import { Activity, Bot, CheckCircle2, Circle, Clock3, Database, LockKeyhole, RefreshCw, Server, Wrench } from 'lucide-react'
import type { TestDesign, TestDesignNodeRun, TestDesignWorkflowRun } from './types'

const flow = [
  { key: 'test_point_design', label: '测试点设计', owner: 'TestDesignAgent' },
  { key: 'test_point_review', label: '测试点审核', owner: '人工门禁' },
  { key: 'test_case_design', label: '用例生成', owner: 'TestDesignAgent' },
  { key: 'coverage_audit', label: 'Coverage 检查', owner: '服务端' },
  { key: 'test_design_repair', label: '自动修复', owner: 'TestDesignAgent · 最多 2 次' },
] as const

export function TestDesignRunPanel({ design, run, busy, onRefresh, onStartRun }: { design: TestDesign; run: TestDesignWorkflowRun | null; busy: boolean; onRefresh: () => void; onStartRun: () => void }) {
  if (!run) return <section className="td2-card td2-empty"><Bot /><h2>{design.name}</h2><p>这个测试设计还没有运行。启动时将冻结当前绑定的 Requirement Release 与 Workspace。</p><button className="td2-button primary" onClick={onStartRun}>启动 TestDesign Run</button></section>
  const executions = run.nodeRuns.filter(node => node.execution).flatMap(node => node.execution ? [{ node, execution: node.execution }] : [])
  const events = executions.flatMap(item => item.execution.events.map(event => ({ ...event, stage: item.node.nodeKey }))).sort((left, right) => right.sequence - left.sequence).slice(0, 80)
  return <section className="td2-run-grid">
    <div className="td2-card td2-run-main">
      <header className="td2-section-head"><div><p className="td2-kicker">TestDesign Run</p><h2>{design.name}</h2><p>{design.objective}</p></div><div className="td2-run-actions"><span className={`td2-status ${run.status}`}>{run.status}</span><button className="td2-button ghost" disabled={busy} onClick={onRefresh}><RefreshCw />刷新</button></div></header>
      <div className="td2-progress"><span style={{ width: `${run.progress}%` }} /></div>
      <div className="td2-flow" aria-label="测试设计固定流程">{flow.map(item => <FlowStep key={item.key} node={run.nodeRuns.find(node => node.nodeKey === item.key)} label={item.label} owner={item.owner} />)}</div>
      <div className="td2-snapshot-grid">
        <Snapshot icon={<LockKeyhole />} title="Requirement Release" primary={run.basisSnapshot.requirementReleaseId} secondary={`verificationRunId ${run.basisSnapshot.verificationRunId}`} hash={run.basisSnapshot.requirementsJsonSha256} />
        <Snapshot icon={<Database />} title="Workspace Snapshot" primary={run.workspaceSnapshot.activeBranchLogicalPath} secondary={`${run.workspaceSnapshot.files.length} 个冻结文件`} hash={run.workspaceSnapshot.snapshotSha256} />
        <Snapshot icon={<Bot />} title="Agent 配置快照" primary={`V${run.agentConfigurationSnapshot.configurationVersion} · ${run.agentConfigurationSnapshot.primaryModel.modelName}`} secondary={run.agentConfigurationSnapshot.configurationId} hash={run.agentConfigurationSnapshot.configurationSha256} />
      </div>
      {run.error && <div className="td2-error"><b>{run.errorCode ?? '运行失败'}</b><span>{run.error}</span></div>}
    </div>
    <aside className="td2-card td2-trace"><header><div><Activity /><span><b>Pi Agent 实时轨迹</b><small>{executions.length} 次 Stage 执行 · {events.length} 条最近事件</small></span></div></header><div className="td2-trace-list">{events.length ? events.map(event => <article key={`${event.stage}-${event.sequence}-${event.toolCallId ?? ''}`} className={event.isError ? 'error' : ''}><i>{event.toolId ? <Wrench /> : event.type.includes('model') ? <Bot /> : <Circle />}</i><div><b>{event.toolId ?? event.type}</b><small>{stageLabel(event.stage)} · Turn {event.turn ?? '—'} · {formatTime(event.occurredAt)}</small>{event.content && <p>{truncate(event.content, 220)}</p>}</div></article>) : <div className="td2-empty-compact"><Clock3 /><span>等待 TestDesignAgent 运行事件</span></div>}</div></aside>
  </section>
}

function FlowStep({ node, label, owner }: { node?: TestDesignNodeRun; label: string; owner: string }) {
  const Icon = owner === '服务端' ? Server : owner === '人工门禁' ? LockKeyhole : Bot
  return <article className={node?.status ?? 'pending'}><span className="td2-flow-marker">{node?.status === 'succeeded' ? <CheckCircle2 /> : <Icon />}</span><div><b>{label}</b><small>{owner}</small><em>{node?.status ?? 'pending'}{node?.attempt ? ` · attempt ${node.attempt}` : ''}</em></div></article>
}

function Snapshot({ icon, title, primary, secondary, hash }: { icon: React.ReactNode; title: string; primary: string; secondary: string; hash: string }) { return <article><i>{icon}</i><div><small>{title}</small><b>{primary}</b><span>{secondary}</span><code>{hash}</code></div></article> }
function stageLabel(value: string) { return flow.find(item => item.key === value)?.label ?? value }
function formatTime(value: string) { return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
function truncate(value: string, length: number) { return value.length > length ? `${value.slice(0, length)}…` : value }
