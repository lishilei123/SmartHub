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
      '2. 完整 Workspace 是授权边界，不是默认遍历清单。对 currentInputRefs 按冻结 Hash 建立一次连续、非重叠的完整读取；同一 Hash 和所需行范围的正文仍在当前 Context 时直接复用。仅为缺失事实、未读范围或压缩后不可见正文使用最窄范围的 ls、find、grep 或 read；未读取且未被当前 Context 支持的内容不得假设。',
      '3. branches、shared、formal-output、Knowledge 和历史资料只可作为标明来源的参考，不能替代当前正式需求事实；补充资料先定位，再读取最小必要范围。',
      '4. 不得调用 Shell、write、edit，不得使用绝对路径、../ 或越过 /workspace。',
      '</workspace_rules>',
    ].join('\n'),
    [
      '<formal_clarification_rules>',
      `formalClarifications=${JSON.stringify(formalClarifications)}`,
      '1. status=answered 的 answer 是正式业务事实，必须纳入更新后的需求理解。',
      '2. status=dismissed 的 answer 只是处置理由，不是业务规则、权限、边界或 Expected Result；相关事实缺口必须保留。',
      '3. Snapshot 中已有的 answered/dismissed 问题不得重复提交。blocking=true 仅限当前 Requirement、Formal Clarification 与 Workspace 都无法确定的核心业务事实；该事实必须直接改变核心操作、对象关系、状态/权限规则或核心 Expected Result，且不能仅测试已明确部分继续形成任何正确核心 Case。',
      '4. Knowledge、测试最佳实践、额外边界、错误文案、覆盖深度或仍可作为 Test Focus / Risk 的事项不得 blocking；不要为普通风险创建非阻断 Clarification。',
      '5. 每个 blocking 问题的 reason 必须说明无法正确形成的核心 TestCase 或 Expected Result；多个相关维度合并为一个业务决策。',
      '6. 同一轮识别到的 blocking Clarification 必须一次性完整提交。',
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
