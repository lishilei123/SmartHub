import { AlertTriangle, Ban, CheckCircle2, Clock3, CircleSlash2, XCircle } from 'lucide-react'
import type { TestReport } from './types'

export function TestReportOverview({ report }: { report: TestReport }) {
  const values = [
    { key: 'total', label: '用例总数', value: report.overview.totalCases, icon: Clock3 },
    { key: 'passed', label: '通过', value: report.overview.passed, icon: CheckCircle2 },
    { key: 'failed', label: '失败', value: report.overview.failed, icon: XCircle },
    { key: 'blocked', label: '阻塞', value: report.overview.blocked, icon: AlertTriangle },
    { key: 'waiting', label: '等待人工', value: report.overview.waitingManual, icon: Clock3 },
    { key: 'unsupported', label: '未支持', value: report.overview.unsupported, icon: CircleSlash2 },
    { key: 'cancelled', label: '已取消', value: report.overview.cancelled, icon: Ban },
  ]
  const segments = [
    ['passed', '通过', report.overview.passed],
    ['failed', '失败', report.overview.failed],
    ['blocked', '阻塞', report.overview.blocked],
    ['waiting', '等待人工', report.overview.waitingManual],
    ['unsupported', '未支持', report.overview.unsupported],
    ['cancelled', '已取消', report.overview.cancelled],
    ['active', '进行中', report.overview.active],
  ] as const

  return <section className="tr-section" aria-labelledby="tr-overview-title">
    <header><div><h2 id="tr-overview-title">执行概览</h2><p>最终通过率以完整计划用例数为分母。</p></div><strong>{formatRate(report.overview.finalPassRate.percentage)}</strong></header>
    <div className="tr-kpi-grid">
      {values.map(item => <article key={item.key} className={`tr-kpi ${item.key}`}><item.icon aria-hidden="true" /><span>{item.label}</span><b>{item.value}</b></article>)}
    </div>
    <div className="tr-status-distribution" aria-label="用例状态分布">
      <div className="tr-status-bar" aria-hidden="true">
        {segments.filter(([, , value]) => value > 0).map(([key, label, value]) => <span key={key} className={key} title={`${label} ${value}`} style={{ width: `${value / Math.max(1, report.overview.totalCases) * 100}%` }} />)}
      </div>
      <ul>{segments.map(([key, label, value]) => <li key={key}><i className={key} aria-hidden="true" /><span>{label}</span><b>{value}</b></li>)}</ul>
    </div>
  </section>
}

function formatRate(value: number) {
  return `${value.toFixed(2)}%`
}
