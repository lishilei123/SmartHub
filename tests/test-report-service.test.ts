import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { canonicalJson, canonicalSha256 } from '../server/application/canonical-json.js'
import {
  buildTestExecutionReport,
  TestReportService,
  TestReportServiceError,
} from '../server/application/test-report-service.js'
import { reportSourceFixture, reportSourceReader } from './test-report-fixture.js'

test('报告 Service 按正式口径计算概览、效率、首次质量、稳定性和自愈', () => {
  const report = buildTestExecutionReport(reportSourceFixture())
  assert.equal(report.schemaVersion, 'test-execution-report/v5')
  assert.equal(report.statisticsAt, '2026-08-14T00:00:26.000Z')
  assert.deepEqual(report.overview, {
    totalCases: 9,
    passed: 3,
    failed: 1,
    blocked: 1,
    waitingManual: 1,
    unsupported: 1,
    cancelled: 1,
    active: 1,
    maintenanceProposalCount: 1,
    pendingMaintenanceCount: 1,
    acceptedMaintenanceCount: 0,
    rejectedMaintenanceCount: 0,
    productDefectCandidateCount: 1,
    pendingProductDefectCount: 1,
    confirmedProductDefectCount: 0,
    rejectedProductDefectCount: 0,
    statusCounts: {
      pending: 0,
      script_generating: 0,
      ready: 0,
      running: 1,
      diagnosing: 0,
      retrying: 0,
      repairing: 0,
      passed: 3,
      failed: 1,
      blocked: 1,
      unsupported: 1,
      waiting_manual: 1,
      cancelled: 1,
    },
    finalPassRate: { numerator: 3, denominator: 9, percentage: 33.33 },
  })
  assert.deepEqual(report.efficiency, {
    totalDurationMs: 26_000,
    durationSampleCount: 7,
    averageCaseDurationMs: 643,
    minimumCaseDurationMs: 100,
    maximumCaseDurationMs: 900,
    p50CaseDurationMs: 700,
    p95CaseDurationMs: 900,
    totalRunnerAttempts: 10,
  })
  assert.deepEqual(report.firstExecutionQuality, {
    eligibleCaseCount: 5,
    firstPassCount: 1,
    firstPassRate: { numerator: 1, denominator: 5, percentage: 20 },
    passedAfterRetryCount: 1,
    passedAfterRepairCount: 1,
  })
  assert.deepEqual(report.stability, {
    sameScriptRetryCount: 1,
    flakyCaseCount: 1,
    flakyRate: { numerator: 1, denominator: 5, percentage: 20 },
    infrastructureErrorCount: 1,
  })
  assert.deepEqual(report.selfHealing, {
    triggeredTaskCount: 3,
    totalScriptRevisionCount: 11,
    automaticRepairSuccessCount: 1,
    automaticRepairFailureCount: 1,
    automaticRepairPendingCount: 1,
    repairSuccessRate: { numerator: 1, denominator: 2, percentage: 50 },
    averageRepairRounds: 1,
  })
})

test('报告固定返回九类诊断并按 Attempt ordinal 选择最新正式诊断', () => {
  const source = reportSourceFixture()
  const taskFour = source.tasks.find(task => task.id === 'task-4')!
  const firstAttempt = source.attempts.find(item => item.id === 'task-4-attempt-1')!
  taskFour.runnerAttemptCount += 1
  source.attempts.push({
    ...firstAttempt,
    id: 'task-4-attempt-2',
    ordinal: 2,
    invocationKey: 'task-4-invocation-2',
    kind: 'infrastructure_retry',
    startedAt: '2026-08-14T00:00:15.000Z',
    finishedAt: '2026-08-14T00:00:16.000Z',
    durationMs: 650,
  })
  source.diagnoses.push({
    ...source.diagnoses.find(item => item.id === 'diagnosis-product')!,
    id: 'diagnosis-higher-attempt',
    attemptIds: ['task-4-attempt-2'],
    category: 'assertion_mismatch',
    summary: '引用更高 ordinal 的诊断',
    createdAt: '2026-08-14T00:00:01.000Z',
  })
  const report = buildTestExecutionReport(source)
  assert.equal(report.diagnosisDistribution.categories.length, 9)
  assert.deepEqual(
    report.diagnosisDistribution.categories.map(item => item.category),
    [
      'product_defect',
      'script_defect',
      'selector_changed',
      'environment_defect',
      'test_data_defect',
      'flaky',
      'assertion_mismatch',
      'timeout',
      'unknown',
    ],
  )
  assert.equal(report.diagnosisDistribution.totalDiagnoses, 5)
  assert.equal(report.diagnosisDistribution.categories.find(item => item.category === 'script_defect')?.count, 1)
  assert.equal(report.productDefectCandidates.length, 1)
  assert.equal(report.productDefectCandidates[0].diagnosisId, 'diagnosis-product')
  assert.equal(report.productDefectCandidates[0].status, 'pending_confirmation')
  assert.equal(report.nonPassedTasks.find(task => task.taskId === 'task-4')?.diagnosis?.id, 'diagnosis-higher-attempt')
  assert.equal(report.nonPassedTasks.find(task => task.taskId === 'task-5')?.terminal, false)
  assert.equal(report.nonPassedTasks.find(task => task.taskId === 'task-7')?.diagnosis, null)
})

test('报告独立投影维护建议并将状态、内容和时间纳入正式契约', async () => {
  const pendingSource = reportSourceFixture()
  const pending = buildTestExecutionReport(pendingSource)
  assert.equal(pending.overview.maintenanceProposalCount, 1)
  assert.equal(pending.overview.pendingMaintenanceCount, 1)
  assert.equal(pending.overview.acceptedMaintenanceCount, 0)
  assert.equal(pending.overview.rejectedMaintenanceCount, 0)
  assert.equal(pending.maintenanceProposals[0].diagnosisCategory, 'script_defect')
  assert.equal(pending.maintenanceProposals[0].scriptRevisionId, 'task-3-revision-2')
  assert.equal(pending.nonPassedTasks.some(task => task.taskId === 'task-3'), false)

  const acceptedSource = reportSourceFixture()
  acceptedSource.maintenanceProposals[0] = {
    ...acceptedSource.maintenanceProposals[0],
    status: 'accepted',
    decidedBy: 'operator-1',
    decidedAt: '2026-08-14T00:00:30.000Z',
  }
  const accepted = buildTestExecutionReport(acceptedSource)
  assert.equal(accepted.statisticsAt, '2026-08-14T00:00:30.000Z')
  assert.equal(accepted.overview.pendingMaintenanceCount, 0)
  assert.equal(accepted.overview.acceptedMaintenanceCount, 1)
  assert.notEqual(accepted.reportSha256, pending.reportSha256)

  const rejectedSource = reportSourceFixture()
  rejectedSource.maintenanceProposals[0] = {
    ...rejectedSource.maintenanceProposals[0],
    status: 'rejected',
    decidedBy: 'operator-2',
    decidedAt: '2026-08-14T00:00:31.000Z',
  }
  const rejected = buildTestExecutionReport(rejectedSource)
  assert.equal(rejected.overview.rejectedMaintenanceCount, 1)
  assert.notEqual(rejected.reportSha256, accepted.reportSha256)

  const changedSource = reportSourceFixture()
  changedSource.maintenanceProposals[0].proposedChange += ' 人工复核。'
  assert.notEqual(buildTestExecutionReport(changedSource).reportSha256, pending.reportSha256)

  const markdown = await new TestReportService(reportSourceReader(acceptedSource))
    .exportMarkdown(acceptedSource.run.id)
  assert.match(markdown.body, /## 用例维护建议/u)
  assert.match(markdown.body, /已确认维护建议 \| 1/u)
  assert.match(markdown.body, /operator-1/u)
  assert.match(markdown.body, /不会自动修改正式 TestCase/u)
})

test('产品缺陷候选只由 append-only 人工处置事实从待确认进入终态', () => {
  const source = reportSourceFixture()
  source.productDefectCandidateActions = [{
    id: 'product-defect-action-1', runId: 'run-report-1', taskId: 'task-4', diagnosisId: 'diagnosis-product',
    version: 1, action: 'confirm', fromStatus: 'pending_confirmation', toStatus: 'confirmed',
    comment: '已结合 Trace 与终态页面人工复核', actorId: 'operator-1', actorDisplayName: '测试负责人',
    createdAt: '2026-08-14T00:00:31.000Z',
  }]
  const report = buildTestExecutionReport(source)
  assert.equal(report.productDefectCandidates[0].status, 'confirmed')
  assert.equal(report.productDefectCandidates[0].decisionEtag, undefined)
  assert.equal(report.productDefectCandidates[0].disposition?.actorDisplayName, '测试负责人')
  assert.equal(report.overview.pendingProductDefectCount, 0)
  assert.equal(report.overview.confirmedProductDefectCount, 1)
  assert.equal(report.statisticsAt, '2026-08-14T00:00:31.000Z')
})

test('报告 Artifact 只投影公开元数据且不泄露 storagePath', () => {
  const report = buildTestExecutionReport(reportSourceFixture())
  const artifact = report.nonPassedTasks.find(task => task.taskId === 'task-4')?.artifacts[0]
  assert.deepEqual(artifact, {
    id: 'artifact-private-path',
    attemptId: 'task-4-attempt-1',
    type: 'trace',
    sha256: 'a'.repeat(64),
    size: 2_048,
    mimeType: 'application/zip',
    createdAt: '2026-08-14T00:00:25.000Z',
  })
  assert.doesNotMatch(JSON.stringify(report), /storagePath|private\/objects/u)
})

test('报告输入乱序不改变 Hash 或导出字节，正式事实变化会改变 Hash', async () => {
  const source = reportSourceFixture()
  const shuffled = structuredClone(source)
  shuffled.tasks.reverse()
  shuffled.attempts.reverse()
  shuffled.diagnoses.reverse()
  shuffled.scriptRevisions.reverse()
  shuffled.maintenanceProposals.reverse()
  shuffled.artifacts.reverse()
  const first = buildTestExecutionReport(source)
  const second = buildTestExecutionReport(shuffled)
  assert.deepEqual(second, first)
  const { reportSha256: _reportSha256, ...content } = first
  assert.equal(first.reportSha256, canonicalSha256(content))

  const service = new TestReportService(reportSourceReader(source))
  const json = await service.exportJson(source.run.id)
  assert.equal(json.body, canonicalJson(first))
  const markdown = await service.exportMarkdown(source.run.id)
  assert.equal(markdown.sha256, createHash('sha256').update(markdown.body, 'utf8').digest('hex'))
  assert.match(markdown.body, /失败 \\| &lt;script&gt;<br>路径\\\\名称/u)
  assert.match(markdown.body, /## 产品缺陷候选/u)
  assert.match(markdown.body, /只有带人工处置事实的 confirmed 条目才表示已确认产品缺陷/u)
  assert.doesNotMatch(markdown.body, /storagePath|private\/objects/u)
  assert.equal(markdown.body.endsWith('\n'), true)
  assert.equal(markdown.body.includes('\r'), false)

  const changed = reportSourceFixture()
  changed.run.stateVersion += 1
  assert.notEqual(buildTestExecutionReport(changed).reportSha256, first.reportSha256)
})

test('无时长和无分母时返回 null 与数值 0，终态耗时使用 finishedAt', () => {
  const source = reportSourceFixture()
  source.attempts = []
  source.diagnoses = []
  source.scriptRevisions = []
  source.maintenanceProposals = []
  source.artifacts = []
  source.tasks = source.tasks.slice(6, 7).map(task => ({
    ...task,
    runnerAttemptCount: 0,
    sameScriptRetryCount: 0,
    repairCount: 0,
  }))
  source.run.taskCount = 1
  source.run.status = 'failed'
  source.run.finishedAt = '2026-08-14T00:01:00.000Z'
  const report = buildTestExecutionReport(source)
  assert.deepEqual(report.efficiency, {
    totalDurationMs: 60_000,
    durationSampleCount: 0,
    averageCaseDurationMs: null,
    minimumCaseDurationMs: null,
    maximumCaseDurationMs: null,
    p50CaseDurationMs: null,
    p95CaseDurationMs: null,
    totalRunnerAttempts: 0,
  })
  assert.deepEqual(report.firstExecutionQuality.firstPassRate, {
    numerator: 0,
    denominator: 0,
    percentage: 0,
  })
  assert.deepEqual(report.selfHealing.repairSuccessRate, {
    numerator: 0,
    denominator: 0,
    percentage: 0,
  })
})

test('报告拒绝可变计数器与不可变历史不一致', () => {
  const source = reportSourceFixture()
  source.tasks[0].runnerAttemptCount += 1
  assert.throws(
    () => buildTestExecutionReport(source),
    (error: unknown) => error instanceof TestReportServiceError
      && error.code === 'TEST_REPORT_COUNTER_MISMATCH'
      && error.status === 409,
  )
})

test('报告列表校验 limit 并仅投影 Run 的正式身份', async () => {
  const source = reportSourceFixture()
  const service = new TestReportService(reportSourceReader(source))
  assert.deepEqual(await service.listReports('pv-1', 1), {
    items: [{
      runId: source.run.id,
      projectVersionId: 'pv-1',
      status: 'running',
      stateVersion: 12,
      mode: 'full',
      totalCases: 9,
      environment: {
        id: 'environment-1',
        name: '报告测试环境',
        signature: 'e'.repeat(64),
      },
      createdAt: '2026-08-13T23:59:59.000Z',
      startedAt: '2026-08-14T00:00:00.000Z',
    }],
  })
  await assert.rejects(
    service.listReports('pv-1', 0),
    (error: unknown) => error instanceof TestReportServiceError
      && error.code === 'TEST_REPORT_LIMIT_INVALID'
      && error.status === 400,
  )
})
