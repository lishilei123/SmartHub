import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
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
import { LocalWorkspaceRunner, parsePlaywrightJsonReport } from '../server/runner/local-workspace-runner.js'

test('LocalWorkspaceRunner 使用当前 Run baseUrl 真实执行 Playwright request fixture API Case', async () => {
  const observed: Array<{ method?: string; url?: string; host?: string }> = []
  const server = createServer((request, response) => {
    observed.push({ method: request.method, url: request.url, host: request.headers.host })
    response.statusCode = 403
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
        schemaVersion: 'test-script-generation/v1',
        taskId: task.taskId,
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
    const result = await runner.execute({
      package: executionPackage,
      task,
      attemptId: 'attempt-local-api',
      expectedPackageSha256: executionPackage.manifest.packageSha256,
      environment,
      runner: runner.snapshot(),
      workspace: {
        root: workspace.root,
        entryFile,
        entrySymbol: `[${task.caseId}]`,
        authStateRoot: await workspaceStore.runtimeAuthRoot('project-version-api', 'run-local-api'),
      },
    }, new AbortController().signal)
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
    assert.deepEqual(observed, [{
      method: 'POST',
      url: '/api/login',
      host: `127.0.0.1:${address.port}`,
    }])
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

test('Playwright JSON Reporter 生成结构化 UI/API/失败事件并脱敏敏感输入与 Query 值', () => {
  const report = parsePlaywrightJsonReport({
    suites: [{
      specs: [{
        title: '失败流程 [case-events]',
        tests: [{
          results: [{
            retry: 1,
            status: 'failed',
            startTime: '2026-08-23T08:00:00.000Z',
            duration: 42,
            steps: [
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
  assert.deepEqual(report.attachments.map(item => item.contentType), ['image/png', 'application/zip'])
  assert.deepEqual(report.events.map(event => event.sequence), [1, 2, 3, 4, 5, 6, 7])
  assert.equal(report.events[0].type, 'retry')
  assert.equal(report.events.some(event => event.type === 'navigate'), true)
  assert.equal(report.events.some(event => event.type === 'fill' && event.title.includes('填写内容已脱敏')), true)
  assert.deepEqual(report.events.find(event => event.type === 'http')?.metadata, {
    source: 'playwright_json_reporter',
    category: 'pw:api',
    method: 'POST',
    path: '/api/orders',
    httpStatus: 201,
    queryFields: ['token', 'view'],
  })
  assert.equal(report.events.some(event => event.type === 'assertion' && event.status === 'failed'), true)
  assert.equal(report.events.some(event => event.type === 'failure' && event.status === 'failed'), true)
  assert.doesNotMatch(JSON.stringify(report.events), /secret-value|super-secret/u)
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
