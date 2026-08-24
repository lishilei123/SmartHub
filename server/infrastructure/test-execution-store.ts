import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { canonicalJson, canonicalSha256 } from '../application/canonical-json.js'
import {
  aggregateExecutionRunStatus,
  assertTaskTransition,
  executionCreateRequestCanonical,
  executionCreateRequestSha256,
} from '../application/test-execution-validation.js'
import type { AgentExecutionAggregateResult } from '../domain/agent-test-types.js'
import type {
  ExecutionJob,
  ExecutionRun,
  ExecutionRunStatus,
  ExecutionTask,
  ExecutionTaskStatus,
} from '../domain/test-execution-types.js'

export interface ExecutionJobLease {
  workerId: string
  runToken: string
  fencingToken: number
}

interface ExecutionLeaseScope { runId: string; taskId: string }

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
    error?: string
    finishedAt?: string
  }): Promise<ExecutionTask>
  appendAgentExecutionResult(result: AgentExecutionAggregateResult): Promise<void>
  recomputeRun(runId: string): Promise<ExecutionRun>
}

export interface ExecutionTaskDetailSnapshot {
  run: ExecutionRun
  task: ExecutionTask
  agentExecutionResult?: AgentExecutionAggregateResult
}

export interface TestExecutionReportSource {
  run: ExecutionRun
  tasks: ExecutionTask[]
  agentExecutionResults: AgentExecutionAggregateResult[]
}

export interface TestExecutionReportSourceReader {
  listRuns(projectVersionId: string, limit: number): Promise<ExecutionRun[]>
  getRun(runId: string): Promise<ExecutionRun | null>
  getRunReportSource(runId: string): Promise<TestExecutionReportSource | null>
}

export interface TestExecutionStore extends TestExecutionReportSourceReader {
  readiness(): Promise<{ ready: boolean; reason?: string }>
  createAggregate(input: CreateExecutionAggregateInput): Promise<ExecutionRun>
  getRunByIdempotencyKey(projectVersionId: string, idempotencyKey: string): Promise<ExecutionRun | null>
  listTasks(runId: string): Promise<ExecutionTask[]>
  getTask(taskId: string): Promise<ExecutionTask | null>
  getTaskDetail(taskId: string): Promise<ExecutionTaskDetailSnapshot | null>
  getAgentExecutionResult(taskId: string): Promise<AgentExecutionAggregateResult | null>
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

  constructor(connectionString: string) { this.pool = new Pool({ connectionString }) }
  async close() { await this.pool.end() }

  async readiness() {
    try {
      await this.pool.query('SELECT 1 FROM smarthub.agent_execution_results LIMIT 0')
      return { ready: true }
    } catch { return { ready: false, reason: 'AGENT_TEST_POSTGRES_UNAVAILABLE' } }
  }

  async createAggregate(input: CreateExecutionAggregateInput): Promise<ExecutionRun> {
    validateAggregate(input)
    const createRequestSha256 = executionCreateRequestSha256(input.run)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const existing = await getRunByIdempotencyKey(client, input.run.projectVersionId, input.run.idempotencyKey)
      if (existing) {
        if (executionCreateRequestSha256(existing) !== createRequestSha256) throw new Error('TEST_EXECUTION_IDEMPOTENCY_CONFLICT')
        await client.query('COMMIT')
        return existing
      }
      await insertRun(client, input.run, canonicalSha256(input), createRequestSha256)
      for (const task of input.tasks) await insertTask(client, task)
      for (const job of input.jobs) await insertJob(client, job)
      if (input.jobs.length) await client.query("SELECT pg_notify('smarthub_test_execution_jobs', $1)", [input.run.id])
      await client.query('COMMIT')
      return structuredClone(input.run)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async getRun(runId: string) { return getRun(this.pool, runId) }
  async getRunByIdempotencyKey(projectVersionId: string, idempotencyKey: string) { return getRunByIdempotencyKey(this.pool, projectVersionId, idempotencyKey) }

  async listRuns(projectVersionId: string, limit: number) {
    const result = await this.pool.query<RunRow>(`
      SELECT snapshot,status,state_version,started_at,finished_at,cancel_requested_at,error
      FROM smarthub.test_execution_runs
      WHERE project_version_id=$1
      ORDER BY created_at DESC,id DESC
      LIMIT $2
    `, [projectVersionId, Math.min(200, Math.max(1, limit))])
    return result.rows.map(runFromRow)
  }

  async listTasks(runId: string) {
    const result = await this.pool.query<TaskRow>(`${taskSelect} WHERE run_id=$1 ORDER BY ordinal,id`, [runId])
    return result.rows.map(taskFromRow)
  }

  async getTask(taskId: string) {
    const result = await this.pool.query<TaskRow>(`${taskSelect} WHERE id=$1`, [taskId])
    return result.rows[0] ? taskFromRow(result.rows[0]) : null
  }

  async getTaskDetail(taskId: string): Promise<ExecutionTaskDetailSnapshot | null> {
    const task = await this.getTask(taskId)
    if (!task) return null
    const [run, agentExecutionResult] = await Promise.all([this.getRun(task.runId), this.getAgentExecutionResult(taskId)])
    if (!run) throw new Error('TEST_EXECUTION_RUN_NOT_FOUND')
    return { run, task, ...(agentExecutionResult ? { agentExecutionResult } : {}) }
  }

  async getAgentExecutionResult(taskId: string) {
    const result = await this.pool.query<{ data: AgentExecutionAggregateResult }>('SELECT data FROM smarthub.agent_execution_results WHERE task_id=$1', [taskId])
    return result.rows[0]?.data ? structuredClone(result.rows[0].data) : null
  }

  async getRunReportSource(runId: string): Promise<TestExecutionReportSource | null> {
    const run = await this.getRun(runId)
    if (!run) return null
    const tasks = await this.listTasks(runId)
    const result = await this.pool.query<{ data: AgentExecutionAggregateResult }>('SELECT data FROM smarthub.agent_execution_results WHERE run_id=$1 ORDER BY task_id', [runId])
    return { run, tasks, agentExecutionResults: result.rows.map(row => structuredClone(row.data)) }
  }

  async claimJob(workerId: string, leaseMs: number): Promise<ExecutionJob | null> {
    if (!workerId.trim() || !Number.isInteger(leaseMs) || leaseMs < 1_000) throw new Error('TEST_EXECUTION_JOB_LEASE_INVALID')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await requeueExpiredJobs(client)
      const runToken = randomUUID()
      const result = await client.query<JobRow>(`
        WITH candidate AS (
          SELECT job.id
          FROM smarthub.test_execution_jobs job
          JOIN smarthub.test_execution_runs run ON run.id=job.run_id
          JOIN smarthub.test_execution_tasks task ON task.id=job.task_id
          WHERE job.status='queued' AND job.available_at<=now()
            AND run.status IN ('queued','running') AND run.cancel_requested_at IS NULL
            AND task.status IN ('pending','running')
          ORDER BY job.available_at,job.created_at,job.id
          FOR UPDATE OF job SKIP LOCKED
          LIMIT 1
        )
        UPDATE smarthub.test_execution_jobs job
        SET status='running',attempt_count=job.attempt_count+1,lease_owner=$1,run_token=$2::uuid,
            fencing_token=job.fencing_token+1,lease_expires_at=now()+($3::bigint*interval '1 millisecond'),
            heartbeat_at=now(),started_at=COALESCE(job.started_at,now()),finished_at=NULL,error=NULL,updated_at=now(),
            data=jsonb_set(jsonb_set(jsonb_set(job.data,'{status}','\"running\"'::jsonb),'{attempts}',to_jsonb(job.attempt_count+1)),'{updatedAt}',to_jsonb(now()::text))
        FROM candidate
        WHERE job.id=candidate.id
        RETURNING job.*
      `, [workerId, runToken, leaseMs])
      await client.query('COMMIT')
      return result.rows[0] ? jobFromRow(result.rows[0]) : null
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async heartbeatJob(jobId: string, lease: ExecutionJobLease, leaseMs: number) {
    const result = await this.pool.query(`
      UPDATE smarthub.test_execution_jobs
      SET heartbeat_at=now(),lease_expires_at=now()+($5::bigint*interval '1 millisecond'),updated_at=now()
      WHERE id=$1 AND status='running' AND lease_owner=$2 AND run_token=$3::uuid AND fencing_token=$4
    `, [jobId, lease.workerId, lease.runToken, lease.fencingToken, leaseMs])
    return (result.rowCount ?? 0) === 1
  }

  async releaseJob(jobId: string, lease: ExecutionJobLease, retryDelayMs: number, error: string) {
    const result = await this.pool.query(`
      UPDATE smarthub.test_execution_jobs
      SET status='queued',available_at=now()+($5::bigint*interval '1 millisecond'),lease_owner=NULL,run_token=NULL,
          lease_expires_at=NULL,heartbeat_at=NULL,error=$6,updated_at=now(),
          data=jsonb_set(jsonb_set(jsonb_set(data,'{status}','\"queued\"'::jsonb),'{error}',to_jsonb($6::text)),'{updatedAt}',to_jsonb(now()::text))
      WHERE id=$1 AND status='running' AND lease_owner=$2 AND run_token=$3::uuid AND fencing_token=$4 AND attempt_count<max_attempts
    `, [jobId, lease.workerId, lease.runToken, lease.fencingToken, retryDelayMs, safeError(error)])
    return (result.rowCount ?? 0) === 1
  }

  async finishJob(jobId: string, lease: ExecutionJobLease, status: 'succeeded' | 'failed' | 'cancelled', error?: string) {
    const result = await this.pool.query(`
      UPDATE smarthub.test_execution_jobs
      SET status=$5,lease_owner=NULL,run_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL,finished_at=now(),error=$6,updated_at=now(),
          data=jsonb_set(jsonb_set(jsonb_set(data,'{status}',to_jsonb($5::text)),'{error}',to_jsonb($6::text)),'{updatedAt}',to_jsonb(now()::text))
      WHERE id=$1 AND status='running' AND lease_owner=$2 AND run_token=$3::uuid AND fencing_token=$4
    `, [jobId, lease.workerId, lease.runToken, lease.fencingToken, status, error ? safeError(error) : null])
    return (result.rowCount ?? 0) === 1
  }

  async cancelRun(runId: string, expectedStateVersion: number, requestedAt: string) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const run = await getRunForUpdate(client, runId)
      if (!run) throw new Error('TEST_EXECUTION_RUN_NOT_FOUND')
      if (run.stateVersion !== expectedStateVersion) throw new Error('TEST_EXECUTION_RUN_STATE_VERSION_CONFLICT')
      if (!['queued', 'running'].includes(run.status)) throw new Error('TEST_EXECUTION_RUN_NOT_CANCELLABLE')
      await client.query(`
        UPDATE smarthub.test_execution_tasks
        SET status='cancelled',state_version=state_version+1,updated_at=$2,finished_at=$2,error=NULL
        WHERE run_id=$1 AND status IN ('pending','running')
      `, [runId, requestedAt])
      await client.query(`
        UPDATE smarthub.test_execution_jobs
        SET status='cancelled',cancel_requested_at=$2,lease_owner=NULL,run_token=NULL,lease_expires_at=NULL,
            heartbeat_at=NULL,finished_at=$2,updated_at=$2
        WHERE run_id=$1 AND status IN ('queued','running')
      `, [runId, requestedAt])
      await client.query(`
        UPDATE smarthub.test_execution_runs
        SET cancel_requested_at=$2,state_version=state_version+1,status='cancelled',finished_at=$2,error=NULL
        WHERE id=$1
      `, [runId, requestedAt])
      const updated = await getRun(client, runId)
      await client.query('COMMIT')
      return updated!
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async retryTask(input: { runId: string; taskId: string; expectedRunStateVersion: number; expectedTaskStateVersion: number; job: ExecutionJob }) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const [run, task] = await Promise.all([getRunForUpdate(client, input.runId), getTaskForUpdate(client, input.taskId)])
      if (!run || !task || task.runId !== run.id) throw new Error('TEST_EXECUTION_TASK_NOT_FOUND')
      if (run.stateVersion !== input.expectedRunStateVersion || task.stateVersion !== input.expectedTaskStateVersion) throw new Error('TEST_EXECUTION_STATE_VERSION_CONFLICT')
      if (!['failed', 'blocked'].includes(task.status)) throw new Error('TEST_EXECUTION_TASK_NOT_RETRYABLE')
      const existing = await client.query('SELECT 1 FROM smarthub.test_execution_jobs WHERE task_id=$1 AND status IN (\'queued\',\'running\')', [task.id])
      if (existing.rowCount) throw new Error('TEST_EXECUTION_RETRY_STATE_CONFLICT')
      const updated = await transitionTask(client, { taskId: task.id, expectedStatus: task.status, expectedStateVersion: task.stateVersion, status: 'pending' })
      await insertJob(client, input.job)
      await client.query(`UPDATE smarthub.test_execution_runs SET status='running',state_version=state_version+1,finished_at=NULL,error=NULL WHERE id=$1`, [run.id])
      await client.query("SELECT pg_notify('smarthub_test_execution_jobs', $1)", [run.id])
      await client.query('COMMIT')
      return updated
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async transactionWithLease<T>(jobId: string, lease: ExecutionJobLease, operation: (transaction: TestExecutionTransaction) => Promise<T>, options: { allowCancellation?: boolean } = {}) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const scope = await lockOwnedJob(client, jobId, lease, Boolean(options.allowCancellation))
      if (!scope) { await client.query('ROLLBACK'); return null }
      const value = await operation(transactionFor(client, scope))
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }
}

function transactionFor(client: PoolClient, scope: ExecutionLeaseScope): TestExecutionTransaction {
  return {
    transitionTask: input => {
      if (input.taskId !== scope.taskId) throw new Error('TEST_EXECUTION_LEASE_TASK_SCOPE_MISMATCH')
      return transitionTask(client, input)
    },
    appendAgentExecutionResult: result => {
      if (result.runId !== scope.runId || result.taskId !== scope.taskId) throw new Error('TEST_EXECUTION_LEASE_TASK_SCOPE_MISMATCH')
      return insertAgentExecutionResult(client, result)
    },
    recomputeRun: runId => {
      if (runId !== scope.runId) throw new Error('TEST_EXECUTION_LEASE_RUN_SCOPE_MISMATCH')
      return recomputeRun(client, runId)
    },
  }
}

async function lockOwnedJob(client: PoolClient, jobId: string, lease: ExecutionJobLease, allowCancellation: boolean) {
  const result = await client.query<{ run_id: string; task_id: string }>(`
    SELECT run_id,task_id FROM smarthub.test_execution_jobs
    WHERE id=$1 AND status='running' AND lease_owner=$2 AND run_token=$3::uuid AND fencing_token=$4
      AND lease_expires_at>now() AND ($5::boolean OR cancel_requested_at IS NULL)
    FOR UPDATE
  `, [jobId, lease.workerId, lease.runToken, lease.fencingToken, allowCancellation])
  return result.rows[0] ? { runId: result.rows[0].run_id, taskId: result.rows[0].task_id } : null
}

async function transitionTask(client: PoolClient, input: { taskId: string; expectedStatus: ExecutionTaskStatus; expectedStateVersion: number; status: ExecutionTaskStatus; error?: string; finishedAt?: string }) {
  assertTaskTransition(input.expectedStatus, input.status)
  const terminal = ['passed', 'failed', 'blocked', 'cancelled'].includes(input.status)
  if (terminal !== Boolean(input.finishedAt)) throw new Error('TEST_EXECUTION_TASK_FINISHED_AT_INVALID')
  const result = await client.query<TaskRow>(`
    UPDATE smarthub.test_execution_tasks
    SET status=$4,state_version=state_version+1,error=$5,updated_at=now(),finished_at=$6
    WHERE id=$1 AND status=$2 AND state_version=$3
    RETURNING frozen_input,status,state_version,error,created_at,updated_at,finished_at
  `, [input.taskId, input.expectedStatus, input.expectedStateVersion, input.status, input.error ?? null, input.finishedAt ?? null])
  if (!result.rows[0]) throw new Error('TEST_EXECUTION_TASK_STATE_VERSION_CONFLICT')
  const task = taskFromRow(result.rows[0])
  await recomputeRun(client, task.runId)
  return task
}

async function recomputeRun(client: PoolClient, runId: string) {
  const run = await getRunForUpdate(client, runId)
  if (!run) throw new Error('TEST_EXECUTION_RUN_NOT_FOUND')
  const tasks = await client.query<{ status: ExecutionTaskStatus }>('SELECT status FROM smarthub.test_execution_tasks WHERE run_id=$1 ORDER BY ordinal', [runId])
  const status = aggregateExecutionRunStatus(tasks.rows.map(row => row.status))
  const startedAt = run.startedAt ?? (status === 'running' ? new Date().toISOString() : undefined)
  const finishedAt = ['succeeded', 'failed', 'partial', 'cancelled'].includes(status) ? new Date().toISOString() : undefined
  const result = await client.query<RunRow>(`
    UPDATE smarthub.test_execution_runs
    SET status=$2,state_version=state_version+1,started_at=COALESCE(started_at,$3),finished_at=$4,error=NULL
    WHERE id=$1
    RETURNING snapshot,status,state_version,started_at,finished_at,cancel_requested_at,error
  `, [runId, status, startedAt ?? null, finishedAt ?? null])
  return runFromRow(result.rows[0])
}

async function getRun(queryable: Pool | PoolClient, runId: string) {
  const result = await queryable.query<RunRow>('SELECT snapshot,status,state_version,started_at,finished_at,cancel_requested_at,error FROM smarthub.test_execution_runs WHERE id=$1', [runId])
  return result.rows[0] ? runFromRow(result.rows[0]) : null
}

async function getRunForUpdate(client: PoolClient, runId: string) {
  const result = await client.query<RunRow>('SELECT snapshot,status,state_version,started_at,finished_at,cancel_requested_at,error FROM smarthub.test_execution_runs WHERE id=$1 FOR UPDATE', [runId])
  return result.rows[0] ? runFromRow(result.rows[0]) : null
}

async function getRunByIdempotencyKey(queryable: Pool | PoolClient, projectVersionId: string, idempotencyKey: string) {
  const result = await queryable.query<RunRow>('SELECT snapshot,status,state_version,started_at,finished_at,cancel_requested_at,error FROM smarthub.test_execution_runs WHERE project_version_id=$1 AND idempotency_key=$2', [projectVersionId, idempotencyKey])
  return result.rows[0] ? runFromRow(result.rows[0]) : null
}

async function getTaskForUpdate(client: PoolClient, taskId: string) {
  const result = await client.query<TaskRow>(`${taskSelect} WHERE id=$1 FOR UPDATE`, [taskId])
  return result.rows[0] ? taskFromRow(result.rows[0]) : null
}

async function insertRun(client: PoolClient, run: ExecutionRun, aggregateSha256: string, createRequestSha256: string) {
  const snapshotCanonical = canonicalJson(run)
  await client.query(`
    INSERT INTO smarthub.test_execution_runs (
      id,project_id,project_version_id,handoff_id,handoff_sha256,test_case_library_version_id,test_case_library_version_sha256,
      suite_version_id,suite_version_sha256,execution_mode,member_snapshot_sha256,agent_under_test_id,agent_under_test_version,agent_under_test_configuration_sha256,
      snapshot_sha256,aggregate_sha256,create_request_sha256,create_request_canonical,status,state_version,idempotency_key,
      task_count,created_by,created_at,snapshot,snapshot_canonical
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25::jsonb,$26)
  `, [
    run.id, run.projectId, run.projectVersionId, run.handoff.handoffId, run.handoff.handoffSha256,
    run.handoff.testCaseLibraryVersionId, run.handoff.testCaseLibraryVersionSha256, run.handoff.suiteVersionId ?? null,
    run.handoff.suiteVersionSha256 ?? null, run.handoff.mode, run.handoff.memberSnapshotSha256,
    run.agentUnderTest.id, run.agentUnderTest.version, run.agentUnderTest.configurationSha256,
    canonicalSha256(run), aggregateSha256, createRequestSha256, executionCreateRequestCanonical(run), run.status,
    run.stateVersion, run.idempotencyKey, run.taskCount, run.createdBy, run.createdAt, JSON.stringify(run), snapshotCanonical,
  ])
}

async function insertTask(client: PoolClient, task: ExecutionTask) {
  const frozenInput = { ...task.input, taskId: task.id, runId: task.runId }
  await client.query(`
    INSERT INTO smarthub.test_execution_tasks (
      id,run_id,ordinal,dedup_key,source_version_id,case_id,case_revision,method,dimension,case_content_sha256,
      execution_spec_sha256,input_sha256,status,state_version,error,created_at,updated_at,finished_at,frozen_input
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,'agent',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
  `, [task.id, task.runId, task.input.ordinal, task.input.dedupKey, task.input.sourceVersionId, task.input.caseId,
    task.input.caseRevision, task.input.dimension, task.input.caseContentSha256, task.input.executionSpecSha256,
    task.input.inputSha256, task.status, task.stateVersion, task.error ?? null, task.createdAt, task.updatedAt,
    task.finishedAt ?? null, JSON.stringify(frozenInput)])
}

async function insertJob(client: PoolClient, job: ExecutionJob) {
  await client.query(`
    INSERT INTO smarthub.test_execution_jobs (
      id,run_id,task_id,status,attempt_count,max_attempts,available_at,lease_owner,run_token,fencing_token,
      lease_expires_at,heartbeat_at,cancel_requested_at,error,created_at,updated_at,data
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
  `, [job.id, job.runId, job.taskId, job.status, job.attempts, job.maxAttempts, job.availableAt,
    job.leaseOwner ?? null, job.runToken ?? null, job.fencingToken, job.leaseExpiresAt ?? null,
    job.heartbeatAt ?? null, job.cancelRequestedAt ?? null, job.error ?? null, job.createdAt, job.updatedAt, JSON.stringify(job)])
}

async function insertAgentExecutionResult(client: PoolClient, result: AgentExecutionAggregateResult) {
  const existing = await client.query<{ data: AgentExecutionAggregateResult }>('SELECT data FROM smarthub.agent_execution_results WHERE task_id=$1', [result.taskId])
  if (existing.rows[0]) {
    if (canonicalSha256(existing.rows[0].data) !== canonicalSha256(result)) throw new Error('AGENT_EXECUTION_RESULT_IMMUTABLE')
    return
  }
  for (const caseRun of result.caseRuns) {
    await client.query(`INSERT INTO smarthub.agent_execution_case_runs (id,run_id,task_id,repeat_ordinal,status,latency_ms,step_count,token_usage,cost,trace_ref,evidence_coverage,actual_output,error,started_at,finished_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16::jsonb)`, [caseRun.id, result.runId, result.taskId, caseRun.repeatOrdinal, caseRun.status, caseRun.latencyMs, caseRun.stepCount, caseRun.tokenUsage ? JSON.stringify(caseRun.tokenUsage) : null, caseRun.cost ?? null, caseRun.traceRef, JSON.stringify(caseRun.evidenceCoverage), caseRun.actualOutput === undefined ? null : JSON.stringify(caseRun.actualOutput), caseRun.error ?? null, caseRun.startedAt, caseRun.finishedAt, JSON.stringify(caseRun)])
    for (const event of caseRun.traceEvents) await client.query(`INSERT INTO smarthub.agent_execution_trace_events (id,run_id,task_id,case_run_id,sequence,event_type,event_at,source,name,input,output,metadata,duration_ms,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14::jsonb)`, [event.id, result.runId, result.taskId, caseRun.id, event.sequence, event.type, event.timestamp, event.source, event.name ?? null, event.input === undefined ? null : JSON.stringify(event.input), event.output === undefined ? null : JSON.stringify(event.output), event.metadata ? JSON.stringify(event.metadata) : null, event.durationMs ?? null, JSON.stringify(event)])
    for (const assertion of caseRun.assertionResults) await client.query(`INSERT INTO smarthub.agent_execution_assertion_results (id,case_run_id,ordinal,assertion_type,status,code,data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [assertion.id, caseRun.id, assertion.ordinal, assertion.type, assertion.status, assertion.code, JSON.stringify(assertion)])
    for (const evaluation of caseRun.evaluationResults) await client.query(`INSERT INTO smarthub.agent_execution_evaluation_results (id,case_run_id,ordinal,evaluation_kind,status,data) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [evaluation.id, caseRun.id, evaluation.ordinal, evaluation.kind, evaluation.status, JSON.stringify(evaluation)])
    for (const [index, fact] of caseRun.failureFacts.entries()) await client.query(`INSERT INTO smarthub.agent_execution_failure_facts (id,case_run_id,ordinal,code,data) VALUES ($1,$2,$3,$4,$5::jsonb)`, [`${caseRun.id}:failure:${index + 1}`, caseRun.id, index + 1, fact.code, JSON.stringify(fact)])
  }
  await client.query(`INSERT INTO smarthub.agent_execution_results (task_id,run_id,status,repeat_count,success_rate,failure_rate,not_evaluable_rate,error_rate,created_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [result.taskId, result.runId, result.status, result.caseRuns.length, result.successRate, result.failureRate, result.notEvaluableRate, result.errorRate, result.createdAt, JSON.stringify(result)])
  const analysis = result.failureAnalysis
  const analysisError = result.failureAnalysisError
  if (analysis || analysisError) await client.query(`INSERT INTO smarthub.agent_execution_failure_analyses (task_id,run_id,category,source,agent_snapshot_ref,reason,evidence,error,created_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [result.taskId, result.runId, analysis?.category ?? null, analysis ? 'agent' : 'unavailable', analysis?.agentSnapshotRef ?? null, analysis?.reason ?? null, analysis?.evidence ?? null, analysisError ?? null, result.createdAt, JSON.stringify(analysis ?? { error: analysisError })])
}

async function requeueExpiredJobs(client: PoolClient) {
  await client.query(`
    UPDATE smarthub.test_execution_jobs
    SET status='queued',available_at=now(),lease_owner=NULL,run_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL,updated_at=now(),error='AGENT_TEST_JOB_LEASE_EXPIRED'
    WHERE status='running' AND lease_expires_at<=now() AND attempt_count<max_attempts
  `)
}

function validateAggregate(input: CreateExecutionAggregateInput) {
  if (!input.tasks.length || input.run.taskCount !== input.tasks.length || input.jobs.length !== input.tasks.length) throw new Error('TEST_EXECUTION_AGGREGATE_INVALID')
  if (input.run.runner.kind !== 'agent' || input.tasks.some(task => task.runId !== input.run.id || task.input.method !== 'agent' || task.status !== 'pending')) throw new Error('AGENT_TEST_AGGREGATE_INVALID')
  if (input.jobs.some(job => job.runId !== input.run.id || !input.tasks.some(task => task.id === job.taskId))) throw new Error('TEST_EXECUTION_JOB_SCOPE_INVALID')
}

function runFromRow(row: RunRow): ExecutionRun {
  return {
    ...structuredClone(row.snapshot),
    status: row.status,
    stateVersion: row.state_version,
    ...(row.started_at ? { startedAt: iso(row.started_at) } : { startedAt: undefined }),
    ...(row.finished_at ? { finishedAt: iso(row.finished_at) } : { finishedAt: undefined }),
    ...(row.cancel_requested_at ? { cancelRequestedAt: iso(row.cancel_requested_at) } : { cancelRequestedAt: undefined }),
    ...(row.error ? { error: row.error } : { error: undefined }),
  }
}

function taskFromRow(row: TaskRow): ExecutionTask {
  const input = structuredClone(row.frozen_input)
  const taskId = String((input as unknown as Record<string, unknown>).taskId ?? '')
  const runId = String((input as unknown as Record<string, unknown>).runId ?? '')
  delete (input as unknown as Record<string, unknown>).taskId
  delete (input as unknown as Record<string, unknown>).runId
  return {
    id: taskId,
    runId,
    input,
    status: row.status,
    stateVersion: row.state_version,
    ...(row.error ? { error: row.error } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.finished_at ? { finishedAt: iso(row.finished_at) } : {}),
  }
}

function jobFromRow(row: JobRow): ExecutionJob {
  return {
    ...structuredClone(row.data),
    status: row.status,
    attempts: row.attempt_count,
    fencingToken: Number(row.fencing_token),
    availableAt: iso(row.available_at),
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : { leaseOwner: undefined }),
    ...(row.run_token ? { runToken: row.run_token } : { runToken: undefined }),
    ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : { leaseExpiresAt: undefined }),
    ...(row.heartbeat_at ? { heartbeatAt: iso(row.heartbeat_at) } : { heartbeatAt: undefined }),
    updatedAt: iso(row.updated_at),
  }
}

const taskSelect = 'SELECT frozen_input,status,state_version,error,created_at,updated_at,finished_at FROM smarthub.test_execution_tasks'
type RunRow = { snapshot: ExecutionRun; status: ExecutionRunStatus; state_version: number; started_at: Date | string | null; finished_at: Date | string | null; cancel_requested_at: Date | string | null; error: string | null }
type TaskRow = { frozen_input: ExecutionTask['input']; status: ExecutionTaskStatus; state_version: number; error: string | null; created_at: Date | string; updated_at: Date | string; finished_at: Date | string | null }
type JobRow = { data: ExecutionJob; status: ExecutionJob['status']; attempt_count: number; fencing_token: string | number; available_at: Date | string; lease_owner: string | null; run_token: string | null; lease_expires_at: Date | string | null; heartbeat_at: Date | string | null; updated_at: Date | string }
function iso(value: Date | string) { return value instanceof Date ? value.toISOString() : new Date(value).toISOString() }
function safeError(value: string) { return value.replace(/[\u0000-\u001F\u007F]/gu, ' ').replace(/((?:authorization|cookie|token|api.?key|password|secret)\s*[:=])\s*\S+/giu, '$1 <REDACTED>').slice(0, 4_000) }
