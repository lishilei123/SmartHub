import assert from 'node:assert/strict'
import test from 'node:test'
import { documentPathInDirectory, requirementWorkspaceDirectory, versionDocumentDirectory, versionDocumentPath } from '../src/version-document-path.js'

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

test('需求上传与 Pi Agent 共用知识库目录并拒绝目录穿越', () => {
  assert.equal(requirementWorkspaceDirectory('release-3.1'), 'workspace/branches/release-3.1/input/requirements')
  assert.equal(requirementWorkspaceDirectory('2026/Q3'), 'workspace/branches/2026%2FQ3/input/requirements')
  assert.equal(documentPathInDirectory('/产品资料/订单/', '支付需求.md'), '产品资料/订单/支付需求.md')
  assert.equal(documentPathInDirectory('产品资料\\订单', 'a?b.md'), '产品资料/订单/a%3Fb.md')
  assert.throws(() => documentPathInDirectory('../产品资料', '支付需求.md'), /知识库目录路径不合法/u)
})
