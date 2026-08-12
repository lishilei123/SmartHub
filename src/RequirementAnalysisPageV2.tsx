import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, AlertTriangle, BookOpen, Bot, CheckCircle2, Clock3, Download, FileDiff, FileText,
  FolderOpen, GitBranch, ListFilter, LoaderCircle, Play, Quote, RefreshCw, ShieldCheck, Sparkles, Trash2, Wrench, XCircle,
} from 'lucide-react'
import type { KnowledgeDocument } from './prototype-data'
import { loadAssetVersion, waitForTaskResults } from './knowledge-api'
import { MarkdownDocument } from './MarkdownDocument'
import {
  cancelRequirementReviewRun,
  createRequirementReleaseCandidate,
  createFindingAction,
  generateRequirementRepairDraft,
  approveRequirementRepairDraft,
  applyRequirementRepairDraft,
  finalizeRequirementRepairDraft,
  downloadRequirementReviewReport,
  loadFindingActions,
  loadRequirementReviewRun,
  loadRequirementReviewRuns,
  retryRequirementReviewRun,
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
  type RequirementReviewRun,
  type ReviewEvidence,
  type ReviewFinding,
  type ReviewFindingType,
  type ReviewSeverity,
} from './requirement-analysis-api'
import { requirementWorkspaceDirectory } from './version-document-path'
import { loadAgentConfiguration, type AgentConfigurationState } from './agent-configuration-api'
import type { ProjectVersion } from './project-version-api'
import './requirement-analysis-v2.css'
import './requirement-analysis-review-flow.css'

type Notify = (message: string, tone?: 'success' | 'error' | 'warning') => void
type ViewKey = 'overview' | 'baseline' | 'findings' | 'artifacts' | 'diff'
type FindingState = 'open' | 'confirmed' | 'dismissed' | 'resolved' | 'needs_follow_up'
type RunRecord = RequirementReviewRun & { content?: string }

type Props = {
  projectVersion: ProjectVersion | null
  documents: KnowledgeDocument[]
  knowledgeBaseId: string
  apiState: 'connecting' | 'ready' | 'offline'
  refreshKnowledge: () => Promise<void>
  onManageVersions: () => void
  onOpenKnowledge: () => void
  onOpenActivity: () => void
  onOpenRequirementDocument?: (document: KnowledgeDocument) => void
  onDeleteRequirementDocument?: (document: KnowledgeDocument) => void
  canDeleteRequirementDocument?: boolean
  notify: Notify
  addAudit: (entry: string) => void
}

const findingTypeLabels: Record<ReviewFindingType, string> = {
  missing_requirement: '需求缺口', ambiguity: '需求歧义', conflict: '逻辑冲突', boundary_gap: '边界条件',
  state_gap: '状态缺口', exception_gap: '异常场景', security_risk: '安全风险', testability_gap: '可测试性',
  dependency_risk: '依赖风险', other: '其他问题',
}
const severityLabels: Record<ReviewSeverity, string> = { blocker: '阻断', high: '高', medium: '中', low: '低' }
const findingStateLabels: Record<FindingState, string> = { open: '待人工审核', confirmed: '已采纳', dismissed: '不采纳', resolved: '已解决', needs_follow_up: '暂缓 / 待复验' }
const viewTabs: Array<{ key: ViewKey; label: string; icon: typeof Sparkles }> = [
  { key: 'overview', label: '分析概览', icon: Sparkles },
  { key: 'baseline', label: '需求基线', icon: GitBranch },
  { key: 'findings', label: '需求问题', icon: AlertTriangle },
  { key: 'artifacts', label: '最终产物', icon: FileText },
  { key: 'diff', label: '版本差异', icon: FileDiff },
]

function Badge({ children, tone = 'gray' }: { children: React.ReactNode; tone?: string }) { return <span className={`rav2-badge ${tone}`}>{children}</span> }
function formatTime(value: string) { return new Date(value).toLocaleString('zh-CN', { hour12: false }) }
function severityTone(value: ReviewSeverity) { return value === 'blocker' ? 'red' : value === 'high' ? 'orange' : value === 'medium' ? 'gold' : 'blue' }
function assessmentLabel(value?: string) { return value === 'blocked' ? '存在阻断问题' : value === 'needs_revision' ? '建议修改后确认' : value === 'pass_with_notes' ? '附带关注项通过' : value === 'pass' ? '可以进入下一阶段' : '等待分析' }
function runLabel(run?: RunRecord) { return run?.status === 'running' ? '分析中' : run?.status === 'succeeded' ? '已完成' : run?.status === 'failed' ? '失败' : run?.status === 'cancelled' ? '已取消' : '未运行' }
const agentEventLabels: Record<string, string> = {
  runtime_initialized: 'Runtime 已初始化', agent_start: 'Agent 已启动', agent_end: 'Agent 已结束', turn_start: 'Turn 开始', turn_end: 'Turn 结束',
  message_start: '消息开始', message_end: '消息完成', tool_execution_start: '工具调用开始', tool_execution_end: '工具调用结束',
  input_package_built: '输入包已构建', input_batch_delivered: '输入批次已投递', input_final_merge_started: '开始合并输入',
  result_submission_required: '等待提交正式结果', result_submission_retry: '结果校验未通过，等待修正', evidence_repair_tools_enabled: '证据修复工具已启用',
  skill_catalog_loaded: '已加载当前 Stage Skill Catalog', skill_activated: 'Agent 已按需激活 Skill',
}
function eventTime(value: string) { return new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) }
function formatTraceValue(value: unknown) { if (value === undefined) return ''; try { return JSON.stringify(value, null, 2) } catch { return String(value) } }
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

function fixedAssets(run: RunRecord) {
  return run.snapshot?.assets ?? run.documents ?? []
}

function repairDraftForFinding(drafts: RequirementRepairDraft[], findingId: string) {
  return [...drafts].reverse().find(draft => draft.candidate?.patches.some(patch => patch.findingRefs.includes(findingId)))
}

function assetVersionLabel(versionId: string, documents: KnowledgeDocument[]) {
  const version = documents.flatMap(document => document.versions ?? []).find(candidate => candidate.id === versionId)
  return version ? `V${version.number}` : versionId
}

export function RequirementAnalysisPageV2(props: Props) {
  const { projectVersion, documents, apiState, refreshKnowledge, notify, addAudit, onManageVersions, onOpenKnowledge, onOpenActivity, onOpenRequirementDocument, onDeleteRequirementDocument, canDeleteRequirementDocument = false } = props
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
  const [fixFinding, setFixFinding] = useState<ReviewFinding | null>(null)
  const [fixDraft, setFixDraft] = useState<RequirementRepairDraft | null>(null)
  const [fixBusy, setFixBusy] = useState(false)
  const [verificationBusyDraftId, setVerificationBusyDraftId] = useState('')
  const [releaseBusy, setReleaseBusy] = useState(false)
  const [diffVersionIds, setDiffVersionIds] = useState<[string, string]>(['', ''])
  const [diffContents, setDiffContents] = useState<Record<string, string>>({})
  const [diffLoading, setDiffLoading] = useState(false)
  const requestedRepairDiff = useRef<{ assetId: string; versionIds: [string, string] } | null>(null)

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
    let cancelled = false; let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const detail = await loadRequirementReviewRun(selectedRun.id)
        if (cancelled) return
        setRuns(current => current.map(item => item.id === detail.id ? { ...item, ...detail } : item))
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
      setRuns(current => [started, ...current.filter(item => item.id !== started.id)]); setSelectedRunId(started.id); setView('overview')
      addAudit(`启动 RequirementAnalysisAgent：${started.id}`); notify('需求分析已启动。')
    } catch (error) { notify(error instanceof Error ? error.message : '需求分析启动失败', 'error') } finally { setStarting(false) }
  }
  const cancelAnalysis = async () => {
    if (!selectedRun || selectedRun.status !== 'running') return
    try { const cancelled = await cancelRequirementReviewRun(selectedRun.id); setRuns(current => current.map(item => item.id === cancelled.id ? cancelled : item)); notify('已取消本次需求分析。', 'warning') }
    catch (error) { notify(error instanceof Error ? error.message : '取消失败', 'error') }
  }
  const retryAnalysis = async () => {
    if (!selectedRun || selectedRun.status === 'running') return
    setStarting(true)
    try { const started = await retryRequirementReviewRun(selectedRun.id); setRuns(current => [started, ...current.filter(item => item.id !== started.id)]); setSelectedRunId(started.id); setView('overview'); notify('已创建新的完整需求分析运行。') }
    catch (error) { notify(error instanceof Error ? error.message : '重跑失败', 'error') } finally { setStarting(false) }
  }
  const exportReport = async () => {
    if (!projectVersion || !selectedRun?.response) return
    try { const blob = await downloadRequirementReviewReport(projectVersion.id, selectedRun.id); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${projectVersion.name}-需求分析报告.md`; link.click(); URL.revokeObjectURL(url) }
    catch (error) { notify(error instanceof Error ? error.message : '报告导出失败', 'error') }
  }
  const openEvidence = async (evidence: ReviewEvidence) => {
    setSourceEvidence(evidence); setSourceContent(''); setSourceLoading(true)
    try { setSourceContent((await loadAssetVersion(evidence.sourceRef.assetVersionId)).content) }
    catch (error) { notify(error instanceof Error ? error.message : '原文读取失败', 'error'); setSourceEvidence(null) } finally { setSourceLoading(false) }
  }
  const updateFindingState = async (finding: ReviewFinding, next: FindingState) => {
    if (!selectedRun || projectVersion?.status !== 'open') return
    const key = `${selectedRun.id}:${finding.clientFindingId}`; const current = findingStates[key] ?? 'open'; if (current === next) return
    const actionByState: Record<FindingState, FindingActionType> = { open: 'reopen', confirmed: 'confirm', dismissed: 'dismiss', resolved: 'resolve', needs_follow_up: 'request_follow_up' }
    const needsComment = next === 'dismissed' || next === 'needs_follow_up' || next === 'open'
    const comment = needsComment ? window.prompt(`请填写“${findingStateLabels[next]}”的处置说明：`)?.trim() : undefined
    if (needsComment && !comment) return
    try { const saved = await createFindingAction(selectedRun.id, finding.clientFindingId, { action: actionByState[next], comment, expectedVersion: findingVersions[key] ?? 0 }); setFindingStates(values => ({ ...values, [key]: saved.toState })); setFindingVersions(values => ({ ...values, [key]: saved.version })) }
    catch (error) { notify(error instanceof Error ? error.message : 'Finding 状态保存失败', 'error') }
  }

  const draftFindingFix = async (finding: ReviewFinding) => {
    if (!selectedRun || selectedRun.status !== 'succeeded') { notify('请先完成需求分析。', 'warning'); return }
    const state = findingStates[`${selectedRun.id}:${finding.clientFindingId}`] ?? 'open'
    if (state !== 'confirmed') { notify('先将 Finding 人工确认，再进入受控修复 Stage。', 'warning'); return }
    setFixFinding(finding); setFixDraft(null); setFixBusy(true)
    try { setFixDraft(await generateRequirementRepairDraft(selectedRun.id, [finding.clientFindingId])) }
    catch (error) { notify(error instanceof Error ? error.message : 'AI 修复草稿生成失败', 'error') } finally { setFixBusy(false) }
  }

  const applyRepair = async (draft: RequirementRepairDraft, finding: ReviewFinding) => {
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
    const [detail, actions] = await Promise.all([loadRequirementReviewRun(selectedRun.id), loadFindingActions(selectedRun.id)])
    setRuns(current => current.map(item => item.id === detail.id ? { ...item, ...detail } : item))
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
      setView('overview')
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
      addAudit(`正式发布需求包：${published.id} · ${published.contentSha256}`); notify('需求发布包已正式发布且不可变；TestDesignAgent 将读取 requirements.json。')
    } catch (error) { notify(error instanceof Error ? error.message : '需求发布失败', 'error') } finally { setReleaseBusy(false) }
  }

  const versionHistory = (selectedDocument?.versions ?? []).filter(item => item.status === 'ready')
  const leftLines = (diffContents[diffVersionIds[0]] ?? '').split(/\r?\n/).filter(Boolean); const rightLines = (diffContents[diffVersionIds[1]] ?? '').split(/\r?\n/).filter(Boolean)
  const removedLines = leftLines.filter(line => !rightLines.includes(line)); const addedLines = rightLines.filter(line => !leftLines.includes(line))

  if (!projectVersion) return <section className="card rav2-gate"><GitBranch /><h1>新建项目版本后才能进行需求分析</h1><button className="btn primary" onClick={onManageVersions}>新建项目版本</button></section>

  return <section className="card rav2-page">
    <header className="rav2-header">
      <div className="rav2-title"><span><Sparkles /></span><div><h1>需求分析 · {projectVersion.name}</h1><p>AI 分析 → 人工采纳问题 → AI 修复建议 → 人工采纳修复 → 新版本 → 人工启动复验 → AI 复验 → 人工发布。</p></div></div>
      <div className="rav2-run-info"><Badge tone={selectedRun?.status === 'succeeded' ? 'green' : selectedRun?.status === 'running' ? 'purple' : selectedRun?.status === 'failed' ? 'red' : 'gray'}>{runLabel(selectedRun)}</Badge><span><small>Run</small><b>{selectedRun?.id?.replace('review_run_', '').slice(0, 10) ?? '-'}</b></span><span><small>已读 / 候选</small><b>{readVersions.size} / {selectedRun?.assetVersionIds?.length ?? requirementDocuments.length}</b></span></div>
      <div className="rav2-actions"><select value={selectedRunId} onChange={event => setSelectedRunId(event.target.value)} disabled={loadingRuns}><option value="">{loadingRuns ? '加载中…' : '运行历史'}</option>{runs.map(run => <option value={run.id} key={run.id}>{formatTime(run.createdAt)} · {runLabel(run)}</option>)}</select><button className="btn ghost" onClick={() => void refreshRuns()}><RefreshCw />刷新</button><button className="btn ghost" onClick={exportReport} disabled={!selectedRun?.response}><Download />分析报告</button>{selectedRun?.status === 'running' ? <button className="btn danger" onClick={cancelAnalysis}><XCircle />取消</button> : selectedRun && ['failed', 'cancelled'].includes(selectedRun.status) ? <button className="btn primary" onClick={retryAnalysis} disabled={!canRun}><RefreshCw />完整重跑</button> : <button className="btn primary" onClick={startAnalysis} disabled={!canRun}><Play />{starting ? '启动中…' : selectedRun ? '重新分析' : '开始分析'}</button>}</div>
    </header>
    <div className="rav2-layout">
      <aside className="rav2-workspace"><header><span><FolderOpen /><b>需求 Workspace</b></span><Badge tone="blue">{requirementDocuments.length}</Badge></header><div className="rav2-docs">{requirementDocuments.map(document => { const read = Boolean(document.assetVersionId && readVersions.has(document.assetVersionId)); const active = selectedDocument?.id === document.id; return <div className={`rav2-document-row ${active ? 'active' : ''}`} key={document.id}><button className="rav2-document-open" onClick={() => { setSelectedDocumentId(document.id); onOpenRequirementDocument?.(document) }}><span className={read ? 'read' : ''}>{read ? <CheckCircle2 /> : <Clock3 />}</span><div><b>{document.title}</b><small>{read ? 'Agent 已读取' : selectedRun ? 'Agent 未读取' : '候选输入'} · {document.version}</small><em>{document.logicalPath}</em></div></button>{onDeleteRequirementDocument && <button className="rav2-document-delete" aria-label={`删除需求文档 ${document.title || document.name}`} title="删除需求文档" disabled={!canDeleteRequirementDocument} onClick={() => onDeleteRequirementDocument(document)}><Trash2 /></button>}</div>})}</div><footer><button className="rav2-workspace-action rav2-workspace-action-knowledge" onClick={onOpenKnowledge}><BookOpen /><span>知识库</span></button><button className="rav2-workspace-action rav2-workspace-action-versions" onClick={onManageVersions}><GitBranch /><span>版本管理</span></button><button className="rav2-workspace-action rav2-workspace-action-activity" onClick={onOpenActivity}><Clock3 /><span>操作记录</span></button></footer></aside>
      <main className="rav2-main"><nav className="rav2-tabs">{viewTabs.map(tab => <button className={view === tab.key ? 'active' : ''} key={tab.key} onClick={() => setView(tab.key)}><tab.icon />{tab.label}{tab.key === 'findings' && result ? <i>{result.findings.length}</i> : null}</button>)}</nav>{selectedRun?.status === 'running' && <div className="rav2-running"><LoaderCircle className="rotating" /><span><b>RequirementAnalysisAgent 正在分析并自检</b><small>同一 Session 读取 Workspace、查询 Knowledge、生成 Baseline / Finding / Test Focus。</small></span></div>}<div className="rav2-content">
        {view === 'overview' && <Overview result={result} blockerCount={blockerCount} highCount={highCount} pendingCount={pendingCount} onFindings={() => setView('findings')} onArtifacts={() => setView('artifacts')} />}
        {view === 'baseline' && <Baseline result={result} onEvidence={openEvidence} />}
        {view === 'findings' && <Findings result={result} selectedRun={selectedRun} findingStates={findingStates} findingTypeFilter={findingTypeFilter} setFindingTypeFilter={setFindingTypeFilter} severityFilter={severityFilter} setSeverityFilter={setSeverityFilter} findingStateFilter={findingStateFilter} setFindingStateFilter={setFindingStateFilter} visibleFindings={visibleFindings} documents={requirementDocuments} repairDrafts={selectedRun?.workflow?.repairDrafts ?? []} verificationBusyDraftId={verificationBusyDraftId} onEvidence={openEvidence} onState={updateFindingState} onAiFix={draftFindingFix} onStartVerification={startVerification} onViewRepairDiff={openRepairDiff} canAiFix={projectVersion.status === 'open'} />}
        {view === 'artifacts' && <Artifacts result={result} release={release} runId={selectedRun?.id} busy={releaseBusy} onGenerate={() => void generateRelease()} onPublish={() => void publishRelease()} />}
        {view === 'diff' && <Diff versions={versionHistory} value={diffVersionIds} onChange={setDiffVersionIds} loading={diffLoading} removed={removedLines} added={addedLines} />}
      </div></main>
      <aside className="rav2-agent"><header><span><Bot /><b>Pi Agent</b></span><Badge tone={selectedRun?.status === 'running' ? 'purple' : selectedRun?.status === 'succeeded' ? 'green' : 'gray'}>{selectedRun?.status === 'running' ? '运行中' : selectedRun?.status === 'succeeded' ? '已完成' : '待运行'}</Badge></header><AgentConversation run={selectedRun} /></aside>
    </div>
    {sourceEvidence && <div className="rav2-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) setSourceEvidence(null) }}><section className="rav2-source-modal"><header><span><ShieldCheck /><b>固定原文证据</b></span><button onClick={() => setSourceEvidence(null)}><XCircle /></button></header><div className="rav2-evidence"><b>{sourceEvidence.clientEvidenceId} · {sourceEvidence.locator.heading}</b><p>“{sourceEvidence.quote}”</p></div><div className="rav2-source-body">{sourceLoading ? <LoaderCircle className="rotating" /> : <MarkdownDocument source={sourceContent} format="markdown" />}</div></section></div>}
    {fixFinding && <FixModal finding={fixFinding} draft={fixDraft} busy={fixBusy} assets={fixedAssets(selectedRun!)} onClose={() => { if (!fixBusy) { setFixFinding(null); setFixDraft(null) } }} onRegenerate={() => void draftFindingFix(fixFinding)} onApprove={() => void approveRepair()} />}
  </section>
}

function Overview({ result, blockerCount, highCount, pendingCount, onFindings, onArtifacts }: { result?: RequirementAnalysisResponse['result']; blockerCount: number; highCount: number; pendingCount: number; onFindings: () => void; onArtifacts: () => void }) {
  if (!result) return <div className="rav2-empty"><Sparkles /><h2>等待需求分析</h2><p>完成后得到需求基线、问题、测试关注点和可持续修复的需求资产。</p></div>
  return <div><section className="rav2-assessment"><div><Badge tone={result.summary.overallAssessment === 'blocked' ? 'red' : result.summary.overallAssessment === 'needs_revision' ? 'orange' : 'green'}>{assessmentLabel(result.summary.overallAssessment)}</Badge><h2>{result.summary.overview || '需求分析已完成'}</h2><p>{result.summary.risks[0] ?? result.summary.strengths[0] ?? '当前结果已通过服务端结构与追溯校验。'}</p></div><div className="rav2-score"><strong>{result.summary.score}</strong><span>辅助评分</span></div></section><div className="rav2-kpis"><article><GitBranch /><span>需求基线</span><strong>{result.requirementPoints.length}</strong></article><article><AlertTriangle /><span>需求问题</span><strong>{result.findings.length}</strong><small>{blockerCount} 阻断 · {highCount} 高风险</small></article><article><ListFilter /><span>未闭环</span><strong>{pendingCount}</strong></article><article><ShieldCheck /><span>Test Focus</span><strong>{result.testFocus.length}</strong></article></div><section className="rav2-top"><header><div><AlertTriangle /><b>优先处理的问题</b></div><button onClick={onFindings}>查看全部</button></header>{[...result.findings].sort((a,b) => ['blocker','high','medium','low'].indexOf(a.severity)-['blocker','high','medium','low'].indexOf(b.severity)).slice(0,5).map(f => <article key={f.clientFindingId}><Badge tone={severityTone(f.severity)}>{severityLabels[f.severity]}</Badge><span><b>{f.title}</b><small>{f.requirementPointRefs.join('、') || '整体需求问题'}</small></span></article>)}</section><section className="rav2-top"><header><div><FileText /><b>发布工作流</b></div><button onClick={onArtifacts}>查看发布门禁与产物</button></header><p>当前只是分析期候选。修复与复验闭环后，由服务端生成 requirements.json 等机器可读产物，再经人工正式发布供 TestDesignAgent 使用。</p></section></div>
}

function Baseline({ result, onEvidence }: { result?: RequirementAnalysisResponse['result']; onEvidence: (evidence: ReviewEvidence) => void }) {
  if (!result) return <div className="rav2-empty"><GitBranch /><h2>暂无需求基线</h2></div>
  const evidence = new Map(result.evidence.map(item => [item.clientEvidenceId, item]))
  return <div className="rav2-baseline"><header><div><GitBranch /><span><h2>Requirement Baseline</h2><p>自然语言需求为主，Evidence 可下钻到固定原文。</p></span></div><Badge tone="green">{result.requirementPoints.length}</Badge></header>{result.requirementPoints.map(point => { const linked = point.evidenceRefs.map(id => evidence.get(id)).filter((item): item is ReviewEvidence => Boolean(item)); return <article key={point.clientRequirementPointId}><header><span className="rav2-rp">{point.clientRequirementPointId}</span><div><h3>{point.title}</h3><p>{point.description}</p></div><Badge tone={linked.length ? 'green':'orange'}>{linked.length} Evidence</Badge></header><footer>{linked.map(item => <button key={item.clientEvidenceId} onClick={() => onEvidence(item)}><Quote />{item.clientEvidenceId} · {item.locator.heading}</button>)}</footer></article>})}</div>
}

function Findings(props: {
  result?: RequirementAnalysisResponse['result']
  selectedRun?: RunRecord
  findingStates: Record<string, FindingState>
  findingTypeFilter: 'all' | ReviewFindingType
  setFindingTypeFilter: (value: 'all' | ReviewFindingType) => void
  severityFilter: 'all' | ReviewSeverity
  setSeverityFilter: (value: 'all' | ReviewSeverity) => void
  findingStateFilter: 'all' | FindingState
  setFindingStateFilter: (value: 'all' | FindingState) => void
  visibleFindings: ReviewFinding[]
  documents: KnowledgeDocument[]
  repairDrafts: RequirementRepairDraft[]
  verificationBusyDraftId: string
  onEvidence: (evidence: ReviewEvidence) => void
  onState: (finding: ReviewFinding, state: FindingState) => void
  onAiFix: (finding: ReviewFinding) => void
  onStartVerification: (draft: RequirementRepairDraft) => void
  onViewRepairDiff: (draft: RequirementRepairDraft) => void
  canAiFix: boolean
}) {
  const { result, selectedRun, findingStates, visibleFindings } = props
  if (!result) return <div className="rav2-empty"><AlertTriangle /><h2>暂无需求问题</h2></div>
  return <div className="rav2-findings">
    <header><div><AlertTriangle /><span><h2>需求问题</h2><p>先由人工采纳或处置问题；AI 只生成可审核的修复 Diff，应用新版本后由人工另行启动复验。</p></span></div><Badge tone="orange">{visibleFindings.length} / {result.findings.length}</Badge></header>
    <div className="rav2-filters">
      <select value={props.findingTypeFilter} onChange={event => props.setFindingTypeFilter(event.target.value as 'all' | ReviewFindingType)}><option value="all">全部类型</option>{Object.entries(findingTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
      <select value={props.severityFilter} onChange={event => props.setSeverityFilter(event.target.value as 'all' | ReviewSeverity)}><option value="all">全部严重度</option>{Object.entries(severityLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
      <select value={props.findingStateFilter} onChange={event => props.setFindingStateFilter(event.target.value as 'all' | FindingState)}><option value="all">全部状态</option>{Object.entries(findingStateLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
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
  return <div className="rav2-artifacts"><header><div><FileText /><span><h2>{release?.status === 'published' ? '正式需求发布包' : release ? '待发布需求包' : '尚未生成最终产物'}</h2><p>分析期候选不等于最终产物；通过版本、Finding、复验门禁后才可生成并人工发布。</p></span></div><div>{!release?<button className="btn primary" onClick={onGenerate} disabled={busy}>{busy?'生成中…':'生成发布候选'}</button>:release.status==='candidate'?<button className="btn primary" onClick={onPublish} disabled={busy}>{busy?'发布中…':'人工确认并发布'}</button>:<Badge tone="green">已发布</Badge>}</div></header>{!release&&<div className="rav2-warning"><AlertTriangle />当前只有分析期 Baseline / Review / Report 候选。系统不会在审核、修复、复验和人工发布之前把它们标记为最终产物。</div>}{refined&&<div className="rav2-markdown"><MarkdownDocument source={refined} format="markdown" /></div>}{release&&<><div className="rav2-artifact-list">{release.artifacts.map(artifact=><article key={artifact.fileName}><b>{artifact.fileName}</b><small>{artifact.mediaType} · {artifact.contentSha256}</small>{release.status==='published'&&runId?<a className="btn ghost" href={requirementReleaseArtifactUrl(runId,artifact.fileName)} download={artifact.fileName.split('/').at(-1)}><Download />下载</a>:null}</article>)}</div><details><summary>机器可读下游契约</summary><div className="rav2-artifact-list">{release.artifacts.filter(item=>machineNames.has(item.fileName)).map(item=><article key={item.fileName}><b>{item.fileName}</b><small>{item.fileName==='requirements.json'?'TestDesignAgent 主需求输入':'服务端生成并按 Schema 校验'} · {item.contentSha256}</small></article>)}</div></details></>}<details><summary>分析期候选（非最终产物）</summary><div className="rav2-artifact-list">{result.artifacts.map(item=><article key={item.fileName}><b>{item.fileName}</b><small>{item.contentSha256}</small></article>)}</div></details></div>
}

function Diff({ versions,value,onChange,loading,removed,added }:{ versions:NonNullable<KnowledgeDocument['versions']>; value:[string,string]; onChange:(v:[string,string])=>void; loading:boolean; removed:string[]; added:string[] }) {
  if (versions.length<2) return <div className="rav2-empty"><FileDiff /><h2>暂无可比较版本</h2><p>AI 修复应用后会产生新的需求 AssetVersion。</p></div>
  return <div className="rav2-diff"><header><div><span>基准版本</span><select value={value[0]} onChange={e=>onChange([e.target.value,value[1]])}>{versions.map(v=><option value={v.id} key={v.id}>V{v.number}</option>)}</select></div><div><span>目标版本</span><select value={value[1]} onChange={e=>onChange([value[0],e.target.value])}>{versions.map(v=><option value={v.id} key={v.id}>V{v.number}</option>)}</select></div></header>{loading?<div className="rav2-empty"><LoaderCircle className="rotating" /></div>:<div className="rav2-diff-grid"><section><h3>删除 <span>{removed.length}</span></h3>{removed.map((line,i)=><p className="removed" key={`${i}-${line}`}>− {line}</p>)}</section><section><h3>新增 <span>{added.length}</span></h3>{added.map((line,i)=><p className="added" key={`${i}-${line}`}>+ {line}</p>)}</section></div>}</div>
}

function FixModal({ finding, draft, busy, assets, onClose, onRegenerate, onApprove }: { finding: ReviewFinding; draft: RequirementRepairDraft | null; busy: boolean; assets: Array<{ assetVersionId: string; logicalPath: string; displayName: string }>; onClose: () => void; onRegenerate: () => void; onApprove: () => void }) {
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

function AgentConversation({ run }: { run?: RunRecord }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const executions = [run?.response?.executions?.requirementAnalysis, run?.executions?.requirementAnalysis, run?.execution?.agentKey === 'requirement-analysis' ? run.execution : undefined].filter((item): item is AgentExecutionRecord => Boolean(item))
  const execution = executions.sort((left, right) => left.events.length - right.events.length).at(-1)
  const events = execution?.events ?? []
  const toolStarts = new Map(events.filter(event => event.type === 'tool_execution_start' && event.toolCallId).map(event => [event.toolCallId!, event]))
  const completedCalls = new Set(events.filter(event => event.type === 'tool_execution_end' && event.toolCallId).map(event => event.toolCallId))
  const visibleEvents = events.filter(event => event.type !== 'tool_execution_start' || !completedCalls.has(event.toolCallId))
  useEffect(() => { const root = scrollRef.current; if (root) root.scrollTo({ top: root.scrollHeight, behavior: 'smooth' }) }, [events.length])

  return <div className="rav2-conversation">
    <div className="rav2-conversation-scroll" ref={scrollRef}>
      {!run ? <div className="rav2-agent-empty"><span className="rav2-agent-empty-icon"><Bot /></span><div><b>等待启动 Pi Agent</b><p>开始需求分析后，这里会同步展示任务输入、Agent 消息、工具调用与运行状态。</p></div><ul className="rav2-agent-empty-preview"><li><FileText />任务输入与分析进度</li><li><Wrench />工具调用与执行结果</li><li><Sparkles />关键状态与最终产物</li></ul></div> : <>
        <article className="rav2-agent-task"><span><Bot /></span><div><b>RequirementAnalysisAgent</b><p>需求输入：{run.snapshot?.documentWorkspace?.logicalPath ?? run.logicalPath ?? '固定需求工作区'}</p><small>{run.id}</small></div></article>
        <div className="rav2-agent-metrics"><span>{execution?.turns ?? 0} Turn</span><span>{execution?.toolCalls ?? 0} 次工具</span><span>{events.length} 条事件</span>{execution?.toolErrors ? <span className="failed">{execution.toolErrors} 次异常</span> : null}</div>
        {visibleEvents.map(event => <AgentRunEvent event={event} start={event.type === 'tool_execution_end' ? toolStarts.get(event.toolCallId ?? '') : undefined} key={event.sequence} />)}
        {!events.length && <div className="rav2-agent-waiting"><LoaderCircle className={run.status === 'running' ? 'rotating' : ''} /><span><b>{run.status === 'running' ? '等待首个 Agent 事件' : '没有可展示的运行记录'}</b><small>{run.status === 'running' ? '消息和工具调用写入服务端后会自动同步。' : '旧运行可能只保留了结果摘要。'}</small></span></div>}
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
