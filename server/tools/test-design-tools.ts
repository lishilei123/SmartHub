import type { ReviewSubmissionFeedback } from './submission-feedback.js'
import { defaultBuiltInToolConfigResolver } from './built-in-tool-config.js'
import { ToolRegistry } from './registry.js'

export function createTestDesignToolRegistry(toolId: string, schemaVersion: string, submit: (candidate: Record<string, unknown>) => ReviewSubmissionFeedback | Promise<ReviewSubmissionFeedback>) {
  const registry = new ToolRegistry()
  registry.register(defaultBuiltInToolConfigResolver.toDescriptor(toolId), async request => {
    const candidate = structuredClone(request.arguments) as Record<string, unknown>
    const feedback = candidate.schemaVersion === schemaVersion
      ? await submit(candidate)
      : { accepted: false, issues: [{ path: '/schemaVersion', message: `必须为 ${schemaVersion}` }] }
    return feedback.accepted
      ? { data: { accepted: true, status: 'candidate_validated' }, terminate: true }
      : { data: { accepted: false, status: 'validation_failed', issues: feedback.issues?.slice(0, 20) ?? [] } }
  })
  return registry
}
