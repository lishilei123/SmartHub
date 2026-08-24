import {
  AlertTriangle,
  Activity,
  Braces,
  Camera,
  CheckCircle2,
  Clock3,
  Code2,
  Download,
  FileWarning,
  GitCompare,
  Image,
  MousePointerClick,
  Navigation,
  RotateCcw,
  ShieldAlert,
  TerminalSquare,
  TextCursorInput,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { artifactUrl } from './api'
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
      <header><div><h2>测试用例</h2><p>按用例查看执行结果、失败原因与修复记录。</p></div><span>{tasks.length}</span></header>
      <div>{tasks.map(item => <button key={item.id} className={task?.value.task.id === item.id ? 'active' : ''} onClick={() => void onOpen(item.id)}>
        <TaskIcon status={item.status} />
        <span><b>{item.input.caseContent.title}</b><small>{item.input.method} · {item.input.dimension} · r{item.input.caseRevision}</small></span>
        <em className={`te-status-pill ${item.status}`}>{taskStatusLabel(item.status)}</em>
      </button>)}</div>
      {!tasks.length && <p className="te-empty">选择 Run 后显示正式 Task</p>}
    </aside>

    <section className="te-card te-task-detail">
      {!task && <div className="te-task-placeholder"><TerminalSquare /><h2>选择一个测试用例</h2><p>查看执行过程、失败原因、修复说明和运行产物。</p></div>}
      {task && <>
        <header className="te-task-header"><div><span className={`te-status-pill ${task.value.task.status}`}>{taskStatusLabel(task.value.task.status)}</span><h2>{task.value.task.input.caseContent.title}</h2><p>{task.value.task.input.caseContent.expectedResults.join(' · ')}</p></div>{task.value.task.input.method !== 'agent' && retryable(task.value.task.status) && <button className="te-primary" disabled={Boolean(busy)} onClick={() => void onRetry()}><RotateCcw />{busy === 'retry' ? '正在排队…' : '人工重试'}</button>}</header>
        <div className="te-task-metrics">
          <Metric label="执行方式" value={methodLabel(task.value.task.input.method)} />
          <Metric label="执行次数" value={task.value.agentExecutionResult?.caseRuns.length ?? task.value.task.runnerAttemptCount} />
          <Metric label="平均耗时" value={task.value.agentExecutionResult ? formatDuration(task.value.agentExecutionResult.averageLatencyMs) : formatDuration(task.value.attempts.reduce((total, item) => total + (item.durationMs ?? 0), 0))} />
          <Metric label={task.value.task.input.method === 'agent' ? '成功率' : '自动修复'} value={task.value.agentExecutionResult ? `${(task.value.agentExecutionResult.successRate * 100).toFixed(1)}%` : `${task.value.task.repairCount}/2`} />
        </div>
        {task.value.task.status === 'unsupported' && <div className="te-state-message unsupported"><ShieldAlert /><span><b>V1 不支持此执行方法</b><small>{task.value.task.unsupportedReason}</small></span></div>}
        {task.value.task.status === 'blocked' && <div className="te-state-message blocked"><FileWarning /><span><b>外部条件阻塞</b><small>{task.value.task.error}</small></span></div>}
        {task.value.task.status === 'waiting_manual' && <div className="te-state-message waiting_manual"><AlertTriangle /><span><b>等待人工处理</b><small>{task.value.task.error ?? '自动修复已收口，历史不会被重置。'}</small></span></div>}
        {task.value.agentExecutionResult && <AgentExecutionEvidence result={task.value.agentExecutionResult} />}
        <nav className="te-tabs">
          <button className={tab === 'attempts' ? 'active' : ''} onClick={() => setTab('attempts')}>执行过程 <span>{task.value.events.length}</span></button>
          <button className={tab === 'diagnoses' ? 'active' : ''} onClick={() => setTab('diagnoses')}>诊断 <span>{task.value.diagnoses.length}</span></button>
          <button className={tab === 'scripts' ? 'active' : ''} onClick={() => setTab('scripts')}>脚本历史 <span>{task.value.scriptRevisions.length}</span></button>
          <button className={tab === 'artifacts' ? 'active' : ''} onClick={() => setTab('artifacts')}>运行产物 <span>{task.value.artifacts.length}</span></button>
        </nav>

        {tab === 'attempts' && <div className="te-timeline">
          {task.value.attempts.map(item => <article key={item.id} className="te-attempt"><TaskIcon status={item.status === 'infrastructure_error' ? 'blocked' : item.status === 'passed' ? 'passed' : item.status === 'running' ? 'running' : item.status === 'cancelled' ? 'cancelled' : 'failed'} /><div><header><b>第 {item.ordinal} 次执行</b><span className={`te-status-pill ${item.status}`}>{attemptStatusLabel(item.status)}</span></header><p>{attemptKindLabel(item.kind)}</p><small>{new Date(item.startedAt).toLocaleString('zh-CN')} · {item.summary ?? item.error ?? '正在执行'}{item.durationMs !== undefined ? ` · ${formatDuration(item.durationMs)}` : ''}</small><ExecutionEventTimeline method={task.value.task.input.method} events={task.value.events.filter(event => event.attemptId === item.id)} artifacts={task.value.artifacts} /></div></article>)}
          {!task.value.attempts.length && <p className="te-empty">尚未创建真实 Runner Attempt</p>}
        </div>}

        {tab === 'diagnoses' && <div className="te-diagnosis-list">
          {task.value.diagnoses.map(item => <article key={item.id}><header><AlertTriangle /><b>{diagnosisLabel(item.category)}</b><em>{item.repairable ? '可自动修复' : '不自动修复'}</em></header><p>{item.summary}</p><ul>{item.evidence.map((evidence, index) => <li key={`${evidence.attemptId}-${index}`}><span>{evidence.observation}</span></li>)}</ul><footer>{item.recommendedAction}</footer></article>)}
          {!task.value.diagnoses.length && <p className="te-empty">同一 Revision 尚未连续失败两次，无诊断事实</p>}
        </div>}

        {tab === 'scripts' && <div className="te-script-panel">
          <div className="te-revision-list">{task.value.scriptRevisions.map(item => <article key={item.id}><Code2 /><span><b>脚本版本 {item.revision}</b><small>{item.repairReason ?? (item.source === 'repair' ? '自动修复' : '初始实现')} · {item.sourceArtifacts.length} 个文件</small></span></article>)}</div>
          {task.value.scriptRevisions.length > 1 && <div className="te-diff-controls"><select value={fromRevisionId} onChange={event => setFromRevisionId(event.target.value)}>{task.value.scriptRevisions.map(item => <option key={item.id} value={item.id}>Revision {item.revision}</option>)}</select><GitCompare /><select value={toRevisionId} onChange={event => setToRevisionId(event.target.value)}>{task.value.scriptRevisions.map(item => <option key={item.id} value={item.id}>Revision {item.revision}</option>)}</select><button className="te-secondary" disabled={!fromRevisionId || !toRevisionId || fromRevisionId === toRevisionId} onClick={() => void onCompare(fromRevisionId, toRevisionId)}>比较</button></div>}
          {diff && <div className="te-diff"><header><b>脚本版本 {diff.fromRevision.revision} → {diff.toRevision.revision}</b><span>受保护断言已校验</span></header><pre>{diff.changes.removed.lines.map((line, index) => <span className="removed" key={`removed-${index}`}>- {line}{'\n'}</span>)}{diff.changes.added.lines.map((line, index) => <span className="added" key={`added-${index}`}>+ {line}{'\n'}</span>)}</pre></div>}
          {!task.value.scriptRevisions.length && <p className="te-empty">尚未生成脚本 Revision</p>}
        </div>}

        {tab === 'artifacts' && <div className="te-artifact-grid">
          {task.value.artifacts.map(item => <a key={item.id} href={artifactUrl(item.id)}><ArtifactIcon type={item.type} /><span><b>{artifactLabel(item.type)}</b><small>{formatBytes(item.size)} · {item.mimeType}</small></span><Download /></a>)}
          {!task.value.artifacts.length && <p className="te-empty">Runner 尚未产生 Artifact</p>}
        </div>}

      </>}
    </section>
  </div>
}

function ExecutionEventTimeline({
  method,
  events,
  artifacts,
}: {
  method: ExecutionTask['input']['method']
  events: ExecutionTaskDetail['events']
  artifacts: ExecutionTaskDetail['artifacts']
}) {
  const byId = new Map(artifacts.map(artifact => [artifact.id, artifact]))
  return <ol className={`te-execution-events ${method === 'api' ? 'api' : 'ui'}`}>
    {events.slice().sort((left, right) => left.sequence - right.sequence).map(event => {
      const linked = (event.artifactIds ?? []).flatMap(id => byId.get(id) ? [byId.get(id)!] : [])
      return <li key={event.id} className={event.status}>
        <span className="te-event-rail"><EventIcon type={event.type} /></span>
        <div>
          <header><b>{event.title}</b><em className={`te-status-pill ${event.status}`}>{eventStatusLabel(event.status)}</em></header>
          {event.type === 'http' && <p className="te-http-summary"><strong>{event.metadata?.method}</strong><code>{event.metadata?.path}</code>{event.metadata?.httpStatus !== undefined && <span className={event.metadata.httpStatus >= 400 ? 'error' : ''}>{event.metadata.httpStatus}</span>}</p>}
          {event.metadata?.queryFields?.length ? <small>Query 字段：{event.metadata.queryFields.join('、')}</small> : null}
          <small>{new Date(event.startedAt).toLocaleTimeString('zh-CN')}{event.durationMs !== undefined ? ` · ${event.durationMs} ms` : ''} · Playwright Reporter</small>
          {linked.length > 0 && <div className="te-event-artifacts">{linked.map(artifact => <a key={artifact.id} href={artifactUrl(artifact.id, artifact.type === 'screenshot' ? 'inline' : 'attachment')} target="_blank" rel="noreferrer"><ArtifactIcon type={artifact.type} />{artifact.type}</a>)}</div>}
        </div>
      </li>
    })}
    {!events.length && <li className="empty"><Activity /><span>该 Attempt 尚未收到结构化 Playwright Reporter 事件</span></li>}
  </ol>
}

function EventIcon({ type }: { type: ExecutionTaskDetail['events'][number]['type'] }) {
  if (type === 'navigate') return <Navigation />
  if (type === 'click') return <MousePointerClick />
  if (type === 'fill') return <TextCursorInput />
  if (type === 'http') return <Braces />
  if (type === 'assertion') return <CheckCircle2 />
  if (type === 'screenshot') return <Camera />
  if (type === 'failure') return <AlertTriangle />
  return <Activity />
}

function eventStatusLabel(status: ExecutionTaskDetail['events'][number]['status']) {
  return ({ running: '进行中', passed: '完成', failed: '失败', skipped: '跳过' })[status]
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div><span>{label}</span><b>{value}</b></div>
}

function AgentExecutionEvidence({ result }: { result: NonNullable<ExecutionTaskDetail['agentExecutionResult']> }) {
  return <section className="te-agent-evidence"><header><div><b>Agent Execution Result</b><small>Single Runs 与 Aggregate 分开保存；Assertion 和 AI Evaluation 不混合计分。</small></div><span className={`te-status-pill ${result.status === 'PASS' ? 'passed' : result.status === 'NOT_EVALUABLE' ? 'blocked' : 'failed'}`}>{result.status}</span></header>
    <div className="te-task-metrics"><Metric label="PASS" value={`${(result.successRate * 100).toFixed(1)}%`} /><Metric label="FAIL" value={`${(result.failureRate * 100).toFixed(1)}%`} /><Metric label="NOT_EVALUABLE" value={`${(result.notEvaluableRate * 100).toFixed(1)}%`} /><Metric label="Token" value={result.tokenUsage?.totalTokens ?? 'unavailable'} /></div>
    {result.caseRuns.map(caseRun => <details key={caseRun.id} open={result.caseRuns.length === 1}><summary>Repeat {caseRun.repeatOrdinal} · {caseRun.status} · {caseRun.latencyMs} ms · {caseRun.stepCount} steps</summary><div className="te-agent-result-grid"><section><h4>Deterministic Assertions</h4>{caseRun.assertionResults.map(item => <article key={item.id}><span className={`te-status-pill ${item.status === 'PASS' ? 'passed' : item.status === 'NOT_EVALUABLE' ? 'blocked' : 'failed'}`}>{item.status}</span><b>{item.type}</b><p>{item.message}</p><code>{item.code}</code></article>)}</section><section><h4>AI Evaluation</h4>{caseRun.evaluationResults.map(item => <article key={item.id}><span className={`te-status-pill ${item.status === 'PASS' ? 'passed' : item.status === 'NOT_EVALUABLE' ? 'blocked' : 'failed'}`}>{item.status}</span><b>{item.kind}</b><p>{item.criterion}</p><small>{item.explanation}</small></article>)}</section></div><section><h4>Trace / Evidence</h4><ol className="te-agent-trace">{caseRun.traceEvents.map(event => <li key={event.id}><code>{event.sequence}</code><b>{event.type}</b><span>{event.name ?? event.source}</span><small>{new Date(event.timestamp).toLocaleTimeString('zh-CN')}</small></li>)}</ol></section>{caseRun.actualOutput !== undefined && <details><summary>Actual Output</summary><pre>{JSON.stringify(caseRun.actualOutput, null, 2)}</pre></details>}</details>)}
    {result.failureAnalysis && <section className="te-agent-rca"><h4>Failure Analysis · Root Cause Candidate</h4><b>{diagnosisLabel(result.failureAnalysis.category)}</b><p>{result.failureAnalysis.reason}</p><small>{result.failureAnalysis.evidence}</small></section>}
    {result.evaluationError && <p className="te-empty">AI Evaluation unavailable：{result.evaluationError}</p>}{result.failureAnalysisError && <p className="te-empty">Failure Analysis unavailable：{result.failureAnalysisError}</p>}
  </section>
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
  return ({ pending: '待执行', script_generating: '执行中', ready: '待执行', running: '执行中', diagnosing: '执行中', retrying: '执行中', repairing: '修复中', passed: '通过', failed: '失败', blocked: '失败', unsupported: '失败', waiting_manual: '失败', cancelled: '已取消' })[status]
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

function methodLabel(method: ExecutionTask['input']['method']) {
  return ({ ui: 'UI', api: 'API', agent: 'Agent', performance_tool: '性能工具', long_running: '长时任务', environment_matrix: '环境矩阵' })[method]
}

function attemptStatusLabel(status: ExecutionTaskDetail['attempts'][number]['status']) {
  return ({ running: '执行中', passed: '通过', failed: '失败', cancelled: '已取消', infrastructure_error: '执行异常' })[status]
}

function artifactLabel(type: string) {
  return ({ screenshot: '截图', trace: 'Trace', video: '视频', log: '日志', script: '脚本', har: '网络记录', result: '执行结果', completion_manifest: '执行清单' } as Record<string, string>)[type] ?? type
}

function formatDuration(durationMs: number) {
  if (durationMs < 1_000) return `${durationMs} ms`
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} 秒`
  return `${Math.floor(durationMs / 60_000)} 分 ${Math.round(durationMs % 60_000 / 1_000)} 秒`
}
