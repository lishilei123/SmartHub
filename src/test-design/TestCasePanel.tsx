import { Check, ChevronDown, Code2, Monitor, RefreshCw, Send, TestTube2 } from 'lucide-react'
import { useState } from 'react'
import type { TestDesignCase, TestDesignWorkflowRun } from './types'

export function TestCasePanel({ run, busy, onSubmit, onApprove, onResynthesize }: { run: TestDesignWorkflowRun; busy: boolean; onSubmit: () => void; onApprove: () => void; onResynthesize: () => void }) {
  const cases = run.testCases.filter(item => !item.tombstonedAt)
  const [expanded, setExpanded] = useState<string | null>(cases[0]?.id ?? null)
  const counts = cases.reduce<Record<string, number>>((result, item) => ({ ...result, [item.reviewState]: (result[item.reviewState] ?? 0) + 1 }), {})
  return <section className="td2-card td2-cases">
    <header className="td2-section-head"><div><p className="td2-kicker">Test Case Design</p><h2>测试用例候选</h2><p>同一个 TestDesignAgent 读取批准的测试点树与冻结 Workspace，生成 UI/API 用例和数据需求。</p></div><div className="td2-run-actions"><button className="td2-button ghost" disabled={busy || !run.testPointTree?.currentApprovedVersionId} onClick={onResynthesize}><RefreshCw />重新生成</button><button className="td2-button ghost" disabled={busy || !counts.draft} onClick={onSubmit}><Send />提交审核</button><button className="td2-button primary" disabled={busy || !counts.in_review} onClick={onApprove}><Check />批准用例</button></div></header>
    <div className="td2-case-stats"><span>共 <b>{cases.length}</b></span><span>草稿 <b>{counts.draft ?? 0}</b></span><span>审核中 <b>{counts.in_review ?? 0}</b></span><span>已批准 <b>{counts.approved ?? 0}</b></span><span>数据需求 <b>{run.dataSetVersions.at(-1)?.requirements.length ?? 0}</b></span></div>
    {cases.length ? <div className="td2-case-list">{cases.map(testCase => <CaseRow key={testCase.id} testCase={testCase} expanded={expanded === testCase.id} onToggle={() => setExpanded(expanded === testCase.id ? null : testCase.id)} />)}</div> : <div className="td2-empty-compact"><TestTube2 /><span>{run.stage === 'test_case_design' ? 'TestDesignAgent 正在生成用例…' : '批准测试点树后生成用例'}</span></div>}
  </section>
}

function CaseRow({ testCase, expanded, onToggle }: { testCase: TestDesignCase; expanded: boolean; onToggle: () => void }) {
  const revision = testCase.revisions.find(item => item.revision === testCase.currentRevision)!
  const content = revision.content
  return <article className={expanded ? 'expanded' : ''}><button className="td2-case-summary" onClick={onToggle}><span className={`td2-review-state ${testCase.reviewState}`}>{testCase.reviewState}</span><div><b>{content.title}</b><small>{content.dimension} · {content.priority} · {content.testPointIds.length} 个测试点 · Revision {testCase.currentRevision}</small></div><div className="td2-methods">{content.executionMethods.map(method => <span key={method.method}>{method.method === 'ui' ? <Monitor /> : <Code2 />}{method.method.toUpperCase()}</span>)}</div><ChevronDown /></button>
    {expanded && <div className="td2-case-detail"><div><h4>目标</h4><p>{content.objective}</p></div><div><h4>前置条件</h4><ul>{content.preconditions.map(item => <li key={item}>{item}</li>)}</ul></div>{content.executionMethods.map(method => <section key={method.method}><header><b>{method.method.toUpperCase()} 执行</b><span className={method.executionReadiness}>{method.executionReadiness}</span></header>{method.method === 'ui' ? <code>{method.uiSpec.entry}</code> : <code>{method.apiSpec.method} {method.apiSpec.path}</code>}<ol>{method.steps.map(step => <li key={step.key}><b>{step.action}</b><span>{step.expected}</span></li>)}</ol></section>)}<footer><code>{testCase.id}</code><code>{revision.contentSha256}</code></footer></div>}
  </article>
}
