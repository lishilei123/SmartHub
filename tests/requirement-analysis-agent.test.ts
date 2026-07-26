import assert from 'node:assert/strict'
import test from 'node:test'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { PiAgentRuntimeAdapter } from '../server/agent/pi-agent-runtime.js'
import { createRequirementPointExtractionAgentDefinition, REQUIREMENT_POINT_EXTRACTION_AGENT_VERSION } from '../server/agent/requirement-analysis-agent.js'
import { RequirementPointExtractionValidator, RequirementReviewValidator } from '../server/agent/result-validator.js'
import { RequirementAnalysisService } from '../server/application/requirement-analysis-service.js'
import type { CandidateRequirementPointExtraction, CandidateRequirementReview } from '../server/domain/review-types.js'
import { defaultConfig } from '../server/domain/types.js'
import { JsonStore } from '../server/infrastructure/store.js'

test('提取 Agent 提示词明确固定证据的提交常量与标识来源', () => {
  const definition = createRequirementPointExtractionAgentDefinition()
  assert.equal(REQUIREMENT_POINT_EXTRACTION_AGENT_VERSION, '3.2.0')
  assert.match(definition.systemPrompt, /sourceType 必须且只能填写字符串 `knowledge_chunk`/u)
  assert.match(definition.systemPrompt, /严禁填写 `ASSET`/u)
  assert.match(definition.systemPrompt, /sourceRef\.chunkId 与 sourceRef\.assetVersionId 必须逐字复制 evidence_validate/u)
  assert.match(definition.systemPrompt, /reviewedChunkIds/u)
  assert.match(definition.systemPrompt, /actor、action、object/u)
  assert.match(definition.systemPrompt, /evidence_validate/u)
})

test('重复固定 Chunk 读取重放原结果并保留审计标记', async () => {
  const store = await seededStore()
  const faux = fauxProvider()
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('knowledge_read_asset', { assetVersionId: 'version-1' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('knowledge_read_asset', { assetVersionId: 'version-2' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('knowledge_read_chunk', { chunkId: 'chunk-1' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('knowledge_read_chunk', { chunkId: 'chunk-1' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('knowledge_read_chunk', { chunkId: 'chunk-1' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('knowledge_read_chunk', { chunkId: 'chunk-1' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('knowledge_read_chunk', { chunkId: 'chunk-2' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('requirement_points_submit_result', extractionResult()), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('review_submit_result', reviewResult()), { stopReason: 'toolUse' }),
  ])
  const service = new RequirementAnalysisService(store, new PiAgentRuntimeAdapter(store, {
    model: faux.getModel() as Model<Api>,
    streamFn: faux.provider.streamSimple.bind(faux.provider) as StreamFn,
  }))

  const output = await service.analyze({ projectVersionId: 'project-version-1', assetVersionIds: ['version-1', 'version-2'], sourceId: 'source-1', modelId: 'model-1' })
  const repeatedRead = output.executions.requirementPointExtraction.events.find(event =>
    event.type === 'tool_execution_end'
    && event.toolId === 'knowledge_read_chunk'
    && JSON.stringify(event.toolResult).includes('replayed')
  )

  assert.equal(output.status, 'candidate_validated')
  assert.ok(repeatedRead)
  assert.match(JSON.stringify(repeatedRead.toolResult), /chunk-1/u)
  assert.match(JSON.stringify(repeatedRead.toolResult), /replayed/u)
})

test('提取提交被证据和覆盖校验拒绝后允许补读并修复', async () => {
  const store = await seededStore()
  const invalid = structuredClone(extractionResult())
  invalid.evidence[0].quote = '无效'
  invalid.coverage.assets[1].reviewedChunkIds = []
  const faux = fauxProvider()
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('knowledge_read_asset', { assetVersionId: 'version-1' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('knowledge_read_asset', { assetVersionId: 'version-2' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('knowledge_read_chunk', { chunkId: 'chunk-1' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('requirement_points_submit_result', invalid), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('knowledge_read_chunk', { chunkId: 'chunk-2' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('evidence_validate', {
      chunkId: 'chunk-1',
      assetVersionId: 'version-1',
      quote: '用户可以取消待支付订单。',
    }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('requirement_points_submit_result', extractionResult()), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('review_submit_result', reviewResult()), { stopReason: 'toolUse' }),
  ])
  const service = new RequirementAnalysisService(store, new PiAgentRuntimeAdapter(store, {
    model: faux.getModel() as Model<Api>,
    streamFn: faux.provider.streamSimple.bind(faux.provider) as StreamFn,
  }))

  const output = await service.analyze({ projectVersionId: 'project-version-1', assetVersionIds: ['version-1', 'version-2'], sourceId: 'source-1', modelId: 'model-1' })

  assert.equal(output.status, 'candidate_validated')
  assert.ok(output.executions.requirementPointExtraction.events.some(event =>
    event.type === 'tool_execution_start'
    && event.toolId === 'knowledge_read_chunk'
    && JSON.stringify(event.toolArguments).includes('chunk-2')
  ))
  assert.ok(output.executions.requirementPointExtraction.events.some(event =>
    event.type === 'tool_execution_start'
    && event.toolId === 'evidence_validate'
  ))
})

test('两个独立 Agent 串联提取固定需求点并生成评审结果', async () => {
  const store = await seededStore()
  const extraction = extractionResult()
  const review = reviewResult()
  const faux = fauxProvider()
  faux.setResponses([
    ...extractionToolResponses(extraction),
    fauxAssistantMessage(fauxToolCall('review_submit_result', review), { stopReason: 'toolUse' }),
  ])
  const toolChoices: unknown[] = []
  const prompts: string[] = []
  const stream: StreamFn = (model, context, options) => {
    toolChoices.push((options as { toolChoice?: unknown } | undefined)?.toolChoice)
    prompts.push(context.messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).join('\n'))
    return (faux.provider.streamSimple.bind(faux.provider) as StreamFn)(model, context, options)
  }
  const service = new RequirementAnalysisService(store, new PiAgentRuntimeAdapter(store, { model: faux.getModel() as Model<Api>, streamFn: stream }))
  await assert.rejects(() => service.analyze({ projectVersionId: 'project-version-1', assetVersionIds: ['version-1'], sourceId: 'source-1', modelId: 'model-1' }), /全部有效需求绑定/u)

  const output = await service.analyze({ projectVersionId: 'project-version-1', assetVersionIds: ['version-1', 'version-2'], sourceId: 'source-1', modelId: 'model-1' })
  assert.equal(output.status, 'candidate_validated')
  assert.deepEqual(output.result.requirementPoints, extraction.requirementPoints)
  assert.deepEqual(output.result.evidence, extraction.evidence)
  assert.deepEqual(output.result.coverage, extraction.coverage)
  assert.deepEqual(output.result.findings, review.findings)
  assert.equal(output.snapshot.agentDefinitions.requirementPointExtraction.agentKey, 'requirement-point-extraction')
  assert.equal(output.snapshot.agentDefinitions.requirementReview.agentKey, 'requirement-review')
  assert.ok(output.snapshot.agentDefinitions.requirementPointExtraction.toolIds.includes('knowledge.read_asset'))
  assert.deepEqual(output.snapshot.agentDefinitions.requirementReview.toolIds, ['review.submit_result'])
  assert.equal(output.snapshot.agentDefinitions.requirementPointExtraction.systemPrompt, undefined)
  assert.equal(output.snapshot.agentDefinitions.requirementReview.systemPrompt, undefined)
  assert.equal(output.executions.requirementPointExtraction.agentKey, 'requirement-point-extraction')
  assert.equal(output.executions.requirementReview.agentKey, 'requirement-review')
  assert.ok(output.executions.requirementPointExtraction.events.some(event => event.toolId === 'requirement_points_submit_result'))
  assert.ok(output.executions.requirementReview.events.some(event => event.toolId === 'review_submit_result'))
  assert.ok(toolChoices.every(choice => choice === undefined))
  assert.match(prompts[0], /不得生成 Finding、评分或评审结论/u)
  const reviewPrompt = prompts.find(prompt => /已由 SmartHub 校验并冻结/u.test(prompt))
  assert.ok(reviewPrompt)
  assert.match(reviewPrompt, /RP-001/u)
  assert.doesNotMatch(reviewPrompt, /knowledge_read_asset/u)

  const stored = (await store.snapshot()).reviewRuns[0]
  assert.equal(stored.step, 'completed')
  assert.deepEqual(stored.extractionResult, extraction)
  assert.equal(stored.executions?.requirementPointExtraction?.agentKey, 'requirement-point-extraction')
  assert.equal(stored.executions?.requirementReview?.agentKey, 'requirement-review')
})

test('提取结果不接受 Finding，评审结果不接受需求点改写', async () => {
  const store = await seededStore()
  const serviceRuntime = new PiAgentRuntimeAdapter(store)
  assert.ok(serviceRuntime)
  const snapshot = await snapshotForValidation(store)
  const extraction = extractionResult()
  const extractionValidator = new RequirementPointExtractionValidator(store)
  const invalidExtraction = { ...extraction, findings: [] }
  const extractionReport = await extractionValidator.validate(invalidExtraction, snapshot)
  assert.equal(extractionReport.valid, false)
  assert.ok(extractionReport.issues.some(issue => issue.message.includes('不得包含 Finding')))

  const reviewValidator = new RequirementReviewValidator()
  const invalidReview = { ...reviewResult(), requirementPoints: [] }
  const reviewReport = await reviewValidator.validate(invalidReview, extraction, snapshot)
  assert.equal(reviewReport.valid, false)
  assert.ok(reviewReport.issues.some(issue => issue.message.includes('不得增删或改写')))

  const wrongReference: CandidateRequirementReview = { ...reviewResult(), findings: [{ ...reviewResult().findings[0], requirementPointRefs: ['RP-999'] }] }
  const referenceReport = await reviewValidator.validate(wrongReference, extraction, snapshot)
  assert.equal(referenceReport.valid, false)
  assert.ok(referenceReport.issues.some(issue => issue.path.endsWith('requirementPointRefs')))

  const directEvidence = { ...reviewResult(), findings: [{ ...reviewResult().findings[0], evidenceRefs: ['E-001'] }] }
  const directEvidenceReport = await reviewValidator.validate(directEvidence, extraction, snapshot)
  assert.equal(directEvidenceReport.valid, false)
  assert.ok(directEvidenceReport.issues.some(issue => issue.message.includes('不得直接关联 Evidence')))
})

test('提取阶段固定证据仍由服务端独立校验', async () => {
  const store = await seededStore()
  const snapshot = await snapshotForValidation(store)
  const invalid = extractionResult()
  invalid.evidence[0].quote = '伪造证据'
  const report = await new RequirementPointExtractionValidator(store).validate(invalid, snapshot)
  assert.equal(report.valid, false)
  assert.ok(report.issues.some(issue => issue.path === 'evidence[0].quote'))
})

test('提取覆盖缺少固定 Chunk 时不能冻结结果', async () => {
  const store = await seededStore()
  const snapshot = await snapshotForValidation(store)
  const invalid = extractionResult()
  invalid.coverage.assets[0].reviewedChunkIds = []
  const report = await new RequirementPointExtractionValidator(store).validate(invalid, snapshot, new Set(['chunk-1', 'chunk-2']))
  assert.equal(report.valid, false)
  assert.ok(report.issues.some(issue => issue.message.includes('提取覆盖不完整')))
})

test('未实际读取的 Chunk 不能仅通过提交 coverage 宣称覆盖', async () => {
  const store = await seededStore()
  const snapshot = await snapshotForValidation(store)
  const report = await new RequirementPointExtractionValidator(store).validate(extractionResult(), snapshot, new Set(['chunk-1']))
  assert.equal(report.valid, false)
  assert.ok(report.issues.some(issue => issue.message.includes('未被运行时读取')))
})

test('证据来源 Chunk 必须由提取运行实际读取', async () => {
  const store = await seededStore()
  const snapshot = await snapshotForValidation(store)
  const report = await new RequirementPointExtractionValidator(store).validate(extractionResult(), snapshot, new Set(['chunk-1']))
  assert.equal(report.valid, false)
  assert.ok(report.issues.some(issue => issue.message.includes('证据来源 Chunk 未被运行时读取')))
})

test('未遍历固定资产目录时不能冻结提取结果', async () => {
  const store = await seededStore()
  const snapshot = await snapshotForValidation(store)
  const report = await new RequirementPointExtractionValidator(store).validate(
    extractionResult(),
    snapshot,
    new Set(['chunk-1', 'chunk-2']),
    new Map()
  )
  assert.equal(report.valid, false)
  assert.ok(report.issues.some(issue => issue.message.includes('未完整遍历资产')))
})

test('需求点缺少原子行为字段时被拒绝', async () => {
  const store = await seededStore()
  const snapshot = await snapshotForValidation(store)
  const invalid = extractionResult()
  invalid.requirementPoints[0] = { ...invalid.requirementPoints[0], action: '', businessRules: [], acceptanceCriteria: [] }
  const report = await new RequirementPointExtractionValidator(store).validate(invalid, snapshot)
  assert.equal(report.valid, false)
  assert.ok(report.issues.some(issue => issue.path.endsWith('.action')))
})

test('重复主体、动作和对象必须声明一致的归并理由', async () => {
  const store = await seededStore()
  const snapshot = await snapshotForValidation(store)
  const invalid = extractionResult()
  invalid.requirementPoints.push({
    ...invalid.requirementPoints[0],
    clientRequirementPointId: 'RP-003',
  })
  const report = await new RequirementPointExtractionValidator(store).validate(invalid, snapshot)
  assert.equal(report.valid, false)
  assert.ok(report.issues.some(issue => issue.path.includes('mergeGroupId')))
})

async function snapshotForValidation(store: JsonStore) {
  const faux = fauxProvider()
  faux.setResponses([
    ...extractionToolResponses(extractionResult()),
    fauxAssistantMessage(fauxToolCall('review_submit_result', reviewResult()), { stopReason: 'toolUse' }),
  ])
  const service = new RequirementAnalysisService(store, new PiAgentRuntimeAdapter(store, { model: faux.getModel() as Model<Api>, streamFn: faux.provider.streamSimple.bind(faux.provider) as StreamFn }))
  const output = await service.analyze({ projectVersionId: 'project-version-1', assetVersionIds: ['version-1', 'version-2'], sourceId: 'source-1', modelId: 'model-1' })
  return (await store.snapshot()).reviewRuns.find(run => run.id === output.runId)!.snapshot
}

function extractionToolResponses(extraction: CandidateRequirementPointExtraction) {
  return [
    fauxAssistantMessage(fauxToolCall('knowledge_read_asset', { assetVersionId: 'version-1' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('knowledge_read_asset', { assetVersionId: 'version-2' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('knowledge_read_chunk', { chunkId: 'chunk-1' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('knowledge_read_chunk', { chunkId: 'chunk-2' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('requirement_points_submit_result', extraction), { stopReason: 'toolUse' }),
  ]
}

function extractionResult(): CandidateRequirementPointExtraction {
  return {
    requirementPoints: [
      { clientRequirementPointId: 'RP-001', title: '取消待支付订单', description: '用户可以取消处于待支付状态的订单。', actor: '用户', action: '取消', object: '待支付订单', conditions: ['订单处于待支付状态'], businessRules: [], exceptions: [], acceptanceCriteria: ['用户提交取消后订单不再待支付'], evidenceRefs: ['E-001'] },
      { clientRequirementPointId: 'RP-002', title: '支付超时关闭订单', description: '超过十五分钟未支付的订单会自动关闭。', actor: '系统', action: '关闭', object: '超时未支付订单', conditions: ['超过十五分钟未支付'], businessRules: ['超时自动关闭'], exceptions: [], acceptanceCriteria: ['超时订单状态为已关闭'], evidenceRefs: ['E-002'] },
    ],
    evidence: [
      { clientEvidenceId: 'E-001', sourceType: 'knowledge_chunk', sourceRef: { chunkId: 'chunk-1', assetVersionId: 'version-1' }, quote: '用户可以取消待支付订单。', locator: { heading: '取消订单', start: 8, end: 20 } },
      { clientEvidenceId: 'E-002', sourceType: 'knowledge_chunk', sourceRef: { chunkId: 'chunk-2', assetVersionId: 'version-2' }, quote: '订单超过十五分钟未支付时自动关闭。', locator: { heading: '支付超时', start: 8, end: 25 } },
    ],
    coverage: {
      assets: [
        { assetVersionId: 'version-1', reviewedChunkIds: ['chunk-1'], skippedChunks: [] },
        { assetVersionId: 'version-2', reviewedChunkIds: ['chunk-2'], skippedChunks: [] },
      ],
      limitations: [],
    },
  }
}

function reviewResult(): CandidateRequirementReview {
  return {
    summary: { overallAssessment: 'needs_revision', score: 65, strengths: ['目标明确'], risks: ['取消后的状态未定义'] },
    findings: [{ clientFindingId: 'F-001', type: 'state_gap', severity: 'high', confidence: 0.9, title: '取消后状态缺失', description: '需求只定义可取消，未定义取消后的订单状态。', impact: '实现和验收口径可能不一致。', recommendation: '补充状态迁移、幂等与失败处理。', requirementPointRefs: ['RP-001'] }],
  }
}

async function seededStore() {
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
    const chunk = { id: 'chunk-1', chunkKey: 'cancel', assetVersionId: 'version-1', ordinal: 0, headingPath: ['取消订单'], content: '用户可以取消待支付订单。', contentHash: 'chunk-hash', tokenCount: 10, startLine: 3, endLine: 3, startChar: 8, endChar: 20, embedding: [], reused: false }
    const paymentChunk = { id: 'chunk-2', chunkKey: 'payment', assetVersionId: 'version-2', ordinal: 0, headingPath: ['支付超时'], content: '订单超过十五分钟未支付时自动关闭。', contentHash: 'payment-chunk-hash', tokenCount: 12, startLine: 3, endLine: 3, startChar: 8, endChar: 25, embedding: [], reused: false }
    state.versions.push({ id: 'version-1', assetId: 'asset-1', number: 1, content, contentHash: 'asset-hash', status: 'ready', configVersionId: 'config-1', createdAt: '2026-07-23T00:00:00.000Z', readyAt: '2026-07-23T00:00:01.000Z', chunks: [chunk] })
    state.versions.push({ id: 'version-2', assetId: 'asset-2', number: 1, content: paymentContent, contentHash: 'payment-asset-hash', status: 'ready', configVersionId: 'config-1', createdAt: '2026-07-23T00:00:00.000Z', readyAt: '2026-07-23T00:00:01.000Z', chunks: [paymentChunk] })
    state.projectVersionRequirementBindings.push({ id: 'binding-1', projectVersionId: 'project-version-1', assetId: 'asset-1', assetVersionId: 'version-1', createdAt: '2026-07-23T00:00:01.000Z' })
    state.projectVersionRequirementBindings.push({ id: 'binding-2', projectVersionId: 'project-version-1', assetId: 'asset-2', assetVersionId: 'version-2', createdAt: '2026-07-23T00:00:01.000Z' })
    state.indexes.push({ id: 'index-1', knowledgeBaseId: 'kb-1', number: 1, status: 'active', assetVersionIds: ['version-1', 'version-2'], configVersionId: 'config-1', indexedChunks: [{ ...chunk, assetMetadata: { assetId: 'asset-1', displayName: '取消订单需求', assetType: 'requirement', sourceType: 'upload', logicalPath: 'requirements/cancel.md' } }, { ...paymentChunk, assetMetadata: { assetId: 'asset-2', displayName: '支付超时需求', assetType: 'requirement', sourceType: 'upload', logicalPath: 'requirements/payment.md' } }], createdAt: '2026-07-23T00:00:00.000Z', activatedAt: '2026-07-23T00:00:01.000Z' })
    state.modelSources.push({ id: 'source-1', name: '测试来源', providerType: 'openai_compatible', baseUrl: 'https://provider.example/v1', apiKey: 'secret', enabled: true, health: 'healthy', priority: 1, models: [{ id: 'model-1', name: 'review-model', displayName: 'Review Model', contextWindow: 32_768, maxOutputTokens: 4_096, capabilities: ['tool_calling', 'structured_output'], enabled: true, health: 'healthy' }], createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z' })
  })
  return store
}
