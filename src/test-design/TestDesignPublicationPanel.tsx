import { CheckCircle2, FileCheck2, GitCompareArrows, LockKeyhole, PackageCheck, Rocket, Send, ShieldAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import * as api from './api'
import type { ExecutionReadinessOverrideInput, LibraryExecutionHandoff, LibraryTestCase, LibraryTestSuiteVersion, TestCaseLibraryVersion, TestDesignWorkflowRun, TestExecutionMode } from './types'

type PublicationProps = {
  projectId: string
  run?: TestDesignWorkflowRun | null
  cases: LibraryTestCase[]
  versions: TestCaseLibraryVersion[]
  suites: LibraryTestSuiteVersion[]
  handoffs: LibraryExecutionHandoff[]
  busy: boolean
  onPublish?: (name: string) => void
  onHandoff: (version: TestCaseLibraryVersion, mode: TestExecutionMode, suiteVersionId?: string, impactedCaseIds?: string[], executionReadinessOverrides?: ExecutionReadinessOverrideInput[]) => void
}

export function TestDesignPublicationPanel({ projectId, run, cases, versions, suites, handoffs, busy, onPublish, onHandoff }: PublicationProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = versions.find(item => item.id === selectedId) ?? versions[0]
  const [publishName, setPublishName] = useState(run ? `测试用例库 · ${new Date().toLocaleDateString('zh-CN')}` : '')
  const [mode, setMode] = useState<TestExecutionMode>('smoke')
  const [suiteId, setSuiteId] = useState('')
  const [impacted, setImpacted] = useState('')
  const [diff, setDiff] = useState<Array<{ caseId: string; change: string }> | null>(null)
  const [overrideReasons, setOverrideReasons] = useState<Record<string, string>>({})
  const audit = run ? [...run.coverageAudits].reverse().find(item => item.status === 'valid') : undefined
  const publishBlockers = run ? [
      !audit ? 'Coverage Audit 尚未通过' : '',
    run.testCases.some(item => !item.tombstonedAt && item.reviewState !== 'approved') ? '候选用例未全部批准' : '',
    run.caseChangeProposals.some(item => item.decision === 'pending') ? 'Proposal 尚未全部处置' : '',
    !audit ? 'Coverage Audit 未通过或已失效' : '',
    audit?.blockers.length ? `Coverage Audit 存在 ${audit.blockers.length} 个阻断项` : '',
  ].filter(Boolean) : []
  const eligibleSuites = suites.filter(item => item.status !== 'deprecated' && item.compatibilityStatus !== 'migration_required' && item.testCaseLibraryVersionId === selected?.id && item.suiteType === mode)
  const selectedSuite = eligibleSuites.find(item => item.id === suiteId)
  const selectedMemberIds = useMemo(() => {
    const ids = new Set(mode === 'full' ? selected?.members.map(item => item.caseId) ?? [] : selectedSuite?.members.map(item => item.caseId) ?? [])
    if (mode === 'regression') impacted.split(',').map(item => item.trim()).filter(Boolean).forEach(caseId => ids.add(caseId))
    return ids
  }, [impacted, mode, selected, selectedSuite])
  const selectedHandoffMembers = selected?.members.filter(item => selectedMemberIds.has(item.caseId)) ?? []
  const blockedMembers = selectedHandoffMembers.filter(item => item.executionReadiness === 'blocked')
  const confirmationMembers = selectedHandoffMembers.filter(item => item.executionReadiness === 'needs_confirmation')
  const overrideInputs = confirmationMembers.map(item => ({ caseId: item.caseId, revision: item.revision, reason: overrideReasons[`${item.caseId}:${item.revision}`]?.trim() ?? '' }))

  return <section className="tdw-panel tdw-publications">
    <header><div><span className="tdw-icon"><PackageCheck /></span><div><h2>{run ? '发布 / Execution Handoff' : '用例库发布记录'}</h2><p>用例库版本、套件版本与 Handoff 都是不可变资产，Hash 和 Workspace 投影由服务端固定。</p></div></div>{run && <span className={`tdw-badge ${publishBlockers.length ? 'warning' : 'success'}`}>{publishBlockers.length ? `${publishBlockers.length} 项门禁未满足` : '发布门禁已满足'}</span>}</header>
    {run && <section className="tdw-publish-gate"><div><LockKeyhole /><span><b>发布正式测试用例库版本</b><small>将已处置 Proposal 合入项目级用例库：复用不复制，修改不换 ID，新增才创建 ID，删除只废弃。</small></span></div><div className="tdw-publish-form"><input value={publishName} onChange={event => setPublishName(event.target.value)} placeholder="用例库版本名称" /><button className="primary" disabled={busy || publishBlockers.length > 0 || !publishName.trim()} onClick={() => onPublish?.(publishName.trim())}><Rocket />发布版本</button></div>{publishBlockers.length ? <ul>{publishBlockers.map(item => <li key={item}><ShieldAlert />{item}</li>)}</ul> : <p className="success"><CheckCircle2 />候选审核、Proposal 处置与 Coverage Audit 均已通过。</p>}</section>}
    {!versions.length ? <div className="tdw-empty"><PackageCheck /><b>尚未发布正式用例库版本</b><span>从设计任务完成 Proposal 处置与 Coverage Audit 后发布。</span></div> : <div className="tdw-master-detail">
      <div className="tdw-master-list">{versions.map(item => <button key={item.id} className={selected?.id === item.id ? 'active' : ''} onClick={() => { setSelectedId(item.id); setSuiteId(''); setOverrideReasons({}); setDiff(null) }}><span className="tdw-operation reuse">V{item.version}</span><b>{item.name}</b><small>{item.members.length} 条正式用例 · {item.projection.status}</small><footer><code>{item.id}</code><em>{new Date(item.publishedAt).toLocaleDateString('zh-CN')}</em></footer></button>)}</div>
      {selected && <article className="tdw-release-detail">
        <header><div><span className={`tdw-status ${selected.projection.status === 'succeeded' ? 'active' : 'deprecated'}`}>{selected.projection.status}</span><h3>{selected.name} · V{selected.version}</h3><code>{selected.id}</code></div><span>{selected.publishedBy} · {new Date(selected.publishedAt).toLocaleString('zh-CN')}</span></header>
        <ReleaseStatistics version={selected} />
        <section><h4>冻结成员详情</h4><div className="tdw-projection">{selected.members.map(member => { const currentRevision = cases.find(item => item.id === member.caseId)?.currentRevision; return <article key={`${member.caseId}:${member.revision}`}><FileCheck2 /><span><b>{member.frozenContent.title}</b><code>Case ID {member.caseId}</code><code>冻结 Revision r{member.revision} · 当前 Revision r{currentRevision ?? '—'}</code><code>冻结内容 Hash {member.contentSha256}</code><small>{member.frozenContent.dimension} · {member.frozenContent.priority} · {member.frozenContent.executionSpec?.method} · {member.executionReadiness}</small>{currentRevision && currentRevision > member.revision && <small>该用例已有较新 Revision，当前套件仍使用冻结的 Revision r{member.revision}</small>}</span></article> })}</div></section>
        <section><h4>Coverage Audit</h4>{selected.publicationSummary ? <div className="tdw-audit-summary"><CheckCircle2 /><span><b>{selected.publicationSummary.coverageAudit.id}</b><small>Requirement {selected.publicationSummary.coverageAudit.statistics.coveredBasis}/{selected.publicationSummary.coverageAudit.statistics.totalBasis} · Blockers {selected.publicationSummary.coverageAudit.blockerCount}</small></span></div> : <p className="tdw-muted">该版本没有新版发布统计快照。</p>}</section>
        <section><h4>Workspace 投影</h4><div className="tdw-projection">{selected.projection.files.map(file => <article key={file.logicalPath}><FileCheck2 /><span><b>{file.logicalPath}</b><code>{file.contentSha256}</code></span></article>)}</div></section>
        <section><h4>版本 Diff</h4><div className="tdw-compare"><GitCompareArrows /><select defaultValue="" onChange={async event => event.target.value && setDiff((await api.diffLibraryVersions(projectId, event.target.value, selected.id)).changes)}><option value="">选择起始版本</option>{versions.filter(item => item.id !== selected.id).map(item => <option key={item.id} value={item.id}>V{item.version} · {item.name}</option>)}</select></div>{diff && <div className="tdw-version-diff">{diff.length ? diff.map(item => <span key={item.caseId} className={item.change}><b>{item.change}</b><code>{item.caseId}</code></span>) : <p>成员一致。</p>}</div>}</section>
        <section className="tdw-handoff-box"><h4>生成 Execution Handoff</h4><p>冻结 Case Revision、维度、executionSpec、执行方式、选择原因、追溯、内容 Hash 与人工 readiness 覆盖记录。</p><div><select value={mode} onChange={event => { setMode(event.target.value as TestExecutionMode); setSuiteId(''); setOverrideReasons({}) }}><option value="smoke">smoke</option><option value="regression">regression</option><option value="full">full</option><option value="custom">custom</option></select>{mode !== 'full' && <select value={suiteId} onChange={event => { setSuiteId(event.target.value); setOverrideReasons({}) }}><option value="">选择当前用例库版本的 {mode} 套件版本</option>{eligibleSuites.map(item => <option key={item.id} value={item.id}>{item.name} V{item.version}</option>)}</select>}{mode === 'regression' && <input value={impacted} onChange={event => setImpacted(event.target.value)} placeholder="受影响 Case ID，逗号分隔（可选）" />}</div>
          {blockedMembers.length > 0 && <p className="td-confirmation-note"><ShieldAlert />{blockedMembers.map(item => `${item.caseId} r${item.revision}`).join('、')} 为 blocked，不能进入 Handoff。</p>}
          {confirmationMembers.length > 0 && <div className="tdw-readiness-overrides"><p className="td-confirmation-note"><ShieldAlert />以下 needs_confirmation 成员默认被服务端阻断；如需人工覆盖，必须逐条填写原因。</p>{confirmationMembers.map(member => { const key = `${member.caseId}:${member.revision}`; return <label key={key}><span>{member.frozenContent.title}<code>{member.caseId} · r{member.revision}</code></span><input value={overrideReasons[key] ?? ''} onChange={event => setOverrideReasons(current => ({ ...current, [key]: event.target.value }))} placeholder="人工覆盖原因（必填）" /></label> })}</div>}
          <button className="primary" disabled={busy || (mode !== 'full' && !suiteId) || blockedMembers.length > 0 || overrideInputs.some(item => !item.reason)} onClick={() => onHandoff(selected, mode, suiteId || undefined, impacted.split(',').map(item => item.trim()).filter(Boolean), overrideInputs.length ? overrideInputs : undefined)}><Send />生成 Handoff</button>
        </section>
      </article>}
    </div>}
    {handoffs.length > 0 && <section className="tdw-handoff-history"><h3>Execution Handoff 记录</h3>{handoffs.map(item => <article key={item.id}><Send /><span><b>{item.mode} · {item.members.length} 个冻结成员</b><small>{item.testCaseLibraryVersionId}{item.suiteVersionId ? ` · ${item.suiteVersionId}` : ''}</small><code>{item.contentSha256}</code></span><time>{new Date(item.createdAt).toLocaleString('zh-CN')}</time></article>)}</section>}
  </section>
}

function ReleaseStatistics({ version }: { version: TestCaseLibraryVersion }) {
  const proposal = version.publicationSummary?.proposalStatistics
  const dimensions = version.publicationSummary?.dimensionStatistics
  return <><div className="tdw-release-kpis"><span><small>正式用例数</small><b>{version.members.length}</b></span>{(['reuse', 'update', 'create', 'deprecate'] as const).map(key => <span key={key}><small>{({ reuse: '复用', update: '修改', create: '新增', deprecate: '废弃' } as const)[key]}</small><b>{proposal?.[key] ?? '—'}</b></span>)}</div><div className="tdw-dimension-stats">{(['functional', 'performance', 'stability', 'compatibility'] as const).map(key => <span key={key}><i>{dimensions?.[key] ?? 0}</i>{key}</span>)}</div><code className="tdw-release-hash">SHA-256 {version.contentSha256}</code></>
}
