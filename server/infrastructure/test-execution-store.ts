import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { canonicalJson, canonicalSha256 } from '../application/canonical-json.js'
import {
  aggregateExecutionRunStatus,
  assertRunTransition,
  assertTaskTransition,
  executionCreateRequestCanonical,
  executionCreateRequestSha256,
  freezeExecutionTaskInput,
  scriptCacheKey,
  unsupportedExecutionMethodReason,
} from '../application/test-execution-validation.js'
import type {
  ExecutionArtifact,
  ExecutionAttempt,
  ExecutionJob,
  ExecutionRun,
  ExecutionRunStatus,
  ExecutionTask,
  ExecutionTaskStatus,
  FailureDiagnosis,
  ScriptArtifact,
  ScriptRevision,
} from '../domain/test-execution-types.js'
import type {
  ExecutionReadiness,
  TestCaseContent,
  TestCaseExecutionSpec,
  TestCaseLibraryVersionMemberDetail,
  TestCaseTraceability,
  TestDimension,
  TestExecutionHandoffMember,
  TestExecutionMethod,
  TestExecutionMode,
  TestSuiteVersionMember,
} from '../domain/test-design-types.js'

export interface ExecutionJobLease {
  workerId: string
  runToken: string
  fencingToken: number
}

interface ExecutionLeaseScope {
  runId: string
  taskId: string
}

export interface CreateExecutionAggregateInput {
  run: ExecutionRun
  tasks: ExecutionTask[]
  jobs: ExecutionJob[]
}

export interface TestExecutionTransaction {
  transitionTask(input: {
    taskId: string
    expectedStatus: ExecutionTaskStatus
    expectedStateVersion: number
    status: ExecutionTaskStatus
    currentScriptRevisionId?: string
    incrementRunnerAttempt?: boolean
    incrementSameScriptRetry?: boolean
    incrementRepair?: boolean
    unsupportedReason?: string
    error?: string
    finishedAt?: string
  }): Promise<ExecutionTask>
  appendArtifact(artifact: ExecutionArtifact): Promise<void>
  appendScriptArtifact(artifact: ScriptArtifact): Promise<ScriptArtifact>
  appendScriptRevision(revision: ScriptRevision): Promise<void>
  appendAttempt(attempt: ExecutionAttempt): Promise<void>
  finalizeAttempt(input: {
    attemptId: string
    status: Exclude<ExecutionAttempt['status'], 'running'>
    finishedAt: string
    durationMs: number
    exitCode?: number
    summary?: string
    error?: string
  }): Promise<ExecutionAttempt>
  appendDiagnosis(diagnosis: FailureDiagnosis): Promise<void>
  enqueueJob(job: ExecutionJob): Promise<void>
  recomputeRun(runId: string): Promise<ExecutionRun>
}

export interface ExecutionTaskDetailSnapshot {
  run: ExecutionRun
  task: ExecutionTask
  attempts: ExecutionAttempt[]
  diagnoses: FailureDiagnosis[]
  scriptRevisions: ScriptRevision[]
  artifacts: ExecutionArtifact[]
}

export interface TestExecutionStore {
  readiness(): Promise<{ ready: boolean; reason?: string }>
  createAggregate(input: CreateExecutionAggregateInput): Promise<ExecutionRun>
  getRun(runId: string): Promise<ExecutionRun | null>
  getRunByIdempotencyKey(projectVersionId: string, idempotencyKey: string): Promise<ExecutionRun | null>
  listRuns(projectVersionId: string, limit: number): Promise<ExecutionRun[]>
  listTasks(runId: string): Promise<ExecutionTask[]>
  getTask(taskId: string): Promise<ExecutionTask | null>
  getTaskDetail(taskId: string): Promise<ExecutionTaskDetailSnapshot | null>
  listAttempts(taskId: string): Promise<ExecutionAttempt[]>
  listDiagnoses(taskId: string): Promise<FailureDiagnosis[]>
  getScriptArtifactByCacheKey(cacheKey: string): Promise<ScriptArtifact | null>
  getScriptRevision(revisionId: string): Promise<ScriptRevision | null>
  getCacheSourceRevision(scriptArtifactId: string): Promise<ScriptRevision | null>
  listScriptRevisions(taskId: string): Promise<ScriptRevision[]>
  getArtifact(artifactId: string): Promise<ExecutionArtifact | null>
  listArtifacts(taskId: string, attemptId?: string): Promise<ExecutionArtifact[]>
  claimJob(workerId: string, leaseMs: number): Promise<ExecutionJob | null>
  heartbeatJob(jobId: string, lease: ExecutionJobLease, leaseMs: number): Promise<boolean>
  releaseJob(jobId: string, lease: ExecutionJobLease, retryDelayMs: number, error: string): Promise<boolean>
  finishJob(jobId: string, lease: ExecutionJobLease, status: 'succeeded' | 'failed' | 'cancelled', error?: string): Promise<boolean>
  cancelRun(runId: string, expectedStateVersion: number, requestedAt: string): Promise<ExecutionRun>
  retryTask(input: {
    runId: string
    taskId: string
    expectedRunStateVersion: number
    expectedTaskStateVersion: number
    job: ExecutionJob
  }): Promise<ExecutionTask>
  transactionWithLease<T>(jobId: string, lease: ExecutionJobLease, operation: (transaction: TestExecutionTransaction) => Promise<T>, options?: { allowCancellation?: boolean }): Promise<T | null>
  close(): Promise<void>
}

export class PostgresTestExecutionStore implements TestExecutionStore {
  private readonly pool: Pool

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString })
  }

  async close() {
    await this.pool.end()
  }

  async readiness() {
    try {
      await this.pool.query('SELECT 1 FROM smarthub.test_execution_runs LIMIT 0')
      return { ready: true }
    } catch {
      return {
        ready: false,
        reason: 'TEST_EXECUTION_POSTGRES_UNAVAILABLE',
      }
    }
  }

  async createAggregate(input: CreateExecutionAggregateInput): Promise<ExecutionRun> {
    validateAggregate(input)
    const aggregateSha256 = executionAggregateSha256(input)
    const createRequestSha256 = executionCreateRequestSha256(input.run)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const existing = await getAggregateByIdempotencyKey(client, input.run.projectVersionId, input.run.idempotencyKey)
      if (existing) {
        if (existing.createRequestSha256 !== createRequestSha256) {
          throw new Error('TEST_EXECUTION_IDEMPOTENCY_CONFLICT')
        }
        await client.query('COMMIT')
        return existing.run
      }
      await validatePersistedExecutionSources(client, input)
      await insertRun(
        client,
        input.run,
        aggregateSha256,
        createRequestSha256,
      )
      for (const task of input.tasks) await insertTask(client, task)
      for (const job of input.jobs) await insertJob(client, job)
      const created = input.jobs.length
        ? structuredClone(input.run)
        : await recomputeRun(client, input.run.id)
      if (input.jobs.length) await notifyExecutionTask(client)
      await client.query('COMMIT')
      return created
    } catch (error) {
      await client.query('ROLLBACK')
      if ((error as { code?: string }).code === '23505') {
        const existing = await getAggregateByIdempotencyKey(client, input.run.projectVersionId, input.run.idempotencyKey)
        if (existing?.createRequestSha256 === createRequestSha256) {
          return existing.run
        }
        if (existing) {
          throw new Error('TEST_EXECUTION_IDEMPOTENCY_CONFLICT')
        }
      }
      throw error
    } finally {
      client.release()
    }
  }

  async getRun(runId: string) {
    return getRun(this.pool, runId)
  }

  async getRunByIdempotencyKey(projectVersionId: string, idempotencyKey: string) {
    return getRunByIdempotencyKey(this.pool, projectVersionId, idempotencyKey)
  }

  async listRuns(projectVersionId: string, limit: number) {
    const boundedLimit = Math.min(200, Math.max(1, limit))
    const result = await this.pool.query<{
      snapshot: ExecutionRun
      status: ExecutionRunStatus
      state_version: number
      started_at: Date | string | null
      finished_at: Date | string | null
      cancel_requested_at: Date | string | null
      error: string | null
    }>(`
      SELECT snapshot,status,state_version,started_at,finished_at,
             cancel_requested_at,error
      FROM smarthub.test_execution_runs
      WHERE project_version_id=$1
      ORDER BY created_at DESC,id DESC
      LIMIT $2
    `, [projectVersionId, boundedLimit])
    return result.rows.map(runFromRow)
  }

  async listTasks(runId: string) {
    const result = await this.pool.query<{ frozen_input: ExecutionTask['input']; status: ExecutionTaskStatus; state_version: number; runner_attempt_count: number; same_script_retry_count: number; repair_count: number; current_script_revision_id: string | null; unsupported_reason: string | null; error: string | null; created_at: Date | string; updated_at: Date | string; finished_at: Date | string | null }>(`
      SELECT frozen_input,status,state_version,runner_attempt_count,same_script_retry_count,repair_count,current_script_revision_id,unsupported_reason,error,created_at,updated_at,finished_at
      FROM smarthub.test_execution_tasks WHERE run_id=$1 ORDER BY ordinal,id
    `, [runId])
    return result.rows.map(row => taskFromRow(row))
  }

  async getTask(taskId: string) {
    return getTaskWithQueryable(this.pool, taskId)
  }

  async getTaskDetail(taskId: string): Promise<ExecutionTaskDetailSnapshot | null> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const task = await getTaskWithQueryable(client, taskId)
      if (!task) {
        await client.query('COMMIT')
        return null
      }
      const run = await getRun(client, task.runId)
      if (!run) throw new Error('TEST_EXECUTION_RUN_NOT_FOUND')
      const [attempts, diagnoses, revisions, artifacts] = await Promise.all([
        client.query<AttemptRow>('SELECT * FROM smarthub.test_execution_attempts WHERE task_id=$1 ORDER BY ordinal', [task.id]),
        client.query<DiagnosisRow>(`${diagnosisSelectSql}
          WHERE diagnosis.task_id=$1 ORDER BY diagnosis.created_at,diagnosis.id
        `, [task.id]),
        client.query<ScriptRevisionRow>('SELECT * FROM smarthub.test_execution_script_revisions WHERE task_id=$1 ORDER BY revision,id', [task.id]),
        client.query<ArtifactRow>(`
          SELECT * FROM smarthub.test_execution_artifacts
          WHERE task_id=$1 ORDER BY created_at,id
        `, [task.id]),
      ])
      await client.query('COMMIT')
      return {
        run,
        task,
        attempts: attempts.rows.map(attemptFromRow),
        diagnoses: diagnoses.rows.map(diagnosisFromRow),
        scriptRevisions: revisions.rows.map(scriptRevisionFromRow),
        artifacts: artifacts.rows.map(artifactFromRow),
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async listAttempts(taskId: string) {
    const result = await this.pool.query<AttemptRow>('SELECT * FROM smarthub.test_execution_attempts WHERE task_id=$1 ORDER BY ordinal', [taskId])
    return result.rows.map(attemptFromRow)
  }

  async listDiagnoses(taskId: string) {
    const result = await this.pool.query<DiagnosisRow>(`${diagnosisSelectSql}
      WHERE diagnosis.task_id=$1 ORDER BY diagnosis.created_at,diagnosis.id
    `, [taskId])
    return result.rows.map(diagnosisFromRow)
  }

  async getScriptArtifactByCacheKey(cacheKey: string) {
    const result = await this.pool.query<ScriptArtifactRow>('SELECT * FROM smarthub.test_execution_script_artifacts WHERE cache_key=$1', [cacheKey])
    return result.rows[0] ? scriptArtifactFromRow(result.rows[0]) : null
  }

  async getScriptRevision(revisionId: string) {
    const result = await this.pool.query<ScriptRevisionRow>('SELECT * FROM smarthub.test_execution_script_revisions WHERE id=$1', [revisionId])
    return result.rows[0] ? scriptRevisionFromRow(result.rows[0]) : null
  }

  async getCacheSourceRevision(scriptArtifactId: string) {
    const result = await this.pool.query<ScriptRevisionRow>(`
      SELECT * FROM smarthub.test_execution_script_revisions
      WHERE script_artifact_id=$1 AND generation_source<>'cache'
      ORDER BY created_at,id LIMIT 1
    `, [scriptArtifactId])
    return result.rows[0] ? scriptRevisionFromRow(result.rows[0]) : null
  }

  async listScriptRevisions(taskId: string) {
    const result = await this.pool.query<ScriptRevisionRow>('SELECT * FROM smarthub.test_execution_script_revisions WHERE task_id=$1 ORDER BY revision,id', [taskId])
    return result.rows.map(scriptRevisionFromRow)
  }

  async getArtifact(artifactId: string) {
    const result = await this.pool.query<ArtifactRow>('SELECT * FROM smarthub.test_execution_artifacts WHERE id=$1', [artifactId])
    return result.rows[0] ? artifactFromRow(result.rows[0]) : null
  }

  async listArtifacts(taskId: string, attemptId?: string) {
    const result = await this.pool.query<ArtifactRow>(`
      SELECT * FROM smarthub.test_execution_artifacts
      WHERE task_id=$1 AND ($2::text IS NULL OR attempt_id=$2)
      ORDER BY created_at,id
    `, [taskId, attemptId ?? null])
    return result.rows.map(artifactFromRow)
  }

  async claimJob(workerId: string, leaseMs: number): Promise<ExecutionJob | null> {
    const client = await this.pool.connect()
    try {
      let preferredJobId: string | null = null
      while (true) {
        await client.query('BEGIN')
        const reconciledJobId = await reconcileExpiredExhaustedJob(client)
        if (reconciledJobId) {
          await client.query('COMMIT')
          preferredJobId = reconciledJobId
          continue
        }
        const runToken = randomUUID()
        const result = await client.query<JobRow>(`
          WITH next_job AS (
            SELECT id,status='running' AS reclaimed
            FROM smarthub.test_execution_jobs
            WHERE (
                status='queued'
                AND available_at <= clock_timestamp()
                AND attempt_count < max_attempts
                AND cancel_requested_at IS NULL
                AND EXISTS (
                  SELECT 1 FROM smarthub.test_execution_tasks task
                  WHERE task.id=test_execution_jobs.task_id
                    AND task.status NOT IN ('passed','failed','blocked','unsupported','waiting_manual','cancelled')
                )
              ) OR (
                status='running'
                AND lease_expires_at < clock_timestamp()
                AND cancel_requested_at IS NULL
                AND attempt_count < max_attempts
                AND NOT EXISTS (
                  SELECT 1 FROM smarthub.test_execution_attempts attempt
                  WHERE attempt.task_id=test_execution_jobs.task_id
                    AND attempt.status='running'
                )
                AND EXISTS (
                  SELECT 1 FROM smarthub.test_execution_tasks task
                  WHERE task.id=test_execution_jobs.task_id
                    AND task.status NOT IN ('passed','failed','blocked','unsupported','waiting_manual','cancelled')
                )
              )
            ORDER BY CASE WHEN id=$4 THEN 0 ELSE 1 END,available_at,created_at,id
            FOR UPDATE SKIP LOCKED LIMIT 1
          )
          UPDATE smarthub.test_execution_jobs job
          SET status='running',attempt_count=attempt_count+1,
              lease_owner=$1,run_token=$3::uuid,fencing_token=fencing_token+1,
              lease_expires_at=clock_timestamp()+($2::text||' milliseconds')::interval,
              heartbeat_at=clock_timestamp(),started_at=COALESCE(started_at,clock_timestamp()),finished_at=NULL,updated_at=clock_timestamp(),
              error=CASE WHEN next_job.reclaimed THEN 'TEST_EXECUTION_JOB_RECLAIMED' ELSE error END
          FROM next_job WHERE job.id=next_job.id RETURNING job.*
        `, [workerId, Math.max(1_000, leaseMs), runToken, preferredJobId])
        await client.query('COMMIT')
        return result.rows[0] ? jobFromRow(result.rows[0]) : null
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async heartbeatJob(jobId: string, lease: ExecutionJobLease, leaseMs: number) {
    const result = await this.pool.query(`
      UPDATE smarthub.test_execution_jobs
      SET lease_expires_at=clock_timestamp()+($5::text||' milliseconds')::interval,heartbeat_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1 AND status='running' AND lease_owner=$2 AND run_token=$3::uuid AND fencing_token=$4
        AND lease_expires_at>clock_timestamp() AND cancel_requested_at IS NULL
    `, [jobId, lease.workerId, lease.runToken, lease.fencingToken, Math.max(1_000, leaseMs)])
    return result.rowCount === 1
  }

  async releaseJob(jobId: string, lease: ExecutionJobLease, retryDelayMs: number, error: string) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const owned = await lockOwnedJob(client, jobId, lease, false)
      if (!owned) {
        await client.query('ROLLBACK')
        return false
      }
      const runningAttempt = await client.query('SELECT 1 FROM smarthub.test_execution_attempts WHERE task_id=$1 AND status=\'running\' LIMIT 1', [owned.taskId])
      if (runningAttempt.rows[0]) {
        await client.query('ROLLBACK')
        return false
      }
      const taskResult = await client.query<{ status: ExecutionTaskStatus; state_version: number }>(
        'SELECT status,state_version FROM smarthub.test_execution_tasks WHERE id=$1 FOR UPDATE',
        [owned.taskId],
      )
      const task = taskResult.rows[0]
      if (!task) throw new Error('TEST_EXECUTION_TASK_NOT_FOUND')
      const terminalStatuses = new Set<ExecutionTaskStatus>(['passed', 'failed', 'blocked', 'unsupported', 'waiting_manual', 'cancelled'])
      const job = await client.query<{ attempt_count: number; max_attempts: number }>('SELECT attempt_count,max_attempts FROM smarthub.test_execution_jobs WHERE id=$1', [jobId])
      const current = job.rows[0]
      if (!current) throw new Error('TEST_EXECUTION_JOB_NOT_FOUND')
      if (terminalStatuses.has(task.status)) {
        const terminalJobStatus = task.status === 'passed' ? 'succeeded' : task.status === 'cancelled' ? 'cancelled' : 'failed'
        await client.query(`
          UPDATE smarthub.test_execution_jobs
          SET status=$2,finished_at=clock_timestamp(),updated_at=clock_timestamp(),error=$3,
              lease_owner=NULL,run_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL
          WHERE id=$1
        `, [jobId, terminalJobStatus, task.status === 'passed' ? null : error])
        await recomputeRun(client, owned.runId)
      } else if (Number(current.attempt_count) < Number(current.max_attempts)) {
        await client.query(`
          UPDATE smarthub.test_execution_jobs
          SET status='queued',available_at=now()+($2::text||' milliseconds')::interval,updated_at=now(),error=$3,
              lease_owner=NULL,run_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL
          WHERE id=$1
        `, [jobId, Math.max(0, retryDelayMs), error])
        await notifyExecutionTask(client)
      } else {
        assertTaskTransition(task.status, 'blocked')
        await client.query(`
          UPDATE smarthub.test_execution_tasks
          SET status='blocked',state_version=state_version+1,updated_at=now(),finished_at=now(),error=$2
          WHERE id=$1 AND state_version=$3
        `, [owned.taskId, `TEST_EXECUTION_JOB_RETRY_EXHAUSTED: ${error}`, Number(task.state_version)])
        await client.query(`
          UPDATE smarthub.test_execution_jobs
          SET status='failed',finished_at=now(),updated_at=now(),error=$2,
              lease_owner=NULL,run_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL
          WHERE id=$1
        `, [jobId, error])
        await recomputeRun(client, owned.runId)
      }
      await client.query('COMMIT')
      return true
    } catch (errorValue) {
      await client.query('ROLLBACK')
      throw errorValue
    } finally {
      client.release()
    }
  }

  async finishJob(jobId: string, lease: ExecutionJobLease, status: 'succeeded' | 'failed' | 'cancelled', error?: string) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query<{ run_id: string }>(`
        UPDATE smarthub.test_execution_jobs
        SET status=$5,finished_at=now(),updated_at=now(),error=$6,lease_owner=NULL,run_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL
        WHERE id=$1 AND status='running' AND lease_owner=$2 AND run_token=$3::uuid AND fencing_token=$4 AND lease_expires_at>clock_timestamp()
          AND NOT EXISTS (
            SELECT 1 FROM smarthub.test_execution_attempts attempt
            WHERE attempt.task_id=test_execution_jobs.task_id AND attempt.status='running'
          )
          AND (
            ($5 = 'cancelled' AND cancel_requested_at IS NOT NULL AND EXISTS (
              SELECT 1 FROM smarthub.test_execution_tasks task
              WHERE task.id=test_execution_jobs.task_id AND task.status='cancelled'
            ))
            OR ($5 = 'succeeded' AND cancel_requested_at IS NULL AND EXISTS (
              SELECT 1 FROM smarthub.test_execution_tasks task
              WHERE task.id=test_execution_jobs.task_id AND task.status='passed'
            ))
            OR ($5 = 'failed' AND cancel_requested_at IS NULL AND EXISTS (
              SELECT 1 FROM smarthub.test_execution_tasks task
              WHERE task.id=test_execution_jobs.task_id
                AND task.status IN ('failed','blocked','unsupported','waiting_manual')
            ))
          )
        RETURNING run_id
      `, [jobId, lease.workerId, lease.runToken, lease.fencingToken, status, error ?? null])
      if (!result.rows[0]) {
        await client.query('ROLLBACK')
        return false
      }
      await recomputeRun(client, result.rows[0].run_id)
      await client.query('COMMIT')
      return true
    } catch (errorValue) {
      await client.query('ROLLBACK')
      throw errorValue
    } finally {
      client.release()
    }
  }

  async cancelRun(runId: string, expectedStateVersion: number, requestedAt: string) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`
        SELECT id FROM smarthub.test_execution_jobs
        WHERE run_id=$1 AND status IN ('queued','running')
        ORDER BY id FOR UPDATE
      `, [runId])
      const current = await getRunForUpdate(client, runId)
      if (!current) throw new Error('TEST_EXECUTION_RUN_NOT_FOUND')
      if (current.stateVersion !== expectedStateVersion) throw new Error('TEST_EXECUTION_RUN_STATE_VERSION_CONFLICT')
      if (!['queued', 'running'].includes(current.status)) throw new Error('TEST_EXECUTION_RUN_NOT_CANCELLABLE')
      await client.query(`
        WITH completed AS (
          SELECT DISTINCT ON (task.id) task.id,attempt.finished_at
          FROM smarthub.test_execution_tasks task
          JOIN smarthub.test_execution_attempts attempt
            ON attempt.task_id=task.id
           AND attempt.script_revision_id=task.current_script_revision_id
           AND attempt.status='passed'
          WHERE task.run_id=$1 AND task.status='running'
            AND NOT EXISTS (
              SELECT 1 FROM smarthub.test_execution_attempts running_attempt
              WHERE running_attempt.task_id=task.id AND running_attempt.status='running'
            )
          ORDER BY task.id,attempt.ordinal DESC
        )
        UPDATE smarthub.test_execution_tasks task
        SET status='passed',state_version=state_version+1,updated_at=completed.finished_at,
            finished_at=completed.finished_at,error=NULL
        FROM completed WHERE task.id=completed.id
      `, [runId])
      const taskStatuses = await client.query<{ status: ExecutionTaskStatus }>(
        'SELECT status FROM smarthub.test_execution_tasks WHERE run_id=$1 ORDER BY ordinal FOR UPDATE',
        [runId],
      )
      if (aggregateExecutionRunStatus(taskStatuses.rows.map(row => row.status)) !== 'running') {
        const updated = await recomputeRun(client, runId)
        await client.query('COMMIT')
        return updated
      }
      await client.query(`
        UPDATE smarthub.test_execution_jobs job
        SET status=CASE
              WHEN task.status='passed' THEN 'succeeded'
              WHEN task.status='cancelled' THEN 'cancelled'
              ELSE 'failed'
            END,
            finished_at=clock_timestamp(),updated_at=clock_timestamp(),
            lease_owner=NULL,run_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL
        FROM smarthub.test_execution_tasks task
        WHERE job.run_id=$1 AND job.task_id=task.id
          AND job.status IN ('queued','running')
          AND task.status IN ('passed','failed','blocked','unsupported','waiting_manual','cancelled')
          AND NOT EXISTS (
            SELECT 1 FROM smarthub.test_execution_attempts attempt
            WHERE attempt.task_id=job.task_id AND attempt.status='running'
          )
      `, [runId])
      await client.query(`UPDATE smarthub.test_execution_runs SET cancel_requested_at=$2,state_version=state_version+1 WHERE id=$1`, [runId, requestedAt])
      await client.query(`
        UPDATE smarthub.test_execution_tasks task
        SET status='cancelled',state_version=state_version+1,updated_at=$2,finished_at=$2
        WHERE task.run_id=$1
          AND (
            task.status IN ('pending','script_generating','ready','retrying','diagnosing','repairing')
            OR (
              task.status='running'
              AND NOT EXISTS (
                SELECT 1 FROM smarthub.test_execution_attempts attempt
                WHERE attempt.task_id=task.id AND attempt.status='running'
              )
            )
          )
      `, [runId, requestedAt])
      await client.query(`
        UPDATE smarthub.test_execution_jobs job
        SET cancel_requested_at=$2,updated_at=$2,
            status=CASE
              WHEN job.status='queued' OR NOT EXISTS (
                SELECT 1 FROM smarthub.test_execution_attempts attempt
                WHERE attempt.task_id=job.task_id AND attempt.status='running'
              ) THEN 'cancelled'
              ELSE job.status
            END,
            finished_at=CASE
              WHEN job.status='queued' OR NOT EXISTS (
                SELECT 1 FROM smarthub.test_execution_attempts attempt
                WHERE attempt.task_id=job.task_id AND attempt.status='running'
              ) THEN $2
              ELSE job.finished_at
            END,
            lease_owner=CASE
              WHEN job.status='queued' OR NOT EXISTS (
                SELECT 1 FROM smarthub.test_execution_attempts attempt
                WHERE attempt.task_id=job.task_id AND attempt.status='running'
              ) THEN NULL
              ELSE job.lease_owner
            END,
            run_token=CASE
              WHEN job.status='queued' OR NOT EXISTS (
                SELECT 1 FROM smarthub.test_execution_attempts attempt
                WHERE attempt.task_id=job.task_id AND attempt.status='running'
              ) THEN NULL
              ELSE job.run_token
            END,
            lease_expires_at=CASE
              WHEN job.status='queued' OR NOT EXISTS (
                SELECT 1 FROM smarthub.test_execution_attempts attempt
                WHERE attempt.task_id=job.task_id AND attempt.status='running'
              ) THEN NULL
              ELSE job.lease_expires_at
            END,
            heartbeat_at=CASE
              WHEN job.status='queued' OR NOT EXISTS (
                SELECT 1 FROM smarthub.test_execution_attempts attempt
                WHERE attempt.task_id=job.task_id AND attempt.status='running'
              ) THEN NULL
              ELSE job.heartbeat_at
            END
        WHERE job.run_id=$1 AND job.status IN ('queued','running')
      `, [runId, requestedAt])
      const updated = await recomputeRun(client, runId)
      await client.query('COMMIT')
      return updated
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async retryTask(input: {
    runId: string
    taskId: string
    expectedRunStateVersion: number
    expectedTaskStateVersion: number
    job: ExecutionJob
  }) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const currentRun = await getRunForUpdate(client, input.runId)
      if (!currentRun) throw new Error('TEST_EXECUTION_RUN_NOT_FOUND')
      const currentTaskResult = await client.query<{
        frozen_input: ExecutionTask['input']
        status: ExecutionTaskStatus
        state_version: number
        runner_attempt_count: number
        same_script_retry_count: number
        repair_count: number
        current_script_revision_id: string | null
        unsupported_reason: string | null
        error: string | null
        created_at: Date | string
        updated_at: Date | string
        finished_at: Date | string | null
      }>(`
        SELECT frozen_input,status,state_version,runner_attempt_count,
               same_script_retry_count,repair_count,current_script_revision_id,
               unsupported_reason,error,created_at,updated_at,finished_at
        FROM smarthub.test_execution_tasks
        WHERE id=$1 AND run_id=$2
        FOR UPDATE
      `, [input.taskId, input.runId])
      const currentTask = currentTaskResult.rows[0]
        ? taskFromRow(currentTaskResult.rows[0])
        : null
      if (!currentTask) throw new Error('TEST_EXECUTION_TASK_NOT_FOUND')

      const existingJob = await client.query<JobRow & { data: ExecutionJob }>(`
        SELECT *,data
        FROM smarthub.test_execution_jobs
        WHERE id=$1
      `, [input.job.id])
      if (existingJob.rows[0]) {
        const existing = jobFromRow(existingJob.rows[0])
        if (
          existing.runId !== input.runId
          || existing.taskId !== input.taskId
          || canonicalSha256(existing.request) !== canonicalSha256(input.job.request)
        ) {
          throw new Error('TEST_EXECUTION_IDEMPOTENCY_CONFLICT')
        }
        await client.query('COMMIT')
        return currentTask
      }

      if (currentRun.stateVersion !== input.expectedRunStateVersion) {
        throw new Error('TEST_EXECUTION_RUN_STATE_VERSION_CONFLICT')
      }
      if (currentTask.stateVersion !== input.expectedTaskStateVersion) {
        throw new Error('TEST_EXECUTION_TASK_STATE_VERSION_CONFLICT')
      }
      if (!['failed', 'partial'].includes(currentRun.status)) {
        throw new Error('TEST_EXECUTION_RUN_NOT_RETRYABLE')
      }
      if (!['failed', 'blocked', 'waiting_manual'].includes(currentTask.status)) {
        throw new Error('TEST_EXECUTION_TASK_NOT_RETRYABLE')
      }
      if (!currentTask.currentScriptRevisionId) {
        throw new Error('TEST_EXECUTION_CURRENT_SCRIPT_REVISION_REQUIRED')
      }
      if (input.job.runId !== input.runId || input.job.taskId !== input.taskId) {
        throw new Error('TEST_EXECUTION_JOB_TASK_MISMATCH')
      }
      if (
        input.job.status !== 'queued'
        || input.job.attempts !== 0
        || input.job.fencingToken !== 0
        || input.job.maxAttempts < 1
        || !input.job.request
        || input.job.request.kind !== 'manual_retry'
      ) {
        throw new Error('TEST_EXECUTION_MANUAL_RETRY_JOB_INVALID')
      }

      assertTaskTransition(currentTask.status, 'ready')
      assertRunTransition(currentRun.status, 'running')
      const updated = await transitionTask(client, {
        taskId: currentTask.id,
        expectedStatus: currentTask.status,
        expectedStateVersion: currentTask.stateVersion,
        status: 'ready',
      })
      await client.query(`
        UPDATE smarthub.test_execution_runs
        SET status='running',state_version=state_version+1,
            finished_at=NULL,error=NULL
        WHERE id=$1 AND status=$2 AND state_version=$3
      `, [input.runId, currentRun.status, currentRun.stateVersion])
      await insertJob(client, input.job)
      await notifyExecutionTask(client)
      await client.query('COMMIT')
      return updated
    } catch (error) {
      await client.query('ROLLBACK')
      if ((error as { code?: string }).code === '23505') {
        const existingJob = await client.query<JobRow & { data: ExecutionJob }>(`
          SELECT *,data FROM smarthub.test_execution_jobs WHERE id=$1
        `, [input.job.id])
        if (existingJob.rows[0]) {
          const existing = jobFromRow(existingJob.rows[0])
          if (
            existing.runId === input.runId
            && existing.taskId === input.taskId
            && canonicalSha256(existing.request) === canonicalSha256(input.job.request)
          ) {
            const replay = await getTaskWithQueryable(client, input.taskId)
            if (replay) return replay
          }
          throw new Error('TEST_EXECUTION_IDEMPOTENCY_CONFLICT')
        }
      }
      throw error
    } finally {
      client.release()
    }
  }

  async transactionWithLease<T>(jobId: string, lease: ExecutionJobLease, operation: (transaction: TestExecutionTransaction) => Promise<T>, options: { allowCancellation?: boolean } = {}): Promise<T | null> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const allowCancellation = Boolean(options.allowCancellation)
      const scope = await lockOwnedJob(client, jobId, lease, allowCancellation)
      if (!scope) {
        await client.query('ROLLBACK')
        return null
      }
      const result = await operation(transactionFor(client, scope, allowCancellation))
      await recomputeRun(client, scope.runId)
      if (!await lockOwnedJob(client, jobId, lease, allowCancellation)) {
        await client.query('ROLLBACK')
        return null
      }
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}

function transactionFor(client: PoolClient, scope: ExecutionLeaseScope, cancellation: boolean): TestExecutionTransaction {
  const requireNormal = () => {
    if (cancellation) throw new Error('TEST_EXECUTION_CANCELLATION_OPERATION_INVALID')
  }
  return {
    transitionTask: input => {
      assertLeaseTask(scope, input.taskId)
      if (cancellation !== (input.status === 'cancelled')) throw new Error('TEST_EXECUTION_CANCELLATION_TRANSITION_INVALID')
      return transitionTask(client, input)
    },
    appendArtifact: artifact => {
      assertLeaseAggregate(scope, artifact.runId, artifact.taskId)
      return insertArtifact(client, artifact)
    },
    appendScriptArtifact: artifact => {
      requireNormal()
      return insertScriptArtifact(client, artifact)
    },
    appendScriptRevision: revision => {
      requireNormal()
      assertLeaseAggregate(scope, revision.runId, revision.taskId)
      if (revision.package.taskId !== scope.taskId) throw new Error('TEST_EXECUTION_LEASE_SCOPE_MISMATCH')
      const { packageSha256, ...manifestBase } = revision.package
      if (
        revision.package.protectedAssertionSha256 !== revision.protectedAssertionSha256
        || canonicalSha256(revision.package.assertions) !== revision.protectedAssertionSha256
        || canonicalSha256(manifestBase) !== packageSha256
        || revision.package.files.length !== 1
        || revision.package.files[0].path !== revision.package.entrypoint
        || revision.package.files[0].contentSha256 !== revision.contentSha256
      ) {
        throw new Error('TEST_EXECUTION_SCRIPT_REVISION_HASH_MISMATCH')
      }
      return insertScriptRevision(client, revision)
    },
    appendAttempt: attempt => {
      requireNormal()
      assertLeaseAggregate(scope, attempt.runId, attempt.taskId)
      return insertAttempt(client, attempt)
    },
    finalizeAttempt: input => {
      if (cancellation !== (input.status === 'cancelled')) throw new Error('TEST_EXECUTION_CANCELLATION_ATTEMPT_INVALID')
      return finalizeAttempt(client, input, scope)
    },
    appendDiagnosis: diagnosis => {
      requireNormal()
      assertLeaseAggregate(scope, diagnosis.runId, diagnosis.taskId)
      return insertDiagnosis(client, diagnosis)
    },
    enqueueJob: async job => {
      requireNormal()
      assertLeaseAggregate(scope, job.runId, job.taskId)
      await insertJob(client, job)
      await notifyExecutionTask(client)
    },
    recomputeRun: runId => {
      if (runId !== scope.runId) throw new Error('TEST_EXECUTION_LEASE_SCOPE_MISMATCH')
      return recomputeRun(client, runId)
    },
  }
}

async function lockOwnedJob(client: PoolClient, jobId: string, lease: ExecutionJobLease, cancellation: boolean): Promise<ExecutionLeaseScope | null> {
  const result = await client.query<{ run_id: string; task_id: string }>(`
    SELECT run_id,task_id FROM smarthub.test_execution_jobs
    WHERE id=$1 AND status='running' AND lease_owner=$2 AND run_token=$3::uuid AND fencing_token=$4
      AND lease_expires_at>clock_timestamp()
      AND (($5 AND cancel_requested_at IS NOT NULL) OR (NOT $5 AND cancel_requested_at IS NULL))
    FOR UPDATE
  `, [jobId, lease.workerId, lease.runToken, lease.fencingToken, cancellation])
  return result.rows[0] ? { runId: result.rows[0].run_id, taskId: result.rows[0].task_id } : null
}

async function reconcileExpiredExhaustedJob(client: PoolClient): Promise<string | null> {
  const expired = await client.query<{
    id: string
    run_id: string
    task_id: string
    attempt_count: number
    max_attempts: number
    cancel_requested_at: Date | string | null
  }>(`
    SELECT job.id,job.run_id,job.task_id,job.attempt_count,job.max_attempts,job.cancel_requested_at
    FROM smarthub.test_execution_jobs job
    WHERE job.status='running'
      AND job.lease_expires_at < clock_timestamp()
      AND (
        job.cancel_requested_at IS NOT NULL
        OR job.attempt_count >= job.max_attempts
        OR EXISTS (
          SELECT 1 FROM smarthub.test_execution_attempts attempt
          WHERE attempt.task_id=job.task_id AND attempt.status='running'
        )
        OR EXISTS (
          SELECT 1 FROM smarthub.test_execution_tasks task
          WHERE task.id=job.task_id
            AND task.status IN ('passed','failed','blocked','unsupported','waiting_manual','cancelled')
        )
      )
    ORDER BY job.lease_expires_at,job.created_at,job.id
    FOR UPDATE OF job SKIP LOCKED
    LIMIT 1
  `)
  const job = expired.rows[0]
  if (!job) return null

  const runningAttempt = await client.query<{ id: string }>(`
    SELECT id FROM smarthub.test_execution_attempts
    WHERE task_id=$1 AND status='running'
    FOR UPDATE
  `, [job.task_id])
  const taskResult = await client.query<{ status: ExecutionTaskStatus; state_version: number }>(
    'SELECT status,state_version FROM smarthub.test_execution_tasks WHERE id=$1 FOR UPDATE',
    [job.task_id],
  )
  const task = taskResult.rows[0]
  if (!task) throw new Error('TEST_EXECUTION_TASK_NOT_FOUND')
  const terminalStatuses = new Set<ExecutionTaskStatus>(['passed', 'failed', 'blocked', 'unsupported', 'waiting_manual', 'cancelled'])
  const terminal = terminalStatuses.has(task.status)
  const cancelled = task.status === 'cancelled' || (Boolean(job.cancel_requested_at) && !terminal)
  const exhausted = Number(job.attempt_count) >= Number(job.max_attempts)
  const attemptError = cancelled
    ? 'TEST_EXECUTION_JOB_CANCELLED_AFTER_LEASE_EXPIRY'
    : 'TEST_EXECUTION_ATTEMPT_INTERRUPTED_AFTER_LEASE_EXPIRY'

  if (runningAttempt.rows[0]) {
    await client.query(`
      UPDATE smarthub.test_execution_attempts
      SET status=$2,finished_at=clock_timestamp(),
          duration_ms=GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (clock_timestamp()-started_at))*1000)::bigint),
          error=$3
      WHERE id=$1 AND status='running'
    `, [runningAttempt.rows[0].id, cancelled ? 'cancelled' : 'infrastructure_error', attemptError])
  }

  if (!terminal && !cancelled && !exhausted && runningAttempt.rows[0]) {
    assertTaskTransition(task.status, 'ready')
    const updated = await client.query(`
      UPDATE smarthub.test_execution_tasks
      SET status='ready',state_version=state_version+1,updated_at=clock_timestamp(),finished_at=NULL,error=$2
      WHERE id=$1 AND state_version=$3
    `, [job.task_id, attemptError, Number(task.state_version)])
    if (updated.rowCount !== 1) throw new Error('TEST_EXECUTION_TASK_STATE_CONFLICT')
    return job.id
  }

  if (!terminal) {
    const nextStatus: ExecutionTaskStatus = cancelled ? 'cancelled' : 'blocked'
    const error = cancelled
      ? 'TEST_EXECUTION_JOB_CANCELLED_AFTER_LEASE_EXPIRY'
      : 'TEST_EXECUTION_JOB_RETRY_EXHAUSTED_AFTER_LEASE_EXPIRY'
    assertTaskTransition(task.status, nextStatus)
    const updated = await client.query(`
      UPDATE smarthub.test_execution_tasks
      SET status=$2,state_version=state_version+1,updated_at=clock_timestamp(),finished_at=clock_timestamp(),error=$3
      WHERE id=$1 AND state_version=$4
    `, [job.task_id, nextStatus, error, Number(task.state_version)])
    if (updated.rowCount !== 1) throw new Error('TEST_EXECUTION_TASK_STATE_CONFLICT')
  }

  const jobStatus = cancelled ? 'cancelled' : task.status === 'passed' ? 'succeeded' : 'failed'
  const jobError = terminal
    ? null
    : cancelled
      ? 'TEST_EXECUTION_JOB_CANCELLED_AFTER_LEASE_EXPIRY'
      : 'TEST_EXECUTION_JOB_RETRY_EXHAUSTED_AFTER_LEASE_EXPIRY'
  await client.query(`
    UPDATE smarthub.test_execution_jobs
    SET status=$2,finished_at=clock_timestamp(),updated_at=clock_timestamp(),error=$3,
        lease_owner=NULL,run_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL
    WHERE id=$1
  `, [job.id, jobStatus, jobError])
  await recomputeRun(client, job.run_id)
  return job.id
}

async function transitionTask(client: PoolClient, input: {
  taskId: string
  expectedStatus: ExecutionTaskStatus
  expectedStateVersion: number
  status: ExecutionTaskStatus
  currentScriptRevisionId?: string
  incrementRunnerAttempt?: boolean
  incrementSameScriptRetry?: boolean
  incrementRepair?: boolean
  unsupportedReason?: string
  error?: string
  finishedAt?: string
}) {
  assertTaskTransition(input.expectedStatus, input.status)
  if (input.incrementRepair && input.status !== 'ready') throw new Error('TEST_EXECUTION_REPAIR_COUNTER_TRANSITION_INVALID')
  if (input.incrementRunnerAttempt && input.status !== 'running') throw new Error('TEST_EXECUTION_ATTEMPT_COUNTER_TRANSITION_INVALID')
  const terminalStatuses = new Set<ExecutionTaskStatus>(['passed', 'failed', 'blocked', 'unsupported', 'waiting_manual', 'cancelled'])
  if (terminalStatuses.has(input.status)) {
    const runningAttempt = await client.query(`
      SELECT id FROM smarthub.test_execution_attempts
      WHERE task_id=$1 AND status='running'
      FOR UPDATE
    `, [input.taskId])
    if (runningAttempt.rows[0]) throw new Error('TEST_EXECUTION_TASK_HAS_RUNNING_ATTEMPT')
    if (input.status === 'passed') {
      const passed = await client.query(`
        SELECT 1
        FROM smarthub.test_execution_tasks task
        JOIN smarthub.test_execution_attempts attempt
          ON attempt.task_id=task.id
         AND attempt.script_revision_id=task.current_script_revision_id
         AND attempt.status='passed'
        WHERE task.id=$1
        FOR UPDATE OF task
      `, [input.taskId])
      if (!passed.rows[0]) throw new Error('TEST_EXECUTION_TASK_PASSED_ATTEMPT_REQUIRED')
    }
  }
  const result = await client.query<{ frozen_input: ExecutionTask['input']; status: ExecutionTaskStatus; state_version: number; runner_attempt_count: number; same_script_retry_count: number; repair_count: number; current_script_revision_id: string | null; unsupported_reason: string | null; error: string | null; created_at: Date | string; updated_at: Date | string; finished_at: Date | string | null }>(`
    UPDATE smarthub.test_execution_tasks
    SET status=$4,state_version=state_version+1,updated_at=now(),
        current_script_revision_id=COALESCE($5,current_script_revision_id),
        runner_attempt_count=runner_attempt_count+CASE WHEN $6 THEN 1 ELSE 0 END,
        same_script_retry_count=same_script_retry_count+CASE WHEN $7 THEN 1 ELSE 0 END,
        repair_count=repair_count+CASE WHEN $8 THEN 1 ELSE 0 END,
        unsupported_reason=$9,error=$10,finished_at=$11
    WHERE id=$1 AND status=$2 AND state_version=$3
    RETURNING frozen_input,status,state_version,runner_attempt_count,same_script_retry_count,repair_count,current_script_revision_id,unsupported_reason,error,created_at,updated_at,finished_at
  `, [input.taskId, input.expectedStatus, input.expectedStateVersion, input.status, input.currentScriptRevisionId ?? null, Boolean(input.incrementRunnerAttempt), Boolean(input.incrementSameScriptRetry), Boolean(input.incrementRepair), input.unsupportedReason ?? null, input.error ?? null, input.finishedAt ?? null])
  if (!result.rows[0]) throw new Error('TEST_EXECUTION_TASK_STATE_CONFLICT')
  return taskFromRow(result.rows[0])
}

async function recomputeRun(client: PoolClient, runId: string) {
  const current = await getRunForUpdate(client, runId)
  if (!current) throw new Error('TEST_EXECUTION_RUN_NOT_FOUND')
  const statuses = await client.query<{ status: ExecutionTaskStatus }>('SELECT status FROM smarthub.test_execution_tasks WHERE run_id=$1 ORDER BY ordinal', [runId])
  const aggregate = aggregateExecutionRunStatus(statuses.rows.map(row => row.status))
  let nextStatus: ExecutionRunStatus = current.status
  if (current.status === 'queued' && aggregate === 'running') nextStatus = 'running'
  else if (current.status === 'queued' && aggregate !== 'running') {
    assertRunTransition('queued', 'running')
    await client.query(`UPDATE smarthub.test_execution_runs SET status='running',state_version=state_version+1,started_at=COALESCE(started_at,now()) WHERE id=$1 AND state_version=$2`, [runId, current.stateVersion])
    current.status = 'running'
    current.stateVersion += 1
    nextStatus = aggregate
  } else if (current.status === 'running' && aggregate !== 'running') nextStatus = aggregate
  if (nextStatus !== current.status) {
    assertRunTransition(current.status, nextStatus)
    const updated = await client.query<{ snapshot: ExecutionRun; status: ExecutionRunStatus; state_version: number; started_at: Date | string | null; finished_at: Date | string | null; cancel_requested_at: Date | string | null; error: string | null }>(`
      UPDATE smarthub.test_execution_runs
      SET status=$3,state_version=state_version+1,started_at=COALESCE(started_at,now()),finished_at=CASE WHEN $3 IN ('succeeded','failed','partial','cancelled') THEN now() ELSE NULL END
      WHERE id=$1 AND state_version=$2
      RETURNING snapshot,status,state_version,started_at,finished_at,cancel_requested_at,error
    `, [runId, current.stateVersion, nextStatus])
    if (!updated.rows[0]) throw new Error('TEST_EXECUTION_RUN_STATE_CONFLICT')
    return runFromRow(updated.rows[0])
  }
  return current
}

async function getRun(queryable: Pool | PoolClient, runId: string) {
  const result = await queryable.query<{ snapshot: ExecutionRun; status: ExecutionRunStatus; state_version: number; started_at: Date | string | null; finished_at: Date | string | null; cancel_requested_at: Date | string | null; error: string | null }>('SELECT snapshot,status,state_version,started_at,finished_at,cancel_requested_at,error FROM smarthub.test_execution_runs WHERE id=$1', [runId])
  return result.rows[0] ? runFromRow(result.rows[0]) : null
}

async function getTaskWithQueryable(queryable: Pool | PoolClient, taskId: string) {
  const result = await queryable.query<{
    frozen_input: ExecutionTask['input']
    status: ExecutionTaskStatus
    state_version: number
    runner_attempt_count: number
    same_script_retry_count: number
    repair_count: number
    current_script_revision_id: string | null
    unsupported_reason: string | null
    error: string | null
    created_at: Date | string
    updated_at: Date | string
    finished_at: Date | string | null
  }>(`
    SELECT frozen_input,status,state_version,runner_attempt_count,
           same_script_retry_count,repair_count,current_script_revision_id,
           unsupported_reason,error,created_at,updated_at,finished_at
    FROM smarthub.test_execution_tasks WHERE id=$1
  `, [taskId])
  return result.rows[0] ? taskFromRow(result.rows[0]) : null
}

async function getRunForUpdate(client: PoolClient, runId: string) {
  const result = await client.query<{ snapshot: ExecutionRun; status: ExecutionRunStatus; state_version: number; started_at: Date | string | null; finished_at: Date | string | null; cancel_requested_at: Date | string | null; error: string | null }>('SELECT snapshot,status,state_version,started_at,finished_at,cancel_requested_at,error FROM smarthub.test_execution_runs WHERE id=$1 FOR UPDATE', [runId])
  return result.rows[0] ? runFromRow(result.rows[0]) : null
}

async function getRunByIdempotencyKey(queryable: Pool | PoolClient, projectVersionId: string, idempotencyKey: string) {
  const existing = await getAggregateByIdempotencyKey(queryable, projectVersionId, idempotencyKey)
  return existing?.run ?? null
}

async function getAggregateByIdempotencyKey(queryable: Pool | PoolClient, projectVersionId: string, idempotencyKey: string) {
  const result = await queryable.query<{
    snapshot: ExecutionRun
    aggregate_sha256: string
    create_request_sha256: string
    status: ExecutionRunStatus
    state_version: number
    started_at: Date | string | null
    finished_at: Date | string | null
    cancel_requested_at: Date | string | null
    error: string | null
  }>(`
    SELECT snapshot,aggregate_sha256,create_request_sha256,status,state_version,started_at,finished_at,cancel_requested_at,error
    FROM smarthub.test_execution_runs
    WHERE project_version_id=$1 AND idempotency_key=$2
  `, [projectVersionId, idempotencyKey])
  return result.rows[0]
    ? {
        run: runFromRow(result.rows[0]),
        aggregateSha256: result.rows[0].aggregate_sha256,
        createRequestSha256: result.rows[0].create_request_sha256,
      }
    : null
}

async function validatePersistedExecutionSources(client: PoolClient, input: CreateExecutionAggregateInput) {
  const { run, tasks } = input
  const projectVersion = await client.query<{ project_id: string }>(
    'SELECT project_id FROM smarthub.project_versions WHERE id=$1 FOR SHARE',
    [run.projectVersionId],
  )
  if (projectVersion.rows[0]?.project_id !== run.projectId) {
    throw new Error('TEST_EXECUTION_PROJECT_VERSION_SCOPE_MISMATCH')
  }

  const handoffResult = await client.query<{
    project_version_id: string
    test_case_set_version_id: string | null
    test_case_library_version_id: string | null
    suite_version_id: string | null
    execution_mode: string | null
    content_sha256: string
  }>(`
    SELECT project_version_id,test_case_set_version_id,test_case_library_version_id,suite_version_id,execution_mode,content_sha256
    FROM smarthub.test_execution_handoffs WHERE id=$1 FOR SHARE
  `, [run.handoff.handoffId])
  const handoff = handoffResult.rows[0]
  if (!handoff) throw new Error('TEST_EXECUTION_HANDOFF_NOT_FOUND')
  if (handoff.test_case_set_version_id || !handoff.test_case_library_version_id || !handoff.execution_mode) {
    throw new Error('TEST_EXECUTION_HANDOFF_MIGRATION_REQUIRED')
  }
  if (
    handoff.project_version_id !== run.projectVersionId
    || handoff.test_case_library_version_id !== run.handoff.testCaseLibraryVersionId
    || (handoff.suite_version_id ?? undefined) !== run.handoff.suiteVersionId
    || handoff.execution_mode !== run.handoff.mode
    || handoff.content_sha256 !== run.handoff.handoffSha256
  ) {
    throw new Error('TEST_EXECUTION_HANDOFF_SOURCE_MISMATCH')
  }

  const libraryResult = await client.query<{
    project_id: string
    source_run_id: string | null
    legacy_test_case_set_version_id: string | null
    content_sha256: string
  }>(`
    SELECT project_id,source_run_id,legacy_test_case_set_version_id,content_sha256
    FROM smarthub.test_case_library_versions WHERE id=$1 FOR SHARE
  `, [run.handoff.testCaseLibraryVersionId])
  const library = libraryResult.rows[0]
  if (!library) throw new Error('TEST_EXECUTION_LIBRARY_VERSION_NOT_FOUND')
  if (library.project_id !== run.projectId || library.content_sha256 !== run.handoff.testCaseLibraryVersionSha256) {
    throw new Error('TEST_EXECUTION_LIBRARY_VERSION_MISMATCH')
  }

  const libraryMemberResult = await client.query<PersistedLibraryMemberRow>(`
    SELECT member.case_id,member.case_revision,member.ordinal,member.content_sha256,member.frozen_content,
           member.traceability,member.execution_readiness,revision.content_sha256 AS revision_content_sha256,
           revision.content AS revision_content,revision.traceability AS revision_traceability
    FROM smarthub.test_case_library_version_members member
    JOIN smarthub.library_test_case_revisions revision
      ON revision.case_id=member.case_id AND revision.revision=member.case_revision
    WHERE member.version_id=$1
    ORDER BY member.ordinal,member.case_id
    FOR SHARE OF member,revision
  `, [run.handoff.testCaseLibraryVersionId])
  if (!libraryMemberResult.rows.length) throw new Error('TEST_EXECUTION_LIBRARY_MEMBERS_EMPTY')
  const libraryMembers = libraryMemberResult.rows.map(persistedLibraryMember)
  assertUniqueOrdinals(libraryMembers, 'TEST_EXECUTION_LIBRARY_MEMBER_ORDINAL_INVALID')
  const libraryCanonical = library.source_run_id && !library.legacy_test_case_set_version_id
    ? {
        schemaVersion: 'test-case-library/v1',
        projectId: run.projectId,
        sourceRunId: library.source_run_id,
        members: libraryMembers,
      }
    : library.legacy_test_case_set_version_id && !library.source_run_id
      ? {
          schemaVersion: 'test-case-library/v1',
          projectId: run.projectId,
          legacyTestCaseSetVersionId: library.legacy_test_case_set_version_id,
          members: libraryMembers,
        }
      : null
  if (!libraryCanonical || canonicalSha256(libraryCanonical) !== library.content_sha256) {
    throw new Error('TEST_EXECUTION_LIBRARY_CONTENT_HASH_MISMATCH')
  }

  await validatePersistedSuite(client, run, libraryMembers)

  const handoffMemberResult = await client.query<PersistedHandoffMemberRow>(`
    SELECT stage,ordinal,source_version_id,case_id,case_revision,method,dedup_key,dimension,
           execution_spec,traceability,content_sha256,readiness_override,data
    FROM smarthub.test_execution_handoff_members
    WHERE handoff_id=$1
    ORDER BY ordinal,stage
    FOR SHARE
  `, [run.handoff.handoffId])
  const handoffMembers = handoffMemberResult.rows.map(persistedHandoffMember)
  assertUniqueOrdinals(handoffMembers, 'TEST_EXECUTION_HANDOFF_MEMBER_ORDINAL_INVALID')
  if (handoffMembers.length !== tasks.length) throw new Error('TEST_EXECUTION_HANDOFF_MEMBER_COUNT_MISMATCH')
  const handoffCanonical = {
    projectId: run.projectId,
    projectVersionId: run.projectVersionId,
    testCaseLibraryVersionId: run.handoff.testCaseLibraryVersionId,
    ...(run.handoff.suiteVersionId ? { suiteVersionId: run.handoff.suiteVersionId } : {}),
    mode: run.handoff.mode,
    members: handoffMembers,
  }
  if (canonicalSha256(handoffCanonical) !== handoff.content_sha256) {
    throw new Error('TEST_EXECUTION_HANDOFF_CONTENT_HASH_MISMATCH')
  }

  const libraryByCaseRevision = new Map(libraryMembers.map(member => [caseRevisionKey(member.caseId, member.revision), member]))
  const tasksByOrdinal = new Map(tasks.map(task => [task.input.ordinal, task]))
  for (const handoffMember of handoffMembers) {
    const libraryMember = libraryByCaseRevision.get(caseRevisionKey(handoffMember.caseId, handoffMember.revision))
    if (!libraryMember) throw new Error('TEST_EXECUTION_HANDOFF_LIBRARY_MEMBER_NOT_FOUND')
    const task = tasksByOrdinal.get(handoffMember.ordinal)
    if (!task) throw new Error('TEST_EXECUTION_HANDOFF_TASK_NOT_FOUND')
    const frozen = freezeExecutionTaskInput({ handoffMember, libraryMember })
    if (canonicalSha256(frozen) !== canonicalSha256(task.input)) {
      throw new Error('TEST_EXECUTION_TASK_PERSISTED_SOURCE_MISMATCH')
    }
  }
}

async function validatePersistedSuite(
  client: PoolClient,
  run: ExecutionRun,
  libraryMembers: TestCaseLibraryVersionMemberDetail[],
) {
  const expectedSuiteType = run.handoff.mode === 'smoke'
    ? 'smoke'
    : run.handoff.mode === 'regression'
      ? 'regression'
      : run.handoff.mode === 'custom'
        ? 'custom'
        : undefined
  if (!expectedSuiteType) {
    if (run.handoff.suiteVersionId || run.handoff.suiteVersionSha256) {
      throw new Error('TEST_EXECUTION_SUITE_FORBIDDEN')
    }
    return
  }
  if (!run.handoff.suiteVersionId || !run.handoff.suiteVersionSha256) {
    throw new Error('TEST_EXECUTION_SUITE_REQUIRED')
  }
  const suiteResult = await client.query<{
    project_id: string
    suite_key: string
    suite_type: string
    content_sha256: string
    test_case_library_version_id: string | null
    compatibility_status: string | null
    data: Record<string, unknown>
  }>(`
    SELECT project_id,suite_key,suite_type,content_sha256,test_case_library_version_id,compatibility_status,data
    FROM smarthub.test_suite_versions WHERE id=$1 FOR SHARE
  `, [run.handoff.suiteVersionId])
  const suite = suiteResult.rows[0]
  if (!suite) throw new Error('TEST_EXECUTION_SUITE_VERSION_NOT_FOUND')
  if (
    suite.project_id !== run.projectId
    || suite.suite_type !== expectedSuiteType
    || suite.test_case_library_version_id !== run.handoff.testCaseLibraryVersionId
    || suite.compatibility_status !== 'compatible'
    || suite.content_sha256 !== run.handoff.suiteVersionSha256
  ) {
    throw new Error('TEST_EXECUTION_SUITE_VERSION_MISMATCH')
  }
  const suiteMemberResult = await client.query<PersistedSuiteMemberRow>(`
    SELECT test_case_set_version_id,test_case_library_version_id,case_id,case_revision,ordinal,
           execution_methods,execution_method,data
    FROM smarthub.test_suite_version_members
    WHERE suite_version_id=$1
    ORDER BY ordinal,case_id
    FOR SHARE
  `, [run.handoff.suiteVersionId])
  const suiteMembers = suiteMemberResult.rows.map(row => persistedSuiteMember(row, run.handoff.testCaseLibraryVersionId))
  assertUniqueOrdinals(suiteMembers, 'TEST_EXECUTION_SUITE_MEMBER_ORDINAL_INVALID')
  const libraryByCaseRevision = new Set(libraryMembers.map(member => caseRevisionKey(member.caseId, member.revision)))
  if (suiteMembers.some(member => !libraryByCaseRevision.has(caseRevisionKey(member.caseId, member.revision)))) {
    throw new Error('TEST_EXECUTION_SUITE_LIBRARY_MEMBER_MISMATCH')
  }
  const suiteCanonical = {
    projectId: run.projectId,
    suiteKey: suite.suite_key,
    suiteType: suite.suite_type,
    name: requiredString(suite.data, 'name', 'TEST_EXECUTION_SUITE_SNAPSHOT_INVALID'),
    testCaseLibraryVersionId: run.handoff.testCaseLibraryVersionId,
    members: suiteMembers,
  }
  if (canonicalSha256(suiteCanonical) !== suite.content_sha256) {
    throw new Error('TEST_EXECUTION_SUITE_CONTENT_HASH_MISMATCH')
  }
}

interface PersistedLibraryMemberRow {
  case_id: string
  case_revision: number
  ordinal: number
  content_sha256: string
  frozen_content: TestCaseContent | null
  traceability: TestCaseTraceability | null
  execution_readiness: ExecutionReadiness | null
  revision_content_sha256: string
  revision_content: TestCaseContent
  revision_traceability: TestCaseTraceability | null
}

interface PersistedHandoffMemberRow {
  stage: string
  ordinal: number
  source_version_id: string
  case_id: string
  case_revision: number
  method: string
  dedup_key: string
  dimension: string | null
  execution_spec: TestCaseExecutionSpec | null
  traceability: TestCaseTraceability | null
  content_sha256: string | null
  readiness_override: TestExecutionHandoffMember['readinessOverride'] | null
  data: Record<string, unknown>
}

interface PersistedSuiteMemberRow {
  test_case_set_version_id: string | null
  test_case_library_version_id: string | null
  case_id: string
  case_revision: number
  ordinal: number
  execution_methods: string[] | null
  execution_method: string | null
  data: Record<string, unknown>
}

function persistedLibraryMember(row: PersistedLibraryMemberRow): TestCaseLibraryVersionMemberDetail {
  if (!row.frozen_content || !row.execution_readiness) {
    throw new Error('TEST_EXECUTION_LIBRARY_MEMBER_SNAPSHOT_INCOMPLETE')
  }
  if (
    canonicalSha256(row.frozen_content) !== row.content_sha256
    || row.revision_content_sha256 !== row.content_sha256
    || canonicalSha256(row.revision_content) !== row.content_sha256
    || canonicalSha256(row.revision_content) !== canonicalSha256(row.frozen_content)
    || canonicalOptionalSha256(row.revision_traceability) !== canonicalOptionalSha256(row.traceability)
  ) {
    throw new Error('TEST_EXECUTION_LIBRARY_MEMBER_SOURCE_MISMATCH')
  }
  return {
    caseId: row.case_id,
    revision: Number(row.case_revision),
    ordinal: Number(row.ordinal),
    contentSha256: row.content_sha256,
    frozenContent: structuredClone(row.frozen_content),
    ...(row.traceability ? { traceability: structuredClone(row.traceability) } : {}),
    executionReadiness: row.execution_readiness,
  }
}

function persistedHandoffMember(row: PersistedHandoffMemberRow): TestExecutionHandoffMember {
  if (!row.dimension || !row.execution_spec || !row.content_sha256) {
    throw new Error('TEST_EXECUTION_HANDOFF_MEMBER_SNAPSHOT_INCOMPLETE')
  }
  return {
    stage: row.stage as TestExecutionHandoffMember['stage'],
    ordinal: Number(row.ordinal),
    sourceVersionId: row.source_version_id,
    caseId: row.case_id,
    revision: Number(row.case_revision),
    method: row.method as TestExecutionMethod,
    reason: requiredString(row.data, 'reason', 'TEST_EXECUTION_HANDOFF_MEMBER_SNAPSHOT_INVALID'),
    dedupKey: row.dedup_key,
    dimension: row.dimension as TestDimension,
    executionSpec: structuredClone(row.execution_spec),
    ...(row.traceability ? { traceability: structuredClone(row.traceability) } : {}),
    ...(optionalString(row.data, 'selectionReason') ? { selectionReason: optionalString(row.data, 'selectionReason') } : {}),
    contentSha256: row.content_sha256,
    ...(row.readiness_override ? { readinessOverride: structuredClone(row.readiness_override) } : {}),
  }
}

function persistedSuiteMember(row: PersistedSuiteMemberRow, libraryVersionId: string): TestSuiteVersionMember {
  if (!row.execution_method || row.test_case_library_version_id !== libraryVersionId) {
    throw new Error('TEST_EXECUTION_SUITE_MEMBER_SNAPSHOT_INVALID')
  }
  const executionMethods = row.execution_methods ?? []
  if (executionMethods.some(method => method !== 'ui' && method !== 'api')) {
    throw new Error('TEST_EXECUTION_SUITE_MEMBER_SNAPSHOT_INVALID')
  }
  return {
    ...(row.test_case_set_version_id ? { testCaseSetVersionId: row.test_case_set_version_id } : {}),
    testCaseLibraryVersionId: row.test_case_library_version_id,
    caseId: row.case_id,
    revision: Number(row.case_revision),
    executionMethods: executionMethods as Array<'ui' | 'api'>,
    executionMethod: row.execution_method as TestExecutionMethod,
    ordinal: Number(row.ordinal),
    reason: requiredString(row.data, 'reason', 'TEST_EXECUTION_SUITE_MEMBER_SNAPSHOT_INVALID'),
  }
}

function assertUniqueOrdinals(values: Array<{ ordinal: number }>, code: string) {
  if (
    new Set(values.map(value => value.ordinal)).size !== values.length
    || values.some(value => !Number.isInteger(value.ordinal) || value.ordinal < 0)
  ) {
    throw new Error(code)
  }
}

function canonicalOptionalSha256(value: unknown) {
  return value === null || value === undefined ? undefined : canonicalSha256(value)
}

function requiredString(record: Record<string, unknown>, key: string, code: string) {
  const value = record?.[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(code)
  return value
}

function optionalString(record: Record<string, unknown>, key: string) {
  const value = record?.[key]
  return typeof value === 'string' && value ? value : undefined
}

function caseRevisionKey(caseId: string, revision: number) {
  return `${caseId}\u0000${revision}`
}

async function insertRun(
  client: PoolClient,
  run: ExecutionRun,
  aggregateSha256: string,
  createRequestSha256: string,
) {
  const snapshotBase = executionRunSnapshotBase(run)
  const snapshotCanonical = canonicalJson(snapshotBase)
  const createRequestCanonical =
    executionCreateRequestCanonical(run)
  await client.query(`
    INSERT INTO smarthub.test_execution_runs (
      id,project_id,project_version_id,handoff_id,handoff_sha256,test_case_library_version_id,test_case_library_version_sha256,
      suite_version_id,suite_version_sha256,execution_mode,member_snapshot_sha256,environment_id,environment_signature,snapshot_sha256,aggregate_sha256,create_request_sha256,create_request_canonical,
      status,state_version,idempotency_key,task_count,created_by,created_at,started_at,finished_at,cancel_requested_at,error,snapshot,snapshot_canonical
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28::jsonb,$29)
  `, [run.id, run.projectId, run.projectVersionId, run.handoff.handoffId, run.handoff.handoffSha256, run.handoff.testCaseLibraryVersionId, run.handoff.testCaseLibraryVersionSha256, run.handoff.suiteVersionId ?? null, run.handoff.suiteVersionSha256 ?? null, run.handoff.mode, run.handoff.memberSnapshotSha256, run.environment.environmentId, run.environment.signature, canonicalSha256(snapshotBase), aggregateSha256, createRequestSha256, createRequestCanonical, run.status, run.stateVersion, run.idempotencyKey, run.taskCount, run.createdBy, run.createdAt, run.startedAt ?? null, run.finishedAt ?? null, run.cancelRequestedAt ?? null, run.error ?? null, JSON.stringify(run), snapshotCanonical])
}

async function insertTask(client: PoolClient, task: ExecutionTask) {
  await client.query(`
    INSERT INTO smarthub.test_execution_tasks (
      id,run_id,ordinal,dedup_key,source_version_id,case_id,case_revision,method,dimension,case_content_sha256,execution_spec_sha256,input_sha256,
      status,state_version,runner_attempt_count,same_script_retry_count,repair_count,current_script_revision_id,unsupported_reason,error,created_at,updated_at,finished_at,frozen_input
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb)
  `, [task.id, task.runId, task.input.ordinal, task.input.dedupKey, task.input.sourceVersionId, task.input.caseId, task.input.caseRevision, task.input.method, task.input.dimension, task.input.caseContentSha256, task.input.executionSpecSha256, task.input.inputSha256, task.status, task.stateVersion, task.runnerAttemptCount, task.sameScriptRetryCount, task.repairCount, task.currentScriptRevisionId ?? null, task.unsupportedReason ?? null, task.error ?? null, task.createdAt, task.updatedAt, task.finishedAt ?? null, JSON.stringify({ ...task.input, taskId: task.id, runId: task.runId })])
}

async function insertJob(client: PoolClient, job: ExecutionJob) {
  await client.query(`
    INSERT INTO smarthub.test_execution_jobs (id,run_id,task_id,status,attempt_count,max_attempts,available_at,lease_owner,run_token,fencing_token,lease_expires_at,heartbeat_at,cancel_requested_at,error,created_at,updated_at,data)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
  `, [job.id, job.runId, job.taskId, job.status, job.attempts, job.maxAttempts, job.availableAt, job.leaseOwner ?? null, job.runToken ?? null, job.fencingToken, job.leaseExpiresAt ?? null, job.heartbeatAt ?? null, job.cancelRequestedAt ?? null, job.error ?? null, job.createdAt, job.updatedAt, JSON.stringify(job)])
}

async function insertArtifact(client: PoolClient, artifact: ExecutionArtifact) {
  const inserted = await client.query<ArtifactRow>(`
    INSERT INTO smarthub.test_execution_artifacts (id,run_id,task_id,attempt_id,artifact_type,storage_path,sha256,byte_size,mime_type,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (id) DO NOTHING
    RETURNING *
  `, [artifact.id, artifact.runId, artifact.taskId ?? null, artifact.attemptId ?? null, artifact.type, artifact.storagePath, artifact.sha256, artifact.size, artifact.mimeType, artifact.createdAt])
  if (inserted.rows[0]) return
  const existing = await client.query<ArtifactRow>('SELECT * FROM smarthub.test_execution_artifacts WHERE id=$1', [artifact.id])
  if (!existing.rows[0] || !sameCanonicalRecord(artifactFromRow(existing.rows[0]), artifact)) {
    throw new Error('TEST_EXECUTION_ARTIFACT_CONFLICT')
  }
}

async function insertScriptArtifact(client: PoolClient, artifact: ScriptArtifact) {
  const expectedCacheKey = scriptCacheKey({
    caseId: artifact.caseId,
    caseRevision: artifact.caseRevision,
    method: artifact.method,
    caseContentSha256: artifact.caseContentSha256,
    executionSpecSha256: artifact.executionSpecSha256,
    environmentSignature: artifact.environmentSignature,
    testScriptAgentVersion: artifact.testScriptAgentVersion,
    testScriptAgentConfigurationSha256: artifact.testScriptAgentConfigurationSha256,
  })
  if (artifact.cacheKey !== expectedCacheKey) throw new Error('TEST_EXECUTION_SCRIPT_CACHE_KEY_MISMATCH')
  const inserted = await client.query<ScriptArtifactRow>(`
    INSERT INTO smarthub.test_execution_script_artifacts (id,cache_key,case_id,case_revision,method,case_content_sha256,execution_spec_sha256,environment_signature,test_script_agent_version,test_script_agent_configuration_sha256,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (cache_key) DO NOTHING
    RETURNING *
  `, [artifact.id, artifact.cacheKey, artifact.caseId, artifact.caseRevision, artifact.method, artifact.caseContentSha256, artifact.executionSpecSha256, artifact.environmentSignature, artifact.testScriptAgentVersion, artifact.testScriptAgentConfigurationSha256, artifact.createdAt])
  if (inserted.rows[0]) return scriptArtifactFromRow(inserted.rows[0])
  const existing = await client.query<ScriptArtifactRow>('SELECT * FROM smarthub.test_execution_script_artifacts WHERE cache_key=$1', [artifact.cacheKey])
  if (!existing.rows[0]) throw new Error('TEST_EXECUTION_SCRIPT_ARTIFACT_CONFLICT')
  const resolved = scriptArtifactFromRow(existing.rows[0])
  if (resolved.cacheKey !== expectedCacheKey) throw new Error('TEST_EXECUTION_SCRIPT_ARTIFACT_CONFLICT')
  return resolved
}

async function insertScriptRevision(client: PoolClient, revision: ScriptRevision) {
  await validateScriptRevisionSources(client, revision)
  const { packageSha256, ...packageBase } = revision.package
  const inserted = await client.query<ScriptRevisionRow>(`
    INSERT INTO smarthub.test_execution_script_revisions (id,run_id,task_id,script_artifact_id,revision,parent_revision_id,cache_source_revision_id,generation_source,repair_reason,generated_by,package_manifest,package_canonical,package_sha256,source_artifact_id,content_sha256,protected_assertion_sha256,protected_assertions_canonical,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17,$18)
    ON CONFLICT DO NOTHING
    RETURNING *
  `, [revision.id, revision.runId, revision.taskId, revision.scriptArtifactId, revision.revision, revision.parentRevisionId ?? null, revision.cacheSourceRevisionId ?? null, revision.source, revision.repairReason ?? null, JSON.stringify(revision.generatedBy), JSON.stringify(revision.package), canonicalJson(packageBase), packageSha256, revision.sourceArtifactId, revision.contentSha256, revision.protectedAssertionSha256, canonicalJson(revision.package.assertions), revision.createdAt])
  if (inserted.rows[0]) return
  const conflicts = await client.query<ScriptRevisionRow>(`
    SELECT * FROM smarthub.test_execution_script_revisions
    WHERE id=$1 OR (task_id=$2 AND revision=$3) OR (task_id=$2 AND content_sha256=$4)
  `, [revision.id, revision.taskId, revision.revision, revision.contentSha256])
  if (conflicts.rows.length !== 1 || !sameCanonicalRecord(scriptRevisionFromRow(conflicts.rows[0]), revision)) {
    throw new Error('TEST_EXECUTION_SCRIPT_REVISION_CONFLICT')
  }
}

async function validateScriptRevisionSources(client: PoolClient, revision: ScriptRevision) {
  const context = await client.query<{
    input_sha256: string
    case_id: string
    case_revision: number
    method: TestExecutionMethod
    case_content_sha256: string
    execution_spec_sha256: string
    environment_signature: string
    test_script_agent_snapshot: ScriptRevision['generatedBy']
    script_repair_agent_snapshot: ScriptRevision['generatedBy']
  }>(`
    SELECT task.input_sha256,task.case_id,task.case_revision,task.method,
           task.case_content_sha256,task.execution_spec_sha256,
           run.environment_signature,
           run.snapshot->'agents'->'testScript' AS test_script_agent_snapshot,
           run.snapshot->'agents'->'scriptRepair' AS script_repair_agent_snapshot
    FROM smarthub.test_execution_tasks task
    JOIN smarthub.test_execution_runs run ON run.id=task.run_id
    WHERE task.id=$1 AND task.run_id=$2
    FOR SHARE OF task,run
  `, [revision.taskId, revision.runId])
  const scope = context.rows[0]
  if (!scope) throw new Error('TEST_EXECUTION_SCRIPT_REVISION_SCOPE_MISMATCH')

  const artifact = await client.query<ScriptArtifactRow>(`
    SELECT * FROM smarthub.test_execution_script_artifacts
    WHERE id=$1 FOR SHARE
  `, [revision.scriptArtifactId])
  const cached = artifact.rows[0]
  if (
    !cached
    || cached.case_id !== scope.case_id
    || Number(cached.case_revision) !== Number(scope.case_revision)
    || cached.method !== scope.method
    || cached.case_content_sha256 !== scope.case_content_sha256
    || cached.execution_spec_sha256 !== scope.execution_spec_sha256
    || cached.environment_signature !== scope.environment_signature
    || Number(cached.test_script_agent_version) !== scope.test_script_agent_snapshot.configurationVersion
    || cached.test_script_agent_configuration_sha256 !== scope.test_script_agent_snapshot.configurationSha256
    || canonicalSha256(
      revision.source === 'repair'
        ? scope.script_repair_agent_snapshot
        : scope.test_script_agent_snapshot,
    ) !== canonicalSha256(revision.generatedBy)
    || revision.package.taskInputSha256 !== scope.input_sha256
    || revision.package.caseId !== scope.case_id
    || revision.package.caseRevision !== Number(scope.case_revision)
    || revision.package.method !== scope.method
    || revision.package.caseContentSha256 !== scope.case_content_sha256
    || revision.package.executionSpecSha256 !== scope.execution_spec_sha256
    || revision.package.environmentSignature !== scope.environment_signature
  ) {
    throw new Error('TEST_EXECUTION_SCRIPT_REVISION_SOURCE_MISMATCH')
  }

  const source = await client.query<{ artifact_type: ExecutionArtifact['type']; attempt_id: string | null }>(`
    SELECT artifact_type,attempt_id FROM smarthub.test_execution_artifacts
    WHERE id=$1 AND run_id=$2 AND task_id=$3 AND sha256=$4
    FOR SHARE
  `, [revision.sourceArtifactId, revision.runId, revision.taskId, revision.contentSha256])
  if (source.rows[0]?.artifact_type !== 'script' || source.rows[0].attempt_id !== null) {
    throw new Error('TEST_EXECUTION_SCRIPT_REVISION_SOURCE_ARTIFACT_INVALID')
  }

  if (revision.source === 'cache') {
    if (!revision.cacheSourceRevisionId) {
      throw new Error('TEST_EXECUTION_SCRIPT_CACHE_PROVENANCE_REQUIRED')
    }
    const sourceRevision = await client.query<{
      script_artifact_id: string
      generation_source: ScriptRevision['source']
      content_sha256: string
      protected_assertion_sha256: string
    }>(`
      SELECT script_artifact_id,generation_source,content_sha256,
             protected_assertion_sha256
      FROM smarthub.test_execution_script_revisions
      WHERE id=$1 FOR SHARE
    `, [revision.cacheSourceRevisionId])
    const sourceRevisionRow = sourceRevision.rows[0]
    if (
      !sourceRevisionRow
      || sourceRevisionRow.generation_source === 'cache'
      || sourceRevisionRow.script_artifact_id !== revision.scriptArtifactId
      || sourceRevisionRow.content_sha256 !== revision.contentSha256
      || sourceRevisionRow.protected_assertion_sha256
        !== revision.protectedAssertionSha256
    ) {
      throw new Error('TEST_EXECUTION_SCRIPT_CACHE_PROVENANCE_INVALID')
    }
  } else if (revision.cacheSourceRevisionId) {
    throw new Error('TEST_EXECUTION_SCRIPT_CACHE_PROVENANCE_FORBIDDEN')
  }

  if (revision.source === 'repair') {
    if (!revision.parentRevisionId || revision.revision <= 1) {
      throw new Error('TEST_EXECUTION_SCRIPT_REVISION_PARENT_INVALID')
    }
    const parent = await client.query<{
      revision: number
      protected_assertion_sha256: string
      assertions: ScriptRevision['package']['assertions']
    }>(`
      SELECT revision,protected_assertion_sha256,
             package_manifest->'assertions' AS assertions
      FROM smarthub.test_execution_script_revisions
      WHERE id=$1 AND run_id=$2 AND task_id=$3
      FOR SHARE
    `, [revision.parentRevisionId, revision.runId, revision.taskId])
    if (Number(parent.rows[0]?.revision) !== revision.revision - 1) {
      throw new Error('TEST_EXECUTION_SCRIPT_REVISION_PARENT_INVALID')
    }
    if (
      parent.rows[0].protected_assertion_sha256 !== revision.protectedAssertionSha256
      || canonicalSha256(parent.rows[0].assertions) !== canonicalSha256(revision.package.assertions)
    ) {
      throw new Error('TEST_EXECUTION_SCRIPT_REVISION_ASSERTIONS_CHANGED')
    }
  } else if (revision.parentRevisionId || revision.revision !== 1) {
    throw new Error('TEST_EXECUTION_SCRIPT_REVISION_PARENT_INVALID')
  }
}

async function insertAttempt(client: PoolClient, attempt: ExecutionAttempt) {
  if (
    attempt.status !== 'running'
    || attempt.finishedAt !== undefined
    || attempt.durationMs !== undefined
    || attempt.exitCode !== undefined
    || attempt.summary !== undefined
    || attempt.error !== undefined
  ) {
    throw new Error('TEST_EXECUTION_ATTEMPT_MUST_START_RUNNING')
  }
  const inserted = await client.query<AttemptRow>(`
    INSERT INTO smarthub.test_execution_attempts (id,run_id,task_id,ordinal,invocation_key,attempt_kind,script_revision_id,package_sha256,status,started_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'running',$9)
    ON CONFLICT DO NOTHING
    RETURNING *
  `, [attempt.id, attempt.runId, attempt.taskId, attempt.ordinal, attempt.invocationKey, attempt.kind, attempt.scriptRevisionId, attempt.packageSha256, attempt.startedAt])
  if (inserted.rows[0]) return
  const conflicts = await client.query<AttemptRow>(`
    SELECT * FROM smarthub.test_execution_attempts
    WHERE id=$1 OR invocation_key=$2 OR (task_id=$3 AND ordinal=$4)
  `, [attempt.id, attempt.invocationKey, attempt.taskId, attempt.ordinal])
  if (conflicts.rows.length !== 1 || !sameAttemptInvocation(attemptFromRow(conflicts.rows[0]), attempt)) {
    throw new Error('TEST_EXECUTION_ATTEMPT_CONFLICT')
  }
}

async function finalizeAttempt(client: PoolClient, input: { attemptId: string; status: Exclude<ExecutionAttempt['status'], 'running'>; finishedAt: string; durationMs: number; exitCode?: number; summary?: string; error?: string }, scope: ExecutionLeaseScope) {
  const result = await client.query<AttemptRow>(`
    UPDATE smarthub.test_execution_attempts SET status=$2,finished_at=$3,duration_ms=$4,exit_code=$5,summary=$6,error=$7
    WHERE id=$1 AND run_id=$8 AND task_id=$9 AND status='running' AND finished_at IS NULL RETURNING *
  `, [input.attemptId, input.status, input.finishedAt, input.durationMs, input.exitCode ?? null, input.summary ?? null, input.error ?? null, scope.runId, scope.taskId])
  if (result.rows[0]) return attemptFromRow(result.rows[0])
  const existing = await client.query<AttemptRow>('SELECT * FROM smarthub.test_execution_attempts WHERE id=$1 AND run_id=$2 AND task_id=$3', [input.attemptId, scope.runId, scope.taskId])
  if (!existing.rows[0] || !sameAttemptFinalization(attemptFromRow(existing.rows[0]), input)) {
    throw new Error('TEST_EXECUTION_ATTEMPT_ALREADY_FINALIZED')
  }
  return attemptFromRow(existing.rows[0])
}

async function insertDiagnosis(client: PoolClient, diagnosis: FailureDiagnosis) {
  if (
    (diagnosis.source === 'agent') !== Boolean(diagnosis.agent)
    || (diagnosis.source === 'agent' && diagnosis.agent?.agentKey !== 'failure-analysis')
  ) {
    throw new Error('TEST_EXECUTION_DIAGNOSIS_SOURCE_INVALID')
  }
  if (diagnosis.source === 'agent') {
    const run = await client.query<{ failure_analysis_agent: FailureDiagnosis['agent'] }>(`
      SELECT snapshot->'agents'->'failureAnalysis' AS failure_analysis_agent
      FROM smarthub.test_execution_runs WHERE id=$1 FOR SHARE
    `, [diagnosis.runId])
    if (!run.rows[0]?.failure_analysis_agent
      || canonicalSha256(run.rows[0].failure_analysis_agent) !== canonicalSha256(diagnosis.agent)) {
      throw new Error('TEST_EXECUTION_DIAGNOSIS_AGENT_MISMATCH')
    }
  }
  if (
    !diagnosis.attemptIds.length
    || new Set(diagnosis.attemptIds).size !== diagnosis.attemptIds.length
    || diagnosis.attemptIds.some(attemptId => typeof attemptId !== 'string' || !attemptId)
  ) {
    throw new Error('TEST_EXECUTION_DIAGNOSIS_ATTEMPTS_INVALID')
  }
  const attempts = await client.query<{ id: string }>(`
    SELECT id FROM smarthub.test_execution_attempts
    WHERE run_id=$1 AND task_id=$2 AND script_revision_id=$3
      AND id=ANY($4::text[]) AND status<>'running'
    ORDER BY id
    FOR SHARE
  `, [diagnosis.runId, diagnosis.taskId, diagnosis.scriptRevisionId, diagnosis.attemptIds])
  if (attempts.rows.length !== diagnosis.attemptIds.length) {
    throw new Error('TEST_EXECUTION_DIAGNOSIS_ATTEMPT_SCOPE_MISMATCH')
  }
  const attemptIds = new Set(diagnosis.attemptIds)
  if (!diagnosis.evidence.length || diagnosis.evidence.some(evidence => !attemptIds.has(evidence.attemptId))) {
    throw new Error('TEST_EXECUTION_DIAGNOSIS_EVIDENCE_SCOPE_MISMATCH')
  }
  const artifactEvidence = diagnosis.evidence.filter(evidence => evidence.artifactId)
  if (artifactEvidence.length) {
    const artifactIds = [...new Set(artifactEvidence.map(evidence => evidence.artifactId!))]
    const artifacts = await client.query<{ id: string; attempt_id: string | null }>(`
      SELECT id,attempt_id FROM smarthub.test_execution_artifacts
      WHERE run_id=$1 AND task_id=$2 AND id=ANY($3::text[])
      FOR SHARE
    `, [diagnosis.runId, diagnosis.taskId, artifactIds])
    const artifactAttemptById = new Map(artifacts.rows.map(artifact => [artifact.id, artifact.attempt_id]))
    if (artifactEvidence.some(evidence => artifactAttemptById.get(evidence.artifactId!) !== evidence.attemptId)) {
      throw new Error('TEST_EXECUTION_DIAGNOSIS_EVIDENCE_SCOPE_MISMATCH')
    }
  }

  const inserted = await client.query<{ id: string }>(`
    INSERT INTO smarthub.test_execution_diagnoses (id,run_id,task_id,script_revision_id,attempt_count,evidence_count,category,confidence,summary,repairable,recommended_action,source,agent_snapshot,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `, [diagnosis.id, diagnosis.runId, diagnosis.taskId, diagnosis.scriptRevisionId, diagnosis.attemptIds.length, diagnosis.evidence.length, diagnosis.category, diagnosis.confidence, diagnosis.summary, diagnosis.repairable, diagnosis.recommendedAction, diagnosis.source, diagnosis.agent ? JSON.stringify(diagnosis.agent) : null, diagnosis.createdAt])
  if (inserted.rows[0]) {
    await insertDiagnosisChildren(client, diagnosis)
    return
  }
  const existing = await client.query<DiagnosisRow>(`${diagnosisSelectSql}
    WHERE diagnosis.id=$1
  `, [diagnosis.id])
  if (!existing.rows[0] || !sameCanonicalRecord(diagnosisFromRow(existing.rows[0]), diagnosis)) {
    throw new Error('TEST_EXECUTION_DIAGNOSIS_CONFLICT')
  }
}

async function insertDiagnosisChildren(client: PoolClient, diagnosis: FailureDiagnosis) {
  for (const [ordinal, attemptId] of diagnosis.attemptIds.entries()) {
    await client.query(`
      INSERT INTO smarthub.test_execution_diagnosis_attempts
        (diagnosis_id,run_id,task_id,script_revision_id,attempt_id,ordinal)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [diagnosis.id, diagnosis.runId, diagnosis.taskId, diagnosis.scriptRevisionId, attemptId, ordinal])
  }
  for (const [ordinal, evidence] of diagnosis.evidence.entries()) {
    await client.query(`
      INSERT INTO smarthub.test_execution_diagnosis_evidence
        (diagnosis_id,run_id,task_id,script_revision_id,ordinal,attempt_id,artifact_id,observation)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [diagnosis.id, diagnosis.runId, diagnosis.taskId, diagnosis.scriptRevisionId, ordinal, evidence.attemptId, evidence.artifactId ?? null, evidence.observation])
  }
}

function validateAggregate(input: CreateExecutionAggregateInput) {
  const { run, tasks, jobs } = input
  if (!tasks.length || run.taskCount !== tasks.length) throw new Error('TEST_EXECUTION_TASK_COUNT_MISMATCH')
  if (run.status !== 'queued' || run.stateVersion !== 0 || run.startedAt || run.finishedAt || run.cancelRequestedAt) {
    throw new Error('TEST_EXECUTION_RUN_INITIAL_STATE_INVALID')
  }
  if (run.projectId !== run.handoff.projectId || run.projectVersionId !== run.handoff.projectVersionId) {
    throw new Error('TEST_EXECUTION_HANDOFF_SCOPE_MISMATCH')
  }
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error('TEST_EXECUTION_TASK_ID_DUPLICATE')
  const ordinals = tasks.map(task => task.input.ordinal)
  if (new Set(ordinals).size !== tasks.length || ordinals.some(ordinal => !Number.isInteger(ordinal) || ordinal < 0)) {
    throw new Error('TEST_EXECUTION_TASK_ORDINAL_INVALID')
  }
  for (const task of tasks) {
    if (task.runId !== run.id) throw new Error('TEST_EXECUTION_TASK_RUN_MISMATCH')
    if (task.stateVersion !== 0 || task.runnerAttemptCount !== 0 || task.sameScriptRetryCount !== 0 || task.repairCount !== 0 || task.currentScriptRevisionId) {
      throw new Error('TEST_EXECUTION_TASK_INITIAL_STATE_INVALID')
    }
    const { inputSha256, ...frozenInput } = task.input
    if (canonicalSha256(frozenInput) !== inputSha256) throw new Error('TEST_EXECUTION_TASK_INPUT_HASH_MISMATCH')
    if (canonicalSha256(task.input.caseContent) !== task.input.caseContentSha256) throw new Error('TEST_EXECUTION_CASE_CONTENT_HASH_MISMATCH')
    if (canonicalSha256(task.input.executionSpec) !== task.input.executionSpecSha256) throw new Error('TEST_EXECUTION_SPEC_HASH_MISMATCH')
    if (task.input.executionSpec.method !== task.input.method || task.input.caseContent.dimension !== task.input.dimension) {
      throw new Error('TEST_EXECUTION_TASK_SEMANTICS_MISMATCH')
    }
    const unsupportedReason = unsupportedExecutionMethodReason(task.input.method)
    if (unsupportedReason) {
      if (task.status !== 'unsupported' || task.unsupportedReason !== unsupportedReason || !task.finishedAt) {
        throw new Error('TEST_EXECUTION_UNSUPPORTED_TASK_INVALID')
      }
    } else if (task.status !== 'pending' || task.unsupportedReason || task.finishedAt) {
      throw new Error('TEST_EXECUTION_EXECUTABLE_TASK_INVALID')
    }
  }
  const memberSnapshot = tasks
    .slice()
    .sort((left, right) => left.input.ordinal - right.input.ordinal)
    .map(task => task.input)
  if (canonicalSha256(memberSnapshot) !== run.handoff.memberSnapshotSha256) {
    throw new Error('TEST_EXECUTION_MEMBER_SNAPSHOT_HASH_MISMATCH')
  }
  const executableTaskIds = new Set(tasks.filter(task => task.status !== 'unsupported').map(task => task.id))
  if (jobs.some(job => job.runId !== run.id || !executableTaskIds.has(job.taskId))) throw new Error('TEST_EXECUTION_JOB_TASK_MISMATCH')
  if (jobs.length !== executableTaskIds.size || new Set(jobs.map(job => job.id)).size !== jobs.length || new Set(jobs.map(job => job.taskId)).size !== jobs.length) {
    throw new Error('TEST_EXECUTION_JOB_COVERAGE_INVALID')
  }
  if (jobs.some(job => job.status !== 'queued' || job.attempts !== 0 || job.fencingToken !== 0 || job.leaseOwner || job.runToken || job.leaseExpiresAt || job.heartbeatAt || job.cancelRequestedAt)) {
    throw new Error('TEST_EXECUTION_JOB_INITIAL_STATE_INVALID')
  }
}

function executionRunSnapshotBase(run: ExecutionRun) {
  return {
    schemaVersion: 'test-execution-run-snapshot/v1',
    projectId: run.projectId,
    projectVersionId: run.projectVersionId,
    handoff: run.handoff,
    environment: run.environment,
    runner: run.runner,
    agents: run.agents,
    taskCount: run.taskCount,
    createdBy: run.createdBy,
  }
}

function executionAggregateSha256(input: CreateExecutionAggregateInput) {
  return canonicalSha256({
    schemaVersion: 'test-execution-aggregate/v1',
    run: input.run,
    tasks: input.tasks
      .slice()
      .sort((left, right) => left.input.ordinal - right.input.ordinal || left.id.localeCompare(right.id)),
    jobs: input.jobs
      .slice()
      .sort((left, right) => left.taskId.localeCompare(right.taskId) || left.id.localeCompare(right.id)),
  })
}

function assertLeaseTask(scope: ExecutionLeaseScope, taskId: string) {
  if (taskId !== scope.taskId) throw new Error('TEST_EXECUTION_LEASE_SCOPE_MISMATCH')
}

function assertLeaseAggregate(scope: ExecutionLeaseScope, runId: string, taskId?: string) {
  if (runId !== scope.runId || taskId !== scope.taskId) throw new Error('TEST_EXECUTION_LEASE_SCOPE_MISMATCH')
}

async function notifyExecutionTask(client: PoolClient) {
  await client.query("SELECT pg_notify('smarthub_task_ready', 'test_execution')")
}

function runFromRow(row: { snapshot: ExecutionRun; status: ExecutionRunStatus; state_version: number; started_at: Date | string | null; finished_at: Date | string | null; cancel_requested_at: Date | string | null; error: string | null }): ExecutionRun {
  return {
    ...structuredClone(row.snapshot),
    status: row.status,
    stateVersion: Number(row.state_version),
    ...(row.started_at ? { startedAt: iso(row.started_at) } : {}),
    ...(row.finished_at ? { finishedAt: iso(row.finished_at) } : {}),
    ...(row.cancel_requested_at ? { cancelRequestedAt: iso(row.cancel_requested_at) } : {}),
    ...(row.error ? { error: row.error } : {}),
  }
}

function taskFromRow(row: { frozen_input: ExecutionTask['input'] & { taskId?: string; runId?: string }; status: ExecutionTaskStatus; state_version: number; runner_attempt_count: number; same_script_retry_count: number; repair_count: number; current_script_revision_id: string | null; unsupported_reason: string | null; error: string | null; created_at: Date | string; updated_at: Date | string; finished_at: Date | string | null }): ExecutionTask {
  const input = structuredClone(row.frozen_input)
  const id = input.taskId
  const runId = input.runId
  delete input.taskId
  delete input.runId
  if (!id || !runId) throw new Error('TEST_EXECUTION_TASK_SNAPSHOT_INVALID')
  return {
    id,
    runId,
    input,
    status: row.status,
    stateVersion: Number(row.state_version),
    runnerAttemptCount: Number(row.runner_attempt_count),
    sameScriptRetryCount: Number(row.same_script_retry_count),
    repairCount: Number(row.repair_count),
    ...(row.current_script_revision_id ? { currentScriptRevisionId: row.current_script_revision_id } : {}),
    ...(row.unsupported_reason ? { unsupportedReason: row.unsupported_reason } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.finished_at ? { finishedAt: iso(row.finished_at) } : {}),
  }
}

type ScriptArtifactRow = {
  id: string; cache_key: string; case_id: string; case_revision: number; method: ScriptArtifact['method']; case_content_sha256: string; execution_spec_sha256: string; environment_signature: string; test_script_agent_version: number; test_script_agent_configuration_sha256: string; created_at: Date | string
}
function scriptArtifactFromRow(row: ScriptArtifactRow): ScriptArtifact {
  return { id: row.id, cacheKey: row.cache_key, caseId: row.case_id, caseRevision: Number(row.case_revision), method: row.method, caseContentSha256: row.case_content_sha256, executionSpecSha256: row.execution_spec_sha256, environmentSignature: row.environment_signature, testScriptAgentVersion: Number(row.test_script_agent_version), testScriptAgentConfigurationSha256: row.test_script_agent_configuration_sha256, createdAt: iso(row.created_at) }
}

type ScriptRevisionRow = {
  id: string; run_id: string; task_id: string; script_artifact_id: string; revision: number; parent_revision_id: string | null; cache_source_revision_id: string | null; generation_source: ScriptRevision['source']; repair_reason: string | null; generated_by: ScriptRevision['generatedBy']; package_manifest: ScriptRevision['package']; package_sha256: string; source_artifact_id: string; content_sha256: string; protected_assertion_sha256: string; created_at: Date | string
}
function scriptRevisionFromRow(row: ScriptRevisionRow): ScriptRevision {
  return { id: row.id, runId: row.run_id, taskId: row.task_id, scriptArtifactId: row.script_artifact_id, revision: Number(row.revision), ...(row.parent_revision_id ? { parentRevisionId: row.parent_revision_id } : {}), ...(row.cache_source_revision_id ? { cacheSourceRevisionId: row.cache_source_revision_id } : {}), source: row.generation_source, ...(row.repair_reason ? { repairReason: row.repair_reason } : {}), generatedBy: structuredClone(row.generated_by), package: structuredClone(row.package_manifest), sourceArtifactId: row.source_artifact_id, contentSha256: row.content_sha256, protectedAssertionSha256: row.protected_assertion_sha256, createdAt: iso(row.created_at) }
}

type ArtifactRow = {
  id: string; run_id: string; task_id: string | null; attempt_id: string | null; artifact_type: ExecutionArtifact['type']; storage_path: string; sha256: string; byte_size: number | string; mime_type: string; created_at: Date | string
}
function artifactFromRow(row: ArtifactRow): ExecutionArtifact {
  return { id: row.id, runId: row.run_id, ...(row.task_id ? { taskId: row.task_id } : {}), ...(row.attempt_id ? { attemptId: row.attempt_id } : {}), type: row.artifact_type, storagePath: row.storage_path, sha256: row.sha256, size: Number(row.byte_size), mimeType: row.mime_type, createdAt: iso(row.created_at) }
}

type AttemptRow = {
  id: string; run_id: string; task_id: string; ordinal: number; invocation_key: string; attempt_kind: ExecutionAttempt['kind']; script_revision_id: string; package_sha256: string; status: ExecutionAttempt['status']; started_at: Date | string; finished_at: Date | string | null; duration_ms: number | string | null; exit_code: number | null; summary: string | null; error: string | null
}
function attemptFromRow(row: AttemptRow): ExecutionAttempt {
  return { id: row.id, runId: row.run_id, taskId: row.task_id, ordinal: Number(row.ordinal), invocationKey: row.invocation_key, kind: row.attempt_kind, scriptRevisionId: row.script_revision_id, packageSha256: row.package_sha256, status: row.status, startedAt: iso(row.started_at), ...(row.finished_at ? { finishedAt: iso(row.finished_at) } : {}), ...(row.duration_ms !== null ? { durationMs: Number(row.duration_ms) } : {}), ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}), ...(row.summary ? { summary: row.summary } : {}), ...(row.error ? { error: row.error } : {}) }
}

function sameCanonicalRecord(existing: unknown, candidate: unknown) {
  return canonicalSha256(normalizeTemporalRecord(existing)) === canonicalSha256(normalizeTemporalRecord(candidate))
}

function normalizeTemporalRecord(value: unknown, key?: string): unknown {
  if (typeof value === 'string' && key?.endsWith('At')) {
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value
  }
  if (Array.isArray(value)) return value.map(item => normalizeTemporalRecord(item))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([entryKey, entryValue]) => [entryKey, normalizeTemporalRecord(entryValue, entryKey)]),
  )
}

function sameTimestamp(left: string | undefined, right: string | undefined) {
  if (left === undefined || right === undefined) return left === right
  const leftTimestamp = Date.parse(left)
  const rightTimestamp = Date.parse(right)
  return Number.isFinite(leftTimestamp) && leftTimestamp === rightTimestamp
}

function sameAttemptInvocation(existing: ExecutionAttempt, candidate: ExecutionAttempt) {
  return existing.id === candidate.id
    && existing.runId === candidate.runId
    && existing.taskId === candidate.taskId
    && existing.ordinal === candidate.ordinal
    && existing.invocationKey === candidate.invocationKey
    && existing.kind === candidate.kind
    && existing.scriptRevisionId === candidate.scriptRevisionId
    && existing.packageSha256 === candidate.packageSha256
    && candidate.status === 'running'
    && candidate.finishedAt === undefined
    && sameTimestamp(existing.startedAt, candidate.startedAt)
}

function sameAttemptFinalization(existing: ExecutionAttempt, candidate: {
  status: Exclude<ExecutionAttempt['status'], 'running'>
  finishedAt: string
  durationMs: number
  exitCode?: number
  summary?: string
  error?: string
}) {
  return existing.status === candidate.status
    && sameTimestamp(existing.finishedAt, candidate.finishedAt)
    && existing.durationMs === candidate.durationMs
    && existing.exitCode === candidate.exitCode
    && existing.summary === candidate.summary
    && existing.error === candidate.error
}

const diagnosisSelectSql = `
  SELECT diagnosis.*,
    COALESCE((
      SELECT jsonb_agg(binding.attempt_id ORDER BY binding.ordinal)
      FROM smarthub.test_execution_diagnosis_attempts binding
      WHERE binding.diagnosis_id=diagnosis.id
    ), '[]'::jsonb) AS attempt_ids,
    COALESCE((
      SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'attemptId',evidence.attempt_id,
        'artifactId',evidence.artifact_id,
        'observation',evidence.observation
      )) ORDER BY evidence.ordinal)
      FROM smarthub.test_execution_diagnosis_evidence evidence
      WHERE evidence.diagnosis_id=diagnosis.id
    ), '[]'::jsonb) AS evidence
  FROM smarthub.test_execution_diagnoses diagnosis
`

type DiagnosisRow = {
  id: string; run_id: string; task_id: string; script_revision_id: string; attempt_ids: string[]; category: FailureDiagnosis['category']; confidence: number; summary: string; evidence: FailureDiagnosis['evidence']; repairable: boolean; recommended_action: string; source: FailureDiagnosis['source']; agent_snapshot: FailureDiagnosis['agent'] | null; created_at: Date | string
}
function diagnosisFromRow(row: DiagnosisRow): FailureDiagnosis {
  return { id: row.id, runId: row.run_id, taskId: row.task_id, scriptRevisionId: row.script_revision_id, attemptIds: row.attempt_ids, category: row.category, confidence: Number(row.confidence), summary: row.summary, evidence: structuredClone(row.evidence), repairable: row.repairable, recommendedAction: row.recommended_action, source: row.source, ...(row.agent_snapshot ? { agent: structuredClone(row.agent_snapshot) } : {}), createdAt: iso(row.created_at) }
}

type JobRow = {
  id: string; run_id: string; task_id: string; status: ExecutionJob['status']; attempt_count: number; max_attempts: number; available_at: Date | string; lease_owner: string | null; run_token: string | null; fencing_token: number | string; lease_expires_at: Date | string | null; heartbeat_at: Date | string | null; cancel_requested_at: Date | string | null; error: string | null; created_at: Date | string; updated_at: Date | string; data?: ExecutionJob
}
function jobFromRow(row: JobRow): ExecutionJob {
  const request = row.data?.request
  return { id: row.id, runId: row.run_id, taskId: row.task_id, status: row.status, attempts: Number(row.attempt_count), maxAttempts: Number(row.max_attempts), availableAt: iso(row.available_at), fencingToken: Number(row.fencing_token), ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}), ...(row.run_token ? { runToken: row.run_token } : {}), ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}), ...(row.heartbeat_at ? { heartbeatAt: iso(row.heartbeat_at) } : {}), ...(row.cancel_requested_at ? { cancelRequestedAt: iso(row.cancel_requested_at) } : {}), ...(row.error ? { error: row.error } : {}), ...(request ? { request: structuredClone(request) } : {}), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}
