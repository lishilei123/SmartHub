import { createHash } from 'node:crypto'
import type { RequirementAnalysisArtifact, RequirementAnalysisResult } from '../domain/review-types.js'

type ArtifactSource = Omit<RequirementAnalysisResult, 'artifacts'>

export function renderRequirementAnalysisArtifacts(result: ArtifactSource): RequirementAnalysisArtifact[] {
  const pointsById = new Map(result.requirementPoints.map(point => [point.clientRequirementPointId, point]))
  const evidenceById = new Map(result.evidence.map(item => [item.clientEvidenceId, item]))
  const answeredClarifications = result.clarifications.filter(item => item.status === 'answered')
  const dismissedClarifications = result.clarifications.filter(item => item.status === 'dismissed')
  const baseline = [
    '# Requirement Baseline', '',
    ...result.requirementPoints.flatMap(point => [
      `## ${safe(point.clientRequirementPointId)} · ${safe(point.title)}`, '',
      safe(point.description), '',
      `- Evidence：${point.evidenceRefs.join('、') || '无'}`,
      ...point.evidenceRefs.flatMap(id => {
        const evidence = evidenceById.get(id)
        return evidence ? [`  - ${id} · ${safe(evidence.quote)}`] : []
      }),
      '',
    ]),
    '## Formal Clarifications', '',
    ...(answeredClarifications.length ? answeredClarifications.flatMap(item => [
      `### ${safe(item.id)} · Formal Business Fact`, '',
      `- Question：${safe(item.question)}`,
      `- Answer：${safe(item.answer ?? '')}`,
      `- Requirement Points：${item.requirementPointRefs.join('、') || '整体'}`,
      `- Confirmed By：${safe(item.answeredBy ?? 'unknown')} · ${item.answeredAt ?? ''}`,
      '',
    ]) : ['没有额外确认的 Formal Clarification。', '']),
    '## Known Fact Gaps / Human Dispositions', '',
    ...(dismissedClarifications.length ? dismissedClarifications.flatMap(item => [
      `### ${safe(item.id)} · Human Disposition Only`, '',
      `- Question：${safe(item.question)}`,
      `- Disposition：${safe(item.answer ?? '')}`,
      `- Requirement Points：${item.requirementPointRefs.join('、') || '整体'}`,
      '- 该处置不构成业务规则、权限、边界或 Expected Result；相关事实缺口必须保留。',
      '',
    ]) : ['没有已人工处置的事实缺口。', '']),
  ].join('\n')

  const findings = [
    '# Requirement Analysis Findings', '',
    '## Summary', '',
    safe(result.summary.overview), '',
    `- Overall Assessment：${result.summary.overallAssessment}`,
    `- Score：${result.summary.score}`,
    ...result.summary.risks.map(item => `- Risk：${safe(item)}`), '',
    '## Findings', '',
    ...(result.findings.length ? result.findings.flatMap(finding => [
      `### ${safe(finding.clientFindingId)} · ${safe(finding.title)}`, '',
      `- Type / Severity：${finding.type} / ${finding.severity}`,
      `- Requirement Points：${finding.requirementPointRefs.join('、') || '整体性问题'}`,
      `- Analysis：${safe(finding.description)}`,
      `- Impact：${safe(finding.impact)}`,
      `- Suggestion：${safe(finding.recommendation)}`, '',
    ]) : ['未发现需要处理的 Finding。', '']),
    '## Clarifications', '',
    ...(result.clarifications.length ? result.clarifications.flatMap(item => [
      `### ${safe(item.id)} · ${item.blocking ? 'Blocking' : 'Advisory'} · ${item.status}`, '',
      `- Question：${safe(item.question)}`,
      `- Reason：${safe(item.reason)}`,
      `- Requirement Points：${item.requirementPointRefs.join('、') || '整体'}`,
      ...(item.status === 'answered' && item.answer ? [`- Formal Business Fact：${safe(item.answer)}`, `- Confirmed By：${safe(item.answeredBy ?? 'unknown')} · ${item.answeredAt ?? ''}`] : []),
      ...(item.status === 'dismissed' && item.answer ? [`- Human Disposition：${safe(item.answer)}`, '- 处置理由不作为业务规则；相关事实缺口保留。', `- Disposed By：${safe(item.answeredBy ?? 'unknown')} · ${item.answeredAt ?? ''}`] : []), '',
    ]) : ['没有需要人工确认的问题。', '']),
    '## Test Focus', '',
    ...result.testFocus.map(item => `- ${safe(item.id)} · ${safe(item.title)}：${safe(item.description)}（${item.requirementPointRefs.join('、') || '整体'}）`),
  ].join('\n')

  const analysis = [
    '# 需求分析报告', '',
    '## 1. 需求概述', '', safe(result.summary.overview), '',
    '## 2. 业务目标', '', ...(result.summary.businessGoals.length ? result.summary.businessGoals.map(item => `- ${safe(item)}`) : ['- 未在当前需求中明确说明。']), '',
    '## 3. 核心业务流程', '', safe(result.analysisDocument || '结构化结果未附加独立流程说明；请结合 Requirement Baseline 与 Test Focus 阅读。'), '',
    '## 4. Requirement Baseline', '',
    ...result.requirementPoints.map(point => `- ${point.clientRequirementPointId} · ${safe(point.title)}：${safe(point.description)}`), '',
    '## 5. 核心业务规则', '',
    ...result.requirementPoints.filter(point => point.businessRules.length).flatMap(point => point.businessRules.map(rule => `- ${point.clientRequirementPointId}：${safe(rule)}`)),
    ...(result.requirementPoints.some(point => point.businessRules.length) ? [] : ['- 统一结果采用自然语言需求点作为业务语义基线，未强制拆填独立 businessRules 字段。']), '',
    '## 6. 需求问题', '',
    ...result.findings.map(finding => `- [${finding.type}/${finding.severity}] ${finding.clientFindingId} · ${safe(finding.title)}：${safe(finding.description)}（${finding.requirementPointRefs.join('、') || '整体性问题'}）`),
    ...(result.findings.length ? [] : ['- 未发现需要处理的问题。']), '',
    '## 7. 风险与待确认事项', '',
    ...(result.summary.risks.length ? result.summary.risks.map(item => `- ${safe(item)}`) : ['- 无。']), '',
    ...result.clarifications.flatMap(item => item.status === 'answered'
      ? [`- [formal_business_fact/${item.blocking ? 'blocking' : 'advisory'}] ${safe(item.question)} → ${safe(item.answer ?? '')}`]
      : item.status === 'dismissed'
        ? [`- [human_disposition/${item.blocking ? 'blocking' : 'advisory'}] ${safe(item.question)}；处置：${safe(item.answer ?? '')}（不作为业务规则，事实缺口保留）`]
        : [`- [pending/${item.blocking ? 'blocking' : 'advisory'}] ${safe(item.question)}`]),
    ...(result.clarifications.length ? [] : ['- 无待确认问题。']), '',
    '## 8. Test Focus', '',
    ...result.testFocus.map(item => `- ${item.id} · ${safe(item.title)}：${safe(item.description)}`), '',
    '## 9. Traceability', '',
    ...result.findings.flatMap(finding => finding.requirementPointRefs.flatMap(reference => {
      const point = pointsById.get(reference)
      return point ? [`- ${finding.clientFindingId} → ${reference} → ${point.evidenceRefs.join('、') || '无 Evidence'}`] : []
    })),
  ].join('\n')

  return [artifact('requirement-baseline.md', baseline), artifact('requirement-analysis-findings.md', findings), artifact('requirement-analysis.md', analysis)]
}

function artifact(fileName: RequirementAnalysisArtifact['fileName'], content: string): RequirementAnalysisArtifact {
  return { fileName, mediaType: 'text/markdown', content, contentSha256: createHash('sha256').update(content).digest('hex') }
}

function safe(value: string) {
  return value.replace(/[<>]/gu, character => character === '<' ? '&lt;' : '&gt;').trim()
}
