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
  CaseMaintenanceProposal,
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
  maintenanceProposals,
  maintenanceFilter,
  busy,
  loading,
  onRefresh,
  onCreate,
  onOpen,
  onCancel,
  onToggleMaintenanceFilter,
}: {
  readiness: ExecutionReadiness | null
  environments: ExecutionEnvironment[]
  runs: ExecutionRun[]
  run: Versioned<ExecutionRun> | null
  maintenanceProposals: CaseMaintenanceProposal[]
  maintenanceFilter: boolean
  busy: string
  loading: boolean
  onRefresh: () => Promise<void>
  onCreate: (baseUrl: string) => Promise<ExecutionRun | undefined>
  onOpen: (runId: string) => Promise<ExecutionRun | undefined>
  onCancel: () => Promise<void>
  onToggleMaintenanceFilter: () => void
}) {
  const [baseUrl, setBaseUrl] = useState('')
  const pendingMaintenanceCount = maintenanceProposals.filter(item => item.status === 'pending').length

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
      <header><div><h2>创建测试执行</h2><p>服务端会在创建 Run 时冻结当前项目版本最新正式用例库中的全部可执行用例。</p></div></header>
      <div className="te-handoff-preview"><div><span>执行范围</span><b>全部正式用例</b></div><div><span>冻结时机</span><b>创建 Run</b></div></div>
      <label>被测系统地址<input type="url" list="test-execution-addresses" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://staging.example.com" autoComplete="url" /><small>可直接填写；服务端仅接受已登记 OCI 运行网络的地址，并在创建 Run 时冻结。</small></label>
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

    {run && <section className="te-card te-maintenance-summary">
      <header><div><h2>用例维护</h2><p>当前 Run 的建议只确认是否需要人工维护，不自动修改正式用例。</p></div><button className={maintenanceFilter ? 'te-primary' : 'te-secondary'} onClick={onToggleMaintenanceFilter}>待确认 {pendingMaintenanceCount}</button></header>
      <div className="te-task-metrics"><Metric label="全部建议" value={maintenanceProposals.length} /><Metric label="待确认" value={pendingMaintenanceCount} /><Metric label="已确认" value={maintenanceProposals.filter(item => item.status === 'accepted').length} /><Metric label="已拒绝" value={maintenanceProposals.filter(item => item.status === 'rejected').length} /></div>
    </section>}

    {run && <section className="te-card te-run-snapshot">
      <header><div><h2>Run 冻结快照</h2><p>开始后不再解析 latest、current 或 active。</p></div>{['queued', 'running'].includes(run.value.status) && <button className="te-danger" disabled={Boolean(busy) || Boolean(run.value.cancelRequestedAt)} onClick={() => void onCancel()}><Square />{run.value.cancelRequestedAt ? '已请求取消' : busy === 'cancel' ? '正在取消…' : '取消 Run'}</button>}</header>
      <dl>
        <div><dt>执行范围</dt><dd>全部正式用例</dd></div>
        <div><dt>冻结用例库</dt><dd title={run.value.handoff.testCaseLibraryVersionSha256}>{shortId(run.value.handoff.testCaseLibraryVersionId)}</dd></div>
        <div><dt>Environment</dt><dd>{run.value.environment.name} · {shortId(run.value.environment.signature)}</dd></div>
        <div><dt>Test data</dt><dd>{run.value.testData ? `需求 V${run.value.testData.sourceSetVersion} · ${run.value.testData.bindings.length} 项供给 · ${shortId(run.value.testData.contentSha256)}` : '无额外数据需求'}</dd></div>
        <div><dt>Runner</dt><dd>{run.value.runner.runnerVersion} · Playwright {run.value.runner.playwrightVersion}</dd></div>
        <div><dt>Image</dt><dd title={`${run.value.runner.imageReference}@${run.value.runner.imageDigest}`}>{run.value.runner.imageReference} · {shortId(run.value.runner.imageDigest)}</dd></div>
        <div><dt>Agent snapshots</dt><dd>{Object.values(run.value.agents).map(agent => `${agent.agentKey} v${agent.configurationVersion}`).join(' · ')}</dd></div>
      </dl>
    </section>}
  </div>
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div><span>{label}</span><b>{value}</b></div>
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
