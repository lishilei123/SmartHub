import type { TestReport, TestReportListItem } from './types'

const apiBase = 'http://127.0.0.1:8787/api'

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

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`)
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
  return body
}

const scope = (projectVersionId: string) =>
  `/project-versions/${encodeURIComponent(projectVersionId)}/test-reports`

export async function loadReports(projectVersionId: string, limit = 50) {
  return (await request<{ items: TestReportListItem[] }>(
    `${scope(projectVersionId)}?limit=${limit}`,
  )).items
}

export function loadReport(projectVersionId: string, runId: string) {
  return request<TestReport>(`${scope(projectVersionId)}/${encodeURIComponent(runId)}`)
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
