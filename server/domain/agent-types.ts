import type { CandidateReviewResult } from './review-types.js'

export interface AgentExecutionLimits {
  maxTurns: number
  maxToolCalls: number
  deadlineMs: number
  toolTimeoutMs: number
  maxCandidateBytes: number
  maxFindings: number
  maxRepeatedToolCall: number
}

export interface AgentDefinitionVersion {
  agentKey: 'requirement-analysis'
  agentType: 'requirement_analysis'
  version: string
  status: 'published'
  modelScene: 'requirement_analysis'
  resultSchemaVersion: 'review-result/v2'
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
  modelRef: { sourceId: string; modelId: string; providerType: 'openai' | 'anthropic' | 'openai_compatible'; modelName: string; contextWindow: number; maxOutputTokens: number }
  focusAreas: string[]
  excludedAreas: string[]
  agentDefinition: AgentDefinitionVersion
  createdAt: string
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
}

export interface AgentExecutionEvent {
  sequence: number
  type: string
  occurredAt: string
  turn?: number
  toolId?: string
  toolCallId?: string
  isError?: boolean
}

export interface AgentExecutionInput {
  snapshot: ReviewRunSnapshot
  model: AgentModelConnection
  onEvent?: (event: AgentExecutionEvent) => void | Promise<void>
}

export interface AgentExecutionOutput {
  candidate: CandidateReviewResult
  events: AgentExecutionEvent[]
  turns: number
  toolCalls: number
  framework: { name: 'pi-agent-core'; version: string }
}

export interface AgentRuntime {
  execute(input: AgentExecutionInput, signal: AbortSignal): Promise<AgentExecutionOutput>
}
