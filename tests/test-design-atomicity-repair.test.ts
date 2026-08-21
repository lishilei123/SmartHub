import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import { TestDesignService, type PlanningAgentRuntime } from '../server/application/test-design-service.js'
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

test('test-case-design/v2 仅提交新用例时，Service 从冻结快照恢复 100 条历史用例并派生完整 reuse/create Proposal', async () => {
  const store = await storeWithPublishedRequirement()
  await installHistoricalLibrary(store, 100)
  const submitted = referenceCandidate([caseCandidate('TC-NEW', '新增状态校验')])
  const runtime: PlanningAgentRuntime = {
    readiness: async () => ({ ready: true, agents: [] }),
    freezeConfiguration: async () => frozenConfiguration(),
    execute: async () => ({ schemaVersion: 'test-case-design/v2', content: submitted }),
  }
  const service = new TestDesignService(store, runtime)
  const design = await service.createDesign('project-version-1', { name: '引用式历史复用', objective: '验证冻结历史复用', knowledgeAugmentation: { mode: 'disabled' } }, principal)
  const run = await service.createRun('project-version-1', design.id, 'reference-submission', principal)
  const completed = await waitForCompletedRun(service, 'project-version-1', design.id, run.id)

  assert.equal(completed.status, 'succeeded', completed.error)
  assert.equal(completed.testCases.filter(item => !item.tombstonedAt).length, 101)
  assert.equal(completed.caseChangeProposals.filter(item => item.operation === 'reuse').length, 100)
  assert.equal(completed.caseChangeProposals.filter(item => item.operation === 'create').length, 1)
  assert.equal(completed.caseChangeProposals.filter(item => item.decision === 'pending').length, 101, 'Service 自动 Proposal 仍须人工处置')
  assert.ok(completed.testCases.some(item => item.origin === 'historical_unchanged' && item.revisions[item.currentRevision].content.title === '冻结历史 1'))
  const artifact = completed.artifacts.find(item => item.id === completed.nodeRuns.find(item => item.nodeKey === 'test_case_design')?.outputArtifactId)
  assert.equal((artifact?.content as { cases?: unknown[] }).cases?.length, 101, 'Artifact 必须保存 Service 生成的完整 Candidate Snapshot')

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
    state.testDesignState = {
      architectureVersion: 'single-agent-skills/v1', designs: [], runs: [], caseSetVersions: [], suiteDrafts: [], suiteVersions: [], executionHandoffs: [], legacyMigrations: [],
      libraryCases: requirements.map(item => ({ id: item.caseId, projectId: 'project-1', currentRevision: 1, status: 'active', createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z', revisions: [{ revision: 1, content: item.content, contentSha256: canonicalSha256(item.content), semanticSha256: item.semanticSha256, changeReason: '冻结 Fixture', createdBy: 'test-owner', createdAt: '2026-08-20T00:00:00.000Z' }] })),
      libraryVersions: [{ id: 'library-v1', projectId: 'project-1', version: 1, name: '冻结历史', sourceRunId: 'history-run', dataRequirementSet: { id: 'data-history', version: 1, requirements: [], contentSha256: canonicalSha256([]), createdAt: '2026-08-20T00:00:00.000Z', createdBy: 'test-owner' }, members: requirements.map((item, index) => ({ caseId: item.caseId, revision: 1, ordinal: index, contentSha256: canonicalSha256(item.content), frozenContent: item.content })), contentSha256: canonicalSha256(requirements.map(item => item.caseId)), publishedBy: 'test-owner', publishedAt: '2026-08-20T00:00:00.000Z', projection: { status: 'pending', files: [] }, publicationSummary: { proposalStatistics: { reuse: count, update: 0, create: 0, deprecate: 0, reference: 0 }, dimensionStatistics: { functional: count }, coverageAudit: { id: 'history-audit', statistics: { totalBasis: 1, coveredBasis: 1, totalCases: count, approvedCases: count }, blockerCount: 0 } } }],
    } as never
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
