import assert from 'node:assert/strict'
import test from 'node:test'
import { JsonStore, KnowledgeService, type LocalModelRuntime } from '../server/index.js'
import { RemoteEmbeddingClient } from '../server/infrastructure/remote-embedding-client.js'
import type { ChunkSearchInput, StoredChunkCandidate } from '../server/infrastructure/store.js'

class RecordingStore extends JsonStore {
  readonly recalls: ChunkSearchInput[] = []
  override async searchChunks(input: ChunkSearchInput): Promise<StoredChunkCandidate[]> {
    this.recalls.push(input)
    const state = this.read()
    const index = state.indexes.find(item => item.id === input.indexVersionId)
    return (index?.assetVersionIds ?? []).flatMap(versionId => {
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
  const queued = await service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'a.md', assetType: '需求', displayName: 'a.md', logicalPath: 'a.md', content: '# 退款\n必须校验幂等键' }); await service.processTask(queued.task!.id)
  const result = await service.search(kbId, { query: '退款', mode: 'hybrid' })
  assert.equal(result.status, 'ok')
  assert.equal(result.results[0].scores.vector, 0.9)
  assert.equal(result.results[0].scores.keyword, 0.8)
  assert.equal(result.retrieval.vectorCandidates, 1)
  assert.equal(result.retrieval.keywordCandidates, 1)
  assert.equal(result.retrieval.minimumRelevance, 0.05)
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
  const queued = await service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'a.md', assetType: '需求', displayName: 'a.md', logicalPath: 'a.md', content: '# 退款\n必须校验幂等键' }); await service.processTask(queued.task!.id)
  await service.search(kbId, { query: '退款', mode: 'keyword' })
  const rerankerCall = calls.find(call => call.model === 'reranker-test')
  assert.ok(rerankerCall)
  assert.equal(rerankerCall.texts[0], '退款')
  assert.ok(rerankerCall.texts.length > 1)
})

test('混合检索在向量服务不可用时降级到关键词，纯向量检索返回明确状态', async () => {
  let available = true
  const remote = new RemoteEmbeddingClient(async (_input, init) => {
    if (!available) return new Response(JSON.stringify({ error: { message: 'provider unavailable' } }), { status: 503, headers: { 'content-type': 'application/json' } })
    const body = JSON.parse(String(init?.body)) as { input: string[] }
    return new Response(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const service = new KnowledgeService(new JsonStore(null), undefined, undefined, remote)
  await service.initialize()
  const created = await service.createProject('检索降级验收'); const kbId = created.knowledgeBase!.id
  await service.saveConfig(kbId, { embeddingMode: 'remote_api', embeddingBaseUrl: 'https://embedding.example.com/v1', embeddingModel: 'embedding-a', embeddingDimensions: 3, embeddingRetries: 0, rerankerEnabled: false })
  const queued = await service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'a.md', assetType: '需求', displayName: 'a.md', logicalPath: 'a.md', content: '# 退款\n退款必须校验幂等键' })
  await service.processTask(queued.task!.id)
  available = false
  const hybrid = await service.search(kbId, { query: '退款', mode: 'hybrid' })
  assert.equal(hybrid.status, 'ok')
  assert.equal(hybrid.results[0].retrievalMode, 'keyword')
  assert.equal(hybrid.retrieval.degraded, true)
  const vector = await service.search(kbId, { query: '退款', mode: 'vector' })
  assert.equal(vector.status, 'vector_unavailable')
})
