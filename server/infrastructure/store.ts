import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { AgentExecutionRecord, ConfigVersion, DatabaseState, GenerativeModelSource, ProjectVersion, ProjectVersionRequirementBinding, ReviewRun } from '../domain/types.js'

export interface TaskLease { workerId: string; runToken: string }

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

const emptyState = (): DatabaseState => ({ projects: [], projectVersions: [], projectVersionRequirementBindings: [], knowledgeBases: [], directories: [], configs: [], assets: [], versions: [], indexes: [], tasks: [], modelSources: [], reviewRuns: [] })

export interface StateStore {
  load(): Promise<void>
  read(): DatabaseState
  snapshot(): Promise<DatabaseState>
  getActiveKnowledgeConfig?(knowledgeBaseId: string): Promise<ConfigVersion | null>
  listModelSources?(): Promise<GenerativeModelSource[]>
  getProjectVersion?(projectVersionId: string): Promise<ProjectVersion | null>
  listRequirementBindings?(projectVersionId: string): Promise<RequirementBindingMetadata[]>
  listReviewRuns?(projectVersionId: string, options: { limit: number; cursor?: string; runningOnly?: boolean }): Promise<ReviewRunPage>
  getReviewRun?(runId: string): Promise<ReviewRun | null>
  saveReviewRunExecution?(runId: string, execution: AgentExecutionRecord): Promise<void>
  transaction<T>(operation: (draft: DatabaseState) => T | Promise<T>): Promise<T>
  transactionWithTaskLease?<T>(taskId: string, lease: TaskLease, operation: (draft: DatabaseState) => T | Promise<T>): Promise<T | null>
  searchChunks?(input: ChunkSearchInput): Promise<StoredChunkCandidate[]>
  claimTask?(workerId: string, leaseMs: number): Promise<DatabaseState['tasks'][number] | null>
  heartbeatTask?(taskId: string, lease: TaskLease, leaseMs: number): Promise<boolean>
  releaseTask?(taskId: string, lease: TaskLease, retryDelayMs?: number): Promise<boolean>
  ownsTask?(taskId: string, lease: TaskLease): Promise<boolean>
  notifyTask?(): Promise<void>
  waitForTaskNotification?(timeoutMs: number): Promise<void>
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
    try { this.state = JSON.parse(await readFile(this.file, 'utf8')) as DatabaseState; this.state.projectVersions ??= []; this.state.projectVersionRequirementBindings ??= []; this.state.directories ??= []; this.state.modelSources ??= []; this.state.reviewRuns ??= [] }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  read() { return structuredClone(this.state) }
  async snapshot() { return this.read() }
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
