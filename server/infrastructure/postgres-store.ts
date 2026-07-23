import { createHash } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import type { Chunk, DatabaseState, IndexChunk, SyncTask } from '../domain/types.js'
import type { ChunkSearchInput, StateStore, StoredChunkCandidate, TaskLease } from './store.js'
import { verifyMigrations } from './migrations.js'

const emptyState = (): DatabaseState => ({ projects: [], knowledgeBases: [], directories: [], configs: [], assets: [], versions: [], indexes: [], tasks: [], modelSources: [] })

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
      this.state = await loadState(client)
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

  async transactionWithTaskLease<T>(taskId: string, lease: TaskLease, operation: (draft: DatabaseState) => T | Promise<T>): Promise<T | null> {
    return this.runTransaction(operation, { taskId, lease })
  }

  private async runTransaction<T>(operation: (draft: DatabaseState) => T | Promise<T>, fencing?: { taskId: string; lease: TaskLease }): Promise<T | null> {
    let result: T | null = null
    let failure: unknown
    this.queue = this.queue.then(async () => {
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query("SELECT pg_advisory_xact_lock(hashtext('smarthub_state'))")
        if (fencing) {
          const owned = await client.query(`
            SELECT 1 FROM smarthub.sync_tasks
            WHERE id = $1 AND status = 'running' AND lease_owner = $2
              AND run_token = $3::uuid AND lease_expires_at > now()
            FOR UPDATE
          `, [fencing.taskId, fencing.lease.workerId, fencing.lease.runToken])
          if (owned.rowCount !== 1) { await client.query('ROLLBACK'); return }
        }
        const before = await loadState(client)
        const draft = structuredClone(before)
        result = await operation(draft)
        if (fencing) {
          const stillOwned = await client.query(`
            SELECT 1 FROM smarthub.sync_tasks
            WHERE id = $1 AND status = 'running' AND lease_owner = $2
              AND run_token = $3::uuid AND lease_expires_at > now()
            FOR UPDATE
          `, [fencing.taskId, fencing.lease.workerId, fencing.lease.runToken])
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
  return { projects: rows[0].rows.map(row => row.data) as DatabaseState['projects'], knowledgeBases: rows[1].rows.map(row => row.data) as DatabaseState['knowledgeBases'], directories: rows[2].rows.map(row => row.data) as DatabaseState['directories'], configs: rows[3].rows.map(row => row.data) as DatabaseState['configs'], assets: rows[4].rows.map(row => row.data) as DatabaseState['assets'], versions, indexes, tasks, modelSources: modelSources.rows.map(row => row.data) }
}

async function persistChanges(client: PoolClient, before: DatabaseState, state: DatabaseState) {
  await deleteMissing(client, 'model_sources', before.modelSources, state.modelSources)
  await deleteMissing(client, 'sync_tasks', before.tasks, state.tasks)
  await deleteMissing(client, 'index_versions', before.indexes, state.indexes)
  await deleteMissing(client, 'asset_versions', before.versions, state.versions)
  await deleteMissing(client, 'knowledge_assets', before.assets, state.assets)
  await deleteMissing(client, 'config_versions', before.configs, state.configs)
  await deleteMissing(client, 'knowledge_directories', before.directories, state.directories)
  await deleteMissing(client, 'knowledge_bases', before.knowledgeBases, state.knowledgeBases)
  await deleteMissing(client, 'projects', before.projects, state.projects)

  for (const item of changed(before.projects, state.projects)) await client.query('INSERT INTO smarthub.projects VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, created_at=EXCLUDED.created_at, data=EXCLUDED.data', [item.id, item.name, item.createdAt, JSON.stringify(item)])
  for (const item of changed(before.modelSources, state.modelSources)) await client.query('INSERT INTO smarthub.model_sources (id, display_name, provider_type, enabled, priority, created_at, updated_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name, provider_type=EXCLUDED.provider_type, enabled=EXCLUDED.enabled, priority=EXCLUDED.priority, updated_at=EXCLUDED.updated_at, data=EXCLUDED.data', [item.id, item.name, item.providerType, item.enabled, item.priority, item.createdAt, item.updatedAt, JSON.stringify(item)])
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
