import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { DatabaseState } from '../domain/types.js'

export interface TaskLease { workerId: string; runToken: string }

const emptyState = (): DatabaseState => ({ projects: [], projectVersions: [], projectVersionRequirementBindings: [], knowledgeBases: [], directories: [], configs: [], assets: [], versions: [], indexes: [], tasks: [], modelSources: [], reviewRuns: [] })

export interface StateStore {
  load(): Promise<void>
  read(): DatabaseState
  snapshot(): Promise<DatabaseState>
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
