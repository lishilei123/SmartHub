import { createHash } from 'node:crypto'
import { canonicalJson, canonicalSha256 } from './canonical-json.js'
import type { AgentTestExecutionReport, AgentTestExecutionReportContent, TestReportListItem, TestReportRate } from '../domain/test-report-types.js'
import type { ExecutionRun } from '../domain/test-execution-types.js'
import type { AgentExecutionAggregateResult, AgentTokenUsage } from '../domain/agent-test-types.js'
import type { TestExecutionReportSource, TestExecutionReportSourceReader } from '../infrastructure/test-execution-store.js'

export class TestReportServiceError extends Error { constructor(readonly code: string, message: string, readonly status = 400, readonly details?: unknown) { super(message) } }
export class TestReportService {
  constructor(private readonly sourceReader: TestExecutionReportSourceReader) {}
  async getRun(runId: string) { return required(await this.sourceReader.getRun(runId)) }
  async listReports(projectVersionId: string, limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TestReportServiceError('TEST_REPORT_LIMIT_INVALID', 'limit 必须是 1 到 200 的整数', 400)
    const runs = await this.sourceReader.listRuns(projectVersionId, limit)
    return { items: runs.map(reportListItem) }
  }
  async getReport(runId: string) {
    const source = await this.sourceReader.getRunReportSource(runId)
    if (!source) throw new TestReportServiceError('TEST_REPORT_RUN_NOT_FOUND', '测试报告对应的执行 Run 不存在', 404)
    return buildReport(source)
  }
  async exportJson(runId: string) { const report = await this.getReport(runId); return { report, body: `${canonicalJson(report)}\n` } }
  async exportMarkdown(runId: string) { const report = await this.getReport(runId); const body = markdown(report); return { report, body, sha256: createHash('sha256').update(body).digest('hex') } }
}

function reportListItem(run: ExecutionRun): TestReportListItem { return { runId: run.id, projectVersionId: run.projectVersionId, status: run.status, stateVersion: run.stateVersion, mode: run.handoff.mode, totalCases: run.taskCount, agentUnderTest: { id: run.agentUnderTest.id, name: run.agentUnderTest.name, version: run.agentUnderTest.version, protocol: run.agentUnderTest.protocol }, createdAt: run.createdAt, ...(run.startedAt ? { startedAt: run.startedAt } : {}), ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}) } }
function buildReport(source: TestExecutionReportSource): AgentTestExecutionReport {
  const results = structuredClone(source.agentExecutionResults).sort((a, b) => a.taskId.localeCompare(b.taskId))
  const statuses = results.map(item => item.status)
  const active = source.tasks.filter(item => item.status === 'pending' || item.status === 'running').length
  const caseRuns = results.flatMap(item => item.caseRuns)
  const executionAttempts = structuredClone(source.agentExecutionAttempts).sort((a, b) => a.taskId.localeCompare(b.taskId) || a.executionAttemptOrdinal - b.executionAttemptOrdinal)
  const content: AgentTestExecutionReportContent = {
    schemaVersion: 'agent-test-execution-report/v2', statisticsAt: statisticsAt(source),
    run: { id: source.run.id, status: source.run.status, stateVersion: source.run.stateVersion, mode: source.run.handoff.mode, createdAt: source.run.createdAt, ...(source.run.startedAt ? { startedAt: source.run.startedAt } : {}), ...(source.run.finishedAt ? { finishedAt: source.run.finishedAt } : {}) },
    overview: {
      totalCases: source.tasks.length, passed: statuses.filter(value => value === 'PASS').length, failed: statuses.filter(value => value === 'FAIL').length,
      notEvaluable: statuses.filter(value => value === 'NOT_EVALUABLE').length, error: statuses.filter(value => value === 'ERROR').length, active,
      successRate: rate(statuses.filter(value => value === 'PASS').length, results.length), executionAttemptCount: executionAttempts.length, caseRunCount: caseRuns.length,
      averageLatencyMs: caseRuns.length ? caseRuns.reduce((sum, item) => sum + item.latencyMs, 0) / caseRuns.length : null,
      ...aggregateUsage(results),
    },
    results,
    executionAttempts,
    traceability: {
      projectId: source.run.projectId, projectVersionId: source.run.projectVersionId, runId: source.run.id, runStateVersion: source.run.stateVersion,
      handoff: { id: source.run.handoff.handoffId, sha256: source.run.handoff.handoffSha256, memberSnapshotSha256: source.run.handoff.memberSnapshotSha256 },
      testCaseLibraryVersion: { id: source.run.handoff.testCaseLibraryVersionId, sha256: source.run.handoff.testCaseLibraryVersionSha256 },
      ...(source.run.handoff.suiteVersionId && source.run.handoff.suiteVersionSha256 ? { testSuiteVersion: { id: source.run.handoff.suiteVersionId, sha256: source.run.handoff.suiteVersionSha256 } } : {}),
      agentUnderTest: structuredClone(source.run.agentUnderTest), runner: source.run.runner,
      agents: { failureAnalysis: { agentKey: source.run.agents.failureAnalysis.agentKey, configurationId: source.run.agents.failureAnalysis.configurationId, configurationVersion: source.run.agents.failureAnalysis.configurationVersion, configurationSha256: source.run.agents.failureAnalysis.configurationSha256, definitionSha256: source.run.agents.failureAnalysis.definitionSha256, snapshotSha256: source.run.agents.failureAnalysis.snapshotSha256 } },
    },
  }
  return { ...content, reportSha256: canonicalSha256(content) }
}
function aggregateUsage(results: AgentExecutionAggregateResult[]) {
  const usages = results.map(item => item.tokenUsage).filter((item): item is AgentTokenUsage => Boolean(item))
  const tokenUsage = usages.length ? { inputTokens: sumOptional(usages.map(item => item.inputTokens)), outputTokens: sumOptional(usages.map(item => item.outputTokens)), totalTokens: sumOptional(usages.map(item => item.totalTokens)) } : undefined
  const costs = results.map(item => item.cost).filter((item): item is number => typeof item === 'number')
  return { ...(tokenUsage ? { tokenUsage } : {}), ...(costs.length ? { cost: costs.reduce((sum, value) => sum + value, 0) } : {}) }
}
function sumOptional(values: Array<number | undefined>) { const present = values.filter((item): item is number => typeof item === 'number'); return present.length ? present.reduce((sum, item) => sum + item, 0) : undefined }
function rate(numerator: number, denominator: number): TestReportRate { return { numerator, denominator, percentage: denominator ? numerator / denominator * 100 : 0 } }
function statisticsAt(source: TestExecutionReportSource) { return [...source.tasks.map(item => item.updatedAt), ...source.agentExecutionAttempts.map(item => item.createdAt), source.run.finishedAt ?? source.run.startedAt ?? source.run.createdAt].sort().at(-1)! }
function markdown(report: AgentTestExecutionReport) {
  return [
    '# Agent Test Execution Report', '',
    `- Run: ${report.run.id}`,
    `- Status: ${report.run.status}`,
    `- Agent Under Test: ${report.traceability.agentUnderTest.name} v${report.traceability.agentUnderTest.version}`,
    `- Report SHA-256: ${report.reportSha256}`, '',
    '## Overview', '',
    `- Cases: ${report.overview.totalCases}`,
    `- Execution attempts: ${report.overview.executionAttemptCount}`,
    `- PASS: ${report.overview.passed}`,
    `- FAIL: ${report.overview.failed}`,
    `- NOT_EVALUABLE: ${report.overview.notEvaluable}`,
    `- ERROR: ${report.overview.error}`,
    `- Success rate: ${report.overview.successRate.percentage.toFixed(2)}%`, '',
    '## Latest Results', '',
    ...report.results.map(item => `- ${item.taskId}: ${item.status} (attempt ${item.executionAttemptOrdinal}, ${item.caseRuns.length} repeats)`), '',
    '## Attempt History', '',
    ...report.executionAttempts.map(item => `- ${item.taskId} / attempt ${item.executionAttemptOrdinal}: ${item.status} (${item.caseRuns.length} repeats)`), '',
  ].join('\n')
}
function required(run: ExecutionRun | null) { if (!run) throw new TestReportServiceError('TEST_REPORT_RUN_NOT_FOUND', '测试报告对应的执行 Run 不存在', 404); return run }
