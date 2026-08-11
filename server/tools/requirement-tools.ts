import type { CandidateRequirementPointExtractionV5, CandidateRequirementReviewV3 } from '../domain/review-types.js'
import type { StateStore } from '../infrastructure/store.js'
import { ToolRegistry } from './registry.js'
import { registerRequirementPointsSubmitResultTool } from './requirement-points-submit-result.js'
import { registerReviewSubmitResultTool } from './review-submit-result.js'
import { registerRequirementDocumentWorkspaceTools, type RequirementDocumentReadObservation, type RequirementDocumentWorkspace } from './requirement-document-workspace.js'
import type { ReviewSubmissionFeedback } from './submission-feedback.js'

export type { ReviewSubmissionFeedback } from './submission-feedback.js'

export function createRequirementPointExtractionToolRegistry(
  store: StateStore,
  submit: (candidate: CandidateRequirementPointExtractionV5) => ReviewSubmissionFeedback | Promise<ReviewSubmissionFeedback>,
  onRead?: (observation: RequirementDocumentReadObservation) => void,
  documentWorkspace?: RequirementDocumentWorkspace,
) {
  const registry = new ToolRegistry()
  if (!documentWorkspace) throw new Error('PI_DOCUMENT_WORKSPACE_REQUIRED')
  registerRequirementDocumentWorkspaceTools(registry, documentWorkspace, onRead)
  registerRequirementPointsSubmitResultTool(registry, submit)
  return registry
}

export function createRequirementReviewToolRegistry(submit: (candidate: CandidateRequirementReviewV3) => ReviewSubmissionFeedback | Promise<ReviewSubmissionFeedback>) {
  const registry = new ToolRegistry()
  registerReviewSubmitResultTool(registry, submit)
  return registry
}
