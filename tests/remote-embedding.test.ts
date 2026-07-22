import assert from 'node:assert/strict'
import test from 'node:test'
import { JsonStore, KnowledgeService } from '../server/index.js'
import { RemoteEmbeddingClient } from '../server/infrastructure/remote-embedding-client.js'

test('远程模式调用 OpenAI 兼容 Embeddings API 并保存返回向量', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const client = new RemoteEmbeddingClient(async (input, init) => {
    calls.push({ url: String(input), init })
    const body = JSON.parse(String(init?.body)) as { input: string[] }
    return new Response(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [index + 1, 0, 0] })) }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const service = new KnowledgeService(new JsonStore(null), undefined, undefined, client)
  await service.initialize()
  const created = await service.createProject('远程向量验收')
  const kbId = created.knowledgeBase!.id
  await service.saveConfig(kbId, { embeddingMode: 'remote_api', embeddingBaseUrl: 'https://embedding.example.com/v1', embeddingApiKey: 'secret', embeddingModel: 'embedding-a', embeddingDimensions: 3, embeddingBatchSize: 2 })
  const synced = await service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'a.md', assetType: '需求', displayName: 'a.md', logicalPath: 'a.md', content: '# 规则\n必须校验幂等键' })
  assert.equal(calls[0].url, 'https://embedding.example.com/v1/embeddings')
  assert.equal(new Headers(calls[0].init?.headers).get('authorization'), 'Bearer secret')
  assert.deepEqual(synced.version.chunks[0].embedding, [1, 0, 0])
})

test('远程 Embedding 失败会重试并明确报错，不回退 Hash 向量', async () => {
  let requests = 0
  const client = new RemoteEmbeddingClient(async () => {
    requests += 1
    return new Response(JSON.stringify({ error: { message: 'provider unavailable' } }), { status: 503, headers: { 'content-type': 'application/json' } })
  })
  const service = new KnowledgeService(new JsonStore(null), undefined, undefined, client)
  await service.initialize()
  const created = await service.createProject('远程失败验收')
  const kbId = created.knowledgeBase!.id
  await service.saveConfig(kbId, { embeddingMode: 'remote_api', embeddingBaseUrl: 'https://embedding.example.com/v1', embeddingModel: 'embedding-a', embeddingDimensions: 3, embeddingRetries: 1 })
  await assert.rejects(() => service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'a.md', assetType: '需求', displayName: 'a.md', logicalPath: 'a.md', content: '# 规则\n内容' }), /provider unavailable/u)
  assert.equal(requests, 2)
})
