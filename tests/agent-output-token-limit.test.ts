import assert from 'node:assert/strict'
import test from 'node:test'
import { clampOutputTokens, limitingOutputTokenModel } from '../src/agent-output-token-limit.js'

const primary = { displayName: 'gpt-5.6-terra', maxOutputTokens: 32_768 }
const fallback = { displayName: 'fallback-model', maxOutputTokens: 16_384 }

test('Agent 最大输出 Token 使用当前生效路由中最低的模型能力上限', () => {
  assert.equal(limitingOutputTokenModel(primary, [fallback], false), primary)
  assert.equal(limitingOutputTokenModel(primary, [fallback], true), fallback)
  assert.equal(limitingOutputTokenModel(undefined, [fallback], true), undefined)
})

test('Agent 最大输出 Token 被限制在输入范围内', () => {
  assert.equal(clampOutputTokens(65_536, primary.maxOutputTokens), 32_768)
  assert.equal(clampOutputTokens(8_192.8, primary.maxOutputTokens), 8_192)
  assert.equal(clampOutputTokens(0, primary.maxOutputTokens), 1_024)
})
