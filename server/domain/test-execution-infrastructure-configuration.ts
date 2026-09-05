/** Shared scheduling policy. Historical releases are read with defaults, never rewritten. */
export const DEFAULT_RUNNER_CONCURRENCY = 3
export const DEFAULT_AGENT_CONCURRENCY = 1
export const RUNNER_CONCURRENCY_RANGE = { min: 1, max: 16 } as const
export const AGENT_CONCURRENCY_RANGE = { min: 1, max: 8 } as const

export interface ExecutionConcurrencyConfiguration {
  runnerConcurrency: number
  agentConcurrency: number
}

export function normalizeExecutionConcurrency(
  value?: ExecutionConcurrencyConfiguration,
): ExecutionConcurrencyConfiguration {
  if (value === undefined)
    return { runnerConcurrency: DEFAULT_RUNNER_CONCURRENCY, agentConcurrency: DEFAULT_AGENT_CONCURRENCY }
  if (
    !value ||
    typeof value !== 'object' ||
    !Number.isInteger(value.runnerConcurrency) ||
    value.runnerConcurrency < RUNNER_CONCURRENCY_RANGE.min ||
    value.runnerConcurrency > RUNNER_CONCURRENCY_RANGE.max ||
    !Number.isInteger(value.agentConcurrency) ||
    value.agentConcurrency < AGENT_CONCURRENCY_RANGE.min ||
    value.agentConcurrency > AGENT_CONCURRENCY_RANGE.max
  ) {
    throw new Error('TEST_EXECUTION_CONCURRENCY_CONFIGURATION_INVALID')
  }
  return { runnerConcurrency: value.runnerConcurrency, agentConcurrency: value.agentConcurrency }
}

export interface ResolvedExecutionConcurrency extends ExecutionConcurrencyConfiguration {
  source: 'code_defaults' | 'published_configuration' | 'historical_defaults' | 'legacy_environment'
  version: number | null
  publishedAt: string | null
  publishedBy: string | null
}
