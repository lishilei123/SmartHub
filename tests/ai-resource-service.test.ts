import assert from 'node:assert/strict'
import test from 'node:test'
import { AiResourceService } from '../server/application/ai-resource-service.js'
import { JsonStore } from '../server/infrastructure/store.js'

test('AI 资源目录只登记可独立配置工具并持久化 MCP、Skill 和工具', async () => {
  const store = new JsonStore(null)
  await store.load()
  const service = new AiResourceService(store)

  const initial = await service.list()
  assert.deepEqual(initial.tools.map(tool => tool.key).sort(), [
    'knowledge.read_chunk',
    'knowledge.search',
    'requirement-points.submit_result',
    'review.answer_submit',
    'review.submit_result',
    'technical_solution.evidence.preview',
    'technical_solution.input.read',
    'technical_solution_points.submit_result',
    'technical_solution_review.submit_result',
  ])
  assert.deepEqual(initial.skills.map(skill => skill.key), ['system.query-local-ip'])
  assert.equal(initial.skills[0].runtime?.scripts[0].path, 'scripts/get-local-ip.ps1')
  assert.deepEqual(initial.skills[0].toolIds, [])
  assert.ok(initial.tools.every(tool => tool.builtIn && tool.status === 'ready'))
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
  })
  store.transaction = async () => { throw new Error('内置资源已同步时不应再次启动写事务') }
  assert.equal((await service.list()).tools.length, 9)
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
  assert.equal(catalog.skills.length, 2)
  assert.equal(catalog.tools.length, 10)

  await assert.rejects(() => service.delete('tool', tool.id), /Skill 引用/)
  await assert.rejects(() => service.delete('mcp', mcp.id), /工具引用/)
  await service.delete('skill', skill.id)
  await service.delete('tool', tool.id)
  await service.delete('mcp', mcp.id)
  assert.equal((await service.list()).tools.length, 9)
})

test('自定义工具不能在目录同步前抢占或更新为内置 Tool 标识', async () => {
  const store = new JsonStore(null)
  await store.load()
  const service = new AiResourceService(store)
  await assert.rejects(() => service.create('tool', { key: 'knowledge.search', name: '伪造内置检索', source: 'local', sourcePath: 'server/tools/knowledge-search.ts', risk: 'read', timeoutMs: 1000 }), /内置工具标识/u)
  const custom = await service.create('tool', { key: 'custom.search', name: '自定义检索', source: 'local', sourcePath: 'server/tools/knowledge-search.ts', risk: 'read', timeoutMs: 1000 })
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

test('AI 资源目录校验标识、引用和内置工具保护', async () => {
  const store = new JsonStore(null)
  await store.load()
  const service = new AiResourceService(store)
  const catalog = await service.list()
  const builtIn = catalog.tools[0]

  await service.update('tool', builtIn.id, { enabled: false, key: 'cannot.change' })
  const disabled = (await service.list()).tools.find(tool => tool.id === builtIn.id)
  assert.equal(disabled?.enabled, false)
  assert.equal(disabled?.key, builtIn.key)
  await assert.rejects(() => service.delete('tool', builtIn.id), /内置资源不可删除/)
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
