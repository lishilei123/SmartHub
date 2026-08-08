export type TestDesignViewMode = 'list' | 'workspace' | 'route-error'
export type TestDesignCollectionView = 'designs' | 'library' | 'sets'
export type TestDesignBasisMode = 'review_baseline' | 'knowledge_assets'
export type TestDesignTabKey = 'overview' | 'workflow' | 'analysis' | 'retrieval' | 'tree' | 'cases' | 'case-set' | 'data' | 'coverage' | 'history' | 'questions'

const collectionViews: TestDesignCollectionView[] = ['designs', 'library', 'sets']
const tabKeys: TestDesignTabKey[] = ['overview', 'workflow', 'analysis', 'retrieval', 'tree', 'cases', 'case-set', 'data', 'coverage', 'history', 'questions']

export function resolveTestDesignRoute(url: URL | null) {
  if (!url) return { view: 'list' as TestDesignViewMode, collectionView: 'designs' as TestDesignCollectionView, tab: 'overview' as TestDesignTabKey, testDesignId: null, workflowRunId: null }

  const testDesignId = url.searchParams.get('testDesignId')
  const workflowRunId = url.searchParams.get('workflowRunId')
  const createRequested = url.searchParams.get('create') === '1'
  const routedTab = url.searchParams.get('tab')
  const routedAssetView = url.searchParams.get('assetView')
  const collectionView = collectionViews.includes(routedAssetView as TestDesignCollectionView)
    ? routedAssetView as TestDesignCollectionView
    : 'designs'
  const tab = tabKeys.includes(routedTab as TestDesignTabKey) ? routedTab as TestDesignTabKey : 'overview'
  const view = testDesignId && workflowRunId
    ? 'workspace'
    : testDesignId || workflowRunId
      ? 'route-error'
      : createRequested ? 'create' : 'list'

  return {
    view: view as TestDesignViewMode,
    collectionView,
    tab,
    testDesignId,
    workflowRunId,
  }
}

export function getTestDesignCreateBlockers(input: { basisMode: TestDesignBasisMode; knowledgeGoal: string; selectedAssets: string[]; augmentation: string; augmentationAssets: string[] }) {
  const basisIssues = input.basisMode === 'knowledge_assets'
    ? [!input.knowledgeGoal.trim() ? '填写测试目标' : '', input.selectedAssets.length === 0 ? '至少选择一份 ready 固定资产版本' : ''].filter(Boolean)
    : []
  const augmentationIssues = input.augmentation === 'selected_assets' && input.augmentationAssets.length === 0 ? ['为指定资料召回选择至少一份固定资产'] : []
  return { basisIssues, augmentationIssues, blockers: [...basisIssues, ...augmentationIssues] }
}
