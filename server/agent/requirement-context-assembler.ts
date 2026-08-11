import { createHash } from 'node:crypto'
import { defaultTokenCodec } from '../application/content.js'
import type { AgentDefinitionVersion, RequirementInputPlan } from '../domain/agent-types.js'
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
  definition: AgentDefinitionVersion
  contextWindow: number
  maxOutputTokens: number
}): RequirementInputPlan {
  const safeInputBudget = safeBudget(input)
  const workspaceSnapshotSha256 = sha256(JSON.stringify(input.assets.map(({ asset, version }) => ({
    logicalPath: asset.logicalPath,
    assetVersionId: version.id,
    contentHash: version.contentHash,
  }))))
  const content = [
    '<<<SMARTHUB_PI_DOCUMENT_WORKSPACE_BEGIN>>>',
    JSON.stringify({
      mode: 'agent_directory',
      cwd: '/',
      rootLogicalPath: input.workspaceRootPath ?? input.workspacePath,
      activeBranchPath: input.activeBranchPath,
      requirementInputPath: input.workspacePath,
      agentWorkspacePath: input.agentWorkspacePath,
      fileCount: input.assets.length,
      workspaceSnapshotSha256,
      instructions: '像 Codex 一样从当前工作目录开始，使用 ls 查看目录、find 按文件名查找、grep 搜索文本位置，再用 read 按相对路径读取文件。不要假设文件内容，也不要越过工作目录。grep 只用于定位；需要分析或引用的正文必须通过 read 实际读取。',
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
      assetVersionIds: input.assets.map(item => item.version.id),
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
