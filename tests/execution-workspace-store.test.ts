import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  executionBindingDependencySha256,
  LocalExecutionWorkspaceStore,
} from '../server/infrastructure/execution-workspace-store.js'

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

test('Execution Workspace 按 ProjectVersion 隔离 Binding，并保留共享自动化文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smarthub-execution-workspace-'))
  try {
    const store = new LocalExecutionWorkspaceStore(root)
    const page = 'export class LoginPage {}\n'
    const source = `import { test, expect } from '@playwright/test'\nimport { LoginPage } from '../../pages/LoginPage'\ntest('登录成功 [TC_LOGIN_001]', async () => { await expect(LoginPage).toBeTruthy() })\n`
    await store.writeFiles('pv-v1', [
      { path: 'tests/ui/login.spec.ts', content: source },
      { path: 'pages/LoginPage.ts', content: page },
    ])
    const dependencyFiles = [
      { path: 'pages/LoginPage.ts', contentSha256: hash(page) },
      { path: 'tests/ui/login.spec.ts', contentSha256: hash(source) },
    ]
    await store.saveBinding({
      projectVersionId: 'pv-v1', caseId: 'TC_LOGIN_001', executionType: 'ui',
      entryFile: 'tests/ui/login.spec.ts', entrySymbol: '[TC_LOGIN_001]',
      bindingStatus: 'validated', entrySha256: hash(source), caseContentSha256: 'a'.repeat(64),
      dependencyFiles, dependencySha256: executionBindingDependencySha256(dependencyFiles),
      createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z',
    })
    await store.inherit('pv-v1', 'pv-v2')
    const inherited = await store.resolveBinding('pv-v2', 'TC_LOGIN_001')
    assert.equal(inherited?.bindingStatus, 'needs_validation')
    assert.equal(inherited?.inheritedFromProjectVersionId, 'pv-v1')
    await store.writeFiles('pv-v2', [{ path: 'pages/LoginPage.ts', content: 'export class LoginPage { changed = true }\n' }])
    assert.equal((await store.snapshot('pv-v1')).files.find(file => file.path === 'pages/LoginPage.ts')?.content, 'export class LoginPage {}\n')
    assert.equal((await store.snapshot('pv-v2')).files.find(file => file.path === 'pages/LoginPage.ts')?.content, 'export class LoginPage { changed = true }\n')
    assert.equal((await store.resolveBinding('pv-v2', 'TC_LOGIN_001'))?.bindingStatus, 'invalid')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('缺失或漂移 Entry 会使 Binding 失效而不会静默重新生成', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smarthub-execution-workspace-'))
  try {
    const store = new LocalExecutionWorkspaceStore(root)
    const source = `import { test } from '@playwright/test'\ntest('会话检查 [TC_API_001]', async () => {})\n`
    const dependencyFiles = [{ path: 'tests/api/session.spec.ts', contentSha256: hash(source) }]
    await store.writeFiles('pv-v1', [{ path: 'tests/api/session.spec.ts', content: source }])
    await store.saveBinding({
      projectVersionId: 'pv-v1', caseId: 'TC_API_001', executionType: 'api',
      entryFile: 'tests/api/session.spec.ts', entrySymbol: '[TC_API_001]', bindingStatus: 'validated',
      entrySha256: hash(source), caseContentSha256: 'b'.repeat(64), createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z',
      dependencyFiles, dependencySha256: executionBindingDependencySha256(dependencyFiles),
    })
    await store.writeFiles('pv-v1', [{ path: 'tests/api/session.spec.ts', content: 'export const entry = false\n' }])
    assert.equal((await store.resolveBinding('pv-v1', 'TC_API_001'))?.bindingStatus, 'invalid')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('一个 Case 不能覆盖另一个 Binding 已冻结的 Workspace 文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smarthub-execution-workspace-'))
  try {
    const store = new LocalExecutionWorkspaceStore(root)
    const path = 'tests/ui/invalid-task-status.spec.ts'
    const original = `import { test } from '@playwright/test'\ntest('拒绝跳级 [CASE_A]', async () => {})\n`
    const replacement = `import { test } from '@playwright/test'\ntest('拒绝回退 [CASE_B]', async () => {})\n`
    await store.writeFiles('pv-v1', [{ path, content: original }])
    const dependencyFiles = [{ path, contentSha256: hash(original) }]
    await store.saveBinding({
      projectVersionId: 'pv-v1', caseId: 'CASE_A', executionType: 'ui',
      entryFile: path, entrySymbol: '[CASE_A]', bindingStatus: 'validated',
      entrySha256: hash(original), caseContentSha256: 'c'.repeat(64),
      dependencyFiles, dependencySha256: executionBindingDependencySha256(dependencyFiles),
      createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
    })

    await assert.rejects(
      store.writeBindingFiles('pv-v1', 'CASE_B', [{ path, content: replacement }]),
      /TEST_EXECUTION_WORKSPACE_FILE_OWNERSHIP_CONFLICT/u,
    )
    assert.equal((await store.snapshot('pv-v1')).files.find(file => file.path === path)?.content, original)
    await store.writeBindingFiles('pv-v1', 'CASE_B', [{ path, content: original }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('storageState 只存在于 Run 临时目录，不进入 Snapshot 或 ProjectVersion 继承', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smarthub-execution-auth-'))
  try {
    const store = new LocalExecutionWorkspaceStore(root)
    const authRoot = await store.runtimeAuthRoot('pv-auth-v1', 'run-auth-1')
    await writeFile(join(authRoot, 'admin.json'), JSON.stringify({ cookies: [{ value: 'secret-token' }] }), { encoding: 'utf8' })
    assert.equal((await store.snapshot('pv-auth-v1')).files.some(file => file.path.includes('runtime-auth')), false)
    await store.inherit('pv-auth-v1', 'pv-auth-v2')
    const inheritedRoot = await store.ensure('pv-auth-v2')
    await assert.rejects(access(join(inheritedRoot, '.runtime-auth', 'run-auth-1', 'admin.json')))
    await store.cleanupRuntimeAuth('pv-auth-v1', 'run-auth-1')
    await assert.rejects(access(join(authRoot, 'admin.json')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
