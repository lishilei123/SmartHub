import type { AgentExecutionEvent } from './agent-types.js'
import type { AgentExecutionRecord } from './types.js'

export type TestDesignBasisMode = 'review_baseline' | 'knowledge_assets'
export type TestDimension = 'functional' | 'performance' | 'stability' | 'compatibility' | 'security'
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
  userCoverageObjectives?: string[]
  knowledgeAugmentation: KnowledgeAugmentation
  historicalCaseSelections?: HistoricalCaseSelection[]
}

export type CreateTestDesignInput = CreateTestDesignCommon & (
  | { basisMode: 'review_baseline'; sourceReviewRunId: string; sourceTechnicalSolutionRunId: string }
  | { basisMode: 'knowledge_assets'; knowledgeAssetVersionIds: string[] }
)

export interface TestDesign {
  id: string
  projectVersionId: string
  projectId: string
  name: string
  objective: string
  basisMode: TestDesignBasisMode
  input: CreateTestDesignInput
  logicalInputSha256: string
  createdBy: string
  createdAt: string
}

export interface FrozenContentRef {
  id: string
  kind: 'requirement_review' | 'technical_solution_review' | 'knowledge_asset' | 'historical_case_set' | 'historical_case_asset'
  sourceId: string
  contentSha256: string
  content: unknown
  locator?: Record<string, unknown>
}

export interface TestDesignBasisSnapshot {
  schemaVersion: 'test-design-basis-snapshot/v1'
  basisMode: TestDesignBasisMode
  projectVersionId: string
  items: FrozenContentRef[]
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
  createdAt: string
  snapshotSha256: string
}

export type TestDesignNodeKey = 'test_analysis' | 'scope_gate' | 'functional_design' | 'non_functional_design' | 'tree_merge' | 'tree_gate' | 'test_case_synthesis' | 'coverage_audit'
export type TestDesignAgentExecutionRecord = Omit<AgentExecutionRecord, 'agentKey'> & {
  agentKey: 'test-analysis' | 'functional-test-design' | 'non-functional-test-design' | 'test-case-synthesis'
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
  gateKey: 'scope' | 'test-point-tree'
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

export interface TestCaseContent {
  schemaVersion: 'test-case/v1'
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
  blockers: Array<{ code: string; message: string; subjectId?: string }>
  createdAt: string
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
  projection: { status: 'pending' | 'succeeded' | 'failed'; assetVersionId?: string; error?: string }
}

export interface TestSuiteVersionMember { testCaseSetVersionId: string; caseId: string; revision: number; executionMethods: Array<'ui' | 'api'>; ordinal: number; reason: string }
export interface TestSuiteVersion { id: string; projectId: string; suiteKey: string; suiteType: 'smoke' | 'regression' | 'functional_domain'; version: number; name: string; members: TestSuiteVersionMember[]; contentSha256: string; publishedBy: string; publishedAt: string }
export interface SmokeCandidateRelation { caseId: string; executionMethods: Array<'ui' | 'api'>; reason: string; estimatedMinutes: number; stable: boolean; dependencyReady: boolean; decision: 'pending' | 'accepted' | 'rejected'; actorId?: string; reviewedAt?: string }
export interface ImpactedRegressionReference { suiteVersionId: string; caseId: string; executionMethods: Array<'ui' | 'api'>; reason: string; actorId: string; createdAt: string }
export interface TestExecutionHandoffMember { stage: 'smoke' | 'new_feature' | 'impacted_regression' | 'full_regression'; ordinal: number; sourceVersionId: string; caseId: string; revision: number; method: 'ui' | 'api'; reason: string; dedupKey: string }
export interface TestExecutionHandoff { id: string; projectId: string; projectVersionId: string; testCaseSetVersionId: string; strategy: 'standard' | 'fast' | 'full'; smokeSuiteVersionId?: string; regressionSuiteVersionId?: string; members: TestExecutionHandoffMember[]; contentSha256: string; createdBy: string; createdAt: string }

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
  retrievalSnapshot: RetrievalSnapshot
  historicalSnapshot: HistoricalCaseSnapshot
  nodeRuns: WorkflowNodeRun[]
  artifacts: WorkflowArtifact[]
  gateDecisions: WorkflowGateDecision[]
  testPointTree?: TestPointTree
  testCases: TestCase[]
  dataSetVersions: TestDataRequirementSetVersion[]
  coverageAudits: CoverageAudit[]
  smokeCandidates: SmokeCandidateRelation[]
  impactedRegression: ImpactedRegressionReference[]
  findings: DesignFinding[]
  confirmationItems: ConfirmationItem[]
  events: AgentExecutionEvent[]
  createdBy: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  errorCode?: string
  error?: string
}

export interface TestDesignState {
  designs: TestDesign[]
  runs: TestDesignWorkflowRun[]
  caseSetVersions: TestCaseSetVersion[]
  suiteVersions: TestSuiteVersion[]
  executionHandoffs: TestExecutionHandoff[]
}
