import type { TechnicalSolutionExtractionSubmissionV1, TechnicalSolutionReviewSubmissionV1, TechnicalSolutionReviewSubmissionV2, TechnicalSolutionRunSnapshot } from '../domain/technical-solution-types.js'
import type { StateStore } from '../infrastructure/store.js'
import { registerKnowledgeReadChunkTool } from './knowledge-read-chunk.js'
import { registerKnowledgeSearchTool } from './knowledge-search.js'
import { ToolRegistry } from './registry.js'
import type { ReviewSubmissionFeedback } from './submission-feedback.js'
import { defaultBuiltInToolConfigResolver } from './built-in-tool-config.js'

export function createTechnicalSolutionToolRegistry(store: StateStore, submit: (candidate: TechnicalSolutionReviewSubmissionV1) => ReviewSubmissionFeedback | Promise<ReviewSubmissionFeedback>) {
  const registry = new ToolRegistry()
  registerKnowledgeSearchTool(registry, store)
  registerKnowledgeReadChunkTool(registry, store)
  registry.register(defaultBuiltInToolConfigResolver.toDescriptor('technical_solution.input.read'), async request => {
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
  registry.register(defaultBuiltInToolConfigResolver.toDescriptor('technical_solution.evidence.preview'), async request => {
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
  registry.register(defaultBuiltInToolConfigResolver.toDescriptor('technical_solution_review.submit_result', 'legacy-candidate'), async request => {
    const feedback = await submit(structuredClone(request.arguments) as TechnicalSolutionReviewSubmissionV1)
    return feedback.accepted ? { data: { accepted: true, status: 'candidate_validated' }, terminate: true } : { data: { accepted: false, status: 'validation_failed', issues: feedback.issues?.slice(0, 20) ?? [] } }
  })
  return registry
}

export function createTechnicalSolutionExtractionToolRegistry(store: StateStore, submit: (candidate: TechnicalSolutionExtractionSubmissionV1) => ReviewSubmissionFeedback | Promise<ReviewSubmissionFeedback>) {
  const registry = createTechnicalSolutionToolRegistry(store, async () => ({ accepted: false, issues: [{ path: '', message: '旧版单阶段提交工具不可用于技术方案提取阶段' }] }))
  registry.register(defaultBuiltInToolConfigResolver.toDescriptor('technical_solution_points.submit_result'), async request => {
    const feedback = await submit(structuredClone(request.arguments) as TechnicalSolutionExtractionSubmissionV1)
    return feedback.accepted ? { data: { accepted: true, status: 'extraction_validated' }, terminate: true } : { data: { accepted: false, status: 'validation_failed', issues: feedback.issues?.slice(0, 20) ?? [] } }
  })
  return registry
}

export function createTechnicalSolutionReviewToolRegistry(submit: (candidate: TechnicalSolutionReviewSubmissionV2) => ReviewSubmissionFeedback | Promise<ReviewSubmissionFeedback>) {
  const registry = new ToolRegistry()
  registry.register(defaultBuiltInToolConfigResolver.toDescriptor('technical_solution_review.submit_result'), async request => {
    const feedback = await submit(structuredClone(request.arguments) as TechnicalSolutionReviewSubmissionV2)
    return feedback.accepted ? { data: { accepted: true, status: 'review_validated' }, terminate: true } : { data: { accepted: false, status: 'validation_failed', issues: feedback.issues?.slice(0, 20) ?? [] } }
  })
  return registry
}

function normalized(value: string) { return value.normalize('NFKC').replace(/\s+/gu, ' ').trim() }
