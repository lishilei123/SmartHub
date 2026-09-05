import type { TestReport, TestReportListItem } from './types'

import { apiBase } from '../api-base'

export class TestReportApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

type CachedReport = { path: string; etag: string; value: TestReport }
let cachedReport: CachedReport | undefined

async function request<T>(path: string, signal?: AbortSignal, conditional = false): Promise<T> {
  const cached = conditional && cachedReport?.path === path ? cachedReport : undefined
  const response = await fetch(`${apiBase}${path}`, {
    signal,
    headers: cached ? { 'If-None-Match': cached.etag } : undefined,
  })
  if (response.status === 304 && cached) return cached.value as T
  const body = await response.json().catch(() => ({})) as T & {
    code?: string
    message?: string
    details?: unknown
    error?: string
  }
  if (!response.ok) {
    throw new TestReportApiError(
      body.code ?? 'TEST_REPORT_REQUEST_FAILED',
      body.message ?? body.error ?? `测试报告请求失败（HTTP ${response.status}）`,
      response.status,
      body.details,
    )
  }
  if (conditional) {
    const etag = response.headers.get('etag')
    if (etag && !signal?.aborted) cachedReport = { path, etag, value: body as unknown as TestReport }
  }
  return body
}

const scope = (projectVersionId: string) =>
  `/project-versions/${encodeURIComponent(projectVersionId)}/test-reports`

export async function loadReports(projectVersionId: string, limit = 50) {
  return (await request<{ items: TestReportListItem[] }>(
    `${scope(projectVersionId)}?limit=${limit}`,
  )).items
}

export function loadReport(projectVersionId: string, runId: string, signal?: AbortSignal) {
  return request<TestReport>(`${scope(projectVersionId)}/${encodeURIComponent(runId)}`, signal, true)
}

export function reportExportUrl(
  projectVersionId: string,
  runId: string,
  format: 'json' | 'markdown',
) {
  const suffix = format === 'json' ? 'export.json' : 'report.md'
  return `${apiBase}${scope(projectVersionId)}/${encodeURIComponent(runId)}/${suffix}`
}

export function artifactUrl(
  artifactId: string,
  disposition: 'inline' | 'attachment' = 'attachment',
) {
  return `${apiBase}/test-execution-artifacts/${encodeURIComponent(artifactId)}?disposition=${disposition}`
}
