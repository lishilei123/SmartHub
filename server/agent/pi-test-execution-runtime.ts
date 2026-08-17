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

export const TEST_EXECUTION_STAGE_BINDINGS = {
  script_generation: {
    agentKey: 'test-script',
    snapshotKey: 'testScript',
    agentType: 'test_script',
    skillKey: 'test-script-generation',
    submitToolId: 'test_script.submit_result',
    schemaVersion: 'test-script-generation/v1',
    agentLabel: 'TestScriptAgent',
  },
  failure_diagnosis: {
    agentKey: 'failure-analysis',
    snapshotKey: 'failureAnalysis',
    agentType: 'failure_analysis',
    skillKey: 'failure-analysis',
    submitToolId: 'failure_analysis.submit_result',
    schemaVersion: 'failure-analysis/v1',
    agentLabel: 'FailureAnalysisAgent',
  },
  script_repair: {
    agentKey: 'script-repair',
    snapshotKey: 'scriptRepair',
    agentType: 'script_repair',
    skillKey: 'script-repair',
    submitToolId: 'script_repair.submit_result',
    schemaVersion: 'script-repair/v1',
    agentLabel: 'ScriptRepairAgent',
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
  'test-script',
  'failure-analysis',
  'script-repair',
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
      testScript: required(frozen.get('test-script'), 'TEST_SCRIPT_AGENT_SNAPSHOT_REQUIRED'),
      failureAnalysis: required(frozen.get('failure-analysis'), 'FAILURE_ANALYSIS_AGENT_SNAPSHOT_REQUIRED'),
      scriptRepair: required(frozen.get('script-repair'), 'SCRIPT_REPAIR_AGENT_SNAPSHOT_REQUIRED'),
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
      const output = await this.piRuntime.execute({
        snapshot,
        model,
        requirementInputPlan: inputPlan,
        executionProfile: {
          mode: 'workspace_tools',
          workflowStage: input.stage,
          allowedToolIds: [...agentCatalogEntryByDefinition(binding.agentKey).runtimeToolIds, binding.submitToolId],
          submitToolId: binding.submitToolId,
          schemaVersion: binding.schemaVersion,
          agentLabel: binding.agentLabel,
          initialTask: task,
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
  return canonicalJson({
    schemaVersion: 'test-execution-agent-task/v1',
    agent: binding.agentLabel,
    stage: input.stage,
    runId: input.run.id,
    projectVersionId: input.run.projectVersionId,
    task: {
      taskId: input.task.id,
      status: input.task.status,
      input: input.task.input,
      currentScriptRevisionId: input.task.currentScriptRevisionId,
      repairCount: input.task.repairCount,
    },
    environment: { signature: input.run.environment.signature },
    runner: {
      runnerVersion: input.run.runner.runnerVersion,
      playwrightVersion: input.run.runner.playwrightVersion,
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
    },
    stageContext: input.stageContext ?? {},
    stageContract: {
      allowedSkill: binding.skillKey,
      submitTool: binding.submitToolId,
      schemaVersion: binding.schemaVersion,
    },
    instructions: [
      'Workflow Stage 已由 TestExecutionService 固定，不能自行切换。',
      '只读取当前 run/task 的冻结工作区；不得解析 latest、current 或 active 业务输入。',
      '不得调用 Shell、SSH、数据库、任意网络、其他 Agent 或 Runner。',
      'Agent 文本不能作为系统命令直接执行。',
      '不得修改正式 TestCase、Expected Result、Verification Check、断言意义、测试目标或需求规则。',
      `完成后只能调用 ${binding.submitToolId} 提交结构化候选。`,
    ],
  })
}

function buildAgentSnapshot(
  input: TestExecutionAgentRuntimeInput,
  configuration: AgentConfigurationVersion,
  task: string,
): TestExecutionAgentSnapshot {
  return {
    ...structuredClone(input.workspace),
    agentDefinition: structuredClone(configuration.agentDefinition),
    taskSha256: canonicalSha256(task),
    createdAt: new Date().toISOString(),
  }
}

function validateStageInput(
  input: TestExecutionAgentRuntimeInput,
  binding: StageBinding,
  frozen: FrozenExecutionAgentSnapshot,
) {
  if (input.task.runId !== input.run.id || input.workspace.runId !== input.run.id) {
    throw new Error('TEST_EXECUTION_AGENT_RUN_SCOPE_MISMATCH')
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
  if (input.stage === 'failure_diagnosis') {
    if (
      !input.stageContext?.scriptRevisionId
      || !input.stageContext.attemptIds
      || input.stageContext.attemptIds.length < 2
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
    || definition.resultSchemaVersion !== binding.schemaVersion
  ) throw new Error(`${binding.agentLabel} 配置类型不兼容`)

  const expectedTools = [...catalog.runtimeToolIds, binding.submitToolId]
  if (!sameSet(definition.toolIds, expectedTools)) {
    throw new Error(`${binding.agentLabel} 工具白名单必须精确匹配当前 Agent`)
  }
  if (definition.mcpBindings.length) {
    throw new Error(`${binding.agentLabel} 不允许绑定 MCP`)
  }
  const skillBindings = definition.skillBindings
  if (
    skillBindings.length !== 1
    || !skillBindings[0].enabled
    || skillBindings[0].skillKey !== binding.skillKey
  ) throw new Error(`${binding.agentLabel} Skill 白名单必须精确匹配当前 Agent`)

  const skill = state.aiResources.find(
    (item): item is SkillResource => item.kind === 'skill' && item.key === binding.skillKey,
  )
  if (
    !skill
    || !skill.enabled
    || skill.version !== skillBindings[0].version
    || !matchesSkillConfigurationHash(skill, skillBindings[0].configurationHash)
  ) throw new Error(`${binding.agentLabel} Skill ${binding.skillKey} 与发布快照不一致`)

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
    || configuration.routing.structuredOutput
      && !model.capabilities.includes('structured_output')
  ) throw new Error(`${source.name} / ${model.displayName} 未通过模型门禁`)
  return {
    sourceId: source.id,
    providerType: source.providerType,
    baseUrl: source.baseUrl,
    apiKey: source.apiKey,
    modelId: model.id,
    modelName: model.name,
    contextWindow: Math.min(configuration.routing.contextWindow, model.contextWindow),
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
