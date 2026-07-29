import { createHash } from 'node:crypto'
import { defaultTokenCodec } from '../application/content.js'
import type { AgentDefinitionVersion, RequirementInputBatch, RequirementInputPlan } from '../domain/agent-types.js'
import type { Asset, AssetVersion } from '../domain/types.js'

export function buildTechnicalSolutionInputPlan(input: {
  assets: Array<{ asset: Pick<Asset, 'id' | 'displayName' | 'logicalPath'>; version: Pick<AssetVersion, 'id' | 'content' | 'contentHash' | 'chunks'> }>
  definition: AgentDefinitionVersion
  contextWindow: number
  maxOutputTokens: number
}): RequirementInputPlan {
  const reservedOutput = Math.min(input.maxOutputTokens, input.definition.limits.reservedOutputTokens ?? input.maxOutputTokens)
  const safeInputBudget = input.contextWindow - reservedOutput - (input.definition.limits.correctionReserveTokens ?? 2_048) - defaultTokenCodec.count(`${input.definition.systemPrompt}\n${input.definition.taskTemplate}`) - 3_024
  if (safeInputBudget < 1_024) throw new Error('TECH_INPUT_CONTEXT_BUDGET_EXCEEDED: 模型安全输入预算不足')
  const ordered = input.assets.map(item => ({ ...item, chunks: [...item.version.chunks].sort((left, right) => left.ordinal - right.ordinal) }))
  if (ordered.some(item => !item.version.content.trim() || !item.chunks.length)) throw new Error('TECH_INPUT_DELIVERY_INCOMPLETE: 技术方案固定正文或 Chunk 不完整')
  const full = ordered.map(item => renderDocument(item)).join('\n\n')
  const estimatedInputTokens = defaultTokenCodec.count(full)
  const packageSha256 = sha256(full)
  if (estimatedInputTokens <= safeInputBudget) return {
    policyVersion: 'technical-solution-input/v1', mode: 'full_context', estimatedInputTokens, safeInputBudget, packageSha256,
    batches: [makeBatch('technical_input_1', 0, full, ordered.flatMap(item => item.chunks.map(chunk => chunk.id)), ordered.map(item => item.version.id))],
  }
  const batchBudget = Math.max(1_024, Math.floor(safeInputBudget * 0.7))
  const blocks = ordered.flatMap(item => item.chunks.map(chunk => ({ assetVersionId: item.version.id, chunkId: chunk.id, content: renderChunk(item, chunk) })))
  const batches: RequirementInputBatch[] = []
  let current: typeof blocks = []
  let tokens = 0
  const flush = () => {
    if (!current.length) return
    const content = current.map(item => item.content).join('\n\n')
    batches.push(makeBatch(`technical_input_${batches.length + 1}`, batches.length, content, current.map(item => item.chunkId), [...new Set(current.map(item => item.assetVersionId))]))
    current = []
    tokens = 0
  }
  for (const block of blocks) {
    const blockTokens = defaultTokenCodec.count(block.content)
    if (blockTokens > batchBudget) throw new Error(`TECH_INPUT_CONTEXT_BUDGET_EXCEEDED: Chunk ${block.chunkId} 超过单批安全预算`)
    if (current.length && tokens + blockTokens > batchBudget) flush()
    current.push(block)
    tokens += blockTokens
  }
  flush()
  if (batches.length > 24) throw new Error('TECH_INPUT_CONTEXT_BUDGET_EXCEEDED: 技术方案分段数量超过 24')
  return { policyVersion: 'technical-solution-input/v1', mode: 'segmented_context', estimatedInputTokens, safeInputBudget, packageSha256, batches }
}

function renderDocument(item: Parameters<typeof buildTechnicalSolutionInputPlan>[0]['assets'][number]) {
  const boundary = `SMARTHUB_TECH_${item.version.contentHash.slice(0, 16)}`
  return [`<<<FIXED_TECHNICAL_DESIGN_BEGIN ${boundary}>>>`, JSON.stringify({ assetId: item.asset.id, assetVersionId: item.version.id, contentSha256: item.version.contentHash, displayName: item.asset.displayName, logicalPath: item.asset.logicalPath }), item.version.content, `<<<FIXED_TECHNICAL_DESIGN_END ${boundary}>>>`].join('\n')
}

function renderChunk(item: Parameters<typeof buildTechnicalSolutionInputPlan>[0]['assets'][number], chunk: AssetVersion['chunks'][number]) {
  return [`<<<FIXED_TECHNICAL_DESIGN_CHUNK_BEGIN>>>`, JSON.stringify({ assetId: item.asset.id, assetVersionId: item.version.id, assetContentSha256: item.version.contentHash, displayName: item.asset.displayName, logicalPath: item.asset.logicalPath, chunkId: chunk.id, contentSha256: chunk.contentHash, headingPath: chunk.headingPath, startLine: chunk.startLine, endLine: chunk.endLine }), chunk.content, `<<<FIXED_TECHNICAL_DESIGN_CHUNK_END>>>`].join('\n')
}

function makeBatch(batchId: string, ordinal: number, content: string, chunkIds: string[], assetVersionIds: string[]): RequirementInputBatch {
  return { batchId, ordinal, tokenCount: defaultTokenCodec.count(content), assetVersionIds, chunkIds, content }
}

function sha256(value: string) { return createHash('sha256').update(value).digest('hex') }
