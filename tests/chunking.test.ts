import assert from 'node:assert/strict'
import test from 'node:test'
import { chunkDocument, defaultTokenCodec, type TokenCodec } from '../server/application/content.js'
import { defaultConfig } from '../server/domain/types.js'

const wordCodec: TokenCodec = {
  maxTokens: 100,
  count: text => text.trim() ? text.trim().split(/\s+/u).length : 0,
}

test('Chunk 使用 tokenizer 的真实 Token 数而不是 JavaScript 字符长度', () => {
  const content = '# 退款规则\n退款需要人工确认'
  const [chunk] = chunkDocument(content, defaultConfig)
  assert.equal(chunk.tokenCount, defaultTokenCodec.count(chunk.content))
  assert.notEqual(chunk.tokenCount, chunk.content.length)
})

test('目标、最大 Token 数和重叠共同控制普通 Markdown 分块', () => {
  const content = '# Rules\n\none two three four\n\nfive six seven eight\n\nnine ten eleven twelve'
  const chunks = chunkDocument(content, { ...defaultConfig, chunkTargetSize: 6, chunkMaxSize: 8, chunkOverlap: 2 }, [], wordCodec)
  assert.deepEqual(chunks.map(chunk => chunk.tokenCount), [6, 6, 6])
  assert.match(chunks[1].content, /^three four/u)
  assert.match(chunks[2].content, /^seven eight/u)
  assert.ok(chunks.every(chunk => chunk.tokenCount <= 8))
})

test('围栏代码块作为完整结构块，不在达到目标大小时从内部截断', () => {
  const fenced = `\`\`\`ts\n${Array.from({ length: 10 }, (_, index) => `const value${index} = ${index}`).join('\n')}\n\`\`\``
  const content = `# Code\n\n${fenced}\n\nafter text`
  const chunks = chunkDocument(content, { ...defaultConfig, chunkTargetSize: 3, chunkMaxSize: 5, chunkOverlap: 1 }, [], wordCodec)
  const codeChunks = chunks.filter(chunk => chunk.content.includes('```'))
  assert.equal(codeChunks.length, 1)
  assert.equal(codeChunks[0].content, fenced)
  assert.ok(codeChunks[0].tokenCount > 5, '结构完整性优先于代码块的最大 Token 限制')
})

test('重复标题和重复内容仍生成唯一且可稳定复用的 chunkKey', () => {
  const content = '# A\n相同内容\n\n# A\n相同内容'
  const first = chunkDocument(content, defaultConfig)
  const second = chunkDocument(content, defaultConfig, first)
  assert.equal(new Set(first.map(chunk => chunk.chunkKey)).size, first.length)
  assert.deepEqual(second.map(chunk => chunk.chunkKey), first.map(chunk => chunk.chunkKey))
  assert.ok(second.every(chunk => chunk.reused))
})
