import { randomUUID } from 'node:crypto'
import type { AgentDefinitionResolver, AgentRuntime } from '../domain/agent-types.js'
import type { ReviewRun } from '../domain/types.js'
import type { StateStore } from '../infrastructure/store.js'
import { ReviewResultValidator } from '../agent/result-validator.js'
import { BuiltInAgentDefinitionResolver } from '../agent/requirement-analysis-agent.js'

export interface RequirementAnalysisRequest {
  projectVersionId: string
  assetVersionId: string
  sourceId: string
  modelId: string
  focusAreas?: string[]
  excludedAreas?: string[]
}

export class RequirementAnalysisService {
  private readonly validator: ReviewResultValidator
  private readonly activeRuns = new Map<string, AbortController>()
  constructor(private readonly store: StateStore, private readonly runtime: AgentRuntime, private readonly definitions: AgentDefinitionResolver = new BuiltInAgentDefinitionResolver()) { this.validator = new ReviewResultValidator(store) }

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
    const version = required(state.versions.find(item => item.id === request.assetVersionId), '需求资产版本不存在')
    if (version.status !== 'ready') throw new Error('需求资产版本尚未就绪')
    const asset = required(state.assets.find(item => item.id === version.assetId), '需求资产不存在')
    if (asset.assetType !== 'requirement') throw new Error('只有 requirement 类型资产可以发起需求评审')
    const knowledgeBase = required(state.knowledgeBases.find(item => item.id === asset.knowledgeBaseId), '知识库不存在')
    const project = required(state.projects.find(item => item.id === knowledgeBase.projectId), '项目不存在')
    if (projectVersion.projectId !== project.id) throw new Error('需求资产不属于当前项目版本')
    required(state.projectVersionRequirementBindings.find(item => item.projectVersionId === projectVersion.id && item.assetId === asset.id && item.assetVersionId === version.id), '需求资产版本未绑定到当前项目版本')
    const index = required(state.indexes.find(item => item.id === knowledgeBase.activeIndexVersionId && item.status === 'active'), '知识库没有活动索引')
    if (!index.assetVersionIds.includes(version.id)) throw new Error('需求资产版本不属于当前活动索引')
    const source = required(state.modelSources.find(item => item.id === request.sourceId && item.enabled), '生成式模型来源不可用')
    const model = required(source.models.find(item => item.id === request.modelId && item.enabled), '生成式模型不可用')
    if (!model.capabilities.includes('tool_calling')) throw new Error('需求分析模型必须支持 tool_calling')
    if (model.health !== 'healthy') throw new Error('请先完成所选生成式模型的连通性探测并确保健康状态正常')
    const definition = await this.definitions.resolve('requirement-analysis')
    const estimatedInputTokens = Math.ceil(version.content.length / 4) + 4_000
    if (estimatedInputTokens + model.maxOutputTokens > model.contextWindow) throw new Error('需求版本超过模型上下文预算，请选择更大上下文模型')
    const now = new Date().toISOString()
    const snapshot = {
      runId: `review_run_${randomUUID()}`,
      projectId: project.id,
      projectName: project.name,
      projectVersionId: projectVersion.id,
      projectVersionName: projectVersion.name,
      knowledgeBaseId: knowledgeBase.id,
      assetId: asset.id,
      assetVersionId: version.id,
      assetContentHash: version.contentHash,
      indexVersionId: index.id,
      logicalPath: asset.logicalPath,
      modelRef: { sourceId: source.id, modelId: model.id, providerType: source.providerType, modelName: model.name, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens },
      focusAreas: cleanList(request.focusAreas),
      excludedAreas: cleanList(request.excludedAreas),
      agentDefinition: definition,
      createdAt: now,
    }
    const run: ReviewRun = {
      id: snapshot.runId,
      projectVersionId: projectVersion.id,
      assetId: asset.id,
      assetVersionId: version.id,
      documentTitle: asset.displayName,
      documentVersion: version.number,
      logicalPath: asset.logicalPath,
      sourceId: source.id,
      modelId: model.id,
      modelLabel: `${source.name} · ${model.displayName}`,
      status: 'running',
      step: 'agent_executing',
      progress: 10,
      createdAt: now,
      startedAt: now,
      snapshot,
    }
    await this.store.transaction(draft => { draft.reviewRuns.push(run) })
    onCreated?.(presentRun(run))
    try {
      const output = await this.runtime.execute({
        snapshot,
        model: { sourceId: source.id, providerType: source.providerType, baseUrl: source.baseUrl, apiKey: source.apiKey, modelId: model.id, modelName: model.name, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens },
      }, signal)
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('AGENT_CANCELLED')
      const validation = await this.validator.validate(output.candidate, snapshot)
      if (!validation.valid) throw new Error(`AGENT_RESULT_VALIDATION_FAILED: ${validation.issues.map(issue => `${issue.path} ${issue.message}`).join('；')}`)
      const finishedAt = new Date().toISOString()
      await this.store.transaction(draft => {
        const current = required(draft.reviewRuns.find(item => item.id === run.id), '需求评审运行不存在')
        Object.assign(current, { status: 'succeeded', step: 'completed', progress: 100, finishedAt, result: output.candidate, execution: { turns: output.turns, toolCalls: output.toolCalls, framework: output.framework, events: output.events }, error: undefined } satisfies Partial<ReviewRun>)
      })
      const completed = await this.get(run.id)
      return required(completed.response, '需求评审结果不存在')
    } catch (error) {
      const message = sanitizeRuntimeError(error, source.baseUrl, source.apiKey)
      const status = signal.aborted || /AGENT_CANCELLED|客户端已中断/u.test(message) ? 'cancelled' : 'failed'
      await this.store.transaction(draft => {
        const current = required(draft.reviewRuns.find(item => item.id === run.id), '需求评审运行不存在')
        Object.assign(current, { status, step: status === 'cancelled' ? 'cancelled' : 'failed', progress: current.progress, finishedAt: new Date().toISOString(), error: message } satisfies Partial<ReviewRun>)
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
}

function presentRunSummary(run: ReviewRun) {
  return {
    id: run.id,
    runId: run.id,
    projectVersionId: run.projectVersionId,
    assetId: run.assetId,
    assetVersionId: run.assetVersionId,
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
    error: run.error,
    snapshot: redactSnapshot(run.snapshot),
  }
}

function presentRun(run: ReviewRun) {
  const response = run.result && run.execution ? {
    runId: run.id,
    status: 'candidate_validated' as const,
    snapshot: redactSnapshot(run.snapshot),
    result: run.result,
    execution: run.execution,
  } : undefined
  return {
    id: run.id,
    runId: run.id,
    projectVersionId: run.projectVersionId,
    assetId: run.assetId,
    assetVersionId: run.assetVersionId,
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
    error: run.error,
    snapshot: redactSnapshot(run.snapshot),
    response,
  }
}

function redactSnapshot(snapshot: ReviewRun['snapshot']) {
  const definition = snapshot.agentDefinition
  return { ...snapshot, agentDefinition: { ...definition, systemPrompt: undefined, taskTemplate: undefined } }
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
function required<T>(value: T | undefined | null, message: string): T { if (value == null) throw new Error(message); return value }
function cleanList(value: string[] | undefined) { return Array.isArray(value) ? [...new Set(value.map(item => String(item).trim()).filter(Boolean))].slice(0, 20) : [] }
function sanitizeRuntimeError(error: unknown, endpoint: string, credential: string) {
  let message = error instanceof Error ? error.message : '需求分析 Agent 执行失败'
  if (credential) message = message.replaceAll(credential, '[已隐藏凭据]')
  if (endpoint) message = message.replaceAll(endpoint, '[模型端点]')
  return message.replace(/https?:\/\/[^\s'"`]+/giu, '[已隐藏地址]').slice(0, 500)
}
