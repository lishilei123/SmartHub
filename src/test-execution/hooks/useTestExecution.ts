import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../api'
import type { AgentUnderTest, ExecutionReadiness, ExecutionRun, ExecutionTask, ExecutionTaskDetail, Versioned } from '../types'

type Notify = (message: string, tone?: 'success' | 'error' | 'warning') => void
export function useTestExecution(projectVersionId: string | undefined, notify: Notify) {
  const [readiness, setReadiness] = useState<ExecutionReadiness | null>(null)
  const [agentsUnderTest, setAgentsUnderTest] = useState<AgentUnderTest[]>([])
  const [runs, setRuns] = useState<ExecutionRun[]>([])
  const [run, setRun] = useState<Versioned<ExecutionRun> | null>(null)
  const [tasks, setTasks] = useState<ExecutionTask[]>([])
  const [task, setTask] = useState<Versioned<ExecutionTaskDetail> | null>(null)
  const [busy, setBusy] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)

  const fail = useCallback((cause: unknown, toast = false) => { const message = cause instanceof Error ? cause.message : String(cause); setError(message); if (toast) notify(message, 'error') }, [notify])
  const loadCollection = useCallback(async () => {
    if (!projectVersionId) return
    const current = generation.current; setLoading(true)
    try {
      const [nextReadiness, nextAgents, nextRuns] = await Promise.all([api.loadReadiness(projectVersionId), api.loadAgentsUnderTest(projectVersionId), api.loadRuns(projectVersionId)])
      if (current !== generation.current) return
      setReadiness(nextReadiness); setAgentsUnderTest(nextAgents); setRuns(nextRuns); setError('')
    } catch (cause) { if (current === generation.current) fail(cause) }
    finally { if (current === generation.current) setLoading(false) }
  }, [fail, projectVersionId])

  const openRun = useCallback(async (runId: string) => {
    if (!projectVersionId) return
    const [nextRun, nextTasks] = await Promise.all([api.loadRun(projectVersionId, runId), api.loadTasks(projectVersionId, runId)])
    setRun(nextRun); setTasks(nextTasks); setTask(current => current?.value.task.runId === runId ? current : null)
    setRuns(current => [nextRun.value, ...current.filter(item => item.id !== runId)])
    return nextRun.value
  }, [projectVersionId])
  const openTask = useCallback(async (taskId: string) => {
    if (!projectVersionId || !run) return
    const next = await api.loadTask(projectVersionId, run.value.id, taskId)
    setTask(next); setTasks(current => current.map(item => item.id === taskId ? next.value.task : item)); return next.value
  }, [projectVersionId, run])

  useEffect(() => { generation.current += 1; setReadiness(null); setAgentsUnderTest([]); setRuns([]); setRun(null); setTasks([]); setTask(null); setError(''); if (projectVersionId) void loadCollection() }, [loadCollection, projectVersionId])
  useEffect(() => {
    if (!run || !['queued', 'running'].includes(run.value.status)) return
    let stopped = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const next = await openRun(run.value.id)
        if (task) await openTask(task.value.task.id)
        if (!stopped && next && ['queued', 'running'].includes(next.status)) timer = window.setTimeout(poll, 1800)
      } catch (cause) {
        if (!stopped) { fail(cause); timer = window.setTimeout(poll, 3000) }
      }
    }
    timer = window.setTimeout(poll, 1800)
    return () => { stopped = true; if (timer) window.clearTimeout(timer) }
  }, [fail, openRun, openTask, run, task])

  const create = useCallback(async (agentUnderTestId: string) => {
    if (!projectVersionId || busy) return
    setBusy('create')
    try { const created = await api.createRun(projectVersionId, agentUnderTestId, api.executionIdempotencyKey('create', agentUnderTestId)); setRun(created); setTask(null); setTasks(await api.loadTasks(projectVersionId, created.value.id)); setRuns(current => [created.value, ...current.filter(item => item.id !== created.value.id)]); notify('Agent Test Run 已创建并冻结正式输入。', 'success'); return created.value }
    catch (cause) { fail(cause, true) } finally { setBusy('') }
  }, [busy, fail, notify, projectVersionId])
  const createAgentUnderTest = useCallback(async (input: Parameters<typeof api.createAgentUnderTest>[1]) => {
    if (!projectVersionId || busy) return
    setBusy('create-agent-under-test')
    try { const created = await api.createAgentUnderTest(projectVersionId, input); setAgentsUnderTest(current => [...current, created]); notify('被测 Agent 已保存。', 'success'); return created }
    catch (cause) { fail(cause, true) } finally { setBusy('') }
  }, [busy, fail, notify, projectVersionId])
  const cancel = useCallback(async () => {
    if (!projectVersionId || !run || busy) return
    setBusy('cancel')
    try { const next = await api.cancelRun(projectVersionId, run.value.id, run.etag); setRun(next); setRuns(current => current.map(item => item.id === next.value.id ? next.value : item)); notify('取消请求已提交。', 'success') }
    catch (cause) { fail(cause, true) } finally { setBusy('') }
  }, [busy, fail, notify, projectVersionId, run])
  const retry = useCallback(async () => {
    if (!projectVersionId || !run || !task || busy) return
    setBusy('retry')
    try { const result = await api.retryTask(projectVersionId, run.value.id, task.value.task.id, task.etag, api.executionIdempotencyKey('retry', task.value.task.id)); await openRun(result.value.run.id); await openTask(result.value.task.id); notify('Agent Test 人工重试已排队。', 'success') }
    catch (cause) { fail(cause, true) } finally { setBusy('') }
  }, [busy, fail, notify, openRun, openTask, projectVersionId, run, task])

  return { readiness, agentsUnderTest, runs, run, tasks, task, busy, loading, error, loadCollection, openRun, openTask, create, createAgentUnderTest, cancel, retry }
}
