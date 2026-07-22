export type AssetType = string
export type SourceType = 'upload'
export type VersionStatus = 'pending' | 'syncing' | 'ready' | 'failed' | 'deleted'
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type TaskScope = 'asset' | 'directory_recursive' | 'knowledge_base'

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
export interface KnowledgeBase { id: string; projectId: string; name: string; createdAt: string; activeIndexVersionId: string | null; activeConfigVersionId: string }
export interface KnowledgeDirectory { id: string; knowledgeBaseId: string; name: string; parentId: string | null; createdAt: string; updatedAt: string; operationTaskId?: string }
export interface ConfigVersion { id: string; knowledgeBaseId: string; version: number; config: KnowledgeConfig; createdAt: string; compatibilityFingerprint: string; requiresRebuild: boolean }
export interface Asset { id: string; knowledgeBaseId: string; displayName: string; logicalPath: string; assetType: AssetType; sourceType: SourceType; sourceKey: string; activeVersionId: string | null; createdAt: string; updatedAt: string; operationTaskId?: string }
export interface AssetVersion { id: string; assetId: string; number: number; content: string; contentHash: string; status: VersionStatus; configVersionId: string; createdAt: string; readyAt?: string; error?: string; storagePath?: string; snapshotPath?: string; chunks: Chunk[] }
export interface Chunk { id: string; chunkKey: string; assetVersionId: string; ordinal: number; headingPath: string[]; content: string; contentHash: string; tokenCount: number; startLine: number; endLine: number; startChar: number; endChar: number; embedding: number[]; reused: boolean }
export interface IndexVersion { id: string; knowledgeBaseId: string; number: number; status: 'candidate' | 'active' | 'superseded' | 'failed'; assetVersionIds: string[]; configVersionId: string; indexedChunks?: Chunk[]; createdAt: string; activatedAt?: string }
export interface SyncTask { id: string; knowledgeBaseId: string; type: 'sync' | 'rebuild' | 'delete'; trigger: 'upload' | 'manual' | 'retry'; status: TaskStatus; step: string; progress: number; attempts: number; input: Record<string, unknown>; configVersionId: string; createdAt: string; updatedAt?: string; availableAt?: string; maxAttempts?: number; dedupeKey?: string; scope?: TaskScope; targetId?: string; leaseOwner?: string; runToken?: string; leaseExpiresAt?: string; heartbeatAt?: string; cancelRequestedAt?: string; startedAt?: string; finishedAt?: string; error?: string; metrics?: Record<string, number> }

export interface DatabaseState { projects: Project[]; knowledgeBases: KnowledgeBase[]; directories: KnowledgeDirectory[]; configs: ConfigVersion[]; assets: Asset[]; versions: AssetVersion[]; indexes: IndexVersion[]; tasks: SyncTask[] }

export const defaultConfig: KnowledgeConfig = {
  encoding: 'utf-8',
  parserVersion: 'markdown-v2', preprocessVersion: 'normalize-v1', chunkTargetSize: 400, chunkMaxSize: 480, chunkOverlap: 50, headingDepth: 4,
  embeddingSourceId: 'local-default',
  embeddingSources: [{ id: 'local-default', name: '本地模型', type: 'local', baseUrl: '', apiKey: '', models: [{ name: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', dimensions: 384 }] }],
  embeddingMode: 'local', embeddingBaseUrl: '', embeddingApiKey: '', embeddingModel: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', embeddingDimensions: 384, embeddingBatchSize: 32, embeddingTimeoutMs: 30000, embeddingRetries: 2,
  keywordRecall: 40, vectorRecall: 40, finalResults: 8, relevanceThreshold: 0.05, hybridSearch: true, rerankerEnabled: true, rerankerSourceId: 'local-default', rerankerModel: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
}
