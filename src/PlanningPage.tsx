import { RefreshCw } from 'lucide-react'
import { Suspense, lazy } from 'react'
import type { KnowledgeDocument } from './prototype-data'
import type { ProjectVersion } from './project-version-api'
import './planning.css'

const RequirementAnalysisPage = lazy(() => import('./RequirementAnalysisPage').then(module => ({ default: module.RequirementAnalysisPage })))

type Notify = (message: string, tone?: 'success' | 'error' | 'warning') => void
type Props = {
  projectVersion: ProjectVersion | null
  documents: KnowledgeDocument[]
  knowledgeBaseId: string
  apiState: 'connecting' | 'ready' | 'offline'
  refreshKnowledge: () => Promise<void>
  refreshProjectVersions: () => Promise<ProjectVersion[]>
  onManageVersions: () => void
  onOpenKnowledge: () => void
  onOpenActivity: () => void
  notify: Notify
  addAudit: (entry: string) => void
}

/**
 * 测试策划只有一个用户工作台。
 *
 * Planning Workflow 与 Parent Session 仍由服务端管理，运行记录收纳在工作台的
 * 详细信息中；不再把需求分析、测试设计和运行观测拆成需要用户切换的三条路径。
 */
export function PlanningPage(props: Props) {
  return <div className="planning-page">
    <Suspense fallback={<PlanningLoading label="正在加载 PlanningAgent 工作台…" />}>
      <RequirementAnalysisPage {...props} />
    </Suspense>
  </div>
}

function PlanningLoading({ label }: { label: string }) { return <div className="planning-loading"><RefreshCw />{label}</div> }
