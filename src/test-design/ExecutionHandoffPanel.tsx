import { Download, ExternalLink, FileCheck2, PackageCheck, Rocket } from 'lucide-react'
import { useState } from 'react'
import { exportCaseSetUrl } from './api'
import type { TestCaseSetVersion, TestDesignWorkflowRun, TestExecutionHandoff, TestSuiteVersion } from './types'

export function ExecutionHandoffPanel({ run, suites, handoffs, busy, onPublish, onHandoff }: { run: TestDesignWorkflowRun; suites: TestSuiteVersion[]; handoffs: TestExecutionHandoff[]; busy: boolean; onPublish: (name: string) => Promise<TestCaseSetVersion | undefined>; onHandoff: (version: TestCaseSetVersion, strategy: 'standard' | 'fast' | 'full', smokeSuiteVersionId?: string, regressionSuiteVersionId?: string) => void }) {
  const [name, setName] = useState('测试用例集')
  const [strategy, setStrategy] = useState<'standard' | 'fast' | 'full'>('standard')
  const [smokeSuite, setSmokeSuite] = useState('')
  const [regressionSuite, setRegressionSuite] = useState('')
  const audit = run.coverageAudits.at(-1)
  const published = run.caseSetVersions?.at(-1)
  const canPublish = Boolean(audit?.status === 'valid' && audit.blockers.every(item => item.resolution === 'execution_handoff') && run.testCases.filter(item => !item.tombstonedAt).every(item => item.reviewState === 'approved'))
  const submitPublish = () => void onPublish(name.trim() || '测试用例集')
  const canHandoff = Boolean(published && regressionSuite && (strategy === 'full' || smokeSuite))
  return <section className="td2-card td2-handoff">
    <header className="td2-section-head"><div><p className="td2-kicker">Publish & Handoff</p><h2>用例发布与执行交接</h2><p>仅 Audit PASS 后由人工发布不可变 TestCaseSetVersion，再创建执行交接。</p></div></header>
    {!published ? <div className="td2-publish-box"><FileCheck2 /><div><b>发布 TestCaseSetVersion</b><small>{canPublish ? '发布门禁已满足' : '需先完成用例审核并达到 Coverage Audit PASS'}</small></div><input value={name} onChange={event => setName(event.target.value)} /><button className="td2-button primary" disabled={busy || !canPublish} onClick={submitPublish}><PackageCheck />人工发布</button></div> : <>
      <div className="td2-published-set"><PackageCheck /><div><b>{published.name} · V{published.version}</b><small>{published.id} · {published.members.length} 条用例</small><code>{published.contentSha256}</code></div><span className={`td2-status ${published.projection.status}`}>{published.projection.status}</span><div className="td2-downloads"><a href={exportCaseSetUrl(published.id, 'json')}><Download />JSON</a><a href={exportCaseSetUrl(published.id, 'markdown')}><Download />Markdown</a><a href={exportCaseSetUrl(published.id, 'xlsx')}><Download />XLSX</a></div></div>
      <div className="td2-projection-files"><b>正式 Workspace 资产投影</b>{published.projection.files.map(file => <article key={file.logicalPath}><FileCheck2 /><span><code>{file.logicalPath}</code><small>AssetVersion {file.assetVersionId ?? '同步中'}</small></span><code>{file.contentSha256}</code></article>)}</div>
      <div className="td2-handoff-form"><div><b>执行策略</b><div className="td2-segments">{(['standard', 'fast', 'full'] as const).map(item => <button key={item} className={strategy === item ? 'active' : ''} onClick={() => setStrategy(item)}>{item}</button>)}</div></div>{strategy !== 'full' && <label><span>Smoke Suite</span><select value={smokeSuite} onChange={event => setSmokeSuite(event.target.value)}><option value="">请选择不可变版本</option>{suites.filter(item => item.suiteType === 'smoke').map(item => <option value={item.id} key={item.id}>{item.name} · V{item.version}</option>)}</select></label>}<label><span>Regression Suite</span><select value={regressionSuite} onChange={event => setRegressionSuite(event.target.value)}><option value="">请选择不可变版本</option>{suites.filter(item => item.suiteType === 'regression').map(item => <option value={item.id} key={item.id}>{item.name} · V{item.version}</option>)}</select></label><button className="td2-button primary" disabled={busy || !canHandoff} onClick={() => onHandoff(published, strategy, smokeSuite || undefined, regressionSuite || undefined)}><Rocket />创建 Execution Handoff</button></div>
    </>}
    {handoffs.length > 0 && <div className="td2-handoff-list"><h3>执行交接记录</h3>{handoffs.map(item => <article key={item.id}><Rocket /><div><b>{item.strategy} · {item.members.length} 个执行成员</b><small>{new Date(item.createdAt).toLocaleString('zh-CN')}</small><code>{item.id}</code></div><ExternalLink /></article>)}</div>}
  </section>
}
