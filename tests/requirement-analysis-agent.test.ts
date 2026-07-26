import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { PiAgentRuntimeAdapter } from '../server/agent/pi-agent-runtime.js'
import { resolveEvidenceQuote } from '../server/agent/evidence-locator.js'
import { buildRequirementInputPlan } from '../server/agent/requirement-context-assembler.js'
import { createRequirementPointExtractionAgentDefinition, REQUIREMENT_POINT_EXTRACTION_AGENT_VERSION } from '../server/agent/requirement-analysis-agent.js'
import { RequirementPointExtractionValidator, RequirementReviewValidator } from '../server/agent/result-validator.js'
import { RequirementAnalysisService } from '../server/application/requirement-analysis-service.js'
import type { InputDeliveryManifest, RequirementInputPlan, ReviewRunSnapshot } from '../server/domain/agent-types.js'
import type { CandidateRequirementPointExtraction, CandidateRequirementPointExtractionV2, CandidateRequirementReview } from '../server/domain/review-types.js'
import { defaultConfig } from '../server/domain/types.js'
import { JsonStore } from '../server/infrastructure/store.js'

test('提取 Agent v2 只接收需求点与 Evidence 草稿，覆盖和定位由服务端生成', () => {
  const definition = createRequirementPointExtractionAgentDefinition()
  assert.equal(REQUIREMENT_POINT_EXTRACTION_AGENT_VERSION, '4.0.0')
  assert.equal(definition.resultSchemaVersion, 'requirement-point-extraction/v2')
  assert.match(definition.systemPrompt, /正文会以 full_context 一次完整投递/u)
  assert.match(definition.systemPrompt, /不得提交 sourceType、locator 或 coverage/u)
  assert.match(definition.systemPrompt, /actor、action、object/u)
  assert.deepEqual(definition.toolIds, ['knowledge.search', 'knowledge.read_chunk', 'evidence.validate_batch', 'requirement-points.submit_result'])
  assert.equal(definition.limits.reasoningEffort, 'medium')
})

test('Evidence 定位可把 Markdown 可见文本规范化回原文，并纠正同一资产内的相邻 Chunk', () => {
  const chunks = [
    { id: 'chunk-a', assetVersionId: 'version-a', ordinal: 0, content: '- 状态包括 `open`、`locked`、`archived`。', contentHash: 'hash-a', headingPath: ['状态'], startChar: 100 },
    { id: 'chunk-b', assetVersionId: 'version-a', ordinal: 1, content: '- 其他规则。', contentHash: 'hash-b', headingPath: ['其他'], startChar: 200 },
  ]
  const resolved = resolveEvidenceQuote({ assetVersionId: 'version-a', chunkId: 'chunk-b', quote: '状态包括 open、locked、archived。' }, chunks)
  assert.equal(resolved?.chunk.id, 'chunk-a')
  assert.equal(resolved?.quote, '状态包括 `open`、`locked`、`archived`。')
  assert.equal(resolved?.strategy, 'asset_rebound_markdown_visible')
  assert.equal(resolved?.chunk.startChar! + resolved?.offset!, 102)

  const spanning = resolveEvidenceQuote({ assetVersionId: 'version-a', chunkId: 'chunk-c', quote: '状态为 open。人工可以确认。' }, [{
    id: 'chunk-c', assetVersionId: 'version-a', ordinal: 2, content: '- 状态为 `open`。\r\n- 人工可以确认。', contentHash: 'hash-c', headingPath: ['处置'], startChar: 300,
  }])
  assert.equal(spanning?.quote, '状态为 `open`。\r\n- 人工可以确认。')
})

test('Evidence 跨 Chunk 重定位存在多个不同原文位置时保持拒绝', () => {
  const chunks = [
    { id: 'chunk-a', assetVersionId: 'version-a', ordinal: 0, content: '相同需求文本。', contentHash: 'hash-a', headingPath: [], startChar: 0 },
    { id: 'chunk-b', assetVersionId: 'version-a', ordinal: 1, content: '相同需求文本。', contentHash: 'hash-b', headingPath: [], startChar: 100 },
  ]
  assert.equal(resolveEvidenceQuote({ assetVersionId: 'version-a', chunkId: 'missing', quote: '相同需求文本。' }, chunks), undefined)
})

test('普通文档正文在首轮直接进入上下文，模型无需逐 Chunk 读取', async () => {
  const store = await seededStore()
  const faux = fauxProvider()
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('requirement_points_submit_result', extractionDraft()), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('review_submit_result', reviewResult()), { stopReason: 'toolUse' }),
  ])
  const prompts: string[] = []
  const stream: StreamFn = (model, context, options) => {
    prompts.push(context.messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).join('\n'))
    return (faux.provider.streamSimple.bind(faux.provider) as StreamFn)(model, context, options)
  }
  const service = new RequirementAnalysisService(store, new PiAgentRuntimeAdapter(store, { model: faux.getModel() as Model<Api>, streamFn: stream }))
  const output = await service.analyze(request())

  assert.equal(output.status, 'candidate_validated')
  assert.equal(output.snapshot.extractionInput.mode, 'full_context')
  assert.match(prompts[0], /用户可以取消待支付订单。/u)
  assert.match(prompts[0], /订单超过十五分钟未支付时自动关闭。/u)
  assert.ok(!output.executions.requirementPointExtraction.events.some(event => event.toolId === 'knowledge_read_chunk'))
  assert.ok(output.executions.requirementPointExtraction.events.some(event => event.type === 'input_package_built'))
  assert.ok(output.executions.requirementPointExtraction.events.some(event => event.type === 'input_batch_delivered'))
})

test('服务端从固定 Chunk 规范化 Evidence 与覆盖，忽略模型对定位和覆盖的声明能力', async () => {
  const { output, store } = await successfulRun()
  const extraction = output.result as CandidateRequirementPointExtraction
  assert.deepEqual(extraction.evidence[0], {
    clientEvidenceId: 'E-001', sourceType: 'knowledge_chunk', sourceRef: { chunkId: 'chunk-1', assetVersionId: 'version-1' },
    quote: '用户可以取消待支付订单。', locator: { heading: '取消订单', start: 8, end: 20 },
  })
  assert.deepEqual(extraction.coverage.assets, [
    { assetVersionId: 'version-1', deliveredChunkIds: ['chunk-1'], excludedChunks: [] },
    { assetVersionId: 'version-2', deliveredChunkIds: ['chunk-2'], excludedChunks: [] },
  ])
  const saved = (await store.snapshot()).reviewRuns[0]
  assert.equal(saved.snapshot.extractionInput.batches[0].contentSha256.length, 64)
  assert.equal(saved.inputDeliveryManifest?.entries[0].contentSha256, saved.snapshot.extractionInput.batches[0].contentSha256)
  assert.deepEqual(saved.extractionResult, { requirementPoints: extraction.requirementPoints, evidence: extraction.evidence, coverage: extraction.coverage })
})

test('无效 Evidence 草稿会被服务端拒绝，批量校验工具可用于定向修复', async () => {
  const store = await seededStore()
  const invalid = extractionDraft()
  invalid.evidenceDrafts[0].quote = '伪造引用'
  const faux = fauxProvider()
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('requirement_points_submit_result', invalid), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('evidence_validate_batch', { items: extractionDraft().evidenceDrafts }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('requirement_points_submit_result', extractionDraft()), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('review_submit_result', reviewResult()), { stopReason: 'toolUse' }),
  ])
  const service = new RequirementAnalysisService(store, new PiAgentRuntimeAdapter(store, { model: faux.getModel() as Model<Api>, streamFn: faux.provider.streamSimple.bind(faux.provider) as StreamFn }))
  const output = await service.analyze(request())
  assert.equal(output.status, 'candidate_validated')
  assert.ok(output.executions.requirementPointExtraction.events.some(event => event.type === 'tool_execution_end' && event.toolId === 'requirement_points_submit_result' && JSON.stringify(event.toolResult).includes('validation_failed')))
  assert.ok(output.executions.requirementPointExtraction.events.some(event => event.toolId === 'evidence_validate_batch'))
})

test('输入投递清单缺批或哈希不一致时不能冻结结果', async () => {
  const { snapshot, store } = await snapshotForValidation()
  const validator = new RequirementPointExtractionValidator(store)
  const missing = deliveryManifest(snapshot)
  missing.entries = []
  const missingReport = await validator.normalizeV2(extractionDraft(), snapshot, missing)
  assert.equal(missingReport.report.valid, false)
  assert.ok(missingReport.report.issues.some(issue => issue.path.includes('inputDeliveryManifest.entries')))

  const forged = deliveryManifest(snapshot)
  forged.entries[0].contentSha256 = 'forged'
  const forgedReport = await validator.normalizeV2(extractionDraft(), snapshot, forged)
  assert.equal(forgedReport.report.valid, false)
  assert.ok(forgedReport.report.issues.some(issue => issue.message.includes('快照不一致')))
})

test('正式覆盖缺失固定 Chunk 时仍会被独立校验拒绝', async () => {
  const { output, snapshot, store } = await snapshotForValidation()
  const invalid = formalExtraction(output.result)
  invalid.coverage.assets[0].deliveredChunkIds = []
  const report = await new RequirementPointExtractionValidator(store).validate(invalid, snapshot)
  assert.equal(report.valid, false)
  assert.ok(report.issues.some(issue => issue.message.includes('投递覆盖不完整')))
})

test('需求点原子性、显式归并和阶段字段边界继续由服务端校验', async () => {
  const { output, snapshot, store } = await snapshotForValidation()
  const validator = new RequirementPointExtractionValidator(store)
  const invalid = formalExtraction(output.result)
  invalid.requirementPoints[0] = { ...invalid.requirementPoints[0], action: '', businessRules: [], acceptanceCriteria: [] }
  invalid.requirementPoints.push({ ...invalid.requirementPoints[1], clientRequirementPointId: 'RP-003' })
  const report = await validator.validate(invalid, snapshot)
  assert.equal(report.valid, false)
  assert.ok(report.issues.some(issue => issue.path.endsWith('.action')))
  assert.ok(report.issues.some(issue => issue.path.includes('mergeGroupId')))

  const forbidden = { ...extractionDraft(), coverage: { assets: [], limitations: [] } } as CandidateRequirementPointExtractionV2
  const draftReport = await validator.normalizeV2(forbidden, snapshot, deliveryManifest(snapshot))
  assert.equal(draftReport.report.valid, false)
  assert.ok(draftReport.report.issues.some(issue => issue.path === 'coverage'))
})

test('评审 Agent 只能引用冻结需求点，不能改写需求点或直接提交 Evidence', async () => {
  const { output, snapshot } = await snapshotForValidation()
  const extraction = output.result as CandidateRequirementPointExtraction
  const validator = new RequirementReviewValidator()
  const changed = await validator.validate({ ...reviewResult(), requirementPoints: [] } as CandidateRequirementReview, extraction, snapshot)
  assert.equal(changed.valid, false)
  const wrongRef = await validator.validate({ ...reviewResult(), findings: [{ ...reviewResult().findings[0], requirementPointRefs: ['RP-999'] }] }, extraction, snapshot)
  assert.equal(wrongRef.valid, false)
  const directEvidence = await validator.validate({ ...reviewResult(), findings: [{ ...reviewResult().findings[0], evidenceRefs: ['E-001'] }] } as CandidateRequirementReview, extraction, snapshot)
  assert.equal(directEvidence.valid, false)
})

test('超长正文确定性切换 segmented_context 并为每批生成哈希边界', () => {
  const definition = createRequirementPointExtractionAgentDefinition()
  const repeated = '订单状态变化后必须记录审计日志。'.repeat(180)
  const chunks = [0, 1, 2].map(index => ({ id: `chunk-${index}`, content: repeated, contentHash: `hash-${index}`, ordinal: index, headingPath: [`章节${index}`], tokenCount: 2000, startLine: index + 1, endLine: index + 1, startChar: index * repeated.length, endChar: (index + 1) * repeated.length, embedding: [], reused: false, chunkKey: `key-${index}`, assetVersionId: 'version-large' }))
  const plan = buildRequirementInputPlan({
    assets: [{ asset: { id: 'asset-large', displayName: '超长需求', logicalPath: 'requirements/large.md' }, version: { id: 'version-large', content: chunks.map(chunk => chunk.content).join('\n'), contentHash: 'large-hash', chunks } }],
    coveragePlan: [{ assetVersionId: 'version-large', chunks: chunks.map(chunk => ({ chunkId: chunk.id, contentHash: chunk.contentHash, headingPath: chunk.headingPath, startLine: chunk.startLine, endLine: chunk.endLine })) }],
    definition, contextWindow: 18_000, maxOutputTokens: 2_048,
  })
  assert.equal(plan.mode, 'segmented_context')
  assert.ok(plan.batches.length > 1)
  assert.deepEqual(plan.batches.flatMap(batch => batch.chunkIds), chunks.map(chunk => chunk.id))
  assert.ok(plan.batches.every(batch => /SMARTHUB_SEGMENTED_INPUT/u.test(batch.content)))
})

test('用户排除的 Chunk 不会混入 full_context 正文输入包', () => {
  const definition = createRequirementPointExtractionAgentDefinition()
  const chunks = [
    { id: 'included', content: '应当投递的订单规则。', contentHash: 'included-hash', ordinal: 0, headingPath: ['订单'], tokenCount: 10, startLine: 1, endLine: 1, startChar: 0, endChar: 10, embedding: [], reused: false, chunkKey: 'included', assetVersionId: 'version-scope' },
    { id: 'excluded', content: '禁止进入模型的排除内容。', contentHash: 'excluded-hash', ordinal: 1, headingPath: ['排除章节'], tokenCount: 10, startLine: 2, endLine: 2, startChar: 11, endChar: 22, embedding: [], reused: false, chunkKey: 'excluded', assetVersionId: 'version-scope' },
  ]
  const plan = buildRequirementInputPlan({
    assets: [{ asset: { id: 'asset-scope', displayName: '范围需求', logicalPath: 'requirements/scope.md' }, version: { id: 'version-scope', content: chunks.map(chunk => chunk.content).join('\n'), contentHash: 'scope-hash', chunks } }],
    coveragePlan: [{ assetVersionId: 'version-scope', chunks: [
      { chunkId: 'included', contentHash: 'included-hash', headingPath: ['订单'], startLine: 1, endLine: 1 },
      { chunkId: 'excluded', contentHash: 'excluded-hash', headingPath: ['排除章节'], startLine: 2, endLine: 2, excludedReason: '用户排除范围：排除章节' },
    ] }],
    definition, contextWindow: 32_768, maxOutputTokens: 4_096,
  })
  assert.equal(plan.mode, 'full_context')
  assert.match(plan.batches[0].content, /应当投递的订单规则/u)
  assert.doesNotMatch(plan.batches[0].content, /禁止进入模型的排除内容/u)
  assert.deepEqual(plan.batches[0].chunkIds, ['included'])
})

test('segmented_context 逐批隔离草稿后恢复提交工具并完成最终归并', async () => {
  const { snapshot, store } = await snapshotForValidation()
  const contents = ['第一批：用户可以取消待支付订单。', '第二批：订单超过十五分钟未支付时自动关闭。']
  const batches = contents.map((content, ordinal) => ({
    batchId: `input_batch_${ordinal + 1}`, ordinal, tokenCount: 32,
    assetVersionIds: [ordinal === 0 ? 'version-1' : 'version-2'], chunkIds: [ordinal === 0 ? 'chunk-1' : 'chunk-2'], content,
  }))
  const plan: RequirementInputPlan = { policyVersion: '1.0.0', mode: 'segmented_context', estimatedInputTokens: 64, safeInputBudget: 1_024, packageSha256: 'package-hash', batches }
  const extractionSnapshot: ReviewRunSnapshot = {
    ...snapshot,
    runId: 'segmented-runtime-test',
    agentDefinition: snapshot.agentDefinitions.requirementPointExtraction,
    extractionInput: {
      policyVersion: plan.policyVersion, mode: plan.mode, estimatedInputTokens: plan.estimatedInputTokens, safeInputBudget: plan.safeInputBudget, packageSha256: plan.packageSha256,
      batches: batches.map(batch => ({ ...batch, contentSha256: createHash('sha256').update(batch.content).digest('hex'), content: undefined })).map(({ content: _content, ...batch }) => batch),
    },
  }
  const faux = fauxProvider()
  faux.setResponses([
    fauxAssistantMessage('{"requirementPoints":["RP-001"],"evidenceDrafts":["E-001"]}'),
    fauxAssistantMessage('{"requirementPoints":["RP-002"],"evidenceDrafts":["E-002"]}'),
    fauxAssistantMessage(fauxToolCall('requirement_points_submit_result', extractionDraft()), { stopReason: 'toolUse' }),
  ])
  const output = await new PiAgentRuntimeAdapter(store, { model: faux.getModel() as Model<Api>, streamFn: faux.provider.streamSimple.bind(faux.provider) as StreamFn }).execute({
    snapshot: extractionSnapshot,
    requirementInputPlan: plan,
    model: { sourceId: 'source-1', providerType: 'openai_compatible', baseUrl: 'https://provider.example/v1', apiKey: 'secret', modelId: 'model-1', modelName: 'review-model', contextWindow: 32_768, maxOutputTokens: 4_096, supportsReasoning: false },
  }, new AbortController().signal)

  assert.equal(output.inputDeliveryManifest?.finalMergeCompleted, true)
  assert.equal(output.inputDeliveryManifest?.entries.length, 2)
  assert.ok(output.events.some(event => event.type === 'input_final_merge_started'))
  assert.deepEqual((output.candidate as CandidateRequirementPointExtraction).coverage.assets.map(asset => asset.deliveredChunkIds), [['chunk-1'], ['chunk-2']])
})

async function successfulRun() {
  const store = await seededStore()
  const faux = fauxProvider()
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('requirement_points_submit_result', extractionDraft()), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('review_submit_result', reviewResult()), { stopReason: 'toolUse' }),
  ])
  const service = new RequirementAnalysisService(store, new PiAgentRuntimeAdapter(store, { model: faux.getModel() as Model<Api>, streamFn: faux.provider.streamSimple.bind(faux.provider) as StreamFn }))
  const output = await service.analyze(request())
  return { output, store }
}

async function snapshotForValidation() {
  const value = await successfulRun()
  const snapshot = (await value.store.snapshot()).reviewRuns[0].snapshot
  return { ...value, snapshot }
}

function deliveryManifest(snapshot: ReviewRunSnapshot): InputDeliveryManifest {
  return {
    policyVersion: snapshot.extractionInput.policyVersion,
    mode: snapshot.extractionInput.mode,
    packageSha256: snapshot.extractionInput.packageSha256,
    finalMergeCompleted: true,
    entries: snapshot.extractionInput.batches.map((batch, index) => ({ ...structuredClone(batch), modelCallSequence: index + 1 })),
  }
}

function request() { return { projectVersionId: 'project-version-1', assetVersionIds: ['version-1', 'version-2'], sourceId: 'source-1', modelId: 'model-1' } }

function formalExtraction(value: CandidateRequirementPointExtraction) {
  return structuredClone({ requirementPoints: value.requirementPoints, evidence: value.evidence, coverage: value.coverage })
}

function extractionDraft(): CandidateRequirementPointExtractionV2 {
  return {
    requirementPoints: [
      { clientRequirementPointId: 'RP-001', title: '取消待支付订单', description: '用户可以取消处于待支付状态的订单。', actor: '用户', action: '取消', object: '待支付订单', conditions: ['订单处于待支付状态'], businessRules: [], exceptions: [], acceptanceCriteria: ['用户提交取消后订单不再待支付'], evidenceRefs: ['E-001'] },
      { clientRequirementPointId: 'RP-002', title: '支付超时关闭订单', description: '超过十五分钟未支付的订单会自动关闭。', actor: '系统', action: '关闭', object: '超时未支付订单', conditions: ['超过十五分钟未支付'], businessRules: ['超时自动关闭'], exceptions: [], acceptanceCriteria: ['超时订单状态为已关闭'], evidenceRefs: ['E-002'] },
    ],
    evidenceDrafts: [
      { clientEvidenceId: 'E-001', assetVersionId: 'version-1', chunkId: 'chunk-1', quote: '用户可以取消待支付订单。' },
      { clientEvidenceId: 'E-002', assetVersionId: 'version-2', chunkId: 'chunk-2', quote: '订单超过十五分钟未支付时自动关闭。' },
    ],
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
    state.versions.push({ id: 'version-1', assetId: 'asset-1', number: 1, content, contentHash: createHash('sha256').update(content).digest('hex'), status: 'ready', configVersionId: 'config-1', createdAt: '2026-07-23T00:00:00.000Z', readyAt: '2026-07-23T00:00:01.000Z', chunks: [chunk] })
    state.versions.push({ id: 'version-2', assetId: 'asset-2', number: 1, content: paymentContent, contentHash: createHash('sha256').update(paymentContent).digest('hex'), status: 'ready', configVersionId: 'config-1', createdAt: '2026-07-23T00:00:00.000Z', readyAt: '2026-07-23T00:00:01.000Z', chunks: [paymentChunk] })
    state.projectVersionRequirementBindings.push({ id: 'binding-1', projectVersionId: 'project-version-1', assetId: 'asset-1', assetVersionId: 'version-1', createdAt: '2026-07-23T00:00:01.000Z' })
    state.projectVersionRequirementBindings.push({ id: 'binding-2', projectVersionId: 'project-version-1', assetId: 'asset-2', assetVersionId: 'version-2', createdAt: '2026-07-23T00:00:01.000Z' })
    state.indexes.push({ id: 'index-1', knowledgeBaseId: 'kb-1', number: 1, status: 'active', assetVersionIds: ['version-1', 'version-2'], configVersionId: 'config-1', indexedChunks: [{ ...chunk, assetMetadata: { assetId: 'asset-1', displayName: '取消订单需求', assetType: 'requirement', sourceType: 'upload', logicalPath: 'requirements/cancel.md' } }, { ...paymentChunk, assetMetadata: { assetId: 'asset-2', displayName: '支付超时需求', assetType: 'requirement', sourceType: 'upload', logicalPath: 'requirements/payment.md' } }], createdAt: '2026-07-23T00:00:00.000Z', activatedAt: '2026-07-23T00:00:01.000Z' })
    state.modelSources.push({ id: 'source-1', name: '测试来源', providerType: 'openai_compatible', baseUrl: 'https://provider.example/v1', apiKey: 'secret', enabled: true, health: 'healthy', priority: 1, models: [{ id: 'model-1', name: 'review-model', displayName: 'Review Model', contextWindow: 32_768, maxOutputTokens: 4_096, capabilities: ['tool_calling', 'structured_output'], enabled: true, health: 'healthy' }], createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z' })
  })
  return store
}
