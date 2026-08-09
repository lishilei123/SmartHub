import type { AgentConfigurationService } from '../application/agent-configuration-service.js'
import { canonicalJson, canonicalSha256 } from '../application/canonical-json.js'
import type { TestDesignAgentRuntime } from '../application/test-design-service.js'
import type { AgentDefinitionVersion, AgentModelConnection, TestDesignAgentSnapshot } from '../domain/agent-types.js'
import type { TestDesign } from '../domain/test-design-types.js'
import type { AgentConfigurationVersion, AgentModelReference, DatabaseState, GenerativeModel, GenerativeModelSource, ToolResource } from '../domain/types.js'
import type { StateStore } from '../infrastructure/store.js'
import { piVersion, type PiAgentRuntimeAdapter } from './pi-agent-runtime.js'

const stageKeys = {
  test_analysis: 'test-analysis',
  functional_design: 'functional-test-design',
  non_functional_design: 'non-functional-test-design',
  test_case_synthesis: 'test-case-synthesis',
} as const

const submissionTools: Record<(typeof stageKeys)[keyof typeof stageKeys], string> = {
  'test-analysis': 'test_analysis.submit_result',
  'functional-test-design': 'functional_test_design.submit_result',
  'non-functional-test-design': 'non_functional_test_design.submit_result',
  'test-case-synthesis': 'test_case_synthesis.submit_result',
}

export class PiTestDesignRuntimeAdapter implements TestDesignAgentRuntime {
  constructor(private readonly store: StateStore, private readonly piRuntime: PiAgentRuntimeAdapter, private readonly configurations: AgentConfigurationService) {}

  async readiness() {
    const agents = await Promise.all(Object.values(stageKeys).map(async agentKey => {
      const configuration = await this.configurations.resolveActive(agentKey)
      if (!configuration) return { agentKey, ready: false, reason: '未发布 Agent 配置' }
      try { validateConfiguration(configuration, await this.store.snapshot()); return { agentKey, ready: true } }
      catch (error) { return { agentKey, ready: false, reason: error instanceof Error ? error.message : String(error) } }
    }))
    return { ready: agents.every(item => item.ready), agents }
  }

  async execute(input: Parameters<TestDesignAgentRuntime['execute']>[0], signal: AbortSignal) {
    const agentKey = stageKeys[input.stage]
    const configuration = await this.configurations.resolveActive(agentKey)
    if (!configuration) throw new Error(`TEST_DESIGN_AGENT_NOT_READY: ${agentKey} 未发布`)
    const state = await this.store.snapshot()
    validateConfiguration(configuration, state)
    const model = resolveModel(state, configuration)
    const design = state.testDesignState?.designs.find(item => item.id === input.run.testDesignId && item.projectVersionId === input.run.projectVersionId)
    if (!design) throw new Error('TEST_DESIGN_INPUT_NOT_FOUND: 测试设计定义不存在')
    const task = buildTestDesignAgentTask(input, design)
    const snapshot: TestDesignAgentSnapshot = { runId: input.run.id, projectVersionId: input.run.projectVersionId, agentDefinition: structuredClone(configuration.agentDefinition), taskSha256: canonicalSha256(task), createdAt: new Date().toISOString() }
    const events: import('../domain/agent-types.js').AgentExecutionEvent[] = []
    try {
      const output = await this.piRuntime.execute({ snapshot, model, testDesignTask: task, onEvent: event => { events.push(event) } }, signal)
      if (!output.candidate || typeof output.candidate !== 'object' || Array.isArray(output.candidate)) throw new Error('TEST_DESIGN_AGENT_RESULT_INVALID: Agent 未提交对象候选')
      return {
        schemaVersion: configuration.agentDefinition.resultSchemaVersion,
        content: structuredClone(output.candidate as Record<string, unknown>),
        execution: executionRecord(agentKey, configuration.agentDefinition.version, model.modelName, output.events, output.turns, output.toolCalls, output.toolErrors, output.framework),
      }
    } catch (error) {
      const failure = new Error(error instanceof Error ? error.message : String(error), { cause: error }) as Error & { execution?: ReturnType<typeof executionRecord> }
      failure.execution = executionRecord(agentKey, configuration.agentDefinition.version, model.modelName, events)
      throw failure
    }
  }
}

export function buildTestDesignAgentTask(input: Parameters<TestDesignAgentRuntime['execute']>[0], design: TestDesign) {
  return canonicalJson({
    schemaVersion: 'test-design-agent-input/v1',
    stage: input.stage,
    runId: input.run.id,
    projectVersionId: input.run.projectVersionId,
    designContext: {
      name: design.name,
      objective: design.objective,
      basisMode: design.basisMode,
      includedScopes: design.input.includedScopes ?? [],
      excludedScopes: design.input.excludedScopes ?? [],
      focusDimensions: design.input.focusDimensions ?? [],
      userCoverageObjectives: design.input.userCoverageObjectives ?? [],
    },
    generationPolicy: generationPolicy(input.stage),
    basisSnapshot: input.run.basisSnapshot,
    retrievalSnapshot: input.run.retrievalSnapshot,
    historicalSnapshot: input.run.historicalSnapshot,
    upstream: input.upstream,
  })
}

function generationPolicy(stage: Parameters<TestDesignAgentRuntime['execute']>[0]['stage']) {
  const common = [
    '完整性按独立可验证行为决定，不使用固定数量配额，也不得为了增加数量制造同义重复。',
    '不同角色、前置状态、输入等价类或边界、业务分支、失败原因、最终状态或可观察结果，原则上拆为独立测试点或用例。',
    '先建立覆盖矩阵并逐项检查固定依据，再提交完整结果；不得只覆盖主成功路径。',
  ]
  const stageRules = stage === 'test_analysis'
    ? [
        '把每个覆盖目标拆成原子 coverage unit，显式列出角色、规则、状态、输入约束、接口、正向/反向/边界分区和 oracle。',
        '同一依据中的独立动作、分支、权限、异常、状态转换和数据约束不得压缩成一条概述。',
      ]
    : stage === 'functional_design'
    ? [
        '对每个 coverage unit 组合适用的角色、状态、输入分区、边界、分支结果和入口，生成最小可验证功能测试点。',
        '逐项考虑正常、替代、中断恢复、空值/格式/长度/组合边界、非法状态、重复/幂等/并发、权限/数据隔离、接口错误与数据一致性。',
      ]
    : stage === 'non_functional_design'
    ? [
        '性能、稳定性、兼容性、安全四个分区必须逐一给出适用性，并对适用分区按负载/故障/矩阵/威胁与可观察结果拆分测试点。',
        '固定依据没有阈值或支持矩阵时标记 blocked_by_confirmation 并说明待确认项，不得用一条泛化测试点代替完整分区。',
      ]
    : [
        '每个已批准且适用的测试点都必须被至少一条候选用例引用；提交前对 nodeId 做全集核对。',
        '当角色、前置状态、数据分区/边界、触发动作、预期结果或清理方式任一不同，拆成独立用例；不要用一条用例批量引用整棵子树来制造覆盖。',
        '同一业务目标只有在前置、数据和最终判定一致时才合并 UI/API 执行方式；目标或生命周期不同则拆分用例。',
      ]
  return { version: 'test-design-generation-policy/v2', common, stageRules }
}

function executionRecord(agentKey: (typeof stageKeys)[keyof typeof stageKeys], agentVersion: string, modelLabel: string, events: import('../domain/agent-types.js').AgentExecutionEvent[], turns?: number, toolCalls?: number, toolErrors?: number, framework = { name: 'pi-agent-core' as const, version: piVersion }) {
  return {
    agentKey,
    agentVersion,
    modelLabel,
    degraded: false,
    turns: turns ?? Math.max(0, ...events.map(event => event.turn ?? 0)),
    toolCalls: toolCalls ?? events.filter(event => event.type === 'tool_execution_start').length,
    toolErrors: toolErrors ?? events.filter(event => event.type === 'tool_execution_end' && event.isError).length,
    events: structuredClone(events),
    framework,
  }
}

function validateConfiguration(configuration: AgentConfigurationVersion, state: DatabaseState) {
  const definition = configuration.agentDefinition
  const requiredTool = submissionTools[definition.agentKey as keyof typeof submissionTools]
  if (!requiredTool || definition.modelScene !== 'test_design' || definition.toolIds.length !== 1 || definition.toolIds[0] !== requiredTool) throw new Error('测试设计 Agent 只允许绑定对应结果提交工具')
  if (definition.skillBindings.some(item => item.enabled) || definition.mcpBindings.some(item => item.enabled)) throw new Error('测试设计 Agent 不允许绑定 Skill 或 MCP')
  const tool = state.aiResources.find((item): item is ToolResource => item.kind === 'tool' && item.key === requiredTool && item.enabled)
  if (!tool || tool.risk !== 'internal_write') throw new Error(`结果提交工具 ${requiredTool} 不可用`)
  resolveModel(state, configuration)
}

function resolveModel(state: DatabaseState, configuration: AgentConfigurationVersion): AgentModelConnection {
  const reference = configuration.routing.primaryModel
  if (!reference) throw new Error('测试设计 Agent 未选择默认模型')
  const { source, model } = modelByReference(state, reference)
  if (!source.enabled || !model.enabled || model.health !== 'healthy' || !model.qualityGate?.passed || !model.capabilities.includes('tool_calling')) throw new Error(`${source.name} / ${model.displayName} 未通过模型门禁`)
  return { sourceId: source.id, providerType: source.providerType, baseUrl: source.baseUrl, apiKey: source.apiKey, modelId: model.id, modelName: model.name, contextWindow: model.contextWindow, maxOutputTokens: Math.min(model.maxOutputTokens, configuration.routing.maxOutputTokens), supportsReasoning: model.capabilities.includes('reasoning'), temperature: configuration.routing.temperature, requestTimeoutMs: configuration.routing.requestTimeoutSeconds * 1_000, retryCount: configuration.routing.retryCount }
}

function modelByReference(state: DatabaseState, reference: AgentModelReference): { source: GenerativeModelSource; model: GenerativeModel } {
  const source = state.modelSources.find(item => item.id === reference.sourceId)
  const model = source?.models.find(item => item.id === reference.modelId)
  if (!source || !model) throw new Error('测试设计 Agent 模型引用不存在')
  return { source, model }
}
