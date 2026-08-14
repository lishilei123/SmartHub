import type { InputDeliveryManifest, ReviewRunSnapshot } from '../domain/agent-types.js'
import type { CandidateEvidence, CandidateRequirementAnalysisV1, CandidateRequirementPoint, CandidateRequirementPointExtraction, CandidateRequirementPointExtractionV3, CandidateRequirementPointExtractionV4, CandidateRequirementPointExtractionV5, CandidateRequirementReview, CandidateRequirementReviewV3, CandidateReviewResult, RequirementAnalysisResult, ReviewFindingType, ReviewSeverity, ValidationIssue, ValidationReport } from '../domain/review-types.js'
import type { StateStore } from '../infrastructure/store.js'
import { resolveEvidenceQuote, resolveEvidenceSourceText, searchEvidenceCandidates } from './evidence-locator.js'
import { posix } from 'node:path'
import { createHash } from 'node:crypto'
import { renderRequirementAnalysisArtifacts } from './requirement-analysis-artifacts.js'

const assessments = new Set(['pass', 'pass_with_notes', 'needs_revision', 'blocked'])
const findingTypes = new Set(['missing_requirement', 'ambiguity', 'conflict', 'boundary_gap', 'state_gap', 'exception_gap', 'security_risk', 'testability_gap', 'dependency_risk', 'other'])
const severities = new Set(['blocker', 'high', 'medium', 'low'])
const DIRECTORY_NOT_READ_REASON = 'Pi Agent 未通过 read 读取此固定原文范围'

export class RequirementPointExtractionValidator {
  constructor(private readonly store: StateStore) {}

  async normalizeV5(input: CandidateRequirementPointExtractionV5, snapshot: ReviewRunSnapshot, manifest: InputDeliveryManifest): Promise<{ report: ValidationReport; result?: CandidateRequirementPointExtraction }> {
    const issues: ValidationIssue[] = []
    if (!input || typeof input !== 'object') return { report: invalid('$', '结果必须是对象') }
    const raw = input as unknown as Record<string, unknown>
    for (const key of Object.keys(raw)) if (key !== 'requirementPoints') issues.push(issue(key, '该字段由服务端生成；模型只提交 requirementPoints'))
    if (!Array.isArray(input.requirementPoints)) issues.push(issue('requirementPoints', '必须是数组'))
    if (issues.length) return { report: { valid: false, issues } }

    const deduplicated = new Map<string, { title?: string; description: string; sourceTexts: string[] }>()
    input.requirementPoints.forEach((point, position) => {
      const path = `requirementPoints[${position}]`
      if (!point || typeof point !== 'object') { issues.push(issue(path, '需求点必须是对象')); return }
      const rawPoint = point as unknown as Record<string, unknown>
      for (const key of Object.keys(rawPoint)) if (key !== 'title' && key !== 'description' && key !== 'sourceTexts') issues.push(issue(`${path}.${key}`, '该字段由服务端生成；模型只提交 title、description 和 sourceTexts'))
      const title = typeof point.title === 'string' ? point.title.trim().slice(0, 300) : ''
      const description = typeof point.description === 'string' ? point.description.trim() : ''
      if (!description) issues.push(issue(`${path}.description`, '需求描述不能为空'))
      if (!Array.isArray(point.sourceTexts) || !point.sourceTexts.length) { issues.push(issue(`${path}.sourceTexts`, '必须至少提供一条固定原文线索')); return }
      const sourceTexts = [...new Set(point.sourceTexts.map(value => typeof value === 'string' ? value.trim() : '').filter(Boolean))]
      if (sourceTexts.some(value => Array.from(value).filter(character => !/\s/u.test(character)).length < 4)) issues.push(issue(`${path}.sourceTexts`, '每条原文线索至少需要 4 个可见字符'))
      if (!description || !sourceTexts.length) return
      const key = description.toLocaleLowerCase().replace(/\s+/gu, ' ')
      const existing = deduplicated.get(key)
      if (existing) {
        existing.sourceTexts = [...new Set([...existing.sourceTexts, ...sourceTexts])]
        if (!existing.title && title) existing.title = title
      } else deduplicated.set(key, { ...(title ? { title } : {}), description, sourceTexts })
    })
    if (issues.length) return { report: { valid: false, issues } }

    return this.normalizeV4({
      requirementPoints: [...deduplicated.values()].map(point => ({
        ...point,
        actor: '', action: '', object: '',
        conditions: [], businessRules: [], exceptions: [], acceptanceCriteria: [],
      })),
    }, snapshot, manifest)
  }

  async normalizeV4(input: CandidateRequirementPointExtractionV4, snapshot: ReviewRunSnapshot, manifest: InputDeliveryManifest): Promise<{ report: ValidationReport; result?: CandidateRequirementPointExtraction }> {
    const issues: ValidationIssue[] = []
    if (!input || typeof input !== 'object') return { report: invalid('$', '结果必须是对象') }
    if (!Array.isArray(input.requirementPoints)) issues.push(issue('requirementPoints', '必须是数组'))
    const raw = input as unknown as Record<string, unknown>
    for (const forbidden of ['sourceTexts', 'evidenceDrafts', 'evidence', 'coverage', 'findings', 'summary', 'score', 'locator']) if (forbidden in raw) issues.push(issue(forbidden, '该字段由服务端生成或必须放在所属需求点内部'))
    validateManifest(manifest, snapshot, issues)
    if (issues.length) return { report: { valid: false, issues } }

    const state = await this.store.snapshot()
    const index = state.indexes.find(item => item.id === snapshot.indexVersionId && item.knowledgeBaseId === snapshot.knowledgeBaseId)
    if (!index) return { report: invalid('$', '本次运行固定索引不存在') }
    const allowedVersions = new Set(snapshot.assets.map(asset => asset.assetVersionId))
    const chunks = fixedEvidenceChunks(index.indexedChunks ?? [], snapshot, manifest).filter(chunk => allowedVersions.has(chunk.assetVersionId))
    const requirementPoints: CandidateRequirementPoint[] = []
    const evidence: CandidateEvidence[] = []
    const evidenceIds = new Set<string>()
    const evidenceByLocation = new Map<string, string>()

    input.requirementPoints.forEach((draftPoint, pointPosition) => {
      const pointPath = `requirementPoints[${pointPosition}]`
      const rawPoint = draftPoint as unknown as Record<string, unknown>
      for (const forbidden of ['clientRequirementPointId', 'evidenceDrafts', 'evidenceRef', 'evidenceRefs']) if (forbidden in rawPoint) issues.push(issue(`${pointPath}.${forbidden}`, '该字段由服务端生成；请只提交需求点字段和 sourceTexts'))
      if (!Array.isArray(draftPoint.sourceTexts)) {
        issues.push(issue(`${pointPath}.sourceTexts`, '每个需求点必须包含用于检索固定原文的 sourceTexts 数组'))
        return
      }
      const requirementText = [draftPoint.title, draftPoint.description, draftPoint.actor, draftPoint.action, draftPoint.object, ...(draftPoint.conditions ?? []), ...(draftPoint.businessRules ?? []), ...(draftPoint.exceptions ?? []), ...(draftPoint.acceptanceCriteria ?? [])].filter(Boolean).join(' ')
      const pointEvidenceRefs: string[] = []
      draftPoint.sourceTexts.forEach(sourceText => {
        resolveEvidenceSourceText(sourceText, chunks, requirementText).forEach(resolved => {
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
      })
      if (!pointEvidenceRefs.length) {
        const suggestions = draftPoint.sourceTexts.flatMap(sourceText => searchEvidenceCandidates({ quote: sourceText }, chunks, requirementText)).sort((left, right) => right.score - left.score).slice(0, 2)
        const visible = suggestions.map(candidate => `Chunk ${candidate.chunk.id}：“${Array.from(candidate.quote).slice(0, 240).join('')}”`).join('；')
        issues.push(issue(`${pointPath}.sourceTexts`, `未能从本次固定输入检索到支撑该需求点的原文${visible ? `；可核对候选 ${visible}` : ''}`))
      }
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
    const chunks = fixedEvidenceChunks(index.indexedChunks ?? [], snapshot, manifest).filter(chunk => allowedVersions.has(chunk.assetVersionId))
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
          const requirementText = [draftPoint.title, draftPoint.description, draftPoint.actor, draftPoint.action, draftPoint.object, ...(draftPoint.conditions ?? []), ...(draftPoint.businessRules ?? []), ...(draftPoint.exceptions ?? []), ...(draftPoint.acceptanceCriteria ?? [])].filter(Boolean).join(' ')
          const suggestion = searchEvidenceCandidates(draft, chunks, requirementText)[0]
          const suggestionText = suggestion && suggestion.score >= 0.45 ? `；可先核对候选 Chunk ${suggestion.chunk.id} 原文：“${Array.from(suggestion.quote).slice(0, 300).join('')}”` : ''
          issues.push(issue(`${evidencePath}.quote`, `无法从固定 Chunk ${draft.chunkId || '未知'} 或同一固定资产中唯一检索到支撑该需求点的连续原文；请提供更具区分度的原文片段${suggestionText}`))
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
    const allowedVersions = new Set(snapshot.assets.map(asset => asset.assetVersionId))
    const deliveredChunks = snapshot.analysisInput.mode === 'agent_directory'
      ? new Set(input.coverage.assets.flatMap(asset => asset.deliveredChunkIds))
      : undefined
    const allowedChunks = new Map((index?.indexedChunks ?? []).filter(chunk => allowedVersions.has(chunk.assetVersionId) && (!deliveredChunks || deliveredChunks.has(chunk.id))).map(chunk => [chunk.id, chunk]))
    const evidenceIds = new Set<string>()
    const evidenceById = new Map<string, CandidateRequirementPointExtraction['evidence'][number]>()
    input.evidence.forEach((value, position) => {
      const path = `evidence[${position}]`
      if (!value.clientEvidenceId || evidenceIds.has(value.clientEvidenceId)) issues.push(issue(`${path}.clientEvidenceId`, '证据 ID 为空或重复'))
      evidenceIds.add(value.clientEvidenceId)
      evidenceById.set(value.clientEvidenceId, value)
      const chunk = allowedChunks.get(value.sourceRef?.chunkId)
      const quote = value.quote?.trim()
      const offset = quote && chunk && Number.isInteger(value.locator?.start) ? value.locator.start - chunk.startChar : -1
      if (!chunk || chunk.assetVersionId !== value.sourceRef?.assetVersionId || !allowedVersions.has(value.sourceRef?.assetVersionId)) issues.push(issue(`${path}.sourceRef`, '证据不属于本次运行固定输入'))
      else if (!quote || quote.length < 4 || offset < 0 || chunk.content.slice(offset, offset + quote.length) !== quote) issues.push(issue(`${path}.quote`, '引用无法在固定 Chunk 中定位'))
      else {
        const expected = { heading: chunk.headingPath.at(-1) ?? '', start: chunk.startChar + offset, end: chunk.startChar + offset + quote.length }
        if (value.sourceType !== 'knowledge_chunk' || value.locator?.heading !== expected.heading || value.locator?.start !== expected.start || value.locator?.end !== expected.end) issues.push(issue(`${path}.locator`, '证据来源和定位必须与服务端固定 Chunk 一致'))
      }
    })
    validateRequirementPoints(input.requirementPoints, evidenceIds, issues)
    validateCoverage(input, snapshot, issues, manifest)
    const referenced = new Set(input.requirementPoints.flatMap(point => point.evidenceRefs ?? []))
    snapshot.assets.forEach(asset => {
      const requiresEvidence = input.coverage.assets.find(item => item.assetVersionId === asset.assetVersionId)?.deliveredChunkIds.length
      if (requiresEvidence && ![...referenced].some(id => evidenceById.get(id)?.sourceRef.assetVersionId === asset.assetVersionId)) issues.push(issue('requirementPoints', `输入文档 ${asset.logicalPath} 缺少被需求点引用的固定证据`))
    })
    return { valid: issues.length === 0, issues }
  }
}

function validateManifest(manifest: InputDeliveryManifest, snapshot: ReviewRunSnapshot, issues: ValidationIssue[]) {
  const expected = snapshot.analysisInput
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
  if (expected.mode === 'agent_directory') {
    const coveragePlan = snapshot.analysisCoveragePlan
    const plannedChunks = new Map(coveragePlan.flatMap(asset => asset.chunks.map(chunk => [chunk.chunkId, asset.assetVersionId] as const)))
    const reads = manifest.toolReads ?? []
    if (!reads.some(read => read.toolId === 'workspace.read_file' && read.startLine !== undefined && read.endLine !== undefined)) issues.push(issue('inputDeliveryManifest.toolReads', 'Pi Agent 必须使用 read 从固定 /workspace 读取至少一个文件范围'))
    const toolCallIds = new Set<string>()
    reads.forEach((read, position) => {
      const path = `inputDeliveryManifest.toolReads[${position}]`
      if (!read.toolCallId || toolCallIds.has(read.toolCallId)) issues.push(issue(`${path}.toolCallId`, '读取工具调用 ID 为空或重复'))
      toolCallIds.add(read.toolCallId)
      if (read.toolId !== 'workspace.read_file') issues.push(issue(`${path}.toolId`, 'Pi 文件工作区协议只允许 read 形成正文投递证明'))
      const observedVersions = new Set<string>()
      read.chunkIds.forEach(chunkId => {
        const versionId = plannedChunks.get(chunkId)
        if (!versionId) issues.push(issue(`${path}.chunkIds`, `Chunk ${chunkId} 不属于固定文档工作目录`))
        else observedVersions.add(versionId)
      })
      if (read.assetVersionIds.length !== 1 || !snapshot.assets.some(asset => asset.assetVersionId === read.assetVersionIds[0])) issues.push(issue(`${path}.assetVersionIds`, 'read 必须且只能对应一份固定文件版本'))
      if (!Number.isInteger(read.startLine) || !Number.isInteger(read.endLine) || Number(read.startLine) < 1 || Number(read.endLine) < Number(read.startLine)) issues.push(issue(`${path}.startLine`, 'read 的实际行范围无效'))
      const asset = snapshot.assets.find(item => item.assetVersionId === read.assetVersionIds[0])
      if (!asset || read.relativePath !== workspaceRelativePath(snapshot, asset.logicalPath)) issues.push(issue(`${path}.relativePath`, 'read 路径与固定 /workspace 文件不一致'))
      if ([...observedVersions].some(versionId => versionId !== read.assetVersionIds[0])) issues.push(issue(`${path}.chunkIds`, 'read 返回的内部 Chunk 与固定文件版本不一致'))
    })
    const delivered = workspaceDeliveredChunkIds(snapshot, manifest)
    reads.flatMap(read => read.chunkIds).forEach(chunkId => { if (!delivered.has(chunkId)) issues.push(issue('inputDeliveryManifest.toolReads.chunkIds', `Chunk ${chunkId} 未被 read 行范围完整覆盖`)) })
  } else if (manifest.toolReads?.length) issues.push(issue('inputDeliveryManifest.toolReads', '正文直传模式不得伪造目录读取记录'))
}

function buildCoverage(snapshot: ReviewRunSnapshot, manifest: InputDeliveryManifest) {
  const input = snapshot.analysisInput
  const plan = snapshot.analysisCoveragePlan
  if (!input || !plan) throw new Error('REQUIREMENT_ANALYSIS_SNAPSHOT_INVALID: 缺少输入或覆盖计划')
  const delivered = new Set(input.mode === 'agent_directory'
    ? [...directoryDeliveredChunkIds(snapshot, manifest)]
    : manifest.entries.flatMap(entry => entry.chunkIds))
  return {
    assets: plan.map(asset => ({
      assetVersionId: asset.assetVersionId,
      deliveredChunkIds: asset.chunks.filter(chunk => !chunk.excludedReason && delivered.has(chunk.chunkId)).map(chunk => chunk.chunkId),
      excludedChunks: asset.chunks.filter(chunk => chunk.excludedReason || (input.mode === 'agent_directory' && !delivered.has(chunk.chunkId))).map(chunk => ({ chunkId: chunk.chunkId, reason: chunk.excludedReason ?? DIRECTORY_NOT_READ_REASON })),
    })),
    limitations: [] as string[],
  }
}

function validateCoverage(input: CandidateRequirementPointExtraction, snapshot: ReviewRunSnapshot, issues: ValidationIssue[], manifest?: InputDeliveryManifest) {
  const analysisInput = snapshot.analysisInput
  const coveragePlan = snapshot.analysisCoveragePlan
  const coverageByAsset = new Map(input.coverage.assets.map(asset => [asset.assetVersionId, asset]))
  const directoryDelivered = analysisInput?.mode === 'agent_directory' && manifest
    ? directoryDeliveredChunkIds(snapshot, manifest)
    : undefined
  if (coverageByAsset.size !== input.coverage.assets.length || coverageByAsset.size !== coveragePlan.length) issues.push(issue('coverage.assets', '覆盖记录必须与全部固定输入资产一一对应'))
  coveragePlan.forEach((planned, position) => {
    const actual = coverageByAsset.get(planned.assetVersionId)
    if (!actual) { issues.push(issue(`coverage.assets[${position}]`, '缺少固定输入资产覆盖记录')); return }
    if (!Array.isArray(actual.deliveredChunkIds) || !Array.isArray(actual.excludedChunks)) { issues.push(issue(`coverage.assets[${position}]`, '覆盖字段结构不合法')); return }
    const delivered = new Set(actual.deliveredChunkIds)
    const excluded = new Map(actual.excludedChunks.map(item => [item.chunkId, item.reason]))
    if (delivered.size !== actual.deliveredChunkIds.length || excluded.size !== actual.excludedChunks.length) issues.push(issue(`coverage.assets[${position}]`, 'Chunk 不得重复'))
    planned.chunks.forEach(chunk => {
      if (chunk.excludedReason) {
        if (excluded.get(chunk.chunkId) !== chunk.excludedReason || delivered.has(chunk.chunkId)) issues.push(issue(`coverage.assets[${position}]`, `排除 Chunk ${chunk.chunkId} 与服务端计划不一致`))
      } else if (analysisInput?.mode === 'agent_directory') {
        const shouldBeDelivered = directoryDelivered ? directoryDelivered.has(chunk.chunkId) : delivered.has(chunk.chunkId)
        if (shouldBeDelivered && (!delivered.has(chunk.chunkId) || excluded.has(chunk.chunkId))) issues.push(issue(`coverage.assets[${position}]`, `Agent 已读 Chunk 的覆盖记录不一致：${chunk.chunkId}`))
        if (!shouldBeDelivered && (delivered.has(chunk.chunkId) || excluded.get(chunk.chunkId) !== DIRECTORY_NOT_READ_REASON)) issues.push(issue(`coverage.assets[${position}]`, `Agent 未读 Chunk 的排除记录不一致：${chunk.chunkId}`))
      } else if (!delivered.has(chunk.chunkId) || excluded.has(chunk.chunkId)) issues.push(issue(`coverage.assets[${position}]`, `投递覆盖不完整：${chunk.chunkId}`))
    })
    if ([...delivered, ...excluded.keys()].some(id => !planned.chunks.some(chunk => chunk.chunkId === id))) issues.push(issue(`coverage.assets[${position}]`, '包含固定覆盖计划之外的 Chunk'))
  })
}

function fixedEvidenceChunks<T extends { id: string; assetVersionId: string }>(chunks: T[], snapshot: ReviewRunSnapshot, manifest: InputDeliveryManifest) {
  if (snapshot.analysisInput.mode !== 'agent_directory') return chunks
  const delivered = directoryDeliveredChunkIds(snapshot, manifest)
  return chunks.filter(chunk => delivered.has(chunk.id))
}

function directoryDeliveredChunkIds(snapshot: ReviewRunSnapshot, manifest: InputDeliveryManifest) {
  return workspaceDeliveredChunkIds(snapshot, manifest)
}

function workspaceDeliveredChunkIds(snapshot: ReviewRunSnapshot, manifest: InputDeliveryManifest) {
  const rangesByVersion = new Map<string, Array<{ start: number; end: number }>>()
  for (const read of manifest.toolReads ?? []) {
    if (read.toolId !== 'workspace.read_file' || read.assetVersionIds.length !== 1 || !Number.isInteger(read.startLine) || !Number.isInteger(read.endLine)) continue
    const ranges = rangesByVersion.get(read.assetVersionIds[0]) ?? []
    ranges.push({ start: Number(read.startLine), end: Number(read.endLine) })
    rangesByVersion.set(read.assetVersionIds[0], ranges)
  }
  const delivered = new Set<string>()
  const coveragePlan = snapshot.analysisCoveragePlan
  coveragePlan.forEach(asset => {
    const ranges = mergeLineRanges(rangesByVersion.get(asset.assetVersionId) ?? [])
    asset.chunks.forEach(chunk => {
      if (!chunk.excludedReason && ranges.some(range => range.start <= chunk.startLine && range.end >= chunk.endLine)) delivered.add(chunk.chunkId)
    })
  })
  return delivered
}

function mergeLineRanges(ranges: Array<{ start: number; end: number }>) {
  const merged: Array<{ start: number; end: number }> = []
  for (const range of [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)) {
    const previous = merged.at(-1)
    if (!previous || range.start > previous.end + 1) merged.push({ ...range })
    else previous.end = Math.max(previous.end, range.end)
  }
  return merged
}

function workspaceRelativePath(snapshot: ReviewRunSnapshot, logicalPath: string) {
  const workspace = snapshot.documentWorkspace
  const root = normalizeLogicalPath(workspace?.rootLogicalPath ?? workspace?.logicalPath ?? '')
  const file = normalizeLogicalPath(logicalPath)
  const value = posix.relative(root, file)
  return value && value !== '..' && !value.startsWith('../') && !posix.isAbsolute(value) ? value : ''
}

function normalizeLogicalPath(value: string) { return posix.normalize(value.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')) }

function validateRequirementPoints(points: CandidateRequirementPointExtraction['requirementPoints'], evidenceIds: Set<string>, issues: ValidationIssue[]) {
  const pointIds = new Set<string>()
  const duplicateKeys = new Map<string, number[]>()
  points.forEach((point, position) => {
    const path = `requirementPoints[${position}]`
    if (!point.clientRequirementPointId || pointIds.has(point.clientRequirementPointId)) issues.push(issue(`${path}.clientRequirementPointId`, '需求点 ID 为空或重复'))
    pointIds.add(point.clientRequirementPointId)
    for (const key of ['title', 'description'] as const) if (!point[key]?.trim()) issues.push(issue(`${path}.${key}`, '字段不能为空'))
    for (const key of ['conditions', 'businessRules', 'exceptions', 'acceptanceCriteria'] as const) if (!isStrings(point[key])) issues.push(issue(`${path}.${key}`, '必须是字符串数组'))
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

export class RequirementAnalysisValidator {
  private readonly pointValidator: RequirementPointExtractionValidator

  constructor(store: StateStore) {
    this.pointValidator = new RequirementPointExtractionValidator(store)
  }

  async normalize(input: CandidateRequirementAnalysisV1, snapshot: ReviewRunSnapshot, manifest: InputDeliveryManifest): Promise<{ report: ValidationReport; result?: RequirementAnalysisResult }> {
    const issues: ValidationIssue[] = []
    if (!input || typeof input !== 'object') return { report: invalid('$', '结果必须是对象') }
    const raw = input as unknown as Record<string, unknown>
    const allowedRoot = new Set(['summary', 'requirementPoints', 'findings', 'testFocus', 'analysisDocument'])
    for (const key of Object.keys(raw)) if (!allowedRoot.has(key)) issues.push(issue(key, '不属于 requirement-analysis/v1 提交协议'))
    if (!Array.isArray(input.requirementPoints)) issues.push(issue('requirementPoints', '必须是数组'))
    if (!Array.isArray(input.findings)) issues.push(issue('findings', '必须是数组'))
    if (!Array.isArray(input.testFocus)) issues.push(issue('testFocus', '必须是数组'))
    if (issues.length) return { report: { valid: false, issues } }

    const temporaryIds = new Set<string>()
    const descriptions = new Set<string>()
    input.requirementPoints.forEach((point, position) => {
      const path = `requirementPoints[${position}]`
      if (!point || typeof point !== 'object') { issues.push(issue(path, '需求点必须是对象')); return }
      const rawPoint = point as unknown as Record<string, unknown>
      for (const key of Object.keys(rawPoint)) if (!['id', 'title', 'description', 'sourceTexts'].includes(key)) issues.push(issue(`${path}.${key}`, '模型只提交 id、title、description 和 sourceTexts'))
      const id = typeof point.id === 'string' ? point.id.trim() : ''
      if (!/^RP-\d{3,}$/u.test(id)) issues.push(issue(`${path}.id`, '必须使用 RP- 加至少三位数字的本次提交临时 ID'))
      else if (temporaryIds.has(id)) issues.push(issue(`${path}.id`, '需求点 ID 重复'))
      temporaryIds.add(id)
      const description = typeof point.description === 'string' ? point.description.trim().toLocaleLowerCase().replace(/\s+/gu, ' ') : ''
      if (description && descriptions.has(description)) issues.push(issue(`${path}.description`, '存在完全重复的需求点描述，请在同一 Agent Session 内完成去重'))
      if (description) descriptions.add(description)
    })
    if (issues.length) return { report: { valid: false, issues } }

    const normalizedPoints = await this.pointValidator.normalizeV5({
      requirementPoints: input.requirementPoints.map(point => ({ title: point.title, description: point.description, sourceTexts: point.sourceTexts })),
    }, snapshot, manifest)
    if (!normalizedPoints.report.valid || !normalizedPoints.result) return { report: normalizedPoints.report }
    if (normalizedPoints.result.requirementPoints.length !== input.requirementPoints.length) return { report: invalid('requirementPoints', '需求点规范化数量变化，请移除重复项后重新提交') }
    const referenceMap = new Map(input.requirementPoints.map((point, index) => [point.id.trim(), normalizedPoints.result!.requirementPoints[index].clientRequirementPointId]))

    const findings: CandidateRequirementReview['findings'] = []
    const findingKeys = new Set<string>()
    input.findings.forEach((finding, position) => {
      const path = `findings[${position}]`
      if (!finding || typeof finding !== 'object') { issues.push(issue(path, 'Finding 必须是对象')); return }
      const rawFinding = finding as unknown as Record<string, unknown>
      for (const key of Object.keys(rawFinding)) if (!['title', 'type', 'severity', 'confidence', 'requirementPointRefs', 'analysis', 'impact', 'suggestion'].includes(key)) issues.push(issue(`${path}.${key}`, '不属于最小 Finding 协议'))
      if (!Array.isArray(finding.requirementPointRefs) || finding.requirementPointRefs.some(reference => typeof reference !== 'string')) { issues.push(issue(`${path}.requirementPointRefs`, '必须是字符串数组；整体性问题使用空数组')); return }
      const refs = [...new Set(finding.requirementPointRefs.map(reference => reference.trim()).filter(Boolean))]
      const invalidRefs = refs.filter(reference => !referenceMap.has(reference))
      if (invalidRefs.length) issues.push(issue(`${path}.requirementPointRefs`, `引用了不存在的需求点：${invalidRefs.join('、')}`))
      const analysis = typeof finding.analysis === 'string' ? finding.analysis.trim() : ''
      if (!analysis) issues.push(issue(`${path}.analysis`, '分析内容不能为空'))
      if (!analysis || invalidRefs.length) return
      const formalRefs = refs.map(reference => referenceMap.get(reference)!)
      const key = `${formalRefs.slice().sort().join(',')}:${analysis.toLocaleLowerCase().replace(/\s+/gu, ' ')}`
      if (findingKeys.has(key)) return
      findingKeys.add(key)
      const impact = typeof finding.impact === 'string' ? finding.impact.trim() : ''
      const suggestion = typeof finding.suggestion === 'string' ? finding.suggestion.trim() : ''
      findings.push({
        clientFindingId: `F-${String(findings.length + 1).padStart(3, '0')}`,
        type: findingTypes.has(String(finding.type)) ? finding.type! : inferFindingType(analysis),
        severity: severities.has(String(finding.severity)) ? finding.severity! : inferFindingSeverity(analysis),
        confidence: Number.isFinite(finding.confidence) ? Math.min(1, Math.max(0, Number(finding.confidence))) : 0.75,
        title: typeof finding.title === 'string' && finding.title.trim() ? finding.title.trim().slice(0, 300) : generatedFindingTitle(analysis),
        description: analysis,
        impact: impact || '可能影响相关需求的实现、测试或验收一致性。',
        recommendation: suggestion || '请补充或确认相关业务规则和判定标准。',
        requirementPointRefs: formalRefs,
      })
    })

    const testFocus: RequirementAnalysisResult['testFocus'] = []
    const testFocusKeys = new Set<string>()
    input.testFocus.forEach((item, position) => {
      const path = `testFocus[${position}]`
      if (!item || typeof item !== 'object') { issues.push(issue(path, 'Test Focus 必须是对象')); return }
      const rawItem = item as unknown as Record<string, unknown>
      for (const key of Object.keys(rawItem)) if (!['title', 'description', 'requirementPointRefs'].includes(key)) issues.push(issue(`${path}.${key}`, '不属于 Test Focus 协议'))
      const title = typeof item.title === 'string' ? item.title.trim() : ''
      const description = typeof item.description === 'string' ? item.description.trim() : ''
      if (!title) issues.push(issue(`${path}.title`, '标题不能为空'))
      if (!description) issues.push(issue(`${path}.description`, '说明不能为空'))
      if (!Array.isArray(item.requirementPointRefs) || item.requirementPointRefs.some(reference => typeof reference !== 'string')) { issues.push(issue(`${path}.requirementPointRefs`, '必须是字符串数组')); return }
      const refs = [...new Set(item.requirementPointRefs.map(reference => reference.trim()).filter(Boolean))]
      const invalidRefs = refs.filter(reference => !referenceMap.has(reference))
      if (invalidRefs.length) issues.push(issue(`${path}.requirementPointRefs`, `引用了不存在的需求点：${invalidRefs.join('、')}`))
      if (!title || !description || invalidRefs.length) return
      const formalRefs = refs.map(reference => referenceMap.get(reference)!)
      const key = `${formalRefs.slice().sort().join(',')}:${title.toLocaleLowerCase()}:${description.toLocaleLowerCase().replace(/\s+/gu, ' ')}`
      if (testFocusKeys.has(key)) return
      testFocusKeys.add(key)
      testFocus.push({ id: `TF-${String(testFocus.length + 1).padStart(3, '0')}`, title: title.slice(0, 300), description, requirementPointRefs: formalRefs })
    })
    if (issues.length) return { report: { valid: false, issues } }

    const modelSummary = input.summary
    const overallAssessment = assessments.has(String(modelSummary?.overallAssessment)) ? modelSummary!.overallAssessment! : findings.length ? 'needs_revision' : 'pass'
    if (!findings.length && (overallAssessment === 'needs_revision' || overallAssessment === 'blocked')) return { report: invalid('findings', `总体结论为 ${overallAssessment} 时必须提交至少一条 Finding；整体性问题使用空 requirementPointRefs`) }
    const fallbackScore = findings.length ? Math.max(40, 100 - findings.length * 8) : 100
    const core = {
      ...normalizedPoints.result,
      summary: {
        overview: typeof modelSummary?.overview === 'string' && modelSummary.overview.trim() ? modelSummary.overview.trim() : `本次分析形成 ${normalizedPoints.result.requirementPoints.length} 个需求点、${findings.length} 个 Finding 和 ${testFocus.length} 个 Test Focus。`,
        businessGoals: cleanStrings(modelSummary?.businessGoals),
        overallAssessment,
        score: Number.isFinite(modelSummary?.score) ? Math.min(100, Math.max(0, Number(modelSummary?.score))) : fallbackScore,
        strengths: cleanStrings(modelSummary?.strengths),
        risks: cleanStrings(modelSummary?.risks),
      },
      findings,
      testFocus,
      ...(typeof input.analysisDocument === 'string' && input.analysisDocument.trim() ? { analysisDocument: input.analysisDocument.trim() } : {}),
    } satisfies Omit<RequirementAnalysisResult, 'artifacts'>
    const result: RequirementAnalysisResult = { ...core, artifacts: renderRequirementAnalysisArtifacts(core) }
    const report = await this.validate(result, snapshot, manifest)
    return { report, ...(report.valid ? { result } : {}) }
  }

  async validate(input: RequirementAnalysisResult, snapshot: ReviewRunSnapshot, manifest?: InputDeliveryManifest): Promise<ValidationReport> {
    const issues: ValidationIssue[] = []
    if (!input || typeof input !== 'object') return invalid('$', '结果必须是对象')
    const pointReport = await this.pointValidator.validate({ requirementPoints: input.requirementPoints, evidence: input.evidence, coverage: input.coverage }, snapshot, manifest)
    issues.push(...pointReport.issues)
    if (!assessments.has(input.summary?.overallAssessment)) issues.push(issue('summary.overallAssessment', '总体结论不合法'))
    if (!Number.isFinite(input.summary?.score) || input.summary.score < 0 || input.summary.score > 100) issues.push(issue('summary.score', '评分必须为 0～100'))
    if (typeof input.summary?.overview !== 'string' || !isStrings(input.summary?.businessGoals) || !isStrings(input.summary?.strengths) || !isStrings(input.summary?.risks)) issues.push(issue('summary', '摘要字段结构不合法'))
    const pointIds = new Set(input.requirementPoints.map(point => point.clientRequirementPointId))
    const findingIds = new Set<string>()
    const maxFindings = snapshot.agentDefinition.limits.maxFindings
    if (!Array.isArray(input.findings) || input.findings.length > maxFindings) issues.push(issue('findings', 'Finding 结构或数量不合法'))
    else input.findings.forEach((finding, position) => {
      const path = `findings[${position}]`
      if (!finding.clientFindingId || findingIds.has(finding.clientFindingId)) issues.push(issue(`${path}.clientFindingId`, 'Finding ID 为空或重复'))
      findingIds.add(finding.clientFindingId)
      if (!findingTypes.has(finding.type) || !severities.has(finding.severity)) issues.push(issue(path, 'Finding 类型或严重度不合法'))
      if (!Number.isFinite(finding.confidence) || finding.confidence < 0 || finding.confidence > 1) issues.push(issue(`${path}.confidence`, '置信度必须为 0～1'))
      for (const key of ['title', 'description', 'impact', 'recommendation'] as const) if (!finding[key]?.trim()) issues.push(issue(`${path}.${key}`, '字段不能为空'))
      if (!isStrings(finding.requirementPointRefs) || finding.requirementPointRefs.some(reference => !pointIds.has(reference))) issues.push(issue(`${path}.requirementPointRefs`, '引用必须全部指向当前结果内的需求点；整体性问题可以为空'))
    })
    if (!Array.isArray(input.testFocus)) issues.push(issue('testFocus', '必须是数组'))
    else {
      const ids = new Set<string>()
      input.testFocus.forEach((item, position) => {
        const path = `testFocus[${position}]`
        if (!item.id || ids.has(item.id)) issues.push(issue(`${path}.id`, 'Test Focus ID 为空或重复'))
        ids.add(item.id)
        if (!item.title?.trim() || !item.description?.trim()) issues.push(issue(path, 'Test Focus 标题和说明不能为空'))
        if (!isStrings(item.requirementPointRefs) || item.requirementPointRefs.some(reference => !pointIds.has(reference))) issues.push(issue(`${path}.requirementPointRefs`, '引用了不存在的需求点'))
      })
    }
    const expectedArtifactNames = new Set(['requirement-baseline.md', 'requirement-analysis-findings.md', 'requirement-analysis.md'])
    if (!Array.isArray(input.artifacts) || input.artifacts.length !== expectedArtifactNames.size) issues.push(issue('artifacts', '必须包含三个 Markdown Artifact'))
    else input.artifacts.forEach((artifact, position) => {
      if (!expectedArtifactNames.delete(artifact.fileName) || artifact.mediaType !== 'text/markdown' || !artifact.content || createHash('sha256').update(artifact.content).digest('hex') !== artifact.contentSha256) issues.push(issue(`artifacts[${position}]`, 'Artifact 名称、内容或 Hash 不合法'))
    })
    return { valid: issues.length === 0, issues }
  }
}

export class RequirementReviewValidator {
  normalizeV3(input: CandidateRequirementReviewV3, extraction: CandidateRequirementPointExtraction, snapshot: ReviewRunSnapshot): { report: ValidationReport; result?: CandidateRequirementReview } {
    const issues: ValidationIssue[] = []
    if (!input || typeof input !== 'object') return { report: invalid('$', '结果必须是对象') }
    const raw = input as unknown as Record<string, unknown>
    for (const key of Object.keys(raw)) if (key !== 'analyses' && key !== 'summary') issues.push(issue(key, '该字段由服务端生成；模型只提交 summary 和 analyses'))
    if (!Array.isArray(input.analyses)) issues.push(issue('analyses', '必须是数组'))
    if (issues.length) return { report: { valid: false, issues } }

    const requirementPointIds = new Set(extraction.requirementPoints.map(point => point.clientRequirementPointId))
    const deduplicated = new Map<string, CandidateRequirementReviewV3['analyses'][number]>()
    input.analyses.forEach((analysis, position) => {
      const path = `analyses[${position}]`
      if (!analysis || typeof analysis !== 'object') { issues.push(issue(path, '分析结果必须是对象')); return }
      const rawAnalysis = analysis as unknown as Record<string, unknown>
      for (const key of Object.keys(rawAnalysis)) if (!['requirementPointRef', 'analysis', 'title', 'type', 'severity', 'confidence', 'impact', 'recommendation'].includes(key)) issues.push(issue(`${path}.${key}`, '该字段由服务端生成或不属于最小评审协议'))
      const requirementPointRef = typeof analysis.requirementPointRef === 'string' ? analysis.requirementPointRef.trim() : ''
      const description = typeof analysis.analysis === 'string' ? analysis.analysis.trim() : ''
      const title = typeof analysis.title === 'string' ? analysis.title.trim() : ''
      const impact = typeof analysis.impact === 'string' ? analysis.impact.trim() : ''
      const recommendation = typeof analysis.recommendation === 'string' ? analysis.recommendation.trim() : ''
      if (!requirementPointIds.has(requirementPointRef)) issues.push(issue(`${path}.requirementPointRef`, `必须关联一个已冻结需求点；可用 ID：${[...requirementPointIds].join('、')}`))
      if (!description) issues.push(issue(`${path}.analysis`, '分析内容不能为空'))
      if (!requirementPointIds.has(requirementPointRef) || !description) return
      const key = `${requirementPointRef}:${description.toLocaleLowerCase().replace(/\s+/gu, ' ')}`
      if (!deduplicated.has(key)) deduplicated.set(key, {
        requirementPointRef,
        analysis: description,
        ...(title ? { title } : {}),
        ...(findingTypes.has(String(analysis.type)) ? { type: analysis.type } : {}),
        ...(severities.has(String(analysis.severity)) ? { severity: analysis.severity } : {}),
        ...(Number.isFinite(analysis.confidence) ? { confidence: Math.min(1, Math.max(0, Number(analysis.confidence))) } : {}),
        ...(impact ? { impact } : {}),
        ...(recommendation ? { recommendation } : {}),
      })
    })
    if (issues.length) return { report: { valid: false, issues } }

    const analyses = [...deduplicated.values()]
    const modelSummary = input.summary
    const overallAssessment = assessments.has(String(modelSummary?.overallAssessment)) ? modelSummary!.overallAssessment! : analyses.length ? 'needs_revision' : 'pass'
    if (!analyses.length && (overallAssessment === 'needs_revision' || overallAssessment === 'blocked')) {
      issues.push(issue('analyses', `总体结论为 ${overallAssessment} 时必须提交至少一条关联冻结需求点的分析`))
    }
    if (issues.length) return { report: { valid: false, issues } }
    const fallbackScore = analyses.length ? Math.max(40, 100 - analyses.length * 8) : 100
    const result: CandidateRequirementReview = {
      summary: {
        overallAssessment,
        score: Number.isFinite(modelSummary?.score) ? Math.min(100, Math.max(0, Number(modelSummary?.score))) : fallbackScore,
        strengths: isStrings(modelSummary?.strengths) ? modelSummary!.strengths.map(value => value.trim()).filter(Boolean) : analyses.length ? [] : ['未发现需要修正的需求问题'],
        risks: isStrings(modelSummary?.risks) ? modelSummary!.risks.map(value => value.trim()).filter(Boolean) : analyses.slice(0, 20).map(item => item.analysis),
      },
      findings: analyses.map((item, position) => ({
        clientFindingId: `F-${String(position + 1).padStart(3, '0')}`,
        type: item.type ?? inferFindingType(item.analysis),
        severity: item.severity ?? inferFindingSeverity(item.analysis),
        confidence: item.confidence ?? 0.75,
        title: item.title ?? generatedFindingTitle(item.analysis),
        description: item.analysis,
        impact: item.impact ?? '可能影响关联需求点的实现、测试或验收一致性。',
        recommendation: item.recommendation ?? '请补充或确认该需求点的相关约束。',
        requirementPointRefs: [item.requirementPointRef],
      })),
    }
    const report = this.validateSynchronously(result, extraction, snapshot)
    return { report, ...(report.valid ? { result } : {}) }
  }

  async validate(input: CandidateRequirementReview, extraction: CandidateRequirementPointExtraction, snapshot: ReviewRunSnapshot): Promise<ValidationReport> {
    return this.validateSynchronously(input, extraction, snapshot)
  }

  private validateSynchronously(input: CandidateRequirementReview, extraction: CandidateRequirementPointExtraction, snapshot: ReviewRunSnapshot): ValidationReport {
    const issues: ValidationIssue[] = []
    if (!input || typeof input !== 'object') return invalid('$', '结果必须是对象')
    if ('requirementPoints' in input || 'evidence' in input || 'coverage' in input) issues.push(issue('$', '需求分析结果不得增删或改写固定需求点、证据和覆盖范围'))
    if (!assessments.has(input.summary?.overallAssessment)) issues.push(issue('summary.overallAssessment', '总体结论不合法'))
    if (!Number.isFinite(input.summary?.score) || input.summary.score < 0 || input.summary.score > 100) issues.push(issue('summary.score', '评分必须为 0～100'))
    for (const key of ['strengths', 'risks'] as const) if (!isStrings(input.summary?.[key])) issues.push(issue(`summary.${key}`, '必须是字符串数组'))
    if (!Array.isArray(input.findings)) issues.push(issue('findings', '必须是数组'))
    if (issues.length) return { valid: false, issues }
    const requirementPointIds = new Set(extraction.requirementPoints.map(point => point.clientRequirementPointId))
    const findingIds = new Set<string>()
    const maxFindings = snapshot.agentDefinition.limits.maxFindings
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

function generatedFindingTitle(analysis: string) {
  return analysis.trim().split(/[。！？.!?\r\n]/u)[0].slice(0, 300) || '需求点分析结果'
}

function inferFindingType(analysis: string): ReviewFindingType {
  if (/安全|权限|鉴权|越权|泄露/u.test(analysis)) return 'security_risk'
  if (/冲突|矛盾|不一致/u.test(analysis)) return 'conflict'
  if (/状态|流转|迁移/u.test(analysis)) return 'state_gap'
  if (/异常|失败|回滚|重试/u.test(analysis)) return 'exception_gap'
  if (/边界|范围|上限|下限/u.test(analysis)) return 'boundary_gap'
  if (/验收|测试|不可验证/u.test(analysis)) return 'testability_gap'
  if (/依赖|前置/u.test(analysis)) return 'dependency_risk'
  if (/缺少|缺失|未提供/u.test(analysis)) return 'missing_requirement'
  if (/歧义|不明确|未定义|不清楚/u.test(analysis)) return 'ambiguity'
  return 'other'
}

function inferFindingSeverity(analysis: string): ReviewSeverity {
  if (/阻断|无法实现|数据丢失|越权|泄露/u.test(analysis)) return 'blocker'
  if (/严重|高风险/u.test(analysis)) return 'high'
  if (/提示|轻微|低风险/u.test(analysis)) return 'low'
  return 'medium'
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

function generatedRequirementPointTitle(point: CandidateRequirementPointExtractionV3['requirementPoints'][number] | CandidateRequirementPointExtractionV4['requirementPoints'][number]) {
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
function cleanStrings(value: unknown) { return isStrings(value) ? [...new Set(value.map(item => item.trim()).filter(Boolean))] : [] }
