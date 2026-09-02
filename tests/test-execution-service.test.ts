import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import { governedExecutionEntryFile } from '../server/application/test-execution-entry.js'
import {
  TestExecutionInfrastructureError,
  TestExecutionService,
  type TestExecutionAgentRuntime,
} from '../server/application/test-execution-service.js'
import {
  createProjectVersionExplorationResult,
  normalizeUiNetworkObservation,
  type RawUiNetworkObservation,
} from '../server/application/test-execution-exploration.js'
import {
  FrozenTestExecutionWorkspaceProvider,
} from '../server/application/test-execution-workspace-provider.js'
import {
  assertTaskTransition,
  CURRENT_EXECUTION_BINDING_VALIDATION_POLICY,
  freezeExecutionTaskInput,
} from '../server/application/test-execution-validation.js'
import type {
  TestExecutionAgentRuntimeInput,
  TestExecutionAgentRuntimeOutput,
} from '../server/agent/pi-test-execution-runtime.js'
import {
  UIExecutionAgent,
  type PlaywrightBrowserCliAdapter,
  type PlaywrightCliToolAdapter,
  type PlaywrightCliRequestSummary,
  type UiExecutionBrowserContext,
} from '../server/agent/ui-execution-agent.js'
import {
  PlaywrightBrowserToolGateway,
} from '../server/tools/playwright-browser-tools.js'
import type { TestExecutionAgentSnapshot } from '../server/domain/agent-types.js'
import type {
  CaseMaintenanceProposal,
  ExecutionArtifact,
  ExecutionAttempt,
  ExecutionEvent,
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
  executionArtifactBody,
  LocalExecutionArtifactStore,
} from '../server/infrastructure/execution-artifact-store.js'
import {
  executionBindingDependencySha256,
  LocalExecutionWorkspaceStore,
} from '../server/infrastructure/execution-workspace-store.js'
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
function scriptSource(locator = 'status', caseId = 'case-status') {
  return `import { test, expect } from '@playwright/test'

test('状态检查 [${caseId}]', async ({ page }) => {
  await page.goto('/status')
  // smarthub:assert expected-1
  await expect(page.locator('[data-testid="${locator}"]')).toHaveText('Ready')
})
`
}

function workspaceRelativePath(
  workspace: TestExecutionAgentRuntimeInput['workspace'],
  logicalPath: string,
) {
  const root = (workspace.documentWorkspace.rootLogicalPath
    ?? workspace.documentWorkspace.logicalPath).replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
  const normalized = logicalPath.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized
}

function apiScriptSource(caseId: string) {
  return `import { test, expect } from '@playwright/test'
import { AuthClient } from '../../api/auth-client.js'

test('API 状态检查 [${caseId}]', async ({ request }) => {
  const response = await new AuthClient(request).login()
  // smarthub:assert expected-1
  expect(response.ok()).toBeTruthy()
})
`
}

const apiClientSource = `import type { APIRequestContext } from '@playwright/test'

export class AuthClient {
  constructor(private readonly request: APIRequestContext) {}
  login() { return this.request.post('/api/login', { data: {} }) }
}
`

const source = scriptSource()

function singleFileBindingDependency(path: string, content: string) {
  const dependencyFiles = [{
    path,
    contentSha256: createHash('sha256').update(content, 'utf8').digest('hex'),
  }]
  return {
    dependencyFiles,
    dependencySha256: executionBindingDependencySha256(dependencyFiles),
  }
}

function frozenApiInput(caseId = 'TC_API_LOGIN_001') {
  const apiCaseContent: TestCaseContent = {
    ...caseContent,
    title: '正确账号登录 API',
    executionMethods: ['api'],
    steps: ['调用登录接口'],
    expectedResults: ['返回登录成功'],
  }
  const apiContentSha256 = canonicalSha256(apiCaseContent)
  return freezeExecutionTaskInput({
    libraryMember: {
      ...libraryMember,
      caseId,
      contentSha256: apiContentSha256,
      frozenContent: apiCaseContent,
    },
    handoffMember: {
      ...handoffMember,
      caseId,
      dedupKey: `${caseId}:1:api`,
      method: 'api',
      contentSha256: apiContentSha256,
      executionSpec: {
        schemaVersion: 'test-script-input/v1',
        method: 'api',
        testCase: apiCaseContent,
      },
    },
  })
}

function frozenProtectedApiInput(caseId = 'TC_API_TASKS_001') {
  const apiCaseContent: TestCaseContent = {
    ...caseContent,
    title: '拒绝任务非法状态枚举值且不改变已保存状态',
    preconditions: ['已具备任务 API 调用条件'],
    executionMethods: ['api'],
    steps: ['读取任务列表', '提交非法状态'],
    expectedResults: ['拒绝非法状态'],
  }
  const apiContentSha256 = canonicalSha256(apiCaseContent)
  return freezeExecutionTaskInput({
    libraryMember: {
      ...libraryMember,
      caseId,
      contentSha256: apiContentSha256,
      frozenContent: apiCaseContent,
    },
    handoffMember: {
      ...handoffMember,
      caseId,
      dedupKey: `${caseId}:1:api`,
      method: 'api',
      contentSha256: apiContentSha256,
      executionSpec: { schemaVersion: 'test-script-input/v1', method: 'api', testCase: apiCaseContent },
    },
  })
}

function frozenProtectedUiInput(caseId = 'TC_UI_TASKS_001') {
  const uiCaseContent: TestCaseContent = {
    ...caseContent,
    title: '已登录任务页状态检查',
    preconditions: ['已登录'],
    steps: ['打开任务页', '检查任务状态'],
    expectedResults: ['任务状态可见'],
  }
  const uiContentSha256 = canonicalSha256(uiCaseContent)
  return freezeExecutionTaskInput({
    libraryMember: {
      ...libraryMember,
      caseId,
      contentSha256: uiContentSha256,
      frozenContent: uiCaseContent,
    },
    handoffMember: {
      ...handoffMember,
      caseId,
      dedupKey: `${caseId}:1:ui`,
      contentSha256: uiContentSha256,
      executionSpec: { schemaVersion: 'test-script-input/v1', method: 'ui', testCase: uiCaseContent },
    },
  })
}

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
      executionImplementation: agentSnapshot('execution-implementation'),
      failureAnalysis: agentSnapshot('failure-analysis'),
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
  events: ExecutionEvent[] = []
  diagnoses: FailureDiagnosis[] = []
  artifacts: ExecutionArtifact[] = []
  scriptArtifacts: ScriptArtifact[] = []
  revisions: ScriptRevision[] = []
  maintenanceProposals: CaseMaintenanceProposal[] = []
  rejectMaintenanceProposalWrites = false
  maintenanceProposalWriteAttempts = 0

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
      events: this.events.map(item => structuredClone(item)),
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

  async listEvents(taskId: string, attemptId?: string) {
    return this.events
      .filter(item => item.taskId === taskId && (!attemptId || item.attemptId === attemptId))
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

  async appendMaintenanceProposal(proposal: CaseMaintenanceProposal) {
    this.maintenanceProposalWriteAttempts += 1
    if (this.rejectMaintenanceProposalWrites) throw new Error('MAINTENANCE_PROPOSAL_WRITE_MUST_NOT_BLOCK_PASS')
    const existing = this.maintenanceProposals.find(item => item.id === proposal.id)
    if (existing) return structuredClone(existing)
    this.maintenanceProposals.push(structuredClone(proposal))
    return structuredClone(proposal)
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

  async getScriptArtifact(artifactId: string) {
    const artifact = this.scriptArtifacts.find(item => item.id === artifactId)
    return artifact ? structuredClone(artifact) : null
  }

  async getScriptRevision(revisionId: string) {
    const revision = this.revisions.find(item => item.id === revisionId)
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
    retryStatus?: 'pending' | 'ready'
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
      status: input.retryStatus ?? (this.task.currentScriptRevisionId ? 'ready' : 'pending'),
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
      appendExecutionEvents: async events => {
        for (const event of events) {
          assert.equal(this.events.some(item => item.id === event.id), false)
          this.events.push(structuredClone(event))
        }
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
        this.maintenanceProposalWriteAttempts += 1
        if (this.rejectMaintenanceProposalWrites) {
          throw new Error('MAINTENANCE_PROPOSAL_WRITE_MUST_NOT_BLOCK_PASS')
        }
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
  calls: Array<Pick<TestExecutionAgentRuntimeInput, 'stage' | 'stageContext' | 'uiExecution' | 'workspace'> & { browserToolIds: string[] }> = []
  repairOrdinal = 0

  constructor(
    private readonly agents: ExecutionRun['agents'],
    private readonly options: {
      diagnosisCategory?: FailureDiagnosis['category']
      repairSource?: (ordinal: number) => string
      runtimeFailure?: string
    } = {},
  ) {}

  async readiness() {
    return { ready: true, agents: [] }
  }

  async freezeConfiguration() {
    return structuredClone(this.agents)
  }

  async execute(input: TestExecutionAgentRuntimeInput): Promise<TestExecutionAgentRuntimeOutput> {
    const browserToolIds = input.browserSession?.runtimeToolBindings().map(binding => binding.descriptor.id) ?? []
    if (input.browserSession) {
      const bindings = new Map(input.browserSession.runtimeToolBindings().map(binding => [binding.descriptor.id, binding]))
      const invoke = async (toolId: string, argumentsValue: Record<string, unknown>) => {
        const binding = bindings.get(toolId)
        assert.ok(binding)
        return binding.handler({
          toolId,
          toolCallId: `fixture-${toolId}`,
          arguments: argumentsValue,
          context: {
            snapshot: {
              runId: input.run.id,
              taskId: input.task.id,
              projectId: input.run.projectId,
              projectVersionId: input.run.projectVersionId,
              browserAuthorization: {
                runId: input.run.id,
                taskId: input.task.id,
                projectVersionId: input.run.projectVersionId,
                environmentSignature: input.run.environment.signature,
                stage: input.stage as 'script_generation' | 'script_repair',
              },
            } as TestExecutionAgentSnapshot,
            allowedToolIds: new Set(browserToolIds),
          },
        }, new AbortController().signal)
      }
      await invoke('browser.snapshot', {})
      if (input.stage === 'script_generation') {
        await invoke('browser.click', { target: 'e1' })
        const requests = await invoke('browser.requests', {})
        const requestRef = (requests.data as { requests?: Array<{ requestRef: string }> }).requests?.[0]?.requestRef
        if (requestRef) await invoke('browser.request_detail', { requestRef })
      } else if (input.stage === 'script_repair') {
        await invoke('browser.get_locator', { target: 'e1' })
      }
    }
    if (this.options.runtimeFailure) throw new Error(this.options.runtimeFailure)
    this.calls.push(structuredClone({
      stage: input.stage,
      workspace: input.workspace,
      ...(input.stageContext ? { stageContext: input.stageContext } : {}),
      ...(input.uiExecution ? { uiExecution: input.uiExecution } : {}),
      browserToolIds,
    }))
    let candidate: Record<string, unknown>
    let schemaVersion: TestExecutionAgentRuntimeOutput['schemaVersion']
    let agentKey: TestExecutionAgentRuntimeOutput['execution']['agentKey']
    if (input.stage === 'script_generation') {
      schemaVersion = 'test-script-generation/v1'
      agentKey = 'execution-implementation'
      const entryFile = governedExecutionEntryFile(input.task.input)
      const generationFiles = [{
        path: entryFile,
        content: input.task.input.method === 'api'
          ? apiScriptSource(input.task.input.caseId)
          : scriptSource('status', input.task.input.caseId),
      }]
      if (input.task.input.method === 'api') {
        generationFiles.push({ path: 'api/auth-client.ts', content: apiClientSource })
      }
      candidate = {
        entryFile,
        files: generationFiles,
        summary: '生成状态检查脚本',
      }
    } else if (input.stage === 'failure_diagnosis') {
      schemaVersion = 'failure-analysis/v1'
      agentKey = 'failure-analysis'
      assert.ok((input.stageContext?.attemptIds?.length ?? 0) >= 1)
      candidate = {
        category: this.options.diagnosisCategory ?? 'selector_changed',
        reason: '页面选择器已变化',
        evidence: '同一脚本选择器无法匹配元素',
      }
    } else {
      schemaVersion = 'script-repair/v1'
      agentKey = 'execution-implementation'
      this.repairOrdinal += 1
      const entryFile = input.stageContext?.entryFile ?? governedExecutionEntryFile(input.task.input)
      candidate = {
        entryFile,
        files: [{
          path: entryFile,
          content: this.options.repairSource?.(this.repairOrdinal)
            ?? scriptSource(`status-v${this.repairOrdinal + 1}`, input.task.input.caseId),
        }],
        summary: `第 ${this.repairOrdinal} 次修复选择器`,
      }
    }
    const validated = await input.validateCandidate(candidate, {
      policyVersion: 'test-execution-workspace/v1',
      packageSha256: canonicalSha256(candidate),
      batches: [],
      toolReads: input.stage === 'failure_diagnosis'
        ? input.workspace.workspaceFiles
            .map(file => ({
              file,
              relativePath: workspaceRelativePath(input.workspace, file.logicalPath),
            }))
            .filter(({ relativePath }) =>
              relativePath === 'attempts.json'
              || relativePath === 'events.json'
              || relativePath.startsWith('evidence/') && !this.options.omitDiagnosticLogRead)
            .map(({ file, relativePath }, index) => ({
              toolCallId: `fixture-workspace-read-${index}`,
              toolId: 'workspace.read_file' as const,
              relativePath,
              contentHash: file.contentSha256,
              startLine: 1,
              endLine: Math.max(1, file.content.split('\n').length),
              assetVersionIds: [],
              chunkIds: [],
            }))
        : input.stage === 'script_generation'
          && input.task.input.method === 'api'
          && input.workspace.workspaceFiles.some(file => file.logicalPath.endsWith('/exploration/context.json'))
          ? [{
              toolCallId: 'fixture-api-contract-read',
              toolId: 'workspace.read_file' as const,
              relativePath: 'exploration/context.json',
              contentHash: 'fixture-contract',
              startLine: 1,
              endLine: 1,
              assetVersionIds: [],
              chunkIds: [],
            }]
          : [],
      knowledgeReads: input.stage === 'script_generation'
        && input.task.input.method === 'api'
        && !input.workspace.workspaceFiles.some(file => file.logicalPath.endsWith('/exploration/context.json'))
        ? [{
            toolCallId: 'fixture-knowledge-contract-read',
            toolId: 'knowledge.read_chunk' as const,
            chunkId: 'fixture-api-contract',
            assetVersionId: 'fixture-api-contract-version',
            logicalPath: 'api/openapi.json',
            sourceScope: 'knowledge_reference' as const,
            contentHash: 'fixture-contract',
            indexVersionId: 'fixture-index',
          }]
        : [],
    })
    assert.equal(validated.valid, true, JSON.stringify(validated.issues))
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

class FixturePlaywrightCliAdapter implements PlaywrightCliToolAdapter, PlaywrightBrowserCliAdapter {
  calls: Array<UiExecutionBrowserContext['phase']> = []
  browserCalls: string[] = []
  private readonly sessions = new Set<string>()
  private authenticated = false

  constructor(
    private readonly available = true,
    private readonly networkCandidates: RawUiNetworkObservation[] = [],
    private readonly authBootstrap = false,
  ) {}

  async explore(input: {
    baseUrl: string
    task: ExecutionTask
    phase: UiExecutionBrowserContext['phase']
  }) {
    this.calls.push(input.phase)
    return {
      tool: 'playwright-cli' as const,
      phase: input.phase,
      baseUrl: input.baseUrl,
      available: this.available,
      ...(this.available ? {
        snapshot: '- heading "状态页"\n- status [ref=e1]: Ready',
        locatorHints: ['- status [ref=e1]: Ready'],
        networkCandidates: structuredClone(this.networkCandidates),
      } : {
        locatorHints: [],
        error: 'PLAYWRIGHT_CLI_UNAVAILABLE',
      }),
    }
  }

  async open(session: string) {
    this.browserCalls.push('open')
    if (!this.available) throw new Error('PLAYWRIGHT_CLI_OPEN_FAILED_EXIT_1')
    this.sessions.add(session)
  }

  async stateLoad(session: string) {
    this.requireSession(session)
    this.browserCalls.push('state-load')
  }

  async stateSave(session: string, path: string) {
    this.requireSession(session)
    this.browserCalls.push('state-save')
    await writeFile(path, JSON.stringify({
      cookies: [],
      origins: [{
        origin: 'https://example.test',
        localStorage: [{ name: 'example_token', value: 'runtime-token' }],
      }],
    }), { encoding: 'utf8' })
  }

  async close(session: string) {
    this.browserCalls.push('close')
    this.sessions.delete(session)
  }

  async snapshot(session: string) {
    this.requireSession(session)
    this.browserCalls.push('snapshot')
    if (this.authBootstrap && !this.authenticated) {
      return 'url: https://example.test/login\n- textbox "用户名" [ref=e11]: environment-user\n- textbox "密码" [ref=e13]: environment-secret\n- button "登录" [ref=e14]'
    }
    if (this.authBootstrap) return 'url: https://example.test/tasks\n- heading "任务"\n- button "新建任务" [ref=e20]'
    return 'url: https://example.test/status\n- button "状态" [ref=e1]\n- textbox "账号" [ref=e2]'
  }

  async click(session: string, target: string) {
    this.requireSession(session)
    this.browserCalls.push(`click:${target}`)
    if (this.authBootstrap && target === 'e14') this.authenticated = true
    return 'clicked'
  }

  async fill(session: string, target: string) {
    this.requireSession(session)
    this.browserCalls.push(`fill:${target}`)
    return 'filled'
  }

  async generateLocator(session: string, target: string) {
    this.requireSession(session)
    this.browserCalls.push(`locator:${target}`)
    return `page.getByRole('button', { name: '状态' })`
  }

  async screenshot(session: string) {
    this.requireSession(session)
    this.browserCalls.push('screenshot')
    return 'ephemeral-screenshot'
  }

  async listRequests(session: string): Promise<PlaywrightCliRequestSummary[]> {
    this.requireSession(session)
    this.browserCalls.push('requests')
    return this.networkCandidates.map((candidate, index) => ({
      index,
      method: String(candidate.method ?? 'GET'),
      url: String(candidate.url ?? 'https://example.test/'),
      ...(candidate.responseStatus ? { status: candidate.responseStatus } : {}),
      ...(candidate.resourceType ? { resourceType: candidate.resourceType } : {}),
    }))
  }

  async requestDetail(
    session: string,
    summary: PlaywrightCliRequestSummary,
    observedFrom: Pick<RawUiNetworkObservation, 'page' | 'action' | 'actionType' | 'sequence'>,
  ) {
    this.requireSession(session)
    this.browserCalls.push(`request:${summary.index}`)
    return { ...structuredClone(this.networkCandidates[summary.index] ?? {}), ...observedFrom }
  }

  private requireSession(session: string) {
    if (!this.sessions.has(session)) throw new Error('FIXTURE_BROWSER_SESSION_NOT_FOUND')
  }
}

class SequenceRunner implements PlaywrightRunner {
  calls: Array<{
    attemptId: string
    package: ExecutionPackage
    authStatePath?: string
    apiAuthorization?: NonNullable<Parameters<PlaywrightRunner['execute']>[0]['workspace']>['apiAuthorization']
  }> = []

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
    workspace?: NonNullable<Parameters<PlaywrightRunner['execute']>[0]['workspace']>
  }) {
    this.calls.push({
      attemptId: input.attemptId,
      package: structuredClone(input.package),
      ...(input.workspace?.authStatePath ? { authStatePath: input.workspace.authStatePath } : {}),
      ...(input.workspace?.apiAuthorization
        ? { apiAuthorization: structuredClone(input.workspace.apiAuthorization) }
        : {}),
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
    playwrightCli: FixturePlaywrightCliAdapter
    job: ExecutionJob
    workspace?: LocalExecutionWorkspaceStore
  }) => Promise<void>,
  options: {
    environmentReadiness?: { ready: boolean; reason?: string }
    diagnosisCategory?: FailureDiagnosis['category']
    repairSource?: (ordinal: number) => string
    workspace?: boolean
    playwrightCliAvailable?: boolean
    networkCandidates?: RawUiNetworkObservation[]
    rejectMaintenanceProposalWrites?: boolean
    runtimeFailure?: string
    browserAuthBootstrap?: boolean
    diagnosticLog?: string
    omitDiagnosticLogRead?: boolean
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'smarthub-execution-service-'))
  try {
    const value = fixture()
    const store = new InMemoryExecutionStore(value)
    store.rejectMaintenanceProposalWrites = options.rejectMaintenanceProposalWrites ?? false
    const artifactStore = new LocalExecutionArtifactStore(root)
    const preparedResults = structuredClone(results)
    if (options.diagnosticLog) {
      const failed = preparedResults.find(result => result.status === 'failed')
      assert.ok(failed)
      const stored = await artifactStore.put({
        body: executionArtifactBody(options.diagnosticLog),
        mimeType: 'text/plain; charset=utf-8',
      })
      failed.artifacts = [...failed.artifacts, { ...stored, type: 'log' }]
    }
    const runner = new SequenceRunner(preparedResults)
    const runtime = new ScriptAgentRuntime(value.run.agents, options)
    const playwrightCli = new FixturePlaywrightCliAdapter(
      options.playwrightCliAvailable,
      options.networkCandidates,
      options.browserAuthBootstrap,
    )
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
      new UIExecutionAgent(playwrightCli),
      undefined,
      new PlaywrightBrowserToolGateway(playwrightCli),
    )
    await operation({ service, store, runner, runtime, playwrightCli, job: value.job, workspace })
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

test('已有有效 API Execution Binding 时 Execute First 直接运行 request fixture 依赖闭包', async () => {
  await withService([
    { status: 'passed', exitCode: 0, durationMs: 8, summary: '历史 API 入口通过', artifacts: [] },
  ], async ({ service, store, runner, runtime, playwrightCli, job, workspace }) => {
    assert.ok(workspace)
    store.task = { ...store.task, input: frozenApiInput() }
    const entryFile = 'tests/api/login.spec.ts'
    const entrySource = apiScriptSource(store.task.input.caseId)
    const dependencyFiles = [
      { path: 'api/auth-client.ts', contentSha256: createHash('sha256').update(apiClientSource, 'utf8').digest('hex') },
      { path: entryFile, contentSha256: createHash('sha256').update(entrySource, 'utf8').digest('hex') },
    ]
    await workspace.writeFiles(store.run.projectVersionId, [
      { path: 'api/auth-client.ts', content: apiClientSource },
      { path: entryFile, content: entrySource },
    ])
    await workspace.saveBinding({
      projectVersionId: store.run.projectVersionId,
      caseId: store.task.input.caseId,
      executionType: 'api',
      entryFile,
      entrySymbol: `[${store.task.input.caseId}]`,
      bindingStatus: 'validated',
      entrySha256: dependencyFiles[1].contentSha256,
      dependencyFiles,
      dependencySha256: executionBindingDependencySha256(dependencyFiles),
      caseContentSha256: store.task.input.caseContentSha256,
      validationPolicyVersion: CURRENT_EXECUTION_BINDING_VALIDATION_POLICY,
      createdAt: '2026-08-13T12:00:00.000Z',
      updatedAt: '2026-08-13T12:00:00.000Z',
    })

    const task = await service.processPreparedTask(job, lease, new AbortController().signal)
    assert.equal(task.status, 'passed')
    assert.deepEqual(runtime.calls, [])
    assert.deepEqual(playwrightCli.calls, [])
    assert.equal(runner.calls.length, 1)
    assert.equal(runner.calls[0].package.manifest.method, 'api')
    assert.deepEqual(runner.calls[0].package.files.map(file => file.path), [
      'api/auth-client.ts',
      entryFile,
    ])
  }, { workspace: true })
})

test('旧 API Binding 缺少当前契约验证策略时失效并重新进入 Agent Implement', async () => {
  await withService([
    { status: 'passed', exitCode: 0, durationMs: 8, summary: '重新生成 API 入口通过', artifacts: [] },
  ], async ({ service, store, runtime, job, workspace }) => {
    assert.ok(workspace)
    store.task = { ...store.task, input: frozenApiInput() }
    const entryFile = 'tests/api/legacy-login.spec.ts'
    const entrySource = apiScriptSource(store.task.input.caseId)
    const dependencyFiles = [
      { path: 'api/auth-client.ts', contentSha256: createHash('sha256').update(apiClientSource, 'utf8').digest('hex') },
      { path: entryFile, contentSha256: createHash('sha256').update(entrySource, 'utf8').digest('hex') },
    ]
    await workspace.writeFiles(store.run.projectVersionId, [
      { path: 'api/auth-client.ts', content: apiClientSource },
      { path: entryFile, content: entrySource },
    ])
    await workspace.saveBinding({
      projectVersionId: store.run.projectVersionId,
      caseId: store.task.input.caseId,
      executionType: 'api',
      entryFile,
      entrySymbol: `[${store.task.input.caseId}]`,
      bindingStatus: 'validated',
      entrySha256: dependencyFiles[1].contentSha256,
      dependencyFiles,
      dependencySha256: executionBindingDependencySha256(dependencyFiles),
      caseContentSha256: store.task.input.caseContentSha256,
      createdAt: '2026-08-13T12:00:00.000Z',
      updatedAt: '2026-08-13T12:00:00.000Z',
    })

    const task = await service.processPreparedTask(job, lease, new AbortController().signal)
    assert.equal(task.status, 'passed')
    assert.deepEqual(runtime.calls.map(call => call.stage), ['script_generation'])
    const rebound = await workspace.resolveBinding(store.run.projectVersionId, store.task.input.caseId, 'api')
    assert.equal(rebound?.validationPolicyVersion, CURRENT_EXECUTION_BINDING_VALIDATION_POLICY)
    assert.equal(rebound?.entryFile, governedExecutionEntryFile(store.task.input))
  }, { workspace: true })
})

test('受保护 API Binding 在 Attempt 前建立登录态并把 storageState 交给 Runner', async () => {
  await withService([
    { status: 'passed', exitCode: 0, durationMs: 8, summary: '认证 API 入口通过', artifacts: [] },
  ], async ({ service, store, runner, runtime, playwrightCli, job, workspace }) => {
    assert.ok(workspace)
    store.task = { ...store.task, input: frozenProtectedApiInput() }
    const entryFile = 'tests/api/tasks.spec.ts'
    const entrySource = `import { test, expect } from '@playwright/test'
test('拒绝任务非法状态枚举值且不改变已保存状态 [${store.task.input.caseId}]', async ({ request }) => {
  const response = await request.get('/api/tasks')
  // smarthub:assert expected-1
  expect(response.ok()).toBeTruthy()
})
`
    const entrySha256 = createHash('sha256').update(entrySource, 'utf8').digest('hex')
    await workspace.writeFiles(store.run.projectVersionId, [{ path: entryFile, content: entrySource }])
    await workspace.saveBinding({
      projectVersionId: store.run.projectVersionId,
      caseId: store.task.input.caseId,
      executionType: 'api',
      entryFile,
      entrySymbol: `[${store.task.input.caseId}]`,
      bindingStatus: 'validated',
      entrySha256,
      ...singleFileBindingDependency(entryFile, entrySource),
      caseContentSha256: store.task.input.caseContentSha256,
      validationPolicyVersion: CURRENT_EXECUTION_BINDING_VALIDATION_POLICY,
      createdAt: '2026-08-13T12:00:00.000Z',
      updatedAt: '2026-08-13T12:00:00.000Z',
    })

    const task = await service.processPreparedTask(job, lease, new AbortController().signal)
    assert.equal(task.status, 'passed')
    assert.deepEqual(runtime.calls, [])
    assert.equal(runner.calls.length, 1)
    assert.match(runner.calls[0].authStatePath ?? '', /\.runtime-auth[\\/]run-status[\\/]default\.json$/u)
    assert.deepEqual(runner.calls[0].apiAuthorization, {
      kind: 'bearer_local_storage',
      origin: 'https://example.test',
      localStorageKey: 'example_token',
    })
    assert.equal(playwrightCli.browserCalls.includes('click:e14'), true)
    assert.equal(playwrightCli.browserCalls.includes('state-save'), true)
  }, { workspace: true, browserAuthBootstrap: true })
})

test('受保护 API 无受管登录凭据时在 Runner 前进入人工处理', async () => {
  await withService([], async ({ service, store, runner, job, workspace }) => {
    assert.ok(workspace)
    store.task = { ...store.task, input: frozenProtectedApiInput() }
    const entryFile = 'tests/api/tasks.spec.ts'
    const entrySource = `import { test, expect } from '@playwright/test'
test('拒绝任务非法状态枚举值且不改变已保存状态 [${store.task.input.caseId}]', async ({ request }) => {
  const response = await request.get('/api/tasks')
  // smarthub:assert expected-1
  expect(response.ok()).toBeTruthy()
})
`
    const entrySha256 = createHash('sha256').update(entrySource, 'utf8').digest('hex')
    await workspace.writeFiles(store.run.projectVersionId, [{ path: entryFile, content: entrySource }])
    await workspace.saveBinding({
      projectVersionId: store.run.projectVersionId,
      caseId: store.task.input.caseId,
      executionType: 'api',
      entryFile,
      entrySymbol: `[${store.task.input.caseId}]`,
      bindingStatus: 'validated',
      entrySha256,
      ...singleFileBindingDependency(entryFile, entrySource),
      caseContentSha256: store.task.input.caseContentSha256,
      createdAt: '2026-08-13T12:00:00.000Z',
      updatedAt: '2026-08-13T12:00:00.000Z',
    })

    const task = await service.processPreparedTask(job, lease, new AbortController().signal)
    assert.equal(task.status, 'waiting_manual')
    assert.equal(task.error, 'BROWSER_AUTHENTICATION_ENTRY_NOT_FOUND')
    assert.equal(runner.calls.length, 0)
    assert.equal(store.attempts.length, 0)
  }, { workspace: true })
})

test('已有有效 Execution Binding 时直接 Runner，不调用 UIExecutionAgent 或实现 Agent', async () => {
  await withService([
    { status: 'passed', exitCode: 0, durationMs: 8, summary: '历史入口通过', artifacts: [] },
  ], async ({ service, store, runner, runtime, playwrightCli, job, workspace }) => {
    assert.ok(workspace)
    const entrySha256 = createHash('sha256').update(source, 'utf8').digest('hex')
    await workspace.writeFiles(store.run.projectVersionId, [{ path: 'tests/ui/status.spec.ts', content: source }])
    await workspace.saveBinding({
      projectVersionId: store.run.projectVersionId,
      caseId: store.task.input.caseId,
      executionType: 'ui',
      entryFile: 'tests/ui/status.spec.ts',
      entrySymbol: `[${store.task.input.caseId}]`,
      bindingStatus: 'validated',
      entrySha256,
      ...singleFileBindingDependency('tests/ui/status.spec.ts', source),
      caseContentSha256: store.task.input.caseContentSha256,
      validationPolicyVersion: CURRENT_EXECUTION_BINDING_VALIDATION_POLICY,
      createdAt: '2026-08-13T12:00:00.000Z',
      updatedAt: '2026-08-13T12:00:00.000Z',
    })
    const task = await service.processPreparedTask(job, lease, new AbortController().signal)
    assert.equal(task.status, 'passed')
    assert.equal(runner.calls.length, 1)
    assert.equal(runner.calls[0].package.manifest.entrypoint, 'tests/ui/status.spec.ts')
    assert.deepEqual(runtime.calls, [])
    assert.deepEqual(playwrightCli.calls, [])
    assert.equal(store.revisions[0].source, 'agent')
  }, { workspace: true })
})

test('同一 Case 的 UI/API Binding 跨 Run 同时 Execute First，不互相覆盖', async () => {
  await withService([
    { status: 'passed', exitCode: 0, durationMs: 8, summary: 'UI Binding 通过', artifacts: [] },
    { status: 'passed', exitCode: 0, durationMs: 3, summary: 'API Binding 通过', artifacts: [] },
  ], async ({ service, store, runner, runtime, job, workspace }) => {
    assert.ok(workspace)
    const caseId = store.task.input.caseId
    const projectVersionId = store.run.projectVersionId
    const dualCaseContent: TestCaseContent = {
      ...caseContent,
      executionMethods: ['ui', 'api'],
    }
    const dualContentSha256 = canonicalSha256(dualCaseContent)
    const inputFor = (method: 'ui' | 'api') => freezeExecutionTaskInput({
      libraryMember: {
        ...libraryMember,
        caseId,
        contentSha256: dualContentSha256,
        frozenContent: dualCaseContent,
      },
      handoffMember: {
        ...handoffMember,
        caseId,
        method,
        dedupKey: `${caseId}:1:${method}`,
        contentSha256: dualContentSha256,
        executionSpec: {
          schemaVersion: 'test-script-input/v1',
          method,
          testCase: dualCaseContent,
        },
      },
    })
    const uiInput = inputFor('ui')
    const apiInput = inputFor('api')
    store.task = { ...store.task, input: uiInput }
    const uiEntry = 'tests/ui/status.spec.ts'
    const apiEntry = 'tests/api/status.spec.ts'
    const apiSource = apiScriptSource(caseId)
    const apiDependencies = [
      { path: 'api/auth-client.ts', contentSha256: createHash('sha256').update(apiClientSource, 'utf8').digest('hex') },
      { path: apiEntry, contentSha256: createHash('sha256').update(apiSource, 'utf8').digest('hex') },
    ]
    await workspace.writeFiles(store.run.projectVersionId, [
      { path: uiEntry, content: source },
      { path: 'api/auth-client.ts', content: apiClientSource },
      { path: apiEntry, content: apiSource },
    ])
    await workspace.saveBinding({
      projectVersionId: store.run.projectVersionId, caseId, executionType: 'ui',
      entryFile: uiEntry, entrySymbol: `[${caseId}]`, bindingStatus: 'validated',
      entrySha256: createHash('sha256').update(source, 'utf8').digest('hex'),
      ...singleFileBindingDependency(uiEntry, source),
      caseContentSha256: uiInput.caseContentSha256,
      validationPolicyVersion: CURRENT_EXECUTION_BINDING_VALIDATION_POLICY,
      createdAt: '2026-08-13T12:00:00.000Z', updatedAt: '2026-08-13T12:00:00.000Z',
    })
    await workspace.saveBinding({
      projectVersionId: store.run.projectVersionId, caseId, executionType: 'api',
      entryFile: apiEntry, entrySymbol: `[${caseId}]`, bindingStatus: 'validated',
      entrySha256: apiDependencies[1].contentSha256,
      dependencyFiles: apiDependencies,
      dependencySha256: executionBindingDependencySha256(apiDependencies),
      caseContentSha256: apiInput.caseContentSha256,
      validationPolicyVersion: CURRENT_EXECUTION_BINDING_VALIDATION_POLICY,
      createdAt: '2026-08-13T12:00:00.000Z', updatedAt: '2026-08-13T12:00:00.000Z',
    })

    const uiTask = await service.processPreparedTask(job, lease, new AbortController().signal)
    assert.equal(uiTask.status, 'passed')

    const next = fixture()
    store.run = {
      ...next.run,
      id: 'run-dual-method-api',
      projectVersionId,
      idempotencyKey: 'idempotency-dual-method-api',
    }
    store.task = {
      ...next.task,
      id: 'task-dual-method-api',
      runId: store.run.id,
      input: apiInput,
    }
    store.job = {
      ...next.job,
      id: 'job-dual-method-api',
      runId: store.run.id,
      taskId: store.task.id,
    }
    const apiTask = await service.processPreparedTask(
      store.job,
      lease,
      new AbortController().signal,
    )

    assert.equal(apiTask.status, 'passed')
    assert.deepEqual(runtime.calls, [])
    assert.deepEqual(runner.calls.map(call => call.package.manifest.method), ['ui', 'api'])
    assert.equal((await workspace.resolveBinding(store.run.projectVersionId, caseId, 'ui'))?.entryFile, uiEntry)
    assert.equal((await workspace.resolveBinding(store.run.projectVersionId, caseId, 'api'))?.entryFile, apiEntry)
  }, { workspace: true })
})

test('继承 Binding 真实通过后升级 validated，真实失败不自动判 invalid', async () => {
  const bindInheritedEntry = async (
    workspace: LocalExecutionWorkspaceStore,
    store: InMemoryExecutionStore,
  ) => {
    const entrySha256 = createHash('sha256').update(source, 'utf8').digest('hex')
    await workspace.writeFiles(store.run.projectVersionId, [{ path: 'tests/ui/status.spec.ts', content: source }])
    await workspace.saveBinding({
      projectVersionId: store.run.projectVersionId,
      caseId: store.task.input.caseId,
      executionType: 'ui',
      entryFile: 'tests/ui/status.spec.ts',
      entrySymbol: `[${store.task.input.caseId}]`,
      bindingStatus: 'needs_validation',
      entrySha256,
      ...singleFileBindingDependency('tests/ui/status.spec.ts', source),
      caseContentSha256: store.task.input.caseContentSha256,
      validationPolicyVersion: CURRENT_EXECUTION_BINDING_VALIDATION_POLICY,
      createdAt: '2026-08-13T12:00:00.000Z',
      updatedAt: '2026-08-13T12:00:00.000Z',
    })
  }

  await withService([
    { status: 'passed', exitCode: 0, durationMs: 8, summary: '继承入口通过', artifacts: [] },
  ], async ({ service, store, runtime, job, workspace }) => {
    assert.ok(workspace)
    await bindInheritedEntry(workspace, store)
    const task = await service.processPreparedTask(job, lease, new AbortController().signal)
    assert.equal(task.status, 'passed')
    assert.deepEqual(runtime.calls, [])
    assert.equal((await workspace.resolveBinding(store.run.projectVersionId, store.task.input.caseId, 'ui'))?.bindingStatus, 'validated')
  }, { workspace: true })

  await withService([
    { status: 'failed', exitCode: 1, durationMs: 8, summary: '产品行为失败', error: 'expected Ready', artifacts: [] },
  ], async ({ service, store, job, workspace }) => {
    assert.ok(workspace)
    await bindInheritedEntry(workspace, store)
    const task = await service.processPreparedTask(job, lease, new AbortController().signal)
    assert.equal(task.status, 'failed')
    assert.equal((await workspace.resolveBinding(store.run.projectVersionId, store.task.input.caseId, 'ui'))?.bindingStatus, 'needs_validation')
  }, { workspace: true, diagnosisCategory: 'product_defect' })
})

test('Binding 按执行方法独立复用，缺少当前方法时由 Agent 生成且保留另一方法', async () => {
  await withService([
    { status: 'passed', exitCode: 0, durationMs: 8, summary: '新入口通过', artifacts: [] },
  ], async ({ service, store, runtime, job, workspace }) => {
    assert.ok(workspace)
    const entrySha256 = createHash('sha256').update(source, 'utf8').digest('hex')
    await workspace.writeFiles(store.run.projectVersionId, [{ path: 'tests/ui/status.spec.ts', content: source }])
    await workspace.saveBinding({
      projectVersionId: store.run.projectVersionId,
      caseId: store.task.input.caseId,
      executionType: 'api',
      entryFile: 'tests/ui/status.spec.ts',
      entrySymbol: `[${store.task.input.caseId}]`,
      bindingStatus: 'needs_validation',
      entrySha256,
      ...singleFileBindingDependency('tests/ui/status.spec.ts', source),
      caseContentSha256: store.task.input.caseContentSha256,
      createdAt: '2026-08-13T12:00:00.000Z',
      updatedAt: '2026-08-13T12:00:00.000Z',
    })
    const recordedStatuses: string[] = []
    const original = workspace.setBindingStatus.bind(workspace)
    workspace.setBindingStatus = async (projectVersionId, caseId, executionType, status) => {
      recordedStatuses.push(status)
      return original(projectVersionId, caseId, executionType, status)
    }
    const task = await service.processPreparedTask(job, lease, new AbortController().signal)
    assert.equal(task.status, 'passed')
    assert.deepEqual(recordedStatuses, [])
    assert.equal(runtime.calls.some(call => call.stage === 'script_generation'), true)
    assert.equal((await workspace.resolveBinding(store.run.projectVersionId, store.task.input.caseId, 'ui'))?.bindingStatus, 'validated')
    assert.equal((await workspace.resolveBinding(store.run.projectVersionId, store.task.input.caseId, 'api'))?.bindingStatus, 'needs_validation')
  }, { workspace: true })
})

test('旧 UI Binding 缺少初始导航时先失效再由 Agent 重新生成', async () => {
  await withService([
    { status: 'passed', exitCode: 0, durationMs: 8, summary: '重新生成入口通过', artifacts: [] },
  ], async ({ service, store, runtime, job, workspace }) => {
    assert.ok(workspace)
    const legacySource = source.replace("  await page.goto('/status')\n", '')
    const entryFile = 'tests/ui/status.spec.ts'
    const entrySha256 = createHash('sha256').update(legacySource, 'utf8').digest('hex')
    await workspace.writeFiles(store.run.projectVersionId, [{ path: entryFile, content: legacySource }])
    await workspace.saveBinding({
      projectVersionId: store.run.projectVersionId,
      caseId: store.task.input.caseId,
      executionType: 'ui',
      entryFile,
      entrySymbol: `[${store.task.input.caseId}]`,
      bindingStatus: 'validated',
      entrySha256,
      ...singleFileBindingDependency(entryFile, legacySource),
      caseContentSha256: store.task.input.caseContentSha256,
      createdAt: '2026-08-13T12:00:00.000Z',
      updatedAt: '2026-08-13T12:00:00.000Z',
    })
    const recordedStatuses: string[] = []
    const original = workspace.setBindingStatus.bind(workspace)
    workspace.setBindingStatus = async (projectVersionId, caseId, executionType, status) => {
      recordedStatuses.push(status)
      return original(projectVersionId, caseId, executionType, status)
    }

    const task = await service.processPreparedTask(job, lease, new AbortController().signal)

    assert.equal(task.status, 'passed')
    assert.equal(recordedStatuses[0], 'invalid')
    assert.equal(runtime.calls.some(call => call.stage === 'script_generation'), true)
    assert.equal((await workspace.resolveBinding(store.run.projectVersionId, store.task.input.caseId, 'ui'))?.bindingStatus, 'validated')
  }, { workspace: true })
})

test('Workspace 历史入口首次失败后才调用 CLI 诊断，产品缺陷不修改 Workspace', async () => {
  await withService([
    { status: 'failed', exitCode: 1, durationMs: 8, summary: '业务断言失败', error: 'expected Ready', artifacts: [] },
  ], async ({ service, store, runtime, playwrightCli, job, workspace }) => {
    assert.ok(workspace)
    const entrySha256 = createHash('sha256').update(source, 'utf8').digest('hex')
    await workspace.writeFiles(store.run.projectVersionId, [{ path: 'tests/ui/status.spec.ts', content: source }])
    await workspace.saveBinding({
      projectVersionId: store.run.projectVersionId, caseId: store.task.input.caseId,
      executionType: 'ui', entryFile: 'tests/ui/status.spec.ts', entrySymbol: `[${store.task.input.caseId}]`,
      bindingStatus: 'validated', entrySha256, caseContentSha256: store.task.input.caseContentSha256,
      ...singleFileBindingDependency('tests/ui/status.spec.ts', source),
      validationPolicyVersion: CURRENT_EXECUTION_BINDING_VALIDATION_POLICY,
      createdAt: '2026-08-13T12:00:00.000Z', updatedAt: '2026-08-13T12:00:00.000Z',
    })
    const task = await service.processPreparedTask(job, lease, new AbortController().signal)
    assert.equal(task.status, 'failed')
    assert.equal(store.task.runnerAttemptCount, 1)
    assert.deepEqual(runtime.calls.map(call => call.stage), ['failure_diagnosis'])
    assert.deepEqual(playwrightCli.calls, ['failure_analysis'])
    assert.equal(runtime.calls[0].uiExecution?.snapshot?.includes('状态页'), true)
    assert.equal(store.revisions.filter(revision => revision.source === 'repair').length, 0)
    assert.equal(store.diagnoses[0].repairable, false)
    assert.equal(store.diagnoses[0].recommendedAction, '记录产品缺陷，不进入脚本修复 Stage')
    assert.equal(store.diagnoses[0].attemptIds[0], store.attempts[0].id)
    assert.equal(store.diagnoses[0].evidence[0].attemptId, store.attempts[0].id)
    const evidence = runtime.calls[0].workspace.workspaceFiles.find(file =>
      workspaceRelativePath(runtime.calls[0].workspace, file.logicalPath).startsWith('evidence/'))
    assert.ok(evidence)
    assert.match(evidence.content, /Received: false/u)
    assert.doesNotMatch(evidence.content, /runtime-only-token/u)
    assert.doesNotMatch(evidence.content, /Users\\Alice/u)
    assert.equal((await workspace.readEntry(store.run.projectVersionId, { entryFile: 'tests/ui/status.spec.ts' })), source)
  }, {
    workspace: true,
    diagnosisCategory: 'product_defect',
    diagnosticLog: 'Error: expect(received).toBeTruthy()\nReceived: false\nAuthorization: Bearer runtime-only-token\nC:\\Users\\Alice\\repo\\tests\\ui\\status.spec.ts:8:3\n',
  })
})

test('失败诊断缺少日志读取时返回终态 Attempt 的实际 evidence 路径', async () => {
  await withService([
    { status: 'failed', exitCode: 1, durationMs: 8, summary: '业务断言失败', error: 'expected Ready', artifacts: [] },
  ], async ({ service, job }) => {
    await assert.rejects(
      service.processPreparedTask(job, lease, new AbortController().signal),
      error => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, /evidence\/attempt-1\/runner-test_execution_artifact_[a-f0-9]+\.log/u)
        assert.doesNotMatch(message, /<terminal-attempt-runner-log>/u)
        return true
      },
    )
  }, {
    workspace: true,
    diagnosisCategory: 'product_defect',
    diagnosticLog: 'Error: expect(received).toBeTruthy()\nReceived: false\n',
    omitDiagnosticLogRead: true,
  })
})

test('已登录 UI Case 的失败诊断省略不可靠的 CLI 登录页快照', async () => {
  await withService([
    { status: 'failed', exitCode: 1, durationMs: 8, summary: 'selector 不存在', error: 'locator not found', artifacts: [] },
  ], async ({ service, store, runtime, playwrightCli, job, workspace }) => {
    assert.ok(workspace)
    store.task = { ...store.task, input: frozenProtectedUiInput() }
    const entrySource = scriptSource('missing-status', store.task.input.caseId)
    const entryFile = 'tests/ui/protected-status.spec.ts'
    const entrySha256 = createHash('sha256').update(entrySource, 'utf8').digest('hex')
    await workspace.writeFiles(store.run.projectVersionId, [{ path: entryFile, content: entrySource }])
    await workspace.saveBinding({
      projectVersionId: store.run.projectVersionId,
      caseId: store.task.input.caseId,
      executionType: 'ui',
      entryFile,
      entrySymbol: `[${store.task.input.caseId}]`,
      bindingStatus: 'validated',
      entrySha256,
      ...singleFileBindingDependency(entryFile, entrySource),
      caseContentSha256: store.task.input.caseContentSha256,
      validationPolicyVersion: CURRENT_EXECUTION_BINDING_VALIDATION_POLICY,
      createdAt: '2026-08-13T12:00:00.000Z',
      updatedAt: '2026-08-13T12:00:00.000Z',
    })

    const task = await service.processPreparedTask(job, lease, new AbortController().signal)
    assert.equal(task.status, 'failed')
    assert.deepEqual(playwrightCli.calls, [])
    assert.equal(runtime.calls[0].uiExecution, undefined)
  }, { workspace: true, diagnosisCategory: 'product_defect', browserAuthBootstrap: true })
})

test('Workspace script_defect 仅在 CLI 诊断后修改代码并 Retry', async () => {
  await withService([
    { status: 'failed', exitCode: 1, durationMs: 8, summary: 'selector 不存在', error: 'locator not found', artifacts: [] },
    { status: 'passed', exitCode: 0, durationMs: 7, summary: '修复后通过', artifacts: [] },
  ], async ({ service, store, runtime, playwrightCli, job, workspace }) => {
    assert.ok(workspace)
    const entrySha256 = createHash('sha256').update(source, 'utf8').digest('hex')
    await workspace.writeFiles(store.run.projectVersionId, [{ path: 'tests/ui/status.spec.ts', content: source }])
    await workspace.saveBinding({
      projectVersionId: store.run.projectVersionId, caseId: store.task.input.caseId,
      executionType: 'ui', entryFile: 'tests/ui/status.spec.ts', entrySymbol: `[${store.task.input.caseId}]`,
      bindingStatus: 'validated', entrySha256, caseContentSha256: store.task.input.caseContentSha256,
      ...singleFileBindingDependency('tests/ui/status.spec.ts', source),
      validationPolicyVersion: CURRENT_EXECUTION_BINDING_VALIDATION_POLICY,
      createdAt: '2026-08-13T12:00:00.000Z', updatedAt: '2026-08-13T12:00:00.000Z',
    })
    const task = await service.processPreparedTask(job, lease, new AbortController().signal)
    assert.equal(task.status, 'passed')
    assert.equal(store.task.runnerAttemptCount, 2)
    assert.equal(store.revisions.filter(revision => revision.source === 'repair').length, 1)
    assert.deepEqual(runtime.calls.map(call => call.stage), ['failure_diagnosis', 'script_repair'])
    assert.deepEqual(playwrightCli.calls, ['failure_analysis'])
    assert.equal(playwrightCli.browserCalls.filter(call => call === 'open').length, 1)
    assert.equal(playwrightCli.browserCalls.includes('locator:e1'), true)
    const repairCall = runtime.calls[1]
    assert.equal(repairCall.stageContext?.parentScriptRevisionId, store.revisions[0].id)
    assert.equal(repairCall.stageContext?.diagnosisId, store.diagnoses[0].id)
    assert.deepEqual(repairCall.stageContext?.attemptIds, [store.attempts[0].id])
    assert.equal(repairCall.workspace.workspaceFiles.some(file => file.logicalPath.endsWith('/script-revision.json')), true)
    assert.equal(repairCall.workspace.workspaceFiles.some(file => file.logicalPath.endsWith('/current.spec.ts')), true)
    assert.equal(repairCall.workspace.workspaceFiles.some(file => file.logicalPath.endsWith('/attempts.json')), true)
    assert.equal(repairCall.workspace.workspaceFiles.some(file => file.logicalPath.endsWith('/events.json')), true)
    assert.equal(repairCall.workspace.workspaceFiles.some(file => file.logicalPath.endsWith('/diagnoses.json')), true)
    assert.equal(repairCall.workspace.workspaceFiles.some(file => file.logicalPath.endsWith('/artifacts.json')), true)
    const workspaceRoot = repairCall.workspace.documentWorkspace.rootLogicalPath
      ?? repairCall.workspace.documentWorkspace.logicalPath
    assert.equal(
      repairCall.workspace.workspaceFiles.every(file => file.logicalPath.startsWith(`${workspaceRoot}/`)),
      true,
    )
    assert.equal(
      repairCall.workspace.workspaceFiles.some(file => file.logicalPath.startsWith(`${workspaceRoot}/execution/`)),
      true,
    )
    assert.equal(repairCall.workspace.documentWorkspace.layoutVersion, undefined)
    assert.equal(repairCall.workspace.documentWorkspace.activeBranchLogicalPath, undefined)
    assert.equal(store.diagnoses[0].repairable, true)
    assert.equal(store.diagnoses[0].confidence, 0.5)
    assert.match(store.diagnoses[0].recommendedAction, /服务端.*受控脚本修复/u)
    assert.equal(store.revisions.find(revision => revision.source === 'repair')?.parentRevisionId, store.revisions[0].id)
    assert.equal((await workspace.resolveBinding(store.run.projectVersionId, store.task.input.caseId, 'ui'))?.bindingStatus, 'validated')
  }, { workspace: true, diagnosisCategory: 'script_defect' })
})

test('新 UI Case 由 ExecutionImplementationAgent 多轮调用 Browser Tools 后写入 Workspace、建立 Binding 并 Runner', async () => {
  await withService([
    { status: 'passed', exitCode: 0, durationMs: 8, summary: '新入口通过', artifacts: [] },
  ], async ({ service, store, runner, runtime, playwrightCli, job, workspace }) => {
    assert.ok(workspace)
    const task = await service.processPreparedTask(job, lease, new AbortController().signal)
    assert.equal(task.status, 'passed')
    assert.deepEqual(playwrightCli.calls, [])
    assert.equal(runtime.calls[0].stage, 'script_generation')
    assert.equal(runtime.calls[0].uiExecution, undefined)
    assert.deepEqual(runtime.calls[0].browserToolIds, [
      'browser.snapshot',
      'browser.click',
      'browser.fill',
      'browser.get_locator',
      'browser.requests',
      'browser.request_detail',
      'browser.screenshot',
    ])
    assert.deepEqual(playwrightCli.browserCalls, [
      'open',
      'snapshot',
      'click:e1',
      'snapshot',
      'requests',
      'requests',
      'close',
    ])
    const binding = await workspace.resolveBinding(store.run.projectVersionId, store.task.input.caseId, 'ui')
    assert.equal(binding?.entryFile, governedExecutionEntryFile(store.task.input))
    assert.equal(binding?.bindingStatus, 'validated')
    assert.equal(runner.calls.length, 1)
  }, { workspace: true })
})

test('UI Exploration 将 Action 关联业务 API 脱敏沉淀到当前 ProjectVersion 并交付 Agent', async () => {
  await withService([
    { status: 'passed', exitCode: 0, durationMs: 8, summary: 'UI 入口通过', artifacts: [] },
  ], async ({ service, store, runtime, job, workspace }) => {
    assert.ok(workspace)
    const task = await service.processPreparedTask(job, lease, new AbortController().signal)
    assert.equal(task.status, 'passed')
    const [result] = await workspace.listExplorationResults(store.run.projectVersionId)
    assert.equal(result.sourceCaseId, store.task.input.caseId)
    assert.equal(result.method, 'POST')
    assert.equal(result.path, '/api/login')
    assert.equal(result.observedFrom.action, 'click e1')
    assert.equal(result.requestHeaders.authorization, '<REDACTED>')
    assert.equal(result.requestSchema?.properties?.password.redacted, true)
    assert.equal(result.responseSchema?.properties?.token.redacted, true)
    assert.equal(result.validationStatus, 'validated')
    assert.doesNotMatch(JSON.stringify(result), /real-password|real-token|real-authorization|real-session/u)
    assert.equal(runtime.calls[0].workspace.workspaceFiles.some(
      file => file.logicalPath.endsWith('/exploration/context.json'),
    ), false)
  }, {
    workspace: true,
    networkCandidates: [{
      method: 'POST',
      url: 'https://example.test/api/login',
      resourceType: 'fetch',
      requestHeaders: {
        authorization: 'Bearer real-authorization',
        cookie: 'session=real-session',
        'content-type': 'application/json',
      },
      requestBody: { username: 'real-user', password: 'real-password' },
      responseStatus: 200,
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: { token: 'real-token', user: { id: 42 } },
      page: '/login',
      action: 'click 登录',
      actionType: 'click',
      sequence: 2,
    }],
  })
})

test('API Case 无 Binding 时优先获得当前 ProjectVersion Exploration Context 且不调用 UIExecutionAgent', async () => {
  await withService([
    { status: 'passed', exitCode: 0, durationMs: 8, summary: 'API 入口通过', artifacts: [] },
  ], async ({ service, store, runtime, playwrightCli, job, workspace }) => {
    assert.ok(workspace)
    const apiCaseContent: TestCaseContent = {
      ...caseContent,
      title: '正确账号登录 API',
      executionMethods: ['api'],
      steps: ['调用登录接口'],
      expectedResults: ['返回登录成功'],
    }
    const apiInput = freezeExecutionTaskInput({
      libraryMember: {
        ...libraryMember,
        caseId: 'TC_API_LOGIN_001',
        contentSha256: canonicalSha256(apiCaseContent),
        frozenContent: apiCaseContent,
      },
      handoffMember: {
        ...handoffMember,
        caseId: 'TC_API_LOGIN_001',
        dedupKey: 'TC_API_LOGIN_001:1:api',
        method: 'api',
        contentSha256: canonicalSha256(apiCaseContent),
        executionSpec: {
          schemaVersion: 'test-script-input/v1',
          method: 'api',
          testCase: apiCaseContent,
        },
      },
    })
    store.task = { ...store.task, input: apiInput }
    const observation = normalizeUiNetworkObservation({
      method: 'POST',
      url: 'https://example.test/api/login',
      resourceType: 'xhr',
      requestBody: { username: 'observed-user', password: 'observed-password' },
      responseStatus: 200,
      responseBody: { token: 'observed-token', user: { id: 1 } },
      page: '/login',
      action: 'click 登录',
      actionType: 'click',
      sequence: 2,
    })!
    await workspace.saveExplorationResults(store.run.projectVersionId, [
      createProjectVersionExplorationResult({
        projectVersionId: store.run.projectVersionId,
        sourceCaseId: 'TC_UI_LOGIN_001',
        environmentSignature: store.run.environment.signature,
        sourceRunId: 'run-ui-login',
        sourceTaskId: 'task-ui-login',
        observedAt: '2026-08-13T11:00:00.000Z',
        observation,
      }),
    ])

    const task = await service.processPreparedTask(job, lease, new AbortController().signal)
    assert.equal(task.status, 'passed')
    assert.deepEqual(playwrightCli.calls, [])
    assert.deepEqual(runtime.calls.map(call => call.stage), ['script_generation'])
    const contextFile = runtime.calls[0].workspace.workspaceFiles.find(
      file => file.logicalPath.endsWith('/exploration/context.json'),
    )
    assert.ok(contextFile)
    assert.ok(contextFile.logicalPath.startsWith(`${runtime.calls[0].workspace.documentWorkspace.rootLogicalPath}/`))
    const context = JSON.parse(contextFile.content) as {
      projectVersionId: string
      authority: string
      results: Array<{ sourceCaseId: string; method: string; path: string; validationStatus: string }>
    }
    assert.equal(context.projectVersionId, store.run.projectVersionId)
    assert.equal(context.authority, 'runtime_observed_knowledge')
    assert.deepEqual(context.results.map(result => ({
      sourceCaseId: result.sourceCaseId,
      method: result.method,
      path: result.path,
      validationStatus: result.validationStatus,
    })), [{
      sourceCaseId: 'TC_UI_LOGIN_001',
      method: 'POST',
      path: '/api/login',
      validationStatus: 'validated',
    }])
    const binding = await workspace.resolveBinding(store.run.projectVersionId, store.task.input.caseId, 'api')
    const governedEntry = governedExecutionEntryFile(store.task.input)
    assert.equal(binding?.entryFile, governedEntry)
    assert.deepEqual(binding?.dependencyFiles.map(file => file.path), [
      'api/auth-client.ts',
      governedEntry,
    ])
    assert.deepEqual(store.revisions[0].sourceArtifacts.map(file => file.path), [
      'api/auth-client.ts',
      governedEntry,
    ])
  }, { workspace: true })
})

test('新 UI Case 无法创建受控 Browser Session 时不允许凭空生成脚本', async () => {
  await withService([], async ({ service, runtime, playwrightCli, job }) => {
    await assert.rejects(
      service.processPreparedTask(job, lease, new AbortController().signal),
      /PLAYWRIGHT_CLI_OPEN_FAILED_EXIT_1/u,
    )
    assert.deepEqual(playwrightCli.calls, [])
    assert.deepEqual(playwrightCli.browserCalls, ['open', 'close'])
    assert.deepEqual(runtime.calls, [])
  }, { workspace: true, playwrightCliAvailable: false })
})

for (const runtimeFailure of ['MODEL_EXECUTION_FAILED', 'AGENT_DEADLINE_EXCEEDED', 'AGENT_CANCELLED']) {
  test(`ExecutionImplementationAgent ${runtimeFailure} 时 Service 仍关闭 Browser Session`, async () => {
    await withService([], async ({ service, store, runner, playwrightCli, job }) => {
      await assert.rejects(
        service.processPreparedTask(job, lease, new AbortController().signal),
        new RegExp(runtimeFailure, 'u'),
      )
      assert.equal(playwrightCli.browserCalls[0], 'open')
      assert.equal(playwrightCli.browserCalls.at(-1), 'close')
      assert.equal(store.task.status, 'script_generating')
      assert.equal(store.attempts.length, 0)
      assert.equal(runner.calls.length, 0)
    }, { workspace: true, runtimeFailure })
  })
}

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

test('Runner 结构化失败事件按 Attempt 持久化、关联截图与 Trace 并在 Service 边界脱敏', async () => {
  const screenshotSha256 = 'a'.repeat(64)
  const traceSha256 = 'b'.repeat(64)
  const runnerFailure: SandboxExecutionResult = {
    status: 'failed',
    exitCode: 1,
    durationMs: 25,
    summary: '断言失败',
    error: 'expected Ready',
    artifacts: [
      { type: 'screenshot', storagePath: 'objects/a.png', sha256: screenshotSha256, size: 8, mimeType: 'image/png' },
      { type: 'trace', storagePath: 'objects/b.zip', sha256: traceSha256, size: 16, mimeType: 'application/zip' },
    ],
    events: [
      {
        sequence: 1,
        type: 'http',
        title: 'POST https://example.test/api/orders?token=secret-value -> 500 token=secret-value',
        status: 'failed',
        startedAt: '2026-08-13T11:59:59.975Z',
        durationMs: 20,
        artifactSha256s: [screenshotSha256, traceSha256],
        metadata: {
          method: 'POST',
          path: '/api/orders?session=secret-session',
          queryFields: ['token'],
          authorization: 'Bearer secret-token',
          nested: { cookie: 'secret-cookie' },
        },
      },
      {
        sequence: 2,
        type: 'failure',
        title: '业务断言失败 password=secret-password',
        status: 'failed',
        startedAt: '2026-08-13T11:59:59.995Z',
        finishedAt: '2026-08-13T12:00:00.000Z',
        durationMs: 5,
        artifactSha256s: [screenshotSha256, traceSha256],
      },
    ],
  }
  await withService([runnerFailure, structuredClone(runnerFailure)], async ({ service, store, job }) => {
    const task = await service.processPreparedTask(job, lease, new AbortController().signal)
    assert.equal(task.status, 'failed')
    const detail = await service.taskDetail(store.task.id)
    assert.deepEqual(detail.events.map(event => event.sequence), [1, 2, 1, 2])
    assert.deepEqual([...new Set(detail.events.map(event => event.attemptId))], store.attempts.map(attempt => attempt.id))
    assert.equal(detail.events.every(event => event.artifactIds?.length === 2), true)
    assert.deepEqual(detail.events[0].metadata, {
      method: 'POST',
      path: '/api/orders',
      queryFields: ['token'],
      authorization: '<REDACTED>',
      nested: { cookie: '<REDACTED>' },
    })
    assert.equal(detail.events[0].title, 'POST /api/orders -> 500 token=<REDACTED>')
    assert.equal(detail.events[1].title, '业务断言失败 password=<REDACTED>')
    assert.doesNotMatch(JSON.stringify(detail.events), /secret-value|secret-session|secret-token|secret-cookie|secret-password/u)
    assert.deepEqual(detail.artifacts.filter(artifact => artifact.type !== 'script').map(artifact => artifact.type), ['screenshot', 'trace', 'screenshot', 'trace'])
  }, { diagnosisCategory: 'product_defect' })
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
  test(`TestExecutionService ${diagnosisCategory} repair 经真实 post_repair PASS 后直接结束且 Proposal 写入失败也不阻塞`, async () => {
    await withService([
      { status: 'failed', exitCode: 1, durationMs: 10, summary: '首次失败', error: 'locator 未匹配', artifacts: [] },
      { status: 'failed', exitCode: 1, durationMs: 11, summary: '重试失败', error: 'locator 未匹配', artifacts: [] },
      { status: 'passed', exitCode: 0, durationMs: 8, summary: '修复后通过', artifacts: [] },
    ], async ({ service, store, job }) => {
      const task = await service.processPreparedTask(job, lease, new AbortController().signal)
      assert.equal(task.status, 'passed')
      assert.equal(store.maintenanceProposals.length, 0)
      assert.equal(store.maintenanceProposalWriteAttempts, 1)
      const original = store.revisions[0]
      const repair = store.revisions[1]
      assert.equal(repair.parentRevisionId, original.id)
      assert.equal(repair.protectedAssertionSha256, original.protectedAssertionSha256)
      assert.equal(store.attempts.at(-1)?.kind, 'post_repair')
      assert.equal(store.attempts.at(-1)?.status, 'passed')
    }, { diagnosisCategory, rejectMaintenanceProposalWrites: true })
  })
}

test('真实 post_repair PASS 生成待人工决策的维护建议且不修改正式用例', async () => {
  await withService([
    { status: 'failed', exitCode: 1, durationMs: 10, summary: '首次失败', error: 'locator 未匹配', artifacts: [] },
    { status: 'failed', exitCode: 1, durationMs: 11, summary: '重试失败', error: 'locator 未匹配', artifacts: [] },
    { status: 'passed', exitCode: 0, durationMs: 8, summary: '修复后通过', artifacts: [] },
  ], async ({ service, store, job }) => {
    const task = await service.processPreparedTask(job, lease, new AbortController().signal)
    assert.equal(task.status, 'passed')
    assert.equal(store.maintenanceProposals.length, 1)
    assert.equal(store.maintenanceProposals[0].status, 'pending')
    assert.equal(store.maintenanceProposals[0].caseId, store.task.input.caseId)
    assert.equal(store.maintenanceProposals[0].diagnosisId, store.diagnoses[0].id)
    assert.equal(store.maintenanceProposals[0].scriptRevisionId, store.revisions[1].id)
    assert.match(store.maintenanceProposals[0].proposedChange, /不得修改 Expected Result/u)
  }, { diagnosisCategory: 'script_defect' })
})

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

test('TestExecutionService Binding 缺失时进入 Agent Implement，不回放旧 ScriptArtifact Cache', async () => {
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
      summary: '新 Workspace 脚本通过',
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
      projectVersionId: 'project-version-without-binding',
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
      call.stage === 'script_generation').length, 2)
    const implementedRevision = store.revisions.at(-1)!
    assert.equal(implementedRevision.source, 'agent')
    assert.equal(implementedRevision.cacheSourceRevisionId, undefined)
    assert.notEqual(implementedRevision.id, sourceRevision.id)
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
