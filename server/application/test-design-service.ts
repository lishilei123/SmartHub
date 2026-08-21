import { createHash, randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import type { Principal } from '../domain/access-control.js'
import type { AgentExecutionEvent } from '../domain/agent-types.js'
import type { DatabaseState, ProjectVersion, ReviewRun } from '../domain/types.js'
import { activeRequirementReleaseBinding, requirementReleaseBindings } from '../domain/requirement-release-bindings.js'
import type {
  CaseChangeDecision, CaseChangeProposal, CreateTestDesignInput, CoverageAudit, HistoricalCaseSnapshot, ImpactedRegressionReference, LegacyTestCaseMigrationRecord, LibraryTestCase, LibraryTestCaseRevision, RetrievalSnapshot, SmokeCandidateRelation, TestCase,
  TestCaseContent, TestCaseLibraryVersion, TestCaseLibraryVersionDetail, TestCaseSetVersion, TestDataRequirement, TestDataRequirementSetVersion, TestDesign, TestDesignBasisSnapshot, TestDesignWorkspaceFile, TestDesignWorkspaceSnapshot,
  TestCaseTraceability, TestDesignNodeKey, TestDesignRunAgentConfigurationSnapshot, TestDesignState, TestDesignWorkflowRun, TestExecutionHandoff, TestExecutionMethod,
  TestSuiteDraft, TestSuiteVersion, TestSuiteVersionMember, WorkflowArtifact, WorkflowNodeRun,
} from '../domain/test-design-types.js'
import type { StateStore, TaskLease } from '../infrastructure/store.js'
import { canonicalJson, canonicalSha256 } from './canonical-json.js'
import { auditTestDesignCoverage } from './test-design-coverage-auditor.js'
import { assertEtag, etag, isTestDesignRepairPatch, TestDesignError, validateCaseDependencyGraph, validateCreateTestDesignInput, validateHistoricalProposalPlan, validateTestCaseContent, validateTestCaseDesignCandidate, type CandidateCase, type TestCaseDesignCandidate, type TestDataRequirementCandidate, type TestDesignRepairPatch } from './test-design-validation.js'
import { classifyWorkspaceSourceScope } from './project-workspace-snapshot.js'

const AUTOMATIC_REPAIR_MAX_ATTEMPTS = 1
const PLANNING_AGENT_EDITOR_ID = 'planning-agent'
const TEST_DESIGN_SERVICE_ACTOR_ID = 'system:test-design-service'

type RepairCandidateCase = { ref: string } & TestCaseContent & { changeReason?: string; confidence?: number }
type RepairCandidateSnapshot = {
  schemaVersion: 'test-design-repair/v1'
  cases: RepairCandidateCase[]
  dimensionAssessments: TestCaseDesignCandidate['dimensionAssessments']
  scenarioClaims: TestCaseDesignCandidate['scenarioClaims']
  dataRequirements: TestDataRequirementCandidate[]
  findings: Record<string, unknown>[]
  confirmationItems: Record<string, unknown>[]
  proposals: TestCaseDesignCandidate['proposals']
}

export interface PlanningAgentRuntime {
  readiness?(): Promise<{ ready: boolean; agents: Array<{ agentKey: string; ready: boolean; reason?: string }> }>
  freezeConfiguration?(): Promise<TestDesignRunAgentConfigurationSnapshot>
  appendTask?(input: { projectVersionId: string; taskType: string; task: string; metadata?: Record<string, unknown> }): Promise<unknown>
  execute(input: {
    stage: 'test_case_design' | 'test_design_repair'
    run: TestDesignWorkflowRun
    upstream: unknown
    onExecutionEvent?: (event: AgentExecutionEvent) => void | Promise<void>
  }, signal: AbortSignal): Promise<{ schemaVersion: string; content: unknown; execution?: WorkflowNodeRun['execution'] }>
}
type WorkspaceArtifactIngestInput = { knowledgeBaseId: string; sourceType: 'upload'; sourceKey: string; assetType: string; displayName: string; logicalPath: string; content: string; taskTrigger?: 'upload' | 'retry' }
export interface TestCaseAssetProjector {
  ingest(input: WorkspaceArtifactIngestInput): Promise<{ version: { id: string }; task: unknown }>
  ingestWorkspaceArtifact?(input: WorkspaceArtifactIngestInput): Promise<{ version: { id: string }; task: unknown }>
}

export class TestDesignService {
  private readonly activeRuns = new Map<string, AbortController>()
  constructor(private readonly store: StateStore, private readonly runtime?: PlanningAgentRuntime, private readonly projector?: TestCaseAssetProjector) {}

  async inputCandidates(projectVersionId: string) {
    const state = await this.store.snapshot()
    const projectVersion = required(state.projectVersions.find(item => item.id === projectVersionId), 'PROJECT_VERSION_NOT_FOUND', '项目版本不存在')
    const projectBases = state.knowledgeBases.filter(item => item.projectId === projectVersion.projectId)
    const requirementRelease = boundRequirementRelease(state, projectVersionId)
    const requirementReleases = requirementReleaseBindings(projectVersion).flatMap(binding => {
      try {
        const resolved = boundRequirementRelease(state, projectVersionId, binding.releaseId)
        return resolved ? [resolved] : []
      } catch (error) {
        if (error instanceof TestDesignError && error.code === 'TEST_DESIGN_REQUIREMENT_RELEASE_BINDING_INVALID') return []
        throw error
      }
    })
    const knowledgeAssets = projectBases.flatMap(base => state.assets.filter(asset => asset.knowledgeBaseId === base.id).flatMap(asset => state.versions.filter(version => version.assetId === asset.id).map(version => ({ assetId: asset.id, assetVersionId: version.id, version: version.number, contentHash: version.contentHash, displayName: asset.displayName, logicalPath: asset.logicalPath, assetType: asset.assetType, status: version.status, selectable: version.status === 'ready', reason: version.status === 'ready' ? undefined : '资产版本未就绪' }))))
    const designState = readDesignState(state)
    const inheritedSource = explicitlyInheritedSourceVersion(state, projectVersion)
    const inheritedLibraryVersions = inheritedSource ? inheritedLibraryVersionsForSource(designState, inheritedSource.id) : []
    const inheritedLibraryVersionIds = new Set(inheritedLibraryVersions.map(item => item.id))
    const agentReadiness = this.runtime?.readiness ? await this.runtime.readiness() : { ready: Boolean(this.runtime), agents: [{ agentKey: 'planning', ready: Boolean(this.runtime), reason: this.runtime ? undefined : 'PlanningAgent Runtime 未配置' }] }
    return {
      projectVersion: { id: projectVersion.id, projectId: projectVersion.projectId, name: projectVersion.name, status: projectVersion.status, ...(projectVersion.sourceProjectVersionId ? { sourceProjectVersionId: projectVersion.sourceProjectVersionId } : {}), ...(inheritedSource ? { sourceProjectVersionName: inheritedSource.name } : {}), inheritsSourceAssets: Boolean(inheritedSource) },
      requirementRelease: requirementRelease ? presentRequirementRelease(requirementRelease, true) : null,
      requirementReleases: requirementReleases.map(item => presentRequirementRelease(item, item.binding.releaseId === requirementRelease?.binding.releaseId)),
      knowledgeAssets,
      fixedIndexes: projectBases.flatMap(base => state.indexes.filter(index => index.knowledgeBaseId === base.id && index.status === 'active').map(index => ({ id: index.id, selectable: true }))),
      historicalCaseSets: designState.caseSetVersions.filter(item => item.projectId === projectVersion.projectId).map(item => ({ id: item.id, name: item.name, version: item.version, memberCount: item.members.length, contentSha256: item.contentSha256 })),
      testCaseLibraryVersions: inheritedLibraryVersions.sort((left, right) => right.version - left.version).map(item => ({ id: item.id, name: item.name, version: item.version, memberCount: item.members.length, contentSha256: item.contentSha256, publishedAt: item.publishedAt })),
      historicalTestSuites: designState.suiteVersions.filter(item => item.projectId === projectVersion.projectId && item.status !== 'deprecated' && Boolean(item.testCaseLibraryVersionId && inheritedLibraryVersionIds.has(item.testCaseLibraryVersionId))).sort(newest).map(item => ({ id: item.id, name: item.name, suiteKey: item.suiteKey, suiteType: item.suiteType, version: item.version, memberCount: item.members.length, contentSha256: item.contentSha256 })),
      historicalCaseAssets: knowledgeAssets.filter(item => item.assetType === 'test_case' && item.selectable),
      agentReadiness,
    }
  }

  async createDesign(projectVersionId: string, rawInput: unknown, principal: Principal) {
    const input = validateCreateTestDesignInput(rawInput)
    return this.store.transaction(state => {
      const projectVersion = required(state.projectVersions.find(item => item.id === projectVersionId), 'PROJECT_VERSION_NOT_FOUND', '项目版本不存在')
      if (projectVersion.status !== 'open') throw new TestDesignError('PROJECT_VERSION_READ_ONLY', '当前项目版本只读', 409)
      const requirement = required(boundRequirementRelease(state, projectVersionId, input.requirementReleaseId), 'TEST_DESIGN_REQUIREMENT_RELEASE_NOT_BOUND', '当前 ProjectVersion 尚未完成需求分析并绑定 Requirement Release')
      validateDesignSources(state, projectVersion, input)
      const design: TestDesign = { id: `test_design_${randomUUID()}`, projectVersionId, projectId: projectVersion.projectId, name: input.name, objective: input.objective, input, logicalInputSha256: canonicalSha256(input), createdBy: principal.subjectId, createdAt: now(), creationMode: 'manual', sourceRequirementReleaseId: requirement.release.id }
      designState(state).designs.push(design)
      return structuredClone(design)
    })
  }

  async createAutomaticDesignAndRun(projectVersionId: string, analysisRunId: string) {
    const created = await this.store.transaction(state => {
      const projectVersion = required(state.projectVersions.find(item => item.id === projectVersionId), 'PROJECT_VERSION_NOT_FOUND', '项目版本不存在')
      if (projectVersion.status !== 'open') throw new TestDesignError('PROJECT_VERSION_READ_ONLY', '当前项目版本只读', 409)
      const analysisRun = required(state.reviewRuns.find(item => item.id === analysisRunId && item.projectVersionId === projectVersionId), 'REQUIREMENT_RUN_NOT_FOUND', '需求理解运行不存在')
      const release = required(analysisRun.workflow?.release, 'TEST_DESIGN_REQUIREMENT_RELEASE_NOT_BOUND', '需求理解尚未冻结正式基线')
      if (analysisRun.status !== 'succeeded' || release.status !== 'published' || !boundRequirementRelease(state, projectVersionId, release.id)) throw new TestDesignError('TEST_DESIGN_REQUIREMENT_RELEASE_NOT_BOUND', '需求理解基线尚未正式绑定', 409)
      const aggregate = designState(state)
      const existing = aggregate.designs.find(item => item.projectVersionId === projectVersionId && item.creationMode === 'automatic' && item.sourceRequirementReleaseId === release.id)
      if (existing) return { design: structuredClone(existing), created: false }
      const result = required(analysisRun.result, 'REQUIREMENT_RESULT_NOT_FOUND', '需求理解结果不存在')
      const activeIndex = state.indexes.find(item => item.id === analysisRun.snapshot.indexVersionId && item.status === 'active')
      const inheritedSource = explicitlyInheritedSourceVersion(state, projectVersion)
      const latestInheritedLibrary = inheritedSource ? latestPublishedLibraryVersion(inheritedLibraryVersionsForSource(aggregate, inheritedSource.id)) : undefined
      const rawInput: CreateTestDesignInput = {
        name: `${projectVersion.name} · 自动测试设计`,
        objective: result.summary.overview.trim() || '依据已冻结的需求理解生成可追溯测试用例。',
        includedScopes: [],
        excludedScopes: [],
        focusDimensions: ['functional', 'performance', 'stability', 'compatibility', 'security'],
        executionMethods: ['ui', 'api'],
        userCoverageObjectives: result.testFocus.map(item => `${item.title}：${item.description}`),
        knowledgeAugmentation: activeIndex ? { mode: 'fixed_index', indexVersionId: activeIndex.id } : { mode: 'disabled' },
        historicalCaseSelections: [],
        historicalLibrarySelection: latestInheritedLibrary
          ? { mode: 'latest_library' }
          : { mode: 'none' },
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
    const run = await this.createRun(projectVersionId, created.design.id, `test-design-run:${created.design.id}:automatic:${analysisRunId}`, { subjectId: 'system:planning-workflow', displayName: 'Planning Workflow' })
    return { design: created.design, run }
  }

  async listDesigns(projectVersionId: string) {
    const state = await this.store.snapshot(); const aggregate = readDesignState(state)
    return aggregate.designs.filter(item => item.projectVersionId === projectVersionId).sort(newest).map(design => ({ ...design, latestRun: aggregate.runs.filter(run => run.testDesignId === design.id).sort(newest)[0] ?? null }))
  }

  async getDesign(projectVersionId: string, designId: string) {
    const state = await this.store.snapshot(); return structuredClone(findDesign(state, projectVersionId, designId))
  }

  async createRun(projectVersionId: string, designId: string, idempotencyKey: string, principal: Principal) {
    if (!idempotencyKey?.trim()) throw new TestDesignError('IDEMPOTENCY_KEY_REQUIRED', '创建运行必须提供 Idempotency-Key', 400)
    findDesign(await this.store.snapshot(), projectVersionId, designId)
    const readiness = this.runtime?.readiness ? await this.runtime.readiness() : { ready: Boolean(this.runtime) }
    if (!readiness.ready) throw new TestDesignError('TEST_DESIGN_AGENT_NOT_READY', 'PlanningAgent 尚未发布或未通过模型门禁', 409, readiness)
    const agentConfigurationSnapshot = this.runtime?.freezeConfiguration ? await this.runtime.freezeConfiguration() : undefined
    if (!agentConfigurationSnapshot) throw new TestDesignError('TEST_DESIGN_AGENT_NOT_READY', 'PlanningAgent Runtime 无法冻结配置版本', 409)
    const created = await this.store.transaction(async state => {
      const design = findDesign(state, projectVersionId, designId)
      const projectVersion = required(state.projectVersions.find(item => item.id === projectVersionId), 'PROJECT_VERSION_NOT_FOUND', '项目版本不存在')
      if (projectVersion.status !== 'open') throw new TestDesignError('PROJECT_VERSION_READ_ONLY', '当前项目版本只读', 409)
      const aggregate = designState(state)
      const existing = aggregate.runs.find(run => run.testDesignId === designId && run.idempotencyKey === idempotencyKey)
      if (existing) return { run: structuredClone(existing), created: false }
      if (!this.runtime) throw new TestDesignError('TEST_DESIGN_AGENT_NOT_READY', 'PlanningAgent 尚未完成运行时配置', 409)
      const requirement = required(boundRequirementRelease(state, projectVersionId, design.sourceRequirementReleaseId), 'TEST_DESIGN_REQUIREMENT_RELEASE_NOT_BOUND', '测试设计未绑定有效的 Requirement Release')
      const requirements = publishedRequirements(requirement.analysisRun)
      if (requirements.artifact.contentSha256 !== requirement.binding.requirementsJsonSha256) throw new TestDesignError('TEST_DESIGN_REQUIREMENT_RELEASE_BINDING_INVALID', 'ProjectVersion 绑定的 requirements.json Hash 与发布包不一致', 409)
      const runId = `test_design_run_${randomUUID()}`
      const createdAt = now()
      const basisSnapshot = buildBasisSnapshot(design, requirement, requirements, createdAt)
      const retrievalSnapshot = await buildRetrievalSnapshot(state, design, createdAt)
      const historicalSnapshot = buildHistoricalSnapshot(state, design, createdAt)
      const workspaceSnapshot = buildWorkspaceSnapshot(state, design, requirement, requirements, historicalSnapshot, createdAt)
      const run: TestDesignWorkflowRun = {
        id: runId, testDesignId: design.id, projectVersionId, status: 'queued', stage: 'test_case_design', progress: 0, idempotencyKey, requestedExecutionMethods: [...(design.input.executionMethods ?? [])],
        basisSnapshot, agentConfigurationSnapshot, currentInputRefs: structuredClone(requirement.analysisRun.snapshot.currentInputRefs), retrievalSnapshot, historicalSnapshot, workspaceSnapshot, formalWorkspaceFiles: [],
        ...(historicalSnapshot.baseTestCaseLibraryVersionId ? { baseTestCaseLibraryVersionId: historicalSnapshot.baseTestCaseLibraryVersionId, baseTestCaseLibraryVersionSha256: historicalSnapshot.baseTestCaseLibraryVersionSha256 } : {}),
        nodeRuns: workflowNodes(runId), artifacts: [], gateDecisions: [], testCases: [], scenarioClaims: [], dimensionAssessments: [], caseChangeProposals: [], dataSetVersions: [], coverageAudits: [], smokeCandidates: [], impactedRegression: [], findings: [], confirmationItems: [], automaticRepair: initialAutomaticRepairState(), events: [], createdBy: principal.subjectId, createdAt,
      }
      aggregate.runs.push(run)
      return { run: structuredClone(run), created: true }
    })
    if (created.run.status === 'queued') await this.schedule(created.run.id)
    return created.run
  }

  async listRuns(projectVersionId: string, designId: string) {
    const state = await this.store.snapshot(); findDesign(state, projectVersionId, designId)
    const aggregate = readDesignState(state)
    const publishedRunIds = new Set(aggregate.libraryVersions.flatMap(item => item.sourceRunId ? [item.sourceRunId] : []))
    return aggregate.runs.filter(item => item.projectVersionId === projectVersionId && item.testDesignId === designId).sort(newest).map(run => {
      const baseline = run.baseTestCaseLibraryVersionId ? aggregate.libraryVersions.find(item => item.id === run.baseTestCaseLibraryVersionId) : undefined
      return { ...presentRun(run), ...(run.baseTestCaseLibraryVersionId ? { baseTestCaseLibraryVersionId: run.baseTestCaseLibraryVersionId } : {}), ...(baseline ? { baseTestCaseLibraryVersion: { id: baseline.id, version: baseline.version, name: baseline.name } } : {}), caseCount: run.testCases.filter(item => !item.tombstonedAt).length, pendingManualProposalCount: run.caseChangeProposals.filter(item => item.decision === 'pending' && requiresHumanProposalDecision(item)).length, published: publishedRunIds.has(run.id) }
    })
  }

  async getRun(projectVersionId: string, designId: string, runId: string) {
    const state = await this.store.snapshot(); const run = findRun(state, projectVersionId, designId, runId)
    return { ...presentRun(run, true), caseChangeProposalSha256: caseChangeProposalSha256(run.caseChangeProposals ?? []) }
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
      await this.store.transaction(state => {
        const current = readDesignState(state).runs.find(item => item.id === runId); if (!current || current.status === 'cancelled') return
        const message = error instanceof Error ? error.message : String(error); const active = current.nodeRuns.find(item => item.status === 'running'); const execution = error && typeof error === 'object' && 'execution' in error ? (error as { execution?: WorkflowNodeRun['execution'] }).execution : undefined; if (active) Object.assign(active, { status: 'failed', finishedAt: now(), error: message, errorCode: errorCode(message), ...(execution ? { execution } : {}) })
        Object.assign(current, { status: 'failed', stage: 'failed', finishedAt: now(), error: message, errorCode: errorCode(message) })
      }).catch(() => undefined)
      throw error
    }
  }

  async processPreparedNode(runId: string, nodeRunId: string, lease: TaskLease, signal = new AbortController().signal) {
    if (!this.runtime) throw new TestDesignError('TEST_DESIGN_AGENT_NOT_READY', '测试设计 Agent Runtime 未配置', 409)
    const initial = await this.loadRun(runId)
    const claimed = required(initial.nodeRuns.find(item => item.id === nodeRunId), 'WORKFLOW_NODE_NOT_FOUND', '领取的工作流节点不存在')
    if (!['test_case_design', 'test_design_repair'].includes(claimed.nodeKey)) throw new TestDesignError('WORKFLOW_NODE_NOT_RETRYABLE', '领取的节点不是 PlanningAgent Stage', 409)
    if (initial.status === 'cancelled' || claimed.status === 'succeeded' || claimed.status === 'cancelled') return initial

    const key = claimed.nodeKey as 'test_case_design' | 'test_design_repair'
    try {
      await this.fencedNodeTransaction(nodeRunId, lease, state => {
        const run = findRunById(state, runId)
        const target = required(run.nodeRuns.find(item => item.id === nodeRunId && item.nodeKey === key), 'WORKFLOW_NODE_NOT_FOUND', '节点已被新 generation 替换')
        // A reclaimed PostgreSQL Job can retain the previous worker's running
        // node state. The lease transaction below fences that worker out, so
        // the current Job owner may safely take over the interrupted attempt.
        if (!['queued', 'failed', 'running'].includes(target.status)) throw new TestDesignError('WORKFLOW_NODE_NOT_RETRYABLE', `节点当前状态 ${target.status} 不可执行`, 409)
        Object.assign(target, { status: 'running', attempt: target.attempt + 1, startedAt: now(), finishedAt: undefined, error: undefined, errorCode: undefined, execution: undefined })
        Object.assign(run, { status: 'running', stage: key, startedAt: run.startedAt ?? now(), finishedAt: undefined, error: undefined, errorCode: undefined })
        if (key === 'test_design_repair' && run.automaticRepair?.status === 'queued') Object.assign(run.automaticRepair, { status: 'running', startedAt: now(), finishedAt: undefined })
      })
      const running = await this.loadRun(runId)
      const upstream = key === 'test_case_design' ? caseDesignInput(running) : repairInput(running)
      const events: AgentExecutionEvent[] = []
      const output = await this.runtime.execute({
        stage: key,
        run: running,
        upstream,
        onExecutionEvent: async event => {
          events.push(event)
          if (shouldCheckpointTestDesignExecution(event)) await this.saveNodeExecutionProgress(runId, nodeRunId, key, events, lease)
        },
      }, signal)
      const result = await this.fencedNodeTransaction(nodeRunId, lease, state => {
        const run = findRunById(state, runId)
        const target = required(run.nodeRuns.find(item => item.id === nodeRunId && item.nodeKey === key), 'WORKFLOW_NODE_NOT_FOUND', '节点已被新 generation 替换')
        if (target.status !== 'running') throw new TestDesignError('WORKFLOW_JOB_LEASE_LOST', '节点已不处于当前执行状态', 409)
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
          Object.assign(run, { status: 'failed', stage: 'failed', finishedAt: now(), error: message, errorCode: errorCode(message) })
        }).catch(() => undefined)
      }
      throw error
    }
  }

  async cancelRun(projectVersionId: string, designId: string, runId: string, principal: Principal) {
    const controller = this.activeRuns.get(runId); controller?.abort(new Error(`WORKFLOW_CANCELLED: ${principal.subjectId}`))
    await this.store.cancelTestDesignJob?.(runId)
    return this.store.transaction(state => { const run = findRun(state, projectVersionId, designId, runId); if (run.status === 'succeeded') throw new TestDesignError('WORKFLOW_NODE_NOT_RETRYABLE', '已完成运行不能取消', 409); Object.assign(run, { status: 'cancelled', stage: 'cancelled', finishedAt: now(), errorCode: 'WORKFLOW_CANCELLED', error: '运行已由用户取消' }); run.nodeRuns.filter(item => ['pending', 'queued', 'running', 'waiting_gate'].includes(item.status)).forEach(item => { item.status = 'cancelled'; item.finishedAt = now() }); return presentRun(run, true) })
  }

  async fullRerun(projectVersionId: string, designId: string, runId: string, idempotencyKey: string, principal: Principal) { await this.getRun(projectVersionId, designId, runId); return this.createRun(projectVersionId, designId, idempotencyKey, principal) }

  async resynthesize(projectVersionId: string, designId: string, runId: string) {
    const state = await this.store.snapshot()
    assertOpenVersion(state, projectVersionId)
    findRun(state, projectVersionId, designId, runId)
    await this.runtime?.appendTask?.({
      projectVersionId,
      taskType: 'test_case_resynthesize',
      task: [
        '请重新生成测试用例。',
        '',
        '请继续在当前 Planning Session 中，基于当前 Requirement Release、正式 Clarification 和冻结 Workspace 重新生成完整测试用例候选。',
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
      run.scenarioClaims = []
      run.dimensionAssessments = []
      run.caseChangeProposals = []
      run.dataSetVersions = []
      run.automaticRepair = initialAutomaticRepairState()
      invalidateAudit(run)
      Object.assign(run, { status: 'queued', stage: 'test_case_design', progress: 55, error: undefined, errorCode: undefined, finishedAt: undefined })
    })
    await this.schedule(runId)
    return this.getRun(projectVersionId, designId, runId)
  }

  async listCases(projectVersionId: string, designId: string, runId: string, filters: { dimension?: string; executionMethod?: string; status?: string } = {}) {
    const run = await this.loadScopedRun(projectVersionId, designId, runId)
    return run.testCases.filter(item => !item.tombstonedAt).filter(item => { const content = currentCaseRevision(item).content; return (!filters.dimension || content.dimension === filters.dimension) && (!filters.executionMethod || executionMethodForContent(content) === filters.executionMethod || (content.executionMethods ?? []).some(method => method.method === filters.executionMethod)) && (!filters.status || item.reviewState === filters.status) }).map(testCase => presentCase(testCase))
  }

  async createCase(projectVersionId: string, designId: string, runId: string, rawContent: unknown, principal: Principal) {
    return this.store.transaction(state => { assertOpenVersion(state, projectVersionId); const run = findRun(state, projectVersionId, designId, runId); const content = validateTestCaseContent(rawContent); const testCase = newCase(run.id, content, 'manual', principal.subjectId, '人工新建'); run.testCases.push(testCase); ensureCandidateProposal(run, testCase, '人工新增测试用例'); invalidateAudit(run); validateCurrentDependencyGraph(run); return presentCase(testCase) })
  }

  async getCase(projectVersionId: string, designId: string, runId: string, caseId: string) { const run = await this.loadScopedRun(projectVersionId, designId, runId); return presentCase(findCase(run, caseId), true) }
  async caseRevisions(projectVersionId: string, designId: string, runId: string, caseId: string) { const run = await this.loadScopedRun(projectVersionId, designId, runId); return structuredClone(findCase(run, caseId).revisions) }
  async caseDiff(projectVersionId: string, designId: string, runId: string, caseId: string, from: number, to: number) { const run = await this.loadScopedRun(projectVersionId, designId, runId); const testCase = findCase(run, caseId); const left = required(testCase.revisions.find(item => item.revision === from), 'TEST_CASE_REVISION_NOT_FOUND', '起始用例 revision 不存在'); const right = required(testCase.revisions.find(item => item.revision === to), 'TEST_CASE_REVISION_NOT_FOUND', '目标用例 revision 不存在'); return structuralDiff(left.content, right.content) }

  async patchCase(projectVersionId: string, designId: string, runId: string, caseId: string, ifMatch: string | undefined, input: { content: unknown; reason: string }, principal: Principal) {
    return this.store.transaction(state => {
      assertOpenVersion(state, projectVersionId); const run = findRun(state, projectVersionId, designId, runId); const testCase = findCase(run, caseId)
      const editableReviewStates: ReadonlyArray<TestCase['reviewState']> = ['draft', 'needs_revision', 'rejected']
      if (!editableReviewStates.includes(testCase.reviewState)) throw new TestDesignError('TEST_CASE_EDIT_REVIEW_STATE_INVALID', '审核中的 Revision 不能直接修改；请先撤回审核、退回修改或发起变更。', 409, { caseId: testCase.id, reviewState: testCase.reviewState })
      const current = currentCaseRevision(testCase); assertEtag(ifMatch, etag('case', testCase.id, current.revision, current.contentSha256), 'TEST_CASE_REVISION_CONFLICT')
      const content = validateTestCaseContent(input.content); const revision = createCaseRevision(current.revision + 1, content, principal.subjectId, input.reason, current.content); testCase.revisions.push(revision); testCase.currentRevision = revision.revision; testCase.reviewState = 'draft'; if (testCase.origin === 'historical_unchanged') testCase.origin = 'historical_modified'; ensureCandidateProposal(run, testCase, input.reason); invalidateAudit(run); validateCurrentDependencyGraph(run); return presentCase(testCase, true)
    })
  }

  async deleteCase(projectVersionId: string, designId: string, runId: string, caseId: string, principal: Principal) { return this.store.transaction(state => { assertOpenVersion(state, projectVersionId); const run = findRun(state, projectVersionId, designId, runId); const testCase = findCase(run, caseId); testCase.tombstonedAt ??= now(); testCase.reviewState = 'draft'; convertDeletedCandidateProposal(run, testCase); invalidateAudit(run); validateCurrentDependencyGraph(run); return { caseId, deletedBy: principal.subjectId, tombstonedAt: testCase.tombstonedAt } }) }

  async reviewCase(projectVersionId: string, designId: string, runId: string, caseId: string, input: { decision: 'submit' | 'approve' | 'reject' | 'request_revision' | 'withdraw'; targetRevision: number; comment?: string }, principal: Principal) {
    return this.store.transaction(state => { assertOpenVersion(state, projectVersionId); const run = findRun(state, projectVersionId, designId, runId); const testCase = findCase(run, caseId); applyReviewAction(testCase, input, principal.subjectId); reconcileAutomaticProposalDecisions(run); return presentCase(testCase, true) })
  }

  async batchReview(projectVersionId: string, designId: string, runId: string, input: { targets: Array<{ caseId: string; targetRevision: number }>; decision: 'submit' | 'approve' | 'reject' | 'request_revision' | 'withdraw'; comment?: string }, principal: Principal) {
    return this.store.transaction(state => { assertOpenVersion(state, projectVersionId); const run = findRun(state, projectVersionId, designId, runId); const targets = input.targets.map(target => ({ target, testCase: findCase(run, target.caseId) })); targets.forEach(({ target, testCase }) => { if (testCase.currentRevision !== target.targetRevision) throw new TestDesignError('TEST_CASE_REVISION_CONFLICT', `用例 ${testCase.id} revision 已变化`, 412) }); targets.forEach(({ target, testCase }) => applyReviewAction(testCase, { ...input, targetRevision: target.targetRevision }, principal.subjectId)); reconcileAutomaticProposalDecisions(run); return targets.map(item => presentCase(item.testCase)) })
  }

  async getDataRequirements(projectVersionId: string, designId: string, runId: string) { const run = await this.loadScopedRun(projectVersionId, designId, runId); return structuredClone(run.dataSetVersions) }

  async replaceDataRequirements(projectVersionId: string, designId: string, runId: string, requirements: TestDataRequirement[], principal: Principal) {
    return this.store.transaction(state => { assertOpenVersion(state, projectVersionId); const run = findRun(state, projectVersionId, designId, runId); const normalized = validateDataRequirements(run, requirements); const version = dataSetVersion(run.dataSetVersions.length + 1, normalized, principal.subjectId); run.dataSetVersions.push(version); invalidateAudit(run); return structuredClone(version) })
  }

  async reAudit(projectVersionId: string, designId: string, runId: string) { return this.store.transaction(state => { assertOpenVersion(state, projectVersionId); const run = findRun(state, projectVersionId, designId, runId); const audit = runCoverageAudit(run); run.coverageAudits.forEach(item => { item.status = 'stale' }); run.coverageAudits.push(audit); return structuredClone(audit) }) }
  async coverageAudits(projectVersionId: string, designId: string, runId: string) { return structuredClone((await this.loadScopedRun(projectVersionId, designId, runId)).coverageAudits) }
  async coverageMatrix(projectVersionId: string, designId: string, runId: string, direction: 'basis_to_case' | 'case_to_basis') { const run = await this.loadScopedRun(projectVersionId, designId, runId); const audit = [...run.coverageAudits].reverse().find(item => item.status === 'valid'); if (!audit) throw new TestDesignError('COVERAGE_AUDIT_STALE', '没有有效覆盖审计', 409); return direction === 'basis_to_case' ? audit.relations : [...audit.relations].sort((left, right) => String(left.caseId).localeCompare(String(right.caseId))) }

  async basisSource(projectVersionId: string, designId: string, runId: string, basisItemId: string) { const run = await this.loadScopedRun(projectVersionId, designId, runId); return structuredClone(required(run.basisSnapshot.items.find(item => item.id === basisItemId), 'TEST_DESIGN_BASIS_ITEM_NOT_FOUND', '固定依据不存在')) }
  async retrievalSource(projectVersionId: string, designId: string, runId: string, hitId: string) { const run = await this.loadScopedRun(projectVersionId, designId, runId); return structuredClone(required(run.retrievalSnapshot.hits.find(item => item.id === hitId), 'TEST_DESIGN_RETRIEVAL_HIT_NOT_FOUND', '固定召回结果不存在')) }
  async historicalSource(projectVersionId: string, designId: string, runId: string, itemId: string) { const run = await this.loadScopedRun(projectVersionId, designId, runId); return structuredClone(required(run.historicalSnapshot.items.find(item => item.id === itemId), 'TEST_DESIGN_HISTORICAL_SOURCE_INVALID', '历史用例快照不存在')) }
  async findings(projectVersionId: string, designId: string, runId: string) { return structuredClone((await this.loadScopedRun(projectVersionId, designId, runId)).findings) }
  async confirmationItems(projectVersionId: string, designId: string, runId: string) { return structuredClone((await this.loadScopedRun(projectVersionId, designId, runId)).confirmationItems) }
  async actOnFinding(projectVersionId: string, designId: string, runId: string, findingId: string, input: { expectedVersion: number; decision: 'confirm' | 'resolve' | 'defer' | 'reject' | 'reopen'; comment?: string }, principal: Principal) { return this.store.transaction(state => { assertOpenVersion(state, projectVersionId); const run = findRun(state, projectVersionId, designId, runId); const finding = required(run.findings.find(item => item.id === findingId), 'TEST_DESIGN_FINDING_NOT_FOUND', '测试设计 Finding 不存在'); applyDisposition(finding, input, principal.subjectId); invalidateAudit(run); return structuredClone(finding) }) }
  async actOnConfirmation(projectVersionId: string, designId: string, runId: string, itemId: string, input: { expectedVersion: number; decision: 'confirm' | 'resolve' | 'defer' | 'reject' | 'reopen'; comment?: string; structuredDecision?: unknown }, principal: Principal) { return this.store.transaction(state => { assertOpenVersion(state, projectVersionId); const run = findRun(state, projectVersionId, designId, runId); const item = required(run.confirmationItems.find(candidate => candidate.id === itemId), 'TEST_DESIGN_CONFIRMATION_NOT_FOUND', '待确认项不存在'); applyDisposition(item, input, principal.subjectId); invalidateAudit(run); const requiredAction = item.impactStage === 'publication' ? 're_audit' : 'resynthesize'; return { item: structuredClone(item), requiredAction } }) }

  async listCaseChangeProposals(projectVersionId: string, designId: string, runId: string, operation?: string) { const run = await this.loadScopedRun(projectVersionId, designId, runId); return structuredClone((run.caseChangeProposals ?? []).filter(item => !operation || item.operation === operation)) }

  async decideCaseChangeProposal(projectVersionId: string, designId: string, runId: string, proposalId: string, input: { expectedVersion: number; decision: Exclude<CaseChangeDecision, 'pending'>; comment?: string }, principal: Principal) {
    return this.store.transaction(state => {
      assertOpenVersion(state, projectVersionId)
      const run = findRun(state, projectVersionId, designId, runId)
      const proposal = required(run.caseChangeProposals.find(item => item.id === proposalId), 'CASE_CHANGE_PROPOSAL_NOT_FOUND', '用例库变更 Proposal 不存在')
      if (!requiresHumanProposalDecision(proposal)) throw new TestDesignError('CASE_CHANGE_PROPOSAL_AUTOMATIC', `${proposal.operation} Proposal 由 Service 随用例审核状态自动处理`, 409)
      if (proposal.decisions.length !== input.expectedVersion) throw new TestDesignError('CASE_CHANGE_PROPOSAL_VERSION_CONFLICT', 'Proposal 决策版本已变化', 409)
      validateProposalDecision(proposal, input.decision)
      const decidedAt = now()
      proposal.decision = input.decision; proposal.decidedBy = principal.subjectId; proposal.decidedAt = decidedAt
      proposal.decisions.push({ id: `case_change_decision_${randomUUID()}`, expectedVersion: input.expectedVersion, decision: input.decision, ...(input.comment?.trim() ? { comment: input.comment.trim().slice(0, 4_000) } : {}), decidedBy: principal.subjectId, decidedAt })
      return structuredClone(proposal)
    })
  }

  async listLibraryCases(projectId: string, filters: { domain?: string; dimension?: string; executionMethod?: string; priority?: string; status?: string; tag?: string } = {}) {
    const state = await this.store.snapshot(); const aggregate = readDesignState(state)
    return aggregate.libraryCases.filter(item => item.projectId === projectId).filter(item => {
      const content = currentLibraryRevision(item).content
      return (!filters.domain || content.domain === filters.domain) && (!filters.dimension || content.dimension === filters.dimension) && (!filters.executionMethod || executionMethodForContent(content) === filters.executionMethod || (content.executionMethods ?? []).some(method => method.method === filters.executionMethod)) && (!filters.priority || content.priority === filters.priority) && (!filters.status || item.status === filters.status) && (!filters.tag || content.tags.includes(filters.tag))
    }).sort(newest).map(item => presentLibraryCase(item))
  }

  async getLibraryCase(projectId: string, caseId: string) { const state = await this.store.snapshot(); return presentLibraryCase(required(readDesignState(state).libraryCases.find(item => item.id === caseId && item.projectId === projectId), 'LIBRARY_TEST_CASE_NOT_FOUND', '正式测试用例不存在'), true) }

  async createLibraryCase(projectId: string, rawContent: unknown, changeReason: string, principal: Principal) {
    return this.store.transaction(state => { assertProjectExists(state, projectId); const content = validateTestCaseContent(rawContent); const createdAt = now(); const revision = createLibraryRevision(1, content, principal.subjectId, cleanRequired(changeReason, '变更原因', 2_000)); const testCase: LibraryTestCase = { id: `library_test_case_${randomUUID()}`, projectId, currentRevision: 1, status: 'active', createdAt, updatedAt: createdAt, revisions: [revision] }; designState(state).libraryCases.push(testCase); return presentLibraryCase(testCase, true) })
  }

  async editLibraryCase(projectId: string, caseId: string, ifMatch: string | undefined, rawContent: unknown, changeReason: string, principal: Principal, rawTraceability?: unknown) {
    return this.store.transaction(state => {
      const testCase = findLibraryCase(state, projectId, caseId)
      const current = currentLibraryRevision(testCase)
      assertEtag(ifMatch, libraryCaseEtag(testCase, current), 'LIBRARY_TEST_CASE_REVISION_CONFLICT')
      if (testCase.status === 'deprecated') throw new TestDesignError('LIBRARY_TEST_CASE_DEPRECATED', '废弃用例不能直接编辑', 409)
      const content = validateTestCaseContent(rawContent)
      const traceabilityChanged = traceabilityRelevantContentChanged(current.content, content)
      if (traceabilityChanged && rawTraceability === undefined) throw new TestDesignError('LIBRARY_TEST_CASE_TRACEABILITY_REQUIRED', '追溯相关内容已变化，必须提交与新 Revision 匹配的正式追溯', 422)
      const traceability = rawTraceability === undefined ? current.traceability : validateLibraryTraceability(state, projectId, content, rawTraceability)
      if (traceability) assertTraceabilityMatchesContent(content, traceability)
      const revision = createLibraryRevision(current.revision + 1, content, principal.subjectId, cleanRequired(changeReason, '变更原因', 2_000), undefined, undefined, traceability)
      testCase.revisions.push(revision)
      testCase.currentRevision = revision.revision
      testCase.updatedAt = revision.createdAt
      return presentLibraryCase(testCase, true)
    })
  }

  async copyLibraryCase(projectId: string, caseId: string, input: { content?: unknown; changeReason: string }, principal: Principal) { const source = await this.getLibraryCase(projectId, caseId) as ReturnType<typeof presentLibraryCase>; return this.createLibraryCase(projectId, input.content ?? source.content, input.changeReason, principal) }

  async deprecateLibraryCase(projectId: string, caseId: string, ifMatch: string | undefined, changeReason: string, principal: Principal) {
    return this.store.transaction(state => { const testCase = findLibraryCase(state, projectId, caseId); const current = currentLibraryRevision(testCase); assertEtag(ifMatch, libraryCaseEtag(testCase, current), 'LIBRARY_TEST_CASE_REVISION_CONFLICT'); testCase.status = 'deprecated'; testCase.updatedAt = now(); const revision = createLibraryRevision(current.revision + 1, current.content, principal.subjectId, cleanRequired(changeReason, '废弃原因', 2_000), undefined, undefined, current.traceability); testCase.revisions.push(revision); testCase.currentRevision = revision.revision; return presentLibraryCase(testCase, true) })
  }

  async libraryCaseDiff(projectId: string, caseId: string, from: number, to: number) { const state = await this.store.snapshot(); const testCase = findLibraryCase(state, projectId, caseId); const left = required(testCase.revisions.find(item => item.revision === from), 'LIBRARY_TEST_CASE_REVISION_NOT_FOUND', '起始 Revision 不存在'); const right = required(testCase.revisions.find(item => item.revision === to), 'LIBRARY_TEST_CASE_REVISION_NOT_FOUND', '目标 Revision 不存在'); return structuralDiff(left.content, right.content) }

  async publishLibraryVersion(projectVersionId: string, designId: string, runId: string, input: { name: string; expectedAuditId: string; expectedCaseSetSha256: string; expectedProposalSha256: string }, principal: Principal) {
    const published = await this.store.transaction(state => {
      assertOpenVersion(state, projectVersionId); const design = findDesign(state, projectVersionId, designId); const run = findRun(state, projectVersionId, designId, runId); const aggregate = designState(state)
      const existing = aggregate.libraryVersions.find(item => item.sourceRunId === runId); if (existing) return structuredClone(existing)
      const baseline = run.baseTestCaseLibraryVersionId
        ? required(aggregate.libraryVersions.find(item => item.id === run.baseTestCaseLibraryVersionId && item.projectId === design.projectId && item.contentSha256 === run.baseTestCaseLibraryVersionSha256), 'TEST_CASE_LIBRARY_BASE_CHANGED', 'Run 冻结的正式用例库版本或 Hash 不存在')
        : undefined
      reconcileAutomaticProposalDecisions(run)
      const audit = required(run.coverageAudits.find(item => item.id === input.expectedAuditId && item.status === 'valid'), 'COVERAGE_AUDIT_STALE', '覆盖审计不存在或已失效')
      const dataRequirementSet = required(run.dataSetVersions.find(item => item.id === audit.dataSetVersionId), 'TEST_DATA_REQUIREMENT_SET_NOT_FOUND', 'Coverage Audit 固定的测试数据需求版本不存在')
      if (canonicalSha256(dataRequirementSet.requirements) !== dataRequirementSet.contentSha256) throw new TestDesignError('TEST_DATA_REQUIREMENT_SET_HASH_MISMATCH', '测试数据需求版本 Hash 不一致', 409)
      const publicationBlockers = audit.blockers.filter(item => item.resolution !== 'execution_handoff')
      if (publicationBlockers.length) throw new TestDesignError('TEST_CASE_LIBRARY_PUBLICATION_BLOCKED', 'Coverage Audit 存在发布阻断项', 409, { blockers: publicationBlockers })
      if (audit.caseSetSha256 !== input.expectedCaseSetSha256) throw new TestDesignError('TEST_CASE_LIBRARY_HASH_MISMATCH', '候选用例 Hash 与审计不一致', 409)
      const proposalSha256 = caseChangeProposalSha256(run.caseChangeProposals)
      if (proposalSha256 !== input.expectedProposalSha256) throw new TestDesignError('CASE_CHANGE_PROPOSAL_HASH_MISMATCH', 'Proposal 决策 Hash 已变化', 409)
      const pending = run.caseChangeProposals.filter(item => item.decision === 'pending' && requiresHumanProposalDecision(item)); if (pending.length) throw new TestDesignError('CASE_CHANGE_PROPOSAL_DECISION_REQUIRED', '高风险用例库变更必须先完成人工处置', 409, { proposalIds: pending.map(item => item.id) })
      const currentAudit = runCoverageAudit(run); if (currentAudit.inputSha256 !== audit.inputSha256 || currentAudit.caseSetSha256 !== audit.caseSetSha256 || currentAudit.blockers.some(item => item.resolution !== 'execution_handoff')) throw new TestDesignError('COVERAGE_AUDIT_STALE', '发布前测试设计状态已变化，请重新审计', 409)
      assertLibraryPublicationGates(aggregate, design.projectId, run)
      assertLibraryBaselineMembersCurrent(aggregate, design.projectId, run, baseline)
      assertProposalSourcesCurrent(aggregate, design.projectId, run, baseline)
      const members = new Map((baseline?.members ?? []).map(item => [item.caseId, { ...item }]))
      for (const proposal of run.caseChangeProposals) applyProposalToLibrary(aggregate, design.projectId, run, proposal, members, principal.subjectId)
      const orderedMembers = [...members.values()].sort((left, right) => left.caseId.localeCompare(right.caseId)).map((member, ordinal) => freezeLibraryVersionMember(aggregate, design.projectId, { ...member, ordinal }))
      const canonicalContent = { schemaVersion: 'test-case-library/v1', projectId: design.projectId, sourceRunId: runId, dataRequirementSet: { id: dataRequirementSet.id, version: dataRequirementSet.version, contentSha256: dataRequirementSet.contentSha256 }, members: orderedMembers }
      const contentSha256 = canonicalSha256(canonicalContent)
      const proposalStatistics = Object.fromEntries((['reuse', 'update', 'create', 'deprecate', 'reference'] as const).map(operation => [operation, run.caseChangeProposals.filter(item => item.operation === operation && item.decision !== 'rejected').length])) as Record<CaseChangeProposal['operation'], number>
      const dimensionStatistics = orderedMembers.reduce<Partial<Record<TestCaseContent['dimension'], number>>>((result, member) => { const content = required(aggregate.libraryCases.find(item => item.id === member.caseId)?.revisions.find(item => item.revision === member.revision)?.content, 'LIBRARY_TEST_CASE_REVISION_NOT_FOUND', '发布成员 Revision 不存在'); result[content.dimension] = (result[content.dimension] ?? 0) + 1; return result }, {})
      const version: TestCaseLibraryVersion = { id: `test_case_library_version_${randomUUID()}`, projectId: design.projectId, version: Math.max(0, ...aggregate.libraryVersions.filter(item => item.projectId === design.projectId).map(item => item.version)) + 1, name: cleanRequired(input.name, '用例库版本名称', 200), sourceRunId: runId, dataRequirementSet: structuredClone(dataRequirementSet), members: orderedMembers, contentSha256, publishedBy: principal.subjectId, publishedAt: now(), projection: { status: 'pending', files: [] }, publicationSummary: { proposalStatistics, dimensionStatistics, coverageAudit: { id: audit.id, statistics: structuredClone(audit.statistics), blockerCount: audit.blockers.length } } }
      aggregate.libraryVersions.push(version); return structuredClone(version)
    })
    if (published.projection.status === 'pending' && !published.projection.files.length) await this.projectLibraryVersion(published.id)
    return this.getLibraryVersion(published.projectId, published.id)
  }

  async listLibraryVersions(projectId: string) { const state = await this.store.snapshot(); const aggregate = readDesignState(state); return aggregate.libraryVersions.filter(item => item.projectId === projectId).sort((left, right) => right.version - left.version).map(item => presentLibraryVersion(aggregate, item)) }
  async getLibraryVersion(projectId: string, versionId: string) { const state = await this.store.snapshot(); const aggregate = readDesignState(state); return presentLibraryVersion(aggregate, required(aggregate.libraryVersions.find(item => item.id === versionId && item.projectId === projectId), 'TEST_CASE_LIBRARY_VERSION_NOT_FOUND', '用例库版本不存在')) }
  async compareLibraryVersions(projectId: string, fromId: string, toId: string) { const left = await this.getLibraryVersion(projectId, fromId); const right = await this.getLibraryVersion(projectId, toId); return versionMemberDiff(left.members, right.members) }

  async previewLegacyCaseMigration(projectId: string, legacyTestCaseSetVersionId: string) {
    const state = await this.store.snapshot()
    assertProjectExists(state, projectId)
    return structuredClone(buildLegacyMigrationPreview(readDesignState(state), projectId, legacyTestCaseSetVersionId))
  }

  async migrateLegacyCaseSet(projectId: string, input: { legacyTestCaseSetVersionId: string; expectedPreviewSha256: string; confirmUncertain?: boolean }, principal: Principal) {
    const result = await this.store.transaction(state => {
      assertProjectExists(state, projectId)
      const aggregate = designState(state)
      const existingRecord = aggregate.legacyMigrations.find(item => item.projectId === projectId && item.legacyTestCaseSetVersionId === input.legacyTestCaseSetVersionId)
      if (existingRecord) return { version: required(aggregate.libraryVersions.find(item => item.id === existingRecord.testCaseLibraryVersionId), 'TEST_CASE_LIBRARY_VERSION_NOT_FOUND', '已迁移用例库版本不存在'), record: existingRecord }
      const preview = buildLegacyMigrationPreview(aggregate, projectId, cleanRequired(input.legacyTestCaseSetVersionId, 'legacyTestCaseSetVersionId', 500))
      if (preview.previewSha256 !== input.expectedPreviewSha256) throw new TestDesignError('LEGACY_TEST_CASE_MIGRATION_PREVIEW_STALE', '迁移预览已变化，请重新查看后确认', 409, { currentPreviewSha256: preview.previewSha256 })
      if (preview.status === 'needs_confirmation' && !input.confirmUncertain) throw new TestDesignError('LEGACY_TEST_CASE_MIGRATION_CONFIRMATION_REQUIRED', '迁移预览存在重复冲突或执行配置不完整的历史用例，必须人工确认后导入', 409, { items: preview.items.filter(item => item.resolution === 'needs_confirmation' || item.executionConfigurationStatus !== 'ready') })
      const legacy = required(aggregate.caseSetVersions.find(item => item.id === input.legacyTestCaseSetVersionId && item.projectId === projectId), 'TEST_CASE_SET_NOT_FOUND', '历史已发布用例集不存在')
      const mappings: LegacyTestCaseMigrationRecord['mappings'] = []
      const members = new Map((aggregate.libraryVersions.filter(item => item.projectId === projectId).sort((left, right) => right.version - left.version)[0]?.members ?? []).map(item => [item.caseId, { ...item }]))
      for (const item of preview.items) {
        const normalized = normalizeLegacyCaseContent(item.content)
        const priorMapping = aggregate.legacyMigrations.flatMap(record => record.mappings).find(mapping => mapping.legacyCaseId === item.legacyCaseId)
        let target = priorMapping ? aggregate.libraryCases.find(candidate => candidate.id === priorMapping.libraryCaseId && candidate.projectId === projectId) : aggregate.libraryCases.find(candidate => candidate.id === item.suggestedLibraryCaseId && candidate.projectId === projectId)
        if (!target && item.resolution === 'needs_confirmation') target = aggregate.libraryCases.find(candidate => candidate.id === item.legacyCaseId && candidate.projectId === projectId)
        if (!target) {
          const createdAt = now()
          const revision = createLibraryRevision(1, normalized, principal.subjectId, `从历史用例集 ${legacy.id} 迁移`)
          target = { id: item.suggestedLibraryCaseId, projectId, currentRevision: 1, status: 'active', createdAt, updatedAt: createdAt, revisions: [revision] }
          aggregate.libraryCases.push(target)
        }
        let revision = target.revisions.find(candidate => candidate.contentSha256 === canonicalSha256(normalized))
        if (!revision) {
          revision = createLibraryRevision(Math.max(0, ...target.revisions.map(candidate => candidate.revision)) + 1, normalized, principal.subjectId, `从历史用例集 ${legacy.id} 迁移`)
          target.revisions.push(revision)
          target.currentRevision = revision.revision
          target.updatedAt = revision.createdAt
          target.status = 'active'
        }
        members.set(target.id, { caseId: target.id, revision: revision.revision, ordinal: 0, contentSha256: revision.contentSha256 })
        mappings.push({ legacyCaseId: item.legacyCaseId, legacyRevision: item.legacyRevision, libraryCaseId: target.id, libraryRevision: revision.revision, resolution: item.resolution === 'needs_confirmation' ? 'created_after_confirmation' : item.resolution === 'reuse_identical' ? 'reused_identical' : 'created' })
      }
      const orderedMembers = [...members.values()].sort((left, right) => left.caseId.localeCompare(right.caseId)).map((member, ordinal) => freezeLibraryVersionMember(aggregate, projectId, { ...member, ordinal }))
      const canonicalContent = { schemaVersion: 'test-case-library/v1', projectId, legacyTestCaseSetVersionId: legacy.id, members: orderedMembers }
      const version: TestCaseLibraryVersion = { id: `test_case_library_version_${randomUUID()}`, projectId, version: Math.max(0, ...aggregate.libraryVersions.filter(item => item.projectId === projectId).map(item => item.version)) + 1, name: `历史用例迁移 · ${legacy.name}`, legacyTestCaseSetVersionId: legacy.id, members: orderedMembers, contentSha256: canonicalSha256(canonicalContent), publishedBy: principal.subjectId, publishedAt: now(), projection: { status: 'pending', files: [] } }
      aggregate.libraryVersions.push(version)
      const record: LegacyTestCaseMigrationRecord = { id: `legacy_test_case_migration_${randomUUID()}`, projectId, legacyTestCaseSetVersionId: legacy.id, previewSha256: preview.previewSha256, status: 'migrated', mappings, testCaseLibraryVersionId: version.id, migratedBy: principal.subjectId, migratedAt: version.publishedAt }
      aggregate.legacyMigrations.push(record)
      return { version, record }
    })
    if (result.version.projection.status === 'pending' && !result.version.projection.files.length) await this.projectLibraryVersion(result.version.id)
    return { version: await this.getLibraryVersion(projectId, result.version.id), record: structuredClone(result.record) }
  }

  async publishCaseSet(projectVersionId: string, designId: string, runId: string, input: { name: string; expectedAuditId: string; expectedCaseSetSha256: string }, principal: Principal) {
    const published = await this.store.transaction(state => {
      assertOpenVersion(state, projectVersionId); const design = findDesign(state, projectVersionId, designId); const run = findRun(state, projectVersionId, designId, runId); const audit = required(run.coverageAudits.find(item => item.id === input.expectedAuditId && item.status === 'valid'), 'COVERAGE_AUDIT_STALE', '覆盖审计不存在或已失效')
      const publicationBlockers = audit.blockers.filter(item => item.resolution !== 'execution_handoff')
      if (publicationBlockers.length) throw new TestDesignError('TEST_CASE_SET_PUBLICATION_BLOCKED', '存在发布阻断项', 409, { blockers: publicationBlockers })
      if (audit.caseSetSha256 !== input.expectedCaseSetSha256) throw new TestDesignError('TEST_CASE_SET_HASH_MISMATCH', '用例集合 Hash 与审计不一致', 409)
      const currentAudit = runCoverageAudit(run)
      if (currentAudit.inputSha256 !== audit.inputSha256 || currentAudit.caseSetSha256 !== audit.caseSetSha256) throw new TestDesignError('COVERAGE_AUDIT_STALE', '当前用例、数据、依据或处置状态与审计不一致', 409)
      const currentPublicationBlockers = currentAudit.blockers.filter(item => item.resolution !== 'execution_handoff')
      if (currentPublicationBlockers.length) throw new TestDesignError('TEST_CASE_SET_PUBLICATION_BLOCKED', '当前状态仍存在发布阻断项', 409, { blockers: currentPublicationBlockers })
      const dataSet = required(run.dataSetVersions.at(-1), 'TEST_CASE_NOT_READY', '数据需求版本不存在')
      const members = run.testCases.filter(item => !item.tombstonedAt).map((testCase, ordinal) => { const revision = currentCaseRevision(testCase); if (testCase.reviewState !== 'approved') throw new TestDesignError('TEST_CASE_REVIEW_REQUIRED', `用例 ${testCase.id} 未批准`, 409); return { caseId: testCase.id, revision: revision.revision, ordinal, contentSha256: revision.contentSha256 } })
      const canonicalContent = { schemaVersion: 'test-case-set/v1', projectVersionId, testDesignId: designId, runId, requirementReleaseId: run.basisSnapshot.requirementReleaseId, dataSetVersion: { id: dataSet.id, sha256: dataSet.contentSha256 }, coverageAudit: { id: audit.id, inputSha256: audit.inputSha256 }, cases: members.map(member => ({ ...member, content: currentCaseRevision(findCase(run, member.caseId)).content })) }
      const contentSha256 = canonicalSha256(canonicalContent); const aggregate = designState(state); const existing = aggregate.caseSetVersions.find(item => item.testDesignId === designId && item.contentSha256 === contentSha256); if (existing) return structuredClone(existing)
      const version: TestCaseSetVersion = { id: `test_case_set_${randomUUID()}`, projectId: design.projectId, projectVersionId, testDesignId: designId, runId, version: Math.max(0, ...aggregate.caseSetVersions.filter(item => item.testDesignId === designId).map(item => item.version)) + 1, schemaVersion: 'test-case-set/v1', name: cleanRequired(input.name, '用例集名称', 200), dataSetVersionId: dataSet.id, coverageAuditId: audit.id, members, canonicalContent, contentSha256, publishedBy: principal.subjectId, publishedAt: now(), projection: { status: 'pending', files: [] } }
      aggregate.caseSetVersions.push(version); return structuredClone(version)
    })
    if (published.projection.status === 'pending' && published.projection.files.length === 0) await this.projectCaseSet(published.id, 'upload')
    return this.getCaseSet(published.id)
  }

  async getCaseSet(versionId: string) { const state = await this.store.snapshot(); return structuredClone(required(readDesignState(state).caseSetVersions.find(item => item.id === versionId), 'TEST_CASE_SET_NOT_FOUND', '用例集版本不存在')) }
  async retryCaseSetProjection(versionId: string) { const version = await this.getCaseSet(versionId); if (!this.projector) throw new TestDesignError('TEST_CASE_ASSET_PROJECTION_UNAVAILABLE', '知识资产投影服务不可用', 503); if (version.projection.status !== 'failed') return version; await this.projectCaseSet(versionId, 'retry'); return this.getCaseSet(versionId) }
  async exportCaseSet(versionId: string, format: 'json' | 'markdown' | 'xlsx') { const version = await this.getCaseSet(versionId); if (format === 'json') return { contentType: 'application/json; charset=utf-8', fileName: `${version.id}.json`, content: `${canonicalJson(version.canonicalContent)}\n` }; if (format === 'markdown') return { contentType: 'text/markdown; charset=utf-8', fileName: `${version.id}.md`, content: markdownCaseSet(version) }; return { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName: `${version.id}.xlsx`, content: await xlsxCaseSet(version) } }

  async projectCatalog(projectId: string, filters: { domain?: string; executionMethod?: string; suiteVersionId?: string } = {}) {
    const state = await this.store.snapshot(); const aggregate = readDesignState(state); const suite = filters.suiteVersionId ? aggregate.suiteVersions.find(item => item.id === filters.suiteVersionId && item.projectId === projectId) : undefined
    const allowed = suite ? new Set(suite.members.map(item => `${item.testCaseSetVersionId}:${item.caseId}:${item.revision}`)) : null
    const items = aggregate.caseSetVersions.filter(item => item.projectId === projectId).flatMap(version => { const run = aggregate.runs.find(item => item.id === version.runId); if (!run) return []; return version.members.flatMap(member => { if (allowed && !allowed.has(`${version.id}:${member.caseId}:${member.revision}`)) return []; const testCase = run.testCases.find(item => item.id === member.caseId); const revision = testCase?.revisions.find(item => item.revision === member.revision); if (!revision || (filters.domain && revision.content.domain !== filters.domain) || (filters.executionMethod && !revision.content.executionMethods.some(method => method.method === filters.executionMethod))) return []; return [{ testCaseSetVersionId: version.id, testCaseSetName: version.name, caseId: member.caseId, revision: member.revision, content: revision.content, publishedAt: version.publishedAt, contentSha256: member.contentSha256 }] }) })
    return { items, catalogAsOf: now() }
  }

  async listSuites(projectId: string, suiteType?: string) { const state = await this.store.snapshot(); return structuredClone(readDesignState(state).suiteVersions.filter(item => item.projectId === projectId && (!suiteType || item.suiteType === suiteType)).sort(newest)) }
  async getSuite(projectId: string, suiteVersionId: string) { const state = await this.store.snapshot(); return structuredClone(required(readDesignState(state).suiteVersions.find(item => item.id === suiteVersionId && item.projectId === projectId), 'TEST_SUITE_VERSION_NOT_FOUND', '测试套件版本不存在')) }

  async listSuiteDrafts(projectId: string) { const state = await this.store.snapshot(); return structuredClone(readDesignState(state).suiteDrafts.filter(item => item.projectId === projectId).sort(newest)) }
  async getSuiteDraft(projectId: string, draftId: string) { const state = await this.store.snapshot(); const draft = required(readDesignState(state).suiteDrafts.find(item => item.id === draftId && item.projectId === projectId), 'TEST_SUITE_DRAFT_NOT_FOUND', '测试套件草稿不存在'); return { ...structuredClone(draft), etag: suiteDraftEtag(draft) } }

  async createSuiteDraft(projectId: string, raw: unknown, principal: Principal) {
    const input = suiteDraftInput(raw)
    return this.store.transaction(state => { assertProjectExists(state, projectId); const aggregate = designState(state); const members = validateSuiteMembers(aggregate, projectId, input.testCaseLibraryVersionId, input.members); const createdAt = now(); const base = { projectId, suiteKey: input.suiteKey, suiteType: input.suiteType, name: input.name, testCaseLibraryVersionId: input.testCaseLibraryVersionId, compatibilityStatus: 'compatible' as const, members }; const draft: TestSuiteDraft = { id: `test_suite_draft_${randomUUID()}`, ...base, contentSha256: canonicalSha256(base), status: 'draft', createdBy: principal.subjectId, createdAt, updatedBy: principal.subjectId, updatedAt: createdAt }; aggregate.suiteDrafts.push(draft); return { ...structuredClone(draft), etag: suiteDraftEtag(draft) } })
  }

  async updateSuiteDraft(projectId: string, draftId: string, ifMatch: string | undefined, raw: unknown, principal: Principal) {
    const input = suiteDraftInput(raw)
    return this.store.transaction(state => { const aggregate = designState(state); const draft = required(aggregate.suiteDrafts.find(item => item.id === draftId && item.projectId === projectId), 'TEST_SUITE_DRAFT_NOT_FOUND', '测试套件草稿不存在'); assertEtag(ifMatch, suiteDraftEtag(draft), 'TEST_SUITE_DRAFT_CONFLICT'); if (draft.status !== 'draft') throw new TestDesignError('TEST_SUITE_DRAFT_IMMUTABLE', '已发布的套件草稿不可修改', 409); const changingVersion = Boolean(draft.testCaseLibraryVersionId && draft.testCaseLibraryVersionId !== input.testCaseLibraryVersionId); const retainsOldMembers = input.members.some(member => draft.members.some(current => current.caseId === member.caseId)); if (changingVersion && retainsOldMembers && !input.confirmLibraryVersionChange) throw new TestDesignError('TEST_SUITE_LIBRARY_VERSION_CHANGE_CONFIRMATION_REQUIRED', '更换用例库版本时必须清空成员，或明确确认成员迁移', 409); const members = validateSuiteMembers(aggregate, projectId, input.testCaseLibraryVersionId, input.members); const base = { projectId, suiteKey: input.suiteKey, suiteType: input.suiteType, name: input.name, testCaseLibraryVersionId: input.testCaseLibraryVersionId, compatibilityStatus: 'compatible' as const, members }; Object.assign(draft, { ...base, incompatibilityReason: undefined, contentSha256: canonicalSha256(base), updatedBy: principal.subjectId, updatedAt: now() }); return { ...structuredClone(draft), etag: suiteDraftEtag(draft) } })
  }

  async publishSuiteDraft(projectId: string, draftId: string, ifMatch: string | undefined, principal: Principal) {
    return this.store.transaction(state => { const aggregate = designState(state); const draft = required(aggregate.suiteDrafts.find(item => item.id === draftId && item.projectId === projectId), 'TEST_SUITE_DRAFT_NOT_FOUND', '测试套件草稿不存在'); assertEtag(ifMatch, suiteDraftEtag(draft), 'TEST_SUITE_DRAFT_CONFLICT'); if (draft.status !== 'draft') throw new TestDesignError('TEST_SUITE_DRAFT_IMMUTABLE', '套件草稿已发布', 409); if (!draft.members.length) throw new TestDesignError('TEST_SUITE_MEMBER_REQUIRED', '测试套件至少包含一条正式用例', 422); if (!draft.testCaseLibraryVersionId || draft.compatibilityStatus === 'migration_required' || draft.members.some(member => member.testCaseLibraryVersionId !== draft.testCaseLibraryVersionId)) throw new TestDesignError('TEST_SUITE_LIBRARY_VERSION_INCOMPATIBLE', '测试套件未固定唯一正式用例库版本，需要人工迁移', 409); const version: TestSuiteVersion = { id: `test_suite_version_${randomUUID()}`, projectId, suiteKey: draft.suiteKey, suiteType: draft.suiteType, version: Math.max(0, ...aggregate.suiteVersions.filter(item => item.projectId === projectId && item.suiteKey === draft.suiteKey).map(item => item.version)) + 1, name: draft.name, testCaseLibraryVersionId: draft.testCaseLibraryVersionId, compatibilityStatus: 'compatible', members: structuredClone(draft.members), contentSha256: canonicalSha256({ projectId, suiteKey: draft.suiteKey, suiteType: draft.suiteType, name: draft.name, testCaseLibraryVersionId: draft.testCaseLibraryVersionId, members: draft.members }), publishedBy: principal.subjectId, publishedAt: now(), status: 'active' }; aggregate.suiteVersions.push(version); draft.status = 'published'; draft.publishedVersionId = version.id; draft.updatedBy = principal.subjectId; draft.updatedAt = version.publishedAt; return structuredClone(version) })
  }

  async compareSuiteVersions(projectId: string, fromId: string, toId: string) { const left = await this.getSuite(projectId, fromId); const right = await this.getSuite(projectId, toId); return versionMemberDiff(left.members, right.members) }
  async deprecateSuiteVersion(projectId: string, suiteVersionId: string, principal: Principal) { return this.store.transaction(state => { const suite = required(designState(state).suiteVersions.find(item => item.id === suiteVersionId && item.projectId === projectId), 'TEST_SUITE_VERSION_NOT_FOUND', '测试套件版本不存在'); suite.status = 'deprecated'; suite.deprecatedBy = principal.subjectId; suite.deprecatedAt = now(); return structuredClone(suite) }) }

  async createLibraryHandoff(projectVersionId: string, libraryVersionId: string, input: { mode: 'smoke' | 'regression' | 'full' | 'custom'; suiteVersionId?: string; impactedCaseIds?: string[]; expectedLibrarySha256: string; executionReadinessOverrides?: Array<{ caseId: string; revision: number; method?: TestExecutionMethod; reason: string }> }, principal: Principal) {
    return this.store.transaction(state => {
      assertOpenVersion(state, projectVersionId); const projectVersion = required(state.projectVersions.find(item => item.id === projectVersionId), 'PROJECT_VERSION_NOT_FOUND', '项目版本不存在'); const aggregate = designState(state); const libraryVersion = required(aggregate.libraryVersions.find(item => item.id === libraryVersionId && item.projectId === projectVersion.projectId), 'TEST_CASE_LIBRARY_VERSION_NOT_FOUND', '用例库版本不存在'); if (libraryVersion.contentSha256 !== input.expectedLibrarySha256) throw new TestDesignError('TEST_CASE_LIBRARY_HASH_MISMATCH', '用例库版本 Hash 不一致', 409)
      const detailedLibraryVersion = presentLibraryVersion(aggregate, libraryVersion)
      const expectedSuiteType = input.mode === 'smoke' ? 'smoke' : input.mode === 'regression' ? 'regression' : input.mode === 'custom' ? 'custom' : undefined
      const suite = expectedSuiteType ? required(aggregate.suiteVersions.find(item => item.id === input.suiteVersionId && item.projectId === projectVersion.projectId && item.suiteType === expectedSuiteType && item.status !== 'deprecated'), 'TEST_SUITE_VERSION_NOT_FOUND', `${expectedSuiteType} 套件版本不存在`) : undefined
      if (suite && (suite.compatibilityStatus === 'migration_required' || !suite.testCaseLibraryVersionId || suite.testCaseLibraryVersionId !== libraryVersion.id)) throw new TestDesignError('TEST_EXECUTION_HANDOFF_LIBRARY_VERSION_MISMATCH', '套件版本与选择的正式用例库版本不一致或需要人工迁移', 422)
      if (input.mode === 'full' && input.suiteVersionId) throw new TestDesignError('TEST_EXECUTION_HANDOFF_SUITE_FORBIDDEN', 'Full Handoff 不使用测试套件', 422)
      const libraryMembers = new Map(detailedLibraryVersion.members.map(item => [item.caseId, item]))
      const selections = input.mode === 'full'
        ? detailedLibraryVersion.members.map(item => ({ ...item, executionMethods: executionMethodsForContent(item.frozenContent), reason: '指定用例库版本的全部冻结用例' }))
        : suite!.members.map(item => { if (item.testCaseLibraryVersionId !== libraryVersion.id) throw new TestDesignError('TEST_EXECUTION_HANDOFF_LIBRARY_VERSION_MISMATCH', '套件成员不属于指定用例库版本', 422); const libraryMember = required(libraryMembers.get(item.caseId), 'TEST_SUITE_MEMBER_NOT_FOUND', '套件成员不属于指定用例库版本'); if (item.revision !== libraryMember.revision) throw new TestDesignError('TEST_EXECUTION_HANDOFF_LIBRARY_VERSION_MISMATCH', '套件成员 Revision 与用例库版本冻结 Revision 不一致', 422, { caseId: item.caseId, suiteRevision: item.revision, libraryRevision: libraryMember.revision }); const methods = suiteMemberExecutionMethods(item, libraryMember.frozenContent); return { ...libraryMember, executionMethods: methods, reason: item.reason } })
      if (input.mode === 'regression') for (const caseId of [...new Set(input.impactedCaseIds ?? [])]) { const member = required(libraryMembers.get(caseId), 'TEST_CASE_LIBRARY_MEMBER_NOT_FOUND', '变更影响用例不属于指定用例库版本'); if (!selections.some(item => item.caseId === caseId)) selections.push({ ...member, executionMethods: executionMethodsForContent(member.frozenContent), reason: '需求变更影响分析补充' }) }
      if (input.executionReadinessOverrides !== undefined && !Array.isArray(input.executionReadinessOverrides)) throw new TestDesignError('TEST_EXECUTION_CASE_NOT_READY', 'executionReadinessOverrides 必须是数组', 422)
      const overrides = new Map<string, { reason: string; actorId: string; createdAt: string }>()
      for (const [index, override] of (input.executionReadinessOverrides ?? []).entries()) {
        if (!override || typeof override !== 'object' || !Number.isInteger(override.revision) || override.revision < 1) throw new TestDesignError('TEST_EXECUTION_CASE_NOT_READY', `executionReadinessOverrides[${index}] 无效`, 422)
        const caseId = cleanRequired(override.caseId, `executionReadinessOverrides[${index}].caseId`, 500)
        const method = override.method === undefined ? undefined : testExecutionMethod(override.method, `executionReadinessOverrides[${index}].method`)
        const key = `${caseId}:${override.revision}:${method ?? ''}`
        if (overrides.has(key)) throw new TestDesignError('TEST_EXECUTION_CASE_NOT_READY', '同一 Case Revision / 执行方式的人工覆盖决定不得重复', 422, { caseId, revision: override.revision, method })
        overrides.set(key, { reason: cleanRequired(override.reason, `executionReadinessOverrides[${index}].reason`, 2_000), actorId: principal.subjectId, createdAt: now() })
      }
      const usedOverrides = new Set<string>()
      const members = selections.flatMap(selection => {
        const content = required(selection.frozenContent, 'TEST_EXECUTION_CASE_NOT_READY', '正式用例库版本缺少冻结内容')
        const reason = cleanRequired(selection.reason, '选择原因', 2_000)
        return selection.executionMethods.map(method => {
          const available = executionMethodsForContent(content)
          if (!available.includes(method)) throw new TestDesignError('TEST_SUITE_EXECUTION_METHOD_INVALID', '套件执行方式不属于冻结 Revision 的 executionMethods', 422, { caseId: selection.caseId, revision: selection.revision, method })
          const executionSpec = executionSpecForMethod(content, method)
          const configuration = executionConfigurationForMethod(content, method)
          const exactOverrideKey = `${selection.caseId}:${selection.revision}:${method}`
          const legacyOverrideKey = `${selection.caseId}:${selection.revision}:`
          const readinessOverride = overrides.get(exactOverrideKey) ?? (selection.executionMethods.length === 1 ? overrides.get(legacyOverrideKey) : undefined)
          if (configuration.status === 'blocked') throw new TestDesignError('TEST_EXECUTION_CASE_BLOCKED', 'blocked 执行方式禁止进入 Execution Handoff，人工覆盖不能绕过', 422, { caseId: selection.caseId, revision: selection.revision, method, issues: configuration.issues })
          if (configuration.status === 'needs_confirmation' && !readinessOverride) throw new TestDesignError('TEST_EXECUTION_READINESS_OVERRIDE_REQUIRED', 'needs_confirmation 执行方式需要明确的人工覆盖决定和原因', 422, { caseId: selection.caseId, revision: selection.revision, method, issues: configuration.issues })
          if (readinessOverride) usedOverrides.add(overrides.has(exactOverrideKey) ? exactOverrideKey : legacyOverrideKey)
          return { stage: input.mode, ordinal: 0, sourceVersionId: suite?.id ?? libraryVersion.id, caseId: selection.caseId, revision: selection.revision, method, reason, dedupKey: `${selection.caseId}:${selection.revision}:${method}`, dimension: content.dimension, executionSpec, ...(selection.traceability ? { traceability: structuredClone(selection.traceability) } : {}), selectionReason: reason, contentSha256: selection.contentSha256, ...(readinessOverride ? { readinessOverride } : {}) }
        })
      })
      const handoffDedupKeys = new Set<string>()
      const duplicate = members.find(member => handoffDedupKeys.has(member.dedupKey) || !handoffDedupKeys.add(member.dedupKey))
      if (duplicate) throw new TestDesignError('TEST_EXECUTION_HANDOFF_MEMBER_DUPLICATE', 'Execution Handoff 的 Case Revision / 执行方式组合不能重复', 422, { caseId: duplicate.caseId, revision: duplicate.revision, method: duplicate.method, dedupKey: duplicate.dedupKey })
      members.forEach((member, ordinal) => { member.ordinal = ordinal })
      const unusedOverrides = [...overrides.keys()].filter(key => !usedOverrides.has(key))
      if (unusedOverrides.length) throw new TestDesignError('TEST_EXECUTION_CASE_NOT_READY', '人工覆盖只能引用本次选择中 needs_confirmation 的冻结 Case Revision', 422, { overrides: unusedOverrides })
      const testDataSnapshot = freezeHandoffDataRequirementSnapshot(aggregate, libraryVersion, selections)
      const canonicalContent = { projectId: projectVersion.projectId, projectVersionId, testCaseLibraryVersionId: libraryVersion.id, ...(suite ? { suiteVersionId: suite.id } : {}), mode: input.mode, members, ...(testDataSnapshot ? { testDataSnapshot } : {}) }
      const contentSha256 = canonicalSha256(canonicalContent); const existing = aggregate.executionHandoffs.find(item => item.projectVersionId === projectVersionId && item.mode === input.mode && item.contentSha256 === contentSha256); if (existing) return structuredClone(existing)
      const handoff: TestExecutionHandoff = { id: `test_execution_handoff_${randomUUID()}`, ...canonicalContent, contentSha256, createdBy: principal.subjectId, createdAt: now() }; aggregate.executionHandoffs.push(handoff); return structuredClone(handoff)
    })
  }

  async listLibraryHandoffs(projectVersionId: string, libraryVersionId?: string) {
    const state = await this.store.snapshot()
    const projectVersion = required(state.projectVersions.find(item => item.id === projectVersionId), 'PROJECT_VERSION_NOT_FOUND', '项目版本不存在')
    return structuredClone(readDesignState(state).executionHandoffs
      .filter(item => item.projectId === projectVersion.projectId && item.projectVersionId === projectVersionId && Boolean(item.testCaseLibraryVersionId) && (!libraryVersionId || item.testCaseLibraryVersionId === libraryVersionId))
      .sort(newest))
  }

  async reviewSmokeCandidate(versionId: string, caseId: string, input: { executionMethods: Array<'ui' | 'api'>; reason: string; estimatedMinutes: number; stable: boolean; dependencyReady: boolean; decision: 'accepted' | 'rejected' }, principal: Principal) {
    return this.store.transaction(state => { const aggregate = designState(state); const version = required(aggregate.caseSetVersions.find(item => item.id === versionId), 'TEST_CASE_SET_NOT_FOUND', '用例集版本不存在'); assertOpenVersion(state, version.projectVersionId); const run = required(aggregate.runs.find(item => item.id === version.runId), 'TEST_DESIGN_RUN_NOT_FOUND', '运行不存在'); assertMethodSubset(run, caseId, input.executionMethods); const relation: SmokeCandidateRelation = { testCaseSetVersionId: versionId, caseId, executionMethods: input.executionMethods, reason: cleanRequired(input.reason, '候选理由', 2_000), estimatedMinutes: positive(input.estimatedMinutes, 'estimatedMinutes'), stable: input.stable === true, dependencyReady: input.dependencyReady === true, decision: input.decision, actorId: principal.subjectId, reviewedAt: now() }; run.smokeCandidates = [...run.smokeCandidates.filter(item => item.testCaseSetVersionId !== versionId || item.caseId !== caseId), relation]; return structuredClone(relation) })
  }

  async setImpactedRegression(versionId: string, values: Array<{ suiteVersionId: string; caseId: string; executionMethods: Array<'ui' | 'api'>; reason: string }>, principal: Principal) {
    return this.store.transaction(state => { const aggregate = designState(state); const version = required(aggregate.caseSetVersions.find(item => item.id === versionId), 'TEST_CASE_SET_NOT_FOUND', '用例集版本不存在'); assertOpenVersion(state, version.projectVersionId); const references: ImpactedRegressionReference[] = values.map(value => { const suite = required(aggregate.suiteVersions.find(item => item.id === value.suiteVersionId && item.projectId === version.projectId && item.suiteType === 'regression'), 'TEST_SUITE_VERSION_NOT_FOUND', '回归套件版本不存在'); const member = required(suite.members.find(item => item.caseId === value.caseId), 'TEST_SUITE_MEMBER_NOT_FOUND', '回归套件成员不存在'); const memberMethods = member.executionMethods ?? (member.executionMethod === 'ui' || member.executionMethod === 'api' ? [member.executionMethod] : []); if (!value.executionMethods.length || value.executionMethods.some(method => !memberMethods.includes(method))) throw new TestDesignError('TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', '影响回归执行方式必须是套件成员方式的非空子集', 422); return { ...value, testCaseSetVersionId: versionId, reason: cleanRequired(value.reason, '影响理由', 2_000), actorId: principal.subjectId, createdAt: now() } }); const run = required(aggregate.runs.find(item => item.id === version.runId), 'TEST_DESIGN_RUN_NOT_FOUND', '运行不存在'); run.impactedRegression = [...run.impactedRegression.filter(item => item.testCaseSetVersionId !== versionId), ...references]; return structuredClone(references) })
  }

  async createHandoff(versionId: string, input: { strategy: 'standard' | 'fast' | 'full'; smokeSuiteVersionId?: string; regressionSuiteVersionId?: string; expectedCaseSetSha256: string }, principal: Principal) {
    return this.store.transaction(state => {
      const aggregate = designState(state); const version = required(aggregate.caseSetVersions.find(item => item.id === versionId), 'TEST_CASE_SET_NOT_FOUND', '用例集版本不存在'); assertOpenVersion(state, version.projectVersionId); if (version.contentSha256 !== input.expectedCaseSetSha256) throw new TestDesignError('TEST_CASE_SET_HASH_MISMATCH', '用例集 Hash 已变化', 409)
      const run = required(aggregate.runs.find(item => item.id === version.runId), 'TEST_DESIGN_RUN_NOT_FOUND', '运行不存在'); const smoke = input.smokeSuiteVersionId ? required(aggregate.suiteVersions.find(item => item.id === input.smokeSuiteVersionId && item.projectId === version.projectId && item.suiteType === 'smoke'), 'TEST_SUITE_VERSION_NOT_FOUND', '冒烟套件版本不存在') : undefined; const regression = input.regressionSuiteVersionId ? required(aggregate.suiteVersions.find(item => item.id === input.regressionSuiteVersionId && item.projectId === version.projectId && item.suiteType === 'regression'), 'TEST_SUITE_VERSION_NOT_FOUND', '回归套件版本不存在') : undefined
      if (input.strategy !== 'full' && (!smoke || !regression)) throw new TestDesignError('TEST_EXECUTION_HANDOFF_BASELINE_REQUIRED', '标准或快速交接必须固定冒烟和回归套件版本', 422)
      if (input.strategy === 'full' && !regression) throw new TestDesignError('TEST_EXECUTION_HANDOFF_BASELINE_REQUIRED', '直接全量交接必须固定回归套件版本', 422)
      const members: TestExecutionHandoff['members'] = []; const add = (stage: TestExecutionHandoff['members'][number]['stage'], sourceVersionId: string, caseId: string, revision: number, methods: Array<'ui' | 'api'>, reason: string) => methods.forEach(method => { const dedupKey = `${caseId}:${revision}:${method}`; if (!members.some(item => item.dedupKey === dedupKey)) members.push({ stage, ordinal: members.length, sourceVersionId, caseId, revision, method, reason, dedupKey }) })
      if (input.strategy !== 'full') {
        smoke!.members.forEach(item => add('smoke', smoke!.id, item.caseId, item.revision, legacySuiteMemberUiApiMethods(item), item.reason))
        run.smokeCandidates.filter(item => item.testCaseSetVersionId === version.id && item.decision === 'accepted').forEach(item => {
          if (!item.stable || !item.dependencyReady) throw new TestDesignError('TEST_EXECUTION_HANDOFF_SMOKE_CANDIDATE_NOT_READY', `冒烟候选 ${item.caseId} 尚未满足稳定性或依赖条件`, 422)
          const member = required(version.members.find(candidate => candidate.caseId === item.caseId), 'TEST_CASE_SET_MEMBER_NOT_FOUND', '冒烟候选不属于当前功能集')
          add('smoke', version.id, item.caseId, member.revision, item.executionMethods, item.reason)
        })
      }
      if (input.strategy !== 'full') version.members.forEach(item => { const testCase = findCase(run, item.caseId); add('new_feature', version.id, item.caseId, item.revision, currentCaseRevision(testCase).content.executionMethods.map(method => method.method), '本次新功能用例') })
      if (input.strategy !== 'full') run.impactedRegression.filter(item => item.testCaseSetVersionId === version.id).forEach(item => { if (item.suiteVersionId !== regression!.id) throw new TestDesignError('TEST_EXECUTION_HANDOFF_REGRESSION_VERSION_MISMATCH', '影响回归引用与固定回归套件版本不一致', 422); const member = required(regression!.members.find(candidate => candidate.caseId === item.caseId), 'TEST_SUITE_MEMBER_NOT_FOUND', '影响回归套件成员不存在'); add('impacted_regression', regression!.id, item.caseId, member.revision, item.executionMethods, item.reason) })
      if (input.strategy !== 'fast') regression!.members.forEach(item => add('full_regression', regression!.id, item.caseId, item.revision, legacySuiteMemberUiApiMethods(item), item.reason))
      const canonicalContent = { projectId: version.projectId, projectVersionId: version.projectVersionId, testCaseSetVersionId: version.id, strategy: input.strategy, ...(smoke ? { smokeSuiteVersionId: smoke.id } : {}), regressionSuiteVersionId: regression!.id, members }
      const contentSha256 = canonicalSha256(canonicalContent)
      const existing = aggregate.executionHandoffs.find(item => item.projectVersionId === version.projectVersionId && item.strategy === input.strategy && item.contentSha256 === contentSha256)
      if (existing) return structuredClone(existing)
      const handoff: TestExecutionHandoff = { id: `test_execution_handoff_${randomUUID()}`, ...canonicalContent, contentSha256, createdBy: principal.subjectId, createdAt: now() }; aggregate.executionHandoffs.push(handoff); return structuredClone(handoff)
    })
  }

  async listHandoffs(versionId: string) { const state = await this.store.snapshot(); return structuredClone(readDesignState(state).executionHandoffs.filter(item => item.testCaseSetVersionId === versionId).sort(newest)) }
  async getHandoff(handoffId: string) { const state = await this.store.snapshot(); return structuredClone(required(readDesignState(state).executionHandoffs.find(item => item.id === handoffId), 'TEST_EXECUTION_HANDOFF_NOT_FOUND', '执行交接不存在')) }
  async smokeCandidates(versionId: string) { const state = await this.store.snapshot(); const aggregate = readDesignState(state); const version = required(aggregate.caseSetVersions.find(item => item.id === versionId), 'TEST_CASE_SET_NOT_FOUND', '用例集版本不存在'); return structuredClone(required(aggregate.runs.find(item => item.id === version.runId), 'TEST_DESIGN_RUN_NOT_FOUND', '运行不存在').smokeCandidates.filter(item => !item.testCaseSetVersionId || item.testCaseSetVersionId === versionId)) }
  async impactedRegression(versionId: string) { const state = await this.store.snapshot(); const aggregate = readDesignState(state); const version = required(aggregate.caseSetVersions.find(item => item.id === versionId), 'TEST_CASE_SET_NOT_FOUND', '用例集版本不存在'); return structuredClone(required(aggregate.runs.find(item => item.id === version.runId), 'TEST_DESIGN_RUN_NOT_FOUND', '运行不存在').impactedRegression.filter(item => !item.testCaseSetVersionId || item.testCaseSetVersionId === versionId)) }

  private async executeNode(runId: string, key: 'test_case_design' | 'test_design_repair', signal: AbortSignal, upstream: unknown) {
    await this.store.transaction(state => { const run = findRunById(state, runId); const target = node(run, key); Object.assign(target, { status: 'running', attempt: target.attempt + 1, startedAt: now(), finishedAt: undefined, error: undefined, errorCode: undefined, execution: undefined }); Object.assign(run, { status: 'running', stage: key, startedAt: run.startedAt ?? now(), finishedAt: undefined, error: undefined, errorCode: undefined }); if (key === 'test_design_repair' && run.automaticRepair?.status === 'queued') Object.assign(run.automaticRepair, { status: 'running', startedAt: now(), finishedAt: undefined }) })
    const run = await this.loadRun(runId)
    const nodeRunId = node(run, key).id
    const events: AgentExecutionEvent[] = []
    return this.runtime!.execute({
      stage: key,
      run,
      upstream,
      onExecutionEvent: async event => {
        events.push(event)
        if (shouldCheckpointTestDesignExecution(event)) await this.saveNodeExecutionProgress(runId, nodeRunId, key, events)
      },
    }, signal)
  }
  private async saveNodeExecutionProgress(runId: string, nodeRunId: string, key: 'test_case_design' | 'test_design_repair', events: AgentExecutionEvent[], lease?: TaskLease) {
    const persist = (state: DatabaseState) => {
      const run = readDesignState(state).runs.find(item => item.id === runId)
      const target = run?.nodeRuns.find(item => item.id === nodeRunId && item.nodeKey === key)
      if (!run || !target || target.status !== 'running') return
      target.execution = testDesignExecutionProgress(run, key, events)
    }
    if (lease) await this.fencedNodeTransaction(nodeRunId, lease, persist)
    else await this.store.transaction(persist)
  }
  private startLocally(runId: string) { if (this.activeRuns.has(runId)) return; const controller = new AbortController(); this.activeRuns.set(runId, controller); void this.processPreparedRun(runId, controller.signal).catch(() => undefined).finally(() => this.activeRuns.delete(runId)) }
  private async schedule(runId: string) { if (!this.store.enqueueTestDesignJob) { this.startLocally(runId); return } const run = await this.loadRun(runId); const targets = run.nodeRuns.filter(item => item.status === 'queued'); await Promise.all(targets.map(async target => { const createdAt = now(); await this.store.enqueueTestDesignJob!({ id: `workflow_job_${randomUUID()}`, runId, nodeRunId: target.id, status: 'queued', attempts: 0, maxAttempts: 3, availableAt: createdAt, createdAt, updatedAt: createdAt }) })) }
  private async fencedNodeTransaction<T>(nodeRunId: string, lease: TaskLease, operation: (draft: DatabaseState) => T | Promise<T>) { if (!this.store.transactionWithTestDesignLease) throw new TestDesignError('WORKFLOW_JOB_LEASE_LOST', '当前 Store 不支持测试设计节点租约', 503); const result = await this.store.transactionWithTestDesignLease(nodeRunId, lease, operation); if (result === null) throw new TestDesignError('WORKFLOW_JOB_LEASE_LOST', '测试设计节点租约已失效', 409); return result }
  private async loadRun(runId: string) { const state = await this.store.snapshot(); return structuredClone(findRunById(state, runId)) }
  private async loadScopedRun(projectVersionId: string, designId: string, runId: string) { const state = await this.store.snapshot(); return structuredClone(findRun(state, projectVersionId, designId, runId)) }
  private async projectCaseSet(versionId: string, trigger: 'upload' | 'retry') {
    if (!this.projector) throw new TestDesignError('TEST_DESIGN_WORKSPACE_PROJECTION_UNAVAILABLE', '用例集必须投影到正式 AssetVersion，但资产服务不可用', 503)
    const state = await this.store.snapshot()
    const version = required(readDesignState(state).caseSetVersions.find(item => item.id === versionId), 'TEST_CASE_SET_NOT_FOUND', '用例集版本不存在')
    const projectVersion = required(state.projectVersions.find(item => item.id === version.projectVersionId), 'PROJECT_VERSION_NOT_FOUND', '项目版本不存在')
    const run = required(readDesignState(state).runs.find(item => item.id === version.runId), 'TEST_DESIGN_RUN_NOT_FOUND', '测试设计运行不存在')
    const dataSet = required(run.dataSetVersions.find(item => item.id === version.dataSetVersionId), 'TEST_DATA_REQUIREMENT_SET_NOT_FOUND', '测试数据版本不存在')
    const base = required(state.knowledgeBases.find(item => item.projectId === version.projectId), 'TEST_DESIGN_WORKSPACE_PROJECTION_UNAVAILABLE', '项目知识库不存在')
    const files = testCaseProjectionFiles(projectVersion.name, version, dataSet)
    try {
      const projected = await this.projectWorkspaceFiles(base.id, `test-case-set:${version.id}`, 'test_case', files, trigger)
      await this.store.transaction(draft => {
        const aggregate = designState(draft)
        const target = required(aggregate.caseSetVersions.find(item => item.id === versionId), 'TEST_CASE_SET_NOT_FOUND', '用例集版本不存在')
        target.projection = { status: projected.some(item => item.pending) ? 'pending' : 'succeeded', files: projected.map(item => ({ logicalPath: item.file.logicalPath, contentSha256: item.file.contentSha256, assetVersionId: item.assetVersionId })) }
        const currentRun = required(aggregate.runs.find(item => item.id === target.runId), 'TEST_DESIGN_RUN_NOT_FOUND', '测试设计运行不存在')
        const paths = new Set(projected.map(item => item.file.logicalPath))
        currentRun.formalWorkspaceFiles = [...currentRun.formalWorkspaceFiles.filter(item => !paths.has(item.logicalPath)), ...projected.map(item => ({ ...item.file, sourceType: 'test_case_set_version' as const, sourceId: target.id, assetVersionId: item.assetVersionId }))]
      })
    } catch (error) {
      await this.store.transaction(draft => { const target = required(designState(draft).caseSetVersions.find(item => item.id === versionId), 'TEST_CASE_SET_NOT_FOUND', '用例集版本不存在'); target.projection = { status: 'failed', files: [], error: String(error instanceof Error ? error.message : error).slice(0, 2_000) } })
      throw error
    }
  }

  private async projectLibraryVersion(versionId: string) {
    if (!this.projector) throw new TestDesignError('TEST_DESIGN_WORKSPACE_PROJECTION_UNAVAILABLE', '正式用例库必须投影到 Workspace AssetVersion，但资产服务不可用', 503)
    const state = await this.store.snapshot(); const aggregate = readDesignState(state); const version = required(aggregate.libraryVersions.find(item => item.id === versionId), 'TEST_CASE_LIBRARY_VERSION_NOT_FOUND', '用例库版本不存在'); const sourceRun = version.sourceRunId ? aggregate.runs.find(item => item.id === version.sourceRunId) : undefined; const projectVersion = required(sourceRun ? state.projectVersions.find(item => item.id === sourceRun.projectVersionId) : state.projectVersions.filter(item => item.projectId === version.projectId).sort(newest)[0], 'PROJECT_VERSION_NOT_FOUND', '用例库项目版本不存在'); const base = required(state.knowledgeBases.find(item => item.projectId === version.projectId), 'TEST_DESIGN_WORKSPACE_PROJECTION_UNAVAILABLE', '项目知识库不存在'); const files = libraryProjectionFiles(projectVersion.name, version, aggregate.libraryCases)
    try {
      const projected = await this.projectWorkspaceFiles(base.id, `test-case-library:${version.id}`, 'test_case_library', files, 'upload')
      await this.store.transaction(draft => { const current = designState(draft); const target = required(current.libraryVersions.find(item => item.id === version.id), 'TEST_CASE_LIBRARY_VERSION_NOT_FOUND', '用例库版本不存在'); target.projection = { status: projected.some(item => item.pending) ? 'pending' : 'succeeded', files: projected.map(item => ({ logicalPath: item.file.logicalPath, contentSha256: item.file.contentSha256, assetVersionId: item.assetVersionId })) }; const run = target.sourceRunId ? current.runs.find(item => item.id === target.sourceRunId) : undefined; if (run) { const paths = new Set(projected.map(item => item.file.logicalPath)); run.formalWorkspaceFiles = [...run.formalWorkspaceFiles.filter(item => !paths.has(item.logicalPath)), ...projected.map(item => ({ ...item.file, sourceType: 'test_case_library_version' as const, sourceId: target.id, assetVersionId: item.assetVersionId }))] } })
    } catch (error) {
      await this.store.transaction(draft => { const target = required(designState(draft).libraryVersions.find(item => item.id === version.id), 'TEST_CASE_LIBRARY_VERSION_NOT_FOUND', '用例库版本不存在'); target.projection = { status: 'failed', files: [], error: String(error instanceof Error ? error.message : error).slice(0, 2_000) } })
      throw error
    }
  }

  private async projectWorkspaceFiles(knowledgeBaseId: string, sourcePrefix: string, assetType: string, files: TestDesignWorkspaceFile[], trigger: 'upload' | 'retry') {
    return Promise.all(files.map(async file => {
      const input: WorkspaceArtifactIngestInput = { knowledgeBaseId, sourceType: 'upload', sourceKey: `${sourcePrefix}:${file.logicalPath}:${file.contentSha256}`, assetType, displayName: file.displayName, logicalPath: file.logicalPath, content: file.content, taskTrigger: trigger }
      const ingest = this.projector!.ingestWorkspaceArtifact ?? this.projector!.ingest
      const result = await ingest.call(this.projector, input)
      return { file, assetVersionId: result.version.id, pending: Boolean(result.task) }
    }))
  }
}

function workflowNodes(runId: string): WorkflowNodeRun[] {
  const definition: Array<[TestDesignNodeKey, TestDesignNodeKey[]]> = [
    ['test_case_design', []],
    ['coverage_audit', ['test_case_design']],
    ['test_design_repair', ['coverage_audit']],
  ]
  return definition.map(([nodeKey, dependencies]) => ({ id: `${runId}:${nodeKey}:g1:a0`, nodeKey, generation: 1, attempt: 0, status: nodeKey === 'test_case_design' ? 'queued' : 'pending', dependencies }))
}

function caseDesignInput(run: TestDesignWorkflowRun) {
  return { workspaceSnapshotSha256: run.workspaceSnapshot.snapshotSha256, requirementReleaseId: run.workspaceSnapshot.requirementReleaseId, requirementsJsonSha256: run.workspaceSnapshot.requirementsJsonSha256 }
}

function repairInput(run: TestDesignWorkflowRun) {
  const state = required(run.automaticRepair, 'TEST_DESIGN_REPAIR_NOT_QUEUED', '自动修复状态不存在')
  const audit = required(run.coverageAudits.find(item => item.id === state.triggerAuditId), 'TEST_DESIGN_REPAIR_AUDIT_NOT_FOUND', '触发修复的 Coverage Audit 不存在')
  return { schemaVersion: 'test-design-repair-context/v1', attempt: state.attempt, maxAttempts: state.maxAttempts, auditId: audit.id, blockers: selectedRepairBlockers(audit, state), candidateWorkspacePath: 'workspace/agent_workspace/planning_agent/current-test-cases.json', baseCandidateSha256: canonicalSha256(repairCandidateContent(run)) }
}

/** The stable Service-owned base used for both the repair Workspace and v2 Patch conflict detection. */
export function repairCandidateContent(run: TestDesignWorkflowRun): RepairCandidateSnapshot {
  const activeCases = run.testCases.filter(item => !item.tombstonedAt)
  const refById = new Map(activeCases.map(item => [item.id, item.candidateRef ?? `case-${item.id}`]))
  const proposalByCandidateCaseId = new Map(run.caseChangeProposals.flatMap(item => item.candidateCaseId ? [[item.candidateCaseId, item] as const] : []))
  const dataSet = run.dataSetVersions.at(-1)
  return {
    schemaVersion: 'test-design-repair/v1',
    cases: activeCases.map(testCase => {
      const revision = currentCaseRevision(testCase)
      const proposal = proposalByCandidateCaseId.get(testCase.id)
      return { ref: requiredRepairCaseRef(refById, testCase.id), ...structuredClone(revision.content), dependencies: revision.content.dependencies.map(id => refById.get(id) ?? id), dataRequirementIds: [], ...(proposal ? { changeReason: proposal.reason, confidence: proposal.confidence } : {}) }
    }),
    dimensionAssessments: structuredClone(run.dimensionAssessments ?? []),
    scenarioClaims: structuredClone(run.scenarioClaims ?? []),
    dataRequirements: (dataSet?.requirements ?? []).map((item, index): TestDataRequirementCandidate => ({
      ref: `data-${index + 1}`,
      name: item.name,
      entityType: item.entityType,
      featureTags: [...item.featureTags],
      requirementRefs: [...(item.requirementRefs ?? [])],
      caseRefs: item.caseIds.map(id => requiredRepairCaseRef(refById, id)),
      fieldConstraints: structuredClone(item.fieldConstraints),
      relationships: [...item.relationships],
      quantity: item.quantity,
      initialState: item.initialState,
      preparationHint: item.preparationHint,
      sensitivity: item.sensitivity,
      isolation: item.isolation,
      resetAndCleanup: item.resetAndCleanup,
      readiness: item.readiness,
      ...(item.readinessReason ? { readinessReason: item.readinessReason } : {}),
    })),
    findings: run.findings.map(item => ({ title: item.title, description: item.description, severity: item.severity, basisRefs: [...item.basisRefs] })),
    confirmationItems: run.confirmationItems.filter(item => item.impactStage !== 'handoff').map(item => ({ title: item.title, question: item.question, decisionType: item.decisionType, impactStage: item.impactStage, affectedRefs: [...item.affectedRefs], blocker: item.blocker })),
    proposals: run.caseChangeProposals.map(item => ({ operation: item.operation, ...(item.sourceCaseId ? { sourceCaseId: item.sourceCaseId } : {}), ...(item.sourceRevision !== undefined ? { sourceRevision: item.sourceRevision } : {}), ...(item.candidateCaseId ? { candidateRef: requiredRepairCaseRef(refById, item.candidateCaseId) } : {}), requirementRefs: [...(item.requirementRefs ?? [])], reason: item.reason, confidence: item.confidence })),
  }
}

function completeCandidateSnapshot(value: TestCaseDesignCandidate | RepairCandidateSnapshot) {
  return {
    schemaVersion: 'test-design-candidate-snapshot/v2',
    sourceSchemaVersion: value.schemaVersion,
    cases: value.cases.map(item => 'content' in item ? flatCandidateCase(item) : structuredClone(item)),
    dimensionAssessments: structuredClone(value.dimensionAssessments),
    scenarioClaims: structuredClone(value.scenarioClaims),
    dataRequirements: structuredClone(value.dataRequirements),
    findings: structuredClone(value.findings),
    confirmationItems: structuredClone(value.confirmationItems),
    proposals: structuredClone(value.proposals),
  }
}

function flatCandidateCase(candidate: CandidateCase): RepairCandidateCase { return { ref: candidate.ref, ...structuredClone(candidate.content), ...(candidate.changeReason ? { changeReason: candidate.changeReason } : {}), ...(candidate.confidence === undefined ? {} : { confidence: candidate.confidence }) } }
function requiredRepairCaseRef(refById: Map<string, string>, caseId: string) {
  const ref = refById.get(caseId)
  if (!ref) throw new TestDesignError('TEST_DESIGN_REPAIR_CASE_REFERENCE_INVALID', `自动修复候选引用的用例不存在或已删除：${caseId}`, 409)
  return ref
}

function materializeDesignIssues(run: TestDesignWorkflowRun, raw: unknown) {
  const value = raw && typeof raw === 'object' ? raw as { findings?: unknown[]; confirmationItems?: unknown[] } : {}
  const findings = (Array.isArray(value.findings) ? value.findings : []).slice(0, 500).map((candidate, index) => { const item = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {}; return { id: `test_design_finding_${randomUUID()}`, title: cleanRequired(String(item.title ?? `Finding ${index + 1}`), 'Finding 标题', 500), description: String(item.description ?? '').slice(0, 8_000), severity: ['blocker', 'high', 'medium', 'low'].includes(String(item.severity)) ? item.severity as 'blocker' | 'high' | 'medium' | 'low' : 'medium', basisRefs: Array.isArray(item.basisRefs) ? item.basisRefs.map(String) : [], state: 'open' as const, actions: [] } })
  const confirmations = (Array.isArray(value.confirmationItems) ? value.confirmationItems : []).slice(0, 500).map((candidate, index) => { const item = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {}; return { id: `test_design_confirmation_${randomUUID()}`, title: cleanRequired(String(item.title ?? `待确认项 ${index + 1}`), '待确认项标题', 500), question: String(item.question ?? '').slice(0, 8_000), decisionType: String(item.decisionType ?? 'other').slice(0, 200), impactStage: ['case', 'data', 'publication', 'handoff'].includes(String(item.impactStage)) ? item.impactStage as 'case' | 'data' | 'publication' | 'handoff' : 'publication', affectedRefs: Array.isArray(item.affectedRefs) ? item.affectedRefs.map(String) : [], blocker: item.blocker === true, state: 'open' as const, actions: [] } })
  for (const finding of findings) if (!run.findings.some(item => item.title === finding.title && item.description === finding.description)) run.findings.push(finding)
  for (const confirmation of confirmations) if (!run.confirmationItems.some(item => item.title === confirmation.title && item.question === confirmation.question)) run.confirmationItems.push(confirmation)
}

function buildBasisSnapshot(design: TestDesign, requirement: BoundRequirementRelease, machine: ReturnType<typeof publishedRequirements>, createdAt: string): TestDesignBasisSnapshot {
  const requirementItems = machine.requirements.map((point, index) => ({
    id: `basis_requirement_${requirement.analysisRun.id}_${point.clientRequirementPointId}`,
    kind: 'requirement_release' as const,
    sourceId: `${requirement.analysisRun.id}:${point.clientRequirementPointId}`,
    contentSha256: canonicalSha256(point),
    content: structuredClone(point),
    locator: { coverageTarget: point.coverageTarget !== false, ...(point.coverageRationale ? { coverageRationale: point.coverageRationale } : {}), requirementReleaseId: requirement.release.id, verificationRunId: requirement.analysisRun.id, requirementPointId: point.clientRequirementPointId, ordinal: index, evidenceRefs: point.evidenceRefs },
  }))
  const clarifications = structuredClone(requirement.analysisRun.result?.clarifications ?? [])
  const clarificationItems = clarifications.map(item => ({
    id: `basis_clarification_${item.id}`,
    kind: 'human_clarification' as const,
    sourceId: item.id,
    contentSha256: canonicalSha256(item),
    content: structuredClone(item),
    locator: { coverageTarget: false, requirementReleaseId: requirement.release.id, verificationRunId: requirement.analysisRun.id, clarificationId: item.id, requirementPointRefs: item.requirementPointRefs, answeredAt: item.answeredAt, answeredBy: item.answeredBy },
  }))
  const base = { schemaVersion: 'test-design-basis-snapshot/v2' as const, projectVersionId: design.projectVersionId, requirementReleaseId: requirement.release.id, verificationRunId: requirement.analysisRun.id, requirementsJsonSha256: machine.artifact.contentSha256, items: [...requirementItems, ...clarificationItems], clarifications, createdAt }
  return { ...base, snapshotSha256: canonicalSha256(base) }
}

async function buildRetrievalSnapshot(state: DatabaseState, design: TestDesign, createdAt: string): Promise<RetrievalSnapshot> {
  const augmentation = design.input.knowledgeAugmentation
  const index = augmentation.mode === 'fixed_index' ? required(state.indexes.find(item => item.id === augmentation.indexVersionId && item.status === 'active'), 'TEST_DESIGN_AUGMENTATION_INVALID', '固定索引不存在或未激活') : undefined
  const assetVersionIds = augmentation.mode === 'selected_assets' ? augmentation.assetVersionIds : index?.assetVersionIds ?? []
  assetVersionIds.forEach(id => assetContentRef(state, design.projectId, id, 'knowledge_asset'))
  const queryPlan = augmentation.mode === 'disabled' ? [] : retrievalQueries(design.input)
  const candidates = augmentation.mode === 'disabled' ? [] : assetVersionIds.flatMap(id => retrievalCandidates(state, design.projectId, id, augmentation.mode === 'fixed_index' ? augmentation.filters : undefined))
  const ranked = new Map<string, RetrievalSnapshot['hits'][number]>()
  for (const [queryIndex, plan] of queryPlan.entries()) {
    const tokens = searchTokens(plan.query)
    candidates.map(candidate => ({ candidate, score: retrievalScore(tokens, candidate.content) })).filter(item => item.score > 0).sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id)).slice(0, 8).forEach(({ candidate, score }, rank) => {
      const current = ranked.get(candidate.id)
      const hit = { id: `retrieval_hit_${canonicalSha256(`${candidate.id}:${queryIndex}`).slice(0, 20)}`, assetVersionId: candidate.assetVersionId, chunkId: candidate.chunkId, contentSha256: canonicalSha256(candidate.content), score, rank: rank + 1, locator: candidate.locator, classification: candidate.classification, content: candidate.content }
      if (!current || score > current.score) ranked.set(candidate.id, hit)
    })
  }
  const hits = [...ranked.values()].sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).slice(0, 80).map((hit, index) => ({ ...hit, rank: index + 1 }))
  const base = { canonicalVersion: 'retrieval-snapshot/v1' as const, mode: augmentation.mode, assetVersionIds, ...(index ? { indexVersionId: index.id, ...(augmentation.mode === 'fixed_index' && augmentation.filters ? { filters: augmentation.filters } : {}) } : {}), queryPlan, hits, createdAt }
  return { ...base, snapshotSha256: canonicalSha256(base) }
}
function buildHistoricalSnapshot(state: DatabaseState, design: TestDesign, createdAt: string): HistoricalCaseSnapshot {
  const aggregate = readDesignState(state)
  const projectVersion = required(state.projectVersions.find(item => item.id === design.projectVersionId), 'PROJECT_VERSION_NOT_FOUND', '项目版本不存在')
  const inheritedSource = explicitlyInheritedSourceVersion(state, projectVersion)
  const eligibleLibraryVersions = inheritedSource ? inheritedLibraryVersionsForSource(aggregate, inheritedSource.id) : []
  const eligibleLibraryVersionIds = new Set(eligibleLibraryVersions.map(item => item.id))
  const items: HistoricalCaseSnapshot['items'] = []
  const selection = design.input.historicalLibrarySelection ?? { mode: 'none' as const }
  let libraryVersion: TestCaseLibraryVersion | undefined
  let memberFilter: Set<string> | undefined
  let kind: 'test_case_library' | 'historical_test_suite' = 'test_case_library'
  if (selection.mode !== 'none' && !inheritedSource) throw new TestDesignError('TEST_DESIGN_SOURCE_INHERITANCE_REQUIRED', '当前版本未明确继承来源版本，不能加载历史测试资产', 422)
  if (selection.mode === 'latest_library') libraryVersion = eligibleLibraryVersions.sort((left, right) => right.version - left.version)[0]
  if (selection.mode === 'library_version') libraryVersion = eligibleLibraryVersions.find(item => item.id === selection.testCaseLibraryVersionId)
  if (selection.mode === 'suite_version') {
    const suite = required(aggregate.suiteVersions.find(item => item.id === selection.suiteVersionId && item.projectId === design.projectId && item.status !== 'deprecated' && Boolean(item.testCaseLibraryVersionId && eligibleLibraryVersionIds.has(item.testCaseLibraryVersionId))), 'TEST_DESIGN_HISTORICAL_SOURCE_INVALID', '历史测试套件版本不属于明确继承的来源版本')
    if (!suite.testCaseLibraryVersionId || suite.compatibilityStatus === 'migration_required' || suite.members.some(item => item.testCaseLibraryVersionId !== suite.testCaseLibraryVersionId)) throw new TestDesignError('TEST_DESIGN_HISTORICAL_SOURCE_INVALID', '历史测试套件没有固定唯一用例库版本，需要人工迁移', 422)
    libraryVersion = aggregate.libraryVersions.find(item => item.id === suite.testCaseLibraryVersionId && item.projectId === design.projectId)
    memberFilter = new Set(suite.members.map(item => `${item.caseId}:${item.revision}`))
    kind = 'historical_test_suite'
  }
  if (selection.mode !== 'none') required(libraryVersion, 'TEST_DESIGN_HISTORICAL_SOURCE_INVALID', '指定的历史用例库版本不存在或不属于来源版本')
  for (const member of libraryVersion?.members ?? []) {
    if (memberFilter && !memberFilter.has(`${member.caseId}:${member.revision}`)) continue
    const sourceCase = required(aggregate.libraryCases.find(item => item.id === member.caseId && item.projectId === design.projectId), 'TEST_DESIGN_HISTORICAL_SOURCE_INVALID', '正式历史用例不存在')
    const revision = required(sourceCase.revisions.find(item => item.revision === member.revision), 'TEST_DESIGN_HISTORICAL_SOURCE_INVALID', '正式历史用例 Revision 不存在')
    items.push({ id: `history_${libraryVersion!.id}_${sourceCase.id}_${revision.revision}`, kind, sourceId: `${libraryVersion!.id}:${sourceCase.id}:${revision.revision}`, contentSha256: revision.semanticSha256, content: structuredClone(revision.content), locator: { testCaseLibraryVersionId: libraryVersion!.id, caseId: sourceCase.id, revision: revision.revision, status: sourceCase.status } })
  }
  for (const legacySelection of design.input.historicalCaseSelections ?? []) {
    if (legacySelection.sourceType !== 'asset_version') continue
    if (!inheritedSource || !sourceVersionHasAssetVersion(state, inheritedSource.id, legacySelection.assetVersionId!)) throw new TestDesignError('TEST_DESIGN_SOURCE_INHERITANCE_REQUIRED', '历史资产必须来自明确继承的来源版本', 422)
    items.push(assetContentRef(state, design.projectId, legacySelection.assetVersionId!, 'historical_case_asset'))
  }
  const baseline = libraryVersion
  const selectedCaseIds = new Set(items.flatMap(item => {
    const locator = item.locator as { caseId?: unknown } | undefined
    return typeof locator?.caseId === 'string' ? [locator.caseId] : []
  }))
  const dataRequirements = libraryVersion?.dataRequirementSet?.requirements
    .filter(item => item.caseIds.some(caseId => selectedCaseIds.has(caseId)))
    .map(item => structuredClone(item))
  const base = {
    schemaVersion: 'historical-case-snapshot/v1' as const,
    items,
    ...(dataRequirements?.length ? { dataRequirements } : {}),
    ...(baseline ? { baseTestCaseLibraryVersionId: baseline.id, baseTestCaseLibraryVersionSha256: baseline.contentSha256 } : {}),
    createdAt,
  }
  return { ...base, snapshotSha256: canonicalSha256(base) }
}
function assetContentRef(state: DatabaseState, projectId: string, versionId: string, kind: 'knowledge_asset' | 'historical_case_asset') { const version = required(state.versions.find(item => item.id === versionId && item.status === 'ready'), 'TEST_DESIGN_ASSET_NOT_READY', `资产版本 ${versionId} 不存在或未就绪`); const asset = required(state.assets.find(item => item.id === version.assetId), 'TEST_DESIGN_ASSET_NOT_READY', '资产不存在'); const base = required(state.knowledgeBases.find(item => item.id === asset.knowledgeBaseId && item.projectId === projectId), 'TEST_DESIGN_HISTORICAL_SOURCE_INVALID', '资产不属于当前项目'); return { id: `basis_asset_${version.id}`, kind, sourceId: version.id, contentSha256: version.contentHash, content: { assetId: asset.id, assetVersionId: version.id, assetType: asset.assetType, displayName: asset.displayName, logicalPath: asset.logicalPath, content: version.content, chunks: version.chunks.map(({ embedding: _embedding, ...chunk }) => chunk) }, locator: { projectId, knowledgeBaseId: base.id, assetId: asset.id, assetVersionId: version.id, logicalPath: asset.logicalPath } } }
function knowledgeBasisItems(state: DatabaseState, projectId: string, versionId: string) {
  const source = assetContentRef(state, projectId, versionId, 'knowledge_asset')
  const content = source.content as { assetId: string; assetVersionId: string; assetType: string; displayName: string; logicalPath: string; content: string; chunks: Array<{ id: string; chunkKey?: string; content: string; headingPath?: string[]; startLine?: number; endLine?: number }> }
  return fixedContentUnits(content).map((unit, index) => ({
    id: `basis_knowledge_${versionId}_${canonicalSha256(unit.id).slice(0, 16)}`,
    kind: 'knowledge_asset' as const,
    sourceId: `${versionId}:${unit.id}`,
    contentSha256: canonicalSha256(unit.content),
    content: { title: unit.headingPath.at(-1) ?? `${content.displayName} ${index + 1}`, description: unit.content, assetType: content.assetType },
    locator: { coverageTarget: true, projectId, assetId: content.assetId, assetVersionId: versionId, logicalPath: content.logicalPath, chunkId: unit.id, headingPath: unit.headingPath, ...(unit.startLine === undefined ? {} : { startLine: unit.startLine }), ...(unit.endLine === undefined ? {} : { endLine: unit.endLine }), ordinal: index },
  }))
}

function retrievalCandidates(state: DatabaseState, projectId: string, versionId: string, filters?: Record<string, string | string[]>) {
  const source = assetContentRef(state, projectId, versionId, 'knowledge_asset')
  const content = source.content as { assetId: string; assetVersionId: string; assetType: string; displayName: string; logicalPath: string; content: string; chunks: Array<{ id: string; chunkKey?: string; content: string; headingPath?: string[]; startLine?: number; endLine?: number }> }
  if (!matchesRetrievalFilters(content, filters)) return []
  const classification = /defect|bug|incident|report|缺陷|复盘|报告/iu.test(`${content.assetType} ${content.logicalPath}`) ? 'historical_defect' as const : /requirement|technical|api|规范|需求|方案|接口/iu.test(`${content.assetType} ${content.logicalPath}`) ? 'normative_reference' as const : 'context_only' as const
  return fixedContentUnits(content).map((unit, index) => ({ id: `${versionId}:${unit.id}`, assetVersionId: versionId, chunkId: unit.id, content: unit.content.slice(0, 2_000), classification, locator: { projectId, assetId: content.assetId, assetVersionId: versionId, logicalPath: content.logicalPath, headingPath: unit.headingPath, ...(unit.startLine === undefined ? {} : { startLine: unit.startLine }), ...(unit.endLine === undefined ? {} : { endLine: unit.endLine }), ordinal: index } }))
}

function fixedContentUnits(content: { content: string; chunks?: Array<{ id: string; chunkKey?: string; content: string; headingPath?: string[]; startLine?: number; endLine?: number }> }) {
  if (content.chunks?.length) return content.chunks.map((chunk, index) => ({ id: chunk.id || chunk.chunkKey || `chunk-${index + 1}`, content: chunk.content, headingPath: chunk.headingPath ?? [], startLine: chunk.startLine, endLine: chunk.endLine })).filter(item => item.content.trim())
  const units = content.content.split(/\r?\n\s*\r?\n/u).map(item => item.trim()).filter(Boolean)
  return (units.length ? units : [content.content]).slice(0, 500).map((value, index) => ({ id: `paragraph-${index + 1}`, content: value, headingPath: [] as string[], startLine: undefined, endLine: undefined }))
}

function retrievalQueries(input: CreateTestDesignInput) {
  const values = [input.objective, ...(input.userCoverageObjectives ?? []), ...(input.includedScopes ?? []).map(item => `${item.kind} ${item.value}`), ...(input.focusDimensions ?? []).map(item => `${item} 测试风险`)]
  return [...new Set(values.map(item => item.trim()).filter(Boolean))].slice(0, 20).map((query, index) => ({ query, intent: index === 0 ? 'test_objective' : 'coverage_context' }))
}

function searchTokens(value: string) {
  const normalized = value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const words = normalized.split(/\s+/u).filter(item => item.length > 1)
  const han = [...normalized.replace(/[^\p{Script=Han}]/gu, '')]
  for (let index = 0; index < han.length - 1; index += 1) words.push(`${han[index]}${han[index + 1]}`)
  return [...new Set(words)].slice(0, 100)
}

function retrievalScore(tokens: string[], content: string) {
  const normalized = content.toLocaleLowerCase()
  if (!tokens.length) return 0
  const matched = tokens.filter(token => normalized.includes(token)).length
  return Number((matched / Math.sqrt(tokens.length * Math.max(tokens.length, 4))).toFixed(6))
}

function matchesRetrievalFilters(content: { assetType: string; logicalPath: string }, filters?: Record<string, string | string[]>) {
  if (!filters) return true
  return Object.entries(filters).every(([key, raw]) => {
    const values = Array.isArray(raw) ? raw : [raw]
    const target = key === 'assetType' ? content.assetType : key === 'logicalPath' ? content.logicalPath : ''
    return target && values.some(value => target.toLocaleLowerCase().includes(value.toLocaleLowerCase()))
  })
}

function validateDesignSources(state: DatabaseState, projectVersion: ProjectVersion, input: CreateTestDesignInput) {
  const projectId = projectVersion.projectId
  const augmentation = input.knowledgeAugmentation
  if (augmentation.mode === 'selected_assets') augmentation.assetVersionIds.forEach(id => assetContentRef(state, projectId, id, 'knowledge_asset'))
  if (augmentation.mode === 'fixed_index') {
    const index = required(state.indexes.find(item => item.id === augmentation.indexVersionId && item.status === 'active'), 'TEST_DESIGN_AUGMENTATION_INVALID', '固定索引不存在或未激活')
    const base = required(state.knowledgeBases.find(item => item.id === index.knowledgeBaseId), 'TEST_DESIGN_AUGMENTATION_INVALID', '固定索引知识库不存在')
    if (base.projectId !== projectId) throw new TestDesignError('TEST_DESIGN_AUGMENTATION_INVALID', '固定索引不属于当前项目')
  }
  for (const selection of input.historicalCaseSelections ?? []) {
    const source = explicitlyInheritedSourceVersion(state, projectVersion)
    if (selection.sourceType === 'asset_version' && source && sourceVersionHasAssetVersion(state, source.id, selection.assetVersionId!)) assetContentRef(state, projectId, selection.assetVersionId!, 'historical_case_asset')
    else if (selection.sourceType === 'asset_version') throw new TestDesignError('TEST_DESIGN_SOURCE_INHERITANCE_REQUIRED', '当前版本未明确继承来源版本中的该历史资产', 422)
    else throw new TestDesignError('TEST_DESIGN_HISTORICAL_SOURCE_INVALID', '结构化历史用例请改用项目级用例库版本', 422)
  }
  const historical = input.historicalLibrarySelection ?? { mode: 'none' as const }
  if (historical.mode === 'none') return
  const source = required(explicitlyInheritedSourceVersion(state, projectVersion), 'TEST_DESIGN_SOURCE_INHERITANCE_REQUIRED', '当前版本未明确继承来源版本，不能加载历史测试资产')
  const aggregate = readDesignState(state)
  const libraryVersions = inheritedLibraryVersionsForSource(aggregate, source.id)
  const libraryVersionIds = new Set(libraryVersions.map(item => item.id))
  if (historical.mode === 'latest_library' && !libraryVersions.length) throw new TestDesignError('TEST_DESIGN_HISTORICAL_SOURCE_INVALID', '来源版本没有可继承的冻结用例库版本', 422)
  if (historical.mode === 'library_version') required(libraryVersions.find(item => item.id === historical.testCaseLibraryVersionId), 'TEST_DESIGN_HISTORICAL_SOURCE_INVALID', '历史用例库版本不存在或不属于来源版本')
  if (historical.mode === 'suite_version') required(aggregate.suiteVersions.find(item => item.id === historical.suiteVersionId && item.projectId === projectId && item.status !== 'deprecated' && Boolean(item.testCaseLibraryVersionId && libraryVersionIds.has(item.testCaseLibraryVersionId))), 'TEST_DESIGN_HISTORICAL_SOURCE_INVALID', '历史测试套件版本不存在或不属于来源版本')
}

function explicitlyInheritedSourceVersion(state: DatabaseState, projectVersion: ProjectVersion) {
  if (!projectVersion.inheritRequirementBindings) return undefined
  const source = projectVersion.sourceProjectVersionId ? state.projectVersions.find(item => item.id === projectVersion.sourceProjectVersionId && item.projectId === projectVersion.projectId) : undefined
  return source
}

function sourceVersionHasAssetVersion(state: DatabaseState, sourceProjectVersionId: string, assetVersionId: string) {
  return state.projectVersionRequirementBindings.some(item => item.projectVersionId === sourceProjectVersionId && item.assetVersionId === assetVersionId)
}

function inheritedLibraryVersionsForSource(aggregate: TestDesignState, sourceProjectVersionId: string) {
  const sourceRunIds = new Set(aggregate.runs.filter(run => run.projectVersionId === sourceProjectVersionId).map(run => run.id))
  return aggregate.libraryVersions.filter(item => Boolean(item.sourceRunId && sourceRunIds.has(item.sourceRunId)))
}

function latestPublishedLibraryVersion(versions: TestCaseLibraryVersion[]) {
  return [...versions].sort((left, right) => right.version - left.version || right.publishedAt.localeCompare(left.publishedAt))[0]
}

function publishedRequirements(analysisRun: ReviewRun) {
  const release = required(analysisRun.workflow?.release, 'TEST_DESIGN_REQUIREMENTS_PACKAGE_REQUIRED', '需求发布包不存在')
  if (release.status !== 'published') throw new TestDesignError('TEST_DESIGN_REQUIREMENTS_PACKAGE_REQUIRED', '需求发布包尚未正式发布', 422)
  if (release.projectVersionId !== analysisRun.projectVersionId || release.verificationRunId !== analysisRun.id) throw new TestDesignError('TEST_DESIGN_REQUIREMENTS_PACKAGE_INVALID', '需求发布包与固定需求分析运行不一致', 422)
  const manifest = required(release.artifacts.find(item => item.fileName === 'manifest.json' && item.mediaType === 'application/json'), 'TEST_DESIGN_REQUIREMENTS_PACKAGE_REQUIRED', '需求发布包缺少 manifest.json')
  if (canonicalSha256Text(manifest.content) !== release.contentSha256) throw new TestDesignError('TEST_DESIGN_REQUIREMENTS_PACKAGE_HASH_MISMATCH', 'manifest.json 内容 Hash 校验失败', 422)
  const artifact = required(release.artifacts.find(item => item.fileName === 'requirements.json' && item.mediaType === 'application/json'), 'TEST_DESIGN_REQUIREMENTS_PACKAGE_REQUIRED', '需求发布包缺少 requirements.json')
  if (canonicalSha256Text(artifact.content) !== artifact.contentSha256) throw new TestDesignError('TEST_DESIGN_REQUIREMENTS_PACKAGE_HASH_MISMATCH', 'requirements.json 内容 Hash 校验失败', 422)
  let manifestValue: unknown
  try { manifestValue = JSON.parse(manifest.content) } catch { throw new TestDesignError('TEST_DESIGN_REQUIREMENTS_PACKAGE_INVALID', 'manifest.json 不是合法 JSON', 422) }
  const manifestRecord = manifestValue && typeof manifestValue === 'object' && !Array.isArray(manifestValue)
    ? manifestValue as { schemaVersion?: unknown; releaseId?: unknown; projectVersionId?: unknown; verificationRunId?: unknown; artifacts?: unknown; machineReadableEntryPoints?: unknown }
    : {}
  const entryPoints = manifestRecord.machineReadableEntryPoints && typeof manifestRecord.machineReadableEntryPoints === 'object' && !Array.isArray(manifestRecord.machineReadableEntryPoints)
    ? manifestRecord.machineReadableEntryPoints as { requirements?: unknown }
    : {}
  const manifestArtifacts = Array.isArray(manifestRecord.artifacts) ? manifestRecord.artifacts : []
  const requirementsEntry = manifestArtifacts.find(item => item && typeof item === 'object' && !Array.isArray(item) && (item as { fileName?: unknown }).fileName === 'requirements.json') as { mediaType?: unknown; contentSha256?: unknown } | undefined
  if (manifestRecord.schemaVersion !== 'requirement-release-manifest/v1' || manifestRecord.releaseId !== release.id || manifestRecord.projectVersionId !== analysisRun.projectVersionId || manifestRecord.verificationRunId !== analysisRun.id || entryPoints.requirements !== 'requirements.json' || requirementsEntry?.mediaType !== 'application/json' || requirementsEntry.contentSha256 !== artifact.contentSha256) throw new TestDesignError('TEST_DESIGN_REQUIREMENTS_PACKAGE_INVALID', 'manifest.json 未固定正确的 requirements.json 入口', 422)
  let value: unknown
  try { value = JSON.parse(artifact.content) } catch { throw new TestDesignError('TEST_DESIGN_REQUIREMENTS_PACKAGE_INVALID', 'requirements.json 不是合法 JSON', 422) }
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as { schemaVersion?: unknown; releaseId?: unknown; projectVersionId?: unknown; verificationRunId?: unknown; sourceAssetVersions?: unknown; requirements?: unknown } : {}
  const sourceIds = Array.isArray(record.sourceAssetVersions) ? record.sourceAssetVersions.map(item => item && typeof item === 'object' && !Array.isArray(item) ? String((item as { assetVersionId?: unknown }).assetVersionId ?? '') : '') : []
  const requirements = Array.isArray(record.requirements) ? record.requirements : []
  const requirementIds = requirements.map(item => item && typeof item === 'object' && !Array.isArray(item) ? String((item as { clientRequirementPointId?: unknown }).clientRequirementPointId ?? '').trim() : '')
  const invalidRequirement = requirements.some(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return true
    const point = item as { evidenceRefs?: unknown; coverageTarget?: unknown; coverageRationale?: unknown }
    return !Array.isArray(point.evidenceRefs)
      || (point.coverageTarget !== undefined && typeof point.coverageTarget !== 'boolean')
      || (point.coverageRationale !== undefined && (typeof point.coverageRationale !== 'string' || !point.coverageRationale.trim()))
  })
  if (record.schemaVersion !== 'requirements/v1' || record.releaseId !== release.id || record.projectVersionId !== analysisRun.projectVersionId || record.verificationRunId !== analysisRun.id || !requirements.length || requirementIds.some(id => !id) || new Set(requirementIds).size !== requirementIds.length || invalidRequirement || canonicalSha256(sourceIds) !== canonicalSha256(release.sourceAssetVersionIds)) throw new TestDesignError('TEST_DESIGN_REQUIREMENTS_PACKAGE_INVALID', 'requirements.json Schema、需求点或发布来源不兼容', 422)
  return { release, manifest, artifact, requirements: record.requirements as NonNullable<ReviewRun['result']>['requirementPoints'] }
}

function canonicalSha256Text(value: string) { return createHash('sha256').update(value).digest('hex') }
type BoundRequirementRelease = {
  binding: NonNullable<ReturnType<typeof activeRequirementReleaseBinding>>
  analysisRun: ReviewRun
  release: NonNullable<NonNullable<ReviewRun['workflow']>['release']>
}

function presentRequirementRelease(requirement: BoundRequirementRelease, active: boolean) {
  return {
    id: requirement.release.id,
    analysisRunId: requirement.analysisRun.id,
    contentSha256: requirement.release.contentSha256,
    publishedAt: requirement.release.publishedAt,
    label: `${requirement.analysisRun.documentTitle ?? '正式需求'} / ${requirement.release.id.slice(-8)}`,
    active,
  }
}

function boundRequirementRelease(state: DatabaseState, projectVersionId: string, releaseId?: string): BoundRequirementRelease | undefined {
  const projectVersion = state.projectVersions.find(item => item.id === projectVersionId)
  const binding = releaseId
    ? projectVersion && requirementReleaseBindings(projectVersion).find(item => item.releaseId === releaseId)
    : projectVersion && activeRequirementReleaseBinding(projectVersion)
  if (!projectVersion || !binding) return undefined
  const analysisRun = state.reviewRuns.find(item => item.id === binding.verificationRunId && item.projectVersionId === projectVersionId && item.status === 'succeeded' && item.workflow?.release?.id === binding.releaseId)
  if (!analysisRun?.workflow?.release) throw new TestDesignError('TEST_DESIGN_REQUIREMENT_RELEASE_BINDING_INVALID', 'ProjectVersion 绑定的 Requirement Release 不存在', 409)
  const machine = publishedRequirements(analysisRun)
  if (machine.release.verificationRunId !== binding.verificationRunId || machine.artifact.contentSha256 !== binding.requirementsJsonSha256) throw new TestDesignError('TEST_DESIGN_REQUIREMENT_RELEASE_BINDING_INVALID', 'ProjectVersion 的 Requirement Release 绑定与发布包不一致', 409)
  return { binding, analysisRun, release: machine.release }
}

function buildWorkspaceSnapshot(state: DatabaseState, design: TestDesign, requirement: BoundRequirementRelease, machine: ReturnType<typeof publishedRequirements>, historical: HistoricalCaseSnapshot, createdAt: string): TestDesignWorkspaceSnapshot {
  const projectVersion = required(state.projectVersions.find(item => item.id === design.projectVersionId), 'PROJECT_VERSION_NOT_FOUND', '项目版本不存在')
  const knowledgeBase = required(state.knowledgeBases.find(item => item.projectId === design.projectId), 'TEST_DESIGN_WORKSPACE_REQUIRED', '项目知识库不存在')
  const index = required(state.indexes.find(item => item.id === knowledgeBase.activeIndexVersionId && item.status === 'active'), 'TEST_DESIGN_WORKSPACE_REQUIRED', '项目 Workspace 没有活动索引')
  const files = new Map<string, TestDesignWorkspaceFile>()
  const branch = `workspace/branches/${safeWorkspaceSegment(projectVersion.name)}`
  const currentInputVersionIds = new Set(requirement.analysisRun.snapshot.currentInputRefs.map(item => item.assetVersionId))
  for (const asset of state.assets) {
    if (asset.knowledgeBaseId !== knowledgeBase.id || !asset.activeVersionId || !isWithinWorkspace(asset.logicalPath)) continue
    const version = state.versions.find(item => item.id === asset.activeVersionId && item.assetId === asset.id && item.status === 'ready')
    if (!version) continue
    const logicalPath = normalizeWorkspacePath(asset.logicalPath)
    files.set(logicalPath, { logicalPath, sourceType: 'asset_version', sourceId: version.id, assetId: asset.id, assetVersionId: version.id, contentSha256: version.contentHash, content: version.content, displayName: asset.displayName, sourceScope: classifyWorkspaceSourceScope(logicalPath, branch, currentInputVersionIds.has(version.id)) })
  }
  for (const releaseArtifact of requirement.release.artifacts) {
    const logicalPath = `${branch}/requirements/${releaseArtifact.fileName}`
    files.set(logicalPath, { logicalPath, sourceType: 'requirement_release', sourceId: `${requirement.release.id}:${releaseArtifact.fileName}`, contentSha256: releaseArtifact.contentSha256, content: releaseArtifact.content, displayName: releaseArtifact.fileName, sourceScope: 'current_input' })
  }
  if (historical.items.length) {
    const content = `${canonicalJson({ schemaVersion: historical.schemaVersion, snapshotSha256: historical.snapshotSha256, items: historical.items })}\n`
    const logicalPath = 'workspace/agent_workspace/planning_agent/historical-test-cases.json'
    files.set(logicalPath, { logicalPath, sourceType: 'run_candidate', sourceId: historical.snapshotSha256, contentSha256: canonicalSha256Text(content), content, displayName: 'historical-test-cases.json', sourceScope: 'historical_branch' })
  }
  const ordered = [...files.values()].sort((left, right) => left.logicalPath.localeCompare(right.logicalPath, 'zh-CN'))
  const base = { schemaVersion: 'project-workspace-snapshot/v1' as const, projectId: design.projectId, rootLogicalPath: 'workspace' as const, activeBranchLogicalPath: branch, agentLogicalPath: 'workspace/agent_workspace/planning_agent' as const, projectVersionId: projectVersion.id, projectVersionName: projectVersion.name, knowledgeBaseId: knowledgeBase.id, indexVersionId: index.id, requirementReleaseId: requirement.release.id, verificationRunId: requirement.analysisRun.id, requirementsJsonSha256: machine.artifact.contentSha256, files: ordered, createdAt }
  return { ...base, snapshotSha256: canonicalSha256(base) }
}

export function materializeCaseDesign(run: TestDesignWorkflowRun, raw: unknown, actorId: string, repair: boolean): TestCaseDesignCandidate {
  const submitted = validateTestCaseDesignCandidate(raw, repair)
  const value = isTestDesignRepairPatch(submitted)
    ? applyRepairPatch(run, submitted)
    : validateHistoricalProposalPlan(submitted, run.historicalSnapshot)
  if (!value.cases.length) throw new TestDesignError('TEST_DESIGN_CANDIDATE_EMPTY_WITHOUT_REUSABLE_HISTORY', 'test-case-design/v2 提交 cases: [] 时，当前版本必须明确继承且冻结快照中至少存在一条可复用历史用例', 422)
  assertRequestedExecutionMethodCoverage(run, value)
  const existingByRef = new Map(run.testCases.filter(item => !item.tombstonedAt && item.candidateRef).map(item => [item.candidateRef!, item]))
  const idByRef = new Map(value.cases.map(candidate => [candidate.ref, existingByRef.get(candidate.ref)?.id ?? `test_case_${randomUUID()}`]))
  const existingDataIdByRef = new Map((run.dataSetVersions.at(-1)?.requirements ?? []).map((item, index) => [`data-${index + 1}`, item.id]))
  const dataIdByRef = new Map(value.dataRequirements.map(candidate => [candidate.ref, repair ? existingDataIdByRef.get(candidate.ref) ?? `test_data_${randomUUID()}` : `test_data_${randomUUID()}`]))
  const proposalByCandidateRef = new Map(value.proposals.flatMap(item => item.candidateRef ? [[item.candidateRef, item] as const] : []))
  const historicalBySourceKey = new Map(run.historicalSnapshot.items.flatMap(item => {
    const locator = item.locator as { caseId?: unknown; revision?: unknown } | undefined
    return typeof locator?.caseId === 'string' && Number.isInteger(locator.revision) ? [[`${locator.caseId}:${locator.revision}`, item] as const] : []
  }))
  const nextCases = value.cases.map(candidate => {
    const dependencies = candidate.content.dependencies.map(reference => required(idByRef.get(reference), 'TEST_CASE_DEPENDENCY_INVALID', `依赖用例 ref ${reference} 不存在`))
    const dataRequirementIds = value.dataRequirements.filter(item => item.caseRefs.includes(candidate.ref)).map(item => dataIdByRef.get(item.ref)!)
    const content = { ...candidate.content, dependencies, dataRequirementIds }
    const current = existingByRef.get(candidate.ref)
    const proposal = proposalByCandidateRef.get(candidate.ref)
    const historical = proposal?.sourceCaseId && proposal.sourceRevision !== undefined ? historicalBySourceKey.get(`${proposal.sourceCaseId}:${proposal.sourceRevision}`) : undefined
    if (current) {
      const previous = currentCaseRevision(current)
      if (previous.semanticSha256 !== semanticContentSha256(content)) {
        const revision = createCaseRevision(previous.revision + 1, content, PLANNING_AGENT_EDITOR_ID, repair ? 'PlanningAgent Repair Patch' : 'PlanningAgent 候选更新', previous.content)
        current.revisions.push(revision)
        current.currentRevision = revision.revision
        current.reviewState = 'in_review'
      }
      synchronizeCandidateHistoricalOrigin(current, historical)
      current.tombstonedAt = undefined
      return current
    }
    const testCase = newCase(run.id, content, historical ? (semanticContentSha256(content) === historical.contentSha256 ? 'historical_unchanged' : 'historical_modified') : 'ai', PLANNING_AGENT_EDITOR_ID, historical ? '固定历史用例当前 Candidate' : 'PlanningAgent 候选', idByRef.get(candidate.ref)!)
    testCase.candidateRef = candidate.ref
    if (historical) testCase.historicalSourceRef = historical.id
    return testCase
  })
  if (repair) for (const removed of run.testCases.filter(item => item.candidateRef && !idByRef.has(item.candidateRef))) removed.tombstonedAt = now()
  run.testCases = repair ? [...run.testCases.filter(item => !item.candidateRef), ...nextCases] : nextCases
  run.dimensionAssessments = structuredClone(value.dimensionAssessments)
  run.scenarioClaims = structuredClone(value.scenarioClaims)
  const requirements: TestDataRequirement[] = value.dataRequirements.map(candidate => ({
    id: dataIdByRef.get(candidate.ref)!, name: candidate.name, entityType: candidate.entityType, featureTags: candidate.featureTags, requirementRefs: candidate.requirementRefs,
    caseIds: candidate.caseRefs.map(reference => required(idByRef.get(reference), 'TEST_DATA_REQUIREMENT_CASE_INVALID', `数据需求引用的用例 ref ${reference} 无效`)),
    fieldConstraints: candidate.fieldConstraints, relationships: candidate.relationships, quantity: candidate.quantity, initialState: candidate.initialState, preparationHint: candidate.preparationHint, sensitivity: candidate.sensitivity, isolation: candidate.isolation, resetAndCleanup: candidate.resetAndCleanup, readiness: candidate.readiness, ...(candidate.readinessReason ? { readinessReason: candidate.readinessReason } : {}),
  }))
  const normalizedRequirements = validateDataRequirements(run, requirements)
  const currentDataSet = run.dataSetVersions.at(-1)
  if (!currentDataSet || currentDataSet.contentSha256 !== canonicalSha256(normalizedRequirements)) run.dataSetVersions.push(dataSetVersion(run.dataSetVersions.length + 1, normalizedRequirements, actorId))
  materializeCaseChangeProposals(run, value, nextCases)
  materializeDesignIssues(run, value)
  validateCurrentDependencyGraph(run)
  return value
}

function assertRequestedExecutionMethodCoverage(run: TestDesignWorkflowRun, value: TestCaseDesignCandidate) {
  const covered = new Set(value.cases.flatMap(candidate => candidate.content.executionMethods.map(method => method.method)))
  const missingMethods = (run.requestedExecutionMethods ?? []).filter(method => !covered.has(method))
  if (missingMethods.length) throw new TestDesignError(
    'TEST_DESIGN_EXECUTION_METHOD_UNCOVERED',
    `测试设计选择的执行方式未出现在任何功能或安全用例中：${missingMethods.join('、')}；缺少接口、URL 或定位器等执行数据时请保留对应方式、将字段留空并标记 needs_confirmation`,
    422,
    { requestedExecutionMethods: run.requestedExecutionMethods, coveredExecutionMethods: [...covered], missingMethods },
  )
}

function applyRepairPatch(run: TestDesignWorkflowRun, patch: TestDesignRepairPatch): TestCaseDesignCandidate {
  const before = repairCandidateContent(run)
  const actualSha256 = canonicalSha256(before)
  if (patch.baseCandidateSha256 !== actualSha256) throw new TestDesignError('TEST_DESIGN_REPAIR_BASE_CANDIDATE_CONFLICT', 'Repair Patch 的 baseCandidateSha256 与当前完整 Candidate 不一致，请重新读取当前快照后提交', 409, { expectedBaseCandidateSha256: actualSha256, actualBaseCandidateSha256: patch.baseCandidateSha256 })
  const cases = new Map(before.cases.map(item => [item.ref, structuredClone(item)]))
  const scenarioClaims = structuredClone(before.scenarioClaims)
  const dataRequirements = new Map(before.dataRequirements.map(item => [item.ref, structuredClone(item)]))
  const dimensions = new Map(before.dimensionAssessments.map(item => [item.dimension, structuredClone(item)]))
  const proposals = before.proposals.map(item => structuredClone(item))
  const activeCaseByRef = new Map(run.testCases.filter(item => !item.tombstonedAt && item.candidateRef).map(item => [item.candidateRef!, item]))
  const proposalByCandidateRef = new Map(proposals.flatMap(item => item.candidateRef ? [[item.candidateRef, item] as const] : []))

  for (const ref of patch.removeCaseRefs) {
    const current = activeCaseByRef.get(ref)
    const proposal = proposalByCandidateRef.get(ref)
    if (!current || !cases.has(ref)) throw new TestDesignError('TEST_DESIGN_REPAIR_CASE_REFERENCE_INVALID', `removeCaseRefs 引用了不存在的当前 Candidate：${ref}`, 422)
    if (current.origin === 'historical_unchanged' || proposal?.operation === 'reuse' || proposal?.operation === 'update') throw new TestDesignError('TEST_DESIGN_REPAIR_HISTORICAL_CASE_REMOVAL_FORBIDDEN', `不能通过 Repair Patch 删除冻结历史 Case：${ref}`, 422)
    if (proposal?.operation && proposal.operation !== 'create') throw new TestDesignError('TEST_DESIGN_REPAIR_CASE_REMOVAL_FORBIDDEN', `removeCaseRefs 只能删除本轮新增 Candidate：${ref}`, 422)
    cases.delete(ref)
    for (let index = scenarioClaims.length - 1; index >= 0; index -= 1) if (scenarioClaims[index].caseRef === ref) scenarioClaims.splice(index, 1)
    const proposalIndex = proposals.findIndex(item => item.candidateRef === ref)
    if (proposalIndex >= 0) proposals.splice(proposalIndex, 1)
  }
  for (const candidate of patch.upsertCases) {
    const previous = cases.get(candidate.ref)
    const next = flatCandidateCase(candidate)
    const currentClaims = scenarioClaims.filter(item => item.caseRef === candidate.ref)
    if (candidate.coverageClaims !== undefined) {
      for (let index = scenarioClaims.length - 1; index >= 0; index -= 1) if (scenarioClaims[index].caseRef === candidate.ref) scenarioClaims.splice(index, 1)
      scenarioClaims.push(...candidate.coverageClaims)
    }
    if (previous && semanticContentSha256(previous) === semanticContentSha256(next)) {
      cases.set(candidate.ref, previous)
      continue
    }
    if (candidate.coverageClaims === undefined && currentClaims.length && currentClaims.some(claim => claim.requirementRefs.some(requirementRef => !candidate.content.requirementRefs.includes(requirementRef)))) {
      for (let index = scenarioClaims.length - 1; index >= 0; index -= 1) if (scenarioClaims[index].caseRef === candidate.ref) scenarioClaims.splice(index, 1)
      scenarioClaims.push(...currentClaims.map(claim => ({ ...claim, requirementRefs: [...candidate.content.requirementRefs] })))
    }
    cases.set(candidate.ref, next)
    const proposal = proposalByCandidateRef.get(candidate.ref)
    if (!proposal) {
      proposals.push({ operation: 'create', candidateRef: candidate.ref, requirementRefs: [...candidate.content.requirementRefs], reason: candidate.changeReason ?? 'Coverage Audit 修复产生的新测试场景', confidence: candidate.confidence ?? 0.8 })
      continue
    }
    proposal.requirementRefs = [...candidate.content.requirementRefs]
    if (candidate.changeReason) proposal.reason = candidate.changeReason
    if (candidate.confidence !== undefined) proposal.confidence = candidate.confidence
    if (proposal.sourceCaseId && proposal.sourceRevision !== undefined && (proposal.operation === 'reuse' || proposal.operation === 'update')) {
      const source = run.historicalSnapshot.items.find(item => {
        const locator = item.locator as { caseId?: unknown; revision?: unknown } | undefined
        return locator?.caseId === proposal.sourceCaseId && locator?.revision === proposal.sourceRevision
      })
      if (!source) throw new TestDesignError('CASE_CHANGE_PROPOSAL_SOURCE_INVALID', 'Repair Patch 的历史 Proposal 来源不属于当前冻结快照', 422)
      proposal.operation = semanticContentSha256(candidate.content) === source.contentSha256 ? 'reuse' : 'update'
    }
  }
  for (const ref of patch.removeDataRequirementRefs) {
    if (!dataRequirements.delete(ref)) throw new TestDesignError('TEST_DESIGN_REPAIR_DATA_REQUIREMENT_REFERENCE_INVALID', `removeDataRequirementRefs 引用了不存在的数据需求：${ref}`, 422)
  }
  for (const item of patch.upsertDataRequirements) dataRequirements.set(item.ref, structuredClone(item))
  for (const item of patch.dimensionAssessmentUpdates) dimensions.set(item.dimension, structuredClone(item))

  const full: Record<string, unknown> = {
    schemaVersion: 'test-design-repair/v1',
    cases: [...cases.values()],
    dimensionAssessments: ['functional', 'performance', 'stability', 'compatibility', 'security'].flatMap(dimension => dimensions.has(dimension as TestCaseContent['dimension']) ? [dimensions.get(dimension as TestCaseContent['dimension'])] : []),
    scenarioClaims,
    dataRequirements: [...dataRequirements.values()],
    findings: before.findings,
    confirmationItems: before.confirmationItems,
    proposals,
  }
  const normalized = validateTestCaseDesignCandidate(full, true)
  if (isTestDesignRepairPatch(normalized)) throw new TestDesignError('TEST_DESIGN_REPAIR_PATCH_INVALID', 'Repair Patch 未能展开为完整 Candidate', 422)
  return validateHistoricalProposalPlan(normalized, run.historicalSnapshot)
}

function materializeCaseChangeProposals(run: TestDesignWorkflowRun, value: TestCaseDesignCandidate, cases: TestCase[]) {
  const byRef = new Map(cases.flatMap(testCase => testCase.candidateRef ? [[testCase.candidateRef, testCase] as const] : []))
  const frozenByCase = new Map(run.historicalSnapshot.items.flatMap(item => {
    const locator = item.locator as { caseId?: unknown; revision?: unknown } | undefined
    return typeof locator?.caseId === 'string' && Number.isInteger(locator.revision) ? [[`${locator.caseId}:${locator.revision}`, item] as const] : []
  }))
  const candidates = value.proposals.length ? value.proposals : cases.map(testCase => {
    const revision = currentCaseRevision(testCase)
    const historical = run.historicalSnapshot.items.find(item => item.contentSha256 === revision.semanticSha256)
    const locator = historical?.locator as { caseId?: string; revision?: number } | undefined
    return historical && locator?.caseId && locator.revision !== undefined
      ? { operation: 'reuse' as const, sourceCaseId: locator.caseId, sourceRevision: locator.revision, candidateRef: testCase.candidateRef, requirementRefs: requirementRefsForCase(run, revision.content), reason: '与冻结历史 Revision 语义一致，优先复用', confidence: 1 }
      : { operation: 'create' as const, candidateRef: testCase.candidateRef, requirementRefs: requirementRefsForCase(run, revision.content), reason: '冻结历史用例无法覆盖该 Requirement', confidence: 0.8 }
  })
  const existing = new Map(run.caseChangeProposals.map(item => [proposalAssociation(item.sourceCaseId, item.sourceRevision, cases.find(candidate => candidate.id === item.candidateCaseId)?.candidateRef), item]))
  run.caseChangeProposals = candidates.map(candidate => {
    const source = candidate.sourceCaseId && candidate.sourceRevision !== undefined ? required(frozenByCase.get(`${candidate.sourceCaseId}:${candidate.sourceRevision}`), 'CASE_CHANGE_PROPOSAL_SOURCE_INVALID', 'Proposal 来源不属于冻结历史用例') : undefined
    const testCase = candidate.candidateRef ? required(byRef.get(candidate.candidateRef), 'CASE_CHANGE_PROPOSAL_CANDIDATE_INVALID', 'Proposal 候选用例不存在') : undefined
    const content = testCase ? currentCaseRevision(testCase).content : undefined
    const operation = source && content && ['reuse', 'update'].includes(candidate.operation) && semanticContentSha256(content) === source.contentSha256 ? 'reuse' : candidate.operation
    const retained = existing.get(proposalAssociation(candidate.sourceCaseId, candidate.sourceRevision, candidate.candidateRef))
    const candidateChanged = Boolean(retained?.candidateContent && content && semanticContentSha256(retained.candidateContent) !== semanticContentSha256(content))
    const resetDecision = Boolean(retained && (candidateChanged || retained.operation !== operation))
    const createdAt = retained?.createdAt ?? now()
    return {
      id: retained?.id ?? `case_change_proposal_${randomUUID()}`,
      runId: run.id,
      operation,
      ...(candidate.sourceCaseId ? { sourceCaseId: candidate.sourceCaseId } : {}),
      ...(candidate.sourceRevision !== undefined ? { sourceRevision: candidate.sourceRevision } : {}),
      ...(testCase ? { candidateCaseId: testCase.id, candidateContent: structuredClone(content) } : {}),
      diff: source && content ? structuralDiff(source.content, content) : [],
      requirementRefs: content ? requirementRefsForCase(run, content) : candidate.requirementRefs,
      reason: candidate.reason,
      confidence: candidate.confidence,
      decision: resetDecision ? 'pending' : retained?.decision ?? 'pending',
      createdAt,
      ...(!resetDecision && retained?.decidedBy ? { decidedBy: retained.decidedBy } : {}),
      ...(!resetDecision && retained?.decidedAt ? { decidedAt: retained.decidedAt } : {}),
      decisions: retained?.decisions ?? [],
      ...(!resetDecision && retained?.appliedCaseId ? { appliedCaseId: retained.appliedCaseId } : {}),
      ...(!resetDecision && retained?.appliedRevision !== undefined ? { appliedRevision: retained.appliedRevision } : {}),
    }
  })
  reconcileAutomaticProposalDecisions(run)
}

function requirementRefsForCase(_run: TestDesignWorkflowRun, content: TestCaseContent) { return [...new Set(content.requirementRefs ?? [])] }
function proposalAssociation(sourceCaseId?: string, sourceRevision?: number, candidateRef?: string) { return `${sourceCaseId ?? ''}:${sourceRevision ?? ''}:${candidateRef ?? ''}` }

function finalizeCaseDesignAndAudit(run: TestDesignWorkflowRun, raw: unknown, actorId: string, repair: boolean) {
  const beforeCandidate = repair ? repairCandidateContent(run) : undefined
  const before = beforeCandidate ? completeCandidateSnapshot(beforeCandidate) : undefined
  const value = materializeCaseDesign(run, raw, actorId, repair)
  const after = completeCandidateSnapshot(value)
  const artifact = repair
    ? { schemaVersion: 'test-design-repair-snapshot/v2', content: { baseCandidateSha256: canonicalSha256(beforeCandidate!), before, after, diff: structuralDiff(before, after) } }
    : { schemaVersion: 'test-case-design-candidate-snapshot/v2', content: after }
  const auditNode = node(run, 'coverage_audit')
  Object.assign(auditNode, { status: 'running', attempt: auditNode.attempt + 1, startedAt: now(), finishedAt: undefined, error: undefined, errorCode: undefined })
  const audit = runCoverageAudit(run)
  run.coverageAudits.forEach(item => { item.status = 'stale' })
  run.coverageAudits.push(audit)
  finishNode(run, 'coverage_audit')

  const repairable = audit.blockers.filter(item => item.resolution === 'agent_repair')
  const selectedRepairable = repairable.filter(item => repairBlockerCanRunIndependently(run, audit, item))
  const state = run.automaticRepair ?? initialAutomaticRepairState()
  run.automaticRepair = state
  const safeToRepair = selectedRepairable.every(item => repairBlockerCandidateIsSafe(run, item))
  if (selectedRepairable.length && safeToRepair && state.attempt < state.maxAttempts) {
    const timestamp = now()
    Object.assign(state, {
      status: 'queued',
      attempt: state.attempt + 1,
      blockerCodes: [...new Set(selectedRepairable.map(item => item.code))],
      blockerScopes: selectedRepairable.map(item => ({ code: item.code, ...(item.subjectId ? { subjectId: item.subjectId } : {}) })),
      triggerAuditId: audit.id,
      startedAt: state.startedAt ?? timestamp,
      finishedAt: undefined,
    })
    const repairNode = node(run, 'test_design_repair')
    if (repairNode.status === 'pending') queueNode(run, 'test_design_repair')
    else advanceNodeGeneration(run, repairNode, 'queued')
    advanceNodeGeneration(run, node(run, 'coverage_audit'), 'pending')
    Object.assign(run, { status: 'queued', stage: 'test_design_repair', progress: 80, finishedAt: undefined, error: undefined, errorCode: undefined })
    return { repairQueued: true, artifact }
  }

  const attempted = state.attempt > 0
  const status = repairable.length
    ? selectedRepairable.length && state.attempt >= state.maxAttempts ? 'exhausted'
      : 'deferred'
    : attempted ? 'succeeded' : 'not_needed'
  Object.assign(state, {
    status,
    blockerCodes: [...new Set(selectedRepairable.map(item => item.code))],
    blockerScopes: selectedRepairable.map(item => ({ code: item.code, ...(item.subjectId ? { subjectId: item.subjectId } : {}) })),
    triggerAuditId: repairable.length ? audit.id : undefined,
    finishedAt: now(),
  })
  Object.assign(run, { status: 'succeeded', stage: 'completed', progress: 100, finishedAt: now(), error: undefined, errorCode: undefined })
  return { repairQueued: false, artifact }
}
function selectedRepairBlockers(audit: CoverageAudit, state: NonNullable<TestDesignWorkflowRun['automaticRepair']>) {
  const scopes = state.blockerScopes
  const agentRepair = audit.blockers.filter(item => item.resolution === 'agent_repair')
  if (!scopes?.length) return agentRepair
  return agentRepair.filter(item => scopes.some(scope => scope.code === item.code && scope.subjectId === item.subjectId))
}
function repairBlockerCanRunIndependently(run: TestDesignWorkflowRun, audit: CoverageAudit, blocker: CoverageAudit['blockers'][number]) {
  if (['TEST_CASE_OVER_MERGED', 'TEST_CASE_DUPLICATE', 'TEST_CASE_REQUIREMENT_REFERENCE_INVALID'].includes(blocker.code)) return true
  if (blocker.code !== 'COVERAGE_REQUIREMENT_UNCOVERED' || !blocker.subjectId) return false
  const requirementId = blocker.subjectId
  const relatedCaseIds = new Set(run.testCases.filter(item => !item.tombstonedAt && currentCaseRevision(item).content.requirementRefs.includes(requirementId)).map(item => item.id))
  const relatedClarification = (run.basisSnapshot.clarifications ?? []).some(item => item.blocking && item.status === 'pending' && item.requirementPointRefs.includes(requirementId))
  if (relatedClarification) return false
  return !audit.blockers.some(item => {
    if (item.resolution !== 'human_decision' && item.resolution !== 'manual_edit') return false
    if (relatedCaseIds.has(item.subjectId ?? '')) return true
    const confirmation = run.confirmationItems.find(candidate => candidate.id === item.subjectId)
    if (confirmation?.affectedRefs.includes(requirementId) || confirmation?.affectedRefs.some(ref => relatedCaseIds.has(ref))) return true
    const finding = run.findings.find(candidate => candidate.id === item.subjectId)
    if (finding?.basisRefs.includes(requirementId)) return true
    const clarification = (run.basisSnapshot.clarifications ?? []).find(candidate => candidate.id === item.subjectId)
    return clarification?.requirementPointRefs.includes(requirementId) ?? false
  })
}
function repairBlockerCandidateIsSafe(run: TestDesignWorkflowRun, blocker: CoverageAudit['blockers'][number]) {
  const activeCases = run.testCases.filter(item => !item.tombstonedAt)
  const relatedIds = new Set<string>()
  if (blocker.subjectId && activeCases.some(item => item.id === blocker.subjectId)) relatedIds.add(blocker.subjectId)
  if (blocker.code === 'TEST_CASE_DUPLICATE' && blocker.subjectId) {
    const source = activeCases.find(item => item.id === blocker.subjectId)
    if (source) activeCases.filter(item => currentCaseRevision(item).semanticSha256 === currentCaseRevision(source).semanticSha256).forEach(item => relatedIds.add(item.id))
  }
  if (blocker.code === 'COVERAGE_REQUIREMENT_UNCOVERED' && blocker.subjectId) activeCases.filter(item => currentCaseRevision(item).content.requirementRefs.includes(blocker.subjectId!)).forEach(item => relatedIds.add(item.id))
  return [...relatedIds].every(caseId => {
    const candidate = activeCases.find(item => item.id === caseId)!
    const proposal = run.caseChangeProposals.find(item => item.candidateCaseId === candidate.id)
    return candidate.origin !== 'manual' && candidate.reviewActions.length === 0 && candidate.revisions.every(revision => revision.editorId === PLANNING_AGENT_EDITOR_ID) && (!proposal || proposal.decision === 'pending')
  })
}
function runCoverageAudit(run: TestDesignWorkflowRun): CoverageAudit { const dataSet = required(run.dataSetVersions.at(-1), 'TEST_CASE_NOT_READY', '数据需求版本不存在'); return auditTestDesignCoverage({ runId: run.id, basis: run.basisSnapshot, retrieval: run.retrievalSnapshot, historical: run.historicalSnapshot, cases: run.testCases, dimensionAssessments: run.dimensionAssessments ?? [], scenarioClaims: run.scenarioClaims ?? [], dataSet, findings: run.findings, confirmationItems: run.confirmationItems }) }
function initialAutomaticRepairState(): NonNullable<TestDesignWorkflowRun['automaticRepair']> { return { status: 'idle', attempt: 0, maxAttempts: AUTOMATIC_REPAIR_MAX_ATTEMPTS, blockerCodes: [] } }

function testCaseProjectionFiles(projectVersionName: string, version: TestCaseSetVersion, dataSet: TestDataRequirementSetVersion): TestDesignWorkspaceFile[] {
  const directory = `workspace/branches/${safeWorkspaceSegment(projectVersionName)}/test-cases`
  const casesJson = `${canonicalJson(version.canonicalContent)}\n`
  const casesMarkdown = markdownCaseSet(version)
  const dataJson = `${canonicalJson({ schemaVersion: 'test-data/v1', id: dataSet.id, version: dataSet.version, contentSha256: dataSet.contentSha256, requirements: dataSet.requirements })}\n`
  const baseFiles = [
    formalWorkspaceFile(`${directory}/test-cases.json`, 'test_case_set_version', version.id, casesJson),
    formalWorkspaceFile(`${directory}/test-cases.md`, 'test_case_set_version', version.id, casesMarkdown),
    formalWorkspaceFile(`${directory}/test-data.json`, 'test_case_set_version', version.id, dataJson),
  ]
  const manifestContent = `${canonicalJson({ schemaVersion: 'test-case-set-manifest/v1', testCaseSetVersionId: version.id, projectVersionId: version.projectVersionId, runId: version.runId, contentSha256: version.contentSha256, publishedAt: version.publishedAt, artifacts: baseFiles.map(item => ({ fileName: item.logicalPath.split('/').at(-1), mediaType: item.logicalPath.endsWith('.json') ? 'application/json' : 'text/markdown', contentSha256: item.contentSha256 })) })}\n`
  return [...baseFiles, formalWorkspaceFile(`${directory}/manifest.json`, 'test_case_set_version', version.id, manifestContent)]
}

function formalWorkspaceFile(logicalPath: string, sourceType: 'test_case_set_version', sourceId: string, content: string): TestDesignWorkspaceFile {
  return { logicalPath, sourceType, sourceId, contentSha256: canonicalSha256Text(content), content, displayName: logicalPath.split('/').at(-1) ?? logicalPath, sourceScope: 'formal_output' }
}

function normalizeWorkspacePath(value: string) { return value.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '') }
function isWithinWorkspace(value: string) { const normalized = normalizeWorkspacePath(value); return normalized === 'workspace' || normalized.startsWith('workspace/') }
function safeWorkspaceSegment(value: string) { const encode = (character: string) => `%${character.codePointAt(0)!.toString(16).toUpperCase().padStart(2, '0')}`; const source = value.normalize('NFC').trim() || '未命名版本'; let safe = source.replace(/[%<>:"/\\|?*\u0000-\u001F]/gu, encode).replace(/[. ]+$/gu, characters => [...characters].map(encode).join('')); if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(source)) safe = `${encode(source[0])}${safe.slice(1)}`; return safe }

function validateDataRequirements(run: TestDesignWorkflowRun, requirements: TestDataRequirement[]) { const caseIds = new Set(run.testCases.filter(item => !item.tombstonedAt).map(item => item.id)); const ids = new Set<string>(); return requirements.map(requirement => { if (!requirement.id || ids.has(requirement.id)) throw new TestDesignError('TEST_DATA_REQUIREMENT_SCHEMA_INVALID', '数据需求 ID 缺失或重复', 422); ids.add(requirement.id); if (!requirement.name?.trim() || !requirement.entityType?.trim() || !Number.isInteger(requirement.quantity) || requirement.quantity < 1) throw new TestDesignError('TEST_DATA_REQUIREMENT_SCHEMA_INVALID', '数据需求基础字段无效', 422); if (requirement.caseIds.some(id => !caseIds.has(id))) throw new TestDesignError('TEST_DATA_REQUIREMENT_REFERENCE_INVALID', '数据需求引用不属于当前运行', 422); const serialized = canonicalJson(requirement); if (/(api[_ -]?key|authorization|cookie|token|身份证|真实账号)\s*[:=]\s*[^<\s]/iu.test(serialized)) throw new TestDesignError('TEST_DATA_REQUIREMENT_SECRET_FORBIDDEN', '数据需求不能包含真实凭据或个人敏感数据', 422); return structuredClone(requirement) }) }
function dataSetVersion(version: number, requirements: TestDataRequirement[], actorId: string): TestDataRequirementSetVersion { return { id: `test_data_set_${randomUUID()}`, version, requirements: structuredClone(requirements), contentSha256: canonicalSha256(requirements), createdBy: actorId, createdAt: now() } }
function freezeHandoffDataRequirementSnapshot(aggregate: TestDesignState, libraryVersion: TestCaseLibraryVersion, selections: Array<{ frozenContent?: TestCaseContent }>) {
  const requiredIds = [...new Set(selections.flatMap(selection => selection.frozenContent?.dataRequirementIds ?? []))].sort((left, right) => left.localeCompare(right, 'en'))
  if (!requiredIds.length) return undefined
  const sourceRun = libraryVersion.sourceRunId ? aggregate.runs.find(item => item.id === libraryVersion.sourceRunId) : undefined
  const sourceAudit = sourceRun && libraryVersion.publicationSummary?.coverageAudit.id
    ? sourceRun.coverageAudits.find(item => item.id === libraryVersion.publicationSummary?.coverageAudit.id)
    : undefined
  const sourceSet = libraryVersion.dataRequirementSet
    ?? (sourceAudit
      ? sourceRun?.dataSetVersions.find(item => item.id === sourceAudit.dataSetVersionId)
      : sourceRun?.dataSetVersions.at(-1))
  if (!sourceSet) throw new TestDesignError('TEST_DATA_REQUIREMENT_SET_NOT_FOUND', '正式用例引用测试数据需求，但用例库版本没有保留独立数据需求快照', 409, { libraryVersionId: libraryVersion.id, requirementIds: requiredIds })
  if (canonicalSha256(sourceSet.requirements) !== sourceSet.contentSha256) throw new TestDesignError('TEST_DATA_REQUIREMENT_SET_HASH_MISMATCH', '测试数据需求快照 Hash 不一致', 409, { sourceSetId: sourceSet.id })
  const byId = new Map(sourceSet.requirements.map(requirement => [requirement.id, requirement]))
  const requirements = requiredIds.map(id => structuredClone(required(byId.get(id), 'TEST_DATA_REQUIREMENT_NOT_FOUND', `测试数据需求 ${id} 不存在于固定数据需求版本`)))
  const snapshot = { sourceSetId: sourceSet.id, sourceSetVersion: sourceSet.version, sourceSetSha256: sourceSet.contentSha256, requirements }
  return { ...snapshot, contentSha256: canonicalSha256(snapshot) }
}
function semanticContentSha256(content: TestCaseContent) { return canonicalSha256({ ...content, tags: [...content.tags].sort() }) }
function synchronizeCandidateHistoricalOrigin(testCase: TestCase, historical: HistoricalCaseSnapshot['items'][number] | undefined) {
  if (!historical) return
  testCase.historicalSourceRef = historical.id
  testCase.origin = currentCaseRevision(testCase).semanticSha256 === historical.contentSha256 ? 'historical_unchanged' : 'historical_modified'
}
function newCase(runId: string, content: TestCaseContent, origin: TestCase['origin'], actorId: string, reason: string, id = `test_case_${randomUUID()}`): TestCase { const revision = createCaseRevision(0, content, actorId, reason); return { id, runId, origin, currentRevision: 0, reviewState: 'in_review', revisions: [revision], reviewActions: [] } }
function createCaseRevision(revision: number, content: TestCaseContent, actorId: string, reason: string, previous?: TestCaseContent) { return { revision, content: structuredClone(content), contentSha256: canonicalSha256(content), semanticSha256: semanticContentSha256(content), diff: previous ? structuralDiff(previous, content) : [], editorId: actorId, reason: cleanRequired(reason, '保存说明', 2_000), createdAt: now() } }
function createLibraryRevision(revision: number, content: TestCaseContent, actorId: string, changeReason: string, sourceRunId?: string, sourceProposalId?: string, traceability?: TestCaseTraceability): LibraryTestCaseRevision { return { revision, content: structuredClone(content), contentSha256: canonicalSha256(content), semanticSha256: canonicalSha256({ ...content, tags: [...content.tags].sort() }), ...(sourceRunId ? { sourceRunId } : {}), ...(sourceProposalId ? { sourceProposalId } : {}), ...(traceability ? { traceability: structuredClone(traceability) } : {}), changeReason, createdBy: actorId, createdAt: now() } }
function currentLibraryRevision(testCase: LibraryTestCase) { return required(testCase.revisions.find(item => item.revision === testCase.currentRevision), 'LIBRARY_TEST_CASE_REVISION_NOT_FOUND', '正式用例当前 Revision 不存在') }
function libraryCaseEtag(testCase: LibraryTestCase, revision = currentLibraryRevision(testCase)) { return `"library-case:${testCase.id}:r${revision.revision}:${canonicalSha256({ contentSha256: revision.contentSha256, status: testCase.status, updatedAt: testCase.updatedAt })}"` }
function presentLibraryCase(testCase: LibraryTestCase, detail = false) { const revision = currentLibraryRevision(testCase); return { id: testCase.id, projectId: testCase.projectId, currentRevision: testCase.currentRevision, status: testCase.status, content: structuredClone(revision.content), contentSha256: revision.contentSha256, semanticSha256: revision.semanticSha256, createdAt: testCase.createdAt, updatedAt: testCase.updatedAt, etag: libraryCaseEtag(testCase, revision), ...(detail ? { revisions: structuredClone(testCase.revisions) } : {}) } }
function findLibraryCase(state: DatabaseState, projectId: string, caseId: string) { return required(designState(state).libraryCases.find(item => item.id === caseId && item.projectId === projectId), 'LIBRARY_TEST_CASE_NOT_FOUND', '正式测试用例不存在') }
function assertProjectExists(state: DatabaseState, projectId: string) { required(state.projects.find(item => item.id === projectId), 'PROJECT_NOT_FOUND', '项目不存在') }
function executionMethodForContent(content: TestCaseContent): TestExecutionMethod { if (content.dimension === 'functional' || content.dimension === 'security') return content.executionMethods?.[0]?.method ?? content.executionSpec?.method ?? 'ui'; if (content.executionSpec) return content.executionSpec.method; if (content.dimension === 'performance') return 'performance_tool'; if (content.dimension === 'stability') return 'long_running'; if (content.dimension === 'compatibility') return 'environment_matrix'; return 'ui' }
function executionMethodsForContent(content: TestCaseContent): TestExecutionMethod[] { if (content.dimension !== 'functional' && content.dimension !== 'security') return [executionMethodForContent(content)]; if (content.executionMethods?.length) return content.executionMethods.map(item => item.method); return content.executionSpec?.kind === 'functional' ? [content.executionSpec.method] : [] }
function executionSpecForMethod(content: TestCaseContent, executionMethod: TestExecutionMethod) {
  if (content.dimension !== 'functional' && content.dimension !== 'security') {
    const spec = required(content.executionSpec, 'TEST_EXECUTION_CASE_NOT_READY', '正式用例缺少 executionSpec')
    if (spec.method !== executionMethod) throw new TestDesignError('TEST_SUITE_EXECUTION_METHOD_INVALID', '套件执行方式与冻结 Revision 的执行配置不一致', 422)
    return structuredClone(spec)
  }
  if (executionMethod !== 'ui' && executionMethod !== 'api') throw new TestDesignError('TEST_SUITE_EXECUTION_METHOD_INVALID', '功能或安全用例只支持 UI/API 执行方式', 422)
  const method = content.executionMethods?.find(item => item.method === executionMethod)
  if (!method) {
    const legacy = required(content.executionSpec && content.executionSpec.kind === 'functional' && content.executionSpec.method === executionMethod ? content.executionSpec : undefined, 'TEST_SUITE_EXECUTION_METHOD_INVALID', '冻结 Revision 未选择该执行方式')
    return { ...structuredClone(legacy), preconditions: structuredClone(content.preconditions), testDataRequirements: structuredClone(content.dataRequirementIds), executionReadiness: 'needs_confirmation' as const, automationHint: legacy.automationHint || '历史用例缺少独立执行入口，待人工补充' }
  }
  return { kind: 'functional' as const, method: method.method, steps: structuredClone(method.steps), verificationChecks: structuredClone(method.verificationChecks), preconditions: structuredClone(content.preconditions), testDataRequirements: structuredClone(content.dataRequirementIds), executionReadiness: method.executionReadiness, automationHint: method.automationHint }
}
function concreteExecutionValue(value: unknown) { return typeof value === 'string' && Boolean(value.trim()) && !/(?:待确认|待补充|未提供|未知|legacy-untraced)/iu.test(value) }
function executionConfigurationForMethod(content: TestCaseContent, executionMethod: TestExecutionMethod): { status: 'ready' | 'needs_confirmation' | 'blocked'; issues: string[] } {
  const spec = executionSpecForMethod(content, executionMethod)
  const issues: string[] = []
  if (spec.kind === 'functional') {
    if (!spec.steps.length || spec.steps.some(step => !concreteExecutionValue(step.action) || !concreteExecutionValue(step.expected))) issues.push('功能用例缺少完整执行步骤和预期结果')
    const method = content.executionMethods?.find(item => item.method === spec.method)
    if (!method) issues.push('功能用例 executionSpec.method 没有对应执行入口')
    else if (method.method === 'ui' && !concreteExecutionValue(method.uiSpec.entry)) issues.push('功能 UI 用例缺少明确 UI 入口')
    else if (method.method === 'ui' && !method.uiSpec.selectors?.some(concreteExecutionValue)) issues.push('功能 UI 用例缺少可执行 selector')
    else if (method.method === 'api' && (!concreteExecutionValue(method.apiSpec.method) || !concreteExecutionValue(method.apiSpec.path))) issues.push('功能 API 用例缺少完整请求方法或路径')
  } else if (spec.kind === 'performance') {
    if (!spec.thresholds.length || spec.thresholds.some(threshold => !concreteExecutionValue(threshold.metric) || !concreteExecutionValue(threshold.target) || !concreteExecutionValue(threshold.sourceRef))) issues.push('性能用例缺少有效阈值或阈值来源')
  } else if (spec.kind === 'stability') {
    if (!concreteExecutionValue(spec.duration)) issues.push('稳定性用例缺少运行时长')
  } else if (![...spec.browserMatrix, ...spec.operatingSystemMatrix, ...spec.viewportMatrix, ...spec.versionMatrix].some(concreteExecutionValue)) issues.push('兼容性用例缺少环境矩阵')
  const status = spec.executionReadiness === 'blocked' ? 'blocked' : issues.length || spec.executionReadiness === 'needs_confirmation' ? 'needs_confirmation' : 'ready'
  return { status, issues }
}
function executionConfiguration(content: TestCaseContent): { status: 'ready' | 'needs_confirmation' | 'blocked'; issues: string[] } {
  const configurations = executionMethodsForContent(content).map(method => ({ method, configuration: executionConfigurationForMethod(content, method) }))
  const status = configurations.some(item => item.configuration.status === 'blocked') ? 'blocked' : configurations.some(item => item.configuration.status === 'needs_confirmation') ? 'needs_confirmation' : 'ready'
  return { status, issues: configurations.flatMap(item => item.configuration.issues.map(issue => `${item.method}: ${issue}`)) }
}
function freezeLibraryVersionMember(aggregate: TestDesignState, projectId: string, member: { caseId: string; revision: number; ordinal: number; contentSha256: string }) {
  const testCase = required(aggregate.libraryCases.find(item => item.id === member.caseId && item.projectId === projectId), 'LIBRARY_TEST_CASE_NOT_FOUND', '正式用例库成员不存在')
  const revision = required(testCase.revisions.find(item => item.revision === member.revision), 'LIBRARY_TEST_CASE_REVISION_NOT_FOUND', '正式用例库成员 Revision 不存在')
  if (revision.contentSha256 !== member.contentSha256 || canonicalSha256(revision.content) !== member.contentSha256) throw new TestDesignError('TEST_CASE_LIBRARY_MEMBER_HASH_MISMATCH', '用例库成员冻结内容 Hash 与成员记录不一致', 409, { caseId: member.caseId, revision: member.revision, expectedSha256: member.contentSha256, actualSha256: revision.contentSha256 })
  if (revision.traceability) assertTraceabilityMatchesContent(revision.content, revision.traceability)
  return { ...member, frozenContent: structuredClone(revision.content), frozenExecutionMethods: executionMethodsForContent(revision.content).filter((method): method is 'ui' | 'api' => method === 'ui' || method === 'api'), ...(revision.traceability ? { traceability: structuredClone(revision.traceability) } : {}), executionReadiness: executionConfiguration(revision.content).status }
}
function presentLibraryVersion(aggregate: TestDesignState, version: TestCaseLibraryVersion): TestCaseLibraryVersionDetail {
  const members = version.members.map(member => {
    const frozen = member.frozenContent
    if (frozen && canonicalSha256(frozen) !== member.contentSha256) throw new TestDesignError('TEST_CASE_LIBRARY_MEMBER_HASH_MISMATCH', '用例库版本冻结内容 Hash 与成员记录不一致', 409, { versionId: version.id, caseId: member.caseId, revision: member.revision })
    const detail = freezeLibraryVersionMember(aggregate, version.projectId, member)
    if (frozen && canonicalSha256(frozen) !== canonicalSha256(detail.frozenContent)) throw new TestDesignError('TEST_CASE_LIBRARY_MEMBER_HASH_MISMATCH', '用例库版本冻结内容与不可变 Revision 不一致', 409, { versionId: version.id, caseId: member.caseId, revision: member.revision })
    return detail
  })
  return structuredClone({ ...version, members }) as TestCaseLibraryVersionDetail
}
function traceabilityRelevantContentChanged(before: TestCaseContent, after: TestCaseContent) { return canonicalSha256({ requirementRefs: before.requirementRefs, dataRequirementIds: before.dataRequirementIds, dimension: before.dimension, objective: before.objective }) !== canonicalSha256({ requirementRefs: after.requirementRefs, dataRequirementIds: after.dataRequirementIds, dimension: after.dimension, objective: after.objective }) }
function dynamicTraceabilityReference(value: string) { return /^(?:latest|active|current)(?:$|[:/@_-])/iu.test(value) }
function assertTraceabilityMatchesContent(content: TestCaseContent, traceability: TestCaseTraceability) {
  if (!traceability.sourceRequirementReleaseId || dynamicTraceabilityReference(traceability.sourceRequirementReleaseId) || !traceability.requirementRefs.length || traceability.requirementRefs.some(item => item.requirementReleaseId !== traceability.sourceRequirementReleaseId || dynamicTraceabilityReference(item.requirementReleaseId))) throw new TestDesignError('LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH', 'requirementRefs 必须引用同一个固定 Requirement Release ID，禁止 latest、active、current 等动态引用', 422)
  const contentRefs = new Set(content.requirementRefs)
  if (contentRefs.size !== traceability.requirementRefs.length || traceability.requirementRefs.some(item => !contentRefs.has(item.requirementId))) throw new TestDesignError('LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH', '测试用例 Requirement 引用必须与正式追溯一致', 422)
}
function validateLibraryTraceability(state: DatabaseState, projectId: string, content: TestCaseContent, value: unknown): TestCaseTraceability {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TestDesignError('LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH', 'traceability 必须是对象', 422)
  const input = value as Record<string, unknown>
  const sourceRequirementReleaseId = cleanRequired(input.sourceRequirementReleaseId, 'traceability.sourceRequirementReleaseId', 500)
  const requirementRefs = Array.isArray(input.requirementRefs) ? input.requirementRefs.map((candidate, index) => { if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new TestDesignError('LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH', `traceability.requirementRefs[${index}] 无效`, 422); const item = candidate as Record<string, unknown>; return { requirementReleaseId: cleanRequired(item.requirementReleaseId, `traceability.requirementRefs[${index}].requirementReleaseId`, 500), requirementId: cleanRequired(item.requirementId, `traceability.requirementRefs[${index}].requirementId`, 500) } }) : []
  const traceability = { sourceRequirementReleaseId, requirementRefs }
  const duplicateRequirementRefs = new Set(requirementRefs.map(item => `${item.requirementReleaseId}\u0000${item.requirementId}`)).size !== requirementRefs.length
  if (duplicateRequirementRefs) throw new TestDesignError('LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH', '同一 Requirement 引用不得重复', 422)
  const fixedReleaseExists = state.reviewRuns.some(run => run.workflow?.release?.id === sourceRequirementReleaseId && run.workflow.release.status === 'published' && state.projectVersions.some(version => version.id === run.projectVersionId && version.projectId === projectId))
  if (!fixedReleaseExists) throw new TestDesignError('LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH', 'Requirement Release ID 不属于当前项目的已发布固定版本', 422, { sourceRequirementReleaseId })
  assertTraceabilityMatchesContent(content, traceability)
  return traceability
}
function caseChangeProposalSha256(proposals: CaseChangeProposal[]) { return canonicalSha256(proposals.map(item => ({ id: item.id, operation: item.operation, ...(item.sourceCaseId ? { sourceCaseId: item.sourceCaseId } : {}), ...(item.sourceRevision !== undefined ? { sourceRevision: item.sourceRevision } : {}), ...(item.candidateCaseId ? { candidateCaseId: item.candidateCaseId } : {}), ...(item.candidateContent ? { candidateContentSha256: canonicalSha256(item.candidateContent) } : {}), decision: item.decision, decisionVersion: item.decisions.length })).sort((left, right) => left.id.localeCompare(right.id))) }
function proposalSourceContent(run: TestDesignWorkflowRun, proposal: CaseChangeProposal): TestCaseContent | undefined { if (!proposal.sourceCaseId || proposal.sourceRevision === undefined) return undefined; return run.historicalSnapshot.items.find(item => { const locator = item.locator as { caseId?: unknown; revision?: unknown } | undefined; return locator?.caseId === proposal.sourceCaseId && locator?.revision === proposal.sourceRevision })?.content as TestCaseContent | undefined }
function isUnchangedReuseProposal(run: TestDesignWorkflowRun, proposal: CaseChangeProposal) {
  if (proposal.operation !== 'reuse' || !proposal.candidateCaseId || !proposal.sourceCaseId || proposal.sourceRevision === undefined) return false
  const candidate = run.testCases.find(item => item.id === proposal.candidateCaseId && !item.tombstonedAt)
  const source = proposalSourceContent(run, proposal)
  return Boolean(candidate && source && candidate.origin === 'historical_unchanged' && candidate.reviewActions.length === 0 && candidate.revisions.every(revision => revision.editorId === PLANNING_AGENT_EDITOR_ID) && currentCaseRevision(candidate).semanticSha256 === semanticContentSha256(source))
}
function requiresHumanProposalDecision(proposal: CaseChangeProposal) { return proposal.operation === 'deprecate' || proposal.operation === 'reference' }
function resetProposalDecision(proposal: CaseChangeProposal) {
  proposal.decision = 'pending'
  delete proposal.decidedBy
  delete proposal.decidedAt
  delete proposal.appliedCaseId
  delete proposal.appliedRevision
}
function ensureCandidateProposal(run: TestDesignWorkflowRun, testCase: TestCase, reason: string) {
  const revision = currentCaseRevision(testCase)
  const existing = run.caseChangeProposals.find(item => item.candidateCaseId === testCase.id)
  const source = existing ? proposalSourceContent(run, existing) : undefined
  const operation: CaseChangeProposal['operation'] = source ? (revision.semanticSha256 === semanticContentSha256(source) ? 'reuse' : 'update') : 'create'
  if (!existing) {
    run.caseChangeProposals.push({ id: `case_change_proposal_${randomUUID()}`, runId: run.id, operation, candidateCaseId: testCase.id, candidateContent: structuredClone(revision.content), diff: [], requirementRefs: requirementRefsForCase(run, revision.content), reason, confidence: 1, decision: 'pending', createdAt: now(), decisions: [] })
    return
  }
  const changed = existing.operation !== operation || !existing.candidateContent || semanticContentSha256(existing.candidateContent) !== revision.semanticSha256
  existing.operation = operation
  existing.candidateContent = structuredClone(revision.content)
  existing.diff = source ? structuralDiff(source, revision.content) : []
  existing.requirementRefs = requirementRefsForCase(run, revision.content)
  existing.reason = reason
  if (changed) resetProposalDecision(existing)
}
function convertDeletedCandidateProposal(run: TestDesignWorkflowRun, testCase: TestCase) {
  const proposal = run.caseChangeProposals.find(item => item.candidateCaseId === testCase.id)
  if (!proposal) return
  if (!proposal.sourceCaseId || proposal.sourceRevision === undefined) {
    run.caseChangeProposals = run.caseChangeProposals.filter(item => item.id !== proposal.id)
    return
  }
  proposal.operation = 'deprecate'
  proposal.reason = '人工删除当前候选用例；废弃正式历史 Case 需要显式确认'
  proposal.diff = []
  delete proposal.candidateCaseId
  delete proposal.candidateContent
  resetProposalDecision(proposal)
}
function reconcileAutomaticProposalDecisions(run: TestDesignWorkflowRun) {
  for (const proposal of run.caseChangeProposals) {
    if (proposal.decision !== 'pending' || requiresHumanProposalDecision(proposal)) continue
    const candidate = proposal.candidateCaseId ? run.testCases.find(item => item.id === proposal.candidateCaseId && !item.tombstonedAt) : undefined
    const eligible = isUnchangedReuseProposal(run, proposal)
      || ((proposal.operation === 'create' || proposal.operation === 'update') && candidate?.reviewState === 'approved')
    if (!eligible) continue
    const decidedAt = now()
    proposal.decision = 'accepted'
    proposal.decidedBy = TEST_DESIGN_SERVICE_ACTOR_ID
    proposal.decidedAt = decidedAt
    proposal.decisions.push({ id: `case_change_decision_${randomUUID()}`, expectedVersion: proposal.decisions.length, decision: 'accepted', comment: proposal.operation === 'reuse' ? 'Service 自动接受与冻结 Snapshot 一致的未变化复用' : 'Service 随当前 TestCase Revision 审核通过自动接受', decidedBy: TEST_DESIGN_SERVICE_ACTOR_ID, decidedAt })
  }
}
function validateProposalDecision(proposal: CaseChangeProposal, decision: Exclude<CaseChangeDecision, 'pending'>) { const allowed: Record<CaseChangeProposal['operation'], Array<Exclude<CaseChangeDecision, 'pending'>>> = { reuse: [], update: [], create: [], deprecate: ['deprecated', 'keep_original'], reference: ['reference', 'rejected'] }; if (!allowed[proposal.operation].includes(decision)) throw new TestDesignError('CASE_CHANGE_PROPOSAL_DECISION_INVALID', `${proposal.operation} 不允许决策 ${decision}`, 422) }
function traceabilityForProposal(run: TestDesignWorkflowRun, proposal: CaseChangeProposal, content: TestCaseContent): TestCaseTraceability {
  const releaseId = run.basisSnapshot.requirementReleaseId
  const referencedBasis = new Set([...(proposal.requirementRefs ?? []), ...requirementRefsForCase(run, content)])
  const requirementRefs = run.basisSnapshot.items.flatMap(item => {
    const locator = item.locator as { requirementReleaseId?: unknown; requirementPointId?: unknown } | undefined
    if (item.kind !== 'requirement_release' || (!referencedBasis.has(item.id) && !referencedBasis.has(String(locator?.requirementPointId ?? '')))) return []
    const requirementId = String(locator?.requirementPointId ?? '').trim()
    return requirementId ? [{ requirementReleaseId: releaseId, requirementId }] : []
  })
  return {
    sourceRequirementReleaseId: releaseId,
    requirementRefs: [...new Map(requirementRefs.map(item => [`${item.requirementReleaseId}:${item.requirementId}`, item])).values()],
  }
}
function assertLibraryPublicationGates(aggregate: TestDesignState, projectId: string, run: TestDesignWorkflowRun) {
  const unreviewed = run.testCases.filter(item => !item.tombstonedAt && item.reviewState !== 'approved')
  if (unreviewed.length) throw new TestDesignError('TEST_CASE_REVIEW_REQUIRED', '所有候选用例必须完成人工审核', 409, { caseIds: unreviewed.map(item => item.id) })
  const pendingProposals = run.caseChangeProposals.filter(item => item.decision === 'pending' && requiresHumanProposalDecision(item))
  if (pendingProposals.length) throw new TestDesignError('CASE_CHANGE_PROPOSAL_DECISION_REQUIRED', '高风险用例库变更必须先完成人工处置', 409, { proposalIds: pendingProposals.map(item => item.id) })
  const blockingFindings = run.findings.filter(item => item.severity === 'blocker' && item.state !== 'resolved' && item.state !== 'rejected')
  if (blockingFindings.length) throw new TestDesignError('TEST_CASE_LIBRARY_PUBLICATION_BLOCKED', '阻断级 Finding 尚未处理', 409, { findingIds: blockingFindings.map(item => item.id) })
  const blockingConfirmations = run.confirmationItems.filter(item => item.blocker && item.impactStage !== 'handoff' && item.state !== 'resolved' && item.state !== 'rejected')
  if (blockingConfirmations.length) throw new TestDesignError('TEST_CASE_LIBRARY_PUBLICATION_BLOCKED', '阻断发布的待确认项尚未处理', 409, { confirmationItemIds: blockingConfirmations.map(item => item.id) })
  for (const suite of aggregate.suiteVersions.filter(item => item.projectId === projectId)) for (const member of suite.members) {
    const testCase = aggregate.libraryCases.find(item => item.id === member.caseId && item.projectId === projectId)
    if (!testCase?.revisions.some(item => item.revision === member.revision)) throw new TestDesignError('LIBRARY_TEST_CASE_REVISION_CONFLICT', '已发布套件引用的正式用例 Revision 不存在', 409, { suiteVersionId: suite.id, caseId: member.caseId, revision: member.revision })
  }
  for (const handoff of aggregate.executionHandoffs.filter(item => item.projectId === projectId && item.testCaseLibraryVersionId)) for (const member of handoff.members) {
    const testCase = aggregate.libraryCases.find(item => item.id === member.caseId && item.projectId === projectId)
    if (!testCase?.revisions.some(item => item.revision === member.revision)) throw new TestDesignError('LIBRARY_TEST_CASE_REVISION_CONFLICT', 'Execution Handoff 引用的正式用例 Revision 不存在', 409, { handoffId: handoff.id, caseId: member.caseId, revision: member.revision })
  }
}
function assertProposalSourcesCurrent(aggregate: TestDesignState, projectId: string, run: TestDesignWorkflowRun, baseline?: TestCaseLibraryVersion) {
  const baselineMembers = new Map((baseline?.members ?? []).map(item => [item.caseId, item]))
  for (const proposal of run.caseChangeProposals) {
    if (!proposal.sourceCaseId || proposal.sourceRevision === undefined || proposal.decision === 'rejected' || proposal.decision === 'reference') continue
    const baselineMember = baselineMembers.get(proposal.sourceCaseId)
    if (!baselineMember || baselineMember.revision !== proposal.sourceRevision) throw new TestDesignError('CASE_CHANGE_PROPOSAL_SOURCE_STALE', 'Proposal 来源不再是运行冻结基线中的 Revision', 409, { proposalId: proposal.id, sourceCaseId: proposal.sourceCaseId, sourceRevision: proposal.sourceRevision })
    const source = aggregate.libraryCases.find(item => item.id === proposal.sourceCaseId && item.projectId === projectId)
    const revision = source?.revisions.find(item => item.revision === proposal.sourceRevision)
    if (!source || !revision || revision.contentSha256 !== baselineMember.contentSha256 || canonicalSha256(revision.content) !== baselineMember.contentSha256) throw new TestDesignError('CASE_CHANGE_PROPOSAL_SOURCE_STALE', 'Proposal 来源冻结 Revision 不存在或内容已损坏', 409, { proposalId: proposal.id, sourceCaseId: proposal.sourceCaseId, sourceRevision: proposal.sourceRevision })
  }
}
function assertLibraryBaselineMembersCurrent(aggregate: TestDesignState, projectId: string, run: TestDesignWorkflowRun, baseline?: TestCaseLibraryVersion) {
  for (const member of baseline?.members ?? []) {
    const correspondingProposal = run.caseChangeProposals.find(proposal => proposal.sourceCaseId === member.caseId && proposal.sourceRevision === member.revision && !['pending', 'rejected', 'reference'].includes(proposal.decision))
    if (correspondingProposal) continue
    const testCase = aggregate.libraryCases.find(item => item.id === member.caseId && item.projectId === projectId)
    if (!testCase) throw new TestDesignError('TEST_CASE_LIBRARY_BASE_MEMBER_CHANGED', '基线成员在任务运行期间被移除', 409, { caseId: member.caseId, revision: member.revision })
    const revision = testCase.revisions.find(item => item.revision === member.revision)
    if (!revision || revision.contentSha256 !== member.contentSha256 || canonicalSha256(revision.content) !== member.contentSha256) throw new TestDesignError('TEST_CASE_LIBRARY_BASE_MEMBER_CHANGED', 'Run 冻结的基线成员 Revision 不存在或内容 Hash 已损坏', 409, { caseId: member.caseId, expectedRevision: member.revision, expectedSha256: member.contentSha256, actualSha256: revision?.contentSha256 })
  }
}
function buildLegacyMigrationPreview(aggregate: TestDesignState, projectId: string, legacyTestCaseSetVersionId: string) {
  const migrated = aggregate.legacyMigrations.find(item => item.projectId === projectId && item.legacyTestCaseSetVersionId === legacyTestCaseSetVersionId)
  if (migrated) return { legacyTestCaseSetVersionId, status: 'migrated' as const, previewSha256: migrated.previewSha256, testCaseLibraryVersionId: migrated.testCaseLibraryVersionId, items: migrated.mappings.map(mapping => { const content = aggregate.libraryCases.find(item => item.id === mapping.libraryCaseId)?.revisions.find(item => item.revision === mapping.libraryRevision)?.content; const configuration = content ? executionConfiguration(content) : { status: 'blocked' as const, issues: ['冻结 Revision 内容不存在'] }; return { legacyCaseId: mapping.legacyCaseId, legacyRevision: mapping.legacyRevision, suggestedLibraryCaseId: mapping.libraryCaseId, resolution: 'reuse_identical' as const, content, executionConfigurationStatus: configuration.status, executionConfigurationIssues: configuration.issues } }) }
  const legacy = required(aggregate.caseSetVersions.find(item => item.id === legacyTestCaseSetVersionId && item.projectId === projectId), 'TEST_CASE_SET_NOT_FOUND', '历史已发布用例集不存在')
  const content = legacy.canonicalContent as { cases?: Array<{ caseId?: unknown; revision?: unknown; content?: unknown }> }
  const sourceCases = Array.isArray(content?.cases) ? content.cases : []
  if (!sourceCases.length) throw new TestDesignError('LEGACY_TEST_CASE_MIGRATION_SOURCE_INVALID', '历史用例集缺少可迁移的结构化用例内容', 409)
  const items = sourceCases.map((source, index) => {
    const legacyCaseId = cleanRequired(source.caseId, `cases[${index}].caseId`, 500)
    const legacyRevision = Number(source.revision)
    if (!Number.isInteger(legacyRevision) || legacyRevision < 0) throw new TestDesignError('LEGACY_TEST_CASE_MIGRATION_SOURCE_INVALID', `cases[${index}].revision 无效`, 409)
    const normalized = normalizeLegacyCaseContent(source.content)
    const priorMapping = aggregate.legacyMigrations.filter(record => record.projectId === projectId).flatMap(record => record.mappings).find(mapping => mapping.legacyCaseId === legacyCaseId)
    const globallyOccupied = aggregate.libraryCases.find(item => item.id === legacyCaseId && item.projectId !== projectId)
    const suggestedLibraryCaseId = priorMapping?.libraryCaseId ?? (globallyOccupied ? `library_test_case_legacy_${canonicalSha256(`${projectId}:${legacyCaseId}`).slice(0, 24)}` : legacyCaseId)
    const existing = aggregate.libraryCases.find(item => item.id === suggestedLibraryCaseId && item.projectId === projectId)
    const identical = existing?.revisions.find(revision => revision.contentSha256 === canonicalSha256(normalized))
    const resolution = identical ? 'reuse_identical' as const : existing && !priorMapping ? 'needs_confirmation' as const : existing ? 'create_revision' as const : 'create' as const
    const configuration = executionConfiguration(normalized)
    return { legacyCaseId, legacyRevision, suggestedLibraryCaseId, resolution, content: normalized, executionConfigurationStatus: configuration.status, executionConfigurationIssues: configuration.issues }
  })
  const previewBody = { schemaVersion: 'legacy-test-case-migration-preview/v2', projectId, legacyTestCaseSetVersionId, sourceSha256: legacy.contentSha256, items: items.map(({ content: caseContent, ...item }) => ({ ...item, contentSha256: canonicalSha256(caseContent) })) }
  return { ...previewBody, status: items.some(item => item.resolution === 'needs_confirmation' || item.executionConfigurationStatus !== 'ready') ? 'needs_confirmation' as const : 'ready' as const, previewSha256: canonicalSha256(previewBody), items }
}
function normalizeLegacyCaseContent(value: unknown): TestCaseContent {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? structuredClone(value) as Partial<TestCaseContent> : {}
  const dimension = ['functional', 'performance', 'stability', 'compatibility', 'security'].includes(String(input.dimension)) ? input.dimension as TestCaseContent['dimension'] : 'functional'
  const fallbackMethod = { method: 'ui' as const, uiSpec: { entry: '历史数据未提供 UI 入口' }, executionReadiness: 'needs_confirmation' as const, steps: [{ key: 'legacy-step-1', action: '历史用例未提供结构化执行步骤，等待人工补充', expected: '人工确认历史预期结果' }], verificationChecks: [], automationHint: '历史迁移后待人工确认' }
  const executionMethods = Array.isArray(input.executionMethods) && input.executionMethods.length ? input.executionMethods : dimension === 'functional' || dimension === 'security' ? [fallbackMethod] : []
  const executionSpec = input.executionSpec ?? (dimension === 'performance'
    ? { kind: 'performance' as const, method: 'performance_tool' as const, target: '历史用例未提供性能目标', scenario: '历史用例未提供性能场景', virtualUsers: null, duration: null, rampUp: null, thresholds: [], dataStrategy: '历史用例未提供数据策略', environmentRequirements: [], executionReadiness: 'needs_confirmation' as const }
    : dimension === 'stability'
      ? { kind: 'stability' as const, method: 'long_running' as const, workload: '历史用例未提供稳定性负载', duration: null, interval: null, observations: [], recoveryPolicy: null, checkpointPolicy: null, environmentRequirements: [], executionReadiness: 'needs_confirmation' as const }
      : dimension === 'compatibility'
        ? { kind: 'compatibility' as const, method: 'environment_matrix' as const, baseMethod: 'ui' as const, baseCaseRefs: [], browserMatrix: [], operatingSystemMatrix: [], viewportMatrix: [], versionMatrix: [], expectedConsistency: '历史用例未提供兼容性一致性标准', executionReadiness: 'needs_confirmation' as const }
        : undefined)
  const normalized = validateTestCaseContent({
    schemaVersion: 'test-case/v2',
    title: typeof input.title === 'string' && input.title.trim() ? input.title : '历史测试用例',
    objective: typeof input.objective === 'string' && input.objective.trim() ? input.objective : '历史用例未提供测试目标，等待人工补充',
    dimension,
    requirementRefs: Array.isArray(input.requirementRefs) ? input.requirementRefs : [],
    priority: ['P0', 'P1', 'P2', 'P3'].includes(String(input.priority)) ? input.priority : 'P2',
    preconditions: Array.isArray(input.preconditions) ? input.preconditions : [],
    dataRequirementIds: Array.isArray(input.dataRequirementIds) ? input.dataRequirementIds : [],
    cleanup: Array.isArray(input.cleanup) ? input.cleanup : [],
    dependencies: [],
    executionMethods,
    ...(executionSpec ? { executionSpec } : {}),
    sharedVerificationChecks: Array.isArray(input.sharedVerificationChecks) ? input.sharedVerificationChecks : [],
    tags: [...new Set([...(Array.isArray(input.tags) ? input.tags : []), 'legacy-migrated'])],
    domain: typeof input.domain === 'string' && input.domain.trim() ? input.domain : '历史迁移',
  })
  const configuration = executionConfiguration(normalized)
  if (normalized.executionSpec && configuration.status !== normalized.executionSpec.executionReadiness) normalized.executionSpec = { ...normalized.executionSpec, executionReadiness: configuration.status }
  if (normalized.executionSpec?.kind === 'functional') normalized.executionMethods = normalized.executionMethods.map(method => method.method === normalized.executionSpec!.method ? { ...method, executionReadiness: normalized.executionSpec!.executionReadiness } : method)
  return normalized
}
function applyProposalToLibrary(aggregate: TestDesignState, projectId: string, run: TestDesignWorkflowRun, proposal: CaseChangeProposal, members: Map<string, { caseId: string; revision: number; ordinal: number; contentSha256: string }>, actorId: string) {
  if (proposal.decision === 'pending') throw new TestDesignError('CASE_CHANGE_PROPOSAL_DECISION_REQUIRED', 'Proposal 尚未处置', 409)
  const source = proposal.sourceCaseId ? required(aggregate.libraryCases.find(item => item.id === proposal.sourceCaseId && item.projectId === projectId), 'LIBRARY_TEST_CASE_NOT_FOUND', 'Proposal 来源正式用例不存在') : undefined
  const sourceRevision = source && proposal.sourceRevision !== undefined ? required(source.revisions.find(item => item.revision === proposal.sourceRevision), 'LIBRARY_TEST_CASE_REVISION_NOT_FOUND', 'Proposal 来源 Revision 不存在') : undefined
  const candidate = proposal.candidateCaseId ? required(run.testCases.find(item => item.id === proposal.candidateCaseId && !item.tombstonedAt), 'CASE_CHANGE_PROPOSAL_CANDIDATE_INVALID', 'Proposal 候选用例不存在') : undefined
  const candidateRevision = candidate ? currentCaseRevision(candidate) : undefined
  if (candidate && candidate.reviewState !== 'approved') throw new TestDesignError('TEST_CASE_REVIEW_REQUIRED', `Proposal 候选用例 ${candidate.id} 未批准`, 409)
  if (proposal.decision === 'reference') { if (source) members.delete(source.id); return }
  if (proposal.decision === 'rejected') return
  if (proposal.decision === 'keep_original') { if (source && sourceRevision) members.set(source.id, { caseId: source.id, revision: sourceRevision.revision, ordinal: 0, contentSha256: sourceRevision.contentSha256 }); return }
  if (proposal.operation === 'reuse') { const testCase = required(source, 'LIBRARY_TEST_CASE_NOT_FOUND', '复用来源用例不存在'); const revision = required(sourceRevision, 'LIBRARY_TEST_CASE_REVISION_NOT_FOUND', '复用来源 Revision 不存在'); members.set(testCase.id, { caseId: testCase.id, revision: revision.revision, ordinal: 0, contentSha256: revision.contentSha256 }); proposal.appliedCaseId = testCase.id; proposal.appliedRevision = revision.revision; return }
  if (proposal.operation === 'update') { const testCase = required(source, 'LIBRARY_TEST_CASE_NOT_FOUND', '修改来源用例不存在'); const content = required(candidateRevision?.content, 'CASE_CHANGE_PROPOSAL_CANDIDATE_INVALID', '修改 Proposal 缺少候选内容'); const revision = createLibraryRevision(testCase.currentRevision + 1, content, actorId, proposal.reason, run.id, proposal.id, traceabilityForProposal(run, proposal, content)); testCase.revisions.push(revision); testCase.currentRevision = revision.revision; testCase.status = 'active'; testCase.updatedAt = revision.createdAt; members.set(testCase.id, { caseId: testCase.id, revision: revision.revision, ordinal: 0, contentSha256: revision.contentSha256 }); proposal.appliedCaseId = testCase.id; proposal.appliedRevision = revision.revision; return }
  if (proposal.operation === 'create') { const content = required(candidateRevision?.content, 'CASE_CHANGE_PROPOSAL_CANDIDATE_INVALID', '新增 Proposal 缺少候选内容'); const createdAt = now(); const revision = createLibraryRevision(1, content, actorId, proposal.reason, run.id, proposal.id, traceabilityForProposal(run, proposal, content)); const testCase: LibraryTestCase = { id: `library_test_case_${randomUUID()}`, projectId, currentRevision: 1, status: 'active', createdAt, updatedAt: createdAt, revisions: [revision] }; aggregate.libraryCases.push(testCase); members.set(testCase.id, { caseId: testCase.id, revision: 1, ordinal: 0, contentSha256: revision.contentSha256 }); proposal.appliedCaseId = testCase.id; proposal.appliedRevision = 1; return }
  if (proposal.operation === 'deprecate' && proposal.decision === 'deprecated') { const testCase = required(source, 'LIBRARY_TEST_CASE_NOT_FOUND', '废弃来源用例不存在'); testCase.status = 'deprecated'; testCase.updatedAt = now(); members.delete(testCase.id); proposal.appliedCaseId = testCase.id; proposal.appliedRevision = testCase.currentRevision }
}

function suiteDraftInput(raw: unknown): { suiteKey: string; suiteType: 'smoke' | 'regression' | 'custom'; name: string; testCaseLibraryVersionId: string; confirmLibraryVersionChange: boolean; members: Array<{ testCaseLibraryVersionId?: string; caseId: string; executionMethods?: Array<'ui' | 'api'>; executionMethod?: TestExecutionMethod; reason: string }> } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TestDesignError('TEST_SUITE_DRAFT_INVALID', '套件草稿必须是对象', 422)
  const input = raw as Record<string, unknown>
  const suiteType = String(input.suiteType)
  if (!['smoke', 'regression', 'custom'].includes(suiteType)) throw new TestDesignError('TEST_SUITE_DRAFT_INVALID', 'suiteType 必须为 smoke、regression 或 custom', 422)
  if (!Array.isArray(input.members) || input.members.length > 10_000) throw new TestDesignError('TEST_SUITE_DRAFT_INVALID', 'members 必须是最多 10000 项的数组', 422)
  const memberVersionIds = [...new Set(input.members.flatMap(candidate => candidate && typeof candidate === 'object' && !Array.isArray(candidate) && typeof (candidate as Record<string, unknown>).testCaseLibraryVersionId === 'string' ? [String((candidate as Record<string, unknown>).testCaseLibraryVersionId).trim()] : []).filter(Boolean))]
  const selectedVersionId = input.testCaseLibraryVersionId ?? (memberVersionIds.length === 1 ? memberVersionIds[0] : undefined)
  return {
    suiteKey: cleanRequired(input.suiteKey, 'suiteKey', 200),
    suiteType: suiteType as 'smoke' | 'regression' | 'custom',
    name: cleanRequired(input.name, '套件名称', 200),
    testCaseLibraryVersionId: cleanRequired(selectedVersionId, 'testCaseLibraryVersionId', 500),
    confirmLibraryVersionChange: input.confirmLibraryVersionChange === true,
    members: input.members.map((candidate, index) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new TestDesignError('TEST_SUITE_DRAFT_INVALID', `members[${index}] 必须是对象`, 422)
      const item = candidate as Record<string, unknown>
      const legacyMethod = item.executionMethod === undefined ? undefined : testExecutionMethod(item.executionMethod, `members[${index}].executionMethod`)
      const rawExecutionMethods = item.executionMethods
      if (rawExecutionMethods !== undefined && !Array.isArray(rawExecutionMethods)) throw new TestDesignError('TEST_SUITE_EXECUTION_METHOD_INVALID', `members[${index}].executionMethods 必须是数组`, 422)
      const executionMethods = Array.isArray(rawExecutionMethods)
        ? rawExecutionMethods.map((method, methodIndex) => {
          if (method !== 'ui' && method !== 'api') throw new TestDesignError('TEST_SUITE_EXECUTION_METHOD_INVALID', `members[${index}].executionMethods[${methodIndex}] 只能是 ui 或 api`, 422)
          return method
        })
        : undefined
      if (executionMethods && !executionMethods.length) throw new TestDesignError('TEST_SUITE_EXECUTION_METHOD_INVALID', `members[${index}].executionMethods 不能为空`, 422)
      if (executionMethods && new Set(executionMethods).size !== executionMethods.length) throw new TestDesignError('TEST_SUITE_EXECUTION_METHOD_INVALID', `members[${index}].executionMethods 不能包含重复执行方式`, 422)
      if (!executionMethods && !legacyMethod) throw new TestDesignError('TEST_SUITE_EXECUTION_METHOD_INVALID', `members[${index}] 必须提供 executionMethods 或 executionMethod`, 422)
      if (executionMethods && legacyMethod && !executionMethods.includes(legacyMethod as 'ui' | 'api')) throw new TestDesignError('TEST_SUITE_EXECUTION_METHOD_INVALID', `members[${index}] 的 executionMethod 必须属于 executionMethods`, 422)
      return { ...(typeof item.testCaseLibraryVersionId === 'string' && item.testCaseLibraryVersionId.trim() ? { testCaseLibraryVersionId: item.testCaseLibraryVersionId.trim() } : {}), caseId: cleanRequired(item.caseId, 'caseId', 500), ...(executionMethods ? { executionMethods: canonicalSuiteExecutionMethods(executionMethods) } : {}), ...(legacyMethod ? { executionMethod: legacyMethod } : {}), reason: cleanRequired(item.reason, '选择原因', 2_000) }
    }),
  }
}
function validateSuiteMembers(aggregate: TestDesignState, projectId: string, testCaseLibraryVersionId: string, values: ReturnType<typeof suiteDraftInput>['members']): TestSuiteVersionMember[] {
  const version = presentLibraryVersion(aggregate, required(aggregate.libraryVersions.find(item => item.id === testCaseLibraryVersionId && item.projectId === projectId), 'TEST_CASE_LIBRARY_VERSION_NOT_FOUND', '套件引用的用例库版本不存在'))
  const seen = new Set<string>()
  return values.map((value, ordinal) => {
    if (value.testCaseLibraryVersionId && value.testCaseLibraryVersionId !== version.id) throw new TestDesignError('TEST_SUITE_LIBRARY_VERSION_MISMATCH', '套件所有成员必须属于草稿固定的同一个用例库版本', 422)
    if (seen.has(value.caseId)) throw new TestDesignError('TEST_SUITE_MEMBER_DUPLICATE', '套件成员不能重复', 422)
    seen.add(value.caseId)
    const member = required(version.members.find(item => item.caseId === value.caseId), 'TEST_CASE_LIBRARY_MEMBER_NOT_FOUND', '套件成员不属于固定的用例库版本')
    const frozenContent = required(member.frozenContent, 'TEST_CASE_LIBRARY_MEMBER_HASH_MISMATCH', '用例库成员缺少冻结内容')
    const availableMethods = executionMethodsForContent(frozenContent)
    const selectedMethods = value.executionMethods ?? (value.executionMethod === 'ui' || value.executionMethod === 'api' ? [value.executionMethod] : undefined)
    if (frozenContent.dimension === 'functional' || frozenContent.dimension === 'security') {
      if (!selectedMethods?.length || selectedMethods.some(method => !availableMethods.includes(method))) throw new TestDesignError('TEST_SUITE_EXECUTION_METHOD_INVALID', '套件执行方式不是冻结 Revision 实际拥有方式的非空子集', 422, { caseId: member.caseId, revision: member.revision, selectedMethods: selectedMethods ?? [], availableMethods })
      return { testCaseLibraryVersionId: version.id, caseId: member.caseId, revision: member.revision, executionMethods: canonicalSuiteExecutionMethods(selectedMethods), ordinal, reason: cleanRequired(value.reason, '套件成员原因', 2_000) }
    }
    const selectedMethod = value.executionMethod ?? (value.executionMethods?.length === 1 ? value.executionMethods[0] : undefined)
    if (!selectedMethod || value.executionMethods?.length && (value.executionMethods.length !== 1 || value.executionMethods[0] !== selectedMethod) || availableMethods.length !== 1 || availableMethods[0] !== selectedMethod) throw new TestDesignError('TEST_SUITE_EXECUTION_METHOD_INVALID', '套件执行方式不是冻结 Revision 实际拥有的非功能执行方式', 422, { caseId: member.caseId, revision: member.revision, selectedMethods: value.executionMethods ?? (selectedMethod ? [selectedMethod] : []), availableMethods })
    return { testCaseLibraryVersionId: version.id, caseId: member.caseId, revision: member.revision, executionMethods: [], executionMethod: selectedMethod, ordinal, reason: cleanRequired(value.reason, '套件成员原因', 2_000) }
  })
}
function canonicalSuiteExecutionMethods(methods: Array<'ui' | 'api'>) { return (['ui', 'api'] as const).filter((method): method is 'ui' | 'api' => methods.includes(method)) }
function suiteMemberExecutionMethods(member: TestSuiteVersionMember, frozenContent: TestCaseContent): TestExecutionMethod[] { return member.executionMethods?.length ? canonicalSuiteExecutionMethods(member.executionMethods) : member.executionMethod ? [member.executionMethod] : executionMethodsForContent(frozenContent) }
function legacySuiteMemberUiApiMethods(member: TestSuiteVersionMember): Array<'ui' | 'api'> { return member.executionMethods?.length ? member.executionMethods : member.executionMethod === 'ui' || member.executionMethod === 'api' ? [member.executionMethod] : [] }
function suiteDraftEtag(draft: TestSuiteDraft) { return `"suite-draft:${draft.id}:${canonicalSha256({ contentSha256: draft.contentSha256, status: draft.status, updatedAt: draft.updatedAt })}"` }
function versionMemberDiff<T extends { caseId: string; revision: number }>(left: T[], right: T[]) { const before = new Map(left.map(item => [item.caseId, item])); const after = new Map(right.map(item => [item.caseId, item])); return [...new Set([...before.keys(), ...after.keys()])].sort().map(caseId => { const from = before.get(caseId); const to = after.get(caseId); return { caseId, change: !from ? 'added' as const : !to ? 'removed' as const : canonicalSha256(from) === canonicalSha256(to) ? 'unchanged' as const : 'modified' as const, ...(from ? { from: structuredClone(from) } : {}), ...(to ? { to: structuredClone(to) } : {}) } }).filter(item => item.change !== 'unchanged') }
function libraryProjectionFiles(projectVersionName: string, version: TestCaseLibraryVersion, cases: LibraryTestCase[]): TestDesignWorkspaceFile[] {
  const directory = `workspace/branches/${safeWorkspaceSegment(projectVersionName)}/test-case-library/v${version.version}`
  const entries = version.members.map(member => {
    const testCase = required(cases.find(item => item.id === member.caseId), 'LIBRARY_TEST_CASE_NOT_FOUND', '正式用例不存在')
    const revision = required(testCase.revisions.find(item => item.revision === member.revision), 'LIBRARY_TEST_CASE_REVISION_NOT_FOUND', '正式用例 Revision 不存在')
    const content = member.frozenContent ?? revision.content
    if (canonicalSha256(content) !== member.contentSha256 || revision.contentSha256 !== member.contentSha256) throw new TestDesignError('TEST_CASE_LIBRARY_MEMBER_HASH_MISMATCH', 'Workspace 投影前发现冻结内容 Hash 不一致', 409, { versionId: version.id, caseId: member.caseId, revision: member.revision })
    const traceability = member.traceability ?? revision.traceability
    if (traceability) assertTraceabilityMatchesContent(content, traceability)
    return { caseId: testCase.id, revision: revision.revision, contentSha256: member.contentSha256, content: structuredClone(content), ...(traceability ? { traceability: structuredClone(traceability) } : {}), executionReadiness: member.executionReadiness ?? executionConfiguration(content).status }
  })
  const canonicalContent = { schemaVersion: 'test-case-library/v2', versionId: version.id, projectId: version.projectId, version: version.version, name: version.name, contentSha256: version.contentSha256, cases: entries }
  const json = `${canonicalJson(canonicalContent)}\n`
  const dataRequirementsJson = version.dataRequirementSet ? `${canonicalJson({ schemaVersion: 'test-data-requirements/v1', sourceSetId: version.dataRequirementSet.id, sourceSetVersion: version.dataRequirementSet.version, sourceSetSha256: version.dataRequirementSet.contentSha256, requirements: version.dataRequirementSet.requirements })}\n` : undefined
  const markdown = [`# ${version.name}`, '', `- Library Version: ${version.version}`, `- Version ID: ${version.id}`, `- SHA-256: ${version.contentSha256}`, '', ...entries.flatMap(item => {
    const trace = item.traceability
    const requirementIds = trace?.requirementRefs.map(reference => reference.requirementId) ?? []
    return [`## ${item.caseId} r${item.revision} · ${item.content.title}`, '', item.content.objective, '', `- Case ID: ${item.caseId}`, `- Revision: r${item.revision}`, `- Content SHA-256: ${item.contentSha256}`, `- Dimension: ${item.content.dimension}`, `- Priority: ${item.content.priority}`, `- Execution Method: ${executionMethodForContent(item.content)}`, `- Execution Readiness: ${item.executionReadiness}`, `- Execution Spec: ${item.content.executionSpec ? canonicalJson(item.content.executionSpec) : '未配置'}`, `- Requirement Release: ${trace?.sourceRequirementReleaseId ?? '历史数据未建立正式追溯'}`, `- Requirement ID: ${requirementIds.length ? requirementIds.join(', ') : '历史数据未建立正式追溯'}`, '']
  })].join('\n')
  const files = [{ name: 'test-cases.json', content: json, displayName: `用例库 V${version.version} JSON` }, { name: 'test-cases.md', content: markdown, displayName: `用例库 V${version.version} 文档` }, ...(dataRequirementsJson ? [{ name: 'test-data-requirements.json', content: dataRequirementsJson, displayName: `测试数据需求 V${version.dataRequirementSet!.version}` }] : [])]
  const manifestBody = { schemaVersion: 'test-case-library-manifest/v2', versionId: version.id, contentSha256: version.contentSha256, members: entries.map(item => ({ caseId: item.caseId, revision: item.revision, contentSha256: item.contentSha256, ...(item.content.executionSpec ? { executionSpec: item.content.executionSpec } : {}), executionReadiness: item.executionReadiness, ...(item.traceability ? { traceability: item.traceability } : { traceabilityStatus: '历史数据未建立正式追溯' }) })), files: files.map(file => ({ name: file.name, sha256: canonicalSha256Text(file.content) })) }
  const manifest = `${canonicalJson(manifestBody)}\n`
  return [...files.map(file => ({ logicalPath: `${directory}/${file.name}`, sourceType: 'test_case_library_version' as const, sourceId: version.id, contentSha256: canonicalSha256Text(file.content), content: file.content, displayName: file.displayName, sourceScope: 'formal_output' as const })), { logicalPath: `${directory}/manifest.json`, sourceType: 'test_case_library_version', sourceId: version.id, contentSha256: canonicalSha256Text(manifest), content: manifest, displayName: `用例库 V${version.version} Manifest`, sourceScope: 'formal_output' }]
}
function structuralDiff(before: unknown, after: unknown, path = ''): Array<{ path: string; before?: unknown; after?: unknown }> {
  if (before === undefined || after === undefined) return before === after ? [] : [{ path: path || '/', ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) }]
  if (canonicalSha256(before) === canonicalSha256(after)) return []
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) || Array.isArray(after)) return [{ path: path || '/', before, after }]
  const left = before as Record<string, unknown>
  const right = after as Record<string, unknown>
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().flatMap(key => structuralDiff(left[key], right[key], `${path}/${key}`))
}
function applyReviewAction(testCase: TestCase, input: { decision: 'submit' | 'approve' | 'reject' | 'request_revision' | 'withdraw'; targetRevision: number; comment?: string }, actorId: string) { if (testCase.currentRevision !== input.targetRevision) throw new TestDesignError('TEST_CASE_REVISION_CONFLICT', '审核目标 revision 已变化', 412); if (['reject', 'request_revision'].includes(input.decision) && !input.comment?.trim()) throw new TestDesignError('TEST_CASE_REVIEW_COMMENT_REQUIRED', '退回修改或拒绝必须填写审核意见。', 422); const transitions = { draft: { submit: 'in_review' }, in_review: { approve: 'approved', reject: 'rejected', request_revision: 'needs_revision', withdraw: 'draft' }, approved: { request_revision: 'needs_revision' }, rejected: {}, needs_revision: { submit: 'in_review' } } as const; const toState = (transitions[testCase.reviewState] as Record<string, TestCase['reviewState'] | undefined>)[input.decision]; if (!toState) throw new TestDesignError('TEST_CASE_REVIEW_TRANSITION_INVALID', `不能从 ${testCase.reviewState} 执行 ${input.decision}`, 409); testCase.reviewActions.push({ id: `test_case_review_${randomUUID()}`, targetRevision: input.targetRevision, fromState: testCase.reviewState, toState, decision: input.decision, ...(input.comment?.trim() ? { comment: input.comment.trim().slice(0, 4_000) } : {}), actorId, createdAt: now() }); testCase.reviewState = toState }
function applyDisposition(target: { state: 'open' | 'confirmed' | 'resolved' | 'deferred' | 'rejected'; actions: Array<{ id: string; expectedVersion: number; fromState: string; toState: string; decision: string; comment?: string; structuredDecision?: unknown; actorId: string; createdAt: string }> }, input: { expectedVersion: number; decision: 'confirm' | 'resolve' | 'defer' | 'reject' | 'reopen'; comment?: string; structuredDecision?: unknown }, actorId: string) { if (target.actions.length !== input.expectedVersion) throw new TestDesignError('TEST_DESIGN_DISPOSITION_VERSION_CONFLICT', '处置版本已变化', 409); const toState = input.decision === 'confirm' ? 'confirmed' : input.decision === 'resolve' ? 'resolved' : input.decision === 'defer' ? 'deferred' : input.decision === 'reject' ? 'rejected' : 'open'; target.actions.push({ id: `test_design_action_${randomUUID()}`, expectedVersion: input.expectedVersion, fromState: target.state, toState, decision: input.decision, ...(input.comment?.trim() ? { comment: input.comment.trim().slice(0, 4_000) } : {}), ...(input.structuredDecision === undefined ? {} : { structuredDecision: structuredClone(input.structuredDecision) }), actorId, createdAt: now() }); target.state = toState }
function validateCurrentDependencyGraph(run: TestDesignWorkflowRun) { validateCaseDependencyGraph(run.testCases.filter(item => !item.tombstonedAt).map(item => ({ id: item.id, content: currentCaseRevision(item).content }))) }
function invalidateAudit(run: TestDesignWorkflowRun) { run.coverageAudits.forEach(item => { item.status = 'stale' }) }
function assertMethodSubset(run: TestDesignWorkflowRun, caseId: string, methods: Array<'ui' | 'api'>) { if (!methods.length) throw new TestDesignError('TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', '执行方式子集不能为空', 422); const content = currentCaseRevision(findCase(run, caseId)).content; const available = new Set(content.executionMethods.filter(method => method.executionReadiness === 'ready').map(method => method.method)); if (methods.some(method => !available.has(method))) throw new TestDesignError('TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', '执行方式不是来源用例 ready 方式的子集', 422) }
function publishArtifact(run: TestDesignWorkflowRun, key: TestDesignNodeKey, output: { schemaVersion: string; content: unknown }) { const target = node(run, key); const artifactValue: WorkflowArtifact = { id: `workflow_artifact_${randomUUID()}`, nodeKey: key, schemaVersion: output.schemaVersion, generation: target.generation, content: structuredClone(output.content), contentSha256: canonicalSha256(output.content), createdAt: now() }; run.artifacts.push(artifactValue); target.outputArtifactId = artifactValue.id }
function finishNode(run: TestDesignWorkflowRun, key: TestDesignNodeKey, execution?: WorkflowNodeRun['execution']) { const target = node(run, key); Object.assign(target, { status: 'succeeded', finishedAt: now(), ...(execution ? { execution } : {}) }) }
function failNode(run: TestDesignWorkflowRun, key: TestDesignNodeKey, error: unknown) { const target = node(run, key); const message = error instanceof Error ? error.message : String(error); const execution = error && typeof error === 'object' && 'execution' in error ? (error as { execution?: WorkflowNodeRun['execution'] }).execution : undefined; Object.assign(target, { status: 'failed', finishedAt: now(), error: message, errorCode: errorCode(message), ...(execution ? { execution } : {}) }) }
function shouldCheckpointTestDesignExecution(event: AgentExecutionEvent) { return ['tool_execution_end', 'turn_end', 'agent_end', 'result_submission_required', 'result_submission_retry', 'input_package_built', 'input_batch_delivered'].includes(event.type) }
function testDesignExecutionProgress(run: TestDesignWorkflowRun, stage: 'test_case_design' | 'test_design_repair', events: AgentExecutionEvent[]): WorkflowNodeRun['execution'] {
  const framework = events.find(event => event.framework)?.framework
  return {
    agentKey: 'planning',
    workflowStage: stage,
    agentVersion: run.agentConfigurationSnapshot.agentDefinition.version,
    modelLabel: run.agentConfigurationSnapshot.primaryModel.modelName,
    degraded: false,
    turns: events.reduce((maximum, event) => Math.max(maximum, event.turn ?? 0), 0),
    toolCalls: events.filter(event => event.type === 'tool_execution_start').length,
    toolErrors: events.filter(event => event.type === 'tool_execution_end' && event.isError).length,
    ...(framework ? { framework } : {}),
    events: structuredClone(events),
  }
}
function queueNode(run: TestDesignWorkflowRun, key: TestDesignNodeKey) { const target = node(run, key); Object.assign(target, { status: 'queued', error: undefined, errorCode: undefined }) }
function advanceNodeGeneration(run: TestDesignWorkflowRun, target: WorkflowNodeRun, status: WorkflowNodeRun['status']) { target.generation += 1; target.attempt = 0; target.id = `${run.id}:${target.nodeKey}:g${target.generation}:a0`; target.status = status; target.outputArtifactId = undefined; target.startedAt = undefined; target.finishedAt = undefined; target.error = undefined; target.errorCode = undefined; target.execution = undefined }
function node(run: TestDesignWorkflowRun, key: TestDesignNodeKey) { return required(run.nodeRuns.find(item => item.nodeKey === key), 'WORKFLOW_NODE_NOT_FOUND', `${key} 节点不存在`) }
function currentCaseRevision(testCase: TestCase) { return required(testCase.revisions.find(item => item.revision === testCase.currentRevision), 'TEST_CASE_REVISION_NOT_FOUND', '用例当前 revision 不存在') }
function findCase(run: TestDesignWorkflowRun, caseId: string) { return required(run.testCases.find(item => item.id === caseId), 'TEST_CASE_NOT_FOUND', '测试用例不存在') }
function findDesign(state: DatabaseState, projectVersionId: string, designId: string) { return required(readDesignState(state).designs.find(item => item.id === designId && item.projectVersionId === projectVersionId), 'TEST_DESIGN_NOT_FOUND', '测试设计不存在') }
function findRun(state: DatabaseState, projectVersionId: string, designId: string, runId: string) { findDesign(state, projectVersionId, designId); return required(readDesignState(state).runs.find(item => item.id === runId && item.testDesignId === designId && item.projectVersionId === projectVersionId), 'TEST_DESIGN_RUN_NOT_FOUND', '测试设计运行不存在') }
function findRunById(state: DatabaseState, runId: string) { return required(designState(state).runs.find(item => item.id === runId), 'TEST_DESIGN_RUN_NOT_FOUND', '测试设计运行不存在') }
function assertOpenVersion(state: DatabaseState, projectVersionId: string) { const version = required(state.projectVersions.find(item => item.id === projectVersionId), 'PROJECT_VERSION_NOT_FOUND', '项目版本不存在'); if (version.status !== 'open') throw new TestDesignError('PROJECT_VERSION_READ_ONLY', '当前项目版本只读', 409) }
function designState(state: DatabaseState): TestDesignState { const aggregate = state.testDesignState ??= emptyTestDesignState(); aggregate.legacyMigrations ??= []; return aggregate }
function readDesignState(state: DatabaseState): TestDesignState { return state.testDesignState ?? emptyTestDesignState() }
function emptyTestDesignState(): TestDesignState { return { architectureVersion: 'single-agent-skills/v1', designs: [], runs: [], caseSetVersions: [], libraryCases: [], libraryVersions: [], suiteDrafts: [], suiteVersions: [], executionHandoffs: [], legacyMigrations: [] } }
function presentRun(run: TestDesignWorkflowRun, detail = false) { const value = structuredClone(run); if (value.status === 'succeeded') { value.error = undefined; value.errorCode = undefined } if (!detail) return { id: value.id, testDesignId: value.testDesignId, projectVersionId: value.projectVersionId, status: value.status, stage: value.stage, progress: value.progress, createdAt: value.createdAt, startedAt: value.startedAt, finishedAt: value.finishedAt, errorCode: value.errorCode, error: value.error }; return value }
function presentCase(testCase: TestCase, detail = false) { const revision = currentCaseRevision(testCase); const value = { id: testCase.id, runId: testCase.runId, origin: testCase.origin, currentRevision: testCase.currentRevision, reviewState: testCase.reviewState, content: structuredClone(revision.content), contentSha256: revision.contentSha256, etag: etag('case', testCase.id, revision.revision, revision.contentSha256), ...(detail ? { revisions: structuredClone(testCase.revisions), reviewActions: structuredClone(testCase.reviewActions), tombstonedAt: testCase.tombstonedAt } : {}) }; return value }
function markdownCaseSet(version: TestCaseSetVersion) { const content = version.canonicalContent as { cases: Array<{ caseId: string; revision: number; content: TestCaseContent }> }; return [`# ${version.name}`, '', `- Version: ${version.version}`, `- Schema: ${version.schemaVersion}`, `- Content SHA-256: ${version.contentSha256}`, '', ...content.cases.flatMap(item => [`## ${item.caseId} r${item.revision}: ${item.content.title}`, '', item.content.objective, '', `- Dimension: ${item.content.dimension}`, `- Priority: ${item.content.priority}`, `- Methods: ${item.content.executionMethods.map(method => method.method).join(', ')}`, ''])].join('\n') }
async function xlsxCaseSet(version: TestCaseSetVersion) { const value = version.canonicalContent as { cases: Array<{ caseId: string; revision: number; content: TestCaseContent }> }; const rows = [['Case ID', 'Revision', 'Title', 'Objective', 'Dimension', 'Priority', 'Methods', 'Domain', 'Preconditions', 'Steps', 'Checks'], ...value.cases.map(item => [item.caseId, String(item.revision), item.content.title, item.content.objective, item.content.dimension, item.content.priority, item.content.executionMethods.map(method => method.method).join(', '), item.content.domain, item.content.preconditions.join('\n'), item.content.executionMethods.flatMap(method => method.steps.map(step => `[${method.method}] ${step.key}: ${step.action} => ${step.expected}`)).join('\n'), item.content.executionMethods.flatMap(method => method.verificationChecks.map(check => `[${method.method}] ${check.description}`)).concat(item.content.sharedVerificationChecks.map(check => `[shared] ${check.description}`)).join('\n')])]; const sheetRows = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((cell, columnIndex) => `<c r="${columnName(columnIndex + 1)}${rowIndex + 1}" t="inlineStr"${rowIndex === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xml(safeSpreadsheetText(cell))}</t></is></c>`).join('')}</row>`).join(''); const zip = new JSZip(); zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'); zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'); zip.file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Test Cases" sheetId="1" r:id="rId1"/></sheets></workbook>'); zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'); zip.file('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font/><font><b/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf xfId="0"/><xf xfId="0" fontId="1" applyFont="1"/></cellXfs></styleSheet>'); zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`); return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) }
function columnName(index: number) { let name = ''; for (let value = index; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + ((value - 1) % 26)) + name; return name }
function safeSpreadsheetText(value: string) { return /^[=+\-@]/u.test(value) ? `'${value}` : value }
function xml(value: string) { return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;') }
function required<T>(value: T | null | undefined, code: string, message: string): T { if (value == null) throw new TestDesignError(code, message, code.endsWith('_NOT_FOUND') ? 404 : 409); return value }
function cleanRequired(value: unknown, label: string, max: number) { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TestDesignError('TEST_DESIGN_INPUT_INVALID', `${label} 不能为空且不能超过 ${max} 个字符`, 422); return value.trim() }
function testExecutionMethod(value: unknown, label: string): TestExecutionMethod { if (!['ui', 'api', 'performance_tool', 'long_running', 'environment_matrix'].includes(String(value))) throw new TestDesignError('TEST_EXECUTION_CASE_NOT_READY', `${label} 无效`, 422); return value as TestExecutionMethod }
function positive(value: unknown, label: string) { const number = Number(value); if (!Number.isFinite(number) || number <= 0) throw new TestDesignError('TEST_DESIGN_INPUT_INVALID', `${label} 必须是正数`, 422); return number }
function newest(left: { createdAt?: string; publishedAt?: string }, right: { createdAt?: string; publishedAt?: string }) { return String(right.createdAt ?? right.publishedAt).localeCompare(String(left.createdAt ?? left.publishedAt)) }
function now() { return new Date().toISOString() }
function errorCode(message: string) { return /^([A-Z][A-Z0-9_]+):/u.exec(message)?.[1] ?? 'TEST_DESIGN_RUN_FAILED' }
