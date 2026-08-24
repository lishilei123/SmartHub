import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createProjectVersionExplorationResult,
  normalizeUiNetworkObservation,
} from '../server/application/test-execution-exploration.js'
import { canonicalJson } from '../server/application/canonical-json.js'
import { StateStoreTestExecutionKnowledgeResolver } from '../server/application/test-execution-knowledge.js'
import {
  parsePlaywrightCliRequestDetail,
  parsePlaywrightCliRequestSummaries,
} from '../server/agent/ui-execution-agent.js'
import { LocalExecutionWorkspaceStore } from '../server/infrastructure/execution-workspace-store.js'
import { JsonStore } from '../server/infrastructure/store.js'

const environmentSignature = 'e'.repeat(64)

test('UI Action 关联的业务 API 被结构化，真实请求与响应值不进入 Exploration Context', () => {
  const observation = normalizeUiNetworkObservation({
    method: 'POST',
    url: 'https://example.test/api/projects/550e8400-e29b-41d4-a716-446655440000?include=owner&token=secret-query',
    resourceType: 'xhr',
    requestHeaders: {
      authorization: 'Bearer live-access-token',
      cookie: 'session=live-session',
      'content-type': 'application/json; charset=utf-8',
      'x-user-email': 'person@example.test',
    },
    requestBody: {
      username: 'real-user@example.test',
      password: 'real-password',
      profile: { phone: '13800138000' },
    },
    responseStatus: 201,
    responseHeaders: {
      'content-type': 'application/json',
      'set-cookie': 'session=server-session',
    },
    responseBody: {
      token: 'real-jwt-token',
      user: { id: 42, email: 'real-user@example.test' },
    },
    page: 'https://example.test/projects/new?draft=secret',
    action: 'click 创建项目 password with action-secret',
    actionType: 'click',
    sequence: 3,
  })

  assert.ok(observation)
  assert.equal(observation.method, 'POST')
  assert.equal(observation.path, '/api/projects/{id}')
  assert.deepEqual(observation.queryParams, ['include', 'token'])
  assert.deepEqual(observation.observedFrom, {
    page: '/projects/new',
    action: 'click 创建项目 password <REDACTED>',
    actionType: 'click',
    sequence: 3,
  })
  assert.equal(observation.requestHeaders.authorization, '<REDACTED>')
  assert.equal(observation.requestHeaders.cookie, '<REDACTED>')
  assert.equal(observation.requestHeaders['x-user-email'], undefined)
  assert.equal(observation.requestSchema?.properties?.password.redacted, true)
  assert.equal(observation.responseSchema?.properties?.token.redacted, true)
  assert.equal(observation.responseStatus, 201)
  const serialized = JSON.stringify(observation)
  for (const secret of [
    'live-access-token',
    'live-session',
    'real-user@example.test',
    'real-password',
    '13800138000',
    'real-jwt-token',
    'secret-query',
    'server-session',
    'action-secret',
  ]) assert.equal(serialized.includes(secret), false, secret)
})

test('静态资源、Analytics 与 Telemetry 不进入正式 API Exploration Context', () => {
  for (const candidate of [
    { method: 'GET', url: 'https://example.test/assets/main.js', resourceType: 'script' },
    { method: 'GET', url: 'https://example.test/logo.png', resourceType: 'image' },
    { method: 'POST', url: 'https://example.test/analytics/collect', resourceType: 'fetch' },
    { method: 'POST', url: 'https://telemetry.example.test/v1/events', resourceType: 'xhr' },
  ]) assert.equal(normalizeUiNetworkObservation(candidate), null)
})

test('无请求体与响应体的 Exploration Result 可进入严格 Canonical JSON', () => {
  const observation = normalizeUiNetworkObservation({
    method: 'GET',
    url: 'https://example.test/api/tasks?priority=high',
    resourceType: 'xhr',
    responseStatus: 204,
    page: '/tasks',
    action: 'select high priority',
    actionType: 'select',
    sequence: 1,
  })!
  const result = createProjectVersionExplorationResult({
    projectVersionId: 'pv-v1',
    sourceCaseId: 'TC_UI_PRIORITY_001',
    environmentSignature,
    observedAt: '2026-08-24T10:00:00.000Z',
    observation,
  })

  assert.equal(Object.hasOwn(result, 'requestSchema'), false)
  assert.equal(Object.hasOwn(result, 'responseSchema'), false)
  assert.doesNotThrow(() => canonicalJson(result))
})

test('Playwright CLI requests/request 输出解析保留稳定请求序号与详情', () => {
  const [summary] = parsePlaywrightCliRequestSummaries([
    '[7] POST https://example.test/api/login [200] xhr',
    '[8] GET https://example.test/assets/main.js [200] script',
  ].join('\n'))
  assert.deepEqual(summary, {
    index: 7,
    method: 'POST',
    url: 'https://example.test/api/login',
    status: 200,
    resourceType: 'xhr',
  })
  assert.deepEqual(parsePlaywrightCliRequestDetail([
    'Method: POST',
    'URL: https://example.test/api/login',
    'Status: 201 Created',
    'Resource Type: fetch',
  ].join('\n'), summary), {
    index: 7,
    method: 'POST',
    url: 'https://example.test/api/login',
    status: 201,
    resourceType: 'fetch',
  })
})

test('Exploration Context 按 ProjectVersion 隔离、继承后独立 needs_validation、再次观察后 validated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smarthub-exploration-context-'))
  try {
    const store = new LocalExecutionWorkspaceStore(root)
    const observation = normalizeUiNetworkObservation({
      method: 'POST',
      url: 'https://example.test/api/login',
      resourceType: 'fetch',
      requestBody: { username: 'real-user', password: 'real-password' },
      responseStatus: 200,
      responseBody: { token: 'real-token', user: { id: 1 } },
      page: '/login',
      action: 'click 登录',
      actionType: 'click',
      sequence: 2,
    })!
    const source = createProjectVersionExplorationResult({
      projectVersionId: 'pv-v1',
      sourceCaseId: 'TC_UI_LOGIN_001',
      environmentSignature,
      sourceRunId: 'run-v1',
      sourceTaskId: 'task-v1',
      observedAt: '2026-08-23T01:00:00.000Z',
      observation,
    })
    await store.saveExplorationResults('pv-v1', [source])
    assert.equal((await store.listExplorationResults('pv-v2')).length, 0)

    await store.inherit('pv-v1', 'pv-v2')
    const [inherited] = await store.listExplorationResults('pv-v2')
    assert.equal(inherited.projectVersionId, 'pv-v2')
    assert.equal(inherited.validationStatus, 'needs_validation')
    assert.equal(inherited.inheritedFromProjectVersionId, 'pv-v1')
    assert.equal(inherited.inheritedFromExplorationId, source.id)
    assert.notEqual(inherited.id, source.id)

    const current = createProjectVersionExplorationResult({
      projectVersionId: 'pv-v2',
      sourceCaseId: 'TC_UI_LOGIN_001',
      environmentSignature,
      sourceRunId: 'run-v2',
      sourceTaskId: 'task-v2',
      observedAt: '2026-08-23T02:00:00.000Z',
      observation,
    })
    await store.saveExplorationResults('pv-v2', [current])
    const [validated] = await store.listExplorationResults('pv-v2')
    assert.equal(validated.validationStatus, 'validated')
    assert.equal(validated.inheritedFromProjectVersionId, undefined)
    assert.equal(validated.sourceRunId, 'run-v2')
    assert.equal((await store.listExplorationResults('pv-v1'))[0].sourceRunId, 'run-v1')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Execution Run 的 Knowledge Retrieval 固定当前项目不可变 active index', async () => {
  const store = new JsonStore(null)
  await store.load()
  await store.transaction(state => {
    state.knowledgeBases.push({
      id: 'kb-project-1',
      projectId: 'project-1',
      name: '项目知识库',
      createdAt: '2026-08-20T00:00:00.000Z',
      activeIndexVersionId: 'index-7',
      activeConfigVersionId: 'config-1',
    })
    state.indexes.push({
      id: 'index-7',
      knowledgeBaseId: 'kb-project-1',
      number: 7,
      status: 'active',
      assetVersionIds: [],
      configVersionId: 'config-1',
      createdAt: '2026-08-22T00:00:00.000Z',
      activatedAt: '2026-08-22T01:00:00.000Z',
    })
  })
  assert.deepEqual(
    await new StateStoreTestExecutionKnowledgeResolver(store).resolveSnapshot('project-1'),
    {
      knowledgeBaseId: 'kb-project-1',
      indexVersionId: 'index-7',
      indexVersion: 7,
      indexCreatedAt: '2026-08-22T00:00:00.000Z',
    },
  )
})
