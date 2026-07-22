import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { KnowledgeService, JsonStore, type AssetType } from '../server/index.js'
import { RawDocumentStore } from '../server/infrastructure/raw-document-store.js'

async function fixture() {
  const service = new KnowledgeService(new JsonStore(null)); await service.initialize()
  const created = await service.createProject('验收项目'); return { service, kbId: created.knowledgeBase!.id }
}

async function ingestReady(service: KnowledgeService, input: Parameters<KnowledgeService['ingest']>[0]) {
  const queued = await service.ingest(input)
  if (queued.task) await service.processTask(queued.task.id)
  return {
    ...queued,
    asset: (await service.assets(input.knowledgeBaseId, { includeDeleted: true })).find(item => item.id === queued.asset?.id) ?? queued.asset,
    version: await service.version(queued.version.id),
    task: queued.task ? await service.task(queued.task.id) : null,
  }
}

const document = (section = '退款请求必须携带幂等键。') => `# 支付平台\n\n## 退款规则\n\n${section}\n\n## 审计\n\n所有操作记录审计日志。`

test('AC-001 创建项目时自动创建唯一默认知识库', async () => {
  const { service, kbId } = await fixture(); const overview = await service.overview(kbId)
  assert.equal(overview.knowledgeBase.activeIndexVersionId, null); assert.equal(overview.counts.assets, 0)
})

test('默认知识库由后端稳定复用且并发初始化不创建空库', async () => {
  const service = new KnowledgeService(new JsonStore(null)); await service.initialize()
  const [first, second] = await Promise.all([service.ensureDefaultKnowledgeBase(), service.ensureDefaultKnowledgeBase()])
  assert.equal(first.knowledgeBase.id, second.knowledgeBase.id)
  assert.equal(service.store.read().knowledgeBases.length, 1)
  const other = await service.createProject('SmartHub')
  await ingestReady(service, { knowledgeBaseId: other.knowledgeBase!.id, sourceType: 'upload', sourceKey: 'persisted.md', assetType: 'requirement', displayName: '持久化资料', logicalPath: 'persisted.md', content: document() })
  const selected = await service.ensureDefaultKnowledgeBase()
  assert.equal(selected.knowledgeBase.id, other.knowledgeBase!.id)
  const cleanup = await service.cleanupEmptyDefaultKnowledgeBases()
  assert.deepEqual(cleanup.deletedKnowledgeBaseIds, [first.knowledgeBase.id])
  assert.equal(service.store.read().knowledgeBases.length, 1)
})

test('AC-002/003 多类型资料统一接入且相同内容短路', async () => {
  const { service, kbId } = await fixture()
  const types: AssetType[] = ['requirement', 'technical_design', 'api_spec', 'test_case', 'test_report']
  for (const [index, assetType] of types.entries()) await ingestReady(service, { knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: `${index}.md`, assetType, displayName: assetType, logicalPath: `${assetType}.md`, content: document(assetType) })
  const before = service.store.read(); const duplicate = await service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: '0.md', assetType: 'requirement', displayName: 'requirement', logicalPath: 'requirement.md', content: document('requirement') })
  const after = service.store.read(); assert.equal(duplicate.deduplicated, true); assert.equal(after.versions.length, before.versions.length); assert.equal(after.tasks.length, before.tasks.length); assert.equal((await service.assets(kbId, { assetType: 'test_case' })).length, 1)
})

test('AC-004 局部修改仅计算变化 Chunk 并保留历史版本', async () => {
  const { service, kbId } = await fixture()
  const first = await ingestReady(service, { knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'requirements.md', assetType: 'requirement', displayName: '需求', logicalPath: 'requirements.md', content: document() })
  const second = await ingestReady(service, { knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'requirements.md', assetType: 'requirement', displayName: '需求', logicalPath: 'requirements.md', content: document('退款请求必须携带全局唯一幂等键。') })
  assert.equal(first.asset!.id, second.asset!.id); assert.equal(second.version.number, 2); assert.ok((second.task?.metrics?.reusedChunks ?? 0) >= 1); assert.ok((second.task?.metrics?.embeddedChunks ?? 0) >= 1); assert.equal((await service.assets(kbId))[0].versions.length, 2)
})

test('上传文件写入系统默认知识库目录并保存不可变版本快照', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'smarthub-documents-')); const service = new KnowledgeService(new JsonStore(null), new RawDocumentStore(root)); await service.initialize(); const created = await service.createProject('文件落盘验收'); const kbId = created.knowledgeBase!.id
  const synced = await ingestReady(service, { knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'browser:a.md', assetType: '自定义业务规范', displayName: 'a.md', logicalPath: 'requirements/payment/a.md', content: document() })
  assert.equal(await readFile(resolve(root, kbId, 'files', 'requirements', 'payment', 'a.md'), 'utf8'), document()); assert.equal(await readFile(resolve(root, synced.version.snapshotPath!), 'utf8'), document()); assert.equal(synced.asset?.assetType, '自定义业务规范'); await assert.rejects(() => service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'escape', assetType: 'other', displayName: 'escape.md', logicalPath: '../escape.md', content: 'escape' }), /逻辑路径/)
})

test('知识库目录创建、重命名和删除均持久化', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'smarthub-directories-'))
  const dataFile = resolve(root, 'state.json')
  const documentsRoot = resolve(root, 'knowledge-bases')
  const service = new KnowledgeService(new JsonStore(dataFile), new RawDocumentStore(documentsRoot)); await service.initialize(); const created = await service.createProject('目录验收'); const kbId = created.knowledgeBase!.id
  const requirements = await service.createDirectory(kbId, '需求文档', null)
  const payment = await service.createDirectory(kbId, '支付', requirements.id)
  await ingestReady(service, { knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'browser:需求文档/支付/a.md', assetType: '需求', displayName: 'a.md', logicalPath: '需求文档/支付/a.md', content: document() })
  await service.renameDirectory(requirements.id, '产品需求')
  assert.equal((await service.assets(kbId))[0].logicalPath, '产品需求/支付/a.md')
  assert.equal(await readFile(resolve(documentsRoot, kbId, 'files', '产品需求', '支付', 'a.md'), 'utf8'), document())
  const reloaded = new KnowledgeService(new JsonStore(dataFile), new RawDocumentStore(documentsRoot)); await reloaded.initialize()
  assert.deepEqual((await reloaded.directories(kbId)).map(item => item.name), ['产品需求', '支付'])
  const deletion = await reloaded.deleteDirectory(payment.id, 'recursive')
  assert.ok('task' in deletion)
  await reloaded.processTask(deletion.task.id)
  assert.equal((await reloaded.directories(kbId)).some(item => item.id === payment.id), false)
  assert.equal((await reloaded.assets(kbId)).length, 0)
})

test('目录清理失败仅重试文件清理并保持删除范围锁', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'smarthub-directory-cleanup-'))
  const documentsRoot = resolve(root, 'knowledge-bases')
  const storage = new RawDocumentStore(documentsRoot)
  let failCleanup = true
  const failingStorage = Object.assign(Object.create(Object.getPrototypeOf(storage)), storage, {
    deleteActiveDirectory: async (knowledgeBaseId: string, logicalPrefix: string) => {
      if (failCleanup) throw new Error('模拟文件清理失败')
      return storage.deleteActiveDirectory(knowledgeBaseId, logicalPrefix)
    },
  }) as RawDocumentStore
  const service = new KnowledgeService(new JsonStore(resolve(root, 'state.json')), failingStorage)
  await service.initialize()
  const created = await service.createProject('目录清理重试验收')
  const kbId = created.knowledgeBase!.id
  const directory = await service.createDirectory(kbId, '待删除', null)
  const synced = await ingestReady(service, { knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'browser:待删除/a.md', assetType: '需求', displayName: 'a.md', logicalPath: '待删除/a.md', content: document() })
  const activeBefore = (await service.overview(kbId)).knowledgeBase.activeIndexVersionId
  const deletion = await service.deleteDirectory(directory.id, 'recursive')
  assert.ok('task' in deletion)
  await service.processTask(deletion.task.id)
  const failed = await service.task(deletion.task.id)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.step, 'file_cleanup')
  assert.equal(failed.input.fileCleanupOnly, true)
  assert.notEqual((await service.overview(kbId)).knowledgeBase.activeIndexVersionId, activeBefore)
  assert.equal((await service.directories(kbId)).some(item => item.id === directory.id), true)
  assert.equal((await service.directories(kbId)).find(item => item.id === directory.id)?.task?.status, 'failed')
  assert.equal((await service.assets(kbId, { includeDeleted: true })).find(item => item.id === synced.asset!.id)?.operationTaskId, deletion.task.id)
  await assert.rejects(() => service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'browser:待删除/new.md', assetType: '需求', displayName: 'new.md', logicalPath: '待删除/new.md', content: document() }), /后台删除/)
  await assert.rejects(() => service.cancelTask(deletion.task.id), /只能重试/)
  const candidateId = failed.input.candidateIndexVersionId
  failCleanup = false
  const retried = await service.retry(deletion.task.id)
  assert.equal(retried.input.candidateIndexVersionId, candidateId)
  await service.processTask(retried.id)
  const completed = await service.task(retried.id)
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.step, 'completed')
  assert.equal((await service.directories(kbId)).some(item => item.id === directory.id), false)
  assert.equal((await service.assets(kbId, { includeDeleted: true })).find(item => item.id === synced.asset!.id)?.operationTaskId, undefined)
  await assert.rejects(() => readFile(resolve(documentsRoot, kbId, 'files', '待删除', 'a.md'), 'utf8'), /ENOENT/)
})

test('知识文件移动、重命名和删除同步数据库状态与默认目录', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'smarthub-file-actions-'))
  const service = new KnowledgeService(new JsonStore(resolve(root, 'state.json')), new RawDocumentStore(resolve(root, 'knowledge-bases'))); await service.initialize(); const created = await service.createProject('文件操作验收'); const kbId = created.knowledgeBase!.id
  const source = await service.createDirectory(kbId, '待整理', null)
  const target = await service.createDirectory(kbId, '已归档', null)
  const synced = await ingestReady(service, { knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'browser:待整理/a.md', assetType: '需求', displayName: 'a.md', logicalPath: '待整理/a.md', content: document() })
  await service.updateAsset(synced.asset!.id, { displayName: '退款规则.md' })
  assert.equal((await service.assets(kbId))[0].logicalPath, '待整理/退款规则.md')
  await service.updateAsset(synced.asset!.id, { targetDirectoryId: target.id })
  assert.equal((await service.assets(kbId))[0].logicalPath, '已归档/退款规则.md')
  assert.equal(await readFile(resolve(root, 'knowledge-bases', kbId, 'files', '已归档', '退款规则.md'), 'utf8'), document())
  assert.equal((await service.directories(kbId)).some(item => item.id === source.id), true)
  const deletion = await service.deleteAsset(synced.asset!.id); await service.processTask(deletion.task.id)
  await assert.rejects(() => readFile(resolve(root, 'knowledge-bases', kbId, 'files', '已归档', '退款规则.md'), 'utf8'), /ENOENT/)
  assert.equal((await service.assets(kbId)).length, 0)
  assert.equal((await service.version(synced.version.id)).status, 'deleted')
  assert.equal(await readFile(resolve(root, 'knowledge-bases', synced.version.snapshotPath!), 'utf8'), document())
})

test('AC-006 新版本失败不会破坏旧活动索引', async () => {
  const { service, kbId } = await fixture(); const first = await ingestReady(service, { knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'a.md', assetType: 'requirement', displayName: '需求', logicalPath: 'a.md', content: document() }); const oldIndex = (await service.overview(kbId)).knowledgeBase.activeIndexVersionId
  const failed = await ingestReady(service, { knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'a.md', assetType: 'requirement', displayName: '需求', logicalPath: 'a.md', content: document('变更内容'), simulateFailureAt: 'embedding' })
  assert.equal(failed.version.status, 'failed'); assert.equal((await service.overview(kbId)).knowledgeBase.activeIndexVersionId, oldIndex); assert.equal((await service.assets(kbId))[0].activeVersionId, first.version.id); assert.equal((await service.search(kbId, { query: '幂等' })).status, 'ok')
  const retried = await service.retry(failed.task!.id); await service.processTask(retried.id); const completed = await service.task(retried.id); assert.equal((await service.version(failed.version.id)).status, 'ready'); assert.equal(completed.trigger, 'retry'); assert.equal(completed.attempts, 0); assert.notEqual((await service.overview(kbId)).knowledgeBase.activeIndexVersionId, oldIndex)
})

test('AC-007 检索结果绑定固定资产版本与原文位置', async () => {
  const { service, kbId } = await fixture(); const synced = await ingestReady(service, { knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'a.md', assetType: 'requirement', displayName: '退款需求', logicalPath: 'requirements/a.md', content: document() })
  const found = await service.search(kbId, { query: '幂等', mode: 'keyword', assetType: 'requirement' }); assert.equal(found.status, 'ok'); assert.equal(found.results[0].version.id, synced.version.id); assert.ok(found.results[0].chunk.startLine > 0); assert.equal((await service.version(found.results[0].version.id)).content, document())
})

test('AC-008 查询配置无需重建，兼容性配置受控重建且失败保旧索引', async () => {
  const { service, kbId } = await fixture(); await ingestReady(service, { knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'a.md', assetType: 'requirement', displayName: '需求', logicalPath: 'a.md', content: document() }); const oldIndex = (await service.overview(kbId)).knowledgeBase.activeIndexVersionId; const oldIndexConfig = service.store.read().indexes.find(item => item.id === oldIndex)!.configVersionId
  const queryChange = await service.saveConfig(kbId, { relevanceThreshold: 0.2 }); assert.equal(queryChange.impact, 'query'); assert.equal(queryChange.configVersion.requiresRebuild, false)
  const indexChange = await service.saveConfig(kbId, { chunkTargetSize: 700, chunkMaxSize: 800, embeddingDimensions: 32 }); assert.equal(indexChange.impact, 'index_rebuild'); assert.equal(indexChange.configVersion.requiresRebuild, true); assert.equal((await service.overview(kbId)).knowledgeBase.activeIndexVersionId, oldIndex)
  const pending = await ingestReady(service, { knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'b.md', assetType: 'other', displayName: '待重建期间资料', logicalPath: 'b.md', content: '# 新资料\n仍按旧活动索引配置处理' }); assert.equal(pending.version.configVersionId, oldIndexConfig); const activeBeforeRebuild = (await service.overview(kbId)).knowledgeBase.activeIndexVersionId; assert.equal(service.store.read().indexes.find(item => item.id === activeBeforeRebuild)!.configVersionId, oldIndexConfig)
  await service.rebuild(kbId, 'failure'); assert.equal((await service.overview(kbId)).knowledgeBase.activeIndexVersionId, activeBeforeRebuild)
  const originalDimension = service.store.read().versions.find(item => item.id === pending.version.id)!.chunks[0].embedding.length
  const success = await service.rebuild(kbId, 'success'); assert.notEqual(success.index!.id, oldIndex); assert.equal(success.index!.indexedChunks![0].embedding.length, 32); assert.equal(service.store.read().versions.find(item => item.id === pending.version.id)!.chunks[0].embedding.length, originalDimension); assert.equal((await service.config(kbId)).requiresRebuild, false)
})

test('查询参数保存后立即覆盖活动索引中的旧查询参数', async () => {
  const { service, kbId } = await fixture()
  await ingestReady(service, { knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'a.md', assetType: 'requirement', displayName: '需求', logicalPath: 'a.md', content: document() })
  const activeIndex = (await service.overview(kbId)).activeIndex!
  await service.saveConfig(kbId, { hybridSearch: false, rerankerEnabled: false, relevanceThreshold: 0.47, keywordRecall: 3, finalResults: 2 })
  assert.equal((await service.overview(kbId)).activeIndex!.configVersionId, activeIndex.configVersionId)
  const result = await service.search(kbId, { query: '幂等' })
  assert.equal(result.status, 'ok')
  assert.equal(result.results[0].retrievalMode, 'keyword')
  assert.equal(result.results[0].scores.keyword, 1)
})

test('FR-003/004 配置草稿字段完整持久化且无变化不生成版本', async () => {
  const { service, kbId } = await fixture(); const saved = await service.saveConfig(kbId, { parserVersion: 'markdown-v2', preprocessVersion: 'normalize-v2', chunkTargetSize: 500, chunkMaxSize: 800, chunkOverlap: 50, headingDepth: 5, embeddingMode: 'remote_api', embeddingBaseUrl: 'https://embedding.example.com/v1', embeddingApiKey: 'sk-test', embeddingModel: 'embedding-a', embeddingDimensions: 128, embeddingBatchSize: 16, embeddingTimeoutMs: 15000, embeddingRetries: 3, keywordRecall: 30, vectorRecall: 50, finalResults: 10, relevanceThreshold: .4, hybridSearch: false, rerankerEnabled: true, rerankerModel: 'embedding-a' }); const config = await service.config(kbId); assert.equal(saved.changed, true); assert.equal(config.config.embeddingDimensions, 128); assert.equal(config.config.embeddingApiKey, 'sk-test'); assert.equal(config.config.rerankerModel, 'embedding-a'); const unchanged = await service.saveConfig(kbId, config.config); assert.equal(unchanged.changed, false); assert.equal(service.store.read().configs.filter(item => item.knowledgeBaseId === kbId).length, 2)
  await assert.rejects(() => service.saveConfig(kbId, { chunkTargetSize: 900, chunkMaxSize: 800 }), /最大大小/)
})

test('AC-009 只有显式接入的人工保存资料进入知识库', async () => {
  const { service, kbId } = await fixture(); const draft = 'AI 临时草稿'; assert.equal((await service.search(kbId, { query: draft })).status, 'no_ready_assets')
  await ingestReady(service, { knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'design.md', assetType: 'technical_design', displayName: '人工确认方案', logicalPath: 'design.md', content: `# 方案\n${draft}` }); assert.equal((await service.search(kbId, { query: draft, mode: 'keyword' })).status, 'ok')
})

test('FR-020/021 异步重建可观察、可取消且取消不切换活动索引', async () => {
  const { service, kbId } = await fixture(); await ingestReady(service, { knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'a.md', assetType: 'requirement', displayName: '需求', logicalPath: 'a.md', content: document() }); await service.saveConfig(kbId, { chunkTargetSize: 700, chunkMaxSize: 800 }); const oldIndex = (await service.overview(kbId)).knowledgeBase.activeIndexVersionId
  const cancelled = await service.queueRebuild(kbId); await service.cancelTask(cancelled.id); await service.processQueuedRebuild(cancelled.id); assert.equal((await service.tasks(kbId)).find(task => task.id === cancelled.id)?.status, 'cancelled'); assert.equal((await service.overview(kbId)).knowledgeBase.activeIndexVersionId, oldIndex)
  const queued = await service.queueRebuild(kbId); await service.processQueuedRebuild(queued.id); assert.equal((await service.tasks(kbId)).find(task => task.id === queued.id)?.status, 'succeeded'); assert.notEqual((await service.overview(kbId)).knowledgeBase.activeIndexVersionId, oldIndex)
})

test('删除资产先发布新索引并保留 deleted 历史版本', async () => {
  const { service, kbId } = await fixture(); const synced = await ingestReady(service, { knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'a.md', assetType: 'requirement', displayName: '需求', logicalPath: 'a.md', content: document() }); await service.saveConfig(kbId, { embeddingDimensions: 32 }); const deletion = await service.deleteAsset(synced.asset!.id); await service.processTask(deletion.task.id)
  assert.equal((await service.search(kbId, { query: '幂等' })).status, 'no_ready_assets'); assert.equal((await service.version(synced.version.id)).status, 'deleted'); assert.equal((await service.assets(kbId)).length, 0); assert.equal((await service.assets(kbId, { includeDeleted: true })).length, 1)
})
