import assert from 'node:assert/strict'
import test from 'node:test'
import { JsonStore, KnowledgeService, type LocalModelRuntime } from '../server/index.js'

test('AC-005 上传只创建持久化任务，Worker 完成后才激活候选索引', async () => {
  const service = new KnowledgeService(new JsonStore(null)); await service.initialize()
  const created = await service.createProject('异步上传验收'); const kbId = created.knowledgeBase!.id
  const queued = await service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'a.md', assetType: '需求', displayName: 'a.md', logicalPath: 'a.md', content: '# 规则\n必须校验幂等键' })
  const duplicate = await service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'a.md', assetType: '需求', displayName: 'a.md', logicalPath: 'a.md', content: '# 规则\n必须校验幂等键' })
  assert.equal(queued.task?.status, 'queued')
  assert.equal(duplicate.task?.id, queued.task?.id)
  assert.equal((await service.assets(kbId, { includeDeleted: true }))[0].versions.length, 1)
  assert.equal((await service.version(queued.version.id)).status, 'pending')
  assert.equal((await service.overview(kbId)).knowledgeBase.activeIndexVersionId, null)
  await service.processTask(queued.task!.id)
  const completed = await service.task(queued.task!.id)
  const overview = await service.overview(kbId)
  assert.equal(completed.status, 'succeeded')
  assert.equal((await service.version(queued.version.id)).status, 'ready')
  assert.equal(overview.activeIndex?.status, 'active')
  assert.equal(overview.activeIndex?.id, completed.input.candidateIndexVersionId)
})

test('Embedding 进行中取消任务不会切换旧活动索引', async () => {
  let hold = false
  let release: (() => void) | undefined
  let signalStarted: (() => void) | undefined
  const started = new Promise<void>(resolvePromise => { signalStarted = resolvePromise })
  const runtime = {
    tokenCodec: async () => ({ count: (text: string) => text.length, maxTokens: 512 }),
    ensureRunning: async () => ({}),
    embed: async (_model: string, texts: string[]) => {
      if (hold) { signalStarted?.(); await new Promise<void>(resolvePromise => { release = resolvePromise }) }
      return texts.map(() => [1, 0, 0])
    },
  } as unknown as LocalModelRuntime
  const service = new KnowledgeService(new JsonStore(null), undefined, runtime); await service.initialize()
  const created = await service.createProject('取消切换验收'); const kbId = created.knowledgeBase!.id
  const config = (await service.config(kbId)).config
  await service.saveConfig(kbId, {
    embeddingSources: config.embeddingSources.map(source => source.id === 'local-default'
      ? { ...source, models: [...source.models, { name: 'test-model', dimensions: 3 }] }
      : source),
    embeddingModel: 'test-model',
    embeddingDimensions: 3,
    rerankerEnabled: false,
  })
  const first = await service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'a.md', assetType: '需求', displayName: 'a.md', logicalPath: 'a.md', content: '# 规则\n旧内容' }); await service.processTask(first.task!.id)
  const oldIndex = (await service.overview(kbId)).knowledgeBase.activeIndexVersionId
  hold = true
  const second = await service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'a.md', assetType: '需求', displayName: 'a.md', logicalPath: 'a.md', content: '# 规则\n新内容' })
  const processing = service.processTask(second.task!.id)
  await started
  await service.cancelTask(second.task!.id)
  release?.()
  await processing
  assert.equal((await service.task(second.task!.id)).status, 'cancelled')
  assert.equal((await service.overview(kbId)).knowledgeBase.activeIndexVersionId, oldIndex)
  assert.equal((await service.version(first.version.id)).status, 'ready')
  assert.equal((await service.version(second.version.id)).status, 'failed')
})

test('索引版本存在删除空洞时按历史最大版本递增，不会复用已存在版本号', async () => {
  const store = new JsonStore(null)
  const service = new KnowledgeService(store); await service.initialize()
  const created = await service.createProject('索引版本空洞验收'); const kbId = created.knowledgeBase!.id
  const first = await service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'first.md', assetType: '需求', displayName: 'first.md', logicalPath: 'first.md', content: '# 第一版\n必须保留历史版本号。' })
  await service.processTask(first.task!.id)
  const second = await service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'second.md', assetType: '需求', displayName: 'second.md', logicalPath: 'second.md', content: '# 第二版\n索引版本号必须继续递增。' })
  await service.processTask(second.task!.id)
  await store.transaction(state => { state.indexes = state.indexes.filter(index => index.knowledgeBaseId !== kbId || index.number !== 1) })

  const third = await service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'third.md', assetType: '需求', displayName: 'third.md', logicalPath: 'third.md', content: '# 第三版\n删除旧索引后也不能复用版本号。' })
  await service.processTask(third.task!.id)
  const indexes = (await store.snapshot()).indexes.filter(index => index.knowledgeBaseId === kbId)
  assert.equal((await service.task(third.task!.id)).status, 'succeeded')
  assert.equal(Math.max(...indexes.map(index => index.number)), 3)
  assert.equal(new Set(indexes.map(index => index.number)).size, indexes.length)
})

test('同步任务准备阶段失败也会收口为 failed，不会停在 waiting 或 claimed', async () => {
  const store = new JsonStore(null)
  const service = new KnowledgeService(store); await service.initialize()
  const created = await service.createProject('同步准备失败验收'); const kbId = created.knowledgeBase!.id
  const queued = await service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'broken.md', assetType: '需求', displayName: 'broken.md', logicalPath: 'broken.md', content: '# 准备失败\n任务必须明确失败。' })
  await store.transaction(state => { state.tasks.find(task => task.id === queued.task!.id)!.configVersionId = 'missing-config-version' })

  const completed = await service.processTask(queued.task!.id)
  assert.equal(completed?.status, 'failed')
  assert.equal((await service.task(queued.task!.id)).step, 'failed')
  assert.match((await service.task(queued.task!.id)).error ?? '', /配置不存在/u)
  assert.equal((await service.version(queued.version.id)).status, 'failed')
})
