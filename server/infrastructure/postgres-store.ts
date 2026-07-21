import { Pool, type PoolClient } from 'pg'
import type { DatabaseState } from '../domain/types.js'
import type { StateStore } from './store.js'

const emptyState = (): DatabaseState => ({ projects: [], knowledgeBases: [], directories: [], configs: [], assets: [], versions: [], indexes: [], tasks: [] })

export class PostgresStore implements StateStore {
  private state: DatabaseState = emptyState()
  private queue = Promise.resolve()
  private readonly pool: Pool

  constructor(connectionString: string) { this.pool = new Pool({ connectionString }) }

  async load() {
    const client = await this.pool.connect()
    try {
      await migrate(client)
      this.state = await loadState(client)
    } finally { client.release() }
  }

  read() { return structuredClone(this.state) }

  async close() { await this.pool.end() }

  async transaction<T>(operation: (draft: DatabaseState) => T | Promise<T>): Promise<T> {
    let result!: T
    this.queue = this.queue.then(async () => {
      const draft = structuredClone(this.state)
      result = await operation(draft)
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query("SELECT pg_advisory_xact_lock(hashtext('smarthub_state'))")
        await persistState(client, draft)
        await client.query('COMMIT')
        this.state = draft
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    })
    await this.queue
    return result
  }
}

async function migrate(client: PoolClient) {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS smarthub;
    CREATE TABLE IF NOT EXISTS smarthub.projects (id text PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS smarthub.knowledge_bases (id text PRIMARY KEY, project_id text NOT NULL REFERENCES smarthub.projects(id), name text NOT NULL, active_index_version_id text, active_config_version_id text NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS smarthub.knowledge_directories (id text PRIMARY KEY, knowledge_base_id text NOT NULL REFERENCES smarthub.knowledge_bases(id), parent_id text REFERENCES smarthub.knowledge_directories(id), name text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, data jsonb NOT NULL, UNIQUE (knowledge_base_id, parent_id, name));
    CREATE TABLE IF NOT EXISTS smarthub.config_versions (id text PRIMARY KEY, knowledge_base_id text NOT NULL REFERENCES smarthub.knowledge_bases(id), version integer NOT NULL, requires_rebuild boolean NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL, UNIQUE (knowledge_base_id, version));
    CREATE TABLE IF NOT EXISTS smarthub.knowledge_assets (id text PRIMARY KEY, knowledge_base_id text NOT NULL REFERENCES smarthub.knowledge_bases(id), logical_path text NOT NULL, display_name text NOT NULL, asset_type text NOT NULL, source_type text NOT NULL, active_version_id text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, data jsonb NOT NULL, UNIQUE (knowledge_base_id, logical_path));
    CREATE TABLE IF NOT EXISTS smarthub.asset_versions (id text PRIMARY KEY, asset_id text NOT NULL REFERENCES smarthub.knowledge_assets(id), version integer NOT NULL, content_hash char(64) NOT NULL, status text NOT NULL, config_version_id text NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL, UNIQUE (asset_id, version));
    CREATE TABLE IF NOT EXISTS smarthub.asset_chunks (id text PRIMARY KEY, asset_version_id text NOT NULL REFERENCES smarthub.asset_versions(id) ON DELETE CASCADE, chunk_key text NOT NULL, ordinal integer NOT NULL, content text NOT NULL, content_hash char(64) NOT NULL, embedding double precision[] NOT NULL, data jsonb NOT NULL, UNIQUE (asset_version_id, chunk_key));
    CREATE TABLE IF NOT EXISTS smarthub.index_versions (id text PRIMARY KEY, knowledge_base_id text NOT NULL REFERENCES smarthub.knowledge_bases(id), version integer NOT NULL, status text NOT NULL, config_version_id text NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL, UNIQUE (knowledge_base_id, version));
    CREATE TABLE IF NOT EXISTS smarthub.sync_tasks (id text PRIMARY KEY, knowledge_base_id text NOT NULL REFERENCES smarthub.knowledge_bases(id), type text NOT NULL, status text NOT NULL, step text NOT NULL, progress integer NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL);
    CREATE INDEX IF NOT EXISTS knowledge_assets_kb_path_idx ON smarthub.knowledge_assets (knowledge_base_id, logical_path);
    CREATE INDEX IF NOT EXISTS asset_chunks_version_idx ON smarthub.asset_chunks (asset_version_id);
    CREATE INDEX IF NOT EXISTS sync_tasks_kb_created_idx ON smarthub.sync_tasks (knowledge_base_id, created_at DESC);
  `)
}

async function loadState(client: PoolClient): Promise<DatabaseState> {
  const tables = ['projects', 'knowledge_bases', 'knowledge_directories', 'config_versions', 'knowledge_assets', 'asset_versions', 'index_versions', 'sync_tasks'] as const
  const rows = []
  for (const table of tables) rows.push(await client.query<{ data: DatabaseState[keyof DatabaseState][number] }>(`SELECT data FROM smarthub.${table} ORDER BY created_at, id`))
  return { projects: rows[0].rows.map(row => row.data) as DatabaseState['projects'], knowledgeBases: rows[1].rows.map(row => row.data) as DatabaseState['knowledgeBases'], directories: rows[2].rows.map(row => row.data) as DatabaseState['directories'], configs: rows[3].rows.map(row => row.data) as DatabaseState['configs'], assets: rows[4].rows.map(row => row.data) as DatabaseState['assets'], versions: rows[5].rows.map(row => row.data) as DatabaseState['versions'], indexes: rows[6].rows.map(row => row.data) as DatabaseState['indexes'], tasks: rows[7].rows.map(row => row.data) as DatabaseState['tasks'] }
}

async function persistState(client: PoolClient, state: DatabaseState) {
  await client.query('TRUNCATE smarthub.asset_chunks, smarthub.sync_tasks, smarthub.index_versions, smarthub.asset_versions, smarthub.knowledge_assets, smarthub.config_versions, smarthub.knowledge_directories, smarthub.knowledge_bases, smarthub.projects CASCADE')
  for (const item of state.projects) await client.query('INSERT INTO smarthub.projects VALUES ($1,$2,$3,$4::jsonb)', [item.id, item.name, item.createdAt, JSON.stringify(item)])
  for (const item of state.knowledgeBases) await client.query('INSERT INTO smarthub.knowledge_bases VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)', [item.id, item.projectId, item.name, item.activeIndexVersionId, item.activeConfigVersionId, item.createdAt, JSON.stringify(item)])
  for (const item of orderDirectories(state.directories)) await client.query('INSERT INTO smarthub.knowledge_directories VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)', [item.id, item.knowledgeBaseId, item.parentId, item.name, item.createdAt, item.updatedAt, JSON.stringify(item)])
  for (const item of state.configs) await client.query('INSERT INTO smarthub.config_versions VALUES ($1,$2,$3,$4,$5,$6::jsonb)', [item.id, item.knowledgeBaseId, item.version, item.requiresRebuild, item.createdAt, JSON.stringify(item)])
  for (const item of state.assets) await client.query('INSERT INTO smarthub.knowledge_assets VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)', [item.id, item.knowledgeBaseId, item.logicalPath, item.displayName, item.assetType, item.sourceType, item.activeVersionId, item.createdAt, item.updatedAt, JSON.stringify(item)])
  for (const item of state.versions) {
    await client.query('INSERT INTO smarthub.asset_versions VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [item.id, item.assetId, item.number, item.contentHash, item.status, item.configVersionId, item.createdAt, JSON.stringify(item)])
    for (const chunk of item.chunks) await client.query('INSERT INTO smarthub.asset_chunks VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [chunk.id, item.id, chunk.chunkKey, chunk.ordinal, chunk.content, chunk.contentHash, chunk.embedding, JSON.stringify(chunk)])
  }
  for (const item of state.indexes) await client.query('INSERT INTO smarthub.index_versions VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)', [item.id, item.knowledgeBaseId, item.number, item.status, item.configVersionId, item.createdAt, JSON.stringify(item)])
  for (const item of state.tasks) await client.query('INSERT INTO smarthub.sync_tasks VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [item.id, item.knowledgeBaseId, item.type, item.status, item.step, item.progress, item.createdAt, JSON.stringify(item)])
}

function orderDirectories(directories: DatabaseState['directories']) {
  const ordered: DatabaseState['directories'] = []
  const remaining = [...directories]
  while (remaining.length) {
    const index = remaining.findIndex(item => !item.parentId || ordered.some(parent => parent.id === item.parentId))
    if (index < 0) throw new Error('知识库目录层级存在循环或缺失父目录')
    ordered.push(remaining.splice(index, 1)[0])
  }
  return ordered
}
