export type TestDimension = 'functional' | 'performance' | 'stability' | 'compatibility' | 'security'
export type ExecutionMethod = 'ui' | 'api'
export type ReviewState = 'draft' | 'in_review' | 'approved' | 'rejected' | 'needs_revision'

export type TestDesignInputCandidates = {
  projectVersion: { id: string; projectId: string; name: string; status: string }
  requirementRelease: { id: string; reviewRunId: string; contentSha256: string; publishedAt?: string; label: string } | null
  knowledgeAssets: Array<{ assetId: string; assetVersionId: string; displayName: string; logicalPath: string; assetType: string; status: string; selectable: boolean; reason?: string }>
  fixedIndexes: Array<{ id: string; selectable: boolean }>
  historicalCaseSets: Array<{ id: string; name: string; version: number; memberCount: number; contentSha256: string }>
  historicalCaseAssets: Array<{ assetId: string; assetVersionId: string; displayName: string; logicalPath: string; selectable: boolean }>
  agentReadiness: { ready: boolean; agents: Array<{ agentKey: string; ready: boolean; reason?: string }> }
}

export type CreateTestDesignInput = {
  name: string
  objective: string
  includedScopes: Array<{ kind: string; value: string }>
  excludedScopes: Array<{ kind: string; value: string }>
  focusDimensions: TestDimension[]
  executionMethods: ExecutionMethod[]
  userCoverageObjectives: string[]
  knowledgeAugmentation: { mode: 'disabled' } | { mode: 'selected_assets'; assetVersionIds: string[] } | { mode: 'fixed_index'; indexVersionId: string }
  historicalCaseSelections: Array<{ sourceType: 'test_case_set'; testCaseSetVersionId: string; caseIds: string[] } | { sourceType: 'asset_version'; assetVersionId: string }>
}

export type TestDesign = {
  id: string
  projectId: string
  projectVersionId: string
  name: string
  objective: string
  input: CreateTestDesignInput
  logicalInputSha256: string
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
  content?: string
  toolArguments?: unknown
  toolResult?: unknown
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }
}

export type TestDesignNodeRun = {
  id: string
  nodeKey: 'test_point_design' | 'test_point_review' | 'test_case_design' | 'coverage_audit' | 'test_design_repair'
  generation: number
  attempt: number
  status: string
  dependencies: string[]
  startedAt?: string
  finishedAt?: string
  errorCode?: string
  error?: string
  execution?: { agentKey: 'test-design'; workflowStage: 'test_point_design' | 'test_case_design' | 'test_design_repair'; agentVersion: string; modelLabel: string; turns: number; toolCalls: number; toolErrors?: number; events: AgentEvent[] }
}

export type TestPointNode = {
  nodeId: string
  parentId: string | null
  sortKey: string
  title: string
  objective: string
  dimension: TestDimension
  priority: 'P0' | 'P1' | 'P2' | 'P3'
  applicability: 'applicable' | 'not_applicable' | 'blocked_by_confirmation'
  designTechniques: string[]
  entryMethods: ExecutionMethod[]
  oracle: string
  dataConditions: string[]
  risks: string[]
  assumptions: string[]
  basisRefs: string[]
  historicalRefs: string[]
  deleted?: boolean
}

export type TestPointTreeOperation =
  | { op: 'add'; clientNodeRef: string; parentId: string | null; sortKey: string; value: Omit<TestPointNode, 'nodeId' | 'parentId' | 'sortKey' | 'deleted'> }
  | { op: 'rename'; nodeId: string; title: string }
  | { op: 'update'; nodeId: string; patch: Partial<Omit<TestPointNode, 'nodeId' | 'parentId' | 'sortKey' | 'deleted'>> }
  | { op: 'move'; nodeId: string; parentId: string | null; sortKey: string }
  | { op: 'delete'; nodeId: string }
  | { op: 'mark_not_applicable'; nodeId: string; reason: string }
  | { op: 'reorder'; nodeId: string; sortKey: string }
  | { op: 'split'; nodeId: string; children: Array<{ clientNodeRef: string; sortKey: string; value: Omit<TestPointNode, 'nodeId' | 'parentId' | 'sortKey' | 'deleted'> }> }
  | { op: 'merge'; sourceNodeIds: string[]; targetNodeId: string; value: Partial<Omit<TestPointNode, 'nodeId' | 'parentId' | 'sortKey' | 'deleted'>> }

export type TestPointTree = {
  id: string
  runId: string
  currentRevision: number
  currentApprovedVersionId?: string
  revisions: Array<{ revision: number; nodes: TestPointNode[]; treeSha256: string; reason: string; actorId: string; createdAt: string }>
  versions: Array<{ id: string; version: number; revision: number; treeSha256: string; approvedBy: string; approvedAt: string; projection: WorkspaceProjection }>
}

export type TestCaseContent = {
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
  executionMethods: Array<({ method: 'ui'; uiSpec: { entry: string; viewport?: string; selectors?: string[] } } | { method: 'api'; apiSpec: { method: string; path: string; requestSchemaRef?: string; responseSchemaRef?: string } }) & { executionReadiness: 'ready' | 'blocked' | 'needs_confirmation'; steps: Array<{ key: string; action: string; expected: string }>; verificationChecks: Array<{ key: string; description: string }>; automationHint: string }>
  sharedVerificationChecks: Array<{ key: string; description: string }>
  tags: string[]
  domain: string
}

export type TestDesignCase = {
  id: string
  candidateRef?: string
  origin: string
  currentRevision: number
  reviewState: ReviewState
  revisions: Array<{ revision: number; content: TestCaseContent; contentSha256: string; createdAt: string }>
  reviewActions: Array<{ id: string; decision: string; createdAt: string }>
  tombstonedAt?: string
}

export type TestDataSetVersion = { id: string; version: number; contentSha256: string; createdAt: string; requirements: Array<{ id: string; name: string; readiness: 'ready' | 'blocked' | 'needs_confirmation'; readinessReason?: string; caseIds: string[]; testPointIds: string[] }> }
export type TestDesignCoverageAudit = { id: string; status: 'valid' | 'stale'; caseSetSha256: string; inputSha256: string; statistics: { totalBasis: number; coveredBasis: number; totalPoints: number; coveredPoints: number; totalCases: number; approvedCases: number }; blockers: Array<{ code: string; message: string; subjectId?: string; resolution: 'agent_repair' | 'human_review' | 'human_decision' | 'manual_edit' }>; createdAt: string }
export type WorkspaceProjection = { status: 'pending' | 'succeeded' | 'failed'; files: Array<{ logicalPath: string; contentSha256: string; assetVersionId?: string }>; error?: string }
export type TestCaseSetVersion = { id: string; projectId: string; projectVersionId: string; testDesignId: string; runId: string; version: number; name: string; members: Array<{ caseId: string; revision: number; ordinal: number; contentSha256: string }>; contentSha256: string; publishedBy: string; publishedAt: string; projection: WorkspaceProjection }
export type TestSuiteVersion = { id: string; projectId: string; suiteType: 'smoke' | 'regression' | 'functional_domain'; version: number; name: string; members: Array<{ caseId: string; revision: number; executionMethods: ExecutionMethod[] }> }
export type TestExecutionHandoff = { id: string; testCaseSetVersionId: string; strategy: 'standard' | 'fast' | 'full'; members: Array<{ stage: string; caseId: string; method: ExecutionMethod }>; contentSha256: string; createdAt: string }

export type TestDesignWorkflowRun = TestDesignRunSummary & {
  basisSnapshot: { schemaVersion: string; projectVersionId: string; requirementReleaseId: string; verificationRunId: string; requirementsJsonSha256: string; items: unknown[]; snapshotSha256: string; createdAt: string }
  agentConfigurationSnapshot: { configurationId: string; configurationVersion: number; configurationSha256: string; primaryModel: { modelName: string }; snapshotSha256: string }
  workspaceSnapshot: { activeBranchLogicalPath: string; requirementReleaseId: string; verificationRunId: string; requirementsJsonSha256: string; files: Array<{ logicalPath: string; contentSha256: string; assetVersionId?: string }>; snapshotSha256: string }
  formalWorkspaceFiles: Array<{ logicalPath: string; contentSha256: string; assetVersionId?: string }>
  nodeRuns: TestDesignNodeRun[]
  testPointTree?: TestPointTree
  testCases: TestDesignCase[]
  dataSetVersions: TestDataSetVersion[]
  coverageAudits: TestDesignCoverageAudit[]
  findings: Array<{ id: string; title: string; description: string; severity: string; state: string; actions: Array<{ id: string }> }>
  confirmationItems: Array<{ id: string; title: string; question: string; impactStage: string; blocker: boolean; state: string; actions: Array<{ id: string }> }>
  automaticRepair?: { status: string; attempt: number; maxAttempts: number; blockerCodes: string[] }
  caseSetVersions?: TestCaseSetVersion[]
}
