import type { InputDeliveryManifest, TestExecutionAgentWorkspaceProjection } from '../domain/agent-types.js'
import type { AgentEvaluationResult, AgentExecutionAggregateResult } from '../domain/agent-test-types.js'
import type {
  ExecutionJob,
  ExecutionRun,
  ExecutionTask,
} from '../domain/test-execution-types.js'
import type { TestCaseLibraryVersionDetail, TestExecutionHandoff } from '../domain/test-design-types.js'
import type { TestExecutionAgentRuntimeInput, TestExecutionAgentRuntimeOutput } from '../agent/pi-test-execution-runtime.js'
import type { ExecutionJobLease, TestExecutionStore, TestExecutionTransaction } from '../infrastructure/test-execution-store.js'
import type { AgentRunner } from '../runner/agent-runner.js'
import type { AgentUnderTestService } from './agent-under-test-service.js'
import { canonicalSha256 } from './canonical-json.js'
import {
  freezeExecutionTaskInput,
  validateFailureDiagnosisCandidate,
} from './test-execution-validation.js'

export interface ImmutableTestExecutionSourceReader {
  getCurrentLibraryVersion(projectVersionId: string): Promise<TestCaseLibraryVersionDetail>
  createDefaultExecutionHandoff(projectVersionId: string, libraryVersionId: string, expectedLibrarySha256: string, createdBy: string): Promise<TestExecutionHandoff>
}

export interface TestExecutionKnowledgeResolver {
  resolveSnapshot(projectId: string): Promise<ExecutionRun['knowledge']>
}

export interface TestExecutionWorkspaceProvider {
  project(input: { run: ExecutionRun; task: ExecutionTask }): Promise<TestExecutionAgentWorkspaceProjection>
}

export interface TestExecutionAgentRuntime {
  readiness(): Promise<{ ready: boolean; agents: Array<{ agentKey: string; ready: boolean; reason?: string }> }>
  freezeConfiguration(): Promise<ExecutionRun['agents']>
  execute(input: TestExecutionAgentRuntimeInput, signal: AbortSignal): Promise<TestExecutionAgentRuntimeOutput>
}

export type CreateTestExecutionRunInput = {
  projectVersionId: string
  agentUnderTestId: string
  idempotencyKey: string
  createdBy: string
}

export class TestExecutionServiceError extends Error {
  constructor(readonly code: string, message: string, readonly status = 422, readonly details?: unknown) { super(message) }
}

export class AgentTestExecutionRuntimeError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options) }
}

export class TestExecutionService {
  constructor(
    private readonly sources: ImmutableTestExecutionSourceReader,
    private readonly store: TestExecutionStore,
    private readonly agentRuntime: TestExecutionAgentRuntime,
    private readonly workspaceProvider: TestExecutionWorkspaceProvider,
    private readonly agentUnderTestService: AgentUnderTestService,
    private readonly agentRunner: AgentRunner,
    private readonly knowledgeResolver?: TestExecutionKnowledgeResolver,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async readiness() {
    const [store, worker, agents] = await Promise.all([this.store.readiness(), this.store.workerReadiness(), this.agentRuntime.readiness()])
    const failureAnalysis = agents.agents.find(item => item.agentKey === 'failure-analysis')
    return {
      ready: store.ready && worker.ready && agents.ready && Boolean(failureAnalysis?.ready),
      store,
      worker,
      agents,
      runner: { ready: true, snapshot: { kind: 'agent' as const, runnerVersion: 'agent-runner/v2' as const } },
      agent: { ready: store.ready && Boolean(failureAnalysis?.ready), reason: store.reason ?? failureAnalysis?.reason },
    }
  }

  async listRuns(projectVersionId: string, limit = 50) {
    requiredIdentity(projectVersionId, 'projectVersionId')
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TestExecutionServiceError('TEST_EXECUTION_LIMIT_INVALID', 'limit 必须是 1 到 200 的整数', 400)
    return this.store.listRuns(projectVersionId, limit)
  }

  async getRun(runId: string) {
    return required(await this.store.getRun(requiredIdentity(runId, 'runId')), 'TEST_EXECUTION_RUN_NOT_FOUND', '测试执行 Run 不存在', 404)
  }

  async listTasks(runId: string) {
    await this.getRun(runId)
    return this.store.listTasks(runId)
  }

  async getTask(taskId: string) {
    return required(await this.store.getTask(requiredIdentity(taskId, 'taskId')), 'TEST_EXECUTION_TASK_NOT_FOUND', '测试执行 Task 不存在', 404)
  }

  async taskDetail(taskId: string) {
    return required(await this.store.getTaskDetail(requiredIdentity(taskId, 'taskId')), 'TEST_EXECUTION_TASK_NOT_FOUND', '测试执行 Task 不存在', 404)
  }

  async cancelRun(runId: string, expectedStateVersion: number) {
    const run = await this.getRun(runId)
    requireStateVersion(expectedStateVersion, 'Run')
    try { return await this.store.cancelRun(run.id, expectedStateVersion, this.clock()) }
    catch (error) { throw storeCommandError(error) }
  }

  async retryTask(input: {
    taskId: string
    expectedTaskStateVersion: number
    expectedRunStateVersion: number
    idempotencyKey: string
    requestedBy: string
  }) {
    const task = await this.getTask(input.taskId)
    const run = await this.getRun(task.runId)
    const idempotencyKey = requiredIdentity(input.idempotencyKey, 'idempotencyKey')
    const requestedBy = requiredIdentity(input.requestedBy, 'requestedBy')
    requireStateVersion(input.expectedTaskStateVersion, 'Task')
    requireStateVersion(input.expectedRunStateVersion, 'Run')
    const requestedAt = this.clock()
    const job: ExecutionJob = {
      id: stableIdentity('agent_test_manual_retry_job', { taskId: task.id, idempotencyKey }),
      runId: run.id,
      taskId: task.id,
      executionAttemptOrdinal: ((await this.store.getAgentExecutionResult(task.id))?.executionAttemptOrdinal ?? 0) + 1,
      status: 'queued',
      attempts: 0,
      maxAttempts: 3,
      availableAt: requestedAt,
      fencingToken: 0,
      request: { kind: 'manual_retry', idempotencyKey, requestedBy },
      createdAt: requestedAt,
      updatedAt: requestedAt,
    }
    try {
      return await this.store.retryTask({
        runId: run.id,
        taskId: task.id,
        expectedRunStateVersion: input.expectedRunStateVersion,
        expectedTaskStateVersion: input.expectedTaskStateVersion,
        job,
      })
    } catch (error) { throw storeCommandError(error) }
  }

  async createRun(input: CreateTestExecutionRunInput) {
    const projectVersionId = requiredIdentity(input.projectVersionId, 'projectVersionId')
    const agentUnderTestId = requiredIdentity(input.agentUnderTestId, 'agentUnderTestId')
    const idempotencyKey = requiredIdentity(input.idempotencyKey, 'idempotencyKey')
    const createdBy = requiredIdentity(input.createdBy, 'createdBy')
    const replay = await this.store.getRunByIdempotencyKey(projectVersionId, idempotencyKey)
    if (replay) {
      if (replay.agentUnderTest.id !== agentUnderTestId || replay.createdBy !== createdBy) {
        throw new TestExecutionServiceError('TEST_EXECUTION_IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于不同的 Agent Test 请求', 409)
      }
      return replay
    }

    const library = await this.sources.getCurrentLibraryVersion(projectVersionId)
    validateLibraryVersion(library, projectVersionId)
    const handoff = validateHandoff(await this.sources.createDefaultExecutionHandoff(
      projectVersionId,
      library.id,
      library.contentSha256,
      createdBy,
    ), projectVersionId)
    if (handoff.testCaseLibraryVersionId !== library.id || handoff.mode !== 'full' || handoff.suiteVersionId) {
      throw new TestExecutionServiceError('TEST_EXECUTION_SCOPE_INVALID', 'Agent Test Run 只支持当前正式用例库的全部用例')
    }
    const libraryMembers = new Map(library.members.map(member => [caseRevisionKey(member.caseId, member.revision), member]))
    const frozenInputs = handoff.members.slice().sort((left, right) => left.ordinal - right.ordinal).map(member => freezeExecutionTaskInput({
      handoffMember: member,
      libraryMember: required(
        libraryMembers.get(caseRevisionKey(member.caseId, member.revision)),
        'TEST_EXECUTION_HANDOFF_LIBRARY_MEMBER_NOT_FOUND',
        `Handoff 成员 ${member.caseId}@${member.revision} 不属于固定用例库版本`,
      ),
    }))
    if (!frozenInputs.length) throw new TestExecutionServiceError('TEST_EXECUTION_HANDOFF_EMPTY', '执行交接必须包含至少一个冻结 Agent Test')
    if (new Set(frozenInputs.map(item => item.ordinal)).size !== frozenInputs.length || new Set(frozenInputs.map(item => item.dedupKey)).size !== frozenInputs.length) {
      throw new TestExecutionServiceError('TEST_EXECUTION_HANDOFF_MEMBER_DUPLICATE', '执行交接包含重复 ordinal 或 dedupKey')
    }

    const [agentUnderTest, agents, knowledge] = await Promise.all([
      this.agentUnderTestService.freeze(projectVersionId, agentUnderTestId),
      this.agentRuntime.freezeConfiguration(),
      this.knowledgeResolver?.resolveSnapshot(handoff.projectId),
    ])
    assertAgentSnapshot(agents)
    const createdAt = this.clock()
    const runId = stableIdentity('agent_test_execution_run', { projectVersionId, idempotencyKey })
    const tasks: ExecutionTask[] = frozenInputs.map(frozenInput => ({
      id: stableIdentity('agent_test_execution_task', { runId, ordinal: frozenInput.ordinal, dedupKey: frozenInput.dedupKey }),
      runId,
      input: frozenInput,
      status: 'pending',
      stateVersion: 0,
      createdAt,
      updatedAt: createdAt,
    }))
    const run: ExecutionRun = {
      id: runId,
      projectId: handoff.projectId,
      projectVersionId,
      handoff: {
        handoffId: handoff.id,
        handoffSha256: handoff.contentSha256,
        projectId: handoff.projectId,
        projectVersionId,
        testCaseLibraryVersionId: library.id,
        testCaseLibraryVersionSha256: library.contentSha256,
        mode: handoff.mode,
        memberSnapshotSha256: canonicalSha256(frozenInputs),
      },
      agentUnderTest,
      ...(knowledge ? { knowledge: structuredClone(knowledge) } : {}),
      runner: { kind: 'agent', runnerVersion: 'agent-runner/v2' },
      agents: structuredClone(agents),
      status: 'queued',
      stateVersion: 0,
      idempotencyKey,
      taskCount: tasks.length,
      createdBy,
      createdAt,
    }
    const jobs: ExecutionJob[] = tasks.map(task => ({
      id: stableIdentity('agent_test_execution_job', { runId, taskId: task.id }),
      runId,
      taskId: task.id,
      executionAttemptOrdinal: 1,
      status: 'queued',
      attempts: 0,
      maxAttempts: 3,
      availableAt: createdAt,
      fencingToken: 0,
      createdAt,
      updatedAt: createdAt,
    }))
    return this.store.createAggregate({ run, tasks, jobs })
  }

  async processPreparedTask(job: ExecutionJob, lease: ExecutionJobLease, signal: AbortSignal): Promise<ExecutionTask> {
    if (signal.aborted) throw abortError(signal)
    const [run, task] = await Promise.all([this.store.getRun(job.runId), this.store.getTask(job.taskId)])
    if (!run || !task || task.runId !== run.id) throw new Error('TEST_EXECUTION_JOB_SCOPE_INVALID')
    if (terminalTaskStatus(task.status)) return task
    if (task.status === 'pending') {
      await requiredLeaseTransaction(this.store, job.id, lease, transaction => transaction.transitionTask({
        taskId: task.id,
        expectedStatus: 'pending',
        expectedStateVersion: task.stateVersion,
        status: 'running',
      }))
      return this.processPreparedTask(job, lease, signal)
    }
    if (task.status !== 'running') throw new AgentTestExecutionRuntimeError(`AGENT_TEST_TASK_STATE_INVALID: ${task.status}`)

    const spec = task.input.caseContent.agentTestSpec
    if (!spec || task.input.executionSpec.schemaVersion !== 'agent-test-input/v1') throw new AgentTestExecutionRuntimeError('AGENT_TEST_FROZEN_INPUT_INVALID')
    const resolvedVersion = await this.agentUnderTestService.resolveVersion(run.agentUnderTest)
    const runnerResult = await this.agentRunner.execute({ runId: run.id, taskId: task.id, executionAttemptOrdinal: job.executionAttemptOrdinal, agentUnderTest: run.agentUnderTest, resolvedVersion, spec }, signal)
    const executionResult = runnerResult.caseRuns.some(item => item.evaluationResults.length)
      ? await this.evaluateAgentSemantics(run, task, runnerResult, signal)
      : runnerResult
    const result = executionResult.status === 'FAIL' || executionResult.status === 'ERROR'
      ? await this.analyzeAgentFailure(run, task, executionResult, signal)
      : executionResult
    const status: ExecutionTask['status'] = result.status === 'PASS' ? 'passed' : result.status === 'NOT_EVALUABLE' ? 'blocked' : 'failed'
    const error = result.status === 'PASS' ? undefined : result.caseRuns.flatMap(item => item.failureFacts.map(fact => fact.code)).filter((value, index, values) => values.indexOf(value) === index).join(', ') || result.status
    return requiredLeaseTransaction(this.store, job.id, lease, async transaction => {
      await transaction.appendAgentExecutionResult(result)
      return transaction.transitionTask({
        taskId: task.id,
        expectedStatus: 'running',
        expectedStateVersion: task.stateVersion,
        status,
        ...(error ? { error } : {}),
        finishedAt: this.clock(),
      })
    })
  }

  async cleanupRunRuntimeState(_runId: string) {}

  private workspace(run: ExecutionRun, task: ExecutionTask) { return this.workspaceProvider.project({ run, task }) }

  private async evaluateAgentSemantics(run: ExecutionRun, task: ExecutionTask, result: AgentExecutionAggregateResult, signal: AbortSignal) {
    try {
      const output = await this.agentRuntime.execute({
        stage: 'agent_evaluation',
        run,
        task,
        workspace: await this.workspace(run, task),
        stageContext: { agentExecution: result },
        validateCandidate: candidateValidator(candidate => applyAgentEvaluationCandidate(result, candidate, run.agents.failureAnalysis.snapshotSha256)),
      }, signal)
      assertAgentOutputSchema(output, 'agent-evaluation/v1')
      return applyAgentEvaluationCandidate(result, output.candidate, run.agents.failureAnalysis.snapshotSha256)
    } catch (error) {
      return { ...result, evaluationError: error instanceof Error ? error.message : String(error) }
    }
  }

  private async analyzeAgentFailure(run: ExecutionRun, task: ExecutionTask, result: AgentExecutionAggregateResult, signal: AbortSignal) {
    try {
      const validate = (candidate: Record<string, unknown>) => validateFailureDiagnosisCandidate(candidate)
      const output = await this.agentRuntime.execute({
        stage: 'failure_diagnosis',
        run,
        task,
        workspace: await this.workspace(run, task),
        stageContext: { agentExecution: result },
        validateCandidate: candidateValidator(validate),
      }, signal)
      assertAgentOutputSchema(output, 'failure-analysis/v1')
      const candidate = validate(output.candidate)
      return {
        ...result,
        failureAnalysis: {
          category: candidate.category,
          reason: candidate.reason,
          evidence: candidate.evidence,
          source: 'agent' as const,
          agentSnapshotRef: run.agents.failureAnalysis.snapshotSha256,
        },
      }
    } catch (error) {
      return { ...result, failureAnalysisError: error instanceof Error ? error.message : String(error) }
    }
  }
}

function validateHandoff(handoff: TestExecutionHandoff, projectVersionId: string) {
  if (handoff.projectVersionId !== projectVersionId) throw new TestExecutionServiceError('TEST_EXECUTION_HANDOFF_SCOPE_MISMATCH', 'Execution Handoff 不属于目标项目版本', 404)
  const canonical = {
    projectId: handoff.projectId,
    projectVersionId: handoff.projectVersionId,
    testCaseLibraryVersionId: handoff.testCaseLibraryVersionId,
    ...(handoff.suiteVersionId ? { suiteVersionId: handoff.suiteVersionId } : {}),
    mode: handoff.mode,
    members: handoff.members,
  }
  if (canonicalSha256(canonical) !== handoff.contentSha256) throw new TestExecutionServiceError('TEST_EXECUTION_HANDOFF_CONTENT_HASH_MISMATCH', 'Execution Handoff 内容 Hash 无效')
  return handoff
}

function validateLibraryVersion(library: TestCaseLibraryVersionDetail, projectVersionId: string) {
  if (library.projectVersionId !== projectVersionId || !library.members.length || !library.sourceRunId) {
    throw new TestExecutionServiceError('TEST_EXECUTION_LIBRARY_VERSION_MISMATCH', '固定用例库版本与 Agent Test 执行交接不一致')
  }
  const canonical = { schemaVersion: 'test-case-library/v3', projectId: library.projectId, sourceRunId: library.sourceRunId, members: library.members }
  if (canonicalSha256(canonical) !== library.contentSha256) throw new TestExecutionServiceError('TEST_EXECUTION_LIBRARY_CONTENT_HASH_MISMATCH', '固定用例库版本内容 Hash 无效')
}

function assertAgentSnapshot(agents: ExecutionRun['agents']) {
  const { snapshotSha256, ...base } = agents.failureAnalysis
  if (agents.failureAnalysis.agentKey !== 'failure-analysis' || canonicalSha256(base) !== snapshotSha256) throw new Error('TEST_EXECUTION_AGENT_SNAPSHOT_INVALID')
}

function assertAgentOutputSchema(output: TestExecutionAgentRuntimeOutput, expected: TestExecutionAgentRuntimeOutput['schemaVersion']) {
  if (output.schemaVersion !== expected) throw new Error('TEST_EXECUTION_AGENT_OUTPUT_SCHEMA_MISMATCH')
}

export function applyAgentEvaluationCandidate(result: AgentExecutionAggregateResult, candidate: Record<string, unknown>, modelSnapshotRef: string): AgentExecutionAggregateResult {
  if (Object.keys(candidate).some(key => key !== 'results') || !Array.isArray(candidate.results)) throw new Error('AGENT_EVALUATION_CANDIDATE_INVALID')
  const expected = result.caseRuns.flatMap(caseRun => caseRun.evaluationResults.map(evaluation => ({ caseRun, evaluation })))
  if (candidate.results.length !== expected.length) throw new Error('AGENT_EVALUATION_RESULT_COUNT_MISMATCH')
  const remaining = [...expected]
  const replacements = new Map<string, AgentEvaluationResult>()
  for (const raw of candidate.results) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('AGENT_EVALUATION_RESULT_INVALID')
    const item = raw as Record<string, unknown>
    const allowed = new Set(['caseRunId', 'kind', 'criterion', 'status', 'explanation', 'evidenceRefs'])
    if (Object.keys(item).some(key => !allowed.has(key))) throw new Error('AGENT_EVALUATION_RESULT_FIELD_INVALID')
    const caseRunId = boundedEvaluationText(item.caseRunId, 'caseRunId', 500)
    const kind = boundedEvaluationText(item.kind, 'kind', 50)
    const criterion = boundedEvaluationText(item.criterion, 'criterion', 4_000)
    const index = remaining.findIndex(entry => entry.caseRun.id === caseRunId && entry.evaluation.kind === kind && entry.evaluation.criterion === criterion)
    if (index < 0) throw new Error('AGENT_EVALUATION_CRITERION_MISMATCH')
    const [{ caseRun, evaluation }] = remaining.splice(index, 1)
    const status = boundedEvaluationText(item.status, 'status', 50)
    if (status !== 'PASS' && status !== 'FAIL' && status !== 'NOT_EVALUABLE') throw new Error('AGENT_EVALUATION_STATUS_INVALID')
    if (!Array.isArray(item.evidenceRefs) || item.evidenceRefs.length > 200 || item.evidenceRefs.some(value => typeof value !== 'string')) throw new Error('AGENT_EVALUATION_EVIDENCE_INVALID')
    const evidenceRefs = [...new Set(item.evidenceRefs as string[])]
    const visibleEvidence = new Set(caseRun.traceEvents.map(event => event.id))
    if (evidenceRefs.some(id => !visibleEvidence.has(id))) throw new Error('AGENT_EVALUATION_EVIDENCE_NOT_FOUND')
    replacements.set(evaluation.id, {
      ...evaluation,
      status,
      explanation: boundedEvaluationText(item.explanation, 'explanation', 8_000),
      evidenceRefs,
      modelSnapshotRef,
    })
  }
  if (remaining.length) throw new Error('AGENT_EVALUATION_RESULT_MISSING')
  const caseRuns = result.caseRuns.map(caseRun => {
    const evaluationResults = caseRun.evaluationResults.map(item => required(replacements.get(item.id), 'AGENT_EVALUATION_RESULT_MISSING', 'Agent Evaluation 结果不完整'))
    const status = caseRun.status === 'ERROR' ? 'ERROR' as const
      : [...caseRun.assertionResults, ...evaluationResults].some(item => item.status === 'FAIL') ? 'FAIL' as const
        : [...caseRun.assertionResults, ...evaluationResults].some(item => item.status === 'NOT_EVALUABLE') ? 'NOT_EVALUABLE' as const
          : 'PASS' as const
    const deterministicFailureFacts = caseRun.failureFacts.filter(item => item.code !== 'AI_EVALUATION_FAILED')
    const evaluationFailureFacts = evaluationResults
      .filter(item => item.status === 'FAIL')
      .map(item => ({
        code: 'AI_EVALUATION_FAILED',
        message: item.explanation,
        evidenceRefs: [...item.evidenceRefs],
        expected: item.criterion,
        actual: caseRun.actualOutput,
      }))
    return { ...caseRun, evaluationResults, status, failureFacts: [...deterministicFailureFacts, ...evaluationFailureFacts] }
  })
  const count = caseRuns.length
  const rate = (status: typeof caseRuns[number]['status']) => caseRuns.filter(item => item.status === status).length / count
  const status = caseRuns.some(item => item.status === 'ERROR') ? 'ERROR'
    : caseRuns.some(item => item.status === 'FAIL') ? 'FAIL'
      : caseRuns.some(item => item.status === 'NOT_EVALUABLE') ? 'NOT_EVALUABLE' : 'PASS'
  return { ...result, caseRuns, status, successRate: rate('PASS'), failureRate: rate('FAIL'), notEvaluableRate: rate('NOT_EVALUABLE'), errorRate: rate('ERROR') }
}

function boundedEvaluationText(value: unknown, field: string, maxLength: number) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > maxLength) throw new Error(`AGENT_EVALUATION_${field.toUpperCase()}_INVALID`)
  return normalized
}

function candidateValidator<T>(validate: (candidate: Record<string, unknown>) => T) {
  return async (candidate: Record<string, unknown>, _manifest: InputDeliveryManifest) => {
    try { return { valid: true, result: structuredClone(validate(candidate)) as Record<string, unknown>, issues: [] } }
    catch (error) { return { valid: false, issues: [{ path: '/', message: error instanceof Error ? error.message : String(error) }] } }
  }
}

async function requiredLeaseTransaction<T>(store: TestExecutionStore, jobId: string, lease: ExecutionJobLease, operation: (transaction: TestExecutionTransaction) => Promise<T>) {
  const result = await store.transactionWithLease(jobId, lease, operation)
  if (result === null) throw new Error('TEST_EXECUTION_LEASE_LOST')
  return result
}

function requiredIdentity(value: string | undefined, field: string) {
  const normalized = String(value ?? '').trim()
  if (!normalized || normalized.length > 500 || /[\u0000-\u001F\u007F]/u.test(normalized)) throw new TestExecutionServiceError('TEST_EXECUTION_IDENTITY_INVALID', `${field} 无效`, 400)
  return normalized
}

function required<T>(value: T | null | undefined, code: string, message: string, status = 422): T {
  if (value === null || value === undefined) throw new TestExecutionServiceError(code, message, status)
  return value
}

function requireStateVersion(value: number, resource: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TestExecutionServiceError('TEST_EXECUTION_STATE_VERSION_INVALID', `${resource} stateVersion 无效`, 400)
}

function storeCommandError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const code = message.split(':', 1)[0]
  if (code.endsWith('_NOT_FOUND')) return new TestExecutionServiceError(code, '测试执行资源不存在', 404)
  if (code.includes('STATE_VERSION') || code.includes('STATE_CONFLICT')) return new TestExecutionServiceError(code, '测试执行状态版本已变化', 412)
  if (code.includes('NOT_CANCELLABLE') || code.includes('NOT_RETRYABLE') || code.includes('IDEMPOTENCY_CONFLICT')) return new TestExecutionServiceError(code, '测试执行命令与当前状态冲突', 409)
  return error
}

function stableIdentity(prefix: string, value: unknown) { return `${prefix}_${canonicalSha256(value).slice(0, 40)}` }
function caseRevisionKey(caseId: string, revision: number) { return `${caseId}\u0000${revision}` }
function terminalTaskStatus(status: ExecutionTask['status']) { return ['passed', 'failed', 'blocked', 'cancelled'].includes(status) }
function abortError(signal: AbortSignal) { return signal.reason instanceof Error ? signal.reason : new Error('TEST_EXECUTION_ABORTED') }
