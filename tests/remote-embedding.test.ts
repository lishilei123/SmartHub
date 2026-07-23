import assert from 'node:assert/strict'
import test from 'node:test'
import { JsonStore, KnowledgeService } from '../server/index.js'
import { RemoteEmbeddingClient } from '../server/infrastructure/remote-embedding-client.js'

const localSource = {
  id: 'local-default',
  name: '本地模型',
  type: 'local' as const,
  baseUrl: '',
  apiKey: '',
  models: [{ name: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', dimensions: 384 }],
}

function remoteSource(id: string, name: string, baseUrl: string, apiKey: string, models: { name: string; dimensions: number }[]) {
  return { id, name, type: 'remote_api' as const, baseUrl, apiKey, models }
}

function serviceWith(client: RemoteEmbeddingClient) {
  return new KnowledgeService(new JsonStore(null), undefined, undefined, client)
}

async function configureRemote(service: KnowledgeService, knowledgeBaseId: string, patch: Record<string, unknown> = {}) {
  const embedding = remoteSource('embedding-source', 'Embedding 服务', 'https://embedding.example.com/v1', 'test-secret', [{ name: 'embedding-model', dimensions: 3 }, { name: 'embedding-auto', dimensions: 0 }])
  const reranker = remoteSource('reranker-source', 'Reranker 服务', 'https://reranker.example.com/v1', 'reranker-secret', [{ name: 'reranker-model', dimensions: 3 }])
  return service.saveConfig(knowledgeBaseId, {
    embeddingSourceId: embedding.id,
    embeddingSources: [localSource, embedding, reranker],
    embeddingMode: 'remote_api',
    embeddingBaseUrl: embedding.baseUrl,
    embeddingApiKey: embedding.apiKey,
    embeddingModel: 'embedding-model',
    embeddingDimensions: 3,
    embeddingBatchSize: 2,
    rerankerEnabled: false,
    ...patch,
  })
}

test('远程模式使用当前知识库配置的路由调用 Embeddings API', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const client = new RemoteEmbeddingClient(async (input, init) => {
    calls.push({ url: String(input), init })
    const body = JSON.parse(String(init?.body)) as { input: string[] }
    return new Response(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [index + 1, 0, 0] })) }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const service = serviceWith(client)
  await service.initialize()
  const created = await service.createProject('远程向量验收')
  const kbId = created.knowledgeBase!.id
  await configureRemote(service, kbId)
  const synced = await service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'a.md', assetType: '需求', displayName: 'a.md', logicalPath: 'a.md', content: '# 规则\n必须校验幂等键' })
  await service.processTask(synced.task!.id)
  assert.equal(calls[0].url, 'https://embedding.example.com/v1/embeddings')
  assert.equal(new Headers(calls[0].init?.headers).get('authorization'), 'Bearer test-secret')
  assert.deepEqual((await service.version(synced.version.id)).chunks[0].embedding, [1, 0, 0])
  const config = await service.config(kbId)
  assert.equal(config.config.embeddingSources.find(source => source.id === 'embedding-source')?.baseUrl, 'https://embedding.example.com/v1')
  assert.doesNotMatch(JSON.stringify(config), /test-secret|reranker-secret/u)
})

test('编辑远程来源后使用新地址并保留已保存的凭据', async () => {
  const calls: { url: string; authorization: string | null }[] = []
  const client = new RemoteEmbeddingClient(async (input, init) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') })
    const body = JSON.parse(String(init?.body)) as { input: string[] }
    return new Response(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const service = serviceWith(client)
  await service.initialize()
  const created = await service.createProject('编辑远程来源验收')
  const kbId = created.knowledgeBase!.id
  await configureRemote(service, kbId)
  const redacted = await service.config(kbId)
  await service.saveConfig(kbId, {
    embeddingSources: redacted.config.embeddingSources.map(source => source.id === 'embedding-source' ? { ...source, name: '编辑后的 Embedding 服务', baseUrl: 'https://edited.example.com/v1', apiKey: '' } : source),
  })
  const synced = await service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'edited.md', assetType: '需求', displayName: 'edited.md', logicalPath: 'edited.md', content: '# 编辑后路由\n必须继续使用保存的密钥' })
  await service.processTask(synced.task!.id)
  assert.deepEqual(calls, [{ url: 'https://edited.example.com/v1/embeddings', authorization: 'Bearer test-secret' }])
})

test('远程模型可按当前知识库配置自动检测维度', async () => {
  let requestBody: Record<string, unknown> = {}
  const client = new RemoteEmbeddingClient(async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0, 0] }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const service = serviceWith(client)
  await service.initialize()
  const created = await service.createProject('远程维度检测验收')
  const source = remoteSource('embedding-source', 'Embedding 服务', 'https://embedding.example.com/v1', 'test-secret', [{ name: 'embedding-auto', dimensions: 0 }])
  const result = await service.testEmbeddingConfig(created.knowledgeBase!.id, { embeddingSourceId: source.id, embeddingSources: [localSource, source], embeddingMode: 'remote_api', embeddingBaseUrl: source.baseUrl, embeddingApiKey: source.apiKey, embeddingModel: 'embedding-auto', embeddingDimensions: 0, embeddingBatchSize: 32, embeddingTimeoutMs: 30_000, embeddingRetries: 2 })
  assert.equal(result.dimensions, 4)
  assert.equal('dimensions' in requestBody, false)
})

test('远程模型兼容 Ollama api/embed 路由', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const client = new RemoteEmbeddingClient(async (input, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] }
    calls.push({ url: String(input), body })
    return new Response(JSON.stringify({ model: 'bge-m3', embeddings: body.input.map((_, index) => [index + 1, 0, 0, 0]) }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const service = serviceWith(client)
  await service.initialize()
  const created = await service.createProject('Ollama 维度检测验收')
  const source = remoteSource('ollama-source', 'Ollama 服务', 'http://localhost:11434/api/embed', '', [{ name: 'bge-m3', dimensions: 0 }])
  const result = await service.testEmbeddingConfig(created.knowledgeBase!.id, { embeddingSourceId: source.id, embeddingSources: [localSource, source], embeddingMode: 'remote_api', embeddingBaseUrl: source.baseUrl, embeddingModel: 'bge-m3', embeddingDimensions: 0, embeddingBatchSize: 32, embeddingTimeoutMs: 30_000, embeddingRetries: 2 })
  assert.equal(calls[0].url, 'http://localhost:11434/api/embed')
  assert.deepEqual(calls[0].body.input, ['SmartHub 向量维度自动检测'])
  assert.equal(result.dimensions, 4)
})

test('远程错误不会泄露知识库保存的端点或凭据', async () => {
  const client = new RemoteEmbeddingClient(async () => new Response('endpoint https://embedding.example.com/v1 token test-secret', { status: 404, headers: { 'content-type': 'text/plain' } }))
  const service = serviceWith(client)
  await service.initialize()
  const created = await service.createProject('远程错误提示验收')
  await configureRemote(service, created.knowledgeBase!.id)
  await assert.rejects(
    () => service.testEmbeddingConfig(created.knowledgeBase!.id, { embeddingSourceId: 'embedding-source', embeddingModel: 'embedding-model', embeddingDimensions: 3, embeddingBatchSize: 32, embeddingTimeoutMs: 30_000, embeddingRetries: 0 }),
    error => {
      const message = error instanceof Error ? error.message : String(error)
      assert.match(message, /非 JSON 响应/u)
      assert.match(message, /HTTP 404/u)
      assert.doesNotMatch(message, /embedding\.example\.com|test-secret/u)
      return true
    },
  )
})

test('Reranker 可使用同一知识库中独立配置的远程来源', async () => {
  const calls: { url: string; model: string; inputs: string[] }[] = []
  const client = new RemoteEmbeddingClient(async (input, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; input: string[] }
    calls.push({ url: String(input), model: body.model, inputs: body.input })
    return new Response(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: [text.length, 1, 1] })) }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const service = serviceWith(client)
  await service.initialize()
  const created = await service.createProject('独立 Reranker 来源验收')
  const kbId = created.knowledgeBase!.id
  await configureRemote(service, kbId, { rerankerEnabled: true, rerankerSourceId: 'reranker-source', rerankerModel: 'reranker-model' })
  const synced = await service.ingest({ knowledgeBaseId: kbId, sourceType: 'upload', sourceKey: 'a.md', assetType: '需求', displayName: 'a.md', logicalPath: 'a.md', content: '# 退款\n退款必须校验幂等键' })
  await service.processTask(synced.task!.id)
  await service.search(kbId, { query: '退款', mode: 'keyword' })
  const rerankerCall = calls.find(call => call.url === 'https://reranker.example.com/v1/embeddings')
  assert.equal(rerankerCall?.model, 'reranker-model')
  assert.equal(rerankerCall?.inputs[0], '退款')
  assert.ok((rerankerCall?.inputs.length ?? 0) > 1)
})

test('不同知识库可保存同名模型的独立远程路由', async () => {
  const calls: { url: string; authorization: string | null }[] = []
  const client = new RemoteEmbeddingClient(async (input, init) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') })
    const body = JSON.parse(String(init?.body)) as { input: string[] }
    return new Response(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const service = serviceWith(client)
  await service.initialize()
  const left = await service.createProject('知识库 A')
  const right = await service.createProject('知识库 B')
  const configure = (knowledgeBaseId: string, baseUrl: string, apiKey: string) => {
    const source = remoteSource('shared-id', '同名模型', baseUrl, apiKey, [{ name: 'embedding-model', dimensions: 3 }])
    return service.saveConfig(knowledgeBaseId, { embeddingSourceId: source.id, embeddingSources: [localSource, source], embeddingMode: 'remote_api', embeddingBaseUrl: source.baseUrl, embeddingApiKey: source.apiKey, embeddingModel: 'embedding-model', embeddingDimensions: 3, rerankerEnabled: false })
  }
  await configure(left.knowledgeBase!.id, 'https://a.example.com/v1', 'key-a')
  await configure(right.knowledgeBase!.id, 'https://b.example.com/v1', 'key-b')
  for (const [knowledgeBaseId, sourceKey] of [[left.knowledgeBase!.id, 'a.md'], [right.knowledgeBase!.id, 'b.md']] as const) {
    const queued = await service.ingest({ knowledgeBaseId, sourceType: 'upload', sourceKey, assetType: '需求', displayName: sourceKey, logicalPath: sourceKey, content: '# 规则\n必须校验幂等键' })
    await service.processTask(queued.task!.id)
  }
  assert.deepEqual(calls.map(call => [call.url, call.authorization]), [['https://a.example.com/v1/embeddings', 'Bearer key-a'], ['https://b.example.com/v1/embeddings', 'Bearer key-b']])
})
