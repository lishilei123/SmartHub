import type { FrozenAgentUnderTestSnapshot } from './agent-test-types.js'
import type {
  TestCaseContent,
  TestCaseExecutionSpec,
  TestCaseTraceability,
  TestDimension,
  TestExecutionMode,
} from './test-design-types.js'

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

export type ExecutionRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'partial' | 'cancelled'
export type ExecutionTaskStatus = 'pending' | 'running' | 'passed' | 'failed' | 'blocked' | 'cancelled'

export type FailureDiagnosisCategory =
  | 'product_defect'
  | 'environment_defect'
  | 'test_data_defect'
  | 'assertion_mismatch'
  | 'timeout'
  | 'planning'
  | 'tool_selection'
  | 'tool_argument'
  | 'tool_sequence'
  | 'prompt'
  | 'context'
  | 'model'
  | 'tool_schema'
  | 'mcp'
  | 'workflow'
  | 'knowledge'
  | 'memory'
  | 'runtime'
  | 'business_backend'
  | 'unknown'

export interface FrozenExecutionAgentSnapshot {
  agentKey: 'failure-analysis'
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

export interface ExecutionRunnerSnapshot {
  kind: 'agent'
  runnerVersion: 'agent-runner/v1'
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
  agentUnderTest: FrozenAgentUnderTestSnapshot
  knowledge?: FrozenExecutionKnowledgeSnapshot
  testData?: FrozenExecutionTestDataSnapshot
  runner: ExecutionRunnerSnapshot
  agents: { failureAnalysis: FrozenExecutionAgentSnapshot }
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
  method: 'agent'
  dimension: TestDimension
  executionSpec: TestCaseExecutionSpec
  executionSpecSha256: string
  traceability?: TestCaseTraceability
  selectionReason?: string
  readinessOverride?: { reason: string; actorId: string; createdAt: string }
  testDataBindings?: Array<{ requirement: TestDataRequirement; binding: ExecutionTestDataBinding }>
  inputSha256: string
}

export interface ExecutionTask {
  id: string
  runId: string
  input: FrozenExecutionTaskInput
  status: ExecutionTaskStatus
  stateVersion: number
  error?: string
  createdAt: string
  updatedAt: string
  finishedAt?: string
}

export interface FailureDiagnosisCandidate {
  category: FailureDiagnosisCategory
  reason: string
  evidence: string
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
  request?: { kind: 'manual_retry'; idempotencyKey: string; requestedBy: string }
  createdAt: string
  updatedAt: string
}
