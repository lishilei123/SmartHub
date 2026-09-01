import { createHash } from 'node:crypto'
import type { AgentConfigurationService } from '../application/agent-configuration-service.js'
import {
  builtInToolBindingToken,
  matchesSkillConfigurationHash,
  toolBindingToken,
  toolsetContentHash,
} from '../application/ai-resource-hash.js'
import { canonicalJson, canonicalSha256 } from '../application/canonical-json.js'
import { governedExecutionEntryFile } from '../application/test-execution-entry.js'
import type {
  AgentExecutionContext,
  AgentExecutionEvent,
  AgentExecutionOutput,
  AgentDefinitionVersion,
  AgentModelConnection,
  InputDeliveryManifest,
  TestExecutionAgentSnapshot,
  TestExecutionAgentWorkspaceProjection,
} from '../domain/agent-types.js'
import type {
  ExecutionRun,
  ExecutionTask,
  FrozenExecutionAgentSnapshot,
} from '../domain/test-execution-types.js'
import { agentDefinitionContentSha256 } from './planning-agent.js'
import type {
  AgentConfigurationVersion,
  AgentModelReference,
  DatabaseState,
  GenerativeModel,
  GenerativeModelSource,
  SkillResource,
  ToolResource,
} from '../domain/types.js'
import type { StateStore } from '../infrastructure/store.js'
import { defaultBuiltInToolConfigResolver } from '../tools/built-in-tool-config.js'
import { agentCatalogEntryByDefinition } from './agent-catalog.js'
import { piVersion, type PiAgentRuntimeAdapter } from './pi-agent-runtime.js'
import { buildTestExecutionDirectoryInputPlan } from './requirement-context-assembler.js'
import type { UiExecutionBrowserContext } from './ui-execution-agent.js'
import {
  BROWSER_TOOL_IDS,
  type BrowserToolSession,
} from '../tools/playwright-browser-tools.js'

const TEST_EXECUTION_WORKSPACE_TOOL_IDS = [
  'workspace.read_file',
  'workspace.grep_files',
  'workspace.find_files',
  'workspace.list_directory',
] as const

const TEST_EXECUTION_KNOWLEDGE_TOOL_IDS = [
  'knowledge.search',
  'knowledge.read_chunk',
] as const

export const TEST_EXECUTION_STAGE_BINDINGS = {
  script_generation: {
    agentKey: 'execution-implementation',
    snapshotKey: 'executionImplementation',
    agentType: 'execution_implementation',
    configurationSchemaVersion: 'execution-implementation/v1',
    skillKey: 'test-script-generation',
    submitToolId: 'execution_implementation.submit_result',
    schemaVersion: 'test-script-generation/v1',
    agentLabel: 'ExecutionImplementationAgent',
    runtimeToolIds: [
      ...TEST_EXECUTION_WORKSPACE_TOOL_IDS,
      ...TEST_EXECUTION_KNOWLEDGE_TOOL_IDS,
      ...BROWSER_TOOL_IDS,
    ],
  },
  failure_diagnosis: {
    agentKey: 'failure-analysis',
    snapshotKey: 'failureAnalysis',
    agentType: 'failure_analysis',
    configurationSchemaVersion: 'failure-analysis/v1',
    skillKey: 'failure-analysis',
    submitToolId: 'failure_analysis.submit_result',
    schemaVersion: 'failure-analysis/v1',
    agentLabel: 'FailureAnalysisAgent',
    runtimeToolIds: [...TEST_EXECUTION_WORKSPACE_TOOL_IDS],
  },
  script_repair: {
    agentKey: 'execution-implementation',
    snapshotKey: 'executionImplementation',
    agentType: 'execution_implementation',
    configurationSchemaVersion: 'execution-implementation/v1',
    skillKey: 'script-repair',
    submitToolId: 'execution_implementation.submit_result',
    schemaVersion: 'script-repair/v1',
    agentLabel: 'ExecutionImplementationAgent',
    runtimeToolIds: [...TEST_EXECUTION_WORKSPACE_TOOL_IDS, ...BROWSER_TOOL_IDS],
  },
} as const

export type TestExecutionAgentStage = keyof typeof TEST_EXECUTION_STAGE_BINDINGS

type StageBinding = typeof TEST_EXECUTION_STAGE_BINDINGS[TestExecutionAgentStage]

type CandidateValidation = (
  candidate: Record<string, unknown>,
  manifest: InputDeliveryManifest,
) => Promise<{
  valid: boolean
  result?: Record<string, unknown>
  issues: Array<{ path: string; message: string }>
}>

export interface TestExecutionAgentStageContext {
  scriptRevisionId?: string
  parentScriptRevisionId?: string
  diagnosisId?: string
  attemptIds?: string[]
  artifactIds?: string[]
  repairCount?: number
  /** Service-owned physical entry; required when repairing a legacy Binding path. */
  entryFile?: string
}

export interface TestExecutionAgentRuntimeInput {
  stage: TestExecutionAgentStage
  run: ExecutionRun
  task: ExecutionTask
  workspace: TestExecutionAgentWorkspaceProjection
  /** Ephemeral output from the Service-owned Playwright CLI capability. */
  uiExecution?: UiExecutionBrowserContext
  /** Service-owned invocation session; its opaque CLI identity is never sent to the model. */
  browserSession?: BrowserToolSession
  stageContext?: TestExecutionAgentStageContext
  validateCandidate: CandidateValidation
}

export interface TestExecutionAgentRuntimeOutput {
  schemaVersion: StageBinding['schemaVersion']
  candidate: Record<string, unknown>
  execution: {
    agentKey: StageBinding['agentKey']
    workflowStage: TestExecutionAgentStage
    turns: number
    toolCalls: number
    toolErrors: number
    events: AgentExecutionEvent[]
    framework: AgentExecutionOutput['framework']
    context?: AgentExecutionContext
  }
}

const EXECUTION_AGENT_KEYS = [
  'execution-implementation',
  'failure-analysis',
] as const

export class PiTestExecutionRuntimeAdapter {
  constructor(
    private readonly store: StateStore,
    private readonly piRuntime: PiAgentRuntimeAdapter,
    private readonly configurations: AgentConfigurationService,
  ) {}

  async readiness() {
    const state = await this.store.snapshot()
    const agents = await Promise.all(EXECUTION_AGENT_KEYS.map(async agentKey => {
      const configuration = await this.configurations.resolveActive(agentKey)
      if (!configuration) {
        return {
          agentKey,
          ready: false,
          reason: `未发布 ${agentCatalogEntryByDefinition(agentKey).identifier} 配置`,
        }
      }
      try {
        validateConfiguration(configuration, state, bindingByAgentKey(agentKey))
        return { agentKey, ready: true }
      } catch (error) {
        return {
          agentKey,
          ready: false,
          reason: error instanceof Error ? error.message : String(error),
        }
      }
    }))
    return { ready: agents.every(agent => agent.ready), agents }
  }

  async freezeConfiguration(): Promise<ExecutionRun['agents']> {
    return this.freezeConfigurations()
  }

  async freezeConfigurations(): Promise<ExecutionRun['agents']> {
    const configurations = await Promise.all(EXECUTION_AGENT_KEYS.map(async agentKey => {
      const configuration = await this.configurations.resolveActive(agentKey)
      if (!configuration) {
        throw new Error(
          `TEST_EXECUTION_AGENT_NOT_READY: 未发布 ${agentCatalogEntryByDefinition(agentKey).identifier} 配置`,
        )
      }
      return [agentKey, configuration] as const
    }))
    const state = await this.store.snapshot()
    const frozen = new Map(configurations.map(([agentKey, configuration]) => {
      const binding = bindingByAgentKey(agentKey)
      validateConfiguration(configuration, state, binding)
      return [agentKey, freezeAgent(configuration, resolveModel(state, configuration), agentKey)]
    }))
    return {
      executionImplementation: required(frozen.get('execution-implementation'), 'EXECUTION_IMPLEMENTATION_AGENT_SNAPSHOT_REQUIRED'),
      failureAnalysis: required(frozen.get('failure-analysis'), 'FAILURE_ANALYSIS_AGENT_SNAPSHOT_REQUIRED'),
    }
  }

  async execute(
    input: TestExecutionAgentRuntimeInput,
    signal: AbortSignal,
  ): Promise<TestExecutionAgentRuntimeOutput> {
    const binding = TEST_EXECUTION_STAGE_BINDINGS[input.stage]
    const frozen = input.run.agents[binding.snapshotKey]
    validateStageInput(input, binding, frozen)
    const configuration = await this.configurations.resolveVersion(frozen.configurationId)
    const state = await this.store.snapshot()
    validateConfiguration(configuration, state, binding)
    validateFrozenConfiguration(configuration, frozen)
    const model = resolveModel(state, configuration)
    validateFrozenModel(model, frozen)
    const task = buildTestExecutionAgentTask(input, binding)
    const snapshot = buildAgentSnapshot(input, configuration, task)
    const inputPlan = buildTestExecutionDirectoryInputPlan({
      snapshot,
      definition: configuration.agentDefinition,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
    })
    const events: AgentExecutionEvent[] = []
    try {
      const allowedToolIds = runtimeToolIds(input, binding)
      const output = await this.piRuntime.execute({
        snapshot,
        model,
        requirementInputPlan: inputPlan,
        executionProfile: {
          mode: 'workspace_tools',
          workflowStage: input.stage,
          allowedToolIds: [...allowedToolIds, binding.submitToolId],
          submitToolId: binding.submitToolId,
          schemaVersion: binding.schemaVersion,
          agentLabel: binding.agentLabel,
          initialTask: task,
          ...(input.browserSession ? {
            runtimeToolBindings: input.browserSession.runtimeToolBindings(),
          } : {}),
          validateCandidate: input.validateCandidate,
        },
        onEvent: event => { events.push(event) },
      }, signal)
      return {
        schemaVersion: binding.schemaVersion,
        candidate: output.candidate as Record<string, unknown>,
        execution: executionRecord(
          binding.agentKey,
          input.stage,
          output.events,
          output.turns,
          output.toolCalls,
          output.toolErrors,
          output.framework,
          output.context,
        ),
      }
    } catch (error) {
      const failure = new Error(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      ) as Error & { execution?: TestExecutionAgentRuntimeOutput['execution'] }
      failure.execution = executionRecord(binding.agentKey, input.stage, events)
      throw failure
    }
  }
}

export function buildTestExecutionAgentTask(
  input: Omit<TestExecutionAgentRuntimeInput, 'validateCandidate'>,
  binding = TEST_EXECUTION_STAGE_BINDINGS[input.stage],
) {
  const workspace = input.workspace.documentWorkspace
  const explorationContext = input.workspace.workspaceFiles.find(
    file => file.logicalPath.endsWith('/exploration/context.json'),
  )
  const entryFile = input.stage === 'failure_diagnosis'
    ? undefined
    : input.stageContext?.entryFile ?? governedExecutionEntryFile(input.task.input)
  return canonicalJson({
    schemaVersion: 'test-execution-agent-task/v2',
    agent: binding.agentLabel,
    assignment: stageAssignment(input.stage),
    testCase: input.task.input.caseContent,
    execution: {
      method: input.task.input.method,
      dimension: input.task.input.dimension,
      specification: input.task.input.executionSpec,
      ...(entryFile ? {
        entry: {
          file: entryFile,
          symbol: `[${input.task.input.caseId}]`,
        },
      } : {}),
      ...(input.task.input.testDataBindings?.length
        ? { testDataBindings: input.task.input.testDataBindings }
        : {}),
    },
    workspace: {
      root: '/',
      logicalRoot: `/${workspace.rootLogicalPath ?? workspace.logicalPath}`,
      ...(workspace.activeBranchLogicalPath
        ? { activeBranch: `/${workspace.activeBranchLogicalPath}` }
        : {}),
      ...(workspace.agentLogicalPath
        ? { agentDirectory: `/${workspace.agentLogicalPath}` }
        : {}),
      fileCount: input.workspace.workspaceFiles.length,
      ...(explorationContext ? {
        explorationContext: {
          logicalPath: '/exploration/context.json',
          contentSha256: explorationContext.contentSha256,
          authority: 'runtime_observed_knowledge',
        },
      } : {}),
    },
    ...(input.uiExecution ? { uiExecution: input.uiExecution } : {}),
    instructions: stageInstructions(input.stage, input.task.input.caseId, binding.submitToolId, entryFile),
  })
}

function stageAssignment(stage: TestExecutionAgentStage) {
  if (stage === 'script_generation') return '根据冻结 TestCase 和 Execution Workspace 实现 Playwright 自动化代码'
  if (stage === 'failure_diagnosis') return '根据当前失败 Attempt 和 Runner Evidence 客观判断失败类型'
  return '根据已确认的 FailureDiagnosis 修复 Playwright 实现'
}

function stageInstructions(
  stage: TestExecutionAgentStage,
  caseId: string,
  submitToolId: string,
  entryFile?: string,
) {
  const common = [
    '只使用冻结 TestCase、只读 Workspace 与当前 Runtime 明确授权的上下文；不得编造 API、Selector、凭据、业务规则或预期结果。',
    '不得修改 TestCase、Expected Result、Verification Check、受保护断言语义或测试目标。',
    '不得调用 Shell、数据库、任意网络、其他 Agent 或 Runner；Service 和 Runner 负责流程与真实执行。',
  ]
  if (stage === 'failure_diagnosis') return [
    ...common,
    '只根据当前失败 Attempt、Execution Event 与 Artifact 证据分类；不得修改脚本或决定是否修复。',
    'Workspace 工具的当前目录就是本任务的冻结根目录；先读取 attempts.json、events.json，若存在 evidence/ 则必须读取其中与终态 Attempt 对应的 Runner 日志摘录。',
    '若 HTTP 证据为 404/405，且冻结 TestCase 未明确要求该状态码，必须判定为 API 契约/脚本实现问题 script_defect；Validator 要求通用 4xx 断言排除 404/405 是为了暴露错误路径/方法，绝不能将该保护性断言诊断为 assertion_mismatch。只有 400/401/403/409/422 等非路由失败状态被脚本自行收窄、且冻结 Expected Result 未固定时，才属于 assertion_mismatch。',
    '若 events.json 的 failure phase=load，且证据指向脚本导入、测试发现或入口实现（包括 No tests found），应归类 script_defect；只有独立 Runner readiness 或依赖安装证据才能支持 environment_defect。',
    '若 T1、T2、K 等符号数据未由冻结 Test Data Binding、成功 setup 响应或显式前置数据守卫证明存在，且现有契约证据未提供可信创建路径，相关失败应归类 test_data_defect，不能据此报告 product_defect。若 Workspace 或 Exploration Context 已提供可信创建路径，而脚本只用 guard 依赖可变存量数据、没有落实本应自给的前置条件，应归类 script_defect 以允许修复。',
    '当失败来自可变存量数据 guard 时，在提交 test_data_defect 前必须先用 workspace.grep_files/find_files/read_file 检查当前 Workspace 是否已有同类实体的可信创建 helper、API Case、Fixture 或 UI setup；找到可信创建路径而当前脚本未使用时应归类 script_defect。',
    '若脚本从全局列表选择 first/find 任意现有记录来满足可变状态前置，且同一 Run 的并发任务或其他业务操作能够修改该记录，即使终态表现为 API 与 UI 状态不一致，也应归类 script_defect；可信创建路径存在时，脚本必须自建带唯一标识的记录、按合法路径准备状态并清理，不能把共享记录竞争归为 test_data_defect。',
    'UI 失败必须优先核对 events.json 中 category=terminal_page 的同源终态路径和页面地标；它们是 Runner 从本次 Playwright Trace 提取的正向观察事实。不得只根据失败 Locator 猜测 assertion_mismatch；若终态路径或页面地标直接违反冻结 Expected Result，应按产品行为证据判断。',
    '若失败来自脚本自行增加、但冻结 Expected Result/Verification Check 未要求的提示文案、Toast、状态码或其他额外门槛，应归类 script_defect；assertion_mismatch 只用于受保护断言本身与冻结预期存在语义冲突，不能让额外实现断言阻断自动修复。',
    '若冻结预期要求在变更前出现确认交互，脚本已在点击正确目标前注册原生 dialog 观察，点击后观察值仍为 false，且终态仍位于正确业务页面、未观察到 modal、确认文案或确认/取消控件，这已经是“未提供确认交互”的直接产品证据，应归类 product_defect；不要求脚本继续执行到对象已被修改或删除后才成立。若对象已直接被修改或删除，同样归类 product_defect。只有 Trace/页面证据真实显示另一种确认控件而脚本没有绑定时，才归类 script_defect；不得无证据猜测“可能是非原生确认”并返回 unknown。',
    '若确认类脚本把“目标对象仍可见”、固定布尔值、点击完成或其他非确认观察当成确认已出现，后续失败应归类 script_defect：受保护确认断言必须绑定真实 dialog、modal、确认文案或确认/取消控件证据，不能由对象可见性代替。',
    '若冻结步骤要求修改实体，脚本已定位正确实体并尝试触发修改，但终态仍在正确业务页面且页面地标/控件证据中不存在改名、编辑、保存等任何修改入口，也没有出现 modal/dialog，则这是产品未提供冻结能力的直接证据，应归类 product_defect，不得仅因没有更新请求而返回 unknown。若证据显示存在真实修改入口但脚本触发了错误元素，才归类 script_defect。',
    '若已登录 UI 脚本需要同源 API 数据却从 @playwright/test 导入并使用 page.request，而没有从 @smarthub/playwright-test 接收受管 request fixture，且失败发生在该辅助请求或其 response.ok() 门槛、尚未到达受保护业务断言，应归类 script_defect。即使 Trace 事件摘要与 response.ok() 表现矛盾，也不得返回 unknown：当前脚本未使用平台规定的 Run-scoped Bearer bridge 是可直接从 ScriptRevision 观察的实现缺陷。',
    `完成后只调用 ${submitToolId} 提交 category、reason、evidence。`,
  ]
  const implementation = [
    ...common,
    '实现阶段可使用只读 Workspace、Knowledge、已有 Runtime Observation 与当前 invocation 明确授权的 Browser Tools。',
    `Playwright Test 标题必须以稳定 Case Symbol ${JSON.stringify(`[${caseId}]`)} 结尾。`,
    `entryFile 必须为 Service 指定的 ${JSON.stringify(entryFile)}；该文件只归当前 Case 所有，不得写入或改写其他 Case。`,
    '优先复用 execution/ 下已有 tests、pages、api、helpers 和 fixtures；API 使用 request/APIRequestContext，UI 必须完成真实 UI 操作与页面断言；已登录 UI 如用 request 辅助准备，入口 test/expect 必须来自 @smarthub/playwright-test。',
    '先复用 Workspace 和已有 Observation；只有实现所需信息不足时才按需、多轮调用 Browser Tools。Browser Observation 是运行时观察事实，不是 Requirement Truth。',
    'Browser Tools 只用于受控探索，不是 Runner；不得把工具观察解释为 PASS/FAIL，也不得据此改变 Expected Result 或弱化断言。',
    '每条前置条件都必须由冻结 Test Data、受管 Fixture、可追溯的 setup/cleanup 或运行时可观察验证来落实；T1、T2、K 等用例符号不是环境中已存在数据的证明，无法落实时不得提交可执行候选。',
    '仅检查前置数据并在缺失时失败，不算落实前置条件；已有可信 setup API、Fixture 或合法 UI 流程时必须创建所需状态并在清理阶段隔离回收。状态机数据必须按已知合法边创建，禁止直接写入或猜测捷径。',
    '不得从全局列表选择 first/find 任意现有记录来满足可能被并发任务修改的前置条件。每个 Case 必须创建带本次唯一标识的实体并只操作自己的记录；状态型前置必须通过已知合法流转准备，最后清理。',
    'Dashboard、报表或聚合一致性 Case 不得依赖可变的全局种子数量；若可信 UI/受管 Fixture/同源 setup 契约可用，应为每个必要类别创建最小隔离数据，并从已创建记录或可观察源数据推导期望，完成后清理。',
    'API 的 method、path、query 参数和 request body 字段必须来自复用代码、Exploration Context 或本次 Browser Observation；禁止根据命名习惯猜测 /search、/auth/login、PATCH 等契约。契约仍不可观察时不得提交候选。',
    '每次 Service 重试都是新的提交校验 invocation；即使同一 Session 记得先前内容，提交 API 脚本前也必须在本次 invocation 重新 read /exploration/context.json、相关 execution/api|helpers|fixtures|tests/api 文件，或执行 knowledge.search 后 read_chunk。只 search、只依赖历史读取或反复提交不能满足契约证据门。',
    '每个需要读取响应体的 API 请求必须包装在标题精确形如 test.step("METHOD /relative/path", ...) 的步骤中；Runner 会用该方法和相对路径关联同源 Trace，固化脱敏状态码、请求与响应证据。不得使用“发起登录请求”等无法关联 HTTP Trace 的自由文本步骤标题。',
    'API Case 的 test/expect 必须直接从 @playwright/test 导入；@smarthub/playwright-test 只允许用于冻结前置条件明确已登录、且确实需要 request 辅助准备的 UI Case。',
    'API 异常场景不得把业务失败自行等同于 HTTP 4xx：只有冻结 Expected Result 明确要求 HTTP/状态码时，受保护断言才能锚定状态码或 4xx 范围。否则应把冻结的业务错误字段、成功标志或持久化不变量作为受保护断言；404/405 仅作为非锚定防误报保护并必须触发契约修复，不能把不存在的路径、错误方法或“200 + 业务失败响应”误判。',
    '重复删除、幂等或恢复性 Case 若未冻结具体响应状态，应通过目标仍不存在、对照数据仍可读、后续列表/查询仍成功等持久化不变量证明结果；不得把 response.ok()、4xx 范围或任意单一状态码作为受保护业务断言。',
    'UI 拒绝类 Case 若冻结 Expected Result 未指定错误文案，不得额外要求某个 Toast、提示文本或正则必须可见；应在刷新、重新进入或稳定页面查询后通过持久化业务状态证明操作被拒绝。',
    'UI 状态机负向 Case 不得用页面上可见的合法前进、回退或其他相邻动作替代冻结步骤中的目标非法动作。若目标对象范围内根本不提供该非法转换入口，应验证该对象内不存在对应按钮、菜单项或选项，并在刷新后验证状态未改变；不得点击其他合法动作制造失败，也不得使用页面级宽泛状态文本定位器代替对象内定位。',
    '只提交需要新增或修改的 Workspace 文件；summary 仅用于简短说明。',
  ]
  if (stage === 'script_repair') implementation.push(
    '当前 Stage 只根据已确认的 FailureDiagnosis、当前 ScriptRevision、Runner Evidence 和 Execution Workspace 修复实现问题；不得重新进行需求分析、测试设计或通过 Knowledge 搜索扩大修复范围。',
    '只修改诊断支持的实现问题；不得删除、绕过或弱化受保护断言和业务闭环。',
    '若诊断指出脚本增加了冻结预期未要求的提示文案、Toast 或状态码门槛，应移除该额外门槛，并保留或补全刷新/重新进入后的受保护持久化状态验证；这属于修复脚本实现，不是弱化正式断言。',
    '若诊断证据显示脚本为受保护业务不变量增加了未冻结且返回 404/405 的辅助 API 路径，应删除该无效调用，或改用 Exploration Context/Workspace 已证明的列表、查询契约验证同一不变量；不得因为它靠近断言锚点就保留错误路由。',
    '若诊断指出确认断言由对象可见性、固定布尔值或点击完成冒充，应删除该替代逻辑，只让真实 dialog/modal/确认文案或确认/取消控件设置确认观察；若真实确认不存在，让受保护断言如实失败，禁止继续猜测或制造确认。',
    '若诊断指出状态机动作被错误替换或定位器范围过宽，必须回到目标对象范围：只定位该对象内真实存在的目标动作；目标非法动作未暴露时验证其入口在该对象内不存在并刷新验证持久化状态，禁止改点合法相邻动作或使用页面级状态文本。',
    '若诊断指出 Dashboard、报表或聚合脚本只依赖可变存量数据的 guard，而当前证据已有可信创建路径，应创建最小隔离前置数据、从受控源数据推导期望并清理；不得保留“环境必须预先有数据”的实现假设。',
    '若诊断指出脚本从全局列表选择任意现有记录并与并发任务发生状态竞争，应改为在本 Case 内创建带唯一标识的记录，通过已知合法流转准备所需状态，只操作该记录并在 finally 清理；不得通过降低 Worker 并发度掩盖数据隔离缺陷。',
    '已登录 UI Case 需要同源 APIRequestContext 读取或准备数据时，必须把入口改为从 @smarthub/playwright-test 导入 test/expect，并从测试参数接收受管 request fixture；禁止用 page.request 代替，因为浏览器 localStorage 登录不会自动成为其 Bearer 凭据。若诊断已指出 response.ok() 是未冻结的辅助门槛，应移除该门槛并保留真正的响应体解析与受保护 Dashboard/持久化对账断言；不得原样提交导致 TEST_EXECUTION_REPAIR_NO_CHANGE。',
  )
  return [...implementation, `完成后只调用 ${submitToolId} 提交 entryFile、files，可选 summary。`]
}

function buildAgentSnapshot(
  input: TestExecutionAgentRuntimeInput,
  configuration: AgentConfigurationVersion,
  task: string,
): TestExecutionAgentSnapshot {
  return {
    ...structuredClone(input.workspace),
    agentDefinition: stageAgentDefinition(configuration.agentDefinition, bindingForStage(input.stage)),
    executionSessionKey: executionSessionKey(input),
    ...(input.browserSession ? {
      browserAuthorization: {
        runId: input.run.id,
        taskId: input.task.id,
        projectVersionId: input.run.projectVersionId,
        environmentSignature: input.run.environment.signature,
        stage: input.stage as 'script_generation' | 'script_repair',
      },
    } : {}),
    taskSha256: canonicalSha256(task),
    createdAt: new Date().toISOString(),
  }
}

function bindingForStage(stage: TestExecutionAgentStage) {
  return TEST_EXECUTION_STAGE_BINDINGS[stage]
}

function stageAgentDefinition(
  definition: AgentDefinitionVersion,
  binding: StageBinding,
): AgentDefinitionVersion {
  const selected = definition.skillBindings.filter(
    skill => skill.enabled && skill.skillKey === binding.skillKey,
  )
  if (selected.length !== 1) throw new Error(`${binding.agentLabel} 当前 Stage Skill 快照无效`)
  const {
    contentSha256: _contentSha256,
    skillBindings: _skillBindings,
    enabledSkills: _enabledSkills,
    ...base
  } = definition
  const projected = {
    ...structuredClone(base),
    skillBindings: structuredClone(selected),
    enabledSkills: selected.map(skill => skill.skillKey),
  }
  return {
    ...projected,
    contentSha256: createHash('sha256').update(JSON.stringify(projected)).digest('hex'),
  }
}

function executionSessionKey(input: TestExecutionAgentRuntimeInput) {
  if (input.stage === 'failure_diagnosis') {
    const revisionId = required(
      input.stageContext?.scriptRevisionId,
      'TEST_EXECUTION_DIAGNOSIS_REVISION_SESSION_REQUIRED',
    )
    return `execution-diagnosis:${input.run.id}:${input.task.id}:${revisionId}`
  }
  return `execution-implementation:${input.run.id}:${input.task.id}`
}

function validateStageInput(
  input: TestExecutionAgentRuntimeInput,
  binding: StageBinding,
  frozen: FrozenExecutionAgentSnapshot,
) {
  if (input.task.runId !== input.run.id || input.workspace.runId !== input.run.id) {
    throw new Error('TEST_EXECUTION_AGENT_RUN_SCOPE_MISMATCH')
  }
  if (input.workspace.taskId !== input.task.id) {
    throw new Error('TEST_EXECUTION_AGENT_TASK_SCOPE_MISMATCH')
  }
  if (
    input.workspace.projectId !== input.run.projectId
    || input.workspace.projectVersionId !== input.run.projectVersionId
  ) {
    throw new Error('TEST_EXECUTION_AGENT_PROJECT_SCOPE_MISMATCH')
  }
  if (frozen.agentKey !== binding.agentKey) {
    throw new Error('TEST_EXECUTION_AGENT_STAGE_SNAPSHOT_MISMATCH')
  }
  if (input.browserSession) {
    const scope = input.browserSession.scope
    if (
      input.stage === 'failure_diagnosis'
      || input.task.input.method !== 'ui'
      || scope.runId !== input.run.id
      || scope.taskId !== input.task.id
      || scope.projectVersionId !== input.run.projectVersionId
      || scope.environmentSignature !== input.run.environment.signature
      || scope.baseUrl !== input.run.environment.baseUrl
      || scope.stage !== input.stage
    ) throw new Error('TEST_EXECUTION_BROWSER_SESSION_SCOPE_MISMATCH')
  }
  if (input.stage === 'failure_diagnosis') {
    if (
      !input.stageContext?.scriptRevisionId
      || !input.stageContext.attemptIds
      || input.stageContext.attemptIds.length < 1
    ) throw new Error('TEST_EXECUTION_DIAGNOSIS_CONTEXT_REQUIRED')
  }
  if (input.stage === 'script_repair') {
    if (
      !input.stageContext?.parentScriptRevisionId
      || !input.stageContext.diagnosisId
      || !input.stageContext.entryFile
    ) {
      throw new Error('TEST_EXECUTION_REPAIR_CONTEXT_REQUIRED')
    }
    if ((input.stageContext.repairCount ?? input.task.repairCount) >= 2) {
      throw new Error('TEST_EXECUTION_REPAIR_LIMIT_REACHED')
    }
  }
}

function runtimeToolIds(input: TestExecutionAgentRuntimeInput, binding: StageBinding) {
  return binding.runtimeToolIds.filter(toolId =>
    !BROWSER_TOOL_IDS.includes(toolId as typeof BROWSER_TOOL_IDS[number])
    || Boolean(input.browserSession))
}

function freezeAgent(
  configuration: AgentConfigurationVersion,
  model: AgentModelConnection,
  agentKey: FrozenExecutionAgentSnapshot['agentKey'],
): FrozenExecutionAgentSnapshot {
  const base = {
    agentKey,
    configurationId: configuration.id,
    configurationVersion: configuration.version,
    configurationSha256: configuration.contentSha256,
    definitionSha256: configuration.agentDefinition.contentSha256,
    model: frozenModel(model),
  }
  return { ...base, snapshotSha256: canonicalSha256(base) }
}

function frozenModel(model: AgentModelConnection): FrozenExecutionAgentSnapshot['model'] {
  return {
    sourceId: model.sourceId,
    modelId: model.modelId,
    providerType: model.providerType,
    modelName: model.modelName,
    baseUrlSha256: sha256(model.baseUrl),
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    supportsReasoning: model.supportsReasoning,
    requestTimeoutMs: model.requestTimeoutMs ?? 0,
    retryCount: model.retryCount ?? 0,
  }
}

function validateFrozenConfiguration(
  configuration: AgentConfigurationVersion,
  frozen: FrozenExecutionAgentSnapshot,
) {
  if (
    configuration.id !== frozen.configurationId
    || configuration.version !== frozen.configurationVersion
    || configuration.contentSha256 !== frozen.configurationSha256
    || configuration.agentDefinition.contentSha256 !== frozen.definitionSha256
  ) throw new Error('TEST_EXECUTION_AGENT_CONFIGURATION_DRIFT')
  const definitionSha256 = configuration.agentDefinition.contentSha256
  if (agentDefinitionContentSha256(configuration.agentDefinition) !== definitionSha256) {
    throw new Error('TEST_EXECUTION_AGENT_DEFINITION_HASH_INVALID')
  }
  const { snapshotSha256, ...snapshotBase } = frozen
  if (canonicalSha256(snapshotBase) !== snapshotSha256) {
    throw new Error('TEST_EXECUTION_AGENT_SNAPSHOT_HASH_INVALID')
  }
}

function validateFrozenModel(
  model: AgentModelConnection,
  frozen: FrozenExecutionAgentSnapshot,
) {
  if (canonicalSha256(frozenModel(model)) !== canonicalSha256(frozen.model)) {
    throw new Error('TEST_EXECUTION_AGENT_MODEL_DRIFT')
  }
}

function validateConfiguration(
  configuration: AgentConfigurationVersion,
  state: DatabaseState,
  binding: StageBinding,
) {
  const definition = configuration.agentDefinition
  const catalog = agentCatalogEntryByDefinition(binding.agentKey)
  if (
    configuration.scene !== 'test_execution'
    || configuration.agentKey !== catalog.configurationKey
    || definition.agentKey !== binding.agentKey
    || definition.agentType !== binding.agentType
    || definition.modelScene !== 'test_execution'
    || definition.resultSchemaVersion !== binding.configurationSchemaVersion
  ) throw new Error(`${binding.agentLabel} 配置类型不兼容`)

  const expectedTools = [...catalog.runtimeToolIds, binding.submitToolId]
  if (!sameSet(definition.toolIds, expectedTools)) {
    throw new Error(`${binding.agentLabel} 工具白名单必须精确匹配当前 Agent`)
  }
  if (definition.mcpBindings.length) {
    throw new Error(`${binding.agentLabel} 不允许绑定 MCP`)
  }
  const skillBindings = definition.skillBindings.filter(skill => skill.enabled)
  const requiredSkillKeys = catalog.requiredSkillKeys
  if (
    skillBindings.length !== requiredSkillKeys.length
    || !requiredSkillKeys.every(skillKey => skillBindings.some(binding => binding.skillKey === skillKey))
  ) throw new Error(`${binding.agentLabel} Skill 白名单必须精确匹配当前 Agent`)

  for (const skillBinding of skillBindings) {
    const skill = state.aiResources.find(
      (item): item is SkillResource => item.kind === 'skill' && item.key === skillBinding.skillKey,
    )
    if (
      !skill
      || !skill.enabled
      || skill.version !== skillBinding.version
      || !matchesSkillConfigurationHash(skill, skillBinding.configurationHash)
    ) throw new Error(`${binding.agentLabel} Skill ${skillBinding.skillKey} 与发布快照不一致`)
  }

  const tools = state.aiResources.filter((item): item is ToolResource => item.kind === 'tool')
  for (const toolId of expectedTools) {
    const resource = tools.find(tool => tool.key === toolId)
    if (!resource || !resource.enabled || !defaultBuiltInToolConfigResolver.has(toolId)) {
      throw new Error(`${binding.agentLabel} 工具 ${toolId} 不可用`)
    }
  }
  const toolTokens = definition.toolIds.map(toolId => {
    const resource = tools.find(tool => tool.key === toolId)
    return resource
      ? toolBindingToken(resource)
      : builtInToolBindingToken(toolId)
  })
  if (toolsetContentHash(toolTokens) !== definition.toolsetContentSha256) {
    throw new Error(`${binding.agentLabel} Tool 配置与发布快照不一致`)
  }
  resolveModel(state, configuration)
}

function resolveModel(
  state: DatabaseState,
  configuration: AgentConfigurationVersion,
): AgentModelConnection {
  const reference = configuration.routing.primaryModel
  if (!reference) throw new Error('测试执行 Agent 未选择默认模型')
  const { source, model } = modelByReference(state, reference)
  if (
    !source.enabled
    || !model.enabled
    || model.health !== 'healthy'
    || model.qualityGate?.version !== 'model-probe/v2'
    || !model.qualityGate.passed
    || !model.capabilities.includes('tool_calling')
  ) throw new Error(`${source.name} / ${model.displayName} 未通过模型门禁`)
  return {
    sourceId: source.id,
    providerType: source.providerType,
    baseUrl: source.baseUrl,
    apiKey: source.apiKey,
    modelId: model.id,
    modelName: model.name,
    contextWindow: configuration.routing.contextWindow,
    maxOutputTokens: configuration.routing.maxOutputTokens,
    supportsReasoning: model.capabilities.includes('reasoning'),
    requestTimeoutMs: configuration.routing.requestTimeoutSeconds * 1_000,
    retryCount: configuration.routing.retryCount,
  }
}

function modelByReference(
  state: DatabaseState,
  reference: AgentModelReference,
): { source: GenerativeModelSource; model: GenerativeModel } {
  const source = state.modelSources.find(item => item.id === reference.sourceId)
  const model = source?.models.find(item => item.id === reference.modelId)
  if (!source || !model) throw new Error('测试执行 Agent 模型引用不存在')
  return { source, model }
}

function bindingByAgentKey(agentKey: FrozenExecutionAgentSnapshot['agentKey']): StageBinding {
  const binding = Object.values(TEST_EXECUTION_STAGE_BINDINGS).find(item => item.agentKey === agentKey)
  return required(binding, `TEST_EXECUTION_AGENT_BINDING_NOT_FOUND: ${agentKey}`)
}

function executionRecord(
  agentKey: StageBinding['agentKey'],
  workflowStage: TestExecutionAgentStage,
  events: AgentExecutionEvent[],
  turns?: number,
  toolCalls?: number,
  toolErrors?: number,
  framework: AgentExecutionOutput['framework'] = { name: 'pi-agent-core', version: piVersion },
  context?: AgentExecutionContext,
): TestExecutionAgentRuntimeOutput['execution'] {
  return {
    agentKey,
    workflowStage,
    turns: turns ?? Math.max(0, ...events.map(event => event.turn ?? 0)),
    toolCalls: toolCalls ?? events.filter(event => event.type === 'tool_execution_start').length,
    toolErrors: toolErrors ?? events.filter(event => event.type === 'tool_execution_end' && event.isError).length,
    events: structuredClone(events),
    framework,
    ...(context ? { context: structuredClone(context) } : {}),
  }
}

function sameSet(left: readonly string[], right: readonly string[]) {
  return left.length === right.length
    && new Set(left).size === left.length
    && left.every(item => right.includes(item))
}

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message)
  return value
}
