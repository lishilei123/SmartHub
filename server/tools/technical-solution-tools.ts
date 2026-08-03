import { Type } from 'typebox'
import type { TechnicalSolutionReviewSubmissionV1, TechnicalSolutionRunSnapshot } from '../domain/technical-solution-types.js'
import type { StateStore } from '../infrastructure/store.js'
import { registerKnowledgeReadChunkTool } from './knowledge-read-chunk.js'
import { registerKnowledgeSearchTool } from './knowledge-search.js'
import { ToolRegistry } from './registry.js'
import type { ReviewSubmissionFeedback } from './submission-feedback.js'

export function createTechnicalSolutionToolRegistry(store: StateStore, submit: (candidate: TechnicalSolutionReviewSubmissionV1) => ReviewSubmissionFeedback | Promise<ReviewSubmissionFeedback>) {
  const registry = new ToolRegistry()
  registerKnowledgeSearchTool(registry, store)
  registerKnowledgeReadChunkTool(registry, store)
  registry.register({
    id: 'technical_solution.input.read', piName: 'technical_solution_input_read', version: '1.0.0', label: '补读固定技术方案正文', risk: 'read', idempotent: true, repeatPolicy: 'replay_success_once', timeoutMs: 30_000,
    description: '仅按本次运行快照中的技术方案资产版本补读固定正文，不读取最新版本。',
    parameters: Type.Object({ assetVersionId: Type.String({ minLength: 1, maxLength: 200 }), chunkId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }, { additionalProperties: false }),
  }, async request => {
    const snapshot = request.context.snapshot as TechnicalSolutionRunSnapshot
    const args = request.arguments as { assetVersionId: string; chunkId?: string }
    const allowed = snapshot.solutionInputs.find(item => item.assetVersionId === args.assetVersionId)
    if (!allowed) throw new Error('TECH_TOOL_INPUT_OUT_OF_SCOPE: 资产版本不属于本次固定技术方案输入')
    const state = await store.snapshot()
    const version = state.versions.find(item => item.id === args.assetVersionId && item.contentHash === allowed.contentSha256)
    if (!version) throw new Error('TECH_INPUT_HASH_MISMATCH: 固定正文不存在或 Hash 不一致')
    if (args.chunkId) {
      const chunk = version.chunks.find(item => item.id === args.chunkId)
      if (!chunk) throw new Error('TECH_TOOL_INPUT_OUT_OF_SCOPE: Chunk 不属于固定资产版本')
      return { data: { assetVersionId: version.id, contentSha256: version.contentHash, chunkId: chunk.id, headingPath: chunk.headingPath, startLine: chunk.startLine, endLine: chunk.endLine, content: chunk.content } }
    }
    return { data: { assetVersionId: version.id, contentSha256: version.contentHash, content: version.content } }
  })
  registry.register({
    id: 'technical_solution.evidence.preview', piName: 'technical_solution_evidence_preview', version: '1.0.0', label: '预校验技术方案原文线索', risk: 'read', idempotent: true, timeoutMs: 30_000,
    description: '检查逐字原文线索在固定技术方案输入中是否唯一出现；只返回候选匹配，不生成正式 Evidence。',
    parameters: Type.Object({ sourceText: Type.String({ minLength: 4, maxLength: 4_000 }) }, { additionalProperties: false }),
  }, async request => {
    const snapshot = request.context.snapshot as TechnicalSolutionRunSnapshot
    const sourceText = String((request.arguments as { sourceText: string }).sourceText)
    const state = await store.snapshot()
    const matches = snapshot.solutionInputs.flatMap(input => {
      const version = state.versions.find(item => item.id === input.assetVersionId && item.contentHash === input.contentSha256)
      if (!version) return []
      return version.chunks.filter(chunk => normalized(chunk.content).includes(normalized(sourceText))).map(chunk => ({ assetVersionId: version.id, chunkId: chunk.id, headingPath: chunk.headingPath, startLine: chunk.startLine, endLine: chunk.endLine }))
    })
    return { data: { unique: matches.length === 1, count: matches.length, matches: matches.slice(0, 10) } }
  })
  registry.register({
    id: 'technical_solution_review.submit_result', piName: 'technical_solution_review_submit_result', version: '1.0.0', label: '提交技术方案评审候选', risk: 'internal_write', idempotent: false, timeoutMs: 30_000,
    description: '提交 technical-solution-review/v1 的语义内容和原文线索；正式 ID、Evidence、需求关系和统计由服务端生成。',
    parameters: candidateSchema(),
  }, async request => {
    const feedback = await submit(structuredClone(request.arguments) as TechnicalSolutionReviewSubmissionV1)
    return feedback.accepted ? { data: { accepted: true, status: 'candidate_validated' }, terminate: true } : { data: { accepted: false, status: 'validation_failed', issues: feedback.issues?.slice(0, 20) ?? [] } }
  })
  return registry
}

function candidateSchema() {
  const sourceTexts = Type.Array(Type.String({ minLength: 4, maxLength: 4_000 }), { maxItems: 20 })
  const stringList = Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 100 })
  return Type.Object({
    schemaVersion: Type.Literal('technical-solution-review/v1'),
    summary: Type.Object({ overallAssessment: Type.String({ minLength: 1, maxLength: 100, description: '建议使用 pass、pass_with_notes、needs_revision 或 blocked；常见近义值由服务端确定性归一化。' }), overview: Type.String({ minLength: 1, maxLength: 8_000 }), majorGaps: stringList, majorRisks: stringList, recommendedOrder: stringList }, { additionalProperties: false }),
    coverageCandidates: Type.Array(Type.Object({ requirementSourceTexts: sourceTexts, status: Type.String({ minLength: 1, maxLength: 100, description: '建议使用 covered、partially_covered、not_covered 或 needs_confirmation；常见近义值由服务端确定性归一化。' }), analysis: Type.String({ minLength: 1, maxLength: 8_000 }), solutionSourceTexts: sourceTexts }, { additionalProperties: false }), { maxItems: 500 }),
    findings: Type.Array(Type.Object({ type: Type.String({ minLength: 1, maxLength: 100, description: '建议使用 requirement_coverage_gap、architecture_gap、interface_gap、data_gap、exception_gap、non_functional_gap、conflict、risk 或 other；常见近义值由服务端确定性归一化。' }), severity: Type.String({ minLength: 1, maxLength: 100, description: '建议使用 blocker、high、medium 或 low；常见近义值由服务端确定性归一化。' }), title: Type.String({ minLength: 1, maxLength: 300 }), problem: Type.String({ minLength: 1, maxLength: 8_000 }), impact: Type.String({ minLength: 1, maxLength: 4_000 }), recommendation: Type.String({ minLength: 1, maxLength: 4_000 }), confidence: Type.Number({ minimum: 0, maximum: 1 }), requirementSourceTexts: sourceTexts, solutionSourceTexts: sourceTexts }, { additionalProperties: false }), { maxItems: 200 }),
    risks: Type.Array(Type.Object({ description: Type.String({ minLength: 1, maxLength: 4_000 }), impact: Type.String({ minLength: 1, maxLength: 4_000 }), mitigation: Type.String({ minLength: 1, maxLength: 4_000 }), requirementSourceTexts: sourceTexts, solutionSourceTexts: sourceTexts }, { additionalProperties: false }), { maxItems: 200 }),
    questions: Type.Array(Type.Object({ question: Type.String({ minLength: 1, maxLength: 4_000 }), reason: Type.String({ minLength: 1, maxLength: 4_000 }), requirementSourceTexts: sourceTexts, solutionSourceTexts: sourceTexts }, { additionalProperties: false }), { maxItems: 200 }),
  }, { additionalProperties: false })
}

function normalized(value: string) { return value.normalize('NFKC').replace(/\s+/gu, ' ').trim() }
