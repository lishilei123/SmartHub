import { createHash } from 'node:crypto'
import type { AgentDefinitionVersion, ReviewRunSnapshot } from '../domain/agent-types.js'
import { toolsetContentHash } from '../application/ai-resource-hash.js'
import type { CandidateRequirementPointExtraction } from '../domain/review-types.js'

export function renderRequirementTask(snapshot: ReviewRunSnapshot, fixedExtraction?: CandidateRequirementPointExtraction) {
  const template = snapshot.agentDefinition.taskTemplate
  return template
    .replace('{{projectName}}', snapshot.projectName)
    .replace('{{assetCount}}', String(snapshot.assets.length))
    .replace('{{logicalPaths}}', snapshot.assets.map(asset => asset.logicalPath).join('、'))
    .replace('{{runId}}', snapshot.runId)
    .replace('{{assetVersionIds}}', snapshot.assets.map(asset => asset.assetVersionId).join('、'))
    .replace('{{indexVersionId}}', snapshot.indexVersionId)
    .replace('{{focusAreas}}', snapshot.focusAreas.join('、') || '完整性、边界、状态、异常和可测试性')
    .replace('{{excludedAreas}}', snapshot.excludedAreas.join('、') || '无')
    .replace('{{inputMode}}', snapshot.extractionInput?.mode ?? 'legacy_tool_chunk')
    .replace('{{estimatedInputTokens}}', String(snapshot.extractionInput?.estimatedInputTokens ?? 0))
    .replace('{{safeInputBudget}}', String(snapshot.extractionInput?.safeInputBudget ?? 0))
    .replace('{{fixedExtraction}}', fixedExtraction ? JSON.stringify(fixedExtraction) : '缺少固定需求点提取结果')
}

export function renderSegmentBatchTask(batchNumber: number, batchCount: number, content: string) {
  return `这是 segmented_context 第 ${batchNumber}/${batchCount} 批固定正文。只分析本批正文并输出紧凑 JSON 草稿；每条 requirementPoint 生成简洁 title，并包含 description 和 sourceTexts，此阶段没有提交工具。sourceTexts 优先复制完整原文句子或条目，供服务端最终检索和跨批去重使用。\n\n${content}`
}

export function renderSegmentMergeTask(snapshot: ReviewRunSnapshot, drafts: string[]) {
  return `${renderRequirementTask(snapshot)}\n这是 segmented_context 最终跨批归并阶段。以下批次草稿都来自已成功投递的固定正文。跨批去重并检查主体、条件、状态、异常、权限、数据约束和验收标准是否遗漏；语义完全相同的重复点只保留一个并合并全部 sourceTexts。最终每条需求点生成简洁 title，并提交 description 和 sourceTexts，然后通过 requirement_points_submit_result 提交 requirement-point-extraction/v5。\n\n${drafts.map((draft, index) => `<<<BATCH_DRAFT ${index + 1}>>>\n${draft}\n<<<END_BATCH_DRAFT ${index + 1}>>>`).join('\n\n')}`
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
