import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../api'
import type {
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
  const diffRequest = useRef(0)
  const collectionRequest = useRef(0)
  const selectionVersion = useRef(0)
  const selectedRun = useRef<string | null>(null)
  const selectedTask = useRef<string | null>(null)
  const polling = useRef(false)
  const busyRef = useRef(busy)
  busyRef.current = busy

  const fail = useCallback((cause: unknown, toast = false) => {
    const message = cause instanceof Error ? cause.message : String(cause)
    setError(message)
    if (toast) notify(message, 'error')
    return message
  }, [notify])

  const loadCollection = useCallback(async () => {
    if (!projectVersionId) return
    const requestGeneration = generation.current
    const requestId = ++collectionRequest.current
    setLoading(true)
    try {
      const [nextReadiness, nextEnvironments, nextRuns] =
        await Promise.all([
          api.loadReadiness(projectVersionId),
          api.loadEnvironments(projectVersionId),
          api.loadRuns(projectVersionId),
        ])
      if (requestGeneration !== generation.current || requestId !== collectionRequest.current) return
      setReadiness(nextReadiness)
      setEnvironments(nextEnvironments)
      setRuns(nextRuns)
      setError('')
    } catch (cause) {
      if (requestGeneration === generation.current && requestId === collectionRequest.current) fail(cause)
    } finally {
      if (requestGeneration === generation.current && requestId === collectionRequest.current) setLoading(false)
    }
  }, [fail, projectVersionId])

  const openRun = useCallback(async (runId: string, background = false) => {
    if (!projectVersionId) return
    const requestGeneration = generation.current
    if (background && selectedRun.current !== runId) return
    if (selectedRun.current !== runId) {
      selectionVersion.current += 1
      selectedRun.current = runId
      selectedTask.current = null
      taskRequest.current += 1
      setRun(null)
      setTasks([])
      setTask(null)
      setDiff(null)
    }
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
    if (!background) setDiff(null)
    setRuns(current => [
      nextRun.value,
      ...current.filter(item => item.id !== nextRun.value.id),
    ])
    return nextRun.value
  }, [projectVersionId])

  const openTask = useCallback(async (taskId: string, background = false) => {
    if (!projectVersionId || !run || selectedRun.current !== run.value.id) return
    const requestGeneration = generation.current
    if (background && selectedTask.current !== taskId) return
    if (selectedTask.current !== taskId) {
      selectionVersion.current += 1
      selectedTask.current = taskId
      setTask(null)
      setDiff(null)
    }
    const requestId = ++taskRequest.current
    const runId = run.value.id
    const next = await api.loadTask(projectVersionId, runId, taskId)
    if (
      requestGeneration !== generation.current
      || requestId !== taskRequest.current
      || selectedRun.current !== runId
      || selectedTask.current !== taskId
      || next.value.task.id !== taskId
      || next.value.task.runId !== runId
      || next.value.run.id !== runId
    ) return
    setTask(next)
    if (!background) setDiff(null)
    setTasks(current => current.map(item =>
      item.id === next.value.task.id ? next.value.task : item))
    return next.value
  }, [projectVersionId, run])

  const refreshSelection = useCallback(async () => {
    if (!projectVersionId || !run) return
    const selectedTaskId = task?.value.task.id
    const nextRun = await openRun(run.value.id, true)
    if (selectedTaskId && nextRun) await openTask(selectedTaskId, true)
    return nextRun
  }, [openRun, openTask, projectVersionId, run, task])

  useEffect(() => {
    generation.current += 1
    selectionVersion.current += 1
    selectedRun.current = null
    selectedTask.current = null
    setBusy('')
    setLoading(false)
    runRequest.current += 1
    taskRequest.current += 1
    setReadiness(null)
    setEnvironments([])
    setRuns([])
    setRun(null)
    setTasks([])
    setTask(null)
    setDiff(null)
    setError('')
    if (projectVersionId) void loadCollection()
    return () => { generation.current += 1 }
  }, [loadCollection, projectVersionId])

  const refreshRef = useRef(refreshSelection)
  refreshRef.current = refreshSelection
  const activeRunId = run?.value.id
  const activeStatus = run?.value.status
  useEffect(() => {
    if (!activeRunId || !activeStatus || !['queued', 'running'].includes(activeStatus)) return
    let stopped = false
    let timer: number | undefined
    const poll = async () => {
      if (stopped || selectedRun.current !== activeRunId) return
      let retryDelay = 1800
      if (polling.current || busyRef.current) { timer = window.setTimeout(poll, retryDelay); return }
      polling.current = true
      try {
        await refreshRef.current()
      } catch (cause) {
        if (!stopped) fail(cause)
        retryDelay = 3000
      } finally {
        polling.current = false
        if (!stopped && selectedRun.current === activeRunId) timer = window.setTimeout(poll, retryDelay)
      }
    }
    timer = window.setTimeout(poll, 1800)
    return () => {
      stopped = true
      if (timer) window.clearTimeout(timer)
    }
  }, [fail, activeRunId, activeStatus])

  const create = useCallback(async (
    baseUrl: string,
  ) => {
    if (!projectVersionId || busy) return
    const requestGeneration = generation.current
    const requestSelection = selectionVersion.current
    const current = () => requestGeneration === generation.current && requestSelection === selectionVersion.current
    runRequest.current += 1
    taskRequest.current += 1
    setBusy('create')
    try {
      const created = await api.createRun(
        projectVersionId,
        baseUrl,
        api.executionIdempotencyKey('create', baseUrl),
      )
      if (!current()) return
      selectedRun.current = created.value.id
      selectedTask.current = null
      setRun(created)
      setTask(null)
      setDiff(null)
      const nextTasks = await api.loadTasks(projectVersionId, created.value.id)
      if (!current()) return
      setTasks(nextTasks)
      setRuns(current => [
        created.value,
        ...current.filter(item => item.id !== created.value.id),
      ])
      notify('测试执行已创建，测试数据供给、业务输入与运行配置已冻结。', 'success')
      return created.value
    } catch (cause) {
      if (current()) fail(cause, true)
    } finally {
      if (requestGeneration === generation.current) setBusy('')
    }
  }, [busy, fail, notify, projectVersionId])

  const cancel = useCallback(async () => {
    if (!projectVersionId || !run || busy) return
    const requestGeneration = generation.current
    const requestSelection = selectionVersion.current
    const current = () => requestGeneration === generation.current && requestSelection === selectionVersion.current
    runRequest.current += 1
    taskRequest.current += 1
    setBusy('cancel')
    try {
      const cancelled = await api.cancelRun(
        projectVersionId,
        run.value.id,
        run.etag,
      )
      if (!current()) return
      runRequest.current += 1
      setRun(cancelled)
      setRuns(current => current.map(item =>
        item.id === cancelled.value.id ? cancelled.value : item))
      notify('取消请求已提交。', 'success')
    } catch (cause) {
      if (current()) fail(cause, true)
    } finally {
      if (requestGeneration === generation.current) setBusy('')
    }
  }, [busy, fail, notify, projectVersionId, run])

  const retry = useCallback(async () => {
    if (!projectVersionId || !run || !task || busy) return
    const requestGeneration = generation.current
    const requestSelection = selectionVersion.current
    const current = () => requestGeneration === generation.current && requestSelection === selectionVersion.current
    runRequest.current += 1
    taskRequest.current += 1
    setBusy('retry')
    try {
      const result = await api.retryTask(
        projectVersionId,
        run.value.id,
        task.value.task.id,
        task.etag,
        api.executionIdempotencyKey('retry', task.value.task.id),
      )
      if (!current()) return
      setRun({ value: result.value.run, etag: '' })
      await openRun(result.value.run.id)
      if (!current()) return
      await openTask(result.value.task.id, true)
      notify('人工重试已排队，历史 Attempt、Revision 与修复计数全部保留。', 'success')
    } catch (cause) {
      if (current()) fail(cause, true)
    } finally {
      if (requestGeneration === generation.current) setBusy('')
    }
  }, [busy, fail, notify, openRun, openTask, projectVersionId, run, task])

  const compareRevisions = useCallback(async (
    fromRevisionId: string,
    toRevisionId: string,
  ) => {
    if (!projectVersionId || !run || !task) return
    const requestGeneration = generation.current
    const requestSelection = selectionVersion.current
    const requestId = ++diffRequest.current
    const current = () => requestGeneration === generation.current && requestSelection === selectionVersion.current && requestId === diffRequest.current
    try {
      const next = await api.loadScriptRevisionDiff(
        projectVersionId,
        run.value.id,
        task.value.task.id,
        fromRevisionId,
        toRevisionId,
      )
      if (current()) setDiff(next)
    } catch (cause) {
      if (current()) fail(cause, true)
    }
  }, [fail, projectVersionId, run, task])

  return {
    readiness,
    environments,
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
