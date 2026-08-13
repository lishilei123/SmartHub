import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
import { streamSimple as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages'
import { streamSimple as streamOpenAi } from '@earendil-works/pi-ai/api/openai-completions'
import type { AgentExecutionEvent, AgentExecutionInput, AgentExecutionOutput, AgentRuntime, InputDeliveryManifest, RequirementInputBatch } from '../domain/agent-types.js'
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

const require = createRequire(import.meta.url)
export const piVersion = (require('@earendil-works/pi-agent-core/package.json') as { version: string }).version
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

export class PiAgentRuntimeAdapter implements AgentRuntime {
  constructor(private readonly store: StateStore, private readonly bindings: PiRuntimeBindings = {}, private readonly skillPackages?: SkillPackageStore, private readonly approvalGate?: ToolApprovalGate) {}

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
    const skillSession = await skillRuntime.prepare(input.snapshot.agentDefinition, workspaceProfile.workflowStage, workspaceProfile.allowedSkillKeys)
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
    }, piDocumentWorkspace, skillSession)
    const skillPrompt = skillSession?.renderCatalogPrompt() ?? await skillRuntime.render(input.snapshot.agentDefinition)
    const capabilityLoad = await new AgentCapabilityLoader(this.store, this.skillPackages).load(input.snapshot.agentDefinition, registry, signal)
    const limits = input.snapshot.agentDefinition.limits
    const toolRuntime = new GovernedToolRuntime(registry, limits, { toolIds: new Set([stage.submitToolId]), calls: RESULT_SUBMISSION_TOOL_RESERVE }, this.approvalGate)
    const allowedToolIds = runtimeAllowedToolIds(input)
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
    if (skillSession) await record({ type: 'skill_catalog_loaded', content: JSON.stringify({ workflowStage: skillSession.workflowStage, skills: skillSession.catalog().map(skill => ({ key: skill.key, version: skill.version })) }) })
    else if (skillPrompt) await record({ type: 'skill_bindings_loaded', content: `${input.snapshot.agentDefinition.skillBindings.filter(binding => binding.enabled).length} 个 Skill 已按发布快照加载。` })
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(new Error('AGENT_DEADLINE_EXCEEDED')), limits.deadlineMs)
    const abort = () => controller.abort(signal.reason ?? new Error('AGENT_CANCELLED'))
    signal.addEventListener('abort', abort, { once: true })

    const model = this.bindings.model ?? createModel(input)
    const providerStreamFn = this.bindings.streamFn ?? createStreamFn(input)
    let forceResultSubmission = false
    let latestModelFailure: ModelFailure | undefined
    let resultSubmissionRequiredRecorded = false
    const resultSubmissionTurn = Math.max(1, limits.maxTurns - RESULT_SUBMISSION_TURN_RESERVE + 1)
    const streamFn: StreamFn = (streamModel, context, options) => {
      const requestSignal = input.model.requestTimeoutMs
        ? AbortSignal.any([options?.signal ?? controller.signal, AbortSignal.timeout(input.model.requestTimeoutMs)])
        : options?.signal
      const configuredOptions = {
        ...options,
        maxTokens: input.model.maxOutputTokens,
        ...(requestSignal ? { signal: requestSignal } : {}),
      }
      return providerStreamFn(streamModel, context, forceResultSubmission ? {
        ...configuredOptions,
        toolChoice: input.model.providerType === 'anthropic'
          ? { type: 'tool', name: stage.submitPiName }
          : { type: 'function', function: { name: stage.submitPiName } },
      } as Parameters<StreamFn>[2] : configuredOptions)
    }
    let agent: Agent | undefined
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
      const tools = descriptors.map(descriptor => this.piTool(descriptor, toolRuntime, input, controller.signal, requireResultSubmission, submissionBatches))
      const primaryToolNames = new Set(descriptors.map(descriptor => descriptor.piName))
      const primaryTools = tools.filter(tool => primaryToolNames.has(tool.name))
      let activeToolNames = new Set(primaryToolNames)
      agent = new Agent({
        initialState: { systemPrompt: [input.snapshot.agentDefinition.systemPrompt, skillPrompt].filter(Boolean).join('\n\n'), model, tools: primaryTools, thinkingLevel: limits.reasoningEffort ?? 'medium' },
        streamFn,
        getApiKey: () => input.model.apiKey,
        sessionId: `${input.snapshot.runId}:${input.snapshot.agentDefinition.agentKey}`,
        toolExecution: 'sequential',
        beforeToolCall: async ({ toolCall }) => {
          if (!byPiName.has(toolCall.name) || !activeToolNames.has(toolCall.name)) return { block: true, reason: 'TOOL_NOT_ALLOWED_IN_CURRENT_PHASE' }
          return undefined
        },
      })
      agent.subscribe(async (event, eventSignal) => {
        let resultSubmissionRequired = false
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          latestModelFailure = modelFailure(event.message)
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
          if (auditEvent.type === 'tool_execution_end' && auditEvent.toolId === defaultBuiltInToolConfigResolver.toDescriptor('skill.activate').piName && !auditEvent.isError) {
            await record({ type: 'skill_activated', turn: turns, toolId: 'skill.activate', toolCallId: auditEvent.toolCallId, content: JSON.stringify({ workflowStage: workspaceProfile?.workflowStage, activatedSkillKeys: skillSession?.activatedKeys() ?? [] }) })
          }
        }
        if (resultSubmissionRequired) await record({ type: 'result_submission_required', turn: turns })
        if (eventSignal.aborted || controller.signal.aborted) agent?.abort()
      })
      controller.signal.addEventListener('abort', () => agent?.abort(), { once: true })
      await record({ type: 'runtime_initialized', turn: 0, framework: { name: 'pi-agent-core', version: piVersion } })
      await record({ type: 'input_package_built', turn: 0, content: JSON.stringify({ mode: inputPlan.mode, packageSha256: inputPlan.packageSha256, batches: inputPlan.batches.length, estimatedInputTokens: inputPlan.estimatedInputTokens, safeInputBudget: inputPlan.safeInputBudget }) })
      const current = inputPlan.batches[0]
      deliveryManifest!.entries.push(manifestEntry(current, 1))
      deliveryManifest!.finalMergeCompleted = true
      await record({ type: 'input_batch_delivered', turn: turns, content: JSON.stringify({ batchId: current.batchId, ordinal: current.ordinal, contentSha256: sha256(current.content), tokenCount: current.tokenCount }) })
      await agent.prompt(`${renderInitialTask(input)}\n\n${current.content}`)
      await agent.waitForIdle()
      if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('AGENT_CANCELLED')
      if (!candidate && latestModelFailure && !lastSubmissionIssues.length) throw modelProviderError(latestModelFailure)
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
          await record({ type: 'evidence_repair_tools_enabled', turn: turns, content: '原文定位未能建立 Evidence；继续使用 grep 定位并用 read 核对固定工作区文件，然后修正 sourceTexts。' })
        }
        const repairGuidance = stage.isGovernedCandidate
          ? '请严格按当前 Stage 的提交工具 Schema 和错误路径修正完整候选；不得修改服务端冻结的任务、证据范围或受保护业务语义。'
          : evidenceRepairRequired
          ? '工作区文件版本、内部证据范围、需求点 ID、Evidence ID、定位和引用均由服务端负责；请只修正需求点内部的 sourceTexts，必要时用 grep 定位后通过 read 核对原文。'
          : '正文投递覆盖、需求点 ID、Evidence ID 和 evidenceRefs 均由服务端负责；请按错误路径直接修正需求点内容，不要进行无关的 Evidence 补读。'
        await agent.prompt(`服务端拒绝了刚才的结果提交。以下问题必须先修复：\n${formatValidationIssues(lastSubmissionIssues)}\n${repairGuidance}\n然后通过 ${stage.submitPiName} 重新提交完整结果。`)
        await agent.waitForIdle()
      }
      if (!candidate) {
        await record({ type: 'result_submission_retry', turn: turns })
        forceResultSubmission = true
        const submissionPrompt = `现在进入结果提交阶段。不得继续返回普通文本或调用其他工具；请立即通过 ${stage.submitPiName} 提交完整的 ${stage.schemaVersion}。若参数校验失败，请按工具错误修正参数后再次提交。`
        const transientModelRetries = input.model.retryCount ?? TRANSIENT_MODEL_RETRIES
        for (let attempt = 0; attempt <= transientModelRetries && !candidate; attempt += 1) {
          if (attempt > 0) {
            const retryDelayMs = modelRetryDelay(this.bindings.retryBaseDelayMs ?? MODEL_RETRY_BASE_DELAY_MS, attempt)
            await record({ type: 'model_retry_scheduled', turn: turns, content: `模型服务临时不可用，${retryDelayMs}ms 后执行第 ${attempt}/${transientModelRetries} 次结果提交重试。` })
            await waitForRetry(retryDelayMs, controller.signal)
          }
          latestModelFailure = undefined
          await agent.prompt(attempt === 0 ? submissionPrompt : `模型服务上一次请求临时失败。${submissionPrompt}`)
          await agent.waitForIdle()
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
      if (!candidate && latestModelFailure) throw modelProviderError(latestModelFailure)
      if (!candidate) throw new Error(`MODEL_TOOL_CALL_REQUIRED: 模型未调用 ${stage.submitPiName}，实际工具调用能力不满足 ${stage.agentLabel}；请在模型管理中重新探测并选择通过工具调用检测的模型`)
      if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > limits.maxCandidateBytes) throw new Error('AGENT_RESULT_TOO_LARGE')
      return {
        candidate,
        events,
        turns,
        toolCalls: events.filter(event => event.type === 'tool_execution_start').length,
        toolErrors: events.filter(event => event.type === 'tool_execution_end' && event.isError).length,
        framework: { name: 'pi-agent-core', version: piVersion },
        ...(deliveryManifest ? { inputDeliveryManifest: deliveryManifest } : {}),
      }
    } finally {
      clearTimeout(deadline)
      signal.removeEventListener('abort', abort)
      if (agent?.state.isStreaming) agent.abort()
      await capabilityLoad.close()
      await piDocumentWorkspace?.dispose()
    }
  }

  private piTool(
    descriptor: ToolDescriptor,
    runtime: GovernedToolRuntime,
    input: AgentExecutionInput,
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
        const result = await runtime.execute({ toolId: descriptor.id, toolCallId, arguments: executionArguments, context: { snapshot: input.snapshot, allowedToolIds: runtimeAllowedToolIds(input) } }, AbortSignal.any([signal, toolSignal ?? signal]))
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

function runtimeAllowedToolIds(input: AgentExecutionInput) {
  const profile = required(input.executionProfile, 'WORKSPACE_EXECUTION_PROFILE_REQUIRED')
  return new Set(profile.allowedToolIds)
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
    isGovernedCandidate:
      input.snapshot.agentDefinition.agentKey
        !== 'requirement-analysis',
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

interface ModelFailure { kind: 'rate_limited' | 'authentication' | 'provider_unavailable' | 'request_failed'; retryable: boolean }

function modelFailure(message: AgentMessage): ModelFailure | undefined {
  const value = message as AgentMessage & { stopReason?: string; errorMessage?: string; content?: unknown }
  if (value.stopReason !== 'error') return undefined
  const detail = `${value.errorMessage ?? ''}\n${textFromContent(value.content)}`.toLocaleLowerCase()
  if (/\b429\b|rate[_ -]?limit|too_many_requests|exceeded rate limit/u.test(detail)) return { kind: 'rate_limited', retryable: true }
  if (/\b(?:401|403)\b|unauthori[sz]ed|authentication|invalid api key|api key.*invalid/u.test(detail)) return { kind: 'authentication', retryable: false }
  if (/\b5\d\d\b|timeout|timed out|econnreset|econnrefused|network|temporar(?:y|ily) unavailable/u.test(detail)) return { kind: 'provider_unavailable', retryable: true }
  return { kind: 'request_failed', retryable: false }
}

function modelProviderError(failure: ModelFailure, retries = 0) {
  if (failure.kind === 'rate_limited') return new Error(`MODEL_RATE_LIMITED: 模型服务触发限流（HTTP 429）${retries ? `，已自动重试 ${retries} 次` : ''}；请稍后重新评审或切换可用模型`)
  if (failure.kind === 'authentication') return new Error('MODEL_AUTHENTICATION_FAILED: 模型服务认证失败；请检查模型来源凭据后重新探测')
  if (failure.kind === 'provider_unavailable') return new Error(`MODEL_PROVIDER_UNAVAILABLE: 模型服务暂时不可用${retries ? `，已自动重试 ${retries} 次` : ''}；请稍后重新评审或切换可用模型`)
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

function createModel(input: AgentExecutionInput): Model<Api> {
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

function createStreamFn(input: AgentExecutionInput): StreamFn {
  return (input.model.providerType === 'anthropic' ? streamAnthropic : streamOpenAi) as StreamFn
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
