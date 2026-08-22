import type { PublishedTestCasesResponse } from './types'

const apiBase = 'http://127.0.0.1:8787/api'

export async function loadPublishedTestCases(projectVersionId: string): Promise<PublishedTestCasesResponse> {
  const response = await fetch(`${apiBase}/project-versions/${encodeURIComponent(projectVersionId)}/test-cases`)
  const body = await response.json().catch(() => ({})) as PublishedTestCasesResponse & { error?: string | { message?: string }; message?: string }
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : body.error?.message ?? body.message ?? `测试用例读取失败（HTTP ${response.status}）`)
  return body
}
