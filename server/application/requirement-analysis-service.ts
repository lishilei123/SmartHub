import { createHash, randomUUID } from 'node:crypto'
import type { AgentDefinitionResolver, AgentExecutionEvent, AgentExecutionOutput, AgentRuntime, ReviewRunSnapshot } from '../domain/agent-types.js'
import type { AgentExecutionRecord, ReviewRun } from '../domain/types.js'
import type { CandidateRequirementPointExtraction, CandidateRequirementReview } from '../domain/review-types.js'
import type { StateStore } from '../infrastructure/store.js'
import { RequirementPointExtractionValidator, RequirementReviewValidator, ReviewResultValidator } from '../agent/result-validator.js'
import { BuiltInAgentDefinitionResolver } from '../agent/requirement-analysis-agent.js'
import { buildRequirementInputPlan } from '../agent/requirement-context-assembler.js'

export interface RequirementAnalysisRequest {
  projectVersionId: string
  assetVersionIds?: string[]
  assetVersionId?: string
  sourceId: string
  modelId: string
  focusAreas?: string[]
  excludedAreas?: string[]
}

export class RequirementAnalysisService {
  private readonly validator: ReviewResultValidator
  private readonly extractionValidator: RequirementPointExtractionValidator
  private readonly reviewValidator = new RequirementReviewValidator()
  private readonly activeRuns = new Map<string, AbortController>()
  constructor(private readonly store: StateStore, private readonly runtime: AgentRuntime, private readonly definitions: AgentDefinitionResolver = new BuiltInAgentDefinitionResolver()) {
    this.validator = new ReviewResultValidator(store)
    this.extractionValidator = new RequirementPointExtractionValidator(store)
  }

  async recoverInterruptedRuns() {
    const finishedAt = new Date().toISOString()
    let recovered = 0
    await this.store.transaction(state => {
      state.reviewRuns.forEach(run => {
        if (run.status !== 'running') return
        recovered += 1
        Object.assign(run, {
          status: 'failed',
          step: 'failed',
          finishedAt,
          error: 'REVIEW_RUN_INTERRUPTED: 服务进程在 Agent 执行期间重启，本次运行已终止；请重新发起评审',
        } satisfies Partial<ReviewRun>)
      })
    })
    return recovered
  }

  async list(projectVersionId: string, options: { limit?: number; cursor?: string; runningOnly?: boolean } = {}) {
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 50)), 100)
    const projectVersion = this.store.getProjectVersion
      ? await this.store.getProjectVersion(projectVersionId)
      : (await this.store.snapshot()).projectVersions.find(item => item.id === projectVersionId)
    required(projectVersion, '项目版本不存在')

    if (this.store.listReviewRuns) {
      const page = await this.store.listReviewRuns(projectVersionId, { limit, cursor: options.cursor, runningOnly: options.runningOnly })
      return { items: page.items.map(presentRunSummary), nextCursor: page.nextCursor }
    }

    const state = await this.store.snapshot()
    const runs = state.reviewRuns
      .filter(item => item.projectVersionId === projectVersionId && (!options.runningOnly || item.status === 'running'))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    const offset = decodeCursor(options.cursor, runs)
    const items = runs.slice(offset, offset + limit)
    const last = items.at(-1)
    return { items: items.map(presentRunSummary), nextCursor: offset + limit < runs.length && last ? encodeCursor(last) : undefined }
  }

  async get(runId: string) {
    const run = this.store.getReviewRun
      ? await this.store.getReviewRun(runId)
      : (await this.store.snapshot()).reviewRuns.find(item => item.id === runId)
    return presentRun(required(run, '需求评审运行不存在'))
  }

  async start(request: RequirementAnalysisRequest) {
    const controller = new AbortController()
    let runId = ''
    return await new Promise<ReturnType<typeof presentRun>>((resolve, reject) => {
      void this.analyze(request, controller.signal, run => {
        runId = run.id
        this.activeRuns.set(runId, controller)
        resolve(run)
      }).catch(error => {
        if (!runId) reject(error)
      }).finally(() => {
        if (runId && this.activeRuns.get(runId) === controller) this.activeRuns.delete(runId)
      })
    })
  }

  async cancel(runId: string) {
    const state = await this.store.snapshot()
    const run = required(state.reviewRuns.find(item => item.id === runId), '需求评审运行不存在')
    if (run.status !== 'running') return presentRun(run)
    await this.store.transaction(draft => {
      const current = required(draft.reviewRuns.find(item => item.id === runId), '需求评审运行不存在')
      if (current.status === 'running') Object.assign(current, { status: 'cancelled', step: 'cancelled', finishedAt: new Date().toISOString(), error: '用户已取消本次评审' } satisfies Partial<ReviewRun>)
    })
    this.activeRuns.get(runId)?.abort(new Error('AGENT_CANCELLED_BY_USER'))
    return await this.get(runId)
  }

  async analyze(request: RequirementAnalysisRequest, signal = new AbortController().signal, onCreated?: (run: ReturnType<typeof presentRun>) => void) {
    const state = await this.store.snapshot()
    const projectVersion = required(state.projectVersions.find(item => item.id === request.projectVersionId), '项目版本不存在')
    if (projectVersion.status !== 'open') throw new Error('当前项目版本为只读状态，不能发起需求评审')
    const effectiveBindings = state.projectVersionRequirementBindings.filter(item => item.projectVersionId === projectVersion.id)
    const effectiveVersionIds = [...new Set(effectiveBindings.map(binding => binding.assetVersionId))]
    const requestedVersionIds = [...new Set([...(request.assetVersionIds ?? []), ...(request.assetVersionId ? [request.assetVersionId] : [])].map(item => String(item).trim()).filter(Boolean))]
    if (!requestedVersionIds.length) requestedVersionIds.push(...effectiveVersionIds)
    if (!requestedVersionIds.length) throw new Error('至少需要一份已绑定的需求文档')
    if (requestedVersionIds.length !== effectiveVersionIds.length || requestedVersionIds.some(versionId => !effectiveVersionIds.includes(versionId))) throw new Error('评审输入必须包含当前项目版本的全部有效需求绑定')
    const versions = requestedVersionIds.map(versionId => required(state.versions.find(item => item.id === versionId), `需求资产版本不存在：${versionId}`))
    if (versions.some(version => version.status !== 'ready')) throw new Error('存在尚未就绪的需求资产版本')
    const assets = versions.map(version => required(state.assets.find(item => item.id === version.assetId), '需求资产不存在'))
    if (assets.some(asset => asset.assetType !== 'requirement')) throw new Error('只有 requirement 类型资产可以发起需求评审')
    const knowledgeBaseIds = new Set(assets.map(asset => asset.knowledgeBaseId))
    if (knowledgeBaseIds.size !== 1) throw new Error('同一次评审的需求文档必须属于同一知识库')
    const knowledgeBase = required(state.knowledgeBases.find(item => item.id === assets[0].knowledgeBaseId), '知识库不存在')
    const project = required(state.projects.find(item => item.id === knowledgeBase.projectId), '项目不存在')
    if (projectVersion.projectId !== project.id) throw new Error('需求资产不属于当前项目版本')
    versions.forEach((version, index) => required(state.projectVersionRequirementBindings.find(item => item.projectVersionId === projectVersion.id && item.assetId === assets[index].id && item.assetVersionId === version.id), `需求资产版本未绑定到当前项目版本：${version.id}`))
    const index = required(state.indexes.find(item => item.id === knowledgeBase.activeIndexVersionId && item.status === 'active'), '知识库没有活动索引')
    if (versions.some(version => !index.assetVersionIds.includes(version.id))) throw new Error('存在不属于当前活动索引的需求资产版本')
    const source = required(state.modelSources.find(item => item.id === request.sourceId && item.enabled), '生成式模型来源不可用')
    const model = required(source.models.find(item => item.id === request.modelId && item.enabled), '生成式模型不可用')
    if (!model.capabilities.includes('tool_calling')) throw new Error('需求分析模型必须支持 tool_calling')
    if (model.health !== 'healthy') throw new Error('请先完成所选生成式模型的连通性探测并确保健康状态正常')
    const baseExtractionDefinition = await this.definitions.resolve('requirement-point-extraction')
    const reviewDefinition = await this.definitions.resolve('requirement-review')
    const extractionCoveragePlan = buildExtractionCoveragePlan(versions, request.excludedAreas)
    const extractionDefinition = baseExtractionDefinition
    const extractionToolBudget = { directoryCalls: 0, chunkCalls: 0, evidenceCalls: 0, submissionCalls: 3, minimumToolCalls: 3 }
    const requirementInputPlan = buildRequirementInputPlan({
      assets: assets.map((asset, position) => ({ asset, version: versions[position] })),
      coveragePlan: extractionCoveragePlan,
      definition: extractionDefinition,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
    })
    const now = new Date().toISOString()
    const snapshot: ReviewRunSnapshot = {
      runId: `review_run_${randomUUID()}`,
      projectId: project.id,
      projectName: project.name,
      projectVersionId: projectVersion.id,
      projectVersionName: projectVersion.name,
      knowledgeBaseId: knowledgeBase.id,
      assetId: assets[0].id,
      assetVersionId: versions[0].id,
      assetContentHash: versions[0].contentHash,
      indexVersionId: index.id,
      logicalPath: assets[0].logicalPath,
      assets: assets.map((asset, position) => ({ assetId: asset.id, assetVersionId: versions[position].id, assetContentHash: versions[position].contentHash, logicalPath: asset.logicalPath, displayName: asset.displayName })),
      modelRef: { sourceId: source.id, modelId: model.id, providerType: source.providerType, modelName: model.name, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens, supportsReasoning: model.capabilities.includes('reasoning') },
      focusAreas: cleanList(request.focusAreas),
      excludedAreas: cleanList(request.excludedAreas),
      agentDefinition: extractionDefinition,
      agentDefinitions: { requirementPointExtraction: extractionDefinition, requirementReview: reviewDefinition },
      extractionCoveragePlan,
      extractionToolBudget,
      extractionInput: {
        policyVersion: requirementInputPlan.policyVersion,
        mode: requirementInputPlan.mode,
        estimatedInputTokens: requirementInputPlan.estimatedInputTokens,
        safeInputBudget: requirementInputPlan.safeInputBudget,
        packageSha256: requirementInputPlan.packageSha256,
        batches: requirementInputPlan.batches.map(batch => ({
          batchId: batch.batchId, ordinal: batch.ordinal, tokenCount: batch.tokenCount,
          contentSha256: createHash('sha256').update(batch.content).digest('hex'),
          assetVersionIds: [...batch.assetVersionIds], chunkIds: [...batch.chunkIds],
        })),
      },
      createdAt: now,
    }
    const run: ReviewRun = {
      id: snapshot.runId,
      projectVersionId: projectVersion.id,
      assetId: assets[0].id,
      assetVersionId: versions[0].id,
      documentTitle: `${assets.length} 份需求文档`,
      documentVersion: versions[0].number,
      logicalPath: assets.map(asset => asset.logicalPath).join('；'),
      sourceId: source.id,
      modelId: model.id,
      modelLabel: `${source.name} · ${model.displayName}`,
      status: 'running',
      step: 'extracting_requirement_points',
      progress: 10,
      createdAt: now,
      startedAt: now,
      snapshot,
    }
    await this.store.transaction(draft => { draft.reviewRuns.push(run) })
    onCreated?.(presentRun(run))
    const extractionEvents: AgentExecutionEvent[] = []
    const reviewEvents: AgentExecutionEvent[] = []
    let activeAgentKey: 'requirement-point-extraction' | 'requirement-review' = 'requirement-point-extraction'
    const modelConnection = { sourceId: source.id, providerType: source.providerType, baseUrl: source.baseUrl, apiKey: source.apiKey, modelId: model.id, modelName: model.name, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens, supportsReasoning: model.capabilities.includes('reasoning') }
    try {
      const extractionOutput = await this.runtime.execute({
        snapshot,
        model: modelConnection,
        requirementInputPlan,
        onEvent: async event => {
          extractionEvents.push(event)
          if (shouldCheckpointExecution(event)) await this.saveExecutionProgress(run.id, extractionEvents, 'requirement-point-extraction')
        },
      }, signal)
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('AGENT_CANCELLED')
      const extraction = extractionOutput.candidate as CandidateRequirementPointExtraction
      const extractionValidation = await this.extractionValidator.validate(extraction, snapshot, extractionOutput.inputDeliveryManifest)
      if (!extractionValidation.valid) throw validationError(extractionValidation.issues)
      const extractionExecution = executionRecord(extractionOutput, 'requirement-point-extraction')
      await this.store.transaction(draft => {
        const current = required(draft.reviewRuns.find(item => item.id === run.id), '需求评审运行不存在')
        current.extractionResult = structuredClone(extraction)
        current.inputDeliveryManifest = structuredClone(required(extractionOutput.inputDeliveryManifest, '输入投递证明不存在'))
        current.executions = { ...(current.executions ?? {}), requirementPointExtraction: extractionExecution }
        current.execution = extractionExecution
        current.step = 'reviewing_requirements'
        current.progress = 60
      })

      activeAgentKey = 'requirement-review'
      const reviewSnapshot = { ...snapshot, agentDefinition: reviewDefinition }
      const reviewOutput = await this.runtime.execute({
        snapshot: reviewSnapshot,
        model: modelConnection,
        fixedRequirementPointExtraction: extraction,
        onEvent: async event => {
          reviewEvents.push(event)
          if (shouldCheckpointExecution(event)) await this.saveExecutionProgress(run.id, reviewEvents, 'requirement-review')
        },
      }, signal)
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('AGENT_CANCELLED')
      const review = reviewOutput.candidate as CandidateRequirementReview
      const reviewValidation = await this.reviewValidator.validate(review, extraction, reviewSnapshot)
      if (!reviewValidation.valid) throw validationError(reviewValidation.issues)
      const result = { ...structuredClone(extraction), ...structuredClone(review) }
      const validation = await this.validator.validate(result, reviewSnapshot)
      if (!validation.valid) throw validationError(validation.issues)
      const reviewExecution = executionRecord(reviewOutput, 'requirement-review')
      const finishedAt = new Date().toISOString()
      await this.store.transaction(draft => {
        const current = required(draft.reviewRuns.find(item => item.id === run.id), '需求评审运行不存在')
        Object.assign(current, {
          status: 'succeeded', step: 'completed', progress: 100, finishedAt, extractionResult: extraction, result,
          execution: undefined,
          executions: { requirementPointExtraction: extractionExecution, requirementReview: reviewExecution }, error: undefined,
        } satisfies Partial<ReviewRun>)
      })
      const completed = await this.get(run.id)
      return required(completed.response, '需求评审结果不存在')
    } catch (error) {
      const message = sanitizeRuntimeError(error, source.baseUrl, source.apiKey)
      const status = signal.aborted || /AGENT_CANCELLED|客户端已中断/u.test(message) ? 'cancelled' : 'failed'
      await this.store.transaction(draft => {
        const current = required(draft.reviewRuns.find(item => item.id === run.id), '需求评审运行不存在')
        Object.assign(current, {
          status, step: status === 'cancelled' ? 'cancelled' : 'failed', progress: current.progress, finishedAt: new Date().toISOString(), error: message,
          ...(activeAgentKey === 'requirement-point-extraction' && extractionEvents.length ? { execution: executionProgress(extractionEvents, activeAgentKey) } : {}),
          ...(activeAgentKey === 'requirement-review' && reviewEvents.length ? { execution: executionProgress(reviewEvents, activeAgentKey) } : {}),
        } satisfies Partial<ReviewRun>)
        if (message.startsWith('MODEL_TOOL_CALL_REQUIRED:')) {
          const currentSource = draft.modelSources.find(item => item.id === source.id)
          const currentModel = currentSource?.models.find(item => item.id === model.id)
          if (currentSource && currentModel) {
            const checkedAt = new Date().toISOString()
            currentModel.health = 'degraded'
            currentModel.lastCheckedAt = checkedAt
            currentModel.healthMessage = '需求评审兼容性验证失败：未能提交结构化评审结果'
            currentSource.health = 'degraded'
            currentSource.healthMessage = currentModel.healthMessage
            currentSource.lastCheckedAt = checkedAt
            currentSource.updatedAt = checkedAt
          }
        }
      })
      throw new Error(message)
    }
  }

  private async saveExecutionProgress(runId: string, events: AgentExecutionEvent[], agentKey: 'requirement-point-extraction' | 'requirement-review') {
    const execution = executionProgress(events, agentKey)
    if (this.store.saveReviewRunExecution) return this.store.saveReviewRunExecution(runId, execution)
    await this.store.transaction(draft => {
      const current = required(draft.reviewRuns.find(item => item.id === runId), '需求评审运行不存在')
      current.execution = execution
    })
  }
}

function presentRunSummary(run: ReviewRun) {
  const assets = snapshotAssets(run)
  return {
    id: run.id,
    runId: run.id,
    projectVersionId: run.projectVersionId,
    assetId: run.assetId,
    assetVersionId: run.assetVersionId,
    assetIds: assets.map(asset => asset.assetId),
    assetVersionIds: assets.map(asset => asset.assetVersionId),
    documents: assets,
    documentTitle: run.documentTitle,
    documentVersion: `V${run.documentVersion}`,
    logicalPath: run.logicalPath,
    modelLabel: run.modelLabel,
    status: run.status,
    step: run.step,
    progress: run.progress,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: presentedRunError(run),
    snapshot: redactSnapshot(run.snapshot),
  }
}

function presentRun(run: ReviewRun) {
  const assets = snapshotAssets(run)
  const response = run.result && (run.executions || run.execution) ? {
    runId: run.id,
    status: 'candidate_validated' as const,
    snapshot: redactSnapshot(run.snapshot),
    result: run.result,
    ...(run.inputDeliveryManifest ? { inputDeliveryManifest: run.inputDeliveryManifest } : {}),
    ...(run.execution ? { execution: run.execution } : {}),
    ...(run.executions ? { executions: run.executions } : {}),
  } : undefined
  return {
    id: run.id,
    runId: run.id,
    projectVersionId: run.projectVersionId,
    assetId: run.assetId,
    assetVersionId: run.assetVersionId,
    assetIds: assets.map(asset => asset.assetId),
    assetVersionIds: assets.map(asset => asset.assetVersionId),
    documents: assets,
    documentTitle: run.documentTitle,
    documentVersion: `V${run.documentVersion}`,
    logicalPath: run.logicalPath,
    modelLabel: run.modelLabel,
    status: run.status,
    step: run.step,
    progress: run.progress,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: presentedRunError(run),
    snapshot: redactSnapshot(run.snapshot),
    execution: response ? undefined : run.execution,
    executions: response ? undefined : run.executions,
    extractionResult: response ? undefined : run.extractionResult,
    inputDeliveryManifest: response ? undefined : run.inputDeliveryManifest,
    response,
  }
}

function redactSnapshot(snapshot: ReviewRun['snapshot']) {
  const definition = snapshot.agentDefinition
  const definitions = snapshot.agentDefinitions
  return {
    ...snapshot,
    assets: snapshot.assets ?? [{ assetId: snapshot.assetId, assetVersionId: snapshot.assetVersionId, assetContentHash: snapshot.assetContentHash, logicalPath: snapshot.logicalPath, displayName: snapshot.logicalPath }],
    agentDefinition: { ...definition, systemPrompt: undefined, taskTemplate: undefined },
    ...(definitions ? { agentDefinitions: {
      requirementPointExtraction: { ...definitions.requirementPointExtraction, systemPrompt: undefined, taskTemplate: undefined },
      requirementReview: { ...definitions.requirementReview, systemPrompt: undefined, taskTemplate: undefined },
    } } : {}),
  }
}

function snapshotAssets(run: ReviewRun) {
  return run.snapshot.assets ?? [{ assetId: run.assetId, assetVersionId: run.assetVersionId, assetContentHash: run.snapshot.assetContentHash, logicalPath: run.logicalPath, displayName: run.documentTitle }]
}

function presentedRunError(run: ReviewRun) {
  if (!run.error?.startsWith('MODEL_TOOL_CALL_REQUIRED:')) return run.error
  const savedEvents = [
    ...(run.executions?.requirementPointExtraction?.events ?? []),
    ...(run.executions?.requirementReview?.events ?? []),
    ...(run.execution?.events ?? []),
  ]
  const lastAssistantError = [...savedEvents].reverse().find(event => event.type === 'message_end' && event.role === 'assistant' && event.stopReason === 'error')
  const detail = lastAssistantError?.content?.toLocaleLowerCase() ?? ''
  if (/\b429\b|rate[_ -]?limit|too_many_requests|exceeded rate limit/u.test(detail)) return 'MODEL_RATE_LIMITED: 模型服务触发限流（HTTP 429）；该历史运行已根据保存的供应商错误记录校正展示'
  if (/\b(?:401|403)\b|unauthori[sz]ed|authentication|invalid api key|api key.*invalid/u.test(detail)) return 'MODEL_AUTHENTICATION_FAILED: 模型服务认证失败；该历史运行已根据保存的供应商错误记录校正展示'
  if (lastAssistantError) return 'MODEL_REQUEST_FAILED: 模型请求失败；该历史运行已根据保存的供应商错误记录校正展示'
  return run.error
}

function encodeCursor(run: ReviewRun) { return Buffer.from(JSON.stringify([run.createdAt, run.id])).toString('base64url') }
function decodeCursor(cursor: string | undefined, runs: ReviewRun[]) {
  if (!cursor) return 0
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[]
    if (typeof createdAt !== 'string' || typeof id !== 'string') throw new Error('invalid')
    const index = runs.findIndex(run => run.createdAt === createdAt && run.id === id)
    if (index < 0) throw new Error('invalid')
    return index + 1
  } catch {
    throw new Error('评审历史游标无效')
  }
}
function buildExtractionCoveragePlan(versions: Array<{ id: string; chunks: Array<{ id: string; contentHash: string; headingPath: string[]; startLine: number; endLine: number }> }>, excludedAreas: string[] | undefined) {
  const excluded = cleanList(excludedAreas).map(value => value.toLocaleLowerCase())
  return versions.map(version => ({
    assetVersionId: version.id,
    chunks: version.chunks.map(chunk => {
      const heading = chunk.headingPath.join(' / ')
      const excludedReason = excluded.find(area => heading.toLocaleLowerCase().includes(area))
      return { chunkId: chunk.id, contentHash: chunk.contentHash, headingPath: chunk.headingPath, startLine: chunk.startLine, endLine: chunk.endLine, ...(excludedReason ? { excludedReason: `用户排除范围：${excludedReason}` } : {}) }
    }),
  }))
}

function required<T>(value: T | undefined | null, message: string): T { if (value == null) throw new Error(message); return value }
function cleanList(value: string[] | undefined) { return Array.isArray(value) ? [...new Set(value.map(item => String(item).trim()).filter(Boolean))].slice(0, 20) : [] }
function shouldCheckpointExecution(event: AgentExecutionEvent) { return ['tool_execution_end', 'turn_end', 'agent_end', 'result_submission_required', 'result_submission_retry', 'input_package_built', 'input_batch_delivered', 'input_final_merge_started'].includes(event.type) }
function executionProgress(events: AgentExecutionEvent[], agentKey?: AgentExecutionRecord['agentKey']): AgentExecutionRecord {
  const framework = events.find(event => event.framework)?.framework
  return {
    ...(agentKey ? { agentKey } : {}),
    turns: events.reduce((maximum, event) => Math.max(maximum, event.turn ?? 0), 0),
    toolCalls: events.filter(event => event.type === 'tool_execution_start').length,
    toolErrors: events.filter(event => event.type === 'tool_execution_end' && event.isError).length,
    ...(framework ? { framework } : {}),
    events: structuredClone(events),
  }
}
function executionRecord(output: AgentExecutionOutput, agentKey: 'requirement-point-extraction' | 'requirement-review'): AgentExecutionRecord {
  return { agentKey, turns: output.turns, toolCalls: output.toolCalls, toolErrors: output.toolErrors, framework: output.framework, events: output.events }
}
function validationError(issues: Array<{ path: string; message: string }>) {
  const visible = issues.slice(0, 6).map(issue => `${issue.path} ${issue.message}`).join('；')
  return new Error(`AGENT_RESULT_VALIDATION_FAILED: ${visible}${issues.length > 6 ? `；另有 ${issues.length - 6} 项，请查看结果校验事件` : ''}`)
}
function sanitizeRuntimeError(error: unknown, endpoint: string, credential: string) {
  let message = error instanceof Error ? error.message : '需求分析 Agent 执行失败'
  if (credential) message = message.replaceAll(credential, '[已隐藏凭据]')
  if (endpoint) message = message.replaceAll(endpoint, '[模型端点]')
  return message.replace(/https?:\/\/[^\s'"`]+/giu, '[已隐藏地址]').slice(0, 500)
}
