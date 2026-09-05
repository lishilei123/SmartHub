import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  LayoutDashboard,
  Library,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Settings,
  Sparkles,
  XCircle,
  Zap,
} from 'lucide-react'
import { type KnowledgeDirectory, type KnowledgeDocument } from './prototype-data'
import { ensureKnowledgeBase, loadKnowledgeAssets, loadKnowledgeDocument } from './knowledge-api'
import { loadProjectVersions, type ProjectVersion } from './project-version-api'
import { buildWorkspaceKnowledgeTree } from './workspace-knowledge-tree'
import './planning.css'
import './workbench-layout.css'
import { type PageKey, type PlanningTab, type NotifyTone, type Notify } from './app/types'
import { Dashboard } from './app/Dashboard'
import { PageLoading, Modal } from './app/shared'
import { Documents } from './app/Documents'
import { SystemSettings } from './app/SystemSettings'
import { ProjectVersionManager } from './app/ProjectVersionManager'

const PlanningPage = lazy(() => import('./PlanningPage').then(module => ({ default: module.PlanningPage })))

const TestCasesPage = lazy(() =>
  import('./test-cases/TestCasesPage').then(module => ({ default: module.TestCasesPage })),
)

const TestExecutionPage = lazy(() =>
  import('./test-execution/TestExecutionPage').then(module => ({ default: module.TestExecutionPage })),
)

const TestReportPage = lazy(() =>
  import('./test-report/TestReportPage').then(module => ({ default: module.TestReportPage })),
)

const projectVersionStorageKey = 'smarthub-project-version-id'

const pageKeys: PageKey[] = ['dashboard', 'planning', 'test-cases', 'documents', 'execution', 'reports', 'settings']

const routedPage = (value: string | null): PageKey =>
  value === 'requirement-analysis' || value === 'test-design'
    ? 'planning'
    : pageKeys.includes(value as PageKey)
      ? (value as PageKey)
      : 'dashboard'

const legacyPlanningTab = (value: string | null): PlanningTab | undefined =>
  value === 'requirement-analysis' ? 'requirements' : value === 'test-design' ? 'test-design' : undefined

const restorePage = (): PageKey => {
  if (typeof window === 'undefined') return 'dashboard'
  return routedPage(new URL(window.location.href).searchParams.get('page'))
}

const restoreProjectVersion = () => {
  if (typeof window === 'undefined') return ''
  return (
    new URL(window.location.href).searchParams.get('projectVersionId') ??
    window.localStorage.getItem(projectVersionStorageKey) ??
    ''
  )
}

const menu: { key: PageKey; label: string; icon: typeof LayoutDashboard; hint?: string }[] = [
  { key: 'dashboard', label: '工作台', icon: LayoutDashboard },
  { key: 'planning', label: '测试策划', icon: Sparkles },
  { key: 'test-cases', label: '测试用例', icon: ListChecks },
  { key: 'execution', label: '测试执行', icon: Play },
  { key: 'reports', label: '报告与诊断', icon: Activity },
]

const pageMeta: Record<PageKey, { title: string; desc: string }> = {
  dashboard: { title: '工作台', desc: '掌握项目质量状态与 AI 任务进展' },
  planning: { title: '测试策划', desc: '分析需求、确认问题、审核并发布测试用例' },
  'test-cases': { title: '测试用例', desc: '查看当前项目版本已审核通过及继承复用的正式测试用例' },
  documents: { title: '知识库', desc: '管理项目文档、技术方案与知识资产' },
  execution: { title: '测试执行', desc: '执行正式测试用例，查看运行进度与结果' },
  reports: { title: '报告与诊断', desc: '查看执行报告、分析失败原因并追溯测试证据' },
  settings: { title: '系统管理', desc: '配置模型、集成、权限与平台策略' },
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
    toastTimer.current = window.setTimeout(() => setToast(current => (current?.id === next.id ? null : current)), 2600)
  }, [])

  useEffect(
    () => () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
    },
    [],
  )
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }, [page, selectedProjectVersionId])
  const updateRoute = useCallback(
    (
      next: { page?: PageKey; projectVersionId?: string; planningTab?: PlanningTab; resetAnalysisContext?: boolean },
      mode: 'push' | 'replace' = 'push',
    ) => {
      const url = new URL(window.location.href)
      if (next.page) url.searchParams.set('page', next.page)
      if (next.projectVersionId) url.searchParams.set('projectVersionId', next.projectVersionId)
      else if (next.projectVersionId === '') url.searchParams.delete('projectVersionId')
      if (next.resetAnalysisContext)
        [
          'analysisId',
          'runId',
          'view',
          'findingId',
          'evidenceId',
          'testDesignId',
          'workflowRunId',
          'executionRunId',
          'executionTaskId',
          'executionMaintenanceProposalId',
          'testDesignEntry',
          'libraryCaseId',
          'testCaseId',
          'reportRunId',
          'tab',
          'assetView',
          'planningTab',
        ].forEach(key => url.searchParams.delete(key))
      if (next.planningTab) url.searchParams.set('planningTab', next.planningTab)
      window.history[mode === 'push' ? 'pushState' : 'replaceState']({}, '', url)
    },
    [],
  )
  const navigate = useCallback(
    (nextPage: PageKey, planningTab?: PlanningTab) => {
      const pageChanged = nextPage !== page
      setPage(nextPage)
      updateRoute({
        page: nextPage,
        ...(pageChanged ? { resetAnalysisContext: true } : {}),
        ...(planningTab ? { planningTab } : {}),
      })
    },
    [page, updateRoute],
  )
  const selectProjectVersion = useCallback(
    (id: string) => {
      setSelectedProjectVersionId(id)
      updateRoute({ projectVersionId: id, resetAnalysisContext: true })
    },
    [updateRoute],
  )
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
  const workspaceKnowledgeTree = useMemo(
    () =>
      buildWorkspaceKnowledgeTree({
        directories: knowledgeDirectoryList,
        documents: knowledgeDocumentList,
        versionNames: projectVersions.map(version => version.name),
      }),
    [knowledgeDirectoryList, knowledgeDocumentList, projectVersions],
  )
  const refreshProjectVersions = useCallback(async () => {
    const versions = await loadProjectVersions()
    setProjectVersions(versions)
    setSelectedProjectVersionId(current =>
      versions.some(item => item.id === current) ? current : (versions[0]?.id ?? ''),
    )
    return versions
  }, [])
  const refreshKnowledge = useCallback(
    async (includeDeleted = false, id = knowledgeBaseId) => {
      if (!id) return
      const data = await loadKnowledgeAssets(id, includeDeleted)
      setKnowledgeDirectoryList(data.directories)
      setKnowledgeDocumentList(current => {
        const hydrated = new Map(
          current
            .filter(document => document.content !== undefined)
            .map(document => [`${document.id}:${document.assetVersionId}`, document]),
        )
        return data.documents.map(document => {
          const cached = hydrated.get(`${document.id}:${document.assetVersionId}`)
          return cached
            ? {
                ...document,
                content: cached.content,
                title: cached.title,
                intro: cached.intro,
                sections: cached.sections,
              }
            : document
        })
      })
      setKnowledgeApiState('ready')
    },
    [knowledgeBaseId],
  )
  const hydrateDocument = useCallback(async (document: KnowledgeDocument) => {
    const loaded = await loadKnowledgeDocument(document)
    setKnowledgeDocumentList(current =>
      current.map(item => (item.id === loaded.id && item.assetVersionId === loaded.assetVersionId ? loaded : item)),
    )
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
        await Promise.all([refreshKnowledge(false, id), refreshProjectVersions()])
      } catch {
        if (cancelled) return
        setKnowledgeApiState('offline')
        retryTimer = window.setTimeout(() => void connect(), 2000)
      }
    }
    void connect()
    return () => {
      cancelled = true
      if (retryTimer) window.clearTimeout(retryTimer)
    }
  }, [])
  useEffect(() => {
    if (selectedProjectVersionId) window.localStorage.setItem(projectVersionStorageKey, selectedProjectVersionId)
    else window.localStorage.removeItem(projectVersionStorageKey)
  }, [selectedProjectVersionId])
  const meta = pageMeta[page]

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'shell-collapsed' : ''}`}>
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="brand">
          <div className="brand-mark">
            <Zap size={19} fill="currentColor" />
          </div>
          <div>
            <b>SmartHub</b>
            <span>AI TESTING PLATFORM</span>
          </div>
          <button
            className="sidebar-toggle"
            title={sidebarCollapsed ? '展开导航' : '收起导航'}
            aria-label={sidebarCollapsed ? '展开导航' : '收起导航'}
            onClick={() => setSidebarCollapsed(value => !value)}
          >
            {sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </button>
        </div>
        <button className="project-picker" onClick={() => setVersionManagerOpen(true)} aria-label="切换当前版本">
          <span className="project-logo">V</span>
          <span>
            <small>{activeProjectVersion ? '当前版本' : '尚未创建版本'}</small>
            <strong>{activeProjectVersion ? `SmartHub · ${activeProjectVersion.name}` : '新建版本后开始工作'}</strong>
          </span>
          <ChevronDown size={15} />
        </button>
        <nav>
          <p className="nav-label nav-scope">
            <span>项目空间</span>
            <em>按版本隔离</em>
          </p>
          {menu.map(item => (
            <button key={item.key} className={page === item.key ? 'active' : ''} onClick={() => navigate(item.key)}>
              <item.icon size={18} />
              <span>{item.label}</span>
              {item.hint && <em>{item.hint}</em>}
            </button>
          ))}
          <p className="nav-label second nav-scope">
            <span>平台管理</span>
            <em>全局</em>
          </p>
          <button className={page === 'documents' ? 'active' : ''} onClick={() => navigate('documents')}>
            <Library size={18} />
            <span>知识库</span>
          </button>
          <button className={page === 'settings' ? 'active' : ''} onClick={() => navigate('settings')}>
            <Settings size={18} />
            <span>系统管理</span>
          </button>
        </nav>
        <button
          className="sidebar-account"
          onClick={() => notify('当前账号：李世磊 · 测试负责人')}
          aria-label="查看当前账号"
        >
          <span className="avatar">LS</span>
          <span className="sidebar-account-info">
            <b>李磊</b>
            <small>测试负责人</small>
          </span>
          <ChevronRight />
        </button>
      </aside>
      <main>
        <section
          className={`content ${page === 'planning' ? 'planning-content' : ''} ${page === 'test-cases' ? 'test-cases-content' : ''} ${page === 'execution' ? 'execution-content' : ''} ${page === 'reports' ? 'reports-content' : ''} ${page === 'documents' ? 'documents-content' : ''} ${page === 'settings' ? 'settings-content' : ''}`}
        >
          <div className="page-head">
            <div>
              <h1>{meta.title}</h1>
              <p>{meta.desc}</p>
            </div>
          </div>
          {page === 'dashboard' && (
            <Dashboard
              navigate={navigate}
              projectVersion={activeProjectVersion}
              onManageVersions={() => setVersionManagerOpen(true)}
            />
          )}
          {page === 'planning' && (
            <Suspense fallback={<PageLoading label="正在加载测试策划工作台…" />}>
              <PlanningPage
                key={activeProjectVersion?.id ?? 'no-version'}
                projectVersion={activeProjectVersion}
                documents={knowledgeDocumentList}
                knowledgeBaseId={knowledgeBaseId}
                apiState={knowledgeApiState}
                refreshKnowledge={() => refreshKnowledge()}
                refreshProjectVersions={refreshProjectVersions}
                onManageVersions={() => setVersionManagerOpen(true)}
                onOpenKnowledge={() => navigate('documents')}
                onOpenActivity={() => setActivityOpen(true)}
                notify={notify}
                addAudit={entry => setAudit(current => [entry, ...current])}
              />
            </Suspense>
          )}
          {page === 'test-cases' && (
            <Suspense fallback={<PageLoading label="正在加载正式测试用例…" />}>
              <TestCasesPage
                key={activeProjectVersion?.id ?? 'no-version'}
                projectVersion={activeProjectVersion}
                onManageVersions={() => setVersionManagerOpen(true)}
                notify={notify}
              />
            </Suspense>
          )}
          {page === 'documents' && (
            <Documents
              knowledgeBaseId={knowledgeBaseId}
              apiState={knowledgeApiState}
              refreshKnowledge={refreshKnowledge}
              loadDocument={hydrateDocument}
              directories={workspaceKnowledgeTree.directories}
              documents={workspaceKnowledgeTree.documents}
              workspaceRootDirectoryId={workspaceKnowledgeTree.rootDirectoryId}
              notify={notify}
              addAudit={entry => setAudit(current => [entry, ...current])}
            />
          )}
          {page === 'execution' && (
            <Suspense fallback={<PageLoading label="正在加载测试执行工作台…" />}>
              <TestExecutionPage
                key={activeProjectVersion?.id ?? 'no-version'}
                projectVersion={activeProjectVersion}
                onManageVersions={() => setVersionManagerOpen(true)}
                notify={notify}
              />
            </Suspense>
          )}
          {page === 'reports' && (
            <Suspense fallback={<PageLoading label="正在加载报告与诊断工作台…" />}>
              <TestReportPage
                key={activeProjectVersion?.id ?? 'no-version'}
                projectVersion={activeProjectVersion}
                onManageVersions={() => setVersionManagerOpen(true)}
                notify={notify}
              />
            </Suspense>
          )}
          {page === 'settings' && (
            <SystemSettings
              knowledgeBaseId={knowledgeBaseId}
              notify={notify}
              addAudit={entry => setAudit(current => [entry, ...current])}
            />
          )}
        </section>
      </main>
      {toast && (
        <div className={`toast ${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
          {toast.tone === 'error' ? (
            <XCircle size={18} />
          ) : toast.tone === 'warning' ? (
            <AlertTriangle size={18} />
          ) : (
            <CheckCircle2 size={18} />
          )}
          {toast.message}
        </div>
      )}
      {activityOpen && (
        <Modal title="本次会话操作记录" onClose={() => setActivityOpen(false)}>
          <div className="activity-modal">
            <p>记录只保留在当前浏览器会话中。</p>
            {audit.map((entry, index) => (
              <div key={`${entry}-${index}`}>
                <Clock3 size={15} />
                <span>{entry}</span>
              </div>
            ))}
          </div>
        </Modal>
      )}
      {versionManagerOpen && (
        <ProjectVersionManager
          versions={projectVersions}
          selectedId={selectedProjectVersionId}
          onSelect={id => {
            selectProjectVersion(id)
            setVersionManagerOpen(false)
          }}
          onRefresh={refreshProjectVersions}
          onClose={() => setVersionManagerOpen(false)}
          notify={notify}
        />
      )}
    </div>
  )
}
export default App
