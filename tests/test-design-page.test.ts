import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { resolveTestDesignRoute } from '../src/test-design-state.ts'

test('测试设计页面默认展示空列表并保留合法资产视图', () => {
  assert.equal(resolveTestDesignRoute(new URL('http://127.0.0.1/?page=test-design')).view, 'list')
  assert.equal(resolveTestDesignRoute(new URL('http://127.0.0.1/?page=test-design')).collectionView, 'designs')
  assert.equal(resolveTestDesignRoute(new URL('http://127.0.0.1/?page=test-design&assetView=sets')).collectionView, 'sets')
  assert.equal(resolveTestDesignRoute(new URL('http://127.0.0.1/?page=test-design&create=1')).view, 'create')
})

test('测试设计页面可以恢复固定的真实运行上下文', () => {
  const route = resolveTestDesignRoute(new URL('http://127.0.0.1/?page=test-design&testDesignId=td-1&workflowRunId=run-1&tab=workflow'))
  assert.equal(route.view, 'workspace')
  assert.equal(route.testDesignId, 'td-1')
  assert.equal(route.workflowRunId, 'run-1')
  assert.equal(route.tab, 'workflow')
  assert.equal(resolveTestDesignRoute(new URL('http://127.0.0.1/?page=test-design&testDesignId=unknown')).view, 'route-error')
  assert.equal(resolveTestDesignRoute(new URL('http://127.0.0.1/?page=test-design&workflowRunId=unknown')).view, 'route-error')
})

test('测试设计页面拒绝非法资产视图', () => {
  assert.equal(resolveTestDesignRoute(new URL('http://127.0.0.1/?page=test-design&assetView=latest')).collectionView, 'designs')
})

test('测试设计工作台保留真实运行入口和错误态展示结构', () => {
  const source = readFileSync(new URL('../src/TestDesignPage.tsx', import.meta.url), 'utf8')
  assert.match(source, /loadTestDesignRun/)
  assert.match(source, /运行失败/)
  assert.match(source, /查看原因/)
  assert.match(source, /function RunWorkflowView/)
  assert.match(source, /td-real-workflow-canvas/)
  assert.match(source, /FixedInputCard/)
  assert.match(source, /functional_design.*non_functional_design/s)
  assert.match(source, /nodeExecutionSummary/)
  assert.match(source, /确认测试范围/)
  assert.match(source, /applyTestDesignGateDecision/)
  assert.match(source, /GateDecisionPanel/)
})

test('范围确认门禁展示可审阅的结构化范围而不是对象字符串', () => {
  const source = readFileSync(new URL('../src/TestDesignPage.tsx', import.meta.url), 'utf8')
  assert.match(source, /本次测试范围明细/)
  assert.match(source, /纳入的需求点/)
  assert.match(source, /纳入的技术方案要点/)
  assert.match(source, /明确排除范围/)
  assert.match(source, /范围待确认项/)
  assert.match(source, /历史用例处置/)
  assert.match(source, /readableText\(scopeContent\.scope\)/)
  assert.doesNotMatch(source, /String\(scopeContent\.scope/)
})

test('创建页不再展示或提交硬编码候选数据', () => {
  const source = readFileSync(new URL('../src/TestDesignPage.tsx', import.meta.url), 'utf8')
  assert.match(source, /inputs\.reviewBaselines/)
  assert.match(source, /inputs\.knowledgeAssets/)
  assert.match(source, /创建并提交真实运行/)
  assert.doesNotMatch(source, /RR-20260801-021|TR-20260805-014|ASSET-001|创建预览运行/)
})

test('每次新建测试设计都会清空上一轮创建草稿并返回第一步', () => {
  const source = readFileSync(new URL('../src/TestDesignPage.tsx', import.meta.url), 'utf8')
  const resetCreateDraft = source.match(/const resetCreateDraft = \(\) => \{[\s\S]*?\n  \}/)?.[0] ?? ''

  assert.match(resetCreateDraft, /setCreateStep\(1\)/)
  assert.match(resetCreateDraft, /setDesignName\(''\)/)
  assert.match(resetCreateDraft, /setKnowledgeGoal\(''\)/)
  assert.match(resetCreateDraft, /setBasisMode\('review_baseline'\)/)
  assert.match(resetCreateDraft, /setSelectedAssets\(\[\]\)/)
  assert.match(resetCreateDraft, /setAugmentation\('disabled'\)/)
  assert.match(resetCreateDraft, /setAugmentationAssets\(\[\]\)/)
  assert.match(resetCreateDraft, /setHistoryEnabled\(false\)/)
  assert.match(source, /const openCreate = \(\) => \{\s*resetCreateDraft\(\)/)
  assert.match(source, /const closeCreate = \(\) => \{\s*resetCreateDraft\(\)/)
  assert.match(source, /onCreate=\{openCreate\}/)
  assert.match(source, /onCancel=\{closeCreate\}/)
})

test('评审基线单选框不继承普通输入框的满宽尺寸', () => {
  const source = readFileSync(new URL('../src/test-design.css', import.meta.url), 'utf8')
  assert.match(source, /label>input:not\(\[type=checkbox\]\):not\(\[type=radio\]\)/)
  assert.doesNotMatch(source, /label>input:not\(\[type=checkbox\]\)(?!:not\(\[type=radio\]\))/)
})
