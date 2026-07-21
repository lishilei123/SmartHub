import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { DatabaseState } from '../domain/types.js'

const emptyState = (): DatabaseState => ({ projects: [], knowledgeBases: [], directories: [], configs: [], assets: [], versions: [], indexes: [], tasks: [] })

export interface StateStore {
  load(): Promise<void>
  read(): DatabaseState
  transaction<T>(operation: (draft: DatabaseState) => T | Promise<T>): Promise<T>
  close?(): Promise<void>
}

export class JsonStore implements StateStore {
  private state: DatabaseState = emptyState()
  private queue = Promise.resolve()
  constructor(private readonly file: string | null) {}
  async load() {
    if (!this.file) return
    try { this.state = JSON.parse(await readFile(this.file, 'utf8')) as DatabaseState; this.state.directories ??= [] }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  read() { return structuredClone(this.state) }
  async transaction<T>(operation: (draft: DatabaseState) => T | Promise<T>): Promise<T> {
    let result!: T
    this.queue = this.queue.then(async () => {
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
    })
    await this.queue
    return result
  }
}
