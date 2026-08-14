import type {
  CaseMaintenanceProposal,
  ExecutionArtifactType,
  ExecutionRunStatus,
  ExecutionTaskStatus,
  FailureDiagnosisCategory,
  FrozenExecutionAgentSnapshot,
} from './test-execution-types.js'
import type {
  TestDimension,
  TestExecutionMethod,
  TestExecutionMode,
} from './test-design-types.js'

export interface TestReportRate {
  numerator: number
  denominator: number
  percentage: number
}

export interface TestReportListItem {
  runId: string
  projectVersionId: string
  status: ExecutionRunStatus
  stateVersion: number
  mode: TestExecutionMode
  totalCases: number
  environment: {
    id: string
    name: string
    signature: string
  }
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

export interface TestReportOverview {
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
  finalPassRate: TestReportRate
}

export interface TestReportEfficiency {
  totalDurationMs: number
  durationSampleCount: number
  averageCaseDurationMs: number | null
  minimumCaseDurationMs: number | null
  maximumCaseDurationMs: number | null
  p50CaseDurationMs: number | null
  p95CaseDurationMs: number | null
  totalRunnerAttempts: number
}

export interface TestReportFirstExecutionQuality {
  eligibleCaseCount: number
  firstPassCount: number
  firstPassRate: TestReportRate
  passedAfterRetryCount: number
  passedAfterRepairCount: number
}

export interface TestReportStability {
  sameScriptRetryCount: number
  flakyCaseCount: number
  flakyRate: TestReportRate
  infrastructureErrorCount: number
}

export interface TestReportSelfHealing {
  triggeredTaskCount: number
  totalScriptRevisionCount: number
  automaticRepairSuccessCount: number
  automaticRepairFailureCount: number
  automaticRepairPendingCount: number
  repairSuccessRate: TestReportRate
  averageRepairRounds: number
}

export interface TestReportDiagnosisCategoryStatistics {
  category: FailureDiagnosisCategory
  count: number
  percentage: number
}

export interface TestReportDiagnosisDistribution {
  totalDiagnoses: number
  categories: TestReportDiagnosisCategoryStatistics[]
}

export interface TestReportPublicArtifact {
  id: string
  attemptId?: string
  type: ExecutionArtifactType
  sha256: string
  size: number
  mimeType: string
  createdAt: string
}

export interface TestReportDiagnosisDetail {
  id: string
  category: FailureDiagnosisCategory
  confidence: number
  summary: string
  repairable: boolean
  recommendedAction: string
  source: 'agent' | 'deterministic'
  createdAt: string
}

export interface TestReportNonPassedTask {
  taskId: string
  ordinal: number
  caseId: string
  caseRevision: number
  title: string
  method: TestExecutionMethod
  dimension: TestDimension
  status: ExecutionTaskStatus
  terminal: boolean
  diagnosis: TestReportDiagnosisDetail | null
  attemptCount: number
  scriptRevisionCount: number
  artifacts: TestReportPublicArtifact[]
}

export interface TestReportMaintenanceProposal extends CaseMaintenanceProposal {
  ordinal: number
  title: string
  diagnosisCategory: FailureDiagnosisCategory
  diagnosisSummary: string
}

export interface TestReportAgentTraceability {
  agentKey: FrozenExecutionAgentSnapshot['agentKey']
  configurationId: string
  configurationVersion: number
  configurationSha256: string
  definitionSha256: string
  snapshotSha256: string
}

export interface TestReportTraceability {
  projectId: string
  projectVersionId: string
  runId: string
  runStateVersion: number
  handoff: {
    id: string
    sha256: string
    memberSnapshotSha256: string
  }
  testCaseLibraryVersion: {
    id: string
    sha256: string
    sourceRunId?: string
  }
  testSuiteVersion?: {
    id: string
    sha256: string
  }
  environment: {
    id: string
    name: string
    signature: string
    baseUrl: string
    targets: Array<{
      protocol: 'http' | 'https'
      host: string
      port: number
    }>
  }
  runner: {
    runnerVersion: string
    playwrightVersion: string
    imageReference: string
    imageDigest: string
  }
  agents: {
    testScript: TestReportAgentTraceability
    failureAnalysis: TestReportAgentTraceability
    scriptRepair: TestReportAgentTraceability
  }
}

export interface TestExecutionReportContent {
  schemaVersion: 'test-execution-report/v2'
  statisticsAt: string
  run: {
    id: string
    status: ExecutionRunStatus
    stateVersion: number
    mode: TestExecutionMode
    createdAt: string
    startedAt?: string
    finishedAt?: string
  }
  overview: TestReportOverview
  efficiency: TestReportEfficiency
  firstExecutionQuality: TestReportFirstExecutionQuality
  stability: TestReportStability
  selfHealing: TestReportSelfHealing
  diagnosisDistribution: TestReportDiagnosisDistribution
  nonPassedTasks: TestReportNonPassedTask[]
  maintenanceProposals: TestReportMaintenanceProposal[]
  traceability: TestReportTraceability
}

export interface TestExecutionReport extends TestExecutionReportContent {
  reportSha256: string
}
