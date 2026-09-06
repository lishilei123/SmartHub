import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { apiContractEvidenceIssues, dynamicApiRequestPathGuards, resolveApiContractEvidence } from '../server/application/test-execution-api-contract.js'
import type { InputDeliveryManifest, TestExecutionAgentSnapshot } from '../server/domain/agent-types.js'
import type { ExecutionRun } from '../server/domain/test-execution-types.js'
import type { StateStore } from '../server/infrastructure/store.js'
import { RequirementDocumentWorkspace } from '../server/tools/requirement-document-workspace.js'
import { registerKnowledgeReadChunkTool } from '../server/tools/knowledge-read-chunk.js'
import { ToolRegistry } from '../server/tools/registry.js'

const digest = (content: string) => createHash('sha256').update(content).digest('hex')
const contract = JSON.stringify({ openapi: '3.0.3', paths: { '/api/tasks': { get: {} }, '/api/tasks/{id}': { patch: {} } } })
function fixture(path = 'documents/public-interface.json', content = contract, kind: 'contract' | 'implementation' | 'observation' = 'contract') {
  const workspace = {
    runId: 'run', taskId: 'task', projectId: 'project', projectVersionId: 'version',
    projectName: 'project', projectVersionName: 'version', knowledgeBaseId: 'kb', indexVersionId: 'index', assets: [],
    documentWorkspace: { mode: 'agent_directory', logicalPath: 'frozen', rootLogicalPath: 'frozen', candidateAssetVersionIds: [] },
    workspaceFiles: [{ logicalPath: `frozen/${path}`, content, contentSha256: digest(content), displayName: path, evidenceKind: kind }],
    executionSessionKey: 'session',
  } as unknown as TestExecutionAgentSnapshot
  const run = { id: 'run', projectId: 'project', projectVersionId: 'version', environment: { baseUrl: 'https://example.test', signature: 'environment' }, knowledge: { knowledgeBaseId: 'kb', indexVersionId: 'index' } } as ExecutionRun
  const manifest: InputDeliveryManifest = { policyVersion: 'test', mode: 'agent_directory', packageSha256: 'input', entries: [], finalMergeCompleted: false, toolReads: [] }
  return { workspace, run, manifest }
}
async function readFixture(value: ReturnType<typeof fixture>, offset = 1, limit = 240) {
  const workspace = new RequirementDocumentWorkspace({ snapshot: async () => ({}) } as StateStore, value.workspace)
  try {
    await workspace.execute('workspace.read_file', { toolId: 'workspace.read_file', toolCallId: 'read-1', arguments: { path: value.workspace.workspaceFiles[0].logicalPath.slice('frozen/'.length), offset, limit }, context: { snapshot: value.workspace, allowedToolIds: new Set(['workspace.read_file']) } }, new AbortController().signal, read => value.manifest.toolReads!.push(read))
  } finally { await workspace.dispose() }
}
function candidate(source = "const response = await request.get('/api/tasks')") {
  return { entryFile: 'tests/api/case.spec.ts', files: [{ path: 'tests/api/case.spec.ts', content: `test('case', async ({ request }) => { ${source} })` }] }
}

test('非白名单目录固定 OpenAPI 经真实 workspace.read_file 后按 endpoint/method 认可', async () => {
  const value = fixture()
  assert.deepEqual(resolveApiContractEvidence(value.manifest, value.workspace, value.run), [])
  await readFixture(value)
  const evidence = resolveApiContractEvidence(value.manifest, value.workspace, value.run)
  assert.equal(evidence.length, 2)
  assert.equal(evidence[0].methodsComplete, true)
  assert.match(evidence[0].sourceRef, /documents\/public-interface/u)
  assert.deepEqual(apiContractEvidenceIssues(candidate(), evidence), [])
  assert.equal(apiContractEvidenceIssues(candidate("await request.post('/api/tasks')"), evidence).length, 1)
  assert.equal(apiContractEvidenceIssues(candidate("await request.get('/api/unrelated')"), evidence).length, 1)
})

test('旧目录无关文档、未读取正文、旧记录、内容或 scope 漂移不构成契约', async () => {
  const unrelated = fixture('execution/helpers/readme.txt', '普通 helper，并未记录接口')
  await readFixture(unrelated)
  assert.deepEqual(resolveApiContractEvidence(unrelated.manifest, unrelated.workspace, unrelated.run), [])
  const value = fixture()
  await readFixture(value)
  for (const mutate of [
    (copy: typeof value) => { delete copy.manifest.toolReads![0].executionEvidence },
    (copy: typeof value) => { copy.manifest.toolReads![0].executionEvidence!.contentSha256 = 'wrong' },
    (copy: typeof value) => { copy.manifest.toolReads![0].executionEvidence!.projectId = 'another' },
    (copy: typeof value) => { copy.manifest.toolReads![0].executionEvidence!.projectVersionId = 'older' },
    (copy: typeof value) => { copy.workspace.workspaceFiles[0].content += 'changed' },
    (copy: typeof value) => { copy.manifest.toolReads![0].endLine = 0 },
  ]) {
    const copy = structuredClone(value); mutate(copy)
    assert.deepEqual(resolveApiContractEvidence(copy.manifest, copy.workspace, copy.run), [])
  }
  assert.match(apiContractEvidenceIssues(candidate(), [])[0], /旧读取记录.*重读/u)
})

test('接口说明与受管 API 实现按内容认可，部分读取不把未读正文当证据', async () => {
  const document = fixture('other/routes.md', '# 固定接口说明\nGET /api/tasks\n\nPOST /api/accounts\n')
  await readFixture(document, 1, 2)
  const evidence = resolveApiContractEvidence(document.manifest, document.workspace, document.run)
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].methodsComplete, false)
  assert.equal(apiContractEvidenceIssues(candidate("await request.post('/api/accounts')"), evidence).length, 1)
  const implementation = fixture('execution/unusual/client.ts', "class Client { constructor(private readonly request: APIRequestContext) {} list() { return this.request.get('/api/tasks') } }", 'implementation')
  await readFixture(implementation)
  assert.equal(resolveApiContractEvidence(implementation.manifest, implementation.workspace, implementation.run)[0].kind, 'implementation')
})

test('Map.get 不冒充网络请求，动态和可变地址必须补充受控实现而非静默通过', async () => {
  const value = fixture(); await readFixture(value)
  const evidence = resolveApiContractEvidence(value.manifest, value.workspace, value.run)
  assert.deepEqual(apiContractEvidenceIssues(candidate("const map = new Map(); map.get('business'); await request.get('/api/tasks')"), evidence), [])
  assert.deepEqual(apiContractEvidenceIssues(candidate("const url = '/api/tasks'; await request.get(url)"), evidence), [])
  assert.match(apiContractEvidenceIssues(candidate("let url = '/api/tasks'; url = input; await request.get(url)"), evidence).join(' '), /动态 Endpoint/u)
  assert.match(apiContractEvidenceIssues(candidate('await request.get(input)'), evidence).join(' '), /动态 Endpoint/u)
  assert.match(apiContractEvidenceIssues(candidate("const url = '/api/tasks'; async function other(url) { await request.get(url) }; await other('/invented'); await request.get('/api/tasks')"), evidence).join(' '), /动态 Endpoint/u)
  assert.match(apiContractEvidenceIssues(candidate("await request.fetch('/api/tasks', { method: 'TRACE' }); await request.get('/api/tasks')"), evidence).join(' '), /动态 Endpoint/u)
  assert.deepEqual(apiContractEvidenceIssues(candidate("await request.fetch('/api/tasks', { method: 'GET' })"), evidence), [])
  assert.match(apiContractEvidenceIssues(candidate("await request.fetch('/api/tasks', options)"), evidence).join(' '), /动态 Endpoint/u)
})

test('额外合法请求不能掩盖 alias、计算方法、未知 receiver 或脱离 receiver 的请求', async () => {
  const value = fixture(); await readFixture(value)
  const evidence = resolveApiContractEvidence(value.manifest, value.workspace, value.run)
  assert.deepEqual(apiContractEvidenceIssues(candidate("const alias = request; const second = alias; await second.get('/api/tasks')"), evidence), [])
  assert.deepEqual(apiContractEvidenceIssues(candidate("const map = new Map(); const alias = map; alias.get('business'); const values = new Set(); values.delete('business'); await request.get('/api/tasks')"), evidence), [])
  for (const source of [
    "const alias = request; await alias.get('/invented')",
    "await request[method]('/invented')",
    "const alias = request; await alias['get']('/invented')",
    "await unknownClient.get('/invented')",
    "const get = request.get; await get('/invented')",
    "const { get } = request; await get('/invented')",
    "async function helper(client: APIRequestContext) { await client.get('/invented') }; await helper(request)",
  ]) {
    assert.notDeepEqual(apiContractEvidenceIssues(candidate(`${source}; await request.get('/api/tasks')`), evidence), [], source)
  }
})

test('固定 Knowledge Chunk 由真实读取工具记录，校验固定索引、项目和内容 Hash', async () => {
  const value = fixture()
  const registry = new ToolRegistry()
  const state = { indexes: [{ id: 'index', knowledgeBaseId: 'kb', assetVersionIds: ['asset-version'], indexedChunks: [{ id: 'chunk', assetVersionId: 'asset-version', content: contract, contentHash: digest(contract), assetMetadata: { logicalPath: 'reference/interface.json' } }] }], knowledgeBases: [{ id: 'kb', projectId: 'project' }] }
  registerKnowledgeReadChunkTool(registry, { snapshot: async () => state } as StateStore, read => { value.manifest.knowledgeReads = [read] })
  const request = { toolId: 'knowledge.read_chunk', toolCallId: 'knowledge-1', arguments: { chunkId: 'chunk' }, context: { snapshot: value.workspace, allowedToolIds: new Set(['knowledge.read_chunk']) } }
  await registry.get('knowledge.read_chunk')!.handler(request, new AbortController().signal)
  assert.equal(resolveApiContractEvidence(value.manifest, value.workspace, value.run).length, 2)
  for (const field of ['indexVersionId', 'contentHash', 'assetVersionId', 'chunkId'] as const) {
    const changed = structuredClone(value.manifest); changed.knowledgeReads![0][field] = 'wrong'
    assert.deepEqual(resolveApiContractEvidence(changed, value.workspace, value.run), [])
  }
  state.knowledgeBases[0].projectId = 'another-project'
  await assert.rejects(registry.get('knowledge.read_chunk')!.handler(request, new AbortController().signal), /不属于执行项目/u)
})

test('真实探索证据只保留运行观察等级，环境不符或过期不能作为生成依据', async () => {
  const content = JSON.stringify({ schemaVersion: 'project-version-exploration-context/v1', authority: 'runtime_observed_knowledge', requirementTruth: false, projectVersionId: 'version', environmentSignature: 'environment', results: [{ id: 'observation', projectVersionId: 'version', environmentSignature: 'environment', validationStatus: 'validated', reuseRecommendation: 'prefer_reuse', sourceRunId: 'source-run', sourceTaskId: 'source-task', origin: 'https://example.test', path: '/api/tasks', method: 'GET' }] })
  const value = fixture('observations.json', content, 'observation'); await readFixture(value)
  const evidence = resolveApiContractEvidence(value.manifest, value.workspace, value.run)
  assert.equal(evidence[0].kind, 'observation')
  assert.equal(evidence[0].methodsComplete, false)
  for (const replacement of [content.replace('prefer_reuse', 'reuse_with_validation'), content.replaceAll('environment', 'other-environment')]) {
    const other = fixture('observations.json', replacement, 'observation'); await readFixture(other)
    assert.deepEqual(resolveApiContractEvidence(other.manifest, other.workspace, other.run), [])
  }
})

test('动态路径按已读契约完整参数段匹配模板、拼接、const 和编码包装', async () => {
  const value = fixture('contract.json', JSON.stringify({ openapi: '3.0.3', paths: {
    '/api/tasks': { post: {} }, '/api/tasks/{id}': { get: {}, patch: {}, delete: {} },
    '/api/teams/{team}/tasks/{task}': { get: {} },
  } }))
  await readFixture(value)
  const evidence = resolveApiContractEvidence(value.manifest, value.workspace, value.run)
  for (const source of [
    'await request.get(`/api/tasks/${created.id}`)',
    "await request.get('/api/tasks/' + created.id)",
    "const prefix = '/api/tasks/'; const id = created.id; const path = prefix + id; const alias = path; await request.get(alias)",
    'await request.get(`/api/tasks/${encodeURIComponent(created.id)}`)',
    "const id = encodeURIComponent(created.id); await request.get('/api/tasks/' + id)",
    'await request.get(`/api/teams/${team.id}/tasks/${created.id}`)',
    "const method = 'GET'; await request.fetch(`/api/tasks/${created.id}`, { method })",
    "await request.fetch(`/api/tasks/${created.id}`, { 'method': 'PATCH' })",
    'const context = await factory.newContext({ baseURL: "https://example.test" }); await context.get(`/api/tasks/${created.id}`); await context.dispose()',
    'const response = await request.post("/api/tasks"); const created = await response.json(); const path = `/api/tasks/${created.id}`; await request.get(path); await request.patch(path, { data: { title: "updated" } }); await request.delete(path)',
  ]) {
    const input = candidate(source)
    assert.deepEqual(apiContractEvidenceIssues(input, evidence), [], source)
    assert.ok(dynamicApiRequestPathGuards(input.files[0].content).length > 0, source)
  }
})

test('动态参数不能匹配固定路径或错误方法，仍需有效真实读取与作用域证据', async () => {
  const value = fixture('contract.json', JSON.stringify({ openapi: '3.0.3', paths: {
    '/api/tasks/{id}': { get: {} }, '/api/tasks/current': { delete: {} },
  } }))
  const dynamic = candidate('await request.get(`/api/tasks/${created.id}`)')
  assert.notDeepEqual(apiContractEvidenceIssues(dynamic, resolveApiContractEvidence(value.manifest, value.workspace, value.run)), [])
  await readFixture(value)
  const evidence = resolveApiContractEvidence(value.manifest, value.workspace, value.run)
  for (const source of [
    'await request.post(`/api/tasks/${created.id}`)',
    'await request.get(`/api/accounts/${created.id}`)',
    'await request.delete(`/api/tasks/${created.id}`)',
    'await request.get(`/api/tasks/${created.id}/extra`)',
  ]) assert.match(apiContractEvidenceIssues(candidate(source), evidence).join(' '), /缺少/u, source)
  for (const mutate of [
    (copy: typeof value) => { copy.manifest.toolReads![0].executionEvidence!.runId = 'other' },
    (copy: typeof value) => { copy.manifest.toolReads![0].executionEvidence!.projectVersionId = 'other' },
    (copy: typeof value) => { copy.workspace.workspaceFiles[0].content += ' ' },
    (copy: typeof value) => { delete copy.manifest.toolReads![0].executionEvidence },
  ]) {
    const copy = structuredClone(value); mutate(copy)
    assert.match(apiContractEvidenceIssues(dynamic, resolveApiContractEvidence(copy.manifest, copy.workspace, copy.run)).join(' '), /缺少/u)
  }
  const implementation = fixture('client.ts', candidate('await request.get(`/api/tasks/${created.id}`)').files[0].content, 'implementation')
  await readFixture(implementation)
  assert.deepEqual(resolveApiContractEvidence(implementation.manifest, implementation.workspace, implementation.run), [], '受管实现中的参数槽本身不能扩大为新契约')
})

test('动态 Host、完整路径、复杂分派和路径段结构改变均返回受支持写法', async () => {
  const value = fixture(); await readFixture(value)
  const evidence = resolveApiContractEvidence(value.manifest, value.workspace, value.run)
  for (const source of [
    'await request.get(`https://${host}/api/tasks`)',
    'await request.get(`${host}/api/tasks`)',
    'await request.get(`//${host}/api/tasks`)',
    'await request.get(`${path}`)',
    'await request.get(`/${path}`)',
    'await request.get(`/api/tasks/prefix-${created.id}`)',
    'await request.get(`/api/tasks/${created.id}.json`)',
    'await request.get(`/api/tasks/${created.id}?search=${query}`)',
    'await request.get(`/api/tasks/${resolveId()}`)',
    'await request.get(new URL("/api/tasks", host))',
    'await request.fetch(`/api/tasks/${created.id}`, { method: method })',
    'await request.fetch(`/api/tasks/${created.id}`, { "method": method })',
    'await request.fetch(`/api/tasks/${created.id}`, { method: "GET", method: method })',
    'await request.trace(`/api/tasks/${created.id}`)',
    'await request[method](`/api/tasks/${created.id}`)',
    'await request?.get(`/api/tasks/${created.id}`)',
    'await request.get?.(`/api/tasks/${created.id}`)',
    'await request?.[method](`/api/tasks/${created.id}`)',
    'await request?.get(`https://${host}/api/tasks`)',
    'const get = request.get.bind(request); await get(`/api/tasks/${created.id}`)',
    'Reflect.apply(request.get, request, [`/api/tasks/${created.id}`])',
    'request.get = request.delete.bind(request); await request.get(`/api/tasks/${created.id}`)',
    'const context = await factory.newContext({ baseURL: host }); await context.get(`/api/tasks/${created.id}`)',
    'const context = await factory.newContext(options); await context.get(`/api/tasks/${created.id}`)',
    'const context = await factory.newContext({ baseURL: "https://example.test", ...options }); await context.get(`/api/tasks/${created.id}`)',
    'test.use({ baseURL: host }); await request.get(`/api/tasks/${created.id}`)',
    'test.use({ "baseURL": host }); await request.get(`/api/tasks/${created.id}`)',
    "const path = '/api/tasks/'; async function helper(path) { await request.get(path + created.id) }",
  ]) {
    assert.match(apiContractEvidenceIssues(candidate(`${source}; await request.get('/api/tasks')`), evidence).join(' '), /动态 Endpoint\/Method.*支持/u, source)
  }
})

test('TSX 依赖中的动态请求同样关联契约并产生 Runner 参数检查，解析失败不能静默忽略', async () => {
  const value = fixture(); await readFixture(value)
  const evidence = resolveApiContractEvidence(value.manifest, value.workspace, value.run)
  const helper = { path: 'helpers/client.tsx', content: 'const view = () => <div />; export function update(request: APIRequestContext, id: string) { return request.patch(`/api/tasks/${id}`) }' }
  const input = candidate()
  input.files.push(helper)
  assert.deepEqual(apiContractEvidenceIssues(input, evidence), [])
  assert.equal(dynamicApiRequestPathGuards(helper.content).length, 1)
  helper.content = helper.content.replace('/api/tasks/', '/api/accounts/')
  assert.match(apiContractEvidenceIssues(input, evidence).join(' '), /缺少 PATCH \/api\/accounts/u)
  helper.content = 'not valid typescript {'
  assert.match(apiContractEvidenceIssues(input, evidence).join(' '), /动态 Endpoint\/Method/u)
})
