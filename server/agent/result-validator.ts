import type { InputDeliveryManifest, ReviewRunSnapshot } from '../domain/agent-types.js'
import type { CandidateEvidence, CandidateRequirementPoint, CandidateRequirementPointExtraction, CandidateRequirementPointExtractionV3, CandidateRequirementReview, CandidateReviewResult, ValidationIssue, ValidationReport } from '../domain/review-types.js'
import type { StateStore } from '../infrastructure/store.js'
import { resolveEvidenceQuote } from './evidence-locator.js'

const assessments = new Set(['pass', 'pass_with_notes', 'needs_revision', 'blocked'])
const findingTypes = new Set(['missing_requirement', 'ambiguity', 'conflict', 'boundary_gap', 'state_gap', 'exception_gap', 'security_risk', 'testability_gap', 'dependency_risk', 'other'])
const severities = new Set(['critical', 'high', 'medium', 'low', 'info'])

export class RequirementPointExtractionValidator {
  constructor(private readonly store: StateStore) {}

  async normalizeV3(input: CandidateRequirementPointExtractionV3, snapshot: ReviewRunSnapshot, manifest: InputDeliveryManifest): Promise<{ report: ValidationReport; result?: CandidateRequirementPointExtraction }> {
    const issues: ValidationIssue[] = []
    if (!input || typeof input !== 'object') return { report: invalid('$', '结果必须是对象') }
    if (!Array.isArray(input.requirementPoints)) issues.push(issue('requirementPoints', '必须是数组'))
    const raw = input as unknown as Record<string, unknown>
    for (const forbidden of ['evidenceDrafts', 'evidence', 'coverage', 'findings', 'summary', 'score', 'locator']) if (forbidden in raw) issues.push(issue(forbidden, '该字段由服务端生成或不属于 v3 提取协议；Evidence 草稿必须放在所属需求点内部'))
    validateManifest(manifest, snapshot, issues)
    if (issues.length) return { report: { valid: false, issues } }

    const state = await this.store.snapshot()
    const index = state.indexes.find(item => item.id === snapshot.indexVersionId && item.knowledgeBaseId === snapshot.knowledgeBaseId)
    if (!index) return { report: invalid('$', '本次运行固定索引不存在') }
    const allowedVersions = new Set(snapshot.assets.map(asset => asset.assetVersionId))
    const chunks = (index.indexedChunks ?? []).filter(chunk => allowedVersions.has(chunk.assetVersionId))
    const requirementPoints: CandidateRequirementPoint[] = []
    const evidence: CandidateEvidence[] = []
    const evidenceIds = new Set<string>()
    const evidenceByLocation = new Map<string, string>()

    input.requirementPoints.forEach((draftPoint, pointPosition) => {
      const pointPath = `requirementPoints[${pointPosition}]`
      const rawPoint = draftPoint as unknown as Record<string, unknown>
      for (const forbidden of ['clientRequirementPointId', 'evidenceRef', 'evidenceRefs']) if (forbidden in rawPoint) issues.push(issue(`${pointPath}.${forbidden}`, '该字段由服务端生成；请只在本需求点的 evidenceDrafts 中放置证据'))
      if (!Array.isArray(draftPoint.evidenceDrafts)) {
        issues.push(issue(`${pointPath}.evidenceDrafts`, '每个需求点必须直接包含自己的 Evidence 草稿数组'))
        return
      }
      const pointEvidenceRefs: string[] = []
      draftPoint.evidenceDrafts.forEach((draft, evidencePosition) => {
        const evidencePath = `${pointPath}.evidenceDrafts[${evidencePosition}]`
        const rawDraft = draft as unknown as Record<string, unknown>
        for (const forbidden of ['clientEvidenceId', 'highlight', 'locator', 'sourceType']) if (forbidden in rawDraft) issues.push(issue(`${evidencePath}.${forbidden}`, '该字段由服务端生成或不属于 Evidence 草稿协议'))
        if (!allowedVersions.has(draft.assetVersionId)) { issues.push(issue(`${evidencePath}.assetVersionId`, `证据版本“${draft.assetVersionId}”不属于本次运行固定输入；允许的 assetVersionId：${formatFixedAssetVersionIds(allowedVersions)}`)); return }
        const resolved = resolveEvidenceQuote(draft, chunks)
        if (!resolved) {
          issues.push(issue(`${evidencePath}.quote`, `无法定位该需求点的连续原文；请从固定 Chunk ${draft.chunkId || '未知'} 逐字复制至少 4 个可见字符，禁止改写或使用省略号`))
          return
        }
        const { chunk, quote, offset } = resolved
        const locationKey = `${chunk.assetVersionId}:${chunk.id}:${offset}:${offset + quote.length}`
        let clientEvidenceId = evidenceByLocation.get(locationKey)
        if (!clientEvidenceId) {
          clientEvidenceId = `E-${String(evidence.length + 1).padStart(3, '0')}`
          evidenceByLocation.set(locationKey, clientEvidenceId)
          evidenceIds.add(clientEvidenceId)
          evidence.push({
            clientEvidenceId,
            sourceType: 'knowledge_chunk',
            sourceRef: { chunkId: chunk.id, assetVersionId: chunk.assetVersionId },
            quote,
            locator: { heading: chunk.headingPath.at(-1) ?? '', start: chunk.startChar + offset, end: chunk.startChar + offset + quote.length },
          })
        }
        if (!pointEvidenceRefs.includes(clientEvidenceId)) pointEvidenceRefs.push(clientEvidenceId)
      })
      if (!pointEvidenceRefs.length) issues.push(issue(`${pointPath}.evidenceDrafts`, '需求点至少需要一条可定位的固定 Evidence'))
      requirementPoints.push({
        clientRequirementPointId: `RP-${String(pointPosition + 1).padStart(3, '0')}`,
        title: generatedRequirementPointTitle(draftPoint),
        description: draftPoint.description,
        actor: draftPoint.actor,
        action: draftPoint.action,
        object: draftPoint.object,
        conditions: structuredClone(draftPoint.conditions),
        businessRules: structuredClone(draftPoint.businessRules),
        exceptions: structuredClone(draftPoint.exceptions),
        acceptanceCriteria: structuredClone(draftPoint.acceptanceCriteria),
        evidenceRefs: pointEvidenceRefs,
        ...(draftPoint.mergeGroupId !== undefined ? { mergeGroupId: draftPoint.mergeGroupId } : {}),
        ...(draftPoint.mergeRationale !== undefined ? { mergeRationale: draftPoint.mergeRationale } : {}),
      })
    })
    validateRequirementPoints(requirementPoints, evidenceIds, issues)
    const coverage = buildCoverage(snapshot, manifest)
    if (issues.length) return { report: { valid: false, issues } }
    const result: CandidateRequirementPointExtraction = { requirementPoints, evidence, coverage }
    const formalReport = await this.validate(result, snapshot, manifest)
    return { report: formalReport, ...(formalReport.valid ? { result } : {}) }
  }

  async validate(input: CandidateRequirementPointExtraction, snapshot: ReviewRunSnapshot, manifest?: InputDeliveryManifest): Promise<ValidationReport> {
    const issues: ValidationIssue[] = []
    if (!input || typeof input !== 'object') return invalid('$', '结果必须是对象')
    if (!Array.isArray(input.requirementPoints)) issues.push(issue('requirementPoints', '必须是数组'))
    if (!Array.isArray(input.evidence)) issues.push(issue('evidence', '必须是数组'))
    if (!input.coverage || !Array.isArray(input.coverage.assets) || !isStrings(input.coverage.limitations)) issues.push(issue('coverage', '覆盖范围结构不合法'))
    if ('evidenceDrafts' in input || 'findings' in input || 'summary' in input || 'score' in input) issues.push(issue('$', '正式需求点结果不得包含草稿、Finding、评分或评审结论'))
    if (manifest) validateManifest(manifest, snapshot, issues)
    if (issues.length) return { valid: false, issues }

    const state = await this.store.snapshot()
    const index = state.indexes.find(item => item.id === snapshot.indexVersionId && item.knowledgeBaseId === snapshot.knowledgeBaseId)
    const allowedChunks = new Map((index?.indexedChunks ?? []).map(chunk => [chunk.id, chunk]))
    const allowedVersions = new Set(snapshot.assets.map(asset => asset.assetVersionId))
    const evidenceIds = new Set<string>()
    const evidenceById = new Map<string, CandidateRequirementPointExtraction['evidence'][number]>()
    input.evidence.forEach((value, position) => {
      const path = `evidence[${position}]`
      if (!value.clientEvidenceId || evidenceIds.has(value.clientEvidenceId)) issues.push(issue(`${path}.clientEvidenceId`, '证据 ID 为空或重复'))
      evidenceIds.add(value.clientEvidenceId)
      evidenceById.set(value.clientEvidenceId, value)
      const chunk = allowedChunks.get(value.sourceRef?.chunkId)
      const quote = value.quote?.trim()
      const offset = quote && chunk ? chunk.content.indexOf(quote) : -1
      if (!chunk || chunk.assetVersionId !== value.sourceRef?.assetVersionId || !allowedVersions.has(value.sourceRef?.assetVersionId)) issues.push(issue(`${path}.sourceRef`, '证据不属于本次运行固定输入'))
      else if (!quote || quote.length < 4 || offset < 0) issues.push(issue(`${path}.quote`, '引用无法在固定 Chunk 中定位'))
      else {
        const expected = { heading: chunk.headingPath.at(-1) ?? '', start: chunk.startChar + offset, end: chunk.startChar + offset + quote.length }
        if (value.sourceType !== 'knowledge_chunk' || value.locator?.heading !== expected.heading || value.locator?.start !== expected.start || value.locator?.end !== expected.end) issues.push(issue(`${path}.locator`, '证据来源和定位必须与服务端固定 Chunk 一致'))
      }
    })
    validateRequirementPoints(input.requirementPoints, evidenceIds, issues)
    validateCoverage(input, snapshot, issues)
    const referenced = new Set(input.requirementPoints.flatMap(point => point.evidenceRefs ?? []))
    snapshot.assets.forEach(asset => {
      const requiresEvidence = snapshot.extractionCoveragePlan.find(item => item.assetVersionId === asset.assetVersionId)?.chunks.some(chunk => !chunk.excludedReason)
      if (requiresEvidence && ![...referenced].some(id => evidenceById.get(id)?.sourceRef.assetVersionId === asset.assetVersionId)) issues.push(issue('requirementPoints', `输入文档 ${asset.logicalPath} 缺少被需求点引用的固定证据`))
    })
    return { valid: issues.length === 0, issues }
  }
}

function validateManifest(manifest: InputDeliveryManifest, snapshot: ReviewRunSnapshot, issues: ValidationIssue[]) {
  const expected = snapshot.extractionInput
  if (!manifest || !expected) { issues.push(issue('inputDeliveryManifest', '缺少服务端输入投递证明')); return }
  if (manifest.policyVersion !== expected.policyVersion || manifest.mode !== expected.mode || manifest.packageSha256 !== expected.packageSha256) issues.push(issue('inputDeliveryManifest', '投递策略、模式或输入包哈希与运行快照不一致'))
  if (!manifest.finalMergeCompleted) issues.push(issue('inputDeliveryManifest.finalMergeCompleted', '输入处理或分段归并尚未完成'))
  const entries = new Map(manifest.entries.map(entry => [entry.batchId, entry]))
  if (entries.size !== manifest.entries.length || entries.size !== expected.batches.length) issues.push(issue('inputDeliveryManifest.entries', '输入批次必须逐批且仅投递一次'))
  const callSequences = manifest.entries.map(entry => entry.modelCallSequence)
  if (new Set(callSequences).size !== callSequences.length || callSequences.some(value => !Number.isInteger(value) || value < 1)) issues.push(issue('inputDeliveryManifest.entries.modelCallSequence', '模型调用序号必须为唯一正整数'))
  expected.batches.forEach(batch => {
    const entry = entries.get(batch.batchId)
    if (!entry || entry.ordinal !== batch.ordinal || entry.tokenCount !== batch.tokenCount || entry.contentSha256 !== batch.contentSha256 || !sameStrings(entry.assetVersionIds, batch.assetVersionIds) || !sameStrings(entry.chunkIds, batch.chunkIds)) issues.push(issue(`inputDeliveryManifest.entries.${batch.batchId}`, '输入批次投递证明与快照不一致'))
  })
}

function buildCoverage(snapshot: ReviewRunSnapshot, manifest: InputDeliveryManifest) {
  const delivered = new Set(manifest.entries.flatMap(entry => entry.chunkIds))
  return {
    assets: snapshot.extractionCoveragePlan.map(asset => ({
      assetVersionId: asset.assetVersionId,
      deliveredChunkIds: asset.chunks.filter(chunk => !chunk.excludedReason && delivered.has(chunk.chunkId)).map(chunk => chunk.chunkId),
      excludedChunks: asset.chunks.filter(chunk => chunk.excludedReason).map(chunk => ({ chunkId: chunk.chunkId, reason: chunk.excludedReason! })),
    })),
    limitations: [] as string[],
  }
}

function validateCoverage(input: CandidateRequirementPointExtraction, snapshot: ReviewRunSnapshot, issues: ValidationIssue[]) {
  const coverageByAsset = new Map(input.coverage.assets.map(asset => [asset.assetVersionId, asset]))
  if (coverageByAsset.size !== input.coverage.assets.length || coverageByAsset.size !== snapshot.extractionCoveragePlan.length) issues.push(issue('coverage.assets', '覆盖记录必须与全部固定输入资产一一对应'))
  snapshot.extractionCoveragePlan.forEach((planned, position) => {
    const actual = coverageByAsset.get(planned.assetVersionId)
    if (!actual) { issues.push(issue(`coverage.assets[${position}]`, '缺少固定输入资产覆盖记录')); return }
    if (!Array.isArray(actual.deliveredChunkIds) || !Array.isArray(actual.excludedChunks)) { issues.push(issue(`coverage.assets[${position}]`, '覆盖字段结构不合法')); return }
    const delivered = new Set(actual.deliveredChunkIds)
    const excluded = new Map(actual.excludedChunks.map(item => [item.chunkId, item.reason]))
    if (delivered.size !== actual.deliveredChunkIds.length || excluded.size !== actual.excludedChunks.length) issues.push(issue(`coverage.assets[${position}]`, 'Chunk 不得重复'))
    planned.chunks.forEach(chunk => {
      if (chunk.excludedReason) {
        if (excluded.get(chunk.chunkId) !== chunk.excludedReason || delivered.has(chunk.chunkId)) issues.push(issue(`coverage.assets[${position}]`, `排除 Chunk ${chunk.chunkId} 与服务端计划不一致`))
      } else if (!delivered.has(chunk.chunkId) || excluded.has(chunk.chunkId)) issues.push(issue(`coverage.assets[${position}]`, `投递覆盖不完整：${chunk.chunkId}`))
    })
    if ([...delivered, ...excluded.keys()].some(id => !planned.chunks.some(chunk => chunk.chunkId === id))) issues.push(issue(`coverage.assets[${position}]`, '包含固定覆盖计划之外的 Chunk'))
  })
}

function validateRequirementPoints(points: CandidateRequirementPointExtraction['requirementPoints'], evidenceIds: Set<string>, issues: ValidationIssue[]) {
  const pointIds = new Set<string>()
  const duplicateKeys = new Map<string, number[]>()
  points.forEach((point, position) => {
    const path = `requirementPoints[${position}]`
    if (!point.clientRequirementPointId || pointIds.has(point.clientRequirementPointId)) issues.push(issue(`${path}.clientRequirementPointId`, '需求点 ID 为空或重复'))
    pointIds.add(point.clientRequirementPointId)
    for (const key of ['title', 'description'] as const) if (!point[key]?.trim()) issues.push(issue(`${path}.${key}`, '字段不能为空'))
    for (const key of ['conditions', 'businessRules', 'exceptions', 'acceptanceCriteria'] as const) if (!isStrings(point[key])) issues.push(issue(`${path}.${key}`, '必须是字符串数组'))
    if (!point.action?.trim() && !point.businessRules?.length && !point.acceptanceCriteria?.length) issues.push(issue(`${path}.action`, '需求点至少需要动作、业务规则或验收标准之一'))
    if (!isStrings(point.evidenceRefs) || !point.evidenceRefs.length || point.evidenceRefs.some(reference => !evidenceIds.has(reference))) issues.push(issue(`${path}.evidenceRefs`, '需求点至少需要一条有效固定证据'))
    const mergeGroupId = point.mergeGroupId?.trim()
    const mergeRationale = point.mergeRationale?.trim()
    if (point.mergeGroupId !== undefined && !mergeGroupId) issues.push(issue(`${path}.mergeGroupId`, 'mergeGroupId 不能为空白'))
    else if (mergeRationale && point.mergeGroupId === undefined) issues.push(issue(`${path}.mergeGroupId`, '归并需求点必须同时提供非空 mergeGroupId 与 mergeRationale'))
    if (point.mergeRationale !== undefined && !mergeRationale) issues.push(issue(`${path}.mergeRationale`, 'mergeRationale 不能为空白'))
    else if (mergeGroupId && point.mergeRationale === undefined) issues.push(issue(`${path}.mergeRationale`, '归并需求点必须同时提供非空 mergeGroupId 与 mergeRationale'))
    const key = normalizedPointKey(point)
    if (key) duplicateKeys.set(key, [...(duplicateKeys.get(key) ?? []), position])
  })
  duplicateKeys.forEach(positions => {
    if (positions.length < 2) return
    const group = points[positions[0]].mergeGroupId
    if (!group || positions.some(position => points[position].mergeGroupId !== group || !points[position].mergeRationale?.trim())) issues.push(issue(`requirementPoints[${positions.join(',')}].mergeGroupId`, '重复需求点必须显式归并并说明理由'))
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
      if (!finding.clientFindingId || findingIds.has(finding.clientFindingId)) issues.push(issue(`${path}.clientFindingId`, 'Finding ID 为空或重复'))
      findingIds.add(finding.clientFindingId)
      if (!findingTypes.has(finding.type)) issues.push(issue(`${path}.type`, 'Finding 类型不合法'))
      if (!severities.has(finding.severity)) issues.push(issue(`${path}.severity`, '严重度不合法'))
      if (!Number.isFinite(finding.confidence) || finding.confidence < 0 || finding.confidence > 1) issues.push(issue(`${path}.confidence`, '置信度必须为 0～1'))
      for (const key of ['title', 'description', 'impact', 'recommendation'] as const) if (!finding[key]?.trim()) issues.push(issue(`${path}.${key}`, '字段不能为空'))
      if (!isStrings(finding.requirementPointRefs) || !finding.requirementPointRefs.length || finding.requirementPointRefs.some(reference => !requirementPointIds.has(reference))) issues.push(issue(`${path}.requirementPointRefs`, 'Finding 至少需要关联一个固定需求点'))
      if ('evidenceRefs' in finding) issues.push(issue(`${path}.evidenceRefs`, 'Finding 应通过需求点追溯 Evidence'))
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

function generatedRequirementPointTitle(point: CandidateRequirementPointExtractionV3['requirementPoints'][number]) {
  const explicit = point.title?.trim()
  if (explicit) return explicit.slice(0, 300)
  const structured = [point.actor, point.action, point.object].map(value => value?.trim()).filter(Boolean).join(' / ')
  if (structured) return structured.slice(0, 300)
  return point.description.trim().split(/[。！？.!?\r\n]/u)[0].slice(0, 300) || '未命名需求点'
}

function normalizedPointKey(point: CandidateRequirementPointExtraction['requirementPoints'][number]) { return [point.actor, point.action, point.object].map(value => value.trim().toLocaleLowerCase().replace(/\s+/gu, ' ')).join('|').replace(/^\|+|\|+$/gu, '') }
function formatFixedAssetVersionIds(assetVersionIds: Set<string>) {
  const values = [...assetVersionIds]
  const visible = values.slice(0, 10).join('、')
  return `${visible}${values.length > 10 ? ` 等 ${values.length} 个` : ''}`
}
function sameStrings(left: string[], right: string[]) { return left.length === right.length && left.every((value, index) => value === right[index]) }
function invalid(path: string, message: string): ValidationReport { return { valid: false, issues: [issue(path, message)] } }
function issue(path: string, message: string): ValidationIssue { return { path, message } }
function isStrings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string') }
