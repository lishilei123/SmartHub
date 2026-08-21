import type { AgentDefinitionVersion, AgentExecutionEvent, CurrentInputRef, InputDeliveryManifest, PlanningSubAgentRunRecord, ProjectWorkspaceSnapshot, ProjectWorkspaceSnapshotFile } from './agent-types.js'
import type { AgentExecutionRecord } from './types.js'
import type { AgentRoutingConfiguration } from './types.js'
import type { PlanningClarification } from './review-types.js'

export type TestDimension = 'functional' | 'performance' | 'stability' | 'compatibility' | 'security'
export type TestExecutionMethod = 'ui' | 'api' | 'performance_tool' | 'long_running' | 'environment_matrix'
export type TestExecutionMode = 'smoke' | 'regression' | 'full' | 'custom'
export type WorkflowStatus = 'queued' | 'running' | 'waiting_gate' | 'succeeded' | 'failed' | 'cancelled'
export type WorkflowNodeStatus = 'pending' | 'queued' | 'running' | 'waiting_gate' | 'succeeded' | 'failed' | 'cancelled' | 'stale'
export type TestCaseReviewState = 'draft' | 'in_review' | 'approved' | 'rejected' | 'needs_revision'
export type ExecutionReadiness = 'ready' | 'blocked' | 'needs_confirmation'
export type ScenarioClaimKind = 'crud_lifecycle' | 'state_transition' | 'enum' | 'validation' | 'filter' | 'search' | 'permission' | 'boundary' | 'exception' | 'statistics' | 'cross_channel_consistency' | 'other'
export type ScenarioClaimPolarity = 'positive' | 'negative' | 'neutral'

/**
 * Candidate-only reasoning record. It makes the PlanningAgent account for
 * every selected test dimension without turning dimension selection into a
 * new human gate or a one-case-per-dimension rule.
 */
export interface DimensionAssessment {
  dimension: TestDimension
  applicable: boolean
  reason: string
  /** Direct frozen Requirement Release references supporting the judgement. */
  requirementRefs: string[]
  risks: string[]
  /** Scenario-family descriptions; they are a coverage map, not TestCase IDs. */
  scenarioClaims: string[]
}

/**
 * Run-scoped candidate metadata used to audit one Case's atomic test intent.
 * It is deliberately not a formal TestCase, Version, Revision, or Workspace asset.
 */
export interface ScenarioClaim {
  ref: string
  caseRef: string
  requirementRefs: string[]
  kind: ScenarioClaimKind
  subject: string
  variant: string
  polarity: ScenarioClaimPolarity
  oracle: string
  /** A state-transition claim declares exactly one concrete edge. */
  transition?: { from: string; to: string }
  knowledgeRefs?: string[]
}

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
  /** 明确选择的已发布 Requirement Release；省略时使用当前默认绑定。 */
  requirementReleaseId?: string
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
  creationMode?: 'automatic' | 'manual'
  sourceRequirementReleaseId?: string
}

export interface FrozenContentRef {
  id: string
  kind: 'requirement_release' | 'human_clarification' | 'knowledge_asset' | 'historical_case_set' | 'historical_case_asset' | 'test_case_library' | 'historical_test_suite'
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
  clarifications: PlanningClarification[]
  createdAt: string
  snapshotSha256: string
}

export interface TestDesignWorkspaceFile extends ProjectWorkspaceSnapshotFile {
  logicalPath: string
  sourceType: 'asset_version' | 'requirement_release' | 'test_case_set_version' | 'test_case_library_version' | 'run_candidate'
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

export interface HistoricalCaseSnapshot {
  schemaVersion: 'historical-case-snapshot/v1'
  items: FrozenContentRef[]
  /**
   * The data set frozen with the selected Library Version. It is copied into
   * a new Run only by the Service when a v2 reference submission reuses the
   * corresponding frozen Cases; it is never supplied by the PlanningAgent.
   */
  dataRequirements?: TestDataRequirement[]
  baseTestCaseLibraryVersionId?: string
  baseTestCaseLibraryVersionSha256?: string
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
  /** Direct Requirement Release coverage references. */
  requirementRefs: string[]
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
  /** Directly identifies the frozen Requirement Release used as the audit basis. */
  requirementReleaseId: string
  dataSetVersionId: string
  caseSetSha256: string
  inputSha256: string
  status: 'valid' | 'stale'
  statistics: { totalBasis: number; coveredBasis: number; totalCases: number }
  relations: Array<{ basisRef: string; requirementId: string; caseId?: string; status: 'covered' | 'partially_covered' | 'not_covered' | 'needs_confirmation'; reason: string }>
  blockers: Array<{
    code: string
    message: string
    subjectId?: string
    resolution: 'agent_repair' | 'human_decision' | 'manual_edit' | 'execution_handoff'
    details?: { scenarioRefs?: string[]; reasons?: string[]; suggestedSplitCount?: number }
  }>
  /** Optimization suggestions never participate in publication gates. */
  advisories: Array<{
    code: string
    message: string
    subjectId?: string
    details?: { scenarioRefs?: string[]; reasons?: string[]; suggestedSplitCount?: number }
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
  dataSetVersionId: string
  coverageAuditId: string
  members: TestCaseSetMember[]
  canonicalContent: unknown
  contentSha256: string
  publishedBy: string
  publishedAt: string
  projection: WorkspaceArtifactProjection
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
  legacyTestCaseSetVersionId?: string
  /** Separately frozen test-data requirement definitions; never contains runtime values. */
  dataRequirementSet?: TestDataRequirementSetVersion
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

/**
 * Functional/security suite members freeze one or more UI/API methods in
 * executionMethods. executionMethod remains only for historical members and
 * the single-method non-functional execution contracts.
 */
export interface TestSuiteVersionMember { testCaseSetVersionId?: string; testCaseLibraryVersionId?: string; caseId: string; revision: number; executionMethods?: Array<'ui' | 'api'>; executionMethod?: TestExecutionMethod; ordinal: number; reason: string }
export interface TestSuiteVersion { id: string; projectId: string; suiteKey: string; suiteType: 'smoke' | 'regression' | 'custom' | 'functional_domain'; version: number; name: string; testCaseLibraryVersionId?: string; compatibilityStatus?: 'compatible' | 'migration_required'; incompatibilityReason?: string; members: TestSuiteVersionMember[]; contentSha256: string; publishedBy: string; publishedAt: string; status?: 'active' | 'deprecated'; deprecatedBy?: string; deprecatedAt?: string }
export interface TestSuiteDraft { id: string; projectId: string; suiteKey: string; suiteType: 'smoke' | 'regression' | 'custom'; name: string; testCaseLibraryVersionId?: string; compatibilityStatus?: 'compatible' | 'migration_required'; incompatibilityReason?: string; members: TestSuiteVersionMember[]; contentSha256: string; status: 'draft' | 'published'; createdBy: string; createdAt: string; updatedBy: string; updatedAt: string; publishedVersionId?: string }
export interface SmokeCandidateRelation { testCaseSetVersionId?: string; caseId: string; executionMethods: Array<'ui' | 'api'>; reason: string; estimatedMinutes: number; stable: boolean; dependencyReady: boolean; decision: 'pending' | 'accepted' | 'rejected'; actorId?: string; reviewedAt?: string }
export interface ImpactedRegressionReference { testCaseSetVersionId?: string; suiteVersionId: string; caseId: string; executionMethods: Array<'ui' | 'api'>; reason: string; actorId: string; createdAt: string }
export interface TestExecutionHandoffMember { stage: 'smoke' | 'new_feature' | 'impacted_regression' | 'full_regression' | TestExecutionMode; ordinal: number; sourceVersionId: string; caseId: string; revision: number; method: TestExecutionMethod; reason: string; dedupKey: string; dimension?: TestDimension; executionSpec?: TestCaseExecutionSpec; traceability?: TestCaseTraceability; selectionReason?: string; contentSha256?: string; readinessOverride?: { reason: string; actorId: string; createdAt: string } }
export interface TestExecutionDataRequirementSnapshot { sourceSetId: string; sourceSetVersion: number; sourceSetSha256: string; requirements: TestDataRequirement[]; contentSha256: string }
export interface TestExecutionHandoff { id: string; projectId: string; projectVersionId: string; testCaseSetVersionId?: string; testCaseLibraryVersionId?: string; suiteVersionId?: string; strategy?: 'standard' | 'fast' | 'full'; mode?: TestExecutionMode; smokeSuiteVersionId?: string; regressionSuiteVersionId?: string; members: TestExecutionHandoffMember[]; testDataSnapshot?: TestExecutionDataRequirementSnapshot; contentSha256: string; createdBy: string; createdAt: string }

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
export interface ConfirmationItem { id: string; title: string; question: string; decisionType: string; impactStage: 'analysis' | 'case' | 'data' | 'publication' | 'handoff'; affectedRefs: string[]; blocker: boolean; state: 'open' | 'confirmed' | 'resolved' | 'deferred' | 'rejected'; actions: TestDesignDispositionAction[]; executionIssueSignature?: string }

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
  /** Current candidate-only audit metadata; never promoted into the formal library. */
  scenarioClaims: ScenarioClaim[]
  /** Current candidate-only dimension coverage map; never promoted into the formal library. */
  dimensionAssessments: DimensionAssessment[]
  caseChangeProposals: CaseChangeProposal[]
  dataSetVersions: TestDataRequirementSetVersion[]
  coverageAudits: CoverageAudit[]
  smokeCandidates: SmokeCandidateRelation[]
  impactedRegression: ImpactedRegressionReference[]
  findings: DesignFinding[]
  confirmationItems: ConfirmationItem[]
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
  caseSetVersions: TestCaseSetVersion[]
  libraryCases: LibraryTestCase[]
  libraryVersions: TestCaseLibraryVersion[]
  suiteDrafts: TestSuiteDraft[]
  suiteVersions: TestSuiteVersion[]
  executionHandoffs: TestExecutionHandoff[]
  legacyMigrations: LegacyTestCaseMigrationRecord[]
}
