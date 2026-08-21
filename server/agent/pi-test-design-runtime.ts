import { createHash } from 'node:crypto'
import type { AgentConfigurationService } from '../application/agent-configuration-service.js'
import { builtInToolBindingToken, toolBindingToken, toolsetContentHash } from '../application/ai-resource-hash.js'
import { canonicalJson, canonicalSha256 } from '../application/canonical-json.js'
import { buildTestDesignDirectoryInputPlan } from './requirement-context-assembler.js'
import { repairCandidateContent, type PlanningAgentRuntime } from '../application/test-design-service.js'
import { isTestDesignRepairPatch, TestDesignError, validateHistoricalProposalPlan, validateTestCaseDesignCandidate, type TestCaseDesignCandidate, type TestCaseDesignCandidateSubmission, type TestDesignRepairPatch } from '../application/test-design-validation.js'
import type { AgentConfigurationVersion, AgentModelReference, DatabaseState, GenerativeModel, GenerativeModelSource, ToolResource } from '../domain/types.js'
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
    schemaVersion: 'test-case-design/v2',
  },
  test_design_repair: {
    submitToolId: 'test_design_repair.submit_result',
    schemaVersion: 'test-design-repair/v2',
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

  async readiness() {
    const agentKey = 'planning'
    const state = await this.store.snapshot()
    const configuration = await this.configurations.resolveActive(agentKey)
    if (!configuration) return { ready: false, agents: [{ agentKey, ready: false, reason: '未发布 PlanningAgent 配置' }] }
    try {
      validateConfiguration(configuration, state)
      return { ready: true, agents: [{ agentKey, ready: true }] }
    } catch (error) {
      return { ready: false, agents: [{ agentKey, ready: false, reason: error instanceof Error ? error.message : String(error) }] }
    }
  }

  async freezeConfiguration(): Promise<TestDesignRunAgentConfigurationSnapshot> {
    const state = await this.store.snapshot()
    const configuration = await this.configurations.resolveActive('planning')
    if (!configuration) throw new Error('TEST_DESIGN_AGENT_NOT_READY: 未发布 PlanningAgent 配置')
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
        onEvent: async event => {
          events.push(event)
          await input.onExecutionEvent?.(event)
        },
      }, signal)
      return {
        schemaVersion: binding.schemaVersion,
        content: projectTestCaseCandidateSubmission(output.candidate as TestCaseDesignCandidate | TestDesignRepairPatch),
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
  const repairBlockers = repairAudit
    ? repairAudit.blockers.filter(item => item.resolution === 'agent_repair' && (!repairState?.blockerScopes?.length || repairState.blockerScopes.some(scope => scope.code === item.code && scope.subjectId === item.subjectId)))
    : []
  if (stage === 'test_design_repair' && (!repairState || !repairAudit)) throw new TestDesignError('TEST_DESIGN_REPAIR_CONTEXT_INVALID', '自动修复任务缺少固定的修复状态或 Coverage Audit', 409)
  return canonicalJson({
    schemaVersion: 'test-design-agent-task/v1',
    agent: 'PlanningAgent',
    currentBusinessState: stage,
    runId: run.id,
    projectVersionId: run.projectVersionId,
    requirementRelease: {
      releaseId: run.basisSnapshot.requirementReleaseId,
      verificationRunId: run.basisSnapshot.verificationRunId,
      contentSha256: run.basisSnapshot.requirementReleaseContentSha256,
      content: run.basisSnapshot.content,
    },
    workspace: { root: '/workspace', activeBranch: `/${workspace.activeBranchLogicalPath}`, agentDirectory: `/${workspace.agentLogicalPath}`, snapshotSha256: workspace.snapshotSha256 },
    currentInputRefs: run.currentInputRefs.map(item => ({ logicalPath: item.logicalPath.replace(/^workspace\//u, ''), assetVersionId: item.assetVersionId, contentSha256: item.contentSha256 })),
    design: { name: design.name, objective: design.objective, includedScopes: design.input.includedScopes ?? [], excludedScopes: design.input.excludedScopes ?? [], focusDimensions: design.input.focusDimensions ?? [], executionMethods: design.input.executionMethods ?? [], userCoverageObjectives: design.input.userCoverageObjectives ?? [], historicalLibrarySelection: design.input.historicalLibrarySelection ?? { mode: 'latest_library' }, frozenHistoricalCaseCount: run.historicalSnapshot.items.length },
    agentCapabilities: { enabledSkills: run.agentConfigurationSnapshot.agentDefinition.enabledSkills },
    runtimeBoundary: { submitTool: binding.submitToolId, schemaVersion: binding.schemaVersion },
    task: testDesignTaskMessage(stage),
    ...(repairState && repairAudit ? { repair: { attempt: repairState.attempt, maxAttempts: repairState.maxAttempts, auditId: repairAudit.id, blockers: repairBlockers, currentCandidatePath: '/workspace/agent_workspace/planning_agent/current-test-cases.json', baseCandidateSha256: canonicalSha256(repairCandidateContent(run)) } } : {}),
    instructions: testDesignStageInstructions(stage),
  })
}

function testDesignTaskMessage(stage: TestDesignStage) {
  if (stage === 'test_case_design') {
    return 'Requirement Release 已正式发布。请直接基于任务中明确提供的结构化 Requirement Release content，并按需读取冻结 Workspace 中的用户资料与历史用例快照，设计完整测试用例。'
  }
  return 'Coverage Audit 已识别可由 Agent 修复的候选问题。请继续当前测试策划工作，修复任务中列出的 agent_repair blockers，并保持其他候选语义稳定。'
}

function testDesignStageInstructions(stage: TestDesignStage) {
  const binding = TEST_DESIGN_STAGE_BINDINGS[stage]
  const stageRules = stage === 'test_case_design'
    ? [
          'Requirement Release 是本轮唯一正式覆盖基线；本轮只提交新增 Candidate Case 与实际变化的历史决策。每条用例必须使用 requirementRefs 直接关联至少一个 Requirement。Service 会恢复未变化冻结历史用例、其冻结数据关系和完整内部 Candidate Snapshot。',
          'cases[] 只包含新增用例与 historicalChanges.update 的完整新内容。historicalChanges 只允许 update、deprecate、reference，并仅填写冻结 sourceCaseId/sourceRevision、update 的 candidateRef、reason、confidence；未出现在 historicalChanges 的冻结历史用例由 Service 自动 reuse。不得复制历史 Case 正文、正式 ID、Hash 或 Revision，也不得用省略变更静默删除历史用例。新增 Case 不要提交 create Proposal，Service 会自动生成；reuse 自动接受，create/update 随当前 Case Revision 审核通过自动接受，只有 deprecate 与必要的 reference 需要额外人工决策。',
          '每个 functional/security Candidate Case 都必须在自身 coverageClaims[] 提供至少一条 Claim。coverageClaim 只包含 ref、kind、subject、variant、polarity、明确且可独立判定的 oracle，以及可选 transition/knowledgeRefs；不要重复填写 caseRef 或 requirementRefs，Service 会从所属 Case 自动派生。不要提交根级 scenarioClaims。kind=state_transition 时必须额外声明 transition:{from,to}，一条 Claim 只允许一个明确状态边；它不是 TestPoint，不会获得正式 ID、Revision、Version 或发布。',
          '提交前必须提供根级 dimensionAssessments，且恰好覆盖 functional、performance、stability、compatibility、security 五个维度。每项包含 dimension、applicable、reason、requirementRefs、risks、scenarioClaims；不适用必须用当前冻结 Requirement 的 requirementRefs 说明依据，适用维度必须列出待覆盖场景族并生成对应维度用例。它是候选覆盖地图，不会创建新的人工审核阶段。',
          '功能和安全用例的执行步骤、检查点、就绪状态及自动化提示只在 executionMethods 的对应 UI/API 方式中完整填写。design.executionMethods 中每个已选择方式都必须至少出现在一条适用用例中；没有正式 API method/path、UI entry/selector 等执行数据时仍保留该方式并将未知字段提交为空字符串，留到创建测试执行时补充，绝不编造，也不要仅因这些执行阶段字段为空而改变测试设计候选状态。executionSpec 对此类用例只提交 kind=functional 与同一 method；服务端会从 executionMethods 和用例根字段投影正式 executionSpec。不要提交第二份重复步骤。',
          '非功能 executionSpec 必须使用精确字段：performance 为 kind=performance、method=performance_tool、target、scenario、virtualUsers、duration、rampUp、thresholds、dataStrategy、environmentRequirements、executionReadiness；stability 为 kind=stability、method=long_running、workload、duration、interval、observations、recoveryPolicy、checkpointPolicy、environmentRequirements、executionReadiness；compatibility 为 kind=compatibility、method=environment_matrix、baseMethod、baseCaseRefs、browserMatrix、operatingSystemMatrix、viewportMatrix、versionMatrix、expectedConsistency、executionReadiness。cases[] 根对象和 executionSpec 都不得添加这些列表之外的自定义字段。',
          '性能 thresholds 必须是数组；每一项严格且仅为 { metric, target, sourceRef }，三者都是非空字符串。把比较符、数值、单位和适用范围合并写进 target；不得使用 operator、value、unit，也不得提交缺少其中任一字段的半成品阈值。若没有正式阈值，提交 thresholds: []、executionReadiness: needs_confirmation，并建立 blocker Confirmation Item。',
        ]
      : [
          '当前任务只列出经过 Service 作用域判定、可安全自动修复的 agent_repair blockers；正式 Requirement 保持不变。提交 test-design-repair/v2 时，baseCandidateSha256 必须等于任务和 current-test-cases.json 对应的当前完整 Candidate；Hash 不一致时重新读取快照，不能猜测或覆盖。',
          'Patch 的 upsertCases 是新增或替换指定 ref 的完整 test-case/v2 内容；functional/security 用例将其 coverageClaims 一并放在该 Case 内。可安全修复的完整 Candidate 可以同时包含当前版本 AI Case 与未变化历史 reuse Case；Patch 只修改当前 Run Candidate，绝不修改来源冻结 Revision。removeCaseRefs 只可删除本轮新增 Candidate，不能删除冻结历史 reuse Case。未在 Patch 中列出的 Case、Proposal、历史来源、数据关系和维度评估由 Service 保持不变；Service 会同步 Candidate、ScenarioClaim、requirementRefs、diff 与 Proposal 状态。',
          'upsertDataRequirements / removeDataRequirementRefs 只处理确实受 blocker 影响的数据需求；dimensionAssessmentUpdates 只更新受影响维度。Service 会把 Patch 重新展开为完整 Candidate，执行完整 Validator 和 Coverage Audit，并保留修复前后 Diff。',
          '遇到 TEST_CASE_OVER_MERGED 时，依据 blocker.details 和 current-test-cases.json 中的 scenarioClaims 拆分 Candidate Case，并将每条 ScenarioClaim 重新指向承担该独立 Atomic Test Intent 的 caseRef。',
        ]
  const readingRules = stage === 'test_case_design'
    ? [
        '正式 Requirement、Evidence、Clarification 和 Test Focus 已由 Runtime 在 requirementRelease.content 中完整提供，不要到 Workspace 寻找其 JSON 或 Markdown 镜像。coreFactPaths 只列出需要自主读取的冻结历史资料。',
        '若 coreFactPaths 中存在 historical-test-cases.json，它是本轮唯一的历史用例库基线，必须读取并判断复用、修改、新增或废弃；不得用 branches/*/test-case-library/v*/ 下的 manifest、test-cases 或其他正式投影重复建立历史基线。历史资料不能覆盖当前 Requirement Release。',
        '补充 Workspace 或共享知识只可用于已命名的事实缺口或风险：先用受限路径的 ls/find/grep 或 knowledge.search 定位，再读取最小必要范围。相同 contentHash 和所需行范围仍在当前 Context 时直接复用；不得因确认、Stage 切换或多个 Skill 的方法重叠而重读。',
      ]
    : [
        '修复阶段优先读取 current-test-cases.json、Requirement Release 和 blocker 指明的资料。除 blocker 直接引用外，不回读历史用例库或共享知识；完整冻结 Workspace 仍是授权边界，不是默认遍历清单。',
      ]
  return [
    ...stageRules,
    ...readingRules,
    '提交 cases[] 时，每一项必须是扁平的 test-case/v2 对象：ref、schemaVersion、title、requirementRefs、executionMethods、executionSpec 等字段同级。禁止使用 { ref, content: {...} } 包装。',
    'Runtime 实际暴露的工具、结果 Schema 和 Submit Tool 是本轮执行权限边界。',
    'Workflow 只推进业务流程，不调度 Skill；PlanningAgent 查看 Enabled Skill Catalog，并只在当前 Stage 确有方法缺口时自主决定是否通过 skill.read 读取正文。已有 TRUSTED_SKILL 正文仍在 Context 时直接复用。',
    'requirementRelease.content.clarifications 中 answered 是正式事实；dismissed 只是处置理由，不得转化为断言，相关缺口必须保留。',
    '不得编造阈值、时长、兼容矩阵、接口、定位器、账号、环境或 Expected Result。',
    'PlanningAgent 只生成语义候选；正式 ID、Revision、Version、Hash 和数据库状态由 Service / Validator 管理。',
    stage === 'test_design_repair'
      ? `完成 Self Review 后，通过 ${binding.submitToolId} 提交 test-design-repair/v2 Patch：必须携带任务中给出的 baseCandidateSha256；只提交 upsert/remove 的 Case、数据需求和受影响维度，不要重新提交完整 Candidate、Proposal 或根级 ScenarioClaim。若服务端拒绝，根据错误路径修正后重新提交。`
      : `完成 Self Review 后，通过 ${binding.submitToolId} 提交 test-case-design/v2；Service 会生成完整、可审计的 Candidate Snapshot。若服务端拒绝，根据错误路径修正后重新提交。`,
  ]
}

function stageWorkspace(run: TestDesignWorkflowRun, stage: TestDesignStage): TestDesignWorkspaceSnapshot {
  const byPath = new Map(run.workspaceSnapshot.files.map(file => [file.logicalPath, structuredClone(file)]))
  for (const file of run.formalWorkspaceFiles) byPath.set(file.logicalPath, structuredClone(file))
  if (stage === 'test_case_design') {
    for (const [logicalPath, file] of byPath) {
      if (file.sourceType === 'test_case_library_version') byPath.delete(logicalPath)
    }
  }
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
    requirementReleaseContentSha256: run.workspaceSnapshot.requirementReleaseContentSha256,
    files,
    createdAt: run.workspaceSnapshot.createdAt,
  } satisfies Omit<TestDesignWorkspaceSnapshot, 'snapshotSha256'>
  return { ...base, snapshotSha256: canonicalSha256(base) }
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
    if (!isTestDesignRepairPatch(result)) validateHistoricalProposalPlan(result, run.historicalSnapshot)
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
  candidate: TestCaseDesignCandidate | TestDesignRepairPatch,
): TestCaseDesignCandidateSubmission {
  if (isTestDesignRepairPatch(candidate)) {
    return {
      schemaVersion: candidate.schemaVersion,
      baseCandidateSha256: candidate.baseCandidateSha256,
      upsertCases: candidate.upsertCases.map(item => projectCandidateCase(item, item.coverageClaims ?? [])),
      removeCaseRefs: structuredClone(candidate.removeCaseRefs),
      upsertDataRequirements: structuredClone(candidate.upsertDataRequirements),
      removeDataRequirementRefs: structuredClone(candidate.removeDataRequirementRefs),
      dimensionAssessmentUpdates: structuredClone(candidate.dimensionAssessmentUpdates),
    }
  }
  if (candidate.schemaVersion === 'test-case-design/v2') {
    return {
      schemaVersion: candidate.schemaVersion,
      cases: candidate.cases.map(item => projectCandidateCase(item, candidate.scenarioClaims.filter(claim => claim.caseRef === item.ref))),
      dimensionAssessments: structuredClone(candidate.dimensionAssessments),
      ...(candidate.dataRequirements.length ? { dataRequirements: structuredClone(candidate.dataRequirements) } : {}),
      ...(candidate.findings.length ? { findings: structuredClone(candidate.findings) } : {}),
      ...(candidate.confirmationItems.length ? { confirmationItems: structuredClone(candidate.confirmationItems) } : {}),
      ...(candidate.proposals.length ? { historicalChanges: candidate.proposals.map(item => ({ operation: item.operation, sourceCaseId: item.sourceCaseId, sourceRevision: item.sourceRevision, ...(item.candidateRef ? { candidateRef: item.candidateRef } : {}), reason: item.reason, confidence: item.confidence })) } : {}),
    }
  }
  return {
    schemaVersion: candidate.schemaVersion,
    cases: candidate.cases.map(({ ref, content }) => ({
      ref,
      ...structuredClone(content),
    })),
    dimensionAssessments: structuredClone(candidate.dimensionAssessments),
    scenarioClaims: structuredClone(candidate.scenarioClaims),
    dataRequirements: structuredClone(candidate.dataRequirements),
    findings: structuredClone(candidate.findings),
    confirmationItems: structuredClone(candidate.confirmationItems),
    proposals: structuredClone(candidate.proposals),
  }
}

function projectCandidateCase(candidate: TestCaseDesignCandidate['cases'][number], claims: TestCaseDesignCandidate['scenarioClaims']) {
  return {
    ref: candidate.ref,
    ...structuredClone(candidate.content),
    ...(candidate.changeReason ? { changeReason: candidate.changeReason } : {}),
    ...(candidate.confidence === undefined ? {} : { confidence: candidate.confidence }),
    ...(claims.length ? { coverageClaims: claims.map(({ caseRef: _caseRef, requirementRefs: _requirementRefs, ...claim }) => structuredClone(claim)) } : {}),
  }
}

function testCaseCandidateRecoveryHint(message: string) {
  if (message.includes('不能通过删除 Proposal 省略冻结历史用例')) {
    return '。请恢复每条缺失历史用例的 Proposal；reuse/update 都要将 sourceCaseId/sourceRevision 与本次 cases[] 中完整、扁平的临时 Candidate Case 通过 candidateRef 关联。不要删除 reuse Proposal 来规避校验。'
  }
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
    throw new Error('当前已发布 PlanningAgent 配置与 Toolset 目录内容不一致；请重新发布 PlanningAgent 后再新建测试设计')
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
