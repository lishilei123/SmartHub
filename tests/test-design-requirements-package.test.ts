import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { TestDesignService, type TestDesignAgentRuntime } from '../server/application/test-design-service.js'
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
    state.projectVersions.push({ id: 'project-version-1', projectId: 'project-1', name: 'V1', status: 'open', createdAt: '2026-08-12T00:00:00.000Z' })
    state.reviewRuns.push({
      id: 'review-run-1', projectVersionId: 'project-version-1', assetId: 'asset-1', assetVersionId: 'version-fixed', documentTitle: '已发布需求', documentVersion: 1,
      logicalPath: 'workspace/branches/V1/input/requirements', sourceId: 'source-1', modelId: 'model-1', modelLabel: 'model', status: 'succeeded', step: 'completed', progress: 100,
      createdAt: '2026-08-12T00:00:00.000Z', finishedAt: '2026-08-12T00:01:00.000Z', snapshot: {} as never,
      result: { requirementPoints: [{ clientRequirementPointId: 'RP-STALE', title: '旧运行结果', description: '不能作为 TestDesign 输入', evidenceRefs: [] }] } as never,
      workflow: { currentStage: 'release', release: {
        id: 'release-1', schemaVersion: 'requirement-release-package/v1', status: 'published', projectVersionId: 'project-version-1', verificationRunId: 'review-run-1', sourceAssetVersionIds: ['version-fixed'],
        candidate: { schemaVersion: 'requirement-release-candidate/v1', sourceAssetVersionIds: ['version-fixed'], refinedRequirementsMarkdown: '# 不应被 TestDesign 解析' },
        generationExecution: {} as never,
        artifacts: [
          { fileName: 'requirements.json', mediaType: 'application/json', content: requirementsContent, contentSha256: requirementsHash },
          { fileName: 'manifest.json', mediaType: 'application/json', content: manifestContent, contentSha256: sha256(manifestContent) },
        ],
        contentSha256: sha256(manifestContent), createdAt: '2026-08-12T00:02:00.000Z', createdBy: 'owner', publishedAt: '2026-08-12T00:03:00.000Z', publishedBy: 'owner',
      } },
    } as never)
    state.technicalSolutionRuns.push({ id: 'technical-run-1', technicalReviewId: 'technical-review-1', sourceReviewRunId: 'review-run-1', projectVersionId: 'project-version-1', status: 'succeeded', result: {}, extractionResult: { solutionPoints: [] }, createdAt: '2026-08-12T00:00:00.000Z' } as never)
  })
  const runtime: TestDesignAgentRuntime = {
    readiness: async () => ({ ready: true, agents: [] }),
    execute: async () => { throw new Error('测试无需执行后续 Agent') },
  }
  const service = new TestDesignService(store, runtime)
  const design = await service.createDesign('project-version-1', {
    name: '订单测试设计', objective: '验证发布需求', basisMode: 'review_baseline', sourceReviewRunId: 'review-run-1', sourceTechnicalSolutionRunId: 'technical-run-1', knowledgeAugmentation: { mode: 'disabled' },
  }, principal)
  const run = await service.createRun('project-version-1', design.id, 'requirements-json-only', principal)

  assert.equal(run.basisSnapshot.items.length, 1)
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
    state.projectVersions.push({ id: 'project-version-1', projectId: 'project-1', name: 'V1', status: 'open', createdAt: '2026-08-12T00:00:00.000Z' })
    state.reviewRuns.push({ id: 'review-run-1', projectVersionId: 'project-version-1', status: 'succeeded', result: {}, workflow: { release: { id: 'release-1', status: 'published', projectVersionId: 'project-version-1', verificationRunId: 'review-run-1', sourceAssetVersionIds: ['version-fixed'], artifacts: [{ fileName: 'requirements.json', mediaType: 'application/json', content: requirementsContent, contentSha256: requirementsHash }, { fileName: 'manifest.json', mediaType: 'application/json', content: manifestContent, contentSha256: sha256(manifestContent) }], contentSha256: sha256(manifestContent) } } } as never)
    state.technicalSolutionRuns.push({ id: 'technical-run-1', sourceReviewRunId: 'review-run-1', projectVersionId: 'project-version-1', status: 'succeeded', result: {} } as never)
  })
  const service = new TestDesignService(store)
  await assert.rejects(() => service.createDesign('project-version-1', { name: '订单测试设计', objective: '验证发布需求', basisMode: 'review_baseline', sourceReviewRunId: 'review-run-1', sourceTechnicalSolutionRunId: 'technical-run-1', knowledgeAugmentation: { mode: 'disabled' } }, principal), (error: unknown) => error instanceof TestDesignError && error.code === 'TEST_DESIGN_REQUIREMENTS_PACKAGE_INVALID')
})

function json(value: unknown) { return `${JSON.stringify(value, null, 2)}\n` }
function sha256(value: string) { return createHash('sha256').update(value).digest('hex') }
