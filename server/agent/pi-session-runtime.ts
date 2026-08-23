import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { AgentSession, SessionManager } from '@earendil-works/pi-coding-agent'
import { SessionManager as PiSessionManager } from '@earendil-works/pi-coding-agent'
import type {
  AgentDefinitionVersion,
  AgentExecutionContext,
  AgentModelConnection,
} from '../domain/agent-types.js'

export type PiSessionRole = 'planning_parent' | 'reviewer' | 'execution_agent'

export interface PiSessionScope {
  role: PiSessionRole
  key: string
  parentKey?: string
}

export interface PiSessionLease {
  scope: PiSessionScope
  manager: SessionManager
  created: boolean
  parentSessionId?: string
  release(): void
}

export interface PersistedParentSessionBinding {
  scope: PiSessionScope
  model: Omit<AgentModelConnection, 'baseUrl' | 'apiKey'>
  agentDefinition: AgentDefinitionVersion
  systemPrompt: string
}

type LockState = {
  tail: Promise<void>
  waiting: number
}

export class PiSessionRuntime {
  private readonly locks = new Map<string, LockState>()
  private readonly managers = new Map<string, SessionManager>()
  private readonly sessionFiles = new Map<string, string>()
  private readonly activeSessions = new Map<string, AgentSession>()
  private readonly activeScopes = new Map<string, PiSessionScope>()
  private readonly contextSnapshots = new Map<string, AgentExecutionContext>()

  constructor(private readonly root?: string) {}

  static inMemory() {
    return new PiSessionRuntime()
  }

  scopeFor(input: {
    snapshot: {
      runId: string
      taskId?: string
      projectId: string
      projectVersionId: string
      agentDefinition: Pick<AgentDefinitionVersion, 'agentKey'>
      executionSessionKey?: string
    }
  }): PiSessionScope {
    if (input.snapshot.agentDefinition.agentKey === 'planning') {
      return {
        role: 'planning_parent',
        key: `planning:${input.snapshot.projectId}:${input.snapshot.projectVersionId}`,
      }
    }
    const taskId = input.snapshot.taskId
    if (!taskId) throw new Error('PI_EXECUTION_TASK_SCOPE_REQUIRED')
    const executionSessionKey = input.snapshot.executionSessionKey
    if (!executionSessionKey) throw new Error('PI_EXECUTION_SESSION_SCOPE_REQUIRED')
    return {
      role: 'execution_agent',
      key: executionSessionKey,
    }
  }

  reviewerScope(parent: PiSessionScope, reviewerType: string, runId: string): PiSessionScope {
    return {
      role: 'reviewer',
      key: `reviewer:${reviewerType}:${runId}`,
      parentKey: parent.key,
    }
  }

  async acquire(scope: PiSessionScope): Promise<PiSessionLease> {
    const unlock = await this.lock(scope.key)
    try {
      if (scope.parentKey) this.manager(parentScope(scope.parentKey))
      return this.lease(scope, unlock)
    } catch (error) {
      unlock()
      throw error
    }
  }

  async acquireIdle(scope: PiSessionScope): Promise<PiSessionLease> {
    if (this.activeSessions.has(scope.key) || this.locks.has(scope.key)) {
      throw new Error('PI_SESSION_BUSY')
    }
    const unlock = await this.lock(scope.key)
    return this.lease(scope, unlock)
  }

  bindActive(scope: PiSessionScope, session: AgentSession) {
    this.activeSessions.set(scope.key, session)
    this.activeScopes.set(scope.key, scope)
    return () => {
      if (this.activeSessions.get(scope.key) === session) {
        this.activeSessions.delete(scope.key)
        this.activeScopes.delete(scope.key)
      }
    }
  }

  active(scopeKey: string) {
    const session = this.activeSessions.get(scopeKey)
    const scope = this.activeScopes.get(scopeKey)
    return session && scope ? { session, scope } : undefined
  }

  rememberContext(scopeKey: string, context: AgentExecutionContext) {
    const snapshot = structuredClone(context)
    this.contextSnapshots.set(scopeKey, snapshot)
    const manager = this.managers.get(scopeKey)
    if (manager) {
      manager.appendCustomEntry('smarthub_context_snapshot', snapshot)
    }
  }

  context(scopeKey: string) {
    const cached = this.contextSnapshots.get(scopeKey)
    if (cached) return structuredClone(cached)
    const restored = this.customEntry(scopeKey, 'smarthub_context_snapshot')
    const value = validateContextSnapshot(restored)
    if (value) this.contextSnapshots.set(scopeKey, value)
    return value ? structuredClone(value) : undefined
  }

  rememberParentBinding(binding: PersistedParentSessionBinding) {
    const manager = this.manager(binding.scope)
    manager.appendCustomEntry(
      'smarthub_parent_runtime_binding',
      structuredClone(binding),
    )
  }

  parentBinding(scopeKey: string) {
    return validateParentBinding(
      this.customEntry(scopeKey, 'smarthub_parent_runtime_binding'),
      scopeKey,
    )
  }

  private customEntry(scopeKey: string, customType: string) {
    const manager = this.manager(parentScope(scopeKey))
    const restored = [...manager.getEntries()].reverse().find(
      entry => entry.type === 'custom'
        && entry.customType === customType,
    )
    return restored?.type === 'custom' ? restored.data : undefined
  }

  private lease(scope: PiSessionScope, unlock: () => void): PiSessionLease {
    try {
      const manager = this.manager(scope)
      const created = manager.getEntries().length === 0
      const parentSessionId = scope.parentKey
        ? this.managers.get(scope.parentKey)?.getSessionId()
        : undefined
      return {
        scope,
        manager,
        created,
        ...(parentSessionId ? { parentSessionId } : {}),
        release: unlock,
      }
    } catch (error) {
      unlock()
      throw error
    }
  }

  private manager(scope: PiSessionScope) {
    if (scope.role === 'reviewer' || !this.root) {
      const existing = this.managers.get(scope.key)
      if (existing) return existing
      const parentSession = scope.parentKey
        ? this.managers.get(scope.parentKey)?.getSessionFile()
        : undefined
      const manager = PiSessionManager.inMemory('/workspace', {
        ...(parentSession ? { parentSession } : {}),
      })
      this.managers.set(scope.key, manager)
      return manager
    }

    const existing = this.managers.get(scope.key)
    if (existing) return existing
    const existingFile = this.sessionFiles.get(scope.key)
    const directory = resolve(this.root, scope.role, scopeHash(scope.key))
    const manager = existingFile
      ? PiSessionManager.open(existingFile, directory, '/workspace')
      : PiSessionManager.continueRecent('/workspace', directory)
    this.managers.set(scope.key, manager)
    const sessionFile = manager.getSessionFile()
    if (sessionFile) this.sessionFiles.set(scope.key, sessionFile)
    return manager
  }

  private async lock(key: string) {
    const current = this.locks.get(key) ?? { tail: Promise.resolve(), waiting: 0 }
    const previous = current.tail
    let releaseGate!: () => void
    const gate = new Promise<void>(resolveGate => { releaseGate = resolveGate })
    current.tail = previous.then(() => gate)
    current.waiting += 1
    this.locks.set(key, current)
    await previous
    let released = false
    return () => {
      if (released) return
      released = true
      current.waiting -= 1
      releaseGate()
      if (current.waiting === 0 && this.locks.get(key) === current) this.locks.delete(key)
    }
  }
}

function scopeHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function parentScope(key: string): PiSessionScope {
  return { role: 'planning_parent', key }
}

function validateContextSnapshot(value: unknown): AgentExecutionContext | undefined {
  if (!value || typeof value !== 'object') return undefined
  const snapshot = value as Partial<AgentExecutionContext>
  return typeof snapshot.sessionId === 'string'
    && snapshot.sessionRole === 'planning_parent'
    && typeof snapshot.contextWindow === 'number'
    && (typeof snapshot.currentTokens === 'number' || snapshot.currentTokens === null)
    && (typeof snapshot.usagePercent === 'number' || snapshot.usagePercent === null)
    && typeof snapshot.compactionCount === 'number'
    && typeof snapshot.totalMessages === 'number'
    && typeof snapshot.autoCompactionEnabled === 'boolean'
    ? structuredClone(snapshot as AgentExecutionContext)
    : undefined
}

function validateParentBinding(
  value: unknown,
  scopeKey: string,
): PersistedParentSessionBinding | undefined {
  if (!value || typeof value !== 'object') return undefined
  const binding = value as Partial<PersistedParentSessionBinding>
  const model = binding.model
  const definition = binding.agentDefinition
  return binding.scope?.role === 'planning_parent'
    && binding.scope.key === scopeKey
    && typeof binding.systemPrompt === 'string'
    && model != null
    && typeof model.sourceId === 'string'
    && typeof model.providerType === 'string'
    && typeof model.modelId === 'string'
    && typeof model.modelName === 'string'
    && typeof model.contextWindow === 'number'
    && typeof model.maxOutputTokens === 'number'
    && typeof model.supportsReasoning === 'boolean'
    && definition != null
    && definition.agentKey === 'planning'
    ? structuredClone(binding as PersistedParentSessionBinding)
    : undefined
}
