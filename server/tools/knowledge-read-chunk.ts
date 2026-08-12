import type { StateStore } from '../infrastructure/store.js'
import type { ToolRegistry } from './registry.js'
import { defaultBuiltInToolConfigResolver } from './built-in-tool-config.js'

export function registerKnowledgeReadChunkTool(registry: ToolRegistry, store: StateStore) {
  registry.register(defaultBuiltInToolConfigResolver.toDescriptor('knowledge.read_chunk'), async request => {
    const args = request.arguments as { chunkId: string }
    const state = await store.snapshot()
    const index = required(state.indexes.find(item => item.id === request.context.snapshot.indexVersionId), '固定索引不存在')
    const allowedVersions = new Set(request.context.snapshot.assets.map(item => item.assetVersionId))
    const chunk = required(index.indexedChunks?.find(item => item.id === args.chunkId && allowedVersions.has(item.assetVersionId)), 'Chunk 不属于本次固定输入')
    const source = request.context.snapshot.assets.find(item => item.assetVersionId === chunk.assetVersionId)
    const currentRequirementPath = 'documentWorkspace' in request.context.snapshot ? request.context.snapshot.documentWorkspace?.logicalPath : undefined
    const sourceScope = source?.logicalPath && currentRequirementPath && source.logicalPath.startsWith(`${currentRequirementPath}/`) ? 'current_requirement' : 'knowledge_reference'
    return { data: { chunkId: chunk.id, assetVersionId: chunk.assetVersionId, logicalPath: source?.logicalPath, sourceScope, contentHash: chunk.contentHash, headingPath: chunk.headingPath, startLine: chunk.startLine, endLine: chunk.endLine, startChar: chunk.startChar, endChar: chunk.endChar, content: chunk.content } }
  })
}

function required<T>(value: T | undefined, message: string): T { if (value === undefined) throw new Error(message); return value }
