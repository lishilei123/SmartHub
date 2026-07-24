import { createHash } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'

type Migration = { version: number; name: string; sql: string; transactional?: boolean; statements?: string[] }
type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>

const migrations: Migration[] = [{
  version: 1,
  name: 'initial-schema-and-task-queue',
  sql: `
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE SCHEMA IF NOT EXISTS smarthub;
    CREATE TABLE IF NOT EXISTS smarthub.projects (id text PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS smarthub.knowledge_bases (id text PRIMARY KEY, project_id text NOT NULL REFERENCES smarthub.projects(id), name text NOT NULL, active_index_version_id text, active_config_version_id text NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS smarthub.knowledge_directories (id text PRIMARY KEY, knowledge_base_id text NOT NULL REFERENCES smarthub.knowledge_bases(id), parent_id text REFERENCES smarthub.knowledge_directories(id), name text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, data jsonb NOT NULL, UNIQUE (knowledge_base_id, parent_id, name));
    CREATE TABLE IF NOT EXISTS smarthub.config_versions (id text PRIMARY KEY, knowledge_base_id text NOT NULL REFERENCES smarthub.knowledge_bases(id), version integer NOT NULL, requires_rebuild boolean NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL, UNIQUE (knowledge_base_id, version));
    CREATE TABLE IF NOT EXISTS smarthub.knowledge_assets (id text PRIMARY KEY, knowledge_base_id text NOT NULL REFERENCES smarthub.knowledge_bases(id), logical_path text NOT NULL, display_name text NOT NULL, asset_type text NOT NULL, source_type text NOT NULL, active_version_id text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, data jsonb NOT NULL, UNIQUE (knowledge_base_id, logical_path));
    CREATE TABLE IF NOT EXISTS smarthub.asset_versions (id text PRIMARY KEY, asset_id text NOT NULL REFERENCES smarthub.knowledge_assets(id), version integer NOT NULL, content_hash char(64) NOT NULL, status text NOT NULL, config_version_id text NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL, UNIQUE (asset_id, version));
    CREATE TABLE IF NOT EXISTS smarthub.asset_chunks (id text PRIMARY KEY, asset_version_id text NOT NULL REFERENCES smarthub.asset_versions(id) ON DELETE CASCADE, chunk_key text NOT NULL, ordinal integer NOT NULL, content text NOT NULL, content_hash char(64) NOT NULL, embedding vector NOT NULL, embedding_dimensions integer NOT NULL, data jsonb NOT NULL, UNIQUE (asset_version_id, chunk_key));
    CREATE TABLE IF NOT EXISTS smarthub.index_versions (id text PRIMARY KEY, knowledge_base_id text NOT NULL REFERENCES smarthub.knowledge_bases(id), version integer NOT NULL, status text NOT NULL, config_version_id text NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL, UNIQUE (knowledge_base_id, version));
    CREATE TABLE IF NOT EXISTS smarthub.index_chunks (index_version_id text NOT NULL REFERENCES smarthub.index_versions(id) ON DELETE CASCADE, id text NOT NULL, asset_version_id text NOT NULL REFERENCES smarthub.asset_versions(id), chunk_key text NOT NULL, ordinal integer NOT NULL, content text NOT NULL, content_hash char(64) NOT NULL, embedding vector NOT NULL, embedding_dimensions integer NOT NULL, data jsonb NOT NULL, PRIMARY KEY (index_version_id, id));
    CREATE TABLE IF NOT EXISTS smarthub.sync_tasks (id text PRIMARY KEY, knowledge_base_id text NOT NULL REFERENCES smarthub.knowledge_bases(id), type text NOT NULL, status text NOT NULL, step text NOT NULL, progress integer NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL);
    CREATE INDEX IF NOT EXISTS knowledge_assets_kb_path_idx ON smarthub.knowledge_assets (knowledge_base_id, logical_path);
    CREATE INDEX IF NOT EXISTS asset_chunks_version_idx ON smarthub.asset_chunks (asset_version_id);
    CREATE INDEX IF NOT EXISTS asset_chunks_content_trgm_idx ON smarthub.asset_chunks USING gin (content gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS index_chunks_index_version_idx ON smarthub.index_chunks (index_version_id);
    CREATE INDEX IF NOT EXISTS index_chunks_content_trgm_idx ON smarthub.index_chunks USING gin (content gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS sync_tasks_kb_created_idx ON smarthub.sync_tasks (knowledge_base_id, created_at DESC);

    ALTER TABLE smarthub.sync_tasks ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE smarthub.sync_tasks ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;
    ALTER TABLE smarthub.sync_tasks ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;
    ALTER TABLE smarthub.sync_tasks ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3;
    ALTER TABLE smarthub.sync_tasks ADD COLUMN IF NOT EXISTS dedupe_key text;
    ALTER TABLE smarthub.sync_tasks ADD COLUMN IF NOT EXISTS target_id text;
    ALTER TABLE smarthub.sync_tasks ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'asset';
    ALTER TABLE smarthub.sync_tasks ADD COLUMN IF NOT EXISTS lease_owner text;
    ALTER TABLE smarthub.sync_tasks ADD COLUMN IF NOT EXISTS run_token uuid;
    ALTER TABLE smarthub.sync_tasks ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
    ALTER TABLE smarthub.sync_tasks ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
    ALTER TABLE smarthub.sync_tasks ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;
    ALTER TABLE smarthub.sync_tasks ADD COLUMN IF NOT EXISTS started_at timestamptz;
    ALTER TABLE smarthub.sync_tasks ADD COLUMN IF NOT EXISTS finished_at timestamptz;
    ALTER TABLE smarthub.sync_tasks ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
    CREATE INDEX IF NOT EXISTS sync_tasks_claim_idx ON smarthub.sync_tasks (priority DESC, available_at, created_at) WHERE status = 'queued';
    CREATE INDEX IF NOT EXISTS sync_tasks_lease_idx ON smarthub.sync_tasks (lease_expires_at) WHERE status = 'running';
    CREATE INDEX IF NOT EXISTS sync_tasks_target_idx ON smarthub.sync_tasks (knowledge_base_id, target_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS sync_tasks_active_dedupe_idx ON smarthub.sync_tasks (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');
    CREATE TABLE IF NOT EXISTS smarthub.vector_index_catalog (
      index_version_id text NOT NULL REFERENCES smarthub.index_versions(id) ON DELETE CASCADE,
      embedding_dimensions integer NOT NULL,
      index_name text NOT NULL,
      status text NOT NULL,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      ready_at timestamptz,
      PRIMARY KEY (index_version_id, embedding_dimensions)
    );

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
    INSERT INTO smarthub.index_chunks (index_version_id, id, asset_version_id, chunk_key, ordinal, content, content_hash, embedding, embedding_dimensions, data)
    SELECT i.id, c.id, c.asset_version_id, c.chunk_key, c.ordinal, c.content, c.content_hash, c.embedding, c.embedding_dimensions, c.data
    FROM smarthub.index_versions i
    JOIN smarthub.asset_chunks c ON c.asset_version_id IN (SELECT jsonb_array_elements_text(i.data->'assetVersionIds'))
    ON CONFLICT (index_version_id, id) DO NOTHING;
  `,
}, {
  version: 2,
  name: 'drop-legacy-fixed-dimension-hnsw',
  transactional: false,
  sql: `
    DROP INDEX CONCURRENTLY IF EXISTS smarthub.asset_chunks_embedding_384_hnsw_idx;
    DROP INDEX CONCURRENTLY IF EXISTS smarthub.index_chunks_embedding_384_hnsw_idx;
  `,
  statements: [
    'DROP INDEX CONCURRENTLY IF EXISTS smarthub.asset_chunks_embedding_384_hnsw_idx',
    'DROP INDEX CONCURRENTLY IF EXISTS smarthub.index_chunks_embedding_384_hnsw_idx',
  ],
}, {
  version: 3,
  name: 'freeze-index-metadata-and-scrub-legacy-embedding-secrets',
  sql: `
    UPDATE smarthub.index_chunks chunk
    SET data = jsonb_set(
      chunk.data,
      '{assetMetadata}',
      jsonb_build_object(
        'assetId', asset.id,
        'displayName', asset.display_name,
        'assetType', asset.asset_type,
        'sourceType', asset.source_type,
        'logicalPath', asset.logical_path
      )
    )
    FROM smarthub.asset_versions version
    JOIN smarthub.knowledge_assets asset ON asset.id = version.asset_id
    WHERE chunk.asset_version_id = version.id
      AND NOT (chunk.data ? 'assetMetadata');

    CREATE OR REPLACE FUNCTION smarthub.scrub_embedding_secrets(value jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql
    IMMUTABLE
    AS $$
    DECLARE
      key text;
      item jsonb;
      result jsonb;
    BEGIN
      CASE jsonb_typeof(value)
        WHEN 'object' THEN
          result := '{}'::jsonb;
          FOR key, item IN SELECT * FROM jsonb_each(value) LOOP
            IF key IN ('embeddingApiKey', 'apiKey', 'embeddingBaseUrl', 'baseUrl') THEN CONTINUE; END IF;
            result := result || jsonb_build_object(key, smarthub.scrub_embedding_secrets(item));
          END LOOP;
          RETURN result;
        WHEN 'array' THEN
          RETURN COALESCE((SELECT jsonb_agg(smarthub.scrub_embedding_secrets(elements.item)) FROM jsonb_array_elements(value) AS elements(item)), '[]'::jsonb);
        ELSE
          RETURN value;
      END CASE;
    END $$;

    UPDATE smarthub.projects SET data = smarthub.scrub_embedding_secrets(data);
    UPDATE smarthub.knowledge_bases SET data = smarthub.scrub_embedding_secrets(data);
    UPDATE smarthub.knowledge_directories SET data = smarthub.scrub_embedding_secrets(data);
    UPDATE smarthub.config_versions SET data = smarthub.scrub_embedding_secrets(data);
    UPDATE smarthub.knowledge_assets SET data = smarthub.scrub_embedding_secrets(data);
    UPDATE smarthub.asset_versions SET data = smarthub.scrub_embedding_secrets(data) - 'error';
    UPDATE smarthub.asset_chunks SET data = smarthub.scrub_embedding_secrets(data);
    UPDATE smarthub.index_versions SET data = smarthub.scrub_embedding_secrets(data);
    UPDATE smarthub.index_chunks SET data = smarthub.scrub_embedding_secrets(data);
    UPDATE smarthub.sync_tasks SET data = smarthub.scrub_embedding_secrets(data) - 'error';
    DROP FUNCTION smarthub.scrub_embedding_secrets(jsonb);
  `,
}, {
  version: 4,
  name: 'generative model registry',
  sql: `
    CREATE TABLE IF NOT EXISTS smarthub.model_sources (
      id text PRIMARY KEY,
      display_name text NOT NULL,
      provider_type text NOT NULL,
      enabled boolean NOT NULL,
      priority integer NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      data jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS model_sources_priority_idx ON smarthub.model_sources (priority, created_at);
  `,
}, {
  version: 5,
  name: 'project-version-isolation',
  sql: `
    CREATE TABLE IF NOT EXISTS smarthub.project_versions (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES smarthub.projects(id),
      name text NOT NULL,
      status text NOT NULL,
      source_project_version_id text REFERENCES smarthub.project_versions(id),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      data jsonb NOT NULL,
      UNIQUE (project_id, name)
    );
    CREATE TABLE IF NOT EXISTS smarthub.project_version_requirement_bindings (
      id text PRIMARY KEY,
      project_version_id text NOT NULL REFERENCES smarthub.project_versions(id) ON DELETE CASCADE,
      asset_id text NOT NULL REFERENCES smarthub.knowledge_assets(id),
      asset_version_id text NOT NULL REFERENCES smarthub.asset_versions(id),
      created_at timestamptz NOT NULL,
      data jsonb NOT NULL,
      UNIQUE (project_version_id, asset_id)
    );
    CREATE INDEX IF NOT EXISTS project_versions_project_created_idx ON smarthub.project_versions (project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS project_version_bindings_version_idx ON smarthub.project_version_requirement_bindings (project_version_id, created_at);
  `,
}, {
  version: 6,
  name: 'requirement-review-runs',
  sql: `
    CREATE TABLE IF NOT EXISTS smarthub.review_runs (
      id text PRIMARY KEY,
      project_version_id text NOT NULL REFERENCES smarthub.project_versions(id),
      asset_id text NOT NULL REFERENCES smarthub.knowledge_assets(id),
      asset_version_id text NOT NULL REFERENCES smarthub.asset_versions(id),
      status text NOT NULL,
      created_at timestamptz NOT NULL,
      finished_at timestamptz,
      data jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS review_runs_project_version_created_idx ON smarthub.review_runs (project_version_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS review_runs_asset_created_idx ON smarthub.review_runs (project_version_id, asset_id, created_at DESC);
  `,
}]

export async function runMigrations(connectionString: string) {
  const pool = new Pool({ connectionString })
  try {
    const client = await pool.connect()
    try {
      await client.query("SELECT pg_advisory_lock(hashtext('smarthub_schema_migrations'))")
      await client.query('BEGIN')
      await client.query('CREATE SCHEMA IF NOT EXISTS smarthub')
      await client.query('CREATE TABLE IF NOT EXISTS smarthub.schema_migrations (version integer PRIMARY KEY, name text NOT NULL, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())')
      await client.query('COMMIT')
      for (const migration of migrations) {
        const applied = await client.query<{ checksum: string }>('SELECT checksum FROM smarthub.schema_migrations WHERE version=$1', [migration.version])
        const checksum = migrationChecksum(migration)
        if (applied.rows[0]) {
          if (applied.rows[0].checksum !== checksum) throw new Error(`数据库迁移 ${migration.version} 的 checksum 不匹配`)
          continue
        }
        if (migration.transactional === false) {
          try {
            for (const statement of migration.statements ?? [migration.sql]) await client.query(statement)
            await client.query('BEGIN')
            await client.query('INSERT INTO smarthub.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [migration.version, migration.name, checksum])
            await client.query('COMMIT')
          } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined)
            throw error
          }
          continue
        }
        await client.query('BEGIN')
        try {
          await client.query(migration.sql)
          await client.query('INSERT INTO smarthub.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [migration.version, migration.name, checksum])
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      }
      await verifyMigrations(client)
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('smarthub_schema_migrations'))").catch(() => undefined)
      client.release()
    }
  } finally {
    await pool.end()
  }
}

export async function verifyMigrations(client: Queryable) {
  const table = await client.query<{ exists: boolean }>("SELECT to_regclass('smarthub.schema_migrations') IS NOT NULL AS exists")
  if (!table.rows[0]?.exists) throw new Error('数据库 schema 未迁移，请先执行 npm run migrate')
  const applied = await client.query<{ version: number; checksum: string }>('SELECT version, checksum FROM smarthub.schema_migrations ORDER BY version')
  const knownVersions = new Set(migrations.map(migration => migration.version))
  if (applied.rows.some(row => !knownVersions.has(row.version))) throw new Error('数据库包含当前程序无法识别的迁移版本')
  const recorded = new Map(applied.rows.map(row => [row.version, row.checksum]))
  for (const migration of migrations) {
    const checksum = recorded.get(migration.version)
    if (!checksum) throw new Error(`数据库缺少迁移 ${migration.version}，请先执行 npm run migrate`)
    if (checksum !== migrationChecksum(migration)) throw new Error(`数据库迁移 ${migration.version} 的 checksum 不匹配`)
  }
}

function migrationChecksum(migration: Migration) {
  return createHash('sha256').update(migration.sql).digest('hex')
}
