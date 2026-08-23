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
}, {
  version: 27,
  name: 'test-execution-runs-tasks-and-worker-queue',
  sql: `
    INSERT INTO smarthub.agent_configuration_drafts (scene, revision, updated_at, data)
    SELECT
      'test_design',
      revision,
      updated_at,
      jsonb_build_object(
        'scene', 'test_design',
        'agents', jsonb_build_object('testDesign', data->'agents'->'testDesign')
      )
    FROM smarthub.agent_configuration_drafts
    WHERE scene = 'requirement_analysis'
      AND COALESCE(data->'agents', '{}'::jsonb) ? 'testDesign'
    ON CONFLICT (scene) DO NOTHING;

    INSERT INTO smarthub.agent_configuration_drafts (scene, revision, updated_at, data)
    SELECT
      'test_execution',
      revision,
      updated_at,
      jsonb_build_object(
        'scene', 'test_execution',
        'agents', jsonb_build_object(
          'testScript', data->'agents'->'testScript',
          'failureAnalysis', data->'agents'->'failureAnalysis',
          'scriptRepair', data->'agents'->'scriptRepair'
        )
      )
    FROM smarthub.agent_configuration_drafts
    WHERE scene = 'requirement_analysis'
      AND COALESCE(data->'agents', '{}'::jsonb) ?| ARRAY['testScript','failureAnalysis','scriptRepair']
    ON CONFLICT (scene) DO NOTHING;

    UPDATE smarthub.agent_configuration_drafts
    SET data = jsonb_build_object(
          'scene', 'requirement_analysis',
          'agents', jsonb_build_object(
            'requirementAnalysis', data->'agents'->'requirementAnalysis'
          )
        ),
        updated_at = now()
    WHERE scene = 'requirement_analysis'
      AND COALESCE(data->'agents', '{}'::jsonb) ?| ARRAY['testDesign','testScript','failureAnalysis','scriptRepair'];

    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS smarthub.test_execution_runs (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES smarthub.projects(id) ON DELETE RESTRICT,
      project_version_id text NOT NULL REFERENCES smarthub.project_versions(id) ON DELETE RESTRICT,
      handoff_id text NOT NULL REFERENCES smarthub.test_execution_handoffs(id) ON DELETE RESTRICT,
      handoff_sha256 char(64) NOT NULL,
      test_case_library_version_id text NOT NULL REFERENCES smarthub.test_case_library_versions(id) ON DELETE RESTRICT,
      test_case_library_version_sha256 char(64) NOT NULL,
      suite_version_id text REFERENCES smarthub.test_suite_versions(id) ON DELETE RESTRICT,
      suite_version_sha256 char(64),
      execution_mode text NOT NULL CHECK (execution_mode IN ('smoke','regression','full','custom')),
      member_snapshot_sha256 char(64) NOT NULL,
      environment_id text NOT NULL,
      environment_signature char(64) NOT NULL,
      snapshot_sha256 char(64) NOT NULL,
      aggregate_sha256 char(64) NOT NULL,
      create_request_sha256 char(64) NOT NULL,
      create_request_canonical text NOT NULL,
      status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','partial','cancelled')),
      state_version integer NOT NULL DEFAULT 0 CHECK (state_version >= 0),
      idempotency_key text NOT NULL,
      task_count integer NOT NULL CHECK (task_count > 0),
      created_by text NOT NULL,
      created_at timestamptz NOT NULL,
      started_at timestamptz,
      finished_at timestamptz,
      cancel_requested_at timestamptz,
      error text,
      snapshot jsonb NOT NULL,
      snapshot_canonical text NOT NULL,
      UNIQUE (project_version_id, idempotency_key),
      UNIQUE (id, test_case_library_version_id, test_case_library_version_sha256),
      CHECK ((suite_version_id IS NULL) = (suite_version_sha256 IS NULL)),
      CHECK ((status IN ('succeeded','failed','partial','cancelled')) = (finished_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS test_execution_runs_project_idx ON smarthub.test_execution_runs (project_version_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS test_execution_runs_status_idx ON smarthub.test_execution_runs (status, created_at) WHERE status IN ('queued','running');
    CREATE INDEX IF NOT EXISTS test_execution_runs_handoff_idx ON smarthub.test_execution_runs (handoff_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS smarthub.test_execution_tasks (
      id text PRIMARY KEY,
      run_id text NOT NULL REFERENCES smarthub.test_execution_runs(id) ON DELETE RESTRICT,
      ordinal integer NOT NULL CHECK (ordinal >= 0),
      dedup_key text NOT NULL,
      source_version_id text NOT NULL,
      case_id text NOT NULL REFERENCES smarthub.library_test_cases(id) ON DELETE RESTRICT,
      case_revision integer NOT NULL,
      method text NOT NULL CHECK (method IN ('ui','api','performance_tool','long_running','environment_matrix')),
      dimension text NOT NULL CHECK (dimension IN ('functional','performance','stability','compatibility','security')),
      case_content_sha256 char(64) NOT NULL,
      execution_spec_sha256 char(64) NOT NULL,
      input_sha256 char(64) NOT NULL,
      status text NOT NULL CHECK (status IN ('pending','script_generating','ready','running','diagnosing','retrying','repairing','passed','failed','blocked','unsupported','waiting_manual','cancelled')),
      state_version integer NOT NULL DEFAULT 0 CHECK (state_version >= 0),
      runner_attempt_count integer NOT NULL DEFAULT 0 CHECK (runner_attempt_count >= 0),
      same_script_retry_count integer NOT NULL DEFAULT 0 CHECK (same_script_retry_count >= 0),
      repair_count integer NOT NULL DEFAULT 0 CHECK (repair_count BETWEEN 0 AND 2),
      current_script_revision_id text,
      unsupported_reason text,
      error text,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      finished_at timestamptz,
      frozen_input jsonb NOT NULL,
      UNIQUE (run_id, ordinal),
      UNIQUE (run_id, dedup_key),
      UNIQUE (id, run_id),
      UNIQUE (id, run_id, case_id, case_revision),
      FOREIGN KEY (case_id, case_revision) REFERENCES smarthub.library_test_case_revisions(case_id, revision) ON DELETE RESTRICT,
      CHECK ((status = 'unsupported') = (unsupported_reason IS NOT NULL)),
      CHECK ((status IN ('passed','failed','blocked','unsupported','waiting_manual','cancelled')) = (finished_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS test_execution_tasks_run_status_idx ON smarthub.test_execution_tasks (run_id, status, ordinal);
    CREATE INDEX IF NOT EXISTS test_execution_tasks_case_idx ON smarthub.test_execution_tasks (case_id, case_revision, created_at DESC);

    CREATE TABLE IF NOT EXISTS smarthub.test_execution_jobs (
      id text PRIMARY KEY,
      run_id text NOT NULL REFERENCES smarthub.test_execution_runs(id) ON DELETE RESTRICT,
      task_id text NOT NULL REFERENCES smarthub.test_execution_tasks(id) ON DELETE RESTRICT,
      status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
      attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
      available_at timestamptz NOT NULL,
      lease_owner text,
      run_token uuid,
      fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
      lease_expires_at timestamptz,
      heartbeat_at timestamptz,
      cancel_requested_at timestamptz,
      started_at timestamptz,
      finished_at timestamptz,
      error text,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      data jsonb NOT NULL,
      FOREIGN KEY (task_id, run_id) REFERENCES smarthub.test_execution_tasks(id, run_id) ON DELETE RESTRICT,
      CHECK ((status = 'running') = (lease_owner IS NOT NULL)),
      CHECK ((lease_owner IS NULL) = (run_token IS NULL)),
      CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
      CHECK ((status IN ('succeeded','failed','cancelled')) = (finished_at IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS test_execution_jobs_active_task_uq ON smarthub.test_execution_jobs (task_id) WHERE status IN ('queued','running');
    CREATE INDEX IF NOT EXISTS test_execution_jobs_claim_idx ON smarthub.test_execution_jobs (available_at, created_at, id) WHERE status='queued';
    CREATE INDEX IF NOT EXISTS test_execution_jobs_lease_idx ON smarthub.test_execution_jobs (lease_expires_at, created_at, id) WHERE status='running';
    CREATE INDEX IF NOT EXISTS test_execution_jobs_run_idx ON smarthub.test_execution_jobs (run_id, created_at, id);

    CREATE OR REPLACE FUNCTION smarthub.validate_test_execution_run_write()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'TEST_EXECUTION_RUN_IMMUTABLE';
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'queued' OR NEW.state_version <> 0
          OR NEW.started_at IS NOT NULL OR NEW.finished_at IS NOT NULL
          OR NEW.cancel_requested_at IS NOT NULL THEN
          RAISE EXCEPTION 'TEST_EXECUTION_RUN_INITIAL_STATE_INVALID';
        END IF;
        IF NEW.snapshot->>'id' IS DISTINCT FROM NEW.id
          OR NEW.snapshot->>'projectId' IS DISTINCT FROM NEW.project_id
          OR NEW.snapshot->>'projectVersionId' IS DISTINCT FROM NEW.project_version_id
          OR NEW.snapshot #>> '{handoff,handoffId}' IS DISTINCT FROM NEW.handoff_id
          OR NEW.snapshot #>> '{handoff,handoffSha256}' IS DISTINCT FROM NEW.handoff_sha256
          OR NEW.snapshot #>> '{handoff,testCaseLibraryVersionId}' IS DISTINCT FROM NEW.test_case_library_version_id
          OR NEW.snapshot #>> '{handoff,testCaseLibraryVersionSha256}' IS DISTINCT FROM NEW.test_case_library_version_sha256
          OR NEW.snapshot #>> '{handoff,suiteVersionId}' IS DISTINCT FROM NEW.suite_version_id
          OR NEW.snapshot #>> '{handoff,suiteVersionSha256}' IS DISTINCT FROM NEW.suite_version_sha256
          OR NEW.snapshot #>> '{handoff,mode}' IS DISTINCT FROM NEW.execution_mode
          OR NEW.snapshot #>> '{handoff,memberSnapshotSha256}' IS DISTINCT FROM NEW.member_snapshot_sha256
          OR NEW.snapshot #>> '{environment,environmentId}' IS DISTINCT FROM NEW.environment_id
          OR NEW.snapshot #>> '{environment,signature}' IS DISTINCT FROM NEW.environment_signature
          OR NEW.snapshot->>'status' IS DISTINCT FROM NEW.status
          OR (NEW.snapshot->>'stateVersion')::integer IS DISTINCT FROM NEW.state_version
          OR NEW.snapshot->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key
          OR (NEW.snapshot->>'taskCount')::integer IS DISTINCT FROM NEW.task_count
          OR NEW.snapshot->>'createdBy' IS DISTINCT FROM NEW.created_by
          OR (NEW.snapshot->>'createdAt')::timestamptz IS DISTINCT FROM NEW.created_at
          OR NEW.snapshot_canonical::jsonb IS DISTINCT FROM jsonb_build_object(
            'schemaVersion','test-execution-run-snapshot/v1',
            'projectId',NEW.snapshot->'projectId',
            'projectVersionId',NEW.snapshot->'projectVersionId',
            'handoff',NEW.snapshot->'handoff',
            'environment',NEW.snapshot->'environment',
            'runner',NEW.snapshot->'runner',
            'agents',NEW.snapshot->'agents',
            'taskCount',NEW.snapshot->'taskCount',
            'createdBy',NEW.snapshot->'createdBy'
          )
          OR encode(digest(
            convert_to(NEW.snapshot_canonical, 'UTF8'),
            'sha256'
          ), 'hex') IS DISTINCT FROM NEW.snapshot_sha256
          OR NEW.create_request_canonical::jsonb IS DISTINCT FROM jsonb_build_object(
            'schemaVersion','test-execution-create-request/v1',
            'projectVersionId',NEW.project_version_id,
            'handoffId',NEW.handoff_id,
            'environmentId',NEW.environment_id,
            'createdBy',NEW.created_by
          )
          OR encode(digest(
            convert_to(NEW.create_request_canonical, 'UTF8'),
            'sha256'
          ), 'hex') IS DISTINCT FROM NEW.create_request_sha256 THEN
          RAISE EXCEPTION 'TEST_EXECUTION_RUN_SNAPSHOT_MISMATCH';
        END IF;
        IF NOT EXISTS (
          SELECT 1
          FROM smarthub.project_versions project_version
          JOIN smarthub.test_execution_handoffs handoff ON handoff.id=NEW.handoff_id
          JOIN smarthub.test_case_library_versions library_version ON library_version.id=NEW.test_case_library_version_id
          WHERE project_version.id=NEW.project_version_id
            AND project_version.project_id=NEW.project_id
            AND handoff.project_version_id=NEW.project_version_id
            AND handoff.test_case_set_version_id IS NULL
            AND handoff.test_case_library_version_id=NEW.test_case_library_version_id
            AND handoff.suite_version_id IS NOT DISTINCT FROM NEW.suite_version_id
            AND handoff.execution_mode=NEW.execution_mode
            AND handoff.content_sha256=NEW.handoff_sha256
            AND library_version.project_id=NEW.project_id
            AND library_version.content_sha256=NEW.test_case_library_version_sha256
        ) THEN
          RAISE EXCEPTION 'TEST_EXECUTION_RUN_SOURCE_MISMATCH';
        END IF;
        IF NEW.execution_mode = 'full' THEN
          IF NEW.suite_version_id IS NOT NULL THEN
            RAISE EXCEPTION 'TEST_EXECUTION_RUN_SUITE_INVALID';
          END IF;
        ELSIF NOT EXISTS (
          SELECT 1 FROM smarthub.test_suite_versions suite
          WHERE suite.id=NEW.suite_version_id
            AND suite.project_id=NEW.project_id
            AND suite.test_case_library_version_id=NEW.test_case_library_version_id
            AND suite.content_sha256=NEW.suite_version_sha256
            AND suite.suite_type=NEW.execution_mode
            AND suite.compatibility_status='compatible'
        ) THEN
          RAISE EXCEPTION 'TEST_EXECUTION_RUN_SUITE_INVALID';
        END IF;
        RETURN NEW;
      END IF;

      IF ROW(
        NEW.project_id,NEW.project_version_id,NEW.handoff_id,NEW.handoff_sha256,
        NEW.test_case_library_version_id,NEW.test_case_library_version_sha256,
        NEW.suite_version_id,NEW.suite_version_sha256,NEW.execution_mode,
        NEW.member_snapshot_sha256,NEW.environment_id,NEW.environment_signature,
        NEW.snapshot_sha256,NEW.aggregate_sha256,NEW.create_request_sha256,
        NEW.create_request_canonical,NEW.idempotency_key,NEW.task_count,NEW.created_by,NEW.created_at,
        NEW.snapshot,NEW.snapshot_canonical
      ) IS DISTINCT FROM ROW(
        OLD.project_id,OLD.project_version_id,OLD.handoff_id,OLD.handoff_sha256,
        OLD.test_case_library_version_id,OLD.test_case_library_version_sha256,
        OLD.suite_version_id,OLD.suite_version_sha256,OLD.execution_mode,
        OLD.member_snapshot_sha256,OLD.environment_id,OLD.environment_signature,
        OLD.snapshot_sha256,OLD.aggregate_sha256,OLD.create_request_sha256,
        OLD.create_request_canonical,OLD.idempotency_key,OLD.task_count,OLD.created_by,OLD.created_at,
        OLD.snapshot,OLD.snapshot_canonical
      ) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_RUN_SNAPSHOT_IMMUTABLE';
      END IF;
      IF NEW.state_version <> OLD.state_version + 1 THEN
        RAISE EXCEPTION 'TEST_EXECUTION_RUN_STATE_VERSION_INVALID';
      END IF;
      IF OLD.status IN ('succeeded','cancelled')
        OR (OLD.status IN ('failed','partial') AND NOT (
          NEW.status='running'
          AND OLD.cancel_requested_at IS NULL
          AND NEW.cancel_requested_at IS NULL
          AND NEW.finished_at IS NULL
          AND NEW.error IS NULL
          AND NEW.started_at IS NOT DISTINCT FROM OLD.started_at
        )) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_RUN_TERMINAL_IMMUTABLE';
      END IF;
      IF NEW.status = OLD.status THEN
        IF OLD.status NOT IN ('queued','running')
          OR OLD.cancel_requested_at IS NOT NULL
          OR NEW.cancel_requested_at IS NULL
          OR ROW(NEW.started_at,NEW.finished_at,NEW.error) IS DISTINCT FROM ROW(OLD.started_at,OLD.finished_at,OLD.error) THEN
          RAISE EXCEPTION 'TEST_EXECUTION_RUN_TRANSITION_INVALID';
        END IF;
      ELSIF NOT (
        (OLD.status='queued' AND NEW.status='running')
        OR (OLD.status='running' AND NEW.status IN ('succeeded','failed','partial','cancelled'))
        OR (OLD.status IN ('failed','partial') AND NEW.status='running')
      ) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_RUN_TRANSITION_INVALID';
      END IF;
      IF OLD.cancel_requested_at IS NOT NULL AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at THEN
        RAISE EXCEPTION 'TEST_EXECUTION_RUN_CANCELLATION_IMMUTABLE';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_execution_runs_write_ck
      BEFORE INSERT OR UPDATE OR DELETE ON smarthub.test_execution_runs
      FOR EACH ROW EXECUTE FUNCTION smarthub.validate_test_execution_run_write();

    CREATE OR REPLACE FUNCTION smarthub.validate_test_execution_task_write()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE allowed boolean := false;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'TEST_EXECUTION_TASK_IMMUTABLE';
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.state_version <> 0 OR NEW.runner_attempt_count <> 0
          OR NEW.same_script_retry_count <> 0 OR NEW.repair_count <> 0
          OR NEW.current_script_revision_id IS NOT NULL
          OR (NEW.method IN ('ui','api') AND NEW.status <> 'pending')
          OR (NEW.method NOT IN ('ui','api') AND NEW.status <> 'unsupported') THEN
          RAISE EXCEPTION 'TEST_EXECUTION_TASK_INITIAL_STATE_INVALID';
        END IF;
        IF NOT EXISTS (
          SELECT 1
          FROM smarthub.test_execution_runs run
          JOIN smarthub.test_execution_handoff_members handoff_member
            ON handoff_member.handoff_id=run.handoff_id
           AND handoff_member.stage=NEW.frozen_input->>'stage'
           AND handoff_member.ordinal=NEW.ordinal
          JOIN smarthub.test_case_library_version_members library_member
            ON library_member.version_id=run.test_case_library_version_id
           AND library_member.case_id=NEW.case_id
          WHERE run.id=NEW.run_id
            AND handoff_member.source_version_id=NEW.source_version_id
            AND handoff_member.case_id=NEW.case_id
            AND handoff_member.case_revision=NEW.case_revision
            AND handoff_member.method=NEW.method
            AND handoff_member.dedup_key=NEW.dedup_key
            AND handoff_member.dimension=NEW.dimension
            AND handoff_member.execution_spec=NEW.frozen_input->'executionSpec'
            AND handoff_member.traceability IS NOT DISTINCT FROM NEW.frozen_input->'traceability'
            AND handoff_member.readiness_override IS NOT DISTINCT FROM NEW.frozen_input->'readinessOverride'
            AND handoff_member.content_sha256=NEW.case_content_sha256
            AND library_member.case_revision=NEW.case_revision
            AND library_member.content_sha256=NEW.case_content_sha256
            AND library_member.frozen_content=NEW.frozen_input->'caseContent'
            AND library_member.traceability IS NOT DISTINCT FROM NEW.frozen_input->'traceability'
            AND NEW.frozen_input->>'taskId'=NEW.id
            AND NEW.frozen_input->>'runId'=NEW.run_id
            AND NEW.frozen_input->>'inputSha256'=NEW.input_sha256
            AND NEW.frozen_input->>'sourceVersionId'=NEW.source_version_id
            AND (NEW.frozen_input->>'ordinal')::integer=NEW.ordinal
            AND NEW.frozen_input->>'dedupKey'=NEW.dedup_key
            AND NEW.frozen_input->>'caseId'=NEW.case_id
            AND (NEW.frozen_input->>'caseRevision')::integer=NEW.case_revision
            AND NEW.frozen_input->>'method'=NEW.method
            AND NEW.frozen_input->>'dimension'=NEW.dimension
            AND NEW.frozen_input->>'caseContentSha256'=NEW.case_content_sha256
            AND NEW.frozen_input->>'executionSpecSha256'=NEW.execution_spec_sha256
        ) THEN
          RAISE EXCEPTION 'TEST_EXECUTION_TASK_SOURCE_MISMATCH';
        END IF;
        RETURN NEW;
      END IF;

      IF ROW(
        NEW.run_id,NEW.ordinal,NEW.dedup_key,NEW.source_version_id,NEW.case_id,
        NEW.case_revision,NEW.method,NEW.dimension,NEW.case_content_sha256,
        NEW.execution_spec_sha256,NEW.input_sha256,NEW.created_at,NEW.frozen_input
      ) IS DISTINCT FROM ROW(
        OLD.run_id,OLD.ordinal,OLD.dedup_key,OLD.source_version_id,OLD.case_id,
        OLD.case_revision,OLD.method,OLD.dimension,OLD.case_content_sha256,
        OLD.execution_spec_sha256,OLD.input_sha256,OLD.created_at,OLD.frozen_input
      ) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_TASK_SNAPSHOT_IMMUTABLE';
      END IF;
      IF NEW.state_version <> OLD.state_version + 1 THEN
        RAISE EXCEPTION 'TEST_EXECUTION_TASK_STATE_VERSION_INVALID';
      END IF;
      IF OLD.status IN ('passed','unsupported','cancelled') OR NEW.status=OLD.status THEN
        RAISE EXCEPTION 'TEST_EXECUTION_TASK_TRANSITION_INVALID';
      END IF;
      allowed := CASE OLD.status
        WHEN 'pending' THEN NEW.status IN ('script_generating','ready','unsupported','blocked','cancelled')
        WHEN 'script_generating' THEN NEW.status IN ('ready','blocked','waiting_manual','cancelled')
        WHEN 'ready' THEN NEW.status IN ('running','blocked','waiting_manual','cancelled')
        WHEN 'running' THEN NEW.status IN ('ready','passed','retrying','diagnosing','blocked','waiting_manual','cancelled')
        WHEN 'retrying' THEN NEW.status IN ('running','blocked','cancelled')
        WHEN 'diagnosing' THEN NEW.status IN ('repairing','failed','blocked','waiting_manual','cancelled')
        WHEN 'repairing' THEN NEW.status IN ('ready','blocked','waiting_manual','cancelled')
        WHEN 'failed' THEN NEW.status='ready'
        WHEN 'blocked' THEN NEW.status='ready'
        WHEN 'waiting_manual' THEN NEW.status='ready'
        ELSE false
      END;
      IF NOT allowed THEN RAISE EXCEPTION 'TEST_EXECUTION_TASK_TRANSITION_INVALID'; END IF;
      IF OLD.status='running' AND NEW.status='ready' AND NOT EXISTS (
        SELECT 1 FROM smarthub.test_execution_attempts
        WHERE task_id=NEW.id
          AND ordinal=NEW.runner_attempt_count
          AND status='infrastructure_error'
      ) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_INFRASTRUCTURE_RETRY_REQUIRED';
      END IF;
      IF NEW.runner_attempt_count < OLD.runner_attempt_count
        OR NEW.runner_attempt_count > OLD.runner_attempt_count + 1
        OR NEW.same_script_retry_count < OLD.same_script_retry_count
        OR NEW.same_script_retry_count > OLD.same_script_retry_count + 1
        OR NEW.repair_count < OLD.repair_count
        OR NEW.repair_count > OLD.repair_count + 1
        OR (NEW.runner_attempt_count > OLD.runner_attempt_count AND NEW.status <> 'running')
        OR (NEW.same_script_retry_count > OLD.same_script_retry_count AND NEW.status <> 'running')
        OR (NEW.repair_count > OLD.repair_count AND NEW.status <> 'ready') THEN
        RAISE EXCEPTION 'TEST_EXECUTION_TASK_COUNTER_INVALID';
      END IF;
      IF NEW.current_script_revision_id IS DISTINCT FROM OLD.current_script_revision_id
        AND NEW.status <> 'ready' THEN
        RAISE EXCEPTION 'TEST_EXECUTION_TASK_SCRIPT_REVISION_INVALID';
      END IF;
      IF NEW.status IN ('passed','failed','blocked','unsupported','waiting_manual','cancelled') THEN
        IF EXISTS (
          SELECT 1 FROM smarthub.test_execution_attempts
          WHERE task_id=NEW.id AND status='running'
        ) THEN
          RAISE EXCEPTION 'TEST_EXECUTION_TASK_HAS_RUNNING_ATTEMPT';
        END IF;
        IF NEW.status='passed' AND NOT EXISTS (
          SELECT 1 FROM smarthub.test_execution_attempts
          WHERE task_id=NEW.id
            AND script_revision_id=NEW.current_script_revision_id
            AND status='passed'
        ) THEN
          RAISE EXCEPTION 'TEST_EXECUTION_TASK_PASSED_ATTEMPT_REQUIRED';
        END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_execution_tasks_write_ck
      BEFORE INSERT OR UPDATE OR DELETE ON smarthub.test_execution_tasks
      FOR EACH ROW EXECUTE FUNCTION smarthub.validate_test_execution_task_write();

    CREATE OR REPLACE FUNCTION smarthub.validate_test_execution_job_write()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE task_status text;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'TEST_EXECUTION_JOB_IMMUTABLE';
      END IF;
      SELECT status INTO task_status FROM smarthub.test_execution_tasks WHERE id=NEW.task_id;
      IF task_status IS NULL THEN RAISE EXCEPTION 'TEST_EXECUTION_JOB_TASK_NOT_FOUND'; END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'queued' OR NEW.attempt_count <> 0 OR NEW.fencing_token <> 0
          OR NEW.lease_owner IS NOT NULL OR NEW.run_token IS NOT NULL
          OR NEW.lease_expires_at IS NOT NULL OR NEW.heartbeat_at IS NOT NULL
          OR NEW.cancel_requested_at IS NOT NULL
          OR task_status IN ('passed','failed','blocked','unsupported','waiting_manual','cancelled') THEN
          RAISE EXCEPTION 'TEST_EXECUTION_JOB_INITIAL_STATE_INVALID';
        END IF;
        RETURN NEW;
      END IF;
      IF ROW(NEW.run_id,NEW.task_id,NEW.max_attempts,NEW.created_at,NEW.data)
        IS DISTINCT FROM ROW(OLD.run_id,OLD.task_id,OLD.max_attempts,OLD.created_at,OLD.data) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_JOB_SNAPSHOT_IMMUTABLE';
      END IF;
      IF OLD.status IN ('succeeded','failed','cancelled') THEN
        RAISE EXCEPTION 'TEST_EXECUTION_JOB_TERMINAL_IMMUTABLE';
      END IF;
      IF OLD.cancel_requested_at IS NOT NULL
        AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at THEN
        RAISE EXCEPTION 'TEST_EXECUTION_JOB_CANCELLATION_IMMUTABLE';
      END IF;
      IF NEW.fencing_token <> OLD.fencing_token THEN
        IF NEW.fencing_token <> OLD.fencing_token + 1
          OR NEW.attempt_count <> OLD.attempt_count + 1
          OR NEW.status <> 'running'
          OR NEW.lease_owner IS NULL OR NEW.run_token IS NULL
          OR NEW.run_token IS NOT DISTINCT FROM OLD.run_token
          OR NEW.lease_expires_at <= clock_timestamp()
          OR (OLD.status='running' AND OLD.lease_expires_at >= clock_timestamp()) THEN
          RAISE EXCEPTION 'TEST_EXECUTION_JOB_FENCING_INVALID';
        END IF;
      ELSIF NEW.attempt_count <> OLD.attempt_count THEN
        RAISE EXCEPTION 'TEST_EXECUTION_JOB_ATTEMPT_COUNT_INVALID';
      END IF;
      IF NEW.status='running' THEN
        IF task_status IN ('passed','failed','blocked','unsupported','waiting_manual','cancelled') THEN
          RAISE EXCEPTION 'TEST_EXECUTION_JOB_TASK_TERMINAL';
        END IF;
        IF NEW.fencing_token=OLD.fencing_token
          AND ROW(NEW.lease_owner,NEW.run_token) IS DISTINCT FROM ROW(OLD.lease_owner,OLD.run_token) THEN
          RAISE EXCEPTION 'TEST_EXECUTION_JOB_LEASE_IDENTITY_INVALID';
        END IF;
        IF NEW.fencing_token=OLD.fencing_token
          AND OLD.lease_expires_at IS NOT NULL
          AND NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
          AND (OLD.lease_expires_at <= clock_timestamp()
            OR NEW.lease_expires_at < OLD.lease_expires_at) THEN
          RAISE EXCEPTION 'TEST_EXECUTION_JOB_LEASE_REGRESSION';
        END IF;
      END IF;
      IF NOT (
        (OLD.status='queued' AND NEW.status IN ('running','cancelled'))
        OR (OLD.status='running' AND NEW.status IN ('running','queued','succeeded','failed','cancelled'))
      ) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_JOB_TRANSITION_INVALID';
      END IF;
      IF NEW.status IN ('succeeded','failed','cancelled') AND NOT (
        (NEW.status='succeeded' AND task_status='passed')
        OR (NEW.status='cancelled' AND task_status='cancelled')
        OR (NEW.status='failed' AND task_status IN ('failed','blocked','unsupported','waiting_manual'))
      ) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_JOB_TERMINAL_MISMATCH';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_execution_jobs_write_ck
      BEFORE INSERT OR UPDATE OR DELETE ON smarthub.test_execution_jobs
      FOR EACH ROW EXECUTE FUNCTION smarthub.validate_test_execution_job_write();

    CREATE OR REPLACE FUNCTION smarthub.validate_test_execution_aggregate_completeness()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target_run_id text;
    DECLARE declared_tasks integer;
    DECLARE actual_tasks integer;
    DECLARE executable_tasks integer;
    DECLARE actual_jobs integer;
    DECLARE run_status text;
    DECLARE run_state_version integer;
    DECLARE aggregate_status text;
    DECLARE initial_tasks boolean;
    BEGIN
      target_run_id := CASE
        WHEN TG_TABLE_NAME='test_execution_runs' THEN CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END
        ELSE CASE WHEN TG_OP='DELETE' THEN OLD.run_id ELSE NEW.run_id END
      END;
      SELECT task_count,status,state_version
        INTO declared_tasks,run_status,run_state_version
      FROM smarthub.test_execution_runs WHERE id=target_run_id;
      IF NOT FOUND THEN RETURN NEW; END IF;
      SELECT count(*),count(*) FILTER (WHERE status <> 'unsupported'),
        CASE
          WHEN bool_or(status NOT IN ('passed','failed','blocked','unsupported','waiting_manual','cancelled')) THEN 'running'
          WHEN bool_and(status='cancelled') THEN 'cancelled'
          WHEN bool_and(status='passed') THEN 'succeeded'
          WHEN bool_and(status='failed') THEN 'failed'
          ELSE 'partial'
        END,
        bool_and(state_version=0 AND status IN ('pending','unsupported'))
        INTO actual_tasks,executable_tasks,aggregate_status,initial_tasks
      FROM smarthub.test_execution_tasks WHERE run_id=target_run_id;
      SELECT count(DISTINCT task_id) INTO actual_jobs
      FROM smarthub.test_execution_jobs WHERE run_id=target_run_id;
      IF actual_tasks <> declared_tasks OR actual_jobs <> executable_tasks THEN
        RAISE EXCEPTION 'TEST_EXECUTION_AGGREGATE_INCOMPLETE';
      END IF;
      IF NOT (
        (run_status='queued' AND run_state_version=0 AND initial_tasks)
        OR (run_status='running' AND aggregate_status='running')
        OR (run_status IN ('succeeded','failed','partial','cancelled') AND run_status=aggregate_status)
      ) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_RUN_TASK_STATUS_MISMATCH';
      END IF;
      RETURN NEW;
    END $$;
    CREATE CONSTRAINT TRIGGER test_execution_runs_aggregate_ck
      AFTER INSERT OR UPDATE ON smarthub.test_execution_runs
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION smarthub.validate_test_execution_aggregate_completeness();
    CREATE CONSTRAINT TRIGGER test_execution_tasks_aggregate_ck
      AFTER INSERT OR UPDATE OR DELETE ON smarthub.test_execution_tasks
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION smarthub.validate_test_execution_aggregate_completeness();
    CREATE CONSTRAINT TRIGGER test_execution_jobs_aggregate_ck
      AFTER INSERT OR UPDATE OR DELETE ON smarthub.test_execution_jobs
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION smarthub.validate_test_execution_aggregate_completeness();
  `,
}, {
  version: 28,
  name: 'test-execution-append-only-history-and-artifacts',
  sql: `
    CREATE TABLE IF NOT EXISTS smarthub.test_execution_artifacts (
      id text PRIMARY KEY,
      run_id text NOT NULL REFERENCES smarthub.test_execution_runs(id) ON DELETE RESTRICT,
      task_id text REFERENCES smarthub.test_execution_tasks(id) ON DELETE RESTRICT,
      attempt_id text,
      artifact_type text NOT NULL CHECK (artifact_type IN ('log','screenshot','trace','video','har','script','package','result','completion_manifest')),
      storage_path text NOT NULL,
      sha256 char(64) NOT NULL,
      byte_size bigint NOT NULL CHECK (byte_size >= 0),
      mime_type text NOT NULL,
      created_at timestamptz NOT NULL,
      UNIQUE (id, sha256),
      UNIQUE (id, run_id, task_id),
      UNIQUE (id, run_id, task_id, attempt_id),
      UNIQUE (id, run_id, task_id, sha256),
      FOREIGN KEY (task_id, run_id) REFERENCES smarthub.test_execution_tasks(id, run_id) ON DELETE RESTRICT,
      CHECK (attempt_id IS NULL OR task_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS test_execution_artifacts_task_idx ON smarthub.test_execution_artifacts (task_id, created_at, id);
    CREATE INDEX IF NOT EXISTS test_execution_artifacts_attempt_idx ON smarthub.test_execution_artifacts (attempt_id, created_at, id) WHERE attempt_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS smarthub.test_execution_script_artifacts (
      id text PRIMARY KEY,
      cache_key char(64) NOT NULL UNIQUE,
      case_id text NOT NULL REFERENCES smarthub.library_test_cases(id) ON DELETE RESTRICT,
      case_revision integer NOT NULL,
      method text NOT NULL CHECK (method IN ('ui','api')),
      case_content_sha256 char(64) NOT NULL,
      execution_spec_sha256 char(64) NOT NULL,
      environment_signature char(64) NOT NULL,
      test_script_agent_version integer NOT NULL CHECK (test_script_agent_version > 0),
      test_script_agent_configuration_sha256 char(64) NOT NULL,
      created_at timestamptz NOT NULL,
      FOREIGN KEY (case_id, case_revision) REFERENCES smarthub.library_test_case_revisions(case_id, revision) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS test_execution_script_artifacts_case_idx ON smarthub.test_execution_script_artifacts (case_id, case_revision, method, created_at DESC);

    CREATE TABLE IF NOT EXISTS smarthub.test_execution_script_revisions (
      id text PRIMARY KEY,
      run_id text NOT NULL REFERENCES smarthub.test_execution_runs(id) ON DELETE RESTRICT,
      task_id text NOT NULL REFERENCES smarthub.test_execution_tasks(id) ON DELETE RESTRICT,
      script_artifact_id text NOT NULL REFERENCES smarthub.test_execution_script_artifacts(id) ON DELETE RESTRICT,
      revision integer NOT NULL CHECK (revision > 0),
      parent_revision_id text,
      cache_source_revision_id text,
      generation_source text NOT NULL CHECK (generation_source IN ('agent','cache','repair')),
      repair_reason text,
      generated_by jsonb NOT NULL,
      package_manifest jsonb NOT NULL,
      package_canonical text NOT NULL,
      package_sha256 char(64) NOT NULL,
      source_artifact_id text NOT NULL,
      content_sha256 char(64) NOT NULL,
      protected_assertion_sha256 char(64) NOT NULL,
      protected_assertions_canonical text NOT NULL,
      created_at timestamptz NOT NULL,
      UNIQUE (task_id, revision),
      UNIQUE (task_id, content_sha256),
      UNIQUE (id, run_id, task_id),
      UNIQUE (id, run_id, task_id, package_sha256),
      FOREIGN KEY (task_id, run_id) REFERENCES smarthub.test_execution_tasks(id, run_id) ON DELETE RESTRICT,
      FOREIGN KEY (parent_revision_id, run_id, task_id) REFERENCES smarthub.test_execution_script_revisions(id, run_id, task_id) ON DELETE RESTRICT,
      FOREIGN KEY (cache_source_revision_id) REFERENCES smarthub.test_execution_script_revisions(id) ON DELETE RESTRICT,
      FOREIGN KEY (source_artifact_id, run_id, task_id, content_sha256) REFERENCES smarthub.test_execution_artifacts(id, run_id, task_id, sha256) ON DELETE RESTRICT,
      CHECK ((generation_source = 'repair') = (repair_reason IS NOT NULL)),
      CHECK ((generation_source = 'cache') = (cache_source_revision_id IS NOT NULL))
    );
    ALTER TABLE smarthub.test_execution_tasks
      ADD CONSTRAINT test_execution_tasks_current_script_revision_fk
      FOREIGN KEY (current_script_revision_id, run_id, id) REFERENCES smarthub.test_execution_script_revisions(id, run_id, task_id) ON DELETE RESTRICT;

    CREATE OR REPLACE FUNCTION smarthub.validate_test_execution_script_revision_insert()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE previous_revision integer;
    DECLARE parent_protected_assertion_sha256 char(64);
    DECLARE parent_assertions jsonb;
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM smarthub.test_execution_tasks task
        JOIN smarthub.test_execution_runs run ON run.id=task.run_id
        JOIN smarthub.test_execution_script_artifacts artifact ON artifact.id=NEW.script_artifact_id
        JOIN smarthub.test_execution_artifacts source
          ON source.id=NEW.source_artifact_id
         AND source.run_id=NEW.run_id
         AND source.task_id=NEW.task_id
         AND source.sha256=NEW.content_sha256
        WHERE task.id=NEW.task_id AND task.run_id=NEW.run_id
          AND artifact.case_id=task.case_id
          AND artifact.case_revision=task.case_revision
          AND artifact.method=task.method
          AND artifact.case_content_sha256=task.case_content_sha256
          AND artifact.execution_spec_sha256=task.execution_spec_sha256
          AND artifact.environment_signature=run.environment_signature
          AND artifact.test_script_agent_version=(run.snapshot #>> '{agents,testScript,configurationVersion}')::integer
          AND artifact.test_script_agent_configuration_sha256=run.snapshot #>> '{agents,testScript,configurationSha256}'
          AND NEW.generated_by=CASE
            WHEN NEW.generation_source='repair' THEN run.snapshot->'agents'->'scriptRepair'
            ELSE run.snapshot->'agents'->'testScript'
          END
          AND NEW.package_manifest->>'taskId'=task.id
          AND NEW.package_manifest->>'caseId'=task.case_id
          AND (NEW.package_manifest->>'caseRevision')::integer=task.case_revision
          AND NEW.package_manifest->>'method'=task.method
          AND NEW.package_manifest->>'taskInputSha256'=task.input_sha256
          AND NEW.package_manifest->>'caseContentSha256'=task.case_content_sha256
          AND NEW.package_manifest->>'executionSpecSha256'=task.execution_spec_sha256
          AND NEW.package_manifest->>'environmentSignature'=run.environment_signature
          AND NEW.package_manifest->>'entrypoint'='tests/' || task.id || '.spec.ts'
          AND jsonb_typeof(NEW.package_manifest->'files')='array'
          AND jsonb_array_length(NEW.package_manifest->'files')=1
          AND NEW.package_manifest #>> '{files,0,path}'=NEW.package_manifest->>'entrypoint'
          AND NEW.package_manifest #>> '{files,0,contentSha256}'=NEW.content_sha256
          AND (NEW.package_manifest #>> '{files,0,size}')::bigint=source.byte_size
          AND NEW.package_manifest->>'packageSha256'=NEW.package_sha256
          AND NEW.package_canonical::jsonb=NEW.package_manifest-'packageSha256'
          AND encode(digest(
            convert_to(NEW.package_canonical, 'UTF8'),
            'sha256'
          ), 'hex')=NEW.package_sha256
          AND NEW.package_manifest->>'protectedAssertionSha256'=NEW.protected_assertion_sha256
          AND jsonb_typeof(NEW.package_manifest->'assertions')='array'
          AND NEW.protected_assertions_canonical::jsonb=NEW.package_manifest->'assertions'
          AND encode(digest(
            convert_to(NEW.protected_assertions_canonical, 'UTF8'),
            'sha256'
          ), 'hex')=NEW.protected_assertion_sha256
          AND source.artifact_type='script'
          AND source.attempt_id IS NULL
      ) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_SCRIPT_REVISION_SOURCE_MISMATCH';
      END IF;
      IF NEW.generation_source='cache' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM smarthub.test_execution_script_revisions source_revision
          WHERE source_revision.id=NEW.cache_source_revision_id
            AND source_revision.script_artifact_id=NEW.script_artifact_id
            AND source_revision.generation_source<>'cache'
            AND source_revision.content_sha256=NEW.content_sha256
            AND source_revision.protected_assertion_sha256=NEW.protected_assertion_sha256
        ) THEN
          RAISE EXCEPTION 'TEST_EXECUTION_SCRIPT_CACHE_PROVENANCE_INVALID';
        END IF;
      ELSIF NEW.cache_source_revision_id IS NOT NULL THEN
        RAISE EXCEPTION 'TEST_EXECUTION_SCRIPT_CACHE_PROVENANCE_FORBIDDEN';
      END IF;
      IF NEW.generation_source='repair' THEN
        IF NEW.parent_revision_id IS NULL OR NEW.revision <= 1 THEN
          RAISE EXCEPTION 'TEST_EXECUTION_SCRIPT_REVISION_PARENT_INVALID';
        END IF;
        SELECT revision,protected_assertion_sha256,package_manifest->'assertions'
          INTO previous_revision,parent_protected_assertion_sha256,parent_assertions
        FROM smarthub.test_execution_script_revisions
        WHERE id=NEW.parent_revision_id AND run_id=NEW.run_id AND task_id=NEW.task_id;
        IF previous_revision IS DISTINCT FROM NEW.revision-1 THEN
          RAISE EXCEPTION 'TEST_EXECUTION_SCRIPT_REVISION_PARENT_INVALID';
        END IF;
        IF NEW.protected_assertion_sha256 IS DISTINCT FROM parent_protected_assertion_sha256
          OR NEW.package_manifest->'assertions' IS DISTINCT FROM parent_assertions THEN
          RAISE EXCEPTION 'TEST_EXECUTION_SCRIPT_REVISION_ASSERTIONS_CHANGED';
        END IF;
      ELSIF NEW.parent_revision_id IS NOT NULL OR NEW.revision <> 1 THEN
        RAISE EXCEPTION 'TEST_EXECUTION_SCRIPT_REVISION_PARENT_INVALID';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_execution_script_revisions_insert_ck
      BEFORE INSERT ON smarthub.test_execution_script_revisions
      FOR EACH ROW EXECUTE FUNCTION smarthub.validate_test_execution_script_revision_insert();

    CREATE TABLE IF NOT EXISTS smarthub.test_execution_attempts (
      id text PRIMARY KEY,
      run_id text NOT NULL REFERENCES smarthub.test_execution_runs(id) ON DELETE RESTRICT,
      task_id text NOT NULL REFERENCES smarthub.test_execution_tasks(id) ON DELETE RESTRICT,
      ordinal integer NOT NULL CHECK (ordinal > 0),
      invocation_key text NOT NULL UNIQUE,
      attempt_kind text NOT NULL CHECK (attempt_kind IN ('initial','same_script_retry','infrastructure_retry','post_repair','manual_retry')),
      script_revision_id text NOT NULL,
      package_sha256 char(64) NOT NULL,
      status text NOT NULL CHECK (status IN ('running','passed','failed','cancelled','infrastructure_error')),
      started_at timestamptz NOT NULL,
      finished_at timestamptz,
      duration_ms bigint CHECK (duration_ms IS NULL OR duration_ms >= 0),
      exit_code integer,
      summary text,
      error text,
      UNIQUE (task_id, ordinal),
      UNIQUE (id, run_id, task_id),
      UNIQUE (id, run_id, task_id, script_revision_id),
      FOREIGN KEY (task_id, run_id) REFERENCES smarthub.test_execution_tasks(id, run_id) ON DELETE RESTRICT,
      FOREIGN KEY (script_revision_id, run_id, task_id, package_sha256) REFERENCES smarthub.test_execution_script_revisions(id, run_id, task_id, package_sha256) ON DELETE RESTRICT,
      CHECK ((status = 'running') = (finished_at IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS test_execution_attempts_one_running_task_uq ON smarthub.test_execution_attempts (task_id) WHERE status='running';
    CREATE INDEX IF NOT EXISTS test_execution_attempts_task_idx ON smarthub.test_execution_attempts (task_id, ordinal);
    CREATE INDEX IF NOT EXISTS test_execution_attempts_run_idx ON smarthub.test_execution_attempts (run_id, started_at, id);
    CREATE OR REPLACE FUNCTION smarthub.validate_test_execution_attempt_write()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE task_status text;
    DECLARE task_revision_id text;
    DECLARE task_attempt_count integer;
    DECLARE revision_source text;
    DECLARE revision_attempt_count integer;
    DECLARE revision_same_retry_count integer;
    DECLARE previous_attempt_status text;
    DECLARE previous_attempt_kind text;
    DECLARE previous_script_revision_id text;
    DECLARE previous_package_sha256 char(64);
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'TEST_EXECUTION_HISTORY_IMMUTABLE';
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF EXISTS (
          SELECT 1 FROM smarthub.test_execution_attempts existing
          WHERE existing.id=NEW.id
            AND existing.run_id=NEW.run_id
            AND existing.task_id=NEW.task_id
            AND existing.ordinal=NEW.ordinal
            AND existing.invocation_key=NEW.invocation_key
            AND existing.attempt_kind=NEW.attempt_kind
            AND existing.script_revision_id=NEW.script_revision_id
            AND existing.package_sha256=NEW.package_sha256
            AND existing.started_at=NEW.started_at
        ) THEN
          RETURN NEW;
        END IF;
        SELECT status,current_script_revision_id,runner_attempt_count
          INTO task_status,task_revision_id,task_attempt_count
        FROM smarthub.test_execution_tasks WHERE id=NEW.task_id;
        SELECT generation_source INTO revision_source
        FROM smarthub.test_execution_script_revisions
        WHERE id=NEW.script_revision_id AND task_id=NEW.task_id;
        SELECT count(*),
               count(*) FILTER (
                 WHERE attempt_kind='same_script_retry'
                   AND status IN ('passed','failed')
               )
          INTO revision_attempt_count,revision_same_retry_count
        FROM smarthub.test_execution_attempts
        WHERE task_id=NEW.task_id AND script_revision_id=NEW.script_revision_id;
        SELECT status,attempt_kind,script_revision_id,package_sha256
          INTO previous_attempt_status,previous_attempt_kind,
               previous_script_revision_id,previous_package_sha256
        FROM smarthub.test_execution_attempts
        WHERE task_id=NEW.task_id AND ordinal=task_attempt_count;
        IF NEW.status <> 'running' OR NEW.finished_at IS NOT NULL
          OR NEW.duration_ms IS NOT NULL OR NEW.exit_code IS NOT NULL
          OR NEW.summary IS NOT NULL OR NEW.error IS NOT NULL
          OR task_status NOT IN ('ready','retrying')
          OR NEW.script_revision_id IS DISTINCT FROM task_revision_id
          OR NEW.ordinal <> task_attempt_count + 1
          OR (task_status='retrying' AND NEW.attempt_kind <> 'same_script_retry')
          OR (task_status<>'retrying' AND NEW.attempt_kind='same_script_retry')
          OR (NEW.attempt_kind='initial' AND (task_attempt_count<>0 OR revision_attempt_count<>0 OR revision_source='repair'))
          OR (
            NEW.attempt_kind='same_script_retry'
            AND (
              revision_same_retry_count<>0
              OR previous_attempt_status NOT IN ('failed','infrastructure_error')
              OR (
                previous_attempt_status='infrastructure_error'
                AND previous_attempt_kind<>'same_script_retry'
              )
              OR previous_script_revision_id IS DISTINCT FROM NEW.script_revision_id
              OR previous_package_sha256 IS DISTINCT FROM NEW.package_sha256
            )
          )
          OR (
            NEW.attempt_kind='infrastructure_retry'
            AND (
              task_status<>'ready'
              OR previous_attempt_status<>'infrastructure_error'
              OR previous_script_revision_id IS DISTINCT FROM NEW.script_revision_id
              OR previous_package_sha256 IS DISTINCT FROM NEW.package_sha256
            )
          )
          OR (NEW.attempt_kind='post_repair' AND (revision_source<>'repair' OR revision_attempt_count<>0))
          OR (NEW.attempt_kind='manual_retry' AND (task_attempt_count=0 OR revision_attempt_count=0))
          OR (NEW.attempt_kind NOT IN ('initial','post_repair','manual_retry','same_script_retry','infrastructure_retry')) THEN
          RAISE EXCEPTION 'TEST_EXECUTION_ATTEMPT_INITIAL_STATE_INVALID';
        END IF;
        RETURN NEW;
      END IF;
      IF OLD.status <> 'running' OR NEW.status='running'
        OR ROW(
          NEW.run_id,NEW.task_id,NEW.ordinal,NEW.invocation_key,
          NEW.attempt_kind,NEW.script_revision_id,NEW.package_sha256,NEW.started_at
        ) IS DISTINCT FROM ROW(
          OLD.run_id,OLD.task_id,OLD.ordinal,OLD.invocation_key,
          OLD.attempt_kind,OLD.script_revision_id,OLD.package_sha256,OLD.started_at
        )
        OR NEW.finished_at IS NULL OR NEW.finished_at < NEW.started_at
        OR NEW.duration_ms IS NULL OR NEW.duration_ms < 0 THEN
        RAISE EXCEPTION 'TEST_EXECUTION_ATTEMPT_FINALIZATION_INVALID';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_execution_attempts_write_ck
      BEFORE INSERT OR UPDATE OR DELETE ON smarthub.test_execution_attempts
      FOR EACH ROW EXECUTE FUNCTION smarthub.validate_test_execution_attempt_write();

    CREATE OR REPLACE FUNCTION smarthub.validate_test_execution_task_attempts()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target_task_id text;
    DECLARE task_status text;
    DECLARE declared_attempts integer;
    DECLARE declared_retries integer;
    DECLARE actual_attempts integer;
    DECLARE actual_retries integer;
    DECLARE running_attempts integer;
    BEGIN
      target_task_id := CASE
        WHEN TG_TABLE_NAME='test_execution_tasks' THEN CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END
        ELSE CASE WHEN TG_OP='DELETE' THEN OLD.task_id ELSE NEW.task_id END
      END;
      SELECT status,runner_attempt_count,same_script_retry_count
        INTO task_status,declared_attempts,declared_retries
      FROM smarthub.test_execution_tasks WHERE id=target_task_id;
      IF NOT FOUND THEN RETURN NEW; END IF;
      SELECT count(*),
             count(*) FILTER (WHERE attempt_kind='same_script_retry'),
             count(*) FILTER (WHERE status='running')
        INTO actual_attempts,actual_retries,running_attempts
      FROM smarthub.test_execution_attempts WHERE task_id=target_task_id;
      IF actual_attempts <> declared_attempts
        OR actual_retries <> declared_retries
        OR (task_status='running' AND running_attempts <> 1)
        OR (task_status<>'running' AND running_attempts <> 0) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_TASK_ATTEMPT_STATE_MISMATCH';
      END IF;
      RETURN NEW;
    END $$;
    CREATE CONSTRAINT TRIGGER test_execution_tasks_attempts_ck
      AFTER INSERT OR UPDATE ON smarthub.test_execution_tasks
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION smarthub.validate_test_execution_task_attempts();
    CREATE CONSTRAINT TRIGGER test_execution_attempts_task_ck
      AFTER INSERT OR UPDATE ON smarthub.test_execution_attempts
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION smarthub.validate_test_execution_task_attempts();

    CREATE OR REPLACE FUNCTION smarthub.validate_test_execution_task_revisions()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target_task_id text;
    DECLARE current_revision_id text;
    DECLARE declared_repairs integer;
    DECLARE actual_revisions integer;
    DECLARE actual_repairs integer;
    DECLARE latest_revision_id text;
    BEGIN
      target_task_id := CASE
        WHEN TG_TABLE_NAME='test_execution_tasks' THEN CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END
        ELSE CASE WHEN TG_OP='DELETE' THEN OLD.task_id ELSE NEW.task_id END
      END;
      SELECT current_script_revision_id,repair_count
        INTO current_revision_id,declared_repairs
      FROM smarthub.test_execution_tasks WHERE id=target_task_id;
      IF NOT FOUND THEN RETURN NEW; END IF;
      SELECT count(*),count(*) FILTER (WHERE generation_source='repair')
        INTO actual_revisions,actual_repairs
      FROM smarthub.test_execution_script_revisions WHERE task_id=target_task_id;
      SELECT id INTO latest_revision_id
      FROM smarthub.test_execution_script_revisions
      WHERE task_id=target_task_id ORDER BY revision DESC LIMIT 1;
      IF actual_repairs <> declared_repairs
        OR (actual_revisions=0 AND current_revision_id IS NOT NULL)
        OR (actual_revisions>0 AND current_revision_id IS DISTINCT FROM latest_revision_id) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_TASK_REVISION_STATE_MISMATCH';
      END IF;
      RETURN NEW;
    END $$;
    CREATE CONSTRAINT TRIGGER test_execution_tasks_revisions_ck
      AFTER INSERT OR UPDATE ON smarthub.test_execution_tasks
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION smarthub.validate_test_execution_task_revisions();
    CREATE CONSTRAINT TRIGGER test_execution_revisions_task_ck
      AFTER INSERT ON smarthub.test_execution_script_revisions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION smarthub.validate_test_execution_task_revisions();
    ALTER TABLE smarthub.test_execution_artifacts
      ADD CONSTRAINT test_execution_artifacts_attempt_fk
      FOREIGN KEY (attempt_id, run_id, task_id) REFERENCES smarthub.test_execution_attempts(id, run_id, task_id) ON DELETE RESTRICT;

    CREATE TABLE IF NOT EXISTS smarthub.test_execution_diagnoses (
      id text PRIMARY KEY,
      run_id text NOT NULL REFERENCES smarthub.test_execution_runs(id) ON DELETE RESTRICT,
      task_id text NOT NULL REFERENCES smarthub.test_execution_tasks(id) ON DELETE RESTRICT,
      script_revision_id text NOT NULL,
      attempt_count integer NOT NULL CHECK (attempt_count > 0),
      evidence_count integer NOT NULL CHECK (evidence_count > 0),
      category text NOT NULL CHECK (category IN ('product_defect','script_defect','selector_changed','environment_defect','test_data_defect','flaky','assertion_mismatch','timeout','unknown')),
      confidence double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
      summary text NOT NULL,
      repairable boolean NOT NULL,
      recommended_action text NOT NULL,
      source text NOT NULL CHECK (source IN ('agent','deterministic')),
      agent_snapshot jsonb,
      created_at timestamptz NOT NULL,
      UNIQUE (id, run_id, task_id),
      UNIQUE (id, run_id, task_id, script_revision_id),
      FOREIGN KEY (task_id, run_id) REFERENCES smarthub.test_execution_tasks(id, run_id) ON DELETE RESTRICT,
      FOREIGN KEY (script_revision_id, run_id, task_id) REFERENCES smarthub.test_execution_script_revisions(id, run_id, task_id) ON DELETE RESTRICT,
      CHECK ((source = 'agent') = (agent_snapshot IS NOT NULL)),
      CHECK (agent_snapshot IS NULL OR agent_snapshot->>'agentKey' = 'failure-analysis')
    );
    CREATE INDEX IF NOT EXISTS test_execution_diagnoses_task_idx ON smarthub.test_execution_diagnoses (task_id, created_at, id);
    CREATE OR REPLACE FUNCTION smarthub.validate_test_execution_diagnosis_insert()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.source='agent' AND NOT EXISTS (
        SELECT 1 FROM smarthub.test_execution_runs run
        WHERE run.id=NEW.run_id
          AND run.snapshot->'agents'->'failureAnalysis'=NEW.agent_snapshot
      ) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_DIAGNOSIS_AGENT_MISMATCH';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_execution_diagnoses_insert_ck
      BEFORE INSERT ON smarthub.test_execution_diagnoses
      FOR EACH ROW EXECUTE FUNCTION smarthub.validate_test_execution_diagnosis_insert();

    CREATE TABLE IF NOT EXISTS smarthub.test_execution_diagnosis_attempts (
      diagnosis_id text NOT NULL,
      run_id text NOT NULL,
      task_id text NOT NULL,
      script_revision_id text NOT NULL,
      attempt_id text NOT NULL,
      ordinal integer NOT NULL CHECK (ordinal >= 0),
      PRIMARY KEY (diagnosis_id, attempt_id),
      UNIQUE (diagnosis_id, ordinal),
      FOREIGN KEY (diagnosis_id, run_id, task_id, script_revision_id) REFERENCES smarthub.test_execution_diagnoses(id, run_id, task_id, script_revision_id) ON DELETE RESTRICT,
      FOREIGN KEY (attempt_id, run_id, task_id, script_revision_id) REFERENCES smarthub.test_execution_attempts(id, run_id, task_id, script_revision_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS test_execution_diagnosis_attempts_attempt_idx ON smarthub.test_execution_diagnosis_attempts (attempt_id, diagnosis_id);

    CREATE OR REPLACE FUNCTION smarthub.validate_test_execution_diagnosis_attempt_terminal()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target_attempt_id text;
    BEGIN
      target_attempt_id := CASE
        WHEN TG_TABLE_NAME='test_execution_attempts'
          THEN CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END
        ELSE CASE WHEN TG_OP='DELETE' THEN OLD.attempt_id ELSE NEW.attempt_id END
      END;
      IF EXISTS (
        SELECT 1
        FROM smarthub.test_execution_diagnosis_attempts diagnosis_attempt
        JOIN smarthub.test_execution_attempts attempt
          ON attempt.id=diagnosis_attempt.attempt_id
        WHERE diagnosis_attempt.attempt_id=target_attempt_id
          AND attempt.status='running'
      ) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_DIAGNOSIS_ATTEMPT_NOT_TERMINAL';
      END IF;
      RETURN NEW;
    END $$;
    CREATE CONSTRAINT TRIGGER test_execution_diagnosis_attempts_terminal_ck
      AFTER INSERT OR UPDATE ON smarthub.test_execution_diagnosis_attempts
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION smarthub.validate_test_execution_diagnosis_attempt_terminal();
    CREATE CONSTRAINT TRIGGER test_execution_attempts_diagnosis_terminal_ck
      AFTER INSERT OR UPDATE ON smarthub.test_execution_attempts
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION smarthub.validate_test_execution_diagnosis_attempt_terminal();

    CREATE TABLE IF NOT EXISTS smarthub.test_execution_diagnosis_evidence (
      diagnosis_id text NOT NULL,
      run_id text NOT NULL,
      task_id text NOT NULL,
      script_revision_id text NOT NULL,
      ordinal integer NOT NULL CHECK (ordinal >= 0),
      attempt_id text NOT NULL,
      artifact_id text,
      observation text NOT NULL,
      PRIMARY KEY (diagnosis_id, ordinal),
      FOREIGN KEY (diagnosis_id, run_id, task_id, script_revision_id) REFERENCES smarthub.test_execution_diagnoses(id, run_id, task_id, script_revision_id) ON DELETE RESTRICT,
      FOREIGN KEY (diagnosis_id, attempt_id) REFERENCES smarthub.test_execution_diagnosis_attempts(diagnosis_id, attempt_id) ON DELETE RESTRICT,
      FOREIGN KEY (attempt_id, run_id, task_id, script_revision_id) REFERENCES smarthub.test_execution_attempts(id, run_id, task_id, script_revision_id) ON DELETE RESTRICT,
      FOREIGN KEY (artifact_id, run_id, task_id, attempt_id) REFERENCES smarthub.test_execution_artifacts(id, run_id, task_id, attempt_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS test_execution_diagnosis_evidence_attempt_idx ON smarthub.test_execution_diagnosis_evidence (attempt_id, diagnosis_id);

    CREATE OR REPLACE FUNCTION smarthub.validate_test_execution_diagnosis_children()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target_ids text[];
    DECLARE target_id text;
    DECLARE expected_attempts integer;
    DECLARE expected_evidence integer;
    BEGIN
      IF TG_TABLE_NAME = 'test_execution_diagnoses' THEN
        IF TG_OP = 'INSERT' THEN target_ids := ARRAY[NEW.id];
        ELSIF TG_OP = 'UPDATE' THEN target_ids := ARRAY[OLD.id,NEW.id];
        ELSE target_ids := ARRAY[OLD.id];
        END IF;
      ELSE
        IF TG_OP = 'INSERT' THEN target_ids := ARRAY[NEW.diagnosis_id];
        ELSIF TG_OP = 'UPDATE' THEN target_ids := ARRAY[OLD.diagnosis_id,NEW.diagnosis_id];
        ELSE target_ids := ARRAY[OLD.diagnosis_id];
        END IF;
      END IF;
      FOREACH target_id IN ARRAY target_ids LOOP
        SELECT attempt_count,evidence_count INTO expected_attempts,expected_evidence
        FROM smarthub.test_execution_diagnoses WHERE id=target_id;
        IF NOT FOUND THEN CONTINUE; END IF;
        IF (SELECT count(*) FROM smarthub.test_execution_diagnosis_attempts WHERE diagnosis_id=target_id) <> expected_attempts
          OR (SELECT count(*) FROM smarthub.test_execution_diagnosis_evidence WHERE diagnosis_id=target_id) <> expected_evidence THEN
          RAISE EXCEPTION 'TEST_EXECUTION_DIAGNOSIS_CHILD_COUNT_MISMATCH';
        END IF;
      END LOOP;
      RETURN NEW;
    END $$;
    CREATE CONSTRAINT TRIGGER test_execution_diagnoses_children_ck
      AFTER INSERT OR UPDATE ON smarthub.test_execution_diagnoses
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION smarthub.validate_test_execution_diagnosis_children();
    CREATE CONSTRAINT TRIGGER test_execution_diagnosis_attempts_parent_ck
      AFTER INSERT OR UPDATE OR DELETE ON smarthub.test_execution_diagnosis_attempts
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION smarthub.validate_test_execution_diagnosis_children();
    CREATE CONSTRAINT TRIGGER test_execution_diagnosis_evidence_parent_ck
      AFTER INSERT OR UPDATE OR DELETE ON smarthub.test_execution_diagnosis_evidence
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION smarthub.validate_test_execution_diagnosis_children();

    CREATE TABLE IF NOT EXISTS smarthub.test_execution_case_maintenance_proposals (
      id text PRIMARY KEY,
      run_id text NOT NULL REFERENCES smarthub.test_execution_runs(id) ON DELETE RESTRICT,
      task_id text NOT NULL REFERENCES smarthub.test_execution_tasks(id) ON DELETE RESTRICT,
      case_id text NOT NULL REFERENCES smarthub.library_test_cases(id) ON DELETE RESTRICT,
      case_revision integer NOT NULL,
      diagnosis_id text NOT NULL REFERENCES smarthub.test_execution_diagnoses(id) ON DELETE RESTRICT,
      script_revision_id text NOT NULL,
      status text NOT NULL CHECK (status IN ('pending','accepted','rejected')),
      summary text NOT NULL,
      proposed_change text NOT NULL,
      baseline_library_version_id text NOT NULL REFERENCES smarthub.test_case_library_versions(id) ON DELETE RESTRICT,
      baseline_library_version_sha256 char(64) NOT NULL,
      promoted_case_change_proposal_id text REFERENCES smarthub.case_change_proposals(id) ON DELETE RESTRICT,
      decided_by text,
      decided_at timestamptz,
      created_at timestamptz NOT NULL,
      FOREIGN KEY (case_id, case_revision) REFERENCES smarthub.library_test_case_revisions(case_id, revision) ON DELETE RESTRICT,
      FOREIGN KEY (task_id, run_id, case_id, case_revision) REFERENCES smarthub.test_execution_tasks(id, run_id, case_id, case_revision) ON DELETE RESTRICT,
      FOREIGN KEY (diagnosis_id, run_id, task_id, script_revision_id) REFERENCES smarthub.test_execution_diagnoses(id, run_id, task_id, script_revision_id) ON DELETE RESTRICT,
      FOREIGN KEY (script_revision_id, run_id, task_id) REFERENCES smarthub.test_execution_script_revisions(id, run_id, task_id) ON DELETE RESTRICT,
      FOREIGN KEY (run_id, baseline_library_version_id, baseline_library_version_sha256) REFERENCES smarthub.test_execution_runs(id, test_case_library_version_id, test_case_library_version_sha256) ON DELETE RESTRICT,
      CHECK (
        (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL)
        OR (status IN ('accepted','rejected') AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
      ),
      CHECK (promoted_case_change_proposal_id IS NULL OR status = 'accepted')
    );
    CREATE INDEX IF NOT EXISTS test_execution_maintenance_run_idx ON smarthub.test_execution_case_maintenance_proposals (run_id, status, created_at, id);
    CREATE OR REPLACE FUNCTION smarthub.validate_test_execution_maintenance_proposal_update()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF ROW(
        NEW.run_id,NEW.task_id,NEW.case_id,NEW.case_revision,NEW.diagnosis_id,
        NEW.script_revision_id,NEW.summary,NEW.proposed_change,
        NEW.baseline_library_version_id,NEW.baseline_library_version_sha256,NEW.created_at
      ) IS DISTINCT FROM ROW(
        OLD.run_id,OLD.task_id,OLD.case_id,OLD.case_revision,OLD.diagnosis_id,
        OLD.script_revision_id,OLD.summary,OLD.proposed_change,
        OLD.baseline_library_version_id,OLD.baseline_library_version_sha256,OLD.created_at
      ) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_MAINTENANCE_PROPOSAL_IMMUTABLE';
      END IF;
      IF OLD.status='pending' THEN
        IF NEW.status NOT IN ('accepted','rejected')
          OR NEW.promoted_case_change_proposal_id IS NOT NULL THEN
          RAISE EXCEPTION 'TEST_EXECUTION_MAINTENANCE_DECISION_INVALID';
        END IF;
      ELSIF OLD.status='accepted' THEN
        IF NEW.status <> 'accepted'
          OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
          OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
          OR OLD.promoted_case_change_proposal_id IS NOT NULL
          OR NEW.promoted_case_change_proposal_id IS NULL THEN
          RAISE EXCEPTION 'TEST_EXECUTION_MAINTENANCE_PROMOTION_INVALID';
        END IF;
      ELSE
        RAISE EXCEPTION 'TEST_EXECUTION_MAINTENANCE_PROPOSAL_IMMUTABLE';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_execution_maintenance_proposals_update_ck
      BEFORE UPDATE ON smarthub.test_execution_case_maintenance_proposals
      FOR EACH ROW EXECUTE FUNCTION smarthub.validate_test_execution_maintenance_proposal_update();

    CREATE OR REPLACE FUNCTION smarthub.reject_test_execution_history_update()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'TEST_EXECUTION_HISTORY_IMMUTABLE';
    END $$;
    CREATE TRIGGER test_execution_artifacts_immutable_ck
      BEFORE UPDATE OR DELETE ON smarthub.test_execution_artifacts
      FOR EACH ROW EXECUTE FUNCTION smarthub.reject_test_execution_history_update();
    CREATE TRIGGER test_execution_script_artifacts_immutable_ck
      BEFORE UPDATE OR DELETE ON smarthub.test_execution_script_artifacts
      FOR EACH ROW EXECUTE FUNCTION smarthub.reject_test_execution_history_update();
    CREATE TRIGGER test_execution_script_revisions_immutable_ck
      BEFORE UPDATE OR DELETE ON smarthub.test_execution_script_revisions
      FOR EACH ROW EXECUTE FUNCTION smarthub.reject_test_execution_history_update();
    CREATE TRIGGER test_execution_diagnoses_immutable_ck
      BEFORE UPDATE OR DELETE ON smarthub.test_execution_diagnoses
      FOR EACH ROW EXECUTE FUNCTION smarthub.reject_test_execution_history_update();
    CREATE TRIGGER test_execution_diagnosis_attempts_immutable_ck
      BEFORE UPDATE OR DELETE ON smarthub.test_execution_diagnosis_attempts
      FOR EACH ROW EXECUTE FUNCTION smarthub.reject_test_execution_history_update();
    CREATE TRIGGER test_execution_diagnosis_evidence_immutable_ck
      BEFORE UPDATE OR DELETE ON smarthub.test_execution_diagnosis_evidence
      FOR EACH ROW EXECUTE FUNCTION smarthub.reject_test_execution_history_update();
    CREATE TRIGGER test_execution_maintenance_proposals_delete_ck
      BEFORE DELETE ON smarthub.test_execution_case_maintenance_proposals
      FOR EACH ROW EXECUTE FUNCTION smarthub.reject_test_execution_history_update();
  `,
}, {
  version: 29,
  name: 'test-execution-maintenance-proposal-workflow',
  sql: `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM smarthub.test_execution_case_maintenance_proposals proposal
        LEFT JOIN smarthub.test_execution_diagnoses diagnosis
          ON diagnosis.id=proposal.diagnosis_id
         AND diagnosis.run_id=proposal.run_id
         AND diagnosis.task_id=proposal.task_id
        LEFT JOIN smarthub.test_execution_script_revisions repair
          ON repair.id=proposal.script_revision_id
         AND repair.run_id=proposal.run_id
         AND repair.task_id=proposal.task_id
        LEFT JOIN smarthub.test_execution_script_revisions original
          ON original.id=diagnosis.script_revision_id
         AND original.run_id=proposal.run_id
         AND original.task_id=proposal.task_id
        WHERE diagnosis.id IS NULL
          OR diagnosis.category NOT IN ('script_defect','selector_changed')
          OR repair.id IS NULL
          OR repair.generation_source <> 'repair'
          OR repair.parent_revision_id IS DISTINCT FROM diagnosis.script_revision_id
          OR repair.protected_assertion_sha256 IS DISTINCT FROM original.protected_assertion_sha256
          OR repair.protected_assertions_canonical IS DISTINCT FROM original.protected_assertions_canonical
          OR NOT EXISTS (
            SELECT 1 FROM smarthub.test_execution_attempts attempt
            WHERE attempt.run_id=proposal.run_id
              AND attempt.task_id=proposal.task_id
              AND attempt.script_revision_id=proposal.script_revision_id
              AND attempt.attempt_kind='post_repair'
              AND attempt.status='passed'
          )
      ) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_MAINTENANCE_EXISTING_HISTORY_INVALID';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM smarthub.test_execution_case_maintenance_proposals
        GROUP BY task_id,diagnosis_id,script_revision_id
        HAVING count(*) > 1
      ) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_MAINTENANCE_EXISTING_HISTORY_DUPLICATED';
      END IF;
    END $$;

    DO $$
    DECLARE constraint_name text;
    BEGIN
      SELECT con.conname INTO constraint_name
      FROM pg_constraint con
      WHERE con.conrelid='smarthub.test_execution_case_maintenance_proposals'::regclass
        AND con.contype='f'
        AND pg_get_constraintdef(con.oid) LIKE 'FOREIGN KEY (diagnosis_id, run_id, task_id, script_revision_id)%';
      IF constraint_name IS NULL THEN
        RAISE EXCEPTION 'TEST_EXECUTION_MAINTENANCE_DIAGNOSIS_FK_NOT_FOUND';
      END IF;
      EXECUTE format(
        'ALTER TABLE smarthub.test_execution_case_maintenance_proposals DROP CONSTRAINT %I',
        constraint_name
      );
    END $$;

    ALTER TABLE smarthub.test_execution_case_maintenance_proposals
      ADD CONSTRAINT test_execution_maintenance_diagnosis_scope_fk
      FOREIGN KEY (diagnosis_id,run_id,task_id)
      REFERENCES smarthub.test_execution_diagnoses(id,run_id,task_id)
      ON DELETE RESTRICT,
      ADD CONSTRAINT test_execution_maintenance_business_key_uq
      UNIQUE (task_id,diagnosis_id,script_revision_id);

    CREATE OR REPLACE FUNCTION smarthub.validate_test_execution_maintenance_proposal_insert()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status <> 'pending'
        OR NEW.decided_by IS NOT NULL
        OR NEW.decided_at IS NOT NULL
        OR NEW.promoted_case_change_proposal_id IS NOT NULL
        OR NOT EXISTS (
          SELECT 1
          FROM smarthub.test_execution_tasks task
          JOIN smarthub.test_execution_runs run ON run.id=task.run_id
          JOIN smarthub.test_execution_diagnoses diagnosis
            ON diagnosis.id=NEW.diagnosis_id
           AND diagnosis.run_id=task.run_id
           AND diagnosis.task_id=task.id
          JOIN smarthub.test_execution_script_revisions repair
            ON repair.id=NEW.script_revision_id
           AND repair.run_id=task.run_id
           AND repair.task_id=task.id
          JOIN smarthub.test_execution_script_revisions original
            ON original.id=diagnosis.script_revision_id
           AND original.run_id=task.run_id
           AND original.task_id=task.id
          WHERE task.id=NEW.task_id
            AND task.run_id=NEW.run_id
            AND task.case_id=NEW.case_id
            AND task.case_revision=NEW.case_revision
            AND task.current_script_revision_id=repair.id
            AND run.test_case_library_version_id=NEW.baseline_library_version_id
            AND run.test_case_library_version_sha256=NEW.baseline_library_version_sha256
            AND diagnosis.category IN ('script_defect','selector_changed')
            AND repair.generation_source='repair'
            AND repair.parent_revision_id=original.id
            AND repair.protected_assertion_sha256=original.protected_assertion_sha256
            AND repair.protected_assertions_canonical=original.protected_assertions_canonical
            AND EXISTS (
              SELECT 1 FROM smarthub.test_execution_attempts attempt
              WHERE attempt.run_id=task.run_id
                AND attempt.task_id=task.id
                AND attempt.script_revision_id=repair.id
                AND attempt.attempt_kind='post_repair'
                AND attempt.status='passed'
            )
        ) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_MAINTENANCE_PROPOSAL_FACTS_INVALID';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_execution_maintenance_proposals_insert_ck
      BEFORE INSERT ON smarthub.test_execution_case_maintenance_proposals
      FOR EACH ROW EXECUTE FUNCTION smarthub.validate_test_execution_maintenance_proposal_insert();

    CREATE OR REPLACE FUNCTION smarthub.validate_test_execution_maintenance_proposal_update()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.status <> 'pending'
        OR NEW.status NOT IN ('accepted','rejected')
        OR NEW.status=OLD.status
        OR NEW.decided_by IS NULL
        OR NEW.decided_at IS NULL
        OR NEW.promoted_case_change_proposal_id IS NOT NULL
        OR ROW(
          NEW.id,NEW.run_id,NEW.task_id,NEW.case_id,NEW.case_revision,
          NEW.diagnosis_id,NEW.script_revision_id,NEW.summary,NEW.proposed_change,
          NEW.baseline_library_version_id,NEW.baseline_library_version_sha256,
          NEW.promoted_case_change_proposal_id,NEW.created_at
        ) IS DISTINCT FROM ROW(
          OLD.id,OLD.run_id,OLD.task_id,OLD.case_id,OLD.case_revision,
          OLD.diagnosis_id,OLD.script_revision_id,OLD.summary,OLD.proposed_change,
          OLD.baseline_library_version_id,OLD.baseline_library_version_sha256,
          OLD.promoted_case_change_proposal_id,OLD.created_at
        ) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_MAINTENANCE_PROPOSAL_IMMUTABLE';
      END IF;
      RETURN NEW;
    END $$;
  `,
}, {
  version: 30,
  name: 'remove-test-point-tree-assets',
  sql: `
    DROP TABLE IF EXISTS smarthub.library_test_case_revision_test_point_refs;
    ALTER TABLE smarthub.test_cases DROP COLUMN IF EXISTS tree_version_id;
    DROP TABLE IF EXISTS smarthub.test_point_trees CASCADE;

    UPDATE smarthub.test_design_state
    SET data = jsonb_set(
      data,
      '{runs}',
      COALESCE((
        SELECT jsonb_agg(run - 'testPointTree')
        FROM jsonb_array_elements(data->'runs') AS run
      ), '[]'::jsonb),
      true
    );
  `,
}, {
  version: 31,
  name: 'freeze-test-data-input-in-script-cache',
  sql: `
    ALTER TABLE smarthub.test_execution_script_artifacts
      ADD COLUMN IF NOT EXISTS task_input_sha256 char(64);
  `,
}, {
  version: 32,
  name: 'fix-test-execution-cross-table-trigger-record-access',
  sql: `
    CREATE OR REPLACE FUNCTION smarthub.validate_test_execution_aggregate_completeness()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target_run_id text;
    DECLARE declared_tasks integer;
    DECLARE actual_tasks integer;
    DECLARE executable_tasks integer;
    DECLARE actual_jobs integer;
    DECLARE run_status text;
    DECLARE run_state_version integer;
    DECLARE aggregate_status text;
    DECLARE initial_tasks boolean;
    BEGIN
      IF TG_TABLE_NAME = 'test_execution_runs' THEN
        target_run_id := NEW.id;
      ELSIF TG_TABLE_NAME IN ('test_execution_tasks', 'test_execution_jobs') THEN
        IF TG_OP = 'DELETE' THEN
          target_run_id := OLD.run_id;
        ELSE
          target_run_id := NEW.run_id;
        END IF;
      ELSE
        RAISE EXCEPTION 'TEST_EXECUTION_AGGREGATE_TRIGGER_TABLE_UNSUPPORTED: %', TG_TABLE_NAME;
      END IF;
      SELECT task_count,status,state_version
        INTO declared_tasks,run_status,run_state_version
      FROM smarthub.test_execution_runs WHERE id=target_run_id;
      IF NOT FOUND THEN RETURN NEW; END IF;
      SELECT count(*),count(*) FILTER (WHERE status <> 'unsupported'),
        CASE
          WHEN bool_or(status NOT IN ('passed','failed','blocked','unsupported','waiting_manual','cancelled')) THEN 'running'
          WHEN bool_and(status='cancelled') THEN 'cancelled'
          WHEN bool_and(status='passed') THEN 'succeeded'
          WHEN bool_and(status='failed') THEN 'failed'
          ELSE 'partial'
        END,
        bool_and(state_version=0 AND status IN ('pending','unsupported'))
        INTO actual_tasks,executable_tasks,aggregate_status,initial_tasks
      FROM smarthub.test_execution_tasks WHERE run_id=target_run_id;
      SELECT count(DISTINCT task_id) INTO actual_jobs
      FROM smarthub.test_execution_jobs WHERE run_id=target_run_id;
      IF actual_tasks <> declared_tasks OR actual_jobs <> executable_tasks THEN
        RAISE EXCEPTION 'TEST_EXECUTION_AGGREGATE_INCOMPLETE';
      END IF;
      IF NOT (
        (run_status='queued' AND run_state_version=0 AND initial_tasks)
        OR (run_status='running' AND aggregate_status='running')
        OR (run_status IN ('succeeded','failed','partial','cancelled') AND run_status=aggregate_status)
      ) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_RUN_TASK_STATUS_MISMATCH';
      END IF;
      RETURN NEW;
    END $$;

    CREATE OR REPLACE FUNCTION smarthub.validate_test_execution_task_attempts()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target_task_id text;
    DECLARE task_status text;
    DECLARE declared_attempts integer;
    DECLARE declared_retries integer;
    DECLARE actual_attempts integer;
    DECLARE actual_retries integer;
    DECLARE running_attempts integer;
    BEGIN
      IF TG_TABLE_NAME = 'test_execution_tasks' THEN
        target_task_id := NEW.id;
      ELSIF TG_TABLE_NAME = 'test_execution_attempts' THEN
        target_task_id := NEW.task_id;
      ELSE
        RAISE EXCEPTION 'TEST_EXECUTION_TASK_ATTEMPTS_TRIGGER_TABLE_UNSUPPORTED: %', TG_TABLE_NAME;
      END IF;
      SELECT status,runner_attempt_count,same_script_retry_count
        INTO task_status,declared_attempts,declared_retries
      FROM smarthub.test_execution_tasks WHERE id=target_task_id;
      IF NOT FOUND THEN RETURN NEW; END IF;
      SELECT count(*),
             count(*) FILTER (WHERE attempt_kind='same_script_retry'),
             count(*) FILTER (WHERE status='running')
        INTO actual_attempts,actual_retries,running_attempts
      FROM smarthub.test_execution_attempts WHERE task_id=target_task_id;
      IF actual_attempts <> declared_attempts
        OR actual_retries <> declared_retries
        OR (task_status='running' AND running_attempts <> 1)
        OR (task_status<>'running' AND running_attempts <> 0) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_TASK_ATTEMPT_STATE_MISMATCH';
      END IF;
      RETURN NEW;
    END $$;

    CREATE OR REPLACE FUNCTION smarthub.validate_test_execution_task_revisions()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target_task_id text;
    DECLARE current_revision_id text;
    DECLARE declared_repairs integer;
    DECLARE actual_revisions integer;
    DECLARE actual_repairs integer;
    DECLARE latest_revision_id text;
    BEGIN
      IF TG_TABLE_NAME = 'test_execution_tasks' THEN
        target_task_id := NEW.id;
      ELSIF TG_TABLE_NAME = 'test_execution_script_revisions' THEN
        target_task_id := NEW.task_id;
      ELSE
        RAISE EXCEPTION 'TEST_EXECUTION_TASK_REVISIONS_TRIGGER_TABLE_UNSUPPORTED: %', TG_TABLE_NAME;
      END IF;
      SELECT current_script_revision_id,repair_count
        INTO current_revision_id,declared_repairs
      FROM smarthub.test_execution_tasks WHERE id=target_task_id;
      IF NOT FOUND THEN RETURN NEW; END IF;
      SELECT count(*),count(*) FILTER (WHERE generation_source='repair')
        INTO actual_revisions,actual_repairs
      FROM smarthub.test_execution_script_revisions WHERE task_id=target_task_id;
      SELECT id INTO latest_revision_id
      FROM smarthub.test_execution_script_revisions
      WHERE task_id=target_task_id ORDER BY revision DESC LIMIT 1;
      IF actual_repairs <> declared_repairs
        OR (actual_revisions=0 AND current_revision_id IS NOT NULL)
        OR (actual_revisions>0 AND current_revision_id IS DISTINCT FROM latest_revision_id) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_TASK_REVISION_STATE_MISMATCH';
      END IF;
      RETURN NEW;
    END $$;

    CREATE OR REPLACE FUNCTION smarthub.validate_test_execution_diagnosis_attempt_terminal()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target_attempt_id text;
    BEGIN
      IF TG_TABLE_NAME = 'test_execution_attempts' THEN
        target_attempt_id := NEW.id;
      ELSIF TG_TABLE_NAME = 'test_execution_diagnosis_attempts' THEN
        target_attempt_id := NEW.attempt_id;
      ELSE
        RAISE EXCEPTION 'TEST_EXECUTION_DIAGNOSIS_ATTEMPT_TRIGGER_TABLE_UNSUPPORTED: %', TG_TABLE_NAME;
      END IF;
      IF EXISTS (
        SELECT 1
        FROM smarthub.test_execution_diagnosis_attempts diagnosis_attempt
        JOIN smarthub.test_execution_attempts attempt
          ON attempt.id=diagnosis_attempt.attempt_id
        WHERE diagnosis_attempt.attempt_id=target_attempt_id
          AND attempt.status='running'
      ) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_DIAGNOSIS_ATTEMPT_NOT_TERMINAL';
      END IF;
      RETURN NEW;
    END $$;
  `,
}, {
  version: 33,
  name: 'bind-test-case-library-version-to-project-version',
  sql: `
    ALTER TABLE smarthub.test_case_library_versions
      ADD COLUMN IF NOT EXISTS project_version_id text REFERENCES smarthub.project_versions(id) ON DELETE RESTRICT;
    UPDATE smarthub.test_case_library_versions library_version
      SET project_version_id=project_version.id
      FROM smarthub.workflow_runs run
      JOIN smarthub.project_versions project_version ON project_version.id=run.project_version_id
      WHERE library_version.source_run_id=run.id
        AND project_version.project_id=library_version.project_id
        AND library_version.project_version_id IS NULL;
    UPDATE smarthub.test_case_library_versions library_version
      SET project_version_id=legacy_version.project_version_id
      FROM smarthub.test_case_set_versions legacy_version
      WHERE library_version.legacy_test_case_set_version_id=legacy_version.id
        AND legacy_version.project_id=library_version.project_id
        AND library_version.project_version_id IS NULL;
    UPDATE smarthub.test_case_library_versions library_version
      SET project_version_id=only_project_version.id
      FROM (
        SELECT project_id, min(id) AS id
        FROM smarthub.project_versions
        GROUP BY project_id
        HAVING count(*)=1
      ) only_project_version
      WHERE only_project_version.project_id=library_version.project_id
        AND library_version.project_version_id IS NULL;
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM smarthub.test_case_library_versions
        WHERE project_version_id IS NULL
      ) THEN
        RAISE EXCEPTION 'TEST_CASE_LIBRARY_VERSION_PROJECT_VERSION_BACKFILL_UNRESOLVED';
      END IF;
    END $$;
    ALTER TABLE smarthub.test_case_library_versions
      ALTER COLUMN project_version_id SET NOT NULL;
    ALTER TABLE smarthub.test_case_library_versions
      DROP CONSTRAINT IF EXISTS test_case_library_versions_project_id_version_key;
    ALTER TABLE smarthub.test_case_library_versions
      ADD CONSTRAINT test_case_library_versions_project_version_version_key UNIQUE (project_version_id, version);
    CREATE INDEX IF NOT EXISTS test_case_library_versions_project_version_published_idx
      ON smarthub.test_case_library_versions (project_version_id, published_at DESC, id DESC);
  `,
}, {
  version: 34,
  name: 'test-execution-infrastructure-configuration-versions',
  sql: `
    CREATE TABLE IF NOT EXISTS smarthub.test_execution_infrastructure_configuration_versions (
      id text PRIMARY KEY,
      version integer NOT NULL UNIQUE,
      status text NOT NULL,
      created_at timestamptz NOT NULL,
      data jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS test_execution_infrastructure_configuration_active_idx
      ON smarthub.test_execution_infrastructure_configuration_versions (status, version DESC);
  `,
}, {
  version: 35,
  name: 'freeze-test-execution-workspace-dependency-closure',
  sql: `
    ALTER TABLE smarthub.test_execution_script_revisions
      ADD COLUMN IF NOT EXISTS source_artifacts jsonb;
    UPDATE smarthub.test_execution_script_revisions
      SET source_artifacts=jsonb_build_array(jsonb_build_object(
        'path', package_manifest->>'entrypoint',
        'artifactId', source_artifact_id
      ))
      WHERE source_artifacts IS NULL;
    ALTER TABLE smarthub.test_execution_script_revisions
      ALTER COLUMN source_artifacts SET NOT NULL;
    ALTER TABLE smarthub.test_execution_script_revisions
      DROP CONSTRAINT IF EXISTS test_execution_script_revisions_task_id_content_sha256_key;
    ALTER TABLE smarthub.test_execution_script_revisions
      ADD CONSTRAINT test_execution_script_revisions_task_package_key
      UNIQUE (task_id, package_sha256);

    CREATE OR REPLACE FUNCTION smarthub.validate_test_execution_script_revision_insert()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE previous_revision integer;
    DECLARE parent_protected_assertion_sha256 char(64);
    DECLARE parent_assertions jsonb;
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM smarthub.test_execution_tasks task
        JOIN smarthub.test_execution_runs run ON run.id=task.run_id
        JOIN smarthub.test_execution_script_artifacts artifact ON artifact.id=NEW.script_artifact_id
        JOIN smarthub.test_execution_artifacts source
          ON source.id=NEW.source_artifact_id
         AND source.run_id=NEW.run_id
         AND source.task_id=NEW.task_id
         AND source.sha256=NEW.content_sha256
        WHERE task.id=NEW.task_id AND task.run_id=NEW.run_id
          AND artifact.case_id=task.case_id
          AND artifact.case_revision=task.case_revision
          AND artifact.method=task.method
          AND artifact.case_content_sha256=task.case_content_sha256
          AND artifact.execution_spec_sha256=task.execution_spec_sha256
          AND artifact.environment_signature=run.environment_signature
          AND artifact.test_script_agent_version=(run.snapshot #>> '{agents,testScript,configurationVersion}')::integer
          AND artifact.test_script_agent_configuration_sha256=run.snapshot #>> '{agents,testScript,configurationSha256}'
          AND NEW.generated_by=CASE
            WHEN NEW.generation_source='repair' THEN run.snapshot->'agents'->'scriptRepair'
            ELSE run.snapshot->'agents'->'testScript'
          END
          AND NEW.package_manifest->>'taskId'=task.id
          AND NEW.package_manifest->>'caseId'=task.case_id
          AND (NEW.package_manifest->>'caseRevision')::integer=task.case_revision
          AND NEW.package_manifest->>'method'=task.method
          AND NEW.package_manifest->>'taskInputSha256'=task.input_sha256
          AND NEW.package_manifest->>'caseContentSha256'=task.case_content_sha256
          AND NEW.package_manifest->>'executionSpecSha256'=task.execution_spec_sha256
          AND NEW.package_manifest->>'environmentSignature'=run.environment_signature
          AND NEW.package_manifest->>'entrypoint' ~ '^tests/[A-Za-z0-9._/-]+\\.tsx?$'
          AND position('..' in NEW.package_manifest->>'entrypoint')=0
          AND jsonb_typeof(NEW.package_manifest->'files')='array'
          AND jsonb_array_length(NEW.package_manifest->'files') BETWEEN 1 AND 100
          AND jsonb_typeof(NEW.source_artifacts)='array'
          AND jsonb_array_length(NEW.source_artifacts)=jsonb_array_length(NEW.package_manifest->'files')
          AND NEW.source_artifact_id=(
            SELECT source_reference.value->>'artifactId'
            FROM jsonb_array_elements(NEW.source_artifacts) WITH ORDINALITY source_reference(value, ordinal)
            WHERE source_reference.value->>'path'=NEW.package_manifest->>'entrypoint'
            LIMIT 1
          )
          AND NEW.package_manifest->>'packageSha256'=NEW.package_sha256
          AND NEW.package_canonical::jsonb=NEW.package_manifest-'packageSha256'
          AND encode(digest(convert_to(NEW.package_canonical, 'UTF8'), 'sha256'), 'hex')=NEW.package_sha256
          AND NEW.package_manifest->>'protectedAssertionSha256'=NEW.protected_assertion_sha256
          AND jsonb_typeof(NEW.package_manifest->'assertions')='array'
          AND NEW.protected_assertions_canonical::jsonb=NEW.package_manifest->'assertions'
          AND encode(digest(convert_to(NEW.protected_assertions_canonical, 'UTF8'), 'sha256'), 'hex')=NEW.protected_assertion_sha256
          AND source.artifact_type='script'
          AND source.attempt_id IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(NEW.package_manifest->'files') WITH ORDINALITY manifest_file(value, ordinal)
            LEFT JOIN LATERAL jsonb_array_elements(NEW.source_artifacts) WITH ORDINALITY source_reference(value, ordinal)
              ON source_reference.ordinal=manifest_file.ordinal
            LEFT JOIN smarthub.test_execution_artifacts dependency
              ON dependency.id=source_reference.value->>'artifactId'
             AND dependency.run_id=NEW.run_id
             AND dependency.task_id=NEW.task_id
            WHERE source_reference.value->>'path' IS DISTINCT FROM manifest_file.value->>'path'
               OR dependency.id IS NULL
               OR dependency.artifact_type<>'script'
               OR dependency.attempt_id IS NOT NULL
               OR dependency.sha256 IS DISTINCT FROM manifest_file.value->>'contentSha256'
               OR dependency.byte_size IS DISTINCT FROM (manifest_file.value->>'size')::bigint
          )
      ) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_SCRIPT_REVISION_SOURCE_MISMATCH';
      END IF;
      IF NEW.generation_source='cache' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM smarthub.test_execution_script_revisions source_revision
          WHERE source_revision.id=NEW.cache_source_revision_id
            AND source_revision.script_artifact_id=NEW.script_artifact_id
            AND source_revision.generation_source<>'cache'
            AND source_revision.content_sha256=NEW.content_sha256
            AND source_revision.protected_assertion_sha256=NEW.protected_assertion_sha256
            AND source_revision.package_manifest->'files'=NEW.package_manifest->'files'
            AND source_revision.package_manifest->>'entrypoint'=NEW.package_manifest->>'entrypoint'
        ) THEN
          RAISE EXCEPTION 'TEST_EXECUTION_SCRIPT_CACHE_PROVENANCE_INVALID';
        END IF;
      ELSIF NEW.cache_source_revision_id IS NOT NULL THEN
        RAISE EXCEPTION 'TEST_EXECUTION_SCRIPT_CACHE_PROVENANCE_FORBIDDEN';
      END IF;
      IF NEW.generation_source='repair' THEN
        IF NEW.parent_revision_id IS NULL OR NEW.revision <= 1 THEN
          RAISE EXCEPTION 'TEST_EXECUTION_SCRIPT_REVISION_PARENT_INVALID';
        END IF;
        SELECT revision,protected_assertion_sha256,package_manifest->'assertions'
          INTO previous_revision,parent_protected_assertion_sha256,parent_assertions
        FROM smarthub.test_execution_script_revisions
        WHERE id=NEW.parent_revision_id AND run_id=NEW.run_id AND task_id=NEW.task_id;
        IF previous_revision IS DISTINCT FROM NEW.revision-1 THEN
          RAISE EXCEPTION 'TEST_EXECUTION_SCRIPT_REVISION_PARENT_INVALID';
        END IF;
        IF NEW.protected_assertion_sha256 IS DISTINCT FROM parent_protected_assertion_sha256
          OR NEW.package_manifest->'assertions' IS DISTINCT FROM parent_assertions THEN
          RAISE EXCEPTION 'TEST_EXECUTION_SCRIPT_REVISION_ASSERTIONS_CHANGED';
        END IF;
      ELSIF NEW.parent_revision_id IS NOT NULL OR NEW.revision <> 1 THEN
        RAISE EXCEPTION 'TEST_EXECUTION_SCRIPT_REVISION_PARENT_INVALID';
      END IF;
      RETURN NEW;
    END $$;
  `,
}, {
  version: 36,
  name: 'persist-structured-test-execution-events',
  sql: `
    CREATE TABLE IF NOT EXISTS smarthub.test_execution_events (
      id text PRIMARY KEY,
      run_id text NOT NULL,
      task_id text NOT NULL,
      attempt_id text NOT NULL,
      sequence integer NOT NULL CHECK (sequence > 0),
      event_type text NOT NULL CHECK (event_type IN ('runner','step','navigate','click','fill','assertion','http','screenshot','trace','video','failure','retry')),
      title text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
      status text NOT NULL CHECK (status IN ('running','passed','failed','skipped')),
      started_at timestamptz NOT NULL,
      finished_at timestamptz,
      duration_ms bigint CHECK (duration_ms IS NULL OR duration_ms >= 0),
      artifact_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(artifact_ids)='array'),
      metadata jsonb,
      UNIQUE (attempt_id, sequence),
      FOREIGN KEY (attempt_id, run_id, task_id)
        REFERENCES smarthub.test_execution_attempts(id, run_id, task_id)
        ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS test_execution_events_task_idx
      ON smarthub.test_execution_events (task_id, attempt_id, sequence);

    CREATE OR REPLACE FUNCTION smarthub.validate_test_execution_event_write()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'TEST_EXECUTION_EVENT_IMMUTABLE';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(NEW.artifact_ids) artifact_ref(id)
        LEFT JOIN smarthub.test_execution_artifacts artifact
          ON artifact.id=artifact_ref.id
         AND artifact.run_id=NEW.run_id
         AND artifact.task_id=NEW.task_id
         AND artifact.attempt_id=NEW.attempt_id
        WHERE artifact.id IS NULL
      ) OR (
        SELECT count(*) FROM jsonb_array_elements_text(NEW.artifact_ids)
      ) <> (
        SELECT count(DISTINCT value) FROM jsonb_array_elements_text(NEW.artifact_ids)
      ) THEN
        RAISE EXCEPTION 'TEST_EXECUTION_EVENT_ARTIFACT_SCOPE_INVALID';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS test_execution_events_write_ck ON smarthub.test_execution_events;
    CREATE TRIGGER test_execution_events_write_ck
      BEFORE INSERT OR UPDATE OR DELETE ON smarthub.test_execution_events
      FOR EACH ROW EXECUTE FUNCTION smarthub.validate_test_execution_event_write();
  `,
}, {
  version: 37,
  name: 'unify-test-execution-implementation-agent',
  sql: `
    DO $$
    DECLARE definition text;
    DECLARE updated_definition text;
    BEGIN
      definition := pg_get_functiondef(
        'smarthub.validate_test_execution_script_revision_insert()'::regprocedure
      );
      updated_definition := replace(
        replace(
          replace(
            replace(
              definition,
              '{agents,testScript,configurationVersion}',
              '{agents,executionImplementation,configurationVersion}'
            ),
            '{agents,testScript,configurationSha256}',
            '{agents,executionImplementation,configurationSha256}'
          ),
          'run.snapshot->''agents''->''scriptRepair''',
          'run.snapshot->''agents''->''executionImplementation'''
        ),
        'run.snapshot->''agents''->''testScript''',
        'run.snapshot->''agents''->''executionImplementation'''
      );
      IF updated_definition = definition THEN
        RAISE EXCEPTION 'TEST_EXECUTION_IMPLEMENTATION_AGENT_TRIGGER_MIGRATION_MISMATCH';
      END IF;
      EXECUTE updated_definition;
    END $$;

    CREATE OR REPLACE FUNCTION smarthub.validate_test_execution_run_agents_insert()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE agent_keys text[];
    BEGIN
      IF jsonb_typeof(NEW.snapshot->'agents') IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'TEST_EXECUTION_RUN_AGENT_SNAPSHOT_INVALID';
      END IF;
      SELECT array_agg(agent_key ORDER BY agent_key)
        INTO agent_keys
      FROM jsonb_object_keys(NEW.snapshot->'agents') AS agent_keys(agent_key);
      IF agent_keys IS DISTINCT FROM ARRAY['executionImplementation','failureAnalysis']::text[]
        OR NEW.snapshot #>> '{agents,executionImplementation,agentKey}' IS DISTINCT FROM 'execution-implementation'
        OR NEW.snapshot #>> '{agents,failureAnalysis,agentKey}' IS DISTINCT FROM 'failure-analysis'
      THEN
        RAISE EXCEPTION 'TEST_EXECUTION_RUN_AGENT_SNAPSHOT_INVALID';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS test_execution_runs_agents_insert_ck
      ON smarthub.test_execution_runs;
    CREATE TRIGGER test_execution_runs_agents_insert_ck
      BEFORE INSERT ON smarthub.test_execution_runs
      FOR EACH ROW EXECUTE FUNCTION smarthub.validate_test_execution_run_agents_insert();
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
