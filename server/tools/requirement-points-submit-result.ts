import type { CandidateRequirementPointExtractionV5 } from '../domain/review-types.js'
import type { ToolRegistry } from './registry.js'
import type { ReviewSubmissionFeedback } from './submission-feedback.js'
import { defaultBuiltInToolConfigResolver } from './built-in-tool-config.js'

export function registerRequirementPointsSubmitResultTool(registry: ToolRegistry, submit: (candidate: CandidateRequirementPointExtractionV5) => ReviewSubmissionFeedback | Promise<ReviewSubmissionFeedback>) {
  registry.register(defaultBuiltInToolConfigResolver.toDescriptor('requirement-points.submit_result'), async request => {
    const feedback = await submit(structuredClone(request.arguments) as CandidateRequirementPointExtractionV5)
    return feedback.accepted
      ? { data: { accepted: true, status: 'candidate_validated' }, terminate: true }
      : { data: { accepted: false, status: 'validation_failed', issues: feedback.issues?.slice(0, 20) ?? [] }, terminate: false }
  })
}
