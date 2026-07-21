import { useState, type ReactNode } from 'react'
import {
  Activity, AlertTriangle, Archive, Bell, BookOpen, Bot, BrainCircuit, Cloud,
  Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Clock3, Database, Download,
  Code2, Columns2, FileCode2, FileText, Folder, FolderOpen, Gauge, GitBranch, LayoutDashboard, Library,
  ListChecks, MessageSquareText, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Play, Plus, RefreshCw, Search, Settings,
  ShieldCheck, Sparkles, TestTube2, Upload, Users, XCircle, Zap,
} from 'lucide-react'

type PageKey = 'dashboard' | 'requirements' | 'documents' | 'design' | 'execution' | 'reports' | 'settings'

const menu: { key: PageKey; label: string; icon: typeof Gauge; hint?: string }[] = [
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
  return <div className="progress"><span className={tone} style={{ width: `${value}%` }} /></div>
}

function App() {
  const [page, setPage] = useState<PageKey>('dashboard')
  const [version, setVersion] = useState('V3.6')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [toast, setToast] = useState('')
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2200) }
  const meta = pageMeta[page]

  return <div className={`app-shell ${sidebarCollapsed ? 'shell-collapsed' : ''}`}>
    <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
      <div className="brand"><div className="brand-mark"><Zap size={19} fill="currentColor" /></div><div><b>SmartHub</b><span>AI TESTING PLATFORM</span></div><button className="sidebar-toggle" title={sidebarCollapsed?'展开导航':'收起导航'} onClick={()=>setSidebarCollapsed(!sidebarCollapsed)}>{sidebarCollapsed?<PanelLeftOpen/>:<PanelLeftClose/>}</button></div>
      <button className="project-picker" onClick={() => setVersion(version === 'V3.6' ? 'V3.5' : 'V3.6')}>
        <span className="project-logo">V</span><span><small>当前版本</small><strong>SmartHub · {version}</strong></span><ChevronDown size={15} />
      </button>
      <nav>
        <p className="nav-label nav-scope"><span>项目空间</span><em>按版本隔离</em></p>
        {menu.map(item => <button key={item.key} className={page === item.key ? 'active' : ''} onClick={() => setPage(item.key)}>
          <item.icon size={18} /><span>{item.label}</span>{item.hint && <em>{item.hint}</em>}
        </button>)}
        <p className="nav-label second nav-scope"><span>平台管理</span><em>全局</em></p>
        <button className={page === 'documents' ? 'active' : ''} onClick={() => setPage('documents')}><Library size={18} /><span>知识库</span></button>
        <button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}><Settings size={18} /><span>系统管理</span></button>
      </nav>
      <div className="sidebar-foot"><CircleHelp size={17} /><span>帮助与反馈</span><span className="version">v0.1</span></div>
    </aside>

    <main>
      <header className="topbar">
        <div className="search"><Search size={17} /><input aria-label="全局搜索" placeholder="搜索需求、用例、任务..." /><kbd>⌘ K</kbd></div>
        <div className="top-actions"><button title="AI 助手"><Sparkles size={18} /></button><button className="notification" title="通知"><Bell size={18} /><i /></button><div className="avatar">LS</div><div className="user"><b>李磊</b><span>测试负责人</span></div><ChevronDown size={14} /></div>
      </header>
      <section className="content">
        <div className="page-head"><div><h1>{meta.title}</h1><p>{meta.desc}</p></div>{page !== 'documents' && <div className="head-actions"><button className="btn ghost"><Clock3 size={16} />操作记录</button><button className="btn primary" onClick={() => notify(page === 'requirements' ? '已创建需求分析任务' : '已创建新任务')}><Plus size={17} />{page === 'requirements' ? '新建需求分析' : '新建任务'}</button></div>}</div>
        {page === 'dashboard' && <Dashboard navigate={setPage} notify={notify} />}
        {page === 'requirements' && <Requirements notify={notify} />}
        {page === 'documents' && <Documents notify={notify} />}
        {page === 'design' && <Design notify={notify} />}
        {page === 'execution' && <Execution notify={notify} />}
        {page === 'reports' && <Reports />}
        {page === 'settings' && <SystemSettings notify={notify} />}
      </section>
    </main>
    {toast && <div className="toast"><CheckCircle2 size={18} />{toast}</div>}
  </div>
}

function Dashboard({ navigate, notify }: { navigate: (p: PageKey) => void; notify: (s: string) => void }) {
  const stats = [
    { label: '需求覆盖率', value: '86.4%', delta: '↑ 4.2%', icon: ListChecks, tone: 'blue' },
    { label: '用例通过率', value: '92.8%', delta: '↑ 1.6%', icon: CheckCircle2, tone: 'green' },
    { label: '待审核资产', value: '23', delta: '需处理', icon: Clock3, tone: 'orange' },
    { label: '高风险问题', value: '5', delta: '2 个阻断', icon: AlertTriangle, tone: 'red' },
  ]
  return <>
    <div className="welcome"><div><Badge tone="violet"><Sparkles size={12} /> AI 每日洞察</Badge><h2>早上好，李磊</h2><p>支付重构项目有 <b>2 个高风险变更</b>，建议优先补充退款并发场景。</p><button onClick={() => navigate('requirements')}>查看分析详情 <ChevronRight size={15} /></button></div><div className="orb"><Bot size={42} /></div></div>
    <div className="stat-grid">{stats.map(s => <div className="stat-card" key={s.label}><div className={`stat-icon ${s.tone}`}><s.icon size={20} /></div><span>{s.label}</span><strong>{s.value}</strong><small className={s.tone}>{s.delta}</small></div>)}</div>
    <div className="dashboard-grid">
      <section className="card span2"><div className="card-head"><div><h3>质量趋势</h3><p>近 7 个版本测试通过率与缺陷变化</p></div><select><option>最近 7 个版本</option></select></div><div className="chart-wrap"><div className="y-labels"><span>100%</span><span>75%</span><span>50%</span><span>25%</span></div><svg viewBox="0 0 700 210" role="img" aria-label="质量趋势折线图"><defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#5b67f1" stopOpacity=".25"/><stop offset="1" stopColor="#5b67f1" stopOpacity="0"/></linearGradient></defs><path className="area" d="M0 142 C80 122 105 135 180 104 S290 118 350 83 S470 92 525 54 S630 65 700 31 L700 190 L0 190Z"/><path className="line" d="M0 142 C80 122 105 135 180 104 S290 118 350 83 S470 92 525 54 S630 65 700 31"/>{[0,116,233,350,466,583,700].map((x,i)=><circle key={x} cx={x} cy={[142,124,104,83,72,54,31][i]} r="4" />)}</svg><div className="x-labels">{['V3.0','V3.1','V3.2','V3.3','V3.4','V3.5','V3.6'].map(x=><span key={x}>{x}</span>)}</div></div></section>
      <section className="card"><div className="card-head"><div><h3>AI 任务</h3><p>当前运行与待处理任务</p></div><button className="icon-btn"><MoreHorizontal /></button></div><div className="task-list">
        <Task icon={BrainCircuit} title="需求智能分析" sub="支付模块重构 PRD" status="分析中 · 68%" value={68} />
        <Task icon={FileCode2} title="生成接口用例" sub="订单查询 API" status="排队中" value={12} tone="orange" />
        <Task icon={MessageSquareText} title="失败根因分析" sub="回归计划 #RP-0621" status="待审核" value={100} tone="green" />
      </div><button className="card-link" onClick={() => notify('AI 任务中心将在下一版展开')}>查看全部任务 <ChevronRight size={15} /></button></section>
      <section className="card"><div className="card-head"><div><h3>待办事项</h3><p>需要你关注的工作</p></div><Badge tone="orange">8 项</Badge></div><div className="todo-list">
        <Todo tone="red" title="审核高风险测试点" meta="支付模块重构 · 2 小时前" count="5" />
        <Todo tone="orange" title="确认需求歧义" meta="会员积分改版 · 昨天" count="3" />
        <Todo tone="blue" title="审批测试计划" meta="V3.6 回归计划 · 昨天" count="1" />
      </div></section>
      <section className="card span2"><div className="card-head"><div><h3>进行中的测试计划</h3><p>当前项目最近执行情况</p></div><button className="text-btn" onClick={() => navigate('execution')}>查看全部</button></div><table><thead><tr><th>计划名称</th><th>执行进度</th><th>通过率</th><th>环境</th><th>负责人</th><th>状态</th></tr></thead><tbody>
        <PlanRow name="V3.6 核心回归测试" progress={72} rate="94.2%" env="预发布" owner="李磊" status="执行中" />
        <PlanRow name="支付链路专项测试" progress={46} rate="89.7%" env="测试环境" owner="王敏" status="执行中" />
        <PlanRow name="会员中心冒烟测试" progress={100} rate="98.5%" env="集成环境" owner="陈晨" status="已完成" />
      </tbody></table></section>
    </div>
  </>
}

function Task({ icon: Icon, title, sub, status, value, tone='blue' }: any) { return <div className="task"><div className={`task-icon ${tone}`}><Icon size={17}/></div><div><b>{title}</b><span>{sub}</span><Progress value={value} tone={tone}/></div><small className={tone}>{status}</small></div> }
function Todo({ tone, title, meta, count }: any) { return <div className="todo"><i className={tone}/><div><b>{title}</b><span>{meta}</span></div><strong>{count}</strong><ChevronRight size={15}/></div> }
function PlanRow({ name, progress, rate, env, owner, status }: any) { return <tr><td><b>{name}</b></td><td><div className="table-progress"><Progress value={progress}/><span>{progress}%</span></div></td><td className="success">{rate}</td><td><Badge>{env}</Badge></td><td><span className="mini-avatar">{owner[0]}</span>{owner}</td><td><Badge tone={status === '已完成' ? 'green' : 'blue'}>{status}</Badge></td></tr> }

function Requirements({ notify }: { notify: (s:string)=>void }) {
  const [selected, setSelected] = useState(0)
  const [directoryCollapsed, setDirectoryCollapsed] = useState(false)
  const docs = ['支付模块重构需求', '会员积分体系升级', '订单导出体验优化', '优惠券叠加规则调整']
  return <div className={`split-layout ${directoryCollapsed?'directory-collapsed':''}`}><section className={`card side-list ${directoryCollapsed?'collapsed':''}`}><div className="filter-row"><div className="mini-search"><Search size={15}/><input placeholder="搜索需求" /></div><button className="icon-btn directory-toggle" onClick={()=>setDirectoryCollapsed(!directoryCollapsed)}>{directoryCollapsed?<PanelLeftOpen/>:<PanelLeftClose/>}</button><button className="icon-btn"><Plus/></button></div>{docs.map((d,i)=><button key={d} className={`doc-row ${selected===i?'selected':''}`} onClick={()=>setSelected(i)}><FileText size={18}/><span><b>{d}</b><small>REQ-2026-0{21+i} · {i===0?'分析中':'待分析'}</small></span>{i===0&&<i/>}</button>)}</section><section className="card requirement-main"><div className="document-title"><div><Badge tone="blue">需求 V2.3</Badge><h2>{docs[selected]}</h2><p>更新于 2026-07-20 · 张倩 · Markdown + 3 个附件</p></div><button className="btn primary" onClick={()=>notify('AI 分析任务已启动')}><Sparkles size={17}/>一键 AI 分析</button></div><div className="analysis-progress"><div className="spinner"><BrainCircuit size={22}/></div><div><b>AI 正在分析需求</b><span>正在结合知识库识别边界条件与潜在冲突...</span><Progress value={68}/></div><strong>68%</strong></div><div className="tabs"><button className="active">分析概览</button><button>原始文档</button><button>版本差异</button><button>功能树</button><button>证据引用</button></div><div className="analysis-grid"><div className="analysis-card"><span>结构化需求</span><strong>36</strong><small>已识别需求项</small></div><div className="analysis-card warning"><span>待确认问题</span><strong>7</strong><small>3 个高优先级</small></div><div className="analysis-card danger"><span>潜在风险</span><strong>5</strong><small>涉及支付与数据</small></div><div className="analysis-card success-card"><span>测试点建议</span><strong>84</strong><small>覆盖 7 类场景</small></div></div><div className="findings"><h3>重点分析结论</h3><Finding icon={AlertTriangle} tone="red" title="退款并发规则描述不完整" text="需求未明确同一订单多次退款请求的幂等处理与金额上限。" tag="需要确认"/><Finding icon={ShieldCheck} tone="orange" title="权限边界存在潜在缺口" text="财务角色与客服角色对退款详情的字段可见范围未定义。" tag="高风险"/><Finding icon={BookOpen} tone="blue" title="关联到历史业务规则" text="知识库中“支付网关规范 V4.2”要求所有退款请求携带唯一幂等键。" tag="有依据"/></div></section><aside className="ai-panel card"><div className="ai-head"><div className="ai-avatar"><Sparkles size={17}/></div><span><b>需求 AI 助手</b><small>基于当前需求上下文</small></span><MoreHorizontal size={18}/></div><div className="chat-empty"><div><Bot size={29}/></div><h3>有什么想进一步了解？</h3><p>我会基于当前需求和知识库回答，并标注引用来源。</p><button>帮我补充验收标准</button><button>列出所有异常场景</button><button>解释第 3 条风险</button></div><div className="chat-input"><textarea placeholder="针对当前需求提问..."/><button><Sparkles size={17}/></button></div></aside></div>
}
function Finding({icon:Icon,tone,title,text,tag}:any){return <div className="finding"><div className={`finding-icon ${tone}`}><Icon size={18}/></div><div><b>{title}</b><p>{text}</p></div><Badge tone={tone}>{tag}</Badge></div>}

function Documents({ notify }: { notify:(s:string)=>void }) {
  const files = [
    { name: '支付模块重构需求.md', path: '需求文档 / 支付模块重构需求.md', version: 'V2.3', updated: '2 分钟前', title: '支付模块重构需求', intro: '本次重构旨在统一支付、退款及回调处理链路，降低渠道接入成本，并提升异常场景下的数据一致性。', sections: ['项目背景', '业务目标', '功能范围', '退款处理规则', '验收标准'] },
    { name: '会员积分体系升级.md', path: '需求文档 / 会员积分体系升级.md', version: 'V1.6', updated: '昨天', title: '会员积分体系升级', intro: '升级积分获取、冻结、过期和抵扣规则，为不同会员等级提供差异化权益。', sections: ['需求背景', '积分生命周期', '等级权益', '异常处理', '验收标准'] },
    { name: '支付服务技术方案.md', path: '技术方案 / 支付服务 / 支付服务技术方案.md', version: 'V1.8', updated: '昨天', title: '支付服务技术方案', intro: '支付服务采用统一网关适配多渠道，通过事件驱动机制完成订单状态同步与最终一致性保障。', sections: ['整体架构', '模块设计', '数据模型', '接口定义', '容灾方案'] },
    { name: '接口错误码规范.md', path: '研发规范 / 接口错误码规范.md', version: 'V4.2', updated: '刚刚', title: '接口错误码规范', intro: '统一平台接口错误码组成、分类、返回结构及日志记录方式。', sections: ['编码规则', '错误分类', '响应结构', '使用示例', '检查清单'] },
    { name: '质量门禁规范.md', path: '测试规范 / 质量门禁规范.md', version: 'V3.1', updated: '5 天前', title: '质量门禁规范', intro: '定义各测试阶段的准入、准出条件以及阻断发布的质量指标。', sections: ['适用范围', '准入条件', '准出条件', '风险豁免', '审计要求'] },
  ]
  const [selected, setSelected] = useState(0)
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  const [outlineCollapsed, setOutlineCollapsed] = useState(false)
  const [viewMode, setViewMode] = useState<'preview'|'source'|'split'>('preview')
  const [imageOpen, setImageOpen] = useState(false)
  const file = files[selected]
  const source = `# ${file.title}\n\n${file.intro}\n\n> 文档说明：该文档已发布至正式知识库，AI 分析引用内容均可追溯到当前版本。\n\n## 1. ${file.sections[0]}\n\n随着业务规模持续增长，原有流程在扩展性、异常恢复和统一治理方面逐渐暴露出不足。本次调整将围绕核心链路完成能力升级。\n\n![统一支付与退款处理流程](assets/payment-flow.svg)\n\n## 2. ${file.sections[1]}\n\n- 统一核心流程及状态流转规则，减少重复实现。\n- 完善异常、超时和重试场景，确保数据最终一致。\n- 所有关键结论保留来源引用并支持版本追溯。\n\n## 3. ${file.sections[2]}\n\n| 能力模块 | 主要内容 | 优先级 |\n| --- | --- | --- |\n| 核心流程 | 主流程、状态流转与结果通知 | P0 |\n| 异常治理 | 超时、重试、幂等与补偿机制 | P1 |\n\n## 4. ${file.sections[3]}\n\n所有写入操作必须携带唯一业务标识。重复请求返回首次处理结果，不得重复改变业务状态。`
  return <section className="card knowledge-page">
    <div className="knowledge-toolbar">
      <div className="mini-search wide"><Search size={16}/><input placeholder="搜索文件名称或文档内容"/></div>
      <Badge tone="green"><CheckCircle2 size={12}/>知识库已同步</Badge>
      <button className="btn ghost" onClick={()=>notify('已发起知识库同步')}><GitBranch size={16}/>立即同步</button>
      <button className="btn primary" onClick={()=>notify('上传入口已打开（原型）')}><Upload size={16}/>上传文档</button>
    </div>
    <div className={`knowledge-layout ${treeCollapsed?'tree-collapsed':''}`}>
      <aside className={`file-tree ${treeCollapsed?'collapsed':''}`}>
        <div className="tree-title"><span>文件目录</span><button className="icon-btn" title={treeCollapsed?'展开文件树':'收起文件树'} onClick={()=>setTreeCollapsed(!treeCollapsed)}>{treeCollapsed?<PanelLeftOpen/>:<PanelLeftClose/>}</button></div>
        <div className="tree-root"><ChevronDown/><FolderOpen/><b>SmartHub 知识库</b><small>128</small></div>
        <div className="tree-folder"><ChevronDown/><FolderOpen/><span>需求文档</span><small>34</small></div>
        {files.slice(0,2).map((f,i)=><button className={`tree-file ${selected===i?'active':''}`} key={f.name} onClick={()=>setSelected(i)}><FileText/><span>{f.name}</span></button>)}
        <div className="tree-folder nested"><ChevronDown/><FolderOpen/><span>assets</span><small>3</small></div>
        <div className="tree-file deep asset-file"><FileCode2/><span>payment-flow.svg</span></div>
        <div className="tree-folder"><ChevronDown/><FolderOpen/><span>技术方案</span><small>26</small></div>
        <div className="tree-folder nested"><ChevronDown/><FolderOpen/><span>支付服务</span></div>
        <button className={`tree-file deep ${selected===2?'active':''}`} onClick={()=>setSelected(2)}><FileText/><span>{files[2].name}</span></button>
        <div className="tree-folder"><ChevronDown/><FolderOpen/><span>研发规范</span><small>31</small></div>
        <button className={`tree-file ${selected===3?'active':''}`} onClick={()=>setSelected(3)}><FileText/><span>{files[3].name}</span></button>
        <div className="tree-folder"><ChevronDown/><FolderOpen/><span>测试规范</span><small>37</small></div>
        <button className={`tree-file ${selected===4?'active':''}`} onClick={()=>setSelected(4)}><FileText/><span>{files[4].name}</span></button>
        <div className="tree-folder muted"><ChevronRight/><Folder/><span>历史归档</span><small>16</small></div>
      </aside>
      <article className={`document-preview ${outlineCollapsed?'outline-collapsed':''}`}>
        <div className="preview-head"><div className="breadcrumb"><Library size={14}/><span>{file.path}</span></div><div className="preview-actions"><Badge tone="green">已同步</Badge><div className="view-switch"><button className={viewMode==='preview'?'active':''} onClick={()=>setViewMode('preview')}><BookOpen/>预览</button><button className={viewMode==='source'?'active':''} onClick={()=>setViewMode('source')}><Code2/>源码</button><button className={viewMode==='split'?'active':''} onClick={()=>setViewMode('split')}><Columns2/>分屏</button></div><button className="btn ghost"><Clock3/>版本历史</button><button className="icon-btn" title={outlineCollapsed?'显示本文目录':'隐藏本文目录'} onClick={()=>setOutlineCollapsed(!outlineCollapsed)}>{outlineCollapsed?<PanelLeftOpen/>:<PanelLeftClose/>}</button><button className="icon-btn"><MoreHorizontal/></button></div></div>
        {viewMode === 'preview' ? <div className="markdown-view">
          <div className="document-meta"><Badge tone="blue">Markdown</Badge><span>版本 {file.version}</span><span>更新于 {file.updated}</span><span>1,286 字</span></div>
          <h1>{file.title}</h1>
          <p>{file.intro}</p>
          <div className="md-callout"><CircleHelp size={18}/><div><b>文档说明</b><span>该文档已发布至正式知识库，AI 分析引用内容均可追溯到当前版本。</span></div></div>
          <h2>1. {file.sections[0]}</h2><p>随着业务规模持续增长，原有流程在扩展性、异常恢复和统一治理方面逐渐暴露出不足。本次调整将围绕核心链路完成能力升级。</p>
          <figure className="md-image" onClick={()=>setImageOpen(true)}><img src="/assets/payment-flow.svg" alt="统一支付与退款处理流程"/><figcaption><span>图 1：统一支付与退款处理流程</span><em>点击查看原图</em></figcaption></figure>
          <h2>2. {file.sections[1]}</h2>
          <ul><li>统一核心流程及状态流转规则，减少重复实现。</li><li>完善异常、超时和重试场景，确保数据最终一致。</li><li>所有关键结论保留来源引用并支持版本追溯。</li></ul>
          <h2>3. {file.sections[2]}</h2>
          <table className="md-table"><thead><tr><th>能力模块</th><th>主要内容</th><th>优先级</th></tr></thead><tbody><tr><td>核心流程</td><td>主流程、状态流转与结果通知</td><td><Badge tone="red">P0</Badge></td></tr><tr><td>异常治理</td><td>超时、重试、幂等与补偿机制</td><td><Badge tone="orange">P1</Badge></td></tr></tbody></table>
          <h2>4. {file.sections[3]}</h2><p>所有写入操作必须携带唯一业务标识。重复请求返回首次处理结果，不得重复改变业务状态。</p>
        </div> : viewMode === 'source' ? <div className="source-view"><div className="source-gutter">{source.split('\n').map((_,i)=><span key={i}>{i+1}</span>)}</div><pre><code>{source}</code></pre></div> : <div className="split-view"><section className="split-pane source-pane"><header><Code2/>Markdown 源码</header><div className="source-view"><div className="source-gutter">{source.split('\n').map((_,i)=><span key={i}>{i+1}</span>)}</div><pre><code>{source}</code></pre></div></section><section className="split-pane rendered-pane"><header><BookOpen/>渲染预览</header><div className="split-markdown"><div className="document-meta"><Badge tone="blue">Markdown</Badge><span>版本 {file.version}</span></div><h1>{file.title}</h1><p>{file.intro}</p><div className="md-callout"><CircleHelp size={18}/><div><b>文档说明</b><span>该文档已发布至正式知识库。</span></div></div><h2>1. {file.sections[0]}</h2><p>随着业务规模持续增长，原有流程在扩展性、异常恢复和统一治理方面逐渐暴露出不足。</p><figure className="md-image" onClick={()=>setImageOpen(true)}><img src="/assets/payment-flow.svg" alt="统一支付与退款处理流程"/><figcaption><span>图 1：统一支付与退款处理流程</span><em>点击查看原图</em></figcaption></figure><h2>2. {file.sections[1]}</h2><ul><li>统一核心流程及状态流转规则。</li><li>完善异常、超时和重试场景。</li><li>保留来源引用并支持版本追溯。</li></ul><h2>3. {file.sections[2]}</h2><table className="md-table"><tbody><tr><td>核心流程</td><td>状态流转与结果通知</td></tr><tr><td>异常治理</td><td>超时、重试与补偿机制</td></tr></tbody></table></div></section></div>}
        {viewMode === 'preview' && <nav className="document-outline"><b>本文目录</b>{file.sections.map((s,i)=><a key={s} className={i===0?'active':''}>{i+1}. {s}</a>)}</nav>}
      </article>
    </div>
    {imageOpen && <div className="image-lightbox" onClick={()=>setImageOpen(false)}><button aria-label="关闭原图"><XCircle/></button><div onClick={e=>e.stopPropagation()}><img src="/assets/payment-flow.svg" alt="统一支付与退款处理流程原图"/><p>统一支付与退款处理流程 · assets/payment-flow.svg</p></div></div>}
  </section>
}

function Design({notify}:{notify:(s:string)=>void}) { return <div className="design-layout"><section className="card trace-tree"><h3>需求追踪树</h3><div className="tree-item root"><ChevronDown/><FileText/>支付模块重构 <Badge tone="blue">86%</Badge></div><div className="tree-item l1 active"><ChevronDown/><ListChecks/>退款流程 <span>12</span></div>{['正常退款','部分退款','重复退款','超时与重试'].map((x,i)=><div className="tree-item l2" key={x}><span className={`dot d${i}`}/>{x}<small>{[4,3,2,3][i]}</small></div>)}<div className="tree-item l1"><ChevronRight/><ListChecks/>支付回调 <span>8</span></div><div className="tree-item l1"><ChevronRight/><ListChecks/>对账与补偿 <span>6</span></div></section><section className="card case-board"><div className="card-head"><div><h3>退款流程 · 测试点</h3><p>12 个测试点，覆盖率 83%</p></div><button className="btn primary" onClick={()=>notify('已生成 6 条测试用例草稿')}><Sparkles/>AI 生成用例</button></div><div className="coverage"><span>场景覆盖</span>{['主流程 100%','异常 75%','边界 66%','权限 50%'].map((x,i)=><Badge key={x} tone={['green','blue','orange','red'][i]}>{x}</Badge>)}</div>{['全额退款成功，原路退回','部分退款金额边界校验','重复退款请求幂等处理','退款超时后的状态补偿','无权限用户发起退款'].map((x,i)=><div className="case-row" key={x}><input type="checkbox" defaultChecked={i<3}/><span><b>{x}</b><small>TP-{String(i+1).padStart(3,'0')} · {i<2?'P0':'P1'} · AI 生成</small></span><Badge tone={i===2?'orange':i===4?'red':'green'}>{i===2?'待审核':i===4?'有风险':'已通过'}</Badge><button className="icon-btn"><MoreHorizontal/></button></div>)}</section><aside className="card coverage-card"><h3>覆盖矩阵</h3><div className="donut"><div><strong>83%</strong><span>总覆盖率</span></div></div><div className="legend"><p><i className="green"/>已覆盖 <b>24</b></p><p><i className="orange"/>部分覆盖 <b>5</b></p><p><i className="gray"/>未覆盖 <b>3</b></p></div><button className="btn ghost full">查看完整矩阵</button></aside></div> }

function Execution({notify}:{notify:(s:string)=>void}) { return <><div className="execution-summary"><div><span className="pulse"><Play size={18} fill="currentColor"/></span><p><b>V3.6 核心回归测试</b><small>RUN-20260721-0832 · 预发布环境</small></p></div><div className="run-number"><strong>168</strong><span>总用例</span></div><div className="run-number green"><strong>132</strong><span>已通过</span></div><div className="run-number red"><strong>8</strong><span>失败</span></div><div className="run-number"><strong>28</strong><span>执行中/等待</span></div><button className="btn ghost" onClick={()=>notify('执行任务已暂停')}><span className="pause">Ⅱ</span> 暂停执行</button></div><div className="dashboard-grid"><section className="card span2"><div className="card-head"><div><h3>套件执行状态</h3><p>整体进度 83% · 预计剩余 18 分钟</p></div><Badge tone="blue">执行中</Badge></div>{[['用户登录与鉴权',100,'56 / 56','green'],['订单主流程',92,'44 / 48','blue'],['支付与退款',68,'25 / 36','orange'],['会员与优惠券',41,'17 / 28','blue']].map(x=><div className="suite" key={String(x[0])}><div className={`suite-icon ${x[3]}`}><TestTube2/></div><div><b>{x[0]}</b><Progress value={Number(x[1])} tone={String(x[3])}/></div><span>{x[2]}</span><strong>{x[1]}%</strong><ChevronRight/></div>)}</section><section className="card"><div className="card-head"><div><h3>实时活动</h3><p>最近执行事件</p></div><span className="live">LIVE</span></div>{[['green','退款申请成功','通过 · 10:42:18'],['red','重复退款幂等校验','失败 · 10:42:06'],['blue','会员等级刷新','执行中 · 10:41:57'],['green','优惠券核销','通过 · 10:41:49']].map(x=><div className="event" key={x[1]}><i className={x[0]}/><span><b>{x[1]}</b><small>{x[2]}</small></span></div>)}</section></div></> }

function Reports(){ return <div className="report-grid"><section className="card release-card"><Badge tone="orange"><AlertTriangle/> 有条件通过</Badge><h2>V3.6 发布质量评估</h2><p>核心链路整体稳定，但退款并发和弱网重试仍有 2 个高风险问题。建议修复阻断问题并完成定向回归后发布。</p><div className="score"><strong>82</strong><span>/ 100<br/>质量评分</span></div><button className="btn primary">查看完整报告</button></section><section className="card"><div className="card-head"><div><h3>缺陷分布</h3><p>按严重程度统计</p></div></div><div className="bar-stats"><div><span>阻断</span><Progress value={16} tone="red"/><b>2</b></div><div><span>严重</span><Progress value={42} tone="orange"/><b>5</b></div><div><span>一般</span><Progress value={75}/><b>9</b></div><div><span>提示</span><Progress value={33} tone="green"/><b>4</b></div></div></section><section className="card wide-report"><div className="card-head"><div><h3>失败聚类与根因建议</h3><p>AI 已将 8 个失败归为 3 个问题簇</p></div><button className="text-btn">查看诊断详情</button></div>{[['FC-018','重复退款导致状态覆盖','4 个失败','疑似幂等锁过早释放','高'],['FC-017','弱网环境支付回调超时','3 个失败','回调重试间隔配置异常','中'],['FC-016','测试数据污染','1 个失败','共享账号存在历史余额','低']].map((x,i)=><div className="cluster" key={x[0]}><div className={`cluster-icon c${i}`}><GitBranch/></div><span><b>{x[1]}</b><small>{x[0]} · {x[2]}</small></span><p>{x[3]}</p><Badge tone={['red','orange','green'][i]}>置信度{x[4]}</Badge><ChevronRight/></div>)}</section></div> }

function SystemSettings({notify}:{notify:(s:string)=>void}){
  const items=[
    {name:'AI 模型与路由',desc:'大模型、Embedding 与路由策略',icon:Bot,group:'AI 能力'},
    {name:'Prompt 与 Agent',desc:'分析模板、工具和版本管理',icon:Sparkles,group:'AI 能力'},
    {name:'知识库配置',desc:'同步、切分与检索策略',icon:BookOpen,group:'资源与集成'},
    {name:'代码与流水线',desc:'Git、CI/CD 与执行器',icon:GitBranch,group:'资源与集成'},
    {name:'用户与权限',desc:'成员、角色与审批流程',icon:Users,group:'安全与治理'},
    {name:'环境与安全',desc:'密钥、数据保留与审计',icon:ShieldCheck,group:'安全与治理'},
  ]
  const [selected,setSelected]=useState(0)
  const [collapsed,setCollapsed]=useState(false)
  const current=items[selected]
  const CurrentIcon=current.icon
  return <div className={`settings-layout ${collapsed?'directory-collapsed':''}`}>
    <aside className={`card settings-directory ${collapsed?'collapsed':''}`}>
      <div className="settings-dir-head"><b>配置目录</b><button className="icon-btn" title={collapsed?'展开配置目录':'收起配置目录'} onClick={()=>setCollapsed(!collapsed)}>{collapsed?<PanelLeftOpen/>:<PanelLeftClose/>}</button></div>
      {['AI 能力','资源与集成','安全与治理'].map(group=><div className="settings-group" key={group}><p>{group}</p>{items.map((item,i)=>item.group===group&&<button key={item.name} className={selected===i?'active':''} onClick={()=>setSelected(i)}><item.icon/><span><b>{item.name}</b><small>{item.desc}</small></span><ChevronRight/></button>)}</div>)}
    </aside>
    <section className="card settings-editor">
      <div className="settings-editor-head"><div className="setting-symbol"><CurrentIcon/></div><div><h2>{current.name}</h2><p>{current.desc}</p></div><Badge tone="green"><CheckCircle2/>配置正常</Badge><button className="btn primary" onClick={()=>notify(`${current.name}已保存`)}><Check/>保存配置</button></div>
      {selected===0&&<div className="settings-form"><FormSection title="默认模型" desc="平台 AI 任务使用的模型及调用参数"><FormRow label="主分析模型" help="用于需求分析、测试设计与根因诊断"><select><option>GPT-5.2 · 推荐</option><option>私有模型</option></select></FormRow><FormRow label="模型温度" help="数值越低，输出结果越稳定"><div className="range-field"><input type="range" min="0" max="10" defaultValue="2"/><b>0.2</b></div></FormRow></FormSection><FormSection title="路由与降级" desc="控制多模型路由和服务异常时的处理方式"><SwitchRow title="启用智能模型路由" desc="根据任务复杂度、数据级别和成本自动选择模型"/><SwitchRow title="AI 不可用时允许降级" desc="继续使用已批准的确定性测试资产"/></FormSection></div>}
      {selected===1&&<div className="settings-form"><FormSection title="Prompt 模板" desc="管理不同 AI 任务使用的指令模板"><FormRow label="默认需求分析模板" help="当前已发布版本 V3.2"><select><option>企业需求分析标准模板</option></select></FormRow><FormRow label="测试用例生成模板" help="当前已发布版本 V2.6"><select><option>全场景测试设计模板</option></select></FormRow></FormSection><FormSection title="Agent 工具权限" desc="限制 Agent 可以调用的外部工具"><SwitchRow title="知识库检索" desc="允许 Agent 在授权知识库中检索证据"/><SwitchRow title="代码仓库只读访问" desc="允许读取分支、提交及代码 Diff"/></FormSection></div>}
      {selected===2&&<div className="settings-form"><FormSection title="向量模型" desc="配置远程 Embedding API，或从云端拉取模型后在本机运行"><VectorModelConfig notify={notify}/></FormSection><FormSection title="Markdown 切分" desc="设置文档结构化切分规则"><FormRow label="目标 Chunk 大小" help="建议范围 400～800 tokens"><select><option>600 tokens</option></select></FormRow><FormRow label="Chunk 重叠" help="保留相邻段落语义连续性"><select><option>80 tokens</option></select></FormRow></FormSection><FormSection title="检索与索引" desc="配置混合检索、结果重排和向量索引版本"><RetrievalIndexConfig notify={notify}/></FormSection></div>}
      {selected===3&&<div className="settings-form"><FormSection title="代码仓库" desc="连接平台唯一项目的 Git 仓库"><FormRow label="仓库地址" help="使用最小权限的只读凭据"><input defaultValue="https://git.example.com/smarthub.git"/></FormRow><FormRow label="默认分支" help="用于变更基线比较"><input defaultValue="main"/></FormRow></FormSection><FormSection title="流水线执行"><SwitchRow title="允许流水线触发测试计划" desc="接收来自受信 CI/CD 系统的执行请求"/><SwitchRow title="上传执行产物" desc="采集日志、截图、视频与 Trace"/></FormSection></div>}
      {selected===4&&<div className="settings-form"><FormSection title="访问控制" desc="平台用户、角色及授权策略"><FormRow label="默认新用户角色" help="首次登录后授予的最低权限"><select><option>只读人员</option><option>测试工程师</option></select></FormRow><SwitchRow title="启用审批流程" desc="生产执行与正式资产发布必须经过审批"/><SwitchRow title="强制最小权限" desc="Agent 服务账号仅获得任务所需权限"/></FormSection></div>}
      {selected===5&&<div className="settings-form"><FormSection title="数据安全" desc="平台敏感数据与凭据保护策略"><SwitchRow title="日志自动脱敏" desc="隐藏密钥、Token、手机号等敏感信息"/><SwitchRow title="启用完整审计" desc="记录 AI 输入、输出、依据、审核和工具调用"/><FormRow label="数据保留周期" help="到期后按照策略自动归档或清理"><select><option>365 天</option><option>180 天</option></select></FormRow></FormSection></div>}
    </section>
  </div>
}
function FormSection({title,desc,children}:{title:string;desc?:string;children:ReactNode}){return <section className="form-section"><div className="form-section-title"><h3>{title}</h3>{desc&&<p>{desc}</p>}</div><div>{children}</div></section>}
function FormRow({label,help,children}:{label:string;help:string;children:ReactNode}){return <label className="form-row"><span><b>{label}</b><small>{help}</small></span><div>{children}</div></label>}
function SwitchRow({title,desc}:{title:string;desc:string}){return <div className="form-row"><span><b>{title}</b><small>{desc}</small></span><label className="switch"><input type="checkbox" defaultChecked/><i/></label></div>}
function VectorModelConfig({notify}:{notify:(s:string)=>void}){
  const [mode,setMode]=useState<'api'|'local'>('api')
  const [modelsLoaded,setModelsLoaded]=useState(false)
  const [remoteModel,setRemoteModel]=useState('')
  const [connectionTested,setConnectionTested]=useState(false)
  const [localStatus,setLocalStatus]=useState<'idle'|'pulling'|'running'>('idle')
  const [advanced,setAdvanced]=useState(false)
  const pullModel=()=>{setLocalStatus('pulling');notify('正在从云端拉取向量模型');window.setTimeout(()=>{setLocalStatus('running');notify('BGE-M3 已启动运行')},1800)}
  return <div className="vector-config">
    <div className="model-mode"><button className={mode==='api'?'active':''} onClick={()=>setMode('api')}><Cloud/>远程 API</button><button className={mode==='local'?'active':''} onClick={()=>setMode('local')}><Download/>本地模型</button></div>
    {mode==='api'&&<div className="model-safety"><div className="compliance-confirm"><ShieldCheck/><span><b>云端数据合规确认</b><small>文档切片将发送到外部模型服务，请确认当前知识库允许使用云端 Embedding。</small></span><label className="switch"><input type="checkbox" defaultChecked/><i/></label></div><div className="connection-test"><button className="btn ghost" disabled={!remoteModel} onClick={()=>{setConnectionTested(true);notify('测试 Embedding 调用成功')}}><Activity/>测试连接与向量维度</button>{connectionTested&&<span><CheckCircle2/>调用成功 · 182 ms · 维度 1536</span>}</div></div>}
    {mode==='local'&&<div className="preflight"><b>运行前检查</b><span><CheckCircle2/>磁盘空间 86 GB</span><span><CheckCircle2/>CUDA 12.4</span><span><CheckCircle2/>端口 8091 可用</span><Badge tone="green">检查通过</Badge></div>}
    {mode==='api'?<div className="model-panel"><label><span>Base URL</span><input defaultValue="https://api.openai.com/v1" placeholder="请输入兼容 OpenAI 协议的服务地址"/></label><label><span>API Key</span><div className="key-fetch"><input type="password" defaultValue="sk-prototype-key"/><button className="btn ghost" onClick={()=>{setModelsLoaded(true);setRemoteModel('text-embedding-3-small');notify('已获取 3 个可用向量模型')}}><Cloud/>获取模型名称</button></div></label><label><span>选择模型</span><select value={remoteModel} onChange={e=>setRemoteModel(e.target.value)}><option value="">{modelsLoaded?'请选择向量模型':'可获取模型名称或使用自定义模型'}</option>{modelsLoaded&&<><option value="text-embedding-3-small">text-embedding-3-small</option><option value="text-embedding-3-large">text-embedding-3-large</option><option value="embedding-v2">embedding-v2</option></>}<option value="custom">自定义模型名称...</option></select></label>{remoteModel==='custom'&&<label className="custom-model-row"><span>自定义模型</span><div><input placeholder="例如：bge-m3-embedding" autoFocus/><small>直接填写服务端使用的模型标识，无需依赖模型列表接口。</small></div></label>}{modelsLoaded&&<div className="model-result"><CheckCircle2/><span><b>连接成功</b><small>已读取可用模型列表，向量维度将在首次调用时自动校验。</small></span></div>}</div>:<div className="model-panel"><label><span>云端模型源</span><select><option>ModelScope 魔搭社区</option><option>Hugging Face</option><option>企业模型仓库</option></select></label><label><span>选择本地模型</span><select><option>BAAI / BGE-M3 · 推荐</option><option>BAAI / bge-large-zh-v1.5</option><option>moka-ai / m3e-base</option></select></label><button className={`advanced-toggle ${advanced?'open':''}`} onClick={()=>setAdvanced(!advanced)}><Settings/><span><b>高级选项</b><small>默认采用系统自动配置</small></span><ChevronDown/></button>{advanced&&<div className="advanced-options"><label><span>运行设备</span><select><option>自动选择（推荐）</option><option>NVIDIA GPU</option><option>仅使用 CPU</option></select></label><label><span>最大并发</span><select><option>自动</option><option>2</option><option>4</option><option>8</option></select></label><label><span>批处理大小</span><select><option>自动</option><option>16</option><option>32</option><option>64</option></select></label></div>}<div className="local-runtime"><div className={`runtime-icon ${localStatus}`}><Download/></div><span><b>{localStatus==='running'?'BGE-M3 正在运行':localStatus==='pulling'?'正在拉取模型数据...':'模型尚未部署'}</b><small>{localStatus==='running'?'本地服务：http://127.0.0.1:8091 · 维度 1024':localStatus==='pulling'?'正在下载权重与配置文件，完成后自动启动服务':'预计下载 2.3 GB，模型数据将保存到系统默认目录'}</small>{localStatus==='pulling'&&<Progress value={64}/>}</span><div className="runtime-actions">{localStatus==='running'&&<button className="btn danger" onClick={()=>{setLocalStatus('idle');notify('本地向量模型服务已停止')}}><XCircle/>停止服务</button>}<button className="btn primary" disabled={localStatus==='pulling'} onClick={pullModel}>{localStatus==='running'?<><Activity/>重启服务</>:<><Download/>拉取并启动</>}</button></div></div><div className="runtime-info"><div className="runtime-info-head"><span><Activity/>运行信息</span><Badge tone={localStatus==='running'?'green':localStatus==='pulling'?'orange':'gray'}>{localStatus==='running'?'服务健康':localStatus==='pulling'?'准备中':'未运行'}</Badge></div><div className="runtime-info-grid"><p><span>运行设备</span><b>{localStatus==='running'?'NVIDIA RTX 4060':'自动检测'}</b></p><p><span>模型版本</span><b>BAAI/bge-m3</b></p><p><span>向量维度</span><b>1024</b></p><p><span>模型大小</span><b>2.3 GB</b></p><p><span>内存占用</span><b>{localStatus==='running'?'3.1 GB':'—'}</b></p><p><span>本地服务</span><b>{localStatus==='running'?'127.0.0.1:8091':'—'}</b></p></div></div></div>}
  </div>
}
function RetrievalIndexConfig({notify}:{notify:(s:string)=>void}){
  const [reranker,setReranker]=useState(true)
  const [rerankerMode,setRerankerMode]=useState<'local'|'remote'>('local')
  const [rerankerRunning,setRerankerRunning]=useState(false)
  const [rebuild,setRebuild]=useState<'idle'|'running'|'done'>('idle')
  const [testResult,setTestResult]=useState(false)
  const startRebuild=()=>{setRebuild('running');notify('向量索引重建任务已启动');window.setTimeout(()=>{setRebuild('done');notify('向量索引 V4 重建完成')},2200)}
  return <div className="retrieval-config">
    <div className="retrieval-block"><div className="block-title"><div><b>混合检索</b><small>结合向量语义和全文关键词，提高专业术语与错误码召回率</small></div><Badge tone="green">推荐开启</Badge><label className="switch"><input type="checkbox" defaultChecked/><i/></label></div><div className="parameter-grid"><label><span>向量召回数量</span><select defaultValue="40"><option>30</option><option>40</option><option>50</option></select></label><label><span>全文召回数量</span><select defaultValue="40"><option>30</option><option>40</option><option>50</option></select></label><label><span>最终返回数量</span><select defaultValue="8"><option>5</option><option>8</option><option>10</option></select></label><label><span>最低相关度</span><div className="threshold"><input type="range" min="0" max="100" defaultValue="62"/><b>0.62</b></div></label></div></div>
    <div className="retrieval-block"><div className="block-title"><div><b>Reranker 结果重排</b><small>独立于向量模型，对候选文档进行二次相关性评分</small></div><label className="switch"><input type="checkbox" checked={reranker} onChange={e=>setReranker(e.target.checked)}/><i/></label></div>{reranker&&<div className="reranker-config"><div className="reranker-mode"><button className={rerankerMode==='local'?'active':''} onClick={()=>setRerankerMode('local')}>本地模型</button><button className={rerankerMode==='remote'?'active':''} onClick={()=>setRerankerMode('remote')}>远程 API</button></div>{rerankerMode==='local'?<><div className="reranker-fields"><label><span>模型来源</span><select><option>ModelScope 魔搭社区</option><option>Hugging Face</option></select></label><label><span>重排模型</span><select><option>BAAI / bge-reranker-v2-m3</option><option>bge-reranker-large</option></select></label></div><div className="reranker-runtime"><span><b>{rerankerRunning?'重排服务正在运行':'重排模型尚未运行'}</b><small>{rerankerRunning?'服务健康 · 内存占用 2.1 GB':'预计下载 1.2 GB，使用系统默认模型目录'}</small></span>{rerankerRunning?<button className="btn danger" onClick={()=>setRerankerRunning(false)}><XCircle/>停止</button>:<button className="btn primary" onClick={()=>{setRerankerRunning(true);notify('本地 Reranker 已拉取并启动')}}><Download/>拉取并启动</button>}</div></>:<div className="reranker-remote"><label><span>连接配置</span><select><option>复用向量模型 Base URL 与 API Key</option><option>独立远程服务</option></select></label><label><span>模型名称</span><input defaultValue="bge-reranker-v2-m3" placeholder="支持自定义模型标识"/></label><button className="btn ghost" onClick={()=>notify('Reranker 远程连接测试成功')}><Activity/>测试连接</button></div>}</div>}</div>
    <div className="retrieval-test"><div className="block-title"><div><b>测试检索</b><small>使用当前草稿配置查看召回来源、分数和重排效果</small></div></div><div className="test-query"><input defaultValue="退款请求如何保证幂等？"/><button className="btn primary" onClick={()=>setTestResult(true)}><Search/>开始测试</button></div>{testResult&&<div className="test-results"><p><b>1</b><span><strong>退款处理规范 / 幂等控制</strong><small>向量 0.86 · 全文 0.74 · 重排 0.93 · 第 42–58 行</small></span><Badge tone="green">高相关</Badge></p><p><b>2</b><span><strong>支付服务技术方案 / 异常补偿</strong><small>向量 0.78 · 全文 0.69 · 重排 0.84 · 第 116–132 行</small></span><Badge tone="blue">相关</Badge></p></div>}</div>
    <div className="index-rebuild"><div className="index-status"><div className={`index-icon ${rebuild}`}><Database/></div><div><b>向量索引版本</b><strong>{rebuild==='done'?'V4':'V3'}</strong><Badge tone={rebuild==='running'?'orange':'green'}>{rebuild==='running'?'重建中':'当前生效'}</Badge><small>模型：text-embedding-3-small · 128 个文档 · 3,842 个 Chunk</small></div></div>{rebuild==='idle'&&<div className="rebuild-notice"><AlertTriangle/><span><b>配置变更将触发索引重建</b><small>检测到 Chunk 参数有未应用变更，预计处理 128 个文档，重建期间继续使用 V3。</small></span></div>}{rebuild==='running'&&<div className="rebuild-progress"><div><span>正在生成新版本向量</span><b>64%</b></div><Progress value={64}/><small>已处理 82 / 128 个文档 · 旧索引 V3 仍在提供检索</small></div>}{rebuild==='done'&&<div className="rebuild-done"><CheckCircle2/><span><b>索引重建完成</b><small>已原子切换至 V4，旧版本将在保留期后自动清理。</small></span></div>}<button className="btn primary" disabled={rebuild==='running'} onClick={startRebuild}><RefreshCw className={rebuild==='running'?'rotating':''}/>{rebuild==='running'?'正在重建':rebuild==='done'?'重新构建':'重建向量索引'}</button></div>
  </div>
}

export default App
