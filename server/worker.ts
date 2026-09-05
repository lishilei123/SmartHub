import { hostname } from 'node:os'
import {
  requirementAnalysisService,
  service,
  stateStore,
  testDesignService,
  testExecutionService,
  testExecutionStore,
  testExecutionInfrastructureConfigurationService,
  usingPostgres,
} from './runtime.js'
import type { TaskLease } from './infrastructure/store.js'
import type {
  ExecutionJobLease,
  TestExecutionStore,
} from './infrastructure/test-execution-store.js'
import type { ExecutionJob, ExecutionResourceClass } from './domain/test-execution-types.js'
import { ExecutionResourceScheduler } from './application/execution-resource-scheduler.js'
import type { TestExecutionService } from './application/test-execution-service.js'

const workerId = process.env.SMARTHUB_WORKER_ID ?? `${hostname()}-${process.pid}`
const leaseMs = positiveIntegerEnv('SMARTHUB_TASK_LEASE_MS', 60_000)
const pollMs = positiveIntegerEnv('SMARTHUB_TASK_POLL_MS', 1_000)
const runtimeCleanupIntervalMs = 60_000
const workflowConcurrency = positiveIntegerEnv(
  'SMARTHUB_WORKFLOW_CONCURRENCY',
  positiveIntegerEnv('SMARTHUB_WORKER_CONCURRENCY', 1, 8),
  8,
)
let stopping = false
const shutdown = new AbortController()
const activeControllers = new Set<AbortController>()
let nextQueueIndex = 0

async function processWorkflowOne() {
  const queues = [
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

async function processTestExecutionOne(resourceClass: ExecutionResourceClass, preparationOnly = false) {
  const executionStore = testExecutionStore
  const executionService = testExecutionService
  if (!executionStore || !executionService) return false
  let job
  try {
    job = await executionStore.claimJob(workerId, leaseMs, resourceClass, preparationOnly)
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
    resourceClass,
    preparationOnly,
    shutdownSignal: shutdown.signal,
  })
  return true
}

export async function processClaimedTestExecutionJob(input: {
  job: ExecutionJob
  store: TestExecutionStore
  service: Pick<TestExecutionService, 'processPreparedTask'>
    & Partial<Pick<TestExecutionService, 'cleanupRunRuntimeState'>>
  workerId: string
  leaseMs: number
  resourceClass?: ExecutionResourceClass
  preparationOnly?: boolean
  shutdownSignal?: AbortSignal
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
  const abortForShutdown = () => controller.abort(input.shutdownSignal?.reason ?? new Error('TEST_EXECUTION_WORKER_SHUTDOWN'))
  input.shutdownSignal?.addEventListener('abort', abortForShutdown, { once: true })
  if (input.shutdownSignal?.aborted) abortForShutdown()
  input.activeControllers?.add(controller)
  const scheduled = startLeaseHeartbeat({
    renew: () => input.store.heartbeatJob(input.job.id, lease, input.leaseMs),
    controller,
    leaseMs: input.leaseMs,
    label: `测试执行任务 ${input.job.id}`,
    leaseLostMessage: '测试执行 Worker 租约已失效或运行已取消',
    schedule: input.scheduleHeartbeat,
  })
  try {
    const processed = await input.service.processPreparedTask(
      input.job,
      lease,
      controller.signal,
      input.resourceClass,
      input.preparationOnly,
    )
    if (input.resourceClass && processed && !['passed', 'failed', 'blocked', 'unsupported', 'waiting_manual', 'cancelled'].includes(processed.status)) {
      // Service already returned the lease at the durable phase boundary.
      return
    }
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
    await bestEffortRunCleanup(input.service, input.job.runId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (controller.signal.aborted) {
      const finished = await input.store.finishJob(
        input.job.id,
        lease,
        'cancelled',
        message,
      )
      if (finished) await bestEffortRunCleanup(input.service, input.job.runId)
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
    input.shutdownSignal?.removeEventListener('abort', abortForShutdown)
    input.activeControllers?.delete(controller)
  }
}

async function bestEffortRunCleanup(
  service: Partial<Pick<TestExecutionService, 'cleanupRunRuntimeState'>>,
  runId: string,
) {
  try {
    await service.cleanupRunRuntimeState?.(runId)
  } catch (error) {
    console.error(
      `测试执行 Run ${runId} 认证状态清理失败，将由终态扫描重试：`,
      error instanceof Error ? error.message : error,
    )
  }
}

function defaultHeartbeatScheduler(
  heartbeat: () => Promise<void>,
  intervalMs: number,
) {
  const timer = setInterval(() => { void heartbeat() }, intervalMs)
  return { clear: () => clearInterval(timer) }
}

function startLeaseHeartbeat(input: {
  renew: () => Promise<boolean> | undefined
  controller: AbortController
  leaseMs: number
  label: string
  leaseLostMessage: string
  schedule?: (heartbeat: () => Promise<void>, intervalMs: number) => { clear(): void }
}) {
  let stopped = false
  let inFlight = false
  let scheduled: { clear(): void } | undefined
  const clear = () => {
    stopped = true
    scheduled?.clear()
    input.controller.signal.removeEventListener('abort', clear)
  }
  const heartbeat = async () => {
    if (stopped || inFlight || input.controller.signal.aborted) return
    inFlight = true
    try {
      const renewed = await input.renew()
      if (!stopped && !renewed) input.controller.abort(new Error(input.leaseLostMessage))
    } catch (error) {
      if (!stopped) {
        const cause = error instanceof Error ? error : new Error(String(error))
        console.error(`${input.label} 心跳失败：`, cause.message)
        // Fail closed: without a successful renewal, stop model/runner work.
        input.controller.abort(cause)
      }
    } finally {
      inFlight = false
    }
  }
  input.controller.signal.addEventListener('abort', clear, { once: true })
  if (input.controller.signal.aborted) clear()
  else {
    scheduled = (input.schedule ?? defaultHeartbeatScheduler)(
      heartbeat,
      Math.max(1_000, Math.floor(input.leaseMs / 3)),
    )
    if (stopped) scheduled.clear()
  }
  return { clear }
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
  const heartbeat = startLeaseHeartbeat({
    renew: () => stateStore.heartbeatTask?.(task.id, lease, leaseMs),
    controller, leaseMs,
    label: `知识库任务 ${task.id}`,
    leaseLostMessage: '任务租约已失效',
  })
  try {
    const completed = await service.processTask(task.id, lease, controller.signal)
    if (completed?.status === 'failed' && !controller.signal.aborted) await retryFailedTask(task, lease, completed.error)
  } catch (error) {
    if (!controller.signal.aborted) await retryFailedTask(task, lease, error instanceof Error ? error.message : String(error))
  } finally {
    heartbeat.clear()
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
  const heartbeat = startLeaseHeartbeat({
    renew: () => stateStore.heartbeatTestDesignJob?.(job.nodeRunId, lease, leaseMs),
    controller, leaseMs,
    label: `测试设计节点任务 ${job.nodeRunId}`,
    leaseLostMessage: '测试设计 Worker 租约已失效或运行已取消',
  })
  try { await testDesignService.processPreparedNode(job.runId, job.nodeRunId, lease, controller.signal); await stateStore.finishTestDesignJob?.(job.nodeRunId, lease, 'succeeded') }
  catch (error) { const message = error instanceof Error ? error.message : String(error); if (controller.signal.aborted) await stateStore.finishTestDesignJob?.(job.nodeRunId, lease, 'cancelled', message); else if (job.attempts < job.maxAttempts && /^(MODEL_|TEST_DESIGN_RUN_FAILED|MODEL_PROVIDER)/u.test(message)) await stateStore.releaseTestDesignJob?.(job.nodeRunId, lease, Math.min(60_000, 1_000 * 2 ** Math.max(0, job.attempts - 1)), message); else await stateStore.finishTestDesignJob?.(job.nodeRunId, lease, 'failed', message) }
  finally { heartbeat.clear(); activeControllers.delete(controller) }
  return true
}


async function processReviewOne() {
  let job
  try {
    job = await stateStore.claimReviewJob?.(workerId, leaseMs)
  } catch (error) {
    console.error('需求分析任务领取失败：', error instanceof Error ? error.message : error)
    return false
  }
  if (!job) return false
  const lease: TaskLease = { workerId, runToken: job.runToken! }
  const controller = new AbortController()
  activeControllers.add(controller)
  const heartbeat = startLeaseHeartbeat({
    renew: () => stateStore.heartbeatReviewJob?.(job.runId, lease, leaseMs),
    controller, leaseMs,
    label: `需求分析任务 ${job.runId}`,
    leaseLostMessage: '需求分析 Worker 租约已失效或运行已取消',
  })
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
    heartbeat.clear()
    activeControllers.delete(controller)
  }
  return true
}

async function retryFailedReviewJob(claimed: { runId: string; attempts: number; maxAttempts: number }, lease: TaskLease, error: string) {
  const retryable = claimed.attempts < claimed.maxAttempts && isRetryableReviewJobError(error)
  const delay = Math.min(60_000, 1_000 * 2 ** Math.max(0, claimed.attempts - 1))
  const nextAttemptAt = new Date(Date.now() + delay).toISOString()
  await requirementAnalysisService.failPreparedRun(claimed.runId, lease, error, false, retryable, { attempt: claimed.attempts, maxAttempts: claimed.maxAttempts, ...(retryable ? { nextAttemptAt } : {}) }).catch(() => undefined)
  if (!retryable) {
    const finished = await stateStore.finishReviewJob?.(claimed.runId, lease, 'failed', error)
    if (!finished) console.error(`需求分析任务 ${claimed.runId} 无法标记为最终失败：${error}`)
    else console.error(`需求分析任务 ${claimed.runId} 已达到最大重试次数：${error}`)
    return
  }
  const released = await stateStore.releaseReviewJob?.(claimed.runId, lease, delay, error)
  if (!released) console.error(`需求分析任务 ${claimed.runId} 无法重新入队：${error}`)
  else console.error(`需求分析任务 ${claimed.runId} 将在 ${delay}ms 后重试：${error}`)
}

function isRetryableReviewJobError(error: string) {
  return /^(?:MODEL_RATE_LIMITED|MODEL_PROVIDER_UNAVAILABLE|MODEL_REQUEST_TIMEOUT):/u.test(error)
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
  console.log(
    `SmartHub Worker ${workerId} 已启动，测试执行容量使用已发布配置，其余工作流并发度 ${workflowConcurrency}`,
  )
  try {
    await Promise.all([
      runExecutionResources(),
      // Short deterministic checks must progress even when all real Runner slots
      // are occupied. This lane never executes Playwright or invokes an Agent.
      runLane('测试执行预检', 1, () => processTestExecutionOne('runner', true)),
      runLane('工作流', workflowConcurrency, processWorkflowOne),
      runRuntimeCleanupLane(),
    ])
  } finally {
    await Promise.all([
      stateStore.close?.(),
      testExecutionStore.close(),
    ])
  }
}

async function runExecutionResources() {
  const scheduler = new ExecutionResourceScheduler(processTestExecutionOne, error => {
    console.error('测试执行调度或配置读取失败，保留最近有效容量：', error instanceof Error ? error.message : error)
  })
  let nextRefresh = 0
  let lastConfiguration: string | undefined
  try {
    while (!stopping) {
      if (Date.now() >= nextRefresh) {
        await scheduler.refresh(() => testExecutionInfrastructureConfigurationService.resolveConcurrency())
        const configuration = JSON.stringify(scheduler.configuration)
        if (configuration !== lastConfiguration) {
          console.log(`测试执行并发已生效：Runner ${scheduler.configuration.runnerConcurrency}，Agent ${scheduler.configuration.agentConcurrency}（当前 Worker）`)
          lastConfiguration = configuration
        }
        nextRefresh = Date.now() + 5_000
      }
      scheduler.tick()
      await new Promise<void>(resolve => {
        const finish = () => {
          clearTimeout(timer)
          shutdown.signal.removeEventListener('abort', finish)
          resolve()
        }
        const timer = setTimeout(finish, Math.min(pollMs, 1_000))
        shutdown.signal.addEventListener('abort', finish, { once: true })
        if (shutdown.signal.aborted) finish()
      })
    }
  } finally {
    await scheduler.stop()
  }
}

async function runRuntimeCleanupLane() {
  // One serial lane per Worker: scans neither delay claimed-job heartbeats nor
  // multiply with execution concurrency. Await the active scan before closing DBs.
  while (!stopping) {
    try {
      await testExecutionService?.cleanupTerminalRunRuntimeStates(shutdown.signal)
    } catch (error) {
      console.error('测试执行终态认证状态清理失败，将在下一轮重试：',
        error instanceof Error ? error.message : error)
    }
    if (stopping) break
    await new Promise<void>(resolve => {
      const finish = () => {
        clearTimeout(timer)
        shutdown.signal.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, runtimeCleanupIntervalMs)
      shutdown.signal.addEventListener('abort', finish, { once: true })
      if (shutdown.signal.aborted) finish()
    })
  }
}

async function runLane(
  label: string,
  slots: number,
  processWork: () => Promise<boolean>,
) {
  await Promise.all(Array.from({ length: slots }, async () => {
    while (!stopping) {
      let claimed = false
      try {
        claimed = await processWork()
      } catch (error) {
        console.error(
          `${label}任务处理失败：`,
          error instanceof Error ? error.message : error,
        )
      }
      if (!claimed && !stopping) await waitForWork(label)
    }
  }))
}

async function waitForWork(label: string) {
  try {
    if (stateStore.waitForTaskNotification) {
      await stateStore.waitForTaskNotification(pollMs)
    } else {
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
  } catch (error) {
    console.error(
      `${label}任务等待失败：`,
      error instanceof Error ? error.message : error,
    )
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  stopping = true
  shutdown.abort()
  activeControllers.forEach(controller => controller.abort(new Error(`Worker 收到 ${signal}，停止任务执行`)))
})

if (process.argv[1]?.endsWith('worker.ts') || process.argv[1]?.endsWith('worker.js')) {
  run().catch(error => { console.error('SmartHub Worker 启动失败：', error instanceof Error ? error.message : error); process.exitCode = 1 })
}

function positiveIntegerEnv(name: string, fallback: number, maximum?: number) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`)
  if (maximum !== undefined && value > maximum) {
    throw new Error(`${name} 不能大于 ${maximum}`)
  }
  return value
}

export { run }
