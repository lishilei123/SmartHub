import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
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
    const inherited = await store.resolveBinding('pv-v2', 'TC_LOGIN_001', 'ui')
    assert.equal(inherited?.bindingStatus, 'needs_validation')
    assert.equal(inherited?.inheritedFromProjectVersionId, 'pv-v1')
    await store.writeFiles('pv-v2', [{ path: 'pages/LoginPage.ts', content: 'export class LoginPage { changed = true }\n' }])
    assert.equal((await store.snapshot('pv-v1')).files.find(file => file.path === 'pages/LoginPage.ts')?.content, 'export class LoginPage {}\n')
    assert.equal((await store.snapshot('pv-v2')).files.find(file => file.path === 'pages/LoginPage.ts')?.content, 'export class LoginPage { changed = true }\n')
    assert.equal((await store.resolveBinding('pv-v2', 'TC_LOGIN_001', 'ui'))?.bindingStatus, 'invalid')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('同一 Case 的 UI 与 API Binding 使用复合身份并可同时复用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smarthub-execution-workspace-'))
  try {
    const store = new LocalExecutionWorkspaceStore(root)
    const caseId = 'CASE_DUAL_METHOD'
    const uiPath = 'tests/ui/dual-method.spec.ts'
    const apiPath = 'tests/api/dual-method.spec.ts'
    const uiSource = `import { test } from '@playwright/test'\ntest('双执行方式 UI [${caseId}]', async ({ page }) => { await page.goto('/') })\n`
    const apiSource = `import { test } from '@playwright/test'\ntest('双执行方式 API [${caseId}]', async ({ request }) => { await request.get('/') })\n`
    await store.writeFiles('pv-v1', [
      { path: uiPath, content: uiSource },
      { path: apiPath, content: apiSource },
    ])
    for (const [executionType, entryFile, source] of [
      ['ui', uiPath, uiSource],
      ['api', apiPath, apiSource],
    ] as const) {
      const dependencyFiles = [{ path: entryFile, contentSha256: hash(source) }]
      await store.saveBinding({
        projectVersionId: 'pv-v1', caseId, executionType,
        entryFile, entrySymbol: `[${caseId}]`, bindingStatus: 'validated',
        entrySha256: hash(source), caseContentSha256: '1'.repeat(64),
        dependencyFiles, dependencySha256: executionBindingDependencySha256(dependencyFiles),
        createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
      })
    }

    assert.equal((await store.resolveBinding('pv-v1', caseId, 'ui'))?.entryFile, uiPath)
    assert.equal((await store.resolveBinding('pv-v1', caseId, 'api'))?.entryFile, apiPath)
    assert.equal((await readdir(join(await store.ensure('pv-v1'), 'bindings'))).length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('旧单键 Binding 按已有 executionType 安全迁移到复合身份', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smarthub-execution-workspace-'))
  try {
    const store = new LocalExecutionWorkspaceStore(root)
    const projectVersionId = 'pv-legacy'
    const caseId = 'CASE_LEGACY_UI'
    const entryFile = 'tests/ui/legacy.spec.ts'
    const source = `import { test } from '@playwright/test'\ntest('旧入口 [${caseId}]', async () => {})\n`
    const dependencyFiles = [{ path: entryFile, contentSha256: hash(source) }]
    const workspace = await store.ensure(projectVersionId)
    await store.writeFiles(projectVersionId, [{ path: entryFile, content: source }])
    const legacyPath = join(workspace, 'bindings', `${hash(caseId).slice(0, 32)}.json`)
    await writeFile(legacyPath, JSON.stringify({
      projectVersionId, caseId, executionType: 'ui', entryFile,
      entrySymbol: `[${caseId}]`, bindingStatus: 'validated', entrySha256: hash(source),
      dependencyFiles, dependencySha256: executionBindingDependencySha256(dependencyFiles),
      caseContentSha256: '2'.repeat(64), createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    }, null, 2), { encoding: 'utf8' })

    assert.equal(await store.resolveBinding(projectVersionId, caseId, 'api'), null)
    assert.equal((await store.resolveBinding(projectVersionId, caseId, 'ui'))?.bindingStatus, 'validated')
    await assert.rejects(access(legacyPath))
    assert.equal((await readdir(join(workspace, 'bindings'))).length, 1)
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
    assert.equal((await store.resolveBinding('pv-v1', 'TC_API_001', 'api'))?.bindingStatus, 'invalid')
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
      store.writeBindingFiles('pv-v1', 'CASE_B', 'ui', [{ path, content: replacement }]),
      /TEST_EXECUTION_WORKSPACE_FILE_OWNERSHIP_CONFLICT/u,
    )
    assert.equal((await store.snapshot('pv-v1')).files.find(file => file.path === path)?.content, original)
    await store.writeBindingFiles('pv-v1', 'CASE_B', 'ui', [{ path, content: original }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('共享 spec 只允许追加当前 Case，并使其他 Case Binding 等待重新验证', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smarthub-execution-workspace-'))
  try {
    const store = new LocalExecutionWorkspaceStore(root)
    const path = 'tests/api/requirement-task-status.spec.ts'
    const original = `import { test } from '@playwright/test'\ntest('状态流转 [CASE_A]', async () => {})\n`
    const helperPath = 'helpers/task-record.ts'
    const helper = 'export const taskRecord = true\n'
    const shared = `import { test } from '@playwright/test'\nimport { taskRecord } from '../../helpers/task-record.js'\n${original.slice(original.indexOf("test('"))}test('拒绝非法回退 [CASE_B]', async () => { void taskRecord })\n`
    await store.writeFiles('pv-v1', [{ path, content: original }])
    const originalDependencies = [{ path, contentSha256: hash(original) }]
    await store.saveBinding({
      projectVersionId: 'pv-v1', caseId: 'CASE_A', executionType: 'api',
      entryFile: path, entrySymbol: '[CASE_A]', bindingStatus: 'validated',
      entrySha256: hash(original), caseContentSha256: 'd'.repeat(64),
      dependencyFiles: originalDependencies,
      dependencySha256: executionBindingDependencySha256(originalDependencies),
      createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
    })
    const sharedDependencies = [
      { path: helperPath, contentSha256: hash(helper) },
      { path, contentSha256: hash(shared) },
    ]
    await store.saveBindingImplementation({
      projectVersionId: 'pv-v1', caseId: 'CASE_B', executionType: 'api',
      entryFile: path, entrySymbol: '[CASE_B]', bindingStatus: 'validated',
      entrySha256: hash(shared), caseContentSha256: 'e'.repeat(64),
      dependencyFiles: sharedDependencies,
      dependencySha256: executionBindingDependencySha256(sharedDependencies),
      createdAt: '2026-08-24T00:01:00.000Z', updatedAt: '2026-08-24T00:01:00.000Z',
    }, [{ path: helperPath, content: helper }, { path, content: shared }], originalDependencies)

    const rebound = await store.resolveBinding('pv-v1', 'CASE_A', 'api')
    assert.equal(rebound?.bindingStatus, 'needs_validation')
    assert.equal(rebound?.entrySha256, hash(shared))
    assert.deepEqual(rebound?.dependencyFiles, sharedDependencies)
    assert.equal((await store.resolveBinding('pv-v1', 'CASE_B', 'api'))?.bindingStatus, 'validated')

    const mutated = `import { test } from '@playwright/test'\nimport { taskRecord } from '../../helpers/task-record.js'\ntest('状态流转 [CASE_A]', async () => { throw new Error('changed') })\ntest('拒绝非法回退 [CASE_B]', async () => { void taskRecord })\ntest('重复提交 [CASE_C]', async () => {})\n`
    const mutatedDependencies = [
      { path: helperPath, contentSha256: hash(helper) },
      { path, contentSha256: hash(mutated) },
    ]
    await assert.rejects(store.saveBindingImplementation({
      projectVersionId: 'pv-v1', caseId: 'CASE_C', executionType: 'api',
      entryFile: path, entrySymbol: '[CASE_C]', bindingStatus: 'validated',
      entrySha256: hash(mutated), caseContentSha256: 'f'.repeat(64),
      dependencyFiles: mutatedDependencies,
      dependencySha256: executionBindingDependencySha256(mutatedDependencies),
      createdAt: '2026-08-24T00:02:00.000Z', updatedAt: '2026-08-24T00:02:00.000Z',
    }, [{ path: helperPath, content: helper }, { path, content: mutated }], sharedDependencies), /TEST_EXECUTION_WORKSPACE_SHARED_ENTRY_CONFLICT/u)
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
