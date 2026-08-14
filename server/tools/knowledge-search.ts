import type { KnowledgeService } from '../application/knowledge-service.js'
import type { ToolRegistry } from './registry.js'
import { defaultBuiltInToolConfigResolver } from './built-in-tool-config.js'

export function registerKnowledgeSearchTool(registry: ToolRegistry, knowledge: KnowledgeService) {
  registry.register(defaultBuiltInToolConfigResolver.toDescriptor('knowledge.search'), async (request, signal) => {
    const args = request.arguments as { query: string; limit?: number }
    const snapshot = request.context.snapshot
    const search = await knowledge.searchFixedIndex(snapshot.knowledgeBaseId, snapshot.indexVersionId, { query: args.query, mode: 'hybrid', limit: args.limit ?? 8, excerptLength: 1000, signal })
    const retrieval = 'retrieval' in search ? search.retrieval : undefined
    const currentRequirementPath = 'documentWorkspace' in snapshot ? snapshot.documentWorkspace?.logicalPath : undefined
    return { data: {
      status: search.status,
      indexVersionId: snapshot.indexVersionId,
      retrievalMode: retrieval?.mode ?? 'hybrid',
      requestedMode: retrieval?.requestedMode ?? 'hybrid',
      degraded: retrieval?.degraded ?? false,
      degradedReason: retrieval?.degradedReason,
      results: search.results.map(result => ({
        chunkId: result.chunk.id,
        assetVersionId: result.version.id,
        logicalPath: result.asset.logicalPath,
        sourceScope: sourceScope(result.asset.logicalPath, currentRequirementPath),
        headingPath: result.chunk.headingPath,
        startLine: result.chunk.startLine,
        endLine: result.chunk.endLine,
        score: result.score,
        scores: result.scores,
        excerpt: result.excerpt,
      })),
    } }
  })
}

function sourceScope(logicalPath: string | undefined, currentRequirementPath: string | undefined) {
  return logicalPath && currentRequirementPath && logicalPath.startsWith(`${currentRequirementPath}/`) ? 'current_requirement' : 'knowledge_reference'
}
