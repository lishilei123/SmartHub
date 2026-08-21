import assert from 'node:assert/strict'
import test from 'node:test'
import { auditTestDesignCoverage } from '../server/application/test-design-coverage-auditor.js'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import { captureCoverageReviewerSource, type CoverageReviewerSourceRun } from '../server/application/planning-workflow-service.js'
import { TestDesignError, validateHistoricalProposalPlan, validateTestCaseDesignCandidate, validateTestCaseContent } from '../server/application/test-design-validation.js'
import type { ScenarioClaim, TestCase, TestCaseContent } from '../server/domain/test-design-types.js'

const executionMethods = [{ method: 'ui' as const, uiSpec: { entry: '/login', selectors: ['data-testid=submit'] }, steps: [{ key: 'step-1', action: '提交表单', expected: '显示登录成功' }], verificationChecks: [{ key: 'check-1', description: '页面显示首页' }], executionReadiness: 'ready' as const, automationHint: 'UI 自动化' }]
function content(requirementRefs: string[], objective = '验证登录行为'): TestCaseContent { return { schemaVersion: 'test-case/v2', title: objective, objective, dimension: 'functional', requirementRefs, priority: 'P0', preconditions: [], dataRequirementIds: [], cleanup: [], dependencies: [], executionMethods, executionSpec: { kind: 'functional', method: 'ui', steps: executionMethods[0].steps, verificationChecks: executionMethods[0].verificationChecks, preconditions: [], testDataRequirements: [], executionReadiness: 'ready', automationHint: 'UI 自动化' }, sharedVerificationChecks: [], tags: [], domain: '认证' } }
function testCase(id: string, value: TestCaseContent, reviewState: TestCase['reviewState'] = 'approved'): TestCase { const revision = { revision: 0, content: value, contentSha256: canonicalSha256(value), semanticSha256: canonicalSha256({ ...value, tags: [] }), diff: [], editorId: 'test', reason: 'test', createdAt: new Date().toISOString() }; return { id, runId: 'run-1', candidateRef: id, origin: 'ai', currentRevision: 0, reviewState, revisions: [revision], reviewActions: [] } }
function basis(ids: Array<string | { id: string; coverageTarget?: boolean }>, cues = '') { const content = { requirements: ids.map(item => { const { id, coverageTarget } = typeof item === 'string' ? { id: item, coverageTarget: true } : { id: item.id, coverageTarget: item.coverageTarget ?? true }; return { clientRequirementPointId: id, title: id, description: `${id} ${cues}`, actor: '用户', action: '操作', object: '对象', conditions: [], businessRules: [], exceptions: [], acceptanceCriteria: [], evidenceRefs: [], coverageTarget } }), evidence: [], clarifications: [], testFocus: [] }; return { schemaVersion: 'test-design-basis-snapshot/v3', projectVersionId: 'pv-1', requirementReleaseId: 'release-1', verificationRunId: 'review-1', requirementReleaseContentSha256: canonicalSha256(content), content, createdAt: new Date().toISOString(), snapshotSha256: 'b'.repeat(64) } as never }
function claim(ref: string, caseRef: string, value: Partial<Omit<ScenarioClaim, 'ref' | 'caseRef' | 'requirementRefs'>> = {}): ScenarioClaim { const result = { ref, caseRef, requirementRefs: ['REQ-1'], kind: 'other' as ScenarioClaim['kind'], subject: 'task', variant: ref, polarity: 'neutral' as const, oracle: '结果符合 Requirement', ...value }; return { ...result, ...(result.kind === 'state_transition' ? { transition: result.transition ?? transition(result.variant) } : {}) } }
function transition(variant: string) { const [from, to] = variant.split('->'); return { from: from?.trim() || variant, to: to?.trim() || variant } }
function audit(cases: TestCase[], ids: Array<string | { id: string; coverageTarget?: boolean }>, scenarioClaims: ScenarioClaim[] = [], cues = '') { return auditTestDesignCoverage({ runId: 'run-1', basis: basis(ids, cues), retrieval: { snapshotSha256: 'c'.repeat(64) } as never, historical: { items: [], snapshotSha256: 'd'.repeat(64) } as never, cases, scenarioClaims, dataSet: { id: 'data-1', version: 1, requirements: [], contentSha256: 'e'.repeat(64), createdAt: new Date().toISOString(), createdBy: 'test' }, findings: [], confirmationItems: [] }) }
function candidate(cases: Array<{ ref: string; content: TestCaseContent }>, scenarioClaims: ScenarioClaim[]) {
  return {
    schemaVersion: 'test-case-design/v2',
    cases: cases.map(item => ({
      ref: item.ref,
      ...item.content,
      coverageClaims: scenarioClaims.filter(claim => claim.caseRef === item.ref).map(({ caseRef: _caseRef, requirementRefs: _requirementRefs, ...inline }) => inline),
    })),
    dimensionAssessments: fiveDimensions(),
    dataRequirements: [],
    findings: [],
    confirmationItems: [],
  }
}
function overMerged(result: ReturnType<typeof audit>) { return result.blockers.find(item => item.code === 'TEST_CASE_OVER_MERGED') }

test('CoverageReviewer 由 Service 冻结 active Case currentRevision、Audit DataSet 与最新 valid Audit', () => {
  const current = testCase('case-current', content(['REQ-1']))
  const revisedContent = content(['REQ-1'], '当前最新 Revision')
  current.revisions.push({ revision: 1, content: revisedContent, contentSha256: canonicalSha256(revisedContent), semanticSha256: canonicalSha256({ ...revisedContent, tags: [] }), diff: [], editorId: 'test', reason: '更新', createdAt: '2026-08-21T01:00:00.000Z' })
  current.currentRevision = 1
  const deleted = testCase('case-deleted', content(['REQ-2']))
  deleted.tombstonedAt = '2026-08-21T01:00:00.000Z'
  const currentCaseSet = [{ caseId: current.id, revision: 1, contentSha256: current.revisions[1].contentSha256 }]
  const caseSetSha256 = canonicalSha256(currentCaseSet)
  const auditBase = { runId: 'run-1', requirementReleaseId: 'release-1', caseSetSha256, inputSha256: 'f'.repeat(64), status: 'valid' as const, statistics: { totalBasis: 1, coveredBasis: 1, totalCases: 1 }, relations: [], blockers: [], advisories: [] }
  const sourceRun = {
    id: 'run-1',
    basisSnapshot: { requirementReleaseId: 'release-1', requirementReleaseContentSha256: 'a'.repeat(64) },
    testCases: [current, deleted],
    dataSetVersions: [
      { id: 'data-old', version: 1, requirements: [], contentSha256: 'b'.repeat(64), createdBy: 'test', createdAt: '2026-08-21T01:00:00.000Z' },
      { id: 'data-current', version: 2, requirements: [], contentSha256: 'c'.repeat(64), createdBy: 'test', createdAt: '2026-08-21T02:00:00.000Z' },
    ],
    coverageAudits: [
      { ...auditBase, id: 'audit-old', dataSetVersionId: 'data-old', createdAt: '2026-08-21T01:30:00.000Z' },
      { ...auditBase, id: 'audit-stale-newest', dataSetVersionId: 'data-current', status: 'stale' as const, createdAt: '2026-08-21T03:00:00.000Z' },
      { ...auditBase, id: 'audit-current', dataSetVersionId: 'data-current', inputSha256: 'd'.repeat(64), createdAt: '2026-08-21T02:30:00.000Z' },
    ],
  } satisfies CoverageReviewerSourceRun

  const frozen = captureCoverageReviewerSource(sourceRun)
  assert.deepEqual(frozen.testCases, currentCaseSet)
  assert.equal(frozen.dataSetVersionId, 'data-current')
  assert.equal(frozen.dataSetContentSha256, 'c'.repeat(64))
  assert.equal(frozen.coverageAuditId, 'audit-current')
  assert.equal(frozen.coverageAuditInputSha256, 'd'.repeat(64))
})

test('TestCase 候选直接使用 Requirement refs，并允许一个 Requirement 展开多条场景', () => {
  const cases = [content(['REQ-1'], '正确密码登录'), content(['REQ-1'], '密码错误'), content(['REQ-1', 'REQ-2'], '登录后跳转')].map((item, index) => ({ ref: `case-${index + 1}`, content: item }))
  const value = validateTestCaseDesignCandidate(candidate(cases, cases.map(item => claim(`SC-${item.ref}`, item.ref, { requirementRefs: item.content.requirementRefs }))))
  assert.equal(value.cases.length, 3)
  assert.deepEqual(value.cases[2].content.requirementRefs, ['REQ-1', 'REQ-2'])
  assert.throws(() => validateTestCaseContent({ ...content(['REQ-1']), legacyRefs: ['legacy-reference'] }), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID')
})

test('测试用例候选提交只接受 v2，且不再接受根级 proposals', () => {
  const valid = candidate([{ ref: 'TC-1', content: content(['REQ-1']) }], [claim('SC-1', 'TC-1')])
  assert.throws(
    () => validateTestCaseDesignCandidate({ ...valid, schemaVersion: 'test-case-design/v1' }),
    (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_DESIGN_CANDIDATE_SCHEMA_INVALID' && error.message.includes('v1 提交协议已删除'),
  )
  assert.throws(
    () => validateTestCaseDesignCandidate({ ...valid, proposals: [] }),
    (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_DESIGN_CANDIDATE_SCHEMA_INVALID' && error.message.includes('proposals'),
  )
})

test('v2 将内联 coverageClaims 和历史变更规范化为完整内部 Claim/Proposal，update/deprecate/reference 不要求重复正文', () => {
  const first = content(['REQ-1'], '历史状态用例')
  const second = content(['REQ-1'], '历史废弃用例')
  const third = content(['REQ-1'], '历史参考用例')
  const historical = {
    schemaVersion: 'historical-case-snapshot/v1',
    items: [
      { id: 'history-1', kind: 'test_case_library', sourceId: 'library-1:case-1:1', contentSha256: canonicalSha256({ ...first, tags: [] }), content: first, locator: { caseId: 'case-1', revision: 1 } },
      { id: 'history-2', kind: 'test_case_library', sourceId: 'library-1:case-2:1', contentSha256: canonicalSha256({ ...second, tags: [] }), content: second, locator: { caseId: 'case-2', revision: 1 } },
      { id: 'history-3', kind: 'test_case_library', sourceId: 'library-1:case-3:1', contentSha256: canonicalSha256({ ...third, tags: [] }), content: third, locator: { caseId: 'case-3', revision: 1 } },
    ],
    createdAt: new Date().toISOString(),
    snapshotSha256: 'history-snapshot',
  } as never
  const updated = { ...content(['REQ-1'], '更新后的状态用例'), title: '更新后的状态用例' }
  const submission = {
    schemaVersion: 'test-case-design/v2',
    cases: [{ ref: 'case-updated', ...updated, coverageClaims: [{ ref: 'SC-UPDATED', kind: 'state_transition', subject: 'task.status', variant: 'todo->in_progress', polarity: 'positive', oracle: '状态为 in_progress', transition: { from: 'todo', to: 'in_progress' } }] }],
    dimensionAssessments: fiveDimensions(),
    historicalChanges: [
      { operation: 'update', sourceCaseId: 'case-1', sourceRevision: 1, candidateRef: 'case-updated', reason: '状态规则已修改', confidence: 0.95 },
      { operation: 'deprecate', sourceCaseId: 'case-2', sourceRevision: 1, reason: '能力已删除', confidence: 0.98 },
      { operation: 'reference', sourceCaseId: 'case-3', sourceRevision: 1, reason: '仅保留设计参考', confidence: 0.9 },
    ],
  }
  const normalized = validateTestCaseDesignCandidate(submission)
  assert.ok(!('baseCandidateSha256' in normalized))
  const complete = validateHistoricalProposalPlan(normalized, historical)
  assert.equal(complete.cases.length, 1)
  assert.deepEqual(complete.scenarioClaims[0] && { caseRef: complete.scenarioClaims[0].caseRef, requirementRefs: complete.scenarioClaims[0].requirementRefs }, { caseRef: 'case-updated', requirementRefs: ['REQ-1'] })
  assert.deepEqual(complete.proposals.map(item => [item.operation, item.candidateRef]).sort(), [['deprecate', undefined], ['reference', undefined], ['update', 'case-updated']])

  const duplicateClaim = { ...submission, scenarioClaims: [claim('SC-UPDATED', 'case-updated')] }
  assert.throws(() => validateTestCaseDesignCandidate(duplicateClaim), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_DESIGN_CANDIDATE_SCHEMA_INVALID' && error.message.includes('scenarioClaims'))
})

function fiveDimensions() {
  return [
    { dimension: 'functional', applicable: true, reason: 'Requirement 定义状态行为', requirementRefs: ['REQ-1'], risks: ['状态转换'], scenarioClaims: ['状态迁移'] },
    { dimension: 'performance', applicable: false, reason: 'Requirement 未定义性能目标', requirementRefs: ['REQ-1'], risks: [], scenarioClaims: [] },
    { dimension: 'stability', applicable: false, reason: 'Requirement 未定义稳定性目标', requirementRefs: ['REQ-1'], risks: [], scenarioClaims: [] },
    { dimension: 'compatibility', applicable: false, reason: 'Requirement 未定义兼容性矩阵', requirementRefs: ['REQ-1'], risks: [], scenarioClaims: [] },
    { dimension: 'security', applicable: false, reason: 'Requirement 未定义安全规则', requirementRefs: ['REQ-1'], risks: [], scenarioClaims: [] },
  ]
}

test('Coverage Audit 直接建立 Requirement 到 TestCase 关系，并识别多需求闭环', () => {
  const result = audit([testCase('case-1', content(['REQ-1', 'REQ-2']))], ['REQ-1', 'REQ-2'], [claim('SC-1', 'case-1', { requirementRefs: ['REQ-1', 'REQ-2'] })])
  assert.equal(result.statistics.totalBasis, 2)
  assert.equal(result.statistics.coveredBasis, 2)
  assert.deepEqual(result.relations.map(item => item.caseId), ['case-1', 'case-1'])
})

test('Coverage Audit 与人工审核状态解耦，draft Case 不产生审核 blocker', () => {
  const draft = testCase('case-draft', content(['REQ-1']), 'draft')
  const result = audit([draft], ['REQ-1'], [claim('SC-DRAFT', 'case-draft')])
  assert.equal(result.status, 'valid')
  assert.equal(result.blockers.some(item => item.code === 'TEST_CASE_REVIEW_REQUIRED'), false)
  assert.equal('approvedCases' in result.statistics, false)
})

test('coverageTarget=false 的项目背景不进入 Coverage，而 true 的业务 Requirement 仍必须覆盖', () => {
  const contextOnly = audit([], [{ id: 'RP-CONTEXT', coverageTarget: false }])
  assert.equal(contextOnly.statistics.totalBasis, 0)
  assert.equal(contextOnly.blockers.some(item => item.code === 'COVERAGE_REQUIREMENT_UNCOVERED'), false)
  const testable = audit([], [{ id: 'RP-BEHAVIOR', coverageTarget: true }])
  assert.ok(testable.blockers.some(item => item.code === 'COVERAGE_REQUIREMENT_UNCOVERED' && item.subjectId === 'RP-BEHAVIOR'))
})

test('Coverage Audit 保留低置信度 shallow coverage 检查，但 Scenario Atomicity 才识别过度合并', () => {
  const broad = testCase('case-1', content(['REQ-1'], '验证登录'))
  const shallow = audit([broad], ['REQ-1'], [claim('SC-1', 'case-1')], '正常异常边界权限状态')
  assert.ok(shallow.blockers.some(item => item.code === 'TEST_CASE_COVERAGE_TOO_SHALLOW' && item.resolution === 'agent_repair'))
  const uncovered = audit([testCase('case-1', content(['REQ-1']))], ['REQ-1', 'REQ-2'], [claim('SC-2', 'case-1')])
  assert.ok(uncovered.blockers.some(item => item.code === 'COVERAGE_REQUIREMENT_UNCOVERED'))
})

test('多个状态迁移必须拆分，且不会再以 requirementRefs 虚报完整覆盖', () => {
  const result = audit([testCase('TC-STATE', content(['REQ-1'], '任务状态迁移'))], ['REQ-1'], [claim('SC-1', 'TC-STATE', { kind: 'state_transition', subject: 'task.status', variant: 'todo->in_progress', polarity: 'positive', oracle: '状态为 in_progress' }), claim('SC-2', 'TC-STATE', { kind: 'state_transition', subject: 'task.status', variant: 'in_progress->completed', polarity: 'positive', oracle: '状态为 completed' })])
  const blocker = overMerged(result)
  assert.equal(blocker?.resolution, 'agent_repair')
  assert.ok(blocker?.details?.reasons?.includes('multiple_state_transitions'))
  assert.equal(blocker?.details?.suggestedSplitCount, 2)
  assert.equal(result.statistics.coveredBasis, 0)
  assert.equal(result.relations[0].status, 'partially_covered')
})

test('正向与负向状态路径同 Case 会报告 mixed_positive_negative', () => {
  const result = audit([testCase('TC-STATE', content(['REQ-1']))], ['REQ-1'], [claim('SC-1', 'TC-STATE', { kind: 'state_transition', subject: 'task.status', variant: 'todo->in_progress', polarity: 'positive', oracle: '状态为 in_progress' }), claim('SC-2', 'TC-STATE', { kind: 'state_transition', subject: 'task.status', variant: 'todo->completed', polarity: 'negative', oracle: '拒绝跳级' })])
  assert.ok(overMerged(result)?.details?.reasons?.includes('mixed_positive_negative'))
})

test('两个独立非法状态边必须拆分', () => {
  const result = audit([testCase('TC-STATE', content(['REQ-1']))], ['REQ-1'], [claim('SC-1', 'TC-STATE', { kind: 'state_transition', subject: 'task.status', variant: 'completed->todo', polarity: 'negative', oracle: '拒绝回退 todo' }), claim('SC-2', 'TC-STATE', { kind: 'state_transition', subject: 'task.status', variant: 'completed->in_progress', polarity: 'negative', oracle: '拒绝回退 in_progress' })])
  assert.ok(overMerged(result)?.details?.reasons?.includes('multiple_state_transitions'))
})

test('已拆开的独立状态边不再触发 over-merge', () => {
  const cases = ['todo->in_progress', 'in_progress->completed', 'todo->completed', 'completed->todo', 'completed->in_progress'].map((variant, index) => testCase(`TC-${index}`, content(['REQ-1'], variant)))
  const result = audit(cases, ['REQ-1'], cases.map((item, index) => claim(`SC-${index}`, item.candidateRef!, { kind: 'state_transition', subject: 'task.status', variant: item.revisions[0].content.title, polarity: index < 2 ? 'positive' : 'negative', oracle: `验证 ${item.revisions[0].content.title}` })))
  assert.equal(overMerged(result), undefined)
})

test('CRUD lifecycle 和同一枚举 subject 的多个合法值允许聚合', () => {
  const lifecycle = audit([testCase('TC-CRUD', content(['REQ-1']))], ['REQ-1'], [claim('SC-CREATE', 'TC-CRUD', { kind: 'crud_lifecycle', subject: 'project', variant: 'create', polarity: 'positive', oracle: '创建后可查询' }), claim('SC-UPDATE', 'TC-CRUD', { kind: 'crud_lifecycle', subject: 'project', variant: 'update', polarity: 'positive', oracle: '更新后可查询' })])
  assert.equal(overMerged(lifecycle), undefined)
  const enumResult = audit([testCase('TC-PRIORITY', content(['REQ-1']))], ['REQ-1'], ['high', 'medium', 'low'].map(value => claim(`SC-${value}`, 'TC-PRIORITY', { kind: 'enum', subject: 'task.priority', variant: value, polarity: 'positive', oracle: '值属于合法 priority 集合并可正确保存和查询' })))
  assert.equal(overMerged(enumResult), undefined)
})

test('允许聚合类型与独立意图混合时仍必须拆分', () => {
  const result = audit([testCase('TC-MIXED', content(['REQ-1']))], ['REQ-1'], [claim('SC-CREATE', 'TC-MIXED', { kind: 'crud_lifecycle', subject: 'task', variant: 'create', polarity: 'positive', oracle: '创建后可查询' }), claim('SC-TRANSITION', 'TC-MIXED', { kind: 'state_transition', subject: 'task.status', variant: 'todo->in_progress', polarity: 'positive', oracle: '状态为 in_progress' })])
  assert.ok(overMerged(result)?.details?.reasons?.includes('multiple_independent_subjects'))
})

test('priority 与 status 合法枚举同 Case 会报告多个独立 subject', () => {
  const result = audit([testCase('TC-ENUM', content(['REQ-1']))], ['REQ-1'], [claim('SC-PRIORITY', 'TC-ENUM', { kind: 'enum', subject: 'task.priority', variant: 'high|medium|low', polarity: 'positive', oracle: 'priority 合法并可保存' }), claim('SC-STATUS', 'TC-ENUM', { kind: 'enum', subject: 'task.status', variant: 'todo|in_progress|completed', polarity: 'positive', oracle: 'status 合法并可保存' })])
  assert.ok(overMerged(result)?.details?.reasons?.includes('multiple_independent_subjects'))
})

test('状态筛选、优先级筛选与关键字搜索同 Case 会报告多个查询意图；拆开后通过', () => {
  const claims = [claim('SC-STATUS', 'TC-QUERY', { kind: 'filter', subject: 'task.status', variant: 'status=todo', polarity: 'positive', oracle: 'todo 命中且 completed 排除' }), claim('SC-PRIORITY', 'TC-QUERY', { kind: 'filter', subject: 'task.priority', variant: 'priority=high', polarity: 'positive', oracle: 'high 命中且 low 排除' }), claim('SC-SEARCH', 'TC-QUERY', { kind: 'search', subject: 'task.keyword', variant: 'keyword=release', polarity: 'positive', oracle: '匹配字段命中且不匹配项排除' })]
  const merged = audit([testCase('TC-QUERY', content(['REQ-1']))], ['REQ-1'], claims)
  assert.ok(overMerged(merged)?.details?.reasons?.includes('multiple_query_intents'))
  const splitCases = ['TC-STATUS', 'TC-PRIORITY', 'TC-SEARCH'].map(id => testCase(id, content(['REQ-1'], id)))
  const split = audit(splitCases, ['REQ-1'], claims.map((item, index) => ({ ...item, caseRef: splitCases[index].candidateRef! })))
  assert.equal(overMerged(split), undefined)
})

test('coverageClaims 由所属 Case 派生追溯，且 functional/security 不能缺失', () => {
  const cases = [{ ref: 'TC-1', content: content(['REQ-1']) }]
  assert.throws(() => validateTestCaseDesignCandidate(candidate(cases, [claim('SC-1', 'TC-MISSING')])), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_DESIGN_CANDIDATE_SCHEMA_INVALID')
  const repeatedTraceability = candidate(cases, [claim('SC-1', 'TC-1')])
  Object.assign(repeatedTraceability.cases[0].coverageClaims[0]!, { requirementRefs: ['REQ-2'] })
  assert.throws(() => validateTestCaseDesignCandidate(repeatedTraceability), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_DESIGN_CANDIDATE_SCHEMA_INVALID')
  assert.throws(() => validateTestCaseDesignCandidate(candidate(cases, [])), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_DESIGN_CANDIDATE_SCHEMA_INVALID')
  assert.throws(() => validateTestCaseDesignCandidate(candidate(cases, [{ ref: 'SC-STATE', caseRef: 'TC-1', requirementRefs: ['REQ-1'], kind: 'state_transition', subject: 'task.status', variant: 'completed 回退', polarity: 'negative', oracle: '拒绝状态回退' }] as ScenarioClaim[])), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_DESIGN_CANDIDATE_SCHEMA_INVALID')
  assert.throws(() => validateTestCaseDesignCandidate(candidate(cases, [claim('SC-STATE-AMBIGUOUS', 'TC-1', { kind: 'state_transition', subject: 'task.status', variant: 'completed rollback', polarity: 'negative', oracle: '拒绝不允许的回退', transition: { from: 'completed', to: 'todo 或 in_progress' } })])), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_DESIGN_CANDIDATE_SCHEMA_INVALID')
  assert.throws(() => validateTestCaseDesignCandidate({ ...candidate(cases, [claim('SC-1', 'TC-1')]), confirmationItems: [{ title: 'Agent 不应创建交接确认', question: '缺少 selector', decisionType: 'execution_contract', impactStage: 'handoff', affectedRefs: ['TC-1'], blocker: true }] }), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_DESIGN_CANDIDATE_SCHEMA_INVALID')
})

test('执行契约待确认是 handoff gate，明确 Expected Result 不会误报语义不清', () => {
  const pending = content(['REQ-1'], '状态迁移')
  pending.executionMethods = [{ ...pending.executionMethods[0], uiSpec: { entry: '/login', selectors: [] }, executionReadiness: 'needs_confirmation', automationHint: 'UI 定位器待确认' }]
  pending.executionSpec = { ...pending.executionSpec!, executionReadiness: 'needs_confirmation', automationHint: 'UI 定位器待确认' }
  const result = audit([testCase('TC-READY', pending)], ['REQ-1'], [claim('SC-READY', 'TC-READY', { kind: 'state_transition', subject: 'task.status', variant: 'todo->in_progress', polarity: 'positive', oracle: '状态为 in_progress' })])
  assert.ok(result.blockers.some(item => item.code === 'TEST_CASE_NOT_READY' && item.resolution === 'execution_handoff'))
  assert.equal(result.blockers.some(item => item.code === 'TEST_CASE_EXPECTED_RESULT_UNCLEAR'), false)
})

test('缺少 UI/API 执行数据时允许留空，Service Validator 不改写候选 readiness', () => {
  const pending = validateTestCaseContent({
    ...content(['REQ-1'], '跨通道状态迁移'),
    executionMethods: [
      { ...executionMethods[0], uiSpec: { entry: '', selectors: [] }, executionReadiness: 'ready' },
      { method: 'api', apiSpec: { method: '', path: '' }, steps: [{ key: 'api-step-1', action: '提交状态变更请求', expected: '任务状态变更为 in_progress' }], verificationChecks: [], executionReadiness: 'ready', automationHint: '' },
    ],
    executionSpec: { kind: 'functional', method: 'api' },
  })
  assert.equal(pending.executionMethods.find(item => item.method === 'ui')?.executionReadiness, 'ready')
  const api = pending.executionMethods.find(item => item.method === 'api')
  assert.equal(api?.executionReadiness, 'ready')
  assert.deepEqual(api?.method === 'api' ? api.apiSpec : undefined, { method: '', path: '' })
})

test('ScenarioClaim.oracle 自身待确认或弱 Oracle 会报告业务 Expected Result 不清', () => {
  const pendingOracle = audit([testCase('TC-ORACLE', content(['REQ-1']))], ['REQ-1'], [claim('SC-ORACLE', 'TC-ORACLE', { kind: 'state_transition', subject: 'task.status', variant: 'todo->in_progress', polarity: 'positive', oracle: '待确认具体状态表现' })])
  assert.ok(pendingOracle.blockers.some(item => item.code === 'TEST_CASE_EXPECTED_RESULT_UNCLEAR' && item.resolution === 'human_decision'))
  const weakOracle = audit([testCase('TC-WEAK', content(['REQ-1']))], ['REQ-1'], [claim('SC-WEAK', 'TC-WEAK', { kind: 'filter', subject: 'task.status', variant: 'status=todo', polarity: 'positive', oracle: '查询成功' })])
  assert.ok(weakOracle.blockers.some(item => item.code === 'TEST_CASE_EXPECTED_RESULT_UNCLEAR'))
})

test('合法 todo 状态不是 TODO 占位词，明确状态 Oracle 不会误报', () => {
  const todoState = audit([testCase('TC-TODO', content(['REQ-1']))], ['REQ-1'], [claim('SC-TODO', 'TC-TODO', { kind: 'state_transition', subject: 'task.status', variant: 'todo->in_progress', polarity: 'positive', oracle: 'todo 任务变更后查询显示 in_progress。' })])
  assert.equal(todoState.blockers.some(item => item.code === 'TEST_CASE_EXPECTED_RESULT_UNCLEAR'), false)
  const placeholder = audit([testCase('TC-PLACEHOLDER', content(['REQ-1']))], ['REQ-1'], [claim('SC-PLACEHOLDER', 'TC-PLACEHOLDER', { kind: 'state_transition', subject: 'task.status', variant: 'todo->in_progress', polarity: 'positive', oracle: 'TODO：补充状态变更后的业务结果。' })])
  assert.ok(placeholder.blockers.some(item => item.code === 'TEST_CASE_EXPECTED_RESULT_UNCLEAR'))
})
