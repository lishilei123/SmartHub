import { AlertTriangle, Bot, CheckCircle2, RefreshCw, Server } from 'lucide-react'
import type { TestDesignWorkflowRun } from './types'

export function CoverageAuditPanel({ run, busy, onAudit }: { run: TestDesignWorkflowRun; busy: boolean; onAudit: () => void }) {
  const audit = run.coverageAudits.at(-1)
  const stale = audit?.status === 'stale'
  const pass = audit?.status === 'valid' && audit.blockers.length === 0
  return <section className="td2-card td2-audit">
    <header className="td2-section-head"><div><p className="td2-kicker">Server Coverage Audit</p><h2>确定性覆盖检查</h2><p>Coverage 基于 Effective Case Set 的当前 Requirement Release 追溯投影，只检查 coverageTarget Requirement；历史 RP 编号不会直接跨版本证明覆盖。</p></div><button className={`td2-button ${stale ? 'primary' : 'ghost'}`} disabled={busy || (run.effectiveCaseCount ?? run.testCases.length) === 0} onClick={onAudit}><RefreshCw />{stale ? '重新检查当前内容' : '重新检查'}</button></header>
    {!audit ? <div className="td2-empty-compact"><Server /><span>等待 TestCase 生成后执行服务端审计</span></div> : <>
      <div className={`td2-audit-state ${pass ? 'pass' : stale ? 'stale' : 'blocked'}`}>{pass ? <CheckCircle2 /> : <AlertTriangle />}<div><b>{pass ? 'Coverage Audit 已通过' : stale ? '当前结果已失效' : `存在 ${audit.blockers.length} 个阻断项`}</b><small>{pass ? '所有 coverageTarget Requirement 均有 Effective Case 显式引用。' : '按下方确定性问题修改 Candidate Delta 后重新检查。'}</small></div></div>
      <p className="tdw-muted">需求追溯覆盖率只表示 coverageTarget Requirement 已有 TestCase direct trace，不表示异常、边界或组合场景已 100% 覆盖。</p>
      <div className="td2-audit-kpis"><span><small>需求追溯覆盖率</small><b>{audit.statistics.coveredBasis}/{audit.statistics.totalBasis}</b></span><span><small>Effective TestCase</small><b>{audit.statistics.totalCases}</b></span><span><small>Blockers</small><b>{audit.blockers.length}</b></span><span><small>Advisories</small><b>{audit.advisories.length}</b></span></div>
      {audit.blockers.length > 0 && <section className="td2-audit-categories"><header><div><h3>必须处理</h3><p>无效引用、未覆盖 Requirement 或不完整语义会阻断发布。</p></div></header><div className="td2-audit-category-list">{audit.blockers.map((item, index) => <article key={`${item.code}-${item.subjectId ?? index}`}><code>{item.code}</code><p>{item.message}</p>{item.subjectId && <small>{item.subjectId}</small>}</article>)}</div></section>}
      {audit.advisories.length > 0 && <section className="td2-audit-categories"><header><div><h3>人工复核建议</h3><p>无法安全映射的历史追溯、扩展测试和可疑重复不会虚增 Coverage，也不会阻断历史资产继承。</p></div></header><div className="td2-audit-category-list">{audit.advisories.map((item, index) => <article key={`${item.code}-${item.subjectId ?? index}`}><code>{item.code}</code><p>{item.message}</p>{item.subjectId && <small>{item.subjectId}</small>}</article>)}</div></section>}
      <div className="td2-repair-state"><Bot /><div><b>PlanningAgent Repair</b><small>仅处理 resolution=agent_repair，并由服务端校验 v3 Patch 与完整 Candidate。</small></div><span>{run.automaticRepair ? `${run.automaticRepair.status} · ${run.automaticRepair.attempt}/${run.automaticRepair.maxAttempts}` : '未触发'}</span></div>
      <details className="td2-audit-provenance"><summary>查看审计依据与 Hash</summary><div><span>Requirement Release <code>{audit.requirementReleaseId}</code></span><span>Input Hash <code>{audit.inputSha256}</code></span></div></details>
    </>}
  </section>
}
