import { CheckCircle2, FileCheck2, GitCompareArrows, LockKeyhole, PackageCheck, Rocket, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import * as api from './api'
import type { LibraryTestCase, TestCaseLibraryVersion, TestDesignWorkflowRun, TestExecutionMethod } from './types'

type PublicationProps = {
  projectId: string
  run?: TestDesignWorkflowRun | null
  cases: LibraryTestCase[]
  versions: TestCaseLibraryVersion[]
  busy: boolean
  onPublish?: (name: string) => Promise<TestCaseLibraryVersion | undefined>
}

export function TestDesignPublicationPanel({ projectId, run, cases, versions, busy, onPublish }: PublicationProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = versions.find(item => item.id === selectedId) ?? versions[0]
  const [publishName, setPublishName] = useState(run ? `测试用例库 · ${new Date().toLocaleDateString('zh-CN')}` : '')
  const [diff, setDiff] = useState<Array<{ caseId: string; change: string }> | null>(null)
  const audit = run?.coverageAudits.at(-1)
  const publicationAuditBlockers = audit?.blockers.filter(item => item.resolution !== 'execution_handoff') ?? []
  const publishBlockers = run ? [
    !audit ? '尚未执行 Coverage Audit' : '',
    audit?.status !== 'valid' ? '最新 Coverage Audit 已失效，请重新检查' : '',
    run.testCases.some(item => !item.tombstonedAt && item.reviewState !== 'approved') ? '候选用例未全部审核通过' : '',
    publicationAuditBlockers.length ? `Coverage Audit 存在 ${publicationAuditBlockers.length} 个语义发布阻断项` : '',
  ].filter(Boolean) : []
  const publish = async () => {
    const version = await onPublish?.(publishName.trim())
    if (!version) return
    setSelectedId(version.id); setPublishName('')
    const url = new URL(window.location.href)
    url.searchParams.set('testDesignEntry', 'library')
    window.history.pushState({}, '', url)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  return <section className="tdw-panel tdw-publications">
    <header><div><span className="tdw-icon"><PackageCheck /></span><div><h2>{run ? '确认并发布' : '用例库发布记录'}</h2><p>正式用例版本与测试套件均由服务端创建为不可变资产。</p></div></div>{run && <span className={`tdw-badge ${publishBlockers.length ? 'warning' : 'success'}`}>{publishBlockers.length ? `${publishBlockers.length} 项门禁未满足` : '发布门禁已满足'}</span>}</header>
    {run && <section className="tdw-publish-gate"><div><LockKeyhole /><span><b>发布正式测试用例版本</b><small>Service 将冻结历史基线与本轮 Candidate Delta 合并；未命中历史默认复用，只有 create/update Candidate 需要审核，正式废弃仅由用例库人工管理触发。</small></span></div><div className="tdw-publish-form"><input value={publishName} onChange={event => setPublishName(event.target.value)} placeholder="正式用例版本名称" /><button className="primary" disabled={busy || publishBlockers.length > 0 || !publishName.trim()} onClick={() => void publish().catch(() => undefined)}><Rocket />确认发布</button></div>{publishBlockers.length ? <ul>{publishBlockers.map(item => <li key={item}><ShieldAlert />{item}</li>)}</ul> : <p className="success"><CheckCircle2 />Candidate 审核与 coverageTarget Requirement Trace Coverage 均已通过；该指标不代表场景完整性。Effective Case Set 共 {run.effectiveCaseCount ?? audit?.statistics.totalCases ?? run.testCases.length} 条。</p>}</section>}
    {!versions.length ? <div className="tdw-empty"><PackageCheck /><b>尚未发布正式用例库版本</b><span>完成 TestCase 审核与 Coverage Audit 后发布。</span></div> : <div className="tdw-master-detail">
      <div className="tdw-master-list">{versions.map(item => <button key={item.id} className={selected?.id === item.id ? 'active' : ''} onClick={() => { setSelectedId(item.id); setDiff(null) }}><span className="tdw-operation reuse">V{item.version}</span><b>{item.name}</b><small>{item.members.length} 条正式用例</small><footer><code>{item.id}</code><em>{new Date(item.publishedAt).toLocaleDateString('zh-CN')}</em></footer></button>)}</div>
      {selected && <article className="tdw-release-detail">
        <header><div><span className="tdw-status active">正式用例库已发布</span><h3>{selected.name} · V{selected.version}</h3><code>{selected.id}</code></div><span>{selected.publishedBy} · {new Date(selected.publishedAt).toLocaleString('zh-CN')}</span></header>
        <ReleaseStatistics version={selected} />
        <section><h4>冻结成员详情</h4><div className="tdw-projection">{selected.members.map(member => { const currentRevision = cases.find(item => item.id === member.caseId)?.currentRevision; return <article key={`${member.caseId}:${member.revision}`}><FileCheck2 /><span><b>{member.frozenContent.title}</b><code>Case ID {member.caseId}</code><code>冻结 Revision r{member.revision} · 当前 Revision r{currentRevision ?? '—'}</code><code>冻结内容 Hash {member.contentSha256}</code><small>{member.frozenContent.dimension} · {member.frozenContent.priority} · {memberMethods(member).join(' + ')} · {member.executionReadiness}</small>{currentRevision && currentRevision > member.revision && <small>该用例已有较新 Revision，当前套件仍使用冻结的 Revision r{member.revision}</small>}</span></article> })}</div></section>
        <section><h4>Coverage Audit</h4>{selected.publicationSummary ? <div className="tdw-audit-summary"><CheckCircle2 /><span><b>{selected.publicationSummary.coverageAudit.id}</b><small>Requirement Trace {selected.publicationSummary.coverageAudit.statistics.coveredBasis}/{selected.publicationSummary.coverageAudit.statistics.totalBasis} · Blockers {selected.publicationSummary.coverageAudit.blockerCount}</small></span></div> : <p className="tdw-muted">该版本没有新版发布统计快照。</p>}</section>
        <section><h4>版本 Diff</h4><div className="tdw-compare"><GitCompareArrows /><select defaultValue="" onChange={async event => event.target.value && setDiff((await api.diffLibraryVersions(projectId, event.target.value, selected.id)).changes)}><option value="">选择起始版本</option>{versions.filter(item => item.id !== selected.id).map(item => <option key={item.id} value={item.id}>V{item.version} · {item.name}</option>)}</select></div>{diff && <div className="tdw-version-diff">{diff.length ? diff.map(item => <span key={item.caseId} className={item.change}><b>{item.change}</b><code>{item.caseId}</code></span>) : <p>成员一致。</p>}</div>}</section>
      </article>}
    </div>}
  </section>
}

function ReleaseStatistics({ version }: { version: TestCaseLibraryVersion }) {
  const proposal = version.publicationSummary?.proposalStatistics
  const dimensions = version.publicationSummary?.dimensionStatistics
  return <><div className="tdw-release-kpis"><span><small>正式用例数</small><b>{version.members.length}</b></span></div><div className="tdw-dimension-stats">{(['functional', 'performance', 'stability', 'compatibility', 'security'] as const).map(key => <span key={key}><i>{dimensions?.[key] ?? 0}</i>{key}</span>)}</div><code className="tdw-release-hash">SHA-256 {version.contentSha256}</code></>
}

type FrozenMember = TestCaseLibraryVersion['members'][number]
function memberMethods(member: FrozenMember): TestExecutionMethod[] { return member.frozenExecutionMethods?.length ? member.frozenExecutionMethods : member.frozenContent.executionMethods }
