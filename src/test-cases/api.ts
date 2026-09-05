import type { PublishedTestCasesResponse } from './types'

import { apiBase } from '../api-base'

export async function loadPublishedTestCases(projectVersionId: string): Promise<PublishedTestCasesResponse> {
  const response = await fetch(`${apiBase}/project-versions/${encodeURIComponent(projectVersionId)}/test-cases`)
  const body = await response.json().catch(() => ({})) as PublishedTestCasesResponse & { error?: string | { message?: string }; message?: string }
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : body.error?.message ?? body.message ?? `测试用例读取失败（HTTP ${response.status}）`)
  return body
}
