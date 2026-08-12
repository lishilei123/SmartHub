import type { CaseChangeDecision, CaseChangeProposal, CreateTestDesignInput, LibraryExecutionHandoff, LibraryTestCase, LibraryTestSuiteVersion, TestCaseContent, TestCaseLibraryVersion, TestDesign, TestDesignCase, TestDesignCoverageAudit, TestDesignInputCandidates, TestDesignWorkflowRun, TestPointNode, TestPointTree, TestPointTreeOperation, TestSuiteDraft, TestExecutionMethod } from './types'

const apiBase = 'http://127.0.0.1:8787/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } })
  const body = await response.json().catch(() => ({})) as T & { error?: string | { message?: string }; message?: string }
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : body.error?.message ?? body.message ?? `测试设计请求失败（HTTP ${response.status}）`)
  return body
}

async function requestWithResponse<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${apiBase}${path}`, { ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } })
  const body = await response.json().catch(() => ({})) as T & { error?: string | { message?: string }; message?: string }
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : body.error?.message ?? body.message ?? `测试设计请求失败（HTTP ${response.status}）`)
  return { value: body, response }
}

const runScope = (projectVersionId: string, designId: string, runId: string) => `/project-versions/${encodeURIComponent(projectVersionId)}/test-designs/${encodeURIComponent(designId)}/runs/${encodeURIComponent(runId)}`

export const loadInputs = (projectVersionId: string) => request<TestDesignInputCandidates>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-designs/inputs`)
export const loadDesigns = (projectVersionId: string) => request<{ items: TestDesign[] }>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-designs`)
export const loadDesign = (projectVersionId: string, designId: string) => request<TestDesign>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-designs/${encodeURIComponent(designId)}`)
export const loadRun = (projectVersionId: string, designId: string, runId: string) => request<TestDesignWorkflowRun>(runScope(projectVersionId, designId, runId))
export const createDesign = (projectVersionId: string, input: CreateTestDesignInput) => request<TestDesign>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-designs`, { method: 'POST', body: JSON.stringify(input) })
export const createRun = (projectVersionId: string, designId: string) => request<TestDesignWorkflowRun>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-designs/${encodeURIComponent(designId)}/runs`, { method: 'POST', headers: { 'idempotency-key': `test-design-${designId}-${crypto.randomUUID()}` } })
export const cancelRun = (projectVersionId: string, designId: string, runId: string) => request<TestDesignWorkflowRun>(`${runScope(projectVersionId, designId, runId)}/cancel`, { method: 'POST' })
export const redesignTestPoints = (projectVersionId: string, designId: string, runId: string) => request<TestDesignWorkflowRun>(`${runScope(projectVersionId, designId, runId)}/actions/redesign-test-points`, { method: 'POST' })
export const resynthesizeCases = (projectVersionId: string, designId: string, runId: string) => request<TestDesignWorkflowRun>(`${runScope(projectVersionId, designId, runId)}/actions/resynthesize`, { method: 'POST' })

export async function loadTree(projectVersionId: string, designId: string, runId: string) {
  const { value, response } = await requestWithResponse<{ tree: TestPointTree; revision: { revision: number; nodes: TestPointNode[]; treeSha256: string } }>(`${runScope(projectVersionId, designId, runId)}/test-point-tree`)
  return { ...value, etag: response.headers.get('etag') ?? '' }
}

export async function patchTree(projectVersionId: string, designId: string, runId: string, etag: string, operations: TestPointTreeOperation[], reason: string) {
  const { value, response } = await requestWithResponse<{ tree: TestPointTree; revision: { revision: number; nodes: TestPointNode[]; treeSha256: string }; etag?: string }>(`${runScope(projectVersionId, designId, runId)}/test-point-tree`, { method: 'PATCH', headers: { 'if-match': etag }, body: JSON.stringify({ operations, reason }) })
  return { ...value, etag: response.headers.get('etag') ?? value.etag ?? '' }
}

export const approveTree = (projectVersionId: string, designId: string, runId: string, etag: string) => request(`${runScope(projectVersionId, designId, runId)}/test-point-tree/approve`, { method: 'POST', headers: { 'if-match': etag } })
const caseScope = (projectVersionId: string, designId: string, runId: string, caseId: string) => `${runScope(projectVersionId, designId, runId)}/test-cases/${encodeURIComponent(caseId)}`

export const createCase = (projectVersionId: string, designId: string, runId: string, content: TestDesignCase['revisions'][number]['content']) => request<TestDesignCase>(`${runScope(projectVersionId, designId, runId)}/test-cases`, { method: 'POST', body: JSON.stringify({ content }) })
export async function loadCase(projectVersionId: string, designId: string, runId: string, caseId: string) {
  const { value, response } = await requestWithResponse<TestDesignCase>(caseScope(projectVersionId, designId, runId, caseId))
  return { testCase: value, etag: response.headers.get('etag') ?? '' }
}
export async function patchCase(projectVersionId: string, designId: string, runId: string, caseId: string, etag: string, content: TestDesignCase['revisions'][number]['content'], reason: string) {
  const { value, response } = await requestWithResponse<TestDesignCase>(caseScope(projectVersionId, designId, runId, caseId), { method: 'PATCH', headers: { 'if-match': etag }, body: JSON.stringify({ content, reason }) })
  return { testCase: value, etag: response.headers.get('etag') ?? '' }
}
export const deleteCase = (projectVersionId: string, designId: string, runId: string, caseId: string) => request<{ caseId: string; tombstonedAt: string }>(caseScope(projectVersionId, designId, runId, caseId), { method: 'DELETE' })
export const reviewCase = (projectVersionId: string, designId: string, runId: string, caseId: string, decision: 'submit' | 'approve' | 'reject' | 'request_revision' | 'withdraw', targetRevision: number, comment?: string) => request<TestDesignCase>(`${caseScope(projectVersionId, designId, runId, caseId)}/review-actions`, { method: 'POST', body: JSON.stringify({ decision, targetRevision, comment }) })
export const batchReviewCases = (projectVersionId: string, designId: string, runId: string, targets: Array<{ caseId: string; targetRevision: number }>, decision: 'submit' | 'approve') => request<TestDesignCase[]>(`${runScope(projectVersionId, designId, runId)}/test-cases/batch-review-actions`, { method: 'POST', body: JSON.stringify({ targets, decision }) })
export const reAudit = (projectVersionId: string, designId: string, runId: string) => request<TestDesignCoverageAudit>(`${runScope(projectVersionId, designId, runId)}/actions/re-audit`, { method: 'POST' })
export const actOnFinding = (projectVersionId: string, designId: string, runId: string, findingId: string, expectedVersion: number) => request(`${runScope(projectVersionId, designId, runId)}/findings/${encodeURIComponent(findingId)}/actions`, { method: 'POST', body: JSON.stringify({ expectedVersion, decision: 'resolve' }) })
export const actOnConfirmation = (projectVersionId: string, designId: string, runId: string, itemId: string, expectedVersion: number) => request(`${runScope(projectVersionId, designId, runId)}/confirmation-items/${encodeURIComponent(itemId)}/actions`, { method: 'POST', body: JSON.stringify({ expectedVersion, decision: 'resolve' }) })
export const loadProposals = (projectVersionId: string, designId: string, runId: string, operation?: string) => request<{ items: CaseChangeProposal[] }>(`${runScope(projectVersionId, designId, runId)}/case-change-proposals${operation ? `?operation=${encodeURIComponent(operation)}` : ''}`)
export const decideProposal = (projectVersionId: string, designId: string, runId: string, proposalId: string, input: { expectedVersion: number; decision: Exclude<CaseChangeDecision, 'pending'>; comment?: string; editedContent?: TestCaseContent }) => request<CaseChangeProposal>(`${runScope(projectVersionId, designId, runId)}/case-change-proposals/${encodeURIComponent(proposalId)}/decisions`, { method: 'POST', body: JSON.stringify(input) })
export const publishLibraryVersion = (projectVersionId: string, designId: string, runId: string, input: { name: string; expectedAuditId: string; expectedCaseSetSha256: string; expectedProposalSha256: string }) => request<TestCaseLibraryVersion>(`${runScope(projectVersionId, designId, runId)}/test-case-library-versions`, { method: 'POST', body: JSON.stringify(input) })

const projectScope = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`
export const loadLibraryCases = (projectId: string, filters: Record<string, string> = {}) => request<{ items: LibraryTestCase[] }>(`${projectScope(projectId)}/test-case-library${Object.keys(filters).length ? `?${new URLSearchParams(filters)}` : ''}`)
export const loadLibraryCase = (projectId: string, caseId: string) => requestWithResponse<LibraryTestCase>(`${projectScope(projectId)}/test-case-library/${encodeURIComponent(caseId)}`)
export const createLibraryCase = (projectId: string, content: TestCaseContent, changeReason: string) => request<LibraryTestCase>(`${projectScope(projectId)}/test-case-library`, { method: 'POST', body: JSON.stringify({ content, changeReason }) })
export const editLibraryCase = (projectId: string, caseId: string, etag: string, content: TestCaseContent, changeReason: string) => request<LibraryTestCase>(`${projectScope(projectId)}/test-case-library/${encodeURIComponent(caseId)}`, { method: 'PATCH', headers: { 'if-match': etag }, body: JSON.stringify({ content, changeReason }) })
export const copyLibraryCase = (projectId: string, caseId: string, changeReason: string, content?: TestCaseContent) => request<LibraryTestCase>(`${projectScope(projectId)}/test-case-library/${encodeURIComponent(caseId)}/copy`, { method: 'POST', body: JSON.stringify({ changeReason, ...(content ? { content } : {}) }) })
export const deprecateLibraryCase = (projectId: string, caseId: string, etag: string, changeReason: string) => request<LibraryTestCase>(`${projectScope(projectId)}/test-case-library/${encodeURIComponent(caseId)}`, { method: 'DELETE', headers: { 'if-match': etag }, body: JSON.stringify({ changeReason }) })
export const diffLibraryCase = (projectId: string, caseId: string, from: number, to: number) => request<{ changes: Array<{ path: string; before?: unknown; after?: unknown }> }>(`${projectScope(projectId)}/test-case-library/${encodeURIComponent(caseId)}/diff?from=${from}&to=${to}`)
export const loadLibraryVersions = (projectId: string) => request<{ items: TestCaseLibraryVersion[] }>(`${projectScope(projectId)}/test-case-library-versions`)
export const diffLibraryVersions = (projectId: string, from: string, to: string) => request<{ changes: Array<{ caseId: string; change: string }> }>(`${projectScope(projectId)}/test-case-library-versions/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)

export const loadSuiteDrafts = (projectId: string) => request<{ items: TestSuiteDraft[] }>(`${projectScope(projectId)}/test-suite-drafts`)
export const loadSuiteVersions = (projectId: string) => request<{ items: LibraryTestSuiteVersion[] }>(`${projectScope(projectId)}/test-suite-versions`)
type SuiteDraftInput = { suiteKey: string; suiteType: 'smoke' | 'regression' | 'custom'; name: string; testCaseLibraryVersionId: string; confirmLibraryVersionChange?: boolean; members: Array<{ caseId: string; executionMethod: TestExecutionMethod; reason: string }> }
export const createSuiteDraft = (projectId: string, input: SuiteDraftInput) => request<TestSuiteDraft>(`${projectScope(projectId)}/test-suite-drafts`, { method: 'POST', body: JSON.stringify(input) })
export const loadSuiteDraft = (projectId: string, draftId: string) => requestWithResponse<TestSuiteDraft>(`${projectScope(projectId)}/test-suite-drafts/${encodeURIComponent(draftId)}`)
export const updateSuiteDraft = (projectId: string, draftId: string, etag: string, input: SuiteDraftInput) => request<TestSuiteDraft>(`${projectScope(projectId)}/test-suite-drafts/${encodeURIComponent(draftId)}`, { method: 'PUT', headers: { 'if-match': etag }, body: JSON.stringify(input) })
export const publishSuiteDraft = (projectId: string, draftId: string, etag: string) => request<LibraryTestSuiteVersion>(`${projectScope(projectId)}/test-suite-drafts/${encodeURIComponent(draftId)}/publish`, { method: 'POST', headers: { 'if-match': etag } })
export const diffSuiteVersions = (projectId: string, from: string, to: string) => request<{ changes: Array<{ caseId: string; change: string }> }>(`${projectScope(projectId)}/test-suite-versions/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
export const deprecateSuiteVersion = (projectId: string, suiteVersionId: string) => request<LibraryTestSuiteVersion>(`${projectScope(projectId)}/test-suite-versions/${encodeURIComponent(suiteVersionId)}/deprecate`, { method: 'POST' })
export const previewLegacyCaseMigration = (projectId: string, legacyTestCaseSetVersionId: string) => request<{ legacyTestCaseSetVersionId: string; status: 'ready' | 'needs_confirmation' | 'migrated'; previewSha256: string; items: Array<{ legacyCaseId: string; legacyRevision: number; suggestedLibraryCaseId: string; resolution: string }> }>(`${projectScope(projectId)}/test-case-library-migrations/${encodeURIComponent(legacyTestCaseSetVersionId)}/preview`)
export const migrateLegacyCaseSet = (projectId: string, input: { legacyTestCaseSetVersionId: string; expectedPreviewSha256: string; confirmUncertain?: boolean }) => request<{ version: TestCaseLibraryVersion }>(`${projectScope(projectId)}/test-case-library-migrations`, { method: 'POST', body: JSON.stringify(input) })

export const createLibraryHandoff = (projectVersionId: string, libraryVersionId: string, input: { mode: 'smoke' | 'regression' | 'full' | 'custom'; suiteVersionId?: string; impactedCaseIds?: string[]; expectedLibrarySha256: string }) => request<LibraryExecutionHandoff>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-case-library-versions/${encodeURIComponent(libraryVersionId)}/execution-handoffs`, { method: 'POST', body: JSON.stringify(input) })
export const loadLibraryHandoffs = (projectVersionId: string) => request<{ items: LibraryExecutionHandoff[] }>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-case-library-handoffs`)
export const exportCaseSetUrl = (versionId: string, format: 'json' | 'markdown' | 'xlsx') => `${apiBase}/test-case-set-versions/${encodeURIComponent(versionId)}/${format === 'json' ? 'export.json' : format === 'xlsx' ? 'export.xlsx' : 'report.md'}`
