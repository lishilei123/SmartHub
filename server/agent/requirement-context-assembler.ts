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
      clarificationInstruction: '已回答或已处置的 Clarification 是带来源的正式业务输入；必须采用其明确事实，不得重复提问。pending blocking Clarification 仍须等待人工，不得猜测。',
      instructions: 'currentInputRefs 是本次重点，不是读取白名单。优先读取重点输入，再从工作区根目录使用 ls 查看 branches/shared/formal-output，使用 find 和 grep 定位其他相关资料，并用 read 阅读正文。不要假设未读取内容，不得越过工作目录。',
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
      instructions: 'Requirement Release 是当前正式需求基线，currentInputRefs 是本次上传资料重点；两者都不是 Workspace 读取白名单。先读取重点输入，再从工作区根目录使用 ls/find/grep 自主探索 branches/shared/formal-output，并用 read 读取事实资料。不得调用 Shell、write、edit 或越过工作区。',
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
