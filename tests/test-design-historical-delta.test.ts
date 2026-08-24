import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import { auditTestDesignCoverage } from '../server/application/test-design-coverage-auditor.js'
import { buildEffectiveCaseSet, buildHistoricalSnapshot, mapRequirementsAcrossReleases, materializeCaseDesign, repairCandidateContent, requirementSemanticSha256, testCaseSemanticSha256, TestDesignService } from '../server/application/test-design-service.js'
import { TestDesignError } from '../server/application/test-design-validation.js'
import type { HistoricalCaseSnapshot, LibraryTestCase, TestCaseContent, TestCaseLibraryVersion, TestDesignState, TestDesignWorkflowRun } from '../server/domain/test-design-types.js'
import type { DatabaseState } from '../server/domain/types.js'
import { JsonStore } from '../server/infrastructure/store.js'

const now = '2026-08-21T00:00:00.000Z'
const principal = { subjectId: 'delta-test-owner', displayName: 'Delta 测试负责人' }

function caseContent(title: string, requirementRefs: string[] = ['RP-001'], overrides: Partial<TestCaseContent> = {}): TestCaseContent {
  return {
    schemaVersion: 'test-case/v3', title, dimension: 'functional', priority: 'P1', requirementRefs, executionMethods: ['agent'],
    preconditions: ['被测 Agent 已配置'], steps: [`执行 ${title}`], expectedResults: [`${title} 成功`], agentTestSpec: agentSpec(title), ...overrides,
  }
}

function agentSpec(title: string) { return { input: title, expectedOutcome: `${title} 成功`, requiredTools: [], forbiddenTools: [], requiredActions: [], forbiddenActions: [], argumentAssertions: [], sequenceConstraints: [], businessAssertions: [], artifactAssertions: [], semanticAssertions: [], safetyAssertions: [], executionConstraints: { timeoutMs: 30_000, maxSteps: 20, repeatCount: 1 } } }

function historicalItem(caseId: string, revision: number, content: TestCaseContent) {
  return { id: `history-${caseId}-${revision}`, kind: 'test_case_library' as const, sourceId: `library-v1:${caseId}:${revision}`, contentSha256: canonicalSha256(content), semanticSha256: testCaseSemanticSha256(content), content: structuredClone(content), sourceRequirementReleaseId: 'release-source', sourceRequirementRefs: [...content.requirementRefs], locator: { sourceProjectVersionId: 'project-version-source', testCaseLibraryVersionId: 'library-v1', caseId, revision, status: 'active' } }
}

function runFixture(items: HistoricalCaseSnapshot['items'], requirements = [{ clientRequirementPointId: 'RP-001', coverageTarget: true }]): TestDesignWorkflowRun {
  const currentIds = new Set(requirements.map(item => item.clientRequirementPointId))
  const requirementMappings = [...new Set(items.flatMap(item => item.sourceRequirementRefs))].map(sourceRequirementId => currentIds.has(sourceRequirementId)
    ? { sourceRequirementId, sourceSemanticSha256: canonicalSha256(sourceRequirementId), status: 'exact' as const, targetRequirementId: sourceRequirementId, targetSemanticSha256: canonicalSha256(sourceRequirementId), confidence: 1 }
    : { sourceRequirementId, sourceSemanticSha256: canonicalSha256(sourceRequirementId), status: 'unmapped' as const })
  const historicalBase = { schemaVersion: 'historical-case-snapshot/v2' as const, items, ...(items.length ? { sourceProjectVersionId: 'project-version-source', sourceTestCaseLibraryVersionId: 'library-v1', sourceTestCaseLibraryVersionSha256: 'f'.repeat(64), sourceRequirementReleaseId: 'release-source', sourceRequirementReleaseContentSha256: 'e'.repeat(64) } : {}), requirementMappings, createdAt: now }
  return {
    id: 'run-delta', testDesignId: 'design-delta', projectVersionId: 'project-version-delta', status: 'running', stage: 'test_case_design', progress: 50, idempotencyKey: 'delta',
    basisSnapshot: { schemaVersion: 'test-design-basis-snapshot/v3', projectVersionId: 'project-version-delta', requirementReleaseId: 'release-delta', verificationRunId: 'review-delta', requirementReleaseContentSha256: 'a'.repeat(64), content: { requirements, evidence: [], clarifications: [] } as never, createdAt: now, snapshotSha256: 'b'.repeat(64) },
    agentConfigurationSnapshot: {} as never, currentInputRefs: [], workspaceSnapshot: {} as never, formalWorkspaceFiles: [], retrievalSnapshot: { snapshotSha256: 'c'.repeat(64) } as never,
    historicalSnapshot: { ...historicalBase, snapshotSha256: canonicalSha256(historicalBase) }, ...(items.length ? { baseTestCaseLibraryVersionId: 'library-v1', baseTestCaseLibraryVersionSha256: 'f'.repeat(64) } : {}),
    nodeRuns: [], artifacts: [], gateDecisions: [], testCases: [], caseChangeProposals: [], coverageAudits: [], events: [], createdBy: principal.subjectId, createdAt: now,
  }
}

function candidate(ref: string, content: TestCaseContent) { return { ref, ...content } }

function requirement(id: string, title: string, overrides: Record<string, unknown> = {}) {
  return {
    clientRequirementPointId: id,
    title,
    description: `${title}业务行为`,
    actor: '项目用户',
    action: title,
    object: '项目',
    conditions: ['用户已登录'],
    businessRules: [`必须完成${title}`],
    exceptions: ['操作失败时保持数据一致'],
    acceptanceCriteria: [`可以完成${title}`],
    evidenceRefs: [],
    coverageTarget: true,
    ...overrides,
  }
}

function mappedRun(sourceRequirements: ReturnType<typeof requirement>[], currentRequirements: ReturnType<typeof requirement>[], items: HistoricalCaseSnapshot['items']) {
  const run = runFixture(items, currentRequirements)
  run.historicalSnapshot.requirementMappings = mapRequirementsAcrossReleases(sourceRequirements as never, currentRequirements as never)
  return run
}

test('Requirement Semantic Fingerprint 排除版本内 ID，并把 V1 RP-001 安全映射到 V2 RP-002', () => {
  const sourceRequirement = requirement('RP-001', '创建项目')
  const currentLogin = requirement('RP-001', '用户登录', { object: '账户' })
  const currentCreate = requirement('RP-002', '创建项目')
  assert.equal(requirementSemanticSha256(sourceRequirement as never), requirementSemanticSha256(currentCreate as never))
  const run = mappedRun([sourceRequirement], [currentLogin, currentCreate], [historicalItem('CASE-A', 3, caseContent('创建项目', ['RP-001']))])
  materializeCaseDesign(run, { schemaVersion: 'test-case-design/v3', cases: [] }, principal.subjectId, false)
  const effective = buildEffectiveCaseSet(run)
  assert.deepEqual(effective[0]?.effectiveRequirementRefs, ['RP-002'])
  const audit = auditTestDesignCoverage({ runId: run.id, basis: run.basisSnapshot, retrieval: run.retrievalSnapshot, historical: run.historicalSnapshot, cases: effective })
  assert.ok(audit.relations.some(item => item.requirementId === 'RP-001' && item.status === 'not_covered'))
  assert.ok(audit.relations.some(item => item.requirementId === 'RP-002' && item.caseId === 'CASE-A' && item.status === 'covered'))
})

test('相同 RP 编号但业务语义不同不得产生跨版本 Coverage', () => {
  const sourceRequirement = requirement('RP-001', '创建项目')
  const currentRequirement = requirement('RP-001', '用户登录', { object: '账户' })
  const run = mappedRun([sourceRequirement], [currentRequirement], [historicalItem('CASE-A', 1, caseContent('创建项目', ['RP-001']))])
  materializeCaseDesign(run, { schemaVersion: 'test-case-design/v3', cases: [] }, principal.subjectId, false)
  const effective = buildEffectiveCaseSet(run)
  assert.deepEqual(effective[0]?.effectiveRequirementRefs, [])
  const audit = auditTestDesignCoverage({ runId: run.id, basis: run.basisSnapshot, retrieval: run.retrievalSnapshot, historical: run.historicalSnapshot, cases: effective })
  assert.equal(audit.statistics.coveredBasis, 0)
  assert.ok(audit.blockers.some(item => item.code === 'COVERAGE_REQUIREMENT_UNCOVERED' && item.subjectId === 'RP-001'))
})

test('轻微文字调整只有唯一高置信候选时允许保守映射', () => {
  const source = requirement('RP-001', '创建项目')
  const current = requirement('RP-002', '创建项目', { description: '创建项目业务行为并记录审计结果' })
  const mapping = mapRequirementsAcrossReleases([source] as never, [current] as never)
  assert.equal(mapping[0]?.status, 'high_confidence')
  assert.equal(mapping[0]?.targetRequirementId, 'RP-002')
  assert.ok((mapping[0]?.confidence ?? 0) >= 0.88)
})

test('一个来源 Requirement 对应多个当前语义候选时不映射并生成 Advisory', () => {
  const sourceRequirement = requirement('RP-003', '创建项目')
  const current = [requirement('RP-004', '创建项目'), requirement('RP-005', '创建项目')]
  const run = mappedRun([sourceRequirement], current, [historicalItem('CASE-A', 1, caseContent('创建项目', ['RP-003']))])
  materializeCaseDesign(run, { schemaVersion: 'test-case-design/v3', cases: [] }, principal.subjectId, false)
  const effective = buildEffectiveCaseSet(run)
  const audit = auditTestDesignCoverage({ runId: run.id, basis: run.basisSnapshot, retrieval: run.retrievalSnapshot, historical: run.historicalSnapshot, cases: effective })
  assert.deepEqual(effective[0]?.effectiveRequirementRefs, [])
  assert.ok(run.historicalSnapshot.requirementMappings.some(item => item.status === 'ambiguous'))
  assert.equal(audit.statistics.coveredBasis, 0)
  assert.ok(audit.advisories.some(item => item.code === 'HISTORICAL_REQUIREMENT_MAPPING_AMBIGUOUS'))
  assert.equal(audit.advisories.filter(item => item.code === 'EXTENDED_RISK_TEST_CASES_PRESENT').length, 0)
})

test('无法映射的历史 Requirement 保留 Case 且不计入当前 Coverage', () => {
  const run = mappedRun([requirement('RP-009', '删除旧项目')], [requirement('RP-010', '创建新项目')], [historicalItem('CASE-OLD', 2, caseContent('删除旧项目', ['RP-009']))])
  materializeCaseDesign(run, { schemaVersion: 'test-case-design/v3', cases: [] }, principal.subjectId, false)
  const effective = buildEffectiveCaseSet(run)
  assert.equal(effective[0]?.caseId, 'CASE-OLD')
  assert.deepEqual(effective[0]?.effectiveRequirementRefs, [])
  assert.ok(run.historicalSnapshot.requirementMappings.some(item => item.status === 'unmapped'))
  const audit = auditTestDesignCoverage({ runId: run.id, basis: run.basisSnapshot, retrieval: run.retrievalSnapshot, historical: run.historicalSnapshot, cases: effective })
  assert.ok(audit.advisories.some(item => item.code === 'HISTORICAL_REQUIREMENT_UNMAPPED'))
  assert.equal(audit.advisories.filter(item => item.code === 'EXTENDED_RISK_TEST_CASES_PRESENT').length, 0)
})

test('原始 requirementRefs 为空的 Case 才作为扩展风险测试统计', () => {
  const run = runFixture([historicalItem('CASE-RISK', 1, caseContent('超长输入下系统保持稳定', []))])
  materializeCaseDesign(run, { schemaVersion: 'test-case-design/v3', cases: [] }, principal.subjectId, false)
  const audit = auditTestDesignCoverage({ runId: run.id, basis: run.basisSnapshot, retrieval: run.retrievalSnapshot, historical: run.historicalSnapshot, cases: buildEffectiveCaseSet(run) })
  const advisory = audit.advisories.find(item => item.code === 'EXTENDED_RISK_TEST_CASES_PRESENT')
  assert.ok(advisory)
  assert.match(advisory.message, /1 条/u)
})

test('requirementRefs 单独变化不改变 Test Intent Hash，也不创建新 Revision', () => {
  const before = caseContent('创建项目', ['RP-001'])
  const after = caseContent('创建项目', ['RP-002'])
  assert.equal(testCaseSemanticSha256(before), testCaseSemanticSha256(after))
  assert.notEqual(canonicalSha256(before), canonicalSha256(after))
  const run = mappedRun([requirement('RP-001', '创建项目')], [requirement('RP-002', '创建项目')], [historicalItem('CASE-A', 3, before)])
  materializeCaseDesign(run, { schemaVersion: 'test-case-design/v3', cases: [candidate('candidate-a', after)] }, principal.subjectId, false)
  assert.deepEqual(buildEffectiveCaseSet(run).map(item => [item.caseId, item.revision, item.source, item.effectiveRequirementRefs]), [['CASE-A', 3, 'historical_reuse', ['RP-002']]])
  assert.equal(run.testCases[0]?.reviewState, 'approved')
})

test('Test 1：纯历史复用，空 Candidate 保留全部历史且不产生 deprecate', () => {
  const run = runFixture(['A', 'B', 'C'].map(id => historicalItem(`CASE-${id}`, 1, caseContent(`场景 ${id}`))))
  materializeCaseDesign(run, { schemaVersion: 'test-case-design/v3', cases: [] }, principal.subjectId, false)
  assert.equal(buildEffectiveCaseSet(run).length, 3)
  assert.equal(run.caseChangeProposals.filter(item => item.operation === 'reuse').length, 3)
  assert.equal(run.caseChangeProposals.filter(item => item.operation === 'deprecate').length, 0)
  assert.ok(run.caseChangeProposals.every(item => item.decision === 'accepted'))
})

test('Test 2：无历史基线时拒绝空 Candidate', () => {
  const run = runFixture([])
  assert.throws(() => materializeCaseDesign(run, { schemaVersion: 'test-case-design/v3', cases: [] }, principal.subjectId, false), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_DESIGN_CANDIDATE_EMPTY')
})

test('Test 3：完全一致交集复用正式 Case ID 和原 Revision，且无需人工重审', () => {
  const original = caseContent('创建项目')
  const run = runFixture([historicalItem('CASE-A', 1, original)])
  materializeCaseDesign(run, { schemaVersion: 'test-case-design/v3', cases: [candidate('candidate-a', original)] }, principal.subjectId, false)
  assert.deepEqual(buildEffectiveCaseSet(run).map(item => [item.caseId, item.revision, item.source]), [['CASE-A', 1, 'historical_reuse']])
  assert.equal(run.testCases[0]?.reviewState, 'approved')
  assert.equal(run.caseChangeProposals[0]?.operation, 'reuse')
})

test('Test 4：唯一高置信同意图交集更新原 Case ID 并递增 Revision', () => {
  const original = caseContent('创建项目')
  const changed = caseContent('创建项目', ['RP-001'], { steps: ['提交新的项目名称'], expectedResults: ['项目创建成功且可查询'] })
  const run = runFixture([historicalItem('CASE-A', 1, original)])
  materializeCaseDesign(run, { schemaVersion: 'test-case-design/v3', cases: [candidate('candidate-a', changed)] }, principal.subjectId, false)
  assert.deepEqual(buildEffectiveCaseSet(run).map(item => [item.caseId, item.revision, item.source]), [['CASE-A', 2, 'historical_update']])
  assert.equal(run.caseChangeProposals[0]?.operation, 'update')
  assert.equal(run.testCases[0]?.reviewState, 'in_review')
})

test('Test 5：无历史匹配的 Candidate 创建新的 Effective Case', () => {
  const run = runFixture([historicalItem('CASE-A', 1, caseContent('创建项目'))])
  materializeCaseDesign(run, { schemaVersion: 'test-case-design/v3', cases: [candidate('candidate-x', caseContent('修改项目'))] }, principal.subjectId, false)
  const effective = buildEffectiveCaseSet(run)
  assert.equal(effective.length, 2)
  assert.ok(effective.some(item => item.caseId === 'CASE-A' && item.source === 'historical_reuse'))
  assert.ok(effective.some(item => item.caseId.startsWith('test_case_') && item.source === 'candidate_create'))
})

test('Test 6：Candidate 只出现 A 时 B/C 仍默认保留', () => {
  const contents = ['A', 'B', 'C'].map(id => caseContent(`场景 ${id}`))
  const run = runFixture(contents.map((content, index) => historicalItem(`CASE-${String.fromCharCode(65 + index)}`, 1, content)))
  materializeCaseDesign(run, { schemaVersion: 'test-case-design/v3', cases: [candidate('candidate-a', contents[0]!)] }, principal.subjectId, false)
  assert.deepEqual(buildEffectiveCaseSet(run).map(item => item.caseId), ['CASE-A', 'CASE-B', 'CASE-C'])
  assert.equal(run.caseChangeProposals.filter(item => item.operation === 'deprecate').length, 0)
})

test('Test 7：多个可能历史交集时保留历史并安全 create', () => {
  const first = caseContent('登录失败', ['RP-001'], { steps: ['输入错误密码'], expectedResults: ['拒绝登录'] })
  const second = caseContent('登录失败', ['RP-001'], { steps: ['输入已锁定账号'], expectedResults: ['拒绝登录'] })
  const ambiguous = caseContent('登录失败', ['RP-001'], { steps: ['输入无效凭据'], expectedResults: ['拒绝登录并保持未认证'] })
  const run = runFixture([historicalItem('CASE-A', 1, first), historicalItem('CASE-B', 1, second)])
  materializeCaseDesign(run, { schemaVersion: 'test-case-design/v3', cases: [candidate('candidate-x', ambiguous)] }, principal.subjectId, false)
  const effective = buildEffectiveCaseSet(run)
  assert.equal(effective.length, 3)
  assert.ok(effective.some(item => item.caseId === 'CASE-A'))
  assert.ok(effective.some(item => item.caseId === 'CASE-B'))
  assert.equal(run.caseChangeProposals.find(item => item.candidateCaseId)?.operation, 'create')
  assert.match(run.caseChangeProposals.find(item => item.candidateCaseId)?.reason ?? '', /多个可能/u)
})

test('Test 8：Coverage 只统计 coverageTarget=true Requirement', () => {
  const effective = { caseId: 'CASE-B', revision: 1, content: caseContent('创建项目', ['RP-B']), contentSha256: canonicalSha256(caseContent('创建项目', ['RP-B'])), effectiveRequirementRefs: ['RP-B'], source: 'historical_reuse' as const }
  const audit = auditTestDesignCoverage({ runId: 'coverage-target', basis: { requirementReleaseId: 'release', snapshotSha256: 'a'.repeat(64), content: { requirements: [{ clientRequirementPointId: 'RP-A', coverageTarget: false }, { clientRequirementPointId: 'RP-B', coverageTarget: true }], clarifications: [] } } as never, retrieval: { snapshotSha256: 'b'.repeat(64) } as never, historical: { snapshotSha256: 'c'.repeat(64), items: [], requirementMappings: [] } as never, cases: [effective] })
  assert.deepEqual(audit.statistics, { totalBasis: 1, coveredBasis: 1, totalCases: 1 })
  assert.ok(!audit.blockers.some(item => item.subjectId === 'RP-A'))
})

test('Test 9/10：历史 Requirement Coverage 与 requirementRefs=[] 扩展 Case 都进入 Effective Set', () => {
  const run = runFixture([historicalItem('CASE-A', 1, caseContent('创建项目')), historicalItem('CASE-RISK', 1, caseContent('安全风险探索', [], { dimension: 'security' }))])
  materializeCaseDesign(run, { schemaVersion: 'test-case-design/v3', cases: [] }, principal.subjectId, false)
  const effective = buildEffectiveCaseSet(run)
  const audit = auditTestDesignCoverage({ runId: run.id, basis: run.basisSnapshot, retrieval: run.retrievalSnapshot, historical: run.historicalSnapshot, cases: effective })
  assert.equal(effective.length, 2)
  assert.equal(effective.find(item => item.caseId === 'CASE-RISK')?.content.requirementRefs.length, 0)
  assert.deepEqual(audit.statistics, { totalBasis: 1, coveredBasis: 1, totalCases: 2 })
})

test('Test 11：Repair remove 撤销历史 update Candidate 后回退原 Revision', () => {
  const original = caseContent('创建项目')
  const changed = caseContent('创建项目', ['RP-001'], { steps: ['提交更新后的创建动作'] })
  const run = runFixture([historicalItem('CASE-A', 1, original)])
  materializeCaseDesign(run, { schemaVersion: 'test-case-design/v3', cases: [candidate('candidate-a', changed)] }, principal.subjectId, false)
  const baseCandidateSha256 = canonicalSha256(repairCandidateContent(run))
  materializeCaseDesign(run, { schemaVersion: 'test-design-repair/v3', baseCandidateSha256, upsertCases: [], removeCaseRefs: ['candidate-a'] }, principal.subjectId, true)
  assert.deepEqual(buildEffectiveCaseSet(run).map(item => [item.caseId, item.revision, item.source]), [['CASE-A', 1, 'historical_reuse']])
  assert.equal(run.caseChangeProposals[0]?.operation, 'reuse')
})

test('Test 12：Library Publication 与 Full Handoff 包含历史 reuse、历史 update、new create 和历史扩展 Case', async () => {
  const historicalA = caseContent('登录成功')
  const historicalB = caseContent('创建项目')
  const historicalRisk = caseContent('越权风险探索', [], { dimension: 'security' })
  const changedB = caseContent('创建项目', ['RP-001'], { steps: ['提交项目名称和描述'], expectedResults: ['项目创建成功并可查询'] })
  const createdC = caseContent('修改项目')
  const sourceCases = [libraryCase('CASE-A', historicalA), libraryCase('CASE-B', historicalB), libraryCase('CASE-RISK', historicalRisk)]
  const members = sourceCases.map((item, ordinal) => ({ caseId: item.id, revision: 1, ordinal, contentSha256: item.revisions[0]!.contentSha256 }))
  const baselineContent = { schemaVersion: 'test-case-library/v3', projectId: 'project-delta', projectVersionId: 'project-version-delta', sourceRunId: 'previous-run', members }
  const baseline: TestCaseLibraryVersion = { id: 'library-v1', projectId: 'project-delta', projectVersionId: 'project-version-delta', version: 1, name: '历史正式库', sourceRunId: 'previous-run', members, contentSha256: canonicalSha256(baselineContent), publishedBy: 'previous-owner', publishedAt: now, projection: { status: 'succeeded', files: [] } }
  const run = runFixture(sourceCases.map(item => historicalItem(item.id, 1, item.revisions[0]!.content)))
  run.baseTestCaseLibraryVersionSha256 = baseline.contentSha256
  run.historicalSnapshot.sourceTestCaseLibraryVersionSha256 = baseline.contentSha256
  materializeCaseDesign(run, { schemaVersion: 'test-case-design/v3', cases: [candidate('candidate-a', historicalA), candidate('candidate-b', changedB), candidate('candidate-c', createdC)] }, principal.subjectId, false)
  const store = new JsonStore(null)
  await store.load()
  await store.transaction(state => {
    state.projects.push({ id: 'project-delta', name: 'Delta 项目', createdAt: now })
    state.projectVersions.push({ id: 'project-version-delta', projectId: 'project-delta', name: 'V2', status: 'open', createdAt: now, updatedAt: now })
    state.knowledgeBases.push({ id: 'kb-delta', projectId: 'project-delta', name: 'Delta KB', createdAt: now })
    const design = { id: 'design-delta', projectVersionId: 'project-version-delta', projectId: 'project-delta', name: 'Delta Design', objective: '验证合并发布', input: { name: 'Delta Design', objective: '验证合并发布', knowledgeAugmentation: { mode: 'disabled' } }, logicalInputSha256: 'd'.repeat(64), createdBy: principal.subjectId, createdAt: now }
    state.testDesignState = { architectureVersion: 'single-agent-skills/v1', designs: [design], runs: [run], libraryCases: sourceCases, libraryVersions: [baseline], suiteDrafts: [], suiteVersions: [], executionHandoffs: [] } as TestDesignState
  })
  const projector = { ingest: async () => ({ version: { id: `asset-version-${Math.random()}` }, task: undefined as never }) }
  const service = new TestDesignService(store, undefined, projector)
  for (const testCase of run.testCases.filter(item => item.reviewState === 'in_review')) await service.reviewCase('project-version-delta', 'design-delta', 'run-delta', testCase.id, { decision: 'approve', targetRevision: testCase.currentRevision }, principal)
  const audit = await service.reAudit('project-version-delta', 'design-delta', 'run-delta')
  const readyRun = await service.getRun('project-version-delta', 'design-delta', 'run-delta')
  const published = await service.publishLibraryVersion('project-version-delta', 'design-delta', 'run-delta', { name: 'Delta 正式库', expectedAuditId: audit.id, expectedCaseSetSha256: audit.caseSetSha256, expectedProposalSha256: readyRun.caseChangeProposalSha256 }, principal)
  assert.equal(published.members.length, 4)
  assert.ok(published.members.some(item => item.caseId === 'CASE-A' && item.revision === 1))
  assert.ok(published.members.some(item => item.caseId === 'CASE-B' && item.revision === 2))
  assert.ok(published.members.some(item => item.caseId === 'CASE-RISK' && item.revision === 1))
  assert.ok(published.members.every(item => item.traceability?.sourceRequirementReleaseId === 'release-delta'))
  assert.deepEqual(published.members.find(item => item.caseId === 'CASE-RISK')?.traceability?.requirementRefs, [])
  const createdMember = published.members.find(item => !['CASE-A', 'CASE-B', 'CASE-RISK'].includes(item.caseId))
  assert.ok(createdMember)
  const handoff = await service.createLibraryHandoff('project-version-delta', published.id, { mode: 'full', expectedLibrarySha256: published.contentSha256 }, principal)
  assert.deepEqual(new Set(handoff.members.map(item => item.caseId)), new Set(published.members.map(item => item.caseId)))
})

test('ProjectVersion 继承只自动选择来源版本最新正式 Library，其他版本不得混入', () => {
  const fixture = historicalBaselineFixture(true, true)
  const snapshot = buildHistoricalSnapshot(fixture.state, fixture.design, fixture.currentBasis, now)
  assert.equal(snapshot.sourceProjectVersionId, 'project-version-v1')
  assert.equal(snapshot.sourceTestCaseLibraryVersionId, 'library-v3')
  assert.equal(snapshot.items.length, 1)
  assert.ok(!snapshot.items.some(item => item.locator?.testCaseLibraryVersionId === 'library-other-v99'))
  assert.equal(snapshot.sourceRequirementReleaseId, 'release-v1')
  assert.equal(snapshot.sourceRequirementReleaseContentSha256, fixture.sourceRun.basisSnapshot.requirementReleaseContentSha256)
})

test('未开启 ProjectVersion 继承时即使项目有正式 Library，Historical Baseline 仍为空', () => {
  const fixture = historicalBaselineFixture(false, true)
  const snapshot = buildHistoricalSnapshot(fixture.state, fixture.design, fixture.currentBasis, now)
  assert.equal(snapshot.items.length, 0)
  assert.equal(snapshot.sourceProjectVersionId, undefined)
  assert.equal(snapshot.sourceTestCaseLibraryVersionId, undefined)
})

test('来源版本没有正式 Library 时按空 Historical Baseline 正常构建', () => {
  const fixture = historicalBaselineFixture(true, false)
  const snapshot = buildHistoricalSnapshot(fixture.state, fixture.design, fixture.currentBasis, now)
  assert.equal(snapshot.items.length, 0)
  assert.equal(snapshot.sourceProjectVersionId, 'project-version-v1')
  assert.equal(snapshot.sourceTestCaseLibraryVersionId, undefined)
  assert.equal(snapshot.sourceRequirementReleaseId, undefined)
  assert.deepEqual(snapshot.requirementMappings, [])
})

test('Run 创建后来源版本发布新 Library 不会改变已冻结 Historical Snapshot', () => {
  const fixture = historicalBaselineFixture(true, true)
  const frozen = buildHistoricalSnapshot(fixture.state, fixture.design, fixture.currentBasis, now)
  const aggregate = fixture.state.testDesignState!
  const libraryV3 = aggregate.libraryVersions.find(item => item.id === 'library-v3')!
  aggregate.libraryVersions.push({ ...structuredClone(libraryV3), id: 'library-v4', version: 4, name: '正式库 V4', contentSha256: '4'.repeat(64), publishedAt: '2026-08-24T00:00:00.000Z' })
  const later = buildHistoricalSnapshot(fixture.state, fixture.design, fixture.currentBasis, '2026-08-24T00:00:01.000Z')
  assert.equal(frozen.sourceTestCaseLibraryVersionId, 'library-v3')
  assert.equal(frozen.sourceTestCaseLibraryVersionSha256, libraryV3.contentSha256)
  assert.equal(later.sourceTestCaseLibraryVersionId, 'library-v4')
})

function historicalBaselineFixture(inheritRequirementBindings: boolean, includeSourceLibrary: boolean) {
  const sourceRequirement = requirement('RP-001', '创建项目')
  const currentRequirement = requirement('RP-002', '创建项目')
  const sourceContent = caseContent('创建项目', ['RP-001'])
  const sourceCase = libraryCase('CASE-SOURCE', sourceContent)
  const sourceTraceability = { sourceRequirementReleaseId: 'release-v1', requirementRefs: [{ requirementReleaseId: 'release-v1', requirementId: 'RP-001' }] }
  sourceCase.revisions[0]!.traceability = sourceTraceability
  const member = { caseId: sourceCase.id, revision: 1, ordinal: 0, contentSha256: sourceCase.revisions[0]!.contentSha256, frozenContent: structuredClone(sourceContent), frozenExecutionMethods: ['api'] as const, traceability: sourceTraceability, executionReadiness: 'ready' as const }
  const sourceRun = runFixture([], [sourceRequirement])
  sourceRun.id = 'source-run-v1'
  sourceRun.projectVersionId = 'project-version-v1'
  sourceRun.basisSnapshot.projectVersionId = 'project-version-v1'
  sourceRun.basisSnapshot.requirementReleaseId = 'release-v1'
  sourceRun.basisSnapshot.requirementReleaseContentSha256 = canonicalSha256(sourceRun.basisSnapshot.content)
  const otherRun = structuredClone(sourceRun)
  otherRun.id = 'source-run-other'
  otherRun.projectVersionId = 'project-version-other'
  const library = (id: string, version: number, sourceRunId: string): TestCaseLibraryVersion => { const projectVersionId = sourceRunId === sourceRun.id ? 'project-version-v1' : 'project-version-other'; return { id, projectId: 'project-delta', projectVersionId, version, name: `正式库 V${version}`, sourceRunId, members: [structuredClone(member)], contentSha256: canonicalSha256({ id, projectVersionId, version, member }), publishedBy: 'owner', publishedAt: `2026-08-2${version}T00:00:00.000Z`, projection: { status: 'succeeded', files: [] } } }
  const libraryVersions = includeSourceLibrary ? [library('library-v1', 1, sourceRun.id), library('library-v3', 3, sourceRun.id), library('library-other-v99', 99, otherRun.id)] : [library('library-other-v99', 99, otherRun.id)]
  const state = {
    projectVersions: [
      { id: 'project-version-v1', projectId: 'project-delta', name: 'V1', status: 'open', inheritRequirementBindings: false, createdAt: now, updatedAt: now },
      { id: 'project-version-v2', projectId: 'project-delta', name: 'V2', status: 'open', sourceProjectVersionId: 'project-version-v1', inheritRequirementBindings, createdAt: now, updatedAt: now },
      { id: 'project-version-other', projectId: 'project-delta', name: 'Other', status: 'open', inheritRequirementBindings: false, createdAt: now, updatedAt: now },
    ],
    testDesignState: { architectureVersion: 'single-agent-skills/v1', designs: [], runs: [sourceRun, otherRun], libraryCases: [sourceCase], libraryVersions, suiteDrafts: [], suiteVersions: [], executionHandoffs: [] },
  } as unknown as DatabaseState
  const design = { id: 'design-v2', projectVersionId: 'project-version-v2', projectId: 'project-delta', name: 'V2 Design', objective: '验证版本继承', input: { name: 'V2 Design', objective: '验证版本继承', knowledgeAugmentation: { mode: 'disabled' as const } }, logicalInputSha256: 'd'.repeat(64), createdBy: principal.subjectId, createdAt: now }
  const currentBasis = { schemaVersion: 'test-design-basis-snapshot/v3' as const, projectVersionId: 'project-version-v2', requirementReleaseId: 'release-v2', verificationRunId: 'review-v2', requirementReleaseContentSha256: canonicalSha256({ requirements: [currentRequirement] }), content: { requirements: [currentRequirement], evidence: [], clarifications: [] }, createdAt: now, snapshotSha256: 'a'.repeat(64) }
  return { state, design, currentBasis, sourceRun }
}

function libraryCase(id: string, content: TestCaseContent): LibraryTestCase {
  const hash = canonicalSha256(content)
  return { id, projectId: 'project-delta', currentRevision: 1, status: 'active', createdAt: now, updatedAt: now, revisions: [{ revision: 1, content, contentSha256: hash, semanticSha256: testCaseSemanticSha256(content), changeReason: '历史基线', createdBy: 'previous-owner', createdAt: now }] }
}
