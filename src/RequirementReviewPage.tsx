import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, AlertTriangle, BookOpen, Bot, CheckCircle2, ChevronRight, CircleHelp, Clock3, Download, FileDiff,
  FileText, GitBranch, ListFilter, LoaderCircle, MessageSquareText, PanelLeftClose, PanelLeftOpen,
  PanelRightClose, PanelRightOpen, Play, Quote, RefreshCw, Send, ShieldCheck, Sparkles, Upload, Wrench, XCircle,
} from 'lucide-react'
import type { GenerativeSourceDraft, KnowledgeDocument } from './prototype-data'
import { loadAssetVersion, loadGenerativeModelSources, uploadKnowledgeArchive, uploadKnowledgeFile, waitForTaskResults } from './knowledge-api'
import { MarkdownDocument } from './MarkdownDocument'
import { emptyMarkdownOutline, parseMarkdownOutline } from './markdown-outline'
import {
  askRequirementReviewQuestion,
  cancelRequirementReviewRun,
  loadRequirementReviewRun,
  loadRequirementReviewRuns,
  startRequirementAnalysis,
  type AgentExecutionEvent,
  type RequirementAnalysisResponse,
  type ReviewEvidence,
  type ReviewFinding,
  type ReviewFindingType,
  type ReviewSeverity,
  type RequirementReviewRun,
  type ReviewQuestionQuote,
} from './requirement-analysis-api'
import { bindRequirementVersion, loadRequirementBindings, unbindRequirementVersion, type ProjectVersion, type RequirementBinding } from './project-version-api'

type Notify = (message: string, tone?: 'success' | 'error' | 'warning') => void
type ViewKey = 'overview' | 'source' | 'diff' | 'tree' | 'evidence'
type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'
type FindingState = 'open' | 'confirmed' | 'dismissed' | 'resolved' | 'needs_follow_up'
type SourceQuote = ReviewQuestionQuote
type ChatMessage = { role: 'user' | 'assistant' | 'system'; text: string; quote?: SourceQuote; citations?: string[]; limitations?: string[]; modelLabel?: string }
type UploadProgress = { stage: 'reading' | 'submitting' | 'processing' | 'binding' | 'completed' | 'failed'; percent: number; detail: string }

type RunRecord = RequirementReviewRun & { content?: string }

type ModelChoice = {
  key: string
  sourceId: string
  modelId: string
  label: string
  healthy: boolean
}

const findingTypeLabels: Record<ReviewFindingType, string> = {
  missing_requirement: '需求缺口', ambiguity: '需求歧义', conflict: '逻辑冲突', boundary_gap: '边界条件', state_gap: '状态缺口',
  exception_gap: '异常场景', security_risk: '安全风险', testability_gap: '验收/测试风险', dependency_risk: '依赖风险', other: '其他问题',
}
const severityLabels: Record<ReviewSeverity, string> = { critical: '阻断', high: '高', medium: '中', low: '低', info: '提示' }
const findingStateLabels: Record<FindingState, string> = { open: '待处理', confirmed: '已确认', dismissed: '已驳回', resolved: '已解决', needs_follow_up: '待跟进' }
const viewTabs: { key: ViewKey; label: string; icon: typeof BookOpen }[] = [
  { key: 'overview', label: '评审概览', icon: Sparkles },
  { key: 'source', label: '原始文档', icon: BookOpen },
  { key: 'diff', label: '版本差异', icon: FileDiff },
  { key: 'tree', label: '需求点', icon: GitBranch },
  { key: 'evidence', label: '证据引用', icon: ShieldCheck },
]

function ReviewBadge({ children, tone = 'gray' }: { children: React.ReactNode; tone?: string }) {
  return <span className={`rr-badge ${tone}`}>{children}</span>
}

function ReviewModal({ title, onClose, children, className = 'rr-binding-modal' }: { title: string; onClose: () => void; children: React.ReactNode; className?: string }) {
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><div className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="icon-btn" onClick={onClose} aria-label={`关闭${title}`}><XCircle /></button></header>{children}</div></div>
}

const severityTone = (severity: ReviewSeverity) => severity === 'critical' ? 'red' : severity === 'high' ? 'orange' : severity === 'medium' ? 'gold' : severity === 'low' ? 'blue' : 'gray'
const runTone = (status?: RunStatus) => status === 'succeeded' ? 'green' : status === 'running' ? 'purple' : status === 'failed' ? 'red' : status === 'cancelled' ? 'orange' : 'gray'
const runLabel = (status?: RunStatus) => status === 'succeeded' ? '评审完成' : status === 'running' ? '分析中' : status === 'failed' ? '运行失败' : status === 'cancelled' ? '已取消' : '待评审'
const runErrorMessage = (error?: string) => error === 'AGENT_TURN_LIMIT_EXCEEDED'
  ? 'Agent 达到本次运行轮次上限，仍未提交有效评审结果。请重新评审；若持续出现，请调整当前项目版本的需求范围或更换模型。'
  : error
const formatTime = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })
const taskStepLabel = (step: string) => ({ waiting: '等待 Worker', claimed: '任务已领取', embedding: '解析并生成 Embedding', vector_indexing: '构建向量索引', committing: '发布活动索引', completed: '索引发布完成', failed: '任务处理失败', cancelled: '任务已取消', superseded: '已被新版本替代' } as Record<string, string>)[step] ?? '正在处理知识资产'
const completedUploadVisibleMs = 15_000

const agentEventLabels: Record<string, string> = {
  runtime_initialized: 'Runtime 初始化',
  agent_start: 'Agent 开始', agent_end: 'Agent 本轮结束', turn_start: 'Turn 开始', turn_end: 'Turn 结束',
  message_start: '消息开始', message_update: '消息流更新', message_end: '消息完成',
  tool_execution_start: '工具调用开始', tool_execution_update: '工具调用更新', tool_execution_end: '工具调用结束',
  result_submission_required: '进入结果提交窗口', result_submission_retry: '要求重新提交结果',
}

function eventTime(value: string) { return new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) }
function formatTraceValue(value: unknown) { return value === undefined ? '' : JSON.stringify(value, null, 2) }

function RunRecordModal({ run, loading, tab, onTab, onClose }: { run: RunRecord; loading: boolean; tab: 'conversation' | 'events'; onTab: (tab: 'conversation' | 'events') => void; onClose: () => void }) {
  const execution = run.response?.execution ?? run.execution
  const events = execution?.events ?? []
  const toolStarts = new Map(events.filter(event => event.type === 'tool_execution_start' && event.toolCallId).map(event => [event.toolCallId!, event]))
  const completedToolIds = new Set(events.filter(event => event.type === 'tool_execution_end' && event.toolCallId).map(event => event.toolCallId))
  const conversation = events.filter(event => (event.type === 'message_end' && (event.role === 'user' || event.role === 'assistant'))
    || event.type === 'tool_execution_end'
    || (event.type === 'tool_execution_start' && !completedToolIds.has(event.toolCallId))
    || event.type === 'result_submission_required'
    || event.type === 'result_submission_retry')
  const hasDetailedTrace = events.some(event => event.content || event.toolArguments !== undefined || event.toolResult !== undefined || event.toolCalls?.length)

  return <ReviewModal title="Agent 运行记录" className="rr-run-record-modal" onClose={onClose}><div className="rr-run-record">
    <div className="rr-run-record-summary"><div><ReviewBadge tone={runTone(run.status)}>{runLabel(run.status)}</ReviewBadge><b>{run.id}</b><span>{run.modelLabel}</span></div><dl><div><dt>开始</dt><dd>{formatTime(run.startedAt)}</dd></div><div><dt>Turn</dt><dd>{execution?.turns ?? 0}</dd></div><div><dt>工具调用</dt><dd>{execution?.toolCalls ?? 0}{execution?.toolErrors ? `（异常 ${execution.toolErrors}）` : ''}</dd></div><div><dt>Runtime</dt><dd>{execution?.framework ? `${execution.framework.name} ${execution.framework.version}` : run.status === 'running' ? '运行中' : '未完成 / 旧记录'}</dd></div></dl></div>
    {run.error && <div className="rr-run-record-error"><AlertTriangle /><span><b>终止原因</b>{runErrorMessage(run.error)}</span></div>}
    <div className="rr-run-record-notice"><ShieldCheck /><span>记录模型可见消息、工具参数与工具返回；API 凭据、签名、图片二进制和模型隐藏思维不会写入运行记录。</span></div>
    <div className="rr-run-record-tabs"><button className={tab === 'conversation' ? 'active' : ''} onClick={() => onTab('conversation')}><MessageSquareText />Agent 对话 <span>{conversation.length}</span></button><button className={tab === 'events' ? 'active' : ''} onClick={() => onTab('events')}><Activity />事件时间线 <span>{events.length}</span></button></div>
    <div className="rr-run-record-body">{loading ? <div className="rr-trace-empty"><LoaderCircle className="rotating" /><b>正在读取运行记录</b></div> : tab === 'conversation' ? <div className="rr-agent-conversation">
      {conversation.map(event => {
        if (event.type === 'message_end') return <article className={`rr-agent-message ${event.role}`} key={event.sequence}><header><span>{event.role === 'user' ? <FileText /> : <Bot />}{event.role === 'user' ? '运行任务' : event.model ?? run.modelLabel}</span><small>Turn {event.turn ?? 0} · {eventTime(event.occurredAt)}</small></header>{event.content ? <p>{event.content}</p> : null}{event.toolCalls?.length ? <div className="rr-agent-tool-requests">{event.toolCalls.map(call => <span key={call.id}><Wrench />请求 {call.name}</span>)}</div> : null}{event.usage && <footer>Token：输入 {event.usage.input} · 输出 {event.usage.output} · 缓存读取 {event.usage.cacheRead} · 总计 {event.usage.totalTokens} · {event.stopReason ?? '未知停止原因'}</footer>}</article>
        if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
          const start = event.type === 'tool_execution_start' ? event : toolStarts.get(event.toolCallId ?? '')
          return <article className={`rr-agent-tool ${event.isError ? 'failed' : ''}`} key={event.sequence}><header><span><Wrench />{event.toolId ?? start?.toolId ?? '未知工具'}</span><ReviewBadge tone={event.type === 'tool_execution_start' ? 'orange' : event.isError ? 'red' : 'green'}>{event.type === 'tool_execution_start' ? '执行中' : event.isError ? '失败' : '完成'}</ReviewBadge><small>Turn {event.turn ?? start?.turn ?? 0} · {eventTime(event.occurredAt)}</small></header><div><details><summary>查看调用参数</summary><pre>{formatTraceValue(start?.toolArguments) || '该历史记录未保存参数'}</pre></details>{event.type === 'tool_execution_end' && <details><summary>查看工具返回</summary><pre>{formatTraceValue(event.toolResult) || '该历史记录未保存返回内容'}</pre></details>}</div><footer>{event.toolCallId}</footer></article>
        }
        return <div className="rr-agent-control" key={event.sequence}><Sparkles /><span><b>{agentEventLabels[event.type] ?? event.type}</b><small>Turn {event.turn ?? 0} · {eventTime(event.occurredAt)}</small></span></div>
      })}
      {!conversation.length && <div className="rr-trace-empty"><MessageSquareText /><b>{run.status === 'running' ? '等待首个 Agent Turn 完成' : '没有可展示的 Agent 对话'}</b><p>{events.length ? '这是一条旧运行，只保存了生命周期元数据。请发起新评审以采集完整对话和工具交互。' : '该运行创建时尚未启用交互记录。'}</p></div>}
      {conversation.length > 0 && !hasDetailedTrace && <div className="rr-trace-legacy"><AlertTriangle />旧运行只保存事件点，没有保存消息正文和工具参数/返回。</div>}
    </div> : <div className="rr-agent-events">{events.map(event => <article key={event.sequence}><i className={event.isError ? 'failed' : event.type.includes('tool') ? 'tool' : event.type.includes('message') ? 'message' : ''} /><span><b>{agentEventLabels[event.type] ?? event.type}</b><small>#{event.sequence} · Turn {event.turn ?? 0}{event.toolId ? ` · ${event.toolId}` : ''}{event.role ? ` · ${event.role}` : ''}</small></span><time>{eventTime(event.occurredAt)}</time></article>)}{!events.length && <div className="rr-trace-empty"><Activity /><b>暂无事件记录</b><p>{run.status === 'running' ? '首个 Turn 完成后会同步到这里。' : '该历史运行未采集执行事件。'}</p></div>}</div>}</div>
  </div></ReviewModal>
}

export function RequirementReviewPage({
  projectVersion,
  documents,
  knowledgeBaseId,
  apiState,
  refreshKnowledge,
  onManageVersions,
  onOpenKnowledge,
  onOpenActivity,
  notify,
  addAudit,
}: {
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
}) {
  const [bindings, setBindings] = useState<RequirementBinding[]>([])
  const [boundDocuments, setBoundDocuments] = useState<KnowledgeDocument[]>([])
  const [bindingsState, setBindingsState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const availableRequirementDocuments = useMemo(() => documents.filter(document => document.assetType === 'requirement' && document.status === 'ready' && document.assetVersionId), [documents])
  const requirementDocuments = boundDocuments
  const [selectedAssetId, setSelectedAssetId] = useState('')
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [chatCollapsed, setChatCollapsed] = useState(false)
  const [view, setView] = useState<ViewKey>('overview')
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [runsState, setRunsState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [runsCursor, setRunsCursor] = useState<string | undefined>()
  const [runsLoadingMore, setRunsLoadingMore] = useState(false)
  const [contentByVersion, setContentByVersion] = useState<Record<string, string>>({})
  const [selectedRunId, setSelectedRunId] = useState('')
  const [models, setModels] = useState<GenerativeSourceDraft[]>([])
  const [modelsState, setModelsState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [selectedModelKey, setSelectedModelKey] = useState('')
  const [selectedFindingId, setSelectedFindingId] = useState('')
  const [selectedEvidenceId, setSelectedEvidenceId] = useState('')
  const [activeSectionKey, setActiveSectionKey] = useState<string | null>(null)
  const [outlineCollapsed, setOutlineCollapsed] = useState(false)
  const [findingTypeFilter, setFindingTypeFilter] = useState<'all' | ReviewFindingType>('all')
  const [severityFilter, setSeverityFilter] = useState<'all' | ReviewSeverity>('all')
  const [basisFilter, setBasisFilter] = useState<'all' | 'evidence' | 'inference'>('all')
  const [findingStateFilter, setFindingStateFilter] = useState<'all' | FindingState>('all')
  const [findingStates, setFindingStates] = useState<Record<string, FindingState>>({})
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const [sourceQuote, setSourceQuote] = useState<SourceQuote | null>(null)
  const [chatDraft, setChatDraft] = useState('')
  const [chatMessages, setChatMessages] = useState<Record<string, ChatMessage[]>>({})
  const [chatSendingRunId, setChatSendingRunId] = useState('')
  const [diffVersionIds, setDiffVersionIds] = useState<[string, string]>(['', ''])
  const [diffContents, setDiffContents] = useState<Record<string, string>>({})
  const [diffLoading, setDiffLoading] = useState(false)
  const [uploadState, setUploadState] = useState<'idle' | 'running'>('idle')
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null)
  const [bindingManagerOpen, setBindingManagerOpen] = useState(false)
  const [bindingActionId, setBindingActionId] = useState('')
  const [runRecordOpen, setRunRecordOpen] = useState(false)
  const [runRecordTab, setRunRecordTab] = useState<'conversation' | 'events'>('conversation')
  const [runRecordLoading, setRunRecordLoading] = useState(false)
  const requestController = useRef<AbortController | null>(null)
  const sourceRef = useRef<HTMLDivElement>(null)
  const outlineRef = useRef<HTMLElement>(null)
  const pendingSectionScroll = useRef<string | null>(null)
  const uploadRef = useRef<HTMLInputElement>(null)
  const readOnly = projectVersion?.status !== 'open'

  useEffect(() => {
    if (uploadProgress?.stage !== 'completed') return
    const timer = window.setTimeout(() => {
      setUploadProgress(current => current?.stage === 'completed' ? null : current)
    }, completedUploadVisibleMs)
    return () => window.clearTimeout(timer)
  }, [uploadProgress?.stage])

  const refreshBindings = async () => {
    if (!projectVersion) { setBindings([]); setBoundDocuments([]); setBindingsState('ready'); return }
    setBindingsState('loading')
    try {
      const loadedBindings = await loadRequirementBindings(projectVersion.id)
      const resolved = loadedBindings
        .filter(binding => binding.version.status === 'ready')
        .map(binding => {
          const base = documents.find(document => document.id === binding.assetId)
          return {
            id: binding.assetId,
            name: binding.asset.displayName,
            parentId: base?.parentId ?? null,
            version: `V${binding.version.number}`,
            updated: formatTime(binding.version.readyAt ?? binding.version.createdAt),
            title: base?.title ?? binding.asset.displayName.replace(/\.(md|txt)$/iu, ''),
            intro: base?.intro ?? '打开原始文档时加载正文',
            sections: base?.sections ?? [],
            assetType: binding.asset.assetType,
            sourceType: binding.asset.sourceType,
            assetVersionId: binding.version.id,
            versions: binding.versions,
            status: binding.version.status,
            logicalPath: binding.asset.logicalPath,
          } satisfies KnowledgeDocument
        })
      setBindings(loadedBindings)
      setBoundDocuments(resolved)
      setBindingsState('ready')
    } catch (error) {
      setBindingsState('failed')
      notify(error instanceof Error ? error.message : '需求版本绑定读取失败', 'error')
    }
  }

  useEffect(() => { void refreshBindings() }, [projectVersion?.id, documents])

  useEffect(() => {
    let cancelled = false
    if (!projectVersion) { setRuns([]); setRunsCursor(undefined); setRunsState('ready'); return }
    setRunsState('loading')
    loadRequirementReviewRuns(projectVersion.id).then(page => {
      if (!cancelled) { setRuns(page.items); setRunsCursor(page.nextCursor); setRunsState('ready') }
    }).catch(error => {
      if (!cancelled) { setRuns([]); setRunsCursor(undefined); setRunsState('failed'); notify(error instanceof Error ? error.message : '需求评审历史读取失败', 'error') }
    })
    return () => { cancelled = true }
  }, [projectVersion?.id])

  const hasRunningRuns = runs.some(run => run.status === 'running')
  useEffect(() => {
    if (!projectVersion || !hasRunningRuns) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const page = await loadRequirementReviewRuns(projectVersion.id, { runningOnly: true })
        if (cancelled) return
        const active = new Map(page.items.map(run => [run.id, run]))
        setRuns(current => current.map(run => active.get(run.id) ?? (run.status === 'running' ? { ...run, status: 'succeeded', step: 'completed', progress: 100 } : run)))
        if (page.items.some(run => run.error?.startsWith('MODEL_TOOL_CALL_REQUIRED:'))) {
          void loadGenerativeModelSources().then(setModels).catch(() => undefined)
        }
        if (page.items.length) timer = setTimeout(() => { void poll() }, 1_000)
      } catch {
        if (!cancelled) timer = setTimeout(() => { void poll() }, 2_000)
      }
    }
    timer = setTimeout(() => { void poll() }, 500)
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [hasRunningRuns, projectVersion?.id])

  const selectedDocument = requirementDocuments.find(document => document.id === selectedAssetId) ?? requirementDocuments[0]
  const selectedRun = runs.find(run => run.id === selectedRunId)
  const result = selectedRun?.response?.result
  const evidenceById = useMemo(() => new Map((result?.evidence ?? []).map(evidence => [evidence.clientEvidenceId, evidence])), [result])
  const documentContent = contentByVersion[selectedDocument?.assetVersionId ?? ''] ?? selectedDocument?.content ?? ''
  const documentVersionId = selectedDocument?.assetVersionId ?? ''
  const documentFormat = selectedDocument?.name.toLowerCase().endsWith('.txt') ? 'text' : 'markdown'
  const outline = useMemo(() => documentFormat === 'markdown' && documentContent ? parseMarkdownOutline(documentContent) : emptyMarkdownOutline, [documentContent, documentFormat])

  const modelChoices = useMemo<ModelChoice[]>(() => models.flatMap(source => source.models
    .filter(model => source.enabled && model.enabled && model.capabilities.includes('tool_calling'))
    .map(model => ({ key: `${source.id}::${model.id}`, sourceId: source.id, modelId: model.id, label: `${source.name} · ${model.displayName}`, healthy: model.health === 'healthy' }))), [models])
  const selectedModel = modelChoices.find(model => model.key === selectedModelKey)

  useEffect(() => {
    if (!selectedAssetId || !requirementDocuments.some(document => document.id === selectedAssetId)) setSelectedAssetId(requirementDocuments[0]?.id ?? '')
  }, [requirementDocuments, selectedAssetId])

  useEffect(() => {
    const latestRun = runs[0]
    setSelectedRunId(latestRun?.id ?? '')
    setSelectedFindingId('')
    setSelectedEvidenceId('')
    setSourceQuote(null)
    setView('overview')
  }, [runsState])

  useEffect(() => {
    let cancelled = false
    loadGenerativeModelSources().then(items => {
      if (cancelled) return
      setModels(items)
      setModelsState('ready')
    }).catch(() => { if (!cancelled) setModelsState('failed') })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!modelChoices.some(model => model.key === selectedModelKey)) setSelectedModelKey(modelChoices.find(model => model.healthy)?.key ?? modelChoices[0]?.key ?? '')
  }, [modelChoices, selectedModelKey])

  useEffect(() => {
    if (!selectedRun?.id || selectedRun.response || selectedRun.status === 'running') return
    let cancelled = false
    void loadRequirementReviewRun(selectedRun.id).then(detail => {
      if (!cancelled) setRuns(current => current.map(run => run.id === detail.id ? { ...run, ...detail } : run))
    }).catch(error => { if (!cancelled) notify(error instanceof Error ? error.message : '需求评审详情读取失败', 'error') })
    return () => { cancelled = true }
  }, [selectedRun?.id, selectedRun?.response, selectedRun?.status, notify])

  useEffect(() => {
    if (!runRecordOpen || !selectedRun?.id || selectedRun.status !== 'running' || selectedRun.id.startsWith('pending-')) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const detail = await loadRequirementReviewRun(selectedRun.id)
        if (cancelled) return
        setRuns(current => current.map(run => run.id === detail.id ? { ...run, ...detail } : run))
        if (detail.status === 'running') timer = setTimeout(() => { void poll() }, 1_000)
      } catch {
        if (!cancelled) timer = setTimeout(() => { void poll() }, 2_000)
      }
    }
    timer = setTimeout(() => { void poll() }, 1_000)
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [runRecordOpen, selectedRun?.id, selectedRun?.status])

  const sourceVersionId = selectedDocument?.assetVersionId
  useEffect(() => {
    if (view !== 'source' || !sourceVersionId || contentByVersion[sourceVersionId]) return
    let cancelled = false
    void loadAssetVersion(sourceVersionId).then(version => {
      if (!cancelled) setContentByVersion(current => ({ ...current, [version.id]: version.content ?? '' }))
    }).catch(error => { if (!cancelled) notify(error instanceof Error ? error.message : '固定版本读取失败', 'error') })
    return () => { cancelled = true }
  }, [contentByVersion, notify, sourceVersionId, view])

  useEffect(() => {
    const history = (selectedDocument?.versions ?? []).filter(item => item.status === 'ready')
    const right = selectedDocument?.assetVersionId ?? history.at(-1)?.id ?? ''
    const rightIndex = history.findIndex(item => item.id === right)
    const left = history[Math.max(0, rightIndex - 1)]?.id ?? history.at(-2)?.id ?? ''
    setDiffVersionIds([left && left !== right ? left : '', right])
    setDiffContents({})
  }, [selectedDocument?.id, selectedDocument?.assetVersionId])

  useEffect(() => {
    if (view !== 'diff') return
    const ids = diffVersionIds.filter(Boolean)
    const missing = ids.filter(id => !(id in diffContents))
    if (!missing.length) return
    let cancelled = false
    setDiffLoading(true)
    Promise.all(missing.map(async id => [id, (await loadAssetVersion(id)).content] as const)).then(entries => {
      if (!cancelled) setDiffContents(current => ({ ...current, ...Object.fromEntries(entries) }))
    }).catch(error => { if (!cancelled) notify(error instanceof Error ? error.message : '固定版本读取失败', 'error') })
      .finally(() => { if (!cancelled) setDiffLoading(false) })
    return () => { cancelled = true }
  }, [diffContents, diffVersionIds, notify, view])

  const scrollToSection = (key: string) => {
    const scroller = sourceRef.current
    const target = scroller?.querySelector<HTMLElement>(`[data-document-section-key="${key}"]`)
    if (!scroller || !target) return
    const scrollerTop = scroller.getBoundingClientRect().top
    const targetTop = target.getBoundingClientRect().top
    scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + targetTop - scrollerTop - 16), behavior: 'smooth' })
  }

  const activateSection = (key: string) => {
    pendingSectionScroll.current = key
    setActiveSectionKey(key)
    if (view !== 'source') { setView('source'); return }
    requestAnimationFrame(() => {
      if (pendingSectionScroll.current !== key) return
      pendingSectionScroll.current = null
      scrollToSection(key)
    })
  }

  useEffect(() => {
    if (view !== 'source') return
    const scroller = sourceRef.current
    if (!scroller) return
    const updateActiveSection = () => {
      const headings = Array.from(scroller.querySelectorAll<HTMLElement>('[data-document-section-key]'))
      if (!headings.length) { setActiveSectionKey(null); return }
      const scrollerTop = scroller.getBoundingClientRect().top + 24
      const current = headings.reduce((active, heading) => heading.getBoundingClientRect().top <= scrollerTop ? heading : active, headings[0])
      const key = current.dataset.documentSectionKey
      if (!key) return
      setActiveSectionKey(active => active === key ? active : key)
      outlineRef.current?.querySelector<HTMLElement>(`[data-outline-section-key="${key}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    const pendingKey = pendingSectionScroll.current
    if (pendingKey) {
      pendingSectionScroll.current = null
      scrollToSection(pendingKey)
    }
    updateActiveSection()
    scroller.addEventListener('scroll', updateActiveSection, { passive: true })
    return () => scroller.removeEventListener('scroll', updateActiveSection)
  }, [documentContent, documentVersionId, view])

  useEffect(() => () => requestController.current?.abort(), [])

  const reviewRuns = runs
  const selectRun = (runId: string) => {
    const run = runs.find(item => item.id === runId)
    if (!run) return
    setSelectedAssetId(run.documents?.[0]?.assetId ?? run.assetId)
    setSelectedRunId(run.id)
    setSelectedFindingId('')
    setSelectedEvidenceId('')
    setSourceQuote(null)
    setView('overview')
  }

  const loadMoreRuns = async () => {
    if (!projectVersion || !runsCursor || runsLoadingMore) return
    setRunsLoadingMore(true)
    try {
      const page = await loadRequirementReviewRuns(projectVersion.id, { cursor: runsCursor })
      setRuns(current => [...current, ...page.items.filter(item => !current.some(run => run.id === item.id))])
      setRunsCursor(page.nextCursor)
    } catch (error) {
      notify(error instanceof Error ? error.message : '更多评审历史读取失败', 'error')
    } finally {
      setRunsLoadingMore(false)
    }
  }

  const openRunRecord = async () => {
    if (!selectedRun || selectedRun.id.startsWith('pending-')) return
    setRunRecordOpen(true)
    setRunRecordTab('conversation')
    setRunRecordLoading(true)
    try {
      const detail = await loadRequirementReviewRun(selectedRun.id)
      setRuns(current => current.map(run => run.id === detail.id ? { ...run, ...detail } : run))
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Agent 运行记录读取失败', 'error')
    } finally {
      setRunRecordLoading(false)
    }
  }

  const startAnalysis = async () => {
    const fixedDocuments = requirementDocuments.filter(document => document.assetVersionId)
    if (!fixedDocuments.length || !selectedModel || !selectedModel.healthy || requestController.current) return
    const controller = new AbortController()
    requestController.current = controller
    const temporaryId = `pending-${Date.now()}`
    const startedAt = new Date().toISOString()
    const pendingRun: RunRecord = {
      id: temporaryId,
      projectVersionId: projectVersion!.id,
      assetId: fixedDocuments[0].id,
      assetVersionId: fixedDocuments[0].assetVersionId!,
      assetIds: fixedDocuments.map(document => document.id),
      assetVersionIds: fixedDocuments.map(document => document.assetVersionId!),
      documents: fixedDocuments.map(document => ({ assetId: document.id, assetVersionId: document.assetVersionId!, assetContentHash: '', logicalPath: document.logicalPath ?? document.name, displayName: document.name })),
      documentTitle: `${fixedDocuments.length} 份需求文档`,
      documentVersion: '固定批次',
      logicalPath: fixedDocuments.map(document => document.logicalPath ?? document.name).join('；'),
      createdAt: startedAt,
      status: 'running',
      step: 'agent_executing',
      progress: 10,
      modelLabel: selectedModel.label,
      startedAt,
    }
    setRuns(current => [pendingRun, ...current])
    setSelectedRunId(temporaryId)
    setView('overview')
    addAudit(`启动多文档需求点提取与评审：${fixedDocuments.length} 份固定文档`)
    try {
      const started = await startRequirementAnalysis(projectVersion!.id, {
        assetVersionIds: fixedDocuments.map(document => document.assetVersionId!),
        sourceId: selectedModel.sourceId,
        modelId: selectedModel.modelId,
        focusAreas: ['功能完整性', '异常流程', '边界条件', '可测试性'],
      }, controller.signal)
      setRuns(current => current.map(run => run.id === temporaryId ? started : run))
      setSelectedRunId(started.id)
      addAudit(`多文档需求点提取与评审已进入后台运行：${started.id}`)
      notify(`已固定 ${fixedDocuments.length} 份文档，正在提取需求点并评审。刷新或切换页面不会取消。`)
    } catch (error) {
      const message = controller.signal.aborted ? '评审启动响应已中断；若任务已创建，重新进入页面后仍可恢复查看' : error instanceof Error ? error.message : '需求评审启动失败'
      setRuns(current => current.map(run => run.id === temporaryId ? { ...run, status: 'failed', step: 'failed', error: message } : run))
      addAudit('启动多文档需求点提取与评审失败')
      notify(message, controller.signal.aborted ? 'warning' : 'error')
    } finally {
      requestController.current = null
    }
  }

  const cancelAnalysis = async () => {
    if (!selectedRun || selectedRun.status !== 'running' || selectedRun.id.startsWith('pending-')) return
    try {
      const cancelled = await cancelRequirementReviewRun(selectedRun.id)
      setRuns(current => current.map(run => run.id === cancelled.id ? { ...cancelled, content: run.content } : run))
      addAudit(`用户取消需求点提取与评审：${selectedRun.id}`)
      notify('已取消本次需求评审。', 'warning')
    } catch (error) {
      notify(error instanceof Error ? error.message : '需求评审取消失败', 'error')
    }
  }

  const uploadRequirements = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    if (!files.length || !knowledgeBaseId || uploadState === 'running' || !projectVersion || readOnly) return
    setUploadState('running')
    setUploadProgress({ stage: 'reading', percent: 2, detail: `正在读取 ${files.length} 个文件` })
    const taskIds: string[] = []
    let documentCount = 0
    let attachmentCount = 0
    let skippedCount = 0
    let deduplicatedCount = 0
    const assetVersionIds: string[] = []
    try {
      for (const [fileIndex, file] of files.entries()) {
        setUploadProgress({ stage: 'submitting', percent: Math.max(5, Math.round(fileIndex / files.length * 15)), detail: `正在提交 ${file.name}（${fileIndex + 1}/${files.length}）` })
        const extension = file.name.split('.').at(-1)?.toLowerCase()
        if (extension === 'zip') {
          const result = await uploadKnowledgeArchive(knowledgeBaseId, file, '需求文档', 'requirement')
          taskIds.push(...result.taskIds)
          assetVersionIds.push(...result.assetVersionIds)
          documentCount += result.documents
          attachmentCount += result.attachments
          skippedCount += result.skipped
          deduplicatedCount += result.deduplicated
          addAudit(`上传需求压缩包：${file.name} · ${result.documents} 篇文档`)
        } else if (extension === 'md' || extension === 'txt') {
          const result = await uploadKnowledgeFile(knowledgeBaseId, file, `需求文档/${file.name}`, 'requirement')
          documentCount += 1
          if (result.task?.id) taskIds.push(result.task.id)
          assetVersionIds.push(result.version.id)
          if (result.deduplicated) deduplicatedCount += 1
          addAudit(`上传需求文档：${file.name}`)
        } else {
          skippedCount += 1
        }
      }
      if (!documentCount) throw new Error('没有可上传的需求文档，仅支持 Markdown、TXT 或包含这些文件的 ZIP。')
      const taskResults = taskIds.length ? await waitForTaskResults(taskIds, { onProgress: progress => setUploadProgress({ stage: 'processing', percent: 15 + Math.round(progress.percent * .7), detail: `${taskStepLabel(progress.currentStep)} · ${progress.completed}/${progress.total} 个任务完成` }) }) : { succeeded: [], failed: [], cancelled: [], pending: [] }
      const bindingErrors: string[] = []
      let boundCount = 0
      const uniqueVersionIds = [...new Set(assetVersionIds)]
      for (const [versionIndex, assetVersionId] of uniqueVersionIds.entries()) {
        setUploadProgress({ stage: 'binding', percent: 85 + Math.round(versionIndex / Math.max(uniqueVersionIds.length, 1) * 14), detail: `正在绑定项目版本（${versionIndex + 1}/${uniqueVersionIds.length}）` })
        try {
          const version = await loadAssetVersion(assetVersionId)
          if (version.status !== 'ready') { bindingErrors.push(`${assetVersionId.slice(0, 12)}：${version.status}`); continue }
          await bindRequirementVersion(projectVersion.id, assetVersionId)
          boundCount += 1
        } catch (error) { bindingErrors.push(error instanceof Error ? error.message : `${assetVersionId.slice(0, 12)}：绑定失败`) }
      }
      await refreshKnowledge()
      await refreshBindings()
      const taskFailures = [...taskResults.failed.map(task => task.error ?? `${task.id} 处理失败`), ...taskResults.cancelled.map(task => `${task.id} 已取消`), ...taskResults.pending.map(task => `${task.id} 仍在处理`)]
      const failures = [...taskFailures, ...bindingErrors]
      if (!boundCount) throw new Error(failures[0] ?? '需求资料未能完成入库和版本绑定')
      const summary = `需求资料已入库并绑定：${boundCount} 篇${attachmentCount ? `、${attachmentCount} 个附件` : ''}${deduplicatedCount ? `，${deduplicatedCount} 篇内容已去重` : ''}${skippedCount ? `，跳过 ${skippedCount} 个不支持文件` : ''}`
      setUploadProgress({ stage: 'completed', percent: 100, detail: summary })
      if (failures.length) notify(`${summary}；另有 ${failures.length} 项未完成：${failures.slice(0, 3).join('；')}`, 'warning')
      else notify(`${summary}。`)
    } catch (error) {
      await refreshKnowledge().catch(() => undefined)
      const message = error instanceof Error ? error.message : '需求资料上传失败'
      setUploadProgress(current => ({ stage: 'failed', percent: current?.percent ?? 0, detail: message }))
      notify(message, 'error')
    } finally {
      setUploadState('idle')
    }
  }

  const locateEvidence = (evidence: ReviewEvidence, findingId?: string) => {
    const sourceDocument = requirementDocuments.find(document => document.assetVersionId === evidence.sourceRef.assetVersionId)
    if (sourceDocument) setSelectedAssetId(sourceDocument.id)
    setSelectedEvidenceId(evidence.clientEvidenceId)
    if (findingId) setSelectedFindingId(findingId)
    setView('source')
  }

  useEffect(() => {
    const evidence = evidenceById.get(selectedEvidenceId)
    if (view !== 'source' || !evidence || evidence.sourceRef.assetVersionId !== documentVersionId || !documentContent) return
    const heading = evidence.locator.heading.trim()
    const section = outline.sections.find(item => item.title === heading || item.title.includes(heading) || heading.includes(item.title))
    if (!section) { setActiveSectionKey(null); return }
    pendingSectionScroll.current = section.key
    setActiveSectionKey(section.key)
    requestAnimationFrame(() => {
      if (pendingSectionScroll.current !== section.key) return
      pendingSectionScroll.current = null
      scrollToSection(section.key)
    })
  }, [documentContent, documentVersionId, evidenceById, outline.sections, selectedEvidenceId, view])

  const locateFinding = (finding: ReviewFinding) => {
    setSelectedFindingId(finding.clientFindingId)
    const evidence = finding.evidenceRefs.map(reference => evidenceById.get(reference)).find(Boolean)
    if (evidence) locateEvidence(evidence, finding.clientFindingId)
    else notify('该 Finding 没有固定证据，已保持为模型推测，不生成原文高亮。', 'warning')
  }

  const updateFindingState = (finding: ReviewFinding, state: FindingState) => {
    if (!selectedRun || readOnly) return
    setFindingStates(current => ({ ...current, [`${selectedRun.id}:${finding.clientFindingId}`]: state }))
    addAudit(`前端处置 ${finding.clientFindingId}：${findingStateLabels[state]}（当前会话）`)
    notify('处置状态已更新；当前后端尚无 Finding Action 接口，仅保留在本次前端会话。', 'warning')
  }

  const quoteFinding = (finding: ReviewFinding) => {
    const evidence = finding.evidenceRefs.map(reference => evidenceById.get(reference)).find(Boolean)
    setSourceQuote({
      text: evidence?.quote ?? finding.description,
      assetVersionId: evidence?.sourceRef.assetVersionId ?? documentVersionId,
      heading: evidence?.locator.heading ?? finding.title,
      findingId: finding.clientFindingId,
    })
    setSelectedFindingId(finding.clientFindingId)
    setChatCollapsed(false)
    setChatDraft(`请解释“${finding.title}”的影响和需要人工确认的内容。`)
  }

  const captureSourceQuote = () => {
    const selection = window.getSelection()
    const text = selection?.toString().trim()
    if (!selection || !text || !sourceRef.current || !selection.rangeCount) return
    const range = selection.getRangeAt(0)
    if (!sourceRef.current.contains(range.commonAncestorContainer)) return
    const element = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement
    const located = element?.closest<HTMLElement>('[data-source-start-line]')
    const headingElement = element?.closest<HTMLElement>('[data-document-section-key]')
    const headingKey = headingElement?.dataset.documentSectionKey
    const heading = outline.sections.find(section => section.key === headingKey)?.title ?? outline.title ?? selectedDocument?.title ?? '原始文档'
    setSourceQuote({
      text: text.slice(0, 500),
      assetVersionId: documentVersionId,
      heading,
      startLine: located?.dataset.sourceStartLine ? Number(located.dataset.sourceStartLine) : undefined,
      endLine: located?.dataset.sourceEndLine ? Number(located.dataset.sourceEndLine) : undefined,
    })
    setChatCollapsed(false)
    notify('已引用固定原文选区，可在右侧继续输入问题。')
  }

  const sendChat = async () => {
    const text = chatDraft.trim()
    if (!selectedRun || selectedRun.status !== 'succeeded' || !text || chatSendingRunId) return
    const key = selectedRun.id
    const quote = sourceQuote ?? undefined
    setChatMessages(current => ({
      ...current,
      [key]: [...(current[key] ?? []), { role: 'user', text, quote }],
    }))
    setChatDraft('')
    setSourceQuote(null)
    setChatSendingRunId(key)
    try {
      const response = await askRequirementReviewQuestion(key, { question: text, quote })
      setChatMessages(current => ({
        ...current,
        [key]: [...(current[key] ?? []), { role: 'assistant', text: response.answer, citations: response.citations, limitations: response.limitations, modelLabel: response.modelLabel }],
      }))
      addAudit(`评审问答：${key} · ${text.slice(0, 60)}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '评审问答失败'
      setChatMessages(current => ({ ...current, [key]: [...(current[key] ?? []), { role: 'system', text: message }] }))
      notify(message, 'error')
    } finally {
      setChatSendingRunId('')
    }
  }

  const exportReport = () => {
    if (!selectedRun?.response) return
    const response = selectedRun.response
    const stateFor = (finding: ReviewFinding) => findingStates[`${selectedRun.id}:${finding.clientFindingId}`] ?? 'open'
    const lines = [
      `# ${projectVersion?.name ?? '当前版本'} · 需求点提取与评审报告`, '',
      `- 运行 ID：${selectedRun.id}`,
      `- 固定输入文档：${(selectedRun.assetVersionIds ?? [selectedRun.assetVersionId]).length} 份`,
      ...(selectedRun.documents ?? []).map(item => `  - ${item.displayName}：${item.assetVersionId}`),
      `- 索引版本：${response.snapshot.indexVersionId}`,
      `- 模型：${selectedRun.modelLabel}`,
      `- 生成时间：${formatTime(response.snapshot.createdAt)}`,
      `- 综合评分：${response.result.summary.score}`, '',
      '## 评审摘要', '',
      ...response.result.summary.risks.map(item => `- 风险：${item}`), '',
      '## 需求点', '',
      ...(response.result.requirementPoints ?? []).flatMap(point => [`### ${point.clientRequirementPointId} · ${point.title}`, '', point.description, '', `- 证据：${point.evidenceRefs.join('、')}`, '']),
      '## Findings', '',
      ...response.result.findings.flatMap((finding, index) => {
        const evidence = finding.evidenceRefs.map(reference => evidenceById.get(reference)).filter((item): item is ReviewEvidence => Boolean(item))
        return [
          `### ${index + 1}. ${finding.title}`, '',
          `- 类型：${findingTypeLabels[finding.type]}`,
          `- 严重度：${severityLabels[finding.severity]}`,
          `- 置信度：${Math.round(finding.confidence * 100)}%`,
          `- 处置状态：${findingStateLabels[stateFor(finding)]}`,
          `- 关联需求点：${finding.requirementPointRefs.join('、')}`,
          `- 问题：${finding.description}`,
          `- 影响：${finding.impact}`,
          `- 建议确认：${finding.recommendation}`,
          ...evidence.map(item => `- 证据：${item.sourceRef.assetVersionId} / ${item.locator.heading} — ${item.quote}`), '',
        ]
      }),
      '## 执行摘要', '',
      `- Agent：${response.snapshot.agentDefinition.agentKey} ${response.snapshot.agentDefinition.version}`,
      `- Framework：${response.execution.framework.name} ${response.execution.framework.version}`,
      `- 回合数：${response.execution.turns}`,
      `- 工具调用数：${response.execution.toolCalls}`,
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${(projectVersion?.name ?? '当前版本').replace(/[\\/:*?"<>|]/g, '-')}-需求点评审报告.md`
    link.click()
    URL.revokeObjectURL(url)
    addAudit(`导出需求评审报告：${selectedRun.id}`)
  }

  const visibleFindings = (result?.findings ?? []).filter(finding => {
    const state = selectedRun ? findingStates[`${selectedRun.id}:${finding.clientFindingId}`] ?? 'open' : 'open'
    const basis = finding.evidenceRefs.length ? 'evidence' : 'inference'
    return (findingTypeFilter === 'all' || finding.type === findingTypeFilter)
      && (severityFilter === 'all' || finding.severity === severityFilter)
      && (basisFilter === 'all' || basis === basisFilter)
      && (findingStateFilter === 'all' || state === findingStateFilter)
  })

  const stats = {
    requirements: result?.requirementPoints?.length ?? 0,
    findings: result?.findings.length ?? 0,
    high: result?.findings.filter(finding => finding.severity === 'critical' || finding.severity === 'high').length ?? 0,
    pending: result?.findings.filter(finding => !finding.evidenceRefs.length).length ?? 0,
    evidence: result?.findings.filter(finding => finding.evidenceRefs.length).length ?? 0,
  }

  const versionHistory = (selectedDocument?.versions ?? []).filter(item => item.status === 'ready')
  const leftLines = (diffContents[diffVersionIds[0]] ?? '').split(/\r?\n/).filter(line => line.trim())
  const rightLines = (diffContents[diffVersionIds[1]] ?? '').split(/\r?\n/).filter(line => line.trim())
  const removedLines = leftLines.filter(line => !rightLines.includes(line))
  const addedLines = rightLines.filter(line => !leftLines.includes(line))
  const currentMessages = selectedRun ? chatMessages[selectedRun.id] ?? [] : []
  const canRun = Boolean(projectVersion && !readOnly && requirementDocuments.length && requirementDocuments.every(document => document.assetVersionId) && selectedModel?.healthy && apiState === 'ready' && bindingsState === 'ready' && !requestController.current)

  const bindDocument = async (document: KnowledgeDocument) => {
    if (!projectVersion || readOnly || !document.assetVersionId || bindingActionId) return
    setBindingActionId(document.id)
    try {
      const previous = bindings.find(item => item.assetId === document.id)
      await bindRequirementVersion(projectVersion.id, document.assetVersionId)
      await refreshBindings()
      addAudit(`${previous ? '替换' : '新增'}项目版本需求绑定：${document.title} · ${document.assetVersionId}`)
      notify(previous ? `已将“${document.title}”替换为 ${document.version}。` : `已将“${document.title}”加入当前版本。`)
    } catch (error) { notify(error instanceof Error ? error.message : '需求绑定更新失败', 'error') }
    finally { setBindingActionId('') }
  }

  const unbindDocument = async (binding: RequirementBinding, documentTitle: string) => {
    if (!projectVersion || readOnly || bindingActionId) return
    setBindingActionId(binding.assetId)
    try {
      await unbindRequirementVersion(projectVersion.id, binding.id)
      await refreshBindings()
      addAudit(`移除项目版本需求绑定：${documentTitle} · ${binding.assetVersionId}`)
      notify(`已从当前版本移除“${documentTitle}”；知识库原文仍保留。`)
    } catch (error) { notify(error instanceof Error ? error.message : '需求绑定移除失败', 'error') }
    finally { setBindingActionId('') }
  }

  if (!projectVersion) return <section className="card rr-version-gate"><div><GitBranch /><ReviewBadge tone="purple">项目空间按版本隔离</ReviewBadge><h1>新建项目版本后才能进行需求分析</h1><p>平台固定为一个项目。需求文档绑定、评审运行、Finding 处置和对话上下文都归属于项目版本；知识库与系统设置保持全局共享。</p><button className="btn primary" onClick={onManageVersions}><GitBranch />新建项目版本</button></div></section>

  return <><section className={`card rr-page ${leftCollapsed ? 'left-collapsed' : ''} ${chatCollapsed ? 'chat-collapsed' : ''}`}>
    <header className="rr-header">
      <div className="rr-title-block">
        <div className="rr-title-icon"><Sparkles /></div>
        <div><span>需求点提取与评审 · {projectVersion.name}</span><h1>{requirementDocuments.length ? `${requirementDocuments.length} 份文档联合分析` : '需求分析'}</h1><p>{requirementDocuments.length ? `先跨文档提取并归并需求点，再关联 Finding 与固定证据` : bindingsState === 'loading' ? '正在加载当前版本的需求绑定' : '当前版本尚未绑定 ready 的需求资产'}</p></div>
      </div>
      <div className="rr-run-summary">
        <ReviewBadge tone={runTone(selectedRun?.status)}>{runLabel(selectedRun?.status)}</ReviewBadge>
        <span><small>运行 ID</small><b title={selectedRun?.id}>{selectedRun?.id ? selectedRun.id.replace('review_run_', '').slice(0, 12) : '尚未创建'}</b></span>
        <span><small>固定输入文档</small><b>{selectedRun?.assetVersionIds?.length ?? requirementDocuments.length} 份</b></span>
      </div>
      <div className="rr-header-actions">
        <ReviewBadge tone={readOnly ? 'orange' : 'green'}>{readOnly ? projectVersion.status === 'locked' ? '版本已锁定 · 只读' : '版本已归档 · 只读' : '版本可编辑'}</ReviewBadge>
        <label className="rr-model-select"><span>评审模型</span><select value={selectedModelKey} onChange={event => setSelectedModelKey(event.target.value)} disabled={modelsState !== 'ready' || selectedRun?.status === 'running'}><option value="">选择支持工具调用的模型</option>{modelChoices.map(model => <option value={model.key} key={model.key}>{model.healthy ? '●' : '○'} {model.label}</option>)}</select></label>
        <button className="btn ghost" onClick={() => setSnapshotOpen(value => !value)} disabled={!selectedRun}><ShieldCheck />固定快照</button>
        <button className="btn ghost" onClick={exportReport} disabled={!selectedRun?.response}><Download />导出报告</button>
        {selectedRun?.status === 'running' ? <button className="btn danger" onClick={cancelAnalysis}><XCircle />取消运行</button> : <button className="btn primary" onClick={startAnalysis} disabled={!canRun} title={!selectedModel?.healthy ? '请先选择通过工具调用检测的健康模型' : undefined}><Play />{selectedRun ? '重新提取并评审' : '提取需求点并评审'}</button>}
      </div>
      {snapshotOpen && selectedRun && <div className="rr-snapshot-popover"><header><b>固定输入快照</b><button onClick={() => setSnapshotOpen(false)} aria-label="关闭快照"><XCircle /></button></header><dl><div><dt>项目版本</dt><dd>{selectedRun.snapshot?.projectVersionName ?? projectVersion.name}</dd></div><div><dt>运行</dt><dd>{selectedRun.id}</dd></div><div><dt>输入文档</dt><dd>{(selectedRun.documents ?? selectedRun.snapshot?.assets ?? []).map(document => `${document.displayName} · ${document.assetVersionId}`).join('\n') || selectedRun.assetVersionId}</dd></div><div><dt>模型</dt><dd>{selectedRun.modelLabel}</dd></div><div><dt>索引版本</dt><dd>{selectedRun.snapshot?.indexVersionId ?? '运行创建后固定'}</dd></div><div><dt>Agent</dt><dd>{selectedRun.snapshot ? `${selectedRun.snapshot.agentDefinition.agentKey} ${selectedRun.snapshot.agentDefinition.version}` : 'RequirementAnalysisAgent'}</dd></div><div><dt>Prompt</dt><dd>{selectedRun.snapshot?.agentDefinition.promptRef.version ?? '内置版本'}</dd></div><div><dt>Toolset / Skill / MCP</dt><dd>{selectedRun.snapshot ? `${selectedRun.snapshot.agentDefinition.toolsetVersion} / ${selectedRun.snapshot.agentDefinition.skillBindings.length} / ${selectedRun.snapshot.agentDefinition.mcpBindings.length}` : '内置工具集'}</dd></div></dl></div>}
    </header>

    <div className="rr-workspace">
      <aside className="rr-review-list">
        <div className="rr-panel-head"><span><FileText /><b>需求文件目录</b></span><button onClick={() => setLeftCollapsed(value => !value)} aria-label={leftCollapsed ? '展开需求文件目录' : '收起需求文件目录'}>{leftCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button></div>
        {!leftCollapsed && <>
          <div className="rr-list-meta"><span>{requirementDocuments.length} 份固定输入文档</span><button onClick={() => void refreshKnowledge()}><RefreshCw />刷新</button></div>
          <div className="rr-list-scroll">{requirementDocuments.map(document => <button className={`rr-review-row ${selectedDocument?.id === document.id ? 'active' : ''}`} key={document.id} onClick={() => { setSelectedAssetId(document.id); setView('source') }}><span className="rr-file-icon">MD</span><span><b>{document.title}</b><small>{document.version} · 固定输入</small><em>{document.logicalPath}</em></span></button>)}{!requirementDocuments.length && <div className="rr-empty compact"><FileText /><b>没有可分析的需求文档</b><p>仅展示当前项目版本已绑定且 ready 的 requirement 类型 Markdown/纯文本资产。</p></div>}</div>
          <div className="rr-list-footer"><button className="rr-upload-button" disabled={readOnly || uploadState === 'running' || apiState !== 'ready'} onClick={() => uploadRef.current?.click()}><Upload />{readOnly ? '当前版本只读' : uploadState === 'running' ? '正在解析并入库…' : '上传需求 / ZIP'}</button><input ref={uploadRef} className="visually-hidden" type="file" multiple accept=".zip,.md,.txt,application/zip,text/markdown,text/plain" onChange={event => void uploadRequirements(event)} />{uploadProgress && <div className={`rr-upload-progress ${uploadProgress.stage}`} role="status" aria-live="polite"><div><span>{uploadProgress.stage === 'failed' ? '上传未完成' : uploadProgress.stage === 'completed' ? '上传完成' : '上传解析进度'}</span><b>{uploadProgress.percent}%</b></div><progress max="100" value={uploadProgress.percent} /><small>{uploadProgress.detail}</small></div>}<button onClick={() => setBindingManagerOpen(true)}><FileDiff />管理需求绑定</button><button onClick={onManageVersions}><GitBranch />切换 / 管理版本</button><button onClick={onOpenKnowledge}><BookOpen />前往知识库</button><button onClick={onOpenActivity}><Clock3 />操作记录</button></div>
        </>}
      </aside>

      <main className="rr-main">
        <div className="rr-main-toolbar">
          <div className="rr-tabs" role="tablist" aria-label="需求评审视图">{viewTabs.map(tab => <button key={tab.key} className={view === tab.key ? 'active' : ''} role="tab" aria-selected={view === tab.key} onClick={() => setView(tab.key)}><tab.icon />{tab.label}</button>)}</div>
          <label className="rr-history"><Clock3 /><span>运行历史</span><select value={selectedRun?.id ?? ''} onChange={event => selectRun(event.target.value)} disabled={runsState === 'loading'}><option value="">{runsState === 'loading' ? '正在加载历史' : '尚无运行'}</option>{reviewRuns.map(run => <option value={run.id} key={run.id}>{formatTime(run.createdAt)} · {runLabel(run.status)}</option>)}</select>{runsCursor && <button className="text-btn" onClick={() => void loadMoreRuns()} disabled={runsLoadingMore}>{runsLoadingMore ? '加载中…' : '更多历史'}</button>}<button className="rr-record-button" type="button" onClick={() => void openRunRecord()} disabled={!selectedRun || selectedRun.id.startsWith('pending-')}><Activity />运行记录</button><ReviewBadge tone={runsState === 'failed' ? 'red' : 'green'}>{runsState === 'failed' ? '读取失败' : '已持久化'}</ReviewBadge></label>
        </div>

        {selectedRun?.status === 'running' && <div className="rr-live-status"><LoaderCircle className="rotating" /><div><b>RequirementAnalysisAgent 正在后台执行</b><span>页面每秒同步服务端状态；刷新、切换页面或关闭浏览器不会取消本次评审。</span><i /></div><ReviewBadge tone="purple">可取消</ReviewBadge></div>}
        {selectedRun?.status === 'failed' && <div className="rr-error-status"><XCircle /><div><b>评审运行失败</b><span>{runErrorMessage(selectedRun.error)}</span>{!selectedModel?.healthy && <small>请在顶部切换到通过工具调用检测的健康模型后重新评审。</small>}</div><button className="btn primary" onClick={startAnalysis} disabled={!canRun}><RefreshCw />重新评审</button></div>}
        {selectedRun?.status === 'cancelled' && <div className="rr-warning-status"><AlertTriangle /><div><b>评审已取消</b><span>{selectedRun.error}</span>{!selectedModel?.healthy && <small>请先选择健康模型。</small>}</div><button className="btn primary" onClick={startAnalysis} disabled={!canRun}><RefreshCw />重新评审</button></div>}

        <div className={`rr-view-content ${view === 'source' ? 'rr-source-view' : ''}`}>
          {view === 'overview' && <OverviewView result={result} stats={stats} visibleFindings={visibleFindings} selectedFindingId={selectedFindingId} selectedRun={selectedRun} findingStates={findingStates} findingTypeFilter={findingTypeFilter} setFindingTypeFilter={setFindingTypeFilter} severityFilter={severityFilter} setSeverityFilter={setSeverityFilter} basisFilter={basisFilter} setBasisFilter={setBasisFilter} findingStateFilter={findingStateFilter} setFindingStateFilter={setFindingStateFilter} onSelectFinding={setSelectedFindingId} onLocate={locateFinding} onQuote={quoteFinding} onState={updateFindingState} onStart={startAnalysis} canRun={canRun} />}
          {view === 'source' && <SourceDocumentView document={selectedDocument} content={documentContent} format={documentFormat} outline={outline} activeSectionKey={activeSectionKey} outlineCollapsed={outlineCollapsed} selectedEvidence={selectedEvidenceId ? evidenceById.get(selectedEvidenceId) : undefined} sourceRef={sourceRef} outlineRef={outlineRef} knowledgeBaseId={knowledgeBaseId} onSection={activateSection} onToggleOutline={() => setOutlineCollapsed(value => !value)} onQuote={captureSourceQuote} />}
          {view === 'diff' && <DiffView versions={versionHistory} value={diffVersionIds} onChange={setDiffVersionIds} loading={diffLoading} removed={removedLines} added={addedLines} />}
          {view === 'tree' && <RequirementPointsView requirementPoints={result?.requirementPoints ?? []} evidence={result?.evidence ?? []} findings={result?.findings ?? []} onLocateEvidence={locateEvidence} onSelectFinding={setSelectedFindingId} />}
          {view === 'evidence' && <EvidenceView evidence={result?.evidence ?? []} findings={result?.findings ?? []} selectedEvidenceId={selectedEvidenceId} onLocate={locateEvidence} />}
        </div>
      </main>

      <aside className="rr-chat">
        <div className="rr-panel-head"><span><MessageSquareText /><b>评审问答</b></span><button onClick={() => setChatCollapsed(value => !value)} aria-label={chatCollapsed ? '展开评审问答' : '收起评审问答'}>{chatCollapsed ? <PanelRightOpen /> : <PanelRightClose />}</button></div>
        {!chatCollapsed && <><div className="rr-chat-context"><ShieldCheck /><span><b>{selectedRun?.status === 'succeeded' ? '已绑定固定评审运行' : '等待成功评审运行'}</b><small>{selectedRun?.response ? `${selectedRun.response.snapshot.assetVersionId} · ${selectedRun.response.result.evidence.length} 条证据` : '问答不会自动切换到最新需求版本'}</small></span><ReviewBadge tone={selectedRun?.status === 'succeeded' ? 'green' : 'gray'}>{selectedRun?.status === 'succeeded' ? '只读上下文' : '不可用'}</ReviewBadge></div>
          <div className="rr-chat-scroll">{currentMessages.length ? currentMessages.map((message, index) => <div className={`rr-message ${message.role}`} key={`${message.role}-${index}`}>{message.quote && <blockquote><Quote />{message.quote.findingId ? `Finding ${message.quote.findingId}` : `${message.quote.heading}${message.quote.startLine ? ` · L${message.quote.startLine}` : ''}`}<span>{message.quote.text}</span></blockquote>}<b>{message.role === 'user' ? '你' : message.role === 'assistant' ? message.modelLabel ?? 'AI 评审助手' : '系统状态'}</b><p>{message.text}</p>{message.citations?.length ? <div className="rr-message-citations">{message.citations.map(citation => <button key={citation} onClick={() => { const evidence = evidenceById.get(citation); if (evidence) locateEvidence(evidence) }}><ShieldCheck />{citation}</button>)}</div> : null}{message.limitations?.length ? <small className="rr-message-limitations">限制：{message.limitations.join('；')}</small> : null}</div>) : <div className="rr-chat-empty"><Bot /><h3>基于本次评审继续追问</h3><p>回答绑定本次 ReviewRun、固定需求版本和已校验证据；不会自动切换到最新版本。</p>{result?.findings.slice(0, 3).map(finding => <button key={finding.clientFindingId} onClick={() => quoteFinding(finding)}><Quote />引用：{finding.title}</button>)}</div>}{chatSendingRunId === selectedRun?.id && <div className="rr-message assistant"><b>AI 评审助手</b><p><LoaderCircle className="rotating" /> 正在基于固定评审上下文生成答案…</p></div>}</div>
          {sourceQuote && <div className="rr-quote-preview"><Quote /><span><b>{sourceQuote.findingId ? `Finding ${sourceQuote.findingId}` : sourceQuote.heading}</b><small>{sourceQuote.text}</small></span><button onClick={() => setSourceQuote(null)} aria-label="移除引用"><XCircle /></button></div>}
          <div className="rr-chat-input"><textarea value={chatDraft} onChange={event => setChatDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendChat() } }} disabled={selectedRun?.status !== 'succeeded' || Boolean(chatSendingRunId)} placeholder={selectedRun?.status === 'succeeded' ? '基于固定评审运行提问…' : '完成一次真实评审后可引用提问'} /><div><span><ShieldCheck />固定 ReviewRun · 真实模型</span><button onClick={() => void sendChat()} disabled={!chatDraft.trim() || selectedRun?.status !== 'succeeded' || Boolean(chatSendingRunId)} aria-label="发送评审问题">{chatSendingRunId ? <LoaderCircle className="rotating" /> : <Send />}</button></div></div></>}
      </aside>
    </div>
  </section>{runRecordOpen && selectedRun && <RunRecordModal run={selectedRun} loading={runRecordLoading} tab={runRecordTab} onTab={setRunRecordTab} onClose={() => setRunRecordOpen(false)} />}{bindingManagerOpen && <ReviewModal title={`${projectVersion.name} · 需求绑定`} onClose={() => setBindingManagerOpen(false)}><div className="rr-binding-manager"><header><div><b>{readOnly ? '当前版本只读' : '维护当前版本的需求范围'}</b><span>继承得到的是独立固定绑定。加入、替换或移除只影响 {projectVersion.name}，不会修改来源版本或删除知识库文件。</span></div><ReviewBadge tone={readOnly ? 'orange' : 'green'}>{bindings.length} 条绑定</ReviewBadge></header><div className="rr-binding-list">{availableRequirementDocuments.map(document => {
    const binding = bindings.find(item => item.assetId === document.id)
    const boundDocument = boundDocuments.find(item => item.id === document.id)
    const isLatest = binding?.assetVersionId === document.assetVersionId
    return <article key={document.id}><FileText /><span><b>{document.title}</b><small>{document.logicalPath}</small><em>{binding ? `当前绑定 ${boundDocument?.version ?? binding.assetVersionId}` : '尚未加入当前版本'} · 知识库最新 {document.version}</em></span><div>{binding && <ReviewBadge tone={isLatest ? 'green' : 'orange'}>{isLatest ? '已绑定最新固定版' : '存在可替换版本'}</ReviewBadge>}{!binding && <button className="btn primary" disabled={readOnly || Boolean(bindingActionId)} onClick={() => void bindDocument(document)}><CheckCircle2 />加入</button>}{binding && !isLatest && <button className="btn primary" disabled={readOnly || Boolean(bindingActionId)} onClick={() => void bindDocument(document)}><RefreshCw />替换为 {document.version}</button>}{binding && <button className="btn ghost danger-text" disabled={readOnly || Boolean(bindingActionId)} onClick={() => void unbindDocument(binding, document.title)}><XCircle />移除</button>}</div></article>
  })}{!availableRequirementDocuments.length && <div className="rr-empty compact"><FileText /><b>知识库暂无 ready 需求</b><p>可以先上传 Markdown、TXT 或 ZIP，入库完成后会自动绑定当前版本。</p></div>}</div><footer><button className="btn ghost" onClick={onOpenKnowledge}><BookOpen />打开全局知识库</button><button className="btn primary" onClick={() => setBindingManagerOpen(false)}>完成</button></footer></div></ReviewModal>}</>
}

function OverviewView({ result, stats, visibleFindings, selectedFindingId, selectedRun, findingStates, findingTypeFilter, setFindingTypeFilter, severityFilter, setSeverityFilter, basisFilter, setBasisFilter, findingStateFilter, setFindingStateFilter, onSelectFinding, onLocate, onQuote, onState, onStart, canRun }: {
  result?: RequirementAnalysisResponse['result']; stats: { requirements: number; findings: number; high: number; pending: number; evidence: number }; visibleFindings: ReviewFinding[]; selectedFindingId: string; selectedRun?: RunRecord; findingStates: Record<string, FindingState>;
  findingTypeFilter: 'all' | ReviewFindingType; setFindingTypeFilter: (value: 'all' | ReviewFindingType) => void; severityFilter: 'all' | ReviewSeverity; setSeverityFilter: (value: 'all' | ReviewSeverity) => void; basisFilter: 'all' | 'evidence' | 'inference'; setBasisFilter: (value: 'all' | 'evidence' | 'inference') => void; findingStateFilter: 'all' | FindingState; setFindingStateFilter: (value: 'all' | FindingState) => void;
  onSelectFinding: (id: string) => void; onLocate: (finding: ReviewFinding) => void; onQuote: (finding: ReviewFinding) => void; onState: (finding: ReviewFinding, state: FindingState) => void; onStart: () => void; canRun: boolean
}) {
  if (!result) return <div className="rr-empty"><Sparkles /><b>{selectedRun?.status === 'running' ? '正在提取需求点并执行评审' : selectedRun?.status === 'failed' ? '本次分析失败，可重新运行' : selectedRun?.status === 'cancelled' ? '本次分析已取消，可重新运行' : '尚未提取需求点'}</b><p>当前运行会固定左侧目录中的全部 ready 文档，先跨文档提取并归并需求点，再生成关联 Finding 与固定证据。</p>{selectedRun?.status !== 'running' && <button className="btn primary" onClick={onStart} disabled={!canRun}><Play />{selectedRun ? '重新提取并评审' : '提取需求点并评审'}</button>}</div>
  return <div className="rr-overview">
    <div className="rr-assessment"><div><span>AI 评审摘要</span><h2>{result.summary.overallAssessment === 'blocked' ? '存在阻断问题' : result.summary.overallAssessment === 'needs_revision' ? '建议修改后确认' : result.summary.overallAssessment === 'pass_with_notes' ? '附带关注项通过' : '评审通过'}</h2><p>{result.summary.risks[0] ?? result.summary.strengths[0] ?? '本次评审已完成结构化校验。'}</p></div><div className="rr-score"><strong>{result.summary.score}</strong><span>综合评分</span></div></div>
    <div className="rr-stat-grid"><article><GitBranch /><span>需求点</span><strong>{stats.requirements}</strong><small>跨文档提取归并</small></article><article><AlertTriangle /><span>Finding</span><strong>{stats.findings}</strong><small>关联到需求点</small></article><article className="danger"><ShieldCheck /><span>阻断/高风险</span><strong>{stats.high}</strong><small>优先人工确认</small></article><article className="warning"><CircleHelp /><span>待确认</span><strong>{stats.pending}</strong><small>证据不足项</small></article><article className="success"><CheckCircle2 /><span>有证据项</span><strong>{stats.evidence}</strong><small>可定位固定原文</small></article></div>
    <div className="rr-finding-toolbar"><span><ListFilter />Finding 筛选</span><select value={findingTypeFilter} onChange={event => setFindingTypeFilter(event.target.value as 'all' | ReviewFindingType)}><option value="all">全部类型</option>{Object.entries(findingTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><select value={severityFilter} onChange={event => setSeverityFilter(event.target.value as 'all' | ReviewSeverity)}><option value="all">全部严重度</option>{Object.entries(severityLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><select value={basisFilter} onChange={event => setBasisFilter(event.target.value as typeof basisFilter)}><option value="all">全部依据</option><option value="evidence">有固定证据</option><option value="inference">模型推测</option></select><select value={findingStateFilter} onChange={event => setFindingStateFilter(event.target.value as 'all' | FindingState)}><option value="all">全部处置</option>{Object.entries(findingStateLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><small>{visibleFindings.length} / {result.findings.length}</small></div>
    <div className="rr-findings">{visibleFindings.map(finding => {
      const state = selectedRun ? findingStates[`${selectedRun.id}:${finding.clientFindingId}`] ?? 'open' : 'open'
      const supported = finding.evidenceRefs.length > 0
      return <article className={`rr-finding-card ${selectedFindingId === finding.clientFindingId ? 'selected' : ''}`} key={finding.clientFindingId} onClick={() => onSelectFinding(finding.clientFindingId)}><header><span className={`rr-risk-icon ${severityTone(finding.severity)}`}><AlertTriangle /></span><div><span>{findingTypeLabels[finding.type]} · {finding.clientFindingId}</span><h3>{finding.title}</h3></div><ReviewBadge tone={severityTone(finding.severity)}>{severityLabels[finding.severity]}风险</ReviewBadge><ReviewBadge tone={supported ? 'green' : 'orange'}>{supported ? `${finding.evidenceRefs.length} 条固定证据` : '模型推测'}</ReviewBadge></header><p>{finding.description}</p><dl><div><dt>影响</dt><dd>{finding.impact}</dd></div><div><dt>建议确认</dt><dd>{finding.recommendation}</dd></div></dl><footer><span>置信度 {Math.round(finding.confidence * 100)}% · <b>{findingStateLabels[state]}</b></span><div><button onClick={event => { event.stopPropagation(); onLocate(finding) }}><BookOpen />定位原文</button><button onClick={event => { event.stopPropagation(); onQuote(finding) }}><MessageSquareText />追问</button><select aria-label={`处置 ${finding.title}`} value={state} onClick={event => event.stopPropagation()} onChange={event => onState(finding, event.target.value as FindingState)}>{Object.entries(findingStateLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div></footer></article>
    })}{!visibleFindings.length && <div className="rr-empty compact"><ListFilter /><b>没有匹配的 Finding</b><p>调整筛选条件后重试。</p></div>}</div>
  </div>
}

function SourceDocumentView({ document, content, format, outline, activeSectionKey, outlineCollapsed, selectedEvidence, sourceRef, outlineRef, knowledgeBaseId, onSection, onToggleOutline, onQuote }: { document?: KnowledgeDocument; content: string; format: 'markdown' | 'text'; outline: ReturnType<typeof parseMarkdownOutline>; activeSectionKey: string | null; outlineCollapsed: boolean; selectedEvidence?: ReviewEvidence; sourceRef: React.RefObject<HTMLDivElement | null>; outlineRef: React.RefObject<HTMLElement | null>; knowledgeBaseId: string; onSection: (key: string) => void; onToggleOutline: () => void; onQuote: () => void }) {
  if (!document || !content) return <div className="rr-empty"><BookOpen /><b>固定原文不可用</b><p>请确认需求资产版本已达到 ready 状态。</p></div>
  return <div className={`rr-source-layout ${outlineCollapsed ? 'outline-collapsed' : ''}`}><nav className="rr-outline" ref={outlineRef}><header><b>本文目录</b>{!outlineCollapsed && <ReviewBadge tone="blue">{outline.sections.length}</ReviewBadge>}<button className="rr-outline-toggle" onClick={onToggleOutline} aria-label={outlineCollapsed ? '展开文档目录' : '收起文档目录'} title={outlineCollapsed ? '展开目录' : '收起目录'}>{outlineCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button></header>{!outlineCollapsed && outline.sections.map(section => <button className={activeSectionKey === section.key ? 'active' : ''} data-outline-section-key={section.key} style={{ paddingLeft: `${12 + Math.max(0, section.depth - 2) * 10}px` }} onClick={() => onSection(section.key)} key={section.key}><span>{section.title}</span></button>)}</nav><article className="rr-source-document"><header><div><ReviewBadge tone="blue">{format === 'text' ? 'TXT' : 'Markdown'}</ReviewBadge><b>{document.title}</b><span>{document.assetVersionId}</span></div><span><ShieldCheck />只读固定版本</span></header>{selectedEvidence && <div className="rr-evidence-banner"><ShieldCheck /><span><b>已定位证据 · {selectedEvidence.locator.heading}</b><small>{selectedEvidence.quote}</small></span><ReviewBadge tone="green">{selectedEvidence.sourceRef.chunkId}</ReviewBadge></div>}<div className="rr-markdown" ref={sourceRef} onMouseUp={onQuote}><MarkdownDocument source={content} format={format} knowledgeBaseId={knowledgeBaseId} logicalPath={document.logicalPath ?? document.name} outline={outline} activeSectionKey={activeSectionKey} anchorPrefix={`review-${document.assetVersionId}`} /></div><footer><Quote />选中原文可引用到右侧评审问答；不会修改或覆盖固定需求版本。</footer></article></div>
}

function DiffView({ versions, value, onChange, loading, removed, added }: { versions: NonNullable<KnowledgeDocument['versions']>; value: [string, string]; onChange: (value: [string, string]) => void; loading: boolean; removed: string[]; added: string[] }) {
  if (versions.length < 2) return <div className="rr-empty"><FileDiff /><b>暂无可比较版本</b><p>同一需求资产至少需要两个 ready 的固定版本。</p></div>
  return <div className="rr-diff"><header><div><span>基准版本</span><select value={value[0]} onChange={event => onChange([event.target.value, value[1]])}>{versions.map(item => <option value={item.id} key={item.id}>V{item.number} · {item.id}</option>)}</select></div><ChevronRight /><div><span>目标版本</span><select value={value[1]} onChange={event => onChange([value[0], event.target.value])}>{versions.map(item => <option value={item.id} key={item.id}>V{item.number} · {item.id}</option>)}</select></div><ReviewBadge tone="blue">真实固定版本</ReviewBadge></header>{loading ? <div className="rr-empty compact"><LoaderCircle className="rotating" /><b>正在读取固定版本</b></div> : <div className="rr-diff-columns"><section><h3>删除内容 <span>{removed.length}</span></h3>{removed.map((line, index) => <p className="removed" key={`${line}-${index}`}>− {line}</p>)}{!removed.length && <small>没有检测到删除行。</small>}</section><section><h3>新增内容 <span>{added.length}</span></h3>{added.map((line, index) => <p className="added" key={`${line}-${index}`}>+ {line}</p>)}{!added.length && <small>没有检测到新增行。</small>}</section></div>}</div>
}

function RequirementPointsView({ requirementPoints, evidence, findings, onLocateEvidence, onSelectFinding }: { requirementPoints: RequirementAnalysisResponse['result']['requirementPoints']; evidence: ReviewEvidence[]; findings: ReviewFinding[]; onLocateEvidence: (evidence: ReviewEvidence, findingId?: string) => void; onSelectFinding: (findingId: string) => void }) {
  const evidenceById = new Map(evidence.map(item => [item.clientEvidenceId, item]))
  if (!requirementPoints.length) return <div className="rr-empty"><GitBranch /><b>暂无已验证需求点</b><p>完成多文档提取后，需求点及其 Finding、固定证据关系会显示在这里。</p></div>
  return <div className="rr-tree"><header><GitBranch /><div><h2>需求点</h2><p>由本次固定的多份文档提取并归并；每个需求点必须至少关联一条已校验证据。</p></div><ReviewBadge tone="green">{requirementPoints.length} 个需求点</ReviewBadge></header><div className="rr-tree-root"><span><FileText /></span><div><b>本次固定输入</b><small>{new Set(evidence.map(item => item.sourceRef.assetVersionId)).size} 份文档 · {evidence.length} 条固定证据</small></div></div>{requirementPoints.map(point => {
    const linkedFindings = findings.filter(finding => finding.requirementPointRefs.includes(point.clientRequirementPointId))
    const linkedEvidence = point.evidenceRefs.map(reference => evidenceById.get(reference)).filter((item): item is ReviewEvidence => Boolean(item))
    return <article className="rr-requirement-point" key={point.clientRequirementPointId}><header><span className="rr-requirement-id">{point.clientRequirementPointId}</span><div><h3>{point.title}</h3><p>{point.description}</p></div><ReviewBadge tone={linkedFindings.length ? 'orange' : 'green'}>{linkedFindings.length} 条 Finding</ReviewBadge></header><div className="rr-requirement-relations"><section><b>Finding</b>{linkedFindings.length ? linkedFindings.map(finding => <button key={finding.clientFindingId} onClick={() => onSelectFinding(finding.clientFindingId)}><AlertTriangle />{finding.clientFindingId} · {finding.title}<ReviewBadge tone={severityTone(finding.severity)}>{severityLabels[finding.severity]}</ReviewBadge></button>) : <span><CheckCircle2 />未发现关联问题</span>}</section><section><b>固定证据</b>{linkedEvidence.map(item => <button key={item.clientEvidenceId} onClick={() => onLocateEvidence(item, linkedFindings[0]?.clientFindingId)}><Quote />{item.clientEvidenceId} · {item.locator.heading}<small>{item.sourceRef.assetVersionId}</small></button>)}</section></div></article>
  })}</div>
}

function EvidenceView({ evidence, findings, selectedEvidenceId, onLocate }: { evidence: ReviewEvidence[]; findings: ReviewFinding[]; selectedEvidenceId: string; onLocate: (evidence: ReviewEvidence, findingId?: string) => void }) {
  if (!evidence.length) return <div className="rr-empty"><ShieldCheck /><b>暂无固定证据</b><p>只有通过服务端引用校验的 Evidence 才会出现在这里。</p></div>
  return <div className="rr-evidence-list"><header><div><ShieldCheck /><span><h2>固定证据引用</h2><p>点击后始终打开 Evidence 指定的资产版本，不跳转 latest。</p></span></div><ReviewBadge tone="green">{evidence.length} 条已校验证据</ReviewBadge></header>{evidence.map(item => {
    const linked = findings.filter(finding => finding.evidenceRefs.includes(item.clientEvidenceId))
    return <button className={selectedEvidenceId === item.clientEvidenceId ? 'active' : ''} key={item.clientEvidenceId} onClick={() => onLocate(item, linked[0]?.clientFindingId)}><span className="rr-evidence-number">{item.clientEvidenceId}</span><span><b>{item.locator.heading}</b><p>“{item.quote}”</p><small>{item.sourceRef.assetVersionId} · {item.sourceRef.chunkId} · 定位 {item.locator.start}–{item.locator.end}</small></span><span className="rr-evidence-links">{linked.map(finding => <ReviewBadge tone={severityTone(finding.severity)} key={finding.clientFindingId}>{finding.clientFindingId}</ReviewBadge>)}</span><ChevronRight /></button>
  })}</div>
}
