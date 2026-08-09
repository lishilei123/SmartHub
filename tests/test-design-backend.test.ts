import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalJson, canonicalSha256 } from '../server/application/canonical-json.js'
import { TestDesignService, type TestDesignAgentRuntime } from '../server/application/test-design-service.js'
import { TestDesignError, validateCreateTestDesignInput, validateDesignCandidateNodes, validateTestCaseContent } from '../server/application/test-design-validation.js'
import type { TestCaseContent, TestPointNodeRevision } from '../server/domain/test-design-types.js'
import { JsonStore } from '../server/infrastructure/store.js'

const principal = { subjectId: 'tester-1', displayName: '测试负责人' }

test('canonical JSON 固定对象键顺序并拒绝不确定值', () => {
  assert.equal(canonicalJson({ z: 1, a: ['x', true] }), '{"a":["x",true],"z":1}')
  assert.equal(canonicalSha256({ a: 1, b: 2 }), canonicalSha256({ b: 2, a: 1 }))
  assert.throws(() => canonicalJson({ invalid: undefined }), /CANONICAL_JSON_UNDEFINED/u)
  assert.throws(() => canonicalJson(Number.NaN), /CANONICAL_JSON_NON_FINITE_NUMBER/u)
})

test('测试设计创建判别联合拒绝错分支字段和 latest 引用', () => {
  assert.throws(() => validateCreateTestDesignInput({ name: '登录', objective: '验证登录', basisMode: 'knowledge_assets', knowledgeAssetVersionIds: ['asset-v1'], sourceReviewRunId: '', knowledgeAugmentation: { mode: 'disabled' } }), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_DESIGN_BASIS_MODE_INVALID')
  assert.throws(() => validateCreateTestDesignInput({ name: '登录', objective: '验证登录', basisMode: 'knowledge_assets', knowledgeAssetVersionIds: ['latest'], knowledgeAugmentation: { mode: 'disabled' } }), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_DESIGN_LATEST_REFERENCE_FORBIDDEN')
})

test('测试点候选在进入树归并前校验临时引用和分支维度', () => {
  const missingRef = { nodes: [{ ...node('ignored', 'functional', []), ref: undefined }] }
  assert.throws(() => validateDesignCandidateNodes(missingRef, 'functional'), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_POINT_TREE_SCHEMA_INVALID' && error.message.includes('functional.nodes[0].ref'))
  assert.throws(() => validateDesignCandidateNodes({ nodes: [node('security-1', 'security', [])] }, 'functional'), (error: unknown) => error instanceof TestDesignError && error.message.includes('functional.nodes[0].dimension'))
  assert.equal(validateDesignCandidateNodes({ nodes: [node('root', 'functional', [])] }, 'functional')[0].ref, 'root')
})

test('test-case/v1 强制 UI/API 判别联合、稳定步骤和非空方式', () => {
  assert.throws(() => validateTestCaseContent({ ...caseContent(['point-1']), executionMethods: [] }, new Set(['point-1'])), /executionMethods/u)
  assert.throws(() => validateTestCaseContent({ ...caseContent(['point-1']), executionMethods: [{ method: 'ui', uiSpec: { entry: '/login' }, apiSpec: { method: 'POST', path: '/login' }, steps: [{ key: 's1', action: '输入', expected: '已输入' }], verificationChecks: [], executionReadiness: 'ready', automationHint: '' }] }, new Set(['point-1'])), /不允许的字段/u)
})

test('测试设计候选接口返回真实资产版本和内容 Hash', async () => {
  const service = new TestDesignService(await seededStore(), new FakeRuntime())
  const candidates = await service.inputCandidates('pv-1')
  assert.equal(candidates.knowledgeAssets[0].assetVersionId, 'asset-version-1')
  assert.equal(candidates.knowledgeAssets[0].version, 1)
  assert.match(candidates.knowledgeAssets[0].contentHash, /^[a-f0-9]{64}$/u)
})

test('测试设计后端完成固定快照、双门禁、并行设计、用例审核、审计和不可变发布', async () => {
  const store = await seededStore()
  const runtime = new FakeRuntime()
  const service = new TestDesignService(store, runtime)
  const design = await service.createDesign('pv-1', {
    name: '认证测试设计', objective: '验证登录与账号保护', basisMode: 'knowledge_assets', knowledgeAssetVersionIds: ['asset-version-1'],
    knowledgeAugmentation: { mode: 'disabled' }, historicalCaseSelections: [],
  }, principal)
  const run = await service.createRun('pv-1', design.id, 'create-run-1', principal)
  const scopeWaiting = await waitFor(service, design.id, run.id, value => value.stage === 'scope_gate')
  assert.equal(scopeWaiting.basisSnapshot.items[0].sourceId, 'asset-version-1')
  assert.equal(scopeWaiting.retrievalSnapshot.mode, 'disabled')
  assert.match(scopeWaiting.basisSnapshot.snapshotSha256, /^[a-f0-9]{64}$/u)
  const analysisArtifact = scopeWaiting.artifacts.find(item => item.nodeKey === 'test_analysis')!
  await service.applyGateDecision('pv-1', design.id, run.id, 'scope', { targetId: analysisArtifact.id, targetRevision: analysisArtifact.generation, expectedVersion: 0, decision: 'approved' }, principal)
  const treeWaiting = await waitFor(service, design.id, run.id, value => value.stage === 'tree_gate')
  assert.equal(treeWaiting.testPointTree?.revisions[0].nodes.length, 2)
  assert.deepEqual(new Set(runtime.stages.slice(1, 3)), new Set(['functional_design', 'non_functional_design']))
  const tree = treeWaiting.testPointTree!
  await service.applyGateDecision('pv-1', design.id, run.id, 'test-point-tree', { targetId: tree.id, targetRevision: tree.currentRevision, expectedVersion: 0, decision: 'approved' }, principal)
  const completed = await waitFor(service, design.id, run.id, value => value.status === 'succeeded')
  assert.equal(completed.testCases.length, 2)
  assert.equal(completed.nodeRuns.find(item => item.nodeKey === 'test_analysis')?.execution?.modelLabel, 'fake-model')
  assert.equal(completed.nodeRuns.find(item => item.nodeKey === 'functional_design')?.execution?.degraded, false)
  assert.ok(completed.coverageAudits.at(-1)!.blockers.some(item => item.code === 'TEST_CASE_REVIEW_REQUIRED'))

  for (const testCase of completed.testCases) {
    await service.reviewCase('pv-1', design.id, run.id, testCase.id, { decision: 'submit', targetRevision: 0 }, principal)
    await service.reviewCase('pv-1', design.id, run.id, testCase.id, { decision: 'approve', targetRevision: 0 }, principal)
  }
  const audit = await service.reAudit('pv-1', design.id, run.id)
  assert.deepEqual(audit.blockers, [])
  assert.equal(audit.statistics.coveredPoints, 2)
  const published = await service.publishCaseSet('pv-1', design.id, run.id, { name: '认证新功能用例集', expectedAuditId: audit.id, expectedCaseSetSha256: audit.caseSetSha256 }, principal)
  const repeated = await service.publishCaseSet('pv-1', design.id, run.id, { name: '认证新功能用例集', expectedAuditId: audit.id, expectedCaseSetSha256: audit.caseSetSha256 }, principal)
  assert.equal(repeated.id, published.id)
  assert.equal(published.members.length, 2)
  const jsonExport = await service.exportCaseSet(published.id, 'json')
  const xlsxExport = await service.exportCaseSet(published.id, 'xlsx')
  assert.match(String(jsonExport.content), /test-case-set\/v1/u)
  assert.ok(Buffer.isBuffer(xlsxExport.content) && xlsxExport.content.subarray(0, 2).toString() === 'PK')
  const catalog = await service.projectCatalog('project-1')
  assert.equal(catalog.items.length, 2)
})

test('树和用例编辑要求当前 ETag，编辑后旧审计失效', async () => {
  const store = await seededStore()
  const service = new TestDesignService(store, new FakeRuntime())
  const design = await service.createDesign('pv-1', { name: '并发测试', objective: '验证并发编辑', basisMode: 'knowledge_assets', knowledgeAssetVersionIds: ['asset-version-1'], knowledgeAugmentation: { mode: 'disabled' } }, principal)
  const run = await service.createRun('pv-1', design.id, 'etag-run', principal)
  const scope = await waitFor(service, design.id, run.id, value => value.stage === 'scope_gate'); const artifact = scope.artifacts.find(item => item.nodeKey === 'test_analysis')!
  await service.applyGateDecision('pv-1', design.id, run.id, 'scope', { targetId: artifact.id, targetRevision: artifact.generation, expectedVersion: 0, decision: 'approved' }, principal)
  const waiting = await waitFor(service, design.id, run.id, value => value.stage === 'tree_gate')
  const currentTree = await service.getTree('pv-1', design.id, run.id)
  await assert.rejects(() => service.patchTree('pv-1', design.id, run.id, '"stale"', { operations: [{ op: 'rename', nodeId: currentTree.revision.nodes[0].nodeId, title: '新标题' }], reason: '修正名称' }, principal), (error: unknown) => error instanceof TestDesignError && error.status === 412)
  const patched = await service.patchTree('pv-1', design.id, run.id, currentTree.etag, { operations: [{ op: 'rename', nodeId: currentTree.revision.nodes[0].nodeId, title: '登录正常路径' }], reason: '修正名称' }, principal)
  assert.equal(patched.revision.revision, 1)
  assert.notEqual(patched.etag, currentTree.etag)
  assert.equal(waiting.testPointTree?.currentRevision, 0)
})

test('并行设计单节点失败后只重跑失败节点', async () => {
  const store = await seededStore(); const runtime = new FailOnceRuntime(); const service = new TestDesignService(store, runtime)
  const design = await service.createDesign('pv-1', { name: '节点恢复', objective: '验证节点级恢复', basisMode: 'knowledge_assets', knowledgeAssetVersionIds: ['asset-version-1'], knowledgeAugmentation: { mode: 'disabled' } }, principal)
  const run = await service.createRun('pv-1', design.id, 'node-retry', principal)
  const scope = await waitFor(service, design.id, run.id, value => value.stage === 'scope_gate'); const analysis = scope.artifacts.find(item => item.nodeKey === 'test_analysis')!
  await service.applyGateDecision('pv-1', design.id, run.id, 'scope', { targetId: analysis.id, targetRevision: analysis.generation, expectedVersion: 0, decision: 'approved' }, principal)
  const failed = await waitFor(service, design.id, run.id, value => value.status === 'failed')
  assert.equal(failed.nodeRuns.find(item => item.nodeKey === 'functional_design')?.status, 'succeeded')
  assert.equal(failed.nodeRuns.find(item => item.nodeKey === 'non_functional_design')?.status, 'failed')
  assert.equal(failed.nodeRuns.find(item => item.nodeKey === 'non_functional_design')?.execution?.modelLabel, 'failed-model')
  await service.retryDesignNode('pv-1', design.id, run.id, 'non_functional_design')
  await waitFor(service, design.id, run.id, value => value.stage === 'tree_gate')
  assert.equal(runtime.stages.filter(stage => stage === 'functional_design').length, 1)
  assert.equal(runtime.stages.filter(stage => stage === 'non_functional_design').length, 2)
})

class FakeRuntime implements TestDesignAgentRuntime {
  readonly stages: string[] = []
  async readiness() { return { ready: true, agents: [] } }
  async execute(input: Parameters<TestDesignAgentRuntime['execute']>[0]) {
    this.stages.push(input.stage)
    const basisRefs = input.run.basisSnapshot.items.map(item => item.id)
    const execution = { agentKey: input.stage === 'test_analysis' ? 'test-analysis' : input.stage === 'functional_design' ? 'functional-test-design' : input.stage === 'non_functional_design' ? 'non-functional-test-design' : 'test-case-synthesis', agentVersion: 'test-v1', modelLabel: 'fake-model', degraded: false, turns: 1, toolCalls: 0, events: [], framework: { name: 'pi-agent-core' as const, version: 'test' } }
    if (input.stage === 'test_analysis') return { schemaVersion: 'test-analysis/v1', content: { schemaVersion: 'test-analysis/v1', scope: '认证', findings: [], confirmationItems: [] }, execution }
    if (input.stage === 'functional_design') return { schemaVersion: 'functional-test-design/v1', content: { schemaVersion: 'functional-test-design/v1', nodes: [node('shared-root', 'functional', basisRefs)] }, execution }
    if (input.stage === 'non_functional_design') return { schemaVersion: 'non-functional-test-design/v1', content: { schemaVersion: 'non-functional-test-design/v1', nodes: [node('shared-root', 'security', basisRefs)] }, execution }
    const upstream = input.upstream as { treeRevision: { nodes: TestPointNodeRevision[] } }
    return { schemaVersion: 'test-case-synthesis/v1', content: { schemaVersion: 'test-case-synthesis/v1', cases: upstream.treeRevision.nodes.map(point => caseContent([point.nodeId])), dataRequirements: [] }, execution }
  }
}

class FailOnceRuntime extends FakeRuntime {
  private failed = false
  override async execute(input: Parameters<TestDesignAgentRuntime['execute']>[0]) {
    if (input.stage === 'non_functional_design' && !this.failed) {
      this.failed = true
      this.stages.push(input.stage)
      const error = new Error('MODEL_PROVIDER_UNAVAILABLE: transient') as Error & { execution?: NonNullable<Awaited<ReturnType<FakeRuntime['execute']>>['execution']> }
      error.execution = { agentKey: 'non-functional-test-design', agentVersion: 'test-v1', modelLabel: 'failed-model', degraded: false, turns: 2, toolCalls: 1, toolErrors: 1, events: [], framework: { name: 'pi-agent-core', version: 'test' } }
      throw error
    }
    return super.execute(input)
  }
}

function node(ref: string, dimension: TestPointNodeRevision['dimension'], basisRefs: string[]) {
  return { ref, title: `${dimension} 测试点`, objective: '验证认证行为', dimension, priority: 'P1', applicability: 'applicable', designTechniques: ['场景法'], entryMethods: ['api'], oracle: '响应与状态一致', dataConditions: [], risks: [], assumptions: [], basisRefs, historicalRefs: [] }
}

function caseContent(testPointIds: string[]): TestCaseContent {
  return { schemaVersion: 'test-case/v1', title: `验证 ${testPointIds[0]}`, objective: '验证认证行为', dimension: 'functional', testPointIds, priority: 'P1', preconditions: [], dataRequirementIds: [], cleanup: [], dependencies: [], executionMethods: [{ method: 'api', apiSpec: { method: 'POST', path: '/api/login' }, steps: [{ key: 'step-1', action: '提交登录请求', expected: '返回明确结果' }], verificationChecks: [{ key: 'check-1', description: '响应结构正确' }], executionReadiness: 'ready', automationHint: '接口自动化' }], sharedVerificationChecks: [], tags: ['认证'], domain: '身份认证' }
}

async function seededStore() {
  const store = new JsonStore(null); await store.load(); const createdAt = new Date().toISOString(); const content = '# 登录需求\n\n用户可以使用账号密码登录。'
  await store.transaction(state => {
    state.projects.push({ id: 'project-1', name: 'SmartHub', createdAt })
    state.projectVersions.push({ id: 'pv-1', projectId: 'project-1', name: 'V4.0', status: 'open', createdAt, updatedAt: createdAt })
    state.knowledgeBases.push({ id: 'kb-1', projectId: 'project-1', name: '项目知识库', activeIndexVersionId: 'index-1', activeConfigVersionId: null, createdAt })
    state.assets.push({ id: 'asset-1', knowledgeBaseId: 'kb-1', directoryId: null, displayName: '登录需求', logicalPath: 'requirements/login.md', assetType: 'requirement', sourceType: 'upload', activeVersionId: 'asset-version-1', syncStatus: 'ready', createdAt, updatedAt: createdAt })
    state.versions.push({ id: 'asset-version-1', assetId: 'asset-1', number: 1, status: 'ready', content, contentHash: canonicalSha256(content), configVersionId: 'config-1', chunks: [], createdAt, readyAt: createdAt })
    state.indexes.push({ id: 'index-1', knowledgeBaseId: 'kb-1', version: 1, status: 'active', configVersionId: 'config-1', assetVersionIds: ['asset-version-1'], createdAt, activatedAt: createdAt, indexedChunks: [] })
  })
  return store
}

async function waitFor(service: TestDesignService, designId: string, runId: string, predicate: (run: Awaited<ReturnType<TestDesignService['getRun']>>) => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) { const run = await service.getRun('pv-1', designId, runId); if (predicate(run)) return run; await new Promise(resolve => setTimeout(resolve, 5)) }
  throw new Error('等待测试设计运行超时')
}
