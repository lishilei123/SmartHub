import type { AgentExecutionContext, PlanningSubAgentRunRecord } from '../planning-api'

export type TestDimension = 'functional' | 'performance' | 'stability' | 'compatibility' | 'security'
export type ExecutionMethod = 'ui' | 'api'
export type TestExecutionMethod = ExecutionMethod
export type TestExecutionMode = 'smoke' | 'regression' | 'full' | 'custom'
export type ReviewState = 'draft' | 'in_review' | 'approved' | 'rejected' | 'needs_revision'

export type TestDesignInputCandidates = {
  projectVersion: { id: string; projectId: string; name: string; status: string; sourceProjectVersionId?: string; sourceProjectVersionName?: string; inheritRequirementBindings: boolean }
  requirementRelease: { id: string; analysisRunId: string; contentSha256: string; publishedAt?: string; label: string } | null
  requirementReleases: Array<{ id: string; analysisRunId: string; contentSha256: string; publishedAt?: string; label: string; active: boolean }>
  knowledgeAssets: Array<{ assetId: string; assetVersionId: string; displayName: string; logicalPath: string; assetType: string; status: string; selectable: boolean; reason?: string }>
  fixedIndexes: Array<{ id: string; selectable: boolean }>
  historicalBaseline:
    | { status: 'not_inherited' }
    | { status: 'source_library_missing'; sourceProjectVersionId: string; sourceProjectVersionName: string; testCaseLibraryVersion: null }
    | { status: 'source_library_available'; sourceProjectVersionId: string; sourceProjectVersionName: string; testCaseLibraryVersion: { id: string; name: string; version: number; memberCount: number; contentSha256: string; publishedAt: string } }
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
  knowledgeAugmentation: { mode: 'disabled' } | { mode: 'selected_assets'; assetVersionIds: string[] } | { mode: 'fixed_index'; indexVersionId: string }
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
  baseTestCaseLibraryVersionId?: string
  baseTestCaseLibraryVersion?: { id: string; version: number; name: string }
  caseCount?: number
  candidateCaseCount?: number
  effectiveCaseCount?: number
  pendingManualProposalCount?: number
  published?: boolean
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
  schemaVersion: 'test-case/v3'
  title: string
  dimension: TestDimension
  requirementRefs: string[]
  priority: 'P0' | 'P1' | 'P2' | 'P3'
  executionMethods: ExecutionMethod[]
  preconditions: string[]
  steps: string[]
  expectedResults: string[]
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

export type TestDesignCoverageAudit = { id: string; requirementReleaseId: string; status: 'valid' | 'stale'; caseSetSha256: string; inputSha256: string; statistics: { totalBasis: number; coveredBasis: number; totalCases: number }; blockers: Array<{ code: string; message: string; subjectId?: string; resolution: 'agent_repair' | 'human_decision' | 'manual_edit' | 'execution_handoff'; details?: { reasons?: string[] } }>; advisories: Array<{ code: string; message: string; subjectId?: string; details?: { reasons?: string[] } }>; createdAt: string }
export type WorkspaceProjection = { status: 'pending' | 'succeeded' | 'failed'; files: Array<{ logicalPath: string; contentSha256: string; assetVersionId?: string }>; error?: string }
export type TestCaseExecutionSpec = { schemaVersion: 'test-script-input/v1'; method: ExecutionMethod; testCase: TestCaseContent }

export type CaseChangeOperation = 'reuse' | 'update' | 'create' | 'deprecate' | 'reference'
export type CaseChangeDecision = 'pending' | 'accepted' | 'rejected' | 'keep_original' | 'reference' | 'deprecated'
export type CaseChangeProposal = { id: string; runId: string; operation: CaseChangeOperation; sourceCaseId?: string; sourceRevision?: number; candidateCaseId?: string; candidateContent?: TestCaseContent; diff: Array<{ path: string; before?: unknown; after?: unknown }>; requirementRefs: string[]; reason: string; confidence: number; decision: CaseChangeDecision; createdAt: string; decidedBy?: string; decidedAt?: string; decisions: Array<{ id: string; expectedVersion: number; decision: Exclude<CaseChangeDecision, 'pending'>; comment?: string; decidedBy: string; decidedAt: string }>; appliedCaseId?: string; appliedRevision?: number }

export type LibraryTestCaseRevision = { revision: number; content: TestCaseContent; contentSha256: string; semanticSha256: string; sourceRunId?: string; sourceProposalId?: string; traceability?: TestCaseTraceability; changeReason: string; createdBy: string; createdAt: string }
export type LibraryTestCase = { id: string; projectId: string; currentRevision: number; status: 'active' | 'deprecated'; content: TestCaseContent; contentSha256: string; semanticSha256: string; createdAt: string; updatedAt: string; etag: string; revisions?: LibraryTestCaseRevision[] }
export type TestCaseLibraryVersionMemberDetail = { caseId: string; revision: number; ordinal: number; contentSha256: string; frozenContent: TestCaseContent; frozenExecutionMethods?: ExecutionMethod[]; traceability?: TestCaseTraceability; executionReadiness: 'ready' | 'needs_confirmation' | 'blocked' }
export type TestCaseLibraryVersion = { id: string; projectId: string; version: number; name: string; sourceRunId?: string; members: TestCaseLibraryVersionMemberDetail[]; contentSha256: string; publishedBy: string; publishedAt: string; projection: WorkspaceProjection; publicationSummary?: { proposalStatistics: Record<CaseChangeOperation, number>; dimensionStatistics: Partial<Record<TestDimension, number>>; coverageAudit: { id: string; statistics: TestDesignCoverageAudit['statistics']; blockerCount: number } } }
export type TestSuiteMember = { testCaseLibraryVersionId: string; caseId: string; revision: number; executionMethods: ExecutionMethod[]; ordinal: number; reason: string }
export type TestSuiteDraft = { id: string; projectId: string; suiteKey: string; suiteType: 'smoke' | 'regression' | 'custom'; name: string; testCaseLibraryVersionId?: string; compatibilityStatus?: 'compatible' | 'migration_required'; incompatibilityReason?: string; members: TestSuiteMember[]; contentSha256: string; status: 'draft' | 'published'; createdBy: string; createdAt: string; updatedBy: string; updatedAt: string; publishedVersionId?: string; etag?: string }
export type LibraryTestSuiteVersion = { id: string; projectId: string; suiteKey: string; suiteType: 'smoke' | 'regression' | 'custom' | 'functional_domain'; version: number; name: string; testCaseLibraryVersionId?: string; compatibilityStatus?: 'compatible' | 'migration_required'; incompatibilityReason?: string; members: TestSuiteMember[]; contentSha256: string; publishedBy: string; publishedAt: string; status?: 'active' | 'deprecated'; deprecatedBy?: string; deprecatedAt?: string }
export type ExecutionReadinessOverrideInput = { caseId: string; revision: number; method?: TestExecutionMethod; reason: string }
export type LibraryExecutionHandoff = { id: string; projectId: string; projectVersionId: string; testCaseLibraryVersionId: string; suiteVersionId?: string; mode: TestExecutionMode; members: Array<{ stage: TestExecutionMode; ordinal: number; sourceVersionId: string; caseId: string; revision: number; method: TestExecutionMethod; reason: string; dimension: TestDimension; executionSpec: TestCaseExecutionSpec; traceability?: TestCaseTraceability; selectionReason: string; contentSha256: string; readinessOverride?: { reason: string; actorId: string; createdAt: string } }>; contentSha256: string; createdBy: string; createdAt: string }

export type TestDesignWorkflowRun = TestDesignRunSummary & {
  basisSnapshot: { schemaVersion: string; projectVersionId: string; requirementReleaseId: string; verificationRunId: string; requirementReleaseContentSha256: string; content: { requirements: unknown[]; evidence: unknown[]; clarifications: unknown[]; testFocus: unknown[] }; snapshotSha256: string; createdAt: string }
  agentConfigurationSnapshot: { configurationId: string; configurationVersion: number; configurationSha256: string; primaryModel: { modelName: string }; snapshotSha256: string }
  currentInputRefs: Array<{ assetId: string; assetVersionId: string; logicalPath: string; contentSha256: string }>
  workspaceSnapshot: { schemaVersion: 'project-workspace-snapshot/v1'; projectId: string; projectVersionId: string; rootLogicalPath: 'workspace'; activeBranchLogicalPath: string; requirementReleaseId: string; verificationRunId: string; requirementReleaseContentSha256: string; files: Array<{ logicalPath: string; displayName: string; contentSha256: string; assetId?: string; assetVersionId?: string; sourceScope: 'current_input' | 'current_branch' | 'shared' | 'historical_branch' | 'formal_output' }>; snapshotSha256: string; createdAt: string }
  historicalSnapshot: { schemaVersion: 'historical-case-snapshot/v2'; sourceProjectVersionId?: string; sourceTestCaseLibraryVersionId?: string; sourceTestCaseLibraryVersionSha256?: string; sourceRequirementReleaseId?: string; sourceRequirementReleaseContentSha256?: string; items: Array<{ id: string; contentSha256: string; semanticSha256: string; sourceRequirementReleaseId: string; sourceRequirementRefs: string[] }>; requirementMappings: Array<{ sourceRequirementId: string; status: 'exact' | 'high_confidence' | 'ambiguous' | 'unmapped'; targetRequirementId?: string }>; snapshotSha256: string; createdAt: string }
  formalWorkspaceFiles: Array<{ logicalPath: string; displayName: string; contentSha256: string; assetVersionId?: string; sourceScope: 'formal_output' }>
  nodeRuns: TestDesignNodeRun[]
  testCases: TestDesignCase[]
  coverageAudits: TestDesignCoverageAudit[]
  caseChangeProposals: CaseChangeProposal[]
  caseChangeProposalSha256: string
  baseTestCaseLibraryVersionId?: string
  baseTestCaseLibraryVersionSha256?: string
  automaticRepair?: { status: string; attempt: number; maxAttempts: number; blockerCodes: string[] }
  planningSubAgentRuns?: PlanningSubAgentRunRecord[]
}
