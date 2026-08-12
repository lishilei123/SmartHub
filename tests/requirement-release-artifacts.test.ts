import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { buildRequirementReleaseArtifacts } from '../server/application/requirement-release-artifacts.js'
import type { RequirementAnalysisResult } from '../server/domain/review-types.js'
import type { ReviewRun } from '../server/domain/types.js'
import { JsonStore } from '../server/infrastructure/store.js'

test('正式需求包同时生成 Markdown 与 requirements.json 等机器可读产物', async () => {
  const store = new JsonStore(null)
  await store.load()
  const source = '# 订单取消\n\n用户可以取消待支付订单。'
  const sourceSha256 = sha256(source)
  const result = analysisResult()
  const run = {
    id: 'verification-run-1', projectVersionId: 'project-version-1', assetId: 'asset-1', assetVersionId: 'version-2', documentTitle: '修复后需求', documentVersion: 2,
    logicalPath: 'workspace/branches/V1/input/requirements', sourceId: 'source-1', modelId: 'model-1', modelLabel: '模型', status: 'succeeded', step: 'completed', progress: 100,
    createdAt: '2026-08-12T00:00:00.000Z', startedAt: '2026-08-12T00:00:00.000Z', finishedAt: '2026-08-12T00:01:00.000Z', result,
    snapshot: {
      runId: 'verification-run-1', projectId: 'project-1', projectName: '订单项目', projectVersionId: 'project-version-1', projectVersionName: 'V1', knowledgeBaseId: 'kb-1',
      assetId: 'asset-1', assetVersionId: 'version-2', assetContentHash: sourceSha256, indexVersionId: 'index-2', logicalPath: 'workspace/branches/V1/input/requirements/order.md',
      assets: [{ assetId: 'asset-1', assetVersionId: 'version-2', assetContentHash: sourceSha256, logicalPath: 'workspace/branches/V1/input/requirements/order.md', displayName: 'order.md', assetType: 'requirement' }],
    },
  } as unknown as ReviewRun
  await store.transaction(state => {
    state.assets.push({ id: 'asset-1', knowledgeBaseId: 'kb-1', displayName: 'order.md', logicalPath: 'workspace/branches/V1/input/requirements/order.md', assetType: 'requirement', sourceType: 'upload', sourceKey: 'order.md', activeVersionId: 'version-2', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' })
    state.versions.push({ id: 'version-2', assetId: 'asset-1', number: 2, content: source, contentHash: sourceSha256, status: 'ready', configVersionId: 'config-1', createdAt: '2026-08-12T00:00:00.000Z', chunks: [] })
  })
  const built = buildRequirementReleaseArtifacts({
    state: await store.snapshot(), releaseId: 'release-1', verificationRun: run,
    candidate: { schemaVersion: 'requirement-release-candidate/v1', sourceAssetVersionIds: ['version-2'], refinedRequirementsMarkdown: '# 完善需求\n\n用户可以取消待支付订单。' },
    generatedAt: '2026-08-12T00:02:00.000Z',
  })

  const names = built.artifacts.map(item => item.fileName)
  assert.deepEqual(names, [
    '修复后的需求原文/order.md', 'refined-requirements.md', 'requirement-baseline.md', 'requirements.json', 'requirement-review-closure.md', 'findings.json',
    'requirement-analysis-report.md', 'test-focus.md', 'test-focus.json', 'traceability.json', 'manifest.json',
  ])
  built.artifacts.forEach(item => assert.equal(item.contentSha256, sha256(item.content)))
  const requirements = JSON.parse(built.artifacts.find(item => item.fileName === 'requirements.json')!.content)
  assert.equal(requirements.schemaVersion, 'requirements/v1')
  assert.equal(requirements.requirements[0].clientRequirementPointId, 'RP-001')
  assert.equal(requirements.sourceAssetVersions[0].assetVersionId, 'version-2')
  const manifestArtifact = built.artifacts.find(item => item.fileName === 'manifest.json')!
  const manifest = JSON.parse(manifestArtifact.content)
  assert.equal(manifest.machineReadableEntryPoints.requirements, 'requirements.json')
  assert.ok(manifest.artifacts.some((item: { fileName: string }) => item.fileName === 'requirements.json'))
  assert.equal(built.contentSha256, manifestArtifact.contentSha256)
})

function analysisResult(): RequirementAnalysisResult {
  const baseline = '# Requirement Baseline\n'
  const review = '# Requirement Review\n'
  const analysis = '# 需求分析报告\n'
  return {
    summary: { overview: '订单取消需求。', businessGoals: ['支持用户取消'], overallAssessment: 'pass', score: 100, strengths: [], risks: [] },
    requirementPoints: [{ clientRequirementPointId: 'RP-001', title: '取消待支付订单', description: '用户可以取消待支付订单。', actor: '用户', action: '取消', object: '待支付订单', conditions: [], businessRules: [], exceptions: [], acceptanceCriteria: [], evidenceRefs: ['EV-001'] }],
    evidence: [{ clientEvidenceId: 'EV-001', sourceType: 'knowledge_chunk', sourceRef: { chunkId: 'chunk-1', assetVersionId: 'version-2' }, quote: '用户可以取消待支付订单。', locator: { heading: '订单取消', start: 8, end: 20 } }],
    coverage: { assets: [{ assetVersionId: 'version-2', deliveredChunkIds: ['chunk-1'], excludedChunks: [] }], limitations: [] },
    findings: [],
    testFocus: [{ id: 'TF-001', title: '取消成功', description: '验证待支付订单取消成功。', requirementPointRefs: ['RP-001'] }],
    artifacts: [markdownArtifact('requirement-baseline.md', baseline), markdownArtifact('requirement-review.md', review), markdownArtifact('requirement-analysis.md', analysis)],
  }
}

function markdownArtifact(fileName: 'requirement-baseline.md' | 'requirement-review.md' | 'requirement-analysis.md', content: string) { return { fileName, mediaType: 'text/markdown' as const, content, contentSha256: sha256(content) } }
function sha256(value: string) { return createHash('sha256').update(value).digest('hex') }
