export type ExecutionRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'partial'
  | 'cancelled'

export type ExecutionTaskStatus =
  | 'pending'
  | 'script_generating'
  | 'ready'
  | 'running'
  | 'diagnosing'
  | 'retrying'
  | 'repairing'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'unsupported'
  | 'waiting_manual'
  | 'cancelled'

export type TestExecutionMode = 'smoke' | 'regression' | 'full' | 'custom'
export type TestExecutionMethod = 'ui' | 'api' | 'performance_tool' | 'long_running' | 'environment_matrix'

export type ExecutionReadiness = {
  ready: boolean
  store: { ready: boolean; reason?: string }
  artifactStore: { ready: boolean; reason?: string }
  environment: { ready: boolean; reason?: string }
  agents: {
    ready: boolean
    agents: Array<{ agentKey: string; ready: boolean; reason?: string }>
  }
  runner: {
    ready: boolean
    reason?: string
    snapshot: ExecutionRunnerSnapshot
  }
}

export type ExecutionEnvironment = {
  environmentId: string
  name: string
  baseUrl: string
  targets: Array<{
    protocol: 'http' | 'https'
    host: string
    port: number
  }>
  signature: string
}

export type ExecutionHandoff = {
  id: string
  projectId: string
  projectVersionId: string
  testCaseLibraryVersionId: string
  suiteVersionId?: string
  mode: TestExecutionMode
  members: Array<{
    stage: TestExecutionMode
    ordinal: number
    sourceVersionId: string
    caseId: string
    revision: number
    method: TestExecutionMethod
    reason: string
    dimension: string
    selectionReason: string
    contentSha256: string
  }>
  contentSha256: string
  createdBy: string
  createdAt: string
}

export type FrozenExecutionAgentSnapshot = {
  agentKey: 'test-script' | 'failure-analysis' | 'script-repair'
  configurationId: string
  configurationVersion: number
  configurationSha256: string
  definitionSha256: string
  model: {
    modelName: string
    providerType: string
  }
  snapshotSha256: string
}

export type ExecutionRunnerSnapshot = {
  runnerVersion: string
  playwrightVersion: string
  imageReference: string
  imageDigest: string
}

export type ExecutionRun = {
  id: string
  projectId: string
  projectVersionId: string
  handoff: {
    handoffId: string
    handoffSha256: string
    projectId: string
    projectVersionId: string
    testCaseLibraryVersionId: string
    testCaseLibraryVersionSha256: string
    suiteVersionId?: string
    suiteVersionSha256?: string
    mode: TestExecutionMode
    memberSnapshotSha256: string
  }
  environment: ExecutionEnvironment
  runner: ExecutionRunnerSnapshot
  agents: {
    testScript: FrozenExecutionAgentSnapshot
    failureAnalysis: FrozenExecutionAgentSnapshot
    scriptRepair: FrozenExecutionAgentSnapshot
  }
  status: ExecutionRunStatus
  stateVersion: number
  idempotencyKey: string
  taskCount: number
  createdBy: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  cancelRequestedAt?: string
  error?: string
}

export type ExecutionTask = {
  id: string
  runId: string
  input: {
    ordinal: number
    stage: string
    caseId: string
    caseRevision: number
    caseContent: { title: string; objective: string }
    caseContentSha256: string
    method: TestExecutionMethod
    dimension: string
    executionSpecSha256: string
    inputSha256: string
  }
  status: ExecutionTaskStatus
  stateVersion: number
  runnerAttemptCount: number
  sameScriptRetryCount: number
  repairCount: number
  currentScriptRevisionId?: string
  unsupportedReason?: string
  error?: string
  createdAt: string
  updatedAt: string
  finishedAt?: string
}

export type ExecutionAttempt = {
  id: string
  runId: string
  taskId: string
  ordinal: number
  kind: 'initial' | 'same_script_retry' | 'infrastructure_retry' | 'post_repair' | 'manual_retry'
  scriptRevisionId: string
  packageSha256: string
  status: 'running' | 'passed' | 'failed' | 'cancelled' | 'infrastructure_error'
  startedAt: string
  finishedAt?: string
  durationMs?: number
  exitCode?: number
  summary?: string
  error?: string
}

export type FailureDiagnosis = {
  id: string
  taskId: string
  scriptRevisionId: string
  attemptIds: string[]
  category: string
  confidence: number
  summary: string
  evidence: Array<{ attemptId: string; artifactId?: string; observation: string }>
  repairable: boolean
  recommendedAction: string
  source: 'agent' | 'deterministic'
  createdAt: string
}

export type ScriptRevision = {
  id: string
  taskId: string
  revision: number
  parentRevisionId?: string
  cacheSourceRevisionId?: string
  source: 'agent' | 'cache' | 'repair'
  repairReason?: string
  contentSha256: string
  protectedAssertionSha256: string
  package: { packageSha256: string; entrypoint: string }
  createdAt: string
}

export type ExecutionArtifact = {
  id: string
  runId: string
  taskId?: string
  attemptId?: string
  type: string
  sha256: string
  size: number
  mimeType: string
  createdAt: string
}

export type CaseMaintenanceProposal = {
  id: string
  runId: string
  taskId: string
  caseId: string
  caseRevision: number
  diagnosisId: string
  scriptRevisionId: string
  status: 'pending' | 'accepted' | 'rejected'
  summary: string
  proposedChange: string
  baselineLibraryVersionId: string
  baselineLibraryVersionSha256: string
  promotedCaseChangeProposalId?: string
  decidedBy?: string
  decidedAt?: string
  createdAt: string
}

export type ExecutionTaskDetail = {
  run: ExecutionRun
  task: ExecutionTask
  attempts: ExecutionAttempt[]
  diagnoses: FailureDiagnosis[]
  scriptRevisions: ScriptRevision[]
  artifacts: ExecutionArtifact[]
  maintenanceProposals: CaseMaintenanceProposal[]
}

export type ScriptRevisionDiff = {
  fromRevision: ScriptRevision
  toRevision: ScriptRevision
  changes: {
    unchangedPrefixLines: number
    removed: { startLine: number; lines: string[] }
    added: { startLine: number; lines: string[] }
    unchangedSuffixLines: number
  }
}

export type MaintenanceProposalDetail = {
  proposal: CaseMaintenanceProposal
  run: ExecutionRun
  task: ExecutionTask
  diagnosis: FailureDiagnosis
  failureAttempts: ExecutionAttempt[]
  originalScriptRevision: ScriptRevision
  repairScriptRevision: ScriptRevision
  postRepairAttempt: ExecutionAttempt
  baselineCase: {
    caseId: string
    revision: number
    content: { title: string; objective: string }
    contentSha256: string
  }
  baselineLibraryVersion: { id: string; sha256: string }
  diff: ScriptRevisionDiff
}

export type Versioned<T> = {
  value: T
  etag: string
  decisionEtag?: string
}
