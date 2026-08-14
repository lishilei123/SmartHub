import { Activity, Boxes, Download, FileJson2, FileText, RefreshCw, Settings2, ShieldCheck } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { ProjectVersion } from '../project-version-api'
import { runStatusLabel } from '../test-execution/ExecutionRunPanel'
import { reportExportUrl } from './api'
import { useTestReport } from './hooks/useTestReport'
import { TestReportDiagnosisPanel } from './TestReportDiagnosisPanel'
import { TestReportFailureTable } from './TestReportFailureTable'
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

  if (!projectVersion) return <main className="tr-shell"><section className="tr-section tr-page-empty"><Boxes /><h2>请先选择 ProjectVersion</h2><p>报告严格绑定 ProjectVersion 与真实 ExecutionRun。</p><button className="tr-primary" onClick={onManageVersions}>管理项目版本</button></section></main>

  return <main className="tr-shell">
    <header className="tr-page-header">
      <div className="tr-page-title"><span><Activity /></span><div><p>{projectVersion.name} · PostgreSQL formal facts → deterministic report</p></div></div>
      <div className="tr-boundary"><ShieldCheck /><span><small>报告边界</small><b>Service 统计 · Agent 不计算正式指标</b></span></div>
      <button className="tr-secondary" onClick={onManageVersions}><Settings2 />项目版本</button>
    </header>
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
          <section className="tr-report-toolbar"><div><span className={`tr-status ${model.report.run.status}`}>{runStatusLabel(model.report.run.status)}</span><b>{model.report.run.id}</b><small>统计截至 {formatDate(model.report.statisticsAt)} · SHA-256 {model.report.reportSha256}</small></div><div>{model.refreshing && <span className="tr-refreshing"><RefreshCw />正在刷新</span>}<a href={reportExportUrl(projectVersion.id, model.report.run.id, 'json')}><FileJson2 />导出 JSON</a><a href={reportExportUrl(projectVersion.id, model.report.run.id, 'markdown')}><FileText />导出 Markdown</a><a href={reportExportUrl(projectVersion.id, model.report.run.id, 'json')} aria-label="下载报告"><Download /></a></div></section>
          <TestReportOverview report={model.report} />
          <TestReportMetrics report={model.report} />
          <TestReportDiagnosisPanel report={model.report} />
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
