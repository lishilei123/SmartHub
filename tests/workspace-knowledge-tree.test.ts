import assert from 'node:assert/strict'
import test from 'node:test'
import type { KnowledgeDirectory, KnowledgeDocument } from '../src/prototype-data.js'
import { buildWorkspaceKnowledgeTree } from '../src/workspace-knowledge-tree.js'

const directories: KnowledgeDirectory[] = [
  { id: 'dir-workspace', name: 'workspace', parentId: null },
  { id: 'dir-branches', name: 'branches', parentId: 'dir-workspace' },
  { id: 'dir-release', name: 'release-3.1', parentId: 'dir-branches' },
  { id: 'dir-input', name: 'input', parentId: 'dir-release' },
  { id: 'dir-requirements', name: 'requirements', parentId: 'dir-input' },
  { id: 'dir-legacy', name: '旧知识库', parentId: null },
]

const documents: KnowledgeDocument[] = [
  {
    id: 'asset-requirement',
    name: '支付需求.md',
    parentId: 'dir-requirements',
    version: 'V1',
    updated: '刚刚',
    title: '支付需求',
    intro: '需求正文',
    sections: [],
    logicalPath: 'workspace/branches/release-3.1/input/requirements/支付需求.md',
  },
  {
    id: 'asset-legacy',
    name: '旧文档.md',
    parentId: 'dir-legacy',
    version: 'V1',
    updated: '刚刚',
    title: '旧文档',
    intro: '旧正文',
    sections: [],
    logicalPath: '旧知识库/旧文档.md',
  },
]

test('知识库目录以 /workspace 为根并补齐完整工作区骨架', () => {
  const tree = buildWorkspaceKnowledgeTree({ directories, documents, versionNames: ['release-3.1', 'release-3.2'] })
  assert.equal(tree.rootDirectoryId, 'dir-workspace')
  assert.deepEqual(tree.directories.filter(directory => directory.parentId === null).map(directory => directory.name), ['branches', 'shared', 'agent_workspace'])
  assert.ok(tree.directories.some(directory => directory.logicalPath === 'workspace/branches/release-3.2/input/api' && directory.structural && !directory.persisted))
  assert.ok(tree.directories.some(directory => directory.logicalPath === 'workspace/shared/knowledge'))
  assert.ok(tree.directories.some(directory => directory.logicalPath === 'workspace/agent_workspace/requirement_agent'))
  assert.ok(!tree.directories.some(directory => directory.name === 'workspace'))
})

test('工作区文件挂载到投影目录且不兼容旧根目录资产', () => {
  const tree = buildWorkspaceKnowledgeTree({ directories, documents, versionNames: ['release-3.1'] })
  assert.deepEqual(tree.documents.map(document => document.id), ['asset-requirement'])
  const requirementDirectory = tree.directories.find(directory => directory.logicalPath === 'workspace/branches/release-3.1/input/requirements')
  assert.equal(requirementDirectory?.id, 'dir-requirements')
  assert.equal(requirementDirectory?.persisted, true)
  assert.equal(tree.documents[0]?.parentId, requirementDirectory?.id)
})
