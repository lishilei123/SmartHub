import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import { freezeExecutionTaskInput, scriptCacheKey } from '../server/application/test-execution-validation.js'
import type {
  ExecutionArtifact,
  ExecutionAttempt,
  ExecutionJob,
  ExecutionPackageManifest,
  ExecutionRun,
  ExecutionTask,
  FailureDiagnosis,
  FrozenExecutionAgentSnapshot,
  ScriptArtifact,
  ScriptRevision,
} from '../server/domain/test-execution-types.js'
import type {
  FunctionalExecutionSpec,
  TestCaseContent,
  TestCaseLibraryVersionMemberDetail,
  TestExecutionHandoffMember,
} from '../server/domain/test-design-types.js'
import { runMigrations } from '../server/infrastructure/migrations.js'
import {
  PostgresTestExecutionStore,
  type ExecutionJobLease,
} from '../server/infrastructure/test-execution-store.js'

const connectionString = process.env.TEST_DATABASE_URL
if (!connectionString) throw new Error('test:postgres 需要配置指向隔离数据库的 TEST_DATABASE_URL')
if (!/test/iu.test(new URL(connectionString).pathname)) throw new Error('TEST_DATABASE_URL 必须指向名称包含 test 的隔离数据库')

await runMigrations(connectionString)

const database = new Pool({ connectionString })
const firstStore = new PostgresTestExecutionStore(connectionString)
const secondStore = new PostgresTestExecutionStore(connectionString)
const prefix = `test-execution-postgres-${randomUUID()}`
const now = new Date().toISOString()
const ids = {
  project: `${prefix}-project`,
  projectVersion: `${prefix}-project-version`,
  libraryCase: `${prefix}-case`,
  libraryVersion: `${prefix}-library-version`,
  handoff: `${prefix}-handoff`,
  run: `${prefix}-run`,
  task: `${prefix}-task`,
  job: `${prefix}-job`,
}

const executionSpec: FunctionalExecutionSpec = {
  kind: 'functional',
  method: 'ui',
  steps: [{ key: 'open', action: '打开健康页', expected: '页面可见' }],
  verificationChecks: [{ key: 'ready', description: '状态为 Ready' }],
  preconditions: [],
  testDataRequirements: [],
  executionReadiness: 'ready',
  automationHint: '使用 data-testid',
}
const caseContent: TestCaseContent = {
  schemaVersion: 'test-case/v2',
  title: '健康检查',
  objective: '验证服务状态',
  dimension: 'functional',
  testPointIds: ['health-point'],
  priority: 'P0',
  preconditions: [],
  dataRequirementIds: [],
  cleanup: [],
  dependencies: [],
  executionMethods: [{ method: 'ui', uiSpec: { entry: '/health' }, steps: executionSpec.steps, verificationChecks: executionSpec.verificationChecks, executionReadiness: 'ready', automationHint: executionSpec.automationHint }],
  executionSpec,
  sharedVerificationChecks: executionSpec.verificationChecks,
  tags: ['smoke'],
  domain: 'system',
}
const caseContentSha256 = canonicalSha256(caseContent)
const libraryMember: TestCaseLibraryVersionMemberDetail = {
  caseId: ids.libraryCase,
  revision: 1,
  ordinal: 0,
  contentSha256: caseContentSha256,
  frozenContent: caseContent,
  executionReadiness: 'ready',
}
const librarySourceRunId = `${prefix}-library-source-run`
const libraryVersionSha256 = canonicalSha256({
  schemaVersion: 'test-case-library/v1',
  projectId: ids.project,
  sourceRunId: librarySourceRunId,
  members: [libraryMember],
})
const handoffMember: TestExecutionHandoffMember = {
  stage: 'full',
  ordinal: 0,
  sourceVersionId: ids.libraryVersion,
  caseId: ids.libraryCase,
  revision: 1,
  method: 'ui',
  reason: '指定用例库版本的全部冻结用例',
  dedupKey: `${ids.libraryCase}:1:ui`,
  dimension: 'functional',
  executionSpec,
  selectionReason: '指定用例库版本的全部冻结用例',
  contentSha256: caseContentSha256,
}
const handoffSha256 = canonicalSha256({
  projectId: ids.project,
  projectVersionId: ids.projectVersion,
  testCaseLibraryVersionId: ids.libraryVersion,
  mode: 'full',
  members: [handoffMember],
})
const frozenInput = freezeExecutionTaskInput({ handoffMember, libraryMember })
const agentSnapshot = (agentKey: FrozenExecutionAgentSnapshot['agentKey']): FrozenExecutionAgentSnapshot => ({
  agentKey,
  configurationId: `${prefix}-${agentKey}-configuration`,
  configurationVersion: 1,
  configurationSha256: 'a'.repeat(64),
  definitionSha256: 'b'.repeat(64),
  model: { sourceId: 'source-1', modelId: 'model-1', providerType: 'anthropic' },
  snapshotSha256: 'c'.repeat(64),
})
const run: ExecutionRun = {
  id: ids.run,
  projectId: ids.project,
  projectVersionId: ids.projectVersion,
  handoff: {
    handoffId: ids.handoff,
    handoffSha256,
    projectId: ids.project,
    projectVersionId: ids.projectVersion,
    testCaseLibraryVersionId: ids.libraryVersion,
    testCaseLibraryVersionSha256: libraryVersionSha256,
    mode: 'full',
    memberSnapshotSha256: canonicalSha256([frozenInput]),
  },
  environment: {
    environmentId: `${prefix}-environment`,
    name: '隔离测试环境',
    baseUrl: 'https://example.test',
    targets: [{ protocol: 'https', host: 'example.test', port: 443 }],
    signature: 'f'.repeat(64),
  },
  runner: { runnerVersion: '1.0.0', playwrightVersion: '1.58.2', imageReference: 'runner@sha256:test', imageDigest: `sha256:${'1'.repeat(64)}` },
  agents: { testScript: agentSnapshot('test-script'), failureAnalysis: agentSnapshot('failure-analysis'), scriptRepair: agentSnapshot('script-repair') },
  status: 'queued',
  stateVersion: 0,
  idempotencyKey: `${prefix}-idempotency`,
  taskCount: 1,
  createdBy: 'integration-test',
  createdAt: now,
}
const task: ExecutionTask = {
  id: ids.task,
  runId: ids.run,
  input: frozenInput,
  status: 'pending',
  stateVersion: 0,
  runnerAttemptCount: 0,
  sameScriptRetryCount: 0,
  repairCount: 0,
  createdAt: now,
  updatedAt: now,
}
const job: ExecutionJob = {
  id: ids.job,
  runId: ids.run,
  taskId: ids.task,
  status: 'queued',
  attempts: 0,
  maxAttempts: 3,
  availableAt: now,
  fencingToken: 0,
  createdAt: now,
  updatedAt: now,
}

test.before(async () => {
  await seedParents()
})

test.after(async () => {
  await Promise.all([firstStore.close(), secondStore.close()])
  await database.end()
})

test('PostgreSQL 执行聚合幂等创建并以 SKIP LOCKED 单次领取任务', async () => {
  const created = await firstStore.createAggregate({ run, tasks: [task], jobs: [job] })
  const replay = await firstStore.createAggregate({ run, tasks: [task], jobs: [job] })
  assert.equal(created.id, ids.run)
  assert.equal(replay.id, ids.run)
  assert.equal((await firstStore.listTasks(ids.run)).length, 1)
  await assert.rejects(
    firstStore.createAggregate({
      run: { ...run, environment: { ...run.environment, signature: '9'.repeat(64) } },
      tasks: [task],
      jobs: [job],
    }),
    /IDEMPOTENCY_CONFLICT/u,
  )
  await assert.rejects(
    firstStore.createAggregate({
      run,
      tasks: [{ ...task, id: `${ids.task}-regenerated` }],
      jobs: [{ ...job, id: `${ids.job}-regenerated`, taskId: `${ids.task}-regenerated` }],
    }),
    /IDEMPOTENCY_CONFLICT/u,
  )
  await assert.rejects(
    firstStore.createAggregate({ run, tasks: [task], jobs: [{ ...job, maxAttempts: 4 }] }),
    /IDEMPOTENCY_CONFLICT/u,
  )

  const claimed = await Promise.all([
    firstStore.claimJob('execution-worker-a', 60_000),
    secondStore.claimJob('execution-worker-b', 60_000),
  ])
  assert.equal(claimed.filter(Boolean).length, 1)
  const active = required(claimed.find(Boolean), '应有一个 Worker 领取任务')
  assert.equal(active.attempts, 1)
  assert.equal(active.fencingToken, 1)
  assert.equal(await firstStore.heartbeatJob(active.id, lease(active), 60_000), true)

  const transitioned = await firstStore.transactionWithLease(active.id, lease(active), transaction => transaction.transitionTask({ taskId: ids.task, expectedStatus: 'pending', expectedStateVersion: 0, status: 'script_generating' }))
  assert.equal(transitioned?.status, 'script_generating')
  assert.equal(transitioned?.stateVersion, 1)
  assert.equal((await firstStore.getRun(ids.run))?.status, 'running')
  assert.equal(await firstStore.releaseJob(active.id, lease(active), 0, 'provider temporarily unavailable'), true)

  const reclaimed = required(await secondStore.claimJob('execution-worker-c', 60_000), '任务应被第二个 Worker 重新领取')
  assert.equal(reclaimed.attempts, 2)
  assert.equal(reclaimed.fencingToken, 2)
  assert.notEqual(reclaimed.runToken, active.runToken)
  assert.equal(await firstStore.transactionWithLease(active.id, lease(active), async () => true), null)
  assert.equal(await firstStore.heartbeatJob(active.id, lease(active), 60_000), false)

  await assert.rejects(
    secondStore.transactionWithLease(reclaimed.id, lease(reclaimed), transaction => transaction.transitionTask({ taskId: ids.task, expectedStatus: 'script_generating', expectedStateVersion: 0, status: 'ready' })),
    /TASK_STATE_CONFLICT/u,
  )

  await appendScriptAndAttempt(reclaimed)
  assert.equal((await firstStore.listAttempts(ids.task)).length, 1)
  assert.equal(await secondStore.finishJob(reclaimed.id, lease(reclaimed), 'succeeded'), false)
  assert.equal(await secondStore.finishJob(reclaimed.id, lease(reclaimed), 'failed'), true)

  const exhaustedRunId = `${prefix}-exhausted-run`
  const exhaustedTaskId = `${prefix}-exhausted-task`
  const exhaustedJobId = `${prefix}-exhausted-job`
  const exhaustedRun: ExecutionRun = {
    ...run,
    id: exhaustedRunId,
    idempotencyKey: `${prefix}-exhausted-idempotency`,
    createdAt: new Date(Date.now() + 400).toISOString(),
  }
  const exhaustedTask: ExecutionTask = {
    ...task,
    id: exhaustedTaskId,
    runId: exhaustedRunId,
    createdAt: exhaustedRun.createdAt,
    updatedAt: exhaustedRun.createdAt,
  }
  const exhaustedJob: ExecutionJob = {
    ...job,
    id: exhaustedJobId,
    runId: exhaustedRunId,
    taskId: exhaustedTaskId,
    maxAttempts: 1,
    availableAt: now,
    createdAt: exhaustedRun.createdAt,
    updatedAt: exhaustedRun.createdAt,
  }
  await firstStore.createAggregate({ run: exhaustedRun, tasks: [exhaustedTask], jobs: [exhaustedJob] })
  const exhaustedClaim = required(await firstStore.claimJob('execution-worker-exhausted', 60_000), '耗尽任务应被领取')
  assert.equal(exhaustedClaim.id, exhaustedJobId)
  assert.equal(await firstStore.releaseJob(exhaustedJobId, lease(exhaustedClaim), 0, 'provider unavailable'), true)
  assert.equal((await firstStore.getTask(exhaustedTaskId))?.status, 'blocked')
  assert.equal((await firstStore.getRun(exhaustedRunId))?.status, 'partial')
  const exhaustedStatus = await database.query<{ status: string }>('SELECT status FROM smarthub.test_execution_jobs WHERE id=$1', [exhaustedJobId])
  assert.equal(exhaustedStatus.rows[0]?.status, 'failed')
})

test('PostgreSQL 使用实时 lease 截止时间回滚过期事务', async () => {
  const aggregate = executionAggregateVariant('lease-clock', 2)
  await firstStore.createAggregate(aggregate)
  const claimed = required(await firstStore.claimJob('execution-worker-lease-clock', 1_000), 'lease 时钟任务应被领取')
  assert.equal(claimed.id, aggregate.jobs[0].id)

  const result = await firstStore.transactionWithLease(claimed.id, lease(claimed), async transaction => {
    await new Promise(resolve => setTimeout(resolve, 1_100))
    return transaction.transitionTask({
      taskId: aggregate.tasks[0].id,
      expectedStatus: 'pending',
      expectedStateVersion: 0,
      status: 'script_generating',
    })
  })
  assert.equal(result, null)
  assert.equal((await firstStore.getTask(aggregate.tasks[0].id))?.status, 'pending')

  const reclaimed = required(await secondStore.claimJob('execution-worker-lease-clock-reclaim', 60_000), '过期任务应被重新领取')
  assert.equal(reclaimed.id, aggregate.jobs[0].id)
  assert.equal(reclaimed.attempts, 2)
  assert.equal(await secondStore.releaseJob(reclaimed.id, lease(reclaimed), 0, 'lease clock test complete'), true)
})

test('PostgreSQL 拒绝终态 run 与任务聚合矛盾', async () => {
  const aggregate = executionAggregateVariant('run-task-status', 2)
  await firstStore.createAggregate(aggregate)
  const constraintClient = await database.connect()
  try {
    await constraintClient.query('BEGIN')
    await constraintClient.query(`
      UPDATE smarthub.test_execution_runs
      SET status='running',state_version=state_version+1,started_at=clock_timestamp()
      WHERE id=$1
    `, [aggregate.run.id])
    await constraintClient.query(`
      UPDATE smarthub.test_execution_runs
      SET status='succeeded',state_version=state_version+1,finished_at=clock_timestamp()
      WHERE id=$1
    `, [aggregate.run.id])
    await assert.rejects(
      constraintClient.query(
        'SET CONSTRAINTS smarthub.test_execution_runs_aggregate_ck IMMEDIATE',
      ),
      /TEST_EXECUTION_RUN_TASK_STATUS_MISMATCH/u,
    )
  } finally {
    await constraintClient.query('ROLLBACK')
    constraintClient.release()
  }
  assert.equal((await firstStore.getRun(aggregate.run.id))?.status, 'queued')
})

test('PostgreSQL 拒绝使用同一 fencing token 复活过期 lease', async () => {
  const aggregate = executionAggregateVariant('expired-lease-resurrection', 2)
  await firstStore.createAggregate(aggregate)
  const claimed = required(
    await firstStore.claimJob('execution-worker-expired-lease', 1_000),
    '过期 lease 任务应被领取',
  )
  await new Promise(resolve => setTimeout(resolve, 1_100))
  await assert.rejects(
    database.query(`
      UPDATE smarthub.test_execution_jobs
      SET lease_expires_at=clock_timestamp()+interval '1 minute',
          heartbeat_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1
    `, [claimed.id]),
    /TEST_EXECUTION_JOB_LEASE_REGRESSION/u,
  )
  const reclaimed = required(
    await secondStore.claimJob('execution-worker-expired-lease-reclaim', 60_000),
    '过期 lease 应以新 fencing token 重新领取',
  )
  assert.equal(reclaimed.id, claimed.id)
  assert.equal(reclaimed.fencingToken, claimed.fencingToken + 1)
  assert.equal(await secondStore.releaseJob(reclaimed.id, lease(reclaimed), 0, 'lease resurrection test complete'), true)
})

test('PostgreSQL 普通 reclaim 先终结遗留 attempt 再允许同脚本重试', async () => {
  const aggregate = executionAggregateVariant('reclaim-running-attempt', 3)
  await firstStore.createAggregate(aggregate)
  const claimed = required(await firstStore.claimJob('execution-worker-reclaim-attempt', 1_000), 'reclaim attempt 任务应被领取')
  const interrupted = await appendRunningAttempt(claimed, aggregate, 'reclaim-running-attempt')
  await new Promise(resolve => setTimeout(resolve, 1_100))

  const reclaimed = required(await secondStore.claimJob('execution-worker-reclaim-successor', 60_000), '遗留 attempt 对账后应重新领取同一 job')
  assert.equal(reclaimed.id, claimed.id)
  assert.equal(reclaimed.attempts, 2)
  assert.notEqual(reclaimed.runToken, claimed.runToken)
  assert.equal((await firstStore.listAttempts(aggregate.tasks[0].id))[0].status, 'infrastructure_error')
  const retrying = required(await firstStore.getTask(aggregate.tasks[0].id), '任务应存在')
  assert.equal(retrying.status, 'retrying')

  const retryAttempt: ExecutionAttempt = {
    ...interrupted,
    id: `${prefix}-reclaim-running-attempt-retry`,
    ordinal: 2,
    invocationKey: `${prefix}-reclaim-running-attempt-retry-invocation`,
    kind: 'same_script_retry',
    status: 'running',
    startedAt: new Date().toISOString(),
  }
  await secondStore.transactionWithLease(reclaimed.id, lease(reclaimed), async transaction => {
    await transaction.appendAttempt(retryAttempt)
    await transaction.transitionTask({
      taskId: aggregate.tasks[0].id,
      expectedStatus: 'retrying',
      expectedStateVersion: retrying.stateVersion,
      status: 'running',
      incrementRunnerAttempt: true,
      incrementSameScriptRetry: true,
    })
  })
  const attempts = await firstStore.listAttempts(aggregate.tasks[0].id)
  assert.deepEqual(attempts.map(attemptValue => attemptValue.status), ['infrastructure_error', 'running'])
})

test('PostgreSQL 对账耗尽的过期 Worker 并终结同一 Runner attempt', async () => {
  const aggregate = executionAggregateVariant('expired-running-attempt', 1)
  await firstStore.createAggregate(aggregate)
  const claimed = required(await firstStore.claimJob('execution-worker-expired-attempt', 1_000), '过期 attempt 任务应被领取')
  assert.equal(claimed.id, aggregate.jobs[0].id)
  const attempt = await appendRunningAttempt(claimed, aggregate, 'expired-running-attempt')
  await new Promise(resolve => setTimeout(resolve, 1_100))

  assert.equal(await secondStore.claimJob('execution-worker-after-exhaustion', 60_000), null)
  const attempts = await firstStore.listAttempts(aggregate.tasks[0].id)
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0].id, attempt.id)
  assert.equal(attempts[0].status, 'infrastructure_error')
  assert.equal((await firstStore.getTask(aggregate.tasks[0].id))?.status, 'blocked')
  assert.equal((await firstStore.getRun(aggregate.run.id))?.status, 'partial')
  const jobStatus = await database.query<{ status: string }>('SELECT status FROM smarthub.test_execution_jobs WHERE id=$1', [claimed.id])
  assert.equal(jobStatus.rows[0]?.status, 'failed')
})

test('PostgreSQL 在提交时拒绝 attempt 与 task 的非原子状态', async () => {
  const aggregate = executionAggregateVariant('attempt-task-atomicity', 2)
  await firstStore.createAggregate(aggregate)
  const claimed = required(
    await firstStore.claimJob('execution-worker-attempt-task-atomicity', 60_000),
    'attempt 原子性任务应被领取',
  )
  const attempt = await appendRunningAttempt(claimed, aggregate, 'attempt-task-atomicity')
  const constraintClient = await database.connect()
  try {
    await constraintClient.query('BEGIN')
    await constraintClient.query(`
      UPDATE smarthub.test_execution_attempts
      SET status='failed',finished_at=clock_timestamp(),duration_ms=0
      WHERE id=$1
    `, [attempt.id])
    await assert.rejects(
      constraintClient.query(
        'SET CONSTRAINTS smarthub.test_execution_attempts_task_ck IMMEDIATE',
      ),
      /TEST_EXECUTION_TASK_ATTEMPT_STATE_MISMATCH/u,
    )
  } finally {
    await constraintClient.query('ROLLBACK')
    constraintClient.release()
  }
  assert.equal((await firstStore.listAttempts(aggregate.tasks[0].id))[0]?.status, 'running')

  const currentTask = required(
    await firstStore.getTask(aggregate.tasks[0].id),
    'attempt 原子性任务应存在',
  )
  await firstStore.transactionWithLease(claimed.id, lease(claimed), async transaction => {
    await transaction.finalizeAttempt({
      attemptId: attempt.id,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      durationMs: 0,
    })
    await transaction.transitionTask({
      taskId: currentTask.id,
      expectedStatus: 'running',
      expectedStateVersion: currentTask.stateVersion,
      status: 'blocked',
      error: '验证 attempt 与 task 原子提交',
      finishedAt: new Date().toISOString(),
    })
  })
  assert.equal((await firstStore.getTask(currentTask.id))?.status, 'blocked')
  assert.equal(await firstStore.heartbeatJob(claimed.id, lease(claimed), 60_000), false)
  assert.equal(await firstStore.finishJob(claimed.id, lease(claimed), 'failed'), true)
})

test('PostgreSQL claim reconciliation 与 cancel 使用无环锁序', { timeout: 15_000 }, async () => {
  const suffix = 'claim-cancel-lock-order'
  const handoffId = `${prefix}-${suffix}-handoff`
  const firstHandoffMember: TestExecutionHandoffMember = {
    ...handoffMember,
    ordinal: 0,
    dedupKey: `${prefix}-${suffix}-first`,
  }
  const secondHandoffMember: TestExecutionHandoffMember = {
    ...handoffMember,
    ordinal: 1,
    dedupKey: `${prefix}-${suffix}-second`,
  }
  const handoffMembers = [firstHandoffMember, secondHandoffMember]
  const handoffContentSha256 = canonicalSha256({
    projectId: ids.project,
    projectVersionId: ids.projectVersion,
    testCaseLibraryVersionId: ids.libraryVersion,
    mode: 'full',
    members: handoffMembers,
  })
  await database.query(`
    INSERT INTO smarthub.test_execution_handoffs (
      id,project_version_id,test_case_set_version_id,
      test_case_library_version_id,suite_version_id,
      execution_mode,strategy,content_sha256,created_by,created_at,content,data
    ) VALUES ($1,$2,NULL,$3,NULL,'full','full',$4,$5,$6,$7::jsonb,$7::jsonb)
  `, [
    handoffId,
    ids.projectVersion,
    ids.libraryVersion,
    handoffContentSha256,
    'integration-test',
    now,
    JSON.stringify({
      id: handoffId,
      projectId: ids.project,
      projectVersionId: ids.projectVersion,
      testCaseLibraryVersionId: ids.libraryVersion,
      mode: 'full',
      members: handoffMembers,
      contentSha256: handoffContentSha256,
      createdBy: 'integration-test',
      createdAt: now,
    }),
  ])
  for (const member of handoffMembers) {
    await database.query(`
      INSERT INTO smarthub.test_execution_handoff_members (
        handoff_id,stage,ordinal,source_version_id,case_id,case_revision,
        method,dedup_key,dimension,execution_spec,traceability,
        content_sha256,readiness_override,data
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,NULL,$11,NULL,$12::jsonb
      )
    `, [
      handoffId,
      member.stage,
      member.ordinal,
      member.sourceVersionId,
      member.caseId,
      member.revision,
      member.method,
      member.dedupKey,
      member.dimension,
      JSON.stringify(member.executionSpec),
      member.contentSha256,
      JSON.stringify(member),
    ])
  }

  const firstInput = freezeExecutionTaskInput({
    handoffMember: firstHandoffMember,
    libraryMember,
  })
  const secondInput = freezeExecutionTaskInput({
    handoffMember: secondHandoffMember,
    libraryMember,
  })
  const runId = `${prefix}-${suffix}-run`
  const lockRun: ExecutionRun = {
    ...run,
    id: runId,
    handoff: {
      ...run.handoff,
      handoffId,
      handoffSha256: handoffContentSha256,
      memberSnapshotSha256: canonicalSha256([firstInput, secondInput]),
    },
    idempotencyKey: `${prefix}-${suffix}-idempotency`,
    taskCount: 2,
  }
  const firstTask: ExecutionTask = {
    ...task,
    id: `${prefix}-${suffix}-a-task`,
    runId,
    input: firstInput,
  }
  const secondTask: ExecutionTask = {
    ...task,
    id: `${prefix}-${suffix}-b-task`,
    runId,
    input: secondInput,
  }
  const firstJob: ExecutionJob = {
    ...job,
    id: `${prefix}-${suffix}-a-job`,
    runId,
    taskId: firstTask.id,
    maxAttempts: 3,
  }
  const secondJob: ExecutionJob = {
    ...job,
    id: `${prefix}-${suffix}-b-job`,
    runId,
    taskId: secondTask.id,
    maxAttempts: 1,
  }
  await firstStore.createAggregate({
    run: lockRun,
    tasks: [firstTask, secondTask],
    jobs: [firstJob, secondJob],
  })
  const firstClaim = required(
    await firstStore.claimJob('execution-worker-lock-order-first', 60_000),
    '锁序测试的第一个 job 应被领取',
  )
  assert.equal(firstClaim.id, firstJob.id)
  await firstStore.transactionWithLease(firstClaim.id, lease(firstClaim), transaction =>
    transaction.transitionTask({
      taskId: firstTask.id,
      expectedStatus: 'pending',
      expectedStateVersion: 0,
      status: 'script_generating',
    }),
  )
  assert.equal(
    await firstStore.releaseJob(firstClaim.id, lease(firstClaim), 0, '准备锁序测试'),
    true,
  )

  const firstJobBlocker = await database.connect()
  try {
    await firstJobBlocker.query('BEGIN')
    await firstJobBlocker.query(
      'SELECT id FROM smarthub.test_execution_jobs WHERE id=$1 FOR UPDATE',
      [firstJob.id],
    )
    const secondClaim = required(
      await secondStore.claimJob('execution-worker-lock-order-second', 1_000),
      '锁序测试的第二个 job 应被领取',
    )
    assert.equal(secondClaim.id, secondJob.id)
    await firstJobBlocker.query('COMMIT')
  } finally {
    await firstJobBlocker.query('ROLLBACK').catch(() => undefined)
    firstJobBlocker.release()
  }

  await new Promise(resolve => setTimeout(resolve, 1_100))
  const taskBlocker = await database.connect()
  let taskBlockerOpen = false
  try {
    await taskBlocker.query('BEGIN')
    taskBlockerOpen = true
    await taskBlocker.query(
      'SELECT id FROM smarthub.test_execution_tasks WHERE id=$1 FOR UPDATE',
      [secondTask.id],
    )
    const claimPromise = secondStore.claimJob(
      'execution-worker-lock-order-reconcile',
      60_000,
    )
    await waitForPostgresLock('%test_execution_tasks WHERE id=$1 FOR UPDATE%')
    const cancelPromise = firstStore.cancelRun(
      runId,
      1,
      new Date().toISOString(),
    )
    await waitForPostgresLock('%test_execution_jobs%ORDER BY id FOR UPDATE%')
    await taskBlocker.query('COMMIT')
    taskBlockerOpen = false

    const [claimResult, cancelled] = await Promise.all([
      claimPromise,
      cancelPromise,
    ])
    assert.equal(claimResult, null)
    assert.equal(cancelled.status, 'partial')
  } finally {
    if (taskBlockerOpen) {
      await taskBlocker.query('ROLLBACK').catch(() => undefined)
    }
    taskBlocker.release()
  }
  const finalTasks = await firstStore.listTasks(runId)
  assert.deepEqual(
    finalTasks.map(taskValue => taskValue.status),
    ['cancelled', 'blocked'],
  )
})

async function appendScriptAndAttempt(claimed: ExecutionJob) {
  const sourceArtifact: ExecutionArtifact = {
    id: `${prefix}-source-artifact`, runId: ids.run, taskId: ids.task, type: 'script', storagePath: `objects/33/${'3'.repeat(64)}`, sha256: '3'.repeat(64), size: 100, mimeType: 'text/typescript', createdAt: now,
  }
  const scriptArtifactBase = {
    caseId: ids.libraryCase, caseRevision: 1, method: 'ui' as const, caseContentSha256, executionSpecSha256: frozenInput.executionSpecSha256, environmentSignature: run.environment.signature, testScriptAgentVersion: 1, testScriptAgentConfigurationSha256: 'a'.repeat(64),
  }
  const scriptArtifact: ScriptArtifact = {
    id: `${prefix}-script-artifact`, cacheKey: scriptCacheKey(scriptArtifactBase), ...scriptArtifactBase, createdAt: now,
  }
  const manifestBase = {
    schemaVersion: 'execution-package/v1' as const,
    taskId: ids.task,
    caseId: ids.libraryCase,
    caseRevision: 1,
    method: 'ui' as const,
    entrypoint: `tests/${ids.task}.spec.ts`,
    taskInputSha256: frozenInput.inputSha256,
    caseContentSha256,
    executionSpecSha256: frozenInput.executionSpecSha256,
    environmentSignature: run.environment.signature,
    files: [{ path: `tests/${ids.task}.spec.ts`, contentSha256: '3'.repeat(64), size: 100 }],
    assertions: [],
    protectedAssertionSha256: canonicalSha256([]),
  }
  const manifest: ExecutionPackageManifest = {
    ...manifestBase,
    packageSha256: canonicalSha256(manifestBase),
  }
  const revision: ScriptRevision = {
    id: `${prefix}-script-revision`, runId: ids.run, taskId: ids.task, scriptArtifactId: scriptArtifact.id, revision: 1, source: 'agent', generatedBy: run.agents.testScript, package: manifest, sourceArtifactId: sourceArtifact.id, contentSha256: '3'.repeat(64), protectedAssertionSha256: manifest.protectedAssertionSha256, createdAt: now,
  }
  const attempt: ExecutionAttempt = {
    id: `${prefix}-attempt`, runId: ids.run, taskId: ids.task, ordinal: 1, invocationKey: `${prefix}-invocation`, kind: 'initial', scriptRevisionId: revision.id, packageSha256: manifest.packageSha256, status: 'running', startedAt: now,
  }
  const activeLease = lease(claimed)
  const ready = required(
    await secondStore.transactionWithLease(claimed.id, activeLease, async transaction => {
      await transaction.appendArtifact(sourceArtifact)
      await transaction.appendArtifact({
        ...sourceArtifact,
        createdAt: sourceArtifact.createdAt.replace(/Z$/u, '+00:00'),
      })
      await assert.rejects(
        transaction.appendArtifact({ ...sourceArtifact, mimeType: 'application/javascript' }),
        /ARTIFACT_CONFLICT/u,
      )
      await transaction.appendScriptArtifact(scriptArtifact)
      await transaction.appendScriptRevision(revision)
      await transaction.appendScriptRevision({
        ...revision,
        createdAt: revision.createdAt.replace(/Z$/u, '+00:00'),
      })
      await assert.rejects(
        transaction.appendScriptRevision({ ...revision, createdAt: new Date(Date.now() + 50).toISOString() }),
        /SCRIPT_REVISION_CONFLICT/u,
      )
      return transaction.transitionTask({ taskId: ids.task, expectedStatus: 'script_generating', expectedStateVersion: 1, status: 'ready', currentScriptRevisionId: revision.id })
    }),
    '脚本 revision 应原子进入 ready',
  )
  await assert.rejects(
    secondStore.transactionWithLease(claimed.id, activeLease, transaction => transaction.appendAttempt({
      ...attempt,
      kind: 'manual_retry',
    })),
    /TEST_EXECUTION_ATTEMPT_INITIAL_STATE_INVALID/u,
  )
  await secondStore.transactionWithLease(claimed.id, activeLease, async transaction => {
    await transaction.appendAttempt(attempt)
    await transaction.appendAttempt({
      ...attempt,
      startedAt: attempt.startedAt.replace(/Z$/u, '+00:00'),
    })
    await transaction.transitionTask({ taskId: ids.task, expectedStatus: 'ready', expectedStateVersion: ready.stateVersion, status: 'running', incrementRunnerAttempt: true })
  })
  assert.equal(await secondStore.finishJob(claimed.id, activeLease, 'succeeded'), false)
  const finalization = { attemptId: attempt.id, status: 'failed' as const, finishedAt: new Date(Date.now() + 100).toISOString(), durationMs: 100, exitCode: 1, summary: '真实执行失败' }
  const diagnosing = required(
    await secondStore.transactionWithLease(claimed.id, activeLease, async transaction => {
      const finalized = await transaction.finalizeAttempt(finalization)
      assert.equal(finalized.status, 'failed')
      return transaction.transitionTask({
        taskId: ids.task,
        expectedStatus: 'running',
        expectedStateVersion: 3,
        status: 'diagnosing',
      })
    }),
    '失败 attempt 与 task 应原子进入 diagnosing',
  )
  await secondStore.transactionWithLease(claimed.id, activeLease, transaction => transaction.appendAttempt(attempt))
  const replayed = await secondStore.transactionWithLease(claimed.id, activeLease, transaction => transaction.finalizeAttempt({
    ...finalization,
    finishedAt: finalization.finishedAt.replace(/Z$/u, '+00:00'),
  }))
  assert.equal(replayed?.finishedAt, finalization.finishedAt)
  await assert.rejects(
    secondStore.transactionWithLease(claimed.id, activeLease, transaction => transaction.finalizeAttempt({ attemptId: attempt.id, status: 'passed', finishedAt: new Date(Date.now() + 200).toISOString(), durationMs: 200 })),
    /ATTEMPT_ALREADY_FINALIZED/u,
  )
  const alternateSourceArtifact: ExecutionArtifact = {
    ...sourceArtifact,
    id: `${prefix}-alternate-source-artifact`,
    storagePath: `objects/66/${'6'.repeat(64)}`,
    sha256: '6'.repeat(64),
  }
  const { packageSha256: _basePackageSha256, ...alternateManifestBase } = {
    ...manifest,
    files: [{ ...manifest.files[0], contentSha256: alternateSourceArtifact.sha256 }],
  }
  const alternateManifest: ExecutionPackageManifest = {
    ...alternateManifestBase,
    packageSha256: canonicalSha256(alternateManifestBase),
  }
  const alternateRevision: ScriptRevision = {
    ...revision,
    id: `${prefix}-alternate-script-revision`,
    revision: 2,
    parentRevisionId: revision.id,
    source: 'repair',
    repairReason: '验证诊断 revision 归属',
    generatedBy: run.agents.scriptRepair,
    package: alternateManifest,
    sourceArtifactId: alternateSourceArtifact.id,
    contentSha256: alternateSourceArtifact.sha256,
  }
  const postRepairAttempt: ExecutionAttempt = {
    ...attempt,
    id: `${prefix}-post-repair-attempt`,
    ordinal: 2,
    invocationKey: `${prefix}-post-repair-invocation`,
    kind: 'post_repair',
    scriptRevisionId: alternateRevision.id,
    packageSha256: alternateRevision.package.packageSha256,
    startedAt: new Date(Date.now() + 225).toISOString(),
  }
  const manualRetryAttempt: ExecutionAttempt = {
    ...postRepairAttempt,
    id: `${prefix}-manual-retry-attempt`,
    ordinal: 3,
    invocationKey: `${prefix}-manual-retry-invocation`,
    kind: 'manual_retry',
    startedAt: new Date(Date.now() + 275).toISOString(),
  }
  const diagnosis: FailureDiagnosis = {
    id: `${prefix}-diagnosis`,
    runId: ids.run,
    taskId: ids.task,
    scriptRevisionId: revision.id,
    attemptIds: [attempt.id],
    category: 'script_defect',
    confidence: 0.9,
    summary: '脚本需要人工检查',
    evidence: [{ attemptId: attempt.id, observation: '真实执行失败' }],
    repairable: true,
    recommendedAction: '检查 locator',
    source: 'deterministic',
    createdAt: new Date(Date.now() + 250).toISOString(),
  }
  await secondStore.transactionWithLease(claimed.id, activeLease, async transaction => {
    await transaction.appendArtifact(alternateSourceArtifact)
    await transaction.appendScriptRevision(alternateRevision)
    const repairing = await transaction.transitionTask({
      taskId: ids.task,
      expectedStatus: 'diagnosing',
      expectedStateVersion: diagnosing.stateVersion,
      status: 'repairing',
    })
    const repaired = await transaction.transitionTask({
      taskId: ids.task,
      expectedStatus: 'repairing',
      expectedStateVersion: repairing.stateVersion,
      status: 'ready',
      currentScriptRevisionId: alternateRevision.id,
      incrementRepair: true,
    })
    await transaction.appendAttempt(postRepairAttempt)
    const postRepairRunning = await transaction.transitionTask({
      taskId: ids.task,
      expectedStatus: 'ready',
      expectedStateVersion: repaired.stateVersion,
      status: 'running',
      incrementRunnerAttempt: true,
    })
    await transaction.finalizeAttempt({
      attemptId: postRepairAttempt.id,
      status: 'failed',
      finishedAt: new Date(Date.now() + 250).toISOString(),
      durationMs: 25,
    })
    const blocked = await transaction.transitionTask({
      taskId: ids.task,
      expectedStatus: 'running',
      expectedStateVersion: postRepairRunning.stateVersion,
      status: 'blocked',
      error: '验证 post_repair 后的人工重试',
      finishedAt: new Date(Date.now() + 250).toISOString(),
    })
    const manualReady = await transaction.transitionTask({
      taskId: ids.task,
      expectedStatus: 'blocked',
      expectedStateVersion: blocked.stateVersion,
      status: 'ready',
      currentScriptRevisionId: alternateRevision.id,
    })
    await transaction.appendAttempt(manualRetryAttempt)
    const manualRunning = await transaction.transitionTask({
      taskId: ids.task,
      expectedStatus: 'ready',
      expectedStateVersion: manualReady.stateVersion,
      status: 'running',
      incrementRunnerAttempt: true,
    })
    await transaction.finalizeAttempt({
      attemptId: manualRetryAttempt.id,
      status: 'failed',
      finishedAt: new Date(Date.now() + 300).toISOString(),
      durationMs: 25,
    })
    const manualDiagnosing = await transaction.transitionTask({
      taskId: ids.task,
      expectedStatus: 'running',
      expectedStateVersion: manualRunning.stateVersion,
      status: 'diagnosing',
    })
    await assert.rejects(
      transaction.appendDiagnosis({
        ...diagnosis,
        id: `${diagnosis.id}-wrong-revision`,
        scriptRevisionId: alternateRevision.id,
      }),
      /DIAGNOSIS_ATTEMPT_SCOPE_MISMATCH/u,
    )
    await transaction.appendDiagnosis(diagnosis)
    await transaction.appendDiagnosis(diagnosis)
    await assert.rejects(
      transaction.appendDiagnosis({ ...diagnosis, summary: '冲突诊断' }),
      /DIAGNOSIS_CONFLICT/u,
    )
    await assert.rejects(
      transaction.appendDiagnosis({ ...diagnosis, id: `${diagnosis.id}-duplicate-attempt`, attemptIds: [attempt.id, attempt.id] }),
      /DIAGNOSIS_ATTEMPTS_INVALID/u,
    )
    await assert.rejects(
      transaction.appendDiagnosis({ ...diagnosis, id: `${diagnosis.id}-foreign-attempt`, attemptIds: [`${prefix}-foreign-attempt`] }),
      /DIAGNOSIS_ATTEMPT_SCOPE_MISMATCH/u,
    )
    await assert.rejects(
      transaction.appendDiagnosis({
        ...diagnosis,
        id: `${diagnosis.id}-foreign-evidence`,
        evidence: [{ attemptId: `${prefix}-foreign-attempt`, observation: '外部执行事实' }],
      }),
      /DIAGNOSIS_EVIDENCE_SCOPE_MISMATCH/u,
    )
    await transaction.transitionTask({ taskId: ids.task, expectedStatus: 'diagnosing', expectedStateVersion: manualDiagnosing.stateVersion, status: 'waiting_manual', finishedAt: new Date(Date.now() + 325).toISOString() })
    await transaction.recomputeRun(ids.run)
  })
  assert.equal((await firstStore.listDiagnoses(ids.task)).length, 1)
  const forgedSourceArtifact: ExecutionArtifact = {
    ...sourceArtifact,
    id: `${prefix}-forged-source-artifact`,
    storagePath: `objects/77/${'7'.repeat(64)}`,
    sha256: '7'.repeat(64),
  }
  const { packageSha256: _alternatePackageSha256, ...forgedManifestBase } = {
    ...alternateManifest,
    files: [{
      ...alternateManifest.files[0],
      contentSha256: forgedSourceArtifact.sha256,
    }],
  }
  const forgedPackageSha256 = '8'.repeat(64)
  const forgedManifest: ExecutionPackageManifest = {
    ...forgedManifestBase,
    packageSha256: forgedPackageSha256,
  }
  const packageConstraintClient = await database.connect()
  try {
    await packageConstraintClient.query('BEGIN')
    await packageConstraintClient.query(`
      INSERT INTO smarthub.test_execution_artifacts (
        id,run_id,task_id,attempt_id,artifact_type,storage_path,
        sha256,byte_size,mime_type,created_at
      ) VALUES ($1,$2,$3,NULL,'script',$4,$5,$6,$7,$8)
    `, [
      forgedSourceArtifact.id,
      forgedSourceArtifact.runId,
      forgedSourceArtifact.taskId,
      forgedSourceArtifact.storagePath,
      forgedSourceArtifact.sha256,
      forgedSourceArtifact.size,
      forgedSourceArtifact.mimeType,
      forgedSourceArtifact.createdAt,
    ])
    await assert.rejects(
      packageConstraintClient.query(`
        INSERT INTO smarthub.test_execution_script_revisions (
          id,run_id,task_id,script_artifact_id,revision,parent_revision_id,
          generation_source,repair_reason,generated_by,package_manifest,
          package_sha256,source_artifact_id,content_sha256,
          protected_assertion_sha256,created_at
        ) VALUES (
          $1,$2,$3,$4,3,$5,'repair',$6,$7::jsonb,$8::jsonb,
          $9,$10,$11,$12,$13
        )
      `, [
        `${prefix}-forged-script-revision`,
        ids.run,
        ids.task,
        scriptArtifact.id,
        alternateRevision.id,
        '验证数据库拒绝伪造 package hash',
        JSON.stringify(run.agents.scriptRepair),
        JSON.stringify(forgedManifest),
        forgedPackageSha256,
        forgedSourceArtifact.id,
        forgedSourceArtifact.sha256,
        forgedManifest.protectedAssertionSha256,
        forgedSourceArtifact.createdAt,
      ]),
      /TEST_EXECUTION_SCRIPT_REVISION_SOURCE_MISMATCH/u,
    )
  } finally {
    await packageConstraintClient.query('ROLLBACK')
    packageConstraintClient.release()
  }
  const constraintClient = await database.connect()
  try {
    await constraintClient.query('BEGIN')
    await constraintClient.query(`
      INSERT INTO smarthub.test_execution_diagnoses (
        id,run_id,task_id,script_revision_id,attempt_count,evidence_count,
        category,confidence,summary,repairable,recommended_action,source,agent_snapshot,created_at
      ) VALUES ($1,$2,$3,$4,1,1,'script_defect',0.9,$5,true,$6,'deterministic',NULL,$7)
    `, [
      `${diagnosis.id}-incomplete`,
      diagnosis.runId,
      diagnosis.taskId,
      diagnosis.scriptRevisionId,
      '缺少正规化子记录',
      '拒绝提交',
      diagnosis.createdAt,
    ])
    await assert.rejects(
      constraintClient.query('SET CONSTRAINTS smarthub.test_execution_diagnoses_children_ck IMMEDIATE'),
      /TEST_EXECUTION_DIAGNOSIS_CHILD_COUNT_MISMATCH/u,
    )
  } finally {
    await constraintClient.query('ROLLBACK')
    constraintClient.release()
  }
  const evidence = await database.query<{ count: string }>(
    'SELECT count(*) FROM smarthub.test_execution_diagnosis_evidence WHERE diagnosis_id=$1',
    [diagnosis.id],
  )
  assert.equal(Number(evidence.rows[0]?.count), 1)
}

function executionAggregateVariant(suffix: string, maxAttempts: number) {
  const runId = `${prefix}-${suffix}-run`
  const taskId = `${prefix}-${suffix}-task`
  const createdAt = now
  const variantRun: ExecutionRun = {
    ...run,
    id: runId,
    idempotencyKey: `${prefix}-${suffix}-idempotency`,
    createdAt,
  }
  const variantTask: ExecutionTask = {
    ...task,
    id: taskId,
    runId,
    createdAt,
    updatedAt: createdAt,
  }
  const variantJob: ExecutionJob = {
    ...job,
    id: `${prefix}-${suffix}-job`,
    runId,
    taskId,
    maxAttempts,
    availableAt: now,
    createdAt,
    updatedAt: createdAt,
  }
  return { run: variantRun, tasks: [variantTask], jobs: [variantJob] }
}

async function appendRunningAttempt(
  claimed: ExecutionJob,
  aggregate: ReturnType<typeof executionAggregateVariant>,
  suffix: string,
) {
  const variantTask = aggregate.tasks[0]
  const sourceArtifact: ExecutionArtifact = {
    id: `${prefix}-${suffix}-source-artifact`,
    runId: aggregate.run.id,
    taskId: variantTask.id,
    type: 'script',
    storagePath: `objects/33/${'3'.repeat(64)}`,
    sha256: '3'.repeat(64),
    size: 100,
    mimeType: 'text/typescript',
    createdAt: aggregate.run.createdAt,
  }
  const scriptArtifactBase = {
    caseId: ids.libraryCase,
    caseRevision: 1,
    method: 'ui' as const,
    caseContentSha256,
    executionSpecSha256: frozenInput.executionSpecSha256,
    environmentSignature: run.environment.signature,
    testScriptAgentVersion: 1,
    testScriptAgentConfigurationSha256: 'a'.repeat(64),
  }
  const scriptArtifact: ScriptArtifact = {
    id: `${prefix}-script-artifact`,
    cacheKey: scriptCacheKey(scriptArtifactBase),
    ...scriptArtifactBase,
    createdAt: now,
  }
  const manifestBase = {
    schemaVersion: 'execution-package/v1' as const,
    taskId: variantTask.id,
    caseId: ids.libraryCase,
    caseRevision: 1,
    method: 'ui' as const,
    entrypoint: `tests/${variantTask.id}.spec.ts`,
    taskInputSha256: frozenInput.inputSha256,
    caseContentSha256,
    executionSpecSha256: frozenInput.executionSpecSha256,
    environmentSignature: run.environment.signature,
    files: [{ path: `tests/${variantTask.id}.spec.ts`, contentSha256: '3'.repeat(64), size: 100 }],
    assertions: [],
    protectedAssertionSha256: canonicalSha256([]),
  }
  const manifest: ExecutionPackageManifest = {
    ...manifestBase,
    packageSha256: canonicalSha256(manifestBase),
  }
  const revision: ScriptRevision = {
    id: `${prefix}-${suffix}-script-revision`,
    runId: aggregate.run.id,
    taskId: variantTask.id,
    scriptArtifactId: scriptArtifact.id,
    revision: 1,
    source: 'agent',
    generatedBy: run.agents.testScript,
    package: manifest,
    sourceArtifactId: sourceArtifact.id,
    contentSha256: sourceArtifact.sha256,
    protectedAssertionSha256: manifest.protectedAssertionSha256,
    createdAt: aggregate.run.createdAt,
  }
  const attempt: ExecutionAttempt = {
    id: `${prefix}-${suffix}-attempt`,
    runId: aggregate.run.id,
    taskId: variantTask.id,
    ordinal: 1,
    invocationKey: `${prefix}-${suffix}-invocation`,
    kind: 'initial',
    scriptRevisionId: revision.id,
    packageSha256: manifest.packageSha256,
    status: 'running',
    startedAt: aggregate.run.createdAt,
  }
  await firstStore.transactionWithLease(claimed.id, lease(claimed), async transaction => {
    await transaction.transitionTask({ taskId: variantTask.id, expectedStatus: 'pending', expectedStateVersion: 0, status: 'script_generating' })
    await transaction.appendArtifact(sourceArtifact)
    await transaction.appendScriptArtifact(scriptArtifact)
    await transaction.appendScriptRevision(revision)
    const ready = await transaction.transitionTask({ taskId: variantTask.id, expectedStatus: 'script_generating', expectedStateVersion: 1, status: 'ready', currentScriptRevisionId: revision.id })
    await transaction.appendAttempt(attempt)
    await transaction.transitionTask({ taskId: variantTask.id, expectedStatus: 'ready', expectedStateVersion: ready.stateVersion, status: 'running', incrementRunnerAttempt: true })
  })
  return attempt
}

async function waitForPostgresLock(queryPattern: string) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const result = await database.query<{ waiting: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname=current_database()
          AND pid<>pg_backend_pid()
          AND wait_event_type='Lock'
          AND query ILIKE $1
      ) AS waiting
    `, [queryPattern])
    if (result.rows[0]?.waiting) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`未观察到预期 PostgreSQL 锁等待: ${queryPattern}`)
}

async function seedParents() {
  await database.query('INSERT INTO smarthub.projects (id,name,created_at,data) VALUES ($1,$2,$3,$4::jsonb)', [ids.project, `${prefix} project`, now, JSON.stringify({ id: ids.project, name: `${prefix} project`, createdAt: now })])
  await database.query('INSERT INTO smarthub.project_versions (id,project_id,name,status,created_at,updated_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)', [ids.projectVersion, ids.project, `${prefix} version`, 'open', now, now, JSON.stringify({ id: ids.projectVersion, projectId: ids.project, name: `${prefix} version`, status: 'open', createdAt: now, updatedAt: now })])
  await database.query('INSERT INTO smarthub.library_test_cases (id,project_id,current_revision,status,created_at,updated_at,data) VALUES ($1,$2,1,$3,$4,$4,$5::jsonb)', [ids.libraryCase, ids.project, 'active', now, JSON.stringify({ id: ids.libraryCase, projectId: ids.project, currentRevision: 1, status: 'active', createdAt: now, updatedAt: now })])
  await database.query('INSERT INTO smarthub.library_test_case_revisions (case_id,revision,content_sha256,semantic_sha256,created_by,created_at,content,data) VALUES ($1,1,$2,$2,$3,$4,$5::jsonb,$6::jsonb)', [ids.libraryCase, caseContentSha256, 'integration-test', now, JSON.stringify(caseContent), JSON.stringify({ revision: 1, content: caseContent, contentSha256: caseContentSha256, semanticSha256: caseContentSha256, changeReason: 'integration test', createdBy: 'integration-test', createdAt: now })])
  await database.query('INSERT INTO smarthub.test_case_library_versions (id,project_id,version,name,source_run_id,content_sha256,published_by,published_at,data) VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8::jsonb)', [ids.libraryVersion, ids.project, 'Execution library', librarySourceRunId, run.handoff.testCaseLibraryVersionSha256, 'integration-test', now, JSON.stringify({ id: ids.libraryVersion, projectId: ids.project, version: 1, name: 'Execution library', sourceRunId: librarySourceRunId, members: [libraryMember], contentSha256: run.handoff.testCaseLibraryVersionSha256, publishedBy: 'integration-test', publishedAt: now, projection: { status: 'succeeded', files: [] } })])
  await database.query('INSERT INTO smarthub.test_case_library_version_members (version_id,case_id,case_revision,ordinal,content_sha256,frozen_content,execution_readiness) VALUES ($1,$2,1,0,$3,$4::jsonb,$5)', [ids.libraryVersion, ids.libraryCase, caseContentSha256, JSON.stringify(caseContent), 'ready'])
  await database.query('INSERT INTO smarthub.test_execution_handoffs (id,project_version_id,test_case_library_version_id,execution_mode,strategy,content_sha256,created_by,created_at,content,data) VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8::jsonb,$8::jsonb)', [ids.handoff, ids.projectVersion, ids.libraryVersion, 'full', run.handoff.handoffSha256, 'integration-test', now, JSON.stringify({ id: ids.handoff, projectId: ids.project, projectVersionId: ids.projectVersion, testCaseLibraryVersionId: ids.libraryVersion, mode: 'full', members: [handoffMember], contentSha256: run.handoff.handoffSha256, createdBy: 'integration-test', createdAt: now })])
  await database.query('INSERT INTO smarthub.test_execution_handoff_members (handoff_id,stage,ordinal,source_version_id,case_id,case_revision,method,dedup_key,dimension,execution_spec,content_sha256,data) VALUES ($1,$2,0,$3,$4,1,$5,$6,$7,$8::jsonb,$9,$10::jsonb)', [ids.handoff, 'full', ids.libraryVersion, ids.libraryCase, 'ui', handoffMember.dedupKey, 'functional', JSON.stringify(executionSpec), caseContentSha256, JSON.stringify(handoffMember)])
}

function lease(jobValue: ExecutionJob): ExecutionJobLease {
  return { workerId: required(jobValue.leaseOwner, '任务缺少 leaseOwner'), runToken: required(jobValue.runToken, '任务缺少 runToken'), fencingToken: jobValue.fencingToken }
}

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message)
  return value
}
