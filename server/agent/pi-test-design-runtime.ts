import { createHash } from 'node:crypto'
import type { AgentConfigurationService } from '../application/agent-configuration-service.js'
import { builtInToolBindingToken, toolBindingToken, toolsetContentHash } from '../application/ai-resource-hash.js'
import { canonicalJson, canonicalSha256 } from '../application/canonical-json.js'
import { buildTestDesignDirectoryInputPlan } from './requirement-context-assembler.js'
import { repairCandidateContent, selectRuntimeKnowledgeReferences, TEST_DESIGN_RUNTIME_KNOWLEDGE_REFERENCE_LIMIT, type PlanningAgentRuntime } from '../application/test-design-service.js'
import { isTestDesignRepairPatch, TestDesignError, validateTestCaseDesignCandidate, type TestCaseDesignCandidate, type TestCaseDesignCandidateSubmission, type TestDesignRepairPatch } from '../application/test-design-validation.js'
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
    schemaVersion: 'test-case-design/v3',
  },
  test_design_repair: {
    submitToolId: 'test_design_repair.submit_result',
    schemaVersion: 'test-design-repair/v3',
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
  const knowledgeReferences = stage === 'test_case_design' ? selectRuntimeKnowledgeReferences(run.retrievalSnapshot) : []
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
      content: {
        requirements: run.basisSnapshot.content.requirements,
        evidence: run.basisSnapshot.content.evidence,
        clarifications: run.basisSnapshot.content.clarifications,
      },
    },
    workspace: { root: '/workspace', activeBranch: `/${workspace.activeBranchLogicalPath}`, agentDirectory: `/${workspace.agentLogicalPath}`, snapshotSha256: workspace.snapshotSha256 },
    currentInputRefs: run.currentInputRefs.map(item => ({ logicalPath: item.logicalPath.replace(/^workspace\//u, ''), assetVersionId: item.assetVersionId, contentSha256: item.contentSha256 })),
    design: { name: design.name, objective: design.objective, includedScopes: design.input.includedScopes ?? [], excludedScopes: design.input.excludedScopes ?? [], focusDimensions: design.input.focusDimensions ?? [], executionMethods: design.input.executionMethods ?? [], frozenHistoricalCaseCount: run.historicalSnapshot.items.length },
    ...(stage === 'test_case_design' ? { knowledgeReferences: { source: 'retrievalSnapshot.hits', maxHits: TEST_DESIGN_RUNTIME_KNOWLEDGE_REFERENCE_LIMIT, availableHitCount: run.retrievalSnapshot.hits.length, selectedHitCount: knowledgeReferences.length, hits: knowledgeReferences } } : {}),
    agentCapabilities: { enabledSkills: run.agentConfigurationSnapshot.agentDefinition.enabledSkills },
    runtimeBoundary: { submitTool: binding.submitToolId, schemaVersion: binding.schemaVersion },
    task: testDesignTaskMessage(stage),
    ...(repairState && repairAudit ? { repair: { attempt: repairState.attempt, maxAttempts: repairState.maxAttempts, auditId: repairAudit.id, blockers: repairBlockers, currentCandidatePath: '/workspace/agent_workspace/planning_agent/current-test-cases.json', baseCandidateSha256: canonicalSha256(repairCandidateContent(run)) } } : {}),
    instructions: testDesignStageInstructions(stage),
  })
}

function testDesignTaskMessage(stage: TestDesignStage) {
  if (stage === 'test_case_design') {
    return 'Requirement Release 已正式发布。请直接基于任务中明确提供的结构化 Requirement Release content，并按需读取冻结 Workspace 中的用户资料与历史用例快照，只设计本轮新增或确实需要调整的 TestCase Candidate Delta。未变化历史用例无需重新提交。'
  }
  return 'Coverage Audit 已识别可由 Agent 修复的候选问题。请继续当前测试策划工作，修复任务中列出的 agent_repair blockers，并保持其他候选语义稳定。'
}

function testDesignStageInstructions(stage: TestDesignStage) {
  const binding = TEST_DESIGN_STAGE_BINDINGS[stage]
  const stageRules = stage === 'test_case_design'
    ? [
          'Requirement 是正式业务事实来源，但不是测试设计的场景边界。先围绕独立 Test Intent 设计自然业务闭环，再主动扩展异常、边界、非法输入、非法状态、权限、并发、一致性、重复操作、恢复、查询准确性、性能、稳定性、兼容性、安全、历史缺陷与 Knowledge 风险场景。',
          'Case 拆分单位是独立 Test Intent，不是 Requirement、步骤或接口数量。Create → Read → Update → Read → Delete → Read 和合法 todo → in_progress → completed 可以各自保持一条自然闭环；todo → completed、in_progress → todo、completed → in_progress、completed → todo、空字符串、纯空白、非法枚举、非法操作等能够独立失败的风险应主动拆分。禁止按最小数量或固定倍数凑 Case。',
          'Case 发生创建、更新、删除、状态流转、持久化配置、跨页面数据或异步最终状态变化时，Expected Result 必须描述回读、刷新、重新进入或最终查询后可观察的稳定业务字段或不存在状态，不能只写操作成功。字段格式、必填、可见性、Tooltip、即时前端校验等非持久化 Case 不机械追加闭环，也不得编造接口、Selector、状态值、等待阈值或账号。',
          '合法枚举集合只证明值属于业务集合，不证明该值在任意操作或生命周期阶段都允许输入。对状态字段必须联合枚举、当前状态、状态转换规则和当前操作判断；Requirement 同时定义状态集合与状态机时，不得通过创建时直接指定 in_progress 或 completed 来验证合法状态，优先通过 todo → in_progress → completed 合法流转验证。priority 若无状态机约束，可直接验证 high、medium、low。',
          '存在明确状态机时，Self Review 必须检查每条有业务意义的合法路径，以及可由正式 Requirement 直接确定为非法的反向、跳级边是否遗漏。对 todo → in_progress → completed，in_progress → todo 是可独立失败的明确回退风险；用例应验证拒绝回退且持久化状态仍保持 in_progress，requirementRefs 关联正式状态顺序 Requirement。不穷举数学意义的全部状态组合。',
          'Knowledge Reference 只提示风险，不是正式业务事实，也不强制 Case 粒度。必须把 knowledgeReferences.hits 纳入设计和提交前 Self Review，但不要求每条引用或每个 Requirement 生成 Case。',
          'requirementRefs 仅表示 TestCase 对正式 Requirement 的直接追溯。Expected Result 直接来源于 Requirement 时填写对应 ID；风险或边界探索没有直接 Requirement 行为依据时必须使用 requirementRefs: []，不得为了 Coverage 强行绑定不相关 Requirement。',
          '允许发散但禁止编造产品业务规则、权限矩阵、性能阈值、错误码、错误文案、接口、URL、Selector、账号、环境或状态机。信息不足时只写安全、稳定、一致、无越权、无不可恢复错误等可确定底线，或把技术事实留到 TestExecution 配置。',
          '从 functional、performance、stability、compatibility、security 五个方向思考，只生成有价值的场景；不要求每个维度都有 Case，也不提交适用性表。这是 PlanningAgent 的设计与 Self Review 方法，不是 Validator Gate。',
          '提交前在当前 Planning Session 内执行一次 Self Review：重新检查异常路径、边界条件、非法输入、明确状态机的合法路径与反向/跳级非法边、重复操作、查询准确性、数据一致性、权限风险、历史缺陷，以及已读取 Knowledge 明确提示的风险。对每个发现同时核对本轮 Candidate Delta 与冻结 Historical Baseline；若它可独立失败且没有已有 Case 覆盖，补充独立 Case，否则不要为了增加数量机械补 Case。',
          '筛选、搜索、查询 Case 已构造正样本和负样本时，Expected Result 必须同时验证应命中数据存在、返回数据符合已明确条件、不匹配数据未混入。如 Task A 含唯一关键字、Task B 不含，搜索必须返回 A 且不返回 B；Requirement 未定义时不得编造模糊匹配、大小写、trim、分词或搜索字段规则。',
          '每条 Case 只提交一份自然语言 preconditions、steps、expectedResults。executionMethods 只选择 ui、api 或二者。UI 与 API 的业务 Test Intent 和 Expected Result 相同时，默认使用一条 Case 并选择 executionMethods: [ui, api]；只在 UI 独有二次确认、明确存在不同约束，或 Knowledge/历史缺陷提示前后端校验漂移等独立风险时才拆分。不要区分 UI/API 两套步骤，也不要提交执行配置、数据需求、Coverage 内部模型、Finding、Confirmation 或历史 Proposal。',
          'cases[] 是本轮 Candidate Delta，不是当前版本完整用例库。历史用例完全未变化时允许提交 cases: []；不要为表达 reuse 而重新输出历史 Case，也不要输出 reuse、update、create、deprecate 等生命周期动作。',
          'historical-test-cases.json 中的 requirementRefs 属于其来源 Requirement Release，只用于理解历史测试意图；不得假设相同 RP 编号在当前 Release 中代表相同 Requirement。当前 Requirement direct trace 只能使用 Runtime 提供的当前 Requirement Release ID，跨版本 Requirement Mapping 由 Service 负责。',
        ]
      : [
          '当前任务只列出可安全自动修复的 Coverage blockers；正式 Requirement 保持不变。提交 test-design-repair/v3 时，baseCandidateSha256 必须等于任务与 current-test-cases.json 对应的当前完整 Candidate。',
          'upsertCases 只包含新增或完整替换的扁平 test-case/v3；removeCaseRefs 只删除本轮 Candidate。未在 Patch 中出现的 Case 保持不变。',
          'Requirement 未覆盖时，应新增真正验证该 Requirement 的 Case；不得把已有扩展风险 Case 强行增加 requirementRefs 只为让 Coverage 变绿。',
          '不得映射旧 Requirement、修改 Historical requirementRefs 或补写历史 Traceability；跨版本 Requirement Mapping 完全由 Service 负责。',
        ]
  const readingRules = stage === 'test_case_design'
    ? [
        '正式 Requirement、Evidence 和 Clarification 已由 Runtime 在 requirementRelease.content 中直接提供；不要到 Workspace 寻找它们的 JSON 或 Markdown 镜像。coreFactPaths 只列出需要自主读取的冻结历史资料。',
        '若 coreFactPaths 中存在 historical-test-cases.json，它是本轮唯一的冻结历史用例库基线。可按需读取它来理解已有覆盖、避免无意义重复，并识别当前 Requirement 变化可能影响的既有场景；只输出新增或确实需要调整的 TestCase。未输出的历史 Case 默认继续保留，禁止用省略表达删除或废弃。不得用 branches/*/test-case-library/v*/ 下的其他正式投影重复建立历史基线。',
        '当前 Context 已经读取过的 Workspace / Knowledge 正文必须直接复用；相同 contentHash 和所需行范围仍可见时，不得因确认、Stage 切换、Self Review 或多个 Skill 的方法重叠而重读。knowledgeReferences.hits 是 Service 从本 Run 已冻结 retrievalSnapshot.hits 中去重、裁剪后的直接输入，必须作为 Case 设计和 Self Review 的风险参考，无需再次搜索才能获得既有 Retrieval。',
        '只有存在已命名且 knowledgeReferences 与当前 Context 未解决的风险或事实缺口时，才自主调用 knowledge.search 定位最小必要范围；搜索命中需要完整上下文时再调用 knowledge.read_chunk。结果不理想时允许修改 Query 后继续搜索。不得为每个 Requirement 机械搜索，也不得为了流程完整而调用 Knowledge 工具。',
      ]
    : [
        '修复阶段优先读取 current-test-cases.json、Requirement Release 和 blocker 指明的资料。current-test-cases.json 只包含本轮 Candidate Delta；removeCaseRefs 只撤销本轮 Candidate，绝不删除或废弃 Historical Baseline。除 blocker 直接引用外，不回读历史用例库或共享知识。',
      ]
  return [
    ...stageRules,
    ...readingRules,
    '提交 Case 必须是扁平 test-case/v3：ref、schemaVersion、title、dimension、priority、requirementRefs、executionMethods、preconditions、steps、expectedResults，禁止额外字段或 { ref, content } 包装。',
    'Runtime 实际暴露的工具、结果 Schema 和 Submit Tool 是本轮执行权限边界。',
    'Workflow 只推进业务流程，不调度 Skill；PlanningAgent 查看 Enabled Skill Catalog，并只在当前 Stage 确有方法缺口时自主决定是否通过 skill.read 读取正文。已有 TRUSTED_SKILL 正文仍在 Context 时直接复用。',
    'requirementRelease.content.clarifications 中 answered 是正式事实；dismissed 只是处置理由，不得转化为断言，相关缺口必须保留。',
    '不得编造阈值、时长、兼容矩阵、接口、定位器、账号、环境或产品业务 Expected Result。',
    'PlanningAgent 只生成语义候选；正式 ID、Revision、Version、Hash 和数据库状态由 Service / Validator 管理。',
    stage === 'test_design_repair'
      ? `完成 Self Review 后，通过 ${binding.submitToolId} 提交 test-design-repair/v3 Patch：携带 baseCandidateSha256，并只提交 upsertCases/removeCaseRefs。若服务端拒绝，根据错误路径修正后重新提交。`
      : `完成 Self Review 后，通过 ${binding.submitToolId} 提交根对象严格只有 schemaVersion 和 cases 的 test-case-design/v3。若服务端拒绝，根据错误路径修正后重新提交。`,
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
      upsertCases: candidate.upsertCases.map(projectCandidateCase),
      removeCaseRefs: structuredClone(candidate.removeCaseRefs),
    }
  }
  return {
    schemaVersion: candidate.schemaVersion,
    cases: candidate.cases.map(projectCandidateCase),
  }
}

function projectCandidateCase(candidate: TestCaseDesignCandidate['cases'][number]) { return { ref: candidate.ref, ...structuredClone(candidate.content) } }

function testCaseCandidateRecoveryHint(_message: string) { return '。请严格按 v3 Schema 提交，不要恢复已删除的治理或执行字段。' }

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
