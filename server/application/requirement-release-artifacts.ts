import type { RequirementReleaseArtifact, RequirementReleaseContent } from '../domain/requirement-workflow-types.js'
import type { ReviewRun } from '../domain/types.js'
import { canonicalSha256 } from './canonical-json.js'

/**
 * Builds the immutable Release content and its single human-readable projection.
 * The Markdown artifact is deliberately excluded from the authoritative content hash.
 */
export function buildRequirementRelease(input: {
  verificationRun: ReviewRun
}): { content: RequirementReleaseContent; contentSha256: string; artifacts: RequirementReleaseArtifact[] } {
  const result = required(input.verificationRun.result, '复验结果不存在')
  const content: RequirementReleaseContent = structuredClone({
    requirements: result.requirementPoints,
    evidence: result.evidence,
    clarifications: result.clarifications,
    testFocus: result.testFocus,
  })
  const report = required(result.artifacts.find(item => item.fileName === 'requirement-analysis.md'), '需求分析报告不存在')
  return {
    content,
    contentSha256: canonicalSha256(content),
    artifacts: [{ ...structuredClone(report), fileName: 'requirement-analysis.md', mediaType: 'text/markdown' }],
  }
}

function required<T>(value: T | undefined | null, message: string): T {
  if (value == null) throw new Error(message)
  return value
}
