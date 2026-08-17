import { Activity, Bot, CheckCircle2, Circle, Clock3, Database, LockKeyhole, RefreshCw, Server, ShieldCheck, Wrench } from 'lucide-react'
import { useEffect, useState } from 'react'
import { PlanningContextMetrics, PlanningSubAgentRuns } from '../PlanningObservability'
import {
  runTestDesignReviewer,
  type PlanningReviewerType,
  type TestDesignReviewerSourceSelection,
} from '../planning-api'
import type { TestDesign, TestDesignNodeRun, TestDesignWorkflowRun } from './types'

const flow = [
  { key: 'test_point_design', label: '测试点设计', owner: 'PlanningAgent' },
  { key: 'test_point_review', label: '测试点自动校验', owner: '服务端 Validator' },
  { key: 'test_case_design', label: '用例生成', owner: 'PlanningAgent' },
  { key: 'coverage_audit', label: 'Coverage 检查', owner: '服务端' },
  { key: 'test_design_repair', label: '自动修复', owner: 'PlanningAgent · 最多 2 次' },
] as const

export function TestDesignRunPanel({ design, run, busy, onRefresh, onStartRun }: { design: TestDesign; run: TestDesignWorkflowRun | null; busy: boolean; onRefresh: () => void; onStartRun: () => void }) {
  const [reviewing, setReviewing] = useState<PlanningReviewerType | ''>('')
  const [reviewError, setReviewError] = useState('')
  const [treeRevision, setTreeRevision] = useState('')
  const [treeVersionId, setTreeVersionId] = useState('')
  const [dataSetVersionId, setDataSetVersionId] = useState('')
  const [coverageAuditId, setCoverageAuditId] = useState('')
  const [caseRevisions, setCaseRevisions] = useState<Record<string, string>>({})
  useEffect(() => {
    setTreeRevision('')
    setTreeVersionId('')
    setDataSetVersionId('')
    setCoverageAuditId('')
    setCaseRevisions({})
  }, [run?.id])
  if (!run) return <section className="td2-card td2-empty"><Bot /><h2>{design.name}</h2><p>这个测试设计还没有运行。启动时将冻结当前绑定的 Requirement Release 与 Workspace。</p><button className="td2-button primary" onClick={onStartRun}>启动 TestDesign Run</button></section>
  const executions = run.nodeRuns.filter(node => node.execution).flatMap(node => node.execution ? [{ node, execution: node.execution }] : [])
  const events = executions.flatMap(item => item.execution.events.map(event => ({ ...event, stage: item.node.nodeKey }))).sort((left, right) => right.sequence - left.sequence).slice(0, 80)
  const context = executions.map(item => item.execution.context).filter(Boolean).at(-1)
  const selectedCases = run.testCases.filter(item => !item.tombstonedAt).flatMap(item => {
    const revision = Number(caseRevisions[item.id])
    return Number.isInteger(revision) && revision > 0
      ? [{ caseId: item.id, treeVersionId: item.treeVersionId, revision }]
      : []
  })
  const sourceSelection = (
    reviewerType: Exclude<PlanningReviewerType, 'requirement'>,
  ): TestDesignReviewerSourceSelection | undefined => {
    const revision = Number(treeRevision)
    if (!Number.isInteger(revision) || revision <= 0) return undefined
    if (reviewerType === 'test_point') {
      return { testPointTreeRevision: revision, testCases: [] }
    }
    if (
      !treeVersionId
      || !dataSetVersionId
      || selectedCases.length !== run.testCases.filter(item => !item.tombstonedAt).length
      || (reviewerType === 'coverage' && !coverageAuditId)
    ) return undefined
    return {
      testPointTreeRevision: revision,
      approvedTestPointTreeVersionId: treeVersionId,
      testCases: selectedCases,
      dataSetVersionId,
      ...(reviewerType === 'coverage' ? { coverageAuditId } : {}),
    }
  }
  const review = async (reviewerType: Exclude<PlanningReviewerType, 'requirement'>) => {
    const selection = sourceSelection(reviewerType)
    if (reviewing || !selection) return
    setReviewing(reviewerType); setReviewError('')
    try { await runTestDesignReviewer(run.id, reviewerType, selection); onRefresh() }
    catch (error) { setReviewError(error instanceof Error ? error.message : 'Reviewer 执行失败') }
    finally { setReviewing('') }
  }
  return <section className="td2-run-grid">
    <div className="td2-card td2-run-main">
      <header className="td2-section-head"><div><p className="td2-kicker">TestDesign Run</p><h2>{design.name}</h2><p>{design.objective}</p></div><div className="td2-run-actions"><span className={`td2-status ${run.status}`}>{run.status}</span><button className="td2-button ghost" disabled={busy} onClick={onRefresh}><RefreshCw />刷新</button></div></header>
      <div className="td2-progress"><span style={{ width: `${run.progress}%` }} /></div>
      <div className="td2-flow" aria-label="测试设计固定流程">{flow.map(item => <FlowStep key={item.key} node={run.nodeRuns.find(node => node.nodeKey === item.key)} label={item.label} owner={item.owner} />)}</div>
      <div className="td2-snapshot-grid">
        <Snapshot icon={<LockKeyhole />} title="Requirement Release" primary={run.basisSnapshot.requirementReleaseId} secondary={`verificationRunId ${run.basisSnapshot.verificationRunId}`} hash={run.basisSnapshot.requirementsJsonSha256} />
        <Snapshot icon={<Database />} title="Workspace Snapshot" primary={run.workspaceSnapshot.activeBranchLogicalPath} secondary={`${run.currentInputRefs.length} 个重点输入 · ${run.workspaceSnapshot.files.length} 个冻结文件`} hash={run.workspaceSnapshot.snapshotSha256} />
        <Snapshot icon={<Bot />} title="Agent 配置快照" primary={`V${run.agentConfigurationSnapshot.configurationVersion} · ${run.agentConfigurationSnapshot.primaryModel.modelName}`} secondary={run.agentConfigurationSnapshot.configurationId} hash={run.agentConfigurationSnapshot.configurationSha256} />
      </div>
      <PlanningContextMetrics context={context} />
      <div className="td2-reviewer-actions"><span><ShieldCheck /><b>只读 Reviewer SubAgents</b></span><div className="td2-reviewer-sources"><label>Tree Revision<select aria-label="Test Point Tree Revision" value={treeRevision} onChange={event => setTreeRevision(event.target.value)}><option value="">选择固定 Revision</option>{run.testPointTree?.revisions.map(revision => <option key={revision.revision} value={revision.revision}>R{revision.revision} · {revision.treeSha256.slice(0, 12)}</option>)}</select></label><label>Approved Tree Version<select aria-label="Approved Test Point Tree Version" value={treeVersionId} onChange={event => { const id = event.target.value; setTreeVersionId(id); const version = run.testPointTree?.versions.find(item => item.id === id); setTreeRevision(version ? String(version.revision) : '') }}><option value="">选择固定 Version</option>{run.testPointTree?.versions.map(version => <option key={version.id} value={version.id}>V{version.version} / R{version.revision} · {version.id}</option>)}</select></label><label>DataSet Version<select aria-label="Test DataSet Version" value={dataSetVersionId} onChange={event => setDataSetVersionId(event.target.value)}><option value="">选择固定 DataSet</option>{run.dataSetVersions.map(version => <option key={version.id} value={version.id}>V{version.version} · {version.id}</option>)}</select></label><label>Coverage Audit<select aria-label="Coverage Audit" value={coverageAuditId} onChange={event => { const id = event.target.value; setCoverageAuditId(id); const audit = run.coverageAudits.find(item => item.id === id); if (audit) { setTreeVersionId(audit.treeVersionId); setDataSetVersionId(audit.dataSetVersionId); const version = run.testPointTree?.versions.find(item => item.id === audit.treeVersionId); setTreeRevision(version ? String(version.revision) : '') } }}><option value="">选择固定 Audit</option>{run.coverageAudits.map(audit => <option key={audit.id} value={audit.id}>{audit.id} · {audit.status}</option>)}</select></label>{run.testCases.filter(item => !item.tombstonedAt).map(item => <label key={item.id}>Case {item.id}<select aria-label={`Test Case Revision ${item.id}`} value={caseRevisions[item.id] ?? ''} onChange={event => setCaseRevisions(current => ({ ...current, [item.id]: event.target.value }))}><option value="">选择固定 Revision</option>{item.revisions.map(revision => <option key={revision.revision} value={revision.revision}>R{revision.revision} · {revision.contentSha256.slice(0, 12)}</option>)}</select></label>)}</div><div className="td2-reviewer-buttons"><button disabled={Boolean(reviewing) || !sourceSelection('test_point')} onClick={() => void review('test_point')}>{reviewing === 'test_point' ? '审阅中…' : '测试点审阅'}</button><button disabled={Boolean(reviewing) || !sourceSelection('test_case')} onClick={() => void review('test_case')}>{reviewing === 'test_case' ? '审阅中…' : '测试用例审阅'}</button><button disabled={Boolean(reviewing) || !sourceSelection('coverage')} onClick={() => void review('coverage')}>{reviewing === 'coverage' ? '审阅中…' : 'Coverage 审阅'}</button></div></div>
      {reviewError && <div className="td2-error"><b>Reviewer 未完成</b><span>{reviewError}</span></div>}
      <PlanningSubAgentRuns runs={run.planningSubAgentRuns} />
      {run.error && <div className="td2-error"><b>{run.errorCode ?? '运行失败'}</b><span>{run.error}</span></div>}
    </div>
    <aside className="td2-card td2-trace"><header><div><Activity /><span><b>Pi Agent 实时轨迹</b><small>{executions.length} 次 Stage 执行 · {events.length} 条最近事件</small></span></div></header><div className="td2-trace-list">{events.length ? events.map(event => <article key={`${event.stage}-${event.sequence}-${event.toolCallId ?? ''}`} className={event.isError ? 'error' : ''}><i>{event.toolId ? <Wrench /> : event.type.includes('model') ? <Bot /> : <Circle />}</i><div><b>{event.toolId ?? event.type}</b><small>{stageLabel(event.stage)} · Turn {event.turn ?? '—'} · {formatTime(event.occurredAt)}</small>{event.content && <p>{truncate(event.content, 220)}</p>}</div></article>) : <div className="td2-empty-compact"><Clock3 /><span>等待 PlanningAgent 运行事件</span></div>}</div></aside>
  </section>
}

function FlowStep({ node, label, owner }: { node?: TestDesignNodeRun; label: string; owner: string }) {
  const Icon = owner.startsWith('服务端') ? Server : Bot
  return <article className={node?.status ?? 'pending'}><span className="td2-flow-marker">{node?.status === 'succeeded' ? <CheckCircle2 /> : <Icon />}</span><div><b>{label}</b><small>{owner}</small><em>{node?.status ?? 'pending'}{node?.attempt ? ` · attempt ${node.attempt}` : ''}</em></div></article>
}

function Snapshot({ icon, title, primary, secondary, hash }: { icon: React.ReactNode; title: string; primary: string; secondary: string; hash: string }) { return <article><i>{icon}</i><div><small>{title}</small><b>{primary}</b><span>{secondary}</span><code>{hash}</code></div></article> }
function stageLabel(value: string) { return flow.find(item => item.key === value)?.label ?? value }
function formatTime(value: string) { return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
function truncate(value: string, length: number) { return value.length > length ? `${value.slice(0, length)}…` : value }
