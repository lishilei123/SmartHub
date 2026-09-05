import { AsyncLocalStorage } from 'node:async_hooks'
import type { ExecutionResourceClass } from '../domain/test-execution-types.js'
import { normalizeExecutionConcurrency, type ExecutionConcurrencyConfiguration } from '../domain/test-execution-infrastructure-configuration.js'

type Waiter = { signal: AbortSignal; start(): void; abort(): void }

/** Process-local resource boundary. Database job scheduling remains durable and fenced. */
export class ExecutionResourceGovernor {
  private limits = normalizeExecutionConcurrency()
  private readonly active = { agent: 0, runner: 0 }
  private readonly queues: Record<ExecutionResourceClass, Waiter[]> = { agent: [], runner: [] }
  private readonly scope = new AsyncLocalStorage<{ resource: ExecutionResourceClass; active: boolean }>()
  private readConfiguration?: () => Promise<ExecutionConcurrencyConfiguration>
  private nextRefresh = 0
  private refreshing?: Promise<void>

  constructor(private readonly maximumQueue = 128) {
    if (!Number.isSafeInteger(maximumQueue) || maximumQueue < 1) throw new Error('RESOURCE_QUEUE_LIMIT_INVALID')
  }

  get running() { return { ...this.active } }
  get waiting() { return { agent: this.queues.agent.length, runner: this.queues.runner.length } }

  setConfigurationReader(read: () => Promise<ExecutionConcurrencyConfiguration>) { this.readConfiguration = read }

  configure(value: ExecutionConcurrencyConfiguration) {
    this.limits = normalizeExecutionConcurrency(value)
    this.drain('runner')
    this.drain('agent')
  }

  async withResource<T>(resource: ExecutionResourceClass, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    const inherited = this.scope.getStore()
    // Browser exploration and its sequential model/tool loop share one reservation.
    if (inherited?.active && inherited.resource === resource) return operation()
    if (inherited?.active) throw new Error('RESOURCE_NESTED_RESERVATION_FORBIDDEN')
    await this.refresh(signal)
    await this.acquire(resource, signal)
    const reservation = { resource, active: true }
    try {
      signal.throwIfAborted()
      return await this.scope.run(reservation, operation)
    } finally {
      reservation.active = false
      this.active[resource] -= 1
      this.drain(resource)
    }
  }

  private async refresh(signal: AbortSignal) {
    if (!this.readConfiguration || Date.now() < this.nextRefresh) return
    this.refreshing ??= this.readConfiguration().then(value => this.configure(value), error => {
      console.error('资源并发配置读取失败，保留最近有效值：', error instanceof Error ? error.message : error)
    }).finally(() => { this.nextRefresh = Date.now() + 5_000; this.refreshing = undefined })
    const refreshing = this.refreshing
    await new Promise<void>((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      void refreshing.then(() => { signal.removeEventListener('abort', abort); resolve() }, error => { signal.removeEventListener('abort', abort); reject(error) })
      if (signal.aborted) abort()
    })
  }

  private capacity(resource: ExecutionResourceClass) {
    return resource === 'runner' ? this.limits.runnerConcurrency : this.limits.agentConcurrency
  }

  private acquire(resource: ExecutionResourceClass, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (!this.queues[resource].length && this.active[resource] < this.capacity(resource)) {
      this.active[resource] += 1
      return Promise.resolve()
    }
    if (this.queues[resource].length >= this.maximumQueue) return Promise.reject(new Error('RESOURCE_QUEUE_FULL'))
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        start: () => { signal.removeEventListener('abort', waiter.abort); this.active[resource] += 1; resolve() },
        abort: () => {
          const index = this.queues[resource].indexOf(waiter)
          if (index < 0) return
          this.queues[resource].splice(index, 1)
          signal.removeEventListener('abort', waiter.abort)
          reject(signal.reason)
          this.drain(resource)
        },
      }
      this.queues[resource].push(waiter)
      signal.addEventListener('abort', waiter.abort, { once: true })
      if (signal.aborted) waiter.abort()
    })
  }

  private drain(resource: ExecutionResourceClass) {
    while (this.active[resource] < this.capacity(resource) && this.queues[resource].length) {
      const waiter = this.queues[resource][0]
      if (waiter.signal.aborted) waiter.abort()
      else { this.queues[resource].shift(); waiter.start() }
    }
  }
}
