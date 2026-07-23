import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, BookOpen, Bot, CheckCircle2, ChevronRight, CircleHelp, Clock3, Download, FileDiff,
  FileText, GitBranch, ListFilter, LoaderCircle, MessageSquareText, PanelLeftClose, PanelLeftOpen,
  PanelRightClose, PanelRightOpen, Play, Quote, RefreshCw, Search, Send, ShieldCheck, Sparkles, Upload, XCircle,
} from 'lucide-react'
import type { GenerativeSourceDraft, KnowledgeDocument, Version } from './prototype-data'
import { loadAssetVersion, loadGenerativeModelSources, uploadKnowledgeArchive, uploadKnowledgeFile, waitForTasks } from './knowledge-api'
import { MarkdownDocument } from './MarkdownDocument'
import { emptyMarkdownOutline, parseMarkdownOutline } from './markdown-outline'
import {
  runRequirementAnalysis,
  type RequirementAnalysisResponse,
  type ReviewEvidence,
  type ReviewFinding,
  type ReviewFindingType,
  type ReviewSeverity,
} from './requirement-analysis-api'

type Notify = (message: string, tone?: 'success' | 'error' | 'warning') => void
type ViewKey = 'overview' | 'source' | 'diff' | 'tree' | 'evidence'
type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'
type FindingState = 'open' | 'confirmed' | 'dismissed' | 'resolved' | 'needs_follow_up'
type SourceQuote = { text: string; assetVersionId: string; heading: string; startLine?: number; endLine?: number; findingId?: string }
type ChatMessage = { role: 'user' | 'system'; text: string; quote?: SourceQuote }

type RunRecord = {
  id: string
  assetId: string
  assetVersionId: string
  documentTitle: string
  documentVersion: string
  logicalPath: string
  content: string
  createdAt: string
  status: RunStatus
  modelLabel: string
  response?: RequirementAnalysisResponse
  error?: string
}

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
  { key: 'tree', label: '功能树', icon: GitBranch },
  { key: 'evidence', label: '证据引用', icon: ShieldCheck },
]

function ReviewBadge({ children, tone = 'gray' }: { children: React.ReactNode; tone?: string }) {
  return <span className={`rr-badge ${tone}`}>{children}</span>
}

const severityTone = (severity: ReviewSeverity) => severity === 'critical' ? 'red' : severity === 'high' ? 'orange' : severity === 'medium' ? 'gold' : severity === 'low' ? 'blue' : 'gray'
const runTone = (status?: RunStatus) => status === 'succeeded' ? 'green' : status === 'running' ? 'purple' : status === 'failed' ? 'red' : status === 'cancelled' ? 'orange' : 'gray'
const runLabel = (status?: RunStatus) => status === 'succeeded' ? '评审完成' : status === 'running' ? '分析中' : status === 'failed' ? '运行失败' : status === 'cancelled' ? '已取消' : '待评审'
const formatTime = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })

export function RequirementReviewPage({
  version,
  documents,
  knowledgeBaseId,
  apiState,
  refreshKnowledge,
  onOpenKnowledge,
  onOpenActivity,
  notify,
  addAudit,
}: {
  version: Version
  documents: KnowledgeDocument[]
  knowledgeBaseId: string
  apiState: 'connecting' | 'ready' | 'offline'
  refreshKnowledge: () => Promise<void>
  onOpenKnowledge: () => void
  onOpenActivity: () => void
  notify: Notify
  addAudit: (entry: string) => void
}) {
  const requirementDocuments = useMemo(() => documents.filter(document => document.assetType === 'requirement' && document.status === 'ready' && document.assetVersionId), [documents])
  const [selectedAssetId, setSelectedAssetId] = useState('')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | RunStatus | 'not_started'>('all')
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [chatCollapsed, setChatCollapsed] = useState(false)
  const [view, setView] = useState<ViewKey>('overview')
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [selectedRunId, setSelectedRunId] = useState('')
  const [models, setModels] = useState<GenerativeSourceDraft[]>([])
  const [modelsState, setModelsState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [selectedModelKey, setSelectedModelKey] = useState('')
  const [selectedFindingId, setSelectedFindingId] = useState('')
  const [selectedEvidenceId, setSelectedEvidenceId] = useState('')
  const [activeSectionKey, setActiveSectionKey] = useState<string | null>(null)
  const [findingTypeFilter, setFindingTypeFilter] = useState<'all' | ReviewFindingType>('all')
  const [severityFilter, setSeverityFilter] = useState<'all' | ReviewSeverity>('all')
  const [basisFilter, setBasisFilter] = useState<'all' | 'evidence' | 'inference'>('all')
  const [findingStateFilter, setFindingStateFilter] = useState<'all' | FindingState>('all')
  const [findingStates, setFindingStates] = useState<Record<string, FindingState>>({})
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const [sourceQuote, setSourceQuote] = useState<SourceQuote | null>(null)
  const [chatDraft, setChatDraft] = useState('')
  const [chatMessages, setChatMessages] = useState<Record<string, ChatMessage[]>>({})
  const [diffVersionIds, setDiffVersionIds] = useState<[string, string]>(['', ''])
  const [diffContents, setDiffContents] = useState<Record<string, string>>({})
  const [diffLoading, setDiffLoading] = useState(false)
  const [uploadState, setUploadState] = useState<'idle' | 'running'>('idle')
  const requestController = useRef<AbortController | null>(null)
  const sourceRef = useRef<HTMLDivElement>(null)
  const uploadRef = useRef<HTMLInputElement>(null)

  const selectedDocument = requirementDocuments.find(document => document.id === selectedAssetId) ?? requirementDocuments[0]
  const selectedRun = runs.find(run => run.id === selectedRunId && run.assetId === selectedDocument?.id)
  const result = selectedRun?.response?.result
  const evidenceById = useMemo(() => new Map((result?.evidence ?? []).map(evidence => [evidence.clientEvidenceId, evidence])), [result])
  const documentContent = selectedRun?.content ?? selectedDocument?.content ?? ''
  const documentVersionId = selectedRun?.assetVersionId ?? selectedDocument?.assetVersionId ?? ''
  const documentFormat = selectedDocument?.name.toLowerCase().endsWith('.txt') ? 'text' : 'markdown'
  const outline = useMemo(() => documentFormat === 'markdown' && documentContent ? parseMarkdownOutline(documentContent) : emptyMarkdownOutline, [documentContent, documentFormat])

  const modelChoices = useMemo<ModelChoice[]>(() => models.flatMap(source => source.models
    .filter(model => source.enabled && model.enabled && model.capabilities.includes('tool_calling'))
    .map(model => ({ key: `${source.id}::${model.id}`, sourceId: source.id, modelId: model.id, label: `${source.name} · ${model.displayName}`, healthy: source.health === 'healthy' && model.health === 'healthy' }))), [models])
  const selectedModel = modelChoices.find(model => model.key === selectedModelKey)

  useEffect(() => {
    if (!selectedAssetId || !requirementDocuments.some(document => document.id === selectedAssetId)) setSelectedAssetId(requirementDocuments[0]?.id ?? '')
  }, [requirementDocuments, selectedAssetId])

  useEffect(() => {
    const latestRun = runs.find(run => run.assetId === selectedDocument?.id)
    setSelectedRunId(latestRun?.id ?? '')
    setSelectedFindingId('')
    setSelectedEvidenceId('')
    setSourceQuote(null)
    setView('overview')
  }, [selectedDocument?.id])

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
    const history = (selectedDocument?.versions ?? []).filter(item => item.status === 'ready')
    const right = selectedRun?.assetVersionId ?? selectedDocument?.assetVersionId ?? history.at(-1)?.id ?? ''
    const rightIndex = history.findIndex(item => item.id === right)
    const left = history[Math.max(0, rightIndex - 1)]?.id ?? history.at(-2)?.id ?? ''
    setDiffVersionIds([left && left !== right ? left : '', right])
    setDiffContents({})
  }, [selectedDocument?.id, selectedDocument?.assetVersionId, selectedRun?.assetVersionId])

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

  useEffect(() => {
    if (!activeSectionKey || view !== 'source') return
    const target = sourceRef.current?.querySelector<HTMLElement>(`[data-document-section-key="${activeSectionKey}"]`)
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [activeSectionKey, view])

  useEffect(() => () => requestController.current?.abort(), [])

  const runsForDocument = runs.filter(run => run.assetId === selectedDocument?.id)
  const filteredDocuments = requirementDocuments.filter(document => {
    const latest = runs.find(run => run.assetId === document.id)
    const matchesQuery = `${document.title} ${document.logicalPath ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())
    const matchesStatus = statusFilter === 'all' || statusFilter === 'not_started' ? statusFilter === 'all' || !latest : latest?.status === statusFilter
    return matchesQuery && matchesStatus
  })

  const selectRun = (runId: string) => {
    const run = runs.find(item => item.id === runId)
    if (!run) return
    setSelectedAssetId(run.assetId)
    setSelectedRunId(run.id)
    setSelectedFindingId('')
    setSelectedEvidenceId('')
    setSourceQuote(null)
    setView('overview')
  }

  const startAnalysis = async () => {
    if (!selectedDocument?.assetVersionId || !selectedModel || !selectedModel.healthy || requestController.current) return
    const controller = new AbortController()
    requestController.current = controller
    const temporaryId = `pending-${Date.now()}`
    const startedAt = new Date().toISOString()
    const pendingRun: RunRecord = {
      id: temporaryId,
      assetId: selectedDocument.id,
      assetVersionId: selectedDocument.assetVersionId,
      documentTitle: selectedDocument.title,
      documentVersion: selectedDocument.version,
      logicalPath: selectedDocument.logicalPath ?? selectedDocument.name,
      content: selectedDocument.content ?? '',
      createdAt: startedAt,
      status: 'running',
      modelLabel: selectedModel.label,
    }
    setRuns(current => [pendingRun, ...current])
    setSelectedRunId(temporaryId)
    setView('overview')
    addAudit(`启动需求评审：${selectedDocument.title} · ${selectedDocument.assetVersionId}`)
    try {
      const response = await runRequirementAnalysis({
        assetVersionId: selectedDocument.assetVersionId,
        sourceId: selectedModel.sourceId,
        modelId: selectedModel.modelId,
        focusAreas: ['功能完整性', '异常流程', '边界条件', '可测试性'],
      }, controller.signal)
      setRuns(current => current.map(run => run.id === temporaryId ? { ...run, id: response.runId, status: 'succeeded', response } : run))
      setSelectedRunId(response.runId)
      addAudit(`完成需求评审：${selectedDocument.title} · ${response.runId}`)
      notify(`需求评审已完成，共生成 ${response.result.findings.length} 条 Finding。`)
    } catch (error) {
      const cancelled = controller.signal.aborted
      const message = cancelled ? '客户端已取消本次评审请求' : error instanceof Error ? error.message : '需求评审运行失败'
      setRuns(current => current.map(run => run.id === temporaryId ? { ...run, status: cancelled ? 'cancelled' : 'failed', error: message } : run))
      addAudit(`${cancelled ? '取消' : '失败'}需求评审：${selectedDocument.title}`)
      notify(message, cancelled ? 'warning' : 'error')
    } finally {
      requestController.current = null
    }
  }

  const cancelAnalysis = () => {
    requestController.current?.abort()
  }

  const uploadRequirements = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    if (!files.length || !knowledgeBaseId || uploadState === 'running') return
    setUploadState('running')
    const taskIds: string[] = []
    let documentCount = 0
    let attachmentCount = 0
    let skippedCount = 0
    let deduplicatedCount = 0
    try {
      for (const file of files) {
        const extension = file.name.split('.').at(-1)?.toLowerCase()
        if (extension === 'zip') {
          const result = await uploadKnowledgeArchive(knowledgeBaseId, file, '需求文档', 'requirement')
          taskIds.push(...result.taskIds)
          documentCount += result.documents
          attachmentCount += result.attachments
          skippedCount += result.skipped
          deduplicatedCount += result.deduplicated
          addAudit(`上传需求压缩包：${file.name} · ${result.documents} 篇文档`)
        } else if (extension === 'md' || extension === 'txt') {
          const result = await uploadKnowledgeFile(knowledgeBaseId, file, `需求文档/${file.name}`, 'requirement')
          documentCount += 1
          if (result.task?.id) taskIds.push(result.task.id)
          if (result.deduplicated) deduplicatedCount += 1
          addAudit(`上传需求文档：${file.name}`)
        } else {
          skippedCount += 1
        }
      }
      if (!documentCount) throw new Error('没有可上传的需求文档，仅支持 Markdown、TXT 或包含这些文件的 ZIP。')
      if (taskIds.length) await waitForTasks(taskIds)
      await refreshKnowledge()
      notify(`需求资料已入库：${documentCount} 篇文档${attachmentCount ? `、${attachmentCount} 个附件` : ''}${deduplicatedCount ? `，${deduplicatedCount} 篇内容已去重` : ''}${skippedCount ? `，跳过 ${skippedCount} 个不支持文件` : ''}。`)
    } catch (error) {
      await refreshKnowledge().catch(() => undefined)
      notify(error instanceof Error ? error.message : '需求资料上传失败', 'error')
    } finally {
      setUploadState('idle')
    }
  }

  const locateEvidence = (evidence: ReviewEvidence, findingId?: string) => {
    setSelectedEvidenceId(evidence.clientEvidenceId)
    if (findingId) setSelectedFindingId(findingId)
    setView('source')
    const heading = evidence.locator.heading.trim()
    const section = outline.sections.find(item => item.title === heading || item.title.includes(heading) || heading.includes(item.title))
    setActiveSectionKey(section?.key ?? null)
    if (!section) notify('证据已绑定固定版本，但当前返回的标题定位无法映射到文档大纲。', 'warning')
  }

  const locateFinding = (finding: ReviewFinding) => {
    setSelectedFindingId(finding.clientFindingId)
    const evidence = finding.evidenceRefs.map(reference => evidenceById.get(reference)).find(Boolean)
    if (evidence) locateEvidence(evidence, finding.clientFindingId)
    else notify('该 Finding 没有固定证据，已保持为模型推测，不生成原文高亮。', 'warning')
  }

  const updateFindingState = (finding: ReviewFinding, state: FindingState) => {
    if (!selectedRun) return
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

  const sendChat = () => {
    const text = chatDraft.trim()
    if (!selectedRun || selectedRun.status !== 'succeeded' || !text) return
    const key = selectedRun.id
    setChatMessages(current => ({
      ...current,
      [key]: [...(current[key] ?? []), { role: 'user', text, quote: sourceQuote ?? undefined }, { role: 'system', text: '问题未发送：当前服务端尚未提供评审问答接口。前端不会使用本地模拟答案替代真实模型结果。' }],
    }))
    setChatDraft('')
    setSourceQuote(null)
    notify('评审问答接口尚未提供，本次问题未发送。', 'warning')
  }

  const exportReport = () => {
    if (!selectedRun?.response) return
    const response = selectedRun.response
    const stateFor = (finding: ReviewFinding) => findingStates[`${selectedRun.id}:${finding.clientFindingId}`] ?? 'open'
    const lines = [
      `# ${selectedRun.documentTitle} · 需求评审报告`, '',
      `- 运行 ID：${selectedRun.id}`,
      `- 固定资产版本：${selectedRun.assetVersionId}`,
      `- 索引版本：${response.snapshot.indexVersionId}`,
      `- 模型：${selectedRun.modelLabel}`,
      `- 生成时间：${formatTime(response.snapshot.createdAt)}`,
      `- 综合评分：${response.result.summary.score}`, '',
      '## 评审摘要', '',
      ...response.result.summary.risks.map(item => `- 风险：${item}`), '',
      '## Findings', '',
      ...response.result.findings.flatMap((finding, index) => {
        const evidence = finding.evidenceRefs.map(reference => evidenceById.get(reference)).filter((item): item is ReviewEvidence => Boolean(item))
        return [
          `### ${index + 1}. ${finding.title}`, '',
          `- 类型：${findingTypeLabels[finding.type]}`,
          `- 严重度：${severityLabels[finding.severity]}`,
          `- 置信度：${Math.round(finding.confidence * 100)}%`,
          `- 处置状态：${findingStateLabels[stateFor(finding)]}`,
          `- 问题：${finding.description}`,
          `- 影响：${finding.impact}`,
          `- 建议确认：${finding.recommendation}`,
          ...evidence.map(item => `- 证据：${item.sourceRef.assetVersionId} / ${item.locator.heading} — ${item.quote}`), '',
        ]
      }),
      '## 执行摘要', '',
      `- Agent：${response.snapshot.agentDefinition.agentKey} ${response.snapshot.agentDefinition.version}`,
      `- Framework：${response.execution.framework}`,
      `- 回合数：${response.execution.turns}`,
      `- 工具调用数：${response.execution.toolCalls}`,
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${selectedRun.documentTitle.replace(/[\\/:*?"<>|]/g, '-')}-评审报告.md`
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
    features: outline.sections.length,
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
  const canRun = Boolean(selectedDocument?.assetVersionId && selectedModel?.healthy && apiState === 'ready' && !requestController.current)

  return <section className={`rr-page ${leftCollapsed ? 'left-collapsed' : ''} ${chatCollapsed ? 'chat-collapsed' : ''}`}>
    <header className="rr-header">
      <div className="rr-title-block">
        <div className="rr-title-icon"><Sparkles /></div>
        <div><span>需求评审工作台 · {version}</span><h1>{selectedDocument?.title ?? '需求分析'}</h1><p>{selectedDocument ? `${selectedDocument.logicalPath} · 固定版本 ${documentVersionId}` : '请先在知识库准备 ready 的需求资产'}</p></div>
      </div>
      <div className="rr-run-summary">
        <ReviewBadge tone={runTone(selectedRun?.status)}>{runLabel(selectedRun?.status)}</ReviewBadge>
        <span><small>运行 ID</small><b title={selectedRun?.id}>{selectedRun?.id ? selectedRun.id.replace('review_run_', '').slice(0, 12) : '尚未创建'}</b></span>
        <span><small>固定资产版本</small><b title={documentVersionId}>{documentVersionId ? documentVersionId.slice(0, 14) : '—'}</b></span>
      </div>
      <div className="rr-header-actions">
        <label className="rr-model-select"><span>评审模型</span><select value={selectedModelKey} onChange={event => setSelectedModelKey(event.target.value)} disabled={modelsState !== 'ready' || selectedRun?.status === 'running'}><option value="">选择支持工具调用的模型</option>{modelChoices.map(model => <option value={model.key} key={model.key}>{model.healthy ? '●' : '○'} {model.label}</option>)}</select></label>
        <button className="btn ghost" onClick={() => setSnapshotOpen(value => !value)} disabled={!selectedRun}><ShieldCheck />固定快照</button>
        <button className="btn ghost" onClick={exportReport} disabled={!selectedRun?.response}><Download />导出报告</button>
        {selectedRun?.status === 'running' ? <button className="btn danger" onClick={cancelAnalysis}><XCircle />取消运行</button> : <button className="btn primary" onClick={startAnalysis} disabled={!canRun}><Play />{selectedRun?.status === 'succeeded' ? '重新评审' : '开始评审'}</button>}
      </div>
      {snapshotOpen && selectedRun && <div className="rr-snapshot-popover"><header><b>固定输入快照</b><button onClick={() => setSnapshotOpen(false)} aria-label="关闭快照"><XCircle /></button></header><dl><div><dt>运行</dt><dd>{selectedRun.id}</dd></div><div><dt>资产版本</dt><dd>{selectedRun.assetVersionId}</dd></div><div><dt>模型</dt><dd>{selectedRun.modelLabel}</dd></div><div><dt>索引版本</dt><dd>{selectedRun.response?.snapshot.indexVersionId ?? '运行完成后返回'}</dd></div><div><dt>Agent</dt><dd>{selectedRun.response ? `${selectedRun.response.snapshot.agentDefinition.agentKey} ${selectedRun.response.snapshot.agentDefinition.version}` : 'RequirementAnalysisAgent'}</dd></div></dl></div>}
    </header>

    <div className="rr-workspace">
      <aside className="rr-review-list">
        <div className="rr-panel-head"><span><FileText /><b>需求评审</b></span><button onClick={() => setLeftCollapsed(value => !value)} aria-label={leftCollapsed ? '展开需求列表' : '收起需求列表'}>{leftCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button></div>
        {!leftCollapsed && <>
          <div className="rr-list-tools"><div><Search /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索需求或路径" /></div><select value={statusFilter} onChange={event => setStatusFilter(event.target.value as typeof statusFilter)}><option value="all">全部状态</option><option value="not_started">待评审</option><option value="running">分析中</option><option value="succeeded">评审完成</option><option value="failed">运行失败</option><option value="cancelled">已取消</option></select></div>
          <div className="rr-list-meta"><span>{filteredDocuments.length} 个 ready 需求</span><button onClick={() => void refreshKnowledge()}><RefreshCw />刷新</button></div>
          <div className="rr-list-scroll">{filteredDocuments.map(document => {
            const latest = runs.find(run => run.assetId === document.id)
            const count = runs.filter(run => run.assetId === document.id).length
            return <button className={`rr-review-row ${selectedDocument?.id === document.id ? 'active' : ''}`} key={document.id} onClick={() => setSelectedAssetId(document.id)}><span className="rr-file-icon">MD</span><span><b>{document.title}</b><small>{document.version} · {latest ? runLabel(latest.status) : '待评审'}</small><em>{document.logicalPath}</em></span>{count > 0 && <i>{count}</i>}</button>
          })}{!filteredDocuments.length && <div className="rr-empty compact"><FileText /><b>没有可评审需求</b><p>仅展示知识库中 ready 的 requirement 类型 Markdown/纯文本资产。</p></div>}</div>
          <div className="rr-list-footer"><button className="rr-upload-button" disabled={uploadState === 'running' || apiState !== 'ready'} onClick={() => uploadRef.current?.click()}><Upload />{uploadState === 'running' ? '正在解析并入库…' : '上传需求 / ZIP'}</button><input ref={uploadRef} className="visually-hidden" type="file" multiple accept=".zip,.md,.txt,application/zip,text/markdown,text/plain" onChange={event => void uploadRequirements(event)} /><button onClick={onOpenKnowledge}><BookOpen />前往知识库管理版本</button><button onClick={onOpenActivity}><Clock3 />操作记录</button></div>
        </>}
      </aside>

      <main className="rr-main">
        <div className="rr-main-toolbar">
          <div className="rr-tabs" role="tablist" aria-label="需求评审视图">{viewTabs.map(tab => <button key={tab.key} className={view === tab.key ? 'active' : ''} role="tab" aria-selected={view === tab.key} onClick={() => setView(tab.key)}><tab.icon />{tab.label}</button>)}</div>
          <label className="rr-history"><Clock3 /><span>运行历史</span><select value={selectedRun?.id ?? ''} onChange={event => selectRun(event.target.value)}><option value="">尚无运行</option>{runsForDocument.map(run => <option value={run.id} key={run.id}>{formatTime(run.createdAt)} · {runLabel(run.status)}</option>)}</select><ReviewBadge tone="gray">当前会话</ReviewBadge></label>
        </div>

        {selectedRun?.status === 'running' && <div className="rr-live-status"><LoaderCircle className="rotating" /><div><b>RequirementAnalysisAgent 正在执行</b><span>服务端当前以单次请求返回结果；前端显示真实等待状态，不播放模拟进度。</span><i /></div><ReviewBadge tone="purple">可取消</ReviewBadge></div>}
        {selectedRun?.status === 'failed' && <div className="rr-error-status"><XCircle /><div><b>评审运行失败</b><span>{selectedRun.error}</span></div></div>}
        {selectedRun?.status === 'cancelled' && <div className="rr-warning-status"><AlertTriangle /><div><b>评审已取消</b><span>{selectedRun.error}</span></div></div>}

        <div className="rr-view-content">
          {view === 'overview' && <OverviewView result={result} stats={stats} visibleFindings={visibleFindings} selectedFindingId={selectedFindingId} selectedRun={selectedRun} findingStates={findingStates} findingTypeFilter={findingTypeFilter} setFindingTypeFilter={setFindingTypeFilter} severityFilter={severityFilter} setSeverityFilter={setSeverityFilter} basisFilter={basisFilter} setBasisFilter={setBasisFilter} findingStateFilter={findingStateFilter} setFindingStateFilter={setFindingStateFilter} onSelectFinding={setSelectedFindingId} onLocate={locateFinding} onQuote={quoteFinding} onState={updateFindingState} onStart={startAnalysis} canRun={canRun} />}
          {view === 'source' && <SourceDocumentView document={selectedDocument} content={documentContent} format={documentFormat} outline={outline} activeSectionKey={activeSectionKey} selectedEvidence={selectedEvidenceId ? evidenceById.get(selectedEvidenceId) : undefined} sourceRef={sourceRef} knowledgeBaseId={knowledgeBaseId} onSection={setActiveSectionKey} onQuote={captureSourceQuote} />}
          {view === 'diff' && <DiffView versions={versionHistory} value={diffVersionIds} onChange={setDiffVersionIds} loading={diffLoading} removed={removedLines} added={addedLines} />}
          {view === 'tree' && <FeatureTreeView outline={outline.sections} reviewedAreas={result?.coverage.reviewedAreas ?? []} evidence={result?.evidence ?? []} findings={result?.findings ?? []} onOpenSection={key => { setActiveSectionKey(key); setView('source') }} />}
          {view === 'evidence' && <EvidenceView evidence={result?.evidence ?? []} findings={result?.findings ?? []} selectedEvidenceId={selectedEvidenceId} onLocate={locateEvidence} />}
        </div>
      </main>

      <aside className="rr-chat">
        <div className="rr-panel-head"><span><MessageSquareText /><b>评审问答</b></span><button onClick={() => setChatCollapsed(value => !value)} aria-label={chatCollapsed ? '展开评审问答' : '收起评审问答'}>{chatCollapsed ? <PanelRightOpen /> : <PanelRightClose />}</button></div>
        {!chatCollapsed && <><div className="rr-chat-context"><ShieldCheck /><span><b>{selectedRun?.status === 'succeeded' ? '已绑定固定评审运行' : '等待成功评审运行'}</b><small>{selectedRun?.response ? `${selectedRun.response.snapshot.assetVersionId} · ${selectedRun.response.result.evidence.length} 条证据` : '问答不会自动切换到最新需求版本'}</small></span><ReviewBadge tone={selectedRun?.status === 'succeeded' ? 'green' : 'gray'}>{selectedRun?.status === 'succeeded' ? '只读上下文' : '不可用'}</ReviewBadge></div>
          <div className="rr-chat-scroll">{currentMessages.length ? currentMessages.map((message, index) => <div className={`rr-message ${message.role}`} key={`${message.role}-${index}`}>{message.quote && <blockquote><Quote />{message.quote.findingId ? `Finding ${message.quote.findingId}` : `${message.quote.heading}${message.quote.startLine ? ` · L${message.quote.startLine}` : ''}`}<span>{message.quote.text}</span></blockquote>}<b>{message.role === 'user' ? '你' : '系统状态'}</b><p>{message.text}</p></div>) : <div className="rr-chat-empty"><Bot /><h3>基于本次评审继续追问</h3><p>可从 Finding 或原始文档引用上下文。当前后端尚未提供问答接口，因此不会生成模拟答案。</p>{result?.findings.slice(0, 3).map(finding => <button key={finding.clientFindingId} onClick={() => quoteFinding(finding)}><Quote />引用：{finding.title}</button>)}</div>}</div>
          {sourceQuote && <div className="rr-quote-preview"><Quote /><span><b>{sourceQuote.findingId ? `Finding ${sourceQuote.findingId}` : sourceQuote.heading}</b><small>{sourceQuote.text}</small></span><button onClick={() => setSourceQuote(null)} aria-label="移除引用"><XCircle /></button></div>}
          <div className="rr-chat-input"><textarea value={chatDraft} onChange={event => setChatDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendChat() } }} disabled={selectedRun?.status !== 'succeeded'} placeholder={selectedRun?.status === 'succeeded' ? '基于固定评审运行提问…' : '完成一次真实评审后可引用提问'} /><div><span><CircleHelp />问答 API 待接入</span><button onClick={sendChat} disabled={!chatDraft.trim() || selectedRun?.status !== 'succeeded'} aria-label="发送评审问题"><Send /></button></div></div></>}
      </aside>
    </div>
  </section>
}

function OverviewView({ result, stats, visibleFindings, selectedFindingId, selectedRun, findingStates, findingTypeFilter, setFindingTypeFilter, severityFilter, setSeverityFilter, basisFilter, setBasisFilter, findingStateFilter, setFindingStateFilter, onSelectFinding, onLocate, onQuote, onState, onStart, canRun }: {
  result?: RequirementAnalysisResponse['result']; stats: { features: number; findings: number; high: number; pending: number; evidence: number }; visibleFindings: ReviewFinding[]; selectedFindingId: string; selectedRun?: RunRecord; findingStates: Record<string, FindingState>;
  findingTypeFilter: 'all' | ReviewFindingType; setFindingTypeFilter: (value: 'all' | ReviewFindingType) => void; severityFilter: 'all' | ReviewSeverity; setSeverityFilter: (value: 'all' | ReviewSeverity) => void; basisFilter: 'all' | 'evidence' | 'inference'; setBasisFilter: (value: 'all' | 'evidence' | 'inference') => void; findingStateFilter: 'all' | FindingState; setFindingStateFilter: (value: 'all' | FindingState) => void;
  onSelectFinding: (id: string) => void; onLocate: (finding: ReviewFinding) => void; onQuote: (finding: ReviewFinding) => void; onState: (finding: ReviewFinding, state: FindingState) => void; onStart: () => void; canRun: boolean
}) {
  if (!result) return <div className="rr-empty"><Sparkles /><b>{selectedRun?.status === 'running' ? '正在等待真实评审结果' : '尚未生成评审结果'}</b><p>选择 ready 的需求资产和健康模型，运行 RequirementAnalysisAgent 后查看结构化 Finding、证据和覆盖范围。</p>{selectedRun?.status !== 'running' && <button className="btn primary" onClick={onStart} disabled={!canRun}><Play />开始真实评审</button>}</div>
  return <div className="rr-overview">
    <div className="rr-assessment"><div><span>AI 评审摘要</span><h2>{result.summary.overallAssessment === 'blocked' ? '存在阻断问题' : result.summary.overallAssessment === 'needs_revision' ? '建议修改后确认' : result.summary.overallAssessment === 'pass_with_notes' ? '附带关注项通过' : '评审通过'}</h2><p>{result.summary.risks[0] ?? result.summary.strengths[0] ?? '本次评审已完成结构化校验。'}</p></div><div className="rr-score"><strong>{result.summary.score}</strong><span>综合评分</span></div></div>
    <div className="rr-stat-grid"><article><FileText /><span>功能章节</span><strong>{stats.features}</strong><small>固定原文大纲</small></article><article><AlertTriangle /><span>Finding</span><strong>{stats.findings}</strong><small>正式结构化结果</small></article><article className="danger"><ShieldCheck /><span>阻断/高风险</span><strong>{stats.high}</strong><small>优先人工确认</small></article><article className="warning"><CircleHelp /><span>待确认</span><strong>{stats.pending}</strong><small>无固定证据</small></article><article className="success"><CheckCircle2 /><span>有证据项</span><strong>{stats.evidence}</strong><small>可定位固定原文</small></article></div>
    <div className="rr-finding-toolbar"><span><ListFilter />Finding 筛选</span><select value={findingTypeFilter} onChange={event => setFindingTypeFilter(event.target.value as 'all' | ReviewFindingType)}><option value="all">全部类型</option>{Object.entries(findingTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><select value={severityFilter} onChange={event => setSeverityFilter(event.target.value as 'all' | ReviewSeverity)}><option value="all">全部严重度</option>{Object.entries(severityLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><select value={basisFilter} onChange={event => setBasisFilter(event.target.value as typeof basisFilter)}><option value="all">全部依据</option><option value="evidence">有固定证据</option><option value="inference">模型推测</option></select><select value={findingStateFilter} onChange={event => setFindingStateFilter(event.target.value as 'all' | FindingState)}><option value="all">全部处置</option>{Object.entries(findingStateLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><small>{visibleFindings.length} / {result.findings.length}</small></div>
    <div className="rr-findings">{visibleFindings.map(finding => {
      const state = selectedRun ? findingStates[`${selectedRun.id}:${finding.clientFindingId}`] ?? 'open' : 'open'
      const supported = finding.evidenceRefs.length > 0
      return <article className={`rr-finding-card ${selectedFindingId === finding.clientFindingId ? 'selected' : ''}`} key={finding.clientFindingId} onClick={() => onSelectFinding(finding.clientFindingId)}><header><span className={`rr-risk-icon ${severityTone(finding.severity)}`}><AlertTriangle /></span><div><span>{findingTypeLabels[finding.type]} · {finding.clientFindingId}</span><h3>{finding.title}</h3></div><ReviewBadge tone={severityTone(finding.severity)}>{severityLabels[finding.severity]}风险</ReviewBadge><ReviewBadge tone={supported ? 'green' : 'orange'}>{supported ? `${finding.evidenceRefs.length} 条固定证据` : '模型推测'}</ReviewBadge></header><p>{finding.description}</p><dl><div><dt>影响</dt><dd>{finding.impact}</dd></div><div><dt>建议确认</dt><dd>{finding.recommendation}</dd></div></dl><footer><span>置信度 {Math.round(finding.confidence * 100)}% · <b>{findingStateLabels[state]}</b></span><div><button onClick={event => { event.stopPropagation(); onLocate(finding) }}><BookOpen />定位原文</button><button onClick={event => { event.stopPropagation(); onQuote(finding) }}><MessageSquareText />追问</button><select aria-label={`处置 ${finding.title}`} value={state} onClick={event => event.stopPropagation()} onChange={event => onState(finding, event.target.value as FindingState)}>{Object.entries(findingStateLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div></footer></article>
    })}{!visibleFindings.length && <div className="rr-empty compact"><ListFilter /><b>没有匹配的 Finding</b><p>调整筛选条件后重试。</p></div>}</div>
  </div>
}

function SourceDocumentView({ document, content, format, outline, activeSectionKey, selectedEvidence, sourceRef, knowledgeBaseId, onSection, onQuote }: { document?: KnowledgeDocument; content: string; format: 'markdown' | 'text'; outline: ReturnType<typeof parseMarkdownOutline>; activeSectionKey: string | null; selectedEvidence?: ReviewEvidence; sourceRef: React.RefObject<HTMLDivElement | null>; knowledgeBaseId: string; onSection: (key: string) => void; onQuote: () => void }) {
  if (!document || !content) return <div className="rr-empty"><BookOpen /><b>固定原文不可用</b><p>请确认需求资产版本已达到 ready 状态。</p></div>
  return <div className="rr-source-layout"><nav className="rr-outline"><header><b>本文目录</b><ReviewBadge tone="blue">{outline.sections.length}</ReviewBadge></header>{outline.sections.map(section => <button className={activeSectionKey === section.key ? 'active' : ''} style={{ paddingLeft: `${12 + Math.max(0, section.depth - 2) * 10}px` }} onClick={() => onSection(section.key)} key={section.key}><span>{section.title}</span></button>)}</nav><article className="rr-source-document"><header><div><ReviewBadge tone="blue">{format === 'text' ? 'TXT' : 'Markdown'}</ReviewBadge><b>{document.title}</b><span>{document.assetVersionId}</span></div><span><ShieldCheck />只读固定版本</span></header>{selectedEvidence && <div className="rr-evidence-banner"><ShieldCheck /><span><b>已定位证据 · {selectedEvidence.locator.heading}</b><small>{selectedEvidence.quote}</small></span><ReviewBadge tone="green">{selectedEvidence.sourceRef.chunkId}</ReviewBadge></div>}<div className="rr-markdown" ref={sourceRef} onMouseUp={onQuote}><MarkdownDocument source={content} format={format} knowledgeBaseId={knowledgeBaseId} logicalPath={document.logicalPath ?? document.name} outline={outline} activeSectionKey={activeSectionKey} anchorPrefix={`review-${document.assetVersionId}`} /></div><footer><Quote />选中原文可引用到右侧评审问答；不会修改或覆盖固定需求版本。</footer></article></div>
}

function DiffView({ versions, value, onChange, loading, removed, added }: { versions: NonNullable<KnowledgeDocument['versions']>; value: [string, string]; onChange: (value: [string, string]) => void; loading: boolean; removed: string[]; added: string[] }) {
  if (versions.length < 2) return <div className="rr-empty"><FileDiff /><b>暂无可比较版本</b><p>同一需求资产至少需要两个 ready 的固定版本。</p></div>
  return <div className="rr-diff"><header><div><span>基准版本</span><select value={value[0]} onChange={event => onChange([event.target.value, value[1]])}>{versions.map(item => <option value={item.id} key={item.id}>V{item.number} · {item.id}</option>)}</select></div><ChevronRight /><div><span>目标版本</span><select value={value[1]} onChange={event => onChange([value[0], event.target.value])}>{versions.map(item => <option value={item.id} key={item.id}>V{item.number} · {item.id}</option>)}</select></div><ReviewBadge tone="blue">真实固定版本</ReviewBadge></header>{loading ? <div className="rr-empty compact"><LoaderCircle className="rotating" /><b>正在读取固定版本</b></div> : <div className="rr-diff-columns"><section><h3>删除内容 <span>{removed.length}</span></h3>{removed.map((line, index) => <p className="removed" key={`${line}-${index}`}>− {line}</p>)}{!removed.length && <small>没有检测到删除行。</small>}</section><section><h3>新增内容 <span>{added.length}</span></h3>{added.map((line, index) => <p className="added" key={`${line}-${index}`}>+ {line}</p>)}{!added.length && <small>没有检测到新增行。</small>}</section></div>}</div>
}

function FeatureTreeView({ outline, reviewedAreas, evidence, findings, onOpenSection }: { outline: ReturnType<typeof parseMarkdownOutline>['sections']; reviewedAreas: string[]; evidence: ReviewEvidence[]; findings: ReviewFinding[]; onOpenSection: (key: string) => void }) {
  const countFor = (title: string) => {
    const evidenceIds = new Set(evidence.filter(item => item.locator.heading.includes(title) || title.includes(item.locator.heading)).map(item => item.clientEvidenceId))
    return findings.filter(finding => finding.evidenceRefs.some(reference => evidenceIds.has(reference))).length
  }
  return <div className="rr-tree"><header><GitBranch /><div><h2>需求功能树</h2><p>由固定 Markdown 大纲与正式 Evidence 关系生成，不包含测试用例。</p></div><ReviewBadge tone="green">{outline.length} 个章节</ReviewBadge></header><div className="rr-tree-root"><span><FileText /></span><div><b>需求范围</b><small>{reviewedAreas.length ? `已评审：${reviewedAreas.join('、')}` : '等待真实评审覆盖信息'}</small></div></div>{outline.map(section => <button className="rr-tree-node" style={{ marginLeft: `${Math.max(0, section.depth - 2) * 22}px` }} key={section.key} onClick={() => onOpenSection(section.key)}><ChevronRight /><span><b>{section.title}</b><small>定位到固定原文章节</small></span><ReviewBadge tone={countFor(section.title) ? 'orange' : 'gray'}>{countFor(section.title)} 条 Finding</ReviewBadge></button>)}</div>
}

function EvidenceView({ evidence, findings, selectedEvidenceId, onLocate }: { evidence: ReviewEvidence[]; findings: ReviewFinding[]; selectedEvidenceId: string; onLocate: (evidence: ReviewEvidence, findingId?: string) => void }) {
  if (!evidence.length) return <div className="rr-empty"><ShieldCheck /><b>暂无固定证据</b><p>只有通过服务端引用校验的 Evidence 才会出现在这里。</p></div>
  return <div className="rr-evidence-list"><header><div><ShieldCheck /><span><h2>固定证据引用</h2><p>点击后始终打开 Evidence 指定的资产版本，不跳转 latest。</p></span></div><ReviewBadge tone="green">{evidence.length} 条已校验证据</ReviewBadge></header>{evidence.map(item => {
    const linked = findings.filter(finding => finding.evidenceRefs.includes(item.clientEvidenceId))
    return <button className={selectedEvidenceId === item.clientEvidenceId ? 'active' : ''} key={item.clientEvidenceId} onClick={() => onLocate(item, linked[0]?.clientFindingId)}><span className="rr-evidence-number">{item.clientEvidenceId}</span><span><b>{item.locator.heading}</b><p>“{item.quote}”</p><small>{item.sourceRef.assetVersionId} · {item.sourceRef.chunkId} · 定位 {item.locator.start}–{item.locator.end}</small></span><span className="rr-evidence-links">{linked.map(finding => <ReviewBadge tone={severityTone(finding.severity)} key={finding.clientFindingId}>{finding.clientFindingId}</ReviewBadge>)}</span><ChevronRight /></button>
  })}</div>
}
