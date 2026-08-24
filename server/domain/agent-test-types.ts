export type AgentUnderTestProtocol = 'http' | 'sse'

export type AgentUnderTestAuthenticationConfig =
  | { type: 'none' }
  | { type: 'bearer_env'; environmentVariable: string }
  | { type: 'api_key_env'; headerName: string; environmentVariable: string }

export interface AgentUnderTestRequestMapping {
  method: 'POST'
  inputField: string
  contextField?: string
  sessionIdField?: string
  headers?: Record<string, string>
}

export interface AgentUnderTestResponseMapping {
  outputPath: string
  tracePath?: string
  tokenUsagePath?: string
  costPath?: string
  /** Only an explicit AUT contract can prove absence from a trace domain. */
  traceCompleteness?: 'complete' | 'partial'
}

export interface AgentUnderTestVersion {
  version: number
  endpoint: string
  protocol: AgentUnderTestProtocol
  authenticationConfig: AgentUnderTestAuthenticationConfig
  requestMapping: AgentUnderTestRequestMapping
  responseMapping: AgentUnderTestResponseMapping
  documentationRefs: string[]
  configurationSha256: string
  createdAt: string
  createdBy: string
}

export interface AgentUnderTest {
  id: string
  projectId: string
  projectVersionId: string
  name: string
  description?: string
  enabled: boolean
  currentVersion: number
  versions: AgentUnderTestVersion[]
  createdAt: string
  updatedAt: string
}

export interface FrozenAgentUnderTestSnapshot {
  id: string
  projectId: string
  projectVersionId: string
  name: string
  description?: string
  version: number
  endpoint: string
  protocol: AgentUnderTestProtocol
  requestMapping: AgentUnderTestRequestMapping
  responseMapping: AgentUnderTestResponseMapping
  documentationRefs: string[]
  configurationSha256: string
}

export type AgentValueAssertionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'matches'
  | 'exists'

export interface AgentArgumentAssertion {
  tool: string
  path: string
  operator: AgentValueAssertionOperator
  expected?: unknown
}

export interface AgentBusinessAssertion {
  path: string
  operator: AgentValueAssertionOperator
  expected?: unknown
}

export interface AgentSequenceConstraint {
  before: string
  after: string
}

export interface AgentArtifactAssertion {
  name: string
}

export interface AgentSemanticAssertion {
  criterion: string
  expected: string
}

export interface AgentSafetyAssertion {
  criterion: string
  expected: string
}

export interface AgentExecutionConstraints {
  timeoutMs: number
  maxSteps: number
  repeatCount: number
  maxCost?: number
}

export interface AgentTestSpec {
  input: unknown
  context?: Record<string, unknown>
  expectedOutcome: string
  requiredTools: string[]
  forbiddenTools: string[]
  requiredActions: string[]
  forbiddenActions: string[]
  argumentAssertions: AgentArgumentAssertion[]
  sequenceConstraints: AgentSequenceConstraint[]
  businessAssertions: AgentBusinessAssertion[]
  artifactAssertions: AgentArtifactAssertion[]
  semanticAssertions: AgentSemanticAssertion[]
  safetyAssertions: AgentSafetyAssertion[]
  executionConstraints: AgentExecutionConstraints
}

export type TraceEventType =
  | 'USER_INPUT'
  | 'AGENT_OUTPUT'
  | 'LLM_CALL'
  | 'TOOL_CALL'
  | 'TOOL_RESULT'
  | 'MCP_CALL'
  | 'RETRIEVAL'
  | 'SUB_AGENT_CALL'
  | 'ARTIFACT'
  | 'BUSINESS_STATE'
  | 'ERROR'

export type TraceEvidenceCoverage = Partial<
  Record<TraceEventType, 'complete' | 'partial' | 'unavailable'>
>

export interface TraceEvent {
  id: string
  runId: string
  taskId: string
  caseRunId: string
  sequence: number
  type: TraceEventType
  timestamp: string
  source: 'agent_under_test' | 'http_response_collector' | 'sse_event_collector' | 'agent_runner'
  name?: string
  input?: unknown
  output?: unknown
  metadata?: Record<string, unknown>
  durationMs?: number
}

export type AgentAssertionStatus = 'PASS' | 'FAIL' | 'NOT_EVALUABLE'

export type AgentAssertionType =
  | 'HTTP_RESULT'
  | 'TOOL_PRESENCE'
  | 'FORBIDDEN_TOOL'
  | 'ACTION_PRESENCE'
  | 'FORBIDDEN_ACTION'
  | 'ARGUMENT_MATCH'
  | 'SEQUENCE_CONSTRAINT'
  | 'BUSINESS_RESULT'
  | 'ARTIFACT'
  | 'TIMEOUT'
  | 'STEP_COUNT'
  | 'COST_LIMIT'

export interface AgentAssertionResult {
  id: string
  caseRunId: string
  ordinal: number
  type: AgentAssertionType
  status: AgentAssertionStatus
  code: string
  message: string
  expected?: unknown
  actual?: unknown
  evidenceRefs: string[]
}

export interface AgentEvaluationResult {
  id: string
  caseRunId: string
  ordinal: number
  kind: 'task_completion' | 'semantic' | 'safety'
  criterion: string
  status: AgentAssertionStatus
  explanation: string
  evidenceRefs: string[]
  modelSnapshotRef?: string
}

export type AgentCaseRunStatus = 'PASS' | 'FAIL' | 'NOT_EVALUABLE' | 'ERROR'

export interface AgentTokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export interface AgentFailureFact {
  code: string
  message: string
  evidenceRefs: string[]
  expected?: unknown
  actual?: unknown
}

export interface AgentExecutionCaseRun {
  id: string
  runId: string
  taskId: string
  repeatOrdinal: number
  status: AgentCaseRunStatus
  actualOutput?: unknown
  assertionResults: AgentAssertionResult[]
  evaluationResults: AgentEvaluationResult[]
  traceRef: string
  traceEvents: TraceEvent[]
  evidenceRefs: string[]
  evidenceCoverage: TraceEvidenceCoverage
  latencyMs: number
  tokenUsage?: AgentTokenUsage
  cost?: number
  stepCount: number
  failureFacts: AgentFailureFact[]
  startedAt: string
  finishedAt: string
  error?: string
}

export interface AgentExecutionAggregateResult {
  taskId: string
  runId: string
  status: AgentCaseRunStatus
  caseRuns: AgentExecutionCaseRun[]
  successRate: number
  failureRate: number
  notEvaluableRate: number
  errorRate: number
  averageLatencyMs: number
  tokenUsage?: AgentTokenUsage
  cost?: number
  failureAnalysis?: {
    category: string
    reason: string
    evidence: string
    source: 'agent'
    agentSnapshotRef: string
  }
  failureAnalysisError?: string
  evaluationError?: string
  createdAt: string
}
