import { CheckCircle2, Plus, RefreshCw, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { TestPointTreePanel } from './TestPointTreePanel'
import type { TestPointNode, TestPointTreeOperation, TestDesignWorkflowRun } from './types'

export function TestPointReviewPanel({ run, nodes, busy, onOperation, onApprove, onRedesign }: { run: TestDesignWorkflowRun; nodes: TestPointNode[]; busy: boolean; onOperation: (operations: TestPointTreeOperation[], reason: string) => void; onApprove: () => void; onRedesign: () => void }) {
  const [selected, setSelected] = useState<string[]>([])
  const approved = Boolean(run.testPointTree?.currentApprovedVersionId)
  const waiting = run.stage === 'test_point_review' && !approved
  const add = () => {
    const title = window.prompt('新增测试点标题')?.trim(); if (!title) return
    const ref = `manual-${Date.now()}`
    onOperation([{ op: 'add', clientNodeRef: ref, parentId: null, sortKey: `manual-${Date.now()}`, value: { title, objective: `验证 ${title}`, dimension: 'functional', priority: 'P1', applicability: 'applicable', designTechniques: ['人工补充'], entryMethods: ['ui'], oracle: '结果符合已发布需求', dataConditions: [], risks: [], assumptions: [], basisRefs: [], historicalRefs: [] } }], '人工增加测试点')
  }
  const version = run.testPointTree?.versions.find(item => item.id === run.testPointTree?.currentApprovedVersionId)
  return <section className="td2-card td2-review">
    <header className="td2-section-head"><div><p className="td2-kicker">唯一人工门禁</p><h2>Test Point Tree 审核</h2><p>人工可修改、增加、删除、拆分、合并，或要求同一 TestDesignAgent 重新设计。</p></div><div className="td2-run-actions"><button className="td2-button ghost" disabled={busy || approved} onClick={add}><Plus />增加</button><button className="td2-button ghost" disabled={busy || approved} onClick={onRedesign}><RefreshCw />AI 重新设计</button><button className="td2-button primary" disabled={busy || !waiting} onClick={onApprove}><ShieldCheck />批准 TestPointTreeVersion</button></div></header>
    {approved && version && <div className="td2-approved"><CheckCircle2 /><div><b>已批准 {version.id}</b><small>Version {version.version} · Revision {version.revision} · {version.projection.status}</small><code>{version.treeSha256}</code></div></div>}
    <TestPointTreePanel nodes={nodes} selected={selected} onSelect={setSelected} onOperation={onOperation} readOnly={approved} />
  </section>
}
