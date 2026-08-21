import { randomUUID } from 'node:crypto'
import type { CoverageAudit, EffectiveTestCase, HistoricalCaseSnapshot, RetrievalSnapshot, TestDesignBasisSnapshot } from '../domain/test-design-types.js'
import { canonicalSha256 } from './canonical-json.js'

/** Requirement coverage is proven only by Service-owned refs projected to the current Release. */
export function auditTestDesignCoverage(input: {
  runId: string
  basis: TestDesignBasisSnapshot
  retrieval: RetrievalSnapshot
  historical: HistoricalCaseSnapshot
  cases: EffectiveTestCase[]
}): CoverageAudit {
  const allRequirements = input.basis.content.requirements
  const requirements = allRequirements.filter(item => item.coverageTarget)
  const requirementIds = new Set(allRequirements.map(item => item.clientRequirementPointId.trim()))
  const coverageRequirementIds = new Set(requirements.map(item => item.clientRequirementPointId.trim()))
  const current = input.cases
  const caseSetSha256 = canonicalSha256(current.map(item => ({ caseId: item.caseId, revision: item.revision, contentSha256: item.contentSha256, effectiveRequirementRefs: item.effectiveRequirementRefs })).sort((left, right) => left.caseId.localeCompare(right.caseId)))
  const blockers: CoverageAudit['blockers'] = []
  const advisories: CoverageAudit['advisories'] = []
  const relations: CoverageAudit['relations'] = []
  const covered = new Set<string>()

  for (const clarification of input.basis.content.clarifications) {
    if (clarification.blocking && clarification.status === 'pending') blockers.push({ code: 'PLANNING_CLARIFICATION_UNRESOLVED', message: `阻断问题 ${clarification.question} 尚未获得正式回答`, subjectId: clarification.id, resolution: 'human_decision' })
  }
  for (const item of current) {
    const content = item.content
    const invalidRefs = item.effectiveRequirementRefs.filter(ref => !requirementIds.has(ref))
    if (invalidRefs.length) blockers.push({ code: 'TEST_CASE_REQUIREMENT_REFERENCE_INVALID', message: `用例 ${content.title} 引用了当前 Requirement Release 之外的需求：${invalidRefs.join('、')}`, subjectId: item.caseId, resolution: 'agent_repair' })
    for (const ref of item.effectiveRequirementRefs) {
      if (!coverageRequirementIds.has(ref)) continue
      covered.add(ref)
      relations.push({ basisRef: ref, requirementId: ref, caseId: item.caseId, status: 'covered', reason: 'Effective Case Set 通过当前 Requirement Release 的 effectiveRequirementRefs 显式覆盖 coverageTarget Requirement' })
    }
    if (!content.steps.length) blockers.push({ code: 'TEST_CASE_STEPS_MISSING', message: `用例 ${content.title} 缺少步骤`, subjectId: item.caseId, resolution: 'manual_edit' })
    if (!content.expectedResults.length) blockers.push({ code: 'TEST_CASE_EXPECTED_RESULTS_MISSING', message: `用例 ${content.title} 缺少预期结果`, subjectId: item.caseId, resolution: 'manual_edit' })
    if (!content.executionMethods.length) blockers.push({ code: 'TEST_CASE_EXECUTION_METHODS_MISSING', message: `用例 ${content.title} 缺少执行方式`, subjectId: item.caseId, resolution: 'manual_edit' })
  }
  for (const requirement of requirements) {
    const requirementId = requirement.clientRequirementPointId.trim()
    if (covered.has(requirementId)) continue
    blockers.push({ code: 'COVERAGE_REQUIREMENT_UNCOVERED', message: `Requirement ${requirementId} 没有显式关联的测试用例`, subjectId: requirementId, resolution: 'agent_repair' })
    relations.push({ basisRef: requirementId, requirementId, status: 'not_covered', reason: '当前没有 TestCase 通过 effectiveRequirementRefs 显式覆盖该 Requirement' })
  }

  const duplicateGroups = new Map<string, string[]>()
  for (const item of current) {
    const content = item.content
    const key = canonicalSha256({ title: normalize(content.title), dimension: content.dimension, steps: content.steps.map(normalize), expectedResults: content.expectedResults.map(normalize) })
    duplicateGroups.set(key, [...(duplicateGroups.get(key) ?? []), item.caseId])
  }
  for (const caseIds of duplicateGroups.values()) {
    if (caseIds.length < 2) continue
    advisories.push({ code: 'POSSIBLE_DUPLICATE_TEST_CASE', message: `存在 ${caseIds.length} 条标题、步骤、预期结果与测试类型几乎完全一致的用例，请人工确认是否需要合并`, subjectId: caseIds[0], details: { reasons: caseIds } })
  }
  const extendedCount = current.filter(item => item.effectiveRequirementRefs.length === 0).length
  if (extendedCount) advisories.push({ code: 'EXTENDED_RISK_TEST_CASES_PRESENT', message: `存在 ${extendedCount} 条未关联 Requirement 的扩展风险测试；这是合法状态，不计入正式 Requirement Coverage` })
  for (const historical of input.historical.items) {
    const locator = historical.locator as { caseId?: unknown } | undefined
    const subjectId = typeof locator?.caseId === 'string' ? locator.caseId : historical.id
    for (const sourceRequirementId of historical.sourceRequirementRefs) {
      const mapping = input.historical.requirementMappings.find(item => item.sourceRequirementId === sourceRequirementId)
      if (mapping?.status === 'ambiguous') advisories.push({ code: 'HISTORICAL_REQUIREMENT_MAPPING_AMBIGUOUS', message: `历史用例 ${subjectId} 的来源 Requirement ${sourceRequirementId} 存在多个当前版本候选，Service 未进行猜测映射。`, subjectId, details: { reasons: mapping.candidateRequirementIds ?? [] } })
      if (!mapping || mapping.status === 'unmapped') advisories.push({ code: 'HISTORICAL_REQUIREMENT_UNMAPPED', message: `历史用例 ${subjectId} 的来源 Requirement ${sourceRequirementId} 无法安全映射到当前 Requirement Release；用例继续保留但不证明当前 Coverage。`, subjectId, details: { reasons: [sourceRequirementId] } })
    }
  }

  const inputSha256 = canonicalSha256({ basisSnapshotSha256: input.basis.snapshotSha256, retrievalSnapshotSha256: input.retrieval.snapshotSha256, historicalSnapshotSha256: input.historical.snapshotSha256, requirementReleaseId: input.basis.requirementReleaseId, caseSetSha256 })
  return {
    id: `coverage_audit_${randomUUID()}`,
    runId: input.runId,
    requirementReleaseId: input.basis.requirementReleaseId,
    caseSetSha256,
    inputSha256,
    status: 'valid',
    statistics: { totalBasis: requirements.length, coveredBasis: requirements.filter(item => covered.has(item.clientRequirementPointId.trim())).length, totalCases: current.length },
    relations,
    blockers,
    advisories,
    createdAt: new Date().toISOString(),
  }
}

function normalize(value: string) { return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN') }
