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
import { AiResourceService } from '../server/application/ai-resource-service.js'
import { legacySkillConfigurationHash, mcpPolicyHash, skillConfigurationHash, toolBindingToken } from '../server/application/ai-resource-hash.js'
import type { AgentDefinitionVersion, ReviewRunSnapshot } from '../server/domain/agent-types.js'
import type { McpServerResource, SkillResource, ToolResource } from '../server/domain/types.js'
import { SkillPackageStore } from '../server/infrastructure/skill-package-store.js'
import { JsonStore } from '../server/infrastructure/store.js'
import { AgentCapabilityLoader } from '../server/tools/capability-loader.js'
import { ToolRegistry } from '../server/tools/registry.js'

test('内置查询本机 IP Skill 自动派生内部脚本能力并执行项目内脚本', async () => {
  const store = new JsonStore(null)
  await store.load()
  const catalog = await new AiResourceService(store).list()
  const skill = catalog.skills.find(item => item.key === 'system.query-local-ip')!
  const tool = builtInTool('skill.execute_script', 'code_execution', 120_000)
  assert.ok(skill)
  assert.ok(!catalog.tools.some(item => item.key === tool.key))
  const binding = { skillKey: skill.key, version: skill.version, enabled: true, configurationHash: legacySkillConfigurationHash(skill) }
  const agentDefinition = definition([tool], [binding])
  assert.match(await new AgentSkillRuntime(store).render(agentDefinition), /查询本机 IP/u)
  const registry = new ToolRegistry()
  const loaded = await new AgentCapabilityLoader(store).load(agentDefinition, registry, new AbortController().signal)
  const descriptor = registry.descriptors(new Set([tool.key]))[0]
  assert.deepEqual((descriptor.parameters as { required?: string[] }).required, ['script'])
  const result = await execute(registry, tool.key, { script: 'scripts/get-local-ip.ps1', args: [] })
  const parsed = (result.data as { parsed: { hostname: string; addresses: unknown[] } }).parsed
  assert.equal(typeof parsed.hostname, 'string')
  assert.ok(Array.isArray(parsed.addresses))
  assert.equal((result.data as { skillKey: string }).skillKey, 'system.query-local-ip')
  await loaded.close()
})

test('脚本路径命中多个已绑定 Skill 时要求显式 skillKey 消歧', async () => {
  const tool = builtInTool('skill.execute_script', 'code_execution', 120_000)
  const first = skillResource({ key: 'script.first', runtime: { scripts: [{ path: 'scripts/shared.ps1', runner: 'powershell', timeoutMs: 5_000 }] } })
  const second = skillResource({ key: 'script.second', runtime: { scripts: [{ path: 'scripts/shared.ps1', runner: 'powershell', timeoutMs: 5_000 }] } })
  const bindings = [first, second].map(skill => ({ skillKey: skill.key, version: skill.version, enabled: true, configurationHash: skillConfigurationHash(skill) }))
  const registry = new ToolRegistry()
  const loaded = await new AgentCapabilityLoader(await storeWith(tool, first, second)).load(definition([tool], bindings), registry, new AbortController().signal)
  await assert.rejects(() => execute(registry, tool.key, { script: 'scripts/shared.ps1' }), /SKILL_SCRIPT_SKILL_KEY_REQUIRED.*script\.first、script\.second/u)
  await loaded.close()
})

test('绑定 Skill 只能执行运行清单声明的 PowerShell 脚本并剥离服务端秘密环境变量', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smarthub-skill-script-'))
  process.env.SMARTHUB_TEST_SECRET = 'must-not-leak'
  try {
    const packages = new SkillPackageStore(root)
    const archive = await new JSZip()
      .file('workflow/SKILL.md', '# Script Skill')
      .file('workflow/skill-runtime.json', JSON.stringify({ scripts: [{ path: 'scripts/run.ps1', runner: 'powershell', timeoutMs: 10_000 }] }))
      .file('workflow/scripts/run.ps1', "param([string]$Value)\n$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n[pscustomobject]@{ value = $Value; secretVisible = [bool]$env:SMARTHUB_TEST_SECRET } | ConvertTo-Json -Compress")
      .generateAsync({ type: 'nodebuffer' })
    const installed = await packages.install({ key: 'script.skill', version: '1.0.0', fileName: 'script.zip', archive })
    const skill = skillResource({ key: 'script.skill', entrypoint: installed.entrypoint, package: installed.package, runtime: installed.runtime })
    const scriptTool = builtInTool('skill.execute_script', 'code_execution', 120_000)
    const binding = { skillKey: skill.key, version: skill.version, enabled: true, configurationHash: skillConfigurationHash(skill) }
    const registry = new ToolRegistry()
    const loaded = await new AgentCapabilityLoader(await storeWith(skill, scriptTool), packages).load(definition([scriptTool], [binding]), registry, new AbortController().signal)
    assert.deepEqual(loaded.warnings, [])
    const result = await execute(registry, scriptTool.key, { skillKey: skill.key, script: 'scripts/run.ps1', args: ['hello'] })
    assert.deepEqual((result.data as { parsed: unknown }).parsed, { value: 'hello', secretVisible: false })
    await assert.rejects(() => execute(registry, scriptTool.key, { skillKey: skill.key, script: 'scripts/other.ps1' }), /SKILL_SCRIPT_NOT_ALLOWED/u)
    await loaded.close()
  } finally {
    delete process.env.SMARTHUB_TEST_SECRET
    await rm(root, { recursive: true, force: true })
  }
})

test('绑定 Skill 的网络访问仅允许清单中的 Origin、只读方法且拒绝重定向', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: '/status' }); response.end(); return }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true }))
  })
  const port = await listen(server)
  try {
    const origin = `http://127.0.0.1:${port}`
    const skill = skillResource({ key: 'network.skill', runtime: { scripts: [], network: { allowedOrigins: [origin], allowedMethods: ['GET'], timeoutMs: 5000 } } })
    const networkTool = builtInTool('skill.http_request', 'network_read', 60_000)
    const binding = { skillKey: skill.key, version: skill.version, enabled: true, configurationHash: skillConfigurationHash(skill) }
    const registry = new ToolRegistry()
    const loaded = await new AgentCapabilityLoader(await storeWith(skill, networkTool)).load(definition([networkTool], [binding]), registry, new AbortController().signal)
    const result = await execute(registry, networkTool.key, { skillKey: skill.key, url: `${origin}/status`, method: 'GET' })
    assert.deepEqual((result.data as { parsed: unknown }).parsed, { ok: true })
    await assert.rejects(() => execute(registry, networkTool.key, { skillKey: skill.key, url: 'https://example.com/' }), /NETWORK_TARGET_FORBIDDEN/u)
    await assert.rejects(() => execute(registry, networkTool.key, { skillKey: skill.key, url: `${origin}/status`, method: 'POST' }), /NETWORK_METHOD_FORBIDDEN/u)
    await assert.rejects(() => execute(registry, networkTool.key, { skillKey: skill.key, url: `${origin}/redirect`, method: 'GET' }), /NETWORK_REDIRECT_FORBIDDEN/u)
    await loaded.close()
  } finally { await close(server) }
})

test('配置已声明但当前阶段未注册的内置工具会产生预警', async () => {
  const tool = builtInTool('technical_solution_review.submit_result', 'internal_write', 30_000)
  const registry = new ToolRegistry()
  const loaded = await new AgentCapabilityLoader(await storeWith(tool)).load(definition([tool]), registry, new AbortController().signal)
  assert.equal(registry.get(tool.key), undefined)
  assert.ok(loaded.warnings.some(warning => /technical_solution_review\.submit_result.*当前 Agent 阶段未注册/u.test(warning)))
  await loaded.close()
})

test('存储异常导致内置工具停用时不会在 Agent 能力注册表中暴露', async () => {
  const store = new JsonStore(null)
  await store.load()
  const catalog = await new AiResourceService(store).list()
  const tool = catalog.tools.find(item => item.key === 'knowledge.search')!
  await store.transaction(state => {
    state.aiResources = state.aiResources.map(resource => resource.id === tool.id ? { ...resource, enabled: false } : resource)
  })
  const registry = new ToolRegistry()
  const loaded = await new AgentCapabilityLoader(store).load(definition([tool]), registry, new AbortController().signal)
  assert.equal(registry.get(tool.key), undefined)
  assert.ok(loaded.warnings.some(warning => /knowledge\.search.*已停用/u.test(warning)))
  await loaded.close()
})

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
    agentKey: 'requirement-analysis', agentType: 'requirement_analysis', resultSchemaVersion: 'requirement-analysis/v1', version: 'test+config.1', systemPrompt: 'test', taskTemplate: 'test', promptKey: 'test',
    tools: tools.map(toolBindingToken), skills, mcps,
    limits: { maxTurns: 8, maxToolCalls: 12, deadlineMs: 30_000, toolTimeoutMs: 5_000, maxCandidateBytes: 64_000, maxFindings: 10, maxRepeatedToolCall: 3 },
  })
}

function resource(overrides: Partial<ToolResource> & Pick<ToolResource, 'key' | 'source'>): ToolResource {
  return { id: `tool-${overrides.key}`, kind: 'tool', name: overrides.key, description: '', version: '1.0.0', enabled: true, status: 'ready', builtIn: false, risk: 'read', timeoutMs: 5_000, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), ...overrides }
}

function builtInTool(key: string, risk: ToolResource['risk'], timeoutMs: number): ToolResource {
  return { id: `builtin-${key}`, kind: 'tool', key, name: key, description: '', version: '1.0.0', enabled: true, status: 'ready', builtIn: true, source: 'builtin', risk, timeoutMs, sourcePath: 'server/tools/skill-capability.ts', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }
}

function skillResource(overrides: Partial<SkillResource> & Pick<SkillResource, 'key'>): SkillResource {
  return { id: `skill-${overrides.key}`, kind: 'skill', key: overrides.key, name: overrides.key, description: '', version: '1.0.0', enabled: true, status: 'ready', builtIn: false, entrypoint: 'server/skills/query-local-ip/SKILL.md', toolIds: [], tags: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), ...overrides }
}

function mcpServer(endpoint: string): McpServerResource {
  return { id: 'mcp-issues', kind: 'mcp', key: 'issues.mcp', name: 'Issues MCP', description: '', version: '1.0.0', enabled: true, status: 'ready', builtIn: false, transport: 'streamable_http', endpoint, authType: 'none', toolIds: ['issues.lookup'], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }
}

async function storeWith(...resources: Array<ToolResource | SkillResource | McpServerResource>) { const store = new JsonStore(null); await store.load(); await store.transaction(state => { state.aiResources.push(...structuredClone(resources)) }); return store }
async function execute(registry: ToolRegistry, toolId: string, argumentsValue: unknown) { const registered = registry.get(toolId); assert.ok(registered); return registered.handler({ toolId, toolCallId: 'call-1', arguments: argumentsValue, context: { snapshot: { runId: 'capability-test-run', projectVersionId: 'project-version', assetVersionId: 'asset-version' } as ReviewRunSnapshot, allowedToolIds: new Set([toolId]) } }, new AbortController().signal) }
async function listen(server: Server) { await new Promise<void>((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolvePromise()) }); const address = server.address(); assert.ok(address && typeof address !== 'string'); return address.port }
async function close(server: Server) { if (!server.listening) return; await new Promise<void>((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise())) }
