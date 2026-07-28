import { Type } from 'typebox'
import type { ReviewAnswerCandidate } from '../domain/review-qa-types.js'
import type { ToolRegistry } from './registry.js'

export function registerReviewAnswerSubmitTool(registry: ToolRegistry, submit: (candidate: ReviewAnswerCandidate) => void | Promise<void>) {
  registry.register({
    id: 'review.answer_submit',
    piName: 'review_answer_submit',
    version: '1.0.0',
    label: '提交评审问答答案',
    risk: 'internal_write',
    idempotent: false,
    timeoutMs: 30_000,
    description: '提交 review-qa/v1。答案必须基于固定 ReviewRun；citations 只能填写固定上下文允许的 E-* Evidence ID。',
    parameters: Type.Object({
      answer: Type.String({ minLength: 1, maxLength: 12_000 }),
      citations: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 50 }),
      limitations: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 20 }),
    }, { additionalProperties: false }),
  }, async request => {
    await submit(structuredClone(request.arguments) as ReviewAnswerCandidate)
    return { data: { accepted: true, status: 'candidate_received' }, terminate: true }
  })
}
