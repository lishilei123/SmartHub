import assert from 'node:assert/strict'
import test from 'node:test'
import { versionDocumentDirectory, versionDocumentPath } from '../src/version-document-path.js'

test('版本文档路径按项目版本和文档类型分目录', () => {
  assert.equal(versionDocumentDirectory('V1.6', '需求文档'), '版本文档/V1.6/需求文档')
  assert.equal(versionDocumentPath('V1.6', '需求文档', '支付需求.md'), '版本文档/V1.6/需求文档/支付需求.md')
  assert.equal(versionDocumentDirectory('SmartHub · V2', '技术方案'), '版本文档/SmartHub · V2/技术方案')
  assert.equal(versionDocumentPath('SmartHub · V2', '技术方案', '总体架构.md'), '版本文档/SmartHub · V2/技术方案/总体架构.md')
})

test('版本文档路径清理不安全的目录和文件名字符', () => {
  assert.equal(versionDocumentPath(' 2026/Q3 ', '需求:文档', 'a?b.md'), '版本文档/2026%2FQ3/需求%3A文档/a%3Fb.md')
  assert.equal(versionDocumentDirectory('...', '需求文档'), '版本文档/%2E%2E%2E/需求文档')
  assert.equal(versionDocumentPath('CON', '需求文档', 'NUL.md'), '版本文档/%43ON/需求文档/%4EUL.md')
})
