import { Agent, type AgentEvent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
import { streamSimple as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages'
import { streamSimple as streamOpenAi } from '@earendil-works/pi-ai/api/openai-completions'
import type { AgentDefinitionVersion, AgentExecutionEvent } from '../domain/agent-types.js'
import type { ReviewAnswerCandidate, ReviewQaExecutionInput, ReviewQaRuntime } from '../domain/review-qa-types.js'
import type { ToolDescriptor } from '../domain/tool-types.js'
import type { SkillPackageStore } from '../infrastructure/skill-package-store.js'
import type { StateStore } from '../infrastructure/store.js'
import { AgentCapabilityLoader, type CapabilityLoadResult } from '../tools/capability-loader.js'
import { ToolRegistry } from '../tools/registry.js'
import { registerReviewAnswerSubmitTool } from '../tools/review-answer-submit.js'
import { GovernedToolRuntime } from '../tools/runtime.js'
import { AgentSkillRuntime } from './skill-runtime.js'
import { createReviewQaAgentDefinition } from './requirement-analysis-agent.js'
import { isTransientAgentEvent, piVersion, toAuditEvent } from './pi-agent-runtime.js'

const RESULT_SUBMISSION_TOOL_RESERVE = 3

export interface PiReviewQaBindings { model?: Model<Api>; streamFn?: StreamFn }

export class PiReviewQaRuntimeAdapter implements ReviewQaRuntime {
  constructor(
    private readonly bindings: PiReviewQaBindings = {},
    private readonly store?: StateStore,
    private readonly skillPackages?: SkillPackageStore,
  ) {}

  async answer(input: ReviewQaExecutionInput, signal: AbortSignal) {
    let candidate: ReviewAnswerCandidate | undefined
    const definition = input.agentDefinition ?? createReviewQaAgentDefinition()
    const registry = new ToolRegistry()
    registerReviewAnswerSubmitTool(registry, value => {
      const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
      if (bytes > definition.limits.maxCandidateBytes) throw new Error('REVIEW_QA_RESULT_TOO_LARGE')
      candidate = structuredClone(value)
    })
    const skillPrompt = this.store ? await new AgentSkillRuntime(this.store, this.skillPackages).render(definition) : ''
    const capabilityLoad = this.store
      ? await new AgentCapabilityLoader(this.store, this.skillPackages).load(definition, registry, signal)
      : emptyCapabilityLoad()
    const allowedToolIds = new Set(definition.toolIds)
    const descriptors = registry.descriptors(allowedToolIds)
    if (!descriptors.some(item => item.id === 'review.answer_submit')) throw new Error('REVIEW_QA_SUBMIT_TOOL_UNAVAILABLE')
    const registeredToolIds = new Set(descriptors.map(item => item.id))
    const unavailableToolIds = definition.toolIds.filter(toolId => !registeredToolIds.has(toolId))
    const events: AgentExecutionEvent[] = []
    let sequence = 0
    let turns = 0
    const record = async (event: Omit<AgentExecutionEvent, 'sequence' | 'occurredAt'>) => {
      const value = { sequence: ++sequence, occurredAt: new Date().toISOString(), ...event }
      events.push(value)
      await input.onEvent?.(value)
    }
    for (const warning of capabilityLoad.warnings) await record({ type: 'capability_binding_unavailable', content: warning })
    if (unavailableToolIds.length) await record({ type: 'tool_bindings_unavailable', content: `以下目录绑定尚未注册到当前问答 Agent 运行时，因此不会暴露给模型：${unavailableToolIds.join('、')}` })
    if (skillPrompt) await record({ type: 'skill_bindings_loaded', content: `${definition.skillBindings.filter(binding => binding.enabled).length} 个 Skill 已按发布快照加载。` })
    const toolRuntime = new GovernedToolRuntime(registry, definition.limits, {
      toolIds: new Set(['review.answer_submit']),
      calls: Math.min(RESULT_SUBMISSION_TOOL_RESERVE, definition.limits.maxToolCalls),
    })
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(new Error('REVIEW_QA_DEADLINE_EXCEEDED')), definition.limits.deadlineMs)
    const abort = () => controller.abort(signal.reason ?? new Error('REVIEW_QA_CANCELLED'))
    signal.addEventListener('abort', abort, { once: true })
    const model = this.bindings.model ?? createModel(input)
    const providerStream = this.bindings.streamFn ?? createStreamFn(input)
    let forceSubmit = false
    const streamFn: StreamFn = (streamModel, context, options) => {
      const requestSignal = input.model.requestTimeoutMs
        ? AbortSignal.any([options?.signal ?? controller.signal, AbortSignal.timeout(input.model.requestTimeoutMs)])
        : options?.signal
      const configured = {
        ...options,
        ...(input.model.temperature == null ? {} : { temperature: input.model.temperature }),
        maxTokens: input.model.maxOutputTokens,
        ...(requestSignal ? { signal: requestSignal } : {}),
      }
      return providerStream(streamModel, context, forceSubmit ? {
        ...configured,
        toolChoice: input.model.providerType === 'anthropic'
          ? { type: 'tool', name: 'review_answer_submit' }
          : { type: 'function', function: { name: 'review_answer_submit' } },
      } as Parameters<StreamFn>[2] : configured)
    }
    const byPiName = new Set(descriptors.map(item => item.piName))
    const agent = new Agent({
      initialState: {
        systemPrompt: [definition.systemPrompt, skillPrompt, capabilityWarnings(capabilityLoad)].filter(Boolean).join('\n\n'),
        model,
        tools: descriptors.map(descriptor => piTool(descriptor, toolRuntime, input, definition, controller.signal)),
        thinkingLevel: definition.limits.reasoningEffort ?? 'medium',
      },
      streamFn,
      getApiKey: () => input.model.apiKey,
      sessionId: `${input.snapshot.runId}:${definition.agentKey}`,
      toolExecution: 'sequential',
      beforeToolCall: async ({ toolCall }) => byPiName.has(toolCall.name) ? undefined : { block: true, reason: 'TOOL_NOT_ALLOWED' },
    })
    agent.subscribe(async (event, eventSignal) => {
      if (event.type === 'turn_start' && ++turns > definition.limits.maxTurns) controller.abort(new Error('REVIEW_QA_TURN_LIMIT_EXCEEDED'))
      if (!isTransientAgentEvent(event)) await record(toReviewQaAuditEvent(event, turns, input))
      if (eventSignal.aborted) controller.abort(eventSignal.reason ?? new Error('REVIEW_QA_CANCELLED'))
      if (controller.signal.aborted) agent.abort()
    })
    controller.signal.addEventListener('abort', () => agent.abort(), { once: true })
    try {
      await record({ type: 'runtime_initialized', turn: 0, framework: { name: 'pi-agent-core', version: piVersion } })
      await agent.prompt(renderQuestion(input, definition))
      await agent.waitForIdle()
      if (!candidate && !controller.signal.aborted) {
        forceSubmit = true
        await record({ type: 'result_submission_retry', turn: turns, content: '模型尚未通过结果工具提交答案，已进入强制提交阶段。' })
        await agent.prompt('请立即使用 review_answer_submit 提交最终答案；不要继续输出普通文本。')
        await agent.waitForIdle()
      }
      if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('REVIEW_QA_CANCELLED')
      if (!candidate) throw new Error('REVIEW_QA_RESULT_NOT_SUBMITTED')
      return {
        candidate,
        execution: {
          agentKey: 'review-qa' as const,
          turns,
          toolCalls: events.filter(event => event.type === 'tool_execution_start').length,
          toolErrors: events.filter(event => event.type === 'tool_execution_end' && event.isError).length,
          framework: { name: 'pi-agent-core' as const, version: piVersion },
          events,
        },
      }
    } finally {
      clearTimeout(deadline)
      signal.removeEventListener('abort', abort)
      if (agent.state.isStreaming) agent.abort()
      await capabilityLoad.close()
    }
  }
}

function toReviewQaAuditEvent(event: AgentEvent, turn: number, input: ReviewQaExecutionInput) {
  const audit = toAuditEvent(event, turn, input.model.baseUrl, input.model.apiKey)
  if (event.type === 'message_end' && event.message.role === 'user') {
    return { ...audit, content: '已提交当前问题与固定 ReviewRun 上下文；为避免复制整份需求正文，输入详情不写入问答轨迹。' }
  }
  return audit
}

function piTool(descriptor: ToolDescriptor, runtime: GovernedToolRuntime, input: ReviewQaExecutionInput, definition: AgentDefinitionVersion, signal: AbortSignal): AgentTool {
  return {
    name: descriptor.piName,
    label: descriptor.label,
    description: `${descriptor.description} 业务工具 ID：${descriptor.id}；版本：${descriptor.version}。`,
    parameters: descriptor.parameters,
    executionMode: 'sequential',
    execute: async (toolCallId, args, toolSignal) => {
      const result = await runtime.execute({
        toolId: descriptor.id,
        toolCallId,
        arguments: args,
        context: { snapshot: input.snapshot, allowedToolIds: new Set(definition.toolIds) },
      }, AbortSignal.any([signal, toolSignal ?? signal]))
      return {
        content: [{ type: 'text', text: JSON.stringify(result.data) }],
        details: { toolId: descriptor.id, version: descriptor.version, data: result.data },
        terminate: result.terminate,
      }
    },
  }
}

function renderQuestion(input: ReviewQaExecutionInput, definition: AgentDefinitionVersion) {
  const allowedCitationEvidence = input.reviewResult.evidence.map(item => ({ id: item.clientEvidenceId, quote: item.quote, heading: item.locator.heading, chunkId: item.sourceRef.chunkId }))
  const fixedContext = {
    runId: input.snapshot.runId,
    assetVersionId: input.snapshot.assetVersionId,
    indexVersionId: input.snapshot.indexVersionId,
    review: input.reviewResult,
    allowedCitationEvidence,
    quotedContext: input.quote ?? null,
    documentContent: input.documentContent,
  }
  return definition.taskTemplate
    .replaceAll('{{runId}}', input.snapshot.runId)
    .replaceAll('{{question}}', input.question)
    .replaceAll('{{fixedContext}}', JSON.stringify(fixedContext))
}

function capabilityWarnings(value: CapabilityLoadResult) {
  return value.warnings.length ? `以下能力绑定未能加载，不要假设它们可用：\n${value.warnings.join('\n')}` : ''
}

function emptyCapabilityLoad(): CapabilityLoadResult { return { warnings: [], close: async () => undefined } }

function createModel(input: ReviewQaExecutionInput): Model<Api> {
  const api: Api = input.model.providerType === 'anthropic' ? 'anthropic-messages' : 'openai-completions'
  return { id: input.model.modelName, name: input.model.modelName, api, provider: input.model.sourceId, baseUrl: normalizeBaseUrl(input.model.baseUrl, api), reasoning: input.model.supportsReasoning, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: input.model.contextWindow, maxTokens: input.model.maxOutputTokens } as Model<Api>
}

function createStreamFn(input: ReviewQaExecutionInput): StreamFn { return (input.model.providerType === 'anthropic' ? streamAnthropic : streamOpenAi) as StreamFn }
function normalizeBaseUrl(value: string, api: Api) { const withoutSlash = value.replace(/\/$/u, ''); return api === 'anthropic-messages' ? withoutSlash.replace(/\/messages$/iu, '') : withoutSlash.replace(/\/chat\/completions$/iu, '') }
