import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import { materializeCaseDesign, repairCandidateContent, TestDesignService, type PlanningAgentRuntime } from '../server/application/test-design-service.js'
import { validateTestCaseContent } from '../server/application/test-design-validation.js'
import { JsonStore } from '../server/infrastructure/store.js'

const principal = { subjectId: 'test-owner', displayName: '测试负责人' }

test('Coverage Audit 的 TEST_CASE_OVER_MERGED 会由同一 PlanningAgent repair 读取并重分配 ScenarioClaims 后闭环', async () => {
  const store = await storeWithPublishedRequirement()
  let repairSawClaims = false
  const stages: string[] = []
  const runtime: PlanningAgentRuntime = {
    readiness: async () => ({ ready: true, agents: [] }),
    freezeConfiguration: async () => frozenConfiguration(),
    execute: async input => {
      stages.push(input.stage)
      if (input.stage === 'test_case_design') return { schemaVersion: 'test-case-design/v1', content: candidate([caseCandidate('TC-TASK-STATE-TRANSITIONS', '任务状态转换')], [stateClaim('SC-TODO-IN-PROGRESS', 'TC-TASK-STATE-TRANSITIONS', 'todo->in_progress', 'positive', '状态为 in_progress'), stateClaim('SC-IN-PROGRESS-COMPLETED', 'TC-TASK-STATE-TRANSITIONS', 'in_progress->completed', 'positive', '状态为 completed')]) }
      repairSawClaims = input.run.scenarioClaims.length === 2 && (input.upstream as { blockers: Array<{ code: string }> }).blockers.some(item => item.code === 'TEST_CASE_OVER_MERGED')
      return { schemaVersion: 'test-design-repair/v1', content: candidate([caseCandidate('TC-TASK-TODO-TO-IN-PROGRESS', 'todo 到 in_progress'), caseCandidate('TC-TASK-IN-PROGRESS-TO-COMPLETED', 'in_progress 到 completed')], [stateClaim('SC-TODO-IN-PROGRESS', 'TC-TASK-TODO-TO-IN-PROGRESS', 'todo->in_progress', 'positive', '状态为 in_progress'), stateClaim('SC-IN-PROGRESS-COMPLETED', 'TC-TASK-IN-PROGRESS-TO-COMPLETED', 'in_progress->completed', 'positive', '状态为 completed')], 'test-design-repair/v1') }
    },
  }
  const service = new TestDesignService(store, runtime)
  const design = await service.createDesign('project-version-1', { name: '状态机测试设计', objective: '验证任务状态机', knowledgeAugmentation: { mode: 'disabled' } }, principal)
  const run = await service.createRun('project-version-1', design.id, 'atomicity-repair', principal)
  const completed = await waitForCompletedRun(service, 'project-version-1', design.id, run.id)

  assert.equal(repairSawClaims, true, JSON.stringify({ stages, automaticRepair: completed.automaticRepair, audit: completed.coverageAudits.at(-1)?.blockers, claims: completed.scenarioClaims }))
  assert.equal(completed.automaticRepair?.status, 'succeeded')
  assert.equal(completed.testCases.filter(item => !item.tombstonedAt).length, 2)
  assert.equal(completed.scenarioClaims.map(item => item.caseRef).sort().join(','), 'TC-TASK-IN-PROGRESS-TO-COMPLETED,TC-TASK-TODO-TO-IN-PROGRESS')
  assert.equal(completed.coverageAudits.at(-1)?.blockers.some(item => item.code === 'TEST_CASE_OVER_MERGED'), false)
  const handoffConfirmations = completed.confirmationItems.filter(item => item.executionIssueSignature)
  assert.equal(handoffConfirmations.length, 1, '同类 UI 执行缺口必须聚合为一个 Confirmation')
  assert.deepEqual(handoffConfirmations[0]?.affectedRefs.filter(ref => completed.testCases.some(item => !item.tombstonedAt && item.id === ref)).sort(), completed.testCases.filter(item => !item.tombstonedAt).map(item => item.id).sort())
  await service.reAudit('project-version-1', design.id, run.id)
  assert.equal((await service.getRun('project-version-1', design.id, run.id)).confirmationItems.filter(item => item.executionIssueSignature).length, 1, '重新 Audit 不得增加相同 Handoff Confirmation')
})

test('无关 human_decision 不阻止 TEST_CASE_OVER_MERGED 的范围化自动修复', async () => {
  const store = await storeWithPublishedRequirement()
  let repairExecuted = false
  const runtime: PlanningAgentRuntime = {
    readiness: async () => ({ ready: true, agents: [] }),
    freezeConfiguration: async () => frozenConfiguration(),
    execute: async input => {
      if (input.stage === 'test_case_design') {
        return {
          schemaVersion: 'test-case-design/v1',
          content: candidate(
            [caseCandidate('TC-MERGED', '状态边合并'), caseCandidate('TC-HUMAN', '待人工业务判断')],
            [
              stateClaim('SC-MERGED-TODO', 'TC-MERGED', 'todo->in_progress', 'positive', '状态变更后为 in_progress'),
              stateClaim('SC-MERGED-COMPLETED', 'TC-MERGED', 'in_progress->completed', 'positive', '状态变更后为 completed'),
              stateClaim('SC-HUMAN', 'TC-HUMAN', 'completed->todo', 'negative', '待确认具体回退语义'),
            ],
          ),
        }
      }
      repairExecuted = (input.upstream as { blockers: Array<{ code: string }> }).blockers.every(item => item.code === 'TEST_CASE_OVER_MERGED')
      return {
        schemaVersion: 'test-design-repair/v1',
        content: candidate(
          [caseCandidate('TC-TODO', 'todo 到 in_progress'), caseCandidate('TC-COMPLETED', 'in_progress 到 completed'), caseCandidate('TC-HUMAN', '待人工业务判断')],
          [
            stateClaim('SC-MERGED-TODO', 'TC-TODO', 'todo->in_progress', 'positive', '状态变更后为 in_progress'),
            stateClaim('SC-MERGED-COMPLETED', 'TC-COMPLETED', 'in_progress->completed', 'positive', '状态变更后为 completed'),
            stateClaim('SC-HUMAN', 'TC-HUMAN', 'completed->todo', 'negative', '待确认具体回退语义'),
          ],
          'test-design-repair/v1',
        ),
      }
    },
  }
  const service = new TestDesignService(store, runtime)
  const design = await service.createDesign('project-version-1', { name: '范围化修复', objective: '验证修复作用域', knowledgeAugmentation: { mode: 'disabled' } }, principal)
  const run = await service.createRun('project-version-1', design.id, 'scope-aware-repair', principal)
  const completed = await waitForCompletedRun(service, 'project-version-1', design.id, run.id)

  assert.equal(repairExecuted, true)
  assert.equal(completed.automaticRepair?.status, 'succeeded')
  assert.equal(completed.coverageAudits.at(-1)?.blockers.some(item => item.code === 'TEST_CASE_OVER_MERGED'), false)
  assert.ok(completed.coverageAudits.at(-1)?.blockers.some(item => item.code === 'TEST_CASE_EXPECTED_RESULT_UNCLEAR' && item.resolution === 'human_decision'))
})

test('未尝试的非独立修复在相关 human_decision 下标记 deferred，不会伪造 exhausted', async () => {
  const store = await storeWithPublishedRequirement()
  let repairExecuted = false
  const runtime: PlanningAgentRuntime = {
    readiness: async () => ({ ready: true, agents: [] }),
    freezeConfiguration: async () => frozenConfiguration(),
    execute: async input => {
      if (input.stage === 'test_design_repair') repairExecuted = true
      return {
        schemaVersion: 'test-case-design/v1',
        content: candidate([caseCandidate('TC-SHALLOW', '覆盖过浅且待确认')], [stateClaim('SC-SHALLOW', 'TC-SHALLOW', 'todo->in_progress', 'positive', '待确认状态展示')]),
      }
    },
  }
  const service = new TestDesignService(store, runtime)
  const design = await service.createDesign('project-version-1', { name: '修复状态', objective: '验证状态语义', knowledgeAugmentation: { mode: 'disabled' } }, principal)
  const run = await service.createRun('project-version-1', design.id, 'deferred-repair-state', principal)
  const completed = await waitForCompletedRun(service, 'project-version-1', design.id, run.id)

  assert.equal(repairExecuted, false)
  assert.equal(completed.automaticRepair?.attempt, 0)
  assert.equal(completed.automaticRepair?.status, 'deferred')
  assert.ok(completed.coverageAudits.at(-1)?.blockers.some(item => item.code === 'TEST_CASE_COVERAGE_TOO_SHALLOW'))
  assert.ok(completed.coverageAudits.at(-1)?.blockers.some(item => item.code === 'TEST_CASE_EXPECTED_RESULT_UNCLEAR'))
})

test('test-case-design/v2 提交 cases: [] 时，Service 从明确继承的冻结快照恢复 100 条历史用例并派生完整 reuse Proposal', async () => {
  const store = await storeWithPublishedRequirement()
  await installHistoricalLibrary(store, 100)
  const submitted = referenceCandidate([])
  const runtime: PlanningAgentRuntime = {
    readiness: async () => ({ ready: true, agents: [] }),
    freezeConfiguration: async () => frozenConfiguration(),
    execute: async () => ({ schemaVersion: 'test-case-design/v2', content: submitted }),
  }
  const service = new TestDesignService(store, runtime)
  const design = await service.createDesign('project-version-1', { name: '引用式历史复用', objective: '验证冻结历史复用', knowledgeAugmentation: { mode: 'disabled' }, historicalLibrarySelection: { mode: 'library_version', testCaseLibraryVersionId: 'library-v1' } }, principal)
  const run = await service.createRun('project-version-1', design.id, 'reference-submission', principal)
  const completed = await waitForCompletedRun(service, 'project-version-1', design.id, run.id)

  assert.equal(completed.status, 'succeeded', completed.error)
  assert.equal(completed.testCases.filter(item => !item.tombstonedAt).length, 100)
  assert.equal(completed.caseChangeProposals.filter(item => item.operation === 'reuse').length, 100)
  assert.equal(completed.caseChangeProposals.filter(item => item.operation === 'create').length, 0)
  assert.equal(completed.caseChangeProposals.filter(item => item.decision === 'accepted').length, 100, 'Service 必须自动接受与冻结 Snapshot 一致的 reuse Proposal')
  assert.ok(completed.caseChangeProposals.every(item => item.decidedBy === 'system:test-design-service'))
  assert.ok(completed.testCases.some(item => item.origin === 'historical_unchanged' && item.revisions[item.currentRevision].content.title === '冻结历史 1'))
  const artifact = completed.artifacts.find(item => item.id === completed.nodeRuns.find(item => item.nodeKey === 'test_case_design')?.outputArtifactId)
  assert.equal((artifact?.content as { cases?: unknown[] }).cases?.length, 100, 'Artifact 必须保存 Service 生成的完整 Candidate Snapshot')

  const legacyLike = {
    schemaVersion: 'test-case-design/v1',
    cases: completed.testCases.filter(item => !item.tombstonedAt).map(item => ({ ref: item.candidateRef, ...item.revisions[item.currentRevision].content })),
    dimensionAssessments: submitted.dimensionAssessments,
    scenarioClaims: completed.scenarioClaims,
    dataRequirements: [],
    findings: [],
    confirmationItems: [],
    proposals: completed.caseChangeProposals.map(item => ({ operation: item.operation, sourceCaseId: item.sourceCaseId, sourceRevision: item.sourceRevision, candidateRef: completed.testCases.find(testCase => testCase.id === item.candidateCaseId)?.candidateRef, requirementRefs: item.requirementRefs, reason: item.reason, confidence: item.confidence })),
  }
  assert.ok(Buffer.byteLength(JSON.stringify(submitted)) <= Buffer.byteLength(JSON.stringify(legacyLike)) * 0.6, '引用式提交应比同一完整历史集合至少减少 40%')
})

test('未选择来源版本时，test-case-design/v2 的 cases: [] 由 Service 明确拒绝', async () => {
  const store = await storeWithPublishedRequirement()
  const runtime: PlanningAgentRuntime = { readiness: async () => ({ ready: true, agents: [] }), freezeConfiguration: async () => frozenConfiguration(), execute: async () => ({ schemaVersion: 'test-case-design/v2', content: referenceCandidate([]) }) }
  const service = new TestDesignService(store, runtime)
  const design = await service.createDesign('project-version-1', { name: '空候选', objective: '没有来源版本时不能提交空候选', knowledgeAugmentation: { mode: 'disabled' } }, principal)
  const run = await service.createRun('project-version-1', design.id, 'empty-without-history', principal)
  const completed = await waitForCompletedRun(service, 'project-version-1', design.id, run.id)
  assert.equal(completed.status, 'failed')
  assert.match(completed.error ?? '', /TEST_DESIGN_CANDIDATE_EMPTY_WITHOUT_REUSABLE_HISTORY/u)
})

test('仅保留来源关系而未继承时，不暴露也不加载来源冻结历史用例', async () => {
  const store = await storeWithPublishedRequirement()
  await installHistoricalLibrary(store, 1)
  await store.transaction(state => { state.projectVersions.find(item => item.id === 'project-version-1')!.inheritRequirementBindings = false })
  const service = new TestDesignService(store)
  const inputs = await service.inputCandidates('project-version-1')
  assert.equal(inputs.projectVersion.inheritsSourceAssets, false)
  assert.equal(inputs.testCaseLibraryVersions.length, 0)
  await assert.rejects(
    () => service.createDesign('project-version-1', { name: '错误继承', objective: '未勾选继承不能选择来源历史', knowledgeAugmentation: { mode: 'disabled' }, historicalLibrarySelection: { mode: 'library_version', testCaseLibraryVersionId: 'library-v1' } }, principal),
    /TEST_DESIGN_SOURCE_INHERITANCE_REQUIRED/u,
  )
})

test('自动创建由 Service 选择来源版本最新正式用例库，并在 Run 启动后冻结确切版本与成员 Revision', async () => {
  const store = await storeWithPublishedRequirement()
  await installHistoricalLibrary(store, 1)
  await addHistoricalLibraryVersion(store, 2, '2026-08-20T01:00:00.000Z')
  await store.transaction(state => { const analysis = state.reviewRuns.find(item => item.id === 'review-run-1')!; analysis.result = { summary: { overview: '自动测试设计' }, testFocus: [] } as never })
  const runtime: PlanningAgentRuntime = { readiness: async () => ({ ready: true, agents: [] }), freezeConfiguration: async () => frozenConfiguration(), execute: async () => ({ schemaVersion: 'test-case-design/v2', content: referenceCandidate([]) }) }
  const service = new TestDesignService(store, runtime)
  const created = await service.createAutomaticDesignAndRun('project-version-1', 'review-run-1')
  assert.deepEqual(created.design.input.historicalLibrarySelection, { mode: 'latest_library' })
  assert.equal(created.run.baseTestCaseLibraryVersionId, 'library-v2')
  assert.equal(created.run.baseTestCaseLibraryVersionSha256, 'library-v2-sha256')
  assert.deepEqual(created.run.historicalSnapshot.items.map(item => (item.locator as { revision: number }).revision), [1])
  const frozenSnapshot = structuredClone(created.run.historicalSnapshot)

  await addHistoricalLibraryVersion(store, 3, '2026-08-20T02:00:00.000Z')
  const persisted = await service.getRun('project-version-1', created.design.id, created.run.id)
  assert.deepEqual(persisted.historicalSnapshot, frozenSnapshot)
  assert.equal(persisted.baseTestCaseLibraryVersionId, 'library-v2')
  const nextRun = await service.createRun('project-version-1', created.design.id, 'test-design-run:auto:new-request', principal)
  assert.equal(nextRun.baseTestCaseLibraryVersionId, 'library-v3')
  assert.equal((await service.getRun('project-version-1', created.design.id, created.run.id)).baseTestCaseLibraryVersionId, 'library-v2')
})

test('来源版本没有正式用例库时，自动创建按首次全量生成且不报错', async () => {
  const store = await storeWithPublishedRequirement()
  await store.transaction(state => {
    const target = state.projectVersions.find(item => item.id === 'project-version-1')!
    target.sourceProjectVersionId = 'project-version-source-empty'
    target.inheritRequirementBindings = true
    state.projectVersions.push({ id: 'project-version-source-empty', projectId: target.projectId, name: 'V0', status: 'locked', inheritRequirementBindings: false, createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z' })
    const analysis = state.reviewRuns.find(item => item.id === 'review-run-1')!
    analysis.result = { summary: { overview: '首次全量设计' }, testFocus: [] } as never
  })
  const runtime: PlanningAgentRuntime = { readiness: async () => ({ ready: true, agents: [] }), freezeConfiguration: async () => frozenConfiguration(), execute: async () => ({ schemaVersion: 'test-case-design/v1', content: candidate([caseCandidate('TC-FIRST', '首次生成')], [stateClaim('SC-FIRST', 'TC-FIRST', 'todo->in_progress', 'positive', '状态为 in_progress')]) }) }
  const service = new TestDesignService(store, runtime)
  const created = await service.createAutomaticDesignAndRun('project-version-1', 'review-run-1')
  assert.deepEqual(created.design.input.historicalLibrarySelection, { mode: 'none' })
  assert.equal(created.run.historicalSnapshot.items.length, 0)
  assert.equal(created.run.baseTestCaseLibraryVersionId, undefined)
})

test('同一 TestDesign 的重试幂等、两个 Run 候选 Proposal Audit 审核与快照完全隔离', async () => {
  const store = await storeWithPublishedRequirement()
  await installHistoricalLibrary(store, 2)
  const runtime: PlanningAgentRuntime = { readiness: async () => ({ ready: true, agents: [] }), freezeConfiguration: async () => frozenConfiguration(), execute: async () => ({ schemaVersion: 'test-case-design/v2', content: referenceCandidate([]) }) }
  let projectedAsset = 0
  const projector = { ingest: async () => ({ version: { id: `projected-asset-${++projectedAsset}` }, task: null }) }
  const service = new TestDesignService(store, runtime, projector)
  const design = await service.createDesign('project-version-1', { name: '并行运行隔离', objective: '验证同一设计的运行隔离', knowledgeAugmentation: { mode: 'disabled' }, historicalLibrarySelection: { mode: 'library_version', testCaseLibraryVersionId: 'library-v1' } }, principal)
  const runA = await service.createRun('project-version-1', design.id, 'test-design-run:fixture:request-a', principal)
  const retryA = await service.createRun('project-version-1', design.id, 'test-design-run:fixture:request-a', principal)
  const runB = await service.createRun('project-version-1', design.id, 'test-design-run:fixture:request-b', principal)
  assert.equal(retryA.id, runA.id)
  assert.notEqual(runB.id, runA.id)
  const completedA = await waitForCompletedRun(service, 'project-version-1', design.id, runA.id)
  const completedB = await waitForCompletedRun(service, 'project-version-1', design.id, runB.id)
  assert.notEqual(completedA.testCases[0]?.id, completedB.testCases[0]?.id)
  assert.notEqual(completedA.caseChangeProposals[0]?.id, completedB.caseChangeProposals[0]?.id)
  assert.notEqual(completedA.coverageAudits[0]?.id, completedB.coverageAudits[0]?.id)
  assert.notEqual(completedA.artifacts[0]?.id, completedB.artifacts[0]?.id)
  assert.equal(completedA.historicalSnapshot.baseTestCaseLibraryVersionId, 'library-v1')
  assert.equal(completedB.historicalSnapshot.baseTestCaseLibraryVersionId, 'library-v1')
  const beforeB = structuredClone(completedB)

  const auditAId = completedA.coverageAudits.at(-1)!.id
  for (const testCase of completedA.testCases) await service.reviewCase('project-version-1', design.id, completedA.id, testCase.id, { decision: 'approve', targetRevision: testCase.currentRevision, comment: 'Run A 独立审核' }, principal)
  assert.equal((await service.getRun('project-version-1', design.id, completedA.id)).coverageAudits.at(-1)?.id, auditAId, '审核不应触发重复 Coverage Audit')
  const afterB = await service.getRun('project-version-1', design.id, completedB.id)
  assert.deepEqual(afterB.testCases, beforeB.testCases)
  assert.deepEqual(afterB.caseChangeProposals, beforeB.caseChangeProposals)
  assert.deepEqual(afterB.coverageAudits, beforeB.coverageAudits)
  assert.deepEqual(afterB.artifacts, beforeB.artifacts)
  assert.deepEqual(afterB.historicalSnapshot, beforeB.historicalSnapshot)

  for (const testCase of afterB.testCases) await service.reviewCase('project-version-1', design.id, afterB.id, testCase.id, { decision: 'approve', targetRevision: testCase.currentRevision, comment: 'Run B 独立审核' }, principal)
  const publishableA = await service.getRun('project-version-1', design.id, completedA.id)
  const publishableB = await service.getRun('project-version-1', design.id, completedB.id)
  const auditA = publishableA.coverageAudits.at(-1)!
  assert.deepEqual(auditA.blockers.filter(item => item.resolution !== 'execution_handoff'), [])
  const publishedA = await service.publishLibraryVersion('project-version-1', design.id, publishableA.id, { name: 'Run A 正式库', expectedAuditId: auditA.id, expectedCaseSetSha256: auditA.caseSetSha256, expectedProposalSha256: publishableA.caseChangeProposalSha256 }, principal)
  const bAfterAPublished = await service.getRun('project-version-1', design.id, afterB.id)
  assert.deepEqual(bAfterAPublished.testCases, publishableB.testCases)
  assert.deepEqual(bAfterAPublished.caseChangeProposals, publishableB.caseChangeProposals)
  assert.deepEqual(bAfterAPublished.coverageAudits, publishableB.coverageAudits)
  assert.deepEqual(bAfterAPublished.historicalSnapshot, beforeB.historicalSnapshot)
  const auditB = bAfterAPublished.coverageAudits.at(-1)!
  const publishedB = await service.publishLibraryVersion('project-version-1', design.id, bAfterAPublished.id, { name: 'Run B 正式库', expectedAuditId: auditB.id, expectedCaseSetSha256: auditB.caseSetSha256, expectedProposalSha256: bAfterAPublished.caseChangeProposalSha256 }, principal)
  assert.notEqual(publishedA.id, publishedB.id)
  assert.equal(publishedB.version, publishedA.version + 1)
  assert.equal(publishedA.sourceRunId, completedA.id)
  assert.equal(publishedB.sourceRunId, completedB.id)
  const history = await service.listRuns('project-version-1', design.id)
  assert.equal(history.length, 2)
  assert.deepEqual(new Set(history.map(item => item.id)), new Set([completedA.id, completedB.id]))
  assert.equal(history.find(item => item.id === completedB.id)?.pendingManualProposalCount, 0)
  assert.equal(history.every(item => item.published), true)
})

test('Patch 修改复用历史 Candidate 时仅创建当前 Run Revision，Proposal/Claim/决策保持一致且相同 Patch 幂等', async () => {
  const store = await storeWithPublishedRequirement()
  await installHistoricalLibrary(store, 1)
  const runtime: PlanningAgentRuntime = { readiness: async () => ({ ready: true, agents: [] }), freezeConfiguration: async () => frozenConfiguration(), execute: async () => ({ schemaVersion: 'test-case-design/v2', content: referenceCandidate([caseCandidate('TC-AI', '当前版本 AI 新增用例')]) }) }
  const service = new TestDesignService(store, runtime)
  const design = await service.createDesign('project-version-1', { name: '历史 Patch 治理', objective: '校验 Repair 当前 Candidate 与 Proposal 一致性', knowledgeAugmentation: { mode: 'disabled' }, historicalLibrarySelection: { mode: 'library_version', testCaseLibraryVersionId: 'library-v1' } }, principal)
  const created = await service.createRun('project-version-1', design.id, 'history-patch-governance', principal)
  const completed = await waitForCompletedRun(service, 'project-version-1', design.id, created.id)
  assert.equal(completed.status, 'succeeded', completed.error)
  const reuse = completed.caseChangeProposals.find(item => item.operation === 'reuse')!
  assert.equal(reuse.decision, 'accepted')
  await assert.rejects(() => service.decideCaseChangeProposal('project-version-1', design.id, completed.id, reuse.id, { expectedVersion: reuse.decisions.length, decision: 'accepted' }, principal), /CASE_CHANGE_PROPOSAL_AUTOMATIC/u)

  const run = await service.getRun('project-version-1', design.id, completed.id)
  const historical = run.testCases.find(item => item.origin === 'historical_unchanged')!
  const sourceBefore = structuredClone((await store.snapshot()).testDesignState!.libraryCases.find(item => item.id === reuse.sourceCaseId)!.revisions)
  const sourceClaim = run.scenarioClaims.find(item => item.caseRef === historical.candidateRef)!
  const { caseRef: _caseRef, requirementRefs: _requirementRefs, ...inlineClaim } = sourceClaim
  run.basisSnapshot.items.push({ id: 'requirement-rp-alt', kind: 'requirement_release', sourceId: 'release-1:RP-ALT', contentSha256: 'b'.repeat(64), content: '{"clientRequirementPointId":"RP-ALT"}', locator: { requirementReleaseId: 'release-1', requirementPointId: 'RP-ALT' } })
  const changedContent = { ...historical.revisions[historical.currentRevision].content, title: '来源用例的当前 Run Repair Revision', requirementRefs: ['RP-STATE', 'RP-ALT'] }
  const patch = (baseCandidateSha256: string) => ({ schemaVersion: 'test-design-repair/v2' as const, baseCandidateSha256, upsertCases: [{ ref: historical.candidateRef!, ...changedContent, changeReason: 'Coverage Audit 修复历史复用 Candidate', confidence: 0.93, coverageClaims: [inlineClaim] }], removeCaseRefs: [], upsertDataRequirements: [], removeDataRequirementRefs: [], dimensionAssessmentUpdates: [] })
  materializeCaseDesign(run, patch(canonicalSha256(repairCandidateContent(run))), principal.subjectId, true)
  const changedCase = run.testCases.find(item => item.id === historical.id)!
  const updated = run.caseChangeProposals.find(item => item.id === reuse.id)!
  assert.equal(changedCase.origin, 'historical_modified')
  assert.equal(changedCase.revisions.length, 2)
  assert.equal(updated.operation, 'update')
  assert.deepEqual(updated.requirementRefs, changedCase.revisions[changedCase.currentRevision].content.requirementRefs)
  assert.deepEqual(run.scenarioClaims.find(item => item.caseRef === historical.candidateRef)?.requirementRefs, changedCase.revisions[changedCase.currentRevision].content.requirementRefs)
  assert.equal(updated.candidateContent?.title, changedContent.title)
  assert.ok(updated.diff.length > 0)
  assert.equal(updated.decision, 'pending')
  assert.equal(updated.decidedBy, undefined)
  assert.equal(updated.appliedCaseId, undefined)
  assert.equal(updated.decisions.length, 1, '旧 accepted 决策保留为审计历史，但不再是有效批准')
  assert.deepEqual((await store.snapshot()).testDesignState!.libraryCases.find(item => item.id === reuse.sourceCaseId)!.revisions, sourceBefore, '来源冻结 Revision 不得被 Repair 改写')
  const revisionCount = changedCase.revisions.length
  const decisionCount = updated.decisions.length
  materializeCaseDesign(run, patch(canonicalSha256(repairCandidateContent(run))), principal.subjectId, true)
  assert.equal(changedCase.revisions.length, revisionCount, '语义无变化的 Patch 不创建伪 Revision')
  assert.equal(updated.decisions.length, decisionCount, '语义无变化的 Patch 不重复重置人工决策')
  await store.transaction(state => {
    const persisted = state.testDesignState!.runs.find(item => item.id === run.id)!
    Object.assign(persisted, structuredClone(run))
  })
  await service.reviewCase('project-version-1', design.id, run.id, changedCase.id, { decision: 'approve', targetRevision: changedCase.currentRevision }, principal)
  assert.equal((await service.getRun('project-version-1', design.id, run.id)).caseChangeProposals.find(item => item.id === updated.id)?.decision, 'accepted')
})

test('未变化历史复用与当前 AI Candidate 并存时，可修复的 Coverage Blocker 仍进入自动 Repair', async () => {
  const store = await storeWithPublishedRequirement()
  await installHistoricalLibrary(store, 1)
  const stages: string[] = []
  const runtime: PlanningAgentRuntime = {
    readiness: async () => ({ ready: true, agents: [] }),
    freezeConfiguration: async () => frozenConfiguration(),
    execute: async input => {
      stages.push(input.stage)
      if (input.stage === 'test_case_design') return { schemaVersion: 'test-case-design/v2', content: referenceCandidate([{ ...caseCandidate('TC-MERGED', '当前 AI 合并状态迁移'), coverageClaims: [inlineStateClaim('SC-AI-TODO', 'todo->in_progress', 'positive', '状态变更后为 in_progress'), inlineStateClaim('SC-AI-DONE', 'in_progress->completed', 'positive', '状态变更后为 completed')] }]) }
      const upstream = input.upstream as { baseCandidateSha256: string }
      return { schemaVersion: 'test-design-repair/v2', content: { schemaVersion: 'test-design-repair/v2', baseCandidateSha256: upstream.baseCandidateSha256, upsertCases: [{ ...caseCandidate('TC-AI-TODO', 'AI todo 到 in_progress'), coverageClaims: [inlineStateClaim('SC-AI-TODO', 'todo->in_progress', 'positive', '状态变更后为 in_progress')] }, { ...caseCandidate('TC-AI-DONE', 'AI in_progress 到 completed'), coverageClaims: [inlineStateClaim('SC-AI-DONE', 'in_progress->completed', 'positive', '状态变更后为 completed')] }], removeCaseRefs: ['TC-MERGED'], upsertDataRequirements: [], removeDataRequirementRefs: [], dimensionAssessmentUpdates: [] } }
    },
  }
  const service = new TestDesignService(store, runtime)
  const design = await service.createDesign('project-version-1', { name: '历史与 AI Repair', objective: '历史复用不应阻塞当前 Candidate 自动修复', knowledgeAugmentation: { mode: 'disabled' }, historicalLibrarySelection: { mode: 'library_version', testCaseLibraryVersionId: 'library-v1' } }, principal)
  const created = await service.createRun('project-version-1', design.id, 'history-and-ai-repair', principal)
  const completed = await waitForCompletedRun(service, 'project-version-1', design.id, created.id)
  assert.equal(completed.status, 'succeeded', completed.error)
  assert.deepEqual(stages, ['test_case_design', 'test_design_repair'])
  assert.equal(completed.automaticRepair?.attempt, 1)
  assert.ok(completed.testCases.some(item => item.origin === 'historical_unchanged'))
  assert.deepEqual(completed.testCases.filter(item => !item.tombstonedAt).map(item => item.candidateRef).sort(), ['TC-AI-DONE', 'TC-AI-TODO', completed.testCases.find(item => item.origin === 'historical_unchanged')!.candidateRef].sort())
})

test('test-design-repair/v2 仅应用指定 Patch、重跑审计并保存修复前后完整 Diff', async () => {
  const store = await storeWithPublishedRequirement()
  let repairSubmission: Record<string, unknown> | undefined
  const runtime: PlanningAgentRuntime = {
    readiness: async () => ({ ready: true, agents: [] }),
    freezeConfiguration: async () => frozenConfiguration(),
    execute: async input => {
      if (input.stage === 'test_case_design') {
        return {
          schemaVersion: 'test-case-design/v2',
          content: referenceCandidate([{
            ...caseCandidate('TC-MERGED', '合并状态迁移'),
            coverageClaims: [inlineStateClaim('SC-TODO', 'todo->in_progress', 'positive', '状态变更后为 in_progress'), inlineStateClaim('SC-DONE', 'in_progress->completed', 'positive', '状态变更后为 completed')],
          }]),
        }
      }
      const upstream = input.upstream as { baseCandidateSha256: string }
      repairSubmission = {
        schemaVersion: 'test-design-repair/v2',
        baseCandidateSha256: upstream.baseCandidateSha256,
        upsertCases: [
          { ...caseCandidate('TC-TODO', 'todo 到 in_progress'), coverageClaims: [inlineStateClaim('SC-TODO', 'todo->in_progress', 'positive', '状态变更后为 in_progress')] },
          { ...caseCandidate('TC-DONE', 'in_progress 到 completed'), coverageClaims: [inlineStateClaim('SC-DONE', 'in_progress->completed', 'positive', '状态变更后为 completed')] },
        ],
        removeCaseRefs: ['TC-MERGED'],
        upsertDataRequirements: [],
        removeDataRequirementRefs: [],
        dimensionAssessmentUpdates: [],
      }
      return { schemaVersion: 'test-design-repair/v2', content: repairSubmission }
    },
  }
  const service = new TestDesignService(store, runtime)
  const design = await service.createDesign('project-version-1', { name: 'Patch 修复', objective: '验证 Patch 范围', knowledgeAugmentation: { mode: 'disabled' } }, principal)
  const run = await service.createRun('project-version-1', design.id, 'repair-patch', principal)
  const completed = await waitForCompletedRun(service, 'project-version-1', design.id, run.id)

  assert.equal(completed.status, 'succeeded', completed.error)
  assert.equal(completed.automaticRepair?.attempt, 1)
  assert.deepEqual(completed.testCases.filter(item => !item.tombstonedAt).map(item => item.candidateRef).sort(), ['TC-DONE', 'TC-TODO'])
  assert.ok(completed.coverageAudits.slice(0, -1).every(item => item.status === 'stale'))
  const repairArtifact = completed.artifacts.find(item => item.id === completed.nodeRuns.find(item => item.nodeKey === 'test_design_repair')?.outputArtifactId)
  assert.equal(repairArtifact?.schemaVersion, 'test-design-repair-snapshot/v2')
  assert.ok(Array.isArray((repairArtifact?.content as { diff?: unknown[] }).diff) && (repairArtifact?.content as { diff: unknown[] }).diff.length > 0)
  assert.equal('cases' in (repairSubmission ?? {}), false, 'Repair v2 不重复提交完整 cases[]')
})

test('test-design-repair/v2 拒绝过期 baseCandidateSha256，不会将 Patch 应用到其他快照', async () => {
  const store = await storeWithPublishedRequirement()
  const runtime: PlanningAgentRuntime = {
    readiness: async () => ({ ready: true, agents: [] }),
    freezeConfiguration: async () => frozenConfiguration(),
    execute: async input => input.stage === 'test_case_design'
      ? { schemaVersion: 'test-case-design/v2', content: referenceCandidate([{ ...caseCandidate('TC-MERGED', '合并状态迁移'), coverageClaims: [inlineStateClaim('SC-TODO', 'todo->in_progress', 'positive', '状态变更后为 in_progress'), inlineStateClaim('SC-DONE', 'in_progress->completed', 'positive', '状态变更后为 completed')] }]) }
      : { schemaVersion: 'test-design-repair/v2', content: { schemaVersion: 'test-design-repair/v2', baseCandidateSha256: '0'.repeat(64), upsertCases: [], removeCaseRefs: [], upsertDataRequirements: [], removeDataRequirementRefs: [], dimensionAssessmentUpdates: [] } },
  }
  const service = new TestDesignService(store, runtime)
  const design = await service.createDesign('project-version-1', { name: '过期 Patch', objective: '验证 Hash 冲突', knowledgeAugmentation: { mode: 'disabled' } }, principal)
  const run = await service.createRun('project-version-1', design.id, 'stale-repair-patch', principal)
  const completed = await waitForCompletedRun(service, 'project-version-1', design.id, run.id)
  assert.equal(completed.status, 'failed')
  assert.match(completed.error ?? '', /TEST_DESIGN_REPAIR_BASE_CANDIDATE_CONFLICT/)
})

test('Case 审核不使 Audit stale，create 随批准自动接受；内容修改才失效且重新审核后可直接发布', async () => {
  const store = await storeWithPublishedRequirement()
  const original = caseCandidate('TC-CREATE', longTitle('新增用例'))
  const runtime: PlanningAgentRuntime = { readiness: async () => ({ ready: true, agents: [] }), freezeConfiguration: async () => frozenConfiguration(), execute: async () => ({ schemaVersion: 'test-case-design/v2', content: referenceCandidate([original]) }) }
  const projector = { ingest: async () => ({ version: { id: 'projected-create-version' }, task: null }) }
  const service = new TestDesignService(store, runtime, projector)
  const design = await service.createDesign('project-version-1', { name: '自动 Proposal 发布', objective: '验证审核与 Coverage 解耦', knowledgeAugmentation: { mode: 'disabled' }, historicalLibrarySelection: { mode: 'none' } }, principal)
  const created = await service.createRun('project-version-1', design.id, 'automatic-create-publication', principal)
  const completed = await waitForCompletedRun(service, 'project-version-1', design.id, created.id)
  const initialAudit = completed.coverageAudits.at(-1)!
  const testCase = completed.testCases[0]!
  const createProposal = completed.caseChangeProposals.find(item => item.operation === 'create')!
  assert.equal(initialAudit.status, 'valid')
  assert.equal(initialAudit.blockers.some(item => item.code === 'TEST_CASE_REVIEW_REQUIRED'), false)
  assert.equal(createProposal.decision, 'pending')

  await service.reviewCase('project-version-1', design.id, completed.id, testCase.id, { decision: 'approve', targetRevision: testCase.currentRevision }, principal)
  let current = await service.getRun('project-version-1', design.id, completed.id)
  assert.equal(current.coverageAudits.at(-1)?.id, initialAudit.id)
  assert.equal(current.coverageAudits.at(-1)?.status, 'valid')
  assert.equal(current.caseChangeProposals.find(item => item.id === createProposal.id)?.decision, 'accepted')

  await service.reviewCase('project-version-1', design.id, completed.id, testCase.id, { decision: 'request_revision', targetRevision: testCase.currentRevision, comment: '补充标题说明' }, principal)
  assert.equal((await service.getRun('project-version-1', design.id, completed.id)).coverageAudits.at(-1)?.status, 'valid')
  const loaded = await service.getCase('project-version-1', design.id, completed.id, testCase.id) as { etag: string; content: ReturnType<typeof validateTestCaseContent> }
  await service.patchCase('project-version-1', design.id, completed.id, testCase.id, loaded.etag, { content: { ...loaded.content, title: longTitle('修改后的新增用例') }, reason: '修改实际 Case Content' }, principal)
  current = await service.getRun('project-version-1', design.id, completed.id)
  assert.equal(current.coverageAudits.at(-1)?.status, 'stale')
  assert.equal(current.caseChangeProposals.find(item => item.id === createProposal.id)?.decision, 'pending')

  const revised = current.testCases.find(item => item.id === testCase.id)!
  await service.reviewCase('project-version-1', design.id, completed.id, testCase.id, { decision: 'submit', targetRevision: revised.currentRevision }, principal)
  await service.reviewCase('project-version-1', design.id, completed.id, testCase.id, { decision: 'approve', targetRevision: revised.currentRevision }, principal)
  await service.reAudit('project-version-1', design.id, completed.id)
  current = await service.getRun('project-version-1', design.id, completed.id)
  assert.equal(current.caseChangeProposals.find(item => item.id === createProposal.id)?.decision, 'accepted')
  const audit = current.coverageAudits.at(-1)!
  const version = await service.publishLibraryVersion('project-version-1', design.id, completed.id, { name: '无需二次 Proposal 审核', expectedAuditId: audit.id, expectedCaseSetSha256: audit.caseSetSha256, expectedProposalSha256: current.caseChangeProposalSha256 }, principal)
  assert.equal(version.members.length, 1)
})

test('deprecate 保持人工 Gate，未确认时阻止发布，确认后从新版本移除并废弃正式 Case', async () => {
  const store = await storeWithPublishedRequirement()
  await installHistoricalLibrary(store, 1)
  const submission = { ...referenceCandidate([caseCandidate('TC-REPLACEMENT', longTitle('替代历史用例'))]), historicalChanges: [{ operation: 'deprecate' as const, sourceCaseId: 'CASE-001', sourceRevision: 1, reason: '当前 Requirement 已由新场景替代', confidence: 0.98 }] }
  const runtime: PlanningAgentRuntime = { readiness: async () => ({ ready: true, agents: [] }), freezeConfiguration: async () => frozenConfiguration(), execute: async () => ({ schemaVersion: 'test-case-design/v2', content: submission }) }
  const projector = { ingest: async () => ({ version: { id: 'projected-deprecate-version' }, task: null }) }
  const service = new TestDesignService(store, runtime, projector)
  const design = await service.createDesign('project-version-1', { name: '废弃人工门禁', objective: '验证破坏性资产变更', knowledgeAugmentation: { mode: 'disabled' }, historicalLibrarySelection: { mode: 'library_version', testCaseLibraryVersionId: 'library-v1' } }, principal)
  const created = await service.createRun('project-version-1', design.id, 'manual-deprecate-gate', principal)
  const completed = await waitForCompletedRun(service, 'project-version-1', design.id, created.id)
  const newCase = completed.testCases.find(item => item.candidateRef === 'TC-REPLACEMENT')!
  await service.reviewCase('project-version-1', design.id, completed.id, newCase.id, { decision: 'approve', targetRevision: newCase.currentRevision }, principal)
  let current = await service.getRun('project-version-1', design.id, completed.id)
  const deprecate = current.caseChangeProposals.find(item => item.operation === 'deprecate')!
  const audit = current.coverageAudits.at(-1)!
  assert.equal(deprecate.decision, 'pending')
  await assert.rejects(() => service.publishLibraryVersion('project-version-1', design.id, completed.id, { name: '禁止发布', expectedAuditId: audit.id, expectedCaseSetSha256: audit.caseSetSha256, expectedProposalSha256: current.caseChangeProposalSha256 }, principal), /CASE_CHANGE_PROPOSAL_DECISION_REQUIRED/u)

  await service.decideCaseChangeProposal('project-version-1', design.id, completed.id, deprecate.id, { expectedVersion: deprecate.decisions.length, decision: 'deprecated', comment: '确认破坏性资产变更' }, principal)
  current = await service.getRun('project-version-1', design.id, completed.id)
  assert.equal(current.coverageAudits.at(-1)?.status, 'valid')
  const version = await service.publishLibraryVersion('project-version-1', design.id, completed.id, { name: '废弃已确认', expectedAuditId: audit.id, expectedCaseSetSha256: audit.caseSetSha256, expectedProposalSha256: current.caseChangeProposalSha256 }, principal)
  assert.equal(version.members.some(item => item.caseId === 'CASE-001'), false)
  assert.equal((await service.getLibraryCase('project-1', 'CASE-001') as { status: string }).status, 'deprecated')
})

function longTitle(prefix: string) { return `${prefix}：验证任务状态在正常、异常、边界、权限、并发、重试、恢复和跨入口一致性场景下均产生独立且可判定的业务结果，并保持正式 Requirement 追溯。` }

function caseCandidate(ref: string, title: string) {
  return {
    ref,
    schemaVersion: 'test-case/v2',
    title,
    objective: `验证 ${title}`,
    dimension: 'functional',
    requirementRefs: ['RP-STATE'],
    priority: 'P0',
    preconditions: [],
    dataRequirementIds: [],
    cleanup: [],
    dependencies: [],
    executionMethods: [{ method: 'ui', uiSpec: { entry: '/tasks', selectors: [] }, steps: [{ key: 'step-1', action: '变更任务状态', expected: '状态变更结果符合该场景' }], verificationChecks: [], executionReadiness: 'needs_confirmation', automationHint: 'UI selector 待确认' }],
    executionSpec: { kind: 'functional', method: 'ui' },
    sharedVerificationChecks: [],
    tags: [],
    domain: '任务',
  }
}

function inlineStateClaim(ref: string, variant: string, polarity: 'positive' | 'negative', oracle: string) { const [from, to] = variant.split('->'); return { ref, kind: 'state_transition' as const, subject: 'task.status', variant, polarity, oracle, transition: { from: from?.trim() || variant, to: to?.trim() || variant } } }
function referenceCandidate(cases: Array<ReturnType<typeof caseCandidate> & { coverageClaims?: ReturnType<typeof inlineStateClaim>[] }>) {
  return {
    schemaVersion: 'test-case-design/v2' as const,
    cases: cases.map(item => ({ ...item, coverageClaims: item.coverageClaims ?? [inlineStateClaim(`SC-${item.ref}`, 'todo->in_progress', 'positive', '状态变更后为 in_progress')] })),
    dimensionAssessments: [
      { dimension: 'functional' as const, applicable: true, reason: 'Requirement 明确任务状态行为', requirementRefs: ['RP-STATE'], risks: ['状态转换'], scenarioClaims: ['状态迁移'] },
      { dimension: 'performance' as const, applicable: false, reason: 'Requirement 未声明性能目标', requirementRefs: ['RP-STATE'], risks: [], scenarioClaims: [] },
      { dimension: 'stability' as const, applicable: false, reason: 'Requirement 未声明稳定性目标', requirementRefs: ['RP-STATE'], risks: [], scenarioClaims: [] },
      { dimension: 'compatibility' as const, applicable: false, reason: 'Requirement 未声明兼容性矩阵', requirementRefs: ['RP-STATE'], risks: [], scenarioClaims: [] },
      { dimension: 'security' as const, applicable: false, reason: 'Requirement 未声明安全规则', requirementRefs: ['RP-STATE'], risks: [], scenarioClaims: [] },
    ],
  }
}

async function installHistoricalLibrary(store: JsonStore, count: number) {
  await store.transaction(state => {
    const requirements = Array.from({ length: count }, (_, index) => {
      const source = caseCandidate(`HISTORY-${index + 1}`, `冻结历史 ${index + 1}`)
      const { ref: _ref, ...base } = source
      const content = validateTestCaseContent({ ...base, executionMethods: [{ ...source.executionMethods[0], executionReadiness: 'ready' as const }], executionSpec: { kind: 'functional' as const, method: 'ui' as const } })
      const semanticSha256 = canonicalSha256({ ...content, tags: [...content.tags].sort() })
      return { caseId: `CASE-${String(index + 1).padStart(3, '0')}`, content, semanticSha256 }
    })
    const target = state.projectVersions.find(item => item.id === 'project-version-1')!
    const sourceProjectVersionId = 'project-version-source'
    target.sourceProjectVersionId = sourceProjectVersionId
    target.inheritRequirementBindings = true
    state.projectVersions.push({ id: sourceProjectVersionId, projectId: target.projectId, name: 'V0', status: 'locked', inheritRequirementBindings: false, createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z' } as never)
    state.projectVersionRequirementBindings.push({ id: 'binding-source', projectVersionId: sourceProjectVersionId, assetId: 'asset-1', assetVersionId: 'version-fixed', createdAt: '2026-08-19T00:00:00.000Z' }, { id: 'binding-target', projectVersionId: target.id, assetId: 'asset-1', assetVersionId: 'version-fixed', createdAt: '2026-08-20T00:00:00.000Z' })
    state.testDesignState = {
      architectureVersion: 'single-agent-skills/v1', designs: [], runs: [{ id: 'history-run', projectVersionId: sourceProjectVersionId } as never], caseSetVersions: [], suiteDrafts: [], suiteVersions: [], executionHandoffs: [], legacyMigrations: [],
      libraryCases: requirements.map(item => ({ id: item.caseId, projectId: 'project-1', currentRevision: 1, status: 'active', createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z', revisions: [{ revision: 1, content: item.content, contentSha256: canonicalSha256(item.content), semanticSha256: item.semanticSha256, changeReason: '冻结 Fixture', createdBy: 'test-owner', createdAt: '2026-08-20T00:00:00.000Z' }] })),
      libraryVersions: [{ id: 'library-v1', projectId: 'project-1', version: 1, name: '冻结历史', sourceRunId: 'history-run', dataRequirementSet: { id: 'data-history', version: 1, requirements: [], contentSha256: canonicalSha256([]), createdAt: '2026-08-20T00:00:00.000Z', createdBy: 'test-owner' }, members: requirements.map((item, index) => ({ caseId: item.caseId, revision: 1, ordinal: index, contentSha256: canonicalSha256(item.content), frozenContent: item.content })), contentSha256: canonicalSha256(requirements.map(item => item.caseId)), publishedBy: 'test-owner', publishedAt: '2026-08-20T00:00:00.000Z', projection: { status: 'pending', files: [] }, publicationSummary: { proposalStatistics: { reuse: count, update: 0, create: 0, deprecate: 0, reference: 0 }, dimensionStatistics: { functional: count }, coverageAudit: { id: 'history-audit', statistics: { totalBasis: 1, coveredBasis: 1, totalCases: count }, blockerCount: 0 } } }],
    } as never
  })
}

async function addHistoricalLibraryVersion(store: JsonStore, version: number, publishedAt: string) {
  await store.transaction(state => {
    const aggregate = state.testDesignState!
    const source = aggregate.libraryVersions.find(item => item.id === 'library-v1')!
    const sourceProjectVersionId = state.projectVersions.find(item => item.id === 'project-version-1')!.sourceProjectVersionId!
    const sourceRunId = `history-run-${version}`
    aggregate.runs.push({ id: sourceRunId, projectVersionId: sourceProjectVersionId } as never)
    aggregate.libraryVersions.push({ ...structuredClone(source), id: `library-v${version}`, version, name: `冻结历史 V${version}`, sourceRunId, contentSha256: `library-v${version}-sha256`, publishedAt })
  })
}

function stateClaim(ref: string, caseRef: string, variant: string, polarity: 'positive' | 'negative', oracle: string) { const [from, to] = variant.split('->'); return { ref, caseRef, requirementRefs: ['RP-STATE'], kind: 'state_transition' as const, subject: 'task.status', variant, polarity, oracle, transition: { from: from?.trim() || variant, to: to?.trim() || variant } } }
function candidate(cases: ReturnType<typeof caseCandidate>[], scenarioClaims: ReturnType<typeof stateClaim>[], schemaVersion: 'test-case-design/v1' | 'test-design-repair/v1' = 'test-case-design/v1') { return { schemaVersion, cases, scenarioClaims, dataRequirements: [], findings: [], confirmationItems: [], proposals: [] } }

async function storeWithPublishedRequirement() {
  const store = new JsonStore(null)
  await store.load()
  const requirementsContent = json({ schemaVersion: 'requirements/v1', releaseId: 'release-1', projectVersionId: 'project-version-1', verificationRunId: 'review-run-1', sourceAssetVersions: [{ assetVersionId: 'version-fixed' }], requirements: [{ clientRequirementPointId: 'RP-STATE', title: '任务状态转换', description: '任务状态具有正常、异常、边界、权限和状态规则。', evidenceRefs: [] }] })
  const requirementsHash = sha256(requirementsContent)
  const manifestContent = json({ schemaVersion: 'requirement-release-manifest/v1', releaseId: 'release-1', projectVersionId: 'project-version-1', verificationRunId: 'review-run-1', artifacts: [{ fileName: 'requirements.json', mediaType: 'application/json', contentSha256: requirementsHash }], machineReadableEntryPoints: { requirements: 'requirements.json' } })
  await store.transaction(state => {
    state.projects.push({ id: 'project-1', name: '任务项目', createdAt: '2026-08-20T00:00:00.000Z' })
    state.projectVersions.push({ id: 'project-version-1', projectId: 'project-1', name: 'V1', status: 'open', requirementReleaseBinding: { releaseId: 'release-1', verificationRunId: 'review-run-1', requirementsJsonSha256: requirementsHash, boundAt: '2026-08-20T00:03:00.000Z' }, activeRequirementReleaseId: 'release-1', createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:03:00.000Z' } as never)
    state.knowledgeBases.push({ id: 'kb-1', projectId: 'project-1', name: '项目知识库', createdAt: '2026-08-20T00:00:00.000Z', activeIndexVersionId: 'index-1', activeConfigVersionId: 'config-1' })
    state.indexes.push({ id: 'index-1', knowledgeBaseId: 'kb-1', number: 1, status: 'active', configVersionId: 'config-1', assetVersionIds: [], indexedChunks: [], createdAt: '2026-08-20T00:00:00.000Z' } as never)
    state.reviewRuns.push({ id: 'review-run-1', projectVersionId: 'project-version-1', assetId: 'asset-1', assetVersionId: 'version-fixed', documentTitle: '已发布需求', documentVersion: 1, logicalPath: 'workspace/branches/V1/input/requirements', sourceId: 'source-1', modelId: 'model-1', modelLabel: 'model', status: 'succeeded', step: 'completed', progress: 100, createdAt: '2026-08-20T00:00:00.000Z', finishedAt: '2026-08-20T00:01:00.000Z', snapshot: { currentInputRefs: [] } as never, result: {} as never, workflow: { currentStage: 'release', release: { id: 'release-1', schemaVersion: 'requirement-release-package/v1', status: 'published', projectVersionId: 'project-version-1', verificationRunId: 'review-run-1', sourceAssetVersionIds: ['version-fixed'], generationExecution: {} as never, artifacts: [{ fileName: 'requirements.json', mediaType: 'application/json', content: requirementsContent, contentSha256: requirementsHash }, { fileName: 'manifest.json', mediaType: 'application/json', content: manifestContent, contentSha256: sha256(manifestContent) }], contentSha256: sha256(manifestContent), createdAt: '2026-08-20T00:02:00.000Z', createdBy: 'owner', publishedAt: '2026-08-20T00:03:00.000Z', publishedBy: 'owner' } } } as never)
  })
  return store
}

function json(value: unknown) { return `${JSON.stringify(value, null, 2)}\n` }
function sha256(value: string) { return createHash('sha256').update(value).digest('hex') }
function frozenConfiguration() { return { configurationId: 'config-version-1', configurationVersion: 1, configurationSha256: 'c'.repeat(64), agentDefinition: {} as never, routing: {} as never, primaryModel: { sourceId: 'source-1', modelId: 'model-1', modelName: '模型' }, createdAt: '2026-08-20T00:00:00.000Z', snapshotSha256: 'd'.repeat(64) } }
async function waitForCompletedRun(service: TestDesignService, projectVersionId: string, designId: string, runId: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const run = await service.getRun(projectVersionId, designId, runId)
    if (run.status === 'succeeded' || run.status === 'failed') return run
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('测试设计运行未在预期时间内完成')
}
