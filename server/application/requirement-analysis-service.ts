import { randomUUID } from 'node:crypto'
import type { AgentRuntime } from '../domain/agent-types.js'
import type { StateStore } from '../infrastructure/store.js'
import { ReviewResultValidator } from '../agent/result-validator.js'
import { createRequirementAnalysisAgentDefinition } from '../agent/requirement-analysis-agent.js'

export interface RequirementAnalysisRequest {
  assetVersionId: string
  sourceId: string
  modelId: string
  focusAreas?: string[]
  excludedAreas?: string[]
}

export class RequirementAnalysisService {
  private readonly validator: ReviewResultValidator
  constructor(private readonly store: StateStore, private readonly runtime: AgentRuntime) { this.validator = new ReviewResultValidator(store) }

  async analyze(request: RequirementAnalysisRequest, signal = new AbortController().signal) {
    const state = await this.store.snapshot()
    const version = required(state.versions.find(item => item.id === request.assetVersionId), '需求资产版本不存在')
    if (version.status !== 'ready') throw new Error('需求资产版本尚未就绪')
    const asset = required(state.assets.find(item => item.id === version.assetId), '需求资产不存在')
    if (asset.assetType !== 'requirement') throw new Error('只有 requirement 类型资产可以发起需求评审')
    const knowledgeBase = required(state.knowledgeBases.find(item => item.id === asset.knowledgeBaseId), '知识库不存在')
    const project = required(state.projects.find(item => item.id === knowledgeBase.projectId), '项目不存在')
    const index = required(state.indexes.find(item => item.id === knowledgeBase.activeIndexVersionId && item.status === 'active'), '知识库没有活动索引')
    if (!index.assetVersionIds.includes(version.id)) throw new Error('需求资产版本不属于当前活动索引')
    const source = required(state.modelSources.find(item => item.id === request.sourceId && item.enabled), '生成式模型来源不可用')
    const model = required(source.models.find(item => item.id === request.modelId && item.enabled), '生成式模型不可用')
    if (!model.capabilities.includes('tool_calling')) throw new Error('需求分析模型必须支持 tool_calling')
    if (model.health !== 'healthy') throw new Error('请先完成所选生成式模型的连通性探测并确保健康状态正常')
    const definition = createRequirementAnalysisAgentDefinition()
    const estimatedInputTokens = Math.ceil(version.content.length / 4) + 4_000
    if (estimatedInputTokens + model.maxOutputTokens > model.contextWindow) throw new Error('需求版本超过模型上下文预算，请选择更大上下文模型')
    const snapshot = {
      runId: `review_run_${randomUUID()}`,
      projectId: project.id,
      projectName: project.name,
      knowledgeBaseId: knowledgeBase.id,
      assetId: asset.id,
      assetVersionId: version.id,
      assetContentHash: version.contentHash,
      indexVersionId: index.id,
      logicalPath: asset.logicalPath,
      focusAreas: cleanList(request.focusAreas),
      excludedAreas: cleanList(request.excludedAreas),
      agentDefinition: definition,
      createdAt: new Date().toISOString(),
    }
    let output: Awaited<ReturnType<AgentRuntime['execute']>>
    try {
      output = await this.runtime.execute({
        snapshot,
        model: { sourceId: source.id, providerType: source.providerType, baseUrl: source.baseUrl, apiKey: source.apiKey, modelId: model.id, modelName: model.name, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens },
      }, signal)
    } catch (error) {
      throw new Error(sanitizeRuntimeError(error, source.baseUrl, source.apiKey))
    }
    const validation = await this.validator.validate(output.candidate, snapshot)
    if (!validation.valid) throw new Error(`AGENT_RESULT_VALIDATION_FAILED: ${validation.issues.map(issue => `${issue.path} ${issue.message}`).join('；')}`)
    return { runId: snapshot.runId, status: 'candidate_validated' as const, snapshot: { ...snapshot, agentDefinition: { ...definition, systemPrompt: undefined, taskTemplate: undefined } }, result: output.candidate, execution: { turns: output.turns, toolCalls: output.toolCalls, framework: output.framework, events: output.events } }
  }
}

function required<T>(value: T | undefined, message: string): T { if (value === undefined) throw new Error(message); return value }
function cleanList(value: string[] | undefined) { return Array.isArray(value) ? [...new Set(value.map(item => String(item).trim()).filter(Boolean))].slice(0, 20) : [] }
function sanitizeRuntimeError(error: unknown, endpoint: string, credential: string) {
  let message = error instanceof Error ? error.message : '需求分析 Agent 执行失败'
  if (credential) message = message.replaceAll(credential, '[已隐藏凭据]')
  if (endpoint) message = message.replaceAll(endpoint, '[模型端点]')
  return message.replace(/https?:\/\/[^\s'"`]+/giu, '[已隐藏地址]').slice(0, 500)
}