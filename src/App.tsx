import { forwardRef, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import {
  Activity, AlertTriangle, ArrowDown, ArrowUp, BookOpen, Bot, BrainCircuit, Check, CheckCircle2, ChevronDown,
  ChevronRight, CircleHelp, Clock3, Code2, Columns2, Database, Download, FileCode2, FileText,
  FolderOpen, FolderPlus, GitBranch, LayoutDashboard, Library, ListChecks, MessageSquareText, MoreHorizontal,
  PanelLeftClose, PanelLeftOpen, Pencil, Play, Plus, RefreshCw, Search, Server, Settings, ShieldCheck, Sparkles,
  TestTube2, Trash2, Upload, Users, XCircle, Zap,
} from 'lucide-react'
import {
  initialSettings, type KnowledgeDirectory, type KnowledgeDocument,
  type EmbeddingSourceDraft, type GenerativeModelDraft, type GenerativeSourceDraft, type SettingsDraft,
} from './prototype-data'
import { cancelTask, createKnowledgeDirectory, deleteKnowledgeAsset, deleteKnowledgeDirectory, discoverGenerativeModels, ensureKnowledgeBase, loadAssetVersion, loadConfig, loadGenerativeModelSources, loadKnowledgeAssets, loadKnowledgeOverview, loadLocalModelStatuses, loadTasks, probeGenerativeModel, rebuildIndex, renameKnowledgeDirectory, retryTask, saveConfig, saveGenerativeModelSources, searchKnowledge, startLocalModel, stopLocalModel, testEmbeddingConfig, updateKnowledgeAsset, uploadKnowledgeArchive, uploadKnowledgeFile, type ApiIndexSummary, type ApiSearchMeta, type ApiSearchResult, type LocalModelStatus } from './knowledge-api'
import { MarkdownDocument } from './MarkdownDocument'
import { getActiveDocumentSectionKey, getClosestSourceLineIndex } from './document-scroll'
import { emptyMarkdownOutline, parseMarkdownOutline, type MarkdownOutline } from './markdown-outline'
import { RequirementReviewPage } from './RequirementReviewPage'
import { createProjectVersion, deleteProjectVersion, loadProjectVersions, updateProjectVersionStatus, type ProjectVersion, type ProjectVersionStatus } from './project-version-api'

type PageKey = 'dashboard' | 'requirements' | 'documents' | 'design' | 'execution' | 'reports' | 'settings'
type NotifyTone = 'success' | 'error' | 'warning'
type Notify = (message: string, tone?: NotifyTone) => void
type JobStatus = 'idle' | 'running' | 'completed' | 'cancelled' | 'failed'
type SearchLocation = { assetId: string; assetVersionId: string; startLine: number; endLine: number; nonce: number }
const retrievalModeLabel = (mode: string) => mode === 'hybrid' ? '混合检索' : mode === 'vector' ? '向量检索' : '关键词检索'

const pageStorageKey = 'smarthub-current-page'
const projectVersionStorageKey = 'smarthub-project-version-id'
const pageKeys: PageKey[] = ['dashboard', 'requirements', 'documents', 'design', 'execution', 'reports', 'settings']
const restorePage = (): PageKey => {
  if (typeof window === 'undefined') return 'dashboard'
  const saved = window.localStorage.getItem(pageStorageKey)
  return pageKeys.includes(saved as PageKey) ? saved as PageKey : 'dashboard'
}

const menu: { key: PageKey; label: string; icon: typeof LayoutDashboard; hint?: string }[] = [
  { key: 'dashboard', label: '工作台', icon: LayoutDashboard },
  { key: 'requirements', label: '需求分析', icon: BrainCircuit },
  { key: 'design', label: '测试设计', icon: TestTube2, hint: '8' },
  { key: 'execution', label: '测试执行', icon: Play },
  { key: 'reports', label: '报告与诊断', icon: Activity },
]

const pageMeta: Record<PageKey, { title: string; desc: string }> = {
  dashboard: { title: '工作台', desc: '掌握项目质量状态与 AI 任务进展' },
  requirements: { title: '需求分析', desc: '让 AI 帮你发现需求缺口、边界与测试风险' },
  documents: { title: '知识库', desc: '管理项目文档、技术方案与知识资产' },
  design: { title: '测试设计', desc: '从需求与风险快速生成可审核的测试资产' },
  execution: { title: '测试执行', desc: '跟踪计划、套件和用例的实时执行状态' },
  reports: { title: '报告与诊断', desc: '聚合质量趋势、失败原因与发布建议' },
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
  const [selectedProjectVersionId, setSelectedProjectVersionId] = useState(() => typeof window === 'undefined' ? '' : window.localStorage.getItem(projectVersionStorageKey) ?? '')
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

  const notify: Notify = (message, tone = 'success') => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    const next = { id: Date.now(), message, tone }
    setToast(next)
    toastTimer.current = window.setTimeout(() => setToast(current => current?.id === next.id ? null : current), 2600)
  }

  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current) }, [])
  useEffect(() => { window.localStorage.setItem(pageStorageKey, page) }, [page])
  const activeProjectVersion = projectVersions.find(item => item.id === selectedProjectVersionId) ?? null
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
    setKnowledgeDocumentList(data.documents)
    setKnowledgeApiState('ready')
  }, [knowledgeBaseId])
  useEffect(() => {
    let cancelled = false
    let retryTimer: number | undefined
    const connect = async () => {
      setKnowledgeApiState('connecting')
      try {
        const id = await ensureKnowledgeBase()
        if (cancelled) return
        setKnowledgeBaseId(id)
        await refreshKnowledge(false, id)
        await refreshProjectVersions()
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
        {menu.map(item => <button key={item.key} className={page === item.key ? 'active' : ''} onClick={() => setPage(item.key)}><item.icon size={18} /><span>{item.label}</span>{item.hint && <em>{item.hint}</em>}</button>)}
        <p className="nav-label second nav-scope"><span>平台管理</span><em>全局</em></p>
        <button className={page === 'documents' ? 'active' : ''} onClick={() => setPage('documents')}><Library size={18} /><span>知识库</span></button>
        <button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}><Settings size={18} /><span>系统管理</span></button>
      </nav>
      <button className="sidebar-account" onClick={() => notify('当前账号：李磊 · 测试负责人')} aria-label="查看当前账号">
        <span className="avatar">LS</span><span className="sidebar-account-info"><b>李磊</b><small>测试负责人</small></span><ChevronRight />
      </button>
      <button className="sidebar-foot" onClick={() => notify('帮助与反馈为静态原型说明：当前数据仅保留在本次会话中。')}><CircleHelp size={17} /><span>帮助与反馈</span><span className="version">v0.1</span></button>
    </aside>
    <main>
      <section className={`content ${page === 'requirements' ? 'requirements-content' : ''} ${page === 'documents' ? 'documents-content' : ''} ${page === 'settings' ? 'settings-content' : ''}`}>
        {page !== 'requirements' && <div className="page-head"><div><h1>{meta.title}</h1><p>{meta.desc}</p></div></div>}
        {page === 'dashboard' && <Dashboard navigate={setPage} projectVersion={activeProjectVersion} onManageVersions={() => setVersionManagerOpen(true)} />}
        {page === 'requirements' && <RequirementReviewPage key={activeProjectVersion?.id ?? 'no-version'} projectVersion={activeProjectVersion} documents={knowledgeDocumentList} knowledgeBaseId={knowledgeBaseId} apiState={knowledgeApiState} refreshKnowledge={() => refreshKnowledge()} onManageVersions={() => setVersionManagerOpen(true)} onOpenKnowledge={() => setPage('documents')} onOpenActivity={() => setActivityOpen(true)} notify={notify} addAudit={entry => setAudit(current => [entry, ...current])} />}
        {page === 'documents' && <Documents knowledgeBaseId={knowledgeBaseId} apiState={knowledgeApiState} refreshKnowledge={refreshKnowledge} directories={knowledgeDirectoryList} documents={knowledgeDocumentList} notify={notify} addAudit={entry => setAudit(current => [entry, ...current])} />}
        {page === 'design' && <StaticNotice title="测试设计" text="测试设计页面仍展示示例资产；本次交互修复聚焦需求分析、知识库和系统设置。" />}
        {page === 'execution' && <StaticNotice title="测试执行" text="测试执行页面仍展示示例执行数据；本次交互修复聚焦需求分析、知识库和系统设置。" />}
        {page === 'reports' && <StaticNotice title="报告与诊断" text="报告页面仍展示示例质量数据；本次交互修复聚焦需求分析、知识库和系统设置。" />}
        {page === 'settings' && <SystemSettings knowledgeBaseId={knowledgeBaseId} notify={notify} addAudit={entry => setAudit(current => [entry, ...current])} />}
      </section>
    </main>
    {toast && <div className={`toast ${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>{toast.tone === 'error' ? <XCircle size={18} /> : toast.tone === 'warning' ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}{toast.message}</div>}
    {activityOpen && <Modal title="本次会话操作记录" onClose={() => setActivityOpen(false)}><div className="activity-modal"><p>记录只保留在当前浏览器会话中。</p>{audit.map((entry, index) => <div key={`${entry}-${index}`}><Clock3 size={15} /><span>{entry}</span></div>)}</div></Modal>}
    {versionManagerOpen && <ProjectVersionManager versions={projectVersions} selectedId={selectedProjectVersionId} onSelect={id => { setSelectedProjectVersionId(id); setVersionManagerOpen(false) }} onRefresh={refreshProjectVersions} onClose={() => setVersionManagerOpen(false)} notify={notify} />}
  </div>
}

function Dashboard({ navigate, projectVersion, onManageVersions }: { navigate: (page: PageKey) => void; projectVersion: ProjectVersion | null; onManageVersions: () => void }) {
  return <div className="dashboard-grid"><section className="card span2 dashboard-notice"><Badge tone="violet"><Sparkles size={12} /> {projectVersion ? `当前版本 ${projectVersion.name}` : '尚未创建项目版本'}</Badge><h2>{projectVersion ? '当前项目空间已按版本隔离' : '先创建项目版本，再开始需求分析'}</h2><p>{projectVersion ? '需求绑定、评审运行与处置上下文只属于当前版本；知识库与系统配置仍为平台全局资源。' : '平台固定服务 SmartHub 单项目，项目空间通过版本切换，不提供项目创建或项目切换。'}</p><div><button className="btn primary" onClick={projectVersion ? () => navigate('requirements') : onManageVersions}>{projectVersion ? '进入需求评审' : '新建项目版本'}</button><button className="btn ghost" onClick={() => navigate('documents')}>查看知识库</button></div></section><section className="card quick-card"><BrainCircuit /><h3>需求评审</h3><p>从当前项目版本绑定的 ready 需求发起分析，版本间结果互不可见。</p><button className="text-btn" onClick={() => navigate('requirements')}>打开需求评审 <ChevronRight /></button></section><section className="card quick-card"><Library /><h3>知识库</h3><p>知识库由平台单项目共享，不随项目版本复制。</p><button className="text-btn" onClick={() => navigate('documents')}>打开知识库 <ChevronRight /></button></section><section className="card quick-card"><Settings /><h3>系统设置</h3><p>模型与平台配置为全局资源，不参与版本隔离。</p><button className="text-btn" onClick={() => navigate('settings')}>打开系统设置 <ChevronRight /></button></section></div>
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
      notify(`项目版本 ${deleted.name} 已删除，同时移除 ${deleted.deletedBindings} 条需求绑定。`)
      if (deleteTarget.id === selectedId) onSelect(remaining[0]?.id ?? '')
      else setDeleteTarget(null)
    } catch (error) { notify(error instanceof Error ? error.message : '项目版本删除失败', 'error') }
    finally { setDeleting(false) }
  }
  return <><Modal title="项目版本" onClose={onClose} className="version-manager-modal"><div className="version-manager"><section><h3>当前项目版本</h3><p>需求分析数据按版本隔离；锁定和归档版本只能查看。删除版本会同时删除该版本的需求绑定。</p><div className="project-version-list">{versions.map(version => <article className={version.id === selectedId ? 'active' : ''} key={version.id}><button className="version-select" onClick={() => onSelect(version.id)}><GitBranch /><span><b>{version.name}</b><small>{version.description || '未填写版本说明'} · {new Date(version.createdAt).toLocaleString('zh-CN')}</small></span><Badge tone={version.status === 'open' ? 'green' : version.status === 'locked' ? 'orange' : 'gray'}>{version.status === 'open' ? '可编辑' : version.status === 'locked' ? '已锁定' : '已归档'}</Badge></button><select aria-label={`设置 ${version.name} 状态`} value={version.status} onChange={event => void changeStatus(version, event.target.value as ProjectVersionStatus)}><option value="open">可编辑</option><option value="locked">锁定</option><option value="archived">归档</option></select><button className="version-delete" title={`删除 ${version.name}`} aria-label={`删除 ${version.name}`} onClick={() => setDeleteTarget(version)}><Trash2 /></button></article>)}{!versions.length && <div className="version-empty"><GitBranch /><b>尚无项目版本</b><span>创建第一个版本后，才能进入需求分析。</span></div>}</div></section><section className="version-create"><h3>新建版本</h3><label>版本名称<input value={name} onChange={event => setName(event.target.value)} placeholder="例如：V1.0 / 2026-Q3" /></label><label>版本说明<textarea value={description} onChange={event => setDescription(event.target.value)} placeholder="本版本目标或范围（可选）" /></label><label>来源版本<select value={sourceId} onChange={event => setSourceId(event.target.value)}><option value="">空白版本</option>{versions.map(version => <option value={version.id} key={version.id}>{version.name}</option>)}</select></label>{sourceId && <label className="version-inherit"><input type="checkbox" checked={inherit} onChange={event => setInherit(event.target.checked)} />继承来源版本的需求绑定（不继承评审运行和对话）</label>}<button className="btn primary full" disabled={!name.trim() || saving} onClick={() => void create()}><Plus />{saving ? '创建中…' : '创建并进入版本'}</button></section></div></Modal>{deleteTarget && <Modal title="删除项目版本" onClose={() => { if (!deleting) setDeleteTarget(null) }}><div className="modal-form version-delete-confirm"><div className="danger-confirm"><AlertTriangle /><span><b>确定删除“{deleteTarget.name}”吗？</b><small>该版本的需求绑定将一并删除，操作不可恢复。知识库原始文件不会被删除。</small></span></div><div className="modal-actions"><button className="btn ghost" disabled={deleting} onClick={() => setDeleteTarget(null)}>取消</button><button className="btn danger" disabled={deleting} onClick={() => void remove()}><Trash2 />{deleting ? '删除中…' : '确认删除'}</button></div></div></Modal>}</>
}

function StaticNotice({ title, text }: { title: string; text: string }) {
  return <section className="card static-notice"><h2>{title}</h2><p>{text}</p></section>
}

function Documents({ knowledgeBaseId, apiState, refreshKnowledge, directories, documents, notify, addAudit }: { knowledgeBaseId: string; apiState: 'connecting' | 'ready' | 'offline'; refreshKnowledge: (includeDeleted?: boolean) => Promise<void>; directories: KnowledgeDirectory[]; documents: KnowledgeDocument[]; notify: Notify; addAudit: (entry: string) => void }) {
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
  const [expandedDirectoryIds, setExpandedDirectoryIds] = useState<Set<string>>(() => new Set(directories.map(directory => directory.id)))
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
        await refreshKnowledge()
        if (!cancelled && active) timer = window.setTimeout(() => void refreshTaskState(), 1_000)
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
    const result = new Map<string | null, KnowledgeDirectory[]>()
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
  const source = file ? makeSource(file) : ''
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
    return ['SmartHub 知识库', ...names].join(' / ')
  }
  const getDirectoryLogicalPath = (directoryId: string) => getDirectoryBreadcrumb(directoryId).split(' / ').slice(1).join('/')
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
  const openRename = (directory: KnowledgeDirectory) => {
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
  const openDelete = (directory: KnowledgeDirectory) => {
    setDirectoryActionId(null)
    setDeleteDirectoryId(directory.id)
    setMoveTargetId(directory.parentId ?? '')
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
    const destination = parentId ? directoryById.get(parentId)?.name ?? '目标目录' : '知识库根目录'
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
    setUploadCandidates(selected); const directoryPath = selectedDirectoryId ? getDirectoryLogicalPath(selectedDirectoryId) : ''
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
  const openFileActions = (target: KnowledgeDocument | undefined = file) => { if (!target) return; setSelectedId(target.id); setFileNameDraft(target.name); setFileTargetDirectoryId(target.parentId ?? ''); setFileActionError(''); setMoreOpen(true) }
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
  const renderTask = (task: KnowledgeDocument['task'] | KnowledgeDirectory['task']) => task ? <span className={`tree-task ${task.status}`} title={task.error ?? `${task.step} ${task.progress}%`}><span>{task.status === 'failed' ? '失败' : task.status === 'queued' ? '排队' : task.step === 'file_cleanup' ? '清理中' : `${task.progress}%`}</span>{task.canRetry && <button onClick={event => { event.stopPropagation(); void retryRowTask(task.id) }}>重试</button>}{task.canCancel && <button onClick={event => { event.stopPropagation(); void cancelRowTask(task.id) }}>取消</button>}</span> : null
  const renderFile = (document: KnowledgeDocument, paddingLeft: string) => <div className={`tree-file-row ${selectedId === document.id ? 'active' : ''}`} key={document.id}><button className={`tree-file ${selectedId === document.id ? 'active' : ''}`} style={{ paddingLeft }} onClick={() => selectFile(document.id)} title={document.task?.error ?? document.name}><FileText /><span>{document.name}</span></button>{renderTask(document.task)}<button className="icon-btn tree-file-action" aria-label={`${document.name}更多操作`} disabled={Boolean(document.task && document.task.status !== 'failed')} onClick={() => openFileActions(document)}><MoreHorizontal /></button></div>
  const renderDirectory = (directory: KnowledgeDirectory, depth: number): ReactNode => {
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
        <button className="icon-btn tree-action" disabled={Boolean(directory.task && directory.task.status !== 'failed')} aria-label={`${directory.name}更多操作`} onClick={() => setDirectoryActionId(current => current === directory.id ? null : directory.id)}><MoreHorizontal /></button>
        {directoryActionId === directory.id && <div className="tree-menu" role="menu"><button role="menuitem" onClick={() => openCreate(directory.id)}><FolderPlus />新建子目录</button><button role="menuitem" onClick={() => openRename(directory)}><Pencil />重命名</button><button className="danger" role="menuitem" onClick={() => openDelete(directory)}><Trash2 />删除目录</button></div>}
      </div>
      {expanded && <div className="tree-children">{childDirectories.map(child => renderDirectory(child, depth + 1))}{childDocuments.map(document => renderFile(document, `${47 + depth * 17}px`))}</div>}
    </div>
  }
  const rootDirectories = directoriesByParent.get(null) ?? []
  const rootDocuments = (documentsByParent.get(null) ?? []).filter(document => !queryText || matchingDocumentIds.has(document.id))
  const editorTarget = directoryEditor?.mode === 'rename' ? directoryById.get(directoryEditor.directoryId) : undefined
  const editorParentId = directoryEditor?.mode === 'create' ? directoryEditor.parentId : editorTarget?.parentId
  const editorParentName = editorParentId ? directoryById.get(editorParentId)?.name : '知识库根目录'
  const deletedDocumentCount = documents.filter(document => document.parentId && deleteDirectoryIds.has(document.parentId)).length
  const uploadIsArchive = uploadCandidates.length === 1 && uploadCandidates[0].name.toLowerCase().endsWith('.zip')
  const uploadIsMultiple = uploadCandidates.length > 1
  const uploadDirectorySuggestions = directories.map(directory => getDirectoryLogicalPath(directory.id)).filter(Boolean).sort((left, right) => left.localeCompare(right, 'zh-CN'))
  const uploadPathSuggestions = uploadIsArchive || uploadIsMultiple ? uploadDirectorySuggestions : uploadCandidates.length === 1 ? [uploadCandidates[0].name, ...uploadDirectorySuggestions.map(path => `${path}/${uploadCandidates[0].name}`)] : []

  return <section className="card knowledge-page">
    <div className="knowledge-toolbar"><div ref={searchInputRef} className="mini-search wide"><Search size={16} /><input aria-label="搜索知识库" value={query} onChange={event => updateSearchQuery(event.target.value)} onFocus={reopenSearchResults} placeholder="搜索文件名称或文档内容" /></div><Badge tone={apiState === 'ready' ? 'green' : apiState === 'connecting' ? 'orange' : 'gray'}>{apiState === 'ready' ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}{apiState === 'ready' ? '知识库已连接' : apiState === 'connecting' ? '正在连接' : 'API 未启动'}</Badge>{activeIndexSummary && <Badge tone="blue">活动索引 V{activeIndexSummary.number} · {activeIndexSummary.dimensions} 维 · {activeIndexSummary.chunks} Chunk · {activeIndexSummary.hnswReady === null ? '内存检索' : activeIndexSummary.hnswReady ? 'HNSW 就绪' : '精确检索'}</Badge>}{candidateProgress && <Badge tone="orange">候选索引 {candidateProgress.step} · {candidateProgress.progress}%（旧索引继续服务）</Badge>}<button className="btn ghost" disabled={syncState === 'running' || apiState !== 'ready'} onClick={() => void sync()}><RefreshCw size={16} />{syncState === 'running' ? '刷新中' : '刷新'}</button><button className="btn primary" disabled={uploadState === 'running' || apiState !== 'ready'} onClick={() => uploadRef.current?.click()}><Upload size={16} />{uploadState === 'running' ? '上传中' : '上传资料'}</button><input ref={uploadRef} className="visually-hidden" type="file" multiple accept=".zip,.md,.txt,application/zip,text/markdown,text/plain" onChange={chooseUpload} />{searchStatus && <div ref={searchPopoverRef} className="knowledge-search-results" role="dialog" aria-label="知识库检索结果">{searchMeta && <div className="search-summary"><b>{retrievalModeLabel(searchMeta.mode)}{searchMeta.degraded ? '（已降级）' : ''}</b><span>关键词召回 {searchMeta.keywordCandidates} · 向量召回 {searchMeta.vectorCandidates} · 通过门槛 {searchMeta.eligibleCandidates}</span><em>{searchMeta.degraded ? '向量服务不可用，已使用关键词检索' : `最低相关度 ${Math.round(searchMeta.minimumRelevance * 100)}%`}</em></div>}{searchResults.length ? searchResults.map(result => <button key={`${result.version.id}-${result.chunk.chunkKey}`} onClick={() => openSearchResult(result)}><b>{result.asset.displayName}<em className="final-score">综合 {Math.round(result.score * 100)}%</em></b><span>{result.excerpt}</span><small>{result.asset.logicalPath} · {result.chunk.headingPath.join(' / ') || '正文'} · L{result.chunk.startLine}-{result.chunk.endLine}</small>{result.scores && <div className="score-breakdown"><i className={result.scores.keyword > 0 ? 'active' : ''}>关键词 {Math.round(result.scores.keyword * 100)}%</i><i className={result.scores.vector > 0 ? 'active' : ''}>向量 {Math.round(result.scores.vector * 100)}%</i>{result.scores.reranker != null && <i className="active">重排 {Math.round(result.scores.reranker * 100)}%</i>}</div>}</button>) : <p>{searchStatus === 'no_ready_assets' ? '尚无已就绪资料。' : searchStatus === 'initial_indexing' ? '正在建立首个索引，请稍后重试。' : searchStatus === 'no_active_index' ? '尚未建立活动索引。' : searchStatus === 'vector_unavailable' ? '向量服务暂不可用，可切换关键词检索。' : searchStatus === 'filter_empty' ? '当前筛选范围没有可检索资料。' : '当前范围没有匹配结果。'}</p>}</div>}</div>
    <div className={`knowledge-layout ${treeCollapsed ? 'tree-collapsed' : ''}`}><aside className={`file-tree ${treeCollapsed ? 'collapsed' : ''}`}><div className="tree-root"><FolderOpen /><b>SmartHub 知识库</b><small>{documents.length}</small><button className="icon-btn tree-root-action" onClick={() => openCreate(null)} aria-label="在知识库根目录新建目录"><FolderPlus /></button><button className="icon-btn tree-collapse" title={treeCollapsed ? '展开文件树' : '收起文件树'} aria-label={treeCollapsed ? '展开文件树' : '收起文件树'} onClick={() => setTreeCollapsed(value => !value)}>{treeCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button></div>{queryText && !matchingDocumentIds.size ? <p className="empty-state">没有匹配的文档。</p> : <div className="tree-content">{rootDirectories.map(directory => renderDirectory(directory, 0))}{rootDocuments.map(document => renderFile(document, '30px'))}</div>}</aside>
      <article ref={documentPanelRef} className={`document-preview ${outlineCollapsed ? 'outline-collapsed' : ''}`}><div className="preview-head"><div className="breadcrumb"><Library size={14} /><span title={file ? getBreadcrumb(file) : undefined}>{file ? getBreadcrumb(file) : '尚未选择文档'}</span></div>{file && <div className="preview-actions">{evidenceFile && <Badge tone="purple">检索证据固定版本</Badge>}<Badge tone={file.task?.status === 'failed' ? 'red' : file.task ? 'orange' : file.status === 'ready' ? 'green' : 'gray'}>{file.task?.status === 'failed' ? '入库失败' : file.task ? `${file.task.step} ${file.task.progress}%` : file.status === 'ready' ? '已入库' : '等待入库'}</Badge><div className="view-switch" role="group" aria-label="文档视图"><button className={viewMode === 'preview' ? 'active' : ''} aria-pressed={viewMode === 'preview'} onClick={() => setViewMode('preview')}><BookOpen />预览</button><button className={viewMode === 'source' ? 'active' : ''} aria-pressed={viewMode === 'source'} onClick={() => setViewMode('source')}><Code2 />源码</button><button className={viewMode === 'split' ? 'active' : ''} aria-pressed={viewMode === 'split'} onClick={() => setViewMode('split')}><Columns2 />分屏</button></div><button className="btn ghost" onClick={() => setHistoryOpen(true)}><Clock3 />版本历史</button><button className="icon-btn" title={outlineCollapsed ? '显示本文目录' : '隐藏本文目录'} aria-label={outlineCollapsed ? '显示本文目录' : '隐藏本文目录'} onClick={() => setOutlineCollapsed(value => !value)}>{outlineCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button><button className="icon-btn" aria-label="文档更多操作" onClick={() => openFileActions()}><MoreHorizontal /></button></div>}</div>
        {file ? viewMode === 'preview' ? <div className="preview-body"><DocumentContent ref={previewRef} file={file} source={source} format={format} outline={outline} knowledgeBaseId={knowledgeBaseId} activeSectionKey={activeSectionKey} onOpenDocument={openLinkedDocument} onOpenImage={() => setImageOpen(true)} /><nav ref={outlineRef} className="document-outline" aria-label="本文目录"><b>本文目录</b>{outline.sections.map(section => <button key={section.key} data-outline-section-key={section.key} className={activeSectionKey === section.key ? 'active' : ''} onClick={() => jumpToSection(section.key)}>{section.title}</button>)}</nav></div> : viewMode === 'source' ? <SourceView source={source} /> : <div className="split-view"><section className="split-pane source-pane"><header><Code2 />Markdown 源码 <Badge tone="orange">只读</Badge></header><SourceView source={source} /></section><section className="split-pane rendered-pane"><header><BookOpen />渲染预览</header><DocumentContent file={file} source={source} format={format} outline={outline} knowledgeBaseId={knowledgeBaseId} activeSectionKey={activeSectionKey} onOpenDocument={openLinkedDocument} onOpenImage={() => setImageOpen(true)} compact /></section></div> : <div className="document-empty"><FolderOpen /><h2>暂无可预览文档</h2><p>请上传资料，或检查知识库服务连接后再刷新。</p></div>}
      </article></div>
    {imageOpen && <ImageLightbox onClose={() => setImageOpen(false)} />}
    {uploadCandidates.length > 0 && <Modal title={uploadIsArchive ? '上传 Markdown 压缩包' : uploadIsMultiple ? `批量上传 ${uploadCandidates.length} 个文档` : '上传知识资产'} onClose={() => setUploadCandidates([])}><div className="modal-form"><p>{uploadIsArchive ? '将保留 ZIP 内的目录结构，导入 Markdown/TXT，并保存其中被文档相对路径引用的 PNG、JPG、GIF、WebP 或 SVG 图片。' : uploadIsMultiple ? '所选 Markdown/TXT 将统一上传到目标目录，每个文件独立生成资产版本并进入活动索引。' : '文件将按逻辑路径保存到系统默认知识库目录，并生成不可变版本快照；索引切换完成后进入检索。'}</p><label>{uploadIsMultiple ? '已选文件' : '文件'}<input value={uploadIsMultiple ? `${uploadCandidates.length} 个：${uploadCandidates.map(file => file.name).join('、')}` : uploadCandidates[0].name} readOnly title={uploadCandidates.map(file => file.name).join('\n')} /></label><label>资料类型<input value={uploadAssetType} onChange={event => setUploadAssetType(event.target.value)} placeholder="输入资料类型" /></label><label>{uploadIsArchive || uploadIsMultiple ? '导入到目录（可留空）' : '知识库路径'}<input list="knowledge-upload-paths" value={uploadLogicalPath} onChange={event => setUploadLogicalPath(event.target.value)} placeholder={uploadIsArchive || uploadIsMultiple ? '输入或选择现有目录' : '输入或选择知识库路径'} /><small className="field-hint">可从现有知识库目录中选择，也可以直接输入新路径。</small></label><datalist id="knowledge-upload-paths">{uploadPathSuggestions.map(path => <option key={path} value={path} />)}</datalist><div className="modal-actions"><button className="btn ghost" onClick={() => setUploadCandidates([])}>取消</button><button className="btn primary" disabled={(!uploadIsArchive && !uploadIsMultiple && !uploadLogicalPath.trim()) || !uploadAssetType.trim() || uploadState === 'running'} onClick={() => void upload()}><Upload />确认上传</button></div></div></Modal>}
    {historyOpen && file && <Modal title="文档版本历史" onClose={() => setHistoryOpen(false)}><div className="history-list">{file.versions?.length ? [...file.versions].reverse().map(version => <div key={version.id}><b>V{version.number} · {version.status}</b><span>{new Date(version.createdAt).toLocaleString('zh-CN')} · {version.id}</span></div>) : <div><b>{file.version}</b><span>当前展示版本 · {file.updated}</span></div>}</div></Modal>}
    {moreOpen && file && <Modal title={`文件操作：${file.name}`} onClose={() => { if (!fileActionBusy) setMoreOpen(false) }}><div className="modal-form"><p>移动、重命名和删除会同步更新 PostgreSQL、系统默认文件目录与活动索引。</p><label>文件名称<input value={fileNameDraft} onChange={event => { setFileNameDraft(event.target.value); setFileActionError('') }} placeholder="document.md" /></label><div className="modal-actions"><button className="btn primary" disabled={fileActionBusy || !fileNameDraft.trim() || fileNameDraft === file.name} onClick={() => void renameFile()}><Pencil />保存名称</button></div><div className="move-directory"><label>移动至<select value={fileTargetDirectoryId} onChange={event => { setFileTargetDirectoryId(event.target.value); setFileActionError('') }}><option value="">知识库根目录</option>{directories.map(directory => <option key={directory.id} value={directory.id}>{getDirectoryBreadcrumb(directory.id)}</option>)}</select></label><button className="btn primary" disabled={fileActionBusy || fileTargetDirectoryId === (file.parentId ?? '')} onClick={() => void moveFile()}><FolderOpen />移动文件</button></div>{fileActionError && <small className="field-error">{fileActionError}</small>}<div className="modal-actions delete-modal-actions"><button className="btn ghost" disabled={fileActionBusy} onClick={() => setMoreOpen(false)}>取消</button><button className="btn danger" disabled={fileActionBusy} onClick={() => void deleteFile()}><Trash2 />删除文件</button></div></div></Modal>}
    {directoryEditor && <Modal title={directoryEditor.mode === 'create' ? '新建目录' : '重命名目录'} onClose={closeEditor}><div className="modal-form"><p>{directoryEditor.mode === 'create' ? `将在“${editorParentName}”中创建目录。` : '目录名称更新后，相关文档路径会同步更新。'} 变更会保存到知识库数据库。</p><label>目录名称<input value={directoryName} onChange={event => { setDirectoryName(event.target.value); setDirectoryNameError('') }} autoFocus placeholder="例如：接口规范" /></label>{directoryNameError && <small className="field-error">{directoryNameError}</small>}<div className="modal-actions"><button className="btn ghost" disabled={directorySaving} onClick={closeEditor}>取消</button><button className="btn primary" disabled={directorySaving} onClick={() => void saveDirectory()}>{directorySaving ? '保存中' : directoryEditor.mode === 'create' ? '创建目录' : '保存名称'}</button></div></div></Modal>}
    {deleteTarget && <Modal title={`删除目录：${deleteTarget.name}`} onClose={closeDelete}><div className="modal-form"><p>此目录包含 {deleteDirectoryIds.size - 1} 个子目录和 {deletedDocumentCount} 份文档。操作完成后会同步保存到知识库数据库。</p><div className="delete-summary"><span><FolderOpen />目录树</span><b>{deleteDirectoryIds.size} 个目录</b><span><FileText />文档</span><b>{deletedDocumentCount} 份</b></div><div className="move-directory"><label>移动内容至<select value={moveTargetId} onChange={event => setMoveTargetId(event.target.value)}><option value="">知识库根目录</option>{moveCandidates.map(directory => <option key={directory.id} value={directory.id}>{getDirectoryBreadcrumb(directory.id)}</option>)}</select></label><button className="btn primary" onClick={() => void moveContents()}>移动内容并删除目录</button></div><div className="modal-actions delete-modal-actions"><button className="btn ghost" onClick={closeDelete}>取消</button><button className="btn danger" onClick={() => void deleteEverything()}><Trash2 />全部删除</button></div></div></Modal>}
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
    { name: '模型管理', desc: '通用模型来源、模型与能力管理', icon: Bot, group: 'AI 能力' },
    { name: 'Prompt 与 Agent', desc: 'Agent 模型、Prompt、工具和版本', icon: Sparkles, group: 'AI 能力' },
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
  const editorScrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (!knowledgeBaseId) return; void Promise.all([loadConfig(knowledgeBaseId), loadGenerativeModelSources()]).then(([value, generativeSources]) => {
    const config = value.config
    const mapped: SettingsDraft = { ...initialSettings, generativeSources, parserVersion: config.parserVersion, preprocessVersion: config.preprocessVersion, chunkSize: `${config.chunkTargetSize} tokens`, chunkMaxSize: String(config.chunkMaxSize), chunkOverlap: `${config.chunkOverlap} tokens`, headingDepth: String(config.headingDepth), embeddingSourceId: config.embeddingSourceId, embeddingSources: config.embeddingSources, embeddingMode: config.embeddingMode, embeddingBaseUrl: config.embeddingBaseUrl, embeddingApiKey: config.embeddingApiKey, embeddingModel: config.embeddingModel, embeddingDimensions: String(config.embeddingDimensions), embeddingBatchSize: String(config.embeddingBatchSize), embeddingTimeoutMs: String(config.embeddingTimeoutMs), embeddingRetries: String(config.embeddingRetries), vectorRecall: String(config.vectorRecall), keywordRecall: String(config.keywordRecall), finalResults: String(config.finalResults), relevanceThreshold: config.relevanceThreshold, hybridSearch: config.hybridSearch, rerankerEnabled: config.rerankerEnabled, rerankerSourceId: config.rerankerSourceId ?? config.embeddingSourceId, rerankerModel: config.rerankerModel }
    const loaded = { ...mapped, ...repairGenerativeRouting(generativeSources, new Set(), mapped) }
    setSaved(loaded); setDraft(loaded); setConfigVersion(value.version); setRequiresRebuild(value.requiresRebuild)
  }).catch(error => notify(error instanceof Error ? error.message : '系统配置 API 未连接。', 'error')) }, [knowledgeBaseId])
  const current = items[selected]
  const CurrentIcon = current.icon
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft)
  useEffect(() => { editorScrollRef.current?.scrollTo({ top: 0 }) }, [selected])
  useEffect(() => { const warn = (event: BeforeUnloadEvent) => { if (!dirty) return; event.preventDefault(); event.returnValue = '' }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn) }, [dirty])
  const update = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => setDraft(currentDraft => ({ ...currentDraft, [key]: value }))
  const save = async () => {
    if (selected === 0) {
      try {
        const generativeSources = await saveGenerativeModelSources(draft.generativeSources)
        const next = { ...draft, generativeSources, ...repairGenerativeRouting(generativeSources, new Set(), draft) }
        setSaved(next); setDraft(next); addAudit('保存生成式模型来源和模型配置'); notify('模型来源和模型配置已持久化。'); return
      } catch (error) { notify(error instanceof Error ? error.message : '模型配置保存失败', 'error'); return }
    }
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
  return <div className={`settings-layout ${collapsed ? 'directory-collapsed' : ''}`}><aside className={`card settings-directory ${collapsed ? 'collapsed' : ''}`}><div className="settings-dir-head"><b>配置目录</b><button className="icon-btn" title={collapsed ? '展开配置目录' : '收起配置目录'} aria-label={collapsed ? '展开配置目录' : '收起配置目录'} onClick={() => setCollapsed(value => !value)}>{collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button></div>{['AI 能力', '资源与集成', '安全与治理'].map(group => <div className="settings-group" key={group}><p>{group}</p>{items.map((item, index) => item.group === group && <button key={item.name} className={selected === index ? 'active' : ''} onClick={() => setSelected(index)}><item.icon /><span><b>{item.name}</b><small>{item.desc}</small></span><ChevronRight /></button>)}</div>)}</aside>
    <section className="card settings-editor"><div className="settings-editor-head"><div className="setting-symbol"><CurrentIcon /></div><div><h2>{current.name}</h2><p>{current.desc}{selected === 2 && configVersion ? ` · 配置 V${configVersion}` : ''}</p></div><Badge tone={dirty ? 'orange' : requiresRebuild && selected === 2 ? 'orange' : 'green'}>{dirty ? '有未保存更改' : requiresRebuild && selected === 2 ? '待重建' : '已保存'}</Badge><button className="btn primary" disabled={!dirty} onClick={() => void save()}><Check />保存配置</button></div><div className="settings-editor-scroll" ref={editorScrollRef}>
      {selected === 0 && <ModelManagementSettings draft={draft} update={update} notify={notify} onHealthUpdated={source => {
        const mergeHealth = (sources: GenerativeSourceDraft[]) => sources.map(item => item.id !== source.id ? item : { ...item, health: source.health, models: item.models.map(model => {
          const checked = source.models.find(candidate => candidate.id === model.id)
          return checked ? { ...model, health: checked.health } : model
        }) })
        setDraft(current => ({ ...current, generativeSources: mergeHealth(current.generativeSources) }))
        setSaved(current => ({ ...current, generativeSources: mergeHealth(current.generativeSources) }))
      }} />}
      {selected === 1 && <PromptAgentSettings draft={draft} update={update} notify={notify} />}
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

type GenerativeSourceEditor = { id?: string; name: string; providerType: GenerativeSourceDraft['providerType']; baseUrl: string; apiKey: string; models: GenerativeModelDraft[] }

type GenerativeSourceEditorErrors = { source?: string; modelList?: string; models?: Record<string, string> }

const createGenerativeModel = (): GenerativeModelDraft => ({ id: crypto.randomUUID(), name: '', displayName: '', contextWindow: 128000, maxOutputTokens: 8192, capabilities: ['structured_output', 'tool_calling'], enabled: true, health: 'unknown' })

const repairGenerativeRouting = (nextSources: GenerativeSourceDraft[], removedModelIds: ReadonlySet<string>, draft: Pick<SettingsDraft, 'mainModel' | 'fallbackModelIds'>) => {
  const models = nextSources.flatMap(source => source.models.map(model => ({ ...model, source })))
  const availableIds = new Set(models.map(model => model.id))
  const mainModel = removedModelIds.has(draft.mainModel) || !availableIds.has(draft.mainModel) ? models.find(model => model.source.enabled && model.enabled)?.id ?? '' : draft.mainModel
  const fallbackModelIds = [...new Set(draft.fallbackModelIds)].filter(id => availableIds.has(id) && !removedModelIds.has(id) && id !== mainModel)
  return { mainModel, fallbackModelIds }
}

function ModelManagementSettings({ draft, update, notify, onHealthUpdated }: { draft: SettingsDraft; update: <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => void; notify: Notify; onHealthUpdated: (source: GenerativeSourceDraft) => void }) {
  const [sourceEditor, setSourceEditor] = useState<GenerativeSourceEditor | null>(null)
  const [sourceEditorErrors, setSourceEditorErrors] = useState<GenerativeSourceEditorErrors>({})
  const [testingModelId, setTestingModelId] = useState('')
  const sources = draft.generativeSources
  const providerLabel = (type: GenerativeSourceDraft['providerType']) => type === 'openai' ? 'OpenAI' : type === 'anthropic' ? 'Anthropic' : 'OpenAI Compatible'
  const setSources = (next: GenerativeSourceDraft[]) => update('generativeSources', next)
  const updateSource = (id: string, patch: Partial<GenerativeSourceDraft>) => setSources(sources.map(source => source.id === id ? { ...source, ...patch } : source))
  const deleteSource = (source: GenerativeSourceDraft) => {
    if (!window.confirm(`移除模型来源“${source.name}”？点击页面“保存配置”后将从服务端删除。`)) return
    const removedIds = new Set(source.models.map(model => model.id)); const remaining = sources.filter(item => item.id !== source.id)
    const routing = repairGenerativeRouting(remaining, removedIds, draft)
    setSources(remaining); update('mainModel', routing.mainModel); update('fallbackModelIds', routing.fallbackModelIds)
  }
  const openSourceEditor = (source?: GenerativeSourceDraft) => {
    setSourceEditorErrors({})
    setSourceEditor(source ? { id: source.id, name: source.name, providerType: source.providerType, baseUrl: source.baseUrl, apiKey: '', models: source.models.map(model => ({ ...model, capabilities: [...model.capabilities] })) } : { name: '', providerType: 'openai_compatible', baseUrl: '', apiKey: '', models: [] })
  }
  const updateEditorModel = (id: string, patch: Partial<GenerativeModelDraft>) => setSourceEditor(current => current && { ...current, models: current.models.map(model => model.id === id ? { ...model, ...patch } : model) })
  const addEditorModel = () => { setSourceEditorErrors(current => ({ ...current, modelList: undefined })); setSourceEditor(current => current && { ...current, models: [...current.models, createGenerativeModel()] }) }
  const discoverModels = async () => {
    if (!sourceEditor) return
    try {
      const discovered = await discoverGenerativeModels(sourceEditor)
      if (discovered.length) setSourceEditorErrors(errors => ({ ...errors, modelList: undefined }))
      setSourceEditor(current => {
        if (!current) return current
        const knownNames = new Set(current.models.map(model => model.name.trim().toLocaleLowerCase()))
        const additions = discovered.filter(model => !knownNames.has(model.name.toLocaleLowerCase())).map(model => ({ ...createGenerativeModel(), ...model }))
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
  const saveSource = () => {
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
    const routing = repairGenerativeRouting(nextSources, removedIds, draft)
    setSources(nextSources); update('mainModel', routing.mainModel); update('fallbackModelIds', routing.fallbackModelIds)
    setSourceEditor(null); setSourceEditorErrors({}); notify(existing ? '修改已加入草稿，请点击“保存配置”持久化。' : '来源已加入草稿，请点击“保存配置”持久化。', 'warning')
  }
  return <div className="model-config-page">
    <div className="model-config-panel"><ModelPanelHead title="模型来源" desc="统一维护可供各 Agent 使用的生成式模型渠道；连接信息由服务端保存。"><button className="btn primary" onClick={() => openSourceEditor()}><Plus />添加来源</button></ModelPanelHead><div className="generative-source-grid">{sources.map(source => <article className={`generative-source-card ${source.enabled ? '' : 'disabled'}`} key={source.id} aria-label={`${source.name} 模型来源`}><header><div className="source-logo"><Server /></div><div><b>{source.name}</b><small>{providerLabel(source.providerType)}</small></div><Badge tone={source.enabled ? modelHealthTone(source.health) : 'gray'}>{source.enabled ? modelHealthLabel(source.health) : '已停用'}</Badge><label className="switch"><input type="checkbox" checked={source.enabled} onChange={event => updateSource(source.id, { enabled: event.target.checked })} aria-label={`启用 ${source.name}`} /><i /></label></header><div className="source-reference"><span>Base URL<b>{source.baseUrl}</b></span></div><div className="source-model-chips">{source.models.map(model => <button type="button" key={model.id} disabled={!source.enabled || !model.enabled || testingModelId === model.id} onClick={() => testModelConnection(source, model)} title={`测试 ${model.displayName} 连通性`} aria-label={`测试 ${model.displayName} 连通性`}><i className={model.health} aria-hidden="true" /><span>{testingModelId === model.id ? '测试中…' : model.displayName}</span></button>)}</div><footer><span>{source.models.length} 个模型</span><div><button className="icon-btn" onClick={() => openSourceEditor(source)} title={`编辑来源 ${source.name}`} aria-label={`编辑来源 ${source.name}`}><Pencil /></button><button className="icon-btn danger-text" onClick={() => deleteSource(source)} title={`移除来源 ${source.name}`} aria-label={`移除来源 ${source.name}`}><Trash2 /></button></div></footer></article>)}</div></div>
    {sources.length === 0 && <div className="model-source-empty"><Server /><b>尚未配置生成式模型来源</b><span>填写 Base URL、API Key 和模型后保存，即可进行真实发现与连通性探测。</span></div>}
    {sourceEditor && <Modal title={sourceEditor.id ? '编辑生成式模型来源' : '添加生成式模型来源'} className="model-source-modal" onClose={() => { setSourceEditor(null); setSourceEditorErrors({}) }}><div className="modal-form"><div className="model-source-modal-content"><p>Base URL 和 API Key 由服务端保存；读取配置时不会回显 API Key。</p><label>来源名称<input value={sourceEditor.name} onChange={event => setSourceEditor(current => current && { ...current, name: event.target.value })} placeholder="例如：OpenAI 灾备渠道" /></label><label>协议类型<select value={sourceEditor.providerType} onChange={event => setSourceEditor(current => current && { ...current, providerType: event.target.value as GenerativeSourceDraft['providerType'] })}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="openai_compatible">OpenAI Compatible</option></select></label><label>Base URL<input value={sourceEditor.baseUrl} onChange={event => setSourceEditor(current => current && { ...current, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label><label>API Key（可选）<input type="password" value={sourceEditor.apiKey} onChange={event => setSourceEditor(current => current && { ...current, apiKey: event.target.value })} placeholder={sourceEditor.id ? '留空保留已保存的 API Key' : '无需鉴权时可留空'} /></label>{sourceEditorErrors.source && <span className="field-error">{sourceEditorErrors.source}</span>}<section className="generative-model-editor"><header><div><b>模型配置</b><small>可获取当前配置模型，也可手动填写并维护模型。</small></div><div className="generative-model-editor-actions"><button type="button" className="btn ghost" onClick={discoverModels}><RefreshCw />获取当前配置模型</button><button type="button" className="btn ghost" onClick={addEditorModel}><Plus />手动添加模型</button></div></header>{sourceEditorErrors.modelList && <span className="field-error">{sourceEditorErrors.modelList}</span>}<div>{sourceEditor.models.map((model, index) => <article key={model.id}><header><div><b>模型 {index + 1}</b>{model.id === draft.mainModel && <Badge tone="green">默认模型</Badge>}{draft.fallbackModelIds.includes(model.id) && <Badge tone="purple">回退模型</Badge>}</div><button type="button" className="icon-btn danger-text" title={`移除模型 ${model.displayName || model.name || index + 1}`} aria-label={`移除模型 ${model.displayName || model.name || index + 1}`} onClick={() => removeEditorModel(model.id)}><Trash2 /></button></header><div className="generative-model-fields"><label>模型标识<input value={model.name} onChange={event => updateEditorModel(model.id, { name: event.target.value })} placeholder="gpt-5.1-mini" /></label><label>展示名称<input value={model.displayName} onChange={event => updateEditorModel(model.id, { displayName: event.target.value })} placeholder="GPT-5.1 Mini" /></label></div><div className="generative-model-options"><span>能力</span>{(['structured_output', 'tool_calling', 'vision'] as const).map(capability => <label key={capability}><input type="checkbox" checked={model.capabilities.includes(capability)} onChange={event => updateEditorModel(model.id, { capabilities: event.target.checked ? [...model.capabilities, capability] : model.capabilities.filter(item => item !== capability) })} />{capability === 'structured_output' ? '结构化输出' : capability === 'tool_calling' ? '工具调用' : '视觉'}</label>)}<label className="model-enabled"><input type="checkbox" checked={model.enabled} onChange={event => updateEditorModel(model.id, { enabled: event.target.checked })} />启用模型</label></div>{sourceEditorErrors.models?.[model.id] && <span className="field-error">{sourceEditorErrors.models[model.id]}</span>}</article>)}</div></section></div><div className="modal-actions"><button className="btn ghost" onClick={() => { setSourceEditor(null); setSourceEditorErrors({}) }}>取消</button><button className="btn primary" onClick={saveSource}>{sourceEditor.id ? <Check /> : <Plus />}{sourceEditor.id ? '保存修改' : '加入草稿'}</button></div></div></Modal>}
  </div>
}

const modelHealthLabel = (health: GenerativeSourceDraft['health']) => health === 'healthy' ? '健康' : health === 'degraded' ? '降级' : '待探测'
const modelHealthTone = (health: GenerativeSourceDraft['health']) => health === 'healthy' ? 'green' : health === 'degraded' ? 'orange' : 'gray'

function PromptAgentSettings({ draft, update, notify }: { draft: SettingsDraft; update: <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => void; notify: Notify }) {
  const [tab, setTab] = useState<'model' | 'prompt' | 'tools' | 'versions'>('model')
  const allModels = draft.generativeSources.flatMap(source => source.models.map(model => ({ ...model, source })))
  const availableModels = allModels.filter(model => model.source.enabled && model.enabled)
  const defaultModel = allModels.find(model => model.id === draft.mainModel)
  const moveFallback = (index: number, offset: number) => {
    const target = index + offset
    if (target < 0 || target >= draft.fallbackModelIds.length) return
    const next = [...draft.fallbackModelIds]; [next[index], next[target]] = [next[target], next[index]]; update('fallbackModelIds', next)
  }
  const addFallback = () => {
    const model = availableModels.find(item => item.id !== draft.mainModel && !draft.fallbackModelIds.includes(item.id))
    if (model) update('fallbackModelIds', [...draft.fallbackModelIds, model.id])
  }
  return <div className="agent-settings-page">
    <section className="agent-config-header"><div className="agent-symbol"><BrainCircuit /></div><div><span>业务 Agent</span><h3>RequirementAnalysisAgent</h3><p>需求评审 · 单 Agent 执行 · 配置草稿 V5</p></div><Badge tone="green">已启用</Badge></section>
    <nav className="agent-config-tabs"><button className={tab === 'model' ? 'active' : ''} onClick={() => setTab('model')}><Bot />模型与路由</button><button className={tab === 'prompt' ? 'active' : ''} onClick={() => setTab('prompt')}><FileText />Prompt</button><button className={tab === 'tools' ? 'active' : ''} onClick={() => setTab('tools')}><ShieldCheck />工具与权限</button><button className={tab === 'versions' ? 'active' : ''} onClick={() => setTab('versions')}><Clock3 />版本记录</button></nav>
    {tab === 'model' && <div className="model-routing-grid"><section className="model-config-panel"><ModelPanelHead title="需求评审模型参数" desc="从通用模型库选择模型，参数随 Agent 配置版本固定。"><Badge tone="purple">requirement_analysis</Badge></ModelPanelHead><div className="routing-form"><FormRow label="默认模型" help="智能路由关闭时固定使用该模型"><select value={draft.mainModel} onChange={event => update('mainModel', event.target.value)}>{availableModels.map(model => <option value={model.id} key={model.id}>{model.displayName} · {model.source.name}</option>)}</select></FormRow><FormRow label="模型温度" help="数值越低，评审结论越稳定"><div className="range-field"><input type="range" min="0" max="10" value={Math.round(draft.temperature * 10)} onChange={event => update('temperature', Number(event.target.value) / 10)} /><b>{draft.temperature.toFixed(1)}</b></div></FormRow><FormRow label="最大输出 Token" help={`不得超过 ${defaultModel?.displayName ?? '默认模型'} 的能力上限`}><div className="input-unit"><input type="number" min="1024" step="1024" value={draft.maxOutputTokens} onChange={event => update('maxOutputTokens', Number(event.target.value))} /><span>tokens</span></div></FormRow><FormRow label="请求超时" help="单次模型请求的服务端超时"><div className="input-unit"><input type="number" min="10" value={draft.requestTimeoutSeconds} onChange={event => update('requestTimeoutSeconds', Number(event.target.value))} /><span>秒</span></div></FormRow><FormRow label="失败重试" help="仅对限流、超时等错误生效"><select value={draft.retryCount} onChange={event => update('retryCount', Number(event.target.value))}><option value={0}>不重试</option><option value={1}>1 次</option><option value={2}>2 次</option><option value={3}>3 次</option></select></FormRow><SwitchRow title="强制结构化输出" desc="提交结果必须通过服务端 Schema 校验" checked={draft.structuredOutput} onChange={value => update('structuredOutput', value)} /></div></section><section className="model-config-panel route-policy-panel"><ModelPanelHead title="路由与降级" desc="仅作用于 RequirementAnalysisAgent。" /><SwitchRow title="启用智能模型路由" desc="按能力、上下文、启用和健康状态选择模型" checked={draft.intelligentRouting} onChange={value => update('intelligentRouting', value)} /><SwitchRow title="允许模型降级" desc="默认模型不可用时按顺序尝试备用模型" checked={draft.fallbackEnabled} onChange={value => update('fallbackEnabled', value)} /><div className={`fallback-route ${draft.fallbackEnabled ? '' : 'disabled'}`}><div className="fallback-primary"><span>主</span><div><b>{defaultModel?.displayName ?? '未选择默认模型'}</b><small>{defaultModel?.source.name ?? '请先在模型管理中启用模型'}</small></div><Badge tone="green">默认</Badge></div>{draft.fallbackModelIds.map((modelId, index) => { const model = allModels.find(item => item.id === modelId); return model && <div className="fallback-item" key={modelId}><span>{index + 1}</span><div><b>{model.displayName}</b><small>{model.source.name}</small></div><div><button className="icon-btn" disabled={index === 0} onClick={() => moveFallback(index, -1)}><ArrowUp /></button><button className="icon-btn" disabled={index === draft.fallbackModelIds.length - 1} onClick={() => moveFallback(index, 1)}><ArrowDown /></button><button className="icon-btn danger-text" onClick={() => update('fallbackModelIds', draft.fallbackModelIds.filter(id => id !== modelId))}><Trash2 /></button></div></div>})}<button className="add-fallback" disabled={!draft.fallbackEnabled || !availableModels.some(model => model.id !== draft.mainModel && !draft.fallbackModelIds.includes(model.id))} onClick={addFallback}><Plus />添加回退模型</button></div><div className="route-note"><ShieldCheck /><span><b>Agent 级配置</b><small>模型来源仍由通用模型库管理，此处只保存选择和路由策略。</small></span></div></section></div>}
    {tab === 'prompt' && <div className="model-config-panel agent-static-panel"><ModelPanelHead title="需求评审 Prompt" desc="系统指令与输出模板按版本绑定到当前 Agent。"><Badge tone="green">Prompt V7</Badge></ModelPanelHead><div className="agent-static-grid"><article><span>系统指令</span><b>需求评审分析器</b><p>识别需求缺口、歧义、冲突、边界和测试风险，每项结论必须关联证据。</p></article><article><span>输出 Schema</span><b>review_finding.v3</b><p>结构化输出 Finding、证据快照、置信度、风险等级和待确认状态。</p></article></div><p className="readonly-notice">当前为前端结构示例，不会发布或覆盖正式 Prompt。</p></div>}
    {tab === 'tools' && <div className="model-config-panel agent-static-panel"><ModelPanelHead title="工具与权限" desc="工具授权随 Agent 定义版本固定，通用模型不能绕过权限。"><Badge tone="purple">工具集 V4</Badge></ModelPanelHead><div className="agent-static-grid"><article><span>知识库工具</span><b>search_knowledge · read_evidence</b><p>只读访问当前评审固定的知识资产版本和索引快照。</p></article><article><span>结果提交</span><b>submit_review_result</b><p>仅提交候选结果，由 SmartHub 独立校验后正式保存。</p></article></div></div>}
    {tab === 'versions' && <div className="model-config-panel"><ModelPanelHead title="Agent 配置版本" desc="模型选择、Prompt、工具与权限共同形成不可变版本。"><button className="btn ghost" onClick={() => notify('当前仅展示 Agent 版本前端原型。', 'warning')}><RefreshCw />刷新</button></ModelPanelHead><div className="model-version-list">{[{ version: 'V5', status: '当前生效', model: 'GPT-5.2', author: '李磊', time: '2026-07-22 16:40' }, { version: 'V4', status: '已停用', model: 'Claude Sonnet 4.5', author: '李磊', time: '2026-07-18 11:26' }, { version: 'V3', status: '已停用', model: 'SmartHub Review 72B', author: '系统管理员', time: '2026-07-12 09:15' }].map((item, index) => <div key={item.version}><span className="version-node"><i /></span><div><b>{item.version} · RequirementAnalysisAgent</b><small>{item.time} · {item.author}</small></div><span><b>{item.model}</b><small>默认模型</small></span><Badge tone={index === 0 ? 'green' : 'gray'}>{item.status}</Badge><button className="btn ghost" onClick={() => notify(`${item.version} 为前端版本快照示例。`, 'warning')}>查看快照</button></div>)}</div></div>}
  </div>
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
  }, [knowledgeBaseId, rebuildTaskId, rebuildPollVersion, onRebuilt, notify])

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
