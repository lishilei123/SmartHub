import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalExecutionWorkspaceStore } from '../server/infrastructure/execution-workspace-store.js'

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

test('Execution Workspace 按 ProjectVersion 隔离 Binding，并保留共享自动化文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smarthub-execution-workspace-'))
  try {
    const store = new LocalExecutionWorkspaceStore(root)
    const source = `import { test, expect } from '@playwright/test'\ntest('TC_LOGIN_001', async () => { await expect(true).toBeTruthy() })\n`
    await store.writeFiles('pv-v1', [
      { path: 'tests/ui/login.spec.ts', content: source },
      { path: 'pages/LoginPage.ts', content: 'export class LoginPage {}\n' },
    ])
    await store.saveBinding({
      projectVersionId: 'pv-v1', caseId: 'TC_LOGIN_001', executionType: 'ui',
      entryFile: 'tests/ui/login.spec.ts', entrySymbol: 'TC_LOGIN_001',
      bindingStatus: 'validated', entrySha256: hash(source), caseContentSha256: 'a'.repeat(64),
      createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z',
    })
    await store.inherit('pv-v1', 'pv-v2')
    const inherited = await store.resolveBinding('pv-v2', 'TC_LOGIN_001')
    assert.equal(inherited?.bindingStatus, 'needs_validation')
    assert.equal(inherited?.inheritedFromProjectVersionId, 'pv-v1')
    await store.writeFiles('pv-v2', [{ path: 'pages/LoginPage.ts', content: 'export class LoginPage { changed = true }\n' }])
    assert.equal((await store.snapshot('pv-v1')).files.find(file => file.path === 'pages/LoginPage.ts')?.content, 'export class LoginPage {}\n')
    assert.equal((await store.snapshot('pv-v2')).files.find(file => file.path === 'pages/LoginPage.ts')?.content, 'export class LoginPage { changed = true }\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('缺失或漂移 Entry 会使 Binding 失效而不会静默重新生成', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smarthub-execution-workspace-'))
  try {
    const store = new LocalExecutionWorkspaceStore(root)
    const source = 'export const entry = true\n'
    await store.writeFiles('pv-v1', [{ path: 'tests/api/session.spec.ts', content: source }])
    await store.saveBinding({
      projectVersionId: 'pv-v1', caseId: 'TC_API_001', executionType: 'api',
      entryFile: 'tests/api/session.spec.ts', entrySymbol: 'TC_API_001', bindingStatus: 'validated',
      entrySha256: hash(source), caseContentSha256: 'b'.repeat(64), createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z',
    })
    await store.writeFiles('pv-v1', [{ path: 'tests/api/session.spec.ts', content: 'export const entry = false\n' }])
    assert.equal((await store.resolveBinding('pv-v1', 'TC_API_001'))?.bindingStatus, 'invalid')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
