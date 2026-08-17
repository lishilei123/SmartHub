import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { defaultAgentDefinitionConfigDictionary } from '../server/agent/agent-definition-config.js'
import { PiAgentRuntimeAdapter } from '../server/agent/pi-agent-runtime.js'
import { createAgentDefinitionVersion } from '../server/agent/planning-agent.js'
import { PlanningWorkflowService } from '../server/application/planning-workflow-service.js'
import type { AgentExecutionInput, AgentModelConnection, PlanningTestDesignSnapshot, RequirementInputPlan } from '../server/domain/agent-types.js'
import { JsonStore } from '../server/infrastructure/store.js'

const workspaceToolIds = [
  'workspace.read_file',
  'workspace.grep_files',
  'workspace.find_files',
  'workspace.list_directory',
  'knowledge.search',
  'knowledge.read_chunk',
]

const requirementSubmit = 'requirement_analysis_submit_result'
const pointSubmit = 'test_design_points_submit_result'
const caseSubmit = 'test_design_cases_submit_result'

test('PlanningAgent System Prompt 只保留长期身份、事实与治理边界', () => {
  const prompt = defaultAgentDefinitionConfigDictionary.planning.systemPrompt
  assert.match(prompt, /同一个 Planning Session 中通过连续对话/u)
  assert.match(prompt, /优先理解当前最新任务/u)
  assert.match(prompt, /Runtime 当前暴露的工具和 Submit Tool 是执行权限边界/u)
  assert.match(prompt, /正式 Requirement、Clarification、Release、TestPoint、TestCase/u)
  assert.doesNotMatch(prompt, /需求分析步骤|测试点设计步骤|测试用例设计步骤|RequirementPoint 生成方式|Finding 生成方法|TestCase 生成方法/u)
  assert.doesNotMatch(prompt, /只执行当前 Stage|当前 Stage 唯一|上一阶段已经失效/u)
})

test('PlanningWorkflow 按正式 Gate 分两轮发送测试点与测试用例任务', async () => {
  const store = new JsonStore(null)
  await store.load()
  await store.transaction(state => {
    state.projects.push({ id: 'project-1', name: '循环对话项目', createdAt: '2026-08-17T00:00:00.000Z' })
    state.projectVersions.push({
      id: 'project-version-1',
      projectId: 'project-1',
      name: 'V1',
      status: 'open',
      requirementReleaseBinding: { releaseId: 'release-1', verificationRunId: 'requirement-run-1', requirementsJsonSha256: 'a'.repeat(64), boundAt: '2026-08-17T00:00:00.000Z' },
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z',
    })
    state.reviewRuns.push({
      id: 'requirement-run-1',
      projectVersionId: 'project-version-1',
      status: 'succeeded',
      workflow: { currentStage: 'release', release: { id: 'release-1', status: 'published', verificationRunId: 'requirement-run-1', contentSha256: 'b'.repeat(64) } },
    } as never)
    state.testDesignState = {
      designs: [],
      runs: [{
        id: 'test-design-run-1',
        projectVersionId: 'project-version-1',
        testPointTree: {
          currentApprovedVersionId: 'tree-version-1',
          versions: [{ id: 'tree-version-1', treeSha256: 'c'.repeat(64) }],
        },
      }],
    } as never
  })
  const tasks: Array<{ projectId: string; projectVersionId: string; task: string; taskType: string; metadata?: Record<string, unknown> }> = []
  const checkpoints: string[] = []
  const runtime = {
    appendPlanningTask: async (input: typeof tasks[number]) => {
      tasks.push(structuredClone(input))
      return { parentSessionId: 'planning-session-1' }
    },
    queueCompactionCheckpoint: (_scopeKey: string, checkpoint: string) => { checkpoints.push(checkpoint) },
  }
  const testDesign = {
    createAutomaticDesignAndRun: async () => ({ design: { id: 'test-design-1' }, run: { id: 'test-design-run-1' } }),
  }
  const workflow = new PlanningWorkflowService(store, {} as never, runtime as never, {} as never, testDesign as never)

  await workflow.requirementReleasePublished('requirement-run-1')
  await workflow.testPointsValidated('project-version-1', 'test-design-run-1', 'tree-version-1')

  assert.deepEqual(tasks.map(task => task.taskType), [
    'test_design_after_requirement_release',
    'test_case_design_after_test_points_validated',
  ])
  assert.match(tasks[0].task, /Requirement Release 已正式发布/u)
  assert.match(tasks[0].task, /开始设计测试点/u)
  assert.doesNotMatch(tasks[0].task, /测试用例编写|编写测试用例/u)
  assert.match(tasks[1].task, /测试点已经完成并通过服务端校验/u)
  assert.match(tasks[1].task, /基于已批准的 TestPointTreeVersion 编写测试用例/u)
  assert.deepEqual(checkpoints, ['test_points_validated'])
})

test('同一 Planning Session 通过连续任务推进需求、测试点、测试用例与 resynthesize，并逐轮收窄 Submit Tool', async () => {
  const store = new JsonStore(null)
  await store.load()
  const provider = fauxProvider()
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall(requirementSubmit, requirementCandidate('首次分析')), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall(requirementSubmit, requirementCandidate('Clarification 后续')), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall(pointSubmit, pointCandidate()), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall(caseSubmit, caseCandidate('首次用例')), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall(caseSubmit, caseCandidate('重新生成用例')), { stopReason: 'toolUse' }),
  ])
  const requests: Array<{ tools: string[]; messages: string }> = []
  const providerStream = provider.provider.streamSimple.bind(provider.provider) as StreamFn
  const streamFn: StreamFn = (model, context, options) => {
    requests.push({
      tools: (context.tools ?? []).map(tool => tool.name),
      messages: JSON.stringify(context.messages),
    })
    return providerStream(model, context, options)
  }
  const runtime = new PiAgentRuntimeAdapter(store, {
    model: provider.getModel() as Model<Api>,
    streamFn,
  })
  const definition = planningDefinition()
  const model = planningModel()
  const sessionIds: string[] = []

  sessionIds.push(await executeRound(runtime, definition, model, 'analysis', 'requirement-analysis.submit_result', 'requirement-analysis/v1', '分析当前需求'))

  await runtime.appendPlanningTask({
    projectId: 'project-1',
    projectVersionId: 'project-version-1',
    taskType: 'requirement_analysis_after_clarifications',
    task: '这些 Clarification 已经由人工处理，请继续当前需求分析工作。',
  })
  sessionIds.push(await executeRound(runtime, definition, model, 'analysis', 'requirement-analysis.submit_result', 'requirement-analysis/v1', '结合正式 Clarification 回答继续完善需求理解'))

  await runtime.appendPlanningTask({
    projectId: 'project-1',
    projectVersionId: 'project-version-1',
    taskType: 'test_design_after_requirement_release',
    task: '需求分析已经完成，Requirement Release 已正式发布。请继续当前测试策划工作，开始设计测试点。',
  })
  sessionIds.push(await executeRound(runtime, definition, model, 'test_point_design', 'test_design_points.submit_result', 'test-point-design/v1', '基于正式 Requirement Release 和冻结 Workspace 设计测试点'))

  await runtime.appendPlanningTask({
    projectId: 'project-1',
    projectVersionId: 'project-version-1',
    taskType: 'test_case_design_after_test_points_validated',
    task: '测试点已经完成并通过服务端校验。请继续当前测试策划工作，基于已批准的 TestPointTreeVersion 编写测试用例。',
  })
  sessionIds.push(await executeRound(runtime, definition, model, 'test_case_design', 'test_design_cases.submit_result', 'test-case-design/v1', '基于已批准 TestPointTreeVersion 编写测试用例'))

  await runtime.appendPlanningTask({
    projectId: 'project-1',
    projectVersionId: 'project-version-1',
    taskType: 'test_case_resynthesize',
    task: '当前已批准 TestPointTreeVersion 保持不变，请重新生成测试用例。',
  })
  sessionIds.push(await executeRound(runtime, definition, model, 'test_case_design', 'test_design_cases.submit_result', 'test-case-design/v1', '重新生成完整测试用例候选'))

  assert.equal(new Set(sessionIds).size, 1, '所有任务必须复用同一个 Planning Session ID')
  assert.equal(requests.length, 5)
  assert.deepEqual(requests.map(request => submitTools(request.tools)), [
    [requirementSubmit],
    [requirementSubmit],
    [pointSubmit],
    [caseSubmit],
    [caseSubmit],
  ])
  assert.match(requests[1].messages, /Clarification 已经由人工处理/u)
  assert.match(requests[2].messages, /Requirement Release 已正式发布/u)
  assert.match(requests[3].messages, /TestPointTreeVersion 编写测试用例/u)
  assert.match(requests[4].messages, /TestPointTreeVersion 保持不变，请重新生成测试用例/u)
  assert.ok(!requests[3].tools.includes(requirementSubmit) && !requests[3].tools.includes(pointSubmit))
  assert.ok(!requests[4].tools.includes(requirementSubmit) && !requests[4].tools.includes(pointSubmit))
})

async function executeRound(
  runtime: PiAgentRuntimeAdapter,
  definition: ReturnType<typeof planningDefinition>,
  model: AgentModelConnection,
  workflowStage: NonNullable<AgentExecutionInput['executionProfile']>['workflowStage'],
  submitToolId: string,
  schemaVersion: string,
  initialTask: string,
) {
  const output = await runtime.execute({
    snapshot: planningSnapshot(definition),
    model,
    requirementInputPlan: inputPlan(),
    executionProfile: {
      mode: 'workspace_tools',
      workflowStage,
      allowedToolIds: [...workspaceToolIds, submitToolId],
      submitToolId,
      schemaVersion,
      agentLabel: 'PlanningAgent',
      initialTask,
      validateCandidate: async candidate => ({ valid: true, result: candidate, issues: [] }),
    },
  }, new AbortController().signal)
  assert.ok(output.context?.sessionId)
  const submitted = output.events.filter(event => event.type === 'tool_execution_end' && event.toolId?.endsWith('_submit_result'))
  assert.equal(submitted.length, 1)
  return output.context.sessionId
}

function planningDefinition() {
  const config = defaultAgentDefinitionConfigDictionary.planning
  return createAgentDefinitionVersion({
    agentKey: 'planning',
    agentType: 'planning',
    resultSchemaVersion: 'planning/v1',
    modelScene: 'planning',
    version: config.version,
    systemPrompt: config.systemPrompt,
    taskTemplate: config.taskTemplate,
    promptKey: config.promptKey,
    tools: [
      ...workspaceToolIds.map(toolId => `${toolId}@1.0.0`),
      'requirement-analysis.submit_result@1.0.0',
      'test_design_points.submit_result@1.0.0',
      'test_design_cases.submit_result@1.1.0',
    ],
    limits: { ...config.limits, maxTurns: 8, maxToolCalls: 8, deadlineMs: 30_000 },
  })
}

function planningSnapshot(agentDefinition: ReturnType<typeof planningDefinition>): PlanningTestDesignSnapshot {
  const createdAt = '2026-08-17T00:00:00.000Z'
  return {
    runId: 'planning-conversation-run',
    projectId: 'project-1',
    projectName: '循环对话项目',
    projectVersionId: 'project-version-1',
    projectVersionName: 'V1',
    knowledgeBaseId: 'knowledge-base-1',
    indexVersionId: 'index-1',
    assets: [],
    currentInputRefs: [],
    documentWorkspace: {
      mode: 'agent_directory',
      logicalPath: 'workspace',
      rootLogicalPath: 'workspace',
      activeBranchLogicalPath: 'workspace/branches/V1',
      branchLogicalPaths: ['workspace/branches/V1'],
      agentLogicalPath: 'workspace/agent_workspace/planning_agent',
      layoutVersion: 'workspace/v1',
      candidateAssetVersionIds: [],
    },
    workspaceFiles: [],
    workspaceSnapshot: {
      schemaVersion: 'project-workspace-snapshot/v1',
      projectId: 'project-1',
      projectVersionId: 'project-version-1',
      rootLogicalPath: 'workspace',
      activeBranchLogicalPath: 'workspace/branches/V1',
      agentLogicalPath: 'workspace/agent_workspace/planning_agent',
      projectVersionName: 'V1',
      knowledgeBaseId: 'knowledge-base-1',
      indexVersionId: 'index-1',
      requirementReleaseId: 'release-1',
      verificationRunId: 'verification-run-1',
      requirementsJsonSha256: 'a'.repeat(64),
      files: [],
      createdAt,
      snapshotSha256: 'b'.repeat(64),
    },
    agentDefinition,
    taskSha256: 'c'.repeat(64),
    createdAt,
  }
}

function planningModel(): AgentModelConnection {
  return {
    sourceId: 'source-1',
    providerType: 'openai_compatible',
    baseUrl: 'https://provider.example/v1',
    apiKey: 'test-key',
    modelId: 'model-1',
    modelName: 'planning-model',
    contextWindow: 32_768,
    maxOutputTokens: 4_096,
    supportsReasoning: false,
  }
}

function inputPlan(): RequirementInputPlan {
  const content = '本轮正式输入均通过固定 Workspace 和 Service 状态提供。'
  return {
    policyVersion: 'planning-conversation-test/v1',
    mode: 'agent_directory',
    estimatedInputTokens: 20,
    safeInputBudget: 1_000,
    packageSha256: sha256(content),
    batches: [{
      batchId: 'planning-conversation-batch',
      ordinal: 0,
      tokenCount: 20,
      assetVersionIds: [],
      chunkIds: [],
      content,
    }],
  }
}

function requirementCandidate(label: string) {
  return {
    summary: { overview: `${label}形成完整需求理解。`, businessGoals: [], overallAssessment: 'pass', score: 100, strengths: [], risks: [] },
    requirementPoints: [{ id: 'RP-001', title: '核心需求', description: '用户可以完成核心业务操作。', sourceTexts: ['用户可以完成核心业务操作。'] }],
    findings: [],
    clarifications: [],
    testFocus: [{ title: '核心流程', description: '验证核心业务流程。', requirementPointRefs: ['RP-001'] }],
    analysisDocument: `${label}需求分析。`,
  }
}

function pointCandidate() {
  return {
    schemaVersion: 'test-point-design/v1',
    nodes: [{
      ref: 'point-1',
      title: '核心流程测试点',
      objective: '验证核心业务流程',
      dimension: 'functional',
      priority: 'P0',
      applicability: 'applicable',
      designTechniques: ['主流程'],
      entryMethods: ['ui'],
      oracle: '结果符合正式需求',
      dataConditions: [],
      risks: [],
      assumptions: [],
      basisRefs: ['requirement-1'],
      historicalRefs: [],
    }],
    findings: [],
    confirmationItems: [],
  }
}

function caseCandidate(title: string) {
  return {
    schemaVersion: 'test-case-design/v1',
    cases: [{
      ref: 'case-1',
      schemaVersion: 'test-case/v2',
      title,
      objective: '验证已批准测试点',
      dimension: 'functional',
      testPointIds: ['test-point-1'],
      priority: 'P0',
      preconditions: [],
      dataRequirementIds: [],
      cleanup: [],
      dependencies: [],
      executionMethods: [],
      executionSpec: {
        kind: 'functional',
        method: 'ui',
        steps: [{ key: 'step-1', action: '执行核心操作', expected: '结果符合正式需求' }],
        verificationChecks: [{ key: 'check-1', description: '核心结果正确' }],
        preconditions: [],
        testDataRequirements: [],
        executionReadiness: 'ready',
        automationHint: '使用 UI 自动化',
      },
      sharedVerificationChecks: [],
      tags: ['regression'],
      domain: '核心业务',
    }],
    dataRequirements: [],
    findings: [],
    confirmationItems: [],
    proposals: [],
  }
}

function submitTools(tools: string[]) {
  return tools.filter(tool => tool.endsWith('_submit_result'))
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
