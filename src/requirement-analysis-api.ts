const apiBase = 'http://127.0.0.1:8787/api'

export type ReviewFindingType = 'missing_requirement' | 'ambiguity' | 'conflict' | 'boundary_gap' | 'state_gap' | 'exception_gap' | 'security_risk' | 'testability_gap' | 'dependency_risk' | 'other'
export type ReviewSeverity = 'blocker' | 'high' | 'medium' | 'low'
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

export type RequirementPointExtractionResult = Pick<RequirementAnalysisResult, 'requirementPoints' | 'evidence' | 'coverage'>

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
  agentKey?: 'requirement-point-extraction' | 'requirement-review' | 'review-qa' | 'requirement-analysis'
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

export type ReviewRunExecutionAttempt = {
  attempt: number
  maxAttempts: number
  activeAgentKey?: 'requirement-point-extraction' | 'requirement-review'
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  startedAt: string
  finishedAt?: string
  modelLabel: string
  error?: string
  executions: AgentExecutions
}

export type InputDeliveryManifest = {
  policyVersion: string
  mode: 'full_context' | 'segmented_context' | 'agent_directory'
  packageSha256: string
  entries: Array<{ batchId: string; ordinal: number; assetVersionIds: string[]; chunkIds: string[]; contentSha256: string; tokenCount: number; modelCallSequence: number }>
  toolReads?: Array<{ toolCallId: string; toolId: 'workspace.read_file'; relativePath: string; assetVersionIds: string[]; chunkIds: string[]; startLine: number; endLine: number }>
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
    assets: { assetId: string; assetVersionId: string; assetContentHash: string; logicalPath: string; displayName: string; assetType?: string }[]
    documentWorkspace?: { mode: 'agent_directory'; logicalPath: string; rootLogicalPath?: string; activeBranchLogicalPath?: string; branchLogicalPaths?: string[]; agentLogicalPath?: string; layoutVersion?: 'workspace/v1'; candidateAssetVersionIds: string[] }
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
      mode: 'full_context' | 'segmented_context' | 'agent_directory'
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
  reviewId: string
  retryOfRunId?: string
  retryMode?: 'full' | 'review_only'
  reusedExtractionFromRunId?: string
  hasFrozenExtraction: boolean
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
  queue?: {
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
    attempts: number
    maxAttempts: number
    availableAt: string
    error?: string
  }
  retryEvents?: Array<{ attempt: number; maxAttempts: number; agentKey?: 'requirement-point-extraction' | 'requirement-review'; status: 'scheduled' | 'exhausted'; error: string; occurredAt: string; nextAttemptAt?: string }>
  createdAt: string
  startedAt: string
  finishedAt?: string
  error?: string
  modelRouteAttempts?: Array<{ id: string; agentKey: 'requirement-point-extraction' | 'requirement-review'; sourceId: string; modelId: string; modelLabel: string; status: 'running' | 'succeeded' | 'failed' | 'cancelled'; startedAt: string; finishedAt?: string; error?: string }>
  degradations?: Array<{ agentKey: 'requirement-point-extraction' | 'requirement-review'; fromSourceId: string; fromModelId: string; toSourceId: string; toModelId: string; reason: string; occurredAt: string }>
  snapshot?: RequirementAnalysisResponse['snapshot']
  execution?: AgentExecutionRecord
  executions?: AgentExecutions
  executionAttempts?: ReviewRunExecutionAttempt[]
  inputDeliveryManifest?: InputDeliveryManifest
  extractionResult?: RequirementPointExtractionResult
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
  execution: AgentExecutionRecord
  agentConfigurationRef?: { id: string; version: number; contentSha256: string }
  createdAt: string
}

export type FindingState = 'open' | 'confirmed' | 'dismissed' | 'resolved' | 'needs_follow_up'
export type FindingActionType = 'confirm' | 'dismiss' | 'resolve' | 'request_follow_up' | 'reopen'
export type FindingActionsResponse = {
  runId: string
  projectVersionId: string
  findings: Array<{ findingId: string; state: FindingState; version: number; lastActionAt?: string }>
  actions: Array<{ id: string; findingId: string; action: FindingActionType; fromState: FindingState; toState: FindingState; comment?: string; actorDisplayName: string; version: number; createdAt: string }>
}

export type ReviewQuestionHistory = {
  runId: string
  projectVersionId: string
  session: { id: string; createdAt: string; createdBy: string } | null
  turns: Array<{
    id: string
    question: string
    quote?: ReviewQuestionQuote
    answer?: string
    citations: string[]
    limitations: string[]
    status: 'succeeded' | 'failed' | 'cancelled'
    modelRef?: { sourceId: string; modelId: string; label: string }
    agentConfigurationRef?: { id: string; version: number; contentSha256: string }
    execution?: AgentExecutionRecord
    error?: string
    createdBy: string
    createdAt: string
    finishedAt: string
  }>
}
export type ToolApproval = { id: string; runId: string; toolId: string; toolVersion: string; risk: 'write_reversible' | 'write_high_risk'; parameterSummary: string; parameterHash: string; status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled'; requestedAt: string; expiresAt: string; decidedAt?: string; decidedByDisplayName?: string; decisionComment?: string; consumedAt?: string }

export async function startRequirementAnalysis(projectVersionId: string, input: { documentDirectoryPath: string; focusAreas?: string[]; excludedAreas?: string[] }, signal?: AbortSignal) {
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

export async function retryRequirementReviewRun(runId: string, mode: 'full' | 'review_only') {
  const response = await fetch(`${apiBase}/requirement-review-runs/${encodeURIComponent(runId)}/retry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  })
  const body = await response.json() as RequirementReviewRun | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : '需求评审重跑失败')
  return body as RequirementReviewRun
}

export async function askRequirementReviewQuestion(runId: string, input: { question: string; quote?: ReviewQuestionQuote }, signal?: AbortSignal, onEvent?: (event: AgentExecutionEvent) => void) {
  const response = await fetch(`${apiBase}/requirement-review-runs/${encodeURIComponent(runId)}/questions${onEvent ? '?stream=true' : ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  })
  if (!onEvent) {
    const body = await response.json() as ReviewQuestionResponse | { error?: string }
    if (!response.ok) throw new Error('error' in body && body.error ? body.error : '评审问答失败')
    return body as ReviewQuestionResponse
  }
  if (!response.ok || !response.body) throw new Error('评审问答流式连接失败')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: ReviewQuestionResponse | undefined
  const consume = (line: string) => {
    if (!line.trim()) return
    const item = JSON.parse(line) as { type: 'event'; event: AgentExecutionEvent } | { type: 'result'; result: ReviewQuestionResponse } | { type: 'error'; error: string }
    if (item.type === 'event') onEvent(item.event)
    else if (item.type === 'result') result = item.result
    else throw new Error(item.error || '评审问答失败')
  }
  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) consume(line)
    if (done) break
  }
  consume(buffer)
  if (!result) throw new Error('评审问答未返回最终答案')
  return result
}

export async function loadFindingActions(runId: string) {
  const response = await fetch(`${apiBase}/requirement-review-runs/${encodeURIComponent(runId)}/finding-actions`)
  const body = await response.json() as FindingActionsResponse | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : 'Finding 处置历史读取失败')
  return body as FindingActionsResponse
}

export async function createFindingAction(runId: string, findingId: string, input: { action: FindingActionType; comment?: string; expectedVersion: number }) {
  const response = await fetch(`${apiBase}/requirement-review-runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(findingId)}/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  const body = await response.json() as FindingActionsResponse['actions'][number] | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : 'Finding 处置保存失败')
  return body as FindingActionsResponse['actions'][number]
}

export async function loadReviewQuestionHistory(runId: string) {
  const response = await fetch(`${apiBase}/requirement-review-runs/${encodeURIComponent(runId)}/questions`)
  const body = await response.json() as ReviewQuestionHistory | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : '评审问答历史读取失败')
  return body as ReviewQuestionHistory
}

export async function downloadRequirementReviewReport(projectVersionId: string, runId: string) {
  const response = await fetch(`${apiBase}/project-versions/${encodeURIComponent(projectVersionId)}/requirement-review-runs/${encodeURIComponent(runId)}/report.md`)
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error || '评审报告导出失败')
  }
  return response.blob()
}

export async function loadToolApprovals(runId: string) {
  const response = await fetch(`${apiBase}/requirement-review-runs/${encodeURIComponent(runId)}/approvals`)
  const body = await response.json() as ToolApproval[] | { error?: string }
  if (!response.ok) throw new Error(!Array.isArray(body) && body.error ? body.error : '工具审批记录读取失败')
  return body as ToolApproval[]
}

export async function decideToolApproval(approvalId: string, decision: 'approved' | 'rejected', comment?: string) {
  const response = await fetch(`${apiBase}/tool-approvals/${encodeURIComponent(approvalId)}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision, comment }) })
  const body = await response.json() as ToolApproval | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : '工具审批失败')
  return body as ToolApproval
}
