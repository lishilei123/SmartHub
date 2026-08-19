import { forwardRef, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import {
  Activity, AlertTriangle, ArrowDown, ArrowUp, BookOpen, Bot, BrainCircuit, Check, CheckCircle2, ChevronDown,
  ChevronRight, CircleHelp, Clock3, Code2, Columns2, Database, Download, FileText,
  FolderOpen, FolderPlus, GitBranch, LayoutDashboard, Library, ListChecks, MessageSquareText, MoreHorizontal,
  PanelLeftClose, PanelLeftOpen, Pencil, Play, Plus, RefreshCw, Search, Server, Settings, ShieldCheck, Sparkles,
  TestTube2, Trash2, Upload, Users, XCircle, Zap,
} from 'lucide-react'
import {
  initialSettings, type KnowledgeDirectory, type KnowledgeDocument,
  type EmbeddingSourceDraft, type GenerativeModelDraft, type GenerativeSourceDraft, type SettingsDraft,
} from './prototype-data'
import { cancelTask, createKnowledgeDirectory, deleteKnowledgeAsset, deleteKnowledgeDirectory, discoverGenerativeModels, ensureKnowledgeBase, loadAssetVersion, loadConfig, loadGenerativeModelSources, loadKnowledgeAssets, loadKnowledgeDocument, loadKnowledgeOverview, loadLocalModelStatuses, loadTasks, probeGenerativeModel, rebuildIndex, renameKnowledgeDirectory, retryTask, saveConfig, saveGenerativeModelSources, searchKnowledge, startLocalModel, stopLocalModel, testEmbeddingConfig, updateKnowledgeAsset, uploadKnowledgeArchive, uploadKnowledgeFile, type ApiIndexSummary, type ApiSearchMeta, type ApiSearchResult, type LocalModelStatus } from './knowledge-api'
import { MarkdownDocument } from './MarkdownDocument'
import { getActiveDocumentSectionKey, getClosestSourceLineIndex } from './document-scroll'
import { emptyMarkdownOutline, parseMarkdownOutline, type MarkdownOutline } from './markdown-outline'
import { createProjectVersion, deleteProjectVersion, loadProjectVersions, updateProjectVersionStatus, type ProjectVersion, type ProjectVersionStatus } from './project-version-api'
import { loadAgentConfiguration, materializeRequiredAgentCapabilities, publishAgentConfiguration, saveAgentConfigurationDraft, type AgentConfigurationAgentDraft, type AgentConfigurationAgentKey, type AgentConfigurationState, type AgentRoutingConfiguration } from './agent-configuration-api'
import { createAiResource, deleteAiResource, loadAiResources, loadToolSource, updateAiResource, uploadSkillPackage, type AiResource, type AiResourceCatalog, type AiResourceKind, type McpServerResource, type SkillPackageMetadata, type SkillResource, type ToolResource, type ToolSource } from './ai-resource-api'
import { buildWorkspaceKnowledgeTree, type WorkspaceKnowledgeDirectory } from './workspace-knowledge-tree'
import { loadPlanningAgentProfile, type PlanningAgentProfile } from './planning-api'
import './planning.css'

const PlanningPage = lazy(() => import('./PlanningPage').then(module => ({ default: module.PlanningPage })))
const TestExecutionPage = lazy(() => import('./test-execution/TestExecutionPage').then(module => ({ default: module.TestExecutionPage })))
const TestReportPage = lazy(() => import('./test-report/TestReportPage').then(module => ({ default: module.TestReportPage })))

type PageKey = 'dashboard' | 'planning' | 'documents' | 'execution' | 'reports' | 'settings'
type PlanningTab = 'requirements' | 'test-design' | 'workflow'
type NotifyTone = 'success' | 'error' | 'warning'
type Notify = (message: string, tone?: NotifyTone) => void
type JobStatus = 'idle' | 'running' | 'completed' | 'cancelled' | 'failed'
type SearchLocation = { assetId: string; assetVersionId: string; startLine: number; endLine: number; nonce: number }
const agentConfigurationMetadata: Record<AgentConfigurationAgentKey, { label: string; identifier: string; sceneLabel: string; protocolLabel: string; publishTarget: string; runtimeToolIds: string[]; exactCapabilities: boolean }> = {
  planning: { label: 'PlanningAgent', identifier: 'PlanningAgent', sceneLabel: '测试策划', protocolLabel: 'Planning + Project Workspace v1', publishTarget: '新的需求分析与测试设计任务', runtimeToolIds: ['workspace.list_directory', 'workspace.find_files', 'workspace.grep_files', 'workspace.read_file', 'knowledge.search', 'knowledge.read_chunk', 'requirement-analysis.submit_result', 'requirement-release.submit_result', 'test_design_points.submit_result', 'test_design_cases.submit_result', 'test_design_repair.submit_result'], exactCapabilities: false },
  testScript: { label: '测试脚本 Agent', identifier: 'TestScriptAgent', sceneLabel: '测试执行', protocolLabel: '测试脚本生成 v1', publishTarget: '新测试执行运行', runtimeToolIds: ['workspace.list_directory', 'workspace.find_files', 'workspace.grep_files', 'workspace.read_file', 'test_script.submit_result'], exactCapabilities: true },
  failureAnalysis: { label: '失败分析 Agent', identifier: 'FailureAnalysisAgent', sceneLabel: '测试执行', protocolLabel: '失败分析 v1', publishTarget: '新测试执行诊断', runtimeToolIds: ['workspace.list_directory', 'workspace.find_files', 'workspace.grep_files', 'workspace.read_file', 'failure_analysis.submit_result'], exactCapabilities: true },
  scriptRepair: { label: '脚本修复 Agent', identifier: 'ScriptRepairAgent', sceneLabel: '测试执行', protocolLabel: '脚本修复 v1', publishTarget: '新测试执行修复', runtimeToolIds: ['workspace.list_directory', 'workspace.find_files', 'workspace.grep_files', 'workspace.read_file', 'script_repair.submit_result'], exactCapabilities: true },
}
const agentConfigurationGroups: Array<{ label: string; agentKeys: AgentConfigurationAgentKey[] }> = [
  { label: '测试策划', agentKeys: ['planning'] },
  { label: '测试执行', agentKeys: ['testScript', 'failureAnalysis', 'scriptRepair'] },
]
const retrievalModeLabel = (mode: string) => mode === 'hybrid' ? '混合检索' : mode === 'vector' ? '向量检索' : '关键词检索'

const projectVersionStorageKey = 'smarthub-project-version-id'
const pageKeys: PageKey[] = ['dashboard', 'planning', 'documents', 'execution', 'reports', 'settings']
const routedPage = (value: string | null): PageKey => value === 'requirement-analysis' || value === 'test-design' ? 'planning' : pageKeys.includes(value as PageKey) ? value as PageKey : 'dashboard'
const legacyPlanningTab = (value: string | null): PlanningTab | undefined => value === 'requirement-analysis' ? 'requirements' : value === 'test-design' ? 'test-design' : undefined
const restorePage = (): PageKey => {
  if (typeof window === 'undefined') return 'dashboard'
  return routedPage(new URL(window.location.href).searchParams.get('page'))
}
const restoreProjectVersion = () => {
  if (typeof window === 'undefined') return ''
  return new URL(window.location.href).searchParams.get('projectVersionId') ?? window.localStorage.getItem(projectVersionStorageKey) ?? ''
}

const menu: { key: PageKey; label: string; icon: typeof LayoutDashboard; hint?: string }[] = [
  { key: 'dashboard', label: '工作台', icon: LayoutDashboard },
  { key: 'planning', label: '测试策划', icon: Sparkles },
  { key: 'execution', label: '测试执行', icon: Play },
  { key: 'reports', label: '报告与诊断', icon: Activity },
]

const pageMeta: Record<PageKey, { title: string; desc: string }> = {
  dashboard: { title: '工作台', desc: '掌握项目质量状态与 AI 任务进展' },
  planning: { title: '测试策划', desc: 'PlanningAgent 串联需求理解、自动测试设计、Coverage Audit 与正式发布交接' },
  documents: { title: '知识库', desc: '管理项目文档、技术方案与知识资产' },
  execution: { title: '测试执行', desc: '基于不可变 Handoff、独立执行 Agents 与 OCI Playwright Runner 的正式执行工作台' },
  reports: { title: '报告与诊断', desc: '基于 PostgreSQL 正式执行事实的确定性单 Run 报告、失败诊断与完整追溯' },
  settings: { title: '系统管理', desc: '配置模型、集成、权限与平台策略' },
}

function Badge({ children, tone = 'gray' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>
}

function Progress({ value, tone = 'blue' }: { value: number; tone?: string }) {
  return <div className="progress" aria-label={`进度 ${value}%`}><span className={tone} style={{ width: `${value}%` }} /></div>
}

function Modal({ title, onClose, children, className = '' }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') closeRef.current() }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previousFocus.current?.focus()
    }
  }, [])
  return <div className={`modal-backdrop ${className}`} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={dialogRef} tabIndex={-1}>
      <header><h2 id="modal-title">{title}</h2><button className="icon-btn" onClick={onClose} aria-label={`关闭${title}`}><XCircle /></button></header>
      {children}
    </div>
  </div>
}

function App() {
  const [page, setPage] = useState<PageKey>(restorePage)
  const [projectVersions, setProjectVersions] = useState<ProjectVersion[]>([])
  const [selectedProjectVersionId, setSelectedProjectVersionId] = useState(restoreProjectVersion)
  const [versionManagerOpen, setVersionManagerOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [toast, setToast] = useState<{ id: number; message: string; tone: NotifyTone } | null>(null)
  const [knowledgeDirectoryList, setKnowledgeDirectoryList] = useState<KnowledgeDirectory[]>([])
  const [knowledgeDocumentList, setKnowledgeDocumentList] = useState<KnowledgeDocument[]>([])
  const [activityOpen, setActivityOpen] = useState(false)
  const [audit, setAudit] = useState<string[]>(['已打开当前会话的 SmartHub 本地原型'])
  const [knowledgeBaseId, setKnowledgeBaseId] = useState('')
  const [knowledgeApiState, setKnowledgeApiState] = useState<'connecting' | 'ready' | 'offline'>('connecting')
  const toastTimer = useRef<number | undefined>(undefined)

  const notify = useCallback<Notify>((message, tone = 'success') => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    const next = { id: Date.now(), message, tone }
    setToast(next)
    toastTimer.current = window.setTimeout(() => setToast(current => current?.id === next.id ? null : current), 2600)
  }, [])

  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current) }, [])
  const updateRoute = useCallback((next: { page?: PageKey; projectVersionId?: string; planningTab?: PlanningTab; resetAnalysisContext?: boolean }, mode: 'push' | 'replace' = 'push') => {
    const url = new URL(window.location.href)
    if (next.page) url.searchParams.set('page', next.page)
    if (next.projectVersionId) url.searchParams.set('projectVersionId', next.projectVersionId)
    else if (next.projectVersionId === '') url.searchParams.delete('projectVersionId')
    if (next.resetAnalysisContext) ['analysisId', 'runId', 'view', 'findingId', 'evidenceId', 'testDesignId', 'workflowRunId', 'executionRunId', 'executionTaskId', 'executionMaintenanceProposalId', 'testDesignEntry', 'libraryCaseId', 'reportRunId', 'tab', 'assetView', 'planningTab'].forEach(key => url.searchParams.delete(key))
    if (next.planningTab) url.searchParams.set('planningTab', next.planningTab)
    window.history[mode === 'push' ? 'pushState' : 'replaceState']({}, '', url)
  }, [])
  const navigate = useCallback((nextPage: PageKey, planningTab?: PlanningTab) => {
    const pageChanged = nextPage !== page
    setPage(nextPage)
    updateRoute({ page: nextPage, ...(pageChanged ? { resetAnalysisContext: true } : {}), ...(planningTab ? { planningTab } : {}) })
  }, [page, updateRoute])
  const selectProjectVersion = useCallback((id: string) => { setSelectedProjectVersionId(id); updateRoute({ projectVersionId: id, resetAnalysisContext: true }) }, [updateRoute])
  useEffect(() => {
    const restore = () => {
      const url = new URL(window.location.href)
      const requestedPage = url.searchParams.get('page')
      setPage(routedPage(requestedPage))
      const planningTab = legacyPlanningTab(requestedPage)
      if (planningTab) {
        url.searchParams.set('page', 'planning')
        url.searchParams.set('planningTab', planningTab)
        window.history.replaceState({}, '', url)
      }
      setSelectedProjectVersionId(url.searchParams.get('projectVersionId') ?? '')
    }
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [])
  useEffect(() => {
    const url = new URL(window.location.href)
    const requestedPage = url.searchParams.get('page')
    const planningTab = legacyPlanningTab(requestedPage)
    if (!planningTab) return
    url.searchParams.set('page', 'planning')
    url.searchParams.set('planningTab', planningTab)
    window.history.replaceState({}, '', url)
  }, [])
  const activeProjectVersion = projectVersions.find(item => item.id === selectedProjectVersionId) ?? null
  const workspaceKnowledgeTree = useMemo(() => buildWorkspaceKnowledgeTree({
    directories: knowledgeDirectoryList,
    documents: knowledgeDocumentList,
    versionNames: projectVersions.map(version => version.name),
  }), [knowledgeDirectoryList, knowledgeDocumentList, projectVersions])
  const refreshProjectVersions = useCallback(async () => {
    const versions = await loadProjectVersions()
    setProjectVersions(versions)
    setSelectedProjectVersionId(current => versions.some(item => item.id === current) ? current : versions[0]?.id ?? '')
    return versions
  }, [])
  const refreshKnowledge = useCallback(async (includeDeleted = false, id = knowledgeBaseId) => {
    if (!id) return
    const data = await loadKnowledgeAssets(id, includeDeleted)
    setKnowledgeDirectoryList(data.directories)
    setKnowledgeDocumentList(current => {
      const hydrated = new Map(current.filter(document => document.content !== undefined).map(document => [`${document.id}:${document.assetVersionId}`, document]))
      return data.documents.map(document => {
        const cached = hydrated.get(`${document.id}:${document.assetVersionId}`)
        return cached ? { ...document, content: cached.content, title: cached.title, intro: cached.intro, sections: cached.sections } : document
      })
    })
    setKnowledgeApiState('ready')
  }, [knowledgeBaseId])
  const hydrateDocument = useCallback(async (document: KnowledgeDocument) => {
    const loaded = await loadKnowledgeDocument(document)
    setKnowledgeDocumentList(current => current.map(item => item.id === loaded.id && item.assetVersionId === loaded.assetVersionId ? loaded : item))
    return loaded
  }, [])
  useEffect(() => {
    let cancelled = false
    let retryTimer: number | undefined
    const connect = async () => {
      setKnowledgeApiState('connecting')
      try {
        const id = await ensureKnowledgeBase()
        if (cancelled) return
        setKnowledgeBaseId(id)
        await Promise.all([
          refreshKnowledge(false, id),
          refreshProjectVersions(),
        ])
      } catch {
        if (cancelled) return
        setKnowledgeApiState('offline')
        retryTimer = window.setTimeout(() => void connect(), 2000)
      }
    }
    void connect()
    return () => { cancelled = true; if (retryTimer) window.clearTimeout(retryTimer) }
  }, [])
  useEffect(() => {
    if (selectedProjectVersionId) window.localStorage.setItem(projectVersionStorageKey, selectedProjectVersionId)
    else window.localStorage.removeItem(projectVersionStorageKey)
  }, [selectedProjectVersionId])
  const meta = pageMeta[page]

  return <div className={`app-shell ${sidebarCollapsed ? 'shell-collapsed' : ''}`}>
    <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
      <div className="brand"><div className="brand-mark"><Zap size={19} fill="currentColor" /></div><div><b>SmartHub</b><span>AI TESTING PLATFORM</span></div><button className="sidebar-toggle" title={sidebarCollapsed ? '展开导航' : '收起导航'} aria-label={sidebarCollapsed ? '展开导航' : '收起导航'} onClick={() => setSidebarCollapsed(value => !value)}>{sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button></div>
      <button className="project-picker" onClick={() => setVersionManagerOpen(true)} aria-label="切换当前版本">
        <span className="project-logo">V</span><span><small>{activeProjectVersion ? '当前版本' : '尚未创建版本'}</small><strong>{activeProjectVersion ? `SmartHub · ${activeProjectVersion.name}` : '新建版本后开始工作'}</strong></span><ChevronDown size={15} />
      </button>
      <nav>
        <p className="nav-label nav-scope"><span>项目空间</span><em>按版本隔离</em></p>
        {menu.map(item => <button key={item.key} className={page === item.key ? 'active' : ''} onClick={() => navigate(item.key)}><item.icon size={18} /><span>{item.label}</span>{item.hint && <em>{item.hint}</em>}</button>)}
        <p className="nav-label second nav-scope"><span>平台管理</span><em>全局</em></p>
        <button className={page === 'documents' ? 'active' : ''} onClick={() => navigate('documents')}><Library size={18} /><span>知识库</span></button>
        <button className={page === 'settings' ? 'active' : ''} onClick={() => navigate('settings')}><Settings size={18} /><span>系统管理</span></button>
      </nav>
      <button className="sidebar-account" onClick={() => notify('当前账号：李世磊 · 测试负责人')} aria-label="查看当前账号">
        <span className="avatar">LS</span><span className="sidebar-account-info"><b>李磊</b><small>测试负责人</small></span><ChevronRight />
      </button>
    </aside>
    <main>
      <section className={`content ${page === 'planning' ? 'planning-content' : ''} ${page === 'documents' ? 'documents-content' : ''} ${page === 'settings' ? 'settings-content' : ''}`}>
        <div className="page-head"><div><h1>{meta.title}</h1><p>{meta.desc}</p></div></div>
        {page === 'dashboard' && <Dashboard navigate={navigate} projectVersion={activeProjectVersion} onManageVersions={() => setVersionManagerOpen(true)} />}
        {page === 'planning' && <Suspense fallback={<PageLoading label="正在加载测试策划工作台…" />}><PlanningPage key={activeProjectVersion?.id ?? 'no-version'} projectVersion={activeProjectVersion} documents={knowledgeDocumentList} knowledgeBaseId={knowledgeBaseId} apiState={knowledgeApiState} refreshKnowledge={() => refreshKnowledge()} onManageVersions={() => setVersionManagerOpen(true)} onOpenKnowledge={() => navigate('documents')} onOpenActivity={() => setActivityOpen(true)} notify={notify} addAudit={entry => setAudit(current => [entry, ...current])} /></Suspense>}
        {page === 'documents' && <Documents knowledgeBaseId={knowledgeBaseId} apiState={knowledgeApiState} refreshKnowledge={refreshKnowledge} loadDocument={hydrateDocument} directories={workspaceKnowledgeTree.directories} documents={workspaceKnowledgeTree.documents} workspaceRootDirectoryId={workspaceKnowledgeTree.rootDirectoryId} notify={notify} addAudit={entry => setAudit(current => [entry, ...current])} />}
        {page === 'execution' && <Suspense fallback={<PageLoading label="正在加载测试执行工作台…" />}><TestExecutionPage key={activeProjectVersion?.id ?? 'no-version'} projectVersion={activeProjectVersion} onManageVersions={() => setVersionManagerOpen(true)} notify={notify} /></Suspense>}
        {page === 'reports' && <Suspense fallback={<PageLoading label="正在加载报告与诊断工作台…" />}><TestReportPage key={activeProjectVersion?.id ?? 'no-version'} projectVersion={activeProjectVersion} onManageVersions={() => setVersionManagerOpen(true)} notify={notify} /></Suspense>}
        {page === 'settings' && <SystemSettings knowledgeBaseId={knowledgeBaseId} notify={notify} addAudit={entry => setAudit(current => [entry, ...current])} />}
      </section>
    </main>
    {toast && <div className={`toast ${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>{toast.tone === 'error' ? <XCircle size={18} /> : toast.tone === 'warning' ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}{toast.message}</div>}
    {activityOpen && <Modal title="本次会话操作记录" onClose={() => setActivityOpen(false)}><div className="activity-modal"><p>记录只保留在当前浏览器会话中。</p>{audit.map((entry, index) => <div key={`${entry}-${index}`}><Clock3 size={15} /><span>{entry}</span></div>)}</div></Modal>}
    {versionManagerOpen && <ProjectVersionManager versions={projectVersions} selectedId={selectedProjectVersionId} onSelect={id => { selectProjectVersion(id); setVersionManagerOpen(false) }} onRefresh={refreshProjectVersions} onClose={() => setVersionManagerOpen(false)} notify={notify} />}
  </div>
}

function Dashboard({ navigate, projectVersion, onManageVersions }: { navigate: (page: PageKey, planningTab?: PlanningTab) => void; projectVersion: ProjectVersion | null; onManageVersions: () => void }) {
  return <div className="dashboard-grid"><section className="card span2 dashboard-notice"><Badge tone="violet"><Sparkles size={12} /> {projectVersion ? `当前版本 ${projectVersion.name}` : '尚未创建项目版本'}</Badge><h2>{projectVersion ? '当前项目空间已按版本隔离' : '先创建项目版本，再开始测试策划'}</h2><p>{projectVersion ? '需求理解快照、测试设计与 Planning Session 上下文都固定在当前版本。' : '平台固定服务 SmartHub 单项目，项目空间通过版本切换。'}</p><div><button className="btn primary" onClick={projectVersion ? () => navigate('planning') : onManageVersions}>{projectVersion ? '进入测试策划' : '新建项目版本'}</button></div></section><section className="card quick-card"><Sparkles /><h3>需求理解</h3><p>由同一个 PlanningAgent 在当前 Project Workspace 与 Planning Session 中完成。</p><button className="text-btn" onClick={() => navigate('planning')}>打开测试策划 <ChevronRight /></button></section><section className="card quick-card"><TestTube2 /><h3>测试用例</h3><p>需求理解达到可测试状态后，Agent 自动生成用例，Coverage 与正式发布仍保留治理门禁。</p><button className="text-btn" onClick={() => navigate('planning', 'test-design')}>查看测试用例 <ChevronRight /></button></section><section className="card quick-card"><Library /><h3>知识库</h3><p>知识库由平台单项目共享，不随项目版本复制。</p><button className="text-btn" onClick={() => navigate('documents')}>打开知识库 <ChevronRight /></button></section><section className="card quick-card"><Settings /><h3>系统设置</h3><p>模型与平台配置为全局资源，不参与版本隔离。</p><button className="text-btn" onClick={() => navigate('settings')}>打开系统设置 <ChevronRight /></button></section></div>
}

function ProjectVersionManager({ versions, selectedId, onSelect, onRefresh, onClose, notify }: { versions: ProjectVersion[]; selectedId: string; onSelect: (id: string) => void; onRefresh: () => Promise<ProjectVersion[]>; onClose: () => void; notify: Notify }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [inherit, setInherit] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ProjectVersion | null>(null)
  const [deleting, setDeleting] = useState(false)
  const create = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      const created = await createProjectVersion({ name, description, sourceProjectVersionId: sourceId || undefined, inheritRequirementBindings: Boolean(sourceId && inherit) })
      await onRefresh()
      notify(`项目版本 ${created.name} 已创建。`)
      onSelect(created.id)
    } catch (error) { notify(error instanceof Error ? error.message : '项目版本创建失败', 'error') }
    finally { setSaving(false) }
  }
  const changeStatus = async (version: ProjectVersion, status: ProjectVersionStatus) => {
    try { await updateProjectVersionStatus(version.id, status); await onRefresh(); notify(`${version.name} 已设为${status === 'open' ? '可编辑' : status === 'locked' ? '已锁定' : '已归档'}。`) }
    catch (error) { notify(error instanceof Error ? error.message : '版本状态更新失败', 'error') }
  }
  const remove = async () => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    try {
      const deleted = await deleteProjectVersion(deleteTarget.id)
      const remaining = await onRefresh()
      notify(`项目版本 ${deleted.name} 已删除，同时移除 ${deleted.deletedBindings} 条需求绑定、${deleted.deletedAnalysisRuns} 条需求分析运行和 ${deleted.deletedTestDesigns} 个测试设计。`)
      if (deleteTarget.id === selectedId) onSelect(remaining[0]?.id ?? '')
      else setDeleteTarget(null)
    } catch (error) { notify(error instanceof Error ? error.message : '项目版本删除失败', 'error') }
    finally { setDeleting(false) }
  }
  return <><Modal title="项目版本" onClose={onClose} className="version-manager-modal"><div className="version-manager"><section><h3>当前项目版本</h3><p>需求分析数据按版本隔离；锁定和归档版本只能查看。只有可编辑版本可删除；删除时会同时移除该版本的需求绑定和已结束分析运行。</p><div className="project-version-list">{versions.map(version => <article className={version.id === selectedId ? 'active' : ''} key={version.id}><button className="version-select" onClick={() => onSelect(version.id)}><GitBranch /><span><b>{version.name}</b><small>{version.description || '未填写版本说明'} · {new Date(version.createdAt).toLocaleString('zh-CN')}</small></span><Badge tone={version.status === 'open' ? 'green' : version.status === 'locked' ? 'orange' : 'gray'}>{version.status === 'open' ? '可编辑' : version.status === 'locked' ? '已锁定' : '已归档'}</Badge></button><select aria-label={`设置 ${version.name} 状态`} value={version.status} onChange={event => void changeStatus(version, event.target.value as ProjectVersionStatus)}><option value="open">可编辑</option><option value="locked">锁定</option><option value="archived">归档</option></select><button className="version-delete" disabled={version.status !== 'open'} title={version.status === 'open' ? `删除 ${version.name}` : '只有可编辑版本可以删除'} aria-label={version.status === 'open' ? `删除 ${version.name}` : `${version.name} 不可删除`} onClick={() => setDeleteTarget(version)}><Trash2 /></button></article>)}{!versions.length && <div className="version-empty"><GitBranch /><b>尚无项目版本</b><span>创建第一个版本后，才能进入需求分析。</span></div>}</div></section><section className="version-create"><h3>新建版本</h3><label>版本名称<input value={name} onChange={event => setName(event.target.value)} placeholder="例如：V1.0 / 2026-Q3" /></label><label>版本说明<textarea value={description} onChange={event => setDescription(event.target.value)} placeholder="本版本目标或范围（可选）" /></label><label>来源版本<select value={sourceId} onChange={event => setSourceId(event.target.value)}><option value="">空白版本</option>{versions.map(version => <option value={version.id} key={version.id}>{version.name}</option>)}</select></label>{sourceId && <label className="version-inherit"><input type="checkbox" checked={inherit} onChange={event => setInherit(event.target.checked)} />继承来源版本的需求绑定（不继承需求分析运行和对话）</label>}<button className="btn primary full" disabled={!name.trim() || saving} onClick={() => void create()}><Plus />{saving ? '创建中…' : '创建并进入版本'}</button></section></div></Modal>{deleteTarget && <Modal title="删除项目版本" onClose={() => { if (!deleting) setDeleteTarget(null) }}><div className="modal-form version-delete-confirm"><div className="danger-confirm"><AlertTriangle /><span><b>确定删除“{deleteTarget.name}”吗？</b><small>该版本的需求绑定和已结束的需求分析运行将一并删除，操作不可恢复。知识库原始文件不会被删除；如有运行中的需求分析，请先取消。</small></span></div><div className="modal-actions"><button className="btn ghost" disabled={deleting} onClick={() => setDeleteTarget(null)}>取消</button><button className="btn danger" disabled={deleting} onClick={() => void remove()}><Trash2 />{deleting ? '删除中…' : '确认删除'}</button></div></div></Modal>}</>
}

function PlaceholderNotice({ title, boundary, missing }: { title: string; boundary: string; missing: string }) {
  return <section className="card static-notice placeholder-notice"><Badge tone="orange"><AlertTriangle size={12} />功能占位 · 尚未实现</Badge><h2>{title}</h2><p>该导航项用于明确产品规划边界，当前不是可用业务页面。</p><div><span><CheckCircle2 /><b>已具备的相邻能力</b><small>{boundary}</small></span><span><Clock3 /><b>尚未实现</b><small>{missing}</small></span></div></section>
}

function PageLoading({ label }: { label: string }) {
  return <section className="card page-loading" role="status"><RefreshCw /><span>{label}</span></section>
}

function Documents({ knowledgeBaseId, apiState, refreshKnowledge, loadDocument, directories, documents, workspaceRootDirectoryId, notify, addAudit }: { knowledgeBaseId: string; apiState: 'connecting' | 'ready' | 'offline'; refreshKnowledge: (includeDeleted?: boolean) => Promise<void>; loadDocument: (document: KnowledgeDocument) => Promise<KnowledgeDocument>; directories: WorkspaceKnowledgeDirectory[]; documents: KnowledgeDocument[]; workspaceRootDirectoryId: string | null; notify: Notify; addAudit: (entry: string) => void }) {
  const [selectedId, setSelectedId] = useState(documents[0]?.id ?? '')
  const [selectedDirectoryId, setSelectedDirectoryId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<ApiSearchResult[]>([])
  const [searchMeta, setSearchMeta] = useState<ApiSearchMeta | null>(null)
  const [searchStatus, setSearchStatus] = useState('')
  const [searchLocation, setSearchLocation] = useState<SearchLocation | null>(null)
  const [evidenceFile, setEvidenceFile] = useState<KnowledgeDocument | null>(null)
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  const [outlineCollapsed, setOutlineCollapsed] = useState(false)
  const [viewMode, setViewMode] = useState<'preview' | 'source' | 'split'>('preview')
  const [activeSectionKey, setActiveSectionKey] = useState<string | null>(null)
  const [imageOpen, setImageOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [fileNameDraft, setFileNameDraft] = useState('')
  const [fileTargetDirectoryId, setFileTargetDirectoryId] = useState('')
  const [fileActionError, setFileActionError] = useState('')
  const [fileActionBusy, setFileActionBusy] = useState(false)
  const [syncState, setSyncState] = useState<JobStatus>('idle')
  const [uploadState, setUploadState] = useState<JobStatus>('idle')
  const [expandedDirectoryIds, setExpandedDirectoryIds] = useState<Set<string>>(() => new Set())
  const [directoryActionId, setDirectoryActionId] = useState<string | null>(null)
  const [directoryEditor, setDirectoryEditor] = useState<{ mode: 'create'; parentId: string | null } | { mode: 'rename'; directoryId: string } | null>(null)
  const [directoryName, setDirectoryName] = useState('')
  const [directoryNameError, setDirectoryNameError] = useState('')
  const [directorySaving, setDirectorySaving] = useState(false)
  const [deleteDirectoryId, setDeleteDirectoryId] = useState<string | null>(null)
  const [moveTargetId, setMoveTargetId] = useState('')
  const timers = useRef<number[]>([])
  const uploadRef = useRef<HTMLInputElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const documentPanelRef = useRef<HTMLElement>(null)
  const outlineRef = useRef<HTMLElement>(null)
  const searchInputRef = useRef<HTMLDivElement>(null)
  const searchPopoverRef = useRef<HTMLDivElement>(null)
  const searchRequestRef = useRef(0)
  const searchResultQueryRef = useRef('')
  const searchResultStatusRef = useRef('')
  const [uploadCandidates, setUploadCandidates] = useState<File[]>([])
  const [uploadAssetType, setUploadAssetType] = useState('other')
  const [uploadLogicalPath, setUploadLogicalPath] = useState('')
  const [activeIndexSummary, setActiveIndexSummary] = useState<ApiIndexSummary | null>(null)
  const [candidateProgress, setCandidateProgress] = useState<{ step: string; progress: number } | null>(null)
  const [taskPollVersion, setTaskPollVersion] = useState(0)
  useEffect(() => () => timers.current.forEach(timer => window.clearTimeout(timer)), [])
  useEffect(() => {
    if (!knowledgeBaseId || apiState !== 'ready') return
    let cancelled = false
    let timer: number | undefined
    const refreshTaskState = async () => {
      try {
        const [overview, tasks] = await Promise.all([loadKnowledgeOverview(knowledgeBaseId), loadTasks(knowledgeBaseId)])
        if (cancelled) return
        setActiveIndexSummary(overview.indexSummary)
        setCandidateProgress(overview.candidateSummary ? { step: overview.candidateSummary.task.step, progress: overview.candidateSummary.task.progress } : null)
        const active = tasks.some(task => task.status === 'queued' || task.status === 'running')
        if (active) {
          await refreshKnowledge()
          if (!cancelled) timer = window.setTimeout(() => void refreshTaskState(), 1_000)
        }
      } catch {
        if (!cancelled) timer = window.setTimeout(() => void refreshTaskState(), 3_000)
      }
    }
    void refreshTaskState()
    return () => { cancelled = true; if (timer) window.clearTimeout(timer) }
  }, [apiState, knowledgeBaseId, refreshKnowledge, taskPollVersion])
  useEffect(() => {
    if (!documents.some(document => document.id === selectedId)) {
      setSelectedId(documents[0]?.id ?? '')
      setActiveSectionKey(null)
    }
  }, [documents, selectedId])
  useEffect(() => {
    if (selectedDirectoryId && !directories.some(directory => directory.id === selectedDirectoryId)) setSelectedDirectoryId(null)
  }, [directories, selectedDirectoryId])
  useEffect(() => {
    const validDirectoryIds = new Set(directories.map(directory => directory.id))
    setExpandedDirectoryIds(current => {
      const next = new Set([...current].filter(directoryId => validDirectoryIds.has(directoryId)))
      return next.size === current.size ? current : next
    })
  }, [directories])
  useEffect(() => { if (!query.trim() || apiState !== 'ready') { searchRequestRef.current += 1; searchResultQueryRef.current = ''; searchResultStatusRef.current = ''; setSearchResults([]); setSearchMeta(null); setSearchStatus(''); return }; const timer = window.setTimeout(() => void search(), 350); return () => window.clearTimeout(timer) }, [query, apiState, knowledgeBaseId])
  useEffect(() => {
    if (!searchStatus) return
    const close = () => { searchRequestRef.current += 1; setSearchStatus('') }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!searchInputRef.current?.contains(target) && !searchPopoverRef.current?.contains(target)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown); window.removeEventListener('keydown', onKeyDown) }
  }, [searchStatus])

  const directoryById = useMemo(() => new Map(directories.map(directory => [directory.id, directory])), [directories])
  const directoriesByParent = useMemo(() => {
    const result = new Map<string | null, WorkspaceKnowledgeDirectory[]>()
    directories.forEach(directory => result.set(directory.parentId, [...(result.get(directory.parentId) ?? []), directory]))
    return result
  }, [directories])
  const documentsByParent = useMemo(() => {
    const result = new Map<string | null, KnowledgeDocument[]>()
    documents.forEach(document => result.set(document.parentId, [...(result.get(document.parentId) ?? []), document]))
    return result
  }, [documents])
  const documentCountByDirectory = useMemo(() => {
    const result = new Map<string, number>()
    const count = (directoryId: string): number => {
      const total = (documentsByParent.get(directoryId) ?? []).length + (directoriesByParent.get(directoryId) ?? []).reduce((sum, child) => sum + count(child.id), 0)
      result.set(directoryId, total)
      return total
    }
    directories.filter(directory => directory.parentId === null).forEach(directory => count(directory.id))
    return result
  }, [directories, directoriesByParent, documentsByParent])
  const queryText = query.trim().toLowerCase()
  const matchingDocumentIds = useMemo(() => new Set(documents.filter(document => `${document.name} ${document.intro} ${document.content ?? ''}`.toLowerCase().includes(queryText)).map(document => document.id)), [documents, queryText])
  const visibleDirectoryIds = useMemo(() => {
    if (!queryText) return new Set(directories.map(directory => directory.id))
    const result = new Set<string>()
    documents.filter(document => matchingDocumentIds.has(document.id)).forEach(document => {
      let currentId = document.parentId
      while (currentId) {
        result.add(currentId)
        currentId = directoryById.get(currentId)?.parentId ?? null
      }
    })
    return result
  }, [directories, directoryById, documents, matchingDocumentIds, queryText])
  const deleteTarget = deleteDirectoryId ? directoryById.get(deleteDirectoryId) : undefined
  const deleteDirectoryIds = useMemo(() => {
    const result = new Set<string>()
    const collect = (directoryId: string) => {
      result.add(directoryId)
      ;(directoriesByParent.get(directoryId) ?? []).forEach(child => collect(child.id))
    }
    if (deleteDirectoryId) collect(deleteDirectoryId)
    return result
  }, [deleteDirectoryId, directoriesByParent])
  const moveCandidates = useMemo(() => directories.filter(directory => !deleteDirectoryIds.has(directory.id)), [deleteDirectoryIds, directories])
  const currentFile = documents.find(document => document.id === selectedId)
  const file = evidenceFile?.id === selectedId ? evidenceFile : currentFile
  useEffect(() => {
    if (!currentFile?.assetVersionId || currentFile.content !== undefined) return
    let cancelled = false
    void loadDocument(currentFile).catch(error => {
      if (!cancelled) notify(error instanceof Error ? error.message : '文档正文加载失败', 'error')
    })
    return () => { cancelled = true }
  }, [currentFile?.assetVersionId, currentFile?.content, loadDocument])
  const documentContentLoading = Boolean(file?.assetVersionId && file.content === undefined)
  const source = file && !documentContentLoading ? makeSource(file) : ''
  const format = file?.name.toLowerCase().endsWith('.txt') ? 'text' : 'markdown'
  const outline = useMemo(() => format === 'markdown' ? parseMarkdownOutline(source) : emptyMarkdownOutline, [format, source])
  useEffect(() => {
    const preview = previewRef.current
    if (!preview || viewMode !== 'preview' || format !== 'markdown' || !outline.sections.length) {
      setActiveSectionKey(null)
      return
    }

    const getActiveSection = () => {
      const previewTop = preview.getBoundingClientRect().top
      const sections = [...preview.querySelectorAll<HTMLElement>('[data-document-section-key]')].map(section => ({
        key: section.dataset.documentSectionKey ?? '',
        top: section.getBoundingClientRect().top - previewTop + preview.scrollTop,
      })).filter(section => section.key)
      const key = getActiveDocumentSectionKey(sections, preview.scrollTop + 14)
      setActiveSectionKey(current => current === key ? current : key)
    }

    getActiveSection()
    preview.addEventListener('scroll', getActiveSection, { passive: true })
    return () => preview.removeEventListener('scroll', getActiveSection)
  }, [format, outline, selectedId, viewMode])
  useEffect(() => {
    const outlineElement = outlineRef.current
    const activeButton = outlineElement?.querySelector<HTMLElement>('[data-outline-section-key].active')
    if (!outlineElement || !activeButton) return

    const outlineBounds = outlineElement.getBoundingClientRect()
    const buttonBounds = activeButton.getBoundingClientRect()
    if (buttonBounds.top < outlineBounds.top) outlineElement.scrollTop += buttonBounds.top - outlineBounds.top
    else if (buttonBounds.bottom > outlineBounds.bottom) outlineElement.scrollTop += buttonBounds.bottom - outlineBounds.bottom
  }, [activeSectionKey])
  useEffect(() => {
    if (!searchLocation || searchLocation.assetId !== selectedId || searchLocation.assetVersionId !== file?.assetVersionId || viewMode !== 'preview') return
    let highlighted: HTMLElement | null = null
    let highlightTimer = 0
    const frame = window.requestAnimationFrame(() => {
      const preview = previewRef.current
      if (!preview) return
      const located = [...preview.querySelectorAll<HTMLElement>('[data-source-start-line]')]
      const lines = located.map(element => Number(element.dataset.sourceStartLine ?? 0))
      const index = getClosestSourceLineIndex(lines, searchLocation.startLine)
      const target = index >= 0 ? located[index] : null
      if (target) {
        highlighted = target
        target.classList.add('search-location-hit')
        const top = target.getBoundingClientRect().top - preview.getBoundingClientRect().top + preview.scrollTop - 18
        preview.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
        const sectionElements = [...preview.querySelectorAll<HTMLElement>('[data-document-section-key][data-source-start-line]')]
        const sectionIndex = getClosestSourceLineIndex(sectionElements.map(element => Number(element.dataset.sourceStartLine ?? 0)), searchLocation.startLine)
        const sectionKey = sectionIndex >= 0 ? sectionElements[sectionIndex].dataset.documentSectionKey : null
        if (sectionKey) setActiveSectionKey(sectionKey)
        highlightTimer = window.setTimeout(() => target.classList.remove('search-location-hit'), 2600)
      } else {
        const totalLines = Math.max(1, source.split('\n').length - 1)
        const ratio = Math.max(0, Math.min(1, (searchLocation.startLine - 1) / totalLines))
        preview.scrollTo({ top: ratio * Math.max(0, preview.scrollHeight - preview.clientHeight), behavior: 'smooth' })
      }
    })
    return () => { window.cancelAnimationFrame(frame); if (highlightTimer) window.clearTimeout(highlightTimer); highlighted?.classList.remove('search-location-hit') }
  }, [file?.assetVersionId, format, searchLocation, selectedId, source, viewMode])
  useEffect(() => {
    if (searchLocation?.assetId === selectedId) return
    const frame = window.requestAnimationFrame(() => {
      const panel = documentPanelRef.current
      panel?.querySelectorAll<HTMLElement>('.markdown-view, .source-view, .split-markdown').forEach(element => { element.scrollTop = 0 })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [searchLocation, selectedId])

  const getDirectoryBreadcrumb = (directoryId: string) => {
    const names: string[] = []
    const visited = new Set<string>()
    let currentId: string | null = directoryId
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId)
      const directory = directoryById.get(currentId)
      if (!directory) break
      names.unshift(directory.name)
      currentId = directory.parentId
    }
    return ['知识库', ...names].join(' / ')
  }
  const getDirectoryLogicalPath = (directoryId: string) => directoryById.get(directoryId)?.logicalPath ?? ''
  const getBreadcrumb = (document: KnowledgeDocument) => `${getDirectoryBreadcrumb(document.parentId ?? '').replace(/ \/ $/, '')} / ${document.name}`
  const isExpanded = (directoryId: string) => queryText ? visibleDirectoryIds.has(directoryId) : expandedDirectoryIds.has(directoryId)
  const toggleDirectory = (directoryId: string) => setExpandedDirectoryIds(current => {
    const next = new Set(current)
    if (next.has(directoryId)) next.delete(directoryId)
    else next.add(directoryId)
    return next
  })
  const closeEditor = () => { setDirectoryEditor(null); setDirectoryName(''); setDirectoryNameError('') }
  const openCreate = (parentId: string | null) => {
    setDirectoryActionId(null)
    setDirectoryEditor({ mode: 'create', parentId })
    setDirectoryName('')
    setDirectoryNameError('')
  }
  const openRename = (directory: WorkspaceKnowledgeDirectory) => {
    setDirectoryActionId(null)
    setDirectoryEditor({ mode: 'rename', directoryId: directory.id })
    setDirectoryName(directory.name)
    setDirectoryNameError('')
  }
  const saveDirectory = async () => {
    if (!directoryEditor) return
    const value = directoryName.trim()
    const editedDirectory = directoryEditor.mode === 'rename' ? directoryById.get(directoryEditor.directoryId) : undefined
    const parentId = (directoryEditor.mode === 'create' ? directoryEditor.parentId : editedDirectory?.parentId) ?? null
    if (!value) { setDirectoryNameError('请输入目录名称。'); return }
    if (directories.some(directory => directory.parentId === parentId && directory.id !== editedDirectory?.id && directory.name.trim().toLocaleLowerCase() === value.toLocaleLowerCase())) {
      setDirectoryNameError('同一目录下已存在相同名称。')
      return
    }
    setDirectorySaving(true)
    try {
      if (directoryEditor.mode === 'create') {
        const created = await createKnowledgeDirectory(knowledgeBaseId, value, parentId)
        await refreshKnowledge(); setExpandedDirectoryIds(current => new Set([...current, created.id, ...(parentId ? [parentId] : [])])); setSelectedDirectoryId(created.id); addAudit(`创建知识库目录：${value}`); notify('目录已保存到知识库。')
      } else if (editedDirectory) {
        await renameKnowledgeDirectory(editedDirectory.id, value); await refreshKnowledge(); setSelectedDirectoryId(editedDirectory.id); addAudit(`重命名知识库目录：${editedDirectory.name} → ${value}`); notify('目录名称及相关文档路径已保存。')
      }
      closeEditor()
    } catch (error) { setDirectoryNameError(error instanceof Error ? error.message : '目录保存失败') }
    finally { setDirectorySaving(false) }
  }
  const openDelete = (directory: WorkspaceKnowledgeDirectory) => {
    setDirectoryActionId(null)
    setDeleteDirectoryId(directory.id)
    setMoveTargetId(directory.parentId ?? workspaceRootDirectoryId ?? '')
  }
  const closeDelete = () => { setDeleteDirectoryId(null); setMoveTargetId('') }
  const deleteEverything = async () => {
    if (!deleteTarget) return
    try { const result = await deleteKnowledgeDirectory(deleteTarget.id, 'recursive'); await refreshKnowledge(); setTaskPollVersion(version => version + 1); setSelectedDirectoryId(null); addAudit(`提交删除知识库目录及内容：${deleteTarget.name}`); notify('目录删除任务已提交，索引切换完成后将清理文件。'); closeDelete(); if ('task' in result && result.task) setExpandedDirectoryIds(current => new Set([...current, deleteTarget.id])) }
    catch (error) { notify(error instanceof Error ? error.message : '目录删除失败', 'error') }
  }
  const moveContents = async () => {
    if (!deleteTarget) return
    const parentId = moveTargetId || null
    const movedDirectories = directories.filter(directory => directory.parentId === deleteTarget.id).length
    const movedDocuments = documents.filter(document => document.parentId === deleteTarget.id).length
    const destination = parentId ? directoryById.get(parentId)?.name ?? (parentId === workspaceRootDirectoryId ? '/workspace' : '目标目录') : '/workspace'
    try { await deleteKnowledgeDirectory(deleteTarget.id, 'move', parentId); await refreshKnowledge(); setExpandedDirectoryIds(current => { const next = new Set(current); next.delete(deleteTarget.id); if (parentId) next.add(parentId); return next }); setSelectedDirectoryId(null); addAudit(`移动“${deleteTarget.name}”的 ${movedDirectories} 个子目录和 ${movedDocuments} 份文档至“${destination}”`); notify('目录内容已移动，目录变更已保存。'); closeDelete() }
    catch (error) { notify(error instanceof Error ? error.message : '目录移动失败') }
  }
  const sync = async () => {
    if (!knowledgeBaseId) return
    setSyncState('running')
    try { await refreshKnowledge(); setSyncState('completed'); addAudit('刷新知识库真实状态'); notify('知识库状态已刷新。') }
    catch (error) { setSyncState('failed'); notify(error instanceof Error ? error.message : '刷新失败') }
  }
  const search = async () => { const searchQuery = query.trim(); if (!searchQuery || !knowledgeBaseId) return; const requestId = ++searchRequestRef.current; try { const result = await searchKnowledge(knowledgeBaseId, searchQuery); if (requestId !== searchRequestRef.current) return; searchResultQueryRef.current = searchQuery; searchResultStatusRef.current = result.status; setSearchResults(result.results); setSearchMeta(result.retrieval ?? null); setSearchStatus(result.status) } catch (error) { if (requestId === searchRequestRef.current) notify(error instanceof Error ? error.message : '检索失败') } }
  const updateSearchQuery = (value: string) => {
    setQuery(value)
    if (value.trim() !== searchResultQueryRef.current) setSearchStatus('')
  }
  const reopenSearchResults = () => {
    const searchQuery = query.trim()
    if (!searchQuery) return
    if (searchQuery === searchResultQueryRef.current && searchResultStatusRef.current) setSearchStatus(searchResultStatusRef.current)
    else void search()
  }
  const chooseUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = [...(event.target.files ?? [])]; event.target.value = ''; if (!selected.length) return
    const archives = selected.filter(file => file.name.toLowerCase().endsWith('.zip'))
    if (archives.length && selected.length > 1) { notify('ZIP 压缩包需要单独上传，不能与 Markdown 文件混选。'); return }
    setUploadCandidates(selected); const directoryPath = selectedDirectoryId ? getDirectoryLogicalPath(selectedDirectoryId) : 'workspace/shared/knowledge'
    setUploadLogicalPath(selected.length === 1 && !archives.length ? directoryPath ? `${directoryPath}/${selected[0].name}` : selected[0].name : directoryPath)
  }
  const upload = async () => {
    const uploaded = uploadCandidates
    if (!uploaded.length || !knowledgeBaseId) return
    setUploadState('running')
    try {
      if (uploaded[0].name.toLowerCase().endsWith('.zip')) {
        const result = await uploadKnowledgeArchive(knowledgeBaseId, uploaded[0], uploadLogicalPath, uploadAssetType); await refreshKnowledge(); setTaskPollVersion(version => version + 1); setUploadState('completed'); setUploadCandidates([]); addAudit(`上传 Markdown 压缩包：${uploaded[0].name}`); notify(`已提交 ${result.documents} 篇文档的入库任务${result.skipped ? `，跳过 ${result.skipped} 个不支持文件` : ''}。`)
      } else {
        let succeeded = 0; let deduplicated = 0; const failed: string[] = []
        const targetDirectory = uploaded.length > 1 ? uploadLogicalPath.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '') : ''
        for (const file of uploaded) {
          const logicalPath = uploaded.length === 1 ? uploadLogicalPath : [targetDirectory, file.name].filter(Boolean).join('/')
          try { const result = await uploadKnowledgeFile(knowledgeBaseId, file, logicalPath, uploadAssetType); succeeded += 1; if (result.deduplicated) deduplicated += 1; addAudit(`上传知识资产：${logicalPath}`) }
          catch { failed.push(file.name) }
        }
        await refreshKnowledge(); if (succeeded) setTaskPollVersion(version => version + 1); setUploadState(succeeded ? 'completed' : 'failed')
        if (succeeded) setUploadCandidates([])
        notify(`已上传 ${succeeded} 个文档${deduplicated ? `，其中 ${deduplicated} 个内容未变化` : ''}${failed.length ? `；失败 ${failed.length} 个：${failed.join('、')}` : ''}。`)
      }
    }
    catch (error) { setUploadState('failed'); notify(error instanceof Error ? error.message : '上传失败') }
  }
  const clearEvidencePreview = () => { setEvidenceFile(null); setSearchLocation(null) }
  const selectFile = (id: string) => { setSelectedId(id); setActiveSectionKey(null); clearEvidencePreview(); setSelectedDirectoryId(null) }
  const openSearchResult = async (result: ApiSearchResult) => {
    const requestId = ++searchRequestRef.current
    setSelectedId(result.asset.id)
    setSelectedDirectoryId(null)
    setViewMode('preview')
    setActiveSectionKey(null)
    setSearchStatus('')
    try {
      const version = await loadAssetVersion(result.version.id)
      if (requestId !== searchRequestRef.current) return
      const name = result.asset.displayName
      const format = name.toLowerCase().endsWith('.txt') ? 'text' : 'markdown'
      const outline = format === 'markdown' ? parseMarkdownOutline(version.content) : undefined
      setEvidenceFile({
        id: result.asset.id,
        name,
        parentId: null,
        version: `V${result.version.number}`,
        updated: version.readyAt ? new Date(version.readyAt).toLocaleString('zh-CN') : new Date(version.createdAt).toLocaleString('zh-CN'),
        title: outline?.title ?? name.replace(/\.(md|txt)$/i, ''),
        intro: version.content.split('\n').find(line => line.trim() && !line.startsWith('#'))?.trim() ?? '',
        sections: outline?.sections.map(section => section.title) ?? [],
        content: version.content,
        assetType: result.asset.assetType,
        sourceType: result.asset.sourceType,
        assetVersionId: version.id,
        versions: [{ id: version.id, number: version.number, status: version.status, createdAt: version.createdAt }],
        status: version.status,
        logicalPath: result.asset.logicalPath,
      })
      setSearchLocation({ assetId: result.asset.id, assetVersionId: version.id, startLine: result.chunk.startLine, endLine: result.chunk.endLine, nonce: Date.now() })
      notify(`已打开检索证据固定版本 V${result.version.number} · L${result.chunk.startLine}-${result.chunk.endLine}`)
    } catch (error) {
      if (requestId === searchRequestRef.current) notify(error instanceof Error ? error.message : '固定版本加载失败', 'error')
    }
  }
  const openLinkedDocument = (logicalPath: string) => {
    const linked = documents.find(document => document.logicalPath?.replaceAll('\\', '/').toLocaleLowerCase() === logicalPath.toLocaleLowerCase())
    if (!linked) { notify(`知识库中未找到链接文档：${logicalPath}`); return }
    selectFile(linked.id)
  }
  const openFileActions = (target: KnowledgeDocument | undefined = file) => { if (!target) return; setSelectedId(target.id); setFileNameDraft(target.name); setFileTargetDirectoryId(target.parentId ?? workspaceRootDirectoryId ?? ''); setFileActionError(''); setMoreOpen(true) }
  const renameFile = async () => {
    if (!file) return
    setFileActionBusy(true); setFileActionError('')
    try { await updateKnowledgeAsset(file.id, { displayName: fileNameDraft }); clearEvidencePreview(); await refreshKnowledge(); addAudit(`重命名知识文件：${file.name} → ${fileNameDraft}`); notify('文件名称及物理路径已保存。'); setMoreOpen(false) }
    catch (error) { setFileActionError(error instanceof Error ? error.message : '文件重命名失败') }
    finally { setFileActionBusy(false) }
  }
  const moveFile = async () => {
    if (!file) return
    setFileActionBusy(true); setFileActionError('')
    try { await updateKnowledgeAsset(file.id, { targetDirectoryId: fileTargetDirectoryId || null }); clearEvidencePreview(); await refreshKnowledge(); addAudit(`移动知识文件：${file.name}`); notify('文件已移动并保存到目标目录。'); setMoreOpen(false) }
    catch (error) { setFileActionError(error instanceof Error ? error.message : '文件移动失败') }
    finally { setFileActionBusy(false) }
  }
  const deleteFile = async () => {
    if (!file) return
    setFileActionBusy(true); setFileActionError('')
    try { const deletedName = file.name; await deleteKnowledgeAsset(file.id); setMoreOpen(false); await refreshKnowledge(); setTaskPollVersion(version => version + 1); addAudit(`提交删除知识文件：${deletedName}`); notify('已提交删除任务，活动索引完成切换后将移除文件。') }
    catch (error) { setFileActionError(error instanceof Error ? error.message : '文件删除失败') }
    finally { setFileActionBusy(false) }
  }
  const retryRowTask = async (taskId: string) => {
    try { await retryTask(taskId); await refreshKnowledge(); setTaskPollVersion(version => version + 1); notify('已重新提交任务。') }
    catch (error) { notify(error instanceof Error ? error.message : '任务重试失败', 'error') }
  }
  const cancelRowTask = async (taskId: string) => {
    try { await cancelTask(taskId); await refreshKnowledge(); notify('已取消任务。') }
    catch (error) { notify(error instanceof Error ? error.message : '任务取消失败', 'error') }
  }
  const jumpToSection = (sectionKey: string) => {
    const preview = previewRef.current
    const target = preview?.querySelector<HTMLElement>(`[data-document-section-key="${sectionKey}"]`)
    setActiveSectionKey(sectionKey)
    if (!preview || !target) return

    const top = target.getBoundingClientRect().top - preview.getBoundingClientRect().top + preview.scrollTop - 14
    preview.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }
  const renderTask = (task: KnowledgeDocument['task'] | WorkspaceKnowledgeDirectory['task']) => task ? <span className={`tree-task ${task.status}`} title={task.error ?? `${task.step} ${task.progress}%`}><span>{task.status === 'failed' ? '失败' : task.status === 'queued' ? '排队' : task.step === 'file_cleanup' ? '清理中' : `${task.progress}%`}</span>{task.canRetry && <button onClick={event => { event.stopPropagation(); void retryRowTask(task.id) }}>重试</button>}{task.canCancel && <button onClick={event => { event.stopPropagation(); void cancelRowTask(task.id) }}>取消</button>}</span> : null
  const renderFile = (document: KnowledgeDocument, paddingLeft: string) => <div className={`tree-file-row ${selectedId === document.id ? 'active' : ''}`} key={document.id}><button className={`tree-file ${selectedId === document.id ? 'active' : ''}`} style={{ paddingLeft }} onClick={() => selectFile(document.id)} title={document.task?.error ?? document.name}><FileText /><span>{document.name}</span></button>{renderTask(document.task)}<button className="icon-btn tree-file-action" aria-label={`${document.name}更多操作`} disabled={Boolean(document.task && document.task.status !== 'failed')} onClick={() => openFileActions(document)}><MoreHorizontal /></button></div>
  const renderDirectory = (directory: WorkspaceKnowledgeDirectory, depth: number): ReactNode => {
    if (queryText && !visibleDirectoryIds.has(directory.id)) return null
    const childDirectories = directoriesByParent.get(directory.id) ?? []
    const childDocuments = (documentsByParent.get(directory.id) ?? []).filter(document => !queryText || matchingDocumentIds.has(document.id))
    const hasChildren = childDirectories.length + (documentsByParent.get(directory.id) ?? []).length > 0
    const expanded = isExpanded(directory.id)
    return <div className="tree-directory" key={directory.id}>
      <div className={`tree-folder ${selectedDirectoryId === directory.id ? 'selected' : ''}`} style={{ paddingLeft: `${8 + depth * 17}px` }}>
        {hasChildren ? <button className="tree-expand" onClick={() => toggleDirectory(directory.id)} aria-label={expanded ? `收起${directory.name}` : `展开${directory.name}`} aria-expanded={expanded}>{expanded ? <ChevronDown /> : <ChevronRight />}</button> : <span className="tree-expand-placeholder" />}
        <button className="tree-folder-name" onClick={() => { setSelectedDirectoryId(directory.id); if (hasChildren) toggleDirectory(directory.id) }} title={directory.task?.error ?? directory.name}><FolderOpen /><span>{directory.name}</span></button>
        {renderTask(directory.task)}
        <small>{documentCountByDirectory.get(directory.id) ?? 0}</small>
        {directory.persisted && <button className="icon-btn tree-action" disabled={Boolean(directory.task && directory.task.status !== 'failed')} aria-label={`${directory.name}更多操作`} onClick={() => setDirectoryActionId(current => current === directory.id ? null : directory.id)}><MoreHorizontal /></button>}
        {directory.persisted && directoryActionId === directory.id && <div className="tree-menu" role="menu"><button role="menuitem" onClick={() => openCreate(directory.id)}><FolderPlus />新建子目录</button>{!directory.structural && <><button role="menuitem" onClick={() => openRename(directory)}><Pencil />重命名</button><button className="danger" role="menuitem" onClick={() => openDelete(directory)}><Trash2 />删除目录</button></>}</div>}
      </div>
      {expanded && <div className="tree-children">{childDirectories.map(child => renderDirectory(child, depth + 1))}{childDocuments.map(document => renderFile(document, `${47 + depth * 17}px`))}</div>}
    </div>
  }
  const rootDirectories = directoriesByParent.get(null) ?? []
  const rootDocuments = (documentsByParent.get(null) ?? []).filter(document => !queryText || matchingDocumentIds.has(document.id))
  const editorTarget = directoryEditor?.mode === 'rename' ? directoryById.get(directoryEditor.directoryId) : undefined
  const editorParentId = directoryEditor?.mode === 'create' ? directoryEditor.parentId : editorTarget?.parentId
  const editorParentName = editorParentId ? directoryById.get(editorParentId)?.name ?? '/workspace' : '/workspace'
  const deletedDocumentCount = documents.filter(document => document.parentId && deleteDirectoryIds.has(document.parentId)).length
  const uploadIsArchive = uploadCandidates.length === 1 && uploadCandidates[0].name.toLowerCase().endsWith('.zip')
  const uploadIsMultiple = uploadCandidates.length > 1
  const uploadDirectorySuggestions = directories.map(directory => directory.logicalPath).filter(Boolean).sort((left, right) => left.localeCompare(right, 'zh-CN'))
  const uploadPathSuggestions = uploadIsArchive || uploadIsMultiple ? uploadDirectorySuggestions : uploadCandidates.length === 1 ? [uploadCandidates[0].name, ...uploadDirectorySuggestions.map(path => `${path}/${uploadCandidates[0].name}`)] : []

  return <section className="card knowledge-page">
    <div className="knowledge-toolbar"><div ref={searchInputRef} className="mini-search wide"><Search size={16} /><input aria-label="搜索知识库" value={query} onChange={event => updateSearchQuery(event.target.value)} onFocus={reopenSearchResults} placeholder="搜索文件名称或文档内容" /></div><Badge tone={apiState === 'ready' ? 'green' : apiState === 'connecting' ? 'orange' : 'gray'}>{apiState === 'ready' ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}{apiState === 'ready' ? '知识库已连接' : apiState === 'connecting' ? '正在连接' : 'API 未启动'}</Badge>{activeIndexSummary && <Badge tone="blue">活动索引 V{activeIndexSummary.number} · {activeIndexSummary.dimensions} 维 · {activeIndexSummary.chunks} Chunk · {activeIndexSummary.hnswReady === null ? '内存检索' : activeIndexSummary.hnswReady ? 'HNSW 就绪' : '精确检索'}</Badge>}{candidateProgress && <Badge tone="orange">候选索引 {candidateProgress.step} · {candidateProgress.progress}%（旧索引继续服务）</Badge>}<button className="btn ghost" disabled={syncState === 'running' || apiState !== 'ready'} onClick={() => void sync()}><RefreshCw size={16} />{syncState === 'running' ? '刷新中' : '刷新'}</button><button className="btn primary" disabled={uploadState === 'running' || apiState !== 'ready'} onClick={() => uploadRef.current?.click()}><Upload size={16} />{uploadState === 'running' ? '上传中' : '上传资料'}</button><input ref={uploadRef} className="visually-hidden" type="file" multiple accept=".zip,.md,.txt,application/zip,text/markdown,text/plain" onChange={chooseUpload} />{searchStatus && <div ref={searchPopoverRef} className="knowledge-search-results" role="dialog" aria-label="知识库检索结果">{searchMeta && <div className="search-summary"><b>{retrievalModeLabel(searchMeta.mode)}{searchMeta.degraded ? '（已降级）' : ''}</b><span>关键词召回 {searchMeta.keywordCandidates} · 向量召回 {searchMeta.vectorCandidates} · 通过门槛 {searchMeta.eligibleCandidates}</span><em>{searchMeta.degraded ? '向量服务不可用，已使用关键词检索' : `最低相关度 ${Math.round(searchMeta.minimumRelevance * 100)}%`}</em></div>}{searchResults.length ? searchResults.map(result => <button key={`${result.version.id}-${result.chunk.chunkKey}`} onClick={() => openSearchResult(result)}><b>{result.asset.displayName}<em className="final-score">综合 {Math.round(result.score * 100)}%</em></b><span>{result.excerpt}</span><small>{result.asset.logicalPath} · {result.chunk.headingPath.join(' / ') || '正文'} · L{result.chunk.startLine}-{result.chunk.endLine}</small>{result.scores && <div className="score-breakdown"><i className={result.scores.keyword > 0 ? 'active' : ''}>关键词 {Math.round(result.scores.keyword * 100)}%</i><i className={result.scores.vector > 0 ? 'active' : ''}>向量 {Math.round(result.scores.vector * 100)}%</i>{result.scores.reranker != null && <i className="active">重排 {Math.round(result.scores.reranker * 100)}%</i>}</div>}</button>) : <p>{searchStatus === 'no_ready_assets' ? '尚无已就绪资料。' : searchStatus === 'initial_indexing' ? '正在建立首个索引，请稍后重试。' : searchStatus === 'no_active_index' ? '尚未建立活动索引。' : searchStatus === 'vector_unavailable' ? '向量服务暂不可用，可切换关键词检索。' : searchStatus === 'filter_empty' ? '当前筛选范围没有可检索资料。' : '当前范围没有匹配结果。'}</p>}</div>}</div>
    <div className={`knowledge-layout ${treeCollapsed ? 'tree-collapsed' : ''}`}><aside className={`file-tree ${treeCollapsed ? 'collapsed' : ''}`}><div className="tree-root" title="/workspace"><FolderOpen /><b>知识库</b><small>{documents.length}</small>{workspaceRootDirectoryId && <button className="icon-btn tree-root-action" onClick={() => openCreate(workspaceRootDirectoryId)} aria-label="在 /workspace 新建目录"><FolderPlus /></button>}<button className="icon-btn tree-collapse" title={treeCollapsed ? '展开文件树' : '收起文件树'} aria-label={treeCollapsed ? '展开文件树' : '收起文件树'} onClick={() => setTreeCollapsed(value => !value)}>{treeCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button></div>{queryText && !matchingDocumentIds.size ? <p className="empty-state">没有匹配的文档。</p> : <div className="tree-content">{rootDirectories.map(directory => renderDirectory(directory, 0))}{rootDocuments.map(document => renderFile(document, '30px'))}</div>}</aside>
      <article ref={documentPanelRef} className={`document-preview ${outlineCollapsed ? 'outline-collapsed' : ''}`}><div className="preview-head"><div className="breadcrumb"><Library size={14} /><span title={file ? getBreadcrumb(file) : undefined}>{file ? getBreadcrumb(file) : '尚未选择文档'}</span></div>{file && <div className="preview-actions">{evidenceFile && <Badge tone="purple">检索证据固定版本</Badge>}<Badge tone={file.task?.status === 'failed' ? 'red' : file.task ? 'orange' : file.status === 'ready' ? 'green' : 'gray'}>{file.task?.status === 'failed' ? '入库失败' : file.task ? `${file.task.step} ${file.task.progress}%` : file.status === 'ready' ? '已入库' : '等待入库'}</Badge><div className="view-switch" role="group" aria-label="文档视图"><button className={viewMode === 'preview' ? 'active' : ''} aria-pressed={viewMode === 'preview'} onClick={() => setViewMode('preview')}><BookOpen />预览</button><button className={viewMode === 'source' ? 'active' : ''} aria-pressed={viewMode === 'source'} onClick={() => setViewMode('source')}><Code2 />源码</button><button className={viewMode === 'split' ? 'active' : ''} aria-pressed={viewMode === 'split'} onClick={() => setViewMode('split')}><Columns2 />分屏</button></div><button className="btn ghost" onClick={() => setHistoryOpen(true)}><Clock3 />版本历史</button><button className="icon-btn" title={outlineCollapsed ? '显示本文目录' : '隐藏本文目录'} aria-label={outlineCollapsed ? '显示本文目录' : '隐藏本文目录'} onClick={() => setOutlineCollapsed(value => !value)}>{outlineCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button><button className="icon-btn" aria-label="文档更多操作" onClick={() => openFileActions()}><MoreHorizontal /></button></div>}</div>
        {file ? documentContentLoading ? <div className="document-empty" role="status"><RefreshCw className="document-loading-icon" /><h2>正在加载文档正文</h2><p>列表已就绪，正在读取所选固定版本。</p></div> : viewMode === 'preview' ? <div className="preview-body"><DocumentContent ref={previewRef} file={file} source={source} format={format} outline={outline} knowledgeBaseId={knowledgeBaseId} activeSectionKey={activeSectionKey} onOpenDocument={openLinkedDocument} onOpenImage={() => setImageOpen(true)} /><nav ref={outlineRef} className="document-outline" aria-label="本文目录"><b>本文目录</b>{outline.sections.map(section => <button key={section.key} data-outline-section-key={section.key} className={activeSectionKey === section.key ? 'active' : ''} onClick={() => jumpToSection(section.key)}>{section.title}</button>)}</nav></div> : viewMode === 'source' ? <SourceView source={source} /> : <div className="split-view"><section className="split-pane source-pane"><header><Code2 />Markdown 源码 <Badge tone="orange">只读</Badge></header><SourceView source={source} /></section><section className="split-pane rendered-pane"><header><BookOpen />渲染预览</header><DocumentContent file={file} source={source} format={format} outline={outline} knowledgeBaseId={knowledgeBaseId} activeSectionKey={activeSectionKey} onOpenDocument={openLinkedDocument} onOpenImage={() => setImageOpen(true)} compact /></section></div> : <div className="document-empty"><FolderOpen /><h2>暂无可预览文档</h2><p>请上传资料，或检查知识库服务连接后再刷新。</p></div>}
      </article></div>
    {imageOpen && <ImageLightbox onClose={() => setImageOpen(false)} />}
    {uploadCandidates.length > 0 && <Modal title={uploadIsArchive ? '上传 Markdown 压缩包' : uploadIsMultiple ? `批量上传 ${uploadCandidates.length} 个文档` : '上传知识资产'} onClose={() => setUploadCandidates([])}><div className="modal-form"><p>{uploadIsArchive ? '将保留 ZIP 内的目录结构，导入 Markdown/TXT，并保存其中被文档相对路径引用的 PNG、JPG、GIF、WebP 或 SVG 图片。' : uploadIsMultiple ? '所选 Markdown/TXT 将统一上传到目标目录，每个文件独立生成资产版本并进入活动索引。' : '文件将按逻辑路径保存到系统默认知识库目录，并生成不可变版本快照；索引切换完成后进入检索。'}</p><label>{uploadIsMultiple ? '已选文件' : '文件'}<input value={uploadIsMultiple ? `${uploadCandidates.length} 个：${uploadCandidates.map(file => file.name).join('、')}` : uploadCandidates[0].name} readOnly title={uploadCandidates.map(file => file.name).join('\n')} /></label><label>资料类型<input value={uploadAssetType} onChange={event => setUploadAssetType(event.target.value)} placeholder="输入资料类型" /></label><label>{uploadIsArchive || uploadIsMultiple ? '导入到目录（可留空）' : '知识库路径'}<input list="knowledge-upload-paths" value={uploadLogicalPath} onChange={event => setUploadLogicalPath(event.target.value)} placeholder={uploadIsArchive || uploadIsMultiple ? '输入或选择现有目录' : '输入或选择知识库路径'} /><small className="field-hint">可从现有知识库目录中选择，也可以直接输入新路径。</small></label><datalist id="knowledge-upload-paths">{uploadPathSuggestions.map(path => <option key={path} value={path} />)}</datalist><div className="modal-actions"><button className="btn ghost" onClick={() => setUploadCandidates([])}>取消</button><button className="btn primary" disabled={(!uploadIsArchive && !uploadIsMultiple && !uploadLogicalPath.trim()) || !uploadAssetType.trim() || uploadState === 'running'} onClick={() => void upload()}><Upload />确认上传</button></div></div></Modal>}
    {historyOpen && file && <Modal title="文档版本历史" onClose={() => setHistoryOpen(false)}><div className="history-list">{file.versions?.length ? [...file.versions].reverse().map(version => <div key={version.id}><b>V{version.number} · {version.status}</b><span>{new Date(version.createdAt).toLocaleString('zh-CN')} · {version.id}</span></div>) : <div><b>{file.version}</b><span>当前展示版本 · {file.updated}</span></div>}</div></Modal>}
    {moreOpen && file && <Modal title={`文件操作：${file.name}`} onClose={() => { if (!fileActionBusy) setMoreOpen(false) }}><div className="modal-form"><p>移动、重命名和删除会同步更新 PostgreSQL、系统默认文件目录与活动索引。</p><label>文件名称<input value={fileNameDraft} onChange={event => { setFileNameDraft(event.target.value); setFileActionError('') }} placeholder="document.md" /></label><div className="modal-actions"><button className="btn primary" disabled={fileActionBusy || !fileNameDraft.trim() || fileNameDraft === file.name} onClick={() => void renameFile()}><Pencil />保存名称</button></div><div className="move-directory"><label>移动至<select value={fileTargetDirectoryId} onChange={event => { setFileTargetDirectoryId(event.target.value); setFileActionError('') }}><option value={workspaceRootDirectoryId ?? ''}>/workspace</option>{directories.filter(directory => directory.persisted).map(directory => <option key={directory.id} value={directory.id}>{getDirectoryBreadcrumb(directory.id)}</option>)}</select></label><button className="btn primary" disabled={fileActionBusy || fileTargetDirectoryId === (file.parentId ?? workspaceRootDirectoryId ?? '')} onClick={() => void moveFile()}><FolderOpen />移动文件</button></div>{fileActionError && <small className="field-error">{fileActionError}</small>}<div className="modal-actions delete-modal-actions"><button className="btn ghost" disabled={fileActionBusy} onClick={() => setMoreOpen(false)}>取消</button><button className="btn danger" disabled={fileActionBusy} onClick={() => void deleteFile()}><Trash2 />删除文件</button></div></div></Modal>}
    {directoryEditor && <Modal title={directoryEditor.mode === 'create' ? '新建目录' : '重命名目录'} onClose={closeEditor}><div className="modal-form"><p>{directoryEditor.mode === 'create' ? `将在“${editorParentName}”中创建目录。` : '目录名称更新后，相关文档路径会同步更新。'} 变更会保存到知识库数据库。</p><label>目录名称<input value={directoryName} onChange={event => { setDirectoryName(event.target.value); setDirectoryNameError('') }} autoFocus placeholder="例如：接口规范" /></label>{directoryNameError && <small className="field-error">{directoryNameError}</small>}<div className="modal-actions"><button className="btn ghost" disabled={directorySaving} onClick={closeEditor}>取消</button><button className="btn primary" disabled={directorySaving} onClick={() => void saveDirectory()}>{directorySaving ? '保存中' : directoryEditor.mode === 'create' ? '创建目录' : '保存名称'}</button></div></div></Modal>}
    {deleteTarget && <Modal title={`删除目录：${deleteTarget.name}`} onClose={closeDelete}><div className="modal-form"><p>此目录包含 {deleteDirectoryIds.size - 1} 个子目录和 {deletedDocumentCount} 份文档。操作完成后会同步保存到知识库数据库。</p><div className="delete-summary"><span><FolderOpen />目录树</span><b>{deleteDirectoryIds.size} 个目录</b><span><FileText />文档</span><b>{deletedDocumentCount} 份</b></div><div className="move-directory"><label>移动内容至<select value={moveTargetId} onChange={event => setMoveTargetId(event.target.value)}><option value={workspaceRootDirectoryId ?? ''}>/workspace</option>{moveCandidates.filter(directory => directory.persisted).map(directory => <option key={directory.id} value={directory.id}>{getDirectoryBreadcrumb(directory.id)}</option>)}</select></label><button className="btn primary" onClick={() => void moveContents()}>移动内容并删除目录</button></div><div className="modal-actions delete-modal-actions"><button className="btn ghost" onClick={closeDelete}>取消</button><button className="btn danger" onClick={() => void deleteEverything()}><Trash2 />全部删除</button></div></div></Modal>}
  </section>
}

function makeSource(file: KnowledgeDocument) {
  return file.content ?? `# ${file.title}\n\n${file.intro}\n\n> 文档说明：当前为只读本地示例，不能保存或发布。\n\n${file.sections.map((section, index) => `## ${index + 1}. ${section}\n\n随着业务规模持续增长，本文档的示例内容覆盖主流程、异常处理和可追溯要求。\n\n${index === 0 ? '![统一支付与退款处理流程](assets/payment-flow.svg)' : ''}`).join('\n\n')}`
}

function SourceView({ source }: { source: string }) {
  return <div className="source-view"><div className="source-gutter">{source.split('\n').map((_, index) => <span key={index}>{index + 1}</span>)}</div><pre><code>{source}</code></pre></div>
}

const DocumentContent = forwardRef<HTMLDivElement, { file: KnowledgeDocument; source: string; format: 'markdown' | 'text'; outline: MarkdownOutline; knowledgeBaseId: string; activeSectionKey: string | null; onOpenDocument: (logicalPath: string) => void; onOpenImage: () => void; compact?: boolean }>(function DocumentContent({ file, source, format, outline, knowledgeBaseId, activeSectionKey, onOpenDocument, onOpenImage, compact = false }, ref) {
  const className = compact ? 'split-markdown' : 'markdown-view'
  if (file.content) {
    return <div ref={ref} className={className}><div className="document-meta"><Badge tone="blue">{format === 'text' ? 'TXT' : 'Markdown'}</Badge><span>版本 {file.version}</span><span>更新于 {file.updated}</span><Badge tone="green">已入活动索引</Badge></div><MarkdownDocument source={source} format={format} knowledgeBaseId={knowledgeBaseId} logicalPath={file.logicalPath} outline={outline} activeSectionKey={activeSectionKey} anchorPrefix={compact ? `split-${file.id}` : `preview-${file.id}`} onOpenKnowledgeDocument={onOpenDocument} /><div className="readonly-notice">固定资产版本：{file.assetVersionId} · 类型：{file.assetType}</div></div>
  }
  return <div ref={ref} className={className}><div className="document-meta"><Badge tone="blue">Markdown</Badge><span>版本 {file.version}</span><span>更新于 {file.updated}</span><Badge tone="orange">只读</Badge></div><h1>{file.title}</h1><p>{file.intro}</p><div className="md-callout"><CircleHelp size={18} /><div><b>只读原型说明</b><span>编辑、保存、发布和历史恢复需要后端服务；当前只能查看本地示例。</span></div></div>{outline.sections.map((section, index) => <section id={`preview-${file.id}-${section.key}`} data-document-section-key={section.key} className={activeSectionKey === section.key ? 'document-section-heading active-document-section' : 'document-section-heading'} key={section.key}><h2>{section.title}</h2><p>随着业务规模持续增长，原有流程在扩展性、异常恢复和统一治理方面逐渐暴露出不足。本地示例用于验证阅读、定位和视图切换交互。</p>{index === 0 && <button className="md-image" onClick={onOpenImage} aria-label="打开统一支付与退款处理流程原图"><img src="/assets/payment-flow.svg" alt="统一支付与退款处理流程" /><span><span>图 1：统一支付与退款处理流程</span><em>点击查看原图</em></span></button>}{index === 1 && <ul><li>统一核心流程及状态流转规则。</li><li>完善异常、超时和重试场景。</li><li>保留来源引用并支持版本追溯。</li></ul>}</section>)}</div>
})

function ImageLightbox({ onClose }: { onClose: () => void }) {
  const previousFocus = useRef<HTMLElement | null>(null)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') closeRef.current() }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previousFocus.current?.focus()
    }
  }, [])
  return <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="统一支付与退款处理流程原图" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><button aria-label="关闭原图" onClick={onClose} autoFocus><XCircle /></button><div onMouseDown={event => event.stopPropagation()}><img src="/assets/payment-flow.svg" alt="统一支付与退款处理流程原图" /><p>统一支付与退款处理流程 · 本地示例资源</p></div></div>
}

function SystemSettings({ knowledgeBaseId, notify, addAudit }: { knowledgeBaseId: string; notify: Notify; addAudit: (entry: string) => void }) {
  const items = [
    { name: '模型管理', desc: '模型、MCP、Skill 与工具资源管理', icon: Bot, group: 'AI 能力' },
    { name: 'Agent 配置', desc: '模型、提示词、工具和运行限制', icon: Sparkles, group: 'AI 能力' },
    { name: '知识库配置', desc: '同步、切分与检索策略', icon: BookOpen, group: '资源与集成' },
    { name: '代码与流水线', desc: 'Git、CI/CD 与执行器', icon: GitBranch, group: '资源与集成' },
    { name: '用户与权限', desc: '成员、角色与审批流程', icon: Users, group: '安全与治理' },
    { name: '环境与安全', desc: '密钥、数据保留与审计', icon: ShieldCheck, group: '安全与治理' },
  ]
  const [selected, setSelected] = useState(0)
  const [collapsed, setCollapsed] = useState(false)
  const [saved, setSaved] = useState<SettingsDraft>(initialSettings)
  const [draft, setDraft] = useState<SettingsDraft>(initialSettings)
  const [configVersion, setConfigVersion] = useState<number | null>(null)
  const [requiresRebuild, setRequiresRebuild] = useState(false)
  const [modelSourcesState, setModelSourcesState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [modelSourcesError, setModelSourcesError] = useState<string | null>(null)
  const [configLoaded, setConfigLoaded] = useState(false)
  const [agentConfiguration, setAgentConfiguration] = useState<AgentConfigurationState | null>(null)
  const [savedAgentDraft, setSavedAgentDraft] = useState<Record<AgentConfigurationAgentKey, AgentConfigurationAgentDraft> | null>(null)
  const [agentDraft, setAgentDraft] = useState<Record<AgentConfigurationAgentKey, AgentConfigurationAgentDraft> | null>(null)
  const [agentConfigState, setAgentConfigState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [agentConfigError, setAgentConfigError] = useState<string | null>(null)
  const [agentPublishing, setAgentPublishing] = useState(false)
  const editorScrollRef = useRef<HTMLDivElement>(null)
  const modelSourcesRequestRef = useRef(0)
  const agentConfigRequestRef = useRef(0)
  useEffect(() => () => {
    modelSourcesRequestRef.current += 1
    agentConfigRequestRef.current += 1
  }, [])
  const loadModelSources = useCallback(async () => {
    const requestId = ++modelSourcesRequestRef.current
    setModelSourcesState('loading')
    setModelSourcesError(null)
    try {
      const generativeSources = await loadGenerativeModelSources()
      if (requestId !== modelSourcesRequestRef.current) return generativeSources
      setSaved(current => ({ ...current, generativeSources, ...repairGenerativeRouting(generativeSources, new Set(), current) }))
      setDraft(current => ({ ...current, generativeSources, ...repairGenerativeRouting(generativeSources, new Set(), current) }))
      setModelSourcesState('ready')
      return generativeSources
    } catch (error) {
      if (requestId !== modelSourcesRequestRef.current) throw error
      const message = error instanceof Error ? error.message : '模型来源读取失败。'
      setModelSourcesState('failed')
      setModelSourcesError(message)
      throw error
    }
  }, [])
  const loadCurrentAgentConfiguration = useCallback(async () => {
    const requestId = ++agentConfigRequestRef.current
    setAgentConfigState('loading')
    setAgentConfigError(null)
    try {
      const configuration = await loadAgentConfiguration()
      if (requestId !== agentConfigRequestRef.current) return configuration
      const agentDrafts = Object.fromEntries(
        (Object.keys(agentConfigurationMetadata) as AgentConfigurationAgentKey[]).map(agentKey => [
          agentKey,
          configuration.agents[agentKey].draft,
        ]),
      ) as Record<AgentConfigurationAgentKey, AgentConfigurationAgentDraft>
      setAgentConfiguration(configuration)
      setSavedAgentDraft(agentDrafts)
      setAgentDraft(agentDrafts)
      setAgentConfigState('ready')
      return configuration
    } catch (error) {
      if (requestId !== agentConfigRequestRef.current) throw error
      const message = error instanceof Error ? error.message : 'Agent 配置读取失败。'
      setAgentConfigState('failed')
      setAgentConfigError(message)
      throw error
    }
  }, [])
  useEffect(() => {
    if ((selected !== 0 && selected !== 1) || modelSourcesState !== 'idle') return
    void loadModelSources().catch(() => undefined)
  }, [loadModelSources, modelSourcesState, selected])
  useEffect(() => {
    if (!knowledgeBaseId || selected !== 2 || configLoaded) return
    void loadConfig(knowledgeBaseId).then(value => {
      const config = value.config
      const mapped = { parserVersion: config.parserVersion, preprocessVersion: config.preprocessVersion, chunkSize: `${config.chunkTargetSize} tokens`, chunkMaxSize: String(config.chunkMaxSize), chunkOverlap: `${config.chunkOverlap} tokens`, headingDepth: String(config.headingDepth), embeddingSourceId: config.embeddingSourceId, embeddingSources: config.embeddingSources, embeddingMode: config.embeddingMode, embeddingBaseUrl: config.embeddingBaseUrl, embeddingApiKey: config.embeddingApiKey, embeddingModel: config.embeddingModel, embeddingDimensions: String(config.embeddingDimensions), embeddingBatchSize: String(config.embeddingBatchSize), embeddingTimeoutMs: String(config.embeddingTimeoutMs), embeddingRetries: String(config.embeddingRetries), vectorRecall: String(config.vectorRecall), keywordRecall: String(config.keywordRecall), finalResults: String(config.finalResults), relevanceThreshold: config.relevanceThreshold, hybridSearch: config.hybridSearch, rerankerEnabled: config.rerankerEnabled, rerankerSourceId: config.rerankerSourceId ?? config.embeddingSourceId, rerankerModel: config.rerankerModel }
      setSaved(current => ({ ...current, ...mapped }))
      setDraft(current => ({ ...current, ...mapped }))
      setConfigVersion(value.version); setRequiresRebuild(value.requiresRebuild); setConfigLoaded(true)
    }).catch(error => notify(error instanceof Error ? error.message : '知识库配置 API 未连接。', 'error'))
  }, [configLoaded, knowledgeBaseId, notify, selected])
  useEffect(() => {
    if (selected !== 1 || agentConfigState !== 'idle') return
    void loadCurrentAgentConfiguration().catch(() => undefined)
  }, [agentConfigState, loadCurrentAgentConfiguration, selected])
  const current = items[selected]
  const CurrentIcon = current.icon
  const settingsDirty = JSON.stringify(saved) !== JSON.stringify(draft)
  const agentDefinitionDirty = JSON.stringify(savedAgentDraft) !== JSON.stringify(agentDraft)
  const dirty = selected === 1 ? agentDefinitionDirty : settingsDirty
  useEffect(() => { editorScrollRef.current?.scrollTo({ top: 0 }) }, [selected])
  useEffect(() => { const warn = (event: BeforeUnloadEvent) => { if (!dirty) return; event.preventDefault(); event.returnValue = '' }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn) }, [dirty])
  const update = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => setDraft(currentDraft => ({ ...currentDraft, [key]: value }))
  const save = async () => {
    if (selected === 2 && knowledgeBaseId) {
      if (draft.embeddingModel && Number(draft.embeddingDimensions) <= 0) { notify('请先运行本地模型，或测试远程模型，以自动检测向量维度。'); return }
      const rerankerSource = draft.embeddingSources.find(source => source.id === draft.rerankerSourceId)
      const rerankerModel = rerankerSource?.models.find(model => model.name === draft.rerankerModel)
      if (draft.rerankerEnabled && (!rerankerSource || !rerankerModel)) { notify('请为 Reranker 选择有效的模型来源和模型。'); return }
      if (draft.rerankerEnabled && rerankerModel!.dimensions <= 0) { notify('请先运行或检测所选 Reranker 模型的向量维度。'); return }
      try {
        const result = await saveConfig(knowledgeBaseId, { parserVersion: draft.parserVersion, preprocessVersion: draft.preprocessVersion, chunkTargetSize: Number.parseInt(draft.chunkSize), chunkMaxSize: Number(draft.chunkMaxSize), chunkOverlap: Number.parseInt(draft.chunkOverlap), headingDepth: Number(draft.headingDepth), embeddingSourceId: draft.embeddingSourceId, embeddingSources: draft.embeddingSources, embeddingMode: draft.embeddingMode, embeddingBaseUrl: draft.embeddingBaseUrl, embeddingApiKey: draft.embeddingApiKey, embeddingModel: draft.embeddingModel, embeddingDimensions: Number(draft.embeddingDimensions), embeddingBatchSize: Number(draft.embeddingBatchSize), embeddingTimeoutMs: Number(draft.embeddingTimeoutMs), embeddingRetries: Number(draft.embeddingRetries), vectorRecall: Number(draft.vectorRecall), keywordRecall: Number(draft.keywordRecall), finalResults: Number(draft.finalResults), relevanceThreshold: draft.relevanceThreshold, hybridSearch: draft.hybridSearch, rerankerEnabled: draft.rerankerEnabled, rerankerSourceId: draft.rerankerSourceId, rerankerModel: draft.rerankerModel })
        setSaved(draft); setConfigVersion(result.configVersion.version); setRequiresRebuild(result.configVersion.requiresRebuild); addAudit(`保存知识库配置 V${result.configVersion.version}`); notify(result.impact === 'index_rebuild' ? '配置已保存；兼容性变更需要确认重建索引。' : result.impact === 'query' ? '检索配置已保存，无需重建索引。' : '知识库配置已保存。'); return
      } catch (error) { notify(error instanceof Error ? error.message : '配置保存失败'); return }
    }
    setSaved(draft); addAudit(`保存系统设置草稿：${current.name}`); notify('此模块尚未接入服务端，配置仅保存在当前会话。', 'warning')
  }
  const persistModelSources = async (nextSources: GenerativeSourceDraft[], removedModelIds: Set<string>) => {
    const generativeSources = await saveGenerativeModelSources(nextSources)
    const synchronize = (currentDraft: SettingsDraft) => ({ ...currentDraft, generativeSources, ...repairGenerativeRouting(generativeSources, removedModelIds, currentDraft) })
    setSaved(synchronize)
    setDraft(synchronize)
    addAudit('即时保存生成式模型来源和模型配置')
    return generativeSources
  }
  return <div className={`settings-layout ${collapsed ? 'directory-collapsed' : ''}`}><aside className={`card settings-directory ${collapsed ? 'collapsed' : ''}`}><div className="settings-dir-head"><b>配置目录</b><button className="icon-btn" title={collapsed ? '展开配置目录' : '收起配置目录'} aria-label={collapsed ? '展开配置目录' : '收起配置目录'} onClick={() => setCollapsed(value => !value)}>{collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button></div>{['AI 能力', '资源与集成', '安全与治理'].map(group => <div className="settings-group" key={group}><p>{group}</p>{items.map((item, index) => item.group === group && <button key={item.name} className={selected === index ? 'active' : ''} onClick={() => setSelected(index)}><item.icon /><span><b>{item.name}</b><small>{item.desc}</small></span><ChevronRight /></button>)}</div>)}</aside>
    <section className="card settings-editor">{selected !== 1 && <div className="settings-editor-head"><div className="setting-symbol"><CurrentIcon /></div><div><h2>{current.name}</h2><p>{current.desc}{selected === 2 && configVersion ? ` · 配置 V${configVersion}` : ''}</p></div>{selected !== 0 && <><Badge tone={dirty ? 'orange' : requiresRebuild && selected === 2 ? 'orange' : 'green'}>{dirty ? '有未保存更改' : requiresRebuild && selected === 2 ? '待重建' : '已保存'}</Badge><button className="btn primary" disabled={!dirty} onClick={() => void save()}><Check />保存配置</button></>}</div>}<div className="settings-editor-scroll" ref={editorScrollRef}>
      {selected === 0 && <ModelManagementSettings draft={draft} notify={notify} onPersistSources={persistModelSources} onHealthUpdated={source => {
        const mergeHealth = (sources: GenerativeSourceDraft[]) => sources.map(item => item.id !== source.id ? item : { ...item, health: source.health, models: item.models.map(model => {
          const checked = source.models.find(candidate => candidate.id === model.id)
          return checked ? { ...model, health: checked.health } : model
        }) })
        setDraft(current => ({ ...current, generativeSources: mergeHealth(current.generativeSources) }))
        setSaved(current => ({ ...current, generativeSources: mergeHealth(current.generativeSources) }))
      }} />}
      {selected === 1 && agentDraft && agentConfiguration && <PromptAgentSettings draft={draft} notify={notify} agentDraft={agentDraft} updateAgent={value => setAgentDraft(current => typeof value === 'function' ? current ? value(current) : current : value)} configuration={agentConfiguration} configurationError={agentConfigError} modelSourcesState={modelSourcesState} modelSourcesError={modelSourcesError} onRetryConfiguration={() => void loadCurrentAgentConfiguration().catch(() => undefined)} onRetryModelSources={() => void loadModelSources().catch(() => undefined)} publishing={agentPublishing} onPublish={async agentKey => {
        setAgentPublishing(true)
        try {
          const nextDraft = materializeRequiredAgentCapabilities(agentDraft[agentKey], agentConfiguration.agents[agentKey])
          const persisted = await saveAgentConfigurationDraft(agentKey, nextDraft)
          setAgentDraft(current => current ? { ...current, [agentKey]: persisted } : current)
          setSavedAgentDraft(current => current ? { ...current, [agentKey]: persisted } : current)
          setAgentConfiguration(current => current ? { ...current, agents: { ...current.agents, [agentKey]: { ...current.agents[agentKey], draft: persisted } } } : current)
          const published = await publishAgentConfiguration(agentKey, persisted.revision)
          const metadata = agentConfigurationMetadata[agentKey]
          const label = metadata.label
          addAudit(`发布${label}配置 V${published.version}`)
          notify(`${label} V${published.version} 已发布，${metadata.publishTarget}将固定使用该版本。`)
          void loadCurrentAgentConfiguration().catch(error => notify(error instanceof Error ? `版本已发布，但配置刷新失败：${error.message}` : '版本已发布，但配置刷新失败。', 'warning'))
        } catch (error) { notify(error instanceof Error ? error.message : 'Agent 配置发布失败', 'error') }
        finally { setAgentPublishing(false) }
      }} />}
      {selected === 1 && !agentDraft && agentConfigState !== 'failed' && <AgentConfigurationLoading />}
      {selected === 1 && !agentDraft && agentConfigState === 'failed' && <AgentConfigurationFailure error={agentConfigError} onRetry={() => void loadCurrentAgentConfiguration().catch(() => undefined)} />}
      {selected === 2 && <div className="settings-form">
        <FormSection title="向量模型配置" desc="集中管理多个来源和模型，再选择知识库实际使用的来源与模型"><EmbeddingModelPrototype knowledgeBaseId={knowledgeBaseId} draft={draft} update={update} notify={notify} /></FormSection>
        <FormSection title="Markdown 切分" desc="按模型 tokenizer 计数；修改后需要重建索引"><FormRow label="目标 Chunk 大小" help="默认 400 tokens，达到目标后优先在 Markdown 结构边界切分"><select value={draft.chunkSize} onChange={event => { const value = event.target.value; const target = Number.parseInt(value); update('chunkSize', value); if (target > Number(draft.chunkMaxSize)) update('chunkMaxSize', String(target === 600 ? 800 : target)) }}><option>300 tokens</option><option>400 tokens</option><option>600 tokens</option><option>800 tokens</option></select></FormRow><FormRow label="最大 Chunk 大小" help="普通文本不会超过该值；代码块和表格优先保持完整"><select value={draft.chunkMaxSize} onChange={event => { const value = event.target.value; update('chunkMaxSize', value); if (Number.parseInt(draft.chunkSize) > Number(value)) update('chunkSize', `${Math.min(Number(value), 400)} tokens`) }}><option>400</option><option>480</option><option>800</option><option>1200</option></select></FormRow><FormRow label="Chunk 重叠" help="仅在同一标题内切出相邻块时保留尾部上下文"><select value={draft.chunkOverlap} onChange={event => update('chunkOverlap', event.target.value)}><option>0 tokens</option><option>50 tokens</option><option>80 tokens</option><option>120 tokens</option></select></FormRow></FormSection>
        <FormSection title="检索与索引" desc="调整检索参数并管理向量索引"><RetrievalIndexConfig knowledgeBaseId={knowledgeBaseId} requiresRebuild={requiresRebuild} onRebuilt={() => setRequiresRebuild(false)} draft={draft} update={update} notify={notify} /></FormSection>
      </div>}
      {selected === 3 && <div className="settings-form"><FormSection title="代码仓库" desc="当前仅保存本地草稿，不会连接仓库"><FormRow label="仓库地址" help="刷新页面后恢复示例地址"><input value={draft.repositoryUrl} onChange={event => update('repositoryUrl', event.target.value)} /></FormRow><FormRow label="默认分支" help="用于示例基线比较"><input value={draft.defaultBranch} onChange={event => update('defaultBranch', event.target.value)} /></FormRow></FormSection></div>}
      {selected === 4 && <StaticSettings title="访问控制" text="成员、角色和审批流程尚未接入服务端；当前页面仅展示本地原型说明。" />}
      {selected === 5 && <div className="settings-form"><FormSection title="数据安全" desc="安全策略可在本次会话中作为草稿保存"><SwitchRow title="启用完整审计" desc="记录当前会话中的本地模拟操作" checked={draft.auditEnabled} onChange={value => update('auditEnabled', value)} /></FormSection></div>}
    </div></section></div>
}

function StaticSettings({ title, text }: { title: string; text: string }) { return <div className="settings-form"><FormSection title={title} desc={text}><p className="readonly-notice">此项没有后端支撑，因此不伪造成功、连接或持久化状态。</p></FormSection></div> }

function AgentConfigurationLoading() { return <div className="page-loading" role="status"><RefreshCw /><span>正在读取服务端 Agent 配置…</span></div> }

function AgentConfigurationFailure({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return <div className="agent-configuration-status failed" role="alert"><AlertTriangle /><div><b>Agent 配置读取失败</b><span>{error ?? '请确认服务端已启动后重新加载。'}</span></div><button className="btn ghost" onClick={onRetry}><RefreshCw />重新加载</button></div>
}

type GenerativeSourceEditor = { id?: string; name: string; providerType: GenerativeSourceDraft['providerType']; baseUrl: string; apiKey: string; models: GenerativeModelDraft[] }

type GenerativeSourceEditorErrors = { source?: string; modelList?: string; models?: Record<string, string> }

type GenerativeModelCapabilities = Pick<GenerativeModelDraft, 'capabilities'>

const genericModelCapabilities = (): GenerativeModelCapabilities => ({ capabilities: ['tool_calling'] })
const modelCapabilityDefaults = (providerType: GenerativeSourceDraft['providerType'], name: string): GenerativeModelCapabilities => {
  if (providerType === 'openai' && /^gpt-5\.6(?:-(?:sol|terra|luna))?$/iu.test(name.trim())) {
    return { capabilities: ['tool_calling', 'reasoning', 'vision'] }
  }
  return genericModelCapabilities()
}
const sameModelCapabilities = (model: GenerativeModelDraft, defaults: GenerativeModelCapabilities) => [...model.capabilities].sort().join('\u0000') === [...defaults.capabilities].sort().join('\u0000')
const createGenerativeModel = (providerType: GenerativeSourceDraft['providerType'], discovered?: { name: string; displayName: string }): GenerativeModelDraft => ({
  id: crypto.randomUUID(),
  name: discovered?.name ?? '',
  displayName: discovered?.displayName ?? '',
  ...modelCapabilityDefaults(providerType, discovered?.name ?? ''),
  enabled: true,
  health: 'unknown',
})

const repairGenerativeRouting = (nextSources: GenerativeSourceDraft[], removedModelIds: ReadonlySet<string>, draft: Pick<SettingsDraft, 'mainModel' | 'fallbackModelIds'>) => {
  const models = nextSources.flatMap(source => source.models.map(model => ({ ...model, source })))
  const availableIds = new Set(models.map(model => model.id))
  const mainModel = removedModelIds.has(draft.mainModel) || !availableIds.has(draft.mainModel) ? models.find(model => model.source.enabled && model.enabled)?.id ?? '' : draft.mainModel
  const fallbackModelIds = [...new Set(draft.fallbackModelIds)].filter(id => availableIds.has(id) && !removedModelIds.has(id) && id !== mainModel)
  return { mainModel, fallbackModelIds }
}

function ModelManagementSettings({ draft, notify, onPersistSources, onHealthUpdated }: { draft: SettingsDraft; notify: Notify; onPersistSources: (sources: GenerativeSourceDraft[], removedModelIds: Set<string>) => Promise<GenerativeSourceDraft[]>; onHealthUpdated: (source: GenerativeSourceDraft) => void }) {
  const [catalogTab, setCatalogTab] = useState<'model' | AiResourceKind>('model')
  const [sourceEditor, setSourceEditor] = useState<GenerativeSourceEditor | null>(null)
  const [sourceEditorErrors, setSourceEditorErrors] = useState<GenerativeSourceEditorErrors>({})
  const [testingModelId, setTestingModelId] = useState('')
  const [savingSourceId, setSavingSourceId] = useState('')
  const sources = draft.generativeSources
  const providerLabel = (type: GenerativeSourceDraft['providerType']) => type === 'openai' ? 'OpenAI' : type === 'anthropic' ? 'Anthropic' : 'OpenAI Compatible'
  const persistSources = async (nextSources: GenerativeSourceDraft[], removedModelIds: Set<string>, operationId: string, message: string) => {
    setSavingSourceId(operationId)
    try { await onPersistSources(nextSources, removedModelIds); notify(message); return true }
    catch (error) { notify(error instanceof Error ? error.message : '模型来源保存失败', 'error'); return false }
    finally { setSavingSourceId('') }
  }
  const updateSource = async (id: string, patch: Partial<GenerativeSourceDraft>) => {
    const nextSources = sources.map(source => source.id === id ? { ...source, ...patch } : source)
    await persistSources(nextSources, new Set(), id, patch.enabled === false ? '模型来源已停用。' : '模型来源已启用。')
  }
  const deleteSource = async (source: GenerativeSourceDraft) => {
    if (!window.confirm(`移除模型来源“${source.name}”？该操作会立即写入服务端。`)) return
    const removedIds = new Set(source.models.map(model => model.id)); const remaining = sources.filter(item => item.id !== source.id)
    await persistSources(remaining, removedIds, source.id, `模型来源“${source.name}”已删除。`)
  }
  const openSourceEditor = (source?: GenerativeSourceDraft) => {
    setSourceEditorErrors({})
    setSourceEditor(source ? { id: source.id, name: source.name, providerType: source.providerType, baseUrl: source.baseUrl, apiKey: '', models: source.models.map(model => ({ ...model, capabilities: [...model.capabilities] })) } : { name: '', providerType: 'openai_compatible', baseUrl: '', apiKey: '', models: [] })
  }
  const updateEditorModel = (id: string, patch: Partial<GenerativeModelDraft>) => setSourceEditor(current => current && { ...current, models: current.models.map(model => model.id === id ? { ...model, ...patch } : model) })
  const updateEditorModelName = (id: string, name: string) => setSourceEditor(current => {
    if (!current) return current
    return {
      ...current,
      models: current.models.map(model => {
        if (model.id !== id) return model
        const previousDefaults = modelCapabilityDefaults(current.providerType, model.name)
        const nextDefaults = modelCapabilityDefaults(current.providerType, name)
        return { ...model, name, ...(sameModelCapabilities(model, previousDefaults) ? nextDefaults : {}) }
      }),
    }
  })
  const addEditorModel = () => { setSourceEditorErrors(current => ({ ...current, modelList: undefined })); setSourceEditor(current => current && { ...current, models: [...current.models, createGenerativeModel(current.providerType)] }) }
  const discoverModels = async () => {
    if (!sourceEditor) return
    try {
      const discovered = await discoverGenerativeModels(sourceEditor)
      if (discovered.length) setSourceEditorErrors(errors => ({ ...errors, modelList: undefined }))
      setSourceEditor(current => {
        if (!current) return current
        const knownNames = new Set(current.models.map(model => model.name.trim().toLocaleLowerCase()))
        const additions = discovered.filter(model => !knownNames.has(model.name.toLocaleLowerCase())).map(model => createGenerativeModel(current.providerType, model))
        return additions.length ? { ...current, models: [...current.models, ...additions] } : current
      })
      notify(discovered.length ? `已从部署端点获取 ${discovered.length} 个模型。` : '部署端点未返回可用模型。', discovered.length ? 'success' : 'warning')
    } catch (error) { notify(error instanceof Error ? error.message : '获取模型失败', 'error') }
  }
  const removeEditorModel = (id: string) => setSourceEditor(current => current ? { ...current, models: current.models.filter(model => model.id !== id) } : current)
  const testModelConnection = async (source: GenerativeSourceDraft, model: GenerativeModelDraft) => {
    if (!source.enabled || !model.enabled) { notify('请先启用模型来源和模型后再测试。', 'warning'); return }
    setTestingModelId(model.id)
    try {
      const result = await probeGenerativeModel(source.id, model.id)
      onHealthUpdated(result.source)
      notify(`${model.displayName}：${result.message}`, result.ok ? 'success' : 'error')
    } catch (error) { notify(error instanceof Error ? error.message : '模型连通性测试失败', 'error') }
    finally { setTestingModelId('') }
  }
  const saveSource = async () => {
    if (!sourceEditor) return
    const name = sourceEditor.name.trim(); const baseUrl = sourceEditor.baseUrl.trim(); const apiKey = sourceEditor.apiKey.trim()
    const normalizedModels = sourceEditor.models.map(model => ({ ...model, name: model.name.trim(), displayName: model.displayName.trim(), capabilities: [...new Set(model.capabilities)] }))
    const modelErrors: Record<string, string> = {}; const names = new Set<string>()
    for (const model of normalizedModels) {
      if (!model.name || !model.displayName) modelErrors[model.id] = '请填写模型标识和展示名称。'
      const key = model.name.toLocaleLowerCase()
      if (key && names.has(key)) modelErrors[model.id] = '同一来源不能有重复的模型标识。'
      names.add(key)
    }
    const sourceError = !name || !baseUrl ? '请完整填写来源名称和 Base URL。' : undefined
    const modelListError = normalizedModels.length ? undefined : '请先获取当前配置模型或手动添加至少一个模型。'
    if (sourceError || modelListError || Object.keys(modelErrors).length) { setSourceEditorErrors({ source: sourceError, modelList: modelListError, models: modelErrors }); notify('请修正来源和模型配置。', 'warning'); return }
    const source: GenerativeSourceDraft | null = sourceEditor.id ? (() => {
      const existingSource = sources.find(item => item.id === sourceEditor.id)
      if (!existingSource) return null
      return { ...existingSource, name, providerType: sourceEditor.providerType, baseUrl, apiKey, models: normalizedModels }
    })() : { id: crypto.randomUUID(), name, providerType: sourceEditor.providerType, baseUrl, apiKey, enabled: true, health: 'unknown', priority: sources.length + 1, models: normalizedModels }
    if (!source) { notify('模型来源不存在，无法保存修改。', 'warning'); return }
    const existing = sources.find(item => item.id === source.id)
    const removedIds = new Set(existing ? existing.models.filter(model => !source.models.some(next => next.id === model.id)).map(model => model.id) : [])
    const nextSources = existing ? sources.map(item => item.id === source.id ? source : item) : [...sources, source]
    const saved = await persistSources(nextSources, removedIds, source.id, existing ? '模型来源修改已保存。' : '模型来源已添加。')
    if (saved) { setSourceEditor(null); setSourceEditorErrors({}) }
  }
  return <div className="model-config-page">
    <nav className="ai-catalog-tabs" aria-label="AI 资源管理类型">
      <button className={catalogTab === 'model' ? 'active' : ''} onClick={() => setCatalogTab('model')}><Bot /><span><b>模型</b><small>来源与能力</small></span></button>
      <button className={catalogTab === 'mcp' ? 'active' : ''} onClick={() => setCatalogTab('mcp')}><Server /><span><b>MCP</b><small>远程工具服务</small></span></button>
      <button className={catalogTab === 'skill' ? 'active' : ''} onClick={() => setCatalogTab('skill')}><Sparkles /><span><b>Skill</b><small>可复用工作流</small></span></button>
      <button className={catalogTab === 'tool' ? 'active' : ''} onClick={() => setCatalogTab('tool')}><ShieldCheck /><span><b>工具</b><small>确定性动作</small></span></button>
    </nav>
    {catalogTab === 'model' ? <>
    <div className="model-config-panel"><ModelPanelHead title="模型来源" desc="统一维护可供各 Agent 使用的生成式模型渠道；所有变更即时保存到服务端。"><button className="btn primary" disabled={Boolean(savingSourceId)} onClick={() => openSourceEditor()}><Plus />添加来源</button></ModelPanelHead><div className="generative-source-grid">{sources.map(source => <article className={`generative-source-card ${source.enabled ? '' : 'disabled'}`} key={source.id} aria-label={`${source.name} 模型来源`}><header><div className="source-logo"><Server /></div><div><b>{source.name}</b><small>{providerLabel(source.providerType)}</small></div><Badge tone={source.enabled ? modelHealthTone(source.health) : 'gray'}>{savingSourceId === source.id ? '保存中' : source.enabled ? modelHealthLabel(source.health) : '已停用'}</Badge><label className="switch"><input type="checkbox" checked={source.enabled} disabled={Boolean(savingSourceId)} onChange={event => void updateSource(source.id, { enabled: event.target.checked })} aria-label={`启用 ${source.name}`} /><i /></label></header><div className="source-reference"><span>Base URL<b>{source.baseUrl}</b></span></div><div className="source-model-chips">{source.models.map(model => <button type="button" key={model.id} disabled={Boolean(savingSourceId) || !source.enabled || !model.enabled || testingModelId === model.id} onClick={() => testModelConnection(source, model)} title={`测试 ${model.displayName} 连通性`} aria-label={`测试 ${model.displayName} 连通性`}><i className={model.health} aria-hidden="true" /><span>{testingModelId === model.id ? '测试中…' : model.displayName}</span></button>)}</div><footer><span>{source.models.length} 个模型</span><div><button className="icon-btn" disabled={Boolean(savingSourceId)} onClick={() => openSourceEditor(source)} title={`编辑来源 ${source.name}`} aria-label={`编辑来源 ${source.name}`}><Pencil /></button><button className="icon-btn danger-text" disabled={Boolean(savingSourceId)} onClick={() => void deleteSource(source)} title={`移除来源 ${source.name}`} aria-label={`移除来源 ${source.name}`}><Trash2 /></button></div></footer></article>)}</div></div>
    {sources.length === 0 && <div className="model-source-empty"><Server /><b>尚未配置生成式模型来源</b><span>填写 Base URL、API Key 和模型并提交，即可进行真实发现与连通性探测。</span></div>}
    {sourceEditor && <Modal title={sourceEditor.id ? '编辑生成式模型来源' : '添加生成式模型来源'} className="model-source-modal" onClose={() => { setSourceEditor(null); setSourceEditorErrors({}) }}><div className="modal-form"><div className="model-source-modal-content"><p>Base URL 和 API Key 由服务端保存；读取配置时不会回显 API Key。</p><label>来源名称<input value={sourceEditor.name} onChange={event => setSourceEditor(current => current && { ...current, name: event.target.value })} placeholder="例如：OpenAI 灾备渠道" /></label><label>协议类型<select value={sourceEditor.providerType} onChange={event => setSourceEditor(current => current && { ...current, providerType: event.target.value as GenerativeSourceDraft['providerType'] })}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="openai_compatible">OpenAI Compatible</option></select></label><label>Base URL<input value={sourceEditor.baseUrl} onChange={event => setSourceEditor(current => current && { ...current, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label><label>API Key（可选）<input type="password" value={sourceEditor.apiKey} onChange={event => setSourceEditor(current => current && { ...current, apiKey: event.target.value })} placeholder={sourceEditor.id ? '留空保留已保存的 API Key' : '无需鉴权时可留空'} /></label>{sourceEditorErrors.source && <span className="field-error">{sourceEditorErrors.source}</span>}<section className="generative-model-editor"><header><div><b>模型配置</b><small>端点发现只返回模型标识；保存前请确认模型能力。</small></div><div className="generative-model-editor-actions"><button type="button" className="btn ghost" onClick={discoverModels}><RefreshCw />获取当前配置模型</button><button type="button" className="btn ghost" onClick={addEditorModel}><Plus />手动添加模型</button></div></header>{sourceEditorErrors.modelList && <span className="field-error">{sourceEditorErrors.modelList}</span>}<div>{sourceEditor.models.map((model, index) => <article key={model.id}><header><div><b>模型 {index + 1}</b>{model.id === draft.mainModel && <Badge tone="green">默认模型</Badge>}{draft.fallbackModelIds.includes(model.id) && <Badge tone="purple">回退模型</Badge>}</div><button type="button" className="icon-btn danger-text" title={`移除模型 ${model.displayName || model.name || index + 1}`} aria-label={`移除模型 ${model.displayName || model.name || index + 1}`} onClick={() => removeEditorModel(model.id)}><Trash2 /></button></header><div className="generative-model-fields"><label>模型标识<input value={model.name} onChange={event => updateEditorModelName(model.id, event.target.value)} placeholder="gpt-5.6-terra" /></label><label>展示名称<input value={model.displayName} onChange={event => updateEditorModel(model.id, { displayName: event.target.value })} placeholder="GPT-5.6 Terra" /></label></div><div className="generative-model-options"><span>能力</span>{(['tool_calling', 'reasoning', 'vision'] as const).map(capability => <label key={capability}><input type="checkbox" checked={model.capabilities.includes(capability)} onChange={event => updateEditorModel(model.id, { capabilities: event.target.checked ? [...model.capabilities, capability] : model.capabilities.filter(item => item !== capability) })} />{capability === 'tool_calling' ? '工具调用' : capability === 'reasoning' ? '推理' : '视觉'}</label>)}<label className="model-enabled"><input type="checkbox" checked={model.enabled} onChange={event => updateEditorModel(model.id, { enabled: event.target.checked })} />启用模型</label></div>{sourceEditorErrors.models?.[model.id] && <span className="field-error">{sourceEditorErrors.models[model.id]}</span>}</article>)}</div></section></div><div className="modal-actions"><button className="btn ghost" disabled={Boolean(savingSourceId)} onClick={() => { setSourceEditor(null); setSourceEditorErrors({}) }}>取消</button><button className="btn primary" disabled={Boolean(savingSourceId)} onClick={() => void saveSource()}>{sourceEditor.id ? <Check /> : <Plus />}{savingSourceId ? '保存中…' : sourceEditor.id ? '保存修改' : '添加来源'}</button></div></div></Modal>}
    </> : <AiResourceManagement kind={catalogTab} notify={notify} />}
  </div>
}

type AiResourceEditor = {
  id?: string
  kind: AiResourceKind
  key: string
  name: string
  description: string
  version: string
  enabled: boolean
  transport: McpServerResource['transport']
  endpoint: string
  authType: McpServerResource['authType']
  credentialEnv: string
  entrypoint: string
  skillMode: 'zip' | 'entrypoint'
  packageFile: File | null
  package?: SkillPackageMetadata
  toolIds: string[]
  tags: string
  source: ToolResource['source']
  risk: ToolResource['risk']
  timeoutMs: number
  sourcePath: string
  mcpServerId: string
  parametersJson: string
}

function AiResourceManagement({ kind, notify }: { kind: AiResourceKind; notify: Notify }) {
  const [catalog, setCatalog] = useState<AiResourceCatalog | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')
  const [editor, setEditor] = useState<AiResourceEditor | null>(null)
  const [sourceViewer, setSourceViewer] = useState<ToolSource | null>(null)
  const [sourceLoadingId, setSourceLoadingId] = useState('')
  const load = useCallback(async (silent = false) => {
    if (!silent) { setLoading(true); setError('') }
    try {
      const nextCatalog = await loadAiResources()
      setCatalog(nextCatalog)
      setError('')
      return nextCatalog
    } catch (loadError) {
      if (!silent) setError(loadError instanceof Error ? loadError.message : 'AI 资源目录读取失败')
      return null
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(true), 1000)
    return () => window.clearInterval(timer)
  }, [load])
  const resources: AiResource[] = catalog ? kind === 'mcp' ? catalog.mcpServers : kind === 'skill' ? catalog.skills : catalog.tools : []
  const title = kind === 'mcp' ? 'MCP 服务' : kind === 'skill' ? 'Skill' : '工具'
  const description = kind === 'mcp' ? '注册远程 MCP 服务及其暴露的工具范围；当前只允许 HTTP/S 传输。' : kind === 'skill' ? '维护可复用专业方法与外部依赖；Agent 发布版本绑定 Catalog，运行时按需读取正文。' : '统一治理可独立配置的内置、本地、HTTP 与 MCP 工具。'
  const openCreate = () => setEditor({ kind, key: '', name: '', description: '', version: '1.0.0', enabled: true, transport: 'streamable_http', endpoint: '', authType: 'none', credentialEnv: '', entrypoint: '', skillMode: kind === 'skill' ? 'zip' : 'entrypoint', packageFile: null, toolIds: [], tags: '', source: kind === 'tool' ? 'local' : 'builtin', risk: 'read', timeoutMs: 30_000, sourcePath: '', mcpServerId: '', parametersJson: '{\n  "type": "object",\n  "properties": {}\n}' })
  const openEdit = (resource: AiResource) => setEditor({
    id: resource.id, kind: resource.kind, key: resource.key, name: resource.name, description: resource.description, version: resource.version, enabled: resource.enabled,
    transport: resource.kind === 'mcp' ? resource.transport : 'streamable_http', endpoint: resource.kind === 'mcp' ? resource.endpoint : resource.kind === 'tool' ? resource.endpoint ?? '' : '', authType: resource.kind === 'mcp' ? resource.authType : resource.kind === 'tool' ? resource.authType ?? 'none' : 'none', credentialEnv: resource.kind === 'mcp' ? resource.credentialEnv ?? '' : resource.kind === 'tool' ? resource.credentialEnv ?? '' : '',
    entrypoint: resource.kind === 'skill' ? resource.entrypoint : '', skillMode: resource.kind === 'skill' && resource.package ? 'zip' : 'entrypoint', packageFile: null, package: resource.kind === 'skill' ? resource.package : undefined, toolIds: resource.kind === 'tool' ? [] : [...resource.toolIds], tags: resource.kind === 'skill' ? resource.tags.join(', ') : '',
    source: resource.kind === 'tool' ? resource.source : 'local', risk: resource.kind === 'tool' ? resource.risk : 'read', timeoutMs: resource.kind === 'tool' ? resource.timeoutMs : 30_000, sourcePath: resource.kind === 'tool' ? resource.sourcePath ?? '' : '', mcpServerId: resource.kind === 'tool' ? resource.mcpServerId ?? '' : '', parametersJson: resource.kind === 'tool' ? JSON.stringify(resource.parameters ?? { type: 'object', properties: {} }, null, 2) : '{\n  "type": "object",\n  "properties": {}\n}',
  })
  const persist = async () => {
    if (!editor) return
    setBusyId(editor.id ?? 'new')
    try {
      const common = { key: editor.key, name: editor.name, description: editor.description, version: editor.version, enabled: editor.enabled }
      const payload = editor.kind === 'mcp'
        ? { ...common, transport: editor.transport, endpoint: editor.endpoint, authType: editor.authType, credentialEnv: editor.authType === 'none' ? undefined : editor.credentialEnv || undefined, toolIds: editor.toolIds }
        : editor.kind === 'skill'
          ? { ...common, entrypoint: editor.entrypoint, toolIds: editor.toolIds, tags: editor.tags.split(',').map(item => item.trim()).filter(Boolean) }
          : { ...common, source: editor.source, risk: editor.risk, timeoutMs: editor.timeoutMs, sourcePath: editor.source === 'local' ? editor.sourcePath : undefined, mcpServerId: editor.source === 'mcp' ? editor.mcpServerId : undefined, endpoint: editor.source === 'http' ? editor.endpoint : undefined, authType: editor.source === 'http' ? editor.authType : undefined, credentialEnv: editor.source === 'http' && editor.authType === 'bearer' ? editor.credentialEnv || undefined : undefined, parameters: editor.source === 'http' ? JSON.parse(editor.parametersJson) : undefined }
      if (editor.id) await updateAiResource(editor.kind, editor.id, payload)
      else if (editor.kind === 'skill' && editor.skillMode === 'zip') {
        if (!editor.packageFile) throw new Error('请选择 Skill ZIP 包')
        if (editor.packageFile.size > 20 * 1024 * 1024) throw new Error('Skill ZIP 不能超过 20 MB')
        await uploadSkillPackage(payload, editor.packageFile)
      } else await createAiResource(editor.kind, payload)
      setEditor(null); await load(); notify(`${title}${editor.id ? '已更新' : '已添加'}并持久化。`)
    } catch (saveError) { notify(saveError instanceof Error ? saveError.message : `${title}保存失败`, 'error') }
    finally { setBusyId('') }
  }
  const toggle = async (resource: AiResource) => {
    if (resource.builtIn) return
    setBusyId(resource.id)
    try { await updateAiResource(resource.kind, resource.id, { enabled: !resource.enabled }); await load(); notify(`${resource.name} 已${resource.enabled ? '停用' : '启用'}。`) }
    catch (toggleError) { notify(toggleError instanceof Error ? toggleError.message : '状态更新失败', 'error') }
    finally { setBusyId('') }
  }
  const remove = async (resource: AiResource) => {
    if (!window.confirm(`删除${title}“${resource.name}”？该操作将立即写入服务端。`)) return
    setBusyId(resource.id)
    try { await deleteAiResource(resource.kind, resource.id); await load(); notify(`${resource.name} 已删除。`) }
    catch (deleteError) { notify(deleteError instanceof Error ? deleteError.message : '资源删除失败', 'error') }
    finally { setBusyId('') }
  }
  const viewSource = async (resource: ToolResource) => {
    setSourceLoadingId(resource.id)
    try { setSourceViewer(await loadToolSource(resource.id)) }
    catch (sourceError) {
      const refreshedCatalog = await load(true)
      if (refreshedCatalog && !refreshedCatalog.tools.some(tool => tool.id === resource.id)) return
      notify(sourceError instanceof Error ? sourceError.message : '工具源码读取失败', 'error')
    }
    finally { setSourceLoadingId('') }
  }
  return <section className="model-config-panel ai-resource-panel">
    <ModelPanelHead title={title} desc={description}><span className="ai-resource-head-actions"><Badge tone="purple">{resources.length} 项</Badge><button className="btn primary" onClick={openCreate}><Plus />添加{title}</button></span></ModelPanelHead>
    {loading && <div className="ai-resource-state"><RefreshCw className="document-loading-icon" /><span>正在读取 AI 资源目录…</span></div>}
    {!loading && error && <div className="ai-resource-state failed"><AlertTriangle /><span><b>读取失败</b><small>{error}</small></span><button className="btn ghost" onClick={() => void load()}><RefreshCw />重试</button></div>}
    {!loading && !error && resources.length === 0 && <div className="ai-resource-empty"><CurrentAiResourceIcon kind={kind} /><b>尚未注册{title}</b><span>点击“添加{title}”创建首个服务端资源记录。</span></div>}
    {!loading && !error && resources.length > 0 && <div className="ai-resource-list">{resources.map(resource => <article className={resource.enabled ? '' : 'disabled'} key={resource.id}>
      <div className="ai-resource-icon"><CurrentAiResourceIcon kind={resource.kind} /></div><div className="ai-resource-main"><header><b>{resource.name}</b><Badge tone={resource.status === 'ready' ? 'green' : 'orange'}>{resource.status === 'ready' ? '可用' : '待接入'}</Badge>{resource.builtIn && <Badge tone="blue">内置</Badge>}{resource.managedBy === 'filesystem' && <Badge tone="purple">外置</Badge>}</header><code>{resource.key}@{resource.version}</code><p>{resource.description || '暂无描述'}</p><ResourceMetadata resource={resource} catalog={catalog} /></div>
      <div className="ai-resource-actions"><label className="switch" title={resource.builtIn ? '内置 Tool 和 Skill 始终启用，不可关闭' : undefined}><input type="checkbox" checked={resource.enabled} disabled={resource.builtIn || busyId === resource.id} onChange={() => void toggle(resource)} aria-label={resource.builtIn ? `${resource.name} 为内置资源，始终启用` : `${resource.enabled ? '停用' : '启用'} ${resource.name}`} /><i /></label>{resource.kind === 'tool' && ['builtin', 'local'].includes(resource.source) && resource.sourcePath && <button className="icon-btn source-code-button" disabled={sourceLoadingId === resource.id} title="查看源码" aria-label={`查看 ${resource.name} 源码`} onClick={() => void viewSource(resource)}>{sourceLoadingId === resource.id ? <RefreshCw className="document-loading-icon" /> : <Code2 />}</button>}{!resource.builtIn && resource.managedBy !== 'filesystem' && <button className="icon-btn" disabled={busyId === resource.id} onClick={() => openEdit(resource)} aria-label={`编辑 ${resource.name}`}><Pencil /></button>}{!resource.builtIn && resource.managedBy !== 'filesystem' && <button className="icon-btn danger-text" disabled={busyId === resource.id} onClick={() => void remove(resource)} aria-label={`删除 ${resource.name}`}><Trash2 /></button>}</div>
    </article>)}</div>}
    {editor && <Modal title={`${editor.id ? '编辑' : '添加'}${title}`} className="ai-resource-modal" onClose={() => setEditor(null)}><div className="modal-form ai-resource-form"><div className="ai-resource-common-fields"><label>资源标识<input value={editor.key} disabled={Boolean(editor.id)} onChange={event => setEditor(current => current && { ...current, key: event.target.value })} placeholder={kind === 'mcp' ? 'github.mcp' : kind === 'skill' ? 'requirement.analysis' : 'quality.check'} /></label><label>名称<input value={editor.name} onChange={event => setEditor(current => current && { ...current, name: event.target.value })} placeholder={`${title}展示名称`} /></label><label>版本<input value={editor.version} disabled={Boolean(editor.package)} onChange={event => setEditor(current => current && { ...current, version: event.target.value })} placeholder="1.0.0" />{editor.package && <small>ZIP 包版本不可原位覆盖，请以新版本重新上传。</small>}</label><label className="wide">描述<textarea value={editor.description} onChange={event => setEditor(current => current && { ...current, description: event.target.value })} placeholder="说明用途、数据边界与适用场景" /></label></div>
      {editor.kind === 'mcp' && <div className="ai-resource-specific-fields"><label>传输协议<select value={editor.transport} onChange={event => setEditor(current => current && { ...current, transport: event.target.value as McpServerResource['transport'] })}><option value="streamable_http">Streamable HTTP</option><option value="sse">SSE（兼容旧服务）</option></select></label><label>鉴权类型<select value={editor.authType} onChange={event => setEditor(current => current && { ...current, authType: event.target.value as McpServerResource['authType'] })}><option value="none">无鉴权</option><option value="bearer">Bearer Token</option><option value="oauth2">OAuth 2.0 Access Token</option></select></label><label className="wide">Endpoint<input value={editor.endpoint} onChange={event => setEditor(current => current && { ...current, endpoint: event.target.value })} placeholder="https://mcp.example.com/mcp" /></label>{editor.authType !== 'none' && <label className="wide">Token 环境变量<input value={editor.credentialEnv} onChange={event => setEditor(current => current && { ...current, credentialEnv: event.target.value })} placeholder="SMARTHUB_MCP_ISSUES_MCP_TOKEN" /><small>只保存环境变量名称；Token 由部署环境注入，不写入数据库。</small></label>}<label className="wide">允许的远程工具标识（逗号分隔）<input value={editor.toolIds.join(', ')} onChange={event => setEditor(current => current && { ...current, toolIds: event.target.value.split(',').map(item => item.trim()).filter(Boolean) })} placeholder="issues.list, issues.create" /></label></div>}
      {editor.kind === 'skill' && <div className="ai-resource-specific-fields"><div className="skill-source-choice wide"><button type="button" className={editor.skillMode === 'zip' ? 'active' : ''} disabled={Boolean(editor.package)} onClick={() => setEditor(current => current && { ...current, skillMode: 'zip' })}>ZIP 包上传</button><button type="button" className={editor.skillMode === 'entrypoint' ? 'active' : ''} disabled={Boolean(editor.package)} onClick={() => setEditor(current => current && { ...current, skillMode: 'entrypoint' })}>手动入口</button></div>{editor.skillMode === 'zip' ? editor.package ? <div className="skill-package-summary wide"><b>{editor.package.uploadedFileName}</b><span>{editor.package.fileCount} 个文件 · {formatBytes(editor.package.unpackedBytes)}</span><code>SHA-256 {editor.package.contentSha256}</code><small>{editor.package.entrypointPath}</small></div> : <label className="skill-zip-picker wide"><span>Skill ZIP 包</span><input type="file" accept=".zip,application/zip" onChange={event => setEditor(current => current && { ...current, packageFile: event.target.files?.[0] ?? null })} /><small>{editor.packageFile ? `${editor.packageFile.name} · ${formatBytes(editor.packageFile.size)}` : '最多 20 MB、200 个文件；必须且只能包含一个非空 UTF-8 SKILL.md。'}</small></label> : <label className="wide">Skill 入口<input value={editor.entrypoint} onChange={event => setEditor(current => current && { ...current, entrypoint: event.target.value })} placeholder="ai/skills/requirement-analysis/SKILL.md" /></label>}<label className="wide">标签（逗号分隔）<input value={editor.tags} onChange={event => setEditor(current => current && { ...current, tags: event.target.value })} placeholder="需求, 分析, 证据" /></label><fieldset className="wide"><legend>外部依赖工具</legend><small>Skill 只声明专业方法；需要执行的独立业务能力必须通过正式 Tool 或 MCP 显式绑定。</small><div className="ai-tool-options">{catalog?.tools.map(tool => <label key={tool.id}><input type="checkbox" checked={editor.toolIds.includes(tool.key)} onChange={event => setEditor(current => current && { ...current, toolIds: event.target.checked ? [...current.toolIds, tool.key] : current.toolIds.filter(id => id !== tool.key) })} /><span><b>{tool.name}</b><small>{tool.key}</small></span></label>)}</div></fieldset></div>}
      {editor.kind === 'tool' && <div className="ai-resource-specific-fields"><label>工具来源<select value={editor.source} onChange={event => setEditor(current => current && { ...current, source: event.target.value as ToolResource['source'], mcpServerId: event.target.value === 'mcp' ? current.mcpServerId : '', sourcePath: event.target.value === 'local' ? current.sourcePath : '' })}><option value="local">本地模块</option><option value="http">HTTP API</option><option value="mcp">MCP 服务</option></select></label><label>风险等级<select value={editor.risk} onChange={event => setEditor(current => current && { ...current, risk: event.target.value as ToolResource['risk'] })}><option value="read">只读</option><option value="network_read">网络只读</option><option value="code_execution">代码执行</option><option value="internal_write">SmartHub 内部写入</option><option value="write_reversible">外部可撤销写入（需审批）</option><option value="write_high_risk">外部高风险写入（需审批）</option></select></label><label>超时（毫秒）<input type="number" min="1000" max="300000" step="1000" value={editor.timeoutMs} onChange={event => setEditor(current => current && { ...current, timeoutMs: Number(event.target.value) })} /></label>{editor.source === 'local' && <label className="wide">模块路径<input value={editor.sourcePath} onChange={event => setEditor(current => current && { ...current, sourcePath: event.target.value })} placeholder="ai/tools/my-tool.js" /><small>模块必须导出 parameters 和 execute(arguments, context, signal)；打包运行优先加载编译后的 JS。</small></label>}{editor.source === 'http' && <><label className="wide">HTTP Endpoint<input value={editor.endpoint} onChange={event => setEditor(current => current && { ...current, endpoint: event.target.value })} placeholder="https://tools.example.com/invoke" /></label><label>鉴权类型<select value={editor.authType} onChange={event => setEditor(current => current && { ...current, authType: event.target.value as McpServerResource['authType'] })}><option value="none">无鉴权</option><option value="bearer">Bearer Token</option></select></label>{editor.authType === 'bearer' && <label>Token 环境变量<input value={editor.credentialEnv} onChange={event => setEditor(current => current && { ...current, credentialEnv: event.target.value })} placeholder="SMARTHUB_HTTP_TOOL_NAME_TOKEN" /></label>}<label className="wide">参数 JSON Schema<textarea value={editor.parametersJson} onChange={event => setEditor(current => current && { ...current, parametersJson: event.target.value })} /></label></>}{editor.source === 'mcp' && <label>MCP 服务<select value={editor.mcpServerId} onChange={event => setEditor(current => current && { ...current, mcpServerId: event.target.value })}><option value="">请选择 MCP 服务</option>{catalog?.mcpServers.map(server => <option value={server.id} key={server.id}>{server.name}</option>)}</select></label>}</div>}
      <label className="ai-resource-enabled"><input type="checkbox" checked={editor.enabled} onChange={event => setEditor(current => current && { ...current, enabled: event.target.checked })} />保存后立即启用该资源</label><div className="modal-actions"><button className="btn ghost" onClick={() => setEditor(null)}>取消</button><button className="btn primary" disabled={busyId === (editor.id ?? 'new')} onClick={() => void persist()}><Check />{busyId ? '保存中…' : '保存资源'}</button></div></div></Modal>}
    {sourceViewer && <Modal title={`${sourceViewer.toolKey} · 源码`} className="tool-source-modal" onClose={() => setSourceViewer(null)}><div className="tool-source-viewer"><header><span><Code2 /><b>{sourceViewer.path}</b></span><Badge tone="blue">只读</Badge></header><pre><code>{sourceViewer.content}</code></pre></div></Modal>}
  </section>
}

function CurrentAiResourceIcon({ kind }: { kind: AiResourceKind }) { return kind === 'mcp' ? <Server /> : kind === 'skill' ? <Sparkles /> : <ShieldCheck /> }

function ResourceMetadata({ resource, catalog }: { resource: AiResource; catalog: AiResourceCatalog | null }) {
  if (resource.kind === 'mcp') return <footer><span>{resource.transport === 'streamable_http' ? 'Streamable HTTP' : 'SSE'}</span><span>{resource.authType === 'none' ? '无鉴权' : resource.authType === 'bearer' ? 'Bearer' : 'OAuth 2.0 Token'}</span><span>{resource.toolIds.length} 个远程工具</span><span title={resource.endpoint}>{resource.endpoint}</span>{resource.credentialEnv && <span>{resource.credentialEnv}</span>}</footer>
  if (resource.kind === 'skill') return <footer><span>{resource.package ? `ZIP · ${resource.package.fileCount} 个文件 · ${formatBytes(resource.package.unpackedBytes)}` : '手动入口'}</span><span>{resource.toolIds.length} 个外部依赖工具</span><span>{skillRuntimeSummary(resource)}</span><span>{resource.tags.join(' · ') || '未设置标签'}</span><span title={resource.package?.contentSha256 ?? resource.entrypoint}>{resource.package ? `SHA-256 ${resource.package.contentSha256.slice(0, 12)}…` : resource.entrypoint}</span></footer>
  const mcp = resource.mcpServerId ? catalog?.mcpServers.find(server => server.id === resource.mcpServerId) : null
  return <footer><span>{resource.source === 'builtin' ? '内置' : resource.source === 'local' ? '本地' : resource.source === 'http' ? 'HTTP' : `MCP · ${mcp?.name ?? '未解析'}`}</span><span>{resource.risk === 'read' ? '只读' : resource.risk === 'network_read' ? '网络只读' : resource.risk === 'code_execution' ? '代码执行' : resource.risk === 'internal_write' ? 'SmartHub 内部写入' : resource.risk === 'write_reversible' ? '外部可撤销写入 · 需审批' : '外部高风险写入 · 需审批'}</span><span>{(resource.timeoutMs / 1000).toLocaleString()} 秒超时</span>{resource.sourcePath && <span title={resource.sourcePath}>{resource.sourcePath}</span>}{resource.endpoint && <span title={resource.endpoint}>{resource.endpoint}</span>}</footer>
}

function agentSkillSummary(skill: SkillResource) {
  const capabilities = skillRuntimeSummary(skill)
  return [skill.toolIds.length ? `外部依赖：${skill.toolIds.join('、')}` : '', capabilities, '发布后进入 Catalog，正文按需读取'].filter(Boolean).join(' · ')
}

function skillRuntimeSummary(skill: SkillResource) {
  const items = [
    ...(skill.runtime?.scripts.length ? [`${skill.runtime.scripts.length} 个受控 PowerShell 脚本`] : []),
    ...(skill.runtime?.network ? [`联网：${skill.runtime.network.allowedOrigins.length} 个 Origin`] : []),
  ]
  return items.length ? items.join('；') : '无脚本或联网权限'
}

function formatBytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB` }

const modelHealthLabel = (health: GenerativeSourceDraft['health']) => health === 'healthy' ? '健康' : health === 'degraded' ? '降级' : '待探测'
const modelHealthTone = (health: GenerativeSourceDraft['health']) => health === 'healthy' ? 'green' : health === 'degraded' ? 'orange' : 'gray'

function PromptAgentSettings({ draft, notify, agentDraft, updateAgent, configuration, configurationError, modelSourcesState, modelSourcesError, onRetryConfiguration, onRetryModelSources, publishing, onPublish }: {
  draft: SettingsDraft
  notify: Notify
  agentDraft: Record<AgentConfigurationAgentKey, AgentConfigurationAgentDraft>
  updateAgent: (value: Record<AgentConfigurationAgentKey, AgentConfigurationAgentDraft> | ((current: Record<AgentConfigurationAgentKey, AgentConfigurationAgentDraft>) => Record<AgentConfigurationAgentKey, AgentConfigurationAgentDraft>)) => void
  configuration: AgentConfigurationState
  configurationError: string | null
  modelSourcesState: 'idle' | 'loading' | 'ready' | 'failed'
  modelSourcesError: string | null
  onRetryConfiguration: () => void
  onRetryModelSources: () => void
  publishing: boolean
  onPublish: (agentKey: AgentConfigurationAgentKey) => Promise<void>
}) {
  const [selectedAgent, setSelectedAgent] = useState<AgentConfigurationAgentKey>('planning')
  const [tab, setTab] = useState<'planning' | 'model' | 'prompt' | 'tools'>('planning')
  const [resourceCatalog, setResourceCatalog] = useState<AiResourceCatalog | null>(null)
  const [resourceCatalogError, setResourceCatalogError] = useState('')
  const [planningProfile, setPlanningProfile] = useState<PlanningAgentProfile | null>(null)
  const [planningProfileError, setPlanningProfileError] = useState('')
  const currentDraft = agentDraft[selectedAgent]
  const currentState = configuration.agents[selectedAgent]
  const routing = currentDraft.routing
  const definition = currentDraft.definition
  const agentMetadata = agentConfigurationMetadata[selectedAgent]
  const agentLabel = agentMetadata.label
  const agentIdentifier = agentMetadata.identifier
  const allModels = draft.generativeSources.flatMap(source => source.models.map(model => ({ ...model, source })))
  const modelSourcesReady = modelSourcesState === 'ready'
  const availableModels = modelSourcesReady ? allModels.filter(model => model.source.enabled && model.enabled) : []
  const modelValue = (sourceId: string, modelId: string) => `${sourceId}\u0000${modelId}`
  const resolveModel = (reference: { sourceId: string; modelId: string } | null) => reference ? allModels.find(model => model.source.id === reference.sourceId && model.id === reference.modelId) : undefined
  const defaultModel = resolveModel(routing.primaryModel)
  const updateCurrent = (value: AgentConfigurationAgentDraft) => updateAgent(current => ({ ...current, [selectedAgent]: value }))
  const updateRouting = <K extends keyof AgentRoutingConfiguration>(key: K, value: AgentRoutingConfiguration[K]) => updateCurrent({ ...currentDraft, routing: { ...routing, [key]: value } })
  const updateDefinition = (patch: Partial<AgentConfigurationAgentDraft['definition']>) => updateCurrent({ ...currentDraft, definition: { ...definition, ...patch } })
  const updateLimit = (limit: keyof AgentConfigurationAgentDraft['definition']['limits'], value: number | string) => updateDefinition({ limits: { ...definition.limits, [limit]: value } })
  const moveFallback = (index: number, offset: number) => {
    const target = index + offset
    if (target < 0 || target >= routing.fallbackModels.length) return
    const next = [...routing.fallbackModels]; [next[index], next[target]] = [next[target], next[index]]
    updateRouting('fallbackModels', next)
  }
  const addFallback = () => {
    const model = availableModels.find(item => (!routing.primaryModel || modelValue(item.source.id, item.id) !== modelValue(routing.primaryModel.sourceId, routing.primaryModel.modelId)) && !routing.fallbackModels.some(reference => modelValue(reference.sourceId, reference.modelId) === modelValue(item.source.id, item.id)))
    if (model) updateRouting('fallbackModels', [...routing.fallbackModels, { sourceId: model.source.id, modelId: model.id }])
  }
  const requiredToolIds = currentState.requiredToolIds
  const requiredSkillKeys = currentState.requiredSkillKeys
  const requiredMcpServerKeys = currentState.requiredMcpServerKeys
  const stageRuntimeToolIds = new Set(agentMetadata.runtimeToolIds)
  const toggleTool = (tool: ToolResource) => {
    if (agentMetadata.exactCapabilities || requiredToolIds.includes(tool.key)) return
    const selected = definition.toolIds.includes(tool.key)
    updateDefinition({ toolIds: selected ? definition.toolIds.filter(item => item !== tool.key) : [...definition.toolIds, tool.key] })
  }
  const toggleSkill = (skill: SkillResource) => {
    if (agentMetadata.exactCapabilities || requiredSkillKeys.includes(skill.key)) return
    const selected = definition.skillKeys.includes(skill.key)
    updateDefinition({ skillKeys: selected ? definition.skillKeys.filter(item => item !== skill.key) : [...definition.skillKeys, skill.key] })
  }
  const toggleMcp = (server: McpServerResource) => {
    if (agentMetadata.exactCapabilities || requiredMcpServerKeys.includes(server.key)) return
    const selected = definition.mcpServerKeys.includes(server.key)
    updateDefinition({ mcpServerKeys: selected ? definition.mcpServerKeys.filter(item => item !== server.key) : [...definition.mcpServerKeys, server.key] })
  }
  const loadResourceCatalog = useCallback(() => {
    setResourceCatalogError('')
    return loadAiResources().then(setResourceCatalog).catch(error => {
      setResourceCatalogError(error instanceof Error ? error.message : 'AI 资源目录读取失败')
      throw error
    })
  }, [])
  useEffect(() => {
    if (tab !== 'tools' || resourceCatalog || resourceCatalogError) return
    void loadResourceCatalog().catch(() => undefined)
  }, [loadResourceCatalog, resourceCatalog, resourceCatalogError, tab])
  const loadPlanningProfile = useCallback(() => {
    setPlanningProfileError('')
    return loadPlanningAgentProfile().then(setPlanningProfile).catch(error => {
      setPlanningProfileError(error instanceof Error ? error.message : 'PlanningAgent Profile 读取失败')
      throw error
    })
  }, [])
  useEffect(() => { void loadPlanningProfile().catch(() => undefined) }, [loadPlanningProfile])
  const selectAgent = (value: AgentConfigurationAgentKey) => setSelectedAgent(value)
  return <><div className="agent-settings-page">
    <section className="agent-config-header"><div className="agent-symbol"><BrainCircuit /></div><div className="agent-selector"><span>配置 Agent</span><select value={selectedAgent} onChange={event => selectAgent(event.target.value as AgentConfigurationAgentKey)} aria-label="选择要配置的 Agent">{agentConfigurationGroups.map(group => <optgroup label={group.label} key={group.label}>{group.agentKeys.map(agentKey => { const metadata = agentConfigurationMetadata[agentKey]; return <option value={agentKey} key={agentKey}>{metadata.label}（{metadata.identifier}）</option> })}</optgroup>)}</select><p>{agentMetadata.sceneLabel} / {agentIdentifier} · 草稿 revision {currentDraft.revision}</p></div><Badge tone={currentState.activeVersion ? 'green' : 'orange'}>{currentState.activeVersion ? `V${currentState.activeVersion.version} 生效中` : '尚未发布'}</Badge><button className="btn primary agent-publish-button" disabled={publishing || !routing.primaryModel || !modelSourcesReady} onClick={() => void onPublish(selectedAgent)}><Play />{publishing ? '发布中…' : `发布`}</button></section>
    {configurationError && <div className="agent-configuration-status failed"><AlertTriangle /><div><b>版本已发布，但配置刷新失败</b><span>{configurationError}</span></div><button className="btn ghost" onClick={onRetryConfiguration}><RefreshCw />重新加载</button></div>}
    <nav className="agent-config-tabs"><button className={tab === 'planning' ? 'active' : ''} onClick={() => setTab('planning')}><BrainCircuit />PlanningAgent</button><button className={tab === 'model' ? 'active' : ''} onClick={() => setTab('model')}><Bot />模型与路由</button><button className={tab === 'prompt' ? 'active' : ''} onClick={() => setTab('prompt')}><FileText />提示词</button><button className={tab === 'tools' ? 'active' : ''} onClick={() => setTab('tools')}><ShieldCheck />Tool、MCP、Skill</button></nav>
    {tab === 'planning' && <PlanningAgentSettings profile={planningProfile} error={planningProfileError} modelSources={draft.generativeSources} agentDraft={agentDraft} onRetry={() => void loadPlanningProfile().catch(() => undefined)} />}
    {tab === 'model' && <div className="model-routing-grid"><section className="model-config-panel"><ModelPanelHead title={`${agentLabel}模型参数`} desc={`仅作用于${agentLabel}，不会影响其他 Agent。`}><Badge tone="purple">{agentMetadata.sceneLabel}</Badge></ModelPanelHead>{!modelSourcesReady && <div className={`agent-configuration-status ${modelSourcesState === 'failed' ? 'failed' : ''}`}><RefreshCw /><div><b>{modelSourcesState === 'failed' ? '模型来源读取失败' : '正在读取模型来源'}</b><span>{modelSourcesState === 'failed' ? modelSourcesError ?? '模型与路由暂不可编辑。' : '提示词、工具和运行限制仍可使用。'}</span></div>{modelSourcesState === 'failed' && <button className="btn ghost" onClick={onRetryModelSources}><RefreshCw />重新加载</button>}</div>}<div className="routing-form"><FormRow label="默认模型" help="智能路由关闭时固定使用该模型"><select disabled={!modelSourcesReady} value={routing.primaryModel ? modelValue(routing.primaryModel.sourceId, routing.primaryModel.modelId) : ''} onChange={event => { const [sourceId, modelId] = event.target.value.split('\u0000'); updateRouting('primaryModel', sourceId && modelId ? { sourceId, modelId } : null) }}><option value="">{modelSourcesReady ? '请选择模型' : '模型来源读取中…'}</option>{availableModels.map(model => <option value={modelValue(model.source.id, model.id)} key={modelValue(model.source.id, model.id)}>{model.displayName} · {model.source.name}</option>)}</select></FormRow><FormRow label="上下文窗口" help="由当前 Agent 独立设置，并随 Agent 配置版本固化"><div className="input-unit"><input type="number" min="16384" step="1024" value={routing.contextWindow} onChange={event => updateRouting('contextWindow', Number(event.target.value))} /><span>tokens</span></div></FormRow><FormRow label="最大输出 Token" help="由当前 Agent 独立设置，发布后直接用于模型调用"><div className="input-unit"><input type="number" min="1024" step="1024" value={routing.maxOutputTokens} onChange={event => updateRouting('maxOutputTokens', Number(event.target.value))} /><span>tokens</span></div></FormRow><FormRow label="流式无响应超时" help="从请求发起或最近一次流式数据开始计时；正常思考、文本和工具参数流会自动续期"><div className="input-unit"><input type="number" min="10" value={routing.requestTimeoutSeconds} onChange={event => updateRouting('requestTimeoutSeconds', Number(event.target.value))} /><span>秒</span></div></FormRow><FormRow label="失败重试" help="仅对限流、超时等错误生效"><select value={routing.retryCount} onChange={event => updateRouting('retryCount', Number(event.target.value))}><option value={0}>不重试</option><option value={1}>1 次</option><option value={2}>2 次</option><option value={3}>3 次</option></select></FormRow></div></section><section className="model-config-panel route-policy-panel"><ModelPanelHead title="路由与降级" desc={`仅保存到${agentLabel}的独立版本快照。`} /><SwitchRow title="启用智能模型路由" desc="按能力、启用和健康状态选择模型" checked={routing.intelligentRouting} onChange={value => updateRouting('intelligentRouting', value)} /><SwitchRow title="允许模型降级" desc="默认模型不可用时按顺序尝试备用模型" checked={routing.fallbackEnabled} onChange={value => updateRouting('fallbackEnabled', value)} /><div className={`fallback-route ${routing.fallbackEnabled ? '' : 'disabled'}`}><div className="fallback-primary"><span>主</span><div><b>{defaultModel?.displayName ?? '未选择默认模型'}</b><small>{defaultModel?.source.name ?? '请先在模型管理中启用模型'}</small></div><Badge tone="green">默认</Badge></div>{routing.fallbackModels.map((reference, index) => { const model = resolveModel(reference); return model && <div className="fallback-item" key={modelValue(reference.sourceId, reference.modelId)}><span>{index + 1}</span><div><b>{model.displayName}</b><small>{model.source.name}</small></div><div><button className="icon-btn" disabled={!modelSourcesReady || index === 0} onClick={() => moveFallback(index, -1)}><ArrowUp /></button><button className="icon-btn" disabled={!modelSourcesReady || index === routing.fallbackModels.length - 1} onClick={() => moveFallback(index, 1)}><ArrowDown /></button><button className="icon-btn danger-text" disabled={!modelSourcesReady} onClick={() => updateRouting('fallbackModels', routing.fallbackModels.filter((_, position) => position !== index))}><Trash2 /></button></div></div>})}<button className="add-fallback" disabled={!modelSourcesReady || !routing.fallbackEnabled || !availableModels.some(model => (!routing.primaryModel || modelValue(model.source.id, model.id) !== modelValue(routing.primaryModel.sourceId, routing.primaryModel.modelId)) && !routing.fallbackModels.some(reference => modelValue(reference.sourceId, reference.modelId) === modelValue(model.source.id, model.id)))} onClick={addFallback}><Plus />添加回退模型</button></div><div className="route-note"><ShieldCheck /><span><b>{agentLabel}独立配置</b><small>模型来源由通用模型库管理；模型选择和路由策略随当前 Agent 版本发布。</small></span></div></section><section className="model-config-panel agent-runtime-limits"><ModelPanelHead title="运行限制" desc={`控制${agentLabel}的执行预算，并随当前 Agent 版本固化。`} /><div className="agent-limit-grid"><label>最大轮次<input type="number" min="4" max="100" value={definition.limits.maxTurns} onChange={event => updateLimit('maxTurns', Number(event.target.value))} /></label><label>最大工具调用<input type="number" min="1" max="200" value={definition.limits.maxToolCalls} onChange={event => updateLimit('maxToolCalls', Number(event.target.value))} /></label><label>总截止时间（秒）<input type="number" min="30" max="3600" value={definition.limits.deadlineMs / 1000} onChange={event => updateLimit('deadlineMs', Number(event.target.value) * 1000)} /></label><label>推理强度<select value={definition.limits.reasoningEffort ?? 'medium'} onChange={event => updateLimit('reasoningEffort', event.target.value)}><option value="off">关闭</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">超高</option></select></label></div></section></div>}
    {tab === 'prompt' && <section className="model-config-panel agent-prompt-editor"><ModelPanelHead title={`${agentLabel}提示词`} desc={`配置${agentLabel}的系统指令与任务模板。`}><Badge tone="purple">{agentMetadata.protocolLabel}</Badge></ModelPanelHead><label><span>系统提示词</span><textarea value={definition.systemPrompt} onChange={event => updateDefinition({ systemPrompt: event.target.value })} /><small>{definition.systemPrompt.length.toLocaleString()} 字符</small></label><label><span>任务模板</span><textarea className="task-template" value={definition.taskTemplate} onChange={event => updateDefinition({ taskTemplate: event.target.value })} /><small>{definition.taskTemplate.length.toLocaleString()} 字符</small></label></section>}
    {tab === 'tools' && <section className="model-config-panel agent-tool-editor"><ModelPanelHead title={`${agentLabel} Tool、MCP、Skill`} desc="发布版本绑定的 Skill 只把 Catalog 加载到 Prompt；Agent 按需通过 skill.read 读取正文。skill-runtime.json 声明的脚本或联网能力仅供本次 Agent 调用，不出现在 Tool 目录，也无需单独选择。"><Badge tone="green">服务端强校验</Badge></ModelPanelHead>{resourceCatalog === null && !resourceCatalogError && <div className="agent-capability-state"><RefreshCw className="document-loading-icon" />正在读取完整 AI 资源目录…</div>}{resourceCatalogError && <div className="agent-capability-state failed"><AlertTriangle /><span>{resourceCatalogError}</span><button className="btn ghost" onClick={() => void loadResourceCatalog().catch(() => undefined)}><RefreshCw />重试</button></div>}{resourceCatalog && <><div className="agent-capability-section"><header><div><b>Tool</b><small>仅展示可独立配置并由 Runtime 注册实现的工具。</small></div><Badge tone="purple">{resourceCatalog.tools.filter(tool => definition.toolIds.includes(tool.key) || requiredToolIds.includes(tool.key)).length} / {resourceCatalog.tools.length} 已选择</Badge></header>{resourceCatalog.tools.length === 0 ? <div className="agent-capability-state"><ShieldCheck />暂无 Tool，请先到模型管理添加。</div> : <div className="agent-skill-list">{resourceCatalog.tools.map(tool => { const required = requiredToolIds.includes(tool.key); const selected = definition.toolIds.includes(tool.key) || required; const runtimeReady = stageRuntimeToolIds.has(tool.key); return <label className={!tool.enabled ? 'disabled' : ''} key={tool.id}><input type="checkbox" checked={selected} disabled={agentMetadata.exactCapabilities || required || (!tool.enabled && !selected)} onChange={() => toggleTool(tool)} /><span><b>{tool.name}</b><code>{tool.key}@{tool.version}</code><small>{tool.description || '暂无描述'}</small></span><Badge tone={required || runtimeReady ? 'green' : tool.status === 'ready' ? 'blue' : 'gray'}>{required ? '必需' : runtimeReady ? '可运行' : tool.status === 'ready' ? '可绑定' : '待接入'}</Badge></label>})}</div>}</div><div className="agent-capability-section"><header><div><b>MCP</b><small>展示 MCP 目录中的全部服务，选择结果随 Agent 版本固化。</small></div><Badge tone="purple">{resourceCatalog.mcpServers.filter(server => definition.mcpServerKeys.includes(server.key) || requiredMcpServerKeys.includes(server.key)).length} / {resourceCatalog.mcpServers.length} 已选择</Badge></header>{resourceCatalog.mcpServers.length === 0 ? <div className="agent-capability-state"><Server />暂无 MCP，请先到模型管理添加。</div> : <div className="agent-skill-list">{resourceCatalog.mcpServers.map(server => { const required = requiredMcpServerKeys.includes(server.key); const selected = definition.mcpServerKeys.includes(server.key) || required; return <label className={!server.enabled ? 'disabled' : ''} key={server.id}><input type="checkbox" checked={selected} disabled={agentMetadata.exactCapabilities || required || (!server.enabled && !selected)} onChange={() => toggleMcp(server)} /><span><b>{server.name}</b><code>{server.key}@{server.version}</code><small>{required ? '必需 MCP，不可移除' : !server.enabled ? '已停用，可取消但不能新增' : `${server.transport === 'streamable_http' ? 'Streamable HTTP' : 'SSE'} · ${server.toolIds.length} 个远程工具`}</small></span><Badge tone={required ? 'green' : server.status === 'ready' ? 'blue' : 'gray'}>{required ? '必需' : server.status === 'ready' ? '可绑定' : '待接入'}</Badge></label>})}</div>}</div><div className="agent-capability-section"><header><div><b>Skill</b><small>选择结果随 Agent 版本固化，运行开始时只加载 Catalog，正文由 Agent 按需读取；其受控脚本和联网权限仍由发布配置固定，停用项不能新增，必需项不可移除。</small></div><Badge tone="purple">{resourceCatalog.skills.filter(skill => definition.skillKeys.includes(skill.key) || requiredSkillKeys.includes(skill.key)).length} / {resourceCatalog.skills.length} 已选择</Badge></header>{resourceCatalog.skills.length === 0 ? <div className="agent-capability-state"><Sparkles />暂无 Skill，请先到模型管理添加。</div> : <div className="agent-skill-list">{resourceCatalog.skills.map(skill => { const required = requiredSkillKeys.includes(skill.key); const selected = definition.skillKeys.includes(skill.key) || required; return <label className={!skill.enabled ? 'disabled' : ''} key={skill.id}><input type="checkbox" checked={selected} disabled={agentMetadata.exactCapabilities || required || (!skill.enabled && !selected)} onChange={() => toggleSkill(skill)} /><span><b>{skill.name}</b><code>{skill.key}@{skill.version}</code><small>{required ? '必需 Skill，不可移除' : !skill.enabled ? '已停用，可取消但不能新增' : agentSkillSummary(skill)}</small></span><Badge tone={required ? 'green' : skill.status === 'ready' ? 'blue' : 'gray'}>{required ? '必需' : skill.status === 'ready' ? '可绑定' : '待接入'}</Badge></label>})}</div>}</div></>}</section>}
  </div></>
}

function PlanningAgentSettings({ profile, error, modelSources, agentDraft, onRetry }: { profile: PlanningAgentProfile | null; error: string; modelSources: GenerativeSourceDraft[]; agentDraft: Record<AgentConfigurationAgentKey, AgentConfigurationAgentDraft>; onRetry: () => void }) {
  if (error) return <div className="agent-configuration-status failed"><AlertTriangle /><div><b>PlanningAgent Profile 读取失败</b><span>{error}</span></div><button className="btn ghost" onClick={onRetry}><RefreshCw />重新加载</button></div>
  if (!profile) return <AgentConfigurationLoading />
  const modelFor = (reference: { sourceId: string; modelId: string } | null) => reference ? modelSources.flatMap(source => source.models.map(model => ({ source, model }))).find(item => item.source.id === reference.sourceId && item.model.id === reference.modelId) : undefined
  return <section className="planning-agent-profile">
    <header><span><BrainCircuit /><div><b>{profile.label}</b><small>需求分析与测试设计共用的唯一可发布 Agent 配置。</small></div></span><Badge tone="green">projectVersion Planning Session</Badge></header>
    <div className="planning-agent-summary"><article><small>Parent Session</small><b>{profile.parentSession}</b><span>RequirementAnalysis 与 TestDesign 共用同一 Planning Context</span></article><article><small>Auto Compaction</small><b>{profile.context.autoCompaction ? 'Enabled' : 'Disabled'} · {profile.context.proactiveThresholdPercent}%</b><span>Summary 不是正式业务事实</span></article><article><small>SubAgents</small><b>{profile.subAgents.length} 个独立 Reviewer</b><span>独立 Session · 只读 Workspace</span></article><article><small>Stages</small><b>{profile.stageProfiles.length} 个固定 Stage</b><span>测试点自动校验，用例审核与发布保留人工门禁</span></article></div>
    <div className="planning-agent-configurations">{profile.configurations.map(configuration => {
      const active = configuration.activeVersion
      const model = modelFor(active?.routing.primaryModel ?? null)
      const draft = agentDraft[configuration.agentKey]
      return <article key={configuration.agentKey}><header><span><Bot /><div><b>PlanningAgent</b><small>统一已发布配置 · {configuration.scene}</small></div></span><Badge tone={active ? 'green' : 'orange'}>{active ? `V${active.version}` : '未发布'}</Badge></header>{active ? <><div className="planning-agent-kpis"><span><small>模型</small><b>{model?.model.displayName ?? active.routing.primaryModel?.modelId ?? '未选择'}</b></span><span><small>Context Window</small><b>{active.routing.contextWindow.toLocaleString()}</b></span><span><small>最大 Turns</small><b>{active.agentDefinition.limits.maxTurns}</b></span><span><small>Tool Calls</small><b>{active.agentDefinition.limits.maxToolCalls}</b></span></div><details><summary>System Prompt</summary><pre>{active.agentDefinition.systemPrompt}</pre></details><dl><div><dt>Enabled Skills</dt><dd>{active.agentDefinition.enabledSkills.join(' · ') || '—'}</dd></div><div><dt>Tools</dt><dd>{active.agentDefinition.toolIds.join(' · ') || '—'}</dd></div></dl></> : <p className="readonly-notice">请在模型与路由、提示词、Tool/MCP/Skill 页签完成统一配置并发布。</p>}<footer>草稿 revision {draft.revision} · 需求分析与测试设计都会固定使用该配置版本</footer></article>
    })}</div>
    <section className="planning-agent-subagents"><header><ShieldCheck /><span><b>Reviewer SubAgents</b><small>候选只注入 Parent Session，最终采纳仍由 Workflow、Service 与 Validator 决定。</small></span></header><div>{profile.subAgents.map(subAgent => <article key={subAgent.reviewerType}><Bot /><span><b>{subAgent.label}</b><small>{subAgent.session} session · {subAgent.workspace} workspace</small><code>{subAgent.resultSchemaVersion}</code></span></article>)}</div></section>
    <section className="planning-agent-context"><header><RefreshCw /><span><b>Context / Compaction</b><small>检查点达到阈值时主动压缩，不在每个 Stage 无条件压缩。</small></span></header><div>{profile.context.checkpoints.map(checkpoint => <code key={checkpoint}>{checkpoint}</code>)}</div></section>
    <section className="planning-agent-stages"><header><Activity /><span><b>Workflow Stage 边界</b><small>Workflow 固定业务 Gate、Allowed Tools、Submit Tool、Schema 与 Reviewer；Skill 始终来自 PlanningAgent 的 Enabled Skills。</small></span></header><div>{profile.stageProfiles.map(stage => <article key={stage.stage}><header><b>{stage.stage}</b><Badge tone={stage.humanGate ? 'orange' : 'gray'}>{stage.humanGate ? 'Human Gate' : stage.stage === 'test_point_review' ? 'Validator' : stage.agentKey}</Badge></header><dl><div><dt>Tools</dt><dd>{stage.allowedToolIds.join(' · ') || '—'}</dd></div><div><dt>Submit / Schema</dt><dd>{stage.submitToolId ?? '—'} · {stage.resultSchemaVersion ?? '—'}</dd></div><div><dt>Reviewer</dt><dd>{stage.reviewers.join(' · ') || '—'}</dd></div></dl></article>)}</div></section>
  </section>
}

function ModelPanelHead({ title, desc, children }: { title: string; desc: string; children?: ReactNode }) { return <div className="model-panel-head"><div><h3>{title}</h3><p>{desc}</p></div>{children}</div> }

function FormSection({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) { return <section className="form-section"><div className="form-section-title"><h3>{title}</h3>{desc && <p>{desc}</p>}</div><div>{children}</div></section> }
function FormRow({ label, help, children }: { label: string; help: string; children: ReactNode }) { return <label className="form-row"><span><b>{label}</b><small>{help}</small></span><div>{children}</div></label> }
function SwitchRow({ title, desc, checked, onChange }: { title: string; desc: string; checked: boolean; onChange: (value: boolean) => void }) { return <div className="form-row"><span><b>{title}</b><small>{desc}</small></span><label className="switch"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} aria-label={title} /><i /></label></div> }

type SourceEditorDraft = { id?: string; name: string; baseUrl: string; apiKey: string; modelName: string }

const localModelRecommendations = [
  { name: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', title: '多语言通用 · 推荐', detail: '中英文知识库 · 384 维' },
  { name: 'Xenova/multilingual-e5-small', title: '多语言检索', detail: '面向语义检索 · 384 维' },
  { name: 'Xenova/all-MiniLM-L6-v2', title: '英文轻量模型', detail: '体积较小、速度快 · 384 维' },
] as const

function EmbeddingModelPrototype({ knowledgeBaseId, draft, update, notify }: { knowledgeBaseId: string; draft: SettingsDraft; update: <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => void; notify: Notify }) {
  const [testingModel, setTestingModel] = useState('')
  const [runtimeStatuses, setRuntimeStatuses] = useState<LocalModelStatus[]>([])
  const [runtimeBusy, setRuntimeBusy] = useState('')
  const [sourceEditor, setSourceEditor] = useState<SourceEditorDraft | null>(null)
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({})
  const [recommendationSourceId, setRecommendationSourceId] = useState('')
  const selectedSource = draft.embeddingSources.find(source => source.id === draft.embeddingSourceId) ?? draft.embeddingSources[0]

  useEffect(() => {
    if (!draft.embeddingSources.some(source => source.type === 'local')) return
    let active = true
    const refresh = () => loadLocalModelStatuses().then(statuses => { if (active) setRuntimeStatuses(statuses) }).catch(() => undefined)
    void refresh()
    const timer = window.setInterval(refresh, 1000)
    return () => { active = false; window.clearInterval(timer) }
  }, [draft.embeddingSources])

  useEffect(() => {
    let changed = false
    const sources = draft.embeddingSources.map(source => source.type !== 'local' ? source : { ...source, models: source.models.map(model => {
      const dimensions = runtimeStatuses.find(status => status.model === model.name && status.phase === 'running')?.dimensions
      if (!dimensions || dimensions === model.dimensions) return model
      changed = true; return { ...model, dimensions }
    }) })
    if (changed) update('embeddingSources', sources)
    const status = runtimeStatuses.find(item => item.model === draft.embeddingModel && item.phase === 'running')
    if (status?.dimensions && draft.embeddingDimensions !== String(status.dimensions)) update('embeddingDimensions', String(status.dimensions))
  }, [draft.embeddingDimensions, draft.embeddingModel, draft.embeddingSourceId, draft.embeddingSources, runtimeStatuses, update])

  const applySelection = (source: EmbeddingSourceDraft, model = source.models[0]) => {
    if (!model) return
    update('embeddingSourceId', source.id)
    update('embeddingMode', source.type)
    update('embeddingBaseUrl', source.baseUrl)
    update('embeddingApiKey', source.apiKey)
    update('embeddingModel', model.name)
    update('embeddingDimensions', String(model.dimensions))
  }
  const updateSources = (sources: EmbeddingSourceDraft[]) => update('embeddingSources', sources)
  const replaceSource = (next: EmbeddingSourceDraft) => updateSources(draft.embeddingSources.map(source => source.id === next.id ? next : source))

  const saveSource = () => {
    if (!sourceEditor) return
    const name = sourceEditor.name.trim(); const baseUrl = sourceEditor.baseUrl.trim()
    if (!name) { notify('请填写来源名称。'); return }
    if (!/^https?:\/\//i.test(baseUrl)) { notify('远程来源 Base URL 必须使用 http:// 或 https://。'); return }
    if (sourceEditor.id) {
      const current = draft.embeddingSources.find(source => source.id === sourceEditor.id)
      if (!current || current.type !== 'remote_api') { notify('远程来源不存在，无法保存编辑。'); return }
      const source: EmbeddingSourceDraft = { ...current, name, baseUrl, apiKey: sourceEditor.apiKey }
      replaceSource(source)
      if (draft.embeddingSourceId === source.id) {
        const model = source.models.find(candidate => candidate.name === draft.embeddingModel)
        if (model) applySelection(source, model)
      }
      setSourceEditor(null); notify(`已更新远程来源 ${name}。`)
      return
    }
    const modelName = sourceEditor.modelName.trim()
    if (!modelName) { notify('请填写首个模型名称。'); return }
    const source: EmbeddingSourceDraft = { id: crypto.randomUUID(), name, type: 'remote_api', baseUrl, apiKey: sourceEditor.apiKey, models: [{ name: modelName, dimensions: 0 }] }
    updateSources([...draft.embeddingSources, source]); setSourceEditor(null); notify(`已添加远程来源 ${name}，请在“知识库生效模型”中手动选择。`)
  }

  const editSource = (source: EmbeddingSourceDraft) => {
    if (source.type !== 'remote_api') return
    setSourceEditor({ id: source.id, name: source.name, baseUrl: source.baseUrl, apiKey: '', modelName: '' })
  }

  const addModel = (source: EmbeddingSourceDraft) => {
    const name = (modelDrafts[source.id] ?? '').trim()
    if (!name) { notify('请填写模型名称。'); return }
    if (source.models.some(model => model.name === name)) { notify('该来源中已存在同名模型。'); return }
    replaceSource({ ...source, models: [...source.models, { name, dimensions: 0 }] })
    setModelDrafts(current => ({ ...current, [source.id]: '' }))
    setRecommendationSourceId('')
  }

  const removeModel = async (source: EmbeddingSourceDraft, modelName: string) => {
    if (source.type === 'remote_api' && source.models.length === 1) { notify('远程来源至少需要保留一个模型；如不再使用，可以删除整个远程来源。'); return }
    const runtime = source.type === 'local' ? runtimeStatuses.find(status => status.model === modelName) : undefined
    if (runtime && runtime.phase !== 'idle') {
      setRuntimeBusy(modelName)
      try {
        const status = await stopLocalModel(modelName)
        setRuntimeStatuses(current => [...current.filter(item => item.model !== modelName), status])
      } catch (error) { notify(error instanceof Error ? error.message : '停止本地模型失败，暂未删除。'); return }
      finally { setRuntimeBusy('') }
    }
    const next = { ...source, models: source.models.filter(model => model.name !== modelName) }
    const sources = draft.embeddingSources.map(item => item.id === source.id ? next : item)
    const fallback = (next.models.length ? next : sources.find(item => item.models.length > 0))
    updateSources(sources)
    if (draft.embeddingSourceId === source.id && draft.embeddingModel === modelName) {
      if (fallback) applySelection(fallback)
      else { update('embeddingSourceId', source.id); update('embeddingMode', 'local'); update('embeddingBaseUrl', ''); update('embeddingApiKey', ''); update('embeddingModel', ''); update('embeddingDimensions', '0') }
    }
    if (draft.rerankerSourceId === source.id && draft.rerankerModel === modelName) {
      if (fallback) { update('rerankerSourceId', fallback.id); update('rerankerModel', fallback.models[0].name) }
      else { update('rerankerEnabled', false); update('rerankerSourceId', source.id); update('rerankerModel', '') }
    }
    notify(`已删除${source.type === 'local' ? '本地' : '远程'}模型 ${modelName}${fallback ? '，相关选择已自动更新。' : '；当前没有可用模型，请重新添加或配置远程来源。'}`)
  }

  const removeSource = (sourceId: string) => {
    if (draft.embeddingSources.find(source => source.id === sourceId)?.type === 'local') { notify('本地模型为系统内置来源，不能删除。'); return }
    if (draft.embeddingSources.length === 1) { notify('至少保留一个模型来源。'); return }
    const remaining = draft.embeddingSources.filter(source => source.id !== sourceId)
    updateSources(remaining)
    if (draft.embeddingSourceId === sourceId) applySelection(remaining[0])
    if (draft.rerankerSourceId === sourceId) { update('rerankerSourceId', remaining[0].id); update('rerankerModel', remaining[0].models[0].name) }
  }

  const testConnection = async (source: EmbeddingSourceDraft, model: EmbeddingSourceDraft['models'][number]) => {
    setTestingModel(`${source.id}:${model.name}`)
    try {
      const result = await testEmbeddingConfig(knowledgeBaseId, { embeddingSourceId: source.id, embeddingSources: draft.embeddingSources, embeddingMode: 'remote_api', embeddingBaseUrl: source.baseUrl, embeddingApiKey: source.apiKey, embeddingModel: model.name, embeddingDimensions: model.dimensions, embeddingBatchSize: Number(draft.embeddingBatchSize), embeddingTimeoutMs: Number(draft.embeddingTimeoutMs), embeddingRetries: Number(draft.embeddingRetries) })
      updateSources(draft.embeddingSources.map(item => item.id !== source.id ? item : { ...item, models: item.models.map(candidate => candidate.name === model.name ? { ...candidate, dimensions: result.dimensions } : candidate) }))
      if (draft.embeddingSourceId === source.id && draft.embeddingModel === model.name) update('embeddingDimensions', String(result.dimensions))
      notify(`连接验证成功：${source.name} / ${result.model} · ${result.dimensions} 维。`)
    } catch (error) { notify(error instanceof Error ? error.message : 'Embedding 连接验证失败。', 'error') }
    finally { setTestingModel('') }
  }

  const operateLocalModel = async (model: string, running: boolean) => {
    setRuntimeBusy(model)
    try {
      const status = running ? await stopLocalModel(model) : await startLocalModel(model)
      setRuntimeStatuses(current => [...current.filter(item => item.model !== model), status])
      notify(running ? `已停止本地模型 ${model}。` : `已开始拉取并加载 ${model}；其他模型继续运行。`)
    } catch (error) { notify(error instanceof Error ? error.message : '本地模型操作失败。') }
    finally { setRuntimeBusy('') }
  }

  const phaseLabel = (phase?: LocalModelStatus['phase']) => phase === 'running' ? '运行中' : phase === 'downloading' ? '下载中' : phase === 'loading' ? '加载中' : phase === 'stopping' ? '停止中' : phase === 'failed' ? '启动失败' : '未运行'
  const phaseTone = (phase?: LocalModelStatus['phase']) => phase === 'running' ? 'green' : phase === 'failed' ? 'red' : phase && phase !== 'idle' ? 'orange' : 'gray'

  return <div className="model-resource-config">
    <div className="model-source-toolbar"><div><b>模型来源</b><small>本地模型始终可用；这里可以继续添加远程 API 来源</small></div><button className="btn primary" onClick={() => setSourceEditor({ name: '', baseUrl: '', apiKey: '', modelName: '' })}><Plus />添加远程来源</button></div>
    <div className="model-source-list">{draft.embeddingSources.map(source => <section className={`model-source-card ${source.id === draft.embeddingSourceId ? 'selected' : ''} ${recommendationSourceId === source.id ? 'recommendations-open' : ''}`} key={source.id}>
      <header><div className={`source-kind ${source.type}`} >{source.type === 'local' ? <Download /> : <Database />}</div><span><b>{source.name}</b><small title={source.type === 'remote_api' ? source.baseUrl : undefined}>{source.type === 'local' ? '系统内置 · 可同时运行多个模型' : source.baseUrl}</small></span><Badge tone={source.type === 'local' ? 'green' : 'purple'}>{source.type === 'local' ? '本地' : '远程 API'} · {source.models.length} 个</Badge>{source.type === 'remote_api' && <><button className="icon-btn" title="编辑来源" aria-label={`编辑来源 ${source.name}`} onClick={() => editSource(source)}><Pencil /></button><button className="icon-btn" title="删除来源" aria-label={`删除来源 ${source.name}`} onClick={() => removeSource(source.id)}><Trash2 /></button></>}</header>
      <div className="source-model-list"><div className="source-model-table-head"><span>模型</span><span>向量维度</span><span>状态</span><span>操作</span></div>{source.models.map(model => {
        const runtime = source.type === 'local' ? runtimeStatuses.find(status => status.model === model.name) : undefined
        const working = runtime?.phase === 'downloading' || runtime?.phase === 'loading' || runtime?.phase === 'stopping'
        const running = runtime?.phase === 'running'
        const testKey = `${source.id}:${model.name}`
        const detectedDimensions = runtime?.dimensions ?? model.dimensions
        const dimensionReady = detectedDimensions > 0
        const statusLabel = source.type === 'remote_api' ? model.dimensions > 0 ? '已检测' : '待检测' : runtime?.fallbackUsed && running ? '镜像运行' : phaseLabel(runtime?.phase)
        return <div className={`source-model-row ${working ? 'working' : ''}`} key={model.name}><div className="model-identity"><div className={`model-state-dot ${runtime?.phase ?? (source.type === 'remote_api' && model.dimensions > 0 ? 'configured' : 'idle')}`} /><span><b title={model.name}>{model.name}</b><small>{source.type === 'local' ? '本地模型' : 'API 模型'}{runtime?.maxTokens ? ` · 最大 ${runtime.maxTokens} tokens` : ''}</small></span></div><div className={`model-dimension ${dimensionReady ? 'ready' : 'pending'} ${runtime?.error ? 'failed' : ''}`}><b>{dimensionReady ? `${detectedDimensions} 维` : '自动检测'}</b><small title={runtime?.error}>{runtime?.error ?? (dimensionReady ? '已识别' : source.type === 'local' ? '运行后识别' : '检测后识别')}</small></div><Badge tone={source.type === 'remote_api' ? model.dimensions > 0 ? 'blue' : 'orange' : phaseTone(runtime?.phase)}>{statusLabel}</Badge><div className="model-row-actions">{source.type === 'local' ? <button className={`btn ${running ? 'danger' : 'ghost'}`} disabled={runtimeBusy === model.name || working} onClick={() => void operateLocalModel(model.name, running)}>{running ? <><XCircle />停止</> : <><Play />运行</>}</button> : <button className="btn ghost" disabled={Boolean(testingModel)} onClick={() => void testConnection(source, model)}><Activity />{testingModel === testKey ? '检测中' : model.dimensions > 0 ? '重检' : '检测'}</button>}{source.type === 'local' && <button className="icon-btn model-remove" title="移除模型" aria-label={`移除模型 ${model.name}`} onClick={() => void removeModel(source, model.name)}><Trash2 /></button>}</div>{working && <div className="model-row-progress"><Progress value={runtime?.progress ?? 0} tone="orange" /><small>{runtime?.progress ?? 0}%</small></div>}</div>
      })}{source.models.length === 1 && <button type="button" className="source-model-add-slot" onClick={() => document.getElementById(`model-input-${source.id}`)?.focus()}><Plus /><span><b>继续添加模型</b><small>同一来源可以配置多个模型</small></span></button>}{source.models.length === 0 && <div className="source-model-empty"><Download /><span><b>暂无{source.type === 'local' ? '本地' : '远程'}模型</b><small>可以从下方输入模型名称并添加。</small></span></div>}</div>
      <div className="add-source-model">{source.type === 'local' ? <div className="model-recommendation-combobox" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setRecommendationSourceId('') }}><input id={`model-input-${source.id}`} value={modelDrafts[source.id] ?? ''} onFocus={() => setRecommendationSourceId(source.id)} onChange={event => { setModelDrafts(current => ({ ...current, [source.id]: event.target.value })); setRecommendationSourceId(source.id) }} placeholder="选择推荐模型或输入 Hugging Face 模型名" aria-label="本地模型名称" autoComplete="off" /><button className="recommendation-trigger" type="button" title="选择推荐模型" aria-label="选择推荐模型" aria-expanded={recommendationSourceId === source.id} onClick={() => setRecommendationSourceId(current => current === source.id ? '' : source.id)}><Sparkles /><ChevronDown /></button>{recommendationSourceId === source.id && <div className="model-recommendation-menu" role="listbox"><header><span><Sparkles />推荐模型</span><small>也可以直接输入其他模型名称</small></header>{localModelRecommendations.filter(item => { const query = (modelDrafts[source.id] ?? '').trim().toLocaleLowerCase(); return !query || item.name.toLocaleLowerCase().includes(query) || item.title.toLocaleLowerCase().includes(query) }).map(item => { const added = source.models.some(model => model.name === item.name); return <button type="button" role="option" aria-selected={modelDrafts[source.id] === item.name} disabled={added} key={item.name} onClick={() => { setModelDrafts(current => ({ ...current, [source.id]: item.name })); setRecommendationSourceId('') }}><span><b>{item.title}</b><small>{item.name}</small></span><em>{added ? '已添加' : item.detail}</em></button>})}{localModelRecommendations.every(item => { const query = (modelDrafts[source.id] ?? '').trim().toLocaleLowerCase(); return query && !item.name.toLocaleLowerCase().includes(query) && !item.title.toLocaleLowerCase().includes(query) }) && <p>没有匹配的推荐项，可直接使用当前输入的自定义模型。</p>}</div>}</div> : <input id={`model-input-${source.id}`} value={modelDrafts[source.id] ?? ''} onChange={event => setModelDrafts(current => ({ ...current, [source.id]: event.target.value }))} placeholder="API 模型名称" />}<span className="auto-dimension"><Activity />维度自动检测</span><button className="btn ghost" onClick={() => addModel(source)}><Plus />添加模型</button></div>
    </section>)}</div>
    <div className="active-model-picker"><div className="picker-title"><CheckCircle2 /><span><b>知识库生效模型</b><small>先选择来源，再选择该来源下用于向量化和检索的模型</small></span></div><label><span>使用来源</span><select value={selectedSource?.id ?? ''} onChange={event => { const source = draft.embeddingSources.find(item => item.id === event.target.value); if (source) applySelection(source) }}>{draft.embeddingSources.map(source => <option key={source.id} value={source.id}>{source.name} · {source.type === 'local' ? '本地' : '远程'}</option>)}</select></label><label><span>使用模型</span><select value={draft.embeddingModel} disabled={!selectedSource?.models.length} onChange={event => { const model = selectedSource?.models.find(item => item.name === event.target.value); if (selectedSource && model) applySelection(selectedSource, model) }}>{!selectedSource?.models.length && <option value="">暂无模型</option>}{selectedSource?.models.map(model => <option key={model.name} value={model.name}>{model.name} · {model.dimensions > 0 ? `${model.dimensions} 维` : '自动检测'}</option>)}</select></label></div>
    {selectedSource && <div className={`active-model-summary ${draft.embeddingModel ? '' : 'empty'}`}><Zap /><span><b>{draft.embeddingModel ? `当前选择：${selectedSource.name} / ${draft.embeddingModel}` : '当前没有生效模型'}</b><small>{draft.embeddingModel ? selectedSource.type === 'local' ? '保存后，任务会使用对应的本地运行实例；未运行时将自动启动。' : `请求将发送到 ${selectedSource.baseUrl}` : '可以保存空模型列表；添加本地模型或选择远程模型后即可恢复向量能力。'}</small></span></div>}
    {sourceEditor && <Modal title={sourceEditor.id ? '编辑远程模型来源' : '添加远程模型来源'} onClose={() => setSourceEditor(null)}><div className="modal-form"><p>支持 OpenAI 兼容 Embeddings API 和 Ollama 原生 API。Ollama 可直接填写 <code>http://localhost:11434/api/embed</code>。</p><label>来源名称<input value={sourceEditor.name} onChange={event => setSourceEditor(current => current ? { ...current, name: event.target.value } : current)} placeholder="例如：本机 Ollama" /></label><label>Base URL<input value={sourceEditor.baseUrl} onChange={event => setSourceEditor(current => current ? { ...current, baseUrl: event.target.value } : current)} placeholder="https://api.example.com/v1 或 http://localhost:11434/api/embed" /></label><label>API Key（可选）<input type="password" value={sourceEditor.apiKey} onChange={event => setSourceEditor(current => current ? { ...current, apiKey: event.target.value } : current)} placeholder={sourceEditor.id ? '留空保留已保存的凭据' : 'Ollama 本地接口可留空'} /></label>{sourceEditor.id ? <div className="auto-detect-note"><Activity /><span><b>模型与维度将保留</b><small>API Key 留空会保留已保存的凭据；如需刷新模型维度，请在来源卡片中点击“重检”。</small></span></div> : <><label>首个模型<input value={sourceEditor.modelName} onChange={event => setSourceEditor(current => current ? { ...current, modelName: event.target.value } : current)} placeholder="例如：bge-m3" /></label><div className="auto-detect-note"><Activity /><span><b>向量维度：自动检测</b><small>添加后点击“检测”，系统将请求一次 Embedding 并记录实际维度。添加后不会自动切换知识库生效模型。</small></span></div></>}<div className="modal-actions"><button className="btn ghost" onClick={() => setSourceEditor(null)}>取消</button><button className="btn primary" onClick={saveSource}>{sourceEditor.id ? <><Check />保存来源</> : <><Plus />添加来源</>}</button></div></div></Modal>}
  </div>
}

function RerankerModelDropdown({ source, value, onChange }: { source: EmbeddingSourceDraft | undefined; value: string; onChange: (model: string) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const selected = source?.models.find(model => model.name === value)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const models = source?.models.filter(model => !normalizedQuery || model.name.toLocaleLowerCase().includes(normalizedQuery)) ?? []
  useEffect(() => { setOpen(false); setQuery('') }, [source?.id])
  return <div className={`reranker-model-dropdown ${open ? 'open' : ''}`} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false) }}><button type="button" className="reranker-model-trigger" disabled={!source} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(current => !current)}><span><b title={selected?.name}>{selected?.name ?? '请选择 Reranker 模型'}</b><small>{selected ? `${source?.type === 'local' ? '本地模型' : '远程 API'} · ${selected.dimensions > 0 ? `${selected.dimensions} 维` : '维度待检测'}` : '当前来源暂无可选模型'}</small></span>{selected && <Badge tone={selected.dimensions > 0 ? 'green' : 'orange'}>{selected.dimensions > 0 ? '可用' : '待检测'}</Badge>}<ChevronDown /></button>{open && <div className="reranker-model-menu"><div className="reranker-model-search"><Search /><input value={query} autoFocus onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setOpen(false) }} placeholder="搜索模型名称" aria-label="搜索 Reranker 模型" /></div><div className="reranker-model-menu-list" role="listbox">{models.map(model => { const active = model.name === value; return <button type="button" role="option" aria-selected={active} className={active ? 'active' : ''} key={model.name} onClick={() => { onChange(model.name); setOpen(false); setQuery('') }}><span className="reranker-menu-check">{active && <Check />}</span><span><b title={model.name}>{model.name}</b><small>{source?.type === 'local' ? '本地模型' : '远程 API'} · {model.dimensions > 0 ? `${model.dimensions} 维` : '维度待检测'}</small></span><Badge tone={model.dimensions > 0 ? 'green' : 'orange'}>{model.dimensions > 0 ? '可用' : '待检测'}</Badge></button>})}{models.length === 0 && <p>没有匹配的模型</p>}</div><footer>共 {source?.models.length ?? 0} 个模型{normalizedQuery ? ` · 匹配 ${models.length} 个` : ''}</footer></div>}</div>
}

function RetrievalIndexConfig({ knowledgeBaseId, requiresRebuild, onRebuilt, draft, update, notify }: { knowledgeBaseId: string; requiresRebuild: boolean; onRebuilt: () => void; draft: SettingsDraft; update: <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => void; notify: Notify }) {
  const [rebuild, setRebuild] = useState<JobStatus>('idle')
  const [rebuildProgress, setRebuildProgress] = useState(0)
  const [rebuildTaskId, setRebuildTaskId] = useState('')
  const [rebuildPollVersion, setRebuildPollVersion] = useState(0)

  useEffect(() => {
    if (!knowledgeBaseId) return
    let cancelled = false
    let timer: number | undefined
    const refreshRebuild = async () => {
      try {
        const tasks = await loadTasks(knowledgeBaseId)
        if (cancelled) return
        const activeTask = tasks.find(task => task.type === 'rebuild' && (task.status === 'queued' || task.status === 'running'))
        const trackedTask = rebuildTaskId ? tasks.find(task => task.id === rebuildTaskId) : undefined
        const task = activeTask ?? trackedTask
        if (!task) return
        setRebuildTaskId(task.id)
        setRebuildProgress(task.progress)
        if (task.status === 'queued' || task.status === 'running') {
          setRebuild('running')
          timer = window.setTimeout(() => void refreshRebuild(), 1_000)
          return
        }
        setRebuildTaskId('')
        if (task.status === 'succeeded') {
          setRebuild('completed')
          onRebuilt()
          notify('候选索引校验完成，活动索引已原子切换。')
        } else if (task.status === 'cancelled') {
          setRebuild('cancelled')
          notify('索引重建已取消，旧活动索引继续生效。')
        } else if (task.status === 'failed') {
          setRebuild('failed')
          notify(task.error ?? '索引重建失败，旧索引继续生效。', 'error')
        }
      } catch {
        if (!cancelled) timer = window.setTimeout(() => void refreshRebuild(), 3_000)
      }
    }
    void refreshRebuild()
    return () => { cancelled = true; if (timer) window.clearTimeout(timer) }
  }, [knowledgeBaseId, rebuildTaskId, rebuildPollVersion])

  const startRebuild = async () => {
    if (rebuild === 'running') return
    setRebuild('running')
    setRebuildProgress(0)
    try {
      const queued = await rebuildIndex(knowledgeBaseId)
      setRebuildTaskId(queued.task.id)
      setRebuildProgress(queued.task.progress)
      setRebuildPollVersion(version => version + 1)
    } catch (error) {
      setRebuild('failed')
      notify(error instanceof Error ? error.message : '索引重建失败，旧索引继续生效。', 'error')
    }
  }

  const cancelRebuild = async () => {
    if (!rebuildTaskId) return
    try {
      await cancelTask(rebuildTaskId)
      setRebuildPollVersion(version => version + 1)
    } catch (error) {
      notify(error instanceof Error ? error.message : '取消索引重建失败。', 'error')
    }
  }
  const rerankerSource = draft.embeddingSources.find(source => source.id === draft.rerankerSourceId)
  const rerankerModel = rerankerSource?.models.find(model => model.name === draft.rerankerModel)
  const toggleReranker = (enabled: boolean) => {
    update('rerankerEnabled', enabled)
    if (!enabled || (rerankerSource && rerankerModel)) return
    const fallback = draft.embeddingSources.find(source => source.id === draft.embeddingSourceId) ?? draft.embeddingSources[0]
    if (fallback) { update('rerankerSourceId', fallback.id); update('rerankerModel', fallback.models[0]?.name ?? '') }
  }
  return <div className="retrieval-config">
    <div className="retrieval-block"><div className="block-title"><div><b>混合检索</b><small>保存后用于后续真实检索，不需要重建索引</small></div><label className="switch"><input type="checkbox" checked={draft.hybridSearch} onChange={event => update('hybridSearch', event.target.checked)} aria-label="启用混合检索" /><i /></label></div><div className="parameter-grid"><label><span>向量召回数量</span><select value={draft.vectorRecall} onChange={event => update('vectorRecall', event.target.value)}><option>30</option><option>40</option><option>50</option></select></label><label><span>关键词召回数量</span><select value={draft.keywordRecall} onChange={event => update('keywordRecall', event.target.value)}><option>30</option><option>40</option><option>50</option></select></label><label><span>最终返回数量</span><select value={draft.finalResults} onChange={event => update('finalResults', event.target.value)}><option>5</option><option>8</option><option>10</option></select></label><label><span>最低相关度</span><div className="threshold"><input type="range" min="0" max="100" value={Math.round(draft.relevanceThreshold * 100)} onChange={event => update('relevanceThreshold', Number(event.target.value) / 100)} /><b>{draft.relevanceThreshold.toFixed(2)}</b></div></label></div></div>
    <div className="retrieval-block reranker-block"><div className="block-title"><div><b>Reranker 结果重排</b><small>可独立选择模型来源和模型，不受 Embedding 生效模型限制</small></div><label className="switch"><input type="checkbox" checked={draft.rerankerEnabled} onChange={event => toggleReranker(event.target.checked)} aria-label="启用 Reranker" /><i /></label></div>{draft.rerankerEnabled && <div className="reranker-config-body"><div className="reranker-source-field"><div className="reranker-field-label"><i>1</i><span><b>选择模型来源</b><small>本地模型或已配置的远程 API</small></span></div><select value={rerankerSource?.id ?? ''} onChange={event => { const source = draft.embeddingSources.find(item => item.id === event.target.value); if (source) { update('rerankerSourceId', source.id); update('rerankerModel', source.models[0]?.name ?? '') } }}>{draft.embeddingSources.map(source => <option key={source.id} value={source.id}>{source.name} · {source.type === 'local' ? '本地' : '远程 API'}</option>)}</select></div><div className="reranker-model-field"><div className="reranker-field-label"><i>2</i><span><b>选择 Reranker 模型</b><small>支持搜索；模型较多时在下拉列表内滚动</small></span></div><RerankerModelDropdown source={rerankerSource} value={draft.rerankerModel} onChange={model => update('rerankerModel', model)} /></div><div className={`reranker-selection-summary ${rerankerModel?.dimensions ? 'ready' : 'pending'}`}><Activity /><span><b>{rerankerModel?.dimensions ? 'Reranker 已就绪' : 'Reranker 尚未就绪'}</b><small>{rerankerSource?.name ?? '未选择来源'} / {rerankerModel?.name ?? '未选择模型'}{rerankerModel?.dimensions ? ` · ${rerankerModel.dimensions} 维` : ' · 请先运行或检测模型'}</small></span><Badge tone={rerankerModel?.dimensions ? 'green' : 'orange'}>{rerankerModel?.dimensions ? '配置有效' : '需要处理'}</Badge></div></div>}</div>
    <div className="index-rebuild"><div className="index-status"><div className={`index-icon ${rebuild === 'running' ? 'running' : rebuild === 'completed' ? 'done' : ''}`}><Database /></div><div><b>活动索引</b><Badge tone={rebuild === 'running' || requiresRebuild ? 'orange' : 'green'}>{rebuild === 'running' ? '正在构建候选索引' : requiresRebuild ? '配置待重建' : rebuild === 'completed' ? '已切换新索引' : '当前索引可用'}</Badge><small>{rebuild === 'running' ? '重建期间旧活动索引继续提供检索' : '索引绑定固定配置快照与资产版本范围'}</small></div></div>{rebuild === 'running' && <div className="rebuild-progress"><div><span>正在处理资产与 Chunk</span><b>{rebuildProgress}%</b></div><Progress value={rebuildProgress} /></div>}{rebuild === 'cancelled' && <div className="rebuild-notice"><AlertTriangle /><span><b>重建已取消</b><small>旧活动索引未发生变化。</small></span></div>}{rebuild === 'failed' && <div className="rebuild-notice"><AlertTriangle /><span><b>重建失败</b><small>旧活动索引继续有效，可在任务列表查看错误。</small></span></div>}{rebuild === 'completed' && <div className="rebuild-done"><CheckCircle2 /><span><b>重建完成</b><small>候选索引已校验并原子切换。</small></span></div>}<div className="index-actions">{rebuild === 'running' && <button className="btn danger" onClick={() => void cancelRebuild()}><XCircle />取消</button>}<button className="btn primary" disabled={rebuild === 'running' || !requiresRebuild} onClick={() => void startRebuild()}><RefreshCw className={rebuild === 'running' ? 'rotating' : ''} />{requiresRebuild ? '确认重建索引' : '无需重建'}</button></div></div>
  </div>
}

export default App
