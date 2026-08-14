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
      : <div className="tr-table-scroll"><table><thead><tr><th>用例</th><th>状态</th><th>最新正式诊断</th><th>建议</th><th>历史</th><th>Artifact</th></tr></thead><tbody>{report.nonPassedTasks.map(task => <tr key={task.taskId}><td><b>{task.title}</b><code>{task.caseId}@{task.caseRevision} · {task.method} · {task.dimension}</code></td><td><span className={`tr-status ${task.status}`}>{taskStatusLabel(task.status)}</span>{!task.terminal && <small>进行中</small>}</td><td>{task.diagnosis ? <><b title={task.diagnosis.category}>{diagnosisLabel(task.diagnosis.category)}</b><p>{task.diagnosis.summary}</p><small>置信度 {(task.diagnosis.confidence * 100).toFixed(0)}% · {task.diagnosis.source}</small></> : <em>无正式诊断</em>}</td><td>{task.diagnosis?.recommendedAction ?? '无正式建议'}</td><td><span>{task.attemptCount} Attempts</span><span>{task.scriptRevisionCount} Revisions</span></td><td><div className="tr-artifacts">{task.artifacts.length ? task.artifacts.map(artifact => <span key={artifact.id}><b>{artifact.type}</b><small>{bytes(artifact.size)} · {artifact.sha256.slice(0, 12)}…</small><a href={artifactUrl(artifact.id, 'inline')} target="_blank" rel="noreferrer" aria-label={`查看 ${artifact.type}`}><ExternalLink /></a><a href={artifactUrl(artifact.id)} aria-label={`下载 ${artifact.type}`}><Download /></a></span>) : <em>无 Artifact</em>}</div></td></tr>)}</tbody></table></div>}
  </section>
}

function bytes(value: number) {
  if (value < 1_024) return `${value} B`
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`
  return `${(value / 1_048_576).toFixed(1)} MiB`
}
