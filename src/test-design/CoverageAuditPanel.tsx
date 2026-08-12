import { AlertTriangle, Bot, CheckCircle2, RefreshCw, Server, UserRoundCheck, Wrench } from 'lucide-react'
import type { TestDesignWorkflowRun } from './types'

export function CoverageAuditPanel({ run, busy, onAudit, onResolve }: { run: TestDesignWorkflowRun; busy: boolean; onAudit: () => void; onResolve: (kind: 'finding' | 'confirmation', id: string, expectedVersion: number) => void }) {
  const audit = [...run.coverageAudits].reverse().find(item => item.status === 'valid')
  const unresolvedFindings = run.findings.filter(item => item.state === 'open')
  const unresolvedConfirmations = run.confirmationItems.filter(item => item.state === 'open')
  const pass = Boolean(audit && audit.blockers.length === 0)
  return <section className="td2-card td2-audit">
    <header className="td2-section-head"><div><p className="td2-kicker">Server Coverage Audit</p><h2>确定性覆盖检查</h2><p>AI 负责怎么测试；服务端负责引用、覆盖、重复、维度、执行与数据就绪规则。</p></div><button className="td2-button ghost" disabled={busy || !run.testCases.length} onClick={onAudit}><RefreshCw />重新检查</button></header>
    {!audit ? <div className="td2-empty-compact"><Server /><span>等待测试用例生成后执行服务端审计</span></div> : <>
      <div className={pass ? 'td2-audit-result pass' : 'td2-audit-result blocked'}>{pass ? <CheckCircle2 /> : <AlertTriangle />}<div><b>{pass ? 'Audit PASS' : `${audit.blockers.length} 个发布阻断项`}</b><small>{audit.statistics.coveredBasis}/{audit.statistics.totalBasis} 需求依据 · {audit.statistics.coveredPoints}/{audit.statistics.totalPoints} 测试点 · {audit.statistics.approvedCases}/{audit.statistics.totalCases} 用例已批准</small><code>{audit.inputSha256}</code></div></div>
      {audit.blockers.length > 0 && <div className="td2-blocker-groups">{(['agent_repair', 'human_review', 'human_decision', 'manual_edit'] as const).map(resolution => {
        const items = audit.blockers.filter(item => item.resolution === resolution); if (!items.length) return null
        return <section key={resolution}><header>{resolution === 'agent_repair' ? <Bot /> : resolution === 'human_review' || resolution === 'human_decision' ? <UserRoundCheck /> : <Wrench />}<div><b>{resolutionLabel(resolution)}</b><small>{items.length} 项</small></div></header>{items.map((item, index) => <article key={`${item.code}-${item.subjectId ?? index}`}><code>{item.code}</code><p>{item.message}</p>{item.subjectId && <small>{item.subjectId}</small>}</article>)}</section>
      })}</div>}
      <div className="td2-repair-state"><Bot /><div><b>Agent Repair</b><small>仅处理 resolution=agent_repair；最多 {run.automaticRepair?.maxAttempts ?? 2} 轮</small></div><span>{run.automaticRepair?.status ?? 'idle'} · {run.automaticRepair?.attempt ?? 0}/{run.automaticRepair?.maxAttempts ?? 2}</span></div>
    </>}
    {(unresolvedFindings.length > 0 || unresolvedConfirmations.length > 0) && <div className="td2-decisions"><h3>等待人工决策</h3><p>业务规则、阈值、兼容矩阵与权限不明确时，TestDesignAgent 不得猜测。</p>{unresolvedFindings.map(item => <article key={item.id}><AlertTriangle /><div><b>{item.title}</b><p>{item.description}</p><small>Finding · {item.severity}</small></div><button className="td2-button ghost" disabled={busy} onClick={() => onResolve('finding', item.id, item.actions.length)}>标记已处理</button></article>)}{unresolvedConfirmations.map(item => <article key={item.id}><UserRoundCheck /><div><b>{item.title}</b><p>{item.question}</p><small>Confirmation · {item.impactStage}</small></div><button className="td2-button ghost" disabled={busy} onClick={() => onResolve('confirmation', item.id, item.actions.length)}>记录决策</button></article>)}</div>}
  </section>
}

function resolutionLabel(value: string) { return value === 'agent_repair' ? 'TestDesignAgent 可修复' : value === 'human_review' ? '需要用例审核' : value === 'human_decision' ? '需要业务决策' : '需要人工编辑' }
