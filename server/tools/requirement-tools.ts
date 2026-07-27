import type { CandidateRequirementPointExtractionV5, CandidateRequirementReviewV3 } from '../domain/review-types.js'
import type { StateStore } from '../infrastructure/store.js'
import { registerKnowledgeReadChunkTool } from './knowledge-read-chunk.js'
import { registerKnowledgeSearchTool } from './knowledge-search.js'
import { ToolRegistry } from './registry.js'
import { registerRequirementPointsSubmitResultTool } from './requirement-points-submit-result.js'
import { registerReviewSubmitResultTool } from './review-submit-result.js'
import type { ReviewSubmissionFeedback } from './submission-feedback.js'

export type { ReviewSubmissionFeedback } from './submission-feedback.js'

export function createRequirementPointExtractionToolRegistry(store: StateStore, submit: (candidate: CandidateRequirementPointExtractionV5) => ReviewSubmissionFeedback | Promise<ReviewSubmissionFeedback>) {
  const registry = new ToolRegistry()
  registerKnowledgeSearchTool(registry, store)
  registerKnowledgeReadChunkTool(registry, store)
  registerRequirementPointsSubmitResultTool(registry, submit)
  return registry
}

export function createRequirementReviewToolRegistry(submit: (candidate: CandidateRequirementReviewV3) => ReviewSubmissionFeedback | Promise<ReviewSubmissionFeedback>) {
  const registry = new ToolRegistry()
  registerReviewSubmitResultTool(registry, submit)
  return registry
}
