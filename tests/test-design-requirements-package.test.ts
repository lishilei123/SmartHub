import assert from 'node:assert/strict'
import test from 'node:test'
import { TestDesignService, type PlanningAgentRuntime } from '../server/application/test-design-service.js'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import { TestDesignError } from '../server/application/test-design-validation.js'
import type { RequirementReleaseContent } from '../server/domain/requirement-workflow-types.js'
import { JsonStore } from '../server/infrastructure/store.js'

const principal = { subjectId: 'test-owner', displayName: '测试负责人' }

test('TestDesign 直接冻结 Requirement Release content，且 Workspace 只保留用户资料', async () => {
  const store = new JsonStore(null)
  await store.load()
  const content = releaseContent('RP-MACHINE', '来自 Requirement Release content')
  const contentSha256 = canonicalSha256(content)
  await store.transaction(state => {
    state.projects.push({ id: 'project-1', name: '订单项目', createdAt: '2026-08-12T00:00:00.000Z' })
    const activeBinding = { releaseId: 'release-1', verificationRunId: 'review-run-1', releaseContentSha256: contentSha256, boundAt: '2026-08-12T00:03:00.000Z' }
    state.projectVersions.push({ id: 'project-version-1', projectId: 'project-1', name: 'V1', status: 'open', inheritRequirementBindings: false, requirementReleaseBinding: activeBinding, requirementReleaseBindings: [activeBinding], activeRequirementReleaseId: 'release-1', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:03:00.000Z' })
    state.knowledgeBases.push({ id: 'kb-1', projectId: 'project-1', name: '项目知识库', createdAt: '2026-08-12T00:00:00.000Z', activeIndexVersionId: 'index-1', activeConfigVersionId: 'config-1' })
    state.indexes.push({ id: 'index-1', knowledgeBaseId: 'kb-1', number: 1, status: 'active', configVersionId: 'config-1', assetVersionIds: ['version-user', 'version-shared'], indexedChunks: [], createdAt: '2026-08-12T00:00:00.000Z' } as never)
    state.assets.push(
      { id: 'asset-user', knowledgeBaseId: 'kb-1', displayName: '用户需求.md', logicalPath: 'workspace/branches/V1/input/requirements/用户需求.md', assetType: 'requirement', sourceType: 'upload', sourceKey: 'user', activeVersionId: 'version-user', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' },
      { id: 'asset-shared', knowledgeBaseId: 'kb-1', displayName: '产品原型.md', logicalPath: 'workspace/shared/产品原型.md', assetType: 'other', sourceType: 'upload', sourceKey: 'shared', activeVersionId: 'version-shared', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' },
      { id: 'asset-formal', knowledgeBaseId: 'kb-1', displayName: '服务端投影.md', logicalPath: 'workspace/branches/V1/requirements/服务端投影.md', assetType: 'other', sourceType: 'upload', sourceKey: 'formal', activeVersionId: 'version-formal', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' },
    )
    state.versions.push(
      { id: 'version-user', assetId: 'asset-user', number: 1, content: '用户原始需求', contentHash: '1'.repeat(64), status: 'ready', configVersionId: 'config-1', createdAt: '2026-08-12T00:00:00.000Z', chunks: [] },
      { id: 'version-shared', assetId: 'asset-shared', number: 1, content: '用户产品原型', contentHash: '2'.repeat(64), status: 'ready', configVersionId: 'config-1', createdAt: '2026-08-12T00:00:00.000Z', chunks: [] },
      { id: 'version-formal', assetId: 'asset-formal', number: 1, content: '服务端旧投影', contentHash: '3'.repeat(64), status: 'ready', configVersionId: 'config-1', createdAt: '2026-08-12T00:00:00.000Z', chunks: [] },
    )
    state.reviewRuns.push({
      id: 'review-run-1', projectVersionId: 'project-version-1', assetId: 'asset-user', assetVersionId: 'version-user', documentTitle: '已发布需求', documentVersion: 1,
      logicalPath: 'workspace/branches/V1/input/requirements', sourceId: 'source-1', modelId: 'model-1', modelLabel: 'model', status: 'succeeded', step: 'completed', progress: 100,
      createdAt: '2026-08-12T00:00:00.000Z', finishedAt: '2026-08-12T00:01:00.000Z', snapshot: { currentInputRefs: [{ assetId: 'asset-user', assetVersionId: 'version-user', logicalPath: 'workspace/branches/V1/input/requirements/用户需求.md', contentSha256: '1'.repeat(64) }] } as never,
      result: { requirementPoints: [{ clientRequirementPointId: 'RP-STALE', title: '旧运行结果', description: '不能作为 TestDesign 输入', evidenceRefs: [] }] } as never,
      workflow: { currentStage: 'release', release: {
        id: 'release-1', schemaVersion: 'requirement-release/v1', status: 'published', projectVersionId: 'project-version-1', verificationRunId: 'review-run-1', content, contentSha256,
        sourceAssetVersionIds: ['version-user'], generationExecution: {} as never,
        artifacts: [{ fileName: 'requirement-analysis.md', mediaType: 'text/markdown', content: '# 展示格式 A', contentSha256: '4'.repeat(64) }],
        createdAt: '2026-08-12T00:02:00.000Z', createdBy: 'owner', publishedAt: '2026-08-12T00:03:00.000Z', publishedBy: 'owner',
      } },
    } as never)
  })
  const service = new TestDesignService(store, runtime())
  const candidates = await service.inputCandidates('project-version-1')
  assert.equal(candidates.requirementRelease?.id, 'release-1')
  const design = await service.createDesign('project-version-1', { name: '订单测试设计', objective: '验证发布需求', knowledgeAugmentation: { mode: 'disabled' } }, principal)
  const run = await service.createRun('project-version-1', design.id, 'release-content-only', principal)

  assert.equal(run.basisSnapshot.schemaVersion, 'test-design-basis-snapshot/v3')
  assert.equal(run.basisSnapshot.requirementReleaseContentSha256, contentSha256)
  assert.deepEqual(run.basisSnapshot.content, content)
  assert.equal(run.basisSnapshot.content.requirements[0].clientRequirementPointId, 'RP-MACHINE')
  assert.equal(run.workspaceSnapshot.requirementReleaseContentSha256, contentSha256)
  assert.ok(run.workspaceSnapshot.files.some(item => item.assetVersionId === 'version-user'))
  assert.ok(run.workspaceSnapshot.files.some(item => item.assetVersionId === 'version-shared'))
  assert.ok(run.workspaceSnapshot.files.every(item => item.assetVersionId !== 'version-formal'))
  assert.ok(run.workspaceSnapshot.files.every(item => !item.logicalPath.startsWith('workspace/branches/V1/requirements/')))
})

test('TestDesign 拒绝 Binding 与 Requirement Release content Hash 漂移', async () => {
  const store = new JsonStore(null)
  await store.load()
  const content = releaseContent('RP-001', '固定需求')
  const contentSha256 = canonicalSha256(content)
  await store.transaction(state => {
    state.projects.push({ id: 'project-1', name: '订单项目', createdAt: '2026-08-12T00:00:00.000Z' })
    state.projectVersions.push({ id: 'project-version-1', projectId: 'project-1', name: 'V1', status: 'open', inheritRequirementBindings: false, requirementReleaseBinding: { releaseId: 'release-1', verificationRunId: 'review-run-1', releaseContentSha256: '0'.repeat(64), boundAt: '2026-08-12T00:03:00.000Z' }, activeRequirementReleaseId: 'release-1', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:03:00.000Z' })
    state.reviewRuns.push({ id: 'review-run-1', projectVersionId: 'project-version-1', status: 'succeeded', workflow: { release: { id: 'release-1', schemaVersion: 'requirement-release/v1', status: 'published', projectVersionId: 'project-version-1', verificationRunId: 'review-run-1', content, contentSha256, sourceAssetVersionIds: ['version-fixed'], generationExecution: {}, artifacts: [], createdAt: '2026-08-12T00:02:00.000Z', createdBy: 'owner' } } } as never)
  })
  const service = new TestDesignService(store, runtime())
  await assert.rejects(
    () => service.createDesign('project-version-1', { name: '订单测试设计', objective: '验证发布需求', knowledgeAugmentation: { mode: 'disabled' } }, principal),
    (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_DESIGN_REQUIREMENT_RELEASE_BINDING_INVALID',
  )
})

function releaseContent(id: string, description: string): RequirementReleaseContent {
  return {
    requirements: [{ clientRequirementPointId: id, title: '机器基线需求', description, actor: '用户', action: '提交', object: '订单', conditions: [], businessRules: [], exceptions: [], acceptanceCriteria: [], evidenceRefs: [], coverageTarget: true }],
    evidence: [], clarifications: [], testFocus: [],
  }
}

function runtime(): PlanningAgentRuntime {
  return { readiness: async () => ({ ready: true, agents: [] }), freezeConfiguration: async () => frozenConfiguration(), execute: async () => { throw new Error('测试无需执行后续 Agent') } }
}

function frozenConfiguration() { return { configurationId: 'config-version-1', configurationVersion: 1, configurationSha256: 'c'.repeat(64), agentDefinition: {} as never, routing: {} as never, primaryModel: { sourceId: 'source-1', modelId: 'model-1', modelName: '模型' }, createdAt: '2026-08-12T00:00:00.000Z', snapshotSha256: 'd'.repeat(64) } }
