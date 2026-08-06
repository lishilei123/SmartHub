import type { CandidateRequirementReviewV3 } from '../domain/review-types.js'
import type { ToolRegistry } from './registry.js'
import type { ReviewSubmissionFeedback } from './submission-feedback.js'
import { defaultBuiltInToolConfigResolver } from './built-in-tool-config.js'

export function registerReviewSubmitResultTool(registry: ToolRegistry, submit: (candidate: CandidateRequirementReviewV3) => ReviewSubmissionFeedback | Promise<ReviewSubmissionFeedback>) {
  registry.register(defaultBuiltInToolConfigResolver.toDescriptor('review.submit_result'), async request => {
    const feedback = await submit(structuredClone(request.arguments) as CandidateRequirementReviewV3)
    return feedback.accepted
      ? { data: { accepted: true, status: 'candidate_validated' }, terminate: true }
      : { data: { accepted: false, status: 'validation_failed', issues: feedback.issues?.slice(0, 20) ?? [] }, terminate: false }
  })
}
