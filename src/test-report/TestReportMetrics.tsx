import { Gauge, HeartPulse, RotateCcw, TimerReset } from 'lucide-react'
import type { TestReport } from './types'

export function TestReportMetrics({ report }: { report: TestReport }) {
  const efficiency = [
    ['总耗时', duration(report.efficiency.totalDurationMs)],
    ['平均用例耗时', duration(report.efficiency.averageCaseDurationMs)],
    ['最短 / 最长', `${duration(report.efficiency.minimumCaseDurationMs)} / ${duration(report.efficiency.maximumCaseDurationMs)}`],
    ['P50 / P95', `${duration(report.efficiency.p50CaseDurationMs)} / ${duration(report.efficiency.p95CaseDurationMs)}`],
    ['Runner Attempts', String(report.efficiency.totalRunnerAttempts)],
    ['时长样本', String(report.efficiency.durationSampleCount)],
  ]
  const quality = [
    ['首轮通过', String(report.firstExecutionQuality.firstPassCount)],
    ['首轮通过率', rate(report.firstExecutionQuality.firstPassRate.percentage)],
    ['重试后通过', String(report.firstExecutionQuality.passedAfterRetryCount)],
    ['修复后通过', String(report.firstExecutionQuality.passedAfterRepairCount)],
    ['同脚本重试', String(report.stability.sameScriptRetryCount)],
    ['Flaky 用例 / 率', `${report.stability.flakyCaseCount} / ${rate(report.stability.flakyRate.percentage)}`],
    ['基础设施错误', String(report.stability.infrastructureErrorCount)],
  ]
  const healing = [
    ['触发 ScriptRepair', String(report.selfHealing.triggeredTaskCount)],
    ['ScriptRevision 总数', String(report.selfHealing.totalScriptRevisionCount)],
    ['自动修复成功', String(report.selfHealing.automaticRepairSuccessCount)],
    ['自动修复失败', String(report.selfHealing.automaticRepairFailureCount)],
    ['自动修复进行中', String(report.selfHealing.automaticRepairPendingCount)],
    ['修复成功率', rate(report.selfHealing.repairSuccessRate.percentage)],
    ['平均修复轮数', String(report.selfHealing.averageRepairRounds)],
  ]

  return <div className="tr-metric-sections">
    <MetricSection id="tr-efficiency" title="执行效率" description="按 Run wall-clock 与每 Task 已结束 Attempt 统计。" icon={Gauge} values={efficiency} />
    <MetricSection id="tr-quality" title="首次执行质量与稳定性" description={`业务结果资格用例 ${report.firstExecutionQuality.eligibleCaseCount} 个。`} icon={TimerReset} values={quality} />
    <MetricSection id="tr-healing" title="自愈" description="仅汇总已产生 repair Revision 的正式 ScriptRepair 事实。" icon={HeartPulse} values={healing} />
  </div>
}

function MetricSection({ id, title, description, icon: Icon, values }: { id: string; title: string; description: string; icon: typeof RotateCcw; values: string[][] }) {
  return <section className="tr-section tr-metrics" aria-labelledby={`${id}-title`}>
    <header><div><h2 id={`${id}-title`}><Icon aria-hidden="true" />{title}</h2><p>{description}</p></div></header>
    <dl>{values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </section>
}

function duration(value: number | null) {
  if (value === null) return '无样本'
  if (value < 1_000) return `${value} ms`
  if (value < 60_000) return `${(value / 1_000).toFixed(2)} s`
  return `${(value / 60_000).toFixed(2)} min`
}

function rate(value: number) {
  return `${value.toFixed(2)}%`
}
