import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { TechnicalSolutionExtractionValidator, TechnicalSolutionResultValidator, TechnicalSolutionReviewValidatorV2 } from '../server/agent/technical-solution-result-validator.js'
import { AgentConfigurationService } from '../server/application/agent-configuration-service.js'
import { AiResourceService } from '../server/application/ai-resource-service.js'
import { TechnicalSolutionReviewService } from '../server/application/technical-solution-review-service.js'
import type { AgentRuntime, InputDeliveryManifest } from '../server/domain/agent-types.js'
import type { TechnicalSolutionExtractionResult, TechnicalSolutionExtractionSubmissionV1, TechnicalSolutionReviewCandidateV1, TechnicalSolutionReviewSubmissionV1, TechnicalSolutionReviewSubmissionV2, TechnicalSolutionRunSnapshot } from '../server/domain/technical-solution-types.js'
import { defaultConfig, type ReviewRun } from '../server/domain/types.js'
import { JsonStore } from '../server/infrastructure/store.js'
import { createTechnicalSolutionToolRegistry } from '../server/tools/technical-solution-tools.js'

const at = '2026-07-29T00:00:00.000Z'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

test('第三期固定输入、独立运行、Evidence、处置和报告形成完整闭环', async () => {
  const store = await seededStore()
  await new AiResourceService(store).list()
  const configurations = new AgentConfigurationService(store)
  const published = await publishTechnicalAgents(configurations)
  assert.equal(published.extraction.agentDefinition.agentKey, 'technical-solution-extraction')
  assert.equal(published.review.agentDefinition.agentKey, 'technical-solution-review')
  assert.equal(published.review.agentDefinition.modelScene, 'technical_solution_analysis')
  assert.deepEqual(published.extraction.agentDefinition.toolIds, ['knowledge.search', 'knowledge.read_chunk', 'technical_solution.input.read', 'technical_solution.evidence.preview', 'technical_solution_points.submit_result'])
  assert.deepEqual(published.review.agentDefinition.toolIds, ['technical_solution_review.submit_result'])

  const runtime: AgentRuntime = {
    execute: async input => {
      const snapshot = input.snapshot as TechnicalSolutionRunSnapshot
      if (snapshot.agentDefinition.agentKey === 'technical-solution-extraction') {
        const normalized = new TechnicalSolutionExtractionValidator().normalize(extractionCandidate(), snapshot, await store.snapshot())
        assert.equal(normalized.report.valid, true, JSON.stringify(normalized.report.issues))
        return { candidate: normalized.result!, events: [{ sequence: 1, type: 'agent_end', occurredAt: at, turn: 1 }], turns: 1, toolCalls: 1, toolErrors: 0, framework: { name: 'pi-agent-core', version: 'test' }, inputDeliveryManifest: manifest(snapshot) }
      }
      const normalized = new TechnicalSolutionReviewValidatorV2().normalize(reviewCandidate(), snapshot, input.fixedTechnicalSolutionExtraction!)
      assert.equal(normalized.report.valid, true, JSON.stringify(normalized.report.issues))
      return { candidate: normalized.result!, events: [{ sequence: 1, type: 'agent_end', occurredAt: at, turn: 1 }], turns: 1, toolCalls: 1, toolErrors: 0, framework: { name: 'pi-agent-core', version: 'test' } }
    },
  }
  Object.assign(store, { enqueueTechnicalSolutionJob: async () => undefined, cancelTechnicalSolutionJob: async () => undefined })
  const service = new TechnicalSolutionReviewService(store, runtime, configurations)
  const candidates = await service.inputCandidates('project-version-1')
  assert.deepEqual(candidates.baselines.map(item => item.id), ['requirement-run-1'])
  assert.deepEqual(candidates.solutionAssets.map(item => item.assetVersionId), ['tech-version-1'])
  assert.equal(candidates.agentConfigurations.extraction?.id, published.extraction.id)
  assert.equal(candidates.agentConfigurations.review?.id, published.review.id)

  const review = await service.createReview('project-version-1', { name: '订单技术方案评审', sourceReviewRunId: 'requirement-run-1', solutionAssetVersionIds: ['tech-version-1'], principal: { subjectId: 'reviewer-1', displayName: '评审人' } })
  const queued = await service.createRun('project-version-1', review.id)
  assert.equal(queued.status, 'queued')
  await service.processPreparedRun(queued.runId)
  const completed = await service.getRun('project-version-1', review.id, queued.runId)
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.extractionResult?.solutionPoints[0].id, 'TSP-001')
  assert.ok(completed.executions?.technicalSolutionExtraction)
  assert.ok(completed.executions?.technicalSolutionReview)
  assert.equal(completed.result?.statistics.coverageRatio, 0.5)
  assert.equal(completed.result?.coverage[0].requirementPointId, 'RP-001')
  assert.deepEqual(new Set(completed.result?.evidence.map(item => item.sourceKind)), new Set(['requirement', 'technical_design']))
  assert.ok(completed.result?.evidence.every(item => item.id.startsWith('tech_evidence_') || item.id.startsWith('tech_requirement_evidence_')))

  const finding = completed.result!.findings[0]
  const action = await service.actOnFinding('project-version-1', review.id, queued.runId, finding.id, { action: 'confirm', expectedVersion: 0, comment: '确认补充接口幂等与异常处理。', principal: { subjectId: 'lead-1', displayName: '技术负责人' } })
  assert.equal(action.toState, 'confirmed')
  await assert.rejects(() => service.actOnFinding('project-version-1', review.id, queued.runId, finding.id, { action: 'resolve', expectedVersion: 0 }), /VERSION_CONFLICT/u)
  const states = await service.listFindingActions('project-version-1', review.id, queued.runId)
  assert.deepEqual(states.findings, [{ findingId: finding.id, state: 'confirmed', version: 1 }])

  const report = await service.exportMarkdown('project-version-1', review.id, queued.runId)
  assert.match(report, /技术方案评审报告/u)
  assert.match(report, /确认补充接口幂等与异常处理/u)
  assert.match(report, new RegExp(queued.runId, 'u'))
  assert.doesNotMatch(report, /secret-key|provider\.example/u)

  const second = await service.createRun('project-version-1', review.id)
  assert.notEqual(second.runId, queued.runId)
  const cancelled = await service.cancelRun('project-version-1', review.id, second.runId)
  assert.equal(cancelled.status, 'cancelled')
})

test('服务端拒绝歧义 Evidence 和缺失的需求覆盖结论', async () => {
  const store = await seededStore()
  const state = await store.snapshot()
  const snapshot = technicalSnapshot(state.reviewRuns[0])
  state.versions.find(item => item.id === 'tech-version-1')!.content += '\n接口层负责订单提交。'
  state.versions.find(item => item.id === 'tech-version-1')!.chunks.push({ ...state.versions.find(item => item.id === 'tech-version-1')!.chunks[0], id: 'tech-chunk-2', chunkKey: 'tech-2' })
  const invalid = candidate()
  invalid.coverageCandidates = []
  invalid.findings[0].solutionSourceTexts = ['接口层负责订单提交。']
  const normalized = new TechnicalSolutionResultValidator().normalize(invalid, snapshot, state)
  assert.equal(normalized.report.valid, false)
  assert.ok(normalized.report.issues.some(item => /恰好有一条覆盖结论/u.test(item.message)))
  assert.ok(normalized.report.issues.some(item => /歧义/u.test(item.message)))
})

test('技术方案完整原文跨相邻 Chunk 时按真实边界生成多个 Evidence', async () => {
  const store = await seededStore()
  const state = await store.snapshot()
  const version = state.versions.find(item => item.id === 'tech-version-1')!
  const start = version.content.indexOf('订单服务暴露创建订单接口。')
  const split = start + '订单服务暴露创建'.length
  version.chunks = [start, split, version.content.length].slice(0, -1).map((_, index, boundaries) => {
    const rangeStart = boundaries[index]
    const rangeEnd = index === boundaries.length - 1 ? version.content.length : boundaries[index + 1]
    const content = version.content.slice(rangeStart, rangeEnd)
    return { ...version.chunks[0], id: `tech-cross-${index}`, chunkKey: `tech-cross-${index}`, ordinal: index, content, contentHash: hash(content), startChar: rangeStart + 3, endChar: rangeEnd + 3 }
  })
  const normalized = new TechnicalSolutionResultValidator().normalize(candidate(), technicalSnapshot(state.reviewRuns[0]), state)
  assert.equal(normalized.report.valid, true, JSON.stringify(normalized.report.issues))
  const solutionEvidence = normalized.result?.evidence.filter(item => item.sourceKind === 'technical_design') ?? []
  assert.equal(solutionEvidence.length, 2)
  assert.deepEqual(solutionEvidence.map(item => item.quote), ['订单服务暴露创建', '订单接口。'])
  assert.ok(solutionEvidence.every(item => version.content.includes(item.quote)))
  assert.equal(normalized.result?.coverage[0].evidenceIds.length, 3)
})

test('技术方案提交近义枚举和带章节前缀的原文线索由服务端确定性归一化', async () => {
  const store = await seededStore()
  const state = await store.snapshot()
  const snapshot = technicalSnapshot(state.reviewRuns[0])
  const input = candidate() as unknown as TechnicalSolutionReviewSubmissionV1
  input.summary.overallAssessment = 'passed_with_findings'
  input.coverageCandidates[0].status = 'partial'
  input.coverageCandidates[0].requirementSourceTexts = ['订单提交幂等', '描述：订单提交必须支持幂等处理。', '需求原文：订单提交必须支持幂等处理。']
  input.coverageCandidates[0].solutionSourceTexts = ['5.2 接口设计... 订单服务暴露创建订单接口。']
  input.findings[0].type = 'logic_gap'
  input.findings[0].severity = 'moderate'
  input.findings[0].requirementSourceTexts = ['需求原文：订单提交必须支持幂等处理。']
  input.findings[0].solutionSourceTexts = ['接口章节... 订单服务暴露创建订单接口。']
  input.risks[0].requirementSourceTexts = ['描述：客户端重试需要关注重复订单风险。']

  const normalized = new TechnicalSolutionResultValidator().normalize(input, snapshot, state)
  assert.equal(normalized.report.valid, true, JSON.stringify(normalized.report.issues))
  assert.equal(normalized.result?.summary.overallAssessment, 'pass_with_notes')
  assert.equal(normalized.result?.coverage[0].status, 'partially_covered')
  assert.equal(normalized.result?.findings[0].type, 'architecture_gap')
  assert.equal(normalized.result?.findings[0].severity, 'medium')
  assert.ok(normalized.result?.risks[0].evidenceIds.length)
  assert.ok(normalized.result?.evidence.some(item => item.quote === '订单服务暴露创建订单接口。'))
  assert.ok(normalized.result?.evidence.every(item => !item.quote.includes('...')))
})

test('技术方案提交工具把模型语义枚举交给服务端归一化', async () => {
  const store = await seededStore()
  const registry = createTechnicalSolutionToolRegistry(store, async () => ({ accepted: true }))
  const descriptor = registry.get('technical_solution_review.submit_result')?.descriptor
  assert.ok(descriptor)
  const schema = descriptor.parameters as unknown as { properties: { summary: { properties: { overallAssessment: { type: string; description: string } } }; findings: { items: { properties: { type: { type: string }; severity: { type: string } } } } } }
  assert.equal(schema.properties.summary.properties.overallAssessment.type, 'string')
  assert.match(schema.properties.summary.properties.overallAssessment.description, /服务端确定性归一化/u)
  assert.equal(schema.properties.findings.items.properties.type.type, 'string')
  assert.equal(schema.properties.findings.items.properties.severity.type, 'string')
})

test('技术方案评审 v2 只能引用冻结需求点和冻结方案要点', async () => {
  const store = await seededStore()
  const state = await store.snapshot()
  const snapshot = technicalSnapshot(state.reviewRuns[0])
  const extraction = new TechnicalSolutionExtractionValidator().normalize(extractionCandidate(), snapshot, state).result!
  const invalid = reviewCandidate()
  invalid.coverage[0].solutionPointRefs = ['TSP-999']
  invalid.findings[0].requirementPointRefs = ['RP-999']
  const normalized = new TechnicalSolutionReviewValidatorV2().normalize(invalid, snapshot, extraction)
  assert.equal(normalized.report.valid, false)
  assert.ok(normalized.report.issues.some(item => /TSP-999/u.test(item.message)))
  assert.ok(normalized.report.issues.some(item => /RP-999/u.test(item.message)))
})

test('Agent 未提交技术方案结果时保留真实失败阶段且不发布正式结果', async () => {
  const store = await seededStore()
  await new AiResourceService(store).list()
  const configurations = new AgentConfigurationService(store)
  await publishTechnicalAgents(configurations)
  const runtime: AgentRuntime = { execute: async () => {
    throw new Error('MODEL_TOOL_CALL_REQUIRED: 模型未调用 technical_solution_review_submit_result')
  } }
  Object.assign(store, { enqueueTechnicalSolutionJob: async () => undefined })
  const service = new TechnicalSolutionReviewService(store, runtime, configurations)
  const review = await service.createReview('project-version-1', { name: '失败阶段测试', sourceReviewRunId: 'requirement-run-1', solutionAssetVersionIds: ['tech-version-1'] })
  const run = await service.createRun('project-version-1', review.id)
  await assert.rejects(() => service.processPreparedRun(run.runId), /MODEL_TOOL_CALL_REQUIRED/u)
  const failed = await service.getRun('project-version-1', review.id, run.runId)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.failedAtStep, 'extracting_solution_points')
  assert.equal(failed.step, 'failed')
  assert.equal(failed.result, undefined)
  assert.match(failed.error ?? '', /MODEL_TOOL_CALL_REQUIRED/u)
  assert.ok(failed.execution)
})

test('Provider 暂时失败后按已发布路由切换候选模型并保留同一 Run', async () => {
  const store = await seededStore()
  await store.transaction(state => { state.modelSources[0].models.push({ ...structuredClone(state.modelSources[0].models[0]), id: 'model-2', name: 'fallback-model', displayName: '回退模型' }) })
  await new AiResourceService(store).list()
  const configurations = new AgentConfigurationService(store)
  await publishTechnicalAgents(configurations, true)
  const runtime: AgentRuntime = { execute: async input => {
    if (input.model.modelId === 'model-1') throw new Error('MODEL_PROVIDER_UNAVAILABLE: 临时不可用')
    const snapshot = input.snapshot as TechnicalSolutionRunSnapshot
    if (snapshot.agentDefinition.agentKey === 'technical-solution-extraction') {
      const normalized = new TechnicalSolutionExtractionValidator().normalize(extractionCandidate(), snapshot, await store.snapshot())
      return { candidate: normalized.result!, events: [], turns: 1, toolCalls: 1, toolErrors: 0, framework: { name: 'pi-agent-core', version: 'test' }, inputDeliveryManifest: manifest(snapshot) }
    }
    const normalized = new TechnicalSolutionReviewValidatorV2().normalize(reviewCandidate(), snapshot, input.fixedTechnicalSolutionExtraction!)
    return { candidate: normalized.result!, events: [], turns: 1, toolCalls: 1, toolErrors: 0, framework: { name: 'pi-agent-core', version: 'test' } }
  } }
  Object.assign(store, { enqueueTechnicalSolutionJob: async () => undefined })
  const service = new TechnicalSolutionReviewService(store, runtime, configurations)
  const review = await service.createReview('project-version-1', { name: '降级评审', sourceReviewRunId: 'requirement-run-1', solutionAssetVersionIds: ['tech-version-1'] })
  const run = await service.createRun('project-version-1', review.id)
  await assert.rejects(() => service.processPreparedRun(run.runId, undefined, new AbortController().signal, 1), /MODEL_PROVIDER_UNAVAILABLE/u)
  await service.processPreparedRun(run.runId, undefined, new AbortController().signal, 2)
  const completed = await service.getRun('project-version-1', review.id, run.runId)
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.modelLabel, '测试来源 · 回退模型 / 测试来源 · 回退模型')
  assert.deepEqual(completed.modelRouteAttempts?.map(item => [item.modelId, item.status]), [['model-1', 'failed'], ['model-2', 'succeeded']])
  assert.equal(completed.degradations?.[0].toModelId, 'model-2')
})

async function publishTechnicalAgents(configurations: AgentConfigurationService, withFallback = false) {
  const agents = (await configurations.get()).agents
  const routing = (draft: typeof agents.technicalSolutionExtraction.draft) => ({ ...draft.routing, primaryModel: { sourceId: 'source-1', modelId: 'model-1' }, fallbackEnabled: withFallback, fallbackModels: withFallback ? [{ sourceId: 'source-1', modelId: 'model-2' }] : [], maxOutputTokens: 4_096 })
  const extractionSaved = await configurations.save({ agentKey: 'technicalSolutionExtraction', revision: agents.technicalSolutionExtraction.draft.revision, routing: routing(agents.technicalSolutionExtraction.draft), definition: agents.technicalSolutionExtraction.draft.definition })
  const extraction = await configurations.publish({ agentKey: 'technicalSolutionExtraction', revision: extractionSaved.revision, publishedBy: '技术负责人' })
  const reviewSaved = await configurations.save({ agentKey: 'technicalSolutionReview', revision: agents.technicalSolutionReview.draft.revision, routing: routing(agents.technicalSolutionReview.draft), definition: agents.technicalSolutionReview.draft.definition })
  const review = await configurations.publish({ agentKey: 'technicalSolutionReview', revision: reviewSaved.revision, publishedBy: '技术负责人' })
  return { extraction, review }
}

function extractionCandidate(): TechnicalSolutionExtractionSubmissionV1 {
  return { schemaVersion: 'technical-solution-extraction/v1', solutionPoints: [{ title: '创建订单接口', description: '订单服务暴露创建订单接口。', sourceTexts: ['订单服务暴露创建订单接口。'] }] }
}

function reviewCandidate(): TechnicalSolutionReviewSubmissionV2 {
  return {
    schemaVersion: 'technical-solution-review/v2',
    summary: { overallAssessment: 'needs_revision', overview: '方案覆盖主流程，但接口幂等和异常响应仍需补充。', majorGaps: ['幂等约束未落到接口'], majorRisks: ['重复提交'], recommendedOrder: ['先补接口契约'] },
    coverage: [{ requirementPointRef: 'RP-001', status: 'partially_covered', analysis: '已描述订单接口，但没有明确幂等键和重复请求语义。', solutionPointRefs: ['TSP-001'] }],
    findings: [{ type: 'interface_gap', severity: 'high', title: '接口幂等契约缺失', problem: '创建订单接口未说明幂等键。', impact: '重试可能生成重复订单。', recommendation: '定义幂等键、冲突响应与保存周期。', confidence: 0.96, requirementPointRefs: ['RP-001'], solutionPointRefs: ['TSP-001'] }],
    risks: [{ description: '客户端超时重试造成重复下单。', impact: '产生重复交易。', mitigation: '持久化幂等键并返回首次结果。', requirementPointRefs: ['RP-001'], solutionPointRefs: ['TSP-001'] }],
    questions: [{ question: '幂等键保存多长时间？', reason: '决定重复请求的判定窗口。', requirementPointRefs: ['RP-001'], solutionPointRefs: [] }],
  }
}

function candidate(): TechnicalSolutionReviewCandidateV1 {
  return {
    schemaVersion: 'technical-solution-review/v1',
    summary: { overallAssessment: 'needs_revision', overview: '方案覆盖主流程，但接口幂等和异常响应仍需补充。', majorGaps: ['幂等约束未落到接口'], majorRisks: ['重复提交'], recommendedOrder: ['先补接口契约'] },
    coverageCandidates: [{ requirementSourceTexts: ['订单提交必须支持幂等处理。'], status: 'partially_covered', analysis: '已描述订单接口，但没有明确幂等键和重复请求语义。', solutionSourceTexts: ['订单服务暴露创建订单接口。'] }],
    findings: [{ type: 'interface_gap', severity: 'high', title: '接口幂等契约缺失', problem: '创建订单接口未说明幂等键。', impact: '重试可能生成重复订单。', recommendation: '定义幂等键、冲突响应与保存周期。', confidence: 0.96, requirementSourceTexts: ['订单提交必须支持幂等处理。'], solutionSourceTexts: ['订单服务暴露创建订单接口。'] }],
    risks: [{ description: '客户端超时重试造成重复下单。', impact: '产生重复交易。', mitigation: '持久化幂等键并返回首次结果。', requirementSourceTexts: ['订单提交必须支持幂等处理。'], solutionSourceTexts: ['订单服务暴露创建订单接口。'] }],
    questions: [{ question: '幂等键保存多长时间？', reason: '决定重复请求的判定窗口。', requirementSourceTexts: ['订单提交必须支持幂等处理。'], solutionSourceTexts: [] }],
  }
}

function manifest(snapshot: TechnicalSolutionRunSnapshot): InputDeliveryManifest {
  return { policyVersion: snapshot.inputPlan.policyVersion, mode: snapshot.inputPlan.mode, packageSha256: snapshot.inputPlan.packageSha256, finalMergeCompleted: true, entries: snapshot.inputPlan.batches.map((batch, index) => ({ batchId: batch.batchId, ordinal: batch.ordinal, assetVersionIds: [...batch.assetVersionIds], chunkIds: [...batch.chunkIds], contentSha256: hash(batch.content), tokenCount: batch.tokenCount, modelCallSequence: index + 1 })) }
}

function technicalSnapshot(run: ReviewRun): TechnicalSolutionRunSnapshot {
  return {
    schemaVersion: 'technical-solution-run-snapshot/v1', runId: 'technical-run-test', technicalReviewId: 'technical-review-test', projectId: 'project-1', projectName: 'SmartHub', projectVersionId: 'project-version-1', projectVersionName: 'V3.0', knowledgeBaseId: 'kb-1',
    requirementBaseline: { sourceReviewRunId: run.id, sourceResultSha256: 'a'.repeat(64), snapshotSha256: 'b'.repeat(64), requirementPoints: [{ id: 'RP-001', title: '订单提交幂等', description: '订单提交必须支持幂等处理。', evidenceIds: ['E-001'] }], evidence: [{ evidenceId: 'E-001', requirementPointId: 'RP-001', assetId: 'requirement-asset-1', assetVersionId: 'requirement-version-1', chunkId: 'requirement-chunk-1', contentSha256: hash('# 订单需求\n\n订单提交必须支持幂等处理。'), headingPath: ['订单需求'], quote: '订单提交必须支持幂等处理。', startLine: 3, endLine: 3 }], findings: [] },
    solutionInputs: [{ assetId: 'tech-asset-1', assetVersionId: 'tech-version-1', assetType: 'technical_design', displayName: '订单技术方案', logicalPath: 'design/order.md', contentSha256: hash('# 订单服务\n\n订单服务暴露创建订单接口。') }], assets: [], indexVersionId: 'index-1',
    modelRef: { sourceId: 'source-1', providerType: 'openai_compatible', modelId: 'model-1', modelName: 'model', contextWindow: 32_768, maxOutputTokens: 4_096, supportsReasoning: false },
    agentDefinition: { agentKey: 'technical-solution-analysis', agentType: 'technical_solution_analysis', version: '1', status: 'published', modelScene: 'technical_solution_analysis', resultSchemaVersion: 'technical-solution-review/v1', systemPrompt: '', taskTemplate: '', promptRef: { promptKey: 'technical', version: '1', contentSha256: 'c'.repeat(64) }, toolsetVersion: '1', toolsetContentSha256: 'd'.repeat(64), skillBindings: [], mcpBindings: [], toolIds: ['technical_solution_review.submit_result'], limits: { maxTurns: 8, maxToolCalls: 16, deadlineMs: 60_000, toolTimeoutMs: 10_000, maxCandidateBytes: 100_000, maxFindings: 50, maxRepeatedToolCall: 2 }, contentSha256: 'e'.repeat(64) },
    inputPlan: { policyVersion: 'technical-solution-input/v1', mode: 'full_context', estimatedInputTokens: 20, safeInputBudget: 10_000, packageSha256: 'f'.repeat(64), batches: [] }, createdAt: at,
  }
}

async function seededStore() {
  const store = new JsonStore(null)
  await store.load()
  const requirementContent = '# 订单需求\n\n订单提交必须支持幂等处理。'
  const technicalContent = '# 订单服务\n\n订单服务暴露创建订单接口。'
  const requirementChunk = { id: 'requirement-chunk-1', chunkKey: 'requirement-1', assetVersionId: 'requirement-version-1', ordinal: 0, headingPath: ['订单需求'], content: '订单提交必须支持幂等处理。', contentHash: hash('订单提交必须支持幂等处理。'), tokenCount: 12, startLine: 3, endLine: 3, startChar: 8, endChar: 21, embedding: [], reused: false }
  const technicalChunk = { id: 'tech-chunk-1', chunkKey: 'tech-1', assetVersionId: 'tech-version-1', ordinal: 0, headingPath: ['订单服务'], content: '订单服务暴露创建订单接口。', contentHash: hash('订单服务暴露创建订单接口。'), tokenCount: 12, startLine: 3, endLine: 3, startChar: 8, endChar: 21, embedding: [], reused: false }
  await store.transaction(state => {
    state.projects.push({ id: 'project-1', name: 'SmartHub', createdAt: at })
    state.projectVersions.push({ id: 'project-version-1', projectId: 'project-1', name: 'V3.0', status: 'open', createdAt: at, updatedAt: at })
    state.configs.push({ id: 'config-1', knowledgeBaseId: 'kb-1', version: 1, config: structuredClone(defaultConfig), createdAt: at, compatibilityFingerprint: 'config', requiresRebuild: false })
    state.knowledgeBases.push({ id: 'kb-1', projectId: 'project-1', name: '项目知识库', createdAt: at, activeIndexVersionId: 'index-1', activeConfigVersionId: 'config-1' })
    state.assets.push({ id: 'requirement-asset-1', knowledgeBaseId: 'kb-1', displayName: '订单需求', logicalPath: 'requirements/order.md', assetType: 'requirement', sourceType: 'upload', sourceKey: 'order-requirement', activeVersionId: 'requirement-version-1', createdAt: at, updatedAt: at })
    state.assets.push({ id: 'tech-asset-1', knowledgeBaseId: 'kb-1', displayName: '订单技术方案', logicalPath: 'design/order.md', assetType: 'technical_design', sourceType: 'upload', sourceKey: 'order-design', activeVersionId: 'tech-version-1', createdAt: at, updatedAt: at })
    state.versions.push({ id: 'requirement-version-1', assetId: 'requirement-asset-1', number: 1, content: requirementContent, contentHash: hash(requirementContent), status: 'ready', configVersionId: 'config-1', createdAt: at, readyAt: at, chunks: [requirementChunk] })
    state.versions.push({ id: 'tech-version-1', assetId: 'tech-asset-1', number: 1, content: technicalContent, contentHash: hash(technicalContent), status: 'ready', configVersionId: 'config-1', createdAt: at, readyAt: at, chunks: [technicalChunk] })
    state.indexes.push({ id: 'index-1', knowledgeBaseId: 'kb-1', number: 1, status: 'active', assetVersionIds: ['requirement-version-1', 'tech-version-1'], configVersionId: 'config-1', indexedChunks: [], createdAt: at, activatedAt: at })
    state.modelSources.push({ id: 'source-1', name: '测试来源', providerType: 'openai_compatible', baseUrl: 'https://provider.example/v1', apiKey: 'secret-key', enabled: true, health: 'healthy', priority: 1, models: [{ id: 'model-1', name: 'model', displayName: '测试模型', contextWindow: 32_768, maxOutputTokens: 4_096, capabilities: ['tool_calling', 'structured_output'], enabled: true, health: 'healthy', qualityGate: { version: 'model-probe/v2', checkedAt: at, passed: true, sampleSha256: 'a'.repeat(64), inputCharacters: 8_000, checks: { connectivity: true, longContext: true, structuredSubmission: true, toolCalling: true } } }], createdAt: at, updatedAt: at })
    const baseline = { id: 'requirement-run-1', reviewId: 'requirement-review-1', projectVersionId: 'project-version-1', assetId: 'requirement-asset-1', assetVersionId: 'requirement-version-1', documentTitle: '订单需求', documentVersion: 1, logicalPath: 'requirements/order.md', sourceId: 'source-1', modelId: 'model-1', modelLabel: '测试模型', status: 'succeeded', step: 'succeeded', progress: 100, createdAt: at, startedAt: at, finishedAt: at, snapshot: { assets: [{ assetId: 'requirement-asset-1', assetVersionId: 'requirement-version-1', assetContentHash: hash(requirementContent), logicalPath: 'requirements/order.md', displayName: '订单需求' }] }, result: { requirementPoints: [{ clientRequirementPointId: 'RP-001', title: '订单提交幂等', description: '订单提交必须支持幂等处理。', actor: '用户', action: '提交', object: '订单', conditions: [], businessRules: ['幂等'], exceptions: [], acceptanceCriteria: ['重复提交只生成一个订单'], evidenceRefs: ['E-001'] }], evidence: [{ clientEvidenceId: 'E-001', sourceType: 'knowledge_chunk', sourceRef: { chunkId: 'requirement-chunk-1', assetVersionId: 'requirement-version-1' }, quote: '订单提交必须支持幂等处理。', locator: { heading: '订单需求', start: 3, end: 3 } }], coverage: { assets: [{ assetVersionId: 'requirement-version-1', deliveredChunkIds: ['requirement-chunk-1'], excludedChunks: [] }], limitations: [] }, summary: { overallAssessment: 'pass', score: 90, strengths: ['目标明确'], risks: [] }, findings: [] } } as ReviewRun
    state.reviewRuns.push(baseline)
  })
  return store
}
