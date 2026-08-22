import { AlertTriangle, ClipboardList, Filter, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ProjectVersion } from '../project-version-api'
import { loadPublishedTestCases } from './api'
import type { PublishedTestCase, PublishedTestCaseSource, PublishedTestCasesResponse } from './types'
import './test-cases.css'

type Notify = (message: string, tone?: 'success' | 'error' | 'warning') => void
type Filters = { query: string; source: '' | PublishedTestCaseSource; priority: string; dimension: string; executionMethod: string; readiness: string }
const emptyFilters: Filters = { query: '', source: '', priority: '', dimension: '', executionMethod: '', readiness: '' }
const sourceLabel: Record<PublishedTestCaseSource, string> = { current_created: '当前版本新增', historical_reused: '历史复用', historical_modified: '历史修改' }
const dimensionLabel: Record<string, string> = { functional: '功能', performance: '性能', stability: '稳定性', compatibility: '兼容性', security: '安全' }
const readinessLabel: Record<string, string> = { ready: '可执行', needs_confirmation: '待确认', blocked: '阻塞' }

export function TestCasesPage({ projectVersion, onManageVersions, notify }: { projectVersion: ProjectVersion | null; onManageVersions: () => void; notify: Notify }) {
  const [data, setData] = useState<PublishedTestCasesResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filters, setFilters] = useState<Filters>(emptyFilters)
  const [selected, setSelected] = useState<PublishedTestCase | null>(null)

  useEffect(() => {
    setData(null); setError(''); setFilters(emptyFilters); setSelected(null)
    if (!projectVersion) return
    let cancelled = false
    setLoading(true)
    void loadPublishedTestCases(projectVersion.id)
      .then(value => { if (!cancelled) setData(value) })
      .catch(cause => { if (!cancelled) { const message = cause instanceof Error ? cause.message : '正式测试用例读取失败'; setError(message); notify(message, 'error') } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [notify, projectVersion?.id])

  const items = useMemo(() => (data?.items ?? []).filter(item => {
    const query = filters.query.trim().toLocaleLowerCase()
    const matchesQuery = !query || item.content.title.toLocaleLowerCase().includes(query) || item.content.requirementRefs.some(reference => reference.toLocaleLowerCase().includes(query))
    return matchesQuery
      && (!filters.source || item.source === filters.source)
      && (!filters.priority || item.content.priority === filters.priority)
      && (!filters.dimension || item.content.dimension === filters.dimension)
      && (!filters.executionMethod || item.content.executionMethods.includes(filters.executionMethod as 'ui' | 'api'))
      && (!filters.readiness || item.executionReadiness === filters.readiness)
  }), [data, filters])
  const update = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters(current => ({ ...current, [key]: value }))

  if (!projectVersion) return <section className="test-cases-page"><EmptyVersion onManageVersions={onManageVersions} /></section>
  return <section className="test-cases-page" aria-label="测试用例">
    <header className="test-cases-hero"><div><span className="test-cases-eyebrow">FORMAL TEST CASE LIBRARY</span><h2>测试用例</h2><p>当前版本已审核并发布的正式测试用例；不读取测试设计 Run 中的临时候选。</p></div><div className="test-cases-version"><small>当前版本</small><b>{projectVersion.name}</b><button onClick={onManageVersions}>切换版本</button></div></header>
    {loading && <div className="test-cases-state">正在读取当前版本正式用例…</div>}
    {error && <div className="test-cases-state error"><AlertTriangle />{error}</div>}
    {!loading && !error && data?.libraryVersion === null && <EmptyLibrary />}
    {!loading && !error && data?.libraryVersion && <>
      <section className="test-cases-summary"><div><small>正式用例库</small><b>{data.libraryVersion.name} · Library v{data.libraryVersion.version}</b><code>{data.libraryVersion.contentSha256.slice(0, 12)}</code></div><Metric label="正式用例" value={data.statistics.total} /><Metric label="当前版本新增" value={data.statistics.currentCreated} /><Metric label="历史复用" value={data.statistics.historicalReused} /><Metric label="历史修改" value={data.statistics.historicalModified} /></section>
      <section className="test-cases-filters" aria-label="测试用例筛选"><label><Search size={16} /><input value={filters.query} onChange={event => update('query', event.target.value)} placeholder="搜索用例名称或需求引用" /></label><Select value={filters.source} onChange={value => update('source', value as Filters['source'])} options={[['', '全部来源'], ['current_created', '当前版本新增'], ['historical_reused', '历史复用'], ['historical_modified', '历史修改']]} /><Select value={filters.priority} onChange={value => update('priority', value)} options={[['', '全部优先级'], ['P0', 'P0'], ['P1', 'P1'], ['P2', 'P2'], ['P3', 'P3']]} /><Select value={filters.dimension} onChange={value => update('dimension', value)} options={[['', '全部维度'], ...Object.entries(dimensionLabel)]} /><Select value={filters.executionMethod} onChange={value => update('executionMethod', value)} options={[['', '全部执行方式'], ['ui', 'UI'], ['api', 'API']]} /><Select value={filters.readiness} onChange={value => update('readiness', value)} options={[['', '全部就绪状态'], ...Object.entries(readinessLabel)]} /><button className="test-cases-clear" onClick={() => setFilters(emptyFilters)}><Filter size={15} />重置</button></section>
      <div className="test-cases-layout"><section className="test-cases-table"><header><b>当前筛选结果</b><span>{items.length} / {data.statistics.total} 条</span></header>{items.length ? <div role="table"><div className="test-cases-row labels" role="row"><span>用例名称</span><span>来源</span><span>优先级</span><span>测试维度</span><span>执行方式</span><span>执行状态</span><span>Revision</span></div>{items.map(item => <button className={`test-cases-row ${selected?.caseId === item.caseId && selected.revision === item.revision ? 'selected' : ''}`} key={`${item.caseId}:${item.revision}`} onClick={() => setSelected(item)}><span><b>{item.content.title}</b><small>{item.content.requirementRefs.join(' · ') || '未标注需求'}</small></span><span><Tag tone={item.source}>{sourceLabel[item.source]}</Tag></span><span>{item.content.priority}</span><span>{dimensionLabel[item.content.dimension] ?? item.content.dimension}</span><span>{item.content.executionMethods.map(method => method.toUpperCase()).join(' / ')}</span><span><Tag tone={item.executionReadiness}>{readinessLabel[item.executionReadiness]}</Tag></span><span>r{item.revision}</span></button>)}</div> : <div className="test-cases-no-results">没有符合筛选条件的正式用例。</div>}</section>{selected && <CaseDetail item={selected} onClose={() => setSelected(null)} />}</div>
    </>}
  </section>
}

function Select({ value, onChange, options }: { value: string; onChange: (value: string) => void; options: Array<[string, string]> }) { return <select value={value} onChange={event => onChange(event.target.value)}>{options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> }
function Metric({ label, value }: { label: string; value: number }) { return <div><small>{label}</small><b>{value}</b></div> }
function Tag({ tone, children }: { tone: string; children: string }) { return <i className={`test-cases-tag ${tone}`}>{children}</i> }
function EmptyVersion({ onManageVersions }: { onManageVersions: () => void }) { return <div className="test-cases-empty"><ClipboardList /><h2>请选择项目版本</h2><p>测试用例以 ProjectVersion 为隔离边界。</p><button onClick={onManageVersions}>管理项目版本</button></div> }
function EmptyLibrary() { return <div className="test-cases-empty"><ClipboardList /><h3>当前版本暂无已发布测试用例</h3><p>请先在测试策划中完成测试设计、审核与发布。</p></div> }
function CaseDetail({ item, onClose }: { item: PublishedTestCase; onClose: () => void }) { return <aside className="test-cases-detail"><header><div><Tag tone={item.source}>{sourceLabel[item.source]}</Tag><h3>{item.content.title}</h3></div><button onClick={onClose} aria-label="关闭用例详情"><X /></button></header><dl><div><dt>优先级</dt><dd>{item.content.priority}</dd></div><div><dt>测试维度</dt><dd>{dimensionLabel[item.content.dimension] ?? item.content.dimension}</dd></div><div><dt>执行方式</dt><dd>{item.content.executionMethods.map(method => method.toUpperCase()).join(' / ')}</dd></div><div><dt>Revision</dt><dd>r{item.revision}</dd></div><div><dt>执行就绪状态</dt><dd>{readinessLabel[item.executionReadiness]}</dd></div></dl><DetailList title="关联需求" values={item.content.requirementRefs} /><DetailList title="前置条件" values={item.content.preconditions} /><DetailList title="执行步骤" values={item.content.steps} /><DetailList title="预期结果" values={item.content.expectedResults} />{item.sourceTraceability ? <section><h4>来源追溯</h4><p>来源版本：{item.sourceTraceability.sourceProjectVersionId}</p><p>来源 Case：{item.sourceTraceability.sourceCaseId} · Revision {item.sourceTraceability.sourceRevision}</p><p>变更类型：{item.sourceTraceability.changeType === 'update' ? '修改' : '复用'}</p></section> : <section><h4>来源追溯</h4><p>来源：当前版本</p></section>}</aside> }
function DetailList({ title, values }: { title: string; values: string[] }) { return <section><h4>{title}</h4>{values.length ? <ol>{values.map((value, index) => <li key={`${index}:${value}`}>{value}</li>)}</ol> : <p>—</p>}</section> }
