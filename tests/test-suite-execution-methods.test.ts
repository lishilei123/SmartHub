import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import { TestDesignService } from '../server/application/test-design-service.js'
import { TestDesignError } from '../server/application/test-design-validation.js'
import type { TestCaseContent, TestDesignState } from '../server/domain/test-design-types.js'
import { JsonStore } from '../server/infrastructure/store.js'

const principal = { subjectId: 'suite-test-user', displayName: '套件测试用户' }
const now = '2026-08-21T00:00:00.000Z'
const projectId = 'project-suite-methods'
const projectVersionId = 'project-version-suite-methods'
const libraryVersionId = 'library-version-suite-methods'

function content(title: string, dimension: TestCaseContent['dimension'], executionMethods: Array<'ui' | 'api'>): TestCaseContent {
  return { schemaVersion: 'test-case/v3', title, dimension, priority: 'P1', requirementRefs: ['REQ-1'], executionMethods, preconditions: [], steps: ['执行测试动作'], expectedResults: ['结果符合预期'] }
}

async function fixture() {
  const store = new JsonStore(null)
  await store.load()
  const cases = [
    { id: 'CASE-DUAL', content: content('双通道订单创建', 'functional', ['ui', 'api']) },
    { id: 'CASE-SECURITY', content: { ...content('越权访问检查', 'security', ['api']), requirementRefs: [] } },
    { id: 'CASE-PERFORMANCE', content: content('订单性能检查', 'performance', ['api']) },
  ].map((item, ordinal) => {
    const contentSha256 = canonicalSha256(item.content)
    return { ...item, ordinal, contentSha256, libraryCase: { id: item.id, projectId, currentRevision: 1, status: 'active' as const, createdAt: now, updatedAt: now, revisions: [{ revision: 1, content: item.content, contentSha256, semanticSha256: contentSha256, changeReason: 'v3 fixture', createdBy: principal.subjectId, createdAt: now }] } }
  })
  const members = cases.map(item => ({ caseId: item.id, revision: 1, ordinal: item.ordinal, contentSha256: item.contentSha256 }))
  const sourceRunId = 'run-suite-fixture'
  const librarySha256 = canonicalSha256({ schemaVersion: 'test-case-library/v3', projectId, sourceRunId, members })
  await store.transaction(state => {
    state.projects.push({ id: projectId, name: '套件执行方式测试', createdAt: now })
    state.projectVersions.push({ id: projectVersionId, projectId, name: '测试版本', status: 'open', createdAt: now, updatedAt: now })
    state.testDesignState = { architectureVersion: 'single-agent-skills/v1', designs: [], runs: [], libraryCases: cases.map(item => item.libraryCase), libraryVersions: [{ id: libraryVersionId, projectId, version: 1, name: '正式用例库 V1', sourceRunId, members, contentSha256: librarySha256, publishedBy: principal.subjectId, publishedAt: now, projection: { status: 'succeeded', files: [] } }], suiteDrafts: [], suiteVersions: [], executionHandoffs: [] } as TestDesignState
  })
  return { service: new TestDesignService(store), librarySha256 }
}

async function publishSuite(service: TestDesignService, executionMethods: Array<'ui' | 'api'>) {
  const draft = await service.createSuiteDraft(projectId, { suiteKey: 'smoke-v3', suiteType: 'smoke', name: 'V3 Smoke', testCaseLibraryVersionId: libraryVersionId, members: [{ caseId: 'CASE-DUAL', executionMethods, reason: '核心链路' }] }, principal)
  return service.publishSuiteDraft(projectId, draft.id, draft.etag, principal)
}

test('套件只接受 v3 executionMethods 数组并拒绝旧 executionMethod', async () => {
  const { service } = await fixture()
  const draft = await service.createSuiteDraft(projectId, { suiteKey: 'api-only', suiteType: 'smoke', name: 'API Smoke', testCaseLibraryVersionId: libraryVersionId, members: [{ caseId: 'CASE-DUAL', executionMethods: ['api'], reason: 'API 核心链路' }] }, principal)
  assert.deepEqual(draft.members[0]?.executionMethods, ['api'])
  await assert.rejects(() => service.createSuiteDraft(projectId, { suiteKey: 'legacy', suiteType: 'smoke', name: 'Legacy', testCaseLibraryVersionId: libraryVersionId, members: [{ caseId: 'CASE-DUAL', executionMethod: 'ui', reason: '旧协议' }] }, principal), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_SUITE_EXECUTION_METHOD_INVALID')
})

test('同一 TestCase 的 UI/API 在 Handoff 展开为两个冻结方法级成员', async () => {
  const { service, librarySha256 } = await fixture()
  const suite = await publishSuite(service, ['ui', 'api'])
  const handoff = await service.createLibraryHandoff(projectVersionId, libraryVersionId, { mode: 'smoke', suiteVersionId: suite.id, expectedLibrarySha256: librarySha256 }, principal)
  assert.deepEqual(handoff.members.map(item => item.method), ['ui', 'api'])
  assert.deepEqual(handoff.members.map(item => item.dedupKey), ['CASE-DUAL:1:ui', 'CASE-DUAL:1:api'])
  assert.equal(handoff.members[0]?.executionSpec?.schemaVersion, 'test-script-input/v1')
  assert.equal(handoff.members[0]?.executionSpec?.testCase.schemaVersion, 'test-case/v3')
  assert.equal(handoff.members[0]?.executionSpec?.testCase.title, '双通道订单创建')
})

test('扩展 Case 与所有测试维度都通过 TestCase v3 的 UI/API 方法创建 Full Handoff', async () => {
  const { service, librarySha256 } = await fixture()
  const handoff = await service.createLibraryHandoff(projectVersionId, libraryVersionId, { mode: 'full', expectedLibrarySha256: librarySha256 }, principal)
  assert.deepEqual(handoff.members.map(item => `${item.caseId}:${item.method}`), ['CASE-DUAL:ui', 'CASE-DUAL:api', 'CASE-SECURITY:api', 'CASE-PERFORMANCE:api'])
  assert.deepEqual(handoff.members.find(item => item.caseId === 'CASE-SECURITY')?.executionSpec?.testCase.requirementRefs, [])
})
