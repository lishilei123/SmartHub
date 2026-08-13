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
import { useEffect, useMemo, useState } from 'react'
import type {
  ExecutionEnvironment,
  ExecutionHandoff,
  ExecutionReadiness,
  ExecutionRun,
  Versioned,
} from './types'

export function ExecutionRunPanel({
  readiness,
  environments,
  handoffs,
  runs,
  run,
  busy,
  loading,
  onRefresh,
  onCreate,
  onOpen,
  onCancel,
}: {
  readiness: ExecutionReadiness | null
  environments: ExecutionEnvironment[]
  handoffs: ExecutionHandoff[]
  runs: ExecutionRun[]
  run: Versioned<ExecutionRun> | null
  busy: string
  loading: boolean
  onRefresh: () => Promise<void>
  onCreate: (handoffId: string, environmentId: string) => Promise<ExecutionRun | undefined>
  onOpen: (runId: string) => Promise<ExecutionRun | undefined>
  onCancel: () => Promise<void>
}) {
  const [handoffId, setHandoffId] = useState('')
  const [environmentId, setEnvironmentId] = useState('')
  useEffect(() => {
    setHandoffId(current => handoffs.some(item => item.id === current)
      ? current
      : handoffs[0]?.id ?? '')
  }, [handoffs])
  useEffect(() => {
    setEnvironmentId(current => environments.some(item => item.environmentId === current)
      ? current
      : environments[0]?.environmentId ?? '')
  }, [environments])
  const handoff = handoffs.find(item => item.id === handoffId)
  const counts = useMemo(() => handoff?.members.reduce((result, member) => {
    if (member.method === 'ui') result.ui += 1
    else if (member.method === 'api') result.api += 1
    else result.unsupported += 1
    return result
  }, { ui: 0, api: 0, unsupported: 0 }) ?? { ui: 0, api: 0, unsupported: 0 }, [handoff])

  return <div className="te-run-column">
    <section className="te-card te-readiness">
      <header><div><h2>执行就绪状态</h2><p>生产执行要求正式存储、不可变 Artifact、三个独立 Agent 与 OCI Runner 全部就绪。</p></div><button className="te-icon-button" disabled={loading} onClick={() => void onRefresh()} aria-label="刷新执行就绪状态"><RefreshCw /></button></header>
      <div className="te-readiness-grid">
        <ReadinessItem icon={<Database />} label="PostgreSQL" ready={readiness?.store.ready} reason={readiness?.store.reason} />
        <ReadinessItem icon={<Box />} label="Artifact Store" ready={readiness?.artifactStore.ready} reason={readiness?.artifactStore.reason} />
        <ReadinessItem icon={<Globe2 />} label="执行环境" ready={readiness?.environment.ready} reason={readiness?.environment.reason} />
        <ReadinessItem icon={<Bot />} label="执行 Agents" ready={readiness?.agents.ready} reason={readiness?.agents.agents.filter(item => !item.ready).map(item => item.reason ?? item.agentKey).join('；')} />
        <ReadinessItem icon={<Server />} label="OCI Runner" ready={readiness?.runner.ready} reason={readiness?.runner.reason} />
      </div>
      {readiness && <span className={`te-status-pill ${readiness.ready ? 'passed' : 'blocked'}`}>{readiness.ready ? '可以创建真实执行' : 'Runner unavailable / Agent not ready'}</span>}
    </section>

    <section className="te-card te-create-card">
      <header><div><h2>创建测试执行</h2><p>唯一正式输入是已发布的 TestExecutionHandoff；执行模式只读。</p></div></header>
      <label>Execution Handoff<select value={handoffId} onChange={event => setHandoffId(event.target.value)}><option value="">选择不可变 Handoff</option>{handoffs.map(item => <option key={item.id} value={item.id}>{item.mode} · {item.members.length} 个成员 · {shortId(item.id)}</option>)}</select></label>
      <label>执行环境<select value={environmentId} onChange={event => setEnvironmentId(event.target.value)}><option value="">选择服务端环境</option>{environments.map(item => <option key={item.environmentId} value={item.environmentId}>{item.name} · {item.baseUrl}</option>)}</select></label>
      {handoff && <div className="te-handoff-preview">
        <div><span>模式</span><b>{handoff.mode}</b></div><div><span>UI</span><b>{counts.ui}</b></div><div><span>API</span><b>{counts.api}</b></div><div><span>Unsupported</span><b>{counts.unsupported}</b></div>
        <code title={handoff.contentSha256}>{handoff.contentSha256}</code>
      </div>}
      {!handoffs.length && !loading && <p className="te-empty-note"><ShieldAlert />当前项目版本没有可执行 Handoff，请先在测试设计中发布正式用例库与交接。</p>}
      <button className="te-primary" disabled={!readiness?.ready || !handoffId || !environmentId || Boolean(busy)} onClick={() => void onCreate(handoffId, environmentId)}><Play />{busy === 'create' ? '正在冻结执行输入…' : '创建执行 Run'}</button>
    </section>

    <section className="te-card te-run-history">
      <header><div><h2>执行历史</h2><p>只展示 PostgreSQL 中的正式 Run。</p></div><span>{runs.length}</span></header>
      <div className="te-run-list">
        {runs.map(item => <button key={item.id} className={run?.value.id === item.id ? 'active' : ''} onClick={() => void onOpen(item.id)}>
          <StatusMark status={item.status} /><span><b>{item.handoff.mode} · {item.taskCount} Tasks</b><small>{new Date(item.createdAt).toLocaleString('zh-CN')}</small><code>{shortId(item.id)}</code></span><em className={`te-status-pill ${item.status}`}>{runStatusLabel(item.status)}</em>
        </button>)}
        {!runs.length && !loading && <p className="te-empty">暂无执行历史</p>}
      </div>
    </section>

    {run && <section className="te-card te-run-snapshot">
      <header><div><h2>Run 冻结快照</h2><p>开始后不再解析 latest、current 或 active。</p></div>{['queued', 'running'].includes(run.value.status) && <button className="te-danger" disabled={Boolean(busy) || Boolean(run.value.cancelRequestedAt)} onClick={() => void onCancel()}><Square />{run.value.cancelRequestedAt ? '已请求取消' : busy === 'cancel' ? '正在取消…' : '取消 Run'}</button>}</header>
      <dl>
        <div><dt>Handoff</dt><dd>{shortId(run.value.handoff.handoffId)} · {run.value.handoff.mode}</dd></div>
        <div><dt>Library</dt><dd title={run.value.handoff.testCaseLibraryVersionSha256}>{shortId(run.value.handoff.testCaseLibraryVersionId)}</dd></div>
        <div><dt>Environment</dt><dd>{run.value.environment.name} · {shortId(run.value.environment.signature)}</dd></div>
        <div><dt>Runner</dt><dd>{run.value.runner.runnerVersion} · Playwright {run.value.runner.playwrightVersion}</dd></div>
        <div><dt>Image</dt><dd title={`${run.value.runner.imageReference}@${run.value.runner.imageDigest}`}>{run.value.runner.imageReference} · {shortId(run.value.runner.imageDigest)}</dd></div>
        <div><dt>Agent snapshots</dt><dd>{Object.values(run.value.agents).map(agent => `${agent.agentKey} v${agent.configurationVersion}`).join(' · ')}</dd></div>
      </dl>
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
