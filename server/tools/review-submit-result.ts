import { Type } from 'typebox'
import type { CandidateRequirementReviewV3 } from '../domain/review-types.js'
import type { ToolRegistry } from './registry.js'
import type { ReviewSubmissionFeedback } from './submission-feedback.js'

export function registerReviewSubmitResultTool(registry: ToolRegistry, submit: (candidate: CandidateRequirementReviewV3) => ReviewSubmissionFeedback | Promise<ReviewSubmissionFeedback>) {
  registry.register({
    id: 'review.submit_result', piName: 'review_submit_result', version: '4.0.0', label: '提交需求点对应分析', risk: 'internal_write', idempotent: false, timeoutMs: 30_000,
    description: '提交 requirement-review/v3。每条分析只需关联一个冻结需求点；模型给出标题、类型、严重度、置信度、影响、建议和总体摘要，服务端生成 Finding ID 并完成引用结构。',
    parameters: requirementReviewSchemaV3(),
  }, async request => {
    const feedback = await submit(structuredClone(request.arguments) as CandidateRequirementReviewV3)
    return feedback.accepted
      ? { data: { accepted: true, status: 'candidate_validated' }, terminate: true }
      : { data: { accepted: false, status: 'validation_failed', issues: feedback.issues?.slice(0, 20) ?? [] }, terminate: false }
  })
}

function requirementReviewSchemaV3() {
  const strings = Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), { maxItems: 100 })
  return Type.Object({
    summary: Type.Optional(Type.Object({
      overallAssessment: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: '建议使用 pass、pass_with_notes、needs_revision 或 blocked。' })),
      score: Type.Optional(Type.Number()),
      strengths: Type.Optional(strings),
      risks: Type.Optional(strings),
    }, { additionalProperties: false })),
    analyses: Type.Array(Type.Object({
      requirementPointRef: Type.String({ minLength: 1, maxLength: 100, description: '必须是输入中存在的 RP-* 需求点 ID。' }),
      analysis: Type.String({ minLength: 1, maxLength: 8000 }),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
      type: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      severity: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      confidence: Type.Optional(Type.Number()),
      impact: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
      recommendation: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
    }, { additionalProperties: false }), { maxItems: 100 }),
  }, { additionalProperties: false })
}
