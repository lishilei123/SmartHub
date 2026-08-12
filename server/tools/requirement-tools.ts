import type { CandidateRequirementAnalysisV1 } from '../domain/review-types.js'
import type { StateStore } from '../infrastructure/store.js'
import { ToolRegistry } from './registry.js'
import { registerRequirementAnalysisSubmitResultTool } from './requirement-analysis-submit-result.js'
import { registerRequirementDocumentWorkspaceTools, type RequirementDocumentReadObservation, type RequirementDocumentWorkspace } from './requirement-document-workspace.js'
import { registerKnowledgeSearchTool } from './knowledge-search.js'
import { registerKnowledgeReadChunkTool } from './knowledge-read-chunk.js'
import type { ReviewSubmissionFeedback } from './submission-feedback.js'
import { defaultBuiltInToolConfigResolver } from './built-in-tool-config.js'
import type { AgentSkillSession } from '../agent/skill-runtime.js'
import { registerSkillActivateTool } from './skill-activate.js'

export type { ReviewSubmissionFeedback } from './submission-feedback.js'

export function createWorkspaceAgentToolRegistry(
  store: StateStore,
  submitToolId: string,
  submit: (candidate: Record<string, unknown>) => ReviewSubmissionFeedback | Promise<ReviewSubmissionFeedback>,
  onRead?: (observation: RequirementDocumentReadObservation) => void,
  documentWorkspace?: RequirementDocumentWorkspace,
  skillSession?: AgentSkillSession,
) {
  const registry = new ToolRegistry()
  if (!documentWorkspace) throw new Error('PI_DOCUMENT_WORKSPACE_REQUIRED')
  registerRequirementDocumentWorkspaceTools(registry, documentWorkspace, onRead)
  registerKnowledgeSearchTool(registry, store)
  registerKnowledgeReadChunkTool(registry, store)
  if (skillSession) registerSkillActivateTool(registry, skillSession)
  registry.register(defaultBuiltInToolConfigResolver.toDescriptor(submitToolId), async request => {
    const feedback = await submit(structuredClone(request.arguments) as Record<string, unknown>)
    return feedback.accepted
      ? { data: { accepted: true, status: 'candidate_validated' }, terminate: true }
      : { data: { accepted: false, status: 'validation_failed', issues: feedback.issues?.slice(0, 20) ?? [] }, terminate: false }
  })
  return registry
}

export function createRequirementAnalysisToolRegistry(
  store: StateStore,
  submit: (candidate: CandidateRequirementAnalysisV1) => ReviewSubmissionFeedback | Promise<ReviewSubmissionFeedback>,
  onRead?: (observation: RequirementDocumentReadObservation) => void,
  documentWorkspace?: RequirementDocumentWorkspace,
) {
  const registry = new ToolRegistry()
  if (!documentWorkspace) throw new Error('PI_DOCUMENT_WORKSPACE_REQUIRED')
  registerRequirementDocumentWorkspaceTools(registry, documentWorkspace, onRead)
  registerKnowledgeSearchTool(registry, store)
  registerKnowledgeReadChunkTool(registry, store)
  registerRequirementAnalysisSubmitResultTool(registry, submit)
  return registry
}
