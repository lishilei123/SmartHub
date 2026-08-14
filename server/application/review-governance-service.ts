import { createHash, randomUUID } from 'node:crypto'
import type { ToolApprovalGate } from '../domain/tool-types.js'
import type { Principal } from '../domain/access-control.js'
import type { FindingAction, FindingActionType, FindingState, ReviewRun, ToolApproval } from '../domain/types.js'
import type { StateStore } from '../infrastructure/store.js'

const findingTransitions: Record<FindingActionType, FindingState> = {
  confirm: 'confirmed',
  dismiss: 'dismissed',
  resolve: 'resolved',
  request_follow_up: 'needs_follow_up',
  reopen: 'open',
}

const allowedTransitions: Record<FindingState, FindingActionType[]> = {
  open: ['confirm', 'dismiss', 'resolve', 'request_follow_up'],
  confirmed: ['dismiss', 'resolve', 'request_follow_up', 'reopen'],
  dismissed: ['reopen'],
  resolved: ['request_follow_up', 'reopen'],
  needs_follow_up: ['confirm', 'dismiss', 'resolve', 'reopen'],
}

export class ReviewGovernanceService implements ToolApprovalGate {
  constructor(private readonly store: StateStore) {}

  async listFindingActions(runId: string) {
    const state = await this.store.snapshot()
    const run = required(state.reviewRuns.find(item => item.id === runId), '需求分析运行不存在')
    return findingProjection(run, state.findingActions.filter(item => item.runId === runId))
  }

  async actOnFinding(runId: string, findingId: string, input: { action: FindingActionType; comment?: string; expectedVersion?: number; principal?: Principal }) {
    if (!(input.action in findingTransitions)) throw new Error('Finding 处置动作无效')
    const comment = String(input.comment ?? '').trim()
    if (comment.length > 2_000) throw new Error('处置说明不能超过 2000 个字符')
    if (['dismiss', 'request_follow_up', 'reopen'].includes(input.action) && !comment) throw new Error('驳回、待跟进或重新打开时必须填写处置说明')
    return this.store.transaction(state => {
      const run = required(state.reviewRuns.find(item => item.id === runId), '需求分析运行不存在')
      if (run.status !== 'succeeded' || !run.result) throw new Error('只有成功完成的需求分析结果可以处置 Finding')
      required(run.result.findings.find(item => item.clientFindingId === findingId), 'Finding 不属于指定需求分析运行')
      const actions = state.findingActions.filter(item => item.runId === runId && item.findingId === findingId).sort((left, right) => left.version - right.version)
      const version = actions.length
      if (input.expectedVersion !== undefined && input.expectedVersion !== version) throw new Error('FINDING_ACTION_VERSION_CONFLICT: 处置状态已被其他用户更新，请刷新后重试')
      const fromState = actions.at(-1)?.toState ?? 'open'
      if (!allowedTransitions[fromState].includes(input.action)) throw new Error(`Finding 当前为 ${fromState}，不能执行 ${input.action}`)
      const action: FindingAction = {
        id: `finding_action_${randomUUID()}`,
        projectVersionId: run.projectVersionId,
        runId,
        findingId,
        action: input.action,
        fromState,
        toState: findingTransitions[input.action],
        ...(comment ? { comment } : {}),
        actorId: principalId(input.principal),
        actorDisplayName: principalName(input.principal),
        version: version + 1,
        createdAt: new Date().toISOString(),
      }
      state.findingActions.push(action)
      return structuredClone(action)
    })
  }

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
    if (run.status !== 'succeeded' || !run.result) throw new Error('只有成功完成的需求分析结果可以导出')
    const projectVersion = required(state.projectVersions.find(item => item.id === projectVersionId), '项目版本不存在')
    const projection = findingProjection(run, state.findingActions.filter(item => item.runId === runId))
    const states = new Map(projection.findings.map(item => [item.findingId, item]))
    const evidence = new Map(run.result.evidence.map(item => [item.clientEvidenceId, item]))
    const points = new Map(run.result.requirementPoints.map(item => [item.clientRequirementPointId, item]))
    const lines = [
      `# ${projectVersion.name} · 需求分析报告`, '',
      `- 运行 ID：${run.id}`,
      `- 项目版本 ID：${projectVersion.id}`,
      `- 固定输入文档：${run.snapshot.assets.length} 份`,
      ...run.snapshot.assets.map(item => `  - ${item.displayName}：${item.assetVersionId}（SHA-256 ${item.assetContentHash}）`),
      `- 固定索引版本：${run.snapshot.indexVersionId}`,
      `- 实际模型路由：${run.modelLabel}`,
      `- 运行状态：${run.status}`,
      `- 生成时间：${new Date().toISOString()}`, '',
      '## 分析摘要', '',
      `- 需求概述：${safeMarkdown(run.result.summary.overview)}`,
      ...run.result.summary.businessGoals.map(item => `- 业务目标：${safeMarkdown(item)}`),
      `- 总体结论：${run.result.summary.overallAssessment}`,
      `- 综合评分：${run.result.summary.score}`,
      ...run.result.summary.risks.map(item => `- 风险：${safeMarkdown(item)}`), '',
      '## 需求点', '',
      ...run.result.requirementPoints.flatMap(point => [`### ${safeMarkdown(point.clientRequirementPointId)} · ${safeMarkdown(point.title)}`, '', safeMarkdown(point.description), '', `- Evidence：${point.evidenceRefs.join('、')}`, '']),
      '## Findings', '',
      ...run.result.findings.flatMap((finding, index) => {
        const current = states.get(finding.clientFindingId)!
        const evidenceItems = finding.requirementPointRefs.flatMap(reference => points.get(reference)?.evidenceRefs ?? []).map(reference => evidence.get(reference)).filter(Boolean)
        return [`### ${index + 1}. ${safeMarkdown(finding.title)}`, '', `- ID：${finding.clientFindingId}`, `- 类型：${finding.type}`, `- 严重度：${finding.severity}`, `- 处置状态：${current.state}`, `- 处置版本：${current.version}`, `- 关联需求点：${finding.requirementPointRefs.join('、')}`, `- 问题：${safeMarkdown(finding.description)}`, `- 影响：${safeMarkdown(finding.impact)}`, `- 建议确认：${safeMarkdown(finding.recommendation)}`, ...evidenceItems.map(item => `- Evidence：${item!.sourceRef.assetVersionId} / ${safeMarkdown(item!.locator.heading)} — ${safeMarkdown(item!.quote)}`), '']
      }),
      '## Test Focus', '',
      ...(run.result.testFocus.length ? run.result.testFocus.flatMap(item => [`### ${safeMarkdown(item.id)} · ${safeMarkdown(item.title)}`, '', safeMarkdown(item.description), '', `- 关联需求点：${item.requirementPointRefs.join('、') || '整体关注项'}`, '']) : ['本次没有单独的测试关注项。', '']),
      '## 降级与执行摘要', '',
      `- 覆盖限制：${run.result.coverage.limitations.length ? run.result.coverage.limitations.map(safeMarkdown).join('；') : '无'}`,
      ...(run.degradations?.length ? run.degradations.map(item => `- ${item.agentKey} 模型降级：${item.fromSourceId}/${item.fromModelId} → ${item.toSourceId}/${item.toModelId}；原因：${safeMarkdown(item.reason)}`) : ['- 模型降级：无']),
      ...Object.values(run.executions ?? {}).filter(Boolean).map(execution => `- ${execution!.agentKey}：${execution!.turns} Turn，${execution!.toolCalls} 次工具调用，${execution!.toolErrors ?? 0} 次工具错误`),
    ]
    return lines.join('\n')
  }
}

function findingProjection(run: ReviewRun, actions: FindingAction[]) {
  if (!run.result) return { runId: run.id, findings: [], actions: [] }
  const ordered = [...actions].sort((left, right) => left.version - right.version)
  return {
    runId: run.id,
    projectVersionId: run.projectVersionId,
    findings: run.result.findings.map(finding => {
      const history = ordered.filter(item => item.findingId === finding.clientFindingId)
      return { findingId: finding.clientFindingId, state: history.at(-1)?.toState ?? 'open' as FindingState, version: history.at(-1)?.version ?? 0, lastActionAt: history.at(-1)?.createdAt }
    }),
    actions: ordered,
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
function safeMarkdown(value: string) { return String(value).replace(/[\r\n]+/gu, ' ').replace(/([*_`])/gu, '\\$1').trim() }
function waitForDecision(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('AGENT_CANCELLED'))
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
    const abort = () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new Error('AGENT_CANCELLED')) }
    signal.addEventListener('abort', abort, { once: true })
  })
}
function required<T>(value: T | undefined, message: string): T { if (value === undefined) throw new Error(message); return value }
