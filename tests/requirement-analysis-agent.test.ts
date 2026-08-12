import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { PiAgentRuntimeAdapter } from '../server/agent/pi-agent-runtime.js'
import { buildRequirementDirectoryInputPlan } from '../server/agent/requirement-context-assembler.js'
import { defaultAgentDefinitionResolver } from '../server/agent/dynamic-agent-definition-resolver.js'
import { RequirementAnalysisValidator } from '../server/agent/result-validator.js'
import { RequirementAnalysisService } from '../server/application/requirement-analysis-service.js'
import { AiResourceService } from '../server/application/ai-resource-service.js'
import type { AgentRuntime, InputDeliveryManifest, ReviewRunSnapshot } from '../server/domain/agent-types.js'
import type { CandidateRequirementAnalysisV1 } from '../server/domain/review-types.js'
import { defaultConfig } from '../server/domain/types.js'
import { JsonStore } from '../server/infrastructure/store.js'

const requirementDirectory = 'workspace/branches/V1.0/input/requirements'

test('RequirementAnalysisAgent 通过一个定义绑定 Workspace、Knowledge、Skill 和统一提交协议', () => {
  const definition = defaultAgentDefinitionResolver.resolve('requirement-analysis')
  assert.equal(definition.agentType, 'requirement_analysis')
  assert.equal(definition.resultSchemaVersion, 'requirement-analysis/v1')
  assert.deepEqual(definition.toolIds, [
    'workspace.read_file',
    'workspace.grep_files',
    'workspace.find_files',
    'workspace.list_directory',
    'knowledge.search',
    'knowledge.read_chunk',
    'requirement-analysis.submit_result',
  ])
  assert.deepEqual(definition.skillBindings.map(binding => binding.skillKey), ['system.requirement-analysis'])
  assert.match(definition.systemPrompt, /一次连续的 Pi Agent Session/u)
  assert.match(definition.systemPrompt, /Current Requirement/u)
  assert.match(definition.systemPrompt, /Knowledge Reference/u)
  assert.match(definition.systemPrompt, /Self Review/u)
  assert.match(definition.taskTemplate, /requirement_analysis_submit_result/u)
})

test('目录输入包只交付工作区元数据，不把原始需求拼接进 Prompt', async () => {
  const store = await seededStore()
  const state = await store.snapshot()
  const definition = defaultAgentDefinitionResolver.resolve('requirement-analysis')
  const assets = state.assets.map(asset => ({ asset, version: state.versions.find(version => version.id === asset.activeVersionId)! }))
  const plan = buildRequirementDirectoryInputPlan({
    workspacePath: requirementDirectory,
    workspaceRootPath: 'workspace',
    activeBranchPath: 'workspace/branches/V1.0',
    agentWorkspacePath: 'workspace/agent_workspace/requirement_analysis',
    assets,
    definition,
    contextWindow: 32_768,
    maxOutputTokens: 4_096,
  })
  assert.equal(plan.mode, 'agent_directory')
  assert.match(plan.batches[0].content, /SMARTHUB_PI_DOCUMENT_WORKSPACE_BEGIN/u)
  assert.match(plan.batches[0].content, /"fileCount":2/u)
  assert.doesNotMatch(plan.batches[0].content, /用户可以取消待支付订单/u)
  assert.doesNotMatch(plan.batches[0].content, /payment\.md/u)
})

test('一次需求分析只执行一次 Pi Runtime，并直接持久化统一结果与三份 Artifact', async () => {
  const { response, store, runtimeCalls } = await successfulRun()
  assert.equal(runtimeCalls(), 1)
  assert.equal(response.result.requirementPoints.length, 2)
  assert.equal(response.result.findings.length, 2)
  assert.deepEqual(response.result.findings[0].requirementPointRefs, ['RP-001', 'RP-002'])
  assert.deepEqual(response.result.findings[1].requirementPointRefs, [])
  assert.equal(response.result.testFocus.length, 2)
  assert.deepEqual(response.result.artifacts.map(item => item.fileName), [
    'requirement-baseline.md',
    'requirement-review.md',
    'requirement-analysis.md',
  ])
  response.result.artifacts.forEach(artifact => {
    assert.equal(artifact.contentSha256, createHash('sha256').update(artifact.content).digest('hex'))
  })
  assert.match(response.result.artifacts[2].content, /# 需求分析报告/u)
  assert.match(response.result.artifacts[2].content, /## 8\. Test Focus/u)

  const run = (await store.snapshot()).reviewRuns[0]
  assert.equal(run.status, 'succeeded')
  assert.equal(run.snapshot.agentDefinition.agentKey, 'requirement-analysis')
  assert.equal(run.executions?.requirementAnalysis?.agentKey, 'requirement-analysis')
  assert.deepEqual(Object.keys(run.executions ?? {}), ['requirementAnalysis'])
  assert.equal(run.execution?.agentKey, 'requirement-analysis')
  assert.equal('extractionResult' in run, false)
})

test('统一 Pi Session 可读取原始需求并主动查询 Knowledge，来源范围保留事实边界', async () => {
  const { response } = await successfulRun()
  const execution = response.executions.requirementAnalysis
  assert.ok(execution)
  const toolEvents = execution.events.filter(event => event.type === 'tool_execution_end')
  assert.ok(toolEvents.some(event => event.toolId === 'read'))
  assert.ok(toolEvents.some(event => event.toolId === 'knowledge_search'))
  assert.ok(toolEvents.some(event => event.toolId === 'knowledge_read_chunk'))
  assert.ok(toolEvents.some(event => event.toolId === 'requirement_analysis_submit_result'))
  const knowledgeResult = toolEvents.find(event => event.toolId === 'knowledge_search')?.toolResult
  assert.match(JSON.stringify(knowledgeResult), /current_requirement/u)
  assert.ok(response.inputDeliveryManifest.toolReads?.some(read => read.toolId === 'workspace.read_file'))
})

test('RequirementAnalysisValidator 支持跨需求与整体 Finding，并拒绝失效引用和重复临时 ID', async () => {
  const { store } = await successfulRun()
  const run = (await store.snapshot()).reviewRuns[0]
  const validator = new RequirementAnalysisValidator(store)
  const invalidReference = await validator.normalize({
    ...analysisCandidate(),
    findings: [{ analysis: '引用不存在。', requirementPointRefs: ['RP-999'] }],
  }, run.snapshot, run.inputDeliveryManifest!)
  assert.equal(invalidReference.report.valid, false)
  assert.ok(invalidReference.report.issues.some(issue => issue.path === 'findings[0].requirementPointRefs'))

  const duplicateId = await validator.normalize({
    ...analysisCandidate(),
    requirementPoints: analysisCandidate().requirementPoints.map(point => ({ ...point, id: 'RP-001' })),
  }, run.snapshot, run.inputDeliveryManifest!)
  assert.equal(duplicateId.report.valid, false)
  assert.ok(duplicateId.report.issues.some(issue => issue.path === 'requirementPoints[1].id'))
})

test('Validator 只做结构、引用、Evidence 与 Artifact 安全校验，不要求每个需求点产生 Finding', async () => {
  const { store } = await successfulRun()
  const run = (await store.snapshot()).reviewRuns[0]
  const validator = new RequirementAnalysisValidator(store)
  const candidate: CandidateRequirementAnalysisV1 = {
    ...analysisCandidate(),
    summary: { overview: '需求基线清晰。', overallAssessment: 'pass', score: 100, strengths: [], risks: [], businessGoals: [] },
    findings: [],
    testFocus: [],
  }
  const normalized = await validator.normalize(candidate, run.snapshot, run.inputDeliveryManifest!)
  assert.equal(normalized.report.valid, true)
  assert.deepEqual(normalized.result?.findings, [])
  assert.equal(normalized.result?.requirementPoints.length, 2)
})

test('服务恢复中断运行并将重试语义限定为完整单 Agent 重跑', async () => {
  const store = await seededStore()
  await store.transaction(state => {
    state.reviewRuns.push({
      id: 'review-run-interrupted', projectVersionId: 'project-version-1', assetId: 'asset-1', assetVersionId: 'version-1',
      documentTitle: '中断运行', documentVersion: 1, logicalPath: requirementDirectory, sourceId: 'source-1', modelId: 'model-1', modelLabel: '测试模型',
      status: 'running', step: 'analyzing_requirements', progress: 10, createdAt: '2026-08-12T00:00:00.000Z', startedAt: '2026-08-12T00:00:00.000Z',
      snapshot: {} as ReviewRunSnapshot,
    })
  })
  const service = new RequirementAnalysisService(store, { execute: async () => { throw new Error('不应执行') } })
  assert.equal(await service.recoverInterruptedRuns(), 1)
  const recovered = (await store.snapshot()).reviewRuns[0]
  assert.equal(recovered.status, 'failed')
  assert.match(recovered.error ?? '', /REVIEW_RUN_INTERRUPTED/u)
  await assert.rejects(() => service.retry(recovered.id, 'review_only' as never), /只支持全部重跑/u)
})

async function successfulRun() {
  const store = await seededStore()
  const resources = new AiResourceService(store, undefined, { reloadIntervalMs: 0 })
  await resources.initialize()
  const faux = fauxProvider()
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('read', { path: 'branches/V1.0/input/requirements/cancel.md' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('read', { path: 'branches/V1.0/input/requirements/payment.md' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('knowledge_search', { query: '取消' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('knowledge_read_chunk', { chunkId: 'chunk-1' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('requirement_analysis_submit_result', analysisCandidate()), { stopReason: 'toolUse' }),
  ])
  const pi = new PiAgentRuntimeAdapter(store, {
    model: faux.getModel() as Model<Api>,
    streamFn: faux.provider.streamSimple.bind(faux.provider) as StreamFn,
  })
  let calls = 0
  const runtime: AgentRuntime = {
    execute: async (input, signal) => {
      calls += 1
      return pi.execute(input, signal)
    },
  }
  const service = new RequirementAnalysisService(store, runtime)
  const response = await service.analyze({ projectVersionId: 'project-version-1', documentDirectoryPath: requirementDirectory, sourceId: 'source-1', modelId: 'model-1' })
  return { response, store, runtimeCalls: () => calls }
}

function analysisCandidate(): CandidateRequirementAnalysisV1 {
  return {
    summary: {
      overview: '订单取消与支付超时形成同一订单生命周期。',
      businessGoals: ['明确订单关闭路径'],
      overallAssessment: 'needs_revision',
      score: 72,
      strengths: ['主路径明确'],
      risks: ['关闭状态与异常闭环待确认'],
    },
    requirementPoints: [
      { id: 'RP-001', title: '取消待支付订单', description: '用户可以取消处于待支付状态的订单。', sourceTexts: ['用户可以取消待支付订单。'] },
      { id: 'RP-002', title: '超时关闭订单', description: '超过十五分钟未支付的订单会自动关闭。', sourceTexts: ['订单超过十五分钟未支付时自动关闭。'] },
    ],
    findings: [
      { title: '关闭状态口径需统一', type: 'conflict', severity: 'high', confidence: 0.91, requirementPointRefs: ['RP-001', 'RP-002'], analysis: '人工取消和超时关闭是否进入同一终态未说明。', impact: '状态机实现与统计口径可能不一致。', suggestion: '统一定义关闭原因、终态和后续操作。' },
      { title: '整体异常闭环缺失', type: 'missing', severity: 'medium', confidence: 0.84, requirementPointRefs: [], analysis: '需求整体没有定义关闭操作失败后的恢复与提示。', impact: '失败场景不可验收。', suggestion: '补充失败码、重试和人工恢复策略。' },
    ],
    testFocus: [
      { title: '取消与超时竞态', description: '验证取消请求和超时任务并发时只有一个终态生效。', requirementPointRefs: ['RP-001', 'RP-002'] },
      { title: '整体异常恢复', description: '验证关闭失败后的提示、重试与状态一致性。', requirementPointRefs: [] },
    ],
    analysisDocument: '订单以待支付为起点，可由用户取消或超时任务关闭；两个关闭路径的终态、竞态与失败恢复需要统一定义。',
  }
}

async function seededStore() {
  const store = new JsonStore(null)
  await store.load()
  const cancelContent = '# 取消订单\n\n用户可以取消待支付订单。'
  const paymentContent = '# 支付超时\n\n订单超过十五分钟未支付时自动关闭。'
  const cancelChunk = { id: 'chunk-1', chunkKey: 'cancel', assetVersionId: 'version-1', ordinal: 0, headingPath: ['取消订单'], content: '用户可以取消待支付订单。', contentHash: 'cancel-chunk-hash', tokenCount: 10, startLine: 3, endLine: 3, startChar: 8, endChar: 20, embedding: [], reused: false }
  const paymentChunk = { id: 'chunk-2', chunkKey: 'payment', assetVersionId: 'version-2', ordinal: 0, headingPath: ['支付超时'], content: '订单超过十五分钟未支付时自动关闭。', contentHash: 'payment-chunk-hash', tokenCount: 12, startLine: 3, endLine: 3, startChar: 8, endChar: 25, embedding: [], reused: false }
  await store.transaction(state => {
    state.projects.push({ id: 'project-1', name: '订单项目', createdAt: '2026-08-12T00:00:00.000Z' })
    state.projectVersions.push({ id: 'project-version-1', projectId: 'project-1', name: 'V1.0', status: 'open', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' })
    state.configs.push({ id: 'config-1', knowledgeBaseId: 'kb-1', version: 1, config: structuredClone(defaultConfig), createdAt: '2026-08-12T00:00:00.000Z', compatibilityFingerprint: 'config-hash', requiresRebuild: false })
    state.knowledgeBases.push({ id: 'kb-1', projectId: 'project-1', name: '项目知识库', createdAt: '2026-08-12T00:00:00.000Z', activeIndexVersionId: 'index-1', activeConfigVersionId: 'config-1' })
    state.assets.push(
      { id: 'asset-1', knowledgeBaseId: 'kb-1', displayName: '取消订单需求', logicalPath: `${requirementDirectory}/cancel.md`, assetType: 'requirement', sourceType: 'upload', sourceKey: 'cancel.md', activeVersionId: 'version-1', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' },
      { id: 'asset-2', knowledgeBaseId: 'kb-1', displayName: '支付超时需求', logicalPath: `${requirementDirectory}/payment.md`, assetType: 'requirement', sourceType: 'upload', sourceKey: 'payment.md', activeVersionId: 'version-2', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' },
    )
    state.versions.push(
      { id: 'version-1', assetId: 'asset-1', number: 1, content: cancelContent, contentHash: createHash('sha256').update(cancelContent).digest('hex'), status: 'ready', configVersionId: 'config-1', createdAt: '2026-08-12T00:00:00.000Z', readyAt: '2026-08-12T00:00:01.000Z', chunks: [cancelChunk] },
      { id: 'version-2', assetId: 'asset-2', number: 1, content: paymentContent, contentHash: createHash('sha256').update(paymentContent).digest('hex'), status: 'ready', configVersionId: 'config-1', createdAt: '2026-08-12T00:00:00.000Z', readyAt: '2026-08-12T00:00:01.000Z', chunks: [paymentChunk] },
    )
    state.projectVersionRequirementBindings.push(
      { id: 'binding-1', projectVersionId: 'project-version-1', assetId: 'asset-1', assetVersionId: 'version-1', createdAt: '2026-08-12T00:00:01.000Z' },
      { id: 'binding-2', projectVersionId: 'project-version-1', assetId: 'asset-2', assetVersionId: 'version-2', createdAt: '2026-08-12T00:00:01.000Z' },
    )
    state.indexes.push({ id: 'index-1', knowledgeBaseId: 'kb-1', number: 1, status: 'active', assetVersionIds: ['version-1', 'version-2'], configVersionId: 'config-1', indexedChunks: [
      { ...cancelChunk, assetMetadata: { assetId: 'asset-1', displayName: '取消订单需求', assetType: 'requirement', sourceType: 'upload', logicalPath: `${requirementDirectory}/cancel.md` } },
      { ...paymentChunk, assetMetadata: { assetId: 'asset-2', displayName: '支付超时需求', assetType: 'requirement', sourceType: 'upload', logicalPath: `${requirementDirectory}/payment.md` } },
    ], createdAt: '2026-08-12T00:00:00.000Z', activatedAt: '2026-08-12T00:00:01.000Z' })
    state.modelSources.push({ id: 'source-1', name: '测试来源', providerType: 'openai_compatible', baseUrl: 'https://provider.example/v1', apiKey: 'secret', enabled: true, health: 'healthy', priority: 1, models: [{ id: 'model-1', name: 'analysis-model', displayName: 'Analysis Model', contextWindow: 32_768, maxOutputTokens: 4_096, capabilities: ['tool_calling', 'structured_output'], enabled: true, health: 'healthy', qualityGate: { version: 'model-probe/v2', checkedAt: '2026-08-12T00:00:00.000Z', passed: true, sampleSha256: 'a'.repeat(64), inputCharacters: 8_000, checks: { connectivity: true, longContext: true, structuredSubmission: true, toolCalling: true } } }], createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' })
  })
  return store
}
