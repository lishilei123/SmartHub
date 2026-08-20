import { createHash } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import type { AgentConfigurationAgentKey, AgentConfigurationDraft, AgentConfigurationScene, AgentConfigurationVersion, AgentExecutionRecord, AiResource, Chunk, ConfigVersion, DatabaseState, GenerativeModelSource, IndexChunk, ProjectVersion, ReviewRun, ReviewRunQueueState, SyncTask } from '../domain/types.js'
import { normalizeRequirementReleaseBindings } from '../domain/requirement-release-bindings.js'
import { normalizeReviewSeverities, normalizeTestDesignState, type ChunkSearchInput, type ConfigurationTransactionScope, type DefaultKnowledgeBase, type KnowledgeReadState, type RequirementBindingMetadata, type ReviewJob, type ReviewRunPage, type StateStore, type StoredChunkCandidate, type TaskLease, type TestDesignJob } from './store.js'
import { verifyMigrations } from './migrations.js'

const emptyState = (): DatabaseState => ({ projects: [], projectVersions: [], projectVersionRequirementBindings: [], knowledgeBases: [], directories: [], configs: [], assets: [], versions: [], indexes: [], tasks: [], modelSources: [], aiResources: [], agentConfigurationDrafts: [], agentConfigurationVersions: [], reviewRuns: [], findingActions: [], toolApprovals: [] })

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
    return versions.rows.map(row => { const version = row.data; normalizeRequirementReleaseBindings(version); return version })
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
    const version = result.rows[0]?.data ?? null
    if (version) normalizeRequirementReleaseBindings(version)
    return version
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
      SELECT (run.data - 'result' - 'execution' - 'executions') AS data,
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
        if (!result.rows[0]) throw new Error('需求分析运行不存在')
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
          SELECT id, data #>> '{input,candidateIndexVersionId}' AS candidate_id, attempt_count, max_attempts
          FROM smarthub.sync_tasks
          WHERE status = 'running' AND lease_expires_at < now() AND cancel_requested_at IS NULL
          FOR UPDATE
        ), recovered AS (
          UPDATE smarthub.sync_tasks
          SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'queued' END,
              step = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'waiting' END,
              progress = CASE WHEN attempt_count >= max_attempts THEN progress ELSE 0 END,
              updated_at = now(),
              finished_at = CASE WHEN attempt_count >= max_attempts THEN now() ELSE NULL END,
              lease_owner = NULL, run_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
              available_at = CASE WHEN attempt_count >= max_attempts THEN available_at ELSE now() END,
              data = CASE WHEN attempt_count >= max_attempts THEN
                jsonb_set(jsonb_set(jsonb_set(data #- '{input,candidateIndexVersionId}', '{status}', to_jsonb('failed'::text)), '{step}', to_jsonb('failed'::text)), '{error}', to_jsonb('TASK_LEASE_EXHAUSTED: Worker 租约多次失效'::text))
              ELSE
                jsonb_set(jsonb_set(jsonb_set((data #- '{input,candidateIndexVersionId}') - 'error' - 'finishedAt', '{status}', to_jsonb('queued'::text)), '{step}', to_jsonb('waiting'::text)), '{progress}', to_jsonb(0))
              END
          WHERE id IN (SELECT id FROM expired)
          RETURNING id
        )
        UPDATE smarthub.index_versions index_version
        SET status = 'failed', data = jsonb_set(data, '{status}', to_jsonb('failed'::text))
        WHERE index_version.id IN (SELECT candidate_id FROM expired WHERE candidate_id IS NOT NULL)
          AND index_version.status = 'candidate'
      `)
      await client.query(`
        UPDATE smarthub.sync_tasks
        SET status = 'failed', step = 'failed', finished_at = now(), updated_at = now(),
            data = jsonb_set(jsonb_set(jsonb_set(data, '{status}', to_jsonb('failed'::text)), '{step}', to_jsonb('failed'::text)), '{error}', to_jsonb('TASK_ATTEMPTS_EXHAUSTED: 知识库任务已达到最大重试次数'::text))
        WHERE status = 'queued' AND attempt_count >= max_attempts
      `)
      const result = await client.query<{ id: string; data: SyncTask }>(`
        WITH next_task AS (
          SELECT id
          FROM smarthub.sync_tasks
          WHERE status = 'queued'
            AND available_at <= now()
            AND attempt_count < max_attempts
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
            data = jsonb_set(jsonb_set(jsonb_set(task.data, '{status}', to_jsonb('running'::text)), '{step}', to_jsonb('claimed'::text)), '{progress}', to_jsonb(1))
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
      ON CONFLICT (run_id) DO UPDATE SET
        id=EXCLUDED.id,
        status='queued',
        max_attempts=smarthub.review_jobs.attempt_count + EXCLUDED.max_attempts,
        available_at=EXCLUDED.available_at,
        updated_at=EXCLUDED.updated_at,
        lease_owner=NULL,
        run_token=NULL,
        lease_expires_at=NULL,
        heartbeat_at=NULL,
        cancel_requested_at=NULL,
        started_at=NULL,
        finished_at=NULL,
        error=NULL,
        data=jsonb_set(
          jsonb_set(EXCLUDED.data, '{attempts}', to_jsonb(smarthub.review_jobs.attempt_count)),
          '{maxAttempts}',
          to_jsonb(smarthub.review_jobs.attempt_count + EXCLUDED.max_attempts)
        )
      WHERE smarthub.review_jobs.status IN ('succeeded','failed','cancelled')
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

  async enqueueTestDesignJob(job: TestDesignJob) {
    await this.pool.query(`INSERT INTO smarthub.workflow_task_jobs (id,node_run_id,status,available_at,attempt_count,max_attempts,created_at,updated_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT (node_run_id) DO UPDATE SET status='queued',available_at=EXCLUDED.available_at,attempt_count=0,max_attempts=EXCLUDED.max_attempts,updated_at=EXCLUDED.updated_at,lease_owner=NULL,run_token=NULL,lease_expires_at=NULL,cancel_requested_at=NULL,error=NULL,data=EXCLUDED.data WHERE smarthub.workflow_task_jobs.status IN ('succeeded','failed','cancelled')`, [job.id, job.nodeRunId, job.status, job.availableAt, job.attempts, job.maxAttempts, job.createdAt, job.updatedAt, JSON.stringify(job)])
    await this.notifyTask()
  }

  async claimTestDesignJob(workerId: string, leaseMs: number): Promise<TestDesignJob | null> {
    const runToken = crypto.randomUUID(); const client = await this.pool.connect()
    try { await client.query('BEGIN'); await client.query(`UPDATE smarthub.workflow_task_jobs SET status=CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' WHEN attempt_count>=max_attempts THEN 'failed' ELSE 'queued' END,available_at=CASE WHEN cancel_requested_at IS NULL AND attempt_count<max_attempts THEN now() ELSE available_at END,updated_at=now(),lease_owner=NULL,run_token=NULL,lease_expires_at=NULL,error=CASE WHEN attempt_count>=max_attempts THEN 'WORKFLOW_JOB_LEASE_EXHAUSTED' ELSE error END WHERE status='running' AND lease_expires_at<now()`); const result = await client.query<{ data: TestDesignJob; attempt_count: number; node_run_id: string }>(`WITH next_job AS (SELECT id FROM smarthub.workflow_task_jobs WHERE status='queued' AND available_at<=now() AND attempt_count<max_attempts ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE smarthub.workflow_task_jobs job SET status='running',attempt_count=attempt_count+1,lease_owner=$1,run_token=$3::uuid,fencing_token=fencing_token+1,lease_expires_at=now()+($2::text||' milliseconds')::interval,updated_at=now(),data=jsonb_set(job.data,'{status}',to_jsonb('running'::text)) FROM next_job WHERE job.id=next_job.id RETURNING job.data,job.attempt_count,job.node_run_id`, [workerId, Math.max(1_000, leaseMs), runToken]); await client.query('COMMIT'); const claimed = result.rows[0]; return claimed ? { ...claimed.data, nodeRunId: claimed.node_run_id, status: 'running', attempts: Number(claimed.attempt_count), leaseOwner: workerId, runToken } : null } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  async heartbeatTestDesignJob(nodeRunId: string, lease: TaskLease, leaseMs: number) { const result = await this.pool.query(`UPDATE smarthub.workflow_task_jobs SET lease_expires_at=now()+($4::text||' milliseconds')::interval,updated_at=now() WHERE node_run_id=$1 AND status='running' AND lease_owner=$2 AND run_token=$3::uuid AND lease_expires_at>now() AND cancel_requested_at IS NULL`, [nodeRunId, lease.workerId, lease.runToken, Math.max(1_000, leaseMs)]); return result.rowCount === 1 }
  async finishTestDesignJob(nodeRunId: string, lease: TaskLease, status: 'succeeded' | 'failed' | 'cancelled', error?: string) { const result = await this.pool.query(`UPDATE smarthub.workflow_task_jobs SET status=$4,updated_at=now(),error=$5,lease_owner=NULL,run_token=NULL,lease_expires_at=NULL,data=jsonb_set(data,'{status}',to_jsonb($4::text)) WHERE node_run_id=$1 AND status='running' AND lease_owner=$2 AND run_token=$3::uuid AND lease_expires_at>now()`, [nodeRunId, lease.workerId, lease.runToken, status, error ?? null]); return result.rowCount === 1 }
  async releaseTestDesignJob(nodeRunId: string, lease: TaskLease, retryDelayMs: number, error: string) { const result = await this.pool.query(`UPDATE smarthub.workflow_task_jobs SET status='queued',available_at=now()+($4::text||' milliseconds')::interval,updated_at=now(),error=$5,lease_owner=NULL,run_token=NULL,lease_expires_at=NULL,data=jsonb_set(data,'{status}',to_jsonb('queued'::text)) WHERE node_run_id=$1 AND status='running' AND lease_owner=$2 AND run_token=$3::uuid AND lease_expires_at>now() AND cancel_requested_at IS NULL AND attempt_count<max_attempts`, [nodeRunId, lease.workerId, lease.runToken, Math.max(0, retryDelayMs), error]); return result.rowCount === 1 }
  async cancelTestDesignJob(runId: string) { const result = await this.pool.query(`UPDATE smarthub.workflow_task_jobs SET cancel_requested_at=now(),updated_at=now(),status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END WHERE data->>'runId'=$1 AND status IN ('queued','running')`, [runId]); return Boolean(result.rowCount) }

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

  async transactionWithTestDesignLease<T>(nodeRunId: string, lease: TaskLease, operation: (draft: DatabaseState) => T | Promise<T>): Promise<T | null> {
    return this.runTransaction(operation, { kind: 'test_design', id: nodeRunId, lease })
  }

  private async runTransaction<T>(operation: (draft: DatabaseState) => T | Promise<T>, fencing?: { kind: 'sync' | 'review' | 'test_design'; id: string; lease: TaskLease }): Promise<T | null> {
    let result: T | null = null
    let failure: unknown
    this.queue = this.queue.then(async () => {
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query("SELECT pg_advisory_xact_lock(hashtext('smarthub_state'))")
        if (fencing) {
          const table = fencing.kind === 'sync' ? 'sync_tasks' : fencing.kind === 'review' ? 'review_jobs' : 'workflow_task_jobs'
          const key = fencing.kind === 'sync' ? 'id' : fencing.kind === 'test_design' ? 'node_run_id' : 'run_id'
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
          const table = fencing.kind === 'sync' ? 'sync_tasks' : fencing.kind === 'review' ? 'review_jobs' : 'workflow_task_jobs'
          const key = fencing.kind === 'sync' ? 'id' : fencing.kind === 'test_design' ? 'node_run_id' : 'run_id'
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

function groupRows<T extends { run_id: string }>(rows: T[]) {
  const grouped = new Map<string, T[]>()
  rows.forEach(row => grouped.set(row.run_id, [...(grouped.get(row.run_id) ?? []), row]))
  return grouped
}

function groupRelationIds<T extends Record<string, string>>(rows: T[], owner: keyof T, value: keyof T) {
  const grouped = new Map<string, string[]>()
  rows.forEach(row => {
    const key = row[owner]
    const id = row[value]
    grouped.set(key, [...(grouped.get(key) ?? []), id])
  })
  return grouped
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
  for (const table of tables) rows.push(await client.query<{ data: Extract<DatabaseState[keyof DatabaseState], readonly unknown[]>[number] }>(`SELECT data FROM smarthub.${table} ORDER BY created_at, id`))
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
  const toolApprovals = await client.query<{ data: DatabaseState['toolApprovals'][number] }>('SELECT data FROM smarthub.tool_approvals ORDER BY requested_at, id')
  const legacyTestDesignState = await client.query<{ data: NonNullable<DatabaseState['testDesignState']> }>("SELECT data FROM smarthub.test_design_state WHERE singleton_id='current'")
  const normalizedDesigns = await client.query<{ data: NonNullable<DatabaseState['testDesignState']>['designs'][number] }>('SELECT data FROM smarthub.test_designs ORDER BY created_at DESC, id')
  const normalizedRuns = await client.query<{ data: NonNullable<DatabaseState['testDesignState']>['runs'][number] }>("SELECT data FROM smarthub.workflow_runs WHERE domain_type='test_design' ORDER BY created_at DESC, id")
  const normalizedCaseSets = await client.query<{ data: NonNullable<DatabaseState['testDesignState']>['caseSetVersions'][number] }>('SELECT data FROM smarthub.test_case_set_versions ORDER BY published_at DESC, id')
  const normalizedLibraryCases = await client.query<{ data: NonNullable<DatabaseState['testDesignState']>['libraryCases'][number] }>('SELECT data FROM smarthub.library_test_cases ORDER BY updated_at DESC, id')
  const normalizedLibraryVersions = await client.query<{ data: NonNullable<DatabaseState['testDesignState']>['libraryVersions'][number] }>('SELECT data FROM smarthub.test_case_library_versions ORDER BY published_at DESC, id')
  const normalizedSuiteDrafts = await client.query<{ data: NonNullable<DatabaseState['testDesignState']>['suiteDrafts'][number] }>('SELECT data FROM smarthub.test_suite_drafts ORDER BY updated_at DESC, id')
  const normalizedSuites = await client.query<{ data: NonNullable<DatabaseState['testDesignState']>['suiteVersions'][number] }>('SELECT data FROM smarthub.test_suite_versions ORDER BY published_at DESC, id')
  const normalizedHandoffs = await client.query<{ data: NonNullable<DatabaseState['testDesignState']>['executionHandoffs'][number] }>('SELECT data FROM smarthub.test_execution_handoffs ORDER BY created_at DESC, id')
  const normalizedLegacyMigrations = await client.query<{ data: NonNullable<DatabaseState['testDesignState']>['legacyMigrations'][number] }>('SELECT data FROM smarthub.legacy_test_case_migrations ORDER BY migrated_at DESC, id')
  const legacyDesignState = legacyTestDesignState.rows[0]?.data
  const hasAnyTestDesignState = Boolean(legacyDesignState) || (normalizedDesigns.rowCount ?? 0) > 0 || (normalizedRuns.rowCount ?? 0) > 0 || (normalizedCaseSets.rowCount ?? 0) > 0 || (normalizedLibraryCases.rowCount ?? 0) > 0 || (normalizedLibraryVersions.rowCount ?? 0) > 0 || (normalizedSuiteDrafts.rowCount ?? 0) > 0 || (normalizedSuites.rowCount ?? 0) > 0 || (normalizedHandoffs.rowCount ?? 0) > 0 || (normalizedLegacyMigrations.rowCount ?? 0) > 0
  const testDesignState = hasAnyTestDesignState ? {
    architectureVersion: 'single-agent-skills/v1' as const,
    designs: (normalizedDesigns.rowCount ?? 0) > 0 ? normalizedDesigns.rows.map(row => row.data) : legacyDesignState?.designs ?? [],
    runs: (normalizedRuns.rowCount ?? 0) > 0 ? normalizedRuns.rows.map(row => row.data) : legacyDesignState?.runs ?? [],
    caseSetVersions: (normalizedCaseSets.rowCount ?? 0) > 0 ? normalizedCaseSets.rows.map(row => row.data) : legacyDesignState?.caseSetVersions ?? [],
    libraryCases: (normalizedLibraryCases.rowCount ?? 0) > 0 ? normalizedLibraryCases.rows.map(row => row.data) : legacyDesignState?.libraryCases ?? [],
    libraryVersions: (normalizedLibraryVersions.rowCount ?? 0) > 0 ? normalizedLibraryVersions.rows.map(row => row.data) : legacyDesignState?.libraryVersions ?? [],
    suiteDrafts: (normalizedSuiteDrafts.rowCount ?? 0) > 0 ? normalizedSuiteDrafts.rows.map(row => row.data) : legacyDesignState?.suiteDrafts ?? [],
    suiteVersions: (normalizedSuites.rowCount ?? 0) > 0 ? normalizedSuites.rows.map(row => row.data) : legacyDesignState?.suiteVersions ?? [],
    executionHandoffs: (normalizedHandoffs.rowCount ?? 0) > 0 ? normalizedHandoffs.rows.map(row => row.data) : legacyDesignState?.executionHandoffs ?? [],
    legacyMigrations: (normalizedLegacyMigrations.rowCount ?? 0) > 0 ? normalizedLegacyMigrations.rows.map(row => row.data) : legacyDesignState?.legacyMigrations ?? [],
  } : undefined
  const state = { projects: rows[0].rows.map(row => row.data) as DatabaseState['projects'], projectVersions: projectVersions.rows.map(row => row.data), projectVersionRequirementBindings: projectVersionRequirementBindings.rows.map(row => row.data), knowledgeBases: rows[1].rows.map(row => row.data) as DatabaseState['knowledgeBases'], directories: rows[2].rows.map(row => row.data) as DatabaseState['directories'], configs: rows[3].rows.map(row => row.data) as DatabaseState['configs'], assets: rows[4].rows.map(row => row.data) as DatabaseState['assets'], versions, indexes, tasks, modelSources: modelSources.rows.map(row => row.data), aiResources: aiResources.rows.map(row => row.data), agentConfigurationDrafts: agentConfigurationDrafts.rows.map(row => row.data), agentConfigurationVersions: agentConfigurationVersions.rows.map(row => row.data), reviewRuns: reviewRuns.rows.map(row => row.data), findingActions: findingActions.rows.map(row => row.data), toolApprovals: toolApprovals.rows.map(row => row.data), testDesignState }
  state.projectVersions.forEach(normalizeRequirementReleaseBindings)
  normalizeTestDesignState(state)
  normalizeReviewSeverities(state)
  return state
}

async function persistChanges(client: PoolClient, before: DatabaseState, state: DatabaseState) {
  await deleteRemovedTestDesignState(client, before, state)
  await deleteMissing(client, 'finding_actions', before.findingActions, state.findingActions)
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
  for (const item of changed(before.toolApprovals, state.toolApprovals)) await client.query('INSERT INTO smarthub.tool_approvals (id, project_version_id, run_id, tool_id, parameter_hash, status, requested_at, expires_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, expires_at=EXCLUDED.expires_at, data=EXCLUDED.data', [item.id, item.projectVersionId, item.runId, item.toolId, item.parameterHash, item.status, item.requestedAt, item.expiresAt, JSON.stringify(item)])
  for (const item of state.testDesignState?.designs ?? []) await client.query('INSERT INTO smarthub.test_designs (id,project_version_id,project_id,name,objective,basis_mode,logical_input_sha256,created_by,created_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,objective=EXCLUDED.objective,data=EXCLUDED.data', [item.id,item.projectVersionId,item.projectId,item.name,item.objective,'project_workspace',item.logicalInputSha256,item.createdBy,item.createdAt,JSON.stringify(item)])
  for (const run of state.testDesignState?.runs ?? []) {
    const design = state.testDesignState?.designs.find(item => item.id === run.testDesignId)
    await client.query('INSERT INTO smarthub.workflow_runs (id,project_version_id,domain_type,domain_id,definition_key,definition_version,status,stage,progress,idempotency_key,input_sha256,created_by,created_at,started_at,finished_at,error_code,error_summary,base_test_case_library_version_id,base_test_case_library_version_sha256,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,stage=EXCLUDED.stage,progress=EXCLUDED.progress,started_at=EXCLUDED.started_at,finished_at=EXCLUDED.finished_at,error_code=EXCLUDED.error_code,error_summary=EXCLUDED.error_summary,base_test_case_library_version_id=EXCLUDED.base_test_case_library_version_id,base_test_case_library_version_sha256=EXCLUDED.base_test_case_library_version_sha256,data=EXCLUDED.data', [run.id,run.projectVersionId,'test_design',run.testDesignId,'test-design-workflow','2',run.status,run.stage,run.progress,run.idempotencyKey,design?.logicalInputSha256 ?? run.basisSnapshot.snapshotSha256,run.createdBy,run.createdAt,run.startedAt??null,run.finishedAt??null,run.errorCode??null,run.error??null,run.baseTestCaseLibraryVersionId??null,run.baseTestCaseLibraryVersionSha256??null,JSON.stringify(run)])
    for (const item of run.nodeRuns) await client.query('INSERT INTO smarthub.workflow_node_runs (id,workflow_run_id,node_key,node_kind,generation,attempt,status,started_at,finished_at,error_code,error_summary,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) ON CONFLICT (id) DO UPDATE SET generation=EXCLUDED.generation,attempt=EXCLUDED.attempt,status=EXCLUDED.status,started_at=EXCLUDED.started_at,finished_at=EXCLUDED.finished_at,error_code=EXCLUDED.error_code,error_summary=EXCLUDED.error_summary,data=EXCLUDED.data', [item.id,run.id,item.nodeKey,item.nodeKey==='coverage_audit'?'deterministic':'agent',item.generation,item.attempt,item.status,item.startedAt??null,item.finishedAt??null,item.errorCode??null,item.error??null,JSON.stringify(item)])
  }
  if (JSON.stringify(before.testDesignState) !== JSON.stringify(state.testDesignState)) {
    await persistTestDesignNormalizedDetails(client, state)
    await client.query("INSERT INTO smarthub.test_design_state (singleton_id, updated_at, data) VALUES ('current', now(), $1::jsonb) ON CONFLICT (singleton_id) DO UPDATE SET updated_at=EXCLUDED.updated_at, data=EXCLUDED.data", [JSON.stringify(state.testDesignState ?? { architectureVersion: 'single-agent-skills/v1', designs: [], runs: [], caseSetVersions: [], libraryCases: [], libraryVersions: [], suiteDrafts: [], suiteVersions: [], executionHandoffs: [], legacyMigrations: [] })])
  }
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

async function persistTestDesignNormalizedDetails(client: PoolClient, state: DatabaseState) {
  const aggregate = state.testDesignState
  if (!aggregate) return
  for (const run of aggregate.runs) {
    const design = aggregate.designs.find(item => item.id === run.testDesignId)
    if (!design) continue
    const snapshots = [
      { kind: 'basis', id: `${run.id}:basis`, value: run.basisSnapshot, hash: run.basisSnapshot.snapshotSha256 },
      { kind: 'retrieval', id: `${run.id}:retrieval`, value: run.retrievalSnapshot, hash: run.retrievalSnapshot.snapshotSha256 },
      { kind: 'historical', id: `${run.id}:historical`, value: run.historicalSnapshot, hash: run.historicalSnapshot.snapshotSha256 },
    ] as const
    await client.query('INSERT INTO smarthub.test_design_basis_snapshots (id,test_design_id,workflow_run_id,basis_mode,snapshot_sha256,created_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (id) DO UPDATE SET snapshot_sha256=EXCLUDED.snapshot_sha256,data=EXCLUDED.data', [snapshots[0].id,run.testDesignId,run.id,'project_workspace',snapshots[0].hash,run.basisSnapshot.createdAt,JSON.stringify(run.basisSnapshot)])
    await client.query('INSERT INTO smarthub.test_design_retrieval_snapshots (id,workflow_run_id,mode,snapshot_sha256,created_at,data) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (id) DO UPDATE SET snapshot_sha256=EXCLUDED.snapshot_sha256,data=EXCLUDED.data', [snapshots[1].id,run.id,run.retrievalSnapshot.mode,snapshots[1].hash,run.retrievalSnapshot.createdAt,JSON.stringify(run.retrievalSnapshot)])
    await client.query('INSERT INTO smarthub.test_design_historical_case_snapshots (id,workflow_run_id,snapshot_sha256,created_at,data) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (id) DO UPDATE SET snapshot_sha256=EXCLUDED.snapshot_sha256,data=EXCLUDED.data', [snapshots[2].id,run.id,snapshots[2].hash,run.historicalSnapshot.createdAt,JSON.stringify(run.historicalSnapshot)])
    const snapshotItems = [
      ...run.basisSnapshot.items.map((item, ordinal) => ({ kind: 'basis', item, ordinal })),
      ...run.retrievalSnapshot.hits.map((item, ordinal) => ({ kind: 'retrieval', item: { ...item, kind: 'knowledge_asset', sourceId: `${item.assetVersionId}:${item.chunkId}` }, ordinal })),
      ...run.historicalSnapshot.items.map((item, ordinal) => ({ kind: 'historical', item, ordinal })),
    ]
    for (const entry of snapshotItems) {
      const content = typeof entry.item.content === 'string' ? entry.item.content : JSON.stringify(entry.item.content)
      await client.query('INSERT INTO smarthub.frozen_contents (content_sha256,media_type,byte_length,content,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (content_sha256) DO NOTHING', [entry.item.contentSha256,'application/json; charset=utf-8',Buffer.byteLength(content,'utf8'),content,run.createdAt])
      await client.query('INSERT INTO smarthub.frozen_content_refs (owner_type,owner_id,role,ordinal,content_sha256,locator) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (owner_type,owner_id,role,ordinal) DO UPDATE SET content_sha256=EXCLUDED.content_sha256,locator=EXCLUDED.locator', ['workflow_run',run.id,entry.kind,entry.ordinal,entry.item.contentSha256,JSON.stringify(entry.item.locator ?? {})])
      await client.query('INSERT INTO smarthub.test_design_snapshot_items (id,workflow_run_id,snapshot_kind,source_kind,source_id,content_sha256,ordinal,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (id) DO UPDATE SET content_sha256=EXCLUDED.content_sha256,data=EXCLUDED.data', [`${run.id}:${entry.kind}:${entry.ordinal}`,run.id,entry.kind,String(entry.item.kind),entry.item.sourceId,entry.item.contentSha256,entry.ordinal,JSON.stringify(entry.item)])
    }
    for (const artifact of run.artifacts) {
      const currentNode = run.nodeRuns.find(item => item.nodeKey === artifact.nodeKey && item.generation === artifact.generation)
      await client.query('INSERT INTO smarthub.workflow_handoff_artifacts (id,workflow_run_id,node_run_id,artifact_type,schema_version,content_sha256,validation_status,created_at,content) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT (id) DO UPDATE SET validation_status=EXCLUDED.validation_status,content=EXCLUDED.content', [artifact.id,run.id,currentNode?.id??null,artifact.nodeKey,artifact.schemaVersion,artifact.contentSha256,'valid',artifact.createdAt,JSON.stringify(artifact.content)])
    }
    for (const decision of run.gateDecisions) await client.query('INSERT INTO smarthub.workflow_gate_decisions (id,workflow_run_id,gate_key,target_artifact_id,target_revision,decision,actor_id,expected_version,created_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT (id) DO UPDATE SET decision=EXCLUDED.decision,data=EXCLUDED.data', [decision.id,run.id,decision.gateKey,decision.targetId,decision.targetRevision,decision.decision,decision.actorId,Math.max(0,decision.version-1),decision.createdAt,JSON.stringify(decision)])
    for (const testCase of run.testCases) {
      await client.query('INSERT INTO smarthub.test_cases (id,workflow_run_id,current_revision,lifecycle_status,data) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (id) DO UPDATE SET current_revision=EXCLUDED.current_revision,lifecycle_status=EXCLUDED.lifecycle_status,data=EXCLUDED.data', [testCase.id,run.id,testCase.currentRevision,testCase.tombstonedAt?'deleted':testCase.reviewState,JSON.stringify(testCase)])
      for (const revision of testCase.revisions) await client.query('INSERT INTO smarthub.test_case_revisions (id,case_id,revision,content_sha256,semantic_sha256,created_at,content,data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) ON CONFLICT (case_id,revision) DO UPDATE SET content_sha256=EXCLUDED.content_sha256,semantic_sha256=EXCLUDED.semantic_sha256,content=EXCLUDED.content,data=EXCLUDED.data', [`${testCase.id}:r${revision.revision}`,testCase.id,revision.revision,revision.contentSha256,revision.semanticSha256,revision.createdAt,JSON.stringify(revision.content),JSON.stringify(revision)])
      for (const action of testCase.reviewActions) await client.query('INSERT INTO smarthub.test_case_review_actions (id,case_id,target_revision,decision,actor_id,created_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (id) DO NOTHING', [action.id,testCase.id,action.targetRevision,action.decision,action.actorId,action.createdAt,JSON.stringify(action)])
      if (testCase.historicalSourceRef) {
        const source = run.historicalSnapshot.items.find(item => item.id === testCase.historicalSourceRef)
        const current = testCase.revisions.find(item => item.revision === testCase.currentRevision)
        if (source && current) await client.query('INSERT INTO smarthub.test_case_reuse_relations (id,case_id,source_type,source_id,mode,source_sha256,current_sha256,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (id) DO UPDATE SET mode=EXCLUDED.mode,current_sha256=EXCLUDED.current_sha256,data=EXCLUDED.data', [`${testCase.id}:historical`,testCase.id,source.kind,source.id,testCase.origin === 'historical_unchanged'?'unchanged':testCase.origin === 'historical_reference'?'reference':'modified',source.contentSha256,current.semanticSha256,JSON.stringify({ historicalSourceRef:testCase.historicalSourceRef, origin:testCase.origin })])
      }
    }
    for (const testCase of run.testCases) {
      await client.query('DELETE FROM smarthub.test_case_dependencies WHERE case_id=$1', [testCase.id])
      const current = testCase.revisions.find(item => item.revision === testCase.currentRevision)
      for (const dependencyId of current?.content.dependencies ?? []) await client.query('INSERT INTO smarthub.test_case_dependencies (case_id,target_case_id,revision) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [testCase.id,dependencyId,testCase.currentRevision])
    }
    if (run.dataSetVersions.length) {
      const setId = `${run.id}:data`
      await client.query('INSERT INTO smarthub.test_data_requirement_sets (id,workflow_run_id,current_version,data) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (id) DO UPDATE SET current_version=EXCLUDED.current_version,data=EXCLUDED.data', [setId,run.id,run.dataSetVersions.at(-1)!.version,JSON.stringify({ id:setId, workflowRunId:run.id })])
      for (const version of run.dataSetVersions) {
        await client.query('INSERT INTO smarthub.test_data_requirement_set_versions (id,set_id,version,content_sha256,created_at,content) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (id) DO UPDATE SET content_sha256=EXCLUDED.content_sha256,content=EXCLUDED.content', [version.id,setId,version.version,version.contentSha256,version.createdAt,JSON.stringify(version.requirements)])
        for (const requirement of version.requirements) await client.query('INSERT INTO smarthub.test_data_requirements (id,set_version_id,readiness,data) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (id) DO UPDATE SET set_version_id=EXCLUDED.set_version_id,readiness=EXCLUDED.readiness,data=EXCLUDED.data', [requirement.id,version.id,requirement.readiness,JSON.stringify(requirement)])
      }
    }
    await client.query('DELETE FROM smarthub.test_design_basis_relations WHERE workflow_run_id=$1', [run.id])
    for (const testCase of run.testCases.filter(item => !item.tombstonedAt)) {
      const content = testCase.revisions.find(item => item.revision === testCase.currentRevision)?.content
      for (const requirementId of content?.requirementRefs ?? []) {
        const relationId = `basis_relation_${createHash('sha256').update(`${run.id}:${testCase.id}:${requirementId}`).digest('hex').slice(0, 24)}`
        await client.query('INSERT INTO smarthub.test_design_basis_relations (id,workflow_run_id,subject_kind,subject_id,basis_type,basis_ref,data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data', [relationId,run.id,'test_case',testCase.id,'requirement_release',requirementId,JSON.stringify({ requirementReleaseId:run.basisSnapshot.requirementReleaseId, requirementId, testCaseId:testCase.id })])
      }
    }
    for (const audit of run.coverageAudits) {
      await client.query('INSERT INTO smarthub.test_design_coverage_audits (id,workflow_run_id,input_sha256,case_set_sha256,status,created_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,data=EXCLUDED.data', [audit.id,run.id,audit.inputSha256,audit.caseSetSha256,audit.status,audit.createdAt,JSON.stringify(audit)])
      for (const [index, relation] of audit.relations.entries()) await client.query('INSERT INTO smarthub.test_design_coverage_relations (id,audit_id,target_type,target_ref,status,data) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,data=EXCLUDED.data', [`${audit.id}:${index}`,audit.id,relation.caseId?'test_case':'requirement',relation.caseId??relation.requirementId,relation.status,JSON.stringify(relation)])
    }
    for (const finding of run.findings) await client.query('INSERT INTO smarthub.test_design_findings (id,workflow_run_id,created_at,data) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data', [finding.id,run.id,run.createdAt,JSON.stringify(finding)])
    for (const item of run.confirmationItems) await client.query('INSERT INTO smarthub.test_design_confirmation_items (id,workflow_run_id,impact_stage,blocker,created_at,data) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (id) DO UPDATE SET impact_stage=EXCLUDED.impact_stage,blocker=EXCLUDED.blocker,data=EXCLUDED.data', [item.id,run.id,item.impactStage,item.blocker,run.createdAt,JSON.stringify(item)])
    for (const proposal of run.caseChangeProposals ?? []) {
      await client.query('INSERT INTO smarthub.case_change_proposals (id,workflow_run_id,operation,source_case_id,source_revision,decision,created_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (id) DO UPDATE SET decision=EXCLUDED.decision,data=EXCLUDED.data', [proposal.id,run.id,proposal.operation,proposal.sourceCaseId??null,proposal.sourceRevision??null,proposal.decision,proposal.createdAt,JSON.stringify(proposal)])
      for (const decision of proposal.decisions) await client.query('INSERT INTO smarthub.case_change_proposal_decisions (id,proposal_id,expected_version,decision,decided_by,decided_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (id) DO NOTHING', [decision.id,proposal.id,decision.expectedVersion,decision.decision,decision.decidedBy,decision.decidedAt,JSON.stringify(decision)])
    }
  }
  for (const testCase of aggregate.libraryCases) {
    await client.query('INSERT INTO smarthub.library_test_cases (id,project_id,current_revision,status,created_at,updated_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (id) DO UPDATE SET current_revision=EXCLUDED.current_revision,status=EXCLUDED.status,updated_at=EXCLUDED.updated_at,data=EXCLUDED.data', [testCase.id,testCase.projectId,testCase.currentRevision,testCase.status,testCase.createdAt,testCase.updatedAt,JSON.stringify(testCase)])
    for (const revision of testCase.revisions) {
      await client.query('INSERT INTO smarthub.library_test_case_revisions (case_id,revision,content_sha256,semantic_sha256,source_run_id,source_proposal_id,created_by,created_at,content,traceability,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb) ON CONFLICT (case_id,revision) DO NOTHING', [testCase.id,revision.revision,revision.contentSha256,revision.semanticSha256,revision.sourceRunId??null,revision.sourceProposalId??null,revision.createdBy,revision.createdAt,JSON.stringify(revision.content),revision.traceability?JSON.stringify(revision.traceability):null,JSON.stringify(revision)])
      for (const reference of revision.traceability?.requirementRefs ?? []) await client.query('INSERT INTO smarthub.library_test_case_revision_requirement_refs (case_id,case_revision,requirement_release_id,requirement_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [testCase.id,revision.revision,reference.requirementReleaseId,reference.requirementId])
    }
  }
  for (const version of aggregate.libraryVersions) {
    await client.query('INSERT INTO smarthub.test_case_library_versions (id,project_id,version,name,source_run_id,legacy_test_case_set_version_id,content_sha256,published_by,published_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT (id) DO NOTHING', [version.id,version.projectId,version.version,version.name,version.sourceRunId??null,version.legacyTestCaseSetVersionId??null,version.contentSha256,version.publishedBy,version.publishedAt,JSON.stringify(version)])
    for (const member of version.members) await client.query('INSERT INTO smarthub.test_case_library_version_members (version_id,case_id,case_revision,ordinal,content_sha256,frozen_content,traceability,execution_readiness) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8) ON CONFLICT (version_id,case_id) DO UPDATE SET case_revision=EXCLUDED.case_revision,ordinal=EXCLUDED.ordinal,content_sha256=EXCLUDED.content_sha256,frozen_content=COALESCE(EXCLUDED.frozen_content,smarthub.test_case_library_version_members.frozen_content),traceability=COALESCE(EXCLUDED.traceability,smarthub.test_case_library_version_members.traceability),execution_readiness=COALESCE(EXCLUDED.execution_readiness,smarthub.test_case_library_version_members.execution_readiness)', [version.id,member.caseId,member.revision,member.ordinal,member.contentSha256,member.frozenContent?JSON.stringify(member.frozenContent):null,member.traceability?JSON.stringify(member.traceability):null,member.executionReadiness??member.frozenContent?.executionSpec?.executionReadiness??null])
  }
  for (const draft of aggregate.suiteDrafts) {
    await client.query('INSERT INTO smarthub.test_suite_drafts (id,project_id,suite_key,suite_type,status,content_sha256,created_at,updated_at,test_case_library_version_id,compatibility_status,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,content_sha256=EXCLUDED.content_sha256,updated_at=EXCLUDED.updated_at,test_case_library_version_id=EXCLUDED.test_case_library_version_id,compatibility_status=EXCLUDED.compatibility_status,data=EXCLUDED.data', [draft.id,draft.projectId,draft.suiteKey,draft.suiteType,draft.status,draft.contentSha256,draft.createdAt,draft.updatedAt,draft.testCaseLibraryVersionId??null,draft.compatibilityStatus??null,JSON.stringify(draft)])
    await client.query('DELETE FROM smarthub.test_suite_draft_members WHERE draft_id=$1', [draft.id])
    for (const member of draft.members) await client.query('INSERT INTO smarthub.test_suite_draft_members (draft_id,case_id,case_revision,ordinal,execution_method,data) VALUES ($1,$2,$3,$4,$5,$6::jsonb)', [draft.id,member.caseId,member.revision,member.ordinal,member.executionMethod??member.executionMethods[0],JSON.stringify(member)])
  }
  for (const version of aggregate.caseSetVersions) {
    await client.query('INSERT INTO smarthub.test_case_set_versions (id,project_id,project_version_id,test_design_id,version,content_sha256,published_by,published_at,content,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb) ON CONFLICT (id) DO UPDATE SET content_sha256=EXCLUDED.content_sha256,content=EXCLUDED.content,data=EXCLUDED.data', [version.id,version.projectId,version.projectVersionId,version.testDesignId,version.version,version.contentSha256,version.publishedBy,version.publishedAt,JSON.stringify(version.canonicalContent),JSON.stringify(version)])
    for (const member of version.members) await client.query('INSERT INTO smarthub.test_case_set_members (version_id,case_id,case_revision,ordinal,content_sha256) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (version_id,case_id) DO UPDATE SET case_revision=EXCLUDED.case_revision,ordinal=EXCLUDED.ordinal,content_sha256=EXCLUDED.content_sha256', [version.id,member.caseId,member.revision,member.ordinal,member.contentSha256])
    await client.query('INSERT INTO smarthub.test_case_asset_publications (id,version_id,status,content_sha256,created_at,data) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,data=EXCLUDED.data', [`${version.id}:projection`,version.id,version.projection.status,version.contentSha256,version.publishedAt,JSON.stringify(version.projection)])
  }
  for (const suite of aggregate.suiteVersions) {
    await client.query('INSERT INTO smarthub.test_suite_versions (id,project_id,suite_key,suite_type,version,content_sha256,published_at,test_case_library_version_id,compatibility_status,content,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb) ON CONFLICT (id) DO UPDATE SET content_sha256=EXCLUDED.content_sha256,test_case_library_version_id=EXCLUDED.test_case_library_version_id,compatibility_status=EXCLUDED.compatibility_status,content=EXCLUDED.content,data=EXCLUDED.data', [suite.id,suite.projectId,suite.suiteKey,suite.suiteType,suite.version,suite.contentSha256,suite.publishedAt,suite.testCaseLibraryVersionId??null,suite.compatibilityStatus??null,JSON.stringify(suite.members),JSON.stringify(suite)])
    for (const member of suite.members) await client.query('INSERT INTO smarthub.test_suite_version_members (suite_version_id,test_case_set_version_id,test_case_library_version_id,case_id,case_revision,ordinal,execution_methods,execution_method,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT (suite_version_id,case_id) DO UPDATE SET case_revision=EXCLUDED.case_revision,ordinal=EXCLUDED.ordinal,execution_methods=EXCLUDED.execution_methods,execution_method=EXCLUDED.execution_method,data=EXCLUDED.data', [suite.id,member.testCaseSetVersionId??null,member.testCaseLibraryVersionId??null,member.caseId,member.revision,member.ordinal,member.executionMethods.length?member.executionMethods:null,member.executionMethod??member.executionMethods[0]??null,JSON.stringify(member)])
  }
  for (const version of aggregate.caseSetVersions) {
    const run = aggregate.runs.find(item => item.id === version.runId)
    await client.query('DELETE FROM smarthub.test_case_smoke_candidates WHERE test_case_set_version_id=$1', [version.id])
    await client.query('DELETE FROM smarthub.test_case_impacted_regression_refs WHERE test_case_set_version_id=$1', [version.id])
    for (const relation of run?.smokeCandidates.filter(item => !item.testCaseSetVersionId || item.testCaseSetVersionId === version.id) ?? []) await client.query('INSERT INTO smarthub.test_case_smoke_candidates (test_case_set_version_id,case_id,decision,execution_methods,updated_at,data) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (test_case_set_version_id,case_id) DO UPDATE SET decision=EXCLUDED.decision,execution_methods=EXCLUDED.execution_methods,updated_at=EXCLUDED.updated_at,data=EXCLUDED.data', [version.id,relation.caseId,relation.decision,relation.executionMethods,relation.reviewedAt??version.publishedAt,JSON.stringify(relation)])
    for (const relation of run?.impactedRegression.filter(item => !item.testCaseSetVersionId || item.testCaseSetVersionId === version.id) ?? []) { const id = `impact_${createHash('sha256').update(`${version.id}:${relation.suiteVersionId}:${relation.caseId}`).digest('hex').slice(0,24)}`; await client.query('INSERT INTO smarthub.test_case_impacted_regression_refs (id,test_case_set_version_id,suite_version_id,case_id,execution_methods,created_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (id) DO UPDATE SET execution_methods=EXCLUDED.execution_methods,data=EXCLUDED.data', [id,version.id,relation.suiteVersionId,relation.caseId,relation.executionMethods,relation.createdAt,JSON.stringify(relation)]) }
  }
  for (const handoff of aggregate.executionHandoffs) {
    await client.query('INSERT INTO smarthub.test_execution_handoffs (id,project_version_id,test_case_set_version_id,test_case_library_version_id,suite_version_id,strategy,execution_mode,content_sha256,created_by,created_at,content,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb) ON CONFLICT (id) DO NOTHING', [handoff.id,handoff.projectVersionId,handoff.testCaseSetVersionId??null,handoff.testCaseLibraryVersionId??null,handoff.suiteVersionId??null,handoff.strategy??handoff.mode,handoff.mode??null,handoff.contentSha256,handoff.createdBy,handoff.createdAt,JSON.stringify(handoff.members),JSON.stringify(handoff)])
    for (const member of handoff.members) await client.query('INSERT INTO smarthub.test_execution_handoff_members (handoff_id,stage,ordinal,source_version_id,case_id,case_revision,method,dedup_key,dimension,execution_spec,traceability,content_sha256,readiness_override,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13::jsonb,$14::jsonb) ON CONFLICT (handoff_id,stage,ordinal) DO UPDATE SET source_version_id=EXCLUDED.source_version_id,case_id=EXCLUDED.case_id,case_revision=EXCLUDED.case_revision,method=EXCLUDED.method,dedup_key=EXCLUDED.dedup_key,dimension=EXCLUDED.dimension,execution_spec=EXCLUDED.execution_spec,traceability=EXCLUDED.traceability,content_sha256=EXCLUDED.content_sha256,readiness_override=EXCLUDED.readiness_override,data=EXCLUDED.data', [handoff.id,member.stage,member.ordinal,member.sourceVersionId,member.caseId,member.revision,member.method,member.dedupKey,member.dimension??null,member.executionSpec?JSON.stringify(member.executionSpec):null,member.traceability?JSON.stringify(member.traceability):null,member.contentSha256??null,member.readinessOverride?JSON.stringify(member.readinessOverride):null,JSON.stringify(member)])
  }
  for (const migration of aggregate.legacyMigrations) {
    await client.query('INSERT INTO smarthub.legacy_test_case_migrations (id,project_id,legacy_test_case_set_version_id,test_case_library_version_id,preview_sha256,migrated_by,migrated_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (id) DO NOTHING', [migration.id,migration.projectId,migration.legacyTestCaseSetVersionId,migration.testCaseLibraryVersionId,migration.previewSha256,migration.migratedBy,migration.migratedAt,JSON.stringify(migration)])
    for (const mapping of migration.mappings) await client.query('INSERT INTO smarthub.legacy_test_case_id_mappings (migration_id,project_id,legacy_test_case_set_version_id,legacy_case_id,legacy_revision,library_case_id,library_revision,resolution,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT DO NOTHING', [migration.id,migration.projectId,migration.legacyTestCaseSetVersionId,mapping.legacyCaseId,mapping.legacyRevision,mapping.libraryCaseId,mapping.libraryRevision,mapping.resolution,JSON.stringify(mapping)])
  }
}

async function deleteRemovedTestDesignState(client: PoolClient, before: DatabaseState, state: DatabaseState) {
  const previous = before.testDesignState
  if (!previous) return
  const current = state.testDesignState ?? { architectureVersion: 'single-agent-skills/v1' as const, designs: [], runs: [], caseSetVersions: [], libraryCases: [], libraryVersions: [], suiteDrafts: [], suiteVersions: [], executionHandoffs: [], legacyMigrations: [] }
  const removedHandoffs = previous.executionHandoffs.filter(item => !current.executionHandoffs.some(candidate => candidate.id === item.id)).map(item => item.id)
  if (removedHandoffs.length) await client.query('DELETE FROM smarthub.test_execution_handoffs WHERE id = ANY($1::text[])', [removedHandoffs])
  const removedCaseSets = previous.caseSetVersions.filter(item => !current.caseSetVersions.some(candidate => candidate.id === item.id)).map(item => item.id)
  if (removedCaseSets.length) await client.query('DELETE FROM smarthub.test_case_set_versions WHERE id = ANY($1::text[])', [removedCaseSets])
  const removedSuites = previous.suiteVersions.filter(item => !current.suiteVersions.some(candidate => candidate.id === item.id)).map(item => item.id)
  if (removedSuites.length) {
    await client.query('DELETE FROM smarthub.test_case_impacted_regression_refs WHERE suite_version_id = ANY($1::text[])', [removedSuites])
    await client.query('DELETE FROM smarthub.test_suite_versions WHERE id = ANY($1::text[])', [removedSuites])
  }
  const removedRuns = previous.runs.filter(item => !current.runs.some(candidate => candidate.id === item.id)).map(item => item.id)
  if (removedRuns.length) {
    await client.query('DELETE FROM smarthub.test_design_coverage_relations WHERE audit_id IN (SELECT id FROM smarthub.test_design_coverage_audits WHERE workflow_run_id = ANY($1::text[]))', [removedRuns])
    for (const table of ['test_design_coverage_audits', 'test_design_basis_relations', 'test_design_findings', 'test_design_confirmation_items', 'test_design_snapshot_items', 'test_design_retrieval_snapshots', 'test_design_historical_case_snapshots'] as const) await client.query(`DELETE FROM smarthub.${table} WHERE workflow_run_id = ANY($1::text[])`, [removedRuns])
    await client.query('DELETE FROM smarthub.test_design_basis_snapshots WHERE workflow_run_id = ANY($1::text[])', [removedRuns])
    await client.query("DELETE FROM smarthub.frozen_content_refs WHERE owner_type='workflow_run' AND owner_id = ANY($1::text[])", [removedRuns])
    await client.query('DELETE FROM smarthub.test_case_dependencies WHERE case_id IN (SELECT id FROM smarthub.test_cases WHERE workflow_run_id = ANY($1::text[])) OR target_case_id IN (SELECT id FROM smarthub.test_cases WHERE workflow_run_id = ANY($1::text[]))', [removedRuns])
    await client.query('DELETE FROM smarthub.test_cases WHERE workflow_run_id = ANY($1::text[])', [removedRuns])
    await client.query('DELETE FROM smarthub.test_data_requirement_sets WHERE workflow_run_id = ANY($1::text[])', [removedRuns])
    await client.query("DELETE FROM smarthub.workflow_runs WHERE domain_type='test_design' AND id = ANY($1::text[])", [removedRuns])
  }
  const removedDesigns = previous.designs.filter(item => !current.designs.some(candidate => candidate.id === item.id)).map(item => item.id)
  if (removedDesigns.length) await client.query('DELETE FROM smarthub.test_designs WHERE id = ANY($1::text[])', [removedDesigns])
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
    throw new Error('需求分析历史游标无效')
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
