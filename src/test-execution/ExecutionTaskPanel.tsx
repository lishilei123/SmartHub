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
        <header className="te-task-header"><div><span className={`te-status-pill ${task.value.task.status}`}>{taskStatusLabel(task.value.task.status)}</span><h2>{task.value.task.input.caseContent.title}</h2><p>{task.value.task.input.caseContent.expectedResults.join(' · ')}</p></div>{retryable(task.value.task.status) && <button className="te-primary" disabled={Boolean(busy)} onClick={() => void onRetry()}><RotateCcw />{busy === 'retry' ? '正在排队…' : '人工重试'}</button>}</header>
        <div className="te-task-metrics">
          <Metric label="执行方式" value={methodLabel(task.value.task.input.method)} />
          <Metric label="执行次数" value={task.value.task.runnerAttemptCount} />
          <Metric label="总耗时" value={formatDuration(task.value.attempts.reduce((total, item) => total + (item.durationMs ?? 0), 0))} />
          <Metric label="自动修复" value={`${task.value.task.repairCount}/2`} />
        </div>
        {task.value.task.status === 'unsupported' && <div className="te-state-message unsupported"><ShieldAlert /><span><b>V1 不支持此执行方法</b><small>{task.value.task.unsupportedReason}</small></span></div>}
        {task.value.task.status === 'blocked' && <div className="te-state-message blocked"><FileWarning /><span><b>外部条件阻塞</b><small>{executionErrorLabel(task.value.task.error)}</small></span></div>}
        {task.value.task.status === 'waiting_manual' && <div className="te-state-message waiting_manual"><AlertTriangle /><span><b>等待人工处理</b><small>{executionErrorLabel(task.value.task.error) ?? '自动修复已收口，历史不会被重置。'}</small></span></div>}
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
      const visualStatus = event.type === 'http' && event.status === 'passed' ? 'observed' : event.status
      return <li key={event.id} className={visualStatus}>
        <span className="te-event-rail"><EventIcon type={event.type} /></span>
        <div>
          <header><b>{event.title}</b><em className={`te-status-pill ${visualStatus}`}>{eventStatusLabel(event)}</em></header>
          {event.type === 'http' && <p className="te-http-summary"><strong>{event.metadata?.method}</strong><code>{event.metadata?.path}</code>{event.metadata?.httpStatus !== undefined && <span className={event.metadata.httpStatus >= 400 ? 'error' : ''}>{event.metadata.httpStatus}</span>}</p>}
          {event.type === 'http' && (event.metadata?.request || event.metadata?.response) && <details className="te-http-evidence">
            <summary>查看请求 / 响应数据</summary>
            <div>
              {event.metadata.request && <HttpPayload title="请求" payload={event.metadata.request} />}
              {event.metadata.response && <HttpPayload title="响应" payload={event.metadata.response} />}
            </div>
          </details>}
          {event.metadata?.queryFields?.length ? <small>Query 字段：{event.metadata.queryFields.join('、')}</small> : null}
          {event.metadata?.location ? <small>失败位置：{event.metadata.location.file}:{event.metadata.location.line}:{event.metadata.location.column}</small> : null}
          <small>{new Date(event.startedAt).toLocaleTimeString('zh-CN')}{event.durationMs !== undefined ? ` · ${event.durationMs} ms` : ''} · Playwright Reporter</small>
          {linked.length > 0 && <div className="te-event-artifacts">{linked.map(artifact => <a key={artifact.id} href={artifactUrl(artifact.id, artifact.type === 'screenshot' ? 'inline' : 'attachment')} target="_blank" rel="noreferrer"><ArtifactIcon type={artifact.type} />{artifact.type}</a>)}</div>}
        </div>
      </li>
    })}
    {!events.length && <li className="empty"><Activity /><span>该 Attempt 尚未收到结构化 Playwright Reporter 事件</span></li>}
  </ol>
}

function HttpPayload({ title, payload }: {
  title: '请求' | '响应'
  payload: NonNullable<NonNullable<ExecutionTaskDetail['events'][number]['metadata']>['request']>
}) {
  return <section>
    <header><b>{title}</b><small>{payload.contentType ?? '未知类型'} · {formatBytes(payload.bodyBytes)}{payload.truncated ? ' · 内容过大，仅记录元数据' : ''}</small></header>
    {payload.body !== undefined ? <pre>{typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body, null, 2)}</pre> : <p>无可展示正文</p>}
  </section>
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

function eventStatusLabel(event: ExecutionTaskDetail['events'][number]) {
  if (event.type === 'http' && event.status === 'passed') return '已返回'
  return ({ running: '进行中', passed: '完成', failed: '失败', skipped: '跳过' })[event.status]
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

function executionErrorLabel(error?: string) {
  if (!error) return undefined
  const labels: Record<string, string> = {
    BROWSER_AUTHENTICATION_ENTRY_NOT_FOUND: '当前执行环境没有可识别的同源登录入口，尚未启动 Runner。',
    BROWSER_AUTHENTICATION_CREDENTIALS_REQUIRED: '登录页未提供受管的预填凭据；请先配置测试数据或 Runtime Secret，再人工重试。',
    BROWSER_AUTHENTICATION_SUBMIT_AMBIGUOUS: '登录页存在多个候选提交入口，平台未擅自选择；请完善受管认证配置。',
    BROWSER_AUTHENTICATION_NOT_ESTABLISHED: '已提交登录，但未观察到成功认证证据，登录态没有保存，Runner 未启动。',
    TEST_EXECUTION_AUTH_STATE_PREPARATION_REQUIRED: '当前 Runtime 未配置受控 Browser Gateway，无法准备登录态。',
    TEST_EXECUTION_AUTH_STATE_REQUIRED: '受保护用例缺少已校验的 Run 登录态，Runner 未启动。',
  }
  return labels[error] ?? error
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`
  return `${(size / 1024 / 1024).toFixed(1)} MiB`
}

function methodLabel(method: ExecutionTask['input']['method']) {
  return ({ ui: 'UI', api: 'API', performance_tool: '性能工具', long_running: '长时任务', environment_matrix: '环境矩阵' })[method]
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
