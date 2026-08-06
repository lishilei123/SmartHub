import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'smarthub-ai-resources-'))
process.env.SMARTHUB_FORCE_JSON_STORE = 'true'
process.env.SMARTHUB_DATA_FILE = join(temporaryDirectory, 'state.json')
process.env.SMARTHUB_SKILL_ROOT = join(temporaryDirectory, 'skills')
const { start } = await import('../server/http/server.js')
delete process.env.SMARTHUB_FORCE_JSON_STORE
delete process.env.SMARTHUB_DATA_FILE
delete process.env.SMARTHUB_SKILL_ROOT

test('AI 资源 HTTP API 完成 MCP、工具、Skill 的管理闭环', async context => {
  context.after(async () => { await rm(temporaryDirectory, { recursive: true, force: true }) })
  const server = await start(0)
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const baseUrl = `http://127.0.0.1:${address.port}/api`
    const initial = await fetch(`${baseUrl}/ai-resources`)
    assert.equal(initial.status, 200)
    const initialCatalog = await initial.json() as { tools: Array<{ id: string; key: string; sourcePath: string }>; skills: Array<{ key: string }> }
    assert.equal(initialCatalog.tools.length, 9)
    assert.equal(new Set(initialCatalog.tools.map(tool => tool.sourcePath)).size, 6)
    assert.deepEqual(initialCatalog.skills.map(skill => skill.key), ['system.query-local-ip'])
    const searchTool = initialCatalog.tools.find(tool => tool.key === 'knowledge.search')!
    const sourceResponse = await fetch(`${baseUrl}/ai-resources/tool/${searchTool.id}/source`)
    assert.equal(sourceResponse.status, 200)
    const source = await sourceResponse.json() as { path: string; language: string; content: string; readOnly: boolean }
    assert.equal(source.path, 'server/tools/knowledge-search.ts')
    assert.equal(source.language, 'typescript')
    assert.equal(source.readOnly, true)
    assert.match(source.content, /registerKnowledgeSearchTool/u)

    const skillArchive = await new JSZip()
      .file('workflow/SKILL.md', '# HTTP ZIP Skill\n\n受控上传测试。')
      .file('workflow/skill-runtime.json', JSON.stringify({ scripts: [{ path: 'scripts/check.ps1', runner: 'powershell', timeoutMs: 5000 }] }))
      .file('workflow/scripts/check.ps1', "$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n'{}'")
      .file('workflow/references/guide.md', '只读参考资料')
      .generateAsync({ type: 'nodebuffer' })
    const packageResponse = await fetch(`${baseUrl}/ai-resources/skill-package`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'http.zip.skill', name: 'HTTP ZIP Skill', description: '测试受控 ZIP 上传', version: '1.0.0', enabled: true, toolIds: [], tags: ['zip'], fileName: 'http-zip-skill.zip', contentBase64: skillArchive.toString('base64') }) })
    assert.equal(packageResponse.status, 201)
    const packagedSkill = await packageResponse.json() as { id: string; status: string; version: string; entrypoint: string; toolIds: string[]; runtime: { scripts: Array<{ path: string }> }; package: { storageKey: string; entrypointPath: string; contentSha256: string; fileCount: number } }
    assert.equal(packagedSkill.status, 'ready')
    assert.equal(packagedSkill.package.storageKey, 'http.zip.skill/1.0.0')
    assert.equal(packagedSkill.package.entrypointPath, 'workflow/SKILL.md')
    assert.equal(packagedSkill.package.fileCount, 4)
    assert.deepEqual(packagedSkill.toolIds, [])
    assert.equal(packagedSkill.runtime.scripts[0].path, 'scripts/check.ps1')
    assert.match(packagedSkill.package.contentSha256, /^[a-f0-9]{64}$/u)
    assert.equal(packagedSkill.entrypoint, 'skill-package://http.zip.skill/1.0.0/workflow/SKILL.md')

    const packageUpdate = await fetch(`${baseUrl}/ai-resources/skill/${packagedSkill.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '已更新名称', version: '9.9.9', entrypoint: 'tampered/SKILL.md', package: { storageKey: 'spoofed' } }) })
    assert.equal(packageUpdate.status, 200)
    const updatedPackage = await packageUpdate.json() as { name: string; version: string; entrypoint: string; package: { storageKey: string } }
    assert.equal(updatedPackage.name, '已更新名称')
    assert.equal(updatedPackage.version, '1.0.0')
    assert.equal(updatedPackage.entrypoint, packagedSkill.entrypoint)
    assert.equal(updatedPackage.package.storageKey, packagedSkill.package.storageKey)

    const invalidArchive = await new JSZip().file('README.md', 'missing entrypoint').generateAsync({ type: 'nodebuffer' })
    const invalidPackage = await fetch(`${baseUrl}/ai-resources/skill-package`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'http.invalid.skill', name: 'Invalid', version: '1.0.0', fileName: 'invalid.zip', contentBase64: invalidArchive.toString('base64') }) })
    assert.equal(invalidPackage.status, 400)
    assert.match((await invalidPackage.json() as { error: string }).error, /一个 SKILL\.md/u)

    assert.equal((await fetch(`${baseUrl}/ai-resources/skill/${packagedSkill.id}`, { method: 'DELETE' })).status, 200)
    await assert.rejects(stat(join(temporaryDirectory, 'skills', 'http.zip.skill', '1.0.0')), { code: 'ENOENT' })

    const mcpResponse = await fetch(`${baseUrl}/ai-resources/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'http.test.mcp', name: 'HTTP Test MCP', description: '测试 MCP', version: '1.0.0', transport: 'streamable_http', endpoint: 'https://mcp.example.com/mcp', authType: 'none', toolIds: ['http.test.tool'] }) })
    assert.equal(mcpResponse.status, 201)
    const mcp = await mcpResponse.json() as { id: string }

    const toolResponse = await fetch(`${baseUrl}/ai-resources/tool`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'http.test.tool', name: 'HTTP Test Tool', description: '测试工具', version: '1.0.0', source: 'mcp', risk: 'network_read', timeoutMs: 10000, mcpServerId: mcp.id }) })
    assert.equal(toolResponse.status, 201)
    const tool = await toolResponse.json() as { id: string }

    const skillResponse = await fetch(`${baseUrl}/ai-resources/skill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'http.test.skill', name: 'HTTP Test Skill', description: '测试 Skill', version: '1.0.0', entrypoint: 'ai/skills/http-test/SKILL.md', toolIds: ['http.test.tool'], tags: ['test'] }) })
    assert.equal(skillResponse.status, 201)
    const skill = await skillResponse.json() as { id: string }

    const blocked = await fetch(`${baseUrl}/ai-resources/tool/${tool.id}`, { method: 'DELETE' })
    assert.equal(blocked.status, 400)
    assert.match((await blocked.json() as { error: string }).error, /Skill 引用/)

    assert.equal((await fetch(`${baseUrl}/ai-resources/skill/${skill.id}`, { method: 'DELETE' })).status, 200)
    assert.equal((await fetch(`${baseUrl}/ai-resources/tool/${tool.id}`, { method: 'DELETE' })).status, 200)
    assert.equal((await fetch(`${baseUrl}/ai-resources/mcp/${mcp.id}`, { method: 'DELETE' })).status, 200)
  } finally {
    await new Promise<void>((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()))
  }
})
