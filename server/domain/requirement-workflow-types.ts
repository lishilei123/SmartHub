import type { AgentExecutionRecord } from './types.js'

export type RequirementWorkflowStage = 'analysis' | 'repair' | 'verification' | 'release'

export interface RequirementRepairCandidate {
  schemaVersion: 'requirement-repair/v1'
  summary: string
  patches: Array<{
    assetVersionId: string
    before: string
    after: string
    reason: string
    findingRefs: string[]
  }>
}

export interface RequirementRepairDraft {
  id: string
  sourceRunId: string
  status: 'generated' | 'approved' | 'applying' | 'applied' | 'verification_running' | 'verified' | 'failed'
  candidate: RequirementRepairCandidate
  generationExecution: AgentExecutionRecord
  createdAt: string
  createdBy: string
  approvedAt?: string
  approvedBy?: string
  approvalComment?: string
  application?: {
    items: Array<{
      assetId: string
      sourceAssetVersionId: string
      targetAssetVersionId: string
      taskId?: string
      logicalPath: string
      contentSha256: string
    }>
    startedAt: string
    appliedAt?: string
    verificationRunId?: string
  }
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
  sourceRunId?: string
  repairDraftId?: string
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
  repairDrafts?: RequirementRepairDraft[]
  verificationOf?: { sourceRunId: string; repairDraftId: string }
  release?: RequirementReleasePackage
}
