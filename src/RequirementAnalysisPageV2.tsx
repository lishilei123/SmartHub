import { useEffect, useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, BookOpen, Bot, CheckCircle2, Clock3, Download, FileDiff, FileText,
  GitBranch, ListFilter, LoaderCircle, Play, Quote, RefreshCw, Send, ShieldCheck, Sparkles, Wrench, XCircle,
} from 'lucide-react'
import type { KnowledgeDocument } from './prototype-data'
import { loadAssetVersion, uploadKnowledgeFile, waitForTaskResults } from './knowledge-api'
import { MarkdownDocument } from './MarkdownDocument'
import {
  askRequirementReviewQuestion,
  cancelRequirementReviewRun,
  createFindingAction,
  downloadRequirementReviewReport,
  loadFindingActions,
  loadRequirementReviewRun,
  loadRequirementReviewRuns,
  retryRequirementReviewRun,
  startRequirementAnalysis,
  type AgentExecutionEvent,
  type FindingActionType,
  type RequirementAnalysisResponse,
  type RequirementReviewRun,
  type ReviewEvidence,
  type ReviewFinding,
  type ReviewFindingType,
  type ReviewSeverity,
} from './requirement-analysis-api'
import { requirementWorkspaceDirectory } from './version-document-path'
import { loadAgentConfiguration, type AgentConfigurationState } from './agent-configuration-api'
import { bindRequirementVersion, type ProjectVersion } from './project-version-api'
import './requirement-analysis-v2.css'

type Notify = (message: string, tone?: 'success' | 'error' | 'warning') => void
type ViewKey = 'overview' | 'baseline' | 'findings' | 'artifacts' | 'diff'
type FindingState = 'open' | 'confirmed' | 'dismissed' | 'resolved' | 'needs_follow_up'
type RunRecord = RequirementReviewRun & { content?: string }
type FixPatch = { assetVersionId: string; before: string; after: string; reason: string }
type FixDraft = { summary: string; patches: FixPatch[] }

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
const findingStateLabels: Record<FindingState, string> = { open: '待处理', confirmed: '已确认', dismissed: '已驳回', resolved: '已解决', needs_follow_up: '待复验' }
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

function parseFixDraft(raw: string, allowedAssetVersionIds: Set<string>): FixDraft {
  const cleaned = raw.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim()
  const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('AI 修复结果不是有效 JSON')
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Partial<FixDraft>
  const summary = String(parsed.summary ?? '').trim()
  if (!summary) throw new Error('AI 修复草稿缺少 summary')
  if (!Array.isArray(parsed.patches) || !parsed.patches.length || parsed.patches.length > 20) throw new Error('AI 修复草稿 patches 数量不合法')
  const patches = parsed.patches.map((item, index) => {
    const patch = item as Partial<FixPatch>
    const assetVersionId = String(patch.assetVersionId ?? '').trim()
    const before = String(patch.before ?? '')
    const after = String(patch.after ?? '')
    const reason = String(patch.reason ?? '').trim()
    if (!allowedAssetVersionIds.has(assetVersionId)) throw new Error(`Patch ${index + 1} 引用了非本次固定需求版本`)
    if (!before.trim() || !after.trim() || before === after) throw new Error(`Patch ${index + 1} 缺少有效 before/after`)
    if (!reason) throw new Error(`Patch ${index + 1} 缺少修改原因`)
    return { assetVersionId, before, after, reason }
  })
  return { summary, patches }
}

function replaceExactlyOnce(content: string, before: string, after: string) {
  const first = content.indexOf(before)
  if (first < 0) throw new Error('修复草稿中的原文片段已无法在固定版本中定位')
  if (content.indexOf(before, first + before.length) >= 0) throw new Error('修复草稿中的原文片段出现多次，无法安全自动应用')
  return `${content.slice(0, first)}${after}${content.slice(first + before.length)}`
}

function refinedRequirementsMarkdown(result: RequirementAnalysisResponse['result'], runId: string, versionName: string, findingStates: Record<string, FindingState>) {
  const unresolved = result.findings.filter(finding => {
    const state = findingStates[`${runId}:${finding.clientFindingId}`] ?? 'open'
    return state !== 'resolved' && state !== 'dismissed'
  })
  const lines = [
    `# ${versionName} 完善需求文档`, '',
    '> 本文档由当前固定需求版本经过 PI Agent 分析、人工确认与修复闭环形成。未确认内容明确保留为“待确认”，不会将历史知识自动写成当前需求事实。', '',
    '## 1. 需求概述', '', result.summary.overview || '未提供需求概述。', '',
    '## 2. 业务目标', '', ...(result.summary.businessGoals.length ? result.summary.businessGoals.map(item => `- ${item}`) : ['- 当前需求未明确独立业务目标。']), '',
    '## 3. 完整需求', '',
    ...result.requirementPoints.flatMap(point => [`### ${point.clientRequirementPointId} · ${point.title}`, '', point.description, '']),
    '## 4. 关键业务规则', '',
    ...result.requirementPoints.flatMap(point => point.businessRules.map(rule => `- ${point.clientRequirementPointId}：${rule}`)),
    ...(result.requirementPoints.some(point => point.businessRules.length) ? [] : ['- 当前结构化结果未单独拆分业务规则，请以上述完整需求自然语言为准。']), '',
    '## 5. 待确认与未闭环事项', '',
    ...(unresolved.length ? unresolved.map(finding => `- [${finding.severity}/${finding.type}] ${finding.clientFindingId} · ${finding.title}：${finding.description}；建议：${finding.recommendation}`) : ['- 无未闭环 Finding。']), '',
    '## 6. 验收与测试关注点', '',
    ...(result.testFocus.length ? result.testFocus.map(item => `- ${item.id} · ${item.title}：${item.description}`) : ['- 当前分析未形成独立 Test Focus。']), '',
    '## 7. 来源与追溯', '',
    ...result.requirementPoints.map(point => `- ${point.clientRequirementPointId} → ${point.evidenceRefs.join('、') || '无固定 Evidence'}`), '',
    `生成来源：RequirementAnalysisRun ${runId}`,
  ]
  return lines.join('\n')
}

function downloadText(fileName: string, content: string) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a'); link.href = url; link.download = fileName; link.click(); URL.revokeObjectURL(url)
}

export function RequirementAnalysisPageV2(props: Props) {
  const { projectVersion, documents, knowledgeBaseId, apiState, refreshKnowledge, notify, addAudit, onManageVersions, onOpenKnowledge, onOpenActivity } = props
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
  const [fixDraft, setFixDraft] = useState<FixDraft | null>(null)
  const [fixBusy, setFixBusy] = useState(false)
  const [savingArtifact, setSavingArtifact] = useState(false)
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
    if (!selectedRun || selectedRun.status !== 'succeeded' || !reviewQaReady) { notify('请先完成需求分析并发布评审问答 Agent。', 'warning'); return }
    const assets = fixedAssets(selectedRun); const allowed = new Set(assets.map(item => item.assetVersionId))
    const assetHint = assets.slice(0, 12).map(item => `${item.assetVersionId}|${item.logicalPath}`).join('\n').slice(0, 700)
    const question = [
      `为 Finding ${finding.clientFindingId} 生成需求文档修复草稿。只输出 JSON，不要 Markdown。`,
      `Finding：${finding.title}；问题：${finding.description}；建议：${finding.recommendation}`,
      '规则：before 必须逐字复制固定当前需求中的一个连续片段；after 是替换后的完整片段；不得把历史 Knowledge 直接当当前事实；不确定的业务决策用“待确认”明确表达；多个 patch 不得重叠。',
      `可修改固定需求资产：\n${assetHint}`,
      'JSON Schema：{"summary":"修复说明","patches":[{"assetVersionId":"...","before":"固定原文","after":"修改后原文","reason":"原因"}]}',
    ].join('\n').slice(0, 1_950)
    setFixFinding(finding); setFixDraft(null); setFixBusy(true)
    try { const answer = await askRequirementReviewQuestion(selectedRun.id, { question }); setFixDraft(parseFixDraft(answer.answer, allowed)) }
    catch (error) { notify(error instanceof Error ? error.message : 'AI 修复草稿生成失败', 'error') } finally { setFixBusy(false) }
  }

  const applyFindingFix = async () => {
    if (!fixFinding || !fixDraft || !selectedRun || !projectVersion || projectVersion.status !== 'open') return
    const assets = fixedAssets(selectedRun); const assetByVersion = new Map(assets.map(item => [item.assetVersionId, item])); const grouped = new Map<string, FixPatch[]>()
    fixDraft.patches.forEach(patch => grouped.set(patch.assetVersionId, [...(grouped.get(patch.assetVersionId) ?? []), patch]))
    setFixBusy(true)
    try {
      const applied: Array<{ assetVersionId: string; newVersionId: string; logicalPath: string }> = []
      for (const [assetVersionId, patches] of grouped) {
        const asset = assetByVersion.get(assetVersionId); if (!asset) throw new Error('修复目标不属于本次固定输入')
        const source = await loadAssetVersion(assetVersionId); let content = source.content
        for (const patch of patches) content = replaceExactlyOnce(content, patch.before, patch.after)
        const uploaded = await uploadKnowledgeFile(knowledgeBaseId, new File([content], asset.displayName, { type: asset.displayName.toLowerCase().endsWith('.txt') ? 'text/plain' : 'text/markdown' }), asset.logicalPath, 'requirement')
        if (uploaded.task?.id) {
          const completed = await waitForTaskResults([uploaded.task.id])
          if (completed.failed.length || completed.cancelled.length || completed.pending.length) throw new Error('修复后的需求文档入库未完成')
        }
        await bindRequirementVersion(projectVersion.id, uploaded.version.id)
        applied.push({ assetVersionId, newVersionId: uploaded.version.id, logicalPath: asset.logicalPath })
      }
      await refreshKnowledge()
      const key = `${selectedRun.id}:${fixFinding.clientFindingId}`; const state = findingStates[key] ?? 'open'
      if (state !== 'needs_follow_up') {
        const saved = await createFindingAction(selectedRun.id, fixFinding.clientFindingId, { action: 'request_follow_up', comment: `AI 修复已应用到 ${applied.length} 份需求文档的新版本，待重新需求分析验证。`, expectedVersion: findingVersions[key] ?? 0 })
        setFindingStates(values => ({ ...values, [key]: saved.toState })); setFindingVersions(values => ({ ...values, [key]: saved.version }))
      }
      addAudit(`AI 修复 ${fixFinding.clientFindingId}：${applied.map(item => `${item.logicalPath} → ${item.newVersionId}`).join('；')}`)
      setFixFinding(null); setFixDraft(null); setView('diff'); notify('AI 修复已应用到新的需求文档版本。Finding 已进入待复验，请重新运行需求分析验证。')
    } catch (error) { notify(error instanceof Error ? error.message : 'AI 修复应用失败', 'error') } finally { setFixBusy(false) }
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
  const pendingVerification = result?.findings.some(item => selectedRun && (findingStates[`${selectedRun.id}:${item.clientFindingId}`] ?? 'open') === 'needs_follow_up') ?? false
  const refinedMarkdown = result && selectedRun && projectVersion ? refinedRequirementsMarkdown(result, selectedRun.id, projectVersion.name, findingStates) : ''
  const saveRefinedArtifact = async () => {
    if (!refinedMarkdown || !projectVersion || !selectedRun) return
    if (pendingVerification) { notify('存在刚应用但尚未重新分析验证的修复，请先重新分析后再沉淀最终需求文档。', 'warning'); return }
    const artifactDirectory = workspaceDirectoryPath.replace(/\/input\/requirements$/u, '/artifacts/requirements'); const logicalPath = `${artifactDirectory}/refined-requirements.md`
    setSavingArtifact(true)
    try {
      const uploaded = await uploadKnowledgeFile(knowledgeBaseId, new File([refinedMarkdown], 'refined-requirements.md', { type: 'text/markdown' }), logicalPath, 'requirement_analysis_artifact')
      if (uploaded.task?.id) { const completed = await waitForTaskResults([uploaded.task.id]); if (completed.failed.length || completed.cancelled.length || completed.pending.length) throw new Error('完善需求文档 Artifact 入库未完成') }
      await refreshKnowledge(); addAudit(`沉淀完善需求文档：${logicalPath} · ${uploaded.version.id}`); notify('完善需求文档已沉淀到当前版本 Knowledge/Workspace。')
    } catch (error) { notify(error instanceof Error ? error.message : '完善需求文档沉淀失败', 'error') } finally { setSavingArtifact(false) }
  }

  const versionHistory = (selectedDocument?.versions ?? []).filter(item => item.status === 'ready')
  const leftLines = (diffContents[diffVersionIds[0]] ?? '').split(/\r?\n/).filter(Boolean); const rightLines = (diffContents[diffVersionIds[1]] ?? '').split(/\r?\n/).filter(Boolean)
  const removedLines = leftLines.filter(line => !rightLines.includes(line)); const addedLines = rightLines.filter(line => !leftLines.includes(line))

  if (!projectVersion) return <section className="card rav2-gate"><GitBranch /><h1>新建项目版本后才能进行需求分析</h1><button className="btn primary" onClick={onManageVersions}>新建项目版本</button></section>

  return <section className="card rav2-page">
    <header className="rav2-header">
      <div className="rav2-title"><span><Sparkles /></span><div><h1>Pi Agent 需求分析 · {projectVersion.name}</h1><p>发现问题 → AI 修复 → Diff → 新需求版本 → 重新分析验证 → 沉淀完善需求文档。</p></div></div>
      <div className="rav2-run-info"><Badge tone={selectedRun?.status === 'succeeded' ? 'green' : selectedRun?.status === 'running' ? 'purple' : selectedRun?.status === 'failed' ? 'red' : 'gray'}>{runLabel(selectedRun)}</Badge><span><small>Run</small><b>{selectedRun?.id?.replace('review_run_', '').slice(0, 10) ?? '-'}</b></span><span><small>已读 / 候选</small><b>{readVersions.size} / {selectedRun?.assetVersionIds?.length ?? requirementDocuments.length}</b></span></div>
      <div className="rav2-actions"><select value={selectedRunId} onChange={event => setSelectedRunId(event.target.value)} disabled={loadingRuns}><option value="">{loadingRuns ? '加载中…' : '运行历史'}</option>{runs.map(run => <option value={run.id} key={run.id}>{formatTime(run.createdAt)} · {runLabel(run)}</option>)}</select><button className="btn ghost" onClick={() => void refreshRuns()}><RefreshCw />刷新</button><button className="btn ghost" onClick={exportReport} disabled={!selectedRun?.response}><Download />分析报告</button>{selectedRun?.status === 'running' ? <button className="btn danger" onClick={cancelAnalysis}><XCircle />取消</button> : selectedRun && ['failed', 'cancelled'].includes(selectedRun.status) ? <button className="btn primary" onClick={retryAnalysis} disabled={!canRun}><RefreshCw />完整重跑</button> : <button className="btn primary" onClick={startAnalysis} disabled={!canRun}><Play />{starting ? '启动中…' : selectedRun ? '重新分析' : '开始分析'}</button>}</div>
    </header>
    <div className="rav2-layout">
      <aside className="rav2-workspace"><header><span><FileText /><b>需求 Workspace</b></span><Badge tone="blue">{requirementDocuments.length}</Badge></header><div className="rav2-path">/{workspaceDirectoryPath}</div><div className="rav2-docs">{requirementDocuments.map(document => { const read = Boolean(document.assetVersionId && readVersions.has(document.assetVersionId)); return <button className={selectedDocument?.id === document.id ? 'active' : ''} key={document.id} onClick={() => setSelectedDocumentId(document.id)}><span className={read ? 'read' : ''}>{read ? <CheckCircle2 /> : <Clock3 />}</span><div><b>{document.title}</b><small>{read ? 'Agent 已读取' : selectedRun ? 'Agent 未读取' : '候选输入'} · {document.version}</small><em>{document.logicalPath}</em></div></button>})}</div><footer><button onClick={onOpenKnowledge}><BookOpen />知识库</button><button onClick={onManageVersions}><GitBranch />版本管理</button><button onClick={onOpenActivity}><Clock3 />操作记录</button></footer></aside>
      <main className="rav2-main"><nav className="rav2-tabs">{viewTabs.map(tab => <button className={view === tab.key ? 'active' : ''} key={tab.key} onClick={() => setView(tab.key)}><tab.icon />{tab.label}{tab.key === 'findings' && result ? <i>{result.findings.length}</i> : null}</button>)}</nav>{selectedRun?.status === 'running' && <div className="rav2-running"><LoaderCircle className="rotating" /><span><b>RequirementAnalysisAgent 正在分析并自检</b><small>同一 Session 读取 Workspace、查询 Knowledge、生成 Baseline / Finding / Test Focus。</small></span></div>}<div className="rav2-content">
        {view === 'overview' && <Overview result={result} blockerCount={blockerCount} highCount={highCount} pendingCount={pendingCount} onFindings={() => setView('findings')} onArtifacts={() => setView('artifacts')} />}
        {view === 'baseline' && <Baseline result={result} onEvidence={openEvidence} />}
        {view === 'findings' && <Findings result={result} selectedRun={selectedRun} findingStates={findingStates} findingTypeFilter={findingTypeFilter} setFindingTypeFilter={setFindingTypeFilter} severityFilter={severityFilter} setSeverityFilter={setSeverityFilter} findingStateFilter={findingStateFilter} setFindingStateFilter={setFindingStateFilter} visibleFindings={visibleFindings} onEvidence={openEvidence} onState={updateFindingState} onAiFix={draftFindingFix} canAiFix={reviewQaReady && projectVersion.status === 'open'} />}
        {view === 'artifacts' && <Artifacts result={result} refinedMarkdown={refinedMarkdown} pendingVerification={pendingVerification} saving={savingArtifact} onSave={() => void saveRefinedArtifact()} />}
        {view === 'diff' && <Diff versions={versionHistory} value={diffVersionIds} onChange={setDiffVersionIds} loading={diffLoading} removed={removedLines} added={addedLines} />}
      </div></main>
      <aside className="rav2-agent"><header><span><Bot /><b>Pi Agent Trace</b></span><Badge tone={selectedRun?.status === 'running' ? 'purple' : selectedRun?.status === 'succeeded' ? 'green' : 'gray'}>{selectedRun?.status === 'running' ? '运行中' : selectedRun?.status === 'succeeded' ? '已完成' : '待运行'}</Badge></header><AgentTrace run={selectedRun} /></aside>
    </div>
    {sourceEvidence && <div className="rav2-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) setSourceEvidence(null) }}><section className="rav2-source-modal"><header><span><ShieldCheck /><b>固定原文证据</b></span><button onClick={() => setSourceEvidence(null)}><XCircle /></button></header><div className="rav2-evidence"><b>{sourceEvidence.clientEvidenceId} · {sourceEvidence.locator.heading}</b><p>“{sourceEvidence.quote}”</p></div><div className="rav2-source-body">{sourceLoading ? <LoaderCircle className="rotating" /> : <MarkdownDocument source={sourceContent} format="markdown" />}</div></section></div>}
    {fixFinding && <FixModal finding={fixFinding} draft={fixDraft} busy={fixBusy} assets={fixedAssets(selectedRun!)} onClose={() => { if (!fixBusy) { setFixFinding(null); setFixDraft(null) } }} onRegenerate={() => void draftFindingFix(fixFinding)} onApply={() => void applyFindingFix()} />}
  </section>
}

function Overview({ result, blockerCount, highCount, pendingCount, onFindings, onArtifacts }: { result?: RequirementAnalysisResponse['result']; blockerCount: number; highCount: number; pendingCount: number; onFindings: () => void; onArtifacts: () => void }) {
  if (!result) return <div className="rav2-empty"><Sparkles /><h2>等待需求分析</h2><p>完成后得到需求基线、问题、测试关注点和可持续修复的需求资产。</p></div>
  return <div><section className="rav2-assessment"><div><Badge tone={result.summary.overallAssessment === 'blocked' ? 'red' : result.summary.overallAssessment === 'needs_revision' ? 'orange' : 'green'}>{assessmentLabel(result.summary.overallAssessment)}</Badge><h2>{result.summary.overview || '需求分析已完成'}</h2><p>{result.summary.risks[0] ?? result.summary.strengths[0] ?? '当前结果已通过服务端结构与追溯校验。'}</p></div><div className="rav2-score"><strong>{result.summary.score}</strong><span>辅助评分</span></div></section><div className="rav2-kpis"><article><GitBranch /><span>需求基线</span><strong>{result.requirementPoints.length}</strong></article><article><AlertTriangle /><span>需求问题</span><strong>{result.findings.length}</strong><small>{blockerCount} 阻断 · {highCount} 高风险</small></article><article><ListFilter /><span>未闭环</span><strong>{pendingCount}</strong></article><article><ShieldCheck /><span>Test Focus</span><strong>{result.testFocus.length}</strong></article></div><section className="rav2-top"><header><div><AlertTriangle /><b>优先处理的问题</b></div><button onClick={onFindings}>查看全部</button></header>{[...result.findings].sort((a,b) => ['blocker','high','medium','low'].indexOf(a.severity)-['blocker','high','medium','low'].indexOf(b.severity)).slice(0,5).map(f => <article key={f.clientFindingId}><Badge tone={severityTone(f.severity)}>{severityLabels[f.severity]}</Badge><span><b>{f.title}</b><small>{f.requirementPointRefs.join('、') || '整体需求问题'}</small></span></article>)}</section><section className="rav2-top"><header><div><FileText /><b>最终产物</b></div><button onClick={onArtifacts}>查看完善需求文档</button></header><p>完成 Finding 修复并重新分析验证后，将完善需求文档沉淀到当前版本 Workspace，作为后续测试设计的首要输入。</p></section></div>
}

function Baseline({ result, onEvidence }: { result?: RequirementAnalysisResponse['result']; onEvidence: (evidence: ReviewEvidence) => void }) {
  if (!result) return <div className="rav2-empty"><GitBranch /><h2>暂无需求基线</h2></div>
  const evidence = new Map(result.evidence.map(item => [item.clientEvidenceId, item]))
  return <div className="rav2-baseline"><header><div><GitBranch /><span><h2>Requirement Baseline</h2><p>自然语言需求为主，Evidence 可下钻到固定原文。</p></span></div><Badge tone="green">{result.requirementPoints.length}</Badge></header>{result.requirementPoints.map(point => { const linked = point.evidenceRefs.map(id => evidence.get(id)).filter((item): item is ReviewEvidence => Boolean(item)); return <article key={point.clientRequirementPointId}><header><span className="rav2-rp">{point.clientRequirementPointId}</span><div><h3>{point.title}</h3><p>{point.description}</p></div><Badge tone={linked.length ? 'green':'orange'}>{linked.length} Evidence</Badge></header><footer>{linked.map(item => <button key={item.clientEvidenceId} onClick={() => onEvidence(item)}><Quote />{item.clientEvidenceId} · {item.locator.heading}</button>)}</footer></article>})}</div>
}

function Findings(props: { result?: RequirementAnalysisResponse['result']; selectedRun?: RunRecord; findingStates: Record<string, FindingState>; findingTypeFilter: 'all'|ReviewFindingType; setFindingTypeFilter:(v:'all'|ReviewFindingType)=>void; severityFilter:'all'|ReviewSeverity; setSeverityFilter:(v:'all'|ReviewSeverity)=>void; findingStateFilter:'all'|FindingState; setFindingStateFilter:(v:'all'|FindingState)=>void; visibleFindings:ReviewFinding[]; onEvidence:(e:ReviewEvidence)=>void; onState:(f:ReviewFinding,s:FindingState)=>void; onAiFix:(f:ReviewFinding)=>void; canAiFix:boolean }) {
  const { result, selectedRun, findingStates, visibleFindings } = props; if (!result) return <div className="rav2-empty"><AlertTriangle /><h2>暂无需求问题</h2></div>
  return <div className="rav2-findings"><header><div><AlertTriangle /><span><h2>需求问题</h2><p>AI 修复只生成 Patch 草稿；应用前必须在 Diff 中人工确认。</p></span></div><Badge tone="orange">{visibleFindings.length} / {result.findings.length}</Badge></header><div className="rav2-filters"><select value={props.findingTypeFilter} onChange={e=>props.setFindingTypeFilter(e.target.value as 'all'|ReviewFindingType)}><option value="all">全部类型</option>{Object.entries(findingTypeLabels).map(([v,l])=><option value={v} key={v}>{l}</option>)}</select><select value={props.severityFilter} onChange={e=>props.setSeverityFilter(e.target.value as 'all'|ReviewSeverity)}><option value="all">全部严重度</option>{Object.entries(severityLabels).map(([v,l])=><option value={v} key={v}>{l}</option>)}</select><select value={props.findingStateFilter} onChange={e=>props.setFindingStateFilter(e.target.value as 'all'|FindingState)}><option value="all">全部状态</option>{Object.entries(findingStateLabels).map(([v,l])=><option value={v} key={v}>{l}</option>)}</select></div>{visibleFindings.map(finding => { const state = selectedRun ? findingStates[`${selectedRun.id}:${finding.clientFindingId}`] ?? 'open':'open'; const evidence=evidenceForFinding(finding,result); return <article className="rav2-finding" key={finding.clientFindingId}><header><div><Badge tone={severityTone(finding.severity)}>{severityLabels[finding.severity]}</Badge><span><small>{findingTypeLabels[finding.type]} · {finding.clientFindingId}</small><h3>{finding.title}</h3></span></div><Badge tone={state==='resolved'?'green':state==='dismissed'?'gray':state==='needs_follow_up'?'blue':'orange'}>{findingStateLabels[state]}</Badge></header><div className="rav2-refs">{finding.requirementPointRefs.length?finding.requirementPointRefs.map(ref=><span key={ref}>{ref}</span>):<span className="global">🌐 整体需求问题</span>}</div><p>{finding.description}</p><dl><div><dt>影响</dt><dd>{finding.impact}</dd></div><div><dt>建议</dt><dd>{finding.recommendation}</dd></div></dl><footer><span>{evidence.length} 条证据 · 置信度 {Math.round(finding.confidence*100)}%</span><div>{evidence.slice(0,1).map(item=><button key={item.clientEvidenceId} onClick={()=>props.onEvidence(item)}><BookOpen />原文</button>)}{!['resolved','dismissed'].includes(state)&&<button className="ai" onClick={()=>props.onAiFix(finding)} disabled={!props.canAiFix}><Sparkles />AI 修复</button>}<select value={state} onChange={e=>props.onState(finding,e.target.value as FindingState)}>{Object.entries(findingStateLabels).map(([v,l])=><option value={v} key={v}>{l}</option>)}</select></div></footer></article>})}</div>
}

function Artifacts({ result, refinedMarkdown, pendingVerification, saving, onSave }: { result?: RequirementAnalysisResponse['result']; refinedMarkdown:string; pendingVerification:boolean; saving:boolean; onSave:()=>void }) {
  if (!result) return <div className="rav2-empty"><FileText /><h2>暂无最终产物</h2></div>
  const analysis = result.artifacts.find(item=>item.fileName==='requirement-analysis.md'); const baseline=result.artifacts.find(item=>item.fileName==='requirement-baseline.md'); const review=result.artifacts.find(item=>item.fileName==='requirement-review.md')
  return <div className="rav2-artifacts"><header><div><FileText /><span><h2>完善需求文档</h2><p>最终首要产物。刚应用 AI 修复时必须先重新分析验证，再沉淀。</p></span></div><div><button className="btn ghost" onClick={()=>downloadText('refined-requirements.md',refinedMarkdown)}><Download />下载</button><button className="btn primary" onClick={onSave} disabled={saving||pendingVerification}>{saving?'沉淀中…':pendingVerification?'待复验':'沉淀到 Workspace'}</button></div></header>{pendingVerification&&<div className="rav2-warning"><AlertTriangle />存在 AI 修复后的待复验 Finding，当前完善需求文档不是最终版本。请先重新运行需求分析。</div>}<div className="rav2-markdown"><MarkdownDocument source={refinedMarkdown} format="markdown" /></div><details><summary>其他需求分析产物</summary><div className="rav2-artifact-list"><article><b>Requirement Baseline</b><small>{baseline?.fileName} · {baseline?.contentSha256}</small></article><article><b>Requirement Review</b><small>{review?.fileName} · {review?.contentSha256}</small></article><article><b>Requirement Analysis Report</b><small>{analysis?.fileName} · {analysis?.contentSha256}</small></article></div></details></div>
}

function Diff({ versions,value,onChange,loading,removed,added }:{ versions:NonNullable<KnowledgeDocument['versions']>; value:[string,string]; onChange:(v:[string,string])=>void; loading:boolean; removed:string[]; added:string[] }) {
  if (versions.length<2) return <div className="rav2-empty"><FileDiff /><h2>暂无可比较版本</h2><p>AI 修复应用后会产生新的需求 AssetVersion。</p></div>
  return <div className="rav2-diff"><header><div><span>基准版本</span><select value={value[0]} onChange={e=>onChange([e.target.value,value[1]])}>{versions.map(v=><option value={v.id} key={v.id}>V{v.number}</option>)}</select></div><div><span>目标版本</span><select value={value[1]} onChange={e=>onChange([value[0],e.target.value])}>{versions.map(v=><option value={v.id} key={v.id}>V{v.number}</option>)}</select></div></header>{loading?<div className="rav2-empty"><LoaderCircle className="rotating" /></div>:<div className="rav2-diff-grid"><section><h3>删除 <span>{removed.length}</span></h3>{removed.map((line,i)=><p className="removed" key={`${i}-${line}`}>− {line}</p>)}</section><section><h3>新增 <span>{added.length}</span></h3>{added.map((line,i)=><p className="added" key={`${i}-${line}`}>+ {line}</p>)}</section></div>}</div>
}

function FixModal({ finding,draft,busy,assets,onClose,onRegenerate,onApply }:{ finding:ReviewFinding; draft:FixDraft|null; busy:boolean; assets:Array<{assetVersionId:string;logicalPath:string;displayName:string}>; onClose:()=>void; onRegenerate:()=>void; onApply:()=>void }) {
  const assetByVersion=new Map(assets.map(a=>[a.assetVersionId,a])); return <div className="rav2-backdrop" onMouseDown={e=>{if(e.currentTarget===e.target)onClose()}}><section className="rav2-fix-modal"><header><div><Sparkles /><span><b>AI 修复 · {finding.clientFindingId}</b><small>{finding.title}</small></span></div><button onClick={onClose} disabled={busy}><XCircle /></button></header>{busy&&!draft?<div className="rav2-empty"><LoaderCircle className="rotating" /><h2>AI 正在生成修复 Patch</h2></div>:draft?<><div className="rav2-fix-summary"><Wrench /><span><b>修复说明</b><p>{draft.summary}</p></span></div><div className="rav2-patches">{draft.patches.map((patch,index)=><article key={`${patch.assetVersionId}-${index}`}><header><b>Patch {index+1} · {assetByVersion.get(patch.assetVersionId)?.displayName??patch.assetVersionId}</b><small>{assetByVersion.get(patch.assetVersionId)?.logicalPath}</small></header><p>{patch.reason}</p><div className="rav2-patch-diff"><section><h4>修改前</h4><pre>{patch.before}</pre></section><section><h4>修改后</h4><pre>{patch.after}</pre></section></div></article>)}</div><footer><button className="btn ghost" onClick={onRegenerate} disabled={busy}><RefreshCw />重新生成</button><button className="btn primary" onClick={onApply} disabled={busy}>{busy?<LoaderCircle className="rotating" />:<CheckCircle2 />}应用修改并生成新版本</button></footer></>:<div className="rav2-empty"><AlertTriangle /><h2>未生成有效修复草稿</h2><button className="btn primary" onClick={onRegenerate}>重新生成</button></div>}</section></div>
}

function AgentTrace({ run }:{run?:RunRecord}) { if(!run)return <div className="rav2-agent-empty"><Bot /><b>等待启动 Pi Agent</b></div>; const execution=run.response?.executions?.requirementAnalysis??run.executions?.requirementAnalysis??(run.execution?.agentKey==='requirement-analysis'?run.execution:undefined); const events=execution?.events??[]; const visible=events.filter(e=>['message_end','tool_execution_start','tool_execution_end','result_submission_required','result_submission_retry'].includes(e.type)); return <div className="rav2-trace"><div className="rav2-agent-summary"><Activity /><span><b>RequirementAnalysisAgent</b><small>{execution?.turns??0} Turn · {execution?.toolCalls??0} 工具调用</small></span></div>{visible.slice(-60).map(e=><TraceEvent event={e} key={e.sequence}/>)}</div> }
function TraceEvent({event}:{event:AgentExecutionEvent}) { if(event.type==='message_end')return <article className="rav2-trace-message"><b>{event.role==='user'?'任务输入':event.model??'Agent'}</b>{event.content&&<p>{event.content.length>360?`${event.content.slice(0,360)}…`:event.content}</p>}</article>; if(event.type==='tool_execution_start'||event.type==='tool_execution_end'){const label=event.toolId?.includes('read')?'读取文件':event.toolId?.includes('knowledge')?'查询 Knowledge':event.toolId?.includes('submit')?'提交结果':event.toolId??'工具调用';return <article className="rav2-trace-tool"><Activity /><span><b>{label}</b><small>{event.toolId} · Turn {event.turn??0}</small></span><Badge tone={event.type==='tool_execution_start'?'orange':event.isError?'red':'green'}>{event.type==='tool_execution_start'?'执行中':event.isError?'失败':'完成'}</Badge></article>} return <article className="rav2-trace-control"><Sparkles />{event.type}</article> }
