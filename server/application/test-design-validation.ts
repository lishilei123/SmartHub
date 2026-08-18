import type { CreateTestDesignInput, ExecutionMethodSpec, ExecutionReadiness, HistoricalLibrarySelection, TestCaseContent, TestCaseExecutionSpec, TestDataRequirement, TestDimension, TestPointNodeContent, TestPointNodeRevision } from '../domain/test-design-types.js'
import { canonicalSha256 } from './canonical-json.js'

export class TestDesignError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400, public readonly details?: unknown) {
    super(`${code}: ${message}`)
    this.name = 'TestDesignError'
  }
}

export function validateCreateTestDesignInput(value: unknown): CreateTestDesignInput {
  const input = object(value, 'TEST_DESIGN_INPUT_INVALID', '创建参数必须是对象')
  rejectUnknown(input, ['name', 'objective', 'requirementReleaseId', 'includedScopes', 'excludedScopes', 'focusDimensions', 'executionMethods', 'userCoverageObjectives', 'knowledgeAugmentation', 'historicalCaseSelections', 'historicalLibrarySelection'], 'TEST_DESIGN_INPUT_INVALID')
  return {
    name: requiredText(input.name, 'name', 200),
    objective: requiredText(input.objective, 'objective', 4_000),
    ...(input.requirementReleaseId === undefined ? {} : { requirementReleaseId: requiredText(input.requirementReleaseId, 'requirementReleaseId', 200) }),
    includedScopes: optionalScopeRules(input.includedScopes),
    excludedScopes: optionalScopeRules(input.excludedScopes),
    focusDimensions: optionalDimensions(input.focusDimensions),
    executionMethods: optionalExecutionMethods(input.executionMethods),
    userCoverageObjectives: optionalTexts(input.userCoverageObjectives, 'userCoverageObjectives', 100, 2_000),
    knowledgeAugmentation: validateAugmentation(input.knowledgeAugmentation ?? { mode: 'disabled' }),
    historicalCaseSelections: validateHistoricalSelections(input.historicalCaseSelections),
    historicalLibrarySelection: validateHistoricalLibrarySelection(input.historicalLibrarySelection),
  }
}

function optionalExecutionMethods(value: unknown): Array<'ui' | 'api'> {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => item !== 'ui' && item !== 'api')) fail('TEST_DESIGN_INPUT_INVALID', 'executionMethods 只能包含 ui、api', 422)
  return [...new Set(value)] as Array<'ui' | 'api'>
}

export function validateTestCaseContent(value: unknown, validPointIds?: Set<string>): TestCaseContent {
  const input = object(value, 'TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', '用例必须是对象')
  rejectUnknown(input, ['schemaVersion', 'title', 'objective', 'dimension', 'testPointIds', 'priority', 'preconditions', 'dataRequirementIds', 'cleanup', 'dependencies', 'executionMethods', 'executionSpec', 'sharedVerificationChecks', 'tags', 'domain'], 'TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID')
  if (input.schemaVersion !== 'test-case/v1' && input.schemaVersion !== 'test-case/v2') fail('TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', 'schemaVersion 必须为 test-case/v1 或 test-case/v2', 422)
  const testPointIds = uniqueIds(input.testPointIds, 'testPointIds')
  if (!testPointIds.length) fail('TEST_CASE_BASIS_REFERENCE_INVALID', '用例至少引用一个已自动校验的测试点', 422)
  if (validPointIds && testPointIds.some(pointId => !validPointIds.has(pointId))) fail('TEST_CASE_BASIS_REFERENCE_INVALID', '用例引用了当前已校验树之外的测试点', 422)
  const testDimension = dimension(input.dimension)
  const nonFunctionalSpec = input.executionSpec !== undefined && ['performance', 'stability', 'compatibility'].includes(testDimension)
  const methods = executionMethods(input.executionMethods, nonFunctionalSpec)
  const dependencies = uniqueIds(input.dependencies ?? [], 'dependencies')
  const preconditions = texts(input.preconditions, 'preconditions', 100, 2_000)
  const dataRequirementIds = uniqueIds(input.dataRequirementIds ?? [], 'dataRequirementIds')
  const executionSpec = validateExecutionSpec(input.executionSpec, testDimension, methods, preconditions, dataRequirementIds)
  const synchronizedSpec = executionSpec.kind === 'functional' ? { ...executionSpec, preconditions, testDataRequirements: dataRequirementIds } : executionSpec
  const synchronizedMethods = synchronizedSpec.kind === 'functional' ? methods.map(method => method.method === synchronizedSpec.method ? { ...method, steps: synchronizedSpec.steps, verificationChecks: synchronizedSpec.verificationChecks, executionReadiness: synchronizedSpec.executionReadiness, automationHint: synchronizedSpec.automationHint } : method) : methods
  return {
    schemaVersion: input.schemaVersion,
    title: requiredText(input.title, 'title', 500),
    objective: requiredText(input.objective, 'objective', 4_000),
    dimension: testDimension,
    testPointIds,
    priority: priority(input.priority),
    preconditions,
    dataRequirementIds,
    cleanup: texts(input.cleanup, 'cleanup', 100, 2_000),
    dependencies,
    executionMethods: synchronizedMethods,
    executionSpec: synchronizedSpec,
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

export function executableTestPointIds(nodes: Array<{ nodeId: string; parentId: string | null; deleted?: boolean; applicability: TestPointNodeContent['applicability'] }>) {
  const active = nodes.filter(node => !node.deleted)
  const parentIds = new Set(active.flatMap(node => node.parentId ? [node.parentId] : []))
  return new Set(active.filter(node => node.applicability !== 'not_applicable' && !parentIds.has(node.nodeId)).map(node => node.nodeId))
}

export type DesignCandidateNode = TestPointNodeContent & { ref: string; parentRef?: string }

export type TestDataRequirementCandidate = Omit<TestDataRequirement, 'id' | 'caseIds' | 'testPointIds'> & {
  ref: string
  caseRefs: string[]
  testPointIds: string[]
}

export interface TestPointDesignCandidate extends Record<string, unknown> {
  schemaVersion: 'test-point-design/v1'
  nodes: DesignCandidateNode[]
  findings: Record<string, unknown>[]
  confirmationItems: Record<string, unknown>[]
}

export interface TestCaseDesignCandidate extends Record<string, unknown> {
  schemaVersion: 'test-case-design/v1' | 'test-design-repair/v1'
  cases: Array<{ ref: string; content: TestCaseContent }>
  dataRequirements: TestDataRequirementCandidate[]
  findings: Record<string, unknown>[]
  confirmationItems: Record<string, unknown>[]
  proposals: Array<{ operation: 'reuse' | 'update' | 'create' | 'deprecate' | 'reference'; sourceCaseId?: string; sourceRevision?: number; candidateRef?: string; requirementRefs: string[]; testPointIds: string[]; reason: string; confidence: number }>
}

export function validateTestPointDesignCandidate(value: unknown): TestPointDesignCandidate {
  const input = synthesisObject(value, '/', '提交结果必须是对象')
  synthesisRejectUnknown(input, ['schemaVersion', 'nodes', 'findings', 'confirmationItems'], '/')
  if (input.schemaVersion !== 'test-point-design/v1') synthesisFail('/schemaVersion', 'schemaVersion 必须为 test-point-design/v1')
  const nodes = validateCandidateNodes(input.nodes)
  const { findings, confirmationItems } = validateDesignIssues(input)
  return { schemaVersion: 'test-point-design/v1', nodes, findings, confirmationItems }
}

const synthesisCaseFields = ['ref', 'schemaVersion', 'title', 'objective', 'dimension', 'testPointIds', 'priority', 'preconditions', 'dataRequirementIds', 'cleanup', 'dependencies', 'executionMethods', 'executionSpec', 'sharedVerificationChecks', 'tags', 'domain']
const legacySynthesisFieldGuidance: Record<string, string> = {
  preConditions: '改为 preconditions',
  steps: '移入 executionMethods[].steps，并使用 action/expected',
  expectedResults: '拆入 executionMethods[].steps[].expected 或 verificationChecks',
  entryPoints: 'UI 入口写入 uiSpec.entry，API 入口写入 apiSpec.path',
  dataRequirements: '移到提交根对象 dataRequirements[]',
  testData: '移到提交根对象 dataRequirements[]',
}

export function validateTestCaseDesignCandidate(value: unknown, validPointIds?: Set<string>, repair = false): TestCaseDesignCandidate {
  const input = synthesisObject(value, '/', '提交结果必须是对象')
  synthesisRejectUnknown(input, ['schemaVersion', 'cases', 'dataRequirements', 'findings', 'confirmationItems', 'proposals'], '/')
  const schemaVersion = repair ? 'test-design-repair/v1' : 'test-case-design/v1'
  if (input.schemaVersion !== schemaVersion) synthesisFail('/schemaVersion', `schemaVersion 必须为 ${schemaVersion}`)
  if (!Array.isArray(input.cases) || !input.cases.length || input.cases.length > 1_000) synthesisFail('/cases', 'cases 必须包含 1 到 1000 条用例')
  if (!Array.isArray(input.dataRequirements) || input.dataRequirements.length > 1_000) synthesisFail('/dataRequirements', 'dataRequirements 必须是最多 1000 项的数组')

  const caseRefs = new Set<string>()
  const cases = input.cases.map((candidate, index) => {
    const path = `/cases/${index}`
    const caseInput = synthesisObject(candidate, path, `cases[${index}] 必须是对象`)
    const unexpected = Object.keys(caseInput).filter(key => !synthesisCaseFields.includes(key))
    if (unexpected.length) {
      const guidance = unexpected.map(key => legacySynthesisFieldGuidance[key]).filter(Boolean)
      synthesisFail(path, `包含不允许的字段：${unexpected.join('、')}${guidance.length ? `；字段映射：${guidance.join('；')}` : ''}`)
    }
    try {
      const ref = synthesisText(caseInput.ref, `${path}/ref`, 200)
      if (caseRefs.has(ref)) synthesisFail(`${path}/ref`, `临时引用 ${ref} 重复`)
      caseRefs.add(ref)
      const { ref: _ref, ...contentInput } = caseInput
      const normalized = validateTestCaseContent(contentInput, validPointIds)
      if (normalized.dataRequirementIds.length) synthesisFail(`${path}/dataRequirementIds`, '候选中的 dataRequirementIds 必须为空；服务端根据 dataRequirements[].caseRefs 生成正式关联')
      return { ref, content: normalized }
    } catch (error) {
      if (error instanceof TestDesignError && error.details && typeof error.details === 'object' && 'path' in error.details) throw error
      synthesisFail(path, errorMessage(error))
    }
  })
  const refs = new Set<string>()
  const dataRequirements = input.dataRequirements.map((candidate, index): TestDataRequirementCandidate => {
    const path = `/dataRequirements/${index}`
    const item = synthesisObject(candidate, path, `dataRequirements[${index}] 必须是对象`)
    synthesisRejectUnknown(item, ['ref', 'name', 'entityType', 'featureTags', 'testPointIds', 'caseRefs', 'fieldConstraints', 'relationships', 'quantity', 'initialState', 'preparationHint', 'sensitivity', 'isolation', 'resetAndCleanup', 'readiness', 'readinessReason'], path)
    const ref = synthesisText(item.ref, `${path}/ref`, 200)
    if (refs.has(ref)) synthesisFail(`${path}/ref`, `临时引用 ${ref} 重复`)
    refs.add(ref)
    const testPointIds = synthesisIds(item.testPointIds, `${path}/testPointIds`)
    if (testPointIds.some(pointId => validPointIds && !validPointIds.has(pointId))) synthesisFail(`${path}/testPointIds`, '包含当前已校验测试点树之外的引用')
    const referencedCaseRefs = synthesisIds(item.caseRefs, `${path}/caseRefs`)
    if (!referencedCaseRefs.length || referencedCaseRefs.some(caseRef => !caseRefs.has(caseRef))) synthesisFail(`${path}/caseRefs`, '必须引用本次提交中的有效用例 ref')
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
      caseRefs: referencedCaseRefs,
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
  const { findings, confirmationItems } = validateDesignIssues(input)
  const proposals = validateProposalCandidates(input.proposals, caseRefs)
  if (proposals.length) {
    const proposedCaseRefs = new Set(proposals.flatMap(item => item.candidateRef ? [item.candidateRef] : []))
    const missing = [...caseRefs].filter(ref => !proposedCaseRefs.has(ref))
    if (missing.length) synthesisFail('/proposals', `每条候选用例都必须由 Proposal 覆盖，缺少：${missing.join('、')}`)
  }
  return { schemaVersion, cases, dataRequirements, findings, confirmationItems, proposals }
}

function validateProposalCandidates(value: unknown, caseRefs: Set<string>): TestCaseDesignCandidate['proposals'] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 1_000) synthesisFail('/proposals', 'proposals 必须是最多 1000 项的数组')
  return value.map((candidate, index) => {
    const path = `/proposals/${index}`
    const input = synthesisObject(candidate, path, 'Proposal 必须是对象')
    synthesisRejectUnknown(input, ['operation', 'sourceCaseId', 'sourceRevision', 'candidateRef', 'requirementRefs', 'testPointIds', 'reason', 'confidence'], path)
    const operation = synthesisEnum(input.operation, `${path}/operation`, ['reuse', 'update', 'create', 'deprecate', 'reference'] as const)
    const sourceCaseId = input.sourceCaseId === undefined ? undefined : synthesisText(input.sourceCaseId, `${path}/sourceCaseId`, 500)
    const sourceRevision = input.sourceRevision === undefined ? undefined : synthesisPositiveInteger(input.sourceRevision, `${path}/sourceRevision`)
    const candidateRef = input.candidateRef === undefined ? undefined : synthesisText(input.candidateRef, `${path}/candidateRef`, 200)
    if ((operation === 'reuse' || operation === 'update' || operation === 'deprecate' || operation === 'reference') && (!sourceCaseId || !sourceRevision)) synthesisFail(path, `${operation} 必须指定 sourceCaseId 和 sourceRevision`)
    if ((operation === 'reuse' || operation === 'update' || operation === 'create') && (!candidateRef || !caseRefs.has(candidateRef))) synthesisFail(`${path}/candidateRef`, `${operation} 必须引用本次 cases 中的有效 ref`)
    if ((operation === 'deprecate' || operation === 'reference') && candidateRef && !caseRefs.has(candidateRef)) synthesisFail(`${path}/candidateRef`, 'candidateRef 不属于本次 cases')
    const confidence = Number(input.confidence)
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) synthesisFail(`${path}/confidence`, 'confidence 必须是 0 到 1 的数值')
    return { operation, ...(sourceCaseId ? { sourceCaseId } : {}), ...(sourceRevision ? { sourceRevision } : {}), ...(candidateRef ? { candidateRef } : {}), requirementRefs: synthesisIds(input.requirementRefs, `${path}/requirementRefs`), testPointIds: synthesisIds(input.testPointIds, `${path}/testPointIds`), reason: synthesisText(input.reason, `${path}/reason`, 4_000), confidence }
  })
}

function validateCandidateNodes(raw: unknown): DesignCandidateNode[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 1_000) candidateFail('/nodes', '必须包含 1 到 1000 个节点')
  const dimensions: TestDimension[] = ['functional', 'performance', 'stability', 'compatibility', 'security']
  const refs = new Set<string>()
  const nodes = raw.map((value, index): DesignCandidateNode => {
    const path = `/nodes/${index}`
    if (!value || typeof value !== 'object' || Array.isArray(value)) candidateFail(path, '必须是对象')
    const input = value as Record<string, unknown>
    const allowed = ['ref', 'parentRef', 'title', 'objective', 'dimension', 'priority', 'applicability', 'designTechniques', 'entryMethods', 'oracle', 'dataConditions', 'risks', 'assumptions', 'basisRefs', 'historicalRefs']
    const unexpected = Object.keys(input).filter(key => !allowed.includes(key))
    if (unexpected.length) candidateFail(path, `包含不允许的字段：${unexpected.join('、')}`)
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
  if (nodes.some(node => !node.basisRefs.length)) candidateFail('/nodes', '每个测试点必须至少引用一项固定需求依据')
  for (const [index, node] of nodes.entries()) {
    if (node.parentRef && !refs.has(node.parentRef)) candidateFail(`/nodes/${index}/parentRef`, '未引用本次提交内的节点')
  }
  return nodes
}

function validateDesignIssues(input: Record<string, unknown>) {
  if (!Array.isArray(input.findings) || input.findings.length > 500) synthesisFail('/findings', 'findings 必须是最多 500 项的数组')
  const findings = input.findings.map((candidate, index) => {
    const path = `/findings/${index}`
    const finding = synthesisObject(candidate, path, 'Finding 必须是对象')
    synthesisRejectUnknown(finding, ['title', 'description', 'severity', 'basisRefs'], path)
    const severity = synthesisEnum(finding.severity, `${path}/severity`, ['blocker', 'high', 'medium', 'low'] as const)
    return { title: synthesisText(finding.title, `${path}/title`, 500), description: synthesisText(finding.description, `${path}/description`, 8_000), severity, basisRefs: synthesisIds(finding.basisRefs, `${path}/basisRefs`) }
  })
  if (!Array.isArray(input.confirmationItems) || input.confirmationItems.length > 500) synthesisFail('/confirmationItems', 'confirmationItems 必须是最多 500 项的数组')
  const confirmationItems = input.confirmationItems.map((candidate, index) => {
    const path = `/confirmationItems/${index}`
    const item = synthesisObject(candidate, path, '待确认项必须是对象')
    synthesisRejectUnknown(item, ['title', 'question', 'decisionType', 'impactStage', 'affectedRefs', 'blocker'], path)
    const impactStage = synthesisEnum(item.impactStage, `${path}/impactStage`, ['tree', 'case', 'data', 'publication'] as const)
    if (typeof item.blocker !== 'boolean') synthesisFail(`${path}/blocker`, '必须是布尔值')
    return { title: synthesisText(item.title, `${path}/title`, 500), question: synthesisText(item.question, `${path}/question`, 8_000), decisionType: synthesisText(item.decisionType, `${path}/decisionType`, 200), impactStage, affectedRefs: synthesisIds(item.affectedRefs, `${path}/affectedRefs`), blocker: item.blocker }
  })
  return { findings, confirmationItems }
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

function validateHistoricalLibrarySelection(value: unknown): HistoricalLibrarySelection {
  if (value === undefined) return { mode: 'latest_library' }
  const input = object(value, 'TEST_DESIGN_HISTORICAL_SOURCE_INVALID', 'historicalLibrarySelection 必须是对象')
  if (input.mode === 'latest_library' || input.mode === 'none') {
    rejectUnknown(input, ['mode'], 'TEST_DESIGN_HISTORICAL_SOURCE_INVALID')
    return { mode: input.mode }
  }
  if (input.mode === 'library_version') {
    rejectUnknown(input, ['mode', 'testCaseLibraryVersionId'], 'TEST_DESIGN_HISTORICAL_SOURCE_INVALID')
    return { mode: 'library_version', testCaseLibraryVersionId: id(input.testCaseLibraryVersionId, 'testCaseLibraryVersionId') }
  }
  if (input.mode === 'suite_version') {
    rejectUnknown(input, ['mode', 'suiteVersionId'], 'TEST_DESIGN_HISTORICAL_SOURCE_INVALID')
    return { mode: 'suite_version', suiteVersionId: id(input.suiteVersionId, 'suiteVersionId') }
  }
  fail('TEST_DESIGN_HISTORICAL_SOURCE_INVALID', 'historicalLibrarySelection.mode 无效', 422)
}

function executionMethods(value: unknown, allowEmpty = false): ExecutionMethodSpec[] {
  if (!Array.isArray(value) || value.length > 2 || (!allowEmpty && value.length < 1)) fail('TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', allowEmpty ? 'executionMethods 必须是最多两种 UI/API 兼容入口' : 'executionMethods 必须包含一到两种方式', 422)
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

function validateExecutionSpec(value: unknown, testDimension: TestDimension, methods: ExecutionMethodSpec[], preconditions: string[], dataRequirementIds: string[]): TestCaseExecutionSpec {
  if (value === undefined) {
    const primary = methods[0]
    if (testDimension === 'functional' || testDimension === 'security') return { kind: 'functional', method: primary.method, steps: primary.steps, verificationChecks: primary.verificationChecks, preconditions, testDataRequirements: dataRequirementIds, executionReadiness: primary.executionReadiness, automationHint: primary.automationHint }
    if (testDimension === 'performance') return { kind: 'performance', method: 'performance_tool', target: '待需求或人工确认', scenario: '待需求或人工确认', virtualUsers: null, duration: null, rampUp: null, thresholds: [], dataStrategy: '待确认', environmentRequirements: [], executionReadiness: 'needs_confirmation' }
    if (testDimension === 'stability') return { kind: 'stability', method: 'long_running', workload: '待需求或人工确认', duration: null, interval: null, observations: [], recoveryPolicy: null, checkpointPolicy: null, environmentRequirements: [], executionReadiness: 'needs_confirmation' }
    return { kind: 'compatibility', method: 'environment_matrix', baseMethod: primary.method, baseCaseRefs: [], browserMatrix: [], operatingSystemMatrix: [], viewportMatrix: [], versionMatrix: [], expectedConsistency: '待需求、项目配置或人工确认', executionReadiness: 'needs_confirmation' }
  }
  const input = object(value, 'TEST_CASE_EXECUTION_SPEC_INVALID', 'executionSpec 必须是对象')
  if (testDimension === 'functional' || testDimension === 'security') {
    rejectUnknown(input, ['kind', 'method', 'steps', 'verificationChecks', 'preconditions', 'testDataRequirements', 'executionReadiness', 'automationHint'], 'TEST_CASE_EXECUTION_SPEC_INVALID')
    if (input.kind !== 'functional' || (input.method !== 'ui' && input.method !== 'api')) fail('TEST_CASE_EXECUTION_SPEC_INVALID', '功能执行配置 kind/method 无效', 422)
    if (!methods.some(method => method.method === input.method)) fail('TEST_CASE_EXECUTION_SPEC_INVALID', '功能执行配置 method 必须存在于 executionMethods', 422)
    return { kind: 'functional', method: input.method, steps: steps(input.steps, 0), verificationChecks: checks(input.verificationChecks, 'executionSpec.verificationChecks'), preconditions: texts(input.preconditions, 'executionSpec.preconditions', 100, 2_000), testDataRequirements: texts(input.testDataRequirements, 'executionSpec.testDataRequirements', 100, 2_000), executionReadiness: readiness(input.executionReadiness), automationHint: text(input.automationHint, 'executionSpec.automationHint', 2_000) }
  }
  if (testDimension === 'performance') {
    rejectUnknown(input, ['kind', 'method', 'target', 'scenario', 'virtualUsers', 'duration', 'rampUp', 'thresholds', 'dataStrategy', 'environmentRequirements', 'executionReadiness'], 'TEST_CASE_EXECUTION_SPEC_INVALID')
    if (input.kind !== 'performance' || input.method !== 'performance_tool') fail('TEST_CASE_EXECUTION_SPEC_INVALID', '性能执行配置 kind/method 无效', 422)
    if (!Array.isArray(input.thresholds) || input.thresholds.length > 100) fail('TEST_CASE_EXECUTION_SPEC_INVALID', 'thresholds 必须是最多 100 项的数组', 422)
    const thresholds = input.thresholds.map((candidate, index) => { const threshold = object(candidate, 'TEST_CASE_EXECUTION_SPEC_INVALID', `thresholds[${index}] 必须是对象`); rejectUnknown(threshold, ['metric', 'target', 'sourceRef'], 'TEST_CASE_EXECUTION_SPEC_INVALID'); return { metric: requiredText(threshold.metric, `thresholds[${index}].metric`, 200), target: requiredText(threshold.target, `thresholds[${index}].target`, 500), sourceRef: requiredText(threshold.sourceRef, `thresholds[${index}].sourceRef`, 500) } })
    const requestedReadiness = readiness(input.executionReadiness)
    return { kind: 'performance', method: 'performance_tool', target: requiredText(input.target, 'executionSpec.target', 2_000), scenario: requiredText(input.scenario, 'executionSpec.scenario', 4_000), virtualUsers: nullablePositiveInteger(input.virtualUsers, 'executionSpec.virtualUsers'), duration: nullableText(input.duration, 'executionSpec.duration', 200), rampUp: nullableText(input.rampUp, 'executionSpec.rampUp', 200), thresholds, dataStrategy: requiredText(input.dataStrategy, 'executionSpec.dataStrategy', 2_000), environmentRequirements: texts(input.environmentRequirements, 'executionSpec.environmentRequirements', 100, 2_000), executionReadiness: thresholds.length ? requestedReadiness : 'needs_confirmation' }
  }
  if (testDimension === 'stability') {
    rejectUnknown(input, ['kind', 'method', 'workload', 'duration', 'interval', 'observations', 'recoveryPolicy', 'checkpointPolicy', 'environmentRequirements', 'executionReadiness'], 'TEST_CASE_EXECUTION_SPEC_INVALID')
    if (input.kind !== 'stability' || input.method !== 'long_running') fail('TEST_CASE_EXECUTION_SPEC_INVALID', '稳定性执行配置 kind/method 无效', 422)
    const duration = nullableText(input.duration, 'executionSpec.duration', 200)
    return { kind: 'stability', method: 'long_running', workload: requiredText(input.workload, 'executionSpec.workload', 4_000), duration, interval: nullableText(input.interval, 'executionSpec.interval', 200), observations: texts(input.observations, 'executionSpec.observations', 100, 2_000), recoveryPolicy: nullableText(input.recoveryPolicy, 'executionSpec.recoveryPolicy', 2_000), checkpointPolicy: nullableText(input.checkpointPolicy, 'executionSpec.checkpointPolicy', 2_000), environmentRequirements: texts(input.environmentRequirements, 'executionSpec.environmentRequirements', 100, 2_000), executionReadiness: duration ? readiness(input.executionReadiness) : 'needs_confirmation' }
  }
  rejectUnknown(input, ['kind', 'method', 'baseMethod', 'baseCaseRefs', 'browserMatrix', 'operatingSystemMatrix', 'viewportMatrix', 'versionMatrix', 'expectedConsistency', 'executionReadiness'], 'TEST_CASE_EXECUTION_SPEC_INVALID')
  if (input.kind !== 'compatibility' || input.method !== 'environment_matrix' || (input.baseMethod !== 'ui' && input.baseMethod !== 'api')) fail('TEST_CASE_EXECUTION_SPEC_INVALID', '兼容性执行配置 kind/method/baseMethod 无效', 422)
  const browserMatrix = texts(input.browserMatrix, 'executionSpec.browserMatrix', 100, 500)
  const operatingSystemMatrix = texts(input.operatingSystemMatrix, 'executionSpec.operatingSystemMatrix', 100, 500)
  const viewportMatrix = texts(input.viewportMatrix, 'executionSpec.viewportMatrix', 100, 500)
  const versionMatrix = texts(input.versionMatrix, 'executionSpec.versionMatrix', 100, 500)
  const hasMatrix = browserMatrix.length + operatingSystemMatrix.length + viewportMatrix.length + versionMatrix.length > 0
  return { kind: 'compatibility', method: 'environment_matrix', baseMethod: input.baseMethod, baseCaseRefs: uniqueIds(input.baseCaseRefs, 'executionSpec.baseCaseRefs'), browserMatrix, operatingSystemMatrix, viewportMatrix, versionMatrix, expectedConsistency: requiredText(input.expectedConsistency, 'executionSpec.expectedConsistency', 4_000), executionReadiness: hasMatrix ? readiness(input.executionReadiness) : 'needs_confirmation' }
}

function nullableText(value: unknown, field: string, max: number) { return value == null || value === '' ? null : text(value, field, max).trim() || null }
function nullablePositiveInteger(value: unknown, field: string) { if (value == null) return null; if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 1_000_000) fail('TEST_CASE_EXECUTION_SPEC_INVALID', `${field} 必须为正整数或 null`, 422); return Number(value) }

function steps(value: unknown, methodIndex: number) {
  if (!Array.isArray(value) || !value.length || value.length > 200) fail('TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', `executionMethods[${methodIndex}].steps 不能为空`, 422)
  const keys = new Set<string>()
  return value.map((candidate, index) => { const input = object(candidate, 'TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', 'step 必须是对象'); rejectUnknown(input, ['key', 'action', 'expected'], 'TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID'); const key = id(input.key, `steps[${index}].key`); if (keys.has(key)) fail('TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', '步骤 key 不能重复', 422); keys.add(key); return { key, action: requiredText(input.action, 'step.action', 4_000), expected: requiredText(input.expected, 'step.expected', 4_000) } })
}

function checks(value: unknown, field: string) { if (!Array.isArray(value) || value.length > 200) fail('TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', `${field} 必须是数组`, 422); return value.map((candidate, index) => { const input = object(candidate, 'TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', '检查点必须是对象'); rejectUnknown(input, ['key', 'description'], 'TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID'); return { key: id(input.key, `${field}[${index}].key`), description: requiredText(input.description, `${field}[${index}].description`, 4_000) } }) }
function readiness(value: unknown): ExecutionReadiness { if (value !== 'ready' && value !== 'blocked' && value !== 'needs_confirmation') fail('TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', 'executionReadiness 无效', 422); return value }
function dimension(value: unknown) { if (!['functional', 'performance', 'stability', 'compatibility', 'security'].includes(String(value))) fail('TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', 'dimension 无效', 422); return value as TestCaseContent['dimension'] }
function priority(value: unknown) { if (!['P0', 'P1', 'P2', 'P3'].includes(String(value))) fail('TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', 'priority 无效', 422); return value as TestCaseContent['priority'] }
function optionalDimensions(value: unknown) { if (value === undefined) return []; if (!Array.isArray(value)) fail('TEST_DESIGN_INPUT_INVALID', 'focusDimensions 必须是数组'); return [...new Set(value.map(dimension))] }
function optionalScopeRules(value: unknown) { if (value === undefined) return []; if (!Array.isArray(value) || value.length > 100) fail('TEST_DESIGN_INPUT_INVALID', '范围规则必须是数组'); return value.map(candidate => { const input = object(candidate, 'TEST_DESIGN_INPUT_INVALID', '范围规则必须是对象'); rejectUnknown(input, ['kind', 'value'], 'TEST_DESIGN_INPUT_INVALID'); return { kind: requiredText(input.kind, 'scope.kind', 100), value: requiredText(input.value, 'scope.value', 1_000) } }) }
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
function synthesisFail(path: string, message: string): never { throw new TestDesignError('TEST_DESIGN_CANDIDATE_SCHEMA_INVALID', `${path} ${message}`, 422, { path }) }
function errorMessage(error: unknown) { return error instanceof TestDesignError ? error.message.replace(/^[A-Z0-9_]+:\s*/u, '') : error instanceof Error ? error.message : String(error) }
function object(value: unknown, code: string, message: string) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, message); return value as Record<string, unknown> }
function rejectUnknown(value: Record<string, unknown>, allowed: string[], code: string) { const unexpected = Object.keys(value).filter(key => !allowed.includes(key)); if (unexpected.length) fail(code, `包含不允许的字段：${unexpected.join('、')}`) }
function fail(code: string, message: string, status = 400, details?: unknown): never { throw new TestDesignError(code, message, status, details) }
