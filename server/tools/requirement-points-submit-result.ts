import { Type } from 'typebox'
import type { CandidateRequirementPointExtractionV5 } from '../domain/review-types.js'
import type { ToolRegistry } from './registry.js'
import type { ReviewSubmissionFeedback } from './submission-feedback.js'

export function registerRequirementPointsSubmitResultTool(registry: ToolRegistry, submit: (candidate: CandidateRequirementPointExtractionV5) => ReviewSubmissionFeedback | Promise<ReviewSubmissionFeedback>) {
  registry.register({
    id: 'requirement-points.submit_result', piName: 'requirement_points_submit_result', version: '5.1.0', label: '提交需求标题、描述与原文线索', risk: 'internal_write', idempotent: false, timeoutMs: 30_000,
    description: '提交 requirement-point-extraction/v5。模型正常为每条需求点生成 title，并提交 description 和 sourceTexts；title 缺失或空白时服务端根据 description 兜底，其余结构、ID、Evidence、引用、定位和覆盖清单全部由服务端生成。',
    parameters: requirementPointExtractionSchemaV5(),
  }, async request => {
    const feedback = await submit(structuredClone(request.arguments) as CandidateRequirementPointExtractionV5)
    return feedback.accepted
      ? { data: { accepted: true, status: 'candidate_validated' }, terminate: true }
      : { data: { accepted: false, status: 'validation_failed', issues: feedback.issues?.slice(0, 20) ?? [] }, terminate: false }
  })
}

function requirementPointExtractionSchemaV5() {
  return Type.Object({
    requirementPoints: Type.Array(Type.Object({
      title: Type.Optional(Type.String({ maxLength: 1000, description: '模型生成的简洁需求点标题；缺失或空白时由服务端根据 description 兜底。' })),
      description: Type.String({ minLength: 1, maxLength: 8000, description: '可独立实现、测试或验收的原子需求描述。' }),
      sourceTexts: Type.Array(Type.String({ minLength: 4, maxLength: 4000, description: '支撑当前需求点的原文或高区分度原文线索。' }), { minItems: 1, maxItems: 20 }),
    }, { additionalProperties: false }), { maxItems: 500 }),
  }, { additionalProperties: false })
}
