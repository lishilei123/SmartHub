import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { JsonStore, KnowledgeService, LocalModelRuntime } from '../server/index.js'
import { createFeatureExtractorLoader, type FeatureExtractor, type FeatureExtractorLoader, type PipelineFactory, type ProgressInfo } from '../server/infrastructure/local-model-runtime.js'

function fakeLoader(disposed: { value: boolean }): FeatureExtractorLoader {
  return async (model, _cacheDirectory, onProgress) => {
    onProgress({ status: 'progress', file: `${model}.onnx`, progress: 45 })
    const extractor = Object.assign(async (texts: string | string[]) => {
      const values = (Array.isArray(texts) ? texts : [texts]).map(text => [text.length, text.includes('退款') ? 1 : 0, 1])
      return { tolist: () => values }
    }, { dispose: async () => { disposed.value = true } })
    return extractor as FeatureExtractor
  }
}

async function waitUntilRunning(runtime: LocalModelRuntime) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (runtime.status().phase === 'running') return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
  }
  throw new Error(`模型未进入运行状态：${runtime.status().phase}`)
}

test('SmartHub 内置运行时下载、加载、推理并释放本地模型', async () => {
  const disposed = { value: false }
  const root = await mkdtemp(resolve(tmpdir(), 'smarthub-model-'))
  const runtime = new LocalModelRuntime(root, fakeLoader(disposed))
  const accepted = runtime.start('test/embedding-model')
  assert.equal(accepted.phase, 'downloading')
  await waitUntilRunning(runtime)
  assert.equal(runtime.status().dimensions, 3)
  assert.deepEqual(await runtime.embed('test/embedding-model', ['退款规则']), [[4, 1, 1]])
  await runtime.stop()
  assert.equal(runtime.status().phase, 'idle')
  assert.equal(disposed.value, true)
})

test('多个本地模型拥有独立状态并可同时运行', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'smarthub-model-pool-'))
  const runtime = new LocalModelRuntime(root, fakeLoader({ value: false }))
  runtime.start('test/model-a')
  runtime.start('test/model-b')
  for (let attempt = 0; attempt < 50 && runtime.statuses().some(status => status.phase !== 'running'); attempt += 1) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
  }
  assert.deepEqual(runtime.statuses().map(status => [status.model, status.phase]), [['test/model-a', 'running'], ['test/model-b', 'running']])
  assert.deepEqual(await runtime.embed('test/model-a', ['模型 A']), [[4, 0, 1]])
  assert.deepEqual(await runtime.embed('test/model-b', ['模型 B']), [[4, 0, 1]])
  await runtime.stop('test/model-a')
  assert.equal(runtime.status('test/model-a').phase, 'idle')
  assert.equal(runtime.status('test/model-b').phase, 'running')
  await runtime.stop('test/model-b')
})

test('主模型仓库发生网络错误时自动切换备用镜像', async () => {
  const previousPrimary = process.env.SMARTHUB_MODEL_HUB
  const previousFallback = process.env.SMARTHUB_MODEL_HUB_FALLBACK
  delete process.env.SMARTHUB_MODEL_HUB
  process.env.SMARTHUB_MODEL_HUB_FALLBACK = 'https://fallback.example.com'
  try {
    const env = { remoteHost: 'https://huggingface.co/' }
    const hosts: string[] = []; const progress: ProgressInfo[] = []; let attempts = 0
    const extractor = await fakeLoader({ value: false })('test/fallback-model', 'cache', () => undefined)
    const pipeline: PipelineFactory = async () => {
      hosts.push(env.remoteHost); attempts += 1
      if (attempts === 1) throw new Error('fetch failed', { cause: Object.assign(new Error('SSL unexpected EOF'), { code: 'ECONNRESET' }) })
      return extractor
    }
    const loader = createFeatureExtractorLoader(async () => ({ env, pipeline }))
    assert.equal(await loader('test/fallback-model', 'cache', info => progress.push(info)), extractor)
    assert.deepEqual(hosts, ['https://huggingface.co/', 'https://fallback.example.com/'])
    assert.equal(progress.some(info => info.fallbackUsed && info.modelHub === 'https://fallback.example.com/'), true)
  } finally {
    if (previousPrimary === undefined) delete process.env.SMARTHUB_MODEL_HUB; else process.env.SMARTHUB_MODEL_HUB = previousPrimary
    if (previousFallback === undefined) delete process.env.SMARTHUB_MODEL_HUB_FALLBACK; else process.env.SMARTHUB_MODEL_HUB_FALLBACK = previousFallback
  }
})

test('本地模式的上传解析和混合检索使用系统内置模型向量', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'smarthub-model-'))
  const runtime = new LocalModelRuntime(root, fakeLoader({ value: false }))
  const service = new KnowledgeService(new JsonStore(null), undefined, runtime)
  await service.initialize()
  const created = await service.createProject('本地模型验收')
  const kbId = created.knowledgeBase!.id
  await service.saveConfig(kbId, { embeddingModel: 'test/embedding-model', embeddingDimensions: 3, rerankerModel: 'test/embedding-model' })
  const synced = await service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'refund.md', assetType: '需求', displayName: '退款规则', logicalPath: 'requirements/refund.md', content: '# 退款规则\n退款必须校验幂等键。' })
  await service.processTask(synced.task!.id)
  assert.equal(runtime.status().phase, 'running')
  assert.deepEqual((await service.version(synced.version.id)).chunks[0].embedding, [17, 1, 1])
  const found = await service.search(kbId, { query: '退款', mode: 'hybrid' })
  assert.equal(found.status, 'ok')
})

test('本地来源允许删除全部模型并保存为空配置', async () => {
  const service = new KnowledgeService(new JsonStore(null))
  await service.initialize()
  const created = await service.createProject('空本地模型验收')
  const kbId = created.knowledgeBase!.id
  const current = (await service.config(kbId)).config
  await service.saveConfig(kbId, { embeddingSources: current.embeddingSources.map(source => source.type === 'local' ? { ...source, models: [] } : source), embeddingModel: '', embeddingDimensions: 0, rerankerEnabled: false, rerankerModel: '' })
  const saved = (await service.config(kbId)).config
  assert.equal(saved.embeddingSources.find(source => source.type === 'local')?.models.length, 0)
  assert.equal(saved.embeddingModel, '')
  await assert.rejects(() => service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'a.md', assetType: '需求', displayName: 'a.md', logicalPath: 'a.md', content: '# 内容' }), /没有可用模型/)
})

test('旧版 Hash 模型配置在启动时迁移为系统内置模型', async () => {
  const store = new JsonStore(null)
  const service = new KnowledgeService(store)
  await service.initialize()
  const created = await service.createProject('旧配置迁移')
  const kbId = created.knowledgeBase!.id
  await store.transaction(state => {
    const config = state.configs.find(item => item.knowledgeBaseId === kbId)!
    config.config.embeddingModel = 'hash-embedding-v1'
    config.config.embeddingDimensions = 64
    config.config.rerankerModel = 'hash-embedding-v1'
  })
  await service.initialize()
  assert.equal((await service.config(kbId)).config.embeddingModel, 'Xenova/paraphrase-multilingual-MiniLM-L12-v2')
  assert.equal((await service.config(kbId)).config.embeddingDimensions, 384)
})
