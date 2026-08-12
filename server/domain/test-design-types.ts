import type { AgentDefinitionVersion, AgentExecutionEvent } from './agent-types.js'
import type { AgentExecutionRecord } from './types.js'
import type { AgentRoutingConfiguration } from './types.js'

export type TestDimension = 'functional' | 'performance' | 'stability' | 'compatibility' | 'security'
export type TestExecutionMethod = 'ui' | 'api' | 'performance_tool' | 'long_running' | 'environment_matrix'
export type TestExecutionMode = 'smoke' | 'regression' | 'full' | 'custom'
export type WorkflowStatus = 'queued' | 'running' | 'waiting_gate' | 'succeeded' | 'failed' | 'cancelled'
export type WorkflowNodeStatus = 'pending' | 'queued' | 'running' | 'waiting_gate' | 'succeeded' | 'failed' | 'cancelled' | 'stale'
export type TestCaseReviewState = 'draft' | 'in_review' | 'approved' | 'rejected' | 'needs_revision'
export type ExecutionReadiness = 'ready' | 'blocked' | 'needs_confirmation'

export interface ScopeRule { kind: string; value: string }
export interface HistoricalCaseSelection {
  sourceType: 'test_case_set' | 'asset_version'
  testCaseSetVersionId?: string
  caseIds?: string[]
  assetVersionId?: string
}

export type HistoricalLibrarySelection =
  | { mode: 'latest_library' }
  | { mode: 'library_version'; testCaseLibraryVersionId: string }
  | { mode: 'suite_version'; suiteVersionId: string }
  | { mode: 'none' }

export type KnowledgeAugmentation =
  | { mode: 'disabled' }
  | { mode: 'selected_assets'; assetVersionIds: string[] }
  | { mode: 'fixed_index'; indexVersionId: string; filters?: Record<string, string | string[]> }

export interface CreateTestDesignCommon {
  name: string
  objective: string
  includedScopes?: ScopeRule[]
  excludedScopes?: ScopeRule[]
  focusDimensions?: TestDimension[]
  executionMethods?: Array<'ui' | 'api'>
  userCoverageObjectives?: string[]
  knowledgeAugmentation: KnowledgeAugmentation
  historicalCaseSelections?: HistoricalCaseSelection[]
  historicalLibrarySelection?: HistoricalLibrarySelection
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
}

export interface FrozenContentRef {
  id: string
  kind: 'requirement_release' | 'knowledge_asset' | 'historical_case_set' | 'historical_case_asset' | 'test_case_library' | 'historical_test_suite'
  sourceId: string
  contentSha256: string
  content: unknown
  locator?: Record<string, unknown>
}

export interface TestDesignBasisSnapshot {
  schemaVersion: 'test-design-basis-snapshot/v2'
  projectVersionId: string
  requirementReleaseId: string
  verificationRunId: string
  requirementsJsonSha256: string
  items: FrozenContentRef[]
  createdAt: string
  snapshotSha256: string
}

export interface TestDesignWorkspaceFile {
  logicalPath: string
  sourceType: 'asset_version' | 'requirement_release' | 'test_point_tree_version' | 'test_case_set_version' | 'test_case_library_version' | 'run_candidate'
  sourceId: string
  contentSha256: string
  content: string
  assetId?: string
  assetVersionId?: string
  displayName: string
}

export interface TestDesignWorkspaceSnapshot {
  schemaVersion: 'test-design-workspace-snapshot/v1'
  rootLogicalPath: 'workspace'
  activeBranchLogicalPath: string
  agentLogicalPath: 'workspace/agent_workspace/design_agent'
  projectVersionId: string
  projectVersionName: string
  knowledgeBaseId: string
  indexVersionId: string
  requirementReleaseId: string
  verificationRunId: string
  requirementsJsonSha256: string
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
  primaryModel: { sourceId: string; modelId: string; modelName: string }
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

export interface HistoricalCaseSnapshot {
  schemaVersion: 'historical-case-snapshot/v1'
  items: FrozenContentRef[]
  baseTestCaseLibraryVersionId?: string
  baseTestCaseLibraryVersionSha256?: string
  createdAt: string
  snapshotSha256: string
}

export type TestDesignNodeKey = 'test_point_design' | 'test_point_review' | 'test_case_design' | 'coverage_audit' | 'test_design_repair'
export type TestDesignAgentExecutionRecord = Omit<AgentExecutionRecord, 'agentKey' | 'workflowStage'> & {
  agentKey: 'test-design'
  workflowStage: 'test_point_design' | 'test_case_design' | 'test_design_repair'
  agentVersion: string
  modelLabel: string
  degraded: boolean
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
  execution?: TestDesignAgentExecutionRecord
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
  gateKey: 'test-point-tree'
  targetId: string
  targetRevision: number
  version: number
  decision: 'approved' | 'rejected'
  comment?: string
  actorId: string
  createdAt: string
}

export interface TestPointNodeContent {
  title: string
  objective: string
  dimension: TestDimension
  priority: 'P0' | 'P1' | 'P2' | 'P3'
  applicability: 'applicable' | 'not_applicable' | 'blocked_by_confirmation'
  designTechniques: string[]
  entryMethods: Array<'ui' | 'api'>
  oracle: string
  dataConditions: string[]
  risks: string[]
  assumptions: string[]
  basisRefs: string[]
  historicalRefs: string[]
}

export interface TestPointNodeRevision extends TestPointNodeContent {
  nodeId: string
  parentId: string | null
  sortKey: string
  deleted?: boolean
}

export interface TestPointTreeRevision {
  revision: number
  parentRevision: number | null
  nodes: TestPointNodeRevision[]
  operations: TestPointTreeOperation[]
  reason: string
  actorId: string
  treeSha256: string
  createdAt: string
}

export interface TestPointTreeVersion {
  id: string
  version: number
  revision: number
  treeSha256: string
  approvedBy: string
  approvedAt: string
  projection: WorkspaceArtifactProjection
}

export interface TestPointTree {
  id: string
  runId: string
  currentRevision: number
  revisions: TestPointTreeRevision[]
  versions: TestPointTreeVersion[]
  currentApprovedVersionId?: string
}

export type TestPointTreeOperation =
  | { op: 'add'; clientNodeRef: string; parentId: string | null; sortKey: string; value: TestPointNodeContent }
  | { op: 'rename'; nodeId: string; title: string }
  | { op: 'update'; nodeId: string; patch: Partial<TestPointNodeContent> }
  | { op: 'move'; nodeId: string; parentId: string | null; sortKey: string }
  | { op: 'delete'; nodeId: string }
  | { op: 'mark_not_applicable'; nodeId: string; reason: string }
  | { op: 'reorder'; nodeId: string; sortKey: string }
  | { op: 'split'; nodeId: string; children: Array<{ clientNodeRef: string; sortKey: string; value: TestPointNodeContent }> }
  | { op: 'merge'; sourceNodeIds: string[]; targetNodeId: string; value: Partial<TestPointNodeContent> }

export interface TestStep { key: string; action: string; expected: string }
export interface VerificationCheck { key: string; description: string }
export interface UiExecutionSpec { entry: string; viewport?: string; selectors?: string[] }
export interface ApiExecutionSpec { method: string; path: string; requestSchemaRef?: string; responseSchemaRef?: string }
export type ExecutionMethodSpec =
  | { method: 'ui'; uiSpec: UiExecutionSpec; steps: TestStep[]; verificationChecks: VerificationCheck[]; executionReadiness: ExecutionReadiness; automationHint: string }
  | { method: 'api'; apiSpec: ApiExecutionSpec; steps: TestStep[]; verificationChecks: VerificationCheck[]; executionReadiness: ExecutionReadiness; automationHint: string }

export interface FunctionalExecutionSpec {
  kind: 'functional'
  method: 'ui' | 'api'
  steps: TestStep[]
  verificationChecks: VerificationCheck[]
  preconditions: string[]
  testDataRequirements: string[]
  executionReadiness: ExecutionReadiness
  automationHint: string
}

export interface PerformanceExecutionSpec {
  kind: 'performance'
  method: 'performance_tool'
  target: string
  scenario: string
  virtualUsers: number | null
  duration: string | null
  rampUp: string | null
  thresholds: Array<{ metric: string; target: string; sourceRef: string }>
  dataStrategy: string
  environmentRequirements: string[]
  executionReadiness: ExecutionReadiness
}

export interface StabilityExecutionSpec {
  kind: 'stability'
  method: 'long_running'
  workload: string
  duration: string | null
  interval: string | null
  observations: string[]
  recoveryPolicy: string | null
  checkpointPolicy: string | null
  environmentRequirements: string[]
  executionReadiness: ExecutionReadiness
}

export interface CompatibilityExecutionSpec {
  kind: 'compatibility'
  method: 'environment_matrix'
  baseMethod: 'ui' | 'api'
  baseCaseRefs: string[]
  browserMatrix: string[]
  operatingSystemMatrix: string[]
  viewportMatrix: string[]
  versionMatrix: string[]
  expectedConsistency: string
  executionReadiness: ExecutionReadiness
}

export type TestCaseExecutionSpec = FunctionalExecutionSpec | PerformanceExecutionSpec | StabilityExecutionSpec | CompatibilityExecutionSpec

export interface TestCaseContent {
  schemaVersion: 'test-case/v1' | 'test-case/v2'
  title: string
  objective: string
  dimension: TestDimension
  testPointIds: string[]
  priority: 'P0' | 'P1' | 'P2' | 'P3'
  preconditions: string[]
  dataRequirementIds: string[]
  cleanup: string[]
  dependencies: string[]
  executionMethods: ExecutionMethodSpec[]
  executionSpec?: TestCaseExecutionSpec
  sharedVerificationChecks: VerificationCheck[]
  tags: string[]
  domain: string
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
  testPointRefs: Array<{ testPointTreeVersionId: string; testPointId: string }>
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
export type CaseChangeDecision = 'pending' | 'accepted' | 'accepted_edited' | 'rejected' | 'keep_original' | 'reference' | 'deprecated'

export interface CaseChangeProposalDecisionRecord {
  id: string
  expectedVersion: number
  decision: Exclude<CaseChangeDecision, 'pending'>
  comment?: string
  editedContentSha256?: string
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
  requirementRefs: string[]
  testPointIds: string[]
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
  treeVersionId: string
  origin: 'ai' | 'manual' | 'historical_unchanged' | 'historical_modified' | 'historical_reference'
  candidateRef?: string
  historicalSourceRef?: string
  currentRevision: number
  reviewState: TestCaseReviewState
  revisions: TestCaseRevision[]
  reviewActions: TestCaseReviewAction[]
  tombstonedAt?: string
}

export interface TestDataRequirement {
  id: string
  name: string
  entityType: string
  featureTags: string[]
  testPointIds: string[]
  caseIds: string[]
  fieldConstraints: Record<string, string>
  relationships: string[]
  quantity: number
  initialState: string
  preparationHint: string
  sensitivity: 'public' | 'internal' | 'sensitive'
  isolation: string
  resetAndCleanup: string
  readiness: ExecutionReadiness
  readinessReason?: string
}

export interface TestDataRequirementSetVersion {
  id: string
  version: number
  requirements: TestDataRequirement[]
  contentSha256: string
  createdBy: string
  createdAt: string
}

export interface CoverageAudit {
  id: string
  runId: string
  treeVersionId: string
  dataSetVersionId: string
  caseSetSha256: string
  inputSha256: string
  status: 'valid' | 'stale'
  statistics: { totalBasis: number; coveredBasis: number; totalPoints: number; coveredPoints: number; totalCases: number; approvedCases: number }
  relations: Array<{ basisRef: string; testPointId: string; caseId?: string; status: 'covered' | 'partially_covered' | 'not_covered' | 'needs_confirmation'; reason: string }>
  blockers: Array<{
    code: string
    message: string
    subjectId?: string
    resolution: 'agent_repair' | 'human_review' | 'human_decision' | 'manual_edit'
  }>
  createdAt: string
}

export interface TestDesignAutomaticRepairState {
  status: 'idle' | 'queued' | 'running' | 'succeeded' | 'exhausted' | 'not_needed'
  attempt: number
  maxAttempts: number
  blockerCodes: string[]
  triggerAuditId?: string
  startedAt?: string
  finishedAt?: string
}

export interface TestCaseSetMember { caseId: string; revision: number; ordinal: number; contentSha256: string }
export interface TestCaseSetVersion {
  id: string
  projectId: string
  projectVersionId: string
  testDesignId: string
  runId: string
  version: number
  schemaVersion: 'test-case-set/v1'
  name: string
  treeVersionId: string
  dataSetVersionId: string
  coverageAuditId: string
  members: TestCaseSetMember[]
  canonicalContent: unknown
  contentSha256: string
  publishedBy: string
  publishedAt: string
  projection: WorkspaceArtifactProjection
}

export interface TestCaseLibraryVersionMember { caseId: string; revision: number; ordinal: number; contentSha256: string }
export interface TestCaseLibraryVersion {
  id: string
  projectId: string
  version: number
  name: string
  sourceRunId?: string
  legacyTestCaseSetVersionId?: string
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

export interface WorkspaceArtifactProjection {
  status: 'pending' | 'succeeded' | 'failed'
  files: Array<{ logicalPath: string; contentSha256: string; assetVersionId?: string }>
  error?: string
}

export interface TestSuiteVersionMember { testCaseSetVersionId?: string; testCaseLibraryVersionId?: string; caseId: string; revision: number; executionMethods: Array<'ui' | 'api'>; executionMethod?: TestExecutionMethod; ordinal: number; reason: string }
export interface TestSuiteVersion { id: string; projectId: string; suiteKey: string; suiteType: 'smoke' | 'regression' | 'custom' | 'functional_domain'; version: number; name: string; testCaseLibraryVersionId?: string; compatibilityStatus?: 'compatible' | 'migration_required'; incompatibilityReason?: string; members: TestSuiteVersionMember[]; contentSha256: string; publishedBy: string; publishedAt: string; status?: 'active' | 'deprecated'; deprecatedBy?: string; deprecatedAt?: string }
export interface TestSuiteDraft { id: string; projectId: string; suiteKey: string; suiteType: 'smoke' | 'regression' | 'custom'; name: string; testCaseLibraryVersionId?: string; compatibilityStatus?: 'compatible' | 'migration_required'; incompatibilityReason?: string; members: TestSuiteVersionMember[]; contentSha256: string; status: 'draft' | 'published'; createdBy: string; createdAt: string; updatedBy: string; updatedAt: string; publishedVersionId?: string }
export interface SmokeCandidateRelation { testCaseSetVersionId?: string; caseId: string; executionMethods: Array<'ui' | 'api'>; reason: string; estimatedMinutes: number; stable: boolean; dependencyReady: boolean; decision: 'pending' | 'accepted' | 'rejected'; actorId?: string; reviewedAt?: string }
export interface ImpactedRegressionReference { testCaseSetVersionId?: string; suiteVersionId: string; caseId: string; executionMethods: Array<'ui' | 'api'>; reason: string; actorId: string; createdAt: string }
export interface TestExecutionHandoffMember { stage: 'smoke' | 'new_feature' | 'impacted_regression' | 'full_regression' | TestExecutionMode; ordinal: number; sourceVersionId: string; caseId: string; revision: number; method: TestExecutionMethod; reason: string; dedupKey: string; dimension?: TestDimension; executionSpec?: TestCaseExecutionSpec; traceability?: TestCaseTraceability; selectionReason?: string; contentSha256?: string }
export interface TestExecutionHandoff { id: string; projectId: string; projectVersionId: string; testCaseSetVersionId?: string; testCaseLibraryVersionId?: string; suiteVersionId?: string; strategy?: 'standard' | 'fast' | 'full'; mode?: TestExecutionMode; smokeSuiteVersionId?: string; regressionSuiteVersionId?: string; members: TestExecutionHandoffMember[]; contentSha256: string; createdBy: string; createdAt: string }

export interface LegacyTestCaseMigrationRecord {
  id: string
  projectId: string
  legacyTestCaseSetVersionId: string
  previewSha256: string
  status: 'migrated'
  mappings: Array<{ legacyCaseId: string; legacyRevision: number; libraryCaseId: string; libraryRevision: number; resolution: 'created' | 'reused_identical' | 'created_after_confirmation' }>
  testCaseLibraryVersionId: string
  migratedBy: string
  migratedAt: string
}

export interface TestDesignDispositionAction { id: string; expectedVersion: number; fromState: string; toState: string; decision: string; comment?: string; structuredDecision?: unknown; actorId: string; createdAt: string }
export interface DesignFinding { id: string; title: string; description: string; severity: 'blocker' | 'high' | 'medium' | 'low'; basisRefs: string[]; state: 'open' | 'confirmed' | 'resolved' | 'deferred' | 'rejected'; actions: TestDesignDispositionAction[] }
export interface ConfirmationItem { id: string; title: string; question: string; decisionType: string; impactStage: 'analysis' | 'tree' | 'case' | 'data' | 'publication'; affectedRefs: string[]; blocker: boolean; state: 'open' | 'confirmed' | 'resolved' | 'deferred' | 'rejected'; actions: TestDesignDispositionAction[] }

export interface TestDesignWorkflowRun {
  id: string
  testDesignId: string
  projectVersionId: string
  status: WorkflowStatus
  stage: TestDesignNodeKey | 'completed' | 'cancelled' | 'failed'
  progress: number
  idempotencyKey: string
  basisSnapshot: TestDesignBasisSnapshot
  agentConfigurationSnapshot: TestDesignRunAgentConfigurationSnapshot
  workspaceSnapshot: TestDesignWorkspaceSnapshot
  formalWorkspaceFiles: TestDesignWorkspaceFile[]
  retrievalSnapshot: RetrievalSnapshot
  historicalSnapshot: HistoricalCaseSnapshot
  baseTestCaseLibraryVersionId?: string
  baseTestCaseLibraryVersionSha256?: string
  nodeRuns: WorkflowNodeRun[]
  artifacts: WorkflowArtifact[]
  gateDecisions: WorkflowGateDecision[]
  testPointTree?: TestPointTree
  testCases: TestCase[]
  caseChangeProposals: CaseChangeProposal[]
  dataSetVersions: TestDataRequirementSetVersion[]
  coverageAudits: CoverageAudit[]
  smokeCandidates: SmokeCandidateRelation[]
  impactedRegression: ImpactedRegressionReference[]
  findings: DesignFinding[]
  confirmationItems: ConfirmationItem[]
  automaticRepair?: TestDesignAutomaticRepairState
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
  caseSetVersions: TestCaseSetVersion[]
  libraryCases: LibraryTestCase[]
  libraryVersions: TestCaseLibraryVersion[]
  suiteDrafts: TestSuiteDraft[]
  suiteVersions: TestSuiteVersion[]
  executionHandoffs: TestExecutionHandoff[]
  legacyMigrations: LegacyTestCaseMigrationRecord[]
}
