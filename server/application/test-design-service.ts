import { createHash, randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import type { Principal } from '../domain/access-control.js'
import type { DatabaseState, ReviewRun } from '../domain/types.js'
import { activeRequirementReleaseBinding, requirementReleaseBindings } from '../domain/requirement-release-bindings.js'
import type {
  CaseChangeDecision, CaseChangeProposal, CreateTestDesignInput, CoverageAudit, HistoricalCaseSnapshot, ImpactedRegressionReference, LegacyTestCaseMigrationRecord, LibraryTestCase, LibraryTestCaseRevision, RetrievalSnapshot, SmokeCandidateRelation, TestCase,
  TestCaseContent, TestCaseLibraryVersion, TestCaseLibraryVersionDetail, TestCaseSetVersion, TestDataRequirement, TestDataRequirementSetVersion, TestDesign, TestDesignBasisSnapshot, TestDesignWorkspaceFile, TestDesignWorkspaceSnapshot,
  TestCaseTraceability, TestDesignNodeKey, TestDesignRunAgentConfigurationSnapshot, TestDesignState, TestDesignWorkflowRun, TestExecutionHandoff, TestExecutionMethod, TestPointNodeRevision,
  TestPointTreeOperation, TestPointTreeRevision, TestSuiteDraft, TestSuiteVersion, TestSuiteVersionMember, WorkflowArtifact, WorkflowNodeRun,
} from '../domain/test-design-types.js'
import type { StateStore, TaskLease } from '../infrastructure/store.js'
import { canonicalJson, canonicalSha256 } from './canonical-json.js'
import { auditTestDesignCoverage } from './test-design-coverage-auditor.js'
import { assertEtag, etag, executableTestPointIds, TestDesignError, validateCaseDependencyGraph, validateCreateTestDesignInput, validateTestCaseContent, validateTestCaseDesignCandidate, validateTestPointDesignCandidate, validateTreeNodes, type TestCaseDesignCandidate, type TestPointDesignCandidate } from './test-design-validation.js'
import { classifyWorkspaceSourceScope } from './project-workspace-snapshot.js'

const AUTOMATIC_REPAIR_MAX_ATTEMPTS = 1
const AUTOMATIC_TEST_POINT_REVIEW_ACTOR = 'system:test-point-validator'

export interface PlanningAgentRuntime {
  readiness?(projectVersionId?: string, requirementReleaseId?: string): Promise<{ ready: boolean; agents: Array<{ agentKey: string; ready: boolean; reason?: string }> }>
  freezeConfiguration?(projectVersionId: string, requirementReleaseId?: string): Promise<TestDesignRunAgentConfigurationSnapshot>
  appendTask?(input: { projectVersionId: string; taskType: string; task: string; metadata?: Record<string, unknown> }): Promise<unknown>
  execute(input: {
    stage: 'test_point_design' | 'test_case_design' | 'test_design_repair'
    run: TestDesignWorkflowRun
    upstream: unknown
  }, signal: AbortSignal): Promise<{ schemaVersion: string; content: unknown; execution?: WorkflowNodeRun['execution'] }>
}
type WorkspaceArtifactIngestInput = { knowledgeBaseId: string; sourceType: 'upload'; sourceKey: string; assetType: string; displayName: string; logicalPath: string; content: string; taskTrigger?: 'upload' | 'retry' }
export interface TestCaseAssetProjector {
  ingest(input: WorkspaceArtifactIngestInput): Promise<{ version: { id: string }; task: unknown }>
  ingestWorkspaceArtifact?(input: WorkspaceArtifactIngestInput): Promise<{ version: { id: string }; task: unknown }>
}

export class TestDesignService {
  private readonly activeRuns = new Map<string, AbortController>()
  private testPointsValidatedListener?: (
    projectVersionId: string,
    runId: string,
    treeVersionId: string,
  ) => void | Promise<void>

  constructor(private readonly store: StateStore, private readonly runtime?: PlanningAgentRuntime, private readonly projector?: TestCaseAssetProjector) {}

  onTestPointsValidated(
    listener: (projectVersionId: string, runId: string, treeVersionId: string) => void | Promise<void>,
  ) {
    this.testPointsValidatedListener = listener
  }

  async inputCandidates(projectVersionId: string) {
    const state = await this.store.snapshot()
    const projectVersion = required(state.projectVersions.find(item => item.id === projectVersionId), 'PROJECT_VERSION_NOT_FOUND', '项目版本不存在')
    const projectBases = state.knowledgeBases.filter(item => item.projectId === projectVersion.projectId)
    const requirementRelease = boundRequirementRelease(state, projectVersionId)
    const requirementReleases = requirementReleaseBindings(projectVersion).map(binding => required(boundRequirementRelease(state, projectVersionId, binding.releaseId), 'TEST_DESIGN_REQUIREMENT_RELEASE_BINDING_INVALID', 'ProjectVersion 的 Requirement Release 绑定无效'))
    const knowledgeAssets = projectBases.flatMap(base => state.assets.filter(asset => asset.knowledgeBaseId === base.id).flatMap(asset => state.versions.filter(version => version.assetId === asset.id).map(version => ({ assetId: asset.id, assetVersionId: version.id, version: version.number, contentHash: version.contentHash, displayName: asset.displayName, logicalPath: asset.logicalPath, assetType: asset.assetType, status: version.status, selectable: version.status === 'ready', reason: version.status === 'ready' ? undefined : '资产版本未就绪' }))))
    const designState = readDesignState(state)
    const agentReadiness = this.runtime?.readiness ? await this.runtime.readiness(projectVersionId) : { ready: Boolean(this.runtime), agents: [{ agentKey: 'planning', ready: Boolean(this.runtime), reason: this.runtime ? undefined : 'PlanningAgent Runtime 未配置' }] }
    return {
      projectVersion: { id: projectVersion.id, projectId: projectVersion.projectId, name: projectVersion.name, status: projectVersion.status },
      requirementRelease: requirementRelease ? presentRequirementRelease(requirementRelease, true) : null,
      requirementReleases: requirementReleases.map(item => presentRequirementRelease(item, item.binding.releaseId === requirementRelease?.binding.releaseId)),
      knowledgeAssets,
      fixedIndexes: projectBases.flatMap(base => state.indexes.filter(index => index.knowledgeBaseId === base.id && index.status === 'active').map(index => ({ id: index.id, selectable: true }))),
      historicalCaseSets: designState.caseSetVersions.filter(item => item.projectId === projectVersion.projectId).map(item => ({ id: item.id, name: item.name, version: item.version, memberCount: item.members.length, contentSha256: item.contentSha256 })),
      testCaseLibraryVersions: designState.libraryVersions.filter(item => item.projectId === projectVersion.projectId).sort((left, right) => right.version - left.version).map(item => ({ id: item.id, name: item.name, version: item.version, memberCount: item.members.length, contentSha256: item.contentSha256, publishedAt: item.publishedAt })),
      historicalTestSuites: designState.suiteVersions.filter(item => item.projectId === projectVersion.projectId && item.status !== 'deprecated').sort(newest).map(item => ({ id: item.id, name: item.name, suiteKey: item.suiteKey, suiteType: item.suiteType, version: item.version, memberCount: item.members.length, contentSha256: item.contentSha256 })),
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
      validateDesignSources(state, projectVersion.projectId, input)
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
      const rawInput: CreateTestDesignInput = {
        name: `${projectVersion.name} · 自动测试设计`,
        objective: result.summary.overview.trim() || '依据已冻结的需求理解生成可追溯测试点与测试用例。',
        includedScopes: [],
        excludedScopes: [],
        focusDimensions: [],
        executionMethods: [],
        userCoverageObjectives: result.testFocus.map(item => `${item.title}：${item.description}`),
        knowledgeAugmentation: activeIndex ? { mode: 'fixed_index', indexVersionId: activeIndex.id } : { mode: 'disabled' },
        historicalCaseSelections: [],
        historicalLibrarySelection: { mode: 'latest_library' },
      }
      const input = validateCreateTestDesignInput(rawInput)
      validateDesignSources(state, projectVersion.projectId, input)
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
    const run = await this.createRun(projectVersionId, created.design.id, `automatic:${created.design.sourceRequirementReleaseId}`, { subjectId: 'system:planning-workflow', displayName: 'Planning Workflow' })
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
    const preflight = await this.store.snapshot()
    const sourceReleaseId = findDesign(preflight, projectVersionId, designId).sourceRequirementReleaseId
    const readiness = this.runtime?.readiness ? await this.runtime.readiness(projectVersionId, sourceReleaseId) : { ready: Boolean(this.runtime) }
    if (!readiness.ready) throw new TestDesignError('TEST_DESIGN_AGENT_NOT_READY', 'PlanningAgent 尚未发布或未通过模型门禁', 409, readiness)
    const agentConfigurationSnapshot = this.runtime?.freezeConfiguration ? await this.runtime.freezeConfiguration(projectVersionId, sourceReleaseId) : undefined
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
        id: runId, testDesignId: design.id, projectVersionId, status: 'queued', stage: 'test_point_design', progress: 0, idempotencyKey,
        basisSnapshot, agentConfigurationSnapshot, currentInputRefs: structuredClone(requirement.analysisRun.snapshot.currentInputRefs), retrievalSnapshot, historicalSnapshot, workspaceSnapshot, formalWorkspaceFiles: [],
        ...(historicalSnapshot.baseTestCaseLibraryVersionId ? { baseTestCaseLibraryVersionId: historicalSnapshot.baseTestCaseLibraryVersionId, baseTestCaseLibraryVersionSha256: historicalSnapshot.baseTestCaseLibraryVersionSha256 } : {}),
        nodeRuns: workflowNodes(runId), artifacts: [], gateDecisions: [], testCases: [], caseChangeProposals: [], dataSetVersions: [], coverageAudits: [], smokeCandidates: [], impactedRegression: [], findings: [], confirmationItems: [], automaticRepair: initialAutomaticRepairState(), events: [], createdBy: principal.subjectId, createdAt,
      }
      aggregate.runs.push(run)
      return { run: structuredClone(run), created: true }
    })
    if (created.run.status === 'queued') await this.schedule(created.run.id)
    return created.run
  }

  async listRuns(projectVersionId: string, designId: string) {
    const state = await this.store.snapshot(); findDesign(state, projectVersionId, designId)
    return readDesignState(state).runs.filter(item => item.testDesignId === designId).sort(newest).map(run => presentRun(run))
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
      if (['pending', 'queued', 'running', 'failed'].includes(node(run, 'test_point_design').status)) {
        const output = await this.executeNode(runId, 'test_point_design', signal, pointDesignInput(run))
        const treeVersionId = await this.store.transaction(state => {
          const current = findRunById(state, runId)
          publishArtifact(current, 'test_point_design', output)
          materializeTestPointDesign(current, output.content, current.createdBy)
          materializeDesignIssues(current, output.content)
          finishNode(current, 'test_point_design', output.execution)
          return startAutomaticTestPointReview(current).id
        })
        await this.projectTreeVersion(run.projectVersionId, run.testDesignId, runId, treeVersionId)
        await this.store.transaction(state => { completeAutomaticTestPointReview(findRunById(state, runId)) })
        await this.testPointsValidatedListener?.(run.projectVersionId, run.id, treeVersionId)
      }
      const refreshed = await this.loadRun(runId)
      if (!refreshed.testPointTree?.currentApprovedVersionId) return refreshed
      if (node(refreshed, 'test_case_design').status !== 'succeeded') {
        const output = await this.executeNode(runId, 'test_case_design', signal, caseDesignInput(refreshed))
        let repairQueued = false
        await this.store.transaction(state => {
          const current = findRunById(state, runId)
          publishArtifact(current, 'test_case_design', output)
          finishNode(current, 'test_case_design', output.execution)
          repairQueued = finalizeCaseDesignAndAudit(current, output.content, current.createdBy, false)
        })
        if (repairQueued) return this.processPreparedRun(runId, signal)
      }
      const afterCases = await this.loadRun(runId)
      if (afterCases.automaticRepair?.status === 'queued') {
        const output = await this.executeNode(runId, 'test_design_repair', signal, repairInput(afterCases))
        let repairQueued = false
        await this.store.transaction(state => {
          const current = findRunById(state, runId)
          publishArtifact(current, 'test_design_repair', output)
          finishNode(current, 'test_design_repair', output.execution)
          repairQueued = finalizeCaseDesignAndAudit(current, output.content, current.createdBy, true)
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
    if (!['test_point_design', 'test_case_design', 'test_design_repair'].includes(claimed.nodeKey)) throw new TestDesignError('WORKFLOW_NODE_NOT_RETRYABLE', '领取的节点不是 PlanningAgent Stage', 409)
    if (initial.status === 'cancelled' || claimed.status === 'succeeded' || claimed.status === 'cancelled') return initial

    const key = claimed.nodeKey as 'test_point_design' | 'test_case_design' | 'test_design_repair'
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
      const upstream = key === 'test_point_design' ? pointDesignInput(running) : key === 'test_case_design' ? caseDesignInput(running) : repairInput(running)
      const output = await this.runtime.execute({ stage: key, run: running, upstream }, signal)
      const result = await this.fencedNodeTransaction(nodeRunId, lease, state => {
        const run = findRunById(state, runId)
        const target = required(run.nodeRuns.find(item => item.id === nodeRunId && item.nodeKey === key), 'WORKFLOW_NODE_NOT_FOUND', '节点已被新 generation 替换')
        if (target.status !== 'running') throw new TestDesignError('WORKFLOW_JOB_LEASE_LOST', '节点已不处于当前执行状态', 409)
        publishArtifact(run, key, output)
        finishNode(run, key, output.execution)
        if (key === 'test_point_design') {
          materializeTestPointDesign(run, output.content, run.createdBy)
          materializeDesignIssues(run, output.content)
          return { repairQueued: false, treeVersionId: startAutomaticTestPointReview(run).id }
        }
        return { repairQueued: finalizeCaseDesignAndAudit(run, output.content, run.createdBy, key === 'test_design_repair'), treeVersionId: undefined }
      })
      if (result.treeVersionId) {
        await this.projectTreeVersion(running.projectVersionId, running.testDesignId, runId, result.treeVersionId)
        await this.fencedNodeTransaction(nodeRunId, lease, state => { completeAutomaticTestPointReview(findRunById(state, runId)) })
        await this.testPointsValidatedListener?.(running.projectVersionId, runId, result.treeVersionId)
        await this.schedule(runId)
      } else if (result.repairQueued) await this.schedule(runId)
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

  async redesignTestPoints(projectVersionId: string, designId: string, runId: string) {
    await this.store.transaction(state => { assertOpenVersion(state, projectVersionId); const run = findRun(state, projectVersionId, designId, runId); advanceNodeGeneration(run, node(run, 'test_point_design'), 'queued'); for (const downstream of run.nodeRuns.filter(item => item.nodeKey !== 'test_point_design')) advanceNodeGeneration(run, downstream, 'pending'); run.testPointTree = undefined; run.formalWorkspaceFiles = []; run.testCases = []; run.caseChangeProposals = []; run.dataSetVersions = []; run.findings = []; run.confirmationItems = []; invalidateAudit(run); Object.assign(run, { status: 'queued', stage: 'test_point_design', progress: 0, error: undefined, errorCode: undefined, finishedAt: undefined }) }); await this.schedule(runId); return this.getRun(projectVersionId, designId, runId)
  }

  async resynthesize(projectVersionId: string, designId: string, runId: string) {
    const state = await this.store.snapshot()
    assertOpenVersion(state, projectVersionId)
    const current = findRun(state, projectVersionId, designId, runId)
    const treeVersion = approvedTreeVersion(current)
    await this.runtime?.appendTask?.({
      projectVersionId,
      taskType: 'test_case_resynthesize',
      task: [
        '请重新生成测试用例。',
        '',
        `当前已批准 TestPointTreeVersion = ${treeVersion.id}，该正式测试点基线保持不变。`,
        '',
        '请继续在当前 Planning Session 中，基于当前 Requirement Release、正式 Clarification、已批准 TestPointTreeVersion 和冻结 Workspace 重新生成完整测试用例候选。',
      ].join('\n'),
      metadata: {
        testDesignRunId: runId,
        testPointTreeVersionId: treeVersion.id,
        testPointTreeSha256: treeVersion.treeSha256,
      },
    })
    await this.store.transaction(draft => {
      assertOpenVersion(draft, projectVersionId)
      const run = findRun(draft, projectVersionId, designId, runId)
      if (approvedTreeVersion(run).id !== treeVersion.id) throw new TestDesignError('TEST_POINT_TREE_VERSION_CHANGED', '批准的测试点版本已变化，请重新发起测试用例生成', 409)
      advanceNodeGeneration(run, node(run, 'test_case_design'), 'queued')
      advanceNodeGeneration(run, node(run, 'coverage_audit'), 'pending')
      advanceNodeGeneration(run, node(run, 'test_design_repair'), 'pending')
      run.testCases = []
      run.caseChangeProposals = []
      run.dataSetVersions = []
      run.automaticRepair = initialAutomaticRepairState()
      invalidateAudit(run)
      Object.assign(run, { status: 'queued', stage: 'test_case_design', progress: 55, error: undefined, errorCode: undefined, finishedAt: undefined })
    })
    await this.schedule(runId)
    return this.getRun(projectVersionId, designId, runId)
  }

  async getTree(projectVersionId: string, designId: string, runId: string) {
    const run = await this.loadScopedRun(projectVersionId, designId, runId); const tree = required(run.testPointTree, 'TEST_POINT_TREE_NOT_FOUND', '测试点树尚未生成')
    const revision = tree.revisions.find(item => item.revision === tree.currentRevision)!; return { tree: structuredClone(tree), revision: structuredClone(revision), etag: etag('tree', tree.id, revision.revision, revision.treeSha256) }
  }
  async treeRevisions(projectVersionId: string, designId: string, runId: string) { const run = await this.loadScopedRun(projectVersionId, designId, runId); return structuredClone(required(run.testPointTree, 'TEST_POINT_TREE_NOT_FOUND', '测试点树尚未生成').revisions) }
  async treeDiff(projectVersionId: string, designId: string, runId: string, from: number, to: number) { const run = await this.loadScopedRun(projectVersionId, designId, runId); const tree = required(run.testPointTree, 'TEST_POINT_TREE_NOT_FOUND', '测试点树尚未生成'); const left = required(tree.revisions.find(item => item.revision === from), 'TEST_POINT_TREE_REVISION_NOT_FOUND', '起始树 revision 不存在'); const right = required(tree.revisions.find(item => item.revision === to), 'TEST_POINT_TREE_REVISION_NOT_FOUND', '目标树 revision 不存在'); return structuralDiff(left.nodes, right.nodes) }

  async patchTree(projectVersionId: string, designId: string, runId: string, ifMatch: string | undefined, input: { operations: TestPointTreeOperation[]; reason: string }, principal: Principal) {
    const treeVersionId = await this.store.transaction(state => {
      assertOpenVersion(state, projectVersionId); const run = findRun(state, projectVersionId, designId, runId); const tree = required(run.testPointTree, 'TEST_POINT_TREE_NOT_FOUND', '测试点树尚未生成'); const current = tree.revisions.find(item => item.revision === tree.currentRevision)!
      if (['queued', 'running'].includes(run.status)) throw new TestDesignError('TEST_DESIGN_RUN_BUSY', 'PlanningAgent 正在处理当前测试设计，暂不能修改测试点', 409)
      assertEtag(ifMatch, etag('tree', tree.id, current.revision, current.treeSha256), 'TEST_POINT_TREE_REVISION_CONFLICT')
      if (!Array.isArray(input.operations) || !input.operations.length || input.operations.length > 100) throw new TestDesignError('TEST_POINT_TREE_OPERATION_INVALID', 'operations 必须包含 1 到 100 个操作', 422)
      const nodes = applyTreeOperations(current.nodes, input.operations)
      validateTreeReferences(run, nodes)
      const revision: TestPointTreeRevision = { revision: current.revision + 1, parentRevision: current.revision, nodes, operations: structuredClone(input.operations), reason: cleanRequired(input.reason, '修改说明', 2_000), actorId: principal.subjectId, treeSha256: validateTreeNodes(nodes), createdAt: now() }
      tree.revisions.push(revision); tree.currentRevision = revision.revision; tree.currentApprovedVersionId = undefined
      run.testCases.forEach(testCase => { if (!testCase.tombstonedAt) testCase.reviewState = 'draft' }); run.coverageAudits.forEach(audit => { audit.status = 'stale' })
      return startAutomaticTestPointReview(run).id
    })
    await this.projectTreeVersion(projectVersionId, designId, runId, treeVersionId)
    await this.store.transaction(state => { completeAutomaticTestPointReview(findRun(state, projectVersionId, designId, runId)) })
    await this.testPointsValidatedListener?.(projectVersionId, runId, treeVersionId)
    await this.schedule(runId)
    return this.getTree(projectVersionId, designId, runId)
  }

  async listCases(projectVersionId: string, designId: string, runId: string, filters: { dimension?: string; executionMethod?: string; status?: string } = {}) {
    const run = await this.loadScopedRun(projectVersionId, designId, runId)
    return run.testCases.filter(item => !item.tombstonedAt).filter(item => { const content = currentCaseRevision(item).content; return (!filters.dimension || content.dimension === filters.dimension) && (!filters.executionMethod || executionMethodForContent(content) === filters.executionMethod || content.executionMethods.some(method => method.method === filters.executionMethod)) && (!filters.status || item.reviewState === filters.status) }).map(testCase => presentCase(testCase))
  }

  async createCase(projectVersionId: string, designId: string, runId: string, rawContent: unknown, principal: Principal) {
    return this.store.transaction(state => { assertOpenVersion(state, projectVersionId); const run = findRun(state, projectVersionId, designId, runId); const treeVersion = approvedTreeVersion(run); const points = approvedPointIds(run, treeVersion.id); const content = validateTestCaseContent(rawContent, points); const testCase = newCase(run.id, treeVersion.id, content, 'manual', principal.subjectId, '人工新建'); run.testCases.push(testCase); materializeExecutionConfirmations(run, [testCase]); invalidateAudit(run); validateCurrentDependencyGraph(run); return presentCase(testCase) })
  }

  async getCase(projectVersionId: string, designId: string, runId: string, caseId: string) { const run = await this.loadScopedRun(projectVersionId, designId, runId); return presentCase(findCase(run, caseId), true) }
  async caseRevisions(projectVersionId: string, designId: string, runId: string, caseId: string) { const run = await this.loadScopedRun(projectVersionId, designId, runId); return structuredClone(findCase(run, caseId).revisions) }
  async caseDiff(projectVersionId: string, designId: string, runId: string, caseId: string, from: number, to: number) { const run = await this.loadScopedRun(projectVersionId, designId, runId); const testCase = findCase(run, caseId); const left = required(testCase.revisions.find(item => item.revision === from), 'TEST_CASE_REVISION_NOT_FOUND', '起始用例 revision 不存在'); const right = required(testCase.revisions.find(item => item.revision === to), 'TEST_CASE_REVISION_NOT_FOUND', '目标用例 revision 不存在'); return structuralDiff(left.content, right.content) }

  async patchCase(projectVersionId: string, designId: string, runId: string, caseId: string, ifMatch: string | undefined, input: { content: unknown; reason: string }, principal: Principal) {
    return this.store.transaction(state => {
      assertOpenVersion(state, projectVersionId); const run = findRun(state, projectVersionId, designId, runId); const testCase = findCase(run, caseId); if (testCase.reviewState === 'in_review') throw new TestDesignError('TEST_CASE_EDIT_LOCKED', '审核中的用例不能编辑', 409)
      const current = currentCaseRevision(testCase); assertEtag(ifMatch, etag('case', testCase.id, current.revision, current.contentSha256), 'TEST_CASE_REVISION_CONFLICT')
      const content = validateTestCaseContent(input.content, approvedPointIds(run, testCase.treeVersionId)); const revision = createCaseRevision(current.revision + 1, content, principal.subjectId, input.reason, current.content); testCase.revisions.push(revision); testCase.currentRevision = revision.revision; testCase.reviewState = 'draft'; if (testCase.origin === 'historical_unchanged') testCase.origin = 'historical_modified'; materializeExecutionConfirmations(run, [testCase]); invalidateAudit(run); validateCurrentDependencyGraph(run); return presentCase(testCase, true)
    })
  }

  async deleteCase(projectVersionId: string, designId: string, runId: string, caseId: string, principal: Principal) { return this.store.transaction(state => { assertOpenVersion(state, projectVersionId); const run = findRun(state, projectVersionId, designId, runId); const testCase = findCase(run, caseId); testCase.tombstonedAt ??= now(); testCase.reviewState = 'draft'; invalidateAudit(run); validateCurrentDependencyGraph(run); return { caseId, deletedBy: principal.subjectId, tombstonedAt: testCase.tombstonedAt } }) }

  async reviewCase(projectVersionId: string, designId: string, runId: string, caseId: string, input: { decision: 'submit' | 'approve' | 'reject' | 'request_revision' | 'withdraw'; targetRevision: number; comment?: string }, principal: Principal) {
    return this.store.transaction(state => { assertOpenVersion(state, projectVersionId); const run = findRun(state, projectVersionId, designId, runId); const testCase = findCase(run, caseId); applyReviewAction(testCase, input, principal.subjectId); invalidateAudit(run); return presentCase(testCase, true) })
  }

  async batchReview(projectVersionId: string, designId: string, runId: string, input: { targets: Array<{ caseId: string; targetRevision: number }>; decision: 'submit' | 'approve' | 'reject' | 'request_revision' | 'withdraw'; comment?: string }, principal: Principal) {
    return this.store.transaction(state => { assertOpenVersion(state, projectVersionId); const run = findRun(state, projectVersionId, designId, runId); const targets = input.targets.map(target => ({ target, testCase: findCase(run, target.caseId) })); targets.forEach(({ target, testCase }) => { if (testCase.currentRevision !== target.targetRevision) throw new TestDesignError('TEST_CASE_REVISION_CONFLICT', `用例 ${testCase.id} revision 已变化`, 412) }); targets.forEach(({ target, testCase }) => applyReviewAction(testCase, { ...input, targetRevision: target.targetRevision }, principal.subjectId)); invalidateAudit(run); return targets.map(item => presentCase(item.testCase)) })
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
  async actOnConfirmation(projectVersionId: string, designId: string, runId: string, itemId: string, input: { expectedVersion: number; decision: 'confirm' | 'resolve' | 'defer' | 'reject' | 'reopen'; comment?: string; structuredDecision?: unknown }, principal: Principal) { return this.store.transaction(state => { assertOpenVersion(state, projectVersionId); const run = findRun(state, projectVersionId, designId, runId); const item = required(run.confirmationItems.find(candidate => candidate.id === itemId), 'TEST_DESIGN_CONFIRMATION_NOT_FOUND', '待确认项不存在'); applyDisposition(item, input, principal.subjectId); invalidateAudit(run); const requiredAction = item.impactStage === 'tree' ? 'redesign_or_edit_test_points' : item.impactStage === 'publication' ? 're_audit' : 'resynthesize'; return { item: structuredClone(item), requiredAction } }) }

  async listCaseChangeProposals(projectVersionId: string, designId: string, runId: string, operation?: string) { const run = await this.loadScopedRun(projectVersionId, designId, runId); return structuredClone((run.caseChangeProposals ?? []).filter(item => !operation || item.operation === operation)) }

  async decideCaseChangeProposal(projectVersionId: string, designId: string, runId: string, proposalId: string, input: { expectedVersion: number; decision: Exclude<CaseChangeDecision, 'pending'>; comment?: string; editedContent?: unknown }, principal: Principal) {
    return this.store.transaction(state => {
      assertOpenVersion(state, projectVersionId)
      const run = findRun(state, projectVersionId, designId, runId)
      const proposal = required(run.caseChangeProposals.find(item => item.id === proposalId), 'CASE_CHANGE_PROPOSAL_NOT_FOUND', '用例库变更 Proposal 不存在')
      if (proposal.decisions.length !== input.expectedVersion) throw new TestDesignError('CASE_CHANGE_PROPOSAL_VERSION_CONFLICT', 'Proposal 决策版本已变化', 409)
      validateProposalDecision(proposal, input.decision)
      let editedContentSha256: string | undefined
      if (input.decision === 'accepted_edited') {
        const candidate = required(run.testCases.find(item => item.id === proposal.candidateCaseId), 'CASE_CHANGE_PROPOSAL_CANDIDATE_INVALID', 'Proposal 候选用例不存在')
        const current = currentCaseRevision(candidate)
        const content = validateTestCaseContent(input.editedContent, approvedPointIds(run, candidate.treeVersionId))
        const revision = createCaseRevision(current.revision + 1, content, principal.subjectId, input.comment ?? '编辑后接受 Proposal', current.content)
        candidate.revisions.push(revision); candidate.currentRevision = revision.revision; candidate.reviewState = 'draft'
        proposal.candidateContent = structuredClone(content); proposal.diff = proposalSourceContent(run, proposal) ? structuralDiff(proposalSourceContent(run, proposal), content) : []
        editedContentSha256 = revision.contentSha256
        materializeExecutionConfirmations(run, [candidate])
        invalidateAudit(run)
      }
      const decidedAt = now()
      proposal.decision = input.decision; proposal.decidedBy = principal.subjectId; proposal.decidedAt = decidedAt
      proposal.decisions.push({ id: `case_change_decision_${randomUUID()}`, expectedVersion: input.expectedVersion, decision: input.decision, ...(input.comment?.trim() ? { comment: input.comment.trim().slice(0, 4_000) } : {}), ...(editedContentSha256 ? { editedContentSha256 } : {}), decidedBy: principal.subjectId, decidedAt })
      return structuredClone(proposal)
    })
  }

  async listLibraryCases(projectId: string, filters: { domain?: string; dimension?: string; executionMethod?: string; priority?: string; status?: string; tag?: string } = {}) {
    const state = await this.store.snapshot(); const aggregate = readDesignState(state)
    return aggregate.libraryCases.filter(item => item.projectId === projectId).filter(item => {
      const content = currentLibraryRevision(item).content
      return (!filters.domain || content.domain === filters.domain) && (!filters.dimension || content.dimension === filters.dimension) && (!filters.executionMethod || executionMethodForContent(content) === filters.executionMethod || content.executionMethods.some(method => method.method === filters.executionMethod)) && (!filters.priority || content.priority === filters.priority) && (!filters.status || item.status === filters.status) && (!filters.tag || content.tags.includes(filters.tag))
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
      assertLibraryBaselineUnchanged(aggregate, design.projectId, run)
      const audit = required(run.coverageAudits.find(item => item.id === input.expectedAuditId && item.status === 'valid'), 'COVERAGE_AUDIT_STALE', '覆盖审计不存在或已失效')
      if (audit.blockers.length) throw new TestDesignError('TEST_CASE_LIBRARY_PUBLICATION_BLOCKED', 'Coverage Audit 存在发布阻断项', 409, { blockers: audit.blockers })
      if (audit.caseSetSha256 !== input.expectedCaseSetSha256) throw new TestDesignError('TEST_CASE_LIBRARY_HASH_MISMATCH', '候选用例 Hash 与审计不一致', 409)
      const proposalSha256 = caseChangeProposalSha256(run.caseChangeProposals)
      if (proposalSha256 !== input.expectedProposalSha256) throw new TestDesignError('CASE_CHANGE_PROPOSAL_HASH_MISMATCH', 'Proposal 决策 Hash 已变化', 409)
      const pending = run.caseChangeProposals.filter(item => item.decision === 'pending'); if (pending.length) throw new TestDesignError('CASE_CHANGE_PROPOSAL_DECISION_REQUIRED', '所有 Proposal 必须先完成人工处置', 409, { proposalIds: pending.map(item => item.id) })
      const currentAudit = runCoverageAudit(run); if (currentAudit.inputSha256 !== audit.inputSha256 || currentAudit.caseSetSha256 !== audit.caseSetSha256 || currentAudit.blockers.length) throw new TestDesignError('COVERAGE_AUDIT_STALE', '发布前测试设计状态已变化，请重新审计', 409)
      assertLibraryPublicationGates(aggregate, design.projectId, run)
      const previous = aggregate.libraryVersions.filter(item => item.projectId === design.projectId).sort((left, right) => right.version - left.version)[0]
      assertLibraryBaselineMembersCurrent(aggregate, design.projectId, run, previous)
      assertProposalSourcesCurrent(aggregate, design.projectId, run, previous)
      const members = new Map((previous?.members ?? []).map(item => [item.caseId, { ...item }]))
      for (const proposal of run.caseChangeProposals) applyProposalToLibrary(aggregate, design.projectId, run, proposal, members, principal.subjectId)
      const orderedMembers = [...members.values()].sort((left, right) => left.caseId.localeCompare(right.caseId)).map((member, ordinal) => freezeLibraryVersionMember(aggregate, design.projectId, { ...member, ordinal }))
      const canonicalContent = { schemaVersion: 'test-case-library/v1', projectId: design.projectId, sourceRunId: runId, members: orderedMembers }
      const contentSha256 = canonicalSha256(canonicalContent)
      const proposalStatistics = Object.fromEntries((['reuse', 'update', 'create', 'deprecate', 'reference'] as const).map(operation => [operation, run.caseChangeProposals.filter(item => item.operation === operation && item.decision !== 'rejected').length])) as Record<CaseChangeProposal['operation'], number>
      const dimensionStatistics = orderedMembers.reduce<Partial<Record<TestCaseContent['dimension'], number>>>((result, member) => { const content = required(aggregate.libraryCases.find(item => item.id === member.caseId)?.revisions.find(item => item.revision === member.revision)?.content, 'LIBRARY_TEST_CASE_REVISION_NOT_FOUND', '发布成员 Revision 不存在'); result[content.dimension] = (result[content.dimension] ?? 0) + 1; return result }, {})
      const version: TestCaseLibraryVersion = { id: `test_case_library_version_${randomUUID()}`, projectId: design.projectId, version: Math.max(0, ...aggregate.libraryVersions.filter(item => item.projectId === design.projectId).map(item => item.version)) + 1, name: cleanRequired(input.name, '用例库版本名称', 200), sourceRunId: runId, members: orderedMembers, contentSha256, publishedBy: principal.subjectId, publishedAt: now(), projection: { status: 'pending', files: [] }, publicationSummary: { proposalStatistics, dimensionStatistics, coverageAudit: { id: audit.id, statistics: structuredClone(audit.statistics), blockerCount: audit.blockers.length } } }
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
      if (audit.blockers.length) throw new TestDesignError('TEST_CASE_SET_PUBLICATION_BLOCKED', '存在发布阻断项', 409, { blockers: audit.blockers })
      if (audit.caseSetSha256 !== input.expectedCaseSetSha256) throw new TestDesignError('TEST_CASE_SET_HASH_MISMATCH', '用例集合 Hash 与审计不一致', 409)
      const currentAudit = runCoverageAudit(run)
      if (currentAudit.inputSha256 !== audit.inputSha256 || currentAudit.caseSetSha256 !== audit.caseSetSha256) throw new TestDesignError('COVERAGE_AUDIT_STALE', '当前树、用例、数据、依据或处置状态与审计不一致', 409)
      if (currentAudit.blockers.length) throw new TestDesignError('TEST_CASE_SET_PUBLICATION_BLOCKED', '当前状态仍存在发布阻断项', 409, { blockers: currentAudit.blockers })
      const treeVersion = approvedTreeVersion(run); const dataSet = required(run.dataSetVersions.at(-1), 'TEST_CASE_NOT_READY', '数据需求版本不存在')
      const members = run.testCases.filter(item => !item.tombstonedAt).map((testCase, ordinal) => { const revision = currentCaseRevision(testCase); if (testCase.reviewState !== 'approved') throw new TestDesignError('TEST_CASE_REVIEW_REQUIRED', `用例 ${testCase.id} 未批准`, 409); return { caseId: testCase.id, revision: revision.revision, ordinal, contentSha256: revision.contentSha256 } })
      const canonicalContent = { schemaVersion: 'test-case-set/v1', projectVersionId, testDesignId: designId, runId, treeVersion: { id: treeVersion.id, sha256: treeVersion.treeSha256 }, dataSetVersion: { id: dataSet.id, sha256: dataSet.contentSha256 }, coverageAudit: { id: audit.id, inputSha256: audit.inputSha256 }, cases: members.map(member => ({ ...member, content: currentCaseRevision(findCase(run, member.caseId)).content })) }
      const contentSha256 = canonicalSha256(canonicalContent); const aggregate = designState(state); const existing = aggregate.caseSetVersions.find(item => item.testDesignId === designId && item.contentSha256 === contentSha256); if (existing) return structuredClone(existing)
      const version: TestCaseSetVersion = { id: `test_case_set_${randomUUID()}`, projectId: design.projectId, projectVersionId, testDesignId: designId, runId, version: Math.max(0, ...aggregate.caseSetVersions.filter(item => item.testDesignId === designId).map(item => item.version)) + 1, schemaVersion: 'test-case-set/v1', name: cleanRequired(input.name, '用例集名称', 200), treeVersionId: treeVersion.id, dataSetVersionId: dataSet.id, coverageAuditId: audit.id, members, canonicalContent, contentSha256, publishedBy: principal.subjectId, publishedAt: now(), projection: { status: 'pending', files: [] } }
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

  async createLibraryHandoff(projectVersionId: string, libraryVersionId: string, input: { mode: 'smoke' | 'regression' | 'full' | 'custom'; suiteVersionId?: string; impactedCaseIds?: string[]; expectedLibrarySha256: string; executionReadinessOverrides?: Array<{ caseId: string; revision: number; reason: string }> }, principal: Principal) {
    return this.store.transaction(state => {
      assertOpenVersion(state, projectVersionId); const projectVersion = required(state.projectVersions.find(item => item.id === projectVersionId), 'PROJECT_VERSION_NOT_FOUND', '项目版本不存在'); const aggregate = designState(state); const libraryVersion = required(aggregate.libraryVersions.find(item => item.id === libraryVersionId && item.projectId === projectVersion.projectId), 'TEST_CASE_LIBRARY_VERSION_NOT_FOUND', '用例库版本不存在'); if (libraryVersion.contentSha256 !== input.expectedLibrarySha256) throw new TestDesignError('TEST_CASE_LIBRARY_HASH_MISMATCH', '用例库版本 Hash 不一致', 409)
      const detailedLibraryVersion = presentLibraryVersion(aggregate, libraryVersion)
      const expectedSuiteType = input.mode === 'smoke' ? 'smoke' : input.mode === 'regression' ? 'regression' : input.mode === 'custom' ? 'custom' : undefined
      const suite = expectedSuiteType ? required(aggregate.suiteVersions.find(item => item.id === input.suiteVersionId && item.projectId === projectVersion.projectId && item.suiteType === expectedSuiteType && item.status !== 'deprecated'), 'TEST_SUITE_VERSION_NOT_FOUND', `${expectedSuiteType} 套件版本不存在`) : undefined
      if (suite && (suite.compatibilityStatus === 'migration_required' || !suite.testCaseLibraryVersionId || suite.testCaseLibraryVersionId !== libraryVersion.id)) throw new TestDesignError('TEST_EXECUTION_HANDOFF_LIBRARY_VERSION_MISMATCH', '套件版本与选择的正式用例库版本不一致或需要人工迁移', 422)
      if (input.mode === 'full' && input.suiteVersionId) throw new TestDesignError('TEST_EXECUTION_HANDOFF_SUITE_FORBIDDEN', 'Full Handoff 不使用测试套件', 422)
      const libraryMembers = new Map(detailedLibraryVersion.members.map(item => [item.caseId, item]))
      const selections = input.mode === 'full'
        ? detailedLibraryVersion.members.map(item => ({ ...item, executionMethod: undefined as TestExecutionMethod | undefined, reason: '指定用例库版本的全部冻结用例' }))
        : suite!.members.map(item => { if (item.testCaseLibraryVersionId !== libraryVersion.id) throw new TestDesignError('TEST_EXECUTION_HANDOFF_LIBRARY_VERSION_MISMATCH', '套件成员不属于指定用例库版本', 422); const libraryMember = required(libraryMembers.get(item.caseId), 'TEST_SUITE_MEMBER_NOT_FOUND', '套件成员不属于指定用例库版本'); if (item.revision !== libraryMember.revision) throw new TestDesignError('TEST_EXECUTION_HANDOFF_LIBRARY_VERSION_MISMATCH', '套件成员 Revision 与用例库版本冻结 Revision 不一致', 422, { caseId: item.caseId, suiteRevision: item.revision, libraryRevision: libraryMember.revision }); return { ...libraryMember, executionMethod: item.executionMethod, reason: item.reason } })
      if (input.mode === 'regression') for (const caseId of [...new Set(input.impactedCaseIds ?? [])]) { const member = required(libraryMembers.get(caseId), 'TEST_CASE_LIBRARY_MEMBER_NOT_FOUND', '变更影响用例不属于指定用例库版本'); if (!selections.some(item => item.caseId === caseId)) selections.push({ ...member, executionMethod: undefined, reason: '需求变更影响分析补充' }) }
      if (input.executionReadinessOverrides !== undefined && !Array.isArray(input.executionReadinessOverrides)) throw new TestDesignError('TEST_EXECUTION_CASE_NOT_READY', 'executionReadinessOverrides 必须是数组', 422)
      const overrides = new Map<string, { reason: string; actorId: string; createdAt: string }>()
      for (const [index, override] of (input.executionReadinessOverrides ?? []).entries()) {
        if (!override || typeof override !== 'object' || !Number.isInteger(override.revision) || override.revision < 1) throw new TestDesignError('TEST_EXECUTION_CASE_NOT_READY', `executionReadinessOverrides[${index}] 无效`, 422)
        const caseId = cleanRequired(override.caseId, `executionReadinessOverrides[${index}].caseId`, 500)
        const key = `${caseId}:${override.revision}`
        if (overrides.has(key)) throw new TestDesignError('TEST_EXECUTION_CASE_NOT_READY', '同一 Case Revision 的人工覆盖决定不得重复', 422, { caseId, revision: override.revision })
        overrides.set(key, { reason: cleanRequired(override.reason, `executionReadinessOverrides[${index}].reason`, 2_000), actorId: principal.subjectId, createdAt: now() })
      }
      const usedOverrides = new Set<string>()
      const members = selections.map((selection, ordinal) => {
        const content = required(selection.frozenContent, 'TEST_EXECUTION_CASE_NOT_READY', '正式用例库版本缺少冻结内容')
        const executionSpec = required(content.executionSpec, 'TEST_EXECUTION_CASE_NOT_READY', '正式用例缺少 executionSpec')
        const configuration = executionConfiguration(content)
        const overrideKey = `${selection.caseId}:${selection.revision}`
        const readinessOverride = overrides.get(overrideKey)
        if (configuration.status === 'blocked') throw new TestDesignError('TEST_EXECUTION_CASE_BLOCKED', 'blocked 用例禁止进入 Execution Handoff，人工覆盖不能绕过', 422, { caseId: selection.caseId, revision: selection.revision, issues: configuration.issues })
        if (configuration.status === 'needs_confirmation' && !readinessOverride) throw new TestDesignError('TEST_EXECUTION_READINESS_OVERRIDE_REQUIRED', 'needs_confirmation 用例需要明确的人工覆盖决定和原因', 422, { caseId: selection.caseId, revision: selection.revision, issues: configuration.issues })
        if (readinessOverride) usedOverrides.add(overrideKey)
        const method = selection.executionMethod ?? executionMethodForContent(content)
        if (selection.executionMethod && selection.executionMethod !== executionMethodForContent(content)) throw new TestDesignError('TEST_SUITE_EXECUTION_METHOD_INVALID', '套件执行方式与冻结 Revision 的 executionSpec 不一致', 422)
        const reason = cleanRequired(selection.reason, '选择原因', 2_000)
        return { stage: input.mode, ordinal, sourceVersionId: suite?.id ?? libraryVersion.id, caseId: selection.caseId, revision: selection.revision, method, reason, dedupKey: `${selection.caseId}:${selection.revision}:${method}`, dimension: content.dimension, executionSpec: structuredClone(executionSpec), ...(selection.traceability ? { traceability: structuredClone(selection.traceability) } : {}), selectionReason: reason, contentSha256: selection.contentSha256, ...(readinessOverride ? { readinessOverride } : {}) }
      })
      const unusedOverrides = [...overrides.keys()].filter(key => !usedOverrides.has(key))
      if (unusedOverrides.length) throw new TestDesignError('TEST_EXECUTION_CASE_NOT_READY', '人工覆盖只能引用本次选择中 needs_confirmation 的冻结 Case Revision', 422, { overrides: unusedOverrides })
      const canonicalContent = { projectId: projectVersion.projectId, projectVersionId, testCaseLibraryVersionId: libraryVersion.id, ...(suite ? { suiteVersionId: suite.id } : {}), mode: input.mode, members }
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
    return this.store.transaction(state => { const aggregate = designState(state); const version = required(aggregate.caseSetVersions.find(item => item.id === versionId), 'TEST_CASE_SET_NOT_FOUND', '用例集版本不存在'); assertOpenVersion(state, version.projectVersionId); const references: ImpactedRegressionReference[] = values.map(value => { const suite = required(aggregate.suiteVersions.find(item => item.id === value.suiteVersionId && item.projectId === version.projectId && item.suiteType === 'regression'), 'TEST_SUITE_VERSION_NOT_FOUND', '回归套件版本不存在'); const member = required(suite.members.find(item => item.caseId === value.caseId), 'TEST_SUITE_MEMBER_NOT_FOUND', '回归套件成员不存在'); if (!value.executionMethods.length || value.executionMethods.some(method => !member.executionMethods.includes(method))) throw new TestDesignError('TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', '影响回归执行方式必须是套件成员方式的非空子集', 422); return { ...value, testCaseSetVersionId: versionId, reason: cleanRequired(value.reason, '影响理由', 2_000), actorId: principal.subjectId, createdAt: now() } }); const run = required(aggregate.runs.find(item => item.id === version.runId), 'TEST_DESIGN_RUN_NOT_FOUND', '运行不存在'); run.impactedRegression = [...run.impactedRegression.filter(item => item.testCaseSetVersionId !== versionId), ...references]; return structuredClone(references) })
  }

  async createHandoff(versionId: string, input: { strategy: 'standard' | 'fast' | 'full'; smokeSuiteVersionId?: string; regressionSuiteVersionId?: string; expectedCaseSetSha256: string }, principal: Principal) {
    return this.store.transaction(state => {
      const aggregate = designState(state); const version = required(aggregate.caseSetVersions.find(item => item.id === versionId), 'TEST_CASE_SET_NOT_FOUND', '用例集版本不存在'); assertOpenVersion(state, version.projectVersionId); if (version.contentSha256 !== input.expectedCaseSetSha256) throw new TestDesignError('TEST_CASE_SET_HASH_MISMATCH', '用例集 Hash 已变化', 409)
      const run = required(aggregate.runs.find(item => item.id === version.runId), 'TEST_DESIGN_RUN_NOT_FOUND', '运行不存在'); const smoke = input.smokeSuiteVersionId ? required(aggregate.suiteVersions.find(item => item.id === input.smokeSuiteVersionId && item.projectId === version.projectId && item.suiteType === 'smoke'), 'TEST_SUITE_VERSION_NOT_FOUND', '冒烟套件版本不存在') : undefined; const regression = input.regressionSuiteVersionId ? required(aggregate.suiteVersions.find(item => item.id === input.regressionSuiteVersionId && item.projectId === version.projectId && item.suiteType === 'regression'), 'TEST_SUITE_VERSION_NOT_FOUND', '回归套件版本不存在') : undefined
      if (input.strategy !== 'full' && (!smoke || !regression)) throw new TestDesignError('TEST_EXECUTION_HANDOFF_BASELINE_REQUIRED', '标准或快速交接必须固定冒烟和回归套件版本', 422)
      if (input.strategy === 'full' && !regression) throw new TestDesignError('TEST_EXECUTION_HANDOFF_BASELINE_REQUIRED', '直接全量交接必须固定回归套件版本', 422)
      const members: TestExecutionHandoff['members'] = []; const add = (stage: TestExecutionHandoff['members'][number]['stage'], sourceVersionId: string, caseId: string, revision: number, methods: Array<'ui' | 'api'>, reason: string) => methods.forEach(method => { const dedupKey = `${caseId}:${revision}:${method}`; if (!members.some(item => item.dedupKey === dedupKey)) members.push({ stage, ordinal: members.length, sourceVersionId, caseId, revision, method, reason, dedupKey }) })
      if (input.strategy !== 'full') {
        smoke!.members.forEach(item => add('smoke', smoke!.id, item.caseId, item.revision, item.executionMethods, item.reason))
        run.smokeCandidates.filter(item => item.testCaseSetVersionId === version.id && item.decision === 'accepted').forEach(item => {
          if (!item.stable || !item.dependencyReady) throw new TestDesignError('TEST_EXECUTION_HANDOFF_SMOKE_CANDIDATE_NOT_READY', `冒烟候选 ${item.caseId} 尚未满足稳定性或依赖条件`, 422)
          const member = required(version.members.find(candidate => candidate.caseId === item.caseId), 'TEST_CASE_SET_MEMBER_NOT_FOUND', '冒烟候选不属于当前功能集')
          add('smoke', version.id, item.caseId, member.revision, item.executionMethods, item.reason)
        })
      }
      if (input.strategy !== 'full') version.members.forEach(item => { const testCase = findCase(run, item.caseId); add('new_feature', version.id, item.caseId, item.revision, currentCaseRevision(testCase).content.executionMethods.map(method => method.method), '本次新功能用例') })
      if (input.strategy !== 'full') run.impactedRegression.filter(item => item.testCaseSetVersionId === version.id).forEach(item => { if (item.suiteVersionId !== regression!.id) throw new TestDesignError('TEST_EXECUTION_HANDOFF_REGRESSION_VERSION_MISMATCH', '影响回归引用与固定回归套件版本不一致', 422); const member = required(regression!.members.find(candidate => candidate.caseId === item.caseId), 'TEST_SUITE_MEMBER_NOT_FOUND', '影响回归套件成员不存在'); add('impacted_regression', regression!.id, item.caseId, member.revision, item.executionMethods, item.reason) })
      if (input.strategy !== 'fast') regression!.members.forEach(item => add('full_regression', regression!.id, item.caseId, item.revision, item.executionMethods, item.reason))
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

  private async executeNode(runId: string, key: Exclude<TestDesignNodeKey, 'test_point_review' | 'coverage_audit'>, signal: AbortSignal, upstream: unknown) {
    await this.store.transaction(state => { const run = findRunById(state, runId); const target = node(run, key); Object.assign(target, { status: 'running', attempt: target.attempt + 1, startedAt: now(), finishedAt: undefined, error: undefined, errorCode: undefined, execution: undefined }); Object.assign(run, { status: 'running', stage: key, startedAt: run.startedAt ?? now(), finishedAt: undefined, error: undefined, errorCode: undefined }); if (key === 'test_design_repair' && run.automaticRepair?.status === 'queued') Object.assign(run.automaticRepair, { status: 'running', startedAt: now(), finishedAt: undefined }) })
    const run = await this.loadRun(runId); return this.runtime!.execute({ stage: key, run, upstream }, signal)
  }
  private startLocally(runId: string) { if (this.activeRuns.has(runId)) return; const controller = new AbortController(); this.activeRuns.set(runId, controller); void this.processPreparedRun(runId, controller.signal).catch(() => undefined).finally(() => this.activeRuns.delete(runId)) }
  private async schedule(runId: string) { if (!this.store.enqueueTestDesignJob) { this.startLocally(runId); return } const run = await this.loadRun(runId); const targets = run.nodeRuns.filter(item => item.status === 'queued'); await Promise.all(targets.map(async target => { const createdAt = now(); await this.store.enqueueTestDesignJob!({ id: `workflow_job_${randomUUID()}`, runId, nodeRunId: target.id, status: 'queued', attempts: 0, maxAttempts: 3, availableAt: createdAt, createdAt, updatedAt: createdAt }) })) }
  private async fencedNodeTransaction<T>(nodeRunId: string, lease: TaskLease, operation: (draft: DatabaseState) => T | Promise<T>) { if (!this.store.transactionWithTestDesignLease) throw new TestDesignError('WORKFLOW_JOB_LEASE_LOST', '当前 Store 不支持测试设计节点租约', 503); const result = await this.store.transactionWithTestDesignLease(nodeRunId, lease, operation); if (result === null) throw new TestDesignError('WORKFLOW_JOB_LEASE_LOST', '测试设计节点租约已失效', 409); return result }
  private async loadRun(runId: string) { const state = await this.store.snapshot(); return structuredClone(findRunById(state, runId)) }
  private async loadScopedRun(projectVersionId: string, designId: string, runId: string) { const state = await this.store.snapshot(); return structuredClone(findRun(state, projectVersionId, designId, runId)) }
  private async projectTreeVersion(projectVersionId: string, designId: string, runId: string, treeVersionId: string) {
    if (!this.projector) throw new TestDesignError('TEST_DESIGN_WORKSPACE_PROJECTION_UNAVAILABLE', '测试点树必须投影到正式 AssetVersion，但资产服务不可用', 503)
    const state = await this.store.snapshot()
    const run = findRun(state, projectVersionId, designId, runId)
    const projectVersion = required(state.projectVersions.find(item => item.id === projectVersionId), 'PROJECT_VERSION_NOT_FOUND', '项目版本不存在')
    const base = required(state.knowledgeBases.find(item => item.projectId === projectVersion.projectId), 'TEST_DESIGN_WORKSPACE_PROJECTION_UNAVAILABLE', '项目知识库不存在')
    const tree = required(run.testPointTree, 'TEST_POINT_TREE_NOT_FOUND', '测试点树不存在')
    const version = required(tree.versions.find(item => item.id === treeVersionId), 'TEST_POINT_TREE_APPROVAL_REQUIRED', '测试点树版本不存在')
    const revision = required(tree.revisions.find(item => item.revision === version.revision), 'TEST_POINT_TREE_REVISION_NOT_FOUND', '测试点树 revision 不存在')
    const files = testPointProjectionFiles(projectVersion.name, tree, version, revision)
    try {
      const projected = await this.projectWorkspaceFiles(base.id, `test-point-tree:${version.id}`, 'test_design', files, 'upload')
      await this.store.transaction(draft => {
        const current = findRun(draft, projectVersionId, designId, runId)
        const target = required(current.testPointTree?.versions.find(item => item.id === version.id), 'TEST_POINT_TREE_APPROVAL_REQUIRED', '测试点树版本不存在')
        target.projection = { status: projected.some(item => item.pending) ? 'pending' : 'succeeded', files: projected.map(item => ({ logicalPath: item.file.logicalPath, contentSha256: item.file.contentSha256, assetVersionId: item.assetVersionId })) }
        const paths = new Set(projected.map(item => item.file.logicalPath))
        current.formalWorkspaceFiles = [...current.formalWorkspaceFiles.filter(item => !paths.has(item.logicalPath)), ...projected.map(item => ({ ...item.file, sourceType: 'test_point_tree_version' as const, sourceId: version.id, assetVersionId: item.assetVersionId }))]
      })
    } catch (error) {
      await this.store.transaction(draft => { const target = required(findRun(draft, projectVersionId, designId, runId).testPointTree?.versions.find(item => item.id === version.id), 'TEST_POINT_TREE_APPROVAL_REQUIRED', '测试点树版本不存在'); target.projection = { status: 'failed', files: [], error: String(error instanceof Error ? error.message : error).slice(0, 2_000) } })
      throw error
    }
  }

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
    ['test_point_design', []],
    ['test_point_review', ['test_point_design']],
    ['test_case_design', ['test_point_review']],
    ['coverage_audit', ['test_case_design']],
    ['test_design_repair', ['coverage_audit']],
  ]
  return definition.map(([nodeKey, dependencies]) => ({ id: `${runId}:${nodeKey}:g1:a0`, nodeKey, generation: 1, attempt: 0, status: nodeKey === 'test_point_design' ? 'queued' : 'pending', dependencies }))
}

function pointDesignInput(run: TestDesignWorkflowRun) {
  return { workspaceSnapshotSha256: run.workspaceSnapshot.snapshotSha256, requirementReleaseId: run.workspaceSnapshot.requirementReleaseId, requirementsJsonSha256: run.workspaceSnapshot.requirementsJsonSha256 }
}

function caseDesignInput(run: TestDesignWorkflowRun) {
  const tree = required(run.testPointTree, 'TEST_POINT_TREE_APPROVAL_REQUIRED', '测试点树不存在')
  const treeVersion = required(tree.versions.find(item => item.id === tree.currentApprovedVersionId), 'TEST_POINT_TREE_APPROVAL_REQUIRED', '测试点树尚未通过自动校验并固化')
  return { treeVersionId: treeVersion.id, treeSha256: treeVersion.treeSha256, projectionFiles: treeVersion.projection.files }
}

function repairInput(run: TestDesignWorkflowRun) {
  const state = required(run.automaticRepair, 'TEST_DESIGN_REPAIR_NOT_QUEUED', '自动修复状态不存在')
  const audit = required(run.coverageAudits.find(item => item.id === state.triggerAuditId), 'TEST_DESIGN_REPAIR_AUDIT_NOT_FOUND', '触发修复的 Coverage Audit 不存在')
  return { schemaVersion: 'test-design-repair-context/v1', attempt: state.attempt, maxAttempts: state.maxAttempts, auditId: audit.id, blockers: audit.blockers.filter(item => item.resolution === 'agent_repair'), candidateWorkspacePath: 'workspace/agent_workspace/planning_agent/current-test-cases.json' }
}

function materializeDesignIssues(run: TestDesignWorkflowRun, raw: unknown) {
  const value = raw && typeof raw === 'object' ? raw as { findings?: unknown[]; confirmationItems?: unknown[] } : {}
  const findings = (Array.isArray(value.findings) ? value.findings : []).slice(0, 500).map((candidate, index) => { const item = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {}; return { id: `test_design_finding_${randomUUID()}`, title: cleanRequired(String(item.title ?? `Finding ${index + 1}`), 'Finding 标题', 500), description: String(item.description ?? '').slice(0, 8_000), severity: ['blocker', 'high', 'medium', 'low'].includes(String(item.severity)) ? item.severity as 'blocker' | 'high' | 'medium' | 'low' : 'medium', basisRefs: Array.isArray(item.basisRefs) ? item.basisRefs.map(String) : [], state: 'open' as const, actions: [] } })
  const confirmations = (Array.isArray(value.confirmationItems) ? value.confirmationItems : []).slice(0, 500).map((candidate, index) => { const item = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {}; return { id: `test_design_confirmation_${randomUUID()}`, title: cleanRequired(String(item.title ?? `待确认项 ${index + 1}`), '待确认项标题', 500), question: String(item.question ?? '').slice(0, 8_000), decisionType: String(item.decisionType ?? 'other').slice(0, 200), impactStage: ['tree', 'case', 'data', 'publication'].includes(String(item.impactStage)) ? item.impactStage as 'tree' | 'case' | 'data' | 'publication' : 'publication', affectedRefs: Array.isArray(item.affectedRefs) ? item.affectedRefs.map(String) : [], blocker: item.blocker === true, state: 'open' as const, actions: [] } })
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
    locator: { coverageTarget: true, requirementReleaseId: requirement.release.id, verificationRunId: requirement.analysisRun.id, requirementPointId: point.clientRequirementPointId, ordinal: index, evidenceRefs: point.evidenceRefs },
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
  const items: HistoricalCaseSnapshot['items'] = []
  const selection = design.input.historicalLibrarySelection ?? { mode: 'latest_library' as const }
  let libraryVersion: TestCaseLibraryVersion | undefined
  let memberFilter: Set<string> | undefined
  let kind: 'test_case_library' | 'historical_test_suite' = 'test_case_library'
  if (selection.mode === 'latest_library') libraryVersion = aggregate.libraryVersions.filter(item => item.projectId === design.projectId).sort((left, right) => right.version - left.version)[0]
  if (selection.mode === 'library_version') libraryVersion = aggregate.libraryVersions.find(item => item.id === selection.testCaseLibraryVersionId && item.projectId === design.projectId)
  if (selection.mode === 'suite_version') {
    const suite = required(aggregate.suiteVersions.find(item => item.id === selection.suiteVersionId && item.projectId === design.projectId && item.status !== 'deprecated'), 'TEST_DESIGN_HISTORICAL_SOURCE_INVALID', '历史测试套件版本不存在')
    if (!suite.testCaseLibraryVersionId || suite.compatibilityStatus === 'migration_required' || suite.members.some(item => item.testCaseLibraryVersionId !== suite.testCaseLibraryVersionId)) throw new TestDesignError('TEST_DESIGN_HISTORICAL_SOURCE_INVALID', '历史测试套件没有固定唯一用例库版本，需要人工迁移', 422)
    libraryVersion = aggregate.libraryVersions.find(item => item.id === suite.testCaseLibraryVersionId && item.projectId === design.projectId)
    memberFilter = new Set(suite.members.map(item => `${item.caseId}:${item.revision}`))
    kind = 'historical_test_suite'
  }
  if (selection.mode !== 'none' && selection.mode !== 'latest_library') required(libraryVersion, 'TEST_DESIGN_HISTORICAL_SOURCE_INVALID', '指定的历史用例库版本不存在')
  for (const member of libraryVersion?.members ?? []) {
    if (memberFilter && !memberFilter.has(`${member.caseId}:${member.revision}`)) continue
    const sourceCase = required(aggregate.libraryCases.find(item => item.id === member.caseId && item.projectId === design.projectId), 'TEST_DESIGN_HISTORICAL_SOURCE_INVALID', '正式历史用例不存在')
    const revision = required(sourceCase.revisions.find(item => item.revision === member.revision), 'TEST_DESIGN_HISTORICAL_SOURCE_INVALID', '正式历史用例 Revision 不存在')
    items.push({ id: `history_${libraryVersion!.id}_${sourceCase.id}_${revision.revision}`, kind, sourceId: `${libraryVersion!.id}:${sourceCase.id}:${revision.revision}`, contentSha256: revision.semanticSha256, content: structuredClone(revision.content), locator: { testCaseLibraryVersionId: libraryVersion!.id, caseId: sourceCase.id, revision: revision.revision, status: sourceCase.status } })
  }
  for (const legacySelection of design.input.historicalCaseSelections ?? []) {
    if (legacySelection.sourceType !== 'asset_version') continue
    items.push(assetContentRef(state, design.projectId, legacySelection.assetVersionId!, 'historical_case_asset'))
  }
  const latestLibraryVersion = aggregate.libraryVersions.filter(item => item.projectId === design.projectId).sort((left, right) => right.version - left.version)[0]
  const baseline = libraryVersion ?? latestLibraryVersion
  const base = { schemaVersion: 'historical-case-snapshot/v1' as const, items, ...(baseline ? { baseTestCaseLibraryVersionId: baseline.id, baseTestCaseLibraryVersionSha256: baseline.contentSha256 } : {}), createdAt }
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

function validateDesignSources(state: DatabaseState, projectId: string, input: CreateTestDesignInput) {
  const augmentation = input.knowledgeAugmentation
  if (augmentation.mode === 'selected_assets') augmentation.assetVersionIds.forEach(id => assetContentRef(state, projectId, id, 'knowledge_asset'))
  if (augmentation.mode === 'fixed_index') {
    const index = required(state.indexes.find(item => item.id === augmentation.indexVersionId && item.status === 'active'), 'TEST_DESIGN_AUGMENTATION_INVALID', '固定索引不存在或未激活')
    const base = required(state.knowledgeBases.find(item => item.id === index.knowledgeBaseId), 'TEST_DESIGN_AUGMENTATION_INVALID', '固定索引知识库不存在')
    if (base.projectId !== projectId) throw new TestDesignError('TEST_DESIGN_AUGMENTATION_INVALID', '固定索引不属于当前项目')
  }
  for (const selection of input.historicalCaseSelections ?? []) {
    if (selection.sourceType === 'asset_version') assetContentRef(state, projectId, selection.assetVersionId!, 'historical_case_asset')
    else throw new TestDesignError('TEST_DESIGN_HISTORICAL_SOURCE_INVALID', '结构化历史用例请改用项目级用例库版本', 422)
  }
  const historical = input.historicalLibrarySelection ?? { mode: 'latest_library' as const }
  if (historical.mode === 'library_version') required(readDesignState(state).libraryVersions.find(item => item.id === historical.testCaseLibraryVersionId && item.projectId === projectId), 'TEST_DESIGN_HISTORICAL_SOURCE_INVALID', '历史用例库版本不存在')
  if (historical.mode === 'suite_version') required(readDesignState(state).suiteVersions.find(item => item.id === historical.suiteVersionId && item.projectId === projectId && item.status !== 'deprecated'), 'TEST_DESIGN_HISTORICAL_SOURCE_INVALID', '历史测试套件版本不存在')
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
  const invalidRequirement = requirements.some(item => !item || typeof item !== 'object' || Array.isArray(item) || !Array.isArray((item as { evidenceRefs?: unknown }).evidenceRefs))
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

function materializeTestPointDesign(run: TestDesignWorkflowRun, raw: unknown, actorId: string) {
  const value = validateTestPointDesignCandidate(raw)
  const idByRef = new Map(value.nodes.map(candidate => [candidate.ref, `test_point_${randomUUID()}`]))
  const nodes: TestPointNodeRevision[] = value.nodes.map((candidate, index) => ({
    nodeId: idByRef.get(candidate.ref)!,
    parentId: candidate.parentRef ? required(idByRef.get(candidate.parentRef), 'TEST_POINT_PARENT_REFERENCE_INVALID', '测试点父引用无效') : null,
    sortKey: `${String(index + 1).padStart(6, '0')}:${candidate.ref}`,
    title: candidate.title,
    objective: candidate.objective,
    dimension: candidate.dimension,
    priority: candidate.priority,
    applicability: candidate.applicability,
    designTechniques: candidate.designTechniques,
    entryMethods: candidate.entryMethods,
    oracle: candidate.oracle,
    dataConditions: candidate.dataConditions,
    risks: candidate.risks,
    assumptions: candidate.assumptions,
    basisRefs: candidate.basisRefs,
    historicalRefs: candidate.historicalRefs,
  }))
  validateTreeReferences(run, nodes)
  const treeSha256 = validateTreeNodes(nodes)
  run.testPointTree = { id: `test_point_tree_${randomUUID()}`, runId: run.id, currentRevision: 0, revisions: [{ revision: 0, parentRevision: null, nodes, operations: [], reason: 'PlanningAgent 测试点候选', actorId, treeSha256, createdAt: now() }], versions: [] }
}

function normalizeTreeBasisReferences(run: TestDesignWorkflowRun, nodes: TestPointNodeRevision[]) {
  const canonicalByRequirementPointId = new Map<string, string | null>()
  for (const item of run.basisSnapshot.items) {
    if (item.kind !== 'requirement_release') continue
    const requirementPointId = item.locator?.requirementPointId
    if (typeof requirementPointId !== 'string' || !requirementPointId) continue
    const existing = canonicalByRequirementPointId.get(requirementPointId)
    canonicalByRequirementPointId.set(requirementPointId, existing === undefined || existing === item.id ? item.id : null)
  }
  for (const node of nodes) {
    node.basisRefs = node.basisRefs.map(reference => {
      const canonical = canonicalByRequirementPointId.get(reference)
      return typeof canonical === 'string' ? canonical : reference
    })
  }
}

function validateTreeReferences(run: TestDesignWorkflowRun, nodes: TestPointNodeRevision[]) {
  normalizeTreeBasisReferences(run, nodes)
  const allowedBasis = new Set([...run.basisSnapshot.items.map(item => item.id), ...run.retrievalSnapshot.hits.map(item => item.id)])
  const allowedHistorical = new Set(run.historicalSnapshot.items.map(item => item.id))
  for (const node of nodes.filter(item => !item.deleted)) {
    const invalidBasis = node.basisRefs.filter(reference => !allowedBasis.has(reference))
    if (invalidBasis.length) throw new TestDesignError('TEST_POINT_BASIS_REFERENCE_INVALID', `测试点 ${node.title} 引用了固定输入之外的依据`, 422, { nodeId: node.nodeId, invalidRefs: invalidBasis })
    const invalidHistorical = node.historicalRefs.filter(reference => !allowedHistorical.has(reference))
    if (invalidHistorical.length) throw new TestDesignError('TEST_POINT_HISTORICAL_REFERENCE_INVALID', `测试点 ${node.title} 引用了固定快照之外的历史用例`, 422, { nodeId: node.nodeId, invalidRefs: invalidHistorical })
  }
}
function materializeCaseDesign(run: TestDesignWorkflowRun, raw: unknown, actorId: string, repair: boolean) {
  const treeVersion = approvedTreeVersion(run)
  const value = validateTestCaseDesignCandidate(raw, approvedPointIds(run, treeVersion.id), repair)
  const existingByRef = new Map(run.testCases.filter(item => !item.tombstonedAt && item.candidateRef).map(item => [item.candidateRef!, item]))
  const idByRef = new Map(value.cases.map(candidate => [candidate.ref, existingByRef.get(candidate.ref)?.id ?? `test_case_${randomUUID()}`]))
  const dataIdByRef = new Map(value.dataRequirements.map(candidate => [candidate.ref, `test_data_${randomUUID()}`]))
  const nextCases = value.cases.map(candidate => {
    const dependencies = candidate.content.dependencies.map(reference => required(idByRef.get(reference), 'TEST_CASE_DEPENDENCY_INVALID', `依赖用例 ref ${reference} 不存在`))
    const dataRequirementIds = value.dataRequirements.filter(item => item.caseRefs.includes(candidate.ref)).map(item => dataIdByRef.get(item.ref)!)
    const content = { ...candidate.content, dependencies, dataRequirementIds }
    const current = existingByRef.get(candidate.ref)
    if (current) {
      const previous = currentCaseRevision(current)
      if (previous.contentSha256 !== canonicalSha256(content)) {
        const revision = createCaseRevision(previous.revision + 1, content, actorId, 'PlanningAgent 自动修复', previous.content)
        current.revisions.push(revision)
        current.currentRevision = revision.revision
        current.reviewState = 'draft'
      }
      current.tombstonedAt = undefined
      return current
    }
    const semanticSha256 = canonicalSha256({ ...content, tags: [...content.tags].sort() })
    const historical = run.historicalSnapshot.items.find(item => item.contentSha256 === semanticSha256)
    const testCase = newCase(run.id, treeVersion.id, content, historical ? 'historical_unchanged' : 'ai', actorId, historical ? '固定历史用例原样复用' : 'PlanningAgent 候选', idByRef.get(candidate.ref)!)
    testCase.candidateRef = candidate.ref
    if (historical) testCase.historicalSourceRef = historical.id
    return testCase
  })
  if (repair) for (const removed of run.testCases.filter(item => item.candidateRef && !idByRef.has(item.candidateRef))) removed.tombstonedAt = now()
  run.testCases = repair ? [...run.testCases.filter(item => !item.candidateRef), ...nextCases] : nextCases
  const requirements: TestDataRequirement[] = value.dataRequirements.map(candidate => ({
    id: dataIdByRef.get(candidate.ref)!, name: candidate.name, entityType: candidate.entityType, featureTags: candidate.featureTags, testPointIds: candidate.testPointIds,
    caseIds: candidate.caseRefs.map(reference => required(idByRef.get(reference), 'TEST_DATA_REQUIREMENT_CASE_INVALID', `数据需求引用的用例 ref ${reference} 无效`)),
    fieldConstraints: candidate.fieldConstraints, relationships: candidate.relationships, quantity: candidate.quantity, initialState: candidate.initialState, preparationHint: candidate.preparationHint, sensitivity: candidate.sensitivity, isolation: candidate.isolation, resetAndCleanup: candidate.resetAndCleanup, readiness: candidate.readiness, ...(candidate.readinessReason ? { readinessReason: candidate.readinessReason } : {}),
  }))
  run.dataSetVersions.push(dataSetVersion(run.dataSetVersions.length + 1, validateDataRequirements(run, requirements), actorId))
  materializeCaseChangeProposals(run, value, nextCases)
  materializeDesignIssues(run, value)
  materializeExecutionConfirmations(run, nextCases)
  validateCurrentDependencyGraph(run)
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
      ? { operation: 'reuse' as const, sourceCaseId: locator.caseId, sourceRevision: locator.revision, candidateRef: testCase.candidateRef, requirementRefs: requirementRefsForCase(run, revision.content), testPointIds: revision.content.testPointIds, reason: '与冻结历史 Revision 语义一致，优先复用', confidence: 1 }
      : { operation: 'create' as const, candidateRef: testCase.candidateRef, requirementRefs: requirementRefsForCase(run, revision.content), testPointIds: revision.content.testPointIds, reason: '冻结历史用例无法覆盖该测试点', confidence: 0.8 }
  })
  const existing = new Map(run.caseChangeProposals.map(item => [proposalIdentity(item.operation, item.sourceCaseId, item.sourceRevision, cases.find(candidate => candidate.id === item.candidateCaseId)?.candidateRef), item]))
  run.caseChangeProposals = candidates.map(candidate => {
    const source = candidate.sourceCaseId && candidate.sourceRevision !== undefined ? required(frozenByCase.get(`${candidate.sourceCaseId}:${candidate.sourceRevision}`), 'CASE_CHANGE_PROPOSAL_SOURCE_INVALID', 'Proposal 来源不属于冻结历史用例') : undefined
    const testCase = candidate.candidateRef ? required(byRef.get(candidate.candidateRef), 'CASE_CHANGE_PROPOSAL_CANDIDATE_INVALID', 'Proposal 候选用例不存在') : undefined
    const content = testCase ? currentCaseRevision(testCase).content : undefined
    const identity = proposalIdentity(candidate.operation, candidate.sourceCaseId, candidate.sourceRevision, candidate.candidateRef)
    const retained = existing.get(identity)
    const createdAt = retained?.createdAt ?? now()
    return {
      id: retained?.id ?? `case_change_proposal_${randomUUID()}`,
      runId: run.id,
      operation: candidate.operation,
      ...(candidate.sourceCaseId ? { sourceCaseId: candidate.sourceCaseId } : {}),
      ...(candidate.sourceRevision !== undefined ? { sourceRevision: candidate.sourceRevision } : {}),
      ...(testCase ? { candidateCaseId: testCase.id, candidateContent: structuredClone(content) } : {}),
      diff: source && content ? structuralDiff(source.content, content) : [],
      requirementRefs: candidate.requirementRefs,
      testPointIds: candidate.testPointIds,
      reason: candidate.reason,
      confidence: candidate.confidence,
      decision: retained?.decision ?? 'pending',
      createdAt,
      ...(retained?.decidedBy ? { decidedBy: retained.decidedBy } : {}),
      ...(retained?.decidedAt ? { decidedAt: retained.decidedAt } : {}),
      decisions: retained?.decisions ?? [],
      ...(retained?.appliedCaseId ? { appliedCaseId: retained.appliedCaseId } : {}),
      ...(retained?.appliedRevision !== undefined ? { appliedRevision: retained.appliedRevision } : {}),
    }
  })
}

function materializeExecutionConfirmations(run: TestDesignWorkflowRun, cases: TestCase[]) {
  for (const testCase of cases) {
    const revision = currentCaseRevision(testCase)
    const spec = revision.content.executionSpec
    const missing = spec?.kind === 'performance' && !spec.thresholds.length ? '性能阈值及其需求来源' : spec?.kind === 'stability' && !spec.duration ? '稳定性运行时长' : spec?.kind === 'compatibility' && ![...spec.browserMatrix, ...spec.operatingSystemMatrix, ...spec.viewportMatrix, ...spec.versionMatrix].length ? '兼容性环境矩阵' : undefined
    if (!missing) continue
    const title = `${revision.content.title}：确认${missing}`
    if (run.confirmationItems.some(item => item.title === title)) continue
    run.confirmationItems.push({ id: `test_design_confirmation_${randomUUID()}`, title, question: `需求或项目配置未提供${missing}，请人工确认后再发布。`, decisionType: spec?.kind ?? revision.content.dimension, impactStage: 'publication', affectedRefs: [testCase.id, ...revision.content.testPointIds], blocker: true, state: 'open', actions: [] })
  }
}

function requirementRefsForCase(run: TestDesignWorkflowRun, content: TestCaseContent) { const pointIds = new Set(content.testPointIds); const revision = run.testPointTree?.revisions.find(item => item.revision === run.testPointTree?.versions.find(version => version.id === run.testPointTree?.currentApprovedVersionId)?.revision); return [...new Set(revision?.nodes.filter(item => pointIds.has(item.nodeId)).flatMap(item => item.basisRefs) ?? [])] }
function proposalIdentity(operation: string, sourceCaseId?: string, sourceRevision?: number, candidateRef?: string) { return `${operation}:${sourceCaseId ?? ''}:${sourceRevision ?? ''}:${candidateRef ?? ''}` }

function finalizeCaseDesignAndAudit(run: TestDesignWorkflowRun, raw: unknown, actorId: string, repair: boolean) {
  materializeCaseDesign(run, raw, actorId, repair)
  const auditNode = node(run, 'coverage_audit')
  Object.assign(auditNode, { status: 'running', attempt: auditNode.attempt + 1, startedAt: now(), finishedAt: undefined, error: undefined, errorCode: undefined })
  const audit = runCoverageAudit(run)
  run.coverageAudits.forEach(item => { item.status = 'stale' })
  run.coverageAudits.push(audit)
  finishNode(run, 'coverage_audit')

  const repairable = audit.blockers.filter(item => item.resolution === 'agent_repair')
  const requiresHumanDecision = audit.blockers.some(item => item.resolution === 'human_decision' || item.resolution === 'manual_edit')
  const state = run.automaticRepair ?? initialAutomaticRepairState()
  run.automaticRepair = state
  const safeToRepair = run.testCases.every(item => item.origin === 'ai' && item.reviewActions.length === 0)
  if (repairable.length && !requiresHumanDecision && safeToRepair && state.attempt < state.maxAttempts) {
    const timestamp = now()
    Object.assign(state, {
      status: 'queued',
      attempt: state.attempt + 1,
      blockerCodes: [...new Set(repairable.map(item => item.code))],
      triggerAuditId: audit.id,
      startedAt: state.startedAt ?? timestamp,
      finishedAt: undefined,
    })
    const repairNode = node(run, 'test_design_repair')
    if (repairNode.status === 'pending') queueNode(run, 'test_design_repair')
    else advanceNodeGeneration(run, repairNode, 'queued')
    advanceNodeGeneration(run, node(run, 'coverage_audit'), 'pending')
    Object.assign(run, { status: 'queued', stage: 'test_design_repair', progress: 80, finishedAt: undefined, error: undefined, errorCode: undefined })
    return true
  }

  const attempted = state.attempt > 0
  Object.assign(state, {
    status: repairable.length ? 'exhausted' : attempted ? 'succeeded' : 'not_needed',
    blockerCodes: [...new Set(repairable.map(item => item.code))],
    triggerAuditId: repairable.length ? audit.id : undefined,
    finishedAt: now(),
  })
  Object.assign(run, { status: 'succeeded', stage: 'completed', progress: 100, finishedAt: now(), error: undefined, errorCode: undefined })
  return false
}
function runCoverageAudit(run: TestDesignWorkflowRun): CoverageAudit { const tree = required(run.testPointTree, 'TEST_POINT_TREE_APPROVAL_REQUIRED', '测试点树不存在'); const version = approvedTreeVersion(run); const dataSet = required(run.dataSetVersions.at(-1), 'TEST_CASE_NOT_READY', '数据需求版本不存在'); return auditTestDesignCoverage({ runId: run.id, basis: run.basisSnapshot, retrieval: run.retrievalSnapshot, historical: run.historicalSnapshot, tree, treeVersion: version, cases: run.testCases, dataSet, findings: run.findings, confirmationItems: run.confirmationItems }) }
function initialAutomaticRepairState(): NonNullable<TestDesignWorkflowRun['automaticRepair']> { return { status: 'idle', attempt: 0, maxAttempts: AUTOMATIC_REPAIR_MAX_ATTEMPTS, blockerCodes: [] } }

function testPointProjectionFiles(projectVersionName: string, tree: NonNullable<TestDesignWorkflowRun['testPointTree']>, version: NonNullable<TestDesignWorkflowRun['testPointTree']>['versions'][number], revision: TestPointTreeRevision): TestDesignWorkspaceFile[] {
  const directory = `workspace/branches/${safeWorkspaceSegment(projectVersionName)}/test-design`
  const canonicalContent = { schemaVersion: 'test-point-tree/v1', treeId: tree.id, runId: tree.runId, version: version.version, versionId: version.id, revision: revision.revision, treeSha256: revision.treeSha256, nodes: revision.nodes }
  const json = `${canonicalJson(canonicalContent)}\n`
  const markdown = [
    '# 测试点设计', '',
    `- TestPointTreeVersion: ${version.id}`, `- Version: ${version.version}`, `- Revision: ${revision.revision}`, `- SHA-256: ${revision.treeSha256}`, '',
    ...revision.nodes.filter(item => !item.deleted).flatMap(item => [`${item.parentId ? '###' : '##'} ${item.title}`, '', item.objective, '', `- TP ID: ${item.nodeId}`, `- Dimension: ${item.dimension}`, `- Priority: ${item.priority}`, `- Applicability: ${item.applicability}`, `- Entry: ${item.entryMethods.join(', ') || 'N/A'}`, `- Basis: ${item.basisRefs.join(', ')}`, `- Oracle: ${item.oracle}`, '']),
  ].join('\n')
  return [
    formalWorkspaceFile(`${directory}/test-point-tree.json`, 'test_point_tree_version', version.id, json),
    formalWorkspaceFile(`${directory}/test-design.md`, 'test_point_tree_version', version.id, markdown),
  ]
}

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

function formalWorkspaceFile(logicalPath: string, sourceType: 'test_point_tree_version' | 'test_case_set_version', sourceId: string, content: string): TestDesignWorkspaceFile {
  return { logicalPath, sourceType, sourceId, contentSha256: canonicalSha256Text(content), content, displayName: logicalPath.split('/').at(-1) ?? logicalPath, sourceScope: 'formal_output' }
}

function normalizeWorkspacePath(value: string) { return value.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '') }
function isWithinWorkspace(value: string) { const normalized = normalizeWorkspacePath(value); return normalized === 'workspace' || normalized.startsWith('workspace/') }
function safeWorkspaceSegment(value: string) { const encode = (character: string) => `%${character.codePointAt(0)!.toString(16).toUpperCase().padStart(2, '0')}`; const source = value.normalize('NFC').trim() || '未命名版本'; let safe = source.replace(/[%<>:"/\\|?*\u0000-\u001F]/gu, encode).replace(/[. ]+$/gu, characters => [...characters].map(encode).join('')); if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(source)) safe = `${encode(source[0])}${safe.slice(1)}`; return safe }

function validateDataRequirements(run: TestDesignWorkflowRun, requirements: TestDataRequirement[]) { const caseIds = new Set(run.testCases.filter(item => !item.tombstonedAt).map(item => item.id)); const pointIds = approvedPointIds(run, approvedTreeVersion(run).id); const ids = new Set<string>(); return requirements.map(requirement => { if (!requirement.id || ids.has(requirement.id)) throw new TestDesignError('TEST_DATA_REQUIREMENT_SCHEMA_INVALID', '数据需求 ID 缺失或重复', 422); ids.add(requirement.id); if (!requirement.name?.trim() || !requirement.entityType?.trim() || !Number.isInteger(requirement.quantity) || requirement.quantity < 1) throw new TestDesignError('TEST_DATA_REQUIREMENT_SCHEMA_INVALID', '数据需求基础字段无效', 422); if (requirement.caseIds.some(id => !caseIds.has(id)) || requirement.testPointIds.some(id => !pointIds.has(id))) throw new TestDesignError('TEST_DATA_REQUIREMENT_REFERENCE_INVALID', '数据需求引用不属于当前运行', 422); const serialized = canonicalJson(requirement); if (/(api[_ -]?key|authorization|cookie|token|身份证|真实账号)\s*[:=]\s*[^<\s]/iu.test(serialized)) throw new TestDesignError('TEST_DATA_REQUIREMENT_SECRET_FORBIDDEN', '数据需求不能包含真实凭据或个人敏感数据', 422); return structuredClone(requirement) }) }
function dataSetVersion(version: number, requirements: TestDataRequirement[], actorId: string): TestDataRequirementSetVersion { return { id: `test_data_set_${randomUUID()}`, version, requirements: structuredClone(requirements), contentSha256: canonicalSha256(requirements), createdBy: actorId, createdAt: now() } }
function newCase(runId: string, treeVersionId: string, content: TestCaseContent, origin: TestCase['origin'], actorId: string, reason: string, id = `test_case_${randomUUID()}`): TestCase { const revision = createCaseRevision(0, content, actorId, reason); return { id, runId, treeVersionId, origin, currentRevision: 0, reviewState: 'draft', revisions: [revision], reviewActions: [] } }
function createCaseRevision(revision: number, content: TestCaseContent, actorId: string, reason: string, previous?: TestCaseContent) { return { revision, content: structuredClone(content), contentSha256: canonicalSha256(content), semanticSha256: canonicalSha256({ ...content, tags: [...content.tags].sort() }), diff: previous ? structuralDiff(previous, content) : [], editorId: actorId, reason: cleanRequired(reason, '保存说明', 2_000), createdAt: now() } }
function createLibraryRevision(revision: number, content: TestCaseContent, actorId: string, changeReason: string, sourceRunId?: string, sourceProposalId?: string, traceability?: TestCaseTraceability): LibraryTestCaseRevision { return { revision, content: structuredClone(content), contentSha256: canonicalSha256(content), semanticSha256: canonicalSha256({ ...content, tags: [...content.tags].sort() }), ...(sourceRunId ? { sourceRunId } : {}), ...(sourceProposalId ? { sourceProposalId } : {}), ...(traceability ? { traceability: structuredClone(traceability) } : {}), changeReason, createdBy: actorId, createdAt: now() } }
function currentLibraryRevision(testCase: LibraryTestCase) { return required(testCase.revisions.find(item => item.revision === testCase.currentRevision), 'LIBRARY_TEST_CASE_REVISION_NOT_FOUND', '正式用例当前 Revision 不存在') }
function libraryCaseEtag(testCase: LibraryTestCase, revision = currentLibraryRevision(testCase)) { return `"library-case:${testCase.id}:r${revision.revision}:${canonicalSha256({ contentSha256: revision.contentSha256, status: testCase.status, updatedAt: testCase.updatedAt })}"` }
function presentLibraryCase(testCase: LibraryTestCase, detail = false) { const revision = currentLibraryRevision(testCase); return { id: testCase.id, projectId: testCase.projectId, currentRevision: testCase.currentRevision, status: testCase.status, content: structuredClone(revision.content), contentSha256: revision.contentSha256, semanticSha256: revision.semanticSha256, createdAt: testCase.createdAt, updatedAt: testCase.updatedAt, etag: libraryCaseEtag(testCase, revision), ...(detail ? { revisions: structuredClone(testCase.revisions) } : {}) } }
function findLibraryCase(state: DatabaseState, projectId: string, caseId: string) { return required(designState(state).libraryCases.find(item => item.id === caseId && item.projectId === projectId), 'LIBRARY_TEST_CASE_NOT_FOUND', '正式测试用例不存在') }
function assertProjectExists(state: DatabaseState, projectId: string) { required(state.projects.find(item => item.id === projectId), 'PROJECT_NOT_FOUND', '项目不存在') }
function executionMethodForContent(content: TestCaseContent): TestExecutionMethod { if (content.executionSpec) return content.executionSpec.method; if (content.dimension === 'performance') return 'performance_tool'; if (content.dimension === 'stability') return 'long_running'; if (content.dimension === 'compatibility') return 'environment_matrix'; return content.executionMethods[0]?.method ?? 'ui' }
function concreteExecutionValue(value: unknown) { return typeof value === 'string' && Boolean(value.trim()) && !/(?:待确认|待补充|未提供|未知|legacy-untraced)/iu.test(value) }
function executionConfiguration(content: TestCaseContent): { status: 'ready' | 'needs_confirmation' | 'blocked'; issues: string[] } {
  const spec = content.executionSpec
  if (!spec) return { status: 'needs_confirmation', issues: ['缺少 executionSpec'] }
  const issues: string[] = []
  if (spec.kind === 'functional') {
    if (!spec.steps.length || spec.steps.some(step => !concreteExecutionValue(step.action) || !concreteExecutionValue(step.expected))) issues.push('功能用例缺少完整执行步骤和预期结果')
    const method = content.executionMethods.find(item => item.method === spec.method)
    if (!method) issues.push('功能用例 executionSpec.method 没有对应执行入口')
    else if (method.method === 'ui' && !concreteExecutionValue(method.uiSpec.entry)) issues.push('功能 UI 用例缺少明确 UI 入口')
    else if (method.method === 'api' && (!concreteExecutionValue(method.apiSpec.method) || !concreteExecutionValue(method.apiSpec.path))) issues.push('功能 API 用例缺少完整请求方法或路径')
  } else if (spec.kind === 'performance') {
    if (!spec.thresholds.length || spec.thresholds.some(threshold => !concreteExecutionValue(threshold.metric) || !concreteExecutionValue(threshold.target) || !concreteExecutionValue(threshold.sourceRef))) issues.push('性能用例缺少有效阈值或阈值来源')
  } else if (spec.kind === 'stability') {
    if (!concreteExecutionValue(spec.duration)) issues.push('稳定性用例缺少运行时长')
  } else if (![...spec.browserMatrix, ...spec.operatingSystemMatrix, ...spec.viewportMatrix, ...spec.versionMatrix].some(concreteExecutionValue)) issues.push('兼容性用例缺少环境矩阵')
  const status = spec.executionReadiness === 'blocked' ? 'blocked' : issues.length || spec.executionReadiness === 'needs_confirmation' ? 'needs_confirmation' : 'ready'
  return { status, issues }
}
function freezeLibraryVersionMember(aggregate: TestDesignState, projectId: string, member: { caseId: string; revision: number; ordinal: number; contentSha256: string }) {
  const testCase = required(aggregate.libraryCases.find(item => item.id === member.caseId && item.projectId === projectId), 'LIBRARY_TEST_CASE_NOT_FOUND', '正式用例库成员不存在')
  const revision = required(testCase.revisions.find(item => item.revision === member.revision), 'LIBRARY_TEST_CASE_REVISION_NOT_FOUND', '正式用例库成员 Revision 不存在')
  if (revision.contentSha256 !== member.contentSha256 || canonicalSha256(revision.content) !== member.contentSha256) throw new TestDesignError('TEST_CASE_LIBRARY_MEMBER_HASH_MISMATCH', '用例库成员冻结内容 Hash 与成员记录不一致', 409, { caseId: member.caseId, revision: member.revision, expectedSha256: member.contentSha256, actualSha256: revision.contentSha256 })
  if (revision.traceability) assertTraceabilityMatchesContent(revision.content, revision.traceability)
  return { ...member, frozenContent: structuredClone(revision.content), ...(revision.traceability ? { traceability: structuredClone(revision.traceability) } : {}), executionReadiness: executionConfiguration(revision.content).status }
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
function traceabilityRelevantContentChanged(before: TestCaseContent, after: TestCaseContent) { return canonicalSha256({ testPointIds: before.testPointIds, dataRequirementIds: before.dataRequirementIds, dimension: before.dimension, objective: before.objective }) !== canonicalSha256({ testPointIds: after.testPointIds, dataRequirementIds: after.dataRequirementIds, dimension: after.dimension, objective: after.objective }) }
function dynamicTraceabilityReference(value: string) { return /^(?:latest|active|current)(?:$|[:/@_-])/iu.test(value) }
function assertTraceabilityMatchesContent(content: TestCaseContent, traceability: TestCaseTraceability) {
  const pointIds = traceability.testPointRefs.map(item => item.testPointId)
  if (new Set(pointIds).size !== pointIds.length || canonicalSha256([...new Set(pointIds)].sort()) !== canonicalSha256([...new Set(content.testPointIds)].sort())) throw new TestDesignError('LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH', 'traceability.testPointRefs 必须与用例 testPointIds 完全一致且不得重复', 422, { testPointIds: content.testPointIds, traceabilityTestPointIds: pointIds })
  if (!traceability.sourceRequirementReleaseId || dynamicTraceabilityReference(traceability.sourceRequirementReleaseId) || !traceability.requirementRefs.length || traceability.requirementRefs.some(item => item.requirementReleaseId !== traceability.sourceRequirementReleaseId || dynamicTraceabilityReference(item.requirementReleaseId))) throw new TestDesignError('LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH', 'requirementRefs 必须引用同一个固定 Requirement Release ID，禁止 latest、active、current 等动态引用', 422)
  if (traceability.testPointRefs.some(item => dynamicTraceabilityReference(item.testPointTreeVersionId))) throw new TestDesignError('LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH', 'TestPointTreeVersion 必须是固定版本 ID', 422)
}
function validateLibraryTraceability(state: DatabaseState, projectId: string, content: TestCaseContent, value: unknown): TestCaseTraceability {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TestDesignError('LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH', 'traceability 必须是对象', 422)
  const input = value as Record<string, unknown>
  const sourceRequirementReleaseId = cleanRequired(input.sourceRequirementReleaseId, 'traceability.sourceRequirementReleaseId', 500)
  const requirementRefs = Array.isArray(input.requirementRefs) ? input.requirementRefs.map((candidate, index) => { if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new TestDesignError('LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH', `traceability.requirementRefs[${index}] 无效`, 422); const item = candidate as Record<string, unknown>; return { requirementReleaseId: cleanRequired(item.requirementReleaseId, `traceability.requirementRefs[${index}].requirementReleaseId`, 500), requirementId: cleanRequired(item.requirementId, `traceability.requirementRefs[${index}].requirementId`, 500) } }) : []
  const testPointRefs = Array.isArray(input.testPointRefs) ? input.testPointRefs.map((candidate, index) => { if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new TestDesignError('LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH', `traceability.testPointRefs[${index}] 无效`, 422); const item = candidate as Record<string, unknown>; return { testPointTreeVersionId: cleanRequired(item.testPointTreeVersionId, `traceability.testPointRefs[${index}].testPointTreeVersionId`, 500), testPointId: cleanRequired(item.testPointId, `traceability.testPointRefs[${index}].testPointId`, 500) } }) : []
  const traceability = { sourceRequirementReleaseId, requirementRefs, testPointRefs }
  const duplicateRequirementRefs = new Set(requirementRefs.map(item => `${item.requirementReleaseId}\u0000${item.requirementId}`)).size !== requirementRefs.length
  if (duplicateRequirementRefs) throw new TestDesignError('LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH', '同一 Requirement 引用不得重复', 422)
  const fixedReleaseExists = state.reviewRuns.some(run => run.workflow?.release?.id === sourceRequirementReleaseId && run.workflow.release.status === 'published' && state.projectVersions.some(version => version.id === run.projectVersionId && version.projectId === projectId))
  if (!fixedReleaseExists) throw new TestDesignError('LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH', 'Requirement Release ID 不属于当前项目的已发布固定版本', 422, { sourceRequirementReleaseId })
  assertTraceabilityMatchesContent(content, traceability)
  return traceability
}
function caseChangeProposalSha256(proposals: CaseChangeProposal[]) { return canonicalSha256(proposals.map(item => ({ id: item.id, operation: item.operation, ...(item.sourceCaseId ? { sourceCaseId: item.sourceCaseId } : {}), ...(item.sourceRevision !== undefined ? { sourceRevision: item.sourceRevision } : {}), ...(item.candidateCaseId ? { candidateCaseId: item.candidateCaseId } : {}), ...(item.candidateContent ? { candidateContentSha256: canonicalSha256(item.candidateContent) } : {}), decision: item.decision, decisionVersion: item.decisions.length })).sort((left, right) => left.id.localeCompare(right.id))) }
function proposalSourceContent(run: TestDesignWorkflowRun, proposal: CaseChangeProposal) { if (!proposal.sourceCaseId || proposal.sourceRevision === undefined) return undefined; return run.historicalSnapshot.items.find(item => { const locator = item.locator as { caseId?: unknown; revision?: unknown } | undefined; return locator?.caseId === proposal.sourceCaseId && locator?.revision === proposal.sourceRevision })?.content }
function validateProposalDecision(proposal: CaseChangeProposal, decision: Exclude<CaseChangeDecision, 'pending'>) { const allowed: Record<CaseChangeProposal['operation'], Array<Exclude<CaseChangeDecision, 'pending'>>> = { reuse: ['accepted', 'accepted_edited', 'rejected', 'keep_original', 'reference'], update: ['accepted', 'accepted_edited', 'rejected', 'keep_original', 'reference'], create: ['accepted', 'accepted_edited', 'rejected', 'reference'], deprecate: ['deprecated', 'rejected', 'keep_original', 'reference'], reference: ['reference', 'rejected'] }; if (!allowed[proposal.operation].includes(decision)) throw new TestDesignError('CASE_CHANGE_PROPOSAL_DECISION_INVALID', `${proposal.operation} 不允许决策 ${decision}`, 422) }
function traceabilityForProposal(run: TestDesignWorkflowRun, proposal: CaseChangeProposal, content: TestCaseContent): TestCaseTraceability {
  const releaseId = run.basisSnapshot.requirementReleaseId
  const referencedBasis = new Set([...proposal.requirementRefs, ...requirementRefsForCase(run, content)])
  const requirementRefs = run.basisSnapshot.items.flatMap(item => {
    const locator = item.locator as { requirementReleaseId?: unknown; requirementPointId?: unknown } | undefined
    if (item.kind !== 'requirement_release' || (!referencedBasis.has(item.id) && !referencedBasis.has(String(locator?.requirementPointId ?? '')))) return []
    const requirementId = String(locator?.requirementPointId ?? '').trim()
    return requirementId ? [{ requirementReleaseId: releaseId, requirementId }] : []
  })
  const treeVersionId = approvedTreeVersion(run).id
  return {
    sourceRequirementReleaseId: releaseId,
    requirementRefs: [...new Map(requirementRefs.map(item => [`${item.requirementReleaseId}:${item.requirementId}`, item])).values()],
    testPointRefs: [...new Set(content.testPointIds)].map(testPointId => ({ testPointTreeVersionId: treeVersionId, testPointId })),
  }
}
function assertLibraryPublicationGates(aggregate: TestDesignState, projectId: string, run: TestDesignWorkflowRun) {
  approvedTreeVersion(run)
  const unreviewed = run.testCases.filter(item => !item.tombstonedAt && item.reviewState !== 'approved')
  if (unreviewed.length) throw new TestDesignError('TEST_CASE_REVIEW_REQUIRED', '所有候选用例必须完成人工审核', 409, { caseIds: unreviewed.map(item => item.id) })
  const pendingProposals = run.caseChangeProposals.filter(item => item.decision === 'pending')
  if (pendingProposals.length) throw new TestDesignError('CASE_CHANGE_PROPOSAL_DECISION_REQUIRED', '所有 Proposal 必须先完成人工处置', 409, { proposalIds: pendingProposals.map(item => item.id) })
  const blockingFindings = run.findings.filter(item => item.severity === 'blocker' && item.state !== 'resolved' && item.state !== 'rejected')
  if (blockingFindings.length) throw new TestDesignError('TEST_CASE_LIBRARY_PUBLICATION_BLOCKED', '阻断级 Finding 尚未处理', 409, { findingIds: blockingFindings.map(item => item.id) })
  const blockingConfirmations = run.confirmationItems.filter(item => item.blocker && item.state !== 'resolved' && item.state !== 'rejected')
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
function assertLibraryBaselineUnchanged(aggregate: TestDesignState, projectId: string, run: TestDesignWorkflowRun) {
  const latest = aggregate.libraryVersions.filter(item => item.projectId === projectId).sort((left, right) => right.version - left.version)[0]
  const unchanged = run.baseTestCaseLibraryVersionId
    ? latest?.id === run.baseTestCaseLibraryVersionId && latest.contentSha256 === run.baseTestCaseLibraryVersionSha256
    : !latest
  if (!unchanged) throw new TestDesignError('TEST_CASE_LIBRARY_BASE_CHANGED', '正式用例库在本任务运行期间已经变化，请重新分析或基于最新版本重新创建任务。', 409, { expectedVersionId: run.baseTestCaseLibraryVersionId, expectedSha256: run.baseTestCaseLibraryVersionSha256, currentVersionId: latest?.id, currentSha256: latest?.contentSha256 })
}
function assertProposalSourcesCurrent(aggregate: TestDesignState, projectId: string, run: TestDesignWorkflowRun, baseline?: TestCaseLibraryVersion) {
  const baselineMembers = new Map((baseline?.members ?? []).map(item => [item.caseId, item]))
  for (const proposal of run.caseChangeProposals) {
    if (!proposal.sourceCaseId || proposal.sourceRevision === undefined || proposal.decision === 'rejected' || proposal.decision === 'reference') continue
    const baselineMember = baselineMembers.get(proposal.sourceCaseId)
    if (!baselineMember || baselineMember.revision !== proposal.sourceRevision) throw new TestDesignError('CASE_CHANGE_PROPOSAL_SOURCE_STALE', 'Proposal 来源不再是运行冻结基线中的 Revision', 409, { proposalId: proposal.id, sourceCaseId: proposal.sourceCaseId, sourceRevision: proposal.sourceRevision })
    const source = aggregate.libraryCases.find(item => item.id === proposal.sourceCaseId && item.projectId === projectId)
    if (!source || source.status !== 'active') throw new TestDesignError('CASE_CHANGE_PROPOSAL_SOURCE_STALE', 'Proposal 来源用例已被其他任务废弃或移除', 409, { proposalId: proposal.id, sourceCaseId: proposal.sourceCaseId })
    if (source.currentRevision !== proposal.sourceRevision) throw new TestDesignError('LIBRARY_TEST_CASE_REVISION_CONFLICT', 'Proposal 来源正式用例 Revision 已变化，禁止旧 Proposal 覆盖较新 Revision', 409, { proposalId: proposal.id, sourceCaseId: source.id, expectedRevision: proposal.sourceRevision, currentRevision: source.currentRevision })
  }
}
function assertLibraryBaselineMembersCurrent(aggregate: TestDesignState, projectId: string, run: TestDesignWorkflowRun, baseline?: TestCaseLibraryVersion) {
  for (const member of baseline?.members ?? []) {
    const correspondingProposal = run.caseChangeProposals.find(proposal => proposal.sourceCaseId === member.caseId && proposal.sourceRevision === member.revision && !['pending', 'rejected', 'reference'].includes(proposal.decision))
    if (correspondingProposal) continue
    const testCase = aggregate.libraryCases.find(item => item.id === member.caseId && item.projectId === projectId)
    if (!testCase) throw new TestDesignError('TEST_CASE_LIBRARY_BASE_MEMBER_CHANGED', '基线成员在任务运行期间被移除', 409, { caseId: member.caseId, revision: member.revision })
    if (testCase.status === 'deprecated') throw new TestDesignError('TEST_CASE_LIBRARY_BASE_MEMBER_DEPRECATED', '基线成员在任务运行期间被并发废弃，禁止静默从新版本删除', 409, { caseId: member.caseId, revision: member.revision })
    const revision = testCase.revisions.find(item => item.revision === member.revision)
    if (!revision || revision.contentSha256 !== member.contentSha256 || canonicalSha256(revision.content) !== member.contentSha256 || testCase.currentRevision !== member.revision) throw new TestDesignError('TEST_CASE_LIBRARY_BASE_MEMBER_CHANGED', '基线成员的当前 Revision 或内容 Hash 在任务运行期间发生变化', 409, { caseId: member.caseId, expectedRevision: member.revision, currentRevision: testCase.currentRevision, expectedSha256: member.contentSha256, actualSha256: revision?.contentSha256 })
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
    testPointIds: Array.isArray(input.testPointIds) && input.testPointIds.length ? input.testPointIds : ['legacy-untraced'],
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
  if (proposal.decision === 'reference' || proposal.decision === 'rejected') return
  if (proposal.decision === 'keep_original') { if (source && sourceRevision) members.set(source.id, { caseId: source.id, revision: sourceRevision.revision, ordinal: 0, contentSha256: sourceRevision.contentSha256 }); return }
  if (proposal.operation === 'reuse') { const testCase = required(source, 'LIBRARY_TEST_CASE_NOT_FOUND', '复用来源用例不存在'); const revision = required(sourceRevision, 'LIBRARY_TEST_CASE_REVISION_NOT_FOUND', '复用来源 Revision 不存在'); if (testCase.status !== 'active') throw new TestDesignError('LIBRARY_TEST_CASE_DEPRECATED', '废弃用例不能直接复用', 409); members.set(testCase.id, { caseId: testCase.id, revision: revision.revision, ordinal: 0, contentSha256: revision.contentSha256 }); proposal.appliedCaseId = testCase.id; proposal.appliedRevision = revision.revision; return }
  if (proposal.operation === 'update') { const testCase = required(source, 'LIBRARY_TEST_CASE_NOT_FOUND', '修改来源用例不存在'); const content = required(candidateRevision?.content, 'CASE_CHANGE_PROPOSAL_CANDIDATE_INVALID', '修改 Proposal 缺少候选内容'); const revision = createLibraryRevision(testCase.currentRevision + 1, content, actorId, proposal.reason, run.id, proposal.id, traceabilityForProposal(run, proposal, content)); testCase.revisions.push(revision); testCase.currentRevision = revision.revision; testCase.status = 'active'; testCase.updatedAt = revision.createdAt; members.set(testCase.id, { caseId: testCase.id, revision: revision.revision, ordinal: 0, contentSha256: revision.contentSha256 }); proposal.appliedCaseId = testCase.id; proposal.appliedRevision = revision.revision; return }
  if (proposal.operation === 'create') { const content = required(candidateRevision?.content, 'CASE_CHANGE_PROPOSAL_CANDIDATE_INVALID', '新增 Proposal 缺少候选内容'); const createdAt = now(); const revision = createLibraryRevision(1, content, actorId, proposal.reason, run.id, proposal.id, traceabilityForProposal(run, proposal, content)); const testCase: LibraryTestCase = { id: `library_test_case_${randomUUID()}`, projectId, currentRevision: 1, status: 'active', createdAt, updatedAt: createdAt, revisions: [revision] }; aggregate.libraryCases.push(testCase); members.set(testCase.id, { caseId: testCase.id, revision: 1, ordinal: 0, contentSha256: revision.contentSha256 }); proposal.appliedCaseId = testCase.id; proposal.appliedRevision = 1; return }
  if (proposal.operation === 'deprecate' && proposal.decision === 'deprecated') { const testCase = required(source, 'LIBRARY_TEST_CASE_NOT_FOUND', '废弃来源用例不存在'); testCase.status = 'deprecated'; testCase.updatedAt = now(); members.delete(testCase.id); proposal.appliedCaseId = testCase.id; proposal.appliedRevision = testCase.currentRevision }
}

function suiteDraftInput(raw: unknown): { suiteKey: string; suiteType: 'smoke' | 'regression' | 'custom'; name: string; testCaseLibraryVersionId: string; confirmLibraryVersionChange: boolean; members: Array<{ testCaseLibraryVersionId?: string; caseId: string; executionMethod: TestExecutionMethod; reason: string }> } {
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
      const executionMethod = String(item.executionMethod) as TestExecutionMethod
      if (!['ui', 'api', 'performance_tool', 'long_running', 'environment_matrix'].includes(executionMethod)) throw new TestDesignError('TEST_SUITE_EXECUTION_METHOD_INVALID', `members[${index}].executionMethod 无效`, 422)
      return { ...(typeof item.testCaseLibraryVersionId === 'string' && item.testCaseLibraryVersionId.trim() ? { testCaseLibraryVersionId: item.testCaseLibraryVersionId.trim() } : {}), caseId: cleanRequired(item.caseId, 'caseId', 500), executionMethod, reason: cleanRequired(item.reason, '选择原因', 2_000) }
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
    if (executionMethodForContent(frozenContent) !== value.executionMethod) throw new TestDesignError('TEST_SUITE_EXECUTION_METHOD_INVALID', '套件执行方式与冻结 Revision 的 executionSpec 不一致', 422)
    return { testCaseLibraryVersionId: version.id, caseId: member.caseId, revision: member.revision, executionMethods: value.executionMethod === 'ui' || value.executionMethod === 'api' ? [value.executionMethod] : [], executionMethod: value.executionMethod, ordinal, reason: cleanRequired(value.reason, '套件成员原因', 2_000) }
  })
}
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
  const markdown = [`# ${version.name}`, '', `- Library Version: ${version.version}`, `- Version ID: ${version.id}`, `- SHA-256: ${version.contentSha256}`, '', ...entries.flatMap(item => {
    const trace = item.traceability
    const requirementIds = trace?.requirementRefs.map(reference => reference.requirementId) ?? []
    const treeVersions = trace ? [...new Set(trace.testPointRefs.map(reference => reference.testPointTreeVersionId))] : []
    const pointIds = trace?.testPointRefs.map(reference => reference.testPointId) ?? []
    return [`## ${item.caseId} r${item.revision} · ${item.content.title}`, '', item.content.objective, '', `- Case ID: ${item.caseId}`, `- Revision: r${item.revision}`, `- Content SHA-256: ${item.contentSha256}`, `- Dimension: ${item.content.dimension}`, `- Priority: ${item.content.priority}`, `- Execution Method: ${executionMethodForContent(item.content)}`, `- Execution Readiness: ${item.executionReadiness}`, `- Execution Spec: ${item.content.executionSpec ? canonicalJson(item.content.executionSpec) : '未配置'}`, `- Requirement Release: ${trace?.sourceRequirementReleaseId ?? '历史数据未建立正式追溯'}`, `- Requirement ID: ${requirementIds.length ? requirementIds.join(', ') : '历史数据未建立正式追溯'}`, `- TestPointTreeVersion: ${treeVersions.length ? treeVersions.join(', ') : '历史数据未建立正式追溯'}`, `- TestPoint ID: ${pointIds.length ? pointIds.join(', ') : '历史数据未建立正式追溯'}`, '']
  })].join('\n')
  const manifestBody = { schemaVersion: 'test-case-library-manifest/v2', versionId: version.id, contentSha256: version.contentSha256, members: entries.map(item => ({ caseId: item.caseId, revision: item.revision, contentSha256: item.contentSha256, ...(item.content.executionSpec ? { executionSpec: item.content.executionSpec } : {}), executionReadiness: item.executionReadiness, ...(item.traceability ? { traceability: item.traceability } : { traceabilityStatus: '历史数据未建立正式追溯' }) })), files: [{ name: 'test-cases.json', sha256: canonicalSha256Text(json) }, { name: 'test-cases.md', sha256: canonicalSha256Text(markdown) }] }
  const manifest = `${canonicalJson(manifestBody)}\n`
  return [{ logicalPath: `${directory}/test-cases.json`, sourceType: 'test_case_library_version', sourceId: version.id, contentSha256: canonicalSha256Text(json), content: json, displayName: `用例库 V${version.version} JSON`, sourceScope: 'formal_output' }, { logicalPath: `${directory}/test-cases.md`, sourceType: 'test_case_library_version', sourceId: version.id, contentSha256: canonicalSha256Text(markdown), content: markdown, displayName: `用例库 V${version.version} 文档`, sourceScope: 'formal_output' }, { logicalPath: `${directory}/manifest.json`, sourceType: 'test_case_library_version', sourceId: version.id, contentSha256: canonicalSha256Text(manifest), content: manifest, displayName: `用例库 V${version.version} Manifest`, sourceScope: 'formal_output' }]
}
function structuralDiff(before: unknown, after: unknown, path = ''): Array<{ path: string; before?: unknown; after?: unknown }> {
  if (before === undefined || after === undefined) return before === after ? [] : [{ path: path || '/', ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) }]
  if (canonicalSha256(before) === canonicalSha256(after)) return []
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) || Array.isArray(after)) return [{ path: path || '/', before, after }]
  const left = before as Record<string, unknown>
  const right = after as Record<string, unknown>
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().flatMap(key => structuralDiff(left[key], right[key], `${path}/${key}`))
}
function applyTreeOperations(current: TestPointNodeRevision[], operations: TestPointTreeOperation[]) { const nodes = structuredClone(current); const active = (id: string) => required(nodes.find(item => item.nodeId === id && !item.deleted), 'TEST_POINT_NOT_FOUND', `测试点 ${id} 不存在`); for (const operation of operations) { if (operation.op === 'add') { if (operation.parentId) active(operation.parentId); nodes.push({ nodeId: `test_point_${randomUUID()}`, parentId: operation.parentId, sortKey: cleanRequired(operation.sortKey, 'sortKey', 200), ...structuredClone(operation.value) }) } else if (operation.op === 'rename') active(operation.nodeId).title = cleanRequired(operation.title, 'title', 500); else if (operation.op === 'update') Object.assign(active(operation.nodeId), structuredClone(operation.patch), { nodeId: operation.nodeId }); else if (operation.op === 'move') { const node = active(operation.nodeId); if (operation.parentId) active(operation.parentId); node.parentId = operation.parentId; node.sortKey = cleanRequired(operation.sortKey, 'sortKey', 200) } else if (operation.op === 'delete') { const target = active(operation.nodeId); target.deleted = true; nodes.filter(item => item.parentId === target.nodeId && !item.deleted).forEach(item => { item.parentId = target.parentId }) } else if (operation.op === 'mark_not_applicable') { const target = active(operation.nodeId); target.applicability = 'not_applicable'; target.assumptions = [...target.assumptions, cleanRequired(operation.reason, 'reason', 2_000)] } else if (operation.op === 'reorder') active(operation.nodeId).sortKey = cleanRequired(operation.sortKey, 'sortKey', 200); else if (operation.op === 'split') { const target = active(operation.nodeId); operation.children.forEach(child => nodes.push({ nodeId: `test_point_${randomUUID()}`, parentId: target.parentId, sortKey: child.sortKey, ...structuredClone(child.value) })); target.deleted = true } else if (operation.op === 'merge') { const target = active(operation.targetNodeId); operation.sourceNodeIds.filter(id => id !== target.nodeId).forEach(id => { active(id).deleted = true }); Object.assign(target, structuredClone(operation.value), { nodeId: target.nodeId }) } } validateTreeNodes(nodes); return nodes }
function approveCurrentTree(run: TestDesignWorkflowRun, actorId: string) { const tree = required(run.testPointTree, 'TEST_POINT_TREE_APPROVAL_REQUIRED', '测试点树不存在'); const revision = tree.revisions.find(item => item.revision === tree.currentRevision)!; const existing = tree.versions.find(item => item.revision === revision.revision && item.treeSha256 === revision.treeSha256); if (existing) { tree.currentApprovedVersionId = existing.id; return existing } const version = { id: `test_point_tree_version_${randomUUID()}`, version: Math.max(0, ...tree.versions.map(item => item.version)) + 1, revision: revision.revision, treeSha256: revision.treeSha256, approvedBy: actorId, approvedAt: now(), projection: { status: 'pending' as const, files: [] } }; tree.versions.push(version); tree.currentApprovedVersionId = version.id; return version }
function startAutomaticTestPointReview(run: TestDesignWorkflowRun) {
  const tree = required(run.testPointTree, 'TEST_POINT_TREE_NOT_FOUND', '测试点树尚未生成')
  const revision = required(tree.revisions.find(item => item.revision === tree.currentRevision), 'TEST_POINT_TREE_REVISION_NOT_FOUND', '测试点树当前 Revision 不存在')
  validateTreeReferences(run, revision.nodes)
  const validatedSha256 = validateTreeNodes(revision.nodes)
  if (validatedSha256 !== revision.treeSha256) throw new TestDesignError('TEST_POINT_TREE_VALIDATION_FAILED', '测试点树内容 Hash 与当前 Revision 不一致', 409)
  const review = node(run, 'test_point_review')
  if (review.status !== 'pending') advanceNodeGeneration(run, review, 'pending')
  Object.assign(review, { status: 'running', attempt: review.attempt + 1, startedAt: now(), finishedAt: undefined, error: undefined, errorCode: undefined, inputSha256: validatedSha256 })
  const version = approveCurrentTree(run, AUTOMATIC_TEST_POINT_REVIEW_ACTOR)
  Object.assign(run, { status: 'running', stage: 'test_point_review', progress: 40, finishedAt: undefined, error: undefined, errorCode: undefined })
  return version
}
function completeAutomaticTestPointReview(run: TestDesignWorkflowRun) {
  const review = node(run, 'test_point_review')
  if (review.status !== 'running') throw new TestDesignError('TEST_POINT_TREE_VALIDATION_FAILED', '测试点自动校验节点不在运行状态', 409)
  finishNode(run, 'test_point_review')
  const caseDesign = node(run, 'test_case_design')
  if (caseDesign.status === 'pending') queueNode(run, 'test_case_design')
  else if (caseDesign.status !== 'queued') advanceNodeGeneration(run, caseDesign, 'queued')
  for (const key of ['coverage_audit', 'test_design_repair'] as const) {
    const downstream = node(run, key)
    if (downstream.status !== 'pending') advanceNodeGeneration(run, downstream, 'pending')
  }
  run.automaticRepair = initialAutomaticRepairState()
  Object.assign(run, { status: 'queued', stage: 'test_case_design', progress: 50, finishedAt: undefined, error: undefined, errorCode: undefined })
}
function approvedTreeVersion(run: TestDesignWorkflowRun) { const tree = required(run.testPointTree, 'TEST_POINT_TREE_APPROVAL_REQUIRED', '测试点树不存在'); return required(tree.versions.find(item => item.id === tree.currentApprovedVersionId), 'TEST_POINT_TREE_APPROVAL_REQUIRED', '测试点树尚未通过自动校验并固化') }
function approvedPointIds(run: TestDesignWorkflowRun, treeVersionId: string) { const tree = required(run.testPointTree, 'TEST_POINT_TREE_APPROVAL_REQUIRED', '测试点树不存在'); const version = required(tree.versions.find(item => item.id === treeVersionId), 'TEST_POINT_TREE_APPROVAL_REQUIRED', '测试点树版本不存在'); const revision = tree.revisions.find(item => item.revision === version.revision)!; return executableTestPointIds(revision.nodes) }
function applyReviewAction(testCase: TestCase, input: { decision: 'submit' | 'approve' | 'reject' | 'request_revision' | 'withdraw'; targetRevision: number; comment?: string }, actorId: string) { if (testCase.currentRevision !== input.targetRevision) throw new TestDesignError('TEST_CASE_REVISION_CONFLICT', '审核目标 revision 已变化', 412); const transitions = { draft: { submit: 'in_review' }, in_review: { approve: 'approved', reject: 'rejected', request_revision: 'needs_revision', withdraw: 'draft' }, approved: { request_revision: 'needs_revision' }, rejected: { submit: 'in_review' }, needs_revision: { submit: 'in_review' } } as const; const toState = (transitions[testCase.reviewState] as Record<string, TestCase['reviewState'] | undefined>)[input.decision]; if (!toState) throw new TestDesignError('TEST_CASE_REVIEW_TRANSITION_INVALID', `不能从 ${testCase.reviewState} 执行 ${input.decision}`, 409); testCase.reviewActions.push({ id: `test_case_review_${randomUUID()}`, targetRevision: input.targetRevision, fromState: testCase.reviewState, toState, decision: input.decision, ...(input.comment?.trim() ? { comment: input.comment.trim().slice(0, 4_000) } : {}), actorId, createdAt: now() }); testCase.reviewState = toState }
function applyDisposition(target: { state: 'open' | 'confirmed' | 'resolved' | 'deferred' | 'rejected'; actions: Array<{ id: string; expectedVersion: number; fromState: string; toState: string; decision: string; comment?: string; structuredDecision?: unknown; actorId: string; createdAt: string }> }, input: { expectedVersion: number; decision: 'confirm' | 'resolve' | 'defer' | 'reject' | 'reopen'; comment?: string; structuredDecision?: unknown }, actorId: string) { if (target.actions.length !== input.expectedVersion) throw new TestDesignError('TEST_DESIGN_DISPOSITION_VERSION_CONFLICT', '处置版本已变化', 409); const toState = input.decision === 'confirm' ? 'confirmed' : input.decision === 'resolve' ? 'resolved' : input.decision === 'defer' ? 'deferred' : input.decision === 'reject' ? 'rejected' : 'open'; target.actions.push({ id: `test_design_action_${randomUUID()}`, expectedVersion: input.expectedVersion, fromState: target.state, toState, decision: input.decision, ...(input.comment?.trim() ? { comment: input.comment.trim().slice(0, 4_000) } : {}), ...(input.structuredDecision === undefined ? {} : { structuredDecision: structuredClone(input.structuredDecision) }), actorId, createdAt: now() }); target.state = toState }
function validateCurrentDependencyGraph(run: TestDesignWorkflowRun) { validateCaseDependencyGraph(run.testCases.filter(item => !item.tombstonedAt).map(item => ({ id: item.id, content: currentCaseRevision(item).content }))) }
function invalidateAudit(run: TestDesignWorkflowRun) { run.coverageAudits.forEach(item => { item.status = 'stale' }) }
function assertMethodSubset(run: TestDesignWorkflowRun, caseId: string, methods: Array<'ui' | 'api'>) { if (!methods.length) throw new TestDesignError('TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', '执行方式子集不能为空', 422); const content = currentCaseRevision(findCase(run, caseId)).content; const available = new Set(content.executionMethods.filter(method => method.executionReadiness === 'ready').map(method => method.method)); if (methods.some(method => !available.has(method))) throw new TestDesignError('TEST_CASE_EXECUTION_METHODS_SCHEMA_INVALID', '执行方式不是来源用例 ready 方式的子集', 422) }
function publishArtifact(run: TestDesignWorkflowRun, key: TestDesignNodeKey, output: { schemaVersion: string; content: unknown }) { const target = node(run, key); const artifactValue: WorkflowArtifact = { id: `workflow_artifact_${randomUUID()}`, nodeKey: key, schemaVersion: output.schemaVersion, generation: target.generation, content: structuredClone(output.content), contentSha256: canonicalSha256(output.content), createdAt: now() }; run.artifacts.push(artifactValue); target.outputArtifactId = artifactValue.id }
function finishNode(run: TestDesignWorkflowRun, key: TestDesignNodeKey, execution?: WorkflowNodeRun['execution']) { const target = node(run, key); Object.assign(target, { status: 'succeeded', finishedAt: now(), ...(execution ? { execution } : {}) }) }
function failNode(run: TestDesignWorkflowRun, key: TestDesignNodeKey, error: unknown) { const target = node(run, key); const message = error instanceof Error ? error.message : String(error); const execution = error && typeof error === 'object' && 'execution' in error ? (error as { execution?: WorkflowNodeRun['execution'] }).execution : undefined; Object.assign(target, { status: 'failed', finishedAt: now(), error: message, errorCode: errorCode(message), ...(execution ? { execution } : {}) }) }
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
function presentCase(testCase: TestCase, detail = false) { const revision = currentCaseRevision(testCase); const value = { id: testCase.id, runId: testCase.runId, treeVersionId: testCase.treeVersionId, origin: testCase.origin, currentRevision: testCase.currentRevision, reviewState: testCase.reviewState, content: structuredClone(revision.content), contentSha256: revision.contentSha256, etag: etag('case', testCase.id, revision.revision, revision.contentSha256), ...(detail ? { revisions: structuredClone(testCase.revisions), reviewActions: structuredClone(testCase.reviewActions), tombstonedAt: testCase.tombstonedAt } : {}) }; return value }
function markdownCaseSet(version: TestCaseSetVersion) { const content = version.canonicalContent as { cases: Array<{ caseId: string; revision: number; content: TestCaseContent }> }; return [`# ${version.name}`, '', `- Version: ${version.version}`, `- Schema: ${version.schemaVersion}`, `- Content SHA-256: ${version.contentSha256}`, '', ...content.cases.flatMap(item => [`## ${item.caseId} r${item.revision}: ${item.content.title}`, '', item.content.objective, '', `- Dimension: ${item.content.dimension}`, `- Priority: ${item.content.priority}`, `- Methods: ${item.content.executionMethods.map(method => method.method).join(', ')}`, ''])].join('\n') }
async function xlsxCaseSet(version: TestCaseSetVersion) { const value = version.canonicalContent as { cases: Array<{ caseId: string; revision: number; content: TestCaseContent }> }; const rows = [['Case ID', 'Revision', 'Title', 'Objective', 'Dimension', 'Priority', 'Methods', 'Domain', 'Preconditions', 'Steps', 'Checks'], ...value.cases.map(item => [item.caseId, String(item.revision), item.content.title, item.content.objective, item.content.dimension, item.content.priority, item.content.executionMethods.map(method => method.method).join(', '), item.content.domain, item.content.preconditions.join('\n'), item.content.executionMethods.flatMap(method => method.steps.map(step => `[${method.method}] ${step.key}: ${step.action} => ${step.expected}`)).join('\n'), item.content.executionMethods.flatMap(method => method.verificationChecks.map(check => `[${method.method}] ${check.description}`)).concat(item.content.sharedVerificationChecks.map(check => `[shared] ${check.description}`)).join('\n')])]; const sheetRows = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((cell, columnIndex) => `<c r="${columnName(columnIndex + 1)}${rowIndex + 1}" t="inlineStr"${rowIndex === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xml(safeSpreadsheetText(cell))}</t></is></c>`).join('')}</row>`).join(''); const zip = new JSZip(); zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'); zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'); zip.file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Test Cases" sheetId="1" r:id="rId1"/></sheets></workbook>'); zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'); zip.file('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font/><font><b/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf xfId="0"/><xf xfId="0" fontId="1" applyFont="1"/></cellXfs></styleSheet>'); zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`); return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) }
function columnName(index: number) { let name = ''; for (let value = index; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + ((value - 1) % 26)) + name; return name }
function safeSpreadsheetText(value: string) { return /^[=+\-@]/u.test(value) ? `'${value}` : value }
function xml(value: string) { return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;') }
function required<T>(value: T | null | undefined, code: string, message: string): T { if (value == null) throw new TestDesignError(code, message, code.endsWith('_NOT_FOUND') ? 404 : 409); return value }
function cleanRequired(value: unknown, label: string, max: number) { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TestDesignError('TEST_DESIGN_INPUT_INVALID', `${label} 不能为空且不能超过 ${max} 个字符`, 422); return value.trim() }
function positive(value: unknown, label: string) { const number = Number(value); if (!Number.isFinite(number) || number <= 0) throw new TestDesignError('TEST_DESIGN_INPUT_INVALID', `${label} 必须是正数`, 422); return number }
function newest(left: { createdAt?: string; publishedAt?: string }, right: { createdAt?: string; publishedAt?: string }) { return String(right.createdAt ?? right.publishedAt).localeCompare(String(left.createdAt ?? left.publishedAt)) }
function now() { return new Date().toISOString() }
function errorCode(message: string) { return /^([A-Z][A-Z0-9_]+):/u.exec(message)?.[1] ?? 'TEST_DESIGN_RUN_FAILED' }
