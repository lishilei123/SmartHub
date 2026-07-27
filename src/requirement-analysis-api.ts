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

export type RequirementPoint = {
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

export type ReviewFinding = {
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

export type RequirementAnalysisResult = {
  summary: {
    overallAssessment: OverallAssessment
    score: number
    strengths: string[]
    risks: string[]
  }
  requirementPoints: RequirementPoint[]
  findings: ReviewFinding[]
  evidence: ReviewEvidence[]
  coverage: {
    assets: Array<{
      assetVersionId: string
      deliveredChunkIds: string[]
      excludedChunks: Array<{ chunkId: string; reason: string }>
    }>
    limitations: string[]
  }
}

export type AgentExecutionEvent = {
  sequence: number
  type: string
  occurredAt: string
  turn?: number
  toolId?: string
  toolCallId?: string
  isError?: boolean
  role?: 'user' | 'assistant' | 'tool'
  content?: string
  toolCalls?: { id: string; name: string }[]
  toolArguments?: unknown
  toolResult?: unknown
  stopReason?: string
  model?: string
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }
  framework?: { name: string; version: string }
}

export type AgentExecutionRecord = {
  agentKey?: 'requirement-point-extraction' | 'requirement-review' | 'requirement-analysis'
  turns: number
  toolCalls: number
  toolErrors?: number
  framework?: { name: string; version: string }
  events: AgentExecutionEvent[]
}

export type AgentDefinitionSnapshot = {
  agentKey: string
  version: string
  promptRef: { promptKey: string; version: string; contentSha256: string }
  toolsetVersion: string
  toolsetContentSha256: string
  skillBindings: { skillKey: string; version: string; enabled: boolean; configurationHash: string }[]
  mcpBindings: { serverKey: string; version: string; enabled: boolean; toolIds: string[]; policyHash: string }[]
  resultSchemaVersion: string
}

export type AgentExecutions = {
  requirementPointExtraction?: AgentExecutionRecord
  requirementReview?: AgentExecutionRecord
}

export type InputDeliveryManifest = {
  policyVersion: string
  mode: 'full_context' | 'segmented_context'
  packageSha256: string
  entries: Array<{ batchId: string; ordinal: number; assetVersionIds: string[]; chunkIds: string[]; contentSha256: string; tokenCount: number; modelCallSequence: number }>
  finalMergeCompleted: boolean
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
    assets: { assetId: string; assetVersionId: string; assetContentHash: string; logicalPath: string; displayName: string }[]
    modelRef: { sourceId: string; modelId: string; providerType: string; modelName: string; contextWindow: number; maxOutputTokens: number; supportsReasoning: boolean }
    agentModelRefs?: {
      requirementPointExtraction: { sourceId: string; modelId: string; providerType: string; modelName: string; contextWindow: number; maxOutputTokens: number; supportsReasoning: boolean }
      requirementReview: { sourceId: string; modelId: string; providerType: string; modelName: string; contextWindow: number; maxOutputTokens: number; supportsReasoning: boolean }
    }
    agentConfigurationRef?: { id: string; version: number; contentSha256: string }
    agentConfigurationRefs?: {
      requirementPointExtraction: { id: string; version: number; contentSha256: string }
      requirementReview: { id: string; version: number; contentSha256: string }
    }
    focusAreas: string[]
    excludedAreas: string[]
    extractionInput: {
      policyVersion: string
      mode: 'full_context' | 'segmented_context'
      estimatedInputTokens: number
      safeInputBudget: number
      packageSha256: string
      batches: Array<{ batchId: string; ordinal: number; tokenCount: number; contentSha256: string; assetVersionIds: string[]; chunkIds: string[] }>
    }
    createdAt: string
    agentDefinition: AgentDefinitionSnapshot
    agentDefinitions?: {
      requirementPointExtraction: AgentDefinitionSnapshot
      requirementReview: AgentDefinitionSnapshot
    }
  }
  result: RequirementAnalysisResult
  execution?: AgentExecutionRecord
  executions?: AgentExecutions
  inputDeliveryManifest?: InputDeliveryManifest
}

export type RequirementReviewRun = {
  id: string
  projectVersionId: string
  assetId: string
  assetVersionId: string
  assetIds: string[]
  assetVersionIds: string[]
  documents: { assetId: string; assetVersionId: string; assetContentHash: string; logicalPath: string; displayName: string }[]
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
  execution?: AgentExecutionRecord
  executions?: AgentExecutions
  inputDeliveryManifest?: InputDeliveryManifest
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

export async function startRequirementAnalysis(projectVersionId: string, input: { assetVersionIds: string[]; focusAreas?: string[]; excludedAreas?: string[] }, signal?: AbortSignal) {
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
