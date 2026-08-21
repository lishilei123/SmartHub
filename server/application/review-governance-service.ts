import { createHash, randomUUID } from 'node:crypto'
import type { ToolApprovalGate } from '../domain/tool-types.js'
import type { Principal } from '../domain/access-control.js'
import type { ToolApproval } from '../domain/types.js'
import type { StateStore } from '../infrastructure/store.js'

export class ReviewGovernanceService implements ToolApprovalGate {
  constructor(private readonly store: StateStore) {}

  async listApprovals(runId: string) {
    const now = Date.now()
    await this.store.transaction(state => {
      state.toolApprovals.forEach(approval => {
        if (approval.runId === runId && approval.status === 'pending' && Date.parse(approval.expiresAt) <= now) approval.status = 'expired'
      })
    })
    const state = await this.store.snapshot()
    required(state.reviewRuns.find(item => item.id === runId), '需求分析运行不存在')
    return state.toolApprovals.filter(item => item.runId === runId).sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
  }

  async decideApproval(approvalId: string, input: { decision: 'approved' | 'rejected'; principal?: Principal; comment?: string }) {
    if (!['approved', 'rejected'].includes(input.decision)) throw new Error('审批结果必须是 approved 或 rejected')
    const outcome = await this.store.transaction(state => {
      const approval = required(state.toolApprovals.find(item => item.id === approvalId), '审批记录不存在')
      const run = required(state.reviewRuns.find(item => item.id === approval.runId), '需求分析运行不存在')
      if (run.status !== 'running') {
        approval.status = 'cancelled'
        return { error: '运行已结束，审批自动失效' }
      }
      if (approval.status !== 'pending') return { error: '审批记录已处理或失效' }
      if (Date.parse(approval.expiresAt) <= Date.now()) { approval.status = 'expired'; return { error: '审批已过期' } }
      approval.status = input.decision
      approval.decidedAt = new Date().toISOString()
      approval.decidedBy = principalId(input.principal)
      approval.decidedByDisplayName = principalName(input.principal)
      const comment = String(input.comment ?? '').trim()
      if (comment) approval.decisionComment = comment.slice(0, 2_000)
      return { approval: structuredClone(approval) }
    })
    if (outcome.error) throw new Error(outcome.error)
    return outcome.approval!
  }

  async authorize(input: { runId: string; toolId: string; toolVersion: string; risk: 'write_reversible' | 'write_high_risk'; arguments: unknown; signal: AbortSignal }): Promise<void> {
    const parameterHash = hashParameters(input.arguments)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString()
    let pending!: ToolApproval
    const authorizationError = await this.store.transaction(state => {
      const run = required(state.reviewRuns.find(item => item.id === input.runId), '需求分析运行不存在')
      if (run.status !== 'running') throw new Error('TOOL_APPROVAL_INVALID: 运行已结束')
      state.toolApprovals.forEach(approval => {
        if (approval.runId === input.runId && approval.toolId === input.toolId && approval.status === 'pending' && (approval.toolVersion !== input.toolVersion || approval.parameterHash !== parameterHash || Date.parse(approval.expiresAt) <= now.getTime())) approval.status = Date.parse(approval.expiresAt) <= now.getTime() ? 'expired' : 'cancelled'
      })
      const exact = state.toolApprovals.find(approval => approval.runId === input.runId && approval.toolId === input.toolId && approval.toolVersion === input.toolVersion && approval.parameterHash === parameterHash && approval.status === 'approved' && !approval.consumedAt && Date.parse(approval.expiresAt) > now.getTime())
      if (exact) { exact.consumedAt = now.toISOString(); return undefined }
      const rejected = state.toolApprovals.find(approval => approval.runId === input.runId && approval.toolId === input.toolId && approval.toolVersion === input.toolVersion && approval.parameterHash === parameterHash && approval.status === 'rejected')
      if (rejected) return 'TOOL_APPROVAL_REJECTED: 外部操作已被人工拒绝'
      pending = state.toolApprovals.find(approval => approval.runId === input.runId && approval.toolId === input.toolId && approval.toolVersion === input.toolVersion && approval.parameterHash === parameterHash && approval.status === 'pending') ?? {
        id: `tool_approval_${randomUUID()}`,
        projectVersionId: run.projectVersionId,
        runId: input.runId,
        toolId: input.toolId,
        toolVersion: input.toolVersion,
        risk: input.risk,
        parameterSummary: summarizeParameters(redactParameters(input.arguments)),
        parameterHash,
        status: 'pending',
        requestedAt: now.toISOString(),
        expiresAt,
        requestedBy: 'agent-runtime',
      }
      if (!state.toolApprovals.some(item => item.id === pending.id)) state.toolApprovals.push(pending)
      return undefined
    })
    if (authorizationError) throw new Error(authorizationError)
    if (!pending) return
    try {
      while (true) {
      await waitForDecision(500, input.signal)
      const state = await this.store.snapshot()
      const run = state.reviewRuns.find(item => item.id === input.runId)
      const current = state.toolApprovals.find(item => item.id === pending.id)
      if (!run || run.status !== 'running') {
        await this.store.transaction(draft => { const approval = draft.toolApprovals.find(item => item.id === pending.id); if (approval?.status === 'pending') approval.status = 'cancelled' })
        throw new Error('TOOL_APPROVAL_CANCELLED: 运行已结束')
      }
      if (!current) throw new Error('TOOL_APPROVAL_INVALID: 审批记录不存在')
      if (current.parameterHash !== parameterHash) throw new Error('TOOL_APPROVAL_INVALID: 工具参数已变化')
      if (current.status === 'approved' && !current.consumedAt && Date.parse(current.expiresAt) > Date.now()) {
        const consumed = await this.store.transaction(draft => {
          const approval = draft.toolApprovals.find(item => item.id === pending.id)
          if (!approval || approval.status !== 'approved' || approval.consumedAt || approval.parameterHash !== parameterHash || approval.toolVersion !== input.toolVersion || Date.parse(approval.expiresAt) <= Date.now()) return false
          approval.consumedAt = new Date().toISOString()
          return true
        })
        if (consumed) return
      }
      if (current.status === 'approved' && current.consumedAt) return this.authorize(input)
      if (current.status === 'rejected') throw new Error('TOOL_APPROVAL_REJECTED: 外部操作已被人工拒绝')
      if (current.status === 'cancelled') throw new Error('TOOL_APPROVAL_CANCELLED: 审批已取消')
      if (current.status === 'expired' || Date.parse(current.expiresAt) <= Date.now()) {
        await this.store.transaction(draft => { const approval = draft.toolApprovals.find(item => item.id === pending.id); if (approval?.status === 'pending') approval.status = 'expired' })
        throw new Error('TOOL_APPROVAL_EXPIRED: 审批已过期')
      }
      }
    } catch (error) {
      if (input.signal.aborted) await this.store.transaction(draft => { const approval = draft.toolApprovals.find(item => item.id === pending.id); if (approval?.status === 'pending') approval.status = 'cancelled' })
      throw error
    }
  }

  async exportMarkdown(runId: string, projectVersionId: string) {
    const state = await this.store.snapshot()
    const run = required(state.reviewRuns.find(item => item.id === runId && item.projectVersionId === projectVersionId), '指定项目版本下不存在该需求分析运行')
    const release = required(run.workflow?.release, '只有正式发布的 Requirement Release 可以导出需求分析报告')
    return required(release.artifacts.find(item => item.fileName === 'requirement-analysis.md'), 'Requirement Release 缺少需求分析报告').content
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
  return JSON.stringify(value)
}
function redactParameters(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactParameters)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, /api.?key|token|password|secret|authorization|credential/iu.test(key) ? '***' : redactParameters(item)]))
}
function hashParameters(value: unknown) { return createHash('sha256').update(stableStringify(value)).digest('hex') }
function summarizeParameters(value: unknown) { const text = stableStringify(value); return text.length <= 500 ? text : `${text.slice(0, 497)}...` }
function principalId(principal: Principal | undefined) { return String(principal?.subjectId ?? '').trim().slice(0, 200) || 'system' }
function principalName(principal: Principal | undefined) { return String(principal?.displayName ?? '').trim().slice(0, 200) || '系统' }
function waitForDecision(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('AGENT_CANCELLED'))
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
    const abort = () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new Error('AGENT_CANCELLED')) }
    signal.addEventListener('abort', abort, { once: true })
  })
}
function required<T>(value: T | undefined, message: string): T { if (value === undefined) throw new Error(message); return value }
