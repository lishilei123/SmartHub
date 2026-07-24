import { Type } from 'typebox'
import type { CandidateReviewResult } from '../domain/review-types.js'
import type { StateStore } from '../infrastructure/store.js'
import { ToolRegistry } from './registry.js'

export interface ReviewSubmissionFeedback { accepted: boolean; issues?: Array<{ path: string; message: string }> }

export function createRequirementToolRegistry(store: StateStore, submit: (candidate: CandidateReviewResult) => ReviewSubmissionFeedback | Promise<ReviewSubmissionFeedback>) {
  const registry = new ToolRegistry()
  registry.register({
    id: 'knowledge.search', piName: 'knowledge_search', version: '1.0.0', label: '固定索引检索', risk: 'read', idempotent: true, timeoutMs: 30_000,
    description: '仅在本次运行固定的知识索引版本内检索相关 Chunk。',
    parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 500 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
  }, async request => {
    const args = request.arguments as { query: string; limit?: number }
    const state = await store.snapshot()
    const index = required(state.indexes.find(item => item.id === request.context.snapshot.indexVersionId && item.knowledgeBaseId === request.context.snapshot.knowledgeBaseId), '固定索引不存在')
    const terms = [...new Set(args.query.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length > 1))]
    const results = (index.indexedChunks ?? []).map(chunk => {
      const haystack = `${chunk.headingPath.join(' ')} ${chunk.content}`.toLocaleLowerCase()
      const hits = terms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0)
      return { chunk, score: terms.length ? hits / terms.length : 0 }
    }).filter(item => item.score > 0).sort((left, right) => right.score - left.score || left.chunk.ordinal - right.chunk.ordinal).slice(0, args.limit ?? 8)
    return { data: { retrievalMode: 'fixed_index_keyword', degraded: true, degradedReason: '当前 M2 固定索引工具仅启用关键词召回', results: results.map(({ chunk, score }) => ({ chunkId: chunk.id, assetVersionId: chunk.assetVersionId, headingPath: chunk.headingPath, startLine: chunk.startLine, endLine: chunk.endLine, score, excerpt: chunk.content.slice(0, 1000) })) } }
  })

  registry.register({
    id: 'knowledge.read_asset', piName: 'knowledge_read_asset', version: '1.0.0', label: '读取固定需求资产', risk: 'read', idempotent: true, timeoutMs: 30_000,
    description: '读取本次固定资产版本的目录和指定行范围，不会切换到最新版本。',
    parameters: Type.Object({ startLine: Type.Optional(Type.Integer({ minimum: 1 })), endLine: Type.Optional(Type.Integer({ minimum: 1 })) }),
  }, async request => {
    const args = request.arguments as { startLine?: number; endLine?: number }
    const state = await store.snapshot()
    const version = required(state.versions.find(item => item.id === request.context.snapshot.assetVersionId && item.assetId === request.context.snapshot.assetId), '固定资产版本不存在')
    const lines = version.content.split(/\r?\n/u)
    const start = Math.min(args.startLine ?? 1, Math.max(lines.length, 1))
    const end = Math.min(Math.max(args.endLine ?? Math.min(start + 199, lines.length), start), lines.length)
    const outline = version.chunks.map(chunk => ({ chunkId: chunk.id, headingPath: chunk.headingPath, startLine: chunk.startLine, endLine: chunk.endLine }))
    return { data: { assetVersionId: version.id, contentHash: version.contentHash, totalLines: lines.length, startLine: start, endLine: end, content: lines.slice(start - 1, end).join('\n'), outline } }
  })

  registry.register({
    id: 'knowledge.read_chunk', piName: 'knowledge_read_chunk', version: '1.0.0', label: '读取固定 Chunk', risk: 'read', idempotent: true, timeoutMs: 30_000,
    description: '按 Chunk ID 读取固定索引中的完整内容与定位。',
    parameters: Type.Object({ chunkId: Type.String({ minLength: 1, maxLength: 200 }) }),
  }, async request => {
    const args = request.arguments as { chunkId: string }
    const state = await store.snapshot()
    const index = required(state.indexes.find(item => item.id === request.context.snapshot.indexVersionId), '固定索引不存在')
    const chunk = required(index.indexedChunks?.find(item => item.id === args.chunkId), 'Chunk 不属于固定索引')
    return { data: { chunkId: chunk.id, assetVersionId: chunk.assetVersionId, contentHash: chunk.contentHash, headingPath: chunk.headingPath, startLine: chunk.startLine, endLine: chunk.endLine, startChar: chunk.startChar, endChar: chunk.endChar, content: chunk.content } }
  })

  registry.register({
    id: 'evidence.validate', piName: 'evidence_validate', version: '1.0.0', label: '校验证据', risk: 'read', idempotent: true, timeoutMs: 30_000,
    description: '校验证据是否属于固定索引、固定资产版本，以及摘录是否真实存在。',
    parameters: Type.Object({ chunkId: Type.String({ minLength: 1 }), assetVersionId: Type.String({ minLength: 1 }), quote: Type.String({ minLength: 1, maxLength: 4000 }) }),
  }, async request => {
    const args = request.arguments as { chunkId: string; assetVersionId: string; quote: string }
    const state = await store.snapshot()
    const index = required(state.indexes.find(item => item.id === request.context.snapshot.indexVersionId), '固定索引不存在')
    const chunk = index.indexedChunks?.find(item => item.id === args.chunkId && item.assetVersionId === args.assetVersionId)
    const quote = args.quote.trim()
    return { data: { valid: Boolean(chunk && quote && chunk.content.includes(quote)), chunkId: args.chunkId, assetVersionId: args.assetVersionId, contentHash: chunk?.contentHash ?? null } }
  })

  registry.register({
    id: 'review.submit_result', piName: 'review_submit_result', version: '1.0.0', label: '提交候选评审结果', risk: 'internal_write', idempotent: false, timeoutMs: 30_000,
    description: '提交 review-result/v1 候选结果并结束 Agent。候选结果仍由 SmartHub 独立校验，不直接写入正式 Finding。',
    parameters: reviewResultSchema(),
  }, async request => {
    const feedback = await submit(structuredClone(request.arguments) as CandidateReviewResult)
    return feedback.accepted
      ? { data: { accepted: true, status: 'candidate_validated' }, terminate: true }
      : { data: { accepted: false, status: 'validation_failed', issues: feedback.issues?.slice(0, 20) ?? [] }, terminate: false }
  })
  return registry
}

function reviewResultSchema() {
  const strings = Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), { maxItems: 100 })
  return Type.Object({
    summary: Type.Object({ overallAssessment: Type.Union(['pass', 'pass_with_notes', 'needs_revision', 'blocked'].map(value => Type.Literal(value))), score: Type.Number({ minimum: 0, maximum: 100 }), strengths: strings, risks: strings }),
    findings: Type.Array(Type.Object({
      clientFindingId: Type.String({ minLength: 1, maxLength: 100 }),
      type: Type.Union(['missing_requirement', 'ambiguity', 'conflict', 'boundary_gap', 'state_gap', 'exception_gap', 'security_risk', 'testability_gap', 'dependency_risk', 'other'].map(value => Type.Literal(value))),
      severity: Type.Union(['critical', 'high', 'medium', 'low', 'info'].map(value => Type.Literal(value))),
      confidence: Type.Number({ minimum: 0, maximum: 1 }), title: Type.String({ minLength: 1, maxLength: 300 }), description: Type.String({ minLength: 1, maxLength: 8000 }), impact: Type.String({ minLength: 1, maxLength: 4000 }), recommendation: Type.String({ minLength: 1, maxLength: 4000 }), evidenceRefs: Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 }),
    }), { maxItems: 100 }),
    evidence: Type.Array(Type.Object({ clientEvidenceId: Type.String({ minLength: 1, maxLength: 100 }), sourceType: Type.Literal('knowledge_chunk'), sourceRef: Type.Object({ chunkId: Type.String({ minLength: 1 }), assetVersionId: Type.String({ minLength: 1 }) }), quote: Type.String({ minLength: 1, maxLength: 4000 }), locator: Type.Object({ heading: Type.String(), start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 0 }) }) }), { maxItems: 300 }),
    coverage: Type.Object({ reviewedAreas: strings, notReviewedAreas: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 100 }), limitations: Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 100 }) }),
  })
}

function required<T>(value: T | undefined, message: string): T { if (value === undefined) throw new Error(message); return value }
