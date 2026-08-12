import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { approveTree, createRun, loadInputs, patchCase, redesignTestPoints, reviewCase } from '../src/test-design/api.ts'
import { routeTestDesign } from '../server/http/test-design-routes.ts'

test('测试设计创建表单读取当前绑定 Requirement Release 和单 Agent 就绪状态', async () => {
  const originalFetch = globalThis.fetch
  const paths: string[] = []
  globalThis.fetch = async input => { paths.push(new URL(String(input)).pathname); return Response.json({
    projectVersion: { id: 'pv-1', projectId: 'project-1', name: 'v1', status: 'open' },
    requirementRelease: { id: 'release-1', reviewRunId: 'verify-1', contentSha256: 'a'.repeat(64), label: '正式需求' },
    knowledgeAssets: [], fixedIndexes: [], historicalCaseSets: [], historicalCaseAssets: [],
    agentReadiness: { ready: true, agents: [{ agentKey: 'test-design', ready: true }] },
  }) }
  try {
    const result = await loadInputs('pv-1')
    assert.equal(result.requirementRelease?.id, 'release-1')
    assert.equal(result.requirementRelease?.reviewRunId, 'verify-1')
    assert.equal(result.agentReadiness.agents[0].agentKey, 'test-design')
    assert.deepEqual(paths, ['/api/project-versions/pv-1/test-designs/inputs'])
  } finally { globalThis.fetch = originalFetch }
})

test('测试设计聚合输入路由只计算一次完整候选数据', async () => {
  let calls = 0; let body = ''
  const candidates = { projectVersion: { id: 'pv-1' }, requirementRelease: null, knowledgeAssets: [], fixedIndexes: [], historicalCaseSets: [], historicalCaseAssets: [], agentReadiness: { ready: true, agents: [] } }
  const response = { statusCode: 0, setHeader() {}, end(value: string) { body = value } }
  const handled = await routeTestDesign({ headers: {} }, response as never, { method: 'GET', url: new URL('http://127.0.0.1/api/project-versions/pv-1/test-designs/inputs'), principal: { subjectId: 'tester', displayName: '测试人员' }, controls: { authorize: async () => undefined, canAccess: async () => true }, service: { inputCandidates: async () => { calls += 1; return candidates } } as never, store: {} as never, configurations: {} as never })
  assert.equal(handled, true); assert.equal(calls, 1); assert.deepEqual(JSON.parse(body), candidates)
})

test('启动 TestDesign Run 携带服务端要求的幂等键', async () => {
  const originalFetch = globalThis.fetch; let idempotencyKey = ''
  globalThis.fetch = async (_input, init) => { idempotencyKey = new Headers(init?.headers).get('idempotency-key') ?? ''; return Response.json({ id: 'run-1', status: 'queued' }) }
  try { const run = await createRun('pv-1', 'design-1'); assert.equal(run.id, 'run-1'); assert.match(idempotencyKey, /^test-design-design-1-[0-9a-f-]{36}$/u) } finally { globalThis.fetch = originalFetch }
})

test('测试点批准只使用 If-Match，不存在 Scope Gate API', async () => {
  const originalFetch = globalThis.fetch; let requestPath = ''; let ifMatch = ''
  globalThis.fetch = async (input, init) => { requestPath = new URL(String(input)).pathname; ifMatch = new Headers(init?.headers).get('if-match') ?? ''; return Response.json({ id: 'tp-version-1' }) }
  try { await approveTree('pv-1', 'design-1', 'run-1', '"tree:1:hash"'); assert.equal(requestPath, '/api/project-versions/pv-1/test-designs/design-1/runs/run-1/test-point-tree/approve'); assert.equal(ifMatch, '"tree:1:hash"') } finally { globalThis.fetch = originalFetch }
})

test('AI 重新设计测试点使用固定动作接口', async () => {
  const originalFetch = globalThis.fetch; let requestPath = ''
  globalThis.fetch = async input => { requestPath = new URL(String(input)).pathname; return Response.json({ id: 'run-1', stage: 'test_point_design' }) }
  try { await redesignTestPoints('pv-1', 'design-1', 'run-1'); assert.match(requestPath, /actions\/redesign-test-points$/u) } finally { globalThis.fetch = originalFetch }
})

test('测试用例编辑携带 If-Match 并将审核意见写入单条 Review Action', async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ path: string; method: string; etag: string; body: Record<string, unknown> }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({ path: new URL(String(input)).pathname, method: init?.method ?? 'GET', etag: new Headers(init?.headers).get('if-match') ?? '', body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    return Response.json({ id: 'case-1', currentRevision: 2, reviewState: 'draft', revisions: [], reviewActions: [] }, { headers: { etag: '"case:case-1:2:new"' } })
  }
  const content = { schemaVersion: 'test-case/v1', title: '编辑后的用例', objective: '验证编辑', dimension: 'functional', testPointIds: ['tp-1'], priority: 'P1', preconditions: [], dataRequirementIds: [], cleanup: [], dependencies: [], executionMethods: [{ method: 'ui', uiSpec: { entry: '/' }, executionReadiness: 'ready', steps: [{ key: 's1', action: '打开页面', expected: '页面可用' }], verificationChecks: [], automationHint: '' }], sharedVerificationChecks: [], tags: [], domain: '订单' } as const
  try {
    await patchCase('pv-1', 'design-1', 'run-1', 'case-1', '"case:case-1:1:old"', content, '人工修订')
    await reviewCase('pv-1', 'design-1', 'run-1', 'case-1', 'request_revision', 2, '补充异常路径')
    assert.equal(requests[0].method, 'PATCH')
    assert.equal(requests[0].etag, '"case:case-1:1:old"')
    assert.equal(requests[0].body.reason, '人工修订')
    assert.match(requests[0].path, /test-cases\/case-1$/u)
    assert.equal(requests[1].body.decision, 'request_revision')
    assert.equal(requests[1].body.comment, '补充异常路径')
    assert.match(requests[1].path, /test-cases\/case-1\/review-actions$/u)
  } finally { globalThis.fetch = originalFetch }
})

test('测试设计 HTTP 响应允许浏览器跨端口读取', async () => {
  const server = readFileSync(new URL('../server/http/server.ts', import.meta.url), 'utf8'); const headers = new Map<string, string>(); let body = ''
  const response = { statusCode: 0, setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value) }, end(value: string) { body = value } }
  const handled = await routeTestDesign({ headers: {} }, response as never, { method: 'GET', url: new URL('http://127.0.0.1/api/project-versions/pv-1/test-designs'), principal: { subjectId: 'tester', displayName: '测试人员' }, controls: { authorize: async () => undefined, canAccess: async () => true }, service: { listDesigns: async () => [] } as never, store: {} as never, configurations: {} as never })
  assert.equal(handled, true); assert.equal(headers.get('access-control-allow-origin'), '*'); assert.match(headers.get('access-control-allow-headers') ?? '', /idempotency-key/u); assert.match(headers.get('access-control-expose-headers') ?? '', /etag/u); assert.match(server, /access-control-allow-headers': 'content-type, authorization, idempotency-key, if-match'/u); assert.equal(body, '{"items":[]}')
})
