import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('测试设计页面拆分为固定流程面板且不展示多 Agent DAG', () => {
  const page = read('../src/test-design/TestDesignPage.tsx')
  for (const panel of ['TestDesignCreatePanel', 'TestDesignRunPanel', 'TestPointReviewPanel', 'TestCasePanel', 'CoverageAuditPanel', 'ExecutionHandoffPanel']) assert.match(page, new RegExp(panel, 'u'))
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
})

test('Coverage 面板区分 Agent Repair 与 Human Decision，发布面板显示正式资产文件', () => {
  const audit = read('../src/test-design/CoverageAuditPanel.tsx')
  const publish = read('../src/test-design/ExecutionHandoffPanel.tsx')
  assert.match(audit, /resolution=agent_repair/u)
  assert.match(audit, /最多/u)
  assert.match(audit, /等待人工决策/u)
  assert.match(publish, /Audit PASS/u)
  assert.match(publish, /正式 Workspace 资产投影/u)
  assert.match(publish, /AssetVersion/u)
  assert.match(publish, /Execution Handoff/u)
})

test('测试设计页面在窄视口收敛布局并允许长 Hash 与路径完整显示', () => {
  const styles = read('../src/test-design/test-design.css')
  assert.match(styles, /@media \(max-width:760px\)/u)
  assert.match(styles, /min-width:0/u)
  assert.match(styles, /overflow-wrap:anywhere/u)
  assert.match(styles, /text-overflow:ellipsis/u)
  assert.match(styles, /overflow-x:auto/u)
})
