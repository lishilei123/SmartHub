import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { defaultAgentDefinitionConfigDictionary } from '../server/agent/agent-definition-config.js'
import { TEST_DESIGN_STAGE_BINDINGS } from '../server/agent/pi-test-design-runtime.js'

test('PlanningAgent 直接从 Requirement Release 进入 test_case_design', () => {
  assert.deepEqual(Object.keys(TEST_DESIGN_STAGE_BINDINGS), ['test_case_design', 'test_design_repair'])
  assert.equal(TEST_DESIGN_STAGE_BINDINGS.test_case_design.submitToolId, 'test_design_cases.submit_result')
  assert.equal(TEST_DESIGN_STAGE_BINDINGS.test_design_repair.submitToolId, 'test_design_repair.submit_result')
  assert.match(defaultAgentDefinitionConfigDictionary.planning.systemPrompt, /连续对话/u)
})

test('PlanningAgent 的测试设计 Skill 只声明 Requirement 直接追踪', () => {
  const skill = defaultAgentDefinitionConfigDictionary.planning.skills.find(item => item.skillKey === 'test-case-design')
  assert.ok(skill?.enabled)
  const runtime = readFileSync(new URL('../server/agent/pi-test-design-runtime.ts', import.meta.url), 'utf8')
  assert.match(runtime, /coverageClaims\[\]\.kind 是场景意图分类，不是 Case dimension 或 executionSpec\.kind/u)
  assert.match(runtime, /禁止把 functional、performance、stability、compatibility、security 复制到这里/u)
  assert.doesNotMatch(runtime, /coverageClaims\[\]\.kind 是场景意图分类[^。]*crud_lifecycle/u)
})
