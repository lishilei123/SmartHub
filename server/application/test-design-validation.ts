import type { CreateTestDesignInput, TestCaseContent, TestDimension } from '../domain/test-design-types.js'
import type { AgentTestSpec, AgentValueAssertionOperator } from '../domain/agent-test-types.js'

export class TestDesignError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400, public readonly details?: unknown) {
    super(`${code}: ${message}`)
    this.name = 'TestDesignError'
  }
}

export function validateCreateTestDesignInput(value: unknown): CreateTestDesignInput {
  const input = object(value, 'TEST_DESIGN_INPUT_INVALID', '创建参数必须是对象')
  rejectUnknown(input, ['name', 'objective', 'requirementReleaseId', 'includedScopes', 'excludedScopes', 'focusDimensions', 'executionMethods', 'knowledgeAugmentation'], 'TEST_DESIGN_INPUT_INVALID')
  return {
    name: requiredText(input.name, 'name', 200, 'TEST_DESIGN_INPUT_INVALID'),
    objective: requiredText(input.objective, 'objective', 4_000, 'TEST_DESIGN_INPUT_INVALID'),
    ...(input.requirementReleaseId === undefined ? {} : { requirementReleaseId: requiredText(input.requirementReleaseId, 'requirementReleaseId', 200, 'TEST_DESIGN_INPUT_INVALID') }),
    includedScopes: optionalScopeRules(input.includedScopes),
    excludedScopes: optionalScopeRules(input.excludedScopes),
    focusDimensions: optionalDimensions(input.focusDimensions, ['functional', 'performance', 'stability', 'compatibility', 'security']),
    executionMethods: optionalExecutionMethods(input.executionMethods, ['agent']),
    knowledgeAugmentation: validateAugmentation(input.knowledgeAugmentation ?? { mode: 'disabled' }),
  }
}

export function validateTestCaseContent(value: unknown): TestCaseContent {
  const input = object(value, 'TEST_CASE_SCHEMA_INVALID', 'TestCase 必须是对象')
  rejectUnknown(input, ['schemaVersion', 'title', 'dimension', 'priority', 'requirementRefs', 'executionMethods', 'preconditions', 'steps', 'expectedResults', 'agentTestSpec'], 'TEST_CASE_SCHEMA_INVALID')
  if (input.schemaVersion !== 'test-case/v3') fail('TEST_CASE_SCHEMA_INVALID', 'schemaVersion 必须为 test-case/v3', 422)
  const methods = executionMethods(input.executionMethods)
  const agentTestSpec = validateAgentTestSpec(input.agentTestSpec)
  return {
    schemaVersion: 'test-case/v3',
    title: requiredText(input.title, 'title', 500, 'TEST_CASE_SCHEMA_INVALID'),
    dimension: dimension(input.dimension),
    priority: priority(input.priority),
    requirementRefs: uniqueTexts(input.requirementRefs, 'requirementRefs', 1_000, 500, 'TEST_CASE_SCHEMA_INVALID'),
    executionMethods: methods,
    preconditions: texts(input.preconditions, 'preconditions', 100, 2_000, 'TEST_CASE_SCHEMA_INVALID'),
    steps: nonEmptyTexts(input.steps, 'steps', 200, 4_000),
    expectedResults: nonEmptyTexts(input.expectedResults, 'expectedResults', 200, 4_000),
    agentTestSpec,
  }
}

export type CandidateCase = { ref: string; content: TestCaseContent }
export interface TestCaseDesignCandidate extends Record<string, unknown> { schemaVersion: 'test-case-design/v3'; cases: CandidateCase[] }
export interface TestDesignRepairPatch extends Record<string, unknown> { schemaVersion: 'test-design-repair/v3'; baseCandidateSha256: string; upsertCases: CandidateCase[]; removeCaseRefs: string[] }
export type TestCaseDesignCandidateSubmission = Record<string, unknown>

export function isTestDesignRepairPatch(value: TestCaseDesignCandidate | TestDesignRepairPatch): value is TestDesignRepairPatch { return value.schemaVersion === 'test-design-repair/v3' }

export function validateTestCaseDesignCandidate(value: unknown, repair = false): TestCaseDesignCandidate | TestDesignRepairPatch {
  const input = synthesisObject(value, '/', '提交结果必须是对象')
  if (repair) return validateRepairPatch(input)
  synthesisRejectUnknown(input, ['schemaVersion', 'cases'], '/')
  if (input.schemaVersion !== 'test-case-design/v3') synthesisFail('/schemaVersion', 'schemaVersion 必须为 test-case-design/v3')
  return { schemaVersion: 'test-case-design/v3', cases: validateCandidateCases(input.cases, '/cases', true) }
}

function validateRepairPatch(input: Record<string, unknown>): TestDesignRepairPatch {
  synthesisRejectUnknown(input, ['schemaVersion', 'baseCandidateSha256', 'upsertCases', 'removeCaseRefs'], '/')
  if (input.schemaVersion !== 'test-design-repair/v3') synthesisFail('/schemaVersion', 'schemaVersion 必须为 test-design-repair/v3')
  const baseCandidateSha256 = synthesisText(input.baseCandidateSha256, '/baseCandidateSha256', 128)
  if (!/^[a-f0-9]{64}$/u.test(baseCandidateSha256)) synthesisFail('/baseCandidateSha256', '必须为 64 位小写 SHA-256')
  const upsertCases = validateCandidateCases(input.upsertCases, '/upsertCases', true)
  const removeCaseRefs = uniqueSynthesisTexts(input.removeCaseRefs, '/removeCaseRefs', 1_000, 200)
  const overlap = upsertCases.map(item => item.ref).filter(ref => removeCaseRefs.includes(ref))
  if (overlap.length) synthesisFail('/removeCaseRefs', `不能同时删除和更新同一 Case：${overlap.join('、')}`)
  return { schemaVersion: 'test-design-repair/v3', baseCandidateSha256, upsertCases, removeCaseRefs }
}

function validateCandidateCases(value: unknown, path: string, allowEmpty: boolean): CandidateCase[] {
  if (!Array.isArray(value) || value.length > 2_000 || (!allowEmpty && value.length === 0)) synthesisFail(path, allowEmpty ? '必须是最多 2000 条用例的数组' : '必须包含 1 到 2000 条用例')
  const cases = value.map((candidate, index) => {
    const casePath = `${path}/${index}`
    const input = synthesisObject(candidate, casePath, '必须是扁平 TestCase 对象')
    synthesisRejectUnknown(input, ['ref', 'schemaVersion', 'title', 'dimension', 'priority', 'requirementRefs', 'executionMethods', 'preconditions', 'steps', 'expectedResults', 'agentTestSpec'], casePath)
    const ref = synthesisText(input.ref, `${casePath}/ref`, 200)
    const { ref: _ref, ...content } = input
    try { return { ref, content: validateTestCaseContent(content) } }
    catch (error) {
      if (error instanceof TestDesignError) synthesisFail(casePath, error.message.replace(/^TEST_CASE_SCHEMA_INVALID:\s*/u, ''))
      throw error
    }
  })
  const refs = cases.map(item => item.ref)
  if (new Set(refs).size !== refs.length) synthesisFail(path, 'ref 不能重复')
  return cases
}

/** v3 has no dependency field. */
export function validateCaseDependencyGraph(_cases: Array<{ id: string; content: TestCaseContent }>) {}
export function etag(kind: 'tree' | 'case', id: string, revision: number, hash: string) { return `\"${kind}:${id}:r${revision}:${hash}\"` }
export function assertEtag(actual: string | undefined, expected: string, code: string) { if (!actual || actual !== expected) fail(code, 'If-Match 与当前 Revision 不一致', 409) }

function optionalExecutionMethods(value: unknown, fallback: Array<'agent'> = []): Array<'agent'> { if (value === undefined) return [...fallback]; if (!Array.isArray(value) || value.length !== 1 || value[0] !== 'agent') fail('TEST_DESIGN_INPUT_INVALID', 'executionMethods 只能为 [agent]', 422); return ['agent'] }
function executionMethods(value: unknown): Array<'agent'> { if (!Array.isArray(value) || value.length !== 1 || value[0] !== 'agent') fail('TEST_CASE_SCHEMA_INVALID', 'executionMethods 必须且只能为 [agent]', 422); return ['agent'] }

function validateAgentTestSpec(value: unknown): AgentTestSpec {
  const input = object(value, 'TEST_CASE_SCHEMA_INVALID', 'agentTestSpec 必须是对象')
  rejectUnknown(input, ['input', 'context', 'expectedOutcome', 'requiredTools', 'forbiddenTools', 'requiredActions', 'forbiddenActions', 'argumentAssertions', 'sequenceConstraints', 'businessAssertions', 'artifactAssertions', 'semanticAssertions', 'safetyAssertions', 'executionConstraints'], 'TEST_CASE_SCHEMA_INVALID')
  if (!Object.hasOwn(input, 'input')) fail('TEST_CASE_SCHEMA_INVALID', 'agentTestSpec.input 必须存在', 422)
  const context = input.context === undefined ? undefined : jsonObject(input.context, 'agentTestSpec.context')
  const requiredTools = uniqueTexts(input.requiredTools, 'agentTestSpec.requiredTools', 100, 200, 'TEST_CASE_SCHEMA_INVALID')
  const forbiddenTools = uniqueTexts(input.forbiddenTools, 'agentTestSpec.forbiddenTools', 100, 200, 'TEST_CASE_SCHEMA_INVALID')
  const requiredActions = uniqueTexts(input.requiredActions, 'agentTestSpec.requiredActions', 100, 200, 'TEST_CASE_SCHEMA_INVALID')
  const forbiddenActions = uniqueTexts(input.forbiddenActions, 'agentTestSpec.forbiddenActions', 100, 200, 'TEST_CASE_SCHEMA_INVALID')
  rejectOverlap(requiredTools, forbiddenTools, 'Tool')
  rejectOverlap(requiredActions, forbiddenActions, 'Action')
  const execution = object(input.executionConstraints, 'TEST_CASE_SCHEMA_INVALID', 'agentTestSpec.executionConstraints 必须是对象')
  rejectUnknown(execution, ['timeoutMs', 'maxSteps', 'repeatCount', 'maxCost'], 'TEST_CASE_SCHEMA_INVALID')
  const maxCost = execution.maxCost === undefined ? undefined : finiteNumber(execution.maxCost, 'agentTestSpec.executionConstraints.maxCost', 0, 1_000_000)
  return {
    input: jsonValue(input.input, 'agentTestSpec.input'),
    ...(context ? { context } : {}),
    expectedOutcome: requiredText(input.expectedOutcome, 'agentTestSpec.expectedOutcome', 4_000, 'TEST_CASE_SCHEMA_INVALID'),
    requiredTools,
    forbiddenTools,
    requiredActions,
    forbiddenActions,
    argumentAssertions: objectArray(input.argumentAssertions, 'agentTestSpec.argumentAssertions', 200, (item, path) => {
      rejectUnknown(item, ['tool', 'path', 'operator', 'expected'], 'TEST_CASE_SCHEMA_INVALID')
      const operator = assertionOperator(item.operator, `${path}.operator`)
      return { tool: requiredText(item.tool, `${path}.tool`, 200, 'TEST_CASE_SCHEMA_INVALID'), path: jsonPath(item.path, `${path}.path`), operator, ...assertionExpected(item, operator, path) }
    }),
    sequenceConstraints: objectArray(input.sequenceConstraints, 'agentTestSpec.sequenceConstraints', 200, (item, path) => {
      rejectUnknown(item, ['before', 'after'], 'TEST_CASE_SCHEMA_INVALID')
      const before = requiredText(item.before, `${path}.before`, 200, 'TEST_CASE_SCHEMA_INVALID')
      const after = requiredText(item.after, `${path}.after`, 200, 'TEST_CASE_SCHEMA_INVALID')
      if (before === after) fail('TEST_CASE_SCHEMA_INVALID', `${path} 的 before 与 after 不能相同`, 422)
      return { before, after }
    }),
    businessAssertions: objectArray(input.businessAssertions, 'agentTestSpec.businessAssertions', 200, (item, path) => {
      rejectUnknown(item, ['path', 'operator', 'expected'], 'TEST_CASE_SCHEMA_INVALID')
      const operator = assertionOperator(item.operator, `${path}.operator`)
      return { path: jsonPath(item.path, `${path}.path`), operator, ...assertionExpected(item, operator, path) }
    }),
    artifactAssertions: objectArray(input.artifactAssertions, 'agentTestSpec.artifactAssertions', 100, (item, path) => {
      rejectUnknown(item, ['name'], 'TEST_CASE_SCHEMA_INVALID')
      return { name: requiredText(item.name, `${path}.name`, 500, 'TEST_CASE_SCHEMA_INVALID') }
    }),
    semanticAssertions: objectArray(input.semanticAssertions, 'agentTestSpec.semanticAssertions', 100, (item, path) => {
      rejectUnknown(item, ['criterion', 'expected'], 'TEST_CASE_SCHEMA_INVALID')
      return { criterion: requiredText(item.criterion, `${path}.criterion`, 1_000, 'TEST_CASE_SCHEMA_INVALID'), expected: requiredText(item.expected, `${path}.expected`, 4_000, 'TEST_CASE_SCHEMA_INVALID') }
    }),
    safetyAssertions: objectArray(input.safetyAssertions, 'agentTestSpec.safetyAssertions', 100, (item, path) => {
      rejectUnknown(item, ['criterion', 'expected'], 'TEST_CASE_SCHEMA_INVALID')
      return { criterion: requiredText(item.criterion, `${path}.criterion`, 1_000, 'TEST_CASE_SCHEMA_INVALID'), expected: requiredText(item.expected, `${path}.expected`, 4_000, 'TEST_CASE_SCHEMA_INVALID') }
    }),
    executionConstraints: {
      timeoutMs: integer(execution.timeoutMs, 'agentTestSpec.executionConstraints.timeoutMs', 100, 600_000),
      maxSteps: integer(execution.maxSteps, 'agentTestSpec.executionConstraints.maxSteps', 1, 10_000),
      repeatCount: integer(execution.repeatCount, 'agentTestSpec.executionConstraints.repeatCount', 1, 50),
      ...(maxCost === undefined ? {} : { maxCost }),
    },
  }
}

function rejectOverlap(left: string[], right: string[], label: string) { const overlap = left.filter(item => right.includes(item)); if (overlap.length) fail('TEST_CASE_SCHEMA_INVALID', `${label} 不能同时 required 和 forbidden：${overlap.join('、')}`, 422) }
function assertionOperator(value: unknown, field: string): AgentValueAssertionOperator { if (!['equals', 'not_equals', 'contains', 'matches', 'exists'].includes(String(value))) fail('TEST_CASE_SCHEMA_INVALID', `${field} 无效`, 422); return value as AgentValueAssertionOperator }
function assertionExpected(item: Record<string, unknown>, operator: AgentValueAssertionOperator, path: string) { if (operator === 'exists') { if (Object.hasOwn(item, 'expected')) fail('TEST_CASE_SCHEMA_INVALID', `${path}.expected 不适用于 exists`, 422); return {} } if (!Object.hasOwn(item, 'expected')) fail('TEST_CASE_SCHEMA_INVALID', `${path}.expected 必须存在`, 422); const expected = jsonValue(item.expected, `${path}.expected`); if (operator === 'matches') { if (typeof expected !== 'string') fail('TEST_CASE_SCHEMA_INVALID', `${path}.expected 必须是正则字符串`, 422); try { new RegExp(expected, 'u') } catch { fail('TEST_CASE_SCHEMA_INVALID', `${path}.expected 不是有效正则表达式`, 422) } } return { expected } }
function objectArray<T>(value: unknown, field: string, maxItems: number, mapper: (item: Record<string, unknown>, path: string) => T): T[] { if (!Array.isArray(value) || value.length > maxItems) fail('TEST_CASE_SCHEMA_INVALID', `${field} 必须是最多 ${maxItems} 项的数组`, 422); return value.map((item, index) => mapper(object(item, 'TEST_CASE_SCHEMA_INVALID', `${field}[${index}] 必须是对象`), `${field}[${index}]`)) }
function jsonPath(value: unknown, field: string) { const content = requiredText(value, field, 500, 'TEST_CASE_SCHEMA_INVALID'); if (content !== '$' && !/^[A-Za-z_][A-Za-z0-9_-]*(?:\.(?:[A-Za-z_][A-Za-z0-9_-]*|\d+))*$/u.test(content)) fail('TEST_CASE_SCHEMA_INVALID', `${field} 不是有效 JSON 路径`, 422); return content }
function integer(value: unknown, field: string, min: number, max: number) { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail('TEST_CASE_SCHEMA_INVALID', `${field} 必须是 ${min} 到 ${max} 的整数`, 422); return value }
function finiteNumber(value: unknown, field: string, min: number, max: number) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail('TEST_CASE_SCHEMA_INVALID', `${field} 必须是 ${min} 到 ${max} 的有限数字`, 422); return value }
function jsonObject(value: unknown, field: string): Record<string, unknown> { const result = jsonValue(value, field); if (!result || typeof result !== 'object' || Array.isArray(result)) fail('TEST_CASE_SCHEMA_INVALID', `${field} 必须是 JSON 对象`, 422); return result as Record<string, unknown> }
function jsonValue(value: unknown, field: string, depth = 0): unknown { if (depth > 20) fail('TEST_CASE_SCHEMA_INVALID', `${field} 嵌套过深`, 422); if (value === null || typeof value === 'string' || typeof value === 'boolean') return value; if (typeof value === 'number' && Number.isFinite(value)) return value; if (Array.isArray(value)) { if (value.length > 1_000) fail('TEST_CASE_SCHEMA_INVALID', `${field} 数组过长`, 422); return value.map((item, index) => jsonValue(item, `${field}[${index}]`, depth + 1)) } if (value && typeof value === 'object') { const entries = Object.entries(value as Record<string, unknown>); if (entries.length > 1_000) fail('TEST_CASE_SCHEMA_INVALID', `${field} 对象字段过多`, 422); return Object.fromEntries(entries.map(([key, item]) => [requiredText(key, `${field}.key`, 500, 'TEST_CASE_SCHEMA_INVALID'), jsonValue(item, `${field}.${key}`, depth + 1)])) } fail('TEST_CASE_SCHEMA_INVALID', `${field} 必须是 JSON 值`, 422) }
function dimension(value: unknown): TestDimension { if (!['functional', 'performance', 'stability', 'compatibility', 'security'].includes(String(value))) fail('TEST_CASE_SCHEMA_INVALID', 'dimension 无效', 422); return value as TestDimension }
function priority(value: unknown): TestCaseContent['priority'] { if (!['P0', 'P1', 'P2', 'P3'].includes(String(value))) fail('TEST_CASE_SCHEMA_INVALID', 'priority 无效', 422); return value as TestCaseContent['priority'] }
function validateAugmentation(value: unknown): CreateTestDesignInput['knowledgeAugmentation'] {
  const input = object(value, 'TEST_DESIGN_AUGMENTATION_INVALID', 'knowledgeAugmentation 必须是对象')
  if (input.mode === 'disabled') { rejectUnknown(input, ['mode'], 'TEST_DESIGN_AUGMENTATION_INVALID'); return { mode: 'disabled' } }
  if (input.mode === 'selected_assets') { rejectUnknown(input, ['mode', 'assetVersionIds'], 'TEST_DESIGN_AUGMENTATION_INVALID'); return { mode: 'selected_assets', assetVersionIds: uniqueTexts(input.assetVersionIds, 'assetVersionIds', 1_000, 500, 'TEST_DESIGN_AUGMENTATION_INVALID') } }
  if (input.mode === 'fixed_index') { rejectUnknown(input, ['mode', 'indexVersionId', 'filters'], 'TEST_DESIGN_AUGMENTATION_INVALID'); return { mode: 'fixed_index', indexVersionId: requiredText(input.indexVersionId, 'indexVersionId', 500, 'TEST_DESIGN_AUGMENTATION_INVALID'), ...(input.filters === undefined ? {} : { filters: stringFilters(input.filters) }) } }
  fail('TEST_DESIGN_AUGMENTATION_INVALID', 'knowledgeAugmentation.mode 无效')
}
function optionalDimensions(value: unknown, fallback: TestDimension[]): TestDimension[] { if (value === undefined) return [...fallback]; if (!Array.isArray(value)) fail('TEST_DESIGN_INPUT_INVALID', 'focusDimensions 必须是数组'); return [...new Set(value.map(dimension))] }
function optionalScopeRules(value: unknown) { if (value === undefined) return []; if (!Array.isArray(value) || value.length > 100) fail('TEST_DESIGN_INPUT_INVALID', '范围规则必须是数组'); return value.map(candidate => { const input = object(candidate, 'TEST_DESIGN_INPUT_INVALID', '范围规则必须是对象'); rejectUnknown(input, ['kind', 'value'], 'TEST_DESIGN_INPUT_INVALID'); return { kind: requiredText(input.kind, 'scope.kind', 100, 'TEST_DESIGN_INPUT_INVALID'), value: requiredText(input.value, 'scope.value', 1_000, 'TEST_DESIGN_INPUT_INVALID') } }) }
function optionalTexts(value: unknown, field: string, maxItems: number, maxLength: number, code: string) { return value === undefined ? [] : texts(value, field, maxItems, maxLength, code) }
function nonEmptyTexts(value: unknown, field: string, maxItems: number, maxLength: number) { const result = texts(value, field, maxItems, maxLength, 'TEST_CASE_SCHEMA_INVALID'); if (!result.length) fail('TEST_CASE_SCHEMA_INVALID', `${field} 至少包含一项`, 422); return result }
function texts(value: unknown, field: string, maxItems: number, maxLength: number, code: string) { if (!Array.isArray(value) || value.length > maxItems) fail(code, `${field} 必须是最多 ${maxItems} 项的数组`, 422); return value.map((item, index) => requiredText(item, `${field}[${index}]`, maxLength, code)) }
function uniqueTexts(value: unknown, field: string, maxItems: number, maxLength: number, code: string) { const result = texts(value, field, maxItems, maxLength, code); if (new Set(result).size !== result.length) fail(code, `${field} 不能重复`, 422); return result }
function stringFilters(value: unknown) { const input = object(value, 'TEST_DESIGN_AUGMENTATION_INVALID', 'filters 必须是对象'); return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, Array.isArray(item) ? item.map(entry => requiredText(entry, `filters.${key}`, 500, 'TEST_DESIGN_AUGMENTATION_INVALID')) : requiredText(item, `filters.${key}`, 500, 'TEST_DESIGN_AUGMENTATION_INVALID')])) }
function object(value: unknown, code: string, message: string) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, message, 422); return value as Record<string, unknown> }
function rejectUnknown(value: Record<string, unknown>, allowed: string[], code: string) { const unexpected = Object.keys(value).filter(key => !allowed.includes(key)); if (unexpected.length) fail(code, `包含不允许的字段：${unexpected.join('、')}`, 422) }
function requiredText(value: unknown, field: string, max: number, code: string) { if (typeof value !== 'string' || !value.trim() || value.length > max) fail(code, `${field} 必须是长度不超过 ${max} 的非空字符串`, 422); return value.trim() }
function synthesisObject(value: unknown, path: string, message: string) { if (!value || typeof value !== 'object' || Array.isArray(value)) synthesisFail(path, message); return value as Record<string, unknown> }
function synthesisRejectUnknown(value: Record<string, unknown>, allowed: string[], path: string) { const unexpected = Object.keys(value).filter(key => !allowed.includes(key)); if (unexpected.length) synthesisFail(path, `包含不允许的字段：${unexpected.join('、')}`) }
function synthesisText(value: unknown, path: string, max: number) { if (typeof value !== 'string' || !value.trim() || value.length > max) synthesisFail(path, `必须是长度不超过 ${max} 的非空字符串`); return value.trim() }
function uniqueSynthesisTexts(value: unknown, path: string, maxItems: number, maxLength: number) { if (!Array.isArray(value) || value.length > maxItems) synthesisFail(path, `必须是最多 ${maxItems} 项的数组`); const result = value.map((item, index) => synthesisText(item, `${path}/${index}`, maxLength)); if (new Set(result).size !== result.length) synthesisFail(path, '不能重复'); return result }
function synthesisFail(path: string, message: string): never { throw new TestDesignError('TEST_DESIGN_CANDIDATE_SCHEMA_INVALID', `${path} ${message}`, 422, { path }) }
function fail(code: string, message: string, status = 400, details?: unknown): never { throw new TestDesignError(code, message, status, details) }
