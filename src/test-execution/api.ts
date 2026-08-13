import type {
  ExecutionEnvironment,
  ExecutionHandoff,
  ExecutionReadiness,
  ExecutionRun,
  ExecutionTask,
  ExecutionTaskDetail,
  ScriptRevisionDiff,
  Versioned,
} from './types'

const apiBase = 'http://127.0.0.1:8787/api'

export class TestExecutionApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<Versioned<T>> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const body = await response.json().catch(() => ({})) as T & {
    code?: string
    message?: string
    details?: unknown
    error?: string
  }
  if (!response.ok) {
    throw new TestExecutionApiError(
      body.code ?? 'TEST_EXECUTION_REQUEST_FAILED',
      body.message ?? body.error ?? `测试执行请求失败（HTTP ${response.status}）`,
      response.status,
      body.details,
    )
  }
  return {
    value: body,
    etag: response.headers.get('etag') ?? '',
  }
}

const projectScope = (projectVersionId: string) =>
  `/project-versions/${encodeURIComponent(projectVersionId)}`
const runScope = (projectVersionId: string, runId: string) =>
  `${projectScope(projectVersionId)}/test-execution-runs/${encodeURIComponent(runId)}`
const taskScope = (projectVersionId: string, runId: string, taskId: string) =>
  `${runScope(projectVersionId, runId)}/tasks/${encodeURIComponent(taskId)}`

export async function loadReadiness(projectVersionId: string) {
  return (await request<ExecutionReadiness>(
    `${projectScope(projectVersionId)}/test-execution/readiness`,
  )).value
}

export async function loadEnvironments(projectVersionId: string) {
  return (await request<{ items: ExecutionEnvironment[] }>(
    `${projectScope(projectVersionId)}/test-execution/environments`,
  )).value.items
}

export async function loadHandoffs(projectVersionId: string) {
  return (await request<{ items: ExecutionHandoff[] }>(
    `${projectScope(projectVersionId)}/test-execution/handoffs`,
  )).value.items
}

export async function loadRuns(projectVersionId: string, limit = 50) {
  return (await request<{ items: ExecutionRun[] }>(
    `${projectScope(projectVersionId)}/test-execution-runs?limit=${limit}`,
  )).value.items
}

export function loadRun(projectVersionId: string, runId: string) {
  return request<ExecutionRun>(runScope(projectVersionId, runId))
}

export async function loadTasks(projectVersionId: string, runId: string) {
  return (await request<{ items: ExecutionTask[] }>(
    `${runScope(projectVersionId, runId)}/tasks`,
  )).value.items
}

export function loadTask(
  projectVersionId: string,
  runId: string,
  taskId: string,
) {
  return request<ExecutionTaskDetail>(
    taskScope(projectVersionId, runId, taskId),
  )
}

export function createRun(
  projectVersionId: string,
  handoffId: string,
  environmentId: string,
  idempotencyKey: string,
) {
  return request<ExecutionRun>(`${projectScope(projectVersionId)}/test-execution-runs`, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: JSON.stringify({ handoffId, environmentId }),
  })
}

export function cancelRun(
  projectVersionId: string,
  runId: string,
  etag: string,
) {
  return request<ExecutionRun>(`${runScope(projectVersionId, runId)}/cancel`, {
    method: 'POST',
    headers: { 'if-match': etag },
    body: JSON.stringify({}),
  })
}

export function retryTask(
  projectVersionId: string,
  runId: string,
  taskId: string,
  etag: string,
  idempotencyKey: string,
) {
  return request<{ run: ExecutionRun; task: ExecutionTask }>(
    `${taskScope(projectVersionId, runId, taskId)}/retry`,
    {
      method: 'POST',
      headers: {
        'if-match': etag,
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({}),
    },
  )
}

export async function loadScriptRevisionDiff(
  projectVersionId: string,
  runId: string,
  taskId: string,
  fromRevisionId: string,
  toRevisionId: string,
) {
  return (await request<ScriptRevisionDiff>(
    `${taskScope(projectVersionId, runId, taskId)}/script-revisions/diff?from=${encodeURIComponent(fromRevisionId)}&to=${encodeURIComponent(toRevisionId)}`,
  )).value
}

export function artifactUrl(
  artifactId: string,
  disposition: 'inline' | 'attachment' = 'attachment',
) {
  return `${apiBase}/test-execution-artifacts/${encodeURIComponent(artifactId)}?disposition=${disposition}`
}

export function executionIdempotencyKey(kind: 'create' | 'retry', targetId: string) {
  return `test-execution-${kind}-${targetId}-${crypto.randomUUID()}`
}
