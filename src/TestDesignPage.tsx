import { useMemo, useState, type ReactNode } from 'react'
import {
  AlertTriangle, ArchiveRestore, ArrowDown, ArrowRight, ArrowUp, Bot, Braces, Check,
  CheckCircle2, ChevronDown, ChevronRight, CircleDot, Clock3, Database, Download,
  FileDiff, FileJson2, FileText, Filter, GitBranch, History, Layers3, Link2, ListChecks,
  LockKeyhole, MoreHorizontal, Network, PanelRightClose, Pencil, Play, Plus, RefreshCw,
  Search, ShieldCheck, Sparkles, Split, TableProperties, TestTube2, Trash2, Users,
  X, XCircle,
} from 'lucide-react'
import type { ProjectVersion } from './project-version-api'
import './test-design.css'
import './test-design-collection.css'

type NotifyTone = 'success' | 'error' | 'warning'
type Notify = (message: string, tone?: NotifyTone) => void
type BasisMode = 'review_baseline' | 'knowledge_assets'
type ViewMode = 'list' | 'create' | 'workspace'
type CollectionView = 'designs' | 'library' | 'sets'
type TabKey = 'overview' | 'workflow' | 'analysis' | 'retrieval' | 'tree' | 'cases' | 'case-set' | 'data' | 'coverage' | 'history' | 'questions'
type ExecutionMethod = 'UI' | 'API'

type Props = {
  projectVersion: ProjectVersion | null
  onManageVersions: () => void
  notify: Notify
}

type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

const tabKeys: TabKey[] = ['overview', 'workflow', 'analysis', 'retrieval', 'tree', 'cases', 'case-set', 'data', 'coverage', 'history', 'questions']

const tabs: Array<{ key: TabKey; label: string; count?: number }> = [
  { key: 'overview', label: '概览' },
  { key: 'workflow', label: '工作流' },
  { key: 'analysis', label: '依据解构', count: 18 },
  { key: 'retrieval', label: '知识召回', count: 12 },
  { key: 'tree', label: '测试点树', count: 46 },
  { key: 'cases', label: '测试用例', count: 28 },
  { key: 'case-set', label: '用例集', count: 1 },
  { key: 'data', label: '测试数据', count: 9 },
  { key: 'coverage', label: '覆盖审计', count: 3 },
  { key: 'history', label: '历史复用', count: 6 },
  { key: 'questions', label: '待确认项', count: 2 },
]

const stages = [
  { label: '依据解构与知识召回', state: 'done' },
  { label: '测试点智能发散', state: 'done' },
  { label: '测试用例具象化', state: 'done' },
  { label: '测试数据资产定义', state: 'done' },
  { label: '覆盖反向审计', state: 'active' },
]

const basisItems = [
  { id: 'REQ-018', kind: '需求点', title: '用户可通过账号密码登录系统', source: '需求评审 · RP-018', status: '已覆盖' },
  { id: 'REQ-021', kind: '需求点', title: '连续失败后触发账户保护策略', source: '需求评审 · RP-021', status: '部分覆盖' },
  { id: 'REQ-024', kind: '需求点', title: '登录态在多端保持一致', source: '需求评审 · RP-024', status: '已覆盖' },
  { id: 'SOL-008', kind: '方案要点', title: '认证令牌采用双 Token 轮换机制', source: '技术方案 · SP-008', status: '已覆盖' },
  { id: 'SOL-012', kind: '方案要点', title: '登录审计事件异步写入消息队列', source: '技术方案 · SP-012', status: '待确认' },
  { id: 'FND-006', kind: '风险', title: '弱网下重复提交可能触发并发刷新', source: '技术方案 Finding', status: '部分覆盖' },
]

const treeNodes = [
  { id: 'TP-001', level: 0, title: '身份认证', count: 18, priority: 'P0', method: 'UI + API', expanded: true },
  { id: 'TP-003', level: 1, title: '账号密码登录', count: 7, priority: 'P0', method: 'UI', expanded: true },
  { id: 'TP-008', level: 2, title: '有效账号完成登录', count: 2, priority: 'P0', method: 'UI' },
  { id: 'TP-009', level: 2, title: '错误密码提示与重试', count: 3, priority: 'P0', method: 'UI' },
  { id: 'TP-010', level: 2, title: '表单边界与防重复提交', count: 2, priority: 'P1', method: 'UI' },
  { id: 'TP-004', level: 1, title: '账户保护', count: 6, priority: 'P0', method: 'API', expanded: false },
  { id: 'TP-005', level: 1, title: '令牌轮换', count: 5, priority: 'P1', method: 'API', expanded: false },
  { id: 'TP-002', level: 0, title: '可靠性与安全', count: 12, priority: 'P1', method: 'UI + API', expanded: false },
  { id: 'TP-006', level: 0, title: '兼容性', count: 8, priority: 'P2', method: 'UI', expanded: false },
]

const cases = [
  { id: 'TC-AUTH-001', title: '有效账号密码登录成功', point: 'TP-008', methods: ['UI', 'API'] as ExecutionMethod[], priority: 'P0', status: '已通过', readiness: '就绪', origin: 'AI 生成', smokeCandidate: true },
  { id: 'TC-AUTH-002', title: '错误密码登录失败并显示明确提示', point: 'TP-009', methods: ['UI'] as ExecutionMethod[], priority: 'P0', status: '已通过', readiness: '就绪', origin: '历史复用', smokeCandidate: true },
  { id: 'TC-AUTH-003', title: '连续五次失败后账户进入保护状态', point: 'TP-004', methods: ['API'] as ExecutionMethod[], priority: 'P0', status: '审核中', readiness: '待确认', origin: 'AI 生成', smokeCandidate: true },
  { id: 'TC-AUTH-004', title: '并发刷新令牌时仅一个请求成功', point: 'TP-005', methods: ['API'] as ExecutionMethod[], priority: 'P1', status: '需修订', readiness: '阻塞', origin: '复制并修改' },
  { id: 'TC-AUTH-005', title: '登录按钮防止连续重复提交', point: 'TP-010', methods: ['UI'] as ExecutionMethod[], priority: 'P1', status: '草稿', readiness: '就绪', origin: 'AI 生成' },
  { id: 'TC-AUTH-006', title: 'Safari 最新两个主版本完成登录', point: 'TP-006', methods: ['UI'] as ExecutionMethod[], priority: 'P2', status: '草稿', readiness: '就绪', origin: 'AI 生成' },
]

const workflowNodes = [
  { role: '测试分析 Agent', subtitle: '依据解构与召回计划', state: '成功', meta: '1 次尝试 · 2m 18s', className: 'analysis' },
  { role: '功能设计 Agent', subtitle: '功能测试点发散', state: '成功', meta: '1 次尝试 · 3m 42s', className: 'functional' },
  { role: '非功能设计 Agent', subtitle: '专项测试点发散', state: '成功', meta: '1 次尝试 · 3m 11s', className: 'nonfunctional' },
  { role: '用例综合 Agent', subtitle: '用例与数据需求具象化', state: '成功', meta: '2 次尝试 · 5m 06s', className: 'synthesis' },
]

function StatusPill({ children, tone = 'neutral' }: { children: ReactNode; tone?: StatusTone }) {
  return <span className={`td-status ${tone}`}>{children}</span>
}

function setRouteContext(params: Record<string, string | null>) {
  const url = new URL(window.location.href)
  Object.entries(params).forEach(([key, value]) => value ? url.searchParams.set(key, value) : url.searchParams.delete(key))
  window.history.pushState({}, '', url)
}

export function TestDesignPage({ projectVersion, onManageVersions, notify }: Props) {
  const routedUrl = typeof window === 'undefined' ? null : new URL(window.location.href)
  const routed = routedUrl?.searchParams.get('testDesignId') ?? null
  const routedTab = routedUrl?.searchParams.get('tab')
  const routedAssetView = routedUrl?.searchParams.get('assetView')
  const [view, setView] = useState<ViewMode>(routed ? 'workspace' : 'list')
  const [collectionView, setCollectionView] = useState<CollectionView>(['designs', 'library', 'sets'].includes(routedAssetView ?? '') ? routedAssetView as CollectionView : 'designs')
  const [tab, setTab] = useState<TabKey>(tabKeys.includes(routedTab as TabKey) ? routedTab as TabKey : 'overview')
  const [basisMode, setBasisMode] = useState<BasisMode>('review_baseline')
  const [selectedBasis, setSelectedBasis] = useState(basisItems[0].id)
  const [selectedTreeNode, setSelectedTreeNode] = useState('TP-009')
  const [selectedCase, setSelectedCase] = useState(cases[0].id)
  const [caseFilter, setCaseFilter] = useState('全部方式')
  const [caseQuery, setCaseQuery] = useState('')
  const [rightOpen, setRightOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 900)
  const [treeApproved, setTreeApproved] = useState(true)
  const [saving, setSaving] = useState(false)
  const [caseTitle, setCaseTitle] = useState(cases[0].title)
  const [createStep, setCreateStep] = useState(1)
  const [selectedAssets, setSelectedAssets] = useState(['ASSET-001', 'ASSET-002'])
  const [augmentation, setAugmentation] = useState('selected_assets')
  const [historyEnabled, setHistoryEnabled] = useState(true)
  const [caseMethods, setCaseMethods] = useState<Record<string, ExecutionMethod[]>>(() => Object.fromEntries(cases.map(item => [item.id, item.methods])))

  const activeBasis = basisItems.find(item => item.id === selectedBasis) ?? basisItems[0]
  const activeTreeNode = treeNodes.find(item => item.id === selectedTreeNode) ?? treeNodes[0]
  const activeCase = cases.find(item => item.id === selectedCase) ?? cases[0]
  const activeCaseMethods = caseMethods[activeCase.id] ?? activeCase.methods
  const filteredCases = useMemo(() => cases.map(item => ({ ...item, methods: caseMethods[item.id] ?? item.methods })).filter(item => {
    const methodMatches = caseFilter === '全部方式' || item.methods.includes(caseFilter as ExecutionMethod)
    const queryMatches = !caseQuery.trim() || `${item.id}${item.title}`.toLowerCase().includes(caseQuery.trim().toLowerCase())
    return methodMatches && queryMatches
  }), [caseFilter, caseMethods, caseQuery])

  const openWorkspace = () => {
    setView('workspace')
    setRouteContext({ testDesignId: 'td-auth-20260807', workflowRunId: 'wf-20260807-03', tab })
  }
  const returnToList = () => {
    setView('list')
    setRouteContext({ testDesignId: null, workflowRunId: null, tab: null })
  }
  const selectTab = (next: TabKey) => {
    setTab(next)
    setRouteContext({ tab: next })
  }
  const selectCollectionView = (next: CollectionView) => {
    setCollectionView(next)
    setRouteContext({ assetView: next })
  }
  const saveCase = () => {
    setSaving(true)
    window.setTimeout(() => {
      setSaving(false)
      notify('用例草稿已保存，revision 更新为 r7。')
    }, 650)
  }
  const toggleCaseMethod = (method: ExecutionMethod) => {
    if (activeCaseMethods.includes(method) && activeCaseMethods.length === 1) {
      notify('每条用例至少保留一种执行方式。', 'warning')
      return
    }
    setCaseMethods(current => ({
      ...current,
      [activeCase.id]: activeCaseMethods.includes(method)
        ? activeCaseMethods.filter(item => item !== method)
        : [...activeCaseMethods, method],
    }))
  }

  if (!projectVersion) {
    return <section className="td-version-gate">
      <TestTube2 />
      <StatusPill tone="warning">需要项目版本</StatusPill>
      <h2>先选择一个项目版本</h2>
      <p>测试设计必须固定在一个项目版本下，之后才能选择评审基线或知识库资料。</p>
      <button className="btn primary" onClick={onManageVersions}>选择项目版本</button>
    </section>
  }

  if (view === 'create') {
    return <CreateDesign
      projectVersion={projectVersion}
      basisMode={basisMode}
      setBasisMode={setBasisMode}
      createStep={createStep}
      setCreateStep={setCreateStep}
      selectedAssets={selectedAssets}
      setSelectedAssets={setSelectedAssets}
      augmentation={augmentation}
      setAugmentation={setAugmentation}
      historyEnabled={historyEnabled}
      setHistoryEnabled={setHistoryEnabled}
      onCancel={() => setView('list')}
      onStart={() => { notify('交互预览：已创建测试设计运行。'); openWorkspace() }}
    />
  }

  if (view === 'list') {
    return <DesignList projectVersion={projectVersion} view={collectionView} setView={selectCollectionView} onCreate={() => setView('create')} onOpen={openWorkspace} notify={notify} />
  }

  return <section className={`td-workbench ${rightOpen ? '' : 'detail-collapsed'}`}>
    <header className="td-workbench-head">
      <div className="td-title-block">
        <button className="td-back" onClick={returnToList} aria-label="返回测试设计列表"><ChevronRight /></button>
        <span className="td-workbench-icon"><TestTube2 /></span>
        <div><span>测试设计</span><h2>登录与身份认证测试设计</h2></div>
        <StatusPill tone="warning">待覆盖确认</StatusPill>
      </div>
      <div className="td-head-actions">
        <button className="icon-btn td-mobile-detail-button" onClick={() => setRightOpen(value => !value)} aria-label={rightOpen ? '收起详情' : '展开详情'}><PanelRightClose /></button>
        <button className="btn" onClick={() => notify('运行记录已刷新。')}><RefreshCw />刷新</button>
        <button className="btn" onClick={() => notify('当前候选版本可导出 JSON、Markdown 和 Excel。')}><Download />导出<ChevronDown /></button>
        <button className="btn primary" onClick={() => notify('仍有 3 个发布阻断项，请先完成覆盖处置。', 'warning')}><LockKeyhole />发布新功能用例集</button>
        <button className="icon-btn" aria-label="更多操作"><MoreHorizontal /></button>
      </div>
    </header>

    <div className="td-context-bar">
      <dl><div><dt>项目版本</dt><dd>{projectVersion.name}</dd></div><div><dt>测试设计</dt><dd>TD-20260807-01</dd></div><div><dt>工作流运行</dt><dd>WF-20260807-03</dd></div><div><dt>主依据</dt><dd>评审基线</dd></div></dl>
      <span className="td-preview-flag"><CircleDot />交互预览数据</span>
      <span className="td-agent-ready"><CheckCircle2 />4/4 Agent 就绪</span>
    </div>

    <div className="td-stage-strip" aria-label="五阶段进度">
      {stages.map((stage, index) => <div key={stage.label} className={stage.state}>
        <span>{stage.state === 'done' ? <Check /> : index + 1}</span>
        <p><small>阶段 {index + 1}</small><b>{stage.label}</b></p>
        {index < stages.length - 1 && <i />}
      </div>)}
    </div>

    <nav className="td-tabs" aria-label="测试设计视图">
      {tabs.map(item => <button key={item.key} className={tab === item.key ? 'active' : ''} onClick={() => selectTab(item.key)}>{item.label}{item.count !== undefined && <span>{item.count}</span>}</button>)}
      <button className="td-detail-toggle" onClick={() => setRightOpen(value => !value)} title={rightOpen ? '收起详情' : '展开详情'}><PanelRightClose /></button>
    </nav>

    <div className="td-workspace-grid">
      <BasisPanel selected={selectedBasis} onSelect={setSelectedBasis} />
      <main className="td-main-canvas">
        {tab === 'overview' && <Overview onNavigate={selectTab} />}
        {tab === 'workflow' && <WorkflowView notify={notify} />}
        {tab === 'analysis' && <AnalysisView />}
        {tab === 'retrieval' && <RetrievalView />}
        {tab === 'tree' && <TreeView selected={selectedTreeNode} onSelect={setSelectedTreeNode} approved={treeApproved} onApprove={() => { setTreeApproved(true); notify('测试点树 r12 已批准。') }} onInvalidate={() => { setTreeApproved(false); notify('树已进入编辑状态，下游产物标记为过期。', 'warning') }} />}
        {tab === 'cases' && <CasesView selected={selectedCase} onSelect={id => { setSelectedCase(id); setCaseTitle(cases.find(item => item.id === id)?.title ?? '') }} filter={caseFilter} setFilter={setCaseFilter} query={caseQuery} setQuery={setCaseQuery} rows={filteredCases} notify={notify} />}
        {tab === 'case-set' && <FeatureCaseSetView notify={notify} />}
        {tab === 'data' && <DataView />}
        {tab === 'coverage' && <CoverageView notify={notify} />}
        {tab === 'history' && <HistoryView notify={notify} />}
        {tab === 'questions' && <QuestionsView notify={notify} />}
      </main>
      {rightOpen && <DetailPanel tab={tab} basis={activeBasis} treeNode={activeTreeNode} testCase={activeCase} executionMethods={activeCaseMethods} onToggleMethod={toggleCaseMethod} caseTitle={caseTitle} setCaseTitle={setCaseTitle} saving={saving} onSave={saveCase} approved={treeApproved} notify={notify} />}
    </div>
  </section>
}

function DesignList({ projectVersion, view, setView, onCreate, onOpen, notify }: { projectVersion: ProjectVersion; view: CollectionView; setView: (view: CollectionView) => void; onCreate: () => void; onOpen: () => void; notify: Notify }) {
  return <section className="td-list-page">
    <nav className="td-asset-tabs" aria-label="测试资产视图">
      <button className={view === 'designs' ? 'active' : ''} onClick={() => setView('designs')}><GitBranch />测试设计<span>3</span></button>
      <button className={view === 'library' ? 'active' : ''} onClick={() => setView('library')}><TableProperties />测试用例库<span>412</span></button>
      <button className={view === 'sets' ? 'active' : ''} onClick={() => setView('sets')}><Layers3 />测试用例集<span>8</span></button>
    </nav>
    {view === 'designs' && <>
    <div className="td-list-toolbar">
      <div className="td-list-search"><Search /><input aria-label="搜索测试设计" placeholder="搜索名称或运行 ID" /></div>
      <select aria-label="状态筛选"><option>全部状态</option><option>设计中</option><option>待审核</option><option>已发布</option></select>
      <button className="btn primary" onClick={onCreate}><Plus />创建测试设计</button>
    </div>
    <section className="td-summary-band">
      <div><span className="td-summary-icon"><TestTube2 /></span><p><small>当前项目版本</small><b>{projectVersion.name}</b><em>测试设计与输入快照均固定在此版本</em></p></div>
      <dl><div><dt>测试设计</dt><dd>3</dd></div><div><dt>运行中</dt><dd>1</dd></div><div><dt>待审核用例</dt><dd>7</dd></div><div><dt>已发布版本</dt><dd>1</dd></div></dl>
    </section>
    <div className="td-list-table-wrap">
      <table className="td-design-table">
        <thead><tr><th>测试设计</th><th>主依据</th><th>当前阶段</th><th>用例 / 覆盖</th><th>更新时间</th><th>状态</th><th /></tr></thead>
        <tbody>
          <tr onClick={onOpen}>
            <td><span className="td-row-symbol active"><TestTube2 /></span><p><b>登录与身份认证测试设计</b><small>TD-20260807-01 · WF-20260807-03</small></p></td>
            <td><StatusPill tone="info">评审基线</StatusPill><small>需求评审 RR-021 · 技术评审 TR-014</small></td>
            <td><b>覆盖反向审计</b><div className="td-mini-progress"><span style={{ width: '86%' }} /></div></td>
            <td><b>28 条用例</b><small>覆盖率 91.3% · 3 个阻断项</small></td>
            <td><b>今天 14:32</b><small>李磊</small></td>
            <td><StatusPill tone="warning">待覆盖确认</StatusPill></td>
            <td><button className="icon-btn" aria-label="打开测试设计"><ChevronRight /></button></td>
          </tr>
          <tr>
            <td><span className="td-row-symbol"><Database /></span><p><b>知识库检索与索引测试设计</b><small>TD-20260806-02 · WF-20260806-04</small></p></td>
            <td><StatusPill tone="success">知识库资料</StatusPill><small>3 份固定资产 · Index v12</small></td>
            <td><b>人工审核</b><div className="td-mini-progress"><span style={{ width: '100%' }} /></div></td>
            <td><b>42 条用例</b><small>覆盖率 100% · 无阻断项</small></td>
            <td><b>昨天 18:06</b><small>李磊</small></td>
            <td><StatusPill tone="info">审核中</StatusPill></td>
            <td><button className="icon-btn" aria-label="打开测试设计"><ChevronRight /></button></td>
          </tr>
          <tr>
            <td><span className="td-row-symbol"><CheckCircle2 /></span><p><b>需求评审工作台回归设计</b><small>TD-20260802-01 · TCS v1</small></p></td>
            <td><StatusPill tone="info">评审基线</StatusPill><small>需求评审 RR-017 · 技术评审 TR-009</small></td>
            <td><b>已完成</b><div className="td-mini-progress"><span style={{ width: '100%' }} /></div></td>
            <td><b>35 条用例</b><small>覆盖率 100% · 已全部通过</small></td>
            <td><b>8月2日 16:40</b><small>李磊</small></td>
            <td><StatusPill tone="success">已发布 v1</StatusPill></td>
            <td><button className="icon-btn" aria-label="打开测试设计"><ChevronRight /></button></td>
          </tr>
        </tbody>
      </table>
    </div>
    </>}
    {view === 'library' && <ProjectCaseLibrary projectVersion={projectVersion} />}
    {view === 'sets' && <CaseSetCatalog projectVersion={projectVersion} onOpenFeature={onOpen} notify={notify} />}
  </section>
}

function ProjectCaseLibrary({ projectVersion }: { projectVersion: ProjectVersion }) {
  const rows = [
    ['TC-AUTH-001', '有效账号密码登录成功', '身份认证', 'UI + API', 'P0', '冒烟 · 核心回归 · 身份认证 v2', '已批准'],
    ['TC-AUTH-002', '错误密码登录失败并显示明确提示', '身份认证', 'UI', 'P0', '冒烟 · 核心回归 · 身份认证 v2', '已批准'],
    ['TC-KB-014', '混合检索返回固定资产版本与原文定位', '知识库', 'API', 'P0', '核心回归 · 知识库检索 v3', '已批准'],
    ['TC-RR-028', '需求评审失败后仅重跑评审阶段', '需求评审', 'API', 'P1', '核心回归 · 需求评审 v1', '已批准'],
    ['TC-TS-011', '技术方案评审引用固定需求基线', '技术方案', 'UI', 'P1', '技术方案评审 v1', '已批准'],
    ['TC-AUTH-004', '并发刷新令牌时仅一个请求成功', '身份认证', 'API', 'P1', '身份认证候选集', '需修订'],
  ]
  return <div className="td-library-view">
    <div className="td-list-toolbar">
      <div className="td-list-search"><Search /><input aria-label="搜索测试用例库" placeholder="搜索用例 ID、名称或业务域" /></div>
      <select aria-label="业务域筛选"><option>全部业务域</option><option>身份认证</option><option>知识库</option><option>需求评审</option></select>
      <select aria-label="状态筛选"><option>当前有效版本</option><option>已废弃</option><option>全部版本</option></select>
      <button className="btn"><Download />导出清单</button>
    </div>
    <section className="td-library-summary">
      <div><span><TableProperties /></span><p><small>项目测试用例库</small><b>{projectVersion.name}</b><em>用例按 caseId 统一管理，可被多个用例集引用，不复制内容。</em></p></div>
      <dl><div><dt>有效用例</dt><dd>386</dd></div><div><dt>P0 用例</dt><dd>74</dd></div><div><dt>含 UI / API</dt><dd>221 / 171</dd></div><div><dt>待维护</dt><dd className="warning">9</dd></div></dl>
    </section>
    <div className="td-library-table">
      <div className="td-library-table-head"><span>测试用例</span><span>业务域</span><span>方式</span><span>优先级</span><span>所属用例集</span><span>当前状态</span></div>
      {rows.map((row, index) => <button key={row[0]}>
        <span><i className={row[3] === 'UI' ? 'ui' : row[3] === 'API' ? 'api' : 'mixed'}>{row[3].includes('UI') && <TableProperties />}{row[3].includes('API') && <Braces />}</i><p><b>{row[1]}</b><small>{row[0]} · revision {index + 3}</small></p></span>
        <em>{row[2]}</em><strong>{row[3]}</strong><strong className={row[4] === 'P0' ? 'p0' : ''}>{row[4]}</strong><small>{row[5]}</small><StatusPill tone={row[6] === '已批准' ? 'success' : 'warning'}>{row[6]}</StatusPill>
      </button>)}
    </div>
  </div>
}

function CaseSetCatalog({ projectVersion, onOpenFeature, notify }: { projectVersion: ProjectVersion; onOpenFeature: () => void; notify: Notify }) {
  const sets = [
    { id: 'SET-SMOKE', name: 'SmartHub 冒烟用例集', type: '冒烟基线', cases: 18, version: 'v6', updated: '2026-08-06 18:20', status: '已发布', tone: 'smoke', scope: '登录、知识库访问、评审创建、核心配置读取' },
    { id: 'SET-REGRESSION', name: 'SmartHub 核心回归用例集', type: '回归基线', cases: 326, version: 'v12', updated: '2026-08-06 18:20', status: '已发布', tone: 'regression', scope: '覆盖当前项目版本全部稳定功能域' },
    { id: 'SET-AUTH', name: '登录与身份认证新功能用例集', type: '新功能', cases: 28, version: '候选 v2', updated: '今天 14:32', status: '待发布', tone: 'feature', scope: '18 条新增 · 4 条修改 · 6 条历史复用 · 3 条冒烟候选' },
    { id: 'SET-KB', name: '知识库检索与索引用例集', type: '新功能', cases: 42, version: 'v3', updated: '昨天 18:06', status: '已发布', tone: 'feature', scope: '混合检索、固定版本、索引切换与降级' },
    { id: 'SET-RR', name: '需求评审工作台用例集', type: '功能域', cases: 35, version: 'v1', updated: '2026-08-02 16:40', status: '已发布', tone: 'domain', scope: '需求提取、评审、Evidence、重跑与人工处置' },
  ]
  return <div className="td-set-catalog">
    <div className="td-list-toolbar">
      <div className="td-list-search"><Search /><input aria-label="搜索测试用例集" placeholder="搜索用例集名称或版本" /></div>
      <select aria-label="用例集类型筛选"><option>全部类型</option><option>冒烟基线</option><option>回归基线</option><option>新功能</option></select>
      <button className="btn"><History />版本历史</button>
    </div>
    <section className="td-set-summary">
      <div><span><Layers3 /></span><p><small>项目测试用例集</small><b>{projectVersion.name}</b><em>用例集保存成员引用与固定 revision，单条用例可以进入多个集合。</em></p></div>
      <div className="td-set-legend"><span><i className="smoke" />冒烟基线</span><span><i className="regression" />回归基线</span><span><i className="feature" />新功能用例集</span></div>
    </section>
    <div className="td-set-grid">
      {sets.map(set => <article key={set.id} className={set.id === 'SET-AUTH' ? 'current' : ''}>
        <header><span className={set.tone}><Layers3 /></span><div><small>{set.type} · {set.id}</small><h3>{set.name}</h3></div><StatusPill tone={set.status === '已发布' ? 'success' : 'warning'}>{set.status}</StatusPill></header>
        <p>{set.scope}</p>
        <dl><div><dt>用例数量</dt><dd>{set.cases}</dd></div><div><dt>版本</dt><dd>{set.version}</dd></div><div><dt>更新时间</dt><dd>{set.updated}</dd></div></dl>
        <footer><span>{set.status === '已发布' ? <><LockKeyhole />不可变版本</> : <><CircleDot />来自 TD-20260807-01</>}</span><button onClick={set.id === 'SET-AUTH' ? onOpenFeature : () => notify(`已打开 ${set.name} ${set.version} 的只读成员清单。`)}>查看用例集<ChevronRight /></button></footer>
      </article>)}
    </div>
  </div>
}

function CreateDesign({ projectVersion, basisMode, setBasisMode, createStep, setCreateStep, selectedAssets, setSelectedAssets, augmentation, setAugmentation, historyEnabled, setHistoryEnabled, onCancel, onStart }: {
  projectVersion: ProjectVersion
  basisMode: BasisMode
  setBasisMode: (mode: BasisMode) => void
  createStep: number
  setCreateStep: (step: number) => void
  selectedAssets: string[]
  setSelectedAssets: (assets: string[]) => void
  augmentation: string
  setAugmentation: (value: string) => void
  historyEnabled: boolean
  setHistoryEnabled: (value: boolean) => void
  onCancel: () => void
  onStart: () => void
}) {
  const assets = [
    { id: 'ASSET-001', type: '产品需求', name: 'SmartHub 身份认证需求', path: '/产品/认证/身份认证需求.md', version: 'v8', hash: '9f2a...e31c' },
    { id: 'ASSET-002', type: '技术方案', name: '认证服务技术设计', path: '/技术/服务/认证服务设计.md', version: 'v5', hash: '34bd...19af' },
    { id: 'ASSET-003', type: '接口文档', name: 'Auth API 规范', path: '/接口/auth-openapi.yaml', version: 'v3', hash: '7c11...d20e' },
  ]
  const toggleAsset = (id: string) => setSelectedAssets(selectedAssets.includes(id) ? selectedAssets.filter(item => item !== id) : [...selectedAssets, id])
  return <section className="td-create-page">
    <header><button className="icon-btn" onClick={onCancel} aria-label="关闭创建页"><X /></button><div><span>创建测试设计</span><h2>固定输入并启动多 Agent 工作流</h2></div><StatusPill tone="neutral">{projectVersion.name}</StatusPill></header>
    <div className="td-create-steps">
      {['选择主依据', '补充上下文', '运行前检查'].map((label, index) => <button key={label} className={createStep === index + 1 ? 'active' : createStep > index + 1 ? 'done' : ''} onClick={() => setCreateStep(index + 1)}><span>{createStep > index + 1 ? <Check /> : index + 1}</span><b>{label}</b>{index < 2 && <i />}</button>)}
    </div>
    <div className="td-create-body">
      {createStep === 1 && <>
        <div className="td-form-heading"><h3>选择主测试依据</h3><p>主依据创建后不可切换，所有内容会固定为不可变快照。</p></div>
        <div className="td-segmented"><button className={basisMode === 'review_baseline' ? 'active' : ''} onClick={() => setBasisMode('review_baseline')}><GitBranch /><span><b>评审基线</b><small>固定成功的需求与技术方案评审</small></span></button><button className={basisMode === 'knowledge_assets' ? 'active' : ''} onClick={() => setBasisMode('knowledge_assets')}><Database /><span><b>知识库资料</b><small>直接选择一至多份 ready 资产版本</small></span></button></div>
        {basisMode === 'review_baseline' ? <div className="td-form-section">
          <label><span>需求评审基线</span><select><option>登录能力需求评审 · RR-20260801-021 · 已成功</option></select><small>36 个固定需求点，2 个高风险 Finding 已处置</small></label>
          <label><span>技术方案评审基线</span><select><option>认证服务技术方案评审 · TR-20260805-014 · 已成功</option></select><small>来源需求与所选评审一致，包含 28 个方案要点</small></label>
          <div className="td-inline-notice success"><CheckCircle2 /><span><b>基线关系校验通过</b><small>项目版本、来源需求、Finding 处置和结果 Hash 均一致。</small></span></div>
        </div> : <div className="td-form-section">
          <label><span>测试目标</span><textarea defaultValue="验证身份认证能力在正常、异常、并发和安全场景下的行为与约束。" /></label>
          <div className="td-asset-picker"><div className="td-picker-head"><b>固定资产版本</b><span>{selectedAssets.length} 项已选择</span></div>{assets.map(asset => <label key={asset.id} className={selectedAssets.includes(asset.id) ? 'selected' : ''}><input type="checkbox" checked={selectedAssets.includes(asset.id)} onChange={() => toggleAsset(asset.id)} /><FileText /><span><b>{asset.name}</b><small>{asset.type} · {asset.path}</small></span><em>{asset.version}</em><code>{asset.hash}</code></label>)}</div>
        </div>}
      </>}
      {createStep === 2 && <>
        <div className="td-form-heading"><h3>补充知识与历史用例</h3><p>补充项同样会冻结具体版本、范围与内容 Hash。</p></div>
        <div className="td-form-section">
          <fieldset><legend>知识增强</legend><div className="td-radio-list">
            {[['disabled', '不启用', '仅使用主依据，不执行补充召回'], ['selected_assets', '指定资料', '从 2 份已选资料中进行受控召回'], ['fixed_index', '固定索引', '从当前知识库索引 v12 中召回']].map(option => <label key={option[0]} className={augmentation === option[0] ? 'selected' : ''}><input type="radio" name="augmentation" checked={augmentation === option[0]} onChange={() => setAugmentation(option[0])} /><span><b>{option[1]}</b><small>{option[2]}</small></span></label>)}
          </div></fieldset>
          <fieldset><legend>历史用例</legend><label className="td-switch-row"><input type="checkbox" checked={historyEnabled} onChange={event => setHistoryEnabled(event.target.checked)} /><span><b>参考已发布历史用例集</b><small>默认不选择；已选择 6 条与认证能力相关的用例。</small></span><em className={historyEnabled ? 'on' : ''}><i /></em></label>{historyEnabled && <div className="td-history-source"><History /><span><b>需求评审工作台回归设计 · TCS v1</b><small>6 条用例 · 来源版本 SmartHub 2026.07 · Hash 17b8...c921</small></span><button className="btn">更改选择</button></div>}</fieldset>
        </div>
      </>}
      {createStep === 3 && <>
        <div className="td-form-heading"><h3>运行前检查</h3><p>输入快照与四个 Agent 全部就绪后才能开始。</p></div>
        <div className="td-preflight-summary"><div><CheckCircle2 /><span><b>8 项检查通过</b><small>工作流可以安全启动</small></span></div><StatusPill tone="success">允许开始</StatusPill></div>
        <div className="td-preflight-grid">
          {[['固定输入', '需求与技术方案基线关系一致', 'success'], ['知识增强', augmentation === 'disabled' ? '已明确禁用' : '召回范围与索引版本已固定', 'success'], ['历史用例', historyEnabled ? '6 条来源用例已固定' : '未选择历史用例', 'success'], ['风险确认', '2 个非阻断 Finding 将保留在快照', 'warning']].map(item => <article key={item[0]}><span className={item[2]}>{item[2] === 'warning' ? <AlertTriangle /> : <Check />}</span><p><b>{item[0]}</b><small>{item[1]}</small></p><ChevronRight /></article>)}
        </div>
        <div className="td-agent-check"><header><Bot /><span><b>Agent 就绪状态</b><small>本次运行将固定以下已发布版本</small></span><StatusPill tone="success">4 / 4 就绪</StatusPill></header>{['测试分析 Agent', '功能设计 Agent', '非功能设计 Agent', '用例综合 Agent'].map((agent, index) => <div key={agent}><span className="success"><Check /></span><b>{agent}</b><small>v{index === 0 ? 4 : 3} · glm-4.5-air · 协议校验通过</small><em>已发布</em></div>)}</div>
      </>}
    </div>
    <footer><button className="btn" onClick={createStep === 1 ? onCancel : () => setCreateStep(createStep - 1)}>{createStep === 1 ? '取消' : '上一步'}</button><span>输入将在创建运行时固定，不使用 latest。</span>{createStep < 3 ? <button className="btn primary" onClick={() => setCreateStep(createStep + 1)}>继续<ArrowRight /></button> : <button className="btn primary" onClick={onStart}><Play />开始测试设计</button>}</footer>
  </section>
}

function BasisPanel({ selected, onSelect }: { selected: string; onSelect: (id: string) => void }) {
  return <aside className="td-basis-panel">
    <header><div><b>固定测试依据</b><small>评审基线 · 64 项</small></div><button className="icon-btn" aria-label="筛选依据"><Filter /></button></header>
    <div className="td-basis-summary"><GitBranch /><span><b>登录能力评审基线</b><small>需求 RR-021 · 技术方案 TR-014</small></span><LockKeyhole /></div>
    <div className="td-panel-search"><Search /><input aria-label="搜索依据" placeholder="搜索依据项" /></div>
    <div className="td-basis-list">
      <p>当前视图依据</p>
      {basisItems.map(item => <button key={item.id} className={selected === item.id ? 'active' : ''} onClick={() => onSelect(item.id)}><i className={item.kind === '风险' ? 'risk' : item.kind === '方案要点' ? 'solution' : ''} /><span><small>{item.kind} · {item.id}</small><b>{item.title}</b><em>{item.source}</em></span>{item.status === '已覆盖' ? <CheckCircle2 className="covered" /> : item.status === '待确认' ? <AlertTriangle className="question" /> : <CircleDot className="partial" />}</button>)}
    </div>
    <footer><span><i className="covered" />已覆盖 52</span><span><i className="partial" />部分 9</span><span><i className="missing" />未覆盖 3</span></footer>
  </aside>
}

function Overview({ onNavigate }: { onNavigate: (tab: TabKey) => void }) {
  return <div className="td-overview">
    <section className="td-metric-row">
      <article><span className="purple"><ListChecks /></span><p><small>测试点</small><b>46</b><em>已批准树 r12</em></p></article>
      <article><span className="green"><TestTube2 /></span><p><small>测试用例</small><b>28</b><em>18 条已通过</em></p></article>
      <article><span className="blue"><ShieldCheck /></span><p><small>依据覆盖率</small><b>91.3%</b><em>目标 100%</em></p></article>
      <article><span className="orange"><AlertTriangle /></span><p><small>发布阻断项</small><b>3</b><em>需人工处置</em></p></article>
    </section>
    <section className="td-overview-grid">
      <div className="td-overview-panel"><header><span><GitBranch /><b>工作流进度</b></span><button onClick={() => onNavigate('workflow')}>查看工作流<ChevronRight /></button></header><div className="td-overview-flow">{stages.map((stage, index) => <div key={stage.label} className={stage.state}><span>{stage.state === 'done' ? <Check /> : index + 1}</span><p><b>{stage.label}</b><small>{stage.state === 'done' ? '已完成' : '等待确认 3 个缺口'}</small></p></div>)}</div></div>
      <div className="td-overview-panel"><header><span><ShieldCheck /><b>覆盖概览</b></span><button onClick={() => onNavigate('coverage')}>查看审计<ChevronRight /></button></header><div className="td-coverage-ring"><div><strong>91.3<small>%</small></strong><span>依据覆盖率</span></div><ul><li><i className="covered" />已覆盖 <b>52</b></li><li><i className="partial" />部分覆盖 <b>9</b></li><li><i className="missing" />未覆盖 <b>3</b></li></ul></div></div>
      <div className="td-overview-panel wide td-feature-set-overview"><header><span><Layers3 /><b>本次新功能用例集</b></span><StatusPill tone="warning">候选 v2</StatusPill><button onClick={() => onNavigate('case-set')}>查看用例集与提测交接<ChevronRight /></button></header><div><span><small>候选用例</small><b>28</b></span><i /><span><small>新增</small><b>18</b></span><span><small>修改</small><b>4</b></span><span><small>历史复用</small><b>6</b></span><i /><span><small>冒烟候选</small><b>3</b></span><span><small>影响回归引用</small><b>12</b></span><em>冒烟 v6 保持不可变</em></div></div>
      <div className="td-overview-panel wide"><header><span><AlertTriangle /><b>需要处理</b></span><StatusPill tone="warning">5 项</StatusPill></header><div className="td-attention-list"><button onClick={() => onNavigate('coverage')}><span className="danger"><AlertTriangle /></span><p><b>3 个发布阻断项</b><small>2 个依据未覆盖，1 条用例缺少可判定预期</small></p><ChevronRight /></button><button onClick={() => onNavigate('cases')}><span className="warning"><Users /></span><p><b>7 条用例等待审核</b><small>其中 2 条由历史用例复制并修改</small></p><ChevronRight /></button><button onClick={() => onNavigate('questions')}><span className="info"><CircleDot /></span><p><b>2 个待确认项</b><small>账户保护窗口和 Safari 兼容范围需要确认</small></p><ChevronRight /></button></div></div>
    </section>
  </div>
}

function WorkflowView({ notify }: { notify: Notify }) {
  return <div className="td-workflow-view">
    <header className="td-canvas-toolbar"><div><b>固定工作流</b><small>test-design-workflow/v1 · 运行完成 86%</small></div><span><i className="done" />成功</span><span><i className="running" />进行中</span><span><i />等待</span><button className="btn" onClick={() => notify('运行详情面板已是预览数据。')}>运行详情</button></header>
    <div className="td-workflow-canvas">
      <div className="td-flow-column start"><small>固定输入</small><article><span><LockKeyhole /></span><p><b>评审基线快照</b><small>64 项依据 · Hash 已校验</small></p><CheckCircle2 /></article></div>
      <ArrowRight className="td-flow-arrow a1" />
      <div className="td-flow-column analysis"><small>阶段 1</small><WorkflowCard node={workflowNodes[0]} /></div>
      <ArrowRight className="td-flow-arrow a2" />
      <div className="td-flow-branch">
        <span className="td-branch-line" />
        <div><small>阶段 2 · 并行</small><WorkflowCard node={workflowNodes[1]} /><WorkflowCard node={workflowNodes[2]} /></div>
      </div>
      <ArrowRight className="td-flow-arrow a3" />
      <div className="td-flow-column gate"><small>人工门禁 1</small><article><span><Users /></span><p><b>测试点树批准</b><small>r12 · 李磊 · 13:46</small></p><CheckCircle2 /></article></div>
      <ArrowRight className="td-flow-arrow a4" />
      <div className="td-flow-column synthesis"><small>阶段 3-4</small><WorkflowCard node={workflowNodes[3]} /></div>
      <ArrowRight className="td-flow-arrow a5" />
      <div className="td-flow-column audit"><small>阶段 5</small><article className="running"><span><ShieldCheck /></span><p><b>覆盖反向审计</b><small>等待处理 3 个阻断项</small></p><RefreshCw /></article></div>
    </div>
    <section className="td-run-timeline"><header><b>最近事件</b><span>不展示模型隐藏思维</span></header>{[['14:28:16', '覆盖审计', '服务端完成覆盖矩阵计算，发现 3 个发布阻断项'], ['14:24:38', '用例综合 Agent', '第 2 次提交通过协议与依据引用校验'], ['14:19:32', '用例综合 Agent', '首次提交缺少 2 个 oracle，返回结构化校验反馈'], ['13:46:05', '人工门禁', '李磊批准测试点树 r12，解锁用例具象化']].map((event, index) => <div key={event[0]}><i className={index === 0 ? 'active' : ''} /><time>{event[0]}</time><b>{event[1]}</b><span>{event[2]}</span></div>)}</section>
  </div>
}

function WorkflowCard({ node }: { node: typeof workflowNodes[number] }) {
  return <article className={node.className}><span><Bot /></span><p><b>{node.role}</b><small>{node.subtitle}</small><em>{node.meta}</em></p><CheckCircle2 /></article>
}

function AnalysisView() {
  const groups = [
    { title: '业务动作', count: 5, items: ['提交登录凭据', '校验账户状态', '签发访问令牌', '轮换刷新令牌'] },
    { title: '规则与约束', count: 8, items: ['连续失败 5 次进入保护状态', '访问令牌有效期 30 分钟', '刷新操作必须满足幂等约束'] },
    { title: '状态', count: 4, items: ['未认证', '已认证', '保护中', '令牌已失效'] },
    { title: '接口与异步事件', count: 6, items: ['POST /auth/login', 'POST /auth/refresh', 'auth.audit.created'] },
  ]
  return <div className="td-analysis-view"><header className="td-canvas-toolbar"><div><b>依据解构</b><small>结构化实体、动作、规则、状态与风险均保留固定来源</small></div><StatusPill tone="success">18 项已校验</StatusPill></header><div className="td-analysis-groups">{groups.map(group => <section key={group.title}><header><span><Braces /><b>{group.title}</b></span><em>{group.count}</em></header>{group.items.map((item, index) => <button key={item}><span>{String(index + 1).padStart(2, '0')}</span><p><b>{item}</b><small>来源 REQ-{18 + index} · 置信度 {(0.98 - index * .03).toFixed(2)}</small></p><ChevronRight /></button>)}</section>)}</div></div>
}

function RetrievalView() {
  return <div className="td-retrieval-view"><header className="td-canvas-toolbar"><div><b>固定知识召回</b><small>12 个 Chunk · 3 个查询意图 · 索引 v12</small></div><StatusPill tone="info">selected_assets</StatusPill></header><div className="td-query-intents"><button className="active"><Search /><span><b>账户保护机制的测试边界</b><small>5 个命中 · top score 0.94</small></span></button><button><Search /><span><b>双 Token 并发刷新约束</b><small>4 个命中 · top score 0.91</small></span></button><button><Search /><span><b>登录审计事件可靠性</b><small>3 个命中 · top score 0.88</small></span></button></div><div className="td-retrieval-results">{[['认证服务技术设计', '账户保护采用滑动窗口计数。在 10 分钟内连续失败 5 次后，账户进入 30 分钟保护状态。', '0.94', '核心依据'], ['安全基线规范', '认证接口应同时限制账号维度与来源 IP 维度的尝试频率，并避免通过错误差异泄漏账号存在性。', '0.89', '补充约束'], ['Auth API 规范', 'POST /auth/login 在账户受保护时返回统一业务码 AUTH_ACCOUNT_PROTECTED。', '0.86', '接口约束']].map((item, index) => <article key={item[0]} className={index === 0 ? 'active' : ''}><header><FileText /><b>{item[0]}</b><StatusPill tone={index === 0 ? 'success' : 'neutral'}>{item[3]}</StatusPill><strong>{item[2]}</strong></header><p>{item[1]}</p><footer><span>/技术/服务/认证服务设计.md · L{128 + index * 34}-L{143 + index * 34}</span><button>查看固定原文<Link2 /></button></footer></article>)}</div></div>
}

function TreeView({ selected, onSelect, approved, onApprove, onInvalidate }: { selected: string; onSelect: (id: string) => void; approved: boolean; onApprove: () => void; onInvalidate: () => void }) {
  return <div className="td-tree-view"><header className="td-canvas-toolbar"><div><b>测试点树</b><small>revision r12 · 46 个节点 · 64 项依据</small></div><StatusPill tone={approved ? 'success' : 'warning'}>{approved ? '已批准' : '编辑中'}</StatusPill><button className="btn" onClick={onInvalidate}><Pencil />编辑树</button>{approved ? <button className="btn" onClick={onInvalidate}>要求修订</button> : <button className="btn primary" onClick={onApprove}><Check />批准 r13</button>}</header><div className="td-tree-tools"><div className="td-panel-search"><Search /><input placeholder="搜索测试点" /></div><button className="btn"><Plus />新增</button><button className="icon-btn" aria-label="上移"><ArrowUp /></button><button className="icon-btn" aria-label="下移"><ArrowDown /></button><button className="icon-btn" aria-label="拆分"><Split /></button><button className="icon-btn" aria-label="删除"><Trash2 /></button></div><div className="td-tree-header"><span>测试点</span><span>方法</span><span>优先级</span><span>用例数</span></div><div className="td-tree-list" role="tree">{treeNodes.map(node => <button role="treeitem" aria-level={node.level + 1} aria-selected={selected === node.id} key={node.id} className={selected === node.id ? 'active' : ''} style={{ '--tree-level': node.level } as React.CSSProperties} onClick={() => onSelect(node.id)}><span className="td-tree-name">{node.expanded !== undefined ? <ChevronRight className={node.expanded ? 'expanded' : ''} /> : <i />}<TestTube2 /><span><b>{node.title}</b><small>{node.id} · {node.level === 0 ? '业务域' : '测试点'}</small></span></span><em>{node.method}</em><strong className={node.priority === 'P0' ? 'p0' : ''}>{node.priority}</strong><small>{node.count}</small></button>)}</div></div>
}

function CasesView({ selected, onSelect, filter, setFilter, query, setQuery, rows, notify }: { selected: string; onSelect: (id: string) => void; filter: string; setFilter: (value: string) => void; query: string; setQuery: (value: string) => void; rows: typeof cases; notify: Notify }) {
  return <div className="td-cases-view"><header className="td-canvas-toolbar"><div><b>测试用例</b><small>28 条 · 18 条已通过 · 3 条冒烟候选</small></div><button className="btn" onClick={() => notify('已选择 7 条可提交用例。')}><Users />批量审核</button><button className="btn primary" onClick={() => notify('已创建空白用例草稿。')}><Plus />新建用例</button></header><div className="td-case-filters"><div className="td-panel-search"><Search /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索用例 ID 或标题" /></div><select value={filter} onChange={event => setFilter(event.target.value)}><option>全部方式</option><option>UI</option><option>API</option></select><select><option>全部优先级</option><option>P0</option><option>P1</option><option>P2</option></select><select><option>全部集合角色</option><option>冒烟候选</option><option>普通用例</option></select><button className="icon-btn" aria-label="更多筛选"><Filter /></button></div><div className="td-case-table"><div className="td-case-table-head"><span>用例</span><span>测试点</span><span>方式</span><span>优先级</span><span>审核</span><span>就绪</span></div>{rows.map(item => <button key={item.id} className={selected === item.id ? 'active' : ''} onClick={() => onSelect(item.id)}><span><i className={item.methods.length === 2 ? 'mixed' : item.methods[0].toLowerCase()}>{item.methods.includes('UI') && <TableProperties />}{item.methods.includes('API') && <Braces />}</i><p><b>{item.title}</b><small>{item.id} · {item.origin}</small></p>{item.smokeCandidate && <span className="td-smoke-candidate"><Sparkles />冒烟候选</span>}</span><em>{item.point}</em><strong>{item.methods.join(' + ')}</strong><strong className={item.priority === 'P0' ? 'p0' : ''}>{item.priority}</strong><StatusPill tone={item.status === '已通过' ? 'success' : item.status === '需修订' ? 'danger' : item.status === '审核中' ? 'info' : 'neutral'}>{item.status}</StatusPill><StatusPill tone={item.readiness === '就绪' ? 'success' : item.readiness === '阻塞' ? 'danger' : 'warning'}>{item.readiness}</StatusPill></button>)}{rows.length === 0 && <div className="td-empty-filter"><Search /><b>没有匹配的测试用例</b><span>调整测试方式或搜索关键词后重试。</span></div>}</div></div>
}

function FeatureCaseSetView({ notify }: { notify: Notify }) {
  const [strategy, setStrategy] = useState<'standard' | 'quick' | 'full'>('standard')
  const chooseStrategy = (next: 'standard' | 'quick' | 'full') => {
    setStrategy(next)
    notify(`提测交接预览已切换为${next === 'standard' ? '标准流程' : next === 'quick' ? '快速验证' : '直接全量'}。`)
  }
  return <div className="td-feature-set-view">
    <header className="td-canvas-toolbar">
      <div><b>登录与身份认证新功能用例集</b><small>SET-AUTH · 候选 v2 · 来源 TD-20260807-01</small></div>
      <StatusPill tone="warning">待发布</StatusPill>
      <button className="btn" onClick={() => notify('已打开候选成员 Diff：相对 v1 新增 18 条、修改 4 条。')}><FileDiff />比较 v1</button>
      <button className="btn primary" onClick={() => notify('仍有 3 个发布阻断项，请先完成覆盖处置。', 'warning')}><LockKeyhole />发布新功能用例集</button>
    </header>
    <section className="td-set-identity">
      <span><Layers3 /></span>
      <div><small>本次正式交付物</small><h2>身份认证新功能用例集</h2><p>只包含本次新增、修改和复用形成的用例；冒烟与全量回归通过固定版本引用组合，不复制进当前集合。</p></div>
      <dl><div><dt>候选用例</dt><dd>28</dd></div><div><dt>覆盖率</dt><dd>91.3%</dd></div><div><dt>发布阻断</dt><dd className="danger">3</dd></div></dl>
    </section>
    <section className="td-set-composition">
      <header><div><b>候选成员构成</b><small>发布后固定成员 caseId、revision 与集合内容 Hash</small></div><span>28 条候选</span></header>
      <div>
        <article><span className="added"><Plus /></span><p><small>本次新增</small><b>18</b><em>AI 生成并人工修订</em></p></article>
        <article><span className="modified"><FileDiff /></span><p><small>修改历史用例</small><b>4</b><em>保留来源 Diff</em></p></article>
        <article><span className="reused"><ArchiveRestore /></span><p><small>原样复用</small><b>6</b><em>unchanged 关系</em></p></article>
        <article><span className="impacted"><Link2 /></span><p><small>影响回归引用</small><b>12</b><em>不进入当前集合</em></p></article>
        <article><span className="smoke"><Sparkles /></span><p><small>冒烟候选</small><b>3</b><em>待稳定性验证</em></p></article>
      </div>
    </section>
    <section className="td-smoke-evolution">
      <header><div><b>冒烟基线演进</b><small>当前已发布版本保持不可变，本次仅创建组合快照和下一版候选</small></div><StatusPill tone="info">3 条候选</StatusPill></header>
      <div className="td-smoke-flow">
        <article><span><LockKeyhole /></span><div><small>当前稳定基线</small><b>冒烟用例集 v6</b><em>18 条 · 已发布不可变</em></div></article>
        <Plus />
        <article className="candidate"><span><Sparkles /></span><div><small>本次功能补充</small><b>冒烟候选</b><em>3 条 · 随新功能验证</em></div></article>
        <ArrowRight />
        <article className="snapshot"><span><FileJson2 /></span><div><small>本次提测使用</small><b>冒烟组合快照</b><em>21 条 · 固定成员与 revision</em></div></article>
        <ArrowRight />
        <article className="next"><span><Layers3 /></span><div><small>功能稳定后</small><b>冒烟基线 v7</b><em>建议 21 条 · 待人工发布</em></div></article>
      </div>
      <footer><span>只有执行稳定、耗时可控且判定明确的候选才进入 v7；未通过的候选留在新功能用例集。</span><button className="btn" disabled><LockKeyhole />发布冒烟 v7</button></footer>
    </section>
    <section className="td-execution-handoff">
      <header><div><b>提测执行交接</b><small>发布后由测试执行阶段固定各用例集版本并生成一次 TestPlanVersion</small></div><StatusPill tone="neutral">后续阶段</StatusPill></header>
      <div className="td-strategy-row"><span>建议策略</span><div><button className={strategy === 'standard' ? 'active' : ''} aria-pressed={strategy === 'standard'} onClick={() => chooseStrategy('standard')}>标准流程</button><button className={strategy === 'quick' ? 'active' : ''} aria-pressed={strategy === 'quick'} onClick={() => chooseStrategy('quick')}>快速验证</button><button className={strategy === 'full' ? 'active' : ''} aria-pressed={strategy === 'full'} onClick={() => chooseStrategy('full')}>直接全量</button></div><em>{strategy === 'standard' ? '冒烟通过后逐步扩大执行范围' : strategy === 'quick' ? '跳过全量回归，仅验证本次变更与影响范围' : '直接执行当前全量回归固定版本'}</em></div>
      <div className={`td-execution-chain strategy-${strategy}`}>
        <article className="smoke"><span>1</span><div><small>质量门禁</small><b>冒烟测试</b><em>v6 18 条 + 本次候选 3 条</em></div><StatusPill tone="info">组合快照</StatusPill></article>
        <ArrowRight />
        <article className="feature"><span>2</span><div><small>本次变更</small><b>新功能验证</b><em>当前候选 v2 · 28 条</em></div><StatusPill tone="warning">待发布</StatusPill></article>
        <ArrowRight />
        <article className="impact"><span>3</span><div><small>影响范围</small><b>影响回归</b><em>跨 3 个用例集 · 12 条</em></div><StatusPill tone="info">动态组合</StatusPill></article>
        <ArrowRight className="arrow-to-regression" />
        <article className="regression"><span>4</span><div><small>完整基线</small><b>全量回归</b><em>核心回归 v12 · 326 条</em></div><StatusPill tone="success">固定引用</StatusPill></article>
      </div>
      <footer><AlertTriangle /><span><b>本期只生成可执行交接</b><small>第四期不会创建真实测试任务或执行用例。发布成功后，下一阶段才能选择构建、环境与执行策略创建提测计划。</small></span><button className="btn" disabled><Play />创建提测计划</button></footer>
    </section>
  </div>
}

function DataView() {
  const rows = [['DATA-001', '标准有效账号', '账户实体', '内部', 'ready', 'TC-AUTH-001、002'], ['DATA-002', '处于保护状态的账号', '账户状态', '敏感', 'needs_generation', 'TC-AUTH-003'], ['DATA-003', '并发刷新令牌组', '令牌集合', '敏感', 'needs_generation', 'TC-AUTH-004'], ['DATA-004', 'Safari 浏览器环境', '客户端环境', '公开', 'ready', 'TC-AUTH-006']]
  return <div className="td-data-view"><header className="td-canvas-toolbar"><div><b>测试数据需求</b><small>只定义条件、占位符与生成约束，不创建真实数据</small></div><StatusPill tone="info">9 项需求</StatusPill><button className="btn"><Plus />新增数据需求</button></header><div className="td-data-table"><div className="td-data-table-head"><span>数据需求</span><span>实体类型</span><span>敏感级别</span><span>Readiness</span><span>关联用例</span></div>{rows.map(row => <button key={row[0]}><span><i><Database /></i><p><b>{row[1]}</b><small>{row[0]}</small></p></span><em>{row[2]}</em><StatusPill tone={row[3] === '敏感' ? 'warning' : 'neutral'}>{row[3]}</StatusPill><StatusPill tone={row[4] === 'ready' ? 'success' : 'warning'}>{row[4] === 'ready' ? '就绪' : '待生成'}</StatusPill><small>{row[5]}</small></button>)}</div><div className="td-inline-notice info"><ShieldCheck /><span><b>数据安全边界</b><small>这里仅保存数据条件、参数占位符、生成规则和清理要求，不展示真实秘密或生产数据。</small></span></div></div>
}

function CoverageView({ notify }: { notify: Notify }) {
  const gaps = [['REQ-021', '账户保护解除后的首次登录', '未覆盖', '缺少测试点'], ['SOL-012', '审计队列写入失败后的补偿策略', '待确认', '上游方案未明确'], ['TC-AUTH-004', '并发刷新令牌时仅一个请求成功', '阻断', '缺少确定性 oracle']]
  return <div className="td-coverage-view"><header className="td-canvas-toolbar"><div><b>覆盖反向审计</b><small>审计基于当前树 r12、用例 revision 集合与数据需求 Hash</small></div><StatusPill tone="warning">3 个阻断项</StatusPill><button className="btn primary" onClick={() => notify('覆盖审计已重新计算，仍有 3 个阻断项。', 'warning')}><RefreshCw />重新审计</button></header><div className="td-coverage-summary"><div className="td-coverage-donut"><span><strong>91.3%</strong><small>依据覆盖</small></span></div><dl><div><dt>依据项</dt><dd>64</dd></div><div><dt>已覆盖</dt><dd className="success">52</dd></div><div><dt>部分覆盖</dt><dd className="warning">9</dd></div><div><dt>未覆盖</dt><dd className="danger">3</dd></div></dl><div className="td-publish-readiness"><AlertTriangle /><p><b>暂不可发布</b><small>服务端 publishReadiness 返回 3 个 blocker</small></p><button onClick={() => notify('已定位到第一个发布阻断项。')}>逐项处理<ChevronRight /></button></div></div><div className="td-coverage-mode"><button className="active">依据 → 测试点 → 用例</button><button>用例 → 测试点 → 依据</button><span /><select><option>仅看缺口与异常</option><option>查看全部映射</option></select></div><div className="td-gap-list">{gaps.map((gap, index) => <button key={gap[0]}><span className={index === 2 ? 'danger' : 'warning'}>{index === 2 ? <XCircle /> : <AlertTriangle />}</span><p><small>{gap[0]} · {gap[2]}</small><b>{gap[1]}</b><em>{gap[3]}</em></p><StatusPill tone={index === 2 ? 'danger' : 'warning'}>发布阻断</StatusPill><ChevronRight /></button>)}</div></div>
}

function HistoryView({ notify }: { notify: Notify }) {
  return <div className="td-history-view"><header className="td-canvas-toolbar"><div><b>历史用例复用</b><small>冻结来源与当前 revision 保持可追溯差异</small></div><StatusPill tone="info">6 条候选</StatusPill></header><div className="td-history-layout"><section className="td-history-list">{[['TC-OLD-018', '错误密码登录提示', '适用性高', 'unchanged'], ['TC-OLD-021', '连续失败账户锁定', '需修改', 'modified'], ['TC-OLD-024', 'Token 刷新成功', '需修改', 'modified']].map((item, index) => <button key={item[0]} className={index === 1 ? 'active' : ''}><History /><p><b>{item[1]}</b><small>{item[0]} · SmartHub 2026.07 · TCS v1</small></p><StatusPill tone={index === 0 ? 'success' : 'warning'}>{item[2]}</StatusPill></button>)}</section><section className="td-diff-panel"><header><div><small>冻结来源</small><b>TC-OLD-021 · revision 3</b></div><FileDiff /><div><small>当前草稿</small><b>TC-AUTH-003 · revision 6</b></div></header><div className="td-diff-row"><span>前置条件</span><p>账号连续登录失败 <del>3 次</del></p><p>账号在 10 分钟内连续登录失败 <ins>5 次</ins></p></div><div className="td-diff-row"><span>预期结果</span><p>账号被锁定</p><p>账号进入 <ins>30 分钟保护状态</ins>，接口返回统一业务码</p></div><div className="td-diff-row"><span>适用性</span><p>旧密码策略</p><p><ins>已按当前认证方案更新</ins></p></div><footer><button className="btn" onClick={() => notify('来源用例已按 unchanged 关系复用。')}><ArchiveRestore />直接复用</button><button className="btn primary" onClick={() => notify('已创建复制并修改草稿。')}><FileDiff />复制并修改</button></footer></section></div></div>
}

function QuestionsView({ notify }: { notify: Notify }) {
  return <div className="td-questions-view"><header className="td-canvas-toolbar"><div><b>待确认项</b><small>确认结论将追加保存并进入报告与发布门禁</small></div><StatusPill tone="warning">2 项未解决</StatusPill></header>{[['Q-006', '账户保护窗口是否允许管理员提前解除？', '该规则会影响保护状态的等价类和恢复场景。', '产品规则'], ['Q-009', 'Safari 的支持范围按最新两个主版本还是固定版本？', '上游仅写明支持主流浏览器，无法形成可验收的兼容性边界。', '验收标准']].map(item => <article key={item[0]}><span><CircleDot /></span><p><small>{item[0]} · {item[3]}</small><b>{item[1]}</b><em>{item[2]}</em></p><button className="btn" onClick={() => notify(`${item[0]} 已标记为确认处理中。`)}>填写结论</button></article>)}</div>
}

function DetailPanel({ tab, basis, treeNode, testCase, executionMethods, onToggleMethod, caseTitle, setCaseTitle, saving, onSave, approved, notify }: { tab: TabKey; basis: typeof basisItems[number]; treeNode: typeof treeNodes[number]; testCase: typeof cases[number]; executionMethods: ExecutionMethod[]; onToggleMethod: (method: ExecutionMethod) => void; caseTitle: string; setCaseTitle: (value: string) => void; saving: boolean; onSave: () => void; approved: boolean; notify: Notify }) {
  if (tab === 'case-set') return <aside className="td-detail-panel"><header><div><small>候选用例集</small><b>SET-AUTH · v2</b></div><StatusPill tone="warning">待发布</StatusPill></header><div className="td-detail-scroll"><section className="td-set-version-card"><span><FileJson2 /></span><div><small>test-case-set/v1</small><b>登录与身份认证新功能用例集</b><code>contentSha256: pending</code></div></section><div className="td-basis-meta"><p><span>来源设计</span><b>TD-20260807-01</b></p><p><span>候选成员</span><b>28 条</b></p><p><span>冒烟候选</span><b>3 条</b></p><p><span>覆盖审计</span><b>Audit r4</b></p></div><section className="td-detail-section"><h3>发布后固定</h3><button><TestTube2 /><span><small>用例成员</small><b>caseId + revision</b></span><CheckCircle2 /></button><button><Sparkles /><span><small>冒烟建议</small><b>3 条候选关系</b></span><CheckCircle2 /></button><button><ShieldCheck /><span><small>覆盖审计</small><b>成员集合 Hash</b></span><CheckCircle2 /></button></section><section className="td-detail-callout danger"><AlertTriangle /><p><b>3 个发布阻断项</b><small>当前内容不能形成不可变版本，需先补齐覆盖并重新审核。</small></p></section></div><footer><button className="btn" onClick={() => notify('已导出候选用例集预览。')}><Download />导出预览</button><button className="btn primary" onClick={() => notify('仍有 3 个发布阻断项。', 'warning')}><LockKeyhole />发布</button></footer></aside>
  if (tab === 'cases') return <aside className="td-detail-panel td-case-editor"><header><div><small>结构化用例</small><b>{testCase.id}</b></div><button className="icon-btn" aria-label="更多用例操作"><MoreHorizontal /></button></header><div className="td-editor-meta"><StatusPill tone="neutral">revision r6</StatusPill><StatusPill tone={testCase.status === '已通过' ? 'success' : 'warning'}>{testCase.status}</StatusPill><span>{saving ? '正在保存...' : '已保存'}</span></div><div className="td-detail-scroll"><label><span>用例标题</span><input value={caseTitle} onChange={event => setCaseTitle(event.target.value)} /></label><div className="td-method-segment" aria-label="执行方式，可多选"><button type="button" aria-pressed={executionMethods.includes('UI')} className={executionMethods.includes('UI') ? 'active' : ''} onClick={() => onToggleMethod('UI')}><TableProperties />UI</button><button type="button" aria-pressed={executionMethods.includes('API')} className={executionMethods.includes('API') ? 'active' : ''} onClick={() => onToggleMethod('API')}><Braces />API</button></div><div className="td-readonly-grid"><p><span>优先级</span><b>{testCase.priority}</b></p><p><span>来源</span><b>{testCase.origin}</b></p><p><span>测试点</span><b>{testCase.point}</b></p><p><span>执行方式</span><b>{executionMethods.join(' + ')}</b></p></div><label><span>共同前置条件</span><textarea defaultValue="存在状态正常且密码已设置的测试账号；测试环境中的认证服务可用。" /></label>{executionMethods.includes('UI') && <section className="td-step-editor td-method-editor"><header><b><TableProperties />UI 执行流程</b><button><Plus />添加步骤</button></header><article><em>1</em><div><input defaultValue="打开登录页面，输入有效账号与密码" /><textarea defaultValue="输入框展示内容正确，登录按钮可用" /></div><button className="icon-btn" aria-label="UI 步骤操作"><MoreHorizontal /></button></article><article><em>2</em><div><input defaultValue="点击登录按钮" /><textarea defaultValue="页面进入工作台并展示当前用户" /></div><button className="icon-btn" aria-label="UI 步骤操作"><MoreHorizontal /></button></article></section>}{executionMethods.includes('API') && <section className="td-step-editor td-method-editor"><header><b><Braces />API 执行流程</b><button><Plus />添加步骤</button></header><article><em>1</em><div><input defaultValue="POST /api/auth/login，提交账号与密码参数" /><textarea defaultValue="响应 200，返回访问令牌与刷新令牌" /></div><button className="icon-btn" aria-label="API 步骤操作"><MoreHorizontal /></button></article><article><em>2</em><div><input defaultValue="携带访问令牌请求 GET /api/session" /><textarea defaultValue="响应当前用户，身份与登录账号一致" /></div><button className="icon-btn" aria-label="API 步骤操作"><MoreHorizontal /></button></article></section>}<label><span>共同验证检查点</span><textarea defaultValue="UI 与 API 结果指向同一登录会话；产生 auth.login.succeeded 审计事件；无重复令牌。" /></label><label><span>清理要求</span><input defaultValue="撤销测试会话并清理浏览器 Cookie" /></label></div><footer><button className="btn" onClick={() => notify('用例已提交人工审核。')}>提交审核</button><button className="btn primary" onClick={onSave} disabled={saving}>{saving ? <RefreshCw className="rotating" /> : <Check />}保存草稿</button></footer></aside>
  if (tab === 'tree') return <aside className="td-detail-panel"><header><div><small>测试点节点</small><b>{treeNode.id}</b></div><StatusPill tone={approved ? 'success' : 'warning'}>{approved ? '树 r12 已批准' : '编辑中'}</StatusPill></header><div className="td-detail-scroll"><label><span>测试点名称</span><input defaultValue={treeNode.title} /></label><label><span>测试维度</span><select defaultValue="功能"><option>功能</option><option>性能</option><option>稳定性</option><option>兼容性</option><option>安全</option></select></label><div className="td-method-segment"><button className={treeNode.method.includes('UI') ? 'active' : ''}>UI</button><button className={treeNode.method.includes('API') ? 'active' : ''}>API</button></div><label><span>优先级</span><select defaultValue={treeNode.priority}><option>P0</option><option>P1</option><option>P2</option></select></label><label><span>设计说明</span><textarea defaultValue="覆盖正常路径、输入校验、错误反馈以及重复提交场景。" /></label><section className="td-source-links"><header><b>来源关系</b><StatusPill tone="neutral">2 项</StatusPill></header><button><Link2 /><span><b>REQ-018</b><small>用户可通过账号密码登录系统</small></span><ChevronRight /></button><button><Link2 /><span><b>SOL-008</b><small>认证令牌采用双 Token 轮换机制</small></span><ChevronRight /></button></section></div><footer><button className="btn" onClick={() => notify('节点已标记为不适用。', 'warning')}>标记不适用</button><button className="btn primary" onClick={() => notify('节点修改已保存为新的树 revision。')}><Check />保存节点</button></footer></aside>
  if (tab === 'coverage') return <aside className="td-detail-panel"><header><div><small>覆盖缺口</small><b>REQ-021</b></div><StatusPill tone="danger">发布阻断</StatusPill></header><div className="td-detail-scroll"><section className="td-detail-callout danger"><AlertTriangle /><p><b>账户保护解除后的首次登录未覆盖</b><small>当前依据项仅覆盖保护触发与保护期间行为，未验证自动解除后的状态恢复。</small></p></section><section className="td-detail-section"><h3>关联链路</h3><button><FileText /><span><small>依据</small><b>REQ-021 账户保护策略</b></span></button><button><Network /><span><small>测试点</small><b>TP-004 账户保护</b></span></button><button className="missing"><TestTube2 /><span><small>用例</small><b>缺少恢复路径用例</b></span></button></section><label><span>处置结论</span><textarea placeholder="填写处理说明或不可测原因" /></label></div><footer><button className="btn" onClick={() => notify('已将该依据标记为待确认。')}>标记待确认</button><button className="btn primary" onClick={() => notify('已基于缺口创建用例草稿。')}><Plus />创建用例</button></footer></aside>
  return <aside className="td-detail-panel"><header><div><small>{basis.kind} · 固定来源</small><b>{basis.id}</b></div><StatusPill tone="success"><LockKeyhole />Hash 已固定</StatusPill></header><div className="td-detail-scroll"><h2>{basis.title}</h2><div className="td-basis-meta"><p><span>来源</span><b>{basis.source}</b></p><p><span>覆盖状态</span><b>{basis.status}</b></p><p><span>内容 Hash</span><code>sha256:9f2a84...e31c</code></p><p><span>固定时间</span><b>2026-08-07 13:08</b></p></div><section className="td-source-quote"><header><FileText /><b>固定原文</b><span>L128-L143</span></header><p>当用户连续输入错误密码达到策略阈值时，系统应进入账户保护状态。保护期间所有登录请求返回统一提示，不得泄漏账号存在性。</p></section><section className="td-detail-section"><h3>派生关系</h3><button><Network /><span><small>测试点</small><b>3 个直接关联节点</b></span><ChevronRight /></button><button><TestTube2 /><span><small>测试用例</small><b>5 条当前用例</b></span><ChevronRight /></button></section></div><footer><button className="btn full" onClick={() => notify('已定位到固定来源原文。')}><Link2 />查看来源定位</button></footer></aside>
}
