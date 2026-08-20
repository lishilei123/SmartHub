import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentSkillRuntime, type SkillReadData } from '../server/agent/skill-runtime.js'
import { defaultAgentDefinitionResolver } from '../server/agent/dynamic-agent-definition-resolver.js'
import { AiResourceService } from '../server/application/ai-resource-service.js'
import type { ReviewRunSnapshot } from '../server/domain/agent-types.js'
import type { SkillResource } from '../server/domain/types.js'
import { JsonStore } from '../server/infrastructure/store.js'
import { ToolRegistry } from '../server/tools/registry.js'

test('System Prompt 只包含 Enabled Skill Catalog，不包含任何 Skill 正文', async () => {
  const { session } = await prepareSkills(['requirement.analysis', 'test-case-design'])
  const prompt = session.renderPrompt()

  assert.match(prompt, /runtime_skill_catalog_contract authority="highest"/u)
  assert.match(prompt, /优先于 Agent Configuration、Session 历史或旧 Context Summary/u)
  assert.match(prompt, /当前 Agent 可用 Skills（发布配置目录；不包含 Skill 正文）/u)
  assert.match(prompt, /- requirement\.analysis[\s\S]*description:[\s\S]*version: 1\.0\.0[\s\S]*tags:/u)
  assert.match(prompt, /- test-case-design[\s\S]*version: 1\.2\.0/u)
  assert.match(prompt, /skill\.read/u)
  assert.doesNotMatch(prompt, /<<<TRUSTED_SKILL/u)
  assert.doesNotMatch(prompt, /# Requirement Analysis 方法论/u)
  assert.doesNotMatch(prompt, /# Test case design/u)
  assert.doesNotMatch(prompt, /server\/skills|SKILL\.md/u)
})

test('skill.read 返回当前绑定版本的 TRUSTED_SKILL 正文，并在同轮缓存重放', async () => {
  const { store, session } = await prepareSkills(['test-case-design'])
  const registry = new ToolRegistry()
  session.register(registry)
  assert.deepEqual(session.runtimeToolIds(), ['skill.read'])
  assert.equal(registry.get('skill.read')?.descriptor.risk, 'read')

  const originalSnapshot = store.snapshot.bind(store)
  let snapshotCalls = 0
  store.snapshot = async () => {
    snapshotCalls += 1
    return originalSnapshot()
  }

  const first = await executeSkillRead(registry, { skillKey: 'test-case-design' })
  const firstData = first.data as SkillReadData
  assert.equal(first.replayed, undefined)
  assert.equal(firstData.skillKey, 'test-case-design')
  assert.equal(firstData.version, '1.2.0')
  assert.match(firstData.content, /^<<<TRUSTED_SKILL key="test-case-design" version="1\.2\.0">>>/u)
  assert.match(firstData.content, /# Test case design/u)
  assert.match(firstData.content, /<<<END_TRUSTED_SKILL>>>$/u)

  const second = await executeSkillRead(registry, { skillKey: 'test-case-design' })
  assert.equal(second.replayed, true)
  assert.deepEqual(second.data, first.data)
  assert.equal(snapshotCalls, 1, '同一执行轮重复读取不能再次访问 Skill 存储')
})

test('Requirement Analysis Skill 将扩展测试风险留在 Test Focus，不把 Knowledge 升级为 Blocking', async () => {
  const { session } = await prepareSkills(['requirement.analysis'])
  const registry = new ToolRegistry()
  session.register(registry)
  const result = await executeSkillRead(registry, { skillKey: 'requirement.analysis' })
  const content = (result.data as SkillReadData).content

  assert.match(content, /一个 Clarification 只有\*\*同时\*\*满足以下全部条件/u)
  assert.match(content, /无法生成至少一个语义正确的核心 TestCase/u)
  assert.match(content, /不能通过“只测试当前 Requirement 已明确的部分”继续完成测试设计/u)
  assert.match(content, /纯空白、trim、Tab\/换行、最大长度、字符集和唯一性应作为输入规范化风险/u)
  assert.match(content, /Knowledge Reference 只能提醒风险/u)
  assert.match(content, /普通测试风险不要为了记录而创建 `blocking=false` Clarification/u)
})

test('skill.read 拒绝未绑定 Skill、路径式输入和额外参数', async () => {
  const { session } = await prepareSkills(['test-case-design'])
  const registry = new ToolRegistry()
  session.register(registry)

  await assert.rejects(() => executeSkillRead(registry, { skillKey: 'unknown-skill' }), /SKILL_READ_NOT_BOUND/u)
  await assert.rejects(() => executeSkillRead(registry, { skillKey: '..\/..\/server\/skills\/test-case-design\/SKILL\.md' }), /SKILL_READ_KEY_INVALID/u)
  await assert.rejects(() => executeSkillRead(registry, { skillKey: 'test-case-design', path: 'server/skills/test-case-design/SKILL.md' }), /SKILL_READ_ARGUMENTS_INVALID/u)
})

test('skill.read 在 prepare 后仍重新校验绑定版本与 configurationHash/content hash', async t => {
  await t.test('版本漂移拒绝', async () => {
    const { store, session } = await prepareSkills(['test-case-design'])
    const registry = new ToolRegistry()
    session.register(registry)
    await store.transaction(state => {
      const skill = state.aiResources.find((item): item is SkillResource => item.kind === 'skill' && item.key === 'test-case-design')!
      skill.version = '9.9.9'
    })
    await assert.rejects(() => executeSkillRead(registry, { skillKey: 'test-case-design' }), /SKILL_BINDING_UNAVAILABLE/u)
  })

  await t.test('内容 Hash 导致 configurationHash 漂移时拒绝', async () => {
    const { store, session } = await prepareSkills(['test-case-design'])
    const registry = new ToolRegistry()
    session.register(registry)
    await store.transaction(state => {
      const skill = state.aiResources.find((item): item is SkillResource => item.kind === 'skill' && item.key === 'test-case-design')!
      skill.contentSha256 = 'a'.repeat(64)
    })
    await assert.rejects(() => executeSkillRead(registry, { skillKey: 'test-case-design' }), /SKILL_BINDING_CHANGED/u)
  })
})

async function prepareSkills(skillKeys: string[]) {
  const store = new JsonStore(null)
  await store.load()
  await new AiResourceService(store, undefined, { reloadIntervalMs: 0 }).initialize()
  const definition = structuredClone(defaultAgentDefinitionResolver.resolve('planning'))
  definition.skillBindings = definition.skillBindings.filter(binding => skillKeys.includes(binding.skillKey))
  definition.enabledSkills = [...skillKeys]
  const session = await new AgentSkillRuntime(store).prepare(definition, 'test_case_design')
  return { store, definition, session }
}

async function executeSkillRead(registry: ToolRegistry, argumentsValue: Record<string, unknown>) {
  const registered = registry.get('skill.read')
  assert.ok(registered)
  return registered.handler({
    toolId: 'skill.read',
    toolCallId: 'skill-read-call',
    arguments: argumentsValue,
    context: {
      snapshot: { runId: 'skill-runtime-test' } as ReviewRunSnapshot,
      allowedToolIds: new Set(['skill.read']),
    },
  }, new AbortController().signal)
}
