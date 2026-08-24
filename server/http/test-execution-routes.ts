import type { IncomingMessage, ServerResponse } from 'node:http'
import { canonicalSha256 } from '../application/canonical-json.js'
import { TestExecutionService, TestExecutionServiceError } from '../application/test-execution-service.js'
import type { ProjectVersion } from '../domain/types.js'
import type { Principal, ProjectVersionPermission } from '../domain/access-control.js'
import type { AccessControl } from './access-control.js'

export interface TestExecutionRouteContext {
  method: string
  url: URL
  request: IncomingMessage
  response: ServerResponse
  principal: Principal
  controls: AccessControl
  service?: TestExecutionService
  resolveProjectVersion(projectVersionId: string): Promise<ProjectVersion | null>
  readiness(): Promise<unknown>
  handoffs(projectVersionId: string): Promise<unknown[]>
}

export async function handleTestExecutionRoute(context: TestExecutionRouteContext) {
  const { method, url, request, response, principal, controls, service } = context
  if (method === 'OPTIONS' && url.pathname.includes('/test-execution')) { cors(response); response.statusCode = 204; response.end(); return true }

  const readiness = /^\/api\/project-versions\/([^/]+)\/test-execution\/readiness$/.exec(url.pathname)
  if (readiness && method === 'GET') {
    await scopedProjectVersion(context, readiness[1], 'test-execution:read')
    privateNoStore(response)
    return send(response, 200, await context.readiness())
  }

  const handoffs = /^\/api\/project-versions\/([^/]+)\/test-execution\/handoffs$/.exec(url.pathname)
  if (handoffs && method === 'GET') {
    await scopedProjectVersion(context, handoffs[1], 'test-execution:read')
    privateNoStore(response)
    return send(response, 200, { items: await context.handoffs(handoffs[1]) })
  }

  const runs = /^\/api\/project-versions\/([^/]+)\/test-execution-runs$/.exec(url.pathname)
  if (runs && method === 'GET') {
    const executionService = requireService(service)
    await scopedProjectVersion(context, runs[1], 'test-execution:read')
    const limit = Number(url.searchParams.get('limit') ?? 50)
    privateNoStore(response)
    return send(response, 200, { items: await executionService.listRuns(runs[1], limit) })
  }
  if (runs && method === 'POST') {
    const executionService = requireService(service)
    await scopedProjectVersion(context, runs[1], 'test-execution:create')
    const body = await json(request)
    rejectUnknownFields(body, ['agentUnderTestId'])
    const run = await executionService.createRun({
      projectVersionId: runs[1],
      agentUnderTestId: String(body.agentUnderTestId ?? ''),
      idempotencyKey: header(request, 'idempotency-key'),
      createdBy: principal.subjectId,
    })
    privateNoStore(response)
    response.setHeader('ETag', runEtag(run.stateVersion))
    return send(response, 202, run)
  }

  const runPath = /^\/api\/project-versions\/([^/]+)\/test-execution-runs\/([^/]+)$/.exec(url.pathname)
  if (runPath && method === 'GET') {
    const run = await scopedRun(requireService(service), controls, principal, runPath[1], runPath[2], 'test-execution:read')
    privateNoStore(response)
    response.setHeader('ETag', runEtag(run.stateVersion))
    return send(response, 200, run)
  }

  const runTasks = /^\/api\/project-versions\/([^/]+)\/test-execution-runs\/([^/]+)\/tasks$/.exec(url.pathname)
  if (runTasks && method === 'GET') {
    const executionService = requireService(service)
    const run = await scopedRun(executionService, controls, principal, runTasks[1], runTasks[2], 'test-execution:read')
    privateNoStore(response)
    return send(response, 200, { items: await executionService.listTasks(run.id) })
  }

  const cancel = /^\/api\/project-versions\/([^/]+)\/test-execution-runs\/([^/]+)\/cancel$/.exec(url.pathname)
  if (cancel && method === 'POST') {
    const executionService = requireService(service)
    const run = await scopedRun(executionService, controls, principal, cancel[1], cancel[2], 'test-execution:cancel')
    rejectUnknownFields(await json(request), [])
    const cancelled = await executionService.cancelRun(run.id, parseRunIfMatch(request))
    response.setHeader('ETag', runEtag(cancelled.stateVersion))
    return send(response, 202, cancelled)
  }

  const taskPath = /^\/api\/project-versions\/([^/]+)\/test-execution-runs\/([^/]+)\/tasks\/([^/]+)$/.exec(url.pathname)
  if (taskPath && method === 'GET') {
    const executionService = requireService(service)
    const detail = await executionService.taskDetail(taskPath[3])
    await authorizeTaskDetail(detail, controls, principal, taskPath[1], taskPath[2], 'test-execution:read')
    privateNoStore(response)
    response.setHeader('ETag', taskEtag(detail.task.stateVersion, detail.run.stateVersion))
    return send(response, 200, detail)
  }

  const retry = /^\/api\/project-versions\/([^/]+)\/test-execution-runs\/([^/]+)\/tasks\/([^/]+)\/retry$/.exec(url.pathname)
  if (retry && method === 'POST') {
    const executionService = requireService(service)
    const scoped = await scopedTask(executionService, controls, principal, retry[1], retry[2], retry[3], 'test-execution:retry')
    rejectUnknownFields(await json(request), [])
    const versions = parseTaskIfMatch(request)
    const task = await executionService.retryTask({
      taskId: scoped.task.id,
      expectedTaskStateVersion: versions.taskStateVersion,
      expectedRunStateVersion: versions.runStateVersion,
      idempotencyKey: header(request, 'idempotency-key'),
      requestedBy: principal.subjectId,
    })
    const run = await executionService.getRun(task.runId)
    response.setHeader('ETag', taskEtag(task.stateVersion, run.stateVersion))
    return send(response, 202, { run, task })
  }
  return false
}

async function scopedProjectVersion(context: TestExecutionRouteContext, projectVersionId: string, permission: ProjectVersionPermission) {
  const projectVersion = await context.resolveProjectVersion(projectVersionId)
  if (!projectVersion) throw new TestExecutionServiceError('TEST_EXECUTION_PROJECT_VERSION_NOT_FOUND', '项目版本不存在', 404)
  await context.controls.authorize(context.principal, projectVersion.id, permission)
  return projectVersion
}

async function scopedRun(service: TestExecutionService, controls: AccessControl, principal: Principal, projectVersionId: string, runId: string, permission: ProjectVersionPermission) {
  const run = await service.getRun(runId)
  await controls.authorize(principal, run.projectVersionId, permission)
  if (run.projectVersionId !== projectVersionId) throw new TestExecutionServiceError('TEST_EXECUTION_RUN_NOT_FOUND', '测试执行 Run 不存在', 404)
  return run
}

async function scopedTask(service: TestExecutionService, controls: AccessControl, principal: Principal, projectVersionId: string, runId: string, taskId: string, permission: ProjectVersionPermission) {
  const task = await service.getTask(taskId)
  const run = await service.getRun(task.runId)
  await controls.authorize(principal, run.projectVersionId, permission)
  if (run.projectVersionId !== projectVersionId || run.id !== runId || task.runId !== run.id) throw new TestExecutionServiceError('TEST_EXECUTION_TASK_NOT_FOUND', '测试执行 Task 不存在', 404)
  return { run, task }
}

async function authorizeTaskDetail(detail: Awaited<ReturnType<TestExecutionService['taskDetail']>>, controls: AccessControl, principal: Principal, projectVersionId: string, runId: string, permission: ProjectVersionPermission) {
  await controls.authorize(principal, detail.run.projectVersionId, permission)
  if (detail.run.projectVersionId !== projectVersionId || detail.run.id !== runId || detail.task.runId !== detail.run.id) throw new TestExecutionServiceError('TEST_EXECUTION_TASK_NOT_FOUND', '测试执行 Task 不存在', 404)
}

function requireService(service?: TestExecutionService) {
  if (!service) throw new TestExecutionServiceError('TEST_EXECUTION_POSTGRES_UNAVAILABLE', 'Agent Test 执行要求 PostgreSQL 正式存储', 503)
  return service
}

function parseRunIfMatch(request: IncomingMessage) {
  const match = /^"test-execution-run-v(0|[1-9][0-9]*)"$/.exec(ifMatch(request))
  if (!match) throw invalidIfMatch('Run')
  return safeStateVersion(match[1], 'Run')
}

function parseTaskIfMatch(request: IncomingMessage) {
  const match = /^"test-execution-task-v(0|[1-9][0-9]*)-run-v(0|[1-9][0-9]*)"$/.exec(ifMatch(request))
  if (!match) throw invalidIfMatch('Task')
  return { taskStateVersion: safeStateVersion(match[1], 'Task'), runStateVersion: safeStateVersion(match[2], 'Run') }
}

function ifMatch(request: IncomingMessage) {
  const value = header(request, 'if-match')
  if (!value) throw new TestExecutionServiceError('TEST_EXECUTION_IF_MATCH_REQUIRED', '该命令必须提供 If-Match', 428)
  return value
}

function invalidIfMatch(resource: string) { return new TestExecutionServiceError('TEST_EXECUTION_IF_MATCH_INVALID', `${resource} If-Match 无效`, 400) }
function safeStateVersion(value: string, resource: string) { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw invalidIfMatch(resource); return parsed }
function runEtag(stateVersion: number) { return `"test-execution-run-v${stateVersion}"` }
function taskEtag(taskStateVersion: number, runStateVersion: number) { return `"test-execution-task-v${taskStateVersion}-run-v${runStateVersion}"` }
export function representationEtag(value: unknown) { return `"sha256-${canonicalSha256(value)}"` }

function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]) {
  const unknown = Object.keys(body).filter(key => !allowed.includes(key))
  if (unknown.length) throw new TestExecutionServiceError('TEST_EXECUTION_REQUEST_FIELD_FORBIDDEN', '请求包含不允许的字段', 400, { fields: unknown })
}

function header(request: IncomingMessage, name: string) { const value = request.headers[name]; return Array.isArray(value) ? value[0] ?? '' : value ?? '' }

async function json(request: IncomingMessage) {
  const maximumBytes = 64 * 1024
  const chunks: Buffer[] = []
  let received = 0
  for await (const value of request) {
    const chunk = Buffer.from(value); received += chunk.length
    if (received > maximumBytes) throw new TestExecutionServiceError('TEST_EXECUTION_REQUEST_TOO_LARGE', '请求体不能超过 64 KiB', 413)
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_OBJECT')
    return parsed as Record<string, unknown>
  } catch { throw new TestExecutionServiceError('TEST_EXECUTION_REQUEST_JSON_INVALID', '请求体必须是 JSON 对象', 400) }
}

function cors(response: ServerResponse) {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, idempotency-key, if-match')
  response.setHeader('Access-Control-Expose-Headers', 'etag')
}
function privateNoStore(response: ServerResponse) { response.setHeader('Cache-Control', 'private, no-store'); response.setHeader('Vary', 'Authorization') }
function send(response: ServerResponse, status: number, value: unknown) { response.statusCode = status; response.setHeader('Content-Type', 'application/json; charset=utf-8'); cors(response); response.end(value == null ? '' : JSON.stringify(value)); return true }
