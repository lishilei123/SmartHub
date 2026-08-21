import type { AgentExecutionContext, PlanningSubAgentRunRecord } from '../planning-api'

export type TestDimension = 'functional' | 'performance' | 'stability' | 'compatibility' | 'security'
export type ExecutionMethod = 'ui' | 'api'
export type TestExecutionMethod = ExecutionMethod | 'performance_tool' | 'long_running' | 'environment_matrix'
export type DimensionAssessment = { dimension: TestDimension; applicable: boolean; reason: string; requirementRefs: string[]; risks: string[]; scenarioClaims: string[] }
export type TestExecutionMode = 'smoke' | 'regression' | 'full' | 'custom'
export type ReviewState = 'draft' | 'in_review' | 'approved' | 'rejected' | 'needs_revision'

export type TestDesignInputCandidates = {
  projectVersion: { id: string; projectId: string; name: string; status: string }
  requirementRelease: { id: string; analysisRunId: string; contentSha256: string; publishedAt?: string; label: string } | null
  requirementReleases: Array<{ id: string; analysisRunId: string; contentSha256: string; publishedAt?: string; label: string; active: boolean }>
  knowledgeAssets: Array<{ assetId: string; assetVersionId: string; displayName: string; logicalPath: string; assetType: string; status: string; selectable: boolean; reason?: string }>
  fixedIndexes: Array<{ id: string; selectable: boolean }>
  historicalCaseSets: Array<{ id: string; name: string; version: number; memberCount: number; contentSha256: string }>
  testCaseLibraryVersions: Array<{ id: string; name: string; version: number; memberCount: number; contentSha256: string; publishedAt: string }>
  historicalTestSuites: Array<{ id: string; name: string; suiteKey: string; suiteType: string; version: number; memberCount: number; contentSha256: string }>
  historicalCaseAssets: Array<{ assetId: string; assetVersionId: string; displayName: string; logicalPath: string; selectable: boolean }>
  agentReadiness: { ready: boolean; agents: Array<{ agentKey: string; ready: boolean; reason?: string }> }
}

export type CreateTestDesignInput = {
  name: string
  objective: string
  requirementReleaseId?: string
  includedScopes: Array<{ kind: string; value: string }>
  excludedScopes: Array<{ kind: string; value: string }>
  focusDimensions: TestDimension[]
  executionMethods: ExecutionMethod[]
  userCoverageObjectives: string[]
  knowledgeAugmentation: { mode: 'disabled' } | { mode: 'selected_assets'; assetVersionIds: string[] } | { mode: 'fixed_index'; indexVersionId: string }
  historicalCaseSelections?: Array<{ sourceType: 'asset_version'; assetVersionId: string }>
  historicalLibrarySelection: { mode: 'latest_library' } | { mode: 'library_version'; testCaseLibraryVersionId: string } | { mode: 'suite_version'; suiteVersionId: string } | { mode: 'none' }
}

export type TestDesign = {
  id: string
  projectId: string
  projectVersionId: string
  name: string
  objective: string
  input: CreateTestDesignInput
  logicalInputSha256: string
  creationMode?: 'automatic' | 'manual'
  sourceRequirementReleaseId?: string
  createdAt: string
  latestRun?: TestDesignRunSummary | null
}

export type TestDesignRunSummary = {
  id: string
  testDesignId: string
  projectVersionId: string
  status: string
  stage: string
  progress: number
  createdAt: string
  startedAt?: string
  finishedAt?: string
  errorCode?: string
  error?: string
}

export type AgentEvent = {
  sequence: number
  type: string
  occurredAt: string
  turn?: number
  toolId?: string
  toolCallId?: string
  isError?: boolean
  role?: 'user' | 'assistant' | 'tool'
  content?: string
  toolCalls?: { id: string; name: string }[]
  toolArguments?: unknown
  toolResult?: unknown
  skillKey?: string
  version?: string
  stopReason?: string
  model?: string
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }
}

export type TestDesignNodeRun = {
  id: string
  nodeKey: 'test_case_design' | 'coverage_audit' | 'test_design_repair'
  generation: number
  attempt: number
  status: string
  dependencies: string[]
  startedAt?: string
  finishedAt?: string
  errorCode?: string
  error?: string
  execution?: { agentKey: 'planning'; workflowStage: 'test_case_design' | 'test_design_repair'; agentVersion: string; modelLabel: string; turns: number; toolCalls: number; toolErrors?: number; context?: AgentExecutionContext; inputDeliveryManifest?: { toolReads?: Array<{ toolCallId: string; relativePath: string; sourceScope?: 'current_input' | 'current_branch' | 'shared' | 'historical_branch' | 'formal_output' }> }; events: AgentEvent[] }
}

export type TestCaseContent = {
  schemaVersion: 'test-case/v1' | 'test-case/v2'
  title: string
  objective: string
  dimension: TestDimension
  requirementRefs: string[]
  priority: 'P0' | 'P1' | 'P2' | 'P3'
  preconditions: string[]
  dataRequirementIds: string[]
  cleanup: string[]
  dependencies: string[]
  executionMethods: Array<({ method: 'ui'; uiSpec: { entry: string; viewport?: string; selectors?: string[] } } | { method: 'api'; apiSpec: { method: string; path: string; requestSchemaRef?: string; responseSchemaRef?: string } }) & { executionReadiness: 'ready' | 'blocked' | 'needs_confirmation'; steps: Array<{ key: string; action: string; expected: string }>; verificationChecks: Array<{ key: string; description: string }>; automationHint: string }>
  executionSpec?: TestCaseExecutionSpec
  sharedVerificationChecks: Array<{ key: string; description: string }>
  tags: string[]
  domain: string
}

/** Candidate-only Atomic Test Intent metadata. It is not a published test asset. */
export type ScenarioClaim = {
  ref: string
  caseRef: string
  requirementRefs: string[]
  kind: 'crud_lifecycle' | 'state_transition' | 'enum' | 'validation' | 'filter' | 'search' | 'permission' | 'boundary' | 'exception' | 'statistics' | 'cross_channel_consistency' | 'other'
  subject: string
  variant: string
  polarity: 'positive' | 'negative' | 'neutral'
  oracle: string
  transition?: { from: string; to: string }
  knowledgeRefs?: string[]
}

export type TestCaseTraceability = {
  sourceRequirementReleaseId: string
  requirementRefs: Array<{ requirementReleaseId: string; requirementId: string }>
}

export type TestDesignCase = {
  id: string
  candidateRef?: string
  origin: 'ai' | 'manual' | 'historical_unchanged' | 'historical_modified' | 'historical_reference'
  currentRevision: number
  reviewState: ReviewState
  revisions: Array<{ revision: number; content: TestCaseContent; contentSha256: string; createdAt: string }>
  reviewActions: Array<{ id: string; targetRevision?: number; fromState?: ReviewState; toState?: ReviewState; decision: string; comment?: string; actorId?: string; createdAt: string }>
  tombstonedAt?: string
}

export type TestDataRequirement = { id: string; name: string; entityType: string; featureTags: string[]; requirementRefs?: string[]; caseIds: string[]; fieldConstraints: Record<string, string>; relationships: string[]; quantity: number; initialState: string; preparationHint: string; sensitivity: 'public' | 'internal' | 'sensitive'; isolation: string; resetAndCleanup: string; readiness: 'ready' | 'blocked' | 'needs_confirmation'; readinessReason?: string }
export type TestDataSetVersion = { id: string; version: number; contentSha256: string; createdBy?: string; createdAt: string; requirements: TestDataRequirement[] }
export type TestDesignCoverageAudit = { id: string; requirementReleaseId: string; dataSetVersionId: string; status: 'valid' | 'stale'; caseSetSha256: string; inputSha256: string; statistics: { totalBasis: number; coveredBasis: number; totalCases: number; approvedCases: number }; blockers: Array<{ code: string; message: string; subjectId?: string; resolution: 'agent_repair' | 'human_review' | 'human_decision' | 'manual_edit' | 'execution_handoff'; details?: { scenarioRefs?: string[]; reasons?: string[]; suggestedSplitCount?: number } }>; advisories: Array<{ code: string; message: string; subjectId?: string; details?: { scenarioRefs?: string[]; reasons?: string[]; suggestedSplitCount?: number } }>; createdAt: string }
export type WorkspaceProjection = { status: 'pending' | 'succeeded' | 'failed'; files: Array<{ logicalPath: string; contentSha256: string; assetVersionId?: string }>; error?: string }
export type TestCaseSetVersion = { id: string; projectId: string; projectVersionId: string; testDesignId: string; runId: string; version: number; name: string; members: Array<{ caseId: string; revision: number; ordinal: number; contentSha256: string }>; contentSha256: string; publishedBy: string; publishedAt: string; projection: WorkspaceProjection }
export type TestSuiteVersion = { id: string; projectId: string; suiteType: 'smoke' | 'regression' | 'functional_domain'; version: number; name: string; members: Array<{ caseId: string; revision: number; executionMethods: ExecutionMethod[] }> }
export type TestExecutionHandoff = { id: string; testCaseSetVersionId: string; strategy: 'standard' | 'fast' | 'full'; members: Array<{ stage: string; caseId: string; method: ExecutionMethod }>; contentSha256: string; createdAt: string }

export type FunctionalExecutionSpec = { kind: 'functional'; method: ExecutionMethod; steps: Array<{ key: string; action: string; expected: string }>; verificationChecks: Array<{ key: string; description: string }>; preconditions: string[]; testDataRequirements: string[]; executionReadiness: 'ready' | 'blocked' | 'needs_confirmation'; automationHint: string }
export type PerformanceExecutionSpec = { kind: 'performance'; method: 'performance_tool'; target: string; scenario: string; virtualUsers: number | null; duration: string | null; rampUp: string | null; thresholds: Array<{ metric: string; target: string; sourceRef: string }>; dataStrategy: string; environmentRequirements: string[]; executionReadiness: 'ready' | 'blocked' | 'needs_confirmation' }
export type StabilityExecutionSpec = { kind: 'stability'; method: 'long_running'; workload: string; duration: string | null; interval: string | null; observations: string[]; recoveryPolicy: string | null; checkpointPolicy: string | null; environmentRequirements: string[]; executionReadiness: 'ready' | 'blocked' | 'needs_confirmation' }
export type CompatibilityExecutionSpec = { kind: 'compatibility'; method: 'environment_matrix'; baseMethod: ExecutionMethod; baseCaseRefs: string[]; browserMatrix: string[]; operatingSystemMatrix: string[]; viewportMatrix: string[]; versionMatrix: string[]; expectedConsistency: string; executionReadiness: 'ready' | 'blocked' | 'needs_confirmation' }
export type TestCaseExecutionSpec = FunctionalExecutionSpec | PerformanceExecutionSpec | StabilityExecutionSpec | CompatibilityExecutionSpec

export type CaseChangeOperation = 'reuse' | 'update' | 'create' | 'deprecate' | 'reference'
export type CaseChangeDecision = 'pending' | 'accepted' | 'accepted_edited' | 'rejected' | 'keep_original' | 'reference' | 'deprecated'
export type CaseChangeProposal = { id: string; runId: string; operation: CaseChangeOperation; sourceCaseId?: string; sourceRevision?: number; candidateCaseId?: string; candidateContent?: TestCaseContent; diff: Array<{ path: string; before?: unknown; after?: unknown }>; requirementRefs: string[]; reason: string; confidence: number; decision: CaseChangeDecision; createdAt: string; decidedBy?: string; decidedAt?: string; decisions: Array<{ id: string; expectedVersion: number; decision: Exclude<CaseChangeDecision, 'pending'>; comment?: string; decidedBy: string; decidedAt: string }>; appliedCaseId?: string; appliedRevision?: number }

export type LibraryTestCaseRevision = { revision: number; content: TestCaseContent; contentSha256: string; semanticSha256: string; sourceRunId?: string; sourceProposalId?: string; traceability?: TestCaseTraceability; changeReason: string; createdBy: string; createdAt: string }
export type LibraryTestCase = { id: string; projectId: string; currentRevision: number; status: 'active' | 'deprecated'; content: TestCaseContent; contentSha256: string; semanticSha256: string; createdAt: string; updatedAt: string; etag: string; revisions?: LibraryTestCaseRevision[] }
export type TestCaseLibraryVersionMemberDetail = { caseId: string; revision: number; ordinal: number; contentSha256: string; frozenContent: TestCaseContent; frozenExecutionMethods?: ExecutionMethod[]; traceability?: TestCaseTraceability; executionReadiness: 'ready' | 'needs_confirmation' | 'blocked' }
export type TestCaseLibraryVersion = { id: string; projectId: string; version: number; name: string; sourceRunId?: string; dataRequirementSet?: TestDataSetVersion; members: TestCaseLibraryVersionMemberDetail[]; contentSha256: string; publishedBy: string; publishedAt: string; projection: WorkspaceProjection; publicationSummary?: { proposalStatistics: Record<CaseChangeOperation, number>; dimensionStatistics: Partial<Record<TestDimension, number>>; coverageAudit: { id: string; statistics: TestDesignCoverageAudit['statistics']; blockerCount: number } } }
/** Functional/security members use executionMethods; executionMethod is kept for historical and non-functional members. */
export type TestSuiteMember = { testCaseLibraryVersionId?: string; caseId: string; revision: number; executionMethods?: ExecutionMethod[]; executionMethod?: TestExecutionMethod; ordinal: number; reason: string }
export type TestSuiteDraft = { id: string; projectId: string; suiteKey: string; suiteType: 'smoke' | 'regression' | 'custom'; name: string; testCaseLibraryVersionId?: string; compatibilityStatus?: 'compatible' | 'migration_required'; incompatibilityReason?: string; members: TestSuiteMember[]; contentSha256: string; status: 'draft' | 'published'; createdBy: string; createdAt: string; updatedBy: string; updatedAt: string; publishedVersionId?: string; etag?: string }
export type LibraryTestSuiteVersion = { id: string; projectId: string; suiteKey: string; suiteType: 'smoke' | 'regression' | 'custom' | 'functional_domain'; version: number; name: string; testCaseLibraryVersionId?: string; compatibilityStatus?: 'compatible' | 'migration_required'; incompatibilityReason?: string; members: TestSuiteMember[]; contentSha256: string; publishedBy: string; publishedAt: string; status?: 'active' | 'deprecated'; deprecatedBy?: string; deprecatedAt?: string }
export type ExecutionReadinessOverrideInput = { caseId: string; revision: number; method?: TestExecutionMethod; reason: string }
export type LibraryExecutionHandoff = { id: string; projectId: string; projectVersionId: string; testCaseLibraryVersionId: string; suiteVersionId?: string; mode: TestExecutionMode; members: Array<{ stage: TestExecutionMode; ordinal: number; sourceVersionId: string; caseId: string; revision: number; method: TestExecutionMethod; reason: string; dimension: TestDimension; executionSpec: TestCaseExecutionSpec; traceability?: TestCaseTraceability; selectionReason: string; contentSha256: string; readinessOverride?: { reason: string; actorId: string; createdAt: string } }>; testDataSnapshot?: { sourceSetId: string; sourceSetVersion: number; sourceSetSha256: string; requirements: TestDataRequirement[]; contentSha256: string }; contentSha256: string; createdBy: string; createdAt: string }

export type TestDesignWorkflowRun = TestDesignRunSummary & {
  basisSnapshot: { schemaVersion: string; projectVersionId: string; requirementReleaseId: string; verificationRunId: string; requirementsJsonSha256: string; items: unknown[]; clarifications?: unknown[]; snapshotSha256: string; createdAt: string }
  agentConfigurationSnapshot: { configurationId: string; configurationVersion: number; configurationSha256: string; primaryModel: { modelName: string }; snapshotSha256: string }
  currentInputRefs: Array<{ assetId: string; assetVersionId: string; logicalPath: string; contentSha256: string }>
  workspaceSnapshot: { schemaVersion: 'project-workspace-snapshot/v1'; projectId: string; projectVersionId: string; rootLogicalPath: 'workspace'; activeBranchLogicalPath: string; requirementReleaseId: string; verificationRunId: string; requirementsJsonSha256: string; files: Array<{ logicalPath: string; displayName: string; contentSha256: string; assetId?: string; assetVersionId?: string; sourceScope: 'current_input' | 'current_branch' | 'shared' | 'historical_branch' | 'formal_output' }>; snapshotSha256: string; createdAt: string }
  formalWorkspaceFiles: Array<{ logicalPath: string; displayName: string; contentSha256: string; assetVersionId?: string; sourceScope: 'formal_output' }>
  nodeRuns: TestDesignNodeRun[]
  testCases: TestDesignCase[]
  scenarioClaims?: ScenarioClaim[]
  dimensionAssessments?: DimensionAssessment[]
  dataSetVersions: TestDataSetVersion[]
  coverageAudits: TestDesignCoverageAudit[]
  findings: Array<{ id: string; title: string; description: string; severity: string; state: string; actions: Array<{ id: string }> }>
  confirmationItems: Array<{ id: string; title: string; question: string; decisionType?: string; impactStage: string; affectedRefs?: string[]; blocker: boolean; state: string; actions: Array<{ id: string }>; executionIssueSignature?: string }>
  caseChangeProposals: CaseChangeProposal[]
  caseChangeProposalSha256: string
  baseTestCaseLibraryVersionId?: string
  baseTestCaseLibraryVersionSha256?: string
  automaticRepair?: { status: string; attempt: number; maxAttempts: number; blockerCodes: string[] }
  planningSubAgentRuns?: PlanningSubAgentRunRecord[]
  /** Legacy run payload shape retained only for the unmounted historical component. */
  caseSetVersions?: TestCaseSetVersion[]
}
