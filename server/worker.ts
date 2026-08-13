import { hostname } from 'node:os'
import {
  requirementAnalysisService,
  service,
  stateStore,
  testDesignService,
  testExecutionService,
  testExecutionStore,
  usingPostgres,
} from './runtime.js'
import type { TaskLease } from './infrastructure/store.js'
import type {
  ExecutionJobLease,
  TestExecutionStore,
} from './infrastructure/test-execution-store.js'
import type { ExecutionJob } from './domain/test-execution-types.js'
import type { TestExecutionService } from './application/test-execution-service.js'

const workerId = process.env.SMARTHUB_WORKER_ID ?? `${hostname()}-${process.pid}`
const leaseMs = positiveIntegerEnv('SMARTHUB_TASK_LEASE_MS', 60_000)
const pollMs = positiveIntegerEnv('SMARTHUB_TASK_POLL_MS', 1_000)
const concurrency = positiveIntegerEnv('SMARTHUB_WORKER_CONCURRENCY', 1)
let stopping = false
const activeControllers = new Set<AbortController>()
let nextQueueIndex = 0

async function processOne() {
  const queues = [
    processTestExecutionOne,
    processTestDesignOne,
    processReviewOne,
    processKnowledgeOne,
  ]
  const start = nextQueueIndex++ % queues.length
  for (let offset = 0; offset < queues.length; offset += 1) {
    if (await queues[(start + offset) % queues.length]()) return true
  }
  return false
}

async function processTestExecutionOne() {
  const executionStore = testExecutionStore
  const executionService = testExecutionService
  if (!executionStore || !executionService) return false
  let job
  try {
    job = await executionStore.claimJob(workerId, leaseMs)
  } catch (error) {
    console.error(
      '测试执行任务领取失败：',
      error instanceof Error ? error.message : error,
    )
    return false
  }
  if (!job) return false
  if (!job.runToken || job.fencingToken < 1) {
    throw new Error('TEST_EXECUTION_JOB_LEASE_INVALID')
  }
  await processClaimedTestExecutionJob({
    job,
    store: executionStore,
    service: executionService,
    workerId,
    leaseMs,
    activeControllers,
  })
  return true
}

export async function processClaimedTestExecutionJob(input: {
  job: ExecutionJob
  store: TestExecutionStore
  service: Pick<TestExecutionService, 'processPreparedTask'>
  workerId: string
  leaseMs: number
  activeControllers?: Set<AbortController>
  scheduleHeartbeat?: (
    heartbeat: () => Promise<void>,
    intervalMs: number,
  ) => { clear(): void }
}) {
  if (!input.job.runToken || input.job.fencingToken < 1) {
    throw new Error('TEST_EXECUTION_JOB_LEASE_INVALID')
  }
  const lease: ExecutionJobLease = {
    workerId: input.workerId,
    runToken: input.job.runToken,
    fencingToken: input.job.fencingToken,
  }
  const controller = new AbortController()
  input.activeControllers?.add(controller)
  const heartbeat = async () => {
    try {
      const renewed = await input.store.heartbeatJob(
        input.job.id,
        lease,
        input.leaseMs,
      )
      if (!renewed) {
        controller.abort(
          new Error('测试执行 Worker 租约已失效或运行已取消'),
        )
      }
    } catch (error) {
      const cause = error instanceof Error
        ? error
        : new Error(String(error))
      console.error(`测试执行任务 ${input.job.id} 心跳失败：`, cause.message)
      controller.abort(cause)
    }
  }
  const intervalMs = Math.max(1_000, Math.floor(input.leaseMs / 3))
  const scheduled = input.scheduleHeartbeat
    ? input.scheduleHeartbeat(heartbeat, intervalMs)
    : defaultHeartbeatScheduler(heartbeat, intervalMs)
  try {
    await input.service.processPreparedTask(
      input.job,
      lease,
      controller.signal,
    )
    const task = await input.store.getTask(input.job.taskId)
    if (!task) throw new Error('TEST_EXECUTION_TASK_NOT_FOUND')
    const jobStatus = task.status === 'passed'
      ? 'succeeded'
      : task.status === 'cancelled'
        ? 'cancelled'
        : 'failed'
    const finished = await input.store.finishJob(
      input.job.id,
      lease,
      jobStatus,
      task.error,
    )
    if (!finished) {
      throw new Error('TEST_EXECUTION_JOB_FINALIZATION_REJECTED')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (controller.signal.aborted) {
      await input.store.finishJob(
        input.job.id,
        lease,
        'cancelled',
        message,
      )
    } else {
      const delay = Math.min(
        60_000,
        1_000 * 2 ** Math.max(0, input.job.attempts - 1),
      )
      const released = await input.store.releaseJob(
        input.job.id,
        lease,
        delay,
        message,
      )
      if (!released) {
        console.error(`测试执行任务 ${input.job.id} 无法释放或收口：${message}`)
      }
    }
  } finally {
    scheduled.clear()
    input.activeControllers?.delete(controller)
  }
}

function defaultHeartbeatScheduler(
  heartbeat: () => Promise<void>,
  intervalMs: number,
) {
  const timer = setInterval(() => { void heartbeat() }, intervalMs)
  return { clear: () => clearInterval(timer) }
}

async function processKnowledgeOne() {
  let task
  try {
    task = await stateStore.claimTask?.(workerId, leaseMs)
  } catch (error) {
    console.error('知识库任务领取失败：', error instanceof Error ? error.message : error)
    return false
  }
  if (!task) return false
  const lease: TaskLease = { workerId, runToken: task.runToken! }
  const controller = new AbortController()
  activeControllers.add(controller)
  const heartbeat = setInterval(() => {
    void stateStore.heartbeatTask?.(task.id, lease, leaseMs)
      .then(renewed => { if (!renewed) controller.abort(new Error('任务租约已失效')) })
      .catch(error => console.error(`知识库任务 ${task.id} 心跳失败：`, error instanceof Error ? error.message : error))
  }, Math.max(1_000, Math.floor(leaseMs / 3)))
  try {
    const completed = await service.processTask(task.id, lease, controller.signal)
    if (completed?.status === 'failed' && !controller.signal.aborted) await retryFailedTask(task, lease, completed.error)
  } catch (error) {
    if (!controller.signal.aborted) await retryFailedTask(task, lease, error instanceof Error ? error.message : String(error))
  } finally {
    clearInterval(heartbeat)
    activeControllers.delete(controller)
  }
  return true
}

async function processTestDesignOne() {
  let job
  try { job = await stateStore.claimTestDesignJob?.(workerId, leaseMs) }
  catch (error) { console.error('测试设计任务领取失败：', error instanceof Error ? error.message : error); return false }
  if (!job) return false
  const lease: TaskLease = { workerId, runToken: job.runToken! }; const controller = new AbortController(); activeControllers.add(controller)
  const heartbeat = setInterval(() => { void stateStore.heartbeatTestDesignJob?.(job.nodeRunId, lease, leaseMs).then(renewed => { if (!renewed) controller.abort(new Error('测试设计 Worker 租约已失效或运行已取消')) }).catch(error => console.error(`测试设计节点任务 ${job.nodeRunId} 心跳失败：`, error instanceof Error ? error.message : error)) }, Math.max(1_000, Math.floor(leaseMs / 3)))
  try { await testDesignService.processPreparedNode(job.runId, job.nodeRunId, lease, controller.signal); await stateStore.finishTestDesignJob?.(job.nodeRunId, lease, 'succeeded') }
  catch (error) { const message = error instanceof Error ? error.message : String(error); if (controller.signal.aborted) await stateStore.finishTestDesignJob?.(job.nodeRunId, lease, 'cancelled', message); else if (job.attempts < job.maxAttempts && /^(MODEL_|TEST_DESIGN_RUN_FAILED|MODEL_PROVIDER)/u.test(message)) await stateStore.releaseTestDesignJob?.(job.nodeRunId, lease, Math.min(60_000, 1_000 * 2 ** Math.max(0, job.attempts - 1)), message); else await stateStore.finishTestDesignJob?.(job.nodeRunId, lease, 'failed', message) }
  finally { clearInterval(heartbeat); activeControllers.delete(controller) }
  return true
}


async function processReviewOne() {
  let job
  try {
    job = await stateStore.claimReviewJob?.(workerId, leaseMs)
  } catch (error) {
    console.error('需求评审任务领取失败：', error instanceof Error ? error.message : error)
    return false
  }
  if (!job) return false
  const lease: TaskLease = { workerId, runToken: job.runToken! }
  const controller = new AbortController()
  activeControllers.add(controller)
  const heartbeat = setInterval(() => {
    void stateStore.heartbeatReviewJob?.(job.runId, lease, leaseMs)
      .then(renewed => { if (!renewed) controller.abort(new Error('需求评审 Worker 租约已失效或运行已取消')) })
      .catch(error => console.error(`需求评审任务 ${job.runId} 心跳失败：`, error instanceof Error ? error.message : error))
  }, Math.max(1_000, Math.floor(leaseMs / 3)))
  try {
    await requirementAnalysisService.processPreparedRun(job.runId, lease, controller.signal, job.attempts, job.maxAttempts)
    await stateStore.finishReviewJob?.(job.runId, lease, 'succeeded')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (controller.signal.aborted) {
      await stateStore.finishReviewJob?.(job.runId, lease, 'cancelled', message)
    } else {
      await retryFailedReviewJob(job, lease, message)
    }
  } finally {
    clearInterval(heartbeat)
    activeControllers.delete(controller)
  }
  return true
}

async function retryFailedReviewJob(claimed: { runId: string; attempts: number; maxAttempts: number }, lease: TaskLease, error: string) {
  const retryable = claimed.attempts < claimed.maxAttempts
  const delay = Math.min(60_000, 1_000 * 2 ** Math.max(0, claimed.attempts - 1))
  const nextAttemptAt = new Date(Date.now() + delay).toISOString()
  await requirementAnalysisService.failPreparedRun(claimed.runId, lease, error, false, retryable, { attempt: claimed.attempts, maxAttempts: claimed.maxAttempts, ...(retryable ? { nextAttemptAt } : {}) }).catch(() => undefined)
  if (!retryable) {
    const finished = await stateStore.finishReviewJob?.(claimed.runId, lease, 'failed', error)
    if (!finished) console.error(`需求评审任务 ${claimed.runId} 无法标记为最终失败：${error}`)
    else console.error(`需求评审任务 ${claimed.runId} 已达到最大重试次数：${error}`)
    return
  }
  const released = await stateStore.releaseReviewJob?.(claimed.runId, lease, delay, error)
  if (!released) console.error(`需求评审任务 ${claimed.runId} 无法重新入队：${error}`)
  else console.error(`需求评审任务 ${claimed.runId} 将在 ${delay}ms 后重试：${error}`)
}

async function retryFailedTask(claimed: { id: string; attempts: number; maxAttempts?: number }, lease: TaskLease, error: string | undefined) {
  const completed = await service.task(claimed.id)
  if (completed.status !== 'failed') return
  if (completed.attempts >= (completed.maxAttempts ?? 3)) {
    console.error(`知识库任务 ${claimed.id} 已达到最大重试次数：${error ?? completed.error ?? '未知错误'}`)
    return
  }
  const delay = Math.min(60_000, 1_000 * 2 ** Math.max(0, completed.attempts - 1))
  const released = await stateStore.releaseTask?.(claimed.id, lease, delay)
  if (!released) console.error(`知识库任务 ${claimed.id} 无法重新入队：${error ?? completed.error ?? '未知错误'}`)
  else console.error(`知识库任务 ${claimed.id} 将在 ${delay}ms 后重试：${error ?? completed.error ?? '未知错误'}`)
}

async function run() {
  if (
    !usingPostgres
    || !stateStore.claimTask
    || !stateStore.claimReviewJob
    || !stateStore.claimTestDesignJob
    || !testExecutionStore
    || !testExecutionService
  ) throw new Error('独立 Worker 仅支持配置 DATABASE_URL 且完成任务队列迁移的 PostgreSQL 模式')
  await service.initialize()
  console.log(`SmartHub Worker ${workerId} 已启动，并发度 ${concurrency}`)
  try {
    while (!stopping) {
      const results = await Promise.allSettled(Array.from({ length: concurrency }, () => processOne()))
      const claimed = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
      results.filter(result => result.status === 'rejected').forEach(result => console.error('知识库任务处理失败：', result.reason instanceof Error ? result.reason.message : result.reason))
      if (!claimed.some(Boolean)) {
        try {
          if (stateStore.waitForTaskNotification) await stateStore.waitForTaskNotification(pollMs)
          else await new Promise(resolve => setTimeout(resolve, pollMs))
        } catch (error) {
          console.error('知识库任务等待失败：', error instanceof Error ? error.message : error)
        }
      }
    }
  } finally {
    await Promise.all([
      stateStore.close?.(),
      testExecutionStore.close(),
    ])
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  stopping = true
  activeControllers.forEach(controller => controller.abort(new Error(`Worker 收到 ${signal}，停止任务执行`)))
})

if (process.argv[1]?.endsWith('worker.ts') || process.argv[1]?.endsWith('worker.js')) {
  run().catch(error => { console.error('SmartHub Worker 启动失败：', error instanceof Error ? error.message : error); process.exitCode = 1 })
}

function positiveIntegerEnv(name: string, fallback: number) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`)
  return value
}

export { run }
