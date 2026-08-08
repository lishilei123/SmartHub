import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AiResourceService } from '../server/application/ai-resource-service.js'
import { JsonStore } from '../server/infrastructure/store.js'

test('AI 资源目录只登记可独立配置工具并持久化 MCP、Skill 和工具', async () => {
  const store = new JsonStore(null)
  await store.load()
  const service = new AiResourceService(store)

  const initial = await service.list()
  assert.deepEqual(initial.tools.map(tool => tool.key).sort(), [
    'example.echo',
    'functional_test_design.submit_result',
    'knowledge.read_chunk',
    'knowledge.search',
    'non_functional_test_design.submit_result',
    'requirement-points.submit_result',
    'review.answer_submit',
    'review.submit_result',
    'technical_solution.evidence.preview',
    'technical_solution.input.read',
    'technical_solution_points.submit_result',
    'technical_solution_review.submit_result',
    'test_analysis.submit_result',
    'test_case_synthesis.submit_result',
  ])
  assert.deepEqual(initial.skills.map(skill => skill.key), ['system.query-local-ip', 'system.structured-summary', 'example.echo-skill'])
  assert.equal(initial.skills[0].runtime?.scripts[0].path, 'scripts/get-local-ip.ps1')
  assert.deepEqual(initial.skills[0].toolIds, [])
  assert.equal(initial.skills[1].entrypoint, 'server/skills/structured-summary/SKILL.md')
  assert.equal(initial.skills[2].managedBy, 'filesystem')
  assert.deepEqual(initial.skills[2].toolIds, ['example.echo'])
  assert.ok(initial.tools.filter(tool => tool.builtIn).every(tool => tool.status === 'ready' && tool.enabled))
  assert.ok(initial.skills.filter(skill => skill.builtIn).every(skill => skill.status === 'ready' && skill.enabled))
  assert.equal(initial.tools.find(tool => tool.key === 'example.echo')?.managedBy, 'filesystem')
  assert.deepEqual(Object.fromEntries(initial.tools.map(tool => [tool.key, tool.sourcePath])), {
    'knowledge.search': 'server/tools/knowledge-search.ts',
    'knowledge.read_chunk': 'server/tools/knowledge-read-chunk.ts',
    'requirement-points.submit_result': 'server/tools/requirement-points-submit-result.ts',
    'review.answer_submit': 'server/tools/review-answer-submit.ts',
    'review.submit_result': 'server/tools/review-submit-result.ts',
    'technical_solution.input.read': 'server/tools/technical-solution-tools.ts',
    'technical_solution.evidence.preview': 'server/tools/technical-solution-tools.ts',
    'technical_solution_points.submit_result': 'server/tools/technical-solution-tools.ts',
    'technical_solution_review.submit_result': 'server/tools/technical-solution-tools.ts',
    'test_analysis.submit_result': 'server/tools/test-design-tools.ts',
    'functional_test_design.submit_result': 'server/tools/test-design-tools.ts',
    'non_functional_test_design.submit_result': 'server/tools/test-design-tools.ts',
    'test_case_synthesis.submit_result': 'server/tools/test-design-tools.ts',
    'example.echo': 'ai/tools/example-echo.ts',
  })
  store.transaction = async () => { throw new Error('内置资源已同步时不应再次启动写事务') }
  assert.equal((await service.list()).tools.length, 14)
  store.transaction = JsonStore.prototype.transaction.bind(store)
  const searchTool = initial.tools.find(tool => tool.key === 'knowledge.search')!
  const builtInSource = await service.source(searchTool.id)
  assert.equal(builtInSource.path, 'server/tools/knowledge-search.ts')
  assert.equal(builtInSource.language, 'typescript')
  assert.match(builtInSource.content, /registerKnowledgeSearchTool/u)

  const mcp = await service.create('mcp', {
    key: 'issues.mcp', name: 'Issue MCP', description: '缺陷系统工具服务', version: '1.0.0', enabled: true,
    transport: 'streamable_http', endpoint: 'https://mcp.example.com/mcp', authType: 'oauth2', toolIds: ['issues.list'],
  })
  assert.equal(mcp.kind, 'mcp')
  assert.equal(mcp.endpoint, 'https://mcp.example.com/mcp')
  assert.equal(mcp.status, 'ready')
  assert.equal(mcp.credentialEnv, 'SMARTHUB_MCP_ISSUES_MCP_TOKEN')

  const tool = await service.create('tool', {
    key: 'issues.list', name: '查询缺陷', description: '查询缺陷列表', version: '1.0.0', enabled: true,
    source: 'mcp', risk: 'network_read', timeoutMs: 20_000, mcpServerId: mcp.id,
  })
  assert.equal(tool.kind, 'tool')
  assert.equal(tool.mcpServerId, mcp.id)

  const skill = await service.create('skill', {
    key: 'issue.triage', name: '缺陷分诊', description: '复用缺陷分诊流程', version: '1.0.0', enabled: true,
    entrypoint: 'ai/skills/issue-triage/SKILL.md', toolIds: ['issues.list', 'knowledge.search'], tags: ['缺陷', '分诊'],
  })
  assert.equal(skill.kind, 'skill')
  assert.deepEqual(skill.toolIds, ['issues.list', 'knowledge.search'])
  assert.equal(skill.status, 'ready')

  const catalog = await service.list()
  assert.equal(catalog.mcpServers.length, 1)
  assert.equal(catalog.skills.length, 4)
  assert.equal(catalog.tools.length, 15)

  await assert.rejects(() => service.delete('tool', tool.id), /Skill 引用/)
  await assert.rejects(() => service.delete('mcp', mcp.id), /工具引用/)
  await service.delete('skill', skill.id)
  await service.delete('tool', tool.id)
  await service.delete('mcp', mcp.id)
  assert.equal((await service.list()).tools.length, 14)
})

test('ai/skills 与 ai/tools 支持单文件、单描述、目录、批量和 package 自动识别并按内容 Hash 重载', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smarthub-ai-extensions-'))
  const skillDirectory = join(root, 'ai', 'skills', 'demo')
  const toolDirectory = join(root, 'ai', 'tools')
  const directoryTool = join(toolDirectory, 'directory-tool')
  const batchTool = join(toolDirectory, 'batch-tool')
  const packageTool = join(toolDirectory, 'package-tool')
  await Promise.all([mkdir(skillDirectory, { recursive: true }), mkdir(directoryTool, { recursive: true }), mkdir(batchTool, { recursive: true }), mkdir(packageTool, { recursive: true })])
  await Promise.all([
    writeFile(join(skillDirectory, 'skill.json'), JSON.stringify({ key: 'demo.skill', name: 'Demo Skill', version: '1.0.0', toolIds: ['demo.echo'], tags: ['demo'] }), 'utf8'),
    writeFile(join(skillDirectory, 'SKILL.md'), '# Demo Skill', 'utf8'),
    writeFile(join(toolDirectory, 'demo-echo.tool.json'), JSON.stringify({ key: 'demo.echo', name: 'Demo Echo', version: '1.0.0', risk: 'read', timeoutMs: 5000 }), 'utf8'),
    writeFile(join(toolDirectory, 'demo-echo.ts'), 'export const parameters = { type: "object" }; export async function execute() { return { data: "v1" } }', 'utf8'),
    writeFile(join(toolDirectory, 'inline.ts'), 'export const tool = { key: "inline.echo", name: "Inline Echo", version: "1.0.0", risk: "read", timeoutMs: 5000 } as const; throw new Error("扫描阶段不得执行模块");', 'utf8'),
    writeFile(join(directoryTool, 'tool.json'), JSON.stringify({ key: 'directory.echo', name: 'Directory Echo', version: '1.0.0', risk: 'read', timeoutMs: 5000 }), 'utf8'),
    writeFile(join(directoryTool, 'tool.ts'), 'export const parameters = { type: "object" }; export async function execute() { return { data: "directory" } }', 'utf8'),
    writeFile(join(batchTool, 'tools.json'), JSON.stringify({ tools: [{ key: 'batch.echo', name: 'Batch Echo', version: '1.0.0', module: 'batch.ts', risk: 'read', timeoutMs: 5000 }, { key: 'batch.second', name: 'Batch Second', version: '1.0.0', module: 'second.ts', risk: 'read', timeoutMs: 5000 }] }), 'utf8'),
    writeFile(join(batchTool, 'batch.ts'), 'export const parameters = { type: "object" }; export async function execute() { return { data: "batch" } }', 'utf8'),
    writeFile(join(batchTool, 'second.ts'), 'export const parameters = { type: "object" }; export async function execute() { return { data: "second" } }', 'utf8'),
    writeFile(join(packageTool, 'package.json'), JSON.stringify({ main: 'index.js', smarthub: { tool: { key: 'package.echo', name: 'Package Echo', version: '1.0.0', risk: 'read', timeoutMs: 5000 } } }), 'utf8'),
    writeFile(join(packageTool, 'index.js'), 'export const parameters = { type: "object" }; export async function execute() { return { data: "package" } }', 'utf8'),
  ])
  const store = new JsonStore(null)
  await store.load()
  const service = new AiResourceService(store, undefined, { extensionRoot: root, reloadIntervalMs: 20 })
  try {
    await service.initialize()
    const initial = await service.list()
    const initialTool = initial.tools.find(tool => tool.key === 'demo.echo')!
    assert.equal(initialTool.managedBy, 'filesystem')
    assert.equal(initial.skills.find(skill => skill.key === 'demo.skill')?.managedBy, 'filesystem')
    assert.deepEqual(['inline.echo', 'directory.echo', 'batch.echo', 'batch.second', 'package.echo'].map(key => initial.tools.find(tool => tool.key === key)?.managedBy), ['filesystem', 'filesystem', 'filesystem', 'filesystem', 'filesystem'])
    await writeFile(join(toolDirectory, 'demo-echo.ts'), 'export const parameters = { type: "object" }; export async function execute() { return { data: "v2" } }', 'utf8')
    await eventually(async () => (await store.snapshot()).aiResources.some(item => item.kind === 'tool' && item.key === 'demo.echo' && item.contentSha256 !== initialTool.contentSha256))
    await Promise.all([rm(join(toolDirectory, 'demo-echo.tool.json')), rm(join(skillDirectory, 'skill.json'))])
    await eventually(async () => !(await store.snapshot()).aiResources.some(item => item.kind === 'tool' && item.key === 'demo.echo'))
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('自定义工具不能在目录同步前抢占或更新为内置 Tool 标识', async () => {
  const store = new JsonStore(null)
  await store.load()
  const service = new AiResourceService(store)
  await assert.rejects(() => service.create('tool', { key: 'knowledge.search', name: '伪造内置检索', source: 'local', sourcePath: 'server/tools/knowledge-search.ts', risk: 'read', timeoutMs: 1000 }), /内置工具标识/u)
  const custom = await service.create('tool', { key: 'custom.search', name: '自定义检索', source: 'local', sourcePath: 'server/tools/knowledge-search.ts', risk: 'read', timeoutMs: 1000 })
  assert.equal(custom.managedBy, 'catalog')
  const cannotSpoof = await service.create('tool', { key: 'custom.filesystem', name: '不可伪造外置资源', managedBy: 'filesystem', source: 'local', sourcePath: 'server/tools/knowledge-search.ts', risk: 'read', timeoutMs: 1000 })
  assert.equal(cannotSpoof.managedBy, 'catalog')
  await assert.rejects(() => service.update('tool', custom.id, { key: 'knowledge.search' }), /内置工具标识/u)
})

test('AI 资源目录清理已退役的批量校验证据工具', async () => {
  const store = new JsonStore(null)
  await store.load()
  await store.transaction(state => {
    state.aiResources.push({ id: 'retired-evidence-tool', kind: 'tool', key: 'evidence.validate_batch', name: '批量校验证据', description: '', version: '1.1.0', enabled: true, status: 'ready', builtIn: true, source: 'builtin', risk: 'read', timeoutMs: 30_000, sourcePath: 'server/tools/evidence-validate-batch.ts', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() })
  })
  const catalog = await new AiResourceService(store).list()
  assert.ok(!catalog.tools.some(tool => tool.key === 'evidence.validate_batch'))
})

test('AI 资源目录自动恢复历史上被停用的内置 Tool 和 Skill', async () => {
  const store = new JsonStore(null)
  await store.load()
  const service = new AiResourceService(store)
  const initial = await service.list()
  const toolId = initial.tools.find(tool => tool.builtIn)!.id
  const skillId = initial.skills.find(skill => skill.builtIn)!.id
  await store.transaction(state => {
    state.aiResources = state.aiResources.map(resource => resource.id === toolId || resource.id === skillId ? { ...resource, enabled: false } : resource)
  })

  const repaired = await service.list()
  assert.equal(repaired.tools.find(tool => tool.id === toolId)?.enabled, true)
  assert.equal(repaired.skills.find(skill => skill.id === skillId)?.enabled, true)
})

test('AI 资源目录校验标识、引用和内置 Tool/Skill 保护', async () => {
  const store = new JsonStore(null)
  await store.load()
  const service = new AiResourceService(store)
  const catalog = await service.list()
  const builtIn = catalog.tools[0]
  const builtInSkill = catalog.skills.find(skill => skill.builtIn)!
  const external = catalog.tools.find(tool => tool.key === 'example.echo')!

  await assert.rejects(() => service.update('tool', builtIn.id, { enabled: false }), /始终启用，不可停用/)
  await assert.rejects(() => service.update('skill', builtInSkill.id, { enabled: false }), /始终启用，不可停用/)
  assert.equal((await service.list()).tools.find(tool => tool.id === builtIn.id)?.enabled, true)
  assert.equal((await service.list()).skills.find(skill => skill.id === builtInSkill.id)?.enabled, true)
  await assert.rejects(() => service.delete('tool', builtIn.id), /不可删除或停用/)
  await service.update('tool', external.id, { name: '不能覆盖文件描述', enabled: false })
  assert.equal((await service.list()).tools.find(tool => tool.id === external.id)?.name, external.name)
  assert.equal((await service.list()).tools.find(tool => tool.id === external.id)?.enabled, false)
  await assert.rejects(() => service.delete('tool', external.id), /文件系统管理/)
  await assert.rejects(() => service.create('mcp', { key: 'Bad Key', name: '错误', endpoint: 'file:///tmp/mcp', transport: 'sse', authType: 'none' }), /资源标识/)
  await assert.rejects(() => service.create('skill', { key: 'bad.skill', name: '错误 Skill', entrypoint: 'SKILL.md', toolIds: ['missing.tool'] }), /未注册工具/)
  await assert.rejects(() => service.create('tool', { key: 'remote.tool', name: '远程工具', source: 'mcp', risk: 'read', timeoutMs: 1000, mcpServerId: 'missing' }), /MCP 服务/)
  await assert.rejects(() => service.create('tool', { key: 'skill.execute_script', name: '伪造 Skill 网关', source: 'local', sourcePath: 'server/tools/skill-capability.ts', risk: 'code_execution', timeoutMs: 1000 }), /运行权限清单/)
  await assert.rejects(() => service.create('tool', { key: 'knowledge.search', name: '伪造内置检索', source: 'local', sourcePath: 'server/tools/knowledge-search.ts', risk: 'read', timeoutMs: 1000 }), /内置工具标识/)
  await assert.rejects(() => service.create('tool', { key: 'http.missing', name: '错误 HTTP 工具', source: 'http', risk: 'network_read', timeoutMs: 1000 }), /HTTP 工具 Endpoint/)
  const http = await service.create('tool', { key: 'http.lookup', name: 'HTTP 查询', source: 'http', risk: 'network_read', timeoutMs: 1000, endpoint: 'https://tools.example.com/invoke', authType: 'bearer', parameters: { type: 'object', properties: { query: { type: 'string' } } } })
  assert.equal(http.kind === 'tool' ? http.credentialEnv : '', 'SMARTHUB_HTTP_TOOL_HTTP_LOOKUP_TOKEN')
  const highRisk = await service.create('tool', { key: 'issues.close', name: '关闭外部问题', source: 'http', risk: 'write_high_risk', timeoutMs: 1000, endpoint: 'https://tools.example.com/issues/close', authType: 'none', parameters: { type: 'object', required: ['issueId'], properties: { issueId: { type: 'string' } } } })
  assert.equal(highRisk.kind === 'tool' ? highRisk.risk : '', 'write_high_risk')
  await assert.rejects(() => service.create('tool', { key: 'unsafe.local', name: '越界本地工具', source: 'local', sourcePath: 'server/tools/../runtime.ts', risk: 'read', timeoutMs: 1000 }), /相对文件路径/)
  const local = await service.create('tool', { key: 'safe.local', name: '安全本地工具', source: 'local', sourcePath: 'server/tools/knowledge-search.ts', risk: 'read', timeoutMs: 1000 })
  const localSource = await service.source(local.id)
  assert.equal(localSource.toolKey, 'safe.local')
  assert.equal(localSource.readOnly, true)
})

async function eventually(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
  }
  assert.fail('等待外置资源自动重载超时')
}
