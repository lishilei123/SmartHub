import assert from 'node:assert/strict'
import test from 'node:test'
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { PiAgentRuntimeAdapter } from '../server/agent/pi-agent-runtime.js'
import { PiReviewQaRuntimeAdapter } from '../server/agent/pi-review-qa-runtime.js'
import { RequirementAnalysisService } from '../server/application/requirement-analysis-service.js'
import { ReviewQaService } from '../server/application/review-qa-service.js'
import type { AgentRuntime } from '../server/domain/agent-types.js'
import { defaultConfig } from '../server/domain/types.js'
import { JsonStore } from '../server/infrastructure/store.js'

test('RequirementAnalysisAgent 通过真实 Pi Agent 工具循环提交并校验候选结果', async () => {
  const store = new JsonStore(null)
  await store.load()
  const content = '# 取消订单\n\n用户可以取消待支付订单。'
  const paymentContent = '# 支付超时\n\n订单超过十五分钟未支付时自动关闭。'
  await store.transaction(state => {
    state.projects.push({ id: 'project-1', name: '订单项目', createdAt: '2026-07-23T00:00:00.000Z' })
    state.projectVersions.push({ id: 'project-version-1', projectId: 'project-1', name: 'V1.0', status: 'open', createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z' })
    state.configs.push({ id: 'config-1', knowledgeBaseId: 'kb-1', version: 1, config: structuredClone(defaultConfig), createdAt: '2026-07-23T00:00:00.000Z', compatibilityFingerprint: 'config-hash', requiresRebuild: false })
    state.knowledgeBases.push({ id: 'kb-1', projectId: 'project-1', name: '项目知识库', createdAt: '2026-07-23T00:00:00.000Z', activeIndexVersionId: 'index-1', activeConfigVersionId: 'config-1' })
    state.assets.push({ id: 'asset-1', knowledgeBaseId: 'kb-1', displayName: '取消订单需求', logicalPath: 'requirements/cancel.md', assetType: 'requirement', sourceType: 'upload', sourceKey: 'cancel.md', activeVersionId: 'version-1', createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z' })
    state.assets.push({ id: 'asset-2', knowledgeBaseId: 'kb-1', displayName: '支付超时需求', logicalPath: 'requirements/payment.md', assetType: 'requirement', sourceType: 'upload', sourceKey: 'payment.md', activeVersionId: 'version-2', createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z' })
    const chunk = { id: 'chunk-1', chunkKey: 'cancel', assetVersionId: 'version-1', ordinal: 0, headingPath: ['取消订单'], content: '用户可以取消待支付订单。', contentHash: 'chunk-hash', tokenCount: 10, startLine: 3, endLine: 3, startChar: 8, endChar: 21, embedding: [], reused: false }
    const paymentChunk = { id: 'chunk-2', chunkKey: 'payment', assetVersionId: 'version-2', ordinal: 0, headingPath: ['支付超时'], content: '订单超过十五分钟未支付时自动关闭。', contentHash: 'payment-chunk-hash', tokenCount: 12, startLine: 3, endLine: 3, startChar: 8, endChar: 25, embedding: [], reused: false }
    state.versions.push({ id: 'version-1', assetId: 'asset-1', number: 1, content, contentHash: 'asset-hash', status: 'ready', configVersionId: 'config-1', createdAt: '2026-07-23T00:00:00.000Z', readyAt: '2026-07-23T00:00:01.000Z', chunks: [chunk] })
    state.versions.push({ id: 'version-2', assetId: 'asset-2', number: 1, content: paymentContent, contentHash: 'payment-asset-hash', status: 'ready', configVersionId: 'config-1', createdAt: '2026-07-23T00:00:00.000Z', readyAt: '2026-07-23T00:00:01.000Z', chunks: [paymentChunk] })
    state.projectVersionRequirementBindings.push({ id: 'binding-1', projectVersionId: 'project-version-1', assetId: 'asset-1', assetVersionId: 'version-1', createdAt: '2026-07-23T00:00:01.000Z' })
    state.projectVersionRequirementBindings.push({ id: 'binding-2', projectVersionId: 'project-version-1', assetId: 'asset-2', assetVersionId: 'version-2', createdAt: '2026-07-23T00:00:01.000Z' })
    state.indexes.push({ id: 'index-1', knowledgeBaseId: 'kb-1', number: 1, status: 'active', assetVersionIds: ['version-1', 'version-2'], configVersionId: 'config-1', indexedChunks: [{ ...chunk, assetMetadata: { assetId: 'asset-1', displayName: '取消订单需求', assetType: 'requirement', sourceType: 'upload', logicalPath: 'requirements/cancel.md' } }, { ...paymentChunk, assetMetadata: { assetId: 'asset-2', displayName: '支付超时需求', assetType: 'requirement', sourceType: 'upload', logicalPath: 'requirements/payment.md' } }], createdAt: '2026-07-23T00:00:00.000Z', activatedAt: '2026-07-23T00:00:01.000Z' })
    state.modelSources.push({ id: 'source-1', name: '测试来源', providerType: 'openai_compatible', baseUrl: 'https://provider.example/v1', apiKey: 'secret', enabled: true, health: 'healthy', priority: 1, models: [{ id: 'model-1', name: 'review-model', displayName: 'Review Model', contextWindow: 32_768, maxOutputTokens: 4_096, capabilities: ['tool_calling', 'structured_output'], enabled: true, health: 'healthy' }], createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z' })
  })

  const faux = fauxProvider()
  const result = {
    summary: { overallAssessment: 'needs_revision', score: 65, strengths: ['目标明确'], risks: ['取消后的状态未定义'] },
    requirementPoints: [{ clientRequirementPointId: 'RP-001', title: '取消待支付订单', description: '用户可以取消处于待支付状态的订单。', evidenceRefs: ['E-001'] }, { clientRequirementPointId: 'RP-002', title: '支付超时关闭订单', description: '超过十五分钟未支付的订单会自动关闭。', evidenceRefs: ['E-002'] }],
    findings: [{ clientFindingId: 'F-001', type: 'state_gap', severity: 'high', confidence: 0.9, title: '取消后状态缺失', description: '需求只定义可取消，未定义取消后的订单状态。', impact: '实现和验收口径可能不一致。', recommendation: '补充状态迁移、幂等与失败处理。', requirementPointRefs: ['RP-001'], evidenceRefs: ['E-001'] }],
    evidence: [{ clientEvidenceId: 'E-001', sourceType: 'knowledge_chunk', sourceRef: { chunkId: 'chunk-1', assetVersionId: 'version-1' }, quote: '用户可以取消待支付订单。', locator: { heading: '取消订单', start: 8, end: 21 } }, { clientEvidenceId: 'E-002', sourceType: 'knowledge_chunk', sourceRef: { chunkId: 'chunk-2', assetVersionId: 'version-2' }, quote: '订单超过十五分钟未支付时自动关闭。', locator: { heading: '支付超时', start: 8, end: 25 } }],
    coverage: { reviewedAreas: ['状态与异常'], notReviewedAreas: [], limitations: [] },
  }
  faux.setResponses([
    fauxAssistantMessage(fauxText('分析完成。')),
    fauxAssistantMessage(fauxToolCall('knowledge_read_asset', { assetVersionId: 'version-1' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('review_submit_result', result), { stopReason: 'toolUse' }),
  ])
  const observedToolChoices: unknown[] = []
  const trackedStream: StreamFn = (model, context, options) => {
    observedToolChoices.push((options as { toolChoice?: unknown } | undefined)?.toolChoice)
    return (faux.provider.streamSimple.bind(faux.provider) as StreamFn)(model, context, options)
  }
  const runtime = new PiAgentRuntimeAdapter(store, { model: faux.getModel() as Model<Api>, streamFn: trackedStream })
  const service = new RequirementAnalysisService(store, runtime)
  await assert.rejects(() => service.analyze({ projectVersionId: 'project-version-1', assetVersionIds: ['version-1'], sourceId: 'source-1', modelId: 'model-1' }), /全部有效需求绑定/u)
  const output = await service.analyze({ projectVersionId: 'project-version-1', assetVersionIds: ['version-1', 'version-2'], sourceId: 'source-1', modelId: 'model-1' })
  assert.equal(output.status, 'candidate_validated')
  assert.equal(output.result.requirementPoints.length, 2)
  assert.deepEqual(output.snapshot.assets.map(asset => asset.assetVersionId), ['version-1', 'version-2'])
  assert.equal(output.result.findings[0].title, '取消后状态缺失')
  assert.equal(output.execution.framework.name, 'pi-agent-core')
  assert.equal(output.execution.toolCalls, 2)
  assert.ok(output.execution.events.some(event => event.type === 'result_submission_retry'))
  assert.ok(output.execution.events.some(event => event.type === 'tool_execution_end' && event.toolId === 'review_submit_result'))
  assert.equal(observedToolChoices[0], undefined)
  assert.deepEqual(observedToolChoices[1], { type: 'function', function: { name: 'review_submit_result' } })
  assert.deepEqual(observedToolChoices[2], { type: 'function', function: { name: 'review_submit_result' } })
  const stored = await service.list('project-version-1')
  assert.equal(stored.items.length, 1)
  assert.equal(stored.items[0].status, 'succeeded')
  const storedDetail = await service.get(stored.items[0].id)
  assert.equal(storedDetail.response?.result.findings[0].clientFindingId, 'F-001')
  assert.equal(storedDetail.response?.snapshot.agentDefinition.promptRef.version, '2.0.0')
  assert.equal(storedDetail.response?.snapshot.agentDefinition.toolsetVersion, '2.0.0')
  assert.match(storedDetail.response?.snapshot.agentDefinition.toolsetContentSha256 ?? '', /^[a-f0-9]{64}$/u)
  assert.equal(storedDetail.response?.snapshot.modelRef.modelId, 'model-1')
  assert.deepEqual(storedDetail.response?.snapshot.agentDefinition.skillBindings, [])
  assert.deepEqual(storedDetail.response?.snapshot.agentDefinition.mcpBindings, [])
  assert.equal(storedDetail.response?.snapshot.agentDefinition.systemPrompt, undefined)

  const qaProvider = fauxProvider()
  qaProvider.setResponses([
    fauxAssistantMessage(fauxToolCall('review_answer_submit', { answer: '取消后状态需要人工确认，因为固定需求只说明待支付订单可以取消。', citations: ['E-001'], limitations: ['固定需求未定义取消后的目标状态。'] }), { stopReason: 'toolUse' }),
  ])
  const qaService = new ReviewQaService(store, new PiReviewQaRuntimeAdapter({ model: qaProvider.getModel() as Model<Api>, streamFn: qaProvider.provider.streamSimple.bind(qaProvider.provider) as StreamFn }))
  const qaAnswer = await qaService.ask(output.runId, { question: '为什么需要人工确认取消后的状态？', quote: { text: '用户可以取消待支付订单。', assetVersionId: 'version-1', heading: '取消订单' } })
  assert.equal(qaAnswer.citations[0], 'E-001')
  assert.match(qaAnswer.answer, /人工确认/u)

  const invalidQa = new ReviewQaService(store, { answer: async () => ({ answer: '无效引用', citations: ['E-999'], limitations: [] }) })
  await assert.rejects(() => invalidQa.ask(output.runId, { question: '测试无效引用' }), /REVIEW_QA_INVALID_CITATION/u)

  const invalid = fauxProvider()
  invalid.setResponses([
    fauxAssistantMessage(fauxToolCall('review_submit_result', { ...result, evidence: [{ ...result.evidence[0], quote: '伪造证据' }] }), { stopReason: 'toolUse' }),
  ])
  const invalidRuntime = new PiAgentRuntimeAdapter(store, { model: invalid.getModel() as Model<Api>, streamFn: invalid.provider.streamSimple.bind(invalid.provider) as StreamFn })
  const invalidService = new RequirementAnalysisService(store, invalidRuntime)
  await assert.rejects(() => invalidService.analyze({ projectVersionId: 'project-version-1', assetVersionIds: ['version-1', 'version-2'], sourceId: 'source-1', modelId: 'model-1' }), /AGENT_RESULT_VALIDATION_FAILED/u)
  const history = await invalidService.list('project-version-1')
  assert.equal(history.items.length, 2)
  const failed = history.items.find(item => item.status === 'failed')
  assert.match(failed?.error ?? '', /AGENT_RESULT_VALIDATION_FAILED/u)
  assert.ok(history.items.some(item => item.status === 'succeeded'))

  const correcting = fauxProvider()
  correcting.setResponses([
    fauxAssistantMessage(fauxToolCall('review_submit_result', { ...result, findings: [{ ...result.findings[0], evidenceRefs: [] }] }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('review_submit_result', result), { stopReason: 'toolUse' }),
  ])
  const correctingRuntime = new PiAgentRuntimeAdapter(store, { model: correcting.getModel() as Model<Api>, streamFn: correcting.provider.streamSimple.bind(correcting.provider) as StreamFn })
  const corrected = await new RequirementAnalysisService(store, correctingRuntime).analyze({ projectVersionId: 'project-version-1', assetVersionIds: ['version-1', 'version-2'], sourceId: 'source-1', modelId: 'model-1' })
  assert.equal(corrected.status, 'candidate_validated')
  assert.equal(corrected.execution.toolCalls, 2)

  const cancelledController = new AbortController()
  cancelledController.abort(new Error('AGENT_CANCELLED'))
  const cancellingRuntime: AgentRuntime = { execute: async () => { throw new Error('AGENT_CANCELLED') } }
  const cancellingService = new RequirementAnalysisService(store, cancellingRuntime)
  await assert.rejects(() => cancellingService.analyze({ projectVersionId: 'project-version-1', assetVersionIds: ['version-1', 'version-2'], sourceId: 'source-1', modelId: 'model-1' }, cancelledController.signal), /AGENT_CANCELLED/u)
  assert.equal((await cancellingService.list('project-version-1')).items.filter(item => item.status === 'cancelled').length, 1)

  const backgroundRuntime: AgentRuntime = {
    execute: async (_input, signal) => await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
  }
  const backgroundService = new RequirementAnalysisService(store, backgroundRuntime)
  const backgroundRun = await backgroundService.start({ projectVersionId: 'project-version-1', assetVersionIds: ['version-1', 'version-2'], sourceId: 'source-1', modelId: 'model-1' })
  assert.equal(backgroundRun.status, 'running')
  assert.equal((await backgroundService.get(backgroundRun.id)).status, 'running')
  const explicitlyCancelled = await backgroundService.cancel(backgroundRun.id)
  assert.equal(explicitlyCancelled.status, 'cancelled')
  assert.equal((await backgroundService.get(backgroundRun.id)).error, '用户已取消本次评审')
})

test('独立结果校验拒绝伪造固定索引证据', async () => {
  const store = new JsonStore(null)
  await store.load()
  const faux = fauxProvider()
  faux.setResponses([])
  const runtime = new PiAgentRuntimeAdapter(store, { model: faux.getModel() as Model<Api>, streamFn: faux.provider.streamSimple.bind(faux.provider) as StreamFn })
  const service = new RequirementAnalysisService(store, runtime)
  await assert.rejects(() => service.analyze({ projectVersionId: 'missing', assetVersionId: 'missing', sourceId: 'missing', modelId: 'missing' }), /项目版本不存在/u)
})

