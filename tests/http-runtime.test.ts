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
  const response = await fetch(`${baseUrl}/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `HTTP 验收 ${crypto.randomUUID()}` }) })
  assert.equal(response.status, 201)
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
