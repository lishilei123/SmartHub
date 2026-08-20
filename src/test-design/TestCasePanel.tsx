import { AlertTriangle, Check, ChevronDown, History, Pencil, Plus, RefreshCw, TestTube2, Trash2, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { actualExecutionMethod, createEmptyTestCase, executionPendingItems, TestCaseEditor, testCaseEditorValid } from './TestCaseEditor'
import type { TestCaseContent, TestCaseExecutionSpec, TestDesignCase, TestDesignWorkflowRun } from './types'

type ReviewDecision = 'approve'

type Props = {
  run: TestDesignWorkflowRun
  busy: boolean
  onApprove: () => void
  onResynthesize: () => void
  onCreate: (content: TestCaseContent) => void
  onEdit: (caseId: string, content: TestCaseContent, reason: string) => void
  onDelete: (caseId: string) => void
  onReview: (caseId: string, decision: ReviewDecision, targetRevision: number, comment?: string) => void
}

export function TestCasePanel({ run, busy, onApprove, onResynthesize, onCreate, onEdit, onDelete, onReview }: Props) {
  const cases = run.testCases.filter(item => !item.tombstonedAt)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ mode: 'create' } | { mode: 'edit'; testCase: TestDesignCase } | null>(null)
  const [deleting, setDeleting] = useState<TestDesignCase | null>(null)
  const counts = cases.reduce<Record<string, number>>((result, item) => ({ ...result, [item.reviewState]: (result[item.reviewState] ?? 0) + 1 }), {})
  const approvedCount = counts.approved ?? 0
  const pendingReviewCount = cases.length - approvedCount
  return <section className="td2-card td2-cases">
    <header className="td2-section-head"><div><p className="td2-kicker">Test Case Design</p><h2>测试用例候选</h2><p>PlanningAgent 生成候选后直接进入人工审核；可以先编辑形成新 Revision，也可以确认当前 Revision 审核通过。</p></div></header>
    <div className="td2-case-toolbar">
      <div className="td2-case-stats"><span>共 <b>{cases.length}</b></span><span>待人工审核 <b>{pendingReviewCount}</b></span><span>审核通过 <b>{approvedCount}</b></span></div>
      <div className="td2-run-actions"><button className="td2-button primary td2-batch-approve" disabled={busy || !pendingReviewCount} onClick={onApprove}><Check />{pendingReviewCount ? `批量审核通过（${pendingReviewCount}）` : '全部已审核通过'}</button><button className="td2-button ghost" disabled={busy} onClick={() => setEditor({ mode: 'create' })}><Plus />新增用例</button><button className="td2-button ghost" disabled={busy} onClick={onResynthesize}><RefreshCw />重新生成</button></div>
    </div>
    {cases.length ? <div className="td2-case-list">{cases.map(testCase => <CaseRow key={testCase.id} testCase={testCase} requirementRefs={run.caseChangeProposals.find(item => item.candidateCaseId === testCase.id)?.requirementRefs ?? currentContent(testCase).requirementRefs} busy={busy} expanded={expanded === testCase.id} onToggle={() => setExpanded(expanded === testCase.id ? null : testCase.id)} onEdit={() => setEditor({ mode: 'edit', testCase })} onDelete={() => setDeleting(testCase)} onApprove={() => onReview(testCase.id, 'approve', testCase.currentRevision)} />)}</div> : <div className="td2-empty-compact"><TestTube2 /><span>{run.stage === 'test_case_design' ? 'PlanningAgent 正在生成用例…' : 'Requirement 已就绪，可人工新增用例。'}</span></div>}
    {editor && <CaseEditorDialog key={editor.mode === 'edit' ? `${editor.testCase.id}:${editor.testCase.currentRevision}` : 'new-case'} testCase={editor.mode === 'edit' ? editor.testCase : undefined} busy={busy} onClose={() => setEditor(null)} onSave={(content, reason) => { if (editor.mode === 'edit') onEdit(editor.testCase.id, content, reason); else onCreate(content); setEditor(null) }} />}
    {deleting && <CaseDialog title="删除测试用例" onClose={() => setDeleting(null)}><div className="td2-dialog-form"><div className="td2-danger-note"><AlertTriangle /><span><b>删除“{currentContent(deleting).title}”？</b><small>用例将被标记删除，依赖关系和 Coverage Audit 会重新校验；已发布的不可变 TestCaseSetVersion 不受影响。</small></span></div><DialogActions busy={busy} valid onClose={() => setDeleting(null)} submitLabel="确认删除" danger onSubmit={() => { onDelete(deleting.id); setDeleting(null) }} /></div></CaseDialog>}
  </section>
}

function CaseRow({ testCase, requirementRefs, busy, expanded, onToggle, onEdit, onDelete, onApprove }: { testCase: TestDesignCase; requirementRefs: string[]; busy: boolean; expanded: boolean; onToggle: () => void; onEdit: () => void; onDelete: () => void; onApprove: () => void }) {
  const revision = testCase.revisions.find(item => item.revision === testCase.currentRevision)!
  const content = revision.content
  const readiness = content.executionSpec?.executionReadiness ?? content.executionMethods[0]?.executionReadiness ?? 'needs_confirmation'
  const pending = executionPendingItems(content)
  return <article className={expanded ? 'expanded' : ''}><button className="td2-case-summary" onClick={onToggle}><span className={`td2-review-state ${testCase.reviewState}`}>{reviewStateLabel(testCase.reviewState)}</span><div><b>{content.title}</b><small>{dimensionLabel(content.dimension)} · {executionMethodLabel(actualExecutionMethod(content))} · {readinessLabel(readiness)} · {content.priority} · Revision {testCase.currentRevision}</small></div><div className="td2-methods"><span>{executionMethodLabel(actualExecutionMethod(content))}</span>{pending.length > 0 && <span className="needs_confirmation">待确认 {pending.length}</span>}</div><ChevronDown /></button>
    {expanded && <div className="td2-case-detail"><div><h4>目标</h4><p>{content.objective}</p></div><div><h4>前置条件</h4>{content.preconditions.length ? <ul>{content.preconditions.map(item => <li key={item}>{item}</li>)}</ul> : <p>无</p>}</div><section className="td2-execution-summary"><header><b>{dimensionLabel(content.dimension)} · {executionMethodLabel(actualExecutionMethod(content))}</b><span className={readiness} title={readiness}>{readinessLabel(readiness)}</span></header><ExecutionSpecView content={content} /></section><section><h4>待确认项</h4>{pending.length ? <ul>{pending.map(item => <li key={item}>{item}</li>)}</ul> : <p>无</p>}</section><section><h4>Requirement 追溯 / 测试数据需求</h4><div className="tdw-chips">{requirementRefs.map(id => <code key={`requirement-${id}`}>{id}</code>)}{content.dataRequirementIds.map(id => <code key={`data-${id}`}>{id}</code>)}</div></section>
      <section className="td2-case-governance"><header><b>Revision 与审核记录</b><History /></header><div className="td2-revision-list">{[...testCase.revisions].reverse().map(item => <span key={item.revision}><b>Revision {item.revision}</b><small>{new Date(item.createdAt).toLocaleString('zh-CN')}</small><code title={item.contentSha256}>{item.contentSha256}</code></span>)}</div>{testCase.reviewActions.length > 0 && <div className="td2-review-history">{[...testCase.reviewActions].reverse().map(action => <span key={action.id}>{reviewDecisionLabel(action.decision)} · Revision {action.targetRevision ?? testCase.currentRevision}{action.comment ? ` · ${action.comment}` : ''}</span>)}</div>}</section>
      <div className="td2-case-actions"><button className="td2-button ghost" disabled={busy} onClick={onEdit}><Pencil />编辑修改并新建 Revision</button>{testCase.reviewState !== 'approved' && <button className="td2-button primary" disabled={busy} onClick={onApprove}><Check />审核通过</button>}<button className="td2-button danger" disabled={busy} onClick={onDelete}><Trash2 />删除</button></div>
      <footer><code title={testCase.id}>{testCase.id}</code><code title={revision.contentSha256}>{revision.contentSha256}</code></footer></div>}
  </article>
}

function ExecutionSpecView({ content }: { content: TestCaseContent }) {
  const spec = content.executionSpec
  if (!spec) return <div className="td2-execution-empty"><AlertTriangle /><span><b>执行配置尚未生成</b><small>当前 Revision 没有持久化 executionSpec，不能据此推断执行步骤。</small></span></div>
  return <div className="td2-execution-view">
    {spec.kind === 'functional' && <FunctionalExecutionView content={content} spec={spec} />}
    {spec.kind === 'performance' && <PerformanceExecutionView spec={spec} />}
    {spec.kind === 'stability' && <StabilityExecutionView spec={spec} />}
    {spec.kind === 'compatibility' && <CompatibilityExecutionView spec={spec} />}
    <details className="td2-raw-spec"><summary>查看原始 executionSpec（诊断）</summary><pre className="tdw-json">{JSON.stringify(spec, null, 2)}</pre></details>
  </div>
}

function FunctionalExecutionView({ content, spec }: { content: TestCaseContent; spec: Extract<TestCaseExecutionSpec, { kind: 'functional' }> }) {
  const method = content.executionMethods.find(item => item.method === spec.method)
  const entry = method?.method === 'ui'
    ? `${method.uiSpec.entry}${method.uiSpec.viewport ? ` · ${method.uiSpec.viewport}` : ''}`
    : method?.method === 'api'
      ? `${method.apiSpec.method.toUpperCase()} ${method.apiSpec.path}`
      : '待确认'
  return <>
    <dl className="td2-execution-meta"><MetaItem label="执行方式" value={executionMethodLabel(spec.method)} /><MetaItem label="执行入口" value={entry} /><MetaItem label="步骤 / 检查" value={`${spec.steps.length} / ${spec.verificationChecks.length}`} /></dl>
    <section className="td2-execution-block"><h5>执行步骤</h5>{spec.steps.length ? <ol className="td2-execution-steps">{spec.steps.map((step, index) => <li key={step.key}><i>{index + 1}</i><div><b>{step.action}</b><p><span>预期</span>{step.expected}</p></div></li>)}</ol> : <p className="td2-execution-missing">未提供执行步骤</p>}</section>
    <section className="td2-execution-block"><h5>验证检查</h5>{spec.verificationChecks.length ? <div className="td2-verification-list">{spec.verificationChecks.map(check => <article key={check.key}><code>{check.key}</code><span>{check.description}</span></article>)}</div> : <p className="td2-execution-missing">未提供验证检查</p>}</section>
    <section className="td2-execution-note"><b>自动化提示</b><p>{spec.automationHint || '未提供'}</p></section>
  </>
}

function PerformanceExecutionView({ spec }: { spec: Extract<TestCaseExecutionSpec, { kind: 'performance' }> }) {
  return <>
    <dl className="td2-execution-meta"><MetaItem label="性能目标" value={spec.target} /><MetaItem label="虚拟用户" value={spec.virtualUsers} /><MetaItem label="持续 / Ramp-up" value={`${displayValue(spec.duration)} / ${displayValue(spec.rampUp)}`} /></dl>
    <section className="td2-execution-block"><h5>负载场景</h5><p>{spec.scenario}</p></section>
    <section className="td2-execution-block"><h5>阈值</h5>{spec.thresholds.length ? <div className="td2-verification-list">{spec.thresholds.map((threshold, index) => <article key={`${threshold.metric}-${index}`}><code>{threshold.metric}</code><span>{threshold.target}<small>来源：{threshold.sourceRef}</small></span></article>)}</div> : <p className="td2-execution-missing">未提供性能阈值</p>}</section>
    <section className="td2-execution-note"><b>数据策略</b><p>{spec.dataStrategy || '未提供'}</p></section>
    <StringList title="环境要求" items={spec.environmentRequirements} />
  </>
}

function StabilityExecutionView({ spec }: { spec: Extract<TestCaseExecutionSpec, { kind: 'stability' }> }) {
  return <>
    <dl className="td2-execution-meta"><MetaItem label="稳定性负载" value={spec.workload} /><MetaItem label="持续时间" value={spec.duration} /><MetaItem label="观测间隔" value={spec.interval} /></dl>
    <StringList title="稳定性观测" items={spec.observations} />
    <dl className="td2-execution-meta compact"><MetaItem label="恢复策略" value={spec.recoveryPolicy} /><MetaItem label="检查点策略" value={spec.checkpointPolicy} /></dl>
    <StringList title="环境要求" items={spec.environmentRequirements} />
  </>
}

function CompatibilityExecutionView({ spec }: { spec: Extract<TestCaseExecutionSpec, { kind: 'compatibility' }> }) {
  const matrices = [
    ['浏览器', spec.browserMatrix],
    ['操作系统', spec.operatingSystemMatrix],
    ['视口', spec.viewportMatrix],
    ['版本', spec.versionMatrix],
  ] as const
  return <>
    <dl className="td2-execution-meta"><MetaItem label="基础执行方式" value={executionMethodLabel(spec.baseMethod)} /><MetaItem label="基础用例" value={spec.baseCaseRefs.length ? spec.baseCaseRefs.join('、') : null} /><MetaItem label="一致性预期" value={spec.expectedConsistency} /></dl>
    <section className="td2-execution-block"><h5>兼容矩阵</h5><div className="td2-compatibility-matrix">{matrices.map(([label, values]) => <article key={label}><b>{label}</b>{values.length ? <div>{values.map(value => <span key={value}>{value}</span>)}</div> : <small>未提供</small>}</article>)}</div></section>
  </>
}

function MetaItem({ label, value }: { label: string; value: string | number | null | undefined }) { return <div><dt>{label}</dt><dd>{displayValue(value)}</dd></div> }
function StringList({ title, items }: { title: string; items: string[] }) { return <section className="td2-execution-block"><h5>{title}</h5>{items.length ? <ul className="td2-execution-list">{items.map(item => <li key={item}>{item}</li>)}</ul> : <p className="td2-execution-missing">未提供</p>}</section> }
function displayValue(value: string | number | null | undefined) { return value === null || value === undefined || value === '' ? '待确认' : String(value) }

function CaseEditorDialog({ testCase, busy, onClose, onSave }: { testCase?: TestDesignCase; busy: boolean; onClose: () => void; onSave: (content: TestCaseContent, reason: string) => void }) {
  const [content, setContent] = useState<TestCaseContent>(() => testCase ? currentContent(testCase) : createEmptyTestCase())
  const [reason, setReason] = useState(testCase ? '人工编辑测试用例' : '人工新建测试用例')
  const valid = testCaseEditorValid(content) && (!testCase || reason.trim().length >= 2)
  return <CaseDialog title={testCase ? `编辑用例 · Revision ${testCase.currentRevision}` : '新增测试用例'} wide onClose={onClose}><form className="td2-dialog-form" onSubmit={event => { event.preventDefault(); if (valid) onSave(content, reason.trim()) }}><TestCaseEditor value={content} onChange={setContent} />{testCase && <label>Revision 修改说明<input value={reason} onChange={event => setReason(event.target.value)} /></label>}<DialogActions busy={busy} valid={valid} onClose={onClose} submitLabel={testCase ? '保存新 Revision（待审核）' : '创建待审核用例'} /></form></CaseDialog>
}

function CaseDialog({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: ReactNode }) { return <div className="td2-dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section className={`td2-dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><header><h3>{title}</h3><button aria-label="关闭" onClick={onClose}><X /></button></header>{children}</section></div> }
function DialogActions({ busy, valid, onClose, submitLabel, danger, onSubmit }: { busy: boolean; valid: boolean; onClose: () => void; submitLabel: string; danger?: boolean; onSubmit?: () => void }) { return <footer className="td2-dialog-actions"><button type="button" className="td2-button ghost" disabled={busy} onClick={onClose}>取消</button><button type={onSubmit ? 'button' : 'submit'} className={`td2-button ${danger ? 'danger' : 'primary'}`} disabled={busy || !valid} onClick={onSubmit}>{submitLabel}</button></footer> }
function currentContent(testCase: TestDesignCase) { return testCase.revisions.find(item => item.revision === testCase.currentRevision)!.content }
function reviewStateLabel(value: TestDesignCase['reviewState']) { return ({ draft: '待审核', in_review: '待审核', approved: '审核通过', rejected: '未通过', needs_revision: '待审核' } as const)[value] }
function reviewDecisionLabel(value: string) { return ({ submit: '进入人工审核（历史流程）', approve: '审核通过', reject: '未通过（历史流程）', request_revision: '退回修改（历史流程）', withdraw: '撤回审核（历史流程）' } as Record<string, string>)[value] ?? value }
function dimensionLabel(value: TestCaseContent['dimension']) { return ({ functional: '功能', performance: '性能', stability: '稳定性', compatibility: '兼容性', security: '安全' } as const)[value] }
function executionMethodLabel(value: string) { return ({ ui: 'UI', api: 'API', performance_tool: '性能工具', long_running: '长稳运行', environment_matrix: '环境矩阵' } as Record<string, string>)[value] ?? value }
function readinessLabel(value: string) { return ({ ready: '已就绪', blocked: '已阻断', needs_confirmation: '待确认' } as Record<string, string>)[value] ?? value }
