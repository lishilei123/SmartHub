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
  ExecutionEnvironment,
  ExecutionReadiness,
  ExecutionRun,
  Versioned,
} from './types'

export function ExecutionRunPanel({
  readiness,
  environments,
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
  runs: ExecutionRun[]
  run: Versioned<ExecutionRun> | null
  busy: string
  loading: boolean
  onRefresh: () => Promise<void>
  onCreate: (baseUrl: string) => Promise<ExecutionRun | undefined>
  onOpen: (runId: string) => Promise<ExecutionRun | undefined>
  onCancel: () => Promise<void>
}) {
  const [baseUrl, setBaseUrl] = useState('')

  return <div className="te-run-column">
    <section className="te-card te-readiness">
      <header><div><h2>执行就绪状态</h2><p>生产执行要求正式存储、不可变 Artifact、受控 Agent 与 ProjectVersion Execution Workspace Runner 全部就绪。</p></div><button className="te-icon-button" disabled={loading} onClick={() => void onRefresh()} aria-label="刷新执行就绪状态"><RefreshCw /></button></header>
      <div className="te-readiness-grid">
        <ReadinessItem icon={<Database />} label="PostgreSQL" ready={readiness?.store.ready} reason={readiness?.store.reason} />
        <ReadinessItem icon={<Box />} label="Artifact Store" ready={readiness?.artifactStore.ready} reason={readiness?.artifactStore.reason} />
        <ReadinessItem icon={<Globe2 />} label="执行环境" ready={readiness?.environment.ready} reason={readiness?.environment.reason} />
        <ReadinessItem icon={<Bot />} label="执行 Agents" ready={readiness?.agents.ready} reason={readiness?.agents.agents.filter(item => !item.ready).map(item => item.reason ?? item.agentKey).join('；')} />
        <ReadinessItem icon={<Server />} label="Local Workspace Runner" ready={readiness?.runner.ready} reason={readiness?.runner.reason} />
      </div>
      {readiness && <span className={`te-status-pill ${readiness.ready ? 'passed' : 'blocked'}`}>{readiness.ready ? '可以创建真实执行' : 'Runner unavailable / Agent not ready'}</span>}
    </section>

    <section className="te-card te-create-card">
      <header><div><h2>创建测试执行</h2><p>服务端会在创建 Run 时冻结当前项目版本最新正式用例库中的全部可执行用例。</p></div></header>
      <div className="te-handoff-preview"><div><span>执行范围</span><b>全部正式用例</b></div><div><span>冻结时机</span><b>创建 Run</b></div></div>
      <label>被测系统地址<input type="url" list="test-execution-addresses" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://staging.example.com" autoComplete="url" /><small>服务端校验 http/https 地址，并在创建执行时冻结目标环境。</small></label>
      <datalist id="test-execution-addresses">{environments.map(item => <option key={item.environmentId} value={item.baseUrl} label={item.name} />)}</datalist>
      <button className="te-primary" disabled={!readiness?.ready || !baseUrl.trim() || Boolean(busy)} onClick={() => void onCreate(baseUrl)}><Play />{busy === 'create' ? '正在冻结执行输入…' : '创建执行 Run'}</button>
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
        <div><dt>目标环境</dt><dd>{run.value.environment.name} · {run.value.environment.baseUrl}</dd></div>
        <div><dt>创建时间</dt><dd>{new Date(run.value.createdAt).toLocaleString('zh-CN')}</dd></div>
        <div><dt>执行耗时</dt><dd>{runDuration(run.value)}</dd></div>
        <div><dt>测试数据</dt><dd>{run.value.testData ? `需求 V${run.value.testData.sourceSetVersion} · ${run.value.testData.bindings.length} 项供给` : '无额外数据需求'}</dd></div>
      </dl>
      <details className="te-developer-details"><summary>开发者信息</summary><dl><div><dt>冻结用例库</dt><dd>{shortId(run.value.handoff.testCaseLibraryVersionId)}</dd></div><div><dt>Runner</dt><dd>{run.value.runner.runnerVersion} · Playwright {run.value.runner.playwrightVersion}</dd></div><div><dt>Workspace</dt><dd>{run.value.runner.imageReference === 'local-workspace' ? 'ProjectVersion 隔离 Workspace' : run.value.runner.imageReference}</dd></div><div><dt>Agent 配置</dt><dd>{Object.values(run.value.agents).map(agent => `${agent.agentKey} v${agent.configurationVersion}`).join(' · ')}</dd></div></dl></details>
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
