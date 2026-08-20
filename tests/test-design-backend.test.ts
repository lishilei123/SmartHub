import assert from 'node:assert/strict'
import test from 'node:test'
import { auditTestDesignCoverage } from '../server/application/test-design-coverage-auditor.js'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import { TestDesignError, validateTestCaseDesignCandidate, validateTestCaseContent } from '../server/application/test-design-validation.js'
import type { TestCase, TestCaseContent } from '../server/domain/test-design-types.js'

const executionMethods = [{ method: 'ui' as const, uiSpec: { entry: '/login' }, steps: [{ key: 'step-1', action: '提交表单', expected: '显示登录成功' }], verificationChecks: [{ key: 'check-1', description: '页面显示首页' }], executionReadiness: 'ready' as const, automationHint: 'UI 自动化' }]
function content(requirementRefs: string[], objective = '验证登录行为'): TestCaseContent { return { schemaVersion: 'test-case/v2', title: objective, objective, dimension: 'functional', requirementRefs, priority: 'P0', preconditions: [], dataRequirementIds: [], cleanup: [], dependencies: [], executionMethods, executionSpec: { kind: 'functional', method: 'ui', steps: executionMethods[0].steps, verificationChecks: executionMethods[0].verificationChecks, preconditions: [], testDataRequirements: [], executionReadiness: 'ready', automationHint: 'UI 自动化' }, sharedVerificationChecks: [], tags: [], domain: '认证' } }
function testCase(id: string, value: TestCaseContent, reviewState: TestCase['reviewState'] = 'approved'): TestCase { const revision = { revision: 0, content: value, contentSha256: canonicalSha256(value), semanticSha256: canonicalSha256({ ...value, tags: [] }), diff: [], editorId: 'test', reason: 'test', createdAt: new Date().toISOString() }; return { id, runId: 'run-1', origin: 'ai', currentRevision: 0, reviewState, revisions: [revision], reviewActions: [] } }
function basis(ids: string[], cues = '') { return { schemaVersion: 'test-design-basis-snapshot/v2', projectVersionId: 'pv-1', requirementReleaseId: 'release-1', verificationRunId: 'review-1', requirementsJsonSha256: 'a'.repeat(64), items: ids.map(id => ({ id: `basis-${id}`, kind: 'requirement_release', sourceId: 'release-1', contentSha256: canonicalSha256({ id, cues }), content: { id, description: `${id} ${cues}` }, locator: { requirementPointId: id }, createdAt: new Date().toISOString() })), clarifications: [], createdAt: new Date().toISOString(), snapshotSha256: 'b'.repeat(64) } as never }
function audit(cases: TestCase[], ids: string[], cues = '') { return auditTestDesignCoverage({ runId: 'run-1', basis: basis(ids, cues), retrieval: { snapshotSha256: 'c'.repeat(64) } as never, historical: { items: [], snapshotSha256: 'd'.repeat(64) } as never, cases, dataSet: { id: 'data-1', version: 1, requirements: [], contentSha256: 'e'.repeat(64), createdAt: new Date().toISOString(), createdBy: 'test' }, findings: [], confirmationItems: [] }) }

test('TestCase 候选直接使用 Requirement refs，并允许一个 Requirement 展开多条场景', () => {
  const value = validateTestCaseDesignCandidate({ schemaVersion: 'test-case-design/v1', cases: [content(['REQ-1'], '正确密码登录'), content(['REQ-1'], '密码错误'), content(['REQ-1', 'REQ-2'], '登录后跳转')].map((item, index) => ({ ref: `case-${index + 1}`, ...item })), dataRequirements: [], findings: [], confirmationItems: [], proposals: [] })
  assert.equal(value.cases.length, 3)
  assert.deepEqual(value.cases[2].content.requirementRefs, ['REQ-1', 'REQ-2'])
  assert.throws(() => validateTestCaseContent({ ...content(['REQ-1']), legacyRefs: ['legacy-reference'] }), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID')
})

test('Coverage Audit 直接建立 Requirement 到 TestCase 关系，并识别多需求闭环', () => {
  const result = audit([testCase('case-1', content(['REQ-1', 'REQ-2']))], ['REQ-1', 'REQ-2'])
  assert.equal(result.statistics.totalBasis, 2)
  assert.equal(result.statistics.coveredBasis, 2)
  assert.deepEqual(result.relations.map(item => item.caseId), ['case-1', 'case-1'])
  assert.equal(result.relations.every(item => item.requirementId === 'REQ-1' || item.requirementId === 'REQ-2'), true)
})

test('Coverage Audit 将需求缺失、重复和过浅覆盖交给 Agent Repair', () => {
  const broad = testCase('case-1', content(['REQ-1'], '验证登录'))
  const shallow = audit([broad], ['REQ-1'], '正常异常边界权限状态')
  assert.ok(shallow.blockers.some(item => item.code === 'TEST_CASE_COVERAGE_TOO_SHALLOW' && item.resolution === 'agent_repair'))
  const uncovered = audit([testCase('case-1', content(['REQ-1']))], ['REQ-1', 'REQ-2'])
  assert.ok(uncovered.blockers.some(item => item.code === 'COVERAGE_REQUIREMENT_UNCOVERED'))
})
