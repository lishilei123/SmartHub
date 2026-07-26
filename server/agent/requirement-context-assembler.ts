import { createHash } from 'node:crypto'
import { defaultTokenCodec } from '../application/content.js'
import type { AgentDefinitionVersion, RequirementInputBatch, RequirementInputPlan, ReviewRunSnapshot } from '../domain/agent-types.js'
import type { Asset, AssetVersion, Chunk } from '../domain/types.js'

const INPUT_POLICY_VERSION = '1.0.0'
const TOOL_SCHEMA_RESERVE_TOKENS = 2_000
const SAFETY_MARGIN_TOKENS = 1_024
const SEGMENT_DOCUMENT_SHARE = 0.75

export interface RequirementContextAsset {
  asset: Pick<Asset, 'id' | 'displayName' | 'logicalPath'>
  version: Pick<AssetVersion, 'id' | 'content' | 'contentHash' | 'chunks'>
}

export function buildRequirementInputPlan(input: {
  assets: RequirementContextAsset[]
  coveragePlan: ReviewRunSnapshot['extractionCoveragePlan']
  definition: AgentDefinitionVersion
  contextWindow: number
  maxOutputTokens: number
}): RequirementInputPlan {
  const reservedOutput = Math.min(input.maxOutputTokens, input.definition.limits.reservedOutputTokens ?? input.maxOutputTokens)
  const correctionReserve = input.definition.limits.correctionReserveTokens ?? 2_048
  const promptTokens = defaultTokenCodec.count(`${input.definition.systemPrompt}\n${input.definition.taskTemplate}`)
  const safeInputBudget = input.contextWindow - reservedOutput - correctionReserve - promptTokens - TOOL_SCHEMA_RESERVE_TOKENS - SAFETY_MARGIN_TOKENS
  if (safeInputBudget < 1_024) throw new Error(`INPUT_CONTEXT_BUDGET_EXCEEDED: 模型安全输入预算不足（context=${input.contextWindow}，可用=${Math.max(0, safeInputBudget)}）`)

  const scope = scopedChunks(input.assets, input.coveragePlan)
  if (!scope.some(item => item.chunks.length)) throw new Error('INPUT_DELIVERY_INCOMPLETE: 本次范围没有可投递的需求正文 Chunk')
  const hasExclusions = input.coveragePlan.some(asset => asset.chunks.some(chunk => chunk.excludedReason))
  const fullPackage = hasExclusions ? renderScopedPackage(scope) : renderFullPackage(scope)
  const estimatedInputTokens = defaultTokenCodec.count(fullPackage)
  const packageSha256 = sha256(fullPackage)
  if (estimatedInputTokens <= safeInputBudget) return {
    policyVersion: INPUT_POLICY_VERSION,
    mode: 'full_context',
    estimatedInputTokens,
    safeInputBudget,
    packageSha256,
    batches: [batch('input_batch_1', 0, fullPackage, scope.flatMap(item => item.chunks), scope.map(item => item.version.id))],
  }

  const batchBudget = Math.max(1_024, Math.floor(safeInputBudget * SEGMENT_DOCUMENT_SHARE))
  const blocks = scope.flatMap(item => item.chunks.map(chunk => ({
    assetVersionId: item.version.id,
    chunk,
    content: renderChunkBlock(item, chunk),
  })))
  const batches: RequirementInputBatch[] = []
  let current: typeof blocks = []
  let currentTokens = 0
  const flush = () => {
    if (!current.length) return
    const content = renderSegmentPackage(current, batches.length, -1)
    batches.push(batch(`input_batch_${batches.length + 1}`, batches.length, content, current.map(item => item.chunk), [...new Set(current.map(item => item.assetVersionId))]))
    current = []
    currentTokens = 0
  }
  for (const block of blocks) {
    const blockTokens = defaultTokenCodec.count(block.content)
    if (blockTokens > batchBudget) throw new Error(`INPUT_CONTEXT_BUDGET_EXCEEDED: Chunk ${block.chunk.id} 需要 ${blockTokens} Token，超过单批安全预算 ${batchBudget}；请缩小 Chunk 或拆分需求文档`)
    if (current.length && currentTokens + blockTokens > batchBudget) flush()
    current.push(block)
    currentTokens += blockTokens
  }
  flush()
  batches.forEach((value, index) => {
    value.content = value.content.replace('batchCount=-1', `batchCount=${batches.length}`)
    value.tokenCount = defaultTokenCodec.count(value.content)
  })
  if (batches.length > 24) throw new Error(`INPUT_CONTEXT_BUDGET_EXCEEDED: 超长正文需要 ${batches.length} 个批次，超过上限 24；请拆分项目版本输入`)
  return { policyVersion: INPUT_POLICY_VERSION, mode: 'segmented_context', estimatedInputTokens, safeInputBudget, packageSha256, batches }
}

function scopedChunks(assets: RequirementContextAsset[], plan: ReviewRunSnapshot['extractionCoveragePlan']) {
  const planByAsset = new Map(plan.map(item => [item.assetVersionId, item]))
  return assets.map(item => {
    const allowed = new Set((planByAsset.get(item.version.id)?.chunks ?? []).filter(chunk => !chunk.excludedReason).map(chunk => chunk.chunkId))
    return { ...item, chunks: item.version.chunks.filter(chunk => allowed.has(chunk.id)).sort((left, right) => left.ordinal - right.ordinal) }
  })
}

function renderFullPackage(scope: ReturnType<typeof scopedChunks>) {
  return scope.map(item => {
    const boundary = boundaryFor(item.version.content, item.version.contentHash)
    const directory = item.chunks.map(chunkMetadata)
    return [
      `<<<SMARTHUB_FIXED_REQUIREMENT_DOCUMENT_BEGIN ${boundary}>>>`,
      JSON.stringify({ assetId: item.asset.id, assetVersionId: item.version.id, contentHash: item.version.contentHash, displayName: item.asset.displayName, logicalPath: item.asset.logicalPath, chunks: directory }),
      `<<<SMARTHUB_DOCUMENT_BODY_BEGIN ${boundary}>>>`,
      item.version.content,
      `<<<SMARTHUB_DOCUMENT_BODY_END ${boundary}>>>`,
      `<<<SMARTHUB_FIXED_REQUIREMENT_DOCUMENT_END ${boundary}>>>`,
    ].join('\n')
  }).join('\n\n')
}

function renderScopedPackage(scope: ReturnType<typeof scopedChunks>) {
  return [
    '<<<SMARTHUB_FIXED_REQUIREMENT_SCOPE_BEGIN>>>',
    ...scope.flatMap(item => item.chunks.map(chunk => renderChunkBlock(item, chunk))),
    '<<<SMARTHUB_FIXED_REQUIREMENT_SCOPE_END>>>',
  ].join('\n\n')
}

function renderChunkBlock(item: ReturnType<typeof scopedChunks>[number], chunk: Chunk) {
  const boundary = boundaryFor(chunk.content, chunk.contentHash)
  return [
    `<<<SMARTHUB_FIXED_REQUIREMENT_CHUNK_BEGIN ${boundary}>>>`,
    JSON.stringify({ assetId: item.asset.id, assetVersionId: item.version.id, assetContentHash: item.version.contentHash, displayName: item.asset.displayName, logicalPath: item.asset.logicalPath, ...chunkMetadata(chunk) }),
    chunk.content,
    `<<<SMARTHUB_FIXED_REQUIREMENT_CHUNK_END ${boundary}>>>`,
  ].join('\n')
}

function renderSegmentPackage(blocks: Array<{ content: string }>, batchIndex: number, batchCount: number) {
  return [`<<<SMARTHUB_SEGMENTED_INPUT batch=${batchIndex + 1} batchCount=${batchCount}>>>`, ...blocks.map(item => item.content)].join('\n\n')
}

function chunkMetadata(chunk: Chunk) {
  return { chunkId: chunk.id, contentHash: chunk.contentHash, headingPath: chunk.headingPath, startLine: chunk.startLine, endLine: chunk.endLine, startChar: chunk.startChar, endChar: chunk.endChar }
}

function batch(batchId: string, ordinal: number, content: string, chunks: Chunk[], assetVersionIds: string[]): RequirementInputBatch {
  return { batchId, ordinal, tokenCount: defaultTokenCodec.count(content), assetVersionIds, chunkIds: chunks.map(chunk => chunk.id), content }
}

function boundaryFor(content: string, hash: string) {
  let boundary = `SMARTHUB_${hash.slice(0, 16)}`
  let suffix = 0
  while (content.includes(boundary)) boundary = `SMARTHUB_${hash.slice(0, 16)}_${++suffix}`
  return boundary
}

function sha256(value: string) { return createHash('sha256').update(value).digest('hex') }
