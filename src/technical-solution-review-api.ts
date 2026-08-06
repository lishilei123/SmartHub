const apiBase = 'http://127.0.0.1:8787/api'

export type TechnicalRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type CoverageStatus = 'covered' | 'partially_covered' | 'not_covered' | 'needs_confirmation'
export type FindingState = 'open' | 'confirmed' | 'dismissed' | 'resolved' | 'needs_follow_up'

export type TechnicalBaseline = { id: string; reviewId: string; completedAt?: string; requirementCount: number; documentTitle: string; unresolvedHighCount: number }
export type TechnicalSolutionAsset = { assetId: string; assetVersionId: string; displayName: string; logicalPath: string; version: number; contentSha256: string; indexVersionId: string }
type TechnicalAgentConfiguration = null | { id: string; version: number; contentSha256: string; toolIds: string[]; primaryModel: { sourceId: string; modelId: string } | null }
export type TechnicalInputResponse<T> = { projectVersion: { id: string; name: string; status: 'open' | 'locked' | 'archived' }; items: T[]; agentConfiguration: TechnicalAgentConfiguration; agentConfigurations?: { extraction: TechnicalAgentConfiguration; review: TechnicalAgentConfiguration } }
export type TechnicalReview = { id: string; projectVersionId: string; name: string; sourceReviewRunId: string; solutionAssetVersionIds: string[]; inputSetSha256: string; createdAt: string; latestRun?: TechnicalRunSummary | null }
export type TechnicalEvidence = { id: string; sourceKind: 'requirement' | 'technical_design'; assetId: string; assetVersionId: string; chunkId: string; contentSha256: string; headingPath: string[]; quote: string; startLine: number; endLine: number }
export type TechnicalFormalResult = {
  schemaVersion: 'technical-solution-review-result/v1'
  summary: { overallAssessment: 'pass' | 'pass_with_notes' | 'needs_revision' | 'blocked'; overview: string; majorGaps: string[]; majorRisks: string[]; recommendedOrder: string[] }
  coverage: Array<{ id: string; requirementPointId: string; requirementTitle: string; status: CoverageStatus; analysis: string; evidenceIds: string[] }>
  findings: Array<{ id: string; type: string; severity: 'blocker' | 'high' | 'medium' | 'low'; title: string; problem: string; impact: string; recommendation: string; confidence: number; requirementPointIds: string[]; evidenceIds: string[] }>
  evidence: TechnicalEvidence[]
  risks: Array<{ id: string; description: string; impact: string; mitigation: string; evidenceIds: string[] }>
  questions: Array<{ id: string; question: string; reason: string; evidenceIds: string[] }>
  statistics: { totalRequirements: number; covered: number; partiallyCovered: number; notCovered: number; needsConfirmation: number; coverageRatio: number }
}
type TechnicalAgentSnapshot = { agentKey: string; version: string; promptRef: { contentSha256: string }; toolsetContentSha256: string; toolIds: string[] }
export type TechnicalSnapshot = { schemaVersion: string; runId: string; technicalReviewId: string; projectVersionId: string; projectVersionName: string; indexVersionId: string; requirementBaseline: { sourceReviewRunId: string; snapshotSha256: string; requirementPoints: Array<{ id: string; title: string; description: string; evidenceIds: string[] }>; evidence: Array<{ evidenceId: string; requirementPointId: string; assetVersionId: string; quote: string; startLine: number; endLine: number }>; findings: Array<{ id: string; severity: string; state: FindingState; title: string }> }; solutionInputs: Array<{ assetId: string; assetVersionId: string; displayName: string; logicalPath: string; contentSha256: string }>; modelRef: { sourceId: string; modelId: string; modelName: string }; agentConfigurationRef?: { id: string; version: number; contentSha256: string }; agentDefinition: TechnicalAgentSnapshot; agentDefinitions?: { technicalSolutionExtraction: TechnicalAgentSnapshot; technicalSolutionReview: TechnicalAgentSnapshot }; inputPlan: { mode: 'full_context' | 'segmented_context'; estimatedInputTokens: number; safeInputBudget: number; packageSha256: string; batches: Array<{ batchId: string; tokenCount: number; assetVersionIds: string[]; chunkIds: string[] }> } }
export type TechnicalRunSummary = { id: string; runId: string; technicalReviewId: string; projectVersionId: string; sourceReviewRunId: string; status: TechnicalRunStatus; step: string; failedAtStep?: string; progress: number; modelLabel: string; modelRouteAttempts?: Array<{ id: string; attempt: number; modelLabel: string; status: string; error?: string }>; degradations?: Array<{ fromModelId: string; toModelId: string; reason: string; occurredAt: string }>; createdAt: string; startedAt?: string; finishedAt?: string; errorCode?: string; error?: string; queue?: { status: TechnicalRunStatus; attempts: number; maxAttempts: number; availableAt: string }; snapshot: TechnicalSnapshot; summary?: TechnicalFormalResult['summary']; statistics?: TechnicalFormalResult['statistics'] }
export type TechnicalExecutionEvent = {
  sequence: number
  type: string
  occurredAt: string
  turn?: number
  toolId?: string
  toolCallId?: string
  isError?: boolean
  role?: 'user' | 'assistant' | 'tool'
  content?: string
  toolCalls?: { id: string; name: string }[]
  toolArguments?: unknown
  toolResult?: unknown
  stopReason?: string
  model?: string
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }
  framework?: { name: string; version: string }
}

export type TechnicalExecutionRecord = {
  agentKey?: 'technical-solution-analysis' | 'technical-solution-extraction' | 'technical-solution-review'
  turns: number
  toolCalls: number
  toolErrors?: number
  framework?: { name: string; version: string }
  events: TechnicalExecutionEvent[]
}

export type TechnicalRun = TechnicalRunSummary & { result?: TechnicalFormalResult; extractionResult?: { schemaVersion: string; solutionPoints: Array<{ id: string; title: string; description: string; evidenceIds: string[] }>; evidence: TechnicalEvidence[] }; inputDeliveryManifest?: { mode: string; entries: unknown[]; finalMergeCompleted: boolean }; execution?: TechnicalExecutionRecord; executions?: { technicalSolutionExtraction?: TechnicalExecutionRecord; technicalSolutionReview?: TechnicalExecutionRecord }; events?: TechnicalExecutionEvent[] }
export type FindingActionsResponse = { actions: Array<{ id: string; findingId: string; action: string; fromState: FindingState; toState: FindingState; comment?: string; actorDisplayName: string; version: number; createdAt: string }>; findings: Array<{ findingId: string; state: FindingState; version: number }> }

export async function loadTechnicalBaselines(projectVersionId: string) { return request<TechnicalInputResponse<TechnicalBaseline>>(`/project-versions/${encodeURIComponent(projectVersionId)}/technical-solution-review-inputs/baselines`) }
export async function loadTechnicalSolutionAssets(projectVersionId: string) { return request<TechnicalInputResponse<TechnicalSolutionAsset>>(`/project-versions/${encodeURIComponent(projectVersionId)}/technical-solution-review-inputs/solution-assets`) }
export async function loadTechnicalReviews(projectVersionId: string) { return request<{ items: TechnicalReview[] }>(`/project-versions/${encodeURIComponent(projectVersionId)}/technical-solution-reviews`) }
export async function createTechnicalReview(projectVersionId: string, input: { name: string; sourceReviewRunId: string; solutionAssetVersionIds: string[] }) { return request<TechnicalReview>(`/project-versions/${encodeURIComponent(projectVersionId)}/technical-solution-reviews`, { method: 'POST', body: JSON.stringify(input) }) }
export async function createTechnicalRun(projectVersionId: string, technicalReviewId: string) { return request<TechnicalRun>(scope(projectVersionId, technicalReviewId, 'runs'), { method: 'POST' }) }
export async function loadTechnicalRuns(projectVersionId: string, technicalReviewId: string) { return request<{ items: TechnicalRunSummary[] }>(scope(projectVersionId, technicalReviewId, 'runs')) }
export async function loadTechnicalRun(projectVersionId: string, technicalReviewId: string, runId: string) { return request<TechnicalRun>(scope(projectVersionId, technicalReviewId, `runs/${encodeURIComponent(runId)}`)) }
export async function cancelTechnicalRun(projectVersionId: string, technicalReviewId: string, runId: string) { return request<TechnicalRun>(scope(projectVersionId, technicalReviewId, `runs/${encodeURIComponent(runId)}/cancel`), { method: 'POST' }) }
export async function loadTechnicalFindingActions(projectVersionId: string, technicalReviewId: string, runId: string) { return request<FindingActionsResponse>(scope(projectVersionId, technicalReviewId, `runs/${encodeURIComponent(runId)}/finding-actions`)) }
export async function actOnTechnicalFinding(projectVersionId: string, technicalReviewId: string, runId: string, findingId: string, input: { action: string; comment?: string; expectedVersion: number }) { return request(scope(projectVersionId, technicalReviewId, `runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(findingId)}/actions`), { method: 'POST', body: JSON.stringify(input) }) }
export async function loadTechnicalFixedContent(projectVersionId: string, technicalReviewId: string, runId: string, assetVersionId: string) { return request<{ assetVersionId: string; contentSha256: string; content: string }>(scope(projectVersionId, technicalReviewId, `runs/${encodeURIComponent(runId)}/asset-versions/${encodeURIComponent(assetVersionId)}/content`)) }
export async function downloadTechnicalReport(projectVersionId: string, technicalReviewId: string, runId: string) { const response = await fetch(`${apiBase}${scope(projectVersionId, technicalReviewId, `runs/${encodeURIComponent(runId)}/report.md`)}`); if (!response.ok) throw new Error(await responseError(response, '报告导出失败')); return response.blob() }

function scope(projectVersionId: string, technicalReviewId: string, suffix: string) { return `/project-versions/${encodeURIComponent(projectVersionId)}/technical-solution-reviews/${encodeURIComponent(technicalReviewId)}/${suffix}` }
async function request<T = unknown>(path: string, init?: RequestInit) { const response = await fetch(`${apiBase}${path}`, { ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } }); if (!response.ok) throw new Error(await responseError(response, '技术方案评审请求失败')); return await response.json() as T }
async function responseError(response: Response, fallback: string) { try { const body = await response.json() as { error?: string | { message?: string } }; return typeof body.error === 'string' ? body.error : body.error?.message ?? fallback } catch { return fallback } }
