import type { FrozenExecutionKnowledgeSnapshot } from '../domain/test-execution-types.js'
import type { StateStore } from '../infrastructure/store.js'

/** Resolves one immutable Knowledge index for a newly created Execution Run. */
export class StateStoreTestExecutionKnowledgeResolver {
  constructor(private readonly store: StateStore) {}

  async resolveSnapshot(projectId: string): Promise<FrozenExecutionKnowledgeSnapshot | undefined> {
    const state = await this.store.snapshot()
    const candidates = state.knowledgeBases.filter(knowledgeBase =>
      knowledgeBase.projectId === projectId
      && knowledgeBase.activeIndexVersionId)
    if (!candidates.length) return undefined
    if (candidates.length > 1) {
      throw new Error('TEST_EXECUTION_KNOWLEDGE_BASE_AMBIGUOUS')
    }
    const knowledgeBase = candidates[0]
    const index = state.indexes.find(candidate =>
      candidate.id === knowledgeBase.activeIndexVersionId
      && candidate.knowledgeBaseId === knowledgeBase.id)
    if (!index || index.status !== 'active') {
      throw new Error('TEST_EXECUTION_KNOWLEDGE_INDEX_INVALID')
    }
    return {
      knowledgeBaseId: knowledgeBase.id,
      indexVersionId: index.id,
      indexVersion: index.number,
      indexCreatedAt: index.createdAt,
    }
  }
}
