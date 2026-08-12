import { useEffect, useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, BookOpen, Bot, CheckCircle2, Clock3, Download, FileDiff, FileText,
  GitBranch, ListFilter, LoaderCircle, MessageSquareText, Play, Quote, RefreshCw, Send, ShieldCheck,
  Sparkles, XCircle,
} from 'lucide-react'
import type { KnowledgeDocument } from './prototype-data'
import { loadAssetVersion } from './knowledge-api'
import { MarkdownDocument } from './MarkdownDocument'
import {
  askRequirementReviewQuestion,
  cancelRequirementReviewRun,
  createFindingAction,
  downloadRequirementReviewReport,
  loadFindingActions,
  loadRequirementReviewRun,
  loadRequirementReviewRuns,
  loadReviewQuestionHistory,
  retryRequirementReviewRun,
  startRequirementAnalysis,
  type AgentExecutionEvent,
  type RequirementAnalysisResponse,
  type RequirementReviewRun,
  type ReviewEvidence,
  type ReviewFinding,
  type ReviewFindingType,
  type ReviewSeverity,
  type FindingActionType,
} from './requirement-analysis-api'
import { requirementWorkspaceDirectory } from './version-document-path'
import { loadAgentConfiguration, type AgentConfigurationState } from './agent-configuration-api'
import type { ProjectVersion } from './project-version-api'
import { RequirementReviewPage as LegacyRequirementReviewPage } from './RequirementReviewPageLegacy'
import './requirement-analysis-page.css'

type Notify = (message: string, tone?: 'success' | 'error' | 'warning') => void
type ViewKey = 'overview' | 'baseline' | 'findings' | 'report' | 'diff'
type FindingState = 'open' | 'confirmed' | 'dismissed' | 'resolved' | 'needs_follow_up'
type RunRecord = RequirementReviewRun & { content?: string }
type ChatMessage = { id: string; role: 'user' | 'assistant' | 'system'; text: string; citations?: string[] }

type Props = {
  projectVersion: ProjectVersion | null
  documents: KnowledgeDocument[]
  knowledgeBaseId: string
  apiState: 'connecting' | 'ready' | 'offline'
  refreshKnowledge: () => Promise<void>
  onManageVersions: () => void
  onOpenKnowledge: () => void
  onOpenActivity: () => void
  notify: Notify
  addAudit: (entry: string) => void
}

const findingTypeLabels: Record<ReviewFindingType, string> = {
  missing_requirement: '需求缺口', ambiguity: '需求歧义', conflict: '逻辑冲突', boundary_gap: '边界条件',
  state_gap: '状态缺口', exception_gap: '异常场景', security_risk: '安全风险', testability_gap: '可测试性',
  dependency_risk: '依赖风险', other: '其他问题',
}
const severityLabels: Record<ReviewSeverity, string> = { blocker: '阻断', high: '高', medium: '中', low: '低' }
const findingStateLabels: Record<FindingState, string> = { open: '待处理', confirmed: '已确认', dismissed: '已驳回', resolved: '已解决', needs_follow_up: '待跟进' }
const viewTabs: Array<{ key: ViewKey; label: string; icon: typeof Sparkles }> = [
  { key: 'overview', label: '分析概览', icon: Sparkles },
  { key: 'baseline', label: '需求基线', icon: GitBranch },
  { key: 'findings', label: '需求问题', icon: AlertTriangle },
  { key: 'report', label: '分析报告', icon: FileText },
  { key: 'diff', label: '版本差异', icon: FileDiff },
]

function Badge({ children, tone = 'gray' }: { children: React.ReactNode; tone?: string }) {
  return <span className={`ra-badge ${tone}`}>{children}</span>
}

function formatTime(value: string) { return new Date(value).toLocaleString('zh-CN', { hour12: false }) }
function severityTone(value: ReviewSeverity) { return value === 'blocker' ? 'red' : value === 'high' ? 'orange' : value === 'medium' ? 'gold' : 'blue' }
function assessmentLabel(value?: string) { return value === 'blocked' ? '存在阻断问题' : value === 'needs_revision' ? '建议修改后确认' : value === 'pass_with_notes' ? '附带关注项通过' : value === 'pass' ? '可以进入下一阶段' : '等待分析' }
function runLabel(run?: RunRecord) { return run?.status === 'running' ? '分析中' : run?.status === 'succeeded' ? '已完成' : run?.status === 'failed' ? '失败' : run?.status === 'cancelled' ? '已取消' : '未运行' }

function evidenceForFinding(finding: ReviewFinding, result?: RequirementAnalysisResponse['result']) {
  if (!result) return [] as ReviewEvidence[]
  const points = new Map(result.requirementPoints.map(item => [item.clientRequirementPointId, item]))
  const evidence = new Map(result.evidence.map(item => [item.clientEvidenceId, item]))
  const refs = new Set(finding.requirementPointRefs.flatMap(reference => points.get(reference)?.evidenceRefs ?? []))
  return [...refs].map(reference => evidence.get(reference)).filter((item): item is ReviewEvidence => Boolean(item))
}

function readAssetVersionIds(run?: RunRecord) {
  return new Set((run?.response?.inputDeliveryManifest ?? run?.inputDeliveryManifest)?.toolReads?.flatMap(read => read.assetVersionIds) ?? [])
}

export function RequirementAnalysisPage(props: Props) {
  const { projectVersion, documents, apiState, notify, addAudit, onManageVersions, onOpenKnowledge, onOpenActivity } = props
  const [legacyMode, setLegacyMode] = useState(false)
  const [view, setView] = useState<ViewKey>('overview')
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [selectedRunId, setSelectedRunId] = useState('')
  const [loadingRuns, setLoadingRuns] = useState(false)
  const [starting, setStarting] = useState(false)
  const [agentConfiguration, setAgentConfiguration] = useState<AgentConfigurationState | null>(null)
  const [findingStates, setFindingStates] = useState<Record<string, FindingState>>({})
  const [findingVersions, setFindingVersions] = useState<Record<string, number>>({})
  const [findingTypeFilter, setFindingTypeFilter] = useState<'all' | ReviewFindingType>('all')
  const [severityFilter, setSeverityFilter] = useState<'all' | ReviewSeverity>('all')
  const [findingStateFilter, setFindingStateFilter] = useState<'all' | FindingState>('all')
  const [selectedDocumentId, setSelectedDocumentId] = useState('')
  const [sourceEvidence, setSourceEvidence] = useState<ReviewEvidence | null>(null)
  const [sourceContent, setSourceContent] = useState('')
  const [sourceLoading, setSourceLoading] = useState(false)
  const [chatDraft, setChatDraft] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatSending, setChatSending] = useState(false)
  const [diffVersionIds, setDiffVersionIds] = useState<[string, string]>(['', ''])
  const [diffContents, setDiffContents] = useState<Record<string, string>>({})
  const [diffLoading, setDiffLoading] = useState(false)

  const workspaceDirectoryPath = projectVersion ? requirementWorkspaceDirectory(projectVersion.name) : ''
  const requirementDocuments = useMemo(() => documents.filter(document => {
    const logicalPath = document.logicalPath?.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '') ?? ''
    return document.status === 'ready' && Boolean(document.assetVersionId) && Boolean(workspaceDirectoryPath) && logicalPath.startsWith(`${workspaceDirectoryPath}/`)
  }), [documents, workspaceDirectoryPath])

  const selectedRun = runs.find(run => run.id === selectedRunId)
  const result = selectedRun?.response?.result
  const readVersions = readAssetVersionIds(selectedRun)
  const selectedDocument = requirementDocuments.find(item => item.id === selectedDocumentId) ?? requirementDocuments[0]
  const analysisAgentReady = Boolean(agentConfiguration?.agents.requirementAnalysis.activeVersion)
  const reviewQaReady = Boolean(agentConfiguration?.agents.reviewQa.activeVersion)
  const canRun = Boolean(projectVersion && projectVersion.status === 'open' && requirementDocuments.length && analysisAgentReady && apiState === 'ready' && !starting)

  const refreshRuns = async (selectLatest = false) => {
    if (!projectVersion) { setRuns([]); setSelectedRunId(''); return }
    setLoadingRuns(true)
    try {
      const page = await loadRequirementReviewRuns(projectVersion.id)
      setRuns(page.items)
      if (selectLatest || !page.items.some(item => item.id === selectedRunId)) setSelectedRunId(page.items[0]?.id ?? '')
    } catch (error) { notify(error instanceof Error ? error.message : '需求分析历史读取失败', 'error') }
    finally { setLoadingRuns(false) }
  }

  useEffect(() => { void refreshRuns(true) }, [projectVersion?.id])
  useEffect(() => { loadAgentConfiguration().then(setAgentConfiguration).catch(() => undefined) }, [])
  useEffect(() => { if (!selectedDocumentId || !requirementDocuments.some(item => item.id === selectedDocumentId)) setSelectedDocumentId(requirementDocuments[0]?.id ?? '') }, [requirementDocuments, selectedDocumentId])

  useEffect(() => {
    if (!selectedRun || selectedRun.id.startsWith('pending-')) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const detail = await loadRequirementReviewRun(selectedRun.id)
        if (cancelled) return
        setRuns(current => current.map(item => item.id === detail.id ? { ...item, ...detail } : item))
        if (detail.status === 'running') timer = setTimeout(() => void poll(), 1000)
      } catch { if (!cancelled && selectedRun.status === 'running') timer = setTimeout(() => void poll(), 2000) }
    }
    void poll()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [selectedRun?.id, selectedRun?.status])

  useEffect(() => {
    if (!selectedRun || selectedRun.status !== 'succeeded') { setChatMessages([]); return }
    let cancelled = false
    Promise.all([loadFindingActions(selectedRun.id), loadReviewQuestionHistory(selectedRun.id)]).then(([actions, history]) => {
      if (cancelled) return
      setFindingStates(current => ({ ...current, ...Object.fromEntries(actions.findings.map(item => [`${selectedRun.id}:${item.findingId}`, item.state])) }))
      setFindingVersions(current => ({ ...current, ...Object.fromEntries(actions.findings.map(item => [`${selectedRun.id}:${item.findingId}`, item.version])) }))
      setChatMessages(history.turns.flatMap(turn => [
        { id: `${turn.id}:q`, role: 'user' as const, text: turn.question },
        turn.status === 'succeeded'
          ? { id: turn.id, role: 'assistant' as const, text: turn.answer ?? '', citations: turn.citations }
          : { id: turn.id, role: 'system' as const, text: turn.error ?? '问答未完成' },
      ]))
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [selectedRun?.id, selectedRun?.status])

  useEffect(() => {
    const versions = (selectedDocument?.versions ?? []).filter(item => item.status === 'ready')
    const right = selectedDocument?.assetVersionId ?? versions.at(-1)?.id ?? ''
    const rightIndex = versions.findIndex(item => item.id === right)
    const left = versions[Math.max(0, rightIndex - 1)]?.id ?? versions.at(-2)?.id ?? ''
    setDiffVersionIds([left && left !== right ? left : '', right])
    setDiffContents({})
  }, [selectedDocument?.id, selectedDocument?.assetVersionId])

  useEffect(() => {
    if (view !== 'diff') return
    const missing = diffVersionIds.filter(Boolean).filter(id => !(id in diffContents))
    if (!missing.length) return
    let cancelled = false
    setDiffLoading(true)
    Promise.all(missing.map(async id => [id, (await loadAssetVersion(id)).content] as const)).then(entries => {
      if (!cancelled) setDiffContents(current => ({ ...current, ...Object.fromEntries(entries) }))
    }).catch(error => { if (!cancelled) notify(error instanceof Error ? error.message : '版本内容读取失败', 'error') })
      .finally(() => { if (!cancelled) setDiffLoading(false) })
    return () => { cancelled = true }
  }, [view, diffVersionIds, diffContents])

  const startAnalysis = async () => {
    if (!projectVersion || !canRun) return
    setStarting(true)
    try {
      const started = await startRequirementAnalysis(projectVersion.id, {
        documentDirectoryPath: workspaceDirectoryPath,
        focusAreas: ['功能完整性', '异常流程', '边界条件', '可测试性'],
      })
      setRuns(current => [started, ...current.filter(item => item.id !== started.id)])
      setSelectedRunId(started.id)
      setView('overview')
      addAudit(`启动 RequirementAnalysisAgent：${started.id}`)
      notify('需求分析已启动，RequirementAnalysisAgent 将在同一 Session 内完成分析与自检。')
    } catch (error) { notify(error instanceof Error ? error.message : '需求分析启动失败', 'error') }
    finally { setStarting(false) }
  }

  const cancelAnalysis = async () => {
    if (!selectedRun || selectedRun.status !== 'running') return
    try {
      const cancelled = await cancelRequirementReviewRun(selectedRun.id)
      setRuns(current => current.map(item => item.id === cancelled.id ? cancelled : item))
      notify('已取消本次需求分析。', 'warning')
    } catch (error) { notify(error instanceof Error ? error.message : '取消失败', 'error') }
  }

  const retryAnalysis = async () => {
    if (!selectedRun || selectedRun.status === 'running') return
    setStarting(true)
    try {
      const started = await retryRequirementReviewRun(selectedRun.id)
      setRuns(current => [started, ...current.filter(item => item.id !== started.id)])
      setSelectedRunId(started.id)
      setView('overview')
      notify('已创建新的完整需求分析运行。')
    } catch (error) { notify(error instanceof Error ? error.message : '重跑失败', 'error') }
    finally { setStarting(false) }
  }

  const exportReport = async () => {
    if (!projectVersion || !selectedRun?.response) return
    try {
      const blob = await downloadRequirementReviewReport(projectVersion.id, selectedRun.id)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${projectVersion.name.replace(/[\\/:*?"<>|]/g, '-')}-需求分析报告.md`
      link.click()
      URL.revokeObjectURL(url)
    } catch (error) { notify(error instanceof Error ? error.message : '报告导出失败', 'error') }
  }

  const openEvidence = async (evidence: ReviewEvidence) => {
    setSourceEvidence(evidence)
    setSourceContent('')
    setSourceLoading(true)
    try { setSourceContent((await loadAssetVersion(evidence.sourceRef.assetVersionId)).content) }
    catch (error) { notify(error instanceof Error ? error.message : '原文读取失败', 'error'); setSourceEvidence(null) }
    finally { setSourceLoading(false) }
  }

  const updateFindingState = async (finding: ReviewFinding, next: FindingState) => {
    if (!selectedRun || projectVersion?.status !== 'open') return
    const key = `${selectedRun.id}:${finding.clientFindingId}`
    const current = findingStates[key] ?? 'open'
    if (current === next) return
    const actionByState: Record<FindingState, FindingActionType> = { open: 'reopen', confirmed: 'confirm', dismissed: 'dismiss', resolved: 'resolve', needs_follow_up: 'request_follow_up' }
    const needsComment = next === 'dismissed' || next === 'needs_follow_up' || next === 'open'
    const comment = needsComment ? window.prompt(`请填写“${findingStateLabels[next]}”的处置说明：`)?.trim() : undefined
    if (needsComment && !comment) return
    try {
      const saved = await createFindingAction(selectedRun.id, finding.clientFindingId, { action: actionByState[next], comment, expectedVersion: findingVersions[key] ?? 0 })
      setFindingStates(values => ({ ...values, [key]: saved.toState }))
      setFindingVersions(values => ({ ...values, [key]: saved.version }))
    } catch (error) { notify(error instanceof Error ? error.message : 'Finding 状态保存失败', 'error') }
  }

  const sendChat = async () => {
    const question = chatDraft.trim()
    if (!selectedRun || selectedRun.status !== 'succeeded' || !reviewQaReady || !question || chatSending) return
    setChatMessages(current => [...current, { id: `local-${Date.now()}`, role: 'user', text: question }])
    setChatDraft('')
    setChatSending(true)
    try {
      const response = await askRequirementReviewQuestion(selectedRun.id, { question })
      setChatMessages(current => [...current, { id: response.id, role: 'assistant', text: response.answer, citations: response.citations }])
    } catch (error) {
      const message = error instanceof Error ? error.message : '评审问答失败'
      setChatMessages(current => [...current, { id: `error-${Date.now()}`, role: 'system', text: message }])
    } finally { setChatSending(false) }
  }

  if (legacyMode) return <div className="ra-legacy-shell"><button className="btn ghost ra-back-new" onClick={() => setLegacyMode(false)}>返回新版需求分析</button><LegacyRequirementReviewPage {...props} /></div>

  if (!projectVersion) return <section className="card ra-version-gate"><GitBranch /><h1>新建项目版本后才能进行需求分析</h1><p>需求输入、分析运行和 Finding 都归属于项目版本。</p><button className="btn primary" onClick={onManageVersions}>新建项目版本</button></section>

  const visibleFindings = (result?.findings ?? []).filter(finding => {
    const state = selectedRun ? findingStates[`${selectedRun.id}:${finding.clientFindingId}`] ?? 'open' : 'open'
    return (findingTypeFilter === 'all' || finding.type === findingTypeFilter)
      && (severityFilter === 'all' || finding.severity === severityFilter)
      && (findingStateFilter === 'all' || state === findingStateFilter)
  })
  const blockerCount = result?.findings.filter(item => item.severity === 'blocker').length ?? 0
  const highCount = result?.findings.filter(item => item.severity === 'high').length ?? 0
  const pendingCount = result?.findings.filter(item => {
    const state = selectedRun ? findingStates[`${selectedRun.id}:${item.clientFindingId}`] ?? 'open' : 'open'
    return state === 'open' || state === 'confirmed' || state === 'needs_follow_up'
  }).length ?? 0
  const versionHistory = (selectedDocument?.versions ?? []).filter(item => item.status === 'ready')
  const leftLines = (diffContents[diffVersionIds[0]] ?? '').split(/\r?\n/).filter(Boolean)
  const rightLines = (diffContents[diffVersionIds[1]] ?? '').split(/\r?\n/).filter(Boolean)
  const removedLines = leftLines.filter(line => !rightLines.includes(line))
  const addedLines = rightLines.filter(line => !leftLines.includes(line))

  return <section className="card ra-page">
    <header className="ra-header">
      <div className="ra-title"><span><Sparkles /></span><div><h1>Pi Agent 需求分析 · {projectVersion.name}</h1><p>一次 RequirementAnalysisAgent Session 完成需求基线、整体 Review、Test Focus 与分析报告。</p></div></div>
      <div className="ra-run-info"><Badge tone={selectedRun?.status === 'succeeded' ? 'green' : selectedRun?.status === 'running' ? 'purple' : selectedRun?.status === 'failed' ? 'red' : 'gray'}>{runLabel(selectedRun)}</Badge><span><small>Run</small><b>{selectedRun?.id?.replace('review_run_', '').slice(0, 10) ?? '-'}</b></span><span><small>已读 / 候选</small><b>{readVersions.size} / {selectedRun?.assetVersionIds?.length ?? requirementDocuments.length}</b></span></div>
      <div className="ra-actions">
        <select value={selectedRunId} onChange={event => setSelectedRunId(event.target.value)} disabled={loadingRuns}><option value="">{loadingRuns ? '加载中…' : '运行历史'}</option>{runs.map(run => <option value={run.id} key={run.id}>{formatTime(run.createdAt)} · {runLabel(run)}</option>)}</select>
        <button className="btn ghost" onClick={() => void refreshRuns()}><RefreshCw />刷新</button>
        <button className="btn ghost" onClick={() => setLegacyMode(true)}>高级视图</button>
        <button className="btn ghost" onClick={exportReport} disabled={!selectedRun?.response}><Download />导出</button>
        {selectedRun?.status === 'running' ? <button className="btn danger" onClick={cancelAnalysis}><XCircle />取消</button> : selectedRun && ['failed', 'cancelled'].includes(selectedRun.status) ? <button className="btn primary" onClick={retryAnalysis} disabled={!canRun}><RefreshCw />完整重跑</button> : <button className="btn primary" onClick={startAnalysis} disabled={!canRun}><Play />{starting ? '启动中…' : selectedRun ? '重新分析' : '开始分析'}</button>}
      </div>
    </header>

    <div className="ra-layout">
      <aside className="ra-workspace">
        <header><span><FileText /><b>需求 Workspace</b></span><Badge tone="blue">{requirementDocuments.length}</Badge></header>
        <div className="ra-workspace-path">/{workspaceDirectoryPath}</div>
        <div className="ra-document-list">{requirementDocuments.map(document => {
          const read = Boolean(document.assetVersionId && readVersions.has(document.assetVersionId))
          return <button className={selectedDocument?.id === document.id ? 'active' : ''} key={document.id} onClick={() => setSelectedDocumentId(document.id)}><span className={`ra-read-dot ${read ? 'read' : ''}`}>{read ? <CheckCircle2 /> : <Clock3 />}</span><span><b>{document.title}</b><small>{read ? 'Agent 已读取' : selectedRun ? 'Agent 未读取' : '候选输入'} · {document.version}</small><em>{document.logicalPath}</em></span></button>
        })}{!requirementDocuments.length && <div className="ra-empty compact"><FileText /><b>暂无需求输入</b><p>当前版本的 input/requirements 目录中没有 ready 文档。</p></div>}</div>
        <footer><button onClick={onOpenKnowledge}><BookOpen />知识库</button><button onClick={onManageVersions}><GitBranch />版本管理</button><button onClick={onOpenActivity}><Clock3 />操作记录</button></footer>
      </aside>

      <main className="ra-main">
        <nav className="ra-tabs">{viewTabs.map(tab => <button className={view === tab.key ? 'active' : ''} key={tab.key} onClick={() => setView(tab.key)}><tab.icon />{tab.label}{tab.key === 'findings' && result ? <i>{result.findings.length}</i> : null}</button>)}</nav>
        {selectedRun?.status === 'running' && <div className="ra-running"><LoaderCircle className="rotating" /><span><b>RequirementAnalysisAgent 正在分析并自检</b><small>Workspace 读取、Knowledge 查询和提交过程会同步显示在右侧。</small></span></div>}
        <div className="ra-content">
          {view === 'overview' && <Overview result={result} blockerCount={blockerCount} highCount={highCount} pendingCount={pendingCount} onFindings={() => setView('findings')} onReport={() => setView('report')} />}
          {view === 'baseline' && <Baseline result={result} onEvidence={openEvidence} />}
          {view === 'findings' && <Findings result={result} selectedRun={selectedRun} findingStates={findingStates} findingTypeFilter={findingTypeFilter} setFindingTypeFilter={setFindingTypeFilter} severityFilter={severityFilter} setSeverityFilter={setSeverityFilter} findingStateFilter={findingStateFilter} setFindingStateFilter={setFindingStateFilter} visibleFindings={visibleFindings} onEvidence={openEvidence} onState={updateFindingState} />}
          {view === 'report' && <Report result={result} />}
          {view === 'diff' && <Diff versions={versionHistory} value={diffVersionIds} onChange={setDiffVersionIds} loading={diffLoading} removed={removedLines} added={addedLines} />}
        </div>
      </main>

      <aside className="ra-agent">
        <header><span><Bot /><b>Pi Agent</b></span><Badge tone={selectedRun?.status === 'running' ? 'purple' : selectedRun?.status === 'succeeded' ? 'green' : 'gray'}>{selectedRun?.status === 'running' ? '运行中' : selectedRun?.status === 'succeeded' ? '可追问' : '待运行'}</Badge></header>
        <AgentTrace run={selectedRun} />
        {selectedRun?.status === 'succeeded' && <><div className="ra-chat-divider">分析完成后的追问</div><div className="ra-chat-messages">{chatMessages.map(message => <article className={message.role} key={message.id}><b>{message.role === 'user' ? '你' : message.role === 'assistant' ? 'AI 助手' : '系统'}</b><p>{message.text}</p>{message.citations?.length ? <small>引用：{message.citations.join('、')}</small> : null}</article>)}</div><div className="ra-chat-input"><textarea value={chatDraft} onChange={event => setChatDraft(event.target.value)} placeholder={reviewQaReady ? '基于本次固定分析结果继续追问…' : '请先发布评审问答 Agent'} disabled={!reviewQaReady || chatSending} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendChat() } }} /><button onClick={() => void sendChat()} disabled={!chatDraft.trim() || !reviewQaReady || chatSending}>{chatSending ? <LoaderCircle className="rotating" /> : <Send />}</button></div></>}
      </aside>
    </div>

    {sourceEvidence && <div className="ra-modal-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) setSourceEvidence(null) }}><section className="ra-source-modal"><header><span><ShieldCheck /><b>固定原文证据</b></span><button onClick={() => setSourceEvidence(null)}><XCircle /></button></header><div className="ra-evidence-summary"><b>{sourceEvidence.clientEvidenceId} · {sourceEvidence.locator.heading}</b><p>“{sourceEvidence.quote}”</p><small>{sourceEvidence.sourceRef.assetVersionId} · {sourceEvidence.sourceRef.chunkId}</small></div><div className="ra-source-body">{sourceLoading ? <div className="ra-empty"><LoaderCircle className="rotating" /><b>正在加载固定版本</b></div> : <MarkdownDocument source={sourceContent} format="markdown" />}</div></section></div>}
  </section>
}

function Overview({ result, blockerCount, highCount, pendingCount, onFindings, onReport }: { result?: RequirementAnalysisResponse['result']; blockerCount: number; highCount: number; pendingCount: number; onFindings: () => void; onReport: () => void }) {
  if (!result) return <div className="ra-empty"><Sparkles /><h2>等待需求分析</h2><p>启动后，一个 RequirementAnalysisAgent Session 会自主读取 Workspace、按需查询 Knowledge，并一次提交完整需求分析结果。</p></div>
  return <div className="ra-overview">
    <section className="ra-assessment"><div><Badge tone={result.summary.overallAssessment === 'blocked' ? 'red' : result.summary.overallAssessment === 'needs_revision' ? 'orange' : 'green'}>{assessmentLabel(result.summary.overallAssessment)}</Badge><h2>{result.summary.overview || '需求分析已完成'}</h2><p>{result.summary.risks[0] ?? result.summary.strengths[0] ?? '当前结果已通过服务端结构与追溯校验。'}</p></div><div className="ra-score"><strong>{result.summary.score}</strong><span>辅助评分</span></div></section>
    <div className="ra-kpis"><article><GitBranch /><span>需求基线</span><strong>{result.requirementPoints.length}</strong><small>可追溯 Requirement</small></article><article><AlertTriangle /><span>需求问题</span><strong>{result.findings.length}</strong><small>{blockerCount} 阻断 · {highCount} 高风险</small></article><article><ListFilter /><span>待处理</span><strong>{pendingCount}</strong><small>需要确认或继续跟进</small></article><article><ShieldCheck /><span>Test Focus</span><strong>{result.testFocus.length}</strong><small>传递给测试设计</small></article></div>
    <div className="ra-overview-grid"><section><header><b>业务目标</b><Badge tone="blue">{result.summary.businessGoals.length}</Badge></header>{result.summary.businessGoals.length ? <ul>{result.summary.businessGoals.map(item => <li key={item}>{item}</li>)}</ul> : <p>当前需求没有明确独立业务目标。</p>}</section><section><header><b>主要风险</b><Badge tone="orange">{result.summary.risks.length}</Badge></header>{result.summary.risks.length ? <ul>{result.summary.risks.map(item => <li key={item}>{item}</li>)}</ul> : <p>没有单独列出的整体风险。</p>}</section></div>
    <section className="ra-top-findings"><header><div><AlertTriangle /><span><b>优先处理的问题</b><small>按严重度展示前 5 条 Finding</small></span></div><button onClick={onFindings}>查看全部</button></header>{[...result.findings].sort((a, b) => ['blocker','high','medium','low'].indexOf(a.severity) - ['blocker','high','medium','low'].indexOf(b.severity)).slice(0, 5).map(finding => <article key={finding.clientFindingId}><Badge tone={severityTone(finding.severity)}>{severityLabels[finding.severity]}</Badge><span><b>{finding.title}</b><small>{finding.requirementPointRefs.join('、') || '整体需求问题'}</small></span></article>)}{!result.findings.length && <p>没有需要处理的 Finding。</p>}</section>
    <section className="ra-test-focus"><header><div><ShieldCheck /><span><b>Test Focus</b><small>需求分析向测试设计传递的重点</small></span></div><button onClick={onReport}>查看完整报告</button></header>{result.testFocus.slice(0, 6).map(item => <article key={item.id}><b>{item.id} · {item.title}</b><p>{item.description}</p><small>{item.requirementPointRefs.join('、') || '整体关注项'}</small></article>)}</section>
  </div>
}

function Baseline({ result, onEvidence }: { result?: RequirementAnalysisResponse['result']; onEvidence: (evidence: ReviewEvidence) => void }) {
  if (!result) return <div className="ra-empty"><GitBranch /><h2>暂无需求基线</h2><p>完成一次需求分析后显示。</p></div>
  const evidence = new Map(result.evidence.map(item => [item.clientEvidenceId, item]))
  return <div className="ra-baseline"><header><div><GitBranch /><span><h2>Requirement Baseline</h2><p>以自然语言需求为主，结构化字段降级为可选详情。</p></span></div><Badge tone="green">{result.requirementPoints.length} 个</Badge></header>{result.requirementPoints.map(point => {
    const linked = point.evidenceRefs.map(id => evidence.get(id)).filter((item): item is ReviewEvidence => Boolean(item))
    const details = [['主体', point.actor], ['动作', point.action], ['对象', point.object], ['条件', point.conditions.join('；')], ['业务规则', point.businessRules.join('；')], ['异常', point.exceptions.join('；')], ['验收标准', point.acceptanceCriteria.join('；')]].filter(([, value]) => value)
    return <article className="ra-baseline-card" key={point.clientRequirementPointId}><header><span className="ra-rp-id">{point.clientRequirementPointId}</span><div><h3>{point.title}</h3><p>{point.description}</p></div><Badge tone={linked.length ? 'green' : 'orange'}>{linked.length} 条证据</Badge></header>{details.length ? <details><summary>查看结构化详情</summary><dl>{details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details> : null}<footer>{linked.map(item => <button key={item.clientEvidenceId} onClick={() => onEvidence(item)}><Quote />{item.clientEvidenceId} · {item.locator.heading}</button>)}</footer></article>
  })}</div>
}

function Findings({ result, selectedRun, findingStates, findingTypeFilter, setFindingTypeFilter, severityFilter, setSeverityFilter, findingStateFilter, setFindingStateFilter, visibleFindings, onEvidence, onState }: { result?: RequirementAnalysisResponse['result']; selectedRun?: RunRecord; findingStates: Record<string, FindingState>; findingTypeFilter: 'all' | ReviewFindingType; setFindingTypeFilter: (value: 'all' | ReviewFindingType) => void; severityFilter: 'all' | ReviewSeverity; setSeverityFilter: (value: 'all' | ReviewSeverity) => void; findingStateFilter: 'all' | FindingState; setFindingStateFilter: (value: 'all' | FindingState) => void; visibleFindings: ReviewFinding[]; onEvidence: (evidence: ReviewEvidence) => void; onState: (finding: ReviewFinding, next: FindingState) => void }) {
  if (!result) return <div className="ra-empty"><AlertTriangle /><h2>暂无需求问题</h2><p>完成一次需求分析后显示。</p></div>
  return <div className="ra-findings"><header><div><AlertTriangle /><span><h2>需求问题</h2><p>单需求、跨需求与整体性 Finding 统一处理。</p></span></div><Badge tone="orange">{visibleFindings.length} / {result.findings.length}</Badge></header><div className="ra-filters"><select value={findingTypeFilter} onChange={event => setFindingTypeFilter(event.target.value as 'all' | ReviewFindingType)}><option value="all">全部类型</option>{Object.entries(findingTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><select value={severityFilter} onChange={event => setSeverityFilter(event.target.value as 'all' | ReviewSeverity)}><option value="all">全部严重度</option>{Object.entries(severityLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><select value={findingStateFilter} onChange={event => setFindingStateFilter(event.target.value as 'all' | FindingState)}><option value="all">全部状态</option>{Object.entries(findingStateLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>{visibleFindings.map(finding => {
    const state = selectedRun ? findingStates[`${selectedRun.id}:${finding.clientFindingId}`] ?? 'open' : 'open'
    const evidence = evidenceForFinding(finding, result)
    return <article className="ra-finding-card" key={finding.clientFindingId}><header><div><Badge tone={severityTone(finding.severity)}>{severityLabels[finding.severity]}</Badge><span><small>{findingTypeLabels[finding.type]} · {finding.clientFindingId}</small><h3>{finding.title}</h3></span></div><Badge tone={state === 'resolved' ? 'green' : state === 'dismissed' ? 'gray' : 'orange'}>{findingStateLabels[state]}</Badge></header><div className="ra-finding-refs">{finding.requirementPointRefs.length ? finding.requirementPointRefs.map(ref => <span key={ref}>{ref}</span>) : <span className="global">🌐 整体需求问题</span>}</div><p>{finding.description}</p><dl><div><dt>影响</dt><dd>{finding.impact}</dd></div><div><dt>建议</dt><dd>{finding.recommendation}</dd></div></dl><footer><span>置信度 {Math.round(finding.confidence * 100)}% · {evidence.length} 条证据</span><div>{evidence.slice(0, 2).map(item => <button key={item.clientEvidenceId} onClick={() => onEvidence(item)}><BookOpen />查看原文</button>)}<select value={state} onChange={event => onState(finding, event.target.value as FindingState)}>{Object.entries(findingStateLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div></footer></article>
  })}{!visibleFindings.length && <div className="ra-empty compact"><ListFilter /><b>没有匹配的问题</b></div>}</div>
}

function Report({ result }: { result?: RequirementAnalysisResponse['result'] }) {
  if (!result) return <div className="ra-empty"><FileText /><h2>暂无分析报告</h2><p>完成一次需求分析后显示正式 Markdown Artifact。</p></div>
  const artifact = result.artifacts.find(item => item.fileName === 'requirement-analysis.md')
  return <div className="ra-report"><header><div><FileText /><span><h2>需求分析报告</h2><p>正式 Knowledge Artifact，可作为后续 Test Design 输入。</p></span></div><Badge tone="green">requirement-analysis.md</Badge></header><div className="ra-report-meta"><span>SHA-256</span><code>{artifact?.contentSha256 ?? '-'}</code></div><div className="ra-markdown"><MarkdownDocument source={artifact?.content ?? result.analysisDocument ?? ''} format="markdown" /></div></div>
}

function Diff({ versions, value, onChange, loading, removed, added }: { versions: NonNullable<KnowledgeDocument['versions']>; value: [string, string]; onChange: (value: [string, string]) => void; loading: boolean; removed: string[]; added: string[] }) {
  if (versions.length < 2) return <div className="ra-empty"><FileDiff /><h2>暂无可比较版本</h2><p>当前需求文档至少需要两个 ready 版本。</p></div>
  return <div className="ra-diff"><header><div><span>基准版本</span><select value={value[0]} onChange={event => onChange([event.target.value, value[1]])}>{versions.map(item => <option value={item.id} key={item.id}>V{item.number}</option>)}</select></div><div><span>目标版本</span><select value={value[1]} onChange={event => onChange([value[0], event.target.value])}>{versions.map(item => <option value={item.id} key={item.id}>V{item.number}</option>)}</select></div></header>{loading ? <div className="ra-empty"><LoaderCircle className="rotating" /><b>正在读取固定版本</b></div> : <div className="ra-diff-grid"><section><h3>删除内容 <span>{removed.length}</span></h3>{removed.map((line, index) => <p className="removed" key={`${index}-${line}`}>− {line}</p>)}</section><section><h3>新增内容 <span>{added.length}</span></h3>{added.map((line, index) => <p className="added" key={`${index}-${line}`}>+ {line}</p>)}</section></div>}</div>
}

function AgentTrace({ run }: { run?: RunRecord }) {
  if (!run) return <div className="ra-agent-empty"><Bot /><b>等待启动 Pi Agent</b><p>Agent 的 Workspace 读取、Knowledge 查询和提交过程会显示在这里。</p></div>
  const execution = run.response?.executions?.requirementAnalysis ?? run.executions?.requirementAnalysis ?? (run.execution?.agentKey === 'requirement-analysis' ? run.execution : undefined)
  const events = execution?.events ?? []
  const visible = events.filter(event => event.type === 'message_end' || event.type === 'tool_execution_end' || event.type === 'tool_execution_start' || event.type === 'result_submission_required' || event.type === 'result_submission_retry')
  return <div className="ra-agent-trace"><div className="ra-agent-summary"><Activity /><span><b>RequirementAnalysisAgent</b><small>{execution?.turns ?? 0} Turn · {execution?.toolCalls ?? 0} 次工具调用</small></span></div>{visible.slice(-80).map(event => <TraceEvent event={event} key={event.sequence} />)}{!visible.length && <div className="ra-agent-empty compact"><LoaderCircle className={run.status === 'running' ? 'rotating' : ''} /><b>{run.status === 'running' ? '等待首个 Agent 事件' : '该运行没有可展示 Trace'}</b></div>}</div>
}

function TraceEvent({ event }: { event: AgentExecutionEvent }) {
  if (event.type === 'message_end') return <article className="ra-trace-message"><header><Bot /><b>{event.role === 'user' ? '任务输入' : event.model ?? 'Agent'}</b><small>Turn {event.turn ?? 0}</small></header>{event.content ? <p>{event.content.length > 500 ? `${event.content.slice(0, 500)}…` : event.content}</p> : null}</article>
  if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
    const label = event.toolId?.includes('list_directory') || event.toolId === 'ls' ? '查看目录' : event.toolId?.includes('find_files') || event.toolId === 'find' ? '查找文件' : event.toolId?.includes('grep_files') || event.toolId === 'grep' ? '搜索正文' : event.toolId?.includes('read_file') || event.toolId === 'read' ? '读取文件' : event.toolId?.includes('knowledge.search') ? '查询 Knowledge' : event.toolId?.includes('knowledge.read') ? '读取 Knowledge' : event.toolId?.includes('submit') ? '提交分析结果' : event.toolId ?? '工具调用'
    return <article className={`ra-trace-tool ${event.isError ? 'failed' : ''}`}><Activity /><span><b>{label}</b><small>{event.toolId} · Turn {event.turn ?? 0}</small></span><Badge tone={event.type === 'tool_execution_start' ? 'orange' : event.isError ? 'red' : 'green'}>{event.type === 'tool_execution_start' ? '执行中' : event.isError ? '失败' : '完成'}</Badge></article>
  }
  return <article className="ra-trace-control"><Sparkles /><span>{event.type === 'result_submission_required' ? '进入结果提交窗口' : '结果需要修正后重新提交'}</span></article>
}
