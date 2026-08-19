import type { AgentExecutionRecord } from './types.js'
import type { PlanningClarification } from './review-types.js'

export type RequirementWorkflowStage = 'analysis' | 'clarification' | 'understanding' | 'release'

export interface RequirementUnderstandingSnapshot {
  id: string
  schemaVersion: 'requirement-understanding-snapshot/v1'
  projectVersionId: string
  analysisRunId: string
  sourceAssetVersionIds: string[]
  requirementPointIds: string[]
  clarifications: PlanningClarification[]
  requirementResultSha256: string
  createdAt: string
  contentSha256: string
}

export interface RequirementAutomaticTransitionState {
  status: 'pending' | 'running' | 'succeeded' | 'failed'
  testDesignId?: string
  testDesignRunId?: string
  startedAt?: string
  finishedAt?: string
  error?: string
}

export interface RequirementReleaseCandidate {
  schemaVersion: 'requirement-release-candidate/v1'
  sourceAssetVersionIds: string[]
  refinedRequirementsMarkdown: string
}

export interface RequirementReleaseArtifact {
  fileName: string
  mediaType: 'text/markdown' | 'application/json' | 'text/plain'
  content: string
  contentSha256: string
}

export interface RequirementReleasePackage {
  id: string
  schemaVersion: 'requirement-release-package/v1'
  status: 'candidate' | 'published'
  projectVersionId: string
  verificationRunId: string
  sourceAssetVersionIds: string[]
  candidate: RequirementReleaseCandidate
  generationExecution: AgentExecutionRecord
  artifacts: RequirementReleaseArtifact[]
  contentSha256: string
  createdAt: string
  createdBy: string
  publishedAt?: string
  publishedBy?: string
}

export interface RequirementWorkflowState {
  currentStage: RequirementWorkflowStage
  understandingSnapshot?: RequirementUnderstandingSnapshot
  automaticTransition?: RequirementAutomaticTransitionState
  release?: RequirementReleasePackage
}
