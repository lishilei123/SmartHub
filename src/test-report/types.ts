import type { AgentExecutionAggregateResult, ExecutionRunStatus, FrozenAgentUnderTest } from '../test-execution/types'
export type TestReportListItem = {
  runId: string; projectVersionId: string; status: ExecutionRunStatus; stateVersion: number; mode: string; totalCases: number
  agentUnderTest: { id: string; name: string; version: number; protocol: 'http' | 'sse' }
  createdAt: string; startedAt?: string; finishedAt?: string
}
export type AgentTestReport = {
  schemaVersion: 'agent-test-execution-report/v2'; statisticsAt: string
  run: { id: string; status: ExecutionRunStatus; stateVersion: number; mode: string; createdAt: string; startedAt?: string; finishedAt?: string }
  overview: { totalCases: number; passed: number; failed: number; notEvaluable: number; error: number; active: number; successRate: { numerator: number; denominator: number; percentage: number }; executionAttemptCount: number; caseRunCount: number; averageLatencyMs: number | null; tokenUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }; cost?: number }
  results: AgentExecutionAggregateResult[]
  executionAttempts: AgentExecutionAggregateResult[]
  traceability: {
    projectId: string; projectVersionId: string; runId: string; runStateVersion: number
    handoff: { id: string; sha256: string; memberSnapshotSha256: string }
    testCaseLibraryVersion: { id: string; sha256: string }
    agentUnderTest: FrozenAgentUnderTest
    runner: { kind: 'agent'; runnerVersion: string }
    agents: { failureAnalysis: { snapshotSha256: string } }
  }
  reportSha256: string
}
export type TestReport = AgentTestReport
