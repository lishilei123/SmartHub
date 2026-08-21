import { CheckCircle2, FileCheck2, GitCompareArrows, LockKeyhole, PackageCheck, Rocket, Send, ShieldAlert } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as api from './api'
import type { ExecutionReadinessOverrideInput, LibraryExecutionHandoff, LibraryTestCase, LibraryTestSuiteVersion, TestCaseLibraryVersion, TestDesignWorkflowRun, TestExecutionMethod, TestExecutionMode } from './types'

type PublicationProps = {
  projectId: string
  run?: TestDesignWorkflowRun | null
  cases: LibraryTestCase[]
  versions: TestCaseLibraryVersion[]
  suites: LibraryTestSuiteVersion[]
  handoffs: LibraryExecutionHandoff[]
  busy: boolean
  handoffFocusRequest?: number
  onPublish?: (name: string) => Promise<TestCaseLibraryVersion | undefined>
  onHandoff: (version: TestCaseLibraryVersion, mode: TestExecutionMode, suiteVersionId?: string, impactedCaseIds?: string[], executionReadinessOverrides?: ExecutionReadinessOverrideInput[]) => void
}

export function TestDesignPublicationPanel({ projectId, run, cases, versions, suites, handoffs, busy, handoffFocusRequest, onPublish, onHandoff }: PublicationProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = versions.find(item => item.id === selectedId) ?? versions[0]
  const [publishName, setPublishName] = useState(run ? `测试用例库 · ${new Date().toLocaleDateString('zh-CN')}` : '')
  const [mode, setMode] = useState<TestExecutionMode>('smoke')
  const [suiteId, setSuiteId] = useState('')
  const [impacted, setImpacted] = useState('')
  const [diff, setDiff] = useState<Array<{ caseId: string; change: string }> | null>(null)
  const [overrideReasons, setOverrideReasons] = useState<Record<string, string>>({})
  const handoffRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!handoffFocusRequest) return
    setMode('full'); setSuiteId(''); setImpacted(''); setOverrideReasons({})
    const frame = window.requestAnimationFrame(() => handoffRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    return () => window.cancelAnimationFrame(frame)
  }, [handoffFocusRequest])
  const audit = run?.coverageAudits.at(-1)
  const publicationAuditBlockers = audit?.blockers.filter(item => item.resolution !== 'execution_handoff') ?? []
  const executionHandoffBlockerCount = audit?.blockers.filter(item => item.resolution === 'execution_handoff').length ?? 0
  const publishBlockers = run ? [
    !audit ? '尚未执行 Coverage Audit' : '',
    audit?.status !== 'valid' ? '最新 Coverage Audit 已失效，请重新检查' : '',
    run.testCases.some(item => !item.tombstonedAt && item.reviewState !== 'approved') ? '候选用例未全部审核通过' : '',
    run.caseChangeProposals.some(item => item.decision === 'pending' && (item.operation === 'deprecate' || item.operation === 'reference')) ? '仍有废弃或仅参考变更待确认' : '',
    run.findings.some(item => item.severity === 'blocker' && !['resolved', 'rejected'].includes(item.state)) ? '仍有阻断级设计问题未处理' : '',
    run.confirmationItems.some(item => item.blocker && item.impactStage !== 'handoff' && !['resolved', 'rejected'].includes(item.state)) ? '仍有阻断发布的待确认项未处理' : '',
    publicationAuditBlockers.length ? `Coverage Audit 存在 ${publicationAuditBlockers.length} 个语义发布阻断项` : '',
  ].filter(Boolean) : []
  const eligibleSuites = suites.filter(item => item.status !== 'deprecated' && item.compatibilityStatus !== 'migration_required' && item.testCaseLibraryVersionId === selected?.id && item.suiteType === mode)
  const selectedSuite = eligibleSuites.find(item => item.id === suiteId)
  const selectedMemberIds = useMemo(() => {
    const ids = new Set(mode === 'full' ? selected?.members.map(item => item.caseId) ?? [] : selectedSuite?.members.map(item => item.caseId) ?? [])
    if (mode === 'regression') impacted.split(',').map(item => item.trim()).filter(Boolean).forEach(caseId => ids.add(caseId))
    return ids
  }, [impacted, mode, selected, selectedSuite])
  const selectedHandoffMembers = selected?.members.filter(item => selectedMemberIds.has(item.caseId)) ?? []
  const handoffExecutions = selectedHandoffMembers.flatMap(member => selectedMethods(member, mode, selectedSuite).map(method => ({ member, method, readiness: methodReadiness(member, method) })))
  const blockedMembers = handoffExecutions.filter(item => item.readiness === 'blocked')
  const confirmationMembers = handoffExecutions.filter(item => item.readiness === 'needs_confirmation')
  const overrideInputs = confirmationMembers.map(item => ({ caseId: item.member.caseId, revision: item.member.revision, method: item.method, reason: overrideReasons[`${item.member.caseId}:${item.member.revision}:${item.method}`]?.trim() ?? '' }))
  const publish = async () => {
    const version = await onPublish?.(publishName.trim())
    if (version) { setSelectedId(version.id); setPublishName('') }
  }

  return <section className="tdw-panel tdw-publications">
    <header><div><span className="tdw-icon"><PackageCheck /></span><div><h2>{run ? '确认并发布' : '用例库发布记录'}</h2><p>正式用例版本、测试套件和执行交接均由服务端创建为不可变资产。</p></div></div>{run && <span className={`tdw-badge ${publishBlockers.length ? 'warning' : 'success'}`}>{publishBlockers.length ? `${publishBlockers.length} 项门禁未满足` : '发布门禁已满足'}</span>}</header>
    {run && <section className="tdw-publish-gate"><div><LockKeyhole /><span><b>发布正式测试用例版本</b><small>Service 已自动处理复用、新增和修改 Proposal；仅废弃或必要的仅参考变更需要额外确认。Execution Handoff 会在发布后单独检查就绪条件。</small></span></div><div className="tdw-publish-form"><input value={publishName} onChange={event => setPublishName(event.target.value)} placeholder="正式用例版本名称" /><button className="primary" disabled={busy || publishBlockers.length > 0 || !publishName.trim()} onClick={() => void publish().catch(() => undefined)}><Rocket />确认发布</button></div>{publishBlockers.length ? <ul>{publishBlockers.map(item => <li key={item}><ShieldAlert />{item}</li>)}</ul> : <p className="success"><CheckCircle2 />测试用例审核与覆盖检查均已通过，没有重复的 Proposal 人工确认。{executionHandoffBlockerCount ? `另有 ${executionHandoffBlockerCount} 项执行就绪问题，仅在执行交接前处理。` : ''}</p>}</section>}
    {!versions.length ? <div className="tdw-empty"><PackageCheck /><b>尚未发布正式用例库版本</b><span>从设计任务完成 Proposal 处置与 Coverage Audit 后发布。</span></div> : <div className="tdw-master-detail">
      <div className="tdw-master-list">{versions.map(item => <button key={item.id} className={selected?.id === item.id ? 'active' : ''} onClick={() => { setSelectedId(item.id); setSuiteId(''); setOverrideReasons({}); setDiff(null) }}><span className="tdw-operation reuse">V{item.version}</span><b>{item.name}</b><small>{item.members.length} 条正式用例 · {item.dataRequirementSet?.requirements.length ?? 0} 项数据需求 · {item.projection.status}</small><footer><code>{item.id}</code><em>{new Date(item.publishedAt).toLocaleDateString('zh-CN')}</em></footer></button>)}</div>
      {selected && <article className="tdw-release-detail">
        <header><div><span className={`tdw-status ${selected.projection.status === 'succeeded' ? 'active' : 'deprecated'}`}>{selected.projection.status}</span><h3>{selected.name} · V{selected.version}</h3><code>{selected.id}</code></div><span>{selected.publishedBy} · {new Date(selected.publishedAt).toLocaleString('zh-CN')}</span></header>
        <ReleaseStatistics version={selected} />
        <section><h4>冻结成员详情</h4><div className="tdw-projection">{selected.members.map(member => { const currentRevision = cases.find(item => item.id === member.caseId)?.currentRevision; return <article key={`${member.caseId}:${member.revision}`}><FileCheck2 /><span><b>{member.frozenContent.title}</b><code>Case ID {member.caseId}</code><code>冻结 Revision r{member.revision} · 当前 Revision r{currentRevision ?? '—'}</code><code>冻结内容 Hash {member.contentSha256}</code><small>{member.frozenContent.dimension} · {member.frozenContent.priority} · {memberMethods(member).join(' + ')} · {member.executionReadiness}</small>{currentRevision && currentRevision > member.revision && <small>该用例已有较新 Revision，当前套件仍使用冻结的 Revision r{member.revision}</small>}</span></article> })}</div></section>
        <section><h4>Coverage Audit</h4>{selected.publicationSummary ? <div className="tdw-audit-summary"><CheckCircle2 /><span><b>{selected.publicationSummary.coverageAudit.id}</b><small>Requirement {selected.publicationSummary.coverageAudit.statistics.coveredBasis}/{selected.publicationSummary.coverageAudit.statistics.totalBasis} · Blockers {selected.publicationSummary.coverageAudit.blockerCount}</small></span></div> : <p className="tdw-muted">该版本没有新版发布统计快照。</p>}</section>
        <section><h4>Workspace 投影</h4><div className="tdw-projection">{selected.projection.files.map(file => <article key={file.logicalPath}><FileCheck2 /><span><b>{file.logicalPath}</b><code>{file.contentSha256}</code></span></article>)}</div></section>
        <section><h4>版本 Diff</h4><div className="tdw-compare"><GitCompareArrows /><select defaultValue="" onChange={async event => event.target.value && setDiff((await api.diffLibraryVersions(projectId, event.target.value, selected.id)).changes)}><option value="">选择起始版本</option>{versions.filter(item => item.id !== selected.id).map(item => <option key={item.id} value={item.id}>V{item.version} · {item.name}</option>)}</select></div>{diff && <div className="tdw-version-diff">{diff.length ? diff.map(item => <span key={item.caseId} className={item.change}><b>{item.change}</b><code>{item.caseId}</code></span>) : <p>成员一致。</p>}</div>}</section>
        <section ref={handoffRef} className="tdw-handoff-box"><h4>创建执行交接</h4><p>冻结测试用例 Revision、执行配置、追溯、内容 Hash 和独立测试数据需求快照；UI 与 API 会从同一冻结 Revision 分别展开为方法级交接项。实际 Fixture / 生成器 / 数据引用到创建执行 Run 时再绑定。</p><p className="td-confirmation-note"><ShieldAlert />此处可填写待确认执行方式的人工覆盖原因；UI 入口、API 契约、环境或阈值等实际执行配置，需要通过新 Revision 补全后重新发布。</p><div><select value={mode} onChange={event => { setMode(event.target.value as TestExecutionMode); setSuiteId(''); setOverrideReasons({}) }}><option value="smoke">冒烟测试</option><option value="regression">回归测试</option><option value="full">全量测试</option><option value="custom">自定义测试</option></select>{mode !== 'full' && <select value={suiteId} onChange={event => { setSuiteId(event.target.value); setOverrideReasons({}) }}><option value="">选择当前正式用例版本的{modeLabel(mode)}套件</option>{eligibleSuites.map(item => <option key={item.id} value={item.id}>{item.name} V{item.version}</option>)}</select>}{mode === 'regression' && <input value={impacted} onChange={event => setImpacted(event.target.value)} placeholder="受影响测试用例 ID，逗号分隔（可选）" />}</div>
          {mode !== 'full' && !eligibleSuites.length && <p className="td-confirmation-note"><ShieldAlert />当前正式用例版本没有兼容的{modeLabel(mode)}套件。请先在“测试套件”创建或选择兼容的套件版本；系统不会自动创建套件。</p>}
          {blockedMembers.length > 0 && <p className="td-confirmation-note"><ShieldAlert />{blockedMembers.map(item => `${item.member.caseId} r${item.member.revision} / ${item.method}`).join('、')} 为 blocked，不能进入 Handoff。</p>}
          {confirmationMembers.length > 0 && <div className="tdw-readiness-overrides"><p className="td-confirmation-note"><ShieldAlert />以下 needs_confirmation 成员默认被服务端阻断；同一 Case 的 UI/API 会按执行方式分别填写人工覆盖原因。</p>{confirmationMembers.map(item => { const key = `${item.member.caseId}:${item.member.revision}:${item.method}`; return <label key={key}><span>{item.member.frozenContent.title}<code>{item.member.caseId} · r{item.member.revision} · {item.method}</code></span><input value={overrideReasons[key] ?? ''} onChange={event => setOverrideReasons(current => ({ ...current, [key]: event.target.value }))} placeholder="人工覆盖原因（必填）" /></label> })}</div>}
          <button className="primary" disabled={busy || (mode !== 'full' && !suiteId) || blockedMembers.length > 0 || overrideInputs.some(item => !item.reason)} onClick={() => onHandoff(selected, mode, suiteId || undefined, impacted.split(',').map(item => item.trim()).filter(Boolean), overrideInputs.length ? overrideInputs : undefined)}><Send />创建执行交接</button>
        </section>
      </article>}
    </div>}
    {handoffs.length > 0 && <section className="tdw-handoff-history"><h3>执行交接记录</h3>{handoffs.map(item => <article key={item.id}><Send /><span><b>{modeLabel(item.mode)} · {item.members.length} 个冻结成员 · {item.testDataSnapshot?.requirements.length ?? 0} 项数据需求</b><small>{item.testCaseLibraryVersionId}{item.suiteVersionId ? ` · ${item.suiteVersionId}` : ''}</small><code>{item.contentSha256}</code></span><time>{new Date(item.createdAt).toLocaleString('zh-CN')}</time></article>)}</section>}
  </section>
}

function ReleaseStatistics({ version }: { version: TestCaseLibraryVersion }) {
  const proposal = version.publicationSummary?.proposalStatistics
  const dimensions = version.publicationSummary?.dimensionStatistics
  return <><div className="tdw-release-kpis"><span><small>正式用例数</small><b>{version.members.length}</b></span><span><small>数据需求</small><b>{version.dataRequirementSet?.requirements.length ?? 0}</b></span>{(['reuse', 'update', 'create', 'deprecate'] as const).map(key => <span key={key}><small>{({ reuse: '复用', update: '修改', create: '新增', deprecate: '废弃' } as const)[key]}</small><b>{proposal?.[key] ?? '—'}</b></span>)}</div><div className="tdw-dimension-stats">{(['functional', 'performance', 'stability', 'compatibility'] as const).map(key => <span key={key}><i>{dimensions?.[key] ?? 0}</i>{key}</span>)}</div><code className="tdw-release-hash">SHA-256 {version.contentSha256}</code></>
}

function modeLabel(value: TestExecutionMode) { return ({ smoke: '冒烟测试', regression: '回归测试', full: '全量测试', custom: '自定义测试' } as const)[value] }
type FrozenMember = TestCaseLibraryVersion['members'][number]
function memberMethods(member: FrozenMember): TestExecutionMethod[] { if (member.frozenExecutionMethods?.length) return member.frozenExecutionMethods; if (member.frozenContent.executionMethods?.length) return member.frozenContent.executionMethods.map(item => item.method); return member.frozenContent.executionSpec ? [member.frozenContent.executionSpec.method] : [] }
function selectedMethods(member: FrozenMember, mode: TestExecutionMode, suite?: LibraryTestSuiteVersion): TestExecutionMethod[] { if (mode === 'full') return memberMethods(member); const suiteMember = suite?.members.find(item => item.caseId === member.caseId); if (!suiteMember) return memberMethods(member); return suiteMember.executionMethods?.length ? suiteMember.executionMethods : suiteMember.executionMethod ? [suiteMember.executionMethod] : memberMethods(member) }
function methodReadiness(member: FrozenMember, method: TestExecutionMethod) { const configuration = member.frozenContent.executionMethods?.find(item => item.method === method); return configuration?.executionReadiness ?? (member.frozenContent.executionSpec?.method === method ? member.frozenContent.executionSpec.executionReadiness : 'needs_confirmation') }
