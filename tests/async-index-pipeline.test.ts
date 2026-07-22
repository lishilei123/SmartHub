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
