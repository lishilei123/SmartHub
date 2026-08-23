import type {
  CaseMaintenanceProposal,
  ExecutionRunStatus,
  ExecutionTaskStatus,
  TestExecutionMethod,
  TestExecutionMode,
} from '../test-execution/types'

export type FailureDiagnosisCategory =
  | 'product_defect'
  | 'script_defect'
  | 'selector_changed'
  | 'environment_defect'
  | 'test_data_defect'
  | 'flaky'
  | 'assertion_mismatch'
  | 'timeout'
  | 'unknown'

export type ReportRate = {
  numerator: number
  denominator: number
  percentage: number
}

export type TestReportListItem = {
  runId: string
  projectVersionId: string
  status: ExecutionRunStatus
  stateVersion: number
  mode: TestExecutionMode
  totalCases: number
  environment: { id: string; name: string; signature: string }
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

export type TestReport = {
  schemaVersion: 'test-execution-report/v3'
  statisticsAt: string
  reportSha256: string
  run: {
    id: string
    status: ExecutionRunStatus
    stateVersion: number
    mode: TestExecutionMode
    createdAt: string
    startedAt?: string
    finishedAt?: string
  }
  overview: {
    totalCases: number
    passed: number
    failed: number
    blocked: number
    waitingManual: number
    unsupported: number
    cancelled: number
    active: number
    maintenanceProposalCount: number
    pendingMaintenanceCount: number
    acceptedMaintenanceCount: number
    rejectedMaintenanceCount: number
    statusCounts: Record<ExecutionTaskStatus, number>
    finalPassRate: ReportRate
  }
  efficiency: {
    totalDurationMs: number
    durationSampleCount: number
    averageCaseDurationMs: number | null
    minimumCaseDurationMs: number | null
    maximumCaseDurationMs: number | null
    p50CaseDurationMs: number | null
    p95CaseDurationMs: number | null
    totalRunnerAttempts: number
  }
  firstExecutionQuality: {
    eligibleCaseCount: number
    firstPassCount: number
    firstPassRate: ReportRate
    passedAfterRetryCount: number
    passedAfterRepairCount: number
  }
  stability: {
    sameScriptRetryCount: number
    flakyCaseCount: number
    flakyRate: ReportRate
    infrastructureErrorCount: number
  }
  selfHealing: {
    triggeredTaskCount: number
    totalScriptRevisionCount: number
    automaticRepairSuccessCount: number
    automaticRepairFailureCount: number
    automaticRepairPendingCount: number
    repairSuccessRate: ReportRate
    averageRepairRounds: number
  }
  diagnosisDistribution: {
    totalDiagnoses: number
    categories: Array<{
      category: FailureDiagnosisCategory
      count: number
      percentage: number
    }>
  }
  maintenanceProposals: Array<CaseMaintenanceProposal & {
    ordinal: number
    title: string
    diagnosisCategory: FailureDiagnosisCategory
    diagnosisSummary: string
  }>
  nonPassedTasks: Array<{
    taskId: string
    ordinal: number
    caseId: string
    caseRevision: number
    title: string
    method: TestExecutionMethod
    dimension: string
    status: ExecutionTaskStatus
    terminal: boolean
    diagnosis: null | {
      id: string
      category: FailureDiagnosisCategory
      confidence: number
      summary: string
      repairable: boolean
      recommendedAction: string
      source: 'agent' | 'deterministic'
      createdAt: string
    }
    attemptCount: number
    scriptRevisionCount: number
    artifacts: Array<{
      id: string
      attemptId?: string
      type: string
      sha256: string
      size: number
      mimeType: string
      createdAt: string
    }>
  }>
  traceability: {
    projectId: string
    projectVersionId: string
    runId: string
    runStateVersion: number
    handoff: { id: string; sha256: string; memberSnapshotSha256: string }
    testCaseLibraryVersion: { id: string; sha256: string; sourceRunId?: string }
    testSuiteVersion?: { id: string; sha256: string }
    environment: {
      id: string
      name: string
      signature: string
      baseUrl: string
      targets: Array<{ protocol: 'http' | 'https'; host: string; port: number }>
    }
    runner: {
      runnerVersion: string
      playwrightVersion: string
      imageReference: string
      imageDigest: string
    }
    agents: Record<'executionImplementation' | 'failureAnalysis', {
      agentKey: 'execution-implementation' | 'failure-analysis'
      configurationId: string
      configurationVersion: number
      configurationSha256: string
      definitionSha256: string
      snapshotSha256: string
    }>
  }
}
