import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type {
  AgentModelConnection,
  PlanningAgentProfile,
  PlanningReviewerSnapshot,
  PlanningReviewerSourceReference,
  PlanningReviewerType,
  PlanningStageProfile,
  PlanningSubAgentRunRecord,
  ReviewerExecutionOutput,
} from '../domain/agent-types.js'
import type {
  CoverageAudit,
  TestDesignWorkflowRun,
  TestDesignWorkspaceFile,
} from '../domain/test-design-types.js'
import type {
  AgentConfigurationVersion,
  DatabaseState,
  ReviewRun,
} from '../domain/types.js'
import type { StateStore } from '../infrastructure/store.js'
import {
  TEST_DESIGN_STAGE_BINDINGS,
} from '../agent/pi-test-design-runtime.js'
import type { PiAgentRuntimeAdapter } from '../agent/pi-agent-runtime.js'
import type { AgentConfigurationService } from './agent-configuration-service.js'
import { canonicalJson, canonicalSha256 } from './canonical-json.js'
import type { RequirementAnalysisService } from './requirement-analysis-service.js'
import type { TestDesignService } from './test-design-service.js'

export interface TestDesignReviewerSourceSelection {
  testPointTreeRevision: number
  approvedTestPointTreeVersionId?: string
  testCases: Array<{
    caseId: string
    treeVersionId: string
    revision: number
  }>
  dataSetVersionId?: string
  coverageAuditId?: string
}

const REQUIREMENT_WORKSPACE_TOOLS = [
  'workspace.read_file',
  'workspace.grep_files',
  'workspace.find_files',
  'workspace.list_directory',
] as const

const TEST_DESIGN_WORKSPACE_TOOLS = [
  ...REQUIREMENT_WORKSPACE_TOOLS,
  'knowledge.search',
  'knowledge.read_chunk',
  'skill.activate',
] as const

const STAGE_PROFILES: PlanningStageProfile[] = [
  stage(
    'requirement_analysis',
    'requirement-analysis',
    ['requirement.baseline', 'requirement.analysis'],
    [...REQUIREMENT_WORKSPACE_TOOLS, 'requirement-analysis.submit_result'],
    'requirement-analysis.submit_result',
    'requirement-analysis/v1',
    ['requirement'],
  ),
  stage(
    'requirement_repair',
    'requirement-analysis',
    ['requirement.repair'],
    [...REQUIREMENT_WORKSPACE_TOOLS, 'requirement-repair.submit_result'],
    'requirement-repair.submit_result',
    'requirement-repair/v1',
    ['requirement'],
    true,
  ),
  stage(
    'requirement_verification',
    'requirement-analysis',
    [
      'requirement.baseline',
      'requirement.analysis',
      'requirement.verification',
    ],
    [...REQUIREMENT_WORKSPACE_TOOLS, 'requirement-analysis.submit_result'],
    'requirement-analysis.submit_result',
    'requirement-analysis/v1',
    ['requirement'],
  ),
  stage(
    'requirement_release',
    'requirement-analysis',
    ['requirement.release'],
    [...REQUIREMENT_WORKSPACE_TOOLS, 'requirement-release.submit_result'],
    'requirement-release.submit_result',
    'requirement-release-candidate/v1',
    [],
    true,
  ),
  stage(
    'test_point_design',
    'test-design',
    [...TEST_DESIGN_STAGE_BINDINGS.test_point_design.skills],
    [
      ...TEST_DESIGN_WORKSPACE_TOOLS,
      TEST_DESIGN_STAGE_BINDINGS.test_point_design.submitToolId,
    ],
    TEST_DESIGN_STAGE_BINDINGS.test_point_design.submitToolId,
    TEST_DESIGN_STAGE_BINDINGS.test_point_design.schemaVersion,
    ['test_point'],
  ),
  stage(
    'test_point_review',
    'test-design',
    [],
    [],
    undefined,
    undefined,
    ['test_point'],
    true,
  ),
  stage(
    'test_case_design',
    'test-design',
    [...TEST_DESIGN_STAGE_BINDINGS.test_case_design.skills],
    [
      ...TEST_DESIGN_WORKSPACE_TOOLS,
      TEST_DESIGN_STAGE_BINDINGS.test_case_design.submitToolId,
    ],
    TEST_DESIGN_STAGE_BINDINGS.test_case_design.submitToolId,
    TEST_DESIGN_STAGE_BINDINGS.test_case_design.schemaVersion,
    ['test_case'],
  ),
  stage(
    'test_design_repair',
    'test-design',
    [...TEST_DESIGN_STAGE_BINDINGS.test_design_repair.skills],
    [
      ...TEST_DESIGN_WORKSPACE_TOOLS,
      TEST_DESIGN_STAGE_BINDINGS.test_design_repair.submitToolId,
    ],
    TEST_DESIGN_STAGE_BINDINGS.test_design_repair.submitToolId,
    TEST_DESIGN_STAGE_BINDINGS.test_design_repair.schemaVersion,
    ['coverage'],
  ),
  stage(
    'test_design_release',
    'test-design',
    [],
    [],
    undefined,
    undefined,
    ['coverage'],
    true,
  ),
]

export class PlanningWorkflowService {
  constructor(
    private readonly store: StateStore,
    private readonly configurations: AgentConfigurationService,
    private readonly runtime: PiAgentRuntimeAdapter,
    private readonly requirements: RequirementAnalysisService,
    private readonly testDesign: TestDesignService,
  ) {}

  async profile(): Promise<PlanningAgentProfile> {
    const [requirementAnalysis, testDesign] = await Promise.all([
      this.configurations.resolveActive('requirement-analysis'),
      this.configurations.resolveActive('test-design'),
    ])
    const context = this.runtime.contextProfile()
    return {
      agentKey: 'planning',
      label: 'PlanningAgent',
      parentSession: 'project_version',
      subAgents: [
        reviewer('requirement', 'RequirementReviewer'),
        reviewer('test_point', 'TestPointReviewer'),
        reviewer('test_case', 'TestCaseReviewer'),
        reviewer('coverage', 'CoverageReviewer'),
      ],
      context: {
        autoCompaction: true,
        proactiveThresholdPercent:
          context.proactiveThresholdPercent,
        checkpoints: [...context.checkpoints],
        summaryIsFormalBusinessFact: false,
      },
      stageProfiles: structuredClone(STAGE_PROFILES),
      configurations: [
        {
          scene: 'requirement_analysis',
          agentKey: 'requirementAnalysis',
          activeVersion: requirementAnalysis,
        },
        {
          scene: 'test_design',
          agentKey: 'testDesign',
          activeVersion: testDesign,
        },
      ],
    }
  }

  async workflow(projectVersionId: string) {
    const state = await this.store.snapshot()
    const projectVersion = required(
      state.projectVersions.find(item => item.id === projectVersionId),
      'PROJECT_VERSION_NOT_FOUND',
    )
    const requirementRuns = await this.requirements.list(
      projectVersionId,
      { limit: 100 },
    )
    const designs = await this.testDesign.listDesigns(projectVersionId)
    return {
      projectVersion: structuredClone(projectVersion),
      stageProfiles: structuredClone(STAGE_PROFILES),
      requirementRuns,
      testDesigns: designs,
      context: this.runtime.context(
        planningScope(projectVersion.projectId, projectVersion.id),
      ) ?? null,
    }
  }

  async reviewRequirement(
    sourceRunId: string,
    signal = new AbortController().signal,
  ) {
    const state = await this.store.snapshot()
    const source = required(
      state.reviewRuns.find(item => item.id === sourceRunId),
      'REQUIREMENT_RUN_NOT_FOUND',
    )
    if (source.status !== 'succeeded' || !source.result) {
      throw new Error('REQUIREMENT_REVIEW_SOURCE_NOT_READY')
    }
    const model = requirementModel(state, source)
    const requiredReadPaths = requirementReadPaths(source)
    const task = requirementReviewerTask(source)
    const sourceReference: PlanningReviewerSourceReference = {
      kind: 'requirement',
      requirementRunId: source.id,
      assetVersions: source.snapshot.assets.map(item => ({
        assetVersionId: item.assetVersionId,
        contentSha256: item.assetContentHash,
      })),
      resultSha256: canonicalSha256(source.result),
    }
    const sourceSha256 = canonicalSha256(sourceReference)
    return this.executeReviewer({
      sourceKind: 'requirement_run',
      sourceId: source.id,
      sourceSha256,
      sourceReference,
      reviewerType: 'requirement',
      snapshot: source.snapshot,
      model,
      task,
      requiredReadPaths,
    }, signal)
  }

  async reviewTestDesign(
    input: {
      sourceRunId: string
      reviewerType: Exclude<PlanningReviewerType, 'requirement'>
      sourceSelection: TestDesignReviewerSourceSelection
    },
    signal = new AbortController().signal,
  ) {
    const state = await this.store.snapshot()
    const source = required(
      state.testDesignState?.runs.find(
        item => item.id === input.sourceRunId,
      ),
      'TEST_DESIGN_RUN_NOT_FOUND',
    )
    const configuration = fixedTestDesignConfiguration(state, source)
    const model = testDesignModel(state, source, configuration)
    const sourceReference = captureTestDesignReviewerSource(
      source,
      input.reviewerType,
      input.sourceSelection,
    )
    const projection = testDesignReviewerProjection(
      state,
      source,
      input.reviewerType,
      sourceReference,
      configuration,
    )
    return this.executeReviewer({
      sourceKind: 'test_design_run',
      sourceId: source.id,
      sourceSha256: projection.sourceSha256,
      sourceReference,
      reviewerType: input.reviewerType,
      snapshot: projection.snapshot,
      model,
      task: projection.task,
      requiredReadPaths: projection.requiredReadPaths,
    }, signal)
  }

  queueTestPointsConfirmed(
    projectId: string,
    projectVersionId: string,
  ) {
    this.runtime.queueCompactionCheckpoint(
      planningScope(projectId, projectVersionId),
      'test_points_confirmed',
    )
  }

  private async executeReviewer(
    input: {
      sourceKind: PlanningSubAgentRunRecord['sourceKind']
      sourceId: string
      sourceSha256: string
      sourceReference: PlanningReviewerSourceReference
      reviewerType: PlanningReviewerType
      snapshot: Parameters<PiAgentRuntimeAdapter['review']>[0]['snapshot']
      model: AgentModelConnection
      task: string
      requiredReadPaths: string[]
    },
    signal: AbortSignal,
  ) {
    const runId = `planning_reviewer_${randomUUID()}`
    const startedAt = new Date().toISOString()
    const observedEvents: PlanningSubAgentRunRecord['events'] = []
    await this.addReviewerRun({
      runId,
      reviewerType: input.reviewerType,
      status: 'running',
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      sourceSha256: input.sourceSha256,
      sourceReference: structuredClone(input.sourceReference),
      turns: 0,
      toolCalls: 0,
      toolErrors: 0,
      events: [],
      startedAt,
    })
    try {
      const output = await this.runtime.review({
        runId,
        reviewerType: input.reviewerType,
        snapshot: input.snapshot,
        model: input.model,
        task: input.task,
        requiredReadPaths: input.requiredReadPaths,
        onEvent: event => { observedEvents.push(event) },
      }, signal)
      const injected = await this.runtime.injectReviewCandidate(
        input.snapshot,
        output,
      )
      const completed: ReviewerExecutionOutput = {
        ...output,
        parentSessionId: injected.parentSessionId,
      }
      await this.finishReviewerRun(input.sourceKind, input.sourceId, runId, {
        status: 'succeeded',
        parentSessionId: injected.parentSessionId,
        reviewerSessionId: output.context.sessionId,
        turns: output.turns,
        toolCalls: output.toolCalls,
        toolErrors: output.toolErrors,
        framework: output.framework,
        context: output.context,
        events: output.events,
        finishedAt: new Date().toISOString(),
      })
      return completed
    } catch (error) {
      await this.finishReviewerRun(input.sourceKind, input.sourceId, runId, {
        status: signal.aborted ? 'cancelled' : 'failed',
        events: observedEvents,
        finishedAt: new Date().toISOString(),
        error: safeError(error, input.model),
      })
      throw error
    }
  }

  private async addReviewerRun(record: PlanningSubAgentRunRecord) {
    await this.store.transaction(state => {
      const runs = reviewerRuns(state, record.sourceKind, record.sourceId)
      if (runs.some(item => item.runId === record.runId)) {
        throw new Error('PLANNING_REVIEWER_RUN_DUPLICATE')
      }
      runs.push(structuredClone(record))
    })
  }

  private async finishReviewerRun(
    sourceKind: PlanningSubAgentRunRecord['sourceKind'],
    sourceId: string,
    runId: string,
    patch: Partial<PlanningSubAgentRunRecord>,
  ) {
    await this.store.transaction(state => {
      const record = required(
        reviewerRuns(state, sourceKind, sourceId).find(
          item => item.runId === runId,
        ),
        'PLANNING_REVIEWER_RUN_NOT_FOUND',
      )
      Object.assign(record, structuredClone(patch))
    })
  }
}

function stage(
  planningStage: PlanningStageProfile['stage'],
  agentKey: PlanningStageProfile['agentKey'],
  allowedSkillKeys: string[],
  allowedToolIds: string[],
  submitToolId: string | undefined,
  resultSchemaVersion: string | undefined,
  reviewers: PlanningReviewerType[],
  humanGate = false,
): PlanningStageProfile {
  return {
    stage: planningStage,
    agentKey,
    allowedSkillKeys,
    allowedToolIds,
    ...(submitToolId ? { submitToolId } : {}),
    ...(resultSchemaVersion ? { resultSchemaVersion } : {}),
    reviewers,
    humanGate,
  }
}

function reviewer(
  reviewerType: PlanningReviewerType,
  label: string,
): PlanningAgentProfile['subAgents'][number] {
  return {
    reviewerType,
    label,
    session: 'independent',
    workspace: 'read_only',
    resultSchemaVersion: 'planning-review-candidate/v1',
  }
}

function requirementModel(
  state: DatabaseState,
  run: ReviewRun,
): AgentModelConnection {
  const reference = run.snapshot.modelRef
  const configuration = run.snapshot.agentConfigurationRef
    ? required(
        state.agentConfigurationVersions.find(
          item => item.id === run.snapshot.agentConfigurationRef?.id,
        ),
        'REQUIREMENT_AGENT_CONFIGURATION_NOT_FOUND',
      )
    : undefined
  if (configuration && (
    configuration.version !== run.snapshot.agentConfigurationRef?.version
    || configuration.contentSha256
      !== run.snapshot.agentConfigurationRef?.contentSha256
    || configuration.agentDefinition.contentSha256
      !== run.snapshot.agentDefinition.contentSha256
  )) {
    throw new Error('REQUIREMENT_AGENT_CONFIGURATION_DRIFT')
  }
  const source = required(
    state.modelSources.find(item => item.id === reference.sourceId),
    'REQUIREMENT_REVIEWER_MODEL_SOURCE_NOT_FOUND',
  )
  const model = required(
    source.models.find(item => item.id === reference.modelId),
    'REQUIREMENT_REVIEWER_MODEL_NOT_FOUND',
  )
  requireModelReady(source, model)
  if (
    source.providerType !== reference.providerType
    || model.name !== reference.modelName
    || model.contextWindow !== reference.contextWindow
  ) {
    throw new Error('REQUIREMENT_REVIEWER_MODEL_DRIFT')
  }
  return {
    sourceId: source.id,
    providerType: source.providerType,
    baseUrl: source.baseUrl,
    apiKey: source.apiKey,
    modelId: model.id,
    modelName: model.name,
    contextWindow: reference.contextWindow,
    maxOutputTokens: reference.maxOutputTokens,
    supportsReasoning: reference.supportsReasoning,
    ...(configuration ? {
      requestTimeoutMs:
        configuration.routing.requestTimeoutSeconds * 1_000,
      retryCount: configuration.routing.retryCount,
    } : {}),
  }
}

function fixedTestDesignConfiguration(
  state: DatabaseState,
  run: TestDesignWorkflowRun,
) {
  const frozen = run.agentConfigurationSnapshot
  const configuration = required(
    state.agentConfigurationVersions.find(
      item => item.id === frozen.configurationId,
    ),
    'TEST_DESIGN_AGENT_CONFIGURATION_NOT_FOUND',
  )
  if (
    configuration.version !== frozen.configurationVersion
    || configuration.contentSha256 !== frozen.configurationSha256
    || canonicalSha256(configuration.agentDefinition)
      !== canonicalSha256(frozen.agentDefinition)
  ) {
    throw new Error('TEST_DESIGN_AGENT_CONFIGURATION_DRIFT')
  }
  const reference = configuration.routing.primaryModel
  if (
    !reference
    || reference.sourceId !== frozen.primaryModel.sourceId
    || reference.modelId !== frozen.primaryModel.modelId
  ) {
    throw new Error('TEST_DESIGN_AGENT_MODEL_DRIFT')
  }
  return configuration
}

function testDesignModel(
  state: DatabaseState,
  run: TestDesignWorkflowRun,
  configuration: AgentConfigurationVersion,
): AgentModelConnection {
  const reference = run.agentConfigurationSnapshot.primaryModel
  const source = required(
    state.modelSources.find(item => item.id === reference.sourceId),
    'TEST_DESIGN_REVIEWER_MODEL_SOURCE_NOT_FOUND',
  )
  const model = required(
    source.models.find(item => item.id === reference.modelId),
    'TEST_DESIGN_REVIEWER_MODEL_NOT_FOUND',
  )
  requireModelReady(source, model)
  if (
    source.providerType !== reference.providerType
    || model.name !== reference.modelName
    || model.contextWindow !== reference.contextWindow
    || configuration.routing.maxOutputTokens !== reference.maxOutputTokens
    || model.capabilities.includes('reasoning') !== reference.supportsReasoning
  ) {
    throw new Error('TEST_DESIGN_REVIEWER_MODEL_DRIFT')
  }
  return {
    sourceId: reference.sourceId,
    providerType: reference.providerType,
    baseUrl: source.baseUrl,
    apiKey: source.apiKey,
    modelId: reference.modelId,
    modelName: reference.modelName,
    contextWindow: reference.contextWindow,
    maxOutputTokens: reference.maxOutputTokens,
    supportsReasoning: reference.supportsReasoning,
    requestTimeoutMs:
      configuration.routing.requestTimeoutSeconds * 1_000,
    retryCount: configuration.routing.retryCount,
  }
}

function requireModelReady(
  source: DatabaseState['modelSources'][number],
  model: DatabaseState['modelSources'][number]['models'][number],
) {
  if (
    !source.enabled
    || !model.enabled
    || model.health !== 'healthy'
    || !model.qualityGate?.passed
    || !model.capabilities.includes('tool_calling')
  ) {
    throw new Error('PLANNING_REVIEWER_MODEL_NOT_READY')
  }
}

function requirementReadPaths(run: ReviewRun) {
  const root = normalizeLogicalPath(
    run.snapshot.documentWorkspace?.rootLogicalPath
      ?? run.snapshot.documentWorkspace?.logicalPath
      ?? '',
  )
  const paths = run.snapshot.assets.map(item => relativePath(root, item.logicalPath))
  if (!paths.length) throw new Error('REQUIREMENT_REVIEWER_INPUT_EMPTY')
  return paths
}

function requirementReviewerTask(run: ReviewRun) {
  return [
    '审阅固定 RequirementAnalysis 结果，不修改任何正式事实。',
    `Source Run：${run.id}`,
    `ProjectVersion：${run.projectVersionId}`,
    `固定 AssetVersion/Hash：${JSON.stringify(run.snapshot.assets.map(item => ({ assetVersionId: item.assetVersionId, contentSha256: item.assetContentHash })))}`,
    `固定 Finding：${JSON.stringify(run.result?.findings ?? [])}`,
    '重点检查需求完整性、一致性、歧义、可验证性、Evidence 与 Test Focus。',
  ].join('\n')
}

function captureTestDesignReviewerSource(
  run: TestDesignWorkflowRun,
  reviewerType: Exclude<PlanningReviewerType, 'requirement'>,
  selection: TestDesignReviewerSourceSelection,
): Extract<PlanningReviewerSourceReference, { kind: 'test_design' }> {
  const tree = required(run.testPointTree, 'TEST_POINT_TREE_NOT_READY')
  const audit = reviewerType === 'coverage'
    ? required(
        selection.coverageAuditId
          ? run.coverageAudits.find(item =>
              item.id === selection.coverageAuditId
              && item.status === 'valid',
            )
          : undefined,
        selection.coverageAuditId
          ? 'COVERAGE_AUDIT_NOT_FOUND'
          : 'COVERAGE_REVIEW_AUDIT_ID_REQUIRED',
      )
    : undefined
  const approvedVersion = selection.approvedTestPointTreeVersionId
    ? required(
        tree.versions.find(item =>
          item.id === selection.approvedTestPointTreeVersionId
          && item.revision === selection.testPointTreeRevision,
        ),
        'TEST_POINT_TREE_APPROVAL_REQUIRED',
      )
    : undefined
  const treeRevision = required(
    tree.revisions.find(item =>
      item.revision === selection.testPointTreeRevision
      && (!approvedVersion || item.treeSha256 === approvedVersion.treeSha256),
    ),
    'TEST_POINT_TREE_SOURCE_NOT_FOUND',
  )
  if (reviewerType !== 'test_point' && !approvedVersion) {
    throw new Error('TEST_POINT_TREE_APPROVAL_REQUIRED')
  }
  if (reviewerType === 'coverage' && audit?.treeVersionId !== approvedVersion?.id) {
    throw new Error('COVERAGE_AUDIT_SOURCE_DRIFT')
  }

  const activeCases = run.testCases.filter(item => !item.tombstonedAt)
  const testCases = reviewerType === 'test_point'
    ? []
    : selection.testCases.map(reference => {
        const item = required(
          activeCases.find(candidate =>
            candidate.id === reference.caseId
            && candidate.treeVersionId === reference.treeVersionId,
          ),
          'TEST_CASE_SOURCE_NOT_FOUND',
        )
        const revision = required(
          item.revisions.find(candidate => candidate.revision === reference.revision),
          'TEST_CASE_REVISION_NOT_FOUND',
        )
        return {
          caseId: item.id,
          treeVersionId: item.treeVersionId,
          revision: revision.revision,
          contentSha256: revision.contentSha256,
        }
      }).sort((left, right) => left.caseId.localeCompare(right.caseId))
  if (
    reviewerType !== 'test_point'
    && (
      testCases.length !== activeCases.length
      || new Set(testCases.map(item => item.caseId)).size !== testCases.length
      || activeCases.some(item => !testCases.some(reference => reference.caseId === item.id))
    )
  ) {
    throw new Error('TEST_CASE_SOURCE_SELECTION_INCOMPLETE')
  }

  const dataSet = reviewerType === 'test_point'
    ? undefined
    : required(
        selection.dataSetVersionId
          ? run.dataSetVersions.find(item => item.id === selection.dataSetVersionId)
          : undefined,
        'TEST_DATA_VERSION_NOT_FOUND',
      )
  if (audit) {
    const caseSetSha256 = canonicalSha256(testCases.map(item => ({
      caseId: item.caseId,
      revision: item.revision,
      contentSha256: item.contentSha256,
    })))
    if (
      audit.caseSetSha256 !== caseSetSha256
      || audit.dataSetVersionId !== dataSet?.id
    ) {
      throw new Error('COVERAGE_AUDIT_SOURCE_DRIFT')
    }
  }
  return {
    kind: 'test_design',
    testDesignRunId: run.id,
    requirementReleaseId: run.basisSnapshot.requirementReleaseId,
    requirementsJsonSha256: run.basisSnapshot.requirementsJsonSha256,
    testPointTreeId: tree.id,
    testPointTreeRevision: treeRevision.revision,
    testPointTreeSha256: treeRevision.treeSha256,
    ...(approvedVersion ? {
      approvedTestPointTreeVersionId: approvedVersion.id,
    } : {}),
    testCases,
    ...(dataSet ? {
      dataSetVersionId: dataSet.id,
      dataSetContentSha256: dataSet.contentSha256,
    } : {}),
    ...(audit ? {
      coverageAuditId: audit.id,
      coverageAuditInputSha256: audit.inputSha256,
    } : {}),
  }
}

function testDesignReviewerProjection(
  state: DatabaseState,
  run: TestDesignWorkflowRun,
  reviewerType: Exclude<PlanningReviewerType, 'requirement'>,
  sourceReference: Extract<PlanningReviewerSourceReference, { kind: 'test_design' }>,
  configuration: AgentConfigurationVersion,
) {
  const projectVersion = required(
    state.projectVersions.find(item => item.id === run.projectVersionId),
    'PROJECT_VERSION_NOT_FOUND',
  )
  const project = required(
    state.projects.find(item => item.id === projectVersion.projectId),
    'PROJECT_NOT_FOUND',
  )
  const files = new Map<string, TestDesignWorkspaceFile>()
  for (const file of [
    ...run.workspaceSnapshot.files,
    ...run.formalWorkspaceFiles,
  ]) {
    requireFileHash(file)
    files.set(file.logicalPath, structuredClone(file))
  }
  const requirementPath = required(
    [...files.values()].find(
      file => file.logicalPath === `${run.workspaceSnapshot.activeBranchLogicalPath}/requirements/requirements.json`,
    )?.logicalPath,
    'TEST_DESIGN_REQUIREMENTS_FILE_NOT_FOUND',
  )
  const reviewRoot = `workspace/agent_workspace/design_agent/reviewer/${run.id}`
  const tree = required(
    run.testPointTree?.id === sourceReference.testPointTreeId
      ? run.testPointTree
      : undefined,
    'TEST_POINT_TREE_NOT_READY',
  )
  const currentTree = required(
    tree.revisions.find(
      revision =>
        revision.revision === sourceReference.testPointTreeRevision
        && revision.treeSha256 === sourceReference.testPointTreeSha256,
    ),
    'TEST_POINT_TREE_SOURCE_DRIFT',
  )
  const approvedTreeVersion = sourceReference.approvedTestPointTreeVersionId
    ? required(
        tree.versions.find(
          version =>
            version.id === sourceReference.approvedTestPointTreeVersionId
            && version.revision === sourceReference.testPointTreeRevision
            && version.treeSha256 === sourceReference.testPointTreeSha256,
        ),
        'TEST_POINT_TREE_VERSION_SOURCE_DRIFT',
      )
    : undefined
  const treePayload = {
    schemaVersion: 'planning-review-test-point-tree/v1',
    treeId: run.testPointTree?.id,
    currentRevision: currentTree.revision,
    currentTreeSha256: currentTree.treeSha256,
    approvedVersion: approvedTreeVersion ?? null,
    nodes: currentTree.nodes,
  }
  const treePath = `${reviewRoot}/test-point-tree.json`
  files.set(treePath, candidateFile(treePath, treePayload, run.id))

  const casesPayload = {
    schemaVersion: 'planning-review-test-cases/v1',
    cases: sourceReference.testCases.map(reference => {
      const item = required(
        run.testCases.find(candidate =>
          candidate.id === reference.caseId
          && candidate.treeVersionId === reference.treeVersionId,
        ),
        'TEST_CASE_SOURCE_NOT_FOUND',
      )
      const revision = required(
        item.revisions.find(candidate =>
          candidate.revision === reference.revision
          && candidate.contentSha256 === reference.contentSha256,
        ),
        'TEST_CASE_REVISION_SOURCE_DRIFT',
      )
      return {
        id: item.id,
        treeVersionId: item.treeVersionId,
        revisionNumber: reference.revision,
        reviewState: item.reviewState,
        revision,
      }
    }),
  }
  const casesPath = `${reviewRoot}/test-cases.json`
  files.set(casesPath, candidateFile(casesPath, casesPayload, run.id))
  const dataSet = sourceReference.dataSetVersionId
    ? required(
        run.dataSetVersions.find(candidate =>
          candidate.id === sourceReference.dataSetVersionId
          && candidate.contentSha256 === sourceReference.dataSetContentSha256,
        ),
        'TEST_DATA_VERSION_SOURCE_DRIFT',
      )
    : undefined
  const dataPath = `${reviewRoot}/test-data-requirements.json`
  files.set(dataPath, candidateFile(dataPath, {
    schemaVersion: 'planning-review-test-data/v1',
    dataSet: dataSet ?? null,
  }, run.id))

  let audit: CoverageAudit | undefined
  let auditPath: string | undefined
  if (reviewerType === 'coverage') {
    audit = required(
      run.coverageAudits.find(item =>
        item.id === sourceReference.coverageAuditId
        && item.inputSha256 === sourceReference.coverageAuditInputSha256
        && item.treeVersionId === sourceReference.approvedTestPointTreeVersionId
        && item.dataSetVersionId === sourceReference.dataSetVersionId
        && item.caseSetSha256 === canonicalSha256(
          sourceReference.testCases.map(item => ({
            caseId: item.caseId,
            revision: item.revision,
            contentSha256: item.contentSha256,
          })).sort((left, right) => left.caseId.localeCompare(right.caseId)),
        ),
      ),
      'COVERAGE_AUDIT_SOURCE_DRIFT',
    )
    auditPath = `${reviewRoot}/coverage-audit.json`
    files.set(auditPath, candidateFile(auditPath, {
      schemaVersion: 'planning-review-coverage-audit/v1',
      audit,
      findings: run.findings,
      confirmationItems: run.confirmationItems,
    }, run.id))
  }

  const requiredLogicalPaths = reviewerType === 'test_point'
    ? [requirementPath, treePath]
    : reviewerType === 'test_case'
      ? [requirementPath, treePath, casesPath, dataPath]
      : [requirementPath, treePath, casesPath, dataPath, required(auditPath, 'COVERAGE_AUDIT_PATH_REQUIRED')]
  const workspaceFiles = [...files.values()].map(file => ({
    logicalPath: file.logicalPath,
    contentSha256: file.contentSha256,
    content: file.content,
    displayName: file.displayName,
    ...(file.assetId ? { assetId: file.assetId } : {}),
    ...(file.assetVersionId ? { assetVersionId: file.assetVersionId } : {}),
  })).sort((left, right) => left.logicalPath.localeCompare(right.logicalPath, 'zh-CN'))
  const task = testDesignReviewerTask(
    run,
    reviewerType,
    sourceReference,
    audit,
  )
  const snapshot: PlanningReviewerSnapshot = {
    runId: `review:${reviewerType}:${run.id}`,
    projectId: project.id,
    projectName: project.name,
    projectVersionId: projectVersion.id,
    projectVersionName: projectVersion.name,
    knowledgeBaseId: run.workspaceSnapshot.knowledgeBaseId,
    indexVersionId: run.workspaceSnapshot.indexVersionId,
    assets: workspaceFiles.flatMap(file => file.assetId && file.assetVersionId ? [{
      assetId: file.assetId,
      assetVersionId: file.assetVersionId,
      assetContentHash: file.contentSha256,
      logicalPath: file.logicalPath,
      displayName: file.displayName,
    }] : []),
    documentWorkspace: {
      mode: 'agent_directory',
      logicalPath: run.workspaceSnapshot.rootLogicalPath,
      rootLogicalPath: run.workspaceSnapshot.rootLogicalPath,
      activeBranchLogicalPath: run.workspaceSnapshot.activeBranchLogicalPath,
      branchLogicalPaths: [run.workspaceSnapshot.activeBranchLogicalPath],
      agentLogicalPath: run.workspaceSnapshot.agentLogicalPath,
      layoutVersion: 'workspace/v1',
      candidateAssetVersionIds: [],
    },
    workspaceFiles,
    agentDefinition: structuredClone(configuration.agentDefinition),
    taskSha256: canonicalSha256(task),
    createdAt: new Date().toISOString(),
  }
  return {
    snapshot,
    task,
    requiredReadPaths: requiredLogicalPaths.map(path => relativePath('workspace', path)),
    sourceSha256: canonicalSha256({
      runId: run.id,
      reviewerType,
      requiredFiles: requiredLogicalPaths.map(path => ({
        path,
        contentSha256: required(files.get(path), 'REVIEWER_FILE_NOT_FOUND').contentSha256,
      })),
      sourceReference,
      configurationId: run.agentConfigurationSnapshot.configurationId,
      configurationSha256: run.agentConfigurationSnapshot.configurationSha256,
    }),
  }
}

function testDesignReviewerTask(
  run: TestDesignWorkflowRun,
  reviewerType: Exclude<PlanningReviewerType, 'requirement'>,
  sourceReference: Extract<PlanningReviewerSourceReference, { kind: 'test_design' }>,
  audit: CoverageAudit | undefined,
) {
  const objective = {
    test_point: '审阅当前候选测试点树的覆盖、维度、适用性、Oracle 与需求追踪。',
    test_case: '审阅当前 TestCase revisions 的步骤、Expected Result、边界、数据、依赖与可执行性。',
    coverage: '审阅指定 CoverageAudit 的覆盖关系、遗漏、重复、阻塞项和修复后残留风险。',
  }[reviewerType]
  return [
    objective,
    `Source TestDesign Run：${run.id}`,
    `Requirement Release：${run.basisSnapshot.requirementReleaseId}`,
    `Requirements Hash：${run.basisSnapshot.requirementsJsonSha256}`,
    `TestPoint Tree Revision：${sourceReference.testPointTreeRevision}`,
    `TestPoint Tree Hash：${sourceReference.testPointTreeSha256}`,
    `TestCase Revisions：${JSON.stringify(sourceReference.testCases)}`,
    `DataSet Version：${sourceReference.dataSetVersionId ?? 'none'}`,
    ...(audit ? [`CoverageAudit：${audit.id}`, `Coverage inputSha256：${audit.inputSha256}`] : []),
    '只输出 ReviewCandidate；不得修改 Stage、Workspace、Case、Expected Result 或发布对象。',
  ].join('\n')
}

function candidateFile(
  logicalPath: string,
  payload: unknown,
  sourceId: string,
): TestDesignWorkspaceFile {
  const content = `${canonicalJson(payload)}\n`
  return {
    logicalPath,
    sourceType: 'run_candidate',
    sourceId,
    contentSha256: sha256Text(content),
    content,
    displayName: logicalPath.split('/').at(-1) ?? logicalPath,
  }
}

function requireFileHash(file: TestDesignWorkspaceFile) {
  if (sha256Text(file.content) !== file.contentSha256) {
    throw new Error(`TEST_DESIGN_REVIEWER_FILE_DRIFT: ${file.logicalPath}`)
  }
}

function reviewerRuns(
  state: DatabaseState,
  sourceKind: PlanningSubAgentRunRecord['sourceKind'],
  sourceId: string,
) {
  if (sourceKind === 'requirement_run') {
    const source = required(
      state.reviewRuns.find(item => item.id === sourceId),
      'REQUIREMENT_RUN_NOT_FOUND',
    )
    return source.planningSubAgentRuns ??= []
  }
  const source = required(
    state.testDesignState?.runs.find(item => item.id === sourceId),
    'TEST_DESIGN_RUN_NOT_FOUND',
  )
  return source.planningSubAgentRuns ??= []
}

function relativePath(root: string, logicalPath: string) {
  const normalizedRoot = normalizeLogicalPath(root)
  const normalizedPath = normalizeLogicalPath(logicalPath)
  const relative = posix.relative(normalizedRoot, normalizedPath)
  if (!relative || relative === '..' || relative.startsWith('../')) {
    throw new Error(`PLANNING_REVIEWER_PATH_OUTSIDE_WORKSPACE: ${logicalPath}`)
  }
  return relative
}

function normalizeLogicalPath(value: string) {
  const normalized = posix.normalize(
    value.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, ''),
  )
  if (
    !normalized
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
  ) {
    throw new Error(`PLANNING_REVIEWER_PATH_INVALID: ${value}`)
  }
  return normalized
}

function planningScope(projectId: string, projectVersionId: string) {
  return `planning:${projectId}:${projectVersionId}`
}

function safeError(error: unknown, model: AgentModelConnection) {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replaceAll(model.apiKey, '[REDACTED]')
    .replaceAll(model.baseUrl, '[MODEL_ENDPOINT]')
    .slice(0, 4_000)
}

function sha256Text(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function required<T>(value: T | null | undefined, code: string): T {
  if (value == null) throw new Error(code)
  return value
}
