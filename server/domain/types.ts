import type { AgentExecutionEvent, InputDeliveryManifest, ReviewRunSnapshot } from './agent-types.js'
import type { CandidateRequirementPointExtraction, CandidateReviewResult } from './review-types.js'

export type AssetType = string
export type SourceType = 'upload'
export type VersionStatus = 'pending' | 'syncing' | 'ready' | 'failed' | 'deleted'
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type TaskScope = 'asset' | 'directory_recursive' | 'knowledge_base'
export type ModelHealth = 'healthy' | 'degraded' | 'unknown'
export type GenerativeProviderType = 'openai' | 'anthropic' | 'openai_compatible'
export type GenerativeCapability = 'structured_output' | 'tool_calling' | 'vision' | 'reasoning'

export interface GenerativeModel {
  id: string
  name: string
  displayName: string
  contextWindow: number
  maxOutputTokens: number
  capabilities: GenerativeCapability[]
  enabled: boolean
  health: ModelHealth
  lastCheckedAt?: string
  healthMessage?: string
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
  createdAt: string
  updatedAt: string
}

export interface McpServerResource extends AiResourceBase {
  kind: 'mcp'
  transport: 'streamable_http' | 'sse'
  endpoint: string
  authType: 'none' | 'bearer' | 'oauth2'
  toolIds: string[]
}

export interface SkillResource extends AiResourceBase {
  kind: 'skill'
  entrypoint: string
  toolIds: string[]
  tags: string[]
  package?: SkillPackageMetadata
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
  risk: 'read' | 'network_read' | 'internal_write'
  timeoutMs: number
  sourcePath?: string
  mcpServerId?: string
}

export type AiResource = McpServerResource | SkillResource | ToolResource

export type AgentConfigurationScene = 'requirement_analysis'
export type AgentConfigurationStatus = 'active' | 'superseded'
export type AgentConfigurationAgentKey = 'requirementPointExtraction' | 'requirementReview'
export interface AgentModelReference { sourceId: string; modelId: string }
export interface AgentRoutingConfiguration {
  primaryModel: AgentModelReference | null
  fallbackModels: AgentModelReference[]
  intelligentRouting: boolean
  fallbackEnabled: boolean
  temperature: number
  maxOutputTokens: number
  requestTimeoutSeconds: number
  retryCount: number
  structuredOutput: boolean
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
  agents: {
    requirementPointExtraction: AgentConfigurationAgentDraft
    requirementReview: AgentConfigurationAgentDraft
  }
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
export interface ProjectVersion { id: string; projectId: string; name: string; description?: string; status: ProjectVersionStatus; sourceProjectVersionId?: string; createdAt: string; updatedAt: string }
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
export type ReviewRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'
export interface AgentExecutionRecord {
  agentKey?: 'requirement-point-extraction' | 'requirement-review' | 'requirement-analysis'
  turns: number
  toolCalls: number
  toolErrors?: number
  framework?: { name: 'pi-agent-core'; version: string }
  events: AgentExecutionEvent[]
}
export interface ReviewRun {
  id: string
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
  extractionResult?: CandidateRequirementPointExtraction
  inputDeliveryManifest?: InputDeliveryManifest
  result?: CandidateReviewResult
  execution?: AgentExecutionRecord
  executions?: {
    requirementPointExtraction?: AgentExecutionRecord
    requirementReview?: AgentExecutionRecord
  }
  error?: string
}

export interface DatabaseState { projects: Project[]; projectVersions: ProjectVersion[]; projectVersionRequirementBindings: ProjectVersionRequirementBinding[]; knowledgeBases: KnowledgeBase[]; directories: KnowledgeDirectory[]; configs: ConfigVersion[]; assets: Asset[]; versions: AssetVersion[]; indexes: IndexVersion[]; tasks: SyncTask[]; modelSources: GenerativeModelSource[]; aiResources: AiResource[]; agentConfigurationDrafts: AgentConfigurationDraft[]; agentConfigurationVersions: AgentConfigurationVersion[]; reviewRuns: ReviewRun[] }

export const defaultConfig: KnowledgeConfig = {
  encoding: 'utf-8',
  parserVersion: 'markdown-v2', preprocessVersion: 'normalize-v1', chunkTargetSize: 400, chunkMaxSize: 480, chunkOverlap: 50, headingDepth: 4,
  embeddingSourceId: 'local-default',
  embeddingSources: [{ id: 'local-default', name: '本地模型', type: 'local', baseUrl: '', apiKey: '', models: [{ name: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', dimensions: 384 }] }],
  embeddingMode: 'local', embeddingBaseUrl: '', embeddingApiKey: '', embeddingModel: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', embeddingDimensions: 384, embeddingBatchSize: 32, embeddingTimeoutMs: 30000, embeddingRetries: 2,
  keywordRecall: 40, vectorRecall: 40, finalResults: 8, relevanceThreshold: 0.05, hybridSearch: true, rerankerEnabled: true, rerankerSourceId: 'local-default', rerankerModel: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
}
