import { randomUUID } from 'node:crypto'
import type { ConfirmationItem, CoverageAudit, DesignFinding, HistoricalCaseSnapshot, RetrievalSnapshot, TestCase, TestDataRequirementSetVersion, TestDesignBasisSnapshot, TestPointTreeVersion, TestPointTree } from '../domain/test-design-types.js'
import { canonicalSha256 } from './canonical-json.js'
import { validateCaseDependencyGraph } from './test-design-validation.js'

export function auditTestDesignCoverage(input: { runId: string; basis: TestDesignBasisSnapshot; retrieval: RetrievalSnapshot; historical: HistoricalCaseSnapshot; tree: TestPointTree; treeVersion: TestPointTreeVersion; cases: TestCase[]; dataSet: TestDataRequirementSetVersion; findings: DesignFinding[]; confirmationItems: ConfirmationItem[] }): CoverageAudit {
  const revision = input.tree.revisions.find(item => item.revision === input.treeVersion.revision)
  if (!revision) throw new Error('TEST_POINT_TREE_APPROVAL_REQUIRED: 批准树版本不存在')
  const points = revision.nodes.filter(node => !node.deleted && node.applicability !== 'not_applicable')
  const cases = input.cases.filter(testCase => !testCase.tombstonedAt)
  const current = cases.map(testCase => ({ testCase, revision: testCase.revisions.find(item => item.revision === testCase.currentRevision)! }))
  validateCaseDependencyGraph(current.map(item => ({ id: item.testCase.id, content: item.revision.content })))
  const caseSetSha256 = canonicalSha256(current.map(item => ({ caseId: item.testCase.id, revision: item.revision.revision, contentSha256: item.revision.contentSha256 })).sort((left, right) => left.caseId.localeCompare(right.caseId)))
  const blockers: CoverageAudit['blockers'] = []
  const relations: CoverageAudit['relations'] = []
  const allowedRefs = new Set([...input.basis.items.map(item => item.id), ...input.retrieval.hits.map(item => item.id)])
  const allowedHistoricalRefs = new Set(input.historical.items.map(item => item.id))
  for (const point of points) {
    const invalidRefs = point.basisRefs.filter(reference => !allowedRefs.has(reference))
    if (invalidRefs.length) blockers.push({ code: 'TEST_POINT_BASIS_REFERENCE_INVALID', message: `测试点 ${point.title} 引用了固定输入之外的依据`, subjectId: point.nodeId })
    const invalidHistoricalRefs = point.historicalRefs.filter(reference => !allowedHistoricalRefs.has(reference))
    if (invalidHistoricalRefs.length) blockers.push({ code: 'TEST_POINT_HISTORICAL_REFERENCE_INVALID', message: `测试点 ${point.title} 引用了固定快照之外的历史用例`, subjectId: point.nodeId })
    const pointCases = current.filter(item => item.revision.content.testPointIds.includes(point.nodeId))
    if (!pointCases.length) blockers.push({ code: 'COVERAGE_TEST_POINT_UNCOVERED', message: `测试点 ${point.title} 没有用例`, subjectId: point.nodeId })
    for (const basisRef of point.basisRefs) {
      if (!pointCases.length) relations.push({ basisRef, testPointId: point.nodeId, status: 'not_covered', reason: '当前测试点没有用例' })
      else pointCases.forEach(item => relations.push({ basisRef, testPointId: point.nodeId, caseId: item.testCase.id, status: 'covered', reason: '存在映射到当前测试点的用例' }))
    }
  }
  for (const item of current) {
    if (item.testCase.origin.startsWith('historical_')) {
      const source = input.historical.items.find(candidate => candidate.id === item.testCase.historicalSourceRef)
      if (!source) blockers.push({ code: 'TEST_CASE_HISTORICAL_SOURCE_INVALID', message: `用例 ${item.revision.content.title} 的历史来源不属于当前冻结快照`, subjectId: item.testCase.id })
      else if (item.testCase.origin === 'historical_unchanged' && item.revision.semanticSha256 !== source.contentSha256) blockers.push({ code: 'TEST_CASE_HISTORICAL_REUSE_HASH_MISMATCH', message: `用例 ${item.revision.content.title} 已变化，不能继续标记为原样复用`, subjectId: item.testCase.id })
      else if (item.testCase.origin === 'historical_modified' && item.revision.semanticSha256 === source.contentSha256) blockers.push({ code: 'TEST_CASE_HISTORICAL_REUSE_MODE_INVALID', message: `用例 ${item.revision.content.title} 与历史来源完全一致，不应标记为修改复用`, subjectId: item.testCase.id })
    }
    if (item.testCase.reviewState !== 'approved') blockers.push({ code: 'TEST_CASE_REVIEW_REQUIRED', message: `用例 ${item.revision.content.title} 当前 revision 未批准`, subjectId: item.testCase.id })
    if (item.revision.content.executionMethods.some(method => method.executionReadiness !== 'ready')) blockers.push({ code: 'TEST_CASE_NOT_READY', message: `用例 ${item.revision.content.title} 执行方式未就绪`, subjectId: item.testCase.id })
    const missingData = item.revision.content.dataRequirementIds.filter(id => !input.dataSet.requirements.some(requirement => requirement.id === id && requirement.readiness === 'ready'))
    if (missingData.length) blockers.push({ code: 'TEST_CASE_NOT_READY', message: `用例 ${item.revision.content.title} 的数据需求未就绪`, subjectId: item.testCase.id })
  }
  const duplicateGroups = new Map<string, string[]>()
  for (const item of current) duplicateGroups.set(item.revision.semanticSha256, [...(duplicateGroups.get(item.revision.semanticSha256) ?? []), item.testCase.id])
  for (const caseIds of duplicateGroups.values()) if (caseIds.length > 1) blockers.push({ code: 'TEST_CASE_DUPLICATE', message: `存在 ${caseIds.length} 条语义完全相同的测试用例`, subjectId: caseIds[0] })
  for (const finding of input.findings) if (finding.state === 'open') blockers.push({ code: 'TEST_DESIGN_FINDING_UNRESOLVED', message: `Finding ${finding.title} 尚未处置`, subjectId: finding.id })
  for (const item of input.confirmationItems) if (item.state === 'open') blockers.push({ code: 'TEST_DESIGN_CONFIRMATION_UNRESOLVED', message: `待确认项 ${item.title} 尚未处置`, subjectId: item.id })
  const basisRefs = new Set(input.basis.items.filter(item => item.locator?.coverageTarget !== false).map(item => item.id))
  const referencedBasis = new Set(points.flatMap(point => point.basisRefs))
  for (const basisRef of basisRefs) if (!referencedBasis.has(basisRef)) blockers.push({ code: 'COVERAGE_BASIS_UNCOVERED', message: `固定依据 ${basisRef} 未映射测试点`, subjectId: basisRef })
  const inputSha256 = canonicalSha256({ basisSnapshotSha256: input.basis.snapshotSha256, retrievalSnapshotSha256: input.retrieval.snapshotSha256, historicalSnapshotSha256: input.historical.snapshotSha256, treeVersionId: input.treeVersion.id, treeSha256: input.treeVersion.treeSha256, caseSetSha256, dataSetVersionId: input.dataSet.id, dataSetSha256: input.dataSet.contentSha256, findingStateSha256: canonicalSha256(input.findings.map(item => ({ id: item.id, state: item.state, actions: item.actions.length }))), confirmationStateSha256: canonicalSha256(input.confirmationItems.map(item => ({ id: item.id, state: item.state, actions: item.actions.length }))) })
  return {
    id: `coverage_audit_${randomUUID()}`, runId: input.runId, treeVersionId: input.treeVersion.id, dataSetVersionId: input.dataSet.id, caseSetSha256, inputSha256, status: 'valid',
    statistics: { totalBasis: basisRefs.size, coveredBasis: [...basisRefs].filter(item => referencedBasis.has(item)).length, totalPoints: points.length, coveredPoints: points.filter(point => current.some(item => item.revision.content.testPointIds.includes(point.nodeId))).length, totalCases: current.length, approvedCases: current.filter(item => item.testCase.reviewState === 'approved').length },
    relations, blockers, createdAt: new Date().toISOString(),
  }
}
