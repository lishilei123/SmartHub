import type { ReviewQaRuntime, ReviewQuestionQuote } from '../domain/review-qa-types.js'
import type { ReviewRun } from '../domain/types.js'
import type { StateStore } from '../infrastructure/store.js'

export interface ReviewQuestionRequest { question: string; quote?: ReviewQuestionQuote }

export class ReviewQaService {
  constructor(private readonly store: StateStore, private readonly runtime: ReviewQaRuntime) {}

  async ask(runId: string, request: ReviewQuestionRequest, signal = new AbortController().signal) {
    const question = String(request.question ?? '').trim()
    if (!question) throw new Error('评审问题不能为空')
    if (question.length > 2_000) throw new Error('评审问题不能超过 2000 个字符')
    const state = await this.store.snapshot()
    const run = required(state.reviewRuns.find(item => item.id === runId), '需求评审运行不存在')
    if (run.status !== 'succeeded' || !run.result) throw new Error('只有成功完成的评审运行可以继续问答')
    const fixedAssetVersionIds = new Set((run.snapshot.assets ?? [{ assetVersionId: run.assetVersionId }]).map(item => item.assetVersionId))
    const versions = [...fixedAssetVersionIds].map(versionId => required(state.versions.find(item => item.id === versionId && item.status === 'ready'), '评审绑定的固定资产版本不可用'))
    const documentContent = versions.map(version => version.content).join('\n\n')
    const source = required(state.modelSources.find(item => item.id === run.sourceId && item.enabled), '评审模型来源不可用')
    const model = required(source.models.find(item => item.id === run.modelId && item.enabled), '评审模型不可用')
    if (model.health !== 'healthy') throw new Error('评审模型当前不健康，请重新探测后再问答')
    const quote = normalizeQuote(request.quote, fixedAssetVersionIds, versions, run.result)
    const estimatedTokens = Math.ceil((documentContent.length + JSON.stringify(run.result).length + question.length) / 4) + 2_000
    if (estimatedTokens + Math.min(model.maxOutputTokens, 4_096) > model.contextWindow) throw new Error('固定评审上下文超过模型窗口，暂时无法继续问答')
    const candidate = await this.runtime.answer({
      question,
      quote,
      snapshot: run.snapshot,
      reviewResult: run.result,
      documentContent,
      model: { sourceId: source.id, providerType: source.providerType, baseUrl: source.baseUrl, apiKey: source.apiKey, modelId: model.id, modelName: model.name, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens },
    }, signal)
    const evidenceIds = new Set(run.result.evidence.map(item => item.clientEvidenceId))
    const citations = [...new Set(candidate.citations.map(item => String(item).trim()).filter(Boolean))]
    const invalid = citations.filter(item => !evidenceIds.has(item))
    if (invalid.length) throw new Error(`REVIEW_QA_INVALID_CITATION: ${invalid.join(', ')}`)
    const answer = String(candidate.answer ?? '').trim()
    if (!answer) throw new Error('REVIEW_QA_EMPTY_ANSWER')
    return { id: `review_qa_${crypto.randomUUID()}`, runId, question, answer, citations, limitations: candidate.limitations.map(item => String(item).trim()).filter(Boolean), quote, modelLabel: run.modelLabel, createdAt: new Date().toISOString() }
  }
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
