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
  await service.processTask(synced.task!.id)
  assert.equal(calls[0].url, 'https://embedding.example.com/v1/embeddings')
  assert.equal(new Headers(calls[0].init?.headers).get('authorization'), 'Bearer secret')
  assert.deepEqual((await service.version(synced.version.id)).chunks[0].embedding, [1, 0, 0])
})

test('远程模型通过返回向量自动检测维度且不要求用户填写', async () => {
  let requestBody: Record<string, unknown> = {}
  const client = new RemoteEmbeddingClient(async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0, 0] }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const service = new KnowledgeService(new JsonStore(null), undefined, undefined, client)
  await service.initialize()
  const created = await service.createProject('远程维度检测验收')
  const result = await service.testEmbeddingConfig(created.knowledgeBase!.id, { embeddingMode: 'remote_api', embeddingBaseUrl: 'https://embedding.example.com/v1', embeddingModel: 'embedding-auto', embeddingDimensions: 0 })
  assert.equal(result.dimensions, 4)
  assert.equal('dimensions' in requestBody, false)
})

test('远程模型兼容 Ollama 原生 api/embed 接口和 embeddings 返回格式', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const client = new RemoteEmbeddingClient(async (input, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] }
    calls.push({ url: String(input), body })
    return new Response(JSON.stringify({ model: 'bge-m3', embeddings: body.input.map((_, index) => [index + 1, 0, 0, 0]) }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const service = new KnowledgeService(new JsonStore(null), undefined, undefined, client)
  await service.initialize()
  const created = await service.createProject('Ollama 维度检测验收')
  const result = await service.testEmbeddingConfig(created.knowledgeBase!.id, { embeddingMode: 'remote_api', embeddingBaseUrl: 'http://localhost:11434/api/embed', embeddingModel: 'bge-m3', embeddingDimensions: 0 })
  assert.equal(calls[0].url, 'http://localhost:11434/api/embed')
  assert.deepEqual(calls[0].body.input, ['SmartHub 向量维度自动检测'])
  assert.equal(result.dimensions, 4)
})

test('远程 Embedding 返回非 JSON 时给出可操作提示且不会显示底层解析异常', async () => {
  let requests = 0
  const client = new RemoteEmbeddingClient(async () => {
    requests += 1
    return new Response('404 page not found\n', { status: 404, headers: { 'content-type': 'text/plain' } })
  })
  const service = new KnowledgeService(new JsonStore(null), undefined, undefined, client)
  await service.initialize()
  const created = await service.createProject('远程错误提示验收')
  await assert.rejects(
    () => service.testEmbeddingConfig(created.knowledgeBase!.id, { embeddingMode: 'remote_api', embeddingBaseUrl: 'https://embedding.example.com/wrong', embeddingModel: 'embedding-a', embeddingDimensions: 0, embeddingRetries: 2 }),
    error => {
      const message = error instanceof Error ? error.message : String(error)
      assert.match(message, /非 JSON 响应/u)
      assert.match(message, /HTTP 404/u)
      assert.match(message, /Base URL/u)
      assert.doesNotMatch(message, /Unexpected non-whitespace/u)
      return true
    },
  )
  assert.equal(requests, 1)
})

test('Reranker 使用独立选择的来源和模型执行结果重排', async () => {
  const calls: { url: string; model: string; inputs: string[] }[] = []
  const client = new RemoteEmbeddingClient(async (input, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; input: string[] }
    calls.push({ url: String(input), model: body.model, inputs: body.input })
    return new Response(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: [text.length, 1, 1] })) }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const service = new KnowledgeService(new JsonStore(null), undefined, undefined, client)
  await service.initialize()
  const created = await service.createProject('独立 Reranker 来源验收')
  const kbId = created.knowledgeBase!.id
  await service.saveConfig(kbId, {
    embeddingSourceId: 'embedding-source',
    embeddingSources: [
      { id: 'embedding-source', name: 'Embedding 服务', type: 'remote_api', baseUrl: 'https://embedding.example.com/v1', apiKey: 'embedding-key', models: [{ name: 'embedding-model', dimensions: 3 }] },
      { id: 'reranker-source', name: 'Reranker 服务', type: 'remote_api', baseUrl: 'https://reranker.example.com/v1', apiKey: 'reranker-key', models: [{ name: 'reranker-model', dimensions: 3 }] },
    ],
    embeddingMode: 'remote_api', embeddingBaseUrl: 'https://embedding.example.com/v1', embeddingApiKey: 'embedding-key', embeddingModel: 'embedding-model', embeddingDimensions: 3,
    rerankerEnabled: true, rerankerSourceId: 'reranker-source', rerankerModel: 'reranker-model',
  })
  const configured = (await service.config(kbId)).config
  assert.ok(configured.embeddingSources.some(source => source.type === 'local' && source.name === '本地模型'), '系统内置本地模型必须始终存在并使用产品名称')
  await service.saveConfig(kbId, { embeddingSources: configured.embeddingSources.map(source => source.type === 'local' ? { ...source, models: [] } : source) })
  assert.equal((await service.config(kbId)).config.embeddingSources.find(source => source.type === 'local')?.models.length, 0)
  const synced = await service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'a.md', assetType: '需求', displayName: 'a.md', logicalPath: 'a.md', content: '# 退款\n退款必须校验幂等键' })
  await service.processTask(synced.task!.id)
  await service.search(kbId, { query: '退款', mode: 'keyword' })
  const rerankerCall = calls.find(call => call.url === 'https://reranker.example.com/v1/embeddings')
  assert.equal(rerankerCall?.model, 'reranker-model')
  assert.equal(rerankerCall?.inputs[0], '退款')
  assert.ok((rerankerCall?.inputs.length ?? 0) > 1)
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
  const queued = await service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'a.md', assetType: '需求', displayName: 'a.md', logicalPath: 'a.md', content: '# 规则\n内容' })
  await service.processTask(queued.task!.id)
  assert.match((await service.task(queued.task!.id)).error ?? '', /provider unavailable/u)
  assert.equal(requests, 2)
})
