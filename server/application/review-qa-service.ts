import { BuiltInAgentDefinitionResolver } from '../agent/requirement-analysis-agent.js'
import type { AgentDefinitionResolver, AgentExecutionEvent } from '../domain/agent-types.js'
import type { ReviewQaRuntime, ReviewQuestionQuote } from '../domain/review-qa-types.js'
import type { AgentConfigurationVersion, DatabaseState, GenerativeModel, GenerativeModelSource, ReviewQaTurn, ReviewRun } from '../domain/types.js'
import type { StateStore } from '../infrastructure/store.js'

export interface ReviewQuestionRequest { question: string; quote?: ReviewQuestionQuote; actorId?: string; actorDisplayName?: string }

export class ReviewQaService {
  constructor(
    private readonly store: StateStore,
    private readonly runtime: ReviewQaRuntime,
    private readonly definitions: AgentDefinitionResolver = new BuiltInAgentDefinitionResolver(),
  ) {}

  async list(runId: string) {
    const state = await this.store.snapshot()
    const run = required(state.reviewRuns.find(item => item.id === runId), '需求评审运行不存在')
    return {
      runId,
      projectVersionId: run.projectVersionId,
      session: state.reviewQaSessions.find(item => item.runId === runId) ?? null,
      turns: state.reviewQaTurns.filter(item => item.runId === runId).sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    }
  }

  async ask(runId: string, request: ReviewQuestionRequest, signal = new AbortController().signal, onEvent?: (event: AgentExecutionEvent) => void | Promise<void>) {
    const question = String(request.question ?? '').trim()
    if (!question) throw new Error('评审问题不能为空')
    if (question.length > 2_000) throw new Error('评审问题不能超过 2000 个字符')
    const state = await this.store.snapshot()
    const run = required(state.reviewRuns.find(item => item.id === runId), '需求评审运行不存在')
    if (run.status !== 'succeeded' || !run.result) throw new Error('只有成功完成的评审运行可以继续问答')
    const actorId = String(request.actorId ?? '').trim().slice(0, 200) || 'current-user'
    const actorDisplayName = String(request.actorDisplayName ?? '').trim().slice(0, 200) || '当前用户'
    const session = await this.store.transaction(draft => {
      const existing = draft.reviewQaSessions.find(item => item.runId === runId)
      if (existing) return structuredClone(existing)
      const created = { id: `review_qa_session_${crypto.randomUUID()}`, projectVersionId: run.projectVersionId, runId, createdAt: new Date().toISOString(), createdBy: actorId }
      draft.reviewQaSessions.push(created)
      return structuredClone(created)
    })
    const fixedAssetVersionIds = new Set((run.snapshot.assets ?? [{ assetVersionId: run.assetVersionId }]).map(item => item.assetVersionId))
    const versions = [...fixedAssetVersionIds].map(versionId => required(state.versions.find(item => item.id === versionId && item.status === 'ready'), '评审绑定的固定资产版本不可用'))
    const documentContent = versions.map(version => version.content).join('\n\n')
    const configuration = this.definitions.resolveActive ? await this.definitions.resolveActive('review-qa') : null
    if (this.definitions.resolveActive && !configuration) throw new Error('请先在系统管理的 Agent 配置中发布评审问答 Agent，再继续问答')
    const definition = configuration?.agentDefinition ?? await this.definitions.resolve('review-qa')
    const { source, model } = selectModel(state, run, configuration)
    const quote = normalizeQuote(request.quote, fixedAssetVersionIds, versions, run.result)
    const estimatedTokens = Math.ceil((documentContent.length + JSON.stringify(run.result).length + question.length) / 4) + 2_000
    const maxOutputTokens = Math.min(model.maxOutputTokens, configuration?.routing.maxOutputTokens ?? 4_096)
    if (estimatedTokens + maxOutputTokens > model.contextWindow) throw new Error('固定评审上下文超过模型窗口，暂时无法继续问答')
    const turnId = `review_qa_turn_${crypto.randomUUID()}`
    const createdAt = new Date().toISOString()
    try {
      const output = await this.runtime.answer({
        question,
        quote,
        snapshot: run.snapshot,
        reviewResult: run.result,
        documentContent,
        model: { sourceId: source.id, providerType: source.providerType, baseUrl: source.baseUrl, apiKey: source.apiKey, modelId: model.id, modelName: model.name, contextWindow: model.contextWindow, maxOutputTokens, supportsReasoning: model.capabilities.includes('reasoning'), temperature: configuration?.routing.temperature, requestTimeoutMs: configuration ? configuration.routing.requestTimeoutSeconds * 1_000 : undefined, retryCount: configuration?.routing.retryCount },
        agentDefinition: definition,
        onEvent,
      }, signal)
      const { candidate, execution } = output
      const citations = normalizeCitations(candidate.citations, run.result)
      const answer = String(candidate.answer ?? '').trim()
      if (!answer) throw new Error('REVIEW_QA_EMPTY_ANSWER')
      const limitations = candidate.limitations.map(item => String(item).trim()).filter(Boolean)
      const turn: ReviewQaTurn = {
        id: turnId, sessionId: session.id, projectVersionId: run.projectVersionId, runId, question, answer, citations, limitations, quote,
        status: 'succeeded', modelRef: { sourceId: source.id, modelId: model.id, label: `${source.name} · ${model.displayName}` },
        ...(configuration ? { agentConfigurationRef: { id: configuration.id, version: configuration.version, contentSha256: configuration.contentSha256 } } : {}),
        agentDefinitionRef: { agentKey: definition.agentKey, version: definition.version, contentSha256: definition.contentSha256, promptRef: definition.promptRef, toolsetContentSha256: definition.toolsetContentSha256 },
        execution, usage: executionUsage(execution.events), createdBy: actorId, createdAt, finishedAt: new Date().toISOString(),
      }
      await this.store.transaction(draft => { draft.reviewQaTurns.push(turn) })
      return { id: turn.id, sessionId: session.id, runId, question, answer, citations, limitations, quote, modelLabel: turn.modelRef!.label, execution, ...(turn.agentConfigurationRef ? { agentConfigurationRef: turn.agentConfigurationRef } : {}), createdAt, createdBy: actorDisplayName }
    } catch (error) {
      const message = sanitizeError(error, source.baseUrl, source.apiKey)
      const status = signal.aborted ? 'cancelled' : 'failed'
      const turn: ReviewQaTurn = {
        id: turnId, sessionId: session.id, projectVersionId: run.projectVersionId, runId, question, citations: [], limitations: [], quote,
        status, modelRef: { sourceId: source.id, modelId: model.id, label: `${source.name} · ${model.displayName}` },
        ...(configuration ? { agentConfigurationRef: { id: configuration.id, version: configuration.version, contentSha256: configuration.contentSha256 } } : {}),
        agentDefinitionRef: { agentKey: definition.agentKey, version: definition.version, contentSha256: definition.contentSha256, promptRef: definition.promptRef, toolsetContentSha256: definition.toolsetContentSha256 },
        error: message, createdBy: actorId, createdAt, finishedAt: new Date().toISOString(),
      }
      await this.store.transaction(draft => { draft.reviewQaTurns.push(turn) })
      throw new Error(message)
    }
  }
}

function executionUsage(events: AgentExecutionEvent[]) {
  const totals = events.flatMap(event => event.usage ? [event.usage] : [])
  if (!totals.length) return undefined
  return totals.reduce((sum, item) => ({ input: sum.input + item.input, output: sum.output + item.output, totalTokens: sum.totalTokens + item.totalTokens }), { input: 0, output: 0, totalTokens: 0 })
}

function sanitizeError(error: unknown, endpoint: string, credential: string) {
  let message = error instanceof Error ? error.message : '评审问答失败'
  if (endpoint) message = message.replaceAll(endpoint, '[模型端点]')
  if (credential) message = message.replaceAll(credential, '••••••')
  return message.slice(0, 2_000)
}

function selectModel(state: DatabaseState, run: ReviewRun, configuration: AgentConfigurationVersion | null) {
  const references = configuration?.routing.primaryModel
    ? [configuration.routing.primaryModel, ...(configuration.routing.fallbackEnabled ? configuration.routing.fallbackModels : [])]
    : [{ sourceId: run.sourceId, modelId: run.modelId }]
  let lastError = '评审问答模型不可用'
  for (const reference of references) {
    const source = state.modelSources.find(item => item.id === reference.sourceId)
    const model = source?.models.find(item => item.id === reference.modelId)
    if (!source || !model) { lastError = '评审问答模型或来源不存在'; continue }
    if (!source.enabled || !model.enabled) { lastError = `${source.name} · ${model.displayName} 未启用`; continue }
    if (model.health !== 'healthy') { lastError = `${source.name} · ${model.displayName} 当前不健康`; continue }
    if (!model.capabilities.includes('tool_calling')) { lastError = `${source.name} · ${model.displayName} 不支持工具调用`; continue }
    return { source: source as GenerativeModelSource, model: model as GenerativeModel }
  }
  throw new Error(`${lastError}，请重新探测或调整评审问答 Agent 路由`)
}

function normalizeCitations(value: string[], result: NonNullable<ReviewRun['result']>) {
  const evidenceIds = new Set(result.evidence.map(item => item.clientEvidenceId))
  const pointsById = new Map(result.requirementPoints.map(point => [point.clientRequirementPointId, point]))
  const findingsById = new Map(result.findings.map(finding => [finding.clientFindingId, finding]))
  const citations: string[] = []
  const invalid: string[] = []

  for (const citation of value.map(item => String(item).trim()).filter(Boolean)) {
    const evidence = evidenceIds.has(citation)
      ? [citation]
      : pointsById.get(citation)?.evidenceRefs
        ?? findingsById.get(citation)?.requirementPointRefs.flatMap(reference => pointsById.get(reference)?.evidenceRefs ?? [])
    const resolvedEvidence = evidence?.filter(evidenceId => evidenceIds.has(evidenceId)) ?? []
    if (!resolvedEvidence.length) {
      invalid.push(citation)
      continue
    }
    for (const evidenceId of resolvedEvidence) if (!citations.includes(evidenceId)) citations.push(evidenceId)
  }
  if (invalid.length) throw new Error(`REVIEW_QA_INVALID_CITATION: ${invalid.join(', ')}`)
  return citations
}

function normalizeQuote(value: ReviewQuestionQuote | undefined, assetVersionIds: Set<string>, versions: Array<{ id: string; content: string }>, result: NonNullable<ReviewRun['result']>) {
  if (!value) return undefined
  const text = String(value.text ?? '').trim().slice(0, 1_000)
  if (!text) return undefined
  if (!assetVersionIds.has(value.assetVersionId)) throw new Error('引用内容不属于本次评审的固定资产版本')
  const content = versions.find(version => version.id === value.assetVersionId)?.content ?? ''
  const finding = value.findingId ? result.findings.find(item => item.clientFindingId === value.findingId) : undefined
  if (!content.includes(text) && !finding?.description.includes(text)) throw new Error('引用内容无法在固定需求原文或本次 Finding 中验证')
  return { ...value, text, assetVersionId: value.assetVersionId, heading: String(value.heading ?? '').trim().slice(0, 300) || '固定需求原文' }
}

function required<T>(value: T | undefined, message: string): T { if (value === undefined) throw new Error(message); return value }
