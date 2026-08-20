import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { TestDesignService, type PlanningAgentRuntime } from '../server/application/test-design-service.js'
import { TestDesignError } from '../server/application/test-design-validation.js'
import { JsonStore } from '../server/infrastructure/store.js'

const principal = { subjectId: 'test-owner', displayName: '测试负责人' }

test('TestDesign 只消费已发布 requirements.json，不从 Review 结果或 Markdown 重新解析需求', async () => {
  const store = new JsonStore(null)
  await store.load()
  const requirementsContent = json({
    schemaVersion: 'requirements/v1',
    releaseId: 'release-1',
    projectVersionId: 'project-version-1',
    verificationRunId: 'review-run-1',
    sourceAssetVersions: [{ assetVersionId: 'version-fixed' }],
    requirements: [{ clientRequirementPointId: 'RP-MACHINE', title: '机器基线需求', description: '来自 requirements.json', evidenceRefs: [] }],
  })
  const requirementsHash = sha256(requirementsContent)
  const manifestContent = json({
    schemaVersion: 'requirement-release-manifest/v1',
    releaseId: 'release-1',
    projectVersionId: 'project-version-1',
    verificationRunId: 'review-run-1',
    sourceAssetVersions: [{ assetVersionId: 'version-fixed' }],
    artifacts: [{ fileName: 'requirements.json', mediaType: 'application/json', contentSha256: requirementsHash, bytes: Buffer.byteLength(requirementsContent, 'utf8') }],
    machineReadableEntryPoints: { requirements: 'requirements.json' },
  })
  await store.transaction(state => {
    state.projects.push({ id: 'project-1', name: '订单项目', createdAt: '2026-08-12T00:00:00.000Z' })
    const activeBinding = { releaseId: 'release-1', verificationRunId: 'review-run-1', requirementsJsonSha256: requirementsHash, boundAt: '2026-08-12T00:03:00.000Z' }
    state.projectVersions.push({
      id: 'project-version-1', projectId: 'project-1', name: 'V1', status: 'open',
      requirementReleaseBinding: activeBinding,
      requirementReleaseBindings: [
        { releaseId: 'released-run-removed', verificationRunId: 'removed-run', requirementsJsonSha256: '0'.repeat(64), boundAt: '2026-08-11T00:03:00.000Z' },
        activeBinding,
      ],
      activeRequirementReleaseId: 'release-1',
      createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:03:00.000Z',
    })
    state.knowledgeBases.push({ id: 'kb-1', projectId: 'project-1', name: '项目知识库', createdAt: '2026-08-12T00:00:00.000Z', activeIndexVersionId: 'index-1', activeConfigVersionId: 'config-1' })
    state.indexes.push({ id: 'index-1', knowledgeBaseId: 'kb-1', number: 1, status: 'active', configVersionId: 'config-1', assetVersionIds: [], indexedChunks: [], createdAt: '2026-08-12T00:00:00.000Z' } as never)
    state.reviewRuns.push({
      id: 'review-run-1', projectVersionId: 'project-version-1', assetId: 'asset-1', assetVersionId: 'version-fixed', documentTitle: '已发布需求', documentVersion: 1,
      logicalPath: 'workspace/branches/V1/input/requirements', sourceId: 'source-1', modelId: 'model-1', modelLabel: 'model', status: 'succeeded', step: 'completed', progress: 100,
      createdAt: '2026-08-12T00:00:00.000Z', finishedAt: '2026-08-12T00:01:00.000Z', snapshot: { currentInputRefs: [] } as never,
      result: { requirementPoints: [{ clientRequirementPointId: 'RP-STALE', title: '旧运行结果', description: '不能作为 TestDesign 输入', evidenceRefs: [] }] } as never,
      workflow: { currentStage: 'release', release: {
        id: 'release-1', schemaVersion: 'requirement-release-package/v1', status: 'published', projectVersionId: 'project-version-1', verificationRunId: 'review-run-1', sourceAssetVersionIds: ['version-fixed'],
        generationExecution: {} as never,
        artifacts: [
          { fileName: 'requirements.json', mediaType: 'application/json', content: requirementsContent, contentSha256: requirementsHash },
          { fileName: 'manifest.json', mediaType: 'application/json', content: manifestContent, contentSha256: sha256(manifestContent) },
        ],
        contentSha256: sha256(manifestContent), createdAt: '2026-08-12T00:02:00.000Z', createdBy: 'owner', publishedAt: '2026-08-12T00:03:00.000Z', publishedBy: 'owner',
      } },
    } as never)
  })
  const runtime: PlanningAgentRuntime = {
    readiness: async () => ({ ready: true, agents: [] }),
    freezeConfiguration: async () => frozenConfiguration(),
    execute: async () => { throw new Error('测试无需执行后续 Agent') },
  }
  const service = new TestDesignService(store, runtime)
  const candidates = await service.inputCandidates('project-version-1')
  assert.equal(candidates.requirementRelease?.id, 'release-1')
  assert.deepEqual(candidates.requirementReleases.map(item => item.id), ['release-1'])
  const design = await service.createDesign('project-version-1', {
    name: '订单测试设计', objective: '验证发布需求', knowledgeAugmentation: { mode: 'disabled' },
  }, principal)
  const run = await service.createRun('project-version-1', design.id, 'requirements-json-only', principal)

  assert.equal(run.basisSnapshot.items.length, 1)
  assert.equal(run.basisSnapshot.requirementReleaseId, 'release-1')
  assert.equal(run.basisSnapshot.verificationRunId, 'review-run-1')
  assert.equal(run.basisSnapshot.requirementsJsonSha256, requirementsHash)
  assert.equal(run.workspaceSnapshot.requirementsJsonSha256, requirementsHash)
  assert.equal((run.basisSnapshot.items[0].content as { clientRequirementPointId: string }).clientRequirementPointId, 'RP-MACHINE')
  assert.ok(run.basisSnapshot.items.every(item => item.sourceId !== 'review-run-1:RP-STALE'))
})

test('TestDesign 拒绝 manifest 未固定 requirements.json Hash 的发布包', async () => {
  const store = new JsonStore(null)
  await store.load()
  const requirementsContent = json({ schemaVersion: 'requirements/v1', releaseId: 'release-1', projectVersionId: 'project-version-1', verificationRunId: 'review-run-1', sourceAssetVersions: [{ assetVersionId: 'version-fixed' }], requirements: [{ clientRequirementPointId: 'RP-001', evidenceRefs: [] }] })
  const requirementsHash = sha256(requirementsContent)
  const manifestContent = json({ schemaVersion: 'requirement-release-manifest/v1', releaseId: 'release-1', projectVersionId: 'project-version-1', verificationRunId: 'review-run-1', artifacts: [{ fileName: 'requirements.json', mediaType: 'application/json', contentSha256: '0'.repeat(64) }], machineReadableEntryPoints: { requirements: 'requirements.json' } })
  await store.transaction(state => {
    state.projects.push({ id: 'project-1', name: '订单项目', createdAt: '2026-08-12T00:00:00.000Z' })
    state.projectVersions.push({ id: 'project-version-1', projectId: 'project-1', name: 'V1', status: 'open', requirementReleaseBinding: { releaseId: 'release-1', verificationRunId: 'review-run-1', requirementsJsonSha256: requirementsHash, boundAt: '2026-08-12T00:03:00.000Z' }, createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:03:00.000Z' })
    state.knowledgeBases.push({ id: 'kb-1', projectId: 'project-1', name: '项目知识库', createdAt: '2026-08-12T00:00:00.000Z', activeIndexVersionId: 'index-1', activeConfigVersionId: 'config-1' })
    state.indexes.push({ id: 'index-1', knowledgeBaseId: 'kb-1', number: 1, status: 'active', configVersionId: 'config-1', assetVersionIds: [], indexedChunks: [], createdAt: '2026-08-12T00:00:00.000Z' } as never)
    state.reviewRuns.push({ id: 'review-run-1', projectVersionId: 'project-version-1', status: 'succeeded', result: {}, workflow: { release: { id: 'release-1', status: 'published', projectVersionId: 'project-version-1', verificationRunId: 'review-run-1', sourceAssetVersionIds: ['version-fixed'], artifacts: [{ fileName: 'requirements.json', mediaType: 'application/json', content: requirementsContent, contentSha256: requirementsHash }, { fileName: 'manifest.json', mediaType: 'application/json', content: manifestContent, contentSha256: sha256(manifestContent) }], contentSha256: sha256(manifestContent) } } } as never)
  })
  const runtime: PlanningAgentRuntime = { readiness: async () => ({ ready: true, agents: [] }), freezeConfiguration: async () => frozenConfiguration(), execute: async () => { throw new Error('不应执行') } }
  const service = new TestDesignService(store, runtime)
  await assert.rejects(
    () => service.createDesign('project-version-1', { name: '订单测试设计', objective: '验证发布需求', knowledgeAugmentation: { mode: 'disabled' } }, principal),
    (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_DESIGN_REQUIREMENTS_PACKAGE_INVALID',
  )
})

function json(value: unknown) { return `${JSON.stringify(value, null, 2)}\n` }
function sha256(value: string) { return createHash('sha256').update(value).digest('hex') }
function frozenConfiguration() { return { configurationId: 'config-version-1', configurationVersion: 1, configurationSha256: 'c'.repeat(64), agentDefinition: {} as never, routing: {} as never, primaryModel: { sourceId: 'source-1', modelId: 'model-1', modelName: '模型' }, createdAt: '2026-08-12T00:00:00.000Z', snapshotSha256: 'd'.repeat(64) } }
