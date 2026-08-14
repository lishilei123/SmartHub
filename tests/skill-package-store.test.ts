import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import { SkillPackageStore } from '../server/infrastructure/skill-package-store.js'

test('SkillPackageStore 安全解包并生成不可变包元数据', async context => {
  const root = await mkdtemp(join(tmpdir(), 'smarthub-skill-package-'))
  context.after(async () => { await rm(root, { recursive: true, force: true }) })
  const store = new SkillPackageStore(root)
  const archive = await new JSZip()
    .file('superpowers/SKILL.md', '# Superpowers\n\nSkill instructions.')
    .file('superpowers/skill-runtime.json', JSON.stringify({ scripts: [{ path: 'scripts/run.ps1', runner: 'powershell', timeoutMs: 5000 }], network: { allowedOrigins: ['https://api.example.com'], allowedMethods: ['GET'], timeoutMs: 3000 } }))
    .file('superpowers/scripts/run.ps1', "$ErrorActionPreference = 'Stop'\n'{}'")
    .file('superpowers/references/rules.md', 'Rules')
    .generateAsync({ type: 'nodebuffer' })

  const installed = await store.install({ key: 'superpowers', version: '1.2.0', fileName: 'superpowers.zip', archive })
  assert.equal(installed.entrypoint, 'skill-package://superpowers/1.2.0/superpowers/SKILL.md')
  assert.equal(installed.package.fileCount, 4)
  assert.deepEqual(installed.package.files, ['superpowers/references/rules.md', 'superpowers/scripts/run.ps1', 'superpowers/skill-runtime.json', 'superpowers/SKILL.md'])
  assert.equal(installed.runtime?.scripts[0].path, 'scripts/run.ps1')
  assert.deepEqual(installed.runtime?.network?.allowedOrigins, ['https://api.example.com'])
  assert.match(installed.package.archiveSha256, /^[a-f0-9]{64}$/u)
  assert.match(installed.package.contentSha256, /^[a-f0-9]{64}$/u)
  assert.equal((await store.read(installed.package.storageKey, installed.package.entrypointPath)).toString('utf8').startsWith('# Superpowers'), true)

  await store.remove(installed.package.storageKey)
  await assert.rejects(stat(join(root, 'superpowers', '1.2.0')), { code: 'ENOENT' })
})

test('SkillPackageStore 拒绝路径穿越、原生可执行文件和无效入口', async context => {
  const root = await mkdtemp(join(tmpdir(), 'smarthub-skill-reject-'))
  context.after(async () => { await rm(root, { recursive: true, force: true }) })
  const store = new SkillPackageStore(root)

  const traversal = await new JSZip().file('../escape.md', 'escape').file('SKILL.md', '# Skill').generateAsync({ type: 'nodebuffer' })
  await assert.rejects(store.install({ key: 'bad.path', version: '1.0.0', fileName: 'bad.zip', archive: traversal }), /路径不安全/u)

  const executable = await new JSZip().file('SKILL.md', '# Skill').file('bin/setup.exe', 'binary').generateAsync({ type: 'nodebuffer' })
  await assert.rejects(store.install({ key: 'bad.exe', version: '1.0.0', fileName: 'bad.zip', archive: executable }), /原生可执行文件/u)

  const missing = await new JSZip().file('README.md', 'No entrypoint').generateAsync({ type: 'nodebuffer' })
  await assert.rejects(store.install({ key: 'bad.entry', version: '1.0.0', fileName: 'bad.zip', archive: missing }), /一个 SKILL\.md/u)

  const duplicate = await new JSZip().file('one/SKILL.md', '# One').file('two/SKILL.md', '# Two').generateAsync({ type: 'nodebuffer' })
  await assert.rejects(store.install({ key: 'bad.duplicate', version: '1.0.0', fileName: 'bad.zip', archive: duplicate }), /当前找到 2 个/u)

  const missingScript = await new JSZip().file('workflow/SKILL.md', '# Skill').file('workflow/skill-runtime.json', JSON.stringify({ scripts: [{ path: 'scripts/missing.ps1' }] })).generateAsync({ type: 'nodebuffer' })
  await assert.rejects(store.install({ key: 'bad.runtime', version: '1.0.0', fileName: 'bad.zip', archive: missingScript }), /运行脚本不存在/u)

})
