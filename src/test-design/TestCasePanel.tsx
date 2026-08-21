import { useEffect, useMemo, useState } from 'react'
import { Pencil, Plus, Trash2, X } from 'lucide-react'
import { actualExecutionMethod, createEmptyTestCase, dimensionLabel, TestCaseEditor, testCaseEditorValid } from './TestCaseEditor'
import type { TestCaseContent, TestDesignCase, TestDesignWorkflowRun } from './types'

type Props = {
  run?: TestDesignWorkflowRun | null
  busy: boolean
  createRequest?: number
  onBatchApprove: () => Promise<void>
  onResynthesize: () => Promise<void>
  onCreate: (content: TestCaseContent) => Promise<void>
  onEdit: (caseId: string, content: TestCaseContent, reason: string) => Promise<void>
  onDelete: (caseId: string) => Promise<void>
  onReview: (caseId: string, decision: 'submit' | 'approve' | 'reject' | 'request_revision' | 'withdraw', revision: number, comment?: string) => Promise<void>
}

export function TestCasePanel(props: Props) {
  const cases = useMemo(() => props.run?.testCases.filter(item => !item.tombstonedAt) ?? [], [props.run])
  const [selectedId, setSelectedId] = useState<string>()
  const [editing, setEditing] = useState<TestDesignCase | 'new'>()
  useEffect(() => { if (props.createRequest) setEditing('new') }, [props.createRequest])
  useEffect(() => { if (!selectedId || !cases.some(item => item.id === selectedId)) setSelectedId(cases[0]?.id) }, [cases, selectedId])
  const selected = cases.find(item => item.id === selectedId)
  return <section className="td2-case-workbench">
    <header className="td2-workbench-header"><div><h2>Candidate Delta 审核</h2><small>这里只审核本轮 create/update 或人工修改；未变化 Historical Case 由 Service 直接复用，不需要重新审核。</small></div><div><button onClick={() => setEditing('new')}><Plus />新增</button><button disabled={props.busy || !cases.length} onClick={() => void props.onBatchApprove()}>批量审核</button><button disabled={props.busy} onClick={() => void props.onResynthesize()}>重新生成 Delta</button></div></header>
    <div className="td2-case-layout">
      <nav className="td2-case-list">{cases.map(item => { const content = currentContent(item); return <button key={item.id} className={selectedId === item.id ? 'active' : ''} onClick={() => setSelectedId(item.id)}><b>{content.title}</b><small>{dimensionLabel(content.dimension)} · {content.priority} · {actualExecutionMethod(content)}</small><span>{content.requirementRefs.length ? `${content.requirementRefs.length} 个关联需求` : '扩展测试'}</span></button> })}{!cases.length && <p className="tdw-muted">本轮没有新增或需要调整的 Candidate；冻结历史用例将全部保留。</p>}</nav>
      <div className="td2-case-detail">{selected ? <CaseDetail testCase={selected} busy={props.busy} onEdit={() => setEditing(selected)} onDelete={() => void props.onDelete(selected.id)} onReview={props.onReview} /> : <p className="tdw-muted">选择一条用例查看审核内容。</p>}</div>
    </div>
    {editing && <CaseEditorDialog testCase={editing === 'new' ? undefined : editing} busy={props.busy} onClose={() => setEditing(undefined)} onSave={async (content, reason) => { if (editing === 'new') await props.onCreate(content); else await props.onEdit(editing.id, content, reason); setEditing(undefined) }} />}
  </section>
}

function CaseDetail({ testCase, busy, onEdit, onDelete, onReview }: { testCase: TestDesignCase; busy: boolean; onEdit: () => void; onDelete: () => void; onReview: Props['onReview'] }) {
  const content = currentContent(testCase)
  const [comment, setComment] = useState('')
  return <article className="td2-case-card"><header><div><span className={`tdw-status ${testCase.reviewState}`}>{testCase.reviewState}</span><h3>{content.title}</h3><code>{testCase.id} · r{testCase.currentRevision}</code></div><div><button disabled={busy || testCase.reviewState === 'in_review'} onClick={onEdit}><Pencil />编辑</button><button disabled={busy} className="danger" onClick={onDelete}><Trash2 />删除</button></div></header>
    <div className="tdw-proposal-kpis"><span><small>测试类型</small><b>{dimensionLabel(content.dimension)}</b></span><span><small>优先级</small><b>{content.priority}</b></span><span><small>执行方式</small><b>{actualExecutionMethod(content)}</b></span><span><small>关联需求</small><b>{content.requirementRefs.length ? content.requirementRefs.join(', ') : '扩展测试'}</b></span></div>
    <TextSection title="前置条件" values={content.preconditions} empty="无" />
    <TextSection title="执行步骤" values={content.steps} ordered />
    <TextSection title="预期结果" values={content.expectedResults} ordered />
    <section><h4>人工审核</h4><textarea placeholder="退回或拒绝时填写意见" value={comment} onChange={event => setComment(event.target.value)} /><div className="td2-review-actions">{testCase.reviewState === 'draft' || testCase.reviewState === 'needs_revision' ? <button disabled={busy} onClick={() => void onReview(testCase.id, 'submit', testCase.currentRevision)}>提交审核</button> : null}{testCase.reviewState === 'in_review' && <><button disabled={busy} onClick={() => void onReview(testCase.id, 'approve', testCase.currentRevision)}>批准</button><button disabled={busy || !comment.trim()} onClick={() => void onReview(testCase.id, 'request_revision', testCase.currentRevision, comment)}>退回修改</button><button disabled={busy || !comment.trim()} onClick={() => void onReview(testCase.id, 'reject', testCase.currentRevision, comment)}>拒绝</button></>}</div></section>
  </article>
}

function TextSection({ title, values, empty, ordered }: { title: string; values: string[]; empty?: string; ordered?: boolean }) { const Tag = ordered ? 'ol' : 'ul'; return <section><h4>{title}</h4>{values.length ? <Tag>{values.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</Tag> : <p className="tdw-muted">{empty ?? '无'}</p>}</section> }
function currentContent(testCase: TestDesignCase) { return testCase.revisions.find(item => item.revision === testCase.currentRevision)?.content ?? testCase.revisions.at(-1)!.content }
function CaseEditorDialog({ testCase, busy, onClose, onSave }: { testCase?: TestDesignCase; busy: boolean; onClose: () => void; onSave: (content: TestCaseContent, reason: string) => Promise<void> }) { const [content, setContent] = useState(() => testCase ? structuredClone(currentContent(testCase)) : createEmptyTestCase()); const [reason, setReason] = useState(testCase ? '调整测试语义' : '人工新增测试用例'); return <div className="tdw-backdrop"><section className="tdw-modal wide"><header><b>{testCase ? '编辑 TestCase v3' : '新增 TestCase v3'}</b><button onClick={onClose}><X /></button></header><TestCaseEditor value={content} onChange={setContent} /><label>变更原因<input value={reason} onChange={event => setReason(event.target.value)} /></label><footer><button onClick={onClose}>取消</button><button className="primary" disabled={busy || !reason.trim() || !testCaseEditorValid(content)} onClick={() => void onSave(content, reason.trim())}>保存</button></footer></section></div> }
