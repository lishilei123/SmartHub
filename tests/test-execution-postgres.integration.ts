import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { canonicalJson, canonicalSha256 } from '../server/application/canonical-json.js'
import { TestExecutionInfrastructureConfigurationService } from '../server/application/test-execution-infrastructure-configuration-service.js'
import {
  executionCreateRequestCanonical,
  executionCreateRequestSha256,
  freezeExecutionTaskInput,
  scriptCacheKey,
} from '../server/application/test-execution-validation.js'
import type {
  ExecutionArtifact,
  ExecutionAttempt,
  ExecutionEvent,
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
  TestCaseContent,
  TestCaseLibraryVersionMemberDetail,
  TestExecutionHandoffMember,
} from '../server/domain/test-design-types.js'
import { runMigrations } from '../server/infrastructure/migrations.js'
import { PostgresStore } from '../server/infrastructure/postgres-store.js'
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

const caseContent: TestCaseContent = {
  schemaVersion: 'test-case/v3',
  title: '健康检查',
  dimension: 'functional',
  requirementRefs: ['health-point'],
  priority: 'P0',
  preconditions: [],
  executionMethods: ['ui'],
  steps: ['打开健康页'],
  expectedResults: ['状态为 Ready'],
}
const executionSpec = { schemaVersion: 'test-script-input/v1' as const, method: 'ui' as const, testCase: caseContent }
const caseContentSha256 = canonicalSha256(caseContent)
const libraryMember: TestCaseLibraryVersionMemberDetail = {
  caseId: ids.libraryCase,
  revision: 1,
  ordinal: 0,
  contentSha256: caseContentSha256,
  frozenContent: caseContent,
  frozenExecutionMethods: ['ui'],
  executionReadiness: 'ready',
}
const librarySourceRunId = `${prefix}-library-source-run`
const libraryVersionSha256 = canonicalSha256({
  schemaVersion: 'test-case-library/v3',
  projectId: ids.project,
  projectVersionId: ids.projectVersion,
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
  model: {
    sourceId: 'source-1',
    modelId: 'model-1',
    providerType: 'anthropic',
    modelName: 'model-1',
    baseUrlSha256: 'd'.repeat(64),
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsReasoning: true,
    requestTimeoutMs: 30_000,
    retryCount: 2,
  },
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
  agents: { executionImplementation: agentSnapshot('execution-implementation'), failureAnalysis: agentSnapshot('failure-analysis') },
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
  assert.deepEqual(await firstStore.readiness(), { ready: true })
  assert.equal((await firstStore.listTasks(ids.run)).length, 1)
  const detail = required(
    await firstStore.getTaskDetail(ids.task),
    '应返回同一 repeatable-read 快照中的 Task detail',
  )
  assert.equal(detail.run.id, ids.run)
  assert.equal(detail.task.id, ids.task)
  assert.deepEqual(detail.attempts, [])
  assert.deepEqual(detail.diagnoses, [])
  assert.deepEqual(detail.scriptRevisions, [])
  assert.deepEqual(detail.artifacts, [])
  const firstReportSnapshot = required(await firstStore.getRunReportSnapshot(ids.run), '报告应读取真实 PostgreSQL 来源签名')
  assert.equal(firstReportSnapshot.unchanged, false)
  const cachedReportSnapshot = required(await firstStore.getRunReportSnapshot(ids.run, firstReportSnapshot.revision), '报告缓存应能校验相同签名')
  assert.equal(cachedReportSnapshot.unchanged, true)
  assert.equal('source' in cachedReportSnapshot, false, '缓存命中不再读取完整报告源')
  const replayWithFreshServerFacts = await firstStore.createAggregate({
    run: {
      ...run,
      id: `${ids.run}-regenerated`,
      createdAt: new Date(Date.now() + 50).toISOString(),
      environment: {
        ...run.environment,
        signature: '9'.repeat(64),
      },
    },
    tasks: [{
      ...task,
      id: `${ids.task}-regenerated`,
      runId: `${ids.run}-regenerated`,
    }],
    jobs: [{
      ...job,
      id: `${ids.job}-regenerated`,
      runId: `${ids.run}-regenerated`,
      taskId: `${ids.task}-regenerated`,
      maxAttempts: 4,
    }],
  })
  assert.equal(replayWithFreshServerFacts.id, ids.run)
  await assert.rejects(
    firstStore.createAggregate({
      run: {
        ...run,
        environment: {
          ...run.environment,
          environmentId: `${run.environment.environmentId}-other`,
        },
      },
      tasks: [task],
      jobs: [job],
    }),
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
  assert.deepEqual(await firstStore.renewJobLease(active.id, lease(active), 60_000), { status: 'renewed' })

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
  assert.deepEqual(await firstStore.renewJobLease(active.id, lease(active), 60_000), { status: 'lease_lost' })

  await assert.rejects(
    secondStore.transactionWithLease(reclaimed.id, lease(reclaimed), transaction => transaction.transitionTask({ taskId: ids.task, expectedStatus: 'script_generating', expectedStateVersion: 0, status: 'ready' })),
    /TASK_STATE_CONFLICT/u,
  )

  await appendScriptAndAttempt(reclaimed)
  assert.deepEqual(
    (await firstStore.listAttempts(ids.task)).map(item => item.ordinal),
    [1, 2, 3],
  )
  const events = await firstStore.listEvents(ids.task, `${prefix}-attempt`)
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'failure')
  assert.equal(events[0].artifactIds?.length, 1)
  assert.deepEqual((await firstStore.getTaskDetail(ids.task))?.events, events)
  const updatedReportSnapshot = required(await firstStore.getRunReportSnapshot(ids.run, firstReportSnapshot.revision), '执行事实变化后报告必须失效')
  assert.equal(updatedReportSnapshot.unchanged, false)
  assert.notEqual(updatedReportSnapshot.revision, firstReportSnapshot.revision)
  await assert.rejects(
    database.query('UPDATE smarthub.test_execution_events SET title=$2 WHERE id=$1', [events[0].id, '不可改写']),
    /TEST_EXECUTION_EVENT_IMMUTABLE/u,
  )
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

  const blockedTask = required(await firstStore.getTask(exhaustedTaskId), '耗尽 Task 应存在')
  const partialRun = required(await firstStore.getRun(exhaustedRunId), '耗尽 Run 应存在')
  const manualRetryJob: ExecutionJob = {
    ...job,
    id: `${prefix}-exhausted-manual-retry-job`,
    runId: exhaustedRunId,
    taskId: exhaustedTaskId,
    maxAttempts: 1,
    request: {
      kind: 'manual_retry',
      idempotencyKey: `${prefix}-exhausted-manual-retry`,
      requestedBy: 'integration-test',
    },
    createdAt: new Date(Date.now() + 450).toISOString(),
    updatedAt: new Date(Date.now() + 450).toISOString(),
  }
  const retried = await firstStore.retryTask({
    runId: exhaustedRunId,
    taskId: exhaustedTaskId,
    expectedRunStateVersion: partialRun.stateVersion,
    expectedTaskStateVersion: blockedTask.stateVersion,
    job: manualRetryJob,
  })
  assert.equal(retried.status, 'pending')
  assert.equal(retried.currentScriptRevisionId, undefined)
  assert.equal((await firstStore.getRun(exhaustedRunId))?.status, 'running')

  const manualRetryClaim = required(await firstStore.claimJob('execution-worker-manual-retry', 60_000), '脚本生成前阻塞的人工重试应重新排队')
  assert.equal(manualRetryClaim.id, manualRetryJob.id)
  assert.equal(await firstStore.releaseJob(manualRetryJob.id, lease(manualRetryClaim), 0, 'provider still unavailable'), true)
  assert.equal((await firstStore.getTask(exhaustedTaskId))?.status, 'blocked')
})

test('PostgreSQL 结构化续租区分明确取消和旧 Fencing Token', async () => {
  const aggregate = executionAggregateVariant('structured-renew-cancellation', 2)
  await firstStore.createAggregate(aggregate)
  const claimed = required(await firstStore.claimJob('structured-renew-worker', 60_000), '应领取任务')
  assert.equal(claimed.taskId, aggregate.tasks[0].id)
  await appendRunningAttempt(claimed, aggregate, 'structured-renew-attempt')
  assert.deepEqual(await firstStore.renewJobLease(claimed.id, lease(claimed), 60_000), { status: 'renewed' })
  const run = required(await firstStore.getRun(aggregate.run.id), 'Run 应存在')
  await firstStore.cancelRun(run.id, run.stateVersion, new Date().toISOString())
  assert.deepEqual(await firstStore.renewJobLease(claimed.id, lease(claimed), 60_000), { status: 'cancel_requested' })
  assert.deepEqual(await firstStore.renewJobLease(claimed.id, { ...lease(claimed), fencingToken: claimed.fencingToken + 1 }, 60_000), { status: 'lease_lost' })
})

test('PostgreSQL 并发同请求只创建一个聚合并返回唯一键赢家', async () => {
  const first = executionAggregateVariant('concurrent-idempotency-a', 2)
  const second = executionAggregateVariant('concurrent-idempotency-b', 3)
  second.run.idempotencyKey = first.run.idempotencyKey

  const [firstResult, secondResult] = await Promise.all([
    firstStore.createAggregate(first),
    secondStore.createAggregate(second),
  ])

  assert.equal(firstResult.id, secondResult.id)
  assert.ok(
    firstResult.id === first.run.id
      || firstResult.id === second.run.id,
  )
  assert.equal(
    (await firstStore.listTasks(firstResult.id)).length,
    1,
  )
  const cancelled = await firstStore.cancelRun(
    firstResult.id,
    0,
    new Date().toISOString(),
  )
  assert.equal(cancelled.status, 'cancelled')
})

test('PostgreSQL 对 canonical text 的原始 UTF-8 字节求 Hash', async () => {
  const canonical = canonicalJson({ threshold: 1e-7 })
  const result = await database.query<{
    equivalent: boolean
    sha256: string
  }>(`
    SELECT $1::text::jsonb =
             '{"threshold":0.0000001}'::jsonb AS equivalent,
           encode(digest(convert_to($1::text, 'UTF8'), 'sha256'), 'hex') AS sha256
  `, [canonical])
  assert.equal(result.rows[0]?.equivalent, true)
  assert.equal(
    result.rows[0]?.sha256,
    canonicalSha256({ threshold: 1e-7 }),
  )
})

test('PostgreSQL 按任务阶段领取资源并保持交接前的失败预算和 fencing', async () => {
  const aggregate = executionAggregateVariant('resource-handoff', 2)
  await firstStore.createAggregate(aggregate)
  assert.equal(await firstStore.claimJob('agent-no-pending', 60_000, 'agent'), null)
  const runnerJob = required(await firstStore.claimJob('runner-binding', 60_000, 'runner'), 'pending 由 Runner 检查 Binding')
  assert.equal(runnerJob.id, aggregate.jobs[0].id)
  await firstStore.transactionWithLease(runnerJob.id, lease(runnerJob), transaction => transaction.transitionTask({
    taskId: runnerJob.taskId, expectedStatus: 'pending', expectedStateVersion: 0, status: 'script_generating',
  }))
  assert.equal(await firstStore.yieldJob(runnerJob.id, { ...lease(runnerJob), fencingToken: runnerJob.fencingToken + 1 }), false)
  assert.equal(await firstStore.yieldJob(runnerJob.id, lease(runnerJob)), true)
  assert.equal(await firstStore.yieldJob(runnerJob.id, lease(runnerJob)), false)
  assert.equal(await firstStore.claimJob('runner-no-generating', 60_000, 'runner'), null)
  const agentJob = required(await secondStore.claimJob('agent-generate', 60_000, 'agent'), 'Agent 应领取生成阶段')
  assert.equal(agentJob.id, runnerJob.id)
  assert.equal(agentJob.attempts, 1)
  assert.equal(agentJob.fencingToken, runnerJob.fencingToken + 1)
  assert.notEqual(agentJob.runToken, runnerJob.runToken)
  assert.equal(await firstStore.transactionWithLease(runnerJob.id, lease(runnerJob), async () => true), null)
  assert.equal(await firstStore.heartbeatJob(runnerJob.id, lease(runnerJob), 60_000), false)
  await assert.rejects(database.query('UPDATE smarthub.test_execution_jobs SET attempt_count=0 WHERE id=$1', [agentJob.id]), /TEST_EXECUTION_JOB_ATTEMPT_COUNT_INVALID/u)
  assert.equal(await secondStore.releaseJob(agentJob.id, lease(agentJob), 0, 'provider unavailable'), true)
  const retry = required(await firstStore.claimJob('agent-retry', 60_000, 'agent'), '真实失败应消耗一次预算')
  assert.equal(retry.attempts, 2)
  assert.equal(await firstStore.yieldJob(retry.id, lease(retry)), true)
  const continued = required(await secondStore.claimJob('agent-continue', 60_000, 'agent'), '交接后保留真实失败预算')
  assert.equal(continued.attempts, 2)
  assert.equal(await secondStore.releaseJob(continued.id, lease(continued), 0, 'provider still unavailable'), true)
  assert.equal((await firstStore.getTask(continued.taskId))?.status, 'blocked')
})

test('PostgreSQL 拒绝交接运行中的 Attempt 并将诊断阶段交给 Agent', async () => {
  const aggregate = executionAggregateVariant('resource-running-attempt', 2)
  await firstStore.createAggregate(aggregate)
  const runnerJob = required(await firstStore.claimJob('runner-attempt', 60_000, 'runner'), 'Runner 应领取任务')
  const attempt = await appendRunningAttempt(runnerJob, aggregate, 'resource-running-attempt')
  assert.equal(await firstStore.yieldJob(runnerJob.id, lease(runnerJob)), false)
  const taskBefore = required(await firstStore.getTask(runnerJob.taskId), '运行任务应存在')
  await firstStore.transactionWithLease(runnerJob.id, lease(runnerJob), async transaction => {
    await transaction.finalizeAttempt({ attemptId: attempt.id, status: 'failed', durationMs: 1, finishedAt: new Date().toISOString(), exitCode: 1 })
    return transaction.transitionTask({ taskId: runnerJob.taskId, expectedStatus: 'running', expectedStateVersion: taskBefore.stateVersion, status: 'diagnosing' })
  })
  assert.equal(await firstStore.yieldJob(runnerJob.id, lease(runnerJob)), true)
  assert.equal(await secondStore.claimJob('runner-no-diagnosis', 60_000, 'runner'), null)
  const agentJob = required(await secondStore.claimJob('agent-diagnosis', 60_000, 'agent'), 'Agent 应领取诊断阶段')
  assert.equal(agentJob.taskId, runnerJob.taskId)
  const currentRun = required(await firstStore.getRun(aggregate.run.id), 'Run 应存在')
  await firstStore.cancelRun(currentRun.id, currentRun.stateVersion, new Date().toISOString())
  assert.equal(await secondStore.yieldJob(agentJob.id, lease(agentJob)), false)
  assert.equal(await firstStore.claimJob('agent-no-cancelled', 60_000, 'agent'), null)
  assert.equal((await firstStore.getTask(agentJob.taskId))?.status, 'cancelled')
  assert.equal((await firstStore.getRun(aggregate.run.id))?.status, 'cancelled')
})

test('PostgreSQL Runner 占用期间独立预检仍可领取 pending 并分流到 Agent', async () => {
  const runningAggregate = executionAggregateVariant('preparation-occupied-runner', 2)
  await firstStore.createAggregate(runningAggregate)
  const runnerJob = required(await firstStore.claimJob('occupied-runner', 60_000, 'runner'), 'Runner 应领取现有任务')
  const attempt = await appendRunningAttempt(runnerJob, runningAggregate, 'preparation-occupied-runner')
  const pendingAggregate = executionAggregateVariant('preparation-pending', 2)
  await firstStore.createAggregate(pendingAggregate)
  assert.equal(await secondStore.claimJob('runner-excludes-pending', 60_000, 'runner', false), null)
  const preparationJob = required(await secondStore.claimJob('independent-preparation', 60_000, 'runner', true), '预检不受运行中 Runner 影响')
  assert.equal(preparationJob.id, pendingAggregate.jobs[0].id)
  assert.equal((await firstStore.listAttempts(runnerJob.taskId))[0]?.status, 'running')
  assert.equal(await firstStore.heartbeatJob(runnerJob.id, lease(runnerJob), 60_000), true)
  await secondStore.transactionWithLease(preparationJob.id, lease(preparationJob), transaction => transaction.transitionTask({
    taskId: preparationJob.taskId, expectedStatus: 'pending', expectedStateVersion: 0, status: 'script_generating',
  }))
  assert.equal(await secondStore.yieldJob(preparationJob.id, lease(preparationJob)), true)
  assert.equal(await firstStore.claimJob('preparation-excludes-generation', 60_000, 'runner', true), null)
  const agentJob = required(await secondStore.claimJob('agent-during-runner-occupation', 60_000, 'agent', false), '缺脚本任务在 Runner 占用期间进入 Agent')
  assert.equal(agentJob.taskId, preparationJob.taskId)
  assert.equal(agentJob.attempts, 1)
  assert.equal((await firstStore.listAttempts(runnerJob.taskId))[0]?.status, 'running')
  await secondStore.transactionWithLease(agentJob.id, lease(agentJob), transaction => transaction.transitionTask({
    taskId: agentJob.taskId, expectedStatus: 'script_generating', expectedStateVersion: 1, status: 'blocked', error: 'integration cleanup', finishedAt: new Date().toISOString(),
  }))
  assert.equal(await secondStore.finishJob(agentJob.id, lease(agentJob), 'failed'), true)
  const runningTask = required(await firstStore.getTask(runnerJob.taskId), '运行中的任务应存在')
  await firstStore.transactionWithLease(runnerJob.id, lease(runnerJob), async transaction => {
    await transaction.finalizeAttempt({ attemptId: attempt.id, status: 'infrastructure_error', durationMs: 1, finishedAt: new Date().toISOString(), error: 'integration cleanup' })
    await transaction.transitionTask({ taskId: runnerJob.taskId, expectedStatus: 'running', expectedStateVersion: runningTask.stateVersion, status: 'blocked', error: 'integration cleanup', finishedAt: new Date().toISOString() })
  })
  assert.equal(await firstStore.finishJob(runnerJob.id, lease(runnerJob), 'failed'), true)
})

test('PostgreSQL 配置草稿跨连接保存发布、拒绝并发覆盖并兼容历史默认值', async () => {
  const configurationStore = new PostgresStore(connectionString)
  const otherConfigurationStore = new PostgresStore(connectionString)
  const configurationService = new TestExecutionInfrastructureConfigurationService(configurationStore)
  const otherConfigurationService = new TestExecutionInfrastructureConfigurationService(otherConfigurationStore)
  const createdIds: string[] = []
  try {
    await configurationStore.load()
    await otherConfigurationStore.load()
    assert.deepEqual(await configurationStore.listTestExecutionInfrastructureConfigurationVersions(), [])
    const historical = {
      id: `${prefix}-historical-configuration`, version: 1, status: 'active', environments: [],
      contentSha256: 'a'.repeat(64), createdAt: now, publishedBy: '历史管理员',
    }
    await database.query('INSERT INTO smarthub.test_execution_infrastructure_configuration_versions (id,version,status,created_at,data) VALUES ($1,1,$2,$3,$4::jsonb)', [historical.id, historical.status, now, JSON.stringify(historical)])
    createdIds.push(historical.id)
    configurationStore.snapshot = async () => { throw new Error('Configuration polling must not load the full database') }
    assert.equal((await configurationService.resolveConcurrency()).source, 'historical_defaults')
    assert.equal((await configurationService.resolveConcurrency()).runnerConcurrency, 3)
    assert.equal((await configurationService.resolveConcurrency()).agentConcurrency, 1)
    const draft = await configurationService.saveDraft({ expectedActiveVersion: 1, environments: [], concurrency: { runnerConcurrency: 8, agentConcurrency: 2 } }, '保存人')
    assert.deepEqual(await otherConfigurationStore.getTestExecutionInfrastructureConfigurationDraft(), draft)
    assert.equal((await otherConfigurationService.resolveConcurrency()).source, 'historical_defaults')
    assert.deepEqual(await configurationStore.getActiveTestExecutionInfrastructureConfiguration(), historical)
    const saves = await Promise.allSettled([
      configurationService.saveDraft({ expectedActiveVersion: 1, expectedDraftRevision: draft.revision, environments: [], concurrency: { runnerConcurrency: 16, agentConcurrency: 8 } }, '并发保存人甲'),
      otherConfigurationService.saveDraft({ expectedActiveVersion: 1, expectedDraftRevision: draft.revision, environments: [], concurrency: { runnerConcurrency: 16, agentConcurrency: 8 } }, '并发保存人乙'),
    ])
    assert.equal(saves.filter(result => result.status === 'fulfilled').length, 1)
    const rejectedSave = saves.find(result => result.status === 'rejected')
    assert.equal(rejectedSave?.status, 'rejected')
    if (rejectedSave?.status === 'rejected') assert.match(String(rejectedSave.reason), /DRAFT_CONFLICT/u)
    await assert.rejects(configurationService.publishDraft({ revision: draft.revision, expectedActiveVersion: 1 }, '过期发布人'), /DRAFT_CONFLICT/u)
    const currentDraft = required(await configurationStore.getTestExecutionInfrastructureConfigurationDraft(), '草稿应持久化')
    const published = await otherConfigurationService.publishDraft({ revision: currentDraft.revision, expectedActiveVersion: 1 }, '发布人')
    createdIds.push(published.id)
    assert.equal(published.version, 2)
    assert.deepEqual(await configurationService.resolveConcurrency(), {
      runnerConcurrency: 16, agentConcurrency: 8, source: 'published_configuration',
      version: 2, publishedAt: published.createdAt, publishedBy: '发布人',
    })
    assert.deepEqual(await configurationService.resolveVersion(historical.id), { ...historical, status: 'superseded' })
    const retainedDraft = required(await configurationStore.getTestExecutionInfrastructureConfigurationDraft(), '发布后草稿版本应单调增长')
    assert.equal(retainedDraft.revision, currentDraft.revision + 1)
    assert.equal(retainedDraft.expectedActiveVersion, 2)
    for (const concurrency of [
      { runnerConcurrency: 0, agentConcurrency: 1 }, { runnerConcurrency: 17, agentConcurrency: 1 },
      { runnerConcurrency: 1, agentConcurrency: 0 }, { runnerConcurrency: 1, agentConcurrency: 9 },
      { runnerConcurrency: 1.5, agentConcurrency: 1 }, { runnerConcurrency: '3', agentConcurrency: 1 }, null,
    ]) {
      await assert.rejects(database.query("UPDATE smarthub.test_execution_infrastructure_configuration_drafts SET data=jsonb_set(data,'{concurrency}',$1::jsonb) WHERE id='default'", [JSON.stringify(concurrency)]), /test_execution_infrastructure_draft_concurrency_ck/u)
      await assert.rejects(database.query("UPDATE smarthub.test_execution_infrastructure_configuration_versions SET data=jsonb_set(data,'{concurrency}',$1::jsonb) WHERE id=$2", [JSON.stringify(concurrency), published.id]), /test_execution_infrastructure_concurrency_ck/u)
    }
    assert.deepEqual(await otherConfigurationStore.getTestExecutionInfrastructureConfigurationDraft(), retainedDraft)
    assert.deepEqual(await otherConfigurationStore.getActiveTestExecutionInfrastructureConfiguration(), published)
  } finally {
    await database.query("DELETE FROM smarthub.test_execution_infrastructure_configuration_drafts WHERE id='default'")
    await database.query('DELETE FROM smarthub.test_execution_infrastructure_configuration_versions WHERE id=ANY($1::text[])', [createdIds])
    await Promise.all([configurationStore.close(), otherConfigurationStore.close()])
  }
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
  assert.equal(await firstStore.yieldJob(claimed.id, lease(claimed)), false)

  const reclaimed = required(await secondStore.claimJob('execution-worker-lease-clock-reclaim', 60_000), '过期任务应被重新领取')
  assert.equal(reclaimed.id, aggregate.jobs[0].id)
  assert.equal(reclaimed.attempts, 2)
  assert.equal(await secondStore.releaseJob(reclaimed.id, lease(reclaimed), 0, 'lease clock test complete'), true)
})

test('PostgreSQL 拒绝终态 run 与任务聚合矛盾', async () => {
  const aggregate = executionAggregateVariant('run-task-status', 2)
  const forgedRun: ExecutionRun = {
    ...aggregate.run,
    id: `${aggregate.run.id}-forged`,
    idempotencyKey: `${aggregate.run.idempotencyKey}-forged`,
    runner: {
      ...aggregate.run.runner,
      imageDigest: `sha256:${'9'.repeat(64)}`,
    },
  }
  await assert.rejects(
    database.query(`
      INSERT INTO smarthub.test_execution_runs (
        id,project_id,project_version_id,handoff_id,handoff_sha256,
        test_case_library_version_id,test_case_library_version_sha256,
        suite_version_id,suite_version_sha256,execution_mode,
        member_snapshot_sha256,environment_id,environment_signature,
        snapshot_sha256,aggregate_sha256,create_request_sha256,create_request_canonical,status,state_version,
        idempotency_key,task_count,created_by,created_at,started_at,
        finished_at,cancel_requested_at,error,snapshot,snapshot_canonical
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,NULL,NULL,$8,$9,$10,$11,
        $12,$13,$14,$15,'queued',0,$16,$17,$18,$19,NULL,NULL,NULL,NULL,
        $20::jsonb,$21
      )
    `, [
      forgedRun.id,
      forgedRun.projectId,
      forgedRun.projectVersionId,
      forgedRun.handoff.handoffId,
      forgedRun.handoff.handoffSha256,
      forgedRun.handoff.testCaseLibraryVersionId,
      forgedRun.handoff.testCaseLibraryVersionSha256,
      forgedRun.handoff.mode,
      forgedRun.handoff.memberSnapshotSha256,
      forgedRun.environment.environmentId,
      forgedRun.environment.signature,
      '0'.repeat(64),
      '1'.repeat(64),
      executionCreateRequestSha256(forgedRun),
      executionCreateRequestCanonical(forgedRun),
      forgedRun.idempotencyKey,
      forgedRun.taskCount,
      forgedRun.createdBy,
      forgedRun.createdAt,
      JSON.stringify(forgedRun),
      canonicalJson({ invalid: true }),
    ]),
    /TEST_EXECUTION_RUN_SNAPSHOT_MISMATCH/u,
  )
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
  const cancelled = await firstStore.cancelRun(
    aggregate.run.id,
    0,
    new Date().toISOString(),
  )
  assert.equal(cancelled.status, 'cancelled')
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

test('PostgreSQL 普通 reclaim 终结遗留 attempt 后使用独立基础设施重试', async () => {
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
  const ready = required(await firstStore.getTask(aggregate.tasks[0].id), '任务应存在')
  assert.equal(ready.status, 'ready')
  assert.equal(ready.sameScriptRetryCount, 0)

  const retryAttempt: ExecutionAttempt = {
    ...interrupted,
    id: `${prefix}-reclaim-running-attempt-retry`,
    ordinal: 2,
    invocationKey: `${prefix}-reclaim-running-attempt-retry-invocation`,
    kind: 'infrastructure_retry',
    status: 'running',
    startedAt: new Date().toISOString(),
  }
  await secondStore.transactionWithLease(reclaimed.id, lease(reclaimed), async transaction => {
    await transaction.appendAttempt(retryAttempt)
    await transaction.transitionTask({
      taskId: aggregate.tasks[0].id,
      expectedStatus: 'ready',
      expectedStateVersion: ready.stateVersion,
      status: 'running',
      incrementRunnerAttempt: true,
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
  const runningDiagnosis: FailureDiagnosis = {
    id: `${prefix}-running-attempt-diagnosis`,
    runId: aggregate.run.id,
    taskId: aggregate.tasks[0].id,
    scriptRevisionId: attempt.scriptRevisionId,
    attemptIds: [attempt.id],
    category: 'unknown',
    confidence: 0.5,
    summary: '不得诊断仍在运行的 attempt',
    evidence: [{ attemptId: attempt.id, observation: '执行尚未完成' }],
    repairable: false,
    recommendedAction: '等待执行完成',
    source: 'deterministic',
    createdAt: new Date().toISOString(),
  }
  await assert.rejects(
    firstStore.transactionWithLease(claimed.id, lease(claimed), transaction =>
      transaction.appendDiagnosis(runningDiagnosis),
    ),
    /TEST_EXECUTION_DIAGNOSIS_ATTEMPT_SCOPE_MISMATCH/u,
  )
  const diagnosisConstraintClient = await database.connect()
  try {
    await diagnosisConstraintClient.query('BEGIN')
    await diagnosisConstraintClient.query(`
      INSERT INTO smarthub.test_execution_diagnoses (
        id,run_id,task_id,script_revision_id,attempt_count,evidence_count,
        category,confidence,summary,repairable,recommended_action,
        source,agent_snapshot,created_at
      ) VALUES ($1,$2,$3,$4,1,1,'unknown',0.5,$5,false,$6,'deterministic',NULL,$7)
    `, [
      runningDiagnosis.id,
      runningDiagnosis.runId,
      runningDiagnosis.taskId,
      runningDiagnosis.scriptRevisionId,
      runningDiagnosis.summary,
      runningDiagnosis.recommendedAction,
      runningDiagnosis.createdAt,
    ])
    await diagnosisConstraintClient.query(`
      INSERT INTO smarthub.test_execution_diagnosis_attempts (
        diagnosis_id,run_id,task_id,script_revision_id,attempt_id,ordinal
      ) VALUES ($1,$2,$3,$4,$5,0)
    `, [
      runningDiagnosis.id,
      runningDiagnosis.runId,
      runningDiagnosis.taskId,
      runningDiagnosis.scriptRevisionId,
      attempt.id,
    ])
    await diagnosisConstraintClient.query(`
      INSERT INTO smarthub.test_execution_diagnosis_evidence (
        diagnosis_id,run_id,task_id,script_revision_id,ordinal,
        attempt_id,artifact_id,observation
      ) VALUES ($1,$2,$3,$4,0,$5,NULL,$6)
    `, [
      runningDiagnosis.id,
      runningDiagnosis.runId,
      runningDiagnosis.taskId,
      runningDiagnosis.scriptRevisionId,
      attempt.id,
      runningDiagnosis.evidence[0].observation,
    ])
    await assert.rejects(
      diagnosisConstraintClient.query(
        'SET CONSTRAINTS smarthub.test_execution_diagnosis_attempts_terminal_ck IMMEDIATE',
      ),
      /TEST_EXECUTION_DIAGNOSIS_ATTEMPT_NOT_TERMINAL/u,
    )
  } finally {
    await diagnosisConstraintClient.query('ROLLBACK')
    diagnosisConstraintClient.release()
  }
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

test('PostgreSQL deferred aggregate Trigger 按表读取 run、task、job RECORD', async () => {
  const aggregate = executionAggregateVariant('cross-table-trigger-record-access', 2)

  const created = await firstStore.createAggregate(aggregate)

  assert.equal(created.id, aggregate.run.id)
  const persisted = await database.query<{
    runs: string
    tasks: string
    jobs: string
  }>(`
    SELECT
      (SELECT count(*) FROM smarthub.test_execution_runs WHERE id=$1) AS runs,
      (SELECT count(*) FROM smarthub.test_execution_tasks WHERE run_id=$1) AS tasks,
      (SELECT count(*) FROM smarthub.test_execution_jobs WHERE run_id=$1) AS jobs
  `, [aggregate.run.id])
  assert.deepEqual(persisted.rows[0], { runs: '1', tasks: '1', jobs: '1' })
})

async function appendScriptAndAttempt(claimed: ExecutionJob) {
  const sourceArtifact: ExecutionArtifact = {
    id: `${prefix}-source-artifact`, runId: ids.run, taskId: ids.task, type: 'script', storagePath: `objects/33/${'3'.repeat(64)}`, sha256: '3'.repeat(64), size: 100, mimeType: 'text/typescript', createdAt: now,
  }
  const scriptArtifactBase = {
    caseId: ids.libraryCase, caseRevision: 1, method: 'ui' as const, caseContentSha256, executionSpecSha256: frozenInput.executionSpecSha256, environmentSignature: run.environment.signature, executionImplementationAgentVersion: 1, executionImplementationAgentConfigurationSha256: 'a'.repeat(64),
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
    id: `${prefix}-script-revision`, runId: ids.run, taskId: ids.task, scriptArtifactId: scriptArtifact.id, revision: 1, source: 'agent', generatedBy: run.agents.executionImplementation, package: manifest, sourceArtifacts: [{ path: manifest.entrypoint, artifactId: sourceArtifact.id }], sourceArtifactId: sourceArtifact.id, contentSha256: '3'.repeat(64), protectedAssertionSha256: manifest.protectedAssertionSha256, createdAt: now,
  }
  const attempt: ExecutionAttempt = {
    id: `${prefix}-attempt`, runId: ids.run, taskId: ids.task, ordinal: 1, invocationKey: `${prefix}-invocation`, kind: 'initial', scriptRevisionId: revision.id, packageSha256: manifest.packageSha256, status: 'running', startedAt: now,
  }
  const screenshotArtifact: ExecutionArtifact = {
    id: `${prefix}-attempt-screenshot`,
    runId: ids.run,
    taskId: ids.task,
    attemptId: attempt.id,
    type: 'screenshot',
    storagePath: `objects/44/${'4'.repeat(64)}`,
    sha256: '4'.repeat(64),
    size: 200,
    mimeType: 'image/png',
    createdAt: now,
  }
  const executionEvent: ExecutionEvent = {
    id: `${prefix}-attempt-event`,
    runId: ids.run,
    taskId: ids.task,
    attemptId: attempt.id,
    sequence: 1,
    type: 'failure',
    title: '状态断言失败',
    status: 'failed',
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    artifactIds: [screenshotArtifact.id],
    metadata: { source: 'playwright_json_reporter' },
  }
  const activeLease = lease(claimed)
  const ready = required(
    await secondStore.transactionWithLease(claimed.id, activeLease, async transaction => {
      await transaction.appendArtifact(sourceArtifact)
      await transaction.appendArtifact({
        ...sourceArtifact,
        createdAt: new Date(Date.parse(sourceArtifact.createdAt) + 50).toISOString(),
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
  await assert.rejects(
    secondStore.transactionWithLease(claimed.id, activeLease, transaction =>
      transaction.appendAttempt({
        ...attempt,
        summary: 'running attempt 不得携带终结字段',
      }),
    ),
    /TEST_EXECUTION_ATTEMPT_MUST_START_RUNNING/u,
  )
  await secondStore.transactionWithLease(claimed.id, activeLease, async transaction => {
    await transaction.appendAttempt(attempt)
    await transaction.appendAttempt({
      ...attempt,
      startedAt: attempt.startedAt.replace(/Z$/u, '+00:00'),
    })
    await transaction.appendArtifact(screenshotArtifact)
    await transaction.appendExecutionEvents([executionEvent])
    await transaction.appendExecutionEvents([{
      ...executionEvent,
      startedAt: executionEvent.startedAt.replace(/Z$/u, '+00:00'),
      finishedAt: executionEvent.finishedAt?.replace(/Z$/u, '+00:00'),
    }])
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
  const changedAssertions = [{
    verificationCheckKey: 'ready',
    verificationCheckSha256: 'a'.repeat(64),
    anchor: 'ready',
    matcher: 'toBeVisible',
    modifiers: [],
    expectedSemanticsSha256: 'b'.repeat(64),
  }]
  const { packageSha256: _assertionPackageSha256, ...changedAssertionManifestBase } = {
    ...alternateManifest,
    assertions: changedAssertions,
    protectedAssertionSha256: canonicalSha256(changedAssertions),
  }
  const changedAssertionManifest: ExecutionPackageManifest = {
    ...changedAssertionManifestBase,
    packageSha256: canonicalSha256(changedAssertionManifestBase),
  }
  const alternateRevision: ScriptRevision = {
    ...revision,
    id: `${prefix}-alternate-script-revision`,
    revision: 2,
    parentRevisionId: revision.id,
    source: 'repair',
    repairReason: '验证诊断 revision 归属',
    generatedBy: run.agents.executionImplementation,
    package: alternateManifest,
    sourceArtifacts: [{ path: alternateManifest.entrypoint, artifactId: alternateSourceArtifact.id }],
    sourceArtifactId: alternateSourceArtifact.id,
    contentSha256: alternateSourceArtifact.sha256,
  }
  const changedAssertionRevision: ScriptRevision = {
    ...alternateRevision,
    id: `${prefix}-changed-assertion-revision`,
    package: changedAssertionManifest,
    protectedAssertionSha256: changedAssertionManifest.protectedAssertionSha256,
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
  await assert.rejects(
    secondStore.transactionWithLease(claimed.id, activeLease, async transaction => {
      await transaction.appendArtifact(alternateSourceArtifact)
      await transaction.appendScriptRevision(changedAssertionRevision)
    }),
    /TEST_EXECUTION_SCRIPT_REVISION_ASSERTIONS_CHANGED/u,
  )
  const assertionConstraintClient = await database.connect()
  try {
    await assertionConstraintClient.query('BEGIN')
    await assertionConstraintClient.query(`
      INSERT INTO smarthub.test_execution_artifacts (
        id,run_id,task_id,attempt_id,artifact_type,storage_path,
        sha256,byte_size,mime_type,created_at
      ) VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9)
    `, [
      alternateSourceArtifact.id,
      alternateSourceArtifact.runId,
      alternateSourceArtifact.taskId,
      alternateSourceArtifact.type,
      alternateSourceArtifact.storagePath,
      alternateSourceArtifact.sha256,
      alternateSourceArtifact.size,
      alternateSourceArtifact.mimeType,
      alternateSourceArtifact.createdAt,
    ])
    await assert.rejects(
      assertionConstraintClient.query(`
        INSERT INTO smarthub.test_execution_script_revisions (
          id,run_id,task_id,script_artifact_id,revision,parent_revision_id,
          generation_source,repair_reason,generated_by,package_manifest,
          package_canonical,package_sha256,source_artifacts,source_artifact_id,content_sha256,
          protected_assertion_sha256,protected_assertions_canonical,created_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13::jsonb,$14,$15,$16,$17,$18
        )
      `, [
        changedAssertionRevision.id,
        changedAssertionRevision.runId,
        changedAssertionRevision.taskId,
        changedAssertionRevision.scriptArtifactId,
        changedAssertionRevision.revision,
        changedAssertionRevision.parentRevisionId,
        changedAssertionRevision.source,
        changedAssertionRevision.repairReason,
        JSON.stringify(changedAssertionRevision.generatedBy),
        JSON.stringify(changedAssertionRevision.package),
        canonicalJson(changedAssertionManifestBase),
        changedAssertionRevision.package.packageSha256,
        JSON.stringify(changedAssertionRevision.sourceArtifacts),
        changedAssertionRevision.sourceArtifactId,
        changedAssertionRevision.contentSha256,
        changedAssertionRevision.protectedAssertionSha256,
        canonicalJson(changedAssertionRevision.package.assertions),
        changedAssertionRevision.createdAt,
      ]),
      /TEST_EXECUTION_SCRIPT_REVISION_ASSERTIONS_CHANGED/u,
    )
  } finally {
    await assertionConstraintClient.query('ROLLBACK')
    assertionConstraintClient.release()
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
          package_canonical,package_sha256,source_artifacts,source_artifact_id,content_sha256,
          protected_assertion_sha256,protected_assertions_canonical,created_at
        ) VALUES (
          $1,$2,$3,$4,3,$5,'repair',$6,$7::jsonb,$8::jsonb,
          $9,$10,$11::jsonb,$12,$13,$14,$15,$16
        )
      `, [
        `${prefix}-forged-script-revision`,
        ids.run,
        ids.task,
        scriptArtifact.id,
        alternateRevision.id,
        '验证数据库拒绝伪造 package hash',
        JSON.stringify(run.agents.executionImplementation),
        JSON.stringify(forgedManifest),
        canonicalJson(forgedManifestBase),
        forgedPackageSha256,
        JSON.stringify([{ path: forgedManifest.entrypoint, artifactId: forgedSourceArtifact.id }]),
        forgedSourceArtifact.id,
        forgedSourceArtifact.sha256,
        forgedManifest.protectedAssertionSha256,
        canonicalJson(forgedManifest.assertions),
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
    executionImplementationAgentVersion: 1,
    executionImplementationAgentConfigurationSha256: 'a'.repeat(64),
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
    generatedBy: run.agents.executionImplementation,
    package: manifest,
    sourceArtifacts: [{ path: manifest.entrypoint, artifactId: sourceArtifact.id }],
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
  const libraryCaseRevision = {
    revision: 1,
    content: caseContent,
    contentSha256: caseContentSha256,
    semanticSha256: caseContentSha256,
    changeReason: 'integration test',
    createdBy: 'integration-test',
    createdAt: now,
  }
  await database.query('INSERT INTO smarthub.projects (id,name,created_at,data) VALUES ($1,$2,$3,$4::jsonb)', [ids.project, `${prefix} project`, now, JSON.stringify({ id: ids.project, name: `${prefix} project`, createdAt: now })])
  await database.query('INSERT INTO smarthub.project_versions (id,project_id,name,status,created_at,updated_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)', [ids.projectVersion, ids.project, `${prefix} version`, 'open', now, now, JSON.stringify({ id: ids.projectVersion, projectId: ids.project, name: `${prefix} version`, status: 'open', createdAt: now, updatedAt: now })])
  await database.query('INSERT INTO smarthub.library_test_cases (id,project_id,current_revision,status,created_at,updated_at,data) VALUES ($1,$2,1,$3,$4,$4,$5::jsonb)', [ids.libraryCase, ids.project, 'active', now, JSON.stringify({ id: ids.libraryCase, projectId: ids.project, currentRevision: 1, status: 'active', createdAt: now, updatedAt: now, revisions: [libraryCaseRevision] })])
  await database.query('INSERT INTO smarthub.library_test_case_revisions (case_id,revision,content_sha256,semantic_sha256,created_by,created_at,content,data) VALUES ($1,1,$2,$2,$3,$4,$5::jsonb,$6::jsonb)', [ids.libraryCase, caseContentSha256, 'integration-test', now, JSON.stringify(caseContent), JSON.stringify(libraryCaseRevision)])
  await database.query('INSERT INTO smarthub.test_case_library_versions (id,project_id,project_version_id,version,name,source_run_id,content_sha256,published_by,published_at,data) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9::jsonb)', [ids.libraryVersion, ids.project, ids.projectVersion, 'Execution library', librarySourceRunId, run.handoff.testCaseLibraryVersionSha256, 'integration-test', now, JSON.stringify({ id: ids.libraryVersion, projectId: ids.project, projectVersionId: ids.projectVersion, version: 1, name: 'Execution library', sourceRunId: librarySourceRunId, members: [libraryMember], contentSha256: run.handoff.testCaseLibraryVersionSha256, publishedBy: 'integration-test', publishedAt: now, projection: { status: 'succeeded', files: [] } })])
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
