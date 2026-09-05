import { randomUUID } from 'node:crypto'
import type { Principal } from '../domain/access-control.js'
import type { AgentExecutionEvent } from '../domain/agent-types.js'
import type { DatabaseState } from '../domain/types.js'
import { requirementReleaseBindings } from '../domain/requirement-release-bindings.js'
import type {
  CaseChangeDecision,
  CaseChangeProposal,
  CreateTestDesignInput,
  LibraryTestCase,
  TestCase,
  TestCaseContent,
  TestCaseLibraryVersion,
  TestDesign,
  TestDesignWorkspaceFile,
  TestDesignRunAgentConfigurationSnapshot,
  TestDesignWorkflowRun,
  TestExecutionHandoff,
  TestExecutionMethod,
  TestSuiteDraft,
  TestSuiteVersion,
  WorkflowNodeRun,
} from '../domain/test-design-types.js'
import type { StateStore, TaskLease, TestDesignReadScope } from '../infrastructure/store.js'
import { canonicalSha256 } from './canonical-json.js'
import {
  assertEtag,
  etag,
  TestDesignError,
  validateCreateTestDesignInput,
  validateTestCaseContent,
} from './test-design-validation.js'
import {
  required,
  designState,
  readDesignState,
  now,
  newest,
  findDesign,
  findRun,
  findRunById,
  errorCode,
  assertOpenVersion,
  structuralDiff,
  assertProjectExists,
  cleanRequired,
} from './test-design/state.js'
import {
  boundRequirementRelease,
  explicitlyInheritedSourceVersion,
  latestPublishedLibraryVersion,
  inheritedLibraryVersionsForSource,
  presentRequirementRelease,
  validateDesignSources,
  buildBasisSnapshot,
  buildRetrievalSnapshot,
  buildHistoricalSnapshot,
  buildWorkspaceSnapshot,
} from './test-design/snapshots.js'
import {
  workflowNodes,
  initialAutomaticRepairState,
  presentRun,
  node,
  caseDesignInput,
  finalizeCaseDesignAndAudit,
  publishArtifact,
  finishNode,
  repairInput,
  shouldCheckpointTestDesignExecution,
  failNode,
  advanceNodeGeneration,
  runCoverageAudit,
  testDesignExecutionProgress,
} from './test-design/workflow.js'
import {
  buildEffectiveCaseSet,
  requiresHumanProposalDecision,
  caseChangeProposalSha256,
  invalidateAudit,
  currentCaseRevision,
  presentCase,
  newCase,
  ensureCandidateProposal,
  validateCurrentDependencyGraph,
  findCase,
  createCaseRevision,
  convertDeletedCandidateProposal,
  applyReviewAction,
  reconcileAutomaticProposalDecisions,
  validateProposalDecision,
} from './test-design/case-review.js'
import {
  currentLibraryRevision,
  presentLibraryCase,
  createLibraryRevision,
  findLibraryCase,
  libraryCaseEtag,
  traceabilityRelevantContentChanged,
  validateLibraryTraceability,
  assertTraceabilityMatchesContent,
  assertLibraryPublicationGates,
  assertLibraryBaselineMembersCurrent,
  assertProposalSourcesCurrent,
  applyProposalToLibrary,
  freezeLibraryVersionMember,
  effectiveTraceabilityForPublishedMember,
  presentLibraryVersion,
  publishedTestCaseStatistics,
  presentPublishedTestCase,
  executionMethodsForContent,
  testExecutionMethod,
  executionSpecForMethod,
  executionConfigurationForMethod,
  libraryProjectionFiles,
} from './test-design/library.js'
import {
  versionMemberDiff,
  suiteDraftEtag,
  suiteDraftInput,
  validateSuiteMembers,
  suiteMemberExecutionMethods,
} from './test-design/suites.js'

export interface PlanningAgentRuntime {
  readiness?(): Promise<{ ready: boolean; agents: Array<{ agentKey: string; ready: boolean; reason?: string }> }>
  freezeConfiguration?(): Promise<TestDesignRunAgentConfigurationSnapshot>
  appendTask?(input: {
    projectVersionId: string
    taskType: string
    task: string
    metadata?: Record<string, unknown>
  }): Promise<unknown>
  execute(
    input: {
      stage: 'test_case_design' | 'test_design_repair'
      run: TestDesignWorkflowRun
      upstream: unknown
      onExecutionEvent?: (event: AgentExecutionEvent) => void | Promise<void>
    },
    signal: AbortSignal,
  ): Promise<{ schemaVersion: string; content: unknown; execution?: WorkflowNodeRun['execution'] }>
}

type WorkspaceArtifactIngestInput = {
  knowledgeBaseId: string
  sourceType: 'upload'
  sourceKey: string
  assetType: string
  displayName: string
  logicalPath: string
  content: string
  taskTrigger?: 'upload' | 'retry'
}

export interface TestCaseAssetProjector {
  ingest(input: WorkspaceArtifactIngestInput): Promise<{ version: { id: string }; task: unknown }>
  ingestWorkspaceArtifact?(input: WorkspaceArtifactIngestInput): Promise<{ version: { id: string }; task: unknown }>
}

export class TestDesignService {
  private readonly activeRuns = new Map<string, AbortController>()
  constructor(
    private readonly store: StateStore,
    private readonly runtime?: PlanningAgentRuntime,
    private readonly projector?: TestCaseAssetProjector,
  ) {}

  async inputCandidates(projectVersionId: string) {
    const state = await this.readState({ projectVersionId, includeInputs: true, collections: ['libraryVersions'] })
    const projectVersion = required(
      state.projectVersions.find(item => item.id === projectVersionId),
      'PROJECT_VERSION_NOT_FOUND',
      '项目版本不存在',
    )
    const projectBases = state.knowledgeBases.filter(item => item.projectId === projectVersion.projectId)
    const requirementRelease = boundRequirementRelease(state, projectVersionId)
    const requirementReleases = requirementReleaseBindings(projectVersion).flatMap(binding => {
      try {
        const resolved = boundRequirementRelease(state, projectVersionId, binding.releaseId)
        return resolved ? [resolved] : []
      } catch (error) {
        if (error instanceof TestDesignError && error.code === 'TEST_DESIGN_REQUIREMENT_RELEASE_BINDING_INVALID')
          return []
        throw error
      }
    })
    const knowledgeAssets = projectBases.flatMap(base =>
      state.assets
        .filter(asset => asset.knowledgeBaseId === base.id)
        .flatMap(asset =>
          state.versions
            .filter(version => version.assetId === asset.id)
            .map(version => ({
              assetId: asset.id,
              assetVersionId: version.id,
              version: version.number,
              contentHash: version.contentHash,
              displayName: asset.displayName,
              logicalPath: asset.logicalPath,
              assetType: asset.assetType,
              status: version.status,
              selectable: version.status === 'ready',
              reason: version.status === 'ready' ? undefined : '资产版本未就绪',
            })),
        ),
    )
    const designState = readDesignState(state)
    const inheritedSource = explicitlyInheritedSourceVersion(state, projectVersion)
    const inheritedLibraryVersion = inheritedSource
      ? latestPublishedLibraryVersion(inheritedLibraryVersionsForSource(designState, inheritedSource.id))
      : undefined
    const agentReadiness = this.runtime?.readiness
      ? await this.runtime.readiness()
      : {
          ready: Boolean(this.runtime),
          agents: [
            {
              agentKey: 'planning',
              ready: Boolean(this.runtime),
              reason: this.runtime ? undefined : 'PlanningAgent Runtime 未配置',
            },
          ],
        }
    return {
      projectVersion: {
        id: projectVersion.id,
        projectId: projectVersion.projectId,
        name: projectVersion.name,
        status: projectVersion.status,
        ...(projectVersion.sourceProjectVersionId
          ? { sourceProjectVersionId: projectVersion.sourceProjectVersionId }
          : {}),
        ...(projectVersion.sourceProjectVersionId
          ? {
              sourceProjectVersionName: state.projectVersions.find(
                item => item.id === projectVersion.sourceProjectVersionId,
              )?.name,
            }
          : {}),
        inheritRequirementBindings: Boolean(inheritedSource),
      },
      requirementRelease: requirementRelease ? presentRequirementRelease(requirementRelease, true) : null,
      requirementReleases: requirementReleases.map(item =>
        presentRequirementRelease(item, item.binding.releaseId === requirementRelease?.binding.releaseId),
      ),
      knowledgeAssets,
      fixedIndexes: projectBases.flatMap(base =>
        state.indexes
          .filter(index => index.knowledgeBaseId === base.id && index.status === 'active')
          .map(index => ({ id: index.id, selectable: true })),
      ),
      historicalBaseline: !inheritedSource
        ? { status: 'not_inherited' as const }
        : inheritedLibraryVersion
          ? {
              status: 'source_library_available' as const,
              sourceProjectVersionId: inheritedSource.id,
              sourceProjectVersionName: inheritedSource.name,
              testCaseLibraryVersion: {
                id: inheritedLibraryVersion.id,
                name: inheritedLibraryVersion.name,
                version: inheritedLibraryVersion.version,
                memberCount: inheritedLibraryVersion.members.length,
                contentSha256: inheritedLibraryVersion.contentSha256,
                publishedAt: inheritedLibraryVersion.publishedAt,
              },
            }
          : {
              status: 'source_library_missing' as const,
              sourceProjectVersionId: inheritedSource.id,
              sourceProjectVersionName: inheritedSource.name,
              testCaseLibraryVersion: null,
            },
      agentReadiness,
    }
  }

  async createDesign(projectVersionId: string, rawInput: unknown, principal: Principal) {
    const input = validateCreateTestDesignInput(rawInput)
    return this.store.transaction(state => {
      const projectVersion = required(
        state.projectVersions.find(item => item.id === projectVersionId),
        'PROJECT_VERSION_NOT_FOUND',
        '项目版本不存在',
      )
      if (projectVersion.status !== 'open')
        throw new TestDesignError('PROJECT_VERSION_READ_ONLY', '当前项目版本只读', 409)
      const requirement = required(
        boundRequirementRelease(state, projectVersionId, input.requirementReleaseId),
        'TEST_DESIGN_REQUIREMENT_RELEASE_NOT_BOUND',
        '当前 ProjectVersion 尚未完成需求分析并绑定 Requirement Release',
      )
      validateDesignSources(state, projectVersion, input)
      const design: TestDesign = {
        id: `test_design_${randomUUID()}`,
        projectVersionId,
        projectId: projectVersion.projectId,
        name: input.name,
        objective: input.objective,
        input,
        logicalInputSha256: canonicalSha256(input),
        createdBy: principal.subjectId,
        createdAt: now(),
        creationMode: 'manual',
        sourceRequirementReleaseId: requirement.release.id,
      }
      designState(state).designs.push(design)
      return structuredClone(design)
    })
  }

  async createAutomaticDesignAndRun(projectVersionId: string, analysisRunId: string) {
    const created = await this.store.transaction(state => {
      const projectVersion = required(
        state.projectVersions.find(item => item.id === projectVersionId),
        'PROJECT_VERSION_NOT_FOUND',
        '项目版本不存在',
      )
      if (projectVersion.status !== 'open')
        throw new TestDesignError('PROJECT_VERSION_READ_ONLY', '当前项目版本只读', 409)
      const analysisRun = required(
        state.reviewRuns.find(item => item.id === analysisRunId && item.projectVersionId === projectVersionId),
        'REQUIREMENT_RUN_NOT_FOUND',
        '需求理解运行不存在',
      )
      const release = required(
        analysisRun.workflow?.release,
        'TEST_DESIGN_REQUIREMENT_RELEASE_NOT_BOUND',
        '需求理解尚未冻结正式基线',
      )
      if (
        analysisRun.status !== 'succeeded' ||
        release.status !== 'published' ||
        !boundRequirementRelease(state, projectVersionId, release.id)
      )
        throw new TestDesignError('TEST_DESIGN_REQUIREMENT_RELEASE_NOT_BOUND', '需求理解基线尚未正式绑定', 409)
      const aggregate = designState(state)
      const existing = aggregate.designs.find(
        item =>
          item.projectVersionId === projectVersionId &&
          item.creationMode === 'automatic' &&
          item.sourceRequirementReleaseId === release.id,
      )
      if (existing) return { design: structuredClone(existing), created: false }
      const result = required(analysisRun.result, 'REQUIREMENT_RESULT_NOT_FOUND', '需求理解结果不存在')
      const activeIndex = state.indexes.find(
        item => item.id === analysisRun.snapshot.indexVersionId && item.status === 'active',
      )
      const rawInput: CreateTestDesignInput = {
        name: `${projectVersion.name} · 自动测试设计`,
        objective: result.summary.overview.trim() || '依据已冻结的需求理解生成可追溯测试用例。',
        includedScopes: [],
        excludedScopes: [],
        focusDimensions: ['functional', 'performance', 'stability', 'compatibility', 'security'],
        executionMethods: ['ui', 'api'],
        knowledgeAugmentation: activeIndex
          ? { mode: 'fixed_index', indexVersionId: activeIndex.id }
          : { mode: 'disabled' },
      }
      const input = validateCreateTestDesignInput(rawInput)
      validateDesignSources(state, projectVersion, input)
      const design: TestDesign = {
        id: `test_design_${randomUUID()}`,
        projectVersionId,
        projectId: projectVersion.projectId,
        name: input.name,
        objective: input.objective,
        input,
        logicalInputSha256: canonicalSha256(input),
        createdBy: 'system:planning-workflow',
        createdAt: now(),
        creationMode: 'automatic',
        sourceRequirementReleaseId: release.id,
      }
      aggregate.designs.push(design)
      return { design: structuredClone(design), created: true }
    })
    const run = await this.createRun(
      projectVersionId,
      created.design.id,
      `test-design-run:${created.design.id}:automatic:${analysisRunId}`,
      { subjectId: 'system:planning-workflow', displayName: 'Planning Workflow' },
    )
    return { design: created.design, run }
  }

  async listDesigns(projectVersionId: string) {
    const state = await this.readState({ projectVersionId, latestRunsOnly: true, collections: ['designs', 'runs'] })
    const aggregate = readDesignState(state)
    return aggregate.designs
      .filter(item => item.projectVersionId === projectVersionId)
      .sort(newest)
      .map(design => ({
        ...design,
        latestRun: aggregate.runs.filter(run => run.testDesignId === design.id).sort(newest)[0] ?? null,
      }))
  }

  async getDesign(projectVersionId: string, designId: string) {
    const state = await this.readState({ projectVersionId, designId, collections: ['designs'] })
    return structuredClone(findDesign(state, projectVersionId, designId))
  }

  async createRun(projectVersionId: string, designId: string, idempotencyKey: string, principal: Principal) {
    if (!idempotencyKey?.trim())
      throw new TestDesignError('IDEMPOTENCY_KEY_REQUIRED', '创建运行必须提供 Idempotency-Key', 400)
    findDesign(
      await this.readState({ projectVersionId, designId, collections: ['designs'] }),
      projectVersionId,
      designId,
    )
    const readiness = this.runtime?.readiness ? await this.runtime.readiness() : { ready: Boolean(this.runtime) }
    if (!readiness.ready)
      throw new TestDesignError('TEST_DESIGN_AGENT_NOT_READY', 'PlanningAgent 尚未发布或未通过模型门禁', 409, readiness)
    const agentConfigurationSnapshot = this.runtime?.freezeConfiguration
      ? await this.runtime.freezeConfiguration()
      : undefined
    if (!agentConfigurationSnapshot)
      throw new TestDesignError('TEST_DESIGN_AGENT_NOT_READY', 'PlanningAgent Runtime 无法冻结配置版本', 409)
    const created = await this.store.transaction(async state => {
      const design = findDesign(state, projectVersionId, designId)
      const projectVersion = required(
        state.projectVersions.find(item => item.id === projectVersionId),
        'PROJECT_VERSION_NOT_FOUND',
        '项目版本不存在',
      )
      if (projectVersion.status !== 'open')
        throw new TestDesignError('PROJECT_VERSION_READ_ONLY', '当前项目版本只读', 409)
      const aggregate = designState(state)
      const existing = aggregate.runs.find(
        run => run.testDesignId === designId && run.idempotencyKey === idempotencyKey,
      )
      if (existing) return { run: structuredClone(existing), created: false }
      if (!this.runtime)
        throw new TestDesignError('TEST_DESIGN_AGENT_NOT_READY', 'PlanningAgent 尚未完成运行时配置', 409)
      const requirement = required(
        boundRequirementRelease(state, projectVersionId, design.sourceRequirementReleaseId),
        'TEST_DESIGN_REQUIREMENT_RELEASE_NOT_BOUND',
        '测试设计未绑定有效的 Requirement Release',
      )
      const runId = `test_design_run_${randomUUID()}`
      const createdAt = now()
      const basisSnapshot = buildBasisSnapshot(design, requirement, createdAt)
      const retrievalSnapshot = await buildRetrievalSnapshot(state, design, basisSnapshot.content, createdAt)
      const historicalSnapshot = buildHistoricalSnapshot(state, design, basisSnapshot, createdAt)
      const workspaceSnapshot = buildWorkspaceSnapshot(state, design, requirement, historicalSnapshot, createdAt)
      const run: TestDesignWorkflowRun = {
        id: runId,
        testDesignId: design.id,
        projectVersionId,
        status: 'queued',
        stage: 'test_case_design',
        progress: 0,
        idempotencyKey,
        requestedExecutionMethods: [...(design.input.executionMethods ?? [])],
        basisSnapshot,
        agentConfigurationSnapshot,
        currentInputRefs: structuredClone(requirement.analysisRun.snapshot.currentInputRefs),
        retrievalSnapshot,
        historicalSnapshot,
        workspaceSnapshot,
        formalWorkspaceFiles: [],
        ...(historicalSnapshot.sourceTestCaseLibraryVersionId
          ? {
              baseTestCaseLibraryVersionId: historicalSnapshot.sourceTestCaseLibraryVersionId,
              baseTestCaseLibraryVersionSha256: historicalSnapshot.sourceTestCaseLibraryVersionSha256,
            }
          : {}),
        nodeRuns: workflowNodes(runId),
        artifacts: [],
        gateDecisions: [],
        testCases: [],
        caseChangeProposals: [],
        coverageAudits: [],
        automaticRepair: initialAutomaticRepairState(),
        events: [],
        createdBy: principal.subjectId,
        createdAt,
      }
      aggregate.runs.push(run)
      return { run: structuredClone(run), created: true }
    })
    if (created.run.status === 'queued') await this.schedule(created.run.id)
    return created.run
  }

  async listRuns(projectVersionId: string, designId: string) {
    const state = await this.readState({
      projectVersionId,
      designId,
      collections: ['designs', 'runs', 'libraryVersions'],
    })
    findDesign(state, projectVersionId, designId)
    const aggregate = readDesignState(state)
    const publishedRunIds = new Set(
      aggregate.libraryVersions.flatMap(item => (item.sourceRunId ? [item.sourceRunId] : [])),
    )
    return aggregate.runs
      .filter(item => item.projectVersionId === projectVersionId && item.testDesignId === designId)
      .sort(newest)
      .map(run => {
        const baseline = run.baseTestCaseLibraryVersionId
          ? aggregate.libraryVersions.find(item => item.id === run.baseTestCaseLibraryVersionId)
          : undefined
        return {
          ...presentRun(run),
          ...(run.baseTestCaseLibraryVersionId
            ? { baseTestCaseLibraryVersionId: run.baseTestCaseLibraryVersionId }
            : {}),
          ...(baseline
            ? { baseTestCaseLibraryVersion: { id: baseline.id, version: baseline.version, name: baseline.name } }
            : {}),
          caseCount: run.testCases.filter(item => !item.tombstonedAt).length,
          candidateCaseCount: run.testCases.filter(item => !item.tombstonedAt).length,
          effectiveCaseCount: buildEffectiveCaseSet(run).length,
          pendingManualProposalCount: run.caseChangeProposals.filter(
            item => item.decision === 'pending' && requiresHumanProposalDecision(item),
          ).length,
          published: publishedRunIds.has(run.id),
        }
      })
  }

  async getRun(projectVersionId: string, designId: string, runId: string) {
    const state = await this.readState({ projectVersionId, designId, runId, collections: ['designs', 'runs'] })
    const run = findRun(state, projectVersionId, designId, runId)
    return {
      ...presentRun(run, true),
      candidateCaseCount: run.testCases.filter(item => !item.tombstonedAt).length,
      effectiveCaseCount: buildEffectiveCaseSet(run).length,
      caseChangeProposalSha256: caseChangeProposalSha256(run.caseChangeProposals ?? []),
    }
  }

  async processPreparedRun(runId: string, signal = new AbortController().signal): Promise<TestDesignWorkflowRun> {
    if (!this.runtime) throw new TestDesignError('TEST_DESIGN_AGENT_NOT_READY', '测试设计 Agent Runtime 未配置', 409)
    const run = await this.loadRun(runId)
    if (run.status === 'cancelled' || run.status === 'succeeded') return run
    try {
      const refreshed = await this.loadRun(runId)
      if (node(refreshed, 'test_case_design').status !== 'succeeded') {
        const output = await this.executeNode(runId, 'test_case_design', signal, caseDesignInput(refreshed))
        let repairQueued = false
        await this.store.transaction(state => {
          const current = findRunById(state, runId)
          const finalized = finalizeCaseDesignAndAudit(current, output.content, current.createdBy, false)
          publishArtifact(current, 'test_case_design', finalized.artifact)
          finishNode(current, 'test_case_design', output.execution)
          repairQueued = finalized.repairQueued
        })
        if (repairQueued) return this.processPreparedRun(runId, signal)
      }
      const afterCases = await this.loadRun(runId)
      if (afterCases.automaticRepair?.status === 'queued') {
        const output = await this.executeNode(runId, 'test_design_repair', signal, repairInput(afterCases))
        let repairQueued = false
        await this.store.transaction(state => {
          const current = findRunById(state, runId)
          const finalized = finalizeCaseDesignAndAudit(current, output.content, current.createdBy, true)
          publishArtifact(current, 'test_design_repair', finalized.artifact)
          finishNode(current, 'test_design_repair', output.execution)
          repairQueued = finalized.repairQueued
        })
        if (repairQueued) return this.processPreparedRun(runId, signal)
      }
      return this.loadRun(runId)
    } catch (error) {
      await this.store
        .transaction(state => {
          const current = readDesignState(state).runs.find(item => item.id === runId)
          if (!current || current.status === 'cancelled') return
          const message = error instanceof Error ? error.message : String(error)
          const active = current.nodeRuns.find(item => item.status === 'running')
          const execution =
            error && typeof error === 'object' && 'execution' in error
              ? (error as { execution?: WorkflowNodeRun['execution'] }).execution
              : undefined
          if (active)
            Object.assign(active, {
              status: 'failed',
              finishedAt: now(),
              error: message,
              errorCode: errorCode(message),
              ...(execution ? { execution } : {}),
            })
          Object.assign(current, {
            status: 'failed',
            stage: 'failed',
            finishedAt: now(),
            error: message,
            errorCode: errorCode(message),
          })
        })
        .catch(() => undefined)
      throw error
    }
  }

  async processPreparedNode(runId: string, nodeRunId: string, lease: TaskLease, signal = new AbortController().signal) {
    if (!this.runtime) throw new TestDesignError('TEST_DESIGN_AGENT_NOT_READY', '测试设计 Agent Runtime 未配置', 409)
    const initial = await this.loadRun(runId)
    const claimed = required(
      initial.nodeRuns.find(item => item.id === nodeRunId),
      'WORKFLOW_NODE_NOT_FOUND',
      '领取的工作流节点不存在',
    )
    if (!['test_case_design', 'test_design_repair'].includes(claimed.nodeKey))
      throw new TestDesignError('WORKFLOW_NODE_NOT_RETRYABLE', '领取的节点不是 PlanningAgent Stage', 409)
    if (initial.status === 'cancelled' || claimed.status === 'succeeded' || claimed.status === 'cancelled')
      return initial

    const key = claimed.nodeKey as 'test_case_design' | 'test_design_repair'
    try {
      await this.fencedNodeTransaction(nodeRunId, lease, state => {
        const run = findRunById(state, runId)
        const target = required(
          run.nodeRuns.find(item => item.id === nodeRunId && item.nodeKey === key),
          'WORKFLOW_NODE_NOT_FOUND',
          '节点已被新 generation 替换',
        )
        // A reclaimed PostgreSQL Job can retain the previous worker's running
        // node state. The lease transaction below fences that worker out, so
        // the current Job owner may safely take over the interrupted attempt.
        if (!['queued', 'failed', 'running'].includes(target.status))
          throw new TestDesignError('WORKFLOW_NODE_NOT_RETRYABLE', `节点当前状态 ${target.status} 不可执行`, 409)
        Object.assign(target, {
          status: 'running',
          attempt: target.attempt + 1,
          startedAt: now(),
          finishedAt: undefined,
          error: undefined,
          errorCode: undefined,
          execution: undefined,
        })
        Object.assign(run, {
          status: 'running',
          stage: key,
          startedAt: run.startedAt ?? now(),
          finishedAt: undefined,
          error: undefined,
          errorCode: undefined,
        })
        if (key === 'test_design_repair' && run.automaticRepair?.status === 'queued')
          Object.assign(run.automaticRepair, { status: 'running', startedAt: now(), finishedAt: undefined })
      })
      const running = await this.loadRun(runId)
      const upstream = key === 'test_case_design' ? caseDesignInput(running) : repairInput(running)
      const events: AgentExecutionEvent[] = []
      const output = await this.runtime.execute(
        {
          stage: key,
          run: running,
          upstream,
          onExecutionEvent: async event => {
            events.push(event)
            if (shouldCheckpointTestDesignExecution(event))
              await this.saveNodeExecutionProgress(runId, nodeRunId, key, events, lease)
          },
        },
        signal,
      )
      const result = await this.fencedNodeTransaction(nodeRunId, lease, state => {
        const run = findRunById(state, runId)
        const target = required(
          run.nodeRuns.find(item => item.id === nodeRunId && item.nodeKey === key),
          'WORKFLOW_NODE_NOT_FOUND',
          '节点已被新 generation 替换',
        )
        if (target.status !== 'running')
          throw new TestDesignError('WORKFLOW_JOB_LEASE_LOST', '节点已不处于当前执行状态', 409)
        const finalized = finalizeCaseDesignAndAudit(run, output.content, run.createdBy, key === 'test_design_repair')
        publishArtifact(run, key, finalized.artifact)
        finishNode(run, key, output.execution)
        return { repairQueued: finalized.repairQueued }
      })
      if (result.repairQueued) await this.schedule(runId)
      return this.loadRun(runId)
    } catch (error) {
      if (!String(error instanceof Error ? error.message : error).includes('WORKFLOW_JOB_LEASE_LOST')) {
        await this.fencedNodeTransaction(nodeRunId, lease, state => {
          const run = readDesignState(state).runs.find(item => item.id === runId)
          const target = run?.nodeRuns.find(item => item.id === nodeRunId)
          if (!run || !target || run.status === 'cancelled') return
          const active = run.nodeRuns.find(item => item.status === 'running')
          failNode(run, active?.nodeKey ?? target.nodeKey, error)
          const message = error instanceof Error ? error.message : String(error)
          Object.assign(run, {
            status: 'failed',
            stage: 'failed',
            finishedAt: now(),
            error: message,
            errorCode: errorCode(message),
          })
        }).catch(() => undefined)
      }
      throw error
    }
  }

  async cancelRun(projectVersionId: string, designId: string, runId: string, principal: Principal) {
    const controller = this.activeRuns.get(runId)
    controller?.abort(new Error(`WORKFLOW_CANCELLED: ${principal.subjectId}`))
    await this.store.cancelTestDesignJob?.(runId)
    return this.store.transaction(state => {
      const run = findRun(state, projectVersionId, designId, runId)
      if (run.status === 'succeeded')
        throw new TestDesignError('WORKFLOW_NODE_NOT_RETRYABLE', '已完成运行不能取消', 409)
      Object.assign(run, {
        status: 'cancelled',
        stage: 'cancelled',
        finishedAt: now(),
        errorCode: 'WORKFLOW_CANCELLED',
        error: '运行已由用户取消',
      })
      run.nodeRuns
        .filter(item => ['pending', 'queued', 'running', 'waiting_gate'].includes(item.status))
        .forEach(item => {
          item.status = 'cancelled'
          item.finishedAt = now()
        })
      return presentRun(run, true)
    })
  }

  async fullRerun(
    projectVersionId: string,
    designId: string,
    runId: string,
    idempotencyKey: string,
    principal: Principal,
  ) {
    await this.getRun(projectVersionId, designId, runId)
    return this.createRun(projectVersionId, designId, idempotencyKey, principal)
  }

  async resynthesize(projectVersionId: string, designId: string, runId: string) {
    const state = await this.readState({ projectVersionId, designId, runId, collections: ['designs', 'runs'] })
    assertOpenVersion(state, projectVersionId)
    findRun(state, projectVersionId, designId, runId)
    await this.runtime?.appendTask?.({
      projectVersionId,
      taskType: 'test_case_resynthesize',
      task: [
        '请重新生成测试用例。',
        '',
        '请继续在当前 Planning Session 中，基于当前 Requirement Release、正式 Clarification 和冻结 Workspace 重新生成本轮新增或确实需要调整的 TestCase Candidate Delta。未变化历史用例无需重新输出。',
      ].join('\n'),
      metadata: {
        testDesignRunId: runId,
      },
    })
    await this.store.transaction(draft => {
      assertOpenVersion(draft, projectVersionId)
      const run = findRun(draft, projectVersionId, designId, runId)
      advanceNodeGeneration(run, node(run, 'test_case_design'), 'queued')
      advanceNodeGeneration(run, node(run, 'coverage_audit'), 'pending')
      advanceNodeGeneration(run, node(run, 'test_design_repair'), 'pending')
      run.testCases = []
      run.caseChangeProposals = []
      run.automaticRepair = initialAutomaticRepairState()
      invalidateAudit(run)
      Object.assign(run, {
        status: 'queued',
        stage: 'test_case_design',
        progress: 55,
        error: undefined,
        errorCode: undefined,
        finishedAt: undefined,
      })
    })
    await this.schedule(runId)
    return this.getRun(projectVersionId, designId, runId)
  }

  async listCases(
    projectVersionId: string,
    designId: string,
    runId: string,
    filters: { dimension?: string; executionMethod?: string; status?: string } = {},
  ) {
    const run = await this.loadScopedRun(projectVersionId, designId, runId)
    return run.testCases
      .filter(item => !item.tombstonedAt)
      .filter(item => {
        const content = currentCaseRevision(item).content
        return (
          (!filters.dimension || content.dimension === filters.dimension) &&
          (!filters.executionMethod || content.executionMethods.includes(filters.executionMethod as 'ui' | 'api')) &&
          (!filters.status || item.reviewState === filters.status)
        )
      })
      .map(testCase => presentCase(testCase))
  }

  async createCase(
    projectVersionId: string,
    designId: string,
    runId: string,
    rawContent: unknown,
    principal: Principal,
  ) {
    return this.store.transaction(state => {
      assertOpenVersion(state, projectVersionId)
      const run = findRun(state, projectVersionId, designId, runId)
      const content = validateTestCaseContent(rawContent)
      const testCase = newCase(run.id, content, 'manual', principal.subjectId, '人工新建')
      run.testCases.push(testCase)
      ensureCandidateProposal(run, testCase, '人工新增测试用例')
      invalidateAudit(run)
      validateCurrentDependencyGraph(run)
      return presentCase(testCase)
    })
  }

  async getCase(projectVersionId: string, designId: string, runId: string, caseId: string) {
    const run = await this.loadScopedRun(projectVersionId, designId, runId)
    return presentCase(findCase(run, caseId), true)
  }
  async caseRevisions(projectVersionId: string, designId: string, runId: string, caseId: string) {
    const run = await this.loadScopedRun(projectVersionId, designId, runId)
    return structuredClone(findCase(run, caseId).revisions)
  }
  async caseDiff(projectVersionId: string, designId: string, runId: string, caseId: string, from: number, to: number) {
    const run = await this.loadScopedRun(projectVersionId, designId, runId)
    const testCase = findCase(run, caseId)
    const left = required(
      testCase.revisions.find(item => item.revision === from),
      'TEST_CASE_REVISION_NOT_FOUND',
      '起始用例 revision 不存在',
    )
    const right = required(
      testCase.revisions.find(item => item.revision === to),
      'TEST_CASE_REVISION_NOT_FOUND',
      '目标用例 revision 不存在',
    )
    return structuralDiff(left.content, right.content)
  }

  async patchCase(
    projectVersionId: string,
    designId: string,
    runId: string,
    caseId: string,
    ifMatch: string | undefined,
    input: { content: unknown; reason: string },
    principal: Principal,
  ) {
    return this.store.transaction(state => {
      assertOpenVersion(state, projectVersionId)
      const run = findRun(state, projectVersionId, designId, runId)
      const testCase = findCase(run, caseId)
      const editableReviewStates: ReadonlyArray<TestCase['reviewState']> = ['draft', 'needs_revision', 'rejected']
      if (!editableReviewStates.includes(testCase.reviewState))
        throw new TestDesignError(
          'TEST_CASE_EDIT_REVIEW_STATE_INVALID',
          '审核中的 Revision 不能直接修改；请先撤回审核、退回修改或发起变更。',
          409,
          { caseId: testCase.id, reviewState: testCase.reviewState },
        )
      const current = currentCaseRevision(testCase)
      assertEtag(
        ifMatch,
        etag('case', testCase.id, current.revision, current.contentSha256),
        'TEST_CASE_REVISION_CONFLICT',
      )
      const content = validateTestCaseContent(input.content)
      const revision = createCaseRevision(
        current.revision + 1,
        content,
        principal.subjectId,
        input.reason,
        current.content,
      )
      testCase.revisions.push(revision)
      testCase.currentRevision = revision.revision
      testCase.reviewState = 'draft'
      if (testCase.origin === 'historical_unchanged') testCase.origin = 'historical_modified'
      ensureCandidateProposal(run, testCase, input.reason)
      invalidateAudit(run)
      validateCurrentDependencyGraph(run)
      return presentCase(testCase, true)
    })
  }

  async deleteCase(projectVersionId: string, designId: string, runId: string, caseId: string, principal: Principal) {
    return this.store.transaction(state => {
      assertOpenVersion(state, projectVersionId)
      const run = findRun(state, projectVersionId, designId, runId)
      const testCase = findCase(run, caseId)
      testCase.tombstonedAt ??= now()
      testCase.reviewState = 'draft'
      convertDeletedCandidateProposal(run, testCase)
      invalidateAudit(run)
      validateCurrentDependencyGraph(run)
      return { caseId, deletedBy: principal.subjectId, tombstonedAt: testCase.tombstonedAt }
    })
  }

  async reviewCase(
    projectVersionId: string,
    designId: string,
    runId: string,
    caseId: string,
    input: {
      decision: 'submit' | 'approve' | 'reject' | 'request_revision' | 'withdraw'
      targetRevision: number
      comment?: string
    },
    principal: Principal,
  ) {
    return this.store.transaction(state => {
      assertOpenVersion(state, projectVersionId)
      const run = findRun(state, projectVersionId, designId, runId)
      const testCase = findCase(run, caseId)
      applyReviewAction(testCase, input, principal.subjectId)
      reconcileAutomaticProposalDecisions(run)
      return presentCase(testCase, true)
    })
  }

  async batchReview(
    projectVersionId: string,
    designId: string,
    runId: string,
    input: {
      targets: Array<{ caseId: string; targetRevision: number }>
      decision: 'submit' | 'approve' | 'reject' | 'request_revision' | 'withdraw'
      comment?: string
    },
    principal: Principal,
  ) {
    return this.store.transaction(state => {
      assertOpenVersion(state, projectVersionId)
      const run = findRun(state, projectVersionId, designId, runId)
      const targets = input.targets.map(target => ({ target, testCase: findCase(run, target.caseId) }))
      targets.forEach(({ target, testCase }) => {
        if (testCase.currentRevision !== target.targetRevision)
          throw new TestDesignError('TEST_CASE_REVISION_CONFLICT', `用例 ${testCase.id} revision 已变化`, 412)
      })
      targets.forEach(({ target, testCase }) =>
        applyReviewAction(testCase, { ...input, targetRevision: target.targetRevision }, principal.subjectId),
      )
      reconcileAutomaticProposalDecisions(run)
      return targets.map(item => presentCase(item.testCase))
    })
  }

  async reAudit(projectVersionId: string, designId: string, runId: string) {
    return this.store.transaction(state => {
      assertOpenVersion(state, projectVersionId)
      const run = findRun(state, projectVersionId, designId, runId)
      const audit = runCoverageAudit(run)
      run.coverageAudits.forEach(item => {
        item.status = 'stale'
      })
      run.coverageAudits.push(audit)
      return structuredClone(audit)
    })
  }
  async coverageAudits(projectVersionId: string, designId: string, runId: string) {
    return structuredClone((await this.loadScopedRun(projectVersionId, designId, runId)).coverageAudits)
  }
  async coverageMatrix(
    projectVersionId: string,
    designId: string,
    runId: string,
    direction: 'basis_to_case' | 'case_to_basis',
  ) {
    const run = await this.loadScopedRun(projectVersionId, designId, runId)
    const audit = [...run.coverageAudits].reverse().find(item => item.status === 'valid')
    if (!audit) throw new TestDesignError('COVERAGE_AUDIT_STALE', '没有有效覆盖审计', 409)
    return direction === 'basis_to_case'
      ? audit.relations
      : [...audit.relations].sort((left, right) => String(left.caseId).localeCompare(String(right.caseId)))
  }

  async basisSource(projectVersionId: string, designId: string, runId: string, basisItemId: string) {
    const run = await this.loadScopedRun(projectVersionId, designId, runId)
    const content = run.basisSnapshot.content
    const value =
      content.requirements.find(item => item.clientRequirementPointId === basisItemId) ??
      content.evidence.find(item => item.clientEvidenceId === basisItemId) ??
      content.clarifications.find(item => item.id === basisItemId)
    return structuredClone(required(value, 'TEST_DESIGN_BASIS_ITEM_NOT_FOUND', '固定依据不存在'))
  }
  async retrievalSource(projectVersionId: string, designId: string, runId: string, hitId: string) {
    const run = await this.loadScopedRun(projectVersionId, designId, runId)
    return structuredClone(
      required(
        run.retrievalSnapshot.hits.find(item => item.id === hitId),
        'TEST_DESIGN_RETRIEVAL_HIT_NOT_FOUND',
        '固定召回结果不存在',
      ),
    )
  }
  async historicalSource(projectVersionId: string, designId: string, runId: string, itemId: string) {
    const run = await this.loadScopedRun(projectVersionId, designId, runId)
    return structuredClone(
      required(
        run.historicalSnapshot.items.find(item => item.id === itemId),
        'TEST_DESIGN_HISTORICAL_SOURCE_INVALID',
        '历史用例快照不存在',
      ),
    )
  }

  async listCaseChangeProposals(projectVersionId: string, designId: string, runId: string, operation?: string) {
    const run = await this.loadScopedRun(projectVersionId, designId, runId)
    return structuredClone((run.caseChangeProposals ?? []).filter(item => !operation || item.operation === operation))
  }

  async decideCaseChangeProposal(
    projectVersionId: string,
    designId: string,
    runId: string,
    proposalId: string,
    input: { expectedVersion: number; decision: Exclude<CaseChangeDecision, 'pending'>; comment?: string },
    principal: Principal,
  ) {
    return this.store.transaction(state => {
      assertOpenVersion(state, projectVersionId)
      const run = findRun(state, projectVersionId, designId, runId)
      const proposal = required(
        run.caseChangeProposals.find(item => item.id === proposalId),
        'CASE_CHANGE_PROPOSAL_NOT_FOUND',
        '用例库变更 Proposal 不存在',
      )
      if (!requiresHumanProposalDecision(proposal))
        throw new TestDesignError(
          'CASE_CHANGE_PROPOSAL_AUTOMATIC',
          `${proposal.operation} Proposal 由 Service 随用例审核状态自动处理`,
          409,
        )
      if (proposal.decisions.length !== input.expectedVersion)
        throw new TestDesignError('CASE_CHANGE_PROPOSAL_VERSION_CONFLICT', 'Proposal 决策版本已变化', 409)
      validateProposalDecision(proposal, input.decision)
      const decidedAt = now()
      proposal.decision = input.decision
      proposal.decidedBy = principal.subjectId
      proposal.decidedAt = decidedAt
      proposal.decisions.push({
        id: `case_change_decision_${randomUUID()}`,
        expectedVersion: input.expectedVersion,
        decision: input.decision,
        ...(input.comment?.trim() ? { comment: input.comment.trim().slice(0, 4_000) } : {}),
        decidedBy: principal.subjectId,
        decidedAt,
      })
      return structuredClone(proposal)
    })
  }

  async listLibraryCases(
    projectId: string,
    filters: {
      domain?: string
      dimension?: string
      executionMethod?: string
      priority?: string
      status?: string
      tag?: string
    } = {},
  ) {
    const state = await this.readState({ projectId, collections: ['libraryCases'] })
    const aggregate = readDesignState(state)
    return aggregate.libraryCases
      .filter(item => item.projectId === projectId)
      .filter(item => {
        const content = currentLibraryRevision(item).content
        return (
          (!filters.dimension || content.dimension === filters.dimension) &&
          (!filters.executionMethod || content.executionMethods.includes(filters.executionMethod as 'ui' | 'api')) &&
          (!filters.priority || content.priority === filters.priority) &&
          (!filters.status || item.status === filters.status)
        )
      })
      .sort(newest)
      .map(item => presentLibraryCase(item))
  }

  async getLibraryCase(projectId: string, caseId: string) {
    const state = await this.readState({ projectId, collections: ['libraryCases'] })
    return presentLibraryCase(
      required(
        readDesignState(state).libraryCases.find(item => item.id === caseId && item.projectId === projectId),
        'LIBRARY_TEST_CASE_NOT_FOUND',
        '正式测试用例不存在',
      ),
      true,
    )
  }

  async createLibraryCase(projectId: string, rawContent: unknown, changeReason: string, principal: Principal) {
    return this.store.transaction(state => {
      assertProjectExists(state, projectId)
      const content = validateTestCaseContent(rawContent)
      const createdAt = now()
      const revision = createLibraryRevision(
        1,
        content,
        principal.subjectId,
        cleanRequired(changeReason, '变更原因', 2_000),
      )
      const testCase: LibraryTestCase = {
        id: `library_test_case_${randomUUID()}`,
        projectId,
        currentRevision: 1,
        status: 'active',
        createdAt,
        updatedAt: createdAt,
        revisions: [revision],
      }
      designState(state).libraryCases.push(testCase)
      return presentLibraryCase(testCase, true)
    })
  }

  async editLibraryCase(
    projectId: string,
    caseId: string,
    ifMatch: string | undefined,
    rawContent: unknown,
    changeReason: string,
    principal: Principal,
    rawTraceability?: unknown,
  ) {
    return this.store.transaction(state => {
      const testCase = findLibraryCase(state, projectId, caseId)
      const current = currentLibraryRevision(testCase)
      assertEtag(ifMatch, libraryCaseEtag(testCase, current), 'LIBRARY_TEST_CASE_REVISION_CONFLICT')
      if (testCase.status === 'deprecated')
        throw new TestDesignError('LIBRARY_TEST_CASE_DEPRECATED', '废弃用例不能直接编辑', 409)
      const content = validateTestCaseContent(rawContent)
      const traceabilityChanged = traceabilityRelevantContentChanged(current.content, content)
      if (traceabilityChanged && rawTraceability === undefined)
        throw new TestDesignError(
          'LIBRARY_TEST_CASE_TRACEABILITY_REQUIRED',
          '追溯相关内容已变化，必须提交与新 Revision 匹配的正式追溯',
          422,
        )
      const traceability =
        rawTraceability === undefined
          ? current.traceability
          : validateLibraryTraceability(state, projectId, content, rawTraceability)
      if (traceability) assertTraceabilityMatchesContent(content, traceability)
      const revision = createLibraryRevision(
        current.revision + 1,
        content,
        principal.subjectId,
        cleanRequired(changeReason, '变更原因', 2_000),
        undefined,
        undefined,
        traceability,
      )
      testCase.revisions.push(revision)
      testCase.currentRevision = revision.revision
      testCase.updatedAt = revision.createdAt
      return presentLibraryCase(testCase, true)
    })
  }

  async copyLibraryCase(
    projectId: string,
    caseId: string,
    input: { content?: unknown; changeReason: string },
    principal: Principal,
  ) {
    const source = (await this.getLibraryCase(projectId, caseId)) as ReturnType<typeof presentLibraryCase>
    return this.createLibraryCase(projectId, input.content ?? source.content, input.changeReason, principal)
  }

  async deprecateLibraryCase(
    projectId: string,
    caseId: string,
    ifMatch: string | undefined,
    changeReason: string,
    principal: Principal,
  ) {
    return this.store.transaction(state => {
      const testCase = findLibraryCase(state, projectId, caseId)
      const current = currentLibraryRevision(testCase)
      assertEtag(ifMatch, libraryCaseEtag(testCase, current), 'LIBRARY_TEST_CASE_REVISION_CONFLICT')
      testCase.status = 'deprecated'
      testCase.updatedAt = now()
      const revision = createLibraryRevision(
        current.revision + 1,
        current.content,
        principal.subjectId,
        cleanRequired(changeReason, '废弃原因', 2_000),
        undefined,
        undefined,
        current.traceability,
      )
      testCase.revisions.push(revision)
      testCase.currentRevision = revision.revision
      return presentLibraryCase(testCase, true)
    })
  }

  async libraryCaseDiff(projectId: string, caseId: string, from: number, to: number) {
    const state = await this.readState({ projectId, collections: ['libraryCases'] })
    const testCase = findLibraryCase(state, projectId, caseId)
    const left = required(
      testCase.revisions.find(item => item.revision === from),
      'LIBRARY_TEST_CASE_REVISION_NOT_FOUND',
      '起始 Revision 不存在',
    )
    const right = required(
      testCase.revisions.find(item => item.revision === to),
      'LIBRARY_TEST_CASE_REVISION_NOT_FOUND',
      '目标 Revision 不存在',
    )
    return structuralDiff(left.content, right.content)
  }

  async publishLibraryVersion(
    projectVersionId: string,
    designId: string,
    runId: string,
    input: { name: string; expectedAuditId: string; expectedCaseSetSha256: string; expectedProposalSha256: string },
    principal: Principal,
  ) {
    const published = await this.store.transaction(state => {
      assertOpenVersion(state, projectVersionId)
      const design = findDesign(state, projectVersionId, designId)
      const run = findRun(state, projectVersionId, designId, runId)
      const aggregate = designState(state)
      const existing = aggregate.libraryVersions.find(item => item.sourceRunId === runId)
      if (existing) return structuredClone(existing)
      const baseline = run.baseTestCaseLibraryVersionId
        ? required(
            aggregate.libraryVersions.find(
              item =>
                item.id === run.baseTestCaseLibraryVersionId &&
                item.projectId === design.projectId &&
                item.contentSha256 === run.baseTestCaseLibraryVersionSha256,
            ),
            'TEST_CASE_LIBRARY_BASE_CHANGED',
            'Run 冻结的正式用例库版本或 Hash 不存在',
          )
        : undefined
      reconcileAutomaticProposalDecisions(run)
      const audit = required(
        run.coverageAudits.find(item => item.id === input.expectedAuditId && item.status === 'valid'),
        'COVERAGE_AUDIT_STALE',
        '覆盖审计不存在或已失效',
      )
      const publicationBlockers = audit.blockers.filter(item => item.resolution !== 'execution_handoff')
      if (publicationBlockers.length)
        throw new TestDesignError('TEST_CASE_LIBRARY_PUBLICATION_BLOCKED', 'Coverage Audit 存在发布阻断项', 409, {
          blockers: publicationBlockers,
        })
      if (audit.caseSetSha256 !== input.expectedCaseSetSha256)
        throw new TestDesignError('TEST_CASE_LIBRARY_HASH_MISMATCH', '候选用例 Hash 与审计不一致', 409)
      const proposalSha256 = caseChangeProposalSha256(run.caseChangeProposals)
      if (proposalSha256 !== input.expectedProposalSha256)
        throw new TestDesignError('CASE_CHANGE_PROPOSAL_HASH_MISMATCH', 'Proposal 决策 Hash 已变化', 409)
      const pending = run.caseChangeProposals.filter(
        item => item.decision === 'pending' && requiresHumanProposalDecision(item),
      )
      if (pending.length)
        throw new TestDesignError('CASE_CHANGE_PROPOSAL_DECISION_REQUIRED', '高风险用例库变更必须先完成人工处置', 409, {
          proposalIds: pending.map(item => item.id),
        })
      const currentAudit = runCoverageAudit(run)
      if (
        currentAudit.inputSha256 !== audit.inputSha256 ||
        currentAudit.caseSetSha256 !== audit.caseSetSha256 ||
        currentAudit.blockers.some(item => item.resolution !== 'execution_handoff')
      )
        throw new TestDesignError('COVERAGE_AUDIT_STALE', '发布前测试设计状态已变化，请重新审计', 409)
      assertLibraryPublicationGates(aggregate, design.projectId, run)
      assertLibraryBaselineMembersCurrent(aggregate, design.projectId, run, baseline)
      assertProposalSourcesCurrent(aggregate, design.projectId, run, baseline)
      const members = new Map((baseline?.members ?? []).map(item => [item.caseId, { ...item }]))
      for (const proposal of run.caseChangeProposals)
        applyProposalToLibrary(aggregate, design.projectId, run, proposal, members, principal.subjectId)
      const orderedMembers = [...members.values()]
        .sort((left, right) => left.caseId.localeCompare(right.caseId))
        .map((member, ordinal) =>
          freezeLibraryVersionMember(aggregate, design.projectId, {
            ...member,
            ordinal,
            traceability: effectiveTraceabilityForPublishedMember(run, member.caseId),
          }),
        )
      const canonicalContent = {
        schemaVersion: 'test-case-library/v3',
        projectId: design.projectId,
        projectVersionId,
        sourceRunId: runId,
        members: orderedMembers,
      }
      const contentSha256 = canonicalSha256(canonicalContent)
      const proposalStatistics = Object.fromEntries(
        (['reuse', 'update', 'create', 'deprecate', 'reference'] as const).map(operation => [
          operation,
          run.caseChangeProposals.filter(item => item.operation === operation && item.decision !== 'rejected').length,
        ]),
      ) as Record<CaseChangeProposal['operation'], number>
      const dimensionStatistics = orderedMembers.reduce<Partial<Record<TestCaseContent['dimension'], number>>>(
        (result, member) => {
          const content = required(
            aggregate.libraryCases
              .find(item => item.id === member.caseId)
              ?.revisions.find(item => item.revision === member.revision)?.content,
            'LIBRARY_TEST_CASE_REVISION_NOT_FOUND',
            '发布成员 Revision 不存在',
          )
          result[content.dimension] = (result[content.dimension] ?? 0) + 1
          return result
        },
        {},
      )
      const version: TestCaseLibraryVersion = {
        id: `test_case_library_version_${randomUUID()}`,
        projectId: design.projectId,
        projectVersionId,
        version:
          Math.max(
            0,
            ...aggregate.libraryVersions
              .filter(item => item.projectVersionId === projectVersionId)
              .map(item => item.version),
          ) + 1,
        name: cleanRequired(input.name, '用例库版本名称', 200),
        sourceRunId: runId,
        members: orderedMembers,
        contentSha256,
        publishedBy: principal.subjectId,
        publishedAt: now(),
        projection: { status: 'pending', files: [] },
        publicationSummary: {
          proposalStatistics,
          dimensionStatistics,
          coverageAudit: {
            id: audit.id,
            statistics: structuredClone(audit.statistics),
            blockerCount: audit.blockers.length,
          },
        },
      }
      aggregate.libraryVersions.push(version)
      return structuredClone(version)
    })
    if (published.projection.status === 'pending' && !published.projection.files.length)
      await this.projectLibraryVersion(published.id)
    return this.getLibraryVersion(published.projectId, published.id)
  }

  async listLibraryVersions(projectId: string, sourceRunId?: string) {
    const state = await this.readState({ projectId, collections: ['libraryCases', 'libraryVersions'] })
    const aggregate = readDesignState(state)
    return aggregate.libraryVersions
      .filter(item => item.projectId === projectId && (!sourceRunId || item.sourceRunId === sourceRunId))
      .sort((left, right) => right.version - left.version)
      .map(item => presentLibraryVersion(aggregate, item))
  }
  async getLibraryVersion(projectId: string, versionId: string) {
    const state = await this.readState({
      projectId,
      libraryVersionId: versionId,
      collections: ['libraryCases', 'libraryVersions'],
    })
    const aggregate = readDesignState(state)
    return presentLibraryVersion(
      aggregate,
      required(
        aggregate.libraryVersions.find(item => item.id === versionId && item.projectId === projectId),
        'TEST_CASE_LIBRARY_VERSION_NOT_FOUND',
        '用例库版本不存在',
      ),
    )
  }
  async getCurrentLibraryVersion(projectVersionId: string) {
    const state = await this.readState({ projectVersionId, collections: ['libraryCases', 'libraryVersions'] })
    const projectVersion = required(
      state.projectVersions.find(item => item.id === projectVersionId),
      'PROJECT_VERSION_NOT_FOUND',
      '项目版本不存在',
    )
    const aggregate = readDesignState(state)
    const libraryVersion = latestPublishedLibraryVersion(
      aggregate.libraryVersions.filter(item => item.projectVersionId === projectVersion.id),
    )
    if (!libraryVersion)
      throw new TestDesignError('TEST_EXECUTION_LIBRARY_REQUIRED', '当前项目版本尚未发布正式用例库', 409)
    return presentLibraryVersion(aggregate, libraryVersion)
  }
  async createDefaultExecutionHandoff(
    projectVersionId: string,
    libraryVersionId: string,
    expectedLibrarySha256: string,
    createdBy: string,
  ) {
    return this.createLibraryHandoff(
      projectVersionId,
      libraryVersionId,
      {
        mode: 'full',
        expectedLibrarySha256,
      },
      { subjectId: createdBy, displayName: createdBy },
    )
  }
  async publishedTestCases(projectVersionId: string) {
    const state = await this.readState({ projectVersionId, collections: ['runs', 'libraryCases', 'libraryVersions'] })
    const projectVersion = required(
      state.projectVersions.find(item => item.id === projectVersionId),
      'PROJECT_VERSION_NOT_FOUND',
      '项目版本不存在',
    )
    const aggregate = readDesignState(state)
    const libraryVersion = latestPublishedLibraryVersion(
      aggregate.libraryVersions.filter(item => item.projectVersionId === projectVersionId),
    )
    if (!libraryVersion)
      return {
        projectVersion: { id: projectVersion.id, name: projectVersion.name },
        libraryVersion: null,
        statistics: publishedTestCaseStatistics([]),
        items: [],
      }
    const run = required(
      libraryVersion.sourceRunId
        ? aggregate.runs.find(
            item => item.id === libraryVersion.sourceRunId && item.projectVersionId === projectVersionId,
          )
        : undefined,
      'TEST_CASE_LIBRARY_VERSION_SOURCE_INVALID',
      '正式用例库缺少当前 ProjectVersion 的发布 Run',
    )
    const detail = presentLibraryVersion(aggregate, libraryVersion)
    const items = detail.members.map(member => presentPublishedTestCase(run, member))
    return {
      projectVersion: { id: projectVersion.id, name: projectVersion.name },
      libraryVersion: {
        id: libraryVersion.id,
        version: libraryVersion.version,
        name: libraryVersion.name,
        contentSha256: libraryVersion.contentSha256,
        publishedAt: libraryVersion.publishedAt,
      },
      statistics: publishedTestCaseStatistics(items),
      items,
    }
  }
  async compareLibraryVersions(projectId: string, fromId: string, toId: string) {
    const left = await this.getLibraryVersion(projectId, fromId)
    const right = await this.getLibraryVersion(projectId, toId)
    return versionMemberDiff(left.members, right.members)
  }
  async listSuites(projectId: string, suiteType?: string) {
    const state = await this.readState({ projectId, collections: ['suiteVersions'] })
    return structuredClone(
      readDesignState(state)
        .suiteVersions.filter(item => item.projectId === projectId && (!suiteType || item.suiteType === suiteType))
        .sort(newest),
    )
  }
  async getSuite(projectId: string, suiteVersionId: string) {
    const state = await this.readState({ projectId, collections: ['suiteVersions'] })
    return structuredClone(
      required(
        readDesignState(state).suiteVersions.find(item => item.id === suiteVersionId && item.projectId === projectId),
        'TEST_SUITE_VERSION_NOT_FOUND',
        '测试套件版本不存在',
      ),
    )
  }

  async listSuiteDrafts(projectId: string) {
    const state = await this.readState({ projectId, collections: ['suiteDrafts'] })
    return structuredClone(
      readDesignState(state)
        .suiteDrafts.filter(item => item.projectId === projectId)
        .sort(newest),
    )
  }
  async getSuiteDraft(projectId: string, draftId: string) {
    const state = await this.readState({ projectId, collections: ['suiteDrafts'] })
    const draft = required(
      readDesignState(state).suiteDrafts.find(item => item.id === draftId && item.projectId === projectId),
      'TEST_SUITE_DRAFT_NOT_FOUND',
      '测试套件草稿不存在',
    )
    return { ...structuredClone(draft), etag: suiteDraftEtag(draft) }
  }

  async createSuiteDraft(projectId: string, raw: unknown, principal: Principal) {
    const input = suiteDraftInput(raw)
    return this.store.transaction(state => {
      assertProjectExists(state, projectId)
      const aggregate = designState(state)
      const members = validateSuiteMembers(aggregate, projectId, input.testCaseLibraryVersionId, input.members)
      const createdAt = now()
      const base = {
        projectId,
        suiteKey: input.suiteKey,
        suiteType: input.suiteType,
        name: input.name,
        testCaseLibraryVersionId: input.testCaseLibraryVersionId,
        compatibilityStatus: 'compatible' as const,
        members,
      }
      const draft: TestSuiteDraft = {
        id: `test_suite_draft_${randomUUID()}`,
        ...base,
        contentSha256: canonicalSha256(base),
        status: 'draft',
        createdBy: principal.subjectId,
        createdAt,
        updatedBy: principal.subjectId,
        updatedAt: createdAt,
      }
      aggregate.suiteDrafts.push(draft)
      return { ...structuredClone(draft), etag: suiteDraftEtag(draft) }
    })
  }

  async updateSuiteDraft(
    projectId: string,
    draftId: string,
    ifMatch: string | undefined,
    raw: unknown,
    principal: Principal,
  ) {
    const input = suiteDraftInput(raw)
    return this.store.transaction(state => {
      const aggregate = designState(state)
      const draft = required(
        aggregate.suiteDrafts.find(item => item.id === draftId && item.projectId === projectId),
        'TEST_SUITE_DRAFT_NOT_FOUND',
        '测试套件草稿不存在',
      )
      assertEtag(ifMatch, suiteDraftEtag(draft), 'TEST_SUITE_DRAFT_CONFLICT')
      if (draft.status !== 'draft')
        throw new TestDesignError('TEST_SUITE_DRAFT_IMMUTABLE', '已发布的套件草稿不可修改', 409)
      const changingVersion = Boolean(
        draft.testCaseLibraryVersionId && draft.testCaseLibraryVersionId !== input.testCaseLibraryVersionId,
      )
      const retainsOldMembers = input.members.some(member =>
        draft.members.some(current => current.caseId === member.caseId),
      )
      if (changingVersion && retainsOldMembers && !input.confirmLibraryVersionChange)
        throw new TestDesignError(
          'TEST_SUITE_LIBRARY_VERSION_CHANGE_CONFIRMATION_REQUIRED',
          '更换用例库版本时必须清空成员，或明确确认成员迁移',
          409,
        )
      const members = validateSuiteMembers(aggregate, projectId, input.testCaseLibraryVersionId, input.members)
      const base = {
        projectId,
        suiteKey: input.suiteKey,
        suiteType: input.suiteType,
        name: input.name,
        testCaseLibraryVersionId: input.testCaseLibraryVersionId,
        compatibilityStatus: 'compatible' as const,
        members,
      }
      Object.assign(draft, {
        ...base,
        incompatibilityReason: undefined,
        contentSha256: canonicalSha256(base),
        updatedBy: principal.subjectId,
        updatedAt: now(),
      })
      return { ...structuredClone(draft), etag: suiteDraftEtag(draft) }
    })
  }

  async publishSuiteDraft(projectId: string, draftId: string, ifMatch: string | undefined, principal: Principal) {
    return this.store.transaction(state => {
      const aggregate = designState(state)
      const draft = required(
        aggregate.suiteDrafts.find(item => item.id === draftId && item.projectId === projectId),
        'TEST_SUITE_DRAFT_NOT_FOUND',
        '测试套件草稿不存在',
      )
      assertEtag(ifMatch, suiteDraftEtag(draft), 'TEST_SUITE_DRAFT_CONFLICT')
      if (draft.status !== 'draft') throw new TestDesignError('TEST_SUITE_DRAFT_IMMUTABLE', '套件草稿已发布', 409)
      if (!draft.members.length)
        throw new TestDesignError('TEST_SUITE_MEMBER_REQUIRED', '测试套件至少包含一条正式用例', 422)
      if (
        !draft.testCaseLibraryVersionId ||
        draft.compatibilityStatus === 'migration_required' ||
        draft.members.some(member => member.testCaseLibraryVersionId !== draft.testCaseLibraryVersionId)
      )
        throw new TestDesignError(
          'TEST_SUITE_LIBRARY_VERSION_INCOMPATIBLE',
          '测试套件未固定唯一正式用例库版本，需要人工迁移',
          409,
        )
      const version: TestSuiteVersion = {
        id: `test_suite_version_${randomUUID()}`,
        projectId,
        suiteKey: draft.suiteKey,
        suiteType: draft.suiteType,
        version:
          Math.max(
            0,
            ...aggregate.suiteVersions
              .filter(item => item.projectId === projectId && item.suiteKey === draft.suiteKey)
              .map(item => item.version),
          ) + 1,
        name: draft.name,
        testCaseLibraryVersionId: draft.testCaseLibraryVersionId,
        compatibilityStatus: 'compatible',
        members: structuredClone(draft.members),
        contentSha256: canonicalSha256({
          projectId,
          suiteKey: draft.suiteKey,
          suiteType: draft.suiteType,
          name: draft.name,
          testCaseLibraryVersionId: draft.testCaseLibraryVersionId,
          members: draft.members,
        }),
        publishedBy: principal.subjectId,
        publishedAt: now(),
        status: 'active',
      }
      aggregate.suiteVersions.push(version)
      draft.status = 'published'
      draft.publishedVersionId = version.id
      draft.updatedBy = principal.subjectId
      draft.updatedAt = version.publishedAt
      return structuredClone(version)
    })
  }

  async compareSuiteVersions(projectId: string, fromId: string, toId: string) {
    const left = await this.getSuite(projectId, fromId)
    const right = await this.getSuite(projectId, toId)
    return versionMemberDiff(left.members, right.members)
  }
  async deprecateSuiteVersion(projectId: string, suiteVersionId: string, principal: Principal) {
    return this.store.transaction(state => {
      const suite = required(
        designState(state).suiteVersions.find(item => item.id === suiteVersionId && item.projectId === projectId),
        'TEST_SUITE_VERSION_NOT_FOUND',
        '测试套件版本不存在',
      )
      suite.status = 'deprecated'
      suite.deprecatedBy = principal.subjectId
      suite.deprecatedAt = now()
      return structuredClone(suite)
    })
  }

  async createLibraryHandoff(
    projectVersionId: string,
    libraryVersionId: string,
    input: {
      mode: 'smoke' | 'regression' | 'full' | 'custom'
      suiteVersionId?: string
      impactedCaseIds?: string[]
      expectedLibrarySha256: string
      executionReadinessOverrides?: Array<{
        caseId: string
        revision: number
        method?: TestExecutionMethod
        reason: string
      }>
    },
    principal: Principal,
  ) {
    return this.store.transaction(state => {
      assertOpenVersion(state, projectVersionId)
      const projectVersion = required(
        state.projectVersions.find(item => item.id === projectVersionId),
        'PROJECT_VERSION_NOT_FOUND',
        '项目版本不存在',
      )
      const aggregate = designState(state)
      const libraryVersion = required(
        aggregate.libraryVersions.find(
          item =>
            item.id === libraryVersionId &&
            item.projectId === projectVersion.projectId &&
            item.projectVersionId === projectVersionId,
        ),
        'TEST_CASE_LIBRARY_VERSION_NOT_FOUND',
        '用例库版本不属于当前项目版本',
      )
      if (libraryVersion.contentSha256 !== input.expectedLibrarySha256)
        throw new TestDesignError('TEST_CASE_LIBRARY_HASH_MISMATCH', '用例库版本 Hash 不一致', 409)
      const detailedLibraryVersion = presentLibraryVersion(aggregate, libraryVersion)
      const expectedSuiteType =
        input.mode === 'smoke'
          ? 'smoke'
          : input.mode === 'regression'
            ? 'regression'
            : input.mode === 'custom'
              ? 'custom'
              : undefined
      const suite = expectedSuiteType
        ? required(
            aggregate.suiteVersions.find(
              item =>
                item.id === input.suiteVersionId &&
                item.projectId === projectVersion.projectId &&
                item.suiteType === expectedSuiteType &&
                item.status !== 'deprecated',
            ),
            'TEST_SUITE_VERSION_NOT_FOUND',
            `${expectedSuiteType} 套件版本不存在`,
          )
        : undefined
      if (
        suite &&
        (suite.compatibilityStatus === 'migration_required' ||
          !suite.testCaseLibraryVersionId ||
          suite.testCaseLibraryVersionId !== libraryVersion.id)
      )
        throw new TestDesignError(
          'TEST_EXECUTION_HANDOFF_LIBRARY_VERSION_MISMATCH',
          '套件版本与选择的正式用例库版本不一致或需要人工迁移',
          422,
        )
      if (input.mode === 'full' && input.suiteVersionId)
        throw new TestDesignError('TEST_EXECUTION_HANDOFF_SUITE_FORBIDDEN', 'Full Handoff 不使用测试套件', 422)
      const libraryMembers = new Map(detailedLibraryVersion.members.map(item => [item.caseId, item]))
      const selections =
        input.mode === 'full'
          ? detailedLibraryVersion.members.map(item => ({
              ...item,
              executionMethods: executionMethodsForContent(item.frozenContent),
              reason: '指定用例库版本的全部冻结用例',
            }))
          : suite!.members.map(item => {
              if (item.testCaseLibraryVersionId !== libraryVersion.id)
                throw new TestDesignError(
                  'TEST_EXECUTION_HANDOFF_LIBRARY_VERSION_MISMATCH',
                  '套件成员不属于指定用例库版本',
                  422,
                )
              const libraryMember = required(
                libraryMembers.get(item.caseId),
                'TEST_SUITE_MEMBER_NOT_FOUND',
                '套件成员不属于指定用例库版本',
              )
              if (item.revision !== libraryMember.revision)
                throw new TestDesignError(
                  'TEST_EXECUTION_HANDOFF_LIBRARY_VERSION_MISMATCH',
                  '套件成员 Revision 与用例库版本冻结 Revision 不一致',
                  422,
                  { caseId: item.caseId, suiteRevision: item.revision, libraryRevision: libraryMember.revision },
                )
              const methods = suiteMemberExecutionMethods(item, libraryMember.frozenContent)
              return { ...libraryMember, executionMethods: methods, reason: item.reason }
            })
      if (input.mode === 'regression')
        for (const caseId of [...new Set(input.impactedCaseIds ?? [])]) {
          const member = required(
            libraryMembers.get(caseId),
            'TEST_CASE_LIBRARY_MEMBER_NOT_FOUND',
            '变更影响用例不属于指定用例库版本',
          )
          if (!selections.some(item => item.caseId === caseId))
            selections.push({
              ...member,
              executionMethods: executionMethodsForContent(member.frozenContent),
              reason: '需求变更影响分析补充',
            })
        }
      if (input.executionReadinessOverrides !== undefined && !Array.isArray(input.executionReadinessOverrides))
        throw new TestDesignError('TEST_EXECUTION_CASE_NOT_READY', 'executionReadinessOverrides 必须是数组', 422)
      const overrides = new Map<string, { reason: string; actorId: string; createdAt: string }>()
      for (const [index, override] of (input.executionReadinessOverrides ?? []).entries()) {
        if (!override || typeof override !== 'object' || !Number.isInteger(override.revision) || override.revision < 1)
          throw new TestDesignError('TEST_EXECUTION_CASE_NOT_READY', `executionReadinessOverrides[${index}] 无效`, 422)
        const caseId = cleanRequired(override.caseId, `executionReadinessOverrides[${index}].caseId`, 500)
        const method =
          override.method === undefined
            ? undefined
            : testExecutionMethod(override.method, `executionReadinessOverrides[${index}].method`)
        const key = `${caseId}:${override.revision}:${method ?? ''}`
        if (overrides.has(key))
          throw new TestDesignError(
            'TEST_EXECUTION_CASE_NOT_READY',
            '同一 Case Revision / 执行方式的人工覆盖决定不得重复',
            422,
            { caseId, revision: override.revision, method },
          )
        overrides.set(key, {
          reason: cleanRequired(override.reason, `executionReadinessOverrides[${index}].reason`, 2_000),
          actorId: principal.subjectId,
          createdAt: now(),
        })
      }
      const usedOverrides = new Set<string>()
      const members = selections.flatMap(selection => {
        const content = required(selection.frozenContent, 'TEST_EXECUTION_CASE_NOT_READY', '正式用例库版本缺少冻结内容')
        const reason = cleanRequired(selection.reason, '选择原因', 2_000)
        return selection.executionMethods.map(method => {
          const available = executionMethodsForContent(content)
          if (!available.includes(method))
            throw new TestDesignError(
              'TEST_SUITE_EXECUTION_METHOD_INVALID',
              '套件执行方式不属于冻结 Revision 的 executionMethods',
              422,
              { caseId: selection.caseId, revision: selection.revision, method },
            )
          const executionSpec = executionSpecForMethod(content, method)
          const configuration = executionConfigurationForMethod(content, method)
          const exactOverrideKey = `${selection.caseId}:${selection.revision}:${method}`
          const legacyOverrideKey = `${selection.caseId}:${selection.revision}:`
          const readinessOverride =
            overrides.get(exactOverrideKey) ??
            (selection.executionMethods.length === 1 ? overrides.get(legacyOverrideKey) : undefined)
          if (configuration.status === 'blocked')
            throw new TestDesignError(
              'TEST_EXECUTION_CASE_BLOCKED',
              'blocked 执行方式禁止进入 Execution Handoff，人工覆盖不能绕过',
              422,
              { caseId: selection.caseId, revision: selection.revision, method, issues: configuration.issues },
            )
          if (configuration.status === 'needs_confirmation' && !readinessOverride)
            throw new TestDesignError(
              'TEST_EXECUTION_READINESS_OVERRIDE_REQUIRED',
              'needs_confirmation 执行方式需要明确的人工覆盖决定和原因',
              422,
              { caseId: selection.caseId, revision: selection.revision, method, issues: configuration.issues },
            )
          if (readinessOverride)
            usedOverrides.add(overrides.has(exactOverrideKey) ? exactOverrideKey : legacyOverrideKey)
          return {
            stage: input.mode,
            ordinal: 0,
            sourceVersionId: suite?.id ?? libraryVersion.id,
            caseId: selection.caseId,
            revision: selection.revision,
            method,
            reason,
            dedupKey: `${selection.caseId}:${selection.revision}:${method}`,
            dimension: content.dimension,
            executionSpec,
            ...(selection.traceability ? { traceability: structuredClone(selection.traceability) } : {}),
            selectionReason: reason,
            contentSha256: selection.contentSha256,
            ...(readinessOverride ? { readinessOverride } : {}),
          }
        })
      })
      const handoffDedupKeys = new Set<string>()
      const duplicate = members.find(
        member => handoffDedupKeys.has(member.dedupKey) || !handoffDedupKeys.add(member.dedupKey),
      )
      if (duplicate)
        throw new TestDesignError(
          'TEST_EXECUTION_HANDOFF_MEMBER_DUPLICATE',
          'Execution Handoff 的 Case Revision / 执行方式组合不能重复',
          422,
          {
            caseId: duplicate.caseId,
            revision: duplicate.revision,
            method: duplicate.method,
            dedupKey: duplicate.dedupKey,
          },
        )
      members.forEach((member, ordinal) => {
        member.ordinal = ordinal
      })
      const unusedOverrides = [...overrides.keys()].filter(key => !usedOverrides.has(key))
      if (unusedOverrides.length)
        throw new TestDesignError(
          'TEST_EXECUTION_CASE_NOT_READY',
          '人工覆盖只能引用本次选择中 needs_confirmation 的冻结 Case Revision',
          422,
          { overrides: unusedOverrides },
        )
      const canonicalContent = {
        projectId: projectVersion.projectId,
        projectVersionId,
        testCaseLibraryVersionId: libraryVersion.id,
        ...(suite ? { suiteVersionId: suite.id } : {}),
        mode: input.mode,
        members,
      }
      const contentSha256 = canonicalSha256(canonicalContent)
      const existing = aggregate.executionHandoffs.find(
        item =>
          item.projectVersionId === projectVersionId &&
          item.mode === input.mode &&
          item.contentSha256 === contentSha256,
      )
      if (existing) return structuredClone(existing)
      const handoff: TestExecutionHandoff = {
        id: `test_execution_handoff_${randomUUID()}`,
        ...canonicalContent,
        contentSha256,
        createdBy: principal.subjectId,
        createdAt: now(),
      }
      aggregate.executionHandoffs.push(handoff)
      return structuredClone(handoff)
    })
  }

  async listLibraryHandoffs(projectVersionId: string, libraryVersionId?: string) {
    const state = await this.readState({ projectVersionId, collections: ['executionHandoffs'] })
    const projectVersion = required(
      state.projectVersions.find(item => item.id === projectVersionId),
      'PROJECT_VERSION_NOT_FOUND',
      '项目版本不存在',
    )
    return structuredClone(
      readDesignState(state)
        .executionHandoffs.filter(
          item =>
            item.projectId === projectVersion.projectId &&
            item.projectVersionId === projectVersionId &&
            Boolean(item.testCaseLibraryVersionId) &&
            (!libraryVersionId || item.testCaseLibraryVersionId === libraryVersionId),
        )
        .sort(newest),
    )
  }

  async getHandoff(handoffId: string) {
    const state = await this.readState({ handoffId, collections: ['executionHandoffs'] })
    return structuredClone(
      required(
        readDesignState(state).executionHandoffs.find(item => item.id === handoffId),
        'TEST_EXECUTION_HANDOFF_NOT_FOUND',
        '执行交接不存在',
      ),
    )
  }

  private async executeNode(
    runId: string,
    key: 'test_case_design' | 'test_design_repair',
    signal: AbortSignal,
    upstream: unknown,
  ) {
    await this.store.transaction(state => {
      const run = findRunById(state, runId)
      const target = node(run, key)
      Object.assign(target, {
        status: 'running',
        attempt: target.attempt + 1,
        startedAt: now(),
        finishedAt: undefined,
        error: undefined,
        errorCode: undefined,
        execution: undefined,
      })
      Object.assign(run, {
        status: 'running',
        stage: key,
        startedAt: run.startedAt ?? now(),
        finishedAt: undefined,
        error: undefined,
        errorCode: undefined,
      })
      if (key === 'test_design_repair' && run.automaticRepair?.status === 'queued')
        Object.assign(run.automaticRepair, { status: 'running', startedAt: now(), finishedAt: undefined })
    })
    const run = await this.loadRun(runId)
    const nodeRunId = node(run, key).id
    const events: AgentExecutionEvent[] = []
    return this.runtime!.execute(
      {
        stage: key,
        run,
        upstream,
        onExecutionEvent: async event => {
          events.push(event)
          if (shouldCheckpointTestDesignExecution(event))
            await this.saveNodeExecutionProgress(runId, nodeRunId, key, events)
        },
      },
      signal,
    )
  }
  private async saveNodeExecutionProgress(
    runId: string,
    nodeRunId: string,
    key: 'test_case_design' | 'test_design_repair',
    events: AgentExecutionEvent[],
    lease?: TaskLease,
  ) {
    const persist = (state: DatabaseState) => {
      const run = readDesignState(state).runs.find(item => item.id === runId)
      const target = run?.nodeRuns.find(item => item.id === nodeRunId && item.nodeKey === key)
      if (!run || !target || target.status !== 'running') return
      target.execution = testDesignExecutionProgress(run, key, events)
    }
    if (lease) await this.fencedNodeTransaction(nodeRunId, lease, persist)
    else await this.store.transaction(persist)
  }
  private startLocally(runId: string) {
    if (this.activeRuns.has(runId)) return
    const controller = new AbortController()
    this.activeRuns.set(runId, controller)
    void this.processPreparedRun(runId, controller.signal)
      .catch(() => undefined)
      .finally(() => this.activeRuns.delete(runId))
  }
  private async schedule(runId: string) {
    if (!this.store.enqueueTestDesignJob) {
      this.startLocally(runId)
      return
    }
    const run = await this.loadRun(runId)
    const targets = run.nodeRuns.filter(item => item.status === 'queued')
    await Promise.all(
      targets.map(async target => {
        const createdAt = now()
        await this.store.enqueueTestDesignJob!({
          id: `workflow_job_${randomUUID()}`,
          runId,
          nodeRunId: target.id,
          status: 'queued',
          attempts: 0,
          maxAttempts: 3,
          availableAt: createdAt,
          createdAt,
          updatedAt: createdAt,
        })
      }),
    )
  }
  private async fencedNodeTransaction<T>(
    nodeRunId: string,
    lease: TaskLease,
    operation: (draft: DatabaseState) => T | Promise<T>,
  ) {
    if (!this.store.transactionWithTestDesignLease)
      throw new TestDesignError('WORKFLOW_JOB_LEASE_LOST', '当前 Store 不支持测试设计节点租约', 503)
    const result = await this.store.transactionWithTestDesignLease(nodeRunId, lease, operation)
    if (result === null) throw new TestDesignError('WORKFLOW_JOB_LEASE_LOST', '测试设计节点租约已失效', 409)
    return result
  }
  private async readState(scope: TestDesignReadScope) {
    return this.store.getTestDesignReadState ? this.store.getTestDesignReadState(scope) : this.store.snapshot()
  }
  private async loadRun(runId: string) {
    const state = await this.readState({ runId, collections: ['runs'] })
    return structuredClone(findRunById(state, runId))
  }
  private async loadScopedRun(projectVersionId: string, designId: string, runId: string) {
    const state = await this.readState({ projectVersionId, designId, runId, collections: ['designs', 'runs'] })
    return structuredClone(findRun(state, projectVersionId, designId, runId))
  }
  private async projectLibraryVersion(versionId: string) {
    if (!this.projector)
      throw new TestDesignError(
        'TEST_DESIGN_WORKSPACE_PROJECTION_UNAVAILABLE',
        '正式用例库必须投影到 Workspace AssetVersion，但资产服务不可用',
        503,
      )
    const state = await this.readState({
      libraryVersionId: versionId,
      collections: ['runs', 'libraryCases', 'libraryVersions'],
    })
    const aggregate = readDesignState(state)
    const version = required(
      aggregate.libraryVersions.find(item => item.id === versionId),
      'TEST_CASE_LIBRARY_VERSION_NOT_FOUND',
      '用例库版本不存在',
    )
    const projectVersion = required(
      state.projectVersions.find(item => item.id === version.projectVersionId && item.projectId === version.projectId),
      'PROJECT_VERSION_NOT_FOUND',
      '用例库项目版本不存在',
    )
    const base = required(
      state.knowledgeBases.find(item => item.projectId === version.projectId),
      'TEST_DESIGN_WORKSPACE_PROJECTION_UNAVAILABLE',
      '项目知识库不存在',
    )
    const files = libraryProjectionFiles(projectVersion.name, version, aggregate.libraryCases)
    try {
      const projected = await this.projectWorkspaceFiles(
        base.id,
        `test-case-library:${version.id}`,
        'test_case_library',
        files,
        'upload',
      )
      await this.store.transaction(draft => {
        const current = designState(draft)
        const target = required(
          current.libraryVersions.find(item => item.id === version.id),
          'TEST_CASE_LIBRARY_VERSION_NOT_FOUND',
          '用例库版本不存在',
        )
        target.projection = {
          status: projected.some(item => item.pending) ? 'pending' : 'succeeded',
          files: projected.map(item => ({
            logicalPath: item.file.logicalPath,
            contentSha256: item.file.contentSha256,
            assetVersionId: item.assetVersionId,
          })),
        }
        const run = target.sourceRunId ? current.runs.find(item => item.id === target.sourceRunId) : undefined
        if (run) {
          const paths = new Set(projected.map(item => item.file.logicalPath))
          run.formalWorkspaceFiles = [
            ...run.formalWorkspaceFiles.filter(item => !paths.has(item.logicalPath)),
            ...projected.map(item => ({
              ...item.file,
              sourceType: 'test_case_library_version' as const,
              sourceId: target.id,
              assetVersionId: item.assetVersionId,
            })),
          ]
        }
      })
    } catch (error) {
      await this.store.transaction(draft => {
        const target = required(
          designState(draft).libraryVersions.find(item => item.id === version.id),
          'TEST_CASE_LIBRARY_VERSION_NOT_FOUND',
          '用例库版本不存在',
        )
        target.projection = {
          status: 'failed',
          files: [],
          error: String(error instanceof Error ? error.message : error).slice(0, 2_000),
        }
      })
      throw error
    }
  }

  private async projectWorkspaceFiles(
    knowledgeBaseId: string,
    sourcePrefix: string,
    assetType: string,
    files: TestDesignWorkspaceFile[],
    trigger: 'upload' | 'retry',
  ) {
    return Promise.all(
      files.map(async file => {
        const input: WorkspaceArtifactIngestInput = {
          knowledgeBaseId,
          sourceType: 'upload',
          sourceKey: `${sourcePrefix}:${file.logicalPath}:${file.contentSha256}`,
          assetType,
          displayName: file.displayName,
          logicalPath: file.logicalPath,
          content: file.content,
          taskTrigger: trigger,
        }
        const ingest = this.projector!.ingestWorkspaceArtifact ?? this.projector!.ingest
        const result = await ingest.call(this.projector, input)
        return { file, assetVersionId: result.version.id, pending: Boolean(result.task) }
      }),
    )
  }
}
export { TEST_DESIGN_RUNTIME_KNOWLEDGE_REFERENCE_LIMIT } from './test-design/snapshots.js'
export { repairCandidateContent } from './test-design/workflow.js'
export { buildHistoricalSnapshot } from './test-design/snapshots.js'
export { buildTestDesignRetrievalQueries } from './test-design/snapshots.js'
export { selectRuntimeKnowledgeReferences } from './test-design/snapshots.js'
export { materializeCaseDesign } from './test-design/workflow.js'
export { requirementSemanticSha256 } from './test-design/snapshots.js'
export { mapRequirementsAcrossReleases } from './test-design/snapshots.js'
export { buildEffectiveCaseSet } from './test-design/case-review.js'
export { testCaseSemanticSha256 } from './test-design/case-review.js'
