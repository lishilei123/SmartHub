import type { AgentExecutionAggregateResult, FrozenAgentUnderTestSnapshot } from './agent-test-types.js'
import type { ExecutionRunStatus, FrozenExecutionAgentSnapshot } from './test-execution-types.js'

export interface TestReportRate { numerator: number; denominator: number; percentage: number }
export interface TestReportListItem {
  runId: string; projectVersionId: string; status: ExecutionRunStatus; stateVersion: number; mode: string; totalCases: number
  agentUnderTest: { id: string; name: string; version: number; protocol: 'http' | 'sse' }
  createdAt: string; startedAt?: string; finishedAt?: string
}
export interface TestReportAgentTraceability {
  agentKey: FrozenExecutionAgentSnapshot['agentKey']; configurationId: string; configurationVersion: number
  configurationSha256: string; definitionSha256: string; snapshotSha256: string
}
export interface AgentTestExecutionReportContent {
  schemaVersion: 'agent-test-execution-report/v1'; statisticsAt: string
  run: { id: string; status: ExecutionRunStatus; stateVersion: number; mode: string; createdAt: string; startedAt?: string; finishedAt?: string }
  overview: {
    totalCases: number; passed: number; failed: number; notEvaluable: number; error: number; active: number
    successRate: TestReportRate; caseRunCount: number; averageLatencyMs: number | null
    tokenUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }; cost?: number
  }
  results: AgentExecutionAggregateResult[]
  traceability: {
    projectId: string; projectVersionId: string; runId: string; runStateVersion: number
    handoff: { id: string; sha256: string; memberSnapshotSha256: string }
    testCaseLibraryVersion: { id: string; sha256: string }
    testSuiteVersion?: { id: string; sha256: string }
    agentUnderTest: FrozenAgentUnderTestSnapshot
    runner: { kind: 'agent'; runnerVersion: string }
    agents: { failureAnalysis: TestReportAgentTraceability }
  }
}
export interface AgentTestExecutionReport extends AgentTestExecutionReportContent { reportSha256: string }
export type AnyTestExecutionReport = AgentTestExecutionReport
