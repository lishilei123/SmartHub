import {
  Bot,
  Box,
  CheckCircle2,
  Clock3,
  Database,
  Globe2,
  Play,
  RefreshCw,
  Server,
  ShieldAlert,
  Square,
} from 'lucide-react'
import { useState } from 'react'
import type {
  AgentUnderTest,
  ExecutionEnvironment,
  ExecutionReadiness,
  ExecutionRun,
  Versioned,
} from './types'

export function ExecutionRunPanel({
  readiness,
  environments,
  agentsUnderTest,
  runs,
  run,
  busy,
  loading,
  onRefresh,
  onCreate,
  onCreateAgentUnderTest,
  onOpen,
  onCancel,
}: {
  readiness: ExecutionReadiness | null
  environments: ExecutionEnvironment[]
  agentsUnderTest: AgentUnderTest[]
  runs: ExecutionRun[]
  run: Versioned<ExecutionRun> | null
  busy: string
  loading: boolean
  onRefresh: () => Promise<void>
  onCreate: (agentUnderTestId: string) => Promise<ExecutionRun | undefined>
  onCreateAgentUnderTest: (input: Parameters<typeof import('./api').createAgentUnderTest>[1]) => Promise<AgentUnderTest | undefined>
  onOpen: (runId: string) => Promise<ExecutionRun | undefined>
  onCancel: () => Promise<void>
}) {
  const [agentUnderTestId, setAgentUnderTestId] = useState('')
  const [showAgentForm, setShowAgentForm] = useState(false)
  const [agentDraft, setAgentDraft] = useState({ name: '', endpoint: '', protocol: 'http' as 'http' | 'sse', inputField: 'input', contextField: 'context', sessionIdField: 'sessionId', outputPath: 'output', tracePath: 'trace', traceCompleteness: 'partial' as 'complete' | 'partial' })
  const selectedAgent = agentsUnderTest.find(item => item.id === agentUnderTestId)

  return <div className="te-run-column">
    <section className="te-card te-readiness">
      <header><div><h2>Agent Test 就绪状态</h2><p>真实执行要求 PostgreSQL、AgentRunner 与 SmartHub Evaluation / FailureAnalysis 配置就绪。</p></div><button className="te-icon-button" disabled={loading} onClick={() => void onRefresh()} aria-label="刷新执行就绪状态"><RefreshCw /></button></header>
      <div className="te-readiness-grid">
        <ReadinessItem icon={<Database />} label="PostgreSQL" ready={readiness?.store.ready} reason={readiness?.store.reason} />
        <ReadinessItem icon={<Box />} label="Artifact Store" ready={readiness?.artifactStore.ready} reason={readiness?.artifactStore.reason} />
        <ReadinessItem icon={<Globe2 />} label="Agent Under Test" ready={agentsUnderTest.some(item => item.enabled)} reason={agentsUnderTest.length ? '请启用至少一个被测 Agent' : '尚未配置被测 Agent'} />
        <ReadinessItem icon={<Bot />} label="Evaluation / RCA Agent" ready={readiness?.agent?.ready} reason={readiness?.agent?.reason} />
        <ReadinessItem icon={<Server />} label="Deterministic AgentRunner" ready={readiness?.agent?.ready} reason={readiness?.agent?.reason} />
      </div>
      {readiness && <span className={`te-status-pill ${readiness.agent?.ready ? 'passed' : 'blocked'}`}>{readiness.agent?.ready ? 'Agent Runtime 可以真实执行' : 'Agent Runtime 尚未就绪'}</span>}
    </section>

    <section className="te-card te-create-card">
      <header><div><h2>创建测试执行</h2><p>服务端会在创建 Run 时冻结当前项目版本最新正式用例库中的全部可执行用例。</p></div></header>
      <div className="te-handoff-preview"><div><span>执行范围</span><b>全部正式用例</b></div><div><span>冻结时机</span><b>创建 Run</b></div></div>
      <label>Agent Under Test<select value={agentUnderTestId} onChange={event => setAgentUnderTestId(event.target.value)}><option value="">选择当前 ProjectVersion 的被测 Agent</option>{agentsUnderTest.filter(item => item.enabled).map(item => <option key={item.id} value={item.id}>{item.name} · {item.protocol.toUpperCase()}</option>)}</select><small>{selectedAgent ? `${selectedAgent.endpoint} · 配置 V${selectedAgent.currentVersion}` : 'Run 会冻结 endpoint、协议、映射与文档引用；凭据只保存环境变量名。'}</small></label>
      <button className="te-secondary" type="button" onClick={() => setShowAgentForm(value => !value)}>{showAgentForm ? '收起被测 Agent 配置' : '新增被测 Agent'}</button>
      {showAgentForm && <div className="te-agent-under-test-form"><label>名称<input value={agentDraft.name} onChange={event => setAgentDraft(value => ({ ...value, name: event.target.value }))} /></label><label>Endpoint<input type="url" value={agentDraft.endpoint} onChange={event => setAgentDraft(value => ({ ...value, endpoint: event.target.value }))} placeholder="https://agent.example.com/run" /></label><label>协议<select value={agentDraft.protocol} onChange={event => setAgentDraft(value => ({ ...value, protocol: event.target.value as 'http' | 'sse' }))}><option value="http">HTTP</option><option value="sse">SSE</option></select></label><label>Input 字段<input value={agentDraft.inputField} onChange={event => setAgentDraft(value => ({ ...value, inputField: event.target.value }))} /></label><label>Output Path<input value={agentDraft.outputPath} onChange={event => setAgentDraft(value => ({ ...value, outputPath: event.target.value }))} /></label><label>Trace Path<input value={agentDraft.tracePath} onChange={event => setAgentDraft(value => ({ ...value, tracePath: event.target.value }))} /></label><label>Trace 完整度<select value={agentDraft.traceCompleteness} onChange={event => setAgentDraft(value => ({ ...value, traceCompleteness: event.target.value as 'complete' | 'partial' }))}><option value="partial">Partial / 未承诺完整</option><option value="complete">Complete / 契约保证完整</option></select></label><button type="button" className="te-secondary" disabled={!agentDraft.name.trim() || !agentDraft.endpoint.trim() || Boolean(busy)} onClick={() => void onCreateAgentUnderTest({ name: agentDraft.name, endpoint: agentDraft.endpoint, protocol: agentDraft.protocol, authenticationConfig: { type: 'none' }, requestMapping: { method: 'POST', inputField: agentDraft.inputField, contextField: agentDraft.contextField, sessionIdField: agentDraft.sessionIdField }, responseMapping: { outputPath: agentDraft.outputPath, ...(agentDraft.tracePath ? { tracePath: agentDraft.tracePath } : {}), traceCompleteness: agentDraft.traceCompleteness }, documentationRefs: [] }).then(created => { if (created) { setAgentUnderTestId(created.id); setShowAgentForm(false) } })}>{busy === 'create-agent-under-test' ? '保存中…' : '保存被测 Agent'}</button></div>}
      <button className="te-primary" disabled={!readiness?.agent?.ready || !agentUnderTestId || Boolean(busy)} onClick={() => void onCreate(agentUnderTestId)}><Play />{busy === 'create' ? '正在冻结执行输入…' : '创建 Agent Test Run'}</button>
    </section>

    <section className="te-card te-run-history">
      <header><div><h2>执行历史</h2><p>只展示 PostgreSQL 中的正式 Run。</p></div><span>{runs.length}</span></header>
      <div className="te-run-list">
        {runs.map(item => <button key={item.id} className={run?.value.id === item.id ? 'active' : ''} onClick={() => void onOpen(item.id)}>
          <StatusMark status={item.status} /><span><b>全部正式用例 · {item.taskCount} Tasks</b><small>{new Date(item.createdAt).toLocaleString('zh-CN')}</small><code>{shortId(item.id)}</code></span><em className={`te-status-pill ${item.status}`}>{runStatusLabel(item.status)}</em>
        </button>)}
        {!runs.length && !loading && <p className="te-empty">暂无执行历史</p>}
      </div>
    </section>

    {run && <section className="te-card te-run-snapshot">
      <header><div><h2>本次执行</h2><p>查看目标环境、执行时间与必要运行信息。</p></div>{['queued', 'running'].includes(run.value.status) && <button className="te-danger" disabled={Boolean(busy) || Boolean(run.value.cancelRequestedAt)} onClick={() => void onCancel()}><Square />{run.value.cancelRequestedAt ? '已请求取消' : busy === 'cancel' ? '正在取消…' : '取消执行'}</button>}</header>
      <dl>
        <div><dt>执行范围</dt><dd>全部正式用例</dd></div>
        <div><dt>被测 Agent</dt><dd>{run.value.environment.name} · {run.value.environment.baseUrl}</dd></div>
        <div><dt>创建时间</dt><dd>{new Date(run.value.createdAt).toLocaleString('zh-CN')}</dd></div>
        <div><dt>执行耗时</dt><dd>{runDuration(run.value)}</dd></div>
        <div><dt>测试数据</dt><dd>{run.value.testData ? `需求 V${run.value.testData.sourceSetVersion} · ${run.value.testData.bindings.length} 项供给` : '无额外数据需求'}</dd></div>
      </dl>
      <details className="te-developer-details"><summary>开发者信息</summary><dl><div><dt>冻结用例库</dt><dd>{shortId(run.value.handoff.testCaseLibraryVersionId)}</dd></div><div><dt>Runner</dt><dd>{run.value.runner.runnerVersion}{run.value.runner.playwrightVersion ? ` · Playwright ${run.value.runner.playwrightVersion}` : ''}</dd></div><div><dt>协议</dt><dd>{run.value.environment.agentUnderTest?.protocol?.toUpperCase?.() ?? run.value.environment.targets[0]?.protocol.toUpperCase()}</dd></div><div><dt>平台 Agent 配置</dt><dd>{Object.values(run.value.agents).filter(Boolean).map(agent => `${agent!.agentKey} v${agent!.configurationVersion}`).join(' · ')}</dd></div></dl></details>
    </section>}
  </div>
}

function ReadinessItem({ icon, label, ready, reason }: { icon: React.ReactNode; label: string; ready?: boolean; reason?: string }) {
  return <div className={ready ? 'ready' : 'unavailable'}>{icon}<span><b>{label}</b><small title={reason}>{ready ? 'Ready' : reason ?? '正在检查'}</small></span>{ready ? <CheckCircle2 /> : <ShieldAlert />}</div>
}

function StatusMark({ status }: { status: ExecutionRun['status'] }) {
  return status === 'succeeded' ? <CheckCircle2 /> : status === 'queued' || status === 'running' ? <Clock3 /> : <ShieldAlert />
}

export function runStatusLabel(status: ExecutionRun['status']) {
  return ({ queued: '排队中', running: '执行中', succeeded: '成功', failed: '失败', partial: '部分完成', cancelled: '已取消' })[status]
}

export function shortId(value: string) {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value
}

function runDuration(run: ExecutionRun) {
  if (!run.startedAt) return '尚未开始'
  if (!run.finishedAt) return '执行中'
  const durationMs = Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt))
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} 秒`
  return `${Math.floor(durationMs / 60_000)} 分 ${Math.round(durationMs % 60_000 / 1_000)} 秒`
}
