import { Library } from 'lucide-react'
import { diagnosisLabel } from './TestReportDiagnosisPanel'
import type { LegacyTestReport } from './types'

export function TestReportMaintenanceTable({ report }: { report: LegacyTestReport }) {
  return <section className="tr-section tr-maintenance" aria-labelledby="tr-maintenance-title">
    <header><div><h2 id="tr-maintenance-title"><Library aria-hidden="true" />用例维护建议</h2><p>接受仅表示确认正式用例需要人工维护，不会自动修改正式 TestCase。</p></div><span>{report.overview.maintenanceProposalCount}</span></header>
    <div className="tr-maintenance-counts"><span><small>待确认</small><b>{report.overview.pendingMaintenanceCount}</b></span><span><small>已确认</small><b>{report.overview.acceptedMaintenanceCount}</b></span><span><small>已拒绝</small><b>{report.overview.rejectedMaintenanceCount}</b></span></div>
    {!report.maintenanceProposals.length
      ? <p className="tr-empty">没有用例维护建议。</p>
      : <div className="tr-table-scroll"><table><thead><tr><th>用例</th><th>状态</th><th>原因与建议</th><th>追溯</th><th>Baseline</th><th>审批</th></tr></thead><tbody>{report.maintenanceProposals.map(proposal => <tr key={proposal.id}><td><b>{proposal.title}</b><code>{proposal.caseId}@{proposal.caseRevision} · Task #{proposal.ordinal}</code></td><td><span className={`tr-status ${proposal.status}`}>{statusLabel(proposal.status)}</span><small>{formatDate(proposal.createdAt)}</small></td><td><b>{proposal.summary}</b><p>{proposal.proposedChange}</p></td><td><span>{diagnosisLabel(proposal.diagnosisCategory)}</span><small>{proposal.diagnosisSummary}</small><code>Diagnosis {proposal.diagnosisId}<br />Revision {proposal.scriptRevisionId}</code></td><td><span>{proposal.baselineLibraryVersionId}</span><code>{proposal.baselineLibraryVersionSha256}</code></td><td>{proposal.decidedBy ? <><b>{proposal.decidedBy}</b><small>{formatDate(proposal.decidedAt!)}</small></> : <em>待人工确认</em>}</td></tr>)}</tbody></table></div>}
  </section>
}


function statusLabel(status: 'pending' | 'accepted' | 'rejected') {
  return ({ pending: '待确认', accepted: '已确认需要维护', rejected: '已拒绝' })[status]
}

function formatDate(value: string) {
  return new Date(value).toLocaleString('zh-CN')
}
