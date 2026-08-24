import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../api'
import type {
  AgentUnderTest,
  ExecutionEnvironment,
  ExecutionReadiness,
  ExecutionRun,
  ExecutionTask,
  ExecutionTaskDetail,
  ScriptRevisionDiff,
  Versioned,
} from '../types'

type Notify = (message: string, tone?: 'success' | 'error' | 'warning') => void

export function useTestExecution(
  projectVersionId: string | undefined,
  notify: Notify,
) {
  const [readiness, setReadiness] = useState<ExecutionReadiness | null>(null)
  const [environments, setEnvironments] = useState<ExecutionEnvironment[]>([])
  const [agentsUnderTest, setAgentsUnderTest] = useState<AgentUnderTest[]>([])
  const [runs, setRuns] = useState<ExecutionRun[]>([])
  const [run, setRun] = useState<Versioned<ExecutionRun> | null>(null)
  const [tasks, setTasks] = useState<ExecutionTask[]>([])
  const [task, setTask] = useState<Versioned<ExecutionTaskDetail> | null>(null)
  const [diff, setDiff] = useState<ScriptRevisionDiff | null>(null)
  const [busy, setBusy] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const runRequest = useRef(0)
  const taskRequest = useRef(0)

  const fail = useCallback((cause: unknown, toast = false) => {
    const message = cause instanceof Error ? cause.message : String(cause)
    setError(message)
    if (toast) notify(message, 'error')
    return message
  }, [notify])

  const loadCollection = useCallback(async () => {
    if (!projectVersionId) return
    const requestGeneration = generation.current
    setLoading(true)
    try {
      const [nextReadiness, nextEnvironments, nextAgentsUnderTest, nextRuns] =
        await Promise.all([
          api.loadReadiness(projectVersionId),
          api.loadEnvironments(projectVersionId),
          api.loadAgentsUnderTest(projectVersionId),
          api.loadRuns(projectVersionId),
        ])
      if (requestGeneration !== generation.current) return
      setReadiness(nextReadiness)
      setEnvironments(nextEnvironments)
      setAgentsUnderTest(nextAgentsUnderTest)
      setRuns(nextRuns)
      setError('')
    } catch (cause) {
      if (requestGeneration === generation.current) fail(cause)
    } finally {
      if (requestGeneration === generation.current) setLoading(false)
    }
  }, [fail, projectVersionId])

  const openRun = useCallback(async (runId: string) => {
    if (!projectVersionId) return
    const requestGeneration = generation.current
    const requestId = ++runRequest.current
    const [nextRun, nextTasks] = await Promise.all([
      api.loadRun(projectVersionId, runId),
      api.loadTasks(projectVersionId, runId),
    ])
    if (
      requestGeneration !== generation.current
      || requestId !== runRequest.current
      || nextRun.value.id !== runId
      || nextTasks.some(item => item.runId !== runId)
    ) return
    setRun(nextRun)
    setTasks(nextTasks)
    setTask(current => current?.value.task.runId === runId ? current : null)
    setDiff(null)
    setRuns(current => [
      nextRun.value,
      ...current.filter(item => item.id !== nextRun.value.id),
    ])
    return nextRun.value
  }, [projectVersionId])

  const openTask = useCallback(async (taskId: string) => {
    if (!projectVersionId || !run) return
    const requestGeneration = generation.current
    const requestId = ++taskRequest.current
    const runId = run.value.id
    const next = await api.loadTask(projectVersionId, runId, taskId)
    if (
      requestGeneration !== generation.current
      || requestId !== taskRequest.current
      || next.value.task.id !== taskId
      || next.value.task.runId !== runId
      || next.value.run.id !== runId
    ) return
    setTask(next)
    setDiff(null)
    setTasks(current => current.map(item =>
      item.id === next.value.task.id ? next.value.task : item))
    return next.value
  }, [projectVersionId, run])

  const refreshSelection = useCallback(async () => {
    if (!projectVersionId || !run) return
    const selectedTaskId = task?.value.task.id
    const nextRun = await openRun(run.value.id)
    if (selectedTaskId && nextRun) await openTask(selectedTaskId)
    return nextRun
  }, [openRun, openTask, projectVersionId, run, task])

  useEffect(() => {
    generation.current += 1
    runRequest.current += 1
    taskRequest.current += 1
    setReadiness(null)
    setEnvironments([])
    setAgentsUnderTest([])
    setRuns([])
    setRun(null)
    setTasks([])
    setTask(null)
    setDiff(null)
    setError('')
    if (projectVersionId) void loadCollection()
  }, [loadCollection, projectVersionId])

  useEffect(() => {
    if (!run || !['queued', 'running'].includes(run.value.status)) return
    let stopped = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const next = await refreshSelection()
        if (!stopped && next && ['queued', 'running'].includes(next.status)) {
          timer = window.setTimeout(poll, 1800)
        }
      } catch (cause) {
        if (!stopped) {
          fail(cause)
          timer = window.setTimeout(poll, 3000)
        }
      }
    }
    timer = window.setTimeout(poll, 1800)
    return () => {
      stopped = true
      if (timer) window.clearTimeout(timer)
    }
  }, [fail, refreshSelection, run])

  const create = useCallback(async (
    agentUnderTestId: string,
  ) => {
    if (!projectVersionId || busy) return
    setBusy('create')
    try {
      const created = await api.createRun(
        projectVersionId,
        agentUnderTestId,
        api.executionIdempotencyKey('create', agentUnderTestId),
      )
      setRun(created)
      setTask(null)
      setDiff(null)
      const nextTasks = await api.loadTasks(projectVersionId, created.value.id)
      setTasks(nextTasks)
      setRuns(current => [
        created.value,
        ...current.filter(item => item.id !== created.value.id),
      ])
      notify('测试执行已创建，测试数据供给、业务输入与运行配置已冻结。', 'success')
      return created.value
    } catch (cause) {
      fail(cause, true)
    } finally {
      setBusy('')
    }
  }, [busy, fail, notify, projectVersionId])

  const createAgentUnderTest = useCallback(async (input: Parameters<typeof api.createAgentUnderTest>[1]) => {
    if (!projectVersionId || busy) return
    setBusy('create-agent-under-test')
    try {
      const created = await api.createAgentUnderTest(projectVersionId, input)
      setAgentsUnderTest(current => [...current, created])
      notify('被测 Agent 已保存到当前 ProjectVersion。', 'success')
      return created
    } catch (cause) {
      fail(cause, true)
    } finally {
      setBusy('')
    }
  }, [busy, fail, notify, projectVersionId])

  const cancel = useCallback(async () => {
    if (!projectVersionId || !run || busy) return
    setBusy('cancel')
    try {
      const cancelled = await api.cancelRun(
        projectVersionId,
        run.value.id,
        run.etag,
      )
      setRun(cancelled)
      setRuns(current => current.map(item =>
        item.id === cancelled.value.id ? cancelled.value : item))
      notify('取消请求已提交。', 'success')
    } catch (cause) {
      fail(cause, true)
    } finally {
      setBusy('')
    }
  }, [busy, fail, notify, projectVersionId, run])

  const retry = useCallback(async () => {
    if (!projectVersionId || !run || !task || busy) return
    setBusy('retry')
    try {
      const result = await api.retryTask(
        projectVersionId,
        run.value.id,
        task.value.task.id,
        task.etag,
        api.executionIdempotencyKey('retry', task.value.task.id),
      )
      setRun({ value: result.value.run, etag: '' })
      await openRun(result.value.run.id)
      await openTask(result.value.task.id)
      notify('人工重试已排队，历史 Attempt、Revision 与修复计数全部保留。', 'success')
    } catch (cause) {
      fail(cause, true)
    } finally {
      setBusy('')
    }
  }, [busy, fail, notify, openRun, openTask, projectVersionId, run, task])

  const compareRevisions = useCallback(async (
    fromRevisionId: string,
    toRevisionId: string,
  ) => {
    if (!projectVersionId || !run || !task) return
    try {
      const next = await api.loadScriptRevisionDiff(
        projectVersionId,
        run.value.id,
        task.value.task.id,
        fromRevisionId,
        toRevisionId,
      )
      setDiff(next)
    } catch (cause) {
      fail(cause, true)
    }
  }, [fail, projectVersionId, run, task])

  return {
    readiness,
    environments,
    agentsUnderTest,
    runs,
    run,
    tasks,
    task,
    diff,
    busy,
    loading,
    error,
    loadCollection,
    openRun,
    openTask,
    create,
    createAgentUnderTest,
    cancel,
    retry,
    compareRevisions,
  }
}
