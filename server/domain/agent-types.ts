import type { AgentCandidateResult, CandidateRequirementPointExtraction } from './review-types.js'

export type AgentReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type RequirementInputMode = 'full_context' | 'segmented_context'

export interface AgentExecutionLimits {
  maxTurns: number
  maxToolCalls: number
  deadlineMs: number
  toolTimeoutMs: number
  maxCandidateBytes: number
  maxFindings: number
  maxRepeatedToolCall: number
  reasoningEffort?: AgentReasoningEffort
  reservedOutputTokens?: number
  correctionReserveTokens?: number
}

export interface AgentDefinitionVersion {
  agentKey: 'requirement-point-extraction' | 'requirement-review'
  agentType: 'requirement_point_extraction' | 'requirement_review'
  version: string
  status: 'published'
  modelScene: 'requirement_analysis'
  resultSchemaVersion: 'requirement-point-extraction/v1' | 'requirement-point-extraction/v2' | 'requirement-review/v2'
  systemPrompt: string
  taskTemplate: string
  promptRef: { promptKey: string; version: string; contentSha256: string }
  toolsetVersion: string
  toolsetContentSha256: string
  skillBindings: Array<{ skillKey: string; version: string; enabled: boolean; configurationHash: string }>
  mcpBindings: Array<{ serverKey: string; version: string; enabled: boolean; toolIds: string[]; policyHash: string }>
  toolIds: string[]
  limits: AgentExecutionLimits
  contentSha256: string
}

export interface AgentDefinitionResolver {
  resolve(agentKey: AgentDefinitionVersion['agentKey']): AgentDefinitionVersion | Promise<AgentDefinitionVersion>
}

export interface ReviewRunSnapshot {
  runId: string
  projectId: string
  projectName: string
  projectVersionId: string
  projectVersionName: string
  knowledgeBaseId: string
  assetId: string
  assetVersionId: string
  assetContentHash: string
  indexVersionId: string
  logicalPath: string
  assets: Array<{ assetId: string; assetVersionId: string; assetContentHash: string; logicalPath: string; displayName: string }>
  modelRef: { sourceId: string; modelId: string; providerType: 'openai' | 'anthropic' | 'openai_compatible'; modelName: string; contextWindow: number; maxOutputTokens: number; supportsReasoning: boolean }
  focusAreas: string[]
  excludedAreas: string[]
  agentDefinition: AgentDefinitionVersion
  agentDefinitions: {
    requirementPointExtraction: AgentDefinitionVersion
    requirementReview: AgentDefinitionVersion
  }
  extractionCoveragePlan: Array<{
    assetVersionId: string
    chunks: Array<{ chunkId: string; contentHash: string; headingPath: string[]; startLine: number; endLine: number; excludedReason?: string }>
  }>
  extractionToolBudget: { directoryCalls: number; chunkCalls: number; evidenceCalls: number; submissionCalls: number; minimumToolCalls: number }
  extractionInput: {
    policyVersion: string
    mode: RequirementInputMode
    estimatedInputTokens: number
    safeInputBudget: number
    packageSha256: string
    batches: Array<{ batchId: string; ordinal: number; tokenCount: number; contentSha256: string; assetVersionIds: string[]; chunkIds: string[] }>
  }
  createdAt: string
}

export interface RequirementInputBatch {
  batchId: string
  ordinal: number
  tokenCount: number
  assetVersionIds: string[]
  chunkIds: string[]
  content: string
}

export interface RequirementInputPlan {
  policyVersion: string
  mode: RequirementInputMode
  estimatedInputTokens: number
  safeInputBudget: number
  packageSha256: string
  batches: RequirementInputBatch[]
}

export interface InputDeliveryManifestEntry {
  batchId: string
  ordinal: number
  assetVersionIds: string[]
  chunkIds: string[]
  contentSha256: string
  tokenCount: number
  modelCallSequence: number
}

export interface InputDeliveryManifest {
  policyVersion: string
  mode: RequirementInputMode
  packageSha256: string
  entries: InputDeliveryManifestEntry[]
  finalMergeCompleted: boolean
}

export interface AgentModelConnection {
  sourceId: string
  providerType: 'openai' | 'anthropic' | 'openai_compatible'
  baseUrl: string
  apiKey: string
  modelId: string
  modelName: string
  contextWindow: number
  maxOutputTokens: number
  supportsReasoning: boolean
}

export interface AgentExecutionEvent {
  sequence: number
  type: string
  occurredAt: string
  turn?: number
  toolId?: string
  toolCallId?: string
  isError?: boolean
  role?: 'user' | 'assistant' | 'tool'
  content?: string
  toolCalls?: Array<{ id: string; name: string }>
  toolArguments?: unknown
  toolResult?: unknown
  stopReason?: string
  model?: string
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }
  framework?: { name: 'pi-agent-core'; version: string }
}

export interface AgentExecutionInput {
  snapshot: ReviewRunSnapshot
  model: AgentModelConnection
  fixedRequirementPointExtraction?: CandidateRequirementPointExtraction
  requirementInputPlan?: RequirementInputPlan
  onEvent?: (event: AgentExecutionEvent) => void | Promise<void>
}

export interface AgentExecutionOutput {
  candidate: AgentCandidateResult
  events: AgentExecutionEvent[]
  turns: number
  toolCalls: number
  toolErrors: number
  framework: { name: 'pi-agent-core'; version: string }
  inputDeliveryManifest?: InputDeliveryManifest
}

export interface AgentRuntime {
  execute(input: AgentExecutionInput, signal: AbortSignal): Promise<AgentExecutionOutput>
}
