import { AlertTriangle, CheckCircle2, ChevronRight, Clock3, Library, Settings, Sparkles, TestTube2 } from 'lucide-react'
import { type ProjectVersion } from '../project-version-api'
import { type PageKey, type PlanningTab } from './types'
import { Badge } from './shared'

export function Dashboard({
  navigate,
  projectVersion,
  onManageVersions,
}: {
  navigate: (page: PageKey, planningTab?: PlanningTab) => void
  projectVersion: ProjectVersion | null
  onManageVersions: () => void
}) {
  return (
    <div className="dashboard-grid">
      <section className="card span2 dashboard-notice">
        <Badge tone="violet">
          <Sparkles size={12} /> {projectVersion ? `当前版本 ${projectVersion.name}` : '尚未创建项目版本'}
        </Badge>
        <h2>{projectVersion ? '当前项目空间已按版本隔离' : '先创建项目版本，再开始测试策划'}</h2>
        <p>
          {projectVersion
            ? 'Requirement Release、测试设计与 Planning Session 上下文都固定在当前版本。'
            : '平台固定服务 SmartHub 单项目，项目空间通过版本切换。'}
        </p>
        <div>
          <button className="btn primary" onClick={projectVersion ? () => navigate('planning') : onManageVersions}>
            {projectVersion ? '进入测试策划' : '新建项目版本'}
          </button>
        </div>
      </section>
      <section className="card quick-card">
        <Sparkles />
        <h3>需求分析</h3>
        <p>由同一个 PlanningAgent 在当前 Project Workspace 与 Planning Session 中完成。</p>
        <button className="text-btn" onClick={() => navigate('planning')}>
          打开测试策划 <ChevronRight />
        </button>
      </section>
      <section className="card quick-card">
        <TestTube2 />
        <h3>测试用例</h3>
        <p>Requirement Release 发布后，Agent 自动生成用例，Coverage 与正式发布仍保留治理门禁。</p>
        <button className="text-btn" onClick={() => navigate('planning', 'test-design')}>
          查看测试用例 <ChevronRight />
        </button>
      </section>
      <section className="card quick-card">
        <Library />
        <h3>知识库</h3>
        <p>知识库由平台单项目共享，不随项目版本复制。</p>
        <button className="text-btn" onClick={() => navigate('documents')}>
          打开知识库 <ChevronRight />
        </button>
      </section>
      <section className="card quick-card">
        <Settings />
        <h3>系统设置</h3>
        <p>模型与平台配置为全局资源，不参与版本隔离。</p>
        <button className="text-btn" onClick={() => navigate('settings')}>
          打开系统设置 <ChevronRight />
        </button>
      </section>
    </div>
  )
}

function PlaceholderNotice({ title, boundary, missing }: { title: string; boundary: string; missing: string }) {
  return (
    <section className="card static-notice placeholder-notice">
      <Badge tone="orange">
        <AlertTriangle size={12} />
        功能占位 · 尚未实现
      </Badge>
      <h2>{title}</h2>
      <p>该导航项用于明确产品规划边界，当前不是可用业务页面。</p>
      <div>
        <span>
          <CheckCircle2 />
          <b>已具备的相邻能力</b>
          <small>{boundary}</small>
        </span>
        <span>
          <Clock3 />
          <b>尚未实现</b>
          <small>{missing}</small>
        </span>
      </div>
    </section>
  )
}
