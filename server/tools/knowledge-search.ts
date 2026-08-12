import type { StateStore } from '../infrastructure/store.js'
import type { ToolRegistry } from './registry.js'
import { defaultBuiltInToolConfigResolver } from './built-in-tool-config.js'

export function registerKnowledgeSearchTool(registry: ToolRegistry, store: StateStore) {
  registry.register(defaultBuiltInToolConfigResolver.toDescriptor('knowledge.search'), async request => {
    const args = request.arguments as { query: string; limit?: number }
    const state = await store.snapshot()
    const index = required(state.indexes.find(item => item.id === request.context.snapshot.indexVersionId && item.knowledgeBaseId === request.context.snapshot.knowledgeBaseId), '固定索引不存在')
    const allowedVersions = new Set(request.context.snapshot.assets.map(item => item.assetVersionId))
    const terms = [...new Set(args.query.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length > 1))]
    const results = (index.indexedChunks ?? []).filter(chunk => allowedVersions.has(chunk.assetVersionId)).map(chunk => {
      const haystack = `${chunk.headingPath.join(' ')} ${chunk.content}`.toLocaleLowerCase()
      const hits = terms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0)
      return { chunk, score: terms.length ? hits / terms.length : 0 }
    }).filter(item => item.score > 0).sort((left, right) => right.score - left.score || left.chunk.ordinal - right.chunk.ordinal).slice(0, args.limit ?? 8)
    return { data: { retrievalMode: 'fixed_index_keyword', degraded: true, degradedReason: '当前固定索引工具仅启用关键词召回', results: results.map(({ chunk, score }) => {
      const source = request.context.snapshot.assets.find(item => item.assetVersionId === chunk.assetVersionId)
      const currentRequirementPath = 'documentWorkspace' in request.context.snapshot ? request.context.snapshot.documentWorkspace?.logicalPath : undefined
      return { chunkId: chunk.id, assetVersionId: chunk.assetVersionId, logicalPath: source?.logicalPath, sourceScope: sourceScope(source?.logicalPath, currentRequirementPath), headingPath: chunk.headingPath, startLine: chunk.startLine, endLine: chunk.endLine, score, excerpt: chunk.content.slice(0, 1000) }
    }) } }
  })
}

function sourceScope(logicalPath: string | undefined, currentRequirementPath: string | undefined) {
  return logicalPath && currentRequirementPath && logicalPath.startsWith(`${currentRequirementPath}/`) ? 'current_requirement' : 'knowledge_reference'
}

function required<T>(value: T | undefined, message: string): T { if (value === undefined) throw new Error(message); return value }
