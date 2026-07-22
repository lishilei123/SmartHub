import { extname, isAbsolute } from 'node:path'
import { defaultConfig, type AssetType, type AssetVersion, type Chunk, type DatabaseState, type EmbeddingSource, type IndexAssetMetadata, type IndexChunk, type KnowledgeConfig, type SourceType, type SyncTask } from '../domain/types.js'
import type { StateStore, TaskLease } from '../infrastructure/store.js'
import { RawDocumentStore } from '../infrastructure/raw-document-store.js'
import type { LocalModelRuntime } from '../infrastructure/local-model-runtime.js'
import { RemoteEmbeddingClient, type ResolvedEmbeddingRoute } from '../infrastructure/remote-embedding-client.js'
import type { StoredChunkCandidate } from '../infrastructure/store.js'
import { chunkDocument, cosine, defaultTokenCodec, embedding, sha256, type TokenCodec } from './content.js'

type RetrievalInput = { logicalPath?: string }
type RankedCandidate = { candidate: StoredChunkCandidate; keywordScore: number; vectorScore: number; rerankerScore?: number; score: number }

const now = () => new Date().toISOString()
const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`
const compatibilityFingerprint = (config: KnowledgeConfig) => sha256(JSON.stringify({ parserVersion: config.parserVersion, preprocessVersion: config.preprocessVersion, chunkTargetSize: config.chunkTargetSize, chunkMaxSize: config.chunkMaxSize, chunkOverlap: config.chunkOverlap, headingDepth: config.headingDepth, embeddingSourceId: config.embeddingSourceId, embeddingMode: config.embeddingMode, embeddingBaseUrl: config.embeddingBaseUrl, embeddingModel: config.embeddingModel, embeddingDimensions: config.embeddingDimensions }))
const queryFingerprint = (config: KnowledgeConfig) => sha256(JSON.stringify({ keywordRecall: config.keywordRecall, vectorRecall: config.vectorRecall, finalResults: config.finalResults, relevanceThreshold: config.relevanceThreshold, hybridSearch: config.hybridSearch, rerankerEnabled: config.rerankerEnabled, rerankerSourceId: config.rerankerSourceId, rerankerModel: config.rerankerModel, rerankerSource: config.embeddingSources.find(source => source.id === config.rerankerSourceId) }))

export class KnowledgeService {
  constructor(readonly store: StateStore, private readonly rawDocuments?: RawDocumentStore, private readonly localModels?: LocalModelRuntime, private readonly remoteEmbeddings = new RemoteEmbeddingClient()) {}
  async initialize() {
    await this.store.load()
    await this.store.transaction(state => {
      state.directories ??= []
      state.projects = state.projects.map(scrubLegacyEmbeddingSecrets)
      state.knowledgeBases = state.knowledgeBases.map(scrubLegacyEmbeddingSecrets)
      state.directories = state.directories.map(scrubLegacyEmbeddingSecrets)
      state.assets = state.assets.map(scrubLegacyEmbeddingSecrets)
      state.indexes = state.indexes.map(scrubLegacyEmbeddingSecrets)
      state.tasks = state.tasks.map(task => ({
        ...scrubLegacyEmbeddingSecrets(task),
        ...(task.error ? { error: safeErrorMessage(task.error) } : {}),
      }))
      state.versions = state.versions.map(version => ({
        ...scrubLegacyEmbeddingSecrets(version),
        ...(version.error ? { error: safeErrorMessage(version.error) } : {}),
      }))
      state.configs.forEach(item => {
        const legacy = item.config as KnowledgeConfig & Record<string, unknown>
        const legacyHashModel = !legacy.embeddingModel || legacy.embeddingModel === 'hash-embedding-v1'
        const migrated = {
          ...defaultConfig,
          ...legacy,
          embeddingMode: legacy.embeddingMode ?? 'local',
          ...(legacyHashModel ? { embeddingModel: defaultConfig.embeddingModel, embeddingDimensions: defaultConfig.embeddingDimensions, rerankerModel: defaultConfig.rerankerModel } : {}),
        }
        item.config = normalizeEmbeddingSources(migrated)
        item.compatibilityFingerprint = compatibilityFingerprint(item.config)
      })
      state.versions.forEach(version => version.chunks.forEach(chunk => { chunk.tokenCount ??= defaultTokenCodec.count(chunk.content) }))
      state.assets.forEach(asset => ensureDirectoryPath(state, asset.knowledgeBaseId, asset.logicalPath.replaceAll('\\', '/').split('/').slice(0, -1)))
      state.indexes.forEach(index => {
        index.indexedChunks?.forEach(chunk => {
          if (!chunk.assetMetadata) {
            const version = state.versions.find(item => item.id === chunk.assetVersionId)
            const asset = state.assets.find(item => item.id === version?.assetId)
            if (asset) chunk.assetMetadata = indexAssetMetadata(asset)
          }
        })
      })
    })
  }

  async recoverInterruptedTasks() {
    return this.store.transaction(state => state.tasks.filter(task => ['queued', 'running'].includes(task.status)).map(task => {
      const candidateId = typeof task.input.candidateIndexVersionId === 'string' ? task.input.candidateIndexVersionId : null
      const candidate = candidateId ? state.indexes.find(index => index.id === candidateId) : null
      if (candidate?.status === 'candidate') candidate.status = 'failed'
      delete task.input.candidateIndexVersionId
      task.status = 'queued'; task.step = 'waiting'; task.progress = 0; task.startedAt = undefined
      return task.id
    }))
  }

  async createProject(name: string) {
    if (!name.trim()) throw new Error('项目名称不能为空')
    return this.store.transaction(async state => {
      const createdAt = now(); const project = { id: id('prj'), name: name.trim(), createdAt }
      const knowledgeBaseId = id('kb'); const configId = id('cfg')
      state.projects.push(project)
      state.configs.push({ id: configId, knowledgeBaseId, version: 1, config: defaultConfig, createdAt, compatibilityFingerprint: compatibilityFingerprint(defaultConfig), requiresRebuild: false })
      state.knowledgeBases.push({ id: knowledgeBaseId, projectId: project.id, name: `${project.name} 项目知识库`, createdAt, activeIndexVersionId: null, activeConfigVersionId: configId })
      return { project, knowledgeBase: state.knowledgeBases.at(-1) }
    })
  }

  async ensureDefaultKnowledgeBase(projectName = 'SmartHub') {
    const normalizedName = projectName.trim() || 'SmartHub'
    const existing = selectDefaultKnowledgeBase(await this.store.snapshot(), normalizedName)
    if (existing) return existing
    return this.store.transaction(async state => {
      const concurrent = selectDefaultKnowledgeBase(state, normalizedName)
      if (concurrent) return concurrent
      const createdAt = now(); const project = { id: id('prj'), name: normalizedName, createdAt }
      const knowledgeBaseId = id('kb'); const configId = id('cfg')
      const knowledgeBase = { id: knowledgeBaseId, projectId: project.id, name: `${project.name} 项目知识库`, createdAt, activeIndexVersionId: null, activeConfigVersionId: configId }
      state.projects.push(project)
      state.configs.push({ id: configId, knowledgeBaseId, version: 1, config: defaultConfig, createdAt, compatibilityFingerprint: compatibilityFingerprint(defaultConfig), requiresRebuild: false })
      state.knowledgeBases.push(knowledgeBase)
      return { project, knowledgeBase }
    })
  }

  async cleanupEmptyDefaultKnowledgeBases(projectName = 'SmartHub') {
    return this.store.transaction(async state => {
      const projectIds = new Set(state.projects.filter(project => project.name === projectName).map(project => project.id))
      const knowledgeBaseIds = state.knowledgeBases.filter(knowledgeBase => projectIds.has(knowledgeBase.projectId)
        && !state.directories.some(directory => directory.knowledgeBaseId === knowledgeBase.id)
        && !state.assets.some(asset => asset.knowledgeBaseId === knowledgeBase.id)
        && !state.tasks.some(task => task.knowledgeBaseId === knowledgeBase.id)
        && !state.indexes.some(index => index.knowledgeBaseId === knowledgeBase.id)).map(knowledgeBase => knowledgeBase.id)
      const deletedKnowledgeBaseIds = new Set(knowledgeBaseIds)
      state.configs = state.configs.filter(config => !deletedKnowledgeBaseIds.has(config.knowledgeBaseId))
      state.knowledgeBases = state.knowledgeBases.filter(knowledgeBase => !deletedKnowledgeBaseIds.has(knowledgeBase.id))
      const remainingProjectIds = new Set(state.knowledgeBases.map(knowledgeBase => knowledgeBase.projectId))
      const deletedProjectIds = [...projectIds].filter(projectId => !remainingProjectIds.has(projectId))
      const deletedProjects = new Set(deletedProjectIds)
      state.projects = state.projects.filter(project => !deletedProjects.has(project.id))
      return { deletedKnowledgeBaseIds: knowledgeBaseIds, deletedProjectIds }
    })
  }

  async cleanupKnowledgeBasesExcept(keepKnowledgeBaseId: string) {
    return this.store.transaction(async state => {
      required(state.knowledgeBases.find(knowledgeBase => knowledgeBase.id === keepKnowledgeBaseId), '需要保留的知识库不存在')
      const deletedKnowledgeBaseIds = state.knowledgeBases.filter(knowledgeBase => knowledgeBase.id !== keepKnowledgeBaseId).map(knowledgeBase => knowledgeBase.id)
      const deletedKnowledgeBases = new Set(deletedKnowledgeBaseIds)
      const deletedAssetIds = new Set(state.assets.filter(asset => deletedKnowledgeBases.has(asset.knowledgeBaseId)).map(asset => asset.id))
      state.directories = state.directories.filter(directory => !deletedKnowledgeBases.has(directory.knowledgeBaseId))
      state.configs = state.configs.filter(config => !deletedKnowledgeBases.has(config.knowledgeBaseId))
      state.assets = state.assets.filter(asset => !deletedKnowledgeBases.has(asset.knowledgeBaseId))
      state.versions = state.versions.filter(version => !deletedAssetIds.has(version.assetId))
      state.indexes = state.indexes.filter(index => !deletedKnowledgeBases.has(index.knowledgeBaseId))
      state.tasks = state.tasks.filter(task => !deletedKnowledgeBases.has(task.knowledgeBaseId))
      state.knowledgeBases = state.knowledgeBases.filter(knowledgeBase => knowledgeBase.id === keepKnowledgeBaseId)
      const remainingProjectIds = new Set(state.knowledgeBases.map(knowledgeBase => knowledgeBase.projectId))
      const deletedProjectIds = state.projects.filter(project => !remainingProjectIds.has(project.id)).map(project => project.id)
      state.projects = state.projects.filter(project => remainingProjectIds.has(project.id))
      return { deletedKnowledgeBaseIds, deletedProjectIds }
    })
  }

  async overview(knowledgeBaseId: string) {
    const state = await this.store.snapshot(); const kb = required(state.knowledgeBases.find(item => item.id === knowledgeBaseId), '知识库不存在')
    const assets = state.assets.filter(item => item.knowledgeBaseId === knowledgeBaseId)
    const versions = state.versions.filter(item => assets.some(asset => asset.id === item.assetId))
    const tasks = state.tasks.filter(item => item.knowledgeBaseId === knowledgeBaseId)
    const activeIndex = state.indexes.find(item => item.id === kb.activeIndexVersionId) ?? null
    const indexConfig = activeIndex ? required(state.configs.find(item => item.id === activeIndex.configVersionId), '活动索引配置不存在').config : null
    const hnswReady = activeIndex && indexConfig && this.store.isVectorIndexReady
      ? await this.store.isVectorIndexReady(activeIndex.id, indexConfig.embeddingDimensions)
      : null
    const candidateTask = [...tasks].reverse().find(task => ['queued', 'running'].includes(task.status) && typeof task.input.candidateIndexVersionId === 'string') ?? null
    const candidateIndex = candidateTask ? state.indexes.find(index => index.id === candidateTask.input.candidateIndexVersionId) ?? null : null
    const countBy = (key: 'assetType' | 'sourceType') => Object.fromEntries([...new Set(assets.map(item => item[key]))].map(value => [value, assets.filter(item => item[key] === value).length]))
    return {
      knowledgeBase: kb,
      counts: { assets: assets.length, ready: versions.filter(item => item.status === 'ready').length, syncing: versions.filter(item => item.status === 'syncing' || item.status === 'pending').length, failed: versions.filter(item => item.status === 'failed').length },
      byAssetType: countBy('assetType'), bySource: countBy('sourceType'), activeIndex, latestTask: tasks.at(-1) ?? null, latestFailure: tasks.filter(item => item.status === 'failed').at(-1) ?? null,
      indexSummary: activeIndex && indexConfig ? { id: activeIndex.id, number: activeIndex.number, dimensions: indexConfig.embeddingDimensions, chunks: activeIndex.indexedChunks?.length ?? 0, hnswReady } : null,
      candidateSummary: candidateTask ? { task: taskSummary(candidateTask), index: candidateIndex ? { id: candidateIndex.id, number: candidateIndex.number, chunks: candidateIndex.indexedChunks?.length ?? 0 } : null } : null,
    }
  }

  async config(knowledgeBaseId: string) {
    const state = await this.store.snapshot(); const kb = required(state.knowledgeBases.find(item => item.id === knowledgeBaseId), '知识库不存在')
    const version = required(state.configs.find(item => item.id === kb.activeConfigVersionId), '配置不存在')
    return { ...version, config: redactConfig(normalizeEmbeddingSources(version.config)) }
  }

  async saveConfig(knowledgeBaseId: string, patch: Partial<KnowledgeConfig>) {
    return this.store.transaction(async state => {
      const kb = required(state.knowledgeBases.find(item => item.id === knowledgeBaseId), '知识库不存在')
      const current = required(state.configs.find(item => item.id === kb.activeConfigVersionId), '配置不存在')
      const config = normalizeEmbeddingSources(mergeConfigPatch(current.config, patch))
      validateConfig(config)
      if (JSON.stringify(config) === JSON.stringify(current.config)) return { changed: false, configVersion: { ...current, config: redactConfig(current.config) }, impact: 'none' }
      const compatible = compatibilityFingerprint(config) === current.compatibilityFingerprint
      const queryOnly = compatible && queryFingerprint(config) !== queryFingerprint(current.config)
      const version = { id: id('cfg'), knowledgeBaseId, version: current.version + 1, config, createdAt: now(), compatibilityFingerprint: compatibilityFingerprint(config), requiresRebuild: !compatible && Boolean(kb.activeIndexVersionId) }
      state.configs.push(version); kb.activeConfigVersionId = version.id
      return { changed: true, configVersion: { ...version, config: redactConfig(version.config) }, impact: !compatible ? 'index_rebuild' : queryOnly ? 'query' : 'ingestion' }
    })
  }

  async testEmbeddingConfig(knowledgeBaseId: string, patch: Partial<KnowledgeConfig>) {
    const state = await this.store.snapshot()
    const kb = required(state.knowledgeBases.find(item => item.id === knowledgeBaseId), '知识库不存在')
    const saved = required(state.configs.find(item => item.id === kb.activeConfigVersionId), '配置不存在')
    const config = normalizeEmbeddingSources(mergeConfigPatch(saved.config, patch))
    validateEmbeddingProbe(config)
    if (config.embeddingMode === 'remote_api') return { ok: true as const, model: config.embeddingModel, dimensions: await this.remoteEmbeddings.detectDimensions(remoteRoute(config, config.embeddingSourceId, config.embeddingModel), config) }
    if (!this.localModels) throw new Error('本地模型运行时不可用，无法自动检测维度')
    const status = await this.localModels.ensureRunning(config.embeddingModel)
    return { ok: true as const, model: config.embeddingModel, dimensions: required(status.dimensions, '本地模型未返回向量维度') }
  }

  async directories(knowledgeBaseId: string) {
    const state = await this.store.snapshot()
    required(state.knowledgeBases.find(item => item.id === knowledgeBaseId), '知识库不存在')
    return state.directories
      .filter(item => item.knowledgeBaseId === knowledgeBaseId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(directory => ({ ...directory, task: taskSummary(activeTaskForDirectory(state.tasks, directory)) }))
  }

  async createDirectory(knowledgeBaseId: string, name: string, parentId: string | null) {
    return this.store.transaction(state => {
      required(state.knowledgeBases.find(item => item.id === knowledgeBaseId), '知识库不存在')
      const normalizedName = validateDirectoryName(name)
      if (parentId) { const parent = required(state.directories.find(item => item.id === parentId), '父目录不存在'); if (parent.knowledgeBaseId !== knowledgeBaseId) throw new Error('父目录不属于当前知识库'); if (parent.operationTaskId) throw new Error('父目录正在执行后台操作') }
      if (state.directories.some(item => item.knowledgeBaseId === knowledgeBaseId && item.parentId === parentId && item.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) throw new Error('同一目录下已存在相同名称')
      const createdAt = now(); const directory = { id: id('dir'), knowledgeBaseId, name: normalizedName, parentId, createdAt, updatedAt: createdAt }
      state.directories.push(directory); return directory
    })
  }

  async renameDirectory(directoryId: string, name: string) {
    return this.store.transaction(async state => {
      const directory = required(state.directories.find(item => item.id === directoryId), '目录不存在')
      if (directory.operationTaskId) throw new Error('目录正在执行后台操作')
      const normalizedName = validateDirectoryName(name)
      if (state.directories.some(item => item.id !== directory.id && item.knowledgeBaseId === directory.knowledgeBaseId && item.parentId === directory.parentId && item.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) throw new Error('同一目录下已存在相同名称')
      const oldPrefix = directoryPath(state, directory.id); directory.name = normalizedName; directory.updatedAt = now(); const newPrefix = directoryPath(state, directory.id)
      await this.relocateAssets(state, directory.knowledgeBaseId, oldPrefix, newPrefix)
      return directory
    })
  }

  async deleteDirectory(directoryId: string, mode: 'recursive' | 'move', targetParentId: string | null = null) {
    return this.store.transaction(async state => {
      const directory = required(state.directories.find(item => item.id === directoryId), '目录不存在')
      if (directory.operationTaskId) {
        const task = state.tasks.find(item => item.id === directory.operationTaskId)
        if (task && ['queued', 'running'].includes(task.status)) return { mode, task, scopeSummary: directoryDeleteSummary(task.input) }
      }
      const descendants = directoryDescendants(state, directory.id)
      const oldPrefix = directoryPath(state, directory.id)
      if (mode === 'move') {
        if (targetParentId && descendants.has(targetParentId)) throw new Error('不能移动到当前目录或其子目录')
        if (targetParentId) { const target = required(state.directories.find(item => item.id === targetParentId), '目标目录不存在'); if (target.knowledgeBaseId !== directory.knowledgeBaseId) throw new Error('目标目录不属于当前知识库'); if (target.operationTaskId) throw new Error('目标目录正在执行后台操作') }
        if ([...descendants].some(idValue => state.directories.find(item => item.id === idValue)?.operationTaskId)) throw new Error('目录正在执行后台操作')
        const newPrefix = targetParentId ? directoryPath(state, targetParentId) : ''
        const affectedAssets = await this.relocateAssets(state, directory.knowledgeBaseId, oldPrefix, newPrefix)
        state.directories.filter(item => item.parentId === directory.id).forEach(item => { item.parentId = targetParentId; item.updatedAt = now() })
        state.directories = state.directories.filter(item => item.id !== directory.id)
        return { mode, deletedDirectoryIds: [directory.id], affectedAssets }
      }
      const existing = state.tasks.find(task => task.type === 'delete' && task.scope === 'directory_recursive' && task.targetId === directory.id && ['queued', 'running'].includes(task.status))
      if (existing) return { mode, task: existing, scopeSummary: directoryDeleteSummary(existing.input) }
      const affectedAssets = state.assets.filter(asset => asset.knowledgeBaseId === directory.knowledgeBaseId && isWithinPath(asset.logicalPath, oldPrefix))
      if (affectedAssets.some(asset => asset.operationTaskId)) throw new Error('目录内资料正在执行后台操作')
      const kb = required(state.knowledgeBases.find(item => item.id === directory.knowledgeBaseId), '知识库不存在')
      const activeIndex = state.indexes.find(item => item.id === kb.activeIndexVersionId)
      const task: SyncTask = {
        id: id('task'), knowledgeBaseId: kb.id, type: 'delete', trigger: 'manual', status: 'queued', step: 'waiting', progress: 0, attempts: 0,
        input: {
          scope: 'directory_recursive', rootDirectoryId: directory.id, directoryIds: [...descendants], logicalPrefix: oldPrefix,
          targets: affectedAssets.map(asset => ({ assetId: asset.id, activeVersionId: asset.activeVersionId, logicalPath: asset.logicalPath })),
          baseIndexVersionId: kb.activeIndexVersionId,
        },
        configVersionId: activeIndex?.configVersionId ?? kb.activeConfigVersionId, createdAt: now(), updatedAt: now(), availableAt: now(), maxAttempts: 3,
        scope: 'directory_recursive', targetId: directory.id, dedupeKey: `directory-delete:${directory.id}`,
      }
      state.directories.filter(item => descendants.has(item.id)).forEach(item => { item.operationTaskId = task.id; item.updatedAt = now() })
      affectedAssets.forEach(asset => { asset.operationTaskId = task.id; asset.updatedAt = now() })
      state.tasks.push(task)
      return { mode, task, scopeSummary: { directories: descendants.size, assets: affectedAssets.length } }
    })
  }

  async ingest(input: { knowledgeBaseId: string; sourceType: SourceType; sourceKey: string; assetType: AssetType; displayName: string; logicalPath: string; content: string; simulateFailureAt?: string; taskTrigger?: 'upload' | 'retry'; attempts?: number }) {
    if (!input.assetType.trim()) throw new Error('资料类型不能为空')
    const normalizedPath = input.logicalPath.replaceAll('\\', '/').replace(/^\/+/, '')
    if (!normalizedPath || isAbsolute(input.logicalPath) || normalizedPath.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('逻辑路径不合法')
    if (!['.md', '.txt'].includes(extname(input.logicalPath).toLowerCase())) throw new Error('仅支持 .md 与 .txt 文件')
    if (Buffer.byteLength(input.content, 'utf8') > 10 * 1024 * 1024) throw new Error('文件超过 10MB 限制')
    const contentHash = sha256(input.content)
    return this.store.transaction(async state => {
      const kb = required(state.knowledgeBases.find(item => item.id === input.knowledgeBaseId), '知识库不存在')
      const parentPath = input.logicalPath.replaceAll('\\', '/').split('/').slice(0, -1).join('/')
      if (parentPath) {
        const blocked = state.directories.some(directory => directory.knowledgeBaseId === kb.id && directory.operationTaskId && (directoryPath(state, directory.id) === parentPath || parentPath.startsWith(`${directoryPath(state, directory.id)}/`)))
        if (blocked) throw new Error('目标目录正在执行后台删除')
      }
      const savedConfigVersion = required(state.configs.find(item => item.id === kb.activeConfigVersionId), '配置不存在')
      if (!savedConfigVersion.config.embeddingModel.trim()) throw new Error('知识库当前没有可用模型，请先添加本地模型或选择远程模型')
      const activeIndex = state.indexes.find(item => item.id === kb.activeIndexVersionId)
      const configVersion = savedConfigVersion.requiresRebuild && activeIndex ? required(state.configs.find(item => item.id === activeIndex.configVersionId), '活动索引配置不存在') : savedConfigVersion
      ensureDirectoryPath(state, input.knowledgeBaseId, input.logicalPath.replaceAll('\\', '/').split('/').slice(0, -1))
      let asset = state.assets.find(item => item.knowledgeBaseId === input.knowledgeBaseId && item.logicalPath.toLocaleLowerCase() === input.logicalPath.toLocaleLowerCase())
      const activeVersion = asset ? state.versions.find(item => item.id === asset!.activeVersionId) : undefined
      if (activeVersion?.contentHash === contentHash) return { deduplicated: true, asset, version: activeVersion, task: null }
      const inFlightVersion = asset ? state.versions.find(item => item.assetId === asset!.id && item.contentHash === contentHash && ['pending', 'syncing'].includes(item.status)) : undefined
      const inFlightTask = inFlightVersion ? state.tasks.find(item => item.input.assetVersionId === inFlightVersion.id && ['queued', 'running'].includes(item.status)) : undefined
      if (asset && inFlightVersion && inFlightTask) return { deduplicated: true, asset, version: inFlightVersion, task: inFlightTask }
      if (!asset) {
        asset = { id: id('ast'), knowledgeBaseId: input.knowledgeBaseId, displayName: input.displayName, logicalPath: input.logicalPath, assetType: input.assetType, sourceType: input.sourceType, sourceKey: input.sourceKey, activeVersionId: null, createdAt: now(), updatedAt: now() }
        state.assets.push(asset)
      }
      const version: AssetVersion = { id: id('av'), assetId: asset.id, number: state.versions.filter(item => item.assetId === asset!.id).length + 1, content: input.content, contentHash, status: 'pending', configVersionId: configVersion.id, createdAt: now(), chunks: [] }
      if (this.rawDocuments) Object.assign(version, await this.rawDocuments.saveSnapshot(input.knowledgeBaseId, input.logicalPath, version.id, input.content))
      const task: SyncTask = { id: id('task'), knowledgeBaseId: input.knowledgeBaseId, type: 'sync', trigger: input.taskTrigger ?? input.sourceType, status: 'queued', step: 'waiting', progress: 0, attempts: input.attempts ?? 0, input: { assetId: asset.id, assetVersionId: version.id, logicalPath: input.logicalPath, displayName: input.displayName, assetType: input.assetType, sourceKey: input.sourceKey, sourceType: input.sourceType, simulateFailureAt: input.simulateFailureAt }, configVersionId: configVersion.id, createdAt: now(), updatedAt: now(), availableAt: now(), maxAttempts: 3, targetId: asset.id, dedupeKey: `sync:${version.id}` }
      state.versions.push(version); state.tasks.push(task)
      return { deduplicated: false, asset, version, task }
    })
  }

  async processTask(taskId: string, lease?: TaskLease, signal?: AbortSignal) {
    throwIfAborted(signal)
    if (lease && this.store.ownsTask && !await this.store.ownsTask(taskId, lease)) return null
    const task = required((await this.store.snapshot()).tasks.find(item => item.id === taskId), '任务不存在')
    if (task.type === 'sync') return this.processQueuedSync(taskId, lease, signal)
    if (task.type === 'rebuild') return this.processQueuedRebuild(taskId, lease, signal)
    if (task.type === 'delete') return this.processQueuedDelete(taskId, lease, signal)
    return task
  }

  async processQueuedSync(taskId: string, lease?: TaskLease, signal?: AbortSignal) {
    const work = await this.taskTransaction(taskId, lease, state => {
      const task = required(state.tasks.find(item => item.id === taskId), '任务不存在')
      if (!canRunTask(task, lease) || task.type !== 'sync') return null
      const version = required(state.versions.find(item => item.id === task.input.assetVersionId), '资产版本不存在')
      const asset = required(state.assets.find(item => item.id === version.assetId), '知识资产不存在')
      const config = required(state.configs.find(item => item.id === task.configVersionId), '配置不存在')
      const previous = state.versions.find(item => item.id === asset.activeVersionId)?.chunks ?? []
      const kb = required(state.knowledgeBases.find(item => item.id === task.knowledgeBaseId), '知识库不存在')
      const candidate = createCandidateIndex(state, task.knowledgeBaseId, task.configVersionId)
      task.status = 'running'; task.step = 'embedding'; task.progress = 35; task.startedAt ??= now(); task.updatedAt = now(); task.input.candidateIndexVersionId = candidate.id; task.input.baseIndexVersionId = kb.activeIndexVersionId
      version.status = 'syncing'
      return { content: version.content, versionId: version.id, assetId: asset.id, previous, config: config.config, candidateId: candidate.id, assetMetadata: { assetId: asset.id, displayName: String(task.input.displayName), assetType: String(task.input.assetType), sourceType: task.input.sourceType as SourceType, logicalPath: String(task.input.logicalPath) } satisfies IndexAssetMetadata, simulateFailureAt: task.input.simulateFailureAt }
    })
    if (!work) return null
    try {
      const chunks = (await this.createChunks(work.content, work.config, work.previous, signal)).map(chunk => ({ ...chunk, assetVersionId: work.versionId }))
      const indexedChunks = chunks.map(chunk => ({ ...chunk, assetMetadata: work.assetMetadata } satisfies IndexChunk))
      throwIfAborted(signal)
      if (work.simulateFailureAt) throw new Error(`模拟 ${String(work.simulateFailureAt)} 阶段失败`)
      const prepared = await this.taskTransaction(taskId, lease, state => {
        const task = required(state.tasks.find(item => item.id === taskId), '任务不存在')
        const candidate = required(state.indexes.find(item => item.id === work.candidateId), '候选索引不存在')
        if (task.status === 'cancelled' || task.cancelRequestedAt || !ownsLease(task, lease)) { candidate.status = 'failed'; return false }
        const version = required(state.versions.find(item => item.id === work.versionId), '资产版本不存在')
        const asset = required(state.assets.find(item => item.id === work.assetId), '知识资产不存在')
        const newer = state.versions.some(item => item.assetId === asset.id && item.number > version.number && !['failed', 'deleted'].includes(item.status))
        if (newer) { candidate.status = 'failed'; version.status = 'failed'; version.error = '已被同一资料的更新版本取代'; task.status = 'cancelled'; task.step = 'superseded'; task.finishedAt = now(); return false }
        const kb = required(state.knowledgeBases.find(item => item.id === task.knowledgeBaseId), '知识库不存在')
        const current = state.indexes.find(item => item.id === kb.activeIndexVersionId)
        const targetVersionIds = new Set(state.versions.filter(item => item.assetId === asset.id).map(item => item.id))
        const retainedChunks = (current?.indexedChunks ?? []).filter(chunk => !targetVersionIds.has(chunk.assetVersionId))
        const members = state.assets.filter(item => item.knowledgeBaseId === kb.id && item.id !== asset.id && item.activeVersionId).map(item => item.activeVersionId!)
        candidate.assetVersionIds = [...members, version.id]; candidate.indexedChunks = [...retainedChunks, ...indexedChunks]
        validateCandidate(candidate, task, state)
        task.step = 'vector_indexing'; task.progress = 80; task.updatedAt = now()
        return true
      })
      if (!prepared) return await this.task(taskId)
      throwIfAborted(signal)
      await this.ensureCandidateVectorIndex(work.candidateId, work.config)
      throwIfAborted(signal)
      return await this.taskTransaction(taskId, lease, async state => {
        const task = required(state.tasks.find(item => item.id === taskId), '任务不存在')
        const candidate = required(state.indexes.find(item => item.id === work.candidateId), '候选索引不存在')
        if (task.status === 'cancelled' || task.cancelRequestedAt || !ownsLease(task, lease)) { candidate.status = 'failed'; return task }
        await this.assertCandidateVectorIndexReady(candidate.id, work.config)
        const version = required(state.versions.find(item => item.id === work.versionId), '资产版本不存在')
        const asset = required(state.assets.find(item => item.id === work.assetId), '知识资产不存在')
        const kb = required(state.knowledgeBases.find(item => item.id === task.knowledgeBaseId), '知识库不存在')
        if (kb.activeIndexVersionId !== task.input.baseIndexVersionId) { candidate.status = 'failed'; task.status = 'failed'; task.step = 'failed'; task.error = '活动索引已变化，任务将重新构建'; task.finishedAt = now(); task.updatedAt = now(); return task }
        const current = state.indexes.find(item => item.id === kb.activeIndexVersionId)
        validateCandidate(candidate, task, state)
        if (this.rawDocuments) await this.rawDocuments.activateSnapshot(kb.id, String(task.input.logicalPath), version.id)
        activateCandidateIndex(state, candidate, current)
        version.chunks = chunks; version.status = 'ready'; version.readyAt = now(); version.error = undefined
        asset.activeVersionId = version.id; asset.updatedAt = now(); asset.displayName = String(task.input.displayName); asset.assetType = String(task.input.assetType); asset.sourceKey = String(task.input.sourceKey); asset.sourceType = task.input.sourceType as SourceType
        task.status = 'succeeded'; task.step = 'completed'; task.progress = 100; task.finishedAt = now(); task.updatedAt = now(); task.metrics = { chunks: chunks.length, reusedChunks: chunks.filter(item => item.reused).length, embeddedChunks: chunks.filter(item => !item.reused).length }
        return task
      })
    } catch (error) {
      if (signal?.aborted) return await this.task(taskId)
      return this.taskTransaction(taskId, lease, state => {
        const task = required(state.tasks.find(item => item.id === taskId), '任务不存在')
        const candidate = state.indexes.find(item => item.id === work.candidateId)
        if (candidate?.status === 'candidate') candidate.status = 'failed'
        if (task.status === 'cancelled') return task
        const version = state.versions.find(item => item.id === work.versionId)
        if (version) { version.status = 'failed'; version.error = error instanceof Error ? safeErrorMessage(error.message) : '同步失败' }
        task.status = 'failed'; task.step = String(task.input.simulateFailureAt ?? 'embedding'); task.error = error instanceof Error ? safeErrorMessage(error.message) : '同步失败'; task.finishedAt = now(); task.updatedAt = now()
        return task
      })
    }
  }

  async assets(knowledgeBaseId: string, filters: { status?: string; path?: string; includeDeleted?: boolean; query?: string } = {}) {
    const state = await this.store.snapshot()
    return state.assets
      .filter(asset => asset.knowledgeBaseId === knowledgeBaseId)
      .map(asset => ({
        ...asset,
        activeVersion: state.versions.find(version => version.id === asset.activeVersionId) ?? null,
        versions: state.versions.filter(version => version.assetId === asset.id).map(version => ({ ...version, content: undefined })),
        task: taskSummary(activeTaskForAsset(state.tasks, asset)),
      }))
      .filter(asset => (!filters.status || asset.activeVersion?.status === filters.status) && (!filters.path || asset.logicalPath.includes(filters.path)) && (filters.includeDeleted || Boolean(asset.activeVersion) || Boolean(asset.task)) && (!filters.query || `${asset.displayName} ${asset.logicalPath} ${asset.activeVersion?.content}`.toLocaleLowerCase().includes(filters.query.toLocaleLowerCase())))
  }

  async version(versionId: string) { return required((await this.store.snapshot()).versions.find(item => item.id === versionId), '资产版本不存在') }

  async tasks(knowledgeBaseId: string) { return (await this.store.snapshot()).tasks.filter(item => item.knowledgeBaseId === knowledgeBaseId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }
  async task(taskId: string) { return required((await this.store.snapshot()).tasks.find(item => item.id === taskId), '任务不存在') }

  async retry(taskId: string) {
    return this.store.transaction(state => {
      const task = required(state.tasks.find(item => item.id === taskId), '任务不存在')
      if (task.status !== 'failed') throw new Error('只有失败任务可以重试')
      if (task.scope === 'directory_recursive' && task.input.fileCleanupOnly === true) {
        task.status = 'queued'; task.trigger = 'retry'; task.step = 'file_cleanup'; task.progress = 95; task.attempts = 0; task.availableAt = now(); task.finishedAt = undefined; task.error = undefined; task.updatedAt = now()
        return task
      }
      const candidateId = typeof task.input.candidateIndexVersionId === 'string' ? task.input.candidateIndexVersionId : null
      const candidate = candidateId ? state.indexes.find(item => item.id === candidateId) : null
      if (candidate?.status === 'candidate') candidate.status = 'failed'
      delete task.input.candidateIndexVersionId
      delete task.input.simulateFailureAt
      if (task.type === 'sync') {
        const version = required(state.versions.find(item => item.id === task.input.assetVersionId), '失败资产版本不存在')
        version.status = 'pending'; version.error = undefined
      }
      if (task.scope === 'directory_recursive') {
        const directoryIds = new Set(stringArray(task.input.directoryIds))
        const assetIds = new Set(directoryDeleteTargets(task.input).map(item => item.assetId))
        state.directories.filter(directory => directoryIds.has(directory.id)).forEach(directory => { directory.operationTaskId = task.id; directory.updatedAt = now() })
        state.assets.filter(asset => assetIds.has(asset.id)).forEach(asset => { asset.operationTaskId = task.id; asset.updatedAt = now() })
      }
      task.status = 'queued'; task.trigger = 'retry'; task.step = 'waiting'; task.progress = 0; task.attempts = 0; task.availableAt = now(); task.startedAt = undefined; task.finishedAt = undefined; task.error = undefined; task.leaseOwner = undefined; task.runToken = undefined; task.leaseExpiresAt = undefined; task.heartbeatAt = undefined; task.cancelRequestedAt = undefined; task.updatedAt = now()
      return task
    })
  }

  async deleteAsset(assetId: string) {
    return this.store.transaction(state => {
      const asset = required(state.assets.find(item => item.id === assetId), '知识资产不存在'); const active = required(state.versions.find(item => item.id === asset.activeVersionId), '活动版本不存在'); const kb = required(state.knowledgeBases.find(item => item.id === asset.knowledgeBaseId), '知识库不存在')
      const existing = state.tasks.find(task => task.type === 'delete' && task.input.assetId === assetId && ['queued', 'running'].includes(task.status))
      if (existing) return { asset, task: existing }
      const activeIndex = state.indexes.find(item => item.id === kb.activeIndexVersionId)
      const task: SyncTask = { id: id('task'), knowledgeBaseId: kb.id, type: 'delete', trigger: 'manual', status: 'queued', step: 'waiting', progress: 0, attempts: 0, input: { assetId, assetVersionId: active.id, logicalPath: asset.logicalPath }, configVersionId: activeIndex?.configVersionId ?? kb.activeConfigVersionId, createdAt: now(), updatedAt: now(), availableAt: now(), maxAttempts: 3, targetId: assetId, dedupeKey: `asset-delete:${assetId}` }
      state.tasks.push(task); return { asset, task }
    })
  }

  async processQueuedDelete(taskId: string, lease?: TaskLease, signal?: AbortSignal) {
    throwIfAborted(signal)
    const queued = await this.task(taskId)
    if (queued.scope === 'directory_recursive' || queued.input.scope === 'directory_recursive') return this.processQueuedDirectoryDelete(taskId, lease, signal)
    try {
      const work = await this.taskTransaction(taskId, lease, state => {
        const task = required(state.tasks.find(item => item.id === taskId), '任务不存在')
        if (!canRunTask(task, lease) || task.type !== 'delete') return null
        const asset = required(state.assets.find(item => item.id === task.input.assetId), '知识资产不存在')
        const active = required(state.versions.find(item => item.id === task.input.assetVersionId), '活动版本不存在')
        if (asset.activeVersionId !== active.id) { task.status = 'cancelled'; task.step = 'superseded'; task.finishedAt = now(); task.updatedAt = now(); return null }
        const kb = required(state.knowledgeBases.find(item => item.id === asset.knowledgeBaseId), '知识库不存在')
        const config = required(state.configs.find(item => item.id === task.configVersionId), '配置不存在').config
        const current = state.indexes.find(item => item.id === kb.activeIndexVersionId)
        const candidate = createCandidateIndex(state, kb.id, task.configVersionId)
        task.status = 'running'; task.step = 'candidate_building'; task.progress = 60; task.startedAt ??= now(); task.updatedAt = now(); task.input.candidateIndexVersionId = candidate.id; task.input.baseIndexVersionId = kb.activeIndexVersionId
        const removedVersionIds = new Set(state.versions.filter(version => version.assetId === asset.id).map(version => version.id))
        candidate.assetVersionIds = state.assets.filter(item => item.knowledgeBaseId === kb.id && item.id !== asset.id && item.activeVersionId).map(item => item.activeVersionId!)
        candidate.indexedChunks = (current?.indexedChunks ?? []).filter(chunk => !removedVersionIds.has(chunk.assetVersionId))
        validateCandidate(candidate, task, state)
        task.step = 'vector_indexing'; task.progress = 80; task.updatedAt = now()
        return { candidateId: candidate.id, config }
      })
      if (!work) return await this.task(taskId)
      throwIfAborted(signal)
      await this.ensureCandidateVectorIndex(work.candidateId, work.config)
      throwIfAborted(signal)
      return await this.taskTransaction(taskId, lease, async state => {
        const task = required(state.tasks.find(item => item.id === taskId), '任务不存在')
        const candidate = required(state.indexes.find(item => item.id === work.candidateId), '候选索引不存在')
        if (task.status === 'cancelled' || task.cancelRequestedAt || !ownsLease(task, lease)) { candidate.status = 'failed'; return task }
        await this.assertCandidateVectorIndexReady(candidate.id, work.config)
        const asset = required(state.assets.find(item => item.id === task.input.assetId), '知识资产不存在')
        const active = required(state.versions.find(item => item.id === task.input.assetVersionId), '活动版本不存在')
        if (asset.activeVersionId !== active.id) { candidate.status = 'failed'; task.status = 'cancelled'; task.step = 'superseded'; task.finishedAt = now(); task.updatedAt = now(); return task }
        const kb = required(state.knowledgeBases.find(item => item.id === asset.knowledgeBaseId), '知识库不存在')
        if (kb.activeIndexVersionId !== task.input.baseIndexVersionId) { candidate.status = 'failed'; task.status = 'failed'; task.step = 'failed'; task.error = '活动索引已变化，任务将重新构建'; task.finishedAt = now(); task.updatedAt = now(); return task }
        const current = state.indexes.find(item => item.id === kb.activeIndexVersionId)
        validateCandidate(candidate, task, state)
        if (this.rawDocuments) await this.rawDocuments.deleteActive(kb.id, asset.logicalPath)
        activateCandidateIndex(state, candidate, current)
        active.status = 'deleted'; asset.activeVersionId = null; asset.updatedAt = now(); task.status = 'succeeded'; task.step = 'completed'; task.progress = 100; task.finishedAt = now(); task.updatedAt = now()
        return task
      })
    } catch (error) {
      if (signal?.aborted) return await this.task(taskId)
      return this.taskTransaction(taskId, lease, state => { const task = required(state.tasks.find(item => item.id === taskId), '任务不存在'); const candidateId = typeof task.input.candidateIndexVersionId === 'string' ? task.input.candidateIndexVersionId : null; const candidate = candidateId ? state.indexes.find(item => item.id === candidateId) : null; if (candidate?.status === 'candidate') candidate.status = 'failed'; if (task.status !== 'cancelled') { task.status = 'failed'; task.step = 'failed'; task.error = error instanceof Error ? safeErrorMessage(error.message) : '删除任务失败'; task.finishedAt = now(); task.updatedAt = now() } return task })
    }
  }

  async processQueuedDirectoryDelete(taskId: string, lease?: TaskLease, signal?: AbortSignal) {
    throwIfAborted(signal)
    const checkpoint = await this.task(taskId)
    if (checkpoint.input.fileCleanupOnly === true) return this.completeDirectoryFileCleanup(taskId, lease, signal)
    try {
      const prepared = await this.taskTransaction(taskId, lease, state => {
        const task = required(state.tasks.find(item => item.id === taskId), '任务不存在')
        if (!canRunTask(task, lease) || task.type !== 'delete') return null
        const input = task.input
        const directoryIds = new Set(stringArray(input.directoryIds))
        const targets = directoryDeleteTargets(input)
        if (!directoryIds.size) throw new Error('目录删除范围为空')
        const kb = required(state.knowledgeBases.find(item => item.id === task.knowledgeBaseId), '知识库不存在')
        const config = required(state.configs.find(item => item.id === task.configVersionId), '配置不存在').config
        const current = state.indexes.find(item => item.id === kb.activeIndexVersionId)
        const targetAssetIds = new Set(targets.map(item => item.assetId))
        const targetVersionIds = new Set(targets.map(item => item.activeVersionId).filter(Boolean))
        const blocked = targets.some(target => {
          const asset = state.assets.find(item => item.id === target.assetId)
          return !asset || asset.operationTaskId !== task.id || asset.activeVersionId !== target.activeVersionId
        })
        if (blocked) { task.status = 'cancelled'; task.step = 'superseded'; task.finishedAt = now(); task.updatedAt = now(); releaseDirectoryDeleteScope(state, task); return null }
        const candidate: DatabaseState['indexes'][number] = createCandidateIndex(state, kb.id, task.configVersionId)
        task.status = 'running'; task.step = 'candidate_building'; task.progress = 55; task.startedAt ??= now(); task.updatedAt = now(); task.input.candidateIndexVersionId = candidate.id
        candidate.assetVersionIds = state.assets.filter(asset => asset.knowledgeBaseId === kb.id && !targetAssetIds.has(asset.id) && asset.activeVersionId).map(asset => asset.activeVersionId!)
        candidate.indexedChunks = (current?.indexedChunks ?? []).filter(chunk => !targetVersionIds.has(chunk.assetVersionId))
        validateCandidate(candidate, task, state)
        task.step = 'vector_indexing'; task.progress = 80; task.updatedAt = now()
        return { candidateId: candidate.id, config }
      })
      if (!prepared) return await this.task(taskId)
      throwIfAborted(signal)
      await this.ensureCandidateVectorIndex(prepared.candidateId, prepared.config)
      throwIfAborted(signal)
      const committed = await this.taskTransaction(taskId, lease, async state => {
        const task = required(state.tasks.find(item => item.id === taskId), '任务不存在')
        const candidate = required(state.indexes.find(item => item.id === prepared.candidateId), '候选索引不存在')
        if (task.status === 'cancelled' || task.cancelRequestedAt || !ownsLease(task, lease)) { candidate.status = 'failed'; return null }
        await this.assertCandidateVectorIndexReady(candidate.id, prepared.config)
        const input = task.input
        const directoryIds = new Set(stringArray(input.directoryIds))
        const targets = directoryDeleteTargets(input)
        const kb = required(state.knowledgeBases.find(item => item.id === task.knowledgeBaseId), '知识库不存在')
        const current = state.indexes.find(item => item.id === kb.activeIndexVersionId)
        const blocked = targets.some(target => {
          const asset = state.assets.find(item => item.id === target.assetId)
          return !asset || asset.operationTaskId !== task.id || asset.activeVersionId !== target.activeVersionId
        })
        if (blocked) { candidate.status = 'failed'; task.status = 'cancelled'; task.step = 'superseded'; task.finishedAt = now(); task.updatedAt = now(); releaseDirectoryDeleteScope(state, task); return null }
        validateCandidate(candidate, task, state)
        task.step = 'committing'; task.progress = 90
        activateCandidateIndex(state, candidate, current)
        for (const target of targets) {
          const asset = state.assets.find(item => item.id === target.assetId)
          const version = state.versions.find(item => item.id === target.activeVersionId)
          if (asset && version) { version.status = 'deleted'; asset.activeVersionId = null; asset.updatedAt = now() }
        }
        task.status = 'running'; task.step = 'file_cleanup'; task.progress = 95; task.input.fileCleanupOnly = true; task.updatedAt = now(); task.metrics = { directories: directoryIds.size, assets: targets.length }
        return { knowledgeBaseId: kb.id, logicalPrefix: String(input.logicalPrefix ?? ''), task }
      })
      if (!committed) return await this.task(taskId)
      try {
        if (this.rawDocuments) await this.rawDocuments.deleteActiveDirectory(committed.knowledgeBaseId, committed.logicalPrefix)
        return await this.taskTransaction(taskId, lease, state => {
          const task = required(state.tasks.find(item => item.id === taskId), '任务不存在')
          if (task.status === 'running' && task.input.fileCleanupOnly === true) { finalizeDirectoryDeleteScope(state, task); task.status = 'succeeded'; task.step = 'completed'; task.progress = 100; task.finishedAt = now(); task.updatedAt = now(); delete task.input.fileCleanupOnly }
          return task
        })
      } catch (error) {
        if (signal?.aborted) return await this.task(taskId)
        return await this.taskTransaction(taskId, lease, state => {
          const task = required(state.tasks.find(item => item.id === taskId), '任务不存在')
          task.status = 'failed'; task.step = 'file_cleanup'; task.error = error instanceof Error ? safeErrorMessage(error.message) : '活动文件清理失败'; task.updatedAt = now(); return task
        })
      }
    } catch (error) {
      if (signal?.aborted) return await this.task(taskId)
      return this.taskTransaction(taskId, lease, state => {
        const task = required(state.tasks.find(item => item.id === taskId), '任务不存在')
        const candidateId = typeof task.input.candidateIndexVersionId === 'string' ? task.input.candidateIndexVersionId : null
        const candidate = candidateId ? state.indexes.find(item => item.id === candidateId) : null
        if (candidate?.status === 'candidate') candidate.status = 'failed'
        if (task.status !== 'cancelled') { task.status = 'failed'; task.step = 'failed'; task.error = error instanceof Error ? safeErrorMessage(error.message) : '目录删除任务失败'; task.finishedAt = now(); task.updatedAt = now(); releaseDirectoryDeleteScope(state, task) }
        return task
      })
    }
  }

  private async completeDirectoryFileCleanup(taskId: string, lease?: TaskLease, signal?: AbortSignal) {
    throwIfAborted(signal)
    const work = await this.taskTransaction(taskId, lease, state => {
      const task = required(state.tasks.find(item => item.id === taskId), '任务不存在')
      if (!canRunTask(task, lease) || task.input.fileCleanupOnly !== true) return null
      task.status = 'running'; task.step = 'file_cleanup'; task.progress = 95; task.startedAt ??= now(); task.updatedAt = now()
      return { knowledgeBaseId: task.knowledgeBaseId, logicalPrefix: String(task.input.logicalPrefix ?? '') }
    })
    if (!work) return await this.task(taskId)
    try {
      throwIfAborted(signal)
      if (this.rawDocuments) await this.rawDocuments.deleteActiveDirectory(work.knowledgeBaseId, work.logicalPrefix)
      throwIfAborted(signal)
      return await this.taskTransaction(taskId, lease, state => {
        const task = required(state.tasks.find(item => item.id === taskId), '任务不存在')
        if (task.status === 'running' && task.input.fileCleanupOnly === true && ownsLease(task, lease)) { finalizeDirectoryDeleteScope(state, task); task.status = 'succeeded'; task.step = 'completed'; task.progress = 100; task.finishedAt = now(); task.updatedAt = now(); delete task.input.fileCleanupOnly }
        return task
      })
    } catch (error) {
      if (signal?.aborted) return await this.task(taskId)
      return this.taskTransaction(taskId, lease, state => {
        const task = required(state.tasks.find(item => item.id === taskId), '任务不存在')
        if (task.status === 'running') { task.status = 'failed'; task.step = 'file_cleanup'; task.error = error instanceof Error ? safeErrorMessage(error.message) : '活动文件清理失败'; task.updatedAt = now() }
        return task
      })
    }
  }

  async updateAsset(assetId: string, patch: { displayName?: string; targetDirectoryId?: string | null }) {
    return this.store.transaction(async state => {
      const asset = required(state.assets.find(item => item.id === assetId), '知识资产不存在')
      if (asset.operationTaskId) throw new Error('知识资产正在执行后台操作')
      if (!asset.activeVersionId) throw new Error('已删除的知识资产不能移动或重命名')
      const currentName = asset.logicalPath.replaceAll('\\', '/').split('/').at(-1)!
      const displayName = patch.displayName == null ? currentName : validateFileName(patch.displayName)
      let directoryPrefix = asset.logicalPath.replaceAll('\\', '/').split('/').slice(0, -1).join('/')
      if ('targetDirectoryId' in patch) {
        if (patch.targetDirectoryId) { const target = required(state.directories.find(item => item.id === patch.targetDirectoryId), '目标目录不存在'); if (target.knowledgeBaseId !== asset.knowledgeBaseId) throw new Error('目标目录不属于当前知识库'); directoryPrefix = directoryPath(state, target.id) }
        else directoryPrefix = ''
      }
      const newPath = [directoryPrefix, displayName].filter(Boolean).join('/')
      if (state.assets.some(item => item.id !== asset.id && item.knowledgeBaseId === asset.knowledgeBaseId && item.activeVersionId && item.logicalPath.toLocaleLowerCase() === newPath.toLocaleLowerCase())) throw new Error(`目标位置已存在 ${displayName}`)
      if (newPath !== asset.logicalPath && this.rawDocuments) { const storagePath = await this.rawDocuments.moveActive(asset.knowledgeBaseId, asset.logicalPath, newPath); const version = state.versions.find(item => item.id === asset.activeVersionId); if (version) version.storagePath = storagePath }
      asset.logicalPath = newPath; asset.displayName = displayName; asset.sourceKey = asset.sourceKey.startsWith('browser:') ? `browser:${newPath}` : asset.sourceKey; asset.updatedAt = now()
      ensureDirectoryPath(state, asset.knowledgeBaseId, newPath.split('/').slice(0, -1))
      return asset
    })
  }

  async search(knowledgeBaseId: string, input: { query: string; mode?: 'keyword' | 'vector' | 'hybrid'; logicalPath?: string }) {
    const state = await this.store.snapshot(); const kb = required(state.knowledgeBases.find(item => item.id === knowledgeBaseId), '知识库不存在')
    const query = input.query.trim()
    if (!query) throw new Error('检索内容不能为空')
    if (!state.versions.some(item => item.status === 'ready' && state.assets.some(asset => asset.knowledgeBaseId === knowledgeBaseId && asset.activeVersionId === item.id))) {
      const indexing = state.tasks.some(task => task.knowledgeBaseId === knowledgeBaseId && ['sync', 'rebuild'].includes(task.type) && ['queued', 'running'].includes(task.status))
      return { status: indexing ? 'initial_indexing' : 'no_ready_assets', results: [] }
    }
    if (!kb.activeIndexVersionId) return { status: 'no_active_index', results: [] }
    const index = required(state.indexes.find(item => item.id === kb.activeIndexVersionId), '活动索引不存在')
    const indexConfig = required(state.configs.find(item => item.id === index.configVersionId), '索引配置不存在').config
    const latestConfig = required(state.configs.find(item => item.id === kb.activeConfigVersionId), '当前查询配置不存在').config
    const config = withLatestQueryConfig(indexConfig, latestConfig)
    const requestedMode = input.mode ?? (config.hybridSearch ? 'hybrid' : 'keyword')
    const hasFilterMatch = index.indexedChunks?.some(chunk => !input.logicalPath || chunk.assetMetadata?.logicalPath.includes(input.logicalPath)) ?? false
    if (input.logicalPath && !hasFilterMatch) return { status: 'filter_empty', results: [] }
    let mode = requestedMode
    let queryVector: number[] | undefined
    let degradedReason: string | undefined
    if (mode !== 'keyword') {
      try { queryVector = (await this.embedTexts(config, [query]))[0] }
      catch (error) {
        degradedReason = error instanceof Error ? safeErrorMessage(error.message) : 'Embedding Provider 不可用'
        if (mode === 'vector') return { status: 'vector_unavailable', results: [], degradation: { requestedMode, fallbackMode: null, reason: degradedReason } }
        mode = 'keyword'
      }
    }
    const [keywordCandidates, vectorCandidates] = await Promise.all([
      mode === 'vector' ? Promise.resolve([]) : this.recall(index, config, 'keyword', query, undefined, config.keywordRecall, input),
      mode === 'keyword' ? Promise.resolve([]) : this.recall(index, config, 'vector', query, queryVector, config.vectorRecall, input),
    ])
    const merged = mergeCandidates(keywordCandidates, vectorCandidates, mode)
    let reranked = merged
    let rerankerDegraded = false
    if (config.rerankerEnabled && merged.length) {
      try { reranked = await this.rerank(config, query, merged) }
      catch (error) { rerankerDegraded = true; degradedReason ??= error instanceof Error ? safeErrorMessage(error.message) : 'Reranker 不可用' }
    }
    const eligible = reranked.filter(item => item.score >= config.relevanceThreshold).sort((a, b) => b.score - a.score)
    const candidates = eligible.slice(0, config.finalResults).map(item => ({
      score: item.score,
      retrievalMode: mode,
      asset: item.candidate.asset,
      version: item.candidate.version,
      chunk: item.candidate.chunk,
      excerpt: item.candidate.content.slice(0, 280),
      scores: { keyword: item.keywordScore, vector: item.vectorScore, reranker: item.rerankerScore, final: item.score },
    }))
    return {
      status: candidates.length ? 'ok' : 'no_matches',
      indexVersionId: index.id,
      retrieval: { mode, requestedMode, degraded: Boolean(degradedReason), degradedReason, minimumRelevance: config.relevanceThreshold, keywordCandidates: keywordCandidates.length, vectorCandidates: vectorCandidates.length, mergedCandidates: merged.length, eligibleCandidates: eligible.length, returned: candidates.length, rerankerEnabled: config.rerankerEnabled, rerankerDegraded },
      results: candidates,
    }
  }

  async rebuild(knowledgeBaseId: string, outcome: 'success' | 'failure' | 'cancel' = 'success') {
    const task = await this.queueRebuild(knowledgeBaseId)
    if (outcome === 'cancel') { await this.cancelTask(task.id); return { task: await this.task(task.id), activeIndexVersionId: (await this.overview(knowledgeBaseId)).knowledgeBase.activeIndexVersionId } }
    if (outcome === 'failure') await this.store.transaction(state => { const queued = required(state.tasks.find(item => item.id === task.id), '任务不存在'); queued.input.simulateFailure = true })
    await this.processQueuedRebuild(task.id)
    const completed = await this.task(task.id)
    const state = await this.store.snapshot()
    return { task: completed, index: completed.status === 'succeeded' ? state.indexes.find(item => item.id === completed.input.candidateIndexVersionId) : undefined, activeIndexVersionId: state.knowledgeBases.find(item => item.id === knowledgeBaseId)?.activeIndexVersionId }
  }

  async queueRebuild(knowledgeBaseId: string) {
    return this.store.transaction(state => {
      const kb = required(state.knowledgeBases.find(item => item.id === knowledgeBaseId), '知识库不存在')
      const config = required(state.configs.find(item => item.id === kb.activeConfigVersionId), '配置不存在')
      if (!config.config.embeddingModel.trim()) throw new Error('知识库当前没有可用模型，无法重建索引')
      const existing = state.tasks.find(item => item.knowledgeBaseId === knowledgeBaseId && item.type === 'rebuild' && ['queued', 'running'].includes(item.status))
      if (existing) return existing
      const task = { id: id('task'), knowledgeBaseId, type: 'rebuild' as const, trigger: 'manual' as const, status: 'queued' as const, step: 'waiting', progress: 0, attempts: 0, input: { oldIndexId: kb.activeIndexVersionId }, configVersionId: kb.activeConfigVersionId, createdAt: now(), updatedAt: now(), availableAt: now(), maxAttempts: 3, scope: 'knowledge_base' as const, targetId: knowledgeBaseId, dedupeKey: `rebuild:${knowledgeBaseId}` }
      state.tasks.push(task); return task
    })
  }

  async processQueuedRebuild(taskId: string, lease?: TaskLease, signal?: AbortSignal) {
    throwIfAborted(signal)
    const work = await this.taskTransaction(taskId, lease, state => {
      const task = required(state.tasks.find(item => item.id === taskId), '任务不存在')
      if (!canRunTask(task, lease) || task.type !== 'rebuild') return null
      const kb = required(state.knowledgeBases.find(item => item.id === task.knowledgeBaseId), '知识库不存在')
      const config = required(state.configs.find(item => item.id === task.configVersionId), '配置不存在')
      const versions = state.assets.filter(item => item.knowledgeBaseId === kb.id && item.activeVersionId).map(asset => ({ version: required(state.versions.find(version => version.id === asset.activeVersionId), '资产版本不存在'), assetMetadata: indexAssetMetadata(asset) }))
      const candidate = createCandidateIndex(state, kb.id, task.configVersionId)
      candidate.assetVersionIds = versions.map(item => item.version.id)
      task.status = 'running'; task.step = 'building_candidate'; task.progress = 20; task.startedAt ??= now(); task.updatedAt = now(); task.input.candidateIndexVersionId = candidate.id; task.input.baseIndexVersionId = kb.activeIndexVersionId
      return { candidateId: candidate.id, knowledgeBaseId: kb.id, configVersionId: config.id, config: config.config, versions: versions.map(({ version, assetMetadata }) => ({ id: version.id, content: version.content, assetMetadata })), simulateFailure: Boolean(task.input.simulateFailure) }
    })
    if (!work) return null
    try {
      const rebuiltChunks: IndexChunk[] = []
      for (const version of work.versions) {
        throwIfAborted(signal)
        rebuiltChunks.push(...(await this.createChunks(version.content, work.config, [], signal)).map(chunk => ({ ...chunk, assetVersionId: version.id, assetMetadata: version.assetMetadata })))
      }
      throwIfAborted(signal)
      if (work.simulateFailure) throw new Error('模拟索引校验失败')
      const prepared = await this.taskTransaction(taskId, lease, state => {
        const task = required(state.tasks.find(item => item.id === taskId), '任务不存在')
        const candidate = required(state.indexes.find(item => item.id === work.candidateId), '候选索引不存在')
        if (task.status === 'cancelled' || task.cancelRequestedAt || !ownsLease(task, lease)) { candidate.status = 'failed'; return false }
        const kb = required(state.knowledgeBases.find(item => item.id === work.knowledgeBaseId), '知识库不存在')
        if (kb.activeIndexVersionId !== task.input.baseIndexVersionId) throw new Error('活动索引已变化，请重新发起重建')
        candidate.indexedChunks = rebuiltChunks
        validateCandidate(candidate, task, state)
        task.step = 'vector_indexing'; task.progress = 80; task.updatedAt = now()
        return true
      })
      if (!prepared) return await this.task(taskId)
      throwIfAborted(signal)
      await this.ensureCandidateVectorIndex(work.candidateId, work.config)
      throwIfAborted(signal)
      return await this.taskTransaction(taskId, lease, async state => {
        const task = required(state.tasks.find(item => item.id === taskId), '任务不存在')
        const candidate = required(state.indexes.find(item => item.id === work.candidateId), '候选索引不存在')
        if (task.status === 'cancelled' || task.cancelRequestedAt || !ownsLease(task, lease)) { candidate.status = 'failed'; return task }
        await this.assertCandidateVectorIndexReady(candidate.id, work.config)
        const kb = required(state.knowledgeBases.find(item => item.id === work.knowledgeBaseId), '知识库不存在')
        if (kb.activeIndexVersionId !== task.input.baseIndexVersionId) throw new Error('活动索引已变化，请重新发起重建')
        validateCandidate(candidate, task, state)
        const current = state.indexes.find(item => item.id === kb.activeIndexVersionId)
        activateCandidateIndex(state, candidate, current)
        const config = required(state.configs.find(item => item.id === work.configVersionId), '配置不存在'); config.requiresRebuild = false
        task.status = 'succeeded'; task.step = 'completed'; task.progress = 100; task.finishedAt = now(); task.updatedAt = now(); task.metrics = { chunks: rebuiltChunks.length, embeddedChunks: rebuiltChunks.length }; return task
      })
    } catch (error) {
      if (signal?.aborted) return await this.task(taskId)
      return this.taskTransaction(taskId, lease, state => {
        const task = required(state.tasks.find(item => item.id === taskId), '任务不存在')
        if (task.status === 'cancelled') return task
        const candidate = state.indexes.find(item => item.id === work.candidateId)
        if (candidate?.status === 'candidate') candidate.status = 'failed'
        task.status = 'failed'; task.step = 'failed'; task.error = error instanceof Error ? safeErrorMessage(error.message) : '索引重建失败'; task.finishedAt = now(); task.updatedAt = now(); return task
      })
    }
  }

  async cancelTask(taskId: string) {
    return this.store.transaction(state => {
      const task = required(state.tasks.find(item => item.id === taskId), '任务不存在')
      if (task.input.fileCleanupOnly === true) throw new Error('目录逻辑删除已完成，文件清理只能重试')
      if (!['queued', 'running'].includes(task.status)) throw new Error('只有等待中或运行中的任务可以取消')
      task.status = 'cancelled'; task.step = 'cancelled'; task.cancelRequestedAt = now(); task.finishedAt = now(); task.updatedAt = now()
      const candidateId = typeof task.input.candidateIndexVersionId === 'string' ? task.input.candidateIndexVersionId : null
      const candidate = candidateId ? state.indexes.find(item => item.id === candidateId) : null
      if (candidate?.status === 'candidate') candidate.status = 'failed'
      if (task.type === 'sync') { const version = state.versions.find(item => item.id === task.input.assetVersionId); if (version && ['pending', 'syncing'].includes(version.status)) { version.status = 'failed'; version.error = '同步任务已取消' } }
      if (task.scope === 'directory_recursive' && task.input.fileCleanupOnly !== true) releaseDirectoryDeleteScope(state, task)
      return task
    })
  }

  private async taskTransaction<T>(taskId: string, lease: TaskLease | undefined, operation: (state: DatabaseState) => T | Promise<T>): Promise<T | null> {
    if (lease && this.store.transactionWithTaskLease) return this.store.transactionWithTaskLease(taskId, lease, operation)
    return this.store.transaction(operation)
  }

  private async ensureCandidateVectorIndex(candidateId: string, config: KnowledgeConfig) {
    if (!this.store.ensureVectorIndex) return
    await this.store.ensureVectorIndex(candidateId, config.embeddingDimensions)
  }

  private async assertCandidateVectorIndexReady(candidateId: string, config: KnowledgeConfig) {
    if (!this.store.isVectorIndexReady) return
    if (!await this.store.isVectorIndexReady(candidateId, config.embeddingDimensions)) throw new Error('候选索引 HNSW 尚未就绪')
  }

  private async createChunks(content: string, config: KnowledgeConfig, previous: Chunk[] = [], signal?: AbortSignal): Promise<Chunk[]> {
    throwIfAborted(signal)
    const tokenizer = await this.tokenizer(config)
    const chunks: Chunk[] = chunkDocument(content, config, previous, tokenizer)
    chunks.filter(chunk => chunk.reused && chunk.embedding.length !== config.embeddingDimensions).forEach(chunk => { chunk.reused = false; chunk.embedding = [] })
    const changed = chunks.filter(chunk => !chunk.reused)
    const vectors = await this.embedTexts(config, changed.map(chunk => chunk.content), config.embeddingModel, signal)
    throwIfAborted(signal)
    changed.forEach((chunk, index) => { chunk.embedding = required(vectors[index], '本地模型未返回完整向量结果') })
    return chunks
  }

  private async tokenizer(config: KnowledgeConfig): Promise<TokenCodec> {
    if (!config.embeddingModel.trim()) throw new Error('知识库当前没有可用模型')
    if (config.embeddingMode === 'remote_api') return this.remoteEmbeddings.tokenCodec(config.embeddingModel)
    return (this.localModels ? await this.localModels.tokenCodec(config.embeddingModel) : null) ?? defaultTokenCodec
  }

  private async embedTexts(config: KnowledgeConfig, texts: string[], model = config.embeddingModel, signal?: AbortSignal) {
    throwIfAborted(signal)
    if (!texts.length) return []
    if (!model.trim()) throw new Error('知识库当前没有可用模型')
    if (config.embeddingMode === 'remote_api') return this.remoteEmbeddings.embed(remoteRoute(config, config.embeddingSourceId, model), config, texts, signal)
    if (this.localModels) {
      await this.localModels.ensureRunning(model)
      throwIfAborted(signal)
      const vectors: number[][] = []
      for (let offset = 0; offset < texts.length; offset += config.embeddingBatchSize) {
        throwIfAborted(signal)
        vectors.push(...await this.localModels.embed(model, texts.slice(offset, offset + config.embeddingBatchSize)))
      }
      throwIfAborted(signal)
      return vectors
    }
    return texts.map(text => embedding(text, config.embeddingDimensions))
  }

  private async recall(index: DatabaseState['indexes'][number], config: KnowledgeConfig, mode: 'keyword' | 'vector', query: string, queryVector: number[] | undefined, limit: number, filters: RetrievalInput) {
    if (this.store.searchChunks) return this.store.searchChunks({ indexVersionId: index.id, mode, query, queryVector, dimensions: config.embeddingDimensions, limit, logicalPath: filters.logicalPath })
    const state = this.store.read()
    const terms = query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []
    return (index.indexedChunks ?? []).flatMap(chunk => {
      const version = state.versions.find(item => item.id === chunk.assetVersionId)
      const metadata = chunk.assetMetadata
      if (!version || !metadata || (filters.logicalPath && !metadata.logicalPath.includes(filters.logicalPath))) return []
      const text = chunk.content.toLocaleLowerCase()
      const score = mode === 'keyword'
        ? (terms.length ? terms.filter(term => text.includes(term)).length / terms.length : 0)
        : (cosine(required(queryVector, '查询向量不存在'), chunk.embedding) + 1) / 2
      return [{ score, asset: { id: metadata.assetId, displayName: metadata.displayName, assetType: metadata.assetType, sourceType: metadata.sourceType, logicalPath: metadata.logicalPath }, version: { id: version.id, number: version.number }, chunk: { id: chunk.id, chunkKey: chunk.chunkKey, headingPath: chunk.headingPath, startLine: chunk.startLine, endLine: chunk.endLine, startChar: chunk.startChar, endChar: chunk.endChar }, content: chunk.content } satisfies StoredChunkCandidate]
    }).sort((left, right) => right.score - left.score).slice(0, limit)
  }

  private async rerank(config: KnowledgeConfig, query: string, candidates: RankedCandidate[]) {
    const rerankerConfig = modelRouteConfig(config, config.rerankerSourceId, config.rerankerModel)
    const vectors = await this.embedTexts(rerankerConfig, [query, ...candidates.map(item => item.candidate.content)])
    const queryVector = required(vectors[0], 'Reranker 未返回查询向量')
    return candidates.map((item, index) => {
      const semanticScore = (cosine(queryVector, required(vectors[index + 1], 'Reranker 未返回完整候选向量')) + 1) / 2
      return { ...item, rerankerScore: semanticScore, score: item.score * 0.6 + semanticScore * 0.4 }
    })
  }

  private async relocateAssets(state: DatabaseState, knowledgeBaseId: string, oldPrefix: string, newPrefix: string) {
    const affected = state.assets.filter(asset => asset.knowledgeBaseId === knowledgeBaseId && isWithinPath(asset.logicalPath, oldPrefix))
    const moves = affected.map(asset => {
      const relativePath = asset.logicalPath.slice(oldPrefix.length).replace(/^\//, '')
      return { asset, oldPath: asset.logicalPath, newPath: [newPrefix, relativePath].filter(Boolean).join('/') }
    })
    for (const move of moves) if (state.assets.some(asset => asset.id !== move.asset.id && asset.knowledgeBaseId === knowledgeBaseId && asset.logicalPath.toLocaleLowerCase() === move.newPath.toLocaleLowerCase())) throw new Error(`目标目录已存在 ${move.newPath}`)
    for (const move of moves) {
      if (this.rawDocuments && move.asset.activeVersionId) { const storagePath = await this.rawDocuments.moveActive(knowledgeBaseId, move.oldPath, move.newPath); const version = state.versions.find(item => item.id === move.asset.activeVersionId); if (version) version.storagePath = storagePath }
      move.asset.logicalPath = move.newPath; move.asset.sourceKey = move.asset.sourceKey.startsWith('browser:') ? `browser:${move.newPath}` : move.asset.sourceKey; move.asset.updatedAt = now()
    }
    return moves.length
  }

}

function taskSummary(task: SyncTask | null | undefined) {
  if (!task) return null
  return {
    id: task.id, type: task.type, status: task.status, step: task.step, progress: task.progress,
    error: task.error, canRetry: task.status === 'failed', canCancel: ['queued', 'running'].includes(task.status) && task.input.fileCleanupOnly !== true,
  }
}

function activeTaskForAsset(tasks: SyncTask[], asset: DatabaseState['assets'][number]) {
  const active = tasks
    .filter(task => task.knowledgeBaseId === asset.knowledgeBaseId && ['queued', 'running', 'failed'].includes(task.status))
    .filter(task => task.targetId === asset.id || task.input.assetId === asset.id || (task.scope === 'directory_recursive' && directoryDeleteTargets(task.input).some(target => target.assetId === asset.id)))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  return active[0] ?? null
}

function activeTaskForDirectory(tasks: SyncTask[], directory: DatabaseState['directories'][number]) {
  const active = tasks
    .filter(task => task.knowledgeBaseId === directory.knowledgeBaseId && task.scope === 'directory_recursive' && ['queued', 'running', 'failed'].includes(task.status))
    .filter(task => task.targetId === directory.id || stringArray(task.input.directoryIds).includes(directory.id))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  return active[0] ?? null
}

function throwIfAborted(signal?: AbortSignal) { if (signal?.aborted) throw signal.reason ?? new Error('任务执行已中止') }

function stringArray(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] }

function directoryDeleteTargets(input: Record<string, unknown>) {
  const raw = Array.isArray(input.targets) ? input.targets : []
  return raw.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const target = item as Record<string, unknown>
    const assetId = typeof target.assetId === 'string' ? target.assetId : ''
    const activeVersionId = typeof target.activeVersionId === 'string' ? target.activeVersionId : null
    const logicalPath = typeof target.logicalPath === 'string' ? target.logicalPath : ''
    return assetId ? [{ assetId, activeVersionId, logicalPath }] : []
  })
}

function directoryDeleteSummary(input: Record<string, unknown>) {
  return { directories: stringArray(input.directoryIds).length, assets: directoryDeleteTargets(input).length }
}

function releaseDirectoryDeleteScope(state: DatabaseState, task: SyncTask) {
  const directoryIds = new Set(stringArray(task.input.directoryIds))
  const assetIds = new Set(directoryDeleteTargets(task.input).map(item => item.assetId))
  state.directories.filter(directory => directoryIds.has(directory.id) && directory.operationTaskId === task.id).forEach(directory => { directory.operationTaskId = undefined; directory.updatedAt = now() })
  state.assets.filter(asset => assetIds.has(asset.id) && asset.operationTaskId === task.id).forEach(asset => { asset.operationTaskId = undefined; asset.updatedAt = now() })
}

function finalizeDirectoryDeleteScope(state: DatabaseState, task: SyncTask) {
  const directoryIds = new Set(stringArray(task.input.directoryIds))
  const assetIds = new Set(directoryDeleteTargets(task.input).map(item => item.assetId))
  state.assets.filter(asset => assetIds.has(asset.id) && asset.operationTaskId === task.id).forEach(asset => { asset.operationTaskId = undefined; asset.updatedAt = now() })
  state.directories = state.directories.filter(directory => !directoryIds.has(directory.id))
}

function canRunTask(task: SyncTask, lease?: TaskLease) {
  if (!lease) return task.status === 'queued'
  return task.status === 'running' && task.leaseOwner === lease.workerId && task.runToken === lease.runToken
}

function ownsLease(task: SyncTask, lease?: TaskLease) {
  return !lease || (task.leaseOwner === lease.workerId && task.runToken === lease.runToken)
}

function mergeCandidates(keyword: StoredChunkCandidate[], vector: StoredChunkCandidate[], mode: 'keyword' | 'vector' | 'hybrid') {
  const merged = new Map<string, RankedCandidate>()
  for (const candidate of keyword) merged.set(candidate.chunk.id, { candidate, keywordScore: candidate.score, vectorScore: 0, score: candidate.score })
  for (const candidate of vector) {
    const current = merged.get(candidate.chunk.id)
    if (current) current.vectorScore = candidate.score
    else merged.set(candidate.chunk.id, { candidate, keywordScore: 0, vectorScore: candidate.score, score: candidate.score })
  }
  return [...merged.values()].map(item => ({
    ...item,
    score: mode === 'keyword' ? item.keywordScore : mode === 'vector' ? item.vectorScore : item.keywordScore * 0.45 + item.vectorScore * 0.55,
  })).sort((left, right) => right.score - left.score)
}

function withLatestQueryConfig(indexConfig: KnowledgeConfig, latestConfig: KnowledgeConfig): KnowledgeConfig {
  return {
    ...indexConfig,
    ...(!latestConfig.embeddingModel ? { embeddingSourceId: latestConfig.embeddingSourceId, embeddingMode: latestConfig.embeddingMode, embeddingBaseUrl: latestConfig.embeddingBaseUrl, embeddingApiKey: latestConfig.embeddingApiKey, embeddingModel: '', embeddingDimensions: 0 } : {}),
    keywordRecall: latestConfig.keywordRecall,
    vectorRecall: latestConfig.vectorRecall,
    finalResults: latestConfig.finalResults,
    relevanceThreshold: latestConfig.relevanceThreshold,
    hybridSearch: latestConfig.hybridSearch,
    rerankerEnabled: latestConfig.rerankerEnabled,
    embeddingSources: latestConfig.embeddingSources,
    rerankerSourceId: latestConfig.rerankerSourceId,
    rerankerModel: latestConfig.rerankerModel,
  }
}

function validateDirectoryName(name: string) { const value = name.trim(); if (!value) throw new Error('目录名称不能为空'); if (/[\\/]/.test(value) || value === '.' || value === '..') throw new Error('目录名称不能包含路径分隔符'); return value }
function validateFileName(name: string) { const value = name.trim(); if (!value) throw new Error('文件名称不能为空'); if (/[\\/]/.test(value) || value === '.' || value === '..') throw new Error('文件名称不能包含路径分隔符'); if (!['.md', '.txt'].includes(extname(value).toLocaleLowerCase())) throw new Error('文件名称必须以 .md 或 .txt 结尾'); return value }
function directoryPath(state: DatabaseState, directoryId: string) { const names: string[] = []; const visited = new Set<string>(); let currentId: string | null = directoryId; while (currentId) { if (visited.has(currentId)) throw new Error('目录层级存在循环'); visited.add(currentId); const item = required(state.directories.find(directory => directory.id === currentId), '目录不存在'); names.unshift(item.name); currentId = item.parentId } return names.join('/') }
function directoryDescendants(state: DatabaseState, directoryId: string) { const result = new Set<string>(); const collect = (idValue: string) => { result.add(idValue); state.directories.filter(item => item.parentId === idValue).forEach(item => collect(item.id)) }; collect(directoryId); return result }
function isWithinPath(logicalPath: string, prefix: string) { return logicalPath === prefix || logicalPath.startsWith(`${prefix}/`) }

function selectDefaultKnowledgeBase(state: DatabaseState, projectName: string) {
  const projects = new Map(state.projects.filter(project => project.name === projectName).map(project => [project.id, project]))
  const candidates = state.knowledgeBases.filter(knowledgeBase => projects.has(knowledgeBase.projectId)).map(knowledgeBase => ({
    project: projects.get(knowledgeBase.projectId)!, knowledgeBase,
    assets: state.assets.filter(asset => asset.knowledgeBaseId === knowledgeBase.id && asset.activeVersionId).length,
    directories: state.directories.filter(directory => directory.knowledgeBaseId === knowledgeBase.id).length,
  }))
  candidates.sort((left, right) => right.assets - left.assets || right.directories - left.directories || left.knowledgeBase.createdAt.localeCompare(right.knowledgeBase.createdAt))
  return candidates[0] ? { project: candidates[0].project, knowledgeBase: candidates[0].knowledgeBase } : null
}
function ensureDirectoryPath(state: DatabaseState, knowledgeBaseId: string, segments: string[]) { let parentId: string | null = null; for (const rawName of segments) { const name = validateDirectoryName(rawName); let directory = state.directories.find(item => item.knowledgeBaseId === knowledgeBaseId && item.parentId === parentId && item.name.toLocaleLowerCase() === name.toLocaleLowerCase()); if (!directory) { const createdAt = now(); directory = { id: id('dir'), knowledgeBaseId, name, parentId, createdAt, updatedAt: createdAt }; state.directories.push(directory) } parentId = directory.id } return parentId }

function publishIndex(state: DatabaseState, knowledgeBaseId: string, configVersionId: string, members: string[], indexedChunks?: IndexChunk[]) {
  const kb = required(state.knowledgeBases.find(item => item.id === knowledgeBaseId), '知识库不存在'); const previous = state.indexes.find(item => item.id === kb.activeIndexVersionId)
  const index = createCandidateIndex(state, knowledgeBaseId, configVersionId)
  index.assetVersionIds = [...new Set(members)]; index.indexedChunks = indexedChunks ?? members.flatMap(versionId => {
    const version = state.versions.find(item => item.id === versionId)
    const asset = state.assets.find(item => item.id === version?.assetId)
    return version && asset ? version.chunks.map(chunk => ({ ...chunk, assetMetadata: indexAssetMetadata(asset) })) : []
  })
  activateCandidateIndex(state, index, previous)
  return index
}
function createCandidateIndex(state: DatabaseState, knowledgeBaseId: string, configVersionId: string) {
  required(state.knowledgeBases.find(item => item.id === knowledgeBaseId), '知识库不存在')
  const index = { id: id('idx'), knowledgeBaseId, number: state.indexes.filter(item => item.knowledgeBaseId === knowledgeBaseId).length + 1, status: 'candidate' as const, assetVersionIds: [] as string[], configVersionId, indexedChunks: [] as IndexChunk[], createdAt: now() }
  state.indexes.push(index)
  return index
}
function indexAssetMetadata(asset: DatabaseState['assets'][number]): IndexAssetMetadata {
  return { assetId: asset.id, displayName: asset.displayName, assetType: asset.assetType, sourceType: asset.sourceType, logicalPath: asset.logicalPath }
}

function validateCandidate(candidate: DatabaseState['indexes'][number], task: SyncTask, state: DatabaseState) {
  if (candidate.status !== 'candidate' || candidate.knowledgeBaseId !== task.knowledgeBaseId) throw new Error('候选索引状态不合法')
  if (task.status !== 'running') throw new Error('任务已失效或取消')
  if (candidate.configVersionId !== task.configVersionId) throw new Error('候选索引配置快照不一致')
  const config = required(state.configs.find(item => item.id === candidate.configVersionId), '候选索引配置不存在').config
  if (candidate.indexedChunks?.some(chunk => chunk.assetVersionId && (!candidate.assetVersionIds.includes(chunk.assetVersionId) || chunk.embedding.length !== config.embeddingDimensions))) throw new Error('候选索引 Chunk 或向量维度校验失败')
}
function activateCandidateIndex(state: DatabaseState, candidate: DatabaseState['indexes'][number], previous?: DatabaseState['indexes'][number]) {
  const kb = required(state.knowledgeBases.find(item => item.id === candidate.knowledgeBaseId), '知识库不存在')
  if (candidate.status !== 'candidate') throw new Error('只有候选索引可以激活')
  if (previous && previous.id !== candidate.id) previous.status = 'superseded'
  candidate.status = 'active'; candidate.activatedAt = now(); kb.activeIndexVersionId = candidate.id
}
function required<T>(value: T | null | undefined, message: string): T { if (value == null) throw new Error(message); return value }
function validateConfig(config: KnowledgeConfig) {
  if (config.chunkTargetSize <= 0 || config.chunkMaxSize < config.chunkTargetSize) throw new Error('Chunk 最大大小不得小于目标大小')
  if (config.chunkOverlap < 0 || config.chunkOverlap >= config.chunkTargetSize) throw new Error('Chunk 重叠必须小于目标大小')
  if (config.headingDepth < 1 || config.headingDepth > 6) throw new Error('标题层级必须为 1～6')
  if (config.embeddingModel && config.embeddingDimensions <= 0) throw new Error('请先运行本地模型或测试远程模型，以自动检测向量维度')
  if (!config.embeddingModel && config.embeddingDimensions !== 0) throw new Error('未选择模型时向量维度必须为 0')
  if (config.embeddingBatchSize <= 0 || config.embeddingTimeoutMs <= 0 || config.embeddingRetries < 0) throw new Error('Embedding 参数不合法')
  if (!config.embeddingSources.length) throw new Error('至少需要配置一个模型来源')
  if (new Set(config.embeddingSources.map(source => source.id)).size !== config.embeddingSources.length) throw new Error('模型来源标识不能重复')
  const selectedSource = config.embeddingSources.find(source => source.id === config.embeddingSourceId)
  if (!selectedSource) throw new Error('请选择有效的模型来源')
  if (selectedSource.type !== config.embeddingMode) throw new Error('所选来源与当前模型模式不一致')
  for (const source of config.embeddingSources) {
    if (!source.id.trim() || !source.name.trim()) throw new Error('模型来源名称不能为空')
    if (source.type === 'remote_api' && !/^https?:\/\//i.test(source.baseUrl)) throw new Error(`远程来源 ${source.name} 的 Base URL 必须使用 http:// 或 https://`)
    if (source.models.some(model => !model.name.trim() || model.dimensions < 0)) throw new Error(`模型来源 ${source.name} 包含无效模型`)
  }
  if (config.keywordRecall <= 0 || config.vectorRecall <= 0 || config.finalResults <= 0 || config.relevanceThreshold < 0 || config.relevanceThreshold > 1) throw new Error('检索参数不合法')
  if (config.rerankerEnabled) modelRouteConfig(config, config.rerankerSourceId, config.rerankerModel)
}

function validateEmbeddingProbe(config: KnowledgeConfig) {
  if (!config.embeddingModel.trim()) throw new Error('模型名称不能为空')
  if (config.embeddingBatchSize <= 0 || config.embeddingTimeoutMs <= 0 || config.embeddingRetries < 0) throw new Error('Embedding 请求参数不合法')
}

function normalizeEmbeddingSources(config: KnowledgeConfig, sourceOverride?: EmbeddingSource[]): KnowledgeConfig {
  const provided = sourceOverride ?? (Array.isArray(config.embeddingSources) ? config.embeddingSources : [])
  const fallbackId = config.embeddingSourceId || 'local-default'
  const sources = provided.length ? structuredClone(provided) : [{ id: fallbackId, name: config.embeddingMode === 'local' ? '本地模型' : '默认远程来源', type: config.embeddingMode, baseUrl: config.embeddingBaseUrl, apiKey: config.embeddingApiKey, models: [{ name: config.embeddingModel, dimensions: config.embeddingDimensions }] }]
  const localDefault = sources.find(source => source.id === 'local-default')
  if (!localDefault) sources.unshift(structuredClone(defaultConfig.embeddingSources[0]))
  else { localDefault.baseUrl = ''; localDefault.apiKey = ''; localDefault.name = '本地模型'; localDefault.type = 'local' }
  const selected = sources.find(source => source.id === config.embeddingSourceId) ?? sources[0]
  const selectedModel = selected.models.find(model => model.name === config.embeddingModel) ?? selected.models[0]
  if (!selectedModel) return { ...config, embeddingSources: sources, embeddingSourceId: selected.id, embeddingMode: selected.type, embeddingBaseUrl: selected.baseUrl, embeddingApiKey: selected.apiKey, embeddingModel: '', embeddingDimensions: 0, rerankerEnabled: false, rerankerSourceId: selected.id, rerankerModel: '' }
  const rerankerSource = sources.find(source => source.id === config.rerankerSourceId && source.models.some(model => model.name === config.rerankerModel)) ?? selected
  const rerankerModel = rerankerSource.models.some(model => model.name === config.rerankerModel) ? config.rerankerModel : selectedModel.name
  return { ...config, embeddingSources: sources, embeddingSourceId: selected.id, embeddingMode: selected.type, embeddingBaseUrl: selected.baseUrl, embeddingApiKey: selected.apiKey, embeddingModel: selectedModel.name, embeddingDimensions: selectedModel.dimensions, rerankerSourceId: rerankerSource.id, rerankerModel }
}

function mergeConfigPatch(current: KnowledgeConfig, patch: Partial<KnowledgeConfig>): KnowledgeConfig {
  const currentSources = new Map(current.embeddingSources.map(source => [source.id, source]))
  const embeddingSources = patch.embeddingSources?.map(source => {
    const existing = currentSources.get(source.id)
    const apiKey = source.apiKey === undefined || source.apiKey === '' ? existing?.apiKey ?? '' : source.apiKey
    return { ...source, apiKey }
  }) ?? current.embeddingSources
  const selected = embeddingSources.find(source => source.id === (patch.embeddingSourceId ?? current.embeddingSourceId))
  return {
    ...current,
    ...patch,
    embeddingSources,
    embeddingBaseUrl: selected?.baseUrl ?? patch.embeddingBaseUrl ?? current.embeddingBaseUrl,
    embeddingApiKey: selected?.apiKey ?? patch.embeddingApiKey ?? current.embeddingApiKey,
  }
}

function redactConfig(config: KnowledgeConfig): KnowledgeConfig {
  return {
    ...config,
    embeddingApiKey: '',
    embeddingSources: config.embeddingSources.map(source => ({ ...source, apiKey: '' })),
  }
}

function remoteRoute(config: KnowledgeConfig, sourceId: string, modelName: string): ResolvedEmbeddingRoute {
  const source = config.embeddingSources.find(item => item.id === sourceId)
  if (!source || source.type !== 'remote_api') throw new Error('远程 Embedding 来源不存在')
  if (!source.models.some(model => model.name === modelName)) throw new Error(`远程来源 ${source.name} 中不存在模型 ${modelName}`)
  return { sourceId, model: modelName, baseUrl: source.baseUrl, ...(source.apiKey ? { apiKey: source.apiKey } : {}) }
}

function modelRouteConfig(config: KnowledgeConfig, sourceId: string, modelName: string): KnowledgeConfig {
  if (!modelName.trim()) throw new Error('启用 Reranker 后必须选择模型')
  const source = config.embeddingSources.find(item => item.id === sourceId)
  if (!source) throw new Error('Reranker 模型来源不存在')
  const model = source.models.find(item => item.name === modelName)
  if (!model) throw new Error(`Reranker 来源 ${source.name} 中不存在模型 ${modelName}`)
  if (model.dimensions <= 0) throw new Error(`请先检测 Reranker 模型 ${modelName} 的向量维度`)
  return { ...config, embeddingSourceId: source.id, embeddingMode: source.type, embeddingBaseUrl: source.baseUrl, embeddingApiKey: source.apiKey, embeddingModel: model.name, embeddingDimensions: model.dimensions }
}

function scrubLegacyEmbeddingSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map(scrubLegacyEmbeddingSecrets) as T
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !['embeddingApiKey', 'embeddingBaseUrl', 'apiKey', 'baseUrl'].includes(key))
      .map(([key, item]) => [key, scrubLegacyEmbeddingSecrets(item)]),
  ) as T
}

function safeErrorMessage(message: string) {
  return message
    .replace(/https?:\/\/[^\s'"`]+/giu, '[已隐藏地址]')
    .replace(/(?:bearer|api[_ -]?key|token)\s*[:=]?\s*[^\s,;]+/giu, '$1 [已隐藏]')
    .slice(0, 240)
}
