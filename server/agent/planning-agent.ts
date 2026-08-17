import { createHash } from 'node:crypto'
import type { AgentDefinitionVersion, ReviewRunSnapshot } from '../domain/agent-types.js'
import { toolsetContentHash } from '../application/ai-resource-hash.js'

export function renderPlanningRequirementTask(snapshot: ReviewRunSnapshot) {
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
  if (snapshot.analysisInput?.mode !== 'agent_directory') throw new Error('PI_WORKSPACE_INPUT_REQUIRED: PlanningAgent 只支持 /workspace 文件工作区输入')
  const workspace = snapshot.documentWorkspace
  const currentInput = snapshot.currentInputRefs.map(item => ({ logicalPath: item.logicalPath.replace(/^workspace\//u, ''), assetVersionId: item.assetVersionId, contentSha256: item.contentSha256 }))
  const sourceScopes = Object.fromEntries([...new Set(snapshot.workspaceSnapshot.files.map(item => item.sourceScope))].map(scope => [scope, snapshot.workspaceSnapshot.files.filter(item => item.sourceScope === scope).length]))
  return `${rendered}\n\n本次运行使用 Pi Coding Agent 文件工作区协议。当前工作目录是 /${workspace?.rootLogicalPath ?? workspace?.logicalPath ?? 'workspace'}；活动分支是 /${workspace?.activeBranchLogicalPath ?? 'workspace/branches/unknown'}；本次冻结需求输入目录是 /${workspace?.logicalPath ?? snapshot.logicalPath}；PlanningAgent 目录是 /${workspace?.agentLogicalPath ?? 'workspace/agent_workspace/planning_agent'}。\n\n本次重点输入 currentInputRefs：${JSON.stringify(currentInput)}\n完整 ProjectWorkspaceSnapshot：${snapshot.workspaceSnapshot.files.length} 个冻结文件，来源统计 ${JSON.stringify(sourceScopes)}，Snapshot SHA-256 ${snapshot.workspaceSnapshot.snapshotSha256}。currentInputRefs 不是读取白名单。服务端已冻结正式输入范围和覆盖计划；请基于已投递内容建立理解，按需调用 ls、find、grep 或 read 浏览工作区中的相关固定资料。不要为了满足提交协议重复读取无关正文。只提交逐字 sourceTexts；Evidence、ID、定位和覆盖均由服务端依据固定输入生成和校验。可自主浏览 branches、shared 与 formal-output；历史或参考资料不能替代当前需求事实。Knowledge 工具返回会显式标记事实范围。不得调用 Shell、write、edit 或越过 /workspace。\n\n服务端正式 Human Clarifications：${JSON.stringify(snapshot.formalClarifications ?? [])}。answered/dismissed 项是带来源的正式输入，必须纳入更新后的需求理解；不得依赖模型记忆恢复。已回答的问题不要重复提问。只有无法从正式输入确定且会影响测试正确性的事实才提交 blocking Clarification，普通 Finding 不阻塞流程。\n\n本阶段唯一的正式结果入口是 requirement_analysis_submit_result。完成 Self Review 后，必须且只能通过该工具提交完整 requirement-analysis/v1 候选（包括 clarifications，若无问题则为空数组）；若服务端返回校验问题，按错误修正后仍只能通过同一工具重新提交。普通文本、Markdown 或中间 JSON 不会被采纳。`
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
    modelScene: input.modelScene ?? 'planning', resultSchemaVersion: input.resultSchemaVersion,
    systemPrompt: input.systemPrompt, taskTemplate: input.taskTemplate,
    promptRef: { promptKey: input.promptKey, version: input.version, contentSha256: promptContentSha256 },
    toolsetVersion: input.version,
    toolsetContentSha256: toolsetContentHash(input.tools),
    skillBindings: structuredClone(input.skills ?? []), enabledSkills: (input.skills ?? []).filter(item => item.enabled).map(item => item.skillKey), mcpBindings: structuredClone(input.mcps ?? []), toolIds: input.tools.map(item => item.split('@')[0]), limits: input.limits,
  }
  return { ...value, contentSha256: createHash('sha256').update(JSON.stringify(value)).digest('hex') }
}
