import { realpath } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { Client, SSEClientTransport, StreamableHTTPClientTransport, type AuthProvider, type Tool as McpTool } from '@modelcontextprotocol/client'
import type { TSchema } from 'typebox'
import { mcpPolicyHash, toolBindingToken, toolsetContentHash } from '../application/ai-resource-hash.js'
import type { AgentDefinitionVersion } from '../domain/agent-types.js'
import type { McpServerResource, ToolResource } from '../domain/types.js'
import type { ToolExecutionContext, ToolExecutionResult } from '../domain/tool-types.js'
import type { StateStore } from '../infrastructure/store.js'
import type { SkillPackageStore } from '../infrastructure/skill-package-store.js'
import { applicationRoot, codeRoot, deployedModuleCandidates, moduleUrl } from '../infrastructure/runtime-paths.js'
import { ToolRegistry } from './registry.js'
import { SkillCapabilityRuntime } from './skill-capability.js'

const MAX_REMOTE_RESULT_BYTES = 256 * 1024
const MCP_CONNECT_TIMEOUT_MS = 20_000
const BUILT_IN_VERSIONS: Record<string, string> = {
  'knowledge.search': '1.0.0',
  'knowledge.read_chunk': '1.0.0',
  'requirement-points.submit_result': '5.1.0',
  'review.submit_result': '4.0.0',
  'review.answer_submit': '1.0.0',
  'skill.execute_script': '1.0.0',
  'skill.http_request': '1.0.0',
}

export interface CapabilityLoadResult { warnings: string[]; close(): Promise<void> }

export class AgentCapabilityLoader {
  constructor(private readonly store: StateStore, private readonly skillPackages?: SkillPackageStore) {}

  async load(definition: AgentDefinitionVersion, registry: ToolRegistry, signal: AbortSignal): Promise<CapabilityLoadResult> {
    const state = await this.store.snapshot()
    const resources = state.aiResources.filter((item): item is ToolResource => item.kind === 'tool')
    const tokens = definition.toolIds.map(toolId => {
      const resource = resources.find(tool => tool.key === toolId)
      if (resource) return toolBindingToken(resource)
      const version = BUILT_IN_VERSIONS[toolId]
      return version ? `${toolId}@${version}` : `${toolId}@missing`
    })
    const warnings: string[] = []
    if (toolsetContentHash(tokens) !== definition.toolsetContentSha256) {
      warnings.push('Toolset 目录内容与发布快照不一致；自定义 Tool 已拒绝加载，请重新发布 Agent 配置。')
      return { warnings, close: async () => undefined }
    }

    new SkillCapabilityRuntime(definition, state, this.skillPackages).register(definition, registry)

    const selected = resources.filter(tool => definition.toolIds.includes(tool.key) && !tool.builtIn)
    const mcpServers = state.aiResources.filter((item): item is McpServerResource => item.kind === 'mcp')
    const clients: Client[] = []
    const mcpSessions = new Map<string, { client: Client; tools: McpTool[] }>()

    for (const tool of selected) {
      if (!tool.enabled) { warnings.push(`${tool.key}@${tool.version} 已停用。`); continue }
      try {
        if (tool.source === 'local') await registerLocal(registry, tool)
        else if (tool.source === 'http') registerHttp(registry, tool)
        else if (tool.source === 'mcp') {
          const server = mcpServers.find(item => item.id === tool.mcpServerId)
          if (!server || !server.enabled) throw new Error('MCP 服务不存在或未启用')
          const binding = definition.mcpBindings.find(item => item.enabled && item.serverKey === server.key && item.version === server.version)
          if (!binding || binding.policyHash !== mcpPolicyHash(server)) throw new Error('MCP 服务与发布快照不一致')
          if (!binding.toolIds.includes(tool.key) || !server.toolIds.includes(tool.key)) throw new Error('工具不在 MCP 发布白名单中')
          let session = mcpSessions.get(server.id)
          if (!session) {
            session = await connectMcp(server, signal)
            mcpSessions.set(server.id, session)
            clients.push(session.client)
          }
          registerMcp(registry, tool, session.client, session.tools)
        }
      } catch (error) { warnings.push(`${tool.key}@${tool.version}：${message(error)}`) }
    }
    return { warnings, close: async () => { await Promise.allSettled(clients.map(client => client.close())) } }
  }
}

async function registerLocal(registry: ToolRegistry, tool: ToolResource) {
  const path = await resolveLocalModule(required(tool.sourcePath, '本地工具缺少源码路径'))
  const loaded = await import(`${moduleUrl(path)}?v=${encodeURIComponent(tool.version)}`) as Record<string, unknown>
  const execute = loaded.execute ?? (loaded.default as { execute?: unknown } | undefined)?.execute
  const parameters = loaded.parameters ?? (loaded.default as { parameters?: unknown } | undefined)?.parameters
  if (typeof execute !== 'function') throw new Error('本地工具必须导出 execute(arguments, context, signal)')
  if (!isObjectSchema(parameters)) throw new Error('本地工具必须导出 type=object 的 parameters JSON Schema')
  register(registry, tool, schema(parameters), async (args, context, signal) => normalizeResult(await (execute as LocalExecute)(args, context, signal)))
}

function registerHttp(registry: ToolRegistry, tool: ToolResource) {
  const endpoint = required(tool.endpoint, 'HTTP 工具缺少 Endpoint')
  register(registry, tool, schema(tool.parameters), async (args, context, signal) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
    if (tool.authType === 'bearer') headers.authorization = `Bearer ${credential(tool.credentialEnv, tool.key)}`
    const response = await fetch(endpoint, {
      method: 'POST', headers, signal,
      body: JSON.stringify({ arguments: args, context: publicContext(context) }),
    })
    const body = await readLimitedBody(response, signal)
    const text = body.toString('utf8')
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`)
    const data = response.headers.get('content-type')?.includes('application/json') && text ? JSON.parse(text) : text
    return normalizeResult(data)
  })
}

function registerMcp(registry: ToolRegistry, tool: ToolResource, client: Client, discovered: McpTool[]) {
  const remote = discovered.find(item => item.name === tool.key)
  if (!remote) throw new Error('MCP tools/list 未返回该工具')
  register(registry, { ...tool, description: tool.description || remote.description || tool.name }, schema(remote.inputSchema), async (args, _context, signal) => {
    const result = await client.callTool({ name: remote.name, arguments: args as Record<string, unknown> }, { signal, timeout: tool.timeoutMs })
    if (result.isError) throw new Error(`MCP_TOOL_ERROR: ${JSON.stringify(result.content).slice(0, 1000)}`)
    const data = { content: result.content, ...('structuredContent' in result ? { structuredContent: result.structuredContent } : {}) }
    enforceResultSize(data, 'MCP 工具响应')
    return { data }
  })
}

async function connectMcp(server: McpServerResource, signal: AbortSignal) {
  const authProvider: AuthProvider | undefined = server.authType === 'none' ? undefined : { token: async () => credential(server.credentialEnv, server.key) }
  const transport = server.transport === 'sse'
    ? new SSEClientTransport(new URL(server.endpoint), { authProvider })
    : new StreamableHTTPClientTransport(new URL(server.endpoint), { authProvider })
  const client = new Client({ name: 'smarthub', version: '0.1.0' })
  const connectSignal = AbortSignal.any([signal, AbortSignal.timeout(MCP_CONNECT_TIMEOUT_MS)])
  try {
    await client.connect(transport, { signal: connectSignal, timeout: MCP_CONNECT_TIMEOUT_MS })
    const { tools } = await client.listTools(undefined, { signal: connectSignal, timeout: MCP_CONNECT_TIMEOUT_MS })
    return { client, tools }
  } catch (error) {
    await client.close().catch(() => undefined)
    throw error
  }
}

function register(registry: ToolRegistry, tool: ToolResource, parameters: TSchema, execute: (args: unknown, context: ToolExecutionContext, signal: AbortSignal) => Promise<ToolExecutionResult>) {
  registry.register({
    id: tool.key,
    piName: piName(tool.key),
    version: tool.version,
    label: tool.name,
    description: tool.description || tool.name,
    risk: tool.risk,
    parameters,
    timeoutMs: tool.timeoutMs,
    idempotent: tool.risk !== 'internal_write',
    ...(tool.risk === 'read' ? { repeatPolicy: 'replay_success_once' as const } : {}),
  }, (request, signal) => execute(request.arguments, request.context, signal))
}

async function resolveLocalModule(sourcePath: string) {
  for (const candidate of deployedModuleCandidates(sourcePath)) {
    const actual = await realpath(candidate).catch(() => null)
    if (!actual) continue
    const allowedRoots = await Promise.all([
      resolve(applicationRoot, 'server/tools'), resolve(applicationRoot, 'ai/tools'),
      resolve(codeRoot, 'server/tools'), resolve(codeRoot, 'ai/tools'),
    ].map(root => realpath(root).catch(() => null)))
    if (allowedRoots.some(root => root && (actual === root || actual.startsWith(`${root}${sep}`))) && ['.js', '.mjs', '.cjs', '.ts'].includes(extname(actual).toLocaleLowerCase())) return actual
  }
  throw new Error('本地工具模块不存在或超出允许目录')
}

function schema(value: unknown): TSchema {
  if (!isObjectSchema(value)) throw new Error('工具参数 Schema 的 type 必须是 object')
  return structuredClone(value) as TSchema
}

function isObjectSchema(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as { type?: unknown }).type === 'object') }

async function readLimitedBody(response: Response, signal: AbortSignal) {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_REMOTE_RESULT_BYTES) throw new Error('HTTP 工具响应超过 256 KB')
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let received = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const current = await reader.read()
      if (current.done) break
      received += current.value.byteLength
      if (received > MAX_REMOTE_RESULT_BYTES) throw new Error('HTTP 工具响应超过 256 KB')
      chunks.push(Buffer.from(current.value))
    }
    return Buffer.concat(chunks)
  } finally { await reader.cancel().catch(() => undefined) }
}

function normalizeResult(value: unknown): ToolExecutionResult {
  const result = value && typeof value === 'object' && !Array.isArray(value) && 'data' in value ? value as ToolExecutionResult : { data: value }
  enforceResultSize(result, '工具响应')
  return result
}

function enforceResultSize(value: unknown, label: string) { if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_REMOTE_RESULT_BYTES) throw new Error(`${label}超过 256 KB`) }
function credential(environmentName: string | undefined, key: string) { const value = environmentName ? process.env[environmentName] : undefined; if (!value) throw new Error(`缺少 ${key} 的凭据环境变量 ${environmentName ?? ''}`.trim()); return value }
function piName(key: string) { const value = key.replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 64); if (!/^[a-zA-Z_]/u.test(value)) return `tool_${value}`; return value }
function required<T>(value: T | null | undefined, error: string): T { if (value == null || value === '') throw new Error(error); return value }
function message(error: unknown) { return error instanceof Error ? error.message : String(error) }
function publicContext(context: ToolExecutionContext) { return { runId: context.snapshot.runId, projectVersionId: context.snapshot.projectVersionId, assetVersionId: 'assetVersionId' in context.snapshot ? context.snapshot.assetVersionId : context.snapshot.assets[0]?.assetVersionId } }
type LocalExecute = (argumentsValue: unknown, context: ToolExecutionContext, signal: AbortSignal) => unknown | Promise<unknown>
