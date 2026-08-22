import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import {
  TestExecutionInfrastructureError,
  TestExecutionService,
  type TestExecutionAgentRuntime,
} from '../server/application/test-execution-service.js'
import {
  FrozenTestExecutionWorkspaceProvider,
} from '../server/application/test-execution-workspace-provider.js'
import {
  assertTaskTransition,
  freezeExecutionTaskInput,
} from '../server/application/test-execution-validation.js'
import type {
  TestExecutionAgentRuntimeInput,
  TestExecutionAgentRuntimeOutput,
} from '../server/agent/pi-test-execution-runtime.js'
import type {
  CaseMaintenanceProposal,
  ExecutionArtifact,
  ExecutionAttempt,
  ExecutionEnvironmentSnapshot,
  ExecutionJob,
  ExecutionPackage,
  ExecutionRun,
  ExecutionTask,
  FailureDiagnosis,
  FrozenExecutionAgentSnapshot,
  ScriptArtifact,
  ScriptRevision,
} from '../server/domain/test-execution-types.js'
import type {
  TestCaseContent,
  TestCaseLibraryVersionMemberDetail,
  TestExecutionHandoffMember,
} from '../server/domain/test-design-types.js'
import {
  LocalExecutionArtifactStore,
} from '../server/infrastructure/execution-artifact-store.js'
import { LocalExecutionWorkspaceStore } from '../server/infrastructure/execution-workspace-store.js'
import type {
  CreateExecutionAggregateInput,
  ExecutionJobLease,
  TestExecutionStore,
  TestExecutionTransaction,
} from '../server/infrastructure/test-execution-store.js'
import type {
  PlaywrightRunner,
} from '../server/runner/playwright-runner.js'
import type {
  SandboxExecutionResult,
} from '../server/runner/execution-sandbox.js'

const caseContent: TestCaseContent = {
  schemaVersion: 'test-case/v3',
  title: '状态检查',
  dimension: 'functional',
  requirementRefs: ['point-status'],
  priority: 'P0',
  preconditions: [],
  executionMethods: ['ui'],
  steps: ['打开状态页'],
  expectedResults: ['状态显示 Ready'],
}

const executionSpec = { schemaVersion: 'test-script-input/v1' as const, method: 'ui' as const, testCase: caseContent }

const caseContentSha256 = canonicalSha256(caseContent)
const libraryMember: TestCaseLibraryVersionMemberDetail = {
  caseId: 'case-status',
  revision: 1,
  ordinal: 0,
  contentSha256: caseContentSha256,
  frozenContent: caseContent,
  executionReadiness: 'ready',
}
const handoffMember: TestExecutionHandoffMember = {
  stage: 'full',
  ordinal: 0,
  sourceVersionId: 'library-version-1',
  caseId: 'case-status',
  revision: 1,
  method: 'ui',
  reason: '核心流程',
  dedupKey: 'case-status:1:ui',
  dimension: 'functional',
  executionSpec,
  contentSha256: caseContentSha256,
}
function scriptSource(locator = 'status') {
  return `import { test, expect } from '@playwright/test'

test('status', async ({ page }) => {
  await page.goto('/status')
  // smarthub:assert expected-1
  await expect(page.locator('[data-testid="${locator}"]')).toHaveText('Ready')
})
`
}

const source = scriptSource()

const runnerSnapshot = {
  runnerVersion: '1.0.0',
  playwrightVersion: '1.58.2',
  imageReference: 'registry.example/smarthub/playwright',
  imageDigest: `sha256:${'a'.repeat(64)}`,
}

const environment: ExecutionEnvironmentSnapshot = {
  environmentId: 'environment-test',
  name: '隔离测试环境',
  baseUrl: 'https://example.test/',
  targets: [{ protocol: 'https', host: 'example.test', port: 443 }],
  signature: 'e'.repeat(64),
}

function agentSnapshot(
  agentKey: FrozenExecutionAgentSnapshot['agentKey'],
): FrozenExecutionAgentSnapshot {
  const base = {
    agentKey,
    configurationId: `${agentKey}-configuration`,
    configurationVersion: 1,
    configurationSha256: canonicalSha256({ agentKey, configuration: 1 }),
    definitionSha256: canonicalSha256({ agentKey, definition: 1 }),
    model: {
      sourceId: 'model-source',
      modelId: 'model-id',
      providerType: 'anthropic' as const,
      modelName: 'claude-sonnet-5',
      baseUrlSha256: canonicalSha256('https://api.anthropic.com'),
      contextWindow: 200_000,
      maxOutputTokens: 16_000,
      supportsReasoning: true,
      requestTimeoutMs: 60_000,
      retryCount: 1,
    },
  }
  return { ...base, snapshotSha256: canonicalSha256(base) }
}

function fixture() {
  const input = freezeExecutionTaskInput({ handoffMember, libraryMember })
  const createdAt = '2026-08-13T12:00:00.000Z'
  const task: ExecutionTask = {
    id: 'task-status',
    runId: 'run-status',
    input,
    status: 'pending',
    stateVersion: 0,
    runnerAttemptCount: 0,
    sameScriptRetryCount: 0,
    repairCount: 0,
    createdAt,
    updatedAt: createdAt,
  }
  const run: ExecutionRun = {
    id: task.runId,
    projectId: 'project-1',
    projectVersionId: 'project-version-1',
    handoff: {
      handoffId: 'handoff-1',
      handoffSha256: canonicalSha256({ handoff: 1 }),
      projectId: 'project-1',
      projectVersionId: 'project-version-1',
      testCaseLibraryVersionId: 'library-version-1',
      testCaseLibraryVersionSha256: canonicalSha256({ library: 1 }),
      mode: 'full',
      memberSnapshotSha256: canonicalSha256([input]),
    },
    environment,
    runner: runnerSnapshot,
    agents: {
      testScript: agentSnapshot('test-script'),
      failureAnalysis: agentSnapshot('failure-analysis'),
      scriptRepair: agentSnapshot('script-repair'),
    },
    status: 'queued',
    stateVersion: 0,
    idempotencyKey: 'idempotency-1',
    taskCount: 1,
    createdBy: 'user-1',
    createdAt,
  }
  const job: ExecutionJob = {
    id: 'job-status',
    runId: run.id,
    taskId: task.id,
    status: 'running',
    attempts: 1,
    maxAttempts: 3,
    availableAt: createdAt,
    leaseOwner: 'worker-1',
    runToken: 'run-token-1',
    fencingToken: 1,
    leaseExpiresAt: '2026-08-13T13:00:00.000Z',
    heartbeatAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  }
  return { run, task, job }
}

class InMemoryExecutionStore implements TestExecutionStore {
  run: ExecutionRun
  task: ExecutionTask
  job: ExecutionJob
  attempts: ExecutionAttempt[] = []
  diagnoses: FailureDiagnosis[] = []
  artifacts: ExecutionArtifact[] = []
  scriptArtifacts: ScriptArtifact[] = []
  revisions: ScriptRevision[] = []
  maintenanceProposals: CaseMaintenanceProposal[] = []

  constructor(value: ReturnType<typeof fixture>) {
    this.run = structuredClone(value.run)
    this.task = structuredClone(value.task)
    this.job = structuredClone(value.job)
  }

  async readiness() {
    return { ready: true }
  }

  async createAggregate(input: CreateExecutionAggregateInput) {
    this.run = structuredClone(input.run)
    this.task = structuredClone(input.tasks[0])
    this.job = structuredClone(input.jobs[0])
    return structuredClone(this.run)
  }

  async getRun(runId: string) {
    return runId === this.run.id ? structuredClone(this.run) : null
  }

  async getRunByIdempotencyKey(projectVersionId: string, idempotencyKey: string) {
    return this.run.projectVersionId === projectVersionId
      && this.run.idempotencyKey === idempotencyKey
      ? structuredClone(this.run)
      : null
  }

  async listRuns(projectVersionId: string, limit: number) {
    return this.run.projectVersionId === projectVersionId && limit > 0
      ? [structuredClone(this.run)]
      : []
  }

  async listTasks(runId: string) {
    return runId === this.run.id ? [structuredClone(this.task)] : []
  }

  async getTask(taskId: string) {
    return taskId === this.task.id ? structuredClone(this.task) : null
  }

  async getTaskDetail(taskId: string) {
    if (taskId !== this.task.id) return null
    return {
      run: structuredClone(this.run),
      task: structuredClone(this.task),
      attempts: this.attempts.map(item => structuredClone(item)),
      diagnoses: this.diagnoses.map(item => structuredClone(item)),
      scriptRevisions: this.revisions.map(item => structuredClone(item)),
      artifacts: this.artifacts.map(item => structuredClone(item)),
      maintenanceProposals: this.maintenanceProposals.map(item => structuredClone(item)),
    }
  }

  async listAttempts(taskId: string) {
    return this.attempts
      .filter(item => item.taskId === taskId)
      .map(item => structuredClone(item))
  }

  async listDiagnoses(taskId: string) {
    return this.diagnoses
      .filter(item => item.taskId === taskId)
      .map(item => structuredClone(item))
  }

  async listMaintenanceProposals(runId: string) {
    return this.maintenanceProposals
      .filter(item => item.runId === runId)
      .map(item => structuredClone(item))
  }

  async listTaskMaintenanceProposals(taskId: string) {
    return this.maintenanceProposals
      .filter(item => item.taskId === taskId)
      .map(item => structuredClone(item))
  }

  async getMaintenanceProposal(proposalId: string) {
    const proposal = this.maintenanceProposals.find(item => item.id === proposalId)
    return proposal ? structuredClone(proposal) : null
  }

  async getMaintenanceProposalDetail() {
    throw new Error('NOT_USED')
  }

  async decideMaintenanceProposal(input: {
    proposalId: string
    expectedStatus: 'pending'
    decision: 'accepted' | 'rejected'
    decidedBy: string
    decidedAt: string
  }) {
    const index = this.maintenanceProposals.findIndex(item => item.id === input.proposalId)
    if (index < 0) throw new Error('TEST_EXECUTION_MAINTENANCE_PROPOSAL_NOT_FOUND')
    if (this.maintenanceProposals[index].status !== input.expectedStatus) {
      throw new Error('TEST_EXECUTION_MAINTENANCE_PROPOSAL_STATE_CONFLICT')
    }
    this.maintenanceProposals[index] = {
      ...this.maintenanceProposals[index],
      status: input.decision,
      decidedBy: input.decidedBy,
      decidedAt: input.decidedAt,
    }
    return structuredClone(this.maintenanceProposals[index])
  }

  async getScriptArtifactByCacheKey(cacheKey: string) {
    const artifact = this.scriptArtifacts.find(item => item.cacheKey === cacheKey)
    return artifact ? structuredClone(artifact) : null
  }

  async getScriptRevision(revisionId: string) {
    const revision = this.revisions.find(item => item.id === revisionId)
    return revision ? structuredClone(revision) : null
  }

  async getCacheSourceRevision(scriptArtifactId: string) {
    const revision = this.revisions.find(item =>
      item.scriptArtifactId === scriptArtifactId
      && item.source !== 'cache')
    return revision ? structuredClone(revision) : null
  }

  async listScriptRevisions(taskId: string) {
    return this.revisions
      .filter(item => item.taskId === taskId)
      .map(item => structuredClone(item))
  }

  async getArtifact(artifactId: string) {
    const artifact = this.artifacts.find(item => item.id === artifactId)
    return artifact ? structuredClone(artifact) : null
  }

  async listArtifacts(taskId: string, attemptId?: string) {
    return this.artifacts
      .filter(item => item.taskId === taskId && (!attemptId || item.attemptId === attemptId))
      .map(item => structuredClone(item))
  }

  async claimJob() {
    return structuredClone(this.job)
  }

  async heartbeatJob() {
    return true
  }

  async releaseJob() {
    return true
  }

  async finishJob() {
    return true
  }

  async cancelRun(
    runId: string,
    expectedStateVersion: number,
    requestedAt: string,
  ) {
    assert.equal(runId, this.run.id)
    assert.equal(expectedStateVersion, this.run.stateVersion)
    this.run = {
      ...this.run,
      stateVersion: this.run.stateVersion + 1,
      cancelRequestedAt: requestedAt,
    }
    return structuredClone(this.run)
  }

  async retryTask(input: {
    runId: string
    taskId: string
    expectedRunStateVersion: number
    expectedTaskStateVersion: number
    job: ExecutionJob
  }) {
    assert.equal(input.runId, this.run.id)
    assert.equal(input.taskId, this.task.id)
    assert.equal(input.expectedRunStateVersion, this.run.stateVersion)
    assert.equal(input.expectedTaskStateVersion, this.task.stateVersion)
    assert.ok(['failed', 'partial'].includes(this.run.status))
    assert.ok(['failed', 'blocked', 'waiting_manual'].includes(this.task.status))
    this.run = {
      ...this.run,
      status: 'running',
      stateVersion: this.run.stateVersion + 1,
      finishedAt: undefined,
      error: undefined,
    }
    this.task = {
      ...this.task,
      status: 'ready',
      stateVersion: this.task.stateVersion + 1,
      updatedAt: input.job.createdAt,
      finishedAt: undefined,
      error: undefined,
    }
    this.job = structuredClone(input.job)
    return structuredClone(this.task)
  }

  async transactionWithLease<T>(
    _jobId: string,
    _lease: ExecutionJobLease,
    operation: (transaction: TestExecutionTransaction) => Promise<T>,
  ) {
    const transaction: TestExecutionTransaction = {
      transitionTask: async input => {
        assert.equal(input.taskId, this.task.id)
        assert.equal(input.expectedStatus, this.task.status)
        assert.equal(input.expectedStateVersion, this.task.stateVersion)
        assertTaskTransition(this.task.status, input.status)
        this.task = {
          ...this.task,
          status: input.status,
          stateVersion: this.task.stateVersion + 1,
          runnerAttemptCount: this.task.runnerAttemptCount + Number(Boolean(input.incrementRunnerAttempt)),
          sameScriptRetryCount: this.task.sameScriptRetryCount + Number(Boolean(input.incrementSameScriptRetry)),
          repairCount: this.task.repairCount + Number(Boolean(input.incrementRepair)),
          ...(input.currentScriptRevisionId
            ? { currentScriptRevisionId: input.currentScriptRevisionId }
            : {}),
          ...(input.error === undefined ? {} : { error: input.error }),
          ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
          updatedAt: '2026-08-13T12:00:00.000Z',
        }
        return structuredClone(this.task)
      },
      appendArtifact: async artifact => {
        assert.equal(this.artifacts.some(item => item.id === artifact.id), false)
        this.artifacts.push(structuredClone(artifact))
      },
      appendScriptArtifact: async artifact => {
        const existing = this.scriptArtifacts.find(item => item.cacheKey === artifact.cacheKey)
        if (existing) return structuredClone(existing)
        this.scriptArtifacts.push(structuredClone(artifact))
        return structuredClone(artifact)
      },
      appendScriptRevision: async revision => {
        assert.equal(this.revisions.some(item => item.id === revision.id), false)
        this.revisions.push(structuredClone(revision))
      },
      appendAttempt: async attempt => {
        assert.equal(attempt.status, 'running')
        assert.equal(this.attempts.some(item => item.id === attempt.id), false)
        this.attempts.push(structuredClone(attempt))
      },
      finalizeAttempt: async input => {
        const index = this.attempts.findIndex(item => item.id === input.attemptId)
        assert.notEqual(index, -1)
        assert.equal(this.attempts[index].status, 'running')
        this.attempts[index] = { ...this.attempts[index], ...structuredClone(input) }
        return structuredClone(this.attempts[index])
      },
      appendDiagnosis: async diagnosis => {
        assert.equal(this.diagnoses.some(item => item.id === diagnosis.id), false)
        this.diagnoses.push(structuredClone(diagnosis))
      },
      appendMaintenanceProposal: async proposal => {
        const existing = this.maintenanceProposals.find(item =>
          item.id === proposal.id
          || item.taskId === proposal.taskId
            && item.diagnosisId === proposal.diagnosisId
            && item.scriptRevisionId === proposal.scriptRevisionId)
        if (existing) {
          assert.deepEqual(existing, proposal)
          return structuredClone(existing)
        }
        this.maintenanceProposals.push(structuredClone(proposal))
        return structuredClone(proposal)
      },
      enqueueJob: async () => undefined,
      recomputeRun: async () => structuredClone(this.run),
    }
    return operation(transaction)
  }

  async close() {}
}

class ScriptAgentRuntime implements TestExecutionAgentRuntime {
  calls: Array<Pick<TestExecutionAgentRuntimeInput, 'stage' | 'stageContext'>> = []
  repairOrdinal = 0

  constructor(
    private readonly agents: ExecutionRun['agents'],
    private readonly options: {
      diagnosisCategory?: FailureDiagnosis['category']
      repairable?: boolean
      repairSource?: (ordinal: number) => string
    } = {},
  ) {}

  async readiness() {
    return { ready: true, agents: [] }
  }

  async freezeConfiguration() {
    return structuredClone(this.agents)
  }

  async execute(input: TestExecutionAgentRuntimeInput): Promise<TestExecutionAgentRuntimeOutput> {
    this.calls.push(structuredClone({
      stage: input.stage,
      ...(input.stageContext ? { stageContext: input.stageContext } : {}),
    }))
    let candidate: Record<string, unknown>
    let schemaVersion: TestExecutionAgentRuntimeOutput['schemaVersion']
    let agentKey: TestExecutionAgentRuntimeOutput['execution']['agentKey']
    if (input.stage === 'script_generation') {
      schemaVersion = 'test-script-generation/v1'
      agentKey = 'test-script'
      candidate = {
        schemaVersion,
        taskId: input.task.id,
        files: [{ path: `tests/${input.task.id}.spec.ts`, content: source }],
        summary: '生成状态检查脚本',
      }
    } else if (input.stage === 'failure_diagnosis') {
      schemaVersion = 'failure-analysis/v1'
      agentKey = 'failure-analysis'
      assert.ok((input.stageContext?.attemptIds?.length ?? 0) >= 1)
      candidate = {
        schemaVersion,
        taskId: input.task.id,
        scriptRevisionId: input.stageContext?.scriptRevisionId,
        attemptIds: input.stageContext?.attemptIds,
        category: this.options.diagnosisCategory ?? 'selector_changed',
        confidence: 0.95,
        summary: '页面选择器已变化',
        evidence: input.stageContext?.attemptIds?.map(attemptId => ({
          attemptId,
          observation: '同一脚本选择器无法匹配元素',
        })),
        repairable: this.options.repairable ?? true,
        recommendedAction: '更新 locator，保留断言语义',
      }
    } else {
      schemaVersion = 'script-repair/v1'
      agentKey = 'script-repair'
      this.repairOrdinal += 1
      candidate = {
        schemaVersion,
        taskId: input.task.id,
        parentScriptRevisionId: input.stageContext?.parentScriptRevisionId,
        files: [{
          path: `tests/${input.task.id}.spec.ts`,
          content: this.options.repairSource?.(this.repairOrdinal)
            ?? scriptSource(`status-v${this.repairOrdinal + 1}`),
        }],
        summary: `第 ${this.repairOrdinal} 次修复选择器`,
      }
    }
    const validated = await input.validateCandidate(candidate, {
      policyVersion: 'test-execution-workspace/v1',
      packageSha256: canonicalSha256(candidate),
      batches: [],
      toolReads: [],
    })
    assert.equal(validated.valid, true)
    return {
      schemaVersion,
      candidate,
      execution: {
        agentKey,
        workflowStage: input.stage,
        turns: 1,
        toolCalls: 1,
        toolErrors: 0,
        events: [],
        framework: { name: 'pi-agent-core', version: 'test' },
      },
    }
  }
}

class SequenceRunner implements PlaywrightRunner {
  calls: Array<{ attemptId: string; package: ExecutionPackage }> = []

  constructor(private readonly results: SandboxExecutionResult[]) {}

  snapshot() {
    return structuredClone(runnerSnapshot)
  }

  async readiness() {
    return { ready: true, snapshot: this.snapshot() }
  }

  async execute(input: {
    package: ExecutionPackage
    attemptId: string
  }) {
    this.calls.push({
      attemptId: input.attemptId,
      package: structuredClone(input.package),
    })
    const result = this.results.shift()
    if (!result) throw new Error('RUNNER_RESULT_NOT_CONFIGURED')
    return structuredClone(result)
  }
}

const lease: ExecutionJobLease = {
  workerId: 'worker-1',
  runToken: 'run-token-1',
  fencingToken: 1,
}

async function withService(
  results: SandboxExecutionResult[],
  operation: (value: {
    service: TestExecutionService
    store: InMemoryExecutionStore
    runner: SequenceRunner
    runtime: ScriptAgentRuntime
    job: ExecutionJob
    workspace?: LocalExecutionWorkspaceStore
  }) => Promise<void>,
  options: {
    environmentReadiness?: { ready: boolean; reason?: string }
    diagnosisCategory?: FailureDiagnosis['category']
    repairable?: boolean
    repairSource?: (ordinal: number) => string
    workspace?: boolean
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'smarthub-execution-service-'))
  try {
    const value = fixture()
    const store = new InMemoryExecutionStore(value)
    const artifactStore = new LocalExecutionArtifactStore(root)
    const runner = new SequenceRunner(results)
    const runtime = new ScriptAgentRuntime(value.run.agents, options)
    const workspace = options.workspace
      ? new LocalExecutionWorkspaceStore(join(root, 'workspace'))
      : undefined
    const service = new TestExecutionService(
      {
        async getCurrentLibraryVersion() { throw new Error('NOT_USED') },
        async createDefaultExecutionHandoff() { throw new Error('NOT_USED') },
      },
      store,
      runtime,
      artifactStore,
      new FrozenTestExecutionWorkspaceProvider(store, artifactStore),
      {
        async readiness() {
          return options.environmentReadiness ?? { ready: true }
        },
        async resolveSnapshotForBaseUrl(baseUrl) {
          assert.equal(baseUrl, environment.baseUrl)
          return environment
        },
      },
      runner,
      () => '2026-08-13T12:00:00.000Z',
      workspace,
    )
    await operation({ service, store, runner, runtime, job: value.job, workspace })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('TestExecutionService 将环境配置和 secret 来源纳入总 readiness', async () => {
  await withService([], async ({ service }) => {
    const readiness = await service.readiness()
    assert.equal(readiness.ready, false)
    assert.deepEqual(readiness.environment, {
      ready: false,
      reason: 'TEST_EXECUTION_ENVIRONMENT_SECRETS_UNAVAILABLE',
    })
    assert.equal(readiness.store.ready, true)
    assert.equal(readiness.artifactStore.ready, true)
    assert.equal(readiness.agents.ready, true)
    assert.equal(readiness.runner.ready, true)
  }, {
    environmentReadiness: {
      ready: false,
      reason: 'TEST_EXECUTION_ENVIRONMENT_SECRETS_UNAVAILABLE',
    },
  })
})

test('已有有效 Execution Binding 时直接 Runner，不调用实现 Agent', async () => {
  await withService([
    { status: 'passed', exitCode: 0, durationMs: 8, summary: '历史入口通过', artifacts: [] },
  ], async ({ service, store, runner, runtime, job, workspace }) => {
    assert.ok(workspace)
    const entrySha256 = createHash('sha256').update(source, 'utf8').digest('hex')
    await workspace.writeFiles(store.run.projectVersionId, [{ path: 'tests/ui/status.spec.ts', content: source }])
    await workspace.saveBinding({
      projectVersionId: store.run.projectVersionId,
      caseId: store.task.input.caseId,
      executionType: 'ui',
      entryFile: 'tests/ui/status.spec.ts',
      entrySymbol: store.task.input.caseId,
      bindingStatus: 'validated',
      entrySha256,
      caseContentSha256: store.task.input.caseContentSha256,
      createdAt: '2026-08-13T12:00:00.000Z',
      updatedAt: '2026-08-13T12:00:00.000Z',
    })
    const task = await service.processPreparedTask(job, lease, new AbortController().signal)
    assert.equal(task.status, 'passed')
    assert.equal(runner.calls.length, 1)
    assert.equal(runner.calls[0].package.manifest.entrypoint, 'tests/ui/status.spec.ts')
    assert.deepEqual(runtime.calls, [])
    assert.equal(store.revisions[0].source, 'agent')
  }, { workspace: true })
})

test('Workspace 历史入口首次失败后直接诊断，产品缺陷不修改 Workspace', async () => {
  await withService([
    { status: 'failed', exitCode: 1, durationMs: 8, summary: '业务断言失败', error: 'expected Ready', artifacts: [] },
  ], async ({ service, store, runtime, job, workspace }) => {
    assert.ok(workspace)
    const entrySha256 = createHash('sha256').update(source, 'utf8').digest('hex')
    await workspace.writeFiles(store.run.projectVersionId, [{ path: 'tests/ui/status.spec.ts', content: source }])
    await workspace.saveBinding({
      projectVersionId: store.run.projectVersionId, caseId: store.task.input.caseId,
      executionType: 'ui', entryFile: 'tests/ui/status.spec.ts', entrySymbol: store.task.input.caseId,
      bindingStatus: 'validated', entrySha256, caseContentSha256: store.task.input.caseContentSha256,
      createdAt: '2026-08-13T12:00:00.000Z', updatedAt: '2026-08-13T12:00:00.000Z',
    })
    const task = await service.processPreparedTask(job, lease, new AbortController().signal)
    assert.equal(task.status, 'failed')
    assert.equal(store.task.runnerAttemptCount, 1)
    assert.deepEqual(runtime.calls.map(call => call.stage), ['failure_diagnosis'])
    assert.equal(store.revisions.filter(revision => revision.source === 'repair').length, 0)
    assert.equal((await workspace.readEntry(store.run.projectVersionId, { entryFile: 'tests/ui/status.spec.ts' })), source)
  }, { workspace: true, diagnosisCategory: 'product_defect' })
})

test('Workspace script_defect 仅在诊断后修改代码并 Retry', async () => {
  await withService([
    { status: 'failed', exitCode: 1, durationMs: 8, summary: 'selector 不存在', error: 'locator not found', artifacts: [] },
    { status: 'passed', exitCode: 0, durationMs: 7, summary: '修复后通过', artifacts: [] },
  ], async ({ service, store, runtime, job, workspace }) => {
    assert.ok(workspace)
    const entrySha256 = createHash('sha256').update(source, 'utf8').digest('hex')
    await workspace.writeFiles(store.run.projectVersionId, [{ path: 'tests/ui/status.spec.ts', content: source }])
    await workspace.saveBinding({
      projectVersionId: store.run.projectVersionId, caseId: store.task.input.caseId,
      executionType: 'ui', entryFile: 'tests/ui/status.spec.ts', entrySymbol: store.task.input.caseId,
      bindingStatus: 'validated', entrySha256, caseContentSha256: store.task.input.caseContentSha256,
      createdAt: '2026-08-13T12:00:00.000Z', updatedAt: '2026-08-13T12:00:00.000Z',
    })
    const task = await service.processPreparedTask(job, lease, new AbortController().signal)
    assert.equal(task.status, 'passed')
    assert.equal(store.task.runnerAttemptCount, 2)
    assert.equal(store.revisions.filter(revision => revision.source === 'repair').length, 1)
    assert.deepEqual(runtime.calls.map(call => call.stage), ['failure_diagnosis', 'script_repair'])
    assert.equal((await workspace.resolveBinding(store.run.projectVersionId, store.task.input.caseId))?.bindingStatus, 'validated')
  }, { workspace: true, diagnosisCategory: 'script_defect' })
})

test('TestExecutionService 首次真实失败固定同脚本重试，成功后确定性标记 flaky', async () => {
  await withService([
    {
      status: 'failed',
      exitCode: 1,
      durationMs: 10,
      summary: '首次失败',
      error: '断言暂时失败',
      artifacts: [],
    },
    {
      status: 'passed',
      exitCode: 0,
      durationMs: 8,
      summary: '重试通过',
      artifacts: [],
    },
  ], async ({ service, store, runner, runtime, job }) => {
    const task = await service.processPreparedTask(
      job,
      lease,
      new AbortController().signal,
    )
    assert.equal(task.status, 'passed')
    assert.equal(store.task.runnerAttemptCount, 2)
    assert.equal(store.task.sameScriptRetryCount, 1)
    assert.deepEqual(store.attempts.map(item => item.kind), [
      'initial',
      'same_script_retry',
    ])
    assert.deepEqual(store.attempts.map(item => item.status), [
      'failed',
      'passed',
    ])
    assert.equal(store.diagnoses.length, 1)
    assert.equal(store.diagnoses[0].category, 'flaky')
    assert.equal(store.diagnoses[0].source, 'deterministic')
    assert.equal(store.diagnoses[0].agent, undefined)
    assert.deepEqual(runtime.calls.map(call => call.stage), ['script_generation'])
    assert.equal(runner.calls.length, 2)
    assert.equal(
      runner.calls[0].package.manifest.packageSha256,
      runner.calls[1].package.manifest.packageSha256,
    )
  })
})

test('TestExecutionService 两次真实失败后才诊断，并在两次自动修复上限收口', async () => {
  const failures = Array.from({ length: 6 }, (_, index): SandboxExecutionResult => ({
    status: 'failed',
    exitCode: 1,
    durationMs: 10 + index,
    summary: `第 ${index + 1} 次失败`,
    error: 'locator 未匹配',
    artifacts: [],
  }))
  await withService(failures, async ({ service, store, runner, runtime, job }) => {
    const task = await service.processPreparedTask(
      job,
      lease,
      new AbortController().signal,
    )
    assert.equal(task.status, 'waiting_manual')
    assert.equal(store.task.runnerAttemptCount, 6)
    assert.equal(store.task.sameScriptRetryCount, 3)
    assert.equal(store.task.repairCount, 2)
    assert.equal(store.revisions.length, 3)
    assert.deepEqual(store.revisions.map(item => item.source), [
      'agent',
      'repair',
      'repair',
    ])
    assert.equal(store.revisions[1].parentRevisionId, store.revisions[0].id)
    assert.equal(store.revisions[2].parentRevisionId, store.revisions[1].id)
    assert.equal(store.diagnoses.length, 3)
    assert.deepEqual(store.diagnoses.map(item => item.category), [
      'selector_changed',
      'selector_changed',
      'selector_changed',
    ])
    assert.deepEqual(store.attempts.map(item => item.kind), [
      'initial',
      'same_script_retry',
      'post_repair',
      'same_script_retry',
      'post_repair',
      'same_script_retry',
    ])
    assert.equal(runner.calls.length, 6)
    const stages = runtime.calls.map(call => call.stage)
    assert.deepEqual(stages, [
      'script_generation',
      'failure_diagnosis',
      'script_repair',
      'failure_diagnosis',
      'script_repair',
      'failure_diagnosis',
    ])
    const diagnosisCalls = runtime.calls.filter(call =>
      call.stage === 'failure_diagnosis')
    assert.equal(diagnosisCalls.length, 3)
    diagnosisCalls.forEach(call => {
      assert.equal(call.stageContext?.attemptIds?.length, 2)
      assert.deepEqual(call.stageContext?.artifactIds, [])
    })
    assert.equal(
      runtime.calls.filter(call => call.stage === 'script_repair').length,
      2,
    )
    assert.equal(store.maintenanceProposals.length, 0)
  })
})

for (const diagnosisCategory of ['script_defect', 'selector_changed'] as const) {
  test(`TestExecutionService ${diagnosisCategory} repair 经真实 post_repair PASS 后创建唯一维护建议`, async () => {
    await withService([
      { status: 'failed', exitCode: 1, durationMs: 10, summary: '首次失败', error: 'locator 未匹配', artifacts: [] },
      { status: 'failed', exitCode: 1, durationMs: 11, summary: '重试失败', error: 'locator 未匹配', artifacts: [] },
      { status: 'passed', exitCode: 0, durationMs: 8, summary: '修复后通过', artifacts: [] },
    ], async ({ service, store, job }) => {
      const task = await service.processPreparedTask(job, lease, new AbortController().signal)
      assert.equal(task.status, 'passed')
      assert.equal(store.maintenanceProposals.length, 1)
      const proposal = store.maintenanceProposals[0]
      const original = store.revisions[0]
      const repair = store.revisions[1]
      assert.equal(proposal.status, 'pending')
      assert.equal(proposal.taskId, task.id)
      assert.equal(proposal.diagnosisId, store.diagnoses[0].id)
      assert.equal(proposal.scriptRevisionId, repair.id)
      assert.equal(repair.parentRevisionId, original.id)
      assert.equal(repair.protectedAssertionSha256, original.protectedAssertionSha256)
      assert.equal(store.attempts.at(-1)?.kind, 'post_repair')
      assert.equal(store.attempts.at(-1)?.status, 'passed')
      assert.equal(proposal.baselineLibraryVersionId, store.run.handoff.testCaseLibraryVersionId)
      assert.match(proposal.proposedChange, /不得修改 Expected Result、Verification Check、matcher、Requirement/u)

      const replay = await store.transactionWithLease(job.id, lease, transaction =>
        transaction.appendMaintenanceProposal(structuredClone(proposal)))
      assert.deepEqual(replay, proposal)
      assert.equal(store.maintenanceProposals.length, 1)
    }, { diagnosisCategory })
  })
}

for (const diagnosisCategory of [
  'product_defect',
  'environment_defect',
  'test_data_defect',
  'flaky',
  'timeout',
  'unknown',
  'assertion_mismatch',
] as const) {
  test(`TestExecutionService ${diagnosisCategory} 不生成维护建议`, async () => {
    await withService([
      { status: 'failed', exitCode: 1, durationMs: 10, summary: '首次失败', error: '执行失败', artifacts: [] },
      { status: 'failed', exitCode: 1, durationMs: 11, summary: '重试失败', error: '执行失败', artifacts: [] },
    ], async ({ service, store, runtime, job }) => {
      await service.processPreparedTask(job, lease, new AbortController().signal)
      assert.equal(store.maintenanceProposals.length, 0)
      assert.equal(store.revisions.filter(item => item.source === 'repair').length, 0)
      assert.equal(runtime.calls.filter(item => item.stage === 'script_repair').length, 0)
    }, { diagnosisCategory })
  })
}

test('TestExecutionService repair 修改受保护断言时在 Runner 前拒绝且不生成维护建议', async () => {
  await withService([
    { status: 'failed', exitCode: 1, durationMs: 10, summary: '首次失败', error: '执行失败', artifacts: [] },
    { status: 'failed', exitCode: 1, durationMs: 11, summary: '重试失败', error: '执行失败', artifacts: [] },
  ], async ({ service, store, runner, job }) => {
    await assert.rejects(service.processPreparedTask(job, lease, new AbortController().signal))
    assert.equal(runner.calls.length, 2)
    assert.equal(store.revisions.filter(item => item.source === 'repair').length, 0)
    assert.equal(store.maintenanceProposals.length, 0)
  }, {
    diagnosisCategory: 'script_defect',
    repairSource: () => source.replace("toHaveText('Ready')", "toHaveText('Changed')"),
  })
})

test('TestExecutionService 维护建议 accepted/rejected 使用服务端审计且终态拒绝再次决策', async () => {
  for (const decision of ['accepted', 'rejected'] as const) {
    await withService([
      { status: 'failed', exitCode: 1, durationMs: 10, summary: '首次失败', error: '执行失败', artifacts: [] },
      { status: 'failed', exitCode: 1, durationMs: 11, summary: '重试失败', error: '执行失败', artifacts: [] },
      { status: 'passed', exitCode: 0, durationMs: 8, summary: '修复后通过', artifacts: [] },
    ], async ({ service, store, job }) => {
      await service.processPreparedTask(job, lease, new AbortController().signal)
      const pending = store.maintenanceProposals[0]
      const decided = await service.decideMaintenanceProposal({
        proposalId: pending.id,
        decision,
        decidedBy: 'operator-1',
      })
      assert.equal(decided.status, decision)
      assert.equal(decided.decidedBy, 'operator-1')
      assert.equal(decided.decidedAt, '2026-08-13T12:00:00.000Z')
      await assert.rejects(
        service.decideMaintenanceProposal({
          proposalId: pending.id,
          decision: decision === 'accepted' ? 'rejected' : 'accepted',
          decidedBy: 'operator-2',
        }),
        (error: unknown) => error instanceof Error
          && 'code' in error
          && error.code === 'TEST_EXECUTION_MAINTENANCE_PROPOSAL_STATE_CONFLICT',
      )
    }, { diagnosisCategory: 'script_defect' })
  }
})

test('TestExecutionService 缓存复用 Revision 显式保存原始非缓存 Revision 来源', async () => {
  await withService([
    {
      status: 'passed',
      exitCode: 0,
      durationMs: 8,
      summary: '原始脚本通过',
      artifacts: [],
    },
    {
      status: 'passed',
      exitCode: 0,
      durationMs: 7,
      summary: '缓存脚本通过',
      artifacts: [],
    },
  ], async ({ service, store, runtime, job }) => {
    await service.processPreparedTask(
      job,
      lease,
      new AbortController().signal,
    )
    const sourceRevision = store.revisions[0]
    assert.equal(sourceRevision.source, 'agent')

    const next = fixture()
    store.run = {
      ...next.run,
      id: 'run-cache-replay',
      idempotencyKey: 'idempotency-cache-replay',
    }
    store.task = {
      ...next.task,
      id: 'task-cache-replay',
      runId: store.run.id,
    }
    store.job = {
      ...next.job,
      id: 'job-cache-replay',
      runId: store.run.id,
      taskId: store.task.id,
    }

    const replayed = await service.processPreparedTask(
      store.job,
      lease,
      new AbortController().signal,
    )
    assert.equal(replayed.status, 'passed')
    assert.equal(runtime.calls.filter(call =>
      call.stage === 'script_generation').length, 1)
    const cachedRevision = store.revisions.at(-1)!
    assert.equal(cachedRevision.source, 'cache')
    assert.equal(
      cachedRevision.cacheSourceRevisionId,
      sourceRevision.id,
    )
    assert.equal(
      cachedRevision.scriptArtifactId,
      sourceRevision.scriptArtifactId,
    )
  })
})

test('TestExecutionService 人工重试成功不按任务历史计数误标 flaky', async () => {
  const failures = Array.from({ length: 6 }, (_, index): SandboxExecutionResult => ({
    status: 'failed',
    exitCode: 1,
    durationMs: 10 + index,
    summary: `第 ${index + 1} 次失败`,
    error: 'locator 未匹配',
    artifacts: [],
  }))
  await withService([
    ...failures,
    {
      status: 'passed',
      exitCode: 0,
      durationMs: 7,
      summary: '人工重试通过',
      artifacts: [],
    },
  ], async ({ service, store, job }) => {
    const waiting = await service.processPreparedTask(
      job,
      lease,
      new AbortController().signal,
    )
    assert.equal(waiting.status, 'waiting_manual')
    assert.equal(store.diagnoses.length, 3)
    store.task = {
      ...store.task,
      status: 'ready',
      stateVersion: store.task.stateVersion + 1,
      error: undefined,
      finishedAt: undefined,
    }

    const passed = await service.processPreparedTask(
      job,
      lease,
      new AbortController().signal,
    )
    assert.equal(passed.status, 'passed')
    assert.equal(store.attempts.at(-1)?.kind, 'manual_retry')
    assert.equal(store.diagnoses.length, 3)
    assert.equal(
      store.diagnoses.some(diagnosis => diagnosis.category === 'flaky'),
      false,
    )
  })
})

test('TestExecutionService 人工重试通过 CAS 重开 Run 且保留全部历史计数', async () => {
  await withService([], async ({ service, store }) => {
    store.run = {
      ...store.run,
      status: 'partial',
      stateVersion: 9,
      finishedAt: '2026-08-13T11:00:00.000Z',
      error: '部分任务失败',
    }
    store.task = {
      ...store.task,
      status: 'waiting_manual',
      stateVersion: 7,
      runnerAttemptCount: 6,
      sameScriptRetryCount: 3,
      repairCount: 2,
      currentScriptRevisionId: 'revision-current',
      finishedAt: '2026-08-13T11:00:00.000Z',
      error: '已达到自动修复上限',
    }
    const retried = await service.retryTask({
      taskId: store.task.id,
      expectedTaskStateVersion: 7,
      expectedRunStateVersion: 9,
      idempotencyKey: 'manual-retry-key',
      requestedBy: 'operator-1',
    })
    assert.equal(retried.status, 'ready')
    assert.equal(retried.stateVersion, 8)
    assert.equal(retried.runnerAttemptCount, 6)
    assert.equal(retried.sameScriptRetryCount, 3)
    assert.equal(retried.repairCount, 2)
    assert.equal(retried.currentScriptRevisionId, 'revision-current')
    assert.equal(store.run.status, 'running')
    assert.equal(store.run.stateVersion, 10)
    assert.equal(store.job.request?.kind, 'manual_retry')
    assert.equal(store.job.request?.idempotencyKey, 'manual-retry-key')
    assert.equal(store.job.request?.requestedBy, 'operator-1')
  })
})

test('TestExecutionService 基础设施失败使用独立 retry kind 且不消耗业务同脚本重试', async () => {
  await withService([
    {
      status: 'infrastructure_error',
      durationMs: 5,
      summary: '容器启动失败',
      error: 'OCI runtime unavailable',
      artifacts: [],
    },
    {
      status: 'passed',
      exitCode: 0,
      durationMs: 8,
      summary: '基础设施恢复后通过',
      artifacts: [],
    },
  ], async ({ service, store, runner, job }) => {
    await assert.rejects(
      service.processPreparedTask(
        job,
        lease,
        new AbortController().signal,
      ),
      error => error instanceof TestExecutionInfrastructureError
        && error.message === 'OCI runtime unavailable',
    )
    assert.equal(store.task.status, 'ready')
    assert.equal(store.task.runnerAttemptCount, 1)
    assert.equal(store.task.sameScriptRetryCount, 0)
    assert.deepEqual(store.attempts.map(item => item.kind), ['initial'])
    assert.deepEqual(store.attempts.map(item => item.status), ['infrastructure_error'])

    const task = await service.processPreparedTask(
      job,
      lease,
      new AbortController().signal,
    )
    assert.equal(task.status, 'passed')
    assert.equal(store.task.runnerAttemptCount, 2)
    assert.equal(store.task.sameScriptRetryCount, 0)
    assert.deepEqual(store.attempts.map(item => item.kind), [
      'initial',
      'infrastructure_retry',
    ])
    assert.deepEqual(store.attempts.map(item => item.status), [
      'infrastructure_error',
      'passed',
    ])
    assert.equal(store.diagnoses.length, 0)
    assert.equal(runner.calls.length, 2)
  })
})
