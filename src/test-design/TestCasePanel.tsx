import { AlertTriangle, Check, ChevronDown, History, Pencil, Plus, RefreshCw, Send, TestTube2, Trash2, X, XCircle } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { actualExecutionMethod, createEmptyTestCase, executionPendingItems, TestCaseEditor, testCaseEditorValid } from './TestCaseEditor'
import type { TestCaseContent, TestDesignCase, TestDesignWorkflowRun, TestPointNode } from './types'

type ReviewDecision = 'submit' | 'approve' | 'reject' | 'request_revision' | 'withdraw'

type Props = {
  run: TestDesignWorkflowRun
  points: TestPointNode[]
  busy: boolean
  onSubmit: () => void
  onApprove: () => void
  onResynthesize: () => void
  onCreate: (content: TestCaseContent) => void
  onEdit: (caseId: string, content: TestCaseContent, reason: string) => void
  onDelete: (caseId: string) => void
  onReview: (caseId: string, decision: ReviewDecision, targetRevision: number, comment?: string) => void
}

export function TestCasePanel({ run, points, busy, onSubmit, onApprove, onResynthesize, onCreate, onEdit, onDelete, onReview }: Props) {
  const cases = run.testCases.filter(item => !item.tombstonedAt)
  const [expanded, setExpanded] = useState<string | null>(cases[0]?.id ?? null)
  const [editor, setEditor] = useState<{ mode: 'create' } | { mode: 'edit'; testCase: TestDesignCase } | null>(null)
  const [review, setReview] = useState<{ testCase: TestDesignCase; decision: 'reject' | 'request_revision' } | null>(null)
  const [deleting, setDeleting] = useState<TestDesignCase | null>(null)
  const counts = cases.reduce<Record<string, number>>((result, item) => ({ ...result, [item.reviewState]: (result[item.reviewState] ?? 0) + 1 }), {})
  const executablePoints = executableTestPoints(points)
  const decide = (testCase: TestDesignCase, decision: ReviewDecision) => {
    if (decision === 'reject' || decision === 'request_revision') return setReview({ testCase, decision })
    onReview(testCase.id, decision, testCase.currentRevision)
  }
  return <section className="td2-card td2-cases">
    <header className="td2-section-head"><div><p className="td2-kicker">Test Case Design</p><h2>测试用例候选</h2><p>支持人工新增、关联可执行测试点、结构化编辑执行步骤、单条审核与 Revision 追踪；批量操作只处理当前符合状态迁移条件的用例。</p></div><div className="td2-run-actions"><button className="td2-button ghost" disabled={busy || !executablePoints.length} onClick={() => setEditor({ mode: 'create' })}><Plus />新增用例</button><button className="td2-button ghost" disabled={busy || !run.testPointTree?.currentApprovedVersionId} onClick={onResynthesize}><RefreshCw />重新生成</button><button className="td2-button ghost" disabled={busy || !counts.draft} onClick={onSubmit}><Send />批量提交审核</button><button className="td2-button primary" disabled={busy || !counts.in_review} onClick={onApprove}><Check />批量批准</button></div></header>
    <div className="td2-case-stats"><span>共 <b>{cases.length}</b></span><span>草稿 <b>{counts.draft ?? 0}</b></span><span>审核中 <b>{counts.in_review ?? 0}</b></span><span>待修改 <b>{counts.needs_revision ?? 0}</b></span><span>已批准 <b>{counts.approved ?? 0}</b></span><span>数据需求 <b>{run.dataSetVersions.at(-1)?.requirements.length ?? 0}</b></span></div>
    {cases.length ? <div className="td2-case-list">{cases.map(testCase => <CaseRow key={testCase.id} testCase={testCase} requirementRefs={run.caseChangeProposals.find(item => item.candidateCaseId === testCase.id)?.requirementRefs ?? []} busy={busy} expanded={expanded === testCase.id} onToggle={() => setExpanded(expanded === testCase.id ? null : testCase.id)} onEdit={() => setEditor({ mode: 'edit', testCase })} onDelete={() => setDeleting(testCase)} onReview={decision => decide(testCase, decision)} />)}</div> : <div className="td2-empty-compact"><TestTube2 /><span>{run.stage === 'test_case_design' ? 'PlanningAgent 正在生成用例…' : '测试点自动校验后生成或人工新增用例'}</span></div>}
    {editor && <CaseEditorDialog key={editor.mode === 'edit' ? `${editor.testCase.id}:${editor.testCase.currentRevision}` : 'new-case'} testCase={editor.mode === 'edit' ? editor.testCase : undefined} points={executablePoints} busy={busy} onClose={() => setEditor(null)} onSave={(content, reason) => { if (editor.mode === 'edit') onEdit(editor.testCase.id, content, reason); else onCreate(content); setEditor(null) }} />}
    {review && <ReviewDialog testCase={review.testCase} decision={review.decision} busy={busy} onClose={() => setReview(null)} onSubmit={comment => { onReview(review.testCase.id, review.decision, review.testCase.currentRevision, comment); setReview(null) }} />}
    {deleting && <CaseDialog title="删除测试用例" onClose={() => setDeleting(null)}><div className="td2-dialog-form"><div className="td2-danger-note"><AlertTriangle /><span><b>删除“{currentContent(deleting).title}”？</b><small>用例将被标记删除，依赖关系和 Coverage Audit 会重新校验；已发布的不可变 TestCaseSetVersion 不受影响。</small></span></div><DialogActions busy={busy} valid onClose={() => setDeleting(null)} submitLabel="确认删除" danger onSubmit={() => { onDelete(deleting.id); setDeleting(null) }} /></div></CaseDialog>}
  </section>
}

function CaseRow({ testCase, requirementRefs, busy, expanded, onToggle, onEdit, onDelete, onReview }: { testCase: TestDesignCase; requirementRefs: string[]; busy: boolean; expanded: boolean; onToggle: () => void; onEdit: () => void; onDelete: () => void; onReview: (decision: ReviewDecision) => void }) {
  const revision = testCase.revisions.find(item => item.revision === testCase.currentRevision)!
  const content = revision.content
  const readiness = content.executionSpec?.executionReadiness ?? content.executionMethods[0]?.executionReadiness ?? 'needs_confirmation'
  const pending = executionPendingItems(content)
  return <article className={expanded ? 'expanded' : ''}><button className="td2-case-summary" onClick={onToggle}><span className={`td2-review-state ${testCase.reviewState}`}>{reviewStateLabel(testCase.reviewState)}</span><div><b>{content.title}</b><small>{content.dimension} · {actualExecutionMethod(content)} · {readiness} · {content.priority} · Revision {testCase.currentRevision}</small></div><div className="td2-methods"><span>{actualExecutionMethod(content)}</span>{pending.length > 0 && <span className="needs_confirmation">待确认 {pending.length}</span>}</div><ChevronDown /></button>
    {expanded && <div className="td2-case-detail"><div><h4>目标</h4><p>{content.objective}</p></div><div><h4>前置条件</h4>{content.preconditions.length ? <ul>{content.preconditions.map(item => <li key={item}>{item}</li>)}</ul> : <p>无</p>}</div><section><header><b>{content.dimension} · {actualExecutionMethod(content)}</b><span className={readiness}>{readiness}</span></header><pre className="tdw-json">{JSON.stringify(content.executionSpec, null, 2)}</pre></section><section><h4>待确认项</h4>{pending.length ? <ul>{pending.map(item => <li key={item}>{item}</li>)}</ul> : <p>无</p>}</section><section><h4>需求追溯 / 测试点追溯 / 测试数据需求</h4><div className="tdw-chips">{requirementRefs.map(id => <code key={`requirement-${id}`}>{id}</code>)}{content.testPointIds.map(id => <code key={`point-${id}`}>{id}</code>)}{content.dataRequirementIds.map(id => <code key={`data-${id}`}>{id}</code>)}</div></section>
      <section className="td2-case-governance"><header><b>Revision 与审核记录</b><History /></header><div className="td2-revision-list">{[...testCase.revisions].reverse().map(item => <span key={item.revision}><b>Revision {item.revision}</b><small>{new Date(item.createdAt).toLocaleString('zh-CN')}</small><code title={item.contentSha256}>{item.contentSha256}</code></span>)}</div>{testCase.reviewActions.length > 0 && <div className="td2-review-history">{[...testCase.reviewActions].reverse().map(action => <span key={action.id}>{reviewDecisionLabel(action.decision)} · Revision {action.targetRevision ?? testCase.currentRevision}{action.comment ? ` · ${action.comment}` : ''}</span>)}</div>}</section>
      <div className="td2-case-actions"><button className="td2-button ghost" disabled={busy || testCase.reviewState === 'in_review'} onClick={onEdit}><Pencil />编辑并新建 Revision</button>{(testCase.reviewState === 'draft' || testCase.reviewState === 'rejected' || testCase.reviewState === 'needs_revision') && <button className="td2-button ghost" disabled={busy} onClick={() => onReview('submit')}><Send />提交审核</button>}{testCase.reviewState === 'in_review' && <><button className="td2-button primary" disabled={busy} onClick={() => onReview('approve')}><Check />批准</button><button className="td2-button ghost" disabled={busy} onClick={() => onReview('request_revision')}><RefreshCw />要求修改</button><button className="td2-button ghost" disabled={busy} onClick={() => onReview('reject')}><XCircle />拒绝</button><button className="td2-button ghost" disabled={busy} onClick={() => onReview('withdraw')}>撤回审核</button></>}{testCase.reviewState === 'approved' && <button className="td2-button ghost" disabled={busy} onClick={() => onReview('request_revision')}><RefreshCw />重新打开修改</button>}<button className="td2-button danger" disabled={busy || testCase.reviewState === 'in_review'} onClick={onDelete}><Trash2 />删除</button></div>
      <footer><code title={testCase.id}>{testCase.id}</code><code title={revision.contentSha256}>{revision.contentSha256}</code></footer></div>}
  </article>
}

function CaseEditorDialog({ testCase, points, busy, onClose, onSave }: { testCase?: TestDesignCase; points: TestPointNode[]; busy: boolean; onClose: () => void; onSave: (content: TestCaseContent, reason: string) => void }) {
  const [content, setContent] = useState<TestCaseContent>(() => testCase ? currentContent(testCase) : createEmptyTestCase(points[0]?.nodeId ?? ''))
  const [reason, setReason] = useState(testCase ? '人工编辑测试用例' : '人工新建测试用例')
  const valid = testCaseEditorValid(content) && (!testCase || reason.trim().length >= 2)
  return <CaseDialog title={testCase ? `编辑用例 · Revision ${testCase.currentRevision}` : '新增测试用例'} wide onClose={onClose}><form className="td2-dialog-form" onSubmit={event => { event.preventDefault(); if (valid) onSave(content, reason.trim()) }}><TestCaseEditor value={content} onChange={setContent} testPoints={points} />{testCase && <label>Revision 修改说明<input value={reason} onChange={event => setReason(event.target.value)} /></label>}<DialogActions busy={busy} valid={valid} onClose={onClose} submitLabel={testCase ? '保存新 Revision' : '创建草稿用例'} /></form></CaseDialog>
}

function ReviewDialog({ testCase, decision, busy, onClose, onSubmit }: { testCase: TestDesignCase; decision: 'reject' | 'request_revision'; busy: boolean; onClose: () => void; onSubmit: (comment: string) => void }) {
  const [comment, setComment] = useState('')
  return <CaseDialog title={decision === 'reject' ? '拒绝测试用例' : '要求修改测试用例'} onClose={onClose}><form className="td2-dialog-form" onSubmit={event => { event.preventDefault(); if (comment.trim()) onSubmit(comment.trim()) }}><p>审核目标为 Revision {testCase.currentRevision}。审核意见会写入不可变的 Review Action 记录。</p><label>审核意见<textarea autoFocus value={comment} onChange={event => setComment(event.target.value)} /></label><DialogActions busy={busy} valid={Boolean(comment.trim())} onClose={onClose} submitLabel={decision === 'reject' ? '确认拒绝' : '提交修改意见'} danger={decision === 'reject'} /></form></CaseDialog>
}

function CaseDialog({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: ReactNode }) { return <div className="td2-dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section className={`td2-dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><header><h3>{title}</h3><button aria-label="关闭" onClick={onClose}><X /></button></header>{children}</section></div> }
function DialogActions({ busy, valid, onClose, submitLabel, danger, onSubmit }: { busy: boolean; valid: boolean; onClose: () => void; submitLabel: string; danger?: boolean; onSubmit?: () => void }) { return <footer className="td2-dialog-actions"><button type="button" className="td2-button ghost" disabled={busy} onClick={onClose}>取消</button><button type={onSubmit ? 'button' : 'submit'} className={`td2-button ${danger ? 'danger' : 'primary'}`} disabled={busy || !valid} onClick={onSubmit}>{submitLabel}</button></footer> }
function currentContent(testCase: TestDesignCase) { return testCase.revisions.find(item => item.revision === testCase.currentRevision)!.content }
function executableTestPoints(nodes: TestPointNode[]) { const active = nodes.filter(node => !node.deleted); const parents = new Set(active.flatMap(node => node.parentId ? [node.parentId] : [])); return active.filter(node => node.applicability !== 'not_applicable' && !parents.has(node.nodeId)) }
function reviewStateLabel(value: TestDesignCase['reviewState']) { return ({ draft: '草稿', in_review: '审核中', approved: '已批准', rejected: '已拒绝', needs_revision: '待修改' } as const)[value] }
function reviewDecisionLabel(value: string) { return ({ submit: '提交审核', approve: '批准', reject: '拒绝', request_revision: '要求修改', withdraw: '撤回审核' } as Record<string, string>)[value] ?? value }
