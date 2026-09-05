import { Activity, Boxes, FileJson2, FileText, RefreshCw, Settings2, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ProjectVersion } from '../project-version-api'
import { runStatusLabel } from '../test-execution/ExecutionRunPanel'
import { decideMaintenanceProposal, decideProductDefectCandidate, loadMaintenanceProposal } from '../test-execution/api'
import { reportExportUrl } from './api'
import { useTestReport } from './hooks/useTestReport'
import { TestReportDiagnosisPanel } from './TestReportDiagnosisPanel'
import { TestReportDefectPanel } from './TestReportDefectPanel'
import { TestReportFailureTable } from './TestReportFailureTable'
import { TestReportMaintenanceTable } from './TestReportMaintenanceTable'
import { TestReportMetrics } from './TestReportMetrics'
import { TestReportOverview } from './TestReportOverview'
import { TestReportTraceability } from './TestReportTraceability'
import './test-report.css'

type Notify = (message: string, tone?: 'success' | 'error' | 'warning') => void

export function TestReportPage({
  projectVersion,
  onManageVersions,
  notify,
}: {
  projectVersion: ProjectVersion | null
  onManageVersions: () => void
  notify: Notify
}) {
  const model = useTestReport(projectVersion?.id)
  const restored = useRef(false)
  const [governanceBusyId, setGovernanceBusyId] = useState('')
  const governanceScope = `${projectVersion?.id ?? ''}:${model.report?.run.id ?? ''}`
  const currentGovernanceScope = useRef(governanceScope)
  currentGovernanceScope.current = governanceScope

  useEffect(() => { setGovernanceBusyId('') }, [governanceScope])

  useEffect(() => {
    restored.current = false
  }, [projectVersion?.id])

  useEffect(() => {
    if (restored.current || !projectVersion || model.loading) return
    restored.current = true
    const runId = new URL(window.location.href).searchParams.get('reportRunId')
    if (runId) void model.openReport(runId).catch(cause => notify(messageOf(cause), 'error'))
  }, [model.loading, model.openReport, notify, projectVersion])

  const open = async (runId: string) => {
    try {
      const next = await model.openReport(runId)
      if (next) updateReportRoute(runId)
    } catch (cause) {
      notify(messageOf(cause), 'error')
    }
  }

  const decideMaintenance = async (proposalId: string, decision: 'accepted' | 'rejected') => {
    if (!projectVersion || !model.report) return
    const current = () => currentGovernanceScope.current === governanceScope
    setGovernanceBusyId(proposalId)
    try {
      const detail = await loadMaintenanceProposal(projectVersion.id, model.report.run.id, proposalId)
      if (!current()) return
      if (!detail.decisionEtag) throw new Error('维护建议缺少并发控制版本，请刷新后重试')
      const accepted = window.confirm(`${detail.value.proposal.summary}\n\n${detail.value.proposal.proposedChange}\n\n该操作不会自动修改正式 TestCase。是否继续？`)
      if (!accepted) return
      await decideMaintenanceProposal(projectVersion.id, model.report.run.id, proposalId, detail.decisionEtag, decision)
      if (!current()) return
      await model.openReport(model.report.run.id, true)
      if (!current()) return
      notify(decision === 'accepted' ? '已确认该用例需要人工维护' : '已拒绝维护建议', 'success')
    } catch (cause) { if (current()) notify(messageOf(cause), 'error') }
    finally { if (current()) setGovernanceBusyId('') }
  }

  const decideDefect = async (diagnosisId: string, etag: string, decision: 'confirmed' | 'rejected', comment?: string) => {
    if (!projectVersion || !model.report) return
    const current = () => currentGovernanceScope.current === governanceScope
    setGovernanceBusyId(`product-defect-candidate:${diagnosisId}`)
    try {
      await decideProductDefectCandidate(projectVersion.id, model.report.run.id, diagnosisId, etag, decision, comment)
      if (!current()) return
      await model.openReport(model.report.run.id, true)
      if (!current()) return
      notify(decision === 'confirmed' ? '已记录人工确认的产品缺陷事实' : '已驳回产品缺陷候选', 'success')
    } catch (cause) { if (current()) notify(messageOf(cause), 'error') }
    finally { if (current()) setGovernanceBusyId('') }
  }

  if (!projectVersion) return <main className="tr-shell"><section className="tr-section tr-page-empty"><Boxes /><h2>请先选择 ProjectVersion</h2><p>报告严格绑定 ProjectVersion 与真实 ExecutionRun。</p><button className="tr-primary" onClick={onManageVersions}>管理项目版本</button></section></main>

  return <main className="tr-shell">
    {model.error && <div className="tr-global-error" role="alert"><b>报告数据未完整加载</b><span>{model.error}</span><button onClick={() => void model.loadReports()}><RefreshCw />重试</button></div>}
    <div className="tr-layout">
      <aside className="tr-section tr-run-list">
        <header><div><h2>ExecutionRun 报告</h2><p>选择运行以生成当前正式事实的报告。</p></div><button className="tr-icon-button" aria-label="刷新报告列表" disabled={model.loading} onClick={() => void model.loadReports()}><RefreshCw className={model.loading ? 'spinning' : ''} /></button></header>
        <div>{model.reports.map(item => <button key={item.runId} className={model.report?.run.id === item.runId ? 'active' : ''} onClick={() => void open(item.runId)}><Activity /><span><b>{item.environment.name} · {item.mode}</b><small>{formatDate(item.createdAt)} · {item.totalCases} cases</small><code>{item.runId}</code></span><em className={`tr-status ${item.status}`}>{runStatusLabel(item.status)}</em></button>)}</div>
        {!model.reports.length && !model.loading && <p className="tr-empty">当前项目版本没有 ExecutionRun。</p>}
      </aside>
      <div className={`tr-report ${model.refreshing ? 'refreshing' : ''}`}>
        {!model.report && <section className="tr-section tr-report-empty"><Activity /><h2>选择一个 ExecutionRun</h2><p>报告只读取正式执行事实，不调用 Agent、Runner，也不修改状态。</p></section>}
        {model.report && <>
          <section className="tr-report-toolbar"><div><span className={`tr-status ${model.report.run.status}`}>{runStatusLabel(model.report.run.status)}</span><b>{model.report.run.id}</b><small>统计截至 {formatDate(model.report.statisticsAt)} · SHA-256 {model.report.reportSha256}</small></div><div>{model.refreshing && <span className="tr-refreshing"><RefreshCw />正在刷新</span>}<button className="tr-icon-button" aria-label="刷新当前报告" title="刷新当前报告" disabled={model.refreshing} onClick={() => void model.openReport(model.report!.run.id, true).catch(cause => notify(messageOf(cause), 'error'))}><RefreshCw className={model.refreshing ? 'spinning' : ''} /></button><a href={reportExportUrl(projectVersion.id, model.report.run.id, 'json')}><FileJson2 />导出 JSON</a><a href={reportExportUrl(projectVersion.id, model.report.run.id, 'markdown')}><FileText />导出 Markdown</a></div></section>
          <TestReportOverview report={model.report} />
          <TestReportMetrics report={model.report} />
          <TestReportDiagnosisPanel report={model.report} />
          <TestReportDefectPanel report={model.report} busyId={governanceBusyId} onDecide={decideDefect} />
          <TestReportMaintenanceTable report={model.report} busyId={governanceBusyId} onDecide={decideMaintenance} />
          <TestReportFailureTable report={model.report} />
          <TestReportTraceability report={model.report} />
        </>}
      </div>
    </div>
  </main>
}

function updateReportRoute(runId: string) {
  const url = new URL(window.location.href)
  url.searchParams.set('reportRunId', runId)
  window.history.replaceState({}, '', url)
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

function messageOf(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}
