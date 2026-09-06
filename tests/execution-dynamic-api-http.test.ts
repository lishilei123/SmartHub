import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import { apiContractEvidenceIssues, resolveApiContractEvidence } from '../server/application/test-execution-api-contract.js'
import { buildExecutionPackage, freezeExecutionTaskInput } from '../server/application/test-execution-validation.js'
import type { InputDeliveryManifest, TestExecutionAgentSnapshot } from '../server/domain/agent-types.js'
import type { TestCaseContent } from '../server/domain/test-design-types.js'
import type { ExecutionRun } from '../server/domain/test-execution-types.js'
import { LocalExecutionArtifactStore } from '../server/infrastructure/execution-artifact-store.js'
import { LocalExecutionWorkspaceStore } from '../server/infrastructure/execution-workspace-store.js'
import type { StateStore } from '../server/infrastructure/store.js'
import { LocalWorkspaceRunner } from '../server/runner/local-workspace-runner.js'
import { RequirementDocumentWorkspace } from '../server/tools/requirement-document-workspace.js'

test('真实 HTTP 创建返回 ID，经契约候选校验及 LocalWorkspaceRunner 完成查询修改删除', async () => {
  await withHttpFixture(async fixture => {
    const source = script(`
  const response = await test.step('POST /api/tasks', async () => request.post('/api/tasks', { data: { title: 'created by this run' } }))
  expect(response.status()).toBe(201)
  const created = await response.json()
  expect(created.id).toBeTruthy()
  const fetched = await test.step('GET /api/tasks/{id}', async () => request.get(\`/api/tasks/\${created.id}\`))
  expect(fetched.status()).toBe(200)
  expect(await fetched.json()).toEqual({ id: created.id, title: 'created by this run' })
  const changed = await test.step('PATCH /api/tasks/{id}', async () => request.patch('/api/tasks/' + created.id, { data: { title: 'updated by this run' } }))
  expect(changed.status()).toBe(200)
  const id = created.id
  const path = '/api/tasks/' + encodeURIComponent(id)
  const readback = await test.step('GET /api/tasks/{id}', async () => request.get(path))
  expect(readback.status()).toBe(200)
  expect(await readback.json()).toEqual({ id, title: 'updated by this run' })
  const deleted = await test.step('DELETE /api/tasks/{id}', async () => request.delete(path))
  // smarthub:assert expected-1
  expect(deleted.status()).toBe(204)
`)
    const { result, log } = await fixture.execute('crud', source, '删除返回 HTTP 204')
    assert.equal(result.status, 'passed', log)
    assert.equal(fixture.createdIds.length, 1)
    const id = fixture.createdIds[0]
    assert.match(id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[\da-f]{4}-[\da-f]{12}$/u)
    assert.deepEqual(fixture.requests, [
      `POST /api/tasks`, `GET /api/tasks/${id}`, `PATCH /api/tasks/${id}`,
      `GET /api/tasks/${id}`, `DELETE /api/tasks/${id}`,
    ])
    assert.deepEqual(fixture.updates, [{ id, title: 'updated by this run' }])
    assert.equal(fixture.resources.size, 0, '该 Run 创建的资源应已实际删除')
  })
})

test('真实 Runner 拒绝返回 ID 中的路径结构改变，原始及编码参数被 catch 也不能 PASS', async () => {
  const unsafeIds = [
    'child/resource', 'child\\resource', '../escape', '.', '..',
    'resource?admin=true', 'resource#fragment', '%2fescape', '%2e%2e',
    '%252e%252e', 'id\u0000tail', 'id\ntail',
  ]
  await withHttpFixture(async fixture => {
    for (const encoded of [false, true]) {
      fixture.unsafeIds.push(...unsafeIds)
      const source = script(`
  for (let index = 0; index < ${unsafeIds.length}; index += 1) {
    const response = await test.step('POST /api/tasks', async () => request.post('/api/tasks', { data: { unsafe: true } }))
    expect(response.status()).toBe(201)
    const created = await response.json()
    try {
      await request.get(\`/api/tasks/\${${encoded ? 'encodeURIComponent(created.id)' : 'created.id'}}\`)
    } catch {}
  }
  const list = await request.get('/api/tasks')
  // smarthub:assert expected-1
  expect(list.status()).toBe(200)
`)
      const start = fixture.requests.length
      const { result, log } = await fixture.execute(encoded ? 'unsafe-encoded' : 'unsafe-raw', source, '查询列表返回 HTTP 200')
      assert.equal(result.status, 'failed', log)
      assert.equal(result.error, 'TEST_EXECUTION_API_PATH_PARAMETER_REJECTED', log)
      assert.equal(fixture.unsafeIds.length, 0, '脚本捕获异常后仍应逐一验证服务返回的全部恶意参数')
      assert.deepEqual(fixture.requests.slice(start), [
        ...unsafeIds.map(() => 'POST /api/tasks'), 'GET /api/tasks',
      ], '任何改变结构的动态 ID 请求都不得到达本地服务')
    }
  })
})

test('真实 Runner 保留 encodeURIComponent 对普通空格和中文参数的编码支持', async () => {
  await withHttpFixture(async fixture => {
    const { result, log } = await fixture.execute('encoded-ordinary-id', script(`
  const response = await test.step('POST /api/tasks', async () => request.post('/api/tasks', {
    data: { title: 'ordinary encoded ID', encodedId: true },
  }))
  expect(response.status()).toBe(201)
  const created = await response.json()
  const path = \`/api/tasks/\${encodeURIComponent(created.id)}\`
  const fetched = await test.step('GET /api/tasks/{id}', async () => request.get(path))
  expect(fetched.status()).toBe(200)
  expect(await fetched.json()).toEqual({ id: created.id, title: 'ordinary encoded ID' })
  const deleted = await request.delete(path)
  // smarthub:assert expected-1
  expect(deleted.status()).toBe(204)
`), '删除返回 HTTP 204')
    assert.equal(result.status, 'passed', log)
    assert.equal(fixture.createdIds.length, 1)
    assert.match(fixture.createdIds[0], / 空间$/u)
    const path = `/api/tasks/${encodeURIComponent(fixture.createdIds[0])}`
    assert.deepEqual(fixture.requests, ['POST /api/tasks', `GET ${path}`, `DELETE ${path}`])
    assert.equal(fixture.resources.size, 0)
  })
})

function script(body: string) {
  return `import { test, expect } from '@playwright/test'
test('dynamic API [TC_DYNAMIC_001]', async ({ request }) => {
${body}
})`
}

async function withHttpFixture(action: (fixture: Awaited<ReturnType<typeof httpFixture>>) => Promise<void>) {
  const fixture = await httpFixture()
  try { await action(fixture) } finally { await fixture.dispose() }
}

async function httpFixture() {
  const resources = new Map<string, { id: string; title: string }>()
  const createdIds: string[] = []
  const unsafeIds: string[] = []
  const updates: Array<{ id: string; title: string }> = []
  const requests: string[] = []
  const server = createServer((request, response) => {
    void (async () => {
      requests.push(`${request.method} ${request.url}`)
      response.setHeader('content-type', 'application/json')
      if (request.url === '/api/tasks' && request.method === 'POST') {
        const body = await requestJson(request)
        const id = body.unsafe ? unsafeIds.shift() : randomUUID() + (body.encodedId ? ' 空间' : '')
        if (typeof id !== 'string') throw new Error('Unsafe ID fixture exhausted')
        if (!body.unsafe) { resources.set(id, { id, title: String(body.title) }); createdIds.push(id) }
        response.writeHead(201)
        response.end(JSON.stringify({ id }))
        return
      }
      if (request.url === '/api/tasks' && request.method === 'GET') {
        response.end(JSON.stringify([...resources.values()]))
        return
      }
      const match = /^\/api\/tasks\/([^/?#]+)$/u.exec(request.url ?? '')
      const id = match ? decodeURIComponent(match[1]) : undefined
      const resource = id ? resources.get(id) : undefined
      if (resource && request.method === 'GET') { response.end(JSON.stringify(resource)); return }
      if (resource && request.method === 'PATCH') {
        const body = await requestJson(request)
        resource.title = String(body.title)
        updates.push({ ...resource })
        response.end(JSON.stringify(resource))
        return
      }
      if (resource && request.method === 'DELETE') {
        resources.delete(resource.id)
        response.writeHead(204); response.end(); return
      }
      response.writeHead(404); response.end(JSON.stringify({ error: 'not found' }))
    })().catch(error => { response.writeHead(500); response.end(JSON.stringify({ error: String(error) })) })
  })
  const baseUrl = await listen(server)
  const temporary = await mkdtemp(join(process.cwd(), 'smarthub-dynamic-api-regression-'))
  const artifacts = new LocalExecutionArtifactStore(join(temporary, 'artifacts'))
  const workspaceStore = new LocalExecutionWorkspaceStore(join(temporary, 'workspaces'))
  const runner = new LocalWorkspaceRunner(artifacts, 30_000)
  const environment = {
    environmentId: 'dynamic-api-regression', name: '真实本地动态 API 回归', baseUrl,
    signature: 'dynamic-api-regression-environment',
    targets: [{ protocol: 'http' as const, host: '127.0.0.1', port: Number(new URL(baseUrl).port) }],
  }
  return {
    resources, createdIds, unsafeIds, updates, requests,
    async execute(name: string, source: string, expectedResult: string) {
      const entryFile = 'tests/api/dynamic.spec.ts'
      const candidate = { entryFile, files: [{ path: entryFile, content: source }] }
      const evidence = await readContract(environment)
      assert.deepEqual(apiContractEvidenceIssues(candidate, evidence), [], '候选必须关联真实读取且作用域和 Hash 有效的契约')
      const task = frozenTask(expectedResult)
      const executionPackage = buildExecutionPackage({ candidate, task, environmentSignature: environment.signature })
      await workspaceStore.writeFiles(name, executionPackage.files)
      const workspace = await workspaceStore.snapshot(name)
      const result = await runner.execute({
        package: executionPackage, task, attemptId: name,
        expectedPackageSha256: executionPackage.manifest.packageSha256,
        environment, runner: runner.snapshot(),
        workspace: { root: workspace.root, entryFile, entrySymbol: '[TC_DYNAMIC_001]',
          authStateRoot: await workspaceStore.runtimeAuthRoot(name, 'run-dynamic-api') },
      }, new AbortController().signal)
      let log = ''
      for (const artifact of result.artifacts.filter(item => item.type === 'log')) {
        for await (const chunk of await artifacts.open(artifact.storagePath)) log += Buffer.from(chunk).toString('utf8')
      }
      return { result, log }
    },
    async dispose() { await close(server); await rm(temporary, { recursive: true, force: true }) },
  }
}

async function readContract(environment: ExecutionRun['environment']) {
  const contract = JSON.stringify({ openapi: '3.0.3', paths: {
    '/api/tasks': { post: {}, get: {} }, '/api/tasks/{id}': { get: {}, patch: {}, delete: {} },
  } })
  const snapshot = {
    runId: 'run-dynamic-api', taskId: 'task-dynamic-api', projectId: 'project', projectVersionId: 'version',
    projectName: 'project', projectVersionName: 'version', knowledgeBaseId: 'kb', indexVersionId: 'index', assets: [],
    documentWorkspace: { mode: 'agent_directory', logicalPath: 'frozen', rootLogicalPath: 'frozen', candidateAssetVersionIds: [] },
    workspaceFiles: [{ logicalPath: 'frozen/contracts/openapi.json', content: contract,
      contentSha256: createHash('sha256').update(contract).digest('hex'), displayName: 'openapi.json', evidenceKind: 'contract' }],
    executionSessionKey: 'session-dynamic-api',
  } as unknown as TestExecutionAgentSnapshot
  const manifest: InputDeliveryManifest = { policyVersion: 'test', mode: 'agent_directory', packageSha256: 'input', entries: [], finalMergeCompleted: false, toolReads: [] }
  const run = { id: snapshot.runId, projectId: snapshot.projectId, projectVersionId: snapshot.projectVersionId,
    environment, knowledge: { knowledgeBaseId: 'kb', indexVersionId: 'index' } } as ExecutionRun
  assert.deepEqual(resolveApiContractEvidence(manifest, snapshot, run), [], '未读取契约不能成为候选证据')
  const workspace = new RequirementDocumentWorkspace({ snapshot: async () => ({}) } as StateStore, snapshot)
  try {
    await workspace.execute('workspace.read_file', {
      toolId: 'workspace.read_file', toolCallId: 'read-openapi', arguments: { path: 'contracts/openapi.json', offset: 1, limit: 240 },
      context: { snapshot, allowedToolIds: new Set(['workspace.read_file']) },
    }, new AbortController().signal, read => manifest.toolReads!.push(read))
  } finally { await workspace.dispose() }
  const evidence = resolveApiContractEvidence(manifest, snapshot, run)
  assert.equal(evidence.length, 5)
  return evidence
}

function frozenTask(expectedResult: string) {
  const content: TestCaseContent = {
    schemaVersion: 'test-case/v3', title: '动态资源 API', dimension: 'functional', priority: 'P1',
    requirementRefs: ['requirement-dynamic-api'], preconditions: [], executionMethods: ['api'],
    steps: ['创建资源并使用实际返回 ID 查询、修改和删除'], expectedResults: [expectedResult],
  }
  const contentSha256 = canonicalSha256(content)
  return { ...freezeExecutionTaskInput({
    libraryMember: { caseId: 'TC_DYNAMIC_001', revision: 1, ordinal: 0, contentSha256,
      frozenContent: content, executionReadiness: 'ready' },
    handoffMember: { stage: 'full', ordinal: 0, sourceVersionId: 'dynamic-api-library', caseId: 'TC_DYNAMIC_001',
      revision: 1, method: 'api', reason: '真实动态路径验证', dedupKey: 'TC_DYNAMIC_001:1:api', dimension: 'functional',
      executionSpec: { schemaVersion: 'test-script-input/v1', method: 'api', testCase: content }, contentSha256 },
  }), taskId: 'task-dynamic-api' }
}

async function requestJson(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}
async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}/`
}
async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
