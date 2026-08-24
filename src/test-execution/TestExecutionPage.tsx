import { Boxes, Play, RefreshCw, Settings2, ShieldCheck } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { ProjectVersion } from '../project-version-api'
import { ExecutionRunPanel } from './ExecutionRunPanel'
import { ExecutionTaskPanel } from './ExecutionTaskPanel'
import { useTestExecution } from './hooks/useTestExecution'
import './test-execution.css'

type Notify = (message: string, tone?: 'success' | 'error' | 'warning') => void

export function TestExecutionPage({
  projectVersion,
  onManageVersions,
  notify,
}: {
  projectVersion: ProjectVersion | null
  onManageVersions: () => void
  notify: Notify
}) {
  const model = useTestExecution(projectVersion?.id, notify)
  const restoredRun = useRef(false)
  const restoredTask = useRef(false)

  useEffect(() => {
    restoredRun.current = false
    restoredTask.current = false
  }, [projectVersion?.id])

  useEffect(() => {
    if (restoredRun.current || !projectVersion || model.loading) return
    restoredRun.current = true
    const runId = new URL(window.location.href).searchParams.get('executionRunId')
    if (runId) void model.openRun(runId).catch(cause => notify(messageOf(cause), 'error'))
  }, [model.loading, model.openRun, notify, projectVersion])

  useEffect(() => {
    if (restoredTask.current || !model.run || !model.tasks.length) return
    restoredTask.current = true
    const taskId = new URL(window.location.href).searchParams.get('executionTaskId')
    if (taskId && model.tasks.some(item => item.id === taskId)) {
      void model.openTask(taskId).catch(cause => notify(messageOf(cause), 'error'))
    }
  }, [model.openTask, model.run, model.tasks, notify])

  const openRun = async (runId: string) => {
    try {
      const opened = await model.openRun(runId)
      if (opened) updateExecutionRoute(opened.id)
      return opened
    } catch (cause) {
      notify(messageOf(cause), 'error')
    }
  }

  const openTask = async (taskId: string) => {
    try {
      const opened = await model.openTask(taskId)
      if (opened && model.run) updateExecutionRoute(model.run.value.id, taskId)
      return opened
    } catch (cause) {
      notify(messageOf(cause), 'error')
    }
  }

  if (!projectVersion) return <main className="te-shell"><section className="te-card te-page-empty"><Boxes /><h2>请先选择 ProjectVersion</h2><p>正式用例库、Run、Task 与全部执行历史都按项目版本授权和隔离。</p><button className="te-primary" onClick={onManageVersions}>管理项目版本</button></section></main>

  return <main className="te-shell">
    {model.error && <div className="te-global-error"><b>执行数据未完整加载</b><span>{model.error}</span><button onClick={() => void model.loadCollection()}><RefreshCw />重试</button></div>}
    <div className="te-layout">
      <ExecutionRunPanel
        readiness={model.readiness}
        environments={model.environments}
        runs={model.runs}
        run={model.run}
        busy={model.busy}
        loading={model.loading}
        onRefresh={model.loadCollection}
        onCreate={async baseUrl => {
          const created = await model.create(baseUrl)
          if (created) updateExecutionRoute(created.id)
          return created
        }}
        onOpen={openRun}
        onCancel={model.cancel}
      />
      <ExecutionTaskPanel
        tasks={model.tasks}
        task={model.task}
        diff={model.diff}
        busy={model.busy}
        onOpen={openTask}
        onRetry={model.retry}
        onCompare={model.compareRevisions}
      />
    </div>
  </main>
}

function updateExecutionRoute(runId: string, taskId?: string) {
  const url = new URL(window.location.href)
  url.searchParams.set('executionRunId', runId)
  if (taskId) url.searchParams.set('executionTaskId', taskId)
  else url.searchParams.delete('executionTaskId')
  url.searchParams.delete('executionMaintenanceProposalId')
  window.history.replaceState({}, '', url)
}

function messageOf(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}
