const apiBase = 'http://127.0.0.1:8787/api'

export type TestDesignBasisMode = 'review_baseline' | 'knowledge_assets'
export type TestDesignInputCandidates = {
  reviewBaselines: Array<{ sourceReviewRunId: string; sourceTechnicalSolutionRunId: string; requirementDocumentTitle?: string; technicalReviewName?: string; reviewCompletedAt?: string; technicalCompletedAt?: string; label: string; selectable: boolean }>
  knowledgeAssets: Array<{ assetId: string; assetVersionId: string; version: number; contentHash: string; displayName: string; logicalPath: string; assetType: string; status: string; selectable: boolean; reason?: string }>
  fixedIndexes: Array<{ id: string; selectable: boolean }>
  historicalCaseSets: Array<{ id: string; name: string; version: number; memberCount: number; contentSha256: string }>
  historicalCaseAssets: Array<{ assetId: string; assetVersionId: string; version: number; contentHash: string; displayName: string; logicalPath: string; assetType: string; status: string; selectable: boolean; reason?: string }>
  agentReadiness: { ready: boolean; agents: Array<{ agentKey: string; ready: boolean; reason?: string }> }
}

export type TestDesign = {
  id: string
  projectId: string
  projectVersionId: string
  name: string
  objective: string
  basisMode: TestDesignBasisMode
  input?: {
    includedScopes?: Array<{ kind: string; value: string }>
    excludedScopes?: Array<{ kind: string; value: string }>
    focusDimensions?: string[]
    userCoverageObjectives?: string[]
  }
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

export type TestDesignNodeRun = {
  id: string
  nodeKey: string
  generation: number
  attempt: number
  status: string
  dependencies: string[]
  startedAt?: string
  finishedAt?: string
  errorCode?: string
  error?: string
  inputSha256?: string
  outputArtifactId?: string
  execution?: {
    agentKey: 'test-analysis' | 'functional-test-design' | 'non-functional-test-design' | 'test-case-synthesis'
    agentVersion: string
    modelLabel: string
    degraded: boolean
    turns: number
    toolCalls: number
    toolErrors?: number
    framework?: { name: 'pi-agent-core'; version: string }
    events: Array<{
      sequence: number
      type: string
      occurredAt: string
      turn?: number
      toolId?: string
      toolCallId?: string
      isError?: boolean
      role?: 'user' | 'assistant' | 'tool'
      content?: string
      toolCalls?: Array<{ id: string; name: string }>
      toolArguments?: unknown
      toolResult?: unknown
      stopReason?: string
      model?: string
      usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }
      framework?: { name: 'pi-agent-core'; version: string }
    }>
  }
}

export type TestDesignArtifact = {
  id: string
  nodeKey: string
  schemaVersion: string
  generation: number
  content: unknown
  contentSha256: string
  createdAt: string
}

export type TestPointNode = {
  nodeId: string
  parentId: string | null
  sortKey: string
  title: string
  objective: string
  dimension: 'functional' | 'performance' | 'stability' | 'compatibility' | 'security'
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
  deleted?: boolean
}

export type TestPointTree = {
  id: string
  runId: string
  currentRevision: number
  currentApprovedVersionId?: string
  revisions: Array<{ revision: number; nodes: TestPointNode[]; treeSha256: string; reason: string; actorId: string; createdAt: string }>
  versions: Array<{ id: string; version: number; revision: number; treeSha256: string; approvedBy: string; approvedAt: string }>
}

export type TestPointTreeOperation =
  | { op: 'add'; clientNodeRef: string; parentId: string | null; sortKey: string; value: Omit<TestPointNode, 'nodeId' | 'parentId' | 'sortKey' | 'deleted'> }
  | { op: 'rename'; nodeId: string; title: string }
  | { op: 'update'; nodeId: string; patch: Partial<Omit<TestPointNode, 'nodeId'>> }
  | { op: 'move'; nodeId: string; parentId: string | null; sortKey: string }
  | { op: 'delete'; nodeId: string }
  | { op: 'mark_not_applicable'; nodeId: string; reason: string }
  | { op: 'reorder'; nodeId: string; sortKey: string }
  | { op: 'split'; nodeId: string; children: Array<{ clientNodeRef: string; sortKey: string; value: Omit<TestPointNode, 'nodeId' | 'parentId' | 'sortKey' | 'deleted'> }> }
  | { op: 'merge'; sourceNodeIds: string[]; targetNodeId: string; value: Partial<Omit<TestPointNode, 'nodeId' | 'parentId' | 'sortKey' | 'deleted'>> }

export type TestCaseContent = {
  schemaVersion: 'test-case/v1'
  title: string
  objective: string
  dimension: TestPointNode['dimension']
  testPointIds: string[]
  priority: TestPointNode['priority']
  preconditions: string[]
  dataRequirementIds: string[]
  cleanup: string[]
  dependencies: string[]
  executionMethods: Array<({
    method: 'ui'
    uiSpec: { entry: string; viewport?: string; selectors?: string[] }
  } | {
    method: 'api'
    apiSpec: { method: string; path: string; requestSchemaRef?: string; responseSchemaRef?: string }
  }) & {
    executionReadiness: 'ready' | 'blocked' | 'needs_confirmation'
    steps: Array<{ key: string; action: string; expected: string }>
    verificationChecks: Array<{ key: string; description: string }>
    automationHint: string
  }>
  sharedVerificationChecks: Array<{ key: string; description: string }>
  tags: string[]
  domain: string
}

export type TestDesignCase = {
  id: string
  origin: 'ai' | 'manual' | 'historical_unchanged' | 'historical_modified' | 'historical_reference'
  historicalSourceRef?: string
  currentRevision: number
  reviewState: 'draft' | 'in_review' | 'approved' | 'rejected' | 'needs_revision'
  revisions: Array<{ revision: number; content: TestCaseContent; contentSha256: string; diff?: Array<{ path: string; before?: unknown; after?: unknown }>; editorId?: string; reason?: string; createdAt: string }>
  reviewActions?: Array<{ id: string; targetRevision: number; fromState: string; toState: string; decision: string; comment?: string; actorId: string; createdAt: string }>
  etag?: string
  tombstonedAt?: string
}

export type TestDataSetVersion = {
  id: string
  version: number
  contentSha256: string
  createdAt: string
  requirements: Array<{
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
    readiness: 'ready' | 'blocked' | 'needs_confirmation'
    readinessReason?: string
  }>
}

export type TestDesignCoverageAudit = {
  id: string
  status: 'valid' | 'stale'
  caseSetSha256: string
  inputSha256: string
  statistics: { totalBasis: number; coveredBasis: number; totalPoints: number; coveredPoints: number; totalCases: number; approvedCases: number }
  relations: Array<{ basisRef: string; testPointId: string; caseId?: string; status: 'covered' | 'partially_covered' | 'not_covered' | 'needs_confirmation'; reason: string }>
  blockers: Array<{ code: string; message: string; subjectId?: string; resolution?: 'agent_repair' | 'human_review' | 'human_decision' | 'manual_edit' }>
  createdAt: string
}

export type TestCaseSetVersion = {
  id: string
  projectId: string
  projectVersionId: string
  testDesignId: string
  runId: string
  version: number
  name: string
  members: Array<{ caseId: string; revision: number; ordinal: number; contentSha256: string }>
  contentSha256: string
  publishedBy: string
  publishedAt: string
  projection: { status: 'pending' | 'succeeded' | 'failed'; assetVersionId?: string; error?: string }
}

export type TestDesignWorkflowRun = TestDesignRunSummary & {
  basisSnapshot: { basisMode: TestDesignBasisMode; items: unknown[]; snapshotSha256: string; createdAt: string }
  retrievalSnapshot: { mode: string; assetVersionIds: string[]; queryPlan: Array<{ query: string; intent: string }>; hits: unknown[]; snapshotSha256: string; createdAt: string }
  historicalSnapshot: { items: unknown[]; snapshotSha256: string; createdAt: string }
  nodeRuns: TestDesignNodeRun[]
  artifacts: TestDesignArtifact[]
  gateDecisions: Array<{ id: string; gateKey: 'scope' | 'test-point-tree'; decision: 'approved' | 'rejected'; comment?: string; actorId: string; createdAt: string }>
  testPointTree?: TestPointTree
  testCases: TestDesignCase[]
  dataSetVersions: TestDataSetVersion[]
  coverageAudits: TestDesignCoverageAudit[]
  findings: Array<{ id: string; title: string; description: string; severity: 'blocker' | 'high' | 'medium' | 'low'; basisRefs: string[]; state: string; actions: Array<{ id: string }> }>
  confirmationItems: Array<{ id: string; title: string; question: string; decisionType: string; impactStage: string; affectedRefs: string[]; blocker: boolean; state: string; actions: Array<{ id: string }> }>
  automaticRepair?: { status: 'idle' | 'queued' | 'running' | 'succeeded' | 'exhausted' | 'not_needed'; attempt: number; maxAttempts: number; blockerCodes: string[]; triggerAuditId?: string; startedAt?: string; finishedAt?: string }
  caseSetVersions?: TestCaseSetVersion[]
}

export type ProjectTestCaseCatalogItem = { testCaseSetVersionId: string; testCaseSetName: string; caseId: string; revision: number; content: TestCaseContent; publishedAt: string; contentSha256: string }
export type TestSuiteVersion = { id: string; projectId: string; suiteKey: string; suiteType: 'smoke' | 'regression' | 'functional_domain'; version: number; name: string; members: Array<{ testCaseSetVersionId: string; caseId: string; revision: number; executionMethods: Array<'ui' | 'api'>; ordinal: number; reason: string }>; contentSha256: string; publishedBy: string; publishedAt: string }
export type SmokeCandidate = { testCaseSetVersionId: string; caseId: string; executionMethods: Array<'ui' | 'api'>; reason: string; estimatedMinutes: number; stable: boolean; dependencyReady: boolean; decision: 'pending' | 'accepted' | 'rejected'; actorId?: string; reviewedAt?: string }
export type ImpactedRegression = { testCaseSetVersionId: string; suiteVersionId: string; caseId: string; executionMethods: Array<'ui' | 'api'>; reason: string; actorId: string; createdAt: string }
export type TestExecutionHandoff = { id: string; projectId: string; projectVersionId: string; testCaseSetVersionId: string; strategy: 'standard' | 'fast' | 'full'; smokeSuiteVersionId?: string; regressionSuiteVersionId?: string; members: Array<{ stage: 'smoke' | 'new_feature' | 'impacted_regression' | 'full_regression'; ordinal: number; sourceVersionId: string; caseId: string; revision: number; method: 'ui' | 'api'; reason: string; dedupKey: string }>; contentSha256: string; createdBy: string; createdAt: string }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } })
  const body = await response.json() as T & { error?: string | { message?: string }; message?: string }
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : body.error?.message ?? body.message ?? '测试设计请求失败')
  return body as T
}

async function requestWithResponse<T>(path: string, init?: RequestInit): Promise<{ value: T; response: Response }> {
  const response = await fetch(`${apiBase}${path}`, { ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } })
  const body = await response.json() as T & { error?: string | { message?: string }; message?: string }
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : body.error?.message ?? body.message ?? '测试设计请求失败')
  return { value: body as T, response }
}

function runScope(projectVersionId: string, designId: string, runId: string) {
  return `/project-versions/${encodeURIComponent(projectVersionId)}/test-designs/${encodeURIComponent(designId)}/runs/${encodeURIComponent(runId)}`
}

export async function loadTestDesignInputs(projectVersionId: string): Promise<TestDesignInputCandidates> {
  return request<TestDesignInputCandidates>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-designs/inputs`)
}
export const loadTestDesigns = (projectVersionId: string) => request<{ items: TestDesign[] }>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-designs`)
export const loadTestDesign = (projectVersionId: string, designId: string) => request<TestDesign>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-designs/${encodeURIComponent(designId)}`)
export const loadTestDesignRun = (projectVersionId: string, designId: string, runId: string) => request<TestDesignWorkflowRun>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-designs/${encodeURIComponent(designId)}/runs/${encodeURIComponent(runId)}`)
export const createTestDesign = (projectVersionId: string, input: Record<string, unknown>) => request<TestDesign>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-designs`, { method: 'POST', body: JSON.stringify(input) })
export const createTestDesignRun = (projectVersionId: string, designId: string) => request<{ id: string; runId?: string; status: string }>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-designs/${encodeURIComponent(designId)}/runs`, { method: 'POST', headers: { 'idempotency-key': `test-design-${designId}-${Date.now()}` } })
export const cancelTestDesignRun = (projectVersionId: string, designId: string, runId: string) => request<TestDesignWorkflowRun>(`${runScope(projectVersionId, designId, runId)}/cancel`, { method: 'POST' })
export const fullRerunTestDesign = (projectVersionId: string, designId: string, runId: string) => request<TestDesignWorkflowRun>(`${runScope(projectVersionId, designId, runId)}/actions/full-rerun`, { method: 'POST', headers: { 'idempotency-key': `test-design-full-rerun-${runId}-${Date.now()}` } })
export const reviseTestDesignScope = (projectVersionId: string, designId: string, runId: string) => request<TestDesignWorkflowRun>(`${runScope(projectVersionId, designId, runId)}/actions/revise-scope`, { method: 'POST' })
export const retryTestDesignNode = (projectVersionId: string, designId: string, runId: string, nodeKey: 'functional_design' | 'non_functional_design') => request<TestDesignWorkflowRun>(`${runScope(projectVersionId, designId, runId)}/actions/retry-design-node`, { method: 'POST', body: JSON.stringify({ nodeKey }) })
export const resynthesizeTestDesign = (projectVersionId: string, designId: string, runId: string) => request<TestDesignWorkflowRun>(`${runScope(projectVersionId, designId, runId)}/actions/resynthesize`, { method: 'POST' })
export const applyTestDesignGateDecision = (projectVersionId: string, designId: string, runId: string, gateKey: 'scope' | 'test-point-tree', input: { targetId: string; targetRevision: number; expectedVersion: number; decision: 'approved' | 'rejected'; comment?: string }) => request<TestDesignWorkflowRun>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-designs/${encodeURIComponent(designId)}/runs/${encodeURIComponent(runId)}/gates/${gateKey}/decisions`, { method: 'POST', body: JSON.stringify(input) })
export const loadTestCaseSetVersion = (versionId: string) => request<{ id: string; members: Array<{ caseId: string; revision: number }> }>(`/test-case-set-versions/${encodeURIComponent(versionId)}`)
export async function loadTestDesignCase(projectVersionId: string, designId: string, runId: string, caseId: string) {
  const { value, response } = await requestWithResponse<TestDesignCase>(`${runScope(projectVersionId, designId, runId)}/test-cases/${encodeURIComponent(caseId)}`)
  return { ...value, etag: response.headers.get('etag') ?? value.etag }
}
export const createTestDesignCase = (projectVersionId: string, designId: string, runId: string, content: TestCaseContent) => request<TestDesignCase>(`${runScope(projectVersionId, designId, runId)}/test-cases`, { method: 'POST', body: JSON.stringify({ content }) })
export async function updateTestDesignCase(projectVersionId: string, designId: string, runId: string, caseId: string, etag: string, content: TestCaseContent, reason: string) {
  const { value, response } = await requestWithResponse<TestDesignCase>(`${runScope(projectVersionId, designId, runId)}/test-cases/${encodeURIComponent(caseId)}`, { method: 'PATCH', headers: { 'if-match': etag }, body: JSON.stringify({ content, reason }) })
  return { ...value, etag: response.headers.get('etag') ?? value.etag }
}
export const reviewTestDesignCase = (projectVersionId: string, designId: string, runId: string, caseId: string, input: { decision: 'submit' | 'approve' | 'reject' | 'request_revision' | 'withdraw'; targetRevision: number; comment?: string }) => request<TestDesignCase>(`${runScope(projectVersionId, designId, runId)}/test-cases/${encodeURIComponent(caseId)}/review-actions`, { method: 'POST', body: JSON.stringify(input) })
export const batchReviewTestDesignCases = (projectVersionId: string, designId: string, runId: string, input: { targets: Array<{ caseId: string; targetRevision: number }>; decision: 'submit' | 'approve' | 'reject' | 'request_revision' | 'withdraw'; comment?: string }) => request<TestDesignCase[]>(`${runScope(projectVersionId, designId, runId)}/test-cases/batch-review-actions`, { method: 'POST', body: JSON.stringify(input) })
export const reAuditTestDesignRun = (projectVersionId: string, designId: string, runId: string) => request<TestDesignCoverageAudit>(`${runScope(projectVersionId, designId, runId)}/actions/re-audit`, { method: 'POST' })
export const publishTestCaseSet = (projectVersionId: string, designId: string, runId: string, input: { name: string; expectedAuditId: string; expectedCaseSetSha256: string }) => request<TestCaseSetVersion>(`${runScope(projectVersionId, designId, runId)}/test-case-set-versions`, { method: 'POST', body: JSON.stringify(input) })
export async function loadTestPointTree(projectVersionId: string, designId: string, runId: string) {
  const { value, response } = await requestWithResponse<{ tree: TestPointTree; revision: { revision: number; nodes: TestPointNode[]; treeSha256: string } }>(`${runScope(projectVersionId, designId, runId)}/test-point-tree`)
  return { ...value, etag: response.headers.get('etag') ?? '' }
}
export async function updateTestPointTree(projectVersionId: string, designId: string, runId: string, etag: string, operations: TestPointTreeOperation[], reason: string) {
  const { value, response } = await requestWithResponse<{ tree: TestPointTree; revision: { revision: number; nodes: TestPointNode[]; treeSha256: string }; etag?: string }>(`${runScope(projectVersionId, designId, runId)}/test-point-tree`, { method: 'PATCH', headers: { 'if-match': etag }, body: JSON.stringify({ operations, reason }) })
  return { ...value, etag: response.headers.get('etag') ?? value.etag ?? '' }
}
export const approveTestPointTree = (projectVersionId: string, designId: string, runId: string, etag: string) => request<{ id: string; version: number; revision: number; treeSha256: string }>(`${runScope(projectVersionId, designId, runId)}/test-point-tree/approve`, { method: 'POST', headers: { 'if-match': etag } })
export const deleteTestDesignCase = (projectVersionId: string, designId: string, runId: string, caseId: string) => request<TestDesignCase>(`${runScope(projectVersionId, designId, runId)}/test-cases/${encodeURIComponent(caseId)}`, { method: 'DELETE' })
export const replaceTestDataRequirements = (projectVersionId: string, designId: string, runId: string, requirements: TestDataSetVersion['requirements']) => request<TestDataSetVersion>(`${runScope(projectVersionId, designId, runId)}/test-data-requirements`, { method: 'PATCH', body: JSON.stringify({ requirements }) })
export const actOnTestDesignFinding = (projectVersionId: string, designId: string, runId: string, findingId: string, input: { expectedVersion: number; decision: 'confirm' | 'resolve' | 'defer' | 'reject' | 'reopen'; comment?: string }) => request<unknown>(`${runScope(projectVersionId, designId, runId)}/findings/${encodeURIComponent(findingId)}/actions`, { method: 'POST', body: JSON.stringify(input) })
export const actOnTestDesignConfirmation = (projectVersionId: string, designId: string, runId: string, itemId: string, input: { expectedVersion: number; decision: 'confirm' | 'resolve' | 'defer' | 'reject' | 'reopen'; comment?: string; structuredDecision?: unknown }) => request<unknown>(`${runScope(projectVersionId, designId, runId)}/confirmation-items/${encodeURIComponent(itemId)}/actions`, { method: 'POST', body: JSON.stringify(input) })
export const loadProjectTestCaseCatalog = (projectId: string, filters: { domain?: string; executionMethod?: string; suiteVersionId?: string } = {}) => { const query = new URLSearchParams(Object.entries(filters).filter((entry): entry is [string, string] => Boolean(entry[1]))); return request<{ items: ProjectTestCaseCatalogItem[]; catalogAsOf: string }>(`/projects/${encodeURIComponent(projectId)}/test-case-catalog${query.size ? `?${query}` : ''}`) }
export const loadProjectTestSuites = (projectId: string, suiteType?: TestSuiteVersion['suiteType']) => request<{ items: TestSuiteVersion[] }>(`/projects/${encodeURIComponent(projectId)}/test-suite-versions${suiteType ? `?suiteType=${encodeURIComponent(suiteType)}` : ''}`)
export const loadSmokeCandidates = (versionId: string) => request<{ items: SmokeCandidate[] }>(`/test-case-set-versions/${encodeURIComponent(versionId)}/smoke-candidates`)
export const reviewSmokeCandidate = (versionId: string, caseId: string, input: Omit<SmokeCandidate, 'testCaseSetVersionId' | 'caseId' | 'actorId' | 'reviewedAt'>) => request<SmokeCandidate>(`/test-case-set-versions/${encodeURIComponent(versionId)}/smoke-candidates/${encodeURIComponent(caseId)}/review`, { method: 'POST', body: JSON.stringify(input) })
export const loadImpactedRegression = (versionId: string) => request<{ items: ImpactedRegression[] }>(`/test-case-set-versions/${encodeURIComponent(versionId)}/impacted-regression`)
export const saveImpactedRegression = (versionId: string, references: Array<Omit<ImpactedRegression, 'testCaseSetVersionId' | 'actorId' | 'createdAt'>>) => request<ImpactedRegression[]>(`/test-case-set-versions/${encodeURIComponent(versionId)}/impacted-regression`, { method: 'PUT', body: JSON.stringify({ references }) })
export const loadExecutionHandoffs = (versionId: string) => request<{ items: TestExecutionHandoff[] }>(`/test-case-set-versions/${encodeURIComponent(versionId)}/execution-handoffs`)
export const createExecutionHandoff = (versionId: string, input: { strategy: 'standard' | 'fast' | 'full'; smokeSuiteVersionId?: string; regressionSuiteVersionId?: string; expectedCaseSetSha256: string }) => request<TestExecutionHandoff>(`/test-case-set-versions/${encodeURIComponent(versionId)}/execution-handoffs`, { method: 'POST', body: JSON.stringify(input) })
export const testCaseSetExportUrl = (versionId: string, format: 'json' | 'markdown' | 'xlsx') => `${apiBase}/test-case-set-versions/${encodeURIComponent(versionId)}/${format === 'json' ? 'export.json' : format === 'xlsx' ? 'export.xlsx' : 'report.md'}`
