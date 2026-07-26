import type { ToolExecutionRequest, ToolExecutionResult } from '../domain/tool-types.js'
import { ToolRegistry } from './registry.js'

export class GovernedToolRuntime {
  private calls = 0
  private standardCalls = 0
  private reservedCalls = 0
  private readonly fingerprints = new Map<string, number>()

  constructor(
    private readonly registry: ToolRegistry,
    private readonly limits: { maxToolCalls: number; maxRepeatedToolCall: number },
    private readonly reservation: { toolIds: ReadonlySet<string>; calls: number } = { toolIds: new Set(), calls: 0 },
  ) {}

  async execute(request: ToolExecutionRequest, signal: AbortSignal): Promise<ToolExecutionResult> {
    if (!request.context.allowedToolIds.has(request.toolId)) throw new Error(`TOOL_NOT_ALLOWED: ${request.toolId}`)
    const registered = this.registry.get(request.toolId)
    if (!registered) throw new Error(`TOOL_NOT_REGISTERED: ${request.toolId}`)
    const reserved = this.reservation.toolIds.has(request.toolId)
    if (reserved) {
      this.reservedCalls += 1
      if (this.reservedCalls > this.reservation.calls) throw new Error('AGENT_RESULT_SUBMISSION_LIMIT_EXCEEDED')
    } else {
      this.standardCalls += 1
      if (this.standardCalls > this.standardCallLimit) throw new Error('AGENT_TOOL_LIMIT_EXCEEDED')
    }
    this.calls += 1
    const fingerprint = `${request.toolId}:${stableStringify(request.arguments)}`
    const repeated = (this.fingerprints.get(fingerprint) ?? 0) + 1
    this.fingerprints.set(fingerprint, repeated)
    if (repeated > this.limits.maxRepeatedToolCall) throw new Error('REPEATED_TOOL_CALL')

    const timeout = AbortSignal.timeout(registered.descriptor.timeoutMs)
    const combined = AbortSignal.any([signal, timeout])
    try { return await registered.handler(request, combined) }
    catch (error) {
      if (combined.aborted) throw new Error(signal.aborted ? 'AGENT_CANCELLED' : `TOOL_TIMEOUT: ${request.toolId}`)
      throw error
    }
  }

  get callCount() { return this.calls }
  get remainingStandardCalls() { return Math.max(0, this.standardCallLimit - this.standardCalls) }
  private get standardCallLimit() { return Math.max(0, this.limits.maxToolCalls - this.reservation.calls) }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
  return JSON.stringify(value)
}
