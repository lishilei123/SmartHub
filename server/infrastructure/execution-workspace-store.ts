import { createHash, randomUUID } from 'node:crypto'
import { chmod, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  RuntimeApiAuthorization,
  RuntimeAuthStateAccess,
  RuntimeAuthStateScope,
} from '../application/test-execution-auth-session.js'
import {
  assertSafeExplorationResult,
  explorationContextKey,
} from '../application/test-execution-exploration.js'
import {
  assertExecutionBindingEntry,
  executionEntrySymbol,
  executionEntrySourceSha256,
} from '../application/test-execution-validation.js'
import type {
  ExecutionPackageFile,
  ProjectVersionExplorationResult,
} from '../domain/test-execution-types.js'

export type ExecutionBindingStatus = 'inherited' | 'validated' | 'needs_validation' | 'invalid'

/**
 * The only durable relationship the platform keeps between a formal Case and
 * automation code. Dependencies remain a code/AST concern; their paths and
 * hashes are frozen only to detect closure drift, never as separate bindings.
 */
export interface CaseExecutionBinding {
  projectVersionId: string
  caseId: string
  executionType: 'ui' | 'api'
  entryFile: string
  entrySymbol: string
  bindingStatus: ExecutionBindingStatus
  entrySha256: string
  dependencyFiles: Array<Pick<ExecutionPackageFile, 'path' | 'contentSha256'>>
  dependencySha256: string
  caseContentSha256: string
  /** Validator policy that admitted this implementation. Missing means legacy. */
  validationPolicyVersion?: 'execution-binding-validation/v2' | 'execution-binding-validation/v3' | 'execution-binding-validation/v4' | 'execution-binding-validation/v5' | 'execution-binding-validation/v6' | 'execution-binding-validation/v7' | 'execution-binding-validation/v8' | 'execution-binding-validation/v9' | 'execution-binding-validation/v10'
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
  private readonly mutationTails = new Map<string, Promise<void>>()

  constructor(private readonly root: string) {}

  async ensure(projectVersionId: string) {
    const workspace = this.workspaceRoot(projectVersionId)
    await Promise.all([
      ...['tests/ui', 'tests/api', 'pages', 'api', 'helpers', 'fixtures', 'data', 'config', 'artifacts', 'bindings', 'exploration']
        .map(directory => mkdir(join(workspace, directory), { recursive: true })),
    ])
    return workspace
  }

  async snapshot(projectVersionId: string): Promise<ExecutionWorkspaceSnapshot> {
    const root = await this.ensure(projectVersionId)
    const files = await this.readFiles(root)
    return { projectVersionId, root, files, contentSha256: sha256(JSON.stringify(files.map(file => [file.path, file.contentSha256]))) }
  }

  async resolveBinding(
    projectVersionId: string,
    caseId: string,
    executionType: CaseExecutionBinding['executionType'],
  ) {
    const root = await this.ensure(projectVersionId)
    const resolved = await this.readBinding(root, projectVersionId, caseId, executionType)
    if (!resolved) return null
    let { binding } = resolved
    try {
      binding = normalizeBinding(binding)
      if (resolved.legacyPath) {
        await this.migrateLegacyBinding(root, binding, resolved.legacyPath)
      }
      const dependencies = await Promise.all(binding.dependencyFiles.map(async file => ({
        path: file.path,
        contentSha256: sha256(await this.readWorkspaceFile(root, file.path)),
      })))
      const source = await this.readWorkspaceFile(root, binding.entryFile)
      assertExecutionBindingEntry(source, binding.caseId, binding.entrySymbol)
      if (
        !dependencies.some(file => file.path === binding.entryFile && file.contentSha256 === binding.entrySha256)
        || dependencies.some((file, index) => file.contentSha256 !== binding.dependencyFiles[index].contentSha256)
        || executionBindingDependencySha256(dependencies) !== binding.dependencySha256
      ) return await this.persistBindingStatus(binding, 'invalid')
      return binding
    } catch {
      try {
        return await this.persistBindingStatus(binding, 'invalid')
      } catch {
        return { ...binding, bindingStatus: 'invalid' as const }
      }
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

  /**
   * Writes one Case implementation without allowing it to mutate files frozen
   * by another Case Binding. Identical shared dependencies remain reusable.
   */
  async writeBindingFiles(
    projectVersionId: string,
    caseId: string,
    executionType: CaseExecutionBinding['executionType'],
    files: readonly Pick<ExecutionPackageFile, 'path' | 'content'>[],
  ) {
    const root = await this.ensure(projectVersionId)
    const candidates = new Map(files.map(file => {
      const path = safePath(file.path)
      return [path, sha256(file.content)] as const
    }))
    for (const bindingPath of await this.bindingFiles(root)) {
      let binding: CaseExecutionBinding
      try {
        binding = normalizeBinding(JSON.parse(await readFile(bindingPath, 'utf8')) as CaseExecutionBinding)
      } catch {
        continue
      }
      if (
        binding.projectVersionId !== projectVersionId
        || binding.caseId === caseId && binding.executionType === executionType
      ) continue
      for (const dependency of binding.dependencyFiles) {
        const candidateSha256 = candidates.get(dependency.path)
        if (candidateSha256 && candidateSha256 !== dependency.contentSha256) {
          throw new Error(`TEST_EXECUTION_WORKSPACE_FILE_OWNERSHIP_CONFLICT: ${dependency.path}`)
        }
      }
    }
    await this.writeFiles(projectVersionId, files)
  }

  async saveBinding(binding: CaseExecutionBinding) {
    const root = await this.ensure(binding.projectVersionId)
    const safe = normalizeBinding(binding)
    await this.writeBinding(root, safe)
    await this.removeMatchingLegacyBinding(root, safe)
    return safe
  }

  /**
   * Serializes the ownership check, workspace write and Binding publication for
   * one ProjectVersion. Concurrent Agent tasks may generate independently, but
   * they cannot race while publishing files into the shared durable workspace.
   */
  async saveBindingImplementation(
    binding: CaseExecutionBinding,
    files: readonly Pick<ExecutionPackageFile, 'path' | 'content'>[],
    baselineFiles?: readonly Pick<ExecutionPackageFile, 'path' | 'contentSha256'>[],
  ) {
    return this.withMutation(binding.projectVersionId, async () => {
      const root = await this.ensure(binding.projectVersionId)
      const safeBinding = normalizeBinding(binding)
      const candidates = new Map(files.map(file => {
        const path = safePath(file.path)
        return [path, { content: file.content, contentSha256: sha256(file.content) }] as const
      }))
      if (candidates.size !== files.length) {
        throw new Error('TEST_EXECUTION_WORKSPACE_FILE_DUPLICATE')
      }
      if (baselineFiles) {
        await this.assertWorkspaceBaseline(root, candidates.keys(), baselineFiles)
      }

      const otherBindings: CaseExecutionBinding[] = []
      for (const bindingPath of await this.bindingFiles(root)) {
        try {
          const existing = normalizeBinding(
            JSON.parse(await readFile(bindingPath, 'utf8')) as CaseExecutionBinding,
          )
          if (
            existing.projectVersionId === safeBinding.projectVersionId
            && (
              existing.caseId !== safeBinding.caseId
              || existing.executionType !== safeBinding.executionType
            )
          ) otherBindings.push(existing)
        } catch {
          // Invalid historical Binding files remain isolated from publication.
        }
      }

      const affected = otherBindings.filter(existing =>
        existing.dependencyFiles.some(file => {
          const candidate = candidates.get(file.path)
          return candidate && candidate.contentSha256 !== file.contentSha256
        }))
      for (const existing of affected) {
        const replacement = candidates.get(existing.entryFile)
        if (!replacement) continue
        const current = await this.readWorkspaceFile(root, existing.entryFile)
        try {
          assertExecutionBindingEntry(replacement.content, existing.caseId, existing.entrySymbol)
          if (
            executionEntrySourceSha256(current, existing.caseId)
            !== executionEntrySourceSha256(replacement.content, existing.caseId)
          ) throw new Error('TEST_EXECUTION_WORKSPACE_SHARED_ENTRY_MUTATION')
        } catch (cause) {
          throw new Error(
            `TEST_EXECUTION_WORKSPACE_SHARED_ENTRY_CONFLICT: ${existing.entryFile}`,
            { cause },
          )
        }
      }

      await this.writeFiles(binding.projectVersionId, files)
      const updatedAt = new Date().toISOString()
      for (const existing of affected) {
        const dependencyFiles = existing.entryFile === safeBinding.entryFile
          ? safeBinding.dependencyFiles
          : existing.dependencyFiles.map(file => {
              const replacement = candidates.get(file.path)
              return replacement
                ? { path: file.path, contentSha256: replacement.contentSha256 }
                : file
            })
        await this.saveBinding({
          ...existing,
          entrySha256: candidates.get(existing.entryFile)?.contentSha256 ?? existing.entrySha256,
          dependencyFiles,
          dependencySha256: executionBindingDependencySha256(dependencyFiles),
          bindingStatus: existing.bindingStatus === 'invalid' ? 'invalid' : 'needs_validation',
          updatedAt,
        })
      }
      return this.saveBinding(safeBinding)
    })
  }

  async setBindingStatus(
    projectVersionId: string,
    caseId: string,
    executionType: CaseExecutionBinding['executionType'],
    status: ExecutionBindingStatus,
  ) {
    const root = await this.ensure(projectVersionId)
    const resolved = await this.readBinding(root, projectVersionId, caseId, executionType)
    if (!resolved) throw new Error('TEST_EXECUTION_BINDING_SCOPE_INVALID')
    const binding = normalizeBinding(resolved.binding)
    if (resolved.legacyPath) {
      await this.migrateLegacyBinding(root, binding, resolved.legacyPath)
    }
    return this.persistBindingStatus(binding, status)
  }

  /** Run-scoped, non-versioned state used only by Playwright fixtures. */
  async runtimeAuthRoot(projectVersionId: string, runId: string) {
    const workspace = await this.ensure(projectVersionId)
    const root = join(workspace, '.runtime-auth', safeIdentity(runId))
    await mkdir(root, { recursive: true, mode: 0o700 })
    return root
  }

  async runtimeAuthStateAccess(
    scope: RuntimeAuthStateScope,
    options: { writable: boolean },
  ): Promise<RuntimeAuthStateAccess> {
    const root = await this.runtimeAuthRoot(scope.projectVersionId, scope.runId)
    const stateKey = safeIdentity(scope.stateKey)
    const statePath = join(root, `${stateKey}.json`)
    const metadataPath = join(root, `.${stateKey}.scope.json`)
    const expected = runtimeAuthMetadata(scope)
    let loadPath: string | undefined
    try {
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as RuntimeAuthStateMetadata
      if (!sameRuntimeAuthMetadata(metadata, expected)) throw new Error('TEST_EXECUTION_RUNTIME_AUTH_SCOPE_INVALID')
      await assertRuntimeAuthState(statePath, scope.baseUrl)
      loadPath = statePath
    } catch {
      loadPath = undefined
    }

    if (!options.writable) return loadPath ? { loadPath } : {}
    const savePath = join(root, `.${stateKey}.${randomUUID()}.pending.json`)
    let committed = false
    return {
      ...(loadPath ? { loadPath } : {}),
      savePath,
      commit: async () => {
        if (committed) return
        await assertRuntimeAuthState(savePath, scope.baseUrl)
        await chmod(savePath, 0o600).catch(() => undefined)
        const temporaryMetadata = `${metadataPath}.${randomUUID()}.tmp`
        await writeFile(temporaryMetadata, JSON.stringify(expected, null, 2), {
          encoding: 'utf8',
          mode: 0o600,
        })
        try {
          await rename(savePath, statePath)
          await rename(temporaryMetadata, metadataPath)
          committed = true
        } finally {
          await rm(temporaryMetadata, { force: true }).catch(() => undefined)
          await rm(savePath, { force: true }).catch(() => undefined)
        }
      },
      discard: async () => {
        if (!committed) await rm(savePath, { force: true })
      },
    }
  }

  async runtimeApiAuthorization(
    statePath: string,
    baseUrl: string,
  ): Promise<RuntimeApiAuthorization | undefined> {
    const source = await readFile(statePath, 'utf8')
    const state = JSON.parse(source) as {
      cookies?: unknown[]
      origins?: Array<{
        origin?: unknown
        localStorage?: Array<{ name?: unknown; value?: unknown }>
      }>
    }
    if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
      throw new Error('TEST_EXECUTION_RUNTIME_AUTH_STATE_INVALID')
    }
    const origin = new URL(baseUrl).origin
    const originState = state.origins.find(value => String(value.origin ?? '') === origin)
    const candidates = (originState?.localStorage ?? []).filter(value =>
      typeof value.name === 'string'
      && typeof value.value === 'string'
      && value.value.length > 0
      && value.value.length <= 64 * 1024
      && /(?:^|[_-])(?:access[_-]?)?(?:auth[_-]?)?token$/iu.test(value.name))
    if (candidates.length === 0 && state.cookies.length) return undefined
    if (candidates.length !== 1) {
      throw new Error('TEST_EXECUTION_API_AUTHORIZATION_BRIDGE_UNAVAILABLE')
    }
    return {
      kind: 'bearer_local_storage',
      origin,
      localStorageKey: String(candidates[0].name),
    }
  }

  async cleanupRuntimeAuth(projectVersionId: string, runId: string) {
    const workspace = this.workspaceRoot(projectVersionId)
    const root = join(workspace, '.runtime-auth', safeIdentity(runId))
    assertInside(workspace, root)
    await rm(root, { recursive: true, force: true })
  }

  async listExplorationResults(projectVersionId: string) {
    const root = await this.ensure(projectVersionId)
    const files = await this.explorationFiles(root)
    const results: ProjectVersionExplorationResult[] = []
    for (const path of files) {
      const result = assertSafeExplorationResult(
        JSON.parse(await readFile(path, 'utf8')) as ProjectVersionExplorationResult,
      )
      if (result.projectVersionId !== projectVersionId) {
        throw new Error('TEST_EXECUTION_EXPLORATION_PROJECT_VERSION_SCOPE_INVALID')
      }
      results.push(result)
    }
    return results.sort((left, right) =>
      right.observedAt.localeCompare(left.observedAt)
      || left.method.localeCompare(right.method, 'en')
      || left.path.localeCompare(right.path, 'en'))
  }

  async saveExplorationResults(
    projectVersionId: string,
    values: readonly ProjectVersionExplorationResult[],
  ) {
    if (values.length > 100) throw new Error('TEST_EXECUTION_EXPLORATION_BATCH_TOO_LARGE')
    const root = await this.ensure(projectVersionId)
    const existingCount = (await this.explorationFiles(root)).length
    if (existingCount + values.length > 1_000) throw new Error('TEST_EXECUTION_EXPLORATION_CONTEXT_TOO_LARGE')
    const saved: ProjectVersionExplorationResult[] = []
    for (const value of values) {
      const safe = assertSafeExplorationResult(value)
      if (safe.projectVersionId !== projectVersionId) {
        throw new Error('TEST_EXECUTION_EXPLORATION_PROJECT_VERSION_SCOPE_INVALID')
      }
      const target = join(root, 'exploration', `${explorationName(safe)}.json`)
      let existing: ProjectVersionExplorationResult | undefined
      try {
        existing = assertSafeExplorationResult(
          JSON.parse(await readFile(target, 'utf8')) as ProjectVersionExplorationResult,
        )
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      const merged = assertSafeExplorationResult({
        ...safe,
        createdAt: existing?.createdAt ?? safe.createdAt,
      })
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(merged, null, 2), { encoding: 'utf8' })
      await rename(temporary, target)
      saved.push(merged)
    }
    return saved
  }

  async inherit(sourceProjectVersionId: string, targetProjectVersionId: string) {
    const source = await this.ensure(sourceProjectVersionId)
    const target = this.workspaceRoot(targetProjectVersionId)
    await rm(target, { recursive: true, force: true })
    await cp(source, target, { recursive: true, force: false })
    // Cookies and tokens are runtime state, never inherited version assets.
    await rm(join(target, '.runtime-auth'), { recursive: true, force: true })
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
    const explorations = await this.explorationFiles(target)
    for (const path of explorations) {
      const sourceResult = assertSafeExplorationResult(
        JSON.parse(await readFile(path, 'utf8')) as ProjectVersionExplorationResult,
      )
      const inherited = assertSafeExplorationResult({
        ...sourceResult,
        id: `exploration_${sha256(`${targetProjectVersionId}\u0000${explorationContextKey(sourceResult, sourceResult.environmentSignature)}`).slice(0, 40)}`,
        projectVersionId: targetProjectVersionId,
        validationStatus: sourceResult.validationStatus === 'invalid' ? 'invalid' : 'needs_validation',
        inheritedFromProjectVersionId: sourceProjectVersionId,
        inheritedFromExplorationId: sourceResult.id,
        updatedAt: inheritedAt,
      })
      await writeFile(path, JSON.stringify(inherited, null, 2), { encoding: 'utf8' })
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
        const path = relative(root, absolute).replaceAll('\\', '/')
        if (entry.isDirectory()) {
          if (path === '.runtime-auth' || path.startsWith('.runtime-auth/')) continue
          pending.push(absolute)
        }
        else if (entry.isFile()) {
          if (['bindings/', 'exploration/', '.runtime-auth/'].some(prefix => path.startsWith(prefix))) continue
          const content = await readFile(absolute, 'utf8')
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

  private async assertWorkspaceBaseline(
    root: string,
    candidatePaths: Iterable<string>,
    baselineFiles: readonly Pick<ExecutionPackageFile, 'path' | 'contentSha256'>[],
  ) {
    const baseline = new Map(baselineFiles.map(file => [safePath(file.path), file.contentSha256]))
    for (const path of candidatePaths) {
      const expected = baseline.get(path)
      let actual: string | undefined
      try {
        actual = sha256(await this.readWorkspaceFile(root, path))
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      if (actual !== expected) {
        throw new Error(`TEST_EXECUTION_WORKSPACE_REVISION_CONFLICT: ${path}`)
      }
    }
  }

  private async bindingFiles(root: string) {
    const directory = join(root, 'bindings')
    return (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => join(directory, entry.name))
  }

  private async readBinding(
    root: string,
    projectVersionId: string,
    caseId: string,
    executionType: CaseExecutionBinding['executionType'],
  ): Promise<{ binding: CaseExecutionBinding; legacyPath?: string } | null> {
    const currentPath = join(root, 'bindings', `${bindingName(caseId, executionType)}.json`)
    const legacyPath = join(root, 'bindings', `${legacyBindingName(caseId)}.json`)
    for (const path of [currentPath, legacyPath]) {
      let binding: CaseExecutionBinding
      try {
        binding = JSON.parse(await readFile(path, 'utf8')) as CaseExecutionBinding
      } catch {
        continue
      }
      if (
        binding.projectVersionId !== projectVersionId
        || binding.caseId !== caseId
        || binding.executionType !== executionType
      ) continue
      return {
        binding,
        ...(path === legacyPath ? { legacyPath } : {}),
      }
    }
    return null
  }

  private async writeBinding(root: string, binding: CaseExecutionBinding) {
    const target = join(
      root,
      'bindings',
      `${bindingName(binding.caseId, binding.executionType)}.json`,
    )
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(binding, null, 2), { encoding: 'utf8' })
    await rename(temporary, target)
  }

  private async migrateLegacyBinding(
    root: string,
    binding: CaseExecutionBinding,
    legacyPath: string,
  ) {
    await this.withMutation(binding.projectVersionId, async () => {
      await this.writeBinding(root, binding)
      await rm(legacyPath, { force: true })
    })
  }

  private async removeMatchingLegacyBinding(
    root: string,
    binding: CaseExecutionBinding,
  ) {
    const legacyPath = join(root, 'bindings', `${legacyBindingName(binding.caseId)}.json`)
    try {
      const legacy = normalizeBinding(
        JSON.parse(await readFile(legacyPath, 'utf8')) as CaseExecutionBinding,
      )
      if (
        legacy.projectVersionId === binding.projectVersionId
        && legacy.caseId === binding.caseId
        && legacy.executionType === binding.executionType
      ) await rm(legacyPath, { force: true })
    } catch {
      // A missing, malformed or other-method legacy Binding remains isolated.
    }
  }

  private async explorationFiles(root: string) {
    const directory = join(root, 'exploration')
    return (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => join(directory, entry.name))
      .sort((left, right) => left.localeCompare(right, 'en'))
  }

  private async persistBindingStatus(
    binding: CaseExecutionBinding,
    status: ExecutionBindingStatus,
  ) {
    if (binding.bindingStatus === status) return binding
    return this.saveBinding({
      ...binding,
      bindingStatus: status,
      updatedAt: new Date().toISOString(),
    })
  }

  private async withMutation<T>(
    projectVersionId: string,
    operation: () => Promise<T>,
  ) {
    const previous = this.mutationTails.get(projectVersionId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolveCurrent => { release = resolveCurrent })
    const tail = previous.then(() => current)
    this.mutationTails.set(projectVersionId, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.mutationTails.get(projectVersionId) === tail) {
        this.mutationTails.delete(projectVersionId)
      }
    }
  }
}

function normalizeBinding(binding: CaseExecutionBinding): CaseExecutionBinding {
  const entryFile = safePath(binding.entryFile)
  if (!Array.isArray(binding.dependencyFiles)) {
    throw new Error('TEST_EXECUTION_BINDING_INVALID')
  }
  const dependencyFiles = binding.dependencyFiles
    .map(file => ({ path: safePath(file.path), contentSha256: file.contentSha256 }))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'))
  if (
    !['ui', 'api'].includes(binding.executionType)
    || !binding.caseId
    || binding.entrySymbol !== executionEntrySymbol(binding.caseId)
    || !/^[a-f0-9]{64}$/u.test(binding.entrySha256)
    || !/^[a-f0-9]{64}$/u.test(binding.caseContentSha256)
    || binding.validationPolicyVersion !== undefined
      && ![
        'execution-binding-validation/v2',
        'execution-binding-validation/v3',
        'execution-binding-validation/v4',
        'execution-binding-validation/v5',
        'execution-binding-validation/v6',
        'execution-binding-validation/v7',
        'execution-binding-validation/v8',
        'execution-binding-validation/v9',
        'execution-binding-validation/v10',
      ].includes(binding.validationPolicyVersion)
    || !dependencyFiles.length
    || new Set(dependencyFiles.map(file => file.path.toLocaleLowerCase())).size !== dependencyFiles.length
    || dependencyFiles.some(file => !/^[a-f0-9]{64}$/u.test(file.contentSha256))
    || !dependencyFiles.some(file => file.path === entryFile && file.contentSha256 === binding.entrySha256)
    || executionBindingDependencySha256(dependencyFiles) !== binding.dependencySha256
  ) {
    throw new Error('TEST_EXECUTION_BINDING_INVALID')
  }
  return {
    ...binding,
    entryFile,
    dependencyFiles,
    dependencySha256: executionBindingDependencySha256(dependencyFiles),
  }
}

export function executionBindingDependencySha256(
  files: readonly Pick<ExecutionPackageFile, 'path' | 'contentSha256'>[],
) {
  return sha256(JSON.stringify(files.map(file => [file.path, file.contentSha256])))
}

function bindingName(caseId: string, executionType: CaseExecutionBinding['executionType']) {
  return sha256(`${caseId}\u0000${executionType}`).slice(0, 32)
}
function legacyBindingName(caseId: string) { return sha256(caseId).slice(0, 32) }
function explorationName(result: ProjectVersionExplorationResult) {
  return explorationContextKey(result, result.environmentSignature).slice(0, 48)
}
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

interface RuntimeAuthStateMetadata {
  schemaVersion: 'runtime-auth-scope/v1'
  projectVersionId: string
  runId: string
  environmentSignature: string
  origin: string
  role: string
  stateKey: string
}

function runtimeAuthMetadata(scope: RuntimeAuthStateScope): RuntimeAuthStateMetadata {
  return {
    schemaVersion: 'runtime-auth-scope/v1',
    projectVersionId: scope.projectVersionId,
    runId: scope.runId,
    environmentSignature: scope.environmentSignature,
    origin: new URL(scope.baseUrl).origin,
    role: scope.role,
    stateKey: scope.stateKey,
  }
}

function sameRuntimeAuthMetadata(left: RuntimeAuthStateMetadata, right: RuntimeAuthStateMetadata) {
  return left.schemaVersion === right.schemaVersion
    && left.projectVersionId === right.projectVersionId
    && left.runId === right.runId
    && left.environmentSignature === right.environmentSignature
    && left.origin === right.origin
    && left.role === right.role
    && left.stateKey === right.stateKey
}

async function assertRuntimeAuthState(path: string, baseUrl: string) {
  const source = await readFile(path, 'utf8')
  if (!source || Buffer.byteLength(source, 'utf8') > 5 * 1024 * 1024) {
    throw new Error('TEST_EXECUTION_RUNTIME_AUTH_STATE_INVALID')
  }
  const state = JSON.parse(source) as {
    cookies?: Array<{ domain?: unknown }>
    origins?: Array<{ origin?: unknown; localStorage?: unknown }>
  }
  if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
    throw new Error('TEST_EXECUTION_RUNTIME_AUTH_STATE_INVALID')
  }
  if (state.cookies.length > 1_000 || state.origins.length > 100) {
    throw new Error('TEST_EXECUTION_RUNTIME_AUTH_STATE_INVALID')
  }
  const base = new URL(baseUrl)
  for (const cookie of state.cookies) {
    const domain = String(cookie.domain ?? '').replace(/^\./u, '').toLocaleLowerCase()
    const host = base.hostname.toLocaleLowerCase()
    if (!domain || host !== domain && !host.endsWith(`.${domain}`)) {
      throw new Error('TEST_EXECUTION_RUNTIME_AUTH_ORIGIN_INVALID')
    }
  }
  for (const originState of state.origins) {
    if (String(originState.origin ?? '') !== base.origin || !Array.isArray(originState.localStorage)) {
      throw new Error('TEST_EXECUTION_RUNTIME_AUTH_ORIGIN_INVALID')
    }
  }
}
