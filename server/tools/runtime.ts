import type { ToolExecutionRequest, ToolExecutionResult } from '../domain/tool-types.js'
import { ToolRegistry } from './registry.js'

export class GovernedToolRuntime {
  private calls = 0
  private standardCalls = 0
  private reservedCalls = 0
  private readonly fingerprints = new Map<string, number>()
  private readonly successfulResults = new Map<string, ToolExecutionResult>()
  private readonly replayedFingerprints = new Set<string>()

  constructor(
    private readonly registry: ToolRegistry,
    private readonly limits: { maxToolCalls: number; maxRepeatedToolCall: number },
    private readonly reservation: { toolIds: ReadonlySet<string>; calls: number } = { toolIds: new Set(), calls: 0 },
  ) {}

  async execute(request: ToolExecutionRequest, signal: AbortSignal): Promise<ToolExecutionResult> {
    if (!request.context.allowedToolIds.has(request.toolId)) throw new Error(`TOOL_NOT_ALLOWED: ${request.toolId}`)
    const registered = this.registry.get(request.toolId)
    if (!registered) throw new Error(`TOOL_NOT_REGISTERED: ${request.toolId}`)

    const fingerprint = `${request.toolId}:${stableStringify(request.arguments)}`
    const repeated = (this.fingerprints.get(fingerprint) ?? 0) + 1
    this.fingerprints.set(fingerprint, repeated)
    if (repeated > this.limits.maxRepeatedToolCall) {
      const cached = this.successfulResults.get(fingerprint)
      if (this.canReplay(registered.descriptor) && cached && !this.replayedFingerprints.has(fingerprint)) {
        this.replayedFingerprints.add(fingerprint)
        return { ...structuredClone(cached), replayed: true }
      }
      const policyError = {
        code: 'REPEATED_TOOL_CALL' as const,
        retryable: false as const,
        toolId: request.toolId,
        nextAction: '不要再次提交相同参数；请使用此前成功返回的结果，或改用不同且受允许范围约束的请求。',
      }
      return { data: { error: policyError }, policyError }
    }

    const reserved = this.reservation.toolIds.has(request.toolId)
    if (reserved) {
      if (this.reservedCalls >= this.reservation.calls) throw new Error('AGENT_RESULT_SUBMISSION_LIMIT_EXCEEDED')
      this.reservedCalls += 1
    } else {
      if (this.standardCalls >= this.standardCallLimit) throw new Error('AGENT_TOOL_LIMIT_EXCEEDED')
      this.standardCalls += 1
    }
    this.calls += 1

    const timeout = AbortSignal.timeout(registered.descriptor.timeoutMs)
    const combined = AbortSignal.any([signal, timeout])
    try {
      const result = await registered.handler(request, combined)
      if (this.canReplay(registered.descriptor)) this.successfulResults.set(fingerprint, structuredClone(result))
      return result
    } catch (error) {
      if (combined.aborted) throw new Error(signal.aborted ? 'AGENT_CANCELLED' : `TOOL_TIMEOUT: ${request.toolId}`)
      throw error
    }
  }

  get callCount() { return this.calls }
  get remainingStandardCalls() { return Math.max(0, this.standardCallLimit - this.standardCalls) }
  private get standardCallLimit() { return Math.max(0, this.limits.maxToolCalls - this.reservation.calls) }

  private canReplay(descriptor: { risk: string; idempotent: boolean; repeatPolicy?: string }) {
    return descriptor.repeatPolicy === 'replay_success_once'
      && descriptor.risk === 'read'
      && descriptor.idempotent
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
  return JSON.stringify(value)
}
