import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Activity, AlertTriangle, ArchiveRestore, ArrowDown, ArrowRight, ArrowUp, Bot, Braces, Check,
  CheckCircle2, ChevronDown, ChevronRight, CircleDot, Clock3, Database, Download,
  Eye, FileDiff, FileJson2, FileText, Filter, GitBranch, History, Layers3, Link2, ListChecks,
  LockKeyhole, MoreHorizontal, Network, PanelRightClose, Pencil, Play, Plus, RefreshCw,
  MessageSquareText, Search, ShieldCheck, Sparkles, Split, TableProperties, TestTube2,
  Trash2, Users, Wrench, X, XCircle,
} from 'lucide-react'
import type { ProjectVersion } from './project-version-api'
import {
  actOnTestDesignConfirmation, actOnTestDesignFinding, applyTestDesignGateDecision, batchReviewTestDesignCases,
  cancelTestDesignRun, createExecutionHandoff, createTestDesign, createTestDesignCase, createTestDesignRun, approveTestPointTree,
  fullRerunTestDesign,
  loadExecutionHandoffs, loadImpactedRegression, loadProjectTestCaseCatalog, loadProjectTestSuites, loadSmokeCandidates,
  loadTestCaseSetVersion, loadTestDesign, loadTestDesignCase, loadTestDesignInputs, loadTestDesignRun,
  loadTestDesigns, publishTestCaseSet, loadTestPointTree, reAuditTestDesignRun, replaceTestDataRequirements,
  resynthesizeTestDesign, retryTestDesignNode, reviseTestDesignScope, reviewSmokeCandidate, reviewTestDesignCase,
  saveImpactedRegression, testCaseSetExportUrl, updateTestDesignCase, updateTestPointTree,
  type TestCaseContent, type TestDesign, type TestDesignCase, type TestDesignCoverageAudit,
  type TestDesignInputCandidates, type TestDesignWorkflowRun, type TestPointNode, type TestPointTreeOperation,
  type ImpactedRegression, type ProjectTestCaseCatalogItem, type SmokeCandidate, type TestSuiteVersion, type TestExecutionHandoff,
} from './test-design-api'
import { resolveTestDesignRoute } from './test-design-state'
import { normalizeTestAnalysisGroups } from './test-design-analysis'
import './test-design.css'
import './test-design-collection.css'

type NotifyTone = 'success' | 'error' | 'warning'
type Notify = (message: string, tone?: NotifyTone) => void
type BasisMode = 'review_baseline' | 'knowledge_assets'
type ViewMode = 'list' | 'create' | 'workspace' | 'route-error'
type CollectionView = 'designs' | 'library' | 'sets'
type TabKey = 'overview' | 'workflow' | 'analysis' | 'retrieval' | 'tree' | 'cases' | 'case-set' | 'data' | 'coverage' | 'history' | 'questions'
type ExecutionMethod = 'UI' | 'API'
type TestDimension = '功能' | '性能' | '稳定性' | '兼容性' | '安全'

type Props = {
  projectVersion: ProjectVersion | null
  onManageVersions: () => void
  notify: Notify
}

type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'
type SaveState = 'clean' | 'dirty' | 'saved' | 'failed' | 'conflict'
type TreeNode = typeof treeNodes[number]
type CaseItem = typeof cases[number]
type MethodDraft = {
  spec: string
  steps: Array<{ action: string; expected: string }>
  checks: string
  readiness: 'ready' | 'blocked' | 'needs_confirmation'
  automationHint: 'recommended' | 'optional' | 'manual'
}
type CaseDraft = {
  title: string
  objective: string
  dimension: TestDimension
  methods: ExecutionMethod[]
  preconditions: string
  dataRefs: string
  dependencies: string
  sharedChecks: string
  postconditions: string
  cleanup: string
  methodDrafts: Record<ExecutionMethod, MethodDraft>
}

const tabKeys: TabKey[] = ['overview', 'workflow', 'analysis', 'retrieval', 'tree', 'cases', 'case-set', 'data', 'coverage', 'history', 'questions']
const testDimensions: TestDimension[] = ['功能', '性能', '稳定性', '兼容性', '安全']
const dimensionClasses: Record<TestDimension, string> = {
  功能: 'functional',
  性能: 'performance',
  稳定性: 'stability',
  兼容性: 'compatibility',
  安全: 'security',
}

const tabs: Array<{ key: TabKey; label: string }> = [
  { key: 'overview', label: '概览' },
  { key: 'workflow', label: '工作流' },
  { key: 'analysis', label: '依据解构' },
  { key: 'retrieval', label: '知识召回' },
  { key: 'tree', label: '测试点树' },
  { key: 'cases', label: '测试用例' },
  { key: 'case-set', label: '用例集' },
  { key: 'data', label: '测试数据' },
  { key: 'coverage', label: '覆盖审计' },
  { key: 'history', label: '历史复用' },
  { key: 'questions', label: '待确认项' },
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

const knowledgeBasisItems = [
  { id: 'KBP-001', kind: '知识基线项', title: '账户保护采用滑动窗口计数', source: '认证服务技术设计 v5 · L128-L143', status: '已覆盖' },
  { id: 'KBP-002', kind: '知识基线项', title: '受保护账户返回统一业务码', source: 'Auth API 规范 v3 · /auth/login', status: '部分覆盖' },
  { id: 'KBP-003', kind: '资料冲突', title: '浏览器支持范围缺少固定版本', source: '身份认证需求 v8 · 兼容性', status: '待确认' },
]

const treeNodes = [
  { id: 'TP-001', level: 0, title: '身份认证', count: 18, priority: 'P0', method: 'UI + API', dimension: '功能' as TestDimension, expanded: true },
  { id: 'TP-003', level: 1, title: '账号密码登录', count: 7, priority: 'P0', method: 'UI', dimension: '功能' as TestDimension, expanded: true },
  { id: 'TP-008', level: 2, title: '有效账号完成登录', count: 2, priority: 'P0', method: 'UI', dimension: '功能' as TestDimension },
  { id: 'TP-009', level: 2, title: '错误密码提示与重试', count: 3, priority: 'P0', method: 'UI', dimension: '功能' as TestDimension },
  { id: 'TP-010', level: 2, title: '表单边界与防重复提交', count: 2, priority: 'P1', method: 'UI', dimension: '功能' as TestDimension },
  { id: 'TP-004', level: 1, title: '账户保护', count: 6, priority: 'P0', method: 'API', dimension: '安全' as TestDimension, expanded: false },
  { id: 'TP-005', level: 1, title: '令牌轮换', count: 5, priority: 'P1', method: 'API', dimension: '稳定性' as TestDimension, expanded: false },
  { id: 'TP-002', level: 0, title: '可靠性与安全', count: 12, priority: 'P1', method: 'UI + API', dimension: '稳定性' as TestDimension, expanded: false },
  { id: 'TP-006', level: 0, title: '兼容性', count: 8, priority: 'P2', method: 'UI', dimension: '兼容性' as TestDimension, expanded: false },
  { id: 'TP-007', level: 0, title: '认证服务性能', count: 4, priority: 'P1', method: 'API', dimension: '性能' as TestDimension, expanded: false },
]

const cases = [
  { id: 'TC-AUTH-001', title: '有效账号密码登录成功', point: 'TP-008', dimension: '功能' as TestDimension, methods: ['UI', 'API'] as ExecutionMethod[], priority: 'P0', status: '已通过', readiness: '就绪', origin: 'AI 生成', smokeCandidate: true },
  { id: 'TC-AUTH-002', title: '错误密码登录失败并显示明确提示', point: 'TP-009', dimension: '功能' as TestDimension, methods: ['UI'] as ExecutionMethod[], priority: 'P0', status: '已通过', readiness: '就绪', origin: '历史复用', smokeCandidate: true },
  { id: 'TC-AUTH-003', title: '连续五次失败后账户进入保护状态', point: 'TP-004', dimension: '安全' as TestDimension, methods: ['API'] as ExecutionMethod[], priority: 'P0', status: '审核中', readiness: '待确认', origin: 'AI 生成', smokeCandidate: true },
  { id: 'TC-AUTH-004', title: '并发刷新令牌时仅一个请求成功', point: 'TP-005', dimension: '稳定性' as TestDimension, methods: ['API'] as ExecutionMethod[], priority: 'P1', status: '需修订', readiness: '阻塞', origin: '复制并修改' },
  { id: 'TC-AUTH-005', title: '登录按钮防止连续重复提交', point: 'TP-010', dimension: '功能' as TestDimension, methods: ['UI'] as ExecutionMethod[], priority: 'P1', status: '草稿', readiness: '就绪', origin: 'AI 生成' },
  { id: 'TC-AUTH-006', title: 'Safari 最新两个主版本完成登录', point: 'TP-006', dimension: '兼容性' as TestDimension, methods: ['UI'] as ExecutionMethod[], priority: 'P2', status: '草稿', readiness: '就绪', origin: 'AI 生成' },
  { id: 'TC-AUTH-007', title: '峰值并发登录满足响应时间目标', point: 'TP-007', dimension: '性能' as TestDimension, methods: ['API'] as ExecutionMethod[], priority: 'P1', status: '草稿', readiness: '待确认', origin: 'AI 生成' },
]

const workflowNodes = [
  { role: '测试分析 Agent', subtitle: '依据解构与召回计划', state: '成功', meta: 'attempt 1 · glm-4.5-air · 2m 18s', time: '13:08:12 - 13:10:30', degraded: '未降级', className: 'analysis' },
  { role: '功能设计 Agent', subtitle: '功能测试点发散', state: '成功', meta: 'attempt 1 · glm-4.5-air · 3m 42s', time: '13:14:02 - 13:17:44', degraded: '未降级', className: 'functional' },
  { role: '非功能设计 Agent', subtitle: '专项测试点发散', state: '成功', meta: 'attempt 1 · glm-4.5-air · 3m 11s', time: '13:14:02 - 13:17:13', degraded: '未降级', className: 'nonfunctional' },
  { role: '用例综合 Agent', subtitle: '用例与数据需求具象化', state: '成功', meta: 'attempt 2 · glm-4.5-air · 5m 06s', time: '14:19:32 - 14:24:38', degraded: '未降级', className: 'synthesis' },
]

function createMethodDraft(method: ExecutionMethod): MethodDraft {
  return method === 'UI'
    ? {
        spec: '起始路由 /login；角色为普通用户；Chrome 1440 x 900；通过可访问名称定位表单控件。',
        steps: [
          { action: '打开登录页并输入有效账号与密码', expected: '账号与密码字段展示正确，登录按钮可用' },
          { action: '点击登录按钮', expected: '页面进入工作台并展示当前用户' },
        ],
        checks: '页面会话、当前用户和登录成功审计事件保持一致。',
        readiness: 'ready',
        automationHint: 'recommended',
      }
    : {
        spec: 'HTTPS POST /api/auth/login；使用 JSON Body；不携带已有会话。',
        steps: [
          { action: 'POST /api/auth/login，提交账号与密码参数', expected: '响应 200，返回访问令牌与刷新令牌' },
          { action: '携带访问令牌请求 GET /api/session', expected: '响应当前用户，身份与登录账号一致' },
        ],
        checks: '响应 Schema、令牌声明和 auth.login.succeeded 事件均满足约束。',
        readiness: 'ready',
        automationHint: 'recommended',
      }
}

function createEmptyMethodDraft(): MethodDraft {
  return { spec: '', steps: [], checks: '', readiness: 'needs_confirmation', automationHint: 'manual' }
}

function createCaseDraft(item: CaseItem): CaseDraft {
  return {
    title: item.title,
    objective: `验证“${item.title}”在已固定测试依据下具备明确且可判定的结果。`,
    dimension: item.dimension,
    methods: [...item.methods],
    preconditions: '存在状态正常且密码已设置的测试账号；测试环境中的认证服务可用。',
    dataRefs: 'DATA-001 标准有效账号',
    dependencies: '无前置用例依赖',
    sharedChecks: 'UI 与 API 结果指向同一登录会话；无重复令牌。',
    postconditions: '保留本次登录审计事件用于结果核对。',
    cleanup: '撤销测试会话并清理浏览器 Cookie。',
    methodDrafts: { UI: createMethodDraft('UI'), API: createMethodDraft('API') },
  }
}

function readPreviewRoute() {
  return resolveTestDesignRoute(typeof window === 'undefined' ? null : new URL(window.location.href))
}

function StatusPill({ children, tone = 'neutral' }: { children: ReactNode; tone?: StatusTone }) {
  return <span className={`td-status ${tone}`}>{children}</span>
}

function DimensionTag({ dimension }: { dimension: TestDimension }) {
  return <span className={`td-dimension-tag ${dimensionClasses[dimension]}`}>{dimension}</span>
}

function setRouteContext(params: Record<string, string | null>) {
  const url = new URL(window.location.href)
  Object.entries(params).forEach(([key, value]) => value ? url.searchParams.set(key, value) : url.searchParams.delete(key))
  window.history.pushState({}, '', url)
}

const nodeLabels: Record<string, string> = {
  test_analysis: '测试分析',
  scope_gate: '范围确认门禁',
  functional_design: '功能测试设计',
  non_functional_design: '非功能测试设计',
  tree_merge: '测试点树归并',
  tree_gate: '测试点树确认门禁',
  test_case_synthesis: '测试用例具象化',
  coverage_audit: '覆盖反向审计',
  completed: '已完成',
  cancelled: '已取消',
  failed: '执行失败',
}

const testDesignEventLabels: Record<string, string> = {
  runtime_initialized: 'Runtime 初始化',
  agent_start: 'Agent 开始',
  agent_end: 'Agent 本轮结束',
  turn_start: 'Turn 开始',
  turn_end: 'Turn 结束',
  message_start: '消息开始',
  message_update: '消息流更新',
  message_end: '消息完成',
  tool_execution_start: '工具调用开始',
  tool_execution_update: '工具调用更新',
  tool_execution_end: '工具调用结束',
  result_submission_required: '进入结果提交窗口',
  result_submission_retry: '要求重新提交结果',
  model_retry_scheduled: '模型请求自动重试',
}

function nodeLabel(value: string) { return nodeLabels[value] ?? value }
function nodeStatusLabel(value: string) { return ({ pending: '等待', queued: '已排队', running: '运行中', waiting_gate: '等待确认', succeeded: '成功', failed: '失败', cancelled: '已取消', stale: '已过期' } as Record<string, string>)[value] ?? value }
function runStatusLabel(value?: string) { return value ? ({ queued: '已排队', running: '运行中', waiting_gate: '等待确认', succeeded: '已完成', failed: '运行失败', cancelled: '已取消' } as Record<string, string>)[value] ?? value : '尚未运行' }
function runStatusTone(value?: string): StatusTone { return value === 'failed' || value === 'cancelled' ? 'danger' : value === 'succeeded' ? 'success' : value === 'running' || value === 'queued' ? 'info' : value === 'waiting_gate' ? 'warning' : 'neutral' }
function runStageLabel(stage?: string, status?: string) { return status === 'failed' ? '执行失败' : stage ? nodeLabel(stage) : '尚未开始' }
function runErrorMessage(error?: string, code?: string) { const value = error?.trim() || '服务端未记录可公开的失败详情。'; return code && value.startsWith(`${code}:`) ? value.slice(code.length + 1).trim() : value }
function formatRunTime(value?: string) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未记录' }
function shortId(value: string) { return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value }
function shortHash(value: string) { return value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value }
function recordOf(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {} }
function arrayOf(value: unknown) { return Array.isArray(value) ? value : [] }
function currentTreeNodes(run: TestDesignWorkflowRun) { return run.testPointTree?.revisions.find(item => item.revision === run.testPointTree?.currentRevision)?.nodes.filter(item => !item.deleted) ?? [] }
function currentCaseContent(testCase: TestDesignCase) { return testCase.revisions.find(item => item.revision === testCase.currentRevision)?.content }
function latestCoverageAudit(run: TestDesignWorkflowRun) { return run.coverageAudits.at(-1) }
function currentNodeArtifact(run: TestDesignWorkflowRun, nodeKey: string) {
  const outputArtifactId = run.nodeRuns.find(item => item.nodeKey === nodeKey)?.outputArtifactId
  if (outputArtifactId) return run.artifacts.find(item => item.id === outputArtifactId)
  return run.artifacts.filter(item => item.nodeKey === nodeKey).sort((left, right) => right.generation - left.generation || right.createdAt.localeCompare(left.createdAt))[0]
}
function analysisGroups(run: TestDesignWorkflowRun) {
  return normalizeTestAnalysisGroups(currentNodeArtifact(run, 'test_analysis')?.content)
}
function analysisItemCount(run: TestDesignWorkflowRun) { return analysisGroups(run).reduce((total, group) => total + group.items.length, 0) }
function dataRequirementCount(run: TestDesignWorkflowRun) { return run.dataSetVersions.at(-1)?.requirements.length ?? 0 }
function canPublishRun(run?: TestDesignWorkflowRun | null) { const audit = run ? latestCoverageAudit(run) : undefined; return Boolean(run?.status === 'succeeded' && audit?.status === 'valid' && audit.blockers.length === 0 && run.testCases.length > 0) }
function runTabCount(tab: TabKey, run: TestDesignWorkflowRun) {
  if (tab === 'overview' || tab === 'workflow') return undefined
  if (tab === 'analysis') return analysisItemCount(run)
  if (tab === 'retrieval') return run.retrievalSnapshot.hits.length
  if (tab === 'tree') return currentTreeNodes(run).length
  if (tab === 'cases') return run.testCases.length
  if (tab === 'case-set') return run.caseSetVersions?.length ?? 0
  if (tab === 'data') return dataRequirementCount(run)
  if (tab === 'coverage') return run.coverageAudits.length
  if (tab === 'history') return run.historicalSnapshot.items.length
  return run.confirmationItems.length
}

export function TestDesignPage({ projectVersion, onManageVersions, notify }: Props) {
  const initialRoute = readPreviewRoute()
  const [view, setView] = useState<ViewMode>(initialRoute.view)
  const [collectionView, setCollectionView] = useState<CollectionView>(initialRoute.collectionView)
  const [tab, setTab] = useState<TabKey>(initialRoute.tab)
  const [activeContext, setActiveContext] = useState({ testDesignId: initialRoute.testDesignId, workflowRunId: initialRoute.workflowRunId })
  const [designs, setDesigns] = useState<TestDesign[]>([])
  const [designsLoading, setDesignsLoading] = useState(false)
  const [designInputs, setDesignInputs] = useState<TestDesignInputCandidates | null>(null)
  const [designInputsLoading, setDesignInputsLoading] = useState(false)
  const [designInputsError, setDesignInputsError] = useState('')
  const [designInputsRequest, setDesignInputsRequest] = useState(0)
  const [activeDesign, setActiveDesign] = useState<TestDesign | null>(null)
  const [activeRun, setActiveRun] = useState<TestDesignWorkflowRun | null>(null)
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [workspaceRefreshing, setWorkspaceRefreshing] = useState(false)
  const [workspaceError, setWorkspaceError] = useState('')
  const [basisMode, setBasisMode] = useState<BasisMode>('review_baseline')
  const [selectedBasis, setSelectedBasis] = useState(basisItems[0].id)
  const [selectedTreeNode, setSelectedTreeNode] = useState('TP-009')
  const [selectedCase, setSelectedCase] = useState(cases[0].id)
  const [caseFilter, setCaseFilter] = useState('全部方式')
  const [caseDimensionFilter, setCaseDimensionFilter] = useState('全部维度')
  const [caseQuery, setCaseQuery] = useState('')
  const [rightOpen, setRightOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 900)
  const [treeApproved, setTreeApproved] = useState(true)
  const [treeRevision, setTreeRevision] = useState(12)
  const [treeDirty, setTreeDirty] = useState(false)
  const [treeConflict, setTreeConflict] = useState(false)
  const [treeNodeList, setTreeNodeList] = useState<TreeNode[]>(treeNodes)
  const [createStep, setCreateStep] = useState(1)
  const [designName, setDesignName] = useState('')
  const [knowledgeGoal, setKnowledgeGoal] = useState('')
  const [selectedAssets, setSelectedAssets] = useState<string[]>([])
  const [augmentation, setAugmentation] = useState('disabled')
  const [augmentationAssets, setAugmentationAssets] = useState<string[]>([])
  const [historyEnabled, setHistoryEnabled] = useState(false)
  const [caseDrafts, setCaseDrafts] = useState<Record<string, CaseDraft>>(() => Object.fromEntries(cases.map(item => [item.id, createCaseDraft(item)])))
  const [caseSaveStates, setCaseSaveStates] = useState<Record<string, SaveState>>(() => Object.fromEntries(cases.map(item => [item.id, 'clean'])))
  const [caseRevisions, setCaseRevisions] = useState<Record<string, number>>(() => Object.fromEntries(cases.map(item => [item.id, 6])))
  const [gateSubmitting, setGateSubmitting] = useState(false)
  const [selectedRunCaseId, setSelectedRunCaseId] = useState<string | null>(null)
  const [newCasePointId, setNewCasePointId] = useState<string | null>(null)

  const visibleBasisItems = basisMode === 'review_baseline' ? basisItems : knowledgeBasisItems
  const activeBasis = visibleBasisItems.find(item => item.id === selectedBasis) ?? visibleBasisItems[0]
  const activeTreeNode = treeNodeList.find(item => item.id === selectedTreeNode) ?? treeNodeList[0]
  const activeCase = cases.find(item => item.id === selectedCase) ?? cases[0]
  const activeCaseDraft = caseDrafts[activeCase.id] ?? createCaseDraft(activeCase)
  const filteredCases = useMemo(() => cases.map(item => ({ ...item, methods: caseDrafts[item.id]?.methods ?? item.methods, dimension: caseDrafts[item.id]?.dimension ?? item.dimension })).filter(item => {
    const methodMatches = caseFilter === '全部方式' || item.methods.includes(caseFilter as ExecutionMethod)
    const dimensionMatches = caseDimensionFilter === '全部维度' || item.dimension === caseDimensionFilter
    const queryMatches = !caseQuery.trim() || `${item.id}${caseDrafts[item.id]?.title ?? item.title}`.toLowerCase().includes(caseQuery.trim().toLowerCase())
    return methodMatches && dimensionMatches && queryMatches
  }), [caseDimensionFilter, caseDrafts, caseFilter, caseQuery])

  useEffect(() => {
    if (!projectVersion) return
    let current = true
    setDesigns([])
    setDesignInputs(null)
    setDesignInputsError('')
    setDesignsLoading(true)
    void loadTestDesigns(projectVersion.id)
      .then(designResponse => { if (current) setDesigns(designResponse.items) })
      .catch(error => notify(error instanceof Error ? error.message : '测试设计数据加载失败', 'error'))
      .finally(() => { if (current) setDesignsLoading(false) })
    return () => { current = false }
  }, [notify, projectVersion?.id])

  useEffect(() => {
    if (!projectVersion || view !== 'create' || designInputs) return
    let current = true
    setDesignInputsLoading(true)
    setDesignInputsError('')
    void loadTestDesignInputs(projectVersion.id)
      .then(value => { if (current) setDesignInputs(value) })
      .catch(error => { if (current) setDesignInputsError(error instanceof Error ? error.message : '测试设计候选数据加载失败') })
      .finally(() => { if (current) setDesignInputsLoading(false) })
    return () => { current = false }
  }, [designInputs, designInputsRequest, projectVersion?.id, view])

  useEffect(() => {
    if (!projectVersion || view !== 'workspace' || !activeContext.testDesignId || !activeContext.workflowRunId) return
    let current = true
    setActiveRun(null)
    setWorkspaceLoading(true)
    setWorkspaceError('')
    void Promise.all([
      loadTestDesign(projectVersion.id, activeContext.testDesignId),
      loadTestDesignRun(projectVersion.id, activeContext.testDesignId, activeContext.workflowRunId),
    ]).then(([design, run]) => {
      if (!current) return
      setActiveDesign(design)
      setActiveRun(run)
      setBasisMode(design.basisMode)
    }).catch(error => {
      if (!current) return
      setActiveDesign(null)
      setActiveRun(null)
      setWorkspaceError(error instanceof Error ? error.message : '测试设计运行加载失败')
    }).finally(() => { if (current) setWorkspaceLoading(false) })
    return () => { current = false }
  }, [activeContext.testDesignId, activeContext.workflowRunId, projectVersion?.id, view])

  useEffect(() => {
    if (!activeRun) return
    const available = activeRun.testCases.filter(item => !item.tombstonedAt)
    if (selectedRunCaseId === '__new__' || available.some(item => item.id === selectedRunCaseId)) return
    setSelectedRunCaseId(available[0]?.id ?? null)
  }, [activeRun, selectedRunCaseId])

  useEffect(() => {
    if (!projectVersion || view !== 'workspace' || !activeContext.testDesignId || !activeContext.workflowRunId || !activeRun || !['queued', 'running'].includes(activeRun.status)) return
    let current = true
    let timer: number | undefined
    const poll = async () => {
      try {
        const run = await loadTestDesignRun(projectVersion.id, activeContext.testDesignId!, activeContext.workflowRunId!)
        if (!current) return
        setActiveRun(run)
        if (['queued', 'running'].includes(run.status)) timer = window.setTimeout(() => void poll(), 1_500)
      } catch {
        if (current) timer = window.setTimeout(() => void poll(), 3_000)
      }
    }
    timer = window.setTimeout(() => void poll(), 800)
    return () => { current = false; if (timer !== undefined) window.clearTimeout(timer) }
  }, [activeContext.testDesignId, activeContext.workflowRunId, activeRun?.status, projectVersion?.id, view])

  useEffect(() => {
    const restore = () => {
      const route = readPreviewRoute()
      setView(route.view)
      setTab(route.tab)
      setCollectionView(route.collectionView)
      setActiveContext({ testDesignId: route.testDesignId, workflowRunId: route.workflowRunId })
    }
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [])

  const openWorkspace = (candidate?: TestDesign) => {
    const design = candidate ?? designs.find(item => item.latestRun)
    if (!design?.latestRun) {
      notify('该测试设计还没有可查看的工作流运行。', 'warning')
      return
    }
    setActiveDesign(design)
    setActiveRun(null)
    setActiveContext({ testDesignId: design.id, workflowRunId: design.latestRun.id })
    setView('workspace')
    setRouteContext({ testDesignId: design.id, workflowRunId: design.latestRun.id, tab, create: null })
  }
  const returnToList = () => {
    setView('list')
    setActiveContext({ testDesignId: null, workflowRunId: null })
    setActiveDesign(null)
    setActiveRun(null)
    setWorkspaceError('')
    setRouteContext({ testDesignId: null, workflowRunId: null, tab: null, create: null })
  }
  const resetCreateDraft = () => {
    setCreateStep(1)
    setDesignName('')
    setKnowledgeGoal('')
    setBasisMode('review_baseline')
    setSelectedAssets([])
    setAugmentation('disabled')
    setAugmentationAssets([])
    setHistoryEnabled(false)
  }
  const openCreate = () => {
    resetCreateDraft()
    setView('create')
    setRouteContext({ create: '1' })
  }
  const closeCreate = () => {
    resetCreateDraft()
    setView('list')
    setRouteContext({ create: null })
  }
  const refreshWorkspace = async () => {
    if (!projectVersion || !activeContext.testDesignId || !activeContext.workflowRunId) return
    setWorkspaceRefreshing(true)
    try {
      const [design, run] = await Promise.all([
        loadTestDesign(projectVersion.id, activeContext.testDesignId),
        loadTestDesignRun(projectVersion.id, activeContext.testDesignId, activeContext.workflowRunId),
      ])
      setActiveDesign(design)
      setActiveRun(run)
    } catch (error) {
      notify(error instanceof Error ? error.message : '测试设计运行刷新失败', 'error')
    } finally {
      setWorkspaceRefreshing(false)
    }
  }
  const refreshRunOnly = async () => {
    if (!projectVersion || !activeContext.testDesignId || !activeContext.workflowRunId) return
    const run = await loadTestDesignRun(projectVersion.id, activeContext.testDesignId, activeContext.workflowRunId)
    setActiveRun(run)
  }
  const openRunCase = (caseId: string) => {
    setSelectedRunCaseId(caseId)
    setNewCasePointId(null)
    setTab('cases')
    setRouteContext({ tab: 'cases' })
    setRightOpen(true)
  }
  const openNewRunCase = (pointId?: string) => {
    setSelectedRunCaseId('__new__')
    setNewCasePointId(pointId ?? currentTreeNodes(activeRun!).find(item => item.applicability !== 'not_applicable')?.nodeId ?? null)
    setTab('cases')
    setRouteContext({ tab: 'cases' })
    setRightOpen(true)
  }
  const submitGateDecision = async (gateKey: 'scope' | 'test-point-tree', decision: 'approved' | 'rejected', comment: string) => {
    if (!projectVersion || !activeContext.testDesignId || !activeContext.workflowRunId || !activeRun) return
    const gateNodeKey = gateKey === 'scope' ? 'scope_gate' : 'tree_gate'
    const gateNode = activeRun.nodeRuns.find(item => item.nodeKey === gateNodeKey)
    const target = gateKey === 'scope'
      ? currentNodeArtifact(activeRun, 'test_analysis')
      : activeRun.testPointTree
    if (!gateNode || gateNode.status !== 'waiting_gate' || !target) {
      notify('当前门禁已变化，请刷新工作流后再操作。', 'warning')
      return
    }
    setGateSubmitting(true)
    try {
      const nextRun = await applyTestDesignGateDecision(projectVersion.id, activeContext.testDesignId, activeContext.workflowRunId, gateKey, {
        targetId: target.id,
        targetRevision: gateKey === 'scope' ? (target as { generation: number }).generation : (target as { currentRevision: number }).currentRevision,
        expectedVersion: activeRun.gateDecisions.filter(item => item.gateKey === gateKey).length,
        decision,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      })
      setActiveRun(nextRun)
      notify(decision === 'approved' ? `${gateKey === 'scope' ? '测试范围' : '测试点树'}已确认，工作流将继续执行。` : `${gateKey === 'scope' ? '测试范围' : '测试点树'}已驳回，运行已停止。`, decision === 'approved' ? 'success' : 'warning')
    } catch (error) {
      notify(error instanceof Error ? error.message : '门禁决策提交失败', 'error')
    } finally {
      setGateSubmitting(false)
    }
  }
  const runAction = async (action: 'cancel' | 'revise_scope' | 'retry_functional' | 'retry_non_functional' | 'resynthesize' | 'full_rerun') => {
    if (!projectVersion || !activeRun || !activeContext.testDesignId) return
    if ((action === 'cancel' || action === 'full_rerun') && !window.confirm(action === 'cancel' ? '取消后当前运行将进入终态，是否继续？' : '全部重跑会创建新的固定输入运行，原运行保留，是否继续？')) return
    setWorkspaceLoading(true)
    try {
      const scope = [projectVersion.id, activeContext.testDesignId, activeRun.id] as const
      const next = action === 'cancel' ? await cancelTestDesignRun(...scope)
        : action === 'revise_scope' ? await reviseTestDesignScope(...scope)
          : action === 'retry_functional' ? await retryTestDesignNode(...scope, 'functional_design')
            : action === 'retry_non_functional' ? await retryTestDesignNode(...scope, 'non_functional_design')
              : action === 'resynthesize' ? await resynthesizeTestDesign(...scope)
                : await fullRerunTestDesign(...scope)
      setActiveRun(next)
      if (next.id !== activeRun.id) { setActiveContext({ testDesignId: activeContext.testDesignId, workflowRunId: next.id }); setRouteContext({ testDesignId: activeContext.testDesignId, workflowRunId: next.id, tab: 'workflow' }) }
      notify(action === 'full_rerun' ? '已创建新的全部重跑 Run，原运行保持不变。' : '运行恢复动作已提交。', 'success')
    } catch (error) { notify(error instanceof Error ? error.message : '运行恢复动作失败', 'error') }
    finally { setWorkspaceLoading(false) }
  }
  const startDesign = async (input: Record<string, unknown>) => {
    if (!projectVersion) throw new Error('请先选择项目版本')
    const projectVersionId = projectVersion.id
    const design = await createTestDesign(projectVersionId, input)
    const run = await createTestDesignRun(projectVersionId, design.id)
    const created: TestDesign = { ...design, latestRun: { id: run.id, testDesignId: design.id, projectVersionId, status: run.status, stage: 'test_analysis', progress: 0, createdAt: new Date().toISOString() } }
    setDesigns(current => [created, ...current.filter(item => item.id !== created.id)])
    notify('测试设计已创建，并已提交真实工作流运行。')
    resetCreateDraft()
    openWorkspace(created)
  }
  const selectTab = (next: TabKey) => {
    setTab(next)
    setRouteContext({ tab: next })
  }
  const selectCollectionView = (next: CollectionView) => {
    setCollectionView(next)
    setRouteContext({ assetView: next })
  }
  const changeBasisMode = (next: BasisMode) => {
    if (next === basisMode) return
    setBasisMode(next)
    setSelectedBasis(next === 'review_baseline' ? basisItems[0].id : knowledgeBasisItems[0].id)
    setCreateStep(1)
    setKnowledgeGoal('')
    setSelectedAssets([])
  }
  const updateCaseDraft = (patch: Partial<CaseDraft>) => {
    setCaseDrafts(current => ({ ...current, [activeCase.id]: { ...activeCaseDraft, ...patch } }))
    setCaseSaveStates(current => ({ ...current, [activeCase.id]: 'dirty' }))
  }
  const saveCase = () => {
    const invalidMethod = activeCaseDraft.methods.some(method => {
      const branch = activeCaseDraft.methodDrafts[method]
      return !branch.spec.trim() || !branch.checks.trim() || branch.steps.length === 0 || branch.steps.some(step => !step.action.trim() || !step.expected.trim())
    })
    if (!activeCaseDraft.title.trim() || !activeCaseDraft.objective.trim() || invalidMethod) {
      setCaseSaveStates(current => ({ ...current, [activeCase.id]: 'failed' }))
      notify('当前会话草稿未保存：标题、测试目标以及每个执行分支的 Spec、步骤、期望和检查点均不能为空。', 'error')
      return
    }
    setCaseRevisions(current => ({ ...current, [activeCase.id]: (current[activeCase.id] ?? 6) + 1 }))
    setCaseSaveStates(current => ({ ...current, [activeCase.id]: 'saved' }))
    notify('已保存到当前会话预览；接入 API 后才会创建正式 revision。')
  }
  const toggleCaseMethod = (method: ExecutionMethod) => {
    if (activeCaseDraft.methods.includes(method) && activeCaseDraft.methods.length === 1) {
      notify('每条用例至少保留一种执行方式。', 'warning')
      return
    }
    if (activeCaseDraft.methods.includes(method) && !window.confirm(`移除 ${method} 执行方式会清空该分支的 Spec、步骤、检查点和就绪状态，是否继续？`)) return
    const removing = activeCaseDraft.methods.includes(method)
    updateCaseDraft({
      methods: removing ? activeCaseDraft.methods.filter(item => item !== method) : [...activeCaseDraft.methods, method],
      methodDrafts: removing
        ? { ...activeCaseDraft.methodDrafts, [method]: createEmptyMethodDraft() }
        : activeCaseDraft.methodDrafts,
    })
  }
  const updateMethodDraft = (method: ExecutionMethod, patch: Partial<MethodDraft>) => updateCaseDraft({
    methodDrafts: { ...activeCaseDraft.methodDrafts, [method]: { ...activeCaseDraft.methodDrafts[method], ...patch } },
  })
  const markTreeChanged = (nextNodes: TreeNode[]) => {
    setTreeNodeList(nextNodes)
    setTreeApproved(false)
    setTreeDirty(true)
    setTreeConflict(false)
  }
  const addTreeNode = (asChild: boolean) => {
    const selectedIndex = treeNodeList.findIndex(node => node.id === selectedTreeNode)
    const parent = treeNodeList[selectedIndex] ?? treeNodeList[0]
    const nextNumber = treeNodeList.reduce((max, node) => Math.max(max, Number(node.id.replace(/\D/g, '')) || 0), 0) + 1
    const nextNode: TreeNode = { ...parent, id: `TP-${String(nextNumber).padStart(3, '0')}`, title: asChild ? '新建子测试点' : '新建同级测试点', level: asChild ? parent.level + 1 : parent.level, count: 0, expanded: undefined }
    const nextNodes = [...treeNodeList]
    nextNodes.splice(selectedIndex + 1, 0, nextNode)
    markTreeChanged(nextNodes)
    setSelectedTreeNode(nextNode.id)
  }
  const moveTreeNode = (direction: -1 | 1) => {
    const index = treeNodeList.findIndex(node => node.id === selectedTreeNode)
    const target = index + direction
    if (index < 0 || target < 0 || target >= treeNodeList.length || treeNodeList[target].level !== treeNodeList[index].level) {
      notify('当前节点在该层级已无法继续移动。', 'warning')
      return
    }
    const nextNodes = [...treeNodeList]
    ;[nextNodes[index], nextNodes[target]] = [nextNodes[target], nextNodes[index]]
    markTreeChanged(nextNodes)
  }
  const splitTreeNode = () => {
    const index = treeNodeList.findIndex(node => node.id === selectedTreeNode)
    if (index < 0) return
    const source = treeNodeList[index]
    const nextNumber = treeNodeList.reduce((max, node) => Math.max(max, Number(node.id.replace(/\D/g, '')) || 0), 0) + 1
    const nextNodes = [...treeNodeList]
    nextNodes[index] = { ...source, title: `${source.title} - 分支 1` }
    nextNodes.splice(index + 1, 0, { ...source, id: `TP-${String(nextNumber).padStart(3, '0')}`, title: `${source.title} - 分支 2`, count: 0, expanded: undefined })
    markTreeChanged(nextNodes)
  }
  const mergeTreeNode = () => {
    const index = treeNodeList.findIndex(node => node.id === selectedTreeNode)
    const sibling = treeNodeList[index + 1]
    if (index < 0 || !sibling || sibling.level !== treeNodeList[index].level) {
      notify('请选择后面存在同级节点的测试点。', 'warning')
      return
    }
    const nextNodes = [...treeNodeList]
    nextNodes[index] = { ...nextNodes[index], title: `${nextNodes[index].title} / ${sibling.title}`, count: nextNodes[index].count + sibling.count }
    nextNodes.splice(index + 1, 1)
    markTreeChanged(nextNodes)
  }
  const deleteTreeNode = () => {
    if (treeNodeList.length === 1) return
    const index = treeNodeList.findIndex(node => node.id === selectedTreeNode)
    const nextNodes = treeNodeList.filter(node => node.id !== selectedTreeNode)
    markTreeChanged(nextNodes)
    setSelectedTreeNode(nextNodes[Math.max(0, index - 1)].id)
  }
  const updateTreeNode = (patch: Partial<TreeNode>) => {
    markTreeChanged(treeNodeList.map(node => node.id === selectedTreeNode ? { ...node, ...patch } : node))
  }
  const saveTree = () => {
    if (treeConflict) {
      notify('当前会话存在 revision 冲突，请先比较或重新应用修改。', 'warning')
      return
    }
    setTreeRevision(value => value + 1)
    setTreeDirty(false)
    notify('树修改已保存到当前会话预览；正式 ETag 保存等待后端 API。')
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

  if (view === 'route-error') {
    return <section className="td-route-error" role="alert">
      <XCircle />
      <StatusPill tone="danger">运行上下文无效</StatusPill>
      <h2>无法恢复指定的测试设计运行</h2>
      <p>当前预览只接受匹配的 testDesignId 与 workflowRunId，不会自动切换到该设计的其他运行或 latest。</p>
      <button className="btn primary" onClick={returnToList}><ArrowRight />返回测试设计列表</button>
    </section>
  }

  if (view === 'create') {
    if (designInputsError) return <section className="td-create-page"><header><button className="icon-btn" onClick={closeCreate} aria-label="关闭创建页"><X /></button><div><span>创建测试设计</span><h2>候选数据加载失败</h2></div></header><div className="td-route-error" role="alert"><XCircle /><p>{designInputsError}</p><button className="btn primary" disabled={designInputsLoading} onClick={() => setDesignInputsRequest(value => value + 1)}><RefreshCw className={designInputsLoading ? 'spin' : ''} />重新加载</button></div></section>
    if (!designInputs) return <section className="td-create-page"><header><button className="icon-btn" onClick={closeCreate} aria-label="关闭创建页"><X /></button><div><span>创建测试设计</span><h2>正在读取当前版本可选输入</h2></div></header><RunLoading /></section>
    return <CreateDesign
      projectVersion={projectVersion}
      inputs={designInputs}
      designName={designName}
      setDesignName={setDesignName}
      basisMode={basisMode}
      setBasisMode={changeBasisMode}
      createStep={createStep}
      setCreateStep={setCreateStep}
      knowledgeGoal={knowledgeGoal}
      setKnowledgeGoal={setKnowledgeGoal}
      selectedAssets={selectedAssets}
      setSelectedAssets={setSelectedAssets}
      augmentation={augmentation}
      setAugmentation={setAugmentation}
      augmentationAssets={augmentationAssets}
      setAugmentationAssets={setAugmentationAssets}
      historyEnabled={historyEnabled}
      setHistoryEnabled={setHistoryEnabled}
      onCancel={closeCreate}
      onStart={startDesign}
    />
  }

  if (view === 'list') {
    return <DesignList projectVersion={projectVersion} view={collectionView} setView={selectCollectionView} designs={designs} loading={designsLoading} onCreate={openCreate} onOpen={openWorkspace} notify={notify} />
  }

  if (workspaceError) {
    return <section className="td-route-error" role="alert">
      <XCircle />
      <StatusPill tone="danger">运行加载失败</StatusPill>
      <h2>无法打开指定的测试设计运行</h2>
      <p>{workspaceError}</p>
      <button className="btn primary" onClick={returnToList}><ArrowRight />返回测试设计列表</button>
    </section>
  }

  if (!activeRun) {
    return <section className="td-workbench-loading" aria-live="polite"><RunLoading /></section>
  }

  const hasDetailPanel = tab === 'overview' || (tab === 'cases' && selectedRunCaseId !== null)
  const detailPanelOpen = hasDetailPanel && rightOpen

  return <section className={`td-workbench ${detailPanelOpen ? '' : 'detail-collapsed'}`}>
    <header className="td-workbench-head">
      <div className="td-title-block">
        <button className="td-back" onClick={returnToList} aria-label="返回测试设计列表"><ChevronRight /></button>
        <span className="td-workbench-icon"><TestTube2 /></span>
        <div><span>测试设计</span><h2>{activeDesign?.name ?? activeRun.testDesignId}</h2></div>
        <StatusPill tone={runStatusTone(activeRun.status)}>{workspaceRefreshing ? '正在同步' : workspaceLoading ? '正在加载' : runStatusLabel(activeRun.status)}</StatusPill>
      </div>
      <div className="td-head-actions">
        {hasDetailPanel && <button className="icon-btn td-mobile-detail-button" onClick={() => setRightOpen(value => !value)} aria-label={rightOpen ? '收起详情' : '展开详情'}><PanelRightClose /></button>}
        <button className="btn" disabled={workspaceLoading || workspaceRefreshing} onClick={refreshWorkspace}><RefreshCw className={workspaceLoading || workspaceRefreshing ? 'spin' : ''} />{workspaceRefreshing ? '同步中' : '刷新'}</button>
        <button className="btn" disabled={!activeRun?.testCases.length} onClick={() => notify('当前运行尚未发布用例集，暂无可导出的固定版本。', 'warning')}><Download />导出<ChevronDown /></button>
        <button className="btn primary" disabled={!canPublishRun(activeRun)} title={activeRun && !canPublishRun(activeRun) ? '请先清除覆盖阻断项并批准全部用例' : '发布当前固定用例集'} onClick={() => { selectTab('case-set'); notify('当前运行已满足发布门禁，请在用例集视图确认固定版本。') }}><LockKeyhole />发布用例集</button>
        <button className="icon-btn" aria-label="更多操作"><MoreHorizontal /></button>
      </div>
    </header>

    <div className="td-context-bar">
      <dl><div><dt>项目版本</dt><dd>{projectVersion.name}</dd></div><div><dt>测试设计</dt><dd>{activeContext.testDesignId}</dd></div><div><dt>工作流运行</dt><dd>{activeContext.workflowRunId}</dd></div><div><dt>主依据</dt><dd>{basisMode === 'review_baseline' ? '评审基线' : '知识库资料'}</dd></div></dl>
      <span className="td-preview-flag"><CircleDot />真实运行数据</span>
      {activeRun?.errorCode ? <span className="td-run-error-code"><AlertTriangle />{activeRun.errorCode}</span> : <span className="td-agent-ready"><CheckCircle2 />运行上下文已固定</span>}
    </div>

    <nav className="td-tabs" aria-label="测试设计视图">
      {tabs.map(item => { const count = runTabCount(item.key, activeRun); return <button key={item.key} className={tab === item.key ? 'active' : ''} onClick={() => selectTab(item.key)}>{item.label}{count !== undefined && <span>{count}</span>}</button> })}
      {hasDetailPanel && <button className="td-detail-toggle" onClick={() => setRightOpen(value => !value)} title={rightOpen ? '收起详情' : '展开详情'}><PanelRightClose /></button>}
    </nav>

    <div className="td-workspace-grid">
      <RunBasisPanel run={activeRun} />
      <main className="td-main-canvas">
        {workspaceLoading && <RunLoading />}
        {!workspaceLoading && activeRun && tab === 'overview' && <RunOverview design={activeDesign} run={activeRun} onNavigate={selectTab} />}
        {!workspaceLoading && activeRun && tab === 'workflow' && <RunWorkflowView design={activeDesign} run={activeRun} onNavigate={selectTab} onGateDecision={submitGateDecision} onRunAction={runAction} gateSubmitting={gateSubmitting} />}
        {!workspaceLoading && activeRun && !['overview', 'workflow'].includes(tab) && <RunArtifactView tab={tab} run={activeRun} projectId={projectVersion.projectId} projectVersionId={projectVersion.id} designId={activeContext.testDesignId!} notify={notify} onRefresh={refreshRunOnly} selectedCaseId={selectedRunCaseId} onSelectCase={openRunCase} onNewCase={openNewRunCase} onOpenTree={() => selectTab('tree')} onOpenGate={() => { selectTab('workflow'); window.setTimeout(() => document.getElementById('test-design-gate-decision')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0) }} />}
      </main>
      {detailPanelOpen && tab === 'cases' && selectedRunCaseId
        ? <RunCaseEditor key={`${activeRun.id}:${selectedRunCaseId}:${newCasePointId ?? ''}`} projectVersionId={projectVersion.id} designId={activeContext.testDesignId!} run={activeRun} caseId={selectedRunCaseId} initialPointId={newCasePointId} notify={notify} onRefresh={refreshRunOnly} onCreated={caseId => { setSelectedRunCaseId(caseId); setNewCasePointId(null) }} />
        : detailPanelOpen && tab === 'overview' && <RunDetailPanel design={activeDesign} run={activeRun} />}
    </div>
  </section>
}

function RunLoading() {
  return <div className="td-run-loading"><RefreshCw className="spin" /><h2>正在加载运行上下文</h2><p>正在读取固定输入、节点状态和运行结果。</p></div>
}

function RunOverview({ design, run, onNavigate }: { design: TestDesign | null; run: TestDesignWorkflowRun; onNavigate: (tab: TabKey) => void }) {
  const failedNode = run.nodeRuns.find(item => item.status === 'failed')
  const completedNodes = run.nodeRuns.filter(item => item.status === 'succeeded').length
  const pendingGate = run.nodeRuns.find(item => item.nodeKey === 'scope_gate' && item.status === 'waiting_gate') ? 'scope' : run.nodeRuns.find(item => item.nodeKey === 'tree_gate' && item.status === 'waiting_gate') ? 'test-point-tree' : null
  return <div className="td-real-overview">
    {run.status === 'failed' && <section className="td-run-failure-banner" role="alert"><AlertTriangle /><div><small>{run.errorCode ?? 'TEST_DESIGN_RUN_FAILED'}</small><h2>测试设计运行失败</h2><p>{runErrorMessage(run.error, run.errorCode)}</p></div></section>}
    {pendingGate && <section className="td-gate-overview-callout"><Users /><div><b>{pendingGate === 'scope' ? '测试范围确认门禁正在等待处理' : '测试点树确认门禁正在等待处理'}</b><p>工作流已暂停，确认固定产物后才能继续后续测试设计阶段。</p></div><button className="btn primary" onClick={() => onNavigate('workflow')}>{pendingGate === 'scope' ? '确认测试范围' : '批准测试点树'}<ChevronRight /></button></section>}
    <div className="td-real-metrics">
      <article><span><GitBranch /></span><p><small>工作流进度</small><b>{run.progress}%</b><em>{completedNodes} / {run.nodeRuns.length} 个节点成功</em></p></article>
      <article><span><FileText /></span><p><small>固定测试依据</small><b>{run.basisSnapshot.items.length}</b><em>{design?.basisMode === 'review_baseline' ? '评审基线' : '知识库资料'}</em></p></article>
      <article><span><TestTube2 /></span><p><small>生成测试用例</small><b>{run.testCases.length}</b><em>{run.artifacts.length} 个工作流产物</em></p></article>
      <article><span><Clock3 /></span><p><small>当前状态</small><b>{runStatusLabel(run.status)}</b><em>{runStageLabel(run.stage, run.status)}</em></p></article>
    </div>
    <section className="td-real-flow-summary"><header><div><b>节点执行状态</b><small>当前工作流运行的服务端真实记录</small></div><button onClick={() => onNavigate('workflow')}>查看工作流<ChevronRight /></button></header><div>{run.nodeRuns.map(node => <article key={node.id} className={node.status}><span>{node.status === 'succeeded' ? <Check /> : node.status === 'failed' ? <XCircle /> : <Clock3 />}</span><p><small>{nodeStatusLabel(node.status)}</small><b>{nodeLabel(node.nodeKey)}</b><em>{node.status === 'failed' ? node.errorCode ?? '执行失败' : node.attempt > 0 ? `attempt ${node.attempt}` : '尚未执行'}</em></p></article>)}</div></section>
    {failedNode && <section className="td-run-next-step"><Bot /><div><b>失败发生在 {nodeLabel(failedNode.nodeKey)}</b><p>{runErrorMessage(failedNode.error ?? run.error, failedNode.errorCode ?? run.errorCode)}</p></div></section>}
  </div>
}

function RunWorkflowView({ design, run, onNavigate, onGateDecision, onRunAction, gateSubmitting }: { design: TestDesign | null; run: TestDesignWorkflowRun; onNavigate: (tab: TabKey) => void; onGateDecision: (gateKey: 'scope' | 'test-point-tree', decision: 'approved' | 'rejected', comment: string) => Promise<void>; onRunAction: (action: 'cancel' | 'revise_scope' | 'retry_functional' | 'retry_non_functional' | 'resynthesize' | 'full_rerun') => Promise<void>; gateSubmitting: boolean }) {
  const node = (nodeKey: string) => run.nodeRuns.find(item => item.nodeKey === nodeKey)
  const fixedInputTime = formatRunTime(run.basisSnapshot.createdAt)
  const gateDecision = (gateKey: 'scope' | 'test-point-tree') => [...run.gateDecisions].reverse().find(item => item.gateKey === gateKey)
  const scopeDecision = gateDecision('scope')
  const treeDecision = gateDecision('test-point-tree')
  const analysis = node('test_analysis')
  const scopeGate = node('scope_gate')
  const functional = node('functional_design')
  const nonFunctional = node('non_functional_design')
  const treeMerge = node('tree_merge')
  const treeGate = node('tree_gate')
  const synthesis = node('test_case_synthesis')
  const coverage = node('coverage_audit')
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [recordNodeId, setRecordNodeId] = useState<string | null>(null)
  const recordNode = run.nodeRuns.find(item => item.id === recordNodeId && hasNodeRunRecord(item))
  const pendingGate = scopeGate?.status === 'waiting_gate' ? 'scope' : treeGate?.status === 'waiting_gate' ? 'test-point-tree' : null
  const openNodeRecord = (nodeRun: TestDesignWorkflowRun['nodeRuns'][number]) => setRecordNodeId(nodeRun.id)
  return <><div className="td-workflow-view td-real-workflow">
    <header className="td-canvas-toolbar"><div><b>固定工作流</b><small>test-design-workflow/v1 · {run.id} · 服务端真实拓扑</small></div><StatusPill tone={runStatusTone(run.status)}>{runStatusLabel(run.status)}</StatusPill><span><i className="done" />成功</span><span><i className="running" />进行中</span><span><i />等待 / 门禁</span>{pendingGate && <a className="btn primary td-gate-entry" href="#test-design-gate-decision"><Users />{pendingGate === 'scope' ? '确认测试范围' : '批准测试点树'}</a>}<button className="btn" onClick={() => setDetailsOpen(value => !value)}>{detailsOpen ? '收起详情' : '运行详情'}</button></header>
    <div className="td-run-recovery-actions"><span>运行恢复</span>{functional?.status === 'failed' && <button className="btn" onClick={() => void onRunAction('retry_functional')}><RefreshCw />仅重跑功能设计</button>}{nonFunctional?.status === 'failed' && <button className="btn" onClick={() => void onRunAction('retry_non_functional')}><RefreshCw />仅重跑非功能设计</button>}{!['queued', 'running'].includes(run.status) && run.status !== 'cancelled' && <button className="btn" onClick={() => void onRunAction('revise_scope')}><FileDiff />重新分析范围</button>}{['succeeded', 'failed'].includes(synthesis?.status ?? '') && run.status !== 'cancelled' && <button className="btn" onClick={() => void onRunAction('resynthesize')}><Sparkles />重新具象化</button>}{['failed', 'cancelled'].includes(run.status) && <button className="btn" onClick={() => void onRunAction('full_rerun')}><ArchiveRestore />全部重跑</button>}{['queued', 'running', 'waiting_gate'].includes(run.status) && <button className="btn danger" onClick={() => void onRunAction('cancel')}><XCircle />取消运行</button>}</div>
    <div className="td-workflow-canvas td-workflow-sequence td-real-workflow-canvas">
      <div className="td-workflow-track">
      <div className="td-flow-column start"><small>固定输入</small><FixedInputCard run={run} time={fixedInputTime} /></div>
      <ArrowRight className="td-flow-arrow inline" />
      <div className="td-flow-column analysis"><small>阶段 1</small><RunWorkflowCard node={analysis} nodeKey="test_analysis" kind="agent" subtitle="依据解构与受控知识召回" onOpenRecord={openNodeRecord} /></div>
      <ArrowRight className="td-flow-arrow inline" />
      <div className="td-flow-column gate"><small>人工门禁 1</small><RunWorkflowCard node={scopeGate} nodeKey="scope_gate" kind="gate" subtitle={scopeDecision ? `${scopeDecision.decision === 'approved' ? '已批准' : '已拒绝'} · ${scopeDecision.actorId}` : '等待范围确认'} onOpenRecord={openNodeRecord} /></div>
      <ArrowRight className="td-flow-arrow inline" />
      <div className="td-flow-branch"><div><small>阶段 2 · 并行</small><RunWorkflowCard node={functional} nodeKey="functional_design" kind="agent" subtitle="功能测试点发散" onOpenRecord={openNodeRecord} /><RunWorkflowCard node={nonFunctional} nodeKey="non_functional_design" kind="agent" subtitle="性能 / 稳定性 / 兼容性 / 安全" onOpenRecord={openNodeRecord} /></div></div>
      <ArrowRight className="td-flow-arrow inline" />
      <div className="td-flow-column server"><small>服务端阶段</small><RunWorkflowCard node={treeMerge} nodeKey="tree_merge" kind="server" subtitle="合并专项候选并保留来源、重复与冲突" onOpenRecord={openNodeRecord} /></div>
      <ArrowRight className="td-flow-arrow inline" />
      <div className="td-flow-column gate"><small>人工门禁 2</small><RunWorkflowCard node={treeGate} nodeKey="tree_gate" kind="gate" subtitle={treeDecision ? `${treeDecision.decision === 'approved' ? '已批准' : '已拒绝'} · ${treeDecision.actorId}` : '等待测试点树批准'} onOpenRecord={openNodeRecord} /></div>
      <ArrowRight className="td-flow-arrow inline" />
      <div className="td-flow-column synthesis"><small>阶段 3-4</small><RunWorkflowCard node={synthesis} nodeKey="test_case_synthesis" kind="agent" subtitle="测试用例与数据需求具象化" onOpenRecord={openNodeRecord} /></div>
      <ArrowRight className="td-flow-arrow inline" />
      <div className="td-flow-column audit server"><small>阶段 5 · 服务端</small><RunWorkflowCard node={coverage} nodeKey="coverage_audit" kind="server" subtitle="覆盖反向审计与候选发布" onOpenRecord={openNodeRecord} /></div>
      </div>
    </div>
    {pendingGate && <GateDecisionPanel gateKey={pendingGate} design={design} run={run} onNavigate={onNavigate} submitting={gateSubmitting} onDecision={onGateDecision} />}
    {detailsOpen && <section className="td-run-details td-real-run-details" aria-label="工作流节点详情"><header><b>节点执行详情</b><span>来源：workflowRunId 对应的服务端记录；错误仅展示脱敏公开信息</span></header>{run.nodeRuns.map(nodeRun => <div key={nodeRun.id}><b>{nodeLabel(nodeRun.nodeKey)}</b><span><strong>{nodeExecutionSummary(nodeRun)}</strong><small>{nodeRun.error ? `${nodeRun.errorCode ?? '执行失败'}：${runErrorMessage(nodeRun.error, nodeRun.errorCode)}` : nodeRun.dependencies.length ? `依赖：${nodeRun.dependencies.map(nodeLabel).join('、')}` : '无上游依赖'}</small></span><time>{formatNodeTime(nodeRun.startedAt)} → {formatNodeTime(nodeRun.finishedAt)}</time><em>{nodeRun.execution ? (nodeRun.execution.degraded ? '已降级' : '未降级') : isAgentNode(nodeRun.nodeKey) ? '未记录' : '不适用'}</em><StatusPill tone={runStatusTone(nodeRun.status)}>{nodeStatusLabel(nodeRun.status)} · {nodeRun.attempt} 次尝试</StatusPill></div>)}</section>}
  </div>{recordNode && <TestDesignNodeRecordModal run={run} node={recordNode} onClose={() => setRecordNodeId(null)} />}</>
}

function TestDesignNodeRecordModal({ run, node, onClose }: { run: TestDesignWorkflowRun; node: TestDesignWorkflowRun['nodeRuns'][number]; onClose: () => void }) {
  const [tab, setTab] = useState<'conversation' | 'events'>('conversation')
  const execution = node.execution
  const events = execution?.events ?? []
  const toolStarts = new Map(events.filter(event => event.type === 'tool_execution_start' && event.toolCallId).map(event => [event.toolCallId!, event]))
  const completedToolIds = new Set(events.filter(event => event.type === 'tool_execution_end' && event.toolCallId).map(event => event.toolCallId))
  const conversation = events.filter(event => (event.type === 'message_end' && (event.role === 'user' || event.role === 'assistant'))
    || event.type === 'tool_execution_end'
    || (event.type === 'tool_execution_start' && !completedToolIds.has(event.toolCallId))
    || event.type === 'result_submission_required'
    || event.type === 'result_submission_retry')

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section className="modal rr-run-record-modal td-node-record-modal" role="dialog" aria-modal="true" aria-label={`${nodeLabel(node.nodeKey)}运行记录`}>
    <header><h2>{nodeLabel(node.nodeKey)}运行记录</h2><button className="icon-btn" onClick={onClose} aria-label="关闭节点运行记录"><XCircle /></button></header>
    <div className="rr-run-record">
      <div className="rr-run-record-summary"><div><StatusPill tone={runStatusTone(node.status)}>{nodeStatusLabel(node.status)}</StatusPill><b>{node.id}</b><span>{execution?.modelLabel ?? '测试设计 Agent'} · generation {node.generation} · attempt {node.attempt}</span></div><dl><div><dt>开始</dt><dd>{formatRunTime(node.startedAt)}</dd></div><div><dt>Turn</dt><dd>{execution?.turns ?? '-'}</dd></div><div><dt>工具调用</dt><dd>{execution ? `${execution.toolCalls}${execution.toolErrors ? `（异常 ${execution.toolErrors}）` : ''}` : '-'}</dd></div><div><dt>Runtime</dt><dd>{execution?.framework ? `${execution.framework.name} ${execution.framework.version}` : '未记录'}</dd></div></dl></div>
      {node.error && <div className="rr-run-record-error"><AlertTriangle /><span><b>终止原因</b>{runErrorMessage(node.error, node.errorCode)}</span></div>}
      <div className="rr-run-record-tabs"><button className={tab === 'conversation' ? 'active' : ''} onClick={() => setTab('conversation')}><MessageSquareText />Agent 对话 <span>{conversation.length}</span></button><button className={tab === 'events' ? 'active' : ''} onClick={() => setTab('events')}><Activity />事件时间线 <span>{events.length}</span></button></div>
      <div className="rr-run-record-body">{tab === 'conversation' ? <div className="rr-agent-conversation">
        {conversation.map(event => {
          if (event.type === 'message_end') return <article className={`rr-agent-message ${event.role}`} key={event.sequence}><header><span>{event.role === 'user' ? <FileText /> : <Bot />}{event.role === 'user' ? '运行任务' : event.model ?? execution?.modelLabel ?? 'Agent'}</span><small>Turn {event.turn ?? 0} · {testDesignEventTime(event.occurredAt)}</small></header>{event.content ? <p>{event.content}</p> : null}{event.toolCalls?.length ? <div className="rr-agent-tool-requests">{event.toolCalls.map(call => <span key={call.id}><Wrench />请求 {call.name}</span>)}</div> : null}{event.usage && <footer>Token：输入 {event.usage.input} · 输出 {event.usage.output} · 缓存读取 {event.usage.cacheRead} · 总计 {event.usage.totalTokens} · {event.stopReason ?? '未知停止原因'}</footer>}</article>
          if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
            const start = event.type === 'tool_execution_start' ? event : toolStarts.get(event.toolCallId ?? '')
            return <article className={`rr-agent-tool ${event.isError ? 'failed' : ''}`} key={event.sequence}><header><span><Wrench />{event.toolId ?? start?.toolId ?? '未知工具'}</span><StatusPill tone={event.type === 'tool_execution_start' ? 'warning' : event.isError ? 'danger' : 'success'}>{event.type === 'tool_execution_start' ? '执行中' : event.isError ? '失败' : '完成'}</StatusPill><small>Turn {event.turn ?? start?.turn ?? 0} · {testDesignEventTime(event.occurredAt)}</small></header><div><details><summary>查看调用参数</summary><pre>{formatTestDesignTraceValue(start?.toolArguments) || '该记录未保存参数'}</pre></details>{event.type === 'tool_execution_end' && <details><summary>查看工具返回</summary><pre>{formatTestDesignTraceValue(event.toolResult) || '该记录未保存返回内容'}</pre></details>}</div><footer>{event.toolCallId ?? '未记录 toolCallId'}</footer></article>
          }
          return <div className="rr-agent-control" key={event.sequence}><Sparkles /><span><b>{testDesignEventLabels[event.type] ?? event.type}</b><small>Turn {event.turn ?? 0} · {testDesignEventTime(event.occurredAt)}</small></span></div>
        })}
        {!conversation.length && <div className="rr-trace-empty"><MessageSquareText /><b>没有可展示的 Agent 对话</b><p>{node.status === 'running' ? '当前节点完成后会固定脱敏执行记录。' : events.length ? '该运行只保存了生命周期事件。' : '该节点没有采集到 Agent 交互。'}</p></div>}
      </div> : <div className="rr-agent-events">{events.map(event => <article key={event.sequence}><i className={event.isError ? 'failed' : event.type.includes('tool') ? 'tool' : event.type.includes('message') ? 'message' : ''} /><span><b>{testDesignEventLabels[event.type] ?? event.type}</b><small>#{event.sequence} · Turn {event.turn ?? 0}{event.toolId ? ` · ${event.toolId}` : ''}{event.role ? ` · ${event.role}` : ''}</small></span><time>{testDesignEventTime(event.occurredAt)}</time></article>)}</div>}</div>
    </div>
  </section></div>
}

function testDesignEventTime(value: string) { return new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) }
function formatTestDesignTraceValue(value: unknown) { return value === undefined ? '' : JSON.stringify(value, null, 2) ?? String(value) }

function GateDecisionPanel({ gateKey, design, run, onNavigate, submitting, onDecision }: { gateKey: 'scope' | 'test-point-tree'; design: TestDesign | null; run: TestDesignWorkflowRun; onNavigate: (tab: TabKey) => void; submitting: boolean; onDecision: (gateKey: 'scope' | 'test-point-tree', decision: 'approved' | 'rejected', comment: string) => Promise<void> }) {
  const [comment, setComment] = useState('')
  const [scopeDetailKey, setScopeDetailKey] = useState<string | null>(null)
  const scopeArtifact = currentNodeArtifact(run, 'test_analysis')
  const scopeContent = recordOf(scopeArtifact?.content)
  const analysisContent = recordOf(scopeContent.analysis)
  const rangeContent = recordOf(analysisContent.range ?? scopeContent.range)
  const scopeRecord = recordOf(scopeContent.scope)
  const requirements = labelScopeRefs(displayValues(rangeContent.requirements ?? scopeRecord.requirements ?? scopeContent.requirements), run, ['requirementPoints'])
  const technicalSolutions = labelScopeRefs(displayValues(rangeContent.technicalSolutions ?? rangeContent.solutions ?? scopeRecord.technicalSolutions ?? scopeContent.technicalSolutions), run, ['solutionPoints', 'technicalSolutionPoints'])
  const includedScopes = uniqueText([
    ...scopeRules(design?.input?.includedScopes),
    ...displayValues(analysisContent.includedScopes ?? scopeContent.includedScopes ?? scopeRecord.inclusions ?? scopeRecord.included),
  ])
  const excludedScopes = uniqueText([
    ...scopeRules(design?.input?.excludedScopes),
    ...displayValues(analysisContent.excludedScopes ?? scopeContent.excludedScopes ?? scopeRecord.exclusions ?? scopeRecord.excluded),
  ])
  const scopeObjectives = uniqueText(displayValues(scopeRecord.objectives ?? analysisContent.objectives ?? scopeContent.objectives))
  const knowledgeBasis = run.basisSnapshot.items.filter(item => recordOf(recordOf(item).locator).coverageTarget !== false).map((item, index) => scopeBasisSummary(item, index))
  const coverageUnits = Array.isArray(scopeContent.coverageUnits) ? scopeContent.coverageUnits.map((item, index) => scopeCoverageUnitSummary(item, index)) : []
  const focusDimensions = uniqueText([
    ...displayValues(design?.input?.focusDimensions),
    ...displayValues(analysisContent.focusDimensions ?? analysisContent.dimensions ?? scopeContent.focusDimensions),
  ]).map(dimensionLabel)
  const coverageObjectives = uniqueText([
    ...displayValues(design?.input?.userCoverageObjectives),
    ...displayValues(analysisContent.coverageObjectives ?? scopeContent.coverageObjectives),
  ])
  const risks = uniqueText([
    ...displayValues(analysisContent.risks ?? scopeContent.risks),
    ...run.findings.map(readableText),
  ])
  const artifactConfirmations = displayValues(analysisContent.pendingConfirmations ?? analysisContent.confirmationItems ?? scopeContent.confirmationItems)
  const openConfirmations = run.confirmationItems.filter(item => item.state === 'open')
  const confirmations = uniqueText(run.confirmationItems.length
    ? openConfirmations.map(item => item.question || item.title)
    : artifactConfirmations)
  const historicalDispositions = displayValues(analysisContent.historicalCaseDispositions ?? analysisContent.historicalCases ?? scopeContent.historicalCaseDispositions)
  const openBlockingConfirmations = run.confirmationItems.filter(item => item.state === 'open' && item.blocker && item.impactStage === 'analysis')
  const scopeApprovalBlocked = gateKey === 'scope' && openBlockingConfirmations.length > 0
  const scopeText = readableText(scopeContent.scope)
    || readableText(scopeContent.summary)
    || readableText(scopeContent.overview)
    || `已识别 ${requirements.length} 个需求点、${technicalSolutions.length} 个技术方案要点，请核对下列范围边界后再确认。`
  const isScope = gateKey === 'scope'
  const basisMode = design?.basisMode ?? run.basisSnapshot.basisMode
  const scopeGroups: ScopeDetailGroup[] = [
    { key: 'objectives', title: '分析目标', items: scopeObjectives, empty: '分析产物未声明目标' },
    ...(basisMode === 'knowledge_assets'
      ? [{ key: 'knowledge-basis', title: '纳入的知识基线项', items: knowledgeBasis, empty: '没有可展示的知识基线项' }, { key: 'coverage-units', title: '原子覆盖单元', items: coverageUnits, empty: '分析产物未生成原子覆盖单元' }]
      : [{ key: 'requirements', title: '纳入的需求点', items: requirements, empty: '分析产物未列出需求点' }, { key: 'technical-solutions', title: '纳入的技术方案要点', items: technicalSolutions, empty: '分析产物未列出技术方案要点' }]),
    { key: 'inclusions', title: '显式包含范围', items: includedScopes, empty: '未额外限定，按固定基线全量分析' },
    { key: 'exclusions', title: '明确排除范围', items: excludedScopes, empty: '未声明排除项' },
    { key: 'dimensions', title: '关注维度', items: focusDimensions, empty: '未限定重点维度，后续仍需逐项判断五维适用性' },
    { key: 'coverage-objectives', title: '用户覆盖目标', items: coverageObjectives, empty: '未额外声明覆盖目标' },
    { key: 'risks', title: '分析风险', items: risks, empty: '分析产物未报告风险' },
    { key: 'confirmations', title: '范围待确认项', items: confirmations, empty: '没有未处理的待确认项' },
    { key: 'history', title: '历史用例处置', items: historicalDispositions, empty: run.historicalSnapshot.items.length ? `已固定 ${run.historicalSnapshot.items.length} 项历史用例，但分析产物未给出处置结论` : '本次未选择历史用例' },
  ]
  const targetId = isScope ? scopeArtifact?.id : run.testPointTree?.id
  const targetRevision = isScope ? scopeArtifact?.generation : run.testPointTree?.currentRevision
  return <section className={`td-gate-decision ${submitting ? 'submitting' : ''}`} id="test-design-gate-decision" aria-label={isScope ? '测试范围确认' : '测试点树批准'} aria-busy={submitting}>
    <header><span><Users /></span><div><small>{isScope ? '人工门禁 1' : '人工门禁 2'} · {submitting ? '正在提交你的决策' : '等待你的决策'}</small><h2>{isScope ? '确认本次测试范围' : '批准当前测试点树'}</h2><p>{isScope ? scopeText : `当前测试点树 revision r${targetRevision ?? '-'} 已固定，批准后将进入测试用例具象化。`}</p></div><StatusPill tone="warning">{submitting ? '正在提交' : '等待确认'}</StatusPill></header>
    <div className="td-gate-facts">
      <div><small>固定目标</small><b>{targetId ? shortId(targetId) : '目标尚未生成'}</b></div>
      <div><small>目标版本</small><b>{targetRevision ?? '-'}</b></div>
      <div><small>分析风险</small><b>{risks.length} 项</b></div>
      <div><small>待确认项</small><b>{confirmations.length} 项</b></div>
    </div>
    {isScope && <div className="td-scope-review" aria-label="本次测试范围明细">
      <section className="td-scope-objective">
        <div><small>测试目标</small><p>{design?.objective || readableText(analysisContent.objective) || '未声明测试目标'}</p></div>
        <button type="button" className="btn" onClick={() => setScopeDetailKey(scopeGroups[0]?.key ?? null)}><Eye />查看完整范围</button>
      </section>
      <div className="td-scope-grid">
        <ScopeReviewSection title="分析目标" count={scopeObjectives.length} items={scopeObjectives} empty="分析产物未声明目标" onExpand={() => setScopeDetailKey('objectives')} />
        {basisMode === 'knowledge_assets' ? <>
          <ScopeReviewSection title="纳入的知识基线项" count={knowledgeBasis.length} items={knowledgeBasis} empty="没有可展示的知识基线项" tone="included" onExpand={() => setScopeDetailKey('knowledge-basis')} />
          <ScopeReviewSection title="原子覆盖单元" count={coverageUnits.length} items={coverageUnits} empty="分析产物未生成原子覆盖单元" tone="included" onExpand={() => setScopeDetailKey('coverage-units')} />
        </> : <>
          <ScopeReviewSection title="纳入的需求点" count={requirements.length} items={requirements} empty="分析产物未列出需求点" tone="included" onExpand={() => setScopeDetailKey('requirements')} />
          <ScopeReviewSection title="纳入的技术方案要点" count={technicalSolutions.length} items={technicalSolutions} empty="分析产物未列出技术方案要点" tone="included" onExpand={() => setScopeDetailKey('technical-solutions')} />
        </>}
        <ScopeReviewSection title="显式包含范围" count={includedScopes.length} items={includedScopes} empty="未额外限定，按固定基线全量分析" onExpand={() => setScopeDetailKey('inclusions')} />
        <ScopeReviewSection title="明确排除范围" count={excludedScopes.length} items={excludedScopes} empty="未声明排除项" tone="excluded" onExpand={() => setScopeDetailKey('exclusions')} />
        <ScopeReviewSection title="关注维度" count={focusDimensions.length} items={focusDimensions} empty="未限定重点维度，后续仍需逐项判断五维适用性" onExpand={() => setScopeDetailKey('dimensions')} />
        <ScopeReviewSection title="用户覆盖目标" count={coverageObjectives.length} items={coverageObjectives} empty="未额外声明覆盖目标" onExpand={() => setScopeDetailKey('coverage-objectives')} />
        <ScopeReviewSection title="分析风险" count={risks.length} items={risks} empty="分析产物未报告风险" tone={risks.length ? 'warning' : undefined} onExpand={() => setScopeDetailKey('risks')} />
        <ScopeReviewSection title="范围待确认项" count={confirmations.length} items={confirmations} empty="没有待确认项" tone={confirmations.length ? 'warning' : undefined} action={confirmations.length ? <button type="button" className="td-scope-action" onClick={() => onNavigate('questions')}><CircleDot />处理待确认项</button> : undefined} onExpand={() => setScopeDetailKey('confirmations')} />
        <ScopeReviewSection title="历史用例处置" count={historicalDispositions.length || run.historicalSnapshot.items.length} items={historicalDispositions} empty={run.historicalSnapshot.items.length ? `已固定 ${run.historicalSnapshot.items.length} 项历史用例，但分析产物未给出处置结论` : '本次未选择历史用例'} onExpand={() => setScopeDetailKey('history')} />
      </div>
    </div>}
    <label><span>决策说明（可选）</span><textarea value={comment} maxLength={4000} placeholder={isScope ? '补充范围边界、风险接受或需要调整的原因' : '补充树版本的批准或驳回说明'} onChange={event => setComment(event.target.value)} disabled={submitting} /></label>
     <footer><span><LockKeyhole />{submitting ? '正在校验目标版本并提交，当前页面会保留。' : scopeApprovalBlocked ? `还有 ${openBlockingConfirmations.length} 项阻断确认未处理，请先完成处置。` : '决策将绑定当前目标 ID 与版本，提交后不可覆盖。'}</span>{scopeApprovalBlocked && <button type="button" className="btn" disabled={submitting} onClick={() => onNavigate('questions')}><CircleDot />查看待确认项</button>}<button className="btn danger" disabled={submitting || !targetId} onClick={() => void onDecision(gateKey, 'rejected', comment)}><XCircle />驳回{isScope ? '范围' : '测试点树'}</button><button className="btn primary" disabled={submitting || !targetId || scopeApprovalBlocked} title={scopeApprovalBlocked ? '请先处理阻断确认项' : undefined} onClick={() => void onDecision(gateKey, 'approved', comment)}>{submitting ? <RefreshCw className="spin" /> : <Check />}{submitting ? '正在提交决策' : `确认${isScope ? '范围并继续' : '批准并继续'}`}</button></footer>
    {scopeDetailKey && <ScopeDetailModal groups={scopeGroups} initialKey={scopeDetailKey} onClose={() => setScopeDetailKey(null)} />}
  </section>
}

type ScopeDetailGroup = { key: string; title: string; items: string[]; empty: string }

function ScopeReviewSection({ title, count, items, empty, tone, action, onExpand }: { title: string; count: number; items: string[]; empty: string; tone?: 'included' | 'excluded' | 'warning'; action?: ReactNode; onExpand?: () => void }) {
  return <section className={`td-scope-section ${tone ?? ''}`}>
    <header><b>{title}</b><div className="td-scope-section-meta">{action}{onExpand && <button type="button" className="td-scope-expand" onClick={onExpand}><Eye />查看全部</button>}<span>{count} 项</span></div></header>
    {items.length ? <ul>{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul> : <p>{empty}</p>}
  </section>
}

function ScopeDetailModal({ groups, initialKey, onClose }: { groups: ScopeDetailGroup[]; initialKey: string; onClose: () => void }) {
  const [selectedKey, setSelectedKey] = useState(initialKey)
  const selected = groups.find(group => group.key === selectedKey) ?? groups[0]
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section className="modal td-scope-detail-modal" role="dialog" aria-modal="true" aria-labelledby="scope-detail-title">
    <header><div><small>范围确认门禁 · 完整固定产物</small><h2 id="scope-detail-title">完整测试范围</h2></div><button type="button" className="icon-btn" onClick={onClose} aria-label="关闭完整测试范围"><X /></button></header>
    <div className="td-scope-detail-layout">
      <nav aria-label="测试范围分类">{groups.map(group => <button type="button" key={group.key} className={group.key === selected?.key ? 'active' : ''} onClick={() => setSelectedKey(group.key)}><span><b>{group.title}</b><small>{group.items.length ? `${group.items.length} 项` : '无内容'}</small></span><ChevronRight /></button>)}</nav>
      <section className="td-scope-detail-content"><header><div><b>{selected?.title ?? '范围明细'}</b><small>完整展示，不截断条目内容</small></div><StatusPill tone={selected?.items.length ? 'info' : 'neutral'}>{selected?.items.length ?? 0} 项</StatusPill></header>{selected?.items.length ? <ol>{selected.items.map((item, index) => <li key={`${selected.key}-${index}`}><span>{String(index + 1).padStart(2, '0')}</span><p>{item}</p></li>)}</ol> : <div className="td-scope-detail-empty"><ListChecks /><p>{selected?.empty ?? '当前分类没有内容'}</p></div>}</section>
    </div>
  </section></div>
}

function scopeBasisSummary(value: unknown, index: number) {
  const item = recordOf(value)
  const content = recordOf(item.content)
  const locator = recordOf(item.locator)
  const title = readableText(content.title) || `固定依据 ${index + 1}`
  const path = readableText(locator.logicalPath)
  const lines = locator.startLine === undefined ? '' : `L${String(locator.startLine)}${locator.endLine === undefined ? '' : `-L${String(locator.endLine)}`}`
  const description = readableText(content.description)
  return [`${title}${path ? ` · ${path}` : ''}${lines ? ` · ${lines}` : ''}`, description].filter(Boolean).join('\n')
}

function scopeCoverageUnitSummary(value: unknown, index: number) {
  const item = recordOf(value)
  const title = readableText(item.title) || readableText(item.ref) || `覆盖单元 ${index + 1}`
  const description = readableText(item.description)
  const basisCount = Array.isArray(item.basisRefs) ? item.basisRefs.length : 0
  const methods = displayValues(item.entryMethods).map(method => method.toUpperCase()).join(' / ')
  return [`${readableText(item.ref) ? `${readableText(item.ref)} · ` : ''}${title}`, description, `关联依据 ${basisCount} 项${methods ? ` · ${methods}` : ''}`].filter(Boolean).join('\n')
}

function scopeRules(value: unknown) {
  return Array.isArray(value) ? value.map(candidate => {
    const item = recordOf(candidate)
    const kind = readableText(item.kind)
    const rule = readableText(item.value)
    return kind && rule ? `${kind}：${rule}` : rule || kind
  }).filter(Boolean) : []
}

function displayValues(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    const text = readableText(value)
    return text ? [text] : []
  }
  return value.map(readableText).filter((item): item is string => Boolean(item))
}

function labelScopeRefs(refs: string[], run: TestDesignWorkflowRun, collectionKeys: string[]) {
  const labels = new Map<string, string>()
  for (const basisItem of run.basisSnapshot.items) {
    const content = recordOf(recordOf(basisItem).content)
    for (const key of collectionKeys) {
      const candidates = content[key]
      if (!Array.isArray(candidates)) continue
      for (const candidate of candidates) {
        const item = recordOf(candidate)
        const ref = primitiveText(item.clientRequirementPointId ?? item.requirementPointId ?? item.solutionPointId ?? item.clientSolutionPointId ?? item.id ?? item.ref)
        const title = primitiveText(item.title ?? item.name)
        if (ref && title) labels.set(ref, title)
      }
    }
  }
  return refs.map(ref => labels.has(ref) ? `${ref} · ${labels.get(ref)}` : ref)
}

function readableText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value).trim()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const item = value as Record<string, unknown>
  const title = primitiveText(item.title ?? item.name ?? item.label ?? item.id ?? item.ref)
  const detail = primitiveText(item.description ?? item.question ?? item.reason ?? item.value ?? item.objective ?? item.summary ?? item.impact)
  if (title && detail && title !== detail) return `${title}：${detail}`
  return detail || title
}

function primitiveText(value: unknown) { return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value).trim() : '' }
function uniqueText(values: string[]) { return [...new Set(values.map(value => value.trim()).filter(Boolean))] }
function dimensionLabel(value: string) { return ({ functional: '功能', performance: '性能', stability: '稳定性', compatibility: '兼容性', security: '安全' } as Record<string, string>)[value] ?? value }

const basisKindLabels: Record<string, string> = {
  requirement_review: '需求点',
  technical_solution_review: '技术方案要点',
  knowledge_asset: '知识库资料',
  historical_case_set: '历史用例',
  historical_case_asset: '历史用例资料',
}

function basisItemPresentation(value: unknown, index: number) {
  const item = recordOf(value)
  const content = recordOf(item.content)
  const locator = recordOf(item.locator)
  const kind = primitiveText(item.kind)
  const headingPath = arrayOf(locator.headingPath).map(primitiveText).filter(Boolean)
  const startLine = primitiveText(locator.startLine)
  const endLine = primitiveText(locator.endLine)
  const lineLabel = startLine ? `L${startLine}${endLine && endLine !== startLine ? `-L${endLine}` : ''}` : ''
  const logicalPath = primitiveText(locator.logicalPath)
  const pointRef = primitiveText(locator.requirementPointId ?? locator.solutionPointId)
  const title = primitiveText(content.title ?? content.name ?? content.displayName)
    || headingPath.at(-1)
    || pointRef
    || `固定依据 ${index + 1}`
  const description = primitiveText(content.description ?? content.problem ?? content.summary ?? content.content)
  const sourceLabel = [logicalPath, headingPath.length ? headingPath.join(' / ') : '', lineLabel].filter(Boolean).join(' · ')
    || pointRef
    || primitiveText(item.sourceId)
    || primitiveText(item.id)
    || '未记录来源位置'
  const sourceType = primitiveText(locator.sourceType)
  const kindLabel = sourceType === 'user_coverage_objective' ? '用户覆盖目标' : basisKindLabels[kind] ?? kind ?? '固定依据'
  return { item, content, locator, kind, kindLabel, title, description, sourceLabel }
}

function FixedInputCard({ run, time }: { run: TestDesignWorkflowRun; time: string }) {
  return <article className="fixed-input"><span><LockKeyhole /></span><p><b>{run.basisSnapshot.basisMode === 'review_baseline' ? '评审基线快照' : '知识库资料快照'}</b><small>{run.basisSnapshot.items.length} 项依据 · Hash 已固定</small><em>{time}</em></p><CheckCircle2 /></article>
}

function RunWorkflowCard({ node, nodeKey, kind, subtitle, onOpenRecord }: { node?: TestDesignWorkflowRun['nodeRuns'][number]; nodeKey: string; kind: 'agent' | 'gate' | 'server'; subtitle: string; onOpenRecord: (node: TestDesignWorkflowRun['nodeRuns'][number]) => void }) {
  const status = node?.status ?? 'pending'
  const description = node?.error ? `${node.errorCode ?? '执行失败'}：${runErrorMessage(node.error, node.errorCode)}` : subtitle
  const recordAvailable = hasNodeRunRecord(node)
  return <article className={`${kind} ${nodeKey} ${status}`} data-node-key={nodeKey}><span>{nodeStatusIcon(status, kind)}</span><p><b>{nodeLabel(nodeKey)}</b><small>{description}</small><em>{nodeExecutionSummary(node)}<br />{node ? `${formatNodeTime(node.startedAt)} → ${formatNodeTime(node.finishedAt)}` : '节点记录未返回'}</em></p><StatusIcon status={status} /><button className="td-node-record-button" type="button" disabled={!recordAvailable} title={recordAvailable ? `查看${nodeLabel(nodeKey)}运行记录` : `${nodeLabel(nodeKey)}暂无运行记录`} onClick={() => { if (node && recordAvailable) onOpenRecord(node) }}><Activity />{recordAvailable ? '运行记录' : '暂无记录'}</button></article>
}

function StatusIcon({ status }: { status: string }) { return status === 'succeeded' ? <CheckCircle2 /> : status === 'failed' ? <XCircle /> : status === 'running' ? <RefreshCw className="spin" /> : null }
function nodeStatusIcon(status: string, kind: 'agent' | 'gate' | 'server') { if (status === 'succeeded') return <Check />; if (status === 'failed') return <XCircle />; if (status === 'running') return <RefreshCw className="spin" />; return kind === 'gate' ? <Users /> : kind === 'server' ? <Network /> : <Bot /> }
function isAgentNode(nodeKey: string) { return ['test_analysis', 'functional_design', 'non_functional_design', 'test_case_synthesis'].includes(nodeKey) }
function hasNodeRunRecord(node?: TestDesignWorkflowRun['nodeRuns'][number]) { return Boolean(node?.execution?.events.length) }
function nodeExecutionSummary(node?: TestDesignWorkflowRun['nodeRuns'][number]) { if (!node) return '节点记录未返回'; if (!isAgentNode(node.nodeKey)) return node.nodeKey === 'scope_gate' || node.nodeKey === 'tree_gate' ? '人工门禁' : '服务端确定性阶段'; if (!node.execution) return node.attempt ? `attempt ${node.attempt} · 执行详情未记录` : '尚未执行'; return `${node.execution.modelLabel} · ${node.execution.turns} Turn · ${node.execution.toolCalls} 次工具调用${node.execution.toolErrors ? ` · 异常 ${node.execution.toolErrors}` : ''}` }
function formatNodeTime(value?: string) { return value ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '未记录' }

function RunBasisPanel({ run }: { run: TestDesignWorkflowRun }) {
  const [preview, setPreview] = useState<{ value: unknown; index: number } | null>(null)
  return <><aside className="td-basis-panel td-real-basis-panel">
    <header><div><b>固定测试依据</b><small>{run.basisSnapshot.items.length} 项 · Hash 已固定</small></div><LockKeyhole /></header>
    <section className="td-basis-summary"><Database /><span><b>{run.basisSnapshot.basisMode === 'review_baseline' ? '评审基线' : '知识库资料'}</b><small>{shortHash(run.basisSnapshot.snapshotSha256)}</small></span><CheckCircle2 /></section>
    <div className="td-basis-list">{run.basisSnapshot.items.map((value, index) => { const view = basisItemPresentation(value, index); return <button type="button" key={primitiveText(view.item.id ?? view.item.sourceId) || String(index)} title={`预览：${view.title}`} aria-label={`预览固定测试依据：${view.title}`} onClick={() => setPreview({ value, index })}><i className={view.kind.includes('technical') ? 'solution' : ''} /><span><small>{view.kindLabel}</small><b>{view.title}</b><em>{view.sourceLabel} · {shortHash(primitiveText(view.item.contentSha256))}</em></span><Eye /></button> })}</div>
    <footer><span><i className="covered" />内容快照已固定</span></footer>
  </aside>{preview && <BasisPreviewModal value={preview.value} index={preview.index} onClose={() => setPreview(null)} />}</>
}

function BasisPreviewModal({ value, index, onClose }: { value: unknown; index: number; onClose: () => void }) {
  const view = basisItemPresentation(value, index)
  const itemId = primitiveText(view.item.id) || '未记录'
  const sourceId = primitiveText(view.item.sourceId) || '未记录'
  const contentSha256 = primitiveText(view.item.contentSha256) || '未记录'

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section className="modal td-basis-preview-modal" role="dialog" aria-modal="true" aria-label="固定测试依据预览">
    <header><div><small>{view.kindLabel}</small><h2>固定测试依据预览</h2></div><button className="icon-btn" type="button" onClick={onClose} aria-label="关闭固定测试依据预览"><X /></button></header>
    <div className="td-basis-preview-body">
      <section className="td-basis-preview-title"><span><FileText /></span><div><small>{view.kindLabel}</small><h3>{view.title}</h3><p>{view.sourceLabel}</p></div><StatusPill tone="success"><LockKeyhole />已固定</StatusPill></section>
      <dl className="td-basis-preview-meta"><div><dt>固定项 ID</dt><dd>{itemId}</dd></div><div><dt>来源 ID</dt><dd>{sourceId}</dd></div><div className="wide"><dt>内容 SHA-256</dt><dd>{contentSha256}</dd></div></dl>
      <section className="td-basis-preview-content"><header><b>固定内容</b><span>运行创建时快照</span></header>{view.description ? <p>{view.description}</p> : <pre>{JSON.stringify(view.content, null, 2)}</pre>}</section>
      <details className="td-basis-preview-raw"><summary>查看完整结构化快照</summary><pre>{JSON.stringify(view.content, null, 2)}</pre></details>
      {Object.keys(view.locator).length > 0 && <details className="td-basis-preview-raw"><summary>查看来源定位信息</summary><pre>{JSON.stringify(view.locator, null, 2)}</pre></details>}
    </div>
  </section></div>
}

function RunDetailPanel({ design, run }: { design: TestDesign | null; run: TestDesignWorkflowRun }) {
  const failedNode = run.nodeRuns.find(item => item.status === 'failed')
  return <aside className="td-detail-panel td-run-detail-panel"><header><div><small>工作流运行</small><b>{shortId(run.id)}</b></div><StatusPill tone={runStatusTone(run.status)}>{runStatusLabel(run.status)}</StatusPill></header><div className="td-detail-scroll">
    {run.status === 'failed' && <section className="td-detail-callout danger"><AlertTriangle /><p><b>{run.errorCode ?? '运行失败'}</b><small>{runErrorMessage(run.error, run.errorCode)}</small></p></section>}
    <div className="td-basis-meta"><p><span>测试设计</span><b>{design?.name ?? run.testDesignId}</b></p><p><span>当前阶段</span><b>{runStageLabel(run.stage, run.status)}</b></p><p><span>运行进度</span><b>{run.progress}%</b></p><p><span>创建时间</span><b>{formatRunTime(run.createdAt)}</b></p><p><span>开始时间</span><b>{formatRunTime(run.startedAt)}</b></p><p><span>结束时间</span><b>{formatRunTime(run.finishedAt)}</b></p></div>
    {failedNode && <section className="td-detail-section"><h3>失败节点</h3><button className="missing"><Bot /><span><small>{failedNode.errorCode ?? '节点执行失败'}</small><b>{nodeLabel(failedNode.nodeKey)}</b></span><XCircle /></button></section>}
    <section className="td-detail-section"><h3>固定快照</h3><button><FileText /><span><small>测试依据</small><b>{run.basisSnapshot.items.length} 项</b></span><LockKeyhole /></button><button><Database /><span><small>知识召回</small><b>{run.retrievalSnapshot.mode}</b></span><LockKeyhole /></button><button><History /><span><small>历史用例</small><b>{run.historicalSnapshot.items.length} 项</b></span><LockKeyhole /></button></section>
  </div></aside>
}

const artifactLabels: Record<TabKey, string> = { overview: '概览', workflow: '工作流', analysis: '依据解构', retrieval: '知识召回', tree: '测试点树', cases: '测试用例', 'case-set': '用例集', data: '测试数据', coverage: '覆盖审计', history: '历史复用', questions: '待确认项' }
const analysisGroupLabels: Record<string, string> = { scopeSummary: '范围摘要', objectives: '测试目标', inclusions: '纳入范围', exclusions: '排除范围', coverageUnits: '原子覆盖单元', features: '功能与能力', rules: '规则与约束', constraints: '约束', states: '状态', transitions: '状态迁移', roles: '角色', entities: '实体', terms: '术语', actions: '业务动作', interfaces: '接口', assertions: '验收断言', risks: '风险', pendingItems: '待确认输入' }
const runDimensionLabels: Record<TestPointNode['dimension'], string> = { functional: '功能', performance: '性能', stability: '稳定性', compatibility: '兼容性', security: '安全' }
const reviewStateLabels: Record<TestDesignCase['reviewState'], string> = { draft: '草稿', in_review: '审核中', approved: '已批准', rejected: '已拒绝', needs_revision: '需修订' }

type RunArtifactViewProps = {
  tab: TabKey
  run: TestDesignWorkflowRun
  projectId: string
  projectVersionId: string
  designId: string
  notify: Notify
  onRefresh: () => Promise<void>
  selectedCaseId: string | null
  onSelectCase: (caseId: string) => void
  onNewCase: (pointId?: string) => void
  onOpenTree: () => void
  onOpenGate: () => void
}

function RunArtifactView({ tab, run, projectId, projectVersionId, designId, notify, onRefresh, selectedCaseId, onSelectCase, onNewCase, onOpenTree, onOpenGate }: RunArtifactViewProps) {
  if (tab === 'analysis') return currentNodeArtifact(run, 'test_analysis') ? <RunAnalysisArtifact run={run} /> : <RunArtifactState tab={tab} run={run} />
  if (tab === 'retrieval') return <RunRetrievalArtifact run={run} />
  if (tab === 'tree') return run.testPointTree ? <RunTreeArtifact run={run} projectVersionId={projectVersionId} designId={designId} notify={notify} onRefresh={onRefresh} /> : <RunArtifactState tab={tab} run={run} />
  if (tab === 'cases') return run.testCases.length || run.status === 'succeeded' ? <RunCasesArtifact run={run} projectVersionId={projectVersionId} designId={designId} notify={notify} onRefresh={onRefresh} selectedCaseId={selectedCaseId} onSelectCase={onSelectCase} onNewCase={onNewCase} /> : <RunArtifactState tab={tab} run={run} />
  if (tab === 'case-set') return <RunCaseSetArtifact run={run} projectId={projectId} projectVersionId={projectVersionId} designId={designId} notify={notify} onRefresh={onRefresh} onSelectCase={onSelectCase} onNewCase={onNewCase} onOpenTree={onOpenTree} />
  if (tab === 'data') return run.dataSetVersions.length ? <RunDataArtifact run={run} projectVersionId={projectVersionId} designId={designId} notify={notify} onRefresh={onRefresh} /> : <RunArtifactState tab={tab} run={run} />
  if (tab === 'coverage') return run.coverageAudits.length ? <RunCoverageArtifact run={run} projectVersionId={projectVersionId} designId={designId} notify={notify} onRefresh={onRefresh} onSelectCase={onSelectCase} onNewCase={onNewCase} onOpenTree={onOpenTree} /> : <RunArtifactState tab={tab} run={run} />
  if (tab === 'history') return <RunHistoryArtifact run={run} />
  if (tab === 'questions') return <RunQuestionsArtifact run={run} projectVersionId={projectVersionId} designId={designId} notify={notify} onRefresh={onRefresh} onOpenGate={onOpenGate} />
  return <RunArtifactState tab={tab} run={run} />
}

function RunArtifactHeader({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <header className="td-canvas-toolbar td-run-artifact-header"><div><b>{title}</b><small>{description}</small></div>{children}</header>
}

function RunIntentionalEmpty({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return <div className="td-run-intentional-empty"><span>{icon}</span><h2>{title}</h2><p>{description}</p></div>
}

function RunDimensionTag({ dimension }: { dimension: TestPointNode['dimension'] }) {
  return <span className={`td-dimension-tag ${dimension}`}>{runDimensionLabels[dimension]}</span>
}

function analysisEntry(value: unknown, index: number) {
  if (typeof value === 'string') return { title: value, description: '' }
  const item = recordOf(value)
  const id = item.ref ?? item.featureId ?? item.ruleId ?? item.stateId ?? item.roleId ?? item.entityId ?? item.interfaceId ?? item.assertionId ?? item.riskId ?? item.id
  const title = String(item.title ?? item.name ?? item.summary ?? id ?? `条目 ${index + 1}`)
  const description = String(item.description ?? item.objective ?? item.question ?? item.mitigation ?? item.status ?? item.reason ?? '')
  return { title, description }
}

function RunAnalysisArtifact({ run }: { run: TestDesignWorkflowRun }) {
  const artifact = currentNodeArtifact(run, 'test_analysis')!
  const groups = analysisGroups(run)
  const [selectedGroupKey, setSelectedGroupKey] = useState(groups[0]?.key ?? '')
  useEffect(() => setSelectedGroupKey(groups[0]?.key ?? ''), [artifact.id])
  const selectedGroup = groups.find(group => group.key === selectedGroupKey) ?? groups[0]
  return <div className="td-run-artifact-view td-run-analysis-view">
    <RunArtifactHeader title="依据解构" description={`${artifact.schemaVersion} · 固定产物 ${shortHash(artifact.contentSha256)}`}><StatusPill tone="success">{analysisItemCount(run)} 项</StatusPill></RunArtifactHeader>
    {selectedGroup ? <div className="td-run-analysis-layout">
      <nav className="td-run-analysis-groups" aria-label="依据解构分组">{groups.map(group => <button type="button" key={group.key} className={selectedGroup.key === group.key ? 'active' : ''} aria-pressed={selectedGroup.key === group.key} onClick={() => setSelectedGroupKey(group.key)}><Braces /><span><b>{analysisGroupLabels[group.key] ?? group.key}</b><small>{group.items.length} 项</small></span></button>)}</nav>
      <div className="td-run-analysis-evidence">
        <header><span><Braces /><b>{analysisGroupLabels[selectedGroup.key] ?? selectedGroup.key}</b></span><em>{selectedGroup.items.length} 项</em></header>
        <div>{selectedGroup.items.map((value, index) => { const item = analysisEntry(value, index); return <article key={`${selectedGroup.key}-${index}`}><span>{String(index + 1).padStart(2, '0')}</span><p><b>{item.title}</b>{item.description && <small>{item.description}</small>}</p></article> })}</div>
        {run.findings.length > 0 && <section className="td-run-findings"><header><b>分析 Finding</b><span>{run.findings.length}</span></header>{run.findings.map(item => <article key={item.id}><AlertTriangle /><p><small>{item.severity} · {item.state}</small><b>{item.title}</b><em>{item.description}</em></p></article>)}</section>}
      </div>
    </div> : <RunIntentionalEmpty icon={<ListChecks />} title="依据解构结果为空" description="该固定产物没有返回可展示的结构化条目。" />}
  </div>
}

function RunRetrievalArtifact({ run }: { run: TestDesignWorkflowRun }) {
  const snapshot = run.retrievalSnapshot
  return <div className="td-run-artifact-view">
    <RunArtifactHeader title="固定知识召回" description={`快照 ${shortHash(snapshot.snapshotSha256)} · ${snapshot.assetVersionIds.length} 个固定资产`}><StatusPill tone={snapshot.mode === 'disabled' ? 'neutral' : 'info'}>{snapshot.mode}</StatusPill></RunArtifactHeader>
    {snapshot.hits.length ? <div className="td-run-retrieval-list">{snapshot.hits.map((value, index) => { const hit = recordOf(value); const locator = recordOf(hit.locator); return <article key={String(hit.id ?? index)}><header><FileText /><b>{String(hit.classification ?? '固定知识')}</b><strong>{typeof hit.score === 'number' ? hit.score.toFixed(3) : '-'}</strong></header><p>{String(hit.content ?? '')}</p><footer><span>{String(locator.logicalPath ?? hit.assetVersionId ?? '')}</span><code>{String(hit.chunkId ?? '')}</code></footer></article> })}</div> : <RunIntentionalEmpty icon={<Search />} title={snapshot.mode === 'disabled' ? '本次未启用补充知识召回' : '固定召回没有命中'} description={snapshot.mode === 'disabled' ? '本次运行仅使用主依据，这是已固定的输入策略，不是产物缺失。' : '快照已成功生成，但固定查询计划没有返回符合条件的内容。'} />}
  </div>
}

function RunTreeArtifact({ run, projectVersionId, designId, notify, onRefresh }: { run: TestDesignWorkflowRun; projectVersionId: string; designId: string; notify: Notify; onRefresh: () => Promise<void> }) {
  const tree = run.testPointTree!
  const nodes = currentTreeNodes(run).sort((left, right) => left.sortKey.localeCompare(right.sortKey))
  const approved = tree.versions.find(item => item.id === tree.currentApprovedVersionId && item.revision === tree.currentRevision)
  const [selectedId, setSelectedId] = useState(nodes[0]?.nodeId ?? '')
  const selected = nodes.find(item => item.nodeId === selectedId) ?? nodes[0]
  const [draft, setDraft] = useState<TestPointNode | null>(selected ? structuredClone(selected) : null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (!selected) return; setDraft(structuredClone(selected)); setDirty(false) }, [selected?.nodeId, tree.currentRevision])
  const change = (patch: Partial<TestPointNode>) => { if (!draft) return; setDraft({ ...draft, ...patch }); setDirty(true) }
  const applyOperations = async (operations: TestPointTreeOperation[], reason: string) => {
    const current = await loadTestPointTree(projectVersionId, designId, run.id)
    await updateTestPointTree(projectVersionId, designId, run.id, current.etag, operations, reason)
    await onRefresh()
  }
  const save = async () => {
    if (!draft || !draft.title.trim() || !draft.objective.trim() || !draft.oracle.trim()) return notify('请补齐测试点名称、目标和判定依据。', 'error')
    setBusy(true)
    try {
      await applyOperations([{ op: 'update', nodeId: draft.nodeId, patch: { title: draft.title, objective: draft.objective, dimension: draft.dimension, priority: draft.priority, applicability: draft.applicability, entryMethods: draft.entryMethods, oracle: draft.oracle, basisRefs: draft.basisRefs, designTechniques: draft.designTechniques, dataConditions: draft.dataConditions, risks: draft.risks, assumptions: draft.assumptions, historicalRefs: draft.historicalRefs } }], '人工修订测试点与固定依据关系')
      setDirty(false); notify('测试点树 revision 已保存，请完成独立批准后继续。', 'success')
    } catch (error) { notify(error instanceof Error ? error.message : '测试点树保存失败', 'error') }
    finally { setBusy(false) }
  }
  const mutate = async (operations: TestPointTreeOperation[], reason: string) => { setBusy(true); try { await applyOperations(operations, reason); notify('测试点树结构已保存为新 revision。', 'success') } catch (error) { notify(error instanceof Error ? error.message : '测试点树结构修改失败', 'error') } finally { setBusy(false) } }
  const add = (parentId: string | null) => { if (!selected) return; const value = treeNodeContent(selected); void mutate([{ op: 'add', clientNodeRef: `manual-${Date.now()}`, parentId, sortKey: `${selected.sortKey}.5`, value: { ...value, title: parentId === selected.nodeId ? '新建子测试点' : '新建同级测试点' } }], '人工新增测试点') }
  const move = (direction: -1 | 1) => { if (!selected) return; const siblings = nodes.filter(item => item.parentId === selected.parentId); const index = siblings.findIndex(item => item.nodeId === selected.nodeId); const target = siblings[index + direction]; if (!target) return notify('当前节点在该层级已无法继续移动。', 'warning'); void mutate([{ op: 'reorder', nodeId: selected.nodeId, sortKey: target.sortKey }, { op: 'reorder', nodeId: target.nodeId, sortKey: selected.sortKey }], '人工调整测试点顺序') }
  const approve = async () => { setBusy(true); try { const current = await loadTestPointTree(projectVersionId, designId, run.id); await approveTestPointTree(projectVersionId, designId, run.id, current.etag); await onRefresh(); notify('当前测试点树 revision 已批准；关联用例需重新复核。', 'success') } catch (error) { notify(error instanceof Error ? error.message : '测试点树批准失败', 'error') } finally { setBusy(false) } }
  return <div className="td-run-artifact-view">
    <RunArtifactHeader title="测试点树" description={`${tree.id} · revision r${tree.currentRevision} · 保存与批准为独立操作`}><StatusPill tone={approved ? 'success' : 'warning'}>{approved ? `已批准 v${approved.version}` : '待批准'}</StatusPill><button className="icon-btn" title="新建同级测试点" aria-label="新建同级测试点" disabled={busy || !selected} onClick={() => add(selected?.parentId ?? null)}><Plus /></button><button className="icon-btn" title="新建子测试点" aria-label="新建子测试点" disabled={busy || !selected} onClick={() => add(selected!.nodeId)}><GitBranch /></button><button className="icon-btn" title="上移" aria-label="上移测试点" disabled={busy || !selected} onClick={() => move(-1)}><ArrowUp /></button><button className="icon-btn" title="下移" aria-label="下移测试点" disabled={busy || !selected} onClick={() => move(1)}><ArrowDown /></button><button className="icon-btn" title="删除测试点" aria-label="删除测试点" disabled={busy || !selected} onClick={() => selected && window.confirm(`删除“${selected.title}”并提升其子节点，是否继续？`) && void mutate([{ op: 'delete', nodeId: selected.nodeId }], '人工删除测试点')}><Trash2 /></button><button className="btn" disabled={!dirty || busy} onClick={() => void save()}>{busy ? <RefreshCw className="spin" /> : <Check />}{busy ? '处理中' : '保存 revision'}</button><button className="btn primary" disabled={Boolean(approved) || dirty || busy} onClick={() => void approve()}><ShieldCheck />批准当前 revision</button></RunArtifactHeader>
    <div className="td-run-tree-layout"><div className="td-run-table td-run-tree-table"><div className="td-run-table-head"><span>测试点</span><span>维度</span><span>方式</span><span>优先级</span><span>依据</span></div>{nodes.map(node => <button className={node.nodeId === selected?.nodeId ? 'active' : ''} key={node.nodeId} onClick={() => setSelectedId(node.nodeId)}><span><TestTube2 /><p><b>{node.title}</b><small>{node.objective}</small><code>{shortId(node.nodeId)}</code></p></span><RunDimensionTag dimension={node.dimension} /><em>{node.entryMethods.map(value => value.toUpperCase()).join(' + ') || '-'}</em><strong className={node.priority === 'P0' ? 'danger' : ''}>{node.priority}</strong><small>{node.basisRefs.length}</small></button>)}</div>
    {draft && <section className="td-real-tree-editor"><header><Pencil /><div><small>当前节点</small><b>{shortId(draft.nodeId)}</b></div><StatusPill tone={dirty ? 'warning' : 'neutral'}>{dirty ? '有未保存修改' : '已保存'}</StatusPill></header><label><span>测试点名称</span><input value={draft.title} onChange={event => change({ title: event.target.value })} /></label><label><span>测试目标</span><textarea value={draft.objective} onChange={event => change({ objective: event.target.value })} /></label><div><label><span>测试维度</span><select value={draft.dimension} onChange={event => change({ dimension: event.target.value as TestPointNode['dimension'] })}>{Object.entries(runDimensionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>优先级</span><select value={draft.priority} onChange={event => change({ priority: event.target.value as TestPointNode['priority'] })}>{['P0', 'P1', 'P2', 'P3'].map(value => <option key={value}>{value}</option>)}</select></label></div><label><span>执行入口</span><div className="td-real-tree-methods"><button className={draft.entryMethods.includes('ui') ? 'active' : ''} onClick={() => change({ entryMethods: draft.entryMethods.includes('ui') ? draft.entryMethods.filter(item => item !== 'ui') : [...draft.entryMethods, 'ui'] })}>UI</button><button className={draft.entryMethods.includes('api') ? 'active' : ''} onClick={() => change({ entryMethods: draft.entryMethods.includes('api') ? draft.entryMethods.filter(item => item !== 'api') : [...draft.entryMethods, 'api'] })}>API</button></div></label><label><span>可判定预期</span><textarea value={draft.oracle} onChange={event => change({ oracle: event.target.value })} /></label><label><span>固定依据引用（逗号或换行分隔）</span><textarea value={draft.basisRefs.join('\n')} onChange={event => change({ basisRefs: textItems(event.target.value) })} placeholder="从左侧固定依据复制 ID，用于修复依据未覆盖阻断" /></label></section>}</div>
  </div>
}

function treeNodeContent(node: TestPointNode): Omit<TestPointNode, 'nodeId' | 'parentId' | 'sortKey' | 'deleted'> {
  const { nodeId: _nodeId, parentId: _parentId, sortKey: _sortKey, deleted: _deleted, ...content } = node
  return content
}

function RunCasesArtifact({ run, projectVersionId, designId, notify, onRefresh, selectedCaseId, onSelectCase, onNewCase }: { run: TestDesignWorkflowRun; projectVersionId: string; designId: string; notify: Notify; onRefresh: () => Promise<void>; selectedCaseId: string | null; onSelectCase: (caseId: string) => void; onNewCase: (pointId?: string) => void }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [submitting, setSubmitting] = useState(false)
  const cases = run.testCases.map(testCase => ({ testCase, content: currentCaseContent(testCase) })).filter((item): item is { testCase: TestDesignCase; content: TestCaseContent } => Boolean(item.content) && !item.testCase.tombstonedAt)
  const filtered = cases.filter(({ testCase, content }) => (status === 'all' || testCase.reviewState === status) && (!query.trim() || `${testCase.id} ${content.title} ${content.objective}`.toLowerCase().includes(query.trim().toLowerCase())))
  const completeReviews = async () => {
    const active = cases.filter(item => item.testCase.reviewState !== 'approved')
    if (!active.length) return
    setSubmitting(true)
    try {
      const submitTargets = active.filter(item => ['draft', 'rejected', 'needs_revision'].includes(item.testCase.reviewState)).map(item => ({ caseId: item.testCase.id, targetRevision: item.testCase.currentRevision }))
      if (submitTargets.length) await batchReviewTestDesignCases(projectVersionId, designId, run.id, { targets: submitTargets, decision: 'submit', comment: '批量提交发布前审核' })
      await batchReviewTestDesignCases(projectVersionId, designId, run.id, { targets: active.map(item => ({ caseId: item.testCase.id, targetRevision: item.testCase.currentRevision })), decision: 'approve', comment: '批量批准当前固定 revision' })
      await reAuditTestDesignRun(projectVersionId, designId, run.id)
      await onRefresh()
      notify(`${active.length} 条用例已批准，并已重新执行覆盖审计。`, 'success')
    } catch (error) { notify(error instanceof Error ? error.message : '批量审核失败', 'error') }
    finally { setSubmitting(false) }
  }
  return <div className="td-run-artifact-view">
    <RunArtifactHeader title="测试用例" description={`${cases.length} 条当前用例 · 编辑保存会创建新 revision 并使覆盖审计失效`}><button className="btn" disabled={submitting || cases.every(item => item.testCase.reviewState === 'approved')} onClick={() => void completeReviews()}><Users />{submitting ? '审核中' : '批量完成审核'}</button><button className="btn primary" onClick={() => onNewCase()}><Plus />新建用例</button></RunArtifactHeader>
    <div className="td-real-case-filters"><label><Search /><input aria-label="搜索真实测试用例" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索用例 ID、标题或目标" /></label><select aria-label="按审核状态筛选" value={status} onChange={event => setStatus(event.target.value)}><option value="all">全部审核状态</option>{Object.entries(reviewStateLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><span>{cases.filter(item => item.testCase.reviewState === 'approved').length} / {cases.length} 已批准</span></div>
    {filtered.length ? <div className="td-run-table td-run-case-table"><div className="td-run-table-head"><span>用例</span><span>维度</span><span>方式</span><span>优先级</span><span>审核</span></div>{filtered.map(({ testCase, content }) => <button className={testCase.id === selectedCaseId ? 'active' : ''} key={testCase.id} onClick={() => onSelectCase(testCase.id)}><span><ListChecks /><p><b>{content.title}</b><small>{content.objective}</small><code>{shortId(testCase.id)} · r{testCase.currentRevision} · {testCase.origin}</code></p></span><RunDimensionTag dimension={content.dimension} /><em>{content.executionMethods.map(method => method.method.toUpperCase()).join(' + ')}</em><strong className={content.priority === 'P0' ? 'danger' : ''}>{content.priority}</strong><StatusPill tone={testCase.reviewState === 'approved' ? 'success' : testCase.reviewState === 'rejected' || testCase.reviewState === 'needs_revision' ? 'danger' : 'warning'}>{reviewStateLabels[testCase.reviewState]}</StatusPill></button>)}</div> : <RunIntentionalEmpty icon={<ListChecks />} title={cases.length ? '没有匹配的测试用例' : '当前运行没有测试用例'} description={cases.length ? '调整搜索词或审核状态后重试。' : '可以新建一条关联已批准测试点的结构化用例。'} />}
  </div>
}

function RunCaseSetArtifact({ run, projectId, projectVersionId, designId, notify, onRefresh, onSelectCase, onNewCase, onOpenTree }: { run: TestDesignWorkflowRun; projectId: string; projectVersionId: string; designId: string; notify: Notify; onRefresh: () => Promise<void>; onSelectCase: (caseId: string) => void; onNewCase: (pointId?: string) => void; onOpenTree: () => void }) {
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const versions = run.caseSetVersions ?? []
  const audit = latestCoverageAudit(run)
  const approved = run.testCases.filter(item => item.reviewState === 'approved' && !item.tombstonedAt).length
  const publish = async () => {
    if (!audit || !canPublishRun(run) || !name.trim()) return
    setSubmitting(true)
    try { await publishTestCaseSet(projectVersionId, designId, run.id, { name: name.trim(), expectedAuditId: audit.id, expectedCaseSetSha256: audit.caseSetSha256 }); await onRefresh(); notify('新功能用例集已发布为不可变版本。', 'success'); setName('') }
    catch (error) { notify(error instanceof Error ? error.message : '用例集发布失败', 'error') }
    finally { setSubmitting(false) }
  }
  return <div className="td-run-artifact-view">
    <RunArtifactHeader title="新功能用例集" description="工作流成功产生候选用例；人工批准并通过覆盖门禁后才能发布不可变版本"><StatusPill tone={versions.length ? 'success' : canPublishRun(run) ? 'info' : 'warning'}>{versions.length ? `已发布 ${versions.length} 个版本` : canPublishRun(run) ? '可发布' : '待发布'}</StatusPill></RunArtifactHeader>
    <section className="td-run-set-summary"><article><span><ListChecks /></span><p><small>候选用例</small><b>{run.testCases.filter(item => !item.tombstonedAt).length}</b><em>当前运行</em></p></article><article><span><ShieldCheck /></span><p><small>已批准</small><b>{approved}</b><em>发布要求全部批准</em></p></article><article><span><AlertTriangle /></span><p><small>发布阻断</small><b>{audit?.blockers.length ?? 0}</b><em>{audit?.status === 'valid' ? '当前审计有效' : '需要重新审计'}</em></p></article></section>
    {versions.length > 0 && <section className="td-run-published-sets"><header><b>已发布版本</b><span>不可变固定产物</span></header>{versions.map(version => <article key={version.id}><Layers3 /><p><small>v{version.version} · {formatRunTime(version.publishedAt)}</small><b>{version.name}</b><code>{shortHash(version.contentSha256)}</code></p><StatusPill tone={version.projection.status === 'succeeded' ? 'success' : version.projection.status === 'failed' ? 'danger' : 'info'}>知识投影 {version.projection.status}</StatusPill><strong>{version.members.length} 条</strong><span className="td-export-actions"><a className="btn" href={testCaseSetExportUrl(version.id, 'json')}><FileJson2 />JSON</a><a className="btn" href={testCaseSetExportUrl(version.id, 'markdown')}><FileText />Markdown</a><a className="btn" href={testCaseSetExportUrl(version.id, 'xlsx')}><Download />Excel</a></span></article>)}</section>}
    {versions.at(-1) && <PublishedCaseSetOperations version={versions.at(-1)!} run={run} projectId={projectId} notify={notify} />}
    {audit && audit.blockers.length > 0 && <RunBlockerList audit={audit} run={run} onSelectCase={onSelectCase} onNewCase={onNewCase} onOpenTree={onOpenTree} />}
    {canPublishRun(run) && <section className="td-real-publish-form"><div><LockKeyhole /><p><b>发布不可变新功能用例集</b><small>固定当前 caseId、revision、树版本、数据版本和覆盖审计 Hash。</small></p></div><input aria-label="用例集名称" value={name} onChange={event => setName(event.target.value)} placeholder="填写用例集名称" /><button className="btn primary" disabled={!name.trim() || submitting} onClick={() => void publish()}>{submitting ? <RefreshCw className="spin" /> : <LockKeyhole />}{submitting ? '发布中' : '确认发布'}</button></section>}
  </div>
}

function PublishedCaseSetOperations({ version, run, projectId, notify }: { version: NonNullable<TestDesignWorkflowRun['caseSetVersions']>[number]; run: TestDesignWorkflowRun; projectId: string; notify: Notify }) {
  const [suites, setSuites] = useState<TestSuiteVersion[]>([])
  const [candidates, setCandidates] = useState<SmokeCandidate[]>([])
  const [impacted, setImpacted] = useState<ImpactedRegression[]>([])
  const [handoffs, setHandoffs] = useState<TestExecutionHandoff[]>([])
  const [strategy, setStrategy] = useState<'standard' | 'fast' | 'full'>('standard')
  const [smokeSuiteId, setSmokeSuiteId] = useState('')
  const [regressionSuiteId, setRegressionSuiteId] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = async () => { const [suiteResponse, candidateResponse, impactResponse, handoffResponse] = await Promise.all([loadProjectTestSuites(projectId), loadSmokeCandidates(version.id), loadImpactedRegression(version.id), loadExecutionHandoffs(version.id)]); setSuites(suiteResponse.items); setCandidates(candidateResponse.items); setImpacted(impactResponse.items); setHandoffs(handoffResponse.items); setSmokeSuiteId(current => current || suiteResponse.items.find(item => item.suiteType === 'smoke')?.id || ''); setRegressionSuiteId(current => current || suiteResponse.items.find(item => item.suiteType === 'regression')?.id || '') }
  useEffect(() => { void refresh().catch(error => notify(error instanceof Error ? error.message : '发布后操作加载失败', 'error')) }, [projectId, version.id])
  const decideCandidate = async (caseId: string, decision: 'accepted' | 'rejected') => { const testCase = run.testCases.find(item => item.id === caseId); const content = testCase && currentCaseContent(testCase); const executionMethods = content?.executionMethods.filter(item => item.executionReadiness === 'ready').map(item => item.method) ?? []; if (!executionMethods.length) return notify('该用例没有 ready 的执行方式，不能进入冒烟候选。', 'warning'); setBusy(true); try { await reviewSmokeCandidate(version.id, caseId, { executionMethods, reason: decision === 'accepted' ? '人工确认进入本次冒烟组合' : '人工确认不进入本次冒烟组合', estimatedMinutes: 5, stable: decision === 'accepted', dependencyReady: decision === 'accepted', decision }); await refresh(); notify('冒烟候选决定已保存。', 'success') } catch (error) { notify(error instanceof Error ? error.message : '冒烟候选保存失败', 'error') } finally { setBusy(false) } }
  const toggleImpact = async (suite: TestSuiteVersion, caseId: string) => { const exists = impacted.some(item => item.suiteVersionId === suite.id && item.caseId === caseId); const next = exists ? impacted.filter(item => item.suiteVersionId !== suite.id || item.caseId !== caseId) : [...impacted, { testCaseSetVersionId: version.id, suiteVersionId: suite.id, caseId, executionMethods: suite.members.find(item => item.caseId === caseId)!.executionMethods, reason: '人工确认本次变更影响该固定回归用例', actorId: '', createdAt: '' }]; setBusy(true); try { await saveImpactedRegression(version.id, next.map(({ suiteVersionId, caseId: id, executionMethods, reason }) => ({ suiteVersionId, caseId: id, executionMethods, reason }))); await refresh(); notify('影响回归引用已保存。', 'success') } catch (error) { notify(error instanceof Error ? error.message : '影响回归保存失败', 'error') } finally { setBusy(false) } }
  const createHandoff = async () => { setBusy(true); try { await createExecutionHandoff(version.id, { strategy, ...(strategy === 'full' ? {} : { smokeSuiteVersionId: smokeSuiteId }), regressionSuiteVersionId: regressionSuiteId, expectedCaseSetSha256: version.contentSha256 }); await refresh(); notify('不可变执行交接已生成。', 'success') } catch (error) { notify(error instanceof Error ? error.message : '执行交接生成失败', 'error') } finally { setBusy(false) } }
  const regression = suites.find(item => item.id === regressionSuiteId)
  return <section className="td-published-operations"><header><b>发布后固定关系与执行交接</b><span>所有选择均绑定明确版本，不使用 latest</span></header><div className="td-smoke-review-list">{version.members.map(member => { const current = candidates.find(item => item.caseId === member.caseId); const testCase = run.testCases.find(item => item.id === member.caseId); return <article key={member.caseId}><TestTube2 /><p><b>{testCase ? currentCaseContent(testCase)?.title : shortId(member.caseId)}</b><small>{current?.decision ?? '尚未确认冒烟候选'}</small></p><button className="btn" disabled={busy} onClick={() => void decideCandidate(member.caseId, 'accepted')}><Check />接受</button><button className="icon-btn" title="拒绝冒烟候选" aria-label="拒绝冒烟候选" disabled={busy} onClick={() => void decideCandidate(member.caseId, 'rejected')}><X /></button></article> })}</div><div className="td-handoff-controls"><select aria-label="执行交接策略" value={strategy} onChange={event => setStrategy(event.target.value as typeof strategy)}><option value="standard">标准流程</option><option value="fast">快速验证</option><option value="full">直接全量</option></select>{strategy !== 'full' && <select aria-label="固定冒烟套件版本" value={smokeSuiteId} onChange={event => setSmokeSuiteId(event.target.value)}><option value="">选择冒烟版本</option>{suites.filter(item => item.suiteType === 'smoke').map(item => <option key={item.id} value={item.id}>{item.name} v{item.version}</option>)}</select>}<select aria-label="固定回归套件版本" value={regressionSuiteId} onChange={event => setRegressionSuiteId(event.target.value)}><option value="">选择回归版本</option>{suites.filter(item => item.suiteType === 'regression').map(item => <option key={item.id} value={item.id}>{item.name} v{item.version}</option>)}</select><button className="btn primary" disabled={busy || !regressionSuiteId || (strategy !== 'full' && !smokeSuiteId)} onClick={() => void createHandoff()}><Play />生成交接</button></div>{regression && <div className="td-impact-list"><b>影响回归引用</b>{regression.members.map(member => <button className={impacted.some(item => item.suiteVersionId === regression.id && item.caseId === member.caseId) ? 'active' : ''} key={member.caseId} disabled={busy} onClick={() => void toggleImpact(regression, member.caseId)}><Link2 />{shortId(member.caseId)}<Check /></button>)}</div>}{handoffs.length > 0 && <div className="td-handoff-list">{handoffs.map(item => <article key={item.id}><Network /><p><b>{item.strategy}</b><small>{item.members.length} 个固定执行成员 · {formatRunTime(item.createdAt)}</small><code>{shortHash(item.contentSha256)}</code></p><StatusPill tone="success">不可变</StatusPill></article>)}</div>}</section>
}

function RunDataArtifact({ run, projectVersionId, designId, notify, onRefresh }: { run: TestDesignWorkflowRun; projectVersionId: string; designId: string; notify: Notify; onRefresh: () => Promise<void> }) {
  const version = run.dataSetVersions.at(-1)!
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(() => JSON.stringify(version.requirements, null, 2))
  const [busy, setBusy] = useState(false)
  useEffect(() => setDraft(JSON.stringify(version.requirements, null, 2)), [version.id])
  const save = async () => { setBusy(true); try { const value = JSON.parse(draft) as typeof version.requirements; if (!Array.isArray(value)) throw new Error('测试数据需求必须是数组'); await replaceTestDataRequirements(projectVersionId, designId, run.id, value); await onRefresh(); setEditing(false); notify('测试数据需求已保存为新版本，覆盖审计已失效。', 'success') } catch (error) { notify(error instanceof Error ? error.message : '测试数据需求保存失败', 'error') } finally { setBusy(false) } }
  return <div className="td-run-artifact-view">
    <RunArtifactHeader title="测试数据需求" description={`v${version.version} · ${shortHash(version.contentSha256)} · 仅保存生成约束，不保存真实测试数据`}><StatusPill tone="info">{version.requirements.length} 项</StatusPill><button className="btn" onClick={() => setEditing(value => !value)}><Pencil />{editing ? '取消编辑' : '编辑约束'}</button></RunArtifactHeader>
    {editing && <section className="td-real-data-editor"><textarea aria-label="测试数据需求 JSON" value={draft} onChange={event => setDraft(event.target.value)} spellCheck={false} /><button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? <RefreshCw className="spin" /> : <Check />}{busy ? '保存中' : '保存新版本'}</button></section>}
    <div className="td-run-table td-run-data-table"><div className="td-run-table-head"><span>数据需求</span><span>实体</span><span>数量</span><span>敏感级别</span><span>Readiness</span><span>用例</span></div>{version.requirements.map(item => <article key={item.id}><span><Database /><p><b>{item.name}</b><small>{item.initialState}</small><code>{shortId(item.id)}</code></p></span><em>{item.entityType}</em><strong>{item.quantity}</strong><StatusPill tone={item.sensitivity === 'sensitive' ? 'warning' : 'neutral'}>{item.sensitivity}</StatusPill><StatusPill tone={item.readiness === 'ready' ? 'success' : item.readiness === 'blocked' ? 'danger' : 'warning'}>{item.readiness}</StatusPill><small>{item.caseIds.length}</small></article>)}</div>
  </div>
}

function RunCoverageArtifact({ run, projectVersionId, designId, notify, onRefresh, onSelectCase, onNewCase, onOpenTree }: { run: TestDesignWorkflowRun; projectVersionId: string; designId: string; notify: Notify; onRefresh: () => Promise<void>; onSelectCase: (caseId: string) => void; onNewCase: (pointId?: string) => void; onOpenTree: () => void }) {
  const [auditing, setAuditing] = useState(false)
  const audit = latestCoverageAudit(run)!
  const basisRatio = audit.statistics.totalBasis ? Math.round(audit.statistics.coveredBasis / audit.statistics.totalBasis * 100) : 100
  const pointRatio = audit.statistics.totalPoints ? Math.round(audit.statistics.coveredPoints / audit.statistics.totalPoints * 100) : 100
  return <div className="td-run-artifact-view">
    <RunArtifactHeader title="覆盖反向审计" description={`${audit.status === 'valid' ? '当前有效' : '已失效'} · ${shortHash(audit.inputSha256)}`}><StatusPill tone={audit.blockers.length ? 'warning' : 'success'}>{audit.blockers.length} 个阻断项</StatusPill><button className="btn primary" disabled={auditing} onClick={async () => { setAuditing(true); try { const next = await reAuditTestDesignRun(projectVersionId, designId, run.id); await onRefresh(); notify(next.blockers.length ? `重新审计完成，仍有 ${next.blockers.length} 个阻断项。` : '重新审计通过，发布阻断已清零。', next.blockers.length ? 'warning' : 'success') } catch (error) { notify(error instanceof Error ? error.message : '重新审计失败', 'error') } finally { setAuditing(false) } }}><RefreshCw className={auditing ? 'spin' : ''} />{auditing ? '审计中' : '重新审计'}</button></RunArtifactHeader>
    <section className="td-run-coverage-summary"><article><small>依据覆盖</small><b>{basisRatio}%</b><em>{audit.statistics.coveredBasis} / {audit.statistics.totalBasis}</em></article><article><small>测试点覆盖</small><b>{pointRatio}%</b><em>{audit.statistics.coveredPoints} / {audit.statistics.totalPoints}</em></article><article><small>当前用例</small><b>{audit.statistics.totalCases}</b><em>{audit.statistics.approvedCases} 条已批准</em></article><article><small>映射关系</small><b>{audit.relations.length}</b><em>双向可追溯</em></article></section>
    {audit.blockers.length ? <RunBlockerList audit={audit} run={run} onSelectCase={onSelectCase} onNewCase={onNewCase} onOpenTree={onOpenTree} /> : <RunIntentionalEmpty icon={<ShieldCheck />} title="覆盖审计已通过" description="当前固定树、用例 revision 集合和数据需求没有发布阻断项。" />}
  </div>
}

function RunBlockerList({ audit, run, onSelectCase, onNewCase, onOpenTree }: { audit: TestDesignCoverageAudit; run: TestDesignWorkflowRun; onSelectCase: (caseId: string) => void; onNewCase: (pointId?: string) => void; onOpenTree: () => void }) {
  const caseIds = new Set(run.testCases.map(item => item.id))
  return <section className="td-run-blockers"><header><b>发布阻断项</b><span>{audit.blockers.length}</span></header>{audit.blockers.map((blocker, index) => { const isCase = Boolean(blocker.subjectId && caseIds.has(blocker.subjectId)); const isPoint = blocker.code === 'COVERAGE_TEST_POINT_UNCOVERED'; return <article key={`${blocker.code}-${blocker.subjectId ?? index}`}><AlertTriangle /><p><small>{blocker.code}</small><b>{blocker.message}</b>{blocker.subjectId && <code>{shortId(blocker.subjectId)}</code>}</p>{isCase && <button className="btn" onClick={() => onSelectCase(blocker.subjectId!)}><Pencil />修改用例</button>}{isPoint && <button className="btn primary" onClick={() => onNewCase(blocker.subjectId)}><Plus />创建关联用例</button>}{!isCase && !isPoint && <button className="btn" onClick={onOpenTree}><Network />编辑测试点树</button>}</article> })}</section>
}

function emptyExecutionMethod(method: 'ui' | 'api'): TestCaseContent['executionMethods'][number] {
  const common = { executionReadiness: 'ready' as const, steps: [{ key: 'step-1', action: '', expected: '' }], verificationChecks: [], automationHint: '' }
  return method === 'ui'
    ? { method, uiSpec: { entry: '/', viewport: '', selectors: [] }, ...common }
    : { method, apiSpec: { method: 'GET', path: '/' }, ...common }
}

function emptyRunCase(run: TestDesignWorkflowRun, initialPointId?: string | null): TestCaseContent {
  const point = currentTreeNodes(run).find(item => item.nodeId === initialPointId) ?? currentTreeNodes(run)[0]
  return { schemaVersion: 'test-case/v1', title: '', objective: '', dimension: point?.dimension ?? 'functional', testPointIds: point ? [point.nodeId] : [], priority: point?.priority ?? 'P1', preconditions: [], dataRequirementIds: [], cleanup: [], dependencies: [], executionMethods: [emptyExecutionMethod(point?.entryMethods[0] ?? 'ui')], sharedVerificationChecks: [], tags: [], domain: '' }
}

function textItems(value: string) { return value.split(/\r?\n|,/u).map(item => item.trim()).filter(Boolean) }
function checksFromText(value: string, prefix: string) { return value.split(/\r?\n/u).map(item => item.trim()).filter(Boolean).map((description, index) => ({ key: `${prefix}-${index + 1}`, description })) }

function RunCaseEditor({ projectVersionId, designId, run, caseId, initialPointId, notify, onRefresh, onCreated }: { projectVersionId: string; designId: string; run: TestDesignWorkflowRun; caseId: string; initialPointId: string | null; notify: Notify; onRefresh: () => Promise<void>; onCreated: (caseId: string) => void }) {
  const isNew = caseId === '__new__'
  const [testCase, setTestCase] = useState<TestDesignCase | null>(null)
  const [etag, setEtag] = useState('')
  const [draft, setDraft] = useState<TestCaseContent>(() => emptyRunCase(run, initialPointId))
  const [dirty, setDirty] = useState(isNew)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [reason, setReason] = useState(isNew ? '人工新建测试用例' : '修订测试用例')
  const [reviewComment, setReviewComment] = useState('')
  const points = currentTreeNodes(run).filter(item => item.applicability !== 'not_applicable')
  const dataRequirements = run.dataSetVersions.at(-1)?.requirements ?? []

  useEffect(() => {
    if (isNew) return
    setBusy(true)
    void loadTestDesignCase(projectVersionId, designId, run.id, caseId).then(value => {
      const content = currentCaseContent(value)
      if (!content) throw new Error('当前用例 revision 不存在')
      setTestCase(value); setEtag(value.etag ?? ''); setDraft(structuredClone(content)); setDirty(false); setConflict(false); setLoadError('')
    }).catch(error => setLoadError(error instanceof Error ? error.message : '用例加载失败')).finally(() => setBusy(false))
  }, [caseId, designId, isNew, projectVersionId, run.id])

  const change = (patch: Partial<TestCaseContent>) => { setDraft(current => ({ ...current, ...patch })); setDirty(true); setConflict(false) }
  const changeMethod = (index: number, patch: Partial<TestCaseContent['executionMethods'][number]>) => change({ executionMethods: draft.executionMethods.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } as TestCaseContent['executionMethods'][number] : item) })
  const toggleMethod = (method: 'ui' | 'api') => {
    const exists = draft.executionMethods.some(item => item.method === method)
    if (exists && draft.executionMethods.length === 1) return notify('每条测试用例至少保留一种执行方式。', 'warning')
    if (exists && !window.confirm(`移除 ${method.toUpperCase()} 执行方式会删除该分支的 Spec、步骤和检查点，是否继续？`)) return
    change({ executionMethods: exists ? draft.executionMethods.filter(item => item.method !== method) : [...draft.executionMethods, emptyExecutionMethod(method)] })
  }
  const save = async () => {
    if (!draft.title.trim() || !draft.objective.trim() || !draft.domain.trim() || !draft.testPointIds.length || draft.executionMethods.some(method => !method.steps.length || method.steps.some(step => !step.action.trim() || !step.expected.trim()) || (method.method === 'ui' ? !method.uiSpec.entry.trim() : !method.apiSpec.method.trim() || !method.apiSpec.path.trim()))) {
      notify('请补齐标题、测试目标、业务域、测试点，以及每个执行分支的 Spec、步骤和期望。', 'error'); return
    }
    setBusy(true)
    try {
      if (isNew) {
        const created = await createTestDesignCase(projectVersionId, designId, run.id, draft)
        await onRefresh(); onCreated(created.id); notify('测试用例已创建为 revision 0。', 'success')
      } else {
        if (!etag) throw new Error('当前用例缺少 ETag，请重新加载')
        const saved = await updateTestDesignCase(projectVersionId, designId, run.id, caseId, etag, draft, reason.trim() || '修订测试用例')
        setTestCase(saved); setEtag(saved.etag ?? ''); setDraft(structuredClone(currentCaseContent(saved)!)); setDirty(false); setConflict(false); await onRefresh(); notify(`已保存 revision r${saved.currentRevision}。`, 'success')
      }
    } catch (error) { const message = error instanceof Error ? error.message : '用例保存失败'; setConflict(/revision|etag|冲突/iu.test(message)); notify(message, 'error') }
    finally { setBusy(false) }
  }
  const review = async (decision: 'submit' | 'approve' | 'reject' | 'request_revision' | 'withdraw') => {
    if (!testCase || dirty) return
    setBusy(true)
    try {
      const next = await reviewTestDesignCase(projectVersionId, designId, run.id, testCase.id, { decision, targetRevision: testCase.currentRevision, ...(reviewComment.trim() ? { comment: reviewComment.trim() } : {}) })
      setTestCase(next); setReviewComment(''); await onRefresh(); notify(decision === 'approve' ? '当前 revision 已批准。' : decision === 'submit' ? '当前 revision 已提交审核。' : '审核状态已更新。', decision === 'reject' || decision === 'request_revision' ? 'warning' : 'success')
    } catch (error) { notify(error instanceof Error ? error.message : '审核操作失败', 'error') }
    finally { setBusy(false) }
  }
  if (busy && !isNew && !testCase && !loadError) return <aside className="td-detail-panel td-case-editor"><RunLoading /></aside>
  if (loadError) return <aside className="td-detail-panel td-case-editor"><div className="td-run-intentional-empty"><XCircle /><h2>用例加载失败</h2><p>{loadError}</p></div></aside>
  const state = testCase?.reviewState ?? 'draft'
  return <aside className="td-detail-panel td-case-editor td-real-case-editor">
    <header><div><small>{isNew ? '人工新建' : '结构化用例'}</small><b>{isNew ? '新用例草稿' : shortId(caseId)}</b></div><RunDimensionTag dimension={draft.dimension} /><StatusPill tone={state === 'approved' ? 'success' : state === 'rejected' || state === 'needs_revision' ? 'danger' : 'warning'}>{reviewStateLabels[state]}</StatusPill></header>
    <div className="td-editor-meta"><StatusPill tone="neutral">revision {isNew ? '待创建' : `r${testCase?.currentRevision ?? '-'}`}</StatusPill><span className={conflict ? 'conflict' : dirty ? 'dirty' : 'saved'}>{conflict ? 'revision 冲突' : dirty ? '有未保存修改' : '已保存'}</span></div>
    {conflict && <div className="td-editor-alert" role="alert"><AlertTriangle /><p><b>服务器 revision 已变化</b><small>当前输入没有覆盖服务器内容。重新打开该用例后再应用修改。</small></p><button onClick={() => window.location.reload()}>重新加载</button></div>}
    <div className="td-detail-scroll">
      <label><span>用例标题</span><input value={draft.title} disabled={state === 'in_review'} onChange={event => change({ title: event.target.value })} /></label>
      <label><span>测试目标</span><textarea value={draft.objective} disabled={state === 'in_review'} onChange={event => change({ objective: event.target.value })} /></label>
      <div className="td-method-contract-grid"><label><span>测试维度</span><select value={draft.dimension} disabled={state === 'in_review'} onChange={event => change({ dimension: event.target.value as TestCaseContent['dimension'] })}>{Object.entries(runDimensionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>优先级</span><select value={draft.priority} disabled={state === 'in_review'} onChange={event => change({ priority: event.target.value as TestCaseContent['priority'] })}>{['P0', 'P1', 'P2', 'P3'].map(value => <option key={value}>{value}</option>)}</select></label></div>
      <label><span>业务域</span><input value={draft.domain} disabled={state === 'in_review'} onChange={event => change({ domain: event.target.value })} placeholder="例如：身份认证" /></label>
      <fieldset className="td-real-point-selector"><legend>关联测试点</legend>{points.map(point => <label key={point.nodeId}><input type="checkbox" disabled={state === 'in_review'} checked={draft.testPointIds.includes(point.nodeId)} onChange={event => change({ testPointIds: event.target.checked ? [...draft.testPointIds, point.nodeId] : draft.testPointIds.filter(id => id !== point.nodeId) })} /><span><b>{point.title}</b><small>{shortId(point.nodeId)}</small></span></label>)}</fieldset>
      <div className="td-method-segment" aria-label="执行方式，可多选"><button type="button" disabled={state === 'in_review'} aria-pressed={draft.executionMethods.some(item => item.method === 'ui')} className={draft.executionMethods.some(item => item.method === 'ui') ? 'active' : ''} onClick={() => toggleMethod('ui')}><TableProperties />UI</button><button type="button" disabled={state === 'in_review'} aria-pressed={draft.executionMethods.some(item => item.method === 'api')} className={draft.executionMethods.some(item => item.method === 'api') ? 'active' : ''} onClick={() => toggleMethod('api')}><Braces />API</button></div>
      <label><span>共同前置条件（每行一项）</span><textarea value={draft.preconditions.join('\n')} disabled={state === 'in_review'} onChange={event => change({ preconditions: textItems(event.target.value) })} /></label>
      {draft.executionMethods.map((method, methodIndex) => <section className="td-step-editor td-method-editor td-method-contract" key={method.method}><header><b>{method.method === 'ui' ? <TableProperties /> : <Braces />}{method.method.toUpperCase()} 独立执行分支</b><button type="button" disabled={state === 'in_review'} onClick={() => changeMethod(methodIndex, { steps: [...method.steps, { key: `step-${method.steps.length + 1}`, action: '', expected: '' }] })}><Plus />添加步骤</button></header>
        {method.method === 'ui' ? <><label><span>页面入口</span><input value={method.uiSpec.entry} disabled={state === 'in_review'} onChange={event => changeMethod(methodIndex, { uiSpec: { ...method.uiSpec, entry: event.target.value } } as Partial<typeof method>)} /></label><label><span>视口 / 环境</span><input value={method.uiSpec.viewport ?? ''} disabled={state === 'in_review'} onChange={event => changeMethod(methodIndex, { uiSpec: { ...method.uiSpec, viewport: event.target.value } } as Partial<typeof method>)} /></label></> : <div className="td-method-contract-grid"><label><span>HTTP 方法</span><input value={method.apiSpec.method} disabled={state === 'in_review'} onChange={event => changeMethod(methodIndex, { apiSpec: { ...method.apiSpec, method: event.target.value } } as Partial<typeof method>)} /></label><label><span>接口路径</span><input value={method.apiSpec.path} disabled={state === 'in_review'} onChange={event => changeMethod(methodIndex, { apiSpec: { ...method.apiSpec, path: event.target.value } } as Partial<typeof method>)} /></label></div>}
        {method.steps.map((step, stepIndex) => <article key={step.key}><em>{stepIndex + 1}</em><div><input aria-label={`${method.method} 步骤 ${stepIndex + 1} 操作`} value={step.action} disabled={state === 'in_review'} onChange={event => changeMethod(methodIndex, { steps: method.steps.map((item, index) => index === stepIndex ? { ...item, action: event.target.value } : item) })} /><textarea aria-label={`${method.method} 步骤 ${stepIndex + 1} 期望`} value={step.expected} disabled={state === 'in_review'} onChange={event => changeMethod(methodIndex, { steps: method.steps.map((item, index) => index === stepIndex ? { ...item, expected: event.target.value } : item) })} /></div><button type="button" className="icon-btn" disabled={state === 'in_review' || method.steps.length === 1} aria-label={`删除步骤 ${stepIndex + 1}`} onClick={() => changeMethod(methodIndex, { steps: method.steps.filter((_, index) => index !== stepIndex).map((item, index) => ({ ...item, key: `step-${index + 1}` })) })}><Trash2 /></button></article>)}
        <label><span>验证检查点（每行一项）</span><textarea value={method.verificationChecks.map(item => item.description).join('\n')} disabled={state === 'in_review'} onChange={event => changeMethod(methodIndex, { verificationChecks: checksFromText(event.target.value, `${method.method}-check`) })} /></label>
        <div className="td-method-contract-grid"><label><span>执行就绪</span><select value={method.executionReadiness} disabled={state === 'in_review'} onChange={event => changeMethod(methodIndex, { executionReadiness: event.target.value as typeof method.executionReadiness })}><option value="ready">ready</option><option value="blocked">blocked</option><option value="needs_confirmation">needs_confirmation</option></select></label><label><span>自动化提示</span><input value={method.automationHint} disabled={state === 'in_review'} onChange={event => changeMethod(methodIndex, { automationHint: event.target.value })} /></label></div>
      </section>)}
      <label><span>共享验证检查点（每行一项）</span><textarea value={draft.sharedVerificationChecks.map(item => item.description).join('\n')} disabled={state === 'in_review'} onChange={event => change({ sharedVerificationChecks: checksFromText(event.target.value, 'shared-check') })} /></label>
      <label><span>测试数据需求</span><select multiple value={draft.dataRequirementIds} disabled={state === 'in_review'} onChange={event => change({ dataRequirementIds: [...event.currentTarget.selectedOptions].map(option => option.value) })}>{dataRequirements.map(item => <option key={item.id} value={item.id}>{item.name} · {item.readiness}</option>)}</select></label>
      <label><span>依赖用例 ID（逗号或换行分隔）</span><textarea value={draft.dependencies.join('\n')} disabled={state === 'in_review'} onChange={event => change({ dependencies: textItems(event.target.value) })} /></label>
      <label><span>清理要求（每行一项）</span><textarea value={draft.cleanup.join('\n')} disabled={state === 'in_review'} onChange={event => change({ cleanup: textItems(event.target.value) })} /></label>
      <label><span>标签（逗号或换行分隔）</span><input value={draft.tags.join(', ')} disabled={state === 'in_review'} onChange={event => change({ tags: textItems(event.target.value) })} /></label>
      {!isNew && <><label><span>保存说明</span><input value={reason} disabled={state === 'in_review'} onChange={event => setReason(event.target.value)} /></label><label><span>审核意见</span><textarea value={reviewComment} onChange={event => setReviewComment(event.target.value)} placeholder="提交、批准或退回时追加记录" /></label></>}
    </div>
    <footer>{!isNew && state === 'in_review' && <><button className="btn" disabled={busy} onClick={() => void review('request_revision')}>退回修订</button><button className="btn primary" disabled={busy} onClick={() => void review('approve')}><ShieldCheck />批准</button></>}{!isNew && ['draft', 'rejected', 'needs_revision'].includes(state) && <button className="btn" disabled={busy || dirty} title={dirty ? '请先保存当前修改' : ''} onClick={() => void review('submit')}><Users />提交审核</button>}{!isNew && state === 'approved' && <button className="btn" disabled={busy || dirty} onClick={() => void review('request_revision')}><FileDiff />发起修订</button>}<button className="btn primary" disabled={busy || (!dirty && !isNew) || state === 'in_review'} onClick={() => void save()}>{busy ? <RefreshCw className="spin" /> : <Check />}{isNew ? '创建用例' : '保存 revision'}</button></footer>
  </aside>
}

function RunHistoryArtifact({ run }: { run: TestDesignWorkflowRun }) {
  const items = run.historicalSnapshot.items
  return <div className="td-run-artifact-view">
    <RunArtifactHeader title="历史用例复用" description={`固定快照 ${shortHash(run.historicalSnapshot.snapshotSha256)}`}><StatusPill tone={items.length ? 'info' : 'neutral'}>{items.length} 项</StatusPill></RunArtifactHeader>
    {items.length ? <div className="td-run-history-list">{items.map((value, index) => { const item = recordOf(value); const content = recordOf(item.content); return <article key={String(item.id ?? index)}><History /><p><small>{String(item.kind ?? '历史来源')}</small><b>{String(content.title ?? item.sourceId ?? `历史用例 ${index + 1}`)}</b><code>{shortHash(String(item.contentSha256 ?? ''))}</code></p><LockKeyhole /></article> })}</div> : <RunIntentionalEmpty icon={<History />} title="本次没有复用历史用例" description="创建运行时未选择历史用例来源，这是固定输入结果，不是数据缺失。" />}
  </div>
}

type TestDesignDispositionDraft = {
  kind: 'finding' | 'confirmation'
  id: string
  title: string
  description: string
  meta: string
  refs: string[]
  blocker: boolean
  expectedVersion: number
  decision: 'resolve' | 'defer' | 'reopen'
}

function RunQuestionsArtifact({ run, projectVersionId, designId, notify, onRefresh, onOpenGate }: { run: TestDesignWorkflowRun; projectVersionId: string; designId: string; notify: Notify; onRefresh: () => Promise<void>; onOpenGate: () => void }) {
  const items = run.confirmationItems
  const unresolvedCount = [...run.findings, ...items].filter(item => item.state === 'open').length
  const scopeGateWaiting = run.stage === 'scope_gate' && run.nodeRuns.some(item => item.nodeKey === 'scope_gate' && item.status === 'waiting_gate')
  const [busyId, setBusyId] = useState('')
  const [disposition, setDisposition] = useState<TestDesignDispositionDraft | null>(null)
  const openFindingDisposition = (item: TestDesignWorkflowRun['findings'][number], decision: TestDesignDispositionDraft['decision']) => setDisposition({ kind: 'finding', id: item.id, title: item.title, description: item.description, meta: `Finding · ${item.severity}`, refs: item.basisRefs, blocker: item.severity === 'blocker', expectedVersion: item.actions.length, decision })
  const openConfirmationDisposition = (item: TestDesignWorkflowRun['confirmationItems'][number], decision: TestDesignDispositionDraft['decision']) => setDisposition({ kind: 'confirmation', id: item.id, title: item.title, description: item.question, meta: `${item.decisionType} · 影响 ${item.impactStage}`, refs: item.affectedRefs, blocker: item.blocker, expectedVersion: item.actions.length, decision })
  const submitDisposition = async (comment: string) => {
    if (!disposition) return
    const returnToScopeGate = scopeGateWaiting && disposition.decision !== 'reopen' && unresolvedCount === 1
    setBusyId(disposition.id)
    try {
      const input = { expectedVersion: disposition.expectedVersion, decision: disposition.decision, comment }
      if (disposition.kind === 'finding') await actOnTestDesignFinding(projectVersionId, designId, run.id, disposition.id, input)
      else await actOnTestDesignConfirmation(projectVersionId, designId, run.id, disposition.id, input)
      await onRefresh()
      setDisposition(null)
      notify(returnToScopeGate ? '全部事项已处理，请确认本次测试范围后继续。' : '处置动作已追加保存，请按提示继续范围修订或覆盖审计。', 'success')
      if (returnToScopeGate) onOpenGate()
    } catch (error) { notify(error instanceof Error ? error.message : '处置保存失败', 'error') }
    finally { setBusyId('') }
  }
  return <><div className="td-run-artifact-view">
    <RunArtifactHeader title="Finding 与待确认项" description="处置结论追加保存，不改写固定输入和历史产物"><StatusPill tone={unresolvedCount ? 'warning' : 'success'}>{unresolvedCount} 项未解决</StatusPill></RunArtifactHeader>
    {scopeGateWaiting && unresolvedCount === 0 && <section className="td-disposition-complete"><CheckCircle2 /><div><b>所有事项已处理</b><p>还需要批准当前测试范围，批准后才会启动功能与非功能测试设计。</p></div><button type="button" className="btn primary" onClick={onOpenGate}>前往确认测试范围<ArrowRight /></button></section>}
    {run.findings.length > 0 && <div className="td-run-question-list">{run.findings.map(item => <article key={item.id}><AlertTriangle /><p><small>Finding · {item.severity}</small><b>{item.title}</b><em>{item.description}</em><code>{item.basisRefs.map(shortId).join(' · ')}</code></p><StatusPill tone={item.state === 'open' ? 'danger' : 'success'}>{dispositionStateLabel(item.state)}</StatusPill><span className="td-disposition-actions">{item.state === 'open' ? <><button className="btn primary" disabled={busyId === item.id} onClick={() => openFindingDisposition(item, 'resolve')}><Check />解决</button><button className="btn" disabled={busyId === item.id} onClick={() => openFindingDisposition(item, 'defer')}><Clock3 />延期</button></> : <button className="btn" disabled={busyId === item.id} onClick={() => openFindingDisposition(item, 'reopen')}><RefreshCw />重新打开</button>}</span></article>)}</div>}
    {items.length ? <div className="td-run-question-list">{items.map(item => <article key={item.id}><CircleDot /><p><small>{item.decisionType} · 影响 {item.impactStage}</small><b>{item.title}</b><em>{item.question}</em><code>{item.affectedRefs.map(shortId).join(' · ')}</code></p><StatusPill tone={item.blocker && item.state === 'open' ? 'danger' : item.state === 'open' ? 'warning' : 'success'}>{item.blocker ? `阻断 · ${dispositionStateLabel(item.state)}` : dispositionStateLabel(item.state)}</StatusPill><span className="td-disposition-actions">{item.state === 'open' ? <><button className="btn primary" disabled={busyId === item.id} onClick={() => openConfirmationDisposition(item, 'resolve')}><Check />确认解决</button><button className="btn" disabled={busyId === item.id} onClick={() => openConfirmationDisposition(item, 'defer')}><Clock3 />延期</button></> : <button className="btn" disabled={busyId === item.id} onClick={() => openConfirmationDisposition(item, 'reopen')}><RefreshCw />重新打开</button>}</span></article>)}</div> : run.findings.length === 0 && <RunIntentionalEmpty icon={<CheckCircle2 />} title="没有待确认项" description="本次分析没有产生需要人工补充结论的事项。" />}
  </div>{disposition && <TestDesignDispositionModal draft={disposition} submitting={busyId === disposition.id} onClose={() => setDisposition(null)} onSubmit={submitDisposition} />}</>
}

function dispositionStateLabel(state: string) { return ({ open: '未处理', confirmed: '已确认', resolved: '已解决', deferred: '已延期', rejected: '已拒绝' } as Record<string, string>)[state] ?? state }

function TestDesignDispositionModal({ draft, submitting, onClose, onSubmit }: { draft: TestDesignDispositionDraft; submitting: boolean; onClose: () => void; onSubmit: (comment: string) => Promise<void> }) {
  const [comment, setComment] = useState('')
  const actionLabel = draft.decision === 'resolve' ? '确认解决' : draft.decision === 'defer' ? '确认延期' : '重新打开'
  const fieldLabel = draft.decision === 'resolve' ? '解决方案 / 处置说明' : draft.decision === 'defer' ? '延期原因与后续计划' : '重新打开原因'
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !submitting) onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose, submitting])
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !submitting) onClose() }}><section className="modal td-disposition-modal" role="dialog" aria-modal="true" aria-labelledby="test-design-disposition-title">
    <header><div><small>{draft.meta}</small><h2 id="test-design-disposition-title">{actionLabel}：{draft.title}</h2></div><button type="button" className="icon-btn" disabled={submitting} onClick={onClose} aria-label="关闭处置弹窗"><X /></button></header>
    <div className="td-disposition-modal-body">
      <section className="td-disposition-subject"><span>{draft.kind === 'finding' ? <AlertTriangle /> : <CircleDot />}</span><div><small>{draft.kind === 'finding' ? '问题描述' : '待确认问题'}</small><p>{draft.description}</p></div><StatusPill tone={draft.blocker ? 'danger' : 'warning'}>{draft.blocker ? '阻断项' : '非阻断项'}</StatusPill></section>
      <dl><div><dt>事项 ID</dt><dd>{draft.id}</dd></div><div><dt>当前版本</dt><dd>{draft.expectedVersion}</dd></div><div className="wide"><dt>关联依据</dt><dd>{draft.refs.length ? draft.refs.join(' · ') : '未关联固定依据'}</dd></div></dl>
      <label><span>{fieldLabel}</span><textarea autoFocus value={comment} maxLength={4000} placeholder={draft.decision === 'resolve' ? '填写明确结论、采用方案、边界或验收口径' : draft.decision === 'defer' ? '填写延期原因、负责人或后续处理计划' : '说明为什么需要重新处理该事项'} onChange={event => setComment(event.target.value)} disabled={submitting} /><small>{comment.trim().length} / 4000</small></label>
    </div>
    <footer><span>{draft.decision === 'resolve' ? '提交后将追加保存解决记录，不改写历史产物。' : '该操作将作为新的处置动作追加保存。'}</span><button type="button" className="btn" disabled={submitting} onClick={onClose}>取消</button><button type="button" className="btn primary" disabled={submitting || !comment.trim()} onClick={() => void onSubmit(comment.trim())}>{submitting ? <RefreshCw className="spin" /> : <Check />}{submitting ? '正在提交' : actionLabel}</button></footer>
  </section></div>
}

function RunArtifactState({ tab, run }: { tab: TabKey; run: TestDesignWorkflowRun }) {
  const failed = run.status === 'failed'
  return <div className="td-run-artifact-state"><Layers3 /><StatusPill tone={failed ? 'danger' : 'neutral'}>{runStatusLabel(run.status)}</StatusPill><h2>{artifactLabels[tab]}尚未生成</h2><p>{failed ? '当前运行在上游节点失败，尚未生成该阶段的固定产物。请先查看概览或工作流中的失败原因。' : run.status === 'succeeded' ? '运行已完成，但服务端没有返回该阶段产物，请检查运行记录。' : '工作流尚未执行到该阶段。'}</p></div>
}

function DesignList({ projectVersion, view, setView, designs, loading, onCreate, onOpen, notify }: { projectVersion: ProjectVersion; view: CollectionView; setView: (view: CollectionView) => void; designs: TestDesign[]; loading: boolean; onCreate: () => void; onOpen: (design?: TestDesign) => void; notify: Notify }) {
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const filteredDesigns = useMemo(() => designs.filter(design => {
    const queryMatches = !query.trim() || `${design.name}${design.id}${design.latestRun?.id ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())
    const statusMatches = statusFilter === 'all'
      || statusFilter === 'no_run' && !design.latestRun
      || design.latestRun?.status === statusFilter
    return queryMatches && statusMatches
  }), [designs, query, statusFilter])
  const runningCount = designs.filter(item => ['queued', 'running', 'waiting_gate'].includes(item.latestRun?.status ?? '')).length
  const failedCount = designs.filter(item => item.latestRun?.status === 'failed').length
  const completedCount = designs.filter(item => item.latestRun?.status === 'succeeded').length
  return <section className="td-list-page">
    {view === 'designs' && <>
    <section className="td-cycle-overview">
      <div className="td-cycle-identity">
        <span><TestTube2 /></span>
        <AssetViewSelect projectVersion={projectVersion} view={view} setView={setView} description="这里只展示固定在当前版本的设计任务；历史用例需要显式选择并冻结，不会随新版本自动继承。" />
      </div>
      <dl>
        <div><dt>设计任务</dt><dd>{designs.length}</dd><small>当前版本</small></div>
        <div><dt>进行中</dt><dd>{runningCount}</dd><small>运行与门禁</small></div>
        <div><dt>待处理</dt><dd className="warning">{failedCount}</dd><small>失败运行</small></div>
        <div><dt>已完成</dt><dd>{completedCount}</dd><small>工作流成功</small></div>
      </dl>
    </section>
    <div className="td-list-toolbar">
      <div className="td-list-search"><Search /><input aria-label="搜索测试设计" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称、设计 ID 或运行 ID" /></div>
      <select aria-label="状态筛选" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
        <option value="all">全部状态</option><option value="no_run">尚未运行</option><option value="queued">已排队</option><option value="running">运行中</option><option value="waiting_gate">等待确认</option><option value="succeeded">已完成</option><option value="failed">运行失败</option><option value="cancelled">已取消</option>
      </select>
      <button className="btn primary td-create-design-button" onClick={onCreate}><Plus />创建测试设计</button>
    </div>
    <div className="td-list-table-wrap">
      <table className="td-design-table">
        <thead><tr><th>测试设计</th><th>固定输入</th><th>当前进度</th><th>当期产出</th><th>更新时间</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>{filteredDesigns.map((design, index) => {
          const run = design.latestRun
          return <tr key={design.id} className={index === 0 ? 'td-current-design-row' : undefined} onClick={() => onOpen(design)}>
            <td><span className={`td-row-symbol ${run ? 'active' : ''}`}><TestTube2 /></span><p><b>{design.name}</b><small>{design.id}{run ? ` · ${run.id}` : ''}</small></p></td>
            <td><StatusPill tone={design.basisMode === 'review_baseline' ? 'info' : 'success'}>{design.basisMode === 'review_baseline' ? '评审基线' : '知识库资料'}</StatusPill><small>{design.objective}</small></td>
            <td><b>{run ? runStageLabel(run.stage, run.status) : '尚未运行'}</b><div className="td-mini-progress"><span style={{ width: `${run?.progress ?? 0}%` }} /></div></td>
            <td><b>{run?.status === 'failed' ? '运行失败' : run ? `${run.progress}%` : '无运行产出'}</b><small className={run?.status === 'failed' ? 'td-row-warning' : undefined}>{run?.errorCode ?? (run ? '打开工作台查看固定产物' : '创建运行后生成')}</small></td>
            <td><b>{formatRunTime(run?.finishedAt ?? run?.startedAt ?? run?.createdAt ?? design.createdAt)}</b><small>{run?.finishedAt ? '已结束' : run?.startedAt ? '已开始' : '已创建'}</small></td>
            <td><StatusPill tone={runStatusTone(run?.status)}>{runStatusLabel(run?.status)}</StatusPill></td>
            <td><button className={`td-row-action ${run?.status === 'failed' ? 'primary' : ''}`} disabled={!run} onClick={event => { event.stopPropagation(); onOpen(design) }}>{run?.status === 'failed' ? '查看原因' : '进入设计'}<ChevronRight /></button></td>
          </tr>
        })}</tbody>
      </table>
      {!loading && designs.length === 0 && <div className="td-collection-empty"><TestTube2 /><h2>暂无测试设计</h2><p>当前项目版本还没有测试设计记录。</p></div>}
      {!loading && designs.length > 0 && filteredDesigns.length === 0 && <div className="td-collection-empty"><Search /><h2>没有匹配的测试设计</h2><p>请清空搜索词或调整状态筛选后重试。</p></div>}
      {loading && designs.length === 0 && <div className="td-collection-empty"><RefreshCw className="spin" /><h2>正在加载测试设计</h2><p>正在读取当前项目版本的真实任务。</p></div>}
    </div>
    </>}
    {view === 'library' && <ProjectCaseLibrary projectVersion={projectVersion} view={view} setView={setView} notify={notify} />}
    {view === 'sets' && <CaseSetCatalog projectVersion={projectVersion} view={view} setView={setView} notify={notify} />}
  </section>
}

function AssetViewSelect({ projectVersion, view, setView, description }: { projectVersion: ProjectVersion; view: CollectionView; setView: (view: CollectionView) => void; description: string }) {
  return <div className="td-asset-view-copy">
    <small>当前项目版本 · {projectVersion.name}</small>
    <label className="td-asset-view-select">
      <select aria-label="测试资产视图" value={view} onChange={event => setView(event.target.value as CollectionView)}>
        <option value="designs">当期测试设计</option>
        <option value="library">测试用例库</option>
        <option value="sets">测试用例集</option>
      </select>
      <ChevronDown />
    </label>
    <p>{description}</p>
  </div>
}

function ProjectCaseLibrary({ projectVersion, view, setView, notify }: { projectVersion: ProjectVersion; view: CollectionView; setView: (view: CollectionView) => void; notify: Notify }) {
  const [query, setQuery] = useState('')
  const [dimensionFilter, setDimensionFilter] = useState('全部维度')
  const [rows, setRows] = useState<ProjectTestCaseCatalogItem[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => { setLoading(true); void loadProjectTestCaseCatalog(projectVersion.projectId).then(value => setRows(value.items)).catch(error => notify(error instanceof Error ? error.message : '项目用例库加载失败', 'error')).finally(() => setLoading(false)) }, [notify, projectVersion.projectId])
  const filteredRows = rows.filter(row => (!query.trim() || `${row.caseId}${row.content.title}${row.content.domain}`.toLowerCase().includes(query.trim().toLowerCase())) && (dimensionFilter === '全部维度' || runDimensionLabels[row.content.dimension] === dimensionFilter))
  const methodCounts = rows.reduce((counts, row) => { row.content.executionMethods.forEach(item => { counts[item.method] += 1 }); return counts }, { ui: 0, api: 0 })
  return <div className="td-library-view">
    <section className="td-library-summary"><div><span><TableProperties /></span><AssetViewSelect projectVersion={projectVersion} view={view} setView={setView} description="只读聚合已发布的不可变用例 revision，不读取候选草稿。" /></div><dl><div><dt>已发布用例</dt><dd>{rows.length}</dd></div><div><dt>P0 用例</dt><dd>{rows.filter(row => row.content.priority === 'P0').length}</dd></div><div><dt>含 UI / API</dt><dd>{methodCounts.ui} / {methodCounts.api}</dd></div><div><dt>固定版本</dt><dd>{new Set(rows.map(row => row.testCaseSetVersionId)).size}</dd></div></dl></section>
    <div className="td-list-toolbar"><div className="td-list-search"><Search /><input aria-label="搜索测试用例库" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索用例 ID、名称或业务域" /></div><select aria-label="测试维度筛选" value={dimensionFilter} onChange={event => setDimensionFilter(event.target.value)}><option>全部维度</option>{testDimensions.map(dimension => <option key={dimension}>{dimension}</option>)}</select></div>
    <div className="td-library-table"><div className="td-library-table-head"><span>测试用例</span><span>业务域</span><span>测试维度</span><span>方式</span><span>优先级</span><span>所属用例集</span><span>当前状态</span></div>
      {filteredRows.map(row => { const methods = row.content.executionMethods.map(item => item.method.toUpperCase()).join(' + '); const dimension = runDimensionLabels[row.content.dimension] as TestDimension; return <button key={`${row.testCaseSetVersionId}:${row.caseId}:${row.revision}`}><span><i className={methods === 'UI' ? 'ui' : methods === 'API' ? 'api' : 'mixed'}>{methods.includes('UI') && <TableProperties />}{methods.includes('API') && <Braces />}</i><p><b>{row.content.title}</b><small>{shortId(row.caseId)} · revision {row.revision}</small></p><span className="td-mobile-dimension"><DimensionTag dimension={dimension} /></span></span><em>{row.content.domain}</em><DimensionTag dimension={dimension} /><strong>{methods}</strong><strong className={row.content.priority === 'P0' ? 'p0' : ''}>{row.content.priority}</strong><small>{row.testCaseSetName}</small><StatusPill tone="success">已发布</StatusPill></button> })}
      {loading && <div className="td-empty-filter"><RefreshCw className="spin" /><b>正在加载项目用例库</b></div>}{!loading && filteredRows.length === 0 && <div className="td-empty-filter"><Search /><b>没有匹配的测试用例</b><span>调整测试维度或搜索关键词后重试。</span></div>}
    </div>
  </div>
}

function CaseSetCatalog({ projectVersion, view, setView, notify }: { projectVersion: ProjectVersion; view: CollectionView; setView: (view: CollectionView) => void; notify: Notify }) {
  const [query, setQuery] = useState('')
  const [catalog, setCatalog] = useState<ProjectTestCaseCatalogItem[]>([])
  const [suites, setSuites] = useState<TestSuiteVersion[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => { setLoading(true); void Promise.all([loadProjectTestCaseCatalog(projectVersion.projectId), loadProjectTestSuites(projectVersion.projectId)]).then(([casesResponse, suitesResponse]) => { setCatalog(casesResponse.items); setSuites(suitesResponse.items) }).catch(error => notify(error instanceof Error ? error.message : '用例集目录加载失败', 'error')).finally(() => setLoading(false)) }, [notify, projectVersion.projectId])
  const featureSets = [...new Map(catalog.map(item => [item.testCaseSetVersionId, { id: item.testCaseSetVersionId, name: item.testCaseSetName, type: '新功能', cases: catalog.filter(candidate => candidate.testCaseSetVersionId === item.testCaseSetVersionId).length, version: '固定版本', updated: item.publishedAt, tone: 'feature', hash: item.contentSha256 }])).values()]
  const sets = [...suites.map(suite => ({ id: suite.id, name: suite.name, type: suite.suiteType === 'smoke' ? '冒烟基线' : suite.suiteType === 'regression' ? '回归基线' : '功能域', cases: suite.members.length, version: `v${suite.version}`, updated: suite.publishedAt, tone: suite.suiteType, hash: suite.contentSha256 })), ...featureSets].filter(set => !query.trim() || `${set.id}${set.name}`.toLowerCase().includes(query.trim().toLowerCase()))
  return <div className="td-set-catalog"><section className="td-set-summary"><div><span><Layers3 /></span><AssetViewSelect projectVersion={projectVersion} view={view} setView={setView} description="用例集保存成员引用与固定 revision，单条用例可以进入多个集合。" /></div><div className="td-set-legend"><span><i className="smoke" />冒烟基线</span><span><i className="regression" />回归基线</span><span><i className="feature" />新功能用例集</span></div></section>
    <div className="td-list-toolbar"><div className="td-list-search"><Search /><input aria-label="搜索测试用例集" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索用例集名称或版本 ID" /></div></div>
    <div className="td-set-grid">{sets.map(set => <article key={set.id}><header><span className={set.tone}><Layers3 /></span><div><small>{set.type} · {shortId(set.id)}</small><h3>{set.name}</h3></div><StatusPill tone="success">已发布</StatusPill></header><p><LockKeyhole /> {shortHash(set.hash)}</p><dl><div><dt>用例数量</dt><dd>{set.cases}</dd></div><div><dt>版本</dt><dd>{set.version}</dd></div><div><dt>更新时间</dt><dd>{formatRunTime(set.updated)}</dd></div></dl><footer><span><LockKeyhole />不可变版本</span><button onClick={() => notify(`${set.name} ${set.version} 含 ${set.cases} 条固定成员。`)}>查看成员<ChevronRight /></button></footer></article>)}{loading && <div className="td-collection-empty"><RefreshCw className="spin" /><h2>正在加载用例集</h2></div>}{!loading && sets.length === 0 && <div className="td-collection-empty"><Layers3 /><h2>暂无已发布用例集</h2><p>当前项目尚未形成不可变用例集或套件版本。</p></div>}</div>
  </div>
}

function CreateDesign({ projectVersion, inputs, designName, setDesignName, basisMode, setBasisMode, createStep, setCreateStep, knowledgeGoal, setKnowledgeGoal, selectedAssets, setSelectedAssets, augmentation, setAugmentation, augmentationAssets, setAugmentationAssets, historyEnabled, setHistoryEnabled, onCancel, onStart }: {
  projectVersion: ProjectVersion
  inputs: TestDesignInputCandidates
  designName: string
  setDesignName: (value: string) => void
  basisMode: BasisMode
  setBasisMode: (mode: BasisMode) => void
  createStep: number
  setCreateStep: (step: number) => void
  knowledgeGoal: string
  setKnowledgeGoal: (value: string) => void
  selectedAssets: string[]
  setSelectedAssets: (assets: string[]) => void
  augmentation: string
  setAugmentation: (value: string) => void
  augmentationAssets: string[]
  setAugmentationAssets: (assets: string[]) => void
  historyEnabled: boolean
  setHistoryEnabled: (value: boolean) => void
  onCancel: () => void
  onStart: (input: Record<string, unknown>) => Promise<void>
}) {
  const selectableBaselines = inputs.reviewBaselines.filter(item => item.selectable)
  const selectableAssets = inputs.knowledgeAssets.filter(item => item.selectable)
  const selectableIndexes = inputs.fixedIndexes.filter(item => item.selectable)
  const [selectedBaselineId, setSelectedBaselineId] = useState(selectableBaselines[0]?.sourceTechnicalSolutionRunId ?? '')
  const [selectedIndexId, setSelectedIndexId] = useState(selectableIndexes[0]?.id ?? '')
  const [historicalSource, setHistoricalSource] = useState(inputs.historicalCaseSets[0]?.id ? `set:${inputs.historicalCaseSets[0].id}` : inputs.historicalCaseAssets[0]?.assetVersionId ? `asset:${inputs.historicalCaseAssets[0].assetVersionId}` : '')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const toggleAsset = (id: string) => setSelectedAssets(selectedAssets.includes(id) ? selectedAssets.filter(item => item !== id) : [...selectedAssets, id])
  const toggleAugmentationAsset = (id: string) => setAugmentationAssets(augmentationAssets.includes(id) ? augmentationAssets.filter(item => item !== id) : [...augmentationAssets, id])
  const commonIssues = [!designName.trim() ? '填写测试设计名称' : '', !knowledgeGoal.trim() ? '填写测试目标' : ''].filter(Boolean)
  const basisIssues = [...commonIssues, basisMode === 'review_baseline' && !selectedBaselineId ? '选择一条可用的评审基线' : '', basisMode === 'knowledge_assets' && selectedAssets.length === 0 ? '至少选择一份 ready 固定资产版本' : ''].filter(Boolean)
  const augmentationIssues = [augmentation === 'selected_assets' && augmentationAssets.length === 0 ? '为指定资料召回选择至少一份固定资产' : '', augmentation === 'fixed_index' && !selectedIndexId ? '选择一个活动固定索引' : '', historyEnabled && !historicalSource ? '选择历史用例来源' : ''].filter(Boolean)
  const readinessIssues = inputs.agentReadiness.ready ? [] : ['测试设计 Agent 尚未全部就绪']
  const blockers = [...basisIssues, ...augmentationIssues, ...readinessIssues]
  const canAdvance = createStep === 1 ? basisIssues.length === 0 : createStep === 2 ? augmentationIssues.length === 0 : blockers.length === 0
  const submit = async () => {
    const baseline = selectableBaselines.find(item => item.sourceTechnicalSolutionRunId === selectedBaselineId)
    const knowledgeAugmentation = augmentation === 'selected_assets' ? { mode: 'selected_assets', assetVersionIds: augmentationAssets } : augmentation === 'fixed_index' ? { mode: 'fixed_index', indexVersionId: selectedIndexId } : { mode: 'disabled' }
    const historicalCaseSelections: Array<Record<string, unknown>> = []
    if (historyEnabled && historicalSource.startsWith('asset:')) historicalCaseSelections.push({ sourceType: 'asset_version', assetVersionId: historicalSource.slice(6) })
    if (historyEnabled && historicalSource.startsWith('set:')) {
      const versionId = historicalSource.slice(4)
      const version = await loadTestCaseSetVersion(versionId)
      historicalCaseSelections.push({ sourceType: 'test_case_set', testCaseSetVersionId: versionId, caseIds: version.members.map(item => item.caseId) })
    }
    const input = basisMode === 'review_baseline' && baseline
      ? { name: designName.trim(), objective: knowledgeGoal.trim(), basisMode, sourceReviewRunId: baseline.sourceReviewRunId, sourceTechnicalSolutionRunId: baseline.sourceTechnicalSolutionRunId, knowledgeAugmentation, historicalCaseSelections }
      : { name: designName.trim(), objective: knowledgeGoal.trim(), basisMode: 'knowledge_assets', knowledgeAssetVersionIds: selectedAssets, knowledgeAugmentation, historicalCaseSelections }
    setSubmitting(true)
    setSubmitError('')
    try { await onStart(input) }
    catch (error) { setSubmitError(error instanceof Error ? error.message : '测试设计创建失败') }
    finally { setSubmitting(false) }
  }
  return <section className="td-create-page">
    <header><button className="icon-btn" onClick={onCancel} aria-label="关闭创建页"><X /></button><div><span>创建测试设计</span><h2>固定输入并启动多 Agent 工作流</h2></div><StatusPill tone="neutral">{projectVersion.name}</StatusPill></header>
    <div className="td-create-steps">
      {['选择主依据', '补充上下文', '运行前检查'].map((label, index) => <button key={label} className={createStep === index + 1 ? 'active' : createStep > index + 1 ? 'done' : ''} onClick={() => index + 1 < createStep && setCreateStep(index + 1)} aria-current={createStep === index + 1 ? 'step' : undefined}><span>{createStep > index + 1 ? <Check /> : index + 1}</span><b>{label}</b>{index < 2 && <i />}</button>)}
    </div>
    <div className="td-create-body">
      {createStep === 1 && <>
        <div className="td-form-heading"><h3>选择主测试依据</h3><p>主依据创建后不可切换，所有内容会固定为不可变快照。</p></div>
        <div className="td-form-section td-create-identity-fields"><label><span>测试设计名称</span><input value={designName} onChange={event => setDesignName(event.target.value)} placeholder="填写本次测试设计名称" /></label><label><span>测试目标</span><textarea value={knowledgeGoal} onChange={event => setKnowledgeGoal(event.target.value)} placeholder="说明本次要验证的能力、范围和排除项" /></label></div>
        <div className="td-segmented"><button className={basisMode === 'review_baseline' ? 'active' : ''} onClick={() => setBasisMode('review_baseline')}><GitBranch /><span><b>评审基线</b><small>固定成功的需求与技术方案评审</small></span></button><button className={basisMode === 'knowledge_assets' ? 'active' : ''} onClick={() => setBasisMode('knowledge_assets')}><Database /><span><b>知识库资料</b><small>直接选择一至多份 ready 资产版本</small></span></button></div>
        {basisMode === 'review_baseline' ? <div className="td-form-section">
           <label><span>需求评审基线</span><select value={selectedBaselineId} onChange={event => setSelectedBaselineId(event.target.value)}><option value="">请选择当前版本的成功需求评审</option>{selectableBaselines.map(item => <option key={item.sourceTechnicalSolutionRunId} value={item.sourceTechnicalSolutionRunId}>{item.requirementDocumentTitle ?? item.label} · {shortId(item.sourceReviewRunId)}</option>)}</select><small>{selectableBaselines.length ? '仅展示当前项目版本中已成功的需求评审。' : '当前版本没有可用的成功需求评审。'}</small></label>
           <label><span>技术方案评审基线</span><select value={selectedBaselineId} onChange={event => setSelectedBaselineId(event.target.value)}><option value="">请选择与需求评审关联的技术方案评审</option>{selectableBaselines.map(item => <option key={item.sourceTechnicalSolutionRunId} value={item.sourceTechnicalSolutionRunId}>{item.technicalReviewName ?? '技术方案评审'} · {shortId(item.sourceTechnicalSolutionRunId)}</option>)}</select><small>{selectableBaselines.find(item => item.sourceTechnicalSolutionRunId === selectedBaselineId)?.technicalCompletedAt ? `完成于 ${formatRunTime(selectableBaselines.find(item => item.sourceTechnicalSolutionRunId === selectedBaselineId)?.technicalCompletedAt)}` : '技术方案评审必须与需求评审属于同一条成功链路。'}</small></label>
          {selectedBaselineId && <div className="td-inline-notice success"><CheckCircle2 /><span><b>基线关系已由服务端校验</b><small>{selectableBaselines.find(item => item.sourceTechnicalSolutionRunId === selectedBaselineId)?.label}</small></span></div>}
        </div> : <div className="td-form-section">
          <div className="td-asset-picker"><div className="td-picker-head"><b>固定资产版本</b><span>{selectedAssets.length} 项已选择 · {selectableAssets.length} 项可用</span></div>{selectableAssets.map(asset => <label key={asset.assetVersionId} className={selectedAssets.includes(asset.assetVersionId) ? 'selected' : ''}><input type="checkbox" checked={selectedAssets.includes(asset.assetVersionId)} onChange={() => toggleAsset(asset.assetVersionId)} /><FileText /><span><b>{asset.displayName}</b><small>{asset.assetType} · {asset.logicalPath}</small></span><em>v{asset.version} · {asset.status}</em><code>{shortHash(asset.contentHash)}</code></label>)}{selectableAssets.length === 0 && <p className="td-history-empty"><AlertTriangle />当前版本没有 ready 资产版本。</p>}</div>
          {basisIssues.length > 0 && <div className="td-inline-notice danger"><AlertTriangle /><span><b>主依据尚不完整</b><small>{basisIssues.join('；')}</small></span></div>}
        </div>}
      </>}
      {createStep === 2 && <>
        <div className="td-form-heading"><h3>补充知识与历史用例</h3><p>补充项同样会冻结具体版本、范围与内容 Hash。</p></div>
        <div className="td-form-section">
          <fieldset><legend>知识增强</legend><div className="td-radio-list">
            {[['disabled', '不启用', '仅使用主依据，不执行补充召回'], ['selected_assets', '指定资料', '从显式选择的固定资料中受控召回'], ['fixed_index', '固定索引', '从当前项目的活动固定索引中召回']].map(option => <label key={option[0]} className={augmentation === option[0] ? 'selected' : ''}><input type="radio" name="augmentation" checked={augmentation === option[0]} onChange={() => setAugmentation(option[0])} /><span><b>{option[1]}</b><small>{option[2]}</small></span></label>)}
          </div>{augmentation === 'selected_assets' && <div className="td-augmentation-assets">{selectableAssets.map(asset => <label key={asset.assetVersionId}><input type="checkbox" checked={augmentationAssets.includes(asset.assetVersionId)} onChange={() => toggleAugmentationAsset(asset.assetVersionId)} /><span>{asset.displayName}</span><code>{asset.assetVersionId}</code></label>)}</div>}{augmentation === 'fixed_index' && <label><span>固定索引版本</span><select value={selectedIndexId} onChange={event => setSelectedIndexId(event.target.value)}><option value="">请选择活动索引</option>{selectableIndexes.map(index => <option key={index.id} value={index.id}>{index.id}</option>)}</select><small>{selectableIndexes.length ? `${selectableIndexes.length} 个活动索引可用` : '当前项目没有活动固定索引'}</small></label>}</fieldset>
          <fieldset><legend>历史用例</legend><label className="td-switch-row"><input type="checkbox" checked={historyEnabled} onChange={event => setHistoryEnabled(event.target.checked)} /><span><b>使用历史用例作为设计输入</b><small>{historyEnabled ? '请选择一个真实的已发布用例集或 ready 测试用例资产。' : '默认不选择；系统不会自动继承上一项目版本的测试用例。'}</small></span><em className={historyEnabled ? 'on' : ''}><i /></em></label>{historyEnabled ? <div className="td-history-source"><History /><span><b>历史用例来源</b><small>{inputs.historicalCaseSets.length} 个用例集 · {inputs.historicalCaseAssets.length} 个资产版本</small></span><select aria-label="历史用例来源" value={historicalSource} onChange={event => setHistoricalSource(event.target.value)}><option value="">请选择来源</option>{inputs.historicalCaseSets.map(item => <option key={item.id} value={`set:${item.id}`}>{item.name} v{item.version} · {item.memberCount} 条</option>)}{inputs.historicalCaseAssets.map(item => <option key={item.assetVersionId} value={`asset:${item.assetVersionId}`}>{item.displayName} · {item.assetVersionId}</option>)}</select></div> : <p className="td-history-empty"><LockKeyhole />开启后可从服务端返回的历史来源中选择；只提供复用候选，不会改写历史用例。</p>}</fieldset>
        </div>
      </>}
      {createStep === 3 && <>
        <div className="td-form-heading"><h3>运行前检查</h3><p>输入快照与四个 Agent 全部就绪后才能开始。</p></div>
        <div className={`td-preflight-summary ${blockers.length > 0 ? 'blocked' : ''}`}><div>{blockers.length > 0 ? <AlertTriangle /> : <CheckCircle2 />}<span><b>{blockers.length > 0 ? `${blockers.length} 项阻断待处理` : '当前输入检查通过'}</b><small>{blockers.length > 0 ? blockers.join('；') : '服务端会在创建时再次校验输入、来源和 Agent 发布状态。'}</small></span></div><StatusPill tone={blockers.length > 0 ? 'danger' : 'success'}>{blockers.length > 0 ? '禁止开始' : '允许开始'}</StatusPill></div>
        <div className="td-preflight-grid">
          {[["固定输入", basisMode === 'review_baseline' ? (selectedBaselineId ? '已选择当前版本成功评审基线' : '未选择评审基线') : selectedAssets.length > 0 ? `${selectedAssets.length} 份 ready 资产已选择` : '未选择 ready 资产', basisIssues.length > 0 ? 'danger' : 'success'], ['知识增强', augmentation === 'disabled' ? '已明确禁用' : augmentation === 'fixed_index' ? (selectedIndexId ? `固定索引 ${selectedIndexId}` : '未选择固定索引') : `${augmentationAssets.length} 份固定资料已选择`, augmentationIssues.length > 0 ? 'danger' : 'success'], ['历史用例', historyEnabled ? (historicalSource ? '已选择真实历史来源' : '未选择来源') : '未选择历史用例', historyEnabled && !historicalSource ? 'danger' : 'success'], ['Agent 就绪', inputs.agentReadiness.ready ? '全部 Agent 已发布并通过门禁' : `${inputs.agentReadiness.agents.filter(item => !item.ready).length} 个 Agent 未就绪`, inputs.agentReadiness.ready ? 'success' : 'danger']].map(item => <article key={item[0]}><span className={item[2]}>{item[2] === 'danger' ? <AlertTriangle /> : <Check />}</span><p><b>{item[0]}</b><small>{item[1]}</small></p><ChevronRight /></article>)}
        </div>
        <div className="td-agent-check"><header><Bot /><span><b>Agent 就绪状态</b><small>当前发布快照的服务端检查结果</small></span><StatusPill tone={inputs.agentReadiness.ready ? 'success' : 'danger'}>{inputs.agentReadiness.agents.filter(item => item.ready).length} / {inputs.agentReadiness.agents.length} 就绪</StatusPill></header>{inputs.agentReadiness.agents.map(agent => <div key={agent.agentKey}><span className={agent.ready ? 'success' : 'danger'}>{agent.ready ? <Check /> : <XCircle />}</span><b>{agent.agentKey}</b><small>{agent.reason ?? '已通过就绪检查'}</small><em>{agent.ready ? '已发布' : '未就绪'}</em></div>)}</div>
        {submitError && <div className="td-inline-notice danger" role="alert"><AlertTriangle /><span><b>创建失败</b><small>{submitError}</small></span></div>}
      </>}
    </div>
    <footer><button className="btn" onClick={createStep === 1 ? onCancel : () => setCreateStep(createStep - 1)}>{createStep === 1 ? '取消' : '上一步'}</button><span>{canAdvance ? '输入将在创建运行时固定，不使用 latest。' : '请先处理当前步骤的阻断项。'}</span>{createStep < 3 ? <button className="btn primary" disabled={!canAdvance} onClick={() => setCreateStep(createStep + 1)}>继续<ArrowRight /></button> : <button className="btn primary" disabled={!canAdvance || submitting} onClick={() => void submit()}>{submitting ? <><RefreshCw className="spin" />创建中</> : <><Play />创建并提交真实运行</>}</button>}</footer>
  </section>
}

function BasisPanel({ selected, onSelect, basisMode }: { selected: string; onSelect: (id: string) => void; basisMode: BasisMode }) {
  const items = basisMode === 'review_baseline' ? basisItems : knowledgeBasisItems
  return <aside className="td-basis-panel">
    <header><div><b>固定测试依据</b><small>{basisMode === 'review_baseline' ? '评审基线 · 64 项' : '知识库资料 · 3 项预览'}</small></div><button className="icon-btn" aria-label="筛选依据"><Filter /></button></header>
    <div className="td-basis-summary">{basisMode === 'review_baseline' ? <GitBranch /> : <Database />}<span><b>{basisMode === 'review_baseline' ? '登录能力评审基线' : '身份认证知识输入包'}</b><small>{basisMode === 'review_baseline' ? '需求 RR-021 · 技术方案 TR-014' : '固定资产版本与定位 Hash'}</small></span><LockKeyhole /></div>
    <div className="td-panel-search"><Search /><input aria-label="搜索依据" placeholder="搜索依据项" /></div>
    <div className="td-basis-list">
      <p>当前视图依据</p>
      {items.map(item => <button key={item.id} className={selected === item.id ? 'active' : ''} onClick={() => onSelect(item.id)}><i className={item.kind === '风险' || item.kind === '资料冲突' ? 'risk' : item.kind === '方案要点' ? 'solution' : ''} /><span><small>{item.kind} · {item.id}</small><b>{item.title}</b><em>{item.source}</em></span>{item.status === '已覆盖' ? <CheckCircle2 className="covered" /> : item.status === '待确认' ? <AlertTriangle className="question" /> : <CircleDot className="partial" />}</button>)}
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
  const [detailsOpen, setDetailsOpen] = useState(false)
  return <div className="td-workflow-view">
    <header className="td-canvas-toolbar"><div><b>固定工作流</b><small>test-design-workflow/v1 · 当前为只读交互预览</small></div><span><i className="done" />成功</span><span><i className="running" />进行中</span><span><i />等待</span><button className="btn" onClick={() => setDetailsOpen(value => !value)}>{detailsOpen ? '收起详情' : '运行详情'}</button><button className="btn" onClick={() => notify('交互预览：正式取消将调用 workflowRunId 对应的取消 API。', 'warning')}>取消运行</button></header>
    <div className="td-workflow-canvas td-workflow-sequence">
      <div className="td-workflow-track">
      <div className="td-flow-column start"><small>固定输入</small><article><span><LockKeyhole /></span><p><b>评审基线快照</b><small>64 项依据 · Hash 已校验</small><em>13:08:01 固定</em></p><CheckCircle2 /></article></div>
      <ArrowRight className="td-flow-arrow inline" />
      <div className="td-flow-column analysis"><small>阶段 1</small><WorkflowCard node={workflowNodes[0]} /></div>
      <ArrowRight className="td-flow-arrow inline" />
      <div className="td-flow-column gate"><small>人工门禁 1</small><article><span><Users /></span><p><b>测试范围确认</b><small>范围、风险与历史处置已确认</small><em>李磊 · 13:13:40</em></p><CheckCircle2 /></article></div>
      <ArrowRight className="td-flow-arrow inline" />
      <div className="td-flow-branch"><div><small>阶段 2 · 并行</small><WorkflowCard node={workflowNodes[1]} /><WorkflowCard node={workflowNodes[2]} /></div></div>
      <ArrowRight className="td-flow-arrow inline" />
      <div className="td-flow-column server"><small>服务端阶段</small><article><span><Network /></span><p><b>测试点树归并</b><small>保留专项来源、重复与冲突</small><em>tree draft r12</em></p><CheckCircle2 /></article></div>
      <ArrowRight className="td-flow-arrow inline" />
      <div className="td-flow-column gate"><small>人工门禁 2</small><article><span><Users /></span><p><b>测试点树批准</b><small>r12 · 李磊 · 13:46</small><em>解锁用例综合</em></p><CheckCircle2 /></article></div>
      <ArrowRight className="td-flow-arrow inline" />
      <div className="td-flow-column synthesis"><small>阶段 3-4</small><WorkflowCard node={workflowNodes[3]} /></div>
      <ArrowRight className="td-flow-arrow inline" />
      <div className="td-flow-column audit server"><small>阶段 5 · 服务端</small><article className="running"><span><ShieldCheck /></span><p><b>覆盖反向审计</b><small>等待处理 3 个阻断项</small><em>输入 Hash 已固定</em></p><RefreshCw /></article></div>
      </div>
    </div>
    {detailsOpen && <section className="td-run-details" aria-label="工作流节点详情"><header><b>节点执行详情</b><span>错误仅展示脱敏公开信息</span></header>{workflowNodes.map(node => <div key={node.role}><b>{node.role}</b><span>{node.meta}</span><time>{node.time}</time><em>{node.degraded}</em><StatusPill tone="success">{node.state}</StatusPill></div>)}<footer><span>分层恢复会创建新执行或新运行，不覆盖当前运行。</span><button className="btn" onClick={() => notify('交互预览：只重新执行失败的设计节点。')}>重试失败节点</button><button className="btn" onClick={() => notify('交互预览：基于已批准树重新具象化用例。')}>重新具象化</button><button className="btn" onClick={() => notify('交互预览：全部重跑会创建新的 workflowRunId。', 'warning')}>全部重跑</button></footer></section>}
    <section className="td-run-timeline"><header><b>最近事件</b><span>不展示模型隐藏思维</span></header>{[['14:28:16', '覆盖审计', '服务端完成覆盖矩阵计算，发现 3 个发布阻断项'], ['14:24:38', '用例综合 Agent', '第 2 次提交通过协议与依据引用校验'], ['14:19:32', '用例综合 Agent', '首次提交缺少 2 个 oracle，返回结构化校验反馈'], ['13:46:05', '人工门禁', '李磊批准测试点树 r12，解锁用例具象化']].map((event, index) => <div key={event[0]}><i className={index === 0 ? 'active' : ''} /><time>{event[0]}</time><b>{event[1]}</b><span>{event[2]}</span></div>)}</section>
  </div>
}

function WorkflowCard({ node }: { node: typeof workflowNodes[number] }) {
  return <article className={node.className}><span><Bot /></span><p><b>{node.role}</b><small>{node.subtitle}</small><em>{node.meta}<br />{node.time} · {node.degraded}</em></p><CheckCircle2 /></article>
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

function TreeView({ nodes, selected, onSelect, approved, revision, dirty, conflict, onAdd, onMove, onSplit, onMerge, onDelete, onToggleExpanded, onSave, onPreviewConflict, onResolveConflict, onApprove, onInvalidate }: { nodes: TreeNode[]; selected: string; onSelect: (id: string) => void; approved: boolean; revision: number; dirty: boolean; conflict: boolean; onAdd: (asChild: boolean) => void; onMove: (direction: -1 | 1) => void; onSplit: () => void; onMerge: () => void; onDelete: () => void; onToggleExpanded: (id: string) => void; onSave: () => void; onPreviewConflict: () => void; onResolveConflict: () => void; onApprove: () => void; onInvalidate: () => void }) {
  const selectAdjacent = (index: number, direction: -1 | 1) => {
    const target = nodes[index + direction]
    if (target) onSelect(target.id)
  }
  return <div className="td-tree-view"><header className="td-canvas-toolbar"><div><b>测试点树</b><small>revision r{revision} · {nodes.length} 个当前预览节点 · 64 项依据</small></div><StatusPill tone={conflict ? 'danger' : approved ? 'success' : dirty ? 'warning' : 'info'}>{conflict ? 'revision 冲突' : approved ? '已批准' : dirty ? '有未保存修改' : '待批准'}</StatusPill>{approved ? <button className="btn" onClick={onInvalidate}><Pencil />编辑树</button> : <><button className="btn" disabled={!dirty || conflict} onClick={onSave}><Check />保存当前会话</button><button className="btn primary" disabled={dirty || conflict} onClick={onApprove}><ShieldCheck />批准 r{revision}</button></>}<button className="icon-btn" aria-label="预览 revision 冲突" title="预览 revision 冲突" onClick={onPreviewConflict}><FileDiff /></button></header>
    {conflict && <div className="td-conflict-banner" role="alert"><AlertTriangle /><p><b>检测到模拟的 412 revision 冲突</b><small>服务器 revision r{revision + 1} 与当前本地修改不同。比较后可基于最新版本重新应用。</small></p><button className="btn" onClick={onResolveConflict}>比较并重新应用</button></div>}
    <div className="td-tree-tools"><div className="td-panel-search"><Search /><input placeholder="搜索测试点" /></div><button className="btn" onClick={() => onAdd(false)}><Plus />新增同级</button><button className="btn" onClick={() => onAdd(true)}><Plus />新增子级</button><button className="icon-btn" aria-label="上移" title="上移" onClick={() => onMove(-1)}><ArrowUp /></button><button className="icon-btn" aria-label="下移" title="下移" onClick={() => onMove(1)}><ArrowDown /></button><button className="icon-btn" aria-label="拆分" title="拆分" onClick={onSplit}><Split /></button><button className="icon-btn" aria-label="与下一同级合并" title="与下一同级合并" onClick={onMerge}><GitBranch /></button><button className="icon-btn" aria-label="删除" title="删除" onClick={onDelete}><Trash2 /></button></div><div className="td-tree-header"><span>测试点</span><span>方法</span><span>优先级</span><span>用例数</span></div><div className="td-tree-list" role="tree" aria-label="测试点树">{nodes.map((node, index) => <button role="treeitem" aria-level={node.level + 1} aria-selected={selected === node.id} aria-expanded={node.expanded} tabIndex={selected === node.id ? 0 : -1} key={node.id} className={selected === node.id ? 'active' : ''} style={{ '--tree-level': node.level } as React.CSSProperties} onClick={() => onSelect(node.id)} onDoubleClick={() => node.expanded !== undefined && onToggleExpanded(node.id)} onKeyDown={event => { if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); onMove(-1) } else if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); onMove(1) } else if (event.key === 'ArrowUp') { event.preventDefault(); selectAdjacent(index, -1) } else if (event.key === 'ArrowDown') { event.preventDefault(); selectAdjacent(index, 1) } }}><span className="td-tree-name">{node.expanded !== undefined ? <ChevronRight className={node.expanded ? 'expanded' : ''} /> : <i />}<TestTube2 /><span><b>{node.title}</b><small>{node.id} · {node.level === 0 ? '业务域' : '测试点'}</small></span></span><em>{node.method}</em><strong className={node.priority === 'P0' ? 'p0' : ''}>{node.priority}</strong><small>{node.count}</small></button>)}</div></div>
}

function CasesView({ selected, onSelect, filter, setFilter, dimensionFilter, setDimensionFilter, query, setQuery, rows, notify }: { selected: string; onSelect: (id: string) => void; filter: string; setFilter: (value: string) => void; dimensionFilter: string; setDimensionFilter: (value: string) => void; query: string; setQuery: (value: string) => void; rows: typeof cases; notify: Notify }) {
  return <div className="td-cases-view">
    <header className="td-canvas-toolbar"><div><b>测试用例</b><small>28 条 · 18 条已通过 · 5 类测试维度</small></div><button className="btn" onClick={() => notify('交互预览：批量审核将先展示影响范围，再为每条用例追加独立记录。')}><Users />批量审核</button><button className="btn primary" onClick={() => notify('交互预览：正式新建将由服务端生成 caseId 和 revision 0。')}><Plus />新建用例</button></header>
    <div className="td-case-filters">
      <div className="td-panel-search"><Search /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索用例 ID 或标题" /></div>
      <select aria-label="测试维度筛选" value={dimensionFilter} onChange={event => setDimensionFilter(event.target.value)}><option>全部维度</option>{testDimensions.map(dimension => <option key={dimension}>{dimension}</option>)}</select>
      <select aria-label="执行方式筛选" value={filter} onChange={event => setFilter(event.target.value)}><option>全部方式</option><option>UI</option><option>API</option></select>
      <select aria-label="优先级筛选"><option>全部优先级</option><option>P0</option><option>P1</option><option>P2</option></select>
      <select aria-label="集合角色筛选"><option>全部集合角色</option><option>冒烟候选</option><option>普通用例</option></select>
      <button className="icon-btn" aria-label="更多筛选"><Filter /></button>
    </div>
    <div className="td-case-table">
      <div className="td-case-table-head"><span>用例</span><span>测试点</span><span>测试维度</span><span>方式</span><span>优先级</span><span>审核</span><span>就绪</span></div>
      {rows.map(item => <button key={item.id} className={selected === item.id ? 'active' : ''} onClick={() => onSelect(item.id)}>
        <span><i className={item.methods.length === 2 ? 'mixed' : item.methods[0].toLowerCase()}>{item.methods.includes('UI') && <TableProperties />}{item.methods.includes('API') && <Braces />}</i><p><b>{item.title}</b><small>{item.id} · {item.origin}</small></p><span className="td-mobile-dimension"><DimensionTag dimension={item.dimension} /></span>{item.smokeCandidate && <span className="td-smoke-candidate"><Sparkles />冒烟候选</span>}</span>
        <em>{item.point}</em><DimensionTag dimension={item.dimension} /><strong>{item.methods.join(' + ')}</strong><strong className={item.priority === 'P0' ? 'p0' : ''}>{item.priority}</strong><StatusPill tone={item.status === '已通过' ? 'success' : item.status === '需修订' ? 'danger' : item.status === '审核中' ? 'info' : 'neutral'}>{item.status}</StatusPill><StatusPill tone={item.readiness === '就绪' ? 'success' : item.readiness === '阻塞' ? 'danger' : 'warning'}>{item.readiness}</StatusPill>
      </button>)}
      {rows.length === 0 && <div className="td-empty-filter"><Search /><b>没有匹配的测试用例</b><span>调整测试维度、执行方式或搜索关键词后重试。</span></div>}
    </div>
  </div>
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
  const [direction, setDirection] = useState<'basis' | 'case'>('basis')
  const gaps = [['REQ-021', '账户保护解除后的首次登录', '未覆盖', '缺少测试点'], ['SOL-012', '审计队列写入失败后的补偿策略', '待确认', '上游方案未明确'], ['TC-AUTH-004', '并发刷新令牌时仅一个请求成功', '阻断', '缺少确定性 oracle']]
  return <div className="td-coverage-view"><header className="td-canvas-toolbar"><div><b>覆盖反向审计</b><small>审计基于当前树 r12、用例 revision 集合与数据需求 Hash</small></div><StatusPill tone="warning">3 个阻断项</StatusPill><button className="btn primary" onClick={() => notify('交互预览：正式重新审计将提交当前树、用例和数据需求 Hash。', 'warning')}><RefreshCw />重新审计</button></header><div className="td-coverage-summary"><div className="td-coverage-donut"><span><strong>91.3%</strong><small>依据覆盖</small></span></div><dl><div><dt>依据项</dt><dd>64</dd></div><div><dt>已覆盖</dt><dd className="success">52</dd></div><div><dt>部分覆盖</dt><dd className="warning">9</dd></div><div><dt>未覆盖</dt><dd className="danger">3</dd></div></dl><div className="td-publish-readiness"><AlertTriangle /><p><b>暂不可发布</b><small>预览 publishReadiness 包含 3 个 blocker</small></p><button onClick={() => notify('已在当前预览中定位到第一个发布阻断项。')}>逐项处理<ChevronRight /></button></div></div><div className="td-coverage-mode"><button className={direction === 'basis' ? 'active' : ''} onClick={() => setDirection('basis')}>依据 → 测试点 → 用例</button><button className={direction === 'case' ? 'active' : ''} onClick={() => setDirection('case')}>用例 → 测试点 → 依据</button><span /><select><option>仅看缺口与异常</option><option>查看全部映射</option></select></div><div className="td-gap-list">{gaps.map((gap, index) => <button key={gap[0]}><span className={index === 2 ? 'danger' : 'warning'}>{index === 2 ? <XCircle /> : <AlertTriangle />}</span><p><small>{gap[0]} · {gap[2]}</small><b>{gap[1]}</b><em>{gap[3]}</em></p><StatusPill tone={index === 2 ? 'danger' : 'warning'}>发布阻断</StatusPill><ChevronRight /></button>)}</div></div>
}

function HistoryView({ notify }: { notify: Notify }) {
  return <div className="td-history-view"><header className="td-canvas-toolbar"><div><b>历史用例复用</b><small>冻结来源与当前 revision 保持可追溯差异</small></div><StatusPill tone="info">6 条候选</StatusPill></header><div className="td-history-layout"><section className="td-history-list">{[['TC-OLD-018', '错误密码登录提示', '适用性高', 'unchanged'], ['TC-OLD-021', '连续失败账户锁定', '需修改', 'modified'], ['TC-OLD-024', 'Token 刷新成功', '需修改', 'modified']].map((item, index) => <button key={item[0]} className={index === 1 ? 'active' : ''}><History /><p><b>{item[1]}</b><small>{item[0]} · SmartHub 2026.07 · TCS v1</small></p><StatusPill tone={index === 0 ? 'success' : 'warning'}>{item[2]}</StatusPill></button>)}</section><section className="td-diff-panel"><header><div><small>冻结来源</small><b>TC-OLD-021 · revision 3</b></div><FileDiff /><div><small>当前草稿</small><b>TC-AUTH-003 · revision 6</b></div></header><div className="td-diff-row"><span>前置条件</span><p>账号连续登录失败 <del>3 次</del></p><p>账号在 10 分钟内连续登录失败 <ins>5 次</ins></p></div><div className="td-diff-row"><span>预期结果</span><p>账号被锁定</p><p>账号进入 <ins>30 分钟保护状态</ins>，接口返回统一业务码</p></div><div className="td-diff-row"><span>适用性</span><p>旧密码策略</p><p><ins>已按当前认证方案更新</ins></p></div><footer><button className="btn" onClick={() => notify('交互预览：正式复用会创建新的 caseId、revision 0 和 unchanged 关系。')}><ArchiveRestore />直接复用</button><button className="btn primary" onClick={() => notify('交互预览：正式操作会创建 modified 草稿并保存字段 Diff。')}><FileDiff />复制并修改</button></footer></section></div></div>
}

function QuestionsView({ notify }: { notify: Notify }) {
  return <div className="td-questions-view"><header className="td-canvas-toolbar"><div><b>待确认项</b><small>确认结论将追加保存并进入报告与发布门禁</small></div><StatusPill tone="warning">2 项未解决</StatusPill></header>{[['Q-006', '账户保护窗口是否允许管理员提前解除？', '该规则会影响保护状态的等价类和恢复场景。', '产品规则'], ['Q-009', 'Safari 的支持范围按最新两个主版本还是固定版本？', '上游仅写明支持主流浏览器，无法形成可验收的兼容性边界。', '验收标准']].map(item => <article key={item[0]}><span><CircleDot /></span><p><small>{item[0]} · {item[3]}</small><b>{item[1]}</b><em>{item[2]}</em></p><button className="btn" onClick={() => notify(`交互预览：${item[0]} 的正式结论将追加保存。`)}>填写结论</button></article>)}</div>
}

function CaseEditor({ testCase, draft, onChangeDraft, onChangeMethodDraft, onToggleMethod, saveState, revision, onSetSaveState, onSave, notify }: { testCase: CaseItem; draft: CaseDraft; onChangeDraft: (patch: Partial<CaseDraft>) => void; onChangeMethodDraft: (method: ExecutionMethod, patch: Partial<MethodDraft>) => void; onToggleMethod: (method: ExecutionMethod) => void; saveState: SaveState; revision: number; onSetSaveState: (state: SaveState) => void; onSave: () => void; notify: Notify }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const stateLabel: Record<SaveState, string> = { clean: '预览基线', dirty: '当前会话未保存', saved: '当前会话已保存', failed: '保存失败预览', conflict: 'revision 冲突预览' }
  const updateStep = (method: ExecutionMethod, index: number, field: 'action' | 'expected', value: string) => {
    const steps = draft.methodDrafts[method].steps.map((step, stepIndex) => stepIndex === index ? { ...step, [field]: value } : step)
    onChangeMethodDraft(method, { steps })
  }
  const addStep = (method: ExecutionMethod) => onChangeMethodDraft(method, { steps: [...draft.methodDrafts[method].steps, { action: '', expected: '' }] })
  const deleteStep = (method: ExecutionMethod, index: number) => onChangeMethodDraft(method, { steps: draft.methodDrafts[method].steps.filter((_, stepIndex) => stepIndex !== index) })
  return <aside className="td-detail-panel td-case-editor">
    <header><div><small>结构化用例</small><b>{testCase.id}</b></div><DimensionTag dimension={draft.dimension} /><div className="td-editor-menu"><button className="icon-btn" aria-label="更多用例操作" aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)}><MoreHorizontal /></button>{menuOpen && <div role="menu"><button role="menuitem" onClick={() => { onSetSaveState('failed'); setMenuOpen(false) }}>预览保存失败</button><button role="menuitem" onClick={() => { onSetSaveState('conflict'); setMenuOpen(false) }}>预览 revision 冲突</button></div>}</div></header>
    <div className="td-editor-meta"><StatusPill tone="neutral">revision r{revision}</StatusPill><StatusPill tone={testCase.status === '已通过' ? 'success' : 'warning'}>{testCase.status}</StatusPill><span className={saveState}>{stateLabel[saveState]}</span></div>
    {(saveState === 'failed' || saveState === 'conflict') && <div className="td-editor-alert" role="alert"><AlertTriangle /><p><b>{saveState === 'failed' ? '当前会话保存失败' : `服务器 revision r${revision + 1} 与当前草稿冲突`}</b><small>{saveState === 'failed' ? '本地输入仍保留，可修正必填字段后重试。' : '当前输入不会覆盖服务器版本，可先比较再重新应用。'}</small></p><button onClick={() => saveState === 'failed' ? onSave() : onSetSaveState('dirty')}>{saveState === 'failed' ? '重试' : '比较并重新应用'}</button></div>}
    <div className="td-detail-scroll">
      <div className="td-readonly-grid"><p><span>caseId</span><b>{testCase.id}</b></p><p><span>来源 Hash</span><b>sha256:17b8...c921</b></p><p><span>来源</span><b>{testCase.origin}</b></p><p><span>reuseMode</span><b>{testCase.origin === '历史复用' ? 'unchanged' : testCase.origin === '复制并修改' ? 'modified' : '不适用'}</b></p><p><span>测试点</span><b>{testCase.point}</b></p><p><span>当前就绪</span><b>{testCase.readiness}</b></p></div>
      <label><span>用例标题</span><input value={draft.title} onChange={event => onChangeDraft({ title: event.target.value })} /></label>
      <label><span>测试目标</span><textarea value={draft.objective} onChange={event => onChangeDraft({ objective: event.target.value })} /></label>
      <label><span>测试维度</span><select value={draft.dimension} onChange={event => onChangeDraft({ dimension: event.target.value as TestDimension })}>{testDimensions.map(dimension => <option key={dimension}>{dimension}</option>)}</select></label>
      <div className="td-method-segment" aria-label="执行方式，可多选"><button type="button" aria-pressed={draft.methods.includes('UI')} className={draft.methods.includes('UI') ? 'active' : ''} onClick={() => onToggleMethod('UI')}><TableProperties />UI</button><button type="button" aria-pressed={draft.methods.includes('API')} className={draft.methods.includes('API') ? 'active' : ''} onClick={() => onToggleMethod('API')}><Braces />API</button></div>
      <label><span>共同前置条件</span><textarea value={draft.preconditions} onChange={event => onChangeDraft({ preconditions: event.target.value })} /></label>
      <label><span>测试数据需求引用</span><input value={draft.dataRefs} onChange={event => onChangeDraft({ dataRefs: event.target.value })} /></label>
      <label><span>依赖</span><input value={draft.dependencies} onChange={event => onChangeDraft({ dependencies: event.target.value })} /></label>
      {draft.methods.map(method => {
        const methodDraft = draft.methodDrafts[method]
        return <section className="td-step-editor td-method-editor td-method-contract" key={method}>
          <header><b>{method === 'UI' ? <TableProperties /> : <Braces />}{method} 独立执行分支</b><button type="button" onClick={() => addStep(method)}><Plus />添加步骤</button></header>
          <label><span>{method} Spec</span><textarea value={methodDraft.spec} onChange={event => onChangeMethodDraft(method, { spec: event.target.value })} /></label>
          {methodDraft.steps.map((step, index) => <article key={`${method}-${index}`}><em>{index + 1}</em><div><input aria-label={`${method} 步骤 ${index + 1} 操作`} value={step.action} onChange={event => updateStep(method, index, 'action', event.target.value)} /><textarea aria-label={`${method} 步骤 ${index + 1} 期望`} value={step.expected} onChange={event => updateStep(method, index, 'expected', event.target.value)} /></div><button type="button" className="icon-btn" aria-label={`删除 ${method} 步骤 ${index + 1}`} onClick={() => deleteStep(method, index)}><Trash2 /></button></article>)}
          <label><span>{method} 验证检查点</span><textarea value={methodDraft.checks} onChange={event => onChangeMethodDraft(method, { checks: event.target.value })} /></label>
          <div className="td-method-contract-grid"><label><span>执行就绪</span><select value={methodDraft.readiness} onChange={event => onChangeMethodDraft(method, { readiness: event.target.value as MethodDraft['readiness'] })}><option value="ready">ready</option><option value="blocked">blocked</option><option value="needs_confirmation">needs_confirmation</option></select></label><label><span>自动化提示</span><select value={methodDraft.automationHint} onChange={event => onChangeMethodDraft(method, { automationHint: event.target.value as MethodDraft['automationHint'] })}><option value="recommended">recommended</option><option value="optional">optional</option><option value="manual">manual</option></select></label></div>
        </section>
      })}
      <label><span>共享验证检查点</span><textarea value={draft.sharedChecks} onChange={event => onChangeDraft({ sharedChecks: event.target.value })} /></label>
      <label><span>执行后状态</span><textarea value={draft.postconditions} onChange={event => onChangeDraft({ postconditions: event.target.value })} /></label>
      <label><span>清理要求</span><input value={draft.cleanup} onChange={event => onChangeDraft({ cleanup: event.target.value })} /></label>
    </div>
    <footer><button className="btn" disabled={saveState !== 'saved'} onClick={() => notify('交互预览：正式提交审核将在后端锁定当前 revision。')}>预览提交审核</button><button className="btn primary" onClick={onSave} disabled={saveState === 'clean' || saveState === 'saved'}><Check />保存当前会话</button></footer>
  </aside>
}

function DetailPanel({ tab, basis, treeNode, onUpdateTreeNode, onSaveTree, treeDirty, testCase, draft, onChangeDraft, onChangeMethodDraft, onToggleMethod, saveState, revision, onSetSaveState, onSave, approved, notify }: { tab: TabKey; basis: typeof basisItems[number] | typeof knowledgeBasisItems[number]; treeNode: TreeNode; onUpdateTreeNode: (patch: Partial<TreeNode>) => void; onSaveTree: () => void; treeDirty: boolean; testCase: CaseItem; draft: CaseDraft; onChangeDraft: (patch: Partial<CaseDraft>) => void; onChangeMethodDraft: (method: ExecutionMethod, patch: Partial<MethodDraft>) => void; onToggleMethod: (method: ExecutionMethod) => void; saveState: SaveState; revision: number; onSetSaveState: (state: SaveState) => void; onSave: () => void; approved: boolean; notify: Notify }) {
  if (tab === 'case-set') return <aside className="td-detail-panel"><header><div><small>候选用例集</small><b>SET-AUTH · v2</b></div><StatusPill tone="warning">待发布</StatusPill></header><div className="td-detail-scroll"><section className="td-set-version-card"><span><FileJson2 /></span><div><small>test-case-set/v1</small><b>登录与身份认证新功能用例集</b><code>contentSha256: pending</code></div></section><div className="td-basis-meta"><p><span>来源设计</span><b>TD-20260807-01</b></p><p><span>候选成员</span><b>28 条</b></p><p><span>冒烟候选</span><b>3 条</b></p><p><span>覆盖审计</span><b>Audit r4</b></p></div><section className="td-detail-section"><h3>发布后固定</h3><button><TestTube2 /><span><small>用例成员</small><b>caseId + revision</b></span><CheckCircle2 /></button><button><Sparkles /><span><small>冒烟建议</small><b>3 条候选关系</b></span><CheckCircle2 /></button><button><ShieldCheck /><span><small>覆盖审计</small><b>成员集合 Hash</b></span><CheckCircle2 /></button></section><section className="td-detail-callout danger"><AlertTriangle /><p><b>3 个发布阻断项</b><small>当前内容不能形成不可变版本，需先补齐覆盖并重新审核。</small></p></section></div><footer><button className="btn" onClick={() => notify('交互预览：正式导出将从指定 TestCaseSetVersion 下载。')}><Download />导出预览</button><button className="btn primary" onClick={() => notify('仍有 3 个发布阻断项。', 'warning')}><LockKeyhole />发布</button></footer></aside>
  if (tab === 'cases') return <CaseEditor testCase={testCase} draft={draft} onChangeDraft={onChangeDraft} onChangeMethodDraft={onChangeMethodDraft} onToggleMethod={onToggleMethod} saveState={saveState} revision={revision} onSetSaveState={onSetSaveState} onSave={onSave} notify={notify} />
  if (tab === 'tree') return <aside className="td-detail-panel"><header><div><small>测试点节点</small><b>{treeNode.id}</b></div><DimensionTag dimension={treeNode.dimension} /><StatusPill tone={approved ? 'success' : treeDirty ? 'warning' : 'info'}>{approved ? '已批准' : treeDirty ? '当前会话未保存' : '待批准'}</StatusPill></header><div className="td-detail-scroll"><label><span>测试点名称</span><input value={treeNode.title} onChange={event => onUpdateTreeNode({ title: event.target.value })} /></label><label><span>测试维度</span><select value={treeNode.dimension} onChange={event => onUpdateTreeNode({ dimension: event.target.value as TestDimension })}>{testDimensions.map(dimension => <option key={dimension}>{dimension}</option>)}</select></label><div className="td-method-segment"><button type="button" aria-pressed={treeNode.method.includes('UI')} className={treeNode.method.includes('UI') ? 'active' : ''} onClick={() => onUpdateTreeNode({ method: treeNode.method.includes('UI') ? 'API' : treeNode.method.includes('API') ? 'UI + API' : 'UI' })}>UI</button><button type="button" aria-pressed={treeNode.method.includes('API')} className={treeNode.method.includes('API') ? 'active' : ''} onClick={() => onUpdateTreeNode({ method: treeNode.method.includes('API') ? 'UI' : treeNode.method.includes('UI') ? 'UI + API' : 'API' })}>API</button></div><label><span>优先级</span><select value={treeNode.priority} onChange={event => onUpdateTreeNode({ priority: event.target.value })}><option>P0</option><option>P1</option><option>P2</option></select></label><label><span>设计说明</span><textarea defaultValue="覆盖正常路径、输入校验、错误反馈以及重复提交场景。" /></label><section className="td-source-links"><header><b>来源关系</b><StatusPill tone="neutral">2 项</StatusPill></header><button><Link2 /><span><b>REQ-018</b><small>用户可通过账号密码登录系统</small></span><ChevronRight /></button><button><Link2 /><span><b>SOL-008</b><small>认证令牌采用双 Token 轮换机制</small></span><ChevronRight /></button></section></div><footer><button className="btn" onClick={() => { onUpdateTreeNode({ title: `${treeNode.title}（不适用）` }); notify('节点已在当前会话标记为不适用。', 'warning') }}>标记不适用</button><button className="btn primary" onClick={onSaveTree} disabled={!treeDirty}><Check />保存当前会话</button></footer></aside>
  if (tab === 'coverage') return <aside className="td-detail-panel"><header><div><small>覆盖缺口</small><b>REQ-021</b></div><StatusPill tone="danger">发布阻断</StatusPill></header><div className="td-detail-scroll"><section className="td-detail-callout danger"><AlertTriangle /><p><b>账户保护解除后的首次登录未覆盖</b><small>当前依据项仅覆盖保护触发与保护期间行为，未验证自动解除后的状态恢复。</small></p></section><section className="td-detail-section"><h3>关联链路</h3><button><FileText /><span><small>依据</small><b>REQ-021 账户保护策略</b></span></button><button><Network /><span><small>测试点</small><b>TP-004 账户保护</b></span></button><button className="missing"><TestTube2 /><span><small>用例</small><b>缺少恢复路径用例</b></span></button></section><label><span>处置结论</span><textarea placeholder="填写处理说明或不可测原因" /></label></div><footer><button className="btn" onClick={() => notify('交互预览：正式处置将追加保存待确认记录。')}>标记待确认</button><button className="btn primary" onClick={() => notify('交互预览：正式操作将创建关联当前缺口的用例草稿。')}><Plus />创建用例</button></footer></aside>
  return <aside className="td-detail-panel"><header><div><small>{basis.kind} · 固定来源</small><b>{basis.id}</b></div><StatusPill tone="success"><LockKeyhole />Hash 已固定</StatusPill></header><div className="td-detail-scroll"><h2>{basis.title}</h2><div className="td-basis-meta"><p><span>来源</span><b>{basis.source}</b></p><p><span>覆盖状态</span><b>{basis.status}</b></p><p><span>内容 Hash</span><code>sha256:9f2a84...e31c</code></p><p><span>固定时间</span><b>2026-08-07 13:08</b></p></div><section className="td-source-quote"><header><FileText /><b>固定原文</b><span>L128-L143</span></header><p>当用户连续输入错误密码达到策略阈值时，系统应进入账户保护状态。保护期间所有登录请求返回统一提示，不得泄漏账号存在性。</p></section><section className="td-detail-section"><h3>派生关系</h3><button><Network /><span><small>测试点</small><b>3 个直接关联节点</b></span><ChevronRight /></button><button><TestTube2 /><span><small>测试用例</small><b>5 条当前用例</b></span><ChevronRight /></button></section></div><footer><button className="btn full" onClick={() => notify('交互预览：正式定位将打开固定资产版本，不会跳转 latest。')}><Link2 />查看来源定位</button></footer></aside>
}
