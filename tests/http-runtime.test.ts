import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const httpTestRoot = await mkdtemp(join(tmpdir(), 'smarthub-http-test-'))
process.env.SMARTHUB_FORCE_JSON_STORE = 'true'
process.env.SMARTHUB_DATA_FILE = join(httpTestRoot, 'smarthub.json')
process.env.SMARTHUB_DOCUMENT_ROOT = join(httpTestRoot, 'knowledge-bases')
process.env.SMARTHUB_MODEL_ROOT = join(httpTestRoot, 'models')
process.env.SMARTHUB_SKILL_ROOT = join(httpTestRoot, 'skills')
const { start, stateStore } = await import('../server/http/server.js')
const { StaticAccessControl, StaticProjectVersionAuthorizer } = await import('../server/http/access-control.js')
delete process.env.SMARTHUB_FORCE_JSON_STORE
delete process.env.SMARTHUB_DATA_FILE
delete process.env.SMARTHUB_DOCUMENT_ROOT
delete process.env.SMARTHUB_MODEL_ROOT
delete process.env.SMARTHUB_SKILL_ROOT
test.after(async () => { await rm(httpTestRoot, { recursive: true, force: true }) })

async function withServer(run: (baseUrl: string) => Promise<void>, controls?: InstanceType<typeof StaticAccessControl>) {
  const server = await start(0, controls)
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

type HttpAgentConfiguration = {
  scene: string
  agents: Record<string, {
    draft: { revision: number; routing: Record<string, unknown>; definition: { skillKeys: string[]; mcpServerKeys: string[]; toolIds: string[] } }
    requiredToolIds: string[]
    requiredSkillKeys: string[]
    requiredMcpServerKeys: string[]
    versions: unknown[]
  }>
}

async function loadAgentConfiguration(baseUrl: string, scenePath: 'requirement-analysis' | 'test-design' | 'test-execution') {
  const response = await fetch(`${baseUrl}/agent-configurations/${scenePath}`)
  assert.equal(response.status, 200)
  return await response.json() as HttpAgentConfiguration
}

test('Agent 配置接口按场景返回精确 Agent 集合并隔离保存', async () => {
  await withServer(async baseUrl => {
    const requirementAnalysis = await loadAgentConfiguration(baseUrl, 'requirement-analysis')
    assert.equal(requirementAnalysis.scene, 'requirement_analysis')
    assert.deepEqual(Object.keys(requirementAnalysis.agents), ['requirementAnalysis'])
    assert.equal(requirementAnalysis.agents.requirementAnalysis.draft.revision, 0)
    assert.deepEqual(requirementAnalysis.agents.requirementAnalysis.requiredToolIds, ['requirement-analysis.submit_result', 'requirement-repair.submit_result', 'requirement-release.submit_result'])

    const testDesign = await loadAgentConfiguration(baseUrl, 'test-design')
    assert.equal(testDesign.scene, 'test_design')
    assert.deepEqual(Object.keys(testDesign.agents), ['testDesign'])
    assert.equal(testDesign.agents.testDesign.draft.revision, 0)
    assert.deepEqual(testDesign.agents.testDesign.requiredToolIds, ['workspace.read_file', 'workspace.grep_files', 'workspace.find_files', 'workspace.list_directory', 'knowledge.search', 'knowledge.read_chunk', 'test_design_points.submit_result', 'test_design_cases.submit_result', 'test_design_repair.submit_result'])
    assert.deepEqual(testDesign.agents.testDesign.requiredSkillKeys, ['test-design-baseline', 'test-point-design', 'test-case-design', 'test-design-repair'])

    const testExecution = await loadAgentConfiguration(baseUrl, 'test-execution')
    assert.equal(testExecution.scene, 'test_execution')
    assert.deepEqual(Object.keys(testExecution.agents), ['testScript', 'failureAnalysis', 'scriptRepair'])

    const skillResponse = await fetch(`${baseUrl}/ai-resources/skill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'http.agent.skill', name: 'HTTP Agent Skill', version: '1.0.0', enabled: true, entrypoint: 'ai/skills/http-agent/SKILL.md', toolIds: [], tags: ['agent'] }),
    })
    assert.equal(skillResponse.status, 201)
    const mcpResponse = await fetch(`${baseUrl}/ai-resources/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'http.agent.mcp', name: 'HTTP Agent MCP', version: '1.0.0', enabled: true, transport: 'streamable_http', endpoint: 'https://agent.example.com/mcp', authType: 'none', toolIds: ['http.agent.tool'] }),
    })
    assert.equal(mcpResponse.status, 201)
    const mcp = await mcpResponse.json() as { id: string }
    const toolResponse = await fetch(`${baseUrl}/ai-resources/tool`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'http.agent.tool', name: 'HTTP Agent Tool', version: '1.0.0', enabled: true, source: 'mcp', risk: 'network_read', timeoutMs: 30_000, mcpServerId: mcp.id }),
    })
    assert.equal(toolResponse.status, 201)
    const draft = testDesign.agents.testDesign.draft
    const crossSceneSave = await fetch(`${baseUrl}/agent-configurations/requirement-analysis/draft`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentKey: 'testDesign', revision: draft.revision, routing: draft.routing, definition: draft.definition }),
    })
    assert.equal(crossSceneSave.status, 400)
    assert.match((await crossSceneSave.json() as { error: string }).error, /不属于当前配置场景/u)

    const savedResponse = await fetch(`${baseUrl}/agent-configurations/test-design/draft`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentKey: 'testDesign', revision: draft.revision, routing: draft.routing, definition: { ...draft.definition, skillKeys: [...draft.definition.skillKeys, 'http.agent.skill'], mcpServerKeys: ['http.agent.mcp'], toolIds: [...draft.definition.toolIds, 'http.agent.tool'] } }),
    })
    assert.equal(savedResponse.status, 200)
    const saved = await savedResponse.json() as { definition: { skillKeys: string[]; mcpServerKeys: string[]; toolIds: string[] } }
    assert.ok(saved.definition.skillKeys.includes('http.agent.skill'))
    assert.deepEqual(saved.definition.mcpServerKeys, ['http.agent.mcp'])
    assert.ok(saved.definition.toolIds.includes('test_design_points.submit_result'))
    assert.ok(saved.definition.toolIds.includes('http.agent.tool'))
  })
})

test('Agent 配置发布人使用认证主体而不是请求 body', async () => {
  const principalName = '认证配置管理员'
  const controls = new StaticAccessControl(
    { async authenticate() { return { subjectId: 'agent-publisher', displayName: principalName } } },
    new StaticProjectVersionAuthorizer([]),
  )
  await withServer(async baseUrl => {
    const source = {
      id: 'http-agent-publish-source',
      name: 'HTTP Agent 发布来源',
      providerType: 'openai_compatible',
      baseUrl: 'https://models.example/v1',
      apiKey: 'secret',
      enabled: true,
      health: 'healthy',
      priority: 1,
      models: [{
        id: 'http-agent-publish-model',
        name: 'agent-model',
        displayName: 'Agent Model',
        contextWindow: 65_536,
        maxOutputTokens: 16_384,
        capabilities: ['structured_output', 'tool_calling', 'reasoning'],
        enabled: true,
        health: 'healthy',
        qualityGate: { version: 'model-probe/v2', checkedAt: '2026-08-13T00:00:00.000Z', passed: true, sampleSha256: 'a'.repeat(64), inputCharacters: 8_000, checks: { connectivity: true, longContext: true, structuredSubmission: true, toolCalling: true } },
      }],
    }
    const now = '2026-08-13T00:00:00.000Z'
    await stateStore.transaction(state => {
      state.modelSources = state.modelSources.filter(item => item.id !== source.id)
      state.modelSources.push({ ...source, createdAt: now, updatedAt: now } as never)
    })

    const configuration = await loadAgentConfiguration(baseUrl, 'requirement-analysis')
    const draft = configuration.agents.requirementAnalysis.draft
    const savedResponse = await fetch(`${baseUrl}/agent-configurations/requirement-analysis/draft`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentKey: 'requirementAnalysis', revision: draft.revision, routing: { ...draft.routing, primaryModel: { sourceId: source.id, modelId: source.models[0].id } }, definition: draft.definition }),
    })
    assert.equal(savedResponse.status, 200)
    const saved = await savedResponse.json() as { revision: number }

    const publishedResponse = await fetch(`${baseUrl}/agent-configurations/requirement-analysis/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentKey: 'requirementAnalysis', revision: saved.revision, publishedBy: '伪造发布人' }),
    })
    const published = await publishedResponse.json() as { publishedBy?: string; error?: string }
    assert.equal(publishedResponse.status, 201, published.error)
    assert.equal(published.publishedBy, principalName)
    assert.notEqual(published.publishedBy, '伪造发布人')
  }, controls)
})

test('本地模型运行状态接口返回隔离的缓存目录', async () => {
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/local-model/status`)
    assert.equal(response.status, 200)
    const status = await response.json() as { phase: string; cacheDirectory: string }
    assert.equal(status.phase, 'idle')
    assert.match(status.cacheDirectory.replaceAll('\\', '/'), /models\/cache$/)
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
