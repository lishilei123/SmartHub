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
import { PlanningWorkflowService } from '../server/application/planning-workflow-service.js'
import type { AgentRuntime, InputDeliveryManifest, ReviewRunSnapshot } from '../server/domain/agent-types.js'
import type { CandidateRequirementAnalysisV1 } from '../server/domain/review-types.js'
import { defaultConfig } from '../server/domain/types.js'
import { JsonStore } from '../server/infrastructure/store.js'

const requirementDirectory = 'workspace/branches/V1.0/input/requirements'

test('PlanningAgent 通过一个长期定义绑定 Workspace、Knowledge、Skills 和各业务提交工具', () => {
  const definition = defaultAgentDefinitionResolver.resolve('planning')
  assert.equal(definition.agentType, 'planning')
  assert.equal(definition.resultSchemaVersion, 'planning/v1')
  assert.deepEqual(definition.toolIds, [
    'workspace.read_file',
    'workspace.grep_files',
    'workspace.find_files',
    'workspace.list_directory',
    'knowledge.search',
    'knowledge.read_chunk',
    'requirement-analysis.submit_result',
    'requirement-repair.submit_result',
    'requirement-release.submit_result',
    'test_design_points.submit_result',
    'test_design_cases.submit_result',
    'test_design_repair.submit_result',
  ])
  assert.match(definition.systemPrompt, /同一个 Planning Session 中通过连续对话/u)
  assert.match(definition.systemPrompt, /根据当前任务自主选择已启用 Skills/u)
  assert.match(definition.systemPrompt, /Workspace \/ Knowledge 工具/u)
  assert.match(definition.systemPrompt, /Runtime 当前暴露的工具和 Submit Tool 是执行权限边界/u)
  assert.doesNotMatch(definition.systemPrompt, /只执行当前 Stage|上一阶段已经失效/u)
})

test('Requirement Release 已绑定后仍可在同一 ProjectVersion 创建新的需求分析 Run，失败不会覆盖既有绑定', async () => {
  const store = await seededStore()
  await store.transaction(state => {
    const projectVersion = state.projectVersions.find(item => item.id === 'project-version-1')!
    projectVersion.requirementReleaseBinding = {
      releaseId: 'release-1',
      verificationRunId: 'analysis-run-1',
      requirementsJsonSha256: 'a'.repeat(64),
      boundAt: '2026-08-17T00:00:00.000Z',
    }
  })
  const service = new RequirementAnalysisService(store, { execute: async () => { throw new Error('不应执行 Agent') } })

  const created = await service.analyze({ projectVersionId: 'project-version-1', documentDirectoryPath: requirementDirectory, sourceId: 'source-1', modelId: 'model-1' }, new AbortController().signal, undefined, true)
  assert.equal('id' in created, true)
  const state = await store.snapshot()
  assert.equal(state.reviewRuns.length, 1)
  assert.equal(state.projectVersions.find(item => item.id === 'project-version-1')!.requirementReleaseBinding?.releaseId, 'release-1')
})

test('目录输入包只交付工作区元数据，不把原始需求拼接进 Prompt', async () => {
  const store = await seededStore()
  const state = await store.snapshot()
  const definition = defaultAgentDefinitionResolver.resolve('planning')
  const assets = state.assets.map(asset => ({ asset, version: state.versions.find(version => version.id === asset.activeVersionId)! }))
  const plan = buildRequirementDirectoryInputPlan({
    workspacePath: requirementDirectory,
    workspaceRootPath: 'workspace',
    activeBranchPath: 'workspace/branches/V1.0',
    agentWorkspacePath: 'workspace/agent_workspace/planning_agent',
    assets,
    currentInputRefs: assets.map(({ asset, version }) => ({ assetId: asset.id, assetVersionId: version.id, logicalPath: asset.logicalPath, contentSha256: version.contentHash })),
    workspaceSnapshot: {
      schemaVersion: 'project-workspace-snapshot/v1',
      projectId: 'project-1',
      projectVersionId: 'project-version-1',
      rootLogicalPath: 'workspace',
      activeBranchLogicalPath: 'workspace/branches/V1.0',
      files: assets.map(({ asset, version }) => ({ assetId: asset.id, assetVersionId: version.id, logicalPath: asset.logicalPath, displayName: asset.displayName, contentSha256: version.contentHash, sourceScope: 'current_input' as const })),
      snapshotSha256: 'a'.repeat(64),
      createdAt: '2026-08-12T00:00:00.000Z',
    },
    definition,
    contextWindow: 32_768,
    maxOutputTokens: 4_096,
  })
  assert.equal(plan.mode, 'agent_directory')
  assert.match(plan.batches[0].content, /SMARTHUB_PI_DOCUMENT_WORKSPACE_BEGIN/u)
  assert.match(plan.batches[0].content, /"workspaceFileCount":2/u)
  assert.doesNotMatch(plan.batches[0].content, /用户可以取消待支付订单/u)
  assert.match(plan.batches[0].content, /payment\.md/u, 'currentInputRefs 路径属于元数据，应突出显示')
})

test('一次需求分析只执行一次 Pi Runtime，并直接持久化统一结果与三份 Artifact', async () => {
  const { response, store, runtimeCalls } = await successfulRun()
  assert.equal(runtimeCalls(), 1)
  assert.equal(response.result.requirementPoints.length, 2)
  assert.equal(response.result.findings.length, 2)
  assert.deepEqual(response.result.findings[0].requirementPointRefs, ['RP-001', 'RP-002'])
  assert.deepEqual(response.result.findings[1].requirementPointRefs, [])
  assert.equal(response.result.testFocus.length, 2)
  response.result.artifacts.forEach(artifact => {
    assert.equal(artifact.contentSha256, createHash('sha256').update(artifact.content).digest('hex'))
  })
  assert.match(response.result.artifacts[2].content, /# 需求分析报告/u)
  assert.match(response.result.artifacts[2].content, /## 8\. Test Focus/u)

  const run = (await store.snapshot()).reviewRuns[0]
  assert.equal(run.status, 'succeeded')
  assert.equal(run.step, 'requirement_understanding_ready')
  assert.equal(run.workflow?.currentStage, 'understanding')
  assert.equal(run.workflow?.automaticTransition?.status, 'pending')
  assert.equal(run.snapshot.agentDefinition.agentKey, 'planning')
  assert.equal(run.executions?.planning?.agentKey, 'planning')
  assert.deepEqual(Object.keys(run.executions ?? {}), ['planning'])
  assert.equal(run.execution?.agentKey, 'planning')
  assert.equal('extractionResult' in run, false)
})

test('统一 Pi Session 可读取原始需求并主动查询 Knowledge，来源范围保留事实边界', async () => {
  const { response } = await successfulRun()
  const execution = response.executions.planning
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
})

test('首轮存在 Blocking Clarification 时保持 waiting_clarification，人工回答后不重跑分析并直接冻结发布', async () => {
  const { store, runtimeCalls } = await successfulRun(blockingClarificationCandidate())
  const runId = (await store.snapshot()).reviewRuns[0].id
  const initial = (await store.snapshot()).reviewRuns[0]
  const clarificationId = initial.result!.clarifications[0].id
  assert.equal(initial.status, 'waiting_clarification')
  assert.equal(initial.step, 'waiting_clarification')
  assert.equal(initial.progress, 55)
  assert.equal(initial.workflow?.currentStage, 'clarification')
  assert.equal(runtimeCalls(), 1)

  const answers: unknown[] = []
  const tasks: Array<{ projectId: string; projectVersionId: string; task: string; taskType: string }> = []
  let unexpectedExecuteCalls = 0
  const service = new RequirementAnalysisService(store, {
    execute: async () => { unexpectedExecuteCalls += 1; throw new Error('Clarification 完成后不应再次执行需求分析 Agent') },
    appendPlanningClarification: async input => { answers.push(structuredClone(input)) },
    appendPlanningTask: async input => { tasks.push(structuredClone(input)) },
  })
  const automaticDesignCalls: string[] = []
  const workflow = new PlanningWorkflowService(store, {} as never, {
    appendPlanningTask: async input => { tasks.push(structuredClone(input)) },
  } as never, service, {
    createAutomaticDesignAndRun: async (_projectVersionId: string, sourceRunId: string) => {
      automaticDesignCalls.push(sourceRunId)
      return { design: { id: 'test-design-1' }, run: { id: 'test-design-run-1' } }
    },
  } as never)
  const listenerStates: Array<{ status: string; step: string; stage?: string; transition?: string }> = []
  service.onUnderstandingReady(async id => {
    const current = (await store.snapshot()).reviewRuns.find(run => run.id === id)!
    listenerStates.push({ status: current.status, step: current.step, stage: current.workflow?.currentStage, transition: current.workflow?.automaticTransition?.status })
    await workflow.requirementUnderstandingReady(id)
  })

  const resolved = await service.actOnClarifications(runId, {
    items: [{ clarificationId, action: 'answer', answer: '关闭失败时保持待支付，可由用户重试。' }],
    principal: { subjectId: 'reviewer', displayName: '评审人' },
  })

  assert.equal(answers.length, 1)
  assert.equal(unexpectedExecuteCalls, 0)
  assert.equal(runtimeCalls(), 1)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].taskType, 'test_design_after_requirement_release')
  assert.doesNotMatch(tasks[0].task, /Clarification 已经由人工处理/u)
  assert.deepEqual(listenerStates, [{ status: 'succeeded', step: 'requirement_understanding_ready', stage: 'understanding', transition: 'pending' }])
  assert.deepEqual(automaticDesignCalls, [runId])
  assert.equal(resolved.run.status, 'succeeded')
  assert.equal(resolved.run.workflow?.understandingSnapshot?.clarifications[0].status, 'answered')
  assert.equal(resolved.run.workflow?.automaticTransition?.status, 'succeeded')
  assert.equal(resolved.run.workflow?.automaticTransition?.testDesignRunId, 'test-design-run-1')

  const release = resolved.run.workflow?.release
  assert.equal(release?.status, 'published')
  const requirements = JSON.parse(release!.artifacts.find(item => item.fileName === 'requirements.json')!.content) as { formalClarifications: Array<{ answer: string }>; clarificationDispositionRecords: unknown[] }
  assert.deepEqual(requirements.formalClarifications.map(item => item.answer), ['关闭失败时保持待支付，可由用户重试。'])
  assert.deepEqual(requirements.clarificationDispositionRecords, [])
  assert.match(release!.artifacts.find(item => item.fileName === 'requirement-baseline.md')!.content, /Formal Business Fact/u)
  assert.match(release!.artifacts.find(item => item.fileName === 'requirement-baseline.md')!.content, /关闭失败时保持待支付/u)
  assert.match(resolved.run.response!.result.artifacts.find(item => item.fileName === 'requirement-analysis-findings.md')!.content, /Formal Business Fact/u)

  await assert.rejects(
    () => service.actOnClarifications(runId, { items: [{ clarificationId, action: 'answer', answer: '重复提交' }] }),
    /REQUIREMENT_UNDERSTANDING_ALREADY_FROZEN/u,
  )
})

test('dismissed Clarification 保留处置记录和事实缺口，但不作为正式业务事实', async () => {
  const { store, runtimeCalls } = await successfulRun(blockingClarificationCandidate())
  const runId = (await store.snapshot()).reviewRuns[0].id
  const clarificationId = (await store.snapshot()).reviewRuns[0].result!.clarifications[0].id
  let unexpectedExecuteCalls = 0
  const service = new RequirementAnalysisService(store, {
    execute: async () => { unexpectedExecuteCalls += 1; throw new Error('dismiss 后不应再次执行需求分析 Agent') },
    appendPlanningClarification: async () => undefined,
  })
  service.onUnderstandingReady(async id => { await service.freezeUnderstanding(id) })

  const resolved = await service.actOnClarifications(runId, {
    items: [{ clarificationId, action: 'dismiss', answer: '当前版本暂不定义关闭失败后的恢复范围，由人工记录风险。' }],
    principal: { subjectId: 'reviewer', displayName: '评审人' },
  })

  assert.equal(runtimeCalls(), 1)
  assert.equal(unexpectedExecuteCalls, 0)
  assert.equal(resolved.run.workflow?.understandingSnapshot?.clarifications[0].status, 'dismissed')
  const release = resolved.run.workflow?.release!
  const requirements = JSON.parse(release.artifacts.find(item => item.fileName === 'requirements.json')!.content) as { formalClarifications: unknown[]; clarificationDispositionRecords: Array<{ answer: string }> }
  assert.deepEqual(requirements.formalClarifications, [])
  assert.deepEqual(requirements.clarificationDispositionRecords.map(item => item.answer), ['当前版本暂不定义关闭失败后的恢复范围，由人工记录风险。'])
  const baseline = release.artifacts.find(item => item.fileName === 'requirement-baseline.md')!.content
  assert.match(baseline, /Human Disposition Only/u)
  assert.match(baseline, /不构成业务规则/u)
  assert.doesNotMatch(baseline, /Formal Business Fact[\s\S]*当前版本暂不定义关闭失败后的恢复范围/u)
})

test('未处理完全部 Blocking Clarification 时不进入 Understanding，也不执行新的 Agent 运行', async () => {
  const candidate = blockingClarificationCandidate()
  candidate.clarifications.push({ question: '关闭状态是否通知下游系统？', reason: '影响集成测试范围。', category: 'expected_result', requirementPointRefs: ['RP-002'], blocking: true })
  const { store, runtimeCalls } = await successfulRun(candidate)
  const runId = (await store.snapshot()).reviewRuns[0].id
  const clarificationId = (await store.snapshot()).reviewRuns[0].result!.clarifications[0].id
  let unexpectedExecuteCalls = 0
  const service = new RequirementAnalysisService(store, {
    execute: async () => { unexpectedExecuteCalls += 1; throw new Error('不完整回答不应执行 Agent') },
  })
  let listenerCalls = 0
  service.onUnderstandingReady(async () => { listenerCalls += 1 })

  await assert.rejects(
    () => service.actOnClarifications(runId, {
      items: [{ clarificationId, action: 'answer', answer: '关闭失败时保持待支付。' }],
    }),
    /CLARIFICATION_BATCH_INCOMPLETE/u,
  )
  const run = (await store.snapshot()).reviewRuns.find(item => item.id === runId)!
  assert.equal(run.status, 'waiting_clarification')
  assert.equal(run.workflow?.currentStage, 'clarification')
  assert.equal(runtimeCalls(), 1)
  assert.equal(unexpectedExecuteCalls, 0)
  assert.equal(listenerCalls, 0)
})

test('修复应用完成后停在待复验状态且不会自动创建复验运行', async () => {
  const { store } = await successfulRun()
  const repairedContent = '# 取消订单\n\n用户可以取消待支付订单，并统一记录关闭原因。'
  const repairedHash = createHash('sha256').update(repairedContent).digest('hex')
  let sourceRunId = ''
  let findingId = ''
  await store.transaction(state => {
    const run = state.reviewRuns[0]
    sourceRunId = run.id
    findingId = run.result!.findings[0].clientFindingId
    state.findingActions.push({
      id: 'finding-action-confirm', projectVersionId: run.projectVersionId, runId: run.id, findingId,
      action: 'confirm', fromState: 'open', toState: 'confirmed', actorId: 'reviewer', actorDisplayName: '评审人', version: 1, createdAt: '2026-08-12T00:02:00.000Z',
    })
    state.versions.push({ id: 'version-repaired', assetId: 'asset-1', number: 2, content: repairedContent, contentHash: repairedHash, status: 'ready', configVersionId: 'config-1', createdAt: '2026-08-12T00:03:00.000Z', readyAt: '2026-08-12T00:03:01.000Z', chunks: [] })
    state.assets.find(asset => asset.id === 'asset-1')!.activeVersionId = 'version-repaired'
    state.indexes.find(index => index.id === 'index-1')!.assetVersionIds.push('version-repaired')
    run.workflow = { currentStage: 'repair', repairDrafts: [{
      id: 'repair-draft-1', sourceRunId: run.id, status: 'applying',
      candidate: { schemaVersion: 'requirement-repair/v1', summary: '统一关闭原因', patches: [{ assetVersionId: 'version-1', before: '用户可以取消待支付订单。', after: '用户可以取消待支付订单，并统一记录关闭原因。', reason: '消除状态口径歧义', findingRefs: [findingId] }] },
      generationExecution: { agentKey: 'planning', workflowStage: 'repair', turns: 1, toolCalls: 1, events: [] },
      createdAt: '2026-08-12T00:02:30.000Z', createdBy: 'reviewer', approvedAt: '2026-08-12T00:02:45.000Z', approvedBy: 'reviewer',
      application: { items: [{ assetId: 'asset-1', sourceAssetVersionId: 'version-1', targetAssetVersionId: 'version-repaired', logicalPath: `${requirementDirectory}/cancel.md`, contentSha256: repairedHash }], startedAt: '2026-08-12T00:03:00.000Z' },
    }] }
  })
  const service = new RequirementAnalysisService(store, { execute: async () => { throw new Error('完成应用时不应执行 Agent') } })
  await assert.rejects(() => service.finalizeRepairAndStartVerification(sourceRunId, 'repair-draft-1'), /前置门禁/u)
  const applied = await service.finalizeRepairApplication(sourceRunId, 'repair-draft-1')
  const state = await store.snapshot()

  assert.equal(applied.status, 'applied')
  assert.ok(applied.application?.appliedAt)
  assert.equal(state.projectVersionRequirementBindings.find(binding => binding.assetId === 'asset-1')?.assetVersionId, 'version-repaired')
  assert.equal(state.findingActions.filter(action => action.findingId === findingId).at(-1)?.toState, 'needs_follow_up')
  assert.equal(state.reviewRuns.length, 1)
  assert.equal(state.reviewRuns.some(run => run.workflow?.verificationOf), false)
})

test('Requirement Repair 的 Verification 仍会对修复后的固定版本独立执行一次 Agent 复验', async () => {
  const { store, faux, runtime, runtimeCalls } = await successfulRun()
  const repairedContent = '# 取消订单\n\n用户可以取消待支付订单。\n关闭操作必须记录关闭原因。'
  const repairedHash = createHash('sha256').update(repairedContent).digest('hex')
  const repairedChunk = { id: 'chunk-repaired', chunkKey: 'cancel-repaired', assetVersionId: 'version-repaired', ordinal: 0, headingPath: ['取消订单'], content: '用户可以取消待支付订单。', contentHash: 'cancel-repaired-chunk-hash', tokenCount: 10, startLine: 3, endLine: 3, startChar: 8, endChar: 20, embedding: [], reused: false }
  let sourceRunId = ''
  let findingId = ''
  await store.transaction(state => {
    const run = state.reviewRuns[0]
    sourceRunId = run.id
    findingId = run.result!.findings[0].clientFindingId
    state.findingActions.push({
      id: 'finding-action-confirm', projectVersionId: run.projectVersionId, runId: run.id, findingId,
      action: 'confirm', fromState: 'open', toState: 'confirmed', actorId: 'reviewer', actorDisplayName: '评审人', version: 1, createdAt: '2026-08-12T00:02:00.000Z',
    })
    state.versions.push({ id: 'version-repaired', assetId: 'asset-1', number: 2, content: repairedContent, contentHash: repairedHash, status: 'ready', configVersionId: 'config-1', createdAt: '2026-08-12T00:03:00.000Z', readyAt: '2026-08-12T00:03:01.000Z', chunks: [repairedChunk] })
    state.assets.find(asset => asset.id === 'asset-1')!.activeVersionId = 'version-repaired'
    const index = state.indexes.find(item => item.id === 'index-1')!
    index.assetVersionIds.push('version-repaired')
    index.indexedChunks!.push({ ...repairedChunk, assetMetadata: { assetId: 'asset-1', displayName: '取消订单需求', assetType: 'requirement', sourceType: 'upload', logicalPath: `${requirementDirectory}/cancel.md` } })
    run.workflow = { currentStage: 'repair', repairDrafts: [{
      id: 'repair-draft-1', sourceRunId: run.id, status: 'applying',
      candidate: { schemaVersion: 'requirement-repair/v1', summary: '补齐关闭原因', patches: [{ assetVersionId: 'version-1', before: '用户可以取消待支付订单。', after: '用户可以取消待支付订单。\n关闭操作必须记录关闭原因。', reason: '补齐关闭原因', findingRefs: [findingId] }] },
      generationExecution: { agentKey: 'planning', workflowStage: 'repair', turns: 1, toolCalls: 1, events: [] },
      createdAt: '2026-08-12T00:02:30.000Z', createdBy: 'reviewer', approvedAt: '2026-08-12T00:02:45.000Z', approvedBy: 'reviewer',
      application: { items: [{ assetId: 'asset-1', sourceAssetVersionId: 'version-1', targetAssetVersionId: 'version-repaired', logicalPath: `${requirementDirectory}/cancel.md`, contentSha256: repairedHash }], startedAt: '2026-08-12T00:03:00.000Z' },
    }] }
  })

  const service = new RequirementAnalysisService(store, runtime)
  await service.finalizeRepairApplication(sourceRunId, 'repair-draft-1')
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('read', { path: 'branches/V1.0/input/requirements/cancel.md' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('read', { path: 'branches/V1.0/input/requirements/payment.md' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('knowledge_search', { query: '取消' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('knowledge_read_chunk', { chunkId: 'chunk-1' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('requirement_analysis_submit_result', verificationCandidate()), { stopReason: 'toolUse' }),
  ])

  const verification = await service.analyze({
    projectVersionId: 'project-version-1',
    documentDirectoryPath: requirementDirectory,
    sourceId: 'source-1',
    modelId: 'model-1',
    workflowStage: 'verification',
    verificationOf: { sourceRunId, repairDraftId: 'repair-draft-1' },
  })

  assert.equal(runtimeCalls(), 2)
  assert.equal(verification.status, 'candidate_validated')
  const persistedVerification = await service.get(verification.runId)
  assert.equal(persistedVerification.status, 'succeeded')
  assert.equal(persistedVerification.response?.execution.workflowStage, 'verification')
  assert.deepEqual(persistedVerification.workflow?.verificationOf, { sourceRunId, repairDraftId: 'repair-draft-1' })
  const state = await store.snapshot()
  assert.equal(state.reviewRuns.find(run => run.id === sourceRunId)?.workflow?.repairDrafts?.[0].status, 'verified')
  assert.equal(state.findingActions.filter(action => action.findingId === findingId).at(-1)?.toState, 'resolved')
})

async function successfulRun(candidate = analysisCandidate()) {
  const store = await seededStore()
  const resources = new AiResourceService(store, undefined, { reloadIntervalMs: 0 })
  await resources.initialize()
  const faux = fauxProvider()
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('read', { path: 'branches/V1.0/input/requirements/cancel.md' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('read', { path: 'branches/V1.0/input/requirements/payment.md' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('knowledge_search', { query: '取消' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('knowledge_read_chunk', { chunkId: 'chunk-1' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('requirement_analysis_submit_result', candidate), { stopReason: 'toolUse' }),
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
  return { response, store, faux, runtime, runtimeCalls: () => calls }
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
    clarifications: [],
    testFocus: [
      { title: '取消与超时竞态', description: '验证取消请求和超时任务并发时只有一个终态生效。', requirementPointRefs: ['RP-001', 'RP-002'] },
      { title: '整体异常恢复', description: '验证关闭失败后的提示、重试与状态一致性。', requirementPointRefs: [] },
    ],
    analysisDocument: '订单以待支付为起点，可由用户取消或超时任务关闭；两个关闭路径的终态、竞态与失败恢复需要统一定义。',
  }
}

function blockingClarificationCandidate(): CandidateRequirementAnalysisV1 {
  const candidate = analysisCandidate()
  candidate.clarifications = [{
    question: '订单关闭后的可恢复范围是什么？',
    reason: '影响异常路径测试正确性。',
    category: 'business_rule',
    requirementPointRefs: ['RP-001'],
    blocking: true,
  }]
  return candidate
}

function verificationCandidate(): CandidateRequirementAnalysisV1 {
  const candidate = analysisCandidate()
  candidate.summary = { ...candidate.summary, overallAssessment: 'pass', score: 100, risks: [] }
  candidate.findings = []
  candidate.testFocus = []
  return candidate
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
    state.modelSources.push({ id: 'source-1', name: '测试来源', providerType: 'openai_compatible', baseUrl: 'https://provider.example/v1', apiKey: 'secret', enabled: true, health: 'healthy', priority: 1, models: [{ id: 'model-1', name: 'analysis-model', displayName: 'Analysis Model', contextWindow: 32_768, maxOutputTokens: 4_096, capabilities: ['tool_calling'], enabled: true, health: 'healthy', qualityGate: { version: 'model-probe/v2', checkedAt: '2026-08-12T00:00:00.000Z', passed: true, sampleSha256: 'a'.repeat(64), inputCharacters: 8_000, checks: { connectivity: true, longContext: true, structuredSubmission: true, toolCalling: true } } }], createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' })
  })
  return store
}
