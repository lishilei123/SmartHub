import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { normalizeTestAnalysisGroups } from '../src/test-design-analysis.ts'
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

test('测试设计真实产物使用独立视图且仅缺失阶段显示占位态', () => {
  const source = readFileSync(new URL('../src/TestDesignPage.tsx', import.meta.url), 'utf8')
  assert.match(source, /<RunArtifactView tab=\{tab\} run=\{activeRun\}/)
  for (const view of ['RunAnalysisArtifact', 'RunRetrievalArtifact', 'RunTreeArtifact', 'RunCasesArtifact', 'RunCaseSetArtifact', 'RunDataArtifact', 'RunCoverageArtifact', 'RunHistoryArtifact', 'RunQuestionsArtifact']) {
    assert.match(source, new RegExp(`function ${view}\\b`))
  }
  assert.doesNotMatch(source, /!\['overview', 'workflow'\]\.includes\(tab\) && <RunArtifactState/)
  assert.match(source, /currentTreeNodes\(run\)\.length/)
  assert.match(source, /dataRequirementCount\(run\)/)
})

test('测试设计列表与创建候选解耦且运行加载期间不展示示例数据', () => {
  const source = readFileSync(new URL('../src/TestDesignPage.tsx', import.meta.url), 'utf8')
  const listEffect = source.match(/useEffect\(\(\) => \{\s*if \(!projectVersion\) return[\s\S]*?\}, \[notify, projectVersion\?\.id\]\)/)?.[0] ?? ''
  assert.match(listEffect, /loadTestDesigns\(projectVersion\.id\)/)
  assert.doesNotMatch(listEffect, /loadTestDesignInputs/)
  assert.match(source, /view !== 'create' \|\| designInputs/)
  assert.match(source, /if \(!activeRun\) \{\s*return <section className="td-workbench-loading"/)
  assert.doesNotMatch(source, /activeRun \? runTabCount\(item\.key, activeRun\) : item\.count/)
  assert.doesNotMatch(source, /activeRun \? <RunBasisPanel run=\{activeRun\} \/> : <BasisPanel/)
})

test('非概览产物页不再展示工作流运行侧栏', () => {
  const source = readFileSync(new URL('../src/TestDesignPage.tsx', import.meta.url), 'utf8')

  assert.match(source, /const hasDetailPanel = tab === 'overview' \|\| \(tab === 'cases' && selectedRunCaseId !== null\)/)
  assert.match(source, /const detailPanelOpen = hasDetailPanel && rightOpen/)
  assert.match(source, /detailPanelOpen && tab === 'overview' && <RunDetailPanel/)
  assert.match(source, /detailPanelOpen && tab === 'cases' && selectedRunCaseId/)
  assert.doesNotMatch(source, /rightOpen && activeRun && <RunDetailPanel/)
})

test('测试设计列表使用真实运行状态进行受控筛选', () => {
  const source = readFileSync(new URL('../src/TestDesignPage.tsx', import.meta.url), 'utf8')
  const designList = source.match(/function DesignList\b[\s\S]*?\n\}\n\nfunction AssetViewSelect/)?.[0] ?? ''

  assert.match(designList, /const \[query, setQuery\] = useState\(''\)/)
  assert.match(designList, /const \[statusFilter, setStatusFilter\] = useState\('all'\)/)
  assert.match(designList, /const filteredDesigns = useMemo\(\(\) => designs\.filter/)
  assert.match(designList, /\$\{design\.name\}\$\{design\.id\}\$\{design\.latestRun\?\.id \?\? ''\}/)
  assert.match(designList, /statusFilter === 'no_run' && !design\.latestRun/)
  assert.match(designList, /design\.latestRun\?\.status === statusFilter/)
  assert.match(designList, /aria-label="搜索测试设计" value=\{query\} onChange=\{event => setQuery\(event\.target\.value\)\}/)
  assert.match(designList, /aria-label="状态筛选" value=\{statusFilter\} onChange=\{event => setStatusFilter\(event\.target\.value\)\}/)
  assert.match(designList, /<tbody>\{filteredDesigns\.map/)
  for (const status of ['queued', 'running', 'waiting_gate', 'succeeded', 'failed', 'cancelled']) assert.match(designList, new RegExp(`value="${status}"`))
  assert.doesNotMatch(designList, />设计中<\/option>|>待审核<\/option>|>已发布<\/option>/)
  assert.match(designList, /designs\.length > 0 && filteredDesigns\.length === 0/)
})

test('紧凑桌面保持测试设计固定壳，移动端才使用文档流', () => {
  const styles = readFileSync(new URL('../src/test-design.css', import.meta.url), 'utf8')
  const compactWorkspace = styles.match(/@media\(max-width:900px\)\{\.td-workspace-grid[^\n]*/)?.[0] ?? ''

  assert.doesNotMatch(compactWorkspace, /\.content\.test-design-content|\.test-design-content>\.td-workbench/)
  assert.match(styles, /@media\(max-width:760px\)\{\.content\.test-design-content\{height:auto;min-height:calc\(100vh - 20px\);overflow:auto;padding:12px\}\.test-design-content>\.td-workbench\{min-height:760px\}\}/)
})

test('真实测试用例支持 ETag 编辑、审核、阻断修复和不可变发布', () => {
  const source = readFileSync(new URL('../src/TestDesignPage.tsx', import.meta.url), 'utf8')
  const api = readFileSync(new URL('../src/test-design-api.ts', import.meta.url), 'utf8')

  assert.match(source, /function RunCaseEditor\b/)
  assert.match(source, /保存 revision/)
  assert.match(source, /提交审核/)
  assert.match(source, /批量完成审核/)
  assert.match(source, /创建关联用例/)
  assert.match(source, /重新审计/)
  assert.match(source, /确认发布/)
  assert.match(source, /function RunTreeArtifact[\s\S]*保存 revision/)
  assert.match(source, /批准当前 revision/)
  for (const action of ['loadTestDesignCase', 'createTestDesignCase', 'updateTestDesignCase', 'reviewTestDesignCase', 'batchReviewTestDesignCases', 'reAuditTestDesignRun', 'publishTestCaseSet', 'updateTestPointTree', 'approveTestPointTree']) {
    assert.match(api, new RegExp(`export (?:async function|const) ${action}\\b`))
  }
  assert.match(api, /'if-match': etag/)
})

test('项目用例目录、导出、处置和执行交接使用真实 Phase 4 API', () => {
  const source = readFileSync(new URL('../src/TestDesignPage.tsx', import.meta.url), 'utf8')
  const api = readFileSync(new URL('../src/test-design-api.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /SET-SMOKE|SET-REGRESSION|有效用例<\/dt><dd>386/u)
  for (const action of ['loadProjectTestCaseCatalog', 'loadProjectTestSuites', 'reviewSmokeCandidate', 'saveImpactedRegression', 'createExecutionHandoff', 'replaceTestDataRequirements', 'actOnTestDesignFinding', 'actOnTestDesignConfirmation']) assert.match(api, new RegExp(`export const ${action}\\b`))
  assert.match(source, /testCaseSetExportUrl\(version\.id, 'xlsx'\)/)
  assert.match(source, /function PublishedCaseSetOperations\b/)
  for (const label of ['仅重跑功能设计', '仅重跑非功能设计', '重新分析范围', '重新具象化', '全部重跑']) assert.match(source, new RegExp(label))
  for (const action of ['fullRerunTestDesign', 'reviseTestDesignScope', 'retryTestDesignNode', 'resynthesizeTestDesign']) assert.match(api, new RegExp(`export const ${action}\\b`))
})

test('测试用例长表单受工作台高度约束并在编辑区内滚动', () => {
  const styles = readFileSync(new URL('../src/test-design.css', import.meta.url), 'utf8')

  assert.match(styles, /\.td-workspace-grid>\.td-detail-panel\{min-height:0;overflow:hidden\}/)
  assert.match(styles, /\.td-detail-scroll\{min-height:0;flex:1;padding:13px;overflow:auto\}/)
  assert.match(styles, /\.td-detail-panel>footer\{min-height:52px;flex:0 0 52px;/)
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

test('知识资产范围门禁展示完整基线、原子覆盖单元和规范包含排除字段', () => {
  const source = readFileSync(new URL('../src/TestDesignPage.tsx', import.meta.url), 'utf8')
  assert.match(source, /scopeRecord\.inclusions/)
  assert.match(source, /scopeRecord\.exclusions/)
  assert.match(source, /纳入的知识基线项/)
  assert.match(source, /原子覆盖单元/)
  assert.match(source, /function scopeBasisSummary/)
  assert.match(source, /function scopeCoverageUnitSummary/)
  assert.match(source, /function ScopeDetailModal/)
  assert.match(source, /查看完整范围/)
  assert.match(source, /完整展示，不截断条目内容/)
})

test('范围门禁提供待确认项处理入口并阻断未处理的分析阻断项', () => {
  const source = readFileSync(new URL('../src/TestDesignPage.tsx', import.meta.url), 'utf8')
  assert.match(source, /处理待确认项/)
  assert.match(source, /openConfirmations = run\.confirmationItems\.filter\(item => item\.state === 'open'\)/)
  assert.match(source, /run\.confirmationItems\.length[\s\S]*openConfirmations\.map/)
  assert.match(source, /openBlockingConfirmations = run\.confirmationItems\.filter/)
  assert.match(source, /scopeApprovalBlocked/)
  assert.match(source, /disabled=\{submitting \|\| !targetId \|\| scopeApprovalBlocked\}/)
})

test('Finding 与待确认项使用可审阅的处置弹窗提交解决方案', () => {
  const source = readFileSync(new URL('../src/TestDesignPage.tsx', import.meta.url), 'utf8')
  const questions = source.match(/function RunQuestionsArtifact\b[\s\S]*?\n\}\n\nfunction dispositionStateLabel/)?.[0] ?? ''
  const modal = source.match(/function TestDesignDispositionModal\b[\s\S]*?\n\}\n\nfunction RunArtifactState/)?.[0] ?? ''
  assert.doesNotMatch(questions, /window\.prompt/)
  assert.match(questions, /openConfirmationDisposition/)
  assert.match(questions, /submitDisposition/)
  assert.match(modal, /role="dialog"/)
  assert.match(modal, /解决方案 \/ 处置说明/)
  assert.match(modal, /关联依据/)
  assert.match(modal, /disabled=\{submitting \|\| !comment\.trim\(\)\}/)
})

test('全部处置后明确返回范围门禁完成最终批准', () => {
  const source = readFileSync(new URL('../src/TestDesignPage.tsx', import.meta.url), 'utf8')
  assert.match(source, /所有事项已处理/)
  assert.match(source, /前往确认测试范围/)
  assert.match(source, /returnToScopeGate/)
  assert.match(source, /if \(returnToScopeGate\) onOpenGate\(\)/)
  assert.match(source, /deferred: '已延期'/)
})

test('范围重新分析后门禁与产物视图使用当前节点输出', () => {
  const source = readFileSync(new URL('../src/TestDesignPage.tsx', import.meta.url), 'utf8')

  assert.match(source, /function currentNodeArtifact\b/)
  assert.match(source, /outputArtifactId[^\n]*run\.artifacts\.find\(item => item\.id === outputArtifactId\)/)
  assert.equal((source.match(/currentNodeArtifact\([^,]+, 'test_analysis'\)/g) ?? []).length, 5)
  assert.doesNotMatch(source, /artifacts\.find\(item => item\.nodeKey === 'test_analysis'\)/)
})

test('依据解构兼容历史根级字段并展示规范 coverageUnits', () => {
  const legacy = normalizeTestAnalysisGroups({ scope: 'TaskFlow V1', roles: ['所有者'], state: ['待处理'], verificationOracles: ['刷新后可见'], confirmationItems: ['确认状态流转'] })
  assert.deepEqual(legacy.map(group => [group.key, group.items.length]), [['scopeSummary', 1], ['states', 1], ['roles', 1], ['assertions', 1], ['pendingItems', 1]])

  const canonical = normalizeTestAnalysisGroups({ scope: { summary: '认证', objectives: ['验证登录'], inclusions: ['账号登录'], exclusions: [] }, coverageUnits: [{ ref: 'login-unit', title: '账号登录' }], findings: [] })
  assert.deepEqual(canonical.map(group => [group.key, group.items.length]), [['scopeSummary', 1], ['objectives', 1], ['inclusions', 1], ['coverageUnits', 1]])
})

test('真实产物页签与依据解构子模块拥有明确的独立滚动容器', () => {
  const source = readFileSync(new URL('../src/TestDesignPage.tsx', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('../src/test-design.css', import.meta.url), 'utf8')

  assert.match(source, /className="td-run-artifact-view td-run-analysis-view"/)
  assert.match(styles, /\.td-workspace-grid\{grid-template-rows:minmax\(0,1fr\)\}/)
  assert.match(styles, /\.td-main-canvas\{display:flex;flex-direction:column\}/)
  assert.match(styles, /\.td-run-artifact-view\{[^}]*height:100%;[^}]*min-height:0;[^}]*overflow:auto/)
  assert.match(styles, /\.td-run-analysis-view\{display:flex;flex-direction:column;overflow:hidden\}/)
  assert.match(styles, /\.td-run-analysis-grid\{[^}]*min-height:0;[^}]*flex:1;[^}]*overflow:auto/)
  assert.match(styles, /\.td-run-analysis-grid>section>div\{[^}]*min-height:0;[^}]*flex:1;[^}]*overflow:auto/)
})

test('活动测试设计运行静默更新且手动刷新不清空工作台', () => {
  const source = readFileSync(new URL('../src/TestDesignPage.tsx', import.meta.url), 'utf8')

  assert.match(source, /!\['queued', 'running'\]\.includes\(activeRun\.status\)/)
  assert.match(source, /window\.setTimeout\(\(\) => void poll\(\), 1_500\)/)
  assert.match(source, /const refreshWorkspace = async \(\) => \{[\s\S]*?setWorkspaceRefreshing\(true\)[\s\S]*?setWorkspaceRefreshing\(false\)/)
  const refreshWorkspace = source.match(/const refreshWorkspace = async \(\) => \{[\s\S]*?\n  \}/)?.[0] ?? ''
  assert.doesNotMatch(refreshWorkspace, /setWorkspaceLoading/)
  assert.match(source, /正在提交决策/)
})

test('测试设计工作流每个节点都可查看与评审一致的运行记录', () => {
  const source = readFileSync(new URL('../src/TestDesignPage.tsx', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('../src/test-design.css', import.meta.url), 'utf8')

  assert.match(source, /function TestDesignNodeRecordModal/)
  assert.match(source, /Agent 对话/)
  assert.match(source, /事件时间线/)
  assert.match(source, /toolArguments/)
  assert.match(source, /toolResult/)
  assert.match(source, /className="td-node-record-button"/)
  assert.match(source, /hasNodeRunRecord/)
  assert.match(source, /recordAvailable \? '运行记录' : '暂无记录'/)
  assert.doesNotMatch(source, /className="td-detail-record-button"/)
  assert.equal((source.match(/onOpenRecord=\{openNodeRecord\}/g) ?? []).length, 8)
  assert.match(styles, /\.td-node-record-button/)
  assert.match(styles, /\.td-node-record-modal/)
})

test('固定测试依据展示可读标题并支持单击弹窗预览完整快照', () => {
  const source = readFileSync(new URL('../src/TestDesignPage.tsx', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('../src/test-design.css', import.meta.url), 'utf8')

  assert.match(source, /function basisItemPresentation\b/)
  assert.match(source, /function BasisPreviewModal\b/)
  assert.match(source, /aria-label=\{`预览固定测试依据：\$\{view\.title\}`\}/)
  assert.match(source, /查看完整结构化快照/)
  assert.match(source, /查看来源定位信息/)
  assert.match(source, /event\.key === 'Escape'/)
  assert.match(styles, /\.td-basis-preview-modal/)
  assert.match(styles, /\.td-basis-preview-content/)
})

test('测试设计工作流使用独立滚动视口展示完整长轨道', () => {
  const source = readFileSync(new URL('../src/TestDesignPage.tsx', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('../src/test-design.css', import.meta.url), 'utf8')

  assert.equal((source.match(/className="td-workflow-track"/g) ?? []).length, 2)
  assert.match(styles, /\.td-workflow-canvas\.td-workflow-sequence\{width:100%;min-width:0;[^}]*overflow-x:auto/)
  assert.match(styles, /\.td-workflow-canvas\.td-workflow-sequence::\-webkit-scrollbar\{height:9px\}/)
  assert.match(styles, /\.td-workflow-track\{[^}]*min-width:1580px;[^}]*display:flex/)
  assert.doesNotMatch(styles, /\.td-workflow-canvas\.td-workflow-sequence\{min-width:1580px/)
})

test('工作流门禁内容扩展主画布高度并允许纵向滚动', () => {
  const styles = readFileSync(new URL('../src/test-design.css', import.meta.url), 'utf8')
  assert.match(styles, /\.td-main-canvas>\.td-workflow-view\{height:max-content;min-height:100%;flex:0 0 auto;overflow:visible\}/)
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
