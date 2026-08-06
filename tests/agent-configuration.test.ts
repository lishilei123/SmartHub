import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentConfigurationService } from '../server/application/agent-configuration-service.js'
import { AiResourceService } from '../server/application/ai-resource-service.js'
import { JsonStore } from '../server/infrastructure/store.js'

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

test('五个 Agent 分别持久化草稿并发布独立不可变版本', async () => {
  const { store, service } = await fixture()
  const initial = await service.get()
  const extractionInitial = initial.agents.requirementPointExtraction.draft
  const reviewInitial = initial.agents.requirementReview.draft
  const qaInitial = initial.agents.reviewQa.draft
  const technicalExtractionInitial = initial.agents.technicalSolutionExtraction.draft
  const technicalReviewInitial = initial.agents.technicalSolutionReview.draft
  assert.equal(extractionInitial.revision, 0)
  assert.equal(reviewInitial.revision, 0)
  assert.equal(qaInitial.revision, 0)
  assert.equal(technicalExtractionInitial.revision, 0)
  assert.equal(technicalReviewInitial.revision, 0)
  assert.deepEqual(initial.agents.reviewQa.requiredToolIds, ['review.answer_submit'])
  assert.deepEqual(initial.agents.technicalSolutionExtraction.requiredToolIds, ['technical_solution_points.submit_result'])
  assert.deepEqual(initial.agents.technicalSolutionReview.requiredToolIds, ['technical_solution_review.submit_result'])

  const extractionSaved = await service.save({
    agentKey: 'requirementPointExtraction',
    revision: extractionInitial.revision,
    routing: { ...extractionInitial.routing, primaryModel: { sourceId: 'source-agent-config', modelId: 'model-agent-config' }, maxOutputTokens: 4_096 },
    definition: extractionInitial.definition,
  })
  const extractionPublished = await service.publish({ agentKey: 'requirementPointExtraction', revision: extractionSaved.revision, publishedBy: '提取管理员' })
  assert.equal(extractionPublished.agentKey, 'requirementPointExtraction')
  assert.equal(extractionPublished.version, 1)
  assert.equal(await service.resolveActive('requirement-review'), null)

  const reviewSaved = await service.save({
    agentKey: 'requirementReview',
    revision: reviewInitial.revision,
    routing: { ...reviewInitial.routing, primaryModel: { sourceId: 'source-agent-config', modelId: 'model-agent-config' }, maxOutputTokens: 8_192 },
    definition: { ...reviewInitial.definition, systemPrompt: `${reviewInitial.definition.systemPrompt}\n只报告有固定证据支撑的问题。` },
  })
  const reviewPublished = await service.publish({ agentKey: 'requirementReview', revision: reviewSaved.revision, publishedBy: '评审管理员' })
  assert.equal(reviewPublished.agentKey, 'requirementReview')
  assert.equal(reviewPublished.version, 1)
  assert.match(reviewPublished.agentDefinition.systemPrompt, /固定证据支撑/)
  assert.equal((await service.resolve('requirement-review')).contentSha256, reviewPublished.agentDefinition.contentSha256)

  const qaSaved = await service.save({
    agentKey: 'reviewQa',
    revision: qaInitial.revision,
    routing: { ...qaInitial.routing, primaryModel: { sourceId: 'source-agent-config', modelId: 'model-agent-config' }, maxOutputTokens: 4_096 },
    definition: { ...qaInitial.definition, systemPrompt: `${qaInitial.definition.systemPrompt}\n回答时明确列出限制。` },
  })
  const qaPublished = await service.publish({ agentKey: 'reviewQa', revision: qaSaved.revision, publishedBy: '问答管理员' })
  assert.equal(qaPublished.agentKey, 'reviewQa')
  assert.equal(qaPublished.agentDefinition.agentKey, 'review-qa')
  assert.deepEqual(qaPublished.agentDefinition.toolIds, ['review.answer_submit'])
  assert.equal((await service.resolveActive('review-qa'))?.id, qaPublished.id)

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
    agentKey: 'requirementReview',
    revision: reviewSaved.revision,
    routing: reviewSaved.routing,
    definition: { ...reviewSaved.definition, systemPrompt: `${reviewSaved.definition.systemPrompt}\n第二版。` },
  })
  const secondReview = await service.publish({ agentKey: 'requirementReview', revision: secondReviewDraft.revision })
  const state = store.read()
  assert.equal(secondReview.version, 2)
  assert.equal(state.agentConfigurationVersions.find(item => item.id === extractionPublished.id)?.status, 'active')
  assert.equal(state.agentConfigurationVersions.find(item => item.id === reviewPublished.id)?.status, 'superseded')
  assert.doesNotMatch((await service.getVersion(reviewPublished.id)).agentDefinition.systemPrompt, /第二版/)
})

test('Agent 配置读取使用窄查询而不加载完整状态快照', async () => {
  const store = new JsonStore(null)
  await store.load()
  store.snapshot = async () => { throw new Error('不应读取完整状态快照') }
  const service = new AgentConfigurationService(store)

  const configuration = await service.get()

  assert.equal(configuration.scene, 'requirement_analysis')
  assert.equal(configuration.agents.requirementPointExtraction.draft.revision, 0)
  assert.equal(configuration.agents.requirementReview.draft.revision, 0)
  assert.equal(configuration.agents.reviewQa.draft.revision, 0)
  assert.equal(configuration.agents.technicalSolutionExtraction.draft.revision, 0)
  assert.equal(configuration.agents.technicalSolutionReview.draft.revision, 0)
})

test('Agent 配置拒绝移除必需提交工具、过期 revision 和不可用模型', async () => {
  const { store, service } = await fixture()
  const initial = (await service.get()).agents.requirementReview.draft
  await assert.rejects(() => service.save({
    agentKey: 'requirementReview',
    revision: 0,
    routing: initial.routing,
    definition: { ...initial.definition, toolIds: [] },
  }), /必须保留结果提交工具/)

  const saved = await service.save({
    agentKey: 'requirementReview',
    revision: 0,
    routing: { ...initial.routing, primaryModel: { sourceId: 'source-agent-config', modelId: 'model-agent-config' } },
    definition: initial.definition,
  })
  await assert.rejects(() => service.save({ agentKey: 'requirementReview', revision: 0, routing: saved.routing, definition: saved.definition }), /已被其他操作更新/)
  await store.transaction(state => { state.modelSources[0].models[0].health = 'degraded' })
  await assert.rejects(() => service.publish({ agentKey: 'requirementReview', revision: saved.revision }), /尚未通过健康探测/)
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
      toolIds: ['review.submit_result', 'quality.lookup'],
      tags: ['质量', '评审'],
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
    })
  })
  const initial = (await service.get()).agents.requirementReview
  assert.deepEqual(initial.requiredToolIds, ['review.submit_result'])
  assert.deepEqual(initial.requiredSkillKeys, [])
  assert.deepEqual(initial.requiredMcpServerKeys, [])
  assert.deepEqual(initial.draft.definition.skillKeys, [])
  assert.deepEqual(initial.draft.definition.mcpServerKeys, [])

  await assert.rejects(() => service.save({
    agentKey: 'requirementReview', revision: initial.draft.revision, routing: initial.draft.routing,
    definition: { ...initial.draft.definition, skillKeys: ['quality.review'] },
  }), /依赖未选择工具/u)
  await assert.rejects(() => service.save({
    agentKey: 'requirementReview', revision: initial.draft.revision, routing: initial.draft.routing,
    definition: { ...initial.draft.definition, toolIds: [...initial.draft.definition.toolIds, 'quality.lookup'] },
  }), /必须同时选择其 MCP 服务/u)

  const saved = await service.save({
    agentKey: 'requirementReview',
    revision: initial.draft.revision,
    routing: { ...initial.draft.routing, primaryModel: { sourceId: 'source-agent-config', modelId: 'model-agent-config' } },
    definition: { ...initial.draft.definition, skillKeys: ['quality.review'], mcpServerKeys: ['quality.mcp'], toolIds: [...initial.draft.definition.toolIds, 'knowledge.search', 'quality.lookup'] },
  })
  assert.deepEqual(saved.definition.skillKeys, ['quality.review'])
  assert.deepEqual(saved.definition.mcpServerKeys, ['quality.mcp'])
  assert.deepEqual(saved.definition.toolIds, ['review.submit_result', 'knowledge.search', 'quality.lookup'])
  const published = await service.publish({ agentKey: 'requirementReview', revision: saved.revision })
  assert.deepEqual(published.agentDefinition.skillBindings.map(item => ({ skillKey: item.skillKey, version: item.version, enabled: item.enabled })), [
    { skillKey: 'quality.review', version: '1.2.0', enabled: true },
  ])
  assert.match(published.agentDefinition.skillBindings[0].configurationHash, /^[a-f0-9]{64}$/u)
  assert.deepEqual(published.agentDefinition.mcpBindings.map(item => ({ serverKey: item.serverKey, version: item.version, toolIds: item.toolIds })), [
    { serverKey: 'quality.mcp', version: '2.1.0', toolIds: ['quality.lookup'] },
  ])
  assert.match(published.agentDefinition.mcpBindings[0].policyHash, /^[a-f0-9]{64}$/u)
  assert.deepEqual(published.agentDefinition.toolIds, ['review.submit_result', 'knowledge.search', 'quality.lookup'])
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
    agentKey: 'requirementReview',
    revision: saved.revision,
    routing: saved.routing,
    definition: saved.definition,
  }), /包含未启用 Skill/)
  await assert.rejects(() => service.save({
    agentKey: 'requirementReview',
    revision: saved.revision,
    routing: saved.routing,
    definition: { ...saved.definition, skillKeys: ['missing.skill'] },
  }), /包含未注册 Skill/)
})
