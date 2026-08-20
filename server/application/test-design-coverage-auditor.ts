import { randomUUID } from 'node:crypto'
import type { ConfirmationItem, CoverageAudit, HistoricalCaseSnapshot, RetrievalSnapshot, TestCase, TestDataRequirementSetVersion, TestDesignBasisSnapshot } from '../domain/test-design-types.js'
import { canonicalSha256 } from './canonical-json.js'
import { validateCaseDependencyGraph } from './test-design-validation.js'

/** Direct Requirement Release -> TestCase coverage audit. */
export function auditTestDesignCoverage(input: {
  runId: string
  basis: TestDesignBasisSnapshot
  retrieval: RetrievalSnapshot
  historical: HistoricalCaseSnapshot
  cases: TestCase[]
  dataSet: TestDataRequirementSetVersion
  findings: Array<{ id: string; title: string; severity: string; state: string }>
  confirmationItems: ConfirmationItem[]
}): CoverageAudit {
  const basisItems = input.basis.items.filter(item => item.kind === 'requirement_release' && item.locator?.coverageTarget !== false)
  const requirementByRef = new Map<string, string>()
  for (const item of basisItems) {
    const requirementId = String((item.locator as { requirementPointId?: unknown } | undefined)?.requirementPointId ?? item.id).trim()
    requirementByRef.set(item.id, requirementId)
    requirementByRef.set(requirementId, requirementId)
  }
  const cases = input.cases.filter(item => !item.tombstonedAt)
  const current = cases.map(testCase => ({ testCase, revision: testCase.revisions.find(item => item.revision === testCase.currentRevision)! }))
  validateCaseDependencyGraph(current.map(item => ({ id: item.testCase.id, content: item.revision.content })))
  const caseSetSha256 = canonicalSha256(current.map(item => ({ caseId: item.testCase.id, revision: item.revision.revision, contentSha256: item.revision.contentSha256 })).sort((left, right) => left.caseId.localeCompare(right.caseId)))
  const blockers: Array<Omit<CoverageAudit['blockers'][number], 'resolution'>> = []
  const relations: CoverageAudit['relations'] = []
  const coveredRequirements = new Set<string>()
  for (const clarification of input.basis.clarifications ?? []) if (clarification.blocking && clarification.status === 'pending') blockers.push({ code: 'PLANNING_CLARIFICATION_UNRESOLVED', message: `阻断问题 ${clarification.question} 尚未获得正式回答`, subjectId: clarification.id })
  const allowedHistoricalRefs = new Set(input.historical.items.map(item => item.id))
  for (const item of current) {
    const content = item.revision.content
    const refs = content.requirementRefs ?? []
    if (!refs.length) blockers.push({ code: 'TEST_CASE_REQUIREMENT_REFERENCE_MISSING', message: `用例 ${content.title} 未直接关联正式 Requirement`, subjectId: item.testCase.id })
    const invalid = refs.filter(ref => !requirementByRef.has(ref))
    if (invalid.length) blockers.push({ code: 'TEST_CASE_REQUIREMENT_REFERENCE_INVALID', message: `用例 ${content.title} 引用了当前 Requirement Release 之外的需求`, subjectId: item.testCase.id })
    for (const ref of refs) {
      const requirementId = requirementByRef.get(ref)
      if (!requirementId) continue
      coveredRequirements.add(requirementId)
      relations.push({ basisRef: ref, requirementId, caseId: item.testCase.id, status: 'covered', reason: '用例直接引用正式 Requirement' })
    }
    if (item.testCase.origin.startsWith('historical_')) {
      const source = input.historical.items.find(candidate => candidate.id === item.testCase.historicalSourceRef)
      if (!source || !allowedHistoricalRefs.has(source.id)) blockers.push({ code: 'TEST_CASE_HISTORICAL_SOURCE_INVALID', message: `用例 ${content.title} 的历史来源不属于当前冻结快照`, subjectId: item.testCase.id })
      else if (item.testCase.origin === 'historical_unchanged' && item.revision.semanticSha256 !== source.contentSha256) blockers.push({ code: 'TEST_CASE_HISTORICAL_REUSE_HASH_MISMATCH', message: `用例 ${content.title} 已变化，不能继续标记为原样复用`, subjectId: item.testCase.id })
      else if (item.testCase.origin === 'historical_modified' && item.revision.semanticSha256 === source.contentSha256) blockers.push({ code: 'TEST_CASE_HISTORICAL_REUSE_MODE_INVALID', message: `用例 ${content.title} 与历史来源完全一致，不应标记为修改复用`, subjectId: item.testCase.id })
    }
    if (item.testCase.reviewState !== 'approved') blockers.push({ code: 'TEST_CASE_REVIEW_REQUIRED', message: `用例 ${content.title} 当前 revision 未批准`, subjectId: item.testCase.id })
    if (content.executionMethods.some(method => method.steps.length === 0) && content.dimension === 'functional') blockers.push({ code: 'TEST_CASE_EXECUTION_METHOD_INCOMPLETE', message: `用例 ${content.title} 缺少可执行步骤`, subjectId: item.testCase.id })
    if (content.executionMethods.some(method => method.executionReadiness === 'needs_confirmation') || content.executionSpec?.executionReadiness === 'needs_confirmation') blockers.push({ code: 'TEST_CASE_NOT_READY', message: `用例 ${content.title} 执行配置仍待确认`, subjectId: item.testCase.id })
    const expectedResults = [...content.executionMethods.flatMap(method => [...method.steps.map(step => step.expected), ...method.verificationChecks.map(check => check.description)]), ...content.sharedVerificationChecks.map(check => check.description), ...(content.executionSpec?.kind === 'performance' ? content.executionSpec.thresholds.map(item => item.target) : []), ...(content.executionSpec?.kind === 'stability' ? content.executionSpec.observations : []), ...(content.executionSpec?.kind === 'compatibility' ? [content.executionSpec.expectedConsistency] : [])]
    if (!expectedResults.length || expectedResults.some(value => /(?:TBD|TODO|待确认|未确定|自行判断|按实际情况)/iu.test(value))) blockers.push({ code: 'TEST_CASE_EXPECTED_RESULT_UNCLEAR', message: `用例 ${content.title} 缺少明确且可判定的 Expected Result`, subjectId: item.testCase.id })
    const missingData = content.dataRequirementIds.filter(id => !input.dataSet.requirements.some(requirement => requirement.id === id && requirement.readiness === 'ready'))
    if (missingData.length) blockers.push({ code: 'TEST_CASE_NOT_READY', message: `用例 ${content.title} 的数据需求未就绪`, subjectId: item.testCase.id })
  }
  for (const item of basisItems) {
    const requirementId = String((item.locator as { requirementPointId?: unknown } | undefined)?.requirementPointId ?? item.id)
    if (!coveredRequirements.has(requirementId)) {
      blockers.push({ code: 'COVERAGE_REQUIREMENT_UNCOVERED', message: `Requirement ${requirementId} 没有直接关联的测试用例`, subjectId: requirementId })
      relations.push({ basisRef: item.id, requirementId, status: 'not_covered', reason: '当前没有引用该 Requirement 的测试用例' })
    }
  }
  const duplicateGroups = new Map<string, string[]>()
  for (const item of current) duplicateGroups.set(item.revision.semanticSha256, [...(duplicateGroups.get(item.revision.semanticSha256) ?? []), item.testCase.id])
  for (const caseIds of duplicateGroups.values()) if (caseIds.length > 1) blockers.push({ code: 'TEST_CASE_DUPLICATE', message: `存在 ${caseIds.length} 条语义完全相同的测试用例`, subjectId: caseIds[0] })
  for (const item of input.findings) if (item.state === 'open' && item.severity === 'blocker') blockers.push({ code: 'TEST_DESIGN_FINDING_UNRESOLVED', message: `阻断 Finding ${item.title} 尚未处置`, subjectId: item.id })
  for (const item of input.confirmationItems) if (item.state === 'open' && item.blocker) blockers.push({ code: 'TEST_DESIGN_CONFIRMATION_UNRESOLVED', message: `阻断待确认项 ${item.title} 尚未处置`, subjectId: item.id })
  for (const item of basisItems) {
    const text = String(item.content && typeof item.content === 'object' ? JSON.stringify(item.content) : item.content ?? '')
    const cues = ['正常', '异常', '边界', '权限', '状态'].filter(cue => text.includes(cue)).length
    const requirementId = String((item.locator as { requirementPointId?: unknown } | undefined)?.requirementPointId ?? item.id)
    const linked = current.filter(candidate => (candidate.revision.content.requirementRefs ?? []).some(ref => requirementByRef.get(ref) === requirementId))
    if (cues >= 2 && linked.length === 1 && linked[0].revision.content.objective.length < 80) blockers.push({ code: 'TEST_CASE_COVERAGE_TOO_SHALLOW', message: `Requirement ${requirementId} 同时包含多个测试维度，但只有一条过于宽泛的用例`, subjectId: linked[0].testCase.id })
  }
  const inputSha256 = canonicalSha256({ basisSnapshotSha256: input.basis.snapshotSha256, retrievalSnapshotSha256: input.retrieval.snapshotSha256, historicalSnapshotSha256: input.historical.snapshotSha256, requirementReleaseId: input.basis.requirementReleaseId, caseSetSha256, dataSetVersionId: input.dataSet.id, dataSetSha256: input.dataSet.contentSha256, findingStateSha256: canonicalSha256(input.findings.map(item => ({ id: item.id, state: item.state }))), confirmationStateSha256: canonicalSha256(input.confirmationItems.map(item => ({ id: item.id, state: item.state, actions: item.actions.length }))) })
  return { id: `coverage_audit_${randomUUID()}`, runId: input.runId, requirementReleaseId: input.basis.requirementReleaseId, dataSetVersionId: input.dataSet.id, caseSetSha256, inputSha256, status: 'valid', statistics: { totalBasis: basisItems.length, coveredBasis: basisItems.filter(item => coveredRequirements.has(String((item.locator as { requirementPointId?: unknown } | undefined)?.requirementPointId ?? item.id))).length, totalCases: current.length, approvedCases: current.filter(item => item.testCase.reviewState === 'approved').length }, relations, blockers: blockers.map(item => ({ ...item, resolution: blockerResolution(item.code) })), createdAt: new Date().toISOString() }
}

function blockerResolution(code: string): CoverageAudit['blockers'][number]['resolution'] {
  if (code === 'COVERAGE_REQUIREMENT_UNCOVERED' || code === 'TEST_CASE_DUPLICATE' || code === 'TEST_CASE_COVERAGE_TOO_SHALLOW' || code === 'TEST_CASE_REQUIREMENT_REFERENCE_INVALID') return 'agent_repair'
  if (code === 'TEST_CASE_REVIEW_REQUIRED') return 'human_review'
  if (code === 'TEST_DESIGN_FINDING_UNRESOLVED' || code === 'TEST_DESIGN_CONFIRMATION_UNRESOLVED' || code === 'PLANNING_CLARIFICATION_UNRESOLVED' || code === 'TEST_CASE_NOT_READY' || code === 'TEST_CASE_EXPECTED_RESULT_UNCLEAR') return 'human_decision'
  return 'manual_edit'
}
