import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { TestDesignService, type PlanningAgentRuntime } from '../server/application/test-design-service.js'
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
