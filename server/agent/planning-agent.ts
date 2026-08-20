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
  const formalClarifications = snapshot.formalClarifications ?? []
  return [
    planningRequirementModeInstruction(),
    [
      '<configuration_task_template>',
      '以下内容来自本 Run 固定的 PlanningAgent 配置，用于补充本轮任务背景。',
      rendered,
      '</configuration_task_template>',
    ].join('\n'),
    [
      '<frozen_run_context>',
      `runId=${snapshot.runId}`,
      `project=${snapshot.projectName}`,
      `workspaceRoot=/${workspace?.rootLogicalPath ?? workspace?.logicalPath ?? 'workspace'}`,
      `activeBranch=/${workspace?.activeBranchLogicalPath ?? 'workspace/branches/unknown'}`,
      `requirementInputDirectory=/${workspace?.logicalPath ?? snapshot.logicalPath}`,
      `planningAgentDirectory=/${workspace?.agentLogicalPath ?? 'workspace/agent_workspace/planning_agent'}`,
      `currentInputRefs=${JSON.stringify(currentInput)}`,
      `projectWorkspaceSnapshot=${JSON.stringify({ fileCount: snapshot.workspaceSnapshot.files.length, sourceScopes, snapshotSha256: snapshot.workspaceSnapshot.snapshotSha256 })}`,
      '</frozen_run_context>',
    ].join('\n'),
    [
      '<workspace_rules>',
      '1. currentInputRefs 是本次重点输入，不是读取白名单；完整 ProjectWorkspaceSnapshot 才是可读取边界。',
      '2. 先读取重点输入，再按需使用 ls、find、grep、read 浏览冻结 Workspace；未读取内容不得假设。',
      '3. branches、shared、formal-output、Knowledge 和历史资料只可作为标明来源的参考，不能替代当前正式需求事实。',
      '4. 不得调用 Shell、write、edit，不得使用绝对路径、../ 或越过 /workspace。',
      '</workspace_rules>',
    ].join('\n'),
    [
      '<formal_clarification_rules>',
      `formalClarifications=${JSON.stringify(formalClarifications)}`,
      '1. status=answered 的 answer 是正式业务事实，必须纳入更新后的需求理解。',
      '2. status=dismissed 的 answer 只是处置理由，不是业务规则、权限、边界或 Expected Result；相关事实缺口必须保留。',
      '3. Snapshot 中已有的 answered/dismissed 问题不得重复提交。只有无法从正式输入确定且会影响测试正确性的事实，才是新的 blocking Clarification。',
      '4. 同一轮识别到的 blocking Clarification 必须一次性完整提交。',
      '</formal_clarification_rules>',
    ].join('\n'),
    [
      '<requirement_analysis_output_contract>',
      '本轮结果范围是需求理解、Clarification 与 Test Focus；Test Focus 是后续测试设计的风险关注点。',
      'TestCase、Case ID、Revision、Version、Hash、Library 变更和 Handoff 不属于本轮结果 Schema。',
      'RequirementPoint 中只提供来自固定输入的逐字 sourceTexts；Evidence、ID、定位和覆盖由服务端生成并校验。',
      '完成 Self Review 后，通过 requirement_analysis_submit_result 提交一个完整 requirement-analysis/v1 候选；没有新 Clarification 时提交空数组。',
      '若服务端拒绝候选，根据返回的错误路径修正后重新提交；普通文本、Markdown 或中间 JSON 不会被采纳。',
      '</requirement_analysis_output_contract>',
    ].join('\n'),
  ].join('\n\n')
}

function planningRequirementModeInstruction() {
  return [
    '<current_requirement_task mode="initial_analysis">',
    '请分析当前需求。',
    '基于本 Run 固定输入形成完整、可追溯的需求理解候选，并识别边界、状态、异常、冲突、事实缺口和后续测试关注点。',
    '</current_requirement_task>',
  ].join('\n')
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
