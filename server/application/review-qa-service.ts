import { BuiltInAgentDefinitionResolver } from '../agent/requirement-analysis-agent.js'
import type { AgentDefinitionResolver, AgentExecutionEvent } from '../domain/agent-types.js'
import type { ReviewQaRuntime, ReviewQuestionQuote } from '../domain/review-qa-types.js'
import type { AgentConfigurationVersion, DatabaseState, GenerativeModel, GenerativeModelSource, ReviewRun } from '../domain/types.js'
import type { StateStore } from '../infrastructure/store.js'

export interface ReviewQuestionRequest { question: string; quote?: ReviewQuestionQuote }

export class ReviewQaService {
  constructor(
    private readonly store: StateStore,
    private readonly runtime: ReviewQaRuntime,
    private readonly definitions: AgentDefinitionResolver = new BuiltInAgentDefinitionResolver(),
  ) {}

  async ask(runId: string, request: ReviewQuestionRequest, signal = new AbortController().signal, onEvent?: (event: AgentExecutionEvent) => void | Promise<void>) {
    const question = String(request.question ?? '').trim()
    if (!question) throw new Error('评审问题不能为空')
    if (question.length > 2_000) throw new Error('评审问题不能超过 2000 个字符')
    const state = await this.store.snapshot()
    const run = required(state.reviewRuns.find(item => item.id === runId), '需求评审运行不存在')
    if (run.status !== 'succeeded' || !run.result) throw new Error('只有成功完成的评审运行可以继续问答')
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
    return { id: `review_qa_${crypto.randomUUID()}`, runId, question, answer, citations, limitations: candidate.limitations.map(item => String(item).trim()).filter(Boolean), quote, modelLabel: `${source.name} · ${model.displayName}`, execution, ...(configuration ? { agentConfigurationRef: { id: configuration.id, version: configuration.version, contentSha256: configuration.contentSha256 } } : {}), createdAt: new Date().toISOString() }
  }
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
