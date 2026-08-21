import { createHash } from 'node:crypto'
import type { RequirementAnalysisArtifact, RequirementAnalysisResult } from '../domain/review-types.js'

type ArtifactSource = Omit<RequirementAnalysisResult, 'artifacts'>

export function renderRequirementAnalysisArtifacts(result: ArtifactSource): RequirementAnalysisArtifact[] {
  const pointsById = new Map(result.requirementPoints.map(point => [point.clientRequirementPointId, point]))
  const evidenceById = new Map(result.evidence.map(item => [item.clientEvidenceId, item]))
  const answeredClarifications = result.clarifications.filter(item => item.status === 'answered')
  const dismissedClarifications = result.clarifications.filter(item => item.status === 'dismissed')
  const analysis = [
    '# 需求分析报告', '',
    '## 1. 需求概述', '', safe(result.summary.overview), '',
    '## 2. 业务目标', '', ...(result.summary.businessGoals.length ? result.summary.businessGoals.map(item => `- ${safe(item)}`) : ['- 未在当前需求中明确说明。']), '',
    '## 3. 核心业务流程', '', safe(result.analysisDocument || '结构化结果未附加独立流程说明；请结合正式需求点、Clarification 与 Test Focus 阅读。'), '',
    '## 4. 正式需求点与来源', '',
    ...result.requirementPoints.flatMap(point => [
      `### ${safe(point.clientRequirementPointId)} · ${safe(point.title)}`, '',
      safe(point.description), '',
      `- Evidence：${point.evidenceRefs.join('、') || '无'}`,
      ...point.evidenceRefs.flatMap(id => {
        const evidence = evidenceById.get(id)
        return evidence ? [`  - ${id} · ${safe(evidence.quote)}（AssetVersion ${evidence.sourceRef.assetVersionId} / Chunk ${evidence.sourceRef.chunkId}）`] : []
      }),
      '',
    ]),
    '## 5. 核心业务规则', '',
    ...result.requirementPoints.filter(point => point.businessRules.length).flatMap(point => point.businessRules.map(rule => `- ${point.clientRequirementPointId}：${safe(rule)}`)),
    ...(result.requirementPoints.some(point => point.businessRules.length) ? [] : ['- 统一结果采用自然语言需求点作为业务语义基线，未强制拆填独立 businessRules 字段。']), '',
    '## 6. 风险与待确认事项', '',
    ...(result.summary.risks.length ? result.summary.risks.map(item => `- ${safe(item)}`) : ['- 无。']), '',
    ...result.clarifications.flatMap(item => item.status === 'answered'
      ? [`- [formal_business_fact/${item.blocking ? 'blocking' : 'advisory'}] ${safe(item.question)} → ${safe(item.answer ?? '')}`]
      : item.status === 'dismissed'
        ? [`- [human_disposition/${item.blocking ? 'blocking' : 'advisory'}] ${safe(item.question)}；处置：${safe(item.answer ?? '')}（不作为业务规则，事实缺口保留）`]
        : [`- [pending/${item.blocking ? 'blocking' : 'advisory'}] ${safe(item.question)}`]),
    ...(result.clarifications.length ? [] : ['- 无待确认问题。']), '',
    '## 7. Formal Clarifications', '',
    ...(answeredClarifications.length ? answeredClarifications.flatMap(item => [
      `- ${safe(item.id)} · ${safe(item.question)} → ${safe(item.answer ?? '')}`,
      `  - Requirement Points：${item.requirementPointRefs.join('、') || '整体'}`,
      `  - Confirmed By：${safe(item.answeredBy ?? 'unknown')} · ${item.answeredAt ?? ''}`,
    ]) : ['- 没有额外确认的 Formal Clarification。']), '',
    ...(dismissedClarifications.length ? [
      '### Human Dispositions（非业务事实）', '',
      ...dismissedClarifications.map(item => `- ${safe(item.id)} · ${safe(item.question)}；处置：${safe(item.answer ?? '')}`),
      '',
    ] : []),
    '## 8. Test Focus', '',
    ...result.testFocus.map(item => `- ${item.id} · ${safe(item.title)}：${safe(item.description)}`), '',
    '## 9. Traceability', '',
    ...result.testFocus.flatMap(focus => focus.requirementPointRefs.flatMap(reference => {
      const point = pointsById.get(reference)
      return point ? [`- ${focus.id} → ${reference} → ${point.evidenceRefs.join('、') || '无 Evidence'}`] : []
    })),
  ].join('\n')

  return [artifact('requirement-analysis.md', analysis)]
}

function artifact(fileName: RequirementAnalysisArtifact['fileName'], content: string): RequirementAnalysisArtifact {
  return { fileName, mediaType: 'text/markdown', content, contentSha256: createHash('sha256').update(content).digest('hex') }
}

function safe(value: string) {
  return value.replace(/[<>]/gu, character => character === '<' ? '&lt;' : '&gt;').trim()
}
