import { randomUUID } from 'node:crypto'
import type {
  AgentUnderTest,
  AgentUnderTestAuthenticationConfig,
  AgentUnderTestRequestMapping,
  AgentUnderTestResponseMapping,
  AgentUnderTestVersion,
  FrozenAgentUnderTestSnapshot,
} from '../domain/agent-test-types.js'
import type { StateStore } from '../infrastructure/store.js'
import { canonicalSha256 } from './canonical-json.js'

export interface AgentUnderTestInput {
  name: string
  description?: string
  endpoint: string
  protocol: 'http' | 'sse'
  authenticationConfig?: AgentUnderTestAuthenticationConfig
  requestMapping?: Partial<AgentUnderTestRequestMapping>
  responseMapping?: Partial<AgentUnderTestResponseMapping>
  documentationRefs?: string[]
  enabled?: boolean
}

export class AgentUnderTestServiceError extends Error {
  constructor(readonly code: string, message: string, readonly status = 422, readonly details?: unknown) {
    super(message)
  }
}

export class AgentUnderTestService {
  constructor(
    private readonly store: StateStore,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async list(projectVersionId: string) {
    const state = await this.store.snapshot()
    requireProjectVersion(state, projectVersionId)
    return state.agentUnderTests
      .filter(item => item.projectVersionId === projectVersionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(presentAgentUnderTest)
  }

  async get(id: string) {
    const state = await this.store.snapshot()
    return presentAgentUnderTest(requiredAgent(state.agentUnderTests, id))
  }

  async create(projectVersionId: string, raw: AgentUnderTestInput, createdBy: string) {
    const input = normalizeInput(raw)
    const now = this.clock()
    return await this.store.transaction(state => {
      const projectVersion = requireProjectVersion(state, projectVersionId)
      if (state.agentUnderTests.some(item => item.projectVersionId === projectVersionId && item.name.toLocaleLowerCase() === input.name.toLocaleLowerCase())) {
        throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_NAME_CONFLICT', '当前 ProjectVersion 已存在同名被测 Agent', 409)
      }
      const version = createVersion(1, input, createdBy, now)
      const value: AgentUnderTest = {
        id: `aut_${randomUUID()}`,
        projectId: projectVersion.projectId,
        projectVersionId,
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        enabled: input.enabled,
        currentVersion: 1,
        versions: [version],
        createdAt: now,
        updatedAt: now,
      }
      state.agentUnderTests.push(value)
      return presentAgentUnderTest(value)
    })
  }

  async update(id: string, expectedVersion: number, raw: AgentUnderTestInput, updatedBy: string) {
    const input = normalizeInput(raw)
    const now = this.clock()
    return await this.store.transaction(state => {
      const current = requiredAgent(state.agentUnderTests, id)
      if (current.currentVersion !== expectedVersion) {
        throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_VERSION_CONFLICT', '被测 Agent 配置已更新，请刷新后重试', 409)
      }
      if (state.agentUnderTests.some(item => item.id !== id && item.projectVersionId === current.projectVersionId && item.name.toLocaleLowerCase() === input.name.toLocaleLowerCase())) {
        throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_NAME_CONFLICT', '当前 ProjectVersion 已存在同名被测 Agent', 409)
      }
      const version = createVersion(current.currentVersion + 1, input, updatedBy, now)
      current.name = input.name
      current.description = input.description
      current.enabled = input.enabled
      current.currentVersion = version.version
      current.versions.push(version)
      current.updatedAt = now
      return presentAgentUnderTest(current)
    })
  }

  async freeze(projectVersionId: string, id: string): Promise<FrozenAgentUnderTestSnapshot> {
    const state = await this.store.snapshot()
    const value = requiredAgent(state.agentUnderTests, id)
    if (value.projectVersionId !== projectVersionId) {
      throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_SCOPE_MISMATCH', '被测 Agent 不属于当前 ProjectVersion')
    }
    if (!value.enabled) throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_DISABLED', '被测 Agent 已停用')
    const version = currentVersion(value)
    return frozenSnapshot(value, version)
  }

  async resolveVersion(snapshot: FrozenAgentUnderTestSnapshot) {
    const state = await this.store.snapshot()
    const value = requiredAgent(state.agentUnderTests, snapshot.id)
    const version = value.versions.find(item => item.version === snapshot.version)
    if (!version || version.configurationSha256 !== snapshot.configurationSha256) {
      throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_SNAPSHOT_UNAVAILABLE', '冻结的被测 Agent 配置版本不可用', 409)
    }
    if (canonicalSha256(frozenSnapshot(value, version)) !== canonicalSha256(snapshot)) {
      throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_SNAPSHOT_DRIFT', '冻结的被测 Agent 快照与持久化版本不一致', 409)
    }
    return structuredClone(version)
  }
}

function normalizeInput(raw: AgentUnderTestInput) {
  if (!raw || typeof raw !== 'object') throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_INPUT_INVALID', '被测 Agent 配置必须是对象', 400)
  const name = text(raw.name, 'name', 200)
  const description = optionalText(raw.description, 'description', 4_000)
  const endpoint = validEndpoint(raw.endpoint)
  if (raw.protocol !== 'http' && raw.protocol !== 'sse') throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_PROTOCOL_INVALID', 'protocol 仅支持 http 或 sse')
  const authenticationConfig = normalizeAuthentication(raw.authenticationConfig ?? { type: 'none' })
  const requestMapping = normalizeRequestMapping(raw.requestMapping)
  const responseMapping = normalizeResponseMapping(raw.responseMapping)
  const documentationRefs = uniqueTexts(raw.documentationRefs ?? [], 'documentationRefs', 200, 1_000)
  return {
    name,
    ...(description ? { description } : {}),
    endpoint,
    protocol: raw.protocol,
    authenticationConfig,
    requestMapping,
    responseMapping,
    documentationRefs,
    enabled: raw.enabled !== false,
  }
}

function normalizeAuthentication(value: AgentUnderTestAuthenticationConfig): AgentUnderTestAuthenticationConfig {
  if (value.type === 'none') return { type: 'none' }
  if (value.type === 'bearer_env') return { type: value.type, environmentVariable: environmentVariable(value.environmentVariable) }
  if (value.type === 'api_key_env') {
    const headerName = text(value.headerName, 'authenticationConfig.headerName', 100)
    if (/^(authorization|cookie|set-cookie)$/iu.test(headerName)) throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_AUTH_HEADER_INVALID', 'API Key Header 不能使用受保护的认证头名称')
    return { type: value.type, headerName, environmentVariable: environmentVariable(value.environmentVariable) }
  }
  throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_AUTH_INVALID', 'authenticationConfig.type 无效')
}

function normalizeRequestMapping(value: Partial<AgentUnderTestRequestMapping> | undefined): AgentUnderTestRequestMapping {
  const headers = Object.fromEntries(Object.entries(value?.headers ?? {}).map(([key, item]) => {
    const name = text(key, 'requestMapping.headers.name', 100)
    if (/^(authorization|cookie|set-cookie|host|content-length)$/iu.test(name)) throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_HEADER_INVALID', `请求头 ${name} 不允许持久化`)
    const content = text(item, `requestMapping.headers.${name}`, 2_000)
    if (/\r|\n/u.test(content)) throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_HEADER_INVALID', `请求头 ${name} 包含换行符`)
    return [name, content]
  }))
  return {
    method: 'POST',
    inputField: mappingField(value?.inputField ?? 'input', 'requestMapping.inputField'),
    ...(value?.contextField === undefined ? { contextField: 'context' } : value.contextField ? { contextField: mappingField(value.contextField, 'requestMapping.contextField') } : {}),
    ...(value?.sessionIdField ? { sessionIdField: mappingField(value.sessionIdField, 'requestMapping.sessionIdField') } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
  }
}

function normalizeResponseMapping(value: Partial<AgentUnderTestResponseMapping> | undefined): AgentUnderTestResponseMapping {
  const traceCompleteness = value?.traceCompleteness
  if (traceCompleteness !== undefined && traceCompleteness !== 'complete' && traceCompleteness !== 'partial') throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_MAPPING_INVALID', 'traceCompleteness 仅支持 complete 或 partial')
  if (traceCompleteness && !value?.tracePath) throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_MAPPING_INVALID', '声明 Trace 完整性时必须配置 tracePath')
  return {
    outputPath: mappingPath(value?.outputPath ?? 'output', 'responseMapping.outputPath'),
    ...(value?.tracePath ? { tracePath: mappingPath(value.tracePath, 'responseMapping.tracePath') } : {}),
    ...(value?.tokenUsagePath ? { tokenUsagePath: mappingPath(value.tokenUsagePath, 'responseMapping.tokenUsagePath') } : {}),
    ...(value?.costPath ? { costPath: mappingPath(value.costPath, 'responseMapping.costPath') } : {}),
    ...(traceCompleteness ? { traceCompleteness } : {}),
  }
}

function createVersion(version: number, input: ReturnType<typeof normalizeInput>, createdBy: string, createdAt: string): AgentUnderTestVersion {
  const base = {
    version,
    endpoint: input.endpoint,
    protocol: input.protocol,
    authenticationConfig: input.authenticationConfig,
    requestMapping: input.requestMapping,
    responseMapping: input.responseMapping,
    documentationRefs: input.documentationRefs,
    createdAt,
    createdBy: text(createdBy, 'createdBy', 200),
  }
  return { ...base, configurationSha256: canonicalSha256(base) }
}

function frozenSnapshot(value: AgentUnderTest, version: AgentUnderTestVersion): FrozenAgentUnderTestSnapshot {
  return {
    id: value.id,
    projectId: value.projectId,
    projectVersionId: value.projectVersionId,
    name: value.name,
    ...(value.description ? { description: value.description } : {}),
    version: version.version,
    endpoint: version.endpoint,
    protocol: version.protocol,
    requestMapping: structuredClone(version.requestMapping),
    responseMapping: structuredClone(version.responseMapping),
    documentationRefs: [...version.documentationRefs],
    configurationSha256: version.configurationSha256,
  }
}

function presentAgentUnderTest(value: AgentUnderTest) {
  const version = currentVersion(value)
  return {
    id: value.id,
    projectId: value.projectId,
    projectVersionId: value.projectVersionId,
    name: value.name,
    description: value.description,
    enabled: value.enabled,
    currentVersion: value.currentVersion,
    endpoint: version.endpoint,
    protocol: version.protocol,
    authenticationConfig: version.authenticationConfig,
    requestMapping: structuredClone(version.requestMapping),
    responseMapping: structuredClone(version.responseMapping),
    documentationRefs: [...version.documentationRefs],
    configurationSha256: version.configurationSha256,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function currentVersion(value: AgentUnderTest) {
  const version = value.versions.find(item => item.version === value.currentVersion)
  if (!version) throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_VERSION_INVALID', '被测 Agent 当前配置版本不存在', 500)
  return version
}

function requireProjectVersion(state: Awaited<ReturnType<StateStore['snapshot']>>, id: string) {
  const value = state.projectVersions.find(item => item.id === id)
  if (!value) throw new AgentUnderTestServiceError('PROJECT_VERSION_NOT_FOUND', 'ProjectVersion 不存在', 404)
  return value
}

function requiredAgent(values: AgentUnderTest[], id: string) {
  const value = values.find(item => item.id === id)
  if (!value) throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_NOT_FOUND', '被测 Agent 不存在', 404)
  return value
}

function validEndpoint(value: unknown) {
  const content = text(value, 'endpoint', 2_000)
  let url: URL
  try { url = new URL(content) } catch { throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_ENDPOINT_INVALID', 'endpoint 必须是有效的 HTTP(S) URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_ENDPOINT_INVALID', 'endpoint 仅支持不含凭据的 HTTP(S) URL')
  return url.toString()
}

function environmentVariable(value: unknown) {
  const content = text(value, 'authenticationConfig.environmentVariable', 200)
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(content)) throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_AUTH_INVALID', '认证环境变量名称无效')
  return content
}

function mappingField(value: unknown, field: string) {
  const content = text(value, field, 200)
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(content)) throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_MAPPING_INVALID', `${field} 不是有效字段名`)
  return content
}

function mappingPath(value: unknown, field: string) {
  const content = text(value, field, 500)
  if (content !== '$' && !/^[A-Za-z_][A-Za-z0-9_-]*(?:\.(?:[A-Za-z_][A-Za-z0-9_-]*|\d+))*$/u.test(content)) throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_MAPPING_INVALID', `${field} 不是有效 JSON 路径`)
  return content
}

function text(value: unknown, field: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_INPUT_INVALID', `${field} 必须是长度不超过 ${max} 的非空字符串`, 400)
  return value.trim()
}

function optionalText(value: unknown, field: string, max: number) {
  if (value === undefined || value === null || value === '') return undefined
  return text(value, field, max)
}

function uniqueTexts(value: unknown, field: string, maxItems: number, maxLength: number) {
  if (!Array.isArray(value) || value.length > maxItems) throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_INPUT_INVALID', `${field} 必须是最多 ${maxItems} 项的数组`, 400)
  const values = value.map(item => text(item, field, maxLength))
  if (new Set(values).size !== values.length) throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_INPUT_INVALID', `${field} 不能重复`, 400)
  return values
}
