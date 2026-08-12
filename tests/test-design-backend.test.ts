import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { defaultAgentDefinitionConfigDictionary } from '../server/agent/agent-definition-config.js'
import { TEST_DESIGN_STAGE_BINDINGS } from '../server/agent/pi-test-design-runtime.js'
import { TestDesignService, type TestCaseAssetProjector, type TestDesignAgentRuntime } from '../server/application/test-design-service.js'
import { TestDesignError, validateCreateTestDesignInput, validateTestCaseDesignCandidate, validateTestPointDesignCandidate } from '../server/application/test-design-validation.js'
import type { TestDesignWorkflowRun } from '../server/domain/test-design-types.js'
import { JsonStore } from '../server/infrastructure/store.js'

const principal = { subjectId: 'tester', displayName: '测试负责人' }

test('创建协议删除旧依据模式并保留范围、维度与执行入口', () => {
  const value = validateCreateTestDesignInput({ name: '登录测试', objective: '验证登录风险', includedScopes: [{ kind: 'module', value: '登录' }], excludedScopes: [], focusDimensions: ['functional', 'security'], executionMethods: ['ui', 'api'], userCoverageObjectives: ['异常恢复'], knowledgeAugmentation: { mode: 'disabled' } })
  assert.deepEqual(value.executionMethods, ['ui', 'api'])
  assert.deepEqual(value.focusDimensions, ['functional', 'security'])
  assert.throws(() => validateCreateTestDesignInput({ name: '旧协议', objective: '必须删除旧协议', basisMode: 'review_baseline', sourceReviewRunId: 'review-1', knowledgeAugmentation: { mode: 'disabled' } }), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_DESIGN_INPUT_INVALID')
})

test('Stage、Skill 与 Submit Tool 映射固定且配置只包含 TestDesignAgent', () => {
  assert.deepEqual(TEST_DESIGN_STAGE_BINDINGS, {
    test_point_design: { skills: ['test-design-baseline', 'test-point-design'], submitToolId: 'test_design_points.submit_result', schemaVersion: 'test-point-design/v1' },
    test_case_design: { skills: ['test-case-design'], submitToolId: 'test_design_cases.submit_result', schemaVersion: 'test-case-design/v1' },
    test_design_repair: { skills: ['test-design-repair'], submitToolId: 'test_design_repair.submit_result', schemaVersion: 'test-design-repair/v1' },
  })
  assert.deepEqual(Object.keys(defaultAgentDefinitionConfigDictionary).filter(key => key.includes('test')), ['test-design'])
  assert.equal(defaultAgentDefinitionConfigDictionary['test-design'].agentType, 'test_design')
  assert.match(defaultAgentDefinitionConfigDictionary['test-design'].systemPrompt, /TestDesignAgent/u)
})

test('候选协议直接生成测试点和用例，不存在 coverageUnits 中间层', () => {
  const points = validateTestPointDesignCandidate({ schemaVersion: 'test-point-design/v1', nodes: [{ ref: 'login', title: '登录主流程', objective: '验证登录', dimension: 'functional', priority: 'P0', applicability: 'applicable', designTechniques: ['主流程'], entryMethods: ['ui'], oracle: '进入首页', dataConditions: ['有效账号'], risks: [], assumptions: [], basisRefs: ['requirement-1'], historicalRefs: [] }], findings: [], confirmationItems: [] })
  assert.equal(points.nodes[0].ref, 'login')
  assert.equal('coverageUnits' in points, false)
  const cases = validateTestCaseDesignCandidate(caseCandidate('test-case-design/v1', ['tp-1']), new Set(['tp-1']))
  assert.equal(cases.cases[0].content.testPointIds[0], 'tp-1')
  assert.equal(cases.dataRequirements.length, 0)
})

test('运行冻结当前绑定 Requirement Release 与 Workspace，后续发布不影响既有 Run', async () => {
  const { store, service } = await fixture(new FakeRuntime())
  const design = await service.createDesign('pv-1', createInput(), principal)
  const first = await service.createRun('pv-1', design.id, 'freeze-release-1', principal)
  assert.equal(first.basisSnapshot.requirementReleaseId, 'release-1')
  assert.equal(first.basisSnapshot.verificationRunId, 'review-1')
  assert.equal(first.workspaceSnapshot.requirementsJsonSha256, first.basisSnapshot.requirementsJsonSha256)
  await bindSecondRelease(store)
  const persisted = await service.getRun('pv-1', design.id, first.id)
  assert.equal(persisted.basisSnapshot.requirementReleaseId, 'release-1')
  assert.equal(persisted.workspaceSnapshot.requirementReleaseId, 'release-1')
  const second = await service.createRun('pv-1', design.id, 'freeze-release-2', principal)
  assert.equal(second.basisSnapshot.requirementReleaseId, 'release-2')
})

test('单 Agent 固定流程完成测试点人工批准、服务端审计、用例发布与正式资产投影', async () => {
  const runtime = new FakeRuntime()
  const projected: string[] = []
  const projector: TestCaseAssetProjector = { ingest: async input => { projected.push(input.logicalPath); return { version: { id: `asset-version-${projected.length}` }, task: { id: `task-${projected.length}` } } } }
  const { service } = await fixture(runtime, projector)
  const design = await service.createDesign('pv-1', createInput(), principal)
  const created = await service.createRun('pv-1', design.id, 'happy-path', principal)
  const review = await waitFor(service, design.id, created.id, run => run.stage === 'test_point_review')
  assert.deepEqual(runtime.stages, ['test_point_design'])
  assert.equal(review.nodeRuns.find(item => item.nodeKey === 'test_point_review')?.status, 'waiting_gate')
  const tree = await service.getTree('pv-1', design.id, created.id)
  await service.approveTree('pv-1', design.id, created.id, tree.etag, principal)
  const designed = await waitFor(service, design.id, created.id, run => run.status === 'succeeded' && run.testCases.length > 0)
  assert.deepEqual(runtime.stages, ['test_point_design', 'test_case_design'])
  assert.ok(projected.includes('workspace/branches/V1/test_design/test-point-tree.json'))
  assert.ok(projected.includes('workspace/branches/V1/test_design/test-design.md'))
  assert.equal(designed.coverageAudits.at(-1)?.blockers.every(item => item.resolution === 'human_review'), true)
  const targets = designed.testCases.map(item => ({ caseId: item.id, targetRevision: item.currentRevision }))
  await service.batchReview('pv-1', design.id, created.id, { targets, decision: 'submit' }, principal)
  await service.batchReview('pv-1', design.id, created.id, { targets, decision: 'approve' }, principal)
  const audit = await service.reAudit('pv-1', design.id, created.id)
  assert.deepEqual(audit.blockers, [])
  const published = await service.publishCaseSet('pv-1', design.id, created.id, { name: 'V1 正式用例', expectedAuditId: audit.id, expectedCaseSetSha256: audit.caseSetSha256 }, principal)
  assert.equal(published.version, 1)
  assert.equal(published.projection.files.length, 4)
  assert.ok(projected.includes('workspace/branches/V1/test_cases/test-cases.json'))
  assert.ok(projected.includes('workspace/branches/V1/test_cases/test-cases.md'))
  assert.ok(projected.includes('workspace/branches/V1/test_cases/test-data.json'))
  assert.ok(projected.includes('workspace/branches/V1/test_cases/manifest.json'))
})

test('Coverage Audit 仅将 agent_repair 问题送回同一 Agent，自动修复最多两轮', async () => {
  const runtime = new FakeRuntime({ uncoveredPoint: true, keepUncoveredDuringRepair: true })
  const { service } = await fixture(runtime, { ingest: async input => ({ version: { id: `asset-${sha256(input.logicalPath).slice(0, 8)}` }, task: null }) })
  const design = await service.createDesign('pv-1', createInput(), principal)
  const created = await service.createRun('pv-1', design.id, 'repair-limit', principal)
  await waitFor(service, design.id, created.id, run => run.stage === 'test_point_review')
  const tree = await service.getTree('pv-1', design.id, created.id)
  await service.approveTree('pv-1', design.id, created.id, tree.etag, principal)
  const completed = await waitFor(service, design.id, created.id, run => run.status === 'succeeded' && run.automaticRepair?.status === 'exhausted')
  assert.equal(runtime.stages.filter(stage => stage === 'test_design_repair').length, 2)
  assert.equal(completed.automaticRepair?.attempt, 2)
  assert.equal(completed.coverageAudits.at(-1)?.blockers.some(item => item.resolution === 'agent_repair'), true)
})

class FakeRuntime implements TestDesignAgentRuntime {
  stages: string[] = []
  constructor(private readonly behavior: { uncoveredPoint?: boolean; keepUncoveredDuringRepair?: boolean } = {}) {}
  readiness = async () => ({ ready: true, agents: [{ agentKey: 'test-design', ready: true }] })
  freezeConfiguration = async () => ({ configurationId: 'agent-config-1', configurationVersion: 1, configurationSha256: 'c'.repeat(64), agentDefinition: {} as never, routing: {} as never, primaryModel: { sourceId: 'source-1', modelId: 'model-1', modelName: '测试模型' }, createdAt: '2026-08-12T00:00:00.000Z', snapshotSha256: 'd'.repeat(64) })
  execute = async (input: { stage: 'test_point_design' | 'test_case_design' | 'test_design_repair'; run: TestDesignWorkflowRun }) => {
    this.stages.push(input.stage)
    if (input.stage === 'test_point_design') {
      const refs = input.run.basisSnapshot.items.map(item => item.id)
      const nodes = refs.map((basisRef, index) => ({ ref: `point-${index + 1}`, title: `需求 ${index + 1} 测试点`, objective: `验证需求 ${index + 1}`, dimension: 'functional', priority: 'P0', applicability: 'applicable', designTechniques: ['主流程'], entryMethods: ['ui'], oracle: '结果符合需求', dataConditions: [], risks: [], assumptions: [], basisRefs: [basisRef], historicalRefs: [] }))
      if (this.behavior.uncoveredPoint) nodes.push({ ...nodes[0], ref: 'point-extra', title: '额外风险测试点' })
      return { schemaVersion: 'test-point-design/v1', content: { schemaVersion: 'test-point-design/v1', nodes, findings: [], confirmationItems: [] } }
    }
    const pointIds = approvedPointIds(input.run)
    const covered = this.behavior.keepUncoveredDuringRepair ? pointIds.slice(0, 1) : pointIds
    return { schemaVersion: input.stage === 'test_design_repair' ? 'test-design-repair/v1' : 'test-case-design/v1', content: caseCandidate(input.stage === 'test_design_repair' ? 'test-design-repair/v1' : 'test-case-design/v1', covered) }
  }
}

async function fixture(runtime: TestDesignAgentRuntime, projector?: TestCaseAssetProjector) {
  const store = new JsonStore(null); await store.load()
  const release = releasePackage('release-1', 'review-1', ['REQ-1'])
  await store.transaction(state => {
    state.projects.push({ id: 'project-1', name: '测试项目', createdAt: '2026-08-12T00:00:00.000Z' })
    state.projectVersions.push({ id: 'pv-1', projectId: 'project-1', name: 'V1', status: 'open', requirementReleaseBinding: { releaseId: release.id, verificationRunId: 'review-1', requirementsJsonSha256: release.requirementsHash, boundAt: '2026-08-12T00:00:00.000Z' }, createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' })
    state.knowledgeBases.push({ id: 'kb-1', projectId: 'project-1', name: '项目知识库', createdAt: '2026-08-12T00:00:00.000Z', activeIndexVersionId: 'index-1', activeConfigVersionId: 'config-1' })
    state.indexes.push({ id: 'index-1', knowledgeBaseId: 'kb-1', number: 1, status: 'active', configVersionId: 'config-1', assetVersionIds: [], indexedChunks: [], createdAt: '2026-08-12T00:00:00.000Z' } as never)
    state.reviewRuns.push(release.review as never)
  })
  return { store, service: new TestDesignService(store, runtime, projector) }
}

async function bindSecondRelease(store: JsonStore) {
  const release = releasePackage('release-2', 'review-2', ['REQ-2'])
  await store.transaction(state => { state.reviewRuns.push(release.review as never); const version = state.projectVersions.find(item => item.id === 'pv-1')!; version.requirementReleaseBinding = { releaseId: release.id, verificationRunId: 'review-2', requirementsJsonSha256: release.requirementsHash, boundAt: '2026-08-12T01:00:00.000Z' } })
}

function releasePackage(releaseId: string, reviewId: string, requirementIds: string[]) {
  const requirements = `${JSON.stringify({ schemaVersion: 'requirements/v1', releaseId, projectVersionId: 'pv-1', verificationRunId: reviewId, sourceAssetVersions: [], requirements: requirementIds.map(id => ({ clientRequirementPointId: id, title: id, description: `需求 ${id}`, evidenceRefs: [] })) })}\n`
  const requirementsHash = sha256(requirements)
  const manifest = `${JSON.stringify({ schemaVersion: 'requirement-release-manifest/v1', releaseId, projectVersionId: 'pv-1', verificationRunId: reviewId, artifacts: [{ fileName: 'requirements.json', mediaType: 'application/json', contentSha256: requirementsHash }], machineReadableEntryPoints: { requirements: 'requirements.json' } })}\n`
  const release = { id: releaseId, schemaVersion: 'requirement-release-package/v1', status: 'published', projectVersionId: 'pv-1', verificationRunId: reviewId, sourceAssetVersionIds: [], artifacts: [{ fileName: 'requirements.json', mediaType: 'application/json', content: requirements, contentSha256: requirementsHash }, { fileName: 'manifest.json', mediaType: 'application/json', content: manifest, contentSha256: sha256(manifest) }], contentSha256: sha256(manifest), publishedAt: '2026-08-12T00:00:00.000Z' }
  return { id: releaseId, requirementsHash, review: { id: reviewId, projectVersionId: 'pv-1', status: 'succeeded', workflow: { release }, result: { requirementPoints: [] }, createdAt: '2026-08-12T00:00:00.000Z' } }
}

function createInput() { return { name: '认证测试设计', objective: '验证正式需求', includedScopes: [{ kind: 'module', value: '认证' }], excludedScopes: [], focusDimensions: ['functional'], executionMethods: ['ui'], userCoverageObjectives: [], knowledgeAugmentation: { mode: 'disabled' }, historicalCaseSelections: [] } }
function caseCandidate(schemaVersion: 'test-case-design/v1' | 'test-design-repair/v1', pointIds: string[]) { return { schemaVersion, cases: pointIds.map((pointId, index) => ({ ref: `case-${index + 1}`, schemaVersion: 'test-case/v1', title: `用例 ${index + 1}`, objective: `验证 ${pointId}`, dimension: 'functional', testPointIds: [pointId], priority: 'P0', preconditions: [], dataRequirementIds: [], cleanup: [], dependencies: [], executionMethods: [{ method: 'ui', uiSpec: { entry: '/login' }, steps: [{ key: 'step-1', action: '执行操作', expected: '结果符合需求' }], verificationChecks: [{ key: 'check-1', description: '页面结果正确' }], executionReadiness: 'ready', automationHint: '使用 UI 自动化' }], sharedVerificationChecks: [], tags: ['smoke'], domain: '认证' })), dataRequirements: [], findings: [], confirmationItems: [] } }
function approvedPointIds(run: TestDesignWorkflowRun) { const tree = run.testPointTree!; const version = tree.versions.find(item => item.id === tree.currentApprovedVersionId)!; const revision = tree.revisions.find(item => item.revision === version.revision)!; const parents = new Set(revision.nodes.flatMap(item => item.parentId ? [item.parentId] : [])); return revision.nodes.filter(item => !item.deleted && item.applicability !== 'not_applicable' && !parents.has(item.nodeId)).map(item => item.nodeId) }
async function waitFor(service: TestDesignService, designId: string, runId: string, predicate: (run: TestDesignWorkflowRun) => boolean) { for (let attempt = 0; attempt < 200; attempt += 1) { const value = await service.getRun('pv-1', designId, runId) as TestDesignWorkflowRun; if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 5)) } throw new Error('等待测试设计状态超时') }
function sha256(value: string) { return createHash('sha256').update(value).digest('hex') }
