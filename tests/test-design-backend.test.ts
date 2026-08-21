import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import { auditTestDesignCoverage } from '../server/application/test-design-coverage-auditor.js'
import { validateTestCaseContent, validateTestCaseDesignCandidate } from '../server/application/test-design-validation.js'
import type { EffectiveTestCase, TestCaseContent } from '../server/domain/test-design-types.js'

function content(overrides: Partial<TestCaseContent> = {}): TestCaseContent {
  return {
    schemaVersion: 'test-case/v3',
    title: '用户成功创建任务',
    dimension: 'functional',
    priority: 'P1',
    requirementRefs: ['REQ-1'],
    executionMethods: ['ui', 'api'],
    preconditions: ['用户已登录'],
    steps: ['输入任务标题并提交'],
    expectedResults: ['任务创建成功并返回唯一标识'],
    ...overrides,
  }
}

function candidateCase(ref: string, value = content()) { return { ref, ...value } }

function effectiveCase(id: string, value: TestCaseContent): EffectiveTestCase {
  const hash = canonicalSha256(value)
  return { caseId: id, revision: 1, content: value, contentSha256: hash, source: 'candidate_create', candidateCaseId: id }
}

test('TestCase v3 只接受统一语义字段，且扩展测试允许空 requirementRefs', () => {
  const extended = validateTestCaseContent(content({ requirementRefs: [], executionMethods: ['api'] }))
  assert.deepEqual(extended.requirementRefs, [])
  assert.deepEqual(extended.executionMethods, ['api'])
  assert.throws(() => validateTestCaseContent({ ...content(), executionSpec: {} }), /TEST_CASE_SCHEMA_INVALID/u)
  assert.throws(() => validateTestCaseContent({ ...content(), executionMethods: ['ui', 'ui'] }), /executionMethods 不能重复/u)
})

test('test-case-design/v3 Candidate 根和 Case 都是闭合结构', () => {
  const result = validateTestCaseDesignCandidate({ schemaVersion: 'test-case-design/v3', cases: [candidateCase('TC-1')] })
  assert.equal(result.schemaVersion, 'test-case-design/v3')
  assert.deepEqual(validateTestCaseDesignCandidate({ schemaVersion: 'test-case-design/v3', cases: [] }), { schemaVersion: 'test-case-design/v3', cases: [] })
  assert.throws(() => validateTestCaseDesignCandidate({ schemaVersion: 'test-case-design/v2', cases: [] }), /test-case-design\/v3/u)
  assert.throws(() => validateTestCaseDesignCandidate({ schemaVersion: 'test-case-design/v3', cases: [{ ...candidateCase('TC-1'), findings: [] }] }), /不允许的字段/u)
})

test('test-design-repair/v3 只接受 base hash、upsert 和 remove', () => {
  const result = validateTestCaseDesignCandidate({ schemaVersion: 'test-design-repair/v3', baseCandidateSha256: 'a'.repeat(64), upsertCases: [candidateCase('TC-1')], removeCaseRefs: ['TC-2'] }, true)
  assert.equal(result.schemaVersion, 'test-design-repair/v3')
  assert.deepEqual(validateTestCaseDesignCandidate({ schemaVersion: 'test-design-repair/v3', baseCandidateSha256: 'a'.repeat(64), upsertCases: [], removeCaseRefs: ['TC-2'] }, true), { schemaVersion: 'test-design-repair/v3', baseCandidateSha256: 'a'.repeat(64), upsertCases: [], removeCaseRefs: ['TC-2'] })
  assert.throws(() => validateTestCaseDesignCandidate({ schemaVersion: 'test-design-repair/v3', baseCandidateSha256: 'a'.repeat(64), upsertCases: [candidateCase('TC-1')], removeCaseRefs: [], proposals: [] }, true), /不允许的字段/u)
})

test('Coverage 只统计显式 Requirement 引用，扩展测试既不覆盖也不阻断', () => {
  const audit = auditTestDesignCoverage({
    runId: 'run-1',
    basis: { requirementReleaseId: 'release-1', snapshotSha256: 'b'.repeat(64), content: { requirements: [{ clientRequirementPointId: 'REQ-1', coverageTarget: true }, { clientRequirementPointId: 'REQ-2', coverageTarget: true }], clarifications: [] } } as never,
    retrieval: { snapshotSha256: 'c'.repeat(64) } as never,
    historical: { snapshotSha256: 'd'.repeat(64), items: [] } as never,
    cases: [effectiveCase('case-formal', content()), effectiveCase('case-extended', content({ title: '越权风险探索', requirementRefs: [], dimension: 'security' }))],
  })
  assert.deepEqual(audit.statistics, { totalBasis: 2, coveredBasis: 1, totalCases: 2 })
  assert.ok(audit.blockers.some(item => item.code === 'COVERAGE_REQUIREMENT_UNCOVERED' && item.subjectId === 'REQ-2'))
  assert.ok(!audit.blockers.some(item => item.subjectId === 'case-extended'))
  assert.ok(audit.advisories.some(item => item.code === 'EXTENDED_RISK_TEST_CASES_PRESENT'))
})

test('Coverage 对无效 Requirement 引用阻断，可疑重复只给 Advisory', () => {
  const duplicate = content({ requirementRefs: ['REQ-NOT-FOUND'] })
  const audit = auditTestDesignCoverage({
    runId: 'run-1',
    basis: { requirementReleaseId: 'release-1', snapshotSha256: 'b'.repeat(64), content: { requirements: [{ clientRequirementPointId: 'REQ-1', coverageTarget: true }], clarifications: [] } } as never,
    retrieval: { snapshotSha256: 'c'.repeat(64) } as never,
    historical: { snapshotSha256: 'd'.repeat(64), items: [] } as never,
    cases: [effectiveCase('case-1', duplicate), effectiveCase('case-2', duplicate)],
  })
  assert.ok(audit.blockers.some(item => item.code === 'TEST_CASE_REQUIREMENT_REFERENCE_INVALID'))
  assert.ok(audit.advisories.some(item => item.code === 'POSSIBLE_DUPLICATE_TEST_CASE'))
  assert.ok(!audit.blockers.some(item => item.code === 'POSSIBLE_DUPLICATE_TEST_CASE'))
})
