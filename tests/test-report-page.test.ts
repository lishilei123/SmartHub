import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('App 懒加载真实报告工作台并清理 reportRunId 上下文', () => {
  const app = read('../src/App.tsx')
  assert.match(app, /import\('\.\/test-report\/TestReportPage'\)/u)
  assert.match(app, /正在加载报告与诊断工作台/u)
  assert.match(app, /<TestReportPage/u)
  assert.match(app, /reportRunId/u)
  assert.doesNotMatch(app, /报告与诊断[^\n]+hint: '占位'/u)
  assert.doesNotMatch(app, /page === 'reports'[^\n]+PlaceholderNotice/u)
})

test('报告页恢复 reportRunId 深链并支持列表外 Run 直接加载', () => {
  const page = read('../src/test-report/TestReportPage.tsx')
  const hook = read('../src/test-report/hooks/useTestReport.ts')
  assert.match(page, /searchParams\.get\('reportRunId'\)/u)
  assert.match(page, /model\.openReport\(runId\)/u)
  assert.match(page, /searchParams\.set\('reportRunId', runId\)/u)
  assert.doesNotMatch(page, /reports\.some[^\n]+openReport/u)
  assert.match(hook, /api\.loadReport\(projectVersionId, runId\)/u)
})

test('活动 Run 使用递归 setTimeout 轮询并保留当前报告', () => {
  const hook = read('../src/test-report/hooks/useTestReport.ts')
  assert.match(hook, /\['queued', 'running'\]\.includes\(report\.run\.status\)/u)
  assert.match(hook, /window\.setTimeout\(poll, 1800\)/u)
  assert.match(hook, /window\.setTimeout\(poll, 3000\)/u)
  assert.match(hook, /setRefreshing\(true\)/u)
  assert.match(hook, /setReport\(next\)/u)
  assert.doesNotMatch(hook, /setReport\(null\)[\s\S]{0,160}background/u)
  assert.doesNotMatch(hook, /setInterval|Math\.random|mock|fake/u)
})

test('前端只展示 Service 指标，不重算正式比率', () => {
  const overview = read('../src/test-report/TestReportOverview.tsx')
  const metrics = read('../src/test-report/TestReportMetrics.tsx')
  assert.match(overview, /report\.overview\.finalPassRate\.percentage/u)
  assert.match(metrics, /report\.firstExecutionQuality\.firstPassRate\.percentage/u)
  assert.match(metrics, /report\.stability\.flakyRate\.percentage/u)
  assert.match(metrics, /report\.selfHealing\.repairSuccessRate\.percentage/u)
  assert.doesNotMatch(`${overview}\n${metrics}`, /passed\s*\/\s*total|firstPassCount\s*\/|flakyCaseCount\s*\/|automaticRepairSuccessCount\s*\//u)
})

test('诊断与失败明细使用语义表格、正式空状态和安全 Artifact URL', () => {
  const diagnosis = read('../src/test-report/TestReportDiagnosisPanel.tsx')
  const failures = read('../src/test-report/TestReportFailureTable.tsx')
  const api = read('../src/test-report/api.ts')
  const categories = [
    'product_defect',
    'script_defect',
    'selector_changed',
    'environment_defect',
    'test_data_defect',
    'flaky',
    'assertion_mismatch',
    'timeout',
    'unknown',
  ]
  for (const category of categories) assert.match(diagnosis, new RegExp(category, 'u'))
  assert.match(diagnosis, /<table>/u)
  assert.match(failures, /暂无失败诊断/u)
  assert.match(failures, /等待执行结果/u)
  assert.match(failures, /artifactUrl\(artifact\.id, 'inline'\)/u)
  assert.match(failures, /artifactUrl\(artifact\.id\)/u)
  assert.match(api, /test-execution-artifacts/u)
  assert.doesNotMatch(`${failures}\n${api}`, /storagePath/u)
})

test('报告独立展示维护建议统计、正式追溯和人工维护边界', () => {
  const page = read('../src/test-report/TestReportPage.tsx')
  const maintenance = read('../src/test-report/TestReportMaintenanceTable.tsx')
  assert.match(page, /<TestReportMaintenanceTable report=\{model\.report\}/u)
  assert.match(maintenance, /report\.overview\.maintenanceProposalCount/u)
  assert.match(maintenance, /report\.overview\.pendingMaintenanceCount/u)
  assert.match(maintenance, /report\.overview\.acceptedMaintenanceCount/u)
  assert.match(maintenance, /report\.overview\.rejectedMaintenanceCount/u)
  assert.match(maintenance, /proposal\.diagnosisId/u)
  assert.match(maintenance, /proposal\.scriptRevisionId/u)
  assert.match(maintenance, /proposal\.baselineLibraryVersionId/u)
  assert.match(maintenance, /不会自动修改正式 TestCase/u)
  assert.doesNotMatch(maintenance, /nonPassedTasks/u)
})

test('报告提供 JSON/Markdown 导出与完整追溯且不引入大型图表库', () => {
  const page = read('../src/test-report/TestReportPage.tsx')
  const trace = read('../src/test-report/TestReportTraceability.tsx')
  const packageJson = read('../package.json')
  for (const value of ["'json'", "'markdown'", 'ProjectVersion ID', 'Handoff Hash', 'Library Version Hash', 'Runner Version', 'Playwright Version']) {
    assert.match(`${page}\n${trace}`, new RegExp(value, 'u'))
  }
  assert.match(trace, /Object\.values\(trace\.agents\)/u)
  assert.doesNotMatch(packageJson, /recharts|d3|chart\.js|echarts/u)
})

test('报告 CSS 提供响应式、滚动、长值换行及 forced-colors 等价视图', () => {
  const styles = read('../src/test-report/test-report.css')
  assert.match(styles, /@media\(max-width:1350px\)/u)
  assert.match(styles, /@media\(max-width:1100px\)/u)
  assert.match(styles, /@media\(max-width:760px\)/u)
  assert.match(styles, /@media\(forced-colors:active\)/u)
  assert.match(styles, /overflow-x:auto/u)
  assert.match(styles, /overflow-wrap:anywhere/u)
  assert.match(styles, /\.tr-status-distribution ul/u)
  assert.match(styles, /\.tr-magnitude i/u)
  assert.doesNotMatch(styles, /conic-gradient|pie|donut/u)
})
