import { Type } from 'typebox'
import type { StateStore } from '../infrastructure/store.js'
import type { ToolRegistry } from './registry.js'

export function registerKnowledgeSearchTool(registry: ToolRegistry, store: StateStore) {
  registry.register({
    id: 'knowledge.search', piName: 'knowledge_search', version: '1.0.0', label: '固定索引检索', risk: 'read', idempotent: true, timeoutMs: 30_000,
    description: '仅在本次运行固定的知识索引版本内检索相关 Chunk；正文已直接投递时只用于定向复查。',
    parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 500 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
  }, async request => {
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
    return { data: { retrievalMode: 'fixed_index_keyword', degraded: true, degradedReason: '当前固定索引工具仅启用关键词召回', results: results.map(({ chunk, score }) => ({ chunkId: chunk.id, assetVersionId: chunk.assetVersionId, headingPath: chunk.headingPath, startLine: chunk.startLine, endLine: chunk.endLine, score, excerpt: chunk.content.slice(0, 1000) })) } }
  })
}

function required<T>(value: T | undefined, message: string): T { if (value === undefined) throw new Error(message); return value }
