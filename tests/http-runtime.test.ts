import assert from 'node:assert/strict'
import test from 'node:test'

process.env.SMARTHUB_FORCE_JSON_STORE = 'true'
const { start } = await import('../server/http/server.js')
delete process.env.SMARTHUB_FORCE_JSON_STORE

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const server = await start(0)
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    await run(`http://127.0.0.1:${address.port}/api`)
  } finally {
    await new Promise<void>((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()))
  }
}

async function createKnowledgeBase(baseUrl: string) {
  const response = await fetch(`${baseUrl}/default-knowledge-base`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(response.status, 200)
  const value = await response.json() as { knowledgeBase: { id: string } }
  return value.knowledgeBase.id
}

test('本地模型运行状态接口返回系统默认缓存目录', async () => {
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/local-model/status`)
    assert.equal(response.status, 200)
    const status = await response.json() as { phase: string; cacheDirectory: string }
    assert.equal(status.phase, 'idle')
    assert.match(status.cacheDirectory.replaceAll('\\', '/'), /data\/models\/cache$/)
  })
})

test('知识库配置可保存远程地址和凭据，但 HTTP 响应不回显凭据', async () => {
  await withServer(async baseUrl => {
    const knowledgeBaseId = await createKnowledgeBase(baseUrl)
    const source = { id: 'remote-http', name: 'HTTP 远程来源', type: 'remote_api', baseUrl: 'https://embedding.example.com/v1', apiKey: 'http-secret', models: [{ name: 'embedding-model', dimensions: 3 }] }
    const saved = await fetch(`${baseUrl}/knowledge-bases/${knowledgeBaseId}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ embeddingSourceId: source.id, embeddingSources: [{ id: 'local-default', name: '本地模型', type: 'local', baseUrl: '', apiKey: '', models: [{ name: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', dimensions: 384 }] }, source], embeddingMode: 'remote_api', embeddingBaseUrl: source.baseUrl, embeddingApiKey: source.apiKey, embeddingModel: 'embedding-model', embeddingDimensions: 3, rerankerEnabled: false }),
    })
    assert.equal(saved.status, 200)
    assert.doesNotMatch(JSON.stringify(await saved.json()), /http-secret/u)

    const config = await fetch(`${baseUrl}/knowledge-bases/${knowledgeBaseId}/config`)
    assert.equal(config.status, 200)
    const body = await config.json() as { config: { embeddingSources: { id: string; baseUrl: string; apiKey: string }[]; embeddingApiKey: string } }
    assert.equal(body.config.embeddingSources.find(item => item.id === source.id)?.baseUrl, source.baseUrl)
    assert.equal(body.config.embeddingSources.find(item => item.id === source.id)?.apiKey, '')
    assert.equal(body.config.embeddingApiKey, '')
    assert.doesNotMatch(JSON.stringify(body), /http-secret/u)
  })
})

test('生成式模型管理 API 持久化来源、掩码密钥并返回真实探测失败', async () => {
  await withServer(async baseUrl => {
    const source = {
      id: 'http-model-source',
      name: 'HTTP 模型来源',
      providerType: 'openai_compatible',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'http-model-secret',
      enabled: true,
      health: 'unknown',
      priority: 1,
      models: [{ id: 'http-model', name: 'review-model', displayName: 'Review Model', contextWindow: 32768, maxOutputTokens: 4096, capabilities: ['structured_output'], enabled: true, health: 'unknown' }],
    }
    const saved = await fetch(`${baseUrl}/model-sources`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify([source]) })
    assert.equal(saved.status, 200)
    const listed = await fetch(`${baseUrl}/model-sources`)
    assert.equal(listed.status, 200)
    const sources = await listed.json() as typeof source[]
    assert.equal(sources[0].models[0].name, 'review-model')
    assert.equal(sources[0].baseUrl, source.baseUrl)
    assert.equal(sources[0].apiKey, '')
    assert.doesNotMatch(JSON.stringify(sources), /http-model-secret/)
    const rejected = await fetch(`${baseUrl}/model-sources`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ ...source, id: 'empty-model-source', models: [] }]) })
    assert.equal(rejected.status, 400)
    assert.match((await rejected.json() as { error: string }).error, /至少需要一个模型/)
    const probe = await fetch(`${baseUrl}/model-sources/${source.id}/models/${source.models[0].id}/probe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(probe.status, 200)
    const result = await probe.json() as { ok: boolean; message: string; source: typeof source }
    assert.equal(result.ok, false)
    assert.equal(result.source.health, 'degraded')
    assert.match(result.message, /fetch failed|连接|ECONNREFUSED/i)
  })
})
