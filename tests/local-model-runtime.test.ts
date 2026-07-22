import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { JsonStore, KnowledgeService, LocalModelRuntime } from '../server/index.js'
import type { FeatureExtractor, FeatureExtractorLoader } from '../server/infrastructure/local-model-runtime.js'

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
