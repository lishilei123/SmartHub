import type { AgentExecutionEvent, InputDeliveryManifest, PlanningSubAgentRunRecord, ReviewRunSnapshot } from './agent-types.js'

export type AssetType = string
export type SourceType = 'upload'
export type VersionStatus = 'pending' | 'syncing' | 'ready' | 'failed' | 'deleted'
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type TaskScope = 'asset' | 'directory_recursive' | 'knowledge_base'
export type ModelHealth = 'healthy' | 'degraded' | 'unknown'
export type GenerativeProviderType = 'openai' | 'anthropic' | 'openai_compatible'
export type GenerativeCapability = 'tool_calling' | 'vision' | 'reasoning'

export interface GenerativeModel {
  id: string
  name: string
  displayName: string
  capabilities: GenerativeCapability[]
  enabled: boolean
  health: ModelHealth
  lastCheckedAt?: string
  healthMessage?: string
  qualityGate?: {
    version: 'model-probe/v2'
    checkedAt: string
    passed: boolean
    sampleSha256: string
    inputCharacters: number
    checks: { connectivity: boolean; longContext: boolean; structuredSubmission: boolean; toolCalling: boolean }
    failureSummary?: string
  }
}

export interface GenerativeModelSource {
  id: string
  name: string
  providerType: GenerativeProviderType
  baseUrl: string
  apiKey: string
  hasApiKey?: boolean
  enabled: boolean
  health: ModelHealth
  priority: number
  models: GenerativeModel[]
  createdAt: string
  updatedAt: string
  lastCheckedAt?: string
  healthMessage?: string
}

export type AiResourceKind = 'mcp' | 'skill' | 'tool'
export type AiResourceStatus = 'ready' | 'draft'

interface AiResourceBase {
  id: string
  key: string
  name: string
  description: string
  version: string
  enabled: boolean
  status: AiResourceStatus
  builtIn: boolean
  managedBy?: 'builtin' | 'catalog' | 'filesystem'
  createdAt: string
  updatedAt: string
}

export interface McpServerResource extends AiResourceBase {
  kind: 'mcp'
  transport: 'streamable_http' | 'sse'
  endpoint: string
  authType: 'none' | 'bearer' | 'oauth2'
  credentialEnv?: string
  toolIds: string[]
}

export interface SkillResource extends AiResourceBase {
  kind: 'skill'
  entrypoint: string
  toolIds: string[]
  tags: string[]
  runtime?: SkillRuntimePolicy
  package?: SkillPackageMetadata
  contentSha256?: string
}

export interface SkillRuntimePolicy {
  scripts: Array<{
    path: string
    runner: 'powershell'
    timeoutMs: number
  }>
  network?: {
    allowedOrigins: string[]
    allowedMethods: Array<'GET' | 'HEAD'>
    timeoutMs: number
  }
}

export interface SkillPackageMetadata {
  storageKey: string
  entrypointPath: string
  uploadedFileName: string
  archiveSha256: string
  contentSha256: string
  fileCount: number
  unpackedBytes: number
  files: string[]
}

export interface ToolResource extends AiResourceBase {
  kind: 'tool'
  source: 'builtin' | 'local' | 'http' | 'mcp'
  risk: 'read' | 'network_read' | 'code_execution' | 'internal_write' | 'write_reversible' | 'write_high_risk'
  timeoutMs: number
  sourcePath?: string
  mcpServerId?: string
  endpoint?: string
  authType?: 'none' | 'bearer'
  credentialEnv?: string
  parameters?: Record<string, unknown>
  contentSha256?: string
}

export type AiResource = McpServerResource | SkillResource | ToolResource

export type AgentConfigurationScene = 'planning' | 'test_execution'
export type AgentConfigurationStatus = 'active' | 'superseded'
export type AgentConfigurationAgentKey =
  | 'planning'
  | 'testScript'
  | 'failureAnalysis'
  | 'scriptRepair'
export interface AgentModelReference { sourceId: string; modelId: string }
export interface AgentRoutingConfiguration {
  primaryModel: AgentModelReference | null
  fallbackModels: AgentModelReference[]
  intelligentRouting: boolean
  fallbackEnabled: boolean
  contextWindow: number
  maxOutputTokens: number
  requestTimeoutSeconds: number
  retryCount: number
}
export interface AgentDefinitionDraft {
  systemPrompt: string
  taskTemplate: string
  skillKeys: string[]
  mcpServerKeys: string[]
  toolIds: string[]
  limits: import('./agent-types.js').AgentExecutionLimits
}
export interface AgentConfigurationAgentDraft {
  revision: number
  routing: AgentRoutingConfiguration
  definition: AgentDefinitionDraft
  updatedAt: string
}
export interface AgentConfigurationDraft {
  scene: AgentConfigurationScene
  agents: Partial<Record<AgentConfigurationAgentKey, AgentConfigurationAgentDraft>>
}
export interface AgentConfigurationVersion {
  id: string
  scene: AgentConfigurationScene
  agentKey: AgentConfigurationAgentKey
  version: number
  status: AgentConfigurationStatus
  routing: AgentRoutingConfiguration
  agentDefinition: import('./agent-types.js').AgentDefinitionVersion
  contentSha256: string
  createdAt: string
  publishedBy: string
}

export interface TestExecutionEnvironmentProfile {
  environmentId: string
  name: string
  baseUrl: string
  targets: Array<{ protocol: 'http' | 'https'; host: string; port: number }>
  networkName: string
  /** Runner-visible name -> server process environment-variable name. */
  secretEnvironmentVariables?: Readonly<Record<string, string>>
}

export interface TestExecutionRunnerConfiguration {
  containerRuntime: 'docker' | 'podman'
  runnerVersion: string
  playwrightVersion: string
  imageReference: string
  imageDigest: string
  entrypoint?: string
  workingRoot?: string
}

/** Server-owned immutable release of runner and environment configuration. */
export interface TestExecutionInfrastructureConfigurationVersion {
  id: string
  version: number
  status: 'active' | 'superseded'
  environments: TestExecutionEnvironmentProfile[]
  runner?: TestExecutionRunnerConfiguration
  contentSha256: string
  createdAt: string
  publishedBy: string
}

export interface EmbeddingSourceModel {
  name: string
  dimensions: number
}

export interface EmbeddingSource {
  id: string
  name: string
  type: 'remote_api' | 'local'
  baseUrl: string
  apiKey: string
  models: EmbeddingSourceModel[]
}

export interface KnowledgeConfig {
  encoding: 'utf-8'
  parserVersion: string
  preprocessVersion: string
  chunkTargetSize: number
  chunkMaxSize: number
  chunkOverlap: number
  headingDepth: number
  embeddingSourceId: string
  embeddingSources: EmbeddingSource[]
  embeddingMode: 'remote_api' | 'local'
  embeddingBaseUrl: string
  embeddingApiKey: string
  embeddingModel: string
  embeddingDimensions: number
  embeddingBatchSize: number
  embeddingTimeoutMs: number
  embeddingRetries: number
  keywordRecall: number
  vectorRecall: number
  finalResults: number
  relevanceThreshold: number
  hybridSearch: boolean
  rerankerEnabled: boolean
  rerankerSourceId: string
  rerankerModel: string
}

export interface Project { id: string; name: string; createdAt: string }
export type ProjectVersionStatus = 'open' | 'locked' | 'archived'
export interface RequirementReleaseBinding {
  releaseId: string
  verificationRunId: string
  releaseContentSha256: string
  boundAt: string
}
export interface ProjectVersion {
  id: string
  projectId: string
  name: string
  description?: string
  status: ProjectVersionStatus
  sourceProjectVersionId?: string
  /** 创建版本时由用户明确提交；后续 Requirement Binding 变化不得改写该意图。 */
  inheritRequirementBindings: boolean
  /** 当前默认的 Requirement Release。 */
  requirementReleaseBinding?: RequirementReleaseBinding
  /** 当前 ProjectVersion 的全部已发布 Requirement Release 绑定，按 boundAt 保留历史。 */
  requirementReleaseBindings?: RequirementReleaseBinding[]
  /** requirementReleaseBindings 中当前默认使用的 Release ID。 */
  activeRequirementReleaseId?: string
  createdAt: string
  updatedAt: string
}
export interface ProjectVersionRequirementBinding { id: string; projectVersionId: string; assetId: string; assetVersionId: string; createdAt: string }
export interface KnowledgeBase { id: string; projectId: string; name: string; createdAt: string; activeIndexVersionId: string | null; activeConfigVersionId: string }
export interface KnowledgeDirectory { id: string; knowledgeBaseId: string; name: string; parentId: string | null; createdAt: string; updatedAt: string; operationTaskId?: string }
export interface ConfigVersion { id: string; knowledgeBaseId: string; version: number; config: KnowledgeConfig; createdAt: string; compatibilityFingerprint: string; requiresRebuild: boolean }
export interface Asset { id: string; knowledgeBaseId: string; displayName: string; logicalPath: string; assetType: AssetType; sourceType: SourceType; sourceKey: string; activeVersionId: string | null; createdAt: string; updatedAt: string; operationTaskId?: string }
export interface AssetVersion { id: string; assetId: string; number: number; content: string; contentHash: string; status: VersionStatus; configVersionId: string; createdAt: string; readyAt?: string; error?: string; storagePath?: string; snapshotPath?: string; chunks: Chunk[] }
export interface Chunk { id: string; chunkKey: string; assetVersionId: string; ordinal: number; headingPath: string[]; content: string; contentHash: string; tokenCount: number; startLine: number; endLine: number; startChar: number; endChar: number; embedding: number[]; reused: boolean }
export interface IndexAssetMetadata { assetId: string; displayName: string; assetType: AssetType; sourceType: SourceType; logicalPath: string }
export interface IndexChunk extends Chunk { assetMetadata: IndexAssetMetadata }
export interface IndexVersion { id: string; knowledgeBaseId: string; number: number; status: 'candidate' | 'active' | 'superseded' | 'failed'; assetVersionIds: string[]; configVersionId: string; indexedChunks?: IndexChunk[]; createdAt: string; activatedAt?: string }
export interface SyncTask { id: string; knowledgeBaseId: string; type: 'sync' | 'rebuild' | 'delete'; trigger: 'upload' | 'manual' | 'retry'; status: TaskStatus; step: string; progress: number; attempts: number; input: Record<string, unknown>; configVersionId: string; createdAt: string; updatedAt?: string; availableAt?: string; maxAttempts?: number; dedupeKey?: string; scope?: TaskScope; targetId?: string; leaseOwner?: string; runToken?: string; leaseExpiresAt?: string; heartbeatAt?: string; cancelRequestedAt?: string; startedAt?: string; finishedAt?: string; error?: string; metrics?: Record<string, number> }
export type ReviewRunStatus = 'running' | 'waiting_clarification' | 'succeeded' | 'failed' | 'cancelled'
export type ReviewRunQueueStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export interface ReviewRunQueueState {
  status: ReviewRunQueueStatus
  attempts: number
  maxAttempts: number
  availableAt: string
  error?: string
}
export interface ReviewRunRetryEvent {
  attempt: number
  maxAttempts: number
  agentKey?: 'planning'
  status: 'scheduled' | 'exhausted'
  error: string
  occurredAt: string
  nextAttemptAt?: string
}
export type FindingState = 'open' | 'confirmed' | 'dismissed' | 'resolved' | 'needs_follow_up'
export type FindingActionType = 'confirm' | 'dismiss' | 'resolve' | 'request_follow_up' | 'reopen'
export interface FindingAction {
  id: string
  projectVersionId: string
  runId: string
  findingId: string
  action: FindingActionType
  fromState: FindingState
  toState: FindingState
  comment?: string
  actorId: string
  actorDisplayName: string
  version: number
  createdAt: string
}
export interface ToolApproval {
  id: string
  projectVersionId: string
  runId: string
  toolId: string
  toolVersion: string
  risk: 'write_reversible' | 'write_high_risk'
  parameterSummary: string
  parameterHash: string
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled'
  requestedAt: string
  expiresAt: string
  requestedBy: string
  decidedAt?: string
  decidedBy?: string
  decidedByDisplayName?: string
  decisionComment?: string
  consumedAt?: string
}
export interface AgentExecutionRecord {
  agentKey?: 'planning' | 'test-script' | 'failure-analysis' | 'script-repair'
  turns: number
  toolCalls: number
  toolErrors?: number
  framework?: { name: 'pi-agent-core' | 'pi-coding-agent'; version: string }
  workflowStage?: import('./requirement-workflow-types.js').RequirementWorkflowStage | 'test_case_design' | 'test_design_repair' | 'script_generation' | 'failure_diagnosis' | 'script_repair'
  context?: import('./agent-types.js').AgentExecutionContext
  events: AgentExecutionEvent[]
}
export interface ReviewRunStageExecutions {
  planning?: AgentExecutionRecord
}
export interface ReviewRunExecutionAttempt {
  attempt: number
  maxAttempts: number
  activeAgentKey?: 'planning'
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  startedAt: string
  finishedAt?: string
  modelLabel: string
  error?: string
  executions: ReviewRunStageExecutions
}
export interface ReviewRun {
  id: string
  reviewId?: string
  retryOfRunId?: string
  retryMode?: 'full'
  projectVersionId: string
  assetId: string
  assetVersionId: string
  documentTitle: string
  documentVersion: number
  logicalPath: string
  sourceId: string
  modelId: string
  modelLabel: string
  status: ReviewRunStatus
  step: string
  progress: number
  createdAt: string
  startedAt: string
  finishedAt?: string
  snapshot: ReviewRunSnapshot
  workflow?: import('./requirement-workflow-types.js').RequirementWorkflowState
  inputDeliveryManifest?: InputDeliveryManifest
  result?: import('./review-types.js').RequirementAnalysisResult
  execution?: AgentExecutionRecord
  executions?: ReviewRunStageExecutions
  executionAttempts?: ReviewRunExecutionAttempt[]
  queue?: ReviewRunQueueState
  retryEvents?: ReviewRunRetryEvent[]
  planningSubAgentRuns?: PlanningSubAgentRunRecord[]
  modelRouteAttempts?: Array<{
    id: string
    agentKey: 'planning'
    sourceId: string
    modelId: string
    modelLabel: string
    status: 'running' | 'succeeded' | 'failed' | 'cancelled'
    startedAt: string
    finishedAt?: string
    error?: string
  }>
  degradations?: Array<{
    agentKey: 'planning'
    fromSourceId: string
    fromModelId: string
    toSourceId: string
    toModelId: string
    reason: string
    occurredAt: string
  }>
  error?: string
}

export interface DatabaseState { projects: Project[]; projectVersions: ProjectVersion[]; projectVersionRequirementBindings: ProjectVersionRequirementBinding[]; knowledgeBases: KnowledgeBase[]; directories: KnowledgeDirectory[]; configs: ConfigVersion[]; assets: Asset[]; versions: AssetVersion[]; indexes: IndexVersion[]; tasks: SyncTask[]; modelSources: GenerativeModelSource[]; aiResources: AiResource[]; agentConfigurationDrafts: AgentConfigurationDraft[]; agentConfigurationVersions: AgentConfigurationVersion[]; testExecutionInfrastructureConfigurationVersions: TestExecutionInfrastructureConfigurationVersion[]; reviewRuns: ReviewRun[]; findingActions: FindingAction[]; toolApprovals: ToolApproval[]; testDesignState?: import('./test-design-types.js').TestDesignState }

export const defaultConfig: KnowledgeConfig = {
  encoding: 'utf-8',
  parserVersion: 'markdown-v2', preprocessVersion: 'normalize-v1', chunkTargetSize: 400, chunkMaxSize: 480, chunkOverlap: 50, headingDepth: 4,
  embeddingSourceId: 'local-default',
  embeddingSources: [{ id: 'local-default', name: '本地模型', type: 'local', baseUrl: '', apiKey: '', models: [{ name: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', dimensions: 384 }] }],
  embeddingMode: 'local', embeddingBaseUrl: '', embeddingApiKey: '', embeddingModel: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', embeddingDimensions: 384, embeddingBatchSize: 32, embeddingTimeoutMs: 30000, embeddingRetries: 2,
  keywordRecall: 40, vectorRecall: 40, finalResults: 8, relevanceThreshold: 0.05, hybridSearch: true, rerankerEnabled: true, rerankerSourceId: 'local-default', rerankerModel: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
}
