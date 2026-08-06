import type { ReviewAnswerCandidate } from '../domain/review-qa-types.js'
import type { ToolRegistry } from './registry.js'
import { defaultBuiltInToolConfigResolver } from './built-in-tool-config.js'

export function registerReviewAnswerSubmitTool(registry: ToolRegistry, submit: (candidate: ReviewAnswerCandidate) => void | Promise<void>) {
  registry.register(defaultBuiltInToolConfigResolver.toDescriptor('review.answer_submit'), async request => {
    await submit(structuredClone(request.arguments) as ReviewAnswerCandidate)
    return { data: { accepted: true, status: 'candidate_received' }, terminate: true }
  })
}
