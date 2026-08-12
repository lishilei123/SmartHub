import type { AgentCandidateResult } from './review-types.js'

export type AgentReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type RequirementInputMode = 'full_context' | 'segmented_context' | 'agent_directory'

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
  agentKey: 'requirement-analysis' | 'test-design'
  agentType: 'requirement_analysis' | 'test_design'
  version: string
  status: 'published'
  modelScene: 'requirement_analysis' | 'test_design'
  resultSchemaVersion: 'requirement-analysis/v1' | 'test-design/v1'
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
  resolveActive?(agentKey: AgentDefinitionVersion['agentKey']): import('./types.js').AgentConfigurationVersion | null | Promise<import('./types.js').AgentConfigurationVersion | null>
  resolveVersion?(id: string): import('./types.js').AgentConfigurationVersion | Promise<import('./types.js').AgentConfigurationVersion>
}

export interface ReviewRunSnapshot {
  runId: string
  reviewId?: string
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
  assets: Array<{ assetId: string; assetVersionId: string; assetContentHash: string; logicalPath: string; displayName: string; assetType?: string }>
  documentWorkspace?: {
    mode: 'agent_directory'
    logicalPath: string
    rootLogicalPath?: string
    activeBranchLogicalPath?: string
    branchLogicalPaths?: string[]
    agentLogicalPath?: string
    layoutVersion?: 'workspace/v1'
    candidateAssetVersionIds: string[]
  }
  modelRef: { sourceId: string; modelId: string; providerType: 'openai' | 'anthropic' | 'openai_compatible'; modelName: string; contextWindow: number; maxOutputTokens: number; supportsReasoning: boolean }
  agentConfigurationRef?: { id: string; version: number; contentSha256: string }
  focusAreas: string[]
  excludedAreas: string[]
  agentDefinition: AgentDefinitionVersion
  analysisCoveragePlan: Array<{
    assetVersionId: string
    chunks: Array<{ chunkId: string; contentHash: string; headingPath: string[]; startLine: number; endLine: number; excludedReason?: string }>
  }>
  analysisToolBudget: { directoryCalls: number; chunkCalls: number; knowledgeCalls: number; submissionCalls: number; minimumToolCalls: number }
  analysisInput: {
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
  toolReads?: Array<{
    toolCallId: string
    toolId: 'workspace.read_file'
    relativePath: string
    assetVersionIds: string[]
    chunkIds: string[]
    startLine: number
    endLine: number
  }>
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
  requestTimeoutMs?: number
  retryCount?: number
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
  snapshot: ReviewRunSnapshot | TestDesignAgentSnapshot
  model: AgentModelConnection
  requirementInputPlan?: RequirementInputPlan
  executionProfile?: {
    mode: 'workspace_tools'
    workflowStage: 'analysis' | 'repair' | 'verification' | 'release' | 'test_point_design' | 'test_case_design' | 'test_design_repair'
    allowedSkillKeys: string[]
    submitToolId: string
    schemaVersion: string
    agentLabel: string
    initialTask: string
    validateCandidate: (candidate: Record<string, unknown>, manifest: InputDeliveryManifest) => Promise<{ valid: boolean; result?: AgentCandidateResult | Record<string, unknown>; issues: Array<{ path: string; message: string }> }>
  }
  onEvent?: (event: AgentExecutionEvent) => void | Promise<void>
}

export interface AgentExecutionOutput {
  candidate: AgentCandidateResult | Record<string, unknown>
  events: AgentExecutionEvent[]
  turns: number
  toolCalls: number
  toolErrors: number
  framework: { name: 'pi-agent-core'; version: string }
  inputDeliveryManifest?: InputDeliveryManifest
}

export interface TestDesignAgentSnapshot {
  runId: string
  projectId: string
  projectName: string
  projectVersionId: string
  projectVersionName: string
  knowledgeBaseId: string
  indexVersionId: string
  assets: Array<{ assetId: string; assetVersionId: string; assetContentHash: string; logicalPath: string; displayName: string; assetType?: string }>
  documentWorkspace: NonNullable<ReviewRunSnapshot['documentWorkspace']>
  workspaceFiles: import('./test-design-types.js').TestDesignWorkspaceFile[]
  agentDefinition: AgentDefinitionVersion
  taskSha256: string
  createdAt: string
}

export interface AgentRuntime {
  execute(input: AgentExecutionInput, signal: AbortSignal): Promise<AgentExecutionOutput>
}
