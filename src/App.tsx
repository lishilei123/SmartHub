import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import {
  Activity, AlertTriangle, Bell, BookOpen, Bot, BrainCircuit, Check, CheckCircle2, ChevronDown,
  ChevronRight, CircleHelp, Clock3, Code2, Columns2, Database, Download, FileCode2, FileText,
  FolderOpen, GitBranch, LayoutDashboard, Library, ListChecks, MessageSquareText, MoreHorizontal,
  PanelLeftClose, PanelLeftOpen, Play, Plus, RefreshCw, Search, Settings, ShieldCheck, Sparkles,
  TestTube2, Upload, Users, XCircle, Zap,
} from 'lucide-react'
import {
  initialSettings, knowledgeDocuments, requirementsByVersion, type KnowledgeDocument, type Requirement,
  type SettingsDraft, type Version,
} from './prototype-data'

type PageKey = 'dashboard' | 'requirements' | 'documents' | 'design' | 'execution' | 'reports' | 'settings'
type Notify = (message: string) => void
type JobStatus = 'idle' | 'running' | 'completed' | 'cancelled' | 'failed'

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
  const [page, setPage] = useState<PageKey>('dashboard')
  const [version, setVersion] = useState<Version>('V3.6')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null)
  const [requirementLists, setRequirementLists] = useState<Record<Version, Requirement[]>>(requirementsByVersion)
  const [requirementCreateOpen, setRequirementCreateOpen] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  const [audit, setAudit] = useState<string[]>(['已打开当前会话的 SmartHub 本地原型'])
  const [globalQuery, setGlobalQuery] = useState('')
  const [globalOpen, setGlobalOpen] = useState(false)
  const toastTimer = useRef<number | undefined>(undefined)

  const notify: Notify = message => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    const next = { id: Date.now(), message }
    setToast(next)
    toastTimer.current = window.setTimeout(() => setToast(current => current?.id === next.id ? null : current), 2600)
  }

  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current) }, [])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '')) {
        event.preventDefault()
        setGlobalOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
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

  const searchResults = useMemo(() => {
    const query = globalQuery.trim().toLowerCase()
    if (!query) return []
    const requirements = requirementLists[version]
      .filter(item => `${item.title} ${item.intro}`.toLowerCase().includes(query))
      .map(item => ({ label: item.title, detail: '需求分析', page: 'requirements' as PageKey }))
    const documents = knowledgeDocuments
      .filter(item => `${item.name} ${item.intro}`.toLowerCase().includes(query))
      .map(item => ({ label: item.name, detail: '知识库文档', page: 'documents' as PageKey }))
    return [...requirements, ...documents].slice(0, 6)
  }, [globalQuery, requirementLists, version])
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
      <button className="sidebar-foot" onClick={() => notify('帮助与反馈为静态原型说明：当前数据仅保留在本次会话中。')}><CircleHelp size={17} /><span>帮助与反馈</span><span className="version">v0.1</span></button>
    </aside>
    <main>
      <header className="topbar">
        <div className="search"><Search size={17} /><input aria-label="全局搜索" value={globalQuery} onFocus={() => setGlobalOpen(true)} onChange={event => { setGlobalQuery(event.target.value); setGlobalOpen(true) }} placeholder="搜索需求、知识库文档..." /><kbd>⌘ K</kbd>
          {globalOpen && <div className="global-results">{globalQuery ? searchResults.length ? searchResults.map(result => <button key={`${result.page}-${result.label}`} onClick={() => { setPage(result.page); setGlobalOpen(false); setGlobalQuery('') }}><b>{result.label}</b><small>{result.detail}</small></button>) : <p>当前版本没有匹配的本地数据。</p> : <p>输入关键词可搜索当前版本需求和全局知识库。</p>}</div>}
        </div>
        <div className="top-actions"><button title="AI 助手" aria-label="打开需求 AI 助手" onClick={() => { setPage('requirements'); notify('已打开需求分析中的本地 AI 助手。') }}><Sparkles size={18} /></button><button className="notification" title="通知" aria-label="查看通知" onClick={() => notify('当前没有新的远程通知；此原型不会连接服务端。')}><Bell size={18} /><i /></button><div className="avatar">LS</div><div className="user"><b>李磊</b><span>测试负责人</span></div></div>
      </header>
      <section className="content">
        <div className="page-head"><div><h1>{meta.title}</h1><p>{meta.desc}</p></div>{page === 'requirements' && <div className="head-actions"><button className="btn ghost" onClick={() => setActivityOpen(true)}><Clock3 size={16} />操作记录</button><button className="btn primary" onClick={() => setRequirementCreateOpen(true)}><Plus size={17} />新建需求分析</button></div>}</div>
        {page === 'dashboard' && <Dashboard navigate={setPage} version={version} />}
        {page === 'requirements' && <Requirements version={version} requirements={requirementLists[version]} createOpen={requirementCreateOpen} setCreateOpen={setRequirementCreateOpen} onCreate={addRequirement} notify={notify} addAudit={entry => setAudit(current => [entry, ...current])} />}
        {page === 'documents' && <Documents notify={notify} addAudit={entry => setAudit(current => [entry, ...current])} />}
        {page === 'design' && <StaticNotice title="测试设计" text="测试设计页面仍展示示例资产；本次交互修复聚焦需求分析、知识库和系统设置。" />}
        {page === 'execution' && <StaticNotice title="测试执行" text="测试执行页面仍展示示例执行数据；本次交互修复聚焦需求分析、知识库和系统设置。" />}
        {page === 'reports' && <StaticNotice title="报告与诊断" text="报告页面仍展示示例质量数据；本次交互修复聚焦需求分析、知识库和系统设置。" />}
        {page === 'settings' && <SystemSettings notify={notify} addAudit={entry => setAudit(current => [entry, ...current])} />}
      </section>
    </main>
    {toast && <div className="toast" role="status"><CheckCircle2 size={18} />{toast.message}</div>}
    {activityOpen && <Modal title="本次会话操作记录" onClose={() => setActivityOpen(false)}><div className="activity-modal"><p>记录只保留在当前浏览器会话中。</p>{audit.map((entry, index) => <div key={`${entry}-${index}`}><Clock3 size={15} /><span>{entry}</span></div>)}</div></Modal>}
  </div>
}

function Dashboard({ navigate, version }: { navigate: (page: PageKey) => void; version: Version }) {
  return <div className="dashboard-grid"><section className="card span2 dashboard-notice"><Badge tone="violet"><Sparkles size={12} /> 当前版本 {version}</Badge><h2>本地原型交互已接通</h2><p>需求分析、知识库和系统设置会在本次会话中保存可见状态；所有模型、上传和同步结果都会明确标注为本地模拟。</p><div><button className="btn primary" onClick={() => navigate('requirements')}>进入需求分析</button><button className="btn ghost" onClick={() => navigate('documents')}>查看知识库</button></div></section><section className="card quick-card"><BrainCircuit /><h3>需求分析</h3><p>搜索需求、切换分析视图并运行可取消的本地模拟任务。</p><button className="text-btn" onClick={() => navigate('requirements')}>打开需求分析 <ChevronRight /></button></section><section className="card quick-card"><Library /><h3>知识库</h3><p>搜索、查看文档、浏览版本说明和受控图片预览。</p><button className="text-btn" onClick={() => navigate('documents')}>打开知识库 <ChevronRight /></button></section><section className="card quick-card"><Settings /><h3>系统设置</h3><p>使用草稿保存和可停止的本地模型、索引模拟。</p><button className="text-btn" onClick={() => navigate('settings')}>打开系统设置 <ChevronRight /></button></section></div>
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

function Documents({ notify, addAudit }: { notify: Notify; addAudit: (entry: string) => void }) {
  const [selectedId, setSelectedId] = useState(knowledgeDocuments[0].id)
  const [query, setQuery] = useState('')
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  const [outlineCollapsed, setOutlineCollapsed] = useState(false)
  const [viewMode, setViewMode] = useState<'preview' | 'source' | 'split'>('preview')
  const [activeSection, setActiveSection] = useState(0)
  const [imageOpen, setImageOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [syncState, setSyncState] = useState<JobStatus>('idle')
  const [uploadState, setUploadState] = useState<JobStatus>('idle')
  const timers = useRef<number[]>([])
  useEffect(() => () => timers.current.forEach(timer => window.clearTimeout(timer)), [])

  const documents = knowledgeDocuments.filter(item => `${item.name} ${item.intro}`.toLowerCase().includes(query.toLowerCase()))
  const file = knowledgeDocuments.find(item => item.id === selectedId) ?? knowledgeDocuments[0]
  const source = makeSource(file)
  const simulate = (kind: 'sync' | 'upload') => {
    const setState = kind === 'sync' ? setSyncState : setUploadState
    const current = kind === 'sync' ? syncState : uploadState
    if (current === 'running') return
    setState('running')
    const timer = window.setTimeout(() => {
      setState('completed')
      const action = kind === 'sync' ? '知识库同步' : '文档上传'
      addAudit(`${action}本地模拟完成`)
      notify(`${action}本地模拟已完成；未上传文件，也没有同步远程知识库。`)
    }, 1000)
    timers.current.push(timer)
  }
  const selectFile = (id: string) => { setSelectedId(id); setActiveSection(0) }
  const jumpToSection = (index: number) => {
    setActiveSection(index)
    document.getElementById(`document-section-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return <section className="card knowledge-page"><div className="knowledge-toolbar"><div className="mini-search wide"><Search size={16} /><input aria-label="搜索知识库" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索文件名称或文档内容" /></div><Badge tone={syncState === 'running' ? 'orange' : 'green'}>{syncState === 'running' ? <RefreshCw size={12} /> : <CheckCircle2 size={12} />}{syncState === 'running' ? '本地同步中' : syncState === 'completed' ? '本地模拟已完成' : '知识库示例数据'}</Badge><button className="btn ghost" disabled={syncState === 'running'} onClick={() => simulate('sync')}><GitBranch size={16} />{syncState === 'running' ? '同步模拟中' : '立即同步'}</button><button className="btn primary" disabled={uploadState === 'running'} onClick={() => simulate('upload')}><Upload size={16} />{uploadState === 'running' ? '上传模拟中' : '上传文档'}</button></div>
    <div className={`knowledge-layout ${treeCollapsed ? 'tree-collapsed' : ''}`}><aside className={`file-tree ${treeCollapsed ? 'collapsed' : ''}`}><div className="tree-title"><span>文件目录</span><button className="icon-btn" title={treeCollapsed ? '展开文件树' : '收起文件树'} aria-label={treeCollapsed ? '展开文件树' : '收起文件树'} onClick={() => setTreeCollapsed(value => !value)}>{treeCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button></div><div className="tree-root"><ChevronDown /><FolderOpen /><b>SmartHub 知识库</b><small>{knowledgeDocuments.length}</small></div>{documents.length ? documents.map(item => <button className={`tree-file ${selectedId === item.id ? 'active' : ''}`} key={item.id} onClick={() => selectFile(item.id)}><FileText /><span>{item.name}</span></button>) : <p className="empty-state">没有匹配的文档。</p>}</aside>
      <article className={`document-preview ${outlineCollapsed ? 'outline-collapsed' : ''}`}><div className="preview-head"><div className="breadcrumb"><Library size={14} /><span>{file.path}</span></div><div className="preview-actions"><Badge tone="green">只读原型</Badge><div className="view-switch" role="group" aria-label="文档视图"><button className={viewMode === 'preview' ? 'active' : ''} aria-pressed={viewMode === 'preview'} onClick={() => setViewMode('preview')}><BookOpen />预览</button><button className={viewMode === 'source' ? 'active' : ''} aria-pressed={viewMode === 'source'} onClick={() => setViewMode('source')}><Code2 />源码</button><button className={viewMode === 'split' ? 'active' : ''} aria-pressed={viewMode === 'split'} onClick={() => setViewMode('split')}><Columns2 />分屏</button></div><button className="btn ghost" onClick={() => setHistoryOpen(true)}><Clock3 />版本历史</button><button className="icon-btn" title={outlineCollapsed ? '显示本文目录' : '隐藏本文目录'} aria-label={outlineCollapsed ? '显示本文目录' : '隐藏本文目录'} onClick={() => setOutlineCollapsed(value => !value)}>{outlineCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button><button className="icon-btn" aria-label="文档更多操作" onClick={() => setMoreOpen(true)}><MoreHorizontal /></button></div></div>
        {viewMode === 'preview' ? <DocumentContent file={file} activeSection={activeSection} onOpenImage={() => setImageOpen(true)} /> : viewMode === 'source' ? <SourceView source={source} /> : <div className="split-view"><section className="split-pane source-pane"><header><Code2 />Markdown 源码 <Badge tone="orange">只读</Badge></header><SourceView source={source} /></section><section className="split-pane rendered-pane"><header><BookOpen />渲染预览</header><DocumentContent file={file} activeSection={activeSection} onOpenImage={() => setImageOpen(true)} compact /></section></div>}
        {viewMode === 'preview' && <nav className="document-outline" aria-label="本文目录"><b>本文目录</b>{file.sections.map((section, index) => <button key={section} className={activeSection === index ? 'active' : ''} onClick={() => jumpToSection(index)}>{index + 1}. {section}</button>)}</nav>}
      </article></div>
    {imageOpen && <ImageLightbox onClose={() => setImageOpen(false)} />}
    {historyOpen && <Modal title="文档版本历史（本地示例）" onClose={() => setHistoryOpen(false)}><div className="history-list"><div><b>{file.version}</b><span>当前展示版本 · {file.updated}</span></div><div><b>上一版本</b><span>本地示例记录，不可恢复或覆盖当前文档。</span></div></div></Modal>}
    {moreOpen && <Modal title="文档操作说明" onClose={() => setMoreOpen(false)}><div className="modal-form"><p>当前文档处于只读原型模式。编辑、正式保存、发布和远程同步均需要后端与权限服务支持。</p><button className="btn primary" onClick={() => setMoreOpen(false)}>我知道了</button></div></Modal>}
  </section>
}

function makeSource(file: KnowledgeDocument) {
  return `# ${file.title}\n\n${file.intro}\n\n> 文档说明：当前为只读本地示例，不能保存或发布。\n\n${file.sections.map((section, index) => `## ${index + 1}. ${section}\n\n随着业务规模持续增长，本文档的示例内容覆盖主流程、异常处理和可追溯要求。\n\n${index === 0 ? '![统一支付与退款处理流程](assets/payment-flow.svg)' : ''}`).join('\n\n')}`
}

function SourceView({ source }: { source: string }) {
  return <div className="source-view"><div className="source-gutter">{source.split('\n').map((_, index) => <span key={index}>{index + 1}</span>)}</div><pre><code>{source}</code></pre></div>
}

function DocumentContent({ file, activeSection, onOpenImage, compact = false }: { file: KnowledgeDocument; activeSection: number; onOpenImage: () => void; compact?: boolean }) {
  const className = compact ? 'split-markdown' : 'markdown-view'
  return <div className={className}><div className="document-meta"><Badge tone="blue">Markdown</Badge><span>版本 {file.version}</span><span>更新于 {file.updated}</span><Badge tone="orange">只读</Badge></div><h1>{file.title}</h1><p>{file.intro}</p><div className="md-callout"><CircleHelp size={18} /><div><b>只读原型说明</b><span>编辑、保存、发布和历史恢复需要后端服务；当前只能查看本地示例。</span></div></div>{file.sections.map((section, index) => <section id={`document-section-${index}`} className={activeSection === index ? 'active-document-section' : ''} key={section}><h2>{index + 1}. {section}</h2><p>随着业务规模持续增长，原有流程在扩展性、异常恢复和统一治理方面逐渐暴露出不足。本地示例用于验证阅读、定位和视图切换交互。</p>{index === 0 && <button className="md-image" onClick={onOpenImage} aria-label="打开统一支付与退款处理流程原图"><img src="/assets/payment-flow.svg" alt="统一支付与退款处理流程" /><span><span>图 1：统一支付与退款处理流程</span><em>点击查看原图</em></span></button>}{index === 1 && <ul><li>统一核心流程及状态流转规则。</li><li>完善异常、超时和重试场景。</li><li>保留来源引用并支持版本追溯。</li></ul>}</section>)}</div>
}

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

function SystemSettings({ notify, addAudit }: { notify: Notify; addAudit: (entry: string) => void }) {
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
  const current = items[selected]
  const CurrentIcon = current.icon
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft)
  const update = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => setDraft(currentDraft => ({ ...currentDraft, [key]: value }))
  const save = () => {
    setSaved(draft)
    addAudit(`保存系统设置草稿：${current.name}`)
    notify('配置已保存在当前会话；刷新页面后将恢复初始示例值。')
  }
  return <div className={`settings-layout ${collapsed ? 'directory-collapsed' : ''}`}><aside className={`card settings-directory ${collapsed ? 'collapsed' : ''}`}><div className="settings-dir-head"><b>配置目录</b><button className="icon-btn" title={collapsed ? '展开配置目录' : '收起配置目录'} aria-label={collapsed ? '展开配置目录' : '收起配置目录'} onClick={() => setCollapsed(value => !value)}>{collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button></div>{['AI 能力', '资源与集成', '安全与治理'].map(group => <div className="settings-group" key={group}><p>{group}</p>{items.map((item, index) => item.group === group && <button key={item.name} className={selected === index ? 'active' : ''} onClick={() => setSelected(index)}><item.icon /><span><b>{item.name}</b><small>{item.desc}</small></span><ChevronRight /></button>)}</div>)}</aside>
    <section className="card settings-editor"><div className="settings-editor-head"><div className="setting-symbol"><CurrentIcon /></div><div><h2>{current.name}</h2><p>{current.desc}</p></div><Badge tone={dirty ? 'orange' : 'green'}>{dirty ? '有未保存更改' : '会话内已保存'}</Badge><button className="btn primary" disabled={!dirty} onClick={save}><Check />保存配置</button></div>
      {selected === 0 && <ModelRoutingSettings draft={draft} update={update} />}
      {selected === 1 && <StaticSettings title="Prompt 模板" text="模板与 Agent 权限当前显示为本地示例；保存按钮可保存会话内草稿设置。" />}
      {selected === 2 && <div className="settings-form"><FormSection title="向量模型" desc="本地模拟远程 API 与本地模型运行状态"><VectorModelConfig notify={notify} /></FormSection><FormSection title="Markdown 切分" desc="修改后保存到当前会话草稿"><FormRow label="目标 Chunk 大小" help="建议范围 400～800 tokens"><select value={draft.chunkSize} onChange={event => update('chunkSize', event.target.value)}><option>400 tokens</option><option>600 tokens</option><option>800 tokens</option></select></FormRow><FormRow label="Chunk 重叠" help="保留相邻段落语义连续性"><select value={draft.chunkOverlap} onChange={event => update('chunkOverlap', event.target.value)}><option>40 tokens</option><option>80 tokens</option><option>120 tokens</option></select></FormRow></FormSection><FormSection title="检索与索引" desc="调整草稿并测试本地模拟索引"><RetrievalIndexConfig draft={draft} update={update} notify={notify} /></FormSection></div>}
      {selected === 3 && <div className="settings-form"><FormSection title="代码仓库" desc="当前仅保存本地草稿，不会连接仓库"><FormRow label="仓库地址" help="刷新页面后恢复示例地址"><input value={draft.repositoryUrl} onChange={event => update('repositoryUrl', event.target.value)} /></FormRow><FormRow label="默认分支" help="用于示例基线比较"><input value={draft.defaultBranch} onChange={event => update('defaultBranch', event.target.value)} /></FormRow></FormSection></div>}
      {selected === 4 && <StaticSettings title="访问控制" text="成员、角色和审批流程尚未接入服务端；当前页面仅展示本地原型说明。" />}
      {selected === 5 && <div className="settings-form"><FormSection title="数据安全" desc="安全策略可在本次会话中作为草稿保存"><SwitchRow title="启用完整审计" desc="记录当前会话中的本地模拟操作" checked={draft.auditEnabled} onChange={value => update('auditEnabled', value)} /></FormSection></div>}
    </section></div>
}

function StaticSettings({ title, text }: { title: string; text: string }) { return <div className="settings-form"><FormSection title={title} desc={text}><p className="readonly-notice">此项没有后端支撑，因此不伪造成功、连接或持久化状态。</p></FormSection></div> }

function ModelRoutingSettings({ draft, update }: { draft: SettingsDraft; update: <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => void }) {
  return <div className="settings-form"><FormSection title="默认模型" desc="仅保存本地配置草稿"><FormRow label="主分析模型" help="不发起真实模型调用"><select value={draft.mainModel} onChange={event => update('mainModel', event.target.value)}><option>GPT-5.2 · 推荐</option><option>私有模型</option></select></FormRow><FormRow label="模型温度" help="数值越低，输出结果越稳定"><div className="range-field"><input type="range" min="0" max="10" value={Math.round(draft.temperature * 10)} onChange={event => update('temperature', Number(event.target.value) / 10)} /><b>{draft.temperature.toFixed(1)}</b></div></FormRow></FormSection><FormSection title="路由与降级" desc="控制会话内草稿"><SwitchRow title="启用智能模型路由" desc="仅保存选择，不会调用模型服务" checked={draft.intelligentRouting} onChange={value => update('intelligentRouting', value)} /><SwitchRow title="AI 不可用时允许降级" desc="继续使用确定性示例资产" checked={draft.fallbackEnabled} onChange={value => update('fallbackEnabled', value)} /></FormSection></div>
}

function FormSection({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) { return <section className="form-section"><div className="form-section-title"><h3>{title}</h3>{desc && <p>{desc}</p>}</div><div>{children}</div></section> }
function FormRow({ label, help, children }: { label: string; help: string; children: ReactNode }) { return <label className="form-row"><span><b>{label}</b><small>{help}</small></span><div>{children}</div></label> }
function SwitchRow({ title, desc, checked, onChange }: { title: string; desc: string; checked: boolean; onChange: (value: boolean) => void }) { return <div className="form-row"><span><b>{title}</b><small>{desc}</small></span><label className="switch"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} aria-label={title} /><i /></label></div> }

function VectorModelConfig({ notify }: { notify: Notify }) {
  const [mode, setMode] = useState<'api' | 'local'>('api')
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [remoteModel, setRemoteModel] = useState('')
  const [connectionState, setConnectionState] = useState<JobStatus>('idle')
  const [localState, setLocalState] = useState<JobStatus>('idle')
  const [localProgress, setLocalProgress] = useState(0)
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => { if (timer.current) window.clearInterval(timer.current) }, [])
  const clear = () => { if (timer.current) window.clearInterval(timer.current); timer.current = undefined }
  const pullModel = () => {
    if (localState === 'completed') { clear(); setLocalState('idle'); setLocalProgress(0); notify('已停止本地模型模拟服务。'); return }
    clear(); setLocalState('running'); setLocalProgress(8)
    timer.current = window.setInterval(() => setLocalProgress(current => {
      const next = Math.min(current + 23, 100)
      if (next === 100) { clear(); setLocalState('completed'); notify('本地模型拉取模拟已完成；没有下载或启动真实模型。') }
      return next
    }), 500)
  }
  const cancelPull = () => { clear(); setLocalState('cancelled'); setLocalProgress(0); notify('已取消本地模型拉取模拟。') }
  const loadModels = () => { clear(); setConnectionState('running'); timer.current = window.setTimeout(() => { setModelsLoaded(true); setConnectionState('completed'); timer.current = undefined; notify('已生成本地模拟模型列表；未请求远程 API。') }, 450) }
  const testConnection = () => { clear(); setConnectionState('running'); timer.current = window.setTimeout(() => { setConnectionState('completed'); timer.current = undefined; notify('本地模拟连接测试完成；未发送任何凭据或网络请求。') }, 500) }
  const switchMode = (nextMode: 'api' | 'local') => {
    clear()
    if (localState === 'running') { setLocalState('cancelled'); setLocalProgress(0) }
    setConnectionState('idle')
    setMode(nextMode)
  }
  return <div className="vector-config"><div className="model-mode"><button className={mode === 'api' ? 'active' : ''} onClick={() => switchMode('api')}><Database />远程 API</button><button className={mode === 'local' ? 'active' : ''} onClick={() => switchMode('local')}><Download />本地模型</button></div>{mode === 'api' ? <div className="model-panel"><p className="readonly-notice">所有远程 API 结果均为本地模拟，不会读取、保存或发送凭据。</p><label><span>Base URL</span><input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="仅用于本地演示的服务地址" /></label><label><span>API Key</span><div className="key-fetch"><input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder="不会保存或发送" /><button className="btn ghost" disabled={connectionState === 'running'} onClick={loadModels}><Database />获取模型名称</button></div></label><label><span>选择模型</span><select value={remoteModel} onChange={event => setRemoteModel(event.target.value)}><option value="">{modelsLoaded ? '请选择向量模型' : '先生成本地模拟列表'}</option>{modelsLoaded && <><option value="text-embedding-3-small">text-embedding-3-small</option><option value="text-embedding-3-large">text-embedding-3-large</option></>}</select></label><div className="connection-test"><button className="btn ghost" disabled={!remoteModel || connectionState === 'running'} onClick={testConnection}><Activity />测试连接</button>{connectionState === 'completed' && <span><CheckCircle2 />本地模拟成功 · 未发起网络请求</span>}</div></div> : <div className="model-panel"><div className="local-runtime"><div className={`runtime-icon ${localState === 'running' ? 'pulling' : localState === 'completed' ? 'running' : ''}`}><Download /></div><span><b>{localState === 'running' ? '正在拉取本地模型模拟...' : localState === 'completed' ? '本地模型模拟已就绪' : localState === 'cancelled' ? '模型模拟已取消' : '模型尚未部署'}</b><small>{localState === 'completed' ? '未下载真实文件，也未启动真实服务。' : '操作仅演示本地进度状态。'}</small>{localState === 'running' && <Progress value={localProgress} />}</span><div className="runtime-actions">{localState === 'running' && <button className="btn danger" onClick={cancelPull}><XCircle />取消</button>}<button className="btn primary" disabled={localState === 'running'} onClick={pullModel}>{localState === 'completed' ? <><XCircle />停止模拟</> : <><Download />拉取并启动</>}</button></div></div></div>}</div>
}

function RetrievalIndexConfig({ draft, update, notify }: { draft: SettingsDraft; update: <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => void; notify: Notify }) {
  const [rerankerRunning, setRerankerRunning] = useState(false)
  const [rebuild, setRebuild] = useState<JobStatus>('idle')
  const [rebuildProgress, setRebuildProgress] = useState(0)
  const [testResult, setTestResult] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => { if (timer.current) window.clearInterval(timer.current) }, [])
  const stop = () => { if (timer.current) window.clearInterval(timer.current); timer.current = undefined }
  const startRebuild = () => {
    if (rebuild === 'running') return
    stop(); setRebuild('running'); setRebuildProgress(10)
    timer.current = window.setInterval(() => setRebuildProgress(current => {
      const next = Math.min(current + 18, 100)
      if (next === 100) { stop(); setRebuild('completed'); notify('索引重建本地模拟已完成，示例索引已切换到 V4。') }
      return next
    }), 550)
  }
  const cancelRebuild = () => { stop(); setRebuild('cancelled'); setRebuildProgress(0); notify('已取消索引重建本地模拟；V3 示例索引继续生效。') }
  return <div className="retrieval-config"><div className="retrieval-block"><div className="block-title"><div><b>混合检索</b><small>所有参数仅保存到当前会话草稿</small></div><label className="switch"><input type="checkbox" checked={draft.hybridSearch} onChange={event => update('hybridSearch', event.target.checked)} aria-label="启用混合检索" /><i /></label></div><div className="parameter-grid"><label><span>向量召回数量</span><select value={draft.vectorRecall} onChange={event => update('vectorRecall', event.target.value)}><option>30</option><option>40</option><option>50</option></select></label><label><span>全文召回数量</span><select value={draft.keywordRecall} onChange={event => update('keywordRecall', event.target.value)}><option>30</option><option>40</option><option>50</option></select></label><label><span>最终返回数量</span><select value={draft.finalResults} onChange={event => update('finalResults', event.target.value)}><option>5</option><option>8</option><option>10</option></select></label><label><span>最低相关度</span><div className="threshold"><input type="range" min="0" max="100" value={Math.round(draft.relevanceThreshold * 100)} onChange={event => update('relevanceThreshold', Number(event.target.value) / 100)} /><b>{draft.relevanceThreshold.toFixed(2)}</b></div></label></div></div><div className="retrieval-block"><div className="block-title"><div><b>Reranker 结果重排</b><small>模拟服务状态不连接真实模型</small></div><label className="switch"><input type="checkbox" checked={draft.rerankerEnabled} onChange={event => update('rerankerEnabled', event.target.checked)} aria-label="启用 Reranker" /><i /></label></div>{draft.rerankerEnabled && <div className="reranker-runtime"><span><b>{rerankerRunning ? '本地 Reranker 模拟服务正在运行' : '本地 Reranker 模拟服务未运行'}</b><small>不会下载模型或监听端口</small></span><button className={`btn ${rerankerRunning ? 'danger' : 'primary'}`} onClick={() => { setRerankerRunning(current => !current); notify(rerankerRunning ? '已停止本地 Reranker 模拟服务。' : '本地 Reranker 模拟服务已启动。') }}>{rerankerRunning ? <><XCircle />停止</> : <><Download />拉取并启动</>}</button></div>}</div><div className="retrieval-test"><div className="block-title"><div><b>测试检索</b><small>使用当前草稿生成本地示例结果</small></div></div><div className="test-query"><input value="退款请求如何保证幂等？" readOnly aria-label="测试检索查询" /><button className="btn primary" onClick={() => setTestResult(true)}><Search />开始测试</button></div>{testResult && <div className="test-results"><p><b>1</b><span><strong>退款处理规范 / 幂等控制</strong><small>本地模拟分数：向量 0.86 · 全文 0.74 · 重排 0.93</small></span><Badge tone="green">高相关</Badge></p></div>}</div><div className="index-rebuild"><div className="index-status"><div className={`index-icon ${rebuild === 'running' ? 'running' : rebuild === 'completed' ? 'done' : ''}`}><Database /></div><div><b>向量索引版本</b><strong>{rebuild === 'completed' ? 'V4' : 'V3'}</strong><Badge tone={rebuild === 'running' ? 'orange' : 'green'}>{rebuild === 'running' ? '本地重建中' : '示例当前生效'}</Badge><small>索引状态仅用于交互模拟</small></div></div>{rebuild === 'running' && <div className="rebuild-progress"><div><span>正在生成新版本向量</span><b>{rebuildProgress}%</b></div><Progress value={rebuildProgress} /><small>旧索引 V3 继续提供本地示例结果</small></div>}{rebuild === 'cancelled' && <div className="rebuild-notice"><AlertTriangle /><span><b>本地重建已取消</b><small>V3 示例索引未发生变化。</small></span></div>}{rebuild === 'completed' && <div className="rebuild-done"><CheckCircle2 /><span><b>本地重建完成</b><small>已模拟切换到 V4；没有写入真实索引。</small></span></div>}<div className="index-actions">{rebuild === 'running' && <button className="btn danger" onClick={cancelRebuild}><XCircle />取消</button>}<button className="btn primary" disabled={rebuild === 'running'} onClick={startRebuild}><RefreshCw className={rebuild === 'running' ? 'rotating' : ''} />{rebuild === 'completed' ? '重新构建' : '重建向量索引'}</button></div></div></div>
}

export default App
