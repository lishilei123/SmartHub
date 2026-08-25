import { Bug } from 'lucide-react'
import { artifactUrl } from './api'
import type { TestReport } from './types'

export function TestReportDefectPanel({ report }: { report: TestReport }) {
  return <section className="tr-section tr-defects" aria-labelledby="tr-defects-title">
    <header>
      <div>
        <h2 id="tr-defects-title"><Bug aria-hidden="true" />产品缺陷候选</h2>
        <p>由正式 product_defect 诊断确定性投影；候选不等于已确认 BUG，需人工结合 Attempt 与 Artifact 复核。</p>
      </div>
      <span>{report.productDefectCandidates.length}</span>
    </header>
    {report.productDefectCandidates.length
      ? <div className="tr-table-scroll"><table><thead><tr><th>测试用例</th><th>状态</th><th>诊断摘要</th><th>证据链</th><th>追溯</th></tr></thead><tbody>{report.productDefectCandidates.map(candidate => <tr key={candidate.id}><td><b>{candidate.title}</b><code>{candidate.caseId}@{candidate.caseRevision} · {candidate.method.toUpperCase()} · Task #{candidate.ordinal}</code></td><td><span className="tr-status pending_confirmation">待人工确认</span><small>{formatDate(candidate.createdAt)}</small></td><td><p>{candidate.summary}</p></td><td><span>{candidate.attemptIds.length} Attempts</span>{candidate.artifactIds.length ? candidate.artifactIds.map((artifactId, index) => <a key={artifactId} href={artifactUrl(artifactId, 'inline')} target="_blank" rel="noreferrer">Artifact {index + 1}</a>) : <small>无关联 Artifact</small>}</td><td><code>Candidate {candidate.id}<br />Diagnosis {candidate.diagnosisId}</code></td></tr>)}</tbody></table></div>
      : <p className="tr-empty">当前 Run 没有满足 product_defect 正式诊断条件的候选。</p>}
  </section>
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}
