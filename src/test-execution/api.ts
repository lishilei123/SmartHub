import type { AgentUnderTest, ExecutionReadiness, ExecutionRun, ExecutionTask, ExecutionTaskDetail, Versioned } from './types'

const apiBase = 'http://127.0.0.1:8787/api'
export class TestExecutionApiError extends Error { constructor(readonly code: string, message: string, readonly status: number, readonly details?: unknown) { super(message) } }
async function request<T>(path: string, init?: RequestInit): Promise<Versioned<T>> {
  const response = await fetch(`${apiBase}${path}`, { ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } })
  const body = await response.json().catch(() => ({})) as T & { code?: string; message?: string; details?: unknown; error?: string }
  if (!response.ok) throw new TestExecutionApiError(body.code ?? 'TEST_EXECUTION_REQUEST_FAILED', body.message ?? body.error ?? `测试执行请求失败（HTTP ${response.status}）`, response.status, body.details)
  return { value: body, etag: response.headers.get('etag') ?? '' }
}
const projectScope = (id: string) => `/project-versions/${encodeURIComponent(id)}`
const runScope = (projectVersionId: string, runId: string) => `${projectScope(projectVersionId)}/test-execution-runs/${encodeURIComponent(runId)}`
const taskScope = (projectVersionId: string, runId: string, taskId: string) => `${runScope(projectVersionId, runId)}/tasks/${encodeURIComponent(taskId)}`
export async function loadReadiness(id: string) { return (await request<ExecutionReadiness>(`${projectScope(id)}/test-execution/readiness`)).value }
export async function loadAgentsUnderTest(id: string) { return (await request<{ items: AgentUnderTest[] }>(`${projectScope(id)}/agents-under-test`)).value.items }
export async function createAgentUnderTest(id: string, input: { name: string; endpoint: string; protocol: 'http' | 'sse'; authenticationConfig: AgentUnderTest['authenticationConfig']; requestMapping: AgentUnderTest['requestMapping']; responseMapping: AgentUnderTest['responseMapping']; documentationRefs: string[] }) { return (await request<AgentUnderTest>(`${projectScope(id)}/agents-under-test`, { method: 'POST', body: JSON.stringify(input) })).value }
export async function loadRuns(id: string, limit = 50) { return (await request<{ items: ExecutionRun[] }>(`${projectScope(id)}/test-execution-runs?limit=${limit}`)).value.items }
export function loadRun(id: string, runId: string) { return request<ExecutionRun>(runScope(id, runId)) }
export async function loadTasks(id: string, runId: string) { return (await request<{ items: ExecutionTask[] }>(`${runScope(id, runId)}/tasks`)).value.items }
export function loadTask(id: string, runId: string, taskId: string) { return request<ExecutionTaskDetail>(taskScope(id, runId, taskId)) }
export function createRun(id: string, agentUnderTestId: string, key: string) { return request<ExecutionRun>(`${projectScope(id)}/test-execution-runs`, { method: 'POST', headers: { 'idempotency-key': key }, body: JSON.stringify({ agentUnderTestId }) }) }
export function cancelRun(id: string, runId: string, etag: string) { return request<ExecutionRun>(`${runScope(id, runId)}/cancel`, { method: 'POST', headers: { 'if-match': etag }, body: '{}' }) }
export function retryTask(id: string, runId: string, taskId: string, etag: string, key: string) { return request<{ run: ExecutionRun; task: ExecutionTask }>(`${taskScope(id, runId, taskId)}/retry`, { method: 'POST', headers: { 'if-match': etag, 'idempotency-key': key }, body: '{}' }) }
export function executionIdempotencyKey(kind: 'create' | 'retry', targetId: string) { return `agent-test-${kind}-${targetId}-${crypto.randomUUID()}` }
