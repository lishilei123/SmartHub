import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../api'
import type { TestReport, TestReportListItem } from '../types'

export function useTestReport(projectVersionId: string | undefined) {
  const [reports, setReports] = useState<TestReportListItem[]>([])
  const [report, setReport] = useState<TestReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)

  const loadReports = useCallback(async () => {
    if (!projectVersionId) return []
    const requestGeneration = generation.current
    setLoading(true)
    try {
      const next = await api.loadReports(projectVersionId)
      if (requestGeneration !== generation.current) return []
      setReports(next)
      setError('')
      return next
    } catch (cause) {
      if (requestGeneration === generation.current) setError(messageOf(cause))
      return []
    } finally {
      if (requestGeneration === generation.current) setLoading(false)
    }
  }, [projectVersionId])

  const openReport = useCallback(async (runId: string, background = false) => {
    if (!projectVersionId) return
    const requestGeneration = generation.current
    if (background) setRefreshing(true)
    else setLoading(true)
    try {
      const next = await api.loadReport(projectVersionId, runId)
      if (requestGeneration !== generation.current) return
      setReport(next)
      setReports(current => current.map(item => item.runId === runId
        ? {
            ...item,
            status: next.run.status,
            stateVersion: next.run.stateVersion,
            finishedAt: next.run.finishedAt,
          }
        : item))
      setError('')
      return next
    } catch (cause) {
      if (requestGeneration === generation.current) setError(messageOf(cause))
      throw cause
    } finally {
      if (requestGeneration === generation.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [projectVersionId])

  useEffect(() => {
    generation.current += 1
    setReports([])
    setReport(null)
    setError('')
    if (projectVersionId) void loadReports()
  }, [loadReports, projectVersionId])

  useEffect(() => {
    if (!report || !['queued', 'running'].includes(report.run.status)) return
    let stopped = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const next = await openReport(report.run.id, true)
        if (!stopped && next && ['queued', 'running'].includes(next.run.status)) {
          timer = window.setTimeout(poll, 1800)
        }
      } catch {
        if (!stopped) timer = window.setTimeout(poll, 3000)
      }
    }
    timer = window.setTimeout(poll, 1800)
    return () => {
      stopped = true
      if (timer) window.clearTimeout(timer)
    }
  }, [openReport, report])

  return {
    reports,
    report,
    loading,
    refreshing,
    error,
    loadReports,
    openReport,
  }
}

function messageOf(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}
