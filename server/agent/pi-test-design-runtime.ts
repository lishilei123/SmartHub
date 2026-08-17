import { createHash } from 'node:crypto'
import type { AgentConfigurationService } from '../application/agent-configuration-service.js'
import { canonicalJson, canonicalSha256 } from '../application/canonical-json.js'
import { buildTestDesignDirectoryInputPlan } from './requirement-context-assembler.js'
import type { PlanningAgentRuntime } from '../application/test-design-service.js'
import { TestDesignError, validateTestCaseDesignCandidate, validateTestPointDesignCandidate, type TestDataRequirementCandidate } from '../application/test-design-validation.js'
import type { AgentConfigurationVersion, AgentModelReference, DatabaseState, GenerativeModel, GenerativeModelSource, ToolResource } from '../domain/types.js'
import type { AgentExecutionContext, AgentExecutionEvent, AgentExecutionOutput, AgentModelConnection, InputDeliveryManifest, PlanningTestDesignSnapshot } from '../domain/agent-types.js'
import type { TestDesign, TestDesignRunAgentConfigurationSnapshot, TestDesignWorkflowRun, TestDesignWorkspaceFile, TestDesignWorkspaceSnapshot } from '../domain/test-design-types.js'
import type { StateStore } from '../infrastructure/store.js'
import { safeWorkspaceSegment } from '../application/project-workspace-snapshot.js'
import { piVersion, type PiAgentRuntimeAdapter } from './pi-agent-runtime.js'

const WORKSPACE_TOOL_IDS = ['workspace.read_file', 'workspace.grep_files', 'workspace.find_files', 'workspace.list_directory', 'knowledge.search', 'knowledge.read_chunk'] as const

export const TEST_DESIGN_STAGE_BINDINGS = {
  test_point_design: {
    submitToolId: 'test_design_points.submit_result',
    schemaVersion: 'test-point-design/v1',
  },
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

  async readiness(projectVersionId?: string) {
    const agentKey = 'planning'
    const state = await this.store.snapshot()
    const projectVersion = projectVersionId ? state.projectVersions.find(item => item.id === projectVersionId) : undefined
    const verificationRun = projectVersion?.requirementReleaseBinding
      ? state.reviewRuns.find(item => item.id === projectVersion.requirementReleaseBinding?.verificationRunId)
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

  async freezeConfiguration(projectVersionId: string): Promise<TestDesignRunAgentConfigurationSnapshot> {
    const state = await this.store.snapshot()
    const projectVersion = state.projectVersions.find(item => item.id === projectVersionId)
    const verificationRun = state.reviewRuns.find(item => item.id === projectVersion?.requirementReleaseBinding?.verificationRunId)
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
          validateCandidate: async (candidate, manifest) => validateStageCandidate(stage, candidate, input.run, manifest),
        },
        onEvent: event => { events.push(event) },
      }, signal)
      return {
        schemaVersion: binding.schemaVersion,
        content: structuredClone(output.candidate),
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
  const treeVersion = run.testPointTree?.versions.find(item => item.id === run.testPointTree?.currentApprovedVersionId)
  const repairState = stage === 'test_design_repair' ? run.automaticRepair : undefined
  const repairAudit = repairState?.triggerAuditId ? run.coverageAudits.find(item => item.id === repairState.triggerAuditId) : undefined
  if (stage === 'test_design_repair' && (!repairState || !repairAudit)) throw new TestDesignError('TEST_DESIGN_REPAIR_CONTEXT_INVALID', '自动修复任务缺少固定的修复状态或 Coverage Audit', 409)
  return canonicalJson({
    schemaVersion: 'test-design-agent-task/v1',
    agent: 'PlanningAgent',
    stage,
    runId: run.id,
    projectVersionId: run.projectVersionId,
    requirementRelease: { releaseId: run.basisSnapshot.requirementReleaseId, verificationRunId: run.basisSnapshot.verificationRunId, requirementsJsonSha256: run.basisSnapshot.requirementsJsonSha256, clarificationCount: run.basisSnapshot.clarifications?.length ?? 0 },
    workspace: { root: '/workspace', activeBranch: `/${workspace.activeBranchLogicalPath}`, agentDirectory: `/${workspace.agentLogicalPath}`, snapshotSha256: workspace.snapshotSha256 },
    currentInputRefs: run.currentInputRefs.map(item => ({ logicalPath: item.logicalPath.replace(/^workspace\//u, ''), assetVersionId: item.assetVersionId, contentSha256: item.contentSha256 })),
    design: { name: design.name, objective: design.objective, includedScopes: design.input.includedScopes ?? [], excludedScopes: design.input.excludedScopes ?? [], focusDimensions: design.input.focusDimensions ?? [], executionMethods: design.input.executionMethods ?? [], userCoverageObjectives: design.input.userCoverageObjectives ?? [], historicalLibrarySelection: design.input.historicalLibrarySelection ?? { mode: 'latest_library' }, frozenHistoricalCaseCount: run.historicalSnapshot.items.length },
    agentCapabilities: { enabledSkills: run.agentConfigurationSnapshot.agentDefinition.enabledSkills },
    stageContract: { submitTool: binding.submitToolId, schemaVersion: binding.schemaVersion },
    stageObjective: testDesignStageObjective(stage),
    ...(treeVersion ? { approvedTestPointTreeVersion: { id: treeVersion.id, revision: treeVersion.revision, treeSha256: treeVersion.treeSha256, path: `/${workspace.activeBranchLogicalPath}/test-design/test-point-tree.json` } } : {}),
    ...(repairState && repairAudit ? { repair: { attempt: repairState.attempt, maxAttempts: repairState.maxAttempts, auditId: repairAudit.id, blockers: repairAudit.blockers.filter(item => item.resolution === 'agent_repair'), currentCandidatePath: '/workspace/agent_workspace/planning_agent/current-test-cases.json' } } : {}),
    instructions: testDesignStageInstructions(stage),
  })
}

function testDesignStageObjective(stage: TestDesignStage) {
  if (stage === 'test_point_design') return '基于正式 Requirement Release 建立完整、去重、风险导向且可追溯的测试点候选；本阶段不设计测试用例。'
  if (stage === 'test_case_design') return '基于已固化 TestPointTreeVersion 生成可审核的测试用例、测试数据需求和用例库变更 Proposal；本阶段不得重写测试点。'
  return '只修复当前 Coverage Audit 中 resolution=agent_repair 的阻断项，最小化修改并保持未受影响候选语义稳定。'
}

function testDesignStageInstructions(stage: TestDesignStage) {
  const binding = TEST_DESIGN_STAGE_BINDINGS[stage]
  const stageRules = stage === 'test_point_design'
    ? ['覆盖正式需求、风险、边界、状态与异常，并保留 Requirement → TestPoint 依据；不得生成 TestCase。']
    : stage === 'test_case_design'
      ? ['必须读取已固化 test-point-tree.json，以适用叶子测试点为覆盖目标；不得修改、补造或绕过已批准测试点。', '用例必须具备明确目标、前置条件、步骤/执行规格、预期结果、清理与追溯；历史用例只在仍符合当前正式需求时复用或提出新 Revision。']
      : ['只处理任务中列出的 agent_repair blockers；不得修改正式需求、已批准测试点或不相关用例。', '优先做最小修复；保留未受影响的候选引用、依赖、Proposal 与测试数据语义。']
  return [
    ...stageRules,
    'Runtime Stage 合同决定当前 Schema、工具白名单和唯一 Submit Tool；Session 历史中的其他 Stage 指令一律不适用。',
    'Workflow 只推进业务流程，不调度 Skill；PlanningAgent 从完整 Enabled Skills 中自主选择所需能力。',
    'currentInputRefs 是重点输入，不是读取白名单；先读取重点输入，再按需使用 ls、find、grep、read 浏览完整冻结 Workspace。',
    'requirements/clarifications.json 中 answered 是正式事实；dismissed 只是处置理由，不得转化为断言，相关缺口必须保留。',
    '若存在 historical-test-cases.json，必须读取并判断复用、修改、新增或废弃；历史资料不能覆盖当前 Requirement Release。',
    '不得编造阈值、时长、兼容矩阵、接口、定位器、账号、环境或 Expected Result。',
    '只生成语义候选；不得调用 Shell、write、edit，不得生成正式 ID、Revision、Version、Hash 或修改数据库/正式 Workspace。',
    `完成 Self Review 后，只提交一个完整 ${binding.schemaVersion} 候选；若服务端拒绝，只按错误路径修正后重新提交。`,
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
      return { ref: requiredRepairCaseRef(refById, testCase.id), content: { ...revision.content, dependencies: revision.content.dependencies.map(id => refById.get(id) ?? id), dataRequirementIds: [] } }
    }),
    dataRequirements: (dataSet?.requirements ?? []).map((item, index): TestDataRequirementCandidate => ({
      ref: `data-${index + 1}`,
      name: item.name,
      entityType: item.entityType,
      featureTags: [...item.featureTags],
      testPointIds: [...item.testPointIds],
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
    proposals: run.caseChangeProposals.map(item => ({ operation: item.operation, ...(item.sourceCaseId ? { sourceCaseId: item.sourceCaseId } : {}), ...(item.sourceRevision !== undefined ? { sourceRevision: item.sourceRevision } : {}), ...(item.candidateCaseId ? { candidateRef: requiredRepairCaseRef(refById, item.candidateCaseId) } : {}), requirementRefs: item.requirementRefs, testPointIds: item.testPointIds, reason: item.reason, confidence: item.confidence })),
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

async function validateStageCandidate(stage: TestDesignStage, candidate: Record<string, unknown>, run: TestDesignWorkflowRun, manifest: InputDeliveryManifest) {
  const readPaths = new Set((manifest.toolReads ?? []).map(item => item.relativePath.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')))
  const branchRelative = run.workspaceSnapshot.activeBranchLogicalPath.replace(/^workspace\//u, '')
  const requiredPaths = stage === 'test_point_design'
    ? [`${branchRelative}/requirements/requirements.json`]
    : stage === 'test_case_design'
    ? [`${branchRelative}/requirements/requirements.json`, `${branchRelative}/test-design/test-point-tree.json`]
    : ['agent_workspace/planning_agent/current-test-cases.json', `${branchRelative}/test-design/test-point-tree.json`]
  if ((run.basisSnapshot.clarifications?.length ?? 0) > 0 && stage !== 'test_design_repair') requiredPaths.push(`${branchRelative}/requirements/clarifications.json`)
  if (run.historicalSnapshot.items.length && stage !== 'test_design_repair') requiredPaths.push('agent_workspace/planning_agent/historical-test-cases.json')
  const missingReads = requiredPaths.filter(path => !readPaths.has(path))
  if (missingReads.length) return { valid: false, issues: missingReads.map(path => ({ path: '/workspaceReads', message: `提交前必须用 read 读取 /workspace/${path}` })) }
  try {
    const result = stage === 'test_point_design' ? validateTestPointDesignCandidate(candidate) : validateTestCaseDesignCandidate(candidate, approvedPointIds(run), stage === 'test_design_repair')
    return { valid: true, result, issues: [] }
  } catch (error) {
    const details = error instanceof TestDesignError && error.details && typeof error.details === 'object' ? error.details as { path?: unknown } : undefined
    return { valid: false, issues: [{ path: typeof details?.path === 'string' ? details.path : '/', message: error instanceof Error ? error.message : String(error) }] }
  }
}

function approvedPointIds(run: TestDesignWorkflowRun) {
  const tree = run.testPointTree
  const version = tree?.versions.find(item => item.id === tree.currentApprovedVersionId)
  const revision = tree?.revisions.find(item => item.revision === version?.revision)
  if (!tree || !version || !revision) throw new TestDesignError('TEST_POINT_TREE_APPROVAL_REQUIRED', '测试点树尚未通过自动校验并固化', 409)
  const active = revision.nodes.filter(item => !item.deleted)
  const parents = new Set(active.flatMap(item => item.parentId ? [item.parentId] : []))
  return new Set(active.filter(item => item.applicability !== 'not_applicable' && !parents.has(item.nodeId)).map(item => item.nodeId))
}

function executionRecord(stage: TestDesignStage, agentVersion: string, modelLabel: string, events: AgentExecutionEvent[], turns?: number, toolCalls?: number, toolErrors?: number, framework: AgentExecutionOutput['framework'] = { name: 'pi-agent-core', version: piVersion }, context?: AgentExecutionContext, inputDeliveryManifest?: InputDeliveryManifest) {
  return { agentKey: 'planning' as const, workflowStage: stage, agentVersion, modelLabel, degraded: false, turns: turns ?? Math.max(0, ...events.map(event => event.turn ?? 0)), toolCalls: toolCalls ?? events.filter(event => event.type === 'tool_execution_start').length, toolErrors: toolErrors ?? events.filter(event => event.type === 'tool_execution_end' && event.isError).length, events: structuredClone(events), framework, ...(context ? { context: structuredClone(context) } : {}), ...(inputDeliveryManifest ? { inputDeliveryManifest: structuredClone(inputDeliveryManifest) } : {}) }
}

function validateConfiguration(configuration: AgentConfigurationVersion, state: DatabaseState) {
  const definition = configuration.agentDefinition
  if (definition.agentKey !== 'planning' || definition.agentType !== 'planning' || definition.modelScene !== 'planning' || definition.resultSchemaVersion !== 'planning/v1') throw new Error('PlanningAgent 配置类型不兼容')
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
