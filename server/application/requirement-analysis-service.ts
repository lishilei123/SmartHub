import { createHash, randomUUID } from 'node:crypto'
import type { AgentDefinitionResolver, AgentExecutionEvent, AgentExecutionInput, AgentExecutionOutput, AgentRuntime, RequirementInputPlan, ReviewRunSnapshot } from '../domain/agent-types.js'
import type { AgentConfigurationVersion, AgentExecutionRecord, DatabaseState, ReviewRun } from '../domain/types.js'
import { activateRequirementReleaseBinding } from '../domain/requirement-release-bindings.js'
import type { CandidateRequirementAnalysisV1, PlanningClarification, RequirementAnalysisResult } from '../domain/review-types.js'
import type { Principal } from '../domain/access-control.js'
import type { RequirementReleaseCandidate, RequirementReleasePackage, RequirementUnderstandingSnapshot, RequirementWorkflowStage, RequirementWorkflowState } from '../domain/requirement-workflow-types.js'
import type { StateStore, TaskLease } from '../infrastructure/store.js'
import { RequirementAnalysisValidator } from '../agent/result-validator.js'
import { defaultAgentDefinitionResolver } from '../agent/dynamic-agent-definition-resolver.js'
import { buildRequirementDirectoryInputPlan } from '../agent/requirement-context-assembler.js'
import { renderPlanningRequirementTask } from '../agent/planning-agent.js'
import { buildRequirementReleaseArtifacts } from './requirement-release-artifacts.js'
import { buildCurrentInputRefs, buildProjectWorkspaceSnapshot } from './project-workspace-snapshot.js'
import { renderRequirementAnalysisArtifacts } from '../agent/requirement-analysis-artifacts.js'

const REQUIREMENT_WORKSPACE_TOOL_IDS = [
  'workspace.read_file',
  'workspace.grep_files',
  'workspace.find_files',
  'workspace.list_directory',
  'knowledge.search',
  'knowledge.read_chunk',
] as const

export interface RequirementAnalysisRequest {
  projectVersionId: string
  documentDirectoryPath: string
  analysisId?: string
  sourceId?: string
  modelId?: string
  focusAreas?: string[]
  excludedAreas?: string[]
  retryOfRunId?: string
  retryMode?: 'full'
  formalClarifications?: PlanningClarification[]
}

export type RequirementAnalysisRetryMode = 'full'

interface PlanningRequirementRuntime extends AgentRuntime {
  appendPlanningClarification?(input: { projectId: string; projectVersionId: string; runId: string; clarificationId: string; question: string; answer: string; status: 'answered' | 'dismissed'; answeredAt: string; answeredBy: string }): Promise<unknown>
}

export class RequirementAnalysisService {
  private readonly validator: RequirementAnalysisValidator
  private readonly activeRuns = new Map<string, AbortController>()
  private understandingReadyListener?: (runId: string) => void | Promise<void>

  constructor(private readonly store: StateStore, private readonly runtime: PlanningRequirementRuntime, private readonly definitions: AgentDefinitionResolver = defaultAgentDefinitionResolver) {
    this.validator = new RequirementAnalysisValidator(store)
  }

  onUnderstandingReady(listener: (runId: string) => void | Promise<void>) {
    this.understandingReadyListener = listener
  }

  async recoverInterruptedRuns() {
    if (this.store.claimReviewJob) return 0
    const finishedAt = new Date().toISOString()
    const error = 'REQUIREMENT_ANALYSIS_RUN_INTERRUPTED: 服务进程在 Agent 执行期间重启，本次运行已终止；请重新发起分析'
    if (this.store.recoverInterruptedReviewRuns) return this.store.recoverInterruptedReviewRuns(finishedAt, error)
    let recovered = 0
    await this.store.transaction(state => {
      state.reviewRuns.forEach(run => {
        if (run.status !== 'running') return
        recovered += 1
        Object.assign(run, { status: 'failed', step: 'failed', finishedAt, error } satisfies Partial<ReviewRun>)
      })
    })
    return recovered
  }

  async list(projectVersionId: string, options: { limit?: number; cursor?: string; runningOnly?: boolean } = {}) {
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 50)), 100)
    const projectVersion = this.store.getProjectVersion ? await this.store.getProjectVersion(projectVersionId) : (await this.store.snapshot()).projectVersions.find(item => item.id === projectVersionId)
    required(projectVersion, '项目版本不存在')
    if (this.store.listReviewRuns) {
      const page = await this.store.listReviewRuns(projectVersionId, { limit, cursor: options.cursor, runningOnly: options.runningOnly })
      return { items: page.items.map(presentRunSummary), nextCursor: page.nextCursor }
    }
    const runs = (await this.store.snapshot()).reviewRuns
      .filter(item => item.projectVersionId === projectVersionId && (!options.runningOnly || item.status === 'running'))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    const offset = decodeCursor(options.cursor, runs)
    const items = runs.slice(offset, offset + limit)
    const last = items.at(-1)
    return { items: items.map(presentRunSummary), nextCursor: offset + limit < runs.length && last ? encodeCursor(last) : undefined }
  }

  async get(runId: string) {
    const run = this.store.getReviewRun ? await this.store.getReviewRun(runId) : (await this.store.snapshot()).reviewRuns.find(item => item.id === runId)
    return presentRun(required(run, '需求分析运行不存在'))
  }

  async actOnClarifications(runId: string, input: { items: Array<{ clarificationId: string; action: 'answer' | 'dismiss'; answer: string }>; principal?: Principal }) {
    const answeredAt = new Date().toISOString()
    const answeredBy = principalId(input.principal)
    const updated = await this.store.transaction(state => {
      const run = required(state.reviewRuns.find(item => item.id === runId), '需求分析运行不存在')
      requireOpenProjectVersion(state, run.projectVersionId)
      if (!run.result || !run.execution) throw new Error('Clarification 只能处理已完成一轮分析的正式候选')
      if (run.workflow?.understandingSnapshot || run.workflow?.release?.status === 'published') throw new Error('REQUIREMENT_UNDERSTANDING_ALREADY_FROZEN: 当前需求理解已冻结，不能回写 Clarification')
      const pendingBlocking = run.result.clarifications.filter(item => item.blocking && item.status === 'pending')
      if (!pendingBlocking.length) {
        throw new Error('CLARIFICATION_BATCH_NOT_REQUIRED: 当前没有待回答的阻断问题')
      }
      const submitted = new Map<string, { action: 'answer' | 'dismiss'; answer: string }>()
      for (const item of input.items) {
        const clarificationId = String(item?.clarificationId ?? '')
        const action = item?.action
        const answer = String(item?.answer ?? '').trim()
        if (!clarificationId || submitted.has(clarificationId)) throw new Error('CLARIFICATION_BATCH_INVALID: 问题 ID 为空或重复')
        if (action !== 'answer' && action !== 'dismiss') throw new Error('CLARIFICATION_BATCH_INVALID: 处置动作不合法')
        if (!answer) throw new Error(action === 'dismiss' ? 'CLARIFICATION_BATCH_INVALID: 忽略问题必须说明理由' : 'CLARIFICATION_BATCH_INVALID: 每个阻断问题都必须填写明确业务事实')
        submitted.set(clarificationId, { action, answer })
      }
      if (submitted.size !== pendingBlocking.length || pendingBlocking.some(item => !submitted.has(item.id))) throw new Error('CLARIFICATION_BATCH_INCOMPLETE: 必须一次性回答当前全部阻断问题')
      const resolved = pendingBlocking.map(clarification => {
        const item = required(submitted.get(clarification.id), 'Clarification 回答不存在')
        clarification.status = item.action === 'answer' ? 'answered' : 'dismissed'
        clarification.answer = item.answer.slice(0, 20_000)
        clarification.answeredAt = answeredAt
        clarification.answeredBy = answeredBy
        return structuredClone(clarification)
      })
      refreshAnalysisArtifacts(run.result)
      run.snapshot.formalClarifications = mergeFormalClarifications(run.snapshot.formalClarifications, run.result.clarifications)
      run.workflow ??= { currentStage: 'understanding' }
      run.workflow.currentStage = 'understanding'
      run.workflow.automaticTransition = { status: 'pending' }
      Object.assign(run, {
        status: 'succeeded',
        step: 'requirement_understanding_ready',
        progress: 100,
        finishedAt: answeredAt,
        error: undefined,
      } satisfies Partial<ReviewRun>)
      return {
        clarifications: resolved,
        projectId: run.snapshot.projectId,
        projectVersionId: run.projectVersionId,
      }
    })
    for (const clarification of updated.clarifications) {
      await this.runtime.appendPlanningClarification?.({
        projectId: updated.projectId,
        projectVersionId: updated.projectVersionId,
        runId,
        clarificationId: clarification.id,
        question: clarification.question,
        answer: clarification.answer!,
        status: clarification.status as 'answered' | 'dismissed',
        answeredAt,
        answeredBy,
      })
    }
    await this.notifyUnderstandingReady(runId)
    return { clarifications: updated.clarifications, run: await this.get(runId) }
  }

  async freezeUnderstanding(runId: string) {
    return this.store.transaction(state => {
      const run = required(state.reviewRuns.find(item => item.id === runId), '需求分析运行不存在')
      requireSucceededRun(run)
      const projectVersion = requireOpenProjectVersion(state, run.projectVersionId)
      const result = required(run.result, '需求分析结果不存在')
      const pendingBlocking = result.clarifications.filter(item => item.blocking && item.status === 'pending')
      if (pendingBlocking.length) throw new Error(`REQUIREMENT_CLARIFICATION_REQUIRED: ${pendingBlocking.map(item => item.id).join('、')}`)
      const timestamp = new Date().toISOString()
      for (const item of result.clarifications.filter(candidate => !candidate.blocking && candidate.status === 'pending')) {
        item.status = 'dismissed'
        item.answer = '该问题不影响当前测试设计正确性，作为非阻断风险记录。'
        item.answeredAt = timestamp
        item.answeredBy = 'system:requirement-understanding-freezer'
      }
      refreshAnalysisArtifacts(result)
      run.snapshot.formalClarifications = mergeFormalClarifications(run.snapshot.formalClarifications, result.clarifications)
      run.workflow ??= { currentStage: 'understanding' }
      if (run.workflow.understandingSnapshot && run.workflow.release?.status === 'published') return { snapshot: structuredClone(run.workflow.understandingSnapshot), release: structuredClone(run.workflow.release) }
      assertRequirementInputsStable(state, run)
      const requirementResultSha256 = sha256Text(JSON.stringify({
        requirementPoints: result.requirementPoints,
        evidence: result.evidence,
        clarifications: result.clarifications,
        testFocus: result.testFocus,
      }))
      const understandingBase = {
        id: `requirement_understanding_${randomUUID()}`,
        schemaVersion: 'requirement-understanding-snapshot/v1' as const,
        projectVersionId: run.projectVersionId,
        analysisRunId: run.id,
        sourceAssetVersionIds: run.snapshot.assets.map(item => item.assetVersionId),
        requirementPointIds: result.requirementPoints.map(item => item.clientRequirementPointId),
        clarifications: structuredClone(result.clarifications),
        requirementResultSha256,
        createdAt: timestamp,
      }
      const understanding: RequirementUnderstandingSnapshot = { ...understandingBase, contentSha256: sha256Text(JSON.stringify(understandingBase)) }
      const releaseId = `requirement_release_${randomUUID()}`
      const candidate: RequirementReleaseCandidate = {
        schemaVersion: 'requirement-release-candidate/v1',
        sourceAssetVersionIds: [...understanding.sourceAssetVersionIds],
        refinedRequirementsMarkdown: required(result.artifacts.find(item => item.fileName === 'requirement-baseline.md'), 'Requirement Baseline 不存在').content,
      }
      const built = buildRequirementReleaseArtifacts({ state, releaseId, verificationRun: run, candidate, generatedAt: timestamp })
      const release: RequirementReleasePackage = {
        id: releaseId,
        schemaVersion: 'requirement-release-package/v1',
        status: 'published',
        projectVersionId: run.projectVersionId,
        verificationRunId: run.id,
        sourceAssetVersionIds: [...understanding.sourceAssetVersionIds],
        candidate,
        generationExecution: { ...required(run.execution, '需求分析执行记录不存在'), workflowStage: 'analysis' },
        artifacts: built.artifacts,
        contentSha256: built.contentSha256,
        createdAt: timestamp,
        createdBy: 'system:requirement-understanding-freezer',
        publishedAt: timestamp,
        publishedBy: 'system:requirement-understanding-freezer',
      }
      run.workflow.currentStage = 'understanding'
      run.workflow.understandingSnapshot = understanding
      run.workflow.release = release
      run.workflow.automaticTransition = { status: 'running', startedAt: timestamp }
      const requirementsArtifact = required(release.artifacts.find(item => item.fileName === 'requirements.json' && item.mediaType === 'application/json'), '需求理解快照缺少 requirements.json')
      activateRequirementReleaseBinding(projectVersion, { releaseId: release.id, verificationRunId: run.id, requirementsJsonSha256: requirementsArtifact.contentSha256, boundAt: timestamp })
      projectVersion.updatedAt = timestamp
      return { snapshot: structuredClone(understanding), release: structuredClone(release) }
    })
  }

  async start(request: RequirementAnalysisRequest) {
    if (this.store.enqueueReviewJob) {
      const created = await this.analyze(request, new AbortController().signal, undefined, true)
      const runId = 'id' in created ? created.id : created.runId
      const timestamp = new Date().toISOString()
      await this.store.enqueueReviewJob({ id: `analysis_job_${randomUUID()}`, runId, projectVersionId: request.projectVersionId, status: 'queued', attempts: 0, maxAttempts: 3, availableAt: timestamp, createdAt: timestamp, updatedAt: timestamp })
      return created
    }
    const controller = new AbortController()
    let runId = ''
    return await new Promise<ReturnType<typeof presentRun>>((resolve, reject) => {
      void this.analyze(request, controller.signal, run => {
        runId = run.id
        this.activeRuns.set(runId, controller)
        resolve(run)
      }).catch(error => { if (!runId) reject(error) }).finally(() => {
        if (runId && this.activeRuns.get(runId) === controller) this.activeRuns.delete(runId)
      })
    })
  }

  async retry(runId: string, mode: RequirementAnalysisRetryMode) {
    if (mode !== 'full') throw new Error('单 Agent 需求分析只支持全部重跑')
    const sourceRun = await this.loadStoredRun(runId)
    if (sourceRun.status === 'running') throw new Error('正在执行的需求分析不能重跑，请先取消运行')
    if (sourceRun.status === 'succeeded') throw new Error('已成功的需求分析不能作为失败重试来源，请直接发起新运行')
    return this.start({
      projectVersionId: sourceRun.projectVersionId,
      documentDirectoryPath: required(sourceRun.snapshot.documentWorkspace?.logicalPath, 'PI_WORKSPACE_SNAPSHOT_REQUIRED: 运行缺少固定工作区目录'),
      analysisId: analysisIdFor(sourceRun),
      focusAreas: sourceRun.snapshot.focusAreas,
      excludedAreas: sourceRun.snapshot.excludedAreas,
      retryOfRunId: sourceRun.id,
      retryMode: 'full',
      formalClarifications: structuredClone(sourceRun.snapshot.formalClarifications ?? []),
    })
  }

  async cancel(runId: string) {
    const run = required((await this.store.snapshot()).reviewRuns.find(item => item.id === runId), '需求分析运行不存在')
    if (run.status !== 'running') return presentRun(run)
    await this.store.cancelReviewJob?.(runId)
    await this.store.transaction(draft => {
      const current = required(draft.reviewRuns.find(item => item.id === runId), '需求分析运行不存在')
      if (current.status === 'running') Object.assign(current, { status: 'cancelled', step: 'cancelled', finishedAt: new Date().toISOString(), error: '用户已取消本次分析' } satisfies Partial<ReviewRun>)
    })
    this.activeRuns.get(runId)?.abort(new Error('AGENT_CANCELLED_BY_USER'))
    return this.get(runId)
  }

  async createReleaseCandidate(runId: string, input: { principal?: Principal }, signal = new AbortController().signal) {
    const state = await this.store.snapshot()
    const run = required(state.reviewRuns.find(item => item.id === runId), '复验运行不存在')
    assertReleaseGate(state, run)
    if (run.workflow?.release) return structuredClone(run.workflow.release)
    const expectedAssetVersionIds = run.snapshot.assets.map(item => item.assetVersionId)
    const task = renderReleaseTask(run)
    const output = await this.executeWorkspaceStage(run, 'release', 'requirement-release.submit_result', 'requirement-release-candidate/v1', 'PlanningAgent', task, async candidate => normalizeReleaseCandidate(candidate, expectedAssetVersionIds), signal)
    const candidate = output.candidate as unknown as RequirementReleaseCandidate
    const releaseId = `requirement_release_${randomUUID()}`
    const generatedAt = new Date().toISOString()
    const built = buildRequirementReleaseArtifacts({ state, releaseId, verificationRun: run, candidate, generatedAt })
    const release = {
      id: releaseId,
      schemaVersion: 'requirement-release-package/v1' as const,
      status: 'candidate' as const,
      projectVersionId: run.projectVersionId,
      verificationRunId: run.id,
      sourceAssetVersionIds: expectedAssetVersionIds,
      candidate,
      generationExecution: executionRecordForStage(output, 'release'),
      artifacts: built.artifacts,
      contentSha256: built.contentSha256,
      createdAt: generatedAt,
      createdBy: principalId(input.principal),
    }
    await this.store.transaction(current => {
      const stored = required(current.reviewRuns.find(item => item.id === run.id), '复验运行不存在')
      assertReleaseGate(current, stored)
      stored.workflow ??= { currentStage: 'release' }
      stored.workflow.currentStage = 'release'
      stored.workflow.release = release
    })
    return structuredClone(release)
  }

  async publishRelease(runId: string, input: { principal?: Principal }) {
    return this.store.transaction(state => {
      const run = required(state.reviewRuns.find(item => item.id === runId), '复验运行不存在')
      assertReleaseGate(state, run)
      const release = required(run.workflow?.release, '请先生成发布候选')
      if (release.status !== 'candidate') throw new Error('该需求发布包已发布')
      assertReleasePackageIntegrity(release)
      release.status = 'published'
      release.publishedAt = new Date().toISOString()
      release.publishedBy = principalId(input.principal)
      const requirementsArtifact = required(release.artifacts.find(item => item.fileName === 'requirements.json' && item.mediaType === 'application/json'), '需求发布包缺少 requirements.json')
      const projectVersion = required(state.projectVersions.find(item => item.id === run.projectVersionId), '项目版本不存在')
      activateRequirementReleaseBinding(projectVersion, {
        releaseId: release.id,
        verificationRunId: run.id,
        requirementsJsonSha256: requirementsArtifact.contentSha256,
        boundAt: release.publishedAt,
      })
      projectVersion.updatedAt = release.publishedAt
      return structuredClone(release)
    })
  }

  async releaseArtifact(runId: string, fileName: string) {
    const run = await this.loadStoredRun(runId)
    const release = required(run.workflow?.release, '需求发布包不存在')
    if (release.status !== 'published') throw new Error('需求发布包尚未正式发布')
    return structuredClone(required(release.artifacts.find(item => item.fileName === fileName), '发布产物不存在'))
  }

  async analyze(request: RequirementAnalysisRequest, signal = new AbortController().signal, onCreated?: (run: ReturnType<typeof presentRun>) => void, deferExecution = false) {
    const state = await this.store.snapshot()
    const projectVersion = required(state.projectVersions.find(item => item.id === request.projectVersionId), '项目版本不存在')
    if (projectVersion.status !== 'open') throw new Error('当前项目版本为只读状态，不能发起需求分析')
    const project = required(state.projects.find(item => item.id === projectVersion.projectId), '项目不存在')
    const knowledgeBase = required(state.knowledgeBases.find(item => item.projectId === project.id), '知识库不存在')
    const index = required(state.indexes.find(item => item.id === knowledgeBase.activeIndexVersionId && item.status === 'active'), '知识库没有活动索引')
    if (request.documentDirectoryPath === undefined) throw new Error('PI_WORKSPACE_DIRECTORY_REQUIRED: 需求分析必须指定 /workspace 下的输入目录')
    const documentDirectoryPath = normalizeDocumentDirectoryPath(request.documentDirectoryPath)
    const requiredInputDirectory = `workspace/branches/${safeWorkspaceSegment(projectVersion.name)}/input/requirements`
    if (documentDirectoryPath !== requiredInputDirectory) throw new Error(`PI_WORKSPACE_INPUT_REQUIRED: 当前版本需求输入目录固定为 /${requiredInputDirectory}`)
    const workspacePairs = state.assets.flatMap(asset => {
      if (asset.knowledgeBaseId !== knowledgeBase.id || !isWithinDirectory(asset.logicalPath, 'workspace') || !asset.activeVersionId) return []
      const version = state.versions.find(item => item.id === asset.activeVersionId && item.assetId === asset.id && item.status === 'ready')
      return version ? [{ asset, version }] : []
    }).sort((left, right) => left.asset.logicalPath.localeCompare(right.asset.logicalPath, 'zh-CN') || left.version.id.localeCompare(right.version.id))
    const boundPairs = state.projectVersionRequirementBindings.filter(item => item.projectVersionId === projectVersion.id).flatMap(binding => {
      const asset = state.assets.find(item => item.id === binding.assetId && item.knowledgeBaseId === knowledgeBase.id)
      const version = state.versions.find(item => item.id === binding.assetVersionId && item.assetId === binding.assetId && item.status === 'ready' && index.assetVersionIds.includes(item.id))
      return asset && version && isWithinDirectory(asset.logicalPath, documentDirectoryPath) ? [{ asset, version }] : []
    })
    const inputPairs = (boundPairs.length ? boundPairs : workspacePairs.filter(({ asset }) => isWithinDirectory(asset.logicalPath, documentDirectoryPath)))
      .sort((left, right) => left.asset.logicalPath.localeCompare(right.asset.logicalPath, 'zh-CN') || left.version.id.localeCompare(right.version.id))
    if (!inputPairs.length) throw new Error(`Agent 输入目录 /${documentDirectoryPath} 中没有已进入活动索引的 ready 文档`)
    const analysisConfiguration = this.definitions.resolveActive ? await this.definitions.resolveActive('planning') : null
    if (this.definitions.resolveActive && !analysisConfiguration) throw new Error('请先在系统管理的 Agent 配置中发布 PlanningAgent，再发起需求分析')
    const requestModel = request.sourceId && request.modelId ? { sourceId: request.sourceId, modelId: request.modelId } : null
    const models = selectAgentModels(state, analysisConfiguration, requestModel, 'PlanningAgent')
    const model = models[0]
    const definition = analysisConfiguration?.agentDefinition ?? await this.definitions.resolve('planning')
    requirePiWorkspaceAgentDefinition(definition)
    const coveragePlan = buildAnalysisCoveragePlan(inputPairs.map(item => item.version), request.excludedAreas)
    const effectiveContextWindow = configuredContextWindow(analysisConfiguration)
    const effectiveMaxOutputTokens = configuredMaxOutputTokens(analysisConfiguration)
    const documentWorkspace = requirementDocumentWorkspace(projectVersion, state.projectVersions, documentDirectoryPath)
    const now = new Date().toISOString()
    const currentInputRefs = buildCurrentInputRefs(inputPairs)
    const workspaceSnapshot = buildProjectWorkspaceSnapshot({
      projectId: project.id,
      projectVersion,
      files: workspacePairs,
      currentInputVersionIds: new Set(currentInputRefs.map(item => item.assetVersionId)),
      createdAt: now,
    })
    const requirementInputPlan = buildRequirementDirectoryInputPlan({
      workspacePath: documentDirectoryPath,
      workspaceRootPath: documentWorkspace.rootLogicalPath,
      activeBranchPath: documentWorkspace.activeBranchLogicalPath,
      agentWorkspacePath: documentWorkspace.agentLogicalPath,
      assets: inputPairs,
      currentInputRefs,
      workspaceSnapshot,
      formalClarifications: structuredClone(request.formalClarifications ?? []),
      definition,
      contextWindow: effectiveContextWindow,
      maxOutputTokens: effectiveMaxOutputTokens,
    })
    const analysisId = request.analysisId ?? `analysis_${randomUUID()}`
    const snapshot: ReviewRunSnapshot = {
      runId: `analysis_run_${randomUUID()}`,
      reviewId: analysisId,
      projectId: project.id,
      projectName: project.name,
      projectVersionId: projectVersion.id,
      projectVersionName: projectVersion.name,
      knowledgeBaseId: knowledgeBase.id,
      assetId: inputPairs[0].asset.id,
      assetVersionId: inputPairs[0].version.id,
      assetContentHash: inputPairs[0].version.contentHash,
      indexVersionId: index.id,
      logicalPath: inputPairs[0].asset.logicalPath,
      assets: inputPairs.map(({ asset, version }) => ({ assetId: asset.id, assetVersionId: version.id, assetContentHash: version.contentHash, logicalPath: asset.logicalPath, displayName: asset.displayName, assetType: asset.assetType })),
      currentInputRefs,
      workspaceSnapshot,
      formalClarifications: structuredClone(request.formalClarifications ?? []),
      documentWorkspace: { ...documentWorkspace, candidateAssetVersionIds: inputPairs.map(item => item.version.id) },
      modelRef: modelSnapshot(model, effectiveContextWindow, effectiveMaxOutputTokens),
      ...(analysisConfiguration ? { agentConfigurationRef: configurationRef(analysisConfiguration) } : {}),
      focusAreas: cleanList(request.focusAreas),
      excludedAreas: cleanList(request.excludedAreas),
      agentDefinition: definition,
      analysisCoveragePlan: coveragePlan,
      analysisToolBudget: { directoryCalls: Math.max(1, definition.limits.maxToolCalls - 3), chunkCalls: Math.max(1, definition.limits.maxToolCalls - 3), knowledgeCalls: Math.max(1, definition.limits.maxToolCalls - 3), submissionCalls: 3, minimumToolCalls: 3 },
      analysisInput: inputSnapshot(requirementInputPlan),
      createdAt: now,
    }
    const run: ReviewRun = {
      id: snapshot.runId,
      reviewId: analysisId,
      ...(request.retryOfRunId ? { retryOfRunId: request.retryOfRunId, retryMode: 'full' as const } : {}),
      projectVersionId: projectVersion.id,
      assetId: inputPairs[0].asset.id,
      assetVersionId: inputPairs[0].version.id,
      documentTitle: `${inputPairs.length} 份需求输入文档 · ${workspacePairs.length} 份工作区文档`,
      documentVersion: inputPairs[0].version.number,
      logicalPath: documentDirectoryPath,
      sourceId: model.source.id,
      modelId: model.model.id,
      modelLabel: `需求分析：${model.source.name} · ${model.model.displayName}`,
      status: 'running',
      step: deferExecution ? 'waiting_worker' : 'analyzing_requirements',
      progress: deferExecution ? 1 : 10,
      createdAt: now,
      startedAt: now,
      snapshot,
      workflow: { currentStage: 'analysis' },
    }
    await this.store.transaction(draft => {
      required(draft.projectVersions.find(item => item.id === request.projectVersionId), '项目版本不存在')
      draft.reviewRuns.push(run)
    })
    onCreated?.(presentRun(run))
    if (deferExecution) return presentRun(run)
    return this.executeAnalysis({ run, snapshot, requirementInputPlan, models, configuration: analysisConfiguration, signal })
  }

  async processPreparedRun(runId: string, lease?: TaskLease, signal = new AbortController().signal, infrastructureAttempt = 1, maxInfrastructureAttempts = 1) {
    await this.beginExecutionAttempt(runId, lease, infrastructureAttempt, maxInfrastructureAttempts)
    const state = await this.store.snapshot()
    const run = required(state.reviewRuns.find(item => item.id === runId), '需求分析运行不存在')
    if (run.status !== 'running') throw new Error('需求分析运行已结束，不能由 Worker 重复执行')
    const configurationRef = run.snapshot.agentConfigurationRef
    const configuration = configurationRef ? required(state.agentConfigurationVersions.find(item => item.id === configurationRef.id), 'PlanningAgent 固定配置版本不存在') : null
    const models = selectAgentModels(state, configuration, { sourceId: run.snapshot.modelRef.sourceId, modelId: run.snapshot.modelRef.modelId }, 'PlanningAgent')
    const plan = this.buildFixedRequirementInputPlan(state, run)
    if (plan.packageSha256 !== run.snapshot.analysisInput.packageSha256) throw new Error('固定正文输入包 Hash 已漂移')
    await this.reviewTransaction(run.id, lease, draft => {
      const current = required(draft.reviewRuns.find(item => item.id === run.id), '需求分析运行不存在')
      current.step = 'analyzing_requirements'
      current.progress = 10
    })
    return this.executeAnalysis({ run, snapshot: run.snapshot, requirementInputPlan: plan, models, configuration, signal, lease, retryable: infrastructureAttempt < maxInfrastructureAttempts })
  }

  private buildFixedRequirementInputPlan(state: DatabaseState, run: ReviewRun) {
    const fixedPairs = run.snapshot.assets.map(item => {
      const version = required(state.versions.find(candidate => candidate.id === item.assetVersionId && candidate.status === 'ready'), '固定需求资产版本不可用')
      if (version.contentHash !== item.assetContentHash) throw new Error('固定需求资产内容 Hash 已漂移')
      const asset = required(state.assets.find(candidate => candidate.id === item.assetId), '固定需求资产不存在')
      return { asset: { ...asset, displayName: item.displayName, logicalPath: item.logicalPath, assetType: item.assetType ?? asset.assetType }, version }
    })
    requirePiWorkspaceAgentDefinition(run.snapshot.agentDefinition)
    if (run.snapshot.analysisInput?.mode !== 'agent_directory') throw new Error('PI_WORKSPACE_SNAPSHOT_REQUIRED: 需求分析输入必须是 agent_directory')
    return buildRequirementDirectoryInputPlan({
      workspacePath: required(run.snapshot.documentWorkspace?.logicalPath, '固定 Agent 文档工作目录不存在'),
      workspaceRootPath: run.snapshot.documentWorkspace?.rootLogicalPath,
      activeBranchPath: run.snapshot.documentWorkspace?.activeBranchLogicalPath,
      agentWorkspacePath: run.snapshot.documentWorkspace?.agentLogicalPath,
      assets: fixedPairs,
      currentInputRefs: run.snapshot.currentInputRefs,
      workspaceSnapshot: run.snapshot.workspaceSnapshot,
      formalClarifications: run.snapshot.formalClarifications,
      definition: run.snapshot.agentDefinition,
      contextWindow: run.snapshot.modelRef.contextWindow,
      maxOutputTokens: run.snapshot.modelRef.maxOutputTokens,
    })
  }

  private async executeWorkspaceStage(
    run: ReviewRun,
    workflowStage: 'release',
    submitToolId: string,
    schemaVersion: string,
    agentLabel: string,
    initialTask: string,
    validateCandidate: (candidate: Record<string, unknown>) => Promise<{ valid: boolean; result?: Record<string, unknown>; issues: Array<{ path: string; message: string }> }>,
    signal: AbortSignal,
  ) {
    const state = await this.store.snapshot()
    const configuration = run.snapshot.agentConfigurationRef
      ? required(state.agentConfigurationVersions.find(item => item.id === run.snapshot.agentConfigurationRef!.id), 'PlanningAgent 固定配置版本不存在')
      : null
    const models = selectAgentModels(state, configuration, { sourceId: run.snapshot.modelRef.sourceId, modelId: run.snapshot.modelRef.modelId }, 'PlanningAgent')
    const model = models[0]
    const fixedPairs = run.snapshot.assets.map(item => {
      const version = required(state.versions.find(candidate => candidate.id === item.assetVersionId && candidate.status === 'ready'), '固定需求资产版本不可用')
      if (version.contentHash !== item.assetContentHash) throw new Error('固定需求资产内容 Hash 已漂移')
      const asset = required(state.assets.find(candidate => candidate.id === item.assetId), '固定需求资产不存在')
      return { asset: { ...asset, displayName: item.displayName, logicalPath: item.logicalPath, assetType: item.assetType ?? asset.assetType }, version }
    })
    const plan = buildRequirementDirectoryInputPlan({
      workspacePath: required(run.snapshot.documentWorkspace?.logicalPath, '固定 Agent 文档工作目录不存在'),
      workspaceRootPath: run.snapshot.documentWorkspace?.rootLogicalPath,
      activeBranchPath: run.snapshot.documentWorkspace?.activeBranchLogicalPath,
      agentWorkspacePath: run.snapshot.documentWorkspace?.agentLogicalPath,
      assets: fixedPairs,
      currentInputRefs: run.snapshot.currentInputRefs,
      workspaceSnapshot: run.snapshot.workspaceSnapshot,
      definition: run.snapshot.agentDefinition,
      contextWindow: run.snapshot.modelRef.contextWindow,
      maxOutputTokens: run.snapshot.modelRef.maxOutputTokens,
    })
    return this.executeOnce({
      runId: run.id,
      snapshot: run.snapshot,
      selection: model,
      configuration,
      signal,
      createInput: modelRef => ({
        snapshot: { ...run.snapshot, modelRef },
        model: modelConnection(model, modelRef, configuration),
        requirementInputPlan: plan,
        executionProfile: {
          mode: 'workspace_tools',
          workflowStage,
          allowedToolIds: [...REQUIREMENT_WORKSPACE_TOOL_IDS, submitToolId],
          submitToolId,
          schemaVersion,
          agentLabel,
          initialTask,
          validateCandidate: async candidate => validateCandidate(candidate),
        },
      }),
    })
  }

  async failPreparedRun(runId: string, lease: TaskLease | undefined, error: unknown, cancelled = false, retryable = false, retry?: { attempt: number; maxAttempts: number; nextAttemptAt?: string }) {
    const message = sanitize(String(error instanceof Error ? error.message : error))
    await this.reviewTransaction(runId, lease, state => {
      const run = required(state.reviewRuns.find(item => item.id === runId), '需求分析运行不存在')
      if (run.status !== 'running') return
      const now = new Date().toISOString()
      if (retry && !cancelled) {
        run.retryEvents ??= []
        run.retryEvents.push({ attempt: retry.attempt, maxAttempts: retry.maxAttempts, agentKey: 'planning', status: retryable ? 'scheduled' : 'exhausted', error: message, occurredAt: now, ...(retry.nextAttemptAt ? { nextAttemptAt: retry.nextAttemptAt } : {}) })
      }
      if (retryable && !cancelled) { run.step = 'waiting_worker'; run.finishedAt = undefined }
      else { run.status = cancelled ? 'cancelled' : 'failed'; run.step = cancelled ? 'cancelled' : 'failed'; run.finishedAt = now }
      run.error = message
      const attempt = latestRunningExecutionAttempt(run)
      if (attempt) { attempt.status = cancelled ? 'cancelled' : 'failed'; attempt.finishedAt = now; attempt.error = message; attempt.modelLabel = run.modelLabel; if (run.execution) attempt.executions.planning = structuredClone(run.execution) }
    })
  }

  private async executeAnalysis(input: { run: ReviewRun; snapshot: ReviewRunSnapshot; requirementInputPlan: RequirementInputPlan; models: AgentModelSelection[]; configuration: AgentConfigurationVersion | null; signal: AbortSignal; lease?: TaskLease; retryable?: boolean }) {
    const events: AgentExecutionEvent[] = []
    const model = supportsInputPlan(input.requirementInputPlan, input.snapshot.modelRef.contextWindow, input.snapshot.modelRef.maxOutputTokens) ? input.models[0] : undefined
    if (!model) throw new Error('PlanningAgent 没有满足固定工作区上下文和工具能力的可用模型')
    try {
      const output = await this.executeOnce({
        runId: input.run.id,
        snapshot: input.snapshot,
        selection: model,
        configuration: input.configuration,
        signal: input.signal,
        lease: input.lease,
        createInput: modelRef => ({
          snapshot: { ...input.snapshot, modelRef },
          model: modelConnection(model, modelRef, input.configuration),
          requirementInputPlan: input.requirementInputPlan,
          executionProfile: {
            mode: 'workspace_tools',
            workflowStage: 'analysis',
            allowedToolIds: [...REQUIREMENT_WORKSPACE_TOOL_IDS, 'requirement-analysis.submit_result'],
            submitToolId: 'requirement-analysis.submit_result',
            schemaVersion: 'requirement-analysis/v1',
            agentLabel: 'PlanningAgent',
            initialTask: renderPlanningRequirementTask(input.snapshot),
            validateCandidate: async (candidate, manifest) => {
              const normalized = await this.validator.normalize(candidate as unknown as CandidateRequirementAnalysisV1, input.snapshot, manifest)
              return { valid: normalized.report.valid, result: normalized.result, issues: normalized.report.issues }
            },
          },
          onEvent: async event => {
            events.push(event)
            if (shouldCheckpointExecution(event)) await this.saveExecutionProgress(input.run.id, events, input.lease)
          },
        }),
      })
      if (input.signal.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new Error('AGENT_CANCELLED')
      const result = output.candidate as RequirementAnalysisResult
      const manifest = required(output.inputDeliveryManifest, '输入投递证明不存在')
      const validation = await this.validator.validate(result, input.snapshot, manifest)
      if (!validation.valid) throw validationError(validation.issues)
      const execution = { ...executionRecord(output), workflowStage: 'analysis' as const }
      const finishedAt = new Date().toISOString()
      const pendingBlockingClarifications = result.clarifications.filter(item => item.blocking && item.status === 'pending')
      await this.reviewTransaction(input.run.id, input.lease, draft => {
        const current = required(draft.reviewRuns.find(item => item.id === input.run.id), '需求分析运行不存在')
        Object.assign(current, {
          status: pendingBlockingClarifications.length ? 'waiting_clarification' : 'succeeded',
          step: pendingBlockingClarifications.length ? 'waiting_clarification' : 'requirement_understanding_ready',
          progress: pendingBlockingClarifications.length ? 55 : 100,
          finishedAt,
          result,
          inputDeliveryManifest: manifest,
          execution,
          executions: { planning: execution },
          error: undefined,
        } satisfies Partial<ReviewRun>)
        current.snapshot.formalClarifications = mergeFormalClarifications(current.snapshot.formalClarifications, result.clarifications)
        current.workflow ??= { currentStage: 'analysis' }
        current.workflow.currentStage = pendingBlockingClarifications.length ? 'clarification' : 'understanding'
        if (!pendingBlockingClarifications.length) current.workflow.automaticTransition = { status: 'pending' }
        const attempt = latestRunningExecutionAttempt(current)
        if (attempt) { attempt.activeAgentKey = 'planning'; attempt.status = 'succeeded'; attempt.finishedAt = finishedAt; attempt.modelLabel = current.modelLabel; attempt.executions = { planning: structuredClone(execution) } }
      })
      if (!pendingBlockingClarifications.length) await this.notifyUnderstandingReady(input.run.id)
      return required((await this.get(input.run.id)).response, '需求分析结果不存在')
    } catch (error) {
      const message = await this.failRun(input.run.id, error, input.signal, model, events, input.lease, input.retryable ?? false)
      throw new Error(message)
    }
  }

  private async notifyUnderstandingReady(runId: string) {
    if (!this.understandingReadyListener) return
    try {
      await this.understandingReadyListener(runId)
    } catch (error) {
      const message = sanitize(String(error instanceof Error ? error.message : error))
      await this.store.transaction(state => {
        const current = state.reviewRuns.find(item => item.id === runId)
        if (!current?.workflow) return
        current.workflow.automaticTransition = { ...(current.workflow.automaticTransition ?? { status: 'failed' }), status: 'failed', finishedAt: new Date().toISOString(), error: message }
      })
    }
  }

  private async executeOnce(input: { runId: string; snapshot: ReviewRunSnapshot; selection: AgentModelSelection; configuration: AgentConfigurationVersion | null; signal: AbortSignal; lease?: TaskLease; createInput: (modelRef: ReviewRunSnapshot['modelRef']) => AgentExecutionInput }) {
    const modelRef = modelSnapshot(input.selection, input.snapshot.modelRef.contextWindow, input.snapshot.modelRef.maxOutputTokens)
    const attemptId = `model_attempt_${randomUUID()}`
    const startedAt = new Date().toISOString()
    await this.reviewTransaction(input.runId, input.lease, state => {
      const run = required(state.reviewRuns.find(item => item.id === input.runId), '需求分析运行不存在')
      run.modelRouteAttempts ??= []
      run.modelRouteAttempts.push({ id: attemptId, agentKey: 'planning', sourceId: input.selection.source.id, modelId: input.selection.model.id, modelLabel: `${input.selection.source.name} · ${input.selection.model.displayName}`, status: 'running', startedAt })
      run.snapshot.modelRef = modelRef
      run.sourceId = modelRef.sourceId
      run.modelId = modelRef.modelId
      run.modelLabel = `需求分析：${input.selection.source.name} · ${input.selection.model.displayName}`
    })
    input.snapshot.modelRef = modelRef
    try {
      const output = await this.runtime.execute(input.createInput(modelRef), input.signal)
      await this.finishModelAttempt(input.runId, attemptId, 'succeeded', undefined, input.lease)
      return output
    } catch (error) {
      const message = sanitizeRuntimeError(error, input.selection.source.baseUrl, input.selection.source.apiKey)
      await this.finishModelAttempt(input.runId, attemptId, input.signal.aborted ? 'cancelled' : 'failed', message, input.lease)
      throw error
    }
  }

  private async finishModelAttempt(runId: string, attemptId: string, status: 'succeeded' | 'failed' | 'cancelled', error?: string, lease?: TaskLease) {
    await this.reviewTransaction(runId, lease, state => {
      const run = required(state.reviewRuns.find(item => item.id === runId), '需求分析运行不存在')
      const attempt = required(run.modelRouteAttempts?.find(item => item.id === attemptId), '模型调用记录不存在')
      attempt.status = status
      attempt.finishedAt = new Date().toISOString()
      if (error) attempt.error = error
    })
  }

  private async failRun(runId: string, error: unknown, signal: AbortSignal, failedModel: AgentModelSelection, events: AgentExecutionEvent[], lease?: TaskLease, retryable = false) {
    const message = sanitizeRuntimeError(error, failedModel.source.baseUrl, failedModel.source.apiKey)
    const cancelled = /AGENT_CANCELLED_BY_USER|用户已取消|客户端已中断/u.test(message)
    await this.reviewTransaction(runId, lease, draft => {
      const current = required(draft.reviewRuns.find(item => item.id === runId), '需求分析运行不存在')
      Object.assign(current, retryable && !cancelled
        ? { status: 'running', step: 'waiting_worker', finishedAt: undefined, error: message, ...(events.length ? { execution: executionProgress(events) } : {}) }
        : { status: cancelled ? 'cancelled' : 'failed', step: cancelled ? 'cancelled' : 'failed', finishedAt: new Date().toISOString(), error: message, ...(events.length ? { execution: executionProgress(events) } : {}) } satisfies Partial<ReviewRun>)
      const attempt = latestRunningExecutionAttempt(current)
      if (attempt) { attempt.activeAgentKey = 'planning'; attempt.status = cancelled ? 'cancelled' : 'failed'; attempt.finishedAt = new Date().toISOString(); attempt.error = message; if (events.length) attempt.executions.planning = executionProgress(events) }
    })
    return message
  }

  private async reviewTransaction<T>(runId: string, lease: TaskLease | undefined, operation: (draft: DatabaseState) => T | Promise<T>) {
    if (!lease || !this.store.transactionWithReviewLease) return this.store.transaction(operation)
    const result = await this.store.transactionWithReviewLease(runId, lease, operation)
    if (result === null) throw new Error('REVIEW_JOB_FENCING_REJECTED: Worker 租约已失效，晚到结果不得发布')
    return result
  }

  private async loadStoredRun(runId: string) {
    const run = this.store.getReviewRun ? await this.store.getReviewRun(runId) : (await this.store.snapshot()).reviewRuns.find(item => item.id === runId)
    return required(run, '需求分析运行不存在')
  }

  private async saveExecutionProgress(runId: string, events: AgentExecutionEvent[], lease?: TaskLease) {
    const execution = executionProgress(events)
    if (!lease && this.store.saveReviewRunExecution) return this.store.saveReviewRunExecution(runId, execution)
    await this.reviewTransaction(runId, lease, draft => {
      const current = required(draft.reviewRuns.find(item => item.id === runId), '需求分析运行不存在')
      current.execution = execution
      current.executions = { planning: execution }
      const attempt = latestRunningExecutionAttempt(current)
      if (attempt) { attempt.activeAgentKey = 'planning'; attempt.executions.planning = structuredClone(execution) }
    })
  }

  private async beginExecutionAttempt(runId: string, lease: TaskLease | undefined, attemptNumber: number, maxAttempts: number) {
    await this.reviewTransaction(runId, lease, draft => {
      const run = required(draft.reviewRuns.find(item => item.id === runId), '需求分析运行不存在')
      if (run.status !== 'running') throw new Error('需求分析运行已结束，不能创建新的 Worker 尝试记录')
      run.execution = undefined
      run.executions = undefined
      run.executionAttempts ??= []
      const startedAt = new Date().toISOString()
      for (const previous of run.executionAttempts) {
        if (previous.status !== 'running' || previous.attempt >= Math.max(1, attemptNumber)) continue
        previous.status = 'failed'; previous.finishedAt = previous.finishedAt ?? startedAt; previous.error = previous.error ?? 'WORKER_ATTEMPT_SUPERSEDED: 后续重试已开始，本次尝试未完成'
      }
      const value = { attempt: Math.max(1, attemptNumber), maxAttempts: Math.max(1, maxAttempts), status: 'running' as const, activeAgentKey: 'planning' as const, startedAt, modelLabel: run.modelLabel, executions: {} }
      const existing = run.executionAttempts.findIndex(item => item.attempt === value.attempt)
      if (existing >= 0) run.executionAttempts[existing] = value
      else run.executionAttempts.push(value)
    })
  }
}

function normalizeReleaseCandidate(candidate: Record<string, unknown>, expectedAssetVersionIds: string[]) {
  const issues: Array<{ path: string; message: string }> = []
  const result = candidate as unknown as RequirementReleaseCandidate
  if (result.schemaVersion !== 'requirement-release-candidate/v1') issues.push({ path: '/schemaVersion', message: '必须为 requirement-release-candidate/v1' })
  const actualIds = Array.isArray(result.sourceAssetVersionIds) ? [...new Set(result.sourceAssetVersionIds.map(item => String(item).trim()).filter(Boolean))] : []
  if (actualIds.length !== expectedAssetVersionIds.length || expectedAssetVersionIds.some(item => !actualIds.includes(item))) issues.push({ path: '/sourceAssetVersionIds', message: '必须与复验固定输入版本完全一致' })
  const markdown = String(result.refinedRequirementsMarkdown ?? '').trim()
  if (!markdown) issues.push({ path: '/refinedRequirementsMarkdown', message: '完善后的需求文档不能为空' })
  if (Buffer.byteLength(markdown, 'utf8') > 1_000_000) issues.push({ path: '/refinedRequirementsMarkdown', message: '完善后的需求文档超过 1MB' })
  const normalized: RequirementReleaseCandidate = { schemaVersion: 'requirement-release-candidate/v1', sourceAssetVersionIds: expectedAssetVersionIds, refinedRequirementsMarkdown: markdown }
  return Promise.resolve({ valid: issues.length === 0, ...(issues.length ? {} : { result: normalized as unknown as Record<string, unknown> }), issues })
}

function renderReleaseTask(run: ReviewRun) {
  return [
    'Workflow Stage 固定为 release。服务端已通过版本和需求基线门禁。只生成 refinedRequirementsMarkdown 候选；requirements.json、test-focus.json、traceability.json 与 manifest.json 由服务端生成。',
    `Analysis Run：${run.id}`,
    `固定 AssetVersion：${JSON.stringify(run.snapshot.assets.map(item => ({ assetVersionId: item.assetVersionId, logicalPath: item.logicalPath, contentSha256: item.assetContentHash })))}`,
    'requirement.release Skill 已由 Runtime 按发布绑定直接加载。通过 requirement_release_submit_result 提交 requirement-release-candidate/v1；不得自行发布。',
  ].join('\n')
}

function requireSucceededRun(run: ReviewRun) { if (run.status !== 'succeeded' || !run.result) throw new Error('只有成功完成的需求分析运行可以进入后续 Workflow Stage') }
function requireOpenProjectVersion(state: DatabaseState, projectVersionId: string) { const version = required(state.projectVersions.find(item => item.id === projectVersionId), '项目版本不存在'); if (version.status !== 'open') throw new Error('当前项目版本为只读状态，不能推进需求工作流'); return version }

function refreshAnalysisArtifacts(result: RequirementAnalysisResult) {
  const { artifacts: _artifacts, ...formalResult } = result
  result.artifacts = renderRequirementAnalysisArtifacts(formalResult)
}

function assertRequirementInputsStable(state: DatabaseState, run: ReviewRun) {
  const expected = new Map(run.snapshot.assets.map(item => [item.assetId, item]))
  const bindings = state.projectVersionRequirementBindings.filter(item => item.projectVersionId === run.projectVersionId)
  const unexpected = bindings.find(binding => !expected.has(binding.assetId))
  if (unexpected) throw new Error('REQUIREMENT_UNDERSTANDING_INPUT_CHANGED: 项目版本存在本次分析之外的需求绑定')
  for (const reference of run.snapshot.assets) {
    const asset = required(state.assets.find(item => item.id === reference.assetId), 'REQUIREMENT_UNDERSTANDING_INPUT_MISSING: 需求资产不存在')
    const version = required(state.versions.find(item => item.id === reference.assetVersionId && item.status === 'ready'), 'REQUIREMENT_UNDERSTANDING_INPUT_MISSING: 需求版本不可用')
    if (asset.activeVersionId !== reference.assetVersionId || version.contentHash !== reference.assetContentHash) throw new Error('REQUIREMENT_UNDERSTANDING_INPUT_CHANGED: 需求资产版本或 Hash 已变化，请重新分析')
    const binding = bindings.find(item => item.assetId === reference.assetId)
    if (binding && binding.assetVersionId !== reference.assetVersionId) throw new Error('REQUIREMENT_UNDERSTANDING_INPUT_CHANGED: 项目版本需求绑定与分析快照不一致')
    if (!binding) state.projectVersionRequirementBindings.push({ id: `pvrb_${randomUUID()}`, projectVersionId: run.projectVersionId, assetId: reference.assetId, assetVersionId: reference.assetVersionId, createdAt: new Date().toISOString() })
  }
}

function sha256Text(value: string) { return createHash('sha256').update(value, 'utf8').digest('hex') }

function assertReleaseGate(state: DatabaseState, run: ReviewRun) {
  requireSucceededRun(run)
  requireOpenProjectVersion(state, run.projectVersionId)
  const result = required(run.result, '复验结果不存在')
  if (!['pass', 'pass_with_notes'].includes(result.summary.overallAssessment)) throw new Error('RELEASE_GATE_ASSESSMENT_BLOCKED: 总体结论未通过')
  const bindings = state.projectVersionRequirementBindings.filter(item => item.projectVersionId === run.projectVersionId)
  const expected = new Map(run.snapshot.assets.map(item => [item.assetId, item]))
  if (bindings.length !== expected.size || bindings.some(binding => expected.get(binding.assetId)?.assetVersionId !== binding.assetVersionId)) throw new Error('RELEASE_GATE_REQUIREMENT_BINDINGS_CHANGED: 项目版本需求绑定与复验快照不一致')
  for (const reference of run.snapshot.assets) {
    const version = required(state.versions.find(item => item.id === reference.assetVersionId && item.status === 'ready'), '发布依赖的需求版本不可用')
    if (version.contentHash !== reference.assetContentHash) throw new Error('RELEASE_GATE_ASSET_HASH_CHANGED: 发布依赖的需求版本 Hash 漂移')
  }
}

function assertReleasePackageIntegrity(release: RequirementReleasePackage) {
  release.artifacts.forEach(item => { if (createHash('sha256').update(item.content).digest('hex') !== item.contentSha256) throw new Error(`RELEASE_ARTIFACT_HASH_MISMATCH: ${item.fileName}`) })
  const manifestArtifact = required(release.artifacts.find(item => item.fileName === 'manifest.json' && item.mediaType === 'application/json'), '发布包缺少 manifest.json')
  if (manifestArtifact.contentSha256 !== release.contentSha256) throw new Error('RELEASE_MANIFEST_HASH_MISMATCH')
  let value: unknown
  try { value = JSON.parse(manifestArtifact.content) } catch { throw new Error('RELEASE_MANIFEST_INVALID: manifest.json 不是合法 JSON') }
  const manifest = value && typeof value === 'object' && !Array.isArray(value)
    ? value as { schemaVersion?: unknown; releaseId?: unknown; projectVersionId?: unknown; verificationRunId?: unknown; sourceAssetVersions?: unknown; artifacts?: unknown; machineReadableEntryPoints?: unknown }
    : {}
  const entryPoints = manifest.machineReadableEntryPoints && typeof manifest.machineReadableEntryPoints === 'object' && !Array.isArray(manifest.machineReadableEntryPoints)
    ? manifest.machineReadableEntryPoints as Record<string, unknown>
    : {}
  const expectedEntryPoints = { requirements: 'requirements.json', clarifications: 'clarifications.json', testFocus: 'test-focus.json', traceability: 'traceability.json' }
  if (manifest.schemaVersion !== 'requirement-release-manifest/v1' || manifest.releaseId !== release.id || manifest.projectVersionId !== release.projectVersionId || manifest.verificationRunId !== release.verificationRunId || Object.entries(expectedEntryPoints).some(([key, fileName]) => entryPoints[key] !== fileName)) throw new Error('RELEASE_MANIFEST_INVALID: 发布来源或机器可读入口不一致')
  const manifestSourceIds = Array.isArray(manifest.sourceAssetVersions) ? manifest.sourceAssetVersions.map(item => item && typeof item === 'object' && !Array.isArray(item) ? String((item as { assetVersionId?: unknown }).assetVersionId ?? '') : '') : []
  if (JSON.stringify(manifestSourceIds) !== JSON.stringify(release.sourceAssetVersionIds)) throw new Error('RELEASE_MANIFEST_INVALID: 固定需求版本不一致')
  const manifestArtifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : []
  const expectedArtifacts = release.artifacts.filter(item => item.fileName !== 'manifest.json')
  if (manifestArtifacts.length !== expectedArtifacts.length) throw new Error('RELEASE_MANIFEST_INVALID: 发布产物清单数量不一致')
  for (const artifact of expectedArtifacts) {
    const entry = manifestArtifacts.find(item => item && typeof item === 'object' && !Array.isArray(item) && (item as { fileName?: unknown }).fileName === artifact.fileName) as { mediaType?: unknown; contentSha256?: unknown; bytes?: unknown } | undefined
    if (!entry || entry.mediaType !== artifact.mediaType || entry.contentSha256 !== artifact.contentSha256 || entry.bytes !== Buffer.byteLength(artifact.content, 'utf8')) throw new Error(`RELEASE_MANIFEST_INVALID: 产物清单不一致 ${artifact.fileName}`)
  }
}

function executionRecordForStage(output: AgentExecutionOutput, workflowStage: RequirementWorkflowStage): AgentExecutionRecord {
  return { agentKey: 'planning', workflowStage, turns: output.turns, toolCalls: output.toolCalls, toolErrors: output.toolErrors, framework: output.framework, context: output.context, events: output.events }
}
function principalId(principal: Principal | undefined) { return String(principal?.subjectId ?? '').trim().slice(0, 200) || 'system' }

function latestRunningExecutionAttempt(run: ReviewRun) { return [...(run.executionAttempts ?? [])].reverse().find(item => item.status === 'running') }

function presentRunSummary(run: ReviewRun) {
  const assets = snapshotAssets(run)
  return { id: run.id, analysisId: analysisIdFor(run), runId: run.id, retryOfRunId: run.retryOfRunId, retryMode: run.retryMode, projectVersionId: run.projectVersionId, assetId: run.assetId, assetVersionId: run.assetVersionId, assetIds: assets.map(asset => asset.assetId), assetVersionIds: assets.map(asset => asset.assetVersionId), documents: assets, documentTitle: run.documentTitle, documentVersion: `V${run.documentVersion}`, logicalPath: run.logicalPath, modelLabel: run.modelLabel, status: run.status, step: run.step, progress: run.progress, createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt, error: run.error, queue: run.queue, retryEvents: run.retryEvents, planningSubAgentRuns: structuredClone(run.planningSubAgentRuns ?? []), modelRouteAttempts: run.modelRouteAttempts, degradations: run.degradations, workflow: presentWorkflowSummary(run.workflow), snapshot: redactSnapshot(run.snapshot) }
}

function presentRun(run: ReviewRun) {
  const response = run.result && run.execution ? { runId: run.id, status: 'candidate_validated' as const, snapshot: redactSnapshot(run.snapshot), result: run.result, execution: run.execution, executions: run.executions, ...(run.inputDeliveryManifest ? { inputDeliveryManifest: run.inputDeliveryManifest } : {}) } : undefined
  return { ...presentRunSummary(run), workflow: run.workflow ? structuredClone(run.workflow) : undefined, executionAttempts: run.executionAttempts, execution: response ? undefined : run.execution, executions: response ? undefined : run.executions, inputDeliveryManifest: response ? undefined : run.inputDeliveryManifest, response }
}

function presentWorkflowSummary(workflow: RequirementWorkflowState | undefined) {
  if (!workflow) return undefined
  return {
    currentStage: workflow.currentStage,
    ...(workflow.release ? {
      release: {
        id: workflow.release.id,
        schemaVersion: workflow.release.schemaVersion,
        status: workflow.release.status,
        projectVersionId: workflow.release.projectVersionId,
        verificationRunId: workflow.release.verificationRunId,
        sourceAssetVersionIds: [...workflow.release.sourceAssetVersionIds],
        contentSha256: workflow.release.contentSha256,
        createdAt: workflow.release.createdAt,
        createdBy: workflow.release.createdBy,
        publishedAt: workflow.release.publishedAt,
        publishedBy: workflow.release.publishedBy,
        artifacts: workflow.release.artifacts.map(item => ({ fileName: item.fileName, mediaType: item.mediaType, contentSha256: item.contentSha256 })),
      },
    } : {}),
    ...(workflow.understandingSnapshot ? { understandingSnapshot: structuredClone(workflow.understandingSnapshot) } : {}),
    ...(workflow.automaticTransition ? { automaticTransition: structuredClone(workflow.automaticTransition) } : {}),
  }
}

function requirementDocumentWorkspace(projectVersion: DatabaseState['projectVersions'][number], projectVersions: DatabaseState['projectVersions'], logicalPath: string): NonNullable<ReviewRunSnapshot['documentWorkspace']> {
  const rootLogicalPath = 'workspace'
  const activeBranchLogicalPath = `${rootLogicalPath}/branches/${safeWorkspaceSegment(projectVersion.name)}`
  return { mode: 'agent_directory', logicalPath, rootLogicalPath, activeBranchLogicalPath, branchLogicalPaths: [...new Set(projectVersions.filter(item => item.projectId === projectVersion.projectId).map(item => `${rootLogicalPath}/branches/${safeWorkspaceSegment(item.name)}`))].sort((left, right) => left.localeCompare(right, 'zh-CN')), agentLogicalPath: `${rootLogicalPath}/agent_workspace/planning_agent`, layoutVersion: 'workspace/v1', candidateAssetVersionIds: [] }
}

type AgentModelSelection = { source: DatabaseState['modelSources'][number]; model: DatabaseState['modelSources'][number]['models'][number] }

function selectAgentModels(state: DatabaseState, configuration: AgentConfigurationVersion | null, requestModel: { sourceId: string; modelId: string } | null, label: string): AgentModelSelection[] {
  const configured = configuration?.routing.primaryModel ? [configuration.routing.primaryModel, ...(configuration.routing.fallbackEnabled ? configuration.routing.fallbackModels : [])] : []
  const references = (configuration ? configured : requestModel ? [requestModel] : []).filter(reference => {
    const source = state.modelSources.find(item => item.id === reference.sourceId && item.enabled)
    const model = source?.models.find(item => item.id === reference.modelId && item.enabled)
    return Boolean(model && model.health === 'healthy' && model.capabilities.includes('tool_calling'))
  })
  if (!references.length) throw new Error(configuration ? `${label}已发布配置中的模型当前均不可用` : `请先完成${label}模型的连通性探测并确保健康状态正常`)
  return references.map(reference => ({ source: required(state.modelSources.find(item => item.id === reference.sourceId), '模型来源不可用'), model: required(state.modelSources.find(item => item.id === reference.sourceId)?.models.find(item => item.id === reference.modelId), '模型不可用') }))
}

function requirePiWorkspaceAgentDefinition(definition: ReviewRunSnapshot['agentDefinition']) {
  const requiredTools = ['workspace.read_file', 'workspace.grep_files', 'workspace.find_files', 'workspace.list_directory', 'knowledge.search', 'knowledge.read_chunk', 'requirement-analysis.submit_result', 'requirement-release.submit_result']
  const missing = requiredTools.filter(toolId => !definition.toolIds.includes(toolId))
  if (definition.agentKey !== 'planning' || definition.resultSchemaVersion !== 'planning/v1' || missing.length) throw new Error(`PI_WORKSPACE_AGENT_CONFIGURATION_REQUIRED: 请重新发布 PlanningAgent${missing.length ? `；缺少工具 ${missing.join(', ')}` : ''}`)
}

function configuredMaxOutputTokens(configuration: AgentConfigurationVersion | null) {
  return configuration?.routing.maxOutputTokens ?? 32_000
}
function configuredContextWindow(configuration: AgentConfigurationVersion | null) {
  return configuration?.routing.contextWindow ?? 256_000
}
function supportsInputPlan(plan: RequirementInputPlan, contextWindow: number, maxOutputTokens: number) {
  if (plan.mode !== 'agent_directory') return false
  return contextWindow >= Math.max(...plan.batches.map(batch => batch.tokenCount), 0) + 4_000 + maxOutputTokens
}

function mergeFormalClarifications(existing: PlanningClarification[] | undefined, current: PlanningClarification[]) {
  const merged = new Map<string, PlanningClarification>()
  for (const item of existing ?? []) merged.set(item.id, structuredClone(item))
  for (const item of current) {
    const prior = merged.get(item.id)
    merged.set(item.id, prior && prior.status !== 'pending' ? prior : structuredClone(item))
  }
  return [...merged.values()]
}

function inputSnapshot(plan: RequirementInputPlan) { return { policyVersion: plan.policyVersion, mode: plan.mode, estimatedInputTokens: plan.estimatedInputTokens, safeInputBudget: plan.safeInputBudget, packageSha256: plan.packageSha256, batches: plan.batches.map(batch => ({ batchId: batch.batchId, ordinal: batch.ordinal, tokenCount: batch.tokenCount, contentSha256: createHash('sha256').update(batch.content).digest('hex'), assetVersionIds: [...batch.assetVersionIds], chunkIds: [...batch.chunkIds] })) } }
function modelSnapshot(selection: AgentModelSelection, contextWindow: number, maxOutputTokens: number): ReviewRunSnapshot['modelRef'] { return { sourceId: selection.source.id, modelId: selection.model.id, providerType: selection.source.providerType, modelName: selection.model.name, contextWindow, maxOutputTokens, supportsReasoning: selection.model.capabilities.includes('reasoning') } }
function modelConnection(selection: AgentModelSelection, snapshot: ReviewRunSnapshot['modelRef'], configuration: AgentConfigurationVersion | null) { return { sourceId: selection.source.id, providerType: selection.source.providerType, baseUrl: selection.source.baseUrl, apiKey: selection.source.apiKey, modelId: selection.model.id, modelName: selection.model.name, contextWindow: snapshot.contextWindow, maxOutputTokens: snapshot.maxOutputTokens, supportsReasoning: snapshot.supportsReasoning, requestTimeoutMs: configuration ? configuration.routing.requestTimeoutSeconds * 1_000 : undefined, retryCount: configuration?.routing.retryCount } }
function configurationRef(configuration: AgentConfigurationVersion) { return { id: configuration.id, version: configuration.version, contentSha256: configuration.contentSha256 } }
function redactSnapshot(snapshot: ReviewRunSnapshot) { return { ...snapshot, agentDefinition: { ...snapshot.agentDefinition, systemPrompt: undefined, taskTemplate: undefined } } }
function snapshotAssets(run: ReviewRun) { return run.snapshot.assets.map(item => ({ ...item })) }
function analysisIdFor(run: ReviewRun) { return run.reviewId ?? run.snapshot.reviewId ?? `analysis_${run.retryOfRunId ?? run.id}` }
function safeWorkspaceSegment(value: string) { const encode = (character: string) => `%${character.codePointAt(0)!.toString(16).toUpperCase().padStart(2, '0')}`; const source = value.normalize('NFC').trim() || '未命名版本'; let safe = source.replace(/[%<>:"/\\|?*\u0000-\u001F]/gu, encode).replace(/[. ]+$/gu, characters => [...characters].map(encode).join('')); if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(source)) safe = `${encode(source[0])}${safe.slice(1)}`; return safe }
function normalizeDocumentDirectoryPath(value: unknown) { const normalized = String(value ?? '').trim().replaceAll('\\', '/').replace(/^\/+|\/+$/gu, ''); const segments = normalized.split('/'); if (!normalized || /^[A-Za-z]:/u.test(normalized) || segments.some(segment => !segment || segment === '.' || segment === '..')) throw new Error('Agent 文档工作目录必须是知识库内的有效逻辑目录'); return normalized }
function isWithinDirectory(logicalPath: string, directoryPath: string) { const normalized = logicalPath.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, ''); return normalized.startsWith(`${directoryPath}/`) && normalized.length > directoryPath.length + 1 }
function buildAnalysisCoveragePlan(versions: Array<{ id: string; chunks: Array<{ id: string; contentHash: string; headingPath: string[]; startLine: number; endLine: number }> }>, excludedAreas: string[] | undefined) { const excluded = cleanList(excludedAreas).map(value => value.toLocaleLowerCase()); return versions.map(version => ({ assetVersionId: version.id, chunks: version.chunks.map(chunk => { const excludedReason = excluded.find(area => chunk.headingPath.join(' / ').toLocaleLowerCase().includes(area)); return { chunkId: chunk.id, contentHash: chunk.contentHash, headingPath: chunk.headingPath, startLine: chunk.startLine, endLine: chunk.endLine, ...(excludedReason ? { excludedReason: `用户排除范围：${excludedReason}` } : {}) } }) })) }
function cleanList(value: string[] | undefined) { return Array.isArray(value) ? [...new Set(value.map(item => String(item).trim()).filter(Boolean))].slice(0, 20) : [] }
function required<T>(value: T | undefined | null, message: string): T { if (value == null) throw new Error(message); return value }
function shouldCheckpointExecution(event: AgentExecutionEvent) { return ['tool_execution_end', 'turn_end', 'agent_end', 'result_submission_required', 'result_submission_retry', 'input_package_built', 'input_batch_delivered'].includes(event.type) }
function executionProgress(events: AgentExecutionEvent[]): AgentExecutionRecord { const framework = events.find(event => event.framework)?.framework; return { agentKey: 'planning', turns: events.reduce((maximum, event) => Math.max(maximum, event.turn ?? 0), 0), toolCalls: events.filter(event => event.type === 'tool_execution_start').length, toolErrors: events.filter(event => event.type === 'tool_execution_end' && event.isError).length, ...(framework ? { framework } : {}), events: structuredClone(events) } }
function executionRecord(output: AgentExecutionOutput): AgentExecutionRecord { return { agentKey: 'planning', turns: output.turns, toolCalls: output.toolCalls, toolErrors: output.toolErrors, framework: output.framework, context: output.context, events: output.events } }
function validationError(issues: Array<{ path: string; message: string }>) { return new Error(`AGENT_RESULT_VALIDATION_FAILED: ${issues.slice(0, 6).map(issue => `${issue.path} ${issue.message}`).join('；')}${issues.length > 6 ? `；另有 ${issues.length - 6} 项` : ''}`) }
function sanitizeRuntimeError(error: unknown, endpoint: string, credential: string) { let message = error instanceof Error ? error.message : 'PlanningAgent 执行失败'; if (credential) message = message.replaceAll(credential, '[已隐藏凭据]'); if (endpoint) message = message.replaceAll(endpoint, '[模型端点]'); return sanitize(message) }
function sanitize(message: string) { return message.replace(/https?:\/\/[^\s'"`]+/giu, '[已隐藏地址]').slice(0, 500) }
function encodeCursor(run: ReviewRun) { return Buffer.from(JSON.stringify([run.createdAt, run.id])).toString('base64url') }
function decodeCursor(cursor: string | undefined, runs: ReviewRun[]) { if (!cursor) return 0; try { const [createdAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[]; if (typeof createdAt !== 'string' || typeof id !== 'string') throw new Error('invalid'); const index = runs.findIndex(run => run.createdAt === createdAt && run.id === id); if (index < 0) throw new Error('invalid'); return index + 1 } catch { throw new Error('需求分析历史游标无效') } }
