import { extname, isAbsolute } from 'node:path'
import { defaultConfig, type AssetType, type AssetVersion, type Chunk, type DatabaseState, type KnowledgeConfig, type SourceType, type SyncTask } from '../domain/types.js'
import type { StateStore } from '../infrastructure/store.js'
import { RawDocumentStore } from '../infrastructure/raw-document-store.js'
import type { LocalModelRuntime } from '../infrastructure/local-model-runtime.js'
import { RemoteEmbeddingClient } from '../infrastructure/remote-embedding-client.js'
import type { StoredChunkCandidate } from '../infrastructure/store.js'
import { chunkDocument, cosine, defaultTokenCodec, embedding, sha256, type TokenCodec } from './content.js'

type RetrievalInput = { assetType?: AssetType; sourceType?: SourceType; logicalPath?: string }
type RankedCandidate = { candidate: StoredChunkCandidate; keywordScore: number; vectorScore: number; rerankerScore?: number; score: number }

const now = () => new Date().toISOString()
const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`
const compatibilityFingerprint = (config: KnowledgeConfig) => sha256(JSON.stringify({ parserVersion: config.parserVersion, preprocessVersion: config.preprocessVersion, chunkTargetSize: config.chunkTargetSize, chunkMaxSize: config.chunkMaxSize, chunkOverlap: config.chunkOverlap, headingDepth: config.headingDepth, embeddingMode: config.embeddingMode, embeddingBaseUrl: config.embeddingBaseUrl, embeddingModel: config.embeddingModel, embeddingDimensions: config.embeddingDimensions }))
const queryFingerprint = (config: KnowledgeConfig) => sha256(JSON.stringify({ keywordRecall: config.keywordRecall, vectorRecall: config.vectorRecall, finalResults: config.finalResults, relevanceThreshold: config.relevanceThreshold, hybridSearch: config.hybridSearch, rerankerEnabled: config.rerankerEnabled, rerankerModel: config.rerankerModel }))

export class KnowledgeService {
  constructor(readonly store: StateStore, private readonly rawDocuments?: RawDocumentStore, private readonly localModels?: LocalModelRuntime, private readonly remoteEmbeddings = new RemoteEmbeddingClient()) {}
  async initialize() {
    await this.store.load()
    await this.store.transaction(state => {
      state.directories ??= []
      state.configs.forEach(item => { const legacyHashModel = !item.config.embeddingModel || item.config.embeddingModel === 'hash-embedding-v1'; item.config = { ...defaultConfig, ...item.config, embeddingMode: item.config.embeddingMode ?? 'local', ...(legacyHashModel ? { embeddingModel: defaultConfig.embeddingModel, embeddingDimensions: defaultConfig.embeddingDimensions, rerankerModel: defaultConfig.rerankerModel } : {}) } })
      state.versions.forEach(version => version.chunks.forEach(chunk => { chunk.tokenCount ??= defaultTokenCodec.count(chunk.content) }))
      state.assets.forEach(asset => ensureDirectoryPath(state, asset.knowledgeBaseId, asset.logicalPath.replaceAll('\\', '/').split('/').slice(0, -1)))
    })
  }

  async recoverInterruptedRebuilds() {
    return this.store.transaction(state => state.tasks.filter(task => task.type === 'rebuild' && ['queued', 'running'].includes(task.status)).map(task => {
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
    const existing = selectDefaultKnowledgeBase(this.store.read(), normalizedName)
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

  overview(knowledgeBaseId: string) {
    const state = this.store.read(); const kb = required(state.knowledgeBases.find(item => item.id === knowledgeBaseId), '知识库不存在')
    const assets = state.assets.filter(item => item.knowledgeBaseId === knowledgeBaseId)
    const versions = state.versions.filter(item => assets.some(asset => asset.id === item.assetId))
    const tasks = state.tasks.filter(item => item.knowledgeBaseId === knowledgeBaseId)
    const countBy = (key: 'assetType' | 'sourceType') => Object.fromEntries([...new Set(assets.map(item => item[key]))].map(value => [value, assets.filter(item => item[key] === value).length]))
    return { knowledgeBase: kb, counts: { assets: assets.length, ready: versions.filter(item => item.status === 'ready').length, syncing: versions.filter(item => item.status === 'syncing' || item.status === 'pending').length, failed: versions.filter(item => item.status === 'failed').length }, byAssetType: countBy('assetType'), bySource: countBy('sourceType'), activeIndex: state.indexes.find(item => item.id === kb.activeIndexVersionId) ?? null, latestTask: tasks.at(-1) ?? null, latestFailure: tasks.filter(item => item.status === 'failed').at(-1) ?? null }
  }

  config(knowledgeBaseId: string) {
    const state = this.store.read(); const kb = required(state.knowledgeBases.find(item => item.id === knowledgeBaseId), '知识库不存在')
    return required(state.configs.find(item => item.id === kb.activeConfigVersionId), '配置不存在')
  }

  async saveConfig(knowledgeBaseId: string, patch: Partial<KnowledgeConfig>) {
    return this.store.transaction(async state => {
      const kb = required(state.knowledgeBases.find(item => item.id === knowledgeBaseId), '知识库不存在')
      const current = required(state.configs.find(item => item.id === kb.activeConfigVersionId), '配置不存在')
      const config = { ...current.config, ...patch }
      validateConfig(config)
      if (JSON.stringify(config) === JSON.stringify(current.config)) return { changed: false, configVersion: current, impact: 'none' }
      const compatible = compatibilityFingerprint(config) === current.compatibilityFingerprint
      const queryOnly = compatible && queryFingerprint(config) !== queryFingerprint(current.config)
      const version = { id: id('cfg'), knowledgeBaseId, version: current.version + 1, config, createdAt: now(), compatibilityFingerprint: compatibilityFingerprint(config), requiresRebuild: !compatible && Boolean(kb.activeIndexVersionId) }
      state.configs.push(version); kb.activeConfigVersionId = version.id
      return { changed: true, configVersion: version, impact: !compatible ? 'index_rebuild' : queryOnly ? 'query' : 'ingestion' }
    })
  }

  directories(knowledgeBaseId: string) {
    required(this.store.read().knowledgeBases.find(item => item.id === knowledgeBaseId), '知识库不存在')
    return this.store.read().directories.filter(item => item.knowledgeBaseId === knowledgeBaseId).sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  async createDirectory(knowledgeBaseId: string, name: string, parentId: string | null) {
    return this.store.transaction(state => {
      required(state.knowledgeBases.find(item => item.id === knowledgeBaseId), '知识库不存在')
      const normalizedName = validateDirectoryName(name)
      if (parentId) { const parent = required(state.directories.find(item => item.id === parentId), '父目录不存在'); if (parent.knowledgeBaseId !== knowledgeBaseId) throw new Error('父目录不属于当前知识库') }
      if (state.directories.some(item => item.knowledgeBaseId === knowledgeBaseId && item.parentId === parentId && item.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) throw new Error('同一目录下已存在相同名称')
      const createdAt = now(); const directory = { id: id('dir'), knowledgeBaseId, name: normalizedName, parentId, createdAt, updatedAt: createdAt }
      state.directories.push(directory); return directory
    })
  }

  async renameDirectory(directoryId: string, name: string) {
    return this.store.transaction(async state => {
      const directory = required(state.directories.find(item => item.id === directoryId), '目录不存在')
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
      const descendants = directoryDescendants(state, directory.id)
      const oldPrefix = directoryPath(state, directory.id)
      if (mode === 'move') {
        if (targetParentId && descendants.has(targetParentId)) throw new Error('不能移动到当前目录或其子目录')
        if (targetParentId) { const target = required(state.directories.find(item => item.id === targetParentId), '目标目录不存在'); if (target.knowledgeBaseId !== directory.knowledgeBaseId) throw new Error('目标目录不属于当前知识库') }
        const newPrefix = targetParentId ? directoryPath(state, targetParentId) : ''
        const affectedAssets = await this.relocateAssets(state, directory.knowledgeBaseId, oldPrefix, newPrefix)
        state.directories.filter(item => item.parentId === directory.id).forEach(item => { item.parentId = targetParentId; item.updatedAt = now() })
        state.directories = state.directories.filter(item => item.id !== directory.id)
        return { mode, deletedDirectoryIds: [directory.id], affectedAssets }
      }
      const affectedAssets = state.assets.filter(asset => asset.knowledgeBaseId === directory.knowledgeBaseId && isWithinPath(asset.logicalPath, oldPrefix))
      for (const asset of affectedAssets) {
        const active = state.versions.find(item => item.id === asset.activeVersionId)
        if (active) { active.status = 'deleted'; if (this.rawDocuments) await this.rawDocuments.deleteActive(directory.knowledgeBaseId, asset.logicalPath) }
        asset.activeVersionId = null; asset.updatedAt = now()
      }
      state.directories = state.directories.filter(item => !descendants.has(item.id))
      const kb = required(state.knowledgeBases.find(item => item.id === directory.knowledgeBaseId), '知识库不存在')
      if (kb.activeIndexVersionId) publishIndex(state, kb.id, kb.activeConfigVersionId, state.assets.filter(item => item.knowledgeBaseId === kb.id && item.activeVersionId).map(item => item.activeVersionId!))
      return { mode, deletedDirectoryIds: [...descendants], affectedAssets: affectedAssets.length }
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
      const savedConfigVersion = required(state.configs.find(item => item.id === kb.activeConfigVersionId), '配置不存在')
      const activeIndex = state.indexes.find(item => item.id === kb.activeIndexVersionId)
      const configVersion = savedConfigVersion.requiresRebuild && activeIndex ? required(state.configs.find(item => item.id === activeIndex.configVersionId), '活动索引配置不存在') : savedConfigVersion
      ensureDirectoryPath(state, input.knowledgeBaseId, input.logicalPath.replaceAll('\\', '/').split('/').slice(0, -1))
      let asset = state.assets.find(item => item.knowledgeBaseId === input.knowledgeBaseId && item.logicalPath.toLocaleLowerCase() === input.logicalPath.toLocaleLowerCase())
      const activeVersion = asset ? state.versions.find(item => item.id === asset!.activeVersionId) : undefined
      if (activeVersion?.contentHash === contentHash) return { deduplicated: true, asset, version: activeVersion, task: null }
      if (!asset) {
        asset = { id: id('ast'), knowledgeBaseId: input.knowledgeBaseId, displayName: input.displayName, logicalPath: input.logicalPath, assetType: input.assetType, sourceType: input.sourceType, sourceKey: input.sourceKey, activeVersionId: null, createdAt: now(), updatedAt: now() }
        state.assets.push(asset)
      }
      const previous = activeVersion?.chunks ?? []
      const version: AssetVersion = { id: id('av'), assetId: asset.id, number: state.versions.filter(item => item.assetId === asset!.id).length + 1, content: input.content, contentHash, status: 'syncing', configVersionId: configVersion.id, createdAt: now(), chunks: await this.createChunks(input.content, configVersion.config, previous) }
      if (this.rawDocuments) Object.assign(version, await this.rawDocuments.save(input.knowledgeBaseId, input.logicalPath, version.id, input.content))
      version.chunks.forEach(chunk => { chunk.assetVersionId = version.id })
      const task: SyncTask = { id: id('task'), knowledgeBaseId: input.knowledgeBaseId, type: 'sync', trigger: input.taskTrigger ?? input.sourceType, status: 'running', step: 'embedding', progress: 60, attempts: input.attempts ?? 1, input: { assetId: asset.id, assetVersionId: version.id, logicalPath: input.logicalPath }, configVersionId: configVersion.id, createdAt: now(), startedAt: now(), metrics: { chunks: version.chunks.length, reusedChunks: version.chunks.filter(item => item.reused).length, embeddedChunks: version.chunks.filter(item => !item.reused).length } }
      state.versions.push(version); state.tasks.push(task)
      if (input.simulateFailureAt) { version.status = 'failed'; version.error = `模拟 ${input.simulateFailureAt} 阶段失败`; task.status = 'failed'; task.step = input.simulateFailureAt; task.error = version.error; task.finishedAt = now(); return { deduplicated: false, asset, version, task } }
      publishIndex(state, kb.id, configVersion.id, [...state.assets.filter(item => item.knowledgeBaseId === kb.id && item.activeVersionId).map(item => item.activeVersionId!), version.id])
      version.status = 'ready'; version.readyAt = now(); asset.activeVersionId = version.id; asset.updatedAt = now(); asset.displayName = input.displayName; asset.assetType = input.assetType; asset.sourceKey = input.sourceKey; asset.sourceType = input.sourceType
      task.status = 'succeeded'; task.step = 'completed'; task.progress = 100; task.finishedAt = now()
      return { deduplicated: false, asset, version, task }
    })
  }

  assets(knowledgeBaseId: string, filters: { assetType?: string; sourceType?: string; status?: string; path?: string; includeDeleted?: boolean; query?: string } = {}) {
    const state = this.store.read()
    return state.assets.filter(asset => asset.knowledgeBaseId === knowledgeBaseId).map(asset => ({ ...asset, activeVersion: state.versions.find(version => version.id === asset.activeVersionId) ?? null, versions: state.versions.filter(version => version.assetId === asset.id).map(version => ({ ...version, content: undefined })) })).filter(asset => (!filters.assetType || asset.assetType === filters.assetType) && (!filters.sourceType || asset.sourceType === filters.sourceType) && (!filters.status || asset.activeVersion?.status === filters.status) && (!filters.path || asset.logicalPath.includes(filters.path)) && (filters.includeDeleted || Boolean(asset.activeVersion)) && (!filters.query || `${asset.displayName} ${asset.logicalPath} ${asset.activeVersion?.content}`.toLocaleLowerCase().includes(filters.query.toLocaleLowerCase())))
  }

  version(versionId: string) { return required(this.store.read().versions.find(item => item.id === versionId), '资产版本不存在') }

  tasks(knowledgeBaseId: string) { return this.store.read().tasks.filter(item => item.knowledgeBaseId === knowledgeBaseId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }
  task(taskId: string) { return required(this.store.read().tasks.find(item => item.id === taskId), '任务不存在') }

  async retry(taskId: string) {
    const state = this.store.read(); const task = required(state.tasks.find(item => item.id === taskId), '任务不存在')
    if (task.status !== 'failed') throw new Error('只有失败任务可以重试')
    const version = required(state.versions.find(item => item.id === task.input.assetVersionId), '失败资产版本不存在'); const asset = required(state.assets.find(item => item.id === version.assetId), '知识资产不存在')
    return this.ingest({ knowledgeBaseId: task.knowledgeBaseId, sourceType: asset.sourceType, sourceKey: asset.sourceKey, assetType: asset.assetType, displayName: asset.displayName, logicalPath: asset.logicalPath, content: version.content, taskTrigger: 'retry', attempts: task.attempts + 1 })
  }

  async deleteAsset(assetId: string) {
    return this.store.transaction(async state => {
      const asset = required(state.assets.find(item => item.id === assetId), '知识资产不存在'); const active = required(state.versions.find(item => item.id === asset.activeVersionId), '活动版本不存在'); const kb = required(state.knowledgeBases.find(item => item.id === asset.knowledgeBaseId), '知识库不存在')
      const task: SyncTask = { id: id('task'), knowledgeBaseId: kb.id, type: 'delete', trigger: 'manual', status: 'running', step: 'building_candidate', progress: 60, attempts: 1, input: { assetId, assetVersionId: active.id }, configVersionId: kb.activeConfigVersionId, createdAt: now(), startedAt: now() }
      state.tasks.push(task); const members = state.assets.filter(item => item.knowledgeBaseId === kb.id && item.id !== assetId && item.activeVersionId).map(item => item.activeVersionId!); publishIndex(state, kb.id, kb.activeConfigVersionId, members)
      if (this.rawDocuments) await this.rawDocuments.deleteActive(kb.id, asset.logicalPath)
      active.status = 'deleted'; asset.activeVersionId = null; asset.updatedAt = now(); task.status = 'succeeded'; task.step = 'completed'; task.progress = 100; task.finishedAt = now(); return { asset, task }
    })
  }

  async updateAsset(assetId: string, patch: { displayName?: string; targetDirectoryId?: string | null }) {
    return this.store.transaction(async state => {
      const asset = required(state.assets.find(item => item.id === assetId), '知识资产不存在')
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

  async search(knowledgeBaseId: string, input: { query: string; mode?: 'keyword' | 'vector' | 'hybrid'; assetType?: AssetType; sourceType?: SourceType; logicalPath?: string }) {
    const state = this.store.read(); const kb = required(state.knowledgeBases.find(item => item.id === knowledgeBaseId), '知识库不存在')
    const query = input.query.trim()
    if (!query) throw new Error('检索内容不能为空')
    if (!state.versions.some(item => item.status === 'ready' && state.assets.some(asset => asset.knowledgeBaseId === knowledgeBaseId && asset.activeVersionId === item.id))) return { status: 'no_ready_assets', results: [] }
    if (!kb.activeIndexVersionId) return { status: 'no_active_index', results: [] }
    const index = required(state.indexes.find(item => item.id === kb.activeIndexVersionId), '活动索引不存在')
    const indexConfig = required(state.configs.find(item => item.id === index.configVersionId), '索引配置不存在').config
    const latestConfig = required(state.configs.find(item => item.id === kb.activeConfigVersionId), '当前查询配置不存在').config
    const config = withLatestQueryConfig(indexConfig, latestConfig)
    const mode = input.mode ?? (config.hybridSearch ? 'hybrid' : 'keyword')
    const queryVector = mode === 'keyword' ? undefined : (await this.embedTexts(config, [query]))[0]
    const [keywordCandidates, vectorCandidates] = await Promise.all([
      mode === 'vector' ? Promise.resolve([]) : this.recall(index, config, 'keyword', query, undefined, config.keywordRecall, input),
      mode === 'keyword' ? Promise.resolve([]) : this.recall(index, config, 'vector', query, queryVector, config.vectorRecall, input),
    ])
    const merged = mergeCandidates(keywordCandidates, vectorCandidates, mode)
    const reranked = config.rerankerEnabled && merged.length ? await this.rerank(config, query, merged) : merged
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
      retrieval: { mode, minimumRelevance: config.relevanceThreshold, keywordCandidates: keywordCandidates.length, vectorCandidates: vectorCandidates.length, mergedCandidates: merged.length, eligibleCandidates: eligible.length, returned: candidates.length, rerankerEnabled: config.rerankerEnabled },
      results: candidates,
    }
  }

  async rebuild(knowledgeBaseId: string, outcome: 'success' | 'failure' | 'cancel' = 'success') {
    return this.store.transaction(async state => {
      const kb = required(state.knowledgeBases.find(item => item.id === knowledgeBaseId), '知识库不存在'); const oldIndexId = kb.activeIndexVersionId
      const task: SyncTask = { id: id('task'), knowledgeBaseId, type: 'rebuild', trigger: 'manual', status: 'running', step: 'building_candidate', progress: 70, attempts: 1, input: { oldIndexId }, configVersionId: kb.activeConfigVersionId, createdAt: now(), startedAt: now() }
      state.tasks.push(task)
      if (outcome !== 'success') { task.status = outcome === 'failure' ? 'failed' : 'cancelled'; task.error = outcome === 'failure' ? '模拟索引校验失败' : undefined; task.finishedAt = now(); return { task, activeIndexVersionId: oldIndexId } }
      const members = state.assets.filter(item => item.knowledgeBaseId === knowledgeBaseId && item.activeVersionId).map(item => item.activeVersionId!)
      const config = required(state.configs.find(item => item.id === kb.activeConfigVersionId), '配置不存在')
      const rebuiltChunks: Chunk[] = []
      for (const versionId of members) {
        const version = required(state.versions.find(item => item.id === versionId), '资产版本不存在')
        const chunks = (await this.createChunks(version.content, config.config)).map(chunk => ({ ...chunk, assetVersionId: version.id }))
        version.chunks = chunks
        rebuiltChunks.push(...chunks)
      }
      const index = publishIndex(state, knowledgeBaseId, kb.activeConfigVersionId, members, rebuiltChunks); config.requiresRebuild = false; task.status = 'succeeded'; task.step = 'completed'; task.progress = 100; task.finishedAt = now(); task.metrics = { chunks: rebuiltChunks.length, embeddedChunks: rebuiltChunks.length }; return { task, index, previousIndexVersionId: oldIndexId }
    })
  }

  async queueRebuild(knowledgeBaseId: string) {
    return this.store.transaction(state => {
      const kb = required(state.knowledgeBases.find(item => item.id === knowledgeBaseId), '知识库不存在')
      const existing = state.tasks.find(item => item.knowledgeBaseId === knowledgeBaseId && item.type === 'rebuild' && ['queued', 'running'].includes(item.status))
      if (existing) return existing
      const task = { id: id('task'), knowledgeBaseId, type: 'rebuild' as const, trigger: 'manual' as const, status: 'queued' as const, step: 'waiting', progress: 0, attempts: 1, input: { oldIndexId: kb.activeIndexVersionId }, configVersionId: kb.activeConfigVersionId, createdAt: now() }
      state.tasks.push(task); return task
    })
  }

  async processQueuedRebuild(taskId: string) {
    const accepted = await this.store.transaction(state => { const task = required(state.tasks.find(item => item.id === taskId), '任务不存在'); if (task.status !== 'queued') return false; task.status = 'running'; task.step = 'building_candidate'; task.progress = 35; task.startedAt = now(); return true })
    if (!accepted) return null
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
    if (this.store.read().tasks.find(item => item.id === taskId)?.status === 'cancelled') return null
    try {
      const queued = required(this.store.read().tasks.find(item => item.id === taskId), '任务不存在')
      const result = await this.rebuild(queued.knowledgeBaseId, 'success')
      return this.store.transaction(state => {
        const task = required(state.tasks.find(item => item.id === taskId), '任务不存在'); const generatedIndex = state.tasks.findIndex(item => item.id === result.task.id)
        if (generatedIndex >= 0) state.tasks.splice(generatedIndex, 1)
        if (task.status === 'cancelled') return task
        task.status = 'succeeded'; task.step = 'completed'; task.progress = 100; task.finishedAt = now(); task.metrics = result.task.metrics; return task
      })
    } catch (error) {
      return this.store.transaction(state => {
        const task = required(state.tasks.find(item => item.id === taskId), '任务不存在')
        if (task.status === 'cancelled') return task
        task.status = 'failed'; task.step = 'failed'; task.error = error instanceof Error ? error.message : '索引重建失败'; task.finishedAt = now(); return task
      })
    }
  }

  async cancelTask(taskId: string) {
    return this.store.transaction(state => { const task = required(state.tasks.find(item => item.id === taskId), '任务不存在'); if (!['queued', 'running'].includes(task.status)) throw new Error('只有等待中或运行中的任务可以取消'); task.status = 'cancelled'; task.step = 'cancelled'; task.finishedAt = now(); return task })
  }

  private async createChunks(content: string, config: KnowledgeConfig, previous: Chunk[] = []): Promise<Chunk[]> {
    const tokenizer = await this.tokenizer(config)
    const chunks: Chunk[] = chunkDocument(content, config, previous, tokenizer)
    chunks.filter(chunk => chunk.reused && chunk.embedding.length !== config.embeddingDimensions).forEach(chunk => { chunk.reused = false; chunk.embedding = [] })
    const changed = chunks.filter(chunk => !chunk.reused)
    const vectors = await this.embedTexts(config, changed.map(chunk => chunk.content))
    changed.forEach((chunk, index) => { chunk.embedding = required(vectors[index], '本地模型未返回完整向量结果') })
    return chunks
  }

  private async tokenizer(config: KnowledgeConfig): Promise<TokenCodec> {
    if (config.embeddingMode === 'remote_api') return this.remoteEmbeddings.tokenCodec(config.embeddingModel)
    return (this.localModels ? await this.localModels.tokenCodec(config.embeddingModel) : null) ?? defaultTokenCodec
  }

  private async embedTexts(config: KnowledgeConfig, texts: string[], model = config.embeddingModel) {
    if (!texts.length) return []
    if (config.embeddingMode === 'remote_api') return this.remoteEmbeddings.embed(config, texts, model)
    if (this.localModels) {
      await this.localModels.ensureRunning(model)
      const vectors: number[][] = []
      for (let offset = 0; offset < texts.length; offset += config.embeddingBatchSize) vectors.push(...await this.localModels.embed(model, texts.slice(offset, offset + config.embeddingBatchSize)))
      return vectors
    }
    return texts.map(text => embedding(text, config.embeddingDimensions))
  }

  private async recall(index: DatabaseState['indexes'][number], config: KnowledgeConfig, mode: 'keyword' | 'vector', query: string, queryVector: number[] | undefined, limit: number, filters: RetrievalInput) {
    if (this.store.searchChunks) return this.store.searchChunks({ versionIds: index.assetVersionIds, mode, query, queryVector, dimensions: config.embeddingDimensions, limit, assetType: filters.assetType, sourceType: filters.sourceType, logicalPath: filters.logicalPath })
    const state = this.store.read()
    const terms = query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []
    return index.assetVersionIds.flatMap(versionId => {
      const version = state.versions.find(item => item.id === versionId)
      const asset = state.assets.find(item => item.id === version?.assetId)
      if (!version || !asset || (filters.assetType && asset.assetType !== filters.assetType) || (filters.sourceType && asset.sourceType !== filters.sourceType) || (filters.logicalPath && !asset.logicalPath.includes(filters.logicalPath))) return []
      const chunks = index.indexedChunks?.filter(chunk => chunk.assetVersionId === version.id) ?? version.chunks
      return chunks.map(chunk => {
        const text = chunk.content.toLocaleLowerCase()
        const score = mode === 'keyword'
          ? (terms.length ? terms.filter(term => text.includes(term)).length / terms.length : 0)
          : (cosine(required(queryVector, '查询向量不存在'), chunk.embedding) + 1) / 2
        return { score, asset: { id: asset.id, displayName: asset.displayName, assetType: asset.assetType, sourceType: asset.sourceType, logicalPath: asset.logicalPath }, version: { id: version.id, number: version.number }, chunk: { id: chunk.id, chunkKey: chunk.chunkKey, headingPath: chunk.headingPath, startLine: chunk.startLine, endLine: chunk.endLine, startChar: chunk.startChar, endChar: chunk.endChar }, content: chunk.content } satisfies StoredChunkCandidate
      })
    }).sort((left, right) => right.score - left.score).slice(0, limit)
  }

  private async rerank(config: KnowledgeConfig, query: string, candidates: RankedCandidate[]) {
    const vectors = await this.embedTexts(config, [query, ...candidates.map(item => item.candidate.content)], config.rerankerModel)
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
    keywordRecall: latestConfig.keywordRecall,
    vectorRecall: latestConfig.vectorRecall,
    finalResults: latestConfig.finalResults,
    relevanceThreshold: latestConfig.relevanceThreshold,
    hybridSearch: latestConfig.hybridSearch,
    rerankerEnabled: latestConfig.rerankerEnabled,
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

function publishIndex(state: DatabaseState, knowledgeBaseId: string, configVersionId: string, members: string[], indexedChunks?: Chunk[]) {
  const kb = required(state.knowledgeBases.find(item => item.id === knowledgeBaseId), '知识库不存在'); const previous = state.indexes.find(item => item.id === kb.activeIndexVersionId)
  const index = { id: id('idx'), knowledgeBaseId, number: state.indexes.filter(item => item.knowledgeBaseId === knowledgeBaseId).length + 1, status: 'active' as const, assetVersionIds: [...new Set(members)], configVersionId, indexedChunks: indexedChunks ?? members.flatMap(versionId => state.versions.find(item => item.id === versionId)?.chunks ?? []), createdAt: now(), activatedAt: now() }
  if (previous) previous.status = 'superseded'; state.indexes.push(index); kb.activeIndexVersionId = index.id; return index
}
function required<T>(value: T | null | undefined, message: string): T { if (value == null) throw new Error(message); return value }
function validateConfig(config: KnowledgeConfig) {
  if (config.chunkTargetSize <= 0 || config.chunkMaxSize < config.chunkTargetSize) throw new Error('Chunk 最大大小不得小于目标大小')
  if (config.chunkOverlap < 0 || config.chunkOverlap >= config.chunkTargetSize) throw new Error('Chunk 重叠必须小于目标大小')
  if (config.headingDepth < 1 || config.headingDepth > 6) throw new Error('标题层级必须为 1～6')
  if (config.embeddingDimensions <= 0 || config.embeddingBatchSize <= 0 || config.embeddingTimeoutMs <= 0 || config.embeddingRetries < 0) throw new Error('Embedding 参数不合法')
  if (config.embeddingMode === 'remote_api' && !/^https?:\/\//i.test(config.embeddingBaseUrl)) throw new Error('远程 Embedding Base URL 必须使用 http:// 或 https://')
  if (config.keywordRecall <= 0 || config.vectorRecall <= 0 || config.finalResults <= 0 || config.relevanceThreshold < 0 || config.relevanceThreshold > 1) throw new Error('检索参数不合法')
  if (config.rerankerEnabled && !config.rerankerModel) throw new Error('启用 Reranker 后必须选择模型')
}
