import { WorkerStoppedError } from '../server/domain/worker-stop.js'
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
  const content: RequirementReleaseContent = {
    ...releaseContent('RP-MACHINE', '来自 Requirement Release content'),
    testFocus: [{ id: 'TF-FROZEN', title: '已退休测试重点', description: '仅验证旧 Release 仍可按原 Hash 冻结', requirementPointRefs: ['RP-MACHINE'] }],
  }
  const contentSha256 = canonicalSha256(content)
  await store.transaction(state => {
    state.projects.push({ id: 'project-1', name: '订单项目', createdAt: '2026-08-12T00:00:00.000Z' })
    const activeBinding = { releaseId: 'release-1', verificationRunId: 'review-run-1', releaseContentSha256: contentSha256, boundAt: '2026-08-12T00:03:00.000Z' }
    state.projectVersions.push({ id: 'project-version-1', projectId: 'project-1', name: 'V1', status: 'open', inheritRequirementBindings: false, requirementReleaseBinding: activeBinding, requirementReleaseBindings: [activeBinding], activeRequirementReleaseId: 'release-1', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:03:00.000Z' })
    state.knowledgeBases.push({ id: 'kb-1', projectId: 'project-1', name: '项目知识库', createdAt: '2026-08-12T00:00:00.000Z', activeIndexVersionId: 'index-1', activeConfigVersionId: 'config-1' })
    state.indexes.push({ id: 'index-1', knowledgeBaseId: 'kb-1', number: 1, status: 'active', configVersionId: 'config-1', assetVersionIds: ['version-user', 'version-shared'], indexedChunks: [], createdAt: '2026-08-12T00:00:00.000Z' } as never)
    const legacyRequirementArtifact = ['requirements', 'json'].join('.')
    const legacyManifestArtifact = ['manifest', 'json'].join('.')
    state.assets.push(
      { id: 'asset-user', knowledgeBaseId: 'kb-1', displayName: '用户需求.md', logicalPath: 'workspace/branches/V1/input/requirements/用户需求.md', assetType: 'requirement', sourceType: 'upload', sourceKey: 'user', activeVersionId: 'version-user', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' },
      { id: 'asset-prototype', knowledgeBaseId: 'kb-1', displayName: '产品原型.md', logicalPath: 'workspace/branches/V1/input/ui/产品原型.md', assetType: 'product_prototype', sourceType: 'upload', sourceKey: 'prototype', activeVersionId: 'version-prototype', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' },
      { id: 'asset-shared', knowledgeBaseId: 'kb-1', displayName: '产品原型.md', logicalPath: 'workspace/shared/产品原型.md', assetType: 'other', sourceType: 'upload', sourceKey: 'shared', activeVersionId: 'version-shared', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' },
      { id: 'asset-historical-user', knowledgeBaseId: 'kb-1', displayName: '历史用户需求.md', logicalPath: 'workspace/branches/V0/input/requirements/历史用户需求.md', assetType: 'requirement', sourceType: 'upload', sourceKey: 'historical-user', activeVersionId: 'version-historical-user', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' },
      { id: 'asset-formal', knowledgeBaseId: 'kb-1', displayName: 'requirement-analysis.md', logicalPath: 'workspace/branches/V1/requirements/requirement-analysis.md', assetType: 'other', sourceType: 'upload', sourceKey: 'formal', activeVersionId: 'version-formal', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' },
      { id: 'asset-formal-json', knowledgeBaseId: 'kb-1', displayName: legacyRequirementArtifact, logicalPath: `workspace/branches/V1/requirements/${legacyRequirementArtifact}`, assetType: 'other', sourceType: 'upload', sourceKey: 'formal-json', activeVersionId: 'version-formal-json', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' },
      { id: 'asset-formal-manifest', knowledgeBaseId: 'kb-1', displayName: legacyManifestArtifact, logicalPath: `workspace/branches/V1/requirements/${legacyManifestArtifact}`, assetType: 'other', sourceType: 'upload', sourceKey: 'formal-manifest', activeVersionId: 'version-formal-manifest', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' },
      { id: 'asset-library-formal', knowledgeBaseId: 'kb-1', displayName: '正式用例投影.json', logicalPath: 'workspace/branches/V1/test_case_library/v1/test-cases.json', assetType: 'test_case_library', sourceType: 'upload', sourceKey: 'library-formal', activeVersionId: 'version-library-formal', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' },
      { id: 'asset-historical-library-formal', knowledgeBaseId: 'kb-1', displayName: '历史正式用例投影.json', logicalPath: 'workspace/branches/V0/test-case-library/v1/test-cases.json', assetType: 'test_case_library', sourceType: 'upload', sourceKey: 'historical-library-formal', activeVersionId: 'version-historical-library-formal', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' },
    )
    state.versions.push(
      { id: 'version-user', assetId: 'asset-user', number: 1, content: '用户原始需求', contentHash: '1'.repeat(64), status: 'ready', configVersionId: 'config-1', createdAt: '2026-08-12T00:00:00.000Z', chunks: [] },
      { id: 'version-prototype', assetId: 'asset-prototype', number: 1, content: '当前版本产品原型', contentHash: '5'.repeat(64), status: 'ready', configVersionId: 'config-1', createdAt: '2026-08-12T00:00:00.000Z', chunks: [] },
      { id: 'version-shared', assetId: 'asset-shared', number: 1, content: '用户产品原型', contentHash: '2'.repeat(64), status: 'ready', configVersionId: 'config-1', createdAt: '2026-08-12T00:00:00.000Z', chunks: [] },
      { id: 'version-historical-user', assetId: 'asset-historical-user', number: 1, content: '历史用户资料', contentHash: '6'.repeat(64), status: 'ready', configVersionId: 'config-1', createdAt: '2026-08-12T00:00:00.000Z', chunks: [] },
      { id: 'version-formal', assetId: 'asset-formal', number: 1, content: '服务端旧投影', contentHash: '3'.repeat(64), status: 'ready', configVersionId: 'config-1', createdAt: '2026-08-12T00:00:00.000Z', chunks: [] },
      { id: 'version-formal-json', assetId: 'asset-formal-json', number: 1, content: '服务端旧 JSON 投影', contentHash: '7'.repeat(64), status: 'ready', configVersionId: 'config-1', createdAt: '2026-08-12T00:00:00.000Z', chunks: [] },
      { id: 'version-formal-manifest', assetId: 'asset-formal-manifest', number: 1, content: '服务端旧 Manifest 投影', contentHash: 'a'.repeat(64), status: 'ready', configVersionId: 'config-1', createdAt: '2026-08-12T00:00:00.000Z', chunks: [] },
      { id: 'version-library-formal', assetId: 'asset-library-formal', number: 1, content: '正式用例库输出镜像', contentHash: '8'.repeat(64), status: 'ready', configVersionId: 'config-1', createdAt: '2026-08-12T00:00:00.000Z', chunks: [] },
      { id: 'version-historical-library-formal', assetId: 'asset-historical-library-formal', number: 1, content: '历史正式用例库输出镜像', contentHash: '9'.repeat(64), status: 'ready', configVersionId: 'config-1', createdAt: '2026-08-12T00:00:00.000Z', chunks: [] },
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
  assert.equal(run.basisSnapshot.content.testFocus?.[0].id, 'TF-FROZEN')
  assert.equal(run.workspaceSnapshot.requirementReleaseContentSha256, contentSha256)
  assert.ok(run.workspaceSnapshot.files.some(item => item.assetVersionId === 'version-user'))
  assert.ok(run.workspaceSnapshot.files.some(item => item.assetVersionId === 'version-prototype'))
  assert.ok(run.workspaceSnapshot.files.some(item => item.assetVersionId === 'version-shared'))
  assert.ok(run.workspaceSnapshot.files.some(item => item.assetVersionId === 'version-historical-user'))
  assert.ok(run.workspaceSnapshot.files.every(item => item.assetVersionId !== 'version-formal'))
  assert.ok(run.workspaceSnapshot.files.every(item => item.assetVersionId !== 'version-formal-json'))
  assert.ok(run.workspaceSnapshot.files.every(item => item.assetVersionId !== 'version-formal-manifest'))
  assert.ok(run.workspaceSnapshot.files.every(item => item.assetVersionId !== 'version-library-formal'))
  assert.ok(run.workspaceSnapshot.files.every(item => item.assetVersionId !== 'version-historical-library-formal'))
  assert.ok(run.workspaceSnapshot.files.every(item => !item.logicalPath.startsWith('workspace/branches/V1/requirements/')))
  assert.ok(run.workspaceSnapshot.files.every(item => !item.logicalPath.endsWith('/historical-test-cases.json')))
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

test('TestDesign 拒绝缺少必填 content 的 Requirement Release', async () => {
  const store = new JsonStore(null)
  await store.load()
  const contentSha256 = 'a'.repeat(64)
  await store.transaction(state => {
    state.projects.push({ id: 'project-1', name: '订单项目', createdAt: '2026-08-12T00:00:00.000Z' })
    state.projectVersions.push({ id: 'project-version-1', projectId: 'project-1', name: 'V1', status: 'open', inheritRequirementBindings: false, requirementReleaseBinding: { releaseId: 'release-1', verificationRunId: 'review-run-1', releaseContentSha256: contentSha256, boundAt: '2026-08-12T00:03:00.000Z' }, activeRequirementReleaseId: 'release-1', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:03:00.000Z' })
    state.reviewRuns.push({ id: 'review-run-1', projectVersionId: 'project-version-1', status: 'succeeded', workflow: { release: { id: 'release-1', schemaVersion: 'requirement-release/v1', status: 'published', projectVersionId: 'project-version-1', verificationRunId: 'review-run-1', contentSha256, sourceAssetVersionIds: [], generationExecution: {}, artifacts: [{ fileName: 'requirement-analysis.md', mediaType: 'text/markdown', content: '# 报告', contentSha256: 'b'.repeat(64) }], createdAt: '2026-08-12T00:02:00.000Z', createdBy: 'owner' } } } as never)
  })
  const service = new TestDesignService(store, runtime())
  await assert.rejects(
    () => service.createDesign('project-version-1', { name: '非法正式输入', objective: '验证 content 必填', knowledgeAugmentation: { mode: 'disabled' } }, principal),
    (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_DESIGN_REQUIREMENTS_PACKAGE_INVALID' && /content 结构无效/u.test(error.message),
  )
})

function releaseContent(id: string, description: string): RequirementReleaseContent {
  return {
    requirements: [{ clientRequirementPointId: id, title: '机器基线需求', description, actor: '用户', action: '提交', object: '订单', conditions: [], businessRules: [], exceptions: [], acceptanceCriteria: [], evidenceRefs: [], coverageTarget: true }],
    evidence: [], clarifications: [],
  }
}

function runtime(): PlanningAgentRuntime {
  return { readiness: async () => ({ ready: true, agents: [] }), freezeConfiguration: async () => frozenConfiguration(), execute: async () => { throw new Error('测试无需执行后续 Agent') } }
}

function frozenConfiguration() { return { configurationId: 'config-version-1', configurationVersion: 1, configurationSha256: 'c'.repeat(64), agentDefinition: {} as never, routing: {} as never, primaryModel: { sourceId: 'source-1', modelId: 'model-1', modelName: '模型' }, createdAt: '2026-08-12T00:00:00.000Z', snapshotSha256: 'd'.repeat(64) } }


test('测试设计 Worker 停止后不发布候选或把 Node/Run 写成业务失败', async () => {
  for (const reason of ['lease_lost', 'heartbeat_unavailable', 'worker_shutdown'] as const) {
    const store = new JsonStore(null)
    await store.load()
    await store.transaction(state => {
      state.testDesignState = { runs: [{ id: 'stopped-run', status: 'running', nodeRuns: [{ id: 'node-1', nodeKey: 'test_case_design', status: 'queued', attempt: 0 }], workspaceSnapshot: { snapshotSha256: 'frozen', requirementReleaseId: 'release-1', requirementReleaseContentSha256: 'frozen' } }] } as never
    })
    let transactions = 0
    Object.assign(store, { transactionWithTestDesignLease: async (_id: string, _lease: unknown, operation: Parameters<JsonStore['transaction']>[0]) => {
      transactions++
      return store.transaction(operation)
    } })
    const controller = new AbortController()
    const service = new TestDesignService(store, { ...runtime(), async execute() {
      controller.abort(new WorkerStoppedError(reason))
      throw new Error('model transport interrupted')
    } })
    await assert.rejects(service.processPreparedNode('stopped-run', 'node-1', { workerId: 'worker-1', runToken: 'token-1' }, controller.signal), error => error instanceof WorkerStoppedError && error.reason === reason)
    const run = (await store.snapshot()).testDesignState!.runs[0]
    assert.equal(transactions, 1)
    assert.equal(run.status, 'running')
    assert.equal(run.nodeRuns[0].status, 'running')
    assert.equal(run.nodeRuns[0].finishedAt, undefined)
  }
})
