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
    projectVersionId: string
    projectVersionName: string
    knowledgeBaseId: string
    assetId: string
    assetVersionId: string
    assetContentHash: string
    indexVersionId: string
    logicalPath: string
    modelRef: { sourceId: string; modelId: string; providerType: string; modelName: string; contextWindow: number; maxOutputTokens: number }
    focusAreas: string[]
    excludedAreas: string[]
    createdAt: string
    agentDefinition: {
      agentKey: string
      version: string
      promptRef: { promptKey: string; version: string; contentSha256: string }
      toolsetVersion: string
      toolsetContentSha256: string
      skillBindings: { skillKey: string; version: string; enabled: boolean; configurationHash: string }[]
      mcpBindings: { serverKey: string; version: string; enabled: boolean; toolIds: string[]; policyHash: string }[]
      resultSchemaVersion: string
    }
  }
  result: RequirementAnalysisResult
  execution: {
    turns: number
    toolCalls: number
    framework: { name: string; version: string }
    events: { type?: string; stage?: string; message?: string; createdAt?: string }[]
  }
}

export type RequirementReviewRun = {
  id: string
  projectVersionId: string
  assetId: string
  assetVersionId: string
  documentTitle: string
  documentVersion: string
  logicalPath: string
  modelLabel: string
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  step: string
  progress: number
  createdAt: string
  startedAt: string
  finishedAt?: string
  error?: string
  snapshot?: RequirementAnalysisResponse['snapshot']
  response?: RequirementAnalysisResponse
}

export type RequirementReviewRunPage = {
  items: RequirementReviewRun[]
  nextCursor?: string
}

export type ReviewQuestionQuote = { text: string; assetVersionId: string; heading: string; startLine?: number; endLine?: number; findingId?: string }
export type ReviewQuestionResponse = {
  id: string
  runId: string
  question: string
  answer: string
  citations: string[]
  limitations: string[]
  quote?: ReviewQuestionQuote
  modelLabel: string
  createdAt: string
}

export async function startRequirementAnalysis(projectVersionId: string, input: { assetVersionId: string; sourceId: string; modelId: string; focusAreas?: string[]; excludedAreas?: string[] }, signal?: AbortSignal) {
  const response = await fetch(`${apiBase}/project-versions/${encodeURIComponent(projectVersionId)}/requirement-reviews/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  })
  const body = await response.json() as RequirementReviewRun | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : '需求评审运行失败')
  return body as RequirementReviewRun
}

export async function loadRequirementReviewRuns(projectVersionId: string, options: { limit?: number; cursor?: string; runningOnly?: boolean } = {}) {
  const query = new URLSearchParams()
  if (options.limit) query.set('limit', String(options.limit))
  if (options.cursor) query.set('cursor', options.cursor)
  if (options.runningOnly) query.set('runningOnly', 'true')
  const suffix = query.size ? `?${query}` : ''
  const response = await fetch(`${apiBase}/project-versions/${encodeURIComponent(projectVersionId)}/requirement-review-runs${suffix}`)
  const body = await response.json() as RequirementReviewRunPage | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : '需求评审历史读取失败')
  return body as RequirementReviewRunPage
}

export async function loadRequirementReviewRun(runId: string) {
  const response = await fetch(`${apiBase}/requirement-review-runs/${encodeURIComponent(runId)}`)
  const body = await response.json() as RequirementReviewRun | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : '需求评审运行读取失败')
  return body as RequirementReviewRun
}

export async function cancelRequirementReviewRun(runId: string) {
  const response = await fetch(`${apiBase}/requirement-review-runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
  const body = await response.json() as RequirementReviewRun | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : '需求评审取消失败')
  return body as RequirementReviewRun
}

export async function askRequirementReviewQuestion(runId: string, input: { question: string; quote?: ReviewQuestionQuote }, signal?: AbortSignal) {
  const response = await fetch(`${apiBase}/requirement-review-runs/${encodeURIComponent(runId)}/questions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  })
  const body = await response.json() as ReviewQuestionResponse | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : '评审问答失败')
  return body as ReviewQuestionResponse
}
