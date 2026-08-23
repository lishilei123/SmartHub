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
import { LocalWorkspaceRunner } from '../server/runner/local-workspace-runner.js'

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

test('TC_API_LOGIN_001', async ({ request }) => {
  const response = await new AuthClient(request).login()
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
        entrySymbol: task.caseId,
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
