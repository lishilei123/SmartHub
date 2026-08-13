import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, lstat, mkdir, open, realpath, rm, stat, unlink } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'

export const DEFAULT_MAXIMUM_EXECUTION_ARTIFACT_BYTES = 512 * 1024 * 1024

export interface ExecutionArtifactObject {
  storagePath: string
  sha256: string
  size: number
}

export interface StoredExecutionArtifact extends ExecutionArtifactObject {
  mimeType: string
}

export interface ExecutionArtifactStore {
  put(input: {
    body: AsyncIterable<Uint8Array>
    mimeType: string
    expectedSha256?: string
    maximumBytes?: number
  }): Promise<StoredExecutionArtifact>
  open(storagePath: string): Promise<Readable>
  stat(storagePath: string): Promise<ExecutionArtifactObject>
}

export class LocalExecutionArtifactStore implements ExecutionArtifactStore {
  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  async put(input: {
    body: AsyncIterable<Uint8Array>
    mimeType: string
    expectedSha256?: string
    maximumBytes?: number
  }): Promise<StoredExecutionArtifact> {
    const mimeType = safeMimeType(input.mimeType)
    const maximumBytes = input.maximumBytes ?? DEFAULT_MAXIMUM_EXECUTION_ARTIFACT_BYTES
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > DEFAULT_MAXIMUM_EXECUTION_ARTIFACT_BYTES) throw new Error('EXECUTION_ARTIFACT_SIZE_LIMIT_INVALID')
    if (input.expectedSha256 && !isSha256(input.expectedSha256)) throw new Error('EXECUTION_ARTIFACT_EXPECTED_HASH_INVALID')
    const stagingDirectory = resolve(this.root, '.staging')
    assertInside(this.root, stagingDirectory)
    await mkdir(stagingDirectory, { recursive: true })
    const temporary = resolve(stagingDirectory, `${randomUUID()}.tmp`)
    assertInside(stagingDirectory, temporary)
    const handle = await open(temporary, 'wx', 0o600)
    const hash = createHash('sha256')
    let size = 0
    let closed = false
    try {
      for await (const value of input.body) {
        const chunk = Buffer.from(value)
        size += chunk.length
        if (size > maximumBytes) throw new Error('EXECUTION_ARTIFACT_TOO_LARGE')
        hash.update(chunk)
        await handle.write(chunk)
      }
      if (!size) throw new Error('EXECUTION_ARTIFACT_EMPTY')
      await handle.sync()
      await handle.close()
      closed = true
      const sha256 = hash.digest('hex')
      if (input.expectedSha256 && input.expectedSha256 !== sha256) throw new Error('EXECUTION_ARTIFACT_HASH_MISMATCH')
      const storagePath = objectPath(sha256)
      const target = this.resolveStoragePath(storagePath)
      await mkdir(dirname(target), { recursive: true })
      try {
        await link(temporary, target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const existing = await lstat(target)
        if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== size) throw new Error('EXECUTION_ARTIFACT_IMMUTABILITY_CONFLICT')
      }
      await unlink(temporary)
      return { storagePath, sha256, size, mimeType }
    } finally {
      if (!closed) await handle.close().catch(() => undefined)
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  async open(storagePath: string) {
    const target = await this.resolveExistingFile(storagePath)
    return createReadStream(target)
  }

  async stat(storagePath: string): Promise<ExecutionArtifactObject> {
    const target = await this.resolveExistingFile(storagePath)
    const value = await stat(target)
    const sha256 = storagePath.split('/').at(-1)!
    return { storagePath, sha256, size: value.size }
  }

  private resolveStoragePath(storagePath: string) {
    const parts = safeStoragePath(storagePath).split('/')
    const target = resolve(this.root, ...parts)
    assertInside(this.root, target)
    return target
  }

  private async resolveExistingFile(storagePath: string) {
    const target = this.resolveStoragePath(storagePath)
    const [actualRoot, actual, metadata] = await Promise.all([
      realpath(this.root),
      realpath(target),
      lstat(target),
    ])
    assertInside(actualRoot, actual)
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('EXECUTION_ARTIFACT_NOT_REGULAR_FILE')
    return actual
  }
}

export function executionArtifactBody(value: string | Uint8Array) {
  return Readable.from([typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value)])
}

function objectPath(sha256: string) {
  return `objects/${sha256.slice(0, 2)}/${sha256}`
}

function safeStoragePath(value: string) {
  const result = String(value ?? '').trim().replaceAll('\\', '/')
  if (!/^objects\/[a-f0-9]{2}\/[a-f0-9]{64}$/u.test(result)) throw new Error('EXECUTION_ARTIFACT_STORAGE_PATH_INVALID')
  const sha256 = result.split('/').at(-1)!
  if (result.split('/')[1] !== sha256.slice(0, 2)) throw new Error('EXECUTION_ARTIFACT_STORAGE_PATH_INVALID')
  return result
}

function safeMimeType(value: string) {
  const result = String(value ?? '').trim().toLocaleLowerCase()
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:; ?[a-z0-9_-]+=[a-z0-9._-]+)*$/u.test(result) || result.length > 200) throw new Error('EXECUTION_ARTIFACT_MIME_INVALID')
  return result
}

function isSha256(value: string) {
  return /^[a-f0-9]{64}$/u.test(value)
}

function assertInside(root: string, target: string) {
  const base = resolve(root)
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error('EXECUTION_ARTIFACT_PATH_OUTSIDE_ROOT')
}

export function relativeExecutionArtifactPath(root: string, target: string) {
  const path = relative(resolve(root), resolve(target)).replaceAll('\\', '/')
  return safeStoragePath(path)
}
