import { createHash } from 'node:crypto'
import { defaultTokenCodec } from '../application/content.js'
import type {
  AgentDefinitionVersion,
  CurrentInputRef,
  ProjectWorkspaceSnapshot,
  RequirementInputPlan,
  TestExecutionAgentSnapshot,
} from '../domain/agent-types.js'
import type { TestDesignWorkspaceSnapshot } from '../domain/test-design-types.js'
import type { PlanningClarification } from '../domain/review-types.js'
import type { Asset, AssetVersion } from '../domain/types.js'

const TOOL_SCHEMA_RESERVE_TOKENS = 2_000
const SAFETY_MARGIN_TOKENS = 1_024

export interface RequirementContextAsset {
  asset: Pick<Asset, 'id' | 'displayName' | 'logicalPath' | 'assetType'>
  version: Pick<AssetVersion, 'id' | 'content' | 'contentHash' | 'chunks'>
}

export function buildRequirementDirectoryInputPlan(input: {
  workspacePath: string
  workspaceRootPath?: string
  activeBranchPath?: string
  agentWorkspacePath?: string
  assets: RequirementContextAsset[]
  currentInputRefs: CurrentInputRef[]
  workspaceSnapshot: ProjectWorkspaceSnapshot
  formalClarifications?: PlanningClarification[]
  definition: AgentDefinitionVersion
  contextWindow: number
  maxOutputTokens: number
}): RequirementInputPlan {
  const safeInputBudget = safeBudget(input)
  const content = [
    '<<<SMARTHUB_PI_DOCUMENT_WORKSPACE_BEGIN>>>',
    JSON.stringify({
      mode: 'agent_directory',
      cwd: '/',
      rootLogicalPath: input.workspaceRootPath ?? input.workspacePath,
      activeBranchPath: input.activeBranchPath,
      requirementInputPath: input.workspacePath,
      agentWorkspacePath: input.agentWorkspacePath,
      currentInputRefs: input.currentInputRefs.map(item => ({ logicalPath: item.logicalPath.replace(/^workspace\//u, ''), assetVersionId: item.assetVersionId, contentSha256: item.contentSha256 })),
      currentInputCount: input.currentInputRefs.length,
      workspaceFileCount: input.workspaceSnapshot.files.length,
      workspaceSourceScopes: Object.fromEntries([...new Set(input.workspaceSnapshot.files.map(item => item.sourceScope))].map(scope => [scope, input.workspaceSnapshot.files.filter(item => item.sourceScope === scope).length])),
      workspaceSnapshotSha256: input.workspaceSnapshot.snapshotSha256,
      formalClarifications: input.formalClarifications ?? [],
      clarificationInstruction: 'status=answered 的 answer 是带来源的正式业务事实，必须采用；status=dismissed 是可追溯的人工处置，answer 仅为不适用或接受缺口的理由，不得据此推导业务规则或 Expected Result。两类记录都不得重复提问；pending blocking Clarification 仍须等待人工，不得猜测。',
      instructions: 'currentInputRefs 是本次重点；完整 ProjectWorkspaceSnapshot 是只读授权边界，不是默认遍历清单。先按当前输入的冻结 Hash 建立一次连续、非重叠的读取计划；同一 Hash 和所需行范围的正文仍在 Context 时直接复用。仅为缺失事实、未读范围或压缩后不可见正文使用范围最小的 ls、find、grep、read 或 Knowledge；不要为了确认、提交协议或多个 Skill 的方法重叠重复读取无关正文，也不得越过工作目录。Evidence、ID、定位与覆盖仍由服务端根据 sourceTexts 生成和校验。',
    }),
    '<<<SMARTHUB_PI_DOCUMENT_WORKSPACE_END>>>',
  ].join('\n')
  const estimatedInputTokens = defaultTokenCodec.count(content)
  if (estimatedInputTokens > safeInputBudget) throw new Error(`INPUT_CONTEXT_BUDGET_EXCEEDED: 文档目录清单需要 ${estimatedInputTokens} Token，超过安全输入预算 ${safeInputBudget}；请缩小 Agent 工作目录`)
  return {
    policyVersion: '3.0.0',
    mode: 'agent_directory',
    estimatedInputTokens,
    safeInputBudget,
    packageSha256: sha256(content),
    batches: [{
      batchId: 'document_workspace_manifest',
      ordinal: 0,
      tokenCount: estimatedInputTokens,
      assetVersionIds: input.currentInputRefs.map(item => item.assetVersionId),
      chunkIds: [],
      content,
    }],
  }
}

export function buildTestDesignDirectoryInputPlan(input: {
  workspace: TestDesignWorkspaceSnapshot
  definition: AgentDefinitionVersion
  contextWindow: number
  maxOutputTokens: number
}): RequirementInputPlan {
  const safeInputBudget = safeBudget(input)
  const coreFactPaths = coreTestDesignFactPaths(input.workspace)
  const content = [
    '<<<SMARTHUB_PI_TEST_DESIGN_WORKSPACE_BEGIN>>>',
    JSON.stringify({
      mode: 'agent_directory',
      cwd: '/',
      rootLogicalPath: input.workspace.rootLogicalPath,
      activeBranchPath: input.workspace.activeBranchLogicalPath,
      agentWorkspacePath: input.workspace.agentLogicalPath,
      fileCount: input.workspace.files.length,
      workspaceSnapshotSha256: input.workspace.snapshotSha256,
      requirementReleaseId: input.workspace.requirementReleaseId,
      currentInputRefs: input.workspace.files.filter(file => file.sourceScope === 'current_input').map(file => ({ logicalPath: file.logicalPath.replace(/^workspace\//u, ''), assetVersionId: file.assetVersionId, contentSha256: file.contentSha256 })),
      coreFactPaths,
      instructions: 'Requirement Release 是当前正式需求基线；currentInputRefs 是上传资料重点。完整冻结 Workspace 是授权边界，不是根目录枚举要求。先读取 coreFactPaths：同一 Hash 的大文件使用连续、非重叠 offset 范围；正文仍在当前 Context 时直接复用。historical-test-cases.json 是唯一历史用例库基线；test-case-library/v*/ 下的正式投影不能用于重复建立历史基线。其他 Workspace 或共享知识仅为已命名的当前事实缺口或风险使用最窄范围的 ls/find/grep/read 或 Knowledge；禁止为发现已列明文件执行根目录 find("**") 或批量读取。不得调用 Shell、write、edit 或越过工作区。',
    }),
    '<<<SMARTHUB_PI_TEST_DESIGN_WORKSPACE_END>>>',
  ].join('\n')
  const estimatedInputTokens = defaultTokenCodec.count(content)
  if (estimatedInputTokens > safeInputBudget) throw new Error(`INPUT_CONTEXT_BUDGET_EXCEEDED: 测试设计工作区清单需要 ${estimatedInputTokens} Token，超过安全输入预算 ${safeInputBudget}`)
  return {
    policyVersion: 'test-design-workspace/v1',
    mode: 'agent_directory',
    estimatedInputTokens,
    safeInputBudget,
    packageSha256: sha256(content),
    batches: [{
      batchId: 'test_design_workspace_manifest',
      ordinal: 0,
      tokenCount: estimatedInputTokens,
      assetVersionIds: input.workspace.files.flatMap(file => file.assetVersionId ? [file.assetVersionId] : []),
      chunkIds: [],
      content,
    }],
  }
}

function coreTestDesignFactPaths(workspace: TestDesignWorkspaceSnapshot) {
  const releaseRoot = `${workspace.activeBranchLogicalPath}/requirements/`
  const roles = new Map([
    [`${releaseRoot}requirements.json`, 'requirement_release'],
    [`${releaseRoot}clarifications.json`, 'formal_clarifications'],
    [`${releaseRoot}test-focus.json`, 'test_focus'],
    [`${workspace.agentLogicalPath}/historical-test-cases.json`, 'historical_cases'],
  ])
  return workspace.files.flatMap(file => {
    const role = roles.get(file.logicalPath)
    return role
      ? [{ role, logicalPath: file.logicalPath.replace(/^workspace\//u, ''), contentSha256: file.contentSha256 }]
      : []
  })
}

export function buildTestExecutionDirectoryInputPlan(input: {
  snapshot: TestExecutionAgentSnapshot
  definition: AgentDefinitionVersion
  contextWindow: number
  maxOutputTokens: number
}): RequirementInputPlan {
  const safeInputBudget = safeBudget(input)
  const workspace = input.snapshot.documentWorkspace
  const content = [
    '<<<SMARTHUB_PI_TEST_EXECUTION_WORKSPACE_BEGIN>>>',
    JSON.stringify({
      mode: 'agent_directory',
      cwd: '/',
      rootLogicalPath: workspace.rootLogicalPath,
      activeBranchPath: workspace.activeBranchLogicalPath,
      agentWorkspacePath: workspace.agentLogicalPath,
      fileCount: input.snapshot.workspaceFiles.length,
      workspaceSnapshotSha256: sha256(JSON.stringify(input.snapshot.workspaceFiles.map(file => ({
        logicalPath: file.logicalPath,
        contentSha256: file.contentSha256,
      })))),
      taskSha256: input.snapshot.taskSha256,
      instructions: '只使用 ls/find/grep/read 读取服务端冻结的当前执行工作区。不得调用 Shell、write、edit、网络、数据库、其他 Agent 或 Runner。',
    }),
    '<<<SMARTHUB_PI_TEST_EXECUTION_WORKSPACE_END>>>',
  ].join('\n')
  const estimatedInputTokens = defaultTokenCodec.count(content)
  if (estimatedInputTokens > safeInputBudget) throw new Error(`INPUT_CONTEXT_BUDGET_EXCEEDED: 测试执行工作区清单需要 ${estimatedInputTokens} Token，超过安全输入预算 ${safeInputBudget}`)
  return {
    policyVersion: 'test-execution-workspace/v1',
    mode: 'agent_directory',
    estimatedInputTokens,
    safeInputBudget,
    packageSha256: sha256(content),
    batches: [{
      batchId: 'test_execution_workspace_manifest',
      ordinal: 0,
      tokenCount: estimatedInputTokens,
      assetVersionIds: [],
      chunkIds: [],
      content,
    }],
  }
}

function safeBudget(input: { definition: AgentDefinitionVersion; contextWindow: number; maxOutputTokens: number }) {
  const reservedOutput = Math.min(input.maxOutputTokens, input.definition.limits.reservedOutputTokens ?? input.maxOutputTokens)
  const correctionReserve = input.definition.limits.correctionReserveTokens ?? 2_048
  const promptTokens = defaultTokenCodec.count(`${input.definition.systemPrompt}\n${input.definition.taskTemplate}`)
  const value = input.contextWindow - reservedOutput - correctionReserve - promptTokens - TOOL_SCHEMA_RESERVE_TOKENS - SAFETY_MARGIN_TOKENS
  if (value < 1_024) throw new Error(`INPUT_CONTEXT_BUDGET_EXCEEDED: 模型安全输入预算不足（context=${input.contextWindow}，可用=${Math.max(0, value)}）`)
  return value
}

function sha256(value: string) { return createHash('sha256').update(value).digest('hex') }
