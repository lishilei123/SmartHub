import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { canonicalSha256 } from '../application/canonical-json.js'
import {
  TestExecutionService,
  TestExecutionServiceError,
} from '../application/test-execution-service.js'
import type { ExecutionEnvironmentSnapshot } from '../domain/test-execution-types.js'
import type { ProjectVersion } from '../domain/types.js'
import type { Principal, ProjectVersionPermission } from '../domain/access-control.js'
import type { ExecutionArtifactStore } from '../infrastructure/execution-artifact-store.js'
import type { AccessControl } from './access-control.js'

export interface TestExecutionRouteContext {
  method: string
  url: URL
  principal: Principal
  controls: AccessControl
  service?: TestExecutionService
  artifactStore: ExecutionArtifactStore
  resolveProjectVersion(projectVersionId: string): Promise<ProjectVersion | null>
  readiness(): Promise<unknown>
  environments(): ExecutionEnvironmentSnapshot[]
  handoffs(projectVersionId: string): Promise<unknown[]>
}

export async function routeTestExecution(
  request: IncomingMessage,
  response: ServerResponse,
  context: TestExecutionRouteContext,
) {
  const { method, url, principal, controls } = context
  if (!url.pathname.includes('test-execution')) return false
  const service = context.service

  const readiness = /^\/api\/project-versions\/([^/]+)\/test-execution\/readiness$/.exec(url.pathname)
  if (readiness && method === 'GET') {
    await scopedProjectVersion(
      context,
      readiness[1],
      'test-execution:read',
    )
    return send(response, 200, await context.readiness())
  }

  const handoffs = /^\/api\/project-versions\/([^/]+)\/test-execution\/handoffs$/.exec(url.pathname)
  if (handoffs && method === 'GET') {
    const projectVersion = await scopedProjectVersion(
      context,
      handoffs[1],
      'test-execution:read',
    )
    return send(response, 200, {
      items: await context.handoffs(projectVersion.id),
    })
  }

  const environments = /^\/api\/project-versions\/([^/]+)\/test-execution\/environments$/.exec(url.pathname)
  if (environments && method === 'GET') {
    await scopedProjectVersion(
      context,
      environments[1],
      'test-execution:read',
    )
    return send(response, 200, {
      items: service?.environments() ?? context.environments(),
    })
  }

  const runs = /^\/api\/project-versions\/([^/]+)\/test-execution-runs$/.exec(url.pathname)
  if (runs && method === 'POST') {
    const projectVersion = await scopedProjectVersion(
      context,
      runs[1],
      'test-execution:create',
    )
    const body = await json(request)
    rejectUnknownFields(body, ['baseUrl', 'testDataBindings'])
    const run = await requireService(service).createRun({
      projectVersionId: projectVersion.id,
      baseUrl: String(body.baseUrl ?? ''),
      ...(body.testDataBindings !== undefined ? { testDataBindings: body.testDataBindings } : {}),
      idempotencyKey: header(request, 'idempotency-key'),
      createdBy: principal.subjectId,
    })
    response.setHeader('ETag', runEtag(run.stateVersion))
    return send(response, 202, run)
  }
  if (runs && method === 'GET') {
    const projectVersion = await scopedProjectVersion(
      context,
      runs[1],
      'test-execution:read',
    )
    const limit = url.searchParams.has('limit')
      ? Number(url.searchParams.get('limit'))
      : 50
    return send(response, 200, {
      items: await requireService(service).listRuns(projectVersion.id, limit),
    })
  }

  const runPath = /^\/api\/project-versions\/([^/]+)\/test-execution-runs\/([^/]+)$/.exec(url.pathname)
  if (runPath && method === 'GET') {
    const run = await scopedRun(
      requireService(service),
      controls,
      principal,
      runPath[1],
      runPath[2],
      'test-execution:read',
    )
    response.setHeader('ETag', runEtag(run.stateVersion))
    return send(response, 200, run)
  }

  const cancel = /^\/api\/project-versions\/([^/]+)\/test-execution-runs\/([^/]+)\/cancel$/.exec(url.pathname)
  if (cancel && method === 'POST') {
    const executionService = requireService(service)
    await scopedRun(
      executionService,
      controls,
      principal,
      cancel[1],
      cancel[2],
      'test-execution:cancel',
    )
    rejectUnknownFields(await json(request), [])
    const run = await executionService.cancelRun(
      cancel[2],
      parseRunIfMatch(request),
    )
    response.setHeader('ETag', runEtag(run.stateVersion))
    return send(response, 202, run)
  }

  const tasks = /^\/api\/project-versions\/([^/]+)\/test-execution-runs\/([^/]+)\/tasks$/.exec(url.pathname)
  if (tasks && method === 'GET') {
    const executionService = requireService(service)
    const run = await scopedRun(
      executionService,
      controls,
      principal,
      tasks[1],
      tasks[2],
      'test-execution:read',
    )
    return send(response, 200, {
      items: await executionService.listTasks(run.id),
    })
  }

  const runMaintenanceProposals = /^\/api\/project-versions\/([^/]+)\/test-execution-runs\/([^/]+)\/maintenance-proposals$/.exec(url.pathname)
  if (runMaintenanceProposals && method === 'GET') {
    const executionService = requireService(service)
    const run = await scopedRun(
      executionService,
      controls,
      principal,
      runMaintenanceProposals[1],
      runMaintenanceProposals[2],
      'test-execution:read',
    )
    privateNoStore(response)
    return send(response, 200, {
      items: await executionService.listMaintenanceProposals(run.id),
    })
  }

  const taskMaintenanceProposals = /^\/api\/project-versions\/([^/]+)\/test-execution-runs\/([^/]+)\/tasks\/([^/]+)\/maintenance-proposals$/.exec(url.pathname)
  if (taskMaintenanceProposals && method === 'GET') {
    const executionService = requireService(service)
    const scoped = await scopedTask(
      executionService,
      controls,
      principal,
      taskMaintenanceProposals[1],
      taskMaintenanceProposals[2],
      taskMaintenanceProposals[3],
      'test-execution:read',
    )
    privateNoStore(response)
    return send(response, 200, {
      items: await executionService.listTaskMaintenanceProposals(scoped.task.id),
    })
  }

  const maintenanceProposalDecision = /^\/api\/project-versions\/([^/]+)\/test-execution-runs\/([^/]+)\/maintenance-proposals\/([^/]+)\/decision$/.exec(url.pathname)
  if (maintenanceProposalDecision && method === 'POST') {
    const executionService = requireService(service)
    const scoped = await scopedMaintenanceProposal(
      executionService,
      controls,
      principal,
      maintenanceProposalDecision[1],
      maintenanceProposalDecision[2],
      maintenanceProposalDecision[3],
      'test-execution:maintain',
    )
    parseProposalIfMatch(request, scoped.proposal)
    const body = await json(request)
    rejectUnknownFields(body, ['decision'])
    const decision = String(body.decision ?? '')
    if (decision !== 'accepted' && decision !== 'rejected') {
      throw new TestExecutionServiceError(
        'TEST_EXECUTION_MAINTENANCE_DECISION_INVALID',
        'decision 只能是 accepted 或 rejected',
        400,
      )
    }
    const proposal = await executionService.decideMaintenanceProposal({
      proposalId: scoped.proposal.id,
      decision,
      decidedBy: principal.subjectId,
    })
    privateNoStore(response)
    response.setHeader('ETag', representationEtag(proposal))
    response.setHeader('Proposal-State-ETag', representationEtag(proposal))
    return send(response, 200, proposal)
  }

  const maintenanceProposalDetail = /^\/api\/project-versions\/([^/]+)\/test-execution-runs\/([^/]+)\/maintenance-proposals\/([^/]+)$/.exec(url.pathname)
  if (maintenanceProposalDetail && method === 'GET') {
    const executionService = requireService(service)
    const scoped = await scopedMaintenanceProposal(
      executionService,
      controls,
      principal,
      maintenanceProposalDetail[1],
      maintenanceProposalDetail[2],
      maintenanceProposalDetail[3],
      'test-execution:read',
    )
    const detail = await executionService.maintenanceProposalDetail(scoped.proposal.id)
    assertMaintenanceProposalDetailScope(detail, scoped.run, scoped.task)
    privateNoStore(response)
    response.setHeader('ETag', representationEtag(detail))
    response.setHeader('Proposal-State-ETag', representationEtag(detail.proposal))
    return send(response, 200, detail)
  }

  const taskPath = /^\/api\/project-versions\/([^/]+)\/test-execution-runs\/([^/]+)\/tasks\/([^/]+)$/.exec(url.pathname)
  if (taskPath && method === 'GET') {
    const executionService = requireService(service)
    const detail = await executionService.taskDetail(taskPath[3])
    await authorizeTaskDetail(
      detail,
      controls,
      principal,
      taskPath[1],
      taskPath[2],
      'test-execution:read',
    )
    privateNoStore(response)
    response.setHeader('ETag', taskEtag(
      detail.task.stateVersion,
      detail.run.stateVersion,
    ))
    return send(response, 200, detail)
  }

  const retry = /^\/api\/project-versions\/([^/]+)\/test-execution-runs\/([^/]+)\/tasks\/([^/]+)\/retry$/.exec(url.pathname)
  if (retry && method === 'POST') {
    const executionService = requireService(service)
    const scoped = await scopedTask(
      executionService,
      controls,
      principal,
      retry[1],
      retry[2],
      retry[3],
      'test-execution:retry',
    )
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

  const attempts = /^\/api\/project-versions\/([^/]+)\/test-execution-runs\/([^/]+)\/tasks\/([^/]+)\/attempts$/.exec(url.pathname)
  if (attempts && method === 'GET') {
    return taskHistory(response, context, attempts, 'attempts')
  }

  const diagnoses = /^\/api\/project-versions\/([^/]+)\/test-execution-runs\/([^/]+)\/tasks\/([^/]+)\/diagnoses$/.exec(url.pathname)
  if (diagnoses && method === 'GET') {
    return taskHistory(response, context, diagnoses, 'diagnoses')
  }

  const revisions = /^\/api\/project-versions\/([^/]+)\/test-execution-runs\/([^/]+)\/tasks\/([^/]+)\/script-revisions$/.exec(url.pathname)
  if (revisions && method === 'GET') {
    return taskHistory(response, context, revisions, 'scriptRevisions')
  }

  const revisionDiff = /^\/api\/project-versions\/([^/]+)\/test-execution-runs\/([^/]+)\/tasks\/([^/]+)\/script-revisions\/diff$/.exec(url.pathname)
  if (revisionDiff && method === 'GET') {
    const executionService = requireService(service)
    const scoped = await scopedTask(
      executionService,
      controls,
      principal,
      revisionDiff[1],
      revisionDiff[2],
      revisionDiff[3],
      'test-execution:read',
    )
    const result = await executionService.scriptRevisionDiff(
      scoped.task.id,
      requiredQuery(url, 'from'),
      requiredQuery(url, 'to'),
    )
    response.setHeader('ETag', representationEtag(result))
    return send(response, 200, result)
  }

  const artifactPath = /^\/api\/test-execution-artifacts\/([^/]+)$/.exec(url.pathname)
  if (artifactPath && method === 'GET') {
    const executionService = requireService(service)
    const artifact = await executionService.artifact(artifactPath[1])
    const run = await executionService.getRun(artifact.metadata.runId)
    await controls.authorize(
      principal,
      run.projectVersionId,
      'test-execution:download',
    )
    const disposition = url.searchParams.get('disposition') ?? 'attachment'
    if (disposition !== 'attachment' && disposition !== 'inline') {
      throw new TestExecutionServiceError(
        'TEST_EXECUTION_ARTIFACT_DISPOSITION_INVALID',
        'disposition 只能是 attachment 或 inline',
        400,
      )
    }
    const stored = await readArtifactStore(
      () => context.artifactStore.stat(artifact.storagePath),
    )
    if (
      stored.sha256 !== artifact.metadata.sha256
      || stored.size !== artifact.metadata.size
    ) {
      throw new TestExecutionServiceError(
        'TEST_EXECUTION_ARTIFACT_DRIFT',
        'Artifact 实际内容与正式元数据不一致',
        409,
      )
    }
    const stream = await readArtifactStore(
      () => context.artifactStore.open(artifact.storagePath),
    )
    response.statusCode = 200
    response.setHeader('Content-Type', safeMimeType(artifact.metadata.mimeType))
    response.setHeader('Content-Length', stored.size)
    response.setHeader('ETag', artifactEtag(stored.sha256))
    response.setHeader('Content-Disposition', `${disposition}; filename="${artifactFileName(artifact.metadata)}"`)
    response.setHeader('Cache-Control', 'private, no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'")
    cors(response)
    try {
      await pipeline(stream, response)
    } catch (error) {
      if (!response.headersSent) throw error
      if (!response.destroyed) response.destroy(error as Error)
    }
    return true
  }

  return false
}

async function taskHistory(
  response: ServerResponse,
  context: TestExecutionRouteContext,
  match: RegExpExecArray,
  key: 'attempts' | 'diagnoses' | 'scriptRevisions',
) {
  const service = requireService(context.service)
  const detail = await service.taskDetail(match[3])
  await authorizeTaskDetail(
    detail,
    context.controls,
    context.principal,
    match[1],
    match[2],
    'test-execution:read',
  )
  response.setHeader('ETag', taskEtag(
    detail.task.stateVersion,
    detail.run.stateVersion,
  ))
  return send(response, 200, { items: detail[key] })
}

async function scopedProjectVersion(
  context: TestExecutionRouteContext,
  projectVersionId: string,
  permission: ProjectVersionPermission,
) {
  const projectVersion = await context.resolveProjectVersion(projectVersionId)
  if (!projectVersion) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_PROJECT_VERSION_NOT_FOUND',
      '项目版本不存在',
      404,
    )
  }
  await context.controls.authorize(
    context.principal,
    projectVersion.id,
    permission,
  )
  return projectVersion
}

async function scopedRun(
  service: TestExecutionService,
  controls: AccessControl,
  principal: Principal,
  projectVersionId: string,
  runId: string,
  permission: ProjectVersionPermission,
) {
  const run = await service.getRun(runId)
  await controls.authorize(principal, run.projectVersionId, permission)
  if (run.projectVersionId !== projectVersionId) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_RUN_NOT_FOUND',
      '测试执行 Run 不存在',
      404,
    )
  }
  return run
}

async function authorizeTaskDetail(
  detail: Awaited<ReturnType<TestExecutionService['taskDetail']>>,
  controls: AccessControl,
  principal: Principal,
  projectVersionId: string,
  runId: string,
  permission: ProjectVersionPermission,
) {
  await controls.authorize(principal, detail.run.projectVersionId, permission)
  if (
    detail.run.projectVersionId !== projectVersionId
    || detail.run.id !== runId
    || detail.task.runId !== detail.run.id
  ) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_TASK_NOT_FOUND',
      '测试执行 Task 不存在',
      404,
    )
  }
}

async function scopedMaintenanceProposal(
  service: TestExecutionService,
  controls: AccessControl,
  principal: Principal,
  projectVersionId: string,
  runId: string,
  proposalId: string,
  permission: ProjectVersionPermission,
) {
  const proposal = await service.getMaintenanceProposal(proposalId)
  const task = await service.getTask(proposal.taskId)
  const run = await service.getRun(task.runId)
  await controls.authorize(principal, run.projectVersionId, permission)
  if (
    run.projectVersionId !== projectVersionId
    || run.id !== runId
    || task.runId !== run.id
    || proposal.runId !== run.id
    || proposal.taskId !== task.id
  ) {
    throw maintenanceProposalNotFound()
  }
  return { proposal, task, run }
}

function assertMaintenanceProposalDetailScope(
  detail: Awaited<ReturnType<TestExecutionService['maintenanceProposalDetail']>>,
  run: Awaited<ReturnType<TestExecutionService['getRun']>>,
  task: Awaited<ReturnType<TestExecutionService['getTask']>>,
) {
  if (
    detail.run.id !== run.id
    || detail.run.projectVersionId !== run.projectVersionId
    || detail.task.id !== task.id
    || detail.task.runId !== run.id
    || detail.proposal.runId !== run.id
    || detail.proposal.taskId !== task.id
  ) throw maintenanceProposalNotFound()
}

function maintenanceProposalNotFound() {
  return new TestExecutionServiceError(
    'TEST_EXECUTION_MAINTENANCE_PROPOSAL_NOT_FOUND',
    '用例维护建议不存在',
    404,
  )
}

async function readArtifactStore<T>(operation: () => Promise<T>) {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof TestExecutionServiceError) throw error
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_ARTIFACT_UNAVAILABLE',
      'Artifact 内容当前不可用',
      503,
    )
  }
}

async function scopedTask(
  service: TestExecutionService,
  controls: AccessControl,
  principal: Principal,
  projectVersionId: string,
  runId: string,
  taskId: string,
  permission: ProjectVersionPermission,
) {
  const task = await service.getTask(taskId)
  const run = await service.getRun(task.runId)
  await controls.authorize(principal, run.projectVersionId, permission)
  if (
    run.projectVersionId !== projectVersionId
    || run.id !== runId
    || task.runId !== run.id
  ) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_TASK_NOT_FOUND',
      '测试执行 Task 不存在',
      404,
    )
  }
  return { run, task }
}

function requireService(service?: TestExecutionService) {
  if (!service) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_POSTGRES_UNAVAILABLE',
      '测试执行要求 PostgreSQL 正式存储',
      503,
    )
  }
  return service
}

function parseRunIfMatch(request: IncomingMessage) {
  const value = ifMatch(request)
  const match = /^"test-execution-run-v(0|[1-9][0-9]*)"$/.exec(value)
  if (!match) throw invalidIfMatch('Run')
  return safeStateVersion(match[1], 'Run')
}

function parseTaskIfMatch(request: IncomingMessage) {
  const value = ifMatch(request)
  const match = /^"test-execution-task-v(0|[1-9][0-9]*)-run-v(0|[1-9][0-9]*)"$/.exec(value)
  if (!match) throw invalidIfMatch('Task')
  return {
    taskStateVersion: safeStateVersion(match[1], 'Task'),
    runStateVersion: safeStateVersion(match[2], 'Run'),
  }
}

function ifMatch(request: IncomingMessage) {
  const value = header(request, 'if-match')
  if (!value) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_IF_MATCH_REQUIRED',
      '该命令必须提供 If-Match',
      428,
    )
  }
  return value
}

function invalidIfMatch(resource: string) {
  return new TestExecutionServiceError(
    'TEST_EXECUTION_IF_MATCH_INVALID',
    `${resource} If-Match 无效`,
    400,
  )
}

function parseProposalIfMatch(request: IncomingMessage, proposal: unknown) {
  const value = ifMatch(request)
  if (!/^"sha256-[a-f0-9]{64}"$/u.test(value)) throw invalidIfMatch('用例维护建议')
  if (value !== representationEtag(proposal)) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_MAINTENANCE_PROPOSAL_STATE_CONFLICT',
      '用例维护建议状态已变化',
      412,
    )
  }
}

function safeStateVersion(value: string, resource: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw invalidIfMatch(resource)
  return parsed
}

function runEtag(stateVersion: number) {
  return `"test-execution-run-v${stateVersion}"`
}

function taskEtag(taskStateVersion: number, runStateVersion: number) {
  return `"test-execution-task-v${taskStateVersion}-run-v${runStateVersion}"`
}

function artifactEtag(sha256: string) {
  return `"sha256-${sha256}"`
}

function representationEtag(value: unknown) {
  return `"sha256-${canonicalSha256(value)}"`
}

function requiredQuery(url: URL, name: string) {
  const value = url.searchParams.get(name)?.trim()
  if (!value) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_QUERY_REQUIRED',
      `${name} 查询参数不能为空`,
      400,
    )
  }
  return value
}

function rejectUnknownFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
) {
  const unknown = Object.keys(body).filter(key => !allowed.includes(key))
  if (unknown.length) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_REQUEST_FIELD_FORBIDDEN',
      '请求包含不允许的字段',
      400,
      { fields: unknown },
    )
  }
}

function artifactFileName(metadata: {
  id: string
  type: string
  mimeType: string
}) {
  const extension = artifactExtension(metadata.type, metadata.mimeType)
  const id = metadata.id.replace(/[^a-zA-Z0-9._-]/gu, '_').slice(0, 120)
  return `${metadata.type}-${id}${extension}`
}

function artifactExtension(type: string, mimeType: string) {
  if (type === 'screenshot' && mimeType === 'image/png') return '.png'
  if (type === 'video' && mimeType === 'video/webm') return '.webm'
  if (type === 'trace') return '.zip'
  if (type === 'har') return '.har'
  if (type === 'script') return '.ts'
  if (type === 'log') return '.log'
  if (mimeType === 'application/json') return '.json'
  return '.bin'
}

function safeMimeType(value: string) {
  const mimeType = String(value ?? '').trim().toLocaleLowerCase()
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:; ?[a-z0-9_-]+=[a-z0-9._-]+)*$/u.test(mimeType)
    && mimeType.length <= 200
    ? mimeType
    : 'application/octet-stream'
}

function header(request: IncomingMessage, name: string) {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

async function json(request: IncomingMessage) {
  const maximumBytes = 64 * 1024
  const declared = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_REQUEST_TOO_LARGE',
      '请求体不能超过 64 KiB',
      413,
    )
  }
  const chunks: Buffer[] = []
  let received = 0
  for await (const value of request) {
    const chunk = Buffer.from(value)
    received += chunk.length
    if (received > maximumBytes) {
      throw new TestExecutionServiceError(
        'TEST_EXECUTION_REQUEST_TOO_LARGE',
        '请求体不能超过 64 KiB',
        413,
      )
    }
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('INVALID_OBJECT')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_REQUEST_JSON_INVALID',
      '请求体必须是 JSON 对象',
      400,
    )
  }
}

function cors(response: ServerResponse) {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  response.setHeader(
    'Access-Control-Allow-Headers',
    'content-type, authorization, idempotency-key, if-match',
  )
  response.setHeader(
    'Access-Control-Expose-Headers',
    'etag, proposal-state-etag, content-disposition, content-length',
  )
}

function privateNoStore(response: ServerResponse) {
  response.setHeader('Cache-Control', 'private, no-store')
  response.setHeader('Vary', 'Authorization')
}

function send(response: ServerResponse, status: number, value: unknown) {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  cors(response)
  response.end(value == null ? '' : JSON.stringify(value))
  return true
}
