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
const { UnauthenticatedError } = await import('../server/domain/access-control.js')
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

function controlsFor(subjectId: string, grants: Array<{ projectVersionId: string | '*'; permissions: Array<'project-version:create' | 'project-version:read' | 'project-version:manage' | 'review:create' | 'review:read' | 'review:cancel' | 'review:retry' | 'review:handle' | 'tool:approve' | 'audit:read' | '*'> }>) {
  return new StaticAccessControl(
    { async authenticate() { return { subjectId, displayName: `测试主体 ${subjectId}` } } },
    new StaticProjectVersionAuthorizer(grants.map(grant => ({ subjectId, ...grant }))),
  )
}

async function createKnowledgeBase(baseUrl: string) {
  const response = await fetch(`${baseUrl}/default-knowledge-base`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(response.status, 200)
  const value = await response.json() as { knowledgeBase: { id: string } }
  return value.knowledgeBase.id
}

test('项目版本授权拒绝未认证和越权评审读取', async () => {
  const unauthenticated = new StaticAccessControl(
    { async authenticate() { throw new UnauthenticatedError() } },
    new StaticProjectVersionAuthorizer([]),
  )
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/project-versions`)
    assert.equal(response.status, 401)
    assert.equal((await response.json() as { error: string }).error, 'UNAUTHENTICATED')
  }, unauthenticated)

  const createdAt = new Date().toISOString()
  await stateStore.transaction(state => {
    state.projects.push(
      { id: 'authorization-project-a', name: 'SmartHub', createdAt },
      { id: 'authorization-project-b', name: '授权项目 B', createdAt },
    )
    state.projectVersions.push(
      { id: 'authorization-pv-a', projectId: 'authorization-project-a', name: 'A', status: 'open', createdAt, updatedAt: createdAt },
      { id: 'authorization-pv-b', projectId: 'authorization-project-b', name: 'B', status: 'open', createdAt, updatedAt: createdAt },
    )
    state.reviewRuns.push({
      id: 'authorization-run-b', projectVersionId: 'authorization-pv-b', assetId: 'authorization-asset', assetVersionId: 'authorization-version', documentTitle: '受保护需求', documentVersion: 1,
      logicalPath: 'requirements/protected.md', sourceId: 'source', modelId: 'model', modelLabel: '测试模型', status: 'failed', step: 'failed', progress: 10,
      createdAt, startedAt: createdAt, finishedAt: createdAt,
      snapshot: { runId: 'authorization-run-b', projectId: 'authorization-project-b', projectName: 'B', projectVersionId: 'authorization-pv-b', projectVersionName: 'B', knowledgeBaseId: 'kb', assetId: 'authorization-asset', assetVersionId: 'authorization-version', assetContentHash: 'a'.repeat(64), indexVersionId: 'index', logicalPath: 'requirements/protected.md', assets: [{ assetId: 'authorization-asset', assetVersionId: 'authorization-version', assetContentHash: 'a'.repeat(64), logicalPath: 'requirements/protected.md', displayName: '受保护需求' }], modelRef: { sourceId: 'source', modelId: 'model', providerType: 'openai_compatible', modelName: 'model', contextWindow: 32_768, maxOutputTokens: 4_096, supportsReasoning: false }, focusAreas: [], excludedAreas: [], agentDefinition: {} as never, agentDefinitions: {} as never, extractionCoveragePlan: [], extractionToolBudget: { directoryCalls: 0, chunkCalls: 0, evidenceCalls: 0, submissionCalls: 1, minimumToolCalls: 1 }, extractionInput: { policyVersion: 'v1', mode: 'full_context', estimatedInputTokens: 1, safeInputBudget: 1, packageSha256: 'b'.repeat(64), batches: [] }, createdAt },
    })
  })
  await withServer(async baseUrl => {
    const list = await fetch(`${baseUrl}/project-versions`)
    assert.equal(list.status, 200)
    assert.deepEqual(await list.json(), [{ id: 'authorization-pv-a', projectId: 'authorization-project-a', name: 'A', status: 'open', createdAt, updatedAt: createdAt }])
    const read = await fetch(`${baseUrl}/requirement-review-runs/authorization-run-b`)
    assert.equal(read.status, 403)
    const qa = await fetch(`${baseUrl}/requirement-review-runs/authorization-run-b/questions?stream=true`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '不应调用运行时' }) })
    assert.equal(qa.status, 403)
  }, controlsFor('reviewer-a', [{ projectVersionId: 'authorization-pv-a', permissions: ['project-version:read', 'review:read'] }]))
})

  test('Agent 配置接口返回需求分析及各场景 Agent 的可编辑草稿', async () => {
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/agent-configurations/requirement-analysis`)
    assert.equal(response.status, 200)
    const body = await response.json() as {
      scene: string
      agents: Record<string, { draft: { revision: number; routing: unknown; definition: { skillKeys: string[]; mcpServerKeys: string[]; toolIds: string[] } }; requiredToolIds: string[]; requiredSkillKeys: string[]; requiredMcpServerKeys: string[]; versions: unknown[] }>
    }
    assert.equal(body.scene, 'requirement_analysis')
    assert.equal(body.agents.requirementAnalysis.draft.revision, 0)
    assert.deepEqual(body.agents.requirementAnalysis.requiredToolIds, ['requirement-analysis.submit_result'])
    assert.deepEqual(body.agents.requirementAnalysis.requiredSkillKeys, ['system.requirement-analysis'])
    assert.equal(body.agents.requirementPointExtraction.draft.revision, 0)
    assert.equal(body.agents.requirementReview.draft.revision, 0)
    assert.equal(body.agents.reviewQa.draft.revision, 0)
    assert.equal(body.agents.technicalSolutionExtraction.draft.revision, 0)
    assert.equal(body.agents.technicalSolutionReview.draft.revision, 0)
    assert.equal(body.agents.testAnalysis.draft.revision, 0)
    assert.equal(body.agents.functionalTestDesign.draft.revision, 0)
    assert.equal(body.agents.nonFunctionalTestDesign.draft.revision, 0)
    assert.equal(body.agents.testCaseSynthesis.draft.revision, 0)
    assert.deepEqual(body.agents.requirementPointExtraction.requiredSkillKeys, [])
    assert.deepEqual(body.agents.requirementReview.requiredToolIds, ['review.submit_result'])
    assert.deepEqual(body.agents.reviewQa.requiredToolIds, ['review.answer_submit'])
    assert.deepEqual(body.agents.technicalSolutionExtraction.requiredToolIds, ['technical_solution_points.submit_result'])
    assert.deepEqual(body.agents.technicalSolutionReview.requiredToolIds, ['technical_solution_review.submit_result'])
    assert.deepEqual(body.agents.testAnalysis.requiredToolIds, ['test_analysis.submit_result'])
    assert.deepEqual(body.agents.functionalTestDesign.requiredToolIds, ['functional_test_design.submit_result'])
    assert.deepEqual(body.agents.nonFunctionalTestDesign.requiredToolIds, ['non_functional_test_design.submit_result'])
    assert.deepEqual(body.agents.testCaseSynthesis.requiredToolIds, ['test_case_synthesis.submit_result'])
    assert.deepEqual(body.agents.requirementReview.requiredMcpServerKeys, [])
    assert.deepEqual(body.agents.requirementReview.draft.definition.skillKeys, [])
    assert.deepEqual(body.agents.requirementReview.draft.definition.mcpServerKeys, [])
    assert.deepEqual(body.agents.requirementPointExtraction.versions, [])
    assert.deepEqual(body.agents.requirementReview.versions, [])
    assert.deepEqual(body.agents.reviewQa.versions, [])
    assert.deepEqual(body.agents.technicalSolutionExtraction.versions, [])
    assert.deepEqual(body.agents.technicalSolutionReview.versions, [])

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
    const draft = body.agents.requirementReview.draft
    const savedResponse = await fetch(`${baseUrl}/agent-configurations/requirement-analysis/draft`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentKey: 'requirementReview', revision: draft.revision, routing: draft.routing, definition: { ...draft.definition, skillKeys: ['http.agent.skill'], mcpServerKeys: ['http.agent.mcp'], toolIds: [...draft.definition.toolIds, 'http.agent.tool'] } }),
    })
    assert.equal(savedResponse.status, 200)
    const saved = await savedResponse.json() as { definition: { skillKeys: string[]; mcpServerKeys: string[]; toolIds: string[] } }
    assert.deepEqual(saved.definition.skillKeys, ['http.agent.skill'])
    assert.deepEqual(saved.definition.mcpServerKeys, ['http.agent.mcp'])
    assert.deepEqual(saved.definition.toolIds, ['review.submit_result', 'http.agent.tool'])
  })
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
