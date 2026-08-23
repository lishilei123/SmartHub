import { Download, ExternalLink, FileWarning } from 'lucide-react'
import { artifactUrl } from './api'
import { diagnosisLabel } from './TestReportDiagnosisPanel'
import { taskStatusLabel } from '../test-execution/ExecutionTaskPanel'
import type { TestReport } from './types'

export function TestReportFailureTable({ report }: { report: TestReport }) {
  return <section className="tr-section tr-failures" aria-labelledby="tr-failures-title">
    <header><div><h2 id="tr-failures-title"><FileWarning aria-hidden="true" />非通过任务明细</h2><p>包含当前状态不是 passed 的任务；活动 Run 中以“进行中”区分尚未终结的任务。</p></div><span>{report.nonPassedTasks.length}</span></header>
    {!report.nonPassedTasks.length
      ? <p className="tr-empty">没有非通过任务。</p>
      : <div className="tr-table-scroll"><table><thead><tr><th>测试用例</th><th>结果</th><th>失败原因</th><th>处理</th><th>执行历史</th><th>运行产物</th></tr></thead><tbody>{report.nonPassedTasks.map(task => <tr key={task.taskId}><td><b>{task.title}</b><code>{task.method.toUpperCase()} · {task.dimension}</code></td><td><span className={`tr-status ${task.status}`}>{taskStatusLabel(task.status)}</span>{!task.terminal && <small>进行中</small>}</td><td>{task.diagnosis ? <><b title={task.diagnosis.category}>{diagnosisLabel(task.diagnosis.category)}</b><p>{task.diagnosis.summary}</p></> : <em>暂无失败诊断</em>}</td><td>{task.diagnosis?.recommendedAction ?? '等待执行结果'}</td><td><span>{task.attemptCount} 次执行</span><span>{task.scriptRevisionCount} 个脚本版本</span></td><td><div className="tr-artifacts">{task.artifacts.length ? task.artifacts.map(artifact => <span key={artifact.id}><b>{artifact.type}</b><small>{bytes(artifact.size)}</small><a href={artifactUrl(artifact.id, 'inline')} target="_blank" rel="noreferrer" aria-label={`查看 ${artifact.type}`}><ExternalLink /></a><a href={artifactUrl(artifact.id)} aria-label={`下载 ${artifact.type}`}><Download /></a></span>) : <em>无运行产物</em>}</div></td></tr>)}</tbody></table></div>}
  </section>
}

function bytes(value: number) {
  if (value < 1_024) return `${value} B`
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`
  return `${(value / 1_048_576).toFixed(1)} MiB`
}
