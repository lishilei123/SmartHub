import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, AlertTriangle, BookOpen, Bot, CheckCircle2, Clock3, Download, FileDiff, FileText,
  FolderOpen, GitBranch, LoaderCircle, Play, Quote, RefreshCw, ShieldCheck, Sparkles, TestTube2, Trash2, Wrench, XCircle,
} from 'lucide-react'
import type { KnowledgeDocument } from './prototype-data'
import { loadAssetVersion, waitForTaskResults } from './knowledge-api'
import { MarkdownDocument } from './MarkdownDocument'
import { PlanningContextMetrics, PlanningSubAgentRuns } from './PlanningObservability'
import { runRequirementReviewer } from './planning-api'
import {
  cancelRequirementAnalysisRun,
  actOnPlanningClarifications,
  createFindingAction,
  generateRequirementRepairDraft,
  approveRequirementRepairDraft,
  applyRequirementRepairDraft,
  finalizeRequirementRepairDraft,
  downloadRequirementAnalysisReport,
  loadFindingActions,
  loadRequirementAnalysisRun,
  loadRequirementAnalysisRuns,
  retryRequirementAnalysisRun,
  retryAutomaticTestDesign,
  requirementReleaseArtifactUrl,
  startRequirementAnalysis,
  verifyRequirementRepairDraft,
  type AgentExecutionEvent,
  type AgentExecutionRecord,
  type FindingActionType,
  type RequirementAnalysisResponse,
  type RequirementRepairDraft,
  type RequirementReleasePackage,
  type AnalysisEvidence,
  type AnalysisFinding,
  type AnalysisFindingType,
  type AnalysisSeverity,
  type RequirementAnalysisRun,
  type PlanningClarification,
} from './requirement-analysis-api'
import { requirementAnalysisInputTypeForDocument, requirementWorkspaceDirectory } from './version-document-path'
import { loadAgentConfiguration, type AgentConfigurationState } from './agent-configuration-api'
import type { ProjectVersion } from './project-version-api'
import './requirement-analysis-v2.css'
import './requirement-analysis-review-flow.css'

const EmbeddedTestDesignPage = lazy(() => import('./test-design/TestDesignPage').then(module => ({ default: module.TestDesignPage })))

type Notify = (message: string, tone?: 'success' | 'error' | 'warning') => void
type ViewKey = 'conversation' | 'clarifications' | 'cases' | 'details'
type DetailViewKey = 'baseline' | 'findings' | 'artifacts' | 'diff'
type FindingState = 'open' | 'confirmed' | 'dismissed' | 'resolved' | 'needs_follow_up'
type ClarificationAction = 'answer' | 'dismiss'
type RunRecord = RequirementAnalysisRun & { content?: string }
type RequirementUnderstandingSnapshot = NonNullable<RequirementAnalysisRun['workflow']>['understandingSnapshot']
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

const findingTypeLabels: Record<AnalysisFindingType, string> = {
  missing_requirement: '需求缺口', ambiguity: '需求歧义', conflict: '逻辑冲突', boundary_gap: '边界条件',
  state_gap: '状态缺口', exception_gap: '异常场景', security_risk: '安全风险', testability_gap: '可测试性',
  dependency_risk: '依赖风险', other: '其他问题',
}
const severityLabels: Record<AnalysisSeverity, string> = { blocker: '阻断', high: '高', medium: '中', low: '低' }
const findingStateLabels: Record<FindingState, string> = { open: '待人工审核', confirmed: '已采纳', dismissed: '不采纳', resolved: '已解决', needs_follow_up: '暂缓 / 待复验' }
const viewTabs: Array<{ key: ViewKey; label: string; icon: typeof Sparkles }> = [
  { key: 'conversation', label: 'Agent 协作', icon: Bot },
  { key: 'clarifications', label: '待确认问题', icon: Quote },
  { key: 'cases', label: '测试用例', icon: TestTube2 },
  { key: 'details', label: '详细信息', icon: ShieldCheck },
]
const detailTabs: Array<{ key: DetailViewKey; label: string }> = [
  { key: 'baseline', label: '需求理解结构' },
  { key: 'findings', label: '分析观察项' },
  { key: 'artifacts', label: 'Snapshot / 产物' },
  { key: 'diff', label: '版本差异' },
]

function Badge({ children, tone = 'gray' }: { children: React.ReactNode; tone?: string }) { return <span className={`rav2-badge ${tone}`}>{children}</span> }
function formatTime(value: string) { return new Date(value).toLocaleString('zh-CN', { hour12: false }) }
function severityTone(value: AnalysisSeverity) { return value === 'blocker' ? 'red' : value === 'high' ? 'orange' : value === 'medium' ? 'gold' : 'blue' }
function assessmentLabel(value?: string) { return value === 'blocked' ? '存在阻断问题' : value === 'needs_revision' ? '建议修改后确认' : value === 'pass_with_notes' ? '附带关注项通过' : value === 'pass' ? '可以进入下一阶段' : '等待分析' }
function runLabel(run?: RunRecord) {
  if (run?.status === 'running') return '分析中'
  if (run?.status === 'waiting_clarification') return run.step === 'continuing_after_clarification' ? '业务事实已确认' : '等待业务确认'
  if (run?.status === 'succeeded') return run.workflow?.understandingSnapshot ? '需求理解已冻结' : '正在冻结需求理解'
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
function evidenceForFinding(finding: AnalysisFinding, result?: RequirementAnalysisResponse['result']) {
  if (!result) return [] as AnalysisEvidence[]
  const points = new Map(result.requirementPoints.map(item => [item.clientRequirementPointId, item]))
  const evidence = new Map(result.evidence.map(item => [item.clientEvidenceId, item]))
  const refs = new Set(finding.requirementPointRefs.flatMap(reference => points.get(reference)?.evidenceRefs ?? []))
  return [...refs].map(reference => evidence.get(reference)).filter((item): item is AnalysisEvidence => Boolean(item))
}

function fixedAssets(run: RunRecord) {
  return run.snapshot?.assets ?? run.documents ?? []
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

function repairDraftForFinding(drafts: RequirementRepairDraft[], findingId: string) {
  return [...drafts].reverse().find(draft => draft.candidate?.patches.some(patch => patch.findingRefs.includes(findingId)))
}

function assetVersionLabel(versionId: string, documents: KnowledgeDocument[]) {
  const version = documents.flatMap(document => document.versions ?? []).find(candidate => candidate.id === versionId)
  return version ? `V${version.number}` : versionId
}

export function RequirementAnalysisPageV2(props: Props) {
  const { projectVersion, documents, apiState, refreshKnowledge, notify, addAudit, onManageVersions, onOpenKnowledge, onOpenActivity, onOpenInputDocument, onDeleteInputDocument, canDeleteInputDocument = false } = props
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
  const [findingStates, setFindingStates] = useState<Record<string, FindingState>>({})
  const [findingVersions, setFindingVersions] = useState<Record<string, number>>({})
  const [findingTypeFilter, setFindingTypeFilter] = useState<'all' | AnalysisFindingType>('all')
  const [severityFilter, setSeverityFilter] = useState<'all' | AnalysisSeverity>('all')
  const [findingStateFilter, setFindingStateFilter] = useState<'all' | FindingState>('all')
  const [selectedDocumentId, setSelectedDocumentId] = useState('')
  const [sourceEvidence, setSourceEvidence] = useState<AnalysisEvidence | null>(null)
  const [sourceContent, setSourceContent] = useState('')
  const [sourceLoading, setSourceLoading] = useState(false)
  const [fixFinding, setFixFinding] = useState<AnalysisFinding | null>(null)
  const [fixDraft, setFixDraft] = useState<RequirementRepairDraft | null>(null)
  const [fixBusy, setFixBusy] = useState(false)
  const [verificationBusyDraftId, setVerificationBusyDraftId] = useState('')
  const [releaseBusy, setReleaseBusy] = useState(false)
  const [clarificationAnswers, setClarificationAnswers] = useState<Record<string, string>>({})
  const [clarificationActions, setClarificationActions] = useState<Record<string, ClarificationAction>>({})
  const [clarificationBusy, setClarificationBusy] = useState(false)
  const [diffVersionIds, setDiffVersionIds] = useState<[string, string]>(['', ''])
  const [diffContents, setDiffContents] = useState<Record<string, string>>({})
  const [diffLoading, setDiffLoading] = useState(false)
  const openDetails = (next: DetailViewKey) => { setDetailView(next); setView('details') }
  const requestedRepairDiff = useRef<{ assetId: string; versionIds: [string, string] } | null>(null)

  const projectVersionName = projectVersion?.name ?? ''
  const workspaceDirectoryPath = projectVersionName ? requirementWorkspaceDirectory(projectVersionName) : ''
  const analysisInputDocuments = useMemo(() => documents.filter(document => document.status === 'ready'
    && Boolean(document.assetVersionId)
    && Boolean(projectVersionName)
    && Boolean(requirementAnalysisInputTypeForDocument(projectVersionName, document.logicalPath ?? '', document.assetType))), [documents, projectVersionName])
  const requirementDocuments = useMemo(() => analysisInputDocuments.filter(document => requirementAnalysisInputTypeForDocument(projectVersionName, document.logicalPath ?? '', document.assetType)?.value === 'requirement'), [analysisInputDocuments, projectVersionName])
  const selectedRun = runs.find(run => run.id === selectedRunId)
  const result = selectedRun?.response?.result
  const workspaceSnapshot = selectedRun?.snapshot?.workspaceSnapshot
  const currentInputRefs = selectedRun?.snapshot?.currentInputRefs ?? []
  const selectedDocument = analysisInputDocuments.find(item => item.id === selectedDocumentId) ?? analysisInputDocuments[0]
  const analysisAgentReady = Boolean(agentConfiguration?.agents.planning.activeVersion)
  const canRun = Boolean(projectVersion && projectVersion.status === 'open' && requirementDocuments.length && analysisAgentReady && apiState === 'ready' && !starting)

  const refreshRuns = async (selectLatest = false) => {
    if (!projectVersion) { setRuns([]); setSelectedRunId(''); return }
    setLoadingRuns(true)
    try {
      const page = await loadRequirementAnalysisRuns(projectVersion.id)
      setRuns(page.items)
      if (selectLatest || !page.items.some(item => item.id === selectedRunId)) setSelectedRunId(page.items[0]?.id ?? '')
    } catch (error) { notify(error instanceof Error ? error.message : '需求分析历史读取失败', 'error') }
    finally { setLoadingRuns(false) }
  }

  useEffect(() => { void refreshRuns(true) }, [projectVersion?.id])
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
    if (!selectedRun || selectedRun.status !== 'succeeded') return
    let cancelled = false
    loadFindingActions(selectedRun.id).then(actions => {
      if (cancelled) return
      setFindingStates(current => ({ ...current, ...Object.fromEntries(actions.findings.map(item => [`${selectedRun.id}:${item.findingId}`, item.state])) }))
      setFindingVersions(current => ({ ...current, ...Object.fromEntries(actions.findings.map(item => [`${selectedRun.id}:${item.findingId}`, item.version])) }))
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [selectedRun?.id, selectedRun?.status])
  useEffect(() => {
    const versions = (selectedDocument?.versions ?? []).filter(item => item.status === 'ready')
    const requested = requestedRepairDiff.current
    if (requested && requested.assetId === selectedDocument?.id) {
      requestedRepairDiff.current = null
      setDiffVersionIds(requested.versionIds)
      setDiffContents({})
      return
    }
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
    if (projectVersion.requirementReleaseBinding) {
      setView('cases')
      notify('当前 ProjectVersion 已绑定 Requirement Release；请创建新的测试设计，而不是重新发起需求分析。', 'warning')
      return
    }
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
      notify(`已在当前 Run 保存 ${answeredCount} 个业务事实、${dismissedCount} 个人工处置；PlanningAgent 正在继续分析。`)
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
  const updateFindingState = async (finding: AnalysisFinding, next: FindingState) => {
    if (!selectedRun || projectVersion?.status !== 'open') return
    const key = `${selectedRun.id}:${finding.clientFindingId}`; const current = findingStates[key] ?? 'open'; if (current === next) return
    const actionByState: Record<FindingState, FindingActionType> = { open: 'reopen', confirmed: 'confirm', dismissed: 'dismiss', resolved: 'resolve', needs_follow_up: 'request_follow_up' }
    const needsComment = next === 'dismissed' || next === 'needs_follow_up' || next === 'open'
    const comment = needsComment ? window.prompt(`请填写“${findingStateLabels[next]}”的处置说明：`)?.trim() : undefined
    if (needsComment && !comment) return
    try { const saved = await createFindingAction(selectedRun.id, finding.clientFindingId, { action: actionByState[next], comment, expectedVersion: findingVersions[key] ?? 0 }); setFindingStates(values => ({ ...values, [key]: saved.toState })); setFindingVersions(values => ({ ...values, [key]: saved.version })) }
    catch (error) { notify(error instanceof Error ? error.message : 'Finding 状态保存失败', 'error') }
  }

  const draftFindingFix = async (finding: AnalysisFinding) => {
    if (!selectedRun || selectedRun.status !== 'succeeded') { notify('请先完成需求分析。', 'warning'); return }
    const state = findingStates[`${selectedRun.id}:${finding.clientFindingId}`] ?? 'open'
    if (state !== 'confirmed') { notify('先将 Finding 人工确认，再进入受控修复 Stage。', 'warning'); return }
    setFixFinding(finding); setFixDraft(null); setFixBusy(true)
    try { setFixDraft(await generateRequirementRepairDraft(selectedRun.id, [finding.clientFindingId])) }
    catch (error) { notify(error instanceof Error ? error.message : 'AI 修复草稿生成失败', 'error') } finally { setFixBusy(false) }
  }

  const applyRepair = async (draft: RequirementRepairDraft, finding: AnalysisFinding) => {
    if (!selectedRun) return
    const applying = await applyRequirementRepairDraft(selectedRun.id, draft.id)
    setFixDraft(applying)
    const taskIds = applying.application?.items.flatMap(item => item.taskId ? [item.taskId] : []) ?? []
    if (taskIds.length) {
      const completed = await waitForTaskResults(taskIds)
      if (completed.failed.length || completed.cancelled.length || completed.pending.length) throw new Error('修复后的需求文档入库未完成')
    }
    const applied = await finalizeRequirementRepairDraft(selectedRun.id, draft.id)
    await refreshKnowledge()
    const [detail, actions] = await Promise.all([loadRequirementAnalysisRun(selectedRun.id), loadFindingActions(selectedRun.id)])
    setRuns(current => replaceRunDetail(current, detail))
    setFindingStates(current => ({ ...current, ...Object.fromEntries(actions.findings.map(item => [`${selectedRun.id}:${item.findingId}`, item.state])) }))
    setFindingVersions(current => ({ ...current, ...Object.fromEntries(actions.findings.map(item => [`${selectedRun.id}:${item.findingId}`, item.version])) }))
    addAudit(`采纳并应用 AI 修复方案 ${draft.id}：${finding.clientFindingId} → ${applied.application?.items.map(item => item.targetAssetVersionId).join('、')}`)
    setFixFinding(null)
    setFixDraft(null)
    openDetails('findings')
    notify('修复方案已应用并生成新 AssetVersion；当前停留在待复验状态。')
  }

  const approveRepair = async () => {
    if (!fixFinding || !fixDraft || !selectedRun || !projectVersion || projectVersion.status !== 'open') return
    setFixBusy(true)
    try {
      const approved = fixDraft.status === 'generated'
        ? await approveRequirementRepairDraft(selectedRun.id, fixDraft.id, `已人工采纳 ${fixFinding.clientFindingId} 的 AI 修复 Diff。`)
        : fixDraft
      setFixDraft(approved)
      await applyRepair(approved, fixFinding)
    } catch (error) { notify(error instanceof Error ? error.message : 'AI 修复方案应用失败', 'error') } finally { setFixBusy(false) }
  }

  const startVerification = async (draft: RequirementRepairDraft) => {
    if (!selectedRun || !projectVersion || projectVersion.status !== 'open' || draft.status !== 'applied') return
    setVerificationBusyDraftId(draft.id)
    try {
      const verification = await verifyRequirementRepairDraft(selectedRun.id, draft.id)
      setRuns(current => [verification.verificationRun, ...current.map(item => item.id === selectedRun.id && item.workflow ? { ...item, workflow: { ...item.workflow, repairDrafts: item.workflow.repairDrafts?.map(candidate => candidate.id === draft.id ? verification.repairDraft : candidate) } } : item).filter(item => item.id !== verification.verificationRun.id)])
      setSelectedRunId(verification.verificationRun.id)
      setView('conversation')
      addAudit(`人工启动 AI 复验：${draft.id} → ${verification.verificationRun.id}`)
      notify('AI 复验已启动，将对新 AssetVersion 执行完整需求分析。')
    } catch (error) { notify(error instanceof Error ? error.message : 'AI 复验启动失败', 'error') } finally { setVerificationBusyDraftId('') }
  }

  const openRepairDiff = (draft: RequirementRepairDraft) => {
    const item = draft.application?.items[0]
    if (!item) return
    const versionIds: [string, string] = [item.sourceAssetVersionId, item.targetAssetVersionId]
    if (selectedDocument?.id === item.assetId) {
      setDiffVersionIds(versionIds)
      setDiffContents({})
    } else {
      requestedRepairDiff.current = { assetId: item.assetId, versionIds }
      setSelectedDocumentId(item.assetId)
    }
    openDetails('diff')
  }

  const visibleFindings = (result?.findings ?? []).filter(finding => {
    const state = selectedRun ? findingStates[`${selectedRun.id}:${finding.clientFindingId}`] ?? 'open' : 'open'
    return (findingTypeFilter === 'all' || finding.type === findingTypeFilter) && (severityFilter === 'all' || finding.severity === severityFilter) && (findingStateFilter === 'all' || state === findingStateFilter)
  })
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
  const resumeClarifiedAnalysis = async () => {
    if (!selectedRun || clarificationBusy) return
    setClarificationBusy(true)
    try {
      const resumed = await actOnPlanningClarifications(selectedRun.id, { items: [] })
      setRuns(current => replaceRunDetail(current, resumed.run))
      setView('conversation')
      notify('已在当前 Run 恢复 PlanningAgent 分析。')
    } catch (error) { notify(error instanceof Error ? error.message : '当前需求分析恢复失败', 'error') }
    finally { setClarificationBusy(false) }
  }
  const versionHistory = (selectedDocument?.versions ?? []).filter(item => item.status === 'ready')
  const leftLines = (diffContents[diffVersionIds[0]] ?? '').split(/\r?\n/).filter(Boolean); const rightLines = (diffContents[diffVersionIds[1]] ?? '').split(/\r?\n/).filter(Boolean)
  const removedLines = leftLines.filter(line => !rightLines.includes(line)); const addedLines = rightLines.filter(line => !leftLines.includes(line))
  const enabledSkills = agentConfiguration?.agents.planning.activeVersion?.agentDefinition.enabledSkills ?? []
  const repairDrafts = selectedRun?.workflow?.repairDrafts ?? []
  const understandingSnapshot = selectedRun?.workflow?.understandingSnapshot
  const automaticTransition = selectedRun?.workflow?.automaticTransition
  const linkedTestDesign = automaticTransition?.testDesignId && automaticTransition.testDesignRunId
    ? { designId: automaticTransition.testDesignId, runId: automaticTransition.testDesignRunId }
    : undefined
  const awaitingClarificationResume = selectedRun?.status === 'waiting_clarification' && !blockingClarifications.length && selectedRun.step === 'continuing_after_clarification'
  const stages: Array<{ label: string; detail: string; state: RequirementStageState }> = [
    { label: '资料输入', detail: analysisInputDocuments.length ? `${analysisInputDocuments.length} 份已就绪` : '待上传', state: analysisInputDocuments.length ? 'complete' : 'current' },
    { label: '需求理解', detail: !selectedRun ? '未开始' : selectedRun.status === 'running' ? `${selectedRun.progress}%` : blockingClarifications.length ? `等待 ${blockingClarifications.length} 个业务事实` : awaitingClarificationResume ? '业务事实已确认，等待当前 Run 继续' : understandingSnapshot ? '已由服务端自动冻结' : selectedRun.status === 'failed' ? '执行失败' : '正在冻结', state: !selectedRun ? 'waiting' : selectedRun.status === 'running' || blockingClarifications.length || awaitingClarificationResume ? 'current' : understandingSnapshot ? 'complete' : selectedRun.status === 'failed' ? 'blocked' : 'waiting' },
    { label: 'Agent 自动设计测试', detail: automaticTransition?.status === 'succeeded' ? '测试设计运行已创建，请查看实时进度' : automaticTransition?.status === 'failed' ? '自动衔接失败' : automaticTransition?.status === 'running' || automaticTransition?.status === 'pending' ? '正在创建测试设计运行' : understandingSnapshot ? '等待自动衔接' : '等待需求理解', state: automaticTransition?.status === 'succeeded' ? 'complete' : automaticTransition?.status === 'failed' ? 'blocked' : automaticTransition?.status === 'running' || automaticTransition?.status === 'pending' || understandingSnapshot ? 'current' : 'waiting' },
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
          <div className="rav2-session-actions"><select aria-label="需求分析运行历史" value={selectedRunId} onChange={event => setSelectedRunId(event.target.value)} disabled={loadingRuns}><option value="">{loadingRuns ? '加载中…' : '运行历史'}</option>{runs.map(run => <option value={run.id} key={run.id}>{formatTime(run.createdAt)} · {runLabel(run)}</option>)}</select><button aria-label="刷新运行" onClick={() => void refreshRuns()}><RefreshCw /></button><button aria-label="下载分析报告" onClick={exportReport} disabled={!selectedRun?.response}><Download /></button></div>
        </header>
        <nav className="rav2-session-tabs">{viewTabs.map(tab => <button className={view === tab.key ? 'active' : ''} key={tab.key} onClick={() => setView(tab.key)}><tab.icon />{tab.label}{tab.key === 'clarifications' && blockingClarifications.length ? <i>{blockingClarifications.length}</i> : null}</button>)}</nav>
        <div className={`rav2-session-body ${view === 'conversation' ? 'conversation' : view === 'cases' ? 'cases' : 'detail'}`}>
          {view === 'conversation' && <AgentConversation run={selectedRun} onReviewed={detail => setRuns(current => replaceRunDetail(current, detail))} notify={notify} />}
          {view === 'clarifications' && <Clarifications items={blockingClarificationHistory} answers={clarificationAnswers} actions={clarificationActions} busy={clarificationBusy} onAnswerChange={(id, value) => setClarificationAnswers(current => ({ ...current, [id]: value }))} onActionChange={(id, action) => setClarificationActions(current => ({ ...current, [id]: action }))} onSubmit={() => void resolveClarifications()} />}
          {view === 'cases' && <Suspense fallback={<div className="rav2-empty"><LoaderCircle className="rotating" /><h2>正在加载测试设计运行</h2><p>正在建立测试设计的正式上下文。</p></div>}>{linkedTestDesign ? <EmbeddedTestDesignPage key={`${selectedRun?.id}:${linkedTestDesign.designId}:${linkedTestDesign.runId}`} embedded projectVersion={projectVersion} onManageVersions={onManageVersions} notify={notify} linkedDesignId={linkedTestDesign.designId} linkedRunId={linkedTestDesign.runId} /> : projectVersion.requirementReleaseBinding ? <EmbeddedTestDesignPage key={`new-test-design:${projectVersion.id}`} projectVersion={projectVersion} onManageVersions={onManageVersions} notify={notify} initialCreate /> : <div className="rav2-empty"><LoaderCircle className="rotating" /><h2>正在创建测试设计运行</h2><p>需求分析完成后，服务端会绑定本次需求理解对应的测试设计运行。</p></div>}</Suspense>}
          {view === 'details' && <section className="rav2-advanced-details"><header><div><ShieldCheck /><span><b>详细信息</b><small>运行配置、分析观察项、Snapshot、版本产物与差异仅用于追溯和排障，不影响当前主流程。</small></span></div><nav>{detailTabs.map(tab => <button className={detailView === tab.key ? 'active' : ''} key={tab.key} onClick={() => setDetailView(tab.key)}>{tab.label}</button>)}</nav></header><div>{detailView === 'baseline' && <Baseline result={result} onEvidence={openEvidence} />}{detailView === 'findings' && <Findings result={result} selectedRun={selectedRun} findingStates={findingStates} findingTypeFilter={findingTypeFilter} setFindingTypeFilter={setFindingTypeFilter} severityFilter={severityFilter} setSeverityFilter={setSeverityFilter} findingStateFilter={findingStateFilter} setFindingStateFilter={setFindingStateFilter} visibleFindings={visibleFindings} documents={requirementDocuments} repairDrafts={repairDrafts} verificationBusyDraftId={verificationBusyDraftId} onEvidence={openEvidence} onState={updateFindingState} onAiFix={draftFindingFix} onStartVerification={startVerification} onViewRepairDiff={openRepairDiff} canAiFix={projectVersion.status === 'open'} />}{detailView === 'artifacts' && <Artifacts result={result} release={release} understandingSnapshot={understandingSnapshot} runId={selectedRun?.id} />}{detailView === 'diff' && <Diff versions={versionHistory} value={diffVersionIds} onChange={setDiffVersionIds} loading={diffLoading} removed={removedLines} added={addedLines} />}</div></section>}
        </div>
        {view === 'conversation' && <footer className="rav2-session-boundary"><ShieldCheck /><span><b>连续 Planning Session</b><small>Requirement、Human Clarification、TestPoint、TestCase 与 Coverage 共用同一父会话；正式事实始终从 Version / Snapshot / Workspace 重新建立。</small></span></footer>}
      </main>

      <aside className="rav2-status-panel">
        <header><span><b>当前任务 / 正式产物</b><small>{selectedRun?.id ? `Run ${selectedRun.id.replace('analysis_run_', '').slice(0, 10)}` : '尚未创建 Run'}</small></span><Badge tone={selectedRun?.status === 'succeeded' ? 'green' : selectedRun?.status === 'running' ? 'purple' : selectedRun?.status === 'failed' ? 'red' : 'gray'}>{runLabel(selectedRun)}</Badge></header>
        <div className="rav2-status-scroll">
          <section className="rav2-status-card"><header><i>①</i><b>当前业务阶段</b></header><div className="rav2-stage-list">{stages.map(stage => <article className={stage.state} key={stage.label}><span /><b>{stage.label}</b><small>{stage.detail}</small></article>)}</div></section>
          <section className="rav2-status-card"><header><i>②</i><b>正式产物</b></header><div className="rav2-formal-list"><button onClick={() => openDetails('artifacts')} disabled={!result}><span><b>需求理解快照</b><small>{understandingSnapshot ? `已由服务端自动冻结 · ${formatTime(understandingSnapshot.createdAt)}` : '等待需求理解达到可测试状态'}</small></span><em className={understandingSnapshot ? 'published' : 'empty'}>{understandingSnapshot ? '已冻结' : '—'}</em></button><button onClick={() => setView('cases')} disabled={!linkedTestDesign}><span><b>测试用例</b><small>{linkedTestDesign ? '查看本次测试设计运行与候选用例' : automaticTransition?.status === 'running' || automaticTransition?.status === 'pending' ? '正在创建测试设计运行' : '等待需求理解快照'}</small></span><em>{linkedTestDesign ? '可查看' : '—'}</em></button><button onClick={() => setView('cases')} disabled={!linkedTestDesign}><span><b>Execution Handoff</b><small>由正式测试设计发布后生成</small></span><em>—</em></button></div></section>
          <details className="rav2-status-card rav2-technical-status"><summary><Activity /><span><b>运行记录</b><small>Turn、工具调用、事件与异常</small></span></summary><div className="rav2-activity-summary"><div className="rav2-activity-state"><span className={selectedRun?.status ?? 'idle'}><Activity /></span><div><b>{selectedRun ? runLabel(selectedRun) : '等待启动'}</b><small>{latestActivity ? `${agentEventLabels[latestActivity.type] ?? latestActivity.type} · #${latestActivity.sequence}` : '尚无 Agent Activity'}</small></div></div><div className="rav2-activity-metrics"><span><small>Turn</small><b>{activityExecution?.turns ?? 0}</b></span><span><small>工具</small><b>{activityExecution?.toolCalls ?? 0}</b></span><span><small>事件</small><b>{activityEvents.length}</b></span><span><small>异常</small><b>{activityExecution?.toolErrors ?? 0}</b></span></div></div></details>
        </div>
        <footer className="rav2-status-action">
          {!selectedRun ? projectVersion.requirementReleaseBinding ? <button className="primary" onClick={() => setView('cases')}><Play />新建测试设计</button> : <button className="primary" onClick={startAnalysis} disabled={!canRun}><Play />{starting ? '启动中…' : '开始分析'}</button> : selectedRun.status === 'running' ? <button className="danger" onClick={cancelAnalysis}><XCircle />取消当前运行</button> : blockingClarifications.length ? <button className="primary" onClick={() => setView('clarifications')}><Quote />回答 {blockingClarifications.length} 个待确认问题</button> : awaitingClarificationResume ? <button className="primary" onClick={() => void resumeClarifiedAnalysis()} disabled={clarificationBusy}><RefreshCw />{clarificationBusy ? '正在继续…' : '继续当前分析'}</button> : ['failed', 'cancelled'].includes(selectedRun.status) ? <button className="primary" onClick={retryAnalysis} disabled={!canRun}><RefreshCw />重新分析</button> : automaticTransition?.status === 'failed' ? <button className="primary" onClick={() => void retryAutomaticTransition()} disabled={releaseBusy}><RefreshCw />重试自动测试设计</button> : linkedTestDesign ? <button className="primary" onClick={() => setView('cases')}><Play />查看测试设计运行</button> : <button className="primary" disabled><LoaderCircle className="rotating" />{understandingSnapshot ? '正在创建测试设计运行' : '服务端正在冻结需求理解'}</button>}
        </footer>
      </aside>
    </div>

    {sourceEvidence && <div className="rav2-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) setSourceEvidence(null) }}><section className="rav2-source-modal"><header><span><ShieldCheck /><b>固定原文证据</b></span><button onClick={() => setSourceEvidence(null)}><XCircle /></button></header><div className="rav2-evidence"><b>{sourceEvidence.clientEvidenceId} · {sourceEvidence.locator.heading}</b><p>“{sourceEvidence.quote}”</p></div><div className="rav2-source-body">{sourceLoading ? <LoaderCircle className="rotating" /> : <MarkdownDocument source={sourceContent} format="markdown" />}</div></section></div>}
    {fixFinding && <FixModal finding={fixFinding} draft={fixDraft} busy={fixBusy} assets={fixedAssets(selectedRun!)} onClose={() => { if (!fixBusy) { setFixFinding(null); setFixDraft(null) } }} onRegenerate={() => void draftFindingFix(fixFinding)} onApprove={() => void approveRepair()} />}
  </section>
}

function Clarifications({ items, answers, actions, busy, onAnswerChange, onActionChange, onSubmit }: { items: PlanningClarification[]; answers: Record<string, string>; actions: Record<string, ClarificationAction>; busy: boolean; onAnswerChange: (id: string, value: string) => void; onActionChange: (id: string, action: ClarificationAction) => void; onSubmit: () => void }) {
  const pending = items.filter(item => item.status === 'pending')
  if (!items.length) return <div className="rav2-empty"><CheckCircle2 /><h2>没有需要人工确认的业务事实</h2><p>PlanningAgent 将继续冻结需求理解并自动进入测试设计。</p></div>
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

function Overview({ result, blockingClarificationCount, understandingSnapshot, onOpenDetails }: { result?: RequirementAnalysisResponse['result']; blockingClarificationCount: number; understandingSnapshot?: RequirementUnderstandingSnapshot; onOpenDetails: () => void }) {
  if (!result) return <div className="rav2-empty"><Sparkles /><h2>等待需求分析</h2><p>完成后，PlanningAgent 会形成可测试的需求理解；只有无法从资料确认的业务事实才会需要人工回答。</p></div>
  const snapshotReady = Boolean(understandingSnapshot)
  return <div><section className="rav2-assessment"><div><Badge tone={blockingClarificationCount ? 'orange' : snapshotReady ? 'green' : 'purple'}>{blockingClarificationCount ? '等待业务确认' : snapshotReady ? '需求理解已冻结' : '正在形成需求理解'}</Badge><h2>{result.summary.overview || 'PlanningAgent 已完成需求理解'}</h2><p>{blockingClarificationCount ? `仍有 ${blockingClarificationCount} 个业务事实会影响测试用例正确性，需要你的确认。` : result.summary.risks[0] ?? result.summary.strengths[0] ?? '需求理解通过服务端校验后会自动冻结并进入测试设计。'}</p></div><div className="rav2-understanding-state"><ShieldCheck /><strong>{snapshotReady ? '已冻结' : blockingClarificationCount ? '待确认' : '分析中'}</strong><span>服务端治理</span></div></section><div className="rav2-kpis"><article><GitBranch /><span>识别需求点</span><strong>{result.requirementPoints.length}</strong></article><article><Quote /><span>阻断澄清</span><strong>{blockingClarificationCount}</strong><small>{blockingClarificationCount ? '需要补充业务事实' : '无需人工确认'}</small></article><article><ShieldCheck /><span>测试关注点</span><strong>{result.testFocus.length}</strong></article><article><FileText /><span>需求理解快照</span><strong>{snapshotReady ? '已冻结' : '等待中'}</strong></article></div><section className="rav2-top"><header><div><ShieldCheck /><b>自动推进状态</b></div></header><p>{snapshotReady ? '需求理解快照已由服务端冻结，PlanningAgent 将以该快照、Workspace 与已确认的澄清继续生成测试点和测试用例。' : blockingClarificationCount ? '请在“待确认问题”中回答阻断澄清；普通分析观察项不会阻塞测试设计。' : '正在校验并冻结需求理解，完成后会自动进入测试设计。'}</p></section><section className="rav2-top"><header><div><AlertTriangle /><b>分析观察项</b></div><button onClick={onOpenDetails}>在详细信息查看</button></header><p>共识别 {result.findings.length} 条观察项，用于追溯和完善需求；它们不是当前用户待办，也不会替代正式的 Clarification。</p></section></div>
}

function Baseline({ result, onEvidence }: { result?: RequirementAnalysisResponse['result']; onEvidence: (evidence: AnalysisEvidence) => void }) {
  if (!result) return <div className="rav2-empty"><GitBranch /><h2>暂无需求理解结构</h2></div>
  const evidence = new Map(result.evidence.map(item => [item.clientEvidenceId, item]))
  return <div className="rav2-baseline"><header><div><GitBranch /><span><h2>需求理解结构</h2><p>该结构用于追溯；可下钻到固定原文证据。</p></span></div><Badge tone="green">{result.requirementPoints.length}</Badge></header>{result.requirementPoints.map(point => { const linked = point.evidenceRefs.map(id => evidence.get(id)).filter((item): item is AnalysisEvidence => Boolean(item)); return <article key={point.clientRequirementPointId}><header><span className="rav2-rp">{point.clientRequirementPointId}</span><div><h3>{point.title}</h3><p>{point.description}</p></div><Badge tone={linked.length ? 'green':'orange'}>{linked.length} Evidence</Badge></header><footer>{linked.map(item => <button key={item.clientEvidenceId} onClick={() => onEvidence(item)}><Quote />{item.clientEvidenceId} · {item.locator.heading}</button>)}</footer></article>})}</div>
}

function Findings(props: {
  result?: RequirementAnalysisResponse['result']
  selectedRun?: RunRecord
  findingStates: Record<string, FindingState>
  findingTypeFilter: 'all' | AnalysisFindingType
  setFindingTypeFilter: (value: 'all' | AnalysisFindingType) => void
  severityFilter: 'all' | AnalysisSeverity
  setSeverityFilter: (value: 'all' | AnalysisSeverity) => void
  findingStateFilter: 'all' | FindingState
  setFindingStateFilter: (value: 'all' | FindingState) => void
  visibleFindings: AnalysisFinding[]
  documents: KnowledgeDocument[]
  repairDrafts: RequirementRepairDraft[]
  verificationBusyDraftId: string
  onEvidence: (evidence: AnalysisEvidence) => void
  onState: (finding: AnalysisFinding, state: FindingState) => void
  onAiFix: (finding: AnalysisFinding) => void
  onStartVerification: (draft: RequirementRepairDraft) => void
  onViewRepairDiff: (draft: RequirementRepairDraft) => void
  canAiFix: boolean
}) {
  const { result, selectedRun, findingStates, visibleFindings } = props
  if (!result) return <div className="rav2-empty"><AlertTriangle /><h2>暂无需求问题</h2></div>
  return <div className="rav2-findings">
    <header><div><AlertTriangle /><span><h2>分析观察项</h2><p>用于追溯和完善需求，不构成当前用户待办；只有 blocking clarification 会阻塞测试设计。</p></span></div><Badge tone="blue">已记录 {result.findings.length}</Badge></header>
    <div className="rav2-filters">
      <select value={props.findingTypeFilter} onChange={event => props.setFindingTypeFilter(event.target.value as 'all' | AnalysisFindingType)}><option value="all">全部类型</option>{Object.entries(findingTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
      <select value={props.severityFilter} onChange={event => props.setSeverityFilter(event.target.value as 'all' | AnalysisSeverity)}><option value="all">全部严重度</option>{Object.entries(severityLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
      <select value={props.findingStateFilter} onChange={event => props.setFindingStateFilter(event.target.value as 'all' | FindingState)}><option value="all">全部状态</option>{Object.entries(findingStateLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
      <span className="rav2-filter-count">当前显示 {visibleFindings.length} / {result.findings.length}</span>
    </div>
    {visibleFindings.map(finding => {
      const state = selectedRun ? findingStates[`${selectedRun.id}:${finding.clientFindingId}`] ?? 'open' : 'open'
      const evidence = evidenceForFinding(finding, result)
      const repair = repairDraftForFinding(props.repairDrafts, finding.clientFindingId)
      const pendingVerification = repair?.status === 'applied'
      const verificationRunning = repair?.status === 'verification_running'
      const deferred = state === 'needs_follow_up' && !pendingVerification && !verificationRunning
      const stateLabel = pendingVerification ? '待复验' : verificationRunning ? 'AI 复验中' : deferred ? '已暂缓' : findingStateLabels[state]
      const stateTone = state === 'resolved' ? 'green' : state === 'dismissed' ? 'gray' : state === 'needs_follow_up' ? 'blue' : state === 'confirmed' ? 'green' : 'orange'
      return <article className="rav2-finding" key={finding.clientFindingId}>
        <header><div><Badge tone={severityTone(finding.severity)}>{severityLabels[finding.severity]}</Badge><span><small>{findingTypeLabels[finding.type]} · {finding.clientFindingId}</small><h3>{finding.title}</h3></span></div><Badge tone={stateTone}>{stateLabel}</Badge></header>
        <div className="rav2-refs">{finding.requirementPointRefs.length ? finding.requirementPointRefs.map(reference => <span key={reference}>{reference}</span>) : <span className="global">🌐 整体需求问题</span>}</div>
        <p>{finding.description}</p>
        <dl><div><dt>影响</dt><dd>{finding.impact}</dd></div><div><dt>AI 建议</dt><dd>{finding.recommendation}</dd></div></dl>
        {pendingVerification && repair?.application && <section className="rav2-repair-applied">
          <header><div><CheckCircle2 /><span><b>修复方案已应用</b><small>{repair.id}</small></span></div><Badge tone="blue">待复验</Badge></header>
          <div>{repair.application.items.map(item => <article key={item.targetAssetVersionId}><span><small>原版本</small><b>{assetVersionLabel(item.sourceAssetVersionId, props.documents)}</b></span><em>→</em><span><small>新版本</small><b>{assetVersionLabel(item.targetAssetVersionId, props.documents)}</b></span><p>{item.logicalPath}</p></article>)}</div>
          <footer><button className="btn ghost" onClick={() => props.onViewRepairDiff(repair)}><FileDiff />查看版本差异</button><button className="btn primary" onClick={() => props.onStartVerification(repair)} disabled={props.verificationBusyDraftId === repair.id}>{props.verificationBusyDraftId === repair.id ? <LoaderCircle className="rotating" /> : <Play />}开始 AI 复验</button></footer>
        </section>}
        <footer><span>{evidence.length} 条证据 · 置信度 {Math.round(finding.confidence * 100)}%</span><div>
          {evidence.slice(0, 1).map(item => <button key={item.clientEvidenceId} onClick={() => props.onEvidence(item)}><BookOpen />查看原文</button>)}
          {state === 'open' && <><button className="accept" onClick={() => props.onState(finding, 'confirmed')} disabled={!props.canAiFix}><CheckCircle2 />采纳问题</button><button className="reject" onClick={() => props.onState(finding, 'dismissed')} disabled={!props.canAiFix}><XCircle />不采纳</button><button className="defer" onClick={() => props.onState(finding, 'needs_follow_up')} disabled={!props.canAiFix}><Clock3 />暂缓</button></>}
          {state === 'confirmed' && <button className="ai" onClick={() => props.onAiFix(finding)} disabled={!props.canAiFix}><Sparkles />生成 AI 修复方案</button>}
          {(state === 'dismissed' || deferred) && <button onClick={() => props.onState(finding, 'open')} disabled={!props.canAiFix}><RefreshCw />重新处理</button>}
        </div></footer>
      </article>
    })}
  </div>
}

function Artifacts({ result, release, understandingSnapshot, runId }: { result?: RequirementAnalysisResponse['result']; release?: RequirementReleasePackage; understandingSnapshot?: RequirementUnderstandingSnapshot; runId?: string }) {
  if (!result) return <div className="rav2-empty"><FileText /><h2>暂无需求分析候选</h2></div>
  const machineNames = new Set(['requirements.json', 'findings.json', 'test-focus.json', 'traceability.json', 'manifest.json'])
  const refined = release?.artifacts.find(item => item.fileName === 'refined-requirements.md')?.content
  return <div className="rav2-artifacts"><header><div><FileText /><span><h2>需求理解快照与正式产物</h2><p>不再需要人工生成或发布 Requirement Release。没有阻断澄清时，Service 会自动冻结需求理解并建立下游正式输入。</p></span></div><Badge tone={understandingSnapshot ? 'green' : 'gray'}>{understandingSnapshot ? '已自动冻结' : '等待冻结'}</Badge></header>{understandingSnapshot ? <div className="rav2-snapshot-facts"><span><small>Snapshot</small><b>{understandingSnapshot.id}</b></span><span><small>冻结时间</small><b>{formatTime(understandingSnapshot.createdAt)}</b></span><span><small>需求点</small><b>{understandingSnapshot.requirementPointIds.length}</b></span><span><small>已纳入澄清</small><b>{understandingSnapshot.clarifications.length}</b></span></div> : <div className="rav2-warning"><Clock3 />当前尚未形成可测试的需求理解；系统会在 blocking clarification 全部解决后自动冻结。</div>}{refined&&<details><summary>可读需求理解</summary><div className="rav2-markdown"><MarkdownDocument source={refined} format="markdown" /></div></details>}{release&&<details><summary>服务端生成的下游产物</summary><div className="rav2-artifact-list">{release.artifacts.map(artifact=><article key={artifact.fileName}><b>{artifact.fileName}</b><small>{artifact.mediaType} · {artifact.contentSha256}</small>{release.status==='published'&&runId?<a className="btn ghost" href={requirementReleaseArtifactUrl(runId,artifact.fileName)} download={artifact.fileName.split('/').at(-1)}><Download />下载</a>:null}</article>)}</div><div className="rav2-artifact-list">{release.artifacts.filter(item=>machineNames.has(item.fileName)).map(item=><article key={item.fileName}><b>{item.fileName}</b><small>{item.fileName==='requirements.json'?'测试设计的正式需求输入':'服务端生成并按 Schema 校验'} · {item.contentSha256}</small></article>)}</div></details>}<details><summary>分析期候选（非正式产物）</summary><div className="rav2-artifact-list">{result.artifacts.map(item=><article key={item.fileName}><b>{item.fileName}</b><small>{item.contentSha256}</small></article>)}</div></details></div>
}

function Diff({ versions,value,onChange,loading,removed,added }:{ versions:NonNullable<KnowledgeDocument['versions']>; value:[string,string]; onChange:(v:[string,string])=>void; loading:boolean; removed:string[]; added:string[] }) {
  if (versions.length<2) return <div className="rav2-empty"><FileDiff /><h2>暂无可比较版本</h2><p>AI 修复应用后会产生新的需求 AssetVersion。</p></div>
  return <div className="rav2-diff"><header><div><span>基准版本</span><select value={value[0]} onChange={e=>onChange([e.target.value,value[1]])}>{versions.map(v=><option value={v.id} key={v.id}>V{v.number}</option>)}</select></div><div><span>目标版本</span><select value={value[1]} onChange={e=>onChange([value[0],e.target.value])}>{versions.map(v=><option value={v.id} key={v.id}>V{v.number}</option>)}</select></div></header>{loading?<div className="rav2-empty"><LoaderCircle className="rotating" /></div>:<div className="rav2-diff-grid"><section><h3>删除 <span>{removed.length}</span></h3>{removed.map((line,i)=><p className="removed" key={`${i}-${line}`}>− {line}</p>)}</section><section><h3>新增 <span>{added.length}</span></h3>{added.map((line,i)=><p className="added" key={`${i}-${line}`}>+ {line}</p>)}</section></div>}</div>
}

function FixModal({ finding, draft, busy, assets, onClose, onRegenerate, onApprove }: { finding: AnalysisFinding; draft: RequirementRepairDraft | null; busy: boolean; assets: Array<{ assetVersionId: string; logicalPath: string; displayName: string }>; onClose: () => void; onRegenerate: () => void; onApprove: () => void }) {
  const assetByVersion = new Map(assets.map(asset => [asset.assetVersionId, asset]))
  return <div className="rav2-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) onClose() }}><section className="rav2-fix-modal">
    <header><div><Sparkles /><span><b>AI 修复建议 · {finding.clientFindingId}</b><small>{finding.title}</small></span></div><button onClick={onClose} disabled={busy} aria-label="关闭 AI 修复建议"><XCircle /></button></header>
    {busy && !draft ? <div className="rav2-empty"><LoaderCircle className="rotating" /><h2>Pi Agent 正在生成可审核的修复 Diff</h2></div> : draft ? <>
      <div className="rav2-fix-summary"><Wrench /><span><b>修复说明</b><p>{draft.candidate.summary}</p><small>{draft.id} · 等待人工审核修复方案</small></span></div>
      <div className="rav2-patches">{draft.candidate.patches.map((patch, index) => <article key={`${patch.assetVersionId}-${index}`}><header><b>建议 {index + 1} · {assetByVersion.get(patch.assetVersionId)?.displayName ?? patch.assetVersionId}</b><small>{assetByVersion.get(patch.assetVersionId)?.logicalPath}</small></header><p>{patch.reason}</p><div className="rav2-patch-diff"><section><h4>原文</h4><pre>{patch.before}</pre></section><section><h4>建议修改</h4><pre>{patch.after}</pre></section></div><small>关联问题：{patch.findingRefs.join('、')}</small></article>)}</div>
      <footer><button className="btn ghost" onClick={onClose} disabled={busy}><XCircle />放弃修复</button><button className="btn ghost" onClick={onRegenerate} disabled={busy}><RefreshCw />重新生成</button><button className="btn primary" onClick={onApprove} disabled={busy}>{busy ? <LoaderCircle className="rotating" /> : <CheckCircle2 />}{busy ? '正在生成新版本…' : '采纳并生成新版本'}</button></footer>
    </> : <div className="rav2-empty"><AlertTriangle /><h2>未生成有效修复建议</h2><button className="btn primary" onClick={onRegenerate}>重新生成</button></div>}
  </section></div>
}

function AgentConversation({ run, onReviewed, notify }: { run?: RunRecord; onReviewed: (run: RequirementAnalysisRun) => void; notify: Notify }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [reviewing, setReviewing] = useState(false)
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
  useEffect(() => { const root = scrollRef.current; if (root) root.scrollTo({ top: root.scrollHeight, behavior: 'smooth' }) }, [eventCount, latestClarificationAt])
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
        {!eventCount && <div className="rav2-agent-waiting"><LoaderCircle className={run.status === 'running' ? 'rotating' : ''} /><span><b>{run.status === 'running' ? '等待首个 Agent 事件' : '没有可展示的运行记录'}</b><small>{run.status === 'running' ? '消息和工具调用写入服务端后会自动同步。' : '旧运行可能只保留了结果摘要。'}</small></span></div>}
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
