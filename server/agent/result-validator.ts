import type { ReviewRunSnapshot } from '../domain/agent-types.js'
import type { CandidateRequirementPointExtraction, CandidateRequirementReview, CandidateReviewResult, ValidationIssue, ValidationReport } from '../domain/review-types.js'
import type { StateStore } from '../infrastructure/store.js'

const assessments = new Set(['pass', 'pass_with_notes', 'needs_revision', 'blocked'])
const findingTypes = new Set(['missing_requirement', 'ambiguity', 'conflict', 'boundary_gap', 'state_gap', 'exception_gap', 'security_risk', 'testability_gap', 'dependency_risk', 'other'])
const severities = new Set(['critical', 'high', 'medium', 'low', 'info'])

export interface ObservedAssetOutlinePage {
  offset: number
  count: number
  total: number
  hasMore: boolean
}

export class RequirementPointExtractionValidator {
  constructor(private readonly store: StateStore) {}

  async validate(
    input: CandidateRequirementPointExtraction,
    snapshot: ReviewRunSnapshot,
    observedReadChunkIds?: ReadonlySet<string>,
    observedOutlinePages?: ReadonlyMap<string, readonly ObservedAssetOutlinePage[]>
  ): Promise<ValidationReport> {
    const issues: ValidationIssue[] = []
    if (!input || typeof input !== 'object') return invalid('$', '结果必须是对象')
    if (!Array.isArray(input.requirementPoints)) issues.push(issue('requirementPoints', '必须是数组'))
    if (!Array.isArray(input.evidence)) issues.push(issue('evidence', '必须是数组'))
    if (!input.coverage || !Array.isArray(input.coverage.assets) || !isStrings(input.coverage.limitations)) issues.push(issue('coverage', '覆盖范围结构不合法'))
    if ('findings' in input || 'summary' in input || 'score' in input) issues.push(issue('$', '需求点提取结果不得包含 Finding、评分或评审结论'))
    if (issues.length) return { valid: false, issues }

    const state = await this.store.snapshot()
    const index = state.indexes.find(item => item.id === snapshot.indexVersionId && item.knowledgeBaseId === snapshot.knowledgeBaseId)
    const allowedChunks = new Map((index?.indexedChunks ?? []).map(chunk => [chunk.id, chunk]))
    const allowedAssetVersionIds = new Set(snapshot.assets.map(asset => asset.assetVersionId))
    const evidenceIds = new Set<string>()
    const evidenceById = new Map<string, CandidateRequirementPointExtraction['evidence'][number]>()
    input.evidence.forEach((evidence, position) => {
      const path = `evidence[${position}]`
      if (!evidence.clientEvidenceId || evidenceIds.has(evidence.clientEvidenceId)) issues.push(issue(`${path}.clientEvidenceId`, '证据 ID 为空或重复'))
      evidenceIds.add(evidence.clientEvidenceId)
      evidenceById.set(evidence.clientEvidenceId, evidence)
      const chunk = allowedChunks.get(evidence.sourceRef?.chunkId)
      if (!chunk || chunk.assetVersionId !== evidence.sourceRef?.assetVersionId || !allowedAssetVersionIds.has(evidence.sourceRef.assetVersionId)) issues.push(issue(`${path}.sourceRef`, '证据不属于本次运行固定的输入文档'))
      else if (observedReadChunkIds && !observedReadChunkIds.has(chunk.id)) issues.push(issue(`${path}.sourceRef`, '证据来源 Chunk 未被运行时读取，不能作为固定证据'))
      const quote = evidence.quote?.trim()
      const quoteOffset = quote && chunk ? chunk.content.indexOf(quote) : -1
      if (!quote || quote.length < 4 || quoteOffset < 0) issues.push(issue(`${path}.quote`, '引用摘录必须至少包含 4 个字符且能在固定 Chunk 中定位'))
      const expectedStart = chunk && quoteOffset >= 0 ? chunk.startChar + quoteOffset : undefined
      const expectedEnd = expectedStart === undefined || !quote ? undefined : expectedStart + quote.length
      const expectedHeading = chunk?.headingPath.at(-1) ?? ''
      if (!Number.isInteger(evidence.locator?.start) || !Number.isInteger(evidence.locator?.end) || evidence.locator.start < 0 || evidence.locator.end < evidence.locator.start) issues.push(issue(`${path}.locator`, '证据定位范围不合法'))
      else if (expectedStart !== undefined && (evidence.locator.start !== expectedStart || evidence.locator.end !== expectedEnd || evidence.locator.heading !== expectedHeading)) issues.push(issue(`${path}.locator`, '证据定位必须与固定 Chunk 中引用原文的标题和字符范围一致'))
    })

    validateCoverage(input, snapshot, issues, observedReadChunkIds)
    validateOutlineCoverage(snapshot, issues, observedOutlinePages)

    const requirementPointIds = new Set<string>()
    const referencedEvidenceIds = new Set<string>()
    const duplicateKeys = new Map<string, number[]>()
    input.requirementPoints.forEach((point, position) => {
      const path = `requirementPoints[${position}]`
      const pointRefs = isStrings(point.evidenceRefs) ? point.evidenceRefs : []
      if (!point.clientRequirementPointId || requirementPointIds.has(point.clientRequirementPointId)) issues.push(issue(`${path}.clientRequirementPointId`, '需求点 ID 为空或重复'))
      requirementPointIds.add(point.clientRequirementPointId)
      pointRefs.forEach(reference => referencedEvidenceIds.add(reference))
      for (const key of ['title', 'description'] as const) if (!point[key]?.trim()) issues.push(issue(`${path}.${key}`, '字段不能为空'))
      for (const key of ['conditions', 'businessRules', 'exceptions', 'acceptanceCriteria'] as const) if (!isStrings(point[key])) issues.push(issue(`${path}.${key}`, '必须是字符串数组'))
      if (!point.action?.trim() && !point.businessRules?.length && !point.acceptanceCriteria?.length) issues.push(issue(`${path}.action`, '需求点至少需要动作、业务规则或验收标准之一'))
      if (!isStrings(point.evidenceRefs) || !pointRefs.length || pointRefs.some(reference => !evidenceIds.has(reference))) issues.push(issue(`${path}.evidenceRefs`, '需求点至少需要一条有效固定证据'))
      if ((point.mergeGroupId && !point.mergeRationale?.trim()) || (!point.mergeGroupId && point.mergeRationale?.trim())) issues.push(issue(`${path}.merge`, '归并组与归并理由必须同时提供或同时省略'))
      const key = normalizedPointKey(point)
      if (key) duplicateKeys.set(key, [...(duplicateKeys.get(key) ?? []), position])
    })
    duplicateKeys.forEach(positions => {
      if (positions.length < 2) return
      const points = positions.map(position => input.requirementPoints[position])
      const group = points[0].mergeGroupId
      if (!group || points.some(point => point.mergeGroupId !== group || !point.mergeRationale?.trim())) issues.push(issue(`requirementPoints[${positions.join(',')}].mergeGroupId`, '主体、动作和对象相同的重复需求点必须显式归并并说明理由'))
    })
    snapshot.assets.forEach((asset, position) => {
      const covered = [...referencedEvidenceIds].some(reference => evidenceById.get(reference)?.sourceRef.assetVersionId === asset.assetVersionId)
      if (!covered) issues.push(issue(`requirementPoints`, `输入文档 ${asset.logicalPath} 缺少被需求点引用的固定证据`))
    })
    return { valid: issues.length === 0, issues }
  }
}

function validateCoverage(input: CandidateRequirementPointExtraction, snapshot: ReviewRunSnapshot, issues: ValidationIssue[], observedReadChunkIds?: ReadonlySet<string>) {
  const coverageByAsset = new Map(input.coverage.assets.map(asset => [asset.assetVersionId, asset]))
  if (coverageByAsset.size !== input.coverage.assets.length) issues.push(issue('coverage.assets', '每个资产版本只能提交一条覆盖记录'))
  if (coverageByAsset.size !== snapshot.extractionCoveragePlan.length || snapshot.extractionCoveragePlan.some(asset => !coverageByAsset.has(asset.assetVersionId))) issues.push(issue('coverage.assets', '覆盖记录必须包含本次运行的全部固定输入资产'))

  snapshot.extractionCoveragePlan.forEach((plannedAsset, assetPosition) => {
    const coverage = coverageByAsset.get(plannedAsset.assetVersionId)
    if (!coverage) return
    const reviewed = new Set(coverage.reviewedChunkIds)
    const skipped = new Map(coverage.skippedChunks.map(item => [item.chunkId, item.reason]))
    if (reviewed.size !== coverage.reviewedChunkIds.length) issues.push(issue(`coverage.assets[${assetPosition}].reviewedChunkIds`, '已读 Chunk 不得重复'))
    if (skipped.size !== coverage.skippedChunks.length) issues.push(issue(`coverage.assets[${assetPosition}].skippedChunks`, '跳过 Chunk 不得重复'))
    const plannedChunks = new Map(plannedAsset.chunks.map(chunk => [chunk.chunkId, chunk]))
    reviewed.forEach(chunkId => {
      if (!plannedChunks.has(chunkId)) issues.push(issue(`coverage.assets[${assetPosition}].reviewedChunkIds`, '包含不属于固定覆盖计划的 Chunk'))
      if (skipped.has(chunkId)) issues.push(issue(`coverage.assets[${assetPosition}]`, 'Chunk 不能同时标记为已读和跳过'))
      if (observedReadChunkIds && !observedReadChunkIds.has(chunkId)) issues.push(issue(`coverage.assets[${assetPosition}].reviewedChunkIds`, `Chunk ${chunkId} 未被运行时读取，不能声明已覆盖`))
    })
    skipped.forEach((reason, chunkId) => {
      const planned = plannedChunks.get(chunkId)
      if (!planned) issues.push(issue(`coverage.assets[${assetPosition}].skippedChunks`, '包含不属于固定覆盖计划的 Chunk'))
      else if (!planned.excludedReason || reason !== planned.excludedReason) issues.push(issue(`coverage.assets[${assetPosition}].skippedChunks`, '只有服务端预先排除的 Chunk 可以跳过，且理由必须匹配覆盖计划'))
    })
    plannedAsset.chunks.forEach(chunk => {
      if (chunk.excludedReason) {
        if (!skipped.has(chunk.chunkId)) issues.push(issue(`coverage.assets[${assetPosition}]`, `预先排除的 Chunk ${chunk.chunkId} 必须带服务端排除理由记录`))
      } else if (!reviewed.has(chunk.chunkId)) {
        issues.push(issue(`coverage.assets[${assetPosition}]`, `提取覆盖不完整：未读取 Chunk ${chunk.chunkId}（${chunk.headingPath.join(' / ') || '无标题'}）`))
      }
    })
  })
}

function validateOutlineCoverage(
  snapshot: ReviewRunSnapshot,
  issues: ValidationIssue[],
  observedOutlinePages?: ReadonlyMap<string, readonly ObservedAssetOutlinePage[]>
) {
  if (!observedOutlinePages) return
  snapshot.extractionCoveragePlan.forEach((asset, position) => {
    const total = asset.chunks.length
    const pages = observedOutlinePages.get(asset.assetVersionId) ?? []
    let offset = 0
    while (true) {
      const page = pages.find(item => item.offset === offset && item.total === total && (total === 0 || item.count > 0))
      if (!page) {
        issues.push(issue(`outline[${position}]`, `未完整遍历资产 ${asset.assetVersionId} 的目录：缺少 offset=${offset} 的目录页`))
        return
      }
      const nextOffset = offset + page.count
      if (nextOffset > total || page.hasMore !== (nextOffset < total)) {
        issues.push(issue(`outline[${position}]`, `资产 ${asset.assetVersionId} 的目录分页结果不连续或 hasMore 状态不正确`))
        return
      }
      if (nextOffset === total) return
      offset = nextOffset
    }
  })
}

export class RequirementReviewValidator {
  async validate(input: CandidateRequirementReview, extraction: CandidateRequirementPointExtraction, snapshot: ReviewRunSnapshot): Promise<ValidationReport> {
    const issues: ValidationIssue[] = []
    if (!input || typeof input !== 'object') return invalid('$', '结果必须是对象')
    if ('requirementPoints' in input || 'evidence' in input || 'coverage' in input) issues.push(issue('$', '需求评审结果不得增删或改写固定需求点、证据和覆盖范围'))
    if (!assessments.has(input.summary?.overallAssessment)) issues.push(issue('summary.overallAssessment', '总体结论不合法'))
    if (!Number.isFinite(input.summary?.score) || input.summary.score < 0 || input.summary.score > 100) issues.push(issue('summary.score', '评分必须为 0～100'))
    for (const key of ['strengths', 'risks'] as const) if (!isStrings(input.summary?.[key])) issues.push(issue(`summary.${key}`, '必须是字符串数组'))
    if (!Array.isArray(input.findings)) issues.push(issue('findings', '必须是数组'))
    if (issues.length) return { valid: false, issues }

    const requirementPointIds = new Set(extraction.requirementPoints.map(point => point.clientRequirementPointId))
    const findingIds = new Set<string>()
    const maxFindings = snapshot.agentDefinitions?.requirementReview.limits.maxFindings ?? snapshot.agentDefinition.limits.maxFindings
    if (input.findings.length > maxFindings) issues.push(issue('findings', 'Finding 数量超过执行限制'))
    input.findings.forEach((finding, position) => {
      const path = `findings[${position}]`
      const requirementRefs = isStrings(finding.requirementPointRefs) ? finding.requirementPointRefs : []
      if (!finding.clientFindingId || findingIds.has(finding.clientFindingId)) issues.push(issue(`${path}.clientFindingId`, 'Finding ID 为空或重复'))
      findingIds.add(finding.clientFindingId)
      if (!findingTypes.has(finding.type)) issues.push(issue(`${path}.type`, 'Finding 类型不合法'))
      if (!severities.has(finding.severity)) issues.push(issue(`${path}.severity`, '严重度不合法'))
      if (!Number.isFinite(finding.confidence) || finding.confidence < 0 || finding.confidence > 1) issues.push(issue(`${path}.confidence`, '置信度必须为 0～1'))
      for (const key of ['title', 'description', 'impact', 'recommendation'] as const) if (!finding[key]?.trim()) issues.push(issue(`${path}.${key}`, '字段不能为空'))
      if (!isStrings(finding.requirementPointRefs) || !requirementRefs.length || requirementRefs.some(reference => !requirementPointIds.has(reference))) issues.push(issue(`${path}.requirementPointRefs`, 'Finding 至少需要关联一个固定需求点'))
      if ('evidenceRefs' in finding) issues.push(issue(`${path}.evidenceRefs`, 'Finding 不得直接关联 Evidence，应通过关联需求点追溯原文依据'))
    })
    return { valid: issues.length === 0, issues }
  }
}

export class ReviewResultValidator {
  private readonly extractionValidator: RequirementPointExtractionValidator
  private readonly reviewValidator = new RequirementReviewValidator()
  constructor(store: StateStore) { this.extractionValidator = new RequirementPointExtractionValidator(store) }

  async validate(input: CandidateReviewResult, snapshot: ReviewRunSnapshot): Promise<ValidationReport> {
    const extraction = { requirementPoints: input.requirementPoints, evidence: input.evidence, coverage: input.coverage }
    const review = { summary: input.summary, findings: input.findings }
    const extractionReport = await this.extractionValidator.validate(extraction, snapshot)
    const reviewReport = await this.reviewValidator.validate(review, extraction, snapshot)
    return { valid: extractionReport.valid && reviewReport.valid, issues: [...extractionReport.issues, ...reviewReport.issues] }
  }
}

function normalizedPointKey(point: CandidateRequirementPointExtraction['requirementPoints'][number]) {
  return [point.actor, point.action, point.object].map(value => value.trim().toLocaleLowerCase().replace(/\s+/gu, ' ')).join('|').replace(/^\|+|\|+$/gu, '')
}
function invalid(path: string, message: string): ValidationReport { return { valid: false, issues: [issue(path, message)] } }
function issue(path: string, message: string): ValidationIssue { return { path, message } }
function isStrings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string') }
