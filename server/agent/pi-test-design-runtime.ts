import { createHash } from 'node:crypto'
import type { AgentConfigurationService } from '../application/agent-configuration-service.js'
import { canonicalJson, canonicalSha256 } from '../application/canonical-json.js'
import { buildTestDesignDirectoryInputPlan } from './requirement-context-assembler.js'
import type { TestDesignAgentRuntime } from '../application/test-design-service.js'
import { TestDesignError, validateTestCaseDesignCandidate, validateTestPointDesignCandidate } from '../application/test-design-validation.js'
import type { AgentConfigurationVersion, AgentModelReference, DatabaseState, GenerativeModel, GenerativeModelSource, SkillResource, ToolResource } from '../domain/types.js'
import type { AgentExecutionEvent, AgentModelConnection, InputDeliveryManifest, TestDesignAgentSnapshot } from '../domain/agent-types.js'
import type { TestDesign, TestDesignRunAgentConfigurationSnapshot, TestDesignWorkflowRun, TestDesignWorkspaceFile, TestDesignWorkspaceSnapshot } from '../domain/test-design-types.js'
import type { StateStore } from '../infrastructure/store.js'
import { piVersion, type PiAgentRuntimeAdapter } from './pi-agent-runtime.js'

const WORKSPACE_TOOL_IDS = ['workspace.read_file', 'workspace.grep_files', 'workspace.find_files', 'workspace.list_directory', 'knowledge.search', 'knowledge.read_chunk', 'skill.activate'] as const

export const TEST_DESIGN_STAGE_BINDINGS = {
  test_point_design: {
    skills: ['test-design-baseline', 'test-point-design'],
    submitToolId: 'test_design_points.submit_result',
    schemaVersion: 'test-point-design/v1',
  },
  test_case_design: {
    skills: ['test-case-design'],
    submitToolId: 'test_design_cases.submit_result',
    schemaVersion: 'test-case-design/v1',
  },
  test_design_repair: {
    skills: ['test-design-repair'],
    submitToolId: 'test_design_repair.submit_result',
    schemaVersion: 'test-design-repair/v1',
  },
} as const

type TestDesignStage = keyof typeof TEST_DESIGN_STAGE_BINDINGS
const ALL_SUBMISSION_TOOLS = Object.values(TEST_DESIGN_STAGE_BINDINGS).map(item => item.submitToolId)
const ALL_SKILLS = [...new Set(Object.values(TEST_DESIGN_STAGE_BINDINGS).flatMap(item => [...item.skills]))]

export class PiTestDesignRuntimeAdapter implements TestDesignAgentRuntime {
  constructor(private readonly store: StateStore, private readonly piRuntime: PiAgentRuntimeAdapter, private readonly configurations: AgentConfigurationService) {}

  async readiness() {
    const agentKey = 'test-design'
    const configuration = await this.configurations.resolveActive(agentKey)
    if (!configuration) return { ready: false, agents: [{ agentKey, ready: false, reason: '未发布 TestDesignAgent 配置' }] }
    try {
      validateConfiguration(configuration, await this.store.snapshot())
      return { ready: true, agents: [{ agentKey, ready: true }] }
    } catch (error) {
      return { ready: false, agents: [{ agentKey, ready: false, reason: error instanceof Error ? error.message : String(error) }] }
    }
  }

  async freezeConfiguration(): Promise<TestDesignRunAgentConfigurationSnapshot> {
    const configuration = await this.configurations.resolveActive('test-design')
    if (!configuration) throw new Error('TEST_DESIGN_AGENT_NOT_READY: TestDesignAgent 未发布')
    const state = await this.store.snapshot()
    validateConfiguration(configuration, state)
    const model = resolveModel(state, configuration)
    const createdAt = new Date().toISOString()
    const base = {
      configurationId: configuration.id,
      configurationVersion: configuration.version,
      configurationSha256: configuration.contentSha256,
      agentDefinition: structuredClone(configuration.agentDefinition),
      routing: structuredClone(configuration.routing),
      primaryModel: { sourceId: model.sourceId, modelId: model.modelId, modelName: model.modelName },
      createdAt,
    }
    return { ...base, snapshotSha256: canonicalSha256(base) }
  }

  async execute(input: Parameters<TestDesignAgentRuntime['execute']>[0], signal: AbortSignal): Promise<Awaited<ReturnType<TestDesignAgentRuntime['execute']>>> {
    const stage = input.stage as TestDesignStage
    const binding = TEST_DESIGN_STAGE_BINDINGS[stage]
    const configuration = await this.configurations.resolveVersion(input.run.agentConfigurationSnapshot.configurationId)
    if (configuration.contentSha256 !== input.run.agentConfigurationSnapshot.configurationSha256 || canonicalSha256(configuration.agentDefinition) !== canonicalSha256(input.run.agentConfigurationSnapshot.agentDefinition)) throw new Error('TEST_DESIGN_AGENT_CONFIGURATION_DRIFT: Run 固定的 Agent 配置版本不一致')
    const state = await this.store.snapshot()
    validateConfiguration(configuration, state)
    const model = resolveModel(state, configuration)
    if (model.sourceId !== input.run.agentConfigurationSnapshot.primaryModel.sourceId || model.modelId !== input.run.agentConfigurationSnapshot.primaryModel.modelId) throw new Error('TEST_DESIGN_AGENT_MODEL_DRIFT: Run 固定的模型路由不一致')
    const design = state.testDesignState?.designs.find(item => item.id === input.run.testDesignId && item.projectVersionId === input.run.projectVersionId)
    if (!design) throw new Error('TEST_DESIGN_INPUT_NOT_FOUND: 测试设计定义不存在')
    const workspace = stageWorkspace(input.run, stage)
    const task = buildTestDesignAgentTask(input.run, design, stage, workspace)
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
          allowedSkillKeys: [...binding.skills],
          submitToolId: binding.submitToolId,
          schemaVersion: binding.schemaVersion,
          agentLabel: 'TestDesignAgent',
          initialTask: task,
          validateCandidate: async (candidate, manifest) => validateStageCandidate(stage, candidate, input.run, manifest),
        },
        onEvent: event => { events.push(event) },
      }, signal)
      return {
        schemaVersion: binding.schemaVersion,
        content: structuredClone(output.candidate),
        execution: executionRecord(stage, configuration.agentDefinition.version, model.modelName, output.events, output.turns, output.toolCalls, output.toolErrors, output.framework),
      }
    } catch (error) {
      const failure = new Error(error instanceof Error ? error.message : String(error), { cause: error }) as Error & { execution?: ReturnType<typeof executionRecord> }
      failure.execution = executionRecord(stage, configuration.agentDefinition.version, model.modelName, events)
      throw failure
    }
  }
}

export function buildTestDesignAgentTask(run: TestDesignWorkflowRun, design: TestDesign, stage: TestDesignStage, workspace: TestDesignWorkspaceSnapshot) {
  const binding = TEST_DESIGN_STAGE_BINDINGS[stage]
  const treeVersion = run.testPointTree?.versions.find(item => item.id === run.testPointTree?.currentApprovedVersionId)
  const repairAudit = stage === 'test_design_repair' ? run.coverageAudits.find(item => item.id === run.automaticRepair?.triggerAuditId) : undefined
  return canonicalJson({
    schemaVersion: 'test-design-agent-task/v1',
    agent: 'TestDesignAgent',
    stage,
    runId: run.id,
    projectVersionId: run.projectVersionId,
    requirementRelease: { releaseId: run.basisSnapshot.requirementReleaseId, verificationRunId: run.basisSnapshot.verificationRunId, requirementsJsonSha256: run.basisSnapshot.requirementsJsonSha256 },
    workspace: { root: '/workspace', activeBranch: `/${workspace.activeBranchLogicalPath}`, agentDirectory: `/${workspace.agentLogicalPath}`, snapshotSha256: workspace.snapshotSha256 },
    design: { name: design.name, objective: design.objective, includedScopes: design.input.includedScopes ?? [], excludedScopes: design.input.excludedScopes ?? [], focusDimensions: design.input.focusDimensions ?? [], executionMethods: design.input.executionMethods ?? [], userCoverageObjectives: design.input.userCoverageObjectives ?? [], historicalLibrarySelection: design.input.historicalLibrarySelection ?? { mode: 'latest_library' }, frozenHistoricalCaseCount: run.historicalSnapshot.items.length },
    stageContract: { allowedSkills: binding.skills, submitTool: binding.submitToolId, schemaVersion: binding.schemaVersion },
    ...(treeVersion ? { approvedTestPointTreeVersion: { id: treeVersion.id, revision: treeVersion.revision, treeSha256: treeVersion.treeSha256, path: `/${workspace.activeBranchLogicalPath}/test_design/test-point-tree.json` } } : {}),
    ...(repairAudit ? { repair: { attempt: run.automaticRepair?.attempt, maxAttempts: run.automaticRepair?.maxAttempts, auditId: repairAudit.id, blockers: repairAudit.blockers.filter(item => item.resolution === 'agent_repair'), currentCandidatePath: '/workspace/agent_workspace/design_agent/current-test-cases.json' } } : {}),
    instructions: ['Workflow 已固定 Stage，不能自行切换。', '从 /workspace 使用 ls、find、grep、read 自主读取资料；不得假设未读取的事实。', '如存在 /workspace/agent_workspace/design_agent/historical-test-cases.json，必须读取并建立需求变化到稳定 Case ID/Revision 的映射。', '测试范围、维度和执行方式必须分离；不得编造阈值、时长、兼容矩阵、接口、定位器、账号或环境。', '不得调用 Shell、write、edit，不得生成正式 TP/TestCase ID、Revision、Version 或 Hash，也不得修改数据库或正式 Workspace。', `完成后仅调用 ${binding.submitToolId} 提交一次完整候选。`],
  })
}

function stageWorkspace(run: TestDesignWorkflowRun, stage: TestDesignStage): TestDesignWorkspaceSnapshot {
  const byPath = new Map(run.workspaceSnapshot.files.map(file => [file.logicalPath, structuredClone(file)]))
  for (const file of run.formalWorkspaceFiles) byPath.set(file.logicalPath, structuredClone(file))
  if (stage === 'test_design_repair') {
    const content = repairCandidateContent(run)
    const file: TestDesignWorkspaceFile = { logicalPath: 'workspace/agent_workspace/design_agent/current-test-cases.json', sourceType: 'run_candidate', sourceId: `${run.id}:repair:${run.automaticRepair?.attempt ?? 0}`, contentSha256: canonicalSha256(content), content: `${canonicalJson(content)}\n`, displayName: 'current-test-cases.json' }
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

function buildAgentSnapshot(state: DatabaseState, run: TestDesignWorkflowRun, workspace: TestDesignWorkspaceSnapshot, configuration: AgentConfigurationVersion, task: string): TestDesignAgentSnapshot {
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
    documentWorkspace: { mode: 'agent_directory', logicalPath: workspace.rootLogicalPath, rootLogicalPath: workspace.rootLogicalPath, activeBranchLogicalPath: workspace.activeBranchLogicalPath, branchLogicalPaths: [workspace.activeBranchLogicalPath], agentLogicalPath: workspace.agentLogicalPath, layoutVersion: 'workspace/v1', candidateAssetVersionIds: [] },
    workspaceFiles: workspace.files,
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
    ? [`${branchRelative}/requirements/requirements.json`, `${branchRelative}/test_design/test-point-tree.json`]
    : ['agent_workspace/design_agent/current-test-cases.json', `${branchRelative}/test_design/test-point-tree.json`]
  if (run.historicalSnapshot.items.length && stage !== 'test_design_repair') requiredPaths.push('agent_workspace/design_agent/historical-test-cases.json')
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
  if (!tree || !version || !revision) throw new TestDesignError('TEST_POINT_TREE_APPROVAL_REQUIRED', '测试点树未批准', 409)
  const active = revision.nodes.filter(item => !item.deleted)
  const parents = new Set(active.flatMap(item => item.parentId ? [item.parentId] : []))
  return new Set(active.filter(item => item.applicability !== 'not_applicable' && !parents.has(item.nodeId)).map(item => item.nodeId))
}

function executionRecord(stage: TestDesignStage, agentVersion: string, modelLabel: string, events: AgentExecutionEvent[], turns?: number, toolCalls?: number, toolErrors?: number, framework = { name: 'pi-agent-core' as const, version: piVersion }) {
  return { agentKey: 'test-design' as const, workflowStage: stage, agentVersion, modelLabel, degraded: false, turns: turns ?? Math.max(0, ...events.map(event => event.turn ?? 0)), toolCalls: toolCalls ?? events.filter(event => event.type === 'tool_execution_start').length, toolErrors: toolErrors ?? events.filter(event => event.type === 'tool_execution_end' && event.isError).length, events: structuredClone(events), framework }
}

function validateConfiguration(configuration: AgentConfigurationVersion, state: DatabaseState) {
  const definition = configuration.agentDefinition
  if (definition.agentKey !== 'test-design' || definition.agentType !== 'test_design' || definition.modelScene !== 'test_design' || definition.resultSchemaVersion !== 'test-design/v1') throw new Error('TestDesignAgent 配置类型不兼容')
  const allowedTools = new Set<string>([...WORKSPACE_TOOL_IDS, ...ALL_SUBMISSION_TOOLS])
  const missingTools = [...allowedTools].filter(toolId => !definition.toolIds.includes(toolId))
  const extraTools = definition.toolIds.filter(toolId => !allowedTools.has(toolId))
  if (missingTools.length || extraTools.length) throw new Error(`TestDesignAgent 工具白名单不兼容${missingTools.length ? `；缺少 ${missingTools.join(', ')}` : ''}${extraTools.length ? `；包含未授权工具 ${extraTools.join(', ')}` : ''}`)
  if (definition.mcpBindings.some(item => item.enabled)) throw new Error('TestDesignAgent 不允许绑定 MCP')
  const enabledSkills = new Set(definition.skillBindings.filter(item => item.enabled).map(item => item.skillKey))
  const missingSkills = ALL_SKILLS.filter(skill => !enabledSkills.has(skill))
  if (missingSkills.length) throw new Error(`TestDesignAgent 缺少 Skill 绑定 ${missingSkills.join(', ')}`)
  for (const skillKey of ALL_SKILLS) {
    const skill = state.aiResources.find((item): item is SkillResource => item.kind === 'skill' && item.key === skillKey && item.enabled)
    if (!skill) throw new Error(`Skill ${skillKey} 不可用`)
  }
  for (const toolId of ALL_SUBMISSION_TOOLS) {
    const tool = state.aiResources.find((item): item is ToolResource => item.kind === 'tool' && item.key === toolId && item.enabled)
    if (!tool || tool.risk !== 'internal_write') throw new Error(`结果提交工具 ${toolId} 不可用`)
  }
  resolveModel(state, configuration)
}

function resolveModel(state: DatabaseState, configuration: AgentConfigurationVersion): AgentModelConnection {
  const reference = configuration.routing.primaryModel
  if (!reference) throw new Error('TestDesignAgent 未选择默认模型')
  const { source, model } = modelByReference(state, reference)
  if (!source.enabled || !model.enabled || model.health !== 'healthy' || !model.qualityGate?.passed || !model.capabilities.includes('tool_calling')) throw new Error(`${source.name} / ${model.displayName} 未通过模型门禁`)
  return { sourceId: source.id, providerType: source.providerType, baseUrl: source.baseUrl, apiKey: source.apiKey, modelId: model.id, modelName: model.name, contextWindow: model.contextWindow, maxOutputTokens: configuration.routing.maxOutputTokens, supportsReasoning: model.capabilities.includes('reasoning'), requestTimeoutMs: configuration.routing.requestTimeoutSeconds * 1_000, retryCount: configuration.routing.retryCount }
}

function modelByReference(state: DatabaseState, reference: AgentModelReference): { source: GenerativeModelSource; model: GenerativeModel } {
  const source = state.modelSources.find(item => item.id === reference.sourceId)
  const model = source?.models.find(item => item.id === reference.modelId)
  if (!source || !model) throw new Error('TestDesignAgent 模型引用不存在')
  return { source, model }
}

function sha256Text(value: string) { return createHash('sha256').update(value, 'utf8').digest('hex') }
