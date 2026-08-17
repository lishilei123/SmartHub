import { Activity, AlertTriangle, BrainCircuit, CheckCircle2, ClipboardList, RefreshCw, TestTube2 } from 'lucide-react'
import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import type { KnowledgeDocument } from './prototype-data'
import type { ProjectVersion } from './project-version-api'
import { compactPlanningContext, loadPlanningWorkflow, type PlanningWorkflow } from './planning-api'
import { PlanningContextMetrics } from './PlanningObservability'
import './planning.css'

const RequirementAnalysisPage = lazy(() => import('./RequirementAnalysisPage').then(module => ({ default: module.RequirementAnalysisPage })))
const TestDesignPage = lazy(() => import('./test-design/TestDesignPage').then(module => ({ default: module.TestDesignPage })))

type Notify = (message: string, tone?: 'success' | 'error' | 'warning') => void
type PlanningTab = 'requirements' | 'test-design' | 'workflow'
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

const stageLabels: Record<string, string> = {
  requirement_analysis: '需求分析',
  requirement_repair: '需求修复',
  requirement_verification: '需求验证',
  requirement_release: '需求发布',
  test_point_design: '测试点设计',
  test_point_review: '测试点自动校验',
  test_case_design: '测试用例设计',
  test_design_repair: 'Coverage 修复',
  test_design_release: '测试设计发布',
}

export function PlanningPage(props: Props) {
  const route = new URL(window.location.href)
  const routedTab = planningTab(route.searchParams.get('planningTab'), route.searchParams.get('page'))
  const [tab, setTab] = useState<PlanningTab>(routedTab)
  const [workflow, setWorkflow] = useState<PlanningWorkflow | null>(null)
  const [workflowError, setWorkflowError] = useState('')
  const [loadingWorkflow, setLoadingWorkflow] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const loadWorkflow = useCallback(async () => {
    if (!props.projectVersion) { setWorkflow(null); return }
    setLoadingWorkflow(true)
    setWorkflowError('')
    try { setWorkflow(await loadPlanningWorkflow(props.projectVersion.id)) }
    catch (error) { setWorkflowError(error instanceof Error ? error.message : 'Planning Workflow 读取失败') }
    finally { setLoadingWorkflow(false) }
  }, [props.projectVersion])
  useEffect(() => { void loadWorkflow() }, [loadWorkflow])
  const selectTab = (value: PlanningTab) => {
    setTab(value)
    const url = new URL(window.location.href)
    url.searchParams.set('planningTab', value)
    window.history.replaceState({}, '', url)
  }
  const compact = async () => {
    if (!props.projectVersion || compacting) return
    setCompacting(true)
    try {
      const context = await compactPlanningContext(props.projectVersion.id)
      setWorkflow(current => current ? { ...current, context } : current)
      props.notify('Planning Parent Session 已按服务端固定规则完成压缩。')
    } catch (error) { props.notify(error instanceof Error ? error.message : 'Context 压缩失败', 'error') }
    finally { setCompacting(false) }
  }
  return <div className="planning-page">
    <nav className="planning-tabs" aria-label="测试策划工作台">
      <button className={tab === 'requirements' ? 'active' : ''} onClick={() => selectTab('requirements')}><ClipboardList />需求分析</button>
      <button className={tab === 'test-design' ? 'active' : ''} onClick={() => selectTab('test-design')}><TestTube2 />测试设计</button>
      <button className={tab === 'workflow' ? 'active' : ''} onClick={() => selectTab('workflow')}><Activity />Planning 运行</button>
    </nav>
    {tab === 'requirements' && <Suspense fallback={<PlanningLoading label="正在加载需求分析工作台…" />}><RequirementAnalysisPage {...props} onOpenTestDesign={() => selectTab('test-design')} /></Suspense>}
    {tab === 'test-design' && <Suspense fallback={<PlanningLoading label="正在加载测试设计工作台…" />}><TestDesignPage projectVersion={props.projectVersion} onManageVersions={props.onManageVersions} notify={props.notify} /></Suspense>}
    {tab === 'workflow' && <section className="planning-workflow-view">
      <header><span><BrainCircuit /><div><b>PlanningWorkflow</b><small>Workflow 推进业务阶段；测试点由 Validator 自动校验，测试用例与发布仍保留人工门禁。</small></div></span><button disabled={loadingWorkflow} onClick={() => void loadWorkflow()}><RefreshCw className={loadingWorkflow ? 'planning-spin' : ''} />刷新</button></header>
      {workflowError && <div className="planning-error"><AlertTriangle />{workflowError}</div>}
      {!props.projectVersion ? <div className="planning-empty">请先选择 ProjectVersion。</div> : !workflow ? <PlanningLoading label="正在读取 Planning Workflow…" /> : <>
        <PlanningContextMetrics context={workflow.context} compacting={compacting} onCompact={() => void compact()} />
        <div className="planning-stage-grid">{workflow.stageProfiles.map((stage, index) => <article key={stage.stage}><header><i>{index + 1}</i><span><b>{stageLabels[stage.stage] ?? stage.stage}</b><small>{stage.stage === 'test_point_review' ? 'Service Validator' : stage.agentKey}</small></span>{stage.humanGate && <em>Human Gate</em>}</header><dl><div><dt>Allowed Tools</dt><dd>{stage.allowedToolIds.length ? stage.allowedToolIds.join(' · ') : '—'}</dd></div><div><dt>Submit Tool</dt><dd>{stage.submitToolId ?? '—'}</dd></div><div><dt>Result Schema</dt><dd>{stage.resultSchemaVersion ?? '—'}</dd></div><div><dt>Reviewer</dt><dd>{stage.reviewers.length ? stage.reviewers.join(' · ') : '—'}</dd></div></dl></article>)}</div>
        <footer className="planning-boundary"><CheckCircle2 /><span><b>正式事实边界</b><small>Compaction Summary 与 Reviewer Candidate 不是正式业务事实；Release、TestCase、Revision、Hash 与 Snapshot 均由 Service 重新读取。</small></span></footer>
      </>}
    </section>}
  </div>
}

function PlanningLoading({ label }: { label: string }) { return <div className="planning-loading"><RefreshCw />{label}</div> }
function planningTab(value: string | null, page: string | null): PlanningTab { return value === 'test-design' || value === 'workflow' ? value : page === 'test-design' ? 'test-design' : 'requirements' }
