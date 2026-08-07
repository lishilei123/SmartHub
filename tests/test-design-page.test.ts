import assert from 'node:assert/strict'
import test from 'node:test'
import { getTestDesignCreateBlockers, resolveTestDesignRoute } from '../src/test-design-state.ts'

test('测试设计路由只恢复固定 testDesignId 和 workflowRunId 组合', () => {
  assert.equal(resolveTestDesignRoute(new URL('http://127.0.0.1/?page=test-design')).view, 'list')
  assert.equal(resolveTestDesignRoute(new URL('http://127.0.0.1/?page=test-design&testDesignId=td-auth-20260807')).view, 'route-error')
  assert.equal(resolveTestDesignRoute(new URL('http://127.0.0.1/?page=test-design&testDesignId=invalid&workflowRunId=invalid')).view, 'route-error')

  const restored = resolveTestDesignRoute(new URL('http://127.0.0.1/?page=test-design&testDesignId=td-auth-20260807&workflowRunId=wf-20260807-03&tab=cases&assetView=sets'))
  assert.deepEqual(restored, { view: 'workspace', tab: 'cases', collectionView: 'sets' })
})

test('测试设计路由拒绝非法标签并回到概览', () => {
  const restored = resolveTestDesignRoute(new URL('http://127.0.0.1/?testDesignId=td-auth-20260807&workflowRunId=wf-20260807-03&tab=latest'))
  assert.equal(restored.view, 'workspace')
  assert.equal(restored.tab, 'overview')
})

test('知识资料模式缺少目标或固定资产时阻止创建', () => {
  const empty = getTestDesignCreateBlockers({ basisMode: 'knowledge_assets', knowledgeGoal: '', selectedAssets: [], augmentation: 'disabled', augmentationAssets: [] })
  assert.deepEqual(empty.blockers, ['填写测试目标', '至少选择一份 ready 固定资产版本'])

  const valid = getTestDesignCreateBlockers({ basisMode: 'knowledge_assets', knowledgeGoal: '验证身份认证', selectedAssets: ['ASSET-001'], augmentation: 'disabled', augmentationAssets: [] })
  assert.deepEqual(valid.blockers, [])
})

test('指定资料召回必须显式选择固定资料', () => {
  const blocked = getTestDesignCreateBlockers({ basisMode: 'review_baseline', knowledgeGoal: '', selectedAssets: [], augmentation: 'selected_assets', augmentationAssets: [] })
  assert.deepEqual(blocked.blockers, ['为指定资料召回选择至少一份固定资产'])

  const valid = getTestDesignCreateBlockers({ basisMode: 'review_baseline', knowledgeGoal: '', selectedAssets: [], augmentation: 'selected_assets', augmentationAssets: ['ASSET-003'] })
  assert.deepEqual(valid.blockers, [])
})
