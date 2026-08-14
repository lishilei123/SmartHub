import type { AgentConfigurationVersion } from './agent-configuration-api'

const apiBase = import.meta.env.VITE_PLANNING_API_BASE ?? 'http://127.0.0.1:8787/api'

export type PlanningReviewerType = 'requirement' | 'test_point' | 'test_case' | 'coverage'
export type TestDesignReviewerSourceSelection = {
  testPointTreeRevision: number
  approvedTestPointTreeVersionId?: string
  testCases: Array<{
    caseId: string
    treeVersionId: string
    revision: number
  }>
  dataSetVersionId?: string
  coverageAuditId?: string
}
export type PlanningWorkflowStage =
  | 'requirement_analysis'
  | 'requirement_repair'
  | 'requirement_verification'
  | 'requirement_release'
  | 'test_point_design'
  | 'test_point_review'
  | 'test_case_design'
  | 'test_design_repair'
  | 'test_design_release'

export type AgentExecutionContext = {
  sessionId: string
  sessionFile?: string
  sessionRole: 'planning_parent' | 'reviewer' | 'execution_agent'
  parentSessionKey?: string
  contextWindow: number
  currentTokens: number | null
  usagePercent: number | null
  compactionCount: number
  lastCompactionAt?: string
  totalMessages: number
  autoCompactionEnabled: boolean
}

export type PlanningExecutionEvent = {
  sequence: number
  type: string
  occurredAt: string
  turn?: number
  toolId?: string
  toolCallId?: string
  isError?: boolean
  content?: string
  parentSessionId?: string
  subAgentRunId?: string
  reviewerType?: PlanningReviewerType
  context?: AgentExecutionContext
  compaction?: {
    reason: 'manual' | 'threshold' | 'overflow'
    aborted?: boolean
    willRetry?: boolean
    tokensBefore?: number
    estimatedTokensAfter?: number
    compactedTokens?: number
  }
}

export type PlanningSubAgentRunRecord = {
  runId: string
  reviewerType: PlanningReviewerType
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  sourceKind: 'requirement_run' | 'test_design_run'
  sourceId: string
  sourceSha256: string
  sourceReference: {
    kind: 'requirement' | 'test_design'
    [key: string]: unknown
  }
  parentSessionId?: string
  reviewerSessionId?: string
  turns: number
  toolCalls: number
  toolErrors: number
  framework?: { name: 'pi-coding-agent'; version: string }
  context?: AgentExecutionContext
  events: PlanningExecutionEvent[]
  startedAt: string
  finishedAt?: string
  error?: string
}

export type PlanningStageProfile = {
  stage: PlanningWorkflowStage
  agentKey: 'planning'
  allowedToolIds: string[]
  submitToolId?: string
  resultSchemaVersion?: string
  reviewers: PlanningReviewerType[]
  humanGate: boolean
}

export type PlanningAgentProfile = {
  agentKey: 'planning'
  label: 'PlanningAgent'
  parentSession: 'project_version'
  subAgents: Array<{
    reviewerType: PlanningReviewerType
    label: string
    session: 'independent'
    workspace: 'read_only'
    resultSchemaVersion: 'planning-review-candidate/v1'
  }>
  context: {
    autoCompaction: true
    proactiveThresholdPercent: number
    checkpoints: string[]
    summaryIsFormalBusinessFact: false
  }
  stageProfiles: PlanningStageProfile[]
  configurations: Array<{
    scene: 'planning'
    agentKey: 'planning'
    activeVersion: AgentConfigurationVersion | null
  }>
}

export type PlanningWorkflow = {
  projectVersion: { id: string; projectId: string; name: string; status: string }
  stageProfiles: PlanningStageProfile[]
  requirementRuns: { items: Array<{ id: string; status: string; workflow?: { currentStage?: string } }> }
  testDesigns: { items: Array<{ id: string; latestRun?: { status: string; stage: string } | null }> }
  context: AgentExecutionContext | null
}

export const loadPlanningAgentProfile = () => request<PlanningAgentProfile>('/planning-agent/profile')
export const loadPlanningWorkflow = (projectVersionId: string) => request<PlanningWorkflow>(`/project-versions/${encodeURIComponent(projectVersionId)}/planning-workflow`)
export const loadPlanningContext = (projectVersionId: string) => request<AgentExecutionContext | null>(`/project-versions/${encodeURIComponent(projectVersionId)}/planning-context`)
export const compactPlanningContext = (projectVersionId: string) => request<AgentExecutionContext>(`/project-versions/${encodeURIComponent(projectVersionId)}/planning-context`, { method: 'POST' })
export const runRequirementReviewer = (runId: string) => request(`/requirement-analysis-runs/${encodeURIComponent(runId)}/planning-reviewer`, { method: 'POST' })
export const runTestDesignReviewer = (
  runId: string,
  reviewerType: Exclude<PlanningReviewerType, 'requirement'>,
  sourceSelection: TestDesignReviewerSourceSelection,
) => request(
  `/test-design-runs/${encodeURIComponent(runId)}/planning-reviewer`,
  {
    method: 'POST',
    body: JSON.stringify({ reviewerType, ...sourceSelection }),
  },
)

async function request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const body = await response.json().catch(() => ({})) as T & { error?: string | { message?: string }; message?: string }
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : body.error?.message ?? body.message ?? `Planning 请求失败（HTTP ${response.status}）`)
  return body
}
