import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentSkillRuntime } from '../server/agent/skill-runtime.js'
import { defaultAgentDefinitionResolver } from '../server/agent/dynamic-agent-definition-resolver.js'
import { AiResourceService } from '../server/application/ai-resource-service.js'
import { JsonStore } from '../server/infrastructure/store.js'

test('Workflow 固定 Stage 后 Runtime 只暴露该阶段 Skill Catalog，Agent 可按需激活', async () => {
  const store = new JsonStore(null)
  await store.load()
  const resources = new AiResourceService(store, undefined, { reloadIntervalMs: 0 })
  await resources.initialize()
  const definition = defaultAgentDefinitionResolver.resolve('requirement-analysis')
  const session = await new AgentSkillRuntime(store).prepare(definition, 'analysis', ['requirement.baseline', 'requirement.review'])

  assert.deepEqual(session.catalog().map(item => item.key), ['requirement.baseline', 'requirement.review'])
  assert.deepEqual(session.activatedKeys(), [])
  assert.match(session.renderCatalogPrompt(), /可以根据任务选择不激活、激活一个或激活多个/u)
  assert.doesNotMatch(session.renderCatalogPrompt(), /# 建立需求基线/u)
  assert.doesNotMatch(session.renderCatalogPrompt(), /requirement\.repair/u)

  const activated = await session.activate('requirement.baseline')
  assert.match(activated.content, /<<<TRUSTED_SKILL key="requirement\.baseline" version="1\.0\.0">>>/u)
  assert.match(activated.content, /# 建立需求基线/u)
  assert.deepEqual(session.activatedKeys(), ['requirement.baseline'])
  await assert.rejects(() => session.activate('requirement.repair'), /SKILL_NOT_ALLOWED_IN_STAGE/u)
})

test('Stage Catalog 引用未绑定 Skill 时在模型启动前失败', async () => {
  const store = new JsonStore(null)
  await store.load()
  await new AiResourceService(store, undefined, { reloadIntervalMs: 0 }).initialize()
  const definition = { ...defaultAgentDefinitionResolver.resolve('requirement-analysis'), skillBindings: [] }
  await assert.rejects(() => new AgentSkillRuntime(store).prepare(definition, 'repair', ['requirement.repair']), /STAGE_SKILL_BINDING_UNAVAILABLE/u)
})
