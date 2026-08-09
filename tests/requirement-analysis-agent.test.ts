import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { PiAgentRuntimeAdapter } from '../server/agent/pi-agent-runtime.js'
import { PiReviewQaRuntimeAdapter } from '../server/agent/pi-review-qa-runtime.js'
import { resolveEvidenceQuote, resolveEvidenceSourceText, searchEvidenceCandidates } from '../server/agent/evidence-locator.js'
import { buildRequirementInputPlan } from '../server/agent/requirement-context-assembler.js'
import { defaultAgentDefinitionResolver, DynamicAgentDefinitionResolver } from '../server/agent/dynamic-agent-definition-resolver.js'
import { defaultAgentDefinitionConfigDictionary, REQUIREMENT_POINT_EXTRACTION_AGENT_VERSION, REQUIREMENT_REVIEW_AGENT_VERSION } from '../server/agent/agent-definition-config.js'
import { RequirementPointExtractionValidator, RequirementReviewValidator } from '../server/agent/result-validator.js'
import { RequirementAnalysisService } from '../server/application/requirement-analysis-service.js'
import { AgentConfigurationService } from '../server/application/agent-configuration-service.js'
import { AiResourceService } from '../server/application/ai-resource-service.js'
import { ReviewQaService } from '../server/application/review-qa-service.js'
import type { AgentRuntime, InputDeliveryManifest, RequirementInputPlan, ReviewRunSnapshot } from '../server/domain/agent-types.js'
import type { ReviewQaExecutionInput, ReviewQaRuntime } from '../server/domain/review-qa-types.js'
import type { CandidateRequirementPointExtraction, CandidateRequirementPointExtractionV4, CandidateRequirementPointExtractionV5, CandidateRequirementReview, CandidateRequirementReviewV3 } from '../server/domain/review-types.js'
import { defaultConfig, type ReviewRun } from '../server/domain/types.js'
import { JsonStore, type StateStore } from '../server/infrastructure/store.js'

test('提取 Agent v5 生成可选标题并提交描述与原文线索，其余字段由服务端生成', () => {
  const definition = defaultAgentDefinitionResolver.resolve('requirement-point-extraction')
  assert.equal(REQUIREMENT_POINT_EXTRACTION_AGENT_VERSION, '7.1.0')
  assert.equal(definition.resultSchemaVersion, 'requirement-point-extraction/v5')
  assert.match(definition.systemPrompt, /正文会以 full_context 一次完整投递/u)
  assert.match(definition.systemPrompt, /正常应提交 title、description 和 sourceTexts/u)
  assert.match(definition.systemPrompt, /title 是容错可选字段/u)
  assert.match(definition.systemPrompt, /置信区间内保留全部证据位置/u)
  assert.match(definition.systemPrompt, /sourceTexts/u)
  assert.match(definition.systemPrompt, /不要提交 actor、action、object/u)
  assert.deepEqual(definition.toolIds, ['knowledge.search', 'knowledge.read_chunk', 'requirement-points.submit_result'])
  assert.equal(definition.limits.reasoningEffort, 'medium')
})

test('评审 Agent v3 只强制分析内容对应冻结需求点，展示与摘要字段由模型给出', () => {
  const definition = defaultAgentDefinitionResolver.resolve('requirement-review')
  assert.equal(REQUIREMENT_REVIEW_AGENT_VERSION, '4.0.0')
  assert.equal(definition.resultSchemaVersion, 'requirement-review/v3')
  assert.match(definition.systemPrompt, /每条分析必须通过 requirementPointRef/u)
  assert.match(definition.systemPrompt, /title、type、severity、confidence、analysis、impact 和 recommendation/u)
  assert.match(definition.systemPrompt, /Finding ID 和正式引用结构由 SmartHub 生成/u)
  assert.deepEqual(definition.toolIds, ['review.submit_result'])
})

test('动态 Resolver 从配置字典构建定义并兼容历史技术方案 key', () => {
  const config = structuredClone(defaultAgentDefinitionConfigDictionary)
  config['requirement-review'].systemPrompt = '动态 Prompt'
  config['requirement-review'].taskTemplate = '动态 Template'
  config['requirement-review'].version = '9.0.0'
  const resolver = new DynamicAgentDefinitionResolver(config)
  const definition = resolver.resolve('requirement-review')
  assert.equal(definition.systemPrompt, '动态 Prompt')
  assert.equal(definition.taskTemplate, '动态 Template')
  assert.equal(definition.version, '9.0.0')
  assert.equal(resolver.resolve('technical-solution-analysis').agentKey, 'technical-solution-review')
  assert.equal(resolver.resolve('technical-solution-analysis').resultSchemaVersion, 'technical-solution-review/v2')
  assert.throws(() => new DynamicAgentDefinitionResolver({}).resolve('review-qa'), /AGENT_DEFINITION_NOT_FOUND/u)
})

test('服务启动时将失去执行进程的 running ReviewRun 收口为可重试失败态', async () => {
  const store = await seededStore()
  await store.transaction(state => {
    state.reviewRuns.push({
      id: 'review-run-interrupted', projectVersionId: 'project-version-1', assetId: 'asset-1', assetVersionId: 'version-1',
      documentTitle: '中断运行', documentVersion: 1, logicalPath: 'requirements/cancel.md', sourceId: 'source-1', modelId: 'model-1', modelLabel: '测试模型',
      status: 'running', step: 'extracting_requirement_points', progress: 10, createdAt: '2026-07-26T00:00:00.000Z', startedAt: '2026-07-26T00:00:00.000Z',
      snapshot: {} as (typeof state.reviewRuns)[number]['snapshot'],
    })
  })
  const service = new RequirementAnalysisService(store, new PiAgentRuntimeAdapter(store))
  assert.equal(await service.recoverInterruptedRuns(), 1)
  const recovered = (await store.snapshot()).reviewRuns[0]
  assert.equal(recovered.status, 'failed')
  assert.equal(recovered.step, 'failed')
  assert.ok(recovered.finishedAt)
  assert.match(recovered.error ?? '', /REVIEW_RUN_INTERRUPTED/u)
  assert.equal(await service.recoverInterruptedRuns(), 0)
})

test('Worker 重试逐次保留 Agent 对话且成功尝试不覆盖失败尝试', async () => {
  const baseline = await successfulRun()
  const fixedExtraction = formalExtraction(baseline.output.result)
  const store = await seededStore()
  let call = 0
  const runtime: AgentRuntime = {
    execute: async input => {
      call += 1
      const extractionStage = !input.fixedRequirementPointExtraction
      const event = {
        sequence: 1,
        type: 'message_end',
        occurredAt: new Date().toISOString(),
        turn: 1,
        role: 'assistant' as const,
        content: call === 1 ? '第一次提取对话' : extractionStage ? '第二次提取对话' : '第二次评审对话',
      }
      await input.onEvent?.(event)
      if (call === 1) throw new Error('MODEL_PROVIDER_UNAVAILABLE: temporary failure')
      return {
        candidate: extractionStage ? fixedExtraction : reviewResult(),
        events: [event], turns: 1, toolCalls: 0, toolErrors: 0, framework: { name: 'pi-agent-core', version: 'test' },
        ...(extractionStage ? { inputDeliveryManifest: deliveryManifest(input.snapshot as ReviewRunSnapshot) } : {}),
      }
    },
  }
  const service = new RequirementAnalysisService(store, runtime)
  const queued = await service.analyze(request(), new AbortController().signal, undefined, true)
  let firstError: unknown
  try {
    await service.processPreparedRun(queued.runId, undefined, new AbortController().signal, 1, 2)
  } catch (error) {
    firstError = error
  }
  assert.match(String(firstError), /MODEL_PROVIDER_UNAVAILABLE/u)
  await service.failPreparedRun(queued.runId, undefined, firstError, false, true, { attempt: 1, maxAttempts: 2, nextAttemptAt: new Date().toISOString() })
  await store.transaction(state => {
    const staleAttempt = state.reviewRuns.find(item => item.id === queued.runId)!.executionAttempts![0]
    staleAttempt.status = 'running'
    staleAttempt.finishedAt = undefined
  })
  await service.processPreparedRun(queued.runId, undefined, new AbortController().signal, 2, 2)

  const run = (await store.snapshot()).reviewRuns.find(item => item.id === queued.runId)!
  assert.deepEqual(run.executionAttempts?.map(item => item.status), ['failed', 'succeeded'])
  assert.deepEqual(run.executionAttempts?.map(item => item.activeAgentKey), ['requirement-point-extraction', 'requirement-review'])
  assert.equal(run.executionAttempts?.[0].executions.requirementPointExtraction?.events[0].content, '第一次提取对话')
  assert.equal(run.executionAttempts?.[1].executions.requirementPointExtraction?.events[0].content, '第二次提取对话')
  assert.equal(run.executionAttempts?.[1].executions.requirementReview?.events[0].content, '第二次评审对话')
  assert.equal(run.retryEvents?.[0].attempt, 1)
  assert.equal(run.retryEvents?.[0].agentKey, 'requirement-point-extraction')
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

  const trailingEllipsis = resolveEvidenceQuote({ assetVersionId: 'version-a', chunkId: 'chunk-a', quote: '状态包括 open、locked...' }, chunks)
  assert.equal(trailingEllipsis?.quote, '状态包括 `open`、`locked')
  assert.equal(trailingEllipsis?.strategy, 'source_search')
})

test('Evidence 可把带省略号或标点差异的检索线索恢复为固定原文', () => {
  const chunks = [{
    id: 'chunk-fr', assetVersionId: 'version-a', ordinal: 0, content: [
      '- 每个需求评审批次必须显式归属一个已存在的 `projectVersionId`，并使用该版本的全部有效需求绑定作为固定输入集合。未创建或未选择项目版本时，不加载需求分析数据、不允许新建评审或启动运行，并提供“新建项目版本”主操作。',
      '- 每个需求点至少关联一条证据，每条 Finding 可关联零到多条补充证据；证据快照至少包含 `assetId`、`assetVersionId`、`chunkId` 或 `chunkKey`、Chunk 内容 Hash、标题路径、行号/字符范围、引用摘录、`indexVersionId`。',
    ].join('\n'), contentHash: 'hash-fr', headingPath: ['固定证据'], startChar: 1000,
  }]
  const internalEllipsis = resolveEvidenceQuote({
    assetVersionId: 'version-a', chunkId: 'chunk-fr',
    quote: '每个需求评审批次必须显式归属一个已存在的 projectVersionId，并使用该版本的全部有效需求绑定作为固定输入集合…未创建或未选择项目版本时，不加载需求分析数据、不允许新建评审或启动运行，并提供“新建项目版本”主操作…',
  }, chunks)
  assert.equal(internalEllipsis?.strategy, 'source_search')
  assert.match(internalEllipsis?.quote ?? '', /固定输入集合。未创建或未选择项目版本/u)

  const punctuationDifference = resolveEvidenceQuote({
    assetVersionId: 'version-a', chunkId: 'chunk-fr',
    quote: '每个需求点至少关联一条证据，每条 Finding 可关联零到多条补充证据；证据快照至少包含 assetId、assetVersionId、chunkId 或 chunkKey, Chunk 内容 Hash、标题路径、行号/字符范围、引用…',
  }, chunks)
  assert.equal(punctuationDifference?.strategy, 'source_search')
  assert.match(punctuationDifference?.quote ?? '', /引用$/u)
})

test('Evidence 原文检索存在多个位置时不自动绑定', () => {
  const chunks = [{
    id: 'chunk-repeat', assetVersionId: 'version-a', ordinal: 0,
    content: '系统必须保留固定原文位置。\n系统必须保留固定原文位置。', contentHash: 'hash-repeat', headingPath: [], startChar: 0,
  }]
  assert.equal(resolveEvidenceQuote({ assetVersionId: 'version-a', chunkId: 'chunk-repeat', quote: '系统必须保留固定原文位置。' }, chunks), undefined)
  assert.equal(resolveEvidenceQuote({ assetVersionId: 'version-a', chunkId: 'chunk-repeat', quote: '系统必须保留固定原文位置...' }, chunks), undefined)
})

test('Evidence 无法唯一定位时可按需求点和引用线索返回固定原文候选', () => {
  const chunks = [{
    id: 'chunk-candidate', assetVersionId: 'version-a', ordinal: 0,
    content: '- 用户创建项目版本后，可以绑定已经就绪的需求资产版本。\n- 系统每天自动清理临时缓存。', contentHash: 'hash-candidate', headingPath: ['项目版本'], startChar: 500,
  }]
  const candidates = searchEvidenceCandidates({ assetVersionId: 'version-a', chunkId: 'chunk-candidate', quote: '创建版本并绑定 ready 需求' }, chunks, '用户创建项目版本并绑定就绪需求资产版本')
  assert.equal(candidates[0]?.chunk.id, 'chunk-candidate')
  assert.equal(candidates[0]?.quote, '- 用户创建项目版本后，可以绑定已经就绪的需求资产版本。')
  assert.ok((candidates[0]?.score ?? 0) > (candidates[1]?.score ?? 0))
})

test('v5 可用需求点的改写原文线索自动检索并生成固定原文', () => {
  const chunks = [{
    id: 'chunk-agent', assetVersionId: 'version-a', ordinal: 0,
    content: '- `RequirementPointExtractionAgent` 的输入是固定需求文档，输出仅含需求点、固定证据和覆盖范围；不得生成 Finding、评分或评审结论。', contentHash: 'hash-agent', headingPath: ['双 Agent'], startChar: 200,
  }]
  const resolved = resolveEvidenceSourceText('RequirementPointExtractionAgent 在独立会话中逐份读取固定原文，只提取需求点、固定证据和覆盖范围；不得生成 Finding、评分或评审结论。', chunks, '需求点提取 Agent 执行逻辑与产物约束')
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0].strategy, 'retrieval_candidate')
  assert.equal(resolved[0].quote, '- `RequirementPointExtractionAgent` 的输入是固定需求文档，输出仅含需求点、固定证据和覆盖范围；不得生成 Finding、评分或评审结论。')
})

test('v5 模糊检索保留最高分置信区间内的全部证据候选', () => {
  const chunks = [
    { id: 'chunk-tool', assetVersionId: 'version-a', ordinal: 0, content: '系统必须保存运行日志和工具调用记录。', contentHash: 'hash-tool', headingPath: ['日志'], startChar: 0 },
    { id: 'chunk-model', assetVersionId: 'version-a', ordinal: 1, content: '系统必须保存运行日志和模型调用记录。', contentHash: 'hash-model', headingPath: ['日志'], startChar: 100 },
    { id: 'chunk-report', assetVersionId: 'version-a', ordinal: 2, content: '用户可以导出报表。', contentHash: 'hash-report', headingPath: ['报表'], startChar: 200 },
  ]
  const resolved = resolveEvidenceSourceText('系统必须保存运行日志和调用记录。', chunks)
  assert.deepEqual(resolved.map(item => item.chunk.id), ['chunk-tool', 'chunk-model'])
  assert.ok(resolved.every(item => item.strategy === 'retrieval_candidate' && item.score >= 0.45))
  assert.ok(Math.max(...resolved.map(item => item.score)) - Math.min(...resolved.map(item => item.score)) <= 0.08)
})

test('v5 原文线索存在多个固定位置时全部生成 Evidence 候选', () => {
  const chunks = [{
    id: 'chunk-repeat-v4', assetVersionId: 'version-a', ordinal: 0,
    content: '系统必须保留固定原文位置。\n系统必须保留固定原文位置。', contentHash: 'hash-repeat-v4', headingPath: [], startChar: 0,
  }]
  const resolved = resolveEvidenceSourceText('系统必须保留固定原文位置。', chunks)
  assert.equal(resolved.length, 2)
  assert.deepEqual(resolved.map(item => item.offset), [0, 14])
})

test('Evidence 跨 Chunk 重定位存在多个不同原文位置时保持拒绝', () => {
  const chunks = [
    { id: 'chunk-a', assetVersionId: 'version-a', ordinal: 0, content: '相同需求文本。', contentHash: 'hash-a', headingPath: [], startChar: 0 },
    { id: 'chunk-b', assetVersionId: 'version-a', ordinal: 1, content: '相同需求文本。', contentHash: 'hash-b', headingPath: [], startChar: 100 },
  ]
  assert.equal(resolveEvidenceQuote({ assetVersionId: 'version-a', chunkId: 'missing', quote: '相同需求文本。' }, chunks), undefined)
})

test('评审问答将同一冻结运行的 Finding 和需求点引用归一化为 Evidence', async () => {
  const { store, runId } = await completedReviewRun()
  const service = new ReviewQaService(store, qaRuntime(['F-001', 'RP-001', 'E-002', 'E-001']))
  const answer = await service.ask(runId, { question: '取消订单的风险是什么？' })
  assert.deepEqual(answer.citations, ['E-001', 'E-002'])
  assert.equal(store.read().reviewQaSessions.length, 1)
  assert.equal(store.read().reviewQaTurns.length, 1)
  assert.equal(store.read().reviewQaTurns[0].status, 'succeeded')
  assert.equal((await service.list(runId)).turns[0].answer, answer.answer)
})

test('评审问答拒绝无法解析为当前冻结 Evidence 的引用', async () => {
  const { store, runId } = await completedReviewRun()
  const service = new ReviewQaService(store, qaRuntime(['F-404', 'RP-404', 'E-404']))
  await assert.rejects(() => service.ask(runId, { question: '未知引用是否有效？' }), /REVIEW_QA_INVALID_CITATION: F-404, RP-404, E-404/u)
})

test('评审问答使用独立发布的 Agent 模型、Prompt 与能力快照', async () => {
  const { store, runId } = await completedReviewRun()
  const configurations = new AgentConfigurationService(store)
  const initial = (await configurations.get()).agents.reviewQa.draft
  const saved = await configurations.save({
    agentKey: 'reviewQa',
    revision: initial.revision,
    routing: { ...initial.routing, primaryModel: { sourceId: 'source-1', modelId: 'model-1' }, maxOutputTokens: 2_048 },
    definition: { ...initial.definition, systemPrompt: `${initial.definition.systemPrompt}\n这是已发布的问答专用 Prompt。` },
  })
  const published = await configurations.publish({ agentKey: 'reviewQa', revision: saved.revision })
  let captured: ReviewQaExecutionInput | undefined
  const runtime: ReviewQaRuntime = { answer: async input => { captured = input; return qaOutput({ answer: '问答 Agent 回答。', citations: ['E-001'], limitations: [] }) } }
  const answer = await new ReviewQaService(store, runtime, configurations).ask(runId, { question: '取消订单有哪些边界？' })

  assert.equal(captured?.agentDefinition.contentSha256, published.agentDefinition.contentSha256)
  assert.match(captured?.agentDefinition.systemPrompt ?? '', /问答专用 Prompt/u)
  assert.equal(captured?.model.maxOutputTokens, 2_048)
  assert.equal(answer.agentConfigurationRef?.id, published.id)
  assert.equal(answer.execution.agentKey, 'review-qa')
})

test('评审问答运行时加载已发布 Agent 绑定的 Skill 与脚本工具', async () => {
  const { store, runId } = await completedReviewRun()
  await new AiResourceService(store).list()
  const configurations = new AgentConfigurationService(store)
  const initial = (await configurations.get()).agents.reviewQa.draft
  const saved = await configurations.save({
    agentKey: 'reviewQa',
    revision: initial.revision,
    routing: { ...initial.routing, primaryModel: { sourceId: 'source-1', modelId: 'model-1' }, maxOutputTokens: 2_048 },
    definition: { ...initial.definition, skillKeys: ['system.query-local-ip'] },
  })
  const published = await configurations.publish({ agentKey: 'reviewQa', revision: saved.revision })
  assert.deepEqual(saved.definition.toolIds, ['review.answer_submit'])
  assert.deepEqual(published.agentDefinition.toolIds, ['review.answer_submit', 'skill.execute_script'])
  const faux = fauxProvider()
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('skill_execute_script', { script: 'scripts/get-local-ip.ps1', args: [] }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('review_answer_submit', { answer: '已通过受控 Skill 查询本机 IP。', citations: [], limitations: [] }), { stopReason: 'toolUse' }),
  ])
  const toolSets: string[][] = []
  const systemPrompts: string[] = []
  const stream: StreamFn = (model, context, options) => {
    toolSets.push((context.tools ?? []).map(tool => tool.name))
    systemPrompts.push(context.systemPrompt ?? '')
    return (faux.provider.streamSimple.bind(faux.provider) as StreamFn)(model, context, options)
  }
  const runtime = new PiReviewQaRuntimeAdapter({ model: faux.getModel() as Model<Api>, streamFn: stream }, store)
  const answer = await new ReviewQaService(store, runtime, configurations).ask(runId, { question: '可以查询本机 IP 吗？' })

  assert.ok(toolSets[0].includes('review_answer_submit'))
  assert.ok(toolSets[0].includes('skill_execute_script'))
  assert.match(systemPrompts[0], /TRUSTED_SKILL key="system\.query-local-ip"/u)
  assert.ok(answer.execution.events.some(event => event.type === 'tool_execution_start' && event.toolId === 'skill_execute_script' && !JSON.stringify(event.toolArguments).includes('skillKey')))
  assert.ok(answer.execution.events.some(event => event.type === 'tool_execution_end' && event.toolId === 'skill_execute_script' && !event.isError))
})

test('评审问答提示将 Evidence 白名单与 Finding、需求点 ID 区分开', async () => {
  const { output } = await successfulRun()
  const faux = fauxProvider()
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('review_answer_submit', { answer: '取消后状态尚未定义。', citations: ['E-001'], limitations: [] }), { stopReason: 'toolUse' }),
  ])
  const prompts: string[] = []
  const stream: StreamFn = (model, context, options) => {
    prompts.push(context.messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).join('\n'))
    return (faux.provider.streamSimple.bind(faux.provider) as StreamFn)(model, context, options)
  }
  const runtime = new PiReviewQaRuntimeAdapter({ model: faux.getModel() as Model<Api>, streamFn: stream })
  const executionOutput = await runtime.answer({
    question: '请说明取消订单的风险。', snapshot: output.snapshot, reviewResult: output.result,
    documentContent: '用户可以取消待支付订单。', model: { sourceId: 'source-1', providerType: 'openai_compatible', baseUrl: 'https://provider.example/v1', apiKey: 'secret', modelId: 'model-1', modelName: 'review-model', contextWindow: 32_768, maxOutputTokens: 4_096, supportsReasoning: false },
    agentDefinition: defaultAgentDefinitionResolver.resolve('review-qa'),
  }, new AbortController().signal)
  assert.match(prompts[0], /allowedCitationEvidence/u)
  assert.match(prompts[0], /F-\* Finding ID 和 RP-\* 需求点 ID/u)
  assert.ok(executionOutput.execution.events.some(event => event.type === 'tool_execution_start' && event.toolId === 'review_answer_submit' && JSON.stringify(event.toolArguments).includes('取消后状态尚未定义')))
  assert.ok(executionOutput.execution.events.some(event => event.type === 'tool_execution_end' && event.toolId === 'review_answer_submit'))
  assert.ok(executionOutput.execution.events.some(event => event.type === 'message_end' && event.role === 'user' && event.content?.includes('输入详情不写入问答轨迹')))
  assert.ok(!executionOutput.execution.events.some(event => event.content?.includes('用户可以取消待支付订单。')))
})

test('普通文档正文在首轮直接进入上下文，模型无需逐 Chunk 读取', async () => {
  const store = await seededStore()
  const faux = fauxProvider()
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('requirement_points_submit_result', extractionDraft()), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('review_submit_result', reviewDraft()), { stopReason: 'toolUse' }),
  ])
  const prompts: string[] = []
  const toolSets: string[][] = []
  const stream: StreamFn = (model, context, options) => {
    prompts.push(context.messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).join('\n'))
    toolSets.push((context.tools ?? []).map(tool => tool.name))
    return (faux.provider.streamSimple.bind(faux.provider) as StreamFn)(model, context, options)
  }
  const service = new RequirementAnalysisService(store, new PiAgentRuntimeAdapter(store, { model: faux.getModel() as Model<Api>, streamFn: stream }))
  const output = await service.analyze(request())

  assert.equal(output.status, 'candidate_validated')
  assert.equal(output.snapshot.extractionInput.mode, 'full_context')
  assert.match(prompts[0], /用户可以取消待支付订单。/u)
  assert.match(prompts[0], /订单超过十五分钟未支付时自动关闭。/u)
  assert.match(prompts[1], /clientRequirementPointId.*RP-001/u)
  assert.match(prompts[1], /clientRequirementPointId.*RP-002/u)
  assert.doesNotMatch(prompts[1], /缺少固定需求点提取结果/u)
  assert.deepEqual(toolSets[0], ['requirement_points_submit_result'])
  assert.ok(!output.executions.requirementPointExtraction.events.some(event => event.toolId === 'knowledge_read_chunk'))
  assert.ok(output.executions.requirementPointExtraction.events.some(event => event.type === 'input_package_built'))
  assert.ok(output.executions.requirementPointExtraction.events.some(event => event.type === 'input_batch_delivered'))
})

test('需求评审失败后可复用冻结需求点只重跑评审，并保留原运行与提取执行', async () => {
  const { output: firstOutput, store } = await successfulRun()
  await store.transaction(state => {
    const run = state.reviewRuns.find(item => item.id === firstOutput.runId)!
    const extractionExecution = run.executions?.requirementPointExtraction
    run.status = 'failed'
    run.step = 'failed'
    run.progress = 60
    run.finishedAt = '2026-07-28T01:00:00.000Z'
    run.error = 'MODEL_REQUEST_FAILED: 需求评审模型调用失败'
    run.result = undefined
    run.execution = undefined
    run.executions = extractionExecution ? { requirementPointExtraction: extractionExecution } : undefined
  })

  const faux = fauxProvider()
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('review_submit_result', reviewDraft()), { stopReason: 'toolUse' }),
  ])
  let modelCalls = 0
  const stream: StreamFn = (model, context, options) => {
    modelCalls += 1
    return (faux.provider.streamSimple.bind(faux.provider) as StreamFn)(model, context, options)
  }
  const service = new RequirementAnalysisService(store, new PiAgentRuntimeAdapter(store, { model: faux.getModel() as Model<Api>, streamFn: stream }))
  const retried = await service.retryReview(firstOutput.runId)

  assert.notEqual(retried.runId, firstOutput.runId)
  assert.equal(retried.status, 'candidate_validated')
  assert.equal(modelCalls, 1)
  const runs = (await store.snapshot()).reviewRuns
  const sourceRun = runs.find(item => item.id === firstOutput.runId)!
  const retryRun = runs.find(item => item.id === retried.runId)!
  assert.equal(sourceRun.status, 'failed')
  assert.equal(sourceRun.result, undefined)
  assert.equal(retryRun.status, 'succeeded')
  assert.equal(retryRun.retryOfRunId, sourceRun.id)
  assert.equal(retryRun.reviewId, sourceRun.reviewId)
  assert.equal(retryRun.retryMode, 'review_only')
  assert.equal(retryRun.reusedExtractionFromRunId, sourceRun.id)
  assert.deepEqual(retryRun.extractionResult, sourceRun.extractionResult)
  assert.deepEqual(retryRun.inputDeliveryManifest, sourceRun.inputDeliveryManifest)
  assert.deepEqual(retryRun.executions?.requirementPointExtraction, sourceRun.executions?.requirementPointExtraction)
  assert.ok(retryRun.executions?.requirementReview)
})

test('运行列表使用轻量投影保留冻结需求点状态', async () => {
  const { store } = await successfulRun()
  const sourceRun = (await store.snapshot()).reviewRuns[0]
  const projectedRun = structuredClone(sourceRun) as ReviewRun & { hasFrozenExtraction: boolean }
  delete projectedRun.extractionResult
  delete projectedRun.inputDeliveryManifest
  projectedRun.hasFrozenExtraction = true
  const pagedStore = store as JsonStore & { listReviewRuns: NonNullable<StateStore['listReviewRuns']> }
  pagedStore.listReviewRuns = async () => ({ items: [projectedRun] })

  const listed = await new RequirementAnalysisService(pagedStore, new PiAgentRuntimeAdapter(pagedStore)).list(sourceRun.projectVersionId)

  assert.equal(listed.items[0].hasFrozenExtraction, true)
})

test('没有冻结需求点的失败运行只能全部重跑', async () => {
  const store = await seededStore()
  await store.transaction(state => {
    state.reviewRuns.push({
      id: 'review-run-extraction-failed', projectVersionId: 'project-version-1', assetId: 'asset-1', assetVersionId: 'version-1',
      documentTitle: '提取失败运行', documentVersion: 1, logicalPath: 'requirements/cancel.md', sourceId: 'source-1', modelId: 'model-1', modelLabel: '测试模型',
      status: 'failed', step: 'failed', progress: 10, createdAt: '2026-07-28T00:00:00.000Z', startedAt: '2026-07-28T00:00:00.000Z', finishedAt: '2026-07-28T00:00:01.000Z',
      snapshot: {} as (typeof state.reviewRuns)[number]['snapshot'], error: '需求点提取失败',
    })
  })
  const service = new RequirementAnalysisService(store, new PiAgentRuntimeAdapter(store))
  await assert.rejects(() => service.retryReview('review-run-extraction-failed'), /没有已冻结的需求点提取结果，只能全部重跑/u)
  assert.equal((await store.snapshot()).reviewRuns.length, 1)
})

test('新评审固定使用已发布 Agent 配置中的模型、输出额度、Prompt、工具与配置版本', async () => {
  const store = await seededStore()
  await store.transaction(state => {
    state.modelSources[0].models.push({ ...state.modelSources[0].models[0], id: 'model-2', name: 'review-model', displayName: '评审模型', maxOutputTokens: 4_096 })
  })
  const configurations = new AgentConfigurationService(store)
  const initial = await configurations.get()
  const extractionDraftState = initial.agents.requirementPointExtraction.draft
  const reviewDraftState = initial.agents.requirementReview.draft
  const extractionSaved = await configurations.save({
    agentKey: 'requirementPointExtraction',
    revision: extractionDraftState.revision,
    routing: { ...extractionDraftState.routing, primaryModel: { sourceId: 'source-1', modelId: 'model-1' }, maxOutputTokens: 8_192, temperature: 0.1, retryCount: 1 },
    definition: extractionDraftState.definition,
  })
  const extractionPublished = await configurations.publish({ agentKey: 'requirementPointExtraction', revision: extractionSaved.revision })
  const reviewSaved = await configurations.save({
    agentKey: 'requirementReview',
    revision: reviewDraftState.revision,
    routing: { ...reviewDraftState.routing, primaryModel: { sourceId: 'source-1', modelId: 'model-2' }, maxOutputTokens: 8_192, temperature: 0.3, retryCount: 2 },
    definition: { ...reviewDraftState.definition, systemPrompt: `${reviewDraftState.definition.systemPrompt}\n已发布配置标记。` },
  })
  const reviewPublished = await configurations.publish({ agentKey: 'requirementReview', revision: reviewSaved.revision })
  const faux = fauxProvider()
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('requirement_points_submit_result', extractionDraft()), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('review_submit_result', reviewDraft()), { stopReason: 'toolUse' }),
  ])
  const service = new RequirementAnalysisService(store, new PiAgentRuntimeAdapter(store, { model: faux.getModel() as Model<Api>, streamFn: faux.provider.streamSimple.bind(faux.provider) as StreamFn }), configurations)
  const output = await service.analyze({ projectVersionId: 'project-version-1', assetVersionIds: ['version-1', 'version-2'] })
  assert.equal(output.snapshot.agentConfigurationRefs?.requirementPointExtraction.id, extractionPublished.id)
  assert.equal(output.snapshot.agentConfigurationRefs?.requirementReview.id, reviewPublished.id)
  assert.equal(output.snapshot.agentConfigurationRefs?.requirementPointExtraction.version, 1)
  assert.equal(output.snapshot.agentConfigurationRefs?.requirementReview.version, 1)
  assert.equal(output.snapshot.modelRef.modelId, 'model-1')
  assert.equal(output.snapshot.modelRef.maxOutputTokens, 8_192)
  assert.equal(output.snapshot.agentModelRefs?.requirementReview.modelId, 'model-2')
  assert.equal(output.snapshot.agentModelRefs?.requirementReview.maxOutputTokens, 8_192)
  assert.match((await configurations.getVersion(reviewPublished.id)).agentDefinition.systemPrompt, /已发布配置标记/u)
  assert.match(output.snapshot.agentDefinitions.requirementReview.version, /\+config\.1$/u)
})

test('主模型临时失败后按发布路由降级并持久化实际模型尝试', async () => {
  const baseline = await successfulRun()
  const fixedExtraction = formalExtraction(baseline.output.result)
  const store = await seededStore()
  await store.transaction(state => {
    const primary = state.modelSources[0].models[0]
    state.modelSources[0].models.push({ ...structuredClone(primary), id: 'model-fallback', name: 'fallback-model', displayName: 'Fallback Model' })
  })
  const configurations = new AgentConfigurationService(store)
  for (const agentKey of ['requirementPointExtraction', 'requirementReview'] as const) {
    const draft = (await configurations.get()).agents[agentKey].draft
    const saved = await configurations.save({
      agentKey,
      revision: draft.revision,
      routing: { ...draft.routing, primaryModel: { sourceId: 'source-1', modelId: 'model-1' }, fallbackEnabled: true, fallbackModels: [{ sourceId: 'source-1', modelId: 'model-fallback' }], maxOutputTokens: 4_096 },
      definition: draft.definition,
    })
    await configurations.publish({ agentKey, revision: saved.revision })
  }
  const calls: string[] = []
  const runtime: AgentRuntime = {
    execute: async input => {
      calls.push(input.model.modelId)
      const extractionStage = !input.fixedRequirementPointExtraction
      if (extractionStage && input.model.modelId === 'model-1') throw new Error('MODEL_PROVIDER_UNAVAILABLE: primary unavailable')
      return {
        candidate: extractionStage ? fixedExtraction : reviewResult(),
        events: [], turns: 1, toolCalls: 1, toolErrors: 0, framework: { name: 'pi-agent-core', version: 'test' },
        ...(extractionStage ? { inputDeliveryManifest: deliveryManifest(input.snapshot) } : {}),
      }
    },
  }
  const service = new RequirementAnalysisService(store, runtime, configurations)
  const output = await service.analyze({ projectVersionId: 'project-version-1', assetVersionIds: ['version-1', 'version-2'] })
  assert.equal(output.status, 'candidate_validated')
  assert.deepEqual(calls, ['model-1', 'model-fallback', 'model-1'])
  const run = (await store.snapshot()).reviewRuns.find(item => item.id === output.runId)!
  assert.equal(run.degradations?.length, 1)
  assert.equal(run.degradations?.[0].toModelId, 'model-fallback')
  assert.deepEqual(run.modelRouteAttempts?.map(item => item.status), ['failed', 'succeeded', 'succeeded'])
})

test('生产配置解析器拒绝通过请求参数绕过未发布的 Agent 配置', async () => {
  const store = await seededStore()
  const configurations = new AgentConfigurationService(store)
  const service = new RequirementAnalysisService(store, new PiAgentRuntimeAdapter(store), configurations)
  await assert.rejects(() => service.analyze(request()), /分别发布需求点提取 Agent 和需求评审 Agent/u)
  assert.equal(store.read().reviewRuns.length, 0)
})

test('服务端从固定 Chunk 规范化 Evidence 与覆盖，忽略模型对定位和覆盖的声明能力', async () => {
  const { output, store } = await successfulRun()
  const extraction = output.result as CandidateRequirementPointExtraction
  assert.deepEqual(extraction.evidence[0], {
    clientEvidenceId: 'E-001', sourceType: 'knowledge_chunk', sourceRef: { chunkId: 'chunk-1', assetVersionId: 'version-1' },
    quote: '用户可以取消待支付订单。', locator: { heading: '取消订单', start: 8, end: 20 },
  })
  assert.equal(extraction.requirementPoints[0].title, '取消待支付订单')
  assert.deepEqual(extraction.requirementPoints.map(point => point.evidenceRefs), [['E-001'], ['E-002']])
  assert.deepEqual(extraction.coverage.assets, [
    { assetVersionId: 'version-1', deliveredChunkIds: ['chunk-1'], excludedChunks: [] },
    { assetVersionId: 'version-2', deliveredChunkIds: ['chunk-2'], excludedChunks: [] },
  ])
  const saved = (await store.snapshot()).reviewRuns[0]
  assert.equal(saved.snapshot.extractionInput.batches[0].contentSha256.length, 64)
  assert.equal(saved.inputDeliveryManifest?.entries[0].contentSha256, saved.snapshot.extractionInput.batches[0].contentSha256)
  assert.deepEqual(saved.extractionResult, { requirementPoints: extraction.requirementPoints, evidence: extraction.evidence, coverage: extraction.coverage })
})

test('服务端按需求点嵌套关系生成引用，并对多个需求点共享的固定 Evidence 去重', async () => {
  const { snapshot, store } = await snapshotForValidation()
  const draft = extractionDraft()
  draft.requirementPoints[0].sourceTexts.unshift('这条无关原文线索不会拖垮已有有效证据。')
  draft.requirementPoints.push({
    description: '管理员可复核用户取消待支付订单的操作。',
    sourceTexts: ['用户可以取消待支付订单。'],
  })
  const normalized = await new RequirementPointExtractionValidator(store).normalizeV5(draft, snapshot, deliveryManifest(snapshot))
  assert.equal(normalized.report.valid, true)
  assert.equal(normalized.result?.evidence.length, 2)
  assert.equal(normalized.result?.requirementPoints[2].clientRequirementPointId, 'RP-003')
  assert.deepEqual(normalized.result?.requirementPoints[2].evidenceRefs, ['E-001'])
})

test('需求点完全检索不到原文时才开放定点补读工具并允许修复 sourceTexts', async () => {
  const store = await seededStore()
  const invalid = extractionDraft()
  invalid.requirementPoints[0] = { description: '数据库备份必须跨区域保留七年。', sourceTexts: ['数据库备份必须跨区域保留七年。'] }
  const faux = fauxProvider()
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('requirement_points_submit_result', invalid), { stopReason: 'toolUse' }),
    fauxAssistantMessage('我需要按服务端问题定点修复原文线索。'),
    fauxAssistantMessage(fauxToolCall('knowledge_read_chunk', { chunkId: 'chunk-1' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('requirement_points_submit_result', extractionDraft()), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('review_submit_result', reviewDraft()), { stopReason: 'toolUse' }),
  ])
  const service = new RequirementAnalysisService(store, new PiAgentRuntimeAdapter(store, { model: faux.getModel() as Model<Api>, streamFn: faux.provider.streamSimple.bind(faux.provider) as StreamFn }))
  const output = await service.analyze(request())
  assert.equal(output.status, 'candidate_validated')
  const execution = output.executions?.requirementPointExtraction
  assert.ok(execution)
  assert.ok(execution.events.some(event => event.type === 'tool_execution_end' && event.toolId === 'requirement_points_submit_result' && JSON.stringify(event.toolResult).includes('validation_failed')))
  assert.ok(execution.events.some(event => event.type === 'evidence_repair_tools_enabled'))
  assert.ok(execution.events.some(event => event.toolId === 'knowledge_read_chunk'))
})

test('v5 重复需求点由服务端自动去重且不要求模型维护归并字段', async () => {
  const store = await seededStore()
  const invalid = extractionDraft()
  invalid.requirementPoints.push(structuredClone(invalid.requirementPoints[0]))
  const faux = fauxProvider()
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('requirement_points_submit_result', invalid), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('review_submit_result', reviewDraft()), { stopReason: 'toolUse' }),
  ])
  const service = new RequirementAnalysisService(store, new PiAgentRuntimeAdapter(store, { model: faux.getModel() as Model<Api>, streamFn: faux.provider.streamSimple.bind(faux.provider) as StreamFn }))
  const output = await service.analyze(request())
  assert.equal(output.status, 'candidate_validated')
  const execution = output.executions?.requirementPointExtraction
  assert.ok(execution)
  assert.equal((output.result as CandidateRequirementPointExtraction).requirementPoints.length, 2)
  assert.ok(!execution.events.some(event => event.type === 'tool_execution_end' && event.toolId === 'requirement_points_submit_result' && JSON.stringify(event.toolResult).includes('validation_failed')))
  assert.ok(!execution.events.some(event => event.type === 'evidence_repair_tools_enabled'))
  assert.ok(!execution.events.some(event => event.toolId === 'knowledge_read_chunk'))
})

test('输入投递清单缺批或哈希不一致时不能冻结结果', async () => {
  const { snapshot, store } = await snapshotForValidation()
  const validator = new RequirementPointExtractionValidator(store)
  const missing = deliveryManifest(snapshot)
  missing.entries = []
  const missingReport = await validator.normalizeV5(extractionDraft(), snapshot, missing)
  assert.equal(missingReport.report.valid, false)
  assert.ok(missingReport.report.issues.some(issue => issue.path.includes('inputDeliveryManifest.entries')))

  const forged = deliveryManifest(snapshot)
  forged.entries[0].contentSha256 = 'forged'
  const forgedReport = await validator.normalizeV5(extractionDraft(), snapshot, forged)
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

test('v5 允许可选 title，但拒绝模型提交 title、description 和 sourceTexts 之外的字段', async () => {
  const { snapshot, store } = await snapshotForValidation()
  const invalid = extractionDraft() as CandidateRequirementPointExtractionV5 & { requirementPoints: Array<CandidateRequirementPointExtractionV5['requirementPoints'][number] & { evidenceDrafts?: unknown }> }
  invalid.requirementPoints[0].evidenceDrafts = [{ assetVersionId: 'version-1', chunkId: 'chunk-1', quote: '用户可以取消待支付订单。' }]
  const report = await new RequirementPointExtractionValidator(store).normalizeV5(invalid, snapshot, deliveryManifest(snapshot))
  assert.equal(report.report.valid, false)
  assert.ok(report.report.issues.some(issue => issue.path === 'requirementPoints[0].evidenceDrafts'))
})

test('v5 优先保留模型标题，缺失或空白时根据 description 兜底', async () => {
  const { snapshot, store } = await snapshotForValidation()
  const validator = new RequirementPointExtractionValidator(store)
  const titled = await validator.normalizeV5(extractionDraft(), snapshot, deliveryManifest(snapshot))
  assert.equal(titled.result?.requirementPoints[0].title, '取消待支付订单')

  const fallback = extractionDraft()
  delete fallback.requirementPoints[0].title
  fallback.requirementPoints[1].title = '   '
  const fallbackResult = await validator.normalizeV5(fallback, snapshot, deliveryManifest(snapshot))
  assert.equal(fallbackResult.report.valid, true)
  assert.equal(fallbackResult.result?.requirementPoints[0].title, '用户可以取消处于待支付状态的订单')
  assert.equal(fallbackResult.result?.requirementPoints[1].title, '超过十五分钟未支付的订单会自动关闭')
})

test('归并字段必须成对且不能是空白', async () => {
  const { snapshot, store } = await snapshotForValidation()
  const validator = new RequirementPointExtractionValidator(store)
  const cases = [
    { field: 'mergeGroupId', value: { mergeRationale: '语义相同' } },
    { field: 'mergeRationale', value: { mergeGroupId: 'group-1' } },
    { field: 'mergeGroupId', value: { mergeGroupId: '   ', mergeRationale: '语义相同' } },
    { field: 'mergeRationale', value: { mergeGroupId: 'group-1', mergeRationale: '   ' } },
  ] as const
  for (const current of cases) {
    const invalid = extractionDraftV4()
    invalid.requirementPoints[0] = { ...invalid.requirementPoints[0], ...current.value }
    const report = await validator.normalizeV4(invalid, snapshot, deliveryManifest(snapshot))
    assert.equal(report.report.valid, false)
    assert.ok(report.report.issues.some(issue => issue.path === `requirementPoints[0].${current.field}`))
  }

  const valid = extractionDraftV4()
  valid.requirementPoints[0] = { ...valid.requirementPoints[0], mergeGroupId: 'group-1', mergeRationale: '同一能力的重复表述。' }
  const validReport = await validator.normalizeV4(valid, snapshot, deliveryManifest(snapshot))
  assert.equal(validReport.report.valid, true)
})

test('v5 自动合并相同需求描述的全部原文线索并保持阶段字段边界', async () => {
  const { snapshot, store } = await snapshotForValidation()
  const validator = new RequirementPointExtractionValidator(store)
  const deduplicated = extractionDraft()
  deduplicated.requirementPoints.push({ description: deduplicated.requirementPoints[0].description, sourceTexts: ['用户可以取消待支付订单。'] })
  const report = await validator.normalizeV5(deduplicated, snapshot, deliveryManifest(snapshot))
  assert.equal(report.report.valid, true)
  assert.equal(report.result?.requirementPoints.length, 2)
  assert.deepEqual(report.result?.requirementPoints[0].evidenceRefs, ['E-001'])

  const forbidden = { ...extractionDraft(), coverage: { assets: [], limitations: [] } } as CandidateRequirementPointExtractionV5
  const draftReport = await validator.normalizeV5(forbidden, snapshot, deliveryManifest(snapshot))
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

test('v3 评审保留模型给出的展示字段和总体摘要，并由服务端生成 Finding ID', async () => {
  const { output, snapshot } = await snapshotForValidation()
  const extraction = output.result as CandidateRequirementPointExtraction
  const normalized = new RequirementReviewValidator().normalizeV3(reviewDraft(), extraction, snapshot)
  assert.equal(normalized.report.valid, true)
  assert.deepEqual(normalized.result?.summary, reviewDraft().summary)
  assert.deepEqual(normalized.result?.findings[0], {
    clientFindingId: 'F-001', type: 'state_gap', severity: 'high', confidence: 0.9, title: '取消后状态缺失',
    description: '需求只定义可取消，未定义取消后的订单状态。', impact: '实现和验收口径可能不一致。',
    recommendation: '补充状态迁移、幂等与失败处理。', requirementPointRefs: ['RP-001'],
  })
})

test('v3 评审拒绝没有任何分析却声明需修订或阻塞', async () => {
  const { output, snapshot } = await snapshotForValidation()
  const extraction = output.result as CandidateRequirementPointExtraction
  const validator = new RequirementReviewValidator()
  const blocked = validator.normalizeV3({
    summary: { overallAssessment: 'blocked', score: 0, strengths: [], risks: ['缺少固定需求点提取结果'] },
    analyses: [],
  }, extraction, snapshot)
  const passed = validator.normalizeV3({
    summary: { overallAssessment: 'pass', score: 100, strengths: ['未发现问题'], risks: [] },
    analyses: [],
  }, extraction, snapshot)

  assert.equal(blocked.report.valid, false)
  assert.ok(blocked.report.issues.some(issue => issue.path === 'analyses'))
  assert.equal(passed.report.valid, true)
})

test('v3 评审漏掉展示字段时服务端兜底，但错误需求点引用仍拒绝', async () => {
  const { output, snapshot } = await snapshotForValidation()
  const extraction = output.result as CandidateRequirementPointExtraction
  const validator = new RequirementReviewValidator()
  const fallbackDraft = {
    summary: { overallAssessment: 'revise', score: 120 },
    analyses: [{ requirementPointRef: 'RP-001', analysis: '取消后的状态没有定义。', type: 'state', severity: 'urgent', confidence: 1.7 }],
  } as unknown as CandidateRequirementReviewV3
  const fallback = validator.normalizeV3(fallbackDraft, extraction, snapshot)
  assert.equal(fallback.report.valid, true)
  assert.equal(fallback.result?.findings[0].type, 'state_gap')
  assert.equal(fallback.result?.findings[0].severity, 'medium')
  assert.equal(fallback.result?.findings[0].confidence, 1)
  assert.equal(fallback.result?.summary.overallAssessment, 'needs_revision')
  assert.equal(fallback.result?.summary.score, 100)
  const invalid = validator.normalizeV3({ analyses: [{ requirementPointRef: 'RP-999', analysis: '无法对应需求点。' }] }, extraction, snapshot)
  assert.equal(invalid.report.valid, false)
  assert.ok(invalid.report.issues.some(issue => issue.path === 'analyses[0].requirementPointRef'))
})

test('超长正文确定性切换 segmented_context 并为每批生成哈希边界', () => {
  const definition = defaultAgentDefinitionResolver.resolve('requirement-point-extraction')
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
  const definition = defaultAgentDefinitionResolver.resolve('requirement-point-extraction')
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
    agentDefinition: { ...snapshot.agentDefinitions.requirementPointExtraction, toolIds: [...snapshot.agentDefinitions.requirementPointExtraction.toolIds, 'catalog.tool.pending-runtime'] },
    extractionInput: {
      policyVersion: plan.policyVersion, mode: plan.mode, estimatedInputTokens: plan.estimatedInputTokens, safeInputBudget: plan.safeInputBudget, packageSha256: plan.packageSha256,
      batches: batches.map(batch => ({ ...batch, contentSha256: createHash('sha256').update(batch.content).digest('hex'), content: undefined })).map(({ content: _content, ...batch }) => batch),
    },
  }
  const faux = fauxProvider()
  faux.setResponses([
    fauxAssistantMessage('{"requirementPoints":[{"description":"第一批需求","sourceTexts":["第一批原文"]}]}'),
    fauxAssistantMessage('{"requirementPoints":[{"description":"第二批需求","sourceTexts":["第二批原文"]}]}'),
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
  assert.ok(output.events.some(event => event.type === 'tool_bindings_unavailable' && event.content?.includes('catalog.tool.pending-runtime')))
  assert.deepEqual((output.candidate as CandidateRequirementPointExtraction).coverage.assets.map(asset => asset.deliveredChunkIds), [['chunk-1'], ['chunk-2']])
})

async function successfulRun() {
  const store = await seededStore()
  const faux = fauxProvider()
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('requirement_points_submit_result', extractionDraft()), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('review_submit_result', reviewDraft()), { stopReason: 'toolUse' }),
  ])
  const service = new RequirementAnalysisService(store, new PiAgentRuntimeAdapter(store, { model: faux.getModel() as Model<Api>, streamFn: faux.provider.streamSimple.bind(faux.provider) as StreamFn }))
  const output = await service.analyze(request())
  return { output, store }
}

async function completedReviewRun() {
  const { output, store } = await successfulRun()
  return { store, runId: output.runId }
}

function qaRuntime(citations: string[]): ReviewQaRuntime {
  return { answer: async () => qaOutput({ answer: '基于固定评审结果的回答。', citations, limitations: [] }) }
}

function qaOutput(candidate: { answer: string; citations: string[]; limitations: string[] }) {
  return { candidate, execution: { agentKey: 'review-qa' as const, turns: 0, toolCalls: 0, toolErrors: 0, framework: { name: 'pi-agent-core' as const, version: 'test' }, events: [] } }
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

function extractionDraft(): CandidateRequirementPointExtractionV5 {
  return {
    requirementPoints: [
      { title: '取消待支付订单', description: '用户可以取消处于待支付状态的订单。', sourceTexts: ['用户可以取消待支付订单。'] },
      { title: '支付超时自动关闭订单', description: '超过十五分钟未支付的订单会自动关闭。', sourceTexts: ['订单超过十五分钟未支付时自动关闭。'] },
    ],
  }
}

function extractionDraftV4(): CandidateRequirementPointExtractionV4 {
  return {
    requirementPoints: [
      { description: '用户可以取消处于待支付状态的订单。', actor: '用户', action: '取消', object: '待支付订单', conditions: ['订单处于待支付状态'], businessRules: [], exceptions: [], acceptanceCriteria: ['用户提交取消后订单不再待支付'], sourceTexts: ['用户可以取消待支付订单。'] },
      { title: '支付超时关闭订单', description: '超过十五分钟未支付的订单会自动关闭。', actor: '系统', action: '关闭', object: '超时未支付订单', conditions: ['超过十五分钟未支付'], businessRules: ['超时自动关闭'], exceptions: [], acceptanceCriteria: ['超时订单状态为已关闭'], sourceTexts: ['订单超过十五分钟未支付时自动关闭。'] },
    ],
  }
}

function reviewResult(): CandidateRequirementReview {
  return {
    summary: { overallAssessment: 'needs_revision', score: 65, strengths: ['目标明确'], risks: ['取消后的状态未定义'] },
    findings: [{ clientFindingId: 'F-001', type: 'state_gap', severity: 'high', confidence: 0.9, title: '取消后状态缺失', description: '需求只定义可取消，未定义取消后的订单状态。', impact: '实现和验收口径可能不一致。', recommendation: '补充状态迁移、幂等与失败处理。', requirementPointRefs: ['RP-001'] }],
  }
}

function reviewDraft(): CandidateRequirementReviewV3 {
  return {
    summary: { overallAssessment: 'needs_revision', score: 65, strengths: ['目标明确'], risks: ['取消后的状态未定义'] },
    analyses: [{ requirementPointRef: 'RP-001', title: '取消后状态缺失', type: 'state_gap', severity: 'high', confidence: 0.9, analysis: '需求只定义可取消，未定义取消后的订单状态。', impact: '实现和验收口径可能不一致。', recommendation: '补充状态迁移、幂等与失败处理。' }],
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
    state.modelSources.push({ id: 'source-1', name: '测试来源', providerType: 'openai_compatible', baseUrl: 'https://provider.example/v1', apiKey: 'secret', enabled: true, health: 'healthy', priority: 1, models: [{ id: 'model-1', name: 'review-model', displayName: 'Review Model', contextWindow: 32_768, maxOutputTokens: 4_096, capabilities: ['tool_calling', 'structured_output'], enabled: true, health: 'healthy', qualityGate: { version: 'model-probe/v2', checkedAt: '2026-07-23T00:00:00.000Z', passed: true, sampleSha256: 'a'.repeat(64), inputCharacters: 8_000, checks: { connectivity: true, longContext: true, structuredSubmission: true, toolCalling: true } } }], createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z' })
  })
  return store
}
