import { createRequire } from 'node:module'
import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
import { streamSimple as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages'
import { streamSimple as streamOpenAi } from '@earendil-works/pi-ai/api/openai-completions'
import type { AgentExecutionEvent, AgentExecutionInput, AgentExecutionOutput, AgentRuntime } from '../domain/agent-types.js'
import type { CandidateReviewResult } from '../domain/review-types.js'
import type { ToolDescriptor } from '../domain/tool-types.js'
import type { StateStore } from '../infrastructure/store.js'
import { GovernedToolRuntime } from '../tools/runtime.js'
import { createRequirementToolRegistry } from '../tools/requirement-tools.js'
import type { ReviewSubmissionFeedback } from '../tools/requirement-tools.js'
import type { ToolRegistry } from '../tools/registry.js'
import { ReviewResultValidator } from './result-validator.js'
import { renderRequirementTask } from './requirement-analysis-agent.js'

const require = createRequire(import.meta.url)
const piVersion = (require('@earendil-works/pi-agent-core/package.json') as { version: string }).version
const RESULT_SUBMISSION_TURN_RESERVE = 3

export interface PiRuntimeBindings {
  model?: Model<Api>
  streamFn?: StreamFn
}

export type RequirementToolRegistryFactory = (store: StateStore, submit: (candidate: CandidateReviewResult) => ReviewSubmissionFeedback | Promise<ReviewSubmissionFeedback>) => ToolRegistry

export class PiAgentRuntimeAdapter implements AgentRuntime {
  constructor(private readonly store: StateStore, private readonly bindings: PiRuntimeBindings = {}, private readonly toolRegistryFactory: RequirementToolRegistryFactory = createRequirementToolRegistry) {}

  async execute(input: AgentExecutionInput, signal: AbortSignal): Promise<AgentExecutionOutput> {
    let candidate: CandidateReviewResult | undefined
    let lastSubmissionIssues: Array<{ path: string; message: string }> = []
    const validator = new ReviewResultValidator(this.store)
    const registry = this.toolRegistryFactory(this.store, async value => {
      const validation = await validator.validate(value, input.snapshot)
      if (!validation.valid) {
        lastSubmissionIssues = validation.issues
        return { accepted: false, issues: validation.issues }
      }
      candidate = value
      lastSubmissionIssues = []
      return { accepted: true }
    })
    const limits = input.snapshot.agentDefinition.limits
    const toolRuntime = new GovernedToolRuntime(registry, limits)
    const allowedToolIds = new Set(input.snapshot.agentDefinition.toolIds)
    const descriptors = registry.descriptors(allowedToolIds)
    const registeredToolIds = new Set(descriptors.map(descriptor => descriptor.id))
    const unavailableToolIds = input.snapshot.agentDefinition.toolIds.filter(toolId => !registeredToolIds.has(toolId))
    if (unavailableToolIds.length) throw new Error(`AGENT_TOOLS_UNAVAILABLE: ${unavailableToolIds.join(', ')}`)
    const byPiName = new Map(descriptors.map(descriptor => [descriptor.piName, descriptor]))
    const events: AgentExecutionEvent[] = []
    let sequence = 0
    let turns = 0
    const record = async (event: Omit<AgentExecutionEvent, 'sequence' | 'occurredAt'>) => {
      const value = { sequence: ++sequence, occurredAt: new Date().toISOString(), ...event }
      events.push(value)
      await input.onEvent?.(value)
    }
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(new Error('AGENT_DEADLINE_EXCEEDED')), limits.deadlineMs)
    const abort = () => controller.abort(signal.reason ?? new Error('AGENT_CANCELLED'))
    signal.addEventListener('abort', abort, { once: true })

    const model = this.bindings.model ?? createModel(input)
    const providerStreamFn = this.bindings.streamFn ?? createStreamFn(input)
    let forceResultSubmission = false
    const resultSubmissionTurn = Math.max(1, limits.maxTurns - RESULT_SUBMISSION_TURN_RESERVE + 1)
    const streamFn: StreamFn = (streamModel, context, options) => providerStreamFn(streamModel, context, forceResultSubmission ? {
      ...options,
      toolChoice: input.model.providerType === 'anthropic'
        ? { type: 'tool', name: 'review_submit_result' }
        : { type: 'function', function: { name: 'review_submit_result' } },
    } as Parameters<StreamFn>[2] : options)
    let agent: Agent | undefined
    try {
      const tools = descriptors.map(descriptor => this.piTool(descriptor, toolRuntime, input, controller.signal))
      agent = new Agent({
        initialState: { systemPrompt: input.snapshot.agentDefinition.systemPrompt, model, tools, thinkingLevel: 'off' },
        streamFn,
        getApiKey: () => input.model.apiKey,
        sessionId: input.snapshot.runId,
        toolExecution: 'sequential',
        beforeToolCall: async ({ toolCall }) => byPiName.has(toolCall.name) ? undefined : { block: true, reason: 'TOOL_NOT_ALLOWED' },
      })
      agent.subscribe(async (event, eventSignal) => {
        let resultSubmissionRequired = false
        if (event.type === 'turn_start') {
          turns += 1
          if (turns > limits.maxTurns) agent?.abort()
          else if (turns >= resultSubmissionTurn && !forceResultSubmission) {
            forceResultSubmission = true
            resultSubmissionRequired = true
          }
        }
        if (!isTransientAgentEvent(event)) await record(toAuditEvent(event, turns, input.model.baseUrl, input.model.apiKey))
        if (resultSubmissionRequired) await record({ type: 'result_submission_required', turn: turns })
        if (eventSignal.aborted || controller.signal.aborted) agent?.abort()
      })
      controller.signal.addEventListener('abort', () => agent?.abort(), { once: true })
      await record({ type: 'runtime_initialized', turn: 0, framework: { name: 'pi-agent-core', version: piVersion } })
      await agent.prompt(renderRequirementTask(input.snapshot))
      await agent.waitForIdle()
      if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('AGENT_CANCELLED')
      if (turns > limits.maxTurns) {
        if (lastSubmissionIssues.length) throw resultValidationError(lastSubmissionIssues)
        throw new Error('AGENT_TURN_LIMIT_EXCEEDED')
      }
      if (!candidate) {
        await record({ type: 'result_submission_retry', turn: turns })
        forceResultSubmission = true
        await agent.prompt('现在进入结果提交阶段。不得继续返回普通文本或调用其他工具；请立即通过 review_submit_result 提交完整的 review-result/v2。若参数校验失败，请按工具错误修正参数后再次提交。')
        await agent.waitForIdle()
      }
      if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('AGENT_CANCELLED')
      if (turns > limits.maxTurns) {
        if (lastSubmissionIssues.length) throw resultValidationError(lastSubmissionIssues)
        throw new Error('AGENT_TURN_LIMIT_EXCEEDED')
      }
      if (!candidate && lastSubmissionIssues.length) throw resultValidationError(lastSubmissionIssues)
      if (!candidate) throw new Error('MODEL_TOOL_CALL_REQUIRED: 模型未调用 review_submit_result，实际工具调用能力不满足需求评审 Agent；请在模型管理中重新探测并选择通过工具调用检测的模型')
      if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > limits.maxCandidateBytes) throw new Error('AGENT_RESULT_TOO_LARGE')
      return {
        candidate,
        events,
        turns,
        toolCalls: events.filter(event => event.type === 'tool_execution_start').length,
        toolErrors: events.filter(event => event.type === 'tool_execution_end' && event.isError).length,
        framework: { name: 'pi-agent-core', version: piVersion },
      }
    } finally {
      clearTimeout(deadline)
      signal.removeEventListener('abort', abort)
      if (agent?.state.isStreaming) agent.abort()
    }
  }

  private piTool(descriptor: ToolDescriptor, runtime: GovernedToolRuntime, input: AgentExecutionInput, signal: AbortSignal): AgentTool {
    return {
      name: descriptor.piName,
      label: descriptor.label,
      description: `${descriptor.description} 业务工具 ID：${descriptor.id}；版本：${descriptor.version}。`,
      parameters: descriptor.parameters,
      executionMode: 'sequential',
      execute: async (toolCallId, args, toolSignal) => {
        const result = await runtime.execute({ toolId: descriptor.id, toolCallId, arguments: args, context: { snapshot: input.snapshot, allowedToolIds: new Set(input.snapshot.agentDefinition.toolIds) } }, AbortSignal.any([signal, toolSignal ?? signal]))
        return { content: [{ type: 'text', text: JSON.stringify(result.data) }], details: { toolId: descriptor.id, version: descriptor.version, data: result.data }, terminate: result.terminate }
      },
    }
  }
}

function resultValidationError(issues: Array<{ path: string; message: string }>) {
  return new Error(`AGENT_RESULT_VALIDATION_FAILED: ${issues.map(issue => `${issue.path} ${issue.message}`).join('；')}`)
}

function createModel(input: AgentExecutionInput): Model<Api> {
  const api: Api = input.model.providerType === 'anthropic' ? 'anthropic-messages' : 'openai-completions'
  return {
    id: input.model.modelName,
    name: input.model.modelName,
    api,
    provider: input.model.sourceId,
    baseUrl: normalizeBaseUrl(input.model.baseUrl, api),
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: input.model.contextWindow,
    maxTokens: input.model.maxOutputTokens,
  } as Model<Api>
}

function createStreamFn(input: AgentExecutionInput): StreamFn {
  return (input.model.providerType === 'anthropic' ? streamAnthropic : streamOpenAi) as StreamFn
}

function normalizeBaseUrl(value: string, api: Api) {
  const withoutSlash = value.replace(/\/$/u, '')
  return api === 'anthropic-messages' ? withoutSlash.replace(/\/messages$/iu, '') : withoutSlash.replace(/\/chat\/completions$/iu, '')
}

function isTransientAgentEvent(event: AgentEvent) { return event.type === 'message_update' || event.type === 'tool_execution_update' }

function toAuditEvent(event: AgentEvent, turn: number, endpoint: string, credential: string): Omit<AgentExecutionEvent, 'sequence' | 'occurredAt'> {
  if (event.type === 'tool_execution_start') return { type: event.type, turn, toolCallId: event.toolCallId, toolId: event.toolName, toolArguments: traceValue(event.args, endpoint, credential) }
  if (event.type === 'tool_execution_end') return { type: event.type, turn, toolCallId: event.toolCallId, toolId: event.toolName, isError: event.isError, toolResult: toolResultTrace(event.result, endpoint, credential) }
  if (event.type === 'message_start') return { type: event.type, turn, ...messageTrace(event.message, false, endpoint, credential) }
  if (event.type === 'message_end') return { type: event.type, turn, ...messageTrace(event.message, true, endpoint, credential) }
  if (event.type === 'turn_end') return { type: event.type, turn, ...messageTrace(event.message, false, endpoint, credential) }
  return { type: event.type, turn }
}

function messageTrace(message: AgentMessage, includeContent: boolean, endpoint: string, credential: string): Partial<AgentExecutionEvent> {
  const value = message as {
    role?: string
    content?: unknown
    toolCallId?: string
    toolName?: string
    isError?: boolean
    stopReason?: string
    errorMessage?: string
    model?: string
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number }
  }
  if (value.role === 'user') return { role: 'user', ...(includeContent ? { content: redactTraceText(textFromContent(value.content), endpoint, credential) } : {}) }
  if (value.role === 'toolResult') return {
    role: 'tool', toolCallId: value.toolCallId, toolId: value.toolName, isError: value.isError,
  }
  if (value.role !== 'assistant') return {}
  const blocks = Array.isArray(value.content) ? value.content : []
  const toolCalls = blocks.flatMap(block => {
    if (!block || typeof block !== 'object' || (block as { type?: string }).type !== 'toolCall') return []
    const toolCall = block as { id?: string; name?: string }
    return [{ id: String(toolCall.id ?? ''), name: String(toolCall.name ?? '') }]
  })
  const usage = value.usage ? {
    input: Number(value.usage.input ?? 0), output: Number(value.usage.output ?? 0), cacheRead: Number(value.usage.cacheRead ?? 0),
    cacheWrite: Number(value.usage.cacheWrite ?? 0), totalTokens: Number(value.usage.totalTokens ?? 0),
  } : undefined
  return {
    role: 'assistant', stopReason: value.stopReason, model: value.model, usage,
    ...(includeContent ? { content: redactTraceText(textFromContent(value.content) || value.errorMessage || '', endpoint, credential), ...(toolCalls.length ? { toolCalls } : {}) } : {}),
  }
}

function textFromContent(content: unknown) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => {
    if (!block || typeof block !== 'object') return []
    if ((block as { type?: string }).type === 'text') return [String((block as { text?: unknown }).text ?? '')]
    if ((block as { type?: string }).type === 'image') return ['[图片内容未写入运行记录]']
    return []
  }).filter(Boolean).join('\n')
}

function toolResultTrace(result: unknown, endpoint: string, credential: string) {
  if (result && typeof result === 'object') {
    const value = result as { details?: unknown; terminate?: unknown }
    if (value.details && typeof value.details === 'object' && 'data' in value.details) {
      return traceValue({ details: value.details, ...(value.terminate === undefined ? {} : { terminate: value.terminate }) }, endpoint, credential)
    }
  }
  return traceValue(result, endpoint, credential)
}

function traceValue(value: unknown, endpoint: string, credential: string): unknown {
  try {
    const serialized = JSON.stringify(value, function (key, item) {
      if (/^(?:api[_-]?key|authorization|credential|password|secret|access[_-]?token|refresh[_-]?token)$/iu.test(key)) return '[已隐藏凭据]'
      if (/signature$/iu.test(key)) return undefined
      if (key === 'data' && this && typeof this === 'object' && (this as { type?: string }).type === 'image') return '[图片二进制未写入运行记录]'
      return typeof item === 'string' ? redactTraceText(item, endpoint, credential) : item
    })
    return serialized === undefined ? undefined : JSON.parse(serialized) as unknown
  } catch {
    return '[内容无法安全序列化]'
  }
}

function redactTraceText(value: string, endpoint: string, credential: string) {
  let result = value
  if (credential) result = result.replaceAll(credential, '[已隐藏凭据]')
  if (endpoint) result = result.replaceAll(endpoint, '[模型端点]')
  return result.replace(/\bbearer\s+[^\s,;"']+/giu, 'Bearer [已隐藏凭据]')
}
