export type Versioned<T> = { value: T; etag: string }

export type AgentUnderTest = {
  id: string
  projectId: string
  projectVersionId: string
  name: string
  description?: string
  enabled: boolean
  currentVersion: number
  versions: Array<{
    version: number
    endpoint: string
    protocol: 'http' | 'sse'
    authenticationConfig: { type: 'none' } | { type: 'bearer_env'; environmentVariable: string } | { type: 'api_key_env'; headerName: string; environmentVariable: string }
    requestMapping: { method: 'POST'; inputField: string; contextField?: string; sessionIdField?: string; headers?: Record<string, string> }
    responseMapping: { outputPath: string; tracePath?: string; tokenUsagePath?: string; costPath?: string; traceCompleteness?: 'complete' | 'partial' }
    documentationRefs: string[]
    configurationSha256: string
    createdAt: string
    createdBy: string
  }>
  createdAt: string
  updatedAt: string
}

export type FrozenAgentUnderTest = { id: string; name: string; version: number; endpoint: string; protocol: 'http' | 'sse'; configurationSha256: string }
export type ExecutionReadiness = {
  ready: boolean
  store: { ready: boolean; reason?: string }
  agents: { ready: boolean; agents: Array<{ agentKey: string; ready: boolean; reason?: string }> }
  runner: { ready: boolean; snapshot: { kind: 'agent'; runnerVersion: 'agent-runner/v1' } }
  agent: { ready: boolean; reason?: string }
}
export type ExecutionRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'partial' | 'cancelled'
export type ExecutionTaskStatus = 'pending' | 'running' | 'passed' | 'failed' | 'blocked' | 'cancelled'
export type ExecutionRun = {
  id: string; projectId: string; projectVersionId: string
  handoff: { handoffId: string; testCaseLibraryVersionId: string; testCaseLibraryVersionSha256: string; mode: string }
  agentUnderTest: FrozenAgentUnderTest
  runner: { kind: 'agent'; runnerVersion: 'agent-runner/v1' }
  agents: { failureAnalysis: { agentKey: 'failure-analysis'; configurationVersion: number; configurationSha256: string } }
  testData?: { sourceSetVersion: number; bindings: unknown[] }
  status: ExecutionRunStatus; stateVersion: number; taskCount: number; createdAt: string
  startedAt?: string; finishedAt?: string; cancelRequestedAt?: string; error?: string
}
export type ExecutionTask = {
  id: string; runId: string
  input: {
    ordinal: number; caseId: string; caseRevision: number
    caseContent: { title: string; preconditions: string[]; steps: string[]; expectedResults: string[] }
    method: 'agent'; dimension: string
    executionSpec: { schemaVersion: 'agent-test-input/v1'; agentTestSpec: unknown }
  }
  status: ExecutionTaskStatus; stateVersion: number; error?: string; createdAt: string; updatedAt: string; finishedAt?: string
}
export type AgentAssertionResult = { id: string; ordinal: number; type: string; status: 'PASS' | 'FAIL' | 'NOT_EVALUABLE'; code: string; message: string; evidenceRefs: string[] }
export type AgentEvaluationResult = { id: string; ordinal: number; kind: string; criterion: string; status: 'PASS' | 'FAIL' | 'NOT_EVALUABLE'; explanation: string; evidenceRefs: string[] }
export type TraceEvent = { id: string; sequence: number; type: string; timestamp: string; source: string; name?: string; durationMs?: number }
export type AgentCaseRun = {
  id: string; repeatOrdinal: number; status: 'PASS' | 'FAIL' | 'NOT_EVALUABLE' | 'ERROR'; actualOutput?: unknown
  assertionResults: AgentAssertionResult[]; evaluationResults: AgentEvaluationResult[]; traceEvents: TraceEvent[]; evidenceRefs: string[]
  latencyMs: number; stepCount: number; tokenUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }; cost?: number; error?: string
}
export type AgentExecutionAggregateResult = {
  taskId: string; runId: string; status: AgentCaseRun['status']; caseRuns: AgentCaseRun[]
  successRate: number; failureRate: number; notEvaluableRate: number; errorRate: number; averageLatencyMs: number
  tokenUsage?: AgentCaseRun['tokenUsage']; cost?: number
  failureAnalysis?: { category: string; reason: string; evidence: string; source: 'agent'; agentSnapshotRef: string }
  failureAnalysisError?: string; evaluationError?: string; createdAt: string
}
export type ExecutionTaskDetail = { run: ExecutionRun; task: ExecutionTask; agentExecutionResult?: AgentExecutionAggregateResult }
