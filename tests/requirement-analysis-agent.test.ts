import assert from 'node:assert/strict'
import test from 'node:test'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { PiAgentRuntimeAdapter } from '../server/agent/pi-agent-runtime.js'
import { RequirementAnalysisService } from '../server/application/requirement-analysis-service.js'
import { defaultConfig } from '../server/domain/types.js'
import { JsonStore } from '../server/infrastructure/store.js'

test('RequirementAnalysisAgent 通过真实 Pi Agent 工具循环提交并校验候选结果', async () => {
  const store = new JsonStore(null)
  await store.load()
  const content = '# 取消订单\n\n用户可以取消待支付订单。'
  await store.transaction(state => {
    state.projects.push({ id: 'project-1', name: '订单项目', createdAt: '2026-07-23T00:00:00.000Z' })
    state.configs.push({ id: 'config-1', knowledgeBaseId: 'kb-1', version: 1, config: structuredClone(defaultConfig), createdAt: '2026-07-23T00:00:00.000Z', compatibilityFingerprint: 'config-hash', requiresRebuild: false })
    state.knowledgeBases.push({ id: 'kb-1', projectId: 'project-1', name: '项目知识库', createdAt: '2026-07-23T00:00:00.000Z', activeIndexVersionId: 'index-1', activeConfigVersionId: 'config-1' })
    state.assets.push({ id: 'asset-1', knowledgeBaseId: 'kb-1', displayName: '取消订单需求', logicalPath: 'requirements/cancel.md', assetType: 'requirement', sourceType: 'upload', sourceKey: 'cancel.md', activeVersionId: 'version-1', createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z' })
    const chunk = { id: 'chunk-1', chunkKey: 'cancel', assetVersionId: 'version-1', ordinal: 0, headingPath: ['取消订单'], content: '用户可以取消待支付订单。', contentHash: 'chunk-hash', tokenCount: 10, startLine: 3, endLine: 3, startChar: 8, endChar: 21, embedding: [], reused: false }
    state.versions.push({ id: 'version-1', assetId: 'asset-1', number: 1, content, contentHash: 'asset-hash', status: 'ready', configVersionId: 'config-1', createdAt: '2026-07-23T00:00:00.000Z', readyAt: '2026-07-23T00:00:01.000Z', chunks: [chunk] })
    state.indexes.push({ id: 'index-1', knowledgeBaseId: 'kb-1', number: 1, status: 'active', assetVersionIds: ['version-1'], configVersionId: 'config-1', indexedChunks: [{ ...chunk, assetMetadata: { assetId: 'asset-1', displayName: '取消订单需求', assetType: 'requirement', sourceType: 'upload', logicalPath: 'requirements/cancel.md' } }], createdAt: '2026-07-23T00:00:00.000Z', activatedAt: '2026-07-23T00:00:01.000Z' })
    state.modelSources.push({ id: 'source-1', name: '测试来源', providerType: 'openai_compatible', baseUrl: 'https://provider.example/v1', apiKey: 'secret', enabled: true, health: 'healthy', priority: 1, models: [{ id: 'model-1', name: 'review-model', displayName: 'Review Model', contextWindow: 32_768, maxOutputTokens: 4_096, capabilities: ['tool_calling', 'structured_output'], enabled: true, health: 'healthy' }], createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z' })
  })

  const faux = fauxProvider()
  const result = {
    summary: { overallAssessment: 'needs_revision', score: 65, strengths: ['目标明确'], risks: ['取消后的状态未定义'] },
    findings: [{ clientFindingId: 'F-001', type: 'state_gap', severity: 'high', confidence: 0.9, title: '取消后状态缺失', description: '需求只定义可取消，未定义取消后的订单状态。', impact: '实现和验收口径可能不一致。', recommendation: '补充状态迁移、幂等与失败处理。', evidenceRefs: ['E-001'] }],
    evidence: [{ clientEvidenceId: 'E-001', sourceType: 'knowledge_chunk', sourceRef: { chunkId: 'chunk-1', assetVersionId: 'version-1' }, quote: '用户可以取消待支付订单。', locator: { heading: '取消订单', start: 8, end: 21 } }],
    coverage: { reviewedAreas: ['状态与异常'], notReviewedAreas: [], limitations: [] },
  }
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('knowledge_read_asset', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('review_submit_result', result), { stopReason: 'toolUse' }),
  ])
  const runtime = new PiAgentRuntimeAdapter(store, { model: faux.getModel() as Model<Api>, streamFn: faux.provider.streamSimple.bind(faux.provider) as StreamFn })
  const service = new RequirementAnalysisService(store, runtime)
  const output = await service.analyze({ assetVersionId: 'version-1', sourceId: 'source-1', modelId: 'model-1' })
  assert.equal(output.status, 'candidate_validated')
  assert.equal(output.result.findings[0].title, '取消后状态缺失')
  assert.equal(output.execution.framework.name, 'pi-agent-core')
  assert.equal(output.execution.toolCalls, 2)
  assert.ok(output.execution.events.some(event => event.type === 'tool_execution_end' && event.toolId === 'review_submit_result'))
})

test('独立结果校验拒绝伪造固定索引证据', async () => {
  const store = new JsonStore(null)
  await store.load()
  const faux = fauxProvider()
  faux.setResponses([])
  const runtime = new PiAgentRuntimeAdapter(store, { model: faux.getModel() as Model<Api>, streamFn: faux.provider.streamSimple.bind(faux.provider) as StreamFn })
  const service = new RequirementAnalysisService(store, runtime)
  await assert.rejects(() => service.analyze({ assetVersionId: 'missing', sourceId: 'missing', modelId: 'missing' }), /需求资产版本不存在/u)
})

