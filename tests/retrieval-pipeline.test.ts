import assert from 'node:assert/strict'
import test from 'node:test'
import { JsonStore, KnowledgeService, type LocalModelRuntime } from '../server/index.js'
import type { ChunkSearchInput, StoredChunkCandidate } from '../server/infrastructure/store.js'

class RecordingStore extends JsonStore {
  readonly recalls: ChunkSearchInput[] = []
  override async searchChunks(input: ChunkSearchInput): Promise<StoredChunkCandidate[]> {
    this.recalls.push(input)
    const state = this.read()
    return input.versionIds.flatMap(versionId => {
      const version = state.versions.find(item => item.id === versionId)
      const asset = state.assets.find(item => item.id === version?.assetId)
      if (!version || !asset) return []
      return version.chunks.map(chunk => ({
        score: input.mode === 'keyword' ? 0.8 : 0.9,
        asset: { id: asset.id, displayName: asset.displayName, assetType: asset.assetType, sourceType: asset.sourceType, logicalPath: asset.logicalPath },
        version: { id: version.id, number: version.number },
        chunk: { id: chunk.id, chunkKey: chunk.chunkKey, headingPath: chunk.headingPath, startLine: chunk.startLine, endLine: chunk.endLine, startChar: chunk.startChar, endChar: chunk.endChar },
        content: chunk.content,
      }))
    }).slice(0, input.limit)
  }
}

test('关键词和向量召回数量分别进入两阶段混合检索', async () => {
  const store = new RecordingStore(null)
  const service = new KnowledgeService(store)
  await service.initialize()
  const created = await service.createProject('召回验收')
  const kbId = created.knowledgeBase!.id
  await service.saveConfig(kbId, { keywordRecall: 3, vectorRecall: 5, finalResults: 2, rerankerEnabled: false })
  await service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'a.md', assetType: '需求', displayName: 'a.md', logicalPath: 'a.md', content: '# 退款\n必须校验幂等键' })
  const result = await service.search(kbId, { query: '退款', mode: 'hybrid' })
  assert.equal(result.status, 'ok')
  assert.equal(result.results[0].scores.vector, 0.9)
  assert.equal(result.results[0].scores.keyword, 0.8)
  assert.deepEqual(store.recalls.map(call => [call.mode, call.limit]), [['keyword', 3], ['vector', 5]])
})

test('启用 Reranker 后候选内容使用配置模型执行二阶段语义重排', async () => {
  const calls: { model: string; texts: string[] }[] = []
  const runtime = {
    tokenCodec: async () => ({ count: (text: string) => text.length, maxTokens: 512 }),
    ensureRunning: async () => ({}),
    embed: async (model: string, texts: string[]) => {
      calls.push({ model, texts })
      return texts.map(text => [text.includes('退款') ? 1 : 0, 1, 0])
    },
  } as unknown as LocalModelRuntime
  const service = new KnowledgeService(new JsonStore(null), undefined, runtime)
  await service.initialize()
  const created = await service.createProject('重排验收')
  const kbId = created.knowledgeBase!.id
  await service.saveConfig(kbId, { embeddingModel: 'embedding-test', embeddingDimensions: 3, embeddingBatchSize: 32, rerankerEnabled: true, rerankerModel: 'reranker-test' })
  await service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'a.md', assetType: '需求', displayName: 'a.md', logicalPath: 'a.md', content: '# 退款\n必须校验幂等键' })
  await service.search(kbId, { query: '退款', mode: 'keyword' })
  const rerankerCall = calls.find(call => call.model === 'reranker-test')
  assert.ok(rerankerCall)
  assert.equal(rerankerCall.texts[0], '退款')
  assert.ok(rerankerCall.texts.length > 1)
})
