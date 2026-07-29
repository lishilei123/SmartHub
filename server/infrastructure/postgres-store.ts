import { createHash } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import type { AgentConfigurationAgentKey, AgentConfigurationDraft, AgentConfigurationScene, AgentConfigurationVersion, AgentExecutionRecord, AiResource, Chunk, ConfigVersion, DatabaseState, GenerativeModelSource, IndexChunk, ProjectVersion, ReviewRun, ReviewRunQueueState, SyncTask } from '../domain/types.js'
import type { TechnicalSolutionReview, TechnicalSolutionReviewJob, TechnicalSolutionReviewRun } from '../domain/technical-solution-types.js'
import { normalizeReviewSeverities, type ChunkSearchInput, type ConfigurationTransactionScope, type DefaultKnowledgeBase, type KnowledgeReadState, type RequirementBindingMetadata, type ReviewJob, type ReviewRunPage, type StateStore, type StoredChunkCandidate, type TaskLease } from './store.js'
import { verifyMigrations } from './migrations.js'

const emptyState = (): DatabaseState => ({ projects: [], projectVersions: [], projectVersionRequirementBindings: [], knowledgeBases: [], directories: [], configs: [], assets: [], versions: [], indexes: [], tasks: [], modelSources: [], aiResources: [], agentConfigurationDrafts: [], agentConfigurationVersions: [], reviewRuns: [], findingActions: [], reviewQaSessions: [], reviewQaTurns: [], toolApprovals: [], technicalSolutionReviews: [], technicalSolutionRuns: [], technicalSolutionFindingActions: [] })

export class PostgresStore implements StateStore {
  private state: DatabaseState = emptyState()
  private queue = Promise.resolve()
  private readonly pool: Pool
  private notificationClient: PoolClient | null = null
  private notificationReady: Promise<void> | null = null
  private notificationWaiters: Array<() => void> = []

  constructor(connectionString: string) { this.pool = new Pool({ connectionString }) }

  async load() {
    const client = await this.pool.connect()
    try {
      await verifyMigrations(client)
      this.state = emptyState()
    } finally { client.release() }
  }

  read() { return structuredClone(this.state) }

  async snapshot() {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const state = await loadState(client)
      await client.query('COMMIT')
      this.state = state
      return structuredClone(state)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async getDefaultKnowledgeBase(projectName: string): Promise<DefaultKnowledgeBase | null> {
    const result = await this.pool.query<{ project: DatabaseState['projects'][number]; knowledge_base: DatabaseState['knowledgeBases'][number] }>(`
      SELECT project.data AS project, base.data AS knowledge_base
      FROM smarthub.projects project
      JOIN smarthub.knowledge_bases base ON base.project_id = project.id
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE asset.active_version_id IS NOT NULL)::int AS assets
        FROM smarthub.knowledge_assets asset
        WHERE asset.knowledge_base_id = base.id
      ) asset_count ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS directories
        FROM smarthub.knowledge_directories directory
        WHERE directory.knowledge_base_id = base.id
      ) directory_count ON true
      WHERE project.name = $1
      ORDER BY asset_count.assets DESC, directory_count.directories DESC, base.created_at, base.id
      LIMIT 1
    `, [projectName])
    const row = result.rows[0]
    return row ? { project: row.project, knowledgeBase: row.knowledge_base } : null
  }

  async listProjectVersions(): Promise<ProjectVersion[]> {
    const projects = await this.pool.query<{ id: string; name: string; created_at: Date | string; active_assets: number }>(`
      SELECT project.id, project.name, project.created_at,
        count(asset.id) FILTER (WHERE asset.active_version_id IS NOT NULL)::int AS active_assets
      FROM smarthub.projects project
      LEFT JOIN smarthub.knowledge_bases base ON base.project_id = project.id
      LEFT JOIN smarthub.knowledge_assets asset ON asset.knowledge_base_id = base.id
      GROUP BY project.id, project.name, project.created_at
      ORDER BY project.created_at, project.id
    `)
    const matching = projects.rows.filter(project => project.name === 'SmartHub')
      .sort((left, right) => right.active_assets - left.active_assets || String(left.created_at).localeCompare(String(right.created_at)))
    const project = matching[0] ?? (projects.rows.length === 1 ? projects.rows[0] : null)
    if (!project) return []
    const versions = await this.pool.query<{ data: ProjectVersion }>('SELECT data FROM smarthub.project_versions WHERE project_id=$1 ORDER BY created_at DESC, id DESC', [project.id])
    return versions.rows.map(row => row.data)
  }

  async getKnowledgeReadState(knowledgeBaseId: string, options: { includeVersionContent?: boolean; includeIndexes?: boolean } = {}): Promise<KnowledgeReadState | null> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const base = await client.query<{ data: DatabaseState['knowledgeBases'][number] }>('SELECT data FROM smarthub.knowledge_bases WHERE id=$1', [knowledgeBaseId])
      if (!base.rows[0]) { await client.query('COMMIT'); return null }
      const directories = await client.query<{ data: DatabaseState['directories'][number] }>('SELECT data FROM smarthub.knowledge_directories WHERE knowledge_base_id=$1 ORDER BY created_at, id', [knowledgeBaseId])
      const configs = await client.query<{ data: DatabaseState['configs'][number] }>('SELECT data FROM smarthub.config_versions WHERE knowledge_base_id=$1 ORDER BY version, id', [knowledgeBaseId])
      const assets = await client.query<{ data: DatabaseState['assets'][number] }>('SELECT data FROM smarthub.knowledge_assets WHERE knowledge_base_id=$1 ORDER BY created_at, id', [knowledgeBaseId])
      const versions = await client.query<{ data: Omit<DatabaseState['versions'][number], 'chunks'> & { content?: string } }>(`
        SELECT CASE WHEN $2::boolean THEN version.data ELSE version.data - 'content' END AS data
        FROM smarthub.asset_versions version
        JOIN smarthub.knowledge_assets asset ON asset.id = version.asset_id
        WHERE asset.knowledge_base_id=$1
        ORDER BY version.created_at, version.id
      `, [knowledgeBaseId, Boolean(options.includeVersionContent)])
      const indexes = options.includeIndexes
        ? await client.query<{ data: DatabaseState['indexes'][number] }>("SELECT data - 'indexedChunks' AS data FROM smarthub.index_versions WHERE knowledge_base_id=$1 ORDER BY created_at, id", [knowledgeBaseId])
        : { rows: [] as Array<{ data: DatabaseState['indexes'][number] }> }
      const taskRows = await client.query<SyncTaskRow>(`${syncTaskSelect} WHERE knowledge_base_id=$1 ORDER BY created_at, id`, [knowledgeBaseId])
      const chunkCounts = options.includeIndexes
        ? await client.query<{ index_version_id: string; chunks: number }>(`
            SELECT chunk.index_version_id, count(*)::int AS chunks
            FROM smarthub.index_chunks chunk
            JOIN smarthub.index_versions version ON version.id = chunk.index_version_id
            WHERE version.knowledge_base_id=$1
            GROUP BY chunk.index_version_id
          `, [knowledgeBaseId])
        : { rows: [] as Array<{ index_version_id: string; chunks: number }> }
      await client.query('COMMIT')
      return {
        state: {
          ...emptyState(),
          knowledgeBases: [base.rows[0].data],
          directories: directories.rows.map(row => row.data),
          configs: configs.rows.map(row => row.data),
          assets: assets.rows.map(row => row.data),
          versions: versions.rows.map(row => ({ ...row.data, content: row.data.content ?? '', chunks: [] })) as DatabaseState['versions'],
          indexes: indexes.rows.map(row => ({ ...row.data, indexedChunks: [] })),
          tasks: taskRows.rows.map(syncTaskFromRow),
        },
        indexChunkCounts: Object.fromEntries(chunkCounts.rows.map(row => [row.index_version_id, Number(row.chunks)])),
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async getAssetVersion(versionId: string, includeChunks: boolean): Promise<DatabaseState['versions'][number] | null> {
    const version = await this.pool.query<{ data: Omit<DatabaseState['versions'][number], 'chunks'> }>('SELECT data FROM smarthub.asset_versions WHERE id=$1', [versionId])
    if (!version.rows[0]) return null
    if (!includeChunks) return { ...version.rows[0].data, chunks: [] }
    const chunks = await this.pool.query<{ embedding: string; data: Chunk }>('SELECT embedding::text AS embedding, data FROM smarthub.asset_chunks WHERE asset_version_id=$1 ORDER BY ordinal, id', [versionId])
    return { ...version.rows[0].data, chunks: chunks.rows.map(row => ({ ...row.data, embedding: decodeVector(row.embedding) })) }
  }

  async getSyncTask(taskId: string): Promise<DatabaseState['tasks'][number] | null> {
    const result = await this.pool.query<SyncTaskRow>(`${syncTaskSelect} WHERE id=$1`, [taskId])
    return result.rows[0] ? syncTaskFromRow(result.rows[0]) : null
  }

  async getActiveKnowledgeConfig(knowledgeBaseId: string): Promise<ConfigVersion | null> {
    const result = await this.pool.query<{ data: ConfigVersion }>(`
      SELECT config.data
      FROM smarthub.knowledge_bases base
      JOIN smarthub.config_versions config ON config.id = base.active_config_version_id
      WHERE base.id = $1
    `, [knowledgeBaseId])
    return result.rows[0]?.data ?? null
  }

  async getAgentConfigurationState(scene: AgentConfigurationScene): Promise<{ draft: AgentConfigurationDraft | null; versions: AgentConfigurationVersion[] }> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const draft = await client.query<{ data: AgentConfigurationDraft }>('SELECT data FROM smarthub.agent_configuration_drafts WHERE scene=$1', [scene])
      const versions = await client.query<{ data: AgentConfigurationVersion }>('SELECT data FROM smarthub.agent_configuration_versions WHERE scene=$1 ORDER BY agent_key, version DESC', [scene])
      await client.query('COMMIT')
      return { draft: draft.rows[0]?.data ?? null, versions: versions.rows.map(row => row.data) }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async listModelSources(): Promise<GenerativeModelSource[]> {
    const result = await this.pool.query<{ data: GenerativeModelSource }>('SELECT data FROM smarthub.model_sources ORDER BY priority, created_at, id')
    return result.rows.map(row => row.data)
  }

  async listAiResources(): Promise<AiResource[]> {
    const result = await this.pool.query<{ data: AiResource }>('SELECT data FROM smarthub.ai_resources ORDER BY kind, resource_key, id')
    return result.rows.map(row => row.data)
  }

  async getActiveAgentConfiguration(scene: AgentConfigurationScene, agentKey: AgentConfigurationAgentKey): Promise<AgentConfigurationVersion | null> {
    const result = await this.pool.query<{ data: AgentConfigurationVersion }>("SELECT data FROM smarthub.agent_configuration_versions WHERE scene=$1 AND agent_key=$2 AND status='active'", [scene, agentKey])
    return result.rows[0]?.data ?? null
  }

  async getProjectVersion(projectVersionId: string): Promise<ProjectVersion | null> {
    const result = await this.pool.query<{ data: ProjectVersion }>('SELECT data FROM smarthub.project_versions WHERE id=$1', [projectVersionId])
    return result.rows[0]?.data ?? null
  }

  async listRequirementBindings(projectVersionId: string): Promise<RequirementBindingMetadata[]> {
    const result = await this.pool.query<{
      binding_data: RequirementBindingMetadata
      asset_id: string
      asset_display_name: string
      asset_logical_path: string
      asset_type: string
      asset_source_type: string
      active_version_id: string | null
      version_id: string
      version_number: number
      version_status: string
      version_created_at: Date | string
      version_ready_at: Date | string | null
      versions: Array<{ id: string; number: number; status: string; createdAt: string; readyAt?: string }> | null
    }>(`
      SELECT binding.data AS binding_data,
        asset.id AS asset_id,
        asset.display_name AS asset_display_name,
        asset.logical_path AS asset_logical_path,
        asset.asset_type,
        asset.source_type AS asset_source_type,
        asset.active_version_id,
        version.id AS version_id,
        version.version AS version_number,
        version.status AS version_status,
        version.created_at AS version_created_at,
        (version.data->>'readyAt')::timestamptz AS version_ready_at,
        versions.items AS versions
      FROM smarthub.project_version_requirement_bindings binding
      JOIN smarthub.knowledge_assets asset ON asset.id = binding.asset_id
      JOIN smarthub.asset_versions version ON version.id = binding.asset_version_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'id', candidate.id,
          'number', candidate.version,
          'status', candidate.status,
          'createdAt', candidate.created_at,
          'readyAt', candidate.data->>'readyAt'
        ) ORDER BY candidate.version) AS items
        FROM smarthub.asset_versions candidate
        WHERE candidate.asset_id = asset.id
      ) versions ON true
      WHERE binding.project_version_id = $1
      ORDER BY binding.created_at, binding.id
    `, [projectVersionId])
    return result.rows.map(row => ({
      ...row.binding_data,
      asset: {
        displayName: row.asset_display_name,
        logicalPath: row.asset_logical_path,
        assetType: row.asset_type,
        sourceType: row.asset_source_type,
        activeVersionId: row.active_version_id,
      },
      version: {
        id: row.version_id,
        number: row.version_number,
        status: row.version_status,
        createdAt: toIsoTimestamp(row.version_created_at)!,
        readyAt: toIsoTimestamp(row.version_ready_at),
      },
      versions: row.versions ?? [],
    }))
  }

  async listReviewRuns(projectVersionId: string, options: { limit: number; cursor?: string; runningOnly?: boolean }): Promise<ReviewRunPage> {
    const limit = Math.min(Math.max(1, options.limit), 100)
    const cursor = decodeReviewRunCursor(options.cursor)
    const result = await this.pool.query<ReviewRunQueueRow>(`
      SELECT run.data - 'result' - 'extractionResult' - 'execution' - 'executions' AS data,
        job.status AS queue_status, job.attempt_count, job.max_attempts,
        job.available_at
      FROM smarthub.review_runs run
      LEFT JOIN smarthub.review_jobs job ON job.run_id = run.id
      WHERE run.project_version_id = $1
        AND ($2::boolean = false OR run.status = 'running')
        AND ($3::timestamptz IS NULL OR (run.created_at, run.id) < ($3::timestamptz, $4::text))
      ORDER BY run.created_at DESC, run.id DESC
      LIMIT $5
    `, [projectVersionId, Boolean(options.runningOnly), cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1])
    const rows = result.rows.map(reviewRunFromQueueRow)
    const items = rows.slice(0, limit)
    const last = items.at(-1)
    return {
      items,
      nextCursor: rows.length > limit && last ? encodeReviewRunCursor(last.createdAt, last.id) : undefined,
    }
  }

  async getReviewRun(runId: string): Promise<ReviewRun | null> {
    const result = await this.pool.query<ReviewRunQueueRow>(`
      SELECT run.data, job.status AS queue_status, job.attempt_count, job.max_attempts,
        job.available_at
      FROM smarthub.review_runs run
      LEFT JOIN smarthub.review_jobs job ON job.run_id = run.id
      WHERE run.id=$1
    `, [runId])
    return result.rows[0] ? reviewRunFromQueueRow(result.rows[0]) : null
  }

  async loadTechnicalSolutionInputState(projectVersionId: string): Promise<Pick<DatabaseState, 'projects' | 'projectVersions' | 'knowledgeBases' | 'assets' | 'versions' | 'indexes' | 'reviewRuns' | 'findingActions'>> {
    const projectVersion = await this.pool.query<{ data: ProjectVersion }>('SELECT data FROM smarthub.project_versions WHERE id=$1', [projectVersionId])
    if (!projectVersion.rows[0]) return { projects: [], projectVersions: [], knowledgeBases: [], assets: [], versions: [], indexes: [], reviewRuns: [], findingActions: [] }
    const projectId = projectVersion.rows[0].data.projectId
    const projects = await this.pool.query<{ data: DatabaseState['projects'][number] }>('SELECT data FROM smarthub.projects WHERE id=$1', [projectId])
    const knowledgeBases = await this.pool.query<{ data: DatabaseState['knowledgeBases'][number] }>('SELECT data FROM smarthub.knowledge_bases WHERE project_id=$1', [projectId])
    const assets = await this.pool.query<{ data: DatabaseState['assets'][number] }>(`SELECT asset.data FROM smarthub.knowledge_assets asset JOIN smarthub.knowledge_bases kb ON kb.id=asset.knowledge_base_id WHERE kb.project_id=$1 AND asset.asset_type='technical_design'`, [projectId])
    const versions = await this.pool.query<{ data: DatabaseState['versions'][number] }>(`SELECT version.data || jsonb_build_object('chunks', COALESCE(chunks.items, '[]'::jsonb)) AS data FROM smarthub.asset_versions version JOIN smarthub.knowledge_assets asset ON asset.id=version.asset_id LEFT JOIN LATERAL (SELECT jsonb_agg(chunk.data ORDER BY chunk.ordinal) AS items FROM smarthub.asset_chunks chunk WHERE chunk.asset_version_id=version.id) chunks ON true WHERE asset.knowledge_base_id = ANY($1::text[]) AND asset.asset_type='technical_design' AND version.status='ready'`, [knowledgeBases.rows.map(row => row.data.id)])
    const indexes = await this.pool.query<{ data: DatabaseState['indexes'][number] }>(`SELECT data FROM smarthub.index_versions WHERE knowledge_base_id = ANY($1::text[]) AND status='active'`, [knowledgeBases.rows.map(row => row.data.id)])
    const reviewRuns = await this.pool.query<{ data: ReviewRun }>(`SELECT data - 'extractionResult' - 'inputDeliveryManifest' - 'execution' - 'executions' - 'modelRouteAttempts' - 'degradations' AS data FROM smarthub.review_runs WHERE project_version_id=$1 AND status='succeeded' AND data ? 'result' ORDER BY created_at DESC, id DESC`, [projectVersionId])
    const findingActions = await this.pool.query<{ data: DatabaseState['findingActions'][number] }>(`SELECT action.data FROM smarthub.finding_actions action JOIN smarthub.review_runs run ON run.id=action.run_id WHERE run.project_version_id=$1`, [projectVersionId])
    return { projects: projects.rows.map(row => row.data), projectVersions: [projectVersion.rows[0].data], knowledgeBases: knowledgeBases.rows.map(row => row.data), assets: assets.rows.map(row => row.data), versions: versions.rows.map(row => row.data), indexes: indexes.rows.map(row => row.data), reviewRuns: reviewRuns.rows.map(row => row.data), findingActions: findingActions.rows.map(row => row.data) }
  }

  async listTechnicalSolutionReviews(projectVersionId: string): Promise<TechnicalSolutionReview[]> {
    const result = await this.pool.query<{ data: TechnicalSolutionReview }>('SELECT data FROM smarthub.technical_solution_reviews WHERE project_version_id=$1 ORDER BY created_at DESC, id DESC', [projectVersionId])
    return result.rows.map(row => row.data)
  }

  async getTechnicalSolutionReview(technicalReviewId: string): Promise<TechnicalSolutionReview | null> {
    const result = await this.pool.query<{ data: TechnicalSolutionReview }>('SELECT data FROM smarthub.technical_solution_reviews WHERE id=$1', [technicalReviewId])
    return result.rows[0]?.data ?? null
  }

  async listTechnicalSolutionRuns(projectVersionId: string, technicalReviewId?: string): Promise<TechnicalSolutionReviewRun[]> {
    const result = await this.pool.query<TechnicalRunQueueRow>(`
      SELECT (run.data - 'result' - 'execution' - 'events') ||
        CASE WHEN run.data ? 'result' THEN jsonb_build_object('result', jsonb_build_object('summary', run.data->'result'->'summary', 'statistics', run.data->'result'->'statistics')) ELSE '{}'::jsonb END AS data,
        job.status AS queue_status,
        job.attempt_count, job.max_attempts, job.available_at
      FROM smarthub.technical_solution_review_runs run
      LEFT JOIN smarthub.technical_solution_review_jobs job ON job.run_id=run.id
      WHERE run.project_version_id=$1 AND ($2::text IS NULL OR run.technical_review_id=$2)
      ORDER BY run.created_at DESC, run.id DESC
    `, [projectVersionId, technicalReviewId ?? null])
    return result.rows.map(technicalRunFromQueueRow)
  }

  async getTechnicalSolutionRun(runId: string): Promise<TechnicalSolutionReviewRun | null> {
    const result = await this.pool.query<TechnicalRunQueueRow>(`
      SELECT run.data, job.status AS queue_status, job.attempt_count, job.max_attempts, job.available_at
      FROM smarthub.technical_solution_review_runs run
      LEFT JOIN smarthub.technical_solution_review_jobs job ON job.run_id=run.id
      WHERE run.id=$1
    `, [runId])
    return result.rows[0] ? technicalRunFromQueueRow(result.rows[0]) : null
  }

  async getToolApproval(approvalId: string) {
    const result = await this.pool.query<{ data: DatabaseState['toolApprovals'][number] }>('SELECT data FROM smarthub.tool_approvals WHERE id=$1', [approvalId])
    return result.rows[0]?.data ?? null
  }

  async recoverInterruptedReviewRuns(finishedAt: string, error: string): Promise<number> {
    const result = await this.pool.query(`
      UPDATE smarthub.review_runs
      SET status='failed', finished_at=$1::text::timestamptz,
        data = data || jsonb_build_object('status', 'failed', 'step', 'failed', 'finishedAt', $1::text, 'error', $2::text)
      WHERE status='running'
    `, [finishedAt, error])
    return result.rowCount ?? 0
  }

  async saveReviewRunExecution(runId: string, execution: AgentExecutionRecord) {
    let failure: unknown
    this.queue = this.queue.then(async () => {
      try {
        const result = await this.pool.query<{ data: ReviewRun }>(`
          UPDATE smarthub.review_runs
          SET data = jsonb_set(data, '{execution}', $2::jsonb, true)
          WHERE id = $1
          RETURNING data
        `, [runId, JSON.stringify(execution)])
        if (!result.rows[0]) throw new Error('需求评审运行不存在')
        const index = this.state.reviewRuns.findIndex(item => item.id === runId)
        if (index >= 0) this.state.reviewRuns[index] = result.rows[0].data
      } catch (error) { failure = error }
    })
    await this.queue
    if (failure) throw failure
  }

  async close() {
    if (this.notificationClient) { this.notificationClient.release(); this.notificationClient = null }
    await this.pool.end()
  }

  async notifyTask() { await this.pool.query("SELECT pg_notify('smarthub_task_ready', 'queued')") }

  async waitForTaskNotification(timeoutMs: number) {
    await this.listenForTaskNotifications()
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        const index = this.notificationWaiters.indexOf(wake)
        if (index >= 0) this.notificationWaiters.splice(index, 1)
        resolve()
      }, Math.max(1, timeoutMs))
      const wake = () => { clearTimeout(timeout); resolve() }
      this.notificationWaiters.push(wake)
    })
  }

  private async listenForTaskNotifications() {
    if (!this.notificationReady) {
      this.notificationReady = (async () => {
        let client: PoolClient | null = null
        try {
          client = await this.pool.connect()
          this.notificationClient = client
          client.on('notification', message => {
            if (message.channel !== 'smarthub_task_ready') return
            const waiters = this.notificationWaiters.splice(0)
            waiters.forEach(wake => wake())
          })
          const listenerClient = client
          listenerClient.on('error', () => {
            if (this.notificationClient === listenerClient) { this.notificationClient = null; this.notificationReady = null; listenerClient.release() }
          })
          await client.query('LISTEN smarthub_task_ready')
        } catch (error) {
          if (this.notificationClient === client) this.notificationClient = null
          this.notificationReady = null
          client?.release()
          throw error
        }
      })()
    }
    await this.notificationReady
  }

  async ensureVectorIndex(indexVersionId: string, dimensions: number) {
    const dimension = positiveInteger(dimensions, '向量维度')
    if (dimension > 4_000) throw new Error('向量维度超过 HNSW 支持范围')
    const suffix = createHash('sha256').update(`${indexVersionId}:${dimension}`).digest('hex').slice(0, 20)
    const indexName = `idx_hnsw_${suffix}`
    await this.pool.query(`
      INSERT INTO smarthub.vector_index_catalog (index_version_id, embedding_dimensions, index_name, status)
      VALUES ($1, $2, $3, 'building')
      ON CONFLICT (index_version_id, embedding_dimensions) DO NOTHING
    `, [indexVersionId, dimension, indexName])
    const catalog = await this.pool.query<{ status: string }>('SELECT status FROM smarthub.vector_index_catalog WHERE index_version_id=$1 AND embedding_dimensions=$2', [indexVersionId, dimension])
    if (catalog.rows[0]?.status === 'ready') return
    try {
      const indexVersionLiteral = `'${indexVersionId.replaceAll("'", "''")}'`
      await this.pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${quoteIdentifier(indexName)} ON smarthub.index_chunks USING hnsw ((embedding::vector(${dimension})) vector_cosine_ops) WHERE index_version_id = ${indexVersionLiteral} AND embedding_dimensions = ${dimension}`)
      const valid = await this.pool.query<{ valid: boolean }>(`SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname=$1`, [indexName])
      if (!valid.rows[0]?.valid) throw new Error('HNSW 索引未处于有效状态')
      await this.pool.query("UPDATE smarthub.vector_index_catalog SET status='ready', ready_at=now(), error=NULL WHERE index_version_id=$1 AND embedding_dimensions=$2", [indexVersionId, dimension])
    } catch (error) {
      await this.pool.query("UPDATE smarthub.vector_index_catalog SET status='failed', error=$3 WHERE index_version_id=$1 AND embedding_dimensions=$2", [indexVersionId, dimension, error instanceof Error ? error.message : 'HNSW 创建失败'])
      throw error
    }
  }

  async isVectorIndexReady(indexVersionId: string, dimensions: number) {
    const result = await this.pool.query("SELECT 1 FROM smarthub.vector_index_catalog WHERE index_version_id=$1 AND embedding_dimensions=$2 AND status='ready'", [indexVersionId, positiveInteger(dimensions, '向量维度')])
    return result.rowCount === 1
  }

  async claimTask(workerId: string, leaseMs: number): Promise<SyncTask | null> {
    const client = await this.pool.connect()
    const runToken = crypto.randomUUID()
    try {
      await client.query('BEGIN')
      await client.query(`
        WITH expired AS (
          SELECT id, data->>'candidateIndexVersionId' AS candidate_id
          FROM smarthub.sync_tasks
          WHERE status = 'running' AND lease_expires_at < now() AND cancel_requested_at IS NULL
          FOR UPDATE
        ), requeued AS (
          UPDATE smarthub.sync_tasks
          SET status = 'queued', step = 'waiting', progress = 0, updated_at = now(), finished_at = NULL,
              lease_owner = NULL, run_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
              available_at = now(),
              data = jsonb_set(jsonb_set(jsonb_set(data - 'candidateIndexVersionId' - 'error' - 'finishedAt', '{status}', to_jsonb('queued'::text)), '{step}', to_jsonb('waiting'::text)), '{progress}', to_jsonb(0))
          WHERE id IN (SELECT id FROM expired)
          RETURNING id
        )
        UPDATE smarthub.index_versions index_version
        SET status = 'failed', data = jsonb_set(data, '{status}', to_jsonb('failed'::text))
        WHERE index_version.id IN (SELECT candidate_id FROM expired WHERE candidate_id IS NOT NULL)
          AND index_version.status = 'candidate'
      `)
      const result = await client.query<{ id: string; data: SyncTask }>(`
        WITH next_task AS (
          SELECT id
          FROM smarthub.sync_tasks
          WHERE status = 'queued'
            AND available_at <= now()
          ORDER BY priority DESC, available_at, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE smarthub.sync_tasks task
        SET status = 'running',
            step = 'claimed',
            progress = 1,
            started_at = COALESCE(task.started_at, now()),
            updated_at = now(),
            attempt_count = task.attempt_count + 1,
            lease_owner = $1,
            run_token = $3::uuid,
            lease_expires_at = now() + ($2::text || ' milliseconds')::interval,
            heartbeat_at = now(),
            data = jsonb_set(jsonb_set(task.data, '{status}', to_jsonb('running'::text)), '{step}', to_jsonb('claimed'::text))
        FROM next_task
        WHERE task.id = next_task.id
        RETURNING task.id, task.data
      `, [workerId, Math.max(1_000, leaseMs), runToken])
      await client.query('COMMIT')
      if (!result.rows[0]) return null
      const task = result.rows[0].data
      return { ...task, status: 'running', step: 'claimed', progress: 1, attempts: (task.attempts ?? 0) + 1, leaseOwner: workerId, runToken }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async heartbeatTask(taskId: string, lease: TaskLease, leaseMs: number) {
    const result = await this.pool.query(`
      UPDATE smarthub.sync_tasks
      SET lease_expires_at = now() + ($4::text || ' milliseconds')::interval,
          heartbeat_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'running' AND lease_owner = $2 AND run_token = $3::uuid
        AND lease_expires_at > now()
    `, [taskId, lease.workerId, lease.runToken, Math.max(1_000, leaseMs)])
    return result.rowCount === 1
  }

  async ownsTask(taskId: string, lease: TaskLease) {
    const result = await this.pool.query(`
      SELECT 1 FROM smarthub.sync_tasks
      WHERE id = $1 AND status = 'running' AND lease_owner = $2 AND run_token = $3::uuid AND lease_expires_at > now()
    `, [taskId, lease.workerId, lease.runToken])
    return result.rowCount === 1
  }

  async releaseTask(taskId: string, lease: TaskLease, retryDelayMs = 0) {
    const result = await this.pool.query(`
      UPDATE smarthub.sync_tasks
      SET status = 'queued', step = 'waiting', progress = 0, updated_at = now(),
          available_at = now() + ($4::text || ' milliseconds')::interval,
          lease_owner = NULL, run_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL, finished_at = NULL,
          data = jsonb_set(jsonb_set(jsonb_set(data - 'error' - 'finishedAt', '{status}', to_jsonb('queued'::text)), '{step}', to_jsonb('waiting'::text)), '{progress}', to_jsonb(0))
      WHERE id = $1 AND status IN ('running', 'failed') AND lease_owner = $2 AND run_token = $3::uuid
        AND lease_expires_at > now()
    `, [taskId, lease.workerId, lease.runToken, Math.max(0, retryDelayMs)])
    return result.rowCount === 1
  }

  async enqueueReviewJob(job: ReviewJob) {
    await this.pool.query(`
      INSERT INTO smarthub.review_jobs (id, run_id, project_version_id, status, attempt_count, max_attempts, available_at, created_at, updated_at, data)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
      ON CONFLICT (run_id) DO NOTHING
    `, [job.id, job.runId, job.projectVersionId, job.status, job.attempts, job.maxAttempts, job.availableAt, job.createdAt, job.updatedAt, JSON.stringify(job)])
    await this.notifyTask()
  }

  async claimReviewJob(workerId: string, leaseMs: number): Promise<ReviewJob | null> {
    const runToken = crypto.randomUUID()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`
        WITH expired AS (
          UPDATE smarthub.review_jobs
          SET status=CASE
                WHEN cancel_requested_at IS NOT NULL THEN 'cancelled'
                WHEN attempt_count >= max_attempts THEN 'failed'
                ELSE 'queued'
              END,
              available_at=CASE WHEN cancel_requested_at IS NULL AND attempt_count < max_attempts THEN now() ELSE available_at END,
              finished_at=CASE WHEN cancel_requested_at IS NULL AND attempt_count < max_attempts THEN NULL ELSE now() END,
              updated_at=now(), lease_owner=NULL, run_token=NULL, lease_expires_at=NULL, heartbeat_at=NULL,
              error=CASE
                WHEN cancel_requested_at IS NOT NULL THEN '用户已取消本次评审'
                WHEN attempt_count >= max_attempts THEN 'REVIEW_JOB_LEASE_EXHAUSTED: Worker 租约多次失效'
                ELSE error
              END,
              data=jsonb_set(data, '{status}', to_jsonb(CASE
                WHEN cancel_requested_at IS NOT NULL THEN 'cancelled'
                WHEN attempt_count >= max_attempts THEN 'failed'
                ELSE 'queued'
              END::text))
          WHERE status='running' AND lease_expires_at < now()
          RETURNING run_id, status, error
        )
        UPDATE smarthub.review_runs run
        SET status=CASE WHEN expired.status='queued' THEN 'running' ELSE expired.status END,
            finished_at=CASE WHEN expired.status='queued' THEN NULL ELSE now() END,
            data=CASE
              WHEN expired.status='queued' THEN jsonb_set(jsonb_set(run.data - 'finishedAt', '{status}', to_jsonb('running'::text)), '{step}', to_jsonb('waiting_worker'::text))
              ELSE jsonb_set(jsonb_set(jsonb_set(run.data, '{status}', to_jsonb(expired.status)), '{step}', to_jsonb(expired.status)), '{error}', to_jsonb(expired.error))
            END
        FROM expired WHERE run.id=expired.run_id AND run.status='running'
      `)
      const result = await client.query<{ data: ReviewJob; attempt_count: number }>(`
        WITH next_job AS (
          SELECT id FROM smarthub.review_jobs
          WHERE status='queued' AND available_at <= now() AND attempt_count < max_attempts
          ORDER BY available_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE smarthub.review_jobs job
        SET status='running', attempt_count=attempt_count+1, lease_owner=$1, run_token=$3::uuid,
            lease_expires_at=now()+($2::text || ' milliseconds')::interval, heartbeat_at=now(),
            started_at=COALESCE(started_at, now()), updated_at=now(),
            data=jsonb_set(job.data, '{status}', to_jsonb('running'::text))
        FROM next_job WHERE job.id=next_job.id RETURNING job.data, job.attempt_count
      `, [workerId, Math.max(1_000, leaseMs), runToken])
      await client.query('COMMIT')
      const claimed = result.rows[0]
      return claimed ? { ...claimed.data, status: 'running', attempts: Number(claimed.attempt_count), leaseOwner: workerId, runToken, heartbeatAt: new Date().toISOString() } : null
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }

  async heartbeatReviewJob(runId: string, lease: TaskLease, leaseMs: number) {
    const result = await this.pool.query(`UPDATE smarthub.review_jobs SET lease_expires_at=now()+($4::text || ' milliseconds')::interval, heartbeat_at=now(), updated_at=now() WHERE run_id=$1 AND status='running' AND lease_owner=$2 AND run_token=$3::uuid AND lease_expires_at>now() AND cancel_requested_at IS NULL`, [runId, lease.workerId, lease.runToken, Math.max(1_000, leaseMs)])
    return result.rowCount === 1
  }

  async finishReviewJob(runId: string, lease: TaskLease, status: 'succeeded' | 'failed' | 'cancelled', error?: string) {
    const result = await this.pool.query(`UPDATE smarthub.review_jobs SET status=$4, finished_at=now(), updated_at=now(), error=$5, lease_owner=NULL, run_token=NULL, lease_expires_at=NULL, heartbeat_at=NULL, data=jsonb_set(data, '{status}', to_jsonb($4::text)) WHERE run_id=$1 AND status='running' AND lease_owner=$2 AND run_token=$3::uuid AND lease_expires_at>now() AND ($4 <> 'cancelled' OR cancel_requested_at IS NOT NULL)`, [runId, lease.workerId, lease.runToken, status, error ?? null])
    return result.rowCount === 1
  }

  async releaseReviewJob(runId: string, lease: TaskLease, retryDelayMs: number, error: string) {
    const result = await this.pool.query(`UPDATE smarthub.review_jobs SET status='queued', available_at=now()+($4::text || ' milliseconds')::interval, updated_at=now(), error=$5, lease_owner=NULL, run_token=NULL, lease_expires_at=NULL, heartbeat_at=NULL, data=jsonb_set(data, '{status}', to_jsonb('queued'::text)) WHERE run_id=$1 AND status='running' AND lease_owner=$2 AND run_token=$3::uuid AND lease_expires_at>now() AND cancel_requested_at IS NULL AND attempt_count < max_attempts`, [runId, lease.workerId, lease.runToken, Math.max(0, retryDelayMs), error])
    return result.rowCount === 1
  }

  async cancelReviewJob(runId: string) {
    const result = await this.pool.query(`UPDATE smarthub.review_jobs SET cancel_requested_at=now(), updated_at=now(), status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END, finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END WHERE run_id=$1 AND status IN ('queued','running')`, [runId])
    return Boolean(result.rowCount)
  }

  async enqueueTechnicalSolutionJob(job: TechnicalSolutionReviewJob) {
    await this.pool.query(`INSERT INTO smarthub.technical_solution_review_jobs (id,run_id,technical_review_id,project_version_id,status,attempt_count,max_attempts,available_at,created_at,updated_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT (run_id) DO NOTHING`, [job.id, job.runId, job.technicalReviewId, job.projectVersionId, job.status, job.attempts, job.maxAttempts, job.availableAt, job.createdAt, job.updatedAt, JSON.stringify(job)])
    await this.notifyTask()
  }

  async claimTechnicalSolutionJob(workerId: string, leaseMs: number): Promise<TechnicalSolutionReviewJob | null> {
    const runToken = crypto.randomUUID()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const expired = await client.query<{ run_id: string; status: 'queued' | 'failed' | 'cancelled'; error: string | null }>(`
        UPDATE smarthub.technical_solution_review_jobs SET
          status=CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' WHEN attempt_count>=max_attempts THEN 'failed' ELSE 'queued' END,
          available_at=CASE WHEN cancel_requested_at IS NULL AND attempt_count<max_attempts THEN now() ELSE available_at END,
          finished_at=CASE WHEN cancel_requested_at IS NULL AND attempt_count<max_attempts THEN NULL ELSE now() END,
          updated_at=now(), lease_owner=NULL, run_token=NULL, lease_expires_at=NULL, heartbeat_at=NULL,
          error=CASE WHEN cancel_requested_at IS NOT NULL THEN '用户已取消技术方案评审' WHEN attempt_count>=max_attempts THEN 'TECH_JOB_LEASE_EXHAUSTED' ELSE error END
        WHERE status='running' AND lease_expires_at<now() RETURNING run_id,status,error
      `)
      for (const row of expired.rows) await client.query(`UPDATE smarthub.technical_solution_review_runs SET status=CASE WHEN $2='queued' THEN 'queued' ELSE $2 END, step=CASE WHEN $2='queued' THEN 'waiting_worker' ELSE $2 END, finished_at=CASE WHEN $2='queued' THEN NULL ELSE now() END, error_summary=$3, data=jsonb_set(jsonb_set(data,'{status}',to_jsonb($2::text)),'{step}',to_jsonb(CASE WHEN $2='queued' THEN 'waiting_worker' ELSE $2 END::text)) WHERE id=$1 AND status IN ('queued','running')`, [row.run_id, row.status, row.error])
      const result = await client.query<{ data: TechnicalSolutionReviewJob; attempt_count: number }>(`
        WITH next_job AS (SELECT id FROM smarthub.technical_solution_review_jobs WHERE status='queued' AND available_at<=now() AND attempt_count<max_attempts ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE smarthub.technical_solution_review_jobs job SET status='running',attempt_count=attempt_count+1,lease_owner=$1,run_token=$3::uuid,lease_expires_at=now()+($2::text||' milliseconds')::interval,heartbeat_at=now(),started_at=COALESCE(started_at,now()),updated_at=now(),data=jsonb_set(job.data,'{status}',to_jsonb('running'::text)) FROM next_job WHERE job.id=next_job.id RETURNING job.data,job.attempt_count
      `, [workerId, Math.max(1_000, leaseMs), runToken])
      await client.query('COMMIT')
      const claimed = result.rows[0]
      return claimed ? { ...claimed.data, status: 'running', attempts: Number(claimed.attempt_count), leaseOwner: workerId, runToken } : null
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }

  async heartbeatTechnicalSolutionJob(runId: string, lease: TaskLease, leaseMs: number) {
    const result = await this.pool.query(`UPDATE smarthub.technical_solution_review_jobs SET lease_expires_at=now()+($4::text||' milliseconds')::interval,heartbeat_at=now(),updated_at=now() WHERE run_id=$1 AND status='running' AND lease_owner=$2 AND run_token=$3::uuid AND lease_expires_at>now() AND cancel_requested_at IS NULL`, [runId, lease.workerId, lease.runToken, Math.max(1_000, leaseMs)])
    return result.rowCount === 1
  }

  async finishTechnicalSolutionJob(runId: string, lease: TaskLease, status: 'succeeded' | 'failed' | 'cancelled', error?: string) {
    const result = await this.pool.query(`UPDATE smarthub.technical_solution_review_jobs SET status=$4,finished_at=now(),updated_at=now(),error=$5,lease_owner=NULL,run_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL,data=jsonb_set(data,'{status}',to_jsonb($4::text)) WHERE run_id=$1 AND status='running' AND lease_owner=$2 AND run_token=$3::uuid AND lease_expires_at>now()`, [runId, lease.workerId, lease.runToken, status, error ?? null])
    return result.rowCount === 1
  }

  async releaseTechnicalSolutionJob(runId: string, lease: TaskLease, retryDelayMs: number, error: string) {
    const result = await this.pool.query(`WITH released AS (
      UPDATE smarthub.technical_solution_review_jobs
      SET status='queued',available_at=now()+($4::text||' milliseconds')::interval,updated_at=now(),error=$5,lease_owner=NULL,run_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL,data=jsonb_set(data,'{status}',to_jsonb('queued'::text))
      WHERE run_id=$1 AND status='running' AND lease_owner=$2 AND run_token=$3::uuid AND lease_expires_at>now() AND cancel_requested_at IS NULL AND attempt_count<max_attempts
      RETURNING run_id
    )
    UPDATE smarthub.technical_solution_review_runs run
    SET status='queued',step='waiting_worker',finished_at=NULL,error_code=NULL,error_summary=NULL,
      data=jsonb_set(jsonb_set(run.data - 'finishedAt' - 'errorCode' - 'error','{status}',to_jsonb('queued'::text)),'{step}',to_jsonb('waiting_worker'::text))
    FROM released WHERE run.id=released.run_id`, [runId, lease.workerId, lease.runToken, Math.max(0, retryDelayMs), error])
    return result.rowCount === 1
  }

  async cancelTechnicalSolutionJob(runId: string) {
    const result = await this.pool.query(`UPDATE smarthub.technical_solution_review_jobs SET cancel_requested_at=now(),updated_at=now(),status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END WHERE run_id=$1 AND status IN ('queued','running')`, [runId])
    return Boolean(result.rowCount)
  }

  async searchChunks(input: ChunkSearchInput): Promise<StoredChunkCandidate[]> {
    const dimensions = positiveInteger(input.dimensions, '向量维度')
    const limit = positiveInteger(input.limit, '召回数量')
    const filters = [input.indexVersionId, input.mode === 'vector' ? encodeVector(input.queryVector ?? []) : input.query, input.logicalPath ?? null, limit]
    const score = input.mode === 'vector'
      ? `(1 + (1 - (c.embedding::vector(${dimensions}) <=> $2::vector(${dimensions})))) / 2`
      : `(CASE WHEN c.content ILIKE '%' || $2 || '%' THEN 0.7 ELSE 0 END) + similarity(c.content, $2) * 0.3`
    const ordering = input.mode === 'vector'
      ? `c.embedding::vector(${dimensions}) <=> $2::vector(${dimensions})`
      : `${score} DESC`
    const retrievalPredicate = input.mode === 'keyword' ? `AND (c.content ILIKE '%' || $2 || '%' OR c.content % $2)` : ''
    const result = await this.pool.query<{
      score: number; version_id: string; version_number: number; chunk_id: string; chunk_key: string; content: string; chunk_data: IndexChunk
    }>(`
      SELECT ${score} AS score,
        v.id AS version_id, v.version AS version_number,
        c.id AS chunk_id, c.chunk_key, c.content, c.data AS chunk_data
      FROM smarthub.index_chunks c
      JOIN smarthub.asset_versions v ON v.id = c.asset_version_id
      WHERE c.index_version_id = $1
        AND c.embedding_dimensions = ${dimensions}
        AND ($3::text IS NULL OR c.data->'assetMetadata'->>'logicalPath' LIKE '%' || replace(replace(replace($3, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%' ESCAPE '\\')
        ${retrievalPredicate}
      ORDER BY ${ordering}
      LIMIT $4
    `, filters)
    return result.rows.flatMap(row => {
      const chunk = row.chunk_data
      const metadata = chunk.assetMetadata
      if (!metadata) return []
      return [{
        score: Number(row.score),
        asset: { id: metadata.assetId, displayName: metadata.displayName, assetType: metadata.assetType, sourceType: metadata.sourceType, logicalPath: metadata.logicalPath },
        version: { id: row.version_id, number: row.version_number },
        chunk: {
          id: row.chunk_id,
          chunkKey: row.chunk_key,
          headingPath: stringArray(chunk.headingPath),
          startLine: Number(chunk.startLine ?? 0), endLine: Number(chunk.endLine ?? 0),
          startChar: Number(chunk.startChar ?? 0), endChar: Number(chunk.endChar ?? 0),
        },
        content: row.content,
      }]
    })
  }

  async transaction<T>(operation: (draft: DatabaseState) => T | Promise<T>): Promise<T> {
    return await this.runTransaction(operation) as T
  }

  async transactionScope<T>(scope: ConfigurationTransactionScope, operation: (draft: DatabaseState) => T | Promise<T>): Promise<T> {
    let result!: T
    let failure: unknown
    this.queue = this.queue.then(async () => {
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query("SELECT pg_advisory_xact_lock(hashtext('smarthub_state'))")
        const before = await loadConfigurationState(client, scope)
        const draft = structuredClone(before)
        result = await operation(draft)
        await persistConfigurationChanges(client, scope, before, draft)
        await client.query('COMMIT')
      } catch (error) {
        failure = error
        await client.query('ROLLBACK')
      } finally { client.release() }
    })
    await this.queue
    if (failure) throw failure
    return result
  }

  async transactionWithTaskLease<T>(taskId: string, lease: TaskLease, operation: (draft: DatabaseState) => T | Promise<T>): Promise<T | null> {
    return this.runTransaction(operation, { kind: 'sync', id: taskId, lease })
  }

  async transactionWithReviewLease<T>(runId: string, lease: TaskLease, operation: (draft: DatabaseState) => T | Promise<T>): Promise<T | null> {
    return this.runTransaction(operation, { kind: 'review', id: runId, lease })
  }

  async transactionWithTechnicalSolutionLease<T>(runId: string, lease: TaskLease, operation: (draft: DatabaseState) => T | Promise<T>): Promise<T | null> {
    return this.runTransaction(operation, { kind: 'technical', id: runId, lease })
  }

  private async runTransaction<T>(operation: (draft: DatabaseState) => T | Promise<T>, fencing?: { kind: 'sync' | 'review' | 'technical'; id: string; lease: TaskLease }): Promise<T | null> {
    let result: T | null = null
    let failure: unknown
    this.queue = this.queue.then(async () => {
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query("SELECT pg_advisory_xact_lock(hashtext('smarthub_state'))")
        if (fencing) {
          const table = fencing.kind === 'sync' ? 'sync_tasks' : fencing.kind === 'review' ? 'review_jobs' : 'technical_solution_review_jobs'
          const key = fencing.kind === 'sync' ? 'id' : 'run_id'
          const owned = await client.query(`
            SELECT 1 FROM smarthub.${table}
            WHERE ${key} = $1 AND status = 'running' AND lease_owner = $2
              AND run_token = $3::uuid AND lease_expires_at > now()
              ${fencing.kind !== 'sync' ? 'AND cancel_requested_at IS NULL' : ''}
            FOR UPDATE
          `, [fencing.id, fencing.lease.workerId, fencing.lease.runToken])
          if (owned.rowCount !== 1) { await client.query('ROLLBACK'); return }
        }
        const before = await loadState(client)
        const draft = structuredClone(before)
        result = await operation(draft)
        if (fencing) {
          const table = fencing.kind === 'sync' ? 'sync_tasks' : fencing.kind === 'review' ? 'review_jobs' : 'technical_solution_review_jobs'
          const key = fencing.kind === 'sync' ? 'id' : 'run_id'
          const stillOwned = await client.query(`
            SELECT 1 FROM smarthub.${table}
            WHERE ${key} = $1 AND status = 'running' AND lease_owner = $2
              AND run_token = $3::uuid AND lease_expires_at > now()
              ${fencing.kind !== 'sync' ? 'AND cancel_requested_at IS NULL' : ''}
            FOR UPDATE
          `, [fencing.id, fencing.lease.workerId, fencing.lease.runToken])
          if (stillOwned.rowCount !== 1) { result = null; await client.query('ROLLBACK'); return }
        }
        await persistChanges(client, before, draft)
        await client.query('COMMIT')
        this.state = draft
      } catch (error) {
        failure = error
        await client.query('ROLLBACK')
      } finally { client.release() }
    })
    await this.queue
    if (failure) throw failure
    return result
  }
}

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>

export function toIsoTimestamp(value: Date | string | null | undefined) {
  return value == null ? undefined : value instanceof Date ? value.toISOString() : value
}

type ReviewRunQueueRow = {
  data: ReviewRun
  queue_status: ReviewRunQueueState['status'] | null
  attempt_count: number | null
  max_attempts: number | null
  available_at: Date | string | null
}

type TechnicalRunQueueRow = {
  data: TechnicalSolutionReviewRun
  queue_status: TechnicalSolutionReviewRun['status'] | null
  attempt_count: number | null
  max_attempts: number | null
  available_at: Date | string | null
}

type SyncTaskRow = {
  data: SyncTask
  status: SyncTask['status']
  step: string
  progress: number
  created_at: Date | string
  available_at: Date | string
  attempt_count: number
  max_attempts: number
  dedupe_key: string | null
  target_id: string | null
  scope: SyncTask['scope']
  lease_owner: string | null
  run_token: string | null
  lease_expires_at: Date | string | null
  heartbeat_at: Date | string | null
  cancel_requested_at: Date | string | null
  started_at: Date | string | null
  finished_at: Date | string | null
  updated_at: Date | string
}

const syncTaskSelect = `SELECT data, status, step, progress, created_at, available_at, attempt_count, max_attempts, dedupe_key, target_id, scope, lease_owner, run_token::text AS run_token, lease_expires_at, heartbeat_at, cancel_requested_at, started_at, finished_at, updated_at FROM smarthub.sync_tasks`

function reviewRunFromQueueRow(row: ReviewRunQueueRow): ReviewRun {
  if (row.queue_status == null || row.attempt_count == null || row.max_attempts == null || row.available_at == null) return row.data
  return {
    ...row.data,
    queue: {
      status: row.queue_status,
      attempts: Number(row.attempt_count),
      maxAttempts: Number(row.max_attempts),
      availableAt: toIsoTimestamp(row.available_at)!,
    },
  }
}

function technicalRunFromQueueRow(row: TechnicalRunQueueRow): TechnicalSolutionReviewRun {
  if (row.queue_status == null || row.attempt_count == null || row.max_attempts == null || row.available_at == null) return row.data
  return { ...row.data, queue: { status: row.queue_status, attempts: Number(row.attempt_count), maxAttempts: Number(row.max_attempts), availableAt: toIsoTimestamp(row.available_at)! } }
}

function syncTaskFromRow(row: SyncTaskRow): SyncTask {
  return {
    ...row.data,
    status: row.status,
    step: row.step,
    progress: row.progress,
    createdAt: toIsoTimestamp(row.created_at)!,
    attempts: row.attempt_count || row.data.attempts,
    availableAt: toIsoTimestamp(row.available_at)!,
    maxAttempts: row.max_attempts,
    dedupeKey: row.dedupe_key ?? undefined,
    targetId: row.target_id ?? undefined,
    scope: row.scope ?? undefined,
    leaseOwner: row.lease_owner ?? undefined,
    runToken: row.run_token ?? undefined,
    leaseExpiresAt: toIsoTimestamp(row.lease_expires_at),
    heartbeatAt: toIsoTimestamp(row.heartbeat_at),
    cancelRequestedAt: toIsoTimestamp(row.cancel_requested_at),
    startedAt: toIsoTimestamp(row.started_at),
    finishedAt: toIsoTimestamp(row.finished_at),
    updatedAt: toIsoTimestamp(row.updated_at)!,
  }
}

async function loadConfigurationState(client: Queryable, scope: ConfigurationTransactionScope): Promise<DatabaseState> {
  const state = emptyState()
  if (scope === 'ai_configuration') {
    const modelSources = await client.query<{ data: DatabaseState['modelSources'][number] }>('SELECT data FROM smarthub.model_sources ORDER BY priority, created_at, id')
    const aiResources = await client.query<{ data: DatabaseState['aiResources'][number] }>('SELECT data FROM smarthub.ai_resources ORDER BY kind, resource_key, id')
    const drafts = await client.query<{ data: DatabaseState['agentConfigurationDrafts'][number] }>('SELECT data FROM smarthub.agent_configuration_drafts ORDER BY scene')
    const versions = await client.query<{ data: DatabaseState['agentConfigurationVersions'][number] }>('SELECT data FROM smarthub.agent_configuration_versions ORDER BY scene, agent_key, version')
    state.modelSources = modelSources.rows.map(row => row.data)
    state.aiResources = aiResources.rows.map(row => row.data)
    state.agentConfigurationDrafts = drafts.rows.map(row => row.data)
    state.agentConfigurationVersions = versions.rows.map(row => row.data)
    return state
  }
  const knowledgeBases = await client.query<{ data: DatabaseState['knowledgeBases'][number] }>('SELECT data FROM smarthub.knowledge_bases ORDER BY created_at, id')
  const configs = await client.query<{ data: DatabaseState['configs'][number] }>('SELECT data FROM smarthub.config_versions ORDER BY created_at, id')
  const indexes = await client.query<{ data: DatabaseState['indexes'][number] }>("SELECT data - 'indexedChunks' AS data FROM smarthub.index_versions ORDER BY created_at, id")
  state.knowledgeBases = knowledgeBases.rows.map(row => row.data)
  state.configs = configs.rows.map(row => row.data)
  state.indexes = indexes.rows.map(row => ({ ...row.data, indexedChunks: [] }))
  return state
}

async function persistConfigurationChanges(client: PoolClient, scope: ConfigurationTransactionScope, before: DatabaseState, state: DatabaseState) {
  if (scope === 'ai_configuration') {
    await deleteMissing(client, 'model_sources', before.modelSources, state.modelSources)
    await deleteMissing(client, 'ai_resources', before.aiResources, state.aiResources)
    await deleteMissing(client, 'agent_configuration_versions', before.agentConfigurationVersions, state.agentConfigurationVersions)
    await deleteMissingScenes(client, 'agent_configuration_drafts', before.agentConfigurationDrafts, state.agentConfigurationDrafts)
    for (const item of changed(before.modelSources, state.modelSources)) await client.query('INSERT INTO smarthub.model_sources (id, display_name, provider_type, enabled, priority, created_at, updated_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name, provider_type=EXCLUDED.provider_type, enabled=EXCLUDED.enabled, priority=EXCLUDED.priority, updated_at=EXCLUDED.updated_at, data=EXCLUDED.data', [item.id, item.name, item.providerType, item.enabled, item.priority, item.createdAt, item.updatedAt, JSON.stringify(item)])
    for (const item of changed(before.aiResources, state.aiResources)) await client.query('INSERT INTO smarthub.ai_resources (id, kind, resource_key, enabled, built_in, created_at, updated_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (id) DO UPDATE SET kind=EXCLUDED.kind, resource_key=EXCLUDED.resource_key, enabled=EXCLUDED.enabled, updated_at=EXCLUDED.updated_at, data=EXCLUDED.data', [item.id, item.kind, item.key, item.enabled, item.builtIn, item.createdAt, item.updatedAt, JSON.stringify(item)])
    for (const item of changedScenes(before.agentConfigurationDrafts, state.agentConfigurationDrafts)) {
      const revision = Math.max(...Object.values(item.agents).map(agent => agent.revision))
      const updatedAt = Object.values(item.agents).map(agent => agent.updatedAt).sort().at(-1)!
      await client.query('INSERT INTO smarthub.agent_configuration_drafts (scene, revision, updated_at, data) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (scene) DO UPDATE SET revision=EXCLUDED.revision, updated_at=EXCLUDED.updated_at, data=EXCLUDED.data', [item.scene, revision, updatedAt, JSON.stringify(item)])
    }
    for (const item of changed(before.agentConfigurationVersions, state.agentConfigurationVersions)) await client.query('INSERT INTO smarthub.agent_configuration_versions (id, scene, agent_key, version, status, created_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, data=EXCLUDED.data', [item.id, item.scene, item.agentKey, item.version, item.status, item.createdAt, JSON.stringify(item)])
    return
  }
  await deleteMissing(client, 'config_versions', before.configs, state.configs)
  for (const item of changed(before.knowledgeBases, state.knowledgeBases)) await client.query('INSERT INTO smarthub.knowledge_bases VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (id) DO UPDATE SET project_id=EXCLUDED.project_id, name=EXCLUDED.name, active_index_version_id=EXCLUDED.active_index_version_id, active_config_version_id=EXCLUDED.active_config_version_id, created_at=EXCLUDED.created_at, data=EXCLUDED.data', [item.id, item.projectId, item.name, item.activeIndexVersionId, item.activeConfigVersionId, item.createdAt, JSON.stringify(item)])
  for (const item of changed(before.configs, state.configs)) await client.query('INSERT INTO smarthub.config_versions VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (id) DO UPDATE SET requires_rebuild=EXCLUDED.requires_rebuild, data=EXCLUDED.data', [item.id, item.knowledgeBaseId, item.version, item.requiresRebuild, item.createdAt, JSON.stringify(item)])
}

async function loadState(client: Queryable): Promise<DatabaseState> {
  const tables = ['projects', 'knowledge_bases', 'knowledge_directories', 'config_versions', 'knowledge_assets', 'asset_versions', 'index_versions'] as const
  const rows = []
  for (const table of tables) rows.push(await client.query<{ data: DatabaseState[keyof DatabaseState][number] }>(`SELECT data FROM smarthub.${table} ORDER BY created_at, id`))
  const versions = rows[5].rows.map(row => ({ ...row.data, chunks: [] })) as DatabaseState['versions']
  const chunks = await client.query<{ asset_version_id: string; embedding: string; data: Chunk }>('SELECT asset_version_id, embedding::text AS embedding, data FROM smarthub.asset_chunks ORDER BY asset_version_id, ordinal, id')
  for (const row of chunks.rows) versions.find(version => version.id === row.asset_version_id)?.chunks.push({ ...row.data, embedding: decodeVector(row.embedding) })
  const indexes = rows[6].rows.map(row => ({ ...row.data, indexedChunks: [] })) as DatabaseState['indexes']
  const indexChunks = await client.query<{ index_version_id: string; embedding: string; data: IndexChunk }>('SELECT index_version_id, embedding::text AS embedding, data FROM smarthub.index_chunks ORDER BY index_version_id, ordinal, id')
  for (const row of indexChunks.rows) indexes.find(index => index.id === row.index_version_id)?.indexedChunks?.push({ ...row.data, embedding: decodeVector(row.embedding) })
  const taskRows = await client.query<{
    data: SyncTask; status: SyncTask['status']; step: string; progress: number; created_at: Date | string; available_at: Date | string; attempt_count: number; max_attempts: number; dedupe_key: string | null; target_id: string | null; scope: SyncTask['scope']; lease_owner: string | null; run_token: string | null; lease_expires_at: Date | string | null; heartbeat_at: Date | string | null; cancel_requested_at: Date | string | null; started_at: Date | string | null; finished_at: Date | string | null; updated_at: Date | string
  }>('SELECT data, status, step, progress, created_at, available_at, attempt_count, max_attempts, dedupe_key, target_id, scope, lease_owner, run_token::text AS run_token, lease_expires_at, heartbeat_at, cancel_requested_at, started_at, finished_at, updated_at FROM smarthub.sync_tasks ORDER BY created_at, id')
  const tasks = taskRows.rows.map(row => ({
    ...row.data,
    status: row.status,
    step: row.step,
    progress: row.progress,
    createdAt: toIsoTimestamp(row.created_at)!,
    attempts: row.attempt_count || row.data.attempts,
    availableAt: toIsoTimestamp(row.available_at)!,
    maxAttempts: row.max_attempts,
    dedupeKey: row.dedupe_key ?? undefined,
    targetId: row.target_id ?? undefined,
    scope: row.scope ?? undefined,
    leaseOwner: row.lease_owner ?? undefined,
    runToken: row.run_token ?? undefined,
    leaseExpiresAt: toIsoTimestamp(row.lease_expires_at),
    heartbeatAt: toIsoTimestamp(row.heartbeat_at),
    cancelRequestedAt: toIsoTimestamp(row.cancel_requested_at),
    startedAt: toIsoTimestamp(row.started_at),
    finishedAt: toIsoTimestamp(row.finished_at),
    updatedAt: toIsoTimestamp(row.updated_at)!,
  })) as DatabaseState['tasks']
  const modelSources = await client.query<{ data: DatabaseState['modelSources'][number] }>('SELECT data FROM smarthub.model_sources ORDER BY priority, created_at, id')
  const aiResources = await client.query<{ data: DatabaseState['aiResources'][number] }>('SELECT data FROM smarthub.ai_resources ORDER BY kind, resource_key, id')
  const agentConfigurationDrafts = await client.query<{ data: DatabaseState['agentConfigurationDrafts'][number] }>('SELECT data FROM smarthub.agent_configuration_drafts ORDER BY scene')
  const agentConfigurationVersions = await client.query<{ data: DatabaseState['agentConfigurationVersions'][number] }>('SELECT data FROM smarthub.agent_configuration_versions ORDER BY scene, agent_key, version')
  const projectVersions = await client.query<{ data: DatabaseState['projectVersions'][number] }>('SELECT data FROM smarthub.project_versions ORDER BY created_at, id')
  const projectVersionRequirementBindings = await client.query<{ data: DatabaseState['projectVersionRequirementBindings'][number] }>('SELECT data FROM smarthub.project_version_requirement_bindings ORDER BY created_at, id')
  const reviewRuns = await client.query<{ data: DatabaseState['reviewRuns'][number] }>('SELECT data FROM smarthub.review_runs ORDER BY created_at DESC, id')
  const findingActions = await client.query<{ data: DatabaseState['findingActions'][number] }>('SELECT data FROM smarthub.finding_actions ORDER BY run_id, finding_id, version')
  const reviewQaSessions = await client.query<{ data: DatabaseState['reviewQaSessions'][number] }>('SELECT data FROM smarthub.review_qa_sessions ORDER BY created_at, id')
  const reviewQaTurns = await client.query<{ data: DatabaseState['reviewQaTurns'][number] }>('SELECT data FROM smarthub.review_qa_turns ORDER BY created_at, id')
  const toolApprovals = await client.query<{ data: DatabaseState['toolApprovals'][number] }>('SELECT data FROM smarthub.tool_approvals ORDER BY requested_at, id')
  const technicalSolutionReviews = await client.query<{ data: DatabaseState['technicalSolutionReviews'][number] }>('SELECT data FROM smarthub.technical_solution_reviews ORDER BY created_at DESC, id')
  const technicalSolutionRuns = await client.query<{ data: DatabaseState['technicalSolutionRuns'][number] }>('SELECT data FROM smarthub.technical_solution_review_runs ORDER BY created_at DESC, id')
  const technicalSolutionFindingActions = await client.query<{ data: DatabaseState['technicalSolutionFindingActions'][number] }>('SELECT data FROM smarthub.technical_solution_finding_actions ORDER BY run_id, finding_id, version')
  const state = { projects: rows[0].rows.map(row => row.data) as DatabaseState['projects'], projectVersions: projectVersions.rows.map(row => row.data), projectVersionRequirementBindings: projectVersionRequirementBindings.rows.map(row => row.data), knowledgeBases: rows[1].rows.map(row => row.data) as DatabaseState['knowledgeBases'], directories: rows[2].rows.map(row => row.data) as DatabaseState['directories'], configs: rows[3].rows.map(row => row.data) as DatabaseState['configs'], assets: rows[4].rows.map(row => row.data) as DatabaseState['assets'], versions, indexes, tasks, modelSources: modelSources.rows.map(row => row.data), aiResources: aiResources.rows.map(row => row.data), agentConfigurationDrafts: agentConfigurationDrafts.rows.map(row => row.data), agentConfigurationVersions: agentConfigurationVersions.rows.map(row => row.data), reviewRuns: reviewRuns.rows.map(row => row.data), findingActions: findingActions.rows.map(row => row.data), reviewQaSessions: reviewQaSessions.rows.map(row => row.data), reviewQaTurns: reviewQaTurns.rows.map(row => row.data), toolApprovals: toolApprovals.rows.map(row => row.data), technicalSolutionReviews: technicalSolutionReviews.rows.map(row => row.data), technicalSolutionRuns: technicalSolutionRuns.rows.map(row => row.data), technicalSolutionFindingActions: technicalSolutionFindingActions.rows.map(row => row.data) }
  normalizeReviewSeverities(state)
  return state
}

async function persistChanges(client: PoolClient, before: DatabaseState, state: DatabaseState) {
  await deleteMissing(client, 'technical_solution_finding_actions', before.technicalSolutionFindingActions, state.technicalSolutionFindingActions)
  await deleteMissing(client, 'technical_solution_review_runs', before.technicalSolutionRuns, state.technicalSolutionRuns)
  await deleteMissing(client, 'technical_solution_reviews', before.technicalSolutionReviews, state.technicalSolutionReviews)
  await deleteMissing(client, 'finding_actions', before.findingActions, state.findingActions)
  await deleteMissing(client, 'review_qa_turns', before.reviewQaTurns, state.reviewQaTurns)
  await deleteMissing(client, 'review_qa_sessions', before.reviewQaSessions, state.reviewQaSessions)
  await deleteMissing(client, 'tool_approvals', before.toolApprovals, state.toolApprovals)
  await deleteMissing(client, 'review_runs', before.reviewRuns, state.reviewRuns)
  await deleteMissing(client, 'project_version_requirement_bindings', before.projectVersionRequirementBindings, state.projectVersionRequirementBindings)
  await deleteMissing(client, 'model_sources', before.modelSources, state.modelSources)
  await deleteMissing(client, 'ai_resources', before.aiResources, state.aiResources)
  await deleteMissing(client, 'agent_configuration_versions', before.agentConfigurationVersions, state.agentConfigurationVersions)
  await deleteMissingScenes(client, 'agent_configuration_drafts', before.agentConfigurationDrafts, state.agentConfigurationDrafts)
  await deleteMissing(client, 'sync_tasks', before.tasks, state.tasks)
  await deleteMissing(client, 'index_versions', before.indexes, state.indexes)
  const retainedVersionIds = new Set(state.versions.map(version => version.id))
  const removedVersionIds = before.versions.filter(version => !retainedVersionIds.has(version.id)).map(version => version.id)
  if (removedVersionIds.length) await client.query('DELETE FROM smarthub.index_chunks WHERE asset_version_id = ANY($1::text[])', [removedVersionIds])
  await deleteMissing(client, 'asset_versions', before.versions, state.versions)
  await deleteMissing(client, 'knowledge_assets', before.assets, state.assets)
  await deleteMissing(client, 'config_versions', before.configs, state.configs)
  await deleteMissing(client, 'knowledge_directories', before.directories, state.directories)
  await deleteMissing(client, 'knowledge_bases', before.knowledgeBases, state.knowledgeBases)
  await deleteMissing(client, 'project_versions', before.projectVersions, state.projectVersions)
  await deleteMissing(client, 'projects', before.projects, state.projects)

  for (const item of changed(before.projects, state.projects)) await client.query('INSERT INTO smarthub.projects VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, created_at=EXCLUDED.created_at, data=EXCLUDED.data', [item.id, item.name, item.createdAt, JSON.stringify(item)])
  for (const item of changed(before.projectVersions, state.projectVersions)) await client.query('INSERT INTO smarthub.project_versions (id, project_id, name, status, source_project_version_id, created_at, updated_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, status=EXCLUDED.status, updated_at=EXCLUDED.updated_at, data=EXCLUDED.data', [item.id, item.projectId, item.name, item.status, item.sourceProjectVersionId ?? null, item.createdAt, item.updatedAt, JSON.stringify(item)])
  for (const item of changed(before.modelSources, state.modelSources)) await client.query('INSERT INTO smarthub.model_sources (id, display_name, provider_type, enabled, priority, created_at, updated_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name, provider_type=EXCLUDED.provider_type, enabled=EXCLUDED.enabled, priority=EXCLUDED.priority, updated_at=EXCLUDED.updated_at, data=EXCLUDED.data', [item.id, item.name, item.providerType, item.enabled, item.priority, item.createdAt, item.updatedAt, JSON.stringify(item)])
  for (const item of changed(before.aiResources, state.aiResources)) await client.query('INSERT INTO smarthub.ai_resources (id, kind, resource_key, enabled, built_in, created_at, updated_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (id) DO UPDATE SET kind=EXCLUDED.kind, resource_key=EXCLUDED.resource_key, enabled=EXCLUDED.enabled, updated_at=EXCLUDED.updated_at, data=EXCLUDED.data', [item.id, item.kind, item.key, item.enabled, item.builtIn, item.createdAt, item.updatedAt, JSON.stringify(item)])
  for (const item of changedScenes(before.agentConfigurationDrafts, state.agentConfigurationDrafts)) {
    const revision = Math.max(...Object.values(item.agents).map(agent => agent.revision))
    const updatedAt = Object.values(item.agents).map(agent => agent.updatedAt).sort().at(-1)!
    await client.query('INSERT INTO smarthub.agent_configuration_drafts (scene, revision, updated_at, data) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (scene) DO UPDATE SET revision=EXCLUDED.revision, updated_at=EXCLUDED.updated_at, data=EXCLUDED.data', [item.scene, revision, updatedAt, JSON.stringify(item)])
  }
  for (const item of changed(before.agentConfigurationVersions, state.agentConfigurationVersions)) await client.query('INSERT INTO smarthub.agent_configuration_versions (id, scene, agent_key, version, status, created_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, data=EXCLUDED.data', [item.id, item.scene, item.agentKey, item.version, item.status, item.createdAt, JSON.stringify(item)])
  for (const item of changed(before.knowledgeBases, state.knowledgeBases)) await client.query('INSERT INTO smarthub.knowledge_bases VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (id) DO UPDATE SET project_id=EXCLUDED.project_id, name=EXCLUDED.name, active_index_version_id=EXCLUDED.active_index_version_id, active_config_version_id=EXCLUDED.active_config_version_id, created_at=EXCLUDED.created_at, data=EXCLUDED.data', [item.id, item.projectId, item.name, item.activeIndexVersionId, item.activeConfigVersionId, item.createdAt, JSON.stringify(item)])
  for (const item of orderDirectories(changed(before.directories, state.directories))) await client.query('INSERT INTO smarthub.knowledge_directories VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (id) DO UPDATE SET knowledge_base_id=EXCLUDED.knowledge_base_id, parent_id=EXCLUDED.parent_id, name=EXCLUDED.name, updated_at=EXCLUDED.updated_at, data=EXCLUDED.data', [item.id, item.knowledgeBaseId, item.parentId, item.name, item.createdAt, item.updatedAt, JSON.stringify(item)])
  for (const item of changed(before.configs, state.configs)) await client.query('INSERT INTO smarthub.config_versions VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (id) DO UPDATE SET requires_rebuild=EXCLUDED.requires_rebuild, data=EXCLUDED.data', [item.id, item.knowledgeBaseId, item.version, item.requiresRebuild, item.createdAt, JSON.stringify(item)])
  for (const item of changed(before.assets, state.assets)) await client.query('INSERT INTO smarthub.knowledge_assets VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT (id) DO UPDATE SET logical_path=EXCLUDED.logical_path, display_name=EXCLUDED.display_name, asset_type=EXCLUDED.asset_type, source_type=EXCLUDED.source_type, active_version_id=EXCLUDED.active_version_id, updated_at=EXCLUDED.updated_at, data=EXCLUDED.data', [item.id, item.knowledgeBaseId, item.logicalPath, item.displayName, item.assetType, item.sourceType, item.activeVersionId, item.createdAt, item.updatedAt, JSON.stringify(item)])
  for (const item of changed(before.versions, state.versions)) {
    const previous = before.versions.find(version => version.id === item.id)
    const data = { ...item, chunks: undefined }
    await client.query('INSERT INTO smarthub.asset_versions VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, data=EXCLUDED.data', [item.id, item.assetId, item.number, item.contentHash, item.status, item.configVersionId, item.createdAt, JSON.stringify(data)])
    if (!previous || JSON.stringify(previous.chunks) !== JSON.stringify(item.chunks)) {
      await client.query('DELETE FROM smarthub.asset_chunks WHERE asset_version_id=$1', [item.id])
      for (const chunk of item.chunks) await insertChunk(client, 'asset_chunks', item.id, chunk)
    }
  }
  for (const item of changed(before.projectVersionRequirementBindings, state.projectVersionRequirementBindings)) await client.query('INSERT INTO smarthub.project_version_requirement_bindings (id, project_version_id, asset_id, asset_version_id, created_at, data) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (id) DO UPDATE SET asset_version_id=EXCLUDED.asset_version_id, data=EXCLUDED.data', [item.id, item.projectVersionId, item.assetId, item.assetVersionId, item.createdAt, JSON.stringify(item)])
  for (const item of changed(before.reviewRuns, state.reviewRuns)) await client.query('INSERT INTO smarthub.review_runs (id, project_version_id, asset_id, asset_version_id, status, created_at, finished_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, finished_at=EXCLUDED.finished_at, data=EXCLUDED.data', [item.id, item.projectVersionId, item.assetId, item.assetVersionId, item.status, item.createdAt, item.finishedAt ?? null, JSON.stringify(item)])
  for (const item of changed(before.findingActions, state.findingActions)) await client.query('INSERT INTO smarthub.finding_actions (id, project_version_id, run_id, finding_id, version, created_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (id) DO NOTHING', [item.id, item.projectVersionId, item.runId, item.findingId, item.version, item.createdAt, JSON.stringify(item)])
  for (const item of changed(before.reviewQaSessions, state.reviewQaSessions)) await client.query('INSERT INTO smarthub.review_qa_sessions (id, project_version_id, run_id, created_at, data) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (id) DO NOTHING', [item.id, item.projectVersionId, item.runId, item.createdAt, JSON.stringify(item)])
  for (const item of changed(before.reviewQaTurns, state.reviewQaTurns)) await client.query('INSERT INTO smarthub.review_qa_turns (id, session_id, project_version_id, run_id, status, created_at, finished_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (id) DO NOTHING', [item.id, item.sessionId, item.projectVersionId, item.runId, item.status, item.createdAt, item.finishedAt, JSON.stringify(item)])
  for (const item of changed(before.toolApprovals, state.toolApprovals)) await client.query('INSERT INTO smarthub.tool_approvals (id, project_version_id, run_id, tool_id, parameter_hash, status, requested_at, expires_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, expires_at=EXCLUDED.expires_at, data=EXCLUDED.data', [item.id, item.projectVersionId, item.runId, item.toolId, item.parameterHash, item.status, item.requestedAt, item.expiresAt, JSON.stringify(item)])
  for (const item of changed(before.technicalSolutionReviews, state.technicalSolutionReviews)) {
    await client.query('INSERT INTO smarthub.technical_solution_reviews (id,project_version_id,source_review_run_id,name,input_set_sha256,created_by,created_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,data=EXCLUDED.data', [item.id,item.projectVersionId,item.sourceReviewRunId,item.name,item.inputSetSha256,item.createdBy,item.createdAt,JSON.stringify(item)])
    await client.query('DELETE FROM smarthub.technical_solution_review_inputs WHERE technical_review_id=$1', [item.id])
    for (let ordinal=0; ordinal<item.solutionAssetVersionIds.length; ordinal += 1) await client.query('INSERT INTO smarthub.technical_solution_review_inputs (technical_review_id,project_version_id,asset_version_id,ordinal) VALUES ($1,$2,$3,$4)', [item.id,item.projectVersionId,item.solutionAssetVersionIds[ordinal],ordinal])
  }
  for (const item of changed(before.technicalSolutionRuns, state.technicalSolutionRuns)) {
    await client.query('INSERT INTO smarthub.technical_solution_review_runs (id,technical_review_id,project_version_id,source_review_run_id,status,step,progress,snapshot_sha256,created_at,started_at,finished_at,error_code,error_summary,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,step=EXCLUDED.step,progress=EXCLUDED.progress,started_at=EXCLUDED.started_at,finished_at=EXCLUDED.finished_at,error_code=EXCLUDED.error_code,error_summary=EXCLUDED.error_summary,data=EXCLUDED.data', [item.id,item.technicalReviewId,item.projectVersionId,item.sourceReviewRunId,item.status,item.step,item.progress,item.snapshotSha256,item.createdAt,item.startedAt??null,item.finishedAt??null,item.errorCode??null,item.error??null,JSON.stringify(item)])
    await persistTechnicalSolutionFormalResult(client, item)
  }
  for (const item of changed(before.technicalSolutionFindingActions, state.technicalSolutionFindingActions)) await client.query('INSERT INTO smarthub.technical_solution_finding_actions (id,project_version_id,technical_review_id,run_id,finding_id,version,created_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (id) DO NOTHING', [item.id,item.projectVersionId,item.technicalReviewId,item.runId,item.findingId,item.version,item.createdAt,JSON.stringify(item)])
  for (const item of changed(before.indexes, state.indexes)) {
    const previous = before.indexes.find(index => index.id === item.id)
    const data = { ...item, indexedChunks: undefined }
    await client.query('INSERT INTO smarthub.index_versions VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, data=EXCLUDED.data', [item.id, item.knowledgeBaseId, item.number, item.status, item.configVersionId, item.createdAt, JSON.stringify(data)])
    if (!previous || JSON.stringify(previous.indexedChunks) !== JSON.stringify(item.indexedChunks)) {
      await client.query('DELETE FROM smarthub.index_chunks WHERE index_version_id=$1', [item.id])
      for (const chunk of item.indexedChunks ?? []) await insertChunk(client, 'index_chunks', item.id, chunk)
    }
  }
  for (const item of changed(before.tasks, state.tasks)) await client.query(`
    INSERT INTO smarthub.sync_tasks (id, knowledge_base_id, type, status, step, progress, created_at, data, available_at, attempt_count, max_attempts, dedupe_key, target_id, scope, lease_owner, run_token, lease_expires_at, heartbeat_at, cancel_requested_at, started_at, finished_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16::uuid,$17,$18,$19,$20,$21,$22)
    ON CONFLICT (id) DO UPDATE SET
      status=EXCLUDED.status, step=EXCLUDED.step, progress=EXCLUDED.progress, data=EXCLUDED.data,
      available_at=EXCLUDED.available_at, attempt_count=EXCLUDED.attempt_count, max_attempts=EXCLUDED.max_attempts,
      dedupe_key=EXCLUDED.dedupe_key, target_id=EXCLUDED.target_id, scope=EXCLUDED.scope,
      lease_owner=EXCLUDED.lease_owner, run_token=EXCLUDED.run_token, lease_expires_at=EXCLUDED.lease_expires_at,
      heartbeat_at=EXCLUDED.heartbeat_at, cancel_requested_at=EXCLUDED.cancel_requested_at,
      started_at=EXCLUDED.started_at, finished_at=EXCLUDED.finished_at, updated_at=EXCLUDED.updated_at
  `, [item.id, item.knowledgeBaseId, item.type, item.status, item.step, item.progress, item.createdAt, JSON.stringify(item), item.availableAt ?? item.createdAt, item.attempts, item.maxAttempts ?? 3, item.dedupeKey ?? null, item.targetId ?? null, item.scope ?? 'asset', item.leaseOwner ?? null, item.runToken ?? null, item.leaseExpiresAt ?? null, item.heartbeatAt ?? null, item.cancelRequestedAt ?? null, item.startedAt ?? null, item.finishedAt ?? null, item.updatedAt ?? new Date().toISOString()])
}

async function persistTechnicalSolutionFormalResult(client: PoolClient, run: TechnicalSolutionReviewRun) {
  await client.query('DELETE FROM smarthub.technical_solution_review_results WHERE run_id=$1', [run.id])
  await client.query('DELETE FROM smarthub.technical_solution_coverage WHERE run_id=$1', [run.id])
  await client.query('DELETE FROM smarthub.technical_solution_findings WHERE run_id=$1', [run.id])
  await client.query('DELETE FROM smarthub.technical_solution_evidence WHERE run_id=$1', [run.id])
  if (!run.result || run.status !== 'succeeded') return
  const result = run.result
  const publishedAt = run.finishedAt ?? new Date().toISOString()
  const candidateSha256 = createHash('sha256').update(JSON.stringify(result)).digest('hex')
  await client.query('INSERT INTO smarthub.technical_solution_review_results (run_id,schema_version,candidate_sha256,published_at,data) VALUES ($1,$2,$3,$4,$5::jsonb)', [run.id,result.schemaVersion,candidateSha256,publishedAt,JSON.stringify({ summary: result.summary, statistics: result.statistics, risks: result.risks, questions: result.questions })])
  for (const evidence of result.evidence) await client.query('INSERT INTO smarthub.technical_solution_evidence (id,run_id,source_kind,asset_id,asset_version_id,chunk_id,content_sha256,start_line,end_line,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)', [evidence.id,run.id,evidence.sourceKind,evidence.assetId,evidence.assetVersionId,evidence.chunkId,evidence.contentSha256,evidence.startLine,evidence.endLine,JSON.stringify(evidence)])
  for (let ordinal = 0; ordinal < result.coverage.length; ordinal += 1) {
    const coverage = result.coverage[ordinal]
    await client.query('INSERT INTO smarthub.technical_solution_coverage (id,run_id,requirement_point_id,status,ordinal,data) VALUES ($1,$2,$3,$4,$5,$6::jsonb)', [coverage.id,run.id,coverage.requirementPointId,coverage.status,ordinal,JSON.stringify(coverage)])
    for (const evidenceId of coverage.evidenceIds) await client.query('INSERT INTO smarthub.technical_solution_coverage_evidence (coverage_id,evidence_id) VALUES ($1,$2)', [coverage.id,evidenceId])
  }
  for (let ordinal = 0; ordinal < result.findings.length; ordinal += 1) {
    const finding = result.findings[ordinal]
    await client.query('INSERT INTO smarthub.technical_solution_findings (id,run_id,finding_type,severity,confidence,ordinal,data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)', [finding.id,run.id,finding.type,finding.severity,finding.confidence,ordinal,JSON.stringify(finding)])
    for (const requirementPointId of finding.requirementPointIds) await client.query('INSERT INTO smarthub.technical_solution_finding_requirements (finding_id,requirement_point_id) VALUES ($1,$2)', [finding.id,requirementPointId])
    for (const evidenceId of finding.evidenceIds) await client.query('INSERT INTO smarthub.technical_solution_finding_evidence (finding_id,evidence_id) VALUES ($1,$2)', [finding.id,evidenceId])
  }
}

async function insertChunk(client: PoolClient, table: 'asset_chunks' | 'index_chunks', ownerId: string, chunk: Chunk | IndexChunk) {
  const data = { ...chunk, embedding: undefined }
  if (table === 'asset_chunks') {
    await client.query('INSERT INTO smarthub.asset_chunks (id, asset_version_id, chunk_key, ordinal, content, content_hash, embedding, embedding_dimensions, data) VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8,$9::jsonb)', [chunk.id, ownerId, chunk.chunkKey, chunk.ordinal, chunk.content, chunk.contentHash, encodeVector(chunk.embedding), chunk.embedding.length, JSON.stringify(data)])
  } else {
    await client.query('INSERT INTO smarthub.index_chunks (index_version_id, id, asset_version_id, chunk_key, ordinal, content, content_hash, embedding, embedding_dimensions, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector,$9,$10::jsonb)', [ownerId, chunk.id, chunk.assetVersionId, chunk.chunkKey, chunk.ordinal, chunk.content, chunk.contentHash, encodeVector(chunk.embedding), chunk.embedding.length, JSON.stringify(data)])
  }
}

async function deleteMissing<T extends { id: string }>(client: PoolClient, table: string, before: T[], after: T[]) {
  const retained = new Set(after.map(item => item.id))
  const missing = before.filter(item => !retained.has(item.id)).map(item => item.id)
  if (missing.length) await client.query(`DELETE FROM smarthub.${table} WHERE id = ANY($1::text[])`, [missing])
}

function changed<T extends { id: string }>(before: T[], after: T[]) {
  const previous = new Map(before.map(item => [item.id, JSON.stringify(item)]))
  return after.filter(item => previous.get(item.id) !== JSON.stringify(item))
}

async function deleteMissingScenes(client: PoolClient, table: string, before: DatabaseState['agentConfigurationDrafts'], after: DatabaseState['agentConfigurationDrafts']) {
  const retained = new Set(after.map(item => item.scene))
  const missing = before.filter(item => !retained.has(item.scene)).map(item => item.scene)
  if (missing.length) await client.query(`DELETE FROM smarthub.${table} WHERE scene = ANY($1::text[])`, [missing])
}

function changedScenes(before: DatabaseState['agentConfigurationDrafts'], after: DatabaseState['agentConfigurationDrafts']) {
  const previous = new Map(before.map(item => [item.scene, JSON.stringify(item)]))
  return after.filter(item => previous.get(item.scene) !== JSON.stringify(item))
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}

function encodeVector(vector: number[]) {
  if (!vector.length || vector.some(value => !Number.isFinite(value))) throw new Error('向量不能为空且必须全部为有限数值')
  return `[${vector.join(',')}]`
}
function decodeVector(value: string) { return value.replace(/^\[|\]$/g, '').split(',').filter(Boolean).map(Number) }

function positiveInteger(value: number, name: string) { if (!Number.isInteger(value) || value <= 0) throw new Error(`${name}必须是正整数`); return value }
function stringArray(value: unknown) { return Array.isArray(value) ? value.map(String) : [] }
function encodeReviewRunCursor(createdAt: string, id: string) { return Buffer.from(JSON.stringify([createdAt, id])).toString('base64url') }
function decodeReviewRunCursor(value: string | undefined) {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') throw new Error('invalid')
    if (Number.isNaN(Date.parse(parsed[0]))) throw new Error('invalid')
    return { createdAt: parsed[0], id: parsed[1] }
  } catch {
    throw new Error('评审历史游标无效')
  }
}

function orderDirectories(directories: DatabaseState['directories']) {
  const ordered: DatabaseState['directories'] = []
  const remaining = [...directories]
  while (remaining.length) {
    const index = remaining.findIndex(item => !item.parentId || ordered.some(parent => parent.id === item.parentId) || !remaining.some(parent => parent.id === item.parentId))
    if (index < 0) throw new Error('知识库目录层级存在循环或缺失父目录')
    ordered.push(remaining.splice(index, 1)[0])
  }
  return ordered
}
