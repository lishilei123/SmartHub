import { createHash } from 'node:crypto'
import type { InputDeliveryManifest, TestExecutionAgentWorkspaceProjection } from '../domain/agent-types.js'
import type {
  ExecutionArtifact,
  ExecutionAttempt,
  ExecutionAttemptKind,
  ExecutionEvent,
  ExecutionEnvironmentSnapshot,
  ExecutionJob,
  ExecutionPackage,
  ExecutionPackageCandidate,
  ExecutionPackageFile,
  ExecutionRun,
  ExecutionTask,
  ExecutionTestDataBinding,
  FailureDiagnosis,
  FrozenExecutionTestDataSnapshot,
  FrozenExecutionAgentSnapshot,
  HttpExplorationObservation,
  ProjectVersionExplorationResult,
  ScriptArtifact,
  ScriptRevision,
} from '../domain/test-execution-types.js'
import type {
  TestCaseLibraryVersionDetail,
  TestExecutionHandoff,
} from '../domain/test-design-types.js'
import type {
  TestExecutionAgentRuntimeInput,
  TestExecutionAgentRuntimeOutput,
} from '../agent/pi-test-execution-runtime.js'
import type { UIExecutionAgent, UiExecutionAgentPhase } from '../agent/ui-execution-agent.js'
import type {
  BrowserToolGateway,
  BrowserToolSession,
  BrowserToolStage,
} from '../tools/playwright-browser-tools.js'
import type { ExecutionArtifactStore } from '../infrastructure/execution-artifact-store.js'
import { executionArtifactBody } from '../infrastructure/execution-artifact-store.js'
import type {
  ExecutionJobLease,
  TestExecutionStore,
  TestExecutionTransaction,
} from '../infrastructure/test-execution-store.js'
import type { PlaywrightRunner } from '../runner/playwright-runner.js'
import type { AgentRunner } from '../runner/agent-runner.js'
import type { AgentEvaluationResult, AgentExecutionAggregateResult } from '../domain/agent-test-types.js'
import type { AgentUnderTestService } from './agent-under-test-service.js'
import {
  executionBindingDependencySha256,
  LocalExecutionWorkspaceStore,
  type CaseExecutionBinding,
} from '../infrastructure/execution-workspace-store.js'
import { canonicalJson, canonicalSha256 } from './canonical-json.js'
import { resolveAuthSessionPolicy } from './test-execution-auth-session.js'
import { createProjectVersionExplorationResult } from './test-execution-exploration.js'
import {
  assertExecutionPackageIntegrity,
  automaticRepairAllowed,
  buildExecutionPackage,
  executionEntrySymbol,
  freezeExecutionTaskInput,
  scriptCacheKey,
  unsupportedExecutionMethodReason,
  validateFailureDiagnosisCandidate,
} from './test-execution-validation.js'

export interface ImmutableTestExecutionSourceReader {
  getCurrentLibraryVersion(projectVersionId: string): Promise<TestCaseLibraryVersionDetail>
  createDefaultExecutionHandoff(projectVersionId: string, libraryVersionId: string, expectedLibrarySha256: string, createdBy: string): Promise<TestExecutionHandoff>
}

export interface ExecutionEnvironmentResolver {
  readiness(): Promise<{ ready: boolean; reason?: string }>
  resolveSnapshotForBaseUrl(baseUrl: string): Promise<ExecutionEnvironmentSnapshot>
  listSnapshots?(): Promise<ExecutionEnvironmentSnapshot[]>
}

export interface TestExecutionKnowledgeResolver {
  resolveSnapshot(projectId: string): Promise<ExecutionRun['knowledge']>
}

export interface TestExecutionWorkspaceProvider {
  project(input: {
    run: ExecutionRun
    task: ExecutionTask
    scriptRevision?: ScriptRevision
    attempts: readonly ExecutionAttempt[]
    diagnoses: readonly FailureDiagnosis[]
    artifacts: readonly ExecutionArtifact[]
  }): Promise<TestExecutionAgentWorkspaceProjection>
}

export interface TestExecutionAgentRuntime {
  readiness(): Promise<{
    ready: boolean
    agents: Array<{ agentKey: string; ready: boolean; reason?: string }>
  }>
  freezeConfiguration(): Promise<ExecutionRun['agents']>
  freezeFailureAnalysisConfiguration?(): Promise<ExecutionRun['agents']>
  execute(
    input: TestExecutionAgentRuntimeInput,
    signal: AbortSignal,
  ): Promise<TestExecutionAgentRuntimeOutput>
}

export type CreateTestExecutionRunInput = {
  projectVersionId: string
  baseUrl?: string
  agentUnderTestId?: string
  testDataBindings?: unknown
  idempotencyKey: string
  createdBy: string
}

export class TestExecutionServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

export class TestExecutionInfrastructureError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

export class TestExecutionService {
  constructor(
    private readonly sources: ImmutableTestExecutionSourceReader,
    private readonly store: TestExecutionStore,
    private readonly agentRuntime: TestExecutionAgentRuntime,
    private readonly artifactStore: ExecutionArtifactStore,
    private readonly workspaceProvider: TestExecutionWorkspaceProvider,
    private readonly environmentResolver: ExecutionEnvironmentResolver,
    private readonly runner: PlaywrightRunner,
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly executionWorkspace?: LocalExecutionWorkspaceStore,
    private readonly uiExecutionAgent?: UIExecutionAgent,
    private readonly knowledgeResolver?: TestExecutionKnowledgeResolver,
    private readonly browserTools?: BrowserToolGateway,
    private readonly agentUnderTestService?: AgentUnderTestService,
    private readonly agentRunner?: AgentRunner,
  ) {}

  async readiness() {
    const [store, artifactStore, environment, agents, runner] = await Promise.all([
      this.store.readiness(),
      this.artifactStore.readiness(),
      this.environmentResolver.readiness(),
      this.agentRuntime.readiness(),
      this.runner.readiness(),
    ])
    return {
      ready: store.ready
        && artifactStore.ready
        && environment.ready
        && agents.ready
        && runner.ready,
      store,
      artifactStore,
      environment,
      agents,
      runner,
      agent: {
        ready: store.ready
          && Boolean(this.agentUnderTestService)
          && Boolean(this.agentRunner)
          && Boolean(agents.agents.find(item => item.agentKey === 'failure-analysis')?.ready),
        reason: !store.ready
          ? store.reason
          : !this.agentUnderTestService || !this.agentRunner
            ? 'AgentRunner 未配置'
            : agents.agents.find(item => item.agentKey === 'failure-analysis')?.reason,
      },
    }
  }

  async environments() {
    return (await this.environmentResolver.listSnapshots?.() ?? [])
      .map(environment => structuredClone(environment))
  }

  async listExplorationContext(projectVersionId: string) {
    requiredIdentity(projectVersionId, 'projectVersionId')
    return this.executionWorkspace?.listExplorationResults(projectVersionId) ?? []
  }

  async listRuns(projectVersionId: string, limit = 50) {
    requiredIdentity(projectVersionId, 'projectVersionId')
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new TestExecutionServiceError(
        'TEST_EXECUTION_LIMIT_INVALID',
        'limit 必须是 1 到 200 的整数',
        400,
      )
    }
    return this.store.listRuns(projectVersionId, limit)
  }

  async getRun(runId: string) {
    return required(
      await this.store.getRun(requiredIdentity(runId, 'runId')),
      'TEST_EXECUTION_RUN_NOT_FOUND',
      '测试执行 Run 不存在',
      404,
    )
  }

  async listTasks(runId: string) {
    await this.getRun(runId)
    return this.store.listTasks(runId)
  }

  async getTask(taskId: string) {
    return required(
      await this.store.getTask(requiredIdentity(taskId, 'taskId')),
      'TEST_EXECUTION_TASK_NOT_FOUND',
      '测试执行 Task 不存在',
      404,
    )
  }

  async taskDetail(taskId: string) {
    const snapshot = required(
      await this.store.getTaskDetail(requiredIdentity(taskId, 'taskId')),
      'TEST_EXECUTION_TASK_NOT_FOUND',
      '测试执行 Task 不存在',
      404,
    )
    return {
      run: snapshot.run,
      task: snapshot.task,
      attempts: snapshot.attempts,
      events: snapshot.events,
      diagnoses: snapshot.diagnoses,
      scriptRevisions: snapshot.scriptRevisions,
      artifacts: snapshot.artifacts.map(publicArtifact),
      maintenanceProposals: snapshot.maintenanceProposals,
      ...(snapshot.agentExecutionResult ? { agentExecutionResult: snapshot.agentExecutionResult } : {}),
    }
  }

  async listMaintenanceProposals(runId: string) {
    const run = await this.getRun(runId)
    return this.store.listMaintenanceProposals(run.id)
  }

  async listTaskMaintenanceProposals(taskId: string) {
    const task = await this.getTask(taskId)
    return this.store.listTaskMaintenanceProposals(task.id)
  }

  async getMaintenanceProposal(proposalId: string) {
    return required(
      await this.store.getMaintenanceProposal(requiredIdentity(proposalId, 'proposalId')),
      'TEST_EXECUTION_MAINTENANCE_PROPOSAL_NOT_FOUND',
      '用例维护建议不存在',
      404,
    )
  }

  async maintenanceProposalDetail(proposalId: string) {
    const detail = required(
      await this.store.getMaintenanceProposalDetail(requiredIdentity(proposalId, 'proposalId')),
      'TEST_EXECUTION_MAINTENANCE_PROPOSAL_NOT_FOUND',
      '用例维护建议不存在',
      404,
    )
    const diff = await this.scriptRevisionDiff(
      detail.task.id,
      detail.originalScriptRevision.id,
      detail.repairScriptRevision.id,
    )
    return { ...detail, diff }
  }

  async decideMaintenanceProposal(input: {
    proposalId: string
    decision: 'accepted' | 'rejected'
    decidedBy: string
  }) {
    const proposal = await this.getMaintenanceProposal(input.proposalId)
    if (input.decision !== 'accepted' && input.decision !== 'rejected') {
      throw new TestExecutionServiceError(
        'TEST_EXECUTION_MAINTENANCE_DECISION_INVALID',
        'decision 只能是 accepted 或 rejected',
        400,
      )
    }
    try {
      return await this.store.decideMaintenanceProposal({
        proposalId: proposal.id,
        expectedStatus: 'pending',
        decision: input.decision,
        decidedBy: requiredIdentity(input.decidedBy, 'decidedBy'),
        decidedAt: this.clock(),
      })
    } catch (error) {
      throw storeCommandError(error)
    }
  }

  async scriptRevisionDiff(
    taskId: string,
    fromRevisionId: string,
    toRevisionId: string,
  ) {
    const task = await this.getTask(taskId)
    const revisions = await this.store.listScriptRevisions(task.id)
    const from = required(
      revisions.find(revision => revision.id === requiredIdentity(fromRevisionId, 'fromRevisionId')),
      'TEST_EXECUTION_SCRIPT_REVISION_NOT_FOUND',
      '起始 ScriptRevision 不存在',
      404,
    )
    const to = required(
      revisions.find(revision => revision.id === requiredIdentity(toRevisionId, 'toRevisionId')),
      'TEST_EXECUTION_SCRIPT_REVISION_NOT_FOUND',
      '目标 ScriptRevision 不存在',
      404,
    )
    const [fromFiles, toFiles] = await Promise.all([
      this.readRevisionFiles(from),
      this.readRevisionFiles(to),
    ])
    return {
      fromRevision: from,
      toRevision: to,
      changes: lineDifference(
        revisionSourceBundle(fromFiles),
        revisionSourceBundle(toFiles),
      ),
    }
  }

  async artifact(artifactId: string) {
    const artifact = required(
      await this.store.getArtifact(requiredIdentity(artifactId, 'artifactId')),
      'TEST_EXECUTION_ARTIFACT_NOT_FOUND',
      '测试执行 Artifact 不存在',
      404,
    )
    return {
      metadata: publicArtifact(artifact),
      storagePath: artifact.storagePath,
    }
  }

  async cancelRun(runId: string, expectedStateVersion: number) {
    const run = await this.getRun(runId)
    requireStateVersion(expectedStateVersion, 'Run')
    try {
      return await this.store.cancelRun(
        run.id,
        expectedStateVersion,
        this.clock(),
      )
    } catch (error) {
      throw storeCommandError(error)
    }
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
    const idempotencyKey = requiredIdentity(
      input.idempotencyKey,
      'idempotencyKey',
    )
    const requestedBy = requiredIdentity(input.requestedBy, 'requestedBy')
    requireStateVersion(input.expectedTaskStateVersion, 'Task')
    requireStateVersion(input.expectedRunStateVersion, 'Run')
    const requestedAt = this.clock()
    const job: ExecutionJob = {
      id: stableIdentity('test_execution_manual_retry_job', {
        taskId: task.id,
        idempotencyKey,
      }),
      runId: run.id,
      taskId: task.id,
      status: 'queued',
      attempts: 0,
      maxAttempts: 3,
      availableAt: requestedAt,
      fencingToken: 0,
      request: {
        kind: 'manual_retry',
        idempotencyKey,
        requestedBy,
      },
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
    } catch (error) {
      throw storeCommandError(error)
    }
  }

  async createRun(input: CreateTestExecutionRunInput) {
    const projectVersionId = requiredIdentity(input.projectVersionId, 'projectVersionId')
    const idempotencyKey = requiredIdentity(input.idempotencyKey, 'idempotencyKey')
    const createdBy = requiredIdentity(input.createdBy, 'createdBy')
    const requestedTestDataBindings = normalizeExecutionTestDataBindings(input.testDataBindings)
    const replay = await this.store.getRunByIdempotencyKey(projectVersionId, idempotencyKey)
    if (replay) {
      if (
        (input.agentUnderTestId ? replay.environment.agentUnderTest?.id !== input.agentUnderTestId : replay.environment.baseUrl !== requiredUrl(input.baseUrl))
        || replay.createdBy !== createdBy
        || canonicalSha256(replay.testData?.bindings ?? []) !== canonicalSha256(requestedTestDataBindings)
      ) {
        throw new TestExecutionServiceError(
          'TEST_EXECUTION_IDEMPOTENCY_CONFLICT',
          'Idempotency-Key 已用于不同的测试执行请求',
          409,
        )
      }
      return replay
    }

    const library = await this.sources.getCurrentLibraryVersion(projectVersionId)
    validateLibraryVersion(library, library.projectId, projectVersionId)
    const handoff = await this.sources.createDefaultExecutionHandoff(
      projectVersionId,
      library.id,
      library.contentSha256,
      createdBy,
    )
    const modern = validateModernHandoff(handoff, projectVersionId)
    if (modern.testCaseLibraryVersionId !== library.id) throw new TestExecutionServiceError('TEST_EXECUTION_LIBRARY_VERSION_MISMATCH', '执行范围未固定为当前正式用例库版本')
    const testData = freezeExecutionTestDataSnapshot(requestedTestDataBindings)
    validateSuiteVersion(modern, library)

    const libraryMembers = new Map(
      library.members.map(member => [caseRevisionKey(member.caseId, member.revision), member]),
    )
    const frozenInputs = modern.members
      .slice()
      .sort((left, right) => left.ordinal - right.ordinal)
      .map(member => freezeExecutionTaskInput({
        handoffMember: member,
        libraryMember: required(
          libraryMembers.get(caseRevisionKey(member.caseId, member.revision)),
          'TEST_EXECUTION_HANDOFF_LIBRARY_MEMBER_NOT_FOUND',
          `Handoff 成员 ${member.caseId}@${member.revision} 不属于固定用例库版本`,
        ),
        ...(testData ? { testData } : {}),
      }))
    if (!frozenInputs.length) {
      throw new TestExecutionServiceError(
        'TEST_EXECUTION_HANDOFF_EMPTY',
        '执行交接必须包含至少一个冻结任务',
      )
    }
    const agentRun = frozenInputs.every(item => item.method === 'agent')
    if (!agentRun && frozenInputs.some(item => item.method === 'agent')) throw new TestExecutionServiceError('TEST_EXECUTION_MIXED_RUNTIME_UNSUPPORTED', '同一个 Run 暂不允许混合 Agent 与 Script 执行任务')
    if (agentRun && (!this.agentUnderTestService || !this.agentRunner)) throw new TestExecutionServiceError('AGENT_TEST_RUNTIME_UNAVAILABLE', 'Agent Test Runtime 未配置', 503)
    if (
      new Set(frozenInputs.map(item => item.ordinal)).size !== frozenInputs.length
      || new Set(frozenInputs.map(item => item.dedupKey)).size !== frozenInputs.length
    ) {
      throw new TestExecutionServiceError(
        'TEST_EXECUTION_HANDOFF_MEMBER_DUPLICATE',
        '执行交接包含重复 ordinal 或 dedupKey',
      )
    }

    const agentUnderTest = agentRun
      ? await this.agentUnderTestService!.freeze(projectVersionId, requiredIdentity(input.agentUnderTestId, 'agentUnderTestId'))
      : undefined
    const [environment, agents, runnerReadiness, knowledge] = await Promise.all([
      agentUnderTest ? Promise.resolve(agentExecutionEnvironment(agentUnderTest)) : this.sourcesEnvironment(requiredUrl(input.baseUrl)),
      agentRun && this.agentRuntime.freezeFailureAnalysisConfiguration
        ? this.agentRuntime.freezeFailureAnalysisConfiguration()
        : this.agentRuntime.freezeConfiguration(),
      agentRun ? Promise.resolve({ ready: true as const, snapshot: { kind: 'agent' as const, runnerVersion: 'agent-runner/v1' } }) : this.runner.readiness(),
      this.knowledgeResolver?.resolveSnapshot(modern.projectId),
    ])
    if (!runnerReadiness.ready) {
      throw new TestExecutionServiceError(
        'TEST_EXECUTION_RUNNER_UNAVAILABLE',
        runnerReadiness.reason ?? (agentRun ? 'Agent Runner 不可用' : 'Playwright Runner 不可用'),
        503,
      )
    }
    assertAgentSnapshots(agents)

    const createdAt = this.clock()
    const runId = stableIdentity('test_execution_run', {
      projectVersionId,
      idempotencyKey,
    })
    const tasks: ExecutionTask[] = frozenInputs.map(frozenInput => {
      const taskId = stableIdentity('test_execution_task', {
        runId,
        ordinal: frozenInput.ordinal,
        dedupKey: frozenInput.dedupKey,
      })
      const unsupportedReason = unsupportedExecutionMethodReason(frozenInput.method)
      return {
        id: taskId,
        runId,
        input: frozenInput,
        status: unsupportedReason ? 'unsupported' : 'pending',
        stateVersion: 0,
        runnerAttemptCount: 0,
        sameScriptRetryCount: 0,
        repairCount: 0,
        ...(unsupportedReason ? { unsupportedReason, finishedAt: createdAt } : {}),
        createdAt,
        updatedAt: createdAt,
      }
    })
    const run: ExecutionRun = {
      id: runId,
      projectId: modern.projectId,
      projectVersionId,
      handoff: {
        handoffId: modern.id,
        handoffSha256: modern.contentSha256,
        projectId: modern.projectId,
        projectVersionId,
        testCaseLibraryVersionId: library.id,
        testCaseLibraryVersionSha256: library.contentSha256,
        mode: modern.mode,
        memberSnapshotSha256: canonicalSha256(frozenInputs),
      },
      environment,
      ...(knowledge ? { knowledge: structuredClone(knowledge) } : {}),
      ...(testData ? { testData } : {}),
      runner: structuredClone(runnerReadiness.snapshot),
      agents: structuredClone(agents),
      status: 'queued',
      stateVersion: 0,
      idempotencyKey,
      taskCount: tasks.length,
      createdBy,
      createdAt,
    }
    const jobs: ExecutionJob[] = tasks
      .filter(task => task.status === 'pending')
      .map(task => ({
        id: stableIdentity('test_execution_job', { runId, taskId: task.id }),
        runId,
        taskId: task.id,
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

  async processPreparedTask(
    job: ExecutionJob,
    lease: ExecutionJobLease,
    signal: AbortSignal,
  ) {
    for (;;) {
      if (signal.aborted) throw abortError(signal)
      const [run, task] = await Promise.all([
        this.store.getRun(job.runId),
        this.store.getTask(job.taskId),
      ])
      if (!run || !task || task.runId !== run.id) {
        throw new Error('TEST_EXECUTION_JOB_SCOPE_INVALID')
      }
      if (task.input.method === 'agent') {
        return await this.processAgentTask(job, lease, run, task, signal)
      }
      if (terminalTaskStatus(task.status)) {
        if (task.status === 'passed') {
          await this.validatePassedWorkspaceBinding(run, task)
        }
        return task
      }
      switch (task.status) {
        case 'pending':
          await this.prepareScript(job, lease, run, task, signal)
          break
        case 'script_generating':
          await this.generateScript(job, lease, run, task, signal)
          break
        case 'ready':
        case 'retrying':
          await this.executeRunner(job, lease, run, task, signal)
          break
        case 'running':
          throw new TestExecutionInfrastructureError(
            'TEST_EXECUTION_RUNNING_ATTEMPT_REQUIRES_RECONCILIATION',
          )
        case 'diagnosing':
          await this.diagnoseFailure(job, lease, run, task, signal)
          break
        case 'repairing':
          await this.repairScript(job, lease, run, task, signal)
          break
        default:
          return task
      }
    }
  }

  private async processAgentTask(
    job: ExecutionJob,
    lease: ExecutionJobLease,
    run: ExecutionRun,
    task: ExecutionTask,
    signal: AbortSignal,
  ): Promise<ExecutionTask> {
    if (terminalTaskStatus(task.status)) return task
    if (!this.agentRunner || !this.agentUnderTestService) throw new TestExecutionInfrastructureError('AGENT_TEST_RUNTIME_UNAVAILABLE')
    const snapshot = run.environment.agentUnderTest
    const spec = task.input.caseContent.agentTestSpec
    if (!snapshot || !spec || task.input.executionSpec.schemaVersion !== 'agent-test-input/v1') throw new TestExecutionInfrastructureError('AGENT_TEST_FROZEN_INPUT_INVALID')
    if (task.status === 'pending' || task.status === 'ready') {
      await requiredLeaseTransaction(this.store, job.id, lease, transaction => transaction.transitionTask({
        taskId: task.id,
        expectedStatus: task.status,
        expectedStateVersion: task.stateVersion,
        status: 'running',
      }))
      const running = await this.getTask(task.id)
      return await this.processAgentTask(job, lease, run, running, signal)
    }
    if (task.status !== 'running') throw new TestExecutionInfrastructureError(`AGENT_TEST_TASK_STATE_INVALID: ${task.status}`)
    const resolvedVersion = await this.agentUnderTestService.resolveVersion(snapshot)
    const runnerResult = await this.agentRunner.execute({ runId: run.id, taskId: task.id, agentUnderTest: snapshot, resolvedVersion, spec }, signal)
    const executionResult = runnerResult.caseRuns.some(item => item.evaluationResults.length)
      ? await this.evaluateAgentSemantics(run, task, runnerResult, signal)
      : runnerResult
    const result = executionResult.status === 'FAIL' || executionResult.status === 'ERROR'
      ? await this.analyzeAgentFailure(run, task, executionResult, signal)
      : executionResult
    const status: ExecutionTask['status'] = result.status === 'PASS' ? 'passed' : result.status === 'NOT_EVALUABLE' ? 'blocked' : 'failed'
    const error = result.status === 'PASS' ? undefined : result.caseRuns.flatMap(item => item.failureFacts.map(fact => fact.code)).filter((value, index, values) => values.indexOf(value) === index).join(', ') || result.status
    return await requiredLeaseTransaction(this.store, job.id, lease, async transaction => {
      await transaction.appendAgentExecutionResult(result)
      return await transaction.transitionTask({ taskId: task.id, expectedStatus: 'running', expectedStateVersion: task.stateVersion, status, ...(error ? { error } : {}), finishedAt: this.clock() })
    })
  }

  private async evaluateAgentSemantics(
    run: ExecutionRun,
    task: ExecutionTask,
    result: AgentExecutionAggregateResult,
    signal: AbortSignal,
  ): Promise<AgentExecutionAggregateResult> {
    try {
      const workspace = await this.workspace(run, task)
      const output = await this.agentRuntime.execute({
        stage: 'agent_evaluation',
        run,
        task,
        workspace,
        stageContext: { agentExecution: result },
        validateCandidate: candidateValidator(candidate => applyAgentEvaluationCandidate(result, candidate, run.agents.failureAnalysis.snapshotSha256)),
      }, signal)
      assertAgentOutputSchema(output, 'agent-evaluation/v1')
      return applyAgentEvaluationCandidate(result, output.candidate, run.agents.failureAnalysis.snapshotSha256)
    } catch (error) {
      return { ...result, evaluationError: error instanceof Error ? error.message : String(error) }
    }
  }

  private async analyzeAgentFailure(
    run: ExecutionRun,
    task: ExecutionTask,
    result: AgentExecutionAggregateResult,
    signal: AbortSignal,
  ): Promise<AgentExecutionAggregateResult> {
    try {
      const workspace = await this.workspace(run, task)
      const validate = (candidate: Record<string, unknown>) => validateFailureDiagnosisCandidate(candidate)
      const output = await this.agentRuntime.execute({
        stage: 'failure_diagnosis',
        run,
        task,
        workspace,
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
          source: 'agent',
          agentSnapshotRef: run.agents.failureAnalysis.snapshotSha256,
        },
      }
    } catch (error) {
      return {
        ...result,
        failureAnalysisError: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async sourcesEnvironment(baseUrl: string) {
    let environment: ExecutionEnvironmentSnapshot
    try {
      environment = await this.environmentResolver.resolveSnapshotForBaseUrl(baseUrl)
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error)
      if (code === 'TEST_EXECUTION_BASE_URL_INVALID') {
        throw new TestExecutionServiceError(
          code,
          '被测系统地址必须是有效的 http 或 https 地址',
          400,
        )
      }
      if (code === 'TEST_EXECUTION_ENVIRONMENT_NOT_REGISTERED') {
        throw new TestExecutionServiceError(
          code,
          '被测系统地址尚未登记到可执行 OCI 运行网络',
          422,
        )
      }
      throw error
    }
    if (environment.baseUrl !== baseUrl) {
      throw new TestExecutionServiceError(
        'TEST_EXECUTION_ENVIRONMENT_SCOPE_MISMATCH',
        '环境解析器返回了与请求地址不一致的环境快照',
      )
    }
    const base = {
      schemaVersion: 'test-execution-environment/v1',
      environmentId: environment.environmentId,
      name: environment.name,
      baseUrl: environment.baseUrl,
      targets: environment.targets,
    }
    if (environment.signature !== canonicalSha256(base)) {
      throw new TestExecutionServiceError(
        'TEST_EXECUTION_ENVIRONMENT_SIGNATURE_INVALID',
        '环境非敏感快照签名无效',
      )
    }
    return structuredClone(environment)
  }

  private async prepareScript(
    job: ExecutionJob,
    lease: ExecutionJobLease,
    run: ExecutionRun,
    task: ExecutionTask,
    signal: AbortSignal,
  ) {
    const executionImplementation = requiredExecutionImplementation(run)
    if (this.executionWorkspace) {
      const binding = await this.executionWorkspace.resolveBinding(
        run.projectVersionId,
        task.input.caseId,
      )
      if (
        binding
        && binding.bindingStatus !== 'invalid'
        && binding.executionType === executableMethod(task)
        && binding.caseContentSha256 === task.input.caseContentSha256
      ) {
        const workspaceSnapshot = await this.executionWorkspace.snapshot(run.projectVersionId)
        const source = await this.executionWorkspace.readEntry(run.projectVersionId, binding)
        const executionPackage = buildExecutionPackage({
          candidate: {
            entryFile: binding.entryFile,
            files: [{ path: binding.entryFile, content: source }],
            summary: '复用 ProjectVersion Execution Workspace 入口',
          },
          task: { ...task.input, taskId: task.id },
          environmentSignature: run.environment.signature,
          workspaceFiles: workspaceSnapshot.files,
        })
        const cacheKey = taskScriptCacheKey(run, task)
        await this.persistScriptRevision({
          job, lease, run, task, expectedStatus: 'pending', executionPackage,
          scriptArtifact: {
            id: stableIdentity('test_execution_script_artifact', { cacheKey }), cacheKey,
            caseId: task.input.caseId, caseRevision: task.input.caseRevision,
            method: executableMethod(task), caseContentSha256: task.input.caseContentSha256,
            executionSpecSha256: task.input.executionSpecSha256, taskInputSha256: task.input.inputSha256,
            environmentSignature: run.environment.signature,
            executionImplementationAgentVersion: executionImplementation.configurationVersion,
            executionImplementationAgentConfigurationSha256: executionImplementation.configurationSha256,
            createdAt: this.clock(),
          },
          // The immutable revision records the entry actually executed. It is
          // not a ScriptArtifact cache replay: the source of truth is the
          // ProjectVersion workspace binding.
          source: 'agent', generatedBy: executionImplementation, incrementRepair: false,
        })
        return
      }
      if (binding && binding.bindingStatus !== 'invalid') {
        await this.executionWorkspace.setBindingStatus(
          run.projectVersionId,
          task.input.caseId,
          'invalid',
        )
      }
    }
    await requiredLeaseTransaction(
      this.store,
      job.id,
      lease,
      transaction => transaction.transitionTask({
        taskId: task.id,
        expectedStatus: 'pending',
        expectedStateVersion: task.stateVersion,
        status: 'script_generating',
      }),
    )
    if (signal.aborted) throw abortError(signal)
  }

  private async generateScript(
    job: ExecutionJob,
    lease: ExecutionJobLease,
    run: ExecutionRun,
    task: ExecutionTask,
    signal: AbortSignal,
  ) {
    const executionImplementation = requiredExecutionImplementation(run)
    const workspace = await this.workspace(run, task)
    const workspaceFiles = this.executionWorkspace
      ? (await this.executionWorkspace.snapshot(run.projectVersionId)).files
      : []
    const output = await this.withBrowserSession(
      run,
      task,
      'script_generation',
      signal,
      browserSession => this.agentRuntime.execute({
        stage: 'script_generation',
        run,
        task,
        workspace,
        ...(browserSession ? { browserSession } : {}),
        validateCandidate: candidateValidator(candidate => {
          const normalized = packageCandidate(candidate, 'test-script-generation/v1')
          buildExecutionPackage({
            candidate: normalized,
            task: { ...task.input, taskId: task.id },
            environmentSignature: run.environment.signature,
            workspaceFiles,
          })
          return normalized
        }),
      }, signal),
    )
    assertAgentOutputSchema(output, 'test-script-generation/v1')
    const executionPackage = buildExecutionPackage({
      candidate: packageCandidate(output.candidate, 'test-script-generation/v1'),
      task: { ...task.input, taskId: task.id },
      environmentSignature: run.environment.signature,
      workspaceFiles,
    })
    const createdAt = this.clock()
    const cacheKey = taskScriptCacheKey(run, task)
    await this.persistWorkspaceImplementation(run, task, executionPackage, 'validated')
    await this.persistScriptRevision({
      job,
      lease,
      run,
      task,
      expectedStatus: 'script_generating',
      scriptArtifact: {
        id: stableIdentity('test_execution_script_artifact', { cacheKey }),
        cacheKey,
        caseId: task.input.caseId,
        caseRevision: task.input.caseRevision,
        method: executableMethod(task),
        caseContentSha256: task.input.caseContentSha256,
        executionSpecSha256: task.input.executionSpecSha256,
        taskInputSha256: task.input.inputSha256,
        environmentSignature: run.environment.signature,
        executionImplementationAgentVersion: executionImplementation.configurationVersion,
        executionImplementationAgentConfigurationSha256: executionImplementation.configurationSha256,
        createdAt,
      },
      executionPackage,
      source: 'agent',
      generatedBy: executionImplementation,
      incrementRepair: false,
    })
  }

  private async repairScript(
    job: ExecutionJob,
    lease: ExecutionJobLease,
    run: ExecutionRun,
    task: ExecutionTask,
    signal: AbortSignal,
  ) {
    const executionImplementation = requiredExecutionImplementation(run)
    const parent = await this.currentRevision(task)
    const diagnoses = await this.store.listDiagnoses(task.id)
    const diagnosis = [...diagnoses]
      .reverse()
      .find(item => item.scriptRevisionId === parent.id)
    if (!diagnosis || !automaticRepairAllowed(diagnosis, task.repairCount)) {
      await requiredLeaseTransaction(
        this.store,
        job.id,
        lease,
        transaction => transaction.transitionTask({
          taskId: task.id,
          expectedStatus: 'repairing',
          expectedStateVersion: task.stateVersion,
          status: 'waiting_manual',
          error: 'TEST_EXECUTION_AUTOMATIC_REPAIR_NOT_ALLOWED',
          finishedAt: this.clock(),
        }),
      )
      return
    }
    const attempts = (await this.store.listAttempts(task.id))
      .filter(attempt => attempt.scriptRevisionId === parent.id && attempt.status === 'failed')
    const artifacts = (await Promise.all(
      attempts.map(attempt => this.store.listArtifacts(task.id, attempt.id)),
    )).flat()
    const workspace = await this.workspace(
      run,
      task,
      parent,
      attempts,
      [diagnosis],
      artifacts,
    )
    const workspaceFiles = this.executionWorkspace
      ? (await this.executionWorkspace.snapshot(run.projectVersionId)).files
      : []
    const build = (candidate: Record<string, unknown>) => {
      const normalized = packageCandidate(candidate, 'script-repair/v1')
      buildExecutionPackage({
        candidate: normalized,
        task: { ...task.input, taskId: task.id },
        environmentSignature: run.environment.signature,
        workspaceFiles,
        baselineAssertions: parent.package.assertions,
      })
      return normalized
    }
    const output = await this.withBrowserSession(
      run,
      task,
      'script_repair',
      signal,
      browserSession => this.agentRuntime.execute({
        stage: 'script_repair',
        run,
        task,
        workspace,
        ...(browserSession ? { browserSession } : {}),
        stageContext: {
          parentScriptRevisionId: parent.id,
          diagnosisId: diagnosis.id,
          attemptIds: attempts.map(attempt => attempt.id),
          artifactIds: artifacts.map(artifact => artifact.id),
          repairCount: task.repairCount,
        },
        validateCandidate: candidateValidator(build),
      }, signal),
    )
    assertAgentOutputSchema(output, 'script-repair/v1')
    const executionPackage = buildExecutionPackage({
      candidate: build(output.candidate),
      task: { ...task.input, taskId: task.id },
      environmentSignature: run.environment.signature,
      workspaceFiles,
      baselineAssertions: parent.package.assertions,
    })
    if (executionPackage.manifest.packageSha256 === parent.package.packageSha256) {
      await requiredLeaseTransaction(
        this.store,
        job.id,
        lease,
        transaction => transaction.transitionTask({
          taskId: task.id,
          expectedStatus: 'repairing',
          expectedStateVersion: task.stateVersion,
          status: 'waiting_manual',
          error: 'TEST_EXECUTION_REPAIR_NO_CHANGE',
          finishedAt: this.clock(),
        }),
      )
      return
    }
    const scriptArtifact = required(
      await this.store.getScriptArtifact(parent.scriptArtifactId),
      'TEST_EXECUTION_SCRIPT_ARTIFACT_NOT_FOUND',
      '当前 ScriptRevision 缺少 ScriptArtifact 身份',
    )
    await this.persistWorkspaceImplementation(run, task, executionPackage, 'validated')
    await this.persistScriptRevision({
      job,
      lease,
      run,
      task,
      expectedStatus: 'repairing',
      scriptArtifact,
      executionPackage,
      source: 'repair',
      generatedBy: executionImplementation,
      parent,
      repairReason: diagnosis.summary,
      incrementRepair: true,
    })
  }

  private async persistScriptRevision(input: {
    job: ExecutionJob
    lease: ExecutionJobLease
    run: ExecutionRun
    task: ExecutionTask
    expectedStatus: 'pending' | 'script_generating' | 'repairing'
    scriptArtifact: ScriptArtifact
    executionPackage: ExecutionPackage
    source: 'agent' | 'repair'
    generatedBy: FrozenExecutionAgentSnapshot
    parent?: ScriptRevision
    repairReason?: string
    incrementRepair: boolean
  }) {
    const file = required(input.executionPackage.files.find(candidate => candidate.path === input.executionPackage.manifest.entrypoint), 'TEST_EXECUTION_PACKAGE_ENTRYPOINT_MISSING', '执行包缺少入口源码')
    const createdAt = this.clock()
    const storedFiles = await Promise.all(input.executionPackage.files.map(async packageFile => {
      const stored = await this.artifactStore.put({
        body: executionArtifactBody(packageFile.content),
        mimeType: 'text/typescript; charset=utf-8',
        expectedSha256: packageFile.contentSha256,
        maximumBytes: 512 * 1024,
      })
      const artifact: ExecutionArtifact = {
        id: stableIdentity('test_execution_artifact', {
          runId: input.run.id,
          taskId: input.task.id,
          type: 'script',
          sha256: stored.sha256,
        }),
        runId: input.run.id,
        taskId: input.task.id,
        type: 'script',
        ...stored,
        createdAt,
      }
      return { path: packageFile.path, artifact }
    }))
    const sourceArtifact = required(
      storedFiles.find(item => item.path === file.path)?.artifact,
      'TEST_EXECUTION_PACKAGE_ENTRYPOINT_MISSING',
      '执行包缺少入口源码 Artifact',
    )
    const sourceArtifacts = storedFiles.map(item => ({
      path: item.path,
      artifactId: item.artifact.id,
    }))
    const revisionNumber = input.parent ? input.parent.revision + 1 : 1
    await requiredLeaseTransaction(
      this.store,
      input.job.id,
      input.lease,
      async transaction => {
        for (const artifact of new Map(storedFiles.map(item => [item.artifact.id, item.artifact])).values()) {
          await transaction.appendArtifact(artifact)
        }
        const scriptArtifact = await transaction.appendScriptArtifact(input.scriptArtifact)
        const revision: ScriptRevision = {
          id: stableIdentity('test_execution_script_revision', {
            runId: input.run.id,
            taskId: input.task.id,
            revision: revisionNumber,
            packageSha256: input.executionPackage.manifest.packageSha256,
          }),
          runId: input.run.id,
          taskId: input.task.id,
          scriptArtifactId: scriptArtifact.id,
          revision: revisionNumber,
          ...(input.parent ? { parentRevisionId: input.parent.id } : {}),
          source: input.source,
          ...(input.repairReason ? { repairReason: input.repairReason } : {}),
          generatedBy: structuredClone(input.generatedBy),
          package: structuredClone(input.executionPackage.manifest),
          sourceArtifacts,
          sourceArtifactId: sourceArtifact.id,
          contentSha256: file.contentSha256,
          protectedAssertionSha256: input.executionPackage.manifest.protectedAssertionSha256,
          createdAt,
        }
        await transaction.appendScriptRevision(revision)
        return transaction.transitionTask({
          taskId: input.task.id,
          expectedStatus: input.expectedStatus,
          expectedStateVersion: input.task.stateVersion,
          status: 'ready',
          currentScriptRevisionId: revision.id,
          incrementRepair: input.incrementRepair,
        })
      },
    )
  }

  private async executeRunner(
    job: ExecutionJob,
    lease: ExecutionJobLease,
    run: ExecutionRun,
    task: ExecutionTask,
    signal: AbortSignal,
  ) {
    const revision = await this.currentRevision(task)
    const executionPackage = await this.reconstructPackage(run, task, revision)
    assertFrozenRunner(run, this.runner.snapshot())
    const priorAttempts = await this.store.listAttempts(task.id)
    const revisionAttempts = priorAttempts.filter(item => item.scriptRevisionId === revision.id)
    const kind = attemptKind(task, revision, priorAttempts, revisionAttempts)
    const ordinal = task.runnerAttemptCount + 1
    const attemptId = stableIdentity('test_execution_attempt', {
      taskId: task.id,
      ordinal,
      scriptRevisionId: revision.id,
      packageSha256: revision.package.packageSha256,
    })
    const startedAt = this.clock()
    const attempt: ExecutionAttempt = {
      id: attemptId,
      runId: run.id,
      taskId: task.id,
      ordinal,
      invocationKey: canonicalSha256({
        schemaVersion: 'test-execution-runner-invocation/v1',
        taskId: task.id,
        ordinal,
        scriptRevisionId: revision.id,
        packageSha256: revision.package.packageSha256,
      }),
      kind,
      scriptRevisionId: revision.id,
      packageSha256: revision.package.packageSha256,
      status: 'running',
      startedAt,
    }
    await requiredLeaseTransaction(
      this.store,
      job.id,
      lease,
      async transaction => {
        await transaction.appendAttempt(attempt)
        return transaction.transitionTask({
          taskId: task.id,
          expectedStatus: task.status as 'ready' | 'retrying',
          expectedStateVersion: task.stateVersion,
          status: 'running',
          incrementRunnerAttempt: true,
          incrementSameScriptRetry: kind === 'same_script_retry',
        })
      },
    )

    let result
    try {
      result = await this.runner.execute({
        package: executionPackage,
        task: { ...task.input, taskId: task.id },
        attemptId,
        expectedPackageSha256: revision.package.packageSha256,
        environment: run.environment,
        runner: run.runner,
        ...(await this.workspaceRunTarget(run, task, revision)),
      }, signal)
    } catch (error) {
      result = {
        status: signal.aborted ? 'cancelled' as const : 'infrastructure_error' as const,
        durationMs: elapsedMilliseconds(startedAt, this.clock()),
        summary: signal.aborted ? 'Runner 已取消' : 'Runner 启动失败',
        error: error instanceof Error ? error.message : String(error),
        artifacts: [],
      }
    }

    const finishedAt = this.clock()
    if (result.status === 'cancelled') {
      const cancelled = await this.store.transactionWithLease(
        job.id,
        lease,
        async transaction => {
          const artifacts = await appendRunnerArtifacts(transaction, run.id, task.id, attemptId, result.artifacts, finishedAt)
          await transaction.appendExecutionEvents(normalizeRunnerExecutionEvents({ run, task, attemptId, result, artifacts, finishedAt }))
          await transaction.finalizeAttempt({
            attemptId,
            status: 'cancelled',
            finishedAt,
            durationMs: result.durationMs,
            ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
            summary: result.summary,
            ...(result.error ? { error: result.error } : {}),
          })
          return transaction.transitionTask({
            taskId: task.id,
            expectedStatus: 'running',
            expectedStateVersion: task.stateVersion + 1,
            status: 'cancelled',
            error: result.error,
            finishedAt,
          })
        },
        { allowCancellation: true },
      )
      if (!cancelled) throw new Error('TEST_EXECUTION_LEASE_LOST')
      return
    }

    if (result.status === 'infrastructure_error') {
      await requiredLeaseTransaction(
        this.store,
        job.id,
        lease,
        async transaction => {
          const artifacts = await appendRunnerArtifacts(transaction, run.id, task.id, attemptId, result.artifacts, finishedAt)
          await transaction.appendExecutionEvents(normalizeRunnerExecutionEvents({ run, task, attemptId, result, artifacts, finishedAt }))
          await transaction.finalizeAttempt({
            attemptId,
            status: 'infrastructure_error',
            finishedAt,
            durationMs: result.durationMs,
            ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
            summary: result.summary,
            error: result.error ?? 'TEST_EXECUTION_RUNNER_INFRASTRUCTURE_ERROR',
          })
          return transaction.transitionTask({
            taskId: task.id,
            expectedStatus: 'running',
            expectedStateVersion: task.stateVersion + 1,
            status: 'ready',
            error: result.error ?? 'TEST_EXECUTION_RUNNER_INFRASTRUCTURE_ERROR',
          })
        },
      )
      throw new TestExecutionInfrastructureError(
        result.error ?? 'TEST_EXECUTION_RUNNER_INFRASTRUCTURE_ERROR',
      )
    }

    const failedAttempts = revisionAttempts.filter(item => item.status === 'failed')
    await requiredLeaseTransaction(
      this.store,
      job.id,
      lease,
      async transaction => {
        const artifacts = await appendRunnerArtifacts(transaction, run.id, task.id, attemptId, result.artifacts, finishedAt)
        await transaction.appendExecutionEvents(normalizeRunnerExecutionEvents({ run, task, attemptId, result, artifacts, finishedAt }))
        await transaction.finalizeAttempt({
          attemptId,
          status: result.status,
          finishedAt,
          durationMs: result.durationMs,
          ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
          summary: result.summary,
          ...(result.error ? { error: result.error } : {}),
        })
        if (result.status === 'passed') {
          if (kind === 'same_script_retry') {
            const failure = required(
              revisionAttempts.at(-1)?.status === 'failed'
                && revisionAttempts.at(-1)?.packageSha256 === attempt.packageSha256
                ? revisionAttempts.at(-1)
                : undefined,
              'TEST_EXECUTION_FLAKY_FAILURE_REQUIRED',
              '同脚本重试成功前缺少紧邻的同包失败 Attempt',
            )
            await transaction.appendDiagnosis(deterministicFlakyDiagnosis({
              run,
              task,
              revision,
              failure,
              success: { ...attempt, status: 'passed', finishedAt },
              createdAt: finishedAt,
            }))
          }
          return transaction.transitionTask({
            taskId: task.id,
            expectedStatus: 'running',
            expectedStateVersion: task.stateVersion + 1,
            status: 'passed',
            finishedAt,
          })
        }
        return transaction.transitionTask({
          taskId: task.id,
          expectedStatus: 'running',
          expectedStateVersion: task.stateVersion + 1,
          status: this.executionWorkspace
            ? retryableFailure(result.error, result.summary) && failedAttempts.length === 0 ? 'retrying' : 'diagnosing'
            : failedAttempts.length === 0 ? 'retrying' : 'diagnosing',
          error: result.error,
        })
      },
    )
  }

  private async diagnoseFailure(
    job: ExecutionJob,
    lease: ExecutionJobLease,
    run: ExecutionRun,
    task: ExecutionTask,
    signal: AbortSignal,
  ) {
    const revision = await this.currentRevision(task)
    const attempts = (await this.store.listAttempts(task.id))
      .filter(item => item.scriptRevisionId === revision.id && item.status === 'failed')
    if (!attempts.length || !this.executionWorkspace && attempts.length < 2) {
      throw new Error(this.executionWorkspace ? 'TEST_EXECUTION_DIAGNOSIS_ATTEMPT_REQUIRED' : 'TEST_EXECUTION_DIAGNOSIS_REQUIRES_TWO_FAILURES')
    }
    const artifacts = (await Promise.all(
      attempts.map(attempt => this.store.listArtifacts(task.id, attempt.id)),
    )).flat()
    const diagnoses = await this.store.listDiagnoses(task.id)
    const uiExecution = await this.uiExecutionContext(run, task, 'failure_analysis', signal)
    const workspace = await this.workspace(run, task, revision, attempts, diagnoses, artifacts)
    const attemptIds = attempts.map(attempt => attempt.id)
    const artifactIds = artifacts.map(artifact => artifact.id)
    const validate = (candidate: Record<string, unknown>) =>
      validateFailureDiagnosisCandidate(candidate)
    const output = await this.agentRuntime.execute({
      stage: 'failure_diagnosis',
      run,
      task,
      workspace,
      ...(uiExecution ? { uiExecution } : {}),
      stageContext: {
        scriptRevisionId: revision.id,
        attemptIds,
        artifactIds,
      },
      validateCandidate: candidateValidator(validate),
    }, signal)
    assertAgentOutputSchema(output, 'failure-analysis/v1')
    const candidate = validate(output.candidate)
    const policy = failureDiagnosisPolicy(candidate.category)
    const evidenceAttempt = attempts.at(-1)!
    const evidenceArtifact = artifacts.find(artifact =>
      artifact.attemptId === evidenceAttempt.id && artifact.type === 'log')
      ?? artifacts.find(artifact => artifact.attemptId === evidenceAttempt.id)
    const diagnosis: FailureDiagnosis = {
      id: stableIdentity('test_execution_diagnosis', {
        taskId: task.id,
        scriptRevisionId: revision.id,
        attemptIds,
      }),
      runId: run.id,
      taskId: task.id,
      scriptRevisionId: revision.id,
      attemptIds,
      category: candidate.category,
      // Kept for persisted v1 compatibility. The Agent no longer self-reports
      // probabilistic confidence, so Service records a neutral value.
      confidence: 0.5,
      summary: candidate.reason,
      evidence: [{
        attemptId: evidenceAttempt.id,
        ...(evidenceArtifact ? { artifactId: evidenceArtifact.id } : {}),
        observation: candidate.evidence,
      }],
      ...policy,
      source: 'agent',
      agent: structuredClone(run.agents.failureAnalysis),
      createdAt: this.clock(),
    }
    const next = diagnosisTaskStatus(diagnosis, task.repairCount)
    await requiredLeaseTransaction(
      this.store,
      job.id,
      lease,
      async transaction => {
        await transaction.appendDiagnosis(diagnosis)
        return transaction.transitionTask({
          taskId: task.id,
          expectedStatus: 'diagnosing',
          expectedStateVersion: task.stateVersion,
          status: next,
          ...(next === 'repairing' ? {} : { finishedAt: this.clock() }),
          ...(next === 'failed' ? { error: diagnosis.summary } : {}),
        })
      },
    )
  }

  private async currentRevision(task: ExecutionTask) {
    if (!task.currentScriptRevisionId) {
      throw new Error('TEST_EXECUTION_CURRENT_SCRIPT_REVISION_REQUIRED')
    }
    const revision = await this.store.getScriptRevision(task.currentScriptRevisionId)
    if (!revision || revision.taskId !== task.id || revision.runId !== task.runId) {
      throw new Error('TEST_EXECUTION_CURRENT_SCRIPT_REVISION_INVALID')
    }
    return revision
  }

  private async reconstructPackage(
    run: ExecutionRun,
    task: ExecutionTask,
    revision: ScriptRevision,
  ) {
    const executionPackage: ExecutionPackage = {
      manifest: structuredClone(revision.package),
      files: await this.readRevisionFiles(revision),
    }
    return assertExecutionPackageIntegrity({
      package: executionPackage,
      task: { ...task.input, taskId: task.id },
      environmentSignature: run.environment.signature,
      expectedPackageSha256: revision.package.packageSha256,
    })
  }

  private async readRevisionFiles(revision: ScriptRevision) {
    if (
      revision.sourceArtifacts.length !== revision.package.files.length
      || revision.sourceArtifacts.some((item, index) => item.path !== revision.package.files[index].path)
    ) throw new Error('TEST_EXECUTION_SCRIPT_SOURCE_ARTIFACT_INVALID')
    return await Promise.all(revision.sourceArtifacts.map(async (reference, index) => {
      const manifestFile = revision.package.files[index]
      const artifact = required(
        await this.store.getArtifact(reference.artifactId),
        'TEST_EXECUTION_SCRIPT_SOURCE_ARTIFACT_NOT_FOUND',
        `ScriptRevision 缺少源码 Artifact：${reference.path}`,
      )
      if (
        artifact.runId !== revision.runId
        || artifact.taskId !== revision.taskId
        || artifact.sha256 !== manifestFile.contentSha256
        || artifact.size !== manifestFile.size
      ) throw new Error('TEST_EXECUTION_SCRIPT_SOURCE_ARTIFACT_INVALID')
      return {
        path: reference.path,
        content: await this.readScriptSource(artifact),
        contentSha256: artifact.sha256,
        size: artifact.size,
      }
    }))
  }

  private async readScriptSource(artifact: ExecutionArtifact) {
    if (artifact.type !== 'script' || artifact.attemptId) {
      throw new Error('TEST_EXECUTION_SCRIPT_SOURCE_ARTIFACT_INVALID')
    }
    const metadata = await this.artifactStore.stat(artifact.storagePath)
    if (metadata.sha256 !== artifact.sha256 || metadata.size !== artifact.size) {
      throw new Error('TEST_EXECUTION_SCRIPT_SOURCE_ARTIFACT_DRIFT')
    }
    const stream = await this.artifactStore.open(artifact.storagePath)
    const chunks: Buffer[] = []
    let size = 0
    for await (const value of stream) {
      const chunk = Buffer.from(value)
      size += chunk.length
      if (size > 512 * 1024) throw new Error('TEST_EXECUTION_SCRIPT_SOURCE_TOO_LARGE')
      chunks.push(chunk)
    }
    const source = Buffer.concat(chunks).toString('utf8')
    if (
      !source
      || Buffer.byteLength(source, 'utf8') !== artifact.size
      || sha256(source) !== artifact.sha256
    ) {
      throw new Error('TEST_EXECUTION_SCRIPT_SOURCE_ARTIFACT_INVALID')
    }
    return source
  }

  private async workspace(
    run: ExecutionRun,
    task: ExecutionTask,
    scriptRevision?: ScriptRevision,
    attempts: readonly ExecutionAttempt[] = [],
    diagnoses: readonly FailureDiagnosis[] = [],
    artifacts: readonly ExecutionArtifact[] = [],
  ) {
    const projection = await this.workspaceProvider.project({
      run: structuredClone(run),
      task: structuredClone(task),
      ...(scriptRevision ? { scriptRevision: structuredClone(scriptRevision) } : {}),
      attempts: structuredClone(attempts),
      diagnoses: structuredClone(diagnoses),
      artifacts: structuredClone(artifacts),
    })
    if (this.executionWorkspace) {
      const snapshot = await this.executionWorkspace.snapshot(run.projectVersionId)
      projection.workspaceFiles.push(...snapshot.files.map(file => ({
        logicalPath: `execution/${file.path}`,
        displayName: `Execution Workspace · ${file.path}`,
        content: file.content,
        contentSha256: file.contentSha256,
      })))
      const explorationResults = await this.executionWorkspace.listExplorationResults(run.projectVersionId)
      if (explorationResults.length) {
        const content = canonicalJson({
          schemaVersion: 'project-version-exploration-context/v1',
          projectVersionId: run.projectVersionId,
          environmentSignature: run.environment.signature,
          authority: 'runtime_observed_knowledge',
          requirementTruth: false,
          results: orderedExplorationResults(explorationResults, run, task, this.clock()),
        })
        projection.workspaceFiles.push({
          logicalPath: 'exploration/context.json',
          displayName: 'ProjectVersion Exploration Context · Runtime Observed Knowledge',
          content,
          contentSha256: sha256(content),
        })
      }
      projection.workspaceFiles.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath, 'en'))
    }
    if (
      projection.runId !== run.id
      || projection.projectId !== run.projectId
      || projection.projectVersionId !== run.projectVersionId
    ) {
      throw new Error('TEST_EXECUTION_WORKSPACE_SCOPE_MISMATCH')
    }
    return projection
  }

  private async persistWorkspaceImplementation(
    run: ExecutionRun,
    task: ExecutionTask,
    executionPackage: ExecutionPackage,
    bindingStatus: CaseExecutionBinding['bindingStatus'],
  ) {
    if (!this.executionWorkspace) return
    await this.executionWorkspace.writeFiles(run.projectVersionId, executionPackage.files)
    const entry = required(executionPackage.files.find(file => file.path === executionPackage.manifest.entrypoint), 'TEST_EXECUTION_PACKAGE_ENTRYPOINT_MISSING', '执行包缺少入口源码')
    const dependencyFiles = executionPackage.manifest.files.map(file => ({
      path: file.path,
      contentSha256: file.contentSha256,
    }))
    const now = this.clock()
    await this.executionWorkspace.saveBinding({
      projectVersionId: run.projectVersionId,
      caseId: task.input.caseId,
      executionType: executableMethod(task),
      entryFile: entry.path,
      entrySymbol: executionEntrySymbol(task.input.caseId),
      bindingStatus,
      entrySha256: entry.contentSha256,
      dependencyFiles,
      dependencySha256: executionBindingDependencySha256(dependencyFiles),
      caseContentSha256: task.input.caseContentSha256,
      createdAt: now,
      updatedAt: now,
    })
  }

  private async workspaceRunTarget(run: ExecutionRun, task: ExecutionTask, revision: ScriptRevision) {
    if (!this.executionWorkspace) return {}
    const binding = await this.executionWorkspace.resolveBinding(run.projectVersionId, task.input.caseId)
    if (
      !binding
      || binding.bindingStatus === 'invalid'
      || binding.entrySha256 !== revision.contentSha256
      || binding.caseContentSha256 !== task.input.caseContentSha256
      || binding.dependencySha256 !== executionBindingDependencySha256(revision.package.files)
    ) {
      throw new Error('TEST_EXECUTION_WORKSPACE_BINDING_DRIFT')
    }
    const [snapshot, authStateRoot] = await Promise.all([
      this.executionWorkspace.snapshot(run.projectVersionId),
      this.executionWorkspace.runtimeAuthRoot(run.projectVersionId, run.id),
    ])
    return {
      workspace: {
        root: snapshot.root,
        entryFile: binding.entryFile,
        entrySymbol: binding.entrySymbol,
        authStateRoot,
      },
    }
  }

  private async validatePassedWorkspaceBinding(run: ExecutionRun, task: ExecutionTask) {
    if (!this.executionWorkspace) return
    const revision = await this.currentRevision(task)
    const binding = await this.executionWorkspace.resolveBinding(
      run.projectVersionId,
      task.input.caseId,
    )
    if (
      !binding
      || binding.bindingStatus === 'invalid'
      || binding.executionType !== executableMethod(task)
      || binding.entrySha256 !== revision.contentSha256
      || binding.caseContentSha256 !== task.input.caseContentSha256
      || binding.dependencySha256 !== executionBindingDependencySha256(revision.package.files)
    ) {
      if (binding && binding.bindingStatus !== 'invalid') {
        await this.executionWorkspace.setBindingStatus(
          run.projectVersionId,
          task.input.caseId,
          'invalid',
        )
      }
      throw new Error('TEST_EXECUTION_WORKSPACE_BINDING_VALIDATION_FAILED')
    }
    if (binding.bindingStatus === 'needs_validation' || binding.bindingStatus === 'inherited') {
      await this.executionWorkspace.setBindingStatus(
        run.projectVersionId,
        task.input.caseId,
        'validated',
      )
    }
  }

  async cleanupRunRuntimeState(runId: string) {
    if (!this.executionWorkspace) return
    const run = await this.getRun(runId)
    if (!['succeeded', 'failed', 'partial', 'cancelled'].includes(run.status)) return
    await this.executionWorkspace.cleanupRuntimeAuth(run.projectVersionId, run.id)
  }

  private async withBrowserSession<T>(
    run: ExecutionRun,
    task: ExecutionTask,
    stage: BrowserToolStage,
    signal: AbortSignal,
    operation: (session?: BrowserToolSession) => Promise<T>,
  ) {
    if (task.input.method !== 'ui') return operation()
    if (!this.browserTools) throw new Error('TEST_EXECUTION_BROWSER_TOOLS_REQUIRED')
    const authPolicy = resolveAuthSessionPolicy(task.input)
    const authState = this.executionWorkspace
      && authPolicy.stateKey
      && authPolicy.role
      && ['reuse_authenticated', 'isolated_role'].includes(authPolicy.mode)
      ? await this.executionWorkspace.runtimeAuthStateAccess({
          projectVersionId: run.projectVersionId,
          runId: run.id,
          environmentSignature: run.environment.signature,
          baseUrl: run.environment.baseUrl,
          role: authPolicy.role,
          stateKey: authPolicy.stateKey,
        }, { writable: authPolicy.mode === 'reuse_authenticated' })
      : undefined
    const session = await this.browserTools.openSession({
      run,
      task,
      stage,
      authPolicy,
      ...(authState ? { authState } : {}),
    }, signal)
    let primaryError: unknown
    try {
      return await operation(session)
    } catch (error) {
      primaryError = error
      throw error
    } finally {
      try {
        await this.persistBrowserObservations(run, task, session.observations())
      } catch (error) {
        if (!primaryError) throw error
      } finally {
        try {
          await session.close()
        } catch (error) {
          if (!primaryError) throw error
        }
      }
    }
  }

  private async persistBrowserObservations(
    run: ExecutionRun,
    task: ExecutionTask,
    observations: readonly HttpExplorationObservation[],
  ) {
    if (!this.executionWorkspace || !observations.length) return
    const observedAt = this.clock()
    await this.executionWorkspace.saveExplorationResults(
      run.projectVersionId,
      observations.map(observation => createProjectVersionExplorationResult({
        projectVersionId: run.projectVersionId,
        sourceCaseId: task.input.caseId,
        environmentSignature: run.environment.signature,
        sourceRunId: run.id,
        sourceTaskId: task.id,
        observedAt,
        observation,
      })),
    )
  }

  private async uiExecutionContext(
    run: ExecutionRun,
    task: ExecutionTask,
    phase: UiExecutionAgentPhase,
    signal: AbortSignal,
    required = false,
  ) {
    if (task.input.method !== 'ui' || !this.executionWorkspace) return undefined
    if (!this.uiExecutionAgent) {
      if (required) throw new Error('TEST_EXECUTION_UI_AGENT_REQUIRED')
      return undefined
    }
    const context = await this.uiExecutionAgent.explore({
      baseUrl: run.environment.baseUrl,
      run,
      task,
      phase,
    }, signal)
    if (required && (!context || !context.available || !context.snapshot)) {
      throw new Error(`TEST_EXECUTION_UI_PLAYWRIGHT_CLI_EXPLORATION_REQUIRED: ${context?.error ?? 'snapshot missing'}`)
    }
    if (context?.networkObservations.length) {
      const observedAt = this.clock()
      await this.executionWorkspace.saveExplorationResults(
        run.projectVersionId,
        context.networkObservations.map(observation => createProjectVersionExplorationResult({
          projectVersionId: run.projectVersionId,
          sourceCaseId: task.input.caseId,
          environmentSignature: run.environment.signature,
          sourceRunId: run.id,
          sourceTaskId: task.id,
          observedAt,
          observation,
        })),
      )
    }
    return context
  }
}

function orderedExplorationResults(
  results: readonly ProjectVersionExplorationResult[],
  run: ExecutionRun,
  task: ExecutionTask,
  currentTime: string,
) {
  const search = explorationSearchText(task)
  return results.slice().sort((left, right) => {
    const leftScore = explorationRelevance(left, run, search)
    const rightScore = explorationRelevance(right, run, search)
    return rightScore - leftScore
      || right.observedAt.localeCompare(left.observedAt)
      || left.id.localeCompare(right.id, 'en')
  }).map(result => ({
    ...result,
    reuseRecommendation: explorationReuseRecommendation(result, run, currentTime),
  }))
}

function explorationReuseRecommendation(
  result: ProjectVersionExplorationResult,
  run: ExecutionRun,
  currentTime: string,
) {
  if (result.validationStatus === 'invalid') return 'do_not_reuse'
  if (result.environmentSignature !== run.environment.signature) return 'context_only_environment_mismatch'
  const age = Date.parse(currentTime) - Date.parse(result.observedAt)
  const fresh = Number.isFinite(age) && age >= 0 && age <= 30 * 24 * 60 * 60 * 1_000
  return result.validationStatus === 'validated' && fresh
    ? 'prefer_reuse'
    : 'reuse_with_validation'
}

function explorationRelevance(
  result: ProjectVersionExplorationResult,
  run: ExecutionRun,
  search: Set<string>,
) {
  let score = 0
  if (result.environmentSignature === run.environment.signature) score += 100
  if (result.validationStatus === 'validated') score += 50
  else if (result.validationStatus === 'needs_validation') score += 10
  const candidate = `${result.sourceCaseId} ${result.path}`.toLocaleLowerCase()
  for (const token of search) if (candidate.includes(token)) score += 5
  return score
}

function explorationSearchText(task: ExecutionTask) {
  const content = task.input.caseContent
  const text = [
    task.input.caseId,
    content.title,
    ...content.steps,
    ...content.expectedResults,
    ...content.requirementRefs,
  ].join(' ').toLocaleLowerCase()
  return new Set(text.match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])
}

function validateModernHandoff(handoff: TestExecutionHandoff, projectVersionId: string) {
  if (handoff.projectVersionId !== projectVersionId) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_HANDOFF_SCOPE_MISMATCH',
      'Execution Handoff 不属于目标项目版本',
      404,
    )
  }
  const canonical = {
    projectId: handoff.projectId,
    projectVersionId: handoff.projectVersionId,
    testCaseLibraryVersionId: handoff.testCaseLibraryVersionId,
    ...(handoff.suiteVersionId ? { suiteVersionId: handoff.suiteVersionId } : {}),
    mode: handoff.mode,
    members: handoff.members,
  }
  if (canonicalSha256(canonical) !== handoff.contentSha256) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_HANDOFF_CONTENT_HASH_MISMATCH',
      'Execution Handoff 内容 Hash 无效',
    )
  }
  return handoff
}

function validateLibraryVersion(library: TestCaseLibraryVersionDetail, projectId: string, projectVersionId?: string) {
  if (library.projectId !== projectId || (projectVersionId && library.projectVersionId !== projectVersionId) || !library.members.length) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_LIBRARY_VERSION_MISMATCH',
      '固定用例库版本与执行交接不一致',
    )
  }
  if (!library.sourceRunId) throw new TestExecutionServiceError('TEST_EXECUTION_LIBRARY_SOURCE_INVALID', '固定用例库版本缺少来源 Run')
  const canonical = {
    schemaVersion: 'test-case-library/v3',
    projectId,
    sourceRunId: library.sourceRunId,
    members: library.members,
  }
  if (canonicalSha256(canonical) !== library.contentSha256) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_LIBRARY_CONTENT_HASH_MISMATCH',
      '固定用例库版本内容 Hash 无效',
    )
  }
}

function normalizeExecutionTestDataBindings(value: unknown): ExecutionTestDataBinding[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 10_000) throw new TestExecutionServiceError('TEST_EXECUTION_TEST_DATA_BINDINGS_INVALID', 'testDataBindings 必须是最多 10000 项的数组', 400)
  const seen = new Set<string>()
  const bindings = value.map((candidate, index): ExecutionTestDataBinding => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new TestExecutionServiceError('TEST_EXECUTION_TEST_DATA_BINDINGS_INVALID', `testDataBindings[${index}] 必须是对象`, 400)
    const input = candidate as Record<string, unknown>
    const unknownFields = Object.keys(input).filter(key => !['requirementId', 'sourceType', 'sourceRef', 'preparationNote'].includes(key))
    if (unknownFields.length) throw new TestExecutionServiceError('TEST_EXECUTION_TEST_DATA_BINDINGS_INVALID', `testDataBindings[${index}] 包含未知字段`, 400, { fields: unknownFields })
    const requirementId = boundedExecutionText(input.requirementId, `testDataBindings[${index}].requirementId`, 500)
    if (seen.has(requirementId)) throw new TestExecutionServiceError('TEST_EXECUTION_TEST_DATA_BINDINGS_INVALID', `测试数据需求 ${requirementId} 重复绑定`, 400)
    seen.add(requirementId)
    const sourceType = String(input.sourceType ?? '')
    if (!['fixture', 'generator', 'data_reference'].includes(sourceType)) throw new TestExecutionServiceError('TEST_EXECUTION_TEST_DATA_BINDINGS_INVALID', `testDataBindings[${index}].sourceType 无效`, 400)
    const sourceRef = boundedExecutionText(input.sourceRef, `testDataBindings[${index}].sourceRef`, 2_000)
    const preparationNote = typeof input.preparationNote === 'string' && input.preparationNote.trim() ? input.preparationNote.trim().slice(0, 2_000) : undefined
    const serialized = canonicalJson({ sourceRef, ...(preparationNote ? { preparationNote } : {}) })
    if (/(?:password|passwd|api[_ -]?key|authorization|cookie|token|身份证|真实账号)\s*[:=]\s*[^<\s]/iu.test(serialized)) throw new TestExecutionServiceError('TEST_EXECUTION_TEST_DATA_SECRET_FORBIDDEN', '测试执行数据只能保存受控 Fixture、生成器或数据引用，禁止提交真实凭据和个人敏感值', 422, { requirementId })
    return { requirementId, sourceType: sourceType as ExecutionTestDataBinding['sourceType'], sourceRef, ...(preparationNote ? { preparationNote } : {}) }
  })
  return bindings.sort((left, right) => left.requirementId.localeCompare(right.requirementId, 'en'))
}

function freezeExecutionTestDataSnapshot(bindings: ExecutionTestDataBinding[]): FrozenExecutionTestDataSnapshot | undefined {
  if (bindings.length) throw new TestExecutionServiceError('TEST_EXECUTION_TEST_DATA_BINDING_UNEXPECTED', 'TestCase v3 不声明结构化数据需求；请在执行脚本或环境配置中引用受控测试数据', 422)
  return undefined
}

function boundedExecutionText(value: unknown, field: string, max: number) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > max) throw new TestExecutionServiceError('TEST_EXECUTION_TEST_DATA_BINDINGS_INVALID', `${field} 无效`, 400)
  return normalized
}

function validateSuiteVersion(
  handoff: TestExecutionHandoff & {
    testCaseLibraryVersionId: string
    mode: NonNullable<TestExecutionHandoff['mode']>
  },
  library: TestCaseLibraryVersionDetail,
) {
  if (handoff.mode === 'full') {
    if (handoff.suiteVersionId) {
      throw new TestExecutionServiceError(
        'TEST_EXECUTION_SUITE_FORBIDDEN',
        'full 模式不能固定测试套件',
      )
    }
    return
  }
  throw new TestExecutionServiceError('TEST_EXECUTION_SCOPE_INVALID', '执行 Run 只支持当前正式用例库的全部用例')
}

function taskScriptCacheKey(run: ExecutionRun, task: ExecutionTask) {
  const executionImplementation = requiredExecutionImplementation(run)
  return scriptCacheKey({
    caseId: task.input.caseId,
    caseRevision: task.input.caseRevision,
    method: executableMethod(task),
    caseContentSha256: task.input.caseContentSha256,
    executionSpecSha256: task.input.executionSpecSha256,
    taskInputSha256: task.input.inputSha256,
    environmentSignature: run.environment.signature,
    executionImplementationAgentVersion: executionImplementation.configurationVersion,
    executionImplementationAgentConfigurationSha256: executionImplementation.configurationSha256,
  })
}

function executableMethod(task: ExecutionTask) {
  if (task.input.method !== 'ui' && task.input.method !== 'api') {
    throw new Error('TEST_EXECUTION_METHOD_UNSUPPORTED')
  }
  return task.input.method
}

function attemptKind(
  task: ExecutionTask,
  revision: ScriptRevision,
  attempts: readonly ExecutionAttempt[],
  revisionAttempts: readonly ExecutionAttempt[],
): ExecutionAttemptKind {
  if (task.status === 'retrying') return 'same_script_retry'
  if (!revisionAttempts.length && revision.source === 'repair') return 'post_repair'
  if (!attempts.length) return 'initial'
  if (attempts.at(-1)?.status === 'infrastructure_error') return 'infrastructure_retry'
  return 'manual_retry'
}

function diagnosisTaskStatus(
  diagnosis: Pick<FailureDiagnosis, 'category'>,
  repairCount: number,
): 'repairing' | 'failed' | 'blocked' | 'waiting_manual' {
  if (automaticRepairAllowed(diagnosis, repairCount)) return 'repairing'
  if (diagnosis.category === 'product_defect' || diagnosis.category === 'assertion_mismatch') return 'failed'
  if (
    diagnosis.category === 'environment_defect'
    || diagnosis.category === 'test_data_defect'
    || diagnosis.category === 'timeout'
  ) return 'blocked'
  return 'waiting_manual'
}

function failureDiagnosisPolicy(
  category: FailureDiagnosis['category'],
): Pick<FailureDiagnosis, 'repairable' | 'recommendedAction'> {
  if (category === 'script_defect' || category === 'selector_changed') {
    return {
      repairable: true,
      recommendedAction: '服务端将在修复次数限制内尝试受控脚本修复',
    }
  }
  const actions: Record<Exclude<FailureDiagnosis['category'], 'script_defect' | 'selector_changed'>, string> = {
    product_defect: '记录产品缺陷，不进入脚本修复 Stage',
    environment_defect: '检查执行环境后人工重试',
    test_data_defect: '补齐或修正测试数据后人工重试',
    flaky: '保留失败证据并人工判断是否重试',
    assertion_mismatch: '核对正式预期；禁止自动修改受保护断言',
    timeout: '检查环境、等待条件或性能约束后人工重试',
    planning: '根据确定性失败事实检查规划策略与前置条件',
    tool_selection: '根据 Tool Trace 与资料检查工具选择',
    tool_argument: '根据参数断言检查工具参数构造',
    tool_sequence: '根据顺序断言检查工具调用次序',
    prompt: '结合可用 Prompt 资料提出候选原因，等待人工确认',
    context: '结合输入与上下文证据检查上下文处理',
    model: '结合冻结模型信息提出模型行为候选原因',
    tool_schema: '结合可用 Tool 文档检查工具 Schema',
    mcp: '结合 MCP Trace 与文档检查 MCP 交互',
    workflow: '结合可用 Workflow 资料检查编排路径',
    knowledge: '结合检索证据与 Knowledge 资料检查知识使用',
    memory: '结合可见 Memory 证据检查记忆处理',
    runtime: '检查 Agent Runtime 错误与超时证据',
    business_backend: '检查业务结果与后端状态证据',
    unknown: '保留失败证据并等待人工处理',
  }
  return { repairable: false, recommendedAction: actions[category] }
}

function deterministicFlakyDiagnosis(input: {
  run: ExecutionRun
  task: ExecutionTask
  revision: ScriptRevision
  failure: ExecutionAttempt
  success: ExecutionAttempt
  createdAt: string
}): FailureDiagnosis {
  const attemptIds = [input.failure.id, input.success.id]
  return {
    id: stableIdentity('test_execution_diagnosis', {
      taskId: input.task.id,
      scriptRevisionId: input.revision.id,
      attemptIds,
    }),
    runId: input.run.id,
    taskId: input.task.id,
    scriptRevisionId: input.revision.id,
    attemptIds,
    category: 'flaky',
    confidence: 1,
    summary: '相同 ScriptRevision 与 ExecutionPackage 首次失败、固定重试成功',
    evidence: [
      { attemptId: input.failure.id, observation: '首次真实 Runner Attempt 失败' },
      { attemptId: input.success.id, observation: '同一 ScriptRevision 与 package hash 的固定重试成功' },
    ],
    repairable: false,
    recommendedAction: '记录 flaky，不进入脚本修复 Stage',
    source: 'deterministic',
    createdAt: input.createdAt,
  }
}

async function appendRunnerArtifacts(
  transaction: TestExecutionTransaction,
  runId: string,
  taskId: string,
  attemptId: string,
  artifacts: ReadonlyArray<{
    type: ExecutionArtifact['type']
    storagePath: string
    sha256: string
    size: number
    mimeType: string
  }>,
  createdAt: string,
) {
  const appended: ExecutionArtifact[] = []
  for (const [index, artifact] of artifacts.entries()) {
    const value: ExecutionArtifact = {
      id: stableIdentity('test_execution_artifact', {
        runId,
        taskId,
        attemptId,
        type: artifact.type,
        sha256: artifact.sha256,
        index,
      }),
      runId,
      taskId,
      attemptId,
      ...artifact,
      createdAt,
    }
    await transaction.appendArtifact(value)
    appended.push(value)
  }
  return appended
}

function normalizeRunnerExecutionEvents(input: {
  run: ExecutionRun
  task: ExecutionTask
  attemptId: string
  result: Awaited<ReturnType<PlaywrightRunner['execute']>>
  artifacts: readonly ExecutionArtifact[]
  finishedAt: string
}): ExecutionEvent[] {
  const bySha256 = new Map(input.artifacts.map(artifact => [artifact.sha256, artifact.id]))
  const source = input.result.events?.length ? input.result.events : [{
    sequence: 1,
    type: 'runner' as const,
    title: input.result.status === 'passed' ? 'Runner 执行完成' : 'Runner 执行未通过',
    status: input.result.status === 'passed' ? 'passed' as const : input.result.status === 'cancelled' ? 'skipped' as const : 'failed' as const,
    startedAt: new Date(Date.parse(input.finishedAt) - input.result.durationMs).toISOString(),
    finishedAt: input.finishedAt,
    durationMs: input.result.durationMs,
    metadata: { source: 'runner_result' },
  }]
  return source.map((event, index) => {
    const sequence = index + 1
    const startedAt = safeExecutionEventTimestamp(event.startedAt, input.finishedAt)
    const durationMs = Number.isSafeInteger(event.durationMs) && event.durationMs! >= 0
      ? Math.min(event.durationMs!, 24 * 60 * 60 * 1_000)
      : undefined
    const finishedAt = event.finishedAt
      ? safeExecutionEventTimestamp(event.finishedAt, input.finishedAt)
      : durationMs === undefined
        ? undefined
        : new Date(Date.parse(startedAt) + durationMs).toISOString()
    const artifactIds = [...new Set((event.artifactSha256s ?? []).map(sha256 => {
      const artifactId = bySha256.get(sha256)
      if (!artifactId) throw new Error('TEST_EXECUTION_EVENT_ARTIFACT_NOT_FOUND')
      return artifactId
    }))]
    const title = redactExecutionEventText(event.title).slice(0, 500)
    if (!title) throw new Error('TEST_EXECUTION_EVENT_TITLE_REQUIRED')
    return {
      id: stableIdentity('test_execution_event', {
        attemptId: input.attemptId,
        sequence,
        type: event.type,
        title,
      }),
      runId: input.run.id,
      taskId: input.task.id,
      attemptId: input.attemptId,
      sequence,
      type: event.type,
      title,
      status: event.status,
      startedAt,
      ...(finishedAt ? { finishedAt } : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(artifactIds.length ? { artifactIds } : {}),
      ...(event.metadata ? { metadata: redactExecutionMetadata(event.metadata) as Record<string, unknown> } : {}),
    }
  })
}

function safeExecutionEventTimestamp(value: string, fallback: string) {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback
}

function redactExecutionMetadata(value: unknown, key = '', depth = 0): unknown {
  if (depth > 6) return '<REDACTED_DEPTH>'
  if (/authorization|cookie|password|token|api.?key|secret|session|csrf/iu.test(key)) return '<REDACTED>'
  if (typeof value === 'string') return redactExecutionEventText(value).slice(0, 2_000)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactExecutionMetadata(item, key, depth + 1))
  if (!value || typeof value !== 'object') return undefined
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .slice(0, 100)
    .map(([childKey, child]) => [childKey, redactExecutionMetadata(child, childKey, depth + 1)]))
}

function redactExecutionEventText(value: string) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/gu, ' ')
    .replace(/https?:\/\/[^\s"')]+/giu, raw => {
      try { return new URL(raw).pathname } catch { return '<redacted-url>' }
    })
    .replace(/\/[A-Za-z0-9._~%/-]+\?[^\s"')]+/giu, raw => {
      try { return new URL(raw, 'https://smarthub.invalid').pathname } catch { return '<redacted-path>' }
    })
    .replace(
      /\b(authorization|cookie|set-cookie|password|token|api[_ -]?key|secret|session|csrf)\b\s*[:=]\s*[^\s,;]+/giu,
      '$1=<REDACTED>',
    )
    .trim()
}

function lineDifference(fromSource: string, toSource: string) {
  const from = fromSource.split('\n')
  const to = toSource.split('\n')
  let prefix = 0
  while (prefix < from.length && prefix < to.length && from[prefix] === to[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < from.length - prefix
    && suffix < to.length - prefix
    && from[from.length - suffix - 1] === to[to.length - suffix - 1]
  ) {
    suffix += 1
  }
  return {
    unchangedPrefixLines: prefix,
    removed: {
      startLine: prefix + 1,
      lines: from.slice(prefix, from.length - suffix),
    },
    added: {
      startLine: prefix + 1,
      lines: to.slice(prefix, to.length - suffix),
    },
    unchangedSuffixLines: suffix,
  }
}

function revisionSourceBundle(files: readonly Pick<ExecutionPackageFile, 'path' | 'content'>[]) {
  return files
    .flatMap(file => [`// smarthub:file ${file.path}`, file.content])
    .join('\n')
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

function assertAgentOutputSchema(
  output: TestExecutionAgentRuntimeOutput,
  expected: TestExecutionAgentRuntimeOutput['schemaVersion'],
) {
  if (output.schemaVersion !== expected) {
    throw new Error('TEST_EXECUTION_AGENT_OUTPUT_SCHEMA_MISMATCH')
  }
}

function applyAgentEvaluationCandidate(
  result: AgentExecutionAggregateResult,
  candidate: Record<string, unknown>,
  modelSnapshotRef: string,
): AgentExecutionAggregateResult {
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
    const criterion = boundedEvaluationText(item.criterion, 'criterion', 4000)
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
      explanation: boundedEvaluationText(item.explanation, 'explanation', 8000),
      evidenceRefs,
      modelSnapshotRef,
    })
  }
  if (remaining.length) throw new Error('AGENT_EVALUATION_CRITERION_MISSING')
  const caseRuns = result.caseRuns.map(caseRun => {
    const evaluationResults = caseRun.evaluationResults.map(item => replacements.get(item.id) ?? item)
    const status = caseRun.status === 'ERROR'
      ? 'ERROR' as const
      : [...caseRun.assertionResults, ...evaluationResults].some(item => item.status === 'FAIL')
        ? 'FAIL' as const
        : [...caseRun.assertionResults, ...evaluationResults].some(item => item.status === 'NOT_EVALUABLE')
          ? 'NOT_EVALUABLE' as const
          : 'PASS' as const
    return { ...caseRun, evaluationResults, status }
  })
  const count = caseRuns.length
  const rate = (status: typeof caseRuns[number]['status']) => caseRuns.filter(item => item.status === status).length / count
  const status = caseRuns.some(item => item.status === 'ERROR') ? 'ERROR'
    : caseRuns.some(item => item.status === 'FAIL') ? 'FAIL'
      : caseRuns.some(item => item.status === 'NOT_EVALUABLE') ? 'NOT_EVALUABLE'
        : 'PASS'
  return { ...result, caseRuns, status, successRate: rate('PASS'), failureRate: rate('FAIL'), notEvaluableRate: rate('NOT_EVALUABLE'), errorRate: rate('ERROR') }
}

function boundedEvaluationText(value: unknown, field: string, maxLength: number) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > maxLength) throw new Error(`AGENT_EVALUATION_${field.toUpperCase()}_INVALID`)
  return normalized
}

function candidateValidator<T>(validate: (candidate: Record<string, unknown>) => T) {
  return async (candidate: Record<string, unknown>, _manifest: InputDeliveryManifest) => {
    try {
      const result = validate(candidate)
      return {
        valid: true,
        result: structuredClone(result) as Record<string, unknown>,
        issues: [],
      }
    } catch (error) {
      return {
        valid: false,
        issues: [{ path: '/', message: error instanceof Error ? error.message : String(error) }],
      }
    }
  }
}

function packageCandidate(
  candidate: Record<string, unknown>,
  expectedSchemaVersion: 'test-script-generation/v1' | 'script-repair/v1',
): ExecutionPackageCandidate {
  if (candidate.schemaVersion !== undefined && candidate.schemaVersion !== expectedSchemaVersion) {
    throw new Error('TEST_EXECUTION_AGENT_OUTPUT_SCHEMA_MISMATCH')
  }
  const allowed = new Set(['schemaVersion', 'entryFile', 'files', 'summary'])
  if (Object.keys(candidate).some(key => !allowed.has(key))) {
    throw new Error('TEST_EXECUTION_PACKAGE_CANDIDATE_SYSTEM_FIELD_FORBIDDEN')
  }
  const files = Array.isArray(candidate.files)
    ? candidate.files.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('TEST_EXECUTION_PACKAGE_CANDIDATE_INVALID')
        }
        const file = value as Record<string, unknown>
        if (Object.keys(file).some(key => !['path', 'content'].includes(key))) {
          throw new Error('TEST_EXECUTION_PACKAGE_CANDIDATE_SYSTEM_FIELD_FORBIDDEN')
        }
        return {
          path: String(file.path ?? ''),
          content: typeof file.content === 'string' ? file.content : '',
        }
      })
    : []
  return {
    entryFile: String(candidate.entryFile ?? ''),
    files,
    ...(candidate.summary === undefined ? {} : { summary: String(candidate.summary) }),
  }
}

async function requiredLeaseTransaction<T>(
  store: TestExecutionStore,
  jobId: string,
  lease: ExecutionJobLease,
  operation: (transaction: TestExecutionTransaction) => Promise<T>,
) {
  const result = await store.transactionWithLease(jobId, lease, operation)
  if (result === null) throw new Error('TEST_EXECUTION_LEASE_LOST')
  return result
}

function agentExecutionEnvironment(agentUnderTest: NonNullable<ExecutionEnvironmentSnapshot['agentUnderTest']>): ExecutionEnvironmentSnapshot {
  const url = new URL(agentUnderTest.endpoint)
  const base = {
    schemaVersion: 'agent-test-execution-environment/v1',
    environmentId: `agent-under-test:${agentUnderTest.id}:v${agentUnderTest.version}`,
    name: agentUnderTest.name,
    baseUrl: agentUnderTest.endpoint,
    targets: [{ protocol: url.protocol.slice(0, -1) as 'http' | 'https', host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) }],
    agentUnderTest: structuredClone(agentUnderTest),
  }
  return { ...base, signature: canonicalSha256(base) }
}

function assertAgentSnapshots(agents: ExecutionRun['agents']) {
  const values = [agents.executionImplementation, agents.failureAnalysis].filter((value): value is FrozenExecutionAgentSnapshot => Boolean(value))
  values.forEach(snapshot => {
    const { snapshotSha256, ...base } = snapshot
    if (
      !['execution-implementation', 'failure-analysis'].includes(snapshot.agentKey)
      || canonicalSha256(base) !== snapshotSha256
    ) throw new Error('TEST_EXECUTION_AGENT_SNAPSHOT_INVALID')
  })
  if (agents.failureAnalysis.agentKey !== 'failure-analysis') throw new Error('TEST_EXECUTION_AGENT_SNAPSHOT_INVALID')
}

function assertFrozenRunner(run: ExecutionRun, actual: ExecutionRun['runner']) {
  if (canonicalSha256(run.runner) !== canonicalSha256(actual)) {
    throw new Error('TEST_EXECUTION_RUNNER_SNAPSHOT_DRIFT')
  }
}

function requiredIdentity(value: string | undefined, field: string) {
  const normalized = String(value ?? '').trim()
  if (!normalized || normalized.length > 500 || /[\u0000-\u001F\u007F]/u.test(normalized)) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_IDENTITY_INVALID',
      `${field} 无效`,
      400,
    )
  }
  return normalized
}

function requiredUrl(value: string | undefined) {
  const normalized = String(value ?? '').trim()
  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_BASE_URL_INVALID',
      '被测系统地址必须是有效的 http 或 https 地址',
      400,
    )
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.hash
  ) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_BASE_URL_INVALID',
      '被测系统地址必须是有效的 http 或 https 地址',
      400,
    )
  }
  return url.toString()
}

function required<T>(
  value: T | null | undefined,
  code: string,
  message: string,
  status = 422,
): T {
  if (value === null || value === undefined) {
    throw new TestExecutionServiceError(code, message, status)
  }
  return value
}

function requiredExecutionImplementation(run: ExecutionRun): FrozenExecutionAgentSnapshot {
  return required(
    run.agents.executionImplementation,
    'TEST_EXECUTION_IMPLEMENTATION_AGENT_SNAPSHOT_REQUIRED',
    '脚本执行链缺少冻结的 ExecutionImplementationAgent 配置',
  )
}

function publicArtifact(artifact: ExecutionArtifact) {
  const { storagePath: _storagePath, ...metadata } = artifact
  return metadata
}

function requireStateVersion(value: number, resource: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_STATE_VERSION_INVALID',
      `${resource} stateVersion 无效`,
      400,
    )
  }
}

function storeCommandError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const code = message.split(':', 1)[0]
  if (code.endsWith('_NOT_FOUND')) {
    return new TestExecutionServiceError(code, '测试执行资源不存在', 404)
  }
  if (code.includes('STATE_VERSION') || code.includes('STATE_CONFLICT')) {
    return new TestExecutionServiceError(code, '测试执行状态版本已变化', 412)
  }
  if (
    code.includes('NOT_CANCELLABLE')
    || code.includes('NOT_RETRYABLE')
    || code.includes('IDEMPOTENCY_CONFLICT')
  ) {
    return new TestExecutionServiceError(code, '测试执行命令与当前状态冲突', 409)
  }
  return error
}

function stableIdentity(prefix: string, value: unknown) {
  return `${prefix}_${canonicalSha256(value).slice(0, 40)}`
}

function caseRevisionKey(caseId: string, revision: number) {
  return `${caseId}\u0000${revision}`
}

function taskEntrypoint(taskId: string) {
  return `tests/${taskId}.spec.ts`
}

function retryableFailure(error?: string, summary?: string) {
  return /(?:timeout|timed? out|ECONNRESET|ECONNREFUSED|temporary network|network error)/iu.test(`${error ?? ''}\n${summary ?? ''}`)
}

function terminalTaskStatus(status: ExecutionTask['status']) {
  return ['passed', 'failed', 'blocked', 'unsupported', 'waiting_manual', 'cancelled'].includes(status)
}

function elapsedMilliseconds(startedAt: string, finishedAt: string) {
  const duration = Date.parse(finishedAt) - Date.parse(startedAt)
  return Number.isFinite(duration) ? Math.max(0, duration) : 0
}

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('TEST_EXECUTION_ABORTED')
}
