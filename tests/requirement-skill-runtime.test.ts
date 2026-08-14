import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentSkillRuntime } from '../server/agent/skill-runtime.js'
import { defaultAgentDefinitionResolver } from '../server/agent/dynamic-agent-definition-resolver.js'
import { AiResourceService } from '../server/application/ai-resource-service.js'
import { JsonStore } from '../server/infrastructure/store.js'

test('发布配置绑定的全部 Skill 在模型启动前直接加载', async () => {
  const store = new JsonStore(null)
  await store.load()
  await new AiResourceService(store, undefined, { reloadIntervalMs: 0 }).initialize()
  const definition = defaultAgentDefinitionResolver.resolve('planning')
  const session = await new AgentSkillRuntime(store).prepare(definition, 'repair')
  const prompt = session.renderPrompt()
  assert.match(prompt, /TRUSTED_SKILL key="requirement\.repair"/u)
  assert.doesNotMatch(prompt, /skill_activate/u)
})
