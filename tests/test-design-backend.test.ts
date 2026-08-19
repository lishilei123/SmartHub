import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { defaultAgentDefinitionConfigDictionary } from '../server/agent/agent-definition-config.js'
import { TEST_DESIGN_STAGE_BINDINGS } from '../server/agent/pi-test-design-runtime.js'
import { TestDesignService, type PlanningAgentRuntime, type TestCaseAssetProjector } from '../server/application/test-design-service.js'
import { TestDesignError, validateCreateTestDesignInput, validateTestCaseDesignCandidate, validateTestPointDesignCandidate } from '../server/application/test-design-validation.js'
import type { TestCaseContent, TestDesignWorkflowRun } from '../server/domain/test-design-types.js'
import { JsonStore } from '../server/infrastructure/store.js'

const principal = { subjectId: 'tester', displayName: '测试负责人' }

test('创建协议删除旧依据模式并保留范围、维度与执行入口', () => {
  const value = validateCreateTestDesignInput({ name: '登录测试', objective: '验证登录风险', includedScopes: [{ kind: 'module', value: '登录' }], excludedScopes: [], focusDimensions: ['functional', 'security'], executionMethods: ['ui', 'api'], userCoverageObjectives: ['异常恢复'], knowledgeAugmentation: { mode: 'disabled' } })
  assert.deepEqual(value.executionMethods, ['ui', 'api'])
  assert.deepEqual(value.focusDimensions, ['functional', 'security'])
  assert.throws(() => validateCreateTestDesignInput({ name: '旧协议', objective: '必须删除旧协议', basisMode: 'review_baseline', sourceReviewRunId: 'review-1', knowledgeAugmentation: { mode: 'disabled' } }), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_DESIGN_INPUT_INVALID')
})

test('PlanningAgent 测试设计动作只绑定本轮 Submit Tool，Skill 保持配置驱动', () => {
  assert.deepEqual(TEST_DESIGN_STAGE_BINDINGS, {
    test_point_design: { submitToolId: 'test_design_points.submit_result', schemaVersion: 'test-point-design/v1' },
    test_case_design: { submitToolId: 'test_design_cases.submit_result', schemaVersion: 'test-case-design/v1' },
    test_design_repair: { submitToolId: 'test_design_repair.submit_result', schemaVersion: 'test-design-repair/v1' },
  })
  assert.deepEqual(Object.keys(defaultAgentDefinitionConfigDictionary), [
    'planning',
    'test-script',
    'failure-analysis',
    'script-repair',
  ])
  assert.equal(defaultAgentDefinitionConfigDictionary.planning.agentType, 'planning')
  assert.ok(defaultAgentDefinitionConfigDictionary.planning.skills.some(skill => skill.skillKey === 'test-case-design' && skill.enabled))
  assert.equal(defaultAgentDefinitionConfigDictionary['test-script'].agentType, 'test_script')
  assert.equal(defaultAgentDefinitionConfigDictionary['failure-analysis'].agentType, 'failure_analysis')
  assert.equal(defaultAgentDefinitionConfigDictionary['script-repair'].agentType, 'script_repair')
  assert.match(defaultAgentDefinitionConfigDictionary.planning.systemPrompt, /连续对话/u)
})

test('候选协议直接生成测试点和用例，不存在 coverageUnits 中间层', () => {
  const points = validateTestPointDesignCandidate({ schemaVersion: 'test-point-design/v1', nodes: [{ ref: 'login', title: '登录主流程', objective: '验证登录', dimension: 'functional', priority: 'P0', applicability: 'applicable', designTechniques: ['主流程'], entryMethods: ['ui'], oracle: '进入首页', dataConditions: ['有效账号'], risks: [], assumptions: [], basisRefs: ['requirement-1'], historicalRefs: [] }], findings: [], confirmationItems: [] })
  assert.equal(points.nodes[0].ref, 'login')
  assert.equal('coverageUnits' in points, false)
  const cases = validateTestCaseDesignCandidate(caseCandidate('test-case-design/v1', ['tp-1']), new Set(['tp-1']))
  assert.equal(cases.cases[0].content.testPointIds[0], 'tp-1')
  assert.equal(cases.dataRequirements.length, 0)
  const flatCandidate = caseCandidate('test-case-design/v1', ['tp-1'])
  const wrappedCandidate = {
    ...flatCandidate,
    cases: flatCandidate.cases.map(({ ref, ...content }) => ({ ref, content })),
  }
  assert.throws(
    () => validateTestCaseDesignCandidate(wrappedCandidate, new Set(['tp-1'])),
    (error: unknown) => error instanceof TestDesignError
      && /\/cases\/0/u.test(error.message)
      && /content/u.test(error.message)
      && /直接展开/u.test(error.message),
  )
})

test('测试点候选的发布 Requirement Point ID 由 Service 解析为当前冻结 basis ID', async () => {
  const projector: TestCaseAssetProjector = { ingest: async input => ({ version: { id: `asset-${sha256(input.logicalPath).slice(0, 8)}` }, task: null }) }
  const { service } = await fixture(new FakeRuntime({ pointBasisRefMode: 'published_requirement_id' }), projector)
  const design = await service.createDesign('pv-1', createInput(), principal)
  const created = await service.createRun('pv-1', design.id, 'published-requirement-id', principal)
  const completed = await waitFor(service, design.id, created.id, run => run.status === 'succeeded' && Boolean(run.testPointTree?.currentApprovedVersionId))
  const nodes = completed.testPointTree!.revisions.find(item => item.revision === completed.testPointTree!.currentRevision)!.nodes
  assert.deepEqual(nodes.map(node => node.basisRefs), [['basis_requirement_review-1_REQ-1']])
})

test('测试点候选的未知 Requirement Point ID 仍被拒绝', async () => {
  const { service } = await fixture(new FakeRuntime({ pointBasisRefMode: 'outside' }))
  const design = await service.createDesign('pv-1', createInput(), principal)
  const created = await service.createRun('pv-1', design.id, 'outside-requirement-id', principal)
  const failed = await waitFor(service, design.id, created.id, run => run.status === 'failed')
  assert.equal(failed.errorCode, 'TEST_POINT_BASIS_REFERENCE_INVALID')
})

test('同一 ProjectVersion 保留多个 Requirement Release，测试设计冻结明确选择的 Release', async () => {
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
  const bindings = (await store.snapshot()).projectVersions.find(item => item.id === 'pv-1')!.requirementReleaseBindings!
  assert.deepEqual(bindings.map(item => item.releaseId), ['release-1', 'release-2'])
  const preservedDesignRun = await service.createRun('pv-1', design.id, 'freeze-release-1-again', principal)
  assert.equal(preservedDesignRun.basisSnapshot.requirementReleaseId, 'release-1')
  const secondDesign = await service.createDesign('pv-1', { ...createInput(), requirementReleaseId: 'release-2' }, principal)
  const second = await service.createRun('pv-1', secondDesign.id, 'freeze-release-2', principal)
  assert.equal(second.basisSnapshot.requirementReleaseId, 'release-2')
})

test('未完成需求分析并绑定 Requirement Release 时拒绝创建测试设计', async () => {
  const { store, service } = await fixture(new FakeRuntime())
  await store.transaction(state => {
    delete state.projectVersions.find(item => item.id === 'pv-1')!.requirementReleaseBinding
    state.reviewRuns = []
  })

  await assert.rejects(
    () => service.createDesign('pv-1', createInput(), principal),
    (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_DESIGN_REQUIREMENT_RELEASE_NOT_BOUND',
  )
  assert.equal((await store.snapshot()).testDesignState?.designs.length ?? 0, 0)
})

test('单 PlanningAgent 自动固化测试点、连续生成及重新生成用例，并完成正式资产投影', async () => {
  const runtime = new FakeRuntime()
  const projected: string[] = []
  const projector: TestCaseAssetProjector = { ingest: async input => { projected.push(input.logicalPath); return { version: { id: `asset-version-${projected.length}` }, task: { id: `task-${projected.length}` } } } }
  const { service } = await fixture(runtime, projector)
  const design = await service.createDesign('pv-1', createInput(), principal)
  const created = await service.createRun('pv-1', design.id, 'happy-path', principal)
  let designed = await waitFor(service, design.id, created.id, run => run.status === 'succeeded' && run.testCases.length > 0)
  assert.deepEqual(runtime.stages, ['test_point_design', 'test_case_design'])
  assert.equal(designed.nodeRuns.find(item => item.nodeKey === 'test_point_review')?.status, 'succeeded')
  const approvedVersionId = designed.testPointTree?.currentApprovedVersionId
  await service.resynthesize('pv-1', design.id, created.id)
  designed = await waitFor(service, design.id, created.id, run => run.status === 'succeeded' && run.testCases.length > 0 && runtime.stages.filter(stage => stage === 'test_case_design').length === 2)
  assert.equal(designed.testPointTree?.currentApprovedVersionId, approvedVersionId)
  assert.deepEqual(runtime.stages, ['test_point_design', 'test_case_design', 'test_case_design'])
  assert.equal(runtime.tasks.at(-1)?.taskType, 'test_case_resynthesize')
  assert.match(runtime.tasks.at(-1)?.task ?? '', /已批准 TestPointTreeVersion.*保持不变/u)
  assert.ok(projected.includes('workspace/branches/V1/test-design/test-point-tree.json'))
  assert.ok(projected.includes('workspace/branches/V1/test-design/test-design.md'))
  assert.equal(designed.coverageAudits.at(-1)?.blockers.every(item => item.resolution === 'human_review'), true)
  const targets = designed.testCases.map(item => ({ caseId: item.id, targetRevision: item.currentRevision }))
  await service.batchReview('pv-1', design.id, created.id, { targets, decision: 'submit' }, principal)
  await service.batchReview('pv-1', design.id, created.id, { targets, decision: 'approve' }, principal)
  const audit = await service.reAudit('pv-1', design.id, created.id)
  assert.deepEqual(audit.blockers, [])
  const published = await service.publishCaseSet('pv-1', design.id, created.id, { name: 'V1 正式用例', expectedAuditId: audit.id, expectedCaseSetSha256: audit.caseSetSha256 }, principal)
  assert.equal(published.version, 1)
  assert.equal(published.projection.files.length, 4)
  assert.ok(projected.includes('workspace/branches/V1/test-cases/test-cases.json'))
  assert.ok(projected.includes('workspace/branches/V1/test-cases/test-cases.md'))
  assert.ok(projected.includes('workspace/branches/V1/test-cases/test-data.json'))
  assert.ok(projected.includes('workspace/branches/V1/test-cases/manifest.json'))
})

test('Coverage Audit 仅将 agent_repair 问题送回同一 PlanningAgent，自动修复受次数上限控制', async () => {
  const runtime = new FakeRuntime({ uncoveredPoint: true, keepUncoveredDuringRepair: true })
  const { service } = await fixture(runtime, { ingest: async input => ({ version: { id: `asset-${sha256(input.logicalPath).slice(0, 8)}` }, task: null }) })
  const design = await service.createDesign('pv-1', createInput(), principal)
  const created = await service.createRun('pv-1', design.id, 'repair-limit', principal)
  const completed = await waitFor(service, design.id, created.id, run => run.status === 'succeeded' && run.automaticRepair?.status === 'exhausted')
  assert.equal(runtime.stages.filter(stage => stage === 'test_design_repair').length, 1)
  assert.equal(completed.automaticRepair?.attempt, 1)
  assert.equal(completed.coverageAudits.at(-1)?.blockers.some(item => item.resolution === 'agent_repair'), true)
})

test('正式用例库 Proposal、Revision、不可变版本、套件与 Full Handoff 形成完整闭环', async () => {
  const projected: string[] = []
  const projector: TestCaseAssetProjector = { ingest: async input => { projected.push(input.logicalPath); return { version: { id: `library-asset-${projected.length}` }, task: null } } }
  const initialRuntime = new FakeRuntime()
  const { store, service: initialService } = await fixture(initialRuntime, projector)
  const initial = await preparePublishableRun(initialService, 'initial-library')

  await assert.rejects(
    initialService.publishLibraryVersion('pv-1', initial.designId, initial.runId, { name: '不应发布', expectedAuditId: initial.audit.id, expectedCaseSetSha256: initial.audit.caseSetSha256, expectedProposalSha256: initial.run.caseChangeProposalSha256 }, principal),
    (error: unknown) => error instanceof TestDesignError && error.code === 'CASE_CHANGE_PROPOSAL_DECISION_REQUIRED',
  )
  for (const proposal of initial.run.caseChangeProposals) await initialService.decideCaseChangeProposal('pv-1', initial.designId, initial.runId, proposal.id, { expectedVersion: 0, decision: 'accepted' }, principal)
  const initialDecided = await initialService.getRun('pv-1', initial.designId, initial.runId)
  const v1 = await initialService.publishLibraryVersion('pv-1', initial.designId, initial.runId, { name: '正式用例库 V1', expectedAuditId: initial.audit.id, expectedCaseSetSha256: initial.audit.caseSetSha256, expectedProposalSha256: initialDecided.caseChangeProposalSha256 }, principal)
  assert.equal(v1.members.length, 1, 'create 只创建一个新正式 Case ID')
  const stableCaseId = v1.members[0].caseId
  assert.match(stableCaseId, /^library_test_case_/u)

  const updateService = new TestDesignService(store, new FakeRuntime({ proposalOperation: 'update' }), projector)
  const update = await preparePublishableRun(updateService, 'update-library')
  for (const proposal of update.run.caseChangeProposals) await updateService.decideCaseChangeProposal('pv-1', update.designId, update.runId, proposal.id, { expectedVersion: 0, decision: 'accepted' }, principal)
  const updateDecided = await updateService.getRun('pv-1', update.designId, update.runId)
  const v2 = await updateService.publishLibraryVersion('pv-1', update.designId, update.runId, { name: '正式用例库 V2', expectedAuditId: update.audit.id, expectedCaseSetSha256: update.audit.caseSetSha256, expectedProposalSha256: updateDecided.caseChangeProposalSha256 }, principal)
  assert.equal(v2.members[0].caseId, stableCaseId, 'update 保持正式 Case ID')
  assert.equal(v2.members[0].revision, 2, 'update 创建新 Revision')
  const updatedCase = await updateService.getLibraryCase('project-1', stableCaseId)
  const updatedTraceability = updatedCase.revisions.find(item => item.revision === 2)!.traceability!
  assert.equal(updatedTraceability.sourceRequirementReleaseId, 'release-1')
  assert.deepEqual(updatedTraceability.requirementRefs.map(item => item.requirementId), ['REQ-1'])
  assert.deepEqual(updatedTraceability.testPointRefs.map(item => item.testPointTreeVersionId), [update.run.testPointTree!.currentApprovedVersionId])

  const reuseService = new TestDesignService(store, new FakeRuntime({ proposalOperation: 'reuse' }), projector)
  const reuse = await preparePublishableRun(reuseService, 'reuse-library')
  for (const proposal of reuse.run.caseChangeProposals) await reuseService.decideCaseChangeProposal('pv-1', reuse.designId, reuse.runId, proposal.id, { expectedVersion: 0, decision: 'accepted' }, principal)
  const reuseDecided = await reuseService.getRun('pv-1', reuse.designId, reuse.runId)
  const v3 = await reuseService.publishLibraryVersion('pv-1', reuse.designId, reuse.runId, { name: '正式用例库 V3', expectedAuditId: reuse.audit.id, expectedCaseSetSha256: reuse.audit.caseSetSha256, expectedProposalSha256: reuseDecided.caseChangeProposalSha256 }, principal)
  assert.deepEqual(v3.members.map(item => [item.caseId, item.revision]), [[stableCaseId, 2]], 'reuse 不复制正式用例或 Revision')
  assert.equal((await reuseService.listLibraryCases('project-1')).length, 1)

  const detachedVersion = await reuseService.getLibraryVersion('project-1', v3.id); detachedVersion.members.length = 0
  assert.equal((await reuseService.getLibraryVersion('project-1', v3.id)).members.length, 1, '已发布用例库版本返回不可变快照')

  const detail = await reuseService.getLibraryCase('project-1', stableCaseId)
  const suiteValues = (suiteKey: string, suiteType: 'smoke' | 'regression' | 'custom') => ({ suiteKey, suiteType, name: `${suiteType} 套件`, testCaseLibraryVersionId: v3.id, members: [{ caseId: stableCaseId, executionMethod: 'ui' as const, reason: '稳定执行基线' }] })
  await assert.rejects(reuseService.createSuiteDraft('project-1', { ...suiteValues('mixed-library', 'smoke'), members: [{ testCaseLibraryVersionId: v1.id, caseId: stableCaseId, executionMethod: 'ui', reason: '非法混用' }] }, principal), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_SUITE_LIBRARY_VERSION_MISMATCH')
  const publishedSuites = []
  for (const suiteType of ['smoke', 'regression', 'custom'] as const) {
    const draft = await reuseService.createSuiteDraft('project-1', suiteValues(`${suiteType}-baseline`, suiteType), principal)
    const suite = await reuseService.publishSuiteDraft('project-1', draft.id, draft.etag, principal); publishedSuites.push(suite)
    await assert.rejects(reuseService.updateSuiteDraft('project-1', draft.id, (await reuseService.getSuiteDraft('project-1', draft.id)).etag, suiteValues(`${suiteType}-changed`, suiteType), principal), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_SUITE_DRAFT_IMMUTABLE')
    const detachedSuite = await reuseService.getSuite('project-1', suite.id); detachedSuite.members.length = 0
    assert.equal((await reuseService.getSuite('project-1', suite.id)).members.length, 1, `${suiteType} 套件版本不可变`)
  }
  assert.equal(publishedSuites.length, 3)

  const full = await reuseService.createLibraryHandoff('pv-1', v3.id, { mode: 'full', expectedLibrarySha256: v3.contentSha256 }, principal)
  assert.deepEqual(full.members.map(item => [item.caseId, item.revision]), v3.members.map(item => [item.caseId, item.revision]), 'Full Handoff 包含指定版本全部 active 用例')
  assert.ok(full.members.every(item => item.dimension === 'functional' && item.executionSpec && item.contentSha256))
  assert.deepEqual(full.members[0].traceability, updatedTraceability, 'Handoff 冻结正式 Revision 的追溯信息')

  const deprecated = await reuseService.deprecateLibraryCase('project-1', stableCaseId, detail.etag, '需求范围移除', principal)
  assert.equal(deprecated.status, 'deprecated')
  assert.equal(deprecated.currentRevision, 3)
  assert.equal(deprecated.revisions.length, 3, '废弃后仍保留全部历史 Revision')
})

test('Coverage Audit 未通过时禁止发布正式用例库版本', async () => {
  const { service } = await fixture(new FakeRuntime(), { ingest: async () => ({ version: { id: 'asset' }, task: null }) })
  const design = await service.createDesign('pv-1', createInput(), principal)
  const created = await service.createRun('pv-1', design.id, 'blocked-publication', principal)
  const run = await waitFor(service, design.id, created.id, value => value.status === 'succeeded' && value.testCases.length > 0)
  const audit = run.coverageAudits.at(-1)!
  assert.ok(audit.blockers.length > 0)
  await assert.rejects(service.publishLibraryVersion('pv-1', design.id, run.id, { name: '禁止发布', expectedAuditId: audit.id, expectedCaseSetSha256: audit.caseSetSha256, expectedProposalSha256: run.caseChangeProposalSha256 }, principal), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_CASE_LIBRARY_PUBLICATION_BLOCKED')
})

test('四类测试维度生成对应 executionSpec，缺少受控配置时形成 Confirmation Item', async () => {
  const { service } = await fixture(new FakeRuntime({ dimensionMatrix: true }), { ingest: async () => ({ version: { id: 'asset' }, task: null }) })
  const design = await service.createDesign('pv-1', { ...createInput(), focusDimensions: ['functional', 'performance', 'stability', 'compatibility'] }, principal)
  const created = await service.createRun('pv-1', design.id, 'dimension-matrix', principal)
  const run = await waitFor(service, design.id, created.id, value => value.status === 'failed' || (value.status === 'succeeded' && value.testCases.length === 4))
  assert.notEqual(run.status, 'failed', run.error)
  assert.deepEqual(run.testCases.map(item => item.revisions.at(-1)!.content.executionSpec?.kind).sort(), ['compatibility', 'functional', 'performance', 'stability'])
  assert.ok(run.confirmationItems.some(item => /性能阈值/u.test(item.title)))
  assert.ok(run.confirmationItems.some(item => /稳定性运行时长/u.test(item.title)))
  assert.ok(run.confirmationItems.some(item => /兼容性环境矩阵/u.test(item.title)))
})

test('正式用例库发布拒绝已变化的基线、过期 Revision 和已废弃来源', async () => {
  const projector: TestCaseAssetProjector = { ingest: async () => ({ version: { id: `asset-${Math.random()}` }, task: null }) }
  const { store, service: initialService } = await fixture(new FakeRuntime(), projector)
  const initial = await preparePublishableRun(initialService, 'conflict-initial')
  for (const proposal of initial.run.caseChangeProposals) await initialService.decideCaseChangeProposal('pv-1', initial.designId, initial.runId, proposal.id, { expectedVersion: 0, decision: 'accepted' }, principal)
  const initialDecided = await initialService.getRun('pv-1', initial.designId, initial.runId)
  const v1 = await initialService.publishLibraryVersion('pv-1', initial.designId, initial.runId, { name: '冲突基线 V1', expectedAuditId: initial.audit.id, expectedCaseSetSha256: initial.audit.caseSetSha256, expectedProposalSha256: initialDecided.caseChangeProposalSha256 }, principal)

  const serviceA = new TestDesignService(store, new FakeRuntime({ proposalOperation: 'update' }), projector)
  const serviceB = new TestDesignService(store, new FakeRuntime({ proposalOperation: 'update' }), projector)
  const runA = await preparePublishableRun(serviceA, 'conflict-a')
  const runB = await preparePublishableRun(serviceB, 'conflict-b')
  for (const proposal of runA.run.caseChangeProposals) await serviceA.decideCaseChangeProposal('pv-1', runA.designId, runA.runId, proposal.id, { expectedVersion: 0, decision: 'accepted' }, principal)
  for (const proposal of runB.run.caseChangeProposals) await serviceB.decideCaseChangeProposal('pv-1', runB.designId, runB.runId, proposal.id, { expectedVersion: 0, decision: 'accepted' }, principal)
  const decidedA = await serviceA.getRun('pv-1', runA.designId, runA.runId)
  const decidedB = await serviceB.getRun('pv-1', runB.designId, runB.runId)
  await serviceA.publishLibraryVersion('pv-1', runA.designId, runA.runId, { name: '冲突基线 V2', expectedAuditId: runA.audit.id, expectedCaseSetSha256: runA.audit.caseSetSha256, expectedProposalSha256: decidedA.caseChangeProposalSha256 }, principal)
  await assert.rejects(serviceB.publishLibraryVersion('pv-1', runB.designId, runB.runId, { name: '禁止覆盖 V2', expectedAuditId: runB.audit.id, expectedCaseSetSha256: runB.audit.caseSetSha256, expectedProposalSha256: decidedB.caseChangeProposalSha256 }, principal), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_CASE_LIBRARY_BASE_CHANGED' && /正式用例库在本任务运行期间已经变化/u.test(error.message))

  const { store: revisionStore, service: revisionInitial } = await fixture(new FakeRuntime(), projector)
  const revisionSeed = await preparePublishableRun(revisionInitial, 'revision-initial')
  for (const proposal of revisionSeed.run.caseChangeProposals) await revisionInitial.decideCaseChangeProposal('pv-1', revisionSeed.designId, revisionSeed.runId, proposal.id, { expectedVersion: 0, decision: 'accepted' }, principal)
  const revisionSeedDecided = await revisionInitial.getRun('pv-1', revisionSeed.designId, revisionSeed.runId)
  const revisionV1 = await revisionInitial.publishLibraryVersion('pv-1', revisionSeed.designId, revisionSeed.runId, { name: 'Revision 基线', expectedAuditId: revisionSeed.audit.id, expectedCaseSetSha256: revisionSeed.audit.caseSetSha256, expectedProposalSha256: revisionSeedDecided.caseChangeProposalSha256 }, principal)
  const revisionService = new TestDesignService(revisionStore, new FakeRuntime({ proposalOperation: 'update' }), projector)
  const staleRevisionRun = await preparePublishableRun(revisionService, 'revision-stale')
  for (const proposal of staleRevisionRun.run.caseChangeProposals) await revisionService.decideCaseChangeProposal('pv-1', staleRevisionRun.designId, staleRevisionRun.runId, proposal.id, { expectedVersion: 0, decision: 'accepted' }, principal)
  const source = await revisionService.getLibraryCase('project-1', revisionV1.members[0].caseId)
  await revisionService.editLibraryCase('project-1', source.id, source.etag, { ...source.content, priority: source.content.priority === 'P0' ? 'P1' : 'P0' }, '并发人工修订', principal)
  const staleRevisionDecided = await revisionService.getRun('pv-1', staleRevisionRun.designId, staleRevisionRun.runId)
  await assert.rejects(revisionService.publishLibraryVersion('pv-1', staleRevisionRun.designId, staleRevisionRun.runId, { name: '禁止旧 Proposal 覆盖', expectedAuditId: staleRevisionRun.audit.id, expectedCaseSetSha256: staleRevisionRun.audit.caseSetSha256, expectedProposalSha256: staleRevisionDecided.caseChangeProposalSha256 }, principal), (error: unknown) => error instanceof TestDesignError && error.code === 'LIBRARY_TEST_CASE_REVISION_CONFLICT')

  const staleSourceService = new TestDesignService(revisionStore, new FakeRuntime({ proposalOperation: 'reuse' }), projector)
  const staleSourceRun = await preparePublishableRun(staleSourceService, 'source-stale')
  for (const proposal of staleSourceRun.run.caseChangeProposals) await staleSourceService.decideCaseChangeProposal('pv-1', staleSourceRun.designId, staleSourceRun.runId, proposal.id, { expectedVersion: 0, decision: 'accepted' }, principal)
  const editedSource = await staleSourceService.getLibraryCase('project-1', revisionV1.members[0].caseId)
  await staleSourceService.deprecateLibraryCase('project-1', editedSource.id, editedSource.etag, '并发废弃', principal)
  const staleSourceDecided = await staleSourceService.getRun('pv-1', staleSourceRun.designId, staleSourceRun.runId)
  await assert.rejects(staleSourceService.publishLibraryVersion('pv-1', staleSourceRun.designId, staleSourceRun.runId, { name: '禁止复用废弃来源', expectedAuditId: staleSourceRun.audit.id, expectedCaseSetSha256: staleSourceRun.audit.caseSetSha256, expectedProposalSha256: staleSourceDecided.caseChangeProposalSha256 }, principal), (error: unknown) => error instanceof TestDesignError && error.code === 'CASE_CHANGE_PROPOSAL_SOURCE_STALE')

  assert.equal(v1.version, 1)
})

test('旧 TestCaseSetVersion 迁移为 v2 正式用例库且重复调用幂等', async () => {
  const { service } = await fixture(new FakeRuntime(), { ingest: async () => ({ version: { id: `legacy-asset-${Math.random()}` }, task: null }) })
  const prepared = await preparePublishableRun(service, 'legacy-migration')
  const legacy = await service.publishCaseSet('pv-1', prepared.designId, prepared.runId, { name: '历史用例集', expectedAuditId: prepared.audit.id, expectedCaseSetSha256: prepared.audit.caseSetSha256 }, principal)
  const preview = await service.previewLegacyCaseMigration('project-1', legacy.id)
  assert.equal(preview.status, 'ready')
  const first = await service.migrateLegacyCaseSet('project-1', { legacyTestCaseSetVersionId: legacy.id, expectedPreviewSha256: preview.previewSha256 }, principal)
  const second = await service.migrateLegacyCaseSet('project-1', { legacyTestCaseSetVersionId: legacy.id, expectedPreviewSha256: preview.previewSha256 }, principal)
  assert.equal(second.version.id, first.version.id)
  assert.equal(second.record.id, first.record.id)
  assert.equal(first.version.legacyTestCaseSetVersionId, legacy.id)
  assert.equal((await service.listLibraryVersions('project-1')).length, 1)
  const migratedCase = await service.getLibraryCase('project-1', first.version.members[0].caseId)
  assert.equal(migratedCase.content.schemaVersion, 'test-case/v2')
  assert.equal(migratedCase.content.executionSpec?.kind, 'functional')
  assert.equal(migratedCase.revisions.length, 1)
})

test('正式用例 API 拒绝非法 executionSpec，非功能用例不依赖 executionMethods', async () => {
  const { service } = await fixture(new FakeRuntime())
  const { ref: _ref, ...performance } = dimensionCaseCandidate('test-case-design/v1', ['point-1', 'point-2', 'point-3', 'point-4']).cases[1]
  const saved = await service.createLibraryCase('project-1', performance, '人工新增性能用例', principal)
  assert.equal(saved.content.executionMethods.length, 0)
  assert.equal(saved.content.executionSpec?.kind, 'performance')
  await assert.rejects(service.createLibraryCase('project-1', { ...performance, executionSpec: { ...performance.executionSpec, kind: 'stability' } }, '非法维度', principal), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_CASE_EXECUTION_SPEC_INVALID')
})

test('needs_confirmation 默认和 Full 均被 Handoff 门禁阻断，人工覆盖后冻结决定', async () => {
  const { ref: _ref, ...candidate } = caseCandidate('test-case-design/v1', ['point-ready']).cases[0]
  const content = { ...candidate, executionMethods: candidate.executionMethods.map(method => ({ ...method, executionReadiness: 'needs_confirmation' as const })) }
  const { store, service } = await fixture(new FakeRuntime())
  const { version, testCase } = await seedManualLibraryVersion(store, service, content, 'needs-confirmation')
  await assert.rejects(service.createLibraryHandoff('pv-1', version.id, { mode: 'full', expectedLibrarySha256: version.contentSha256 }, principal), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_EXECUTION_READINESS_OVERRIDE_REQUIRED' && error.status === 422)
  const handoff = await service.createLibraryHandoff('pv-1', version.id, { mode: 'full', expectedLibrarySha256: version.contentSha256, executionReadinessOverrides: [{ caseId: testCase.id, revision: 1, reason: '历史用例已由测试负责人核对入口与步骤，本轮允许执行' }] }, principal)
  assert.deepEqual(handoff.members[0].readinessOverride, { reason: '历史用例已由测试负责人核对入口与步骤，本轮允许执行', actorId: principal.subjectId, createdAt: handoff.members[0].readinessOverride?.createdAt })
  assert.match(handoff.members[0].readinessOverride!.createdAt, /^\d{4}-\d{2}-\d{2}T/u)
})

test('blocked 用例即使提交人工覆盖也不能进入 Handoff', async () => {
  const { ref: _ref, ...candidate } = caseCandidate('test-case-design/v1', ['point-blocked']).cases[0]
  const content = { ...candidate, executionMethods: candidate.executionMethods.map(method => ({ ...method, executionReadiness: 'blocked' as const })) }
  const { store, service } = await fixture(new FakeRuntime())
  const { version, testCase } = await seedManualLibraryVersion(store, service, content, 'blocked')
  await assert.rejects(service.createLibraryHandoff('pv-1', version.id, { mode: 'full', expectedLibrarySha256: version.contentSha256, executionReadinessOverrides: [{ caseId: testCase.id, revision: 1, reason: '尝试普通覆盖' }] }, principal), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_EXECUTION_CASE_BLOCKED' && error.status === 422)
})

test('正式 Revision 修改追溯字段必须提交匹配追溯，普通字段修改继承原追溯', async () => {
  const { ref: _ref, ...content } = caseCandidate('test-case-design/v1', ['point-trace']).cases[0]
  const { store, service } = await fixture(new FakeRuntime())
  const created = await service.createLibraryCase('project-1', content, '创建正式追溯用例', principal)
  const traceability = { sourceRequirementReleaseId: 'release-1', requirementRefs: [{ requirementReleaseId: 'release-1', requirementId: 'REQ-1' }], testPointRefs: [{ testPointTreeVersionId: 'tree-version-1', testPointId: 'point-trace' }] }
  await store.transaction(state => { const testCase = state.testDesignState!.libraryCases.find(item => item.id === created.id)!; testCase.revisions[0].traceability = structuredClone(traceability) })
  const current = await service.getLibraryCase('project-1', created.id)
  const changed = { ...current.content, testPointIds: ['point-new'] }
  await assert.rejects(service.editLibraryCase('project-1', current.id, current.etag, changed, '修改测试点', principal), (error: unknown) => error instanceof TestDesignError && error.code === 'LIBRARY_TEST_CASE_TRACEABILITY_REQUIRED')
  await assert.rejects(service.editLibraryCase('project-1', current.id, current.etag, changed, '提交错误追溯', principal, traceability), (error: unknown) => error instanceof TestDesignError && error.code === 'LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH')
  const ordinary = await service.editLibraryCase('project-1', current.id, current.etag, { ...current.content, priority: 'P1' }, '只调整优先级', principal)
  assert.deepEqual(ordinary.revisions.at(-1)!.traceability, traceability)

  const historical = await service.createLibraryCase('project-1', { ...content, testPointIds: ['historical-point'] }, '历史无追溯用例', principal)
  const historicalEdited = await service.editLibraryCase('project-1', historical.id, historical.etag, { ...historical.content, tags: ['historical', 'maintained'] }, '普通字段维护', principal)
  assert.equal(historicalEdited.revisions.at(-1)!.traceability, undefined)
})

test('用例库历史版本始终返回冻结内容并在 Hash 不一致时拒绝读取', async () => {
  const { ref: _ref, ...content } = caseCandidate('test-case-design/v1', ['point-frozen']).cases[0]
  const { store, service } = await fixture(new FakeRuntime())
  const { version, testCase } = await seedManualLibraryVersion(store, service, content, 'frozen-history')
  const current = await service.getLibraryCase('project-1', testCase.id)
  await service.editLibraryCase('project-1', current.id, current.etag, { ...current.content, title: '当前 Revision 新标题' }, '只更新当前标题', principal)
  const historical = await service.getLibraryVersion('project-1', version.id)
  assert.equal(historical.members[0].frozenContent?.title, content.title)
  assert.equal((await service.getLibraryCase('project-1', testCase.id)).content.title, '当前 Revision 新标题')
  await store.transaction(state => { state.testDesignState!.libraryVersions.find(item => item.id === version.id)!.members[0].frozenContent = { ...content, title: '被篡改的冻结标题' } })
  await assert.rejects(service.getLibraryVersion('project-1', version.id), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_CASE_LIBRARY_MEMBER_HASH_MISMATCH' && error.status === 409)
})

test('旧用例迁移预览逐条识别四类执行配置缺口且确认导入不虚构配置', async () => {
  const { store, service } = await fixture(new FakeRuntime(), { ingest: async input => ({ version: { id: `legacy-incomplete-${sha256(input.logicalPath).slice(0, 8)}` }, task: null }) })
  const legacyId = 'legacy-incomplete-configurations'
  await store.transaction(state => {
    const aggregate = state.testDesignState ??= { architectureVersion: 'single-agent-skills/v1', designs: [], runs: [], caseSetVersions: [], libraryCases: [], libraryVersions: [], suiteDrafts: [], suiteVersions: [], executionHandoffs: [], legacyMigrations: [] }
    const cases = ['functional', 'performance', 'stability', 'compatibility'].map((dimension, index) => ({ caseId: `legacy-${dimension}`, revision: 1, content: { title: `历史 ${dimension}`, dimension } }))
    aggregate.caseSetVersions.push({ id: legacyId, projectId: 'project-1', projectVersionId: 'pv-1', testDesignId: 'legacy-design', runId: 'legacy-run', version: 1, schemaVersion: 'test-case-set/v1', name: '不完整历史用例', treeVersionId: 'legacy-tree', dataSetVersionId: 'legacy-data', coverageAuditId: 'legacy-audit', members: [], canonicalContent: { schemaVersion: 'test-case-set/v1', cases }, contentSha256: '9'.repeat(64), publishedBy: 'legacy-owner', publishedAt: '2026-08-12T00:00:00.000Z', projection: { status: 'succeeded', files: [] } })
  })
  const preview = await service.previewLegacyCaseMigration('project-1', legacyId)
  assert.equal(preview.status, 'needs_confirmation')
  assert.deepEqual(preview.items.map(item => item.executionConfigurationStatus), ['needs_confirmation', 'needs_confirmation', 'needs_confirmation', 'needs_confirmation'])
  assert.match(preview.items.find(item => item.legacyCaseId === 'legacy-functional')!.executionConfigurationIssues.join(' '), /执行步骤|UI 入口/u)
  assert.match(preview.items.find(item => item.legacyCaseId === 'legacy-performance')!.executionConfigurationIssues.join(' '), /阈值来源/u)
  assert.match(preview.items.find(item => item.legacyCaseId === 'legacy-stability')!.executionConfigurationIssues.join(' '), /运行时长/u)
  assert.match(preview.items.find(item => item.legacyCaseId === 'legacy-compatibility')!.executionConfigurationIssues.join(' '), /环境矩阵/u)
  await assert.rejects(service.migrateLegacyCaseSet('project-1', { legacyTestCaseSetVersionId: legacyId, expectedPreviewSha256: preview.previewSha256 }, principal), (error: unknown) => error instanceof TestDesignError && error.code === 'LEGACY_TEST_CASE_MIGRATION_CONFIRMATION_REQUIRED')
  const migrated = await service.migrateLegacyCaseSet('project-1', { legacyTestCaseSetVersionId: legacyId, expectedPreviewSha256: preview.previewSha256, confirmUncertain: true }, principal)
  assert.ok(migrated.version.members.every(member => member.executionReadiness === 'needs_confirmation'))
  const performance = migrated.version.members.find(member => member.frozenContent?.dimension === 'performance')!.frozenContent!.executionSpec
  const stability = migrated.version.members.find(member => member.frozenContent?.dimension === 'stability')!.frozenContent!.executionSpec
  const compatibility = migrated.version.members.find(member => member.frozenContent?.dimension === 'compatibility')!.frozenContent!.executionSpec
  assert.deepEqual(performance?.kind === 'performance' ? performance.thresholds : null, [])
  assert.equal(stability?.kind === 'stability' ? stability.duration : 'unexpected', null)
  assert.deepEqual(compatibility?.kind === 'compatibility' ? [compatibility.browserMatrix, compatibility.operatingSystemMatrix, compatibility.viewportMatrix, compatibility.versionMatrix] : null, [[], [], [], []])
})

test('无对应 Proposal 的基线成员被并发废弃时阻止发布且不静默删除', async () => {
  const projector: TestCaseAssetProjector = { ingest: async () => ({ version: { id: `asset-${Math.random()}` }, task: null }) }
  const { store, service } = await fixture(new FakeRuntime(), projector)
  const initial = await preparePublishableRun(service, 'base-member-seed')
  for (const proposal of initial.run.caseChangeProposals) await service.decideCaseChangeProposal('pv-1', initial.designId, initial.runId, proposal.id, { expectedVersion: 0, decision: 'accepted' }, principal)
  const initialDecided = await service.getRun('pv-1', initial.designId, initial.runId)
  const v1 = await service.publishLibraryVersion('pv-1', initial.designId, initial.runId, { name: '基线 V1', expectedAuditId: initial.audit.id, expectedCaseSetSha256: initial.audit.caseSetSha256, expectedProposalSha256: initialDecided.caseChangeProposalSha256 }, principal)
  const concurrent = new TestDesignService(store, new FakeRuntime(), projector)
  const next = await preparePublishableRun(concurrent, 'base-member-no-source-proposal')
  for (const proposal of next.run.caseChangeProposals) await concurrent.decideCaseChangeProposal('pv-1', next.designId, next.runId, proposal.id, { expectedVersion: 0, decision: 'accepted' }, principal)
  const baseCase = await concurrent.getLibraryCase('project-1', v1.members[0].caseId)
  await concurrent.deprecateLibraryCase('project-1', baseCase.id, baseCase.etag, '并发废弃基线成员', principal)
  const decided = await concurrent.getRun('pv-1', next.designId, next.runId)
  await assert.rejects(concurrent.publishLibraryVersion('pv-1', next.designId, next.runId, { name: '禁止静默删除', expectedAuditId: next.audit.id, expectedCaseSetSha256: next.audit.caseSetSha256, expectedProposalSha256: decided.caseChangeProposalSha256 }, principal), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_CASE_LIBRARY_BASE_MEMBER_DEPRECATED')
})

class FakeRuntime implements PlanningAgentRuntime {
  stages: string[] = []
  tasks: Array<{ projectVersionId: string; taskType: string; task: string; metadata?: Record<string, unknown> }> = []
  constructor(private readonly behavior: { uncoveredPoint?: boolean; keepUncoveredDuringRepair?: boolean; proposalOperation?: 'reuse' | 'update'; dimensionMatrix?: boolean; pointBasisRefMode?: 'published_requirement_id' | 'outside' } = {}) {}
  readiness = async () => ({ ready: true, agents: [{ agentKey: 'planning', ready: true }] })
  freezeConfiguration = async () => ({ configurationId: 'agent-config-1', configurationVersion: 1, configurationSha256: 'c'.repeat(64), agentDefinition: {} as never, routing: {} as never, primaryModel: { sourceId: 'source-1', modelId: 'model-1', modelName: '测试模型' }, createdAt: '2026-08-12T00:00:00.000Z', snapshotSha256: 'd'.repeat(64) })
  appendTask = async (input: { projectVersionId: string; taskType: string; task: string; metadata?: Record<string, unknown> }) => { this.tasks.push(structuredClone(input)) }
  execute = async (input: { stage: 'test_point_design' | 'test_case_design' | 'test_design_repair'; run: TestDesignWorkflowRun }) => {
    this.stages.push(input.stage)
    if (input.stage === 'test_point_design') {
      const refs = input.run.basisSnapshot.items.map(item => item.id)
      const pointRefs = this.behavior.pointBasisRefMode === 'published_requirement_id'
        ? input.run.basisSnapshot.items.map(item => typeof item.locator?.requirementPointId === 'string' ? item.locator.requirementPointId : item.id)
        : this.behavior.pointBasisRefMode === 'outside'
          ? refs.map(() => 'RP-OUTSIDE')
          : refs
      const dimensions = this.behavior.dimensionMatrix ? ['functional', 'performance', 'stability', 'compatibility'] : refs.map(() => 'functional')
      const nodes = dimensions.map((dimension, index) => ({ ref: `point-${index + 1}`, title: `${dimension} 测试点`, objective: `验证 ${dimension}`, dimension, priority: 'P0', applicability: 'applicable', designTechniques: ['主流程'], entryMethods: ['ui'], oracle: '结果符合需求', dataConditions: [], risks: [], assumptions: [], basisRefs: [pointRefs[index % pointRefs.length]], historicalRefs: [] }))
      if (this.behavior.uncoveredPoint) nodes.push({ ...nodes[0], ref: 'point-extra', title: '额外风险测试点' })
      return { schemaVersion: 'test-point-design/v1', content: { schemaVersion: 'test-point-design/v1', nodes, findings: [], confirmationItems: [] } }
    }
    const pointIds = approvedPointIds(input.run)
    const covered = this.behavior.keepUncoveredDuringRepair ? pointIds.slice(0, 1) : pointIds
    const schemaVersion = input.stage === 'test_design_repair' ? 'test-design-repair/v1' : 'test-case-design/v1'
    if (this.behavior.dimensionMatrix) return { schemaVersion, content: dimensionCaseCandidate(schemaVersion, covered) }
    const content = caseCandidate(schemaVersion, covered)
    if (this.behavior.proposalOperation && input.stage === 'test_case_design') {
      const source = input.run.historicalSnapshot.items[0]; const locator = source.locator as { caseId: string; revision: number }
      content.proposals = [{ operation: this.behavior.proposalOperation, sourceCaseId: locator.caseId, sourceRevision: locator.revision, candidateRef: 'case-1', requirementRefs: input.run.basisSnapshot.items.map(item => item.id), testPointIds: covered, reason: this.behavior.proposalOperation === 'reuse' ? '需求语义未变化，直接复用' : '需求变化影响步骤，保留 Case ID 创建新 Revision', confidence: 0.96 }]
      if (this.behavior.proposalOperation === 'update') content.cases[0].objective = '按新需求更新后的验证目标'
    }
    return { schemaVersion, content }
  }
}

async function fixture(runtime: PlanningAgentRuntime, projector?: TestCaseAssetProjector) {
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
  await store.transaction(state => {
    state.reviewRuns.push(release.review as never)
    const version = state.projectVersions.find(item => item.id === 'pv-1')!
    const binding = { releaseId: release.id, verificationRunId: 'review-2', requirementsJsonSha256: release.requirementsHash, boundAt: '2026-08-12T01:00:00.000Z' }
    version.requirementReleaseBindings = [version.requirementReleaseBinding!, binding]
    version.activeRequirementReleaseId = binding.releaseId
    version.requirementReleaseBinding = binding
  })
}

function releasePackage(releaseId: string, reviewId: string, requirementIds: string[]) {
  const requirements = `${JSON.stringify({ schemaVersion: 'requirements/v1', releaseId, projectVersionId: 'pv-1', verificationRunId: reviewId, sourceAssetVersions: [], requirements: requirementIds.map(id => ({ clientRequirementPointId: id, title: id, description: `需求 ${id}`, evidenceRefs: [] })) })}\n`
  const requirementsHash = sha256(requirements)
  const manifest = `${JSON.stringify({ schemaVersion: 'requirement-release-manifest/v1', releaseId, projectVersionId: 'pv-1', verificationRunId: reviewId, artifacts: [{ fileName: 'requirements.json', mediaType: 'application/json', contentSha256: requirementsHash }], machineReadableEntryPoints: { requirements: 'requirements.json' } })}\n`
  const release = { id: releaseId, schemaVersion: 'requirement-release-package/v1', status: 'published', projectVersionId: 'pv-1', verificationRunId: reviewId, sourceAssetVersionIds: [], artifacts: [{ fileName: 'requirements.json', mediaType: 'application/json', content: requirements, contentSha256: requirementsHash }, { fileName: 'manifest.json', mediaType: 'application/json', content: manifest, contentSha256: sha256(manifest) }], contentSha256: sha256(manifest), publishedAt: '2026-08-12T00:00:00.000Z' }
  return { id: releaseId, requirementsHash, review: { id: reviewId, projectVersionId: 'pv-1', status: 'succeeded', snapshot: { currentInputRefs: [] }, workflow: { release }, result: { requirementPoints: [] }, createdAt: '2026-08-12T00:00:00.000Z' } }
}

function createInput() { return { name: '认证测试设计', objective: '验证正式需求', includedScopes: [{ kind: 'module', value: '认证' }], excludedScopes: [], focusDimensions: ['functional'], executionMethods: ['ui'], userCoverageObjectives: [], knowledgeAugmentation: { mode: 'disabled' }, historicalCaseSelections: [] } }
function caseCandidate(schemaVersion: 'test-case-design/v1' | 'test-design-repair/v1', pointIds: string[]) { return { schemaVersion, cases: pointIds.map((pointId, index) => ({ ref: `case-${index + 1}`, schemaVersion: 'test-case/v1', title: `用例 ${index + 1}`, objective: `验证 ${pointId}`, dimension: 'functional', testPointIds: [pointId], priority: 'P0', preconditions: [], dataRequirementIds: [], cleanup: [], dependencies: [], executionMethods: [{ method: 'ui', uiSpec: { entry: '/login' }, steps: [{ key: 'step-1', action: '执行操作', expected: '结果符合需求' }], verificationChecks: [{ key: 'check-1', description: '页面结果正确' }], executionReadiness: 'ready', automationHint: '使用 UI 自动化' }], sharedVerificationChecks: [], tags: ['smoke'], domain: '认证' })), dataRequirements: [], findings: [], confirmationItems: [] } }
function dimensionCaseCandidate(schemaVersion: 'test-case-design/v1' | 'test-design-repair/v1', pointIds: string[]) { const dimensions = ['functional', 'performance', 'stability', 'compatibility'] as const; return { schemaVersion, cases: pointIds.map((pointId, index) => { const dimension = dimensions[index]; const executionSpec = dimension === 'functional' ? { kind: 'functional', method: 'ui', steps: [{ key: 'step-1', action: '执行功能操作', expected: '功能结果正确' }], verificationChecks: [{ key: 'check-1', description: '功能断言' }], preconditions: [], testDataRequirements: [], executionReadiness: 'ready', automationHint: 'UI 自动化' } : dimension === 'performance' ? { kind: 'performance', method: 'performance_tool', target: '订单接口', scenario: '并发下单', virtualUsers: null, duration: null, rampUp: null, thresholds: [], dataStrategy: '隔离测试数据', environmentRequirements: [], executionReadiness: 'needs_confirmation' } : dimension === 'stability' ? { kind: 'stability', method: 'long_running', workload: '持续下单', duration: null, interval: null, observations: ['错误率'], recoveryPolicy: null, checkpointPolicy: null, environmentRequirements: [], executionReadiness: 'needs_confirmation' } : { kind: 'compatibility', method: 'environment_matrix', baseMethod: 'ui', baseCaseRefs: [], browserMatrix: [], operatingSystemMatrix: [], viewportMatrix: [], versionMatrix: [], expectedConsistency: '行为一致', executionReadiness: 'needs_confirmation' }; return { ref: `case-${index + 1}`, schemaVersion: 'test-case/v2', title: `${dimension} 用例`, objective: `验证 ${dimension}`, dimension, testPointIds: [pointId], priority: 'P0', preconditions: [], dataRequirementIds: [], cleanup: [], dependencies: [], executionMethods: dimension === 'functional' ? [{ method: 'ui', uiSpec: { entry: '/login' }, steps: [{ key: 'step-1', action: '执行功能操作', expected: '功能结果正确' }], verificationChecks: [{ key: 'check-1', description: '功能断言' }], executionReadiness: 'ready', automationHint: 'UI 自动化' }] : [], executionSpec, sharedVerificationChecks: [], tags: [], domain: '多维测试' } }), dataRequirements: [], findings: [], confirmationItems: [], proposals: [] } }
async function preparePublishableRun(service: TestDesignService, key: string) { const design = await service.createDesign('pv-1', { ...createInput(), name: key }, principal); const created = await service.createRun('pv-1', design.id, key, principal); const designed = await waitFor(service, design.id, created.id, run => run.status === 'succeeded' && run.testCases.length > 0); const targets = designed.testCases.map(item => ({ caseId: item.id, targetRevision: item.currentRevision })); await service.batchReview('pv-1', design.id, created.id, { targets, decision: 'submit' }, principal); await service.batchReview('pv-1', design.id, created.id, { targets, decision: 'approve' }, principal); const audit = await service.reAudit('pv-1', design.id, created.id); const run = await service.getRun('pv-1', design.id, created.id); return { designId: design.id, runId: created.id, audit, run } }
async function seedManualLibraryVersion(store: JsonStore, service: TestDesignService, content: TestCaseContent, suffix: string) {
  const testCase = await service.createLibraryCase('project-1', content, `创建 ${suffix} 用例`, principal)
  const revision = testCase.revisions![0]
  const versionId = `library-version-${suffix}`
  await store.transaction(state => {
    const aggregate = state.testDesignState!
    aggregate.libraryVersions.push({ id: versionId, projectId: 'project-1', version: aggregate.libraryVersions.length + 1, name: suffix, members: [{ caseId: testCase.id, revision: revision.revision, ordinal: 0, contentSha256: revision.contentSha256, frozenContent: structuredClone(revision.content), executionReadiness: revision.content.executionSpec!.executionReadiness }], contentSha256: sha256(versionId), publishedBy: principal.subjectId, publishedAt: '2026-08-12T00:00:00.000Z', projection: { status: 'succeeded', files: [] } })
  })
  return { testCase, version: await service.getLibraryVersion('project-1', versionId) }
}
function approvedPointIds(run: TestDesignWorkflowRun) { const tree = run.testPointTree!; const version = tree.versions.find(item => item.id === tree.currentApprovedVersionId)!; const revision = tree.revisions.find(item => item.revision === version.revision)!; const parents = new Set(revision.nodes.flatMap(item => item.parentId ? [item.parentId] : [])); return revision.nodes.filter(item => !item.deleted && item.applicability !== 'not_applicable' && !parents.has(item.nodeId)).map(item => item.nodeId) }
async function waitFor(service: TestDesignService, designId: string, runId: string, predicate: (run: TestDesignWorkflowRun) => boolean) { for (let attempt = 0; attempt < 200; attempt += 1) { const value = await service.getRun('pv-1', designId, runId) as TestDesignWorkflowRun; if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 5)) } throw new Error('等待测试设计状态超时') }
function sha256(value: string) { return createHash('sha256').update(value).digest('hex') }
