export type ReviewFindingType = 'missing_requirement' | 'ambiguity' | 'conflict' | 'boundary_gap' | 'state_gap' | 'exception_gap' | 'security_risk' | 'testability_gap' | 'dependency_risk' | 'other'
export type ReviewSeverity = 'blocker' | 'high' | 'medium' | 'low'
export type OverallAssessment = 'pass' | 'pass_with_notes' | 'needs_revision' | 'blocked'

export interface CandidateEvidence {
  clientEvidenceId: string
  sourceType: 'knowledge_chunk'
  sourceRef: { chunkId: string; assetVersionId: string }
  quote: string
  locator: { heading: string; start: number; end: number }
}

export interface CandidateRequirementPointEvidenceDraft {
  assetVersionId: string
  chunkId: string
  quote: string
}

export interface CandidateRequirementPoint {
  clientRequirementPointId: string
  title: string
  description: string
  actor: string
  action: string
  object: string
  conditions: string[]
  businessRules: string[]
  exceptions: string[]
  acceptanceCriteria: string[]
  evidenceRefs: string[]
  mergeGroupId?: string
  mergeRationale?: string
}

export interface CandidateFinding {
  clientFindingId: string
  type: ReviewFindingType
  severity: ReviewSeverity
  confidence: number
  title: string
  description: string
  impact: string
  recommendation: string
  requirementPointRefs: string[]
}

export interface AssetCoverage {
  assetVersionId: string
  deliveredChunkIds: string[]
  excludedChunks: Array<{ chunkId: string; reason: string }>
}

export interface ReviewCoverage {
  assets: AssetCoverage[]
  limitations: string[]
}

export interface CandidateRequirementPointExtraction {
  requirementPoints: CandidateRequirementPoint[]
  evidence: CandidateEvidence[]
  coverage: ReviewCoverage
}

export interface CandidateRequirementPointDraft {
  title?: string
  description: string
  actor: string
  action: string
  object: string
  conditions: string[]
  businessRules: string[]
  exceptions: string[]
  acceptanceCriteria: string[]
  evidenceDrafts: CandidateRequirementPointEvidenceDraft[]
  mergeGroupId?: string
  mergeRationale?: string
}

export interface CandidateRequirementPointExtractionV3 {
  requirementPoints: CandidateRequirementPointDraft[]
}

export interface CandidateRequirementPointSourceDraft extends Omit<CandidateRequirementPointDraft, 'evidenceDrafts'> {
  sourceTexts: string[]
}

export interface CandidateRequirementPointExtractionV4 {
  requirementPoints: CandidateRequirementPointSourceDraft[]
}

export interface CandidateRequirementPointExtractionV5 {
  requirementPoints: Array<{
    title?: string
    description: string
    sourceTexts: string[]
  }>
}

export interface CandidateRequirementReview {
  summary: {
    overallAssessment: OverallAssessment
    score: number
    strengths: string[]
    risks: string[]
  }
  findings: CandidateFinding[]
}

export interface CandidateRequirementReviewV3 {
  summary?: {
    overallAssessment?: OverallAssessment
    score?: number
    strengths?: string[]
    risks?: string[]
  }
  analyses: Array<{
    requirementPointRef: string
    analysis: string
    title?: string
    type?: ReviewFindingType
    severity?: ReviewSeverity
    confidence?: number
    impact?: string
    recommendation?: string
  }>
}

export interface CandidateReviewResult extends CandidateRequirementPointExtraction, CandidateRequirementReview {
}

export type AgentCandidateResult = CandidateRequirementPointExtraction | CandidateRequirementPointExtractionV3 | CandidateRequirementPointExtractionV4 | CandidateRequirementPointExtractionV5 | CandidateRequirementReview | CandidateRequirementReviewV3 | import('./technical-solution-types.js').TechnicalSolutionExtractionResult | import('./technical-solution-types.js').TechnicalSolutionFormalResult

export interface ValidationIssue { path: string; message: string }
export interface ValidationReport { valid: boolean; issues: ValidationIssue[] }
