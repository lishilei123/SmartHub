
import type { AgentExecutionContext, PlanningSubAgentRunRecord } from './planning-api'

export type ProjectWorkspaceSourceScope = 'current_input' | 'current_branch' | 'shared' | 'historical_branch' | 'formal_output'

const apiBase = 'http://127.0.0.1:8787/api'

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
  coverageTarget: boolean
  coverageRationale?: string
  mergeGroupId?: string
  mergeRationale?: string
}

export type PlanningClarification = {
  id: string
  question: string
  reason: string
  category: 'business_rule' | 'boundary' | 'expected_result' | 'dependency' | 'test_scope' | 'environment' | 'other'
  requirementPointRefs: string[]
  blocking: boolean
  status: 'pending' | 'answered' | 'dismissed'
  answer?: string
  createdAt: string
  answeredAt?: string
  answeredBy?: string
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
  clarifications: PlanningClarification[]
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
  artifacts: Array<{ fileName: 'requirement-baseline.md' | 'requirement-analysis.md'; mediaType: 'text/markdown'; content: string; contentSha256: string }>
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
  skillKey?: string
  version?: string
  stopReason?: string
  model?: string
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }
  framework?: { name: string; version: string }
}

export type AgentExecutionRecord = {
  agentKey?: 'planning'
  turns: number
  toolCalls: number
  toolErrors?: number
  framework?: { name: string; version: string }
  workflowStage?: 'analysis' | 'release'
  context?: AgentExecutionContext
  events: AgentExecutionEvent[]
}

export type RequirementReleasePackage = {
  id: string
  schemaVersion: 'requirement-release-package/v1'
  status: 'published'
  projectVersionId: string
  verificationRunId: string
  sourceAssetVersionIds: string[]
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
  enabledSkills: string[]
  mcpBindings: { serverKey: string; version: string; enabled: boolean; toolIds: string[]; policyHash: string }[]
  resultSchemaVersion: string
}

export type AgentExecutions = {
  planning?: AgentExecutionRecord
}

export type RequirementAnalysisRunExecutionAttempt = {
  attempt: number
  maxAttempts: number
  activeAgentKey?: 'planning'
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
  toolReads?: Array<{ toolCallId: string; toolId: 'workspace.read_file'; relativePath: string; assetVersionIds: string[]; chunkIds: string[]; startLine: number; endLine: number; sourceScope?: ProjectWorkspaceSourceScope }>
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
    currentInputRefs: Array<{ assetId: string; assetVersionId: string; logicalPath: string; contentSha256: string }>
    workspaceSnapshot: {
      schemaVersion: 'project-workspace-snapshot/v1'
      projectId: string
      projectVersionId: string
      rootLogicalPath: 'workspace'
      activeBranchLogicalPath: string
      files: Array<{ assetId?: string; assetVersionId?: string; logicalPath: string; displayName: string; contentSha256: string; sourceScope: ProjectWorkspaceSourceScope }>
      snapshotSha256: string
      createdAt: string
    }
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
    formalClarifications?: PlanningClarification[]
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
  status: 'running' | 'waiting_clarification' | 'succeeded' | 'failed' | 'cancelled'
  step: string
  progress: number
  queue?: {
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
    attempts: number
    maxAttempts: number
    availableAt: string
    error?: string
  }
  retryEvents?: Array<{ attempt: number; maxAttempts: number; agentKey?: 'planning'; status: 'scheduled' | 'exhausted'; error: string; occurredAt: string; nextAttemptAt?: string }>
  createdAt: string
  startedAt: string
  finishedAt?: string
  error?: string
  modelRouteAttempts?: Array<{ id: string; agentKey: 'planning'; sourceId: string; modelId: string; modelLabel: string; status: 'running' | 'succeeded' | 'failed' | 'cancelled'; startedAt: string; finishedAt?: string; error?: string }>
  degradations?: Array<{ agentKey: 'planning'; fromSourceId: string; fromModelId: string; toSourceId: string; toModelId: string; reason: string; occurredAt: string }>
  snapshot?: RequirementAnalysisResponse['snapshot']
  execution?: AgentExecutionRecord
  executions?: AgentExecutions
  executionAttempts?: RequirementAnalysisRunExecutionAttempt[]
  inputDeliveryManifest?: InputDeliveryManifest
  planningSubAgentRuns?: PlanningSubAgentRunRecord[]
  workflow?: {
    currentStage: 'analysis' | 'clarification' | 'release'
    release?: RequirementReleasePackage
    automaticTransition?: { status: 'pending' | 'running' | 'succeeded' | 'failed'; testDesignId?: string; testDesignRunId?: string; startedAt?: string; finishedAt?: string; error?: string }
  }
  response?: RequirementAnalysisResponse
}

export type RequirementAnalysisRunPage = {
  items: RequirementAnalysisRun[]
  nextCursor?: string
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

export async function actOnPlanningClarifications(runId: string, input: { items: Array<{ clarificationId: string; action: 'answer' | 'dismiss'; answer: string }> }) {
  const response = await fetch(`${apiBase}/requirement-analysis-runs/${encodeURIComponent(runId)}/clarifications/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  const body = await response.json() as { clarifications: PlanningClarification[]; run: RequirementAnalysisRun } | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : '待确认问题批量保存失败')
  return body as { clarifications: PlanningClarification[]; run: RequirementAnalysisRun }
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

export async function retryAutomaticTestDesign(runId: string) {
  const response = await fetch(`${apiBase}/requirement-analysis-runs/${encodeURIComponent(runId)}/automatic-test-design/retry`, { method: 'POST' })
  const body = await response.json() as { design: { id: string }; run: { id: string } } | { error?: string }
  if (!response.ok) throw new Error('error' in body && body.error ? body.error : '自动测试设计重试失败')
  return body as { design: { id: string }; run: { id: string } }
}

export function requirementReleaseArtifactUrl(runId: string, fileName: string) {
  return `${apiBase}/requirement-analysis-runs/${encodeURIComponent(runId)}/release/artifacts/${encodeURIComponent(fileName)}`
}

export async function loadRequirementReleaseArtifact(runId: string, fileName: string) {
  const response = await fetch(requirementReleaseArtifactUrl(runId, fileName))
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error || '正式产物读取失败')
  }
  return response.text()
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
