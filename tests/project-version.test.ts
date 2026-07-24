import assert from 'node:assert/strict'
import test from 'node:test'
import { ProjectVersionService } from '../server/application/project-version-service.js'
import { defaultConfig } from '../server/domain/types.js'
import { JsonStore } from '../server/infrastructure/store.js'

async function fixture() {
  const store = new JsonStore(null)
  await store.load()
  await store.transaction(state => {
    state.projects.push({ id: 'project-1', name: 'SmartHub', createdAt: '2026-07-23T00:00:00.000Z' })
    state.configs.push({ id: 'config-1', knowledgeBaseId: 'kb-1', version: 1, config: structuredClone(defaultConfig), createdAt: '2026-07-23T00:00:00.000Z', compatibilityFingerprint: 'hash', requiresRebuild: false })
    state.knowledgeBases.push({ id: 'kb-1', projectId: 'project-1', name: 'SmartHub 项目知识库', createdAt: '2026-07-23T00:00:00.000Z', activeIndexVersionId: null, activeConfigVersionId: 'config-1' })
    state.assets.push({ id: 'asset-1', knowledgeBaseId: 'kb-1', displayName: '需求.md', logicalPath: '需求文档/需求.md', assetType: 'requirement', sourceType: 'upload', sourceKey: 'fixture', activeVersionId: 'asset-version-1', createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z' })
    state.versions.push({ id: 'asset-version-1', assetId: 'asset-1', number: 1, content: '# 需求', contentHash: 'hash', status: 'ready', configVersionId: 'config-1', createdAt: '2026-07-23T00:00:00.000Z', readyAt: '2026-07-23T00:00:01.000Z', chunks: [] })
  })
  return { store, service: new ProjectVersionService(store) }
}

test('项目版本隔离需求绑定且新版本只按显式选择继承绑定', async () => {
  const { service } = await fixture()
  const first = await service.create({ name: 'V1.0' })
  await service.bindRequirement(first.id, 'asset-version-1')
  const blank = await service.create({ name: 'V2.0', sourceProjectVersionId: first.id, inheritRequirementBindings: false })
  const inherited = await service.create({ name: 'V2.1', sourceProjectVersionId: first.id, inheritRequirementBindings: true })
  assert.equal((await service.bindings(first.id)).length, 1)
  assert.equal((await service.bindings(blank.id)).length, 0)
  assert.deepEqual((await service.bindings(inherited.id)).map(item => item.assetVersionId), ['asset-version-1'])
})

test('锁定和归档版本拒绝新增或替换需求绑定', async () => {
  const { service } = await fixture()
  const version = await service.create({ name: 'V1.0' })
  const binding = await service.bindRequirement(version.id, 'asset-version-1')
  await service.updateStatus(version.id, 'locked')
  await assert.rejects(() => service.bindRequirement(version.id, 'asset-version-1'), /只读状态/u)
  await assert.rejects(() => service.unbindRequirement(version.id, binding.id), /只读状态/u)
  await service.updateStatus(version.id, 'archived')
  await assert.rejects(() => service.bindRequirement(version.id, 'asset-version-1'), /只读状态/u)
})

test('open 版本可独立移除继承得到的需求绑定', async () => {
  const { service } = await fixture()
  const source = await service.create({ name: 'V1.0' })
  await service.bindRequirement(source.id, 'asset-version-1')
  const child = await service.create({ name: 'V2.0', sourceProjectVersionId: source.id, inheritRequirementBindings: true })
  const [childBinding] = await service.bindings(child.id)
  await service.unbindRequirement(child.id, childBinding.id)
  assert.equal((await service.bindings(child.id)).length, 0)
  assert.equal((await service.bindings(source.id)).length, 1)
})

test('删除版本同时删除需求绑定并保护仍被继承的来源版本', async () => {
  const { service } = await fixture()
  const source = await service.create({ name: 'V1.0' })
  await service.bindRequirement(source.id, 'asset-version-1')
  const child = await service.create({ name: 'V2.0', sourceProjectVersionId: source.id, inheritRequirementBindings: true })
  await assert.rejects(() => service.delete(source.id), /作为继承来源/u)
  const deletedChild = await service.delete(child.id)
  assert.equal(deletedChild.deletedBindings, 1)
  const deletedSource = await service.delete(source.id)
  assert.equal(deletedSource.deletedBindings, 1)
  assert.deepEqual(await service.list(), [])
})
