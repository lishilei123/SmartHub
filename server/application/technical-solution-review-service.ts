import { createHash, randomUUID } from 'node:crypto'
import type { AgentDefinitionResolver, AgentExecutionEvent, AgentExecutionOutput, AgentRuntime, ReviewRunSnapshot } from '../domain/agent-types.js'
import type { Principal } from '../domain/access-control.js'
import type { TechnicalSolutionExtractionResult, TechnicalSolutionFindingAction, TechnicalSolutionFormalResult, TechnicalSolutionReview, TechnicalSolutionReviewRun, TechnicalSolutionRunSnapshot } from '../domain/technical-solution-types.js'
import type { AgentConfigurationVersion, DatabaseState, FindingActionType, FindingState, ReviewRun } from '../domain/types.js'
import type { StateStore, TaskLease } from '../infrastructure/store.js'
import { buildTechnicalSolutionInputPlan } from '../agent/technical-solution-context-assembler.js'

const transitions: Record<FindingActionType, FindingState> = { confirm: 'confirmed', dismiss: 'dismissed', resolve: 'resolved', request_follow_up: 'needs_follow_up', reopen: 'open' }

export class TechnicalSolutionReviewService {
  private readonly activeRuns = new Map<string, AbortController>()
  constructor(private readonly store: StateStore, private readonly runtime: AgentRuntime, private readonly definitions: AgentDefinitionResolver) {}

  async inputCandidates(projectVersionId: string) {
    const state = this.store.loadTechnicalSolutionInputState ? await this.store.loadTechnicalSolutionInputState(projectVersionId) : await this.store.snapshot()
    const projectVersion = required(state.projectVersions.find(item => item.id === projectVersionId), 'PROJECT_VERSION_NOT_FOUND: 项目版本不存在')
    const projectBases = state.knowledgeBases.filter(item => item.projectId === projectVersion.projectId)
    const baselines = state.reviewRuns.filter(item => item.projectVersionId === projectVersionId && item.status === 'succeeded' && item.result).sort(byNewest).map(run => ({ id: run.id, reviewId: run.reviewId ?? run.id, completedAt: run.finishedAt, requirementCount: run.result!.requirementPoints.length, documentTitle: run.documentTitle, unresolvedHighCount: unresolvedHighCount(run, state), resultSchemaVersions: { extraction: 'requirement-point-extraction/v5', review: 'requirement-review/v3' } }))
    const solutionAssets = projectBases.flatMap(base => {
      const index = state.indexes.find(item => item.id === base.activeIndexVersionId && item.status === 'active')
      if (!index) return []
      return state.assets.filter(asset => asset.knowledgeBaseId === base.id && asset.assetType === 'technical_design').flatMap(asset => {
        const version = state.versions.find(item => item.id === asset.activeVersionId && item.status === 'ready' && index.assetVersionIds.includes(item.id))
        return version ? [{ assetId: asset.id, assetVersionId: version.id, displayName: asset.displayName, logicalPath: asset.logicalPath, version: version.number, contentSha256: version.contentHash, indexVersionId: index.id }] : []
      })
    })
    const [extractionConfiguration, reviewConfiguration] = this.definitions.resolveActive ? await Promise.all([this.definitions.resolveActive('technical-solution-extraction'), this.definitions.resolveActive('technical-solution-review')]) : [null, null]
    const presentConfiguration = (configuration: AgentConfigurationVersion | null) => configuration ? { id: configuration.id, version: configuration.version, contentSha256: configuration.contentSha256, toolIds: configuration.agentDefinition.toolIds, primaryModel: configuration.routing.primaryModel } : null
    return { projectVersion: { id: projectVersion.id, name: projectVersion.name, status: projectVersion.status }, baselines, solutionAssets, agentConfigurations: { extraction: presentConfiguration(extractionConfiguration), review: presentConfiguration(reviewConfiguration) }, agentConfiguration: extractionConfiguration && reviewConfiguration ? presentConfiguration(reviewConfiguration) : null }
  }

  async createReview(projectVersionId: string, input: { name: string; sourceReviewRunId: string; solutionAssetVersionIds: string[]; principal?: Principal }) {
    const state = await this.store.snapshot()
    const projectVersion = required(state.projectVersions.find(item => item.id === projectVersionId), 'PROJECT_VERSION_NOT_FOUND: 项目版本不存在')
    if (projectVersion.status !== 'open') throw new Error('PROJECT_VERSION_READ_ONLY: 当前项目版本只读，不能创建技术方案评审')
    validateReviewInputs(state, projectVersionId, input.sourceReviewRunId, input.solutionAssetVersionIds)
    const solutionIds = unique(input.solutionAssetVersionIds)
    const name = cleanRequired(input.name, '技术方案评审名称', 200)
    const createdAt = new Date().toISOString()
    const review: TechnicalSolutionReview = { id: `technical_review_${randomUUID()}`, projectVersionId, name, sourceReviewRunId: input.sourceReviewRunId, solutionAssetVersionIds: solutionIds, inputSetSha256: sha256(stableStringify([input.sourceReviewRunId, ...solutionIds])), createdBy: principalId(input.principal), createdAt }
    await this.store.transaction(draft => { draft.technicalSolutionReviews.push(review) })
    return structuredClone(review)
  }

  async listReviews(projectVersionId: string) {
    const reviews = this.store.listTechnicalSolutionReviews ? await this.store.listTechnicalSolutionReviews(projectVersionId) : (await this.store.snapshot()).technicalSolutionReviews.filter(item => item.projectVersionId === projectVersionId).sort(byNewest)
    const runs = this.store.listTechnicalSolutionRuns ? await this.store.listTechnicalSolutionRuns(projectVersionId) : (await this.store.snapshot()).technicalSolutionRuns.filter(item => item.projectVersionId === projectVersionId)
    return reviews.map(review => ({ ...review, latestRun: runs.filter(run => run.technicalReviewId === review.id).sort(byNewest)[0] ? presentRunSummary(runs.filter(run => run.technicalReviewId === review.id).sort(byNewest)[0]) : null }))
  }

  async getReview(projectVersionId: string, technicalReviewId: string) {
    const review = this.store.getTechnicalSolutionReview ? await this.store.getTechnicalSolutionReview(technicalReviewId) : (await this.store.snapshot()).technicalSolutionReviews.find(item => item.id === technicalReviewId)
    if (!review || review.projectVersionId !== projectVersionId) throw new Error('TECH_REVIEW_NOT_FOUND: 技术方案评审不存在')
    return structuredClone(review)
  }

  async createRun(projectVersionId: string, technicalReviewId: string) {
    const state = await this.store.snapshot()
    const projectVersion = required(state.projectVersions.find(item => item.id === projectVersionId), 'PROJECT_VERSION_NOT_FOUND: 项目版本不存在')
    if (projectVersion.status !== 'open') throw new Error('PROJECT_VERSION_READ_ONLY: 当前项目版本只读，不能运行技术方案评审')
    const review = required(state.technicalSolutionReviews.find(item => item.id === technicalReviewId && item.projectVersionId === projectVersionId), 'TECH_REVIEW_NOT_FOUND: 技术方案评审不存在')
    const { baselineRun, solutionAssets, solutionVersions, knowledgeBase, index, project } = validateReviewInputs(state, projectVersionId, review.sourceReviewRunId, review.solutionAssetVersionIds)
    const [extractionConfiguration, reviewConfiguration] = this.definitions.resolveActive ? await Promise.all([this.definitions.resolveActive('technical-solution-extraction'), this.definitions.resolveActive('technical-solution-review')]) : [null, null]
    if (!extractionConfiguration || !reviewConfiguration) throw new Error('TECH_AGENT_CONFIGURATION_UNAVAILABLE: 请先分别发布技术方案提取 Agent 和技术方案评审 Agent 配置')
    const extractionRoute = selectModelRoute(state, extractionConfiguration)
    const reviewRoute = selectModelRoute(state, reviewConfiguration)
    const selection = extractionRoute[0]
    const reviewSelection = reviewRoute[0]
    const extractionDefinition = extractionConfiguration.agentDefinition
    const reviewDefinition = reviewConfiguration.agentDefinition
    if (extractionDefinition.agentKey !== 'technical-solution-extraction' || extractionDefinition.resultSchemaVersion !== 'technical-solution-extraction/v1' || reviewDefinition.agentKey !== 'technical-solution-review' || reviewDefinition.resultSchemaVersion !== 'technical-solution-review/v2') throw new Error('TECH_AGENT_CONFIGURATION_UNAVAILABLE: 已发布双阶段配置协议不匹配')
    const effectiveMaxOutput = Math.min(selection.model.maxOutputTokens, extractionConfiguration.routing.maxOutputTokens)
    const inputPlan = buildTechnicalSolutionInputPlan({ assets: solutionAssets.map((asset, index) => ({ asset, version: solutionVersions[index] })), definition: extractionDefinition, contextWindow: selection.model.contextWindow, maxOutputTokens: effectiveMaxOutput })
    const baseline = freezeBaseline(baselineRun, state)
    const now = new Date().toISOString()
    const runId = `technical_run_${randomUUID()}`
    const snapshot: TechnicalSolutionRunSnapshot = {
      schemaVersion: 'technical-solution-run-snapshot/v2', runId, technicalReviewId, projectId: project.id, projectName: project.name, projectVersionId, projectVersionName: projectVersion.name, knowledgeBaseId: knowledgeBase.id,
      requirementBaseline: baseline,
      solutionInputs: solutionAssets.map((asset, position) => ({ assetId: asset.id, assetVersionId: solutionVersions[position].id, assetType: 'technical_design', displayName: asset.displayName, logicalPath: asset.logicalPath, contentSha256: solutionVersions[position].contentHash })),
      assets: [...baselineRun.snapshot.assets.map(item => ({ ...item })), ...solutionAssets.map((asset, position) => ({ assetId: asset.id, assetVersionId: solutionVersions[position].id, assetContentHash: solutionVersions[position].contentHash, logicalPath: asset.logicalPath, displayName: asset.displayName }))],
      indexVersionId: index.id,
      modelRef: { sourceId: selection.source.id, providerType: selection.source.providerType, modelId: selection.model.id, modelName: selection.model.name, contextWindow: selection.model.contextWindow, maxOutputTokens: effectiveMaxOutput, supportsReasoning: selection.model.capabilities.includes('reasoning') },
      agentModelRefs: {
        technicalSolutionExtraction: modelSnapshot(selection, extractionConfiguration),
        technicalSolutionReview: modelSnapshot(reviewSelection, reviewConfiguration),
      },
      modelRoute: extractionRoute.map(item => modelSnapshot(item, extractionConfiguration)),
      agentModelRoutes: { technicalSolutionExtraction: extractionRoute.map(item => modelSnapshot(item, extractionConfiguration)), technicalSolutionReview: reviewRoute.map(item => modelSnapshot(item, reviewConfiguration)) },
      agentConfigurationRef: { id: extractionConfiguration.id, version: extractionConfiguration.version, contentSha256: extractionConfiguration.contentSha256 },
      agentConfigurationRefs: { technicalSolutionExtraction: { id: extractionConfiguration.id, version: extractionConfiguration.version, contentSha256: extractionConfiguration.contentSha256 }, technicalSolutionReview: { id: reviewConfiguration.id, version: reviewConfiguration.version, contentSha256: reviewConfiguration.contentSha256 } },
      agentDefinition: structuredClone(extractionDefinition), agentDefinitions: { technicalSolutionExtraction: structuredClone(extractionDefinition), technicalSolutionReview: structuredClone(reviewDefinition) }, inputPlan, createdAt: now,
    }
    const snapshotSha256 = sha256(stableStringify(snapshot))
    const queued = Boolean(this.store.enqueueTechnicalSolutionJob)
    const run: TechnicalSolutionReviewRun = { id: runId, technicalReviewId, projectVersionId, sourceReviewRunId: review.sourceReviewRunId, status: queued ? 'queued' : 'running', step: queued ? 'waiting_worker' : 'validating_input', progress: queued ? 1 : 5, snapshotSha256, snapshot, modelLabel: `${selection.source.name} · ${selection.model.displayName} / ${reviewSelection.source.name} · ${reviewSelection.model.displayName}`, createdAt: now, ...(queued ? {} : { startedAt: now }) }
    await this.store.transaction(draft => { if (draft.technicalSolutionRuns.some(item => item.projectVersionId === projectVersionId && ['queued', 'running'].includes(item.status))) { const active = draft.technicalSolutionRuns.filter(item => item.projectVersionId === projectVersionId && ['queued', 'running'].includes(item.status)); if (active.length >= 2) throw new Error('TECH_ACTIVE_RUN_LIMIT_EXCEEDED: 当前项目版本已有 2 个技术方案评审运行') } draft.technicalSolutionRuns.push(run) })
    if (queued) {
      await this.store.enqueueTechnicalSolutionJob!({ id: `technical_job_${randomUUID()}`, runId, technicalReviewId, projectVersionId, status: 'queued', attempts: 0, maxAttempts: 3, availableAt: now, createdAt: now, updatedAt: now })
    } else {
      const controller = new AbortController()
      this.activeRuns.set(runId, controller)
      void this.processPreparedRun(runId, undefined, controller.signal).catch(() => undefined).finally(() => this.activeRuns.delete(runId))
    }
    return presentRun(run)
  }

  async listRuns(projectVersionId: string, technicalReviewId: string) {
    await this.getReview(projectVersionId, technicalReviewId)
    const runs = this.store.listTechnicalSolutionRuns ? await this.store.listTechnicalSolutionRuns(projectVersionId, technicalReviewId) : (await this.store.snapshot()).technicalSolutionRuns.filter(item => item.projectVersionId === projectVersionId && item.technicalReviewId === technicalReviewId).sort(byNewest)
    return { items: runs.map(presentRunSummary) }
  }

  async getRun(projectVersionId: string, technicalReviewId: string, runId: string) {
    const run = await this.loadRun(runId)
    scopeRun(run, projectVersionId, technicalReviewId)
    return presentRun(run)
  }

  async cancelRun(projectVersionId: string, technicalReviewId: string, runId: string) {
    const run = await this.loadRun(runId)
    scopeRun(run, projectVersionId, technicalReviewId)
    if (!['queued', 'running'].includes(run.status)) return presentRun(run)
    await this.store.cancelTechnicalSolutionJob?.(runId)
    await this.store.transaction(state => { const current = required(state.technicalSolutionRuns.find(item => item.id === runId), 'TECH_RUN_NOT_FOUND'); if (['queued', 'running'].includes(current.status)) Object.assign(current, { status: 'cancelled', step: 'cancelled', finishedAt: new Date().toISOString(), errorCode: 'TECH_RUN_CANCELLED', error: '用户已取消技术方案评审' }) })
    this.activeRuns.get(runId)?.abort(new Error('TECH_RUN_CANCELLED'))
    return this.getRun(projectVersionId, technicalReviewId, runId)
  }

  async processPreparedRun(runId: string, lease?: TaskLease, signal = new AbortController().signal, infrastructureAttempt = 1) {
    const stored = await this.loadRun(runId)
    if (stored.status === 'cancelled') throw new Error('TECH_RUN_CANCELLED')
    const state = await this.store.snapshot()
    const [extractionConfiguration, reviewConfiguration] = await Promise.all([
      resolveFrozenConfiguration(this.definitions, 'technical-solution-extraction', stored.snapshot.agentConfigurationRefs?.technicalSolutionExtraction ?? stored.snapshot.agentConfigurationRef),
      resolveFrozenConfiguration(this.definitions, 'technical-solution-review', stored.snapshot.agentConfigurationRefs?.technicalSolutionReview),
    ])
    required(extractionConfiguration, 'TECH_AGENT_CONFIGURATION_UNAVAILABLE')
    required(reviewConfiguration, 'TECH_AGENT_CONFIGURATION_UNAVAILABLE')
    const extractionRoute = stored.snapshot.agentModelRoutes?.technicalSolutionExtraction ?? stored.snapshot.modelRoute ?? [stored.snapshot.modelRef]
    const reviewRoute = stored.snapshot.agentModelRoutes?.technicalSolutionReview ?? [stored.snapshot.agentModelRefs?.technicalSolutionReview ?? stored.snapshot.modelRef]
    const extractionModelRef = extractionRoute[Math.min(Math.max(1, infrastructureAttempt) - 1, extractionRoute.length - 1)]
    const reviewModelRef = reviewRoute[Math.min(Math.max(1, infrastructureAttempt) - 1, reviewRoute.length - 1)]
    const extractionSelection = selectSpecificModel(state, extractionModelRef.sourceId, extractionModelRef.modelId)
    const extractionConnection = runtimeConnection(extractionModelRef, extractionSelection, extractionConfiguration!)
    const reviewSelection = selectSpecificModel(state, reviewModelRef.sourceId, reviewModelRef.modelId)
    const reviewConnection = runtimeConnection(reviewModelRef, reviewSelection, reviewConfiguration!)
    const attemptId = `technical_attempt_${Math.max(1, infrastructureAttempt)}`
    const attemptStartedAt = new Date().toISOString()
    await this.runTransaction(runId, lease, draft => { const run = required(draft.technicalSolutionRuns.find(item => item.id === runId), 'TECH_RUN_NOT_FOUND'); const attempts = run.modelRouteAttempts ?? []; const current = { id: attemptId, attempt: Math.max(1, infrastructureAttempt), sourceId: extractionModelRef.sourceId, modelId: extractionModelRef.modelId, modelLabel: `${extractionSelection.source.name} · ${extractionSelection.model.displayName} / ${reviewSelection.source.name} · ${reviewSelection.model.displayName}`, status: 'running' as const, startedAt: attemptStartedAt }; const previous = attempts.findIndex(item => item.id === attemptId); if (previous >= 0) attempts[previous] = current; else attempts.push(current); const degradations = run.degradations ?? []; if ((extractionModelRef.sourceId !== extractionRoute[0].sourceId || extractionModelRef.modelId !== extractionRoute[0].modelId) && !degradations.some(item => item.toSourceId === extractionModelRef.sourceId && item.toModelId === extractionModelRef.modelId)) degradations.push({ fromSourceId: extractionRoute[0].sourceId, fromModelId: extractionRoute[0].modelId, toSourceId: extractionModelRef.sourceId, toModelId: extractionModelRef.modelId, reason: 'Provider 暂时错误后按已发布路由切换候选模型', occurredAt: attemptStartedAt }); Object.assign(run, { status: 'running', step: run.extractionResult ? 'reviewing_solution' : 'extracting_solution_points', progress: run.extractionResult ? 62 : 15, startedAt: run.startedAt ?? attemptStartedAt, modelLabel: current.modelLabel, modelRouteAttempts: attempts, degradations, error: undefined, errorCode: undefined }) })
    let activeAgentKey: 'technical-solution-extraction' | 'technical-solution-review' = stored.extractionResult ? 'technical-solution-review' : 'technical-solution-extraction'
    const extractionEvents: AgentExecutionEvent[] = []
    const reviewEvents: AgentExecutionEvent[] = []
    try {
      let extractionResult = stored.extractionResult
      let extractionOutput: AgentExecutionOutput | undefined
      if (!extractionResult) {
        const extractionSnapshot = stageSnapshot(stored.snapshot, 'technical-solution-extraction')
        extractionOutput = await this.runtime.execute({ snapshot: extractionSnapshot, model: extractionConnection, requirementInputPlan: stored.snapshot.inputPlan, onEvent: async event => { extractionEvents.push(event); if (checkpoint(event)) await this.saveProgress(runId, lease, extractionEvents, progressForEvent(event, 'technical-solution-extraction'), 'technical-solution-extraction') } }, signal)
        if (!extractionOutput.inputDeliveryManifest?.finalMergeCompleted || extractionOutput.inputDeliveryManifest.entries.length !== stored.snapshot.inputPlan.batches.length) throw new Error('TECH_INPUT_DELIVERY_INCOMPLETE: 固定正文投递证明不完整')
        extractionResult = extractionOutput.candidate as TechnicalSolutionExtractionResult
        if (extractionResult.schemaVersion !== 'technical-solution-extraction-result/v1') throw new Error('TECH_EXTRACTION_SCHEMA_INVALID: 未生成冻结技术方案提取结果')
        await this.runTransaction(runId, lease, draft => { const run = required(draft.technicalSolutionRuns.find(item => item.id === runId), 'TECH_RUN_NOT_FOUND'); run.extractionResult = structuredClone(extractionResult!); run.inputDeliveryManifest = extractionOutput!.inputDeliveryManifest; run.executions = { ...run.executions, technicalSolutionExtraction: executionRecord(extractionOutput!, 'technical-solution-extraction') }; run.execution = run.executions.technicalSolutionExtraction; run.events = extractionOutput!.events; run.step = 'reviewing_solution'; run.progress = 60 })
      }
      activeAgentKey = 'technical-solution-review'
      const reviewSnapshot = stageSnapshot(stored.snapshot, 'technical-solution-review')
      const output = await this.runtime.execute({ snapshot: reviewSnapshot, model: reviewConnection, fixedTechnicalSolutionExtraction: extractionResult, onEvent: async event => { reviewEvents.push(event); if (checkpoint(event)) await this.saveProgress(runId, lease, reviewEvents, progressForEvent(event, 'technical-solution-review'), 'technical-solution-review') } }, signal)
      const result = output.candidate as TechnicalSolutionFormalResult
      if (result.schemaVersion !== 'technical-solution-review-result/v1') throw new Error('TECH_CANDIDATE_SCHEMA_INVALID: 未生成正式技术评审结果')
      await this.runTransaction(runId, lease, draft => {
        const run = required(draft.technicalSolutionRuns.find(item => item.id === runId), 'TECH_RUN_NOT_FOUND')
        if (run.status === 'cancelled') throw new Error('TECH_RUN_FENCE_REJECTED: 取消后的迟到结果不得发布')
        const finishedAt = new Date().toISOString(); const attempt = run.modelRouteAttempts?.find(item => item.id === attemptId); if (attempt) Object.assign(attempt, { status: 'succeeded', finishedAt })
        const executions = { ...run.executions, ...(extractionOutput ? { technicalSolutionExtraction: executionRecord(extractionOutput, 'technical-solution-extraction') } : {}), technicalSolutionReview: executionRecord(output, 'technical-solution-review') }
        Object.assign(run, { status: 'succeeded', step: 'succeeded', progress: 100, finishedAt, result: structuredClone(result), executions, execution: executions.technicalSolutionReview, events: output.events, error: undefined, errorCode: undefined })
      })
      return await this.loadRun(runId)
    } catch (error) {
      const message = sanitize(error)
      const events = activeAgentKey === 'technical-solution-extraction' ? extractionEvents : reviewEvents
      await this.runTransaction(runId, lease, draft => { const run = required(draft.technicalSolutionRuns.find(item => item.id === runId), 'TECH_RUN_NOT_FOUND'); const finishedAt = new Date().toISOString(); const failedAtStep = run.step; const attempt = run.modelRouteAttempts?.find(item => item.id === attemptId); if (attempt) Object.assign(attempt, { status: signal.aborted ? 'cancelled' : 'failed', finishedAt, error: message }); const execution = executionProgress(events, activeAgentKey); const executions = { ...run.executions, [activeAgentKey === 'technical-solution-extraction' ? 'technicalSolutionExtraction' : 'technicalSolutionReview']: execution }; if (run.status !== 'cancelled') Object.assign(run, { status: signal.aborted ? 'cancelled' : 'failed', step: signal.aborted ? 'cancelled' : 'failed', ...(signal.aborted ? { failedAtStep: undefined } : { failedAtStep }), finishedAt, errorCode: errorCode(message), error: message, events, executions, execution }) }).catch(() => undefined)
      throw error
    }
  }

  async actOnFinding(projectVersionId: string, technicalReviewId: string, runId: string, findingId: string, input: { action: FindingActionType; comment?: string; expectedVersion?: number; principal?: Principal }) {
    let created!: TechnicalSolutionFindingAction
    await this.store.transaction(state => {
      const run = required(state.technicalSolutionRuns.find(item => item.id === runId), 'TECH_RUN_NOT_FOUND')
      scopeRun(run, projectVersionId, technicalReviewId)
      required(run.result?.findings.find(item => item.id === findingId), 'TECH_FINDING_NOT_FOUND: Finding 不存在')
      const actions = state.technicalSolutionFindingActions.filter(item => item.runId === runId && item.findingId === findingId).sort((left, right) => left.version - right.version)
      const version = actions.at(-1)?.version ?? 0
      if (input.expectedVersion !== undefined && input.expectedVersion !== version) throw new Error('FINDING_ACTION_VERSION_CONFLICT: Finding 已被更新，请刷新后重试')
      const fromState = actions.at(-1)?.toState ?? 'open'
      const toState = transitions[input.action]
      if (!toState || (input.action !== 'reopen' && fromState !== 'open') || (input.action === 'reopen' && fromState === 'open')) throw new Error(`FINDING_ACTION_INVALID_TRANSITION: 不允许从 ${fromState} 执行 ${input.action}`)
      created = { id: `technical_action_${randomUUID()}`, projectVersionId, technicalReviewId, runId, findingId, action: input.action, fromState, toState, ...(input.comment?.trim() ? { comment: input.comment.trim().slice(0, 2_000) } : {}), actorId: principalId(input.principal), actorDisplayName: principalName(input.principal), version: version + 1, createdAt: new Date().toISOString() }
      state.technicalSolutionFindingActions.push(created)
    })
    return structuredClone(created)
  }

  async listFindingActions(projectVersionId: string, technicalReviewId: string, runId: string) {
    const run = await this.loadRun(runId); scopeRun(run, projectVersionId, technicalReviewId)
    const state = await this.store.snapshot()
    const actions = state.technicalSolutionFindingActions.filter(item => item.runId === runId).sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    return { actions, findings: (run.result?.findings ?? []).map(finding => { const history = actions.filter(item => item.findingId === finding.id); return { findingId: finding.id, state: history.at(-1)?.toState ?? 'open', version: history.at(-1)?.version ?? 0 } }) }
  }

  async evidence(projectVersionId: string, technicalReviewId: string, runId: string, evidenceId: string) {
    const run = await this.loadRun(runId); scopeRun(run, projectVersionId, technicalReviewId)
    return structuredClone(required(run.result?.evidence.find(item => item.id === evidenceId), 'TECH_EVIDENCE_NOT_FOUND: Evidence 不存在'))
  }

  async fixedContent(projectVersionId: string, technicalReviewId: string, runId: string, assetVersionId: string) {
    const run = await this.loadRun(runId); scopeRun(run, projectVersionId, technicalReviewId)
    const allowed = run.result?.evidence.some(item => item.assetVersionId === assetVersionId) || run.snapshot.assets.some(item => item.assetVersionId === assetVersionId)
    if (!allowed) throw new Error('TECH_EVIDENCE_OUT_OF_SCOPE: 资产版本不属于本次运行')
    const state = await this.store.snapshot()
    const version = required(state.versions.find(item => item.id === assetVersionId), 'TECH_INPUT_CONTENT_UNAVAILABLE: 固定正文不存在')
    const expected = run.snapshot.assets.find(item => item.assetVersionId === assetVersionId)?.assetContentHash
    if (expected && version.contentHash !== expected) throw new Error('TECH_INPUT_HASH_MISMATCH: 固定正文 Hash 不一致')
    return { assetVersionId, contentSha256: version.contentHash, content: version.content }
  }

  async exportMarkdown(projectVersionId: string, technicalReviewId: string, runId: string) {
    const run = await this.loadRun(runId); scopeRun(run, projectVersionId, technicalReviewId)
    if (run.status !== 'succeeded' || !run.result) throw new Error('TECH_REPORT_RESULT_REQUIRED: 只有成功运行可以导出报告')
    const state = await this.store.snapshot()
    const review = required(state.technicalSolutionReviews.find(item => item.id === technicalReviewId), 'TECH_REVIEW_NOT_FOUND')
    const actions = state.technicalSolutionFindingActions.filter(item => item.runId === runId)
    const result = run.result
    const lines = ['# 技术方案评审报告', '', '## 1. 报告信息', '', `- 评审：${safe(review.name)}`, `- 项目版本：${safe(run.snapshot.projectVersionName)} (${projectVersionId})`, `- 运行：${runId}`, `- 来源需求评审：${run.sourceReviewRunId}`, `- 状态：${run.status}`, '', '## 2. 固定输入摘要', '', ...run.snapshot.solutionInputs.map(item => `- ${safe(item.displayName)} · ${item.assetVersionId} · ${item.contentSha256.slice(0, 12)}`), '', '## 3. 评审摘要', '', result.summary.overview, '', `总体结论：${result.summary.overallAssessment}`, '', '## 4. 需求覆盖', '', `覆盖率：${(result.statistics.coverageRatio * 100).toFixed(1)}%（已覆盖 ${result.statistics.covered} / 部分覆盖 ${result.statistics.partiallyCovered} / 未覆盖 ${result.statistics.notCovered} / 待确认 ${result.statistics.needsConfirmation}）`, '', ...result.coverage.map(item => `- [${item.status}] ${safe(item.requirementTitle)}：${safe(item.analysis)}`), '', '## 5. 技术 Finding', '']
    result.findings.forEach(finding => { const history = actions.filter(item => item.findingId === finding.id).sort((a,b) => a.version-b.version); lines.push(`### ${safe(finding.title)}`, '', `- 类型/严重度：${finding.type} / ${finding.severity}`, `- 状态：${history.at(-1)?.toState ?? 'open'}`, `- 问题：${safe(finding.problem)}`, `- 影响：${safe(finding.impact)}`, `- 建议：${safe(finding.recommendation)}`, `- Evidence：${finding.evidenceIds.join('、') || '无'}`, '') })
    const extractionDefinition = run.snapshot.agentDefinitions?.technicalSolutionExtraction ?? run.snapshot.agentDefinition
    const reviewDefinition = run.snapshot.agentDefinitions?.technicalSolutionReview
    lines.push('## 6. 主要风险', '', ...result.risks.map(item => `- ${safe(item.description)}；影响：${safe(item.impact)}；缓解：${safe(item.mitigation)}`), '', '## 7. 待确认问题', '', ...result.questions.map(item => `- ${safe(item.question)}：${safe(item.reason)}`), '', '## 8. Evidence', '', ...result.evidence.map(item => `- ${item.id} · ${item.sourceKind} · ${item.assetVersionId} · ${safe(item.headingPath.join(' / '))} · “${safe(item.quote)}”`), '', '## 9. 人工处置状态', '', ...actions.map(item => `- ${item.findingId} · ${item.fromState} → ${item.toState} · ${safe(item.actorDisplayName)} · ${safe(item.comment ?? '')}`), '', '## 10. 运行快照摘要', '', `- 提取 Agent：${extractionDefinition.agentKey} ${extractionDefinition.version}`, `- 评审 Agent：${reviewDefinition ? `${reviewDefinition.agentKey} ${reviewDefinition.version}` : '历史单阶段运行'}`, `- 提取 Prompt Hash：${extractionDefinition.promptRef.contentSha256}`, `- 评审 Prompt Hash：${reviewDefinition?.promptRef.contentSha256 ?? '无'}`, `- IndexVersion：${run.snapshot.indexVersionId}`, `- 输入模式：${run.snapshot.inputPlan.mode}`, `- Snapshot Hash：${run.snapshotSha256}`, '', '## 11. 限制与降级', '', '- 本报告只评审固定需求基线与技术方案资料，不包含 Git、代码、部署或测试执行。')
    return lines.join('\n')
  }

  private async saveProgress(runId: string, lease: TaskLease | undefined, events: AgentExecutionEvent[], progress: number, agentKey: 'technical-solution-extraction' | 'technical-solution-review') {
    await this.runTransaction(runId, lease, state => { const run = required(state.technicalSolutionRuns.find(item => item.id === runId), 'TECH_RUN_NOT_FOUND'); run.progress = Math.max(run.progress, progress); run.step = agentKey === 'technical-solution-extraction' ? 'extracting_solution_points' : progress >= 92 ? 'validating_result' : 'reviewing_solution'; run.events = structuredClone(events); const execution = executionProgress(events, agentKey); run.executions = { ...run.executions, [agentKey === 'technical-solution-extraction' ? 'technicalSolutionExtraction' : 'technicalSolutionReview']: execution }; run.execution = execution })
  }
  private async runTransaction<T>(runId: string, lease: TaskLease | undefined, operation: (state: DatabaseState) => T | Promise<T>) { if (!lease || !this.store.transactionWithTechnicalSolutionLease) return this.store.transaction(operation); const result = await this.store.transactionWithTechnicalSolutionLease(runId, lease, operation); if (result === null) throw new Error('TECH_RUN_FENCE_REJECTED: Worker 租约已失效，迟到结果不得发布'); return result }
  private async loadRun(runId: string) { const run = this.store.getTechnicalSolutionRun ? await this.store.getTechnicalSolutionRun(runId) : (await this.store.snapshot()).technicalSolutionRuns.find(item => item.id === runId); return required(run, 'TECH_RUN_NOT_FOUND: 技术方案评审运行不存在') }
}

function validateReviewInputs(state: DatabaseState, projectVersionId: string, sourceReviewRunId: string, rawIds: string[]) {
  const projectVersion = required(state.projectVersions.find(item => item.id === projectVersionId), 'PROJECT_VERSION_NOT_FOUND')
  const baselineRun = required(state.reviewRuns.find(item => item.id === sourceReviewRunId && item.projectVersionId === projectVersionId), 'TECH_BASELINE_NOT_FOUND: 来源需求评审不存在或不属于当前版本')
  if (baselineRun.status !== 'succeeded' || !baselineRun.result) throw new Error('TECH_BASELINE_NOT_SUCCEEDED: 来源需求评审必须成功')
  const ids = unique(rawIds)
  if (!ids.length) throw new Error('TECH_SOLUTION_INPUT_REQUIRED: 至少选择一份技术方案')
  if (ids.length > 10) throw new Error('TECH_SOLUTION_ASSET_INVALID: 单次最多选择 10 份技术方案')
  const solutionVersions = ids.map(id => required(state.versions.find(item => item.id === id), `TECH_SOLUTION_ASSET_INVALID: 资产版本不存在 ${id}`))
  if (solutionVersions.some(item => item.status !== 'ready')) throw new Error('TECH_SOLUTION_ASSET_INVALID: 技术方案资产尚未 ready')
  const solutionAssets = solutionVersions.map(item => required(state.assets.find(asset => asset.id === item.assetId), 'TECH_SOLUTION_ASSET_INVALID: 资产不存在'))
  if (solutionAssets.some(item => item.assetType !== 'technical_design')) throw new Error('TECH_SOLUTION_ASSET_INVALID: 只允许 technical_design 类型资产')
  const knowledgeBaseIds = new Set(solutionAssets.map(item => item.knowledgeBaseId))
  if (knowledgeBaseIds.size !== 1) throw new Error('TECH_SOLUTION_ASSET_INVALID: 技术方案必须属于同一项目知识库')
  const knowledgeBase = required(state.knowledgeBases.find(item => item.id === solutionAssets[0].knowledgeBaseId), 'TECH_SOLUTION_ASSET_INVALID: 知识库不存在')
  const project = required(state.projects.find(item => item.id === knowledgeBase.projectId), 'TECH_SOLUTION_ASSET_INVALID: 项目不存在')
  if (project.id !== projectVersion.projectId) throw new Error('TECH_SOLUTION_ASSET_INVALID: 技术方案不属于当前项目版本')
  const index = required(state.indexes.find(item => item.id === knowledgeBase.activeIndexVersionId && item.status === 'active'), 'TECH_INDEX_UNAVAILABLE: 当前知识库没有活动索引')
  if (solutionVersions.some(item => !index.assetVersionIds.includes(item.id))) throw new Error('TECH_INDEX_UNAVAILABLE: 技术方案不在活动索引中')
  return { baselineRun, solutionAssets, solutionVersions, knowledgeBase, index, project }
}

function freezeBaseline(run: ReviewRun, state: DatabaseState): TechnicalSolutionRunSnapshot['requirementBaseline'] {
  const result = required(run.result, 'TECH_BASELINE_PROTOCOL_UNSUPPORTED')
  const actions = state.findingActions.filter(item => item.runId === run.id).sort((a,b) => a.version-b.version)
  const evidence = result.evidence.map(item => { const version = required(state.versions.find(value => value.id === item.sourceRef.assetVersionId), 'TECH_BASELINE_PROTOCOL_UNSUPPORTED: 需求 Evidence 资产版本不存在'); const asset = required(state.assets.find(value => value.id === version.assetId), 'TECH_BASELINE_PROTOCOL_UNSUPPORTED: 需求 Evidence 资产不存在'); return { evidenceId: item.clientEvidenceId, requirementPointId: result.requirementPoints.find(point => point.evidenceRefs.includes(item.clientEvidenceId))?.clientRequirementPointId ?? '', assetId: asset.id, assetVersionId: version.id, chunkId: item.sourceRef.chunkId, contentSha256: version.contentHash, headingPath: item.locator.heading ? [item.locator.heading] : [], quote: item.quote, startLine: item.locator.start, endLine: item.locator.end } })
  if (evidence.some(item => !item.requirementPointId)) throw new Error('TECH_BASELINE_PROTOCOL_UNSUPPORTED: Evidence 未关联需求点')
  const requirementPoints = result.requirementPoints.map(item => ({ id: item.clientRequirementPointId, title: item.title, description: item.description, evidenceIds: [...item.evidenceRefs] }))
  const findings = result.findings.map(item => { const history = actions.filter(action => action.findingId === item.clientFindingId); return { id: item.clientFindingId, type: item.type, severity: item.severity, title: item.title, description: item.description, impact: item.impact, recommendation: item.recommendation, requirementPointIds: [...item.requirementPointRefs], state: history.at(-1)?.toState ?? 'open' } })
  const content = { requirementPoints, evidence, findings }
  return { sourceReviewRunId: run.id, sourceResultSha256: sha256(stableStringify(result)), snapshotSha256: sha256(stableStringify(content)), ...content }
}

function selectModelRoute(state: DatabaseState, configuration: AgentConfigurationVersion) { const primary = required(configuration.routing.primaryModel, 'TECH_AGENT_CONFIGURATION_UNAVAILABLE: 未配置默认模型'); const references = [primary, ...(configuration.routing.fallbackEnabled ? configuration.routing.fallbackModels : [])]; const seen = new Set<string>(); const route = references.flatMap(reference => { const key = `${reference.sourceId}:${reference.modelId}`; if (seen.has(key)) return []; seen.add(key); try { return [selectSpecificModel(state, reference.sourceId, reference.modelId)] } catch { return [] } }); if (!route.length) throw new Error('TECH_AGENT_CONFIGURATION_UNAVAILABLE: 已发布路由中没有健康且支持工具调用的模型'); return route }
async function resolveFrozenConfiguration(definitions: AgentDefinitionResolver, agentKey: 'technical-solution-extraction' | 'technical-solution-review', reference?: { id: string; version: number; contentSha256: string }) { const configuration = reference && definitions.resolveVersion ? await definitions.resolveVersion(reference.id) : await definitions.resolveActive?.(agentKey); if (!configuration) throw new Error('TECH_AGENT_CONFIGURATION_UNAVAILABLE'); if (reference && (configuration.id !== reference.id || configuration.version !== reference.version || configuration.contentSha256 !== reference.contentSha256)) throw new Error('TECH_AGENT_CONFIGURATION_DRIFT: 运行固定 Agent 配置版本不一致'); if (configuration.agentDefinition.agentKey !== agentKey) throw new Error('TECH_AGENT_CONFIGURATION_UNAVAILABLE: Agent 阶段不匹配'); return configuration }
function selectSpecificModel(state: DatabaseState, sourceId: string, modelId: string) { const source = required(state.modelSources.find(item => item.id === sourceId && item.enabled), 'TECH_AGENT_CONFIGURATION_UNAVAILABLE: 模型来源不可用'); const model = required(source.models.find(item => item.id === modelId && item.enabled && item.health === 'healthy' && item.capabilities.includes('tool_calling')), 'TECH_AGENT_CONFIGURATION_UNAVAILABLE: 模型不可用或不支持工具调用'); return { source, model } }
function modelSnapshot(selection: ReturnType<typeof selectSpecificModel>, configuration: AgentConfigurationVersion): TechnicalSolutionRunSnapshot['modelRef'] { return { sourceId: selection.source.id, providerType: selection.source.providerType, modelId: selection.model.id, modelName: selection.model.name, contextWindow: selection.model.contextWindow, maxOutputTokens: Math.min(selection.model.maxOutputTokens, configuration.routing.maxOutputTokens), supportsReasoning: selection.model.capabilities.includes('reasoning') } }
function runtimeConnection(modelRef: TechnicalSolutionRunSnapshot['modelRef'], selection: ReturnType<typeof selectSpecificModel>, configuration: AgentConfigurationVersion) { return { ...modelRef, baseUrl: selection.source.baseUrl, apiKey: selection.source.apiKey, temperature: configuration.routing.temperature, requestTimeoutMs: configuration.routing.requestTimeoutSeconds * 1_000, retryCount: configuration.routing.retryCount } }
function stageSnapshot(snapshot: TechnicalSolutionRunSnapshot, agentKey: 'technical-solution-extraction' | 'technical-solution-review'): TechnicalSolutionRunSnapshot { const definitions = snapshot.agentDefinitions; const agentDefinition = agentKey === 'technical-solution-extraction' ? definitions?.technicalSolutionExtraction ?? snapshot.agentDefinition : definitions?.technicalSolutionReview ?? snapshot.agentDefinition; return { ...structuredClone(snapshot), agentDefinition: structuredClone(agentDefinition) } }
function executionRecord(output: AgentExecutionOutput, agentKey: 'technical-solution-extraction' | 'technical-solution-review') { return { agentKey, turns: output.turns, toolCalls: output.toolCalls, toolErrors: output.toolErrors, framework: output.framework, events: output.events } }
function executionProgress(events: AgentExecutionEvent[], agentKey: 'technical-solution-extraction' | 'technical-solution-review') { return { agentKey, turns: maxTurn(events), toolCalls: toolCalls(events), toolErrors: toolErrors(events), events: structuredClone(events) } }
function presentRunSummary(run: TechnicalSolutionReviewRun) { return { id: run.id, runId: run.id, technicalReviewId: run.technicalReviewId, projectVersionId: run.projectVersionId, sourceReviewRunId: run.sourceReviewRunId, status: run.status, step: run.step, failedAtStep: run.failedAtStep, progress: run.progress, modelLabel: run.modelLabel, modelRouteAttempts: run.modelRouteAttempts, degradations: run.degradations, createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt, errorCode: run.errorCode, error: run.error, queue: run.queue, snapshot: redactSnapshot(run.snapshot), summary: run.result?.summary, statistics: run.result?.statistics } }
function presentRun(run: TechnicalSolutionReviewRun) { return { ...presentRunSummary(run), ...(run.status === 'succeeded' ? { result: run.result, inputDeliveryManifest: run.inputDeliveryManifest, extractionResult: run.extractionResult, executions: run.executions, execution: run.execution } : { extractionResult: run.extractionResult, executions: run.executions, execution: run.execution }), events: run.events } }
function redactSnapshot(snapshot: TechnicalSolutionRunSnapshot) { return { ...snapshot, agentDefinition: { ...snapshot.agentDefinition, systemPrompt: undefined, taskTemplate: undefined }, ...(snapshot.agentDefinitions ? { agentDefinitions: { technicalSolutionExtraction: { ...snapshot.agentDefinitions.technicalSolutionExtraction, systemPrompt: undefined, taskTemplate: undefined }, technicalSolutionReview: { ...snapshot.agentDefinitions.technicalSolutionReview, systemPrompt: undefined, taskTemplate: undefined } } } : {}), inputPlan: { ...snapshot.inputPlan, batches: snapshot.inputPlan.batches.map(batch => ({ ...batch, content: undefined })) } } }
function scopeRun(run: TechnicalSolutionReviewRun, projectVersionId: string, technicalReviewId: string) { if (run.projectVersionId !== projectVersionId || run.technicalReviewId !== technicalReviewId) throw new Error('TECH_RUN_NOT_FOUND: 技术方案评审运行不存在') }
function unresolvedHighCount(run: ReviewRun, state: Pick<DatabaseState, 'findingActions'>) { const actions = state.findingActions.filter(item => item.runId === run.id); return (run.result?.findings ?? []).filter(item => ['blocker','high'].includes(item.severity) && (actions.filter(action => action.findingId === item.clientFindingId).sort((a,b)=>a.version-b.version).at(-1)?.toState ?? 'open') === 'open').length }
function checkpoint(event: AgentExecutionEvent) { return ['turn_end','tool_execution_end','agent_end','input_batch_delivered','input_final_merge_started','result_submission_required'].includes(event.type) }
function progressForEvent(event: AgentExecutionEvent, agentKey: 'technical-solution-extraction' | 'technical-solution-review') { if (agentKey === 'technical-solution-review') return event.type === 'tool_execution_end' && event.toolId === 'technical_solution_review.submit_result' ? 95 : 78; return event.type === 'tool_execution_end' && event.toolId === 'technical_solution_points.submit_result' ? 58 : event.type === 'input_final_merge_started' ? 48 : event.type === 'input_batch_delivered' ? 28 : 38 }
function maxTurn(events: AgentExecutionEvent[]) { return events.reduce((max,event) => Math.max(max,event.turn ?? 0),0) }
function toolCalls(events: AgentExecutionEvent[]) { return events.filter(item => item.type === 'tool_execution_start').length }
function toolErrors(events: AgentExecutionEvent[]) { return events.filter(item => item.type === 'tool_execution_end' && item.isError).length }
function errorCode(message: string) { return /^[A-Z][A-Z0-9_]+(?=:)/u.exec(message)?.[0] ?? 'TECH_RUN_FAILED' }
function sanitize(error: unknown) { return (error instanceof Error ? error.message : '技术方案评审运行失败').replace(/https?:\/\/[^\s'"`]+/giu,'[已隐藏地址]').replace(/(api[_-]?key|authorization|token|secret|password)\s*[:=]\s*\S+/giu,'$1=[已隐藏凭据]').slice(0,500) }
function sha256(value: string) { return createHash('sha256').update(value).digest('hex') }
function stableStringify(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`; return JSON.stringify(value) }
function unique(value: string[]) { return [...new Set((Array.isArray(value) ? value : []).map(String).map(item=>item.trim()).filter(Boolean))] }
function cleanRequired(value: string, label: string, max: number) { const text=String(value??'').trim(); if(!text) throw new Error(`${label}不能为空`); if(text.length>max) throw new Error(`${label}不能超过 ${max} 字符`); return text }
function principalId(value: Principal | undefined) { return String(value?.subjectId ?? 'system').slice(0,200) }
function principalName(value: Principal | undefined) { return String(value?.displayName ?? '系统').slice(0,200) }
function safe(value: string) { return String(value).replace(/[\r\n]+/gu,' ').replace(/([*_`])/gu,'\\$1').trim() }
function required<T>(value: T | undefined | null, message: string): T { if(value==null) throw new Error(message); return value }
function byNewest<T extends {createdAt:string;id:string}>(a:T,b:T) { return b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id) }
