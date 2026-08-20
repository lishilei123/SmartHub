import { Boxes, Play, RefreshCw, Settings2, ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
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
  const restoredProposal = useRef(false)
  const [maintenanceFilter, setMaintenanceFilter] = useState(false)
  const visibleTasks = useMemo(() => maintenanceFilter
    ? model.tasks.filter(task => model.maintenanceProposals.some(proposal => proposal.taskId === task.id && proposal.status === 'pending'))
    : model.tasks, [maintenanceFilter, model.maintenanceProposals, model.tasks])

  useEffect(() => {
    restoredRun.current = false
    restoredTask.current = false
    restoredProposal.current = false
    setMaintenanceFilter(false)
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

  useEffect(() => {
    if (restoredProposal.current || !model.run || !model.task) return
    restoredProposal.current = true
    const proposalId = new URL(window.location.href).searchParams.get('executionMaintenanceProposalId')
    if (!proposalId) return
    void model.openMaintenanceProposal(proposalId)
      .then(async opened => {
        if (!opened || !model.run) return
        if (model.task?.value.task.id !== opened.proposal.taskId) {
          await model.openTask(opened.proposal.taskId)
        }
        updateExecutionRoute(model.run.value.id, opened.proposal.taskId, proposalId)
      })
      .catch(cause => notify(messageOf(cause), 'error'))
  }, [model.openMaintenanceProposal, model.openTask, model.run, model.task, notify])

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

  const openFormalCase = (caseId: string) => {
    const url = new URL(window.location.href)
    url.searchParams.set('page', 'test-design')
    url.searchParams.set('testDesignEntry', 'library')
    url.searchParams.set('libraryCaseId', caseId)
    url.searchParams.delete('executionRunId')
    url.searchParams.delete('executionTaskId')
    url.searchParams.delete('executionMaintenanceProposalId')
    window.history.pushState({}, '', url)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  if (!projectVersion) return <main className="te-shell"><section className="te-card te-page-empty"><Boxes /><h2>请先选择 ProjectVersion</h2><p>TestExecutionHandoff、Run、Task 与全部执行历史都按项目版本授权和隔离。</p><button className="te-primary" onClick={onManageVersions}>管理项目版本</button></section></main>

  return <main className="te-shell">
    <header className="te-page-header">
      <div className="te-page-title"><span><Play /></span><div><h1>测试执行</h1><p>{projectVersion.name} · Deterministic Service + three isolated Agents + OCI Playwright Runner</p></div></div>
      <div className="te-boundary"><ShieldCheck /><span><small>执行边界</small><b>Agent candidate → Server validation → Runner</b></span></div>
      <button className="te-secondary" onClick={onManageVersions}><Settings2 />项目版本</button>
    </header>
    {model.error && <div className="te-global-error"><b>执行数据未完整加载</b><span>{model.error}</span><button onClick={() => void model.loadCollection()}><RefreshCw />重试</button></div>}
    <div className="te-layout">
      <ExecutionRunPanel
        readiness={model.readiness}
        environments={model.environments}
        handoffs={model.handoffs}
        runs={model.runs}
        run={model.run}
        maintenanceProposals={model.maintenanceProposals}
        maintenanceFilter={maintenanceFilter}
        busy={model.busy}
        loading={model.loading}
        onRefresh={model.loadCollection}
        onCreate={async (handoffId, environmentId, testDataBindings) => {
          const created = await model.create(handoffId, environmentId, testDataBindings)
          if (created) updateExecutionRoute(created.id)
          return created
        }}
        onOpen={openRun}
        onCancel={model.cancel}
        onToggleMaintenanceFilter={() => setMaintenanceFilter(value => !value)}
      />
      <ExecutionTaskPanel
        tasks={visibleTasks}
        task={model.task}
        maintenanceProposal={model.maintenanceProposal}
        diff={model.diff}
        busy={model.busy}
        onOpen={openTask}
        onRetry={model.retry}
        onCompare={model.compareRevisions}
        onOpenMaintenanceProposal={async proposalId => {
          const proposal = model.maintenanceProposals.find(item => item.id === proposalId)
          if (proposal && model.task?.value.task.id !== proposal.taskId) await model.openTask(proposal.taskId)
          const opened = await model.openMaintenanceProposal(proposalId)
          if (opened && model.run) updateExecutionRoute(model.run.value.id, opened.task.id, proposalId)
          return opened
        }}
        onDecideMaintenance={model.decideMaintenance}
        onOpenFormalCase={openFormalCase}
      />
    </div>
  </main>
}

function updateExecutionRoute(runId: string, taskId?: string, proposalId?: string) {
  const url = new URL(window.location.href)
  url.searchParams.set('executionRunId', runId)
  if (taskId) url.searchParams.set('executionTaskId', taskId)
  else url.searchParams.delete('executionTaskId')
  if (proposalId) url.searchParams.set('executionMaintenanceProposalId', proposalId)
  else url.searchParams.delete('executionMaintenanceProposalId')
  window.history.replaceState({}, '', url)
}

function messageOf(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}
