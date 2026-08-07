export type TestDesignBasisMode = 'review_baseline' | 'knowledge_assets'
export type TestDesignViewMode = 'list' | 'create' | 'workspace' | 'route-error'
export type TestDesignCollectionView = 'designs' | 'library' | 'sets'
export type TestDesignTabKey = 'overview' | 'workflow' | 'analysis' | 'retrieval' | 'tree' | 'cases' | 'case-set' | 'data' | 'coverage' | 'history' | 'questions'

export const PREVIEW_TEST_DESIGN_ID = 'td-auth-20260807'
export const PREVIEW_WORKFLOW_RUN_ID = 'wf-20260807-03'

const tabKeys: TestDesignTabKey[] = ['overview', 'workflow', 'analysis', 'retrieval', 'tree', 'cases', 'case-set', 'data', 'coverage', 'history', 'questions']
const collectionViews: TestDesignCollectionView[] = ['designs', 'library', 'sets']

export function resolveTestDesignRoute(url: URL | null) {
  if (!url) return { view: 'list' as TestDesignViewMode, tab: 'overview' as TestDesignTabKey, collectionView: 'designs' as TestDesignCollectionView }
  const testDesignId = url.searchParams.get('testDesignId')
  const workflowRunId = url.searchParams.get('workflowRunId')
  const routedTab = url.searchParams.get('tab')
  const routedAssetView = url.searchParams.get('assetView')
  const tab = tabKeys.includes(routedTab as TestDesignTabKey) ? routedTab as TestDesignTabKey : 'overview'
  const collectionView = collectionViews.includes(routedAssetView as TestDesignCollectionView) ? routedAssetView as TestDesignCollectionView : 'designs'
  if (!testDesignId && !workflowRunId) return { view: 'list' as TestDesignViewMode, tab, collectionView }
  if (testDesignId === PREVIEW_TEST_DESIGN_ID && workflowRunId === PREVIEW_WORKFLOW_RUN_ID) return { view: 'workspace' as TestDesignViewMode, tab, collectionView }
  return { view: 'route-error' as TestDesignViewMode, tab, collectionView }
}

export function getTestDesignCreateBlockers(input: { basisMode: TestDesignBasisMode; knowledgeGoal: string; selectedAssets: string[]; augmentation: string; augmentationAssets: string[] }) {
  const basisIssues = input.basisMode === 'knowledge_assets'
    ? [!input.knowledgeGoal.trim() ? '填写测试目标' : '', input.selectedAssets.length === 0 ? '至少选择一份 ready 固定资产版本' : ''].filter(Boolean)
    : []
  const augmentationIssues = input.augmentation === 'selected_assets' && input.augmentationAssets.length === 0 ? ['为指定资料召回选择至少一份固定资产'] : []
  return { basisIssues, augmentationIssues, blockers: [...basisIssues, ...augmentationIssues] }
}
