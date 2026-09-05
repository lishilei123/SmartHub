import type { ExecutionResourceClass } from '../domain/test-execution-types.js'
import {
  normalizeExecutionConcurrency,
  type ExecutionConcurrencyConfiguration,
} from '../domain/test-execution-infrastructure-configuration.js'

/** Reserves capacity before claiming a database lease. Capacity changes never abort work. */
export class ExecutionResourceScheduler {
  private limits = normalizeExecutionConcurrency()
  private readonly active = { runner: new Set<Promise<void>>(), agent: new Set<Promise<void>>() }
  private stopped = false

  constructor(
    private readonly processOne: (resource: ExecutionResourceClass) => Promise<boolean>,
    private readonly onError: (error: unknown) => void,
  ) {}

  get configuration() { return { ...this.limits } }
  get running() { return { runner: this.active.runner.size, agent: this.active.agent.size } }

  async refresh(read: () => Promise<ExecutionConcurrencyConfiguration>) {
    try {
      this.limits = normalizeExecutionConcurrency(await read())
      return true
    } catch (error) {
      // Publishing/connection failures do not erase the last known valid limits.
      this.onError(error)
      return false
    }
  }

  tick() {
    if (this.stopped) return
    for (const resource of ['runner', 'agent'] as const) {
      const capacity = resource === 'runner' ? this.limits.runnerConcurrency : this.limits.agentConcurrency
      while (this.active[resource].size < capacity) {
        // Defer the claim until after this promise has reserved its resource slot.
        const work = Promise.resolve().then(() => this.processOne(resource))
          .then(() => undefined, error => { this.onError(error) })
          .finally(() => { this.active[resource].delete(work) })
        this.active[resource].add(work)
      }
    }
  }

  async stop() {
    this.stopped = true
    await Promise.all([...this.active.runner, ...this.active.agent])
  }
}
