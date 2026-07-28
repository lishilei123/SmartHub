import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import * as z from 'zod/v4'
import JSZip from 'jszip'
import { createAgentDefinitionVersion } from '../server/agent/requirement-analysis-agent.js'
import { AgentSkillRuntime } from '../server/agent/skill-runtime.js'
import { mcpPolicyHash, skillConfigurationHash, toolBindingToken } from '../server/application/ai-resource-hash.js'
import type { AgentDefinitionVersion, ReviewRunSnapshot } from '../server/domain/agent-types.js'
import type { McpServerResource, SkillResource, ToolResource } from '../server/domain/types.js'
import { SkillPackageStore } from '../server/infrastructure/skill-package-store.js'
import { JsonStore } from '../server/infrastructure/store.js'
import { AgentCapabilityLoader } from '../server/tools/capability-loader.js'
import { ToolRegistry } from '../server/tools/registry.js'

test('打包兼容的本地模块按发布 Toolset Hash 加载并执行', async () => {
  const tool = resource({ key: 'example.echo', source: 'local', sourcePath: 'ai/tools/example-echo.ts' })
  const store = await storeWith(tool)
  const registry = new ToolRegistry()
  const loaded = await new AgentCapabilityLoader(store).load(definition([tool]), registry, new AbortController().signal)
  assert.deepEqual(loaded.warnings, [])
  const result = await execute(registry, tool.key, { message: 'hello' })
  assert.deepEqual(result.data, { message: 'hello', runId: 'capability-test-run' })
  await loaded.close()
})

test('HTTP 工具使用固定 JSON Schema、部署凭据和受限响应执行', async () => {
  let authorization = ''
  const server = createServer(async (request, response) => {
    authorization = String(request.headers.authorization ?? '')
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { arguments: { query: string }; context: { runId: string } }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ query: body.arguments.query, runId: body.context.runId }))
  })
  const port = await listen(server)
  const environmentName = 'SMARTHUB_HTTP_TOOL_CAPABILITY_TEST_TOKEN'
  process.env[environmentName] = 'http-secret'
  try {
    const tool = resource({ key: 'http.lookup', source: 'http', risk: 'network_read', endpoint: `http://127.0.0.1:${port}/invoke`, authType: 'bearer', credentialEnv: environmentName, parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } })
    const registry = new ToolRegistry()
    const loaded = await new AgentCapabilityLoader(await storeWith(tool)).load(definition([tool]), registry, new AbortController().signal)
    assert.deepEqual(loaded.warnings, [])
    assert.deepEqual((await execute(registry, tool.key, { query: '订单' })).data, { query: '订单', runId: 'capability-test-run' })
    assert.equal(authorization, 'Bearer http-secret')
    await loaded.close()
  } finally {
    delete process.env[environmentName]
    await close(server)
  }
})

test('MCP Streamable HTTP 发现白名单工具并通过官方客户端调用', async () => {
  const mcp = new McpServer({ name: 'smarthub-test-mcp', version: '1.0.0' })
  mcp.registerTool('issues.lookup', { description: '查询问题', inputSchema: z.object({ id: z.string() }) }, async ({ id }) => ({ content: [{ type: 'text', text: `issue:${id}` }], structuredContent: { id, state: 'open' } }))
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await mcp.connect(transport)
  const server = createServer((request, response) => { void transport.handleRequest(request, response) })
  const port = await listen(server)
  try {
    const mcpResource = mcpServer(`http://127.0.0.1:${port}/mcp`)
    const tool = resource({ key: 'issues.lookup', source: 'mcp', risk: 'network_read', mcpServerId: mcpResource.id })
    const store = await storeWith(mcpResource, tool)
    const registry = new ToolRegistry()
    const loaded = await new AgentCapabilityLoader(store).load(definition([tool], [], [{ serverKey: mcpResource.key, version: mcpResource.version, enabled: true, toolIds: [...mcpResource.toolIds], policyHash: mcpPolicyHash(mcpResource) }]), registry, new AbortController().signal)
    assert.deepEqual(loaded.warnings, [])
    const result = await execute(registry, tool.key, { id: '42' })
    assert.deepEqual((result.data as { structuredContent: unknown }).structuredContent, { id: '42', state: 'open' })
    await loaded.close()
  } finally {
    await mcp.close()
    await close(server)
  }
})

test('Skill ZIP 内容按发布 Hash 加载，目录漂移会被拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smarthub-skill-runtime-'))
  try {
    const packages = new SkillPackageStore(root)
    const zip = new JSZip()
    zip.file('workflow/SKILL.md', '# Review Skill\n\n必须先核对固定证据。')
    const installed = await packages.install({ key: 'review.skill', version: '1.0.0', fileName: 'review.zip', archive: await zip.generateAsync({ type: 'nodebuffer' }) })
    const skill: SkillResource = { id: 'skill-review', kind: 'skill', key: 'review.skill', name: '评审 Skill', description: '', version: '1.0.0', enabled: true, status: 'ready', builtIn: false, entrypoint: installed.entrypoint, package: installed.package, toolIds: [], tags: ['review'], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }
    const store = await storeWith(skill)
    const binding = { skillKey: skill.key, version: skill.version, enabled: true, configurationHash: skillConfigurationHash(skill) }
    const runtime = new AgentSkillRuntime(store, packages)
    assert.match(await runtime.render(definition([], [binding])), /必须先核对固定证据/u)
    await store.transaction(state => { const current = state.aiResources.find(item => item.id === skill.id) as SkillResource; current.tags = ['changed'] })
    await assert.rejects(() => runtime.render(definition([], [binding])), /SKILL_BINDING_CHANGED/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

function definition(tools: ToolResource[], skills: AgentDefinitionVersion['skillBindings'] = [], mcps: AgentDefinitionVersion['mcpBindings'] = []) {
  return createAgentDefinitionVersion({
    agentKey: 'requirementReview', agentType: 'requirement_review', resultSchemaVersion: 'requirement-review/v3', version: 'test+config.1', systemPrompt: 'test', taskTemplate: 'test', promptKey: 'test',
    tools: tools.map(toolBindingToken), skills, mcps,
    limits: { maxTurns: 8, maxToolCalls: 12, deadlineMs: 30_000, toolTimeoutMs: 5_000, maxCandidateBytes: 64_000, maxFindings: 10, maxRepeatedToolCall: 3 },
  })
}

function resource(overrides: Partial<ToolResource> & Pick<ToolResource, 'key' | 'source'>): ToolResource {
  return { id: `tool-${overrides.key}`, kind: 'tool', name: overrides.key, description: '', version: '1.0.0', enabled: true, status: 'ready', builtIn: false, risk: 'read', timeoutMs: 5_000, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), ...overrides }
}

function mcpServer(endpoint: string): McpServerResource {
  return { id: 'mcp-issues', kind: 'mcp', key: 'issues.mcp', name: 'Issues MCP', description: '', version: '1.0.0', enabled: true, status: 'ready', builtIn: false, transport: 'streamable_http', endpoint, authType: 'none', toolIds: ['issues.lookup'], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }
}

async function storeWith(...resources: Array<ToolResource | SkillResource | McpServerResource>) { const store = new JsonStore(null); await store.load(); await store.transaction(state => { state.aiResources.push(...structuredClone(resources)) }); return store }
async function execute(registry: ToolRegistry, toolId: string, argumentsValue: unknown) { const registered = registry.get(toolId); assert.ok(registered); return registered.handler({ toolId, toolCallId: 'call-1', arguments: argumentsValue, context: { snapshot: { runId: 'capability-test-run', projectVersionId: 'project-version', assetVersionId: 'asset-version' } as ReviewRunSnapshot, allowedToolIds: new Set([toolId]) } }, new AbortController().signal) }
async function listen(server: Server) { await new Promise<void>((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolvePromise()) }); const address = server.address(); assert.ok(address && typeof address !== 'string'); return address.port }
async function close(server: Server) { if (!server.listening) return; await new Promise<void>((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise())) }
