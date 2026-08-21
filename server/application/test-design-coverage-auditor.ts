import { randomUUID } from 'node:crypto'
import type { CoverageAudit, HistoricalCaseSnapshot, RetrievalSnapshot, TestCase, TestDesignBasisSnapshot } from '../domain/test-design-types.js'
import { canonicalSha256 } from './canonical-json.js'

/** Requirement coverage is proven only by explicit TestCase.requirementRefs. */
export function auditTestDesignCoverage(input: {
  runId: string
  basis: TestDesignBasisSnapshot
  retrieval: RetrievalSnapshot
  historical: HistoricalCaseSnapshot
  cases: TestCase[]
}): CoverageAudit {
  const requirements = input.basis.content.requirements
  const requirementIds = new Set(requirements.map(item => item.clientRequirementPointId.trim()))
  const current = input.cases
    .filter(item => !item.tombstonedAt)
    .map(testCase => ({ testCase, revision: testCase.revisions.find(item => item.revision === testCase.currentRevision)! }))
  const caseSetSha256 = canonicalSha256(current.map(item => ({ caseId: item.testCase.id, revision: item.revision.revision, contentSha256: item.revision.contentSha256 })).sort((left, right) => left.caseId.localeCompare(right.caseId)))
  const blockers: CoverageAudit['blockers'] = []
  const advisories: CoverageAudit['advisories'] = []
  const relations: CoverageAudit['relations'] = []
  const covered = new Set<string>()

  for (const clarification of input.basis.content.clarifications) {
    if (clarification.blocking && clarification.status === 'pending') blockers.push({ code: 'PLANNING_CLARIFICATION_UNRESOLVED', message: `阻断问题 ${clarification.question} 尚未获得正式回答`, subjectId: clarification.id, resolution: 'human_decision' })
  }
  for (const item of current) {
    const content = item.revision.content
    const invalidRefs = content.requirementRefs.filter(ref => !requirementIds.has(ref))
    if (invalidRefs.length) blockers.push({ code: 'TEST_CASE_REQUIREMENT_REFERENCE_INVALID', message: `用例 ${content.title} 引用了当前 Requirement Release 之外的需求：${invalidRefs.join('、')}`, subjectId: item.testCase.id, resolution: 'agent_repair' })
    for (const ref of content.requirementRefs) {
      if (!requirementIds.has(ref)) continue
      covered.add(ref)
      relations.push({ basisRef: ref, requirementId: ref, caseId: item.testCase.id, status: 'covered', reason: '用例通过 requirementRefs 显式引用正式 Requirement' })
    }
    if (!content.steps.length) blockers.push({ code: 'TEST_CASE_STEPS_MISSING', message: `用例 ${content.title} 缺少步骤`, subjectId: item.testCase.id, resolution: 'manual_edit' })
    if (!content.expectedResults.length) blockers.push({ code: 'TEST_CASE_EXPECTED_RESULTS_MISSING', message: `用例 ${content.title} 缺少预期结果`, subjectId: item.testCase.id, resolution: 'manual_edit' })
    if (!content.executionMethods.length) blockers.push({ code: 'TEST_CASE_EXECUTION_METHODS_MISSING', message: `用例 ${content.title} 缺少执行方式`, subjectId: item.testCase.id, resolution: 'manual_edit' })
  }
  for (const requirement of requirements) {
    const requirementId = requirement.clientRequirementPointId.trim()
    if (covered.has(requirementId)) continue
    blockers.push({ code: 'COVERAGE_REQUIREMENT_UNCOVERED', message: `Requirement ${requirementId} 没有显式关联的测试用例`, subjectId: requirementId, resolution: 'agent_repair' })
    relations.push({ basisRef: requirementId, requirementId, status: 'not_covered', reason: '当前没有 TestCase 通过 requirementRefs 显式引用该 Requirement' })
  }

  const duplicateGroups = new Map<string, string[]>()
  for (const item of current) {
    const content = item.revision.content
    const key = canonicalSha256({ title: normalize(content.title), dimension: content.dimension, steps: content.steps.map(normalize), expectedResults: content.expectedResults.map(normalize) })
    duplicateGroups.set(key, [...(duplicateGroups.get(key) ?? []), item.testCase.id])
  }
  for (const caseIds of duplicateGroups.values()) {
    if (caseIds.length < 2) continue
    advisories.push({ code: 'POSSIBLE_DUPLICATE_TEST_CASE', message: `存在 ${caseIds.length} 条标题、步骤、预期结果与测试类型几乎完全一致的用例，请人工确认是否需要合并`, subjectId: caseIds[0], details: { reasons: caseIds } })
  }
  const extendedCount = current.filter(item => item.revision.content.requirementRefs.length === 0).length
  if (extendedCount) advisories.push({ code: 'EXTENDED_RISK_TEST_CASES_PRESENT', message: `存在 ${extendedCount} 条未关联 Requirement 的扩展风险测试；这是合法状态，不计入正式 Requirement Coverage` })

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
