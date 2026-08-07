import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('开发启动在创建 Worker 前执行 PowerShell 端口预检', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }
  const script = await readFile(new URL('../scripts/dev.ps1', import.meta.url), 'utf8')

  assert.equal(packageJson.scripts.dev, 'pwsh -NoProfile -File scripts/dev.ps1')
  assert.match(packageJson.scripts['dev:web'], /--port 5173 --strictPort/u)
  assert.match(script, /\$ErrorActionPreference = 'Stop'/u)
  assert.match(script, /Get-NetTCPConnection/u)
  assert.match(script, /\/api\/health/u)
  assert.match(script, /--strictPort/u)
  assert.doesNotMatch(script, /Stop-Process/u)
})
