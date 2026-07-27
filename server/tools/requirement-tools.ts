import { Type } from 'typebox'
import type { CandidateRequirementPointExtractionV5, CandidateRequirementReviewV3 } from '../domain/review-types.js'
import type { StateStore } from '../infrastructure/store.js'
import { ToolRegistry } from './registry.js'
import { resolveEvidenceQuote, searchEvidenceCandidates } from '../agent/evidence-locator.js'

export interface ReviewSubmissionFeedback { accepted: boolean; issues?: Array<{ path: string; message: string }> }

export function createRequirementPointExtractionToolRegistry(store: StateStore, submit: (candidate: CandidateRequirementPointExtractionV5) => ReviewSubmissionFeedback | Promise<ReviewSubmissionFeedback>) {
  const registry = new ToolRegistry()
  registry.register({
    id: 'knowledge.search', piName: 'knowledge_search', version: '1.0.0', label: '固定索引检索', risk: 'read', idempotent: true, timeoutMs: 30_000,
    description: '仅在本次运行固定的知识索引版本内检索相关 Chunk；正文已直接投递时只用于定向复查。',
    parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 500 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
  }, async request => {
    const args = request.arguments as { query: string; limit?: number }
    const state = await store.snapshot()
    const index = required(state.indexes.find(item => item.id === request.context.snapshot.indexVersionId && item.knowledgeBaseId === request.context.snapshot.knowledgeBaseId), '固定索引不存在')
    const allowedVersions = new Set(request.context.snapshot.assets.map(item => item.assetVersionId))
    const terms = [...new Set(args.query.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length > 1))]
    const results = (index.indexedChunks ?? []).filter(chunk => allowedVersions.has(chunk.assetVersionId)).map(chunk => {
      const haystack = `${chunk.headingPath.join(' ')} ${chunk.content}`.toLocaleLowerCase()
      const hits = terms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0)
      return { chunk, score: terms.length ? hits / terms.length : 0 }
    }).filter(item => item.score > 0).sort((left, right) => right.score - left.score || left.chunk.ordinal - right.chunk.ordinal).slice(0, args.limit ?? 8)
    return { data: { retrievalMode: 'fixed_index_keyword', degraded: true, degradedReason: '当前固定索引工具仅启用关键词召回', results: results.map(({ chunk, score }) => ({ chunkId: chunk.id, assetVersionId: chunk.assetVersionId, headingPath: chunk.headingPath, startLine: chunk.startLine, endLine: chunk.endLine, score, excerpt: chunk.content.slice(0, 1000) })) } }
  })

  registry.register({
    id: 'knowledge.read_chunk', piName: 'knowledge_read_chunk', version: '1.0.0', label: '读取固定 Chunk', risk: 'read', idempotent: true, repeatPolicy: 'replay_success_once', timeoutMs: 30_000,
    description: '仅在需要复核引用时按 Chunk ID 读取本次固定输入中的完整内容与定位。',
    parameters: Type.Object({ chunkId: Type.String({ minLength: 1, maxLength: 200 }) }),
  }, async request => {
    const args = request.arguments as { chunkId: string }
    const state = await store.snapshot()
    const index = required(state.indexes.find(item => item.id === request.context.snapshot.indexVersionId), '固定索引不存在')
    const allowedVersions = new Set(request.context.snapshot.assets.map(item => item.assetVersionId))
    const chunk = required(index.indexedChunks?.find(item => item.id === args.chunkId && allowedVersions.has(item.assetVersionId)), 'Chunk 不属于本次固定输入')
    return { data: { chunkId: chunk.id, assetVersionId: chunk.assetVersionId, contentHash: chunk.contentHash, headingPath: chunk.headingPath, startLine: chunk.startLine, endLine: chunk.endLine, startChar: chunk.startChar, endChar: chunk.endChar, content: chunk.content } }
  })

  registry.register({
    id: 'evidence.validate_batch', piName: 'evidence_validate_batch', version: '1.1.0', label: '批量检索并校验证据原文', risk: 'read', idempotent: true, timeoutMs: 30_000,
    description: '把 quote 作为原文检索线索：优先精确匹配，再忽略 Markdown、空白和标点检索，必要时按省略号前后片段恢复固定输入中的唯一连续原文；返回服务端生成的规范 quote、chunkId 与 locator。',
    parameters: Type.Object({ items: Type.Array(Type.Object({
      assetVersionId: Type.String({ minLength: 1, maxLength: 200 }),
      chunkId: Type.String({ minLength: 1, maxLength: 200 }),
      quote: Type.String({ minLength: 1, maxLength: 4000 }),
    }, { additionalProperties: false }), { minItems: 1, maxItems: 100 }) }),
  }, async request => {
    const args = request.arguments as { items: Array<{ assetVersionId: string; chunkId: string; quote: string }> }
    const state = await store.snapshot()
    const index = required(state.indexes.find(item => item.id === request.context.snapshot.indexVersionId), '固定索引不存在')
    const allowedVersions = new Set(request.context.snapshot.assets.map(item => item.assetVersionId))
    const chunks = (index.indexedChunks ?? []).filter(chunk => allowedVersions.has(chunk.assetVersionId))
    return { data: { results: args.items.map((item, itemIndex) => {
      if (!allowedVersions.has(item.assetVersionId)) return { itemIndex, valid: false, reason: 'asset_not_in_fixed_snapshot' }
      const resolved = resolveEvidenceQuote(item, chunks)
      if (!resolved) return { itemIndex, valid: false, reason: 'quote_not_uniquely_locatable', suggestions: searchEvidenceCandidates(item, chunks).slice(0, 20).map(candidate => ({ assetVersionId: candidate.chunk.assetVersionId, chunkId: candidate.chunk.id, quote: candidate.quote, contentHash: candidate.chunk.contentHash, locator: { heading: candidate.chunk.headingPath.at(-1) ?? '', start: candidate.chunk.startChar + candidate.offset, end: candidate.chunk.startChar + candidate.offset + candidate.quote.length }, score: candidate.score })) }
      const { chunk, quote, offset, strategy } = resolved
      return { itemIndex, valid: true, assetVersionId: chunk.assetVersionId, chunkId: chunk.id, contentHash: chunk.contentHash, quote, locator: { heading: chunk.headingPath.at(-1) ?? '', start: chunk.startChar + offset, end: chunk.startChar + offset + quote.length }, strategy }
    }) } }
  })

  registry.register({
    id: 'requirement-points.submit_result', piName: 'requirement_points_submit_result', version: '5.1.0', label: '提交需求标题、描述与原文线索', risk: 'internal_write', idempotent: false, timeoutMs: 30_000,
    description: '提交 requirement-point-extraction/v5。模型正常为每条需求点生成 title，并提交 description 和 sourceTexts；title 缺失或空白时服务端根据 description 兜底，其余结构、ID、Evidence、引用、定位和覆盖清单全部由服务端生成。',
    parameters: requirementPointExtractionSchemaV5(),
  }, async request => {
    const feedback = await submit(structuredClone(request.arguments) as CandidateRequirementPointExtractionV5)
    return feedback.accepted
      ? { data: { accepted: true, status: 'candidate_validated' }, terminate: true }
      : { data: { accepted: false, status: 'validation_failed', issues: feedback.issues?.slice(0, 20) ?? [] }, terminate: false }
  })
  return registry
}

export function createRequirementReviewToolRegistry(submit: (candidate: CandidateRequirementReviewV3) => ReviewSubmissionFeedback | Promise<ReviewSubmissionFeedback>) {
  const registry = new ToolRegistry()
  registry.register({
    id: 'review.submit_result', piName: 'review_submit_result', version: '4.0.0', label: '提交需求点对应分析', risk: 'internal_write', idempotent: false, timeoutMs: 30_000,
    description: '提交 requirement-review/v3。每条分析只需关联一个冻结需求点；模型给出标题、类型、严重度、置信度、影响、建议和总体摘要，服务端生成 Finding ID 并完成引用结构。',
    parameters: requirementReviewSchemaV3(),
  }, async request => {
    const feedback = await submit(structuredClone(request.arguments) as CandidateRequirementReviewV3)
    return feedback.accepted
      ? { data: { accepted: true, status: 'candidate_validated' }, terminate: true }
      : { data: { accepted: false, status: 'validation_failed', issues: feedback.issues?.slice(0, 20) ?? [] }, terminate: false }
  })
  return registry
}

function requirementPointExtractionSchemaV5() {
  return Type.Object({
    requirementPoints: Type.Array(Type.Object({
      title: Type.Optional(Type.String({ maxLength: 1000, description: '模型生成的简洁需求点标题；缺失或空白时由服务端根据 description 兜底。' })),
      description: Type.String({ minLength: 1, maxLength: 8000, description: '可独立实现、测试或验收的原子需求描述。' }),
      sourceTexts: Type.Array(Type.String({ minLength: 4, maxLength: 4000, description: '支撑当前需求点的原文或高区分度原文线索。' }), { minItems: 1, maxItems: 20 }),
    }, { additionalProperties: false }), { maxItems: 500 }),
  }, { additionalProperties: false })
}

function requirementReviewSchemaV3() {
  const strings = Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), { maxItems: 100 })
  return Type.Object({
    summary: Type.Optional(Type.Object({
      overallAssessment: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: '建议使用 pass、pass_with_notes、needs_revision 或 blocked。' })),
      score: Type.Optional(Type.Number()),
      strengths: Type.Optional(strings),
      risks: Type.Optional(strings),
    }, { additionalProperties: false })),
    analyses: Type.Array(Type.Object({
      requirementPointRef: Type.String({ minLength: 1, maxLength: 100, description: '必须是输入中存在的 RP-* 需求点 ID。' }),
      analysis: Type.String({ minLength: 1, maxLength: 8000 }),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
      type: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      severity: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      confidence: Type.Optional(Type.Number()),
      impact: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
      recommendation: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
    }, { additionalProperties: false }), { maxItems: 100 }),
  }, { additionalProperties: false })
}

function required<T>(value: T | undefined, message: string): T { if (value === undefined) throw new Error(message); return value }
