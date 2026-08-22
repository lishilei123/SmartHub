import type { TestCaseContent, TestCaseTraceability } from '../test-design/types'

export type PublishedTestCaseSource = 'current_created' | 'historical_reused' | 'historical_modified'
export type PublishedTestCase = {
  caseId: string
  revision: number
  source: PublishedTestCaseSource
  content: TestCaseContent
  executionReadiness: 'ready' | 'needs_confirmation' | 'blocked'
  contentSha256: string
  traceability?: TestCaseTraceability
  sourceTraceability?: { sourceProjectVersionId: string; sourceCaseId: string; sourceRevision: number; changeType: 'reuse' | 'update' }
}
export type PublishedTestCasesResponse = {
  projectVersion: { id: string; name: string }
  libraryVersion: { id: string; version: number; name: string; contentSha256: string; publishedAt: string } | null
  statistics: { total: number; currentCreated: number; historicalReused: number; historicalModified: number; ready: number; needsConfirmation: number; blocked: number }
  items: PublishedTestCase[]
}
