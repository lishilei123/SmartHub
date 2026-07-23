const apiBase = 'http://127.0.0.1:8787/api'

export type ReviewFindingType = 'missing_requirement' | 'ambiguity' | 'conflict' | 'boundary_gap' | 'state_gap' | 'exception_gap' | 'security_risk' | 'testability_gap' | 'dependency_risk' | 'other'
export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export type OverallAssessment = 'pass' | 'pass_with_notes' | 'needs_revision' | 'blocked'

export type ReviewEvidence = {
  clientEvidenceId: string
  sourceType: 'knowledge_chunk'
  sourceRef: { chunkId: string; assetVersionId: string }
  quote: string
  locator: { heading: string; start: number; end: number }
}

export type ReviewFinding = {
  clientFindingId: string
  type: ReviewFindingType
  severity: ReviewSeverity
  confidence: number
  title: string
  description: string
  impact: string
  recommendation: string
  evidenceRefs: string[]
}

export type RequirementAnalysisResult = {
  summary: {
    overallAssessment: OverallAssessment
    score: number
    strengths: string[]
    risks: string[]
  }
  findings: ReviewFinding[]
  evidence: ReviewEvidence[]
  coverage: {
    reviewedAreas: string[]
    notReviewedAreas: string[]
    limitations: string[]
  }
}

export type RequirementAnalysisResponse = {
  runId: string
  status: 'candidate_validated'
  snapshot: {
    projectId: string
    projectName: string
    knowledgeBaseId: string
    assetId: string
    assetVersionId: string
    assetContentHash: string
    indexVersionId: string
    logicalPath: string
    focusAreas: string[]
    excludedAreas: string[]
    createdAt: string
    agentDefinition: {
      agentKey: string
      version: string
      promptVersion: string
      toolsetVersion: string
      resultSchemaVersion: string
    }
  }
  result: RequirementAnalysisResult
  execution: {
    turns: number
    toolCalls: number
    framework: string
    events: { type?: string; stage?: string; message?: string; createdAt?: string }[]
  }
}

export async function runRequirementAnalysis(input: { assetVersionId: string; sourceId: string; modelId: string; focusAreas?: string[]; excludedAreas?: string[] }, signal?: AbortSignal) {
  const response = await fetch(`${apiBase}/requirement-analysis/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  })
  const body = await response.json() as RequirementAnalysisResponse | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : '需求评审运行失败')
  return body as RequirementAnalysisResponse
}
