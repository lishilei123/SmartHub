import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import { auditTestDesignCoverage } from '../server/application/test-design-coverage-auditor.js'
import { buildEffectiveCaseSet, materializeCaseDesign, repairCandidateContent, TestDesignService } from '../server/application/test-design-service.js'
import { TestDesignError } from '../server/application/test-design-validation.js'
import type { HistoricalCaseSnapshot, LibraryTestCase, TestCaseContent, TestCaseLibraryVersion, TestDesignState, TestDesignWorkflowRun } from '../server/domain/test-design-types.js'
import { JsonStore } from '../server/infrastructure/store.js'

const now = '2026-08-21T00:00:00.000Z'
const principal = { subjectId: 'delta-test-owner', displayName: 'Delta 测试负责人' }

function caseContent(title: string, requirementRefs: string[] = ['RP-001'], overrides: Partial<TestCaseContent> = {}): TestCaseContent {
  return {
    schemaVersion: 'test-case/v3', title, dimension: 'functional', priority: 'P1', requirementRefs, executionMethods: ['api'],
    preconditions: ['用户已登录'], steps: [`执行 ${title}`], expectedResults: [`${title} 成功`], ...overrides,
  }
}

function historicalItem(caseId: string, revision: number, content: TestCaseContent) {
  const hash = canonicalSha256(content)
  return { id: `history-${caseId}-${revision}`, kind: 'test_case_library' as const, sourceId: `library-v1:${caseId}:${revision}`, contentSha256: hash, content: structuredClone(content), locator: { testCaseLibraryVersionId: 'library-v1', caseId, revision, status: 'active' } }
}

function runFixture(items: HistoricalCaseSnapshot['items'], requirements = [{ clientRequirementPointId: 'RP-001', coverageTarget: true }]): TestDesignWorkflowRun {
  const historicalBase = { schemaVersion: 'historical-case-snapshot/v1' as const, items, ...(items.length ? { baseTestCaseLibraryVersionId: 'library-v1', baseTestCaseLibraryVersionSha256: 'f'.repeat(64) } : {}), createdAt: now }
  return {
    id: 'run-delta', testDesignId: 'design-delta', projectVersionId: 'project-version-delta', status: 'running', stage: 'test_case_design', progress: 50, idempotencyKey: 'delta',
    basisSnapshot: { schemaVersion: 'test-design-basis-snapshot/v3', projectVersionId: 'project-version-delta', requirementReleaseId: 'release-delta', verificationRunId: 'review-delta', requirementReleaseContentSha256: 'a'.repeat(64), content: { requirements, evidence: [], clarifications: [], testFocus: [] } as never, createdAt: now, snapshotSha256: 'b'.repeat(64) },
    agentConfigurationSnapshot: {} as never, currentInputRefs: [], workspaceSnapshot: {} as never, formalWorkspaceFiles: [], retrievalSnapshot: { snapshotSha256: 'c'.repeat(64) } as never,
    historicalSnapshot: { ...historicalBase, snapshotSha256: canonicalSha256(historicalBase) }, ...(items.length ? { baseTestCaseLibraryVersionId: 'library-v1', baseTestCaseLibraryVersionSha256: 'f'.repeat(64) } : {}),
    nodeRuns: [], artifacts: [], gateDecisions: [], testCases: [], caseChangeProposals: [], coverageAudits: [], events: [], createdBy: principal.subjectId, createdAt: now,
  }
}

function candidate(ref: string, content: TestCaseContent) { return { ref, ...content } }

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
  const effective = { caseId: 'CASE-B', revision: 1, content: caseContent('创建项目', ['RP-B']), contentSha256: canonicalSha256(caseContent('创建项目', ['RP-B'])), source: 'historical_reuse' as const }
  const audit = auditTestDesignCoverage({ runId: 'coverage-target', basis: { requirementReleaseId: 'release', snapshotSha256: 'a'.repeat(64), content: { requirements: [{ clientRequirementPointId: 'RP-A', coverageTarget: false }, { clientRequirementPointId: 'RP-B', coverageTarget: true }], clarifications: [] } } as never, retrieval: { snapshotSha256: 'b'.repeat(64) } as never, historical: { snapshotSha256: 'c'.repeat(64) } as never, cases: [effective] })
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
  const baselineContent = { schemaVersion: 'test-case-library/v3', projectId: 'project-delta', sourceRunId: 'previous-run', members }
  const baseline: TestCaseLibraryVersion = { id: 'library-v1', projectId: 'project-delta', version: 1, name: '历史正式库', sourceRunId: 'previous-run', members, contentSha256: canonicalSha256(baselineContent), publishedBy: 'previous-owner', publishedAt: now, projection: { status: 'succeeded', files: [] } }
  const run = runFixture(sourceCases.map(item => historicalItem(item.id, 1, item.revisions[0]!.content)))
  run.baseTestCaseLibraryVersionSha256 = baseline.contentSha256
  run.historicalSnapshot.baseTestCaseLibraryVersionSha256 = baseline.contentSha256
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
  const createdMember = published.members.find(item => !['CASE-A', 'CASE-B', 'CASE-RISK'].includes(item.caseId))
  assert.ok(createdMember)
  const handoff = await service.createLibraryHandoff('project-version-delta', published.id, { mode: 'full', expectedLibrarySha256: published.contentSha256 }, principal)
  assert.deepEqual(new Set(handoff.members.map(item => item.caseId)), new Set(published.members.map(item => item.caseId)))
})

function libraryCase(id: string, content: TestCaseContent): LibraryTestCase {
  const hash = canonicalSha256(content)
  return { id, projectId: 'project-delta', currentRevision: 1, status: 'active', createdAt: now, updatedAt: now, revisions: [{ revision: 1, content, contentSha256: hash, semanticSha256: hash, changeReason: '历史基线', createdBy: 'previous-owner', createdAt: now }] }
}
