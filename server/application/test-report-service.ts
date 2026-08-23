import { createHash } from 'node:crypto'
import { canonicalJson, canonicalSha256 } from './canonical-json.js'
import type {
  ExecutionArtifact,
  ExecutionAttempt,
  ExecutionRun,
  ExecutionTask,
  ExecutionTaskStatus,
  FailureDiagnosis,
  FailureDiagnosisCategory,
  FrozenExecutionAgentSnapshot,
  ScriptRevision,
} from '../domain/test-execution-types.js'
import type {
  TestExecutionReport,
  TestExecutionReportContent,
  TestReportAgentTraceability,
  TestReportDiagnosisCategoryStatistics,
  TestReportListItem,
  TestReportNonPassedTask,
  TestReportRate,
} from '../domain/test-report-types.js'
import type {
  TestExecutionReportSource,
  TestExecutionReportSourceReader,
} from '../infrastructure/test-execution-store.js'

const taskStatuses: ExecutionTaskStatus[] = [
  'pending',
  'script_generating',
  'ready',
  'running',
  'diagnosing',
  'retrying',
  'repairing',
  'passed',
  'failed',
  'blocked',
  'unsupported',
  'waiting_manual',
  'cancelled',
]

const diagnosisCategories: FailureDiagnosisCategory[] = [
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

const terminalTaskStatuses = new Set<ExecutionTaskStatus>([
  'passed',
  'failed',
  'blocked',
  'unsupported',
  'waiting_manual',
  'cancelled',
])

export class TestReportServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

export class TestReportService {
  constructor(private readonly sourceReader: TestExecutionReportSourceReader) {}

  async listReports(projectVersionId: string, limit = 50) {
    requiredIdentity(projectVersionId, 'projectVersionId')
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new TestReportServiceError(
        'TEST_REPORT_LIMIT_INVALID',
        'limit 必须是 1 到 200 的整数',
        400,
      )
    }
    const runs = await this.sourceReader.listRuns(projectVersionId, limit)
    return {
      items: runs.map(reportListItem),
    }
  }

  async getRun(runId: string) {
    const run = await this.sourceReader.getRun(requiredIdentity(runId, 'runId'))
    if (!run) {
      throw new TestReportServiceError(
        'TEST_REPORT_RUN_NOT_FOUND',
        '测试报告对应的执行 Run 不存在',
        404,
      )
    }
    return run
  }

  async getReport(runId: string): Promise<TestExecutionReport> {
    const source = await this.sourceReader.getRunReportSource(
      requiredIdentity(runId, 'runId'),
    )
    if (!source) {
      throw new TestReportServiceError(
        'TEST_REPORT_RUN_NOT_FOUND',
        '测试报告对应的执行 Run 不存在',
        404,
      )
    }
    return buildTestExecutionReport(source)
  }

  async exportJson(runId: string) {
    const report = await this.getReport(runId)
    return {
      report,
      body: canonicalJson(report),
    }
  }

  async exportMarkdown(runId: string) {
    const report = await this.getReport(runId)
    const body = testExecutionReportMarkdown(report)
    return {
      report,
      body,
      sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    }
  }
}

export function buildTestExecutionReport(
  rawSource: TestExecutionReportSource,
): TestExecutionReport {
  const source = normalizedSource(rawSource)
  assertSourceConsistency(source)
  const { run, tasks, attempts, diagnoses, scriptRevisions, artifacts, maintenanceProposals } = source
  const statusCounts = Object.fromEntries(
    taskStatuses.map(status => [
      status,
      tasks.filter(task => task.status === status).length,
    ]),
  ) as Record<ExecutionTaskStatus, number>
  const statisticsAt = reportStatisticsAt(source)
  const passed = statusCounts.passed
  const pendingMaintenanceCount = maintenanceProposals.filter(
    proposal => proposal.status === 'pending',
  ).length
  const acceptedMaintenanceCount = maintenanceProposals.filter(
    proposal => proposal.status === 'accepted',
  ).length
  const rejectedMaintenanceCount = maintenanceProposals.filter(
    proposal => proposal.status === 'rejected',
  ).length
  const active = taskStatuses
    .filter(status => !terminalTaskStatuses.has(status))
    .reduce((sum, status) => sum + statusCounts[status], 0)

  const attemptsByTask = grouped(attempts, attempt => attempt.taskId)
  const revisionsByTask = grouped(scriptRevisions, revision => revision.taskId)
  const diagnosesByTask = grouped(diagnoses, diagnosis => diagnosis.taskId)
  const artifactsByTask = grouped(
    artifacts.filter(artifact => artifact.taskId),
    artifact => artifact.taskId!,
  )
  const revisionById = new Map(scriptRevisions.map(revision => [revision.id, revision]))
  const diagnosisById = new Map(diagnoses.map(diagnosis => [diagnosis.id, diagnosis]))
  const attemptById = new Map(attempts.map(attempt => [attempt.id, attempt]))

  const durationSamples = tasks.flatMap(task => {
    const duration = (attemptsByTask.get(task.id) ?? [])
      .filter(attempt => attempt.status !== 'running' && attempt.durationMs !== undefined)
      .reduce((sum, attempt) => sum + attempt.durationMs!, 0)
    return (attemptsByTask.get(task.id) ?? []).some(
      attempt => attempt.status !== 'running' && attempt.durationMs !== undefined,
    ) ? [duration] : []
  }).sort((left, right) => left - right)

  let firstPassCount = 0
  let passedAfterRetryCount = 0
  let passedAfterRepairCount = 0
  let eligibleCaseCount = 0
  for (const task of tasks) {
    const taskAttempts = attemptsByTask.get(task.id) ?? []
    const businessAttempts = taskAttempts.filter(
      attempt => attempt.status === 'passed' || attempt.status === 'failed',
    )
    if (!businessAttempts.length) continue
    eligibleCaseCount += 1
    const repairedPass = taskAttempts.some(attempt =>
      attempt.status === 'passed'
      && revisionById.get(attempt.scriptRevisionId)?.source === 'repair')
    if (repairedPass) passedAfterRepairCount += 1
    else if (
      businessAttempts[0].status === 'failed'
      && businessAttempts.some(attempt => attempt.status === 'passed')
    ) passedAfterRetryCount += 1
    else if (businessAttempts[0].status === 'passed') firstPassCount += 1
  }

  const flakyTaskIds = new Set(
    diagnoses
      .filter(diagnosis => diagnosis.category === 'flaky')
      .map(diagnosis => diagnosis.taskId),
  )
  const repairRevisions = scriptRevisions.filter(revision => revision.source === 'repair')
  const repairTaskIds = new Set(repairRevisions.map(revision => revision.taskId))
  let automaticRepairSuccessCount = 0
  let automaticRepairFailureCount = 0
  let automaticRepairPendingCount = 0
  for (const taskId of repairTaskIds) {
    const task = tasks.find(candidate => candidate.id === taskId)!
    const repairedRevisionIds = new Set(
      (revisionsByTask.get(taskId) ?? [])
        .filter(revision => revision.source === 'repair')
        .map(revision => revision.id),
    )
    const succeeded = (attemptsByTask.get(taskId) ?? []).some(attempt =>
      attempt.status === 'passed' && repairedRevisionIds.has(attempt.scriptRevisionId))
    if (succeeded) automaticRepairSuccessCount += 1
    else if (terminalTaskStatuses.has(task.status)) automaticRepairFailureCount += 1
    else automaticRepairPendingCount += 1
  }

  const diagnosisDistribution = diagnosisCategories.map(category => {
    const count = diagnoses.filter(diagnosis => diagnosis.category === category).length
    return {
      category,
      count,
      percentage: percentage(count, diagnoses.length),
    } satisfies TestReportDiagnosisCategoryStatistics
  })

  const content: TestExecutionReportContent = {
    schemaVersion: 'test-execution-report/v3',
    statisticsAt,
    run: {
      id: run.id,
      status: run.status,
      stateVersion: run.stateVersion,
      mode: run.handoff.mode,
      createdAt: run.createdAt,
      ...(run.startedAt ? { startedAt: run.startedAt } : {}),
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    },
    overview: {
      totalCases: tasks.length,
      passed,
      failed: statusCounts.failed,
      blocked: statusCounts.blocked,
      waitingManual: statusCounts.waiting_manual,
      unsupported: statusCounts.unsupported,
      cancelled: statusCounts.cancelled,
      active,
      maintenanceProposalCount: maintenanceProposals.length,
      pendingMaintenanceCount,
      acceptedMaintenanceCount,
      rejectedMaintenanceCount,
      statusCounts,
      finalPassRate: rate(passed, tasks.length),
    },
    efficiency: {
      totalDurationMs: runDuration(run, statisticsAt),
      durationSampleCount: durationSamples.length,
      averageCaseDurationMs: durationSamples.length
        ? Math.round(durationSamples.reduce((sum, value) => sum + value, 0) / durationSamples.length)
        : null,
      minimumCaseDurationMs: durationSamples.at(0) ?? null,
      maximumCaseDurationMs: durationSamples.at(-1) ?? null,
      p50CaseDurationMs: percentile(durationSamples, 0.5),
      p95CaseDurationMs: percentile(durationSamples, 0.95),
      totalRunnerAttempts: attempts.length,
    },
    firstExecutionQuality: {
      eligibleCaseCount,
      firstPassCount,
      firstPassRate: rate(firstPassCount, eligibleCaseCount),
      passedAfterRetryCount,
      passedAfterRepairCount,
    },
    stability: {
      sameScriptRetryCount: attempts.filter(
        attempt => attempt.kind === 'same_script_retry',
      ).length,
      flakyCaseCount: flakyTaskIds.size,
      flakyRate: rate(flakyTaskIds.size, eligibleCaseCount),
      infrastructureErrorCount: attempts.filter(
        attempt => attempt.status === 'infrastructure_error',
      ).length,
    },
    selfHealing: {
      triggeredTaskCount: repairTaskIds.size,
      totalScriptRevisionCount: scriptRevisions.length,
      automaticRepairSuccessCount,
      automaticRepairFailureCount,
      automaticRepairPendingCount,
      repairSuccessRate: rate(
        automaticRepairSuccessCount,
        automaticRepairSuccessCount + automaticRepairFailureCount,
      ),
      averageRepairRounds: repairTaskIds.size
        ? round(repairRevisions.length / repairTaskIds.size, 2)
        : 0,
    },
    diagnosisDistribution: {
      totalDiagnoses: diagnoses.length,
      categories: diagnosisDistribution,
    },
    nonPassedTasks: tasks
      .filter(task => task.status !== 'passed')
      .map(task => nonPassedTask(
        task,
        attemptsByTask.get(task.id) ?? [],
        diagnosesByTask.get(task.id) ?? [],
        revisionsByTask.get(task.id) ?? [],
        artifactsByTask.get(task.id) ?? [],
        attemptById,
      )),
    maintenanceProposals: maintenanceProposals.map(proposal => {
      const task = tasks.find(item => item.id === proposal.taskId)!
      const diagnosis = diagnosisById.get(proposal.diagnosisId)!
      return {
        ...structuredClone(proposal),
        ordinal: task.input.ordinal,
        title: task.input.caseContent.title,
        diagnosisCategory: diagnosis.category,
        diagnosisSummary: diagnosis.summary,
      }
    }),
    traceability: {
      projectId: run.projectId,
      projectVersionId: run.projectVersionId,
      runId: run.id,
      runStateVersion: run.stateVersion,
      handoff: {
        id: run.handoff.handoffId,
        sha256: run.handoff.handoffSha256,
        memberSnapshotSha256: run.handoff.memberSnapshotSha256,
      },
      testCaseLibraryVersion: {
        id: run.handoff.testCaseLibraryVersionId,
        sha256: run.handoff.testCaseLibraryVersionSha256,
        ...(source.testCaseLibraryVersionSourceRunId
          ? { sourceRunId: source.testCaseLibraryVersionSourceRunId }
          : {}),
      },
      ...(run.handoff.suiteVersionId && run.handoff.suiteVersionSha256
        ? {
            testSuiteVersion: {
              id: run.handoff.suiteVersionId,
              sha256: run.handoff.suiteVersionSha256,
            },
          }
        : {}),
      environment: {
        id: run.environment.environmentId,
        name: run.environment.name,
        signature: run.environment.signature,
        baseUrl: run.environment.baseUrl,
        targets: structuredClone(run.environment.targets),
      },
      runner: structuredClone(run.runner),
      agents: {
        executionImplementation: agentTraceability(run.agents.executionImplementation),
        failureAnalysis: agentTraceability(run.agents.failureAnalysis),
      },
    },
  }
  return {
    ...content,
    reportSha256: canonicalSha256(content),
  }
}

export function testExecutionReportMarkdown(report: TestExecutionReport) {
  const diagnosisRows = report.diagnosisDistribution.categories
    .map(item => `| ${md(item.category)} | ${item.count} | ${formatPercentage(item.percentage)} |`)
  const failureRows = report.nonPassedTasks.length
    ? report.nonPassedTasks.map(task =>
        `| ${task.ordinal} | ${md(task.caseId)}@${task.caseRevision} | ${md(task.title)} | ${md(task.status)} | ${md(task.diagnosis?.category ?? '无正式诊断')} | ${task.attemptCount} | ${task.scriptRevisionCount} |`)
    : ['| - | - | 无 | - | - | 0 | 0 |']
  const maintenanceRows = report.maintenanceProposals.length
    ? report.maintenanceProposals.map(proposal =>
        `| ${proposal.ordinal} | ${md(proposal.caseId)}@${proposal.caseRevision} | ${md(proposal.title)} | ${md(proposal.status)} | ${md(proposal.summary)}<br>${md(proposal.proposedChange)} | ${md(proposal.diagnosisCategory)}<br>${md(proposal.diagnosisSummary)}<br>${md(proposal.diagnosisId)} | ${md(proposal.scriptRevisionId)} | ${md(proposal.baselineLibraryVersionId)}<br>${md(proposal.baselineLibraryVersionSha256)} | ${md(proposal.createdAt)} | ${md(proposal.decidedBy ?? '-')}<br>${md(proposal.decidedAt ?? '-')} |`)
    : ['| - | - | 无 | - | - | - | - | - | - | - |']
  const trace = report.traceability
  const agentRows = Object.values(trace.agents).map(agent =>
    `| ${md(agent.agentKey)} | ${agent.configurationVersion} | ${md(agent.configurationSha256)} | ${md(agent.snapshotSha256)} |`)
  return [
    '# 测试执行报告',
    '',
    `- Report SHA-256: ${md(report.reportSha256)}`,
    `- Statistics At: ${md(report.statisticsAt)}`,
    `- Project Version: ${md(trace.projectVersionId)}`,
    `- Execution Run: ${md(trace.runId)}`,
    `- Run Status: ${md(report.run.status)}`,
    '',
    '## 执行概览',
    '',
    '| 指标 | 数值 |',
    '|---|---:|',
    `| 用例总数 | ${report.overview.totalCases} |`,
    `| 通过 | ${report.overview.passed} |`,
    `| 失败 | ${report.overview.failed} |`,
    `| 阻塞 | ${report.overview.blocked} |`,
    `| 等待人工处理 | ${report.overview.waitingManual} |`,
    `| 未支持 | ${report.overview.unsupported} |`,
    `| 已取消 | ${report.overview.cancelled} |`,
    `| 进行中 | ${report.overview.active} |`,
    `| 用例维护建议 | ${report.overview.maintenanceProposalCount} |`,
    `| 待确认维护建议 | ${report.overview.pendingMaintenanceCount} |`,
    `| 已确认维护建议 | ${report.overview.acceptedMaintenanceCount} |`,
    `| 已拒绝维护建议 | ${report.overview.rejectedMaintenanceCount} |`,
    `| 最终通过率 | ${formatPercentage(report.overview.finalPassRate.percentage)} (${report.overview.finalPassRate.numerator}/${report.overview.finalPassRate.denominator}) |`,
    '',
    '## 执行效率',
    '',
    '| 指标 | 数值 |',
    '|---|---:|',
    `| 总耗时 | ${report.efficiency.totalDurationMs} ms |`,
    `| 时长样本数 | ${report.efficiency.durationSampleCount} |`,
    `| 平均用例耗时 | ${formatDuration(report.efficiency.averageCaseDurationMs)} |`,
    `| 最短用例耗时 | ${formatDuration(report.efficiency.minimumCaseDurationMs)} |`,
    `| 最长用例耗时 | ${formatDuration(report.efficiency.maximumCaseDurationMs)} |`,
    `| P50 | ${formatDuration(report.efficiency.p50CaseDurationMs)} |`,
    `| P95 | ${formatDuration(report.efficiency.p95CaseDurationMs)} |`,
    `| Runner Attempt 总数 | ${report.efficiency.totalRunnerAttempts} |`,
    '',
    '## 首次执行质量、稳定性与自愈',
    '',
    '| 指标 | 数值 |',
    '|---|---:|',
    `| 首轮通过 | ${report.firstExecutionQuality.firstPassCount} |`,
    `| 首轮通过率 | ${formatPercentage(report.firstExecutionQuality.firstPassRate.percentage)} (${report.firstExecutionQuality.firstPassRate.numerator}/${report.firstExecutionQuality.firstPassRate.denominator}) |`,
    `| 重试后通过 | ${report.firstExecutionQuality.passedAfterRetryCount} |`,
    `| 修复后通过 | ${report.firstExecutionQuality.passedAfterRepairCount} |`,
    `| 同脚本重试 | ${report.stability.sameScriptRetryCount} |`,
    `| Flaky 用例 | ${report.stability.flakyCaseCount} |`,
    `| Flaky 率 | ${formatPercentage(report.stability.flakyRate.percentage)} (${report.stability.flakyRate.numerator}/${report.stability.flakyRate.denominator}) |`,
    `| 基础设施错误 | ${report.stability.infrastructureErrorCount} |`,
    `| 触发 ScriptRepair 的任务 | ${report.selfHealing.triggeredTaskCount} |`,
    `| ScriptRevision 总数 | ${report.selfHealing.totalScriptRevisionCount} |`,
    `| 自动修复成功 / 失败 / 进行中 | ${report.selfHealing.automaticRepairSuccessCount} / ${report.selfHealing.automaticRepairFailureCount} / ${report.selfHealing.automaticRepairPendingCount} |`,
    `| 修复成功率 | ${formatPercentage(report.selfHealing.repairSuccessRate.percentage)} (${report.selfHealing.repairSuccessRate.numerator}/${report.selfHealing.repairSuccessRate.denominator}) |`,
    `| 平均修复轮数 | ${report.selfHealing.averageRepairRounds} |`,
    '',
    '## 诊断分布',
    '',
    '| 类别 | 数量 | 占比 |',
    '|---|---:|---:|',
    ...diagnosisRows,
    '',
    '## 非通过任务',
    '',
    '| 序号 | 用例 | 标题 | 状态 | 最新正式诊断 | Attempts | Revisions |',
    '|---:|---|---|---|---|---:|---:|',
    ...failureRows,
    '',
    '## 用例维护建议',
    '',
    '接受仅表示确认该正式用例需要人工维护，不会自动修改正式 TestCase。',
    '',
    '| 序号 | 用例 | 标题 | 状态 | 建议 | Diagnosis | Repair Revision | Baseline Library | 创建时间 | 审批 |',
    '|---:|---|---|---|---|---|---|---|---|---|',
    ...maintenanceRows,
    '',
    '## 完整追溯',
    '',
    `- Project: ${md(trace.projectId)}`,
    `- Project Version: ${md(trace.projectVersionId)}`,
    `- Run: ${md(trace.runId)} (stateVersion ${trace.runStateVersion})`,
    `- Handoff: ${md(trace.handoff.id)} / ${md(trace.handoff.sha256)}`,
    `- TestCaseLibraryVersion: ${md(trace.testCaseLibraryVersion.id)} / ${md(trace.testCaseLibraryVersion.sha256)}`,
    ...(trace.testCaseLibraryVersion.sourceRunId
      ? [`- Library Source Run: ${md(trace.testCaseLibraryVersion.sourceRunId)}`]
      : []),
    ...(trace.testSuiteVersion
      ? [`- TestSuiteVersion: ${md(trace.testSuiteVersion.id)} / ${md(trace.testSuiteVersion.sha256)}`]
      : []),
    `- Environment: ${md(trace.environment.id)} / ${md(trace.environment.signature)}`,
    `- Runner: ${md(trace.runner.runnerVersion)}`,
    `- Playwright: ${md(trace.runner.playwrightVersion)}`,
    `- Runner Image: ${md(trace.runner.imageReference)}@${md(trace.runner.imageDigest)}`,
    '',
    '| Agent | 配置版本 | 配置 Hash | 快照 Hash |',
    '|---|---:|---|---|',
    ...agentRows,
    '',
    '## Artifact',
    '',
    ...artifactMarkdown(report.nonPassedTasks),
    '',
  ].join('\n')
}

function reportListItem(run: ExecutionRun): TestReportListItem {
  return {
    runId: run.id,
    projectVersionId: run.projectVersionId,
    status: run.status,
    stateVersion: run.stateVersion,
    mode: run.handoff.mode,
    totalCases: run.taskCount,
    environment: {
      id: run.environment.environmentId,
      name: run.environment.name,
      signature: run.environment.signature,
    },
    createdAt: run.createdAt,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
  }
}

function normalizedSource(source: TestExecutionReportSource): TestExecutionReportSource {
  const tasks = structuredClone(source.tasks).sort(
    (left, right) => left.input.ordinal - right.input.ordinal || compare(left.id, right.id),
  )
  const taskOrdinal = new Map(tasks.map(task => [task.id, task.input.ordinal]))
  const attempts = structuredClone(source.attempts).sort((left, right) =>
    (taskOrdinal.get(left.taskId) ?? 0) - (taskOrdinal.get(right.taskId) ?? 0)
    || left.ordinal - right.ordinal
    || compare(left.id, right.id))
  const attemptOrdinal = new Map(attempts.map(attempt => [attempt.id, attempt.ordinal]))
  return {
    run: structuredClone(source.run),
    tasks,
    attempts,
    diagnoses: structuredClone(source.diagnoses).sort((left, right) =>
      (taskOrdinal.get(left.taskId) ?? 0) - (taskOrdinal.get(right.taskId) ?? 0)
      || compare(left.createdAt, right.createdAt)
      || compare(left.id, right.id)),
    scriptRevisions: structuredClone(source.scriptRevisions).sort((left, right) =>
      (taskOrdinal.get(left.taskId) ?? 0) - (taskOrdinal.get(right.taskId) ?? 0)
      || left.revision - right.revision
      || compare(left.id, right.id)),
    artifacts: structuredClone(source.artifacts).sort((left, right) =>
      (taskOrdinal.get(left.taskId ?? '') ?? -1) - (taskOrdinal.get(right.taskId ?? '') ?? -1)
      || (attemptOrdinal.get(left.attemptId ?? '') ?? -1) - (attemptOrdinal.get(right.attemptId ?? '') ?? -1)
      || compare(left.createdAt, right.createdAt)
      || compare(left.id, right.id)),
    maintenanceProposals: structuredClone(source.maintenanceProposals).sort((left, right) =>
      (taskOrdinal.get(left.taskId) ?? 0) - (taskOrdinal.get(right.taskId) ?? 0)
      || compare(left.createdAt, right.createdAt)
      || compare(left.id, right.id)),
    ...(source.testCaseLibraryVersionSourceRunId
      ? { testCaseLibraryVersionSourceRunId: source.testCaseLibraryVersionSourceRunId }
      : {}),
  }
}

function assertSourceConsistency(source: TestExecutionReportSource) {
  const { run, tasks, attempts, diagnoses, scriptRevisions, artifacts, maintenanceProposals } = source
  const taskIds = new Set(tasks.map(task => task.id))
  const taskById = new Map(tasks.map(task => [task.id, task]))
  const attemptIds = new Set(attempts.map(attempt => attempt.id))
  const revisionIds = new Set(scriptRevisions.map(revision => revision.id))
  const revisionById = new Map(scriptRevisions.map(revision => [revision.id, revision]))
  const diagnosisById = new Map(diagnoses.map(diagnosis => [diagnosis.id, diagnosis]))
  if (
    tasks.length !== run.taskCount
    || tasks.some(task => task.runId !== run.id)
    || attempts.some(attempt =>
      attempt.runId !== run.id
      || !taskIds.has(attempt.taskId)
      || !revisionIds.has(attempt.scriptRevisionId))
    || diagnoses.some(diagnosis =>
      diagnosis.runId !== run.id
      || !taskIds.has(diagnosis.taskId)
      || !revisionIds.has(diagnosis.scriptRevisionId)
      || diagnosis.attemptIds.some(id => !attemptIds.has(id)))
    || scriptRevisions.some(revision => revision.runId !== run.id || !taskIds.has(revision.taskId))
    || artifacts.some(artifact =>
      artifact.runId !== run.id
      || (artifact.taskId !== undefined && !taskIds.has(artifact.taskId))
      || (artifact.attemptId !== undefined && !attemptIds.has(artifact.attemptId)))
    || maintenanceProposals.some(proposal => {
      const task = taskById.get(proposal.taskId)
      const diagnosis = diagnosisById.get(proposal.diagnosisId)
      const revision = revisionById.get(proposal.scriptRevisionId)
      const original = diagnosis
        ? revisionById.get(diagnosis.scriptRevisionId)
        : undefined
      const postRepairAttempt = attempts.find(attempt =>
        attempt.runId === run.id
        && attempt.taskId === proposal.taskId
        && attempt.scriptRevisionId === proposal.scriptRevisionId
        && attempt.kind === 'post_repair'
        && attempt.status === 'passed')
      return proposal.runId !== run.id
        || !task
        || proposal.caseId !== task.input.caseId
        || proposal.caseRevision !== task.input.caseRevision
        || !diagnosis
        || diagnosis.runId !== run.id
        || diagnosis.taskId !== proposal.taskId
        || !['script_defect', 'selector_changed'].includes(diagnosis.category)
        || !revision
        || !original
        || revision.runId !== run.id
        || revision.taskId !== proposal.taskId
        || revision.source !== 'repair'
        || revision.parentRevisionId !== diagnosis.scriptRevisionId
        || revision.protectedAssertionSha256 !== original.protectedAssertionSha256
        || canonicalSha256(revision.package.assertions) !== canonicalSha256(original.package.assertions)
        || !postRepairAttempt
        || proposal.baselineLibraryVersionId !== run.handoff.testCaseLibraryVersionId
        || proposal.baselineLibraryVersionSha256 !== run.handoff.testCaseLibraryVersionSha256
    })
  ) throw new TestReportServiceError('TEST_REPORT_SOURCE_INVALID', '测试报告正式事实范围不一致', 409)
  if (
    tasks.reduce((sum, task) => sum + task.runnerAttemptCount, 0) !== attempts.length
    || tasks.reduce((sum, task) => sum + task.sameScriptRetryCount, 0)
      !== attempts.filter(attempt => attempt.kind === 'same_script_retry').length
    || tasks.reduce((sum, task) => sum + task.repairCount, 0)
      !== scriptRevisions.filter(revision => revision.source === 'repair').length
  ) throw new TestReportServiceError('TEST_REPORT_COUNTER_MISMATCH', '测试执行计数器与不可变历史不一致', 409)
}

function nonPassedTask(
  task: ExecutionTask,
  attempts: ExecutionAttempt[],
  diagnoses: FailureDiagnosis[],
  revisions: ScriptRevision[],
  artifacts: ExecutionArtifact[],
  attemptById: Map<string, ExecutionAttempt>,
): TestReportNonPassedTask {
  const latestDiagnosis = diagnoses.slice().sort((left, right) =>
    diagnosisAttemptOrdinal(right, attemptById) - diagnosisAttemptOrdinal(left, attemptById)
    || compare(right.createdAt, left.createdAt)
    || compare(right.id, left.id))[0]
  return {
    taskId: task.id,
    ordinal: task.input.ordinal,
    caseId: task.input.caseId,
    caseRevision: task.input.caseRevision,
    title: task.input.caseContent.title,
    method: task.input.method,
    dimension: task.input.dimension,
    status: task.status,
    terminal: terminalTaskStatuses.has(task.status),
    diagnosis: latestDiagnosis
      ? {
          id: latestDiagnosis.id,
          category: latestDiagnosis.category,
          confidence: latestDiagnosis.confidence,
          summary: latestDiagnosis.summary,
          repairable: latestDiagnosis.repairable,
          recommendedAction: latestDiagnosis.recommendedAction,
          source: latestDiagnosis.source,
          createdAt: latestDiagnosis.createdAt,
        }
      : null,
    attemptCount: attempts.length,
    scriptRevisionCount: revisions.length,
    artifacts: artifacts.map(artifact => ({
      id: artifact.id,
      ...(artifact.attemptId ? { attemptId: artifact.attemptId } : {}),
      type: artifact.type,
      sha256: artifact.sha256,
      size: artifact.size,
      mimeType: artifact.mimeType,
      createdAt: artifact.createdAt,
    })),
  }
}

function reportStatisticsAt(source: TestExecutionReportSource) {
  const values = [
    source.run.createdAt,
    source.run.startedAt,
    source.run.finishedAt,
    source.run.cancelRequestedAt,
    ...source.tasks.flatMap(task => [task.createdAt, task.updatedAt, task.finishedAt]),
    ...source.attempts.flatMap(attempt => [attempt.startedAt, attempt.finishedAt]),
    ...source.diagnoses.map(diagnosis => diagnosis.createdAt),
    ...source.scriptRevisions.map(revision => revision.createdAt),
    ...source.artifacts.map(artifact => artifact.createdAt),
    ...source.maintenanceProposals.flatMap(proposal => [
      proposal.createdAt,
      proposal.decidedAt,
    ]),
  ].filter((value): value is string => Boolean(value))
  const timestamp = Math.max(...values.map(value => Date.parse(value)))
  if (!Number.isFinite(timestamp)) {
    throw new TestReportServiceError('TEST_REPORT_TIMESTAMP_INVALID', '测试报告时间戳无效', 409)
  }
  return new Date(timestamp).toISOString()
}

function runDuration(run: ExecutionRun, statisticsAt: string) {
  if (!run.startedAt) return 0
  const endpoint = run.finishedAt ?? statisticsAt
  const duration = Date.parse(endpoint) - Date.parse(run.startedAt)
  return Number.isFinite(duration) ? Math.max(0, duration) : 0
}

function percentile(values: number[], point: number) {
  if (!values.length) return null
  return values[Math.ceil(point * values.length) - 1]
}

function diagnosisAttemptOrdinal(
  diagnosis: FailureDiagnosis,
  attemptById: Map<string, ExecutionAttempt>,
) {
  return Math.max(...diagnosis.attemptIds.map(id => attemptById.get(id)?.ordinal ?? -1))
}

function agentTraceability(agent: FrozenExecutionAgentSnapshot): TestReportAgentTraceability {
  return {
    agentKey: agent.agentKey,
    configurationId: agent.configurationId,
    configurationVersion: agent.configurationVersion,
    configurationSha256: agent.configurationSha256,
    definitionSha256: agent.definitionSha256,
    snapshotSha256: agent.snapshotSha256,
  }
}

function artifactMarkdown(tasks: TestReportNonPassedTask[]) {
  const rows = tasks.flatMap(task => task.artifacts.map(artifact =>
    `- ${md(task.caseId)}: ${md(artifact.type)} / ${md(artifact.id)} / ${md(artifact.sha256)} / ${artifact.size} bytes`))
  return rows.length ? rows : ['无 Artifact。']
}

function formatDuration(value: number | null) {
  return value === null ? '无样本' : `${value} ms`
}

function formatPercentage(value: number) {
  return `${value.toFixed(2)}%`
}

function md(value: unknown) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('\r', '')
    .replaceAll('\n', '<br>')
}

function rate(numerator: number, denominator: number): TestReportRate {
  return {
    numerator,
    denominator,
    percentage: percentage(numerator, denominator),
  }
}

function percentage(numerator: number, denominator: number) {
  return denominator ? round(numerator / denominator * 100, 2) : 0
}

function round(value: number, digits: number) {
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function grouped<T>(values: T[], key: (value: T) => string) {
  const result = new Map<string, T[]>()
  for (const value of values) {
    const groupKey = key(value)
    const group = result.get(groupKey) ?? []
    group.push(value)
    result.set(groupKey, group)
  }
  return result
}

function compare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function requiredIdentity(value: string, field: string) {
  const normalized = String(value ?? '').trim()
  if (!normalized || normalized.length > 500 || /[\u0000-\u001F\u007F]/u.test(normalized)) {
    throw new TestReportServiceError(
      'TEST_REPORT_IDENTITY_INVALID',
      `${field} 无效`,
      400,
    )
  }
  return normalized
}
