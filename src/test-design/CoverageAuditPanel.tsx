import { AlertTriangle, Bot, CheckCircle2, RefreshCw, Server, UserRoundCheck, Wrench } from 'lucide-react'
import type { TestDesignCoverageAudit, TestDesignWorkflowRun } from './types'

type BlockerResolution = TestDesignCoverageAudit['blockers'][number]['resolution']

export function CoverageAuditPanel({ run, busy, onAudit, onResolve, onOpenHandoff }: { run: TestDesignWorkflowRun; busy: boolean; onAudit: () => void; onResolve: (kind: 'finding' | 'confirmation', id: string, expectedVersion: number) => void; onOpenHandoff: () => void }) {
  const audit = run.coverageAudits.at(-1)
  const publicationBlockers = audit?.blockers.filter(item => item.resolution !== 'execution_handoff') ?? []
  const handoffBlockers = audit?.blockers.filter(item => item.resolution === 'execution_handoff') ?? []
  const activeCaseIds = new Set(run.testCases.filter(item => !item.tombstonedAt).map(item => item.id))
  const unresolvedFindings = run.findings.filter(item => item.state === 'open')
  const unresolvedBusinessConfirmations = run.confirmationItems.filter(item => item.state === 'open' && item.impactStage !== 'handoff')
  const unresolvedHandoffConfirmations = run.confirmationItems.filter(item => item.state === 'open' && item.impactStage === 'handoff')
  const isStale = audit?.status === 'stale'
  const pass = Boolean(audit?.status === 'valid' && publicationBlockers.length === 0)

  return <section className="td2-card td2-audit">
    <header className="td2-section-head">
      <div>
        <p className="td2-kicker">Server Coverage Audit</p>
        <h2>确定性覆盖检查</h2>
        <p>AI 负责怎么测试；服务端负责引用、覆盖、重复、维度、执行与数据就绪规则。</p>
      </div>
      <button className={`td2-button ${isStale ? 'primary' : 'ghost'}`} disabled={busy || !run.testCases.length} onClick={onAudit}><RefreshCw />{isStale ? '重新检查当前内容' : '重新检查'}</button>
    </header>

    {!audit ? <div className="td2-empty-compact"><Server /><span>等待测试用例生成后执行服务端审计</span></div> : <>
      <AuditState audit={audit} pass={pass} publicationBlockerCount={publicationBlockers.length} />
      {isStale && <div className="td2-audit-recheck-hint"><RefreshCw /><div><b>当前内容已发生变动</b><small>用例增删改、审核、数据需求或业务确认变化后，服务端会将旧 Audit 标记为失效。下方仅保留上次检查快照，不能用于发布。</small></div></div>}
      <AuditSnapshot audit={audit} publicationBlockerCount={publicationBlockers.length} handoffBlockerCount={handoffBlockers.length} stale={isStale} />
      {audit.blockers.length > 0 && <BlockerCategories audit={audit} stale={isStale} />}
      <div className="td2-repair-state"><Bot /><div><b>Agent Repair</b><small>仅处理 resolution=agent_repair；最多 {run.automaticRepair?.maxAttempts ?? 2} 轮</small></div><span>{run.automaticRepair?.status ?? 'idle'} · {run.automaticRepair?.attempt ?? 0}/{run.automaticRepair?.maxAttempts ?? 2}</span></div>
    </>}

    {(unresolvedFindings.length > 0 || unresolvedBusinessConfirmations.length > 0) && <div className="td2-decisions"><h3>等待业务人工决策</h3><p>业务规则、阈值、兼容矩阵与权限不明确时，PlanningAgent 不得猜测。</p>{unresolvedFindings.map(item => <article key={item.id}><AlertTriangle /><div><b>{item.title}</b><p>{item.description}</p><small>Finding · {item.severity}</small></div><button className="td2-button ghost" disabled={busy} onClick={() => onResolve('finding', item.id, item.actions.length)}>标记已处理</button></article>)}{unresolvedBusinessConfirmations.map(item => <article key={item.id}><UserRoundCheck /><div><b>{item.title}</b><p>{item.question}</p><small>Confirmation · {item.impactStage}</small></div><button className="td2-button ghost" disabled={busy} onClick={() => onResolve('confirmation', item.id, item.actions.length)}>记录决策</button></article>)}</div>}
    {unresolvedHandoffConfirmations.length > 0 && <div className="td2-decisions"><h3>Execution Handoff 补充入口</h3><p>Service 按执行问题聚合。前往 Handoff 后会默认选择全部冻结用例，并显示每条 needs_confirmation 用例的人工覆盖原因输入框。</p>{unresolvedHandoffConfirmations.map(item => { const caseCount = item.affectedRefs?.filter(ref => activeCaseIds.has(ref)).length ?? 0; return <article key={item.id}><Wrench /><div><b>{item.title}</b><p>{item.question}</p><small>影响 {caseCount} 条候选用例 · {item.decisionType ?? 'execution_contract'} · Handoff</small></div><button className="td2-button primary" disabled={busy} onClick={onOpenHandoff}><Wrench />前往 Handoff 补充</button></article> })}</div>}
  </section>
}

function AuditState({ audit, pass, publicationBlockerCount }: { audit: TestDesignCoverageAudit; pass: boolean; publicationBlockerCount: number }) {
  const stale = audit.status === 'stale'
  const title = stale ? '当前 Coverage 状态待重新检查' : pass ? '当前语义发布 Audit 已通过' : `当前存在 ${publicationBlockerCount} 项发布门禁`
  const detail = stale
    ? '当前候选已不再与该审计快照一致；请重新检查后再判断覆盖或发布状态。'
    : pass
      ? '需求映射、审核与语义门禁均基于当前冻结输入通过。'
      : '请优先处理发布门禁；执行交接问题会单独统计，不混入发布阻断。'
  return <div className={`td2-audit-state ${stale ? 'stale' : pass ? 'pass' : 'blocked'}`}>{pass ? <CheckCircle2 /> : <AlertTriangle />}<div><b>{title}</b><small>{detail}</small></div><span>{stale ? '待重新检查' : pass ? '可进入发布' : '发布未就绪'}</span></div>
}

function AuditSnapshot({ audit, publicationBlockerCount, handoffBlockerCount, stale }: { audit: TestDesignCoverageAudit; publicationBlockerCount: number; handoffBlockerCount: number; stale: boolean }) {
  return <section className={`td2-audit-snapshot ${stale ? 'historical' : ''}`}>
    <header><div><b>{stale ? '上次审计快照' : '当前审计摘要'}</b><small>{new Date(audit.createdAt).toLocaleString('zh-CN')} · {stale ? '仅供追溯，不代表当前状态' : '与当前候选内容一致'}</small></div><span>{stale ? '历史快照' : '当前有效'}</span></header>
    <div className="td2-audit-metrics">
      <Metric label="Requirement 映射" value={`${audit.statistics.coveredBasis}/${audit.statistics.totalBasis}`} detail="已直接关联测试用例" />
      <Metric label="用例审核" value={`${audit.statistics.approvedCases}/${audit.statistics.totalCases}`} detail="当前 Revision 已批准" />
      <Metric label="发布门禁" value={`${publicationBlockerCount}`} detail="不含 Execution Handoff" tone={publicationBlockerCount ? 'warning' : 'success'} />
      <Metric label="执行交接" value={`${handoffBlockerCount}`} detail="仅在 Handoff / 执行前处理" tone={handoffBlockerCount ? 'warning' : 'success'} />
    </div>
    <details className="td2-audit-provenance"><summary>查看审计依据与 Hash</summary><div><span>Requirement Release <code>{audit.requirementReleaseId}</code></span><span>DataSet Version <code>{audit.dataSetVersionId}</code></span><span>Input Hash <code>{audit.inputSha256}</code></span></div></details>
  </section>
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: 'warning' | 'success' }) {
  return <article className={tone ?? ''}><small>{label}</small><b>{value}</b><span>{detail}</span></article>
}

function BlockerCategories({ audit, stale }: { audit: TestDesignCoverageAudit; stale: boolean }) {
  const categories: Array<{ resolution: BlockerResolution; icon: typeof Bot; label: string; detail: string }> = [
    { resolution: 'agent_repair', icon: Bot, label: 'PlanningAgent 可修复', detail: 'resolution=agent_repair 的事项会进入受限自动修复流程。' },
    { resolution: 'human_review', icon: UserRoundCheck, label: '需要用例审核', detail: '请在“测试用例”确认当前 Revision 后重新检查。' },
    { resolution: 'human_decision', icon: UserRoundCheck, label: '需要业务决策', detail: '预期结果或业务规则缺少正式结论，不能由 Agent 推测。' },
    { resolution: 'manual_edit', icon: Wrench, label: '需要人工编辑', detail: '请修正候选用例或追溯信息后重新检查。' },
    { resolution: 'execution_handoff', icon: Wrench, label: 'Execution Handoff 待补充', detail: '不阻止语义正确的用例库发布，但会阻止实际交接和执行。' },
  ]
  return <section className={`td2-audit-categories ${stale ? 'historical' : ''}`}><header><div><h3>{stale ? '上次审计识别的事项' : '当前待处理事项'}</h3><p>{stale ? '重新检查后，这些分类和数量可能变化。' : '按责任边界处理，避免将审核、业务决策和执行交接混为 Coverage 失败。'}</p></div></header><div className="td2-audit-category-grid">{categories.map(category => {
    const items = audit.blockers.filter(item => item.resolution === category.resolution)
    if (!items.length) return null
    return <BlockerCategory key={category.resolution} {...category} items={items} />
  })}</div></section>
}

function BlockerCategory({ resolution, icon: Icon, label, detail, items }: { resolution: BlockerResolution; icon: typeof Bot; label: string; detail: string; items: TestDesignCoverageAudit['blockers'] }) {
  const preview = items.slice(0, 2)
  const remaining = items.slice(preview.length)
  return <section className={`td2-audit-category ${resolution}`}><header><Icon /><div><b>{label}</b><small>{items.length} 项</small></div></header><p>{detail}</p><div className="td2-audit-category-list">{preview.map((item, index) => <BlockerItem key={`${item.code}-${item.subjectId ?? index}`} item={item} />)}</div>{remaining.length > 0 && <details><summary>查看其余 {remaining.length} 项</summary><div className="td2-audit-category-list">{remaining.map((item, index) => <BlockerItem key={`${item.code}-${item.subjectId ?? index + preview.length}`} item={item} />)}</div></details>}</section>
}

function BlockerItem({ item }: { item: TestDesignCoverageAudit['blockers'][number] }) {
  return <article><code>{item.code}</code><p>{item.message}</p>{item.subjectId && <small>{item.subjectId}</small>}</article>
}
