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
