import type { CreateTestDesignInput, TestCaseSetVersion, TestDesign, TestDesignCase, TestDesignCoverageAudit, TestDesignInputCandidates, TestDesignWorkflowRun, TestExecutionHandoff, TestPointNode, TestPointTree, TestPointTreeOperation, TestSuiteVersion } from './types'

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
export const reviewCase = (projectVersionId: string, designId: string, runId: string, caseId: string, decision: 'submit' | 'approve' | 'reject' | 'request_revision' | 'withdraw', targetRevision: number) => request<TestDesignCase>(`${runScope(projectVersionId, designId, runId)}/test-cases/${encodeURIComponent(caseId)}/review-actions`, { method: 'POST', body: JSON.stringify({ decision, targetRevision }) })
export const batchReviewCases = (projectVersionId: string, designId: string, runId: string, targets: Array<{ caseId: string; targetRevision: number }>, decision: 'submit' | 'approve') => request<TestDesignCase[]>(`${runScope(projectVersionId, designId, runId)}/test-cases/batch-review-actions`, { method: 'POST', body: JSON.stringify({ targets, decision }) })
export const reAudit = (projectVersionId: string, designId: string, runId: string) => request<TestDesignCoverageAudit>(`${runScope(projectVersionId, designId, runId)}/actions/re-audit`, { method: 'POST' })
export const actOnFinding = (projectVersionId: string, designId: string, runId: string, findingId: string, expectedVersion: number) => request(`${runScope(projectVersionId, designId, runId)}/findings/${encodeURIComponent(findingId)}/actions`, { method: 'POST', body: JSON.stringify({ expectedVersion, decision: 'resolve' }) })
export const actOnConfirmation = (projectVersionId: string, designId: string, runId: string, itemId: string, expectedVersion: number) => request(`${runScope(projectVersionId, designId, runId)}/confirmation-items/${encodeURIComponent(itemId)}/actions`, { method: 'POST', body: JSON.stringify({ expectedVersion, decision: 'resolve' }) })
export const publishCaseSet = (projectVersionId: string, designId: string, runId: string, input: { name: string; expectedAuditId: string; expectedCaseSetSha256: string }) => request<TestCaseSetVersion>(`${runScope(projectVersionId, designId, runId)}/test-case-set-versions`, { method: 'POST', body: JSON.stringify(input) })
export const createHandoff = (versionId: string, input: { strategy: 'standard' | 'fast' | 'full'; smokeSuiteVersionId?: string; regressionSuiteVersionId?: string; expectedCaseSetSha256: string }) => request<TestExecutionHandoff>(`/test-case-set-versions/${encodeURIComponent(versionId)}/execution-handoffs`, { method: 'POST', body: JSON.stringify(input) })
export const loadHandoffs = (versionId: string) => request<{ items: TestExecutionHandoff[] }>(`/test-case-set-versions/${encodeURIComponent(versionId)}/execution-handoffs`)
export const loadSuites = (projectId: string) => request<{ items: TestSuiteVersion[] }>(`/projects/${encodeURIComponent(projectId)}/test-suite-versions`)
export const exportCaseSetUrl = (versionId: string, format: 'json' | 'markdown' | 'xlsx') => `${apiBase}/test-case-set-versions/${encodeURIComponent(versionId)}/${format === 'json' ? 'export.json' : format === 'xlsx' ? 'export.xlsx' : 'report.md'}`
