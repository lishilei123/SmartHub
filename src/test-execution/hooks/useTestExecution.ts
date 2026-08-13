import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../api'
import type {
  ExecutionEnvironment,
  ExecutionHandoff,
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
  const [handoffs, setHandoffs] = useState<ExecutionHandoff[]>([])
  const [runs, setRuns] = useState<ExecutionRun[]>([])
  const [run, setRun] = useState<Versioned<ExecutionRun> | null>(null)
  const [tasks, setTasks] = useState<ExecutionTask[]>([])
  const [task, setTask] = useState<Versioned<ExecutionTaskDetail> | null>(null)
  const [diff, setDiff] = useState<ScriptRevisionDiff | null>(null)
  const [busy, setBusy] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)

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
      const [nextReadiness, nextEnvironments, nextHandoffs, nextRuns] =
        await Promise.all([
          api.loadReadiness(projectVersionId),
          api.loadEnvironments(projectVersionId),
          api.loadHandoffs(projectVersionId),
          api.loadRuns(projectVersionId),
        ])
      if (requestGeneration !== generation.current) return
      setReadiness(nextReadiness)
      setEnvironments(nextEnvironments)
      setHandoffs(nextHandoffs)
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
    const [nextRun, nextTasks] = await Promise.all([
      api.loadRun(projectVersionId, runId),
      api.loadTasks(projectVersionId, runId),
    ])
    if (requestGeneration !== generation.current) return
    setRun(nextRun)
    setTasks(nextTasks)
    setTask(current => current?.value.task.runId === runId ? current : null)
    setDiff(null)
    setRuns(current => current.map(item =>
      item.id === nextRun.value.id ? nextRun.value : item))
    return nextRun.value
  }, [projectVersionId])

  const openTask = useCallback(async (taskId: string) => {
    if (!projectVersionId || !run) return
    const requestGeneration = generation.current
    const next = await api.loadTask(projectVersionId, run.value.id, taskId)
    if (requestGeneration !== generation.current) return
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
    setReadiness(null)
    setEnvironments([])
    setHandoffs([])
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
    handoffId: string,
    environmentId: string,
  ) => {
    if (!projectVersionId || busy) return
    setBusy('create')
    try {
      const created = await api.createRun(
        projectVersionId,
        handoffId,
        environmentId,
        api.executionIdempotencyKey('create', handoffId),
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
      notify('测试执行已创建，全部业务输入与运行配置已冻结。', 'success')
      return created.value
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
    handoffs,
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
    cancel,
    retry,
    compareRevisions,
  }
}
