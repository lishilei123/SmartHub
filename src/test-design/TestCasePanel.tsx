import { CheckCircle2, History, Pencil, Plus, RotateCcw, Search, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { actualExecutionMethod, createEmptyTestCase, dimensionLabel, TestCaseEditor, testCaseEditorValid } from './TestCaseEditor'
import type { ReviewState, TestCaseContent, TestDesignCase, TestDesignWorkflowRun } from './types'

type Props = {
  run?: TestDesignWorkflowRun | null
  busy: boolean
  createRequest?: number
  focusRequest?: { caseId?: string; requestId: number }
  onBatchApprove: () => Promise<void>
  onResynthesize: () => Promise<void>
  onCreate: (content: TestCaseContent) => Promise<void>
  onEdit: (caseId: string, content: TestCaseContent, reason: string) => Promise<void>
  onDelete: (caseId: string) => Promise<void>
  onReview: (caseId: string, decision: 'submit' | 'approve' | 'reject' | 'request_revision' | 'withdraw', revision: number, comment?: string) => Promise<void>
}

type ReviewFilter = 'all' | ReviewState

const filters: Array<{ key: ReviewFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'in_review', label: '待审核' },
  { key: 'draft', label: '草稿' },
  { key: 'needs_revision', label: '待修改' },
  { key: 'approved', label: '已通过' },
  { key: 'rejected', label: '已拒绝' },
]

export function TestCasePanel(props: Props) {
  const workbenchRef = useRef<HTMLElement>(null)
  const cases = useMemo(() => props.run?.testCases.filter(item => !item.tombstonedAt) ?? [], [props.run])
  const [selectedId, setSelectedId] = useState<string>()
  const [editing, setEditing] = useState<TestDesignCase | 'new'>()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ReviewFilter>('all')
  const counts = useMemo(() => cases.reduce<Partial<Record<ReviewState, number>>>((result, item) => {
    result[item.reviewState] = (result[item.reviewState] ?? 0) + 1
    return result
  }, {}), [cases])
  const filteredCases = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase('zh-CN')
    return cases.filter(item => {
      const content = currentContent(item)
      const matchesState = filter === 'all' || item.reviewState === filter
      const matchesQuery = !keyword || [content.title, item.id, ...content.requirementRefs].some(value => value.toLocaleLowerCase('zh-CN').includes(keyword))
      return matchesState && matchesQuery
    })
  }, [cases, filter, query])

  useEffect(() => { if (props.createRequest) setEditing('new') }, [props.createRequest])
  useEffect(() => {
    if (!selectedId || !filteredCases.some(item => item.id === selectedId)) setSelectedId(filteredCases[0]?.id)
  }, [filteredCases, selectedId])
  useEffect(() => {
    if (!props.focusRequest?.requestId) return
    const caseId = props.focusRequest.caseId
    setQuery('')
    setFilter('all')
    if (caseId && cases.some(item => item.id === caseId)) setSelectedId(caseId)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      const mobileDetail = caseId && window.matchMedia('(max-width: 760px)').matches ? document.getElementById('test-case-detail') : undefined
      const scrollTarget = mobileDetail ?? workbenchRef.current
      scrollTarget?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' })
    }))
  }, [cases, props.focusRequest])

  const selected = cases.find(item => item.id === selectedId)
  const pendingReviewCount = counts.in_review ?? 0
  const selectedPosition = filteredCases.findIndex(item => item.id === selectedId)
  const filtersActive = Boolean(query.trim()) || filter !== 'all'

  return <section className="td2-case-workbench" id="test-case-list" ref={workbenchRef}>
    <header className="td2-workbench-header">
      <div><p>本次测试设计</p><h2>Candidate Delta 审核</h2><small>逐条查看本轮新增或修改的用例；未变化的历史用例由 Service 直接复用。</small></div>
      <div className="td2-workbench-actions">
        <button className="td2-button ghost" onClick={() => setEditing('new')}><Plus />新增用例</button>
        <button className="td2-button primary" disabled={props.busy || pendingReviewCount === 0} onClick={() => void props.onBatchApprove()}><CheckCircle2 />{pendingReviewCount ? `批量审核通过（${pendingReviewCount}）` : '暂无待审核'}</button>
        <button className="td2-button ghost" disabled={props.busy} onClick={() => void props.onResynthesize()}>重新生成 Delta</button>
      </div>
    </header>

    <div className="td2-case-controls">
      <label className="td2-case-search"><Search /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索标题、用例 ID 或 Requirement" /></label>
      <nav aria-label="按审核状态筛选">{filters.map(item => {
        const count = item.key === 'all' ? cases.length : counts[item.key] ?? 0
        return <button key={item.key} type="button" aria-pressed={filter === item.key} className={filter === item.key ? 'active' : ''} onClick={() => setFilter(item.key)}>{item.label}<span>{count}</span></button>
      })}</nav>
      <div className="td2-case-result" aria-live="polite">
        <span>显示 <b>{filteredCases.length}</b> / {cases.length} 条{selectedPosition >= 0 ? ` · 当前第 ${selectedPosition + 1} 条` : ''}</span>
        {filtersActive && <button type="button" onClick={() => { setQuery(''); setFilter('all') }}><RotateCcw />清除筛选</button>}
      </div>
    </div>

    <div className="td2-case-layout">
      <nav className="td2-case-list" aria-label="Candidate 测试用例列表">
        {filteredCases.map(item => {
          const content = currentContent(item)
          return <button id={`test-case-${item.id}`} key={item.id} type="button" aria-current={selectedId === item.id ? 'true' : undefined} className={selectedId === item.id ? 'active' : ''} onClick={() => setSelectedId(item.id)}>
            <span className="td2-case-list-labels"><span className={`td2-review-state ${item.reviewState}`}>{reviewStateLabel(item.reviewState)}</span><span className="td2-case-origin">{originLabel(item.origin)}</span></span>
            <b>{content.title}</b>
            <small>{dimensionLabel(content.dimension)} · {content.priority} · {actualExecutionMethod(content)}</small>
            <em>{content.requirementRefs.length ? `${content.requirementRefs.length} 个关联需求` : '扩展测试'} · r{item.currentRevision}</em>
          </button>
        })}
        {!filteredCases.length && <div className="td2-case-list-empty"><Search /><b>没有匹配的用例</b><small>调整搜索词或审核状态后重试。</small></div>}
      </nav>
      <div className="td2-case-detail" id="test-case-detail">{selected ? <CaseDetail testCase={selected} busy={props.busy} onEdit={() => setEditing(selected)} onDelete={() => void props.onDelete(selected.id)} onReview={props.onReview} /> : <div className="td2-case-detail-empty"><b>{cases.length ? '请选择一条用例' : '本轮没有 Candidate Delta'}</b><small>{cases.length ? '左侧列表会保留当前筛选结果。' : '冻结的历史用例仍会进入 Effective Case Set。'}</small></div>}</div>
    </div>
    {editing && <CaseEditorDialog testCase={editing === 'new' ? undefined : editing} busy={props.busy} onClose={() => setEditing(undefined)} onSave={async (content, reason) => { if (editing === 'new') await props.onCreate(content); else await props.onEdit(editing.id, content, reason); setEditing(undefined) }} />}
  </section>
}

function CaseDetail({ testCase, busy, onEdit, onDelete, onReview }: { testCase: TestDesignCase; busy: boolean; onEdit: () => void; onDelete: () => void; onReview: Props['onReview'] }) {
  const content = currentContent(testCase)
  const [comment, setComment] = useState('')
  useEffect(() => setComment(''), [testCase.id, testCase.currentRevision])
  return <article className="td2-case-card">
    <header>
      <div><span className={`td2-review-state ${testCase.reviewState}`}>{reviewStateLabel(testCase.reviewState)}</span><h3>{content.title}</h3><code>{testCase.id} · Revision {testCase.currentRevision}</code></div>
      <div><button className="td2-button ghost" disabled={busy || testCase.reviewState === 'in_review'} onClick={onEdit}><Pencil />编辑</button><button className="td2-button danger" disabled={busy} onClick={onDelete}><Trash2 />删除</button></div>
    </header>
    <div className="tdw-proposal-kpis"><span><small>测试类型</small><b>{dimensionLabel(content.dimension)}</b></span><span><small>优先级</small><b>{content.priority}</b></span><span><small>执行方式</small><b>{actualExecutionMethod(content)}</b></span><span><small>Candidate 来源</small><b>{originLabel(testCase.origin)}</b></span><span><small>关联需求</small><b>{content.requirementRefs.length ? content.requirementRefs.join(', ') : '扩展测试'}</b></span></div>
    <div className="td2-case-content-grid">
      <TextSection title="前置条件" values={content.preconditions} empty="无额外前置条件" />
      <TextSection title="执行步骤" values={content.steps} ordered />
      <TextSection title="预期结果" values={content.expectedResults} ordered />
    </div>
    <section className="td2-case-review">
      <header><div><p>Human Review</p><h4>人工审核</h4></div><span>{reviewHint(testCase.reviewState)}</span></header>
      {testCase.reviewState === 'in_review' && <textarea placeholder="退回修改或拒绝时，需填写具体意见" value={comment} onChange={event => setComment(event.target.value)} />}
      <div className="td2-review-actions">
        {['draft', 'needs_revision'].includes(testCase.reviewState) && <button className="td2-button primary" disabled={busy} onClick={() => void onReview(testCase.id, 'submit', testCase.currentRevision)}>提交审核</button>}
        {testCase.reviewState === 'in_review' && <><button className="td2-button primary" disabled={busy} onClick={() => void onReview(testCase.id, 'approve', testCase.currentRevision)}>审核通过</button><button className="td2-button ghost" disabled={busy || !comment.trim()} onClick={() => void onReview(testCase.id, 'request_revision', testCase.currentRevision, comment.trim())}>退回修改</button><button className="td2-button danger" disabled={busy || !comment.trim()} onClick={() => void onReview(testCase.id, 'reject', testCase.currentRevision, comment.trim())}>拒绝</button></>}
        {testCase.reviewState === 'approved' && <span className="td2-review-complete"><CheckCircle2 />当前 Revision 已通过审核；如需调整，请点击上方“编辑”。</span>}
        {testCase.reviewState === 'rejected' && <span className="td2-review-rejected">当前 Revision 已拒绝；如需继续，请编辑并创建新 Revision。</span>}
      </div>
      {testCase.reviewActions.length > 0 && <details className="td2-review-history"><summary><History />审核记录（{testCase.reviewActions.length}）</summary><div>{[...testCase.reviewActions].reverse().map(action => <article key={action.id}><span><b>{reviewDecisionLabel(action.decision)}</b><small>{action.fromState ? `${reviewStateLabel(action.fromState)} → ${action.toState ? reviewStateLabel(action.toState) : '—'}` : action.toState ? reviewStateLabel(action.toState) : '状态更新'}</small></span><time>{new Date(action.createdAt).toLocaleString('zh-CN')}</time>{action.comment && <p>{action.comment}</p>}</article>)}</div></details>}
    </section>
  </article>
}

function TextSection({ title, values, empty, ordered }: { title: string; values: string[]; empty?: string; ordered?: boolean }) {
  const Tag = ordered ? 'ol' : 'ul'
  return <section><h4>{title}</h4>{values.length ? <Tag>{values.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</Tag> : <p className="tdw-muted">{empty ?? '无'}</p>}</section>
}

function currentContent(testCase: TestDesignCase) { return testCase.revisions.find(item => item.revision === testCase.currentRevision)?.content ?? testCase.revisions.at(-1)!.content }
function reviewStateLabel(state: ReviewState) { return ({ draft: '草稿', in_review: '待审核', approved: '已通过', rejected: '已拒绝', needs_revision: '待修改' } as const)[state] }
function reviewHint(state: ReviewState) { return ({ draft: '提交后进入人工审核', in_review: '请确认当前 Revision', approved: '审核已完成', rejected: '修改后可重新提交', needs_revision: '请根据意见修改后重提' } as const)[state] }
function originLabel(origin: TestDesignCase['origin']) { return ({ ai: 'AI 新增', manual: '人工新增', historical_unchanged: '历史复用', historical_modified: '历史更新', historical_reference: '历史引用' } as const)[origin] }
function reviewDecisionLabel(decision: string) { return ({ submit: '提交审核', approve: '审核通过', reject: '拒绝', request_revision: '退回修改', withdraw: '撤回审核' } as Record<string, string>)[decision] ?? decision }

function CaseEditorDialog({ testCase, busy, onClose, onSave }: { testCase?: TestDesignCase; busy: boolean; onClose: () => void; onSave: (content: TestCaseContent, reason: string) => Promise<void> }) {
  const [content, setContent] = useState(() => testCase ? structuredClone(currentContent(testCase)) : createEmptyTestCase())
  const [reason, setReason] = useState(testCase ? '调整测试语义' : '人工新增测试用例')
  return <div className="tdw-backdrop"><section className="tdw-modal wide"><header><b>{testCase ? '编辑 TestCase v3' : '新增 TestCase v3'}</b><button onClick={onClose}><X /></button></header><TestCaseEditor value={content} onChange={setContent} /><label>变更原因<input value={reason} onChange={event => setReason(event.target.value)} /></label><footer><button onClick={onClose}>取消</button><button className="primary" disabled={busy || !reason.trim() || !testCaseEditorValid(content)} onClick={() => void onSave(content, reason.trim())}>保存</button></footer></section></div>
}
