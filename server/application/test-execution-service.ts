import { createHash } from 'node:crypto'
import type { InputDeliveryManifest, TestExecutionAgentWorkspaceProjection } from '../domain/agent-types.js'
import type {
  CaseMaintenanceProposal,
  ExecutionArtifact,
  ExecutionAttempt,
  ExecutionAttemptKind,
  ExecutionEnvironmentSnapshot,
  ExecutionJob,
  ExecutionPackage,
  ExecutionPackageCandidate,
  ExecutionRun,
  ExecutionTask,
  ExecutionTestDataBinding,
  FailureDiagnosis,
  FrozenExecutionTestDataSnapshot,
  FrozenExecutionAgentSnapshot,
  ScriptArtifact,
  ScriptRevision,
} from '../domain/test-execution-types.js'
import type {
  TestCaseLibraryVersionDetail,
  TestExecutionHandoff,
  TestSuiteVersion,
} from '../domain/test-design-types.js'
import type {
  TestExecutionAgentRuntimeInput,
  TestExecutionAgentRuntimeOutput,
} from '../agent/pi-test-execution-runtime.js'
import type { ExecutionArtifactStore } from '../infrastructure/execution-artifact-store.js'
import { executionArtifactBody } from '../infrastructure/execution-artifact-store.js'
import type {
  ExecutionJobLease,
  TestExecutionStore,
  TestExecutionTransaction,
} from '../infrastructure/test-execution-store.js'
import type { PlaywrightRunner } from '../runner/playwright-runner.js'
import { canonicalJson, canonicalSha256 } from './canonical-json.js'
import {
  assertExecutionPackageIntegrity,
  automaticRepairAllowed,
  buildExecutionPackage,
  freezeExecutionTaskInput,
  scriptCacheKey,
  scriptMaintenanceSemanticSha256,
  unsupportedExecutionMethodReason,
  validateFailureDiagnosisCandidate,
} from './test-execution-validation.js'

export interface ImmutableTestExecutionSourceReader {
  getHandoff(handoffId: string): Promise<TestExecutionHandoff>
  getLibraryVersion(projectId: string, versionId: string): Promise<TestCaseLibraryVersionDetail>
  getSuite(projectId: string, suiteVersionId: string): Promise<TestSuiteVersion>
}

export interface ExecutionEnvironmentResolver {
  readiness(): Promise<{ ready: boolean; reason?: string }>
  resolveSnapshot(environmentId: string): Promise<ExecutionEnvironmentSnapshot>
  listSnapshots?(): ExecutionEnvironmentSnapshot[]
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
  execute(
    input: TestExecutionAgentRuntimeInput,
    signal: AbortSignal,
  ): Promise<TestExecutionAgentRuntimeOutput>
}

export type CreateTestExecutionRunInput = {
  projectVersionId: string
  handoffId: string
  environmentId: string
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
    }
  }

  environments() {
    return (this.environmentResolver.listSnapshots?.() ?? [])
      .map(environment => structuredClone(environment))
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
      diagnoses: snapshot.diagnoses,
      scriptRevisions: snapshot.scriptRevisions,
      artifacts: snapshot.artifacts.map(publicArtifact),
      maintenanceProposals: snapshot.maintenanceProposals,
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
    const [fromArtifact, toArtifact] = await Promise.all([
      this.store.getArtifact(from.sourceArtifactId),
      this.store.getArtifact(to.sourceArtifactId),
    ])
    const [fromSource, toSource] = await Promise.all([
      this.readScriptSource(required(
        fromArtifact,
        'TEST_EXECUTION_SCRIPT_SOURCE_ARTIFACT_NOT_FOUND',
        '起始 ScriptRevision 缺少源码 Artifact',
      )),
      this.readScriptSource(required(
        toArtifact,
        'TEST_EXECUTION_SCRIPT_SOURCE_ARTIFACT_NOT_FOUND',
        '目标 ScriptRevision 缺少源码 Artifact',
      )),
    ])
    return {
      fromRevision: from,
      toRevision: to,
      changes: lineDifference(fromSource, toSource),
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
    const handoffId = requiredIdentity(input.handoffId, 'handoffId')
    const environmentId = requiredIdentity(input.environmentId, 'environmentId')
    const idempotencyKey = requiredIdentity(input.idempotencyKey, 'idempotencyKey')
    const createdBy = requiredIdentity(input.createdBy, 'createdBy')
    const requestedTestDataBindings = normalizeExecutionTestDataBindings(input.testDataBindings)
    const replay = await this.store.getRunByIdempotencyKey(projectVersionId, idempotencyKey)
    if (replay) {
      if (
        replay.handoff.handoffId !== handoffId
        || replay.environment.environmentId !== environmentId
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

    const handoff = await this.sources.getHandoff(handoffId)
    const modern = validateModernHandoff(handoff, projectVersionId)
    const library = await this.sources.getLibraryVersion(
      modern.projectId,
      modern.testCaseLibraryVersionId,
    )
    validateLibraryVersion(library, modern.projectId)
    const testData = freezeExecutionTestDataSnapshot(modern, library, requestedTestDataBindings)
    const suite = modern.suiteVersionId
      ? await this.sources.getSuite(modern.projectId, modern.suiteVersionId)
      : undefined
    validateSuiteVersion(modern, library, suite)

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
    if (
      new Set(frozenInputs.map(item => item.ordinal)).size !== frozenInputs.length
      || new Set(frozenInputs.map(item => item.dedupKey)).size !== frozenInputs.length
    ) {
      throw new TestExecutionServiceError(
        'TEST_EXECUTION_HANDOFF_MEMBER_DUPLICATE',
        '执行交接包含重复 ordinal 或 dedupKey',
      )
    }

    const [environment, agents, runnerReadiness] = await Promise.all([
      this.sourcesEnvironment(environmentId),
      this.agentRuntime.freezeConfiguration(),
      this.runner.readiness(),
    ])
    if (!runnerReadiness.ready) {
      throw new TestExecutionServiceError(
        'TEST_EXECUTION_RUNNER_UNAVAILABLE',
        runnerReadiness.reason ?? 'Playwright Runner 不可用',
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
        ...(suite ? {
          suiteVersionId: suite.id,
          suiteVersionSha256: suite.contentSha256,
        } : {}),
        mode: modern.mode,
        memberSnapshotSha256: canonicalSha256(frozenInputs),
      },
      environment,
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
      if (terminalTaskStatus(task.status)) return task
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

  private async sourcesEnvironment(environmentId: string) {
    const environment = await this.environmentResolver.resolveSnapshot(environmentId)
    if (environment.environmentId !== environmentId) {
      throw new TestExecutionServiceError(
        'TEST_EXECUTION_ENVIRONMENT_SCOPE_MISMATCH',
        '环境解析器返回了错误的环境身份',
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
    const cacheKey = taskScriptCacheKey(run, task)
    const cached = await this.store.getScriptArtifactByCacheKey(cacheKey)
    if (!cached) {
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
      return
    }
    const sourceRevision = required(
      await this.store.getCacheSourceRevision(cached.id),
      'TEST_EXECUTION_SCRIPT_CACHE_SOURCE_NOT_FOUND',
      '脚本缓存缺少不可变来源 Revision',
    )
    const sourceArtifact = required(
      await this.store.getArtifact(sourceRevision.sourceArtifactId),
      'TEST_EXECUTION_SCRIPT_CACHE_ARTIFACT_NOT_FOUND',
      '脚本缓存缺少不可变源码 Artifact',
    )
    const source = await this.readScriptSource(sourceArtifact)
    const executionPackage = buildExecutionPackage({
      candidate: {
        schemaVersion: 'test-script-generation/v1',
        taskId: task.id,
        files: [{ path: taskEntrypoint(task.id), content: source }],
        summary: '复用服务端校验的脚本缓存',
      },
      task: { ...task.input, taskId: task.id },
      environmentSignature: run.environment.signature,
    })
    await this.persistScriptRevision({
      job,
      lease,
      run,
      task,
      expectedStatus: 'pending',
      scriptArtifact: cached,
      executionPackage,
      source: 'cache',
      cacheSourceRevisionId: sourceRevision.id,
      generatedBy: run.agents.testScript,
      incrementRepair: false,
    })
    if (signal.aborted) throw abortError(signal)
  }

  private async generateScript(
    job: ExecutionJob,
    lease: ExecutionJobLease,
    run: ExecutionRun,
    task: ExecutionTask,
    signal: AbortSignal,
  ) {
    const workspace = await this.workspace(run, task)
    const output = await this.agentRuntime.execute({
      stage: 'script_generation',
      run,
      task,
      workspace,
      validateCandidate: candidateValidator(candidate => buildExecutionPackage({
        candidate: packageCandidate(candidate),
        task: { ...task.input, taskId: task.id },
        environmentSignature: run.environment.signature,
      })),
    }, signal)
    assertAgentOutputSchema(output, 'test-script-generation/v1')
    const executionPackage = buildExecutionPackage({
      candidate: packageCandidate(output.candidate),
      task: { ...task.input, taskId: task.id },
      environmentSignature: run.environment.signature,
    })
    const createdAt = this.clock()
    const cacheKey = taskScriptCacheKey(run, task)
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
        testScriptAgentVersion: run.agents.testScript.configurationVersion,
        testScriptAgentConfigurationSha256: run.agents.testScript.configurationSha256,
        createdAt,
      },
      executionPackage,
      source: 'agent',
      generatedBy: run.agents.testScript,
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
    const build = (candidate: Record<string, unknown>) => buildExecutionPackage({
      candidate: packageCandidate(candidate),
      task: { ...task.input, taskId: task.id },
      environmentSignature: run.environment.signature,
      baselineAssertions: parent.package.assertions,
      parentScriptRevisionId: parent.id,
    })
    const output = await this.agentRuntime.execute({
      stage: 'script_repair',
      run,
      task,
      workspace,
      stageContext: {
        parentScriptRevisionId: parent.id,
        diagnosisId: diagnosis.id,
        attemptIds: attempts.map(attempt => attempt.id),
        artifactIds: artifacts.map(artifact => artifact.id),
        repairCount: task.repairCount,
      },
      validateCandidate: candidateValidator(build),
    }, signal)
    assertAgentOutputSchema(output, 'script-repair/v1')
    const executionPackage = build(output.candidate)
    if (executionPackage.files[0].contentSha256 === parent.contentSha256) {
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
      await this.store.getScriptArtifactByCacheKey(taskScriptCacheKey(run, task)),
      'TEST_EXECUTION_SCRIPT_ARTIFACT_NOT_FOUND',
      '当前 ScriptRevision 缺少脚本缓存身份',
    )
    await this.persistScriptRevision({
      job,
      lease,
      run,
      task,
      expectedStatus: 'repairing',
      scriptArtifact,
      executionPackage,
      source: 'repair',
      generatedBy: run.agents.scriptRepair,
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
    source: 'agent' | 'cache' | 'repair'
    cacheSourceRevisionId?: string
    generatedBy: FrozenExecutionAgentSnapshot
    parent?: ScriptRevision
    repairReason?: string
    incrementRepair: boolean
  }) {
    const file = input.executionPackage.files[0]
    const stored = await this.artifactStore.put({
      body: executionArtifactBody(file.content),
      mimeType: 'text/typescript; charset=utf-8',
      expectedSha256: file.contentSha256,
      maximumBytes: 512 * 1024,
    })
    const createdAt = this.clock()
    const sourceArtifact: ExecutionArtifact = {
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
    const revisionNumber = input.parent ? input.parent.revision + 1 : 1
    await requiredLeaseTransaction(
      this.store,
      input.job.id,
      input.lease,
      async transaction => {
        await transaction.appendArtifact(sourceArtifact)
        const scriptArtifact = await transaction.appendScriptArtifact(input.scriptArtifact)
        const revision: ScriptRevision = {
          id: stableIdentity('test_execution_script_revision', {
            runId: input.run.id,
            taskId: input.task.id,
            revision: revisionNumber,
            contentSha256: file.contentSha256,
          }),
          runId: input.run.id,
          taskId: input.task.id,
          scriptArtifactId: scriptArtifact.id,
          revision: revisionNumber,
          ...(input.parent ? { parentRevisionId: input.parent.id } : {}),
          ...(input.cacheSourceRevisionId
            ? { cacheSourceRevisionId: input.cacheSourceRevisionId }
            : {}),
          source: input.source,
          ...(input.repairReason ? { repairReason: input.repairReason } : {}),
          generatedBy: structuredClone(input.generatedBy),
          package: structuredClone(input.executionPackage.manifest),
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
          await appendRunnerArtifacts(transaction, run.id, task.id, attemptId, result.artifacts, finishedAt)
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
          await appendRunnerArtifacts(transaction, run.id, task.id, attemptId, result.artifacts, finishedAt)
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
    let passingRepairProposal: CaseMaintenanceProposal | null = null
    if (result.status === 'passed' && kind === 'post_repair' && revision.parentRevisionId) {
      const scriptRevisions = await this.store.listScriptRevisions(task.id)
      const original = scriptRevisions.find(item => item.id === revision.parentRevisionId)
      if (original) {
        const originalPackage = await this.reconstructPackage(run, task, original)
        passingRepairProposal = maintenanceProposalForPassingRepair({
          run,
          task,
          repairRevision: revision,
          diagnoses: await this.store.listDiagnoses(task.id),
          scriptRevisions,
          originalSource: originalPackage.files[0].content,
          repairSource: executionPackage.files[0].content,
          createdAt: finishedAt,
        })
      }
    }
    await requiredLeaseTransaction(
      this.store,
      job.id,
      lease,
      async transaction => {
        await appendRunnerArtifacts(transaction, run.id, task.id, attemptId, result.artifacts, finishedAt)
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
          if (passingRepairProposal) {
            await transaction.appendMaintenanceProposal(passingRepairProposal)
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
          status: failedAttempts.length === 0 ? 'retrying' : 'diagnosing',
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
    if (attempts.length < 2) {
      throw new Error('TEST_EXECUTION_DIAGNOSIS_REQUIRES_TWO_FAILURES')
    }
    const artifacts = (await Promise.all(
      attempts.map(attempt => this.store.listArtifacts(task.id, attempt.id)),
    )).flat()
    const diagnoses = await this.store.listDiagnoses(task.id)
    const workspace = await this.workspace(run, task, revision, attempts, diagnoses, artifacts)
    const context = {
      taskId: task.id,
      scriptRevisionId: revision.id,
      attemptIds: attempts.map(attempt => attempt.id),
      artifactIds: artifacts.map(artifact => artifact.id),
    }
    const validate = (candidate: Record<string, unknown>) =>
      validateFailureDiagnosisCandidate(candidate, context)
    const output = await this.agentRuntime.execute({
      stage: 'failure_diagnosis',
      run,
      task,
      workspace,
      stageContext: {
        scriptRevisionId: revision.id,
        attemptIds: context.attemptIds,
        artifactIds: context.artifactIds,
      },
      validateCandidate: candidateValidator(validate),
    }, signal)
    assertAgentOutputSchema(output, 'failure-analysis/v1')
    const candidate = validate(output.candidate)
    const diagnosis: FailureDiagnosis = {
      id: stableIdentity('test_execution_diagnosis', {
        taskId: task.id,
        scriptRevisionId: revision.id,
        attemptIds: context.attemptIds,
      }),
      runId: run.id,
      taskId: task.id,
      scriptRevisionId: revision.id,
      attemptIds: context.attemptIds,
      ...candidate,
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
    const sourceArtifact = required(
      await this.store.getArtifact(revision.sourceArtifactId),
      'TEST_EXECUTION_SCRIPT_SOURCE_ARTIFACT_NOT_FOUND',
      'ScriptRevision 缺少源码 Artifact',
    )
    const source = await this.readScriptSource(sourceArtifact)
    const executionPackage: ExecutionPackage = {
      manifest: structuredClone(revision.package),
      files: [{
        path: revision.package.entrypoint,
        content: source,
        contentSha256: sourceArtifact.sha256,
        size: sourceArtifact.size,
      }],
    }
    return assertExecutionPackageIntegrity({
      package: executionPackage,
      task: { ...task.input, taskId: task.id },
      environmentSignature: run.environment.signature,
      expectedPackageSha256: revision.package.packageSha256,
    })
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
    if (
      projection.runId !== run.id
      || projection.projectId !== run.projectId
      || projection.projectVersionId !== run.projectVersionId
    ) {
      throw new Error('TEST_EXECUTION_WORKSPACE_SCOPE_MISMATCH')
    }
    return projection
  }
}

function validateModernHandoff(handoff: TestExecutionHandoff, projectVersionId: string) {
  if (
    handoff.testCaseSetVersionId
    || !handoff.testCaseLibraryVersionId
    || !handoff.mode
  ) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_HANDOFF_MIGRATION_REQUIRED',
      '旧版 Execution Handoff 必须先迁移为固定用例库版本交接',
      409,
    )
  }
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
    ...(handoff.testDataSnapshot ? { testDataSnapshot: handoff.testDataSnapshot } : {}),
  }
  if (canonicalSha256(canonical) !== handoff.contentSha256) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_HANDOFF_CONTENT_HASH_MISMATCH',
      'Execution Handoff 内容 Hash 无效',
    )
  }
  return handoff as TestExecutionHandoff & {
    testCaseLibraryVersionId: string
    mode: NonNullable<TestExecutionHandoff['mode']>
  }
}

function validateLibraryVersion(library: TestCaseLibraryVersionDetail, projectId: string) {
  if (library.projectId !== projectId || !library.members.length) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_LIBRARY_VERSION_MISMATCH',
      '固定用例库版本与执行交接不一致',
    )
  }
  const canonical = library.sourceRunId && !library.legacyTestCaseSetVersionId
    ? {
        schemaVersion: 'test-case-library/v1',
        projectId,
        sourceRunId: library.sourceRunId,
        ...(library.dataRequirementSet ? { dataRequirementSet: { id: library.dataRequirementSet.id, version: library.dataRequirementSet.version, contentSha256: library.dataRequirementSet.contentSha256 } } : {}),
        members: library.members,
      }
    : library.legacyTestCaseSetVersionId && !library.sourceRunId
      ? {
          schemaVersion: 'test-case-library/v1',
          projectId,
          legacyTestCaseSetVersionId: library.legacyTestCaseSetVersionId,
          members: library.members,
        }
      : null
  if (!canonical || canonicalSha256(canonical) !== library.contentSha256) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_LIBRARY_CONTENT_HASH_MISMATCH',
      '固定用例库版本内容 Hash 无效',
    )
  }
  if (library.dataRequirementSet && canonicalSha256(library.dataRequirementSet.requirements) !== library.dataRequirementSet.contentSha256) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_DATA_REQUIREMENT_SET_HASH_MISMATCH',
      '固定测试数据需求版本内容 Hash 无效',
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

function freezeExecutionTestDataSnapshot(handoff: TestExecutionHandoff, library: TestCaseLibraryVersionDetail, bindings: ExecutionTestDataBinding[]): FrozenExecutionTestDataSnapshot | undefined {
  const selectedKeys = new Set(handoff.members.map(member => caseRevisionKey(member.caseId, member.revision)))
  const requirementIds = [...new Set(library.members.filter(member => selectedKeys.has(caseRevisionKey(member.caseId, member.revision))).flatMap(member => member.frozenContent.dataRequirementIds))].sort((left, right) => left.localeCompare(right, 'en'))
  if (!requirementIds.length) {
    if (bindings.length) throw new TestExecutionServiceError('TEST_EXECUTION_TEST_DATA_BINDING_UNEXPECTED', '当前 Handoff 不需要测试数据，不能提交额外绑定', 422)
    return undefined
  }
  const snapshot = required(handoff.testDataSnapshot, 'TEST_EXECUTION_TEST_DATA_SNAPSHOT_REQUIRED', 'Handoff 缺少独立测试数据需求快照，请重新生成 Handoff', 409)
  const snapshotBody = { sourceSetId: snapshot.sourceSetId, sourceSetVersion: snapshot.sourceSetVersion, sourceSetSha256: snapshot.sourceSetSha256, requirements: snapshot.requirements }
  if (canonicalSha256(snapshotBody) !== snapshot.contentSha256) throw new TestExecutionServiceError('TEST_EXECUTION_TEST_DATA_SNAPSHOT_HASH_MISMATCH', 'Handoff 测试数据需求快照 Hash 无效')
  if (library.dataRequirementSet && (library.dataRequirementSet.id !== snapshot.sourceSetId || library.dataRequirementSet.version !== snapshot.sourceSetVersion || library.dataRequirementSet.contentSha256 !== snapshot.sourceSetSha256)) throw new TestExecutionServiceError('TEST_EXECUTION_TEST_DATA_SOURCE_MISMATCH', 'Handoff 测试数据需求来源与正式用例库版本不一致')
  const definitions = new Map(snapshot.requirements.map(requirement => [requirement.id, requirement]))
  if (definitions.size !== snapshot.requirements.length || requirementIds.some(id => !definitions.has(id)) || snapshot.requirements.some(requirement => !requirementIds.includes(requirement.id))) throw new TestExecutionServiceError('TEST_EXECUTION_TEST_DATA_REQUIREMENT_MISMATCH', 'Handoff 测试数据需求与选中用例不一致')
  const byId = new Map(bindings.map(binding => [binding.requirementId, binding]))
  const missing = requirementIds.filter(id => !byId.has(id))
  const extra = bindings.filter(binding => !definitions.has(binding.requirementId)).map(binding => binding.requirementId)
  if (missing.length || extra.length) throw new TestExecutionServiceError('TEST_EXECUTION_TEST_DATA_BINDING_REQUIRED', '创建执行 Run 前必须逐项绑定测试数据供给', 422, { missingRequirementIds: missing, unexpectedRequirementIds: extra })
  const frozen = { sourceSetId: snapshot.sourceSetId, sourceSetVersion: snapshot.sourceSetVersion, sourceSetSha256: snapshot.sourceSetSha256, requirementSnapshotSha256: snapshot.contentSha256, requirements: structuredClone(snapshot.requirements), bindings: structuredClone(bindings) }
  return { ...frozen, contentSha256: canonicalSha256(frozen) }
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
  suite?: TestSuiteVersion,
) {
  if (handoff.mode === 'full') {
    if (handoff.suiteVersionId || suite) {
      throw new TestExecutionServiceError(
        'TEST_EXECUTION_SUITE_FORBIDDEN',
        'full 模式不能固定测试套件',
      )
    }
    return
  }
  if (
    !suite
    || suite.id !== handoff.suiteVersionId
    || suite.projectId !== handoff.projectId
    || suite.suiteType !== handoff.mode
    || suite.testCaseLibraryVersionId !== library.id
    || suite.compatibilityStatus !== 'compatible'
  ) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_SUITE_VERSION_MISMATCH',
      '执行套件与 Handoff 固定的用例库版本或模式不一致',
    )
  }
  const canonical = {
    projectId: suite.projectId,
    suiteKey: suite.suiteKey,
    suiteType: suite.suiteType,
    name: suite.name,
    testCaseLibraryVersionId: library.id,
    members: suite.members,
  }
  if (canonicalSha256(canonical) !== suite.contentSha256) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_SUITE_CONTENT_HASH_MISMATCH',
      '固定测试套件内容 Hash 无效',
    )
  }
}

function taskScriptCacheKey(run: ExecutionRun, task: ExecutionTask) {
  return scriptCacheKey({
    caseId: task.input.caseId,
    caseRevision: task.input.caseRevision,
    method: executableMethod(task),
    caseContentSha256: task.input.caseContentSha256,
    executionSpecSha256: task.input.executionSpecSha256,
    taskInputSha256: task.input.inputSha256,
    environmentSignature: run.environment.signature,
    testScriptAgentVersion: run.agents.testScript.configurationVersion,
    testScriptAgentConfigurationSha256: run.agents.testScript.configurationSha256,
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
  diagnosis: Pick<FailureDiagnosis, 'category' | 'repairable'>,
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

function maintenanceProposalForPassingRepair(input: {
  run: ExecutionRun
  task: ExecutionTask
  repairRevision: ScriptRevision
  diagnoses: readonly FailureDiagnosis[]
  scriptRevisions: readonly ScriptRevision[]
  originalSource: string
  repairSource: string
  createdAt: string
}): CaseMaintenanceProposal | null {
  const repair = input.repairRevision
  if (repair.source !== 'repair' || !repair.parentRevisionId) return null
  const original = input.scriptRevisions.find(revision => revision.id === repair.parentRevisionId)
  const diagnosis = [...input.diagnoses]
    .reverse()
    .find(item => item.scriptRevisionId === repair.parentRevisionId)
  if (
    !original
    || !diagnosis
    || !automaticRepairAllowed(diagnosis, 0)
    || !['script_defect', 'selector_changed'].includes(diagnosis.category)
    || repair.runId !== input.run.id
    || repair.taskId !== input.task.id
    || original.runId !== input.run.id
    || original.taskId !== input.task.id
    || diagnosis.runId !== input.run.id
    || diagnosis.taskId !== input.task.id
    || repair.protectedAssertionSha256 !== original.protectedAssertionSha256
    || canonicalSha256(repair.package.assertions) !== canonicalSha256(original.package.assertions)
    || scriptMaintenanceSemanticSha256(input.repairSource)
      !== scriptMaintenanceSemanticSha256(input.originalSource)
  ) return null

  const id = stableIdentity('test_execution_case_maintenance_proposal', {
    taskId: input.task.id,
    diagnosisId: diagnosis.id,
    scriptRevisionId: repair.id,
  })
  return {
    id,
    runId: input.run.id,
    taskId: input.task.id,
    caseId: input.task.input.caseId,
    caseRevision: input.task.input.caseRevision,
    diagnosisId: diagnosis.id,
    scriptRevisionId: repair.id,
    status: 'pending',
    summary: diagnosis.category === 'selector_changed'
      ? '已验证 selector 修复，建议人工维护正式测试用例的自动化执行表达'
      : '已验证脚本缺陷修复，建议人工维护正式测试用例的自动化执行表达',
    proposedChange: '请人工比较原 Script Revision 与已通过真实 Runner 验证的 repair Revision，仅维护 selector、automation hint 或脚本执行表达；不得修改 Expected Result、Verification Check、matcher、Requirement 或任何业务断言与业务语义。',
    baselineLibraryVersionId: input.run.handoff.testCaseLibraryVersionId,
    baselineLibraryVersionSha256: input.run.handoff.testCaseLibraryVersionSha256,
    createdAt: input.createdAt,
  }
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
    recommendedAction: '记录 flaky，不调用 ScriptRepairAgent',
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
  for (const [index, artifact] of artifacts.entries()) {
    await transaction.appendArtifact({
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
    })
  }
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

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

function assertAgentOutputSchema(
  output: TestExecutionAgentRuntimeOutput,
  expected: TestExecutionAgentRuntimeOutput['schemaVersion'],
) {
  if (
    output.schemaVersion !== expected
    || output.candidate.schemaVersion !== expected
  ) {
    throw new Error('TEST_EXECUTION_AGENT_OUTPUT_SCHEMA_MISMATCH')
  }
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
): ExecutionPackageCandidate {
  const files = Array.isArray(candidate.files)
    ? candidate.files.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('TEST_EXECUTION_PACKAGE_CANDIDATE_INVALID')
        }
        const file = value as Record<string, unknown>
        return {
          path: String(file.path ?? ''),
          content: typeof file.content === 'string' ? file.content : '',
          ...(file.contentSha256 === undefined
            ? {}
            : { contentSha256: String(file.contentSha256) }),
        }
      })
    : []
  return {
    schemaVersion: String(candidate.schemaVersion ?? '') as ExecutionPackageCandidate['schemaVersion'],
    taskId: String(candidate.taskId ?? ''),
    ...(candidate.parentScriptRevisionId === undefined
      ? {}
      : { parentScriptRevisionId: String(candidate.parentScriptRevisionId) }),
    files,
    summary: String(candidate.summary ?? ''),
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

function assertAgentSnapshots(agents: ExecutionRun['agents']) {
  const values = [agents.testScript, agents.failureAnalysis, agents.scriptRepair]
  const expected: FrozenExecutionAgentSnapshot['agentKey'][] = [
    'test-script',
    'failure-analysis',
    'script-repair',
  ]
  values.forEach((snapshot, index) => {
    const { snapshotSha256, ...base } = snapshot
    if (
      snapshot.agentKey !== expected[index]
      || canonicalSha256(base) !== snapshotSha256
    ) throw new Error('TEST_EXECUTION_AGENT_SNAPSHOT_INVALID')
  })
}

function assertFrozenRunner(run: ExecutionRun, actual: ExecutionRun['runner']) {
  if (canonicalSha256(run.runner) !== canonicalSha256(actual)) {
    throw new Error('TEST_EXECUTION_RUNNER_SNAPSHOT_DRIFT')
  }
}

function requiredIdentity(value: string, field: string) {
  const normalized = String(value ?? '').trim()
  if (!normalized || normalized.length > 500 || /[ -]/u.test(normalized)) {
    throw new TestExecutionServiceError(
      'TEST_EXECUTION_IDENTITY_INVALID',
      `${field} 无效`,
      400,
    )
  }
  return normalized
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
  return `${caseId} ${revision}`
}

function taskEntrypoint(taskId: string) {
  return `tests/${taskId}.spec.ts`
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
