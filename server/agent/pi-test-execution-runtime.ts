import { createHash } from 'node:crypto'
import type { AgentConfigurationService } from '../application/agent-configuration-service.js'
import {
  builtInToolBindingToken,
  matchesSkillConfigurationHash,
  toolBindingToken,
  toolsetContentHash,
} from '../application/ai-resource-hash.js'
import { canonicalJson, canonicalSha256 } from '../application/canonical-json.js'
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
    file => file.logicalPath === 'exploration/context.json',
  )
  return canonicalJson({
    schemaVersion: 'test-execution-agent-task/v2',
    agent: binding.agentLabel,
    assignment: stageAssignment(input.stage),
    testCase: input.task.input.caseContent,
    execution: {
      method: input.task.input.method,
      dimension: input.task.input.dimension,
      specification: input.task.input.executionSpec,
      ...(input.task.input.testDataBindings?.length
        ? { testDataBindings: input.task.input.testDataBindings }
        : {}),
    },
    workspace: {
      root: `/${workspace.rootLogicalPath ?? workspace.logicalPath}`,
      activeBranch: workspace.activeBranchLogicalPath
        ? `/${workspace.activeBranchLogicalPath}`
        : undefined,
      agentDirectory: workspace.agentLogicalPath
        ? `/${workspace.agentLogicalPath}`
        : undefined,
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
    instructions: stageInstructions(input.stage, input.task.input.caseId, binding.submitToolId),
  })
}

function stageAssignment(stage: TestExecutionAgentStage) {
  if (stage === 'script_generation') return '根据冻结 TestCase 和 Execution Workspace 实现 Playwright 自动化代码'
  if (stage === 'failure_diagnosis') return '根据当前失败 Attempt 和 Runner Evidence 客观判断失败类型'
  return '根据已确认的 FailureDiagnosis 修复 Playwright 实现'
}

function stageInstructions(stage: TestExecutionAgentStage, caseId: string, submitToolId: string) {
  const common = [
    '只使用冻结 TestCase、只读 Workspace 与当前 Runtime 明确授权的上下文；不得编造 API、Selector、凭据、业务规则或预期结果。',
    '不得修改 TestCase、Expected Result、Verification Check、受保护断言语义或测试目标。',
    '不得调用 Shell、数据库、任意网络、其他 Agent 或 Runner；Service 和 Runner 负责流程与真实执行。',
  ]
  if (stage === 'failure_diagnosis') return [
    ...common,
    '只根据当前失败 Attempt、Execution Event 与 Artifact 证据分类；不得修改脚本或决定是否修复。',
    `完成后只调用 ${submitToolId} 提交 category、reason、evidence。`,
  ]
  const implementation = [
    ...common,
    '实现阶段可使用只读 Workspace、Knowledge、已有 Runtime Observation 与当前 invocation 明确授权的 Browser Tools。',
    `Playwright Test 标题必须以稳定 Case Symbol ${JSON.stringify(`[${caseId}]`)} 结尾。`,
    '优先复用 execution/ 下已有 tests、pages、api、helpers 和 fixtures；API 使用 request/APIRequestContext，UI 必须完成真实 UI 操作与页面断言。',
    '先复用 Workspace 和已有 Observation；只有实现所需信息不足时才按需、多轮调用 Browser Tools。Browser Observation 是运行时观察事实，不是 Requirement Truth。',
    'Browser Tools 只用于受控探索，不是 Runner；不得把工具观察解释为 PASS/FAIL，也不得据此改变 Expected Result 或弱化断言。',
    '只提交需要新增或修改的 Workspace 文件；summary 仅用于简短说明。',
  ]
  if (stage === 'script_repair') implementation.push(
    '当前 Stage 只根据已确认的 FailureDiagnosis、当前 ScriptRevision、Runner Evidence 和 Execution Workspace 修复实现问题；不得重新进行需求分析、测试设计或通过 Knowledge 搜索扩大修复范围。',
    '只修改诊断支持的实现问题；不得删除、绕过或弱化受保护断言和业务闭环。',
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
    if (!input.stageContext?.parentScriptRevisionId || !input.stageContext.diagnosisId) {
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
  const {
    contentSha256: definitionSha256,
    ...definitionBase
  } = configuration.agentDefinition
  if (sha256(JSON.stringify(definitionBase)) !== definitionSha256) {
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
