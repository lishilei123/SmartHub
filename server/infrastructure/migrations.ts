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
}, {
  version: 7,
  name: 'agent-configuration-drafts-and-versions',
  sql: `
    CREATE TABLE IF NOT EXISTS smarthub.agent_configuration_drafts (
      scene text PRIMARY KEY,
      revision integer NOT NULL,
      updated_at timestamptz NOT NULL,
      data jsonb NOT NULL
    );
    CREATE TABLE IF NOT EXISTS smarthub.agent_configuration_versions (
      id text PRIMARY KEY,
      scene text NOT NULL,
      version integer NOT NULL,
      status text NOT NULL,
      created_at timestamptz NOT NULL,
      data jsonb NOT NULL,
      UNIQUE (scene, version)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS agent_configuration_one_active_idx ON smarthub.agent_configuration_versions (scene) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS agent_configuration_versions_scene_idx ON smarthub.agent_configuration_versions (scene, version DESC);
  `,
}, {
  version: 8,
  name: 'independent-agent-configuration-versions',
  sql: `
    UPDATE smarthub.agent_configuration_drafts
    SET data = jsonb_build_object(
      'scene', data->'scene',
      'agents', jsonb_build_object(
        'requirementPointExtraction', jsonb_build_object(
          'revision', data->'revision',
          'routing', data->'routing',
          'definition', data->'agents'->'requirementPointExtraction',
          'updatedAt', data->'updatedAt'
        ),
        'requirementReview', jsonb_build_object(
          'revision', data->'revision',
          'routing', data->'routing',
          'definition', data->'agents'->'requirementReview',
          'updatedAt', data->'updatedAt'
        )
      )
    )
    WHERE data ? 'routing';

    ALTER TABLE smarthub.agent_configuration_versions ADD COLUMN IF NOT EXISTS agent_key text;
    DROP INDEX IF EXISTS smarthub.agent_configuration_one_active_idx;
    ALTER TABLE smarthub.agent_configuration_versions DROP CONSTRAINT IF EXISTS agent_configuration_versions_scene_version_key;

    CREATE TEMP TABLE legacy_agent_configuration_versions ON COMMIT DROP AS
      SELECT * FROM smarthub.agent_configuration_versions WHERE agent_key IS NULL;
    DELETE FROM smarthub.agent_configuration_versions WHERE agent_key IS NULL;

    INSERT INTO smarthub.agent_configuration_versions (id, scene, agent_key, version, status, created_at, data)
    SELECT
      id,
      scene,
      'requirementPointExtraction',
      version,
      status,
      created_at,
      (data - 'agentDefinitions') || jsonb_build_object(
        'agentKey', 'requirementPointExtraction',
        'agentDefinition', data->'agentDefinitions'->'requirementPointExtraction'
      )
    FROM legacy_agent_configuration_versions;

    INSERT INTO smarthub.agent_configuration_versions (id, scene, agent_key, version, status, created_at, data)
    SELECT
      id || ':requirementReview',
      scene,
      'requirementReview',
      version,
      status,
      created_at,
      (data - 'agentDefinitions') || jsonb_build_object(
        'id', id || ':requirementReview',
        'agentKey', 'requirementReview',
        'agentDefinition', data->'agentDefinitions'->'requirementReview'
      )
    FROM legacy_agent_configuration_versions;

    ALTER TABLE smarthub.agent_configuration_versions ALTER COLUMN agent_key SET NOT NULL;
    ALTER TABLE smarthub.agent_configuration_versions ADD CONSTRAINT agent_configuration_versions_scene_agent_version_key UNIQUE (scene, agent_key, version);
    CREATE UNIQUE INDEX agent_configuration_one_active_idx ON smarthub.agent_configuration_versions (scene, agent_key) WHERE status = 'active';
    CREATE INDEX agent_configuration_versions_scene_agent_idx ON smarthub.agent_configuration_versions (scene, agent_key, version DESC);
  `,
}, {
  version: 9,
  name: 'ai-resource-catalog',
  sql: `
    CREATE TABLE IF NOT EXISTS smarthub.ai_resources (
      id text PRIMARY KEY,
      kind text NOT NULL,
      resource_key text NOT NULL,
      enabled boolean NOT NULL,
      built_in boolean NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      data jsonb NOT NULL,
      UNIQUE (kind, resource_key)
    );
    CREATE INDEX IF NOT EXISTS ai_resources_kind_enabled_idx ON smarthub.ai_resources (kind, enabled, resource_key);
  `,
}, {
  version: 10,
  name: 'phase2-review-governance',
  sql: `
    CREATE TABLE IF NOT EXISTS smarthub.finding_actions (
      id text PRIMARY KEY,
      project_version_id text NOT NULL REFERENCES smarthub.project_versions(id) ON DELETE CASCADE,
      run_id text NOT NULL REFERENCES smarthub.review_runs(id) ON DELETE CASCADE,
      finding_id text NOT NULL,
      version integer NOT NULL,
      created_at timestamptz NOT NULL,
      data jsonb NOT NULL,
      UNIQUE (run_id, finding_id, version)
    );
    CREATE INDEX IF NOT EXISTS finding_actions_run_idx ON smarthub.finding_actions (run_id, finding_id, version);

    CREATE TABLE IF NOT EXISTS smarthub.review_qa_sessions (
      id text PRIMARY KEY,
      project_version_id text NOT NULL REFERENCES smarthub.project_versions(id) ON DELETE CASCADE,
      run_id text NOT NULL UNIQUE REFERENCES smarthub.review_runs(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL,
      data jsonb NOT NULL
    );
    CREATE TABLE IF NOT EXISTS smarthub.review_qa_turns (
      id text PRIMARY KEY,
      session_id text NOT NULL REFERENCES smarthub.review_qa_sessions(id) ON DELETE CASCADE,
      project_version_id text NOT NULL REFERENCES smarthub.project_versions(id) ON DELETE CASCADE,
      run_id text NOT NULL REFERENCES smarthub.review_runs(id) ON DELETE CASCADE,
      status text NOT NULL,
      created_at timestamptz NOT NULL,
      finished_at timestamptz NOT NULL,
      data jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS review_qa_turns_run_idx ON smarthub.review_qa_turns (run_id, created_at, id);

    CREATE TABLE IF NOT EXISTS smarthub.tool_approvals (
      id text PRIMARY KEY,
      project_version_id text NOT NULL REFERENCES smarthub.project_versions(id) ON DELETE CASCADE,
      run_id text NOT NULL REFERENCES smarthub.review_runs(id) ON DELETE CASCADE,
      tool_id text NOT NULL,
      parameter_hash char(64) NOT NULL,
      status text NOT NULL,
      requested_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      data jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tool_approvals_run_idx ON smarthub.tool_approvals (run_id, status, requested_at DESC);
    CREATE INDEX IF NOT EXISTS tool_approvals_exact_idx ON smarthub.tool_approvals (run_id, tool_id, parameter_hash, status);
  `,
}, {
  version: 11,
  name: 'review-job-worker-queue',
  sql: `
    CREATE TABLE IF NOT EXISTS smarthub.review_jobs (
      id text PRIMARY KEY,
      run_id text NOT NULL UNIQUE REFERENCES smarthub.review_runs(id) ON DELETE CASCADE,
      project_version_id text NOT NULL REFERENCES smarthub.project_versions(id) ON DELETE CASCADE,
      status text NOT NULL,
      attempt_count integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 3,
      available_at timestamptz NOT NULL DEFAULT now(),
      lease_owner text,
      run_token uuid,
      lease_expires_at timestamptz,
      heartbeat_at timestamptz,
      cancel_requested_at timestamptz,
      started_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      error text,
      data jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS review_jobs_claim_idx ON smarthub.review_jobs (available_at, created_at) WHERE status = 'queued';
    CREATE INDEX IF NOT EXISTS review_jobs_lease_idx ON smarthub.review_jobs (lease_expires_at) WHERE status = 'running';
  `,
}, {
  version: 12,
  name: 'normalize-finding-severity-contract',
  sql: `
    UPDATE smarthub.review_runs run
    SET data = jsonb_set(
      run.data,
      '{result,findings}',
      COALESCE((
        SELECT jsonb_agg(
          CASE finding->>'severity'
            WHEN 'critical' THEN jsonb_set(finding, '{severity}', to_jsonb('blocker'::text))
            WHEN 'info' THEN jsonb_set(finding, '{severity}', to_jsonb('low'::text))
            ELSE finding
          END
          ORDER BY ordinal
        )
        FROM jsonb_array_elements(run.data->'result'->'findings') WITH ORDINALITY AS items(finding, ordinal)
      ), '[]'::jsonb),
      false
    )
    WHERE jsonb_typeof(run.data->'result'->'findings') = 'array'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(run.data->'result'->'findings') finding WHERE finding->>'severity' IN ('critical', 'info'));
  `,
}, {
  version: 13,
  name: 'phase3-technical-solution-review',
  sql: `
    CREATE TABLE IF NOT EXISTS smarthub.technical_solution_reviews (
      id text PRIMARY KEY,
      project_version_id text NOT NULL REFERENCES smarthub.project_versions(id) ON DELETE CASCADE,
      source_review_run_id text NOT NULL REFERENCES smarthub.review_runs(id) ON DELETE RESTRICT,
      name text NOT NULL,
      input_set_sha256 char(64) NOT NULL,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL,
      data jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS technical_solution_reviews_version_idx ON smarthub.technical_solution_reviews (project_version_id, created_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS smarthub.technical_solution_review_inputs (
      technical_review_id text NOT NULL REFERENCES smarthub.technical_solution_reviews(id) ON DELETE CASCADE,
      project_version_id text NOT NULL REFERENCES smarthub.project_versions(id) ON DELETE CASCADE,
      asset_version_id text NOT NULL REFERENCES smarthub.asset_versions(id) ON DELETE RESTRICT,
      ordinal integer NOT NULL,
      PRIMARY KEY (technical_review_id, asset_version_id),
      UNIQUE (technical_review_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS smarthub.technical_solution_review_runs (
      id text PRIMARY KEY,
      technical_review_id text NOT NULL REFERENCES smarthub.technical_solution_reviews(id) ON DELETE CASCADE,
      project_version_id text NOT NULL REFERENCES smarthub.project_versions(id) ON DELETE CASCADE,
      source_review_run_id text NOT NULL REFERENCES smarthub.review_runs(id) ON DELETE RESTRICT,
      status text NOT NULL,
      step text NOT NULL,
      progress integer NOT NULL CHECK (progress BETWEEN 0 AND 100),
      snapshot_sha256 char(64) NOT NULL,
      created_at timestamptz NOT NULL,
      started_at timestamptz,
      finished_at timestamptz,
      error_code text,
      error_summary text,
      data jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS technical_solution_runs_review_idx ON smarthub.technical_solution_review_runs (technical_review_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS technical_solution_runs_version_idx ON smarthub.technical_solution_review_runs (project_version_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS technical_solution_runs_active_idx ON smarthub.technical_solution_review_runs (status, created_at) WHERE status IN ('queued', 'running');
    CREATE TABLE IF NOT EXISTS smarthub.technical_solution_review_jobs (
      id text PRIMARY KEY,
      run_id text NOT NULL UNIQUE REFERENCES smarthub.technical_solution_review_runs(id) ON DELETE CASCADE,
      technical_review_id text NOT NULL REFERENCES smarthub.technical_solution_reviews(id) ON DELETE CASCADE,
      project_version_id text NOT NULL REFERENCES smarthub.project_versions(id) ON DELETE CASCADE,
      status text NOT NULL,
      attempt_count integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 3,
      available_at timestamptz NOT NULL DEFAULT now(),
      lease_owner text,
      run_token uuid,
      lease_expires_at timestamptz,
      heartbeat_at timestamptz,
      cancel_requested_at timestamptz,
      started_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      error text,
      data jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS technical_solution_jobs_claim_idx ON smarthub.technical_solution_review_jobs (available_at, created_at) WHERE status='queued';
    CREATE INDEX IF NOT EXISTS technical_solution_jobs_lease_idx ON smarthub.technical_solution_review_jobs (lease_expires_at) WHERE status='running';
    CREATE TABLE IF NOT EXISTS smarthub.technical_solution_finding_actions (
      id text PRIMARY KEY,
      project_version_id text NOT NULL REFERENCES smarthub.project_versions(id) ON DELETE CASCADE,
      technical_review_id text NOT NULL REFERENCES smarthub.technical_solution_reviews(id) ON DELETE CASCADE,
      run_id text NOT NULL REFERENCES smarthub.technical_solution_review_runs(id) ON DELETE CASCADE,
      finding_id text NOT NULL,
      version integer NOT NULL,
      created_at timestamptz NOT NULL,
      data jsonb NOT NULL,
      UNIQUE (run_id, finding_id, version)
    );
    CREATE INDEX IF NOT EXISTS technical_solution_actions_run_idx ON smarthub.technical_solution_finding_actions (run_id, finding_id, version);
  `,
}, {
  version: 14,
  name: 'phase3-technical-solution-formal-results',
  sql: `
    CREATE TABLE IF NOT EXISTS smarthub.technical_solution_review_results (
      run_id text PRIMARY KEY REFERENCES smarthub.technical_solution_review_runs(id) ON DELETE CASCADE,
      schema_version text NOT NULL,
      candidate_sha256 char(64) NOT NULL,
      published_at timestamptz NOT NULL,
      data jsonb NOT NULL
    );
    CREATE TABLE IF NOT EXISTS smarthub.technical_solution_coverage (
      id text PRIMARY KEY,
      run_id text NOT NULL REFERENCES smarthub.technical_solution_review_runs(id) ON DELETE CASCADE,
      requirement_point_id text NOT NULL,
      status text NOT NULL,
      ordinal integer NOT NULL,
      data jsonb NOT NULL,
      UNIQUE (run_id, requirement_point_id),
      UNIQUE (run_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS smarthub.technical_solution_findings (
      id text PRIMARY KEY,
      run_id text NOT NULL REFERENCES smarthub.technical_solution_review_runs(id) ON DELETE CASCADE,
      finding_type text NOT NULL,
      severity text NOT NULL,
      confidence double precision NOT NULL,
      ordinal integer NOT NULL,
      data jsonb NOT NULL,
      UNIQUE (run_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS smarthub.technical_solution_evidence (
      id text PRIMARY KEY,
      run_id text NOT NULL REFERENCES smarthub.technical_solution_review_runs(id) ON DELETE CASCADE,
      source_kind text NOT NULL,
      asset_id text NOT NULL,
      asset_version_id text NOT NULL,
      chunk_id text NOT NULL,
      content_sha256 char(64) NOT NULL,
      start_line integer NOT NULL,
      end_line integer NOT NULL,
      data jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS technical_solution_evidence_run_idx ON smarthub.technical_solution_evidence (run_id, asset_version_id, chunk_id);
    CREATE TABLE IF NOT EXISTS smarthub.technical_solution_coverage_evidence (
      coverage_id text NOT NULL REFERENCES smarthub.technical_solution_coverage(id) ON DELETE CASCADE,
      evidence_id text NOT NULL REFERENCES smarthub.technical_solution_evidence(id) ON DELETE CASCADE,
      PRIMARY KEY (coverage_id, evidence_id)
    );
    CREATE TABLE IF NOT EXISTS smarthub.technical_solution_finding_requirements (
      finding_id text NOT NULL REFERENCES smarthub.technical_solution_findings(id) ON DELETE CASCADE,
      requirement_point_id text NOT NULL,
      PRIMARY KEY (finding_id, requirement_point_id)
    );
    CREATE TABLE IF NOT EXISTS smarthub.technical_solution_finding_evidence (
      finding_id text NOT NULL REFERENCES smarthub.technical_solution_findings(id) ON DELETE CASCADE,
      evidence_id text NOT NULL REFERENCES smarthub.technical_solution_evidence(id) ON DELETE CASCADE,
      PRIMARY KEY (finding_id, evidence_id)
    );
  `,
}, {
  version: 15,
  name: 'phase4-workflow-runtime',
  sql: `
    CREATE TABLE IF NOT EXISTS smarthub.workflow_runs (
      id text PRIMARY KEY, project_version_id text NOT NULL REFERENCES smarthub.project_versions(id) ON DELETE CASCADE,
      domain_type text NOT NULL, domain_id text NOT NULL, definition_key text NOT NULL, definition_version text NOT NULL,
      status text NOT NULL CHECK (status IN ('queued','running','waiting_gate','succeeded','failed','cancelled')),
      stage text NOT NULL, progress integer NOT NULL CHECK (progress BETWEEN 0 AND 100), idempotency_key text NOT NULL,
      input_sha256 char(64) NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL, started_at timestamptz,
      finished_at timestamptz, error_code text, error_summary text, data jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workflow_runs_domain_idx ON smarthub.workflow_runs (project_version_id, domain_type, domain_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_active_idempotency_idx ON smarthub.workflow_runs (domain_id, idempotency_key) WHERE status IN ('queued','running','waiting_gate');
    CREATE TABLE IF NOT EXISTS smarthub.workflow_node_runs (
      id text PRIMARY KEY, workflow_run_id text NOT NULL REFERENCES smarthub.workflow_runs(id) ON DELETE CASCADE,
      node_key text NOT NULL, node_kind text NOT NULL, generation integer NOT NULL, attempt integer NOT NULL, status text NOT NULL,
      started_at timestamptz, finished_at timestamptz, error_code text, error_summary text, data jsonb NOT NULL,
      UNIQUE (workflow_run_id, node_key, generation, attempt)
    );
    CREATE TABLE IF NOT EXISTS smarthub.workflow_task_jobs (
      id text PRIMARY KEY, node_run_id text NOT NULL UNIQUE REFERENCES smarthub.workflow_node_runs(id) ON DELETE CASCADE,
      status text NOT NULL, available_at timestamptz NOT NULL, attempt_count integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 3,
      lease_owner text, run_token uuid, fencing_token bigint NOT NULL DEFAULT 0, lease_expires_at timestamptz, cancel_requested_at timestamptz,
      created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, error text, data jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workflow_jobs_claim_idx ON smarthub.workflow_task_jobs (available_at, created_at) WHERE status='queued';
    CREATE INDEX IF NOT EXISTS workflow_jobs_lease_idx ON smarthub.workflow_task_jobs (lease_expires_at) WHERE status='running';
    CREATE TABLE IF NOT EXISTS smarthub.workflow_handoff_artifacts (
      id text PRIMARY KEY, workflow_run_id text NOT NULL REFERENCES smarthub.workflow_runs(id) ON DELETE CASCADE,
      node_run_id text REFERENCES smarthub.workflow_node_runs(id) ON DELETE CASCADE, artifact_type text NOT NULL, schema_version text NOT NULL,
      content_sha256 char(64) NOT NULL, validation_status text NOT NULL, created_at timestamptz NOT NULL, content jsonb NOT NULL,
      UNIQUE (node_run_id, artifact_type, content_sha256)
    );
    CREATE TABLE IF NOT EXISTS smarthub.workflow_gate_decisions (
      id text PRIMARY KEY, workflow_run_id text NOT NULL REFERENCES smarthub.workflow_runs(id) ON DELETE CASCADE, gate_key text NOT NULL,
      target_artifact_id text, target_revision integer NOT NULL, decision text NOT NULL, actor_id text NOT NULL, expected_version integer NOT NULL,
      created_at timestamptz NOT NULL, data jsonb NOT NULL, UNIQUE (workflow_run_id, gate_key, expected_version)
    );
  `,
}, {
  version: 16,
  name: 'phase4-test-design-snapshots',
  sql: `
    CREATE TABLE IF NOT EXISTS smarthub.test_design_state (
      singleton_id text PRIMARY KEY CHECK (singleton_id='current'), updated_at timestamptz NOT NULL, data jsonb NOT NULL
    );
    CREATE TABLE IF NOT EXISTS smarthub.test_designs (
      id text PRIMARY KEY, project_version_id text NOT NULL REFERENCES smarthub.project_versions(id) ON DELETE CASCADE,
      project_id text NOT NULL REFERENCES smarthub.projects(id) ON DELETE CASCADE, name text NOT NULL, objective text NOT NULL,
      basis_mode text NOT NULL CHECK (basis_mode IN ('review_baseline','knowledge_assets')), logical_input_sha256 char(64) NOT NULL,
      created_by text NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS test_designs_version_idx ON smarthub.test_designs (project_version_id, created_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS smarthub.frozen_contents (
      content_sha256 char(64) PRIMARY KEY, media_type text NOT NULL, byte_length bigint NOT NULL, content text NOT NULL, created_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS smarthub.frozen_content_refs (
      owner_type text NOT NULL, owner_id text NOT NULL, role text NOT NULL, ordinal integer NOT NULL,
      content_sha256 char(64) NOT NULL REFERENCES smarthub.frozen_contents(content_sha256) ON DELETE RESTRICT, locator jsonb NOT NULL,
      PRIMARY KEY (owner_type, owner_id, role, ordinal)
    );
    CREATE TABLE IF NOT EXISTS smarthub.test_design_basis_snapshots (
      id text PRIMARY KEY, test_design_id text NOT NULL REFERENCES smarthub.test_designs(id) ON DELETE CASCADE, workflow_run_id text NOT NULL,
      basis_mode text NOT NULL, snapshot_sha256 char(64) NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL
    );
    CREATE TABLE IF NOT EXISTS smarthub.test_design_retrieval_snapshots (
      id text PRIMARY KEY, workflow_run_id text NOT NULL, mode text NOT NULL, snapshot_sha256 char(64) NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL
    );
    CREATE TABLE IF NOT EXISTS smarthub.test_design_historical_case_snapshots (
      id text PRIMARY KEY, workflow_run_id text NOT NULL, snapshot_sha256 char(64) NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL
    );
    CREATE TABLE IF NOT EXISTS smarthub.test_design_snapshot_items (
      id text PRIMARY KEY, workflow_run_id text NOT NULL, snapshot_kind text NOT NULL, source_kind text NOT NULL, source_id text NOT NULL,
      content_sha256 char(64) NOT NULL, ordinal integer NOT NULL, data jsonb NOT NULL, UNIQUE (workflow_run_id, snapshot_kind, ordinal)
    );
  `,
}, {
  version: 17,
  name: 'phase4-tree-cases-data',
  sql: `
    CREATE TABLE IF NOT EXISTS smarthub.test_point_trees (id text PRIMARY KEY, workflow_run_id text NOT NULL, current_revision integer NOT NULL, data jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS smarthub.test_point_nodes (id text PRIMARY KEY, tree_id text NOT NULL REFERENCES smarthub.test_point_trees(id) ON DELETE CASCADE, created_at timestamptz NOT NULL, data jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS smarthub.test_point_tree_revisions (id text PRIMARY KEY, tree_id text NOT NULL REFERENCES smarthub.test_point_trees(id) ON DELETE CASCADE, revision integer NOT NULL, parent_revision integer, tree_sha256 char(64) NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL, UNIQUE (tree_id, revision));
    CREATE TABLE IF NOT EXISTS smarthub.test_point_node_revisions (tree_revision_id text NOT NULL REFERENCES smarthub.test_point_tree_revisions(id) ON DELETE CASCADE, node_id text NOT NULL REFERENCES smarthub.test_point_nodes(id) ON DELETE CASCADE, parent_id text, sort_key text NOT NULL, data jsonb NOT NULL, PRIMARY KEY (tree_revision_id, node_id));
    CREATE INDEX IF NOT EXISTS test_point_node_revision_order_idx ON smarthub.test_point_node_revisions (tree_revision_id, parent_id, sort_key);
    CREATE TABLE IF NOT EXISTS smarthub.test_point_tree_versions (id text PRIMARY KEY, tree_id text NOT NULL REFERENCES smarthub.test_point_trees(id) ON DELETE CASCADE, version integer NOT NULL, revision integer NOT NULL, tree_sha256 char(64) NOT NULL, approved_by text NOT NULL, approved_at timestamptz NOT NULL, data jsonb NOT NULL, UNIQUE (tree_id, version));
    CREATE TABLE IF NOT EXISTS smarthub.test_cases (id text PRIMARY KEY, workflow_run_id text NOT NULL, tree_version_id text NOT NULL, current_revision integer NOT NULL, lifecycle_status text NOT NULL, data jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS smarthub.test_case_revisions (id text PRIMARY KEY, case_id text NOT NULL REFERENCES smarthub.test_cases(id) ON DELETE CASCADE, revision integer NOT NULL, content_sha256 char(64) NOT NULL, semantic_sha256 char(64) NOT NULL, created_at timestamptz NOT NULL, content jsonb NOT NULL, data jsonb NOT NULL, UNIQUE (case_id, revision));
    CREATE TABLE IF NOT EXISTS smarthub.test_case_review_actions (id text PRIMARY KEY, case_id text NOT NULL REFERENCES smarthub.test_cases(id) ON DELETE CASCADE, target_revision integer NOT NULL, decision text NOT NULL, actor_id text NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS smarthub.test_case_reuse_relations (id text PRIMARY KEY, case_id text NOT NULL REFERENCES smarthub.test_cases(id) ON DELETE CASCADE, source_type text NOT NULL, source_id text NOT NULL, mode text NOT NULL, source_sha256 char(64) NOT NULL, current_sha256 char(64) NOT NULL, data jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS smarthub.test_case_dependencies (case_id text NOT NULL REFERENCES smarthub.test_cases(id) ON DELETE CASCADE, target_case_id text NOT NULL REFERENCES smarthub.test_cases(id) ON DELETE RESTRICT, revision integer NOT NULL, PRIMARY KEY (case_id, target_case_id, revision));
    CREATE TABLE IF NOT EXISTS smarthub.test_data_requirement_sets (id text PRIMARY KEY, workflow_run_id text NOT NULL, current_version integer NOT NULL, data jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS smarthub.test_data_requirement_set_versions (id text PRIMARY KEY, set_id text NOT NULL REFERENCES smarthub.test_data_requirement_sets(id) ON DELETE CASCADE, version integer NOT NULL, content_sha256 char(64) NOT NULL, created_at timestamptz NOT NULL, content jsonb NOT NULL, UNIQUE (set_id, version));
    CREATE TABLE IF NOT EXISTS smarthub.test_data_requirements (id text PRIMARY KEY, set_version_id text NOT NULL REFERENCES smarthub.test_data_requirement_set_versions(id) ON DELETE CASCADE, readiness text NOT NULL, data jsonb NOT NULL);
  `,
}, {
  version: 18,
  name: 'phase4-audit-publication',
  sql: `
    CREATE TABLE IF NOT EXISTS smarthub.test_design_basis_relations (id text PRIMARY KEY, workflow_run_id text NOT NULL, subject_kind text NOT NULL, subject_id text NOT NULL, basis_type text NOT NULL, basis_ref text NOT NULL, data jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS smarthub.test_design_coverage_relations (id text PRIMARY KEY, audit_id text NOT NULL, target_type text NOT NULL, target_ref text NOT NULL, status text NOT NULL, data jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS smarthub.test_design_findings (id text PRIMARY KEY, workflow_run_id text NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS smarthub.test_design_confirmation_items (id text PRIMARY KEY, workflow_run_id text NOT NULL, impact_stage text NOT NULL, blocker boolean NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS smarthub.test_design_coverage_audits (id text PRIMARY KEY, workflow_run_id text NOT NULL, input_sha256 char(64) NOT NULL, case_set_sha256 char(64) NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL);
    CREATE INDEX IF NOT EXISTS test_design_audits_run_idx ON smarthub.test_design_coverage_audits (workflow_run_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS smarthub.test_case_set_versions (id text PRIMARY KEY, project_id text NOT NULL REFERENCES smarthub.projects(id) ON DELETE CASCADE, project_version_id text NOT NULL REFERENCES smarthub.project_versions(id) ON DELETE CASCADE, test_design_id text NOT NULL, version integer NOT NULL, content_sha256 char(64) NOT NULL, published_by text NOT NULL, published_at timestamptz NOT NULL, content jsonb NOT NULL, data jsonb NOT NULL, UNIQUE (test_design_id, version), UNIQUE (test_design_id, content_sha256));
    CREATE TABLE IF NOT EXISTS smarthub.test_case_set_members (version_id text NOT NULL REFERENCES smarthub.test_case_set_versions(id) ON DELETE CASCADE, case_id text NOT NULL, case_revision integer NOT NULL, ordinal integer NOT NULL, content_sha256 char(64) NOT NULL, PRIMARY KEY (version_id, case_id), UNIQUE (version_id, ordinal));
    CREATE TABLE IF NOT EXISTS smarthub.test_case_asset_publications (id text PRIMARY KEY, version_id text NOT NULL REFERENCES smarthub.test_case_set_versions(id) ON DELETE CASCADE, status text NOT NULL, content_sha256 char(64) NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL);
  `,
}, {
  version: 19,
  name: 'phase4-suites-handoffs',
  sql: `
    CREATE TABLE IF NOT EXISTS smarthub.test_suite_versions (id text PRIMARY KEY, project_id text NOT NULL REFERENCES smarthub.projects(id) ON DELETE CASCADE, suite_key text NOT NULL, suite_type text NOT NULL, version integer NOT NULL, content_sha256 char(64) NOT NULL, published_at timestamptz NOT NULL, content jsonb NOT NULL, data jsonb NOT NULL, UNIQUE (project_id, suite_key, version));
    CREATE TABLE IF NOT EXISTS smarthub.test_suite_version_members (suite_version_id text NOT NULL REFERENCES smarthub.test_suite_versions(id) ON DELETE CASCADE, test_case_set_version_id text NOT NULL, case_id text NOT NULL, case_revision integer NOT NULL, ordinal integer NOT NULL, execution_methods text[] NOT NULL CHECK (cardinality(execution_methods)>0), data jsonb NOT NULL, PRIMARY KEY (suite_version_id, case_id), UNIQUE (suite_version_id, ordinal));
    CREATE TABLE IF NOT EXISTS smarthub.test_case_smoke_candidates (test_case_set_version_id text NOT NULL REFERENCES smarthub.test_case_set_versions(id) ON DELETE CASCADE, case_id text NOT NULL, decision text NOT NULL, execution_methods text[] NOT NULL CHECK (cardinality(execution_methods)>0), updated_at timestamptz NOT NULL, data jsonb NOT NULL, PRIMARY KEY (test_case_set_version_id, case_id));
    CREATE TABLE IF NOT EXISTS smarthub.test_case_impacted_regression_refs (id text PRIMARY KEY, test_case_set_version_id text NOT NULL REFERENCES smarthub.test_case_set_versions(id) ON DELETE CASCADE, suite_version_id text NOT NULL REFERENCES smarthub.test_suite_versions(id) ON DELETE RESTRICT, case_id text NOT NULL, execution_methods text[] NOT NULL CHECK (cardinality(execution_methods)>0), created_at timestamptz NOT NULL, data jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS smarthub.test_execution_handoffs (id text PRIMARY KEY, project_version_id text NOT NULL REFERENCES smarthub.project_versions(id) ON DELETE CASCADE, test_case_set_version_id text NOT NULL REFERENCES smarthub.test_case_set_versions(id) ON DELETE RESTRICT, strategy text NOT NULL, content_sha256 char(64) NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL, content jsonb NOT NULL, data jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS smarthub.test_execution_handoff_members (handoff_id text NOT NULL REFERENCES smarthub.test_execution_handoffs(id) ON DELETE CASCADE, stage text NOT NULL, ordinal integer NOT NULL, source_version_id text NOT NULL, case_id text NOT NULL, case_revision integer NOT NULL, method text NOT NULL, dedup_key text NOT NULL, data jsonb NOT NULL, PRIMARY KEY (handoff_id, stage, ordinal), UNIQUE (handoff_id, dedup_key));
  `,
}, {
  version: 20,
  name: 'remove-review-qa-agent-and-history',
  sql: `
    DELETE FROM smarthub.agent_configuration_versions
    WHERE agent_key = 'reviewQa'
       OR data->>'agentKey' = 'reviewQa'
       OR data->'agentDefinition'->>'agentKey' = 'review-qa';
    UPDATE smarthub.agent_configuration_drafts
    SET data = jsonb_set(data, '{agents}', COALESCE(data->'agents', '{}'::jsonb) - 'reviewQa', true),
        updated_at = now()
    WHERE COALESCE(data->'agents', '{}'::jsonb) ? 'reviewQa';
    DELETE FROM smarthub.ai_resources WHERE resource_key = 'review.answer_submit';
    DROP TABLE IF EXISTS smarthub.review_qa_turns;
    DROP TABLE IF EXISTS smarthub.review_qa_sessions;
  `,
}, {
  version: 21,
  name: 'remove-legacy-requirement-agents-and-history',
  sql: `
    DELETE FROM smarthub.agent_configuration_versions
    WHERE agent_key IN ('requirementPointExtraction', 'requirementReview')
       OR data->>'agentKey' IN ('requirementPointExtraction', 'requirementReview')
       OR data->'agentDefinition'->>'agentKey' IN ('requirement-point-extraction', 'requirement-review')
       OR COALESCE(data->'agentDefinitions', '{}'::jsonb) ?| ARRAY['requirementPointExtraction', 'requirementReview'];
    UPDATE smarthub.agent_configuration_drafts
    SET data = jsonb_set(
          data,
          '{agents}',
          (COALESCE(data->'agents', '{}'::jsonb) - 'requirementPointExtraction') - 'requirementReview',
          true
        ),
        updated_at = now()
    WHERE COALESCE(data->'agents', '{}'::jsonb) ?| ARRAY['requirementPointExtraction', 'requirementReview'];
    DELETE FROM smarthub.ai_resources
    WHERE resource_key IN ('requirement-points.submit_result', 'review.submit_result');
  `,
}, {
  version: 22,
  name: 'replace-test-design-dag-with-single-agent',
  sql: `
    DELETE FROM smarthub.test_execution_handoffs;
    DELETE FROM smarthub.test_case_impacted_regression_refs;
    DELETE FROM smarthub.test_case_smoke_candidates;
    DELETE FROM smarthub.test_suite_version_members;
    DELETE FROM smarthub.test_suite_versions;
    DELETE FROM smarthub.test_case_asset_publications;
    DELETE FROM smarthub.test_case_set_members;
    DELETE FROM smarthub.test_case_set_versions;
    DELETE FROM smarthub.test_design_coverage_relations;
    DELETE FROM smarthub.test_design_coverage_audits;
    DELETE FROM smarthub.test_design_basis_relations;
    DELETE FROM smarthub.test_design_findings;
    DELETE FROM smarthub.test_design_confirmation_items;
    DELETE FROM smarthub.test_data_requirements;
    DELETE FROM smarthub.test_data_requirement_set_versions;
    DELETE FROM smarthub.test_data_requirement_sets;
    DELETE FROM smarthub.test_case_dependencies;
    DELETE FROM smarthub.test_case_review_actions;
    DELETE FROM smarthub.test_case_reuse_relations;
    DELETE FROM smarthub.test_case_revisions;
    DELETE FROM smarthub.test_cases;
    DELETE FROM smarthub.test_point_node_revisions;
    DELETE FROM smarthub.test_point_tree_versions;
    DELETE FROM smarthub.test_point_tree_revisions;
    DELETE FROM smarthub.test_point_nodes;
    DELETE FROM smarthub.test_point_trees;
    DELETE FROM smarthub.test_design_snapshot_items;
    DELETE FROM smarthub.test_design_basis_snapshots;
    DELETE FROM smarthub.test_design_retrieval_snapshots;
    DELETE FROM smarthub.test_design_historical_case_snapshots;
    DELETE FROM smarthub.frozen_content_refs
    WHERE owner_type = 'workflow_run'
      AND owner_id IN (SELECT id FROM smarthub.workflow_runs WHERE domain_type = 'test_design');
    DELETE FROM smarthub.workflow_runs WHERE domain_type = 'test_design';
    DELETE FROM smarthub.test_designs;
    DELETE FROM smarthub.test_design_state;

    ALTER TABLE smarthub.test_designs DROP CONSTRAINT IF EXISTS test_designs_basis_mode_check;
    ALTER TABLE smarthub.test_designs ALTER COLUMN basis_mode SET DEFAULT 'project_workspace';
    ALTER TABLE smarthub.test_designs ADD CONSTRAINT test_designs_basis_mode_check CHECK (basis_mode = 'project_workspace');

    DELETE FROM smarthub.agent_configuration_versions
    WHERE agent_key IN ('testAnalysis', 'functionalTestDesign', 'nonFunctionalTestDesign', 'testCaseSynthesis')
       OR data->>'agentKey' IN ('testAnalysis', 'functionalTestDesign', 'nonFunctionalTestDesign', 'testCaseSynthesis')
       OR data->'agentDefinition'->>'agentKey' IN ('test-analysis', 'functional-test-design', 'non-functional-test-design', 'test-case-synthesis');
    UPDATE smarthub.agent_configuration_drafts
    SET data = jsonb_set(
          data,
          '{agents}',
          (((COALESCE(data->'agents', '{}'::jsonb) - 'testAnalysis') - 'functionalTestDesign') - 'nonFunctionalTestDesign') - 'testCaseSynthesis',
          true
        ),
        updated_at = now()
    WHERE COALESCE(data->'agents', '{}'::jsonb) ?| ARRAY['testAnalysis', 'functionalTestDesign', 'nonFunctionalTestDesign', 'testCaseSynthesis'];
    DELETE FROM smarthub.ai_resources
    WHERE resource_key IN (
      'test_analysis.submit_result',
      'functional_test_design.submit_result',
      'non_functional_test_design.submit_result',
      'test_case_synthesis.submit_result'
    );
  `,
}, {
  version: 23,
  name: 'retire-technical-solution-review',
  sql: `
    DELETE FROM smarthub.agent_configuration_versions
    WHERE agent_key IN ('technicalSolutionExtraction', 'technicalSolutionReview', 'technicalSolutionAnalysis')
       OR data->>'agentKey' IN ('technicalSolutionExtraction', 'technicalSolutionReview', 'technicalSolutionAnalysis')
       OR data->'agentDefinition'->>'agentKey' IN ('technical-solution-extraction', 'technical-solution-review', 'technical-solution-analysis');
    UPDATE smarthub.agent_configuration_drafts
    SET data = jsonb_set(
          data,
          '{agents}',
          (((COALESCE(data->'agents', '{}'::jsonb) - 'technicalSolutionExtraction') - 'technicalSolutionReview') - 'technicalSolutionAnalysis'),
          true
        ),
        updated_at = now()
    WHERE COALESCE(data->'agents', '{}'::jsonb) ?| ARRAY['technicalSolutionExtraction', 'technicalSolutionReview', 'technicalSolutionAnalysis'];
    DELETE FROM smarthub.ai_resources
    WHERE resource_key IN (
      'technical_solution.input.read',
      'technical_solution.evidence.preview',
      'technical_solution_points.submit_result',
      'technical_solution_review.submit_result'
    );

    DROP TABLE IF EXISTS smarthub.technical_solution_coverage_evidence;
    DROP TABLE IF EXISTS smarthub.technical_solution_finding_evidence;
    DROP TABLE IF EXISTS smarthub.technical_solution_finding_requirements;
    DROP TABLE IF EXISTS smarthub.technical_solution_coverage;
    DROP TABLE IF EXISTS smarthub.technical_solution_findings;
    DROP TABLE IF EXISTS smarthub.technical_solution_evidence;
    DROP TABLE IF EXISTS smarthub.technical_solution_review_results;
    DROP TABLE IF EXISTS smarthub.technical_solution_finding_actions;
    DROP TABLE IF EXISTS smarthub.technical_solution_review_jobs;
    DROP TABLE IF EXISTS smarthub.technical_solution_review_inputs;
    DROP TABLE IF EXISTS smarthub.technical_solution_review_runs;
    DROP TABLE IF EXISTS smarthub.technical_solution_reviews;
  `,
}, {
  version: 24,
  name: 'project-test-case-library-and-handoffs',
  sql: `
    CREATE TABLE IF NOT EXISTS smarthub.library_test_cases (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES smarthub.projects(id) ON DELETE CASCADE,
      current_revision integer NOT NULL,
      status text NOT NULL CHECK (status IN ('active','deprecated')),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      data jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS library_test_cases_project_idx ON smarthub.library_test_cases (project_id, status, updated_at DESC, id);
    CREATE TABLE IF NOT EXISTS smarthub.library_test_case_revisions (
      case_id text NOT NULL REFERENCES smarthub.library_test_cases(id) ON DELETE RESTRICT,
      revision integer NOT NULL,
      content_sha256 char(64) NOT NULL,
      semantic_sha256 char(64) NOT NULL,
      source_run_id text,
      source_proposal_id text,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL,
      content jsonb NOT NULL,
      data jsonb NOT NULL,
      PRIMARY KEY (case_id, revision)
    );
    CREATE TABLE IF NOT EXISTS smarthub.case_change_proposals (
      id text PRIMARY KEY,
      workflow_run_id text NOT NULL,
      operation text NOT NULL CHECK (operation IN ('reuse','update','create','deprecate','reference')),
      source_case_id text,
      source_revision integer,
      decision text NOT NULL,
      created_at timestamptz NOT NULL,
      data jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS case_change_proposals_run_idx ON smarthub.case_change_proposals (workflow_run_id, operation, decision, id);
    CREATE TABLE IF NOT EXISTS smarthub.case_change_proposal_decisions (
      id text PRIMARY KEY,
      proposal_id text NOT NULL REFERENCES smarthub.case_change_proposals(id) ON DELETE RESTRICT,
      expected_version integer NOT NULL,
      decision text NOT NULL,
      decided_by text NOT NULL,
      decided_at timestamptz NOT NULL,
      data jsonb NOT NULL,
      UNIQUE (proposal_id, expected_version)
    );
    CREATE TABLE IF NOT EXISTS smarthub.test_case_library_versions (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES smarthub.projects(id) ON DELETE CASCADE,
      version integer NOT NULL,
      name text NOT NULL,
      source_run_id text,
      content_sha256 char(64) NOT NULL,
      published_by text NOT NULL,
      published_at timestamptz NOT NULL,
      data jsonb NOT NULL,
      UNIQUE (project_id, version),
      UNIQUE (project_id, content_sha256)
    );
    CREATE TABLE IF NOT EXISTS smarthub.test_case_library_version_members (
      version_id text NOT NULL REFERENCES smarthub.test_case_library_versions(id) ON DELETE RESTRICT,
      case_id text NOT NULL REFERENCES smarthub.library_test_cases(id) ON DELETE RESTRICT,
      case_revision integer NOT NULL,
      ordinal integer NOT NULL,
      content_sha256 char(64) NOT NULL,
      PRIMARY KEY (version_id, case_id),
      UNIQUE (version_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS smarthub.test_suite_drafts (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES smarthub.projects(id) ON DELETE CASCADE,
      suite_key text NOT NULL,
      suite_type text NOT NULL CHECK (suite_type IN ('smoke','regression','custom')),
      status text NOT NULL CHECK (status IN ('draft','published')),
      content_sha256 char(64) NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      data jsonb NOT NULL,
      UNIQUE (project_id, suite_key, id)
    );
    CREATE TABLE IF NOT EXISTS smarthub.test_suite_draft_members (
      draft_id text NOT NULL REFERENCES smarthub.test_suite_drafts(id) ON DELETE CASCADE,
      case_id text NOT NULL REFERENCES smarthub.library_test_cases(id) ON DELETE RESTRICT,
      case_revision integer NOT NULL,
      ordinal integer NOT NULL,
      execution_method text NOT NULL,
      data jsonb NOT NULL,
      PRIMARY KEY (draft_id, case_id),
      UNIQUE (draft_id, ordinal)
    );
    ALTER TABLE smarthub.test_suite_version_members ALTER COLUMN test_case_set_version_id DROP NOT NULL;
    ALTER TABLE smarthub.test_suite_version_members ALTER COLUMN execution_methods DROP NOT NULL;
    ALTER TABLE smarthub.test_suite_version_members ADD COLUMN IF NOT EXISTS test_case_library_version_id text REFERENCES smarthub.test_case_library_versions(id) ON DELETE RESTRICT;
    ALTER TABLE smarthub.test_suite_version_members ADD COLUMN IF NOT EXISTS execution_method text;
    ALTER TABLE smarthub.test_execution_handoffs ALTER COLUMN test_case_set_version_id DROP NOT NULL;
    ALTER TABLE smarthub.test_execution_handoffs ADD COLUMN IF NOT EXISTS test_case_library_version_id text REFERENCES smarthub.test_case_library_versions(id) ON DELETE RESTRICT;
    ALTER TABLE smarthub.test_execution_handoffs ADD COLUMN IF NOT EXISTS suite_version_id text REFERENCES smarthub.test_suite_versions(id) ON DELETE RESTRICT;
    ALTER TABLE smarthub.test_execution_handoffs ADD COLUMN IF NOT EXISTS execution_mode text;
  `,
}, {
  version: 25,
  name: 'test-case-library-traceability-baseline-and-legacy-migration',
  sql: `
    ALTER TABLE smarthub.library_test_case_revisions ADD COLUMN IF NOT EXISTS traceability jsonb;
    ALTER TABLE smarthub.workflow_runs ADD COLUMN IF NOT EXISTS base_test_case_library_version_id text REFERENCES smarthub.test_case_library_versions(id) ON DELETE RESTRICT;
    ALTER TABLE smarthub.workflow_runs ADD COLUMN IF NOT EXISTS base_test_case_library_version_sha256 char(64);

    ALTER TABLE smarthub.test_case_library_versions ADD COLUMN IF NOT EXISTS legacy_test_case_set_version_id text REFERENCES smarthub.test_case_set_versions(id) ON DELETE RESTRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS test_case_library_versions_legacy_source_uq
      ON smarthub.test_case_library_versions (legacy_test_case_set_version_id)
      WHERE legacy_test_case_set_version_id IS NOT NULL;

    ALTER TABLE smarthub.test_suite_drafts ADD COLUMN IF NOT EXISTS test_case_library_version_id text REFERENCES smarthub.test_case_library_versions(id) ON DELETE RESTRICT;
    ALTER TABLE smarthub.test_suite_drafts ADD COLUMN IF NOT EXISTS compatibility_status text;
    ALTER TABLE smarthub.test_suite_versions ADD COLUMN IF NOT EXISTS test_case_library_version_id text REFERENCES smarthub.test_case_library_versions(id) ON DELETE RESTRICT;
    ALTER TABLE smarthub.test_suite_versions ADD COLUMN IF NOT EXISTS compatibility_status text;
    CREATE INDEX IF NOT EXISTS test_suite_drafts_library_version_idx ON smarthub.test_suite_drafts (project_id, test_case_library_version_id, status);
    CREATE INDEX IF NOT EXISTS test_suite_versions_library_version_idx ON smarthub.test_suite_versions (project_id, test_case_library_version_id, published_at DESC);

    CREATE TABLE IF NOT EXISTS smarthub.library_test_case_revision_requirement_refs (
      case_id text NOT NULL,
      case_revision integer NOT NULL,
      requirement_release_id text NOT NULL,
      requirement_id text NOT NULL,
      PRIMARY KEY (case_id, case_revision, requirement_release_id, requirement_id),
      FOREIGN KEY (case_id, case_revision) REFERENCES smarthub.library_test_case_revisions(case_id, revision) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS library_case_requirement_refs_release_idx
      ON smarthub.library_test_case_revision_requirement_refs (requirement_release_id, requirement_id);
    CREATE TABLE IF NOT EXISTS smarthub.library_test_case_revision_test_point_refs (
      case_id text NOT NULL,
      case_revision integer NOT NULL,
      test_point_tree_version_id text NOT NULL,
      test_point_id text NOT NULL,
      PRIMARY KEY (case_id, case_revision, test_point_tree_version_id, test_point_id),
      FOREIGN KEY (case_id, case_revision) REFERENCES smarthub.library_test_case_revisions(case_id, revision) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS library_case_test_point_refs_version_idx
      ON smarthub.library_test_case_revision_test_point_refs (test_point_tree_version_id, test_point_id);

    CREATE TABLE IF NOT EXISTS smarthub.legacy_test_case_migrations (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES smarthub.projects(id) ON DELETE RESTRICT,
      legacy_test_case_set_version_id text NOT NULL REFERENCES smarthub.test_case_set_versions(id) ON DELETE RESTRICT,
      test_case_library_version_id text NOT NULL REFERENCES smarthub.test_case_library_versions(id) ON DELETE RESTRICT,
      preview_sha256 char(64) NOT NULL,
      migrated_by text NOT NULL,
      migrated_at timestamptz NOT NULL,
      data jsonb NOT NULL,
      UNIQUE (project_id, legacy_test_case_set_version_id)
    );
    CREATE TABLE IF NOT EXISTS smarthub.legacy_test_case_id_mappings (
      migration_id text NOT NULL REFERENCES smarthub.legacy_test_case_migrations(id) ON DELETE RESTRICT,
      project_id text NOT NULL REFERENCES smarthub.projects(id) ON DELETE RESTRICT,
      legacy_test_case_set_version_id text NOT NULL REFERENCES smarthub.test_case_set_versions(id) ON DELETE RESTRICT,
      legacy_case_id text NOT NULL,
      legacy_revision integer NOT NULL,
      library_case_id text NOT NULL,
      library_revision integer NOT NULL,
      resolution text NOT NULL,
      data jsonb NOT NULL,
      PRIMARY KEY (migration_id, legacy_case_id, legacy_revision),
      UNIQUE (project_id, legacy_test_case_set_version_id, legacy_case_id, legacy_revision),
      FOREIGN KEY (library_case_id, library_revision) REFERENCES smarthub.library_test_case_revisions(case_id, revision) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS legacy_test_case_id_mappings_case_idx ON smarthub.legacy_test_case_id_mappings (project_id, legacy_case_id);

    ALTER TABLE smarthub.test_execution_handoff_members ADD COLUMN IF NOT EXISTS dimension text;
    ALTER TABLE smarthub.test_execution_handoff_members ADD COLUMN IF NOT EXISTS execution_spec jsonb;
    ALTER TABLE smarthub.test_execution_handoff_members ADD COLUMN IF NOT EXISTS traceability jsonb;
    ALTER TABLE smarthub.test_execution_handoff_members ADD COLUMN IF NOT EXISTS content_sha256 char(64);

    DO $$ BEGIN
      ALTER TABLE smarthub.test_case_library_version_members
        ADD CONSTRAINT test_case_library_members_revision_fk
        FOREIGN KEY (case_id, case_revision) REFERENCES smarthub.library_test_case_revisions(case_id, revision) ON DELETE RESTRICT NOT VALID;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE smarthub.test_suite_draft_members
        ADD CONSTRAINT test_suite_draft_members_revision_fk
        FOREIGN KEY (case_id, case_revision) REFERENCES smarthub.library_test_case_revisions(case_id, revision) ON DELETE RESTRICT NOT VALID;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `,
}, {
  version: 26,
  name: 'freeze-library-member-execution-readiness-and-handoff-overrides',
  sql: `
    ALTER TABLE smarthub.test_case_library_version_members ADD COLUMN IF NOT EXISTS frozen_content jsonb;
    ALTER TABLE smarthub.test_case_library_version_members ADD COLUMN IF NOT EXISTS traceability jsonb;
    ALTER TABLE smarthub.test_case_library_version_members ADD COLUMN IF NOT EXISTS execution_readiness text;
    ALTER TABLE smarthub.test_execution_handoff_members ADD COLUMN IF NOT EXISTS readiness_override jsonb;

    UPDATE smarthub.test_case_library_version_members member
      SET frozen_content = COALESCE(member.frozen_content, revision.content),
          traceability = COALESCE(member.traceability, revision.traceability),
          execution_readiness = COALESCE(member.execution_readiness, revision.content #>> '{executionSpec,executionReadiness}')
      FROM smarthub.library_test_case_revisions revision
      WHERE revision.case_id = member.case_id AND revision.revision = member.case_revision;

    DO $$ BEGIN
      ALTER TABLE smarthub.test_case_library_version_members
        ADD CONSTRAINT test_case_library_member_execution_readiness_ck
        CHECK (execution_readiness IS NULL OR execution_readiness IN ('ready','needs_confirmation','blocked'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE smarthub.test_execution_handoff_members
        ADD CONSTRAINT test_execution_handoff_readiness_override_ck
        CHECK (readiness_override IS NULL OR (
          jsonb_typeof(readiness_override) = 'object'
          AND readiness_override ?& ARRAY['reason','actorId','createdAt']
          AND jsonb_typeof(readiness_override->'reason') = 'string'
          AND jsonb_typeof(readiness_override->'actorId') = 'string'
          AND jsonb_typeof(readiness_override->'createdAt') = 'string'
          AND length(trim(readiness_override->>'reason')) > 0
          AND length(trim(readiness_override->>'actorId')) > 0
          AND length(trim(readiness_override->>'createdAt')) > 0
        ));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
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
