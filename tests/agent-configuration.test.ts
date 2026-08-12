import assert from 'node:assert/strict'
import test from 'node:test'
import { PiTestDesignRuntimeAdapter } from '../server/agent/pi-test-design-runtime.js'
import { AgentConfigurationService } from '../server/application/agent-configuration-service.js'
import { AiResourceService } from '../server/application/ai-resource-service.js'
import { JsonStore } from '../server/infrastructure/store.js'
import { materializeRequiredAgentCapabilities } from '../src/agent-configuration-api.js'

async function fixture() {
  const store = new JsonStore(null)
  await store.load()
  await store.transaction(state => {
    state.modelSources.push({
      id: 'source-agent-config',
      name: 'Agent 配置测试来源',
      providerType: 'openai_compatible',
      baseUrl: 'https://models.example/v1',
      apiKey: 'secret',
      enabled: true,
      health: 'healthy',
      priority: 1,
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
      models: [{
        id: 'model-agent-config',
        name: 'agent-model',
        displayName: 'Agent Model',
        contextWindow: 65_536,
        maxOutputTokens: 16_384,
        capabilities: ['structured_output', 'tool_calling', 'reasoning'],
        enabled: true,
        health: 'healthy',
        qualityGate: { version: 'model-probe/v2', checkedAt: '2026-07-27T00:00:00.000Z', passed: true, sampleSha256: 'a'.repeat(64), inputCharacters: 8_000, checks: { connectivity: true, longContext: true, structuredSubmission: true, toolCalling: true } },
      }],
    })
  })
  await new AiResourceService(store).list()
  return { store, service: new AgentConfigurationService(store) }
}

test('统一需求分析 Agent 独立发布 Workspace、Knowledge、Skill 与提交协议快照', async () => {
  const { service } = await fixture()
  const initial = (await service.get()).agents.requirementAnalysis
  assert.deepEqual(initial.requiredToolIds, ['skill.activate', 'requirement-analysis.submit_result', 'requirement-repair.submit_result', 'requirement-release.submit_result'])
  assert.deepEqual(initial.requiredSkillKeys, ['requirement.baseline', 'requirement.review', 'requirement.repair', 'requirement.verification', 'requirement.release'])
  assert.ok(initial.draft.definition.toolIds.includes('workspace.read_file'))
  assert.ok(initial.draft.definition.toolIds.includes('knowledge.search'))
  const saved = await service.save({
    agentKey: 'requirementAnalysis',
    revision: initial.draft.revision,
    routing: { ...initial.draft.routing, primaryModel: { sourceId: 'source-agent-config', modelId: 'model-agent-config' }, maxOutputTokens: 12_288 },
    definition: initial.draft.definition,
  })
  const published = await service.publish({ agentKey: 'requirementAnalysis', revision: saved.revision, publishedBy: '需求分析管理员' })
  assert.equal(published.agentDefinition.agentKey, 'requirement-analysis')
  assert.equal(published.agentDefinition.resultSchemaVersion, 'requirement-analysis/v1')
  assert.deepEqual(published.agentDefinition.skillBindings.map(binding => binding.skillKey), initial.requiredSkillKeys)
  assert.equal((await service.resolveActive('requirement-analysis'))?.id, published.id)
})

test('旧需求分析草稿加载和前端发布 payload 都会补齐新增的必需能力', async () => {
  const { store, service } = await fixture()
  const initialState = (await service.get()).agents.requirementAnalysis
  const firstSaved = await service.save({
    agentKey: 'requirementAnalysis',
    revision: initialState.draft.revision,
    routing: { ...initialState.draft.routing, primaryModel: { sourceId: 'source-agent-config', modelId: 'model-agent-config' } },
    definition: initialState.draft.definition,
  })
  const newlyRequiredTools = new Set(['skill.activate', 'requirement-repair.submit_result', 'requirement-release.submit_result'])
  await store.transaction(state => {
    const stored = state.agentConfigurationDrafts.find(item => item.scene === 'requirement_analysis')!.agents.requirementAnalysis
    stored.definition.toolIds = stored.definition.toolIds.filter(toolId => !newlyRequiredTools.has(toolId))
    stored.definition.skillKeys = []
  })

  const reloaded = (await service.get()).agents.requirementAnalysis
  assert.equal(reloaded.draft.revision, firstSaved.revision)
  assert.ok(reloaded.requiredToolIds.every(toolId => reloaded.draft.definition.toolIds.includes(toolId)))
  assert.ok(reloaded.requiredSkillKeys.every(skillKey => reloaded.draft.definition.skillKeys.includes(skillKey)))

  const staleBrowserDraft = structuredClone(reloaded.draft)
  staleBrowserDraft.definition.toolIds = staleBrowserDraft.definition.toolIds.filter(toolId => !newlyRequiredTools.has(toolId))
  staleBrowserDraft.definition.skillKeys = []
  const publishPayload = materializeRequiredAgentCapabilities(staleBrowserDraft, reloaded)
  assert.ok(reloaded.requiredToolIds.every(toolId => publishPayload.definition.toolIds.includes(toolId)))
  assert.ok(reloaded.requiredSkillKeys.every(skillKey => publishPayload.definition.skillKeys.includes(skillKey)))
  assert.equal(staleBrowserDraft.definition.toolIds.includes('skill.activate'), false)

  const migrated = await service.save({ agentKey: 'requirementAnalysis', revision: publishPayload.revision, routing: publishPayload.routing, definition: publishPayload.definition })
  const published = await service.publish({ agentKey: 'requirementAnalysis', revision: migrated.revision })
  assert.ok(reloaded.requiredToolIds.every(toolId => published.agentDefinition.toolIds.includes(toolId)))
  assert.ok(reloaded.requiredSkillKeys.every(skillKey => published.agentDefinition.skillBindings.some(binding => binding.skillKey === skillKey)))
})

test('统一需求分析、技术方案与测试设计 Agent 分别发布独立不可变版本', async () => {
  const { store, service } = await fixture()
  const initial = await service.get()
  const technicalExtractionInitial = initial.agents.technicalSolutionExtraction.draft
  const technicalReviewInitial = initial.agents.technicalSolutionReview.draft
  assert.equal('requirementPointExtraction' in initial.agents, false)
  assert.equal('requirementReview' in initial.agents, false)
  assert.equal(technicalExtractionInitial.revision, 0)
  assert.equal(technicalReviewInitial.revision, 0)
  assert.equal('temperature' in technicalExtractionInitial.routing, false)
  assert.deepEqual(initial.agents.technicalSolutionExtraction.requiredToolIds, ['technical_solution_points.submit_result'])
  assert.deepEqual(initial.agents.technicalSolutionReview.requiredToolIds, ['technical_solution_review.submit_result'])
  assert.deepEqual(initial.agents.testAnalysis.requiredToolIds, ['test_analysis.submit_result'])
  assert.deepEqual(initial.agents.functionalTestDesign.requiredToolIds, ['functional_test_design.submit_result'])
  assert.deepEqual(initial.agents.nonFunctionalTestDesign.requiredToolIds, ['non_functional_test_design.submit_result'])
  assert.deepEqual(initial.agents.testCaseSynthesis.requiredToolIds, ['test_case_synthesis.submit_result'])
  const testAnalysisInitial = initial.agents.testAnalysis.draft
  const testAnalysisSaved = await service.save({ agentKey: 'testAnalysis', revision: testAnalysisInitial.revision, routing: { ...testAnalysisInitial.routing, primaryModel: { sourceId: 'source-agent-config', modelId: 'model-agent-config' }, maxOutputTokens: 8_192 }, definition: testAnalysisInitial.definition })
  const testAnalysisPublished = await service.publish({ agentKey: 'testAnalysis', revision: testAnalysisSaved.revision, publishedBy: '测试设计管理员' })
  assert.equal(testAnalysisPublished.scene, 'test_design')
  assert.equal(testAnalysisPublished.agentDefinition.modelScene, 'test_design')

  const technicalExtractionSaved = await service.save({
    agentKey: 'technicalSolutionExtraction', revision: technicalExtractionInitial.revision,
    routing: { ...technicalExtractionInitial.routing, primaryModel: { sourceId: 'source-agent-config', modelId: 'model-agent-config' }, maxOutputTokens: 8_192 },
    definition: technicalExtractionInitial.definition,
  })
  const technicalExtractionPublished = await service.publish({ agentKey: 'technicalSolutionExtraction', revision: technicalExtractionSaved.revision, publishedBy: '技术方案管理员' })
  const technicalReviewSaved = await service.save({ agentKey: 'technicalSolutionReview', revision: technicalReviewInitial.revision, routing: { ...technicalReviewInitial.routing, primaryModel: { sourceId: 'source-agent-config', modelId: 'model-agent-config' }, maxOutputTokens: 8_192 }, definition: technicalReviewInitial.definition })
  const technicalReviewPublished = await service.publish({ agentKey: 'technicalSolutionReview', revision: technicalReviewSaved.revision, publishedBy: '技术方案管理员' })
  assert.equal(technicalExtractionPublished.agentDefinition.agentKey, 'technical-solution-extraction')
  assert.equal(technicalReviewPublished.agentDefinition.agentKey, 'technical-solution-review')
  assert.equal(technicalReviewPublished.agentDefinition.modelScene, 'technical_solution_analysis')
  assert.equal((await service.resolveActive('technical-solution-extraction'))?.id, technicalExtractionPublished.id)
  assert.equal((await service.resolveActive('technical-solution-review'))?.id, technicalReviewPublished.id)

  const secondReviewDraft = await service.save({
    agentKey: 'technicalSolutionReview',
    revision: technicalReviewSaved.revision,
    routing: technicalReviewSaved.routing,
    definition: { ...technicalReviewSaved.definition, systemPrompt: `${technicalReviewSaved.definition.systemPrompt}\n第二版。` },
  })
  const secondReview = await service.publish({ agentKey: 'technicalSolutionReview', revision: secondReviewDraft.revision })
  const state = store.read()
  assert.equal(secondReview.version, 2)
  assert.equal(state.agentConfigurationVersions.find(item => item.id === technicalExtractionPublished.id)?.status, 'active')
  assert.equal(state.agentConfigurationVersions.find(item => item.id === technicalReviewPublished.id)?.status, 'superseded')
  assert.doesNotMatch((await service.getVersion(technicalReviewPublished.id)).agentDefinition.systemPrompt, /第二版/)
})

test('Agent 配置读取使用窄查询而不加载完整状态快照', async () => {
  const store = new JsonStore(null)
  await store.load()
  store.snapshot = async () => { throw new Error('不应读取完整状态快照') }
  const service = new AgentConfigurationService(store)

  const configuration = await service.get()

  assert.equal(configuration.scene, 'requirement_analysis')
  assert.equal(configuration.agents.requirementAnalysis.draft.revision, 0)
  assert.equal('requirementPointExtraction' in configuration.agents, false)
  assert.equal('requirementReview' in configuration.agents, false)
  assert.equal('reviewQa' in configuration.agents, false)
  assert.equal(configuration.agents.technicalSolutionExtraction.draft.revision, 0)
  assert.equal(configuration.agents.technicalSolutionReview.draft.revision, 0)
})

test('Agent 配置拒绝移除必需提交工具、过期 revision 和不可用模型', async () => {
  const { store, service } = await fixture()
  const initial = (await service.get()).agents.requirementAnalysis.draft
  await assert.rejects(() => service.save({
    agentKey: 'requirementAnalysis',
    revision: 0,
    routing: initial.routing,
    definition: { ...initial.definition, toolIds: [] },
  }), /必须保留结果提交工具/)

  const saved = await service.save({
    agentKey: 'requirementAnalysis',
    revision: 0,
    routing: { ...initial.routing, primaryModel: { sourceId: 'source-agent-config', modelId: 'model-agent-config' } },
    definition: initial.definition,
  })
  await assert.rejects(() => service.save({ agentKey: 'requirementAnalysis', revision: 0, routing: saved.routing, definition: saved.definition }), /已被其他操作更新/)
  await store.transaction(state => { state.modelSources[0].models[0].health = 'degraded' })
  await assert.rejects(() => service.publish({ agentKey: 'requirementAnalysis', revision: saved.revision }), /尚未通过健康探测/)
})

test('测试设计 Agent 保留必需提交工具时允许绑定额外工具', async () => {
  const { store, service } = await fixture()
  const initial = (await service.get()).agents.testAnalysis.draft
  const saved = await service.save({
    agentKey: 'testAnalysis',
    revision: initial.revision,
    routing: { ...initial.routing, primaryModel: { sourceId: 'source-agent-config', modelId: 'model-agent-config' } },
    definition: { ...initial.definition, toolIds: [...initial.definition.toolIds, 'knowledge.search'] },
  })
  await service.publish({ agentKey: 'testAnalysis', revision: saved.revision })

  const runtime = new PiTestDesignRuntimeAdapter(store, null as never, service)
  const readiness = await runtime.readiness()
  const testAnalysis = readiness.agents.find(item => item.agentKey === 'test-analysis')

  assert.equal(testAnalysis?.ready, true)
  assert.equal(testAnalysis?.reason, undefined)
})

test('Agent 最大输出 Token 独立于模型目录中的历史输出值', async () => {
  const { service } = await fixture()
  const initial = (await service.get()).agents.requirementAnalysis.draft
  const saved = await service.save({
    agentKey: 'requirementAnalysis',
    revision: initial.revision,
    routing: { ...initial.routing, primaryModel: { sourceId: 'source-agent-config', modelId: 'model-agent-config' }, maxOutputTokens: 32_768 },
    definition: initial.definition,
  })
  const published = await service.publish({ agentKey: 'requirementAnalysis', revision: saved.revision })

  assert.equal(published.routing.maxOutputTokens, 32_768)
  assert.equal('temperature' in published.routing, false)
})

test('Agent 配置可选择完整 Tool、MCP、Skill 并在发布版本中固定资源版本', async () => {
  const { store, service } = await fixture()
  await store.transaction(state => {
    state.aiResources.push({
      id: 'mcp-quality-review', kind: 'mcp', key: 'quality.mcp', name: '质量 MCP', description: '质量系统远程工具', version: '2.1.0', enabled: true, status: 'draft', builtIn: false,
      transport: 'streamable_http', endpoint: 'https://quality.example.com/mcp', authType: 'none', toolIds: ['quality.lookup'], createdAt: '2026-07-27T00:00:00.000Z', updatedAt: '2026-07-27T00:00:00.000Z',
    })
    state.aiResources.push({
      id: 'tool-quality-lookup', kind: 'tool', key: 'quality.lookup', name: '质量查询', description: '查询质量规则', version: '3.0.0', enabled: true, status: 'draft', builtIn: false,
      source: 'mcp', risk: 'network_read', timeoutMs: 30_000, mcpServerId: 'mcp-quality-review', createdAt: '2026-07-27T00:00:00.000Z', updatedAt: '2026-07-27T00:00:00.000Z',
    })
    state.aiResources.push({
      id: 'skill-quality-review',
      kind: 'skill',
      key: 'quality.review',
      name: '质量复核',
      description: '复核边界与验收条件',
      version: '1.2.0',
      enabled: true,
      status: 'draft',
      builtIn: false,
      entrypoint: 'ai/skills/quality-review/SKILL.md',
      toolIds: ['technical_solution_review.submit_result', 'quality.lookup'],
      tags: ['质量', '评审'],
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
    })
  })
  const initial = (await service.get()).agents.technicalSolutionReview
  assert.deepEqual(initial.requiredToolIds, ['technical_solution_review.submit_result'])
  assert.deepEqual(initial.requiredSkillKeys, [])
  assert.deepEqual(initial.requiredMcpServerKeys, [])
  assert.deepEqual(initial.draft.definition.skillKeys, [])
  assert.deepEqual(initial.draft.definition.mcpServerKeys, [])

  await assert.rejects(() => service.save({
    agentKey: 'technicalSolutionReview', revision: initial.draft.revision, routing: initial.draft.routing,
    definition: { ...initial.draft.definition, skillKeys: ['quality.review'] },
  }), /依赖未选择工具/u)
  await assert.rejects(() => service.save({
    agentKey: 'technicalSolutionReview', revision: initial.draft.revision, routing: initial.draft.routing,
    definition: { ...initial.draft.definition, toolIds: [...initial.draft.definition.toolIds, 'quality.lookup'] },
  }), /必须同时选择其 MCP 服务/u)

  const saved = await service.save({
    agentKey: 'technicalSolutionReview',
    revision: initial.draft.revision,
    routing: { ...initial.draft.routing, primaryModel: { sourceId: 'source-agent-config', modelId: 'model-agent-config' } },
    definition: { ...initial.draft.definition, skillKeys: ['quality.review'], mcpServerKeys: ['quality.mcp'], toolIds: [...initial.draft.definition.toolIds, 'knowledge.search', 'quality.lookup'] },
  })
  assert.deepEqual(saved.definition.skillKeys, ['quality.review'])
  assert.deepEqual(saved.definition.mcpServerKeys, ['quality.mcp'])
  assert.deepEqual(saved.definition.toolIds, ['technical_solution_review.submit_result', 'knowledge.search', 'quality.lookup'])
  const published = await service.publish({ agentKey: 'technicalSolutionReview', revision: saved.revision })
  assert.deepEqual(published.agentDefinition.skillBindings.map(item => ({ skillKey: item.skillKey, version: item.version, enabled: item.enabled })), [
    { skillKey: 'quality.review', version: '1.2.0', enabled: true },
  ])
  assert.match(published.agentDefinition.skillBindings[0].configurationHash, /^[a-f0-9]{64}$/u)
  assert.deepEqual(published.agentDefinition.mcpBindings.map(item => ({ serverKey: item.serverKey, version: item.version, toolIds: item.toolIds })), [
    { serverKey: 'quality.mcp', version: '2.1.0', toolIds: ['quality.lookup'] },
  ])
  assert.match(published.agentDefinition.mcpBindings[0].policyHash, /^[a-f0-9]{64}$/u)
  assert.deepEqual(published.agentDefinition.toolIds, ['technical_solution_review.submit_result', 'knowledge.search', 'quality.lookup'])
  await assert.rejects(() => new AiResourceService(store).delete('skill', 'skill-quality-review'), /仍被 Agent 草稿引用/)
  await assert.rejects(() => new AiResourceService(store).delete('mcp', 'mcp-quality-review'), /仍被工具引用/)
  await assert.rejects(() => new AiResourceService(store).delete('tool', 'tool-quality-lookup'), /仍被 Skill 引用/)

  await store.transaction(state => {
    const skill = state.aiResources.find(item => item.kind === 'skill' && item.key === 'quality.review')!
    skill.version = '2.0.0'
    skill.enabled = false
  })
  assert.equal((await service.getVersion(published.id)).agentDefinition.skillBindings[0].version, '1.2.0')
  await assert.rejects(() => service.save({
    agentKey: 'technicalSolutionReview',
    revision: saved.revision,
    routing: saved.routing,
    definition: saved.definition,
  }), /包含未启用 Skill/)
  await assert.rejects(() => service.save({
    agentKey: 'technicalSolutionReview',
    revision: saved.revision,
    routing: saved.routing,
    definition: { ...saved.definition, skillKeys: ['missing.skill'] },
  }), /包含未注册 Skill/)
})
