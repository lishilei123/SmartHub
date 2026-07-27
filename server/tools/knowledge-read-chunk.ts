import { Type } from 'typebox'
import type { StateStore } from '../infrastructure/store.js'
import type { ToolRegistry } from './registry.js'

export function registerKnowledgeReadChunkTool(registry: ToolRegistry, store: StateStore) {
  registry.register({
    id: 'knowledge.read_chunk', piName: 'knowledge_read_chunk', version: '1.0.0', label: '读取固定 Chunk', risk: 'read', idempotent: true, repeatPolicy: 'replay_success_once', timeoutMs: 30_000,
    description: '仅在需要复核引用时按 Chunk ID 读取本次固定输入中的完整内容与定位。',
    parameters: Type.Object({ chunkId: Type.String({ minLength: 1, maxLength: 200 }) }),
  }, async request => {
    const args = request.arguments as { chunkId: string }
    const state = await store.snapshot()
    const index = required(state.indexes.find(item => item.id === request.context.snapshot.indexVersionId), '固定索引不存在')
    const allowedVersions = new Set(request.context.snapshot.assets.map(item => item.assetVersionId))
    const chunk = required(index.indexedChunks?.find(item => item.id === args.chunkId && allowedVersions.has(item.assetVersionId)), 'Chunk 不属于本次固定输入')
    return { data: { chunkId: chunk.id, assetVersionId: chunk.assetVersionId, contentHash: chunk.contentHash, headingPath: chunk.headingPath, startLine: chunk.startLine, endLine: chunk.endLine, startChar: chunk.startChar, endChar: chunk.endChar, content: chunk.content } }
  })
}

function required<T>(value: T | undefined, message: string): T { if (value === undefined) throw new Error(message); return value }
