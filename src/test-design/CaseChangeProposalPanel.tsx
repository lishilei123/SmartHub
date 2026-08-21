import { Check, CopyCheck, FileDiff, RotateCcw, ShieldX, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { CaseChangeDecision, CaseChangeOperation, CaseChangeProposal, TestDesignWorkflowRun } from './types'

const operations: Array<{ key: CaseChangeOperation; label: string; automatic: boolean }> = [
  { key: 'reuse', label: '复用', automatic: true },
  { key: 'create', label: '新增', automatic: true },
  { key: 'update', label: '修改', automatic: true },
  { key: 'deprecate', label: '废弃', automatic: false },
  { key: 'reference', label: '仅参考', automatic: false },
]

export function CaseChangeProposalPanel({ run, busy, onDecision }: { run: TestDesignWorkflowRun; busy: boolean; onDecision: (proposalId: string, decision: Exclude<CaseChangeDecision, 'pending'>, comment?: string) => Promise<void> }) {
  const manual = useMemo(() => run.caseChangeProposals.filter(requiresHumanDecision), [run.caseChangeProposals])
  const pending = manual.filter(item => item.decision === 'pending')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = manual.find(item => item.id === selectedId) ?? pending[0] ?? manual[0]
  return <section className="tdw-panel tdw-proposals"><header><div><span className="tdw-icon"><FileDiff /></span><div><h2>本次用例库变更</h2><p>复用由 Service 自动处理；新增和修改随当前用例 Revision 审核通过自动接受。这里只处置废弃与必要的仅参考决定。</p></div></div><span className={`tdw-badge ${pending.length ? 'warning' : 'success'}`}>{pending.length ? `需要人工确认 ${pending.length}` : '无需额外确认'}</span></header>
    <div className="tdw-proposal-kpis">{operations.map(item => <span key={item.key}><small>{item.label}{item.automatic ? ' · 自动' : ' · 特殊变更'}</small><b>{run.caseChangeProposals.filter(proposal => proposal.operation === item.key).length}</b></span>)}</div>
    {!manual.length ? <div className="tdw-empty"><CopyCheck /><b>没有需要人工决策的用例库变更</b><span>所有 Proposal 已由 Service 根据冻结 Snapshot 与用例审核结果自动处理。</span></div> : <div className="tdw-master-detail"><div className="tdw-master-list">{manual.map(item => <button key={item.id} className={selected?.id === item.id ? 'active' : ''} onClick={() => setSelectedId(item.id)}><span className={`tdw-operation ${item.operation}`}>{operationLabel(item.operation)}</span><b>{item.candidateContent?.title ?? item.sourceCaseId ?? item.id}</b><small>{item.reason}</small><footer><code>{item.sourceCaseId ? `${item.sourceCaseId} · r${item.sourceRevision}` : '无历史来源'}</code><em className={item.decision}>{decisionLabel(item.decision)}</em></footer></button>)}</div>{selected && <ProposalDetail proposal={selected} busy={busy} onDecision={(decision, comment) => onDecision(selected.id, decision, comment)} />}</div>}
  </section>
}

function ProposalDetail({ proposal, busy, onDecision }: { proposal: CaseChangeProposal; busy: boolean; onDecision: (decision: Exclude<CaseChangeDecision, 'pending'>, comment?: string) => Promise<void> }) {
  return <article className="tdw-proposal-detail"><header><div><span className={`tdw-operation ${proposal.operation}`}>{operationLabel(proposal.operation)}</span><h3>{proposal.candidateContent?.title ?? proposal.sourceCaseId ?? '特殊历史变更'}</h3></div><strong>{Math.round(proposal.confidence * 100)}% 置信度</strong></header>
    <div className="tdw-proposal-kpis"><span><small>历史 Revision</small><b>{proposal.sourceCaseId ? `${proposal.sourceCaseId} / r${proposal.sourceRevision}` : '无'}</b></span><span><small>关联需求</small><b>{proposal.requirementRefs.length || '未标注'}</b></span></div>
    <section><h4>Agent 判断理由</h4><p>{proposal.reason}</p></section>
    <section><h4>字段级 Diff</h4>{proposal.diff.length ? <div className="tdw-diff-list">{proposal.diff.map((change, index) => <article key={`${change.path}-${index}`}><code>{change.path}</code><div><pre>{format(change.before)}</pre><span>→</span><pre>{format(change.after)}</pre></div></article>)}</div> : <p className="tdw-muted">该变更不包含候选内容修改。</p>}</section>
    <section><h4>正式用例库影响</h4><p>{proposal.operation === 'deprecate' ? '确认后会废弃正式历史 Case，并从新版本成员中移除。' : '确认后仅作为设计参考，不进入本次正式用例库版本；历史 Case 资产本身不会被废弃。'}</p></section>
    <footer className="tdw-actions">{proposal.decision === 'pending' ? proposal.operation === 'deprecate' ? <><button disabled={busy} onClick={() => void onDecision('keep_original', '保留当前正式历史用例').catch(() => undefined)}><RotateCcw />保留原用例</button><button disabled={busy} className="danger" onClick={() => void onDecision('deprecated', '确认废弃正式历史用例').catch(() => undefined)}><ShieldX />确认废弃</button></> : <><button disabled={busy} className="primary" onClick={() => void onDecision('reference', '确认仅作为设计参考').catch(() => undefined)}><CopyCheck />确认仅参考</button><button disabled={busy} onClick={() => void onDecision('rejected', '拒绝仅参考建议，保留原用例').catch(() => undefined)}><X />保留原用例</button></> : <span className={`tdw-decision ${proposal.decision}`}><Check />已处置：{decisionLabel(proposal.decision)}</span>}</footer>
  </article>
}

export function requiresHumanDecision(proposal: CaseChangeProposal) { return proposal.operation === 'deprecate' || proposal.operation === 'reference' }
function operationLabel(value: CaseChangeOperation) { return ({ reuse: '复用', update: '修改', create: '新增', deprecate: '废弃', reference: '仅参考' } as const)[value] }
function decisionLabel(value: CaseChangeDecision) { return ({ pending: '待确认', accepted: '系统已接受', rejected: '已拒绝', keep_original: '保留原用例', reference: '仅参考', deprecated: '已废弃' } as const)[value] }
function format(value: unknown) { return value === undefined ? '∅' : typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
