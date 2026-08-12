import { createHash } from 'node:crypto'
import type { AgentDefinitionVersion, ReviewRunSnapshot } from '../domain/agent-types.js'
import { toolsetContentHash } from '../application/ai-resource-hash.js'

export function renderRequirementAnalysisTask(snapshot: ReviewRunSnapshot) {
  const template = snapshot.agentDefinition.taskTemplate
  const rendered = template
    .replace('{{projectName}}', snapshot.projectName)
    .replace('{{assetCount}}', String(snapshot.assets.length))
    .replace('{{logicalPaths}}', '请使用 ls/find 自主查看')
    .replace('{{runId}}', snapshot.runId)
    .replace('{{assetVersionIds}}', '服务端已冻结，不向模型暴露')
    .replace('{{indexVersionId}}', snapshot.indexVersionId)
    .replace('{{focusAreas}}', snapshot.focusAreas.join('、') || '完整性、边界、状态、异常和可测试性')
    .replace('{{excludedAreas}}', snapshot.excludedAreas.join('、') || '无')
    .replace('{{inputMode}}', snapshot.analysisInput?.mode ?? 'agent_directory')
    .replace('{{estimatedInputTokens}}', String(snapshot.analysisInput?.estimatedInputTokens ?? 0))
    .replace('{{safeInputBudget}}', String(snapshot.analysisInput?.safeInputBudget ?? 0))
  if (snapshot.analysisInput?.mode !== 'agent_directory') throw new Error('PI_WORKSPACE_INPUT_REQUIRED: RequirementAnalysisAgent 只支持 /workspace 文件工作区输入')
  const workspace = snapshot.documentWorkspace
  return `${rendered}\n\n本次运行使用 Pi Coding Agent 文件工作区协议。当前工作目录是 /${workspace?.rootLogicalPath ?? workspace?.logicalPath ?? 'workspace'}；活动分支是 /${workspace?.activeBranchLogicalPath ?? 'workspace/branches/unknown'}；本次冻结需求输入目录是 /${workspace?.logicalPath ?? snapshot.logicalPath}；Requirement Agent 目录是 /${workspace?.agentLogicalPath ?? 'workspace/agent_workspace/requirement_agent'}。输入不包含文件清单或正文。请先调用 ls，从工作区目录树开始探索；可用 find 查找文件、grep 定位文本，随后必须使用 read 按相对路径读取需要分析或引用的文件。grep 不形成正文投递证明，只有 read 实际返回的当前需求行范围可用于 sourceTexts。Knowledge 工具返回会显式标记 current_requirement 或 knowledge_reference，必须保持事实边界。不得调用 Shell、write、edit 或越过 /workspace。`
}

export function createAgentDefinitionVersion(input: {
  agentKey: AgentDefinitionVersion['agentKey']
  agentType: AgentDefinitionVersion['agentType']
  resultSchemaVersion: AgentDefinitionVersion['resultSchemaVersion']
  version: string
  systemPrompt: string
  taskTemplate: string
  promptKey: string
  tools: string[]
  skills?: AgentDefinitionVersion['skillBindings']
  mcps?: AgentDefinitionVersion['mcpBindings']
  limits: AgentDefinitionVersion['limits']
  modelScene?: AgentDefinitionVersion['modelScene']
}): AgentDefinitionVersion {
  const promptContentSha256 = createHash('sha256').update(`${input.systemPrompt}\n${input.taskTemplate}`).digest('hex')
  const value = {
    agentKey: input.agentKey, agentType: input.agentType, version: input.version, status: 'published' as const,
    modelScene: input.modelScene ?? 'requirement_analysis', resultSchemaVersion: input.resultSchemaVersion,
    systemPrompt: input.systemPrompt, taskTemplate: input.taskTemplate,
    promptRef: { promptKey: input.promptKey, version: input.version, contentSha256: promptContentSha256 },
    toolsetVersion: input.version,
    toolsetContentSha256: toolsetContentHash(input.tools),
    skillBindings: structuredClone(input.skills ?? []), mcpBindings: structuredClone(input.mcps ?? []), toolIds: input.tools.map(item => item.split('@')[0]), limits: input.limits,
  }
  return { ...value, contentSha256: createHash('sha256').update(JSON.stringify(value)).digest('hex') }
}

export function renderTechnicalSolutionTask(snapshot: import('../domain/technical-solution-types.js').TechnicalSolutionRunSnapshot) {
  return `${snapshot.agentDefinition.taskTemplate}\n\n运行：${snapshot.runId}\n项目版本：${snapshot.projectVersionName}\n固定技术方案：${snapshot.solutionInputs.map(item => `${item.displayName}(${item.assetVersionId})`).join('、')}`
}

export function renderTechnicalSegmentBatchTask(batchNumber: number, batchCount: number, content: string) {
  return `这是技术方案 segmented_context 第 ${batchNumber}/${batchCount} 批固定正文。只分析本批资料并输出紧凑 JSON 草稿，记录与冻结需求的覆盖线索、接口/数据/异常/非功能缺口及逐字原文；此阶段没有提交工具。\n\n${content}`
}

export function renderTechnicalSegmentMergeTask(snapshot: import('../domain/technical-solution-types.js').TechnicalSolutionRunSnapshot, drafts: string[]) {
  return `${renderTechnicalSolutionTask(snapshot)}\n\n这是最终跨批归并阶段。合并以下全部批次草稿，按原子粒度去重技术方案要点，并通过 technical_solution_points_submit_result 提交完整 technical-solution-extraction/v1。\n\n${drafts.map((draft, index) => `<<<BATCH_DRAFT ${index + 1}>>>\n${draft}\n<<<END_BATCH_DRAFT ${index + 1}>>>`).join('\n\n')}`
}

export function renderTechnicalSolutionReviewTask(snapshot: import('../domain/technical-solution-types.js').TechnicalSolutionRunSnapshot, extraction: import('../domain/technical-solution-types.js').TechnicalSolutionExtractionResult) {
  const baseline = snapshot.requirementBaseline
  const requirements = baseline.requirementPoints.map(point => ({ id: point.id, title: point.title, description: point.description, findingContext: baseline.findings.filter(item => item.requirementPointIds.includes(point.id)).map(item => ({ id: item.id, severity: item.severity, state: item.state, title: item.title, description: item.description })) }))
  const solutionPoints = extraction.solutionPoints.map(point => ({ id: point.id, title: point.title, description: point.description, evidence: extraction.evidence.filter(item => point.evidenceIds.includes(item.id)).map(item => item.quote) }))
  return `${snapshot.agentDefinition.taskTemplate}\n\n运行：${snapshot.runId}\n以下 JSON 已由 SmartHub 校验并冻结，只能引用，禁止改写：\n<<<FROZEN_REQUIREMENTS>>>\n${JSON.stringify(requirements)}\n<<<END_FROZEN_REQUIREMENTS>>>\n\n<<<FROZEN_TECHNICAL_SOLUTION_POINTS>>>\n${JSON.stringify(solutionPoints)}\n<<<END_FROZEN_TECHNICAL_SOLUTION_POINTS>>>`
}
