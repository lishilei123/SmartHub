import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('测试设计页面拆分为固定流程面板且不展示多 Agent DAG', () => {
  const page = read('../src/test-design/TestDesignPage.tsx')
  for (const panel of ['TestDesignCreatePanel', 'TestDesignRunPanel', 'TestPointReviewPanel', 'TestCasePanel', 'CaseChangeProposalPanel', 'CoverageAuditPanel', 'TestDesignPublicationPanel', 'TestCaseLibraryPanel', 'TestSuiteLibraryPanel']) assert.match(page, new RegExp(panel, 'u'))
  for (const entry of ['设计任务', '测试用例库', '测试套件', '发布记录']) assert.match(page, new RegExp(entry, 'u'))
  assert.doesNotMatch(page, /ExecutionHandoffPanel/u)
  assert.doesNotMatch(page, /TestAnalysisAgent|FunctionalTestDesignAgent|NonFunctionalTestDesignAgent|TestCaseSynthesisAgent|scope_gate|tree_merge/u)
  assert.match(read('../src/App.tsx'), /\.\/test-design\/TestDesignPage/u)
})

test('创建面板明确展示绑定需求发布包并定义范围、维度和执行入口', () => {
  const source = read('../src/test-design/TestDesignCreatePanel.tsx')
  assert.match(source, /Requirement Release/u)
  assert.match(source, /releaseId/u)
  assert.match(source, /纳入范围/u)
  assert.match(source, /排除范围/u)
  assert.match(source, /测试维度/u)
  assert.match(source, /执行入口/u)
  assert.doesNotMatch(source, /basisMode|review_baseline|sourceTechnicalSolutionRunId/u)
})

test('运行面板展示冻结 Release、Workspace、Agent 配置与实时轨迹', () => {
  const source = read('../src/test-design/TestDesignRunPanel.tsx')
  assert.match(source, /Requirement Release/u)
  assert.match(source, /verificationRunId/u)
  assert.match(source, /requirementsJsonSha256/u)
  assert.match(source, /Workspace Snapshot/u)
  assert.match(source, /Agent 配置快照/u)
  assert.match(source, /Pi Agent 实时轨迹/u)
  assert.match(source, /Coverage 检查/u)
})

test('测试点审核是唯一人工门禁并保留树操作与 AI 重新设计', () => {
  const review = read('../src/test-design/TestPointReviewPanel.tsx')
  const tree = read('../src/test-design/TestPointTreePanel.tsx')
  assert.match(review, /唯一人工门禁/u)
  assert.match(review, /批准 TestPointTreeVersion/u)
  assert.match(review, /AI 重新设计/u)
  for (const operation of ["op: 'add'", "op: 'rename'", "op: 'delete'", "op: 'split'", "op: 'merge'"]) assert.match(`${review}\n${tree}`, new RegExp(operation, 'u'))
  assert.match(review, /op: 'update'/u)
  assert.match(review, /Revision 修改说明/u)
  assert.match(review, /执行入口/u)
  assert.doesNotMatch(`${review}\n${tree}`, /window\.(?:prompt|confirm)/u)
})

test('测试用例支持新增、结构化编辑、单条审核与 Revision 记录', () => {
  const panel = read('../src/test-design/TestCasePanel.tsx')
  const hook = read('../src/test-design/hooks/useTestDesign.ts')
  for (const label of ['新增用例', '编辑并新建 Revision', '要求修改', 'Revision 与审核记录', '确认删除']) assert.match(panel, new RegExp(label, 'u'))
  assert.match(panel, /执行步骤/u)
  assert.match(panel, /关联可执行测试点/u)
  for (const method of ['createCase', 'patchCase', 'deleteCase', 'reviewCase']) assert.match(hook, new RegExp(`api\\.${method}`, 'u'))
})

test('测试执行和报告页明确标记为占位且 README 不再引用已删除阶段文档', () => {
  const app = read('../src/App.tsx')
  const readme = read('../README.md')
  assert.match(app, /功能占位 · 尚未实现/u)
  assert.match(app, /hint: '占位'/u)
  assert.match(app, /Execution Handoff/u)
  assert.match(app, /跨运行质量汇总/u)
  assert.match(readme, /\| 测试执行 \| 占位 \|/u)
  assert.match(readme, /\| 报告与诊断 \| 占位 \|/u)
  assert.doesNotMatch(readme, /第一期-项目知识库|第二期-需求评审/u)
  assert.equal(existsSync(new URL('../_temp.patch', import.meta.url)), false)
})

test('Coverage 面板区分 Agent Repair 与 Human Decision，发布面板显示正式资产文件', () => {
  const audit = read('../src/test-design/CoverageAuditPanel.tsx')
  const publish = read('../src/test-design/TestDesignPublicationPanel.tsx')
  assert.match(audit, /resolution=agent_repair/u)
  assert.match(audit, /最多/u)
  assert.match(audit, /等待人工决策/u)
  assert.match(publish, /Coverage Audit/u)
  assert.match(publish, /Workspace 投影/u)
  assert.match(publish, /contentSha256/u)
  assert.match(publish, /Execution Handoff/u)
})

test('历史用例库版本、套件批量选择与 Handoff 全部使用冻结 Revision', () => {
  const suite = read('../src/test-design/TestSuiteLibraryPanel.tsx')
  const library = read('../src/test-design/TestCaseLibraryPanel.tsx')
  const publish = read('../src/test-design/TestDesignPublicationPanel.tsx')
  const api = read('../src/test-design/api.ts')
  assert.match(suite, /member\.frozenContent\.title/u)
  assert.match(suite, /member\.frozenContent\.executionSpec/u)
  assert.match(suite, /该用例已有较新 Revision，当前套件仍使用冻结的 Revision/u)
  assert.match(library, /executionMethod\(member\.frozenContent\)/u)
  assert.doesNotMatch(library, /executionMethod\(testCase\.content\).*批量加入/u)
  assert.match(publish, /冻结内容 Hash/u)
  assert.match(publish, /needs_confirmation 成员默认被服务端阻断/u)
  assert.match(publish, /人工覆盖原因（必填）/u)
  assert.match(publish, /overrideInputs\.some\(item => !item\.reason\)/u)
  assert.match(api, /executionReadinessOverrides/u)
})

test('测试设计页面在窄视口收敛布局并允许长 Hash 与路径完整显示', () => {
  const styles = read('../src/test-design/test-design.css')
  assert.match(styles, /@media \(max-width:760px\)/u)
  assert.match(styles, /min-width:0/u)
  assert.match(styles, /overflow-wrap:anywhere/u)
  assert.match(styles, /text-overflow:ellipsis/u)
  assert.match(styles, /overflow-x:auto/u)
})
