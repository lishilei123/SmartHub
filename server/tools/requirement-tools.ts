import { Type } from 'typebox'
import type { CandidateRequirementPointExtractionV3, CandidateRequirementReview } from '../domain/review-types.js'
import type { StateStore } from '../infrastructure/store.js'
import { ToolRegistry } from './registry.js'
import { resolveEvidenceQuote } from '../agent/evidence-locator.js'

export interface ReviewSubmissionFeedback { accepted: boolean; issues?: Array<{ path: string; message: string }> }

export function createRequirementPointExtractionToolRegistry(store: StateStore, submit: (candidate: CandidateRequirementPointExtractionV3) => ReviewSubmissionFeedback | Promise<ReviewSubmissionFeedback>) {
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
    id: 'evidence.validate_batch', piName: 'evidence_validate_batch', version: '1.0.0', label: '批量校验证据草稿', risk: 'read', idempotent: true, timeoutMs: 30_000,
    description: '批量校验引用是否能通过精确原文或 Markdown 可见文本映射到固定输入的唯一连续位置，并按 itemIndex 返回规范 quote、chunkId 与 locator；无需创建 Evidence ID。',
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
      if (!resolved) return { itemIndex, valid: false, reason: 'quote_not_uniquely_locatable' }
      const { chunk, quote, offset, strategy } = resolved
      return { itemIndex, valid: true, assetVersionId: chunk.assetVersionId, chunkId: chunk.id, contentHash: chunk.contentHash, quote, locator: { heading: chunk.headingPath.at(-1) ?? '', start: chunk.startChar + offset, end: chunk.startChar + offset + quote.length }, strategy }
    }) } }
  })

  registry.register({
    id: 'requirement-points.submit_result', piName: 'requirement_points_submit_result', version: '3.0.0', label: '提交需求点提取草稿', risk: 'internal_write', idempotent: false, timeoutMs: 30_000,
    description: '提交 requirement-point-extraction/v3。每条需求点把自己的 evidenceDrafts 直接放在该需求点内；不要提交 clientRequirementPointId、clientEvidenceId、evidenceRef 或 evidenceRefs。服务端生成需求点 ID、Evidence ID、evidenceRefs、规范定位与覆盖清单。',
    parameters: requirementPointExtractionSchemaV3(),
  }, async request => {
    const feedback = await submit(structuredClone(request.arguments) as CandidateRequirementPointExtractionV3)
    return feedback.accepted
      ? { data: { accepted: true, status: 'candidate_validated' }, terminate: true }
      : { data: { accepted: false, status: 'validation_failed', issues: feedback.issues?.slice(0, 20) ?? [] }, terminate: false }
  })
  return registry
}

export function createRequirementReviewToolRegistry(submit: (candidate: CandidateRequirementReview) => ReviewSubmissionFeedback | Promise<ReviewSubmissionFeedback>) {
  const registry = new ToolRegistry()
  registry.register({
    id: 'review.submit_result', piName: 'review_submit_result', version: '3.0.0', label: '提交候选需求评审', risk: 'internal_write', idempotent: false, timeoutMs: 30_000,
    description: '提交 requirement-review/v2 候选结果并结束评审 Agent。协议只接受 Finding 与评审摘要；Finding 必须关联需求点。',
    parameters: requirementReviewSchema(),
  }, async request => {
    const feedback = await submit(structuredClone(request.arguments) as CandidateRequirementReview)
    return feedback.accepted
      ? { data: { accepted: true, status: 'candidate_validated' }, terminate: true }
      : { data: { accepted: false, status: 'validation_failed', issues: feedback.issues?.slice(0, 20) ?? [] }, terminate: false }
  })
  return registry
}

function requirementPointExtractionSchemaV3() {
  const strings = Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), { maxItems: 100 })
  const requirementPointFields = {
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 300, description: '可选短标题；省略时由服务端根据 actor、action、object 或 description 生成。' })),
    description: Type.String({ minLength: 1, maxLength: 8000 }),
    actor: Type.String({ maxLength: 500 }), action: Type.String({ maxLength: 500 }), object: Type.String({ maxLength: 500 }),
    conditions: strings, businessRules: strings, exceptions: strings, acceptanceCriteria: strings,
    evidenceDrafts: Type.Array(Type.Object({
      assetVersionId: Type.String({ minLength: 1, maxLength: 200 }),
      chunkId: Type.String({ minLength: 1, maxLength: 200 }),
      quote: Type.String({ minLength: 4, maxLength: 4000, description: '从该 Chunk 连续复制的原文，不得改写，不得使用 ... 或 … 省略。' }),
    }, { additionalProperties: false }), { minItems: 1, maxItems: 20, description: '只放属于当前需求点的证据草稿。' }),
  }
  const requirementPoint = Type.Union([
    Type.Object(requirementPointFields, { additionalProperties: false }),
    Type.Object({
      ...requirementPointFields,
      mergeGroupId: Type.String({ minLength: 1, maxLength: 100, pattern: '.*\\S.*' }),
      mergeRationale: Type.String({ minLength: 1, maxLength: 2000, pattern: '.*\\S.*' }),
    }, { additionalProperties: false }),
  ])
  return Type.Object({
    requirementPoints: Type.Array(requirementPoint, { maxItems: 500 }),
  }, { additionalProperties: false })
}

function requirementReviewSchema() {
  const strings = Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), { maxItems: 100 })
  return Type.Object({
    summary: Type.Object({ overallAssessment: Type.Union(['pass', 'pass_with_notes', 'needs_revision', 'blocked'].map(value => Type.Literal(value))), score: Type.Number({ minimum: 0, maximum: 100 }), strengths: strings, risks: strings }, { additionalProperties: false }),
    findings: Type.Array(Type.Object({
      clientFindingId: Type.String({ minLength: 1, maxLength: 100 }),
      type: Type.Union(['missing_requirement', 'ambiguity', 'conflict', 'boundary_gap', 'state_gap', 'exception_gap', 'security_risk', 'testability_gap', 'dependency_risk', 'other'].map(value => Type.Literal(value))),
      severity: Type.Union(['critical', 'high', 'medium', 'low', 'info'].map(value => Type.Literal(value))),
      confidence: Type.Number({ minimum: 0, maximum: 1 }), title: Type.String({ minLength: 1, maxLength: 300 }), description: Type.String({ minLength: 1, maxLength: 8000 }), impact: Type.String({ minLength: 1, maxLength: 4000 }), recommendation: Type.String({ minLength: 1, maxLength: 4000 }), requirementPointRefs: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20 }),
    }, { additionalProperties: false }), { maxItems: 100 }),
  }, { additionalProperties: false })
}

function required<T>(value: T | undefined, message: string): T { if (value === undefined) throw new Error(message); return value }
