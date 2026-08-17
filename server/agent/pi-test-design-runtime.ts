import { createHash } from 'node:crypto'
import type { AgentConfigurationService } from '../application/agent-configuration-service.js'
import { canonicalJson, canonicalSha256 } from '../application/canonical-json.js'
import { buildTestDesignDirectoryInputPlan } from './requirement-context-assembler.js'
import type { PlanningAgentRuntime } from '../application/test-design-service.js'
import { TestDesignError, validateTestCaseDesignCandidate, validateTestPointDesignCandidate } from '../application/test-design-validation.js'
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
  const repairAudit = stage === 'test_design_repair' ? run.coverageAudits.find(item => item.id === run.automaticRepair?.triggerAuditId) : undefined
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
    ...(treeVersion ? { approvedTestPointTreeVersion: { id: treeVersion.id, revision: treeVersion.revision, treeSha256: treeVersion.treeSha256, path: `/${workspace.activeBranchLogicalPath}/test-design/test-point-tree.json` } } : {}),
    ...(repairAudit ? { repair: { attempt: run.automaticRepair?.attempt, maxAttempts: run.automaticRepair?.maxAttempts, auditId: repairAudit.id, blockers: repairAudit.blockers.filter(item => item.resolution === 'agent_repair'), currentCandidatePath: '/workspace/agent_workspace/planning_agent/current-test-cases.json' } } : {}),
    instructions: ['Workflow 已固定业务任务与提交协议，但不调度 Skill；PlanningAgent 从 Enabled Skills 自主选择需要的能力。', 'currentInputRefs 是本次上传资料重点，不是读取白名单；先读取重点输入，再从完整 ProjectWorkspaceSnapshot 自主查找相关资料。', '从 /workspace 使用 ls、find、grep、read 自主读取资料；不得假设未读取的事实。', 'requirements/clarifications.json 中已回答的 Clarification 是正式业务事实，必须纳入测试设计并保留 Requirement → TestPoint → TestCase 追溯。', '如存在 /workspace/agent_workspace/planning_agent/historical-test-cases.json，必须读取并建立需求变化到稳定 Case ID/Revision 的映射。', '测试范围、维度和执行方式必须根据正式资料的适用性判断；不得编造阈值、时长、兼容矩阵、接口、定位器、账号或环境。', '不得调用 Shell、write、edit，不得生成正式 TP/TestCase ID、Revision、Version 或 Hash，也不得修改数据库或正式 Workspace。', `完成后仅调用 ${binding.submitToolId} 提交一次完整候选。`],
  })
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
  const base = { ...run.workspaceSnapshot, files }
  return { ...base, snapshotSha256: canonicalSha256({ ...base, snapshotSha256: undefined }) }
}

function repairCandidateContent(run: TestDesignWorkflowRun) {
  const activeCases = run.testCases.filter(item => !item.tombstonedAt)
  const refById = new Map(activeCases.map(item => [item.id, item.candidateRef ?? `case-${item.id}`]))
  const dataSet = run.dataSetVersions.at(-1)
  return {
    schemaVersion: 'test-design-repair-input/v1',
    cases: activeCases.map(testCase => {
      const revision = testCase.revisions.find(item => item.revision === testCase.currentRevision)!
      return { ref: refById.get(testCase.id), content: { ...revision.content, dependencies: revision.content.dependencies.map(id => refById.get(id) ?? id), dataRequirementIds: [] } }
    }),
    dataRequirements: (dataSet?.requirements ?? []).map((item, index) => ({ ...item, ref: `data-${index + 1}`, caseRefs: item.caseIds.map(id => refById.get(id) ?? id), id: undefined, caseIds: undefined })),
    proposals: run.caseChangeProposals.map(item => ({ operation: item.operation, ...(item.sourceCaseId ? { sourceCaseId: item.sourceCaseId } : {}), ...(item.sourceRevision !== undefined ? { sourceRevision: item.sourceRevision } : {}), ...(item.candidateCaseId ? { candidateRef: refById.get(item.candidateCaseId) } : {}), requirementRefs: item.requirementRefs, testPointIds: item.testPointIds, reason: item.reason, confidence: item.confidence })),
  }
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
  return { sourceId: source.id, providerType: source.providerType, baseUrl: source.baseUrl, apiKey: source.apiKey, modelId: model.id, modelName: model.name, contextWindow: Math.min(configuration.routing.contextWindow, model.contextWindow), maxOutputTokens: configuration.routing.maxOutputTokens, supportsReasoning: model.capabilities.includes('reasoning'), requestTimeoutMs: configuration.routing.requestTimeoutSeconds * 1_000, retryCount: configuration.routing.retryCount }
}

function modelByReference(state: DatabaseState, reference: AgentModelReference): { source: GenerativeModelSource; model: GenerativeModel } {
  const source = state.modelSources.find(item => item.id === reference.sourceId)
  const model = source?.models.find(item => item.id === reference.modelId)
  if (!source || !model) throw new Error('PlanningAgent 模型引用不存在')
  return { source, model }
}

function sha256Text(value: string) { return createHash('sha256').update(value, 'utf8').digest('hex') }
