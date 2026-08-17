import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core'
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai'
import {
  AgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  compact as compactPiContext,
  type AgentSessionEvent,
  type InlineExtension,
  type SessionManager,
} from '@earendil-works/pi-coding-agent'
import { streamSimple as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages'
import { streamSimple as streamOpenAi } from '@earendil-works/pi-ai/api/openai-completions'
import type { AgentExecutionEvent, AgentExecutionInput, AgentExecutionOutput, AgentModelConnection, AgentRuntime, InputDeliveryManifest, RequirementInputBatch, ReviewCandidate, ReviewerExecutionInput, ReviewerExecutionOutput } from '../domain/agent-types.js'
import type { AgentCandidateResult } from '../domain/review-types.js'
import type { ToolApprovalGate } from '../domain/tool-types.js'
import type { ToolDescriptor } from '../domain/tool-types.js'
import type { StateStore } from '../infrastructure/store.js'
import type { SkillPackageStore } from '../infrastructure/skill-package-store.js'
import { GovernedToolRuntime } from '../tools/runtime.js'
import { AgentCapabilityLoader } from '../tools/capability-loader.js'
import { createWorkspaceAgentToolRegistry } from '../tools/requirement-tools.js'
import { RequirementDocumentWorkspace } from '../tools/requirement-document-workspace.js'
import { defaultBuiltInToolConfigResolver } from '../tools/built-in-tool-config.js'
import { AgentSkillRuntime } from './skill-runtime.js'
import { KnowledgeService } from '../application/knowledge-service.js'
import { ContextManager, protectedCompactionInstructions, type PlanningCompactionCheckpoint } from './context-manager.js'
import {
  PiSessionRuntime,
  type PersistedParentSessionBinding,
  type PiSessionScope,
} from './pi-session-runtime.js'

const require = createRequire(import.meta.url)
export const piVersion = (require('@earendil-works/pi-agent-core/package.json') as { version: string }).version
export const piCodingAgentVersion = '0.84.1'
const RESULT_SUBMISSION_TURN_RESERVE = 3
const RESULT_SUBMISSION_TOOL_RESERVE = 3
const TRANSIENT_MODEL_RETRIES = 2
const MODEL_RETRY_BASE_DELAY_MS = 1_000

export interface PiRuntimeBindings {
  model?: Model<Api>
  streamFn?: StreamFn
  retryBaseDelayMs?: number
}

type SubmissionBatchState = {
  mergedArgumentsByPrimaryId: Map<string, Record<string, unknown>>
  primaryIdByRedundantId: Map<string, string>
  acceptedPrimaryIds: Set<string>
  callCountByPrimaryId: Map<string, number>
}

type PiModelInput = {
  model: AgentModelConnection
  snapshot: {
    agentDefinition: Pick<
      AgentExecutionInput['snapshot']['agentDefinition'],
      'limits'
    >
  }
}

type ParentSessionBinding = {
  scope: PiSessionScope
  model: AgentModelConnection
  agentDefinition: AgentExecutionInput['snapshot']['agentDefinition']
  systemPrompt: string
}

export class PiAgentRuntimeAdapter implements AgentRuntime {
  private readonly knowledge: KnowledgeService
  private readonly parentBindings = new Map<string, ParentSessionBinding>()

  constructor(
    private readonly store: StateStore,
    private readonly bindings: PiRuntimeBindings = {},
    private readonly skillPackages?: SkillPackageStore,
    private readonly approvalGate?: ToolApprovalGate,
    knowledge?: KnowledgeService,
    private readonly sessions = PiSessionRuntime.inMemory(),
    private readonly contexts = new ContextManager(),
  ) {
    this.knowledge = knowledge ?? new KnowledgeService(store)
  }

  context(scopeKey: string) {
    return this.sessions.context(scopeKey)
  }

  contextProfile() {
    return this.contexts.profile()
  }

  queueCompactionCheckpoint(
    scopeKey: string,
    checkpoint: PlanningCompactionCheckpoint,
  ) {
    this.contexts.queueCheckpoint(scopeKey, checkpoint)
  }

  async compact(scopeKey: string) {
    if (this.sessions.active(scopeKey)) throw new Error('PI_SESSION_BUSY')
    const binding = this.parentBindings.get(scopeKey)
      ?? await this.restoreParentBinding(scopeKey)
    if (!binding) throw new Error('PI_SESSION_BINDING_NOT_AVAILABLE')
    const lease = await this.sessions.acquireIdle(binding.scope)
    let session: AgentSession | undefined
    try {
      const modelInput = {
        snapshot: {
          agentDefinition: binding.agentDefinition,
        },
        model: binding.model,
      }
      const model = this.bindings.model ?? createModel(modelInput)
      const providerStreamFn = this.bindings.streamFn ?? createStreamFn(modelInput)
      const streamFn = configuredStreamFn(
        binding.model,
        providerStreamFn,
      )
      const sessionContext = lease.manager.buildSessionContext()
      const agent = new Agent({
        initialState: {
          systemPrompt: binding.systemPrompt,
          model,
          tools: [],
          thinkingLevel: binding.agentDefinition.limits.reasoningEffort ?? 'medium',
        },
        streamFn,
        getApiKey: () => binding.model.apiKey,
        sessionId: lease.manager.getSessionId(),
        toolExecution: 'sequential',
      })
      agent.state.messages = sessionContext.messages
      session = await createPiAgentSession({
        agent,
        manager: lease.manager,
        model,
        tools: [],
        systemPrompt: binding.systemPrompt,
        input: modelInput,
        streamFn,
        compactionStreamFn: streamFn,
      })
      await this.contexts.compact(session)
      const context = this.contexts.describe(session, binding.scope)
      this.sessions.rememberContext(scopeKey, context)
      return context
    } finally {
      session?.dispose()
      lease.release()
    }
  }

  private async restoreParentBinding(scopeKey: string) {
    const persisted = this.sessions.parentBinding(scopeKey)
    if (!persisted) return undefined
    const state = await this.store.snapshot()
    const source = state.modelSources.find(
      item => item.id === persisted.model.sourceId,
    )
    const model = source?.models.find(
      item => item.id === persisted.model.modelId,
    )
    if (
      !source
      || !model
      || source.providerType !== persisted.model.providerType
      || model.name !== persisted.model.modelName
      || model.contextWindow < persisted.model.contextWindow
      || model.capabilities.includes('reasoning') !== persisted.model.supportsReasoning
    ) {
      throw new Error('PI_SESSION_MODEL_BINDING_DRIFT')
    }
    const binding: ParentSessionBinding = {
      scope: persisted.scope,
      model: {
        ...persisted.model,
        baseUrl: source.baseUrl,
        apiKey: source.apiKey,
      },
      agentDefinition: persisted.agentDefinition,
      systemPrompt: persisted.systemPrompt,
    }
    this.parentBindings.set(scopeKey, binding)
    return binding
  }

  async injectReviewCandidate(snapshot: ReviewerExecutionInput['snapshot'], output: ReviewerExecutionOutput) {
    const scope = this.sessions.scopeFor({ snapshot })
    const lease = await this.sessions.acquire(scope)
    try {
      lease.manager.appendCustomMessageEntry(
        'planning_reviewer_candidate',
        reviewCandidateContext(output),
        false,
        {
          subAgentRunId: output.runId,
          reviewerType: output.reviewerType,
          reviewerSessionId: output.context.sessionId,
          formalBusinessFact: false,
        },
      )
      return {
        parentSessionId: lease.manager.getSessionId(),
        subAgentRunId: output.runId,
        reviewerType: output.reviewerType,
      }
    } finally {
      lease.release()
    }
  }

  async appendPlanningTask(input: { projectId: string; projectVersionId: string; task: string; taskType: string; metadata?: Record<string, unknown> }) {
    const scope: PiSessionScope = {
      role: 'planning_parent',
      key: `planning:${input.projectId}:${input.projectVersionId}`,
    }
    const lease = await this.sessions.acquire(scope)
    try {
      lease.manager.appendCustomMessageEntry(
        'planning_workflow_task',
        planningWorkflowTaskContext(input.task, input.taskType),
        false,
        {
          taskType: input.taskType,
          projectId: input.projectId,
          projectVersionId: input.projectVersionId,
          formalBusinessFact: false,
          ...(input.metadata ?? {}),
        },
      )
      return { parentSessionId: lease.manager.getSessionId(), scopeKey: scope.key }
    } finally {
      lease.release()
    }
  }

  async appendPlanningClarification(input: { projectId: string; projectVersionId: string; runId: string; clarificationId: string; question: string; answer: string; status: 'answered' | 'dismissed'; answeredAt: string; answeredBy: string }) {
    const scope: PiSessionScope = {
      role: 'planning_parent',
      key: `planning:${input.projectId}:${input.projectVersionId}`,
    }
    const lease = await this.sessions.acquire(scope)
    try {
      lease.manager.appendCustomMessageEntry(
        'planning_clarification_answer',
        [
          '[Human Clarification；该内容已由 Service 保存为正式、可追溯输入]',
          `Source Run：${input.runId}`,
          `Clarification：${input.clarificationId}`,
          `Question：${input.question}`,
          `Human Answer：${input.answer}`,
          `Disposition：${input.status}`,
          `Answered By：${input.answeredBy}`,
          `Answered At：${input.answeredAt}`,
          '继续分析时必须从 ReviewRunSnapshot.formalClarifications 与冻结 Workspace 重新建立正式事实，不得只依赖本消息或 Context Summary。',
        ].join('\n'),
        false,
        {
          taskType: 'planning_clarification_answer',
          projectId: input.projectId,
          projectVersionId: input.projectVersionId,
          sourceRunId: input.runId,
          clarificationId: input.clarificationId,
          formalBusinessFact: true,
        },
      )
      return { parentSessionId: lease.manager.getSessionId(), scopeKey: scope.key }
    } finally {
      lease.release()
    }
  }

  async review(input: ReviewerExecutionInput, signal: AbortSignal): Promise<ReviewerExecutionOutput> {
    const parentScope = this.sessions.scopeFor(input)
    const scope = this.sessions.reviewerScope(parentScope, input.reviewerType, input.runId)
    const lease = await this.sessions.acquire(scope)
    const manager = lease.manager
    const workspace = new RequirementDocumentWorkspace(this.store, input.snapshot)
    const readPaths = new Set<string>()
    let reviewCandidate: ReviewCandidate | undefined
    const requiredReadPaths = [...new Set(input.requiredReadPaths.map(normalizeReviewPath))]
    const registry = createWorkspaceAgentToolRegistry(
      this.store,
      'reviewer.submit_result',
      candidate => {
        const missingReads = requiredReadPaths.filter(path => !readPaths.has(path))
        if (missingReads.length) return { accepted: false, issues: missingReads.map(path => ({ path: '/workspaceReads', message: `提交前必须读取 /workspace/${path}` })) }
        const normalized = validateReviewCandidate(candidate, input.reviewerType)
        if (!normalized.valid) return { accepted: false, issues: normalized.issues }
        reviewCandidate = normalized.candidate
        return { accepted: true }
      },
      observation => { readPaths.add(normalizeReviewPath(observation.relativePath)) },
      workspace,
      this.knowledge,
    )
    if (!requiredReadPaths.length) throw new Error('REVIEWER_REQUIRED_READS_EMPTY')
    const parentToolIds = new Set(input.snapshot.agentDefinition.toolIds)
    const allowedToolIds = new Set([
      ...[
        'workspace.read_file',
        'workspace.grep_files',
        'workspace.find_files',
        'workspace.list_directory',
        'knowledge.search',
        'knowledge.read_chunk',
      ].filter(toolId => parentToolIds.has(toolId)),
      'reviewer.submit_result',
    ])
    if (!allowedToolIds.has('workspace.read_file')) throw new Error('REVIEWER_PARENT_READ_PERMISSION_REQUIRED')
    const descriptors = registry.descriptors(allowedToolIds)
    const runtime = new GovernedToolRuntime(
      registry,
      { maxToolCalls: Math.min(40, input.snapshot.agentDefinition.limits.maxToolCalls), maxRepeatedToolCall: input.snapshot.agentDefinition.limits.maxRepeatedToolCall },
      { toolIds: new Set(['reviewer.submit_result']), calls: 3 },
    )
    const events: AgentExecutionEvent[] = []
    let sequence = 0
    let turns = 0
    const limits = input.snapshot.agentDefinition.limits
    const controller = new AbortController()
    const deadline = setTimeout(
      () => controller.abort(
        new Error('REVIEWER_DEADLINE_EXCEEDED'),
      ),
      limits.deadlineMs,
    )
    const abort = () => controller.abort(
      signal.reason ?? new Error('REVIEWER_CANCELLED'),
    )
    signal.addEventListener('abort', abort, { once: true })
    let session: AgentSession | undefined
    let unbind: (() => void) | undefined
    let unsubscribe: (() => void) | undefined
    let sessionEventQueue = Promise.resolve()
    const record = async (event: Omit<AgentExecutionEvent, 'sequence' | 'occurredAt'>) => {
      const value = { sequence: ++sequence, occurredAt: new Date().toISOString(), reviewerType: input.reviewerType, subAgentRunId: input.runId, ...event }
      events.push(value)
      await input.onEvent?.(value)
    }
    try {
      const model = this.bindings.model ?? createModel(input)
      const providerStreamFn =
        this.bindings.streamFn ?? createStreamFn(input)
      const streamFn = configuredStreamFn(input.model, providerStreamFn, controller)
      const tools = descriptors.map(descriptor => reviewerTool(
        descriptor,
        runtime,
        input.snapshot,
        allowedToolIds,
        controller.signal,
      ))
      const systemPrompt = reviewerSystemPrompt(input.reviewerType)
      const agent = new Agent({
        initialState: { systemPrompt, model, tools, thinkingLevel: input.snapshot.agentDefinition.limits.reasoningEffort ?? 'medium' },
        streamFn,
        getApiKey: () => input.model.apiKey,
        sessionId: manager.getSessionId(),
        toolExecution: 'sequential',
      })
      session = await createPiAgentSession({ agent, manager, model, tools, systemPrompt, input, streamFn, compactionStreamFn: streamFn })
      unbind = this.sessions.bindActive(scope, session)
      unsubscribe = session.subscribe(event => {
        const contextEvent = this.contexts.sessionEvent(event, session!, scope)
        if (contextEvent) sessionEventQueue = sessionEventQueue.then(() => record(contextEvent))
      })
      agent.subscribe(async (event, eventSignal) => {
        if (event.type === 'turn_start') {
          turns += 1
          if (turns > limits.maxTurns) {
            controller.abort(
              new Error('REVIEWER_TURN_LIMIT_EXCEEDED'),
            )
          }
        }
        if (!isTransientAgentEvent(event)) {
          await record(toAuditEvent(
            event,
            turns,
            input.model.baseUrl,
            input.model.apiKey,
          ))
        }
        if (eventSignal.aborted || controller.signal.aborted) {
          agent.abort()
        }
      })
      controller.signal.addEventListener(
        'abort',
        () => agent.abort(),
        { once: true },
      )
      const initialContext = this.contexts.describe(session, scope)
      await record({ type: 'session_created', context: initialContext, framework: { name: 'pi-coding-agent', version: piCodingAgentVersion }, ...(lease.parentSessionId ? { parentSessionId: lease.parentSessionId } : {}) })
      await record(this.contexts.usageEvent(session, scope))
      await session.prompt(`${input.task}\n\n${reviewerInstructions(input.reviewerType, input.requiredReadPaths)}`)
      await session.waitForIdle()
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error('REVIEWER_CANCELLED')
      }
      if (turns > limits.maxTurns) {
        throw new Error('REVIEWER_TURN_LIMIT_EXCEEDED')
      }
      const missingReads = requiredReadPaths.filter(path => !readPaths.has(path))
      if (missingReads.length) throw new Error(`REVIEWER_REQUIRED_READ_MISSING: ${missingReads.join(', ')}`)
      if (!reviewCandidate) throw new Error('REVIEWER_RESULT_REQUIRED')
      await sessionEventQueue
      const context = this.contexts.describe(session, scope)
      this.sessions.rememberContext(scope.key, context)
      await record(this.contexts.usageEvent(session, scope))
      return {
        runId: input.runId,
        reviewerType: input.reviewerType,
        ...(lease.parentSessionId ? { parentSessionId: lease.parentSessionId } : {}),
        candidate: reviewCandidate,
        events,
        turns,
        toolCalls: events.filter(event => event.type === 'tool_execution_start').length,
        toolErrors: events.filter(event => event.type === 'tool_execution_end' && event.isError).length,
        framework: { name: 'pi-coding-agent', version: piCodingAgentVersion },
        context,
      }
    } finally {
      clearTimeout(deadline)
      signal.removeEventListener('abort', abort)
      if (session?.isStreaming) await session.abort().catch(() => undefined)
      await sessionEventQueue.catch(() => undefined)
      unsubscribe?.()
      unbind?.()
      session?.dispose()
      lease.release()
      await workspace.dispose()
    }
  }

  async execute(input: AgentExecutionInput, signal: AbortSignal): Promise<AgentExecutionOutput> {
    let candidate: AgentCandidateResult | Record<string, unknown> | undefined
    let lastSubmissionIssues: Array<{ path: string; message: string }> = []
    const stage = stageConfiguration(input)
    const inputPlan = required(input.requirementInputPlan, 'AGENT_INPUT_PLAN_REQUIRED: Agent 缺少服务端输入计划')
    if (inputPlan.mode !== 'agent_directory') throw new Error('PI_WORKSPACE_INPUT_REQUIRED: Workspace Agent 只支持 /workspace 文件工作区输入')
    requireAllowedToolset(input.snapshot.agentDefinition.toolIds, stage.submitToolId, stage.allowedToolIds)
    const piDocumentWorkspace = new RequirementDocumentWorkspace(this.store, input.snapshot)
    const workspaceProfile = required(input.executionProfile, 'WORKSPACE_EXECUTION_PROFILE_REQUIRED')
    const skillRuntime = new AgentSkillRuntime(this.store, this.skillPackages)
    const skillSession = await skillRuntime.prepare(input.snapshot.agentDefinition, workspaceProfile.workflowStage)
    const deliveryManifest: InputDeliveryManifest = {
      policyVersion: inputPlan.policyVersion,
      mode: inputPlan.mode,
      packageSha256: inputPlan.packageSha256,
      entries: [],
      ...(inputPlan.mode === 'agent_directory' ? { toolReads: [] } : {}),
      finalMergeCompleted: false,
    }
    const registry = createWorkspaceAgentToolRegistry(this.store, stage.submitToolId, async value => {
      const normalized = await workspaceProfile.validateCandidate(value, required(deliveryManifest, '输入投递证明不存在'))
      if (!normalized.valid || !normalized.result) { lastSubmissionIssues = normalized.issues; return { accepted: false, issues: normalized.issues } }
      candidate = normalized.result
      lastSubmissionIssues = []
      return { accepted: true }
    }, observation => {
      if (deliveryManifest.mode !== 'agent_directory') return
      if (deliveryManifest.toolReads?.some(item => item.toolCallId === observation.toolCallId)) return
      deliveryManifest.toolReads ??= []
      deliveryManifest.toolReads.push(structuredClone(observation))
    }, piDocumentWorkspace, this.knowledge)
    const skillPrompt = skillSession.renderPrompt()
    const capabilityLoad = await new AgentCapabilityLoader(this.store, this.skillPackages).load(input.snapshot.agentDefinition, registry, signal)
    const limits = input.snapshot.agentDefinition.limits
    const toolRuntime = new GovernedToolRuntime(registry, limits, { toolIds: new Set([stage.submitToolId]), calls: RESULT_SUBMISSION_TOOL_RESERVE }, this.approvalGate)
    const allowedToolIds = runtimeAllowedToolIds(input, capabilityLoad.skillRuntimeToolIds)
    const descriptors = registry.descriptors(allowedToolIds)
    const registeredToolIds = new Set(descriptors.map(descriptor => descriptor.id))
    const unavailableToolIds = [...allowedToolIds].filter(toolId => !registeredToolIds.has(toolId))
    if (!registeredToolIds.has(stage.submitToolId)) {
      await capabilityLoad.close()
      throw new Error(`RESULT_SUBMISSION_TOOL_UNAVAILABLE: ${stage.submitToolId}`)
    }
    const byPiName = new Map(descriptors.map(descriptor => [descriptor.piName, descriptor]))
    const events: AgentExecutionEvent[] = []
    let sequence = 0
    let turns = 0
    const record = async (event: Omit<AgentExecutionEvent, 'sequence' | 'occurredAt'>) => {
      const value = { sequence: ++sequence, occurredAt: new Date().toISOString(), ...event }
      events.push(value)
      await input.onEvent?.(value)
    }
    for (const warning of capabilityLoad.warnings) await record({ type: 'capability_binding_unavailable', content: warning })
    if (unavailableToolIds.length) await record({ type: 'tool_bindings_unavailable', content: `以下目录绑定尚未注册到当前 Agent 运行时，因此不会暴露给模型：${unavailableToolIds.join('、')}` })
    await record({ type: 'skill_bindings_loaded', content: JSON.stringify({ workflowStage: skillSession.workflowStage, enabledSkills: skillSession.catalog().map(skill => ({ key: skill.key, version: skill.version })) }) })
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(new Error('AGENT_DEADLINE_EXCEEDED')), limits.deadlineMs)
    const abort = () => controller.abort(signal.reason ?? new Error('AGENT_CANCELLED'))
    signal.addEventListener('abort', abort, { once: true })

    const model = this.bindings.model ?? createModel(input)
    const providerStreamFn = this.bindings.streamFn ?? createStreamFn(input)
    const sessionScope = this.sessions.scopeFor(input)
    let forceResultSubmission = false
    let latestModelFailure: ModelFailure | undefined
    let submitToolCallObserved = false
    let resultSubmissionRequiredRecorded = false
    const resultSubmissionTurn = Math.max(1, limits.maxTurns - RESULT_SUBMISSION_TURN_RESERVE + 1)
    const streamFn: StreamFn = (streamModel, context, options) => {
      const configuredOptions = {
        ...options,
        maxTokens: input.model.maxOutputTokens,
        signal: options?.signal ?? controller.signal,
      }
      const requestOptions = forceResultSubmission ? {
        ...configuredOptions,
        toolChoice: input.model.providerType === 'anthropic'
          ? { type: 'tool', name: stage.submitPiName }
          : { type: 'function', function: { name: stage.submitPiName } },
      } as Parameters<StreamFn>[2] : configuredOptions
      return streamWithIdleTimeout(providerStreamFn, streamModel, context, requestOptions, input.model.requestTimeoutMs)
    }
    let agent: Agent | undefined
    let session: AgentSession | undefined
    let releaseSession: (() => void) | undefined
    let unbindActive: (() => void) | undefined
    let unsubscribeSession: (() => void) | undefined
    let sessionEventQueue = Promise.resolve()
    try {
      const requireResultSubmission = async (content?: string) => {
        if (forceResultSubmission && resultSubmissionRequiredRecorded) return
        forceResultSubmission = true
        resultSubmissionRequiredRecorded = true
        await record({ type: 'result_submission_required', turn: turns, ...(content ? { content } : {}) })
      }
      const submissionBatches: SubmissionBatchState = {
        mergedArgumentsByPrimaryId: new Map(),
        primaryIdByRedundantId: new Map(),
        acceptedPrimaryIds: new Set(),
        callCountByPrimaryId: new Map(),
      }
      const tools = descriptors.map(descriptor => this.piTool(descriptor, toolRuntime, input, allowedToolIds, controller.signal, requireResultSubmission, submissionBatches))
      const primaryToolNames = new Set(descriptors.map(descriptor => descriptor.piName))
      const primaryTools = tools.filter(tool => primaryToolNames.has(tool.name))
      let activeToolNames = new Set(primaryToolNames)
      const lease = await this.sessions.acquire(sessionScope)
      releaseSession = lease.release
      const sessionManager = lease.manager
      const sessionContext = sessionManager.buildSessionContext()
      const systemPrompt = [input.snapshot.agentDefinition.systemPrompt, skillPrompt].filter(Boolean).join('\n\n')
      if (sessionScope.role === 'planning_parent') {
        const parentBinding: ParentSessionBinding = {
          scope: sessionScope,
          model: structuredClone(input.model),
          agentDefinition: structuredClone(input.snapshot.agentDefinition),
          systemPrompt,
        }
        this.parentBindings.set(sessionScope.key, parentBinding)
        const {
          baseUrl: _baseUrl,
          apiKey: _apiKey,
          ...persistedModel
        } = parentBinding.model
        const persisted: PersistedParentSessionBinding = {
          scope: parentBinding.scope,
          model: persistedModel,
          agentDefinition: parentBinding.agentDefinition,
          systemPrompt: parentBinding.systemPrompt,
        }
        this.sessions.rememberParentBinding(persisted)
      }
      agent = new Agent({
        initialState: { systemPrompt, model, tools: primaryTools, thinkingLevel: limits.reasoningEffort ?? 'medium' },
        streamFn,
        getApiKey: () => input.model.apiKey,
        sessionId: sessionManager.getSessionId(),
        toolExecution: 'sequential',
      })
      if (sessionContext.messages.length) agent.state.messages = sessionContext.messages
      session = await createPiAgentSession({
        agent,
        manager: sessionManager,
        model,
        tools: primaryTools,
        systemPrompt,
        input,
        streamFn,
        compactionStreamFn: configuredStreamFn(input.model, providerStreamFn, controller),
      })
      unbindActive = this.sessions.bindActive(sessionScope, session)
      unsubscribeSession = session.subscribe(event => {
        const contextEvent = this.contexts.sessionEvent(event, session!, sessionScope)
        if (contextEvent) sessionEventQueue = sessionEventQueue.then(() => record(contextEvent))
      })
      agent.subscribe(async (event, eventSignal) => {
        let resultSubmissionRequired = false
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          latestModelFailure = modelFailure(event.message)
          if (messageRequestsTool(event.message, stage.submitPiName)) submitToolCallObserved = true
        }
        if (event.type === 'turn_start') {
          turns += 1
          if (turns > limits.maxTurns) agent?.abort()
          else if (turns >= resultSubmissionTurn && !forceResultSubmission) {
            forceResultSubmission = true
            resultSubmissionRequiredRecorded = true
            resultSubmissionRequired = true
          }
        }
        if (!isTransientAgentEvent(event)) {
          const auditEvent = toAuditEvent(event, turns, input.model.baseUrl, input.model.apiKey)
          await record(auditEvent)
        }
        if (resultSubmissionRequired) await record({ type: 'result_submission_required', turn: turns })
        if (eventSignal.aborted || controller.signal.aborted) agent?.abort()
      })
      controller.signal.addEventListener('abort', () => agent?.abort(), { once: true })
      const initialContext = this.contexts.describe(session, sessionScope)
      await record({
        type: 'session_created',
        turn: 0,
        framework: { name: 'pi-coding-agent', version: piCodingAgentVersion },
        context: initialContext,
        ...(lease.parentSessionId ? { parentSessionId: lease.parentSessionId } : {}),
      })
      await record(this.contexts.usageEvent(session, sessionScope))
      await record({ type: 'runtime_initialized', turn: 0, framework: { name: 'pi-coding-agent', version: piCodingAgentVersion } })
      await record({ type: 'input_package_built', turn: 0, content: JSON.stringify({ mode: inputPlan.mode, packageSha256: inputPlan.packageSha256, batches: inputPlan.batches.length, estimatedInputTokens: inputPlan.estimatedInputTokens, safeInputBudget: inputPlan.safeInputBudget }) })
      const current = inputPlan.batches[0]
      deliveryManifest!.entries.push(manifestEntry(current, 1))
      deliveryManifest!.finalMergeCompleted = true
      await record({ type: 'input_batch_delivered', turn: turns, content: JSON.stringify({ batchId: current.batchId, ordinal: current.ordinal, contentSha256: sha256(current.content), tokenCount: current.tokenCount }) })
      await this.contexts.consumeCheckpoint(
        session,
        sessionScope.key,
      )
      const beforePromptCheckpoint = compactionCheckpoint(workspaceProfile.workflowStage, 'before_prompt')
      if (beforePromptCheckpoint) await this.contexts.compactAtCheckpoint(session, beforePromptCheckpoint)
      await session.prompt(`${renderInitialTask(input)}\n\n${current.content}`)
      await session.waitForIdle()
      if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('AGENT_CANCELLED')
      const initialModelFailure = !candidate && !lastSubmissionIssues.length ? latestModelFailure : undefined
      if (initialModelFailure && !initialModelFailure.retryable) throw modelProviderError(initialModelFailure)
      if (turns > limits.maxTurns) {
        if (lastSubmissionIssues.length) throw resultValidationError(lastSubmissionIssues)
        throw new Error('AGENT_TURN_LIMIT_EXCEEDED')
      }
      if (!candidate && lastSubmissionIssues.length) {
        await record({ type: 'result_validation_repair_required', turn: turns, content: formatValidationIssues(lastSubmissionIssues) })
        forceResultSubmission = false
        latestModelFailure = undefined
        const evidenceRepairRequired = hasEvidenceValidationIssue(lastSubmissionIssues)
        if (evidenceRepairRequired) {
          agent.state.tools = tools
          activeToolNames = new Set(tools.map(tool => tool.name))
          await record({ type: 'evidence_repair_tools_enabled', turn: turns, content: '原文定位未能建立 Evidence；可按需使用 grep 或 read 核对固定工作区资料，然后修正 sourceTexts。' })
        }
        const repairGuidance = stage.isGovernedCandidate
          ? '请严格按当前 Stage 的提交工具 Schema 和错误路径修正完整候选；不得修改服务端冻结的任务、证据范围或受保护业务语义。'
          : evidenceRepairRequired
          ? '工作区文件版本、内部证据范围、需求点 ID、Evidence ID、定位和引用均由服务端负责；请只修正需求点内部的 sourceTexts，必要时使用 grep 或 read 核对原文。'
          : '正文投递覆盖、需求点 ID、Evidence ID 和 evidenceRefs 均由服务端负责；请按错误路径直接修正需求点内容，不要进行无关的 Evidence 补读。'
        await session.prompt(`服务端拒绝了刚才的结果提交。以下问题必须先修复：\n${formatValidationIssues(lastSubmissionIssues)}\n${repairGuidance}\n然后通过 ${stage.submitPiName} 重新提交完整结果。`)
        await session.waitForIdle()
      }
      if (!candidate) {
        await record({ type: 'result_submission_retry', turn: turns })
        forceResultSubmission = true
        const submissionPrompt = `现在进入结果提交阶段。不得继续返回普通文本或调用其他工具；请立即通过 ${stage.submitPiName} 提交完整的 ${stage.schemaVersion}。若参数校验失败，请按工具错误修正参数后再次提交。`
        const transientModelRetries = input.model.retryCount ?? TRANSIENT_MODEL_RETRIES
        const firstSubmissionAttempt = initialModelFailure?.retryable ? 1 : 0
        for (let attempt = firstSubmissionAttempt; attempt <= transientModelRetries && !candidate; attempt += 1) {
          if (attempt > 0) {
            const retryDelayMs = modelRetryDelay(this.bindings.retryBaseDelayMs ?? MODEL_RETRY_BASE_DELAY_MS, attempt)
            await record({ type: 'model_retry_scheduled', turn: turns, content: `模型服务临时不可用，${retryDelayMs}ms 后执行第 ${attempt}/${transientModelRetries} 次结果提交重试。` })
            await waitForRetry(retryDelayMs, controller.signal)
          }
          latestModelFailure = undefined
          await session.prompt(attempt === 0 ? submissionPrompt : `模型服务上一次请求临时失败。${submissionPrompt}`)
          await session.waitForIdle()
          const submissionFailure = latestModelFailure as ModelFailure | undefined
          if (!submissionFailure) break
          if (!submissionFailure.retryable || attempt === transientModelRetries) {
            if (lastSubmissionIssues.length) throw resultValidationError(lastSubmissionIssues)
            throw modelProviderError(submissionFailure, attempt)
          }
        }
      }
      if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('AGENT_CANCELLED')
      if (turns > limits.maxTurns) {
        if (lastSubmissionIssues.length) throw resultValidationError(lastSubmissionIssues)
        throw new Error('AGENT_TURN_LIMIT_EXCEEDED')
      }
      if (!candidate && lastSubmissionIssues.length) throw resultValidationError(lastSubmissionIssues)
      if (!candidate && latestModelFailure) throw modelProviderError(latestModelFailure, input.model.retryCount ?? TRANSIENT_MODEL_RETRIES)
      if (!candidate && submitToolCallObserved) throw new Error(`MODEL_TOOL_CALL_STREAM_ABORTED: 模型已开始调用 ${stage.submitPiName}，但工具参数未完整接收或请求被中断；请查看运行记录中的脱敏供应商错误后重试`)
      if (!candidate) throw new Error(`MODEL_TOOL_CALL_REQUIRED: 模型未调用 ${stage.submitPiName}，实际工具调用能力不满足 ${stage.agentLabel}；请在模型管理中重新探测并选择通过工具调用检测的模型`)
      if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > limits.maxCandidateBytes) throw new Error('AGENT_RESULT_TOO_LARGE')
      const completedCheckpoint = compactionCheckpoint(workspaceProfile.workflowStage, 'completed')
      if (completedCheckpoint) await this.contexts.compactAtCheckpoint(session, completedCheckpoint)
      await sessionEventQueue
      const finalContext = this.contexts.describe(session, sessionScope)
      this.sessions.rememberContext(sessionScope.key, finalContext)
      await record(this.contexts.usageEvent(session, sessionScope))
      return {
        candidate,
        events,
        turns,
        toolCalls: events.filter(event => event.type === 'tool_execution_start').length,
        toolErrors: events.filter(event => event.type === 'tool_execution_end' && event.isError).length,
        framework: { name: 'pi-coding-agent', version: piCodingAgentVersion },
        context: finalContext,
        ...(deliveryManifest ? { inputDeliveryManifest: deliveryManifest } : {}),
      }
    } finally {
      clearTimeout(deadline)
      signal.removeEventListener('abort', abort)
      if (session) {
        if (session.isStreaming) await session.abort().catch(() => undefined)
        const finalContext = this.contexts.describe(session, sessionScope)
        this.sessions.rememberContext(sessionScope.key, finalContext)
      } else if (agent?.state.isStreaming) {
        agent.abort()
      }
      await sessionEventQueue.catch(() => undefined)
      unsubscribeSession?.()
      unbindActive?.()
      session?.dispose()
      releaseSession?.()
      await capabilityLoad.close()
      await piDocumentWorkspace?.dispose()
    }
  }

  private piTool(
    descriptor: ToolDescriptor,
    runtime: GovernedToolRuntime,
    input: AgentExecutionInput,
    allowedToolIds: ReadonlySet<string>,
    signal: AbortSignal,
    requireResultSubmission: (content?: string) => Promise<void>,
    submissionBatches: SubmissionBatchState,
  ): AgentTool {
    const stage = stageConfiguration(input)
    return {
      name: descriptor.piName,
      label: descriptor.label,
      description: `${descriptor.description} 业务工具 ID：${descriptor.id}；版本：${descriptor.version}。`,
      parameters: descriptor.parameters,
      executionMode: 'sequential',
      ...(stage.isGovernedCandidate && descriptor.id === stage.submitToolId ? {
        prepareArguments: (args: unknown) => {
          const value = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {}
          return value.schemaVersion === undefined ? { ...value, schemaVersion: stage.schemaVersion } : value
        },
      } : {}),
      execute: async (toolCallId, args, toolSignal) => {
        const primaryId = submissionBatches.primaryIdByRedundantId.get(toolCallId)
        if (primaryId) {
          const accepted = submissionBatches.acceptedPrimaryIds.has(primaryId)
          const data = { accepted, status: accepted ? 'candidate_validated' : 'batch_validation_failed', coalesced: true, primaryToolCallId: primaryId }
          return { content: [{ type: 'text', text: JSON.stringify(data) }], details: { toolId: descriptor.id, version: descriptor.version, data }, terminate: accepted }
        }
        const executionArguments = submissionBatches.mergedArgumentsByPrimaryId.get(toolCallId) ?? args
        const result = await runtime.execute({ toolId: descriptor.id, toolCallId, arguments: executionArguments, context: { snapshot: input.snapshot, allowedToolIds } }, AbortSignal.any([signal, toolSignal ?? signal]))
        if (result.terminate && submissionBatches.mergedArgumentsByPrimaryId.has(toolCallId)) submissionBatches.acceptedPrimaryIds.add(toolCallId)
        if (descriptor.id !== stage.submitToolId && runtime.remainingStandardCalls === 0) await requireResultSubmission(`普通工具调用额度已用尽，保留最后 ${RESULT_SUBMISSION_TOOL_RESERVE} 次调用仅用于 ${stage.submitPiName} 提交或修正结果。`)
        const modelResult = result.replayed
          ? { ...asRecord(result.data), replayed: true, guidance: '这是本次运行已成功读取的固定结果重放；请直接使用返回内容，不要再次提交相同参数。' }
          : result.data
        return {
          content: [{ type: 'text', text: JSON.stringify(modelResult) }],
          details: {
            toolId: descriptor.id,
            version: descriptor.version,
            data: result.data,
            ...(submissionBatches.callCountByPrimaryId.has(toolCallId) ? { coalescedCallCount: submissionBatches.callCountByPrimaryId.get(toolCallId) } : {}),
            ...(result.replayed ? { replayed: true } : {}),
            ...(result.policyError ? { policyError: result.policyError } : {}),
          },
          terminate: result.terminate,
        }
      },
    }
  }
}

function reviewCandidateContext(output: ReviewerExecutionOutput) {
  return [
    '[Reviewer SubAgent 候选输入；不是正式业务事实]',
    `Reviewer 类型：${output.reviewerType}`,
    `SubAgent Run：${output.runId}`,
    '以下候选仅用于 Parent Agent 后续推理；Workflow、Service 和 Validator 必须重新读取固定正式事实并决定是否采纳。',
    JSON.stringify(output.candidate),
  ].join('\n')
}

function planningWorkflowTaskContext(task: string, taskType: string) {
  return [
    '[PlanningWorkflow 下一阶段任务；正式事实必须由 Service 和冻结 Workspace Snapshot 重新读取]',
    `Task Type：${taskType}`,
    task.trim(),
    '继续使用当前 PlanningAgent、Planning Session、Agent Configuration 和 Enabled Skills。Workflow 没有替你选择 Skill；请根据任务与正式状态自主决定。',
  ].join('\n')
}

function reviewerTool(
  descriptor: ToolDescriptor,
  runtime: GovernedToolRuntime,
  snapshot: ReviewerExecutionInput['snapshot'],
  allowedToolIds: ReadonlySet<string>,
  signal: AbortSignal,
): AgentTool {
  return {
    name: descriptor.piName,
    label: descriptor.label,
    description: descriptor.description,
    parameters: descriptor.parameters,
    executionMode: 'sequential',
    execute: async (toolCallId, args, toolSignal) => {
      const result = await runtime.execute({
        toolId: descriptor.id,
        toolCallId,
        arguments: args,
        context: { snapshot, allowedToolIds },
      }, AbortSignal.any([signal, toolSignal ?? signal]))
      return {
        content: [{ type: 'text', text: JSON.stringify(result.data) }],
        details: { toolId: descriptor.id, version: descriptor.version, data: result.data },
        terminate: result.terminate,
      }
    },
  }
}

function reviewerSystemPrompt(reviewerType: ReviewerExecutionInput['reviewerType']) {
  const focus = {
    requirement: '需求完整性、一致性、歧义、可验证性与 Test Focus',
    test_point: '测试点覆盖、维度、适用性、Oracle 与需求追踪',
    test_case: '测试用例步骤、Expected Result、边界、数据、依赖与可执行性',
    coverage: 'Requirement/TestPoint/TestCase 覆盖关系、遗漏、重复与阻塞项',
  }[reviewerType]
  return [
    `你是只读 ${reviewerType} Reviewer，专注于${focus}。`,
    '你拥有独立 Session 和独立 Context，只能读取固定 /workspace 与固定知识库索引。',
    '禁止写 PostgreSQL、修改 Workflow Stage、发布 Requirement Release 或 TestCase Library、修改 Workspace、调用 Runner、Playwright 或 Shell，也不得修改 Expected Result 以获得 PASS。',
    '不得生成或覆盖正式 ID、Version、Revision、Hash、Release 或 Snapshot；不得用 latest/current 替代任务给出的固定引用。',
    '结果仅是 Parent PlanningAgent 的 ReviewCandidate 补充输入，最终采纳由 Workflow、Service 与 Validator 决定。',
  ].join('\n')
}

function reviewerInstructions(reviewerType: ReviewerExecutionInput['reviewerType'], requiredReadPaths: string[]) {
  return [
    `Reviewer 类型固定为 ${reviewerType}，不得改为其他类型。`,
    ...(requiredReadPaths.length ? [`提交前必须逐个使用 read 读取：${requiredReadPaths.map(path => `/workspace/${normalizeReviewPath(path)}`).join('、')}。`] : []),
    '所有 evidenceRefs 必须指向已读取固定文件路径/行号、固定 Requirement/TestPoint/TestCase 引用或固定 Chunk ID；没有证据时不得编造 Finding。',
    '完成后仅调用 reviewer_submit_result 一次提交 planning-review-candidate/v1。',
  ].join('\n')
}

function normalizeReviewPath(value: string) {
  const path = String(value).trim().replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
  if (!path || /^[A-Za-z]:/u.test(path) || path.split('/').some(segment => !segment || segment === '.' || segment === '..')) throw new Error(`REVIEWER_PATH_INVALID: ${value}`)
  return path
}

type ReviewValidation =
  | { valid: true; candidate: ReviewCandidate; issues: [] }
  | { valid: false; issues: Array<{ path: string; message: string }> }

function validateReviewCandidate(value: Record<string, unknown>, reviewerType: ReviewerExecutionInput['reviewerType']): ReviewValidation {
  const issues: Array<{ path: string; message: string }> = []
  const candidate = value as unknown as ReviewCandidate
  if (candidate.schemaVersion !== 'planning-review-candidate/v1') issues.push({ path: '/schemaVersion', message: '必须为 planning-review-candidate/v1' })
  if (candidate.reviewerType !== reviewerType) issues.push({ path: '/reviewerType', message: `必须为 ${reviewerType}` })
  if (!['pass', 'changes_required', 'blocked'].includes(candidate.verdict)) issues.push({ path: '/verdict', message: 'verdict 无效' })
  if (!String(candidate.summary ?? '').trim()) issues.push({ path: '/summary', message: 'summary 不能为空' })
  if (!Array.isArray(candidate.findings)) issues.push({ path: '/findings', message: 'findings 必须为数组' })
  if (!Array.isArray(candidate.suggestedActions)) issues.push({ path: '/suggestedActions', message: 'suggestedActions 必须为数组' })
  if (Array.isArray(candidate.findings)) {
    const refs = new Set<string>()
    candidate.findings.forEach((finding, index) => {
      const path = `/findings/${index}`
      if (!finding || typeof finding !== 'object') { issues.push({ path, message: 'Finding 必须为对象' }); return }
      if (!String(finding.ref ?? '').trim()) issues.push({ path: `${path}/ref`, message: 'ref 不能为空' })
      else if (refs.has(finding.ref)) issues.push({ path: `${path}/ref`, message: 'ref 必须唯一' })
      else refs.add(finding.ref)
      if (!['blocker', 'high', 'medium', 'low'].includes(finding.severity)) issues.push({ path: `${path}/severity`, message: 'severity 无效' })
      for (const field of ['category', 'title', 'detail'] as const) if (!String(finding[field] ?? '').trim()) issues.push({ path: `${path}/${field}`, message: `${field} 不能为空` })
      if (!Array.isArray(finding.evidenceRefs) || !finding.evidenceRefs.length) issues.push({ path: `${path}/evidenceRefs`, message: 'Finding 必须提供 evidenceRefs' })
    })
  }
  if (candidate.verdict === 'pass' && Array.isArray(candidate.findings) && candidate.findings.some(item => item.severity === 'blocker' || item.severity === 'high')) issues.push({ path: '/verdict', message: '存在 blocker/high Finding 时不能判定 pass' })
  return issues.length ? { valid: false, issues } : { valid: true, candidate: structuredClone(candidate), issues: [] }
}

function compactionCheckpoint(
  stage: NonNullable<AgentExecutionInput['executionProfile']>['workflowStage'],
  timing: 'before_prompt' | 'completed',
): PlanningCompactionCheckpoint | undefined {
  if (timing === 'before_prompt' && stage === 'test_case_design') return 'before_test_case_design'
  if (timing !== 'completed') return undefined
  if (stage === 'analysis' || stage === 'verification') return 'requirement_analysis_completed'
  if (stage === 'release') return 'requirement_release_completed'
  if (stage === 'test_design_repair') return 'coverage_repair_completed'
  return undefined
}

function manifestEntry(batch: RequirementInputBatch, modelCallSequence: number) {
  return {
    batchId: batch.batchId,
    ordinal: batch.ordinal,
    assetVersionIds: [...batch.assetVersionIds],
    chunkIds: [...batch.chunkIds],
    contentSha256: sha256(batch.content),
    tokenCount: batch.tokenCount,
    modelCallSequence,
  }
}

function sha256(value: string) { return createHash('sha256').update(value).digest('hex') }
function required<T>(value: T | undefined, message: string): T { if (value === undefined) throw new Error(message); return value }

function runtimeAllowedToolIds(input: AgentExecutionInput, skillRuntimeToolIds: readonly string[] = []) {
  const profile = required(input.executionProfile, 'WORKSPACE_EXECUTION_PROFILE_REQUIRED')
  return new Set([...profile.allowedToolIds, ...skillRuntimeToolIds])
}

function requireAllowedToolset(toolIds: string[], submitToolId: string, allowedToolIds: string[]) {
  const allowed = new Set(allowedToolIds)
  if (!allowed.has(submitToolId)) throw new Error(`PI_AGENT_SUBMIT_TOOL_NOT_ALLOWED: ${submitToolId}`)
  const missing = [...allowed].filter(toolId => !toolIds.includes(toolId))
  if (missing.length) throw new Error(`PI_AGENT_CONFIGURATION_TOOL_MISSING: ${missing.join(', ')}`)
}

type StageConfiguration = {
  isGovernedCandidate: boolean
  submitToolId: string
  submitPiName: string
  schemaVersion: string
  agentLabel: string
  allowedToolIds: string[]
}

function stageConfiguration(input: AgentExecutionInput): StageConfiguration {
  const workspaceStage = input.executionProfile
  if (workspaceStage?.mode !== 'workspace_tools') throw new Error(`AGENT_STAGE_UNSUPPORTED: ${input.snapshot.agentDefinition.agentKey}`)
  return stage({
    isGovernedCandidate: workspaceStage.schemaVersion !== 'requirement-analysis/v1',
    submitToolId: workspaceStage.submitToolId,
    schemaVersion: workspaceStage.schemaVersion,
    agentLabel: workspaceStage.agentLabel,
    allowedToolIds: [...workspaceStage.allowedToolIds],
  })
}

function stage<T extends Omit<StageConfiguration, 'submitPiName'>>(value: T): T & { submitPiName: string } {
  return { ...value, submitPiName: defaultBuiltInToolConfigResolver.toDescriptor(value.submitToolId).piName }
}

function renderInitialTask(input: AgentExecutionInput) {
  return required(input.executionProfile, 'WORKSPACE_EXECUTION_PROFILE_REQUIRED').initialTask
}

function hasEvidenceValidationIssue(issues: Array<{ path: string; message: string }>) {
  return issues.some(issue => issue.path.includes('.sourceTexts') || issue.path.includes('.evidenceDrafts[') || issue.path.endsWith('.evidenceDrafts') || issue.path.startsWith('evidence['))
}

function formatValidationIssues(issues: Array<{ path: string; message: string }>) {
  return issues.slice(0, 20).map(issue => `- ${issue.path}: ${issue.message}`).join('\n')
}

function resultValidationError(issues: Array<{ path: string; message: string }>) {
  const visible = issues.slice(0, 6).map(issue => `${issue.path} ${issue.message}`).join('；')
  return new Error(`AGENT_RESULT_VALIDATION_FAILED: ${visible}${issues.length > 6 ? `；另有 ${issues.length - 6} 项，请查看结果校验事件` : ''}`)
}

interface ModelFailure { kind: 'rate_limited' | 'authentication' | 'provider_unavailable' | 'request_timeout' | 'request_failed'; retryable: boolean }

function modelFailure(message: AgentMessage): ModelFailure | undefined {
  const value = message as AgentMessage & { stopReason?: string; errorMessage?: string; content?: unknown }
  const detail = `${value.errorMessage ?? ''}\n${textFromContent(value.content)}`.toLocaleLowerCase()
  if (value.stopReason === 'aborted') return { kind: 'request_timeout', retryable: true }
  if (value.stopReason !== 'error') return undefined
  if (/\b429\b|rate[_ -]?limit|too_many_requests|exceeded rate limit/u.test(detail)) return { kind: 'rate_limited', retryable: true }
  if (/\b(?:401|403)\b|unauthori[sz]ed|authentication|invalid api key|api key.*invalid/u.test(detail)) return { kind: 'authentication', retryable: false }
  if (/timeout|timed out|request was aborted/u.test(detail)) return { kind: 'request_timeout', retryable: true }
  if (/\b5\d\d\b|econnreset|econnrefused|network|temporar(?:y|ily) unavailable/u.test(detail)) return { kind: 'provider_unavailable', retryable: true }
  return { kind: 'request_failed', retryable: false }
}

function modelProviderError(failure: ModelFailure, retries = 0) {
  if (failure.kind === 'rate_limited') return new Error(`MODEL_RATE_LIMITED: 模型服务触发限流（HTTP 429）${retries ? `，已自动重试 ${retries} 次` : ''}；请稍后重新分析或切换可用模型`)
  if (failure.kind === 'authentication') return new Error('MODEL_AUTHENTICATION_FAILED: 模型服务认证失败；请检查模型来源凭据后重新探测')
  if (failure.kind === 'request_timeout') return new Error(`MODEL_REQUEST_TIMEOUT: 模型请求连续超过配置时长未收到流式数据${retries ? `，已自动重试 ${retries} 次` : ''}；提交工具调用可能尚未完整接收，请降低输出上限、提高流式无响应超时或切换模型`)
  if (failure.kind === 'provider_unavailable') return new Error(`MODEL_PROVIDER_UNAVAILABLE: 模型服务暂时不可用${retries ? `，已自动重试 ${retries} 次` : ''}；请稍后重新分析或切换可用模型`)
  return new Error('MODEL_REQUEST_FAILED: 模型请求失败；请查看运行记录中的脱敏供应商错误后再重试')
}

function modelRetryDelay(baseDelayMs: number, attempt: number) {
  if (baseDelayMs <= 0) return 0
  const exponential = baseDelayMs * (2 ** Math.max(0, attempt - 1))
  return exponential + Math.floor(Math.random() * Math.max(1, Math.floor(baseDelayMs / 2)))
}

async function waitForRetry(delayMs: number, signal: AbortSignal) {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('AGENT_CANCELLED')
  if (delayMs <= 0) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, delayMs)
    const abort = () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new Error('AGENT_CANCELLED')) }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function createModel(input: PiModelInput): Model<Api> {
  const api: Api = input.model.providerType === 'anthropic' ? 'anthropic-messages' : 'openai-completions'
  return {
    id: input.model.modelName,
    name: input.model.modelName,
    api,
    provider: input.model.sourceId,
    baseUrl: normalizeBaseUrl(input.model.baseUrl, api),
    reasoning: input.model.supportsReasoning && (input.snapshot.agentDefinition.limits.reasoningEffort ?? 'medium') !== 'off',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: input.model.contextWindow,
    maxTokens: input.model.maxOutputTokens,
  } as Model<Api>
}

function createStreamFn(input: Pick<AgentExecutionInput, 'model'>): StreamFn {
  return (input.model.providerType === 'anthropic' ? streamAnthropic : streamOpenAi) as StreamFn
}

function configuredStreamFn(
  connection: AgentModelConnection,
  providerStreamFn: StreamFn,
  controller?: AbortController,
): StreamFn {
  return (streamModel, context, options) => {
    const configuredOptions = {
      ...options,
      maxTokens: connection.maxOutputTokens,
      ...(options?.signal || controller?.signal ? { signal: options?.signal ?? controller?.signal } : {}),
    }
    return streamWithIdleTimeout(providerStreamFn, streamModel, context, configuredOptions, connection.requestTimeoutMs)
  }
}

function streamWithIdleTimeout(
  providerStreamFn: StreamFn,
  model: Model<Api>,
  context: Parameters<StreamFn>[1],
  options: Parameters<StreamFn>[2],
  idleTimeoutMs?: number,
) {
  if (!idleTimeoutMs) return providerStreamFn(model, context, options)
  const output = createAssistantMessageEventStream()
  const idleController = new AbortController()
  const signal = options?.signal ? AbortSignal.any([options.signal, idleController.signal]) : idleController.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  let terminal = false
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined }
  const refreshTimer = () => {
    clearTimer()
    timer = setTimeout(() => idleController.abort(new Error('MODEL_STREAM_IDLE_TIMEOUT')), idleTimeoutMs)
    timer.unref?.()
  }
  refreshTimer()
  void (async () => {
    try {
      const source = await providerStreamFn(model, context, { ...options, signal })
      for await (const event of source) {
        refreshTimer()
        if (event.type === 'done' || event.type === 'error') terminal = true
        output.push(event)
      }
      if (!terminal) output.push(streamFailureEvent(model, new Error('MODEL_STREAM_ENDED_WITHOUT_TERMINAL_EVENT'), false))
    } catch (error) {
      if (!terminal) output.push(streamFailureEvent(model, error, idleController.signal.aborted && !options?.signal?.aborted))
    } finally {
      clearTimer()
    }
  })()
  return output
}

function streamFailureEvent(model: Model<Api>, error: unknown, idleTimedOut: boolean) {
  const detail = error instanceof Error ? error.message : String(error)
  const message: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: idleTimedOut ? 'aborted' : 'error',
    errorMessage: idleTimedOut ? `MODEL_STREAM_IDLE_TIMEOUT: ${detail}` : detail,
    timestamp: Date.now(),
  }
  return { type: 'error' as const, reason: message.stopReason as 'aborted' | 'error', error: message }
}

function protectedCompactionExtension(streamFn: StreamFn): InlineExtension {
  return {
    name: 'smarthub-protected-compaction',
    hidden: true,
    factory: pi => {
      pi.on('session_before_compact', async (event, context) => {
        const model = context.model
        if (!model) return { cancel: true }
        const auth = await context.modelRegistry.getApiKeyAndHeaders(model)
        if (!auth.ok) return { cancel: true }
        try {
          const requestModel = auth.baseUrl
            ? { ...model, baseUrl: auth.baseUrl }
            : model
          const instructions = [
            protectedCompactionInstructions(event.reason),
            event.customInstructions,
          ].filter(Boolean).join('\n')
          return {
            compaction: await compactPiContext(
              event.preparation,
              requestModel,
              auth.apiKey,
              auth.headers
                ? Object.fromEntries(
                    Object.entries(auth.headers).filter(
                      (entry): entry is [string, string] => entry[1] != null,
                    ),
                  )
                : undefined,
              instructions,
              event.signal,
              context.thinkingLevel,
              streamFn,
              auth.env,
            ),
          }
        } catch {
          return { cancel: true }
        }
      })
    },
  }
}

async function createPiAgentSession(input: {
  agent: Agent
  manager: SessionManager
  model: Model<Api>
  tools: AgentTool[]
  systemPrompt: string
  input: PiModelInput
  streamFn: StreamFn
  compactionStreamFn: StreamFn
}) {
  const settings = SettingsManager.inMemory({
    compaction: {
      enabled: true,
      reserveTokens: Math.max(16_384, input.input.snapshot.agentDefinition.limits.reservedOutputTokens ?? 16_384),
      keepRecentTokens: 20_000,
    },
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
    images: { autoResize: false, blockImages: true },
  }, { projectTrusted: false })
  const resources = new DefaultResourceLoader({
    cwd: '/workspace',
    agentDir: '/workspace',
    settingsManager: settings,
    extensionFactories: [protectedCompactionExtension(input.compactionStreamFn)],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: input.systemPrompt,
  })
  await resources.reload()
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  })
  modelRuntime.registerProvider(input.model.provider, {
    name: input.model.name,
    baseUrl: input.model.baseUrl,
    apiKey: input.input.model.apiKey,
    api: input.model.api,
    streamSimple: (model, context, options) => {
      const stream = input.streamFn(model, context, options)
      if (stream instanceof Promise) {
        throw new Error('PI_SESSION_STREAM_MUST_BE_SYNCHRONOUS')
      }
      return stream
    },
    models: [{
      id: input.model.id,
      name: input.model.name,
      api: input.model.api,
      baseUrl: input.model.baseUrl,
      reasoning: input.model.reasoning,
      input: input.model.input,
      cost: input.model.cost,
      contextWindow: input.model.contextWindow,
      maxTokens: input.model.maxTokens,
    }],
  })
  const session = new AgentSession({
    agent: input.agent,
    sessionManager: input.manager,
    settingsManager: settings,
    cwd: '/workspace',
    resourceLoader: resources,
    modelRuntime,
    initialActiveToolNames: input.tools.map(tool => tool.name),
    allowedToolNames: input.tools.map(tool => tool.name),
    baseToolsOverride: Object.fromEntries(input.tools.map(tool => [tool.name, tool])),
  })
  session.setAutoCompactionEnabled(true)
  return session
}

function normalizeBaseUrl(value: string, api: Api) {
  const withoutSlash = value.replace(/\/$/u, '')
  return api === 'anthropic-messages' ? withoutSlash.replace(/\/messages$/iu, '') : withoutSlash.replace(/\/chat\/completions$/iu, '')
}

export function isTransientAgentEvent(event: AgentEvent) { return event.type === 'message_update' || event.type === 'tool_execution_update' }

export function toAuditEvent(event: AgentEvent, turn: number, endpoint: string, credential: string): Omit<AgentExecutionEvent, 'sequence' | 'occurredAt'> {
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

function messageRequestsTool(message: AgentMessage, toolName: string) {
  const content = (message as { content?: unknown }).content
  return Array.isArray(content) && content.some(block => block && typeof block === 'object'
    && (block as { type?: string }).type === 'toolCall'
    && (block as { name?: string }).name === toolName)
}

function asRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { data: value }
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
