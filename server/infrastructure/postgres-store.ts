import { Pool, type PoolClient } from 'pg'
import type { DatabaseState } from '../domain/types.js'
import type { ChunkSearchInput, StateStore, StoredChunkCandidate } from './store.js'

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

  async searchChunks(input: ChunkSearchInput): Promise<StoredChunkCandidate[]> {
    if (!input.versionIds.length) return []
    const dimensions = positiveInteger(input.dimensions, '向量维度')
    const limit = positiveInteger(input.limit, '召回数量')
    const filters = [input.versionIds, input.mode === 'vector' ? encodeVector(input.queryVector ?? []) : input.query, input.assetType ?? null, input.sourceType ?? null, input.logicalPath ?? null, limit]
    const score = input.mode === 'vector'
      ? `(1 + (1 - (c.embedding::vector(${dimensions}) <=> $2::vector(${dimensions})))) / 2`
      : `(CASE WHEN c.content ILIKE '%' || $2 || '%' THEN 0.7 ELSE 0 END) + similarity(c.content, $2) * 0.3`
    const ordering = input.mode === 'vector'
      ? `c.embedding::vector(${dimensions}) <=> $2::vector(${dimensions})`
      : `${score} DESC`
    const retrievalPredicate = input.mode === 'keyword' ? `AND (c.content ILIKE '%' || $2 || '%' OR c.content % $2)` : ''
    const result = await this.pool.query<{
      score: number; asset_id: string; display_name: string; asset_type: string; source_type: string; logical_path: string
      version_id: string; version_number: number; chunk_id: string; chunk_key: string; content: string; chunk_data: Record<string, unknown>
    }>(`
      SELECT ${score} AS score,
        a.id AS asset_id, a.display_name, a.asset_type, a.source_type, a.logical_path,
        v.id AS version_id, v.version AS version_number,
        c.id AS chunk_id, c.chunk_key, c.content, c.data AS chunk_data
      FROM smarthub.asset_chunks c
      JOIN smarthub.asset_versions v ON v.id = c.asset_version_id
      JOIN smarthub.knowledge_assets a ON a.id = v.asset_id
      WHERE v.id = ANY($1::text[])
        AND c.embedding_dimensions = ${dimensions}
        AND ($3::text IS NULL OR a.asset_type = $3)
        AND ($4::text IS NULL OR a.source_type = $4)
        AND ($5::text IS NULL OR a.logical_path LIKE '%' || $5 || '%')
        ${retrievalPredicate}
      ORDER BY ${ordering}
      LIMIT $6
    `, filters)
    return result.rows.map(row => {
      const chunk = row.chunk_data
      return {
        score: Number(row.score),
        asset: { id: row.asset_id, displayName: row.display_name, assetType: row.asset_type, sourceType: row.source_type, logicalPath: row.logical_path },
        version: { id: row.version_id, number: row.version_number },
        chunk: {
          id: row.chunk_id,
          chunkKey: row.chunk_key,
          headingPath: stringArray(chunk.headingPath),
          startLine: Number(chunk.startLine ?? 0), endLine: Number(chunk.endLine ?? 0),
          startChar: Number(chunk.startChar ?? 0), endChar: Number(chunk.endChar ?? 0),
        },
        content: row.content,
      }
    })
  }

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
  await client.query('CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;')
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS smarthub;
    CREATE TABLE IF NOT EXISTS smarthub.projects (id text PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS smarthub.knowledge_bases (id text PRIMARY KEY, project_id text NOT NULL REFERENCES smarthub.projects(id), name text NOT NULL, active_index_version_id text, active_config_version_id text NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS smarthub.knowledge_directories (id text PRIMARY KEY, knowledge_base_id text NOT NULL REFERENCES smarthub.knowledge_bases(id), parent_id text REFERENCES smarthub.knowledge_directories(id), name text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, data jsonb NOT NULL, UNIQUE (knowledge_base_id, parent_id, name));
    CREATE TABLE IF NOT EXISTS smarthub.config_versions (id text PRIMARY KEY, knowledge_base_id text NOT NULL REFERENCES smarthub.knowledge_bases(id), version integer NOT NULL, requires_rebuild boolean NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL, UNIQUE (knowledge_base_id, version));
    CREATE TABLE IF NOT EXISTS smarthub.knowledge_assets (id text PRIMARY KEY, knowledge_base_id text NOT NULL REFERENCES smarthub.knowledge_bases(id), logical_path text NOT NULL, display_name text NOT NULL, asset_type text NOT NULL, source_type text NOT NULL, active_version_id text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, data jsonb NOT NULL, UNIQUE (knowledge_base_id, logical_path));
    CREATE TABLE IF NOT EXISTS smarthub.asset_versions (id text PRIMARY KEY, asset_id text NOT NULL REFERENCES smarthub.knowledge_assets(id), version integer NOT NULL, content_hash char(64) NOT NULL, status text NOT NULL, config_version_id text NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL, UNIQUE (asset_id, version));
    CREATE TABLE IF NOT EXISTS smarthub.asset_chunks (id text PRIMARY KEY, asset_version_id text NOT NULL REFERENCES smarthub.asset_versions(id) ON DELETE CASCADE, chunk_key text NOT NULL, ordinal integer NOT NULL, content text NOT NULL, content_hash char(64) NOT NULL, embedding vector NOT NULL, embedding_dimensions integer NOT NULL, data jsonb NOT NULL, UNIQUE (asset_version_id, chunk_key));
    CREATE TABLE IF NOT EXISTS smarthub.index_versions (id text PRIMARY KEY, knowledge_base_id text NOT NULL REFERENCES smarthub.knowledge_bases(id), version integer NOT NULL, status text NOT NULL, config_version_id text NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL, UNIQUE (knowledge_base_id, version));
    CREATE TABLE IF NOT EXISTS smarthub.sync_tasks (id text PRIMARY KEY, knowledge_base_id text NOT NULL REFERENCES smarthub.knowledge_bases(id), type text NOT NULL, status text NOT NULL, step text NOT NULL, progress integer NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL);
    CREATE INDEX IF NOT EXISTS knowledge_assets_kb_path_idx ON smarthub.knowledge_assets (knowledge_base_id, logical_path);
    CREATE INDEX IF NOT EXISTS asset_chunks_version_idx ON smarthub.asset_chunks (asset_version_id);
    CREATE INDEX IF NOT EXISTS asset_chunks_content_trgm_idx ON smarthub.asset_chunks USING gin (content gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS sync_tasks_kb_created_idx ON smarthub.sync_tasks (knowledge_base_id, created_at DESC);
  `)
  await client.query(`
    ALTER TABLE smarthub.asset_chunks ADD COLUMN IF NOT EXISTS embedding_dimensions integer;
    DO $$
    BEGIN
      IF (SELECT udt_name = '_float8' FROM information_schema.columns WHERE table_schema = 'smarthub' AND table_name = 'asset_chunks' AND column_name = 'embedding') THEN
        UPDATE smarthub.asset_chunks SET embedding_dimensions = array_length(embedding, 1) WHERE embedding_dimensions IS NULL;
        ALTER TABLE smarthub.asset_chunks ALTER COLUMN embedding TYPE vector USING ('[' || array_to_string(embedding, ',') || ']')::vector;
      END IF;
    END $$;
    UPDATE smarthub.asset_chunks SET embedding_dimensions = vector_dims(embedding) WHERE embedding_dimensions IS NULL;
    ALTER TABLE smarthub.asset_chunks ALTER COLUMN embedding_dimensions SET NOT NULL;
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_chunks_embedding_dimensions_check' AND conrelid = 'smarthub.asset_chunks'::regclass) THEN
        ALTER TABLE smarthub.asset_chunks ADD CONSTRAINT asset_chunks_embedding_dimensions_check CHECK (embedding_dimensions = vector_dims(embedding));
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS asset_chunks_embedding_384_hnsw_idx ON smarthub.asset_chunks USING hnsw ((embedding::vector(384)) vector_cosine_ops) WHERE embedding_dimensions = 384;
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
    for (const chunk of item.chunks) await client.query('INSERT INTO smarthub.asset_chunks (id, asset_version_id, chunk_key, ordinal, content, content_hash, embedding, embedding_dimensions, data) VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8,$9::jsonb)', [chunk.id, item.id, chunk.chunkKey, chunk.ordinal, chunk.content, chunk.contentHash, encodeVector(chunk.embedding), chunk.embedding.length, JSON.stringify(chunk)])
  }
  for (const item of state.indexes) await client.query('INSERT INTO smarthub.index_versions VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)', [item.id, item.knowledgeBaseId, item.number, item.status, item.configVersionId, item.createdAt, JSON.stringify(item)])
  for (const item of state.tasks) await client.query('INSERT INTO smarthub.sync_tasks VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [item.id, item.knowledgeBaseId, item.type, item.status, item.step, item.progress, item.createdAt, JSON.stringify(item)])
}

function encodeVector(vector: number[]) {
  if (!vector.length || vector.some(value => !Number.isFinite(value))) throw new Error('向量不能为空且必须全部为有限数值')
  return `[${vector.join(',')}]`
}

function positiveInteger(value: number, name: string) { if (!Number.isInteger(value) || value <= 0) throw new Error(`${name}必须是正整数`); return value }
function stringArray(value: unknown) { return Array.isArray(value) ? value.map(String) : [] }

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
