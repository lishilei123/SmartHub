import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentSkillRuntime } from '../server/agent/skill-runtime.js'
import { defaultAgentDefinitionResolver } from '../server/agent/dynamic-agent-definition-resolver.js'
import { AiResourceService } from '../server/application/ai-resource-service.js'
import { JsonStore } from '../server/infrastructure/store.js'

test('Stage Catalog 引用未绑定 Skill 时在模型启动前失败', async () => {
  const store = new JsonStore(null)
  await store.load()
  await new AiResourceService(store, undefined, { reloadIntervalMs: 0 }).initialize()
  const definition = { ...defaultAgentDefinitionResolver.resolve('requirement-analysis'), skillBindings: [] }
  await assert.rejects(() => new AgentSkillRuntime(store).prepare(definition, 'repair', ['requirement.repair']), /STAGE_SKILL_BINDING_UNAVAILABLE/u)
})
