import type { AgentExecutionRecord } from './types.js'
import type { PlanningClarification } from './review-types.js'

export type RequirementWorkflowStage = 'analysis' | 'clarification' | 'release'

export interface RequirementAutomaticTransitionState {
  status: 'pending' | 'running' | 'succeeded' | 'failed'
  testDesignId?: string
  testDesignRunId?: string
  startedAt?: string
  finishedAt?: string
  error?: string
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
  status: 'published'
  projectVersionId: string
  verificationRunId: string
  sourceAssetVersionIds: string[]
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
  automaticTransition?: RequirementAutomaticTransitionState
  release?: RequirementReleasePackage
}
