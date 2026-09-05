import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../api'
import type { TestReport, TestReportListItem } from '../types'

export function useTestReport(projectVersionId: string | undefined) {
  const [reports, setReports] = useState<TestReportListItem[]>([])
  const [report, setReport] = useState<TestReport | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [reportLoading, setReportLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const listRequest = useRef(0)
  const reportRequest = useRef(0)
  const selectedRun = useRef<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const [selection, setSelection] = useState<string | null>(null)

  const loadReports = useCallback(async () => {
    if (!projectVersionId) return []
    const requestGeneration = generation.current
    const requestId = ++listRequest.current
    const current = () => requestGeneration === generation.current && requestId === listRequest.current
    setListLoading(true)
    try {
      const next = await api.loadReports(projectVersionId)
      if (!current()) return []
      setReports(next)
      setError('')
      return next
    } catch (cause) {
      if (current()) setError(messageOf(cause))
      return []
    } finally {
      if (current()) setListLoading(false)
    }
  }, [projectVersionId])

  const openReport = useCallback(async (runId: string, background = false) => {
    if (!projectVersionId || (background && selectedRun.current !== runId)) return
    const requestGeneration = generation.current
    const requestId = ++reportRequest.current
    selectedRun.current = runId
    setSelection(runId)
    controller.current?.abort()
    const requestController = new AbortController()
    controller.current = requestController
    const current = () => requestGeneration === generation.current && requestId === reportRequest.current
    setRefreshing(background)
    setReportLoading(!background)
    if (!background) setReport(previous => previous?.run.id === runId ? previous : null)
    try {
      const next = await api.loadReport(projectVersionId, runId, requestController.signal)
      if (!current()) return
      setReport(next)
      setReports(items => items.map(item => item.runId === runId
        ? { ...item, status: next.run.status, stateVersion: next.run.stateVersion, finishedAt: next.run.finishedAt }
        : item))
      setError('')
      return next
    } catch (cause) {
      if (!current() || requestController.signal.aborted) return
      setError(messageOf(cause))
      throw cause
    } finally {
      if (current()) {
        controller.current = null
        setReportLoading(false)
        setRefreshing(false)
      }
    }
  }, [projectVersionId])

  useEffect(() => {
    generation.current += 1
    selectedRun.current = null
    setSelection(null)
    setReports([])
    setReport(null)
    setError('')
    setReportLoading(false)
    setRefreshing(false)
    setListLoading(false)
    if (projectVersionId) void loadReports()
    return () => {
      generation.current += 1
      controller.current?.abort()
      controller.current = null
    }
  }, [loadReports, projectVersionId])

  const activeRunId = report?.run.id
  const activeStatus = report?.run.status
  useEffect(() => {
    if (!activeRunId || activeRunId !== selection || !activeStatus || !['queued', 'running'].includes(activeStatus)) return
    let stopped = false
    let timer: number | undefined
    const poll = async () => {
      if (stopped || selectedRun.current !== activeRunId) return
      let delay = 1800
      try {
        // A manual refresh owns the outstanding request; wait before polling again.
        if (controller.current) return
        await openReport(activeRunId, true)
      } catch {
        // Keep the visible report and back off after a failed refresh.
        delay = 3000
      }
      finally {
        if (!stopped && selectedRun.current === activeRunId) timer = window.setTimeout(poll, delay)
      }
    }
    timer = window.setTimeout(poll, 1800)
    return () => {
      stopped = true
      if (timer) window.clearTimeout(timer)
    }
  }, [openReport, activeRunId, activeStatus, selection])

  return { reports, report, loading: listLoading || reportLoading, refreshing, error, loadReports, openReport }
}

function messageOf(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}
