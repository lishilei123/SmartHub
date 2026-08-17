import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, AlertTriangle, BookOpen, Bot, CheckCircle2, Clock3, Download, FileDiff, FileText,
  FolderOpen, GitBranch, ListFilter, LoaderCircle, Play, Quote, RefreshCw, ShieldCheck, Sparkles, Trash2, Wrench, XCircle,
} from 'lucide-react'
import type { KnowledgeDocument } from './prototype-data'
import { loadAssetVersion, waitForTaskResults } from './knowledge-api'
import { MarkdownDocument } from './MarkdownDocument'
import { PlanningContextMetrics, PlanningSubAgentRuns } from './PlanningObservability'
import { runRequirementReviewer } from './planning-api'
import {
  cancelRequirementAnalysisRun,
  createRequirementReleaseCandidate,
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
  publishRequirementRelease,
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
} from './requirement-analysis-api'
import { requirementAnalysisInputTypeForDocument, requirementWorkspaceDirectory } from './version-document-path'
import { loadAgentConfiguration, type AgentConfigurationState } from './agent-configuration-api'
import type { ProjectVersion } from './project-version-api'
import './requirement-analysis-v2.css'
import './requirement-analysis-review-flow.css'

type Notify = (message: string, tone?: 'success' | 'error' | 'warning') => void
type ViewKey = 'conversation' | 'overview' | 'baseline' | 'findings' | 'artifacts' | 'diff'
type FindingState = 'open' | 'confirmed' | 'dismissed' | 'resolved' | 'needs_follow_up'
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
  onOpenTestDesign?: () => void
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
  { key: 'overview', label: '分析概览', icon: Sparkles },
  { key: 'baseline', label: '需求基线', icon: GitBranch },
  { key: 'findings', label: '需求问题', icon: AlertTriangle },
  { key: 'artifacts', label: '最终产物', icon: FileText },
  { key: 'diff', label: '版本差异', icon: FileDiff },
]

function Badge({ children, tone = 'gray' }: { children: React.ReactNode; tone?: string }) { return <span className={`rav2-badge ${tone}`}>{children}</span> }
function formatTime(value: string) { return new Date(value).toLocaleString('zh-CN', { hour12: false }) }
function severityTone(value: AnalysisSeverity) { return value === 'blocker' ? 'red' : value === 'high' ? 'orange' : value === 'medium' ? 'gold' : 'blue' }
function assessmentLabel(value?: string) { return value === 'blocked' ? '存在阻断问题' : value === 'needs_revision' ? '建议修改后确认' : value === 'pass_with_notes' ? '附带关注项通过' : value === 'pass' ? '可以进入下一阶段' : '等待分析' }
function runLabel(run?: RunRecord) { return run?.status === 'running' ? '分析中' : run?.status === 'succeeded' ? '已完成' : run?.status === 'failed' ? '失败' : run?.status === 'cancelled' ? '已取消' : '未运行' }
const agentEventLabels: Record<string, string> = {
  runtime_initialized: 'Runtime 已初始化', agent_start: 'Agent 已启动', agent_end: 'Agent 已结束', turn_start: 'Turn 开始', turn_end: 'Turn 结束',
  message_start: '消息开始', message_end: '消息完成', tool_execution_start: '工具调用开始', tool_execution_end: '工具调用结束',
  input_package_built: '输入包已构建', input_batch_delivered: '输入批次已投递', input_final_merge_started: '开始合并输入',
  result_submission_required: '等待提交正式结果', result_submission_retry: '结果校验未通过，等待修正', evidence_repair_tools_enabled: '证据修复工具已启用',
  skill_bindings_loaded: '已加载 Agent 绑定的全部 Skill',
}
function eventTime(value: string) { return new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) }
function formatTraceValue(value: unknown) { if (value === undefined) return ''; try { return JSON.stringify(value, null, 2) } catch { return String(value) } }
function evidenceForFinding(finding: AnalysisFinding, result?: RequirementAnalysisResponse['result']) {
  if (!result) return [] as AnalysisEvidence[]
  const points = new Map(result.requirementPoints.map(item => [item.clientRequirementPointId, item]))
  const evidence = new Map(result.evidence.map(item => [item.clientEvidenceId, item]))
  const refs = new Set(finding.requirementPointRefs.flatMap(reference => points.get(reference)?.evidenceRefs ?? []))
  return [...refs].map(reference => evidence.get(reference)).filter((item): item is AnalysisEvidence => Boolean(item))
}

function readAssetVersionIds(run?: RunRecord) {
  return new Set((run?.response?.inputDeliveryManifest ?? run?.inputDeliveryManifest)?.toolReads?.flatMap(read => read.assetVersionIds) ?? [])
}

function workspaceScopeLabel(scope?: string) {
  return scope === 'current_input' ? 'current_input' : scope === 'current_branch' ? 'current_branch' : scope === 'shared' ? 'shared' : scope === 'historical_branch' ? 'historical_branch' : scope === 'formal_output' ? 'formal_output' : 'workspace'
}

function fixedAssets(run: RunRecord) {
  return run.snapshot?.assets ?? run.documents ?? []
}

type PlanningExecutionGroup = {
  id: string
  label: string
  status?: 'running' | 'succeeded' | 'failed' | 'cancelled'
  execution: AgentExecutionRecord
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
    return execution ? [{ id: `attempt-${attempt.attempt}`, label: `Worker Attempt ${attempt.attempt}/${attempt.maxAttempts}`, status: attempt.status, execution }] : []
  })
  const current = [run?.response?.executions?.planning, run?.executions?.planning, run?.execution?.agentKey === 'planning' ? run.execution : undefined]
    .filter((item): item is AgentExecutionRecord => Boolean(item))
    .sort((left, right) => left.events.length - right.events.length)
    .at(-1)
  if (!current || attempts.some(attempt => sameExecution(attempt.execution, current))) return attempts
  return [...attempts, { id: 'current', label: attempts.length ? '当前执行记录' : '执行记录', status: run?.status, execution: current }]
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
  const { projectVersion, documents, apiState, refreshKnowledge, notify, addAudit, onManageVersions, onOpenKnowledge, onOpenActivity, onOpenTestDesign, onOpenInputDocument, onDeleteInputDocument, canDeleteInputDocument = false } = props
  const [view, setView] = useState<ViewKey>('conversation')
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
  const [diffVersionIds, setDiffVersionIds] = useState<[string, string]>(['', ''])
  const [diffContents, setDiffContents] = useState<Record<string, string>>({})
  const [diffLoading, setDiffLoading] = useState(false)
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
  const readVersions = readAssetVersionIds(selectedRun)
  const workspaceSnapshot = selectedRun?.snapshot?.workspaceSnapshot
  const currentInputRefs = selectedRun?.snapshot?.currentInputRefs ?? []
  const observedReads = (selectedRun?.response?.inputDeliveryManifest ?? selectedRun?.inputDeliveryManifest)?.toolReads ?? []
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
        if (detail.status === 'running') timer = setTimeout(() => void poll(), 1_000)
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
    if (view !== 'diff') return
    const missing = diffVersionIds.filter(Boolean).filter(id => !(id in diffContents)); if (!missing.length) return
    let cancelled = false; setDiffLoading(true)
    Promise.all(missing.map(async id => [id, (await loadAssetVersion(id)).content] as const)).then(entries => {
      if (!cancelled) setDiffContents(current => ({ ...current, ...Object.fromEntries(entries) }))
    }).catch(error => { if (!cancelled) notify(error instanceof Error ? error.message : '固定版本读取失败', 'error') }).finally(() => { if (!cancelled) setDiffLoading(false) })
    return () => { cancelled = true }
  }, [view, diffVersionIds, diffContents])

  const startAnalysis = async () => {
    if (!projectVersion || !canRun) return
    setStarting(true)
    try {
      const started = await startRequirementAnalysis(projectVersion.id, { documentDirectoryPath: workspaceDirectoryPath, focusAreas: ['功能完整性', '业务闭环', '异常流程', '边界条件', '跨需求一致性', '可测试性'] })
      setRuns(current => [started, ...current.filter(item => item.id !== started.id)]); setSelectedRunId(started.id); setView('conversation')
      addAudit(`启动 PlanningAgent 需求分析：${started.id}`); notify('需求分析已在当前 Planning Session 启动。')
    } catch (error) { notify(error instanceof Error ? error.message : '需求分析启动失败', 'error') } finally { setStarting(false) }
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
    setView('findings')
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
    setView('diff')
  }

  const visibleFindings = (result?.findings ?? []).filter(finding => {
    const state = selectedRun ? findingStates[`${selectedRun.id}:${finding.clientFindingId}`] ?? 'open' : 'open'
    return (findingTypeFilter === 'all' || finding.type === findingTypeFilter) && (severityFilter === 'all' || finding.severity === severityFilter) && (findingStateFilter === 'all' || state === findingStateFilter)
  })
  const blockerCount = result?.findings.filter(item => item.severity === 'blocker').length ?? 0
  const highCount = result?.findings.filter(item => item.severity === 'high').length ?? 0
  const pendingCount = result?.findings.filter(item => {
    const state = selectedRun ? findingStates[`${selectedRun.id}:${item.clientFindingId}`] ?? 'open' : 'open'; return !['resolved', 'dismissed'].includes(state)
  }).length ?? 0
  const release = selectedRun?.workflow?.release
  const generateRelease = async () => {
    if (!selectedRun || selectedRun.status !== 'succeeded') return
    setReleaseBusy(true)
    try {
      const created = await createRequirementReleaseCandidate(selectedRun.id)
      setRuns(current => current.map(item => item.id === selectedRun.id ? { ...item, workflow: { ...(item.workflow ?? { currentStage: 'release' as const }), currentStage: 'release', release: created } } : item))
      addAudit(`生成需求发布候选：${created.id}`); notify('发布候选已生成；请核对人读与机器可读产物后正式发布。')
    } catch (error) { notify(error instanceof Error ? error.message : '需求发布候选生成失败', 'error') } finally { setReleaseBusy(false) }
  }
  const publishRelease = async () => {
    if (!selectedRun || release?.status !== 'candidate') return
    setReleaseBusy(true)
    try {
      const published = await publishRequirementRelease(selectedRun.id)
      setRuns(current => current.map(item => item.id === selectedRun.id && item.workflow ? { ...item, workflow: { ...item.workflow, release: published } } : item))
      addAudit(`正式发布需求包：${published.id} · ${published.contentSha256}`); notify('需求发布包已正式发布且不可变；同一个 PlanningAgent Session 已收到测试设计任务。')
    } catch (error) { notify(error instanceof Error ? error.message : '需求发布失败', 'error') } finally { setReleaseBusy(false) }
  }

  const versionHistory = (selectedDocument?.versions ?? []).filter(item => item.status === 'ready')
  const leftLines = (diffContents[diffVersionIds[0]] ?? '').split(/\r?\n/).filter(Boolean); const rightLines = (diffContents[diffVersionIds[1]] ?? '').split(/\r?\n/).filter(Boolean)
  const removedLines = leftLines.filter(line => !rightLines.includes(line)); const addedLines = rightLines.filter(line => !leftLines.includes(line))
  const enabledSkills = agentConfiguration?.agents.planning.activeVersion?.agentDefinition.enabledSkills ?? []
  const repairDrafts = selectedRun?.workflow?.repairDrafts ?? []
  const failedRepair = repairDrafts.some(draft => draft.status === 'failed')
  const activeRepair = repairDrafts.some(draft => ['generated', 'approved', 'applying', 'applied', 'verification_running'].includes(draft.status))
  const verifiedRepairs = repairDrafts.filter(draft => draft.status === 'verified').length
  const stages: Array<{ label: string; detail: string; state: RequirementStageState }> = [
    { label: '资料输入', detail: analysisInputDocuments.length ? `${analysisInputDocuments.length} 份已就绪` : '待上传', state: analysisInputDocuments.length ? 'complete' : 'current' },
    { label: '需求分析', detail: !selectedRun ? '未开始' : selectedRun.status === 'running' ? `${selectedRun.progress}%` : selectedRun.status === 'succeeded' ? '已完成' : selectedRun.status === 'failed' ? '执行失败' : '已取消', state: !selectedRun || selectedRun.status === 'cancelled' ? 'waiting' : selectedRun.status === 'running' ? 'current' : selectedRun.status === 'succeeded' ? 'complete' : 'blocked' },
    { label: '问题处置', detail: !result ? '等待分析' : `${result.findings.length - pendingCount}/${result.findings.length} 已闭环`, state: !result ? 'waiting' : pendingCount ? 'current' : 'complete' },
    { label: '修复与复验', detail: !result ? '未开始' : failedRepair ? '存在失败任务' : activeRepair ? '进行中' : repairDrafts.length ? `${verifiedRepairs}/${repairDrafts.length} 已验证` : pendingCount ? '等待问题处置' : '无需修复', state: !result || (!repairDrafts.length && pendingCount > 0) ? 'waiting' : failedRepair ? 'blocked' : activeRepair ? 'current' : 'complete' },
    { label: 'Requirement Release', detail: release?.status === 'published' ? '已发布' : release?.status === 'candidate' ? '待人工发布' : result ? '待生成' : '未开始', state: release?.status === 'published' ? 'complete' : release?.status === 'candidate' ? 'current' : 'waiting' },
  ]
  const activityExecution = planningExecutionGroups(selectedRun).at(-1)?.execution
  const activityEvents = activityExecution?.events ?? []
  const latestActivity = activityEvents.at(-1)

  if (!projectVersion) return <section className="card rav2-gate"><GitBranch /><h1>新建项目版本后才能进行需求分析</h1><button className="btn primary" onClick={onManageVersions}>新建项目版本</button></section>

  return <section className="card rav2-page rav2-session-page">
    <div className="rav2-planning-layout">
      <aside className="rav2-workspace">
        <header><span><FolderOpen /><b>Project Workspace</b></span><Badge tone="blue">{workspaceSnapshot?.files.length ?? analysisInputDocuments.length}</Badge></header>
        <div className="rav2-workspace-observability"><div><span><small>本次重点输入</small><b>{currentInputRefs.length || requirementDocuments.length}</b></span><span><small>Workspace Snapshot</small><b>{workspaceSnapshot?.files.length ?? '—'}</b></span><span><small>AI 已读取</small><b>{observedReads.length}</b></span></div>{observedReads.length > 0 && <details><summary>实际读取文件</summary>{observedReads.map(read => <article key={read.toolCallId}><code>[{workspaceScopeLabel(read.sourceScope)}]</code><span>{read.relativePath}</span></article>)}</details>}</div>
        <div className="rav2-docs">{analysisInputDocuments.map(document => { const inputType = requirementAnalysisInputTypeForDocument(projectVersion.name, document.logicalPath ?? '', document.assetType)!; const read = Boolean(document.assetVersionId && readVersions.has(document.assetVersionId)); const active = selectedDocument?.id === document.id; const inputStatus = read ? 'Agent 已读取' : selectedRun ? 'Agent 未读取' : inputType.value === 'requirement' ? '本次重点输入' : '分析参考输入'; return <div className={`rav2-document-row ${active ? 'active' : ''}`} key={document.id}><button className="rav2-document-open" onClick={() => { setSelectedDocumentId(document.id); onOpenInputDocument?.(document) }}><span className={read ? 'read' : ''}>{read ? <CheckCircle2 /> : <Clock3 />}</span><div><b>{document.title}</b><small><i className={`rav2-document-kind ${inputType.value}`}>{inputType.label}</i> · {inputStatus} · {document.version}</small><em>{document.logicalPath}</em></div></button>{onDeleteInputDocument && <button className="rav2-document-delete" aria-label={`删除${inputType.label} ${document.title || document.name}`} title={`删除${inputType.label}`} disabled={!canDeleteInputDocument} onClick={() => onDeleteInputDocument(document)}><Trash2 /></button>}</div>})}</div>
        <footer><button className="rav2-workspace-action rav2-workspace-action-knowledge" onClick={onOpenKnowledge}><BookOpen /><span>知识库</span></button><button className="rav2-workspace-action rav2-workspace-action-versions" onClick={onManageVersions}><GitBranch /><span>版本管理</span></button><button className="rav2-workspace-action rav2-workspace-action-activity" onClick={onOpenActivity}><Clock3 /><span>操作记录</span></button></footer>
      </aside>

      <main className="rav2-session-panel">
        <header className="rav2-session-header">
          <div className="rav2-session-identity"><span><Sparkles /></span><div><b>PlanningAgent</b><small>{projectVersion.name} · 需求分析</small></div></div>
          <div className="rav2-skill-chips"><em>已启用 Skills</em>{enabledSkills.length ? enabledSkills.slice(0, 3).map(skill => <span key={skill}>{skill}</span>) : <span className="empty">未发布配置</span>}{enabledSkills.length > 3 && <span>+{enabledSkills.length - 3}</span>}</div>
          <div className="rav2-session-actions"><select aria-label="需求分析运行历史" value={selectedRunId} onChange={event => setSelectedRunId(event.target.value)} disabled={loadingRuns}><option value="">{loadingRuns ? '加载中…' : '运行历史'}</option>{runs.map(run => <option value={run.id} key={run.id}>{formatTime(run.createdAt)} · {runLabel(run)}</option>)}</select><button aria-label="刷新运行" onClick={() => void refreshRuns()}><RefreshCw /></button><button aria-label="下载分析报告" onClick={exportReport} disabled={!selectedRun?.response}><Download /></button></div>
        </header>
        <nav className="rav2-session-tabs">{viewTabs.map(tab => <button className={view === tab.key ? 'active' : ''} key={tab.key} onClick={() => setView(tab.key)}><tab.icon />{tab.label}{tab.key === 'findings' && result ? <i>{result.findings.length}</i> : null}</button>)}</nav>
        <div className={`rav2-session-body ${view === 'conversation' ? 'conversation' : 'detail'}`}>
          {view === 'conversation' && <AgentConversation run={selectedRun} onReviewed={detail => setRuns(current => replaceRunDetail(current, detail))} notify={notify} />}
          {view === 'overview' && <Overview result={result} blockerCount={blockerCount} highCount={highCount} pendingCount={pendingCount} onFindings={() => setView('findings')} onArtifacts={() => setView('artifacts')} />}
          {view === 'baseline' && <Baseline result={result} onEvidence={openEvidence} />}
          {view === 'findings' && <Findings result={result} selectedRun={selectedRun} findingStates={findingStates} findingTypeFilter={findingTypeFilter} setFindingTypeFilter={setFindingTypeFilter} severityFilter={severityFilter} setSeverityFilter={setSeverityFilter} findingStateFilter={findingStateFilter} setFindingStateFilter={setFindingStateFilter} visibleFindings={visibleFindings} pendingCount={pendingCount} documents={requirementDocuments} repairDrafts={repairDrafts} verificationBusyDraftId={verificationBusyDraftId} onEvidence={openEvidence} onState={updateFindingState} onAiFix={draftFindingFix} onStartVerification={startVerification} onViewRepairDiff={openRepairDiff} canAiFix={projectVersion.status === 'open'} />}
          {view === 'artifacts' && <Artifacts result={result} release={release} runId={selectedRun?.id} busy={releaseBusy} onGenerate={() => void generateRelease()} onPublish={() => void publishRelease()} />}
          {view === 'diff' && <Diff versions={versionHistory} value={diffVersionIds} onChange={setDiffVersionIds} loading={diffLoading} removed={removedLines} added={addedLines} />}
        </div>
        {view === 'conversation' && <footer className="rav2-session-boundary"><ShieldCheck /><span><b>受控 Planning Session</b><small>运行轨迹只读；问题处置、修复、复验与发布通过结构化门禁操作，不伪造自由对话能力。</small></span></footer>}
      </main>

      <aside className="rav2-status-panel">
        <header><span><b>当前任务 / 正式产物</b><small>{selectedRun?.id ? `Run ${selectedRun.id.replace('analysis_run_', '').slice(0, 10)}` : '尚未创建 Run'}</small></span><Badge tone={selectedRun?.status === 'succeeded' ? 'green' : selectedRun?.status === 'running' ? 'purple' : selectedRun?.status === 'failed' ? 'red' : 'gray'}>{runLabel(selectedRun)}</Badge></header>
        <div className="rav2-status-scroll">
          <section className="rav2-status-card"><header><i>①</i><b>当前业务阶段</b></header><div className="rav2-stage-list">{stages.map(stage => <article className={stage.state} key={stage.label}><span /><b>{stage.label}</b><small>{stage.detail}</small></article>)}</div></section>
          <section className="rav2-status-card"><header><i>②</i><b>正式产物</b></header><div className="rav2-formal-list"><button onClick={() => setView('artifacts')} disabled={!result}><span><b>Requirement Release</b><small>{release?.status === 'published' ? '已发布' : release?.status === 'candidate' ? '待人工发布' : '未生成'}</small></span><em className={release?.status ?? 'empty'}>{release?.status === 'published' ? '正式' : release?.status === 'candidate' ? '候选' : '—'}</em></button><button onClick={onOpenTestDesign} disabled={!onOpenTestDesign || release?.status !== 'published'}><span><b>Test Cases</b><small>{release?.status === 'published' ? '前往测试设计查看' : '等待 Requirement Release'}</small></span><em>{release?.status === 'published' ? '可进入' : '—'}</em></button><button onClick={onOpenTestDesign} disabled={!onOpenTestDesign || release?.status !== 'published'}><span><b>Execution Handoff</b><small>由正式测试设计发布后生成</small></span><em>—</em></button></div></section>
          <section className="rav2-status-card"><header><i>③</i><b>Agent Activity</b></header><div className="rav2-activity-summary"><div className="rav2-activity-state"><span className={selectedRun?.status ?? 'idle'}><Activity /></span><div><b>{selectedRun ? runLabel(selectedRun) : '等待启动'}</b><small>{latestActivity ? `${agentEventLabels[latestActivity.type] ?? latestActivity.type} · #${latestActivity.sequence}` : '尚无 Agent Activity'}</small></div></div><div className="rav2-activity-metrics"><span><small>Turn</small><b>{activityExecution?.turns ?? 0}</b></span><span><small>工具</small><b>{activityExecution?.toolCalls ?? 0}</b></span><span><small>事件</small><b>{activityEvents.length}</b></span><span><small>异常</small><b>{activityExecution?.toolErrors ?? 0}</b></span></div></div></section>
        </div>
        <footer className="rav2-status-action">
          {!selectedRun ? <button className="primary" onClick={startAnalysis} disabled={!canRun}><Play />{starting ? '启动中…' : '开始需求分析'}</button> : selectedRun.status === 'running' ? <button className="danger" onClick={cancelAnalysis}><XCircle />取消当前运行</button> : ['failed', 'cancelled'].includes(selectedRun.status) ? <button className="primary" onClick={retryAnalysis} disabled={!canRun}><RefreshCw />完整重跑</button> : release?.status === 'candidate' ? <button className="primary" onClick={() => void publishRelease()} disabled={releaseBusy}><ShieldCheck />{releaseBusy ? '发布中…' : '确认并发布 Requirement Release'}</button> : release?.status === 'published' ? <button className="primary" onClick={onOpenTestDesign} disabled={!onOpenTestDesign}><Play />进入测试设计</button> : pendingCount > 0 ? <button className="primary" onClick={() => setView('findings')}><AlertTriangle />处理 {pendingCount} 个待闭环问题</button> : <button className="primary" onClick={() => void generateRelease()} disabled={releaseBusy}><FileText />{releaseBusy ? '生成中…' : '生成 Requirement Release 候选'}</button>}
        </footer>
      </aside>
    </div>

    {sourceEvidence && <div className="rav2-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) setSourceEvidence(null) }}><section className="rav2-source-modal"><header><span><ShieldCheck /><b>固定原文证据</b></span><button onClick={() => setSourceEvidence(null)}><XCircle /></button></header><div className="rav2-evidence"><b>{sourceEvidence.clientEvidenceId} · {sourceEvidence.locator.heading}</b><p>“{sourceEvidence.quote}”</p></div><div className="rav2-source-body">{sourceLoading ? <LoaderCircle className="rotating" /> : <MarkdownDocument source={sourceContent} format="markdown" />}</div></section></div>}
    {fixFinding && <FixModal finding={fixFinding} draft={fixDraft} busy={fixBusy} assets={fixedAssets(selectedRun!)} onClose={() => { if (!fixBusy) { setFixFinding(null); setFixDraft(null) } }} onRegenerate={() => void draftFindingFix(fixFinding)} onApprove={() => void approveRepair()} />}
  </section>
}

function Overview({ result, blockerCount, highCount, pendingCount, onFindings, onArtifacts }: { result?: RequirementAnalysisResponse['result']; blockerCount: number; highCount: number; pendingCount: number; onFindings: () => void; onArtifacts: () => void }) {
  if (!result) return <div className="rav2-empty"><Sparkles /><h2>等待需求分析</h2><p>完成后得到需求基线、问题、测试关注点和可持续修复的需求资产。</p></div>
  return <div><section className="rav2-assessment"><div><Badge tone={result.summary.overallAssessment === 'blocked' ? 'red' : result.summary.overallAssessment === 'needs_revision' ? 'orange' : 'green'}>{assessmentLabel(result.summary.overallAssessment)}</Badge><h2>{result.summary.overview || '需求分析已完成'}</h2><p>{result.summary.risks[0] ?? result.summary.strengths[0] ?? '当前结果已通过服务端结构与追溯校验。'}</p></div><div className="rav2-score"><strong>{result.summary.score}</strong><span>辅助评分</span></div></section><div className="rav2-kpis"><article><GitBranch /><span>需求基线</span><strong>{result.requirementPoints.length}</strong></article><article><AlertTriangle /><span>需求问题</span><strong>{result.findings.length}</strong><small>{blockerCount} 阻断 · {highCount} 高风险</small></article><article><ListFilter /><span>未闭环</span><strong>{pendingCount}</strong></article><article><ShieldCheck /><span>Test Focus</span><strong>{result.testFocus.length}</strong></article></div><section className="rav2-top"><header><div><AlertTriangle /><b>优先处理的问题</b></div><button onClick={onFindings}>查看全部</button></header>{[...result.findings].sort((a,b) => ['blocker','high','medium','low'].indexOf(a.severity)-['blocker','high','medium','low'].indexOf(b.severity)).slice(0,5).map(f => <article key={f.clientFindingId}><Badge tone={severityTone(f.severity)}>{severityLabels[f.severity]}</Badge><span><b>{f.title}</b><small>{f.requirementPointRefs.join('、') || '整体需求问题'}</small></span></article>)}</section><section className="rav2-top"><header><div><FileText /><b>发布工作流</b></div><button onClick={onArtifacts}>查看发布门禁与产物</button></header><p>当前只是分析期候选。修复与复验闭环后，由服务端生成 requirements.json 等机器可读产物；人工正式发布后，Workflow 会给同一 PlanningAgent 追加测试设计任务。</p></section></div>
}

function Baseline({ result, onEvidence }: { result?: RequirementAnalysisResponse['result']; onEvidence: (evidence: AnalysisEvidence) => void }) {
  if (!result) return <div className="rav2-empty"><GitBranch /><h2>暂无需求基线</h2></div>
  const evidence = new Map(result.evidence.map(item => [item.clientEvidenceId, item]))
  return <div className="rav2-baseline"><header><div><GitBranch /><span><h2>Requirement Baseline</h2><p>自然语言需求为主，Evidence 可下钻到固定原文。</p></span></div><Badge tone="green">{result.requirementPoints.length}</Badge></header>{result.requirementPoints.map(point => { const linked = point.evidenceRefs.map(id => evidence.get(id)).filter((item): item is AnalysisEvidence => Boolean(item)); return <article key={point.clientRequirementPointId}><header><span className="rav2-rp">{point.clientRequirementPointId}</span><div><h3>{point.title}</h3><p>{point.description}</p></div><Badge tone={linked.length ? 'green':'orange'}>{linked.length} Evidence</Badge></header><footer>{linked.map(item => <button key={item.clientEvidenceId} onClick={() => onEvidence(item)}><Quote />{item.clientEvidenceId} · {item.locator.heading}</button>)}</footer></article>})}</div>
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
  pendingCount: number
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
    <header><div><AlertTriangle /><span><h2>需求问题</h2><p>先由人工采纳或处置问题；AI 只生成可审核的修复 Diff，应用新版本后由人工另行启动复验。</p></span></div><Badge tone={props.pendingCount > 0 ? 'orange' : 'green'}>已闭环 {result.findings.length - props.pendingCount} / {result.findings.length}</Badge></header>
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

function Artifacts({ result, release, runId, busy, onGenerate, onPublish }: { result?: RequirementAnalysisResponse['result']; release?: RequirementReleasePackage; runId?: string; busy:boolean; onGenerate:()=>void; onPublish:()=>void }) {
  if (!result) return <div className="rav2-empty"><FileText /><h2>暂无需求分析候选</h2></div>
  const machineNames = new Set(['requirements.json', 'findings.json', 'test-focus.json', 'traceability.json', 'manifest.json'])
  const refined = release?.artifacts.find(item => item.fileName === 'refined-requirements.md')?.content
  return <div className="rav2-artifacts"><header><div><FileText /><span><h2>{release?.status === 'published' ? '正式需求发布包' : release ? '待发布需求包' : '尚未生成最终产物'}</h2><p>分析期候选不等于最终产物；通过版本、Finding、复验门禁后才可生成并人工发布。</p></span></div><div>{!release?<button className="btn primary" onClick={onGenerate} disabled={busy}>{busy?'生成中…':'生成发布候选'}</button>:release.status==='candidate'?<button className="btn primary" onClick={onPublish} disabled={busy}>{busy?'发布中…':'人工确认并发布'}</button>:<Badge tone="green">已发布</Badge>}</div></header>{!release&&<div className="rav2-warning"><AlertTriangle />当前只有分析期 Baseline / Findings / Report 候选。系统不会在审核、修复、复验和人工发布之前把它们标记为最终产物。</div>}{refined&&<div className="rav2-markdown"><MarkdownDocument source={refined} format="markdown" /></div>}{release&&<><div className="rav2-artifact-list">{release.artifacts.map(artifact=><article key={artifact.fileName}><b>{artifact.fileName}</b><small>{artifact.mediaType} · {artifact.contentSha256}</small>{release.status==='published'&&runId?<a className="btn ghost" href={requirementReleaseArtifactUrl(runId,artifact.fileName)} download={artifact.fileName.split('/').at(-1)}><Download />下载</a>:null}</article>)}</div><details><summary>机器可读下游契约</summary><div className="rav2-artifact-list">{release.artifacts.filter(item=>machineNames.has(item.fileName)).map(item=><article key={item.fileName}><b>{item.fileName}</b><small>{item.fileName==='requirements.json'?'PlanningAgent 测试设计正式需求基线':'服务端生成并按 Schema 校验'} · {item.contentSha256}</small></article>)}</div></details></>}<details><summary>分析期候选（非最终产物）</summary><div className="rav2-artifact-list">{result.artifacts.map(item=><article key={item.fileName}><b>{item.fileName}</b><small>{item.contentSha256}</small></article>)}</div></details></div>
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
  const latestExecution = executionGroups.at(-1)?.execution
  const eventCount = executionGroups.reduce((total, group) => total + group.execution.events.length, 0)
  const turnCount = executionGroups.reduce((total, group) => total + group.execution.turns, 0)
  const toolCallCount = executionGroups.reduce((total, group) => total + group.execution.toolCalls, 0)
  const toolErrorCount = executionGroups.reduce((total, group) => total + (group.execution.toolErrors ?? 0), 0)
  useEffect(() => { const root = scrollRef.current; if (root) root.scrollTo({ top: root.scrollHeight, behavior: 'smooth' }) }, [eventCount])
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
        <article className="rav2-agent-task"><span><FileText /></span><div><b>需求分析任务</b><p>已提交 {run.snapshot?.currentInputRefs.length ?? run.assetVersionIds.length} 个重点输入，Workspace Snapshot 固定 {run.snapshot?.workspaceSnapshot.files.length ?? '—'} 个文件。</p><small>{run.id}</small></div></article>
        <div className="rav2-agent-metrics"><span>{turnCount} Turn</span><span>{toolCallCount} 次工具</span><span>{eventCount} 条事件</span>{toolErrorCount ? <span className="failed">{toolErrorCount} 次异常</span> : null}</div>
        <details className="rav2-runtime-details"><summary><ShieldCheck />运行上下文与只读 Reviewer</summary><PlanningContextMetrics context={latestExecution?.context} /><button className="planning-reviewer-button" disabled={reviewing || run.status === 'running'} onClick={() => void review()}><ShieldCheck />{reviewing ? 'RequirementReviewer 审阅中…' : '运行只读 RequirementReviewer'}</button><PlanningSubAgentRuns runs={run.planningSubAgentRuns} /></details>
        {executionGroups.map(group => {
          const events = group.execution.events
          const toolStarts = new Map(events.filter(event => event.type === 'tool_execution_start' && event.toolCallId).map(event => [event.toolCallId!, event]))
          const completedCalls = new Set(events.filter(event => event.type === 'tool_execution_end' && event.toolCallId).map(event => event.toolCallId))
          const visibleEvents = events.filter(event => event.type !== 'tool_execution_start' || !completedCalls.has(event.toolCallId))
          return <div key={group.id} className="rav2-execution-attempt"><article className={`rav2-run-control ${group.status === 'failed' || group.status === 'cancelled' ? 'failed' : ''}`}><Activity /><span><b>{group.label}</b><small>{group.status === 'running' ? '执行中' : group.status === 'succeeded' ? '已完成' : group.status === 'failed' ? '失败，已保留运行记录' : group.status === 'cancelled' ? '已取消，已保留运行记录' : '已保存运行记录'} · {events.length} 条事件</small></span></article>{visibleEvents.map(event => <AgentRunEvent event={event} start={event.type === 'tool_execution_end' ? toolStarts.get(event.toolCallId ?? '') : undefined} key={`${group.id}:${event.sequence}`} />)}</div>
        })}
        {!eventCount && <div className="rav2-agent-waiting"><LoaderCircle className={run.status === 'running' ? 'rotating' : ''} /><span><b>{run.status === 'running' ? '等待首个 Agent 事件' : '没有可展示的运行记录'}</b><small>{run.status === 'running' ? '消息和工具调用写入服务端后会自动同步。' : '旧运行可能只保留了结果摘要。'}</small></span></div>}
      </>}
    </div>
  </div>
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
  return <article className={`rav2-run-control ${event.isError ? 'failed' : ''}`}><Sparkles /><span><b>{agentEventLabels[event.type] ?? event.type}</b><small>#{event.sequence} · Turn {event.turn ?? 0} · {eventTime(event.occurredAt)}{event.stopReason ? ` · ${event.stopReason}` : ''}</small></span></article>
}
