import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createRun, loadInputs, patchCase, redesignTestPoints, reviewCase } from '../src/test-design/api.ts'
import { TestDesignError } from '../server/application/test-design-validation.ts'
import { routeTestDesign } from '../server/http/test-design-routes.ts'

test('测试设计创建表单读取当前绑定 Requirement Release 和单 Agent 就绪状态', async () => {
  const originalFetch = globalThis.fetch
  const paths: string[] = []
  globalThis.fetch = async input => { paths.push(new URL(String(input)).pathname); return Response.json({
    projectVersion: { id: 'pv-1', projectId: 'project-1', name: 'v1', status: 'open' },
    requirementRelease: { id: 'release-1', reviewRunId: 'verify-1', contentSha256: 'a'.repeat(64), label: '正式需求' },
    knowledgeAssets: [], fixedIndexes: [], historicalCaseSets: [], historicalCaseAssets: [],
    agentReadiness: { ready: true, agents: [{ agentKey: 'planning', ready: true }] },
  }) }
  try {
    const result = await loadInputs('pv-1')
    assert.equal(result.requirementRelease?.id, 'release-1')
    assert.equal(result.requirementRelease?.reviewRunId, 'verify-1')
    assert.equal(result.agentReadiness.agents[0].agentKey, 'planning')
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

test('测试点由服务端自动校验，不再暴露人工批准 API', () => {
  const client = readFileSync(new URL('../src/test-design/api.ts', import.meta.url), 'utf8')
  const routes = readFileSync(new URL('../server/http/test-design-routes.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(client, /approveTree|test-point-tree\/approve/u)
  assert.doesNotMatch(routes, /test-point-tree\/approve/u)
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

test('正式用例、Proposal、用例库版本、套件和四类 Handoff HTTP 路由覆盖完整写入契约', async () => {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const service = new Proxy({}, { get: (_target, property) => async (...args: unknown[]) => {
    const method = String(property); calls.push({ method, args })
    if (method === 'listLibraryCases' || method === 'listLibraryVersions' || method === 'listCaseChangeProposals') return []
    if (method === 'getLibraryCase' || method === 'editLibraryCase') return { id: 'case-1', etag: '"library-case:case-1:r2:new"' }
    if (method === 'createLibraryCase' || method === 'copyLibraryCase' || method === 'deprecateLibraryCase') return { id: 'case-1' }
    if (method === 'decideCaseChangeProposal') return { id: 'proposal-1', decision: 'accepted' }
    if (method === 'publishLibraryVersion') return { id: 'library-v1' }
    if (method === 'getLibraryVersion') return { id: 'library-v1', members: [{ caseId: 'case-1', revision: 1, ordinal: 0, contentSha256: 'a'.repeat(64), frozenContent: { title: '冻结标题', executionSpec: { method: 'ui' } }, executionReadiness: 'needs_confirmation' }] }
    if (method === 'createSuiteDraft' || method === 'updateSuiteDraft') return { id: 'draft-1', etag: '"suite-draft:draft-1:new"' }
    if (method === 'publishSuiteDraft') return { id: 'suite-v1' }
    if (method === 'createLibraryHandoff') return { id: `handoff-${String((args[2] as { mode: string }).mode)}` }
    throw new Error(`未处理测试服务方法 ${method}`)
  } })

  assert.equal((await routeCall('GET', '/api/projects/project-1/test-case-library', undefined, {}, service)).status, 200)
  assert.equal((await routeCall('GET', '/api/projects/project-1/test-case-library-versions', undefined, {}, service)).status, 200)
  assert.equal((await routeCall('POST', '/api/projects/project-1/test-case-library', { content: { title: '新增' }, changeReason: '新增正式用例' }, {}, service)).status, 201)
  const traceability = { sourceRequirementReleaseId: 'release-1', requirementRefs: [{ requirementReleaseId: 'release-1', requirementId: 'REQ-1' }], testPointRefs: [{ testPointTreeVersionId: 'tree-v1', testPointId: 'point-1' }] }
  const edited = await routeCall('PATCH', '/api/projects/project-1/test-case-library/case-1', { content: { title: '修改' }, changeReason: '修改 Revision', traceability }, { 'if-match': '"library-case:case-1:r1:old"' }, service)
  assert.equal(edited.status, 200); assert.equal(edited.headers.get('etag'), '"library-case:case-1:r2:new"')
  assert.equal((await routeCall('POST', '/api/projects/project-1/test-case-library/case-1/copy', { changeReason: '复制' }, {}, service)).status, 201)
  assert.equal((await routeCall('DELETE', '/api/projects/project-1/test-case-library/case-1', { changeReason: '废弃' }, { 'if-match': '"library-case:case-1:r2:new"' }, service)).status, 200)
  assert.equal((await routeCall('GET', '/api/project-versions/pv-1/test-designs/design-1/runs/run-1/case-change-proposals', undefined, {}, service)).status, 200)
  assert.equal((await routeCall('POST', '/api/project-versions/pv-1/test-designs/design-1/runs/run-1/case-change-proposals/proposal-1/decisions', { expectedVersion: 0, decision: 'accepted' }, {}, service)).status, 201)
  assert.equal((await routeCall('POST', '/api/project-versions/pv-1/test-designs/design-1/runs/run-1/test-case-library-versions', { name: 'V1', expectedAuditId: 'audit-1', expectedCaseSetSha256: 'a', expectedProposalSha256: 'b' }, {}, service)).status, 201)
  assert.equal((await routeCall('POST', '/api/projects/project-1/test-suite-drafts', { suiteKey: 'smoke', suiteType: 'smoke', name: 'Smoke', testCaseLibraryVersionId: 'library-v1', members: [] }, {}, service)).status, 201)
  assert.equal((await routeCall('PUT', '/api/projects/project-1/test-suite-drafts/draft-1', { suiteKey: 'smoke', suiteType: 'smoke', name: 'Smoke 2', testCaseLibraryVersionId: 'library-v1', members: [] }, { 'if-match': '"suite-draft:draft-1:old"' }, service)).status, 200)
  assert.equal((await routeCall('POST', '/api/projects/project-1/test-suite-drafts/draft-1/publish', undefined, { 'if-match': '"suite-draft:draft-1:new"' }, service)).status, 201)
  const versionDetail = await routeCall('GET', '/api/projects/project-1/test-case-library-versions/library-v1', undefined, {}, service)
  assert.equal(((versionDetail.body as { members: Array<{ frozenContent: { title: string } }> }).members[0].frozenContent.title), '冻结标题')
  for (const mode of ['smoke', 'regression', 'full', 'custom']) assert.equal((await routeCall('POST', '/api/project-versions/pv-1/test-case-library-versions/library-v1/execution-handoffs', { mode, expectedLibrarySha256: 'c', ...(mode === 'full' ? { executionReadinessOverrides: [{ caseId: 'case-1', revision: 1, reason: '人工确认执行' }] } : { suiteVersionId: `suite-${mode}` }) }, {}, service)).status, 201)

  assert.equal((calls.find(item => item.method === 'editLibraryCase')!.args[2]), '"library-case:case-1:r1:old"')
  assert.deepEqual(calls.find(item => item.method === 'editLibraryCase')!.args[6], traceability)
  assert.deepEqual(calls.filter(item => item.method === 'createLibraryHandoff').map(item => (item.args[2] as { mode: string }).mode), ['smoke', 'regression', 'full', 'custom'])
  assert.deepEqual((calls.filter(item => item.method === 'createLibraryHandoff')[2].args[2] as { executionReadinessOverrides: unknown }).executionReadinessOverrides, [{ caseId: 'case-1', revision: 1, reason: '人工确认执行' }])
})

test('正式资产 HTTP 路由透传单版本、基线和 executionSpec 服务端拒绝', async () => {
  const mixError = new TestDesignError('TEST_SUITE_LIBRARY_VERSION_MISMATCH', '套件所有成员必须属于同一用例库版本', 422)
  await assert.rejects(routeCall('POST', '/api/projects/project-1/test-suite-drafts', { suiteKey: 'mixed', suiteType: 'smoke', name: '混用', testCaseLibraryVersionId: 'library-v2', members: [{ testCaseLibraryVersionId: 'library-v1', caseId: 'case-1', executionMethod: 'ui', reason: '非法混用' }] }, {}, { createSuiteDraft: async () => { throw mixError } }), (error: unknown) => error === mixError)

  const baselineError = new TestDesignError('TEST_CASE_LIBRARY_BASE_CHANGED', '正式用例库在本任务运行期间已经变化，请重新分析或基于最新版本重新创建任务。', 409)
  await assert.rejects(routeCall('POST', '/api/project-versions/pv-1/test-designs/design-1/runs/run-1/test-case-library-versions', { name: '过期发布' }, {}, { publishLibraryVersion: async () => { throw baselineError } }), (error: unknown) => error === baselineError)

  const schemaError = new TestDesignError('TEST_CASE_EXECUTION_SPEC_INVALID', 'performance 用例必须提供 performance executionSpec', 422)
  await assert.rejects(routeCall('POST', '/api/projects/project-1/test-case-library', { content: { dimension: 'performance', executionSpec: { kind: 'functional' } }, changeReason: '非法配置' }, {}, { createLibraryCase: async () => { throw schemaError } }), (error: unknown) => error === schemaError)

  for (const [code, status] of [['TEST_EXECUTION_CASE_NOT_READY', 422], ['TEST_EXECUTION_CASE_BLOCKED', 422], ['TEST_EXECUTION_READINESS_OVERRIDE_REQUIRED', 422], ['TEST_CASE_LIBRARY_MEMBER_HASH_MISMATCH', 409], ['LIBRARY_TEST_CASE_TRACEABILITY_REQUIRED', 422], ['LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH', 422]] as const) {
    const expected = new TestDesignError(code, '服务端拒绝', status)
    const action = code === 'TEST_CASE_LIBRARY_MEMBER_HASH_MISMATCH'
      ? routeCall('GET', '/api/projects/project-1/test-case-library-versions/library-v1', undefined, {}, { getLibraryVersion: async () => { throw expected } })
      : code.startsWith('LIBRARY_')
        ? routeCall('PATCH', '/api/projects/project-1/test-case-library/case-1', { content: {}, changeReason: '非法追溯' }, { 'if-match': '"etag"' }, { editLibraryCase: async () => { throw expected } })
        : routeCall('POST', '/api/project-versions/pv-1/test-case-library-versions/library-v1/execution-handoffs', { mode: 'full', expectedLibrarySha256: 'a' }, {}, { createLibraryHandoff: async () => { throw expected } })
    await assert.rejects(action, (error: unknown) => error === expected && expected.status === status)
  }
})

test('正式资产 HTTP 路由拒绝未认证和无权限调用', async () => {
  const service = { listLibraryCases: async () => [] }
  await assert.rejects(routeCall('GET', '/api/projects/project-1/test-case-library', undefined, {}, service, { subjectId: '', displayName: '' }, 'unauthenticated'), /UNAUTHENTICATED/u)
  await assert.rejects(routeCall('GET', '/api/projects/project-1/test-case-library', undefined, {}, service, { subjectId: 'reader', displayName: '只读用户' }, 'forbidden'), /FORBIDDEN/u)
  await assert.rejects(routeCall('GET', '/api/projects/another-project/test-case-library-versions/library-v1', undefined, {}, { getLibraryVersion: async () => ({}) }, { subjectId: 'reader', displayName: '只读用户' }, 'forbidden'), /FORBIDDEN/u)
})

async function routeCall(method: string, path: string, body: unknown, headers: Record<string, string>, service: object, principal = { subjectId: 'tester', displayName: '测试人员' }, access: 'allowed' | 'unauthenticated' | 'forbidden' = 'allowed') {
  const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]), { headers })
  const responseHeaders = new Map<string, string>(); let responseBody = ''
  const response = { statusCode: 0, setHeader(name: string, value: string) { responseHeaders.set(name.toLowerCase(), value) }, end(value = '') { responseBody = String(value) } }
  const controls = { canAccess: async () => access === 'allowed', authorize: async () => { if (access === 'unauthenticated') throw new Error('UNAUTHENTICATED'); if (access === 'forbidden') throw new Error('FORBIDDEN') } }
  const store = { snapshot: async () => ({ projectVersions: [{ id: 'pv-1', projectId: 'project-1' }] }) }
  const handled = await routeTestDesign(request as never, response as never, { method, url: new URL(`http://127.0.0.1${path}`), principal, controls: controls as never, service: service as never, store: store as never, configurations: {} as never })
  assert.equal(handled, true)
  return { status: response.statusCode, headers: responseHeaders, body: responseBody ? JSON.parse(responseBody) as unknown : undefined }
}
