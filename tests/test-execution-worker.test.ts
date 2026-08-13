import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  ExecutionJob,
  ExecutionTask,
} from '../server/domain/test-execution-types.js'
import type {
  TestExecutionStore,
} from '../server/infrastructure/test-execution-store.js'
import {
  processClaimedTestExecutionJob,
} from '../server/worker.js'

const createdAt = '2026-08-13T12:00:00.000Z'

function executionJob(attempts = 1): ExecutionJob {
  return {
    id: 'job-1',
    runId: 'run-1',
    taskId: 'task-1',
    status: 'running',
    attempts,
    maxAttempts: 3,
    availableAt: createdAt,
    leaseOwner: 'worker-1',
    runToken: '00000000-0000-4000-8000-000000000001',
    fencingToken: 2,
    leaseExpiresAt: '2026-08-13T13:00:00.000Z',
    heartbeatAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  }
}

function executionTask(status: ExecutionTask['status'], error?: string) {
  return {
    id: 'task-1',
    runId: 'run-1',
    status,
    stateVersion: 1,
    runnerAttemptCount: 0,
    sameScriptRetryCount: 0,
    repairCount: 0,
    input: {},
    createdAt,
    updatedAt: createdAt,
    ...(error ? { error } : {}),
  } as ExecutionTask
}

function workerStore(input: {
  task?: ExecutionTask
  heartbeat?: () => Promise<boolean>
}) {
  const finishes: Array<{
    status: 'succeeded' | 'failed' | 'cancelled'
    error?: string
  }> = []
  const releases: Array<{ delay: number; error: string }> = []
  const store = {
    async heartbeatJob() {
      return input.heartbeat ? input.heartbeat() : true
    },
    async getTask() {
      return input.task ?? null
    },
    async finishJob(
      _jobId: string,
      _lease: unknown,
      status: 'succeeded' | 'failed' | 'cancelled',
      error?: string,
    ) {
      finishes.push({ status, ...(error ? { error } : {}) })
      return true
    },
    async releaseJob(
      _jobId: string,
      _lease: unknown,
      delay: number,
      error: string,
    ) {
      releases.push({ delay, error })
      return true
    },
  } as unknown as TestExecutionStore
  return { store, finishes, releases }
}

function heartbeatHarness(input?: { fire?: boolean }) {
  let cleared = false
  return {
    scheduleHeartbeat(
      heartbeat: () => Promise<void>,
      _intervalMs: number,
    ) {
      if (input?.fire) queueMicrotask(() => { void heartbeat() })
      return { clear: () => { cleared = true } }
    },
    cleared: () => cleared,
  }
}

test('测试执行 Worker 按 Task 业务终态完成 Job，不把 failed/waiting_manual 伪装成功', async () => {
  for (const [task, expected] of [
    [executionTask('passed'), 'succeeded'],
    [executionTask('failed', 'product defect'), 'failed'],
    [executionTask('waiting_manual'), 'failed'],
  ] as const) {
    const state = workerStore({ task })
    const heartbeat = heartbeatHarness()
    await processClaimedTestExecutionJob({
      job: executionJob(),
      store: state.store,
      service: { async processPreparedTask() { return task } },
      workerId: 'worker-1',
      leaseMs: 60_000,
      scheduleHeartbeat: heartbeat.scheduleHeartbeat,
    })
    assert.deepEqual(state.finishes, [{
      status: expected,
      ...(task.error ? { error: task.error } : {}),
    }])
    assert.deepEqual(state.releases, [])
    assert.equal(heartbeat.cleared(), true)
  }
})

test('测试执行 Worker 将基础设施异常交给 Store release 并保留 provider/job 退避计数', async () => {
  const state = workerStore({ task: executionTask('ready') })
  const heartbeat = heartbeatHarness()
  await processClaimedTestExecutionJob({
    job: executionJob(3),
    store: state.store,
    service: {
      async processPreparedTask() {
        throw new Error('MODEL_PROVIDER_TEMPORARY')
      },
    },
    workerId: 'worker-1',
    leaseMs: 60_000,
    scheduleHeartbeat: heartbeat.scheduleHeartbeat,
  })
  assert.deepEqual(state.finishes, [])
  assert.deepEqual(state.releases, [{
    delay: 4_000,
    error: 'MODEL_PROVIDER_TEMPORARY',
  }])
  assert.equal(heartbeat.cleared(), true)
})

test('测试执行 Worker 续租失败立即 Abort，且不以普通 release 延续失效租约', async () => {
  const state = workerStore({
    task: executionTask('running'),
    heartbeat: async () => false,
  })
  const heartbeat = heartbeatHarness({ fire: true })
  let observedAbort = false
  await processClaimedTestExecutionJob({
    job: executionJob(),
    store: state.store,
    service: {
      async processPreparedTask(_job, _lease, signal) {
        await new Promise<void>((_resolve, reject) => {
          const fail = () => {
            observedAbort = true
            reject(signal.reason)
          }
          if (signal.aborted) fail()
          else signal.addEventListener('abort', fail, { once: true })
        })
        return executionTask('cancelled')
      },
    },
    workerId: 'worker-1',
    leaseMs: 60_000,
    scheduleHeartbeat: heartbeat.scheduleHeartbeat,
  })
  assert.equal(observedAbort, true)
  assert.deepEqual(state.releases, [])
  assert.equal(state.finishes.length, 1)
  assert.equal(state.finishes[0].status, 'cancelled')
  assert.match(state.finishes[0].error ?? '', /租约已失效/u)
  assert.equal(heartbeat.cleared(), true)
})

test('测试执行 Worker 拒绝缺少 runToken 或 fencingToken 的 Job', async () => {
  const state = workerStore({ task: executionTask('ready') })
  await assert.rejects(
    processClaimedTestExecutionJob({
      job: { ...executionJob(), runToken: undefined },
      store: state.store,
      service: {
        async processPreparedTask() {
          return executionTask('passed')
        },
      },
      workerId: 'worker-1',
      leaseMs: 60_000,
    }),
    /TEST_EXECUTION_JOB_LEASE_INVALID/u,
  )
})
