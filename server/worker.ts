import { hostname } from 'node:os'
import { service, stateStore, usingPostgres } from './runtime.js'
import type { TaskLease } from './infrastructure/store.js'

const workerId = process.env.SMARTHUB_WORKER_ID ?? `${hostname()}-${process.pid}`
const leaseMs = positiveIntegerEnv('SMARTHUB_TASK_LEASE_MS', 60_000)
const pollMs = positiveIntegerEnv('SMARTHUB_TASK_POLL_MS', 1_000)
const concurrency = positiveIntegerEnv('SMARTHUB_WORKER_CONCURRENCY', 1)
let stopping = false
const activeControllers = new Set<AbortController>()

async function processOne() {
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
  if (!usingPostgres || !stateStore.claimTask) throw new Error('独立 Worker 仅支持配置 DATABASE_URL 的 PostgreSQL 模式')
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
    await stateStore.close?.()
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
