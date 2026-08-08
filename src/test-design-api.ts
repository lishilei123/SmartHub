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
    events: Array<{ type: string; model?: string; occurredAt?: string }>
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

export type TestDesignWorkflowRun = TestDesignRunSummary & {
  basisSnapshot: { basisMode: TestDesignBasisMode; items: unknown[]; snapshotSha256: string; createdAt: string }
  retrievalSnapshot: { mode: string; assetVersionIds: string[]; hits: unknown[]; snapshotSha256: string; createdAt: string }
  historicalSnapshot: { items: unknown[]; snapshotSha256: string; createdAt: string }
  nodeRuns: TestDesignNodeRun[]
  artifacts: TestDesignArtifact[]
  gateDecisions: Array<{ id: string; gateKey: 'scope' | 'test-point-tree'; decision: 'approved' | 'rejected'; actorId: string; createdAt: string }>
  testPointTree?: { id: string; currentRevision: number }
  testCases: unknown[]
  dataSetVersions: unknown[]
  coverageAudits: unknown[]
  findings: unknown[]
  confirmationItems: unknown[]
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } })
  const body = await response.json() as T & { error?: string | { message?: string } }
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : body.error?.message ?? '测试设计请求失败')
  return body as T
}

export async function loadTestDesignInputs(projectVersionId: string): Promise<TestDesignInputCandidates> {
  const scope = `/project-versions/${encodeURIComponent(projectVersionId)}/test-designs`
  const [reviewBaselines, knowledgeAssets, fixedIndexes, historicalCaseSets, historicalCaseAssets, agentReadiness] = await Promise.all([
    request<TestDesignInputCandidates['reviewBaselines']>(`${scope}/inputs/review-baselines`),
    request<TestDesignInputCandidates['knowledgeAssets']>(`${scope}/inputs/knowledge-assets`),
    request<TestDesignInputCandidates['fixedIndexes']>(`${scope}/inputs/fixed-indexes`),
    request<TestDesignInputCandidates['historicalCaseSets']>(`${scope}/inputs/historical-case-sets`),
    request<TestDesignInputCandidates['historicalCaseAssets']>(`${scope}/inputs/historical-case-assets`),
    request<TestDesignInputCandidates['agentReadiness']>(`${scope}/agent-readiness`),
  ])
  return { reviewBaselines, knowledgeAssets, fixedIndexes, historicalCaseSets, historicalCaseAssets, agentReadiness }
}
export const loadTestDesigns = (projectVersionId: string) => request<{ items: TestDesign[] }>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-designs`)
export const loadTestDesign = (projectVersionId: string, designId: string) => request<TestDesign>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-designs/${encodeURIComponent(designId)}`)
export const loadTestDesignRun = (projectVersionId: string, designId: string, runId: string) => request<TestDesignWorkflowRun>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-designs/${encodeURIComponent(designId)}/runs/${encodeURIComponent(runId)}`)
export const createTestDesign = (projectVersionId: string, input: Record<string, unknown>) => request<TestDesign>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-designs`, { method: 'POST', body: JSON.stringify(input) })
export const createTestDesignRun = (projectVersionId: string, designId: string) => request<{ id: string; runId?: string; status: string }>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-designs/${encodeURIComponent(designId)}/runs`, { method: 'POST', headers: { 'idempotency-key': `test-design-${designId}-${Date.now()}` } })
export const applyTestDesignGateDecision = (projectVersionId: string, designId: string, runId: string, gateKey: 'scope' | 'test-point-tree', input: { targetId: string; targetRevision: number; expectedVersion: number; decision: 'approved' | 'rejected'; comment?: string }) => request<TestDesignWorkflowRun>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-designs/${encodeURIComponent(designId)}/runs/${encodeURIComponent(runId)}/gates/${gateKey}/decisions`, { method: 'POST', body: JSON.stringify(input) })
export const loadTestCaseSetVersion = (versionId: string) => request<{ id: string; members: Array<{ caseId: string; revision: number }> }>(`/test-case-set-versions/${encodeURIComponent(versionId)}`)
