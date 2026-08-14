
import type { AgentExecutionContext, PlanningSubAgentRunRecord } from './planning-api'

const apiBase = 'http://127.0.0.1:8787/api'

export type AnalysisFindingType = 'missing_requirement' | 'ambiguity' | 'conflict' | 'boundary_gap' | 'state_gap' | 'exception_gap' | 'security_risk' | 'testability_gap' | 'dependency_risk' | 'other'
export type AnalysisSeverity = 'blocker' | 'high' | 'medium' | 'low'
export type OverallAssessment = 'pass' | 'pass_with_notes' | 'needs_revision' | 'blocked'

export type AnalysisEvidence = {
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

export type AnalysisFinding = {
  clientFindingId: string
  type: AnalysisFindingType
  severity: AnalysisSeverity
  confidence: number
  title: string
  description: string
  impact: string
  recommendation: string
  requirementPointRefs: string[]
}

export type RequirementAnalysisResult = {
  summary: {
    overview: string
    businessGoals: string[]
    overallAssessment: OverallAssessment
    score: number
    strengths: string[]
    risks: string[]
  }
  requirementPoints: RequirementPoint[]
  findings: AnalysisFinding[]
  testFocus: Array<{ id: string; title: string; description: string; requirementPointRefs: string[] }>
  evidence: AnalysisEvidence[]
  coverage: {
    assets: Array<{
      assetVersionId: string
      deliveredChunkIds: string[]
      excludedChunks: Array<{ chunkId: string; reason: string }>
    }>
    limitations: string[]
  }
  analysisDocument?: string
  artifacts: Array<{ fileName: 'requirement-baseline.md' | 'requirement-analysis-findings.md' | 'requirement-analysis.md'; mediaType: 'text/markdown'; content: string; contentSha256: string }>
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
  agentKey?: 'requirement-analysis'
  turns: number
  toolCalls: number
  toolErrors?: number
  framework?: { name: string; version: string }
  workflowStage?: 'analysis' | 'repair' | 'verification' | 'release'
  context?: AgentExecutionContext
  events: AgentExecutionEvent[]
}

export type RequirementRepairDraft = {
  id: string
  sourceRunId: string
  status: 'generated' | 'approved' | 'applying' | 'applied' | 'verification_running' | 'verified' | 'failed'
  candidate: {
    schemaVersion: 'requirement-repair/v1'
    summary: string
    patches: Array<{ assetVersionId: string; before: string; after: string; reason: string; findingRefs: string[] }>
  }
  generationExecution: AgentExecutionRecord
  createdAt: string
  createdBy: string
  approvedAt?: string
  approvedBy?: string
  approvalComment?: string
  application?: { items: Array<{ assetId: string; sourceAssetVersionId: string; targetAssetVersionId: string; taskId?: string; logicalPath: string; contentSha256: string }>; startedAt: string; appliedAt?: string; verificationRunId?: string }
  error?: string
}

export type RequirementReleasePackage = {
  id: string
  schemaVersion: 'requirement-release-package/v1'
  status: 'candidate' | 'published'
  projectVersionId: string
  verificationRunId: string
  sourceRunId?: string
  repairDraftId?: string
  sourceAssetVersionIds: string[]
  candidate: { schemaVersion: 'requirement-release-candidate/v1'; sourceAssetVersionIds: string[]; refinedRequirementsMarkdown: string }
  generationExecution: AgentExecutionRecord
  artifacts: Array<{ fileName: string; mediaType: 'text/markdown' | 'application/json' | 'text/plain'; content: string; contentSha256: string }>
  contentSha256: string
  createdAt: string
  createdBy: string
  publishedAt?: string
  publishedBy?: string
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
  requirementAnalysis?: AgentExecutionRecord
}

export type RequirementAnalysisRunExecutionAttempt = {
  attempt: number
  maxAttempts: number
  activeAgentKey?: 'requirement-analysis'
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
    agentConfigurationRef?: { id: string; version: number; contentSha256: string }
    focusAreas: string[]
    excludedAreas: string[]
    analysisInput: {
      policyVersion: string
      mode: 'full_context' | 'segmented_context' | 'agent_directory'
      estimatedInputTokens: number
      safeInputBudget: number
      packageSha256: string
      batches: Array<{ batchId: string; ordinal: number; tokenCount: number; contentSha256: string; assetVersionIds: string[]; chunkIds: string[] }>
    }
    createdAt: string
    agentDefinition: AgentDefinitionSnapshot
  }
  result: RequirementAnalysisResult
  execution?: AgentExecutionRecord
  executions?: AgentExecutions
  inputDeliveryManifest?: InputDeliveryManifest
}

export type RequirementAnalysisRun = {
  id: string
  analysisId: string
  retryOfRunId?: string
  retryMode?: 'full'
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
  retryEvents?: Array<{ attempt: number; maxAttempts: number; agentKey?: 'requirement-analysis'; status: 'scheduled' | 'exhausted'; error: string; occurredAt: string; nextAttemptAt?: string }>
  createdAt: string
  startedAt: string
  finishedAt?: string
  error?: string
  modelRouteAttempts?: Array<{ id: string; agentKey: 'requirement-analysis'; sourceId: string; modelId: string; modelLabel: string; status: 'running' | 'succeeded' | 'failed' | 'cancelled'; startedAt: string; finishedAt?: string; error?: string }>
  degradations?: Array<{ agentKey: 'requirement-analysis'; fromSourceId: string; fromModelId: string; toSourceId: string; toModelId: string; reason: string; occurredAt: string }>
  snapshot?: RequirementAnalysisResponse['snapshot']
  execution?: AgentExecutionRecord
  executions?: AgentExecutions
  executionAttempts?: RequirementAnalysisRunExecutionAttempt[]
  inputDeliveryManifest?: InputDeliveryManifest
  planningSubAgentRuns?: PlanningSubAgentRunRecord[]
  workflow?: {
    currentStage: 'analysis' | 'repair' | 'verification' | 'release'
    repairDrafts?: RequirementRepairDraft[]
    verificationOf?: { sourceRunId: string; repairDraftId: string }
    release?: RequirementReleasePackage
  }
  response?: RequirementAnalysisResponse
}

export type RequirementAnalysisRunPage = {
  items: RequirementAnalysisRun[]
  nextCursor?: string
}

export type FindingState = 'open' | 'confirmed' | 'dismissed' | 'resolved' | 'needs_follow_up'
export type FindingActionType = 'confirm' | 'dismiss' | 'resolve' | 'request_follow_up' | 'reopen'
export type FindingActionsResponse = {
  runId: string
  projectVersionId: string
  findings: Array<{ findingId: string; state: FindingState; version: number; lastActionAt?: string }>
  actions: Array<{ id: string; findingId: string; action: FindingActionType; fromState: FindingState; toState: FindingState; comment?: string; actorDisplayName: string; version: number; createdAt: string }>
}

export type ToolApproval = { id: string; runId: string; toolId: string; toolVersion: string; risk: 'write_reversible' | 'write_high_risk'; parameterSummary: string; parameterHash: string; status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled'; requestedAt: string; expiresAt: string; decidedAt?: string; decidedByDisplayName?: string; decisionComment?: string; consumedAt?: string }

export async function startRequirementAnalysis(projectVersionId: string, input: { documentDirectoryPath: string; focusAreas?: string[]; excludedAreas?: string[] }, signal?: AbortSignal) {
  const response = await fetch(`${apiBase}/project-versions/${encodeURIComponent(projectVersionId)}/requirement-analysis-runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  })
  const body = await response.json() as RequirementAnalysisRun | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : '需求分析运行失败')
  return body as RequirementAnalysisRun
}

export async function loadRequirementAnalysisRuns(projectVersionId: string, options: { limit?: number; cursor?: string; runningOnly?: boolean } = {}) {
  const query = new URLSearchParams()
  if (options.limit) query.set('limit', String(options.limit))
  if (options.cursor) query.set('cursor', options.cursor)
  if (options.runningOnly) query.set('runningOnly', 'true')
  const suffix = query.size ? `?${query}` : ''
  const response = await fetch(`${apiBase}/project-versions/${encodeURIComponent(projectVersionId)}/requirement-analysis-runs${suffix}`)
  const body = await response.json() as RequirementAnalysisRunPage | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : '需求分析历史读取失败')
  return body as RequirementAnalysisRunPage
}

export async function loadRequirementAnalysisRun(runId: string) {
  const response = await fetch(`${apiBase}/requirement-analysis-runs/${encodeURIComponent(runId)}`)
  const body = await response.json() as RequirementAnalysisRun | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : '需求分析运行读取失败')
  return body as RequirementAnalysisRun
}

export async function cancelRequirementAnalysisRun(runId: string) {
  const response = await fetch(`${apiBase}/requirement-analysis-runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
  const body = await response.json() as RequirementAnalysisRun | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : '需求分析取消失败')
  return body as RequirementAnalysisRun
}

export async function retryRequirementAnalysisRun(runId: string) {
  const response = await fetch(`${apiBase}/requirement-analysis-runs/${encodeURIComponent(runId)}/retry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'full' }),
  })
  const body = await response.json() as RequirementAnalysisRun | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : '需求分析重跑失败')
  return body as RequirementAnalysisRun
}

export async function loadFindingActions(runId: string) {
  const response = await fetch(`${apiBase}/requirement-analysis-runs/${encodeURIComponent(runId)}/finding-actions`)
  const body = await response.json() as FindingActionsResponse | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : 'Finding 处置历史读取失败')
  return body as FindingActionsResponse
}

export async function createFindingAction(runId: string, findingId: string, input: { action: FindingActionType; comment?: string; expectedVersion: number }) {
  const response = await fetch(`${apiBase}/requirement-analysis-runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(findingId)}/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  const body = await response.json() as FindingActionsResponse['actions'][number] | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : 'Finding 处置保存失败')
  return body as FindingActionsResponse['actions'][number]
}

export async function generateRequirementRepairDraft(runId: string, findingIds: string[]) {
  const response = await fetch(`${apiBase}/requirement-analysis-runs/${encodeURIComponent(runId)}/repair-drafts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ findingIds }) })
  const body = await response.json() as RequirementRepairDraft | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : '需求修复草稿生成失败')
  return body as RequirementRepairDraft
}

export async function approveRequirementRepairDraft(runId: string, draftId: string, comment?: string) {
  const response = await fetch(`${apiBase}/requirement-analysis-runs/${encodeURIComponent(runId)}/repair-drafts/${encodeURIComponent(draftId)}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ comment }) })
  const body = await response.json() as RequirementRepairDraft | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : '需求修复草稿审批失败')
  return body as RequirementRepairDraft
}

export async function applyRequirementRepairDraft(runId: string, draftId: string) {
  const response = await fetch(`${apiBase}/requirement-analysis-runs/${encodeURIComponent(runId)}/repair-drafts/${encodeURIComponent(draftId)}/apply`, { method: 'POST' })
  const body = await response.json() as RequirementRepairDraft | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : '需求修复应用失败')
  return body as RequirementRepairDraft
}

export async function finalizeRequirementRepairDraft(runId: string, draftId: string) {
  const response = await fetch(`${apiBase}/requirement-analysis-runs/${encodeURIComponent(runId)}/repair-drafts/${encodeURIComponent(draftId)}/finalize`, { method: 'POST' })
  const body = await response.json() as RequirementRepairDraft | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : '需求修复新版本确认失败')
  return body as RequirementRepairDraft
}

export async function verifyRequirementRepairDraft(runId: string, draftId: string) {
  const response = await fetch(`${apiBase}/requirement-analysis-runs/${encodeURIComponent(runId)}/repair-drafts/${encodeURIComponent(draftId)}/verify`, { method: 'POST' })
  const body = await response.json() as { repairDraft: RequirementRepairDraft; verificationRun: RequirementAnalysisRun } | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : '需求修复复验启动失败')
  return body as { repairDraft: RequirementRepairDraft; verificationRun: RequirementAnalysisRun }
}

export async function createRequirementReleaseCandidate(runId: string) {
  const response = await fetch(`${apiBase}/requirement-analysis-runs/${encodeURIComponent(runId)}/release-candidate`, { method: 'POST' })
  const body = await response.json() as RequirementReleasePackage | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : '需求发布候选生成失败')
  return body as RequirementReleasePackage
}

export async function publishRequirementRelease(runId: string) {
  const response = await fetch(`${apiBase}/requirement-analysis-runs/${encodeURIComponent(runId)}/release/publish`, { method: 'POST' })
  const body = await response.json() as RequirementReleasePackage | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : '需求发布失败')
  return body as RequirementReleasePackage
}

export function requirementReleaseArtifactUrl(runId: string, fileName: string) {
  return `${apiBase}/requirement-analysis-runs/${encodeURIComponent(runId)}/release/artifacts/${encodeURIComponent(fileName)}`
}

export async function downloadRequirementAnalysisReport(projectVersionId: string, runId: string) {
  const response = await fetch(`${apiBase}/project-versions/${encodeURIComponent(projectVersionId)}/requirement-analysis-runs/${encodeURIComponent(runId)}/report.md`)
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error || '需求分析报告导出失败')
  }
  return response.blob()
}

export async function loadToolApprovals(runId: string) {
  const response = await fetch(`${apiBase}/requirement-analysis-runs/${encodeURIComponent(runId)}/approvals`)
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
