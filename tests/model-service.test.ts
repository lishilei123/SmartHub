import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelService } from '../server/application/model-service.js'
import { JsonStore } from '../server/infrastructure/store.js'

const source = {
  id: 'source-test',
  name: '测试模型来源',
  providerType: 'openai_compatible' as const,
  baseUrl: 'https://provider.example/v1',
  apiKey: 'actual-secret',
  enabled: true,
  health: 'unknown' as const,
  priority: 1,
  models: [{
    id: 'model-test',
    name: 'review-model',
    displayName: 'Review Model',
    contextWindow: 32_768,
    maxOutputTokens: 4_096,
    capabilities: ['structured_output', 'tool_calling'] as const,
    enabled: true,
    health: 'unknown' as const,
  }],
}

test('模型来源明文持久化连接且读取响应不回显 API Key', async () => {
  const store = new JsonStore(null)
  await store.load()
  const service = new ModelService(store)
  const saved = await service.replaceSources([source])
  assert.equal(saved[0].name, source.name)
  assert.equal(saved[0].baseUrl, source.baseUrl)
  assert.equal(saved[0].apiKey, '')
  assert.equal(saved[0].hasApiKey, true)
  assert.equal((await service.listSources())[0].models[0].name, 'review-model')
  assert.equal(store.read().modelSources[0].baseUrl, source.baseUrl)
  assert.equal(store.read().modelSources[0].apiKey, source.apiKey)
  const edited = await service.replaceSources([{ ...saved[0], name: '编辑后来源', apiKey: '' }])
  assert.equal(edited[0].hasApiKey, true)
  assert.equal(store.read().modelSources[0].apiKey, source.apiKey)
  await assert.rejects(() => service.replaceSources([{ ...source, baseUrl: 'file:///tmp/model' }]), /HTTP\/HTTPS/)
  await assert.rejects(() => service.replaceSources([{ ...source, models: [] }]), /至少需要一个模型/)
  assert.equal((await service.listSources())[0].models[0].name, 'review-model')
})

test('模型发现和连通性探测使用数据库连接并记录真实健康状态', async () => {
  const store = new JsonStore(null)
  await store.load()
  const service = new ModelService(store)
  await service.replaceSources([source])
  const originalFetch = globalThis.fetch
  const calls: { url: string; authorization: string }[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    calls.push({ url, authorization: headers.get('authorization') ?? '' })
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'review-model' }, { id: 'backup-model' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'smarthub_capability_probe', arguments: '{"value":"ok"}' } }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const discovered = await service.discover(source)
    assert.deepEqual(discovered.map(model => model.name), ['backup-model', 'review-model'])
    const probed = await service.probe(source.id, source.models[0].id)
    assert.equal(probed.ok, true)
    assert.equal(probed.source.health, 'healthy')
    assert.equal(probed.source.models[0].health, 'healthy')
    assert.equal(probed.message, '连通性及工具调用探测成功')
    assert.deepEqual(calls.map(call => call.url), ['https://provider.example/v1/models', 'https://provider.example/v1/chat/completions'])
    assert.ok(calls.every(call => call.authorization === 'Bearer actual-secret'))
    assert.doesNotMatch(JSON.stringify(await service.listSources()), /actual-secret/u)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('声明 tool_calling 的模型未产生真实工具调用时探测失败', async () => {
  const store = new JsonStore(null)
  await store.load()
  const service = new ModelService(store)
  await service.replaceSources([source])
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    const probed = await service.probe(source.id, source.models[0].id)
    assert.equal(probed.ok, false)
    assert.equal(probed.source.models[0].health, 'degraded')
    assert.match(probed.message, /未按要求产生工具调用/u)
  } finally { globalThis.fetch = originalFetch }
})
