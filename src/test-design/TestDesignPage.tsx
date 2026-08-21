import { Activity, AlertTriangle, Bot, Boxes, CheckCircle2, ClipboardCheck, ClipboardList, FolderOpen, Library, LockKeyhole, PackageCheck, RefreshCw, Rocket, Settings2, ShieldAlert, TestTube2, Workflow, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectVersion } from '../project-version-api'
import { CoverageAuditPanel } from './CoverageAuditPanel'
import { TestCaseLibraryPanel } from './TestCaseLibraryPanel'
import { TestCasePanel } from './TestCasePanel'
import { TestDesignCreatePanel } from './TestDesignCreatePanel'
import { TestDesignPublicationPanel } from './TestDesignPublicationPanel'
import { TestDesignRunPanel } from './TestDesignRunPanel'
import { TestSuiteLibraryPanel } from './TestSuiteLibraryPanel'
import { useTestDesign } from './hooks/useTestDesign'
import type { AgentEvent, TestDesignCase, TestDesignWorkflowRun } from './types'
import './test-design.css'

type Notify = (message: string, tone?: 'success' | 'error' | 'warning') => void
type Entry = 'designs' | 'library' | 'suites' | 'releases'
type DesignTab = 'audit' | 'details'

const entries: Array<{ key: Entry; label: string; icon: typeof ClipboardList }> = [{ key: 'designs', label: '设计任务', icon: ClipboardList }, { key: 'library', label: '测试用例库', icon: Library }, { key: 'suites', label: '测试套件', icon: Workflow }, { key: 'releases', label: '发布记录', icon: Rocket }]
const designTabs: Array<{ key: DesignTab; label: string; icon: typeof ClipboardList }> = [{ key: 'audit', label: 'Coverage 状态', icon: Activity }, { key: 'details', label: '运行详情', icon: Settings2 }]

export function TestDesignPage({ projectVersion, onManageVersions, notify, embedded = false, linkedDesignId, linkedRunId, initialCreate = false }: { projectVersion: ProjectVersion | null; onManageVersions: () => void; notify: Notify; embedded?: boolean; linkedDesignId?: string; linkedRunId?: string; initialCreate?: boolean }) {
  const routedEntry = new URL(window.location.href).searchParams.get('testDesignEntry')
  const model = useTestDesign(projectVersion?.id, notify); const [entry, setEntry] = useState<Entry>(routedEntry === 'library' ? 'library' : 'designs'); const [tab, setTab] = useState<DesignTab>('details'); const [creating, setCreating] = useState(initialCreate); const autoOpeningId = useRef(''); const linkedOpeningId = useRef(''); const linkedOpenedTargetId = useRef('')
  const linkedTargetId = linkedDesignId && linkedRunId ? `${linkedDesignId}:${linkedRunId}` : ''
  useEffect(() => {
    if (!linkedDesignId || !linkedRunId) { linkedOpenedTargetId.current = ''; return }
    if (linkedOpenedTargetId.current === linkedTargetId || linkedOpeningId.current === linkedTargetId) return
    linkedOpeningId.current = linkedTargetId
    void model.openLinkedRun(linkedDesignId, linkedRunId).then(() => { linkedOpenedTargetId.current = linkedTargetId }).catch(() => undefined).finally(() => { linkedOpeningId.current = '' })
  }, [linkedDesignId, linkedRunId, linkedTargetId, model.openLinkedRun])
  useEffect(() => { const candidate = model.designs[0]; if (embedded || linkedTargetId || !candidate || model.design || creating || autoOpeningId.current === candidate.id) return; autoOpeningId.current = candidate.id; void model.openDesign(candidate).finally(() => { autoOpeningId.current = '' }) }, [creating, embedded, linkedTargetId, model.design, model.designs[0]?.id])
  if (!projectVersion) return <main className="td2-shell"><section className="td2-card td2-empty"><Boxes /><h2>请先选择 ProjectVersion</h2><p>测试设计的 Requirement Release、Workspace 与正式产物都按项目版本隔离。</p><button className="td2-button primary" onClick={onManageVersions}>管理项目版本</button></section></main>
  if (embedded && (!model.inputs || (linkedTargetId && (!model.design || !model.run)))) return <EmbeddedTestDesignLoading contextReady={Boolean(model.inputs)} error={model.error} onRetry={linkedDesignId && linkedRunId ? () => { void model.openLinkedRun(linkedDesignId, linkedRunId).catch(() => undefined) } : undefined} />
  if (!model.inputs) return <main className="td2-shell"><section className="td2-card td2-empty"><RefreshCw className="spin" /><h2>正在读取测试设计上下文</h2><p>检查正式需求版本、测试用例库、测试套件与 PlanningAgent 配置。</p>{model.error && <div className="td2-error">{model.error}</div>}</section></main>
  const projectId = model.inputs.projectVersion.projectId
  if (embedded) return <section className="tdw-embedded" aria-label="测试用例">
    {model.error && <div className="tdw-global-error"><b>操作未完成</b><span>{model.error}</span></div>}
    {entry === 'designs' && <DesignWorkspace creating={creating} tab={tab} setTab={setTab} model={model} onCreateDone={() => setCreating(false)} />}
    {entry === 'library' && <div className="tdw-content"><TestCaseLibraryPanel projectId={projectId} cases={model.libraryCases} versions={model.libraryVersions} suiteDrafts={model.suiteDrafts} suiteVersions={model.suiteVersions} initialCaseId={new URL(window.location.href).searchParams.get('libraryCaseId') ?? undefined} busy={Boolean(model.busy)} onCreate={(content, reason) => model.createLibraryCase(content, reason)} onEdit={(testCase, content, reason, traceability) => model.editLibraryCase(testCase, content, reason, traceability)} onCopy={testCase => void model.copyLibraryCase(testCase)} onDeprecate={(testCase, reason) => void model.deprecateLibraryCase(testCase, reason)} onSaveSuite={(draft, value) => void model.saveSuiteDraft(draft, value)} /></div>}
    {entry === 'suites' && <div className="tdw-content"><TestSuiteLibraryPanel projectId={projectId} cases={model.libraryCases} libraryVersions={model.libraryVersions} drafts={model.suiteDrafts} versions={model.suiteVersions} busy={Boolean(model.busy)} onSave={(draft, value) => void model.saveSuiteDraft(draft, value)} onPublish={draft => void model.publishSuite(draft)} onDeprecate={version => void model.deprecateSuite(version)} /></div>}
    {entry === 'releases' && <div className="tdw-content"><TestDesignPublicationPanel projectId={projectId} cases={model.libraryCases} versions={model.libraryVersions} suites={model.suiteVersions} handoffs={model.handoffs} busy={Boolean(model.busy)} onHandoff={(version, mode, suiteId, impacted, overrides) => void model.handoff(version, mode, suiteId, impacted, overrides)} /></div>}
  </section>
  return <main className="tdw-page"><header className="tdw-header"><div className="tdw-title"><span><TestTube2 /></span><div><h1>测试设计</h1><p>{projectVersion.name} · PlanningAgent</p></div></div><nav>{entries.map(item => <button key={item.key} className={entry === item.key ? 'active' : ''} onClick={() => { setEntry(item.key); setCreating(false) }}><item.icon />{item.label}</button>)}</nav><div className="tdw-header-context">{entry === 'designs' ? <span className={model.inputs.requirementRelease ? 'bound' : 'missing'}><LockKeyhole /><small>正式需求</small><b>{model.inputs.requirementRelease ? '已绑定' : '未绑定'}</b></span> : <span className={model.inputs.requirementRelease ? 'bound' : 'missing'}><LockKeyhole /><small>Requirement Release</small><b>{model.inputs.requirementRelease?.id.slice(-10) ?? '未绑定'}</b></span>}<button onClick={onManageVersions}><Settings2 />项目版本</button></div></header>
    {model.error && <div className="tdw-global-error"><b>操作未完成</b><span>{model.error}</span></div>}
    <div className={`tdw-layout ${entry === 'designs' ? 'tdw-layout-designs' : ''}`}><WorkspaceSidebar entry={entry} model={model} selectedId={model.design?.id} onCreate={() => { setEntry('designs'); setCreating(true) }} onOpen={design => { setCreating(false); void model.openDesign(design) }} />
      <section className="tdw-main">{entry === 'designs' && <DesignWorkspace creating={creating} tab={tab} setTab={setTab} model={model} onCreateDone={() => setCreating(false)} />}{entry === 'library' && <div className="tdw-content"><TestCaseLibraryPanel projectId={projectId} cases={model.libraryCases} versions={model.libraryVersions} suiteDrafts={model.suiteDrafts} suiteVersions={model.suiteVersions} initialCaseId={new URL(window.location.href).searchParams.get('libraryCaseId') ?? undefined} busy={Boolean(model.busy)} onCreate={(content, reason) => model.createLibraryCase(content, reason)} onEdit={(testCase, content, reason, traceability) => model.editLibraryCase(testCase, content, reason, traceability)} onCopy={testCase => void model.copyLibraryCase(testCase)} onDeprecate={(testCase, reason) => void model.deprecateLibraryCase(testCase, reason)} onSaveSuite={(draft, value) => void model.saveSuiteDraft(draft, value)} /></div>}{entry === 'suites' && <div className="tdw-content"><TestSuiteLibraryPanel projectId={projectId} cases={model.libraryCases} libraryVersions={model.libraryVersions} drafts={model.suiteDrafts} versions={model.suiteVersions} busy={Boolean(model.busy)} onSave={(draft, value) => void model.saveSuiteDraft(draft, value)} onPublish={draft => void model.publishSuite(draft)} onDeprecate={version => void model.deprecateSuite(version)} /></div>}{entry === 'releases' && <div className="tdw-content"><TestDesignPublicationPanel projectId={projectId} cases={model.libraryCases} versions={model.libraryVersions} suites={model.suiteVersions} handoffs={model.handoffs} busy={Boolean(model.busy)} onHandoff={(version, mode, suiteId, impacted, overrides) => void model.handoff(version, mode, suiteId, impacted, overrides)} /></div>}</section>
      {entry !== 'designs' && <ContextSidebar entry={entry} model={model} />}
    </div>
  </main>
}

function DesignWorkspace({ creating, tab, setTab, model, onCreateDone }: { creating: boolean; tab: DesignTab; setTab: (tab: DesignTab) => void; model: ReturnType<typeof useTestDesign>; onCreateDone: () => void }) {
  const [handoffFocusRequest, setHandoffFocusRequest] = useState(0)
  const [createRequest, setCreateRequest] = useState(0)
  const [publishOpen, setPublishOpen] = useState(false)
  const openHandoff = () => { setPublishOpen(true); setHandoffFocusRequest(current => current + 1) }
  if (creating) return <div className="tdw-content"><TestDesignCreatePanel inputs={model.inputs!} busy={Boolean(model.busy)} onCancel={onCreateDone} onCreate={async input => { await model.create(input); onCreateDone() }} /></div>
  if (!model.design) return <div className="tdw-content"><section className="tdw-welcome"><div><Bot /><span><p>PlanningAgent</p><h2>等待正式需求</h2><p>正式需求版本发布后，Service 会自动创建测试设计并直接生成多场景测试用例与覆盖检查。</p></span></div><div className="tdw-pipeline">{['需求基线', '必要时人工澄清', 'AI 测试用例生成', '覆盖检查', '最终人工审核', '发布 / 执行交接'].map((item, index) => <span key={item}><i>{index + 1}</i>{item}</span>)}</div></section></div>
  const run = model.run
  if (!run) return <div className="tdw-content tdw-review-workspace"><DesignProgress run={null} versions={model.libraryVersions} /><section className="td2-card td2-empty"><Bot /><h2>尚未开始 AI 生成</h2><p>启动后，PlanningAgent 会基于已绑定的正式需求生成本次测试用例。</p><button className="td2-button primary" disabled={Boolean(model.busy)} onClick={() => void model.startRun().catch(() => undefined)}>启动 AI 生成</button></section><AdvancedInformation tab={tab} setTab={setTab} model={model} run={null} onOpenHandoff={openHandoff} /></div>
  const publicationBlockers = getPublicationBlockers(run)
  return <div className="tdw-content tdw-review-workspace">
    <RunHistoryPanel model={model} />
    <DesignProgress run={run} versions={model.libraryVersions} />
    {model.auditRetryError && <section className="tdw-audit-retry"><AlertTriangle /><span><b>覆盖检查需要重新执行</b><small>{model.auditRetryError}</small></span><button className="td2-button primary" disabled={Boolean(model.busy)} onClick={() => void model.reAudit()}>重新检查</button></section>}
    <PendingWorkPanel run={run} busy={Boolean(model.busy)} onReAudit={() => model.reAudit()} onCreate={() => setCreateRequest(current => current + 1)} />
    <TestCasePanel run={run} busy={Boolean(model.busy)} createRequest={createRequest} onBatchApprove={() => model.reviewCases()} onResynthesize={() => model.resynthesize()} onCreate={content => model.createCase(content)} onEdit={(caseId, content, reason) => model.editCase(caseId, content, reason)} onDelete={caseId => model.removeCase(caseId)} onReview={(caseId, decision, revision, comment) => model.reviewCase(caseId, decision, revision, comment)} />
    <ReviewAndPublishBar run={run} versions={model.libraryVersions} busy={Boolean(model.busy)} blockers={publicationBlockers} onOpenPublish={() => setPublishOpen(true)} />
    <AdvancedInformation tab={tab} setTab={setTab} model={model} run={run} onOpenHandoff={openHandoff} />
    {publishOpen && <div className="tdw-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setPublishOpen(false) }}><section className="tdw-modal wide tdw-workspace-modal" role="dialog" aria-modal="true" aria-label="确认并发布"><header><div><Rocket /><span><b>确认并发布</b><small>发布成功后可直接创建执行交接。</small></span></div><button aria-label="关闭" onClick={() => setPublishOpen(false)}><X /></button></header><TestDesignPublicationPanel projectId={model.inputs!.projectVersion.projectId} run={run} cases={model.libraryCases} versions={model.libraryVersions} suites={model.suiteVersions} handoffs={model.handoffs} busy={Boolean(model.busy)} handoffFocusRequest={handoffFocusRequest} onPublish={name => model.publish(name)} onHandoff={(version, mode, suiteId, impacted, overrides) => void model.handoff(version, mode, suiteId, impacted, overrides)} /></section></div>}
  </div>
}

function RunHistoryPanel({ model }: { model: ReturnType<typeof useTestDesign> }) {
  const [expanded, setExpanded] = useState(false)
  const current = model.run
  return <section className="tdw-run-history" aria-label="TestDesign 运行历史"><header><div><p>当前运行</p><h2>{current?.id ?? '尚未选择'}<small>{current ? `${runStatusLabel(current.status)} · ${stageLabel(current.stage)} · ${new Date(current.createdAt).toLocaleString('zh-CN')}` : '选择或新建一个运行'}</small></h2></div><aside><button className="td2-button ghost" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>运行历史（{model.runs.length}）</button><button className="td2-button primary" disabled={Boolean(model.busy)} onClick={() => void model.startRun().catch(() => undefined)}>新建运行</button></aside></header>{expanded && <div>{model.runs.map(item => <button key={item.id} className={model.run?.id === item.id ? 'active' : ''} onClick={() => { setExpanded(false); void model.openRun(item.id).catch(() => undefined) }}><span><b>{item.id}</b><small>{new Date(item.createdAt).toLocaleString('zh-CN')}</small></span><span><small>状态 / 阶段</small><b>{runStatusLabel(item.status)} · {stageLabel(item.stage)}</b></span><span><small>历史基线</small><b>{item.baseTestCaseLibraryVersion ? `V${item.baseTestCaseLibraryVersion.version} · ${item.baseTestCaseLibraryVersion.name}` : '首次生成'}</b></span><span><small>Candidate Delta / Effective</small><b>{item.candidateCaseCount ?? item.caseCount ?? 0} / {item.effectiveCaseCount ?? item.caseCount ?? 0}</b></span><em>{item.published ? '已发布' : '未发布'}</em></button>)}</div>}</section>
}

function DesignProgress({ run, versions }: { run: TestDesignWorkflowRun | null; versions: ReturnType<typeof useTestDesign>['libraryVersions'] }) {
  const stages = deriveStages(run, versions)
  return <section className="tdw-design-progress" aria-label="本次测试设计进度"><header><div><p>本次测试设计工作区</p><h2>从 AI 生成到人工确认发布</h2></div>{run && <span className={`td2-status ${run.status}`}>{runStatusLabel(run.status)}</span>}</header><div>{stages.map((stage, index) => <article key={stage.label} className={stage.state}><i>{stage.state === 'complete' ? <CheckCircle2 /> : index + 1}</i><span><b>{stage.label}</b><small>{stage.detail}</small></span></article>)}</div></section>
}

function PendingWorkPanel({ run, busy, onReAudit, onCreate }: { run: TestDesignWorkflowRun; busy: boolean; onReAudit: () => Promise<void>; onCreate: () => void }) {
  const issues = buildPendingIssues(run)
  const goToCase = (caseId?: string) => document.getElementById(caseId ? `test-case-${caseId}` : 'test-case-list')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  if (!issues.length) return <section className="tdw-pending-clear" id="pending-work"><CheckCircle2 /><span><b>当前没有待处理问题</b><small>可以继续审核并发布；服务端提交时仍会执行最终门禁。</small></span></section>
  return <section className="tdw-pending-work" id="pending-work"><header><div><span><ClipboardCheck /></span><div><h2>待处理问题</h2><p>只展示确定性 Coverage 或 TestCase v3 语义问题。</p></div></div><b>{issues.length} 项</b></header><div className="tdw-pending-list">{issues.map(issue => <article key={issue.key} className={issue.severity}><span className="tdw-pending-icon">{issue.severity === 'blocker' ? <ShieldAlert /> : <AlertTriangle />}</span><div><small>{issue.category}</small><b>{issue.title}</b><p>{issue.description}</p>{issue.affected && <em>{issue.affected}</em>}</div><footer>{issue.action === 'audit' && <button className="td2-button primary" disabled={busy} onClick={() => void onReAudit().catch(() => undefined)}><RefreshCw />重新检查</button>}{issue.action === 'create' && <button className="td2-button primary" disabled={busy} onClick={onCreate}>新增用例</button>}{issue.action === 'case' && <button className="td2-button ghost" onClick={() => goToCase(issue.caseId)}>查看用例</button>}</footer></article>)}</div></section>
}

function ReviewAndPublishBar({ run, versions, busy, blockers, onOpenPublish }: { run: TestDesignWorkflowRun; versions: ReturnType<typeof useTestDesign>['libraryVersions']; busy: boolean; blockers: string[]; onOpenPublish: () => void }) {
  const activeCases = run.testCases.filter(item => !item.tombstonedAt)
  const approved = activeCases.filter(item => item.reviewState === 'approved').length
  const audit = run.coverageAudits.at(-1)
  const published = versions.find(item => item.sourceRunId === run.id)
  const executionIssues = activeCases.filter(item => caseReadiness(item) !== 'ready').length
  const coverage = audit?.status === 'valid' ? `${audit.statistics.coveredBasis}/${audit.statistics.totalBasis}` : '待重新检查'
  return <section className="tdw-review-publish"><div className="tdw-review-summary"><span><small>Candidate Delta</small><b>{activeCases.length}</b></span><span><small>Effective Case Set</small><b>{run.effectiveCaseCount ?? audit?.statistics.totalCases ?? activeCases.length}</b></span><span><small>已审核 Candidate</small><b>{approved}/{activeCases.length}</b></span><span><small>目标 Requirement 覆盖</small><b>{coverage}</b></span><span><small>待处理问题</small><b>{buildPendingIssues(run).length}</b></span><span><small>执行就绪问题</small><b>{executionIssues}</b></span></div><div className="tdw-review-publish-action">{published ? <div className="tdw-published-result"><CheckCircle2 /><span><b>已发布正式用例版本</b><small>{published.name} · V{published.version}</small></span></div> : <><div>{blockers.length ? <small>{blockers[0]}</small> : <small>所有条件已满足，点击后填写正式版本名称。</small>}</div><button className="td2-button primary" disabled={busy || blockers.length > 0} onClick={onOpenPublish}><Rocket />确认并发布</button></>}</div></section>
}

function AdvancedInformation({ tab, setTab, model, run, onOpenHandoff }: { tab: DesignTab; setTab: (tab: DesignTab) => void; model: ReturnType<typeof useTestDesign>; run: TestDesignWorkflowRun | null; onOpenHandoff: () => void }) {
  return <section className="tdw-advanced-details"><details><summary><Settings2 />高级信息<small>Coverage 与运行诊断</small></summary><div className="tdw-advanced-body"><nav className="tdw-tabs">{designTabs.map(item => <button key={item.key} className={tab === item.key ? 'tdw-tab-active' : ''} onClick={() => setTab(item.key)}><item.icon />{item.label}</button>)}</nav>{tab === 'audit' && run && <CoverageAuditPanel run={run} busy={Boolean(model.busy)} onAudit={() => void model.reAudit()} />}{tab === 'details' && <TestDesignRunPanel design={model.design!} run={run} busy={Boolean(model.busy)} onStartRun={() => void model.startRun()} onRefresh={() => void model.refreshRun()} />}{model.technicalError && <details className="tdw-technical-error"><summary>原始错误信息</summary><pre>{model.technicalError}</pre></details>}</div></details></section>
}

type PendingIssue = { key: string; category: string; title: string; description: string; affected?: string; severity: 'blocker' | 'warning'; action: 'audit' | 'create' | 'case'; caseId?: string }

function buildPendingIssues(run: TestDesignWorkflowRun): PendingIssue[] {
  const issues: PendingIssue[] = []
  const audit = run.coverageAudits.at(-1)
  const activeCases = run.testCases.filter(item => !item.tombstonedAt)
  if ((run.effectiveCaseCount ?? activeCases.length) > 0 && (!audit || audit.status === 'stale')) issues.push({ key: 'audit', category: '覆盖检查', title: '覆盖检查需要重新执行', description: 'Candidate Delta 或 Historical Baseline 的 Effective Case Set 已变化，请重新执行覆盖检查。', severity: 'blocker', action: 'audit' })
  if (audit?.status === 'valid') audit.blockers.filter(item => item.resolution !== 'agent_repair').forEach((blocker, index) => {
    const relatedCase = blocker.subjectId ? activeCases.find(item => item.id === blocker.subjectId) : undefined
    const isCoverageGap = /UNCOVERED/u.test(blocker.code)
    issues.push({ key: `audit-${blocker.code}-${blocker.subjectId ?? index}`, category: '覆盖检查', title: blocker.message, description: isCoverageGap ? '请新增用例或补充准确的显式 Requirement 引用后重新检查。' : '请查看并修改相关测试用例。', affected: relatedCase ? `影响用例：${caseContent(relatedCase).title}` : undefined, severity: 'blocker', action: relatedCase ? 'case' : isCoverageGap ? 'create' : 'case', caseId: relatedCase?.id })
  })
  activeCases.filter(item => caseReadiness(item) !== 'ready').forEach(item => issues.push({ key: `readiness-${item.id}`, category: '执行就绪问题', title: `${caseContent(item).title} 尚未执行就绪`, description: caseReadiness(item) === 'blocked' ? '该用例处于阻断状态，不能进入执行交接。' : '该用例需要补充执行信息；如发布后仍需交接，必须逐条填写人工覆盖原因。', affected: `影响用例：${caseContent(item).title}`, severity: caseReadiness(item) === 'blocked' ? 'blocker' : 'warning', action: 'case', caseId: item.id }))
  return issues
}

function getPublicationBlockers(run: TestDesignWorkflowRun) {
  const audit = run.coverageAudits.at(-1)
  return [
    !audit ? '尚未执行覆盖检查' : '',
    audit?.status !== 'valid' ? '覆盖检查已失效，请重新检查' : '',
    run.testCases.some(item => !item.tombstonedAt && item.reviewState !== 'approved') ? '候选用例未全部审核通过' : '',
    audit?.blockers.some(item => item.resolution !== 'execution_handoff') ? '覆盖检查存在发布阻断项' : '',
  ].filter((item): item is string => Boolean(item))
}

function deriveStages(run: TestDesignWorkflowRun | null, versions: ReturnType<typeof useTestDesign>['libraryVersions']) {
  if (!run) return [{ label: 'AI 生成', detail: '等待启动', state: 'active' }, { label: '覆盖检查', detail: '等待 AI 生成', state: 'pending' }, { label: '用例审核', detail: '等待覆盖检查', state: 'pending' }, { label: '发布完成', detail: '等待确认发布', state: 'pending' }] as const
  const activeCases = run.testCases.filter(item => !item.tombstonedAt)
  const generation = run.nodeRuns.find(item => item.nodeKey === 'test_case_design')
  const audit = run.coverageAudits.at(-1)
  const reviewDone = activeCases.every(item => item.reviewState === 'approved')
  const coverageDone = audit?.status === 'valid' && !audit.blockers.some(item => item.resolution !== 'execution_handoff')
  const published = versions.find(item => item.sourceRunId === run.id)
  return [
    { label: 'AI 生成', detail: generation?.status === 'succeeded' ? `本轮 Candidate Delta ${activeCases.length} 条，Effective ${run.effectiveCaseCount ?? audit?.statistics.totalCases ?? activeCases.length} 条` : ['failed', 'cancelled'].includes(run.status) ? runStatusLabel(run.status) : 'PlanningAgent 正在生成 Candidate Delta', state: generation?.status === 'succeeded' ? 'complete' : ['failed', 'cancelled'].includes(run.status) ? 'blocked' : 'active' },
    { label: '覆盖检查', detail: coverageDone ? '当前结果有效' : audit?.status === 'stale' ? '等待重新检查' : '系统检查中', state: coverageDone ? 'complete' : generation?.status === 'succeeded' ? 'active' : 'pending' },
    { label: '用例审核', detail: reviewDone ? '全部用例已审核通过' : `${activeCases.filter(item => item.reviewState === 'approved').length}/${activeCases.length} 已审核`, state: reviewDone ? 'complete' : coverageDone ? 'active' : 'pending' },
    { label: '发布完成', detail: published ? `${published.name} · V${published.version}` : coverageDone ? '等待确认并发布' : '等待覆盖检查', state: published ? 'complete' : coverageDone ? 'active' : 'pending' },
  ] as const
}

function caseContent(testCase: TestDesignCase) { return testCase.revisions.find(item => item.revision === testCase.currentRevision)!.content }
function caseReadiness(testCase: TestDesignCase) { return caseContent(testCase).executionMethods.length ? 'ready' : 'blocked' }
function runStatusLabel(status: string) { return ({ queued: '等待处理', running: '正在运行', succeeded: '已完成', failed: '运行失败', cancelled: '已取消' } as Record<string, string>)[status] ?? status }

function WorkspaceSidebar({ entry, model, selectedId, onCreate, onOpen }: { entry: Entry; model: ReturnType<typeof useTestDesign>; selectedId?: string; onCreate: () => void; onOpen: (design: ReturnType<typeof useTestDesign>['designs'][number]) => void }) {
  const title = ({ designs: '设计任务', library: '正式用例', suites: '套件资产', releases: '发布版本' } as const)[entry]
  return <aside className="tdw-workspace"><header><span><FolderOpen />{title}</span>{entry === 'designs' && <button onClick={onCreate} title="高级设置：手动创建测试设计" aria-label="高级设置：手动创建测试设计"><Settings2 /></button>}</header><div className="tdw-path">{entry === 'designs' ? '当前项目 / 测试设计' : `project/${model.inputs?.projectVersion.projectId}/${entry}`}</div><div className="tdw-docs">{entry === 'designs' && model.designs.map(item => <button key={item.id} className={selectedId === item.id ? 'active' : ''} onClick={() => onOpen(item)}><span><ClipboardList /></span><div><b>{item.name}</b><small>{item.latestRun ? `${stageLabel(item.latestRun.stage)} · ${item.latestRun.progress}%` : '尚未运行'}</small><em>{item.creationMode === 'automatic' ? 'PlanningAgent 自动创建' : '高级设置创建'}</em></div></button>)}{entry === 'library' && model.libraryCases.map(item => <button key={item.id}><span><TestTube2 /></span><div><b>{item.content.title}</b><small>{item.content.dimension} · r{item.currentRevision} · {item.status}</small><em>{item.id}</em></div></button>)}{entry === 'suites' && [...model.suiteDrafts, ...model.suiteVersions].map(item => <button key={item.id}><span><Workflow /></span><div><b>{item.name}</b><small>{item.suiteType} · {item.members.length} 条</small><em>{item.id}</em></div></button>)}{entry === 'releases' && model.libraryVersions.map(item => <button key={item.id}><span><PackageCheck /></span><div><b>V{item.version} · {item.name}</b><small>{item.members.length} 条 · {item.projection.status}</small><em>{item.id}</em></div></button>)}</div><footer><button onClick={() => void model.loadCollection()}><RefreshCw />刷新项目资产</button></footer></aside>
}

function ContextSidebar({ entry, model }: { entry: Entry; model: ReturnType<typeof useTestDesign> }) { const events = useMemo(() => model.run?.nodeRuns.flatMap(node => node.execution?.events ?? []).sort((left, right) => right.sequence - left.sequence) ?? [], [model.run]); return <aside className="tdw-agent"><header><span><Bot />{entry === 'designs' ? 'Agent 运行轨迹' : '资产上下文'}</span><span className="tdw-live">● LIVE</span></header><div className="tdw-trace">{entry === 'designs' && model.run ? <><div className="tdw-agent-summary"><Bot /><span><b>PlanningAgent</b><small>{model.run.agentConfigurationSnapshot.primaryModel.modelName} · {model.run.status} · {model.run.progress}%</small></span></div>{events.slice(0, 30).map(event => <article key={`${event.sequence}-${event.type}`} className={event.toolId ? 'tool' : ''}><small>#{event.sequence} · {event.type}</small><b>{skillReadLabel(event) ?? event.toolId ?? event.content?.slice(0, 80) ?? '工作流事件'}</b><time>{event.occurredAt ? new Date(event.occurredAt).toLocaleTimeString('zh-CN') : ''}</time></article>)}</> : <AssetSummary model={model} />}</div></aside> }
function EmbeddedTestDesignLoading({ contextReady, error, onRetry }: { contextReady: boolean; error: string; onRetry?: () => void }) { const title = contextReady ? '正在打开本次测试用例' : '正在建立测试设计上下文'; const detail = contextReady ? '上下文已确认，正在读取冻结运行、候选用例及其覆盖状态。' : '正在确认正式需求，并读取本次测试设计入口。'; return <section className="tdw-embedded tdw-context-loading" aria-label="测试用例加载中" aria-busy="true"><div className="tdw-context-loading-card"><div className="tdw-context-loading-head"><span><RefreshCw className="spin" /></span><div><b>{title}</b><small>{detail}</small></div></div><div className="tdw-context-loading-skeleton" aria-hidden="true"><i /><i /><i /></div>{error && <div className="tdw-context-loading-error"><span>{error}</span>{onRetry && <button onClick={onRetry}>重试读取</button>}</div>}</div></section> }
function skillReadLabel(event: AgentEvent) { if (!event.skillKey) return undefined; return `${event.type === 'skill_read_replayed' ? 'Skill 缓存重放' : 'Skill 已读取'}：${event.skillKey}${event.version ? ` · v${event.version}` : ''}` }
function AssetSummary({ model }: { model: ReturnType<typeof useTestDesign> }) { return <><div className="tdw-agent-summary"><Library /><span><b>项目级测试资产</b><small>当前快照实时来自服务端</small></span></div><div className="tdw-context-kpis"><span><b>{model.libraryCases.length}</b><small>正式用例</small></span><span><b>{model.libraryVersions.length}</b><small>用例库版本</small></span><span><b>{model.suiteDrafts.length}</b><small>套件草稿</small></span><span><b>{model.suiteVersions.length}</b><small>套件版本</small></span><span><b>{model.handoffs.length}</b><small>Handoff</small></span></div></> }
function stageLabel(value: string) { return ({ test_case_design: '用例生成', coverage_audit: 'Coverage 检查', test_design_repair: '自动修复', completed: '已完成' } as Record<string, string>)[value] ?? value }
