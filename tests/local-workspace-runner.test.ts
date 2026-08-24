import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import {
  buildExecutionPackage,
  freezeExecutionTaskInput,
} from '../server/application/test-execution-validation.js'
import type {
  ExecutionEnvironmentSnapshot,
} from '../server/domain/test-execution-types.js'
import type {
  TestCaseContent,
  TestCaseLibraryVersionMemberDetail,
  TestExecutionHandoffMember,
} from '../server/domain/test-design-types.js'
import { LocalExecutionArtifactStore } from '../server/infrastructure/execution-artifact-store.js'
import { LocalExecutionWorkspaceStore } from '../server/infrastructure/execution-workspace-store.js'
import {
  applyPlaywrightTraceHttpObservations,
  LocalWorkspaceRunner,
  parsePlaywrightJsonReport,
} from '../server/runner/local-workspace-runner.js'

test('LocalWorkspaceRunner 使用当前 Run baseUrl 真实执行 Playwright request fixture API Case', async () => {
  const observed: Array<{ method?: string; url?: string; host?: string }> = []
  let responseStatus = 403
  const server = createServer((request, response) => {
    observed.push({ method: request.method, url: request.url, host: request.headers.host })
    response.statusCode = responseStatus
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ code: 'UNAUTHORIZED' }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}/`
  const workspaceParent = await mkdtemp(join(process.cwd(), 'smarthub-local-runner-'))
  const artifactRoot = await mkdtemp(join(process.cwd(), 'smarthub-local-artifacts-'))
  try {
    const task = apiTask()
    const entryFile = 'tests/api/login.spec.ts'
    const clientFile = 'api/auth-client.ts'
    const clientSource = `import type { APIRequestContext } from '@playwright/test'

export class AuthClient {
  constructor(private readonly request: APIRequestContext) {}
  login() { return this.request.post('/api/login') }
}
`
    const entrySource = `import { test, expect } from '@playwright/test'
import { AuthClient } from '../../api/auth-client.js'

test('未授权登录 [TC_API_LOGIN_001]', async ({ request }) => {
  const response = await test.step('POST /api/login', async () => new AuthClient(request).login())
  // smarthub:assert expected-1
  expect(response.status()).toBe(403)
})
`
    const executionPackage = buildExecutionPackage({
      candidate: {
        entryFile,
        files: [
          { path: clientFile, content: clientSource },
          { path: entryFile, content: entrySource },
        ],
        summary: '本地 Playwright API 执行冒烟',
      },
      task,
      environmentSignature: 'local-api-environment',
    })
    const workspaceStore = new LocalExecutionWorkspaceStore(workspaceParent)
    await workspaceStore.writeFiles('project-version-api', executionPackage.files)
    const workspace = await workspaceStore.snapshot('project-version-api')
    const artifactStore = new LocalExecutionArtifactStore(artifactRoot)
    const runner = new LocalWorkspaceRunner(artifactStore, 30_000)
    const environment: ExecutionEnvironmentSnapshot = {
      environmentId: 'local-api',
      name: '本地 API 冒烟',
      baseUrl,
      targets: [{ protocol: 'http', host: '127.0.0.1', port: address.port }],
      signature: 'local-api-environment',
    }
    const runnerInput = {
      package: executionPackage,
      task,
      attemptId: 'attempt-local-api',
      expectedPackageSha256: executionPackage.manifest.packageSha256,
      environment,
      // PostgreSQL jsonb may return object keys in a different order. The
      // immutable Runner snapshot must be compared by canonical content.
      runner: {
        imageDigest: runner.snapshot().imageDigest,
        imageReference: runner.snapshot().imageReference,
        playwrightVersion: runner.snapshot().playwrightVersion,
        runnerVersion: runner.snapshot().runnerVersion,
      },
      workspace: {
        root: workspace.root,
        entryFile,
        entrySymbol: `[${task.caseId}]`,
        authStateRoot: await workspaceStore.runtimeAuthRoot('project-version-api', 'run-local-api'),
      },
    }
    // A later shared-Workspace publication must not rewrite this Attempt's
    // immutable ScriptRevision package before launch.
    await writeFile(
      join(workspace.root, ...entryFile.split('/')),
      `import { test } from '@playwright/test'\ntest('漂移入口 [OTHER_CASE]', async () => {})\n`,
      { encoding: 'utf8' },
    )
    const result = await runner.execute(runnerInput, new AbortController().signal)
    let runnerLog = ''
    const log = result.artifacts[0]
    if (log) {
      for await (const chunk of await artifactStore.open(log.storagePath)) {
        runnerLog += Buffer.from(chunk).toString('utf8')
      }
    }
    assert.equal(result.status, 'passed', runnerLog)
    assert.equal(result.events?.some(event => event.type === 'http' && event.metadata?.method === 'POST' && event.metadata.path === '/api/login'), true, JSON.stringify(result.events))
    assert.equal(result.events?.some(event => event.type === 'runner' && event.status === 'passed'), true)
    responseStatus = 401
    const failed = await runner.execute(
      { ...runnerInput, attemptId: 'attempt-local-api-failed' },
      new AbortController().signal,
    )
    assert.equal(failed.status, 'failed')
    assert.equal(failed.events?.some(event =>
      event.type === 'http'
      && event.title === 'POST /api/login · 401'
      && event.metadata?.httpStatus === 401), true, JSON.stringify(failed.events))
    assert.equal(failed.events?.filter(event => event.type === 'failure').length, 1)
    assert.equal(failed.events?.some(event => event.type === 'runner' && event.status === 'failed'), false)
    assert.equal(failed.events?.filter(event => event.type === 'trace').length, 1)
    assert.equal(failed.events?.filter(event => event.artifactSha256s?.length).length, 1)
    assert.deepEqual(observed, [403, 401].map(() => ({
      method: 'POST',
      url: '/api/login',
      host: `127.0.0.1:${address.port}`,
    })))
    assert.deepEqual((await workspaceStore.snapshot('project-version-api')).files.map(file => file.path), [
      'api/auth-client.ts',
      entryFile,
    ])
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(workspaceParent, { recursive: true, force: true })
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test('LocalWorkspaceRunner readiness 对缺失 Playwright 安装返回真实不可用状态', async () => {
  const artifactRoot = await mkdtemp(join(process.cwd(), 'smarthub-local-artifacts-'))
  try {
    const runner = new LocalWorkspaceRunner(
      new LocalExecutionArtifactStore(artifactRoot),
      30_000,
      undefined,
      {
        version: '1.50.0',
        packagePath: join(artifactRoot, 'missing-package.json'),
        cliPath: join(artifactRoot, 'missing-cli.js'),
      },
    )
    const readiness = await runner.readiness()
    assert.equal(readiness.ready, false)
    assert.match(readiness.reason ?? '', /ENOENT/u)
    assert.equal(readiness.snapshot.playwrightVersion, '1.50.0')
  } finally {
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test('LocalWorkspaceRunner 将 Service 校验过的 Run storageState 注入 API request fixture', async () => {
  const observedCookies: string[] = []
  const server = createServer((request, response) => {
    observedCookies.push(String(request.headers.cookie ?? ''))
    const authenticated = request.headers.cookie?.includes('session=valid') ?? false
    response.statusCode = authenticated ? 200 : 401
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ authenticated }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}/`
  const workspaceParent = await mkdtemp(join(process.cwd(), 'smarthub-auth-runner-'))
  const artifactRoot = await mkdtemp(join(process.cwd(), 'smarthub-auth-artifacts-'))
  try {
    const task = authenticatedApiTask()
    const entryFile = 'tests/api/authenticated-tasks.spec.ts'
    const entrySource = `import { test, expect } from '@playwright/test'
test('读取受保护任务 [TC_API_TASKS_001]', async ({ request }) => {
  const response = await request.get('/api/tasks')
  // smarthub:assert expected-1
  expect(response.status()).toBe(200)
})
`
    const executionPackage = buildExecutionPackage({
      candidate: { entryFile, files: [{ path: entryFile, content: entrySource }], summary: '认证 API 冒烟' },
      task,
      environmentSignature: 'local-auth-environment',
    })
    const workspaceStore = new LocalExecutionWorkspaceStore(workspaceParent)
    await workspaceStore.writeFiles('project-version-auth', executionPackage.files)
    const workspace = await workspaceStore.snapshot('project-version-auth')
    const authStateRoot = await workspaceStore.runtimeAuthRoot('project-version-auth', 'run-local-auth')
    const authStatePath = join(authStateRoot, 'default.json')
    await writeFile(authStatePath, JSON.stringify({
      cookies: [{
        name: 'session', value: 'valid', domain: '127.0.0.1', path: '/', expires: -1,
        httpOnly: true, secure: false, sameSite: 'Lax',
      }],
      origins: [],
    }), { encoding: 'utf8' })
    const artifactStore = new LocalExecutionArtifactStore(artifactRoot)
    const runner = new LocalWorkspaceRunner(artifactStore, 30_000)
    const environment: ExecutionEnvironmentSnapshot = {
      environmentId: 'local-auth', name: '本地认证 API', baseUrl,
      targets: [{ protocol: 'http', host: '127.0.0.1', port: address.port }],
      signature: 'local-auth-environment',
    }
    const result = await runner.execute({
      package: executionPackage,
      task,
      attemptId: 'attempt-local-auth',
      expectedPackageSha256: executionPackage.manifest.packageSha256,
      environment,
      runner: runner.snapshot(),
      workspace: {
        root: workspace.root,
        entryFile,
        entrySymbol: `[${task.caseId}]`,
        authStateRoot,
        authStatePath,
      },
    }, new AbortController().signal)
    assert.equal(result.status, 'passed')
    assert.deepEqual(observedCookies, ['session=valid'])
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(workspaceParent, { recursive: true, force: true })
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test('LocalWorkspaceRunner 将同源 localStorage Bearer 临时桥接到 API request fixture', async () => {
  const observedAuthorization: string[] = []
  const server = createServer((request, response) => {
    observedAuthorization.push(String(request.headers.authorization ?? ''))
    const authenticated = request.headers.authorization === 'Bearer runtime-only-token'
    response.statusCode = authenticated ? 200 : 401
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ authenticated }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}/`
  const workspaceParent = await mkdtemp(join(process.cwd(), 'smarthub-bearer-runner-'))
  const artifactRoot = await mkdtemp(join(process.cwd(), 'smarthub-bearer-artifacts-'))
  try {
    const task = authenticatedApiTask()
    const entryFile = 'tests/api/authenticated-bearer.spec.ts'
    const entrySource = `import { test, expect } from '@playwright/test'
test('读取 Bearer 保护资源 [TC_API_TASKS_001]', async ({ request }) => {
  const response = await request.get('/api/tasks')
  // smarthub:assert expected-1
  expect(response.status()).toBe(200)
})
`
    const executionPackage = buildExecutionPackage({
      candidate: { entryFile, files: [{ path: entryFile, content: entrySource }] },
      task,
      environmentSignature: 'local-bearer-environment',
    })
    const workspaceStore = new LocalExecutionWorkspaceStore(workspaceParent)
    await workspaceStore.writeFiles('project-version-bearer', executionPackage.files)
    const workspace = await workspaceStore.snapshot('project-version-bearer')
    const authStateRoot = await workspaceStore.runtimeAuthRoot('project-version-bearer', 'run-local-bearer')
    const authStatePath = join(authStateRoot, 'default.json')
    await writeFile(authStatePath, JSON.stringify({
      cookies: [],
      origins: [{
        origin: new URL(baseUrl).origin,
        localStorage: [{ name: 'minitask_token', value: 'runtime-only-token' }],
      }],
    }), { encoding: 'utf8' })
    const apiAuthorization = await workspaceStore.runtimeApiAuthorization(authStatePath, baseUrl)
    assert.deepEqual(apiAuthorization, {
      kind: 'bearer_local_storage',
      origin: new URL(baseUrl).origin,
      localStorageKey: 'minitask_token',
    })
    const artifactStore = new LocalExecutionArtifactStore(artifactRoot)
    const runner = new LocalWorkspaceRunner(artifactStore, 30_000)
    const environment: ExecutionEnvironmentSnapshot = {
      environmentId: 'local-bearer', name: '本地 Bearer API', baseUrl,
      targets: [{ protocol: 'http', host: '127.0.0.1', port: address.port }],
      signature: 'local-bearer-environment',
    }
    const result = await runner.execute({
      package: executionPackage,
      task,
      attemptId: 'attempt-local-bearer',
      expectedPackageSha256: executionPackage.manifest.packageSha256,
      environment,
      runner: runner.snapshot(),
      workspace: {
        root: workspace.root,
        entryFile,
        entrySymbol: `[${task.caseId}]`,
        authStateRoot,
        authStatePath,
        apiAuthorization,
      },
    }, new AbortController().signal)
    assert.equal(result.status, 'passed')

    const failingSource = entrySource.replace('toBe(200)', 'toBe(201)')
    const failingPackage = buildExecutionPackage({
      candidate: { entryFile, files: [{ path: entryFile, content: failingSource }] },
      task,
      environmentSignature: 'local-bearer-environment',
    })
    await workspaceStore.writeFiles('project-version-bearer', failingPackage.files)
    const failed = await runner.execute({
      package: failingPackage,
      task,
      attemptId: 'attempt-local-bearer-failed',
      expectedPackageSha256: failingPackage.manifest.packageSha256,
      environment,
      runner: runner.snapshot(),
      workspace: {
        root: workspace.root,
        entryFile,
        entrySymbol: `[${task.caseId}]`,
        authStateRoot,
        authStatePath,
        apiAuthorization,
      },
    }, new AbortController().signal)
    assert.equal(failed.status, 'failed')
    const trace = failed.artifacts.find(artifact => artifact.type === 'trace')
    assert.ok(trace)
    const traceChunks: Buffer[] = []
    for await (const chunk of await artifactStore.open(trace.storagePath)) traceChunks.push(Buffer.from(chunk))
    const archive = await JSZip.loadAsync(Buffer.concat(traceChunks))
    const traceText = (await Promise.all(Object.values(archive.files)
      .filter(entry => !entry.dir)
      .map(entry => entry.async('nodebuffer'))))
      .map(value => value.toString('utf8'))
      .join('\n')
    assert.doesNotMatch(traceText, /runtime-only-token/u)
    assert.deepEqual(observedAuthorization, [
      'Bearer runtime-only-token',
      'Bearer runtime-only-token',
    ])
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(workspaceParent, { recursive: true, force: true })
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test('Playwright JSON Reporter 生成结构化 UI/API/失败事件并脱敏敏感输入与 Query 值', () => {
  const parsed = parsePlaywrightJsonReport({
    suites: [{
      specs: [{
        title: '失败流程 [case-events]',
        tests: [{
          results: [{
            retry: 1,
            status: 'failed',
            startTime: '2026-08-23T08:00:00.000Z',
            duration: 42,
            errors: [{ message: 'Error: expect(received).toBeTruthy()' }],
            errorLocation: { file: 'tests/api/orders.spec.ts', line: 27, column: 5 },
            steps: [
              { category: 'test.step', title: 'GET /api/tasks', duration: 3 },
              { category: 'pw:api', title: 'page.goto https://example.test/orders?token=secret-value', duration: 5 },
              { category: 'pw:api', title: "locator('#password').fill super-secret", duration: 7 },
              { category: 'pw:api', title: 'POST /api/orders?token=secret-value&view=detail -> 201', duration: 9 },
              { category: 'expect', title: 'expect.toHaveText password=secret-value', duration: 11, error: { message: 'failed' } },
            ],
            attachments: [
              { name: 'screenshot', contentType: 'image/png', path: 'test-results/failure.png' },
              { name: 'trace', contentType: 'application/zip', path: 'test-results/trace.zip' },
            ],
          }],
        }],
      }],
    }],
  }, '[case-events]')
  const report = {
    ...parsed,
    events: applyPlaywrightTraceHttpObservations(parsed.events, [{ method: 'GET', path: '/api/tasks', status: 401 }]),
  }
  assert.deepEqual(report.attachments.map(item => item.contentType), ['image/png', 'application/zip'])
  assert.deepEqual(report.events.map(event => event.sequence), [1, 2, 3, 4, 5, 6, 7])
  assert.equal(report.events[0].type, 'retry')
  assert.deepEqual(report.events.find(event => event.title === 'GET /api/tasks · 401')?.metadata, {
    source: 'playwright_json_reporter',
    category: 'test.step',
    method: 'GET',
    path: '/api/tasks',
    httpStatus: 401,
  })
  assert.equal(report.events.some(event => event.type === 'navigate'), true)
  assert.equal(report.events.some(event => event.type === 'fill' && event.title.includes('填写内容已脱敏')), true)
  assert.deepEqual(report.events.find(event => event.type === 'http' && event.metadata?.method === 'POST')?.metadata, {
    source: 'playwright_json_reporter',
    category: 'pw:api',
    method: 'POST',
    path: '/api/orders',
    httpStatus: 201,
    queryFields: ['token', 'view'],
  })
  assert.equal(report.events.some(event => event.type === 'assertion' && event.status === 'failed'), true)
  assert.equal(report.events.some(event => event.type === 'runner' && event.status === 'failed'), false)
  assert.deepEqual(report.events.find(event => event.type === 'failure'), {
    sequence: 7,
    type: 'failure',
    title: 'Playwright 断言失败',
    status: 'failed',
    startedAt: '2026-08-23T08:00:00.042Z',
    finishedAt: '2026-08-23T08:00:00.042Z',
    durationMs: 0,
    metadata: {
      source: 'playwright_json_reporter',
      retry: 1,
      failureKind: 'assertion',
      location: { file: 'tests/api/orders.spec.ts', line: 27, column: 5 },
    },
  })
  assert.doesNotMatch(JSON.stringify(report.events), /secret-value|super-secret/u)

  const timeout = parsePlaywrightJsonReport({
    suites: [{
      specs: [{
        title: '筛选任务 [case-events]',
        tests: [{ results: [{
          status: 'failed',
          startTime: '2026-08-23T08:00:00.000Z',
          duration: 30_000,
          errors: [{ message: "Error: locator.selectOption: Test timeout exceeded\nCall log:\n  - waiting for getByTestId('priority-filter')" }],
        }] }],
      }],
    }],
  }, '[case-events]')
  assert.deepEqual(timeout.events.find(event => event.type === 'failure')?.metadata?.locator, {
    strategy: 'test_id',
    value: 'priority-filter',
    operation: 'selectOption',
  })
})

function apiTask() {
  const content: TestCaseContent = {
    schemaVersion: 'test-case/v3',
    title: '未授权登录 API',
    dimension: 'functional',
    requirementRefs: ['requirement-login'],
    priority: 'P0',
    preconditions: [],
    executionMethods: ['api'],
    steps: ['调用登录接口'],
    expectedResults: ['返回 HTTP 403'],
  }
  const contentSha256 = canonicalSha256(content)
  const libraryMember: TestCaseLibraryVersionMemberDetail = {
    caseId: 'TC_API_LOGIN_001',
    revision: 1,
    ordinal: 0,
    contentSha256,
    frozenContent: content,
    executionReadiness: 'ready',
  }
  const handoffMember: TestExecutionHandoffMember = {
    stage: 'full',
    ordinal: 0,
    sourceVersionId: 'library-version-api',
    caseId: libraryMember.caseId,
    revision: libraryMember.revision,
    method: 'api',
    reason: '验证 API request fixture',
    dedupKey: 'TC_API_LOGIN_001:1:api',
    dimension: content.dimension,
    executionSpec: {
      schemaVersion: 'test-script-input/v1',
      method: 'api',
      testCase: content,
    },
    contentSha256,
  }
  return {
    ...freezeExecutionTaskInput({ handoffMember, libraryMember }),
    taskId: 'task-api-login',
  }
}

function authenticatedApiTask() {
  const content: TestCaseContent = {
    schemaVersion: 'test-case/v3',
    title: '读取受保护任务',
    dimension: 'functional',
    requirementRefs: ['requirement-task'],
    priority: 'P0',
    preconditions: ['已登录'],
    executionMethods: ['api'],
    steps: ['读取任务列表'],
    expectedResults: ['返回 HTTP 200'],
  }
  const contentSha256 = canonicalSha256(content)
  const libraryMember: TestCaseLibraryVersionMemberDetail = {
    caseId: 'TC_API_TASKS_001', revision: 1, ordinal: 0, contentSha256,
    frozenContent: content, executionReadiness: 'ready',
  }
  const handoffMember: TestExecutionHandoffMember = {
    stage: 'full', ordinal: 0, sourceVersionId: 'library-version-auth',
    caseId: libraryMember.caseId, revision: libraryMember.revision, method: 'api',
    reason: '验证受保护 API request fixture', dedupKey: 'TC_API_TASKS_001:1:api',
    dimension: content.dimension,
    executionSpec: { schemaVersion: 'test-script-input/v1', method: 'api', testCase: content },
    contentSha256,
  }
  return { ...freezeExecutionTaskInput({ handoffMember, libraryMember }), taskId: 'task-api-authenticated' }
}
