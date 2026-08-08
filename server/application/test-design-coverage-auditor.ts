import { randomUUID } from 'node:crypto'
import type { CoverageAudit, TestCase, TestDataRequirementSetVersion, TestDesignBasisSnapshot, TestPointTreeVersion, TestPointTree } from '../domain/test-design-types.js'
import { canonicalSha256 } from './canonical-json.js'
import { validateCaseDependencyGraph } from './test-design-validation.js'

export function auditTestDesignCoverage(input: { runId: string; basis: TestDesignBasisSnapshot; tree: TestPointTree; treeVersion: TestPointTreeVersion; cases: TestCase[]; dataSet: TestDataRequirementSetVersion }): CoverageAudit {
  const revision = input.tree.revisions.find(item => item.revision === input.treeVersion.revision)
  if (!revision) throw new Error('TEST_POINT_TREE_APPROVAL_REQUIRED: 批准树版本不存在')
  const points = revision.nodes.filter(node => !node.deleted && node.applicability !== 'not_applicable')
  const cases = input.cases.filter(testCase => !testCase.tombstonedAt)
  const current = cases.map(testCase => ({ testCase, revision: testCase.revisions.find(item => item.revision === testCase.currentRevision)! }))
  validateCaseDependencyGraph(current.map(item => ({ id: item.testCase.id, content: item.revision.content })))
  const caseSetSha256 = canonicalSha256(current.map(item => ({ caseId: item.testCase.id, revision: item.revision.revision, contentSha256: item.revision.contentSha256 })).sort((left, right) => left.caseId.localeCompare(right.caseId)))
  const blockers: CoverageAudit['blockers'] = []
  const relations: CoverageAudit['relations'] = []
  for (const point of points) {
    const pointCases = current.filter(item => item.revision.content.testPointIds.includes(point.nodeId))
    if (!pointCases.length) blockers.push({ code: 'COVERAGE_TEST_POINT_UNCOVERED', message: `测试点 ${point.title} 没有用例`, subjectId: point.nodeId })
    for (const basisRef of point.basisRefs) relations.push({ basisRef, testPointId: point.nodeId, ...(pointCases[0] ? { caseId: pointCases[0].testCase.id } : {}), status: pointCases.length ? 'covered' : 'not_covered', reason: pointCases.length ? '存在映射到当前测试点的用例' : '当前测试点没有用例' })
  }
  for (const item of current) {
    if (item.testCase.reviewState !== 'approved') blockers.push({ code: 'TEST_CASE_REVIEW_REQUIRED', message: `用例 ${item.revision.content.title} 当前 revision 未批准`, subjectId: item.testCase.id })
    if (item.revision.content.executionMethods.some(method => method.executionReadiness !== 'ready')) blockers.push({ code: 'TEST_CASE_NOT_READY', message: `用例 ${item.revision.content.title} 执行方式未就绪`, subjectId: item.testCase.id })
    const missingData = item.revision.content.dataRequirementIds.filter(id => !input.dataSet.requirements.some(requirement => requirement.id === id && requirement.readiness === 'ready'))
    if (missingData.length) blockers.push({ code: 'TEST_CASE_NOT_READY', message: `用例 ${item.revision.content.title} 的数据需求未就绪`, subjectId: item.testCase.id })
  }
  const basisRefs = new Set(input.basis.items.map(item => item.id))
  const referencedBasis = new Set(points.flatMap(point => point.basisRefs))
  for (const basisRef of basisRefs) if (!referencedBasis.has(basisRef)) blockers.push({ code: 'COVERAGE_BASIS_UNCOVERED', message: `固定依据 ${basisRef} 未映射测试点`, subjectId: basisRef })
  const inputSha256 = canonicalSha256({ basisSnapshotSha256: input.basis.snapshotSha256, treeVersionId: input.treeVersion.id, treeSha256: input.treeVersion.treeSha256, caseSetSha256, dataSetVersionId: input.dataSet.id, dataSetSha256: input.dataSet.contentSha256 })
  return {
    id: `coverage_audit_${randomUUID()}`, runId: input.runId, treeVersionId: input.treeVersion.id, dataSetVersionId: input.dataSet.id, caseSetSha256, inputSha256, status: 'valid',
    statistics: { totalBasis: basisRefs.size, coveredBasis: [...basisRefs].filter(item => referencedBasis.has(item)).length, totalPoints: points.length, coveredPoints: points.filter(point => current.some(item => item.revision.content.testPointIds.includes(point.nodeId))).length, totalCases: current.length, approvedCases: current.filter(item => item.testCase.reviewState === 'approved').length },
    relations, blockers, createdAt: new Date().toISOString(),
  }
}
