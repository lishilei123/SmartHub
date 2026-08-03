import { randomUUID } from 'node:crypto'
import type { ValidationIssue } from '../domain/review-types.js'
import type { TechnicalSolutionEvidence, TechnicalSolutionFormalResult, TechnicalSolutionReviewCandidateV1, TechnicalSolutionReviewSubmissionV1, TechnicalSolutionRunSnapshot } from '../domain/technical-solution-types.js'
import type { DatabaseState } from '../domain/types.js'

const coverageStatuses = new Set(['covered', 'partially_covered', 'not_covered', 'needs_confirmation'])
const findingTypes = new Set(['requirement_coverage_gap', 'architecture_gap', 'interface_gap', 'data_gap', 'exception_gap', 'non_functional_gap', 'conflict', 'risk', 'other'])
const severities = new Set(['blocker', 'high', 'medium', 'low'])
const assessments = new Set(['pass', 'pass_with_notes', 'needs_revision', 'blocked'])
const assessmentAliases = new Map<string, TechnicalSolutionReviewCandidateV1['summary']['overallAssessment']>([
  ['passed', 'pass'], ['approved', 'pass'], ['passed_with_findings', 'pass_with_notes'], ['pass_with_findings', 'pass_with_notes'],
  ['conditional_pass', 'pass_with_notes'], ['conditionally_passed', 'pass_with_notes'], ['revision_required', 'needs_revision'],
  ['revise', 'needs_revision'], ['failed', 'needs_revision'], ['fail', 'needs_revision'], ['rejected', 'blocked'],
])
const coverageAliases = new Map<string, TechnicalSolutionReviewCandidateV1['coverageCandidates'][number]['status']>([
  ['fully_covered', 'covered'], ['complete', 'covered'], ['partial', 'partially_covered'], ['partially', 'partially_covered'],
  ['uncovered', 'not_covered'], ['missing', 'not_covered'], ['unknown', 'needs_confirmation'], ['uncertain', 'needs_confirmation'],
])
const findingTypeAliases = new Map<string, TechnicalSolutionReviewCandidateV1['findings'][number]['type']>([
  ['logic_error', 'architecture_gap'], ['logic_gap', 'architecture_gap'], ['business_logic_gap', 'architecture_gap'],
  ['implementation_gap', 'architecture_gap'], ['integration_gap', 'interface_gap'], ['api_gap', 'interface_gap'],
  ['schema_gap', 'data_gap'], ['database_gap', 'data_gap'], ['error_handling_gap', 'exception_gap'],
  ['security_gap', 'non_functional_gap'], ['performance_gap', 'non_functional_gap'], ['reliability_gap', 'non_functional_gap'],
])
const severityAliases = new Map<string, TechnicalSolutionReviewCandidateV1['findings'][number]['severity']>([
  ['critical', 'blocker'], ['fatal', 'blocker'], ['major', 'high'], ['moderate', 'medium'], ['normal', 'medium'],
  ['minor', 'low'], ['info', 'low'], ['informational', 'low'],
])

export class TechnicalSolutionResultValidator {
  normalize(submission: TechnicalSolutionReviewSubmissionV1, snapshot: TechnicalSolutionRunSnapshot, state: DatabaseState) {
    const candidate = normalizeSubmission(submission)
    const issues: ValidationIssue[] = []
    validateShape(candidate, snapshot, issues)
    if (issues.length) return { report: { valid: false, issues } }
    const evidence = new Map<string, TechnicalSolutionEvidence>()
    const evidenceKey = new Map<string, string>()
    const add = (value: Omit<TechnicalSolutionEvidence, 'id'>) => {
      const key = `${value.sourceKind}:${value.assetVersionId}:${value.chunkId}:${value.quote}:${value.startLine}:${value.endLine}`
      const existing = evidenceKey.get(key)
      if (existing) return existing
      const id = `tech_evidence_${randomUUID()}`
      evidenceKey.set(key, id)
      evidence.set(id, { id, ...value })
      return id
    }
    const resolveRequirement = (texts: string[], path: string) => {
      const matches = snapshot.requirementBaseline.evidence.filter(item => texts.some(text => cluesOverlap(item.quote, text)))
      const pointIds = new Set(matches.map(item => item.requirementPointId))
      if (pointIds.size > 1) issues.push({ path, message: '需求原文线索关联到多个需求点，请仅保留一个需求点的逐字原文' })
      const evidenceIds = pointIds.size === 1 ? matches.map(match => add({ sourceKind: 'requirement', assetId: match.assetId, assetVersionId: match.assetVersionId, chunkId: match.chunkId, contentSha256: match.contentSha256, headingPath: match.headingPath, quote: match.quote, startLine: match.startLine, endLine: match.endLine })) : []
      return { pointIds: [...pointIds], evidenceIds }
    }
    const resolveSolution = (texts: string[], path: string) => {
      const evidenceIds: string[] = []
      texts.forEach((text, index) => {
        const resolved = resolveSolutionClue(text, snapshot, state)
        if (resolved.matches.length > 1) { issues.push({ path: `${path}[${index}]`, message: '技术方案原文线索存在歧义，请提供更长的逐字原文' }); return }
        if (!resolved.matches.length) return
        const match = resolved.matches[0]
        evidenceIds.push(add({ sourceKind: 'technical_design', assetId: match.asset.id, assetVersionId: match.input.assetVersionId, chunkId: match.chunk.id, contentSha256: match.input.contentSha256, headingPath: match.chunk.headingPath, quote: match.quote, startLine: match.line.start, endLine: match.line.end }))
      })
      return evidenceIds
    }
    const coverage = candidate.coverageCandidates.map((item, index) => {
      const requirement = resolveRequirement(item.requirementSourceTexts, `coverageCandidates[${index}].requirementSourceTexts`)
      const solutionEvidenceIds = resolveSolution(item.solutionSourceTexts, `coverageCandidates[${index}].solutionSourceTexts`)
      if (requirement.pointIds.length !== 1) issues.push({ path: `coverageCandidates[${index}].requirementSourceTexts`, message: '每条覆盖候选必须唯一关联一个冻结需求点' })
      if (['covered', 'partially_covered'].includes(item.status) && !solutionEvidenceIds.length) issues.push({ path: `coverageCandidates[${index}].solutionSourceTexts`, message: '已覆盖或部分覆盖必须提供固定技术方案中的逐字原文' })
      return { id: `tech_coverage_${randomUUID()}`, requirementPointId: requirement.pointIds[0] ?? '', requirementTitle: snapshot.requirementBaseline.requirementPoints.find(point => point.id === requirement.pointIds[0])?.title ?? '', status: item.status, analysis: item.analysis.trim(), evidenceIds: [...requirement.evidenceIds, ...solutionEvidenceIds] }
    })
    const findings = candidate.findings.map((item, index) => {
      const requirement = resolveRequirement(item.requirementSourceTexts, `findings[${index}].requirementSourceTexts`)
      const solutionEvidenceIds = resolveSolution(item.solutionSourceTexts, `findings[${index}].solutionSourceTexts`)
      if (!requirement.evidenceIds.length && !solutionEvidenceIds.length) issues.push({ path: `findings[${index}]`, message: 'Finding 必须至少有需求或技术方案 Evidence' })
      if (item.type === 'requirement_coverage_gap' && !requirement.pointIds.length) issues.push({ path: `findings[${index}].requirementSourceTexts`, message: '需求覆盖缺口必须关联需求点' })
      return { id: `tech_finding_${randomUUID()}`, type: item.type, severity: item.severity, title: item.title.trim(), problem: item.problem.trim(), impact: item.impact.trim(), recommendation: item.recommendation.trim(), confidence: item.confidence, requirementPointIds: requirement.pointIds, evidenceIds: [...requirement.evidenceIds, ...solutionEvidenceIds] }
    })
    const risks = candidate.risks.map((item, index) => {
      const requirement = resolveRequirement(item.requirementSourceTexts, `risks[${index}].requirementSourceTexts`)
      const solution = resolveSolution(item.solutionSourceTexts, `risks[${index}].solutionSourceTexts`)
      return { id: `tech_risk_${randomUUID()}`, description: item.description.trim(), impact: item.impact.trim(), mitigation: item.mitigation.trim(), evidenceIds: [...requirement.evidenceIds, ...solution] }
    })
    const questions = candidate.questions.map((item, index) => {
      const requirement = resolveRequirement(item.requirementSourceTexts, `questions[${index}].requirementSourceTexts`)
      const solution = resolveSolution(item.solutionSourceTexts, `questions[${index}].solutionSourceTexts`)
      return { id: `tech_question_${randomUUID()}`, question: item.question.trim(), reason: item.reason.trim(), evidenceIds: [...requirement.evidenceIds, ...solution] }
    })
    const counts = new Map<string, number>()
    coverage.forEach(item => counts.set(item.requirementPointId, (counts.get(item.requirementPointId) ?? 0) + 1))
    snapshot.requirementBaseline.requirementPoints.forEach(point => { if (counts.get(point.id) !== 1) issues.push({ path: 'coverageCandidates', message: `需求点 ${point.id} 必须恰好有一条覆盖结论` }) })
    if (coverage.some(item => !snapshot.requirementBaseline.requirementPoints.some(point => point.id === item.requirementPointId))) issues.push({ path: 'coverageCandidates', message: '覆盖候选包含基线外需求点' })
    if (issues.length) return { report: { valid: false, issues } }
    const statistics = {
      totalRequirements: coverage.length,
      covered: coverage.filter(item => item.status === 'covered').length,
      partiallyCovered: coverage.filter(item => item.status === 'partially_covered').length,
      notCovered: coverage.filter(item => item.status === 'not_covered').length,
      needsConfirmation: coverage.filter(item => item.status === 'needs_confirmation').length,
      coverageRatio: coverage.length ? (coverage.filter(item => item.status === 'covered').length + 0.5 * coverage.filter(item => item.status === 'partially_covered').length) / coverage.length : 0,
    }
    const result: TechnicalSolutionFormalResult = { schemaVersion: 'technical-solution-review-result/v1', summary: structuredClone(candidate.summary), coverage, findings, evidence: [...evidence.values()], risks, questions, statistics }
    return { report: { valid: true, issues: [] as ValidationIssue[] }, result }
  }
}

function validateShape(candidate: TechnicalSolutionReviewCandidateV1, snapshot: TechnicalSolutionRunSnapshot, issues: ValidationIssue[]) {
  if (!candidate || typeof candidate !== 'object') { issues.push({ path: '', message: 'Candidate 必须是对象' }); return }
  if (candidate.schemaVersion !== 'technical-solution-review/v1') issues.push({ path: 'schemaVersion', message: '必须为 technical-solution-review/v1' })
  if (!candidate.summary || !assessments.has(candidate.summary.overallAssessment)) issues.push({ path: 'summary.overallAssessment', message: '总体结论无效' })
  for (const field of ['coverageCandidates', 'findings', 'risks', 'questions'] as const) if (!Array.isArray(candidate[field])) issues.push({ path: field, message: '必须是数组' })
  if (issues.length) return
  if (candidate.findings.length > snapshot.agentDefinition.limits.maxFindings) issues.push({ path: 'findings', message: 'Finding 数量超过运行限制' })
  candidate.coverageCandidates.forEach((item, index) => {
    if (!coverageStatuses.has(item.status)) issues.push({ path: `coverageCandidates[${index}].status`, message: '覆盖状态无效' })
    if (!clean(item.analysis)) issues.push({ path: `coverageCandidates[${index}].analysis`, message: '覆盖分析不能为空' })
    if (!Array.isArray(item.requirementSourceTexts) || !item.requirementSourceTexts.length) issues.push({ path: `coverageCandidates[${index}].requirementSourceTexts`, message: '需求原文线索不能为空' })
  })
  candidate.findings.forEach((item, index) => {
    if (!findingTypes.has(item.type)) issues.push({ path: `findings[${index}].type`, message: 'Finding 类型无效' })
    if (!severities.has(item.severity)) issues.push({ path: `findings[${index}].severity`, message: '严重度无效' })
    if (![item.title, item.problem, item.impact, item.recommendation].every(clean)) issues.push({ path: `findings[${index}]`, message: '标题、问题、影响和建议不能为空' })
    if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) issues.push({ path: `findings[${index}].confidence`, message: '置信度必须在 0 到 1 之间' })
  })
}

function normalizeSubmission(submission: TechnicalSolutionReviewSubmissionV1) {
  const candidate = structuredClone(submission) as unknown as TechnicalSolutionReviewCandidateV1
  if (!candidate || typeof candidate !== 'object') return candidate
  if (Array.isArray(candidate.coverageCandidates)) candidate.coverageCandidates.forEach(item => { item.status = canonicalCoverageStatus(String(item.status)) })
  if (Array.isArray(candidate.findings)) candidate.findings.forEach(item => {
    item.type = canonicalFindingType(String(item.type), item)
    item.severity = canonicalSeverity(String(item.severity), item)
  })
  if (candidate.summary && typeof candidate.summary === 'object') candidate.summary.overallAssessment = canonicalAssessment(String(candidate.summary.overallAssessment), candidate.findings ?? [])
  return candidate
}

function canonicalAssessment(value: string, findings: TechnicalSolutionReviewCandidateV1['findings']) {
  const key = enumKey(value)
  if (assessments.has(key)) return key as TechnicalSolutionReviewCandidateV1['summary']['overallAssessment']
  return assessmentAliases.get(key) ?? (findings.length ? 'needs_revision' : 'pass_with_notes')
}

function canonicalCoverageStatus(value: string) {
  const key = enumKey(value)
  if (coverageStatuses.has(key)) return key as TechnicalSolutionReviewCandidateV1['coverageCandidates'][number]['status']
  return coverageAliases.get(key) ?? 'needs_confirmation'
}

function canonicalFindingType(value: string, finding: TechnicalSolutionReviewSubmissionV1['findings'][number]) {
  const key = enumKey(value)
  if (findingTypes.has(key)) return key as TechnicalSolutionReviewCandidateV1['findings'][number]['type']
  const alias = findingTypeAliases.get(key)
  if (alias) return alias
  const text = normalize(`${finding.title} ${finding.problem} ${finding.impact} ${finding.recommendation}`).toLocaleLowerCase()
  if (/接口|api|契约|协议/u.test(text)) return 'interface_gap'
  if (/数据|数据库|字段|表结构|schema/u.test(text)) return 'data_gap'
  if (/异常|错误|超时|重试|补偿/u.test(text)) return 'exception_gap'
  if (/性能|安全|可靠|容量|可用性|监控/u.test(text)) return 'non_functional_gap'
  if (/冲突|矛盾/u.test(text)) return 'conflict'
  if (/风险/u.test(text)) return 'risk'
  return 'other'
}

function canonicalSeverity(value: string, finding: TechnicalSolutionReviewSubmissionV1['findings'][number]) {
  const key = enumKey(value)
  if (severities.has(key)) return key as TechnicalSolutionReviewCandidateV1['findings'][number]['severity']
  const alias = severityAliases.get(key)
  if (alias) return alias
  const text = normalize(`${finding.title} ${finding.problem} ${finding.impact}`).toLocaleLowerCase()
  if (/阻断|无法上线|数据丢失|越权|严重安全/u.test(text)) return 'blocker'
  if (/严重|核心流程|不可用/u.test(text)) return 'high'
  if (/轻微|建议优化|体验/u.test(text)) return 'low'
  return 'medium'
}

function enumKey(value: string) { return value.normalize('NFKC').trim().toLocaleLowerCase().replace(/[\s-]+/gu, '_') }

function cluesOverlap(reference: string, clue: string) {
  const normalizedReference = normalize(reference)
  const normalizedClue = normalize(clue)
  return normalizedReference.length >= 4 && normalizedClue.length >= 4 && (normalizedReference.includes(normalizedClue) || normalizedClue.includes(normalizedReference))
}

type SolutionMatch = {
  input: TechnicalSolutionRunSnapshot['solutionInputs'][number]
  asset: DatabaseState['assets'][number]
  chunk: DatabaseState['versions'][number]['chunks'][number]
  quote: string
  line: { start: number; end: number }
}

function resolveSolutionClue(text: string, snapshot: TechnicalSolutionRunSnapshot, state: DatabaseState): { matches: SolutionMatch[] } {
  const fragments = clueFragments(text)
  let ambiguous: { matches: SolutionMatch[] } | undefined
  for (const fragment of fragments) {
    const matches: SolutionMatch[] = snapshot.solutionInputs.flatMap(input => {
      const version = state.versions.find(item => item.id === input.assetVersionId && item.contentHash === input.contentSha256)
      const asset = state.assets.find(item => item.id === input.assetId)
      if (!version || !asset) return []
      const located = locateFixedQuote(version.content, fragment)
      if (!located) return []
      return version.chunks.filter(chunk => containsEquivalent(chunk.content, fragment)).map(chunk => ({ input, asset, chunk, quote: located.quote, line: located.line }))
    })
    if (matches.length === 1) return { matches }
    if (matches.length > 1 && !ambiguous) ambiguous = { matches }
  }
  return ambiguous ?? { matches: [] }
}

function clueFragments(text: string) {
  const values = [text, ...text.split(/(?:\.{3,}|…+)/u)]
    .map(value => value.trim())
    .filter(value => normalize(value).length >= 4)
    .sort((left, right) => right.length - left.length)
  const seen = new Set<string>()
  return values.filter(value => { const key = normalize(value); if (seen.has(key)) return false; seen.add(key); return true })
}

function clean(value: unknown) { return typeof value === 'string' && Boolean(value.trim()) }
function normalize(value: string) { return value.normalize('NFKC').replace(/\s+/gu, ' ').trim() }
function containsEquivalent(content: string, text: string) { const needle = normalize(text); return needle.length >= 4 && normalize(content).includes(needle) }
function locateFixedQuote(content: string, text: string) {
  const exact = content.indexOf(text)
  if (exact >= 0) {
    const start = content.slice(0, exact).split(/\r?\n/u).length
    return { quote: text, line: { start, end: start + text.split(/\r?\n/u).length - 1 } }
  }
  const needle = normalize(text)
  const lines = content.split(/\r?\n/u)
  const matches = lines.flatMap((line, index) => normalize(line).includes(needle) ? [{ quote: line.trim(), line: { start: index + 1, end: index + 1 } }] : [])
  return matches.length === 1 ? matches[0] : undefined
}
