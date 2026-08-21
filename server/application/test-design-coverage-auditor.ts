import { randomUUID } from 'node:crypto'
import type { ConfirmationItem, CoverageAudit, DimensionAssessment, HistoricalCaseSnapshot, RetrievalSnapshot, ScenarioClaim, TestCase, TestDataRequirementSetVersion, TestDesignBasisSnapshot } from '../domain/test-design-types.js'
import { canonicalSha256 } from './canonical-json.js'
import { validateCaseDependencyGraph } from './test-design-validation.js'

/** Direct Requirement Release -> TestCase coverage audit. */
export function auditTestDesignCoverage(input: {
  runId: string
  basis: TestDesignBasisSnapshot
  retrieval: RetrievalSnapshot
  historical: HistoricalCaseSnapshot
  cases: TestCase[]
  /** Candidate-only PlanningAgent assessment for all five dimensions. */
  dimensionAssessments?: DimensionAssessment[]
  /** Candidate-only metadata; it never becomes a formal TestCase asset. */
  scenarioClaims: ScenarioClaim[]
  dataSet: TestDataRequirementSetVersion
  findings: Array<{ id: string; title: string; severity: string; state: string }>
  confirmationItems: ConfirmationItem[]
}): CoverageAudit {
  const basisItems = input.basis.content.requirements.filter(item => item.coverageTarget)
  const requirementByRef = new Map<string, string>()
  for (const item of basisItems) {
    const requirementId = item.clientRequirementPointId.trim()
    requirementByRef.set(requirementId, requirementId)
  }
  const cases = input.cases.filter(item => !item.tombstonedAt)
  const current = cases.map(testCase => ({ testCase, revision: testCase.revisions.find(item => item.revision === testCase.currentRevision)! }))
  validateCaseDependencyGraph(current.map(item => ({ id: item.testCase.id, content: item.revision.content })))
  const caseIdByCandidateRef = new Map(current.flatMap(item => item.testCase.candidateRef ? [[item.testCase.candidateRef, item.testCase.id] as const] : []))
  const claimsByCaseId = new Map<string, ScenarioClaim[]>()
  for (const claim of input.scenarioClaims) {
    const caseId = caseIdByCandidateRef.get(claim.caseRef)
    if (!caseId) continue
    claimsByCaseId.set(caseId, [...(claimsByCaseId.get(caseId) ?? []), claim])
  }
  const caseSetSha256 = canonicalSha256(current.map(item => ({ caseId: item.testCase.id, revision: item.revision.revision, contentSha256: item.revision.contentSha256 })).sort((left, right) => left.caseId.localeCompare(right.caseId)))
  const blockers: Array<Omit<CoverageAudit['blockers'][number], 'resolution'>> = []
  const advisories: CoverageAudit['advisories'] = []
  const relations: CoverageAudit['relations'] = []
  const coveredRequirements = new Set<string>()
  for (const clarification of input.basis.content.clarifications) if (clarification.blocking && clarification.status === 'pending') blockers.push({ code: 'PLANNING_CLARIFICATION_UNRESOLVED', message: `阻断问题 ${clarification.question} 尚未获得正式回答`, subjectId: clarification.id })
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
    if (content.executionMethods.some(method => method.steps.length === 0) && content.dimension === 'functional') blockers.push({ code: 'TEST_CASE_EXECUTION_METHOD_INCOMPLETE', message: `用例 ${content.title} 缺少可执行步骤`, subjectId: item.testCase.id })
    if (content.executionMethods.some(method => method.executionReadiness === 'needs_confirmation') || content.executionSpec?.executionReadiness === 'needs_confirmation') blockers.push({ code: 'TEST_CASE_NOT_READY', message: `用例 ${content.title} 执行配置仍待确认`, subjectId: item.testCase.id })
    const claims = claimsByCaseId.get(item.testCase.id) ?? []
    if (content.dimension === 'functional' || content.dimension === 'security') {
      if (!claims.length || claims.some(claim => semanticOracleUnclear(claim.oracle))) blockers.push({ code: 'TEST_CASE_EXPECTED_RESULT_UNCLEAR', message: `用例 ${content.title} 缺少明确且可判定的 ScenarioClaim.oracle`, subjectId: item.testCase.id })
    } else {
      const expectedResults = [...content.executionMethods.flatMap(method => [...method.steps.map(step => step.expected), ...method.verificationChecks.map(check => check.description)]), ...content.sharedVerificationChecks.map(check => check.description), ...(content.executionSpec?.kind === 'performance' ? content.executionSpec.thresholds.map(item => item.target) : []), ...(content.executionSpec?.kind === 'stability' ? content.executionSpec.observations : []), ...(content.executionSpec?.kind === 'compatibility' ? [content.executionSpec.expectedConsistency] : [])]
      if (!expectedResults.length || expectedResults.some(semanticOracleUnclear)) blockers.push({ code: 'TEST_CASE_EXPECTED_RESULT_UNCLEAR', message: `用例 ${content.title} 缺少明确且可判定的 Expected Result`, subjectId: item.testCase.id })
    }
    const missingData = content.dataRequirementIds.filter(id => !input.dataSet.requirements.some(requirement => requirement.id === id && requirement.readiness === 'ready'))
    if (missingData.length) blockers.push({ code: 'TEST_CASE_NOT_READY', message: `用例 ${content.title} 的数据需求未就绪`, subjectId: item.testCase.id })
  }
  // Legacy Runs have no candidate-only assessment map. Preserve their prior
  // audit projection unchanged; current submit tools always provide it.
  const dimensionAssessments = input.dimensionAssessments ?? []
  if (dimensionAssessments.length) {
    const assessmentByDimension = new Map(dimensionAssessments.map(item => [item.dimension, item]))
    for (const dimension of ['functional', 'performance', 'stability', 'compatibility', 'security'] as const) {
    const assessment = assessmentByDimension.get(dimension)
    if (!assessment) {
      advisories.push({ code: 'COVERAGE_DIMENSION_ASSESSMENT_MISSING', message: `历史候选缺少 ${dimension} 维度适用性分析；重新生成时应补充完整五维评估`, subjectId: dimension })
      continue
    }
    const invalidEvidence = assessment.requirementRefs.filter(ref => !requirementByRef.has(ref))
    if (invalidEvidence.length) blockers.push({ code: 'COVERAGE_DIMENSION_EVIDENCE_INVALID', message: `${dimension} 维度适用性判断引用了当前 Requirement Release 之外的依据`, subjectId: dimension })
    if (!assessment.applicable) continue
    const linked = current.filter(item => item.revision.content.dimension === dimension)
    if (!linked.length) {
      blockers.push({ code: 'COVERAGE_DIMENSION_UNCOVERED', message: `适用的 ${dimension} 测试维度尚未生成对应测试用例`, subjectId: dimension })
      continue
    }
    if (assessment.risks.length && assessment.scenarioClaims.length && linked.length === 1) advisories.push({
      code: 'COVERAGE_SCENARIO_FAMILY_REVIEW_REQUIRED',
      message: `${dimension} 维度识别到 ${assessment.scenarioClaims.length} 个场景族和 ${assessment.risks.length} 项风险；请确认单条用例是否足以覆盖这些独立风险`,
      subjectId: linked[0].testCase.id,
      details: { reasons: [...assessment.risks], scenarioRefs: [...assessment.scenarioClaims] },
    })
    }
  }
  for (const item of basisItems) {
    const requirementId = item.clientRequirementPointId
    if (!coveredRequirements.has(requirementId)) {
      blockers.push({ code: 'COVERAGE_REQUIREMENT_UNCOVERED', message: `Requirement ${requirementId} 没有直接关联的测试用例`, subjectId: requirementId })
      relations.push({ basisRef: requirementId, requirementId, status: 'not_covered', reason: '当前没有引用该 Requirement 的测试用例' })
    }
  }
  const duplicateGroups = new Map<string, string[]>()
  for (const item of current) duplicateGroups.set(item.revision.semanticSha256, [...(duplicateGroups.get(item.revision.semanticSha256) ?? []), item.testCase.id])
  for (const caseIds of duplicateGroups.values()) if (caseIds.length > 1) blockers.push({ code: 'TEST_CASE_DUPLICATE', message: `存在 ${caseIds.length} 条语义完全相同的测试用例`, subjectId: caseIds[0] })
  for (const item of input.findings) if (item.state === 'open' && item.severity === 'blocker') blockers.push({ code: 'TEST_DESIGN_FINDING_UNRESOLVED', message: `阻断 Finding ${item.title} 尚未处置`, subjectId: item.id })
  for (const item of input.confirmationItems) if (item.impactStage !== 'handoff' && item.state === 'open' && item.blocker) blockers.push({ code: 'TEST_DESIGN_CONFIRMATION_UNRESOLVED', message: `阻断待确认项 ${item.title} 尚未处置`, subjectId: item.id })
  for (const item of basisItems) {
    const text = JSON.stringify(item)
    const cues = ['正常', '异常', '边界', '权限', '状态'].filter(cue => text.includes(cue)).length
    const requirementId = item.clientRequirementPointId
    const linked = current.filter(candidate => (candidate.revision.content.requirementRefs ?? []).some(ref => requirementByRef.get(ref) === requirementId))
    if (cues >= 2 && linked.length === 1 && linked[0].revision.content.objective.length < 80) blockers.push({ code: 'TEST_CASE_COVERAGE_TOO_SHALLOW', message: `Requirement ${requirementId} 同时包含多个测试维度，但只有一条过于宽泛的用例`, subjectId: linked[0].testCase.id })
  }

  for (const item of current) {
    const claims = claimsByCaseId.get(item.testCase.id) ?? []
    const atomicity = atomicityBlocker(item.testCase.id, item.revision.content.title, claims)
    if (!atomicity) continue
    blockers.push(atomicity)
    for (const relation of relations) if (relation.caseId === item.testCase.id && relation.status === 'covered') {
      relation.status = 'partially_covered'
      relation.reason = 'Case 仍可直接追溯 Requirement，但 Scenario / Atomicity Audit 发现多个独立测试意图'
    }
  }

  const fullyCoveredRequirements = new Set(relations.filter(item => item.status === 'covered').map(item => item.requirementId))
  const inputSha256 = canonicalSha256({ basisSnapshotSha256: input.basis.snapshotSha256, retrievalSnapshotSha256: input.retrieval.snapshotSha256, historicalSnapshotSha256: input.historical.snapshotSha256, requirementReleaseId: input.basis.requirementReleaseId, caseSetSha256, dimensionAssessmentsSha256: canonicalSha256([...dimensionAssessments].sort((left, right) => left.dimension.localeCompare(right.dimension))), scenarioClaimsSha256: canonicalSha256([...input.scenarioClaims].sort((left, right) => left.ref.localeCompare(right.ref))), dataSetVersionId: input.dataSet.id, dataSetSha256: input.dataSet.contentSha256, findingStateSha256: canonicalSha256(input.findings.map(item => ({ id: item.id, state: item.state }))), confirmationStateSha256: canonicalSha256(input.confirmationItems.map(item => ({ id: item.id, impactStage: item.impactStage, state: item.state, actions: item.actions.length }))) })
  return { id: `coverage_audit_${randomUUID()}`, runId: input.runId, requirementReleaseId: input.basis.requirementReleaseId, dataSetVersionId: input.dataSet.id, caseSetSha256, inputSha256, status: 'valid', statistics: { totalBasis: basisItems.length, coveredBasis: basisItems.filter(item => fullyCoveredRequirements.has(item.clientRequirementPointId)).length, totalCases: current.length }, relations, blockers: blockers.map(item => ({ ...item, resolution: blockerResolution(item.code) })), advisories, createdAt: new Date().toISOString() }
}

function atomicityBlocker(caseId: string, title: string, claims: ScenarioClaim[]): Omit<CoverageAudit['blockers'][number], 'resolution'> | undefined {
  const sameEnumSubject = claims.every(claim => claim.kind === 'enum' && claim.subject === claims[0]?.subject)
  const allowedAggregate = claims.every(claim => claim.kind === 'crud_lifecycle' || claim.kind === 'cross_channel_consistency') || sameEnumSubject
  if (allowedAggregate) return undefined
  const independent = claims
  const reasons = new Set<string>()
  const stateTransitions = new Set(independent.filter(claim => claim.kind === 'state_transition').map(claim => `${claim.transition?.from ?? claim.variant}\u0000${claim.transition?.to ?? claim.variant}`))
  if (stateTransitions.size > 1) reasons.add('multiple_state_transitions')
  const polarities = new Set(independent.map(claim => claim.polarity))
  if (polarities.has('positive') && polarities.has('negative')) reasons.add('mixed_positive_negative')
  const subjects = new Set(independent.map(claim => claim.subject))
  if (subjects.size > 1) reasons.add('multiple_independent_subjects')
  const queryIntents = new Set(independent.filter(claim => claim.kind === 'filter' || claim.kind === 'search').map(claim => `${claim.kind}:${claim.subject}`))
  if (queryIntents.size > 1) reasons.add('multiple_query_intents')
  const oracles = new Set(independent.map(claim => normalizeOracle(claim.oracle)))
  if (oracles.size > 1) reasons.add('multiple_independent_oracles')
  if (!reasons.size) return undefined
  return {
    code: 'TEST_CASE_OVER_MERGED',
    message: `用例 ${title} 包含 ${claims.length} 个可独立判定的测试意图，必须按 Atomic Test Intent 拆分`,
    subjectId: caseId,
    details: { scenarioRefs: claims.map(claim => claim.ref), reasons: [...reasons].sort(), suggestedSplitCount: Math.max(2, independent.length) },
  }
}

function normalizeOracle(value: string) { return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN') }
function semanticOracleUnclear(value: string) {
  const normalized = normalizeOracle(value).replace(/[。；，,.!！?？]/gu, '')
  return !normalized
    // `todo` is a valid product state in the current MiniTask Requirement. Keep
    // placeholder markers explicit rather than treating every lower-case state
    // occurrence as an unresolved semantic oracle.
    || /(?:\bTBD\b|\bTODO\b|待确认|未确定|自行判断|按实际情况)/u.test(value)
    || ['获得可观察结果', '功能可用', '查询成功'].includes(normalized)
}

function blockerResolution(code: string): CoverageAudit['blockers'][number]['resolution'] {
  if (code === 'COVERAGE_REQUIREMENT_UNCOVERED' || code === 'COVERAGE_DIMENSION_UNCOVERED' || code === 'TEST_CASE_DUPLICATE' || code === 'TEST_CASE_COVERAGE_TOO_SHALLOW' || code === 'TEST_CASE_REQUIREMENT_REFERENCE_INVALID' || code === 'TEST_CASE_OVER_MERGED') return 'agent_repair'
  if (code === 'TEST_CASE_NOT_READY') return 'execution_handoff'
  if (code === 'TEST_DESIGN_FINDING_UNRESOLVED' || code === 'TEST_DESIGN_CONFIRMATION_UNRESOLVED' || code === 'PLANNING_CLARIFICATION_UNRESOLVED' || code === 'TEST_CASE_EXPECTED_RESULT_UNCLEAR') return 'human_decision'
  return 'manual_edit'
}
