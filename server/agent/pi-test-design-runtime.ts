import { createHash } from 'node:crypto'
import type { AgentConfigurationService } from '../application/agent-configuration-service.js'
import { builtInToolBindingToken, toolBindingToken, toolsetContentHash } from '../application/ai-resource-hash.js'
import { canonicalJson, canonicalSha256 } from '../application/canonical-json.js'
import { buildTestDesignDirectoryInputPlan } from './requirement-context-assembler.js'
import type { PlanningAgentRuntime } from '../application/test-design-service.js'
import { TestDesignError, validateTestCaseDesignCandidate, type TestCaseDesignCandidate, type TestCaseDesignCandidateSubmission, type TestDataRequirementCandidate } from '../application/test-design-validation.js'
import type { AgentConfigurationVersion, AgentModelReference, DatabaseState, GenerativeModel, GenerativeModelSource, ToolResource } from '../domain/types.js'
import { activeRequirementReleaseBinding, requirementReleaseBindings } from '../domain/requirement-release-bindings.js'
import type { AgentExecutionContext, AgentExecutionEvent, AgentExecutionOutput, AgentModelConnection, InputDeliveryManifest, PlanningTestDesignSnapshot } from '../domain/agent-types.js'
import type { TestDesign, TestDesignRunAgentConfigurationSnapshot, TestDesignWorkflowRun, TestDesignWorkspaceFile, TestDesignWorkspaceSnapshot } from '../domain/test-design-types.js'
import type { StateStore } from '../infrastructure/store.js'
import { safeWorkspaceSegment } from '../application/project-workspace-snapshot.js'
import { piVersion, type PiAgentRuntimeAdapter } from './pi-agent-runtime.js'
import { defaultBuiltInToolConfigResolver } from '../tools/built-in-tool-config.js'

const WORKSPACE_TOOL_IDS = ['workspace.read_file', 'workspace.grep_files', 'workspace.find_files', 'workspace.list_directory', 'knowledge.search', 'knowledge.read_chunk'] as const

export const TEST_DESIGN_STAGE_BINDINGS = {
  test_case_design: {
    submitToolId: 'test_design_cases.submit_result',
    schemaVersion: 'test-case-design/v1',
  },
  test_design_repair: {
    submitToolId: 'test_design_repair.submit_result',
    schemaVersion: 'test-design-repair/v1',
  },
} as const

type TestDesignStage = keyof typeof TEST_DESIGN_STAGE_BINDINGS
const ALL_SUBMISSION_TOOLS = Object.values(TEST_DESIGN_STAGE_BINDINGS).map(item => item.submitToolId)

export class PiTestDesignRuntimeAdapter implements PlanningAgentRuntime {
  constructor(private readonly store: StateStore, private readonly piRuntime: PiAgentRuntimeAdapter, private readonly configurations: AgentConfigurationService) {}

  async appendTask(input: { projectVersionId: string; taskType: string; task: string; metadata?: Record<string, unknown> }) {
    const state = await this.store.snapshot()
    const projectVersion = state.projectVersions.find(item => item.id === input.projectVersionId)
    if (!projectVersion) throw new Error('PROJECT_VERSION_NOT_FOUND')
    return this.piRuntime.appendPlanningTask({
      projectId: projectVersion.projectId,
      projectVersionId: projectVersion.id,
      taskType: input.taskType,
      task: input.task,
      metadata: input.metadata,
    })
  }

  async readiness(projectVersionId?: string, requirementReleaseId?: string) {
    const agentKey = 'planning'
    const state = await this.store.snapshot()
    const projectVersion = projectVersionId ? state.projectVersions.find(item => item.id === projectVersionId) : undefined
    const binding = projectVersion
      ? requirementReleaseId ? requirementReleaseBindings(projectVersion).find(item => item.releaseId === requirementReleaseId) : activeRequirementReleaseBinding(projectVersion)
      : undefined
    const verificationRun = binding
      ? state.reviewRuns.find(item => item.id === binding.verificationRunId)
      : undefined
    const configurationId = verificationRun?.snapshot.agentConfigurationRef?.id
    const configuration = configurationId
      ? await this.configurations.resolveVersion(configurationId)
      : await this.configurations.resolveActive(agentKey)
    if (!configuration) return { ready: false, agents: [{ agentKey, ready: false, reason: '未发布 PlanningAgent 配置' }] }
    try {
      validateConfiguration(configuration, state)
      return { ready: true, agents: [{ agentKey, ready: true }] }
    } catch (error) {
      return { ready: false, agents: [{ agentKey, ready: false, reason: error instanceof Error ? error.message : String(error) }] }
    }
  }

  async freezeConfiguration(projectVersionId: string, requirementReleaseId?: string): Promise<TestDesignRunAgentConfigurationSnapshot> {
    const state = await this.store.snapshot()
    const projectVersion = state.projectVersions.find(item => item.id === projectVersionId)
    const binding = projectVersion
      ? requirementReleaseId ? requirementReleaseBindings(projectVersion).find(item => item.releaseId === requirementReleaseId) : activeRequirementReleaseBinding(projectVersion)
      : undefined
    const verificationRun = state.reviewRuns.find(item => item.id === binding?.verificationRunId)
    const configurationId = verificationRun?.snapshot.agentConfigurationRef?.id
    if (!configurationId) throw new Error('TEST_DESIGN_AGENT_NOT_READY: Requirement Release 未绑定固定 PlanningAgent 配置')
    const configuration = await this.configurations.resolveVersion(configurationId)
    validateConfiguration(configuration, state)
    const model = resolveModel(state, configuration)
    const createdAt = new Date().toISOString()
    const base = {
      configurationId: configuration.id,
      configurationVersion: configuration.version,
      configurationSha256: configuration.contentSha256,
      agentDefinition: structuredClone(configuration.agentDefinition),
      routing: structuredClone(configuration.routing),
      primaryModel: {
        sourceId: model.sourceId,
        providerType: model.providerType,
        modelId: model.modelId,
        modelName: model.modelName,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        supportsReasoning: model.supportsReasoning,
      },
      createdAt,
    }
    return { ...base, snapshotSha256: canonicalSha256(base) }
  }

  async execute(input: Parameters<PlanningAgentRuntime['execute']>[0], signal: AbortSignal): Promise<Awaited<ReturnType<PlanningAgentRuntime['execute']>>> {
    const stage = input.stage as TestDesignStage
    const binding = TEST_DESIGN_STAGE_BINDINGS[stage]
    const configuration = await this.configurations.resolveVersion(input.run.agentConfigurationSnapshot.configurationId)
    if (configuration.contentSha256 !== input.run.agentConfigurationSnapshot.configurationSha256 || canonicalSha256(configuration.agentDefinition) !== canonicalSha256(input.run.agentConfigurationSnapshot.agentDefinition)) throw new Error('TEST_DESIGN_AGENT_CONFIGURATION_DRIFT: Run 固定的 Agent 配置版本不一致')
    const state = await this.store.snapshot()
    validateConfiguration(configuration, state)
    const model = resolveModel(state, configuration)
    const frozenModel = input.run.agentConfigurationSnapshot.primaryModel
    if (
      model.sourceId !== frozenModel.sourceId
      || model.providerType !== frozenModel.providerType
      || model.modelId !== frozenModel.modelId
      || model.modelName !== frozenModel.modelName
      || model.contextWindow !== frozenModel.contextWindow
      || model.maxOutputTokens !== frozenModel.maxOutputTokens
      || model.supportsReasoning !== frozenModel.supportsReasoning
    ) throw new Error('TEST_DESIGN_AGENT_MODEL_DRIFT: Run 固定的模型路由或能力不一致')
    const design = state.testDesignState?.designs.find(item => item.id === input.run.testDesignId && item.projectVersionId === input.run.projectVersionId)
    if (!design) throw new Error('TEST_DESIGN_INPUT_NOT_FOUND: 测试设计定义不存在')
    const workspace = stageWorkspace(input.run, stage)
    const task = buildPlanningTestDesignTask(input.run, design, stage, workspace)
    const snapshot = buildAgentSnapshot(state, input.run, workspace, configuration, task)
    const inputPlan = buildTestDesignDirectoryInputPlan({ workspace, definition: configuration.agentDefinition, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens })
    const events: AgentExecutionEvent[] = []
    try {
      const output = await this.piRuntime.execute({
        snapshot,
        model,
        requirementInputPlan: inputPlan,
        executionProfile: {
          mode: 'workspace_tools',
          workflowStage: stage,
          allowedToolIds: [...WORKSPACE_TOOL_IDS, binding.submitToolId],
          submitToolId: binding.submitToolId,
          schemaVersion: binding.schemaVersion,
          agentLabel: 'PlanningAgent',
          initialTask: task,
          validateCandidate: async candidate => validateStageCandidate(stage, candidate, input.run),
        },
        onEvent: event => { events.push(event) },
      }, signal)
      return {
        schemaVersion: binding.schemaVersion,
        content: projectTestCaseCandidateSubmission(output.candidate as TestCaseDesignCandidate),
        execution: executionRecord(stage, configuration.agentDefinition.version, model.modelName, output.events, output.turns, output.toolCalls, output.toolErrors, output.framework, output.context, output.inputDeliveryManifest),
      }
    } catch (error) {
      const failure = new Error(error instanceof Error ? error.message : String(error), { cause: error }) as Error & { execution?: ReturnType<typeof executionRecord> }
      failure.execution = executionRecord(stage, configuration.agentDefinition.version, model.modelName, events)
      throw failure
    }
  }
}

export function buildPlanningTestDesignTask(run: TestDesignWorkflowRun, design: TestDesign, stage: TestDesignStage, workspace: TestDesignWorkspaceSnapshot) {
  const binding = TEST_DESIGN_STAGE_BINDINGS[stage]
  const repairState = stage === 'test_design_repair' ? run.automaticRepair : undefined
  const repairAudit = repairState?.triggerAuditId ? run.coverageAudits.find(item => item.id === repairState.triggerAuditId) : undefined
  if (stage === 'test_design_repair' && (!repairState || !repairAudit)) throw new TestDesignError('TEST_DESIGN_REPAIR_CONTEXT_INVALID', '自动修复任务缺少固定的修复状态或 Coverage Audit', 409)
  return canonicalJson({
    schemaVersion: 'test-design-agent-task/v1',
    agent: 'PlanningAgent',
    currentBusinessState: stage,
    runId: run.id,
    projectVersionId: run.projectVersionId,
    requirementRelease: { releaseId: run.basisSnapshot.requirementReleaseId, verificationRunId: run.basisSnapshot.verificationRunId, requirementsJsonSha256: run.basisSnapshot.requirementsJsonSha256, clarificationCount: run.basisSnapshot.clarifications?.length ?? 0 },
    workspace: { root: '/workspace', activeBranch: `/${workspace.activeBranchLogicalPath}`, agentDirectory: `/${workspace.agentLogicalPath}`, snapshotSha256: workspace.snapshotSha256 },
    currentInputRefs: run.currentInputRefs.map(item => ({ logicalPath: item.logicalPath.replace(/^workspace\//u, ''), assetVersionId: item.assetVersionId, contentSha256: item.contentSha256 })),
    design: { name: design.name, objective: design.objective, includedScopes: design.input.includedScopes ?? [], excludedScopes: design.input.excludedScopes ?? [], focusDimensions: design.input.focusDimensions ?? [], executionMethods: design.input.executionMethods ?? [], userCoverageObjectives: design.input.userCoverageObjectives ?? [], historicalLibrarySelection: design.input.historicalLibrarySelection ?? { mode: 'latest_library' }, frozenHistoricalCaseCount: run.historicalSnapshot.items.length },
    agentCapabilities: { enabledSkills: run.agentConfigurationSnapshot.agentDefinition.enabledSkills },
    runtimeBoundary: { submitTool: binding.submitToolId, schemaVersion: binding.schemaVersion },
    task: testDesignTaskMessage(stage),
    ...(repairState && repairAudit ? { repair: { attempt: repairState.attempt, maxAttempts: repairState.maxAttempts, auditId: repairAudit.id, blockers: repairAudit.blockers.filter(item => item.resolution === 'agent_repair'), currentCandidatePath: '/workspace/agent_workspace/planning_agent/current-test-cases.json' } } : {}),
    instructions: testDesignStageInstructions(stage),
  })
}

function testDesignTaskMessage(stage: TestDesignStage) {
  if (stage === 'test_case_design') {
    return 'Requirement Release 已正式发布。请继续当前测试策划工作，直接基于正式 Requirement、Clarification 和冻结 Workspace 设计完整测试用例。'
  }
  return 'Coverage Audit 已识别可由 Agent 修复的候选问题。请继续当前测试策划工作，修复任务中列出的 agent_repair blockers，并保持其他候选语义稳定。'
}

function testDesignStageInstructions(stage: TestDesignStage) {
  const binding = TEST_DESIGN_STAGE_BINDINGS[stage]
  const stageRules = stage === 'test_case_design'
    ? [
          'Requirement Release 是本轮唯一正式覆盖基线；本轮交付测试用例、测试数据需求和用例库变更 Proposal。每条用例必须使用 requirementRefs 直接关联至少一个 Requirement。',
          '每个 functional/security Candidate Case 都必须提供至少一条根级 scenarioClaims。ScenarioClaim 只说明一个可独立判定的 Atomic Test Intent：使用临时 caseRef、Requirement 子集、kind、subject、variant、polarity、明确 oracle，以及可选 knowledgeRefs；它不是 TestPoint，不会获得正式 ID、Revision、Version 或发布。',
          '功能和安全用例的执行步骤、检查点、就绪状态及自动化提示只在 executionMethods 的对应 UI/API 方式中完整填写。executionSpec 对此类用例只提交 kind=functional 与同一 method；服务端会从 executionMethods 和用例根字段投影正式 executionSpec。不要提交第二份重复步骤。',
          '非功能 executionSpec 必须使用精确字段：performance 为 kind=performance、method=performance_tool、target、scenario、virtualUsers、duration、rampUp、thresholds、dataStrategy、environmentRequirements、executionReadiness；stability 为 kind=stability、method=long_running、workload、duration、interval、observations、recoveryPolicy、checkpointPolicy、environmentRequirements、executionReadiness；compatibility 为 kind=compatibility、method=environment_matrix、baseMethod、baseCaseRefs、browserMatrix、operatingSystemMatrix、viewportMatrix、versionMatrix、expectedConsistency、executionReadiness。cases[] 根对象和 executionSpec 都不得添加这些列表之外的自定义字段。',
          '性能 thresholds 必须是数组；每一项严格且仅为 { metric, target, sourceRef }，三者都是非空字符串。把比较符、数值、单位和适用范围合并写进 target；不得使用 operator、value、unit，也不得提交缺少其中任一字段的半成品阈值。若没有正式阈值，提交 thresholds: []、executionReadiness: needs_confirmation，并建立 blocker Confirmation Item。',
        ]
      : ['当前 Coverage Audit 中 resolution=agent_repair 的 blockers 是本轮修复范围；正式 Requirement 保持不变。遇到 TEST_CASE_OVER_MERGED 时，依据 blocker.details 和 current-test-cases.json 中的 scenarioClaims 拆分 Candidate Case，并将每条 ScenarioClaim 重新指向承担该独立 Atomic Test Intent 的 caseRef。']
  return [
    ...stageRules,
    '提交 cases[] 时，每一项必须是扁平的 test-case/v2 对象：ref、schemaVersion、title、requirementRefs、executionMethods、executionSpec 等字段同级。禁止使用 { ref, content: {...} } 包装。',
    'Runtime 实际暴露的工具、结果 Schema 和 Submit Tool 是本轮执行权限边界。',
    'Workflow 只推进业务流程，不调度 Skill；PlanningAgent 查看 Enabled Skill Catalog，并按当前任务自主决定是否通过 skill.read 读取所需方法正文。',
    'currentInputRefs 是重点输入，不是读取白名单；先读取重点输入，再按需使用 ls、find、grep、read 浏览完整冻结 Workspace。',
    'requirements/clarifications.json 中 answered 是正式事实；dismissed 只是处置理由，不得转化为断言，相关缺口必须保留。',
    '若存在 historical-test-cases.json，必须读取并判断复用、修改、新增或废弃；历史资料不能覆盖当前 Requirement Release。',
    '不得编造阈值、时长、兼容矩阵、接口、定位器、账号、环境或 Expected Result。',
    'PlanningAgent 只生成语义候选；正式 ID、Revision、Version、Hash 和数据库状态由 Service / Validator 管理。',
    `完成 Self Review 后，通过 ${binding.submitToolId} 提交一个完整 ${binding.schemaVersion} 候选；若服务端拒绝，根据错误路径修正后重新提交。`,
  ]
}

function stageWorkspace(run: TestDesignWorkflowRun, stage: TestDesignStage): TestDesignWorkspaceSnapshot {
  const byPath = new Map(run.workspaceSnapshot.files.map(file => [file.logicalPath, structuredClone(file)]))
  for (const file of run.formalWorkspaceFiles) byPath.set(file.logicalPath, structuredClone(file))
  if (stage === 'test_design_repair') {
    const content = repairCandidateContent(run)
    const file: TestDesignWorkspaceFile = { logicalPath: 'workspace/agent_workspace/planning_agent/current-test-cases.json', sourceType: 'run_candidate', sourceId: `${run.id}:repair:${run.automaticRepair?.attempt ?? 0}`, contentSha256: canonicalSha256(content), content: `${canonicalJson(content)}\n`, displayName: 'current-test-cases.json', sourceScope: 'formal_output' }
    file.contentSha256 = sha256Text(file.content)
    byPath.set(file.logicalPath, file)
  }
  const files = [...byPath.values()].sort((left, right) => left.logicalPath.localeCompare(right.logicalPath, 'zh-CN'))
  const base = {
    schemaVersion: run.workspaceSnapshot.schemaVersion,
    projectId: run.workspaceSnapshot.projectId,
    projectVersionId: run.workspaceSnapshot.projectVersionId,
    rootLogicalPath: run.workspaceSnapshot.rootLogicalPath,
    activeBranchLogicalPath: run.workspaceSnapshot.activeBranchLogicalPath,
    agentLogicalPath: run.workspaceSnapshot.agentLogicalPath,
    projectVersionName: run.workspaceSnapshot.projectVersionName,
    knowledgeBaseId: run.workspaceSnapshot.knowledgeBaseId,
    indexVersionId: run.workspaceSnapshot.indexVersionId,
    requirementReleaseId: run.workspaceSnapshot.requirementReleaseId,
    verificationRunId: run.workspaceSnapshot.verificationRunId,
    requirementsJsonSha256: run.workspaceSnapshot.requirementsJsonSha256,
    files,
    createdAt: run.workspaceSnapshot.createdAt,
  } satisfies Omit<TestDesignWorkspaceSnapshot, 'snapshotSha256'>
  return { ...base, snapshotSha256: canonicalSha256(base) }
}

function repairCandidateContent(run: TestDesignWorkflowRun) {
  const activeCases = run.testCases.filter(item => !item.tombstonedAt)
  const refById = new Map(activeCases.map(item => [item.id, item.candidateRef ?? `case-${item.id}`]))
  const dataSet = run.dataSetVersions.at(-1)
  return {
    schemaVersion: 'test-design-repair-input/v1',
    cases: activeCases.map(testCase => {
      const revision = testCase.revisions.find(item => item.revision === testCase.currentRevision)!
      return { ref: requiredRepairCaseRef(refById, testCase.id), ...revision.content, dependencies: revision.content.dependencies.map(id => refById.get(id) ?? id), dataRequirementIds: [] }
    }),
    scenarioClaims: structuredClone(run.scenarioClaims ?? []),
    dataRequirements: (dataSet?.requirements ?? []).map((item, index): TestDataRequirementCandidate => ({
      ref: `data-${index + 1}`,
      name: item.name,
      entityType: item.entityType,
      featureTags: [...item.featureTags],
      ...(item.requirementRefs?.length ? { requirementRefs: [...item.requirementRefs] } : {}),
      caseRefs: item.caseIds.map(id => refById.get(id) ?? id),
      fieldConstraints: structuredClone(item.fieldConstraints),
      relationships: [...item.relationships],
      quantity: item.quantity,
      initialState: item.initialState,
      preparationHint: item.preparationHint,
      sensitivity: item.sensitivity,
      isolation: item.isolation,
      resetAndCleanup: item.resetAndCleanup,
      readiness: item.readiness,
      ...(item.readinessReason ? { readinessReason: item.readinessReason } : {}),
    })),
    proposals: run.caseChangeProposals.map(item => ({ operation: item.operation, ...(item.sourceCaseId ? { sourceCaseId: item.sourceCaseId } : {}), ...(item.sourceRevision !== undefined ? { sourceRevision: item.sourceRevision } : {}), ...(item.candidateCaseId ? { candidateRef: requiredRepairCaseRef(refById, item.candidateCaseId) } : {}), requirementRefs: item.requirementRefs, reason: item.reason, confidence: item.confidence })),
  }
}

function requiredRepairCaseRef(refById: Map<string, string>, caseId: string) {
  const ref = refById.get(caseId)
  if (!ref) throw new TestDesignError('TEST_DESIGN_REPAIR_CASE_REFERENCE_INVALID', `自动修复候选引用的用例不存在或已删除：${caseId}`, 409)
  return ref
}

function buildAgentSnapshot(state: DatabaseState, run: TestDesignWorkflowRun, workspace: TestDesignWorkspaceSnapshot, configuration: AgentConfigurationVersion, task: string): PlanningTestDesignSnapshot {
  const projectVersion = state.projectVersions.find(item => item.id === run.projectVersionId)
  const project = state.projects.find(item => item.id === projectVersion?.projectId)
  if (!projectVersion || !project) throw new Error('TEST_DESIGN_PROJECT_SNAPSHOT_INVALID: 项目版本不存在')
  return {
    runId: run.id,
    projectId: project.id,
    projectName: project.name,
    projectVersionId: projectVersion.id,
    projectVersionName: projectVersion.name,
    knowledgeBaseId: workspace.knowledgeBaseId,
    indexVersionId: workspace.indexVersionId,
    assets: workspace.files.flatMap(file => file.assetId && file.assetVersionId ? [{ assetId: file.assetId, assetVersionId: file.assetVersionId, assetContentHash: file.contentSha256, logicalPath: file.logicalPath, displayName: file.displayName }] : []),
    currentInputRefs: structuredClone(run.currentInputRefs),
    documentWorkspace: { mode: 'agent_directory', logicalPath: workspace.rootLogicalPath, rootLogicalPath: workspace.rootLogicalPath, activeBranchLogicalPath: workspace.activeBranchLogicalPath, branchLogicalPaths: state.projectVersions.filter(item => item.projectId === project.id).map(item => `workspace/branches/${safeWorkspaceSegment(item.name)}`), agentLogicalPath: workspace.agentLogicalPath, layoutVersion: 'workspace/v1', candidateAssetVersionIds: [] },
    workspaceFiles: workspace.files,
    workspaceSnapshot: workspace,
    agentDefinition: structuredClone(configuration.agentDefinition),
    taskSha256: canonicalSha256(task),
    createdAt: new Date().toISOString(),
  }
}

async function validateStageCandidate(stage: TestDesignStage, candidate: Record<string, unknown>, run: TestDesignWorkflowRun) {
  try {
    const result = validateTestCaseDesignCandidate(candidate, stage === 'test_design_repair')
    return { valid: true, result, issues: [] }
  } catch (error) {
    const details = error instanceof TestDesignError && error.details && typeof error.details === 'object' ? error.details as { path?: unknown } : undefined
    const message = error instanceof Error ? error.message : String(error)
    const recoveryHint = stage === 'test_case_design' || stage === 'test_design_repair' ? testCaseCandidateRecoveryHint(message) : ''
    return { valid: false, issues: [{ path: typeof details?.path === 'string' ? details.path : '/', message: `${message}${recoveryHint}` }] }
  }
}

/**
 * The submit tools accept flat cases, while validation returns an internal
 * `{ ref, content }` representation. Service materialization revalidates the
 * persisted candidate against the submit contract, so the boundary must return
 * to the flat wire shape without ever accepting wrapped model input.
 */
export function projectTestCaseCandidateSubmission(
  candidate: TestCaseDesignCandidate,
): TestCaseDesignCandidateSubmission {
  return {
    schemaVersion: candidate.schemaVersion,
    cases: candidate.cases.map(({ ref, content }) => ({
      ref,
      ...structuredClone(content),
    })),
    scenarioClaims: structuredClone(candidate.scenarioClaims),
    dataRequirements: structuredClone(candidate.dataRequirements),
    findings: structuredClone(candidate.findings),
    confirmationItems: structuredClone(candidate.confirmationItems),
    proposals: structuredClone(candidate.proposals),
  }
}

function testCaseCandidateRecoveryHint(message: string) {
  if (!message.includes('thresholds') && !['operator', 'value', 'unit'].some(field => message.includes(field))) return ''
  return '。性能 executionSpec.thresholds 是数组；每项只能包含 metric、target、sourceRef 三个非空字符串。比较符、数值和单位都写入 target 这个完整字符串，不能传 operator/value/unit，也不能删掉 metric、target 或 sourceRef 中的任一字段。没有正式阈值时提交空数组并标记 needs_confirmation，同时建立阻断 Confirmation Item。'
}

function executionRecord(stage: TestDesignStage, agentVersion: string, modelLabel: string, events: AgentExecutionEvent[], turns?: number, toolCalls?: number, toolErrors?: number, framework: AgentExecutionOutput['framework'] = { name: 'pi-agent-core', version: piVersion }, context?: AgentExecutionContext, inputDeliveryManifest?: InputDeliveryManifest) {
  return { agentKey: 'planning' as const, workflowStage: stage, agentVersion, modelLabel, degraded: false, turns: turns ?? Math.max(0, ...events.map(event => event.turn ?? 0)), toolCalls: toolCalls ?? events.filter(event => event.type === 'tool_execution_start').length, toolErrors: toolErrors ?? events.filter(event => event.type === 'tool_execution_end' && event.isError).length, events: structuredClone(events), framework, ...(context ? { context: structuredClone(context) } : {}), ...(inputDeliveryManifest ? { inputDeliveryManifest: structuredClone(inputDeliveryManifest) } : {}) }
}

function validateConfiguration(configuration: AgentConfigurationVersion, state: DatabaseState) {
  const definition = configuration.agentDefinition
  if (definition.agentKey !== 'planning' || definition.agentType !== 'planning' || definition.modelScene !== 'planning' || definition.resultSchemaVersion !== 'planning/v1') throw new Error('PlanningAgent 配置类型不兼容')
  const tools = state.aiResources.filter((item): item is ToolResource => item.kind === 'tool')
  const toolTokens = definition.toolIds.map(toolId => {
    const resource = tools.find(tool => tool.key === toolId)
    return resource
      ? toolBindingToken(resource)
      : defaultBuiltInToolConfigResolver.has(toolId) ? builtInToolBindingToken(toolId) : `${toolId}@missing`
  })
  if (toolsetContentHash(toolTokens) !== definition.toolsetContentSha256) {
    throw new Error('PlanningAgent Toolset 目录内容与固定 Agent 配置不一致；此 Requirement Release 仍引用历史配置，请重新发布 PlanningAgent、重新发布 Requirement Release 后再新建测试设计')
  }
  const allowedTools = new Set<string>([...WORKSPACE_TOOL_IDS, ...ALL_SUBMISSION_TOOLS])
  const missingTools = [...allowedTools].filter(toolId => !definition.toolIds.includes(toolId))
  if (missingTools.length) throw new Error(`PlanningAgent 工具白名单不兼容；缺少 ${missingTools.join(', ')}`)
  for (const toolId of ALL_SUBMISSION_TOOLS) {
    const tool = state.aiResources.find((item): item is ToolResource => item.kind === 'tool' && item.key === toolId && item.enabled)
    if (!tool || tool.risk !== 'internal_write') throw new Error(`结果提交工具 ${toolId} 不可用`)
  }
  resolveModel(state, configuration)
}

function resolveModel(state: DatabaseState, configuration: AgentConfigurationVersion): AgentModelConnection {
  const reference = configuration.routing.primaryModel
  if (!reference) throw new Error('PlanningAgent 未选择默认模型')
  const { source, model } = modelByReference(state, reference)
  if (!source.enabled || !model.enabled || model.health !== 'healthy' || !model.qualityGate?.passed || !model.capabilities.includes('tool_calling')) throw new Error(`${source.name} / ${model.displayName} 未通过模型门禁`)
  return { sourceId: source.id, providerType: source.providerType, baseUrl: source.baseUrl, apiKey: source.apiKey, modelId: model.id, modelName: model.name, contextWindow: configuration.routing.contextWindow, maxOutputTokens: configuration.routing.maxOutputTokens, supportsReasoning: model.capabilities.includes('reasoning'), requestTimeoutMs: configuration.routing.requestTimeoutSeconds * 1_000, retryCount: configuration.routing.retryCount }
}

function modelByReference(state: DatabaseState, reference: AgentModelReference): { source: GenerativeModelSource; model: GenerativeModel } {
  const source = state.modelSources.find(item => item.id === reference.sourceId)
  const model = source?.models.find(item => item.id === reference.modelId)
  if (!source || !model) throw new Error('PlanningAgent 模型引用不存在')
  return { source, model }
}

function sha256Text(value: string) { return createHash('sha256').update(value, 'utf8').digest('hex') }
