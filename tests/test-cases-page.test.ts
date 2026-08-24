import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import { TestDesignService, testCaseSemanticSha256 } from '../server/application/test-design-service.js'
import { routeTestDesign } from '../server/http/test-design-routes.js'
import { JsonStore } from '../server/infrastructure/store.js'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const agentTestSpec = { input: '提交任务', expectedOutcome: '任务成功', requiredTools: [], forbiddenTools: [], requiredActions: [], forbiddenActions: [], argumentAssertions: [], sequenceConstraints: [], businessAssertions: [], artifactAssertions: [], semanticAssertions: [], safetyAssertions: [], executionConstraints: { timeoutMs: 30_000, maxSteps: 20, repeatCount: 1 } }
const content = { schemaVersion: 'test-case/v3' as const, title: '继承后修改的任务校验', dimension: 'functional' as const, priority: 'P1' as const, requirementRefs: ['REQ-2'], executionMethods: ['agent'] as const, preconditions: ['被测 Agent 已配置'], steps: ['提交任务'], expectedResults: ['任务成功'], agentTestSpec }
const traceability = { sourceRequirementReleaseId: 'release-v2', requirementRefs: [{ requirementReleaseId: 'release-v2', requirementId: 'REQ-2' }] }

test('正式测试用例读取按 ProjectVersion 选择最新 LibraryVersion，并保留历史修改来源', async () => {
  const sourceContent = { ...content, title: '历史登录校验', requirementRefs: ['REQ-1'] }
  const sourceHash = canonicalSha256(sourceContent)
  const hash = canonicalSha256(content)
  const state = {
    projectVersions: [
      { id: 'pv-1', projectId: 'project-1', name: 'V1.0', status: 'open', inheritRequirementBindings: false, createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z' },
      { id: 'pv-2', projectId: 'project-1', name: 'V2.0', status: 'open', sourceProjectVersionId: 'pv-1', inheritRequirementBindings: true, createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z' },
    ],
    testDesignState: {
      architectureVersion: 'single-agent-skills/v1', designs: [],
      runs: [{ id: 'run-v2', projectVersionId: 'pv-2', historicalSnapshot: { items: [{ id: 'history-1', locator: { sourceProjectVersionId: 'pv-1', caseId: 'case-1', revision: 1 } }], sourceProjectVersionId: 'pv-1' }, caseChangeProposals: [{ operation: 'update', sourceCaseId: 'case-1', sourceRevision: 1, appliedCaseId: 'case-1', appliedRevision: 2 }], }],
      libraryCases: [{ id: 'case-1', projectId: 'project-1', currentRevision: 2, status: 'active', createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z', revisions: [{ revision: 1, content: sourceContent, contentSha256: sourceHash, semanticSha256: testCaseSemanticSha256(sourceContent), changeReason: 'V1', createdBy: 'owner', createdAt: '2026-08-22T00:00:00.000Z' }, { revision: 2, content, contentSha256: hash, semanticSha256: testCaseSemanticSha256(content), traceability, changeReason: 'V2', createdBy: 'owner', createdAt: '2026-08-22T00:00:00.000Z' }] }],
      libraryVersions: [
        { id: 'library-v1', projectId: 'project-1', projectVersionId: 'pv-1', version: 9, name: 'V1 Library', sourceRunId: 'run-v1', members: [{ caseId: 'case-1', revision: 1, ordinal: 0, contentSha256: sourceHash, frozenContent: sourceContent, executionReadiness: 'ready' }], contentSha256: canonicalSha256({ library: 1 }), publishedBy: 'owner', publishedAt: '2026-08-22T00:00:00.000Z', projection: { status: 'succeeded', files: [] } },
        { id: 'library-v2-old', projectId: 'project-1', projectVersionId: 'pv-2', version: 1, name: 'V2 Old', sourceRunId: 'run-v2', members: [], contentSha256: canonicalSha256({ library: 2 }), publishedBy: 'owner', publishedAt: '2026-08-22T01:00:00.000Z', projection: { status: 'succeeded', files: [] } },
        { id: 'library-v2-new', projectId: 'project-1', projectVersionId: 'pv-2', version: 2, name: 'V2 New', sourceRunId: 'run-v2', members: [{ caseId: 'case-1', revision: 2, ordinal: 0, contentSha256: hash, frozenContent: content, traceability, executionReadiness: 'ready' }], contentSha256: canonicalSha256({ library: 3 }), publishedBy: 'owner', publishedAt: '2026-08-22T02:00:00.000Z', projection: { status: 'succeeded', files: [] } },
      ], suiteDrafts: [], suiteVersions: [], executionHandoffs: [],
    },
  }
  const store = new JsonStore(null)
  await store.transaction(draft => { Object.assign(draft, state) })
  const result = await new TestDesignService(store).publishedTestCases('pv-2')
  assert.equal(result.libraryVersion?.id, 'library-v2-new')
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0]?.source, 'historical_modified')
  assert.equal(result.items[0]?.sourceTraceability?.sourceProjectVersionId, 'pv-1')
  assert.equal(result.statistics.historicalModified, 1)
})

test('测试用例 API 只接受 ProjectVersion 范围，并授权后调用正式读取服务', async () => {
  let requested = ''
  const response = { statusCode: 0, setHeader() {}, end() {} }
  const handled = await routeTestDesign({ headers: {} } as never, response as never, { method: 'GET', url: new URL('http://127.0.0.1/api/project-versions/pv-2/test-cases'), principal: { subjectId: 'reader', displayName: '读者' }, controls: { authorize: async (_principal: unknown, projectVersionId: string) => { requested = projectVersionId }, canAccess: async () => true }, service: { publishedTestCases: async () => ({ items: [] }) } as never, store: {} as never })
  assert.equal(handled, true)
  assert.equal(requested, 'pv-2')
})

test('测试用例页面位于测试策划和测试执行之间，并按版本重新读取正式 API', () => {
  const app = read('../src/App.tsx')
  const page = read('../src/test-cases/TestCasesPage.tsx')
  const api = read('../src/test-cases/api.ts')
  assert.match(app, /\{ key: 'planning', label: '测试策划'[\s\S]*?\{ key: 'test-cases', label: '测试用例'[\s\S]*?\{ key: 'execution', label: '测试执行'/u)
  assert.match(app, /\.\/test-cases\/TestCasesPage/u)
  assert.match(app, /page === 'test-cases'/u)
  assert.match(api, /project-versions\/\$\{encodeURIComponent\(projectVersionId\)\}\/test-cases/u)
  assert.match(page, /setFilters\(emptyFilters\);\s*setSelected\(null\)/u)
  for (const label of ['当前版本新增', '历史复用', '历史修改', '当前版本暂无已发布测试用例']) assert.match(page, new RegExp(label, 'u'))
})
