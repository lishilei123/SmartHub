import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PassThrough, Readable } from 'node:stream'
import test from 'node:test'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import type { TestExecutionService } from '../server/application/test-execution-service.js'
import type {
  ExecutionArtifactStore,
} from '../server/infrastructure/execution-artifact-store.js'
import { routeTestExecution } from '../server/http/test-execution-routes.js'

const principal = {
  subjectId: 'operator-1',
  displayName: '执行人员',
}

const run = {
  id: 'run-1',
  projectVersionId: 'pv-1',
  stateVersion: 4,
}

const task = {
  id: 'task-1',
  runId: 'run-1',
  stateVersion: 7,
}

test('测试执行创建只接受 Handoff、环境与受控数据绑定并传入认证主体和幂等键', async () => {
  let input: Record<string, unknown> | undefined
  const service = {
    async createRun(value: Record<string, unknown>) {
      input = value
      return { ...run, status: 'queued' }
    },
  }
  const result = await routeCall({
    method: 'POST',
    path: '/api/project-versions/pv-1/test-execution-runs',
    body: {
      handoffId: 'handoff-1',
      environmentId: 'staging',
      testDataBindings: [{
        requirementId: 'data-login-user',
        sourceType: 'fixture',
        sourceRef: 'fixture://project/login-users/v3',
      }],
    },
    headers: { 'idempotency-key': 'create-run-key' },
    service,
  })
  assert.equal(result.status, 202)
  assert.equal(result.headers.get('etag'), '"test-execution-run-v4"')
  assert.deepEqual(input, {
    projectVersionId: 'pv-1',
    handoffId: 'handoff-1',
    environmentId: 'staging',
    testDataBindings: [{
      requirementId: 'data-login-user',
      sourceType: 'fixture',
      sourceRef: 'fixture://project/login-users/v3',
    }],
    idempotencyKey: 'create-run-key',
    createdBy: 'operator-1',
  })
  assert.equal(result.permissions[0]?.permission, 'test-execution:create')
})

test('不存在的正式 ProjectVersion 在授权前返回 404', async () => {
  let authorized = false
  await assert.rejects(
    routeCall({
      method: 'GET',
      path: '/api/project-versions/pv-missing/test-execution/readiness',
      service: {},
      resolveProjectVersion: async () => null,
      onAuthorize() { authorized = true },
    }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'TEST_EXECUTION_PROJECT_VERSION_NOT_FOUND'
      && 'status' in error
      && error.status === 404,
  )
  assert.equal(authorized, false)
})

test('测试执行创建拒绝客户端覆盖 execution mode', async () => {
  await assert.rejects(
    routeCall({
      method: 'POST',
      path: '/api/project-versions/pv-1/test-execution-runs',
      body: {
        handoffId: 'handoff-1',
        environmentId: 'staging',
        mode: 'smoke',
      },
      headers: { 'idempotency-key': 'create-run-key' },
      service: { async createRun() { throw new Error('SHOULD_NOT_RUN') } },
    }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'TEST_EXECUTION_REQUEST_FIELD_FORBIDDEN',
  )
})

test('人工重试从组合 If-Match 提取 Run/Task CAS 且保留幂等请求身份', async () => {
  let retryInput: Record<string, unknown> | undefined
  const service = {
    async getTask(taskId: string) {
      assert.equal(taskId, task.id)
      return task
    },
    async getRun(runId: string) {
      assert.equal(runId, run.id)
      return run
    },
    async retryTask(value: Record<string, unknown>) {
      retryInput = value
      return { ...task, status: 'ready', stateVersion: 8 }
    },
  }
  const result = await routeCall({
    method: 'POST',
    path: '/api/project-versions/pv-1/test-execution-runs/run-1/tasks/task-1/retry',
    headers: {
      'if-match': '"test-execution-task-v7-run-v4"',
      'idempotency-key': 'manual-retry-key',
    },
    body: {},
    service,
  })
  assert.equal(result.status, 202)
  assert.equal(
    result.headers.get('etag'),
    '"test-execution-task-v8-run-v4"',
  )
  assert.deepEqual(retryInput, {
    taskId: 'task-1',
    expectedTaskStateVersion: 7,
    expectedRunStateVersion: 4,
    idempotencyKey: 'manual-retry-key',
    requestedBy: 'operator-1',
  })
  assert.equal(result.permissions[0]?.permission, 'test-execution:retry')
  assert.equal(result.permissions[0]?.projectVersionId, 'pv-1')
})

test('取消命令要求 Run If-Match，缺失时返回 428 语义错误', async () => {
  const service = {
    async getRun() { return run },
    async cancelRun() { throw new Error('SHOULD_NOT_RUN') },
  }
  await assert.rejects(
    routeCall({
      method: 'POST',
      path: '/api/project-versions/pv-1/test-execution-runs/run-1/cancel',
      body: {},
      service,
    }),
    (error: unknown) => error instanceof Error
      && 'status' in error
      && error.status === 428
      && 'code' in error
      && error.code === 'TEST_EXECUTION_IF_MATCH_REQUIRED',
  )
})

test('Task 资源先按正式 Run 授权，再对路径项目与父 Run 做 404 范围校验', async () => {
  const service = {
    async taskDetail() {
      return {
        run,
        task,
        attempts: [],
        diagnoses: [],
        scriptRevisions: [],
        artifacts: [],
      }
    },
  }
  let authorizedProjectVersionId = ''
  await assert.rejects(
    routeCall({
      method: 'GET',
      path: '/api/project-versions/pv-other/test-execution-runs/run-1/tasks/task-1',
      service,
      onAuthorize(projectVersionId) {
        authorizedProjectVersionId = projectVersionId
      },
    }),
    (error: unknown) => error instanceof Error
      && 'status' in error
      && error.status === 404,
  )
  assert.equal(authorizedProjectVersionId, 'pv-1')
})

test('Task detail ETag 只使用同一原子快照中的 Run/Task 版本', async () => {
  const result = await routeCall({
    method: 'GET',
    path: '/api/project-versions/pv-1/test-execution-runs/run-1/tasks/task-1',
    service: {
      async taskDetail() {
        return {
          run: { ...run, stateVersion: 11 },
          task: { ...task, stateVersion: 13 },
          attempts: [],
          diagnoses: [],
          scriptRevisions: [],
          artifacts: [],
        }
      },
    },
  })
  assert.equal(
    result.headers.get('etag'),
    '"test-execution-task-v13-run-v11"',
  )
})

test('Task collection 不发送不能标识任务表示的 Run ETag', async () => {
  const result = await routeCall({
    method: 'GET',
    path: '/api/project-versions/pv-1/test-execution-runs/run-1/tasks',
    service: {
      async getRun() { return run },
      async listTasks() { return [task] },
    },
  })
  assert.equal(result.headers.has('etag'), false)
})

test('Script revision diff ETag 只绑定不可变 diff 表示', async () => {
  const diff = {
    fromRevision: {
      id: 'revision-1',
      contentSha256: 'a'.repeat(64),
    },
    toRevision: {
      id: 'revision-2',
      contentSha256: 'b'.repeat(64),
    },
    changes: [{ line: 4, from: 'old', to: 'new' }],
  }
  const path =
    '/api/project-versions/pv-1/test-execution-runs/run-1'
    + '/tasks/task-1/script-revisions/diff'
    + '?from=revision-1&to=revision-2'
  const call = (stateVersion: number) => routeCall({
    method: 'GET',
    path,
    service: {
      async getTask() { return { ...task, stateVersion } },
      async getRun() { return { ...run, stateVersion } },
      async scriptRevisionDiff(
        taskId: string,
        fromRevisionId: string,
        toRevisionId: string,
      ) {
        assert.deepEqual(
          [taskId, fromRevisionId, toRevisionId],
          ['task-1', 'revision-1', 'revision-2'],
        )
        return diff
      },
    },
  })
  const beforeTaskProgress = await call(7)
  const afterTaskProgress = await call(19)
  const expectedEtag = `"sha256-${canonicalSha256(diff)}"`
  assert.equal(beforeTaskProgress.headers.get('etag'), expectedEtag)
  assert.equal(afterTaskProgress.headers.get('etag'), expectedEtag)
  assert.deepEqual(beforeTaskProgress.body, diff)
})

test('Artifact 下载复验实际 hash/size、流式返回并隐藏 storagePath', async () => {
  const content = Buffer.from('immutable runner log\n', 'utf8')
  const sha256 = createHash('sha256').update(content).digest('hex')
  const metadata = {
    id: 'artifact-1',
    runId: 'run-1',
    taskId: 'task-1',
    attemptId: 'attempt-1',
    type: 'log',
    sha256,
    size: content.length,
    mimeType: 'text/plain',
    createdAt: '2026-08-13T12:00:00.000Z',
  }
  const storagePath = `objects/${sha256.slice(0, 2)}/${sha256}`
  const service = {
    async artifact(artifactId: string) {
      assert.equal(artifactId, metadata.id)
      return { metadata, storagePath }
    },
    async getRun() { return run },
  }
  const artifactStore = {
    async stat(path: string) {
      assert.equal(path, storagePath)
      return { storagePath: path, sha256, size: content.length }
    },
    async open(path: string) {
      assert.equal(path, storagePath)
      return Readable.from([content.subarray(0, 7), content.subarray(7)])
    },
  }
  const result = await routeCall({
    method: 'GET',
    path: '/api/test-execution-artifacts/artifact-1?disposition=inline',
    service,
    artifactStore,
    streaming: true,
  })
  assert.equal(result.status, 200)
  assert.deepEqual(result.rawBody, content)
  assert.equal(result.headers.get('content-length'), String(content.length))
  assert.equal(result.headers.get('cache-control'), 'private, no-store')
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(result.headers.get('etag'), `"sha256-${sha256}"`)
  assert.match(
    result.headers.get('content-disposition') ?? '',
    /^inline; filename="log-artifact-1\.log"$/u,
  )
  assert.equal(result.rawBody.includes(Buffer.from(storagePath)), false)
  assert.equal(result.permissions[0]?.permission, 'test-execution:download')
  assert.equal(result.permissions[0]?.projectVersionId, 'pv-1')
})

test('Artifact 数据漂移在打开响应流之前被拒绝', async () => {
  const service = {
    async artifact() {
      return {
        metadata: {
          id: 'artifact-1',
          runId: 'run-1',
          type: 'log',
          sha256: 'a'.repeat(64),
          size: 10,
          mimeType: 'text/plain',
          createdAt: '2026-08-13T12:00:00.000Z',
        },
        storagePath: `objects/aa/${'a'.repeat(64)}`,
      }
    },
    async getRun() { return run },
  }
  let opened = false
  const artifactStore = {
    async stat(storagePath: string) {
      return { storagePath, sha256: 'b'.repeat(64), size: 10 }
    },
    async open() {
      opened = true
      return Readable.from([])
    },
  }
  await assert.rejects(
    routeCall({
      method: 'GET',
      path: '/api/test-execution-artifacts/artifact-1',
      service,
      artifactStore,
      streaming: true,
    }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'TEST_EXECUTION_ARTIFACT_DRIFT',
  )
  assert.equal(opened, false)
})

test('Artifact Store 底层错误被翻译且不泄露绝对路径', async () => {
  const leakedPath = 'C:\\private\\execution-artifacts\\object'
  const service = {
    async artifact() {
      return {
        metadata: {
          id: 'artifact-1',
          runId: 'run-1',
          type: 'log',
          sha256: 'a'.repeat(64),
          size: 10,
          mimeType: 'text/plain',
          createdAt: '2026-08-13T12:00:00.000Z',
        },
        storagePath: `objects/aa/${'a'.repeat(64)}`,
      }
    },
    async getRun() { return run },
  }
  await assert.rejects(
    routeCall({
      method: 'GET',
      path: '/api/test-execution-artifacts/artifact-1',
      service,
      artifactStore: {
        async stat() { throw new Error(`ENOENT: ${leakedPath}`) },
      },
      streaming: true,
    }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'TEST_EXECUTION_ARTIFACT_UNAVAILABLE'
      && !error.message.includes(leakedPath),
  )
})

test('主 HTTP 层注册 Test Execution 结构化错误与独立路由', () => {
  const source = readFileSync(
    new URL('../server/http/server.ts', import.meta.url),
    'utf8',
  )
  assert.match(source, /routeTestExecution\(request, response/u)
  assert.match(source, /error instanceof TestExecutionServiceError/u)
  assert.match(source, /error instanceof TestExecutionValidationError/u)
  assert.match(source, /Promise\.allSettled/u)
  assert.match(source, /installAwaitedShutdown/u)
})

async function routeCall(input: {
  method: string
  path: string
  body?: unknown
  headers?: Record<string, string>
  service: object
  artifactStore?: Partial<ExecutionArtifactStore>
  streaming?: boolean
  resolveProjectVersion?: (
    projectVersionId: string,
  ) => Promise<{
    id: string
    projectId: string
    name: string
    status: 'open'
    createdAt: string
    updatedAt: string
  } | null>
  onAuthorize?: (projectVersionId: string) => void
}) {
  const request = Object.assign(
    Readable.from(input.body === undefined
      ? []
      : [Buffer.from(JSON.stringify(input.body), 'utf8')]),
    { headers: input.headers ?? {} },
  )
  const responseHeaders = new Map<string, string>()
  const chunks: Buffer[] = []
  const response = input.streaming
    ? Object.assign(new PassThrough(), {
        statusCode: 0,
        setHeader(name: string, value: string | number) {
          responseHeaders.set(name.toLocaleLowerCase(), String(value))
        },
      })
    : {
        statusCode: 0,
        setHeader(name: string, value: string | number) {
          responseHeaders.set(name.toLocaleLowerCase(), String(value))
        },
        end(value = '') {
          if (value) chunks.push(Buffer.from(String(value), 'utf8'))
        },
      }
  if (input.streaming) {
    response.on('data', chunk => chunks.push(Buffer.from(chunk)))
  }
  const permissions: Array<{
    projectVersionId: string
    permission: string
  }> = []
  const controls = {
    async authorize(
      _principal: typeof principal,
      projectVersionId: string,
      permission: string,
    ) {
      permissions.push({ projectVersionId, permission })
      input.onAuthorize?.(projectVersionId)
    },
    async canAccess() { return true },
  }
  const artifactStore = {
    async readiness() { return { ready: true } },
    async put() { throw new Error('NOT_USED') },
    async open() { throw new Error('NOT_USED') },
    async stat() { throw new Error('NOT_USED') },
    ...input.artifactStore,
  }
  const handled = await routeTestExecution(
    request as never,
    response as never,
    {
      method: input.method,
      url: new URL(`http://127.0.0.1${input.path}`),
      principal,
      controls: controls as never,
      service: input.service as TestExecutionService,
      artifactStore: artifactStore as ExecutionArtifactStore,
      resolveProjectVersion: input.resolveProjectVersion
        ?? (async projectVersionId => ({
          id: projectVersionId,
          projectId: 'project-1',
          name: '测试版本',
          status: 'open',
          createdAt: '2026-08-13T12:00:00.000Z',
          updatedAt: '2026-08-13T12:00:00.000Z',
        })),
      readiness: async () => ({ ready: true }),
      environments: () => [],
      handoffs: async () => [],
    },
  )
  assert.equal(handled, true)
  const rawBody = Buffer.concat(chunks)
  const type = responseHeaders.get('content-type') ?? ''
  return {
    status: response.statusCode,
    headers: responseHeaders,
    rawBody,
    body: type.includes('application/json') && rawBody.length
      ? JSON.parse(rawBody.toString('utf8')) as unknown
      : undefined,
    permissions,
  }
}
