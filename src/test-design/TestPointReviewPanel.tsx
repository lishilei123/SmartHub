import { AlertTriangle, CheckCircle2, Plus, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { TestPointTreePanel } from './TestPointTreePanel'
import type { TestDimension, TestPointNode, TestPointTreeOperation, TestDesignWorkflowRun } from './types'

type DialogState =
  | { mode: 'add' }
  | { mode: 'edit'; node: TestPointNode }
  | { mode: 'split'; node: TestPointNode }
  | { mode: 'merge'; nodes: TestPointNode[] }
  | { mode: 'delete'; node: TestPointNode }

type Props = {
  run: TestDesignWorkflowRun
  nodes: TestPointNode[]
  busy: boolean
  onOperation: (operations: TestPointTreeOperation[], reason: string) => void
  onApprove: () => void
  onRedesign: () => void
}

export function TestPointReviewPanel({ run, nodes, busy, onOperation, onApprove, onRedesign }: Props) {
  const [selected, setSelected] = useState<string[]>([])
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const approved = Boolean(run.testPointTree?.currentApprovedVersionId)
  const waiting = run.stage === 'test_point_review' && !approved
  const version = run.testPointTree?.versions.find(item => item.id === run.testPointTree?.currentApprovedVersionId)
  const submitOperation = (operations: TestPointTreeOperation[], reason: string) => { onOperation(operations, reason); setDialog(null); setSelected([]) }
  return <section className="td2-card td2-review">
    <header className="td2-section-head"><div><p className="td2-kicker">唯一人工门禁</p><h2>Test Point Tree 审核</h2><p>通过页面内结构化表单修改、增加、删除、拆分和合并；每次保存都生成可审计的 Tree Revision。</p></div><div className="td2-run-actions"><button className="td2-button ghost" disabled={busy || approved} onClick={() => setDialog({ mode: 'add' })}><Plus />增加</button><button className="td2-button ghost" disabled={busy || approved} onClick={onRedesign}><RefreshCw />AI 重新设计</button><button className="td2-button primary" disabled={busy || !waiting} onClick={onApprove}><ShieldCheck />批准 TestPointTreeVersion</button></div></header>
    {approved && version && <div className="td2-approved"><CheckCircle2 /><div><b>已批准 {version.id}</b><small>Version {version.version} · Revision {version.revision} · {version.projection.status}</small><code>{version.treeSha256}</code></div></div>}
    <TestPointTreePanel nodes={nodes} selected={selected} onSelect={setSelected} onEdit={node => setDialog({ mode: 'edit', node })} onSplit={node => setDialog({ mode: 'split', node })} onDelete={node => setDialog({ mode: 'delete', node })} onMerge={mergeNodes => setDialog({ mode: 'merge', nodes: mergeNodes })} readOnly={approved} />
    {(dialog?.mode === 'add' || dialog?.mode === 'edit') && <PointFormDialog mode={dialog.mode} node={dialog.mode === 'edit' ? dialog.node : undefined} nodes={nodes} busy={busy} onClose={() => setDialog(null)} onSubmit={submitOperation} />}
    {dialog?.mode === 'split' && <SplitDialog node={dialog.node} busy={busy} onClose={() => setDialog(null)} onSubmit={submitOperation} />}
    {dialog?.mode === 'merge' && <MergeDialog nodes={dialog.nodes} busy={busy} onClose={() => setDialog(null)} onSubmit={submitOperation} />}
    {dialog?.mode === 'delete' && <DeleteDialog node={dialog.node} busy={busy} onClose={() => setDialog(null)} onSubmit={submitOperation} />}
  </section>
}

function PointFormDialog({ mode, node, nodes, busy, onClose, onSubmit }: { mode: 'add' | 'edit'; node?: TestPointNode; nodes: TestPointNode[]; busy: boolean; onClose: () => void; onSubmit: (operations: TestPointTreeOperation[], reason: string) => void }) {
  const active = nodes.filter(item => !item.deleted)
  const [title, setTitle] = useState(node?.title ?? '')
  const [objective, setObjective] = useState(node?.objective ?? '')
  const [parentId, setParentId] = useState(node?.parentId ?? '')
  const [dimension, setDimension] = useState<TestDimension>(node?.dimension ?? 'functional')
  const [priority, setPriority] = useState<TestPointNode['priority']>(node?.priority ?? 'P1')
  const [applicability, setApplicability] = useState<TestPointNode['applicability']>(node?.applicability ?? 'applicable')
  const [entryMethods, setEntryMethods] = useState<TestPointNode['entryMethods']>(node?.entryMethods ?? ['ui'])
  const [oracle, setOracle] = useState(node?.oracle ?? '结果符合已发布需求')
  const [techniques, setTechniques] = useState(toLines(node?.designTechniques ?? ['人工补充']))
  const [dataConditions, setDataConditions] = useState(toLines(node?.dataConditions ?? []))
  const [risks, setRisks] = useState(toLines(node?.risks ?? []))
  const [assumptions, setAssumptions] = useState(toLines(node?.assumptions ?? []))
  const [reason, setReason] = useState(mode === 'add' ? '人工增加测试点' : '人工编辑测试点')
  const descendants = node ? descendantIds(active, node.nodeId) : new Set<string>()
  const parentOptions = active.filter(candidate => candidate.nodeId !== node?.nodeId && !descendants.has(candidate.nodeId))
  const valid = title.trim() && objective.trim() && oracle.trim() && reason.trim().length >= 2 && entryMethods.length > 0
  const submit = (event: FormEvent) => {
    event.preventDefault(); if (!valid) return
    const value = { title: title.trim(), objective: objective.trim(), dimension, priority, applicability, designTechniques: lines(techniques), entryMethods, oracle: oracle.trim(), dataConditions: lines(dataConditions), risks: lines(risks), assumptions: lines(assumptions), basisRefs: node?.basisRefs ?? [], historicalRefs: node?.historicalRefs ?? [] }
    if (!node) return onSubmit([{ op: 'add', clientNodeRef: `manual-${Date.now()}`, parentId: parentId || null, sortKey: `manual-${Date.now()}`, value }], reason.trim())
    const { title: _title, ...patch } = value
    const operations: TestPointTreeOperation[] = []
    if (title.trim() !== node.title) operations.push({ op: 'rename', nodeId: node.nodeId, title: title.trim() })
    operations.push({ op: 'update', nodeId: node.nodeId, patch })
    if ((parentId || null) !== node.parentId) operations.push({ op: 'move', nodeId: node.nodeId, parentId: parentId || null, sortKey: `manual-move-${Date.now()}` })
    onSubmit(operations, reason.trim())
  }
  return <TreeDialog title={mode === 'add' ? '增加测试点' : '编辑测试点'} onClose={onClose}><form className="td2-dialog-form" onSubmit={submit}>
    <div className="td2-editor-grid"><label className="wide">标题<input autoFocus value={title} onChange={event => setTitle(event.target.value)} /></label><label className="wide">验证目标<textarea value={objective} onChange={event => setObjective(event.target.value)} /></label><label>父节点<select value={parentId} onChange={event => setParentId(event.target.value)}><option value="">根节点</option>{parentOptions.map(option => <option value={option.nodeId} key={option.nodeId}>{option.title}</option>)}</select></label><label>维度<select value={dimension} onChange={event => setDimension(event.target.value as TestDimension)}>{['functional', 'performance', 'stability', 'compatibility', 'security'].map(value => <option value={value} key={value}>{value}</option>)}</select></label><label>优先级<select value={priority} onChange={event => setPriority(event.target.value as TestPointNode['priority'])}>{['P0', 'P1', 'P2', 'P3'].map(value => <option value={value} key={value}>{value}</option>)}</select></label><label>适用性<select value={applicability} onChange={event => setApplicability(event.target.value as TestPointNode['applicability'])}><option value="applicable">applicable</option><option value="not_applicable">not_applicable</option><option value="blocked_by_confirmation">blocked_by_confirmation</option></select></label><fieldset className="wide"><legend>执行入口</legend>{(['ui', 'api'] as const).map(method => <label key={method}><input type="checkbox" checked={entryMethods.includes(method)} onChange={() => setEntryMethods(current => current.includes(method) ? current.filter(item => item !== method) : [...current, method])} />{method.toUpperCase()}</label>)}</fieldset><label className="wide">判定准则<textarea value={oracle} onChange={event => setOracle(event.target.value)} /></label><label>设计方法（每行一项）<textarea value={techniques} onChange={event => setTechniques(event.target.value)} /></label><label>数据条件（每行一项）<textarea value={dataConditions} onChange={event => setDataConditions(event.target.value)} /></label><label>风险（每行一项）<textarea value={risks} onChange={event => setRisks(event.target.value)} /></label><label>假设（每行一项）<textarea value={assumptions} onChange={event => setAssumptions(event.target.value)} /></label><label className="wide">Revision 修改说明<input value={reason} onChange={event => setReason(event.target.value)} /></label></div>
    <DialogActions busy={busy} valid={Boolean(valid)} onClose={onClose} submitLabel={mode === 'add' ? '增加测试点' : '保存新 Revision'} />
  </form></TreeDialog>
}

function SplitDialog({ node, busy, onClose, onSubmit }: { node: TestPointNode; busy: boolean; onClose: () => void; onSubmit: (operations: TestPointTreeOperation[], reason: string) => void }) {
  const [raw, setRaw] = useState(`${node.title} - 场景 1\n${node.title} - 场景 2`)
  const titles = lines(raw)
  const submit = (event: FormEvent) => { event.preventDefault(); if (titles.length < 2) return; const value = contentOf(node); onSubmit([{ op: 'split', nodeId: node.nodeId, children: titles.map((title, index) => ({ clientNodeRef: `split-${Date.now()}-${index}`, sortKey: `${node.sortKey}-${String(index + 1).padStart(2, '0')}`, value: { ...value, title, objective: `验证 ${title}` } })) }], `人工拆分测试点：${node.title}`) }
  return <TreeDialog title="拆分测试点" onClose={onClose}><form className="td2-dialog-form" onSubmit={submit}><p>原测试点“{node.title}”将标记为删除，并在同一层级创建以下测试点。每行填写一个标题，至少两项。</p><label>拆分后的标题<textarea autoFocus value={raw} onChange={event => setRaw(event.target.value)} /></label><DialogActions busy={busy} valid={titles.length >= 2} onClose={onClose} submitLabel="确认拆分" /></form></TreeDialog>
}

function MergeDialog({ nodes, busy, onClose, onSubmit }: { nodes: TestPointNode[]; busy: boolean; onClose: () => void; onSubmit: (operations: TestPointTreeOperation[], reason: string) => void }) {
  const target = nodes[0]
  const [title, setTitle] = useState(target?.title ?? '')
  const submit = (event: FormEvent) => { event.preventDefault(); if (!target || !title.trim()) return; onSubmit([{ op: 'merge', sourceNodeIds: nodes.map(node => node.nodeId), targetNodeId: target.nodeId, value: { title: title.trim() } }], `人工合并 ${nodes.length} 个测试点`) }
  return <TreeDialog title="合并测试点" onClose={onClose}><form className="td2-dialog-form" onSubmit={submit}><p>将保留第一项作为目标节点，其他 {Math.max(0, nodes.length - 1)} 项标记为删除。</p><ul>{nodes.map(node => <li key={node.nodeId}>{node.title}</li>)}</ul><label>合并后的标题<input autoFocus value={title} onChange={event => setTitle(event.target.value)} /></label><DialogActions busy={busy} valid={Boolean(target && title.trim())} onClose={onClose} submitLabel="确认合并" /></form></TreeDialog>
}

function DeleteDialog({ node, busy, onClose, onSubmit }: { node: TestPointNode; busy: boolean; onClose: () => void; onSubmit: (operations: TestPointTreeOperation[], reason: string) => void }) {
  return <TreeDialog title="删除测试点" onClose={onClose}><div className="td2-dialog-form"><div className="td2-danger-note"><AlertTriangle /><span><b>删除“{node.title}”？</b><small>其直接子节点将提升到当前层级；保存后会创建新的 Tree Revision，并使现有 Coverage Audit 失效。</small></span></div><DialogActions busy={busy} valid onClose={onClose} submitLabel="确认删除" danger onSubmit={() => onSubmit([{ op: 'delete', nodeId: node.nodeId }], `人工删除测试点：${node.title}`)} /></div></TreeDialog>
}

function TreeDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) { return <div className="td2-dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section className="td2-dialog" role="dialog" aria-modal="true" aria-label={title}><header><h3>{title}</h3><button aria-label="关闭" onClick={onClose}><X /></button></header>{children}</section></div> }

function DialogActions({ busy, valid, onClose, submitLabel, danger, onSubmit }: { busy: boolean; valid: boolean; onClose: () => void; submitLabel: string; danger?: boolean; onSubmit?: () => void }) { return <footer className="td2-dialog-actions"><button type="button" className="td2-button ghost" disabled={busy} onClick={onClose}>取消</button><button type={onSubmit ? 'button' : 'submit'} className={`td2-button ${danger ? 'danger' : 'primary'}`} disabled={busy || !valid} onClick={onSubmit}>{submitLabel}</button></footer> }
function lines(value: string) { return [...new Set(value.split(/\r?\n/u).map(item => item.trim()).filter(Boolean))] }
function toLines(value: string[]) { return value.join('\n') }
function contentOf(node: TestPointNode): Omit<TestPointNode, 'nodeId' | 'parentId' | 'sortKey' | 'deleted'> { const { nodeId: _nodeId, parentId: _parentId, sortKey: _sortKey, deleted: _deleted, ...content } = node; return content }
function descendantIds(nodes: TestPointNode[], nodeId: string) { const result = new Set<string>(); const visit = (parentId: string) => nodes.filter(node => node.parentId === parentId).forEach(node => { if (!result.has(node.nodeId)) { result.add(node.nodeId); visit(node.nodeId) } }); visit(nodeId); return result }
