import { createHash, randomUUID } from 'node:crypto'
import type { AgentDefinitionResolver, AgentExecutionEvent, AgentExecutionInput, AgentExecutionOutput, AgentRuntime, RequirementInputPlan, ReviewRunSnapshot } from '../domain/agent-types.js'
import type { AgentConfigurationVersion, AgentExecutionRecord, DatabaseState, ReviewRun } from '../domain/types.js'
import type { CandidateRequirementPointExtraction, CandidateRequirementReview } from '../domain/review-types.js'
import type { StateStore, TaskLease } from '../infrastructure/store.js'
import { RequirementPointExtractionValidator, RequirementReviewValidator, ReviewResultValidator } from '../agent/result-validator.js'
import { defaultAgentDefinitionResolver } from '../agent/dynamic-agent-definition-resolver.js'
import { buildRequirementDirectoryInputPlan } from '../agent/requirement-context-assembler.js'

export interface RequirementAnalysisRequest {
  projectVersionId: string
  documentDirectoryPath: string
  reviewId?: string
  sourceId?: string
  modelId?: string
  focusAreas?: string[]
  excludedAreas?: string[]
  retryOfRunId?: string
  retryMode?: 'full'
}

export type RequirementReviewRetryMode = 'full' | 'review_only'

export class RequirementAnalysisService {
  private readonly validator: ReviewResultValidator
  private readonly extractionValidator: RequirementPointExtractionValidator
  private readonly reviewValidator = new RequirementReviewValidator()
  private readonly activeRuns = new Map<string, AbortController>()
  constructor(private readonly store: StateStore, private readonly runtime: AgentRuntime, private readonly definitions: AgentDefinitionResolver = defaultAgentDefinitionResolver) {
    this.validator = new ReviewResultValidator(store)
    this.extractionValidator = new RequirementPointExtractionValidator(store)
  }

  async recoverInterruptedRuns() {
    if (this.store.claimReviewJob) return 0
    const finishedAt = new Date().toISOString()
    const error = 'REVIEW_RUN_INTERRUPTED: 服务进程在 Agent 执行期间重启，本次运行已终止；请重新发起评审'
    if (this.store.recoverInterruptedReviewRuns) return this.store.recoverInterruptedReviewRuns(finishedAt, error)
    let recovered = 0
    await this.store.transaction(state => {
      state.reviewRuns.forEach(run => {
        if (run.status !== 'running') return
        recovered += 1
        Object.assign(run, {
          status: 'failed',
          step: 'failed',
          finishedAt,
          error,
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
    if (this.store.enqueueReviewJob) {
      const created = await this.analyze(request, new AbortController().signal, undefined, true)
      const createdRunId = 'id' in created ? created.id : created.runId
      const timestamp = new Date().toISOString()
      await this.store.enqueueReviewJob({ id: `review_job_${randomUUID()}`, runId: createdRunId, projectVersionId: request.projectVersionId, status: 'queued', attempts: 0, maxAttempts: 3, availableAt: timestamp, createdAt: timestamp, updatedAt: timestamp })
      return created
    }
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

  async retry(runId: string, mode: RequirementReviewRetryMode) {
    const sourceRun = await this.loadStoredRun(runId)
    if (sourceRun.status === 'running') throw new Error('正在执行的需求评审不能重跑，请先取消运行')
    if (sourceRun.status === 'succeeded') throw new Error('已成功的需求评审不能作为失败重试来源，请直接发起新的完整运行')
    if (mode === 'full') {
      return this.start({
        projectVersionId: sourceRun.projectVersionId,
        documentDirectoryPath: required(sourceRun.snapshot.documentWorkspace?.logicalPath, 'PI_WORKSPACE_SNAPSHOT_REQUIRED: 旧需求评审运行不能全部重跑'),
        reviewId: reviewIdFor(sourceRun),
        focusAreas: sourceRun.snapshot.focusAreas,
        excludedAreas: sourceRun.snapshot.excludedAreas,
        retryOfRunId: sourceRun.id,
        retryMode: 'full',
      })
    }
    if (this.store.enqueueReviewJob) {
      const created = await this.retryReview(runId, new AbortController().signal, undefined, true)
      const createdRunId = 'id' in created ? created.id : created.runId
      const timestamp = new Date().toISOString()
      await this.store.enqueueReviewJob({ id: `review_job_${randomUUID()}`, runId: createdRunId, projectVersionId: sourceRun.projectVersionId, status: 'queued', attempts: 0, maxAttempts: 3, availableAt: timestamp, createdAt: timestamp, updatedAt: timestamp })
      return created
    }
    const controller = new AbortController()
    let retryRunId = ''
    return await new Promise<ReturnType<typeof presentRun>>((resolve, reject) => {
      void this.retryReview(runId, controller.signal, run => {
        retryRunId = run.id
        this.activeRuns.set(retryRunId, controller)
        resolve(run)
      }).catch(error => {
        if (!retryRunId) reject(error)
      }).finally(() => {
        if (retryRunId && this.activeRuns.get(retryRunId) === controller) this.activeRuns.delete(retryRunId)
      })
    })
  }

  async cancel(runId: string) {
    const state = await this.store.snapshot()
    const run = required(state.reviewRuns.find(item => item.id === runId), '需求评审运行不存在')
    if (run.status !== 'running') return presentRun(run)
    await this.store.cancelReviewJob?.(runId)
    await this.store.transaction(draft => {
      const current = required(draft.reviewRuns.find(item => item.id === runId), '需求评审运行不存在')
      if (current.status === 'running') Object.assign(current, { status: 'cancelled', step: 'cancelled', finishedAt: new Date().toISOString(), error: '用户已取消本次评审' } satisfies Partial<ReviewRun>)
    })
    this.activeRuns.get(runId)?.abort(new Error('AGENT_CANCELLED_BY_USER'))
    return await this.get(runId)
  }

  async retryReview(sourceRunId: string, signal = new AbortController().signal, onCreated?: (run: ReturnType<typeof presentRun>) => void, deferExecution = false) {
    const state = await this.store.snapshot()
    const sourceRun = required(state.reviewRuns.find(item => item.id === sourceRunId), '需求评审运行不存在')
    if (sourceRun.status === 'running') throw new Error('正在执行的需求评审不能重跑，请先取消运行')
    if (sourceRun.status === 'succeeded') throw new Error('已成功的需求评审不能作为失败重试来源')
    if (sourceRun.snapshot.extractionInput?.mode !== 'agent_directory' || sourceRun.snapshot.documentWorkspace?.layoutVersion !== 'workspace/v1') throw new Error('PI_WORKSPACE_SNAPSHOT_REQUIRED: 旧需求评审运行不支持重新需求评审')
    const projectVersion = required(state.projectVersions.find(item => item.id === sourceRun.projectVersionId), '项目版本不存在')
    if (projectVersion.status !== 'open') throw new Error('当前项目版本为只读状态，不能重新需求评审')
    const extraction = structuredClone(required(sourceRun.extractionResult, '该运行没有已冻结的需求点提取结果，只能全部重跑'))
    const inputDeliveryManifest = structuredClone(required(sourceRun.inputDeliveryManifest, '该运行缺少需求点正文投递证明，只能全部重跑'))
    const extractionValidation = await this.extractionValidator.validate(extraction, sourceRun.snapshot, inputDeliveryManifest)
    if (!extractionValidation.valid) throw new Error(`冻结需求点提取结果已无法通过校验，只能全部重跑：${validationIssueSummary(extractionValidation.issues)}`)

    const reviewConfiguration = this.definitions.resolveActive ? await this.definitions.resolveActive('requirement-review') : null
    if (this.definitions.resolveActive && !reviewConfiguration) throw new Error('请先在系统管理的 Agent 配置中发布需求评审 Agent，再重新需求评审')
    const previousReviewModel = sourceRun.snapshot.agentModelRefs?.requirementReview ?? sourceRun.snapshot.modelRef
    const reviewModels = selectAgentModels(state, reviewConfiguration, { sourceId: previousReviewModel.sourceId, modelId: previousReviewModel.modelId }, '需求评审 Agent')
    const reviewModel = reviewModels[0]
    const reviewDefinition = reviewConfiguration?.agentDefinition ?? await this.definitions.resolve('requirement-review')
    const extractionDefinition = sourceRun.snapshot.agentDefinitions?.requirementPointExtraction ?? sourceRun.snapshot.agentDefinition
    const extractionModelRef = sourceRun.snapshot.agentModelRefs?.requirementPointExtraction ?? sourceRun.snapshot.modelRef
    const extractionConfigurationRef = sourceRun.snapshot.agentConfigurationRefs?.requirementPointExtraction ?? sourceRun.snapshot.agentConfigurationRef
    const now = new Date().toISOString()
    const newRunId = `review_run_${randomUUID()}`
    const snapshot: ReviewRunSnapshot = {
      ...structuredClone(sourceRun.snapshot),
      runId: newRunId,
      reviewId: reviewIdFor(sourceRun),
      modelRef: structuredClone(extractionModelRef),
      agentModelRefs: {
        requirementPointExtraction: structuredClone(extractionModelRef),
        requirementReview: modelSnapshot(reviewModel, reviewConfiguration?.routing.maxOutputTokens ?? reviewModel.model.maxOutputTokens),
      },
      ...(extractionConfigurationRef && reviewConfiguration ? { agentConfigurationRefs: {
        requirementPointExtraction: structuredClone(extractionConfigurationRef),
        requirementReview: configurationRef(reviewConfiguration),
      } } : {}),
      agentDefinition: structuredClone(extractionDefinition),
      agentDefinitions: { requirementPointExtraction: structuredClone(extractionDefinition), requirementReview: reviewDefinition },
      createdAt: now,
    }
    const extractionExecution = sourceRun.executions?.requirementPointExtraction
      ?? (sourceRun.execution?.agentKey === 'requirement-point-extraction' ? sourceRun.execution : undefined)
    const run: ReviewRun = {
      id: newRunId,
      reviewId: reviewIdFor(sourceRun),
      retryOfRunId: sourceRun.id,
      retryMode: 'review_only',
      reusedExtractionFromRunId: sourceRun.id,
      projectVersionId: sourceRun.projectVersionId,
      assetId: sourceRun.assetId,
      assetVersionId: sourceRun.assetVersionId,
      documentTitle: sourceRun.documentTitle,
      documentVersion: sourceRun.documentVersion,
      logicalPath: sourceRun.logicalPath,
      sourceId: extractionModelRef.sourceId,
      modelId: extractionModelRef.modelId,
      modelLabel: `复用需求点提取：${sourceRun.id}；需求评审：${reviewModel.source.name} · ${reviewModel.model.displayName}`,
      status: 'running',
      step: deferExecution ? 'waiting_worker' : 'reviewing_requirements',
      progress: deferExecution ? 1 : 60,
      createdAt: now,
      startedAt: now,
      snapshot,
      extractionResult: extraction,
      inputDeliveryManifest,
      ...(extractionExecution ? { executions: { requirementPointExtraction: structuredClone(extractionExecution) } } : {}),
    }
    await this.store.transaction(draft => { draft.reviewRuns.push(run) })
    onCreated?.(presentRun(run))
    if (deferExecution) return presentRun(run)
    const reviewEvents: AgentExecutionEvent[] = []
    let activeReviewModel = reviewModel
    try {
      return await this.executeReviewStage({ run, extraction, snapshot, reviewDefinition, reviewModel, reviewModels, reviewConfiguration, extractionExecution, reviewEvents, signal, onModelAttempt: selection => { activeReviewModel = selection } })
    } catch (error) {
      const message = await this.failRun(run.id, error, signal, activeReviewModel, 'requirement-review', reviewEvents)
      throw new Error(message)
    }
  }

  async analyze(request: RequirementAnalysisRequest, signal = new AbortController().signal, onCreated?: (run: ReturnType<typeof presentRun>) => void, deferExecution = false) {
    const state = await this.store.snapshot()
    const projectVersion = required(state.projectVersions.find(item => item.id === request.projectVersionId), '项目版本不存在')
    if (projectVersion.status !== 'open') throw new Error('当前项目版本为只读状态，不能发起需求评审')
    const project = required(state.projects.find(item => item.id === projectVersion.projectId), '项目不存在')
    const knowledgeBase = required(state.knowledgeBases.find(item => item.projectId === project.id), '知识库不存在')
    const index = required(state.indexes.find(item => item.id === knowledgeBase.activeIndexVersionId && item.status === 'active'), '知识库没有活动索引')
    if (request.documentDirectoryPath === undefined) throw new Error('PI_WORKSPACE_DIRECTORY_REQUIRED: 需求评审必须指定 /workspace 下的输入目录')
    const documentDirectoryPath = normalizeDocumentDirectoryPath(request.documentDirectoryPath)
    const requiredInputDirectory = `workspace/branches/${safeWorkspaceSegment(projectVersion.name)}/input/requirements`
    if (documentDirectoryPath !== requiredInputDirectory) throw new Error(`PI_WORKSPACE_INPUT_REQUIRED: 当前版本需求输入目录固定为 /${requiredInputDirectory}`)
    const workspacePairs = state.assets.flatMap(asset => {
      if (asset.knowledgeBaseId !== knowledgeBase.id || !isWithinDirectory(asset.logicalPath, 'workspace') || !asset.activeVersionId) return []
      const version = state.versions.find(item => item.id === asset.activeVersionId && item.assetId === asset.id && item.status === 'ready' && index.assetVersionIds.includes(item.id))
      return version ? [{ asset, version }] : []
    }).sort((left, right) => left.asset.logicalPath.localeCompare(right.asset.logicalPath, 'zh-CN') || left.version.id.localeCompare(right.version.id))
    const inputPairs = workspacePairs.filter(({ asset }) => isWithinDirectory(asset.logicalPath, documentDirectoryPath))
    if (!inputPairs.length) throw new Error(`Agent 输入目录 /${documentDirectoryPath} 中没有已进入活动索引的 ready 文档`)
    if (!workspacePairs.length) throw new Error('/workspace 中没有已进入活动索引的 ready 文档')
    const workspaceAssets = workspacePairs.map(item => item.asset)
    const workspaceVersions = workspacePairs.map(item => item.version)
    const inputAssets = inputPairs.map(item => item.asset)
    const inputVersions = inputPairs.map(item => item.version)
    const [extractionConfiguration, reviewConfiguration] = this.definitions.resolveActive
      ? await Promise.all([this.definitions.resolveActive('requirement-point-extraction'), this.definitions.resolveActive('requirement-review')])
      : [null, null]
    if (this.definitions.resolveActive && (!extractionConfiguration || !reviewConfiguration)) throw new Error('请先在系统管理的 Agent 配置中分别发布需求点提取 Agent 和需求评审 Agent，再发起需求评审')
    const requestModel = request.sourceId && request.modelId ? { sourceId: request.sourceId, modelId: request.modelId } : null
    const extractionModels = selectAgentModels(state, extractionConfiguration, requestModel, '需求点提取 Agent')
    const reviewModels = selectAgentModels(state, reviewConfiguration, requestModel, '需求评审 Agent')
    const extractionModel = extractionModels[0]
    const reviewModel = reviewModels[0]
    const baseExtractionDefinition = extractionConfiguration?.agentDefinition ?? await this.definitions.resolve('requirement-point-extraction')
    const reviewDefinition = reviewConfiguration?.agentDefinition ?? await this.definitions.resolve('requirement-review')
    requirePiWorkspaceAgentDefinition(baseExtractionDefinition)
    const extractionCoveragePlan = buildExtractionCoveragePlan(inputVersions, request.excludedAreas)
    const extractionDefinition = baseExtractionDefinition
    const extractionToolBudget = { directoryCalls: Math.max(1, extractionDefinition.limits.maxToolCalls - 3), chunkCalls: Math.max(1, extractionDefinition.limits.maxToolCalls - 3), evidenceCalls: 0, submissionCalls: 3, minimumToolCalls: 3 }
    const effectiveMaxOutputTokens = extractionConfiguration?.routing.maxOutputTokens ?? extractionModel.model.maxOutputTokens
    const contextAssets = workspaceAssets.map((asset, position) => ({ asset, version: workspaceVersions[position] }))
    const documentWorkspace = requirementDocumentWorkspace(projectVersion, state.projectVersions, documentDirectoryPath)
    const requirementInputPlan = buildRequirementDirectoryInputPlan({
        workspacePath: documentDirectoryPath,
        workspaceRootPath: documentWorkspace?.rootLogicalPath,
        activeBranchPath: documentWorkspace?.activeBranchLogicalPath,
        agentWorkspacePath: documentWorkspace?.agentLogicalPath,
        assets: contextAssets,
        definition: extractionDefinition,
        contextWindow: extractionModel.model.contextWindow,
        maxOutputTokens: effectiveMaxOutputTokens,
      })
    const now = new Date().toISOString()
    const reviewId = request.reviewId ?? `review_${randomUUID()}`
    const snapshot: ReviewRunSnapshot = {
      runId: `review_run_${randomUUID()}`,
      reviewId,
      projectId: project.id,
      projectName: project.name,
      projectVersionId: projectVersion.id,
      projectVersionName: projectVersion.name,
      knowledgeBaseId: knowledgeBase.id,
      assetId: inputAssets[0].id,
      assetVersionId: inputVersions[0].id,
      assetContentHash: inputVersions[0].contentHash,
      indexVersionId: index.id,
      logicalPath: inputAssets[0].logicalPath,
      assets: workspaceAssets.map((asset, position) => ({ assetId: asset.id, assetVersionId: workspaceVersions[position].id, assetContentHash: workspaceVersions[position].contentHash, logicalPath: asset.logicalPath, displayName: asset.displayName, assetType: asset.assetType })),
      documentWorkspace: { ...documentWorkspace, candidateAssetVersionIds: workspaceVersions.map(item => item.id) },
      modelRef: modelSnapshot(extractionModel, effectiveMaxOutputTokens),
      agentModelRefs: {
        requirementPointExtraction: modelSnapshot(extractionModel, effectiveMaxOutputTokens),
        requirementReview: modelSnapshot(reviewModel, reviewConfiguration?.routing.maxOutputTokens ?? reviewModel.model.maxOutputTokens),
      },
      ...(extractionConfiguration && reviewConfiguration ? { agentConfigurationRefs: {
        requirementPointExtraction: configurationRef(extractionConfiguration),
        requirementReview: configurationRef(reviewConfiguration),
      } } : {}),
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
      reviewId,
      ...(request.retryOfRunId ? { retryOfRunId: request.retryOfRunId, retryMode: request.retryMode ?? 'full' } : {}),
      projectVersionId: projectVersion.id,
      assetId: inputAssets[0].id,
      assetVersionId: inputVersions[0].id,
      documentTitle: `${inputAssets.length} 份需求输入文档 · ${workspaceAssets.length} 份工作区文档`,
      documentVersion: inputVersions[0].number,
      logicalPath: documentDirectoryPath,
      sourceId: extractionModel.source.id,
      modelId: extractionModel.model.id,
      modelLabel: `需求点提取：${extractionModel.source.name} · ${extractionModel.model.displayName}；需求评审：${reviewModel.source.name} · ${reviewModel.model.displayName}`,
      status: 'running',
      step: deferExecution ? 'waiting_worker' : 'extracting_requirement_points',
      progress: deferExecution ? 1 : 10,
      createdAt: now,
      startedAt: now,
      snapshot,
    }
    await this.store.transaction(draft => { draft.reviewRuns.push(run) })
    onCreated?.(presentRun(run))
    if (deferExecution) return presentRun(run)
    return this.executeStages({ run, snapshot, requirementInputPlan, extractionModels, reviewModels, extractionConfiguration, reviewConfiguration, reviewDefinition, signal })
  }

  async processPreparedRun(runId: string, lease?: TaskLease, signal = new AbortController().signal, infrastructureAttempt = 1, maxInfrastructureAttempts = 1) {
    await this.beginExecutionAttempt(runId, lease, infrastructureAttempt, maxInfrastructureAttempts)
    const state = await this.store.snapshot()
    const run = required(state.reviewRuns.find(item => item.id === runId), '需求评审运行不存在')
    if (run.status !== 'running') throw new Error('需求评审运行已结束，不能由 Worker 重复执行')
    const extractionConfigurationRef = run.snapshot.agentConfigurationRefs?.requirementPointExtraction ?? run.snapshot.agentConfigurationRef
    const reviewConfigurationRef = run.snapshot.agentConfigurationRefs?.requirementReview ?? run.snapshot.agentConfigurationRef
    const extractionConfiguration = extractionConfigurationRef ? required(state.agentConfigurationVersions.find(item => item.id === extractionConfigurationRef.id), '需求点提取 Agent 固定配置版本不存在') : null
    const reviewConfiguration = reviewConfigurationRef ? required(state.agentConfigurationVersions.find(item => item.id === reviewConfigurationRef.id), '需求评审 Agent 固定配置版本不存在') : null
    const extractionModels = selectAgentModels(state, extractionConfiguration, { sourceId: run.snapshot.agentModelRefs?.requirementPointExtraction.sourceId ?? run.snapshot.modelRef.sourceId, modelId: run.snapshot.agentModelRefs?.requirementPointExtraction.modelId ?? run.snapshot.modelRef.modelId }, '需求点提取 Agent')
    const reviewReference = run.snapshot.agentModelRefs?.requirementReview ?? run.snapshot.modelRef
    const reviewModels = selectAgentModels(state, reviewConfiguration, { sourceId: reviewReference.sourceId, modelId: reviewReference.modelId }, '需求评审 Agent')
    if (run.retryMode === 'review_only') {
      const extraction = structuredClone(required(run.extractionResult, '仅评审任务缺少冻结需求点提取结果'))
      const extractionExecution = run.executions?.requirementPointExtraction
      const reviewEvents: AgentExecutionEvent[] = []
      let activeReviewModel = reviewModels[0]
      await this.reviewTransaction(run.id, lease, draft => {
        const current = required(draft.reviewRuns.find(item => item.id === run.id), '需求评审运行不存在')
        current.step = 'reviewing_requirements'
        current.progress = 60
      })
      try {
        return await this.executeReviewStage({ run, extraction, snapshot: run.snapshot, reviewDefinition: run.snapshot.agentDefinitions.requirementReview, reviewModel: reviewModels[0], reviewModels, reviewConfiguration, extractionExecution, reviewEvents, signal, lease, onModelAttempt: selection => { activeReviewModel = selection } })
      } catch (error) {
        const message = await this.failRun(run.id, error, signal, activeReviewModel, 'requirement-review', reviewEvents, lease, infrastructureAttempt < maxInfrastructureAttempts)
        throw new Error(message)
      }
    }
    const versions = run.snapshot.assets.map(item => {
      const version = required(state.versions.find(candidate => candidate.id === item.assetVersionId && candidate.status === 'ready'), '固定需求资产版本不可用')
      if (version.contentHash !== item.assetContentHash) throw new Error('固定需求资产内容 Hash 已漂移')
      return version
    })
    const assets = run.snapshot.assets.map(item => required(state.assets.find(candidate => candidate.id === item.assetId), '固定需求资产不存在'))
    const fixedContextAssets = assets.map((asset, index) => ({
      asset: {
        ...asset,
        displayName: run.snapshot.assets[index].displayName,
        logicalPath: run.snapshot.assets[index].logicalPath,
        assetType: run.snapshot.assets[index].assetType ?? asset.assetType,
      },
      version: versions[index],
    }))
    const fixedDefinition = run.snapshot.agentDefinitions.requirementPointExtraction
    requirePiWorkspaceAgentDefinition(fixedDefinition)
    const fixedMaxOutputTokens = extractionConfiguration?.routing.maxOutputTokens ?? extractionModels[0].model.maxOutputTokens
    if (run.snapshot.extractionInput.mode !== 'agent_directory') throw new Error('PI_WORKSPACE_SNAPSHOT_REQUIRED: 旧需求评审输入模式不再支持执行')
    const requirementInputPlan = buildRequirementDirectoryInputPlan({
        workspacePath: required(run.snapshot.documentWorkspace?.logicalPath, '固定 Agent 文档工作目录不存在'),
        workspaceRootPath: run.snapshot.documentWorkspace?.rootLogicalPath,
        activeBranchPath: run.snapshot.documentWorkspace?.activeBranchLogicalPath,
        agentWorkspacePath: run.snapshot.documentWorkspace?.agentLogicalPath,
        assets: fixedContextAssets,
        definition: fixedDefinition,
        contextWindow: extractionModels[0].model.contextWindow,
        maxOutputTokens: fixedMaxOutputTokens,
      })
    if (requirementInputPlan.packageSha256 !== run.snapshot.extractionInput.packageSha256) throw new Error('固定正文输入包 Hash 已漂移')
    await this.reviewTransaction(run.id, lease, draft => {
      const current = required(draft.reviewRuns.find(item => item.id === run.id), '需求评审运行不存在')
      current.step = 'extracting_requirement_points'
      current.progress = 10
    })
    return this.executeStages({ run, snapshot: run.snapshot, requirementInputPlan, extractionModels, reviewModels, extractionConfiguration, reviewConfiguration, reviewDefinition: run.snapshot.agentDefinitions.requirementReview, signal, lease, retryable: infrastructureAttempt < maxInfrastructureAttempts })
  }

  async failPreparedRun(runId: string, lease: TaskLease | undefined, error: unknown, cancelled = false, retryable = false, retry?: { attempt: number; maxAttempts: number; nextAttemptAt?: string }) {
    const message = String(error instanceof Error ? error.message : error).replace(/https?:\/\/[^\s'"`]+/giu, '[已隐藏地址]').slice(0, 500)
    await this.reviewTransaction(runId, lease, state => {
      const run = required(state.reviewRuns.find(item => item.id === runId), '需求评审运行不存在')
      if (run.status !== 'running') return
      const now = new Date().toISOString()
      if (retry && !cancelled) {
        const retryAttempt = run.executionAttempts?.find(item => item.attempt === retry.attempt)
        run.retryEvents ??= []
        run.retryEvents.push({
          attempt: retry.attempt,
          maxAttempts: retry.maxAttempts,
          ...(retryAttempt?.activeAgentKey ? { agentKey: retryAttempt.activeAgentKey } : {}),
          status: retryable ? 'scheduled' : 'exhausted',
          error: message,
          occurredAt: now,
          ...(retry.nextAttemptAt ? { nextAttemptAt: retry.nextAttemptAt } : {}),
        })
      }
      if (retryable && !cancelled) {
        run.step = 'waiting_worker'
        run.finishedAt = undefined
      } else {
        run.status = cancelled ? 'cancelled' : 'failed'
        run.step = cancelled ? 'cancelled' : 'failed'
        run.finishedAt = now
      }
      run.error = message
      const attempt = latestRunningExecutionAttempt(run)
      if (attempt) {
        attempt.status = cancelled ? 'cancelled' : 'failed'
        attempt.finishedAt = now
        attempt.modelLabel = run.modelLabel
        attempt.error = message
        if (run.execution?.agentKey === 'requirement-point-extraction') attempt.executions.requirementPointExtraction = structuredClone(run.execution)
        if (run.execution?.agentKey === 'requirement-review') attempt.executions.requirementReview = structuredClone(run.execution)
      }
    })
  }

  private async executeStages(input: {
    run: ReviewRun
    snapshot: ReviewRunSnapshot
    requirementInputPlan: RequirementInputPlan
    extractionModels: AgentModelSelection[]
    reviewModels: AgentModelSelection[]
    extractionConfiguration: AgentConfigurationVersion | null
    reviewConfiguration: AgentConfigurationVersion | null
    reviewDefinition: ReviewRunSnapshot['agentDefinitions']['requirementReview']
    signal: AbortSignal
    lease?: TaskLease
    retryable?: boolean
  }) {
    const { run, snapshot, requirementInputPlan, extractionModels, reviewModels, extractionConfiguration, reviewConfiguration, reviewDefinition, signal, lease, retryable = false } = input
    const extractionModel = extractionModels[0]
    const reviewModel = reviewModels[0]
    const extractionEvents: AgentExecutionEvent[] = []
    const reviewEvents: AgentExecutionEvent[] = []
    let activeAgentKey: 'requirement-point-extraction' | 'requirement-review' = 'requirement-point-extraction'
    let activeModel = extractionModel
    try {
      const routedExtraction = await this.executeWithFallback({
        runId: run.id,
        agentKey: 'requirement-point-extraction',
        snapshot,
        models: extractionModels.filter(selection => supportsInputPlan(selection, requirementInputPlan, extractionConfiguration)),
        configuration: extractionConfiguration,
        signal,
        lease,
        onAttempt: selection => { activeModel = selection },
        createInput: (selection, modelRef) => ({
          snapshot,
          model: modelConnection(selection, modelRef, extractionConfiguration),
          requirementInputPlan,
          onEvent: async event => {
            extractionEvents.push(event)
            if (shouldCheckpointExecution(event)) await this.saveExecutionProgress(run.id, extractionEvents, 'requirement-point-extraction', lease)
          },
        }),
      })
      const extractionOutput = routedExtraction.output
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('AGENT_CANCELLED')
      const extraction = extractionOutput.candidate as CandidateRequirementPointExtraction
      const extractionValidation = await this.extractionValidator.validate(extraction, snapshot, extractionOutput.inputDeliveryManifest)
      if (!extractionValidation.valid) throw validationError(extractionValidation.issues)
      const extractionExecution = executionRecord(extractionOutput, 'requirement-point-extraction')
      await this.reviewTransaction(run.id, lease, draft => {
        const current = required(draft.reviewRuns.find(item => item.id === run.id), '需求评审运行不存在')
        current.extractionResult = structuredClone(extraction)
        current.inputDeliveryManifest = structuredClone(required(extractionOutput.inputDeliveryManifest, '输入投递证明不存在'))
        current.executions = { ...(current.executions ?? {}), requirementPointExtraction: extractionExecution }
        current.execution = extractionExecution
        const attempt = latestRunningExecutionAttempt(current)
        if (attempt) {
          attempt.executions.requirementPointExtraction = structuredClone(extractionExecution)
          attempt.activeAgentKey = 'requirement-review'
        }
        current.step = 'reviewing_requirements'
        current.progress = 60
      })

      activeAgentKey = 'requirement-review'
      return await this.executeReviewStage({ run, extraction, snapshot, reviewDefinition, reviewModel, reviewModels, reviewConfiguration, extractionExecution, reviewEvents, signal, lease, onModelAttempt: selection => { activeModel = selection } })
    } catch (error) {
      const failedModel = activeModel
      const events = activeAgentKey === 'requirement-point-extraction' ? extractionEvents : reviewEvents
      const message = await this.failRun(run.id, error, signal, failedModel, activeAgentKey, events, lease, retryable)
      throw new Error(message)
    }
  }

  private async executeReviewStage(input: {
    run: ReviewRun
    extraction: CandidateRequirementPointExtraction
    snapshot: ReviewRunSnapshot
    reviewDefinition: ReviewRunSnapshot['agentDefinitions']['requirementReview']
    reviewModel: AgentModelSelection
    reviewModels?: AgentModelSelection[]
    reviewConfiguration: AgentConfigurationVersion | null
    extractionExecution?: AgentExecutionRecord
    reviewEvents: AgentExecutionEvent[]
    signal: AbortSignal
    lease?: TaskLease
    reviewModelConnection?: ReturnType<typeof modelConnection>
    onModelAttempt?: (selection: AgentModelSelection) => void
  }) {
    const reviewSnapshot = { ...input.snapshot, agentDefinition: input.reviewDefinition }
    const routedReview = await this.executeWithFallback({
      runId: input.run.id,
      agentKey: 'requirement-review',
      snapshot: input.snapshot,
      models: input.reviewModels ?? [input.reviewModel],
      configuration: input.reviewConfiguration,
      signal: input.signal,
      lease: input.lease,
      onAttempt: input.onModelAttempt,
      createInput: (selection, modelRef) => ({
        snapshot: { ...reviewSnapshot, agentModelRefs: { ...reviewSnapshot.agentModelRefs!, requirementReview: modelRef } },
        model: input.reviewModelConnection && selection === input.reviewModel ? input.reviewModelConnection : modelConnection(selection, modelRef, input.reviewConfiguration),
        fixedRequirementPointExtraction: input.extraction,
        onEvent: async event => {
          input.reviewEvents.push(event)
          if (shouldCheckpointExecution(event)) await this.saveExecutionProgress(input.run.id, input.reviewEvents, 'requirement-review', input.lease)
        },
      }),
    })
    const reviewOutput = routedReview.output
    if (input.signal.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new Error('AGENT_CANCELLED')
    const review = reviewOutput.candidate as CandidateRequirementReview
    const reviewValidation = await this.reviewValidator.validate(review, input.extraction, reviewSnapshot)
    if (!reviewValidation.valid) throw validationError(reviewValidation.issues)
    const result = { ...structuredClone(input.extraction), ...structuredClone(review) }
    const validation = await this.validator.validate(result, reviewSnapshot)
    if (!validation.valid) throw validationError(validation.issues)
    const reviewExecution = executionRecord(reviewOutput, 'requirement-review')
    const finishedAt = new Date().toISOString()
    await this.reviewTransaction(input.run.id, input.lease, draft => {
      const current = required(draft.reviewRuns.find(item => item.id === input.run.id), '需求评审运行不存在')
      Object.assign(current, {
        status: 'succeeded', step: 'completed', progress: 100, finishedAt, extractionResult: input.extraction, result,
        execution: undefined,
        executions: {
          ...(input.extractionExecution ? { requirementPointExtraction: input.extractionExecution } : {}),
          requirementReview: reviewExecution,
        },
        error: undefined,
      } satisfies Partial<ReviewRun>)
      const attempt = latestRunningExecutionAttempt(current)
      if (attempt) {
        attempt.activeAgentKey = 'requirement-review'
        attempt.status = 'succeeded'
        attempt.finishedAt = finishedAt
        attempt.modelLabel = current.modelLabel
        attempt.executions = structuredClone(current.executions ?? {})
      }
    })
    const completed = await this.get(input.run.id)
    return required(completed.response, '需求评审结果不存在')
  }

  private async failRun(runId: string, error: unknown, signal: AbortSignal, failedModel: AgentModelSelection, agentKey: 'requirement-point-extraction' | 'requirement-review', events: AgentExecutionEvent[], lease?: TaskLease, retryable = false) {
    const message = sanitizeRuntimeError(error, failedModel.source.baseUrl, failedModel.source.apiKey)
    const cancelled = /AGENT_CANCELLED_BY_USER|用户已取消|客户端已中断/u.test(message)
    await this.reviewTransaction(runId, lease, draft => {
      const current = required(draft.reviewRuns.find(item => item.id === runId), '需求评审运行不存在')
      Object.assign(current, retryable && !cancelled
        ? {
            status: 'running', step: 'waiting_worker', progress: current.progress, finishedAt: undefined, error: message,
            ...(events.length ? { execution: executionProgress(events, agentKey) } : {}),
          } satisfies Partial<ReviewRun>
        : {
            status: cancelled ? 'cancelled' : 'failed', step: cancelled ? 'cancelled' : 'failed', progress: current.progress, finishedAt: new Date().toISOString(), error: message,
            ...(events.length ? { execution: executionProgress(events, agentKey) } : {}),
          } satisfies Partial<ReviewRun>)
      const attempt = latestRunningExecutionAttempt(current)
      if (attempt) {
        attempt.activeAgentKey = agentKey
        attempt.status = cancelled ? 'cancelled' : 'failed'
        attempt.finishedAt = new Date().toISOString()
        attempt.modelLabel = current.modelLabel
        attempt.error = message
        if (events.length) attempt.executions[agentKey === 'requirement-point-extraction' ? 'requirementPointExtraction' : 'requirementReview'] = executionProgress(events, agentKey)
      }
      if (message.startsWith('MODEL_TOOL_CALL_REQUIRED:')) {
        const currentSource = draft.modelSources.find(item => item.id === failedModel.source.id)
        const currentModel = currentSource?.models.find(item => item.id === failedModel.model.id)
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
    return message
  }

  private async executeWithFallback(input: {
    runId: string
    agentKey: 'requirement-point-extraction' | 'requirement-review'
    snapshot: ReviewRunSnapshot
    models: AgentModelSelection[]
    configuration: AgentConfigurationVersion | null
    signal: AbortSignal
    lease?: TaskLease
    createInput: (selection: AgentModelSelection, modelRef: ReviewRunSnapshot['modelRef']) => AgentExecutionInput
    onAttempt?: (selection: AgentModelSelection) => void
  }) {
    if (!input.models.length) throw new Error(`${input.agentKey === 'requirement-point-extraction' ? '需求点提取' : '需求评审'} Agent 没有满足固定输入上下文和工具能力的可用模型`)
    let previousFailure: { selection: AgentModelSelection; message: string } | undefined
    for (let index = 0; index < input.models.length; index += 1) {
      const selection = input.models[index]
      input.onAttempt?.(selection)
      const maxOutputTokens = input.configuration?.routing.maxOutputTokens ?? selection.model.maxOutputTokens
      const modelRef = modelSnapshot(selection, maxOutputTokens)
      const attemptId = `model_attempt_${randomUUID()}`
      const startedAt = new Date().toISOString()
      await this.reviewTransaction(input.runId, input.lease, state => {
        const run = required(state.reviewRuns.find(item => item.id === input.runId), '需求评审运行不存在')
        run.modelRouteAttempts ??= []
        run.modelRouteAttempts.push({ id: attemptId, agentKey: input.agentKey, sourceId: selection.source.id, modelId: selection.model.id, modelLabel: `${selection.source.name} · ${selection.model.displayName}`, status: 'running', startedAt })
        run.snapshot.agentModelRefs = { ...run.snapshot.agentModelRefs!, [input.agentKey === 'requirement-point-extraction' ? 'requirementPointExtraction' : 'requirementReview']: modelRef }
        if (input.agentKey === 'requirement-point-extraction') run.snapshot.modelRef = modelRef
        if (previousFailure) {
          run.degradations ??= []
          run.degradations.push({ agentKey: input.agentKey, fromSourceId: previousFailure.selection.source.id, fromModelId: previousFailure.selection.model.id, toSourceId: selection.source.id, toModelId: selection.model.id, reason: previousFailure.message, occurredAt: startedAt })
        }
        const extractionRef = run.snapshot.agentModelRefs.requirementPointExtraction
        const reviewRef = run.snapshot.agentModelRefs.requirementReview
        run.sourceId = extractionRef.sourceId
        run.modelId = extractionRef.modelId
        run.modelLabel = `需求点提取：${modelDisplay(state, extractionRef)}；需求评审：${modelDisplay(state, reviewRef)}`
      })
      input.snapshot.agentModelRefs = { ...input.snapshot.agentModelRefs!, [input.agentKey === 'requirement-point-extraction' ? 'requirementPointExtraction' : 'requirementReview']: modelRef }
      if (input.agentKey === 'requirement-point-extraction') input.snapshot.modelRef = modelRef
      try {
        const output = await this.runtime.execute(input.createInput(selection, modelRef), input.signal)
        await this.finishModelAttempt(input.runId, attemptId, 'succeeded', undefined, input.lease)
        return { output, selection }
      } catch (error) {
        const message = sanitizeRuntimeError(error, selection.source.baseUrl, selection.source.apiKey)
        const status = input.signal.aborted ? 'cancelled' : 'failed'
        await this.finishModelAttempt(input.runId, attemptId, status, message, input.lease)
        const canFallback = Boolean(input.configuration?.routing.fallbackEnabled && index + 1 < input.models.length && isFallbackEligible(message) && !input.signal.aborted)
        if (!canFallback) throw error
        previousFailure = { selection, message }
      }
    }
    throw new Error(previousFailure?.message ?? '模型路由失败')
  }

  private async finishModelAttempt(runId: string, attemptId: string, status: 'succeeded' | 'failed' | 'cancelled', error?: string, lease?: TaskLease) {
    await this.reviewTransaction(runId, lease, state => {
      const run = required(state.reviewRuns.find(item => item.id === runId), '需求评审运行不存在')
      const attempt = required(run.modelRouteAttempts?.find(item => item.id === attemptId), '模型调用记录不存在')
      attempt.status = status
      attempt.finishedAt = new Date().toISOString()
      if (error) attempt.error = error
    })
  }

  private async reviewTransaction<T>(runId: string, lease: TaskLease | undefined, operation: (draft: DatabaseState) => T | Promise<T>) {
    if (!lease || !this.store.transactionWithReviewLease) return this.store.transaction(operation)
    const result = await this.store.transactionWithReviewLease(runId, lease, operation)
    if (result === null) throw new Error('REVIEW_JOB_FENCING_REJECTED: Worker 租约已失效，晚到结果不得发布')
    return result
  }

  private async loadStoredRun(runId: string) {
    const run = this.store.getReviewRun
      ? await this.store.getReviewRun(runId)
      : (await this.store.snapshot()).reviewRuns.find(item => item.id === runId)
    return required(run, '需求评审运行不存在')
  }

  private async saveExecutionProgress(runId: string, events: AgentExecutionEvent[], agentKey: 'requirement-point-extraction' | 'requirement-review', lease?: TaskLease) {
    const execution = executionProgress(events, agentKey)
    if (!lease && this.store.saveReviewRunExecution) return this.store.saveReviewRunExecution(runId, execution)
    await this.reviewTransaction(runId, lease, draft => {
      const current = required(draft.reviewRuns.find(item => item.id === runId), '需求评审运行不存在')
      current.execution = execution
      const attempt = latestRunningExecutionAttempt(current)
      if (attempt) {
        attempt.activeAgentKey = agentKey
        attempt.executions[agentKey === 'requirement-point-extraction' ? 'requirementPointExtraction' : 'requirementReview'] = structuredClone(execution)
      }
    })
  }

  private async beginExecutionAttempt(runId: string, lease: TaskLease | undefined, attemptNumber: number, maxAttempts: number) {
    await this.reviewTransaction(runId, lease, draft => {
      const run = required(draft.reviewRuns.find(item => item.id === runId), '需求评审运行不存在')
      if (run.status !== 'running') throw new Error('需求评审运行已结束，不能创建新的 Worker 尝试记录')
      const retainedExtraction = run.retryMode === 'review_only' ? run.executions?.requirementPointExtraction : undefined
      run.execution = undefined
      run.executions = retainedExtraction ? { requirementPointExtraction: structuredClone(retainedExtraction) } : undefined
      run.executionAttempts ??= []
      const startedAt = new Date().toISOString()
      for (const previous of run.executionAttempts) {
        if (previous.status !== 'running' || previous.attempt >= Math.max(1, attemptNumber)) continue
        previous.status = 'failed'
        previous.finishedAt = previous.finishedAt ?? startedAt
        previous.error = previous.error ?? 'WORKER_ATTEMPT_SUPERSEDED: 后续重试已开始，本次尝试未完成'
      }
      const value = {
        attempt: Math.max(1, attemptNumber), maxAttempts: Math.max(1, maxAttempts), status: 'running' as const,
        activeAgentKey: run.retryMode === 'review_only' ? 'requirement-review' as const : 'requirement-point-extraction' as const,
        startedAt, modelLabel: run.modelLabel,
        executions: retainedExtraction ? { requirementPointExtraction: structuredClone(retainedExtraction) } : {},
      }
      const existing = run.executionAttempts.findIndex(item => item.attempt === value.attempt)
      if (existing >= 0) run.executionAttempts[existing] = value
      else run.executionAttempts.push(value)
    })
  }
}

function latestRunningExecutionAttempt(run: ReviewRun) {
  return [...(run.executionAttempts ?? [])].reverse().find(item => item.status === 'running')
}

function presentRunSummary(run: ReviewRun) {
  const assets = snapshotAssets(run)
  return {
    id: run.id,
    reviewId: reviewIdFor(run),
    runId: run.id,
    retryOfRunId: run.retryOfRunId,
    retryMode: run.retryMode,
    reusedExtractionFromRunId: run.reusedExtractionFromRunId,
    hasFrozenExtraction: hasFrozenExtraction(run),
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
    queue: run.queue,
    retryEvents: run.retryEvents,
    modelRouteAttempts: run.modelRouteAttempts,
    degradations: run.degradations,
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
    reviewId: reviewIdFor(run),
    runId: run.id,
    retryOfRunId: run.retryOfRunId,
    retryMode: run.retryMode,
    reusedExtractionFromRunId: run.reusedExtractionFromRunId,
    hasFrozenExtraction: hasFrozenExtraction(run),
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
    queue: run.queue,
    retryEvents: run.retryEvents,
    modelRouteAttempts: run.modelRouteAttempts,
    degradations: run.degradations,
    executionAttempts: run.executionAttempts,
    snapshot: redactSnapshot(run.snapshot),
    execution: response ? undefined : run.execution,
    executions: response ? undefined : run.executions,
    extractionResult: response ? undefined : run.extractionResult,
    inputDeliveryManifest: response ? undefined : run.inputDeliveryManifest,
    response,
  }
}

function hasFrozenExtraction(run: ReviewRun) {
  const projected = (run as ReviewRun & { hasFrozenExtraction?: unknown }).hasFrozenExtraction
  return typeof projected === 'boolean' ? projected : Boolean(run.extractionResult && run.inputDeliveryManifest)
}

function requirementDocumentWorkspace(projectVersion: DatabaseState['projectVersions'][number], projectVersions: DatabaseState['projectVersions'], logicalPath: string): NonNullable<ReviewRunSnapshot['documentWorkspace']> {
  const rootLogicalPath = 'workspace'
  if (logicalPath !== rootLogicalPath && !logicalPath.startsWith(`${rootLogicalPath}/`)) return { mode: 'agent_directory', logicalPath, candidateAssetVersionIds: [] }
  const activeBranchLogicalPath = `${rootLogicalPath}/branches/${safeWorkspaceSegment(projectVersion.name)}`
  const branchLogicalPaths = [...new Set(projectVersions
    .filter(item => item.projectId === projectVersion.projectId)
    .map(item => `${rootLogicalPath}/branches/${safeWorkspaceSegment(item.name)}`))]
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
  return {
    mode: 'agent_directory',
    logicalPath,
    rootLogicalPath,
    activeBranchLogicalPath,
    branchLogicalPaths,
    agentLogicalPath: `${rootLogicalPath}/agent_workspace/requirement_agent`,
    layoutVersion: 'workspace/v1',
    candidateAssetVersionIds: [],
  }
}

function safeWorkspaceSegment(value: string) {
  const encodeCharacter = (character: string) => `%${character.codePointAt(0)!.toString(16).toUpperCase().padStart(2, '0')}`
  const source = value.normalize('NFC').trim() || '未命名版本'
  let safe = source
    .replace(/[%<>:"/\\|?*\u0000-\u001F]/gu, encodeCharacter)
    .replace(/[. ]+$/gu, characters => [...characters].map(encodeCharacter).join(''))
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(source)) safe = `${encodeCharacter(source[0])}${safe.slice(1)}`
  return safe
}

function normalizeDocumentDirectoryPath(value: unknown) {
  const normalized = String(value ?? '').trim().replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
  const segments = normalized.split('/')
  if (!normalized || /^[A-Za-z]:/u.test(normalized) || segments.some(segment => !segment || segment === '.' || segment === '..')) throw new Error('Agent 文档工作目录必须是知识库内的有效逻辑目录')
  return normalized
}

function isWithinDirectory(logicalPath: string, directoryPath: string) {
  const normalized = logicalPath.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
  return normalized.startsWith(`${directoryPath}/`) && normalized.length > directoryPath.length + 1
}

function reviewIdFor(run: ReviewRun) {
  return run.reviewId ?? run.snapshot.reviewId ?? `review_${run.retryOfRunId ?? run.id}`
}

type AgentModelSelection = {
  source: DatabaseState['modelSources'][number]
  model: DatabaseState['modelSources'][number]['models'][number]
}

function selectAgentModels(state: DatabaseState, configuration: AgentConfigurationVersion | null, requestModel: { sourceId: string; modelId: string } | null, label: string): AgentModelSelection[] {
  const configuredModels = configuration?.routing.primaryModel
    ? [configuration.routing.primaryModel, ...(configuration.routing.fallbackEnabled ? configuration.routing.fallbackModels : [])]
    : []
  const selectedReferences = (configuration ? configuredModels : requestModel ? [requestModel] : []).filter(reference => {
    const candidateSource = state.modelSources.find(item => item.id === reference.sourceId && item.enabled)
    const candidateModel = candidateSource?.models.find(item => item.id === reference.modelId && item.enabled)
    return Boolean(candidateModel && candidateModel.health === 'healthy' && candidateModel.capabilities.includes('tool_calling'))
  })
  if (!selectedReferences.length && configuration) throw new Error(`${label}已发布配置中的默认和回退模型当前均不可用`)
  if (!selectedReferences.length) throw new Error(`请先完成${label}模型的连通性探测并确保健康状态正常`)
  return selectedReferences.map(reference => {
    const source = required(state.modelSources.find(item => item.id === reference.sourceId && item.enabled), configuration ? `${label}已发布配置的生成式模型来源不可用` : '生成式模型来源不可用')
    const model = required(source.models.find(item => item.id === reference.modelId && item.enabled), configuration ? `${label}已发布配置的生成式模型不可用` : '生成式模型不可用')
    return { source, model }
  })
}

function supportsInputPlan(selection: AgentModelSelection, plan: RequirementInputPlan, configuration: AgentConfigurationVersion | null) {
  if (plan.mode !== 'agent_directory') return false
  const output = configuration?.routing.maxOutputTokens ?? selection.model.maxOutputTokens
  const largestBatch = Math.max(...plan.batches.map(batch => batch.tokenCount), 0)
  const requiredInput = largestBatch + 4_000
  return selection.model.contextWindow >= requiredInput + output
}

function requirePiWorkspaceAgentDefinition(definition: ReviewRunSnapshot['agentDefinition']) {
  const requiredTools = ['workspace.read_file', 'workspace.grep_files', 'workspace.find_files', 'workspace.list_directory', 'requirement-points.submit_result']
  const missingTools = requiredTools.filter(toolId => !definition.toolIds.includes(toolId))
  const retiredTools = definition.toolIds.filter(toolId => toolId === 'knowledge.search' || toolId === 'knowledge.read_chunk')
  if (definition.resultSchemaVersion !== 'requirement-point-extraction/v5' || missingTools.length || retiredTools.length) {
    throw new Error(`PI_WORKSPACE_AGENT_CONFIGURATION_REQUIRED: 请重新发布基于 /workspace 的需求点提取 Agent 配置${missingTools.length ? `；缺少工具 ${missingTools.join(', ')}` : ''}${retiredTools.length ? `；不再支持工具 ${retiredTools.join(', ')}` : ''}`)
  }
}

function isFallbackEligible(message: string) {
  return /^(MODEL_RATE_LIMITED|MODEL_PROVIDER_UNAVAILABLE|MODEL_REQUEST_FAILED|MODEL_AUTHENTICATION_FAILED|MODEL_TOOL_CALL_REQUIRED|MODEL_TIMEOUT):/u.test(message)
}

function modelDisplay(state: DatabaseState, reference: ReviewRunSnapshot['modelRef']) {
  const source = state.modelSources.find(item => item.id === reference.sourceId)
  const model = source?.models.find(item => item.id === reference.modelId)
  return source && model ? `${source.name} · ${model.displayName}` : `${reference.sourceId} · ${reference.modelId}`
}

function modelSnapshot(selection: AgentModelSelection, maxOutputTokens: number): ReviewRunSnapshot['modelRef'] {
  const { source, model } = selection
  return { sourceId: source.id, modelId: model.id, providerType: source.providerType, modelName: model.name, contextWindow: model.contextWindow, maxOutputTokens, supportsReasoning: model.capabilities.includes('reasoning') }
}

function modelConnection(selection: AgentModelSelection, snapshot: ReviewRunSnapshot['modelRef'], configuration: AgentConfigurationVersion | null) {
  const { source, model } = selection
  return { sourceId: source.id, providerType: source.providerType, baseUrl: source.baseUrl, apiKey: source.apiKey, modelId: model.id, modelName: model.name, contextWindow: model.contextWindow, maxOutputTokens: snapshot.maxOutputTokens, supportsReasoning: model.capabilities.includes('reasoning'), requestTimeoutMs: configuration ? configuration.routing.requestTimeoutSeconds * 1_000 : undefined, retryCount: configuration?.routing.retryCount }
}

function configurationRef(configuration: AgentConfigurationVersion) {
  return { id: configuration.id, version: configuration.version, contentSha256: configuration.contentSha256 }
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
    ...(run.executionAttempts ?? []).flatMap(attempt => [
      ...(attempt.executions.requirementPointExtraction?.events ?? []),
      ...(attempt.executions.requirementReview?.events ?? []),
    ]),
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
function validationIssueSummary(issues: Array<{ path: string; message: string }>) {
  return issues.slice(0, 3).map(issue => `${issue.path} ${issue.message}`).join('；')
}
function sanitizeRuntimeError(error: unknown, endpoint: string, credential: string) {
  let message = error instanceof Error ? error.message : '需求分析 Agent 执行失败'
  if (credential) message = message.replaceAll(credential, '[已隐藏凭据]')
  if (endpoint) message = message.replaceAll(endpoint, '[模型端点]')
  return message.replace(/https?:\/\/[^\s'"`]+/giu, '[已隐藏地址]').slice(0, 500)
}
