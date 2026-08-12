import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { AgentConfigurationAgentKey, AgentConfigurationDraft, AgentConfigurationScene, AgentConfigurationVersion, AgentExecutionRecord, AiResource, ConfigVersion, DatabaseState, GenerativeModelSource, ProjectVersion, ProjectVersionRequirementBinding, ReviewRun } from '../domain/types.js'

export interface TaskLease { workerId: string; runToken: string }
export interface ReviewJob {
  id: string
  runId: string
  projectVersionId: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  attempts: number
  maxAttempts: number
  availableAt: string
  createdAt: string
  updatedAt: string
  leaseOwner?: string
  runToken?: string
  leaseExpiresAt?: string
  heartbeatAt?: string
  cancelRequestedAt?: string
  startedAt?: string
  finishedAt?: string
  error?: string
}
export interface TestDesignJob { id: string; runId: string; nodeRunId: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; attempts: number; maxAttempts: number; availableAt: string; createdAt: string; updatedAt: string; leaseOwner?: string; runToken?: string; leaseExpiresAt?: string; cancelRequestedAt?: string; error?: string }

export type RequirementBindingMetadata = ProjectVersionRequirementBinding & {
  asset: {
    displayName: string
    logicalPath: string
    assetType: string
    sourceType: string
    activeVersionId: string | null
  }
  version: {
    id: string
    number: number
    status: string
    createdAt: string
    readyAt?: string
  }
  versions: Array<{
    id: string
    number: number
    status: string
    createdAt: string
    readyAt?: string
  }>
}

export type ReviewRunPage = {
  items: ReviewRun[]
  nextCursor?: string
}

export type ConfigurationTransactionScope = 'ai_configuration' | 'knowledge_configuration'

export type KnowledgeReadState = {
  state: DatabaseState
  indexChunkCounts: Record<string, number>
}

export type DefaultKnowledgeBase = {
  project: DatabaseState['projects'][number]
  knowledgeBase: DatabaseState['knowledgeBases'][number]
}

const emptyState = (): DatabaseState => ({ projects: [], projectVersions: [], projectVersionRequirementBindings: [], knowledgeBases: [], directories: [], configs: [], assets: [], versions: [], indexes: [], tasks: [], modelSources: [], aiResources: [], agentConfigurationDrafts: [], agentConfigurationVersions: [], reviewRuns: [], findingActions: [], toolApprovals: [] })

export interface StateStore {
  load(): Promise<void>
  read(): DatabaseState
  snapshot(): Promise<DatabaseState>
  getDefaultKnowledgeBase?(projectName: string): Promise<DefaultKnowledgeBase | null>
  listProjectVersions?(): Promise<ProjectVersion[]>
  getKnowledgeReadState?(knowledgeBaseId: string, options?: { includeVersionContent?: boolean; includeIndexes?: boolean }): Promise<KnowledgeReadState | null>
  getAssetVersion?(versionId: string, includeChunks: boolean): Promise<DatabaseState['versions'][number] | null>
  getSyncTask?(taskId: string): Promise<DatabaseState['tasks'][number] | null>
  getActiveKnowledgeConfig?(knowledgeBaseId: string): Promise<ConfigVersion | null>
  listModelSources?(): Promise<GenerativeModelSource[]>
  listAiResources?(): Promise<AiResource[]>
  getAgentConfigurationState?(scene: AgentConfigurationScene): Promise<{ draft: AgentConfigurationDraft | null; versions: AgentConfigurationVersion[] }>
  getActiveAgentConfiguration?(scene: AgentConfigurationScene, agentKey: AgentConfigurationAgentKey): Promise<AgentConfigurationVersion | null>
  getProjectVersion?(projectVersionId: string): Promise<ProjectVersion | null>
  listRequirementBindings?(projectVersionId: string): Promise<RequirementBindingMetadata[]>
  listReviewRuns?(projectVersionId: string, options: { limit: number; cursor?: string; runningOnly?: boolean }): Promise<ReviewRunPage>
  getReviewRun?(runId: string): Promise<ReviewRun | null>
  getToolApproval?(approvalId: string): Promise<DatabaseState['toolApprovals'][number] | null>
  recoverInterruptedReviewRuns?(finishedAt: string, error: string): Promise<number>
  saveReviewRunExecution?(runId: string, execution: AgentExecutionRecord): Promise<void>
  transaction<T>(operation: (draft: DatabaseState) => T | Promise<T>): Promise<T>
  transactionScope?<T>(scope: ConfigurationTransactionScope, operation: (draft: DatabaseState) => T | Promise<T>): Promise<T>
  transactionWithTaskLease?<T>(taskId: string, lease: TaskLease, operation: (draft: DatabaseState) => T | Promise<T>): Promise<T | null>
  searchChunks?(input: ChunkSearchInput): Promise<StoredChunkCandidate[]>
  claimTask?(workerId: string, leaseMs: number): Promise<DatabaseState['tasks'][number] | null>
  heartbeatTask?(taskId: string, lease: TaskLease, leaseMs: number): Promise<boolean>
  releaseTask?(taskId: string, lease: TaskLease, retryDelayMs?: number): Promise<boolean>
  ownsTask?(taskId: string, lease: TaskLease): Promise<boolean>
  notifyTask?(): Promise<void>
  waitForTaskNotification?(timeoutMs: number): Promise<void>
  enqueueReviewJob?(job: ReviewJob): Promise<void>
  claimReviewJob?(workerId: string, leaseMs: number): Promise<ReviewJob | null>
  heartbeatReviewJob?(runId: string, lease: TaskLease, leaseMs: number): Promise<boolean>
  finishReviewJob?(runId: string, lease: TaskLease, status: 'succeeded' | 'failed' | 'cancelled', error?: string): Promise<boolean>
  releaseReviewJob?(runId: string, lease: TaskLease, retryDelayMs: number, error: string): Promise<boolean>
  cancelReviewJob?(runId: string): Promise<boolean>
  transactionWithReviewLease?<T>(runId: string, lease: TaskLease, operation: (draft: DatabaseState) => T | Promise<T>): Promise<T | null>
  enqueueTestDesignJob?(job: TestDesignJob): Promise<void>
  claimTestDesignJob?(workerId: string, leaseMs: number): Promise<TestDesignJob | null>
  heartbeatTestDesignJob?(nodeRunId: string, lease: TaskLease, leaseMs: number): Promise<boolean>
  finishTestDesignJob?(nodeRunId: string, lease: TaskLease, status: 'succeeded' | 'failed' | 'cancelled', error?: string): Promise<boolean>
  releaseTestDesignJob?(nodeRunId: string, lease: TaskLease, retryDelayMs: number, error: string): Promise<boolean>
  cancelTestDesignJob?(runId: string): Promise<boolean>
  transactionWithTestDesignLease?<T>(nodeRunId: string, lease: TaskLease, operation: (draft: DatabaseState) => T | Promise<T>): Promise<T | null>
  ensureVectorIndex?(indexVersionId: string, dimensions: number): Promise<void>
  isVectorIndexReady?(indexVersionId: string, dimensions: number): Promise<boolean>
  close?(): Promise<void>
}

export interface ChunkSearchInput {
  indexVersionId: string
  mode: 'keyword' | 'vector'
  query: string
  queryVector?: number[]
  dimensions: number
  limit: number
  logicalPath?: string
}

export interface StoredChunkCandidate {
  score: number
  asset: { id: string; displayName: string; assetType: string; sourceType: string; logicalPath: string }
  version: { id: string; number: number }
  chunk: { id: string; chunkKey: string; headingPath: string[]; startLine: number; endLine: number; startChar: number; endChar: number }
  content: string
}

export class JsonStore implements StateStore {
  private state: DatabaseState = emptyState()
  private queue = Promise.resolve()
  constructor(private readonly file: string | null) {}
  async load() {
    if (!this.file) return
    try {
      const loaded = JSON.parse(await readFile(this.file, 'utf8')) as DatabaseState & { reviewQaSessions?: unknown[]; reviewQaTurns?: unknown[]; technicalSolutionReviews?: unknown[]; technicalSolutionRuns?: unknown[]; technicalSolutionFindingActions?: unknown[] }
      this.state = loaded
      this.state.projectVersions ??= []; this.state.projectVersionRequirementBindings ??= []; this.state.directories ??= []; this.state.modelSources ??= []; this.state.aiResources ??= []; this.state.agentConfigurationDrafts ??= []; this.state.agentConfigurationVersions ??= []; this.state.reviewRuns ??= []; this.state.findingActions ??= []; this.state.toolApprovals ??= []
      const retiredDataRemoved = removeRetiredAgentData(loaded)
      normalizeTestDesignState(this.state)
      normalizeReviewSeverities(this.state)
      if (retiredDataRemoved) await this.transaction(() => undefined)
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  read() { return structuredClone(this.state) }
  async snapshot() { return this.read() }
  async listAiResources() { return structuredClone(this.state.aiResources) }
  async getAgentConfigurationState(scene: AgentConfigurationScene) {
    return structuredClone({
      draft: this.state.agentConfigurationDrafts.find(item => item.scene === scene) ?? null,
      versions: this.state.agentConfigurationVersions.filter(item => item.scene === scene),
    })
  }
  async getActiveAgentConfiguration(scene: AgentConfigurationScene, agentKey: AgentConfigurationAgentKey) { return structuredClone(this.state.agentConfigurationVersions.find(item => item.scene === scene && item.agentKey === agentKey && item.status === 'active') ?? null) }
  async getToolApproval(approvalId: string) { return structuredClone(this.state.toolApprovals.find(item => item.id === approvalId) ?? null) }
  async saveReviewRunExecution(runId: string, execution: AgentExecutionRecord) {
    await this.transaction(state => {
      const run = state.reviewRuns.find(item => item.id === runId)
      if (!run) throw new Error('需求评审运行不存在')
      run.execution = structuredClone(execution)
    })
  }
  async transaction<T>(operation: (draft: DatabaseState) => T | Promise<T>): Promise<T> {
    let result!: T
    let failure: unknown
    this.queue = this.queue.then(async () => {
      try {
        const draft = structuredClone(this.state)
        result = await operation(draft)
        this.state = draft
        if (this.file) {
          await mkdir(dirname(this.file), { recursive: true })
          const temporary = `${this.file}.${randomUUID()}.tmp`
          await writeFile(temporary, JSON.stringify(this.state, null, 2), 'utf8')
          await copyFile(temporary, this.file)
          await unlink(temporary)
        }
      } catch (error) { failure = error }
    })
    await this.queue
    if (failure) throw failure
    return result
  }
}

export function normalizeTestDesignState(state: DatabaseState) {
  const aggregate = state.testDesignState
  if (!aggregate) return
  aggregate.caseSetVersions ??= []
  aggregate.libraryCases ??= []
  aggregate.libraryVersions ??= []
  aggregate.suiteDrafts ??= []
  aggregate.suiteVersions ??= []
  aggregate.executionHandoffs ??= []
  aggregate.legacyMigrations ??= []
  for (const run of aggregate.runs ?? []) run.caseChangeProposals ??= []
  for (const draft of aggregate.suiteDrafts) normalizeSuiteLibraryBinding(draft)
  for (const version of aggregate.suiteVersions) normalizeSuiteLibraryBinding(version)
}

function normalizeSuiteLibraryBinding(suite: { testCaseLibraryVersionId?: string; compatibilityStatus?: 'compatible' | 'migration_required'; incompatibilityReason?: string; members: Array<{ testCaseLibraryVersionId?: string }> }) {
  const memberVersionIds = [...new Set(suite.members.map(member => member.testCaseLibraryVersionId).filter((value): value is string => Boolean(value)))]
  if (suite.testCaseLibraryVersionId && memberVersionIds.every(id => id === suite.testCaseLibraryVersionId)) {
    suite.compatibilityStatus = 'compatible'
    suite.incompatibilityReason = undefined
  } else if (!suite.testCaseLibraryVersionId && memberVersionIds.length === 1 && suite.members.every(member => member.testCaseLibraryVersionId === memberVersionIds[0])) {
    suite.testCaseLibraryVersionId = memberVersionIds[0]
    suite.compatibilityStatus = 'compatible'
    suite.incompatibilityReason = undefined
  } else {
    suite.compatibilityStatus = 'migration_required'
    suite.incompatibilityReason = '历史套件未固定唯一正式用例库版本，需要人工迁移。'
  }
}

function removeRetiredAgentData(state: DatabaseState & { reviewQaSessions?: unknown[]; reviewQaTurns?: unknown[]; technicalSolutionReviews?: unknown[]; technicalSolutionRuns?: unknown[]; technicalSolutionFindingActions?: unknown[] }) {
  let changed = false
  if (state.testDesignState && state.testDesignState.architectureVersion !== 'single-agent-skills/v1') { state.testDesignState = undefined; changed = true }
  if ('reviewQaSessions' in state) { delete state.reviewQaSessions; changed = true }
  if ('reviewQaTurns' in state) { delete state.reviewQaTurns; changed = true }
  if ('technicalSolutionReviews' in state) { delete state.technicalSolutionReviews; changed = true }
  if ('technicalSolutionRuns' in state) { delete state.technicalSolutionRuns; changed = true }
  if ('technicalSolutionFindingActions' in state) { delete state.technicalSolutionFindingActions; changed = true }
  for (const draft of state.agentConfigurationDrafts) {
    const agents = draft.agents as unknown as Record<string, unknown>
    for (const key of ['reviewQa', 'requirementPointExtraction', 'requirementReview', 'technicalSolutionExtraction', 'technicalSolutionReview', 'technicalSolutionAnalysis', 'testAnalysis', 'functionalTestDesign', 'nonFunctionalTestDesign', 'testCaseSynthesis']) {
      if (key in agents) { delete agents[key]; changed = true }
    }
  }
  const versions = state.agentConfigurationVersions.filter(item => {
    const legacy = item as unknown as { agentKey?: string; agentDefinition?: { agentKey?: string }; agentDefinitions?: Record<string, unknown> }
    return !['reviewQa', 'requirementPointExtraction', 'requirementReview', 'technicalSolutionExtraction', 'technicalSolutionReview', 'technicalSolutionAnalysis', 'testAnalysis', 'functionalTestDesign', 'nonFunctionalTestDesign', 'testCaseSynthesis'].includes(legacy.agentKey ?? '')
      && !['review-qa', 'requirement-point-extraction', 'requirement-review', 'technical-solution-analysis', 'technical-solution-extraction', 'technical-solution-review', 'test-analysis', 'functional-test-design', 'non-functional-test-design', 'test-case-synthesis'].includes(legacy.agentDefinition?.agentKey ?? '')
      && !legacy.agentDefinitions?.requirementPointExtraction
      && !legacy.agentDefinitions?.requirementReview
      && !legacy.agentDefinitions?.technicalSolutionExtraction
      && !legacy.agentDefinitions?.technicalSolutionReview
      && !legacy.agentDefinitions?.technicalSolutionAnalysis
  })
  if (versions.length !== state.agentConfigurationVersions.length) { state.agentConfigurationVersions = versions; changed = true }
  const resources = state.aiResources.filter(item => !['review.answer_submit', 'requirement-points.submit_result', 'review.submit_result', 'technical_solution.input.read', 'technical_solution.evidence.preview', 'technical_solution_points.submit_result', 'technical_solution_review.submit_result', 'test_analysis.submit_result', 'functional_test_design.submit_result', 'non_functional_test_design.submit_result', 'test_case_synthesis.submit_result'].includes(item.key))
  if (resources.length !== state.aiResources.length) { state.aiResources = resources; changed = true }
  return changed
}

export function normalizeReviewSeverities(state: DatabaseState) {
  const runsById = new Map(state.reviewRuns.map(run => [run.id, run]))
  state.reviewRuns.forEach(run => {
    if (!run.reviewId) {
      let root = run
      const visited = new Set<string>()
      while (root.retryOfRunId && !visited.has(root.id)) {
        visited.add(root.id)
        const parent = runsById.get(root.retryOfRunId)
        if (!parent) break
        root = parent
      }
      run.reviewId = root.reviewId ?? `review_${root.id}`
    }
    run.snapshot.reviewId ??= run.reviewId
    run.result?.findings.forEach(finding => {
      const legacy = String(finding.severity)
      if (legacy === 'critical') finding.severity = 'blocker'
      else if (legacy === 'info') finding.severity = 'low'
    })
  })
}
