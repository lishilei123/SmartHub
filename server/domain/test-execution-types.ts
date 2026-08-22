import type {
  TestCaseContent,
  TestCaseExecutionSpec,
  TestCaseTraceability,
  TestDimension,
  TestExecutionMethod,
  TestExecutionMode,
} from './test-design-types.js'

/** Execution-owned controlled data definition; TestCase v3 never embeds this shape. */
export interface TestDataRequirement {
  id: string
  name: string
  entityType: string
  featureTags: string[]
  requirementRefs?: string[]
  caseIds: string[]
  fieldConstraints: Record<string, string>
  relationships: string[]
  quantity: number
  initialState: string
  preparationHint: string
  sensitivity: 'public' | 'internal' | 'sensitive'
  isolation: string
  resetAndCleanup: string
  readiness: 'ready' | 'needs_confirmation' | 'blocked'
  readinessReason?: string
}

export interface ExecutionTestDataBinding {
  requirementId: string
  sourceType: 'fixture' | 'generator' | 'data_reference'
  sourceRef: string
  preparationNote?: string
}

export interface FrozenExecutionTestDataSnapshot {
  sourceSetId: string
  sourceSetVersion: number
  sourceSetSha256: string
  requirementSnapshotSha256: string
  requirements: TestDataRequirement[]
  bindings: ExecutionTestDataBinding[]
  contentSha256: string
}

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

export type ExecutionAttemptKind =
  | 'initial'
  | 'same_script_retry'
  | 'infrastructure_retry'
  | 'post_repair'
  | 'manual_retry'

export type ExecutionAttemptStatus = 'running' | 'passed' | 'failed' | 'cancelled' | 'infrastructure_error'

export type ScriptGenerationSource = 'agent' | 'cache' | 'repair'

export type ExecutionArtifactType =
  | 'log'
  | 'screenshot'
  | 'trace'
  | 'video'
  | 'har'
  | 'script'
  | 'package'
  | 'result'
  | 'completion_manifest'

export interface FrozenExecutionAgentSnapshot {
  agentKey: 'test-script' | 'failure-analysis' | 'script-repair'
  configurationId: string
  configurationVersion: number
  configurationSha256: string
  definitionSha256: string
  model: {
    sourceId: string
    modelId: string
    providerType: 'openai' | 'anthropic' | 'openai_compatible'
    modelName: string
    baseUrlSha256: string
    contextWindow: number
    maxOutputTokens: number
    supportsReasoning: boolean
    requestTimeoutMs: number
    retryCount: number
  }
  snapshotSha256: string
}

export interface ExecutionEnvironmentSnapshot {
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

export interface ExecutionRunnerSnapshot {
  runnerVersion: string
  playwrightVersion: string
  imageReference: string
  imageDigest: string
  configurationId?: string
  configurationVersion?: number
  configurationSha256?: string
}

export interface FrozenExecutionKnowledgeSnapshot {
  knowledgeBaseId: string
  indexVersionId: string
  indexVersion: number
  indexCreatedAt: string
}

export interface FrozenExecutionHandoffSnapshot {
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

export interface ExecutionRun {
  id: string
  projectId: string
  projectVersionId: string
  handoff: FrozenExecutionHandoffSnapshot
  environment: ExecutionEnvironmentSnapshot
  /** Fixed Knowledge index used only as document/historical context. */
  knowledge?: FrozenExecutionKnowledgeSnapshot
  /** Runtime data supply is frozen per Run and kept separate from formal case content. */
  testData?: FrozenExecutionTestDataSnapshot
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

export interface FrozenExecutionTaskInput {
  sourceVersionId: string
  ordinal: number
  dedupKey: string
  stage: string
  caseId: string
  caseRevision: number
  caseContent: TestCaseContent
  caseContentSha256: string
  method: TestExecutionMethod
  dimension: TestDimension
  executionSpec: TestCaseExecutionSpec
  executionSpecSha256: string
  traceability?: TestCaseTraceability
  selectionReason?: string
  readinessOverride?: {
    reason: string
    actorId: string
    createdAt: string
  }
  testDataBindings?: Array<{
    requirement: TestDataRequirement
    binding: ExecutionTestDataBinding
  }>
  inputSha256: string
}

export interface ExecutionTask {
  id: string
  runId: string
  input: FrozenExecutionTaskInput
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

export interface ExecutionAssertionContract {
  verificationCheckKey: string
  verificationCheckSha256: string
  anchor: string
  matcher: string
  modifiers: string[]
  expectedSemanticsSha256: string
}

export interface ExecutionPackageFile {
  path: string
  content: string
  contentSha256: string
  size: number
}

export interface ExecutionPackageManifest {
  schemaVersion: 'execution-package/v1'
  taskId: string
  caseId: string
  caseRevision: number
  method: 'ui' | 'api'
  entrypoint: string
  taskInputSha256: string
  caseContentSha256: string
  executionSpecSha256: string
  environmentSignature: string
  files: Array<Pick<ExecutionPackageFile, 'path' | 'contentSha256' | 'size'>>
  assertions: ExecutionAssertionContract[]
  protectedAssertionSha256: string
  packageSha256: string
}

export interface ExecutionPackage {
  manifest: ExecutionPackageManifest
  files: ExecutionPackageFile[]
}

export interface ExecutionPackageCandidate {
  schemaVersion: 'test-script-generation/v1' | 'script-repair/v1'
  taskId: string
  parentScriptRevisionId?: string
  /** Persistent workspace entry. Legacy candidates omit it and use the task entry. */
  entryFile?: string
  files: Array<{
    path: string
    content: string
    contentSha256?: string
  }>
  summary: string
}

export interface ScriptArtifact {
  id: string
  cacheKey: string
  caseId: string
  caseRevision: number
  method: 'ui' | 'api'
  caseContentSha256: string
  executionSpecSha256: string
  /** Prevents cache reuse across different frozen runtime data bindings. */
  taskInputSha256?: string
  environmentSignature: string
  testScriptAgentVersion: number
  testScriptAgentConfigurationSha256: string
  createdAt: string
}

export interface ScriptRevision {
  id: string
  runId: string
  taskId: string
  scriptArtifactId: string
  revision: number
  parentRevisionId?: string
  cacheSourceRevisionId?: string
  source: ScriptGenerationSource
  repairReason?: string
  generatedBy: FrozenExecutionAgentSnapshot
  package: ExecutionPackageManifest
  sourceArtifactId: string
  contentSha256: string
  protectedAssertionSha256: string
  createdAt: string
}

export interface ExecutionAttempt {
  id: string
  runId: string
  taskId: string
  ordinal: number
  invocationKey: string
  kind: ExecutionAttemptKind
  scriptRevisionId: string
  packageSha256: string
  status: ExecutionAttemptStatus
  startedAt: string
  finishedAt?: string
  durationMs?: number
  exitCode?: number
  summary?: string
  error?: string
}

export interface FailureDiagnosisEvidence {
  attemptId: string
  artifactId?: string
  observation: string
}

export interface FailureDiagnosis {
  id: string
  runId: string
  taskId: string
  scriptRevisionId: string
  attemptIds: string[]
  category: FailureDiagnosisCategory
  confidence: number
  summary: string
  evidence: FailureDiagnosisEvidence[]
  repairable: boolean
  recommendedAction: string
  source: 'agent' | 'deterministic'
  agent?: FrozenExecutionAgentSnapshot
  createdAt: string
}

export interface ExecutionArtifact {
  id: string
  runId: string
  taskId?: string
  attemptId?: string
  type: ExecutionArtifactType
  storagePath: string
  sha256: string
  size: number
  mimeType: string
  createdAt: string
}

export interface CaseMaintenanceProposal {
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

export interface ExecutionJob {
  id: string
  runId: string
  taskId: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  attempts: number
  maxAttempts: number
  availableAt: string
  leaseOwner?: string
  runToken?: string
  fencingToken: number
  leaseExpiresAt?: string
  heartbeatAt?: string
  cancelRequestedAt?: string
  error?: string
  request?: {
    kind: 'manual_retry'
    idempotencyKey: string
    requestedBy: string
  }
  createdAt: string
  updatedAt: string
}

export type ExplorationValidationStatus = 'validated' | 'needs_validation' | 'invalid'

export interface ExplorationSchemaShape {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'unknown'
  properties?: Record<string, ExplorationSchemaShape>
  required?: string[]
  items?: ExplorationSchemaShape
  redacted?: true
}

/**
 * Redacted, runtime-observed HTTP behavior. This is intentionally a schema
 * summary rather than a request/response recording: real values never cross
 * the Exploration Context persistence boundary.
 */
export interface HttpExplorationObservation {
  type: 'http_endpoint'
  method: string
  origin: string
  path: string
  queryParams: string[]
  requestHeaders: Record<string, string>
  requestSchema?: ExplorationSchemaShape
  responseStatus?: number
  responseSchema?: ExplorationSchemaShape
  contentType?: string
  observedFrom: {
    page: string
    action: string
    actionType: 'navigate' | 'click' | 'fill' | 'select' | 'wait' | 'other'
    sequence: number
  }
  confidence: number
}

/** ProjectVersion-owned reusable runtime knowledge; never Requirement truth. */
export interface ProjectVersionExplorationResult extends HttpExplorationObservation {
  id: string
  projectVersionId: string
  sourceCaseId: string
  environmentSignature: string
  source: 'ui_exploration' | 'api_exploration'
  validationStatus: ExplorationValidationStatus
  observedAt: string
  createdAt: string
  updatedAt: string
  sourceRunId?: string
  sourceTaskId?: string
  inheritedFromProjectVersionId?: string
  inheritedFromExplorationId?: string
}
