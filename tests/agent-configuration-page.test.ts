import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('Agent 最大输出 Token 在页面中作为独立配置且不受模型目录值限制', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

  assert.match(source, /最大输出 Token" help="由当前 Agent 独立设置，发布后直接用于模型调用"/u)
  assert.doesNotMatch(source, /最大输出 Token" help=\{`不得超过/u)
  assert.doesNotMatch(source, /clampOutputTokens|limitingOutputTokenModel/u)
})

test('Agent 配置页面不提供模型温度', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /模型温度|routing\.temperature|updateRouting\('temperature'/u)
})

test('Agent 配置页面展示五个独立 Agent 并按测试执行分组', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

  for (const identifier of [
    'RequirementAnalysisAgent',
    'TestDesignAgent',
    'TestScriptAgent',
    'FailureAnalysisAgent',
    'ScriptRepairAgent',
  ]) assert.match(source, new RegExp(`identifier: '${identifier}'`, 'u'))
  assert.match(source, /\{ label: '测试执行', agentKeys: \['testScript', 'failureAnalysis', 'scriptRepair'\] \}/u)
  assert.match(source, /exactCapabilities: true/u)
})

test('Agent 配置 API 从三个 scene 聚合并按 Agent 选择保存发布 URL', () => {
  const source = readFileSync(new URL('../src/agent-configuration-api.ts', import.meta.url), 'utf8')

  assert.match(source, /requirement_analysis: 'requirement-analysis'/u)
  assert.match(source, /test_design: 'test-design'/u)
  assert.match(source, /test_execution: 'test-execution'/u)
  assert.match(source, /Object\.values\(scenePaths\).*\/agent-configurations\/\$\{path\}/su)
  assert.match(source, /const path = scenePaths\[agentScenes\[agentKey\]\]/u)
  assert.doesNotMatch(source, /request<AgentConfigurationState>\('\/agent-configurations\/requirement-analysis'\)/u)
})
