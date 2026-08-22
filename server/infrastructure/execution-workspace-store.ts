import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ExecutionPackageFile } from '../domain/test-execution-types.js'

export type ExecutionBindingStatus = 'inherited' | 'validated' | 'needs_validation' | 'invalid'

/**
 * The only durable relationship the platform keeps between a formal Case and
 * automation code.  Dependencies below this entry remain a code/AST concern.
 */
export interface CaseExecutionBinding {
  projectVersionId: string
  caseId: string
  executionType: 'ui' | 'api'
  entryFile: string
  entrySymbol: string
  bindingStatus: ExecutionBindingStatus
  entrySha256: string
  caseContentSha256: string
  createdAt: string
  updatedAt: string
  inheritedFromProjectVersionId?: string
}

export interface ExecutionWorkspaceSnapshot {
  projectVersionId: string
  root: string
  contentSha256: string
  files: ExecutionPackageFile[]
}

/**
 * A ProjectVersion owns one writable automation project.  It deliberately
 * lives outside a Run: runs freeze revisions, while the workspace accumulates
 * reusable tests, page objects, fixtures and clients over time.
 */
export class LocalExecutionWorkspaceStore {
  constructor(private readonly root: string) {}

  async ensure(projectVersionId: string) {
    const workspace = this.workspaceRoot(projectVersionId)
    await Promise.all([
      ...['tests/ui', 'tests/api', 'pages', 'api', 'helpers', 'fixtures', 'data', 'config', 'artifacts', 'bindings']
        .map(directory => mkdir(join(workspace, directory), { recursive: true })),
    ])
    return workspace
  }

  async snapshot(projectVersionId: string): Promise<ExecutionWorkspaceSnapshot> {
    const root = await this.ensure(projectVersionId)
    const files = await this.readFiles(root)
    return { projectVersionId, root, files, contentSha256: sha256(JSON.stringify(files.map(file => [file.path, file.contentSha256]))) }
  }

  async resolveBinding(projectVersionId: string, caseId: string) {
    const root = await this.ensure(projectVersionId)
    const bindingPath = join(root, 'bindings', `${bindingName(caseId)}.json`)
    let binding: CaseExecutionBinding
    try {
      binding = JSON.parse(await readFile(bindingPath, 'utf8')) as CaseExecutionBinding
    } catch {
      return null
    }
    if (binding.projectVersionId !== projectVersionId || binding.caseId !== caseId) return null
    try {
      const source = await this.readWorkspaceFile(root, binding.entryFile)
      if (sha256(source) !== binding.entrySha256) return { ...binding, bindingStatus: 'invalid' as const }
      return binding
    } catch {
      return { ...binding, bindingStatus: 'invalid' as const }
    }
  }

  async readEntry(projectVersionId: string, binding: Pick<CaseExecutionBinding, 'entryFile'>) {
    return this.readWorkspaceFile(await this.ensure(projectVersionId), binding.entryFile)
  }

  async writeFiles(projectVersionId: string, files: readonly Pick<ExecutionPackageFile, 'path' | 'content'>[]) {
    const root = await this.ensure(projectVersionId)
    for (const file of files) {
      const path = safePath(file.path)
      const target = resolve(root, ...path.split('/'))
      assertInside(root, target)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.content, { encoding: 'utf8' })
    }
  }

  async saveBinding(binding: CaseExecutionBinding) {
    const root = await this.ensure(binding.projectVersionId)
    const safe = normalizeBinding(binding)
    const target = join(root, 'bindings', `${bindingName(safe.caseId)}.json`)
    const temporary = `${target}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(safe, null, 2), { encoding: 'utf8' })
    await rename(temporary, target)
    return safe
  }

  async inherit(sourceProjectVersionId: string, targetProjectVersionId: string) {
    const source = await this.ensure(sourceProjectVersionId)
    const target = this.workspaceRoot(targetProjectVersionId)
    await rm(target, { recursive: true, force: true })
    await cp(source, target, { recursive: true, force: false })
    const bindings = await this.bindingFiles(target)
    const inheritedAt = new Date().toISOString()
    for (const path of bindings) {
      const binding = JSON.parse(await readFile(path, 'utf8')) as CaseExecutionBinding
      await writeFile(path, JSON.stringify({
        ...binding,
        projectVersionId: targetProjectVersionId,
        bindingStatus: binding.entrySha256 ? 'needs_validation' : 'invalid',
        inheritedFromProjectVersionId: sourceProjectVersionId,
        updatedAt: inheritedAt,
      }, null, 2), { encoding: 'utf8' })
    }
    await this.ensure(targetProjectVersionId)
  }

  async remove(projectVersionId: string) {
    await rm(this.workspaceRoot(projectVersionId), { recursive: true, force: true })
  }

  private workspaceRoot(projectVersionId: string) {
    return join(this.root, safeIdentity(projectVersionId))
  }

  private async readFiles(root: string): Promise<ExecutionPackageFile[]> {
    const files: ExecutionPackageFile[] = []
    const pending = [root]
    while (pending.length) {
      const directory = pending.pop()!
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name)
        if (entry.isDirectory()) pending.push(absolute)
        else if (entry.isFile() && !relative(root, absolute).startsWith('bindings/')) {
          const content = await readFile(absolute, 'utf8')
          const path = relative(root, absolute).replaceAll('\\', '/')
          files.push({ path, content, contentSha256: sha256(content), size: Buffer.byteLength(content, 'utf8') })
        }
      }
    }
    return files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  }

  private async readWorkspaceFile(root: string, path: string) {
    const target = resolve(root, ...safePath(path).split('/'))
    assertInside(root, target)
    const metadata = await stat(target)
    if (!metadata.isFile()) throw new Error('TEST_EXECUTION_BINDING_ENTRY_MISSING')
    return await readFile(target, 'utf8')
  }

  private async bindingFiles(root: string) {
    const directory = join(root, 'bindings')
    return (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => join(directory, entry.name))
  }
}

function normalizeBinding(binding: CaseExecutionBinding): CaseExecutionBinding {
  const entryFile = safePath(binding.entryFile)
  if (!['ui', 'api'].includes(binding.executionType) || !binding.caseId || !binding.entrySymbol || !/^[a-f0-9]{64}$/u.test(binding.entrySha256) || !/^[a-f0-9]{64}$/u.test(binding.caseContentSha256)) {
    throw new Error('TEST_EXECUTION_BINDING_INVALID')
  }
  return { ...binding, entryFile }
}

function bindingName(caseId: string) { return sha256(caseId).slice(0, 32) }
function safeIdentity(value: string) {
  if (!/^[A-Za-z0-9._-]{1,200}$/u.test(value)) throw new Error('TEST_EXECUTION_WORKSPACE_IDENTITY_INVALID')
  return value
}
function safePath(value: string) {
  const path = String(value ?? '').trim().replaceAll('\\', '/')
  if (!path || path.startsWith('/') || /^[A-Za-z]:/u.test(path) || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*\u0000-\u001F]/u.test(part))) throw new Error('TEST_EXECUTION_WORKSPACE_PATH_INVALID')
  return path
}
function assertInside(root: string, target: string) {
  const result = relative(root, target)
  if (result === '' || result === '..' || result.startsWith('../') || result.startsWith('..\\') || isAbsolute(result)) throw new Error('TEST_EXECUTION_WORKSPACE_PATH_INVALID')
}
function sha256(value: string) { return createHash('sha256').update(value, 'utf8').digest('hex') }
