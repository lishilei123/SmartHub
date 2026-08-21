import assert from 'node:assert/strict'
import test from 'node:test'
import { TestDesignService } from '../server/application/test-design-service.js'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import { TestDesignError } from '../server/application/test-design-validation.js'
import type { TestCaseContent, TestDesignState } from '../server/domain/test-design-types.js'
import { JsonStore } from '../server/infrastructure/store.js'

const principal = { subjectId: 'suite-test-user', displayName: '套件测试用户' }
const now = '2026-08-21T00:00:00.000Z'
const projectId = 'project-suite-methods'
const projectVersionId = 'project-version-suite-methods'
const libraryVersionId = 'library-version-suite-methods'

function functionalContent(methods: Array<'ui' | 'api'>, title = '订单创建') : TestCaseContent {
  const executionMethods = methods.map(method => method === 'ui'
    ? { method, uiSpec: { entry: '/orders/new', selectors: ['[data-testid="submit-order"]'] }, steps: [{ key: 'ui-submit', action: '在订单页面提交有效订单', expected: '页面显示订单创建成功' }], verificationChecks: [{ key: 'ui-check', description: '订单详情页显示新订单号' }], executionReadiness: 'ready' as const, automationHint: 'UI 自动化' }
    : { method, apiSpec: { method: 'POST', path: '/api/orders' }, steps: [{ key: 'api-submit', action: '向订单 API 提交有效请求', expected: '响应返回新订单 ID' }], verificationChecks: [{ key: 'api-check', description: '响应状态码为 201 且订单可查询' }], executionReadiness: 'ready' as const, automationHint: 'API 自动化' },
  )
  const primary = executionMethods[0]!
  return {
    schemaVersion: 'test-case/v2', title, objective: `验证${title}`, dimension: 'functional', requirementRefs: ['REQ-ORDER-1'], priority: 'P0', preconditions: [], dataRequirementIds: [], cleanup: [], dependencies: [], executionMethods,
    executionSpec: { kind: 'functional', method: primary.method, steps: primary.steps, verificationChecks: primary.verificationChecks, preconditions: [], testDataRequirements: [], executionReadiness: primary.executionReadiness, automationHint: primary.automationHint },
    sharedVerificationChecks: [], tags: [], domain: '订单',
  }
}

function performanceContent(): TestCaseContent {
  return {
    schemaVersion: 'test-case/v2', title: '订单接口性能', objective: '验证订单接口性能', dimension: 'performance', requirementRefs: ['REQ-ORDER-1'], priority: 'P1', preconditions: [], dataRequirementIds: [], cleanup: [], dependencies: [], executionMethods: [],
    executionSpec: { kind: 'performance', method: 'performance_tool', target: '/api/orders', scenario: '稳定订单创建流量', virtualUsers: 20, duration: '5m', rampUp: '1m', thresholds: [{ metric: 'p95', target: '<= 500ms', sourceRef: 'REQ-PERF-1' }], dataStrategy: '隔离压测数据', environmentRequirements: ['测试环境'], executionReadiness: 'ready' },
    sharedVerificationChecks: [], tags: [], domain: '订单',
  }
}

function stabilityContent(): TestCaseContent {
  return {
    schemaVersion: 'test-case/v2', title: '订单服务稳定性', objective: '验证订单服务稳定性', dimension: 'stability', requirementRefs: ['REQ-ORDER-1'], priority: 'P1', preconditions: [], dataRequirementIds: [], cleanup: [], dependencies: [], executionMethods: [],
    executionSpec: { kind: 'stability', method: 'long_running', workload: '持续创建和查询订单', duration: '24h', interval: '5m', observations: ['无异常退出'], recoveryPolicy: '记录并恢复', checkpointPolicy: '每小时检查', environmentRequirements: ['测试环境'], executionReadiness: 'ready' },
    sharedVerificationChecks: [], tags: [], domain: '订单',
  }
}

function compatibilityContent(): TestCaseContent {
  return {
    schemaVersion: 'test-case/v2', title: '订单页面兼容性', objective: '验证订单页面兼容性', dimension: 'compatibility', requirementRefs: ['REQ-ORDER-1'], priority: 'P1', preconditions: [], dataRequirementIds: [], cleanup: [], dependencies: [], executionMethods: [],
    executionSpec: { kind: 'compatibility', method: 'environment_matrix', baseMethod: 'ui', baseCaseRefs: ['CASE-DUAL'], browserMatrix: ['Chrome'], operatingSystemMatrix: [], viewportMatrix: [], versionMatrix: [], expectedConsistency: '订单创建结果一致', executionReadiness: 'ready' },
    sharedVerificationChecks: [], tags: [], domain: '订单',
  }
}

function libraryCase(id: string, content: TestCaseContent, revision = 3) {
  const contentSha256 = canonicalSha256(content)
  return {
    id, projectId, currentRevision: revision, status: 'active' as const, createdAt: now, updatedAt: now,
    revisions: [{ revision, content, contentSha256, semanticSha256: canonicalSha256({ ...content, tags: [...content.tags].sort() }), changeReason: '测试固定 Revision', createdBy: principal.subjectId, createdAt: now }],
  }
}

async function fixture(options: { dualUiReadiness?: 'ready' | 'blocked'; dualApiReadiness?: 'ready' | 'blocked' } = {}) {
  const store = new JsonStore(null)
  await store.load()
  const dualContent = functionalContent(['ui', 'api'])
  const uiMethod = dualContent.executionMethods.find(item => item.method === 'ui')!
  const apiMethod = dualContent.executionMethods.find(item => item.method === 'api')!
  uiMethod.executionReadiness = options.dualUiReadiness ?? 'ready'
  apiMethod.executionReadiness = options.dualApiReadiness ?? 'ready'
  dualContent.executionSpec = { ...dualContent.executionSpec!, executionReadiness: uiMethod.executionReadiness }
  const dual = libraryCase('CASE-DUAL', dualContent)
  const uiOnly = libraryCase('CASE-UI', functionalContent(['ui'], '仅 UI 订单创建'))
  const apiOnly = libraryCase('CASE-API', functionalContent(['api'], '仅 API 订单创建'))
  const performance = libraryCase('CASE-PERFORMANCE', performanceContent())
  const stability = libraryCase('CASE-STABILITY', stabilityContent())
  const compatibility = libraryCase('CASE-COMPATIBILITY', compatibilityContent())
  const libraryCases = [dual, uiOnly, apiOnly, performance, stability, compatibility]
  const members = libraryCases.map((item, ordinal) => ({ caseId: item.id, revision: item.currentRevision, ordinal, contentSha256: item.revisions[0]!.contentSha256 }))
  const librarySha256 = canonicalSha256({ members })
  await store.transaction(state => {
    state.projects.push({ id: projectId, name: '套件执行方式测试', createdAt: now })
    state.projectVersions.push({ id: projectVersionId, projectId, name: '测试版本', status: 'open', createdAt: now, updatedAt: now })
    state.testDesignState = {
      architectureVersion: 'single-agent-skills/v1', designs: [], runs: [], caseSetVersions: [], libraryCases,
      libraryVersions: [{ id: libraryVersionId, projectId, version: 1, name: '正式用例库 V1', members, contentSha256: librarySha256, publishedBy: principal.subjectId, publishedAt: now, projection: { status: 'succeeded', files: [] } }],
      suiteDrafts: [], suiteVersions: [], executionHandoffs: [], legacyMigrations: [],
    } as TestDesignState
  })
  return { store, service: new TestDesignService(store), librarySha256 }
}

async function createDraft(service: TestDesignService, key: string, suiteType: 'smoke' | 'regression' | 'custom', members: unknown[]) {
  return service.createSuiteDraft(projectId, { suiteKey: key, suiteType, name: `${key} 套件`, testCaseLibraryVersionId: libraryVersionId, members }, principal)
}

async function publishDraft(service: TestDesignService, key: string, suiteType: 'smoke' | 'regression' | 'custom', members: unknown[]) {
  const draft = await createDraft(service, key, suiteType, members)
  return service.publishSuiteDraft(projectId, draft.id, draft.etag, principal)
}

test('功能用例的套件 Draft 规范化 UI/API 数组，并兼容旧 executionMethod 请求', async () => {
  const { service } = await fixture()
  const legacy = await createDraft(service, 'legacy-ui', 'smoke', [{ caseId: 'CASE-DUAL', executionMethod: 'ui', reason: '旧前端请求' }])
  assert.deepEqual(legacy.members[0]!.executionMethods, ['ui'])
  assert.equal(legacy.members[0]!.executionMethod, undefined)

  const ordered = await createDraft(service, 'all-methods', 'smoke', [{ caseId: 'CASE-DUAL', executionMethods: ['api', 'ui'], reason: '核心链路' }])
  assert.deepEqual(ordered.members[0]!.executionMethods, ['ui', 'api'])
  const updated = await service.updateSuiteDraft(projectId, ordered.id, ordered.etag, { suiteKey: 'all-methods', suiteType: 'smoke', name: 'all-methods 套件', testCaseLibraryVersionId: libraryVersionId, members: [{ caseId: 'CASE-DUAL', executionMethods: ['ui', 'api'], reason: '核心链路' }] }, principal)
  assert.equal(updated.contentSha256, ordered.contentSha256)
  const version = await service.publishSuiteDraft(projectId, updated.id, updated.etag, principal)
  assert.deepEqual(version.members[0]!.executionMethods, ['ui', 'api'])
})

test('套件服务端按冻结 Revision 校验多方法子集、重复方法和单一用例成员', async () => {
  const { service } = await fixture()
  const apiOnly = await createDraft(service, 'api-only', 'smoke', [{ caseId: 'CASE-DUAL', executionMethods: ['api'], reason: 'API 快速验证' }])
  assert.deepEqual(apiOnly.members[0]!.executionMethods, ['api'])
  await assert.rejects(
    () => createDraft(service, 'ui-reject-api', 'smoke', [{ caseId: 'CASE-UI', executionMethods: ['api'], reason: '非法方式' }]),
    (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_SUITE_EXECUTION_METHOD_INVALID' && error.details?.caseId === 'CASE-UI' && error.details?.revision === 3 && Array.isArray(error.details?.selectedMethods) && Array.isArray(error.details?.availableMethods),
  )
  await assert.rejects(() => createDraft(service, 'duplicate-method', 'smoke', [{ caseId: 'CASE-DUAL', executionMethods: ['ui', 'ui'], reason: '重复方式' }]), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_SUITE_EXECUTION_METHOD_INVALID')
  await assert.rejects(() => createDraft(service, 'duplicate-case', 'smoke', [{ caseId: 'CASE-DUAL', executionMethods: ['ui'], reason: '第一次' }, { caseId: 'CASE-DUAL', executionMethods: ['api'], reason: '第二次' }]), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_SUITE_MEMBER_DUPLICATE')
})

test('Smoke、Regression、Custom 依据冻结 executionMethods 展开各自 UI/API 契约', async () => {
  const { service, librarySha256 } = await fixture()
  const members = [{ caseId: 'CASE-DUAL', executionMethods: ['ui', 'api'], reason: '核心订单流程' }]
  const smoke = await publishDraft(service, 'smoke-dual', 'smoke', members)
  const regression = await publishDraft(service, 'regression-dual', 'regression', members)
  const custom = await publishDraft(service, 'custom-dual', 'custom', members)
  for (const [mode, suite] of [['smoke', smoke], ['regression', regression], ['custom', custom]] as const) {
    const handoff = await service.createLibraryHandoff(projectVersionId, libraryVersionId, { mode, suiteVersionId: suite.id, expectedLibrarySha256: librarySha256 }, principal)
    assert.deepEqual(handoff.members.map(item => item.method), ['ui', 'api'])
    assert.deepEqual(handoff.members.map(item => item.ordinal), [0, 1])
    assert.deepEqual(handoff.members.map(item => item.dedupKey), ['CASE-DUAL:3:ui', 'CASE-DUAL:3:api'])
    assert.equal(handoff.members[0]!.executionSpec.kind, 'functional')
    assert.equal(handoff.members[0]!.executionSpec.method, 'ui')
    assert.equal(handoff.members[0]!.executionSpec.steps[0]!.key, 'ui-submit')
    assert.equal(handoff.members[1]!.executionSpec.method, 'api')
    assert.equal(handoff.members[1]!.executionSpec.steps[0]!.key, 'api-submit')
  }
  const regressionWithImpact = await service.createLibraryHandoff(projectVersionId, libraryVersionId, { mode: 'regression', suiteVersionId: regression.id, impactedCaseIds: ['CASE-DUAL'], expectedLibrarySha256: librarySha256 }, principal)
  assert.deepEqual(regressionWithImpact.members.map(item => item.dedupKey), ['CASE-DUAL:3:ui', 'CASE-DUAL:3:api'])
  const regressionUiOnly = await publishDraft(service, 'regression-ui-only', 'regression', [{ caseId: 'CASE-UI', executionMethod: 'ui', reason: 'UI 回归基线' }])
  const regressionWithExtraImpact = await service.createLibraryHandoff(projectVersionId, libraryVersionId, { mode: 'regression', suiteVersionId: regressionUiOnly.id, impactedCaseIds: ['CASE-DUAL'], expectedLibrarySha256: librarySha256 }, principal)
  assert.deepEqual(regressionWithExtraImpact.members.map(item => item.dedupKey), ['CASE-UI:3:ui', 'CASE-DUAL:3:ui', 'CASE-DUAL:3:api'])
})

test('仅选择的方式进入 Suite Handoff；旧 Suite Version、非功能套件与 Full Handoff 保持兼容', async () => {
  const { store, service, librarySha256 } = await fixture()
  const uiSuite = await publishDraft(service, 'smoke-ui-only', 'smoke', [{ caseId: 'CASE-DUAL', executionMethods: ['ui'], reason: '仅页面检查' }])
  const uiHandoff = await service.createLibraryHandoff(projectVersionId, libraryVersionId, { mode: 'smoke', suiteVersionId: uiSuite.id, expectedLibrarySha256: librarySha256 }, principal)
  assert.deepEqual(uiHandoff.members.map(item => item.method), ['ui'])

  const apiSuite = await publishDraft(service, 'smoke-api-only', 'smoke', [{ caseId: 'CASE-API', executionMethod: 'api', reason: '仅接口检查' }])
  const apiHandoff = await service.createLibraryHandoff(projectVersionId, libraryVersionId, { mode: 'smoke', suiteVersionId: apiSuite.id, expectedLibrarySha256: librarySha256 }, principal)
  assert.deepEqual(apiHandoff.members.map(item => item.method), ['api'])

  const performanceSuite = await publishDraft(service, 'custom-performance', 'custom', [{ caseId: 'CASE-PERFORMANCE', executionMethod: 'performance_tool', reason: '性能基线' }])
  assert.equal(performanceSuite.members[0]!.executionMethod, 'performance_tool')
  assert.deepEqual(performanceSuite.members[0]!.executionMethods, [])
  const performanceHandoff = await service.createLibraryHandoff(projectVersionId, libraryVersionId, { mode: 'custom', suiteVersionId: performanceSuite.id, expectedLibrarySha256: librarySha256 }, principal)
  assert.deepEqual(performanceHandoff.members.map(item => item.method), ['performance_tool'])

  const stabilitySuite = await publishDraft(service, 'custom-stability', 'custom', [{ caseId: 'CASE-STABILITY', executionMethod: 'long_running', reason: '稳定性基线' }])
  const stabilityHandoff = await service.createLibraryHandoff(projectVersionId, libraryVersionId, { mode: 'custom', suiteVersionId: stabilitySuite.id, expectedLibrarySha256: librarySha256 }, principal)
  assert.deepEqual(stabilityHandoff.members.map(item => item.method), ['long_running'])
  const compatibilitySuite = await publishDraft(service, 'custom-compatibility', 'custom', [{ caseId: 'CASE-COMPATIBILITY', executionMethod: 'environment_matrix', reason: '兼容性矩阵' }])
  const compatibilityHandoff = await service.createLibraryHandoff(projectVersionId, libraryVersionId, { mode: 'custom', suiteVersionId: compatibilitySuite.id, expectedLibrarySha256: librarySha256 }, principal)
  assert.deepEqual(compatibilityHandoff.members.map(item => item.method), ['environment_matrix'])

  await store.transaction(state => {
    const aggregate = state.testDesignState!
    aggregate.suiteVersions.push({ id: 'legacy-suite-api', projectId, suiteKey: 'legacy-suite', suiteType: 'smoke', version: 1, name: '历史 API Smoke', testCaseLibraryVersionId: libraryVersionId, compatibilityStatus: 'compatible', members: [{ testCaseLibraryVersionId: libraryVersionId, caseId: 'CASE-DUAL', revision: 3, executionMethod: 'api', ordinal: 0, reason: '历史冻结选择' }], contentSha256: canonicalSha256({ legacy: true }), publishedBy: principal.subjectId, publishedAt: now, status: 'active' })
  })
  const legacy = await service.getSuite(projectId, 'legacy-suite-api')
  assert.equal(legacy.members[0]!.executionMethods, undefined)
  const legacyHandoff = await service.createLibraryHandoff(projectVersionId, libraryVersionId, { mode: 'smoke', suiteVersionId: legacy.id, expectedLibrarySha256: librarySha256 }, principal)
  assert.deepEqual(legacyHandoff.members.map(item => item.method), ['api'])

  const full = await service.createLibraryHandoff(projectVersionId, libraryVersionId, { mode: 'full', expectedLibrarySha256: librarySha256 }, principal)
  assert.deepEqual(full.members.filter(item => item.caseId === 'CASE-DUAL').map(item => item.method), ['ui', 'api'])
})

test('方法级 Execution Readiness 只阻断套件实际选择的方法', async () => {
  const { service, librarySha256 } = await fixture({ dualUiReadiness: 'blocked' })
  const apiSuite = await publishDraft(service, 'smoke-api-ready', 'smoke', [{ caseId: 'CASE-DUAL', executionMethods: ['api'], reason: '仅执行已就绪 API' }])
  const apiHandoff = await service.createLibraryHandoff(projectVersionId, libraryVersionId, { mode: 'smoke', suiteVersionId: apiSuite.id, expectedLibrarySha256: librarySha256 }, principal)
  assert.deepEqual(apiHandoff.members.map(item => item.method), ['api'])
  const bothSuite = await publishDraft(service, 'smoke-ui-api-blocked', 'smoke', [{ caseId: 'CASE-DUAL', executionMethods: ['ui', 'api'], reason: '同时执行 UI 与 API' }])
  await assert.rejects(() => service.createLibraryHandoff(projectVersionId, libraryVersionId, { mode: 'smoke', suiteVersionId: bothSuite.id, expectedLibrarySha256: librarySha256 }, principal), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_EXECUTION_CASE_BLOCKED' && error.details?.method === 'ui')
})
