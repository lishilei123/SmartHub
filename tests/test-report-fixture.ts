import { canonicalSha256 } from '../server/application/canonical-json.js'
import type {
  ExecutionArtifact,
  CaseMaintenanceProposal,
  ExecutionAttempt,
  ExecutionPackageManifest,
  ExecutionRun,
  ExecutionTask,
  FailureDiagnosis,
  FrozenExecutionAgentSnapshot,
  ScriptRevision,
} from '../server/domain/test-execution-types.js'
import type { TestCaseContent } from '../server/domain/test-design-types.js'
import type { TestExecutionReportSource } from '../server/infrastructure/test-execution-store.js'

function agent(agentKey: FrozenExecutionAgentSnapshot['agentKey']): FrozenExecutionAgentSnapshot {
  const base = {
    agentKey,
    configurationId: `${agentKey}-configuration`,
    configurationVersion: 3,
    configurationSha256: canonicalSha256({ agentKey, configurationVersion: 3 }),
    definitionSha256: canonicalSha256({ agentKey, definitionVersion: 2 }),
    model: {
      sourceId: 'source-1',
      modelId: 'model-1',
      providerType: 'anthropic' as const,
      modelName: 'claude-sonnet-5',
      baseUrlSha256: canonicalSha256('https://example.invalid'),
      contextWindow: 200_000,
      maxOutputTokens: 8_000,
      supportsReasoning: true,
      requestTimeoutMs: 30_000,
      retryCount: 1,
    },
  }
  return { ...base, snapshotSha256: canonicalSha256(base) }
}

const agents = {
  executionImplementation: agent('execution-implementation'),
  failureAnalysis: agent('failure-analysis'),
}

function task(
  ordinal: number,
  status: ExecutionTask['status'],
  counters: Pick<ExecutionTask, 'runnerAttemptCount' | 'sameScriptRetryCount' | 'repairCount'>,
  title = `报告用例 ${ordinal}`,
): ExecutionTask {
  const caseContent: TestCaseContent = {
    schemaVersion: 'test-case/v3',
    title,
    dimension: 'functional',
    requirementRefs: [`REQ-${ordinal}`],
    priority: 'P1',
    preconditions: [],
    executionMethods: ['ui'],
    steps: [`打开报告用例 ${ordinal} 页面`],
    expectedResults: ['内容可见'],
  }
  const executionSpec = { schemaVersion: 'test-script-input/v1' as const, method: 'ui' as const, testCase: caseContent }
  const executionSpecSha256 = canonicalSha256(executionSpec)
  const inputBase = {
    sourceVersionId: 'library-version-1',
    ordinal,
    dedupKey: `case-${ordinal}:1:ui`,
    stage: 'full',
    caseId: `case-${ordinal}`,
    caseRevision: 1,
    caseContent,
    caseContentSha256: canonicalSha256(caseContent),
    method: 'ui' as const,
    dimension: 'functional' as const,
    executionSpec,
    executionSpecSha256,
  }
  const id = `task-${ordinal}`
  return {
    id,
    runId: 'run-report-1',
    input: { ...inputBase, inputSha256: canonicalSha256(inputBase) },
    status,
    stateVersion: ordinal,
    ...counters,
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: `2026-08-14T00:00:${String(ordinal + 10).padStart(2, '0')}.000Z`,
    ...(['passed', 'failed', 'blocked', 'unsupported', 'waiting_manual', 'cancelled'].includes(status)
      ? { finishedAt: `2026-08-14T00:00:${String(ordinal + 10).padStart(2, '0')}.000Z` }
      : {}),
  }
}

function manifest(taskValue: ExecutionTask, revision: number): ExecutionPackageManifest {
  const base = {
    schemaVersion: 'execution-package/v1' as const,
    taskId: taskValue.id,
    caseId: taskValue.input.caseId,
    caseRevision: taskValue.input.caseRevision,
    method: 'ui' as const,
    entrypoint: `tests/${taskValue.id}.spec.ts`,
    taskInputSha256: taskValue.input.inputSha256,
    caseContentSha256: taskValue.input.caseContentSha256,
    executionSpecSha256: taskValue.input.executionSpecSha256,
    environmentSignature: 'e'.repeat(64),
    files: [{
      path: `tests/${taskValue.id}.spec.ts`,
      contentSha256: canonicalSha256({ taskId: taskValue.id, revision }),
      size: 120 + revision,
    }],
    assertions: [],
    protectedAssertionSha256: canonicalSha256([]),
  }
  return { ...base, packageSha256: canonicalSha256(base) }
}

function revision(taskValue: ExecutionTask, number: number, source: ScriptRevision['source']): ScriptRevision {
  const packageValue = manifest(taskValue, number)
  return {
    id: `${taskValue.id}-revision-${number}`,
    runId: taskValue.runId,
    taskId: taskValue.id,
    scriptArtifactId: `${taskValue.id}-script`,
    revision: number,
    ...(number > 1 ? { parentRevisionId: `${taskValue.id}-revision-${number - 1}` } : {}),
    source,
    ...(source === 'repair' ? { repairReason: '修复失败定位器' } : {}),
    generatedBy: agents.executionImplementation,
    package: packageValue,
    sourceArtifacts: [{
      path: packageValue.entrypoint,
      artifactId: `${taskValue.id}-source-${number}`,
    }],
    sourceArtifactId: `${taskValue.id}-source-${number}`,
    contentSha256: packageValue.files[0].contentSha256,
    protectedAssertionSha256: packageValue.protectedAssertionSha256,
    createdAt: `2026-08-14T00:00:${String(number + taskValue.input.ordinal).padStart(2, '0')}.000Z`,
  }
}

function attempt(
  taskValue: ExecutionTask,
  ordinal: number,
  kind: ExecutionAttempt['kind'],
  revisionNumber: number,
  status: ExecutionAttempt['status'],
  durationMs?: number,
): ExecutionAttempt {
  const revisionId = `${taskValue.id}-revision-${revisionNumber}`
  const startedSecond = taskValue.input.ordinal + ordinal * 2
  return {
    id: `${taskValue.id}-attempt-${ordinal}`,
    runId: taskValue.runId,
    taskId: taskValue.id,
    ordinal,
    invocationKey: `${taskValue.id}-invocation-${ordinal}`,
    kind,
    scriptRevisionId: revisionId,
    packageSha256: manifest(taskValue, revisionNumber).packageSha256,
    status,
    startedAt: `2026-08-14T00:00:${String(startedSecond).padStart(2, '0')}.000Z`,
    ...(status !== 'running'
      ? {
          finishedAt: `2026-08-14T00:00:${String(startedSecond + 1).padStart(2, '0')}.000Z`,
          ...(durationMs === undefined ? {} : { durationMs }),
        }
      : {}),
  }
}

function diagnosis(
  taskValue: ExecutionTask,
  id: string,
  category: FailureDiagnosis['category'],
  attemptIds: string[],
  createdAt: string,
  summary: string,
): FailureDiagnosis {
  return {
    id,
    runId: taskValue.runId,
    taskId: taskValue.id,
    scriptRevisionId: `${taskValue.id}-revision-1`,
    attemptIds,
    category,
    confidence: 0.82,
    summary,
    evidence: attemptIds.map(attemptId => ({ attemptId, observation: '正式执行证据' })),
    repairable: category !== 'product_defect',
    recommendedAction: category === 'product_defect' ? '提交产品缺陷' : '检查并重试',
    source: category === 'flaky' ? 'deterministic' : 'agent',
    createdAt,
  }
}

export function reportSourceFixture(): TestExecutionReportSource {
  const tasks = [
    task(1, 'passed', { runnerAttemptCount: 1, sameScriptRetryCount: 0, repairCount: 0 }),
    task(2, 'passed', { runnerAttemptCount: 2, sameScriptRetryCount: 1, repairCount: 0 }),
    task(3, 'passed', { runnerAttemptCount: 2, sameScriptRetryCount: 0, repairCount: 1 }),
    task(4, 'failed', { runnerAttemptCount: 1, sameScriptRetryCount: 0, repairCount: 1 }, '失败 | <script>\n路径\\名称'),
    task(5, 'running', { runnerAttemptCount: 1, sameScriptRetryCount: 0, repairCount: 1 }),
    task(6, 'blocked', { runnerAttemptCount: 1, sameScriptRetryCount: 0, repairCount: 0 }),
    task(7, 'unsupported', { runnerAttemptCount: 0, sameScriptRetryCount: 0, repairCount: 0 }),
    task(8, 'cancelled', { runnerAttemptCount: 1, sameScriptRetryCount: 0, repairCount: 0 }),
    task(9, 'waiting_manual', { runnerAttemptCount: 1, sameScriptRetryCount: 0, repairCount: 0 }),
  ]
  const byOrdinal = new Map(tasks.map(value => [value.input.ordinal, value]))
  const requiredTask = (ordinal: number) => {
    const value = byOrdinal.get(ordinal)
    if (!value) throw new Error(`缺少 Task ${ordinal}`)
    return value
  }
  const scriptRevisions = tasks.flatMap(taskValue => {
    if (taskValue.status === 'unsupported') return []
    const initial = revision(taskValue, 1, 'agent')
    return taskValue.repairCount ? [initial, revision(taskValue, 2, 'repair')] : [initial]
  })
  const attempts = [
    attempt(requiredTask(1), 1, 'initial', 1, 'passed', 100),
    attempt(requiredTask(2), 1, 'initial', 1, 'failed', 200),
    attempt(requiredTask(2), 2, 'same_script_retry', 1, 'passed', 300),
    attempt(requiredTask(3), 1, 'initial', 1, 'failed', 400),
    attempt(requiredTask(3), 2, 'post_repair', 2, 'passed', 500),
    attempt(requiredTask(4), 1, 'initial', 1, 'failed', 600),
    attempt(requiredTask(5), 1, 'post_repair', 2, 'running'),
    attempt(requiredTask(6), 1, 'initial', 1, 'infrastructure_error', 700),
    attempt(requiredTask(8), 1, 'initial', 1, 'cancelled', 800),
    attempt(requiredTask(9), 1, 'initial', 1, 'failed', 900),
  ]
  const diagnoses = [
    diagnosis(requiredTask(2), 'diagnosis-flaky', 'flaky', ['task-2-attempt-1', 'task-2-attempt-2'], '2026-08-14T00:00:12.000Z', '同一脚本重试后通过'),
    diagnosis(requiredTask(3), 'diagnosis-script-defect', 'script_defect', ['task-3-attempt-1'], '2026-08-14T00:00:13.000Z', '定位器脚本缺陷已由修复脚本验证'),
    diagnosis(requiredTask(4), 'diagnosis-product', 'product_defect', ['task-4-attempt-1'], '2026-08-14T00:00:13.000Z', '旧产品诊断'),
    diagnosis(requiredTask(4), 'diagnosis-timeout', 'timeout', ['task-4-attempt-1'], '2026-08-14T00:00:14.000Z', '最新超时诊断'),
  ]
  const maintenanceProposals: CaseMaintenanceProposal[] = [{
    id: 'maintenance-proposal-1',
    runId: 'run-report-1',
    taskId: 'task-3',
    caseId: 'case-3',
    caseRevision: 1,
    diagnosisId: 'diagnosis-script-defect',
    scriptRevisionId: 'task-3-revision-2',
    status: 'pending',
    summary: '修复脚本通过真实 Runner，建议人工维护 selector',
    proposedChange: '仅人工比较 Script Revision 并维护 selector；不得修改 Expected Result、Verification Check、matcher、Requirement 或业务语义。',
    baselineLibraryVersionId: 'library-version-1',
    baselineLibraryVersionSha256: 'c'.repeat(64),
    createdAt: '2026-08-14T00:00:26.000Z',
  }]
  const artifacts: ExecutionArtifact[] = [{
    id: 'artifact-private-path',
    runId: 'run-report-1',
    taskId: 'task-4',
    attemptId: 'task-4-attempt-1',
    type: 'trace',
    storagePath: 'private/objects/never-expose.zip',
    sha256: 'a'.repeat(64),
    size: 2_048,
    mimeType: 'application/zip',
    createdAt: '2026-08-14T00:00:25.000Z',
  }]
  const run: ExecutionRun = {
    id: 'run-report-1',
    projectId: 'project-1',
    projectVersionId: 'pv-1',
    handoff: {
      handoffId: 'handoff-1',
      handoffSha256: 'b'.repeat(64),
      projectId: 'project-1',
      projectVersionId: 'pv-1',
      testCaseLibraryVersionId: 'library-version-1',
      testCaseLibraryVersionSha256: 'c'.repeat(64),
      suiteVersionId: 'suite-version-1',
      suiteVersionSha256: 'd'.repeat(64),
      mode: 'full',
      memberSnapshotSha256: canonicalSha256(tasks.map(value => value.input)),
    },
    environment: {
      environmentId: 'environment-1',
      name: '报告测试环境',
      baseUrl: 'https://example.test',
      targets: [{ protocol: 'https', host: 'example.test', port: 443 }],
      signature: 'e'.repeat(64),
    },
    runner: {
      runnerVersion: '1.2.3',
      playwrightVersion: '1.58.2',
      imageReference: 'registry.example/smarthub/runner',
      imageDigest: `sha256:${'f'.repeat(64)}`,
    },
    agents,
    status: 'running',
    stateVersion: 12,
    idempotencyKey: 'report-fixture',
    taskCount: tasks.length,
    createdBy: 'tester',
    createdAt: '2026-08-13T23:59:59.000Z',
    startedAt: '2026-08-14T00:00:00.000Z',
  }
  return {
    run,
    tasks,
    attempts,
    diagnoses,
    scriptRevisions,
    maintenanceProposals,
    artifacts,
    testCaseLibraryVersionSourceRunId: 'design-run-1',
  }
}

export function reportSourceReader(source = reportSourceFixture()) {
  return {
    async listRuns(projectVersionId: string, limit: number) {
      return source.run.projectVersionId === projectVersionId ? [source.run].slice(0, limit) : []
    },
    async getRun(runId: string) {
      return source.run.id === runId ? source.run : null
    },
    async getRunReportSource(runId: string) {
      return source.run.id === runId ? structuredClone(source) : null
    },
  }
}
