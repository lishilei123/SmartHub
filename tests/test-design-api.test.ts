import assert from 'node:assert/strict'
import test from 'node:test'
import { applyTestDesignGateDecision, createTestDesignRun, loadTestDesignInputs } from '../src/test-design-api.ts'
import { routeTestDesign } from '../server/http/test-design-routes.ts'
import { readFileSync } from 'node:fs'

test('测试设计创建表单从真实候选接口聚合依据和 Agent 就绪状态', async () => {
  const originalFetch = globalThis.fetch
  const paths: string[] = []
  globalThis.fetch = async input => {
    const url = String(input)
    paths.push(new URL(url).pathname)
    if (url.endsWith('/inputs/review-baselines')) return Response.json([{ sourceReviewRunId: 'rr-1', sourceTechnicalSolutionRunId: 'tr-1', label: '基线', selectable: true }])
    if (url.endsWith('/inputs/knowledge-assets')) return Response.json([{ assetId: 'asset-1', assetVersionId: 'av-1', version: 2, contentHash: 'a'.repeat(64), displayName: '需求', logicalPath: '需求.md', assetType: 'requirement', status: 'ready', selectable: true }])
    if (url.endsWith('/inputs/fixed-indexes')) return Response.json([{ id: 'index-1', selectable: true }])
    if (url.endsWith('/inputs/historical-case-sets')) return Response.json([])
    if (url.endsWith('/inputs/historical-case-assets')) return Response.json([])
    if (url.endsWith('/agent-readiness')) return Response.json({ ready: true, agents: [] })
    return Response.json({ error: 'unexpected request' }, { status: 404 })
  }
  try {
    const result = await loadTestDesignInputs('pv-1')
    assert.equal(result.reviewBaselines[0].sourceReviewRunId, 'rr-1')
    assert.equal(result.knowledgeAssets[0].assetVersionId, 'av-1')
    assert.equal(result.agentReadiness.ready, true)
    assert.equal(result.fixedIndexes[0].id, 'index-1')
    assert.equal(paths.length, 6)
  } finally { globalThis.fetch = originalFetch }
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
