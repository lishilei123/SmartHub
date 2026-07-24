import type { ReviewRunSnapshot } from '../domain/agent-types.js'
import type { CandidateReviewResult, ValidationIssue, ValidationReport } from '../domain/review-types.js'
import type { StateStore } from '../infrastructure/store.js'

const assessments = new Set(['pass', 'pass_with_notes', 'needs_revision', 'blocked'])
const findingTypes = new Set(['missing_requirement', 'ambiguity', 'conflict', 'boundary_gap', 'state_gap', 'exception_gap', 'security_risk', 'testability_gap', 'dependency_risk', 'other'])
const severities = new Set(['critical', 'high', 'medium', 'low', 'info'])

export class ReviewResultValidator {
  constructor(private readonly store: StateStore) {}

  async validate(input: CandidateReviewResult, snapshot: ReviewRunSnapshot): Promise<ValidationReport> {
    const issues: ValidationIssue[] = []
    if (!input || typeof input !== 'object') return { valid: false, issues: [{ path: '$', message: '结果必须是对象' }] }
    if (!assessments.has(input.summary?.overallAssessment)) issues.push(issue('summary.overallAssessment', '总体结论不合法'))
    if (!Number.isFinite(input.summary?.score) || input.summary.score < 0 || input.summary.score > 100) issues.push(issue('summary.score', '评分必须为 0～100'))
    for (const key of ['strengths', 'risks'] as const) if (!isStrings(input.summary?.[key])) issues.push(issue(`summary.${key}`, '必须是字符串数组'))
    if (!Array.isArray(input.requirementPoints)) issues.push(issue('requirementPoints', '必须是数组'))
    if (!Array.isArray(input.findings)) issues.push(issue('findings', '必须是数组'))
    if (!Array.isArray(input.evidence)) issues.push(issue('evidence', '必须是数组'))
    if (!input.coverage || !isStrings(input.coverage.reviewedAreas) || !isStrings(input.coverage.notReviewedAreas) || !isStrings(input.coverage.limitations)) issues.push(issue('coverage', '覆盖范围结构不合法'))
    if (issues.length) return { valid: false, issues }

    const evidenceIds = new Set<string>()
    const evidenceById = new Map<string, CandidateReviewResult['evidence'][number]>()
    const state = await this.store.snapshot()
    const index = state.indexes.find(item => item.id === snapshot.indexVersionId && item.knowledgeBaseId === snapshot.knowledgeBaseId)
    const allowedChunks = new Map((index?.indexedChunks ?? []).map(chunk => [chunk.id, chunk]))
    const allowedAssetVersionIds = new Set(snapshot.assets.map(asset => asset.assetVersionId))
    input.evidence.forEach((evidence, position) => {
      const path = `evidence[${position}]`
      if (!evidence.clientEvidenceId || evidenceIds.has(evidence.clientEvidenceId)) issues.push(issue(`${path}.clientEvidenceId`, '证据 ID 为空或重复'))
      evidenceIds.add(evidence.clientEvidenceId)
      evidenceById.set(evidence.clientEvidenceId, evidence)
      const chunk = allowedChunks.get(evidence.sourceRef?.chunkId)
      if (!chunk || chunk.assetVersionId !== evidence.sourceRef?.assetVersionId || !allowedAssetVersionIds.has(evidence.sourceRef.assetVersionId)) issues.push(issue(`${path}.sourceRef`, '证据不属于本次运行固定的输入文档'))
      const quote = evidence.quote?.trim()
      const quoteOffset = quote && chunk ? chunk.content.indexOf(quote) : -1
      if (!quote || quoteOffset < 0) issues.push(issue(`${path}.quote`, '引用摘录无法在固定 Chunk 中定位'))
      const expectedStart = chunk && quoteOffset >= 0 ? chunk.startChar + quoteOffset : undefined
      const expectedEnd = expectedStart === undefined || !quote ? undefined : expectedStart + quote.length
      const expectedHeading = chunk?.headingPath.at(-1) ?? ''
      if (!Number.isInteger(evidence.locator?.start) || !Number.isInteger(evidence.locator?.end) || evidence.locator.start < 0 || evidence.locator.end < evidence.locator.start) issues.push(issue(`${path}.locator`, '证据定位范围不合法'))
      else if (expectedStart !== undefined && (evidence.locator.start !== expectedStart || evidence.locator.end !== expectedEnd || evidence.locator.heading !== expectedHeading)) issues.push(issue(`${path}.locator`, '证据定位必须与固定 Chunk 中引用原文的标题和字符范围一致'))
    })

    const requirementPointIds = new Set<string>()
    const pointEvidenceRefs = new Map<string, Set<string>>()
    const referencedEvidenceIds = new Set<string>()
    input.requirementPoints.forEach((point, position) => {
      const path = `requirementPoints[${position}]`
      const pointRefs = isStrings(point.evidenceRefs) ? point.evidenceRefs : []
      if (!point.clientRequirementPointId || requirementPointIds.has(point.clientRequirementPointId)) issues.push(issue(`${path}.clientRequirementPointId`, '需求点 ID 为空或重复'))
      requirementPointIds.add(point.clientRequirementPointId)
      pointEvidenceRefs.set(point.clientRequirementPointId, new Set(pointRefs))
      pointRefs.forEach(reference => referencedEvidenceIds.add(reference))
      for (const key of ['title', 'description'] as const) if (!point[key]?.trim()) issues.push(issue(`${path}.${key}`, '字段不能为空'))
      if (!isStrings(point.evidenceRefs) || !pointRefs.length || pointRefs.some(reference => !evidenceIds.has(reference))) issues.push(issue(`${path}.evidenceRefs`, '需求点至少需要一条有效固定证据'))
    })
    snapshot.assets.forEach((asset, position) => {
      const covered = [...referencedEvidenceIds].some(reference => evidenceById.get(reference)?.sourceRef.assetVersionId === asset.assetVersionId)
      if (!covered) issues.push(issue(`coverage.assets[${position}]`, `输入文档 ${asset.logicalPath} 缺少被需求点引用的固定证据`))
    })

    const findingIds = new Set<string>()
    if (input.findings.length > snapshot.agentDefinition.limits.maxFindings) issues.push(issue('findings', 'Finding 数量超过执行限制'))
    input.findings.forEach((finding, position) => {
      const path = `findings[${position}]`
      const requirementRefs = isStrings(finding.requirementPointRefs) ? finding.requirementPointRefs : []
      const findingEvidenceRefs = isStrings(finding.evidenceRefs) ? finding.evidenceRefs : []
      if (!finding.clientFindingId || findingIds.has(finding.clientFindingId)) issues.push(issue(`${path}.clientFindingId`, 'Finding ID 为空或重复'))
      findingIds.add(finding.clientFindingId)
      if (!findingTypes.has(finding.type)) issues.push(issue(`${path}.type`, 'Finding 类型不合法'))
      if (!severities.has(finding.severity)) issues.push(issue(`${path}.severity`, '严重度不合法'))
      if (!Number.isFinite(finding.confidence) || finding.confidence < 0 || finding.confidence > 1) issues.push(issue(`${path}.confidence`, '置信度必须为 0～1'))
      for (const key of ['title', 'description', 'impact', 'recommendation'] as const) if (!finding[key]?.trim()) issues.push(issue(`${path}.${key}`, '字段不能为空'))
      if (!isStrings(finding.requirementPointRefs) || !requirementRefs.length || requirementRefs.some(reference => !requirementPointIds.has(reference))) issues.push(issue(`${path}.requirementPointRefs`, 'Finding 至少需要关联一个有效需求点'))
      if (!isStrings(finding.evidenceRefs) || findingEvidenceRefs.some(reference => !evidenceIds.has(reference))) issues.push(issue(`${path}.evidenceRefs`, '包含无效证据引用'))
      const linkedPointEvidence = new Set(requirementRefs.flatMap(reference => [...(pointEvidenceRefs.get(reference) ?? [])]))
      if (findingEvidenceRefs.some(reference => !linkedPointEvidence.has(reference))) issues.push(issue(`${path}.evidenceRefs`, 'Finding 证据必须来自其关联需求点'))
      if (['critical', 'high'].includes(finding.severity) && !findingEvidenceRefs.length) issues.push(issue(`${path}.evidenceRefs`, 'critical/high Finding 至少需要一条证据'))
    })
    return { valid: issues.length === 0, issues }
  }
}

function issue(path: string, message: string): ValidationIssue { return { path, message } }
function isStrings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string') }
