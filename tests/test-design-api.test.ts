import assert from 'node:assert/strict'
import test from 'node:test'
import { applyTestDesignGateDecision, createTestDesignRun, loadTestDesignInputs } from '../src/test-design-api.ts'
import { routeTestDesign } from '../server/http/test-design-routes.ts'
import { readFileSync } from 'node:fs'

test('测试设计创建表单通过单个聚合接口读取依据和 Agent 就绪状态', async () => {
  const originalFetch = globalThis.fetch
  const paths: string[] = []
  globalThis.fetch = async input => {
    const url = String(input)
    paths.push(new URL(url).pathname)
    if (url.endsWith('/inputs')) return Response.json({
      projectVersion: { id: 'pv-1', projectId: 'project-1', name: 'v1', status: 'open' },
      reviewBaselines: [{ sourceReviewRunId: 'rr-1', sourceTechnicalSolutionRunId: 'tr-1', label: '基线', selectable: true }],
      knowledgeAssets: [{ assetId: 'asset-1', assetVersionId: 'av-1', version: 2, contentHash: 'a'.repeat(64), displayName: '需求', logicalPath: '需求.md', assetType: 'requirement', status: 'ready', selectable: true }],
      fixedIndexes: [{ id: 'index-1', selectable: true }],
      historicalCaseSets: [],
      historicalCaseAssets: [],
      agentReadiness: { ready: true, agents: [] },
    })
    return Response.json({ error: 'unexpected request' }, { status: 404 })
  }
  try {
    const result = await loadTestDesignInputs('pv-1')
    assert.equal(result.reviewBaselines[0].sourceReviewRunId, 'rr-1')
    assert.equal(result.knowledgeAssets[0].assetVersionId, 'av-1')
    assert.equal(result.agentReadiness.ready, true)
    assert.equal(result.fixedIndexes[0].id, 'index-1')
    assert.deepEqual(paths, ['/api/project-versions/pv-1/test-designs/inputs'])
  } finally { globalThis.fetch = originalFetch }
})

test('测试设计聚合输入路由只计算一次完整候选数据', async () => {
  let calls = 0
  let body = ''
  const candidates = { reviewBaselines: [], knowledgeAssets: [], fixedIndexes: [], historicalCaseSets: [], historicalCaseAssets: [], agentReadiness: { ready: true, agents: [] } }
  const response = { statusCode: 0, setHeader() {}, end(value: string) { body = value } }
  const handled = await routeTestDesign({ headers: {} }, response as never, {
    method: 'GET',
    url: new URL('http://127.0.0.1/api/project-versions/pv-1/test-designs/inputs'),
    principal: { subjectId: 'tester', displayName: '测试人员' },
    controls: { authenticate: async () => ({ subjectId: 'tester', displayName: '测试人员' }), authorize: async () => undefined, canAccess: async () => true },
    service: { inputCandidates: async () => { calls += 1; return candidates } } as never,
    store: {} as never,
    configurations: {} as never,
  })
  assert.equal(handled, true)
  assert.equal(calls, 1)
  assert.deepEqual(JSON.parse(body), candidates)
})

test('提交测试设计运行携带服务端要求的幂等键', async () => {
  const originalFetch = globalThis.fetch
  let idempotencyKey = ''
  globalThis.fetch = async (_input, init) => {
    idempotencyKey = new Headers(init?.headers).get('idempotency-key') ?? ''
    return Response.json({ id: 'run-1', status: 'queued' })
  }
  try {
    const run = await createTestDesignRun('pv-1', 'design-1')
    assert.equal(run.id, 'run-1')
    assert.match(idempotencyKey, /^test-design-design-1-\d+$/u)
  } finally { globalThis.fetch = originalFetch }
})

test('范围确认提交固定运行、目标版本和并发版本', async () => {
  const originalFetch = globalThis.fetch
  let requestPath = ''
  let requestBody: Record<string, unknown> = {}
  globalThis.fetch = async (input, init) => {
    requestPath = new URL(String(input)).pathname
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({ id: 'run-1', status: 'queued', stage: 'functional_design' })
  }
  try {
    await applyTestDesignGateDecision('pv-1', 'design-1', 'run-1', 'scope', { targetId: 'artifact-1', targetRevision: 2, expectedVersion: 0, decision: 'approved', comment: '范围确认' })
    assert.equal(requestPath, '/api/project-versions/pv-1/test-designs/design-1/runs/run-1/gates/scope/decisions')
    assert.deepEqual(requestBody, { targetId: 'artifact-1', targetRevision: 2, expectedVersion: 0, decision: 'approved', comment: '范围确认' })
  } finally { globalThis.fetch = originalFetch }
})

test('测试设计请求展示服务端结构化业务错误', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ code: 'WORKFLOW_GATE_VERSION_CONFLICT', message: '门禁目标已变化' }, { status: 409 })
  try {
    await assert.rejects(
      applyTestDesignGateDecision('pv-1', 'design-1', 'run-1', 'scope', { targetId: 'stale-artifact', targetRevision: 1, expectedVersion: 1, decision: 'approved' }),
      /门禁目标已变化/u,
    )
  } finally { globalThis.fetch = originalFetch }
})

test('测试设计 HTTP 响应允许浏览器跨端口读取', async () => {
  const server = readFileSync(new URL('../server/http/server.ts', import.meta.url), 'utf8')
  const headers = new Map<string, string>()
  let body = ''
  const response = {
    statusCode: 0,
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value) },
    end(value: string) { body = value },
  }
  const handled = await routeTestDesign({ headers: {} }, response as never, {
    method: 'GET',
    url: new URL('http://127.0.0.1/api/project-versions/pv-1/test-designs'),
    principal: { subjectId: 'tester', displayName: '测试人员' },
    controls: { authenticate: async () => ({ subjectId: 'tester', displayName: '测试人员' }), authorize: async () => undefined, canAccess: async () => true },
    service: { listDesigns: async () => [] } as never,
    store: {} as never,
    configurations: {} as never,
  })
  assert.equal(handled, true)
  assert.equal(headers.get('access-control-allow-origin'), '*')
  assert.match(headers.get('access-control-allow-headers') ?? '', /idempotency-key/u)
  assert.match(headers.get('access-control-allow-headers') ?? '', /if-match/u)
  assert.match(headers.get('access-control-expose-headers') ?? '', /etag/u)
  assert.match(server, /access-control-allow-headers': 'content-type, authorization, idempotency-key, if-match'/u)
  assert.equal(body, '{"items":[]}')
})
