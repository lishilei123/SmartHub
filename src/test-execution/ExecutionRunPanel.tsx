import { Bot, CheckCircle2, Clock3, Cpu, Database, Play, RefreshCw, Server, ShieldAlert, Square } from 'lucide-react'
import { useState } from 'react'
import type { AgentUnderTest, ExecutionReadiness, ExecutionRun, Versioned } from './types'

type CreateAgentInput = Parameters<typeof import('./api').createAgentUnderTest>[1]
type AgentDraft = {
  name: string; endpoint: string; protocol: 'http' | 'sse'
  authType: 'none' | 'bearer_env' | 'api_key_env'; authEnvironmentVariable: string; authHeaderName: string
  inputField: string; contextField: string; sessionIdField: string; headersJson: string
  outputPath: string; tracePath: string; tokenUsagePath: string; costPath: string; traceCompleteness: 'complete' | 'partial'
  documentationRefs: string
}

const emptyDraft: AgentDraft = {
  name: '', endpoint: '', protocol: 'http', authType: 'none', authEnvironmentVariable: '', authHeaderName: 'x-api-key',
  inputField: 'input', contextField: 'context', sessionIdField: 'sessionId', headersJson: '{}',
  outputPath: 'output', tracePath: 'trace', tokenUsagePath: '', costPath: '', traceCompleteness: 'partial', documentationRefs: '',
}

export function ExecutionRunPanel({ readiness, agentsUnderTest, runs, run, busy, loading, onRefresh, onCreate, onCreateAgentUnderTest, onOpen, onCancel }: {
  readiness: ExecutionReadiness | null; agentsUnderTest: AgentUnderTest[]; runs: ExecutionRun[]; run: Versioned<ExecutionRun> | null
  busy: string; loading: boolean; onRefresh: () => Promise<void>; onCreate: (id: string) => Promise<ExecutionRun | undefined>
  onCreateAgentUnderTest: (input: CreateAgentInput) => Promise<AgentUnderTest | undefined>
  onOpen: (id: string) => Promise<ExecutionRun | undefined>; onCancel: () => Promise<void>
}) {
  const [agentUnderTestId, setAgentUnderTestId] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [draft, setDraft] = useState<AgentDraft>(emptyDraft)
  const [formError, setFormError] = useState('')
  const selectedAgent = agentsUnderTest.find(item => item.id === agentUnderTestId)

  const saveAgent = async () => {
    try {
      setFormError('')
      const created = await onCreateAgentUnderTest(agentInput(draft))
      if (created) {
        setAgentUnderTestId(created.id)
        setDraft(emptyDraft)
        setShowForm(false)
      }
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return <div className="te-run-column">
    <section className="te-card te-readiness">
      <header><div><h2>Agent Test 就绪状态</h2><p>检查 PostgreSQL、在线 Worker、AgentRunner 与失败分析 Agent。</p></div><button className="te-icon-button" disabled={loading} onClick={() => void onRefresh()}><RefreshCw /></button></header>
      <div className="te-readiness-grid">
        <ReadinessItem icon={<Database />} label="PostgreSQL" ready={readiness?.store.ready} reason={readiness?.store.reason} />
        <ReadinessItem icon={<Cpu />} label="Worker" ready={readiness?.worker.ready} reason={readiness?.worker.ready ? `${readiness.worker.activeWorkers} online` : readiness?.worker.reason} />
        <ReadinessItem icon={<Server />} label="AgentRunner" ready={readiness?.runner.ready} />
        <ReadinessItem icon={<Bot />} label="FailureAnalysis" ready={readiness?.agent.ready} reason={readiness?.agent.reason} />
      </div>
    </section>

    <section className="te-card te-create-card">
      <header><div><h2>创建 Agent Test Run</h2><p>冻结正式 Agent Case、被测 Agent 版本与平台诊断配置。</p></div></header>
      <label>Agent Under Test<select value={agentUnderTestId} onChange={event => setAgentUnderTestId(event.target.value)}><option value="">选择被测 Agent</option>{agentsUnderTest.filter(item => item.enabled).map(item => <option key={item.id} value={item.id}>{item.name} · V{item.currentVersion}</option>)}</select><small>{selectedAgent ? selectedAgent.endpoint : '凭据只保存环境变量引用。'}</small></label>
      <button className="te-secondary" onClick={() => setShowForm(value => !value)}>{showForm ? '收起配置' : '新增被测 Agent'}</button>
      {showForm && <div className="te-agent-under-test-form">
        <label>名称<input value={draft.name} onChange={event => updateDraft(setDraft, 'name', event.target.value)} /></label>
        <label>Endpoint<input type="url" value={draft.endpoint} onChange={event => updateDraft(setDraft, 'endpoint', event.target.value)} /></label>
        <label>协议<select value={draft.protocol} onChange={event => updateDraft(setDraft, 'protocol', event.target.value as AgentDraft['protocol'])}><option value="http">HTTP</option><option value="sse">SSE</option></select></label>
        <label>认证<select value={draft.authType} onChange={event => updateDraft(setDraft, 'authType', event.target.value as AgentDraft['authType'])}><option value="none">无认证</option><option value="bearer_env">Bearer 环境变量</option><option value="api_key_env">API Key 环境变量</option></select></label>
        {draft.authType !== 'none' && <label>凭据环境变量<input placeholder="AUT_API_KEY" value={draft.authEnvironmentVariable} onChange={event => updateDraft(setDraft, 'authEnvironmentVariable', event.target.value.toUpperCase())} /></label>}
        {draft.authType === 'api_key_env' && <label>API Key Header<input value={draft.authHeaderName} onChange={event => updateDraft(setDraft, 'authHeaderName', event.target.value)} /></label>}
        <label>Input 字段<input value={draft.inputField} onChange={event => updateDraft(setDraft, 'inputField', event.target.value)} /></label>
        <label>Context 字段（可空）<input value={draft.contextField} onChange={event => updateDraft(setDraft, 'contextField', event.target.value)} /></label>
        <label>Session ID 字段（可空）<input value={draft.sessionIdField} onChange={event => updateDraft(setDraft, 'sessionIdField', event.target.value)} /></label>
        <label>固定请求头 JSON<textarea rows={3} value={draft.headersJson} onChange={event => updateDraft(setDraft, 'headersJson', event.target.value)} /></label>
        <label>Output Path<input value={draft.outputPath} onChange={event => updateDraft(setDraft, 'outputPath', event.target.value)} /></label>
        <label>Trace Path（可空）<input value={draft.tracePath} onChange={event => updateDraft(setDraft, 'tracePath', event.target.value)} /></label>
        {draft.tracePath && <label>Trace 完整性<select value={draft.traceCompleteness} onChange={event => updateDraft(setDraft, 'traceCompleteness', event.target.value as AgentDraft['traceCompleteness'])}><option value="partial">Partial</option><option value="complete">Complete</option></select></label>}
        <label>Token Usage Path（可空）<input value={draft.tokenUsagePath} onChange={event => updateDraft(setDraft, 'tokenUsagePath', event.target.value)} /></label>
        <label>Cost Path（可空）<input value={draft.costPath} onChange={event => updateDraft(setDraft, 'costPath', event.target.value)} /></label>
        <label>文档引用（每行一项）<textarea rows={3} value={draft.documentationRefs} onChange={event => updateDraft(setDraft, 'documentationRefs', event.target.value)} /></label>
        {formError && <div className="te-global-error">{formError}</div>}
        <button className="te-secondary" disabled={!draft.name.trim() || !draft.endpoint.trim() || Boolean(busy)} onClick={() => void saveAgent()}>保存被测 Agent</button>
      </div>}
      <button className="te-primary" disabled={!readiness?.ready || !agentUnderTestId || Boolean(busy)} onClick={() => void onCreate(agentUnderTestId)}><Play />{busy === 'create' ? '创建中…' : '创建 Agent Test Run'}</button>
    </section>

    <section className="te-card te-run-history"><header><div><h2>Agent Test 历史</h2><p>PostgreSQL 正式 Run。</p></div><span>{runs.length}</span></header><div className="te-run-list">{runs.map(item => <button key={item.id} className={run?.value.id === item.id ? 'active' : ''} onClick={() => void onOpen(item.id)}><StatusMark status={item.status} /><span><b>{item.agentUnderTest.name} · {item.taskCount} Tasks</b><small>{new Date(item.createdAt).toLocaleString('zh-CN')}</small><code>{shortId(item.id)}</code></span><em className={`te-status-pill ${item.status}`}>{runStatusLabel(item.status)}</em></button>)}{!runs.length && !loading && <p className="te-empty">暂无 Agent Test 历史</p>}</div></section>
    {run && <section className="te-card te-run-snapshot"><header><div><h2>本次执行</h2><p>冻结的 Agent Test 正式事实。</p></div>{['queued', 'running'].includes(run.value.status) && <button className="te-danger" disabled={Boolean(busy) || Boolean(run.value.cancelRequestedAt)} onClick={() => void onCancel()}><Square />取消</button>}</header><dl><div><dt>被测 Agent</dt><dd>{run.value.agentUnderTest.name} · V{run.value.agentUnderTest.version}</dd></div><div><dt>协议</dt><dd>{run.value.agentUnderTest.protocol.toUpperCase()}</dd></div><div><dt>Runner</dt><dd>{run.value.runner.runnerVersion}</dd></div><div><dt>用例库</dt><dd>{shortId(run.value.handoff.testCaseLibraryVersionId)}</dd></div><div><dt>失败分析</dt><dd>V{run.value.agents.failureAnalysis.configurationVersion}</dd></div></dl></section>}
  </div>
}

function agentInput(draft: AgentDraft): CreateAgentInput {
  let headers: Record<string, string>
  try {
    const parsed = JSON.parse(draft.headersJson || '{}') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(value => typeof value !== 'string')) throw new Error('固定请求头必须是字符串值 JSON 对象')
    headers = parsed as Record<string, string>
  } catch (cause) {
    throw new Error(cause instanceof Error ? cause.message : '固定请求头 JSON 无效')
  }
  const authenticationConfig: CreateAgentInput['authenticationConfig'] = draft.authType === 'none'
    ? { type: 'none' }
    : draft.authType === 'bearer_env'
      ? { type: 'bearer_env', environmentVariable: draft.authEnvironmentVariable }
      : { type: 'api_key_env', headerName: draft.authHeaderName, environmentVariable: draft.authEnvironmentVariable }
  return {
    name: draft.name,
    endpoint: draft.endpoint,
    protocol: draft.protocol,
    authenticationConfig,
    requestMapping: { method: 'POST', inputField: draft.inputField, ...(draft.contextField ? { contextField: draft.contextField } : {}), ...(draft.sessionIdField ? { sessionIdField: draft.sessionIdField } : {}), ...(Object.keys(headers).length ? { headers } : {}) },
    responseMapping: { outputPath: draft.outputPath, ...(draft.tracePath ? { tracePath: draft.tracePath, traceCompleteness: draft.traceCompleteness } : {}), ...(draft.tokenUsagePath ? { tokenUsagePath: draft.tokenUsagePath } : {}), ...(draft.costPath ? { costPath: draft.costPath } : {}) },
    documentationRefs: draft.documentationRefs.split(/\r?\n/u).map(item => item.trim()).filter(Boolean),
  }
}

function updateDraft<K extends keyof AgentDraft>(setDraft: React.Dispatch<React.SetStateAction<AgentDraft>>, key: K, value: AgentDraft[K]) {
  setDraft(current => ({ ...current, [key]: value }))
}
function ReadinessItem({ icon, label, ready, reason }: { icon: React.ReactNode; label: string; ready?: boolean; reason?: string }) { return <div className={ready ? 'ready' : 'unavailable'}>{icon}<span><b>{label}</b><small>{ready ? reason ?? 'Ready' : reason ?? '未就绪'}</small></span>{ready ? <CheckCircle2 /> : <ShieldAlert />}</div> }
function StatusMark({ status }: { status: ExecutionRun['status'] }) { return status === 'succeeded' ? <CheckCircle2 /> : ['queued', 'running'].includes(status) ? <Clock3 /> : <ShieldAlert /> }
export function runStatusLabel(status: ExecutionRun['status']) { return ({ queued: '排队中', running: '执行中', succeeded: '成功', failed: '失败', partial: '部分完成', cancelled: '已取消' })[status] }
export function shortId(value: string) { return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value }
