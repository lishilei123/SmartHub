import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Code2,
  Download,
  FileWarning,
  GitCompare,
  Image,
  RotateCcw,
  ShieldAlert,
  TerminalSquare,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { artifactUrl } from './api'
import { shortId } from './ExecutionRunPanel'
import type {
  ExecutionTask,
  ExecutionTaskDetail,
  ScriptRevisionDiff,
  Versioned,
} from './types'

export function ExecutionTaskPanel({
  tasks,
  task,
  diff,
  busy,
  onOpen,
  onRetry,
  onCompare,
}: {
  tasks: ExecutionTask[]
  task: Versioned<ExecutionTaskDetail> | null
  diff: ScriptRevisionDiff | null
  busy: string
  onOpen: (taskId: string) => Promise<ExecutionTaskDetail | undefined>
  onRetry: () => Promise<void>
  onCompare: (fromRevisionId: string, toRevisionId: string) => Promise<void>
}) {
  const [tab, setTab] = useState<'attempts' | 'diagnoses' | 'scripts' | 'artifacts'>('attempts')
  const [fromRevisionId, setFromRevisionId] = useState('')
  const [toRevisionId, setToRevisionId] = useState('')
  useEffect(() => {
    const revisions = task?.value.scriptRevisions ?? []
    setFromRevisionId(revisions.at(-2)?.id ?? revisions[0]?.id ?? '')
    setToRevisionId(revisions.at(-1)?.id ?? '')
  }, [task?.value.task.id, task?.value.scriptRevisions.length])

  return <div className="te-task-workbench">
    <aside className="te-card te-task-list">
      <header><div><h2>执行 Tasks</h2><p>Unsupported 永不生成脚本或 Runner Attempt。</p></div><span>{tasks.length}</span></header>
      <div>{tasks.map(item => <button key={item.id} className={task?.value.task.id === item.id ? 'active' : ''} onClick={() => void onOpen(item.id)}>
        <TaskIcon status={item.status} />
        <span><b>{item.input.caseContent.title}</b><small>{item.input.method} · {item.input.dimension} · r{item.input.caseRevision}</small></span>
        <em className={`te-status-pill ${item.status}`}>{taskStatusLabel(item.status)}</em>
      </button>)}</div>
      {!tasks.length && <p className="te-empty">选择 Run 后显示正式 Task</p>}
    </aside>

    <section className="te-card te-task-detail">
      {!task && <div className="te-task-placeholder"><TerminalSquare /><h2>选择一个执行 Task</h2><p>查看不可变脚本、真实 Runner Attempt、诊断证据和 Artifact。</p></div>}
      {task && <>
        <header className="te-task-header"><div><span className={`te-status-pill ${task.value.task.status}`}>{taskStatusLabel(task.value.task.status)}</span><h2>{task.value.task.input.caseContent.title}</h2><p>{task.value.task.input.caseContent.objective}</p></div>{retryable(task.value.task.status) && <button className="te-primary" disabled={Boolean(busy)} onClick={() => void onRetry()}><RotateCcw />{busy === 'retry' ? '正在排队…' : '人工重试'}</button>}</header>
        <div className="te-task-metrics">
          <Metric label="Runner Attempts" value={task.value.task.runnerAttemptCount} />
          <Metric label="Same-script retries" value={task.value.task.sameScriptRetryCount} />
          <Metric label="Automatic repairs" value={`${task.value.task.repairCount}/2`} />
          <Metric label="State version" value={task.value.task.stateVersion} />
        </div>
        {task.value.task.status === 'unsupported' && <div className="te-state-message unsupported"><ShieldAlert /><span><b>V1 不支持此执行方法</b><small>{task.value.task.unsupportedReason}</small></span></div>}
        {task.value.task.status === 'blocked' && <div className="te-state-message blocked"><FileWarning /><span><b>外部条件阻塞</b><small>{task.value.task.error}</small></span></div>}
        {task.value.task.status === 'waiting_manual' && <div className="te-state-message waiting_manual"><AlertTriangle /><span><b>等待人工处理</b><small>{task.value.task.error ?? '自动修复已收口，历史不会被重置。'}</small></span></div>}
        <nav className="te-tabs">
          <button className={tab === 'attempts' ? 'active' : ''} onClick={() => setTab('attempts')}>Attempts <span>{task.value.attempts.length}</span></button>
          <button className={tab === 'diagnoses' ? 'active' : ''} onClick={() => setTab('diagnoses')}>诊断 <span>{task.value.diagnoses.length}</span></button>
          <button className={tab === 'scripts' ? 'active' : ''} onClick={() => setTab('scripts')}>脚本 Revision <span>{task.value.scriptRevisions.length}</span></button>
          <button className={tab === 'artifacts' ? 'active' : ''} onClick={() => setTab('artifacts')}>Artifacts <span>{task.value.artifacts.length}</span></button>
        </nav>

        {tab === 'attempts' && <div className="te-timeline">
          {task.value.attempts.map(item => <article key={item.id}><TaskIcon status={item.status === 'infrastructure_error' ? 'blocked' : item.status === 'passed' ? 'passed' : item.status === 'running' ? 'running' : item.status === 'cancelled' ? 'cancelled' : 'failed'} /><div><header><b>Attempt #{item.ordinal}</b><span className={`te-status-pill ${item.status}`}>{item.status}</span></header><p>{attemptKindLabel(item.kind)} · Revision {shortId(item.scriptRevisionId)}</p><small>{item.summary ?? item.error ?? 'Runner 正在执行'}{item.durationMs !== undefined ? ` · ${item.durationMs} ms` : ''}</small><code title={item.packageSha256}>{item.packageSha256}</code></div></article>)}
          {!task.value.attempts.length && <p className="te-empty">尚未创建真实 Runner Attempt</p>}
        </div>}

        {tab === 'diagnoses' && <div className="te-diagnosis-list">
          {task.value.diagnoses.map(item => <article key={item.id}><header><AlertTriangle /><b>{diagnosisLabel(item.category)}</b><span>{Math.round(item.confidence * 100)}%</span><em>{item.source === 'deterministic' ? '服务端确定性' : 'FailureAnalysisAgent'}</em></header><p>{item.summary}</p><ul>{item.evidence.map((evidence, index) => <li key={`${evidence.attemptId}-${index}`}><code>{shortId(evidence.attemptId)}</code><span>{evidence.observation}</span></li>)}</ul><footer>{item.repairable ? '允许进入服务端受控修复决策' : '禁止自动修复'} · {item.recommendedAction}</footer></article>)}
          {!task.value.diagnoses.length && <p className="te-empty">同一 Revision 尚未连续失败两次，无诊断事实</p>}
        </div>}

        {tab === 'scripts' && <div className="te-script-panel">
          <div className="te-revision-list">{task.value.scriptRevisions.map(item => <article key={item.id}><Code2 /><span><b>Revision {item.revision} · {item.source}</b><small>{item.repairReason ?? (item.cacheSourceRevisionId ? `缓存来源 ${shortId(item.cacheSourceRevisionId)}` : '初始脚本')}</small><code title={item.contentSha256}>{item.contentSha256}</code></span></article>)}</div>
          {task.value.scriptRevisions.length > 1 && <div className="te-diff-controls"><select value={fromRevisionId} onChange={event => setFromRevisionId(event.target.value)}>{task.value.scriptRevisions.map(item => <option key={item.id} value={item.id}>Revision {item.revision}</option>)}</select><GitCompare /><select value={toRevisionId} onChange={event => setToRevisionId(event.target.value)}>{task.value.scriptRevisions.map(item => <option key={item.id} value={item.id}>Revision {item.revision}</option>)}</select><button className="te-secondary" disabled={!fromRevisionId || !toRevisionId || fromRevisionId === toRevisionId} onClick={() => void onCompare(fromRevisionId, toRevisionId)}>比较</button></div>}
          {diff && <div className="te-diff"><header><b>Revision {diff.fromRevision.revision} → {diff.toRevision.revision}</b><span>断言保护 {shortId(diff.toRevision.protectedAssertionSha256)}</span></header><pre>{diff.changes.removed.lines.map((line, index) => <span className="removed" key={`removed-${index}`}>- {line}{'\n'}</span>)}{diff.changes.added.lines.map((line, index) => <span className="added" key={`added-${index}`}>+ {line}{'\n'}</span>)}</pre></div>}
          {!task.value.scriptRevisions.length && <p className="te-empty">尚未生成脚本 Revision</p>}
        </div>}

        {tab === 'artifacts' && <div className="te-artifact-grid">
          {task.value.artifacts.map(item => <a key={item.id} href={artifactUrl(item.id)}><ArtifactIcon type={item.type} /><span><b>{item.type}</b><small>{formatBytes(item.size)} · {item.mimeType}</small><code title={item.sha256}>{shortId(item.sha256)}</code></span><Download /></a>)}
          {!task.value.artifacts.length && <p className="te-empty">Runner 尚未产生 Artifact</p>}
        </div>}
      </>}
    </section>
  </div>
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div><span>{label}</span><b>{value}</b></div>
}

function TaskIcon({ status }: { status: ExecutionTask['status'] }) {
  if (status === 'passed') return <CheckCircle2 />
  if (['pending', 'script_generating', 'ready', 'running', 'diagnosing', 'retrying', 'repairing'].includes(status)) return <Clock3 />
  if (status === 'unsupported') return <ShieldAlert />
  return <AlertTriangle />
}

function ArtifactIcon({ type }: { type: string }) {
  return type === 'screenshot' ? <Image /> : type === 'script' ? <Code2 /> : <Download />
}

export function taskStatusLabel(status: ExecutionTask['status']) {
  return ({ pending: '待处理', script_generating: '生成脚本', ready: '待执行', running: '执行中', diagnosing: '诊断中', retrying: '同脚本重试', repairing: '修复中', passed: '通过', failed: '失败', blocked: '阻塞', unsupported: '不支持', waiting_manual: '等待人工', cancelled: '已取消' })[status]
}

function attemptKindLabel(kind: ExecutionTaskDetail['attempts'][number]['kind']) {
  return ({ initial: '首次真实执行', same_script_retry: '固定同脚本重试', infrastructure_retry: '基础设施恢复重试', post_repair: '修复后执行', manual_retry: '人工重试' })[kind]
}

function diagnosisLabel(category: string) {
  return ({ product_defect: '产品缺陷', script_defect: '脚本缺陷', selector_changed: '选择器变化', environment_defect: '环境缺陷', test_data_defect: '测试数据缺陷', flaky: 'Flaky', assertion_mismatch: '断言不匹配', timeout: '超时', unknown: '未知' } as Record<string, string>)[category] ?? category
}

function retryable(status: ExecutionTask['status']) {
  return ['failed', 'blocked', 'waiting_manual'].includes(status)
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`
  return `${(size / 1024 / 1024).toFixed(1)} MiB`
}
