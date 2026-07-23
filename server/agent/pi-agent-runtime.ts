import { createRequire } from 'node:module'
import { Agent, type AgentEvent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
import { streamSimple as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages'
import { streamSimple as streamOpenAi } from '@earendil-works/pi-ai/api/openai-completions'
import type { AgentExecutionEvent, AgentExecutionInput, AgentExecutionOutput, AgentRuntime } from '../domain/agent-types.js'
import type { CandidateReviewResult } from '../domain/review-types.js'
import type { ToolDescriptor } from '../domain/tool-types.js'
import type { StateStore } from '../infrastructure/store.js'
import { GovernedToolRuntime } from '../tools/runtime.js'
import { createRequirementToolRegistry } from '../tools/requirement-tools.js'
import { renderRequirementTask } from './requirement-analysis-agent.js'

const require = createRequire(import.meta.url)
const piVersion = (require('@earendil-works/pi-agent-core/package.json') as { version: string }).version

export interface PiRuntimeBindings {
  model?: Model<Api>
  streamFn?: StreamFn
}

export class PiAgentRuntimeAdapter implements AgentRuntime {
  constructor(private readonly store: StateStore, private readonly bindings: PiRuntimeBindings = {}) {}

  async execute(input: AgentExecutionInput, signal: AbortSignal): Promise<AgentExecutionOutput> {
    let candidate: CandidateReviewResult | undefined
    const registry = createRequirementToolRegistry(this.store, value => { candidate = value })
    const limits = input.snapshot.agentDefinition.limits
    const toolRuntime = new GovernedToolRuntime(registry, limits)
    const allowedToolIds = new Set(input.snapshot.agentDefinition.toolIds)
    const descriptors = registry.descriptors(allowedToolIds)
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
    const streamFn = this.bindings.streamFn ?? createStreamFn(input)
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
        if (event.type === 'turn_start') {
          turns += 1
          if (turns > limits.maxTurns) agent?.abort()
        }
        await record(toAuditEvent(event, turns))
        if (eventSignal.aborted || controller.signal.aborted) agent?.abort()
      })
      controller.signal.addEventListener('abort', () => agent?.abort(), { once: true })
      await agent.prompt(renderRequirementTask(input.snapshot))
      await agent.waitForIdle()
      if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('AGENT_CANCELLED')
      if (turns > limits.maxTurns) throw new Error('AGENT_TURN_LIMIT_EXCEEDED')
      if (!candidate) throw new Error('AGENT_RESULT_NOT_SUBMITTED')
      if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > limits.maxCandidateBytes) throw new Error('AGENT_RESULT_TOO_LARGE')
      return { candidate, events, turns, toolCalls: toolRuntime.callCount, framework: { name: 'pi-agent-core', version: piVersion } }
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

function toAuditEvent(event: AgentEvent, turn: number): Omit<AgentExecutionEvent, 'sequence' | 'occurredAt'> {
  if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end' || event.type === 'tool_execution_update') return { type: event.type, turn, toolCallId: event.toolCallId, toolId: event.toolName, ...('isError' in event ? { isError: event.isError } : {}) }
  return { type: event.type, turn }
}
