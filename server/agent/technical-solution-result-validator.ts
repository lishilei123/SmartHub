import { randomUUID } from 'node:crypto'
import type { ValidationIssue } from '../domain/review-types.js'
import type { TechnicalSolutionEvidence, TechnicalSolutionFormalResult, TechnicalSolutionReviewCandidateV1, TechnicalSolutionRunSnapshot } from '../domain/technical-solution-types.js'
import type { DatabaseState } from '../domain/types.js'

const coverageStatuses = new Set(['covered', 'partially_covered', 'not_covered', 'needs_confirmation'])
const findingTypes = new Set(['requirement_coverage_gap', 'architecture_gap', 'interface_gap', 'data_gap', 'exception_gap', 'non_functional_gap', 'conflict', 'risk', 'other'])
const severities = new Set(['blocker', 'high', 'medium', 'low'])
const assessments = new Set(['pass', 'pass_with_notes', 'needs_revision', 'blocked'])

export class TechnicalSolutionResultValidator {
  normalize(candidate: TechnicalSolutionReviewCandidateV1, snapshot: TechnicalSolutionRunSnapshot, state: DatabaseState) {
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
      const pointIds = new Set<string>()
      const evidenceIds: string[] = []
      texts.forEach((text, index) => {
        const matches = snapshot.requirementBaseline.evidence.filter(item => containsEquivalent(item.quote, text))
        if (matches.length !== 1) { issues.push({ path: `${path}[${index}]`, message: matches.length ? '需求原文线索存在歧义' : '需求原文线索不在冻结基线中' }); return }
        const match = matches[0]
        pointIds.add(match.requirementPointId)
        evidenceIds.push(add({ sourceKind: 'requirement', assetId: match.assetId, assetVersionId: match.assetVersionId, chunkId: match.chunkId, contentSha256: match.contentSha256, headingPath: match.headingPath, quote: text, startLine: match.startLine, endLine: match.endLine }))
      })
      return { pointIds: [...pointIds], evidenceIds }
    }
    const resolveSolution = (texts: string[], path: string) => {
      const evidenceIds: string[] = []
      texts.forEach((text, index) => {
        const matches = snapshot.solutionInputs.flatMap(input => {
          const version = state.versions.find(item => item.id === input.assetVersionId)
          const asset = state.assets.find(item => item.id === input.assetId)
          if (!version || !asset || !containsEquivalent(version.content, text)) return []
          const chunks = version.chunks.filter(chunk => containsEquivalent(chunk.content, text))
          const line = locateLine(version.content, text)
          return chunks.map(chunk => ({ input, asset, chunk, line }))
        })
        if (matches.length !== 1) { issues.push({ path: `${path}[${index}]`, message: matches.length ? '技术方案原文线索存在歧义，请提供更长原文' : '技术方案原文线索不在固定输入中' }); return }
        const match = matches[0]
        evidenceIds.push(add({ sourceKind: 'technical_design', assetId: match.asset.id, assetVersionId: match.input.assetVersionId, chunkId: match.chunk.id, contentSha256: match.input.contentSha256, headingPath: match.chunk.headingPath, quote: text, startLine: match.line.start, endLine: match.line.end }))
      })
      return evidenceIds
    }
    const coverage = candidate.coverageCandidates.map((item, index) => {
      const requirement = resolveRequirement(item.requirementSourceTexts, `coverageCandidates[${index}].requirementSourceTexts`)
      const solutionEvidenceIds = resolveSolution(item.solutionSourceTexts, `coverageCandidates[${index}].solutionSourceTexts`)
      if (requirement.pointIds.length !== 1) issues.push({ path: `coverageCandidates[${index}].requirementSourceTexts`, message: '每条覆盖候选必须唯一关联一个冻结需求点' })
      if (['covered', 'partially_covered'].includes(item.status) && !solutionEvidenceIds.length) issues.push({ path: `coverageCandidates[${index}].solutionSourceTexts`, message: '已覆盖或部分覆盖必须提供技术方案 Evidence' })
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

function clean(value: unknown) { return typeof value === 'string' && Boolean(value.trim()) }
function normalize(value: string) { return value.normalize('NFKC').replace(/\s+/gu, ' ').trim() }
function containsEquivalent(content: string, text: string) { const needle = normalize(text); return needle.length >= 4 && normalize(content).includes(needle) }
function locateLine(content: string, text: string) {
  const exact = content.indexOf(text)
  if (exact < 0) return { start: 1, end: 1 }
  const start = content.slice(0, exact).split(/\r?\n/u).length
  return { start, end: start + text.split(/\r?\n/u).length - 1 }
}
