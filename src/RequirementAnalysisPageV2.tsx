import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, AlertTriangle, BookOpen, Bot, CheckCircle2, Clock3, Download, FileDiff, FileText,
  FolderOpen, GitBranch, LoaderCircle, Play, Quote, RefreshCw, ShieldCheck, Sparkles, TestTube2, Trash2, Wrench, XCircle,
} from 'lucide-react'
import type { KnowledgeDocument } from './prototype-data'
import { loadAssetVersion } from './knowledge-api'
import { MarkdownDocument } from './MarkdownDocument'
import { PlanningContextMetrics, PlanningSubAgentRuns } from './PlanningObservability'
import { runRequirementReviewer } from './planning-api'
import {
  cancelRequirementAnalysisRun,
  actOnPlanningClarifications,
  downloadRequirementAnalysisReport,
  loadRequirementAnalysisRun,
  loadRequirementAnalysisRuns,
  retryRequirementAnalysisRun,
  retryAutomaticTestDesign,
  requirementReleaseArtifactUrl,
  startRequirementAnalysis,
  type AgentExecutionEvent,
  type AgentExecutionRecord,
  type RequirementAnalysisResponse,
  type RequirementReleasePackage,
  type AnalysisEvidence,
  type RequirementAnalysisRun,
  type PlanningClarification,
} from './requirement-analysis-api'
import { requirementAnalysisInputTypeForDocument, requirementWorkspaceDirectory } from './version-document-path'
import { loadAgentConfiguration, type AgentConfigurationState } from './agent-configuration-api'
import type { ProjectVersion } from './project-version-api'
import { loadRun as loadTestDesignRun } from './test-design/api'
import type { TestDesignNodeRun, TestDesignWorkflowRun } from './test-design/types'
import './requirement-analysis-v2.css'
import './requirement-analysis-review-flow.css'

const EmbeddedTestDesignPage = lazy(() => import('./test-design/TestDesignPage').then(module => ({ default: module.TestDesignPage })))

type Notify = (message: string, tone?: 'success' | 'error' | 'warning') => void
type ViewKey = 'conversation' | 'clarifications' | 'cases' | 'details'
type DetailViewKey = 'baseline' | 'artifacts' | 'diff'
type ClarificationAction = 'answer' | 'dismiss'
type RunRecord = RequirementAnalysisRun & { content?: string }
type RequirementStageState = 'complete' | 'current' | 'waiting' | 'blocked'

type Props = {
  projectVersion: ProjectVersion | null
  documents: KnowledgeDocument[]
  knowledgeBaseId: string
  apiState: 'connecting' | 'ready' | 'offline'
  refreshKnowledge: () => Promise<void>
  onManageVersions: () => void
  onOpenKnowledge: () => void
  onOpenActivity: () => void
  onOpenInputDocument?: (document: KnowledgeDocument) => void
  onDeleteInputDocument?: (document: KnowledgeDocument) => void
  canDeleteInputDocument?: boolean
  notify: Notify
  addAudit: (entry: string) => void
}

const viewTabs: Array<{ key: ViewKey; label: string; icon: typeof Sparkles }> = [
  { key: 'conversation', label: 'Agent 协作', icon: Bot },
  { key: 'clarifications', label: '待确认问题', icon: Quote },
  { key: 'cases', label: '测试用例', icon: TestTube2 },
  { key: 'details', label: '详细信息', icon: ShieldCheck },
]
const detailTabs: Array<{ key: DetailViewKey; label: string }> = [
  { key: 'baseline', label: '需求基线' },
  { key: 'artifacts', label: '正式产物' },
  { key: 'diff', label: '版本差异' },
]

function Badge({ children, tone = 'gray' }: { children: React.ReactNode; tone?: string }) { return <span className={`rav2-badge ${tone}`}>{children}</span> }
function formatTime(value: string) { return new Date(value).toLocaleString('zh-CN', { hour12: false }) }
function assessmentLabel(value?: string) { return value === 'blocked' ? '存在阻断问题' : value === 'needs_revision' ? '建议修改后确认' : value === 'pass_with_notes' ? '附带关注项通过' : value === 'pass' ? '可以进入下一阶段' : '等待分析' }
function runLabel(run?: RunRecord) {
  if (run?.status === 'running') return '分析中'
  if (run?.status === 'waiting_clarification') return '等待业务确认'
  if (run?.status === 'succeeded') return run.workflow?.release?.status === 'published' ? '需求基线已发布' : '正在发布需求基线'
  return run?.status === 'failed' ? '失败' : run?.status === 'cancelled' ? '已取消' : '未运行'
}
const agentEventLabels: Record<string, string> = {
  runtime_initialized: 'Runtime 已初始化', agent_start: 'Agent 已启动', agent_end: 'Agent 已结束', turn_start: 'Turn 开始', turn_end: 'Turn 结束',
  message_start: '消息开始', message_end: '消息完成', tool_execution_start: '工具调用开始', tool_execution_end: '工具调用结束',
  input_package_built: '输入包已构建', input_batch_delivered: '输入批次已投递', input_final_merge_started: '开始合并输入',
  result_submission_required: '等待提交正式结果', result_submission_retry: '结果校验未通过，等待修正', evidence_repair_tools_enabled: '证据修复工具已启用',
  skill_bindings_loaded: '已校验 Agent Skill 绑定', skill_catalog_loaded: 'Skill Catalog 已加载',
  skill_read: 'Agent 已读取 Skill', skill_read_replayed: 'Skill 读取已从本轮缓存重放',
}
function eventTime(value: string) { return new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) }
function formatTraceValue(value: unknown) { if (value === undefined) return ''; try { return JSON.stringify(value, null, 2) } catch { return String(value) } }
function skillReadSummary(event: AgentExecutionEvent) {
  if (!event.skillKey) return ''
  return ` · ${event.type === 'skill_read_replayed' ? '本轮缓存' : 'Skill'}：${event.skillKey}${event.version ? ` · v${event.version}` : ''}`
}

type PlanningExecutionGroup = {
  id: string
  label: string
  status?: 'running' | 'waiting_clarification' | 'succeeded' | 'failed' | 'cancelled'
  execution: AgentExecutionRecord
  startedAt?: string
}

type HumanClarificationBatch = {
  id: string
  answeredAt: string
  answeredBy: string
  items: PlanningClarification[]
}

function sameExecution(left: AgentExecutionRecord, right: AgentExecutionRecord) {
  const leftLast = left.events.at(-1)
  const rightLast = right.events.at(-1)
  return left.events.length === right.events.length
    && leftLast?.sequence === rightLast?.sequence
    && leftLast?.occurredAt === rightLast?.occurredAt
}

function planningExecutionGroups(run?: RunRecord): PlanningExecutionGroup[] {
  const attempts = (run?.executionAttempts ?? []).flatMap(attempt => {
    const execution = attempt.executions?.planning
    return execution ? [{ id: `attempt-${attempt.attempt}`, label: `Worker Attempt ${attempt.attempt}/${attempt.maxAttempts}`, status: attempt.status, execution, startedAt: attempt.startedAt }] : []
  })
  const current = [run?.response?.executions?.planning, run?.executions?.planning, run?.execution?.agentKey === 'planning' ? run.execution : undefined]
    .filter((item): item is AgentExecutionRecord => Boolean(item))
    .sort((left, right) => left.events.length - right.events.length)
    .at(-1)
  if (!current || attempts.some(attempt => sameExecution(attempt.execution, current))) return attempts
  return [...attempts, { id: 'current', label: attempts.length ? '当前执行记录' : '执行记录', status: run?.status, execution: current, startedAt: current.events[0]?.occurredAt }]
}

function humanClarificationBatches(run?: RunRecord): HumanClarificationBatch[] {
  const batches = new Map<string, HumanClarificationBatch>()
  for (const item of run?.snapshot?.formalClarifications ?? []) {
    if (item.status === 'pending' || !item.answer?.trim() || !item.answeredAt) continue
    const answeredBy = item.answeredBy?.trim() || '未知提交人'
    const key = `${item.answeredAt}:${answeredBy}`
    const batch = batches.get(key) ?? { id: key, answeredAt: item.answeredAt, answeredBy, items: [] }
    batch.items.push(item)
    batches.set(key, batch)
  }
  return [...batches.values()].sort((left, right) => left.answeredAt.localeCompare(right.answeredAt))
}

function replaceRunDetail(current: RunRecord[], detail: RequirementAnalysisRun) {
  return current.map(item => item.id === detail.id
    ? { ...detail, ...(item.content === undefined ? {} : { content: item.content }) }
    : item)
}

export function RequirementAnalysisPageV2(props: Props) {
  const { projectVersion, documents, apiState, notify, addAudit, onManageVersions, onOpenKnowledge, onOpenActivity, onOpenInputDocument, onDeleteInputDocument, canDeleteInputDocument = false } = props
  const [view, setView] = useState<ViewKey>(() => {
    const params = new URL(window.location.href).searchParams
    return params.get('planningTab') === 'test-design' || Boolean(params.get('testDesignEntry')) ? 'cases' : 'conversation'
  })
  const [detailView, setDetailView] = useState<DetailViewKey>('baseline')
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [selectedRunId, setSelectedRunId] = useState('')
  const [loadingRuns, setLoadingRuns] = useState(false)
  const [starting, setStarting] = useState(false)
  const [agentConfiguration, setAgentConfiguration] = useState<AgentConfigurationState | null>(null)
  const [selectedDocumentId, setSelectedDocumentId] = useState('')
  const [sourceEvidence, setSourceEvidence] = useState<AnalysisEvidence | null>(null)
  const [sourceContent, setSourceContent] = useState('')
  const [sourceLoading, setSourceLoading] = useState(false)
  const [releaseBusy, setReleaseBusy] = useState(false)
  const [clarificationAnswers, setClarificationAnswers] = useState<Record<string, string>>({})
  const [clarificationActions, setClarificationActions] = useState<Record<string, ClarificationAction>>({})
  const [clarificationBusy, setClarificationBusy] = useState(false)
  const [diffVersionIds, setDiffVersionIds] = useState<[string, string]>(['', ''])
  const [diffContents, setDiffContents] = useState<Record<string, string>>({})
  const [diffLoading, setDiffLoading] = useState(false)
  const openDetails = (next: DetailViewKey) => { setDetailView(next); setView('details') }

  const projectVersionName = projectVersion?.name ?? ''
  const workspaceDirectoryPath = projectVersionName ? requirementWorkspaceDirectory(projectVersionName) : ''
  const analysisInputDocuments = useMemo(() => documents.filter(document => document.status === 'ready'
    && Boolean(document.assetVersionId)
    && Boolean(projectVersionName)
    && Boolean(requirementAnalysisInputTypeForDocument(projectVersionName, document.logicalPath ?? '', document.assetType))), [documents, projectVersionName])
  const requirementDocuments = useMemo(() => analysisInputDocuments.filter(document => requirementAnalysisInputTypeForDocument(projectVersionName, document.logicalPath ?? '', document.assetType)?.value === 'requirement'), [analysisInputDocuments, projectVersionName])
  const releaseBindings = projectVersion?.requirementReleaseBindings?.length
    ? projectVersion.requirementReleaseBindings
    : projectVersion?.requirementReleaseBinding ? [projectVersion.requirementReleaseBinding] : []
  const selectedRun = runs.find(run => run.id === selectedRunId)
  const result = selectedRun?.response?.result
  const workspaceSnapshot = selectedRun?.snapshot?.workspaceSnapshot
  const currentInputRefs = selectedRun?.snapshot?.currentInputRefs ?? []
  const selectedDocument = analysisInputDocuments.find(item => item.id === selectedDocumentId) ?? analysisInputDocuments[0]
  const analysisAgentReady = Boolean(agentConfiguration?.agents.planning.activeVersion)
  const canRun = Boolean(projectVersion && projectVersion.status === 'open' && requirementDocuments.length && analysisAgentReady && apiState === 'ready' && !starting)

  const refreshRuns = async () => {
    if (!projectVersion) { setRuns([]); setSelectedRunId(''); return }
    setLoadingRuns(true)
    try {
      const page = await loadRequirementAnalysisRuns(projectVersion.id)
      setRuns(page.items)
      const latestRunId = page.items[0]?.id ?? ''
      if (!selectedRunId || !page.items.some(item => item.id === selectedRunId)) setSelectedRunId(latestRunId)
    } catch (error) { notify(error instanceof Error ? error.message : '需求分析历史读取失败', 'error') }
    finally { setLoadingRuns(false) }
  }

  useEffect(() => { void refreshRuns() }, [projectVersion?.id])
  useEffect(() => { loadAgentConfiguration().then(setAgentConfiguration).catch(() => undefined) }, [])
  useEffect(() => { if (!selectedDocumentId || !analysisInputDocuments.some(item => item.id === selectedDocumentId)) setSelectedDocumentId(analysisInputDocuments[0]?.id ?? '') }, [analysisInputDocuments, selectedDocumentId])
  useEffect(() => {
    if (!selectedRun || selectedRun.id.startsWith('pending-')) return
    let cancelled = false; let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const detail = await loadRequirementAnalysisRun(selectedRun.id)
        if (cancelled) return
        setRuns(current => replaceRunDetail(current, detail))
        const automaticTransitionActive = detail.workflow?.automaticTransition?.status === 'pending' || detail.workflow?.automaticTransition?.status === 'running'
        if (detail.status === 'running' || automaticTransitionActive) timer = setTimeout(() => void poll(), 1_000)
      } catch { if (!cancelled && selectedRun.status === 'running') timer = setTimeout(() => void poll(), 2_000) }
    }
    void poll(); return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [selectedRun?.id, selectedRun?.status])
  useEffect(() => {
    const versions = (selectedDocument?.versions ?? []).filter(item => item.status === 'ready')
    const right = selectedDocument?.assetVersionId ?? versions.at(-1)?.id ?? ''
    const rightIndex = versions.findIndex(item => item.id === right)
    const left = versions[Math.max(0, rightIndex - 1)]?.id ?? versions.at(-2)?.id ?? ''
    setDiffVersionIds([left && left !== right ? left : '', right]); setDiffContents({})
  }, [selectedDocument?.id, selectedDocument?.assetVersionId])
  useEffect(() => {
    if (view !== 'details' || detailView !== 'diff') return
    const missing = diffVersionIds.filter(Boolean).filter(id => !(id in diffContents)); if (!missing.length) return
    let cancelled = false; setDiffLoading(true)
    Promise.all(missing.map(async id => [id, (await loadAssetVersion(id)).content] as const)).then(entries => {
      if (!cancelled) setDiffContents(current => ({ ...current, ...Object.fromEntries(entries) }))
    }).catch(error => { if (!cancelled) notify(error instanceof Error ? error.message : '固定版本读取失败', 'error') }).finally(() => { if (!cancelled) setDiffLoading(false) })
    return () => { cancelled = true }
  }, [view, detailView, diffVersionIds, diffContents])

  const startAnalysis = async () => {
    if (!projectVersion || !canRun) return
    setStarting(true)
    try {
      const started = await startRequirementAnalysis(projectVersion.id, { documentDirectoryPath: workspaceDirectoryPath, focusAreas: ['功能完整性', '业务闭环', '异常流程', '边界条件', '跨需求一致性', '可测试性'] })
      setRuns(current => [started, ...current.filter(item => item.id !== started.id)]); setSelectedRunId(started.id); setView('conversation')
      addAudit(`启动 PlanningAgent 需求分析：${started.id}`); notify('需求分析已在当前 Planning Session 启动。')
    } catch (error) { notify(error instanceof Error ? error.message : '需求分析启动失败', 'error') } finally { setStarting(false) }
  }

  const resolveClarifications = async () => {
    if (!selectedRun || clarificationBusy) return
    const pending = (selectedRun.response?.result.clarifications ?? []).filter(item => item.blocking && item.status === 'pending')
    if (!pending.length) return
    const missingActions = pending.filter(item => !clarificationActions[item.id])
    if (missingActions.length) { notify(`请先为全部 ${pending.length} 个阻断问题选择“提供业务事实”或“人工处置”；仍缺少 ${missingActions.length} 项。`, 'warning'); return }
    const missingAnswers = pending.filter(item => !(clarificationAnswers[item.id] ?? '').trim())
    if (missingAnswers.length) { notify(`请填写全部 ${pending.length} 项的业务事实或处置理由；仍缺少 ${missingAnswers.length} 项。`, 'warning'); return }
    setClarificationBusy(true)
    try {
      const items = pending.map(item => ({ clarificationId: item.id, action: clarificationActions[item.id], answer: clarificationAnswers[item.id].trim() }))
      const resolved = await actOnPlanningClarifications(selectedRun.id, { items })
      setRuns(current => replaceRunDetail(current, resolved.run))
      setClarificationAnswers(current => ({ ...current, ...Object.fromEntries(pending.map(item => [item.id, ''])) }))
      setClarificationActions(current => {
        const next = { ...current }
        pending.forEach(item => delete next[item.id])
        return next
      })
      setView('conversation')
      const answeredCount = items.filter(item => item.action === 'answer').length
      const dismissedCount = items.length - answeredCount
      notify(`已在当前 Run 保存 ${answeredCount} 个业务事实、${dismissedCount} 个人工处置；服务端正在发布 Requirement Release 并自动进入测试设计。`)
      addAudit(`批量处理 Planning Clarification：${items.map(item => `${item.clarificationId} · ${item.action}`).join('、')}`)
    } catch (error) { notify(error instanceof Error ? error.message : '待确认问题批量保存失败', 'error') }
    finally { setClarificationBusy(false) }
  }
  const cancelAnalysis = async () => {
    if (!selectedRun || selectedRun.status !== 'running') return
    try { const cancelled = await cancelRequirementAnalysisRun(selectedRun.id); setRuns(current => current.map(item => item.id === cancelled.id ? cancelled : item)); notify('已取消本次需求分析。', 'warning') }
    catch (error) { notify(error instanceof Error ? error.message : '取消失败', 'error') }
  }
  const retryAnalysis = async () => {
    if (!selectedRun || selectedRun.status === 'running') return
    setStarting(true)
    try { const started = await retryRequirementAnalysisRun(selectedRun.id); setRuns(current => [started, ...current.filter(item => item.id !== started.id)]); setSelectedRunId(started.id); setView('conversation'); notify('已创建新的完整需求分析运行。') }
    catch (error) { notify(error instanceof Error ? error.message : '重跑失败', 'error') } finally { setStarting(false) }
  }
  const exportReport = async () => {
    if (!projectVersion || !selectedRun?.response) return
    try { const blob = await downloadRequirementAnalysisReport(projectVersion.id, selectedRun.id); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${projectVersion.name}-需求分析报告.md`; link.click(); URL.revokeObjectURL(url) }
    catch (error) { notify(error instanceof Error ? error.message : '报告导出失败', 'error') }
  }
  const openEvidence = async (evidence: AnalysisEvidence) => {
    setSourceEvidence(evidence); setSourceContent(''); setSourceLoading(true)
    try { setSourceContent((await loadAssetVersion(evidence.sourceRef.assetVersionId)).content) }
    catch (error) { notify(error instanceof Error ? error.message : '原文读取失败', 'error'); setSourceEvidence(null) } finally { setSourceLoading(false) }
  }
  const clarifications = result?.clarifications ?? []
  const pendingClarifications = clarifications.filter(item => item.status === 'pending')
  const blockingClarifications = pendingClarifications.filter(item => item.blocking)
  const blockingClarificationHistory = clarifications.filter(item => item.blocking)
  const release = selectedRun?.workflow?.release
  const retryAutomaticTransition = async () => {
    if (!selectedRun) return
    setReleaseBusy(true)
    try {
      await retryAutomaticTestDesign(selectedRun.id)
      const detail = await loadRequirementAnalysisRun(selectedRun.id)
      setRuns(current => replaceRunDetail(current, detail))
      notify('已重新启动自动测试设计。')
    } catch (error) { notify(error instanceof Error ? error.message : '自动测试设计重试失败', 'error') }
    finally { setReleaseBusy(false) }
  }
  const versionHistory = (selectedDocument?.versions ?? []).filter(item => item.status === 'ready')
  const leftLines = (diffContents[diffVersionIds[0]] ?? '').split(/\r?\n/).filter(Boolean); const rightLines = (diffContents[diffVersionIds[1]] ?? '').split(/\r?\n/).filter(Boolean)
  const removedLines = leftLines.filter(line => !rightLines.includes(line)); const addedLines = rightLines.filter(line => !leftLines.includes(line))
  const enabledSkills = agentConfiguration?.agents.planning.activeVersion?.agentDefinition.enabledSkills ?? []
  const automaticTransition = selectedRun?.workflow?.automaticTransition
  const linkedTestDesign = automaticTransition?.testDesignId && automaticTransition.testDesignRunId
    ? { designId: automaticTransition.testDesignId, runId: automaticTransition.testDesignRunId }
    : undefined
  const currentProjectVersionId = projectVersion?.id
  const selectedReleaseBinding = selectedRun ? releaseBindings.find(binding => binding.verificationRunId === selectedRun.id && binding.releaseId === selectedRun.workflow?.release?.id) : undefined
  const testDesignReady = Boolean(selectedRun && selectedReleaseBinding
    && selectedRun.projectVersionId === currentProjectVersionId
    && selectedRun.status === 'succeeded'
    && selectedRun.workflow?.release?.id === selectedReleaseBinding.releaseId
    && selectedRun.workflow.release.status === 'published')
  const stages: Array<{ label: string; detail: string; state: RequirementStageState }> = [
    { label: '资料输入', detail: analysisInputDocuments.length ? `${analysisInputDocuments.length} 份已就绪` : '待上传', state: analysisInputDocuments.length ? 'complete' : 'current' },
    { label: '需求分析与发布', detail: !selectedRun ? '当前对话未开始' : selectedRun.status === 'running' ? `${selectedRun.progress}%` : blockingClarifications.length ? `等待 ${blockingClarifications.length} 个业务事实` : testDesignReady ? 'Requirement Release 已发布' : selectedRun.status === 'failed' ? '执行失败' : '正在发布', state: !selectedRun ? 'waiting' : selectedRun.status === 'running' || blockingClarifications.length ? 'current' : testDesignReady ? 'complete' : selectedRun.status === 'failed' ? 'blocked' : 'waiting' },
    { label: 'Agent 自动设计测试', detail: automaticTransition?.status === 'succeeded' ? '测试设计运行已创建，请查看实时进度' : automaticTransition?.status === 'failed' ? '自动衔接失败' : automaticTransition?.status === 'running' || automaticTransition?.status === 'pending' ? '正在创建测试设计运行' : testDesignReady ? '可基于本次发布的 Release 设计测试' : '等待 Requirement Release', state: automaticTransition?.status === 'succeeded' ? 'complete' : automaticTransition?.status === 'failed' ? 'blocked' : automaticTransition?.status === 'running' || automaticTransition?.status === 'pending' || testDesignReady ? 'current' : 'waiting' },
    { label: '最终用例审核与发布', detail: automaticTransition?.status === 'succeeded' ? '在测试设计运行完成后审核 TestCase / Proposal' : '等待 Agent 完成', state: automaticTransition?.status === 'succeeded' ? 'current' : 'waiting' },
  ]
  const activityExecution = planningExecutionGroups(selectedRun).at(-1)?.execution
  const activityEvents = activityExecution?.events ?? []
  const latestActivity = activityEvents.at(-1)

  if (!projectVersion) return <section className="card rav2-gate"><GitBranch /><h1>新建项目版本后才能进行需求分析</h1><button className="btn primary" onClick={onManageVersions}>新建项目版本</button></section>

  return <section className="card rav2-page rav2-session-page">
    <div className="rav2-planning-layout">
      <aside className="rav2-workspace">
        <header><span><FolderOpen /><b>Project Workspace</b></span><Badge tone="blue">{workspaceSnapshot?.files.length ?? analysisInputDocuments.length}</Badge></header>
        <div className="rav2-workspace-observability"><div><span><small>本次重点输入</small><b>{currentInputRefs.length || requirementDocuments.length}</b></span><span><small>Workspace Snapshot</small><b>{workspaceSnapshot?.files.length ?? '—'}</b></span></div></div>
        <div className="rav2-docs">{analysisInputDocuments.map(document => { const inputType = requirementAnalysisInputTypeForDocument(projectVersion.name, document.logicalPath ?? '', document.assetType)!; const active = selectedDocument?.id === document.id; const inputStatus = inputType.value === 'requirement' ? '本次重点输入' : '分析参考输入'; return <div className={`rav2-document-row ${active ? 'active' : ''}`} key={document.id}><button className="rav2-document-open" onClick={() => { setSelectedDocumentId(document.id); onOpenInputDocument?.(document) }}><span><FileText /></span><div><b>{document.title}</b><small><i className={`rav2-document-kind ${inputType.value}`}>{inputType.label}</i> · {inputStatus} · {document.version}</small><em>{document.logicalPath}</em></div></button>{onDeleteInputDocument && <button className="rav2-document-delete" aria-label={`删除${inputType.label} ${document.title || document.name}`} title={`删除${inputType.label}`} disabled={!canDeleteInputDocument} onClick={() => onDeleteInputDocument(document)}><Trash2 /></button>}</div>})}</div>
        <footer><button className="rav2-workspace-action rav2-workspace-action-knowledge" onClick={onOpenKnowledge}><BookOpen /><span>知识库</span></button><button className="rav2-workspace-action rav2-workspace-action-versions" onClick={onManageVersions}><GitBranch /><span>版本管理</span></button><button className="rav2-workspace-action rav2-workspace-action-activity" onClick={onOpenActivity}><Clock3 /><span>操作记录</span></button></footer>
      </aside>

      <main className="rav2-session-panel">
        <header className="rav2-session-header">
          <div className="rav2-session-identity"><span><Sparkles /></span><div><b>PlanningAgent</b><small>{projectVersion.name} · 需求分析</small></div></div>
          <details className="rav2-skill-chips"><summary><ShieldCheck />运行配置</summary><div><em>已启用 Skills</em>{enabledSkills.length ? enabledSkills.map(skill => <span key={skill}>{skill}</span>) : <span className="empty">未发布配置</span>}</div></details>
          <div className="rav2-session-actions"><select aria-label="需求分析运行历史" value={selectedRunId} onChange={event => setSelectedRunId(event.target.value)} disabled={loadingRuns}><option value="">新建对话</option>{runs.map(run => <option value={run.id} key={run.id}>{formatTime(run.createdAt)} · {runLabel(run)}</option>)}</select><button aria-label="刷新运行" onClick={() => void refreshRuns()}><RefreshCw /></button><button aria-label="下载分析报告" onClick={exportReport} disabled={!selectedRun?.response}><Download /></button></div>
        </header>
        <nav className="rav2-session-tabs">{viewTabs.map(tab => <button className={view === tab.key ? 'active' : ''} key={tab.key} onClick={() => setView(tab.key)}><tab.icon />{tab.label}{tab.key === 'clarifications' && blockingClarifications.length ? <i>{blockingClarifications.length}</i> : null}</button>)}</nav>
        <div className={`rav2-session-body ${view === 'conversation' ? 'conversation' : view === 'cases' ? 'cases' : 'detail'}`}>
          {view === 'conversation' && <AgentConversation run={selectedRun} projectVersionId={projectVersion.id} linkedTestDesign={linkedTestDesign} onReviewed={detail => setRuns(current => replaceRunDetail(current, detail))} notify={notify} />}
          {view === 'clarifications' && <Clarifications items={blockingClarificationHistory} answers={clarificationAnswers} actions={clarificationActions} busy={clarificationBusy} onAnswerChange={(id, value) => setClarificationAnswers(current => ({ ...current, [id]: value }))} onActionChange={(id, action) => setClarificationActions(current => ({ ...current, [id]: action }))} onSubmit={() => void resolveClarifications()} />}
          {view === 'cases' && <Suspense fallback={<div className="rav2-empty"><LoaderCircle className="rotating" /><h2>正在加载测试设计运行</h2><p>正在建立测试设计的正式上下文。</p></div>}>{linkedTestDesign ? <EmbeddedTestDesignPage key={`${selectedRun?.id}:${linkedTestDesign.designId}:${linkedTestDesign.runId}`} embedded projectVersion={projectVersion} onManageVersions={onManageVersions} notify={notify} linkedDesignId={linkedTestDesign.designId} linkedRunId={linkedTestDesign.runId} /> : testDesignReady ? <EmbeddedTestDesignPage key={`new-test-design:${projectVersion.id}:${selectedReleaseBinding?.releaseId}`} projectVersion={projectVersion} onManageVersions={onManageVersions} notify={notify} initialCreate /> : <div className="rav2-empty"><ShieldCheck /><h2>{selectedRun ? '本次需求分析尚未发布' : '请先完成需求分析'}</h2><p>{selectedRun ? '只有当前选择的成功需求分析 Run 发布 Requirement Release 后，才能创建测试设计。' : '请先在新建对话中启动需求分析，或从运行历史选择一个已发布 Requirement Release 的 Run。'}</p></div>}</Suspense>}
          {view === 'details' && <section className="rav2-advanced-details"><header><div><ShieldCheck /><span><b>详细信息</b><small>运行配置、需求基线、正式产物与版本差异仅用于追溯和排障，不影响当前主流程。</small></span></div><nav>{detailTabs.map(tab => <button className={detailView === tab.key ? 'active' : ''} key={tab.key} onClick={() => setDetailView(tab.key)}>{tab.label}</button>)}</nav></header><div>{detailView === 'baseline' && <Baseline result={result} onEvidence={openEvidence} />}{detailView === 'artifacts' && <Artifacts result={result} release={release} runId={selectedRun?.id} />}{detailView === 'diff' && <Diff versions={versionHistory} value={diffVersionIds} onChange={setDiffVersionIds} loading={diffLoading} removed={removedLines} added={addedLines} />}</div></section>}
        </div>
        {view === 'conversation' && <footer className="rav2-session-boundary"><ShieldCheck /><span><b>连续 Planning Session</b><small>Requirement、Human Clarification、TestCase 与 Coverage 共用同一父会话；正式事实始终从 Version / Snapshot / Workspace 重新建立。</small></span></footer>}
      </main>

      <aside className="rav2-status-panel">
        <header><span><b>当前任务 / 正式产物</b><small>{selectedRun?.id ? `Run ${selectedRun.id.replace('analysis_run_', '').slice(0, 10)}` : '新建对话（未创建 Run）'}</small></span><Badge tone={selectedRun?.status === 'succeeded' ? 'green' : selectedRun?.status === 'running' ? 'purple' : selectedRun?.status === 'failed' ? 'red' : 'gray'}>{selectedRun ? runLabel(selectedRun) : '新建对话'}</Badge></header>
        <div className="rav2-status-scroll">
          <section className="rav2-status-card"><header><i>①</i><b>当前业务阶段</b></header><div className="rav2-stage-list">{stages.map(stage => <article className={stage.state} key={stage.label}><span /><b>{stage.label}</b><small>{stage.detail}</small></article>)}</div></section>
          <section className="rav2-status-card"><header><i>②</i><b>正式产物</b></header><div className="rav2-formal-list"><button onClick={() => openDetails('artifacts')} disabled={!result}><span><b>Requirement Release</b><small>{release?.status === 'published' ? `已由服务端发布 · ${formatTime(release.publishedAt ?? release.createdAt)}` : '等待需求分析和必要澄清完成'}</small></span><em className={release?.status === 'published' ? 'published' : 'empty'}>{release?.status === 'published' ? '已发布' : '—'}</em></button><button onClick={() => setView('cases')} disabled={!linkedTestDesign}><span><b>测试用例</b><small>{linkedTestDesign ? '查看本次测试设计运行与候选用例' : automaticTransition?.status === 'running' || automaticTransition?.status === 'pending' ? '正在创建测试设计运行' : '等待 Requirement Release'}</small></span><em>{linkedTestDesign ? '可查看' : '—'}</em></button><button onClick={() => setView('cases')} disabled={!linkedTestDesign}><span><b>Execution Handoff</b><small>由正式测试设计发布后生成</small></span><em>—</em></button></div></section>
          <details className="rav2-status-card rav2-technical-status"><summary><Activity /><span><b>运行记录</b><small>Turn、工具调用、事件与异常</small></span></summary><div className="rav2-activity-summary"><div className="rav2-activity-state"><span className={selectedRun?.status ?? 'idle'}><Activity /></span><div><b>{selectedRun ? runLabel(selectedRun) : '等待启动'}</b><small>{latestActivity ? `${agentEventLabels[latestActivity.type] ?? latestActivity.type} · #${latestActivity.sequence}` : '尚无 Agent Activity'}</small></div></div><div className="rav2-activity-metrics"><span><small>Turn</small><b>{activityExecution?.turns ?? 0}</b></span><span><small>工具</small><b>{activityExecution?.toolCalls ?? 0}</b></span><span><small>事件</small><b>{activityEvents.length}</b></span><span><small>异常</small><b>{activityExecution?.toolErrors ?? 0}</b></span></div></div></details>
        </div>
        <footer className="rav2-status-action">
          {!selectedRun ? <button className="primary" onClick={startAnalysis} disabled={!canRun}><Play />{starting ? '启动中…' : '开始分析'}</button> : selectedRun.status === 'running' ? <button className="danger" onClick={cancelAnalysis}><XCircle />取消当前运行</button> : blockingClarifications.length ? <button className="primary" onClick={() => setView('clarifications')}><Quote />回答 {blockingClarifications.length} 个待确认问题</button> : ['failed', 'cancelled'].includes(selectedRun.status) ? <button className="primary" onClick={retryAnalysis} disabled={!canRun}><RefreshCw />重新分析</button> : automaticTransition?.status === 'failed' ? <button className="primary" onClick={() => void retryAutomaticTransition()} disabled={releaseBusy}><RefreshCw />重试自动测试设计</button> : linkedTestDesign ? <button className="primary" onClick={() => setView('cases')}><Play />查看测试设计运行</button> : testDesignReady ? <button className="primary" onClick={() => setView('cases')}><Play />新建测试设计</button> : <button className="primary" disabled><AlertTriangle />本次需求分析尚未发布</button>}
        </footer>
      </aside>
    </div>

    {sourceEvidence && <div className="rav2-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) setSourceEvidence(null) }}><section className="rav2-source-modal"><header><span><ShieldCheck /><b>固定原文证据</b></span><button onClick={() => setSourceEvidence(null)}><XCircle /></button></header><div className="rav2-evidence"><b>{sourceEvidence.clientEvidenceId} · {sourceEvidence.locator.heading}</b><p>“{sourceEvidence.quote}”</p></div><div className="rav2-source-body">{sourceLoading ? <LoaderCircle className="rotating" /> : <MarkdownDocument source={sourceContent} format="markdown" />}</div></section></div>}
  </section>
}

function Clarifications({ items, answers, actions, busy, onAnswerChange, onActionChange, onSubmit }: { items: PlanningClarification[]; answers: Record<string, string>; actions: Record<string, ClarificationAction>; busy: boolean; onAnswerChange: (id: string, value: string) => void; onActionChange: (id: string, action: ClarificationAction) => void; onSubmit: () => void }) {
  const pending = items.filter(item => item.status === 'pending')
  if (!items.length) return <div className="rav2-empty"><CheckCircle2 /><h2>没有需要人工确认的业务事实</h2><p>Service 将发布 Requirement Release 并自动进入测试设计。</p></div>
  return <div className="rav2-findings">
    <header><div><Quote /><span><h2>待确认问题</h2><p>PlanningAgent 会一次性列出当前全部阻断问题。请逐项选择提供业务事实或人工处置，完成整批后统一提交到同一个 Planning Session。</p></span></div><Badge tone={pending.length ? 'orange' : 'green'}>{pending.length} 个待确认</Badge></header>
    {pending.length ? <section className="rav2-clarification-batch-note"><CheckCircle2 /><span><b>本批问题需一次性确认</b><small>“提供业务事实”会进入正式需求理解；“人工处置”仅保存不适用或接受当前缺口的理由，不会被当成业务规则。</small></span></section> : null}
    {items.map(item => {
      const action = actions[item.id]
      return <article className="rav2-finding" key={item.id}>
        <header><div><Badge tone="red">阻断测试设计</Badge><span><small>{item.category} · {item.id}</small><h3>Agent：{item.question}</h3></span></div><Badge tone={item.status === 'answered' ? 'green' : item.status === 'dismissed' ? 'gray' : 'orange'}>{item.status === 'answered' ? '已回答' : item.status === 'dismissed' ? '已处置' : '待回答'}</Badge></header>
        <p>{item.reason}</p>
        <div className="rav2-refs">{item.requirementPointRefs.map(reference => <span key={reference}>{reference}</span>)}</div>
        {item.status === 'pending' ? <>
          <div className="rav2-clarification-disposition"><b>处理方式</b><div><button type="button" className={action === 'answer' ? 'answer active' : 'answer'} aria-pressed={action === 'answer'} onClick={() => onActionChange(item.id, 'answer')} disabled={busy}><CheckCircle2 />提供业务事实</button><button type="button" className={action === 'dismiss' ? 'dismiss active' : 'dismiss'} aria-pressed={action === 'dismiss'} onClick={() => onActionChange(item.id, 'dismiss')} disabled={busy}><XCircle />不适用 / 接受缺口</button></div><small>{action === 'answer' ? '内容会作为正式业务事实，进入更新后的 Requirement Understanding。' : action === 'dismiss' ? '只记录人工处置理由；PlanningAgent 不得据此推导业务规则或预期结果。' : '必须先选择处理方式，不能用“跳过”等文字代替状态。'}</small></div>
          <textarea value={answers[item.id] ?? ''} onChange={event => onAnswerChange(item.id, event.target.value)} rows={4} disabled={busy || !action} placeholder={action === 'answer' ? '请输入明确的业务规则、边界、预期结果或环境事实…' : action === 'dismiss' ? '请说明为什么该问题不适用于当前需求，或为什么接受该需求缺口…' : '请先选择处理方式…'} />
          <small className="rav2-clarification-answer-hint">请填写后继续处理本批其余问题。</small>
        </> : <dl><div><dt>{item.status === 'dismissed' ? '处置理由' : 'Human Answer'}</dt><dd>{item.answer}</dd></div><div><dt>来源</dt><dd>{item.answeredBy} · {item.answeredAt ? formatTime(item.answeredAt) : '—'}</dd></div></dl>}
      </article>
    })}
    {pending.length ? <footer className="rav2-clarification-batch-action"><span>本批共 {pending.length} 个阻断问题，事实与处置状态由服务端分别保存。</span><button className="accept" onClick={onSubmit} disabled={busy}>{busy ? <LoaderCircle className="rotating" /> : <CheckCircle2 />}{busy ? '正在保存并继续…' : `确认全部 ${pending.length} 项并继续`}</button></footer> : null}
  </div>
}

function Baseline({ result, onEvidence }: { result?: RequirementAnalysisResponse['result']; onEvidence: (evidence: AnalysisEvidence) => void }) {
  if (!result) return <div className="rav2-empty"><GitBranch /><h2>暂无需求基线</h2></div>
  const evidence = new Map(result.evidence.map(item => [item.clientEvidenceId, item]))
  return <div className="rav2-baseline"><header><div><GitBranch /><span><h2>需求基线</h2><p>分析期需求点及其固定原文证据；正式下游输入以 Requirement Release 为准。</p></span></div><Badge tone="green">{result.requirementPoints.length}</Badge></header>{result.requirementPoints.map(point => { const linked = point.evidenceRefs.map(id => evidence.get(id)).filter((item): item is AnalysisEvidence => Boolean(item)); return <article key={point.clientRequirementPointId}><header><span className="rav2-rp">{point.clientRequirementPointId}</span><div><h3>{point.title}</h3><p>{point.description}</p></div><Badge tone={linked.length ? 'green':'orange'}>{linked.length} Evidence</Badge></header><footer>{linked.map(item => <button key={item.clientEvidenceId} onClick={() => onEvidence(item)}><Quote />{item.clientEvidenceId} · {item.locator.heading}</button>)}</footer></article>})}</div>
}

function Artifacts({ result, release, runId }: { result?: RequirementAnalysisResponse['result']; release?: RequirementReleasePackage; runId?: string }) {
  if (!result) return <div className="rav2-empty"><FileText /><h2>暂无需求分析候选</h2></div>
  const machineNames = new Set(['requirements.json', 'test-focus.json', 'traceability.json', 'manifest.json'])
  const refined = release?.artifacts.find(item => item.fileName === 'refined-requirements.md')?.content
  return <div className="rav2-artifacts"><header><div><FileText /><span><h2>Requirement Release</h2><p>Service 在需求分析和必要澄清完成后原子发布，测试设计只读取该正式版本。</p></span></div><Badge tone={release?.status === 'published' ? 'green' : 'gray'}>{release?.status === 'published' ? '已发布' : '等待发布'}</Badge></header>{release ? <div className="rav2-snapshot-facts"><span><small>Release</small><b>{release.id}</b></span><span><small>发布时间</small><b>{formatTime(release.publishedAt ?? release.createdAt)}</b></span><span><small>固定 Run</small><b>{release.verificationRunId}</b></span><span><small>内容 Hash</small><b>{release.contentSha256}</b></span></div> : <div className="rav2-warning"><Clock3 />当前尚未发布 Requirement Release；系统会在 blocking clarification 全部解决后继续。</div>}{refined&&<details><summary>可读需求基线</summary><div className="rav2-markdown"><MarkdownDocument source={refined} format="markdown" /></div></details>}{release&&<details><summary>服务端生成的下游产物</summary><div className="rav2-artifact-list">{release.artifacts.map(artifact=><article key={artifact.fileName}><b>{artifact.fileName}</b><small>{artifact.mediaType} · {artifact.contentSha256}</small>{release.status==='published'&&runId?<a className="btn ghost" href={requirementReleaseArtifactUrl(runId,artifact.fileName)} download={artifact.fileName.split('/').at(-1)}><Download />下载</a>:null}</article>)}</div><div className="rav2-artifact-list">{release.artifacts.filter(item=>machineNames.has(item.fileName)).map(item=><article key={item.fileName}><b>{item.fileName}</b><small>{item.fileName==='requirements.json'?'测试设计的正式需求输入':'服务端生成并按 Schema 校验'} · {item.contentSha256}</small></article>)}</div></details>}<details><summary>分析期候选（非正式产物）</summary><div className="rav2-artifact-list">{result.artifacts.map(item=><article key={item.fileName}><b>{item.fileName}</b><small>{item.contentSha256}</small></article>)}</div></details></div>
}

function Diff({ versions,value,onChange,loading,removed,added }:{ versions:NonNullable<KnowledgeDocument['versions']>; value:[string,string]; onChange:(v:[string,string])=>void; loading:boolean; removed:string[]; added:string[] }) {
  if (versions.length<2) return <div className="rav2-empty"><FileDiff /><h2>暂无可比较版本</h2><p>需求文档形成新 AssetVersion 后可在此比较版本差异。</p></div>
  return <div className="rav2-diff"><header><div><span>基准版本</span><select value={value[0]} onChange={e=>onChange([e.target.value,value[1]])}>{versions.map(v=><option value={v.id} key={v.id}>V{v.number}</option>)}</select></div><div><span>目标版本</span><select value={value[1]} onChange={e=>onChange([value[0],e.target.value])}>{versions.map(v=><option value={v.id} key={v.id}>V{v.number}</option>)}</select></div></header>{loading?<div className="rav2-empty"><LoaderCircle className="rotating" /></div>:<div className="rav2-diff-grid"><section><h3>删除 <span>{removed.length}</span></h3>{removed.map((line,i)=><p className="removed" key={`${i}-${line}`}>− {line}</p>)}</section><section><h3>新增 <span>{added.length}</span></h3>{added.map((line,i)=><p className="added" key={`${i}-${line}`}>+ {line}</p>)}</section></div>}</div>
}

function AgentConversation({ run, projectVersionId, linkedTestDesign, onReviewed, notify }: { run?: RunRecord; projectVersionId: string; linkedTestDesign?: { designId: string; runId: string }; onReviewed: (run: RequirementAnalysisRun) => void; notify: Notify }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [reviewing, setReviewing] = useState(false)
  const [testDesignRun, setTestDesignRun] = useState<TestDesignWorkflowRun>()
  const [testDesignLoadError, setTestDesignLoadError] = useState('')
  const executionGroups = planningExecutionGroups(run)
  const clarificationBatches = humanClarificationBatches(run)
  const timeline = [
    ...executionGroups.map(group => ({ kind: 'execution' as const, id: group.id, occurredAt: group.startedAt ?? group.execution.events[0]?.occurredAt ?? '', group })),
    ...clarificationBatches.map(batch => ({ kind: 'clarification' as const, id: batch.id, occurredAt: batch.answeredAt, batch })),
  ].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.kind.localeCompare(right.kind))
  const latestExecution = executionGroups.at(-1)?.execution
  const eventCount = executionGroups.reduce((total, group) => total + group.execution.events.length, 0)
  const turnCount = executionGroups.reduce((total, group) => total + group.execution.turns, 0)
  const toolCallCount = executionGroups.reduce((total, group) => total + group.execution.toolCalls, 0)
  const toolErrorCount = executionGroups.reduce((total, group) => total + (group.execution.toolErrors ?? 0), 0)
  const latestClarificationAt = clarificationBatches.at(-1)?.answeredAt
  const testDesignEventCount = testDesignRun?.nodeRuns.reduce((total, node) => total + (node.execution?.events.length ?? 0), 0) ?? 0
  useEffect(() => {
    if (!linkedTestDesign) { setTestDesignRun(undefined); setTestDesignLoadError(''); return }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const detail = await loadTestDesignRun(projectVersionId, linkedTestDesign.designId, linkedTestDesign.runId)
        if (cancelled) return
        setTestDesignRun(detail)
        setTestDesignLoadError('')
        if (!['succeeded', 'failed', 'cancelled'].includes(detail.status)) timer = setTimeout(() => void poll(), 1_000)
      } catch (error) {
        if (cancelled) return
        const message = error instanceof Error ? error.message : '测试设计运行读取失败'
        const transientNetworkFailure = error instanceof TypeError || /failed to fetch|networkerror|network request failed/iu.test(message)
        setTestDesignLoadError(transientNetworkFailure ? '测试设计服务暂时不可用，正在自动重试。' : message)
        if (transientNetworkFailure) timer = setTimeout(() => void poll(), 1_500)
      }
    }
    void poll()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [projectVersionId, linkedTestDesign?.designId, linkedTestDesign?.runId])
  useEffect(() => { const root = scrollRef.current; if (root) root.scrollTo({ top: root.scrollHeight, behavior: 'smooth' }) }, [eventCount, latestClarificationAt, testDesignEventCount, testDesignRun?.status])
  const review = async () => {
    if (!run || reviewing) return
    setReviewing(true)
    try {
      await runRequirementReviewer(run.id)
      onReviewed(await loadRequirementAnalysisRun(run.id))
      notify('RequirementReviewer 已完成；候选仅注入 Planning Parent Session。')
    } catch (error) { notify(error instanceof Error ? error.message : 'RequirementReviewer 执行失败', 'error') }
    finally { setReviewing(false) }
  }

  return <div className="rav2-conversation">
    <div className="rav2-conversation-scroll" ref={scrollRef}>
      {!run ? <div className="rav2-agent-empty"><span className="rav2-agent-empty-icon"><Bot /></span><div><b>等待启动 Pi Agent</b><p>开始需求分析后，这里会同步展示任务输入、Agent 消息、工具调用与运行状态。</p></div><ul className="rav2-agent-empty-preview"><li><FileText />任务输入与分析进度</li><li><Wrench />工具调用与执行结果</li><li><Sparkles />关键状态与最终产物</li></ul></div> : <>
        <article className="rav2-agent-task"><span><FileText /></span><div><b>需求理解与测试关注点分析</b><p>PlanningAgent 正在基于本次重点输入和冻结 Workspace 建立需求理解；若存在会影响测试正确性的缺失事实，会在本阶段统一提出待确认问题。</p><small>{run.id} · 已提交 {run.snapshot?.currentInputRefs.length ?? run.assetVersionIds.length} 个重点输入 · Workspace Snapshot {run.snapshot?.workspaceSnapshot.files.length ?? '—'} 个文件</small></div></article>
        <div className="rav2-agent-metrics"><span>{turnCount} Turn</span><span>{toolCallCount} 次工具</span><span>{eventCount} 条事件</span>{toolErrorCount ? <span className="failed">{toolErrorCount} 次异常</span> : null}</div>
        <details className="rav2-runtime-details"><summary><ShieldCheck />运行上下文与只读 Reviewer</summary><PlanningContextMetrics context={latestExecution?.context} /><button className="planning-reviewer-button" disabled={reviewing || run.status === 'running'} onClick={() => void review()}><ShieldCheck />{reviewing ? 'RequirementReviewer 审阅中…' : '运行只读 RequirementReviewer'}</button><PlanningSubAgentRuns runs={run.planningSubAgentRuns} /></details>
        {timeline.map(item => {
          if (item.kind === 'clarification') return <HumanClarificationEntry batch={item.batch} key={`clarification:${item.id}`} />
          const group = item.group
          const events = group.execution.events
          const toolStarts = new Map(events.filter(event => event.type === 'tool_execution_start' && event.toolCallId).map(event => [event.toolCallId!, event]))
          const completedCalls = new Set(events.filter(event => event.type === 'tool_execution_end' && event.toolCallId).map(event => event.toolCallId))
          const visibleEvents = events.filter(event => {
            if (event.role === 'user' && (event.type === 'message_start' || event.type === 'message_end')) return false
            return event.type !== 'tool_execution_start' || !completedCalls.has(event.toolCallId)
          })
          return <div key={`execution:${item.id}`} className="rav2-execution-attempt"><article className={`rav2-run-control ${group.status === 'failed' || group.status === 'cancelled' ? 'failed' : ''}`}><Activity /><span><b>{group.label}</b><small>{group.status === 'running' ? '执行中' : group.status === 'succeeded' ? '已完成' : group.status === 'failed' ? '失败，已保留运行记录' : group.status === 'cancelled' ? '已取消，已保留运行记录' : '已保存运行记录'} · {events.length} 条事件</small></span></article>{visibleEvents.map(event => <AgentRunEvent event={event} start={event.type === 'tool_execution_end' ? toolStarts.get(event.toolCallId ?? '') : undefined} key={`${group.id}:${event.sequence}`} />)}</div>
          })}
          {linkedTestDesign && <TestDesignConversationEntry linkage={linkedTestDesign} run={testDesignRun} error={testDesignLoadError} />}
          {!eventCount && !linkedTestDesign && <div className="rav2-agent-waiting"><LoaderCircle className={run.status === 'running' ? 'rotating' : ''} /><span><b>{run.status === 'running' ? '等待首个 Agent 事件' : '没有可展示的运行记录'}</b><small>{run.status === 'running' ? '消息和工具调用写入服务端后会自动同步。' : '旧运行可能只保留了结果摘要。'}</small></span></div>}
      </>}
    </div>
  </div>
}

function HumanClarificationEntry({ batch }: { batch: HumanClarificationBatch }) {
  return <article className="rav2-run-message user rav2-human-clarification"><header><span><Quote />Human Clarification 已提交</span><small>{batch.answeredBy} · {eventTime(batch.answeredAt)}</small></header><div>{batch.items.map(item => <section key={item.id}><small>{item.category} · {item.id}</small><b>{item.question}</b><p>{item.answer}</p><em>{item.status === 'dismissed' ? '已人工处置；理由不作为业务事实' : '已作为正式业务事实提交'}</em></section>)}</div><footer>本批 {batch.items.length} 项 · 已写回当前 Run 与 Planning Session</footer></article>
}

function AgentRunEvent({ event, start }: { event: AgentExecutionEvent; start?: AgentExecutionEvent }) {
  if (event.type === 'message_end') {
    const content = event.content?.trim() ?? ''
    return <article className={`rav2-run-message ${event.role ?? 'assistant'}`}><header><span>{event.role === 'user' ? <FileText /> : <Bot />}{event.role === 'user' ? '任务输入' : event.model ?? 'Agent'}</span><small>#{event.sequence} · Turn {event.turn ?? 0} · {eventTime(event.occurredAt)}</small></header>{content && (content.length > 700 ? <details><summary>{content.slice(0, 180)}…</summary><pre>{content}</pre></details> : <p>{content}</p>)}{event.toolCalls?.length ? <div className="rav2-run-tool-requests">{event.toolCalls.map(call => <span key={call.id}><Wrench />请求 {call.name}</span>)}</div> : null}{event.usage && <footer>Token：输入 {event.usage.input} · 输出 {event.usage.output} · 缓存读取 {event.usage.cacheRead} · 总计 {event.usage.totalTokens} · {event.stopReason ?? '未知停止原因'}</footer>}</article>
  }
  if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
    const tool = event.toolId ?? start?.toolId ?? '未知工具'; const completed = event.type === 'tool_execution_end'
    return <article className={`rav2-run-tool ${event.isError ? 'failed' : ''}`}><header><span><Wrench /><b>{tool}</b></span><Badge tone={!completed ? 'orange' : event.isError ? 'red' : 'green'}>{!completed ? '执行中' : event.isError ? '失败' : '完成'}</Badge></header><small>#{start?.sequence ? `${start.sequence} → ` : ''}{event.sequence} · Turn {event.turn ?? start?.turn ?? 0} · {eventTime(event.occurredAt)}</small><details><summary>调用参数</summary><pre>{formatTraceValue(start?.toolArguments ?? event.toolArguments) || '该记录未保存参数'}</pre></details>{completed && <details><summary>工具返回</summary><pre>{formatTraceValue(event.toolResult) || '该记录未保存返回内容'}</pre></details>}<footer>{event.toolCallId ?? '无 Tool Call ID'}</footer></article>
  }
  return <article className={`rav2-run-control ${event.isError ? 'failed' : ''}`}><Sparkles /><span><b>{agentEventLabels[event.type] ?? event.type}</b><small>#{event.sequence} · Turn {event.turn ?? 0} · {eventTime(event.occurredAt)}{skillReadSummary(event)}{event.stopReason ? ` · ${event.stopReason}` : ''}</small></span></article>
}

const testDesignStageLabels: Record<TestDesignNodeRun['nodeKey'], string> = {
  test_case_design: '测试用例设计',
  coverage_audit: 'Coverage Audit',
  test_design_repair: '测试设计修复',
}

function testDesignTone(status?: string) {
  return status === 'failed' || status === 'cancelled' ? 'red' : status === 'succeeded' ? 'green' : status === 'running' ? 'blue' : 'gray'
}

function TestDesignConversationEntry({ linkage, run, error }: { linkage: { designId: string; runId: string }; run?: TestDesignWorkflowRun; error: string }) {
  return <section className="rav2-test-design-conversation">
    <article className="rav2-agent-task"><span><TestTube2 /></span><div><b>自动测试设计</b><p>Requirement Release 已冻结；PlanningAgent 继续在同一 Planning Session 生成测试用例并校验覆盖。</p><small>{linkage.runId} · TestDesign {linkage.designId}</small></div><Badge tone={testDesignTone(run?.status)}>{run ? run.status === 'succeeded' ? '已完成' : run.status === 'failed' ? '失败' : run.status === 'cancelled' ? '已取消' : '执行中' : '正在读取'}</Badge></article>
    {error ? <article className="rav2-run-control failed"><AlertTriangle /><span><b>测试设计运行读取失败</b><small>{error}</small></span></article> : !run ? <div className="rav2-agent-waiting"><LoaderCircle className="rotating" /><span><b>正在读取测试设计运行</b><small>测试用例和覆盖审计轨迹将同步到当前协作会话。</small></span></div> : <>
      <div className="rav2-agent-metrics"><span>{run.progress}% 进度</span><span>{run.nodeRuns.filter(node => node.status === 'succeeded').length}/{run.nodeRuns.length} 阶段完成</span>{run.error ? <span className="failed">{run.errorCode ?? 'TEST_DESIGN_RUN_FAILED'}</span> : null}</div>
      {run.error && <article className="rav2-run-control failed"><AlertTriangle /><span><b>测试设计已停止</b><small>{run.error}</small></span></article>}
      {run.nodeRuns.map(node => <TestDesignNodeConversationEntry key={node.id} node={node} />)}
    </>}
  </section>
}

function TestDesignNodeConversationEntry({ node }: { node: TestDesignNodeRun }) {
  const events = node.execution?.events ?? []
  const toolStarts = new Map(events.filter(event => event.type === 'tool_execution_start' && event.toolCallId).map(event => [event.toolCallId!, event]))
  const completedCalls = new Set(events.filter(event => event.type === 'tool_execution_end' && event.toolCallId).map(event => event.toolCallId))
  const visibleEvents = events.filter(event => !(event.type === 'tool_execution_start' && completedCalls.has(event.toolCallId)))
  return <div className="rav2-execution-attempt"><article className={`rav2-run-control ${node.status === 'failed' || node.status === 'cancelled' ? 'failed' : ''}`}><Activity /><span><b>{testDesignStageLabels[node.nodeKey]} · 第 {node.attempt} 次</b><small>{node.status === 'succeeded' ? '已完成' : node.status === 'failed' ? '失败，已保留运行记录' : node.status === 'running' ? '执行中' : '等待上游阶段'} · {events.length} 条事件</small></span><Badge tone={testDesignTone(node.status)}>{node.status}</Badge></article>{node.error && <article className="rav2-run-control failed"><AlertTriangle /><span><b>{node.errorCode ?? 'TEST_DESIGN_STAGE_FAILED'}</b><small>{node.error}</small></span></article>}{visibleEvents.map(event => <AgentRunEvent event={event} start={event.type === 'tool_execution_end' ? toolStarts.get(event.toolCallId ?? '') : undefined} key={`${node.id}:${event.sequence}`} />)}</div>
}
