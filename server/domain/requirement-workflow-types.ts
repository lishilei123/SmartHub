import type { AgentExecutionRecord } from './types.js'
import type { CandidateEvidence, CandidateRequirementPoint, PlanningClarification } from './review-types.js'

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
  fileName: 'requirement-analysis.md'
  mediaType: 'text/markdown'
  content: string
  contentSha256: string
}

/** Immutable, authoritative machine-readable Requirement Release facts. */
export interface RequirementReleaseContent {
  requirements: CandidateRequirementPoint[]
  evidence: CandidateEvidence[]
  clarifications: PlanningClarification[]
  /**
   * Frozen field from already-published requirement-release/v1 records.
   * New Releases omit it and Test Design must not use it as a design input.
   */
  testFocus?: Array<{
    id: string
    title: string
    description: string
    requirementPointRefs: string[]
  }>
}

export interface RequirementReleasePackage {
  id: string
  schemaVersion: 'requirement-release/v1'
  status: 'published'
  projectVersionId: string
  verificationRunId: string
  content: RequirementReleaseContent
  /** SHA-256 of canonical JSON for content only; artifacts never participate. */
  contentSha256: string
  sourceAssetVersionIds: string[]
  generationExecution: AgentExecutionRecord
  artifacts: RequirementReleaseArtifact[]
  createdAt: string
  createdBy: string
  publishedAt: string
  publishedBy: string
}

export interface RequirementWorkflowState {
  currentStage: RequirementWorkflowStage
  automaticTransition?: RequirementAutomaticTransitionState
  release?: RequirementReleasePackage
}
