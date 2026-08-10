import type { CreateTestDesignInput, ExecutionMethodSpec, ExecutionReadiness, TestCaseContent, TestDataRequirement, TestDimension, TestPointNodeContent, TestPointNodeRevision } from '../domain/test-design-types.js'
import { canonicalSha256 } from './canonical-json.js'

export class TestDesignError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400, public readonly details?: unknown) {
    super(`${code}: ${message}`)
    this.name = 'TestDesignError'
  }
}

export function validateCreateTestDesignInput(value: unknown): CreateTestDesignInput {
  const input = object(value, 'TEST_DESIGN_BASIS_MODE_INVALID', '创建参数必须是对象')
  const basisMode = input.basisMode
  if (basisMode !== 'review_baseline' && basisMode !== 'knowledge_assets') fail('TEST_DESIGN_BASIS_MODE_INVALID', 'basisMode 必须为 review_baseline 或 knowledge_assets')
  const common = ['name', 'objective', 'basisMode', 'includedScopes', 'excludedScopes', 'focusDimensions', 'userCoverageObjectives', 'knowledgeAugmentation', 'historicalCaseSelections']
  const branch = basisMode === 'review_baseline' ? ['sourceReviewRunId', 'sourceTechnicalSolutionRunId'] : ['knowledgeAssetVersionIds']
  rejectUnknown(input, [...common, ...branch], 'TEST_DESIGN_BASIS_MODE_INVALID')
  const normalized = {
    name: requiredText(input.name, 'name', 200),
    objective: requiredText(input.objective, 'objective', 4_000),
    basisMode,
    includedScopes: optionalScopeRules(input.includedScopes),
    excludedScopes: optionalScopeRules(input.excludedScopes),
    focusDimensions: optionalDimensions(input.focusDimensions),
    userCoverageObjectives: optionalTexts(input.userCoverageObjectives, 'userCoverageObjectives', 100, 2_000),
    knowledgeAugmentation: validateAugmentation(input.knowledgeAugmentation),
    historicalCaseSelections: validateHistoricalSelections(input.historicalCaseSelections),
  }
  if (basisMode === 'review_baseline') return { ...normalized, basisMode, sourceReviewRunId: id(input.sourceReviewRunId, 'sourceReviewRunId'), sourceTechnicalSolutionRunId: id(input.sourceTechnicalSolutionRunId, 'sourceTechnicalSolutionRunId') }
  const knowledgeAssetVersionIds = uniqueIds(input.knowledgeAssetVersionIds, 'knowledgeAssetVersionIds')
  if (!knowledgeAssetVersionIds.length) fail('TEST_DESIGN_BASIS_MODE_INVALID', 'knowledge_assets 模式至少选择一个资产版本')
  return { ...normalized, basisMode, knowledgeAssetVersionIds }
}

export function validateTestCaseContent(value: unknown, validPointIds?: Set<string>): TestCaseContent {
  const input = object(value, 'TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', '用例必须是对象')
  rejectUnknown(input, ['schemaVersion', 'title', 'objective', 'dimension', 'testPointIds', 'priority', 'preconditions', 'dataRequirementIds', 'cleanup', 'dependencies', 'executionMethods', 'sharedVerificationChecks', 'tags', 'domain'], 'TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID')
  if (input.schemaVersion !== 'test-case/v1') fail('TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', 'schemaVersion 必须为 test-case/v1', 422)
  const testPointIds = uniqueIds(input.testPointIds, 'testPointIds')
  if (!testPointIds.length) fail('TEST_CASE_BASIS_REFERENCE_INVALID', '用例至少引用一个批准测试点', 422)
  if (validPointIds && testPointIds.some(pointId => !validPointIds.has(pointId))) fail('TEST_CASE_BASIS_REFERENCE_INVALID', '用例引用了批准树之外的测试点', 422)
  const methods = executionMethods(input.executionMethods)
  const dependencies = uniqueIds(input.dependencies ?? [], 'dependencies')
  return {
    schemaVersion: 'test-case/v1',
    title: requiredText(input.title, 'title', 500),
    objective: requiredText(input.objective, 'objective', 4_000),
    dimension: dimension(input.dimension),
    testPointIds,
    priority: priority(input.priority),
    preconditions: texts(input.preconditions, 'preconditions', 100, 2_000),
    dataRequirementIds: uniqueIds(input.dataRequirementIds ?? [], 'dataRequirementIds'),
    cleanup: texts(input.cleanup, 'cleanup', 100, 2_000),
    dependencies,
    executionMethods: methods,
    sharedVerificationChecks: checks(input.sharedVerificationChecks, 'sharedVerificationChecks'),
    tags: texts(input.tags, 'tags', 100, 100),
    domain: requiredText(input.domain, 'domain', 200),
  }
}

export function validateTreeNodes(nodes: TestPointNodeRevision[]) {
  const active = nodes.filter(node => !node.deleted)
  const ids = new Set(active.map(node => node.nodeId))
  if (ids.size !== active.length) fail('TEST_POINT_TREE_CYCLE', '测试点 ID 重复', 422)
  const siblingKeys = new Set<string>()
  for (const node of active) {
    if (node.parentId && !ids.has(node.parentId)) fail('TEST_POINT_TREE_CYCLE', `测试点 ${node.nodeId} 的父节点不存在`, 422)
    const siblingKey = `${node.parentId ?? '<root>'}\u0000${node.sortKey}`
    if (siblingKeys.has(siblingKey)) fail('TEST_POINT_TREE_CYCLE', '同级 sortKey 必须唯一', 422)
    siblingKeys.add(siblingKey)
    let current: TestPointNodeRevision | undefined = node
    const visited = new Set<string>()
    while (current?.parentId) {
      if (visited.has(current.parentId) || current.parentId === node.nodeId) fail('TEST_POINT_TREE_CYCLE', '测试点树不能形成父子循环', 422)
      visited.add(current.parentId)
      current = active.find(candidate => candidate.nodeId === current!.parentId)
    }
  }
  return canonicalSha256(active.map(node => ({ ...node })).sort((left, right) => left.sortKey.localeCompare(right.sortKey) || left.nodeId.localeCompare(right.nodeId)))
}

export type DesignCandidateNode = TestPointNodeContent & { ref: string; parentRef?: string }

export type TestDataRequirementCandidate = Omit<TestDataRequirement, 'id' | 'caseIds' | 'testPointIds'> & {
  ref: string
  caseIndexes: number[]
  testPointIds: string[]
}

export interface TestCaseSynthesisCandidate extends Record<string, unknown> {
  schemaVersion: 'test-case-synthesis/v1'
  cases: TestCaseContent[]
  dataRequirements: TestDataRequirementCandidate[]
}

export function validateTestAnalysisCandidate(value: unknown): Record<string, unknown> {
  const input = analysisObject(value, '/', '提交结果必须是对象')
  analysisRejectUnknown(input, ['schemaVersion', 'scope', 'coverageUnits', 'findings', 'confirmationItems'], '/')
  if (input.schemaVersion !== 'test-analysis/v1') analysisFail('/schemaVersion', 'schemaVersion 必须为 test-analysis/v1')

  const scope = analysisObject(input.scope, '/scope', 'scope 必须是对象')
  analysisRejectUnknown(scope, ['summary', 'objectives', 'inclusions', 'exclusions'], '/scope')
  analysisText(scope.summary, '/scope/summary', 4_000)
  analysisTexts(scope.objectives, '/scope/objectives', 100, 2_000)
  analysisTexts(scope.inclusions, '/scope/inclusions', 200, 2_000)
  analysisTexts(scope.exclusions, '/scope/exclusions', 200, 2_000)

  if (!Array.isArray(input.coverageUnits) || !input.coverageUnits.length || input.coverageUnits.length > 1_000) analysisFail('/coverageUnits', 'coverageUnits 必须包含 1 到 1000 个原子覆盖单元')
  const refs = new Set<string>()
  const semanticArrays = ['roles', 'preconditions', 'actions', 'rules', 'constraints', 'inputPartitions', 'boundaryValues', 'stateTransitions', 'interfaces', 'dataSideEffects', 'oracles', 'positivePaths', 'negativePaths', 'risks', 'assumptions']
  input.coverageUnits.forEach((candidate, index) => {
    const path = `/coverageUnits/${index}`
    const unit = analysisObject(candidate, path, '覆盖单元必须是对象')
    analysisRejectUnknown(unit, ['ref', 'title', 'description', 'basisRefs', 'entryMethods', ...semanticArrays], path)
    const ref = analysisText(unit.ref, `${path}/ref`, 200)
    if (refs.has(ref)) analysisFail(`${path}/ref`, `临时引用 ${ref} 重复`)
    refs.add(ref)
    analysisText(unit.title, `${path}/title`, 500)
    analysisText(unit.description, `${path}/description`, 4_000)
    if (!analysisTexts(unit.basisRefs, `${path}/basisRefs`, 1_000, 500).length) analysisFail(`${path}/basisRefs`, '至少引用一个固定依据')
    analysisEnumTexts(unit.entryMethods, `${path}/entryMethods`, ['ui', 'api'] as const, 2)
    semanticArrays.forEach(field => analysisTexts(unit[field], `${path}/${field}`, 200, 2_000))
  })

  if (!Array.isArray(input.findings) || input.findings.length > 500) analysisFail('/findings', 'findings 必须是最多 500 项的数组')
  input.findings.forEach((candidate, index) => {
    const path = `/findings/${index}`
    const finding = analysisObject(candidate, path, 'Finding 必须是对象')
    analysisRejectUnknown(finding, ['title', 'description', 'severity', 'basisRefs'], path)
    analysisText(finding.title, `${path}/title`, 500)
    analysisText(finding.description, `${path}/description`, 8_000)
    if (!['blocker', 'high', 'medium', 'low'].includes(String(finding.severity))) analysisFail(`${path}/severity`, '必须为 blocker、high、medium 或 low')
    analysisTexts(finding.basisRefs, `${path}/basisRefs`, 1_000, 500)
  })

  if (!Array.isArray(input.confirmationItems) || input.confirmationItems.length > 500) analysisFail('/confirmationItems', 'confirmationItems 必须是最多 500 项的数组')
  input.confirmationItems.forEach((candidate, index) => {
    const path = `/confirmationItems/${index}`
    const item = analysisObject(candidate, path, '待确认项必须是对象')
    analysisRejectUnknown(item, ['title', 'question', 'decisionType', 'impactStage', 'affectedRefs', 'blocker'], path)
    analysisText(item.title, `${path}/title`, 500)
    analysisText(item.question, `${path}/question`, 8_000)
    analysisText(item.decisionType, `${path}/decisionType`, 200)
    if (!['analysis', 'tree', 'case', 'data', 'publication'].includes(String(item.impactStage))) analysisFail(`${path}/impactStage`, '取值无效')
    analysisTexts(item.affectedRefs, `${path}/affectedRefs`, 1_000, 500)
    if (typeof item.blocker !== 'boolean') analysisFail(`${path}/blocker`, '必须是布尔值')
  })
  return structuredClone(input)
}

const synthesisCaseFields = ['schemaVersion', 'title', 'objective', 'dimension', 'testPointIds', 'priority', 'preconditions', 'dataRequirementIds', 'cleanup', 'dependencies', 'executionMethods', 'sharedVerificationChecks', 'tags', 'domain']
const legacySynthesisFieldGuidance: Record<string, string> = {
  preConditions: '改为 preconditions',
  steps: '移入 executionMethods[].steps，并使用 action/expected',
  expectedResults: '拆入 executionMethods[].steps[].expected 或 verificationChecks',
  entryPoints: 'UI 入口写入 uiSpec.entry，API 入口写入 apiSpec.path',
  dataRequirements: '移到提交根对象 dataRequirements[]',
  testData: '移到提交根对象 dataRequirements[]',
}

export function validateTestCaseSynthesisCandidate(value: unknown, validPointIds?: Set<string>): TestCaseSynthesisCandidate {
  const input = synthesisObject(value, '/', '提交结果必须是对象')
  synthesisRejectUnknown(input, ['schemaVersion', 'cases', 'dataRequirements'], '/')
  if (input.schemaVersion !== 'test-case-synthesis/v1') synthesisFail('/schemaVersion', 'schemaVersion 必须为 test-case-synthesis/v1')
  if (!Array.isArray(input.cases) || !input.cases.length || input.cases.length > 1_000) synthesisFail('/cases', 'cases 必须包含 1 到 1000 条用例')
  if (!Array.isArray(input.dataRequirements) || input.dataRequirements.length > 1_000) synthesisFail('/dataRequirements', 'dataRequirements 必须是最多 1000 项的数组')

  const cases = input.cases.map((candidate, index) => {
    const path = `/cases/${index}`
    const caseInput = synthesisObject(candidate, path, `cases[${index}] 必须是对象`)
    const unexpected = Object.keys(caseInput).filter(key => !synthesisCaseFields.includes(key))
    if (unexpected.length) {
      const guidance = unexpected.map(key => legacySynthesisFieldGuidance[key]).filter(Boolean)
      synthesisFail(path, `包含不允许的字段：${unexpected.join('、')}${guidance.length ? `；字段映射：${guidance.join('；')}` : ''}`)
    }
    try {
      const normalized = validateTestCaseContent(caseInput, validPointIds)
      if (normalized.dataRequirementIds.length) synthesisFail(`${path}/dataRequirementIds`, '综合候选中的 dataRequirementIds 必须为空；服务端根据 dataRequirements[].caseIndexes 生成正式关联')
      return normalized
    } catch (error) {
      if (error instanceof TestDesignError && error.details && typeof error.details === 'object' && 'path' in error.details) throw error
      synthesisFail(path, errorMessage(error))
    }
  })
  if (validPointIds) {
    const coveredPointIds = new Set(cases.flatMap(testCase => testCase.testPointIds))
    const missingPointIds = [...validPointIds].filter(pointId => !coveredPointIds.has(pointId))
    if (missingPointIds.length) {
      const preview = missingPointIds.slice(0, 20).join('、')
      synthesisFail('/cases', `缺少 ${missingPointIds.length} 个已批准适用测试点的用例映射：${preview}${missingPointIds.length > 20 ? ' 等' : ''}`)
    }
  }

  const refs = new Set<string>()
  const dataRequirements = input.dataRequirements.map((candidate, index): TestDataRequirementCandidate => {
    const path = `/dataRequirements/${index}`
    const item = synthesisObject(candidate, path, `dataRequirements[${index}] 必须是对象`)
    synthesisRejectUnknown(item, ['ref', 'name', 'entityType', 'featureTags', 'testPointIds', 'caseIndexes', 'fieldConstraints', 'relationships', 'quantity', 'initialState', 'preparationHint', 'sensitivity', 'isolation', 'resetAndCleanup', 'readiness', 'readinessReason'], path)
    const ref = synthesisText(item.ref, `${path}/ref`, 200)
    if (refs.has(ref)) synthesisFail(`${path}/ref`, `临时引用 ${ref} 重复`)
    refs.add(ref)
    const testPointIds = synthesisIds(item.testPointIds, `${path}/testPointIds`)
    if (testPointIds.some(pointId => validPointIds && !validPointIds.has(pointId))) synthesisFail(`${path}/testPointIds`, '包含批准测试点树之外的引用')
    const caseIndexes = synthesisIndexes(item.caseIndexes, `${path}/caseIndexes`, cases.length)
    const fieldConstraints = synthesisStringRecord(item.fieldConstraints, `${path}/fieldConstraints`)
    const sensitivity = synthesisEnum(item.sensitivity, `${path}/sensitivity`, ['public', 'internal', 'sensitive'] as const)
    const readinessValue = synthesisEnum(item.readiness, `${path}/readiness`, ['ready', 'blocked', 'needs_confirmation'] as const)
    const readinessReason = item.readinessReason === undefined ? undefined : synthesisText(item.readinessReason, `${path}/readinessReason`, 2_000)
    if (readinessValue !== 'ready' && !readinessReason) synthesisFail(`${path}/readinessReason`, 'readiness 非 ready 时必须说明原因')
    return {
      ref,
      name: synthesisText(item.name, `${path}/name`, 500),
      entityType: synthesisText(item.entityType, `${path}/entityType`, 200),
      featureTags: synthesisTexts(item.featureTags, `${path}/featureTags`, 100, 100),
      testPointIds,
      caseIndexes,
      fieldConstraints,
      relationships: synthesisTexts(item.relationships, `${path}/relationships`, 100, 1_000),
      quantity: synthesisPositiveInteger(item.quantity, `${path}/quantity`),
      initialState: synthesisText(item.initialState, `${path}/initialState`, 2_000),
      preparationHint: synthesisText(item.preparationHint, `${path}/preparationHint`, 4_000),
      sensitivity,
      isolation: synthesisText(item.isolation, `${path}/isolation`, 2_000),
      resetAndCleanup: synthesisText(item.resetAndCleanup, `${path}/resetAndCleanup`, 2_000),
      readiness: readinessValue,
      ...(readinessReason ? { readinessReason } : {}),
    }
  })
  return { schemaVersion: 'test-case-synthesis/v1', cases, dataRequirements }
}

export function validateDesignCandidateNodes(raw: unknown, kind: 'functional' | 'non_functional'): DesignCandidateNode[] {
  const label = kind === 'functional' ? 'functional' : 'non_functional'
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { nodes?: unknown }).nodes)) candidateFail(label, '结果缺少 nodes')
  const values = (raw as { nodes: unknown[] }).nodes
  if (!values.length || values.length > 1_000) candidateFail(`${label}.nodes`, '必须包含 1 到 1000 个节点')
  const dimensions: TestDimension[] = kind === 'functional' ? ['functional'] : ['performance', 'stability', 'compatibility', 'security']
  const refs = new Set<string>()
  const nodes = values.map((value, index): DesignCandidateNode => {
    const path = `${label}.nodes[${index}]`
    if (!value || typeof value !== 'object' || Array.isArray(value)) candidateFail(path, '必须是对象')
    const input = value as Record<string, unknown>
    const ref = candidateText(input.ref, `${path}.ref`, 200)
    if (refs.has(ref)) candidateFail(`${path}.ref`, '在本次提交内重复')
    refs.add(ref)
    const parentRef = input.parentRef == null || input.parentRef === '' ? undefined : candidateText(input.parentRef, `${path}.parentRef`, 200)
    const dimension = String(input.dimension) as TestDimension
    if (!dimensions.includes(dimension)) candidateFail(`${path}.dimension`, `必须为 ${dimensions.join('、')}`)
    const priority = String(input.priority)
    if (!['P0', 'P1', 'P2', 'P3'].includes(priority)) candidateFail(`${path}.priority`, '必须为 P0、P1、P2 或 P3')
    const applicability = String(input.applicability)
    if (!['applicable', 'not_applicable', 'blocked_by_confirmation'].includes(applicability)) candidateFail(`${path}.applicability`, '取值无效')
    const entryMethods = candidateEnumArray(input.entryMethods, `${path}.entryMethods`, ['ui', 'api'] as const, 2)
    return {
      ref,
      ...(parentRef ? { parentRef } : {}),
      title: candidateText(input.title, `${path}.title`, 500),
      objective: candidateText(input.objective, `${path}.objective`, 2_000),
      dimension,
      priority: priority as DesignCandidateNode['priority'],
      applicability: applicability as DesignCandidateNode['applicability'],
      designTechniques: candidateTextArray(input.designTechniques, `${path}.designTechniques`, 50, 200),
      entryMethods,
      oracle: candidateText(input.oracle, `${path}.oracle`, 4_000),
      dataConditions: candidateTextArray(input.dataConditions, `${path}.dataConditions`, 100, 1_000),
      risks: candidateTextArray(input.risks, `${path}.risks`, 100, 1_000),
      assumptions: candidateTextArray(input.assumptions, `${path}.assumptions`, 100, 1_000),
      basisRefs: candidateTextArray(input.basisRefs, `${path}.basisRefs`, 1_000, 500),
      historicalRefs: candidateTextArray(input.historicalRefs, `${path}.historicalRefs`, 1_000, 500),
    }
  })
  for (const [index, node] of nodes.entries()) {
    if (node.parentRef && !refs.has(node.parentRef)) candidateFail(`${label}.nodes[${index}].parentRef`, '未引用本次提交内的节点')
  }
  if (kind === 'non_functional') {
    const requiredDimensions: TestDimension[] = ['performance', 'stability', 'compatibility', 'security']
    const dimensions = new Set(nodes.map(node => node.dimension))
    const missing = requiredDimensions.filter(dimension => !dimensions.has(dimension))
    if (missing.length) candidateFail('non_functional.nodes', `必须在一次完整提交中覆盖性能、稳定性、兼容性和安全四个维度，缺少：${missing.join('、')}`)
  }
  return nodes
}

export function validateCaseDependencyGraph(cases: Array<{ id: string; content: TestCaseContent }>) {
  const byId = new Map(cases.map(item => [item.id, item]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (caseId: string) => {
    if (visiting.has(caseId)) fail('TEST_CASE_DEPENDENCY_CYCLE', '用例依赖形成循环', 422)
    if (visited.has(caseId)) return
    visiting.add(caseId)
    for (const dependencyId of byId.get(caseId)?.content.dependencies ?? []) {
      if (!byId.has(dependencyId)) fail('TEST_CASE_DEPENDENCY_INVALID', `依赖用例 ${dependencyId} 不存在`, 422)
      visit(dependencyId)
    }
    visiting.delete(caseId)
    visited.add(caseId)
  }
  byId.forEach((_value, caseId) => visit(caseId))
}

export function etag(kind: 'tree' | 'case', id: string, revision: number, hash: string) { return `\"${kind}:${id}:r${revision}:${hash}\"` }

export function assertEtag(actual: string | undefined, expected: string, code: string) {
  if (!actual || actual !== expected) fail(code, 'If-Match 与当前 revision 不一致', 412, { currentEtag: expected })
}

function validateAugmentation(value: unknown) {
  const input = object(value, 'TEST_DESIGN_AUGMENTATION_INVALID', 'knowledgeAugmentation 必须是对象')
  if (input.mode === 'disabled') { rejectUnknown(input, ['mode'], 'TEST_DESIGN_AUGMENTATION_INVALID'); return { mode: 'disabled' as const } }
  if (input.mode === 'selected_assets') { rejectUnknown(input, ['mode', 'assetVersionIds'], 'TEST_DESIGN_AUGMENTATION_INVALID'); const assetVersionIds = uniqueIds(input.assetVersionIds, 'assetVersionIds'); if (!assetVersionIds.length) fail('TEST_DESIGN_AUGMENTATION_INVALID', 'selected_assets 至少选择一个资产版本'); return { mode: 'selected_assets' as const, assetVersionIds } }
  if (input.mode === 'fixed_index') { rejectUnknown(input, ['mode', 'indexVersionId', 'filters'], 'TEST_DESIGN_AUGMENTATION_INVALID'); return { mode: 'fixed_index' as const, indexVersionId: id(input.indexVersionId, 'indexVersionId'), ...(input.filters === undefined ? {} : { filters: stringFilters(input.filters) }) } }
  fail('TEST_DESIGN_AUGMENTATION_INVALID', 'knowledgeAugmentation.mode 无效')
}

function validateHistoricalSelections(value: unknown) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100) fail('TEST_DESIGN_HISTORICAL_SOURCE_INVALID', 'historicalCaseSelections 必须是数组')
  return value.map((candidate, index) => {
    const input = object(candidate, 'TEST_DESIGN_HISTORICAL_SOURCE_INVALID', `historicalCaseSelections[${index}] 必须是对象`)
    if (input.sourceType === 'test_case_set') { rejectUnknown(input, ['sourceType', 'testCaseSetVersionId', 'caseIds'], 'TEST_DESIGN_HISTORICAL_SOURCE_INVALID'); const caseIds = uniqueIds(input.caseIds, 'caseIds'); if (!caseIds.length) fail('TEST_DESIGN_HISTORICAL_SOURCE_INVALID', '结构化历史来源至少选择一个用例'); return { sourceType: 'test_case_set' as const, testCaseSetVersionId: id(input.testCaseSetVersionId, 'testCaseSetVersionId'), caseIds } }
    if (input.sourceType === 'asset_version') { rejectUnknown(input, ['sourceType', 'assetVersionId'], 'TEST_DESIGN_HISTORICAL_SOURCE_INVALID'); return { sourceType: 'asset_version' as const, assetVersionId: id(input.assetVersionId, 'assetVersionId') } }
    fail('TEST_DESIGN_HISTORICAL_SOURCE_INVALID', '历史来源类型无效')
  })
}

function executionMethods(value: unknown): ExecutionMethodSpec[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) fail('TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', 'executionMethods 必须包含一到两种方式', 422)
  const seen = new Set<string>()
  return value.map((candidate, index) => {
    const input = object(candidate, 'TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', `executionMethods[${index}] 必须是对象`)
    if (input.method !== 'ui' && input.method !== 'api') fail('TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', '执行方式只允许 ui 或 api', 422)
    if (seen.has(input.method)) fail('TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', '执行方式不能重复', 422)
    seen.add(input.method)
    const common = { steps: steps(input.steps, index), verificationChecks: checks(input.verificationChecks, `executionMethods[${index}].verificationChecks`), executionReadiness: readiness(input.executionReadiness), automationHint: text(input.automationHint, `executionMethods[${index}].automationHint`, 2_000) }
    if (input.method === 'ui') {
      rejectUnknown(input, ['method', 'uiSpec', 'steps', 'verificationChecks', 'executionReadiness', 'automationHint'], 'TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID')
      const spec = object(input.uiSpec, 'TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', 'uiSpec 必填')
      rejectUnknown(spec, ['entry', 'viewport', 'selectors'], 'TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID')
      return { method: 'ui' as const, uiSpec: { entry: requiredText(spec.entry, 'uiSpec.entry', 2_000), ...(spec.viewport === undefined ? {} : { viewport: text(spec.viewport, 'uiSpec.viewport', 100) }), ...(spec.selectors === undefined ? {} : { selectors: texts(spec.selectors, 'uiSpec.selectors', 100, 500) }) }, ...common }
    }
    rejectUnknown(input, ['method', 'apiSpec', 'steps', 'verificationChecks', 'executionReadiness', 'automationHint'], 'TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID')
    const spec = object(input.apiSpec, 'TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', 'apiSpec 必填')
    rejectUnknown(spec, ['method', 'path', 'requestSchemaRef', 'responseSchemaRef'], 'TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID')
    return { method: 'api' as const, apiSpec: { method: requiredText(spec.method, 'apiSpec.method', 20).toUpperCase(), path: requiredText(spec.path, 'apiSpec.path', 2_000), ...(spec.requestSchemaRef === undefined ? {} : { requestSchemaRef: text(spec.requestSchemaRef, 'requestSchemaRef', 500) }), ...(spec.responseSchemaRef === undefined ? {} : { responseSchemaRef: text(spec.responseSchemaRef, 'responseSchemaRef', 500) }) }, ...common }
  })
}

function steps(value: unknown, methodIndex: number) {
  if (!Array.isArray(value) || !value.length || value.length > 200) fail('TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', `executionMethods[${methodIndex}].steps 不能为空`, 422)
  const keys = new Set<string>()
  return value.map((candidate, index) => { const input = object(candidate, 'TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', 'step 必须是对象'); rejectUnknown(input, ['key', 'action', 'expected'], 'TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID'); const key = id(input.key, `steps[${index}].key`); if (keys.has(key)) fail('TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', '步骤 key 不能重复', 422); keys.add(key); return { key, action: requiredText(input.action, 'step.action', 4_000), expected: requiredText(input.expected, 'step.expected', 4_000) } })
}

function checks(value: unknown, field: string) { if (!Array.isArray(value) || value.length > 200) fail('TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', `${field} 必须是数组`, 422); return value.map((candidate, index) => { const input = object(candidate, 'TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', '检查点必须是对象'); rejectUnknown(input, ['key', 'description'], 'TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID'); return { key: id(input.key, `${field}[${index}].key`), description: requiredText(input.description, `${field}[${index}].description`, 4_000) } }) }
function readiness(value: unknown): ExecutionReadiness { if (value !== 'ready' && value !== 'blocked' && value !== 'needs_confirmation') fail('TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', 'executionReadiness 无效', 422); return value }
function dimension(value: unknown) { if (!['functional', 'performance', 'stability', 'compatibility', 'security'].includes(String(value))) fail('TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', 'dimension 无效', 422); return value as TestCaseContent['dimension'] }
function priority(value: unknown) { if (!['P0', 'P1', 'P2', 'P3'].includes(String(value))) fail('TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', 'priority 无效', 422); return value as TestCaseContent['priority'] }
function optionalDimensions(value: unknown) { if (value === undefined) return []; if (!Array.isArray(value)) fail('TEST_DESIGN_BASIS_MODE_INVALID', 'focusDimensions 必须是数组'); return [...new Set(value.map(dimension))] }
function optionalScopeRules(value: unknown) { if (value === undefined) return []; if (!Array.isArray(value) || value.length > 100) fail('TEST_DESIGN_BASIS_MODE_INVALID', '范围规则必须是数组'); return value.map(candidate => { const input = object(candidate, 'TEST_DESIGN_BASIS_MODE_INVALID', '范围规则必须是对象'); rejectUnknown(input, ['kind', 'value'], 'TEST_DESIGN_BASIS_MODE_INVALID'); return { kind: requiredText(input.kind, 'scope.kind', 100), value: requiredText(input.value, 'scope.value', 1_000) } }) }
function optionalTexts(value: unknown, field: string, max: number, length: number) { return value === undefined ? [] : texts(value, field, max, length) }
function texts(value: unknown, field: string, max: number, length: number) { if (!Array.isArray(value) || value.length > max) fail('TEST_DESIGN_BASIS_MODE_INVALID', `${field} 必须是数组`); return value.map((item, index) => requiredText(item, `${field}[${index}]`, length)) }
function uniqueIds(value: unknown, field: string) { if (!Array.isArray(value) || value.length > 1_000) fail('TEST_DESIGN_BASIS_MODE_INVALID', `${field} 必须是数组`); return [...new Set(value.map((item, index) => id(item, `${field}[${index}]`)))] }
function stringFilters(value: unknown) { const input = object(value, 'TEST_DESIGN_AUGMENTATION_INVALID', 'filters 必须是对象'); return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, Array.isArray(item) ? item.map(valueItem => text(valueItem, `filters.${key}`, 500)) : text(item, `filters.${key}`, 500)])) }
function id(value: unknown, field: string) { const result = requiredText(value, field, 500); if (/^(latest|active)$/iu.test(result)) fail('TEST_DESIGN_LATEST_REFERENCE_FORBIDDEN', `${field} 不允许动态引用`); return result }
function requiredText(value: unknown, field: string, max: number) { const result = text(value, field, max).trim(); if (!result) fail('TEST_DESIGN_BASIS_MODE_INVALID', `${field} 不能为空`); return result }
function text(value: unknown, field: string, max: number) { if (typeof value !== 'string' || value.length > max) fail('TEST_DESIGN_BASIS_MODE_INVALID', `${field} 必须是长度不超过 ${max} 的字符串`); return value }
function candidateText(value: unknown, path: string, max: number) { if (typeof value !== 'string' || !value.trim() || value.length > max) candidateFail(path, `必须是长度不超过 ${max} 的非空字符串`); return value.trim() }
function candidateTextArray(value: unknown, path: string, maxItems: number, maxLength: number) { if (!Array.isArray(value) || value.length > maxItems) candidateFail(path, `必须是最多 ${maxItems} 项的数组`); return value.map((item, index) => candidateText(item, `${path}[${index}]`, maxLength)) }
function candidateEnumArray<const T extends string>(value: unknown, path: string, allowed: readonly T[], maxItems: number): T[] { if (!Array.isArray(value) || value.length > maxItems) candidateFail(path, `必须是最多 ${maxItems} 项的数组`); return value.map((item, index) => { if (typeof item !== 'string' || !allowed.includes(item as T)) candidateFail(`${path}[${index}]`, `必须为 ${allowed.join('、')}`); return item as T }) }
function candidateFail(path: string, message: string): never { throw new TestDesignError('TEST_POINT_TREE_SCHEMA_INVALID', `${path} ${message}`, 422, { path }) }
function analysisObject(value: unknown, path: string, message: string) { if (!value || typeof value !== 'object' || Array.isArray(value)) analysisFail(path, message); return value as Record<string, unknown> }
function analysisRejectUnknown(value: Record<string, unknown>, allowed: string[], path: string) { const unexpected = Object.keys(value).filter(key => !allowed.includes(key)); if (unexpected.length) analysisFail(path, `包含不允许的字段：${unexpected.join('、')}`) }
function analysisText(value: unknown, path: string, max: number) { if (typeof value !== 'string' || !value.trim() || value.length > max) analysisFail(path, `必须是长度不超过 ${max} 的非空字符串`); return value.trim() }
function analysisTexts(value: unknown, path: string, maxItems: number, maxLength: number) { if (!Array.isArray(value) || value.length > maxItems) analysisFail(path, `必须是最多 ${maxItems} 项的数组`); return value.map((item, index) => analysisText(item, `${path}/${index}`, maxLength)) }
function analysisEnumTexts<const T extends string>(value: unknown, path: string, allowed: readonly T[], maxItems: number) { if (!Array.isArray(value) || value.length > maxItems) analysisFail(path, `必须是最多 ${maxItems} 项的数组`); return value.map((item, index) => { if (typeof item !== 'string' || !allowed.includes(item as T)) analysisFail(`${path}/${index}`, `必须为 ${allowed.join('、')}`); return item as T }) }
function analysisFail(path: string, message: string): never { throw new TestDesignError('TEST_ANALYSIS_SCHEMA_INVALID', `${path} ${message}`, 422, { path }) }
function synthesisObject(value: unknown, path: string, message: string) { if (!value || typeof value !== 'object' || Array.isArray(value)) synthesisFail(path, message); return value as Record<string, unknown> }
function synthesisRejectUnknown(value: Record<string, unknown>, allowed: string[], path: string) { const unexpected = Object.keys(value).filter(key => !allowed.includes(key)); if (unexpected.length) synthesisFail(path, `包含不允许的字段：${unexpected.join('、')}`) }
function synthesisText(value: unknown, path: string, max: number) { if (typeof value !== 'string' || !value.trim() || value.length > max) synthesisFail(path, `必须是长度不超过 ${max} 的非空字符串`); return value.trim() }
function synthesisTexts(value: unknown, path: string, maxItems: number, maxLength: number) { if (!Array.isArray(value) || value.length > maxItems) synthesisFail(path, `必须是最多 ${maxItems} 项的数组`); return value.map((item, index) => synthesisText(item, `${path}/${index}`, maxLength)) }
function synthesisIds(value: unknown, path: string) { return [...new Set(synthesisTexts(value, path, 1_000, 500).map(item => { if (/^(latest|active)$/iu.test(item)) synthesisFail(path, '不允许动态引用 latest 或 active'); return item }))] }
function synthesisIndexes(value: unknown, path: string, caseCount: number) { if (!Array.isArray(value) || !value.length || value.length > caseCount) synthesisFail(path, '必须是引用至少一条候选用例的索引数组'); const indexes = value.map((item, index) => { if (!Number.isInteger(item) || Number(item) < 0 || Number(item) >= caseCount) synthesisFail(`${path}/${index}`, `必须是 0 到 ${caseCount - 1} 的整数`); return Number(item) }); if (new Set(indexes).size !== indexes.length) synthesisFail(path, '不能包含重复索引'); return indexes }
function synthesisStringRecord(value: unknown, path: string) {
  const input = synthesisObject(value, path, '必须是对象')
  return Object.fromEntries(Object.entries(input).map(([key, item]) => {
    if (typeof item === 'string') return [key, synthesisText(item, `${path}/${key}`, 2_000)]
    if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return [key, String(item)]
    synthesisFail(`${path}/${key}`, '必须是非空字符串、布尔值或有限数值')
  }))
}
function synthesisPositiveInteger(value: unknown, path: string) { if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 1_000_000) synthesisFail(path, '必须是 1 到 1000000 的整数'); return Number(value) }
function synthesisEnum<const T extends string>(value: unknown, path: string, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) synthesisFail(path, `必须为 ${allowed.join('、')}`); return value as T }
function synthesisFail(path: string, message: string): never { throw new TestDesignError('TEST_CASE_SYNTHESIS_SCHEMA_INVALID', `${path} ${message}`, 422, { path }) }
function errorMessage(error: unknown) { return error instanceof TestDesignError ? error.message.replace(/^[A-Z0-9_]+:\s*/u, '') : error instanceof Error ? error.message : String(error) }
function object(value: unknown, code: string, message: string) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, message); return value as Record<string, unknown> }
function rejectUnknown(value: Record<string, unknown>, allowed: string[], code: string) { const unexpected = Object.keys(value).filter(key => !allowed.includes(key)); if (unexpected.length) fail(code, `包含不允许的字段：${unexpected.join('、')}`) }
function fail(code: string, message: string, status = 400, details?: unknown): never { throw new TestDesignError(code, message, status, details) }
