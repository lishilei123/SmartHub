import type { AgentDefinitionVersion, AgentExecutionEvent, AgentModelConnection, InputDeliveryManifest, RequirementInputPlan } from './agent-types.js'
import type { AgentExecutionRecord, FindingActionType, FindingState } from './types.js'
import type { ReviewSeverity } from './review-types.js'

export type TechnicalFindingType =
  | 'requirement_coverage_gap'
  | 'architecture_gap'
  | 'interface_gap'
  | 'data_gap'
  | 'exception_gap'
  | 'non_functional_gap'
  | 'conflict'
  | 'risk'
  | 'other'

export type CoverageStatus = 'covered' | 'partially_covered' | 'not_covered' | 'needs_confirmation'
export type TechnicalRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface FrozenRequirementEvidence {
  evidenceId: string
  requirementPointId: string
  assetId: string
  assetVersionId: string
  chunkId: string
  contentSha256: string
  headingPath: string[]
  quote: string
  startLine: number
  endLine: number
}

export interface FrozenRequirementPoint {
  id: string
  title: string
  description: string
  evidenceIds: string[]
}

export interface FrozenRequirementFinding {
  id: string
  type: string
  severity: ReviewSeverity
  title: string
  description: string
  impact: string
  recommendation: string
  requirementPointIds: string[]
  state: FindingState
}

export interface TechnicalSolutionReviewCandidateV1 {
  schemaVersion: 'technical-solution-review/v1'
  summary: {
    overallAssessment: 'pass' | 'pass_with_notes' | 'needs_revision' | 'blocked'
    overview: string
    majorGaps: string[]
    majorRisks: string[]
    recommendedOrder: string[]
  }
  coverageCandidates: Array<{
    requirementSourceTexts: string[]
    status: CoverageStatus
    analysis: string
    solutionSourceTexts: string[]
  }>
  findings: Array<{
    type: TechnicalFindingType
    severity: ReviewSeverity
    title: string
    problem: string
    impact: string
    recommendation: string
    confidence: number
    requirementSourceTexts: string[]
    solutionSourceTexts: string[]
  }>
  risks: Array<{
    description: string
    impact: string
    mitigation: string
    requirementSourceTexts: string[]
    solutionSourceTexts: string[]
  }>
  questions: Array<{
    question: string
    reason: string
    requirementSourceTexts: string[]
    solutionSourceTexts: string[]
  }>
}

export interface TechnicalSolutionEvidence {
  id: string
  sourceKind: 'requirement' | 'technical_design'
  assetId: string
  assetVersionId: string
  chunkId: string
  contentSha256: string
  headingPath: string[]
  quote: string
  startLine: number
  endLine: number
}

export interface TechnicalSolutionFormalResult {
  schemaVersion: 'technical-solution-review-result/v1'
  summary: TechnicalSolutionReviewCandidateV1['summary']
  coverage: Array<{
    id: string
    requirementPointId: string
    requirementTitle: string
    status: CoverageStatus
    analysis: string
    evidenceIds: string[]
  }>
  findings: Array<{
    id: string
    type: TechnicalFindingType
    severity: ReviewSeverity
    title: string
    problem: string
    impact: string
    recommendation: string
    confidence: number
    requirementPointIds: string[]
    evidenceIds: string[]
  }>
  evidence: TechnicalSolutionEvidence[]
  risks: Array<{ id: string; description: string; impact: string; mitigation: string; evidenceIds: string[] }>
  questions: Array<{ id: string; question: string; reason: string; evidenceIds: string[] }>
  statistics: {
    totalRequirements: number
    covered: number
    partiallyCovered: number
    notCovered: number
    needsConfirmation: number
    coverageRatio: number
  }
}

export interface TechnicalSolutionRunSnapshot {
  schemaVersion: 'technical-solution-run-snapshot/v1'
  runId: string
  technicalReviewId: string
  projectId: string
  projectName: string
  projectVersionId: string
  projectVersionName: string
  knowledgeBaseId: string
  requirementBaseline: {
    sourceReviewRunId: string
    sourceResultSha256: string
    snapshotSha256: string
    requirementPoints: FrozenRequirementPoint[]
    evidence: FrozenRequirementEvidence[]
    findings: FrozenRequirementFinding[]
  }
  solutionInputs: Array<{
    assetId: string
    assetVersionId: string
    assetType: 'technical_design'
    displayName: string
    logicalPath: string
    contentSha256: string
  }>
  assets: Array<{ assetId: string; assetVersionId: string; assetContentHash: string; logicalPath: string; displayName: string }>
  indexVersionId: string
  modelRef: Omit<AgentModelConnection, 'baseUrl' | 'apiKey' | 'temperature' | 'requestTimeoutMs' | 'retryCount'>
  modelRoute?: Array<Omit<AgentModelConnection, 'baseUrl' | 'apiKey' | 'temperature' | 'requestTimeoutMs' | 'retryCount'>>
  agentConfigurationRef?: { id: string; version: number; contentSha256: string }
  agentDefinition: AgentDefinitionVersion
  inputPlan: RequirementInputPlan
  createdAt: string
}

export interface TechnicalSolutionReview {
  id: string
  projectVersionId: string
  name: string
  sourceReviewRunId: string
  solutionAssetVersionIds: string[]
  inputSetSha256: string
  createdBy: string
  createdAt: string
}

export interface TechnicalSolutionReviewRun {
  id: string
  technicalReviewId: string
  projectVersionId: string
  sourceReviewRunId: string
  status: TechnicalRunStatus
  step: string
  progress: number
  snapshotSha256: string
  snapshot: TechnicalSolutionRunSnapshot
  modelLabel: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  errorCode?: string
  error?: string
  failedAtStep?: string
  result?: TechnicalSolutionFormalResult
  inputDeliveryManifest?: InputDeliveryManifest
  execution?: AgentExecutionRecord
  events?: AgentExecutionEvent[]
  modelRouteAttempts?: Array<{ id: string; attempt: number; sourceId: string; modelId: string; modelLabel: string; status: 'running' | 'succeeded' | 'failed' | 'cancelled'; startedAt: string; finishedAt?: string; error?: string }>
  degradations?: Array<{ fromSourceId: string; fromModelId: string; toSourceId: string; toModelId: string; reason: string; occurredAt: string }>
  queue?: { status: TechnicalRunStatus; attempts: number; maxAttempts: number; availableAt: string }
}

export interface TechnicalSolutionFindingAction {
  id: string
  projectVersionId: string
  technicalReviewId: string
  runId: string
  findingId: string
  action: FindingActionType
  fromState: FindingState
  toState: FindingState
  comment?: string
  actorId: string
  actorDisplayName: string
  version: number
  createdAt: string
}

export interface TechnicalSolutionReviewJob {
  id: string
  runId: string
  technicalReviewId: string
  projectVersionId: string
  status: TechnicalRunStatus
  attempts: number
  maxAttempts: number
  availableAt: string
  createdAt: string
  updatedAt: string
  leaseOwner?: string
  runToken?: string
  leaseExpiresAt?: string
  heartbeatAt?: string
  cancelRequestedAt?: string
  startedAt?: string
  finishedAt?: string
  error?: string
}
