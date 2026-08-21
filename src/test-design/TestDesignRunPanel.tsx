import { AlertTriangle, Bot, CheckCircle2, Database, LockKeyhole, RefreshCw, Server, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { PlanningContextMetrics, PlanningSubAgentRuns } from '../PlanningObservability'
import { runCoverageReviewer } from '../planning-api'
import type { TestDesign, TestDesignNodeRun, TestDesignWorkflowRun } from './types'

const flow = [
  { key: 'test_case_design', label: '用例生成', owner: 'PlanningAgent' },
  { key: 'coverage_audit', label: 'Coverage 检查', owner: '服务端' },
  { key: 'test_design_repair', label: '自动修复', owner: 'PlanningAgent · 自动修复' },
] as const

export function TestDesignRunPanel({ design, run, busy, onRefresh, onStartRun }: { design: TestDesign; run: TestDesignWorkflowRun | null; busy: boolean; onRefresh: () => void; onStartRun: () => void }) {
  const [reviewingCoverage, setReviewingCoverage] = useState(false)
  const [reviewError, setReviewError] = useState('')
  if (!run) return <section className="td2-card td2-empty"><Bot /><h2>{design.name}</h2><p>这个测试设计还没有运行。启动时将冻结当前绑定的 Requirement Release 与 Workspace。</p><button className="td2-button primary" onClick={onStartRun}>启动 TestDesign Run</button></section>
  const executions = run.nodeRuns.filter(node => node.execution).flatMap(node => node.execution ? [{ node, execution: node.execution }] : [])
  const context = executions.map(item => item.execution.context).filter(Boolean).at(-1)
  const nodeErrors = run.nodeRuns.filter(node => node.error)
  const eventErrors = executions.flatMap(({ node, execution }) => execution.events.filter(event => event.isError).map(event => ({ node, event })))
  const diagnosticCount = Number(Boolean(run.error)) + nodeErrors.length + eventErrors.length + Number(Boolean(reviewError))
  const hasValidCoverageAudit = run.coverageAudits.some(item => item.status === 'valid')
  const historicalBaseline = historicalBaselinePresentation(run.historicalSnapshot)
  const reviewCoverage = async () => {
    if (reviewingCoverage || !hasValidCoverageAudit) return
    setReviewingCoverage(true); setReviewError('')
    try { await runCoverageReviewer(run.id); onRefresh() }
    catch (error) { setReviewError(error instanceof Error ? error.message : 'Reviewer 执行失败') }
    finally { setReviewingCoverage(false) }
  }
  return <section className="td2-run-grid">
    <div className="td2-card td2-run-main">
      <header className="td2-section-head"><div><p className="td2-kicker">TestDesign Run</p><h2>{design.name}</h2><p>{design.objective}</p></div><div className="td2-run-actions"><span className={`td2-status ${run.status}`}>{run.status}</span><button className="td2-button ghost" disabled={busy} onClick={onRefresh}><RefreshCw />刷新</button></div></header>
      <div className="td2-progress"><span style={{ width: `${run.progress}%` }} /></div>
      <div className="td2-flow" aria-label="测试设计固定流程">{flow.map(item => <FlowStep key={item.key} node={run.nodeRuns.find(node => node.nodeKey === item.key)} label={item.label} owner={item.owner} repairState={item.key === 'test_design_repair' ? run.automaticRepair : undefined} runStatus={run.status} />)}</div>
      <div className="td2-snapshot-grid">
        <Snapshot icon={<LockKeyhole />} title="Requirement Release" primary={run.basisSnapshot.requirementReleaseId} secondary={`verificationRunId ${run.basisSnapshot.verificationRunId}`} hash={run.basisSnapshot.requirementReleaseContentSha256} />
        <Snapshot icon={<Database />} title="Workspace Snapshot" primary={run.workspaceSnapshot.activeBranchLogicalPath} secondary={`${run.currentInputRefs.length} 个重点输入 · ${run.workspaceSnapshot.files.length} 个冻结文件`} hash={run.workspaceSnapshot.snapshotSha256} />
        <Snapshot icon={<Database />} title="Historical Baseline" primary={historicalBaseline.primary} secondary={historicalBaseline.secondary} hash={run.historicalSnapshot.snapshotSha256} />
        <Snapshot icon={<Bot />} title="Agent 配置快照" primary={`V${run.agentConfigurationSnapshot.configurationVersion} · ${run.agentConfigurationSnapshot.primaryModel.modelName}`} secondary={run.agentConfigurationSnapshot.configurationId} hash={run.agentConfigurationSnapshot.configurationSha256} />
      </div>
      <PlanningContextMetrics context={context} />
      <div className="td2-reviewer-actions"><span><ShieldCheck /><b>AI Coverage 复核</b></span><div className="td2-reviewer-sources"><p>审阅对象：</p><ul><li>当前 TestCase 最新 Revision</li><li>当前有效 DataSet</li><li>最新有效 Coverage Audit</li></ul>{!hasValidCoverageAudit && <small>当前没有有效 Coverage Audit，请先完成或重新执行 Coverage 检查。</small>}</div><div className="td2-reviewer-buttons"><button disabled={reviewingCoverage || !hasValidCoverageAudit} onClick={() => void reviewCoverage()}>{reviewingCoverage ? '复核中…' : '开始 Coverage AI 复核'}</button></div></div>
      <PlanningSubAgentRuns runs={run.planningSubAgentRuns} />
      <details className={`td2-technical-diagnostics ${diagnosticCount ? 'has-errors' : ''}`}><summary><AlertTriangle /><span><b>技术诊断</b><small>{diagnosticCount ? `${diagnosticCount} 条异常记录，仅用于失败排查` : '当前没有运行异常'}</small></span></summary><div><dl><span><dt>Run ID</dt><dd>{run.id}</dd></span><span><dt>状态 / 阶段</dt><dd>{run.status} · {run.stage}</dd></span><span><dt>Node</dt><dd>{run.nodeRuns.length}</dd></span></dl>{run.error && <article><b>{run.errorCode ?? 'TEST_DESIGN_RUN_FAILED'}</b><p>{run.error}</p></article>}{nodeErrors.map(node => <article key={`node-${node.id}`}><b>{node.nodeKey} · {node.errorCode ?? 'TEST_DESIGN_NODE_FAILED'}</b><p>{node.error}</p><small>{node.id} · attempt {node.attempt}</small></article>)}{eventErrors.map(({ node, event }) => <article key={`event-${node.id}-${event.sequence}`}><b>{node.nodeKey} · {event.toolId ?? event.type}</b><p>{event.content ?? 'Agent 工具调用返回异常；完整事件请在主界面 Agent 协作中查看。'}</p><small>#{event.sequence} · {new Date(event.occurredAt).toLocaleString('zh-CN')}</small></article>)}{reviewError && <article><b>Reviewer 未完成</b><p>{reviewError}</p></article>}{!diagnosticCount && <p className="td2-diagnostic-empty">本次运行没有记录 Run、Node 或 Agent Tool 异常。</p>}</div></details>
    </div>
  </section>
}

function historicalBaselinePresentation(snapshot: TestDesignWorkflowRun['historicalSnapshot']) {
  if (!snapshot.sourceProjectVersionId) return { primary: '未开启继承', secondary: '当前 ProjectVersion 未启用版本继承' }
  if (!snapshot.sourceTestCaseLibraryVersionId) return { primary: `来源版本：${snapshot.sourceProjectVersionId}`, secondary: '来源版本暂无正式 TestCase Library · 本次 Run 按空 Historical Baseline 执行' }
  const requirementRelease = snapshot.sourceRequirementReleaseId ? ` · 来源 Requirement Release：${snapshot.sourceRequirementReleaseId}` : ''
  return { primary: `来源版本：${snapshot.sourceProjectVersionId}`, secondary: `正式用例库：${snapshot.sourceTestCaseLibraryVersionId} · 历史用例：${snapshot.items.length} 条${requirementRelease}` }
}

function FlowStep({ node, label, owner, repairState, runStatus }: { node?: TestDesignNodeRun; label: string; owner: string; repairState?: TestDesignWorkflowRun['automaticRepair']; runStatus: TestDesignWorkflowRun['status'] }) {
  const Icon = owner.startsWith('服务端') ? Server : Bot
  const repairLabel = repairState?.status === 'not_needed' ? 'not_needed · 无 agent_repair 阻断项' : repairState?.status === 'deferred' ? 'deferred · 等待相关人工决策' : repairState?.status === 'exhausted' ? `exhausted · ${repairState.attempt}/${repairState.maxAttempts}` : undefined
  const status = repairLabel ?? (node?.status === 'pending' && runStatus === 'succeeded' ? 'not_triggered · 本次 Run 已完成' : node?.status ?? 'pending')
  return <article className={node?.status ?? 'pending'}><span className="td2-flow-marker">{node?.status === 'succeeded' ? <CheckCircle2 /> : <Icon />}</span><div><b>{label}</b><small>{owner}</small><em>{status}{node?.attempt ? ` · attempt ${node.attempt}` : ''}</em></div></article>
}

function Snapshot({ icon, title, primary, secondary, hash }: { icon: React.ReactNode; title: string; primary: string; secondary: string; hash: string }) { return <article><i>{icon}</i><div><small>{title}</small><b>{primary}</b><span>{secondary}</span><code>{hash}</code></div></article> }
