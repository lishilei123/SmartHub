import type { AgentDefinitionVersion, AgentExecutionEvent, CurrentInputRef, InputDeliveryManifest, PlanningSubAgentRunRecord, ProjectWorkspaceSnapshot, ProjectWorkspaceSnapshotFile } from './agent-types.js'
import type { AgentExecutionRecord } from './types.js'
import type { AgentRoutingConfiguration } from './types.js'
import type { RequirementReleaseContent } from './requirement-workflow-types.js'

export type TestDimension = 'functional' | 'performance' | 'stability' | 'compatibility' | 'security'
export type TestExecutionMethod = 'ui' | 'api'
export type TestExecutionMode = 'smoke' | 'regression' | 'full' | 'custom'
export type WorkflowStatus = 'queued' | 'running' | 'waiting_gate' | 'succeeded' | 'failed' | 'cancelled'
export type WorkflowNodeStatus = 'pending' | 'queued' | 'running' | 'waiting_gate' | 'succeeded' | 'failed' | 'cancelled' | 'stale'
export type TestCaseReviewState = 'draft' | 'in_review' | 'approved' | 'rejected' | 'needs_revision'
export type ExecutionReadiness = 'ready' | 'blocked' | 'needs_confirmation'

export interface ScopeRule { kind: string; value: string }
export type KnowledgeAugmentation =
  | { mode: 'disabled' }
  | { mode: 'selected_assets'; assetVersionIds: string[] }
  | { mode: 'fixed_index'; indexVersionId: string; filters?: Record<string, string | string[]> }

export interface CreateTestDesignCommon {
  name: string
  objective: string
  /** 明确选择的已发布 Requirement Release；省略时使用当前默认绑定。 */
  requirementReleaseId?: string
  includedScopes?: ScopeRule[]
  excludedScopes?: ScopeRule[]
  focusDimensions?: TestDimension[]
  executionMethods?: Array<'ui' | 'api'>
  userCoverageObjectives?: string[]
  knowledgeAugmentation: KnowledgeAugmentation
}

export type CreateTestDesignInput = CreateTestDesignCommon

export interface TestDesign {
  id: string
  projectVersionId: string
  projectId: string
  name: string
  objective: string
  input: CreateTestDesignInput
  logicalInputSha256: string
  createdBy: string
  createdAt: string
  creationMode?: 'automatic' | 'manual'
  sourceRequirementReleaseId?: string
}

export interface FrozenContentRef {
  id: string
  kind: 'requirement_release' | 'human_clarification' | 'knowledge_asset' | 'test_case_library' | 'historical_test_suite'
  sourceId: string
  contentSha256: string
  content: unknown
  locator?: Record<string, unknown>
}

export interface TestDesignBasisSnapshot {
  schemaVersion: 'test-design-basis-snapshot/v3'
  projectVersionId: string
  requirementReleaseId: string
  verificationRunId: string
  requirementReleaseContentSha256: string
  content: RequirementReleaseContent
  createdAt: string
  snapshotSha256: string
}

export interface TestDesignWorkspaceFile extends ProjectWorkspaceSnapshotFile {
  logicalPath: string
  sourceType: 'asset_version' | 'test_case_library_version' | 'run_candidate'
  sourceId: string
  contentSha256: string
  content: string
  assetId?: string
  assetVersionId?: string
  displayName: string
}

export interface TestDesignWorkspaceSnapshot extends Omit<ProjectWorkspaceSnapshot, 'files'> {
  agentLogicalPath: 'workspace/agent_workspace/planning_agent'
  projectVersionName: string
  knowledgeBaseId: string
  indexVersionId: string
  requirementReleaseId: string
  verificationRunId: string
  requirementReleaseContentSha256: string
  files: TestDesignWorkspaceFile[]
  createdAt: string
  snapshotSha256: string
}

export interface TestDesignRunAgentConfigurationSnapshot {
  configurationId: string
  configurationVersion: number
  configurationSha256: string
  agentDefinition: AgentDefinitionVersion
  routing: AgentRoutingConfiguration
  primaryModel: {
    sourceId: string
    providerType: 'openai' | 'anthropic' | 'openai_compatible'
    modelId: string
    modelName: string
    contextWindow: number
    maxOutputTokens: number
    supportsReasoning: boolean
  }
  createdAt: string
  snapshotSha256: string
}

export interface RetrievalSnapshot {
  canonicalVersion: 'retrieval-snapshot/v1'
  mode: KnowledgeAugmentation['mode']
  assetVersionIds: string[]
  indexVersionId?: string
  filters?: Record<string, string | string[]>
  queryPlan: Array<{ query: string; intent: string }>
  hits: Array<{ id: string; assetVersionId: string; chunkId: string; contentSha256: string; score: number; rank: number; locator: Record<string, unknown>; classification: 'normative_reference' | 'historical_defect' | 'domain_practice' | 'context_only'; content: string }>
  createdAt: string
  snapshotSha256: string
}

export type HistoricalRequirementMappingStatus = 'exact' | 'high_confidence' | 'ambiguous' | 'unmapped'

export interface HistoricalRequirementMapping {
  sourceRequirementId: string
  sourceSemanticSha256: string
  status: HistoricalRequirementMappingStatus
  targetRequirementId?: string
  targetSemanticSha256?: string
  candidateRequirementIds?: string[]
  confidence?: number
}

export interface HistoricalCaseSnapshotItem extends Omit<FrozenContentRef, 'kind' | 'content'> {
  kind: 'test_case_library'
  content: TestCaseContent
  /** Full TestCase content integrity Hash, including revision-time requirementRefs. */
  contentSha256: string
  /** Test Intent identity Hash; deliberately excludes requirementRefs. */
  semanticSha256: string
  sourceRequirementReleaseId: string
  sourceRequirementRefs: string[]
}

export interface HistoricalCaseSnapshot {
  schemaVersion: 'historical-case-snapshot/v2'
  items: HistoricalCaseSnapshotItem[]
  /** Frozen whenever ProjectVersion inheritance is explicit, even if the source has no formal Library. */
  sourceProjectVersionId?: string
  /** Present only when this Run actually froze a formal source Library. */
  sourceTestCaseLibraryVersionId?: string
  sourceTestCaseLibraryVersionSha256?: string
  sourceRequirementReleaseId?: string
  sourceRequirementReleaseContentSha256?: string
  sourceRequirementReleaseContent?: RequirementReleaseContent
  requirementMappings: HistoricalRequirementMapping[]
  createdAt: string
  snapshotSha256: string
}

export type TestDesignNodeKey = 'test_case_design' | 'coverage_audit' | 'test_design_repair'
export type PlanningTestDesignExecutionRecord = Omit<AgentExecutionRecord, 'agentKey' | 'workflowStage'> & {
  agentKey: 'planning'
  workflowStage: 'test_case_design' | 'test_design_repair'
  agentVersion: string
  modelLabel: string
  degraded: boolean
  inputDeliveryManifest?: InputDeliveryManifest
}
export interface WorkflowNodeRun {
  id: string
  nodeKey: TestDesignNodeKey
  generation: number
  attempt: number
  status: WorkflowNodeStatus
  dependencies: TestDesignNodeKey[]
  inputSha256?: string
  outputArtifactId?: string
  startedAt?: string
  finishedAt?: string
  errorCode?: string
  error?: string
  execution?: PlanningTestDesignExecutionRecord
}

export interface WorkflowArtifact {
  id: string
  nodeKey: TestDesignNodeKey
  schemaVersion: string
  generation: number
  content: unknown
  contentSha256: string
  createdAt: string
}

export interface WorkflowGateDecision {
  id: string
  gateKey: string
  targetId: string
  targetRevision: number
  version: number
  decision: 'approved' | 'rejected'
  comment?: string
  actorId: string
  createdAt: string
}

export interface TestCaseContent {
  schemaVersion: 'test-case/v3'
  title: string
  dimension: TestDimension
  requirementRefs: string[]
  priority: 'P0' | 'P1' | 'P2' | 'P3'
  executionMethods: Array<'ui' | 'api'>
  preconditions: string[]
  steps: string[]
  expectedResults: string[]
}

/** Execution-stage projection: the script agent receives the v3 case unchanged plus the selected channel. */
export interface TestCaseExecutionSpec {
  schemaVersion: 'test-script-input/v1'
  method: 'ui' | 'api'
  testCase: TestCaseContent
}

export interface TestCaseRevision {
  revision: number
  content: TestCaseContent
  contentSha256: string
  semanticSha256: string
  diff: Array<{ path: string; before?: unknown; after?: unknown }>
  editorId: string
  reason: string
  createdAt: string
}

export interface LibraryTestCaseRevision {
  revision: number
  content: TestCaseContent
  contentSha256: string
  semanticSha256: string
  sourceRunId?: string
  sourceProposalId?: string
  traceability?: TestCaseTraceability
  changeReason: string
  createdBy: string
  createdAt: string
}

export interface TestCaseTraceability {
  sourceRequirementReleaseId: string
  requirementRefs: Array<{ requirementReleaseId: string; requirementId: string }>
}

export interface LibraryTestCase {
  id: string
  projectId: string
  currentRevision: number
  status: 'active' | 'deprecated'
  createdAt: string
  updatedAt: string
  revisions: LibraryTestCaseRevision[]
}

export type CaseChangeOperation = 'reuse' | 'update' | 'create' | 'deprecate' | 'reference'
export type CaseChangeDecision = 'pending' | 'accepted' | 'rejected' | 'keep_original' | 'reference' | 'deprecated'

export interface CaseChangeProposalDecisionRecord {
  id: string
  expectedVersion: number
  decision: Exclude<CaseChangeDecision, 'pending'>
  comment?: string
  decidedBy: string
  decidedAt: string
}

export interface CaseChangeProposal {
  id: string
  runId: string
  operation: CaseChangeOperation
  sourceCaseId?: string
  sourceRevision?: number
  candidateCaseId?: string
  candidateContent?: TestCaseContent
  diff: Array<{ path: string; before?: unknown; after?: unknown }>
  requirementRefs?: string[]
  reason: string
  confidence: number
  decision: CaseChangeDecision
  createdAt: string
  decidedBy?: string
  decidedAt?: string
  decisions: CaseChangeProposalDecisionRecord[]
  appliedCaseId?: string
  appliedRevision?: number
}

export interface TestCaseReviewAction {
  id: string
  targetRevision: number
  fromState: TestCaseReviewState
  toState: TestCaseReviewState
  decision: 'submit' | 'approve' | 'reject' | 'request_revision' | 'withdraw'
  comment?: string
  actorId: string
  createdAt: string
}

export interface TestCase {
  id: string
  runId: string
  origin: 'ai' | 'manual' | 'historical_unchanged' | 'historical_modified' | 'historical_reference'
  candidateRef?: string
  historicalSourceRef?: string
  currentRevision: number
  reviewState: TestCaseReviewState
  revisions: TestCaseRevision[]
  reviewActions: TestCaseReviewAction[]
  tombstonedAt?: string
}

/** Service projection used by Coverage and publication before formal IDs/Revisions are persisted. */
export interface EffectiveTestCase {
  caseId: string
  revision: number
  content: TestCaseContent
  contentSha256: string
  /** Current Requirement Release projection. Historical revision refs remain unchanged. */
  effectiveRequirementRefs: string[]
  source: 'historical_reuse' | 'historical_update' | 'candidate_create'
  sourceCaseId?: string
  candidateCaseId?: string
}

export interface CoverageAudit {
  id: string
  runId: string
  /** Directly identifies the frozen Requirement Release used as the audit basis. */
  requirementReleaseId: string
  caseSetSha256: string
  inputSha256: string
  status: 'valid' | 'stale'
  statistics: { totalBasis: number; coveredBasis: number; totalCases: number }
  relations: Array<{ basisRef: string; requirementId: string; caseId?: string; status: 'covered' | 'not_covered'; reason: string }>
  blockers: Array<{
    code: string
    message: string
    subjectId?: string
    resolution: 'agent_repair' | 'human_decision' | 'manual_edit' | 'execution_handoff'
    details?: { reasons?: string[] }
  }>
  /** Optimization suggestions never participate in publication gates. */
  advisories: Array<{
    code: string
    message: string
    subjectId?: string
    details?: { reasons?: string[] }
  }>
  createdAt: string
}

export interface TestDesignAutomaticRepairState {
  status: 'idle' | 'queued' | 'running' | 'succeeded' | 'exhausted' | 'deferred' | 'not_needed'
  attempt: number
  maxAttempts: number
  blockerCodes: string[]
  /** The exact agent-repair blockers selected by the scope-aware repair gate. */
  blockerScopes?: Array<{ code: string; subjectId?: string }>
  triggerAuditId?: string
  startedAt?: string
  finishedAt?: string
}

export interface TestCaseLibraryVersionMember {
  caseId: string
  revision: number
  ordinal: number
  contentSha256: string
  frozenContent?: TestCaseContent
  /** Query-friendly projection of the methods already present in frozenContent. */
  frozenExecutionMethods?: Array<'ui' | 'api'>
  traceability?: TestCaseTraceability
  executionReadiness?: ExecutionReadiness
}
export interface TestCaseLibraryVersionMemberDetail extends TestCaseLibraryVersionMember {
  frozenContent: TestCaseContent
  executionReadiness: ExecutionReadiness
}
export interface TestCaseLibraryVersion {
  id: string
  projectId: string
  version: number
  name: string
  sourceRunId?: string
  members: TestCaseLibraryVersionMember[]
  contentSha256: string
  publishedBy: string
  publishedAt: string
  projection: WorkspaceArtifactProjection
  publicationSummary?: {
    proposalStatistics: Record<CaseChangeOperation, number>
    dimensionStatistics: Partial<Record<TestDimension, number>>
    coverageAudit: { id: string; statistics: CoverageAudit['statistics']; blockerCount: number }
  }
}
export interface TestCaseLibraryVersionDetail extends Omit<TestCaseLibraryVersion, 'members'> { members: TestCaseLibraryVersionMemberDetail[] }

export interface WorkspaceArtifactProjection {
  status: 'pending' | 'succeeded' | 'failed'
  files: Array<{ logicalPath: string; contentSha256: string; assetVersionId?: string }>
  error?: string
}

export interface TestSuiteVersionMember { testCaseLibraryVersionId: string; caseId: string; revision: number; executionMethods: Array<'ui' | 'api'>; ordinal: number; reason: string }
export interface TestSuiteVersion { id: string; projectId: string; suiteKey: string; suiteType: 'smoke' | 'regression' | 'custom' | 'functional_domain'; version: number; name: string; testCaseLibraryVersionId?: string; compatibilityStatus?: 'compatible' | 'migration_required'; incompatibilityReason?: string; members: TestSuiteVersionMember[]; contentSha256: string; publishedBy: string; publishedAt: string; status?: 'active' | 'deprecated'; deprecatedBy?: string; deprecatedAt?: string }
export interface TestSuiteDraft { id: string; projectId: string; suiteKey: string; suiteType: 'smoke' | 'regression' | 'custom'; name: string; testCaseLibraryVersionId?: string; compatibilityStatus?: 'compatible' | 'migration_required'; incompatibilityReason?: string; members: TestSuiteVersionMember[]; contentSha256: string; status: 'draft' | 'published'; createdBy: string; createdAt: string; updatedBy: string; updatedAt: string; publishedVersionId?: string }
export interface TestExecutionHandoffMember { stage: 'smoke' | 'new_feature' | 'impacted_regression' | 'full_regression' | TestExecutionMode; ordinal: number; sourceVersionId: string; caseId: string; revision: number; method: TestExecutionMethod; reason: string; dedupKey: string; dimension?: TestDimension; executionSpec?: TestCaseExecutionSpec; traceability?: TestCaseTraceability; selectionReason?: string; contentSha256?: string; readinessOverride?: { reason: string; actorId: string; createdAt: string } }
export interface TestExecutionHandoff { id: string; projectId: string; projectVersionId: string; testCaseLibraryVersionId: string; suiteVersionId?: string; mode: TestExecutionMode; members: TestExecutionHandoffMember[]; contentSha256: string; createdBy: string; createdAt: string }


export interface TestDesignWorkflowRun {
  id: string
  testDesignId: string
  projectVersionId: string
  status: WorkflowStatus
  stage: TestDesignNodeKey | 'completed' | 'cancelled' | 'failed'
  progress: number
  idempotencyKey: string
  /** Frozen UI/API channels requested by the TestDesign input for this Run. */
  requestedExecutionMethods?: Array<'ui' | 'api'>
  basisSnapshot: TestDesignBasisSnapshot
  agentConfigurationSnapshot: TestDesignRunAgentConfigurationSnapshot
  currentInputRefs: CurrentInputRef[]
  workspaceSnapshot: TestDesignWorkspaceSnapshot
  formalWorkspaceFiles: TestDesignWorkspaceFile[]
  retrievalSnapshot: RetrievalSnapshot
  historicalSnapshot: HistoricalCaseSnapshot
  baseTestCaseLibraryVersionId?: string
  baseTestCaseLibraryVersionSha256?: string
  nodeRuns: WorkflowNodeRun[]
  artifacts: WorkflowArtifact[]
  gateDecisions: WorkflowGateDecision[]
  testCases: TestCase[]
  caseChangeProposals: CaseChangeProposal[]
  coverageAudits: CoverageAudit[]
  automaticRepair?: TestDesignAutomaticRepairState
  planningSubAgentRuns?: PlanningSubAgentRunRecord[]
  events: AgentExecutionEvent[]
  createdBy: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  errorCode?: string
  error?: string
}

export interface TestDesignState {
  architectureVersion: 'single-agent-skills/v1'
  designs: TestDesign[]
  runs: TestDesignWorkflowRun[]
  libraryCases: LibraryTestCase[]
  libraryVersions: TestCaseLibraryVersion[]
  suiteDrafts: TestSuiteDraft[]
  suiteVersions: TestSuiteVersion[]
  executionHandoffs: TestExecutionHandoff[]
}
