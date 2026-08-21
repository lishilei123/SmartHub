import type { CreateTestDesignInput, LibraryExecutionHandoff, LibraryTestCase, LibraryTestSuiteVersion, TestCaseContent, TestCaseLibraryVersion, TestDesign, TestDesignCase, TestDesignCoverageAudit, TestDesignInputCandidates, TestDesignWorkflowRun, TestSuiteDraft, TestExecutionMethod } from './types'

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
export const loadRuns = (projectVersionId: string, designId: string) => request<{ items: import('./types').TestDesignRunSummary[] }>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-designs/${encodeURIComponent(designId)}/runs`)
export const createDesign = (projectVersionId: string, input: CreateTestDesignInput) => request<TestDesign>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-designs`, { method: 'POST', body: JSON.stringify(input) })
export const createRun = (projectVersionId: string, designId: string, clientRequestId = crypto.randomUUID()) => request<TestDesignWorkflowRun>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-designs/${encodeURIComponent(designId)}/runs`, { method: 'POST', headers: { 'idempotency-key': `test-design-run:${designId}:${clientRequestId}` } })
export const cancelRun = (projectVersionId: string, designId: string, runId: string) => request<TestDesignWorkflowRun>(`${runScope(projectVersionId, designId, runId)}/cancel`, { method: 'POST' })
export const resynthesizeCases = (projectVersionId: string, designId: string, runId: string) => request<TestDesignWorkflowRun>(`${runScope(projectVersionId, designId, runId)}/actions/resynthesize`, { method: 'POST' })

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
export type TestCaseReviewDecision = 'submit' | 'approve' | 'reject' | 'request_revision' | 'withdraw'
export const reviewCase = (projectVersionId: string, designId: string, runId: string, caseId: string, decision: TestCaseReviewDecision, targetRevision: number, comment?: string) => request<TestDesignCase>(`${caseScope(projectVersionId, designId, runId, caseId)}/review-actions`, { method: 'POST', body: JSON.stringify({ decision, targetRevision, comment }) })
export const batchReviewCases = (projectVersionId: string, designId: string, runId: string, targets: Array<{ caseId: string; targetRevision: number }>, decision: TestCaseReviewDecision) => request<TestDesignCase[]>(`${runScope(projectVersionId, designId, runId)}/test-cases/batch-review-actions`, { method: 'POST', body: JSON.stringify({ targets, decision }) })
export const reAudit = (projectVersionId: string, designId: string, runId: string) => request<TestDesignCoverageAudit>(`${runScope(projectVersionId, designId, runId)}/actions/re-audit`, { method: 'POST' })
export const publishLibraryVersion = (projectVersionId: string, designId: string, runId: string, input: { name: string; expectedAuditId: string; expectedCaseSetSha256: string; expectedProposalSha256: string }) => request<TestCaseLibraryVersion>(`${runScope(projectVersionId, designId, runId)}/test-case-library-versions`, { method: 'POST', body: JSON.stringify(input) })

const projectScope = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`
export const loadLibraryCases = (projectId: string, filters: Record<string, string> = {}) => request<{ items: LibraryTestCase[] }>(`${projectScope(projectId)}/test-case-library${Object.keys(filters).length ? `?${new URLSearchParams(filters)}` : ''}`)
export const loadLibraryCase = (projectId: string, caseId: string) => requestWithResponse<LibraryTestCase>(`${projectScope(projectId)}/test-case-library/${encodeURIComponent(caseId)}`)
export const createLibraryCase = (projectId: string, content: TestCaseContent, changeReason: string) => request<LibraryTestCase>(`${projectScope(projectId)}/test-case-library`, { method: 'POST', body: JSON.stringify({ content, changeReason }) })
export const editLibraryCase = (projectId: string, caseId: string, etag: string, content: TestCaseContent, changeReason: string, traceability?: import('./types').TestCaseTraceability) => request<LibraryTestCase>(`${projectScope(projectId)}/test-case-library/${encodeURIComponent(caseId)}`, { method: 'PATCH', headers: { 'if-match': etag }, body: JSON.stringify({ content, changeReason, ...(traceability ? { traceability } : {}) }) })
export const copyLibraryCase = (projectId: string, caseId: string, changeReason: string, content?: TestCaseContent) => request<LibraryTestCase>(`${projectScope(projectId)}/test-case-library/${encodeURIComponent(caseId)}/copy`, { method: 'POST', body: JSON.stringify({ changeReason, ...(content ? { content } : {}) }) })
export const deprecateLibraryCase = (projectId: string, caseId: string, etag: string, changeReason: string) => request<LibraryTestCase>(`${projectScope(projectId)}/test-case-library/${encodeURIComponent(caseId)}`, { method: 'DELETE', headers: { 'if-match': etag }, body: JSON.stringify({ changeReason }) })
export const diffLibraryCase = (projectId: string, caseId: string, from: number, to: number) => request<{ changes: Array<{ path: string; before?: unknown; after?: unknown }> }>(`${projectScope(projectId)}/test-case-library/${encodeURIComponent(caseId)}/diff?from=${from}&to=${to}`)
export const loadLibraryVersions = (projectId: string, sourceRunId?: string) => request<{ items: TestCaseLibraryVersion[] }>(`${projectScope(projectId)}/test-case-library-versions${sourceRunId ? `?sourceRunId=${encodeURIComponent(sourceRunId)}` : ''}`)
export const loadLibraryVersion = (projectId: string, versionId: string) => request<TestCaseLibraryVersion>(`${projectScope(projectId)}/test-case-library-versions/${encodeURIComponent(versionId)}`)
export const diffLibraryVersions = (projectId: string, from: string, to: string) => request<{ changes: Array<{ caseId: string; change: string }> }>(`${projectScope(projectId)}/test-case-library-versions/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)

export const loadSuiteDrafts = (projectId: string) => request<{ items: TestSuiteDraft[] }>(`${projectScope(projectId)}/test-suite-drafts`)
export const loadSuiteVersions = (projectId: string) => request<{ items: LibraryTestSuiteVersion[] }>(`${projectScope(projectId)}/test-suite-versions`)
export type SuiteDraftMemberInput = { caseId: string; executionMethods: Array<'ui' | 'api'>; reason: string }
export type SuiteDraftInput = { suiteKey: string; suiteType: 'smoke' | 'regression' | 'custom'; name: string; testCaseLibraryVersionId: string; confirmLibraryVersionChange?: boolean; members: SuiteDraftMemberInput[] }
export const createSuiteDraft = (projectId: string, input: SuiteDraftInput) => request<TestSuiteDraft>(`${projectScope(projectId)}/test-suite-drafts`, { method: 'POST', body: JSON.stringify(input) })
export const loadSuiteDraft = (projectId: string, draftId: string) => requestWithResponse<TestSuiteDraft>(`${projectScope(projectId)}/test-suite-drafts/${encodeURIComponent(draftId)}`)
export const updateSuiteDraft = (projectId: string, draftId: string, etag: string, input: SuiteDraftInput) => request<TestSuiteDraft>(`${projectScope(projectId)}/test-suite-drafts/${encodeURIComponent(draftId)}`, { method: 'PUT', headers: { 'if-match': etag }, body: JSON.stringify(input) })
export const publishSuiteDraft = (projectId: string, draftId: string, etag: string) => request<LibraryTestSuiteVersion>(`${projectScope(projectId)}/test-suite-drafts/${encodeURIComponent(draftId)}/publish`, { method: 'POST', headers: { 'if-match': etag } })
export const diffSuiteVersions = (projectId: string, from: string, to: string) => request<{ changes: Array<{ caseId: string; change: string }> }>(`${projectScope(projectId)}/test-suite-versions/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
export const deprecateSuiteVersion = (projectId: string, suiteVersionId: string) => request<LibraryTestSuiteVersion>(`${projectScope(projectId)}/test-suite-versions/${encodeURIComponent(suiteVersionId)}/deprecate`, { method: 'POST' })

export const createLibraryHandoff = (projectVersionId: string, libraryVersionId: string, input: { mode: 'smoke' | 'regression' | 'full' | 'custom'; suiteVersionId?: string; impactedCaseIds?: string[]; expectedLibrarySha256: string; executionReadinessOverrides?: import('./types').ExecutionReadinessOverrideInput[] }) => request<LibraryExecutionHandoff>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-case-library-versions/${encodeURIComponent(libraryVersionId)}/execution-handoffs`, { method: 'POST', body: JSON.stringify(input) })
export const loadLibraryHandoffs = (projectVersionId: string, libraryVersionId?: string) => request<{ items: LibraryExecutionHandoff[] }>(`/project-versions/${encodeURIComponent(projectVersionId)}/test-case-library-handoffs${libraryVersionId ? `?libraryVersionId=${encodeURIComponent(libraryVersionId)}` : ''}`)
