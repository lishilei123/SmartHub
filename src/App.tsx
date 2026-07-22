import { forwardRef, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import {
  Activity, AlertTriangle, BookOpen, Bot, BrainCircuit, Check, CheckCircle2, ChevronDown,
  ChevronRight, CircleHelp, Clock3, Code2, Columns2, Database, Download, FileCode2, FileText,
  FolderOpen, FolderPlus, GitBranch, LayoutDashboard, Library, ListChecks, MessageSquareText, MoreHorizontal,
  PanelLeftClose, PanelLeftOpen, Pencil, Play, Plus, RefreshCw, Search, Settings, ShieldCheck, Sparkles,
  TestTube2, Trash2, Upload, Users, XCircle, Zap,
} from 'lucide-react'
import {
  initialSettings, requirementsByVersion, type KnowledgeDirectory, type KnowledgeDocument, type Requirement,
  type EmbeddingSourceDraft, type SettingsDraft, type Version,
} from './prototype-data'
import { cancelTask, createKnowledgeDirectory, deleteKnowledgeAsset, deleteKnowledgeDirectory, ensureKnowledgeBase, loadConfig, loadKnowledgeAssets, loadKnowledgeOverview, loadLocalModelStatuses, loadTasks, rebuildIndex, renameKnowledgeDirectory, retryTask, saveConfig, searchKnowledge, startLocalModel, stopLocalModel, testEmbeddingConfig, updateKnowledgeAsset, uploadKnowledgeArchive, uploadKnowledgeFile, type ApiIndexSummary, type ApiSearchMeta, type ApiSearchResult, type LocalModelStatus } from './knowledge-api'
import { MarkdownDocument } from './MarkdownDocument'
import { getActiveDocumentSectionKey, getClosestSourceLineIndex } from './document-scroll'
import { emptyMarkdownOutline, parseMarkdownOutline, type MarkdownOutline } from './markdown-outline'

type PageKey = 'dashboard' | 'requirements' | 'documents' | 'design' | 'execution' | 'reports' | 'settings'
type NotifyTone = 'success' | 'error' | 'warning'
type Notify = (message: string, tone?: NotifyTone) => void
type JobStatus = 'idle' | 'running' | 'completed' | 'cancelled' | 'failed'
type SearchLocation = { assetId: string; startLine: number; endLine: number; nonce: number }
const retrievalModeLabel = (mode: string) => mode === 'hybrid' ? '混合检索' : mode === 'vector' ? '向量检索' : '关键词检索'

const pageStorageKey = 'smarthub-current-page'
const pageKeys: PageKey[] = ['dashboard', 'requirements', 'documents', 'design', 'execution', 'reports', 'settings']
const restorePage = (): PageKey => {
  if (typeof window === 'undefined') return 'dashboard'
  const saved = window.localStorage.getItem(pageStorageKey)
  return pageKeys.includes(saved as PageKey) ? saved as PageKey : 'dashboard'
}

const menu: { key: PageKey; label: string; icon: typeof LayoutDashboard; hint?: string }[] = [
  { key: 'dashboard', label: '工作台', icon: LayoutDashboard },
  { key: 'requirements', label: '需求分析', icon: BrainCircuit, hint: '3' },
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
  const [version, setVersion] = useState<Version>('V3.6')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [toast, setToast] = useState<{ id: number; message: string; tone: NotifyTone } | null>(null)
  const [requirementLists, setRequirementLists] = useState<Record<Version, Requirement[]>>(requirementsByVersion)
  const [knowledgeDirectoryList, setKnowledgeDirectoryList] = useState<KnowledgeDirectory[]>([])
  const [knowledgeDocumentList, setKnowledgeDocumentList] = useState<KnowledgeDocument[]>([])
  const [requirementCreateOpen, setRequirementCreateOpen] = useState(false)
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
      } catch {
        if (cancelled) return
        setKnowledgeApiState('offline')
        retryTimer = window.setTimeout(() => void connect(), 2000)
      }
    }
    void connect()
    return () => { cancelled = true; if (retryTimer) window.clearTimeout(retryTimer) }
  }, [])
  const addRequirement = (title: string) => {
    const item: Requirement = {
      id: `REQ-LOCAL-${Date.now().toString().slice(-5)}`,
      title,
      version: '草稿',
      updated: '刚刚',
      author: '李磊',
      status: '待分析',
      intro: '当前会话中新建的本地需求分析草稿，刷新页面后将恢复为示例数据。',
      sections: ['需求说明', '业务规则', '验收标准'],
      findings: [],
    }
    setRequirementLists(current => ({ ...current, [version]: [item, ...current[version]] }))
    setAudit(current => [`创建本地需求分析：${title}`, ...current])
    notify('已创建本地需求分析草稿；刷新页面后不会保留。')
  }

  const meta = pageMeta[page]

  return <div className={`app-shell ${sidebarCollapsed ? 'shell-collapsed' : ''}`}>
    <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
      <div className="brand"><div className="brand-mark"><Zap size={19} fill="currentColor" /></div><div><b>SmartHub</b><span>AI TESTING PLATFORM</span></div><button className="sidebar-toggle" title={sidebarCollapsed ? '展开导航' : '收起导航'} aria-label={sidebarCollapsed ? '展开导航' : '收起导航'} onClick={() => setSidebarCollapsed(value => !value)}>{sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button></div>
      <button className="project-picker" onClick={() => setVersion(current => current === 'V3.6' ? 'V3.5' : 'V3.6')} aria-label="切换当前版本">
        <span className="project-logo">V</span><span><small>当前版本</small><strong>SmartHub · {version}</strong></span><ChevronDown size={15} />
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
      <section className={`content ${page === 'documents' ? 'documents-content' : ''} ${page === 'settings' ? 'settings-content' : ''}`}>
        <div className="page-head"><div><h1>{meta.title}</h1><p>{meta.desc}</p></div>{page === 'requirements' && <div className="head-actions"><button className="btn ghost" onClick={() => setActivityOpen(true)}><Clock3 size={16} />操作记录</button><button className="btn primary" onClick={() => setRequirementCreateOpen(true)}><Plus size={17} />新建需求分析</button></div>}</div>
        {page === 'dashboard' && <Dashboard navigate={setPage} version={version} />}
        {page === 'requirements' && <Requirements version={version} requirements={requirementLists[version]} createOpen={requirementCreateOpen} setCreateOpen={setRequirementCreateOpen} onCreate={addRequirement} notify={notify} addAudit={entry => setAudit(current => [entry, ...current])} />}
        {page === 'documents' && <Documents knowledgeBaseId={knowledgeBaseId} apiState={knowledgeApiState} refreshKnowledge={refreshKnowledge} directories={knowledgeDirectoryList} documents={knowledgeDocumentList} notify={notify} addAudit={entry => setAudit(current => [entry, ...current])} />}
        {page === 'design' && <StaticNotice title="测试设计" text="测试设计页面仍展示示例资产；本次交互修复聚焦需求分析、知识库和系统设置。" />}
        {page === 'execution' && <StaticNotice title="测试执行" text="测试执行页面仍展示示例执行数据；本次交互修复聚焦需求分析、知识库和系统设置。" />}
        {page === 'reports' && <StaticNotice title="报告与诊断" text="报告页面仍展示示例质量数据；本次交互修复聚焦需求分析、知识库和系统设置。" />}
        {page === 'settings' && <SystemSettings knowledgeBaseId={knowledgeBaseId} notify={notify} addAudit={entry => setAudit(current => [entry, ...current])} />}
      </section>
    </main>
    {toast && <div className={`toast ${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>{toast.tone === 'error' ? <XCircle size={18} /> : toast.tone === 'warning' ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}{toast.message}</div>}
    {activityOpen && <Modal title="本次会话操作记录" onClose={() => setActivityOpen(false)}><div className="activity-modal"><p>记录只保留在当前浏览器会话中。</p>{audit.map((entry, index) => <div key={`${entry}-${index}`}><Clock3 size={15} /><span>{entry}</span></div>)}</div></Modal>}
  </div>
}

function Dashboard({ navigate, version }: { navigate: (page: PageKey) => void; version: Version }) {
  return <div className="dashboard-grid"><section className="card span2 dashboard-notice"><Badge tone="violet"><Sparkles size={12} /> 当前版本 {version}</Badge><h2>本地原型交互已接通</h2><p>知识库上传、模型运行、文档解析与索引同步均连接本地 API 和 PostgreSQL；未进入一期范围的需求 AI 功能仍使用示例数据。</p><div><button className="btn primary" onClick={() => navigate('requirements')}>进入需求分析</button><button className="btn ghost" onClick={() => navigate('documents')}>查看知识库</button></div></section><section className="card quick-card"><BrainCircuit /><h3>需求分析</h3><p>搜索需求、切换分析视图并运行可取消的本地模拟任务。</p><button className="text-btn" onClick={() => navigate('requirements')}>打开需求分析 <ChevronRight /></button></section><section className="card quick-card"><Library /><h3>知识库</h3><p>真实上传、解析、保存文档并浏览固定版本证据。</p><button className="text-btn" onClick={() => navigate('documents')}>打开知识库 <ChevronRight /></button></section><section className="card quick-card"><Settings /><h3>系统设置</h3><p>配置并运行系统内置模型，管理知识库索引。</p><button className="text-btn" onClick={() => navigate('settings')}>打开系统设置 <ChevronRight /></button></section></div>
}

function StaticNotice({ title, text }: { title: string; text: string }) {
  return <section className="card static-notice"><h2>{title}</h2><p>{text}</p></section>
}

function Requirements({ version, requirements, createOpen, setCreateOpen, onCreate, notify, addAudit }: { version: Version; requirements: Requirement[]; createOpen: boolean; setCreateOpen: Dispatch<SetStateAction<boolean>>; onCreate: (title: string) => void; notify: Notify; addAudit: (entry: string) => void }) {
  const [selectedId, setSelectedId] = useState(requirements[0]?.id ?? '')
  const [query, setQuery] = useState('')
  const [directoryCollapsed, setDirectoryCollapsed] = useState(false)
  const [tab, setTab] = useState<'overview' | 'source' | 'diff' | 'tree' | 'evidence'>('overview')
  const [job, setJob] = useState<JobStatus>('idle')
  const [progress, setProgress] = useState(0)
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; text: string }[]>([])
  const [prompt, setPrompt] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [titleError, setTitleError] = useState('')
  const jobTimer = useRef<number | undefined>(undefined)
  const replyTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!requirements.some(item => item.id === selectedId)) setSelectedId(requirements[0]?.id ?? '')
    setJob('idle')
    setProgress(0)
    setMessages([])
    setTab('overview')
  }, [version, requirements, selectedId])
  useEffect(() => () => {
    if (jobTimer.current) window.clearInterval(jobTimer.current)
    if (replyTimer.current) window.clearTimeout(replyTimer.current)
  }, [])

  const selected = requirements.find(item => item.id === selectedId) ?? requirements[0]
  const filtered = requirements.filter(item => `${item.title} ${item.id}`.toLowerCase().includes(query.toLowerCase()))
  if (!selected) return null

  const stopJobTimer = () => { if (jobTimer.current) window.clearInterval(jobTimer.current); jobTimer.current = undefined }
  const startAnalysis = () => {
    if (job === 'running') return
    stopJobTimer()
    setJob('running')
    setProgress(12)
    addAudit(`启动“${selected.title}”的本地 AI 分析模拟`)
    jobTimer.current = window.setInterval(() => {
      setProgress(current => {
        const next = Math.min(current + 18, 100)
        if (next === 100) {
          stopJobTimer()
          setJob('completed')
          addAudit(`完成“${selected.title}”的本地 AI 分析模拟`)
          notify('本地模拟分析已完成，未调用真实模型或知识库。')
        }
        return next
      })
    }, 650)
  }
  const cancelAnalysis = () => {
    stopJobTimer()
    setJob('cancelled')
    addAudit(`取消“${selected.title}”的本地 AI 分析模拟`)
    notify('已取消本地模拟分析；已有示例数据保持不变。')
  }
  const submitQuestion = (question = prompt) => {
    const value = question.trim()
    if (!value || replyTimer.current) return
    setMessages(current => [...current, { role: 'user', text: value }])
    setPrompt('')
    replyTimer.current = window.setTimeout(() => {
      const answer = selected.findings.length
        ? `本地模拟回答：${selected.findings[0].title}。${selected.findings[0].text} 该结论引用当前页面的示例需求与分析结果。`
        : '本地模拟回答：当前需求尚无分析结论。请先运行本地模拟分析，再基于示例结果继续提问。'
      setMessages(current => [...current, { role: 'assistant', text: answer }])
      replyTimer.current = undefined
    }, 420)
  }
  const createRequirement = () => {
    const value = newTitle.trim()
    if (!value) { setTitleError('请输入需求分析名称。'); return }
    onCreate(value)
    setNewTitle('')
    setTitleError('')
    setCreateOpen(false)
  }
  const jobDescription = job === 'running' ? '正在按阶段检查需求结构、示例证据与测试点...' : job === 'completed' ? '本地模拟分析已完成，可重新运行。' : job === 'cancelled' ? '本地模拟分析已取消，可重新运行。' : '尚未启动本地模拟分析。'

  return <div className={`split-layout ${directoryCollapsed ? 'directory-collapsed' : ''}`}>
    <section className={`card side-list ${directoryCollapsed ? 'collapsed' : ''}`}><div className="filter-row"><div className="mini-search"><Search size={15} /><input aria-label="搜索需求" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索需求" /></div><button className="icon-btn directory-toggle" onClick={() => setDirectoryCollapsed(value => !value)} aria-label={directoryCollapsed ? '展开需求目录' : '收起需求目录'}>{directoryCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button><button className="icon-btn" onClick={() => setCreateOpen(true)} aria-label="新建需求分析"><Plus /></button></div>{filtered.length ? filtered.map(item => <button key={item.id} className={`doc-row ${selected.id === item.id ? 'selected' : ''}`} onClick={() => setSelectedId(item.id)}><FileText size={18} /><span><b>{item.title}</b><small>{item.id} · {item.status}</small></span>{item.status === '分析中' && <i />}</button>) : <p className="empty-state">没有匹配的需求。</p>}</section>
    <section className="card requirement-main"><div className="document-title"><div><Badge tone="blue">需求 {selected.version}</Badge><h2>{selected.title}</h2><p>更新于 {selected.updated} · {selected.author} · 当前版本 {version}</p></div><div className="button-stack">{job === 'running' ? <button className="btn danger" onClick={cancelAnalysis}><XCircle size={17} />取消模拟</button> : <button className="btn primary" onClick={startAnalysis}><Sparkles size={17} />{job === 'completed' ? '重新模拟分析' : '一键 AI 分析'}</button>}<small>本地模拟</small></div></div>
      <div className={`analysis-progress ${job}`} aria-live="polite"><div className="spinner"><BrainCircuit size={22} /></div><div><b>{job === 'running' ? 'AI 正在分析需求' : job === 'completed' ? '分析结果已生成' : '本地分析准备就绪'}</b><span>{jobDescription}</span><Progress value={progress} /></div><strong>{progress}%</strong></div>
      <div className="tabs" role="tablist" aria-label="需求分析内容">{([['overview', '分析概览'], ['source', '原始文档'], ['diff', '版本差异'], ['tree', '功能树'], ['evidence', '证据引用']] as const).map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>{label}</button>)}</div>
      <RequirementTab tab={tab} requirement={selected} />
    </section>
    <aside className="ai-panel card"><div className="ai-head"><div className="ai-avatar"><Sparkles size={17} /></div><span><b>需求 AI 助手</b><small>仅使用当前页面的本地示例数据</small></span><Badge tone="violet">模拟</Badge></div><div className="chat-history">{messages.length ? messages.map((message, index) => <div key={`${message.role}-${index}`} className={`chat-message ${message.role}`}><b>{message.role === 'user' ? '你' : '本地助手'}</b><p>{message.text}</p></div>) : <div className="chat-empty"><div><Bot size={29} /></div><h3>有什么想进一步了解？</h3><p>回答会明确标注为本地模拟，不会调用模型或泄露真实知识库内容。</p>{['帮我补充验收标准', '列出所有异常场景', '解释当前风险'].map(question => <button key={question} onClick={() => submitQuestion(question)}>{question}</button>)}</div>}</div><div className="chat-input"><textarea aria-label="针对当前需求提问" value={prompt} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitQuestion() } }} placeholder="针对当前需求提问..." /><button onClick={() => submitQuestion()} aria-label="发送问题" disabled={!prompt.trim()}><Sparkles size={17} /></button></div></aside>
    {createOpen && <Modal title="新建需求分析" onClose={() => { setCreateOpen(false); setTitleError('') }}><div className="modal-form"><p>新建内容仅保留在当前会话，刷新页面后会恢复示例数据。</p><label>需求分析名称<input value={newTitle} onChange={event => { setNewTitle(event.target.value); setTitleError('') }} autoFocus placeholder="例如：支付退款异常分析" /></label>{titleError && <small className="field-error">{titleError}</small>}<div className="modal-actions"><button className="btn ghost" onClick={() => setCreateOpen(false)}>取消</button><button className="btn primary" onClick={createRequirement}>创建本地草稿</button></div></div></Modal>}
  </div>
}

function RequirementTab({ tab, requirement }: { tab: 'overview' | 'source' | 'diff' | 'tree' | 'evidence'; requirement: Requirement }) {
  if (tab === 'source') return <pre className="requirement-source">{`# ${requirement.title}\n\n${requirement.intro}\n\n${requirement.sections.map((section, index) => `## ${index + 1}. ${section}\n\n此处为当前版本的本地示例需求内容。`).join('\n\n')}`}</pre>
  if (tab === 'diff') return <section className="tab-panel"><h3>版本差异（本地示例）</h3><div className="diff-line add">+ 补充退款请求必须携带唯一幂等键。</div><div className="diff-line add">+ 明确部分退款金额不得超过可退款余额。</div><div className="diff-line remove">- 删除未说明处理方式的“异常退款”描述。</div></section>
  if (tab === 'tree') return <section className="tab-panel"><h3>功能树</h3>{requirement.sections.map((section, index) => <div className="feature-node" key={section}><ChevronRight /> <b>{index + 1}. {section}</b><span>建议 {index + 3} 个测试点</span></div>)}</section>
  if (tab === 'evidence') return <section className="tab-panel"><h3>证据引用</h3>{requirement.findings.length ? requirement.findings.map(finding => <div className="evidence" key={finding.title}><FileText /><span><b>{finding.title}</b><small>当前需求 {requirement.version} · 本地 fixture</small></span><Badge tone={finding.tone}>{finding.tag}</Badge></div>) : <p className="empty-state">当前本地草稿尚未生成示例证据。</p>}</section>
  return <><div className="analysis-grid"><div className="analysis-card"><span>结构化需求</span><strong>{requirement.sections.length * 9}</strong><small>本地识别项</small></div><div className="analysis-card warning"><span>待确认问题</span><strong>{requirement.findings.length}</strong><small>需人工确认</small></div><div className="analysis-card danger"><span>潜在风险</span><strong>{requirement.findings.filter(item => item.tone !== 'blue').length}</strong><small>来自示例结果</small></div><div className="analysis-card success-card"><span>测试点建议</span><strong>{requirement.sections.length * 12}</strong><small>本地估算</small></div></div><div className="findings"><h3>重点分析结论</h3>{requirement.findings.length ? requirement.findings.map(finding => <div className="finding" key={finding.title}><div className={`finding-icon ${finding.tone}`}><AlertTriangle size={18} /></div><div><b>{finding.title}</b><p>{finding.text}</p></div><Badge tone={finding.tone}>{finding.tag}</Badge></div>) : <p className="empty-state">运行本地模拟分析后可查看示例结论。</p>}</div></>
}

function Documents({ knowledgeBaseId, apiState, refreshKnowledge, directories, documents, notify, addAudit }: { knowledgeBaseId: string; apiState: 'connecting' | 'ready' | 'offline'; refreshKnowledge: (includeDeleted?: boolean) => Promise<void>; directories: KnowledgeDirectory[]; documents: KnowledgeDocument[]; notify: Notify; addAudit: (entry: string) => void }) {
  const [selectedId, setSelectedId] = useState(documents[0]?.id ?? '')
  const [selectedDirectoryId, setSelectedDirectoryId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<ApiSearchResult[]>([])
  const [searchMeta, setSearchMeta] = useState<ApiSearchMeta | null>(null)
  const [searchStatus, setSearchStatus] = useState('')
  const [searchLocation, setSearchLocation] = useState<SearchLocation | null>(null)
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
  const file = documents.find(document => document.id === selectedId)
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
    if (!searchLocation || searchLocation.assetId !== selectedId || viewMode !== 'preview') return
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
  }, [format, searchLocation, selectedId, source, viewMode])
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
  const selectFile = (id: string) => { setSelectedId(id); setActiveSectionKey(null); setSearchLocation(null); setSelectedDirectoryId(null) }
  const openSearchResult = (result: ApiSearchResult) => {
    setSelectedId(result.asset.id)
    setSelectedDirectoryId(null)
    setViewMode('preview')
    setActiveSectionKey(null)
    setSearchLocation({ assetId: result.asset.id, startLine: result.chunk.startLine, endLine: result.chunk.endLine, nonce: Date.now() })
    searchRequestRef.current += 1
    setSearchStatus('')
    notify(`已定位固定版本 V${result.version.number} · L${result.chunk.startLine}-${result.chunk.endLine}`)
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
    try { await updateKnowledgeAsset(file.id, { displayName: fileNameDraft }); await refreshKnowledge(); addAudit(`重命名知识文件：${file.name} → ${fileNameDraft}`); notify('文件名称及物理路径已保存。'); setMoreOpen(false) }
    catch (error) { setFileActionError(error instanceof Error ? error.message : '文件重命名失败') }
    finally { setFileActionBusy(false) }
  }
  const moveFile = async () => {
    if (!file) return
    setFileActionBusy(true); setFileActionError('')
    try { await updateKnowledgeAsset(file.id, { targetDirectoryId: fileTargetDirectoryId || null }); await refreshKnowledge(); addAudit(`移动知识文件：${file.name}`); notify('文件已移动并保存到目标目录。'); setMoreOpen(false) }
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
      <article ref={documentPanelRef} className={`document-preview ${outlineCollapsed ? 'outline-collapsed' : ''}`}><div className="preview-head"><div className="breadcrumb"><Library size={14} /><span title={file ? getBreadcrumb(file) : undefined}>{file ? getBreadcrumb(file) : '尚未选择文档'}</span></div>{file && <div className="preview-actions"><Badge tone={file.task?.status === 'failed' ? 'red' : file.task ? 'orange' : file.status === 'ready' ? 'green' : 'gray'}>{file.task?.status === 'failed' ? '入库失败' : file.task ? `${file.task.step} ${file.task.progress}%` : file.status === 'ready' ? '已入库' : '等待入库'}</Badge><div className="view-switch" role="group" aria-label="文档视图"><button className={viewMode === 'preview' ? 'active' : ''} aria-pressed={viewMode === 'preview'} onClick={() => setViewMode('preview')}><BookOpen />预览</button><button className={viewMode === 'source' ? 'active' : ''} aria-pressed={viewMode === 'source'} onClick={() => setViewMode('source')}><Code2 />源码</button><button className={viewMode === 'split' ? 'active' : ''} aria-pressed={viewMode === 'split'} onClick={() => setViewMode('split')}><Columns2 />分屏</button></div><button className="btn ghost" onClick={() => setHistoryOpen(true)}><Clock3 />版本历史</button><button className="icon-btn" title={outlineCollapsed ? '显示本文目录' : '隐藏本文目录'} aria-label={outlineCollapsed ? '显示本文目录' : '隐藏本文目录'} onClick={() => setOutlineCollapsed(value => !value)}>{outlineCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button><button className="icon-btn" aria-label="文档更多操作" onClick={() => openFileActions()}><MoreHorizontal /></button></div>}</div>
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
    return <div ref={ref} className={className}><div className="document-meta"><Badge tone="blue">{format === 'text' ? 'TXT' : 'Markdown'}</Badge><span>版本 {file.version}</span><span>更新于 {file.updated}</span><Badge tone="green">已入活动索引</Badge></div><MarkdownDocument source={source} format={format} knowledgeBaseId={knowledgeBaseId} logicalPath={file.logicalPath} outline={outline} activeSectionKey={activeSectionKey} anchorPrefix={compact ? `split-${file.id}` : `preview-${file.id}`} onOpenKnowledgeDocument={onOpenDocument} /><div className="readonly-notice">固定资产版本：{file.assetVersionId} · 来源：{file.sourceType} · 类型：{file.assetType}</div></div>
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
    { name: 'AI 模型与路由', desc: '大模型、Embedding 与路由策略', icon: Bot, group: 'AI 能力' },
    { name: 'Prompt 与 Agent', desc: '分析模板、工具和版本管理', icon: Sparkles, group: 'AI 能力' },
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
  useEffect(() => { if (!knowledgeBaseId) return; void loadConfig(knowledgeBaseId).then(value => {
    const config = value.config
    const mapped: SettingsDraft = { ...initialSettings, parserVersion: config.parserVersion, preprocessVersion: config.preprocessVersion, chunkSize: `${config.chunkTargetSize} tokens`, chunkMaxSize: String(config.chunkMaxSize), chunkOverlap: `${config.chunkOverlap} tokens`, headingDepth: String(config.headingDepth), embeddingSourceId: config.embeddingSourceId, embeddingSources: config.embeddingSources, embeddingMode: config.embeddingMode, embeddingBaseUrl: config.embeddingBaseUrl, embeddingApiKey: config.embeddingApiKey, embeddingModel: config.embeddingModel, embeddingDimensions: String(config.embeddingDimensions), embeddingBatchSize: String(config.embeddingBatchSize), embeddingTimeoutMs: String(config.embeddingTimeoutMs), embeddingRetries: String(config.embeddingRetries), vectorRecall: String(config.vectorRecall), keywordRecall: String(config.keywordRecall), finalResults: String(config.finalResults), relevanceThreshold: config.relevanceThreshold, hybridSearch: config.hybridSearch, rerankerEnabled: config.rerankerEnabled, rerankerSourceId: config.rerankerSourceId ?? config.embeddingSourceId, rerankerModel: config.rerankerModel }
    setSaved(mapped); setDraft(mapped); setConfigVersion(value.version); setRequiresRebuild(value.requiresRebuild)
  }).catch(() => notify('知识库配置 API 未连接。')) }, [knowledgeBaseId])
  const current = items[selected]
  const CurrentIcon = current.icon
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft)
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
    setSaved(draft); addAudit(`保存系统设置草稿：${current.name}`); notify('配置已保存在当前会话。')
  }
  return <div className={`settings-layout ${collapsed ? 'directory-collapsed' : ''}`}><aside className={`card settings-directory ${collapsed ? 'collapsed' : ''}`}><div className="settings-dir-head"><b>配置目录</b><button className="icon-btn" title={collapsed ? '展开配置目录' : '收起配置目录'} aria-label={collapsed ? '展开配置目录' : '收起配置目录'} onClick={() => setCollapsed(value => !value)}>{collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button></div>{['AI 能力', '资源与集成', '安全与治理'].map(group => <div className="settings-group" key={group}><p>{group}</p>{items.map((item, index) => item.group === group && <button key={item.name} className={selected === index ? 'active' : ''} onClick={() => setSelected(index)}><item.icon /><span><b>{item.name}</b><small>{item.desc}</small></span><ChevronRight /></button>)}</div>)}</aside>
    <section className="card settings-editor"><div className="settings-editor-head"><div className="setting-symbol"><CurrentIcon /></div><div><h2>{current.name}</h2><p>{current.desc}{selected === 2 && configVersion ? ` · 配置 V${configVersion}` : ''}</p></div><Badge tone={dirty ? 'orange' : requiresRebuild && selected === 2 ? 'orange' : 'green'}>{dirty ? '有未保存更改' : requiresRebuild && selected === 2 ? '待重建' : '已保存'}</Badge><button className="btn primary" disabled={!dirty} onClick={() => void save()}><Check />保存配置</button></div><div className="settings-editor-scroll" ref={editorScrollRef}>
      {selected === 0 && <ModelRoutingSettings draft={draft} update={update} />}
      {selected === 1 && <StaticSettings title="Prompt 模板" text="模板与 Agent 权限当前显示为本地示例；保存按钮可保存会话内草稿设置。" />}
      {selected === 2 && <div className="settings-form">
        <FormSection title="模型来源与运行时" desc="集中管理多个来源和模型，再选择知识库实际使用的来源与模型"><EmbeddingModelPrototype knowledgeBaseId={knowledgeBaseId} draft={draft} update={update} notify={notify} /></FormSection>
        <FormSection title="Markdown 切分" desc="按模型 tokenizer 计数；修改后需要重建索引"><FormRow label="目标 Chunk 大小" help="默认 400 tokens，达到目标后优先在 Markdown 结构边界切分"><select value={draft.chunkSize} onChange={event => { const value = event.target.value; const target = Number.parseInt(value); update('chunkSize', value); if (target > Number(draft.chunkMaxSize)) update('chunkMaxSize', String(target === 600 ? 800 : target)) }}><option>300 tokens</option><option>400 tokens</option><option>600 tokens</option><option>800 tokens</option></select></FormRow><FormRow label="最大 Chunk 大小" help="普通文本不会超过该值；代码块和表格优先保持完整"><select value={draft.chunkMaxSize} onChange={event => { const value = event.target.value; update('chunkMaxSize', value); if (Number.parseInt(draft.chunkSize) > Number(value)) update('chunkSize', `${Math.min(Number(value), 400)} tokens`) }}><option>400</option><option>480</option><option>800</option><option>1200</option></select></FormRow><FormRow label="Chunk 重叠" help="仅在同一标题内切出相邻块时保留尾部上下文"><select value={draft.chunkOverlap} onChange={event => update('chunkOverlap', event.target.value)}><option>0 tokens</option><option>50 tokens</option><option>80 tokens</option><option>120 tokens</option></select></FormRow></FormSection>
        <FormSection title="检索与索引" desc="调整检索参数并管理向量索引"><RetrievalIndexConfig knowledgeBaseId={knowledgeBaseId} requiresRebuild={requiresRebuild} onRebuilt={() => setRequiresRebuild(false)} draft={draft} update={update} notify={notify} /></FormSection>
      </div>}
      {selected === 3 && <div className="settings-form"><FormSection title="代码仓库" desc="当前仅保存本地草稿，不会连接仓库"><FormRow label="仓库地址" help="刷新页面后恢复示例地址"><input value={draft.repositoryUrl} onChange={event => update('repositoryUrl', event.target.value)} /></FormRow><FormRow label="默认分支" help="用于示例基线比较"><input value={draft.defaultBranch} onChange={event => update('defaultBranch', event.target.value)} /></FormRow></FormSection></div>}
      {selected === 4 && <StaticSettings title="访问控制" text="成员、角色和审批流程尚未接入服务端；当前页面仅展示本地原型说明。" />}
      {selected === 5 && <div className="settings-form"><FormSection title="数据安全" desc="安全策略可在本次会话中作为草稿保存"><SwitchRow title="启用完整审计" desc="记录当前会话中的本地模拟操作" checked={draft.auditEnabled} onChange={value => update('auditEnabled', value)} /></FormSection></div>}
    </div></section></div>
}

function StaticSettings({ title, text }: { title: string; text: string }) { return <div className="settings-form"><FormSection title={title} desc={text}><p className="readonly-notice">此项没有后端支撑，因此不伪造成功、连接或持久化状态。</p></FormSection></div> }

function ModelRoutingSettings({ draft, update }: { draft: SettingsDraft; update: <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => void }) {
  return <div className="settings-form"><FormSection title="默认模型" desc="仅保存本地配置草稿"><FormRow label="主分析模型" help="不发起真实模型调用"><select value={draft.mainModel} onChange={event => update('mainModel', event.target.value)}><option>GPT-5.2 · 推荐</option><option>私有模型</option></select></FormRow><FormRow label="模型温度" help="数值越低，输出结果越稳定"><div className="range-field"><input type="range" min="0" max="10" value={Math.round(draft.temperature * 10)} onChange={event => update('temperature', Number(event.target.value) / 10)} /><b>{draft.temperature.toFixed(1)}</b></div></FormRow></FormSection><FormSection title="路由与降级" desc="控制会话内草稿"><SwitchRow title="启用智能模型路由" desc="仅保存选择，不会调用模型服务" checked={draft.intelligentRouting} onChange={value => update('intelligentRouting', value)} /><SwitchRow title="AI 不可用时允许降级" desc="继续使用确定性示例资产" checked={draft.fallbackEnabled} onChange={value => update('fallbackEnabled', value)} /></FormSection></div>
}

function FormSection({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) { return <section className="form-section"><div className="form-section-title"><h3>{title}</h3>{desc && <p>{desc}</p>}</div><div>{children}</div></section> }
function FormRow({ label, help, children }: { label: string; help: string; children: ReactNode }) { return <label className="form-row"><span><b>{label}</b><small>{help}</small></span><div>{children}</div></label> }
function SwitchRow({ title, desc, checked, onChange }: { title: string; desc: string; checked: boolean; onChange: (value: boolean) => void }) { return <div className="form-row"><span><b>{title}</b><small>{desc}</small></span><label className="switch"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} aria-label={title} /><i /></label></div> }

type SourceEditorDraft = { name: string; baseUrl: string; apiKey: string; modelName: string }
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

  const addSource = () => {
    if (!sourceEditor) return
    const name = sourceEditor.name.trim(); const modelName = sourceEditor.modelName.trim()
    if (!name || !modelName) { notify('请填写来源名称和模型名称。'); return }
    if (!/^https?:\/\//i.test(sourceEditor.baseUrl)) { notify('远程来源 Base URL 必须使用 http:// 或 https://。'); return }
    const source: EmbeddingSourceDraft = { id: crypto.randomUUID(), name, type: 'remote_api', baseUrl: sourceEditor.baseUrl.trim(), apiKey: sourceEditor.apiKey, models: [{ name: modelName, dimensions: 0 }] }
    updateSources([...draft.embeddingSources, source]); applySelection(source); setSourceEditor(null)
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
      <header><div className={`source-kind ${source.type}`} >{source.type === 'local' ? <Download /> : <Database />}</div><span><b>{source.name}</b><small title={source.type === 'remote_api' ? source.baseUrl : undefined}>{source.type === 'local' ? '系统内置 · 可同时运行多个模型' : source.baseUrl}</small></span><Badge tone={source.type === 'local' ? 'green' : 'purple'}>{source.type === 'local' ? '本地' : '远程 API'} · {source.models.length} 个</Badge>{source.type === 'remote_api' && <button className="icon-btn" title="删除来源" aria-label={`删除来源 ${source.name}`} onClick={() => removeSource(source.id)}><Trash2 /></button>}</header>
      <div className="source-model-list"><div className="source-model-table-head"><span>模型</span><span>向量维度</span><span>状态</span><span>操作</span></div>{source.models.map(model => {
        const runtime = source.type === 'local' ? runtimeStatuses.find(status => status.model === model.name) : undefined
        const working = runtime?.phase === 'downloading' || runtime?.phase === 'loading' || runtime?.phase === 'stopping'
        const running = runtime?.phase === 'running'
        const testKey = `${source.id}:${model.name}`
        const detectedDimensions = runtime?.dimensions ?? model.dimensions
        const dimensionReady = detectedDimensions > 0
        const statusLabel = source.type === 'remote_api' ? model.dimensions > 0 ? '已检测' : '待检测' : runtime?.fallbackUsed && running ? '镜像运行' : phaseLabel(runtime?.phase)
        return <div className={`source-model-row ${working ? 'working' : ''}`} key={model.name}><div className="model-identity"><div className={`model-state-dot ${runtime?.phase ?? (source.type === 'remote_api' && model.dimensions > 0 ? 'configured' : 'idle')}`} /><span><b title={model.name}>{model.name}</b><small>{source.type === 'local' ? '本地模型' : 'API 模型'}{runtime?.maxTokens ? ` · 最大 ${runtime.maxTokens} tokens` : ''}</small></span></div><div className={`model-dimension ${dimensionReady ? 'ready' : 'pending'} ${runtime?.error ? 'failed' : ''}`}><b>{dimensionReady ? `${detectedDimensions} 维` : '自动检测'}</b><small title={runtime?.error}>{runtime?.error ?? (dimensionReady ? '已识别' : source.type === 'local' ? '运行后识别' : '检测后识别')}</small></div><Badge tone={source.type === 'remote_api' ? model.dimensions > 0 ? 'blue' : 'orange' : phaseTone(runtime?.phase)}>{statusLabel}</Badge><div className="model-row-actions">{source.type === 'local' ? <button className={`btn ${running ? 'danger' : 'ghost'}`} disabled={runtimeBusy === model.name || working} onClick={() => void operateLocalModel(model.name, running)}>{running ? <><XCircle />停止</> : <><Play />运行</>}</button> : <button className="btn ghost" disabled={Boolean(testingModel)} onClick={() => void testConnection(source, model)}><Activity />{testingModel === testKey ? '检测中' : model.dimensions > 0 ? '重检' : '检测'}</button>}<button className="icon-btn model-remove" title="移除模型" aria-label={`移除模型 ${model.name}`} onClick={() => void removeModel(source, model.name)}><Trash2 /></button></div>{working && <div className="model-row-progress"><Progress value={runtime?.progress ?? 0} tone="orange" /><small>{runtime?.progress ?? 0}%</small></div>}</div>
      })}{source.models.length === 1 && <button type="button" className="source-model-add-slot" onClick={() => document.getElementById(`model-input-${source.id}`)?.focus()}><Plus /><span><b>继续添加模型</b><small>同一来源可以配置多个模型</small></span></button>}{source.models.length === 0 && <div className="source-model-empty"><Download /><span><b>暂无{source.type === 'local' ? '本地' : '远程'}模型</b><small>可以从下方输入模型名称并添加。</small></span></div>}</div>
      <div className="add-source-model">{source.type === 'local' ? <div className="model-recommendation-combobox" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setRecommendationSourceId('') }}><input id={`model-input-${source.id}`} value={modelDrafts[source.id] ?? ''} onFocus={() => setRecommendationSourceId(source.id)} onChange={event => { setModelDrafts(current => ({ ...current, [source.id]: event.target.value })); setRecommendationSourceId(source.id) }} placeholder="选择推荐模型或输入 Hugging Face 模型名" aria-label="本地模型名称" autoComplete="off" /><button className="recommendation-trigger" type="button" title="选择推荐模型" aria-label="选择推荐模型" aria-expanded={recommendationSourceId === source.id} onClick={() => setRecommendationSourceId(current => current === source.id ? '' : source.id)}><Sparkles /><ChevronDown /></button>{recommendationSourceId === source.id && <div className="model-recommendation-menu" role="listbox"><header><span><Sparkles />推荐模型</span><small>也可以直接输入其他模型名称</small></header>{localModelRecommendations.filter(item => { const query = (modelDrafts[source.id] ?? '').trim().toLocaleLowerCase(); return !query || item.name.toLocaleLowerCase().includes(query) || item.title.toLocaleLowerCase().includes(query) }).map(item => { const added = source.models.some(model => model.name === item.name); return <button type="button" role="option" aria-selected={modelDrafts[source.id] === item.name} disabled={added} key={item.name} onClick={() => { setModelDrafts(current => ({ ...current, [source.id]: item.name })); setRecommendationSourceId('') }}><span><b>{item.title}</b><small>{item.name}</small></span><em>{added ? '已添加' : item.detail}</em></button>})}{localModelRecommendations.every(item => { const query = (modelDrafts[source.id] ?? '').trim().toLocaleLowerCase(); return query && !item.name.toLocaleLowerCase().includes(query) && !item.title.toLocaleLowerCase().includes(query) }) && <p>没有匹配的推荐项，可直接使用当前输入的自定义模型。</p>}</div>}</div> : <input id={`model-input-${source.id}`} value={modelDrafts[source.id] ?? ''} onChange={event => setModelDrafts(current => ({ ...current, [source.id]: event.target.value }))} placeholder="API 模型名称" />}<span className="auto-dimension"><Activity />维度自动检测</span><button className="btn ghost" onClick={() => addModel(source)}><Plus />添加模型</button></div>
    </section>)}</div>
    <div className="active-model-picker"><div className="picker-title"><CheckCircle2 /><span><b>知识库生效模型</b><small>先选择来源，再选择该来源下用于向量化和检索的模型</small></span></div><label><span>使用来源</span><select value={selectedSource?.id ?? ''} onChange={event => { const source = draft.embeddingSources.find(item => item.id === event.target.value); if (source) applySelection(source) }}>{draft.embeddingSources.map(source => <option key={source.id} value={source.id}>{source.name} · {source.type === 'local' ? '本地' : '远程'}</option>)}</select></label><label><span>使用模型</span><select value={draft.embeddingModel} disabled={!selectedSource?.models.length} onChange={event => { const model = selectedSource?.models.find(item => item.name === event.target.value); if (selectedSource && model) applySelection(selectedSource, model) }}>{!selectedSource?.models.length && <option value="">暂无模型</option>}{selectedSource?.models.map(model => <option key={model.name} value={model.name}>{model.name} · {model.dimensions > 0 ? `${model.dimensions} 维` : '自动检测'}</option>)}</select></label></div>
    {selectedSource && <div className={`active-model-summary ${draft.embeddingModel ? '' : 'empty'}`}><Zap /><span><b>{draft.embeddingModel ? `当前选择：${selectedSource.name} / ${draft.embeddingModel}` : '当前没有生效模型'}</b><small>{draft.embeddingModel ? selectedSource.type === 'local' ? '保存后，任务会使用对应的本地运行实例；未运行时将自动启动。' : `请求将发送到 ${selectedSource.baseUrl}` : '可以保存空模型列表；添加本地模型或选择远程模型后即可恢复向量能力。'}</small></span></div>}
    {sourceEditor && <Modal title="添加远程模型来源" onClose={() => setSourceEditor(null)}><div className="modal-form"><p>支持 OpenAI 兼容 Embeddings API 和 Ollama 原生 API。Ollama 可直接填写 <code>http://localhost:11434/api/embed</code>。</p><label>来源名称<input value={sourceEditor.name} onChange={event => setSourceEditor(current => current ? { ...current, name: event.target.value } : current)} placeholder="例如：本机 Ollama" /></label><label>Base URL<input value={sourceEditor.baseUrl} onChange={event => setSourceEditor(current => current ? { ...current, baseUrl: event.target.value } : current)} placeholder="https://api.example.com/v1 或 http://localhost:11434/api/embed" /></label><label>API Key（可选）<input type="password" value={sourceEditor.apiKey} onChange={event => setSourceEditor(current => current ? { ...current, apiKey: event.target.value } : current)} placeholder="Ollama 本地接口可留空" /></label><label>首个模型<input value={sourceEditor.modelName} onChange={event => setSourceEditor(current => current ? { ...current, modelName: event.target.value } : current)} placeholder="例如：bge-m3" /></label><div className="auto-detect-note"><Activity /><span><b>向量维度：自动检测</b><small>添加后点击“检测”，系统将请求一次 Embedding 并记录实际维度。</small></span></div><div className="modal-actions"><button className="btn ghost" onClick={() => setSourceEditor(null)}>取消</button><button className="btn primary" onClick={addSource}><Plus />添加并选择</button></div></div></Modal>}
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
  const startRebuild = async () => {
    if (rebuild === 'running') return
    setRebuild('running'); setRebuildProgress(10)
    try {
      const queued = await rebuildIndex(knowledgeBaseId); setRebuildTaskId(queued.task.id)
      for (let attempt = 0; attempt < 60; attempt++) { await new Promise(resolvePromise => window.setTimeout(resolvePromise, 200)); const task = (await loadTasks(knowledgeBaseId)).find(item => item.id === queued.task.id); if (!task) continue; setRebuildProgress(task.progress); if (task.status === 'succeeded') { setRebuild('completed'); onRebuilt(); notify('候选索引校验完成，活动索引已原子切换。'); return } if (task.status === 'cancelled') { setRebuild('cancelled'); notify('索引重建已取消，旧活动索引继续生效。'); return } if (task.status === 'failed') throw new Error(task.error ?? '索引重建失败') }
      throw new Error('索引重建等待超时')
    }
    catch (error) { setRebuild('failed'); notify(error instanceof Error ? error.message : '索引重建失败，旧索引继续生效。') }
  }
  const cancelRebuild = async () => { if (!rebuildTaskId) return; await cancelTask(rebuildTaskId); setRebuild('cancelled'); setRebuildProgress(0); notify('已取消索引重建；旧活动索引继续生效。') }
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
