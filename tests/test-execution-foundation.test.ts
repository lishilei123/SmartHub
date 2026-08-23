import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { canonicalJson, canonicalSha256 } from '../server/application/canonical-json.js'
import {
  ConfiguredExecutionEnvironmentCatalog,
  executionEnvironmentProfilesFromJson,
} from '../server/application/test-execution-environment.js'
import {
  aggregateExecutionRunStatus,
  assertRunTransition,
  assertTaskTransition,
  automaticRepairAllowed,
  buildExecutionPackage,
  executionCreateRequestSha256,
  freezeExecutionTaskInput,
  scriptCacheKey,
  TestExecutionValidationError,
  unsupportedExecutionMethodReason,
  validateFailureDiagnosisCandidate,
} from '../server/application/test-execution-validation.js'
import type {
  ExecutionPackageCandidate,
  FrozenExecutionTestDataSnapshot,
  FrozenExecutionTaskInput,
} from '../server/domain/test-execution-types.js'
import type {
  TestCaseContent,
  TestCaseLibraryVersionMemberDetail,
  TestExecutionHandoffMember,
} from '../server/domain/test-design-types.js'
import {
  executionArtifactBody,
  LocalExecutionArtifactStore,
} from '../server/infrastructure/execution-artifact-store.js'

const caseContent: TestCaseContent = {
  schemaVersion: 'test-case/v3',
  title: '状态检查',
  dimension: 'functional',
  requirementRefs: ['point-status'],
  priority: 'P0',
  preconditions: ['已登录'],
  executionMethods: ['ui'],
  steps: ['打开状态页'],
  expectedResults: ['状态显示 Ready'],
}

const functionalSpec = { schemaVersion: 'test-script-input/v1' as const, method: 'ui' as const, testCase: caseContent }

const contentSha256 = canonicalSha256(caseContent)
const libraryMember: TestCaseLibraryVersionMemberDetail = {
  caseId: 'case-status',
  revision: 3,
  ordinal: 0,
  contentSha256,
  frozenContent: caseContent,
  traceability: {
    sourceRequirementReleaseId: 'release-1',
    requirementRefs: [{ requirementReleaseId: 'release-1', requirementId: 'point-status' }],
  },
  executionReadiness: 'ready',
}
const handoffMember: TestExecutionHandoffMember = {
  stage: 'smoke',
  ordinal: 0,
  sourceVersionId: 'library-version-1',
  caseId: 'case-status',
  revision: 3,
  method: 'ui',
  reason: '核心冒烟',
  dedupKey: 'case-status:3:ui',
  dimension: 'functional',
  executionSpec: functionalSpec,
  traceability: libraryMember.traceability,
  contentSha256,
}

const validSource = `import { test, expect } from '@playwright/test'

test('状态检查 [case-status]', async ({ page }) => {
  await page.goto('/status')
  // smarthub:assert expected-1
  await expect(page.locator('[data-testid="status"]')).toHaveText('Ready')
})
`

function taskInput(): FrozenExecutionTaskInput & { taskId: string } {
  return { ...freezeExecutionTaskInput({ handoffMember, libraryMember }), taskId: 'task-status' }
}

function apiTaskInput(): FrozenExecutionTaskInput & { taskId: string } {
  const apiContent: TestCaseContent = {
    ...caseContent,
    title: '登录 API 状态校验',
    executionMethods: ['api'],
    steps: ['调用登录接口'],
    expectedResults: ['未授权请求返回 HTTP 403'],
  }
  const apiContentSha256 = canonicalSha256(apiContent)
  const apiLibraryMember: TestCaseLibraryVersionMemberDetail = {
    ...libraryMember,
    caseId: 'TC_API_LOGIN_001',
    contentSha256: apiContentSha256,
    frozenContent: apiContent,
  }
  const apiHandoffMember: TestExecutionHandoffMember = {
    ...handoffMember,
    caseId: 'TC_API_LOGIN_001',
    method: 'api',
    dedupKey: 'TC_API_LOGIN_001:3:api',
    contentSha256: apiContentSha256,
    executionSpec: {
      schemaVersion: 'test-script-input/v1',
      method: 'api',
      testCase: apiContent,
    },
  }
  return {
    ...freezeExecutionTaskInput({ handoffMember: apiHandoffMember, libraryMember: apiLibraryMember }),
    taskId: 'task-api-login',
  }
}

function candidate(source = validSource): ExecutionPackageCandidate {
  return {
    entryFile: 'tests/ui/task-status.spec.ts',
    files: [{ path: 'tests/ui/task-status.spec.ts', content: source }],
    summary: '执行状态检查',
  }
}

function validationCode(error: unknown, code: string) {
  return error instanceof TestExecutionValidationError && error.code === code
}

test('canonical JSON 保留 JavaScript 数值词法并拒绝 PostgreSQL 重序列化等价替代', () => {
  const canonical = canonicalJson({ threshold: 1e-7 })
  assert.equal(canonical, '{"threshold":1e-7}')
  assert.notEqual(canonical, '{"threshold":0.0000001}')
  assert.equal(
    canonicalSha256({ threshold: 1e-7 }),
    createHash('sha256').update(canonical, 'utf8').digest('hex'),
  )
})

test('创建请求身份忽略服务端生成事实，但绑定项目版本、Handoff、环境与创建者', () => {
  const base = {
    projectVersionId: 'project-version-one',
    handoff: {
      handoffId: 'handoff-one',
      handoffSha256: 'a'.repeat(64),
      projectId: 'project-one',
      projectVersionId: 'project-version-one',
      testCaseLibraryVersionId: 'library-version-one',
      testCaseLibraryVersionSha256: 'b'.repeat(64),
      mode: 'full' as const,
      memberSnapshotSha256: 'c'.repeat(64),
    },
    environment: {
      environmentId: 'environment-one',
      name: '环境一',
      baseUrl: 'https://example.test',
      targets: [{ protocol: 'https' as const, host: 'example.test', port: 443 }],
      signature: 'd'.repeat(64),
    },
    createdBy: 'user-one',
  }
  const identity = executionCreateRequestSha256(base)
  assert.equal(
    executionCreateRequestSha256({
      ...base,
      environment: {
        ...base.environment,
        signature: 'f'.repeat(64),
      },
    }),
    identity,
  )
  assert.notEqual(
    executionCreateRequestSha256({
      ...base,
      environment: {
        ...base.environment,
        environmentId: 'environment-two',
      },
    }),
    identity,
  )
})

test('执行状态迁移由显式状态图约束，终态聚合不会把 unsupported 当作成功', () => {
  assert.doesNotThrow(() => assertRunTransition('queued', 'running'))
  assert.throws(() => assertRunTransition('queued', 'succeeded'), error => validationCode(error, 'TEST_EXECUTION_RUN_TRANSITION_INVALID'))
  assert.doesNotThrow(() => assertTaskTransition('running', 'retrying'))
  assert.throws(() => assertTaskTransition('pending', 'passed'), error => validationCode(error, 'TEST_EXECUTION_TASK_TRANSITION_INVALID'))
  assert.equal(aggregateExecutionRunStatus(['passed', 'passed']), 'succeeded')
  assert.equal(aggregateExecutionRunStatus(['failed', 'failed']), 'failed')
  assert.equal(aggregateExecutionRunStatus(['unsupported', 'unsupported']), 'partial')
  assert.equal(aggregateExecutionRunStatus(['passed', 'unsupported']), 'partial')
  assert.equal(aggregateExecutionRunStatus(['cancelled', 'cancelled']), 'cancelled')
  assert.equal(aggregateExecutionRunStatus(['passed', 'running']), 'running')
  assert.match(unsupportedExecutionMethodReason('performance_tool') ?? '', /不支持/u)
  assert.equal(unsupportedExecutionMethodReason('ui'), undefined)
})

test('任务冻结只接受同一正式用例库成员，并逐项冻结本次 Run 的测试数据供给', () => {
  const frozen = freezeExecutionTaskInput({ handoffMember, libraryMember })
  assert.equal(frozen.caseContentSha256, contentSha256)
  assert.equal(frozen.executionSpecSha256, canonicalSha256(functionalSpec))
  const { inputSha256, ...snapshot } = frozen
  assert.equal(inputSha256, canonicalSha256(snapshot))

  const requirement = {
    id: 'data-status-user',
    name: '状态页用户',
    entityType: 'user',
    featureTags: ['status'],
    caseIds: ['case-status'],
    fieldConstraints: { role: 'operator' },
    relationships: [],
    quantity: 1,
    initialState: 'active',
    preparationHint: '使用受控 fixture',
    sensitivity: 'internal' as const,
    isolation: 'per-run',
    resetAndCleanup: '运行后删除',
    readiness: 'ready' as const,
  }
  const testDataBase = {
    sourceSetId: 'data-set-status',
    sourceSetVersion: 2,
    sourceSetSha256: canonicalSha256([requirement]),
    requirementSnapshotSha256: canonicalSha256([requirement]),
    requirements: [requirement],
    bindings: [{ requirementId: requirement.id, sourceType: 'fixture' as const, sourceRef: 'fixture://project/status-user/v2' }],
  }
  const testData: FrozenExecutionTestDataSnapshot = {
    ...testDataBase,
    contentSha256: canonicalSha256(testDataBase),
  }
  const dataFrozen = freezeExecutionTaskInput({ handoffMember, libraryMember, testData })
  assert.equal(dataFrozen.testDataBindings, undefined)
  assert.equal(dataFrozen.inputSha256, frozen.inputSha256)
})

test('任务冻结拒绝损坏的内容 Hash 与 Handoff 执行规范漂移', () => {
  assert.throws(
    () => freezeExecutionTaskInput({ handoffMember: { ...handoffMember, contentSha256: 'a'.repeat(64) }, libraryMember }),
    error => validationCode(error, 'TEST_EXECUTION_HANDOFF_CONTENT_HASH_MISMATCH'),
  )
  const changedSpec = { ...functionalSpec, testCase: { ...caseContent, expectedResults: ['已漂移'] } }
  assert.throws(
    () => freezeExecutionTaskInput({ handoffMember: { ...handoffMember, executionSpec: changedSpec }, libraryMember }),
    error => validationCode(error, 'TEST_EXECUTION_SPEC_HASH_MISMATCH'),
  )
})

test('ExecutionPackage 使用固定入口、内容 Hash、断言契约与规范化 package Hash', () => {
  const task = taskInput()
  const first = buildExecutionPackage({ candidate: candidate(), task, environmentSignature: 'environment-signature-1' })
  const second = buildExecutionPackage({ candidate: candidate(), task, environmentSignature: 'environment-signature-1' })
  assert.equal(first.manifest.entrypoint, 'tests/ui/task-status.spec.ts')
  assert.equal(first.manifest.packageSha256, second.manifest.packageSha256)
  assert.equal(first.manifest.assertions[0].verificationCheckKey, 'expected-1')
  assert.equal(first.files[0].contentSha256, createHash('sha256').update(validSource).digest('hex'))
  assert.notEqual(
    scriptCacheKey({ caseId: 'case-status', caseRevision: 3, method: 'ui', caseContentSha256: contentSha256, executionSpecSha256: task.executionSpecSha256, environmentSignature: 'one', executionImplementationAgentVersion: 1, executionImplementationAgentConfigurationSha256: 'b'.repeat(64) }),
    scriptCacheKey({ caseId: 'case-status', caseRevision: 3, method: 'ui', caseContentSha256: contentSha256, executionSpecSha256: task.executionSpecSha256, environmentSignature: 'two', executionImplementationAgentVersion: 1, executionImplementationAgentConfigurationSha256: 'b'.repeat(64) }),
  )
  assert.notEqual(
    scriptCacheKey({ caseId: 'case-status', caseRevision: 3, method: 'ui', caseContentSha256: contentSha256, executionSpecSha256: task.executionSpecSha256, taskInputSha256: 'c'.repeat(64), environmentSignature: 'one', executionImplementationAgentVersion: 1, executionImplementationAgentConfigurationSha256: 'b'.repeat(64) }),
    scriptCacheKey({ caseId: 'case-status', caseRevision: 3, method: 'ui', caseContentSha256: contentSha256, executionSpecSha256: task.executionSpecSha256, taskInputSha256: 'd'.repeat(64), environmentSignature: 'one', executionImplementationAgentVersion: 1, executionImplementationAgentConfigurationSha256: 'b'.repeat(64) }),
  )
})

test('ExecutionPackage 入口必须以固定 Case 符号结尾且只能精确命中一个 test', () => {
  const task = taskInput()
  for (const source of [
    validSource.replace('状态检查 [case-status]', '状态检查 case-status'),
    validSource.replace('[case-status]', '[case-status-similar]'),
    `${validSource}\n${validSource.replace('状态检查 [case-status]', '另一个状态检查 [case-status]')}`,
  ]) {
    assert.throws(
      () => buildExecutionPackage({ candidate: candidate(source), task, environmentSignature: 'env' }),
      error => validationCode(error, 'TEST_EXECUTION_SCRIPT_UNSAFE'),
    )
  }
})

test('ExecutionPackage 拒绝路径逃逸、额外入口、动态导入与 Node 运行时能力', () => {
  const task = taskInput()
  assert.throws(
    () => buildExecutionPackage({ candidate: { ...candidate(), files: [{ path: '../task.spec.ts', content: validSource }] }, task, environmentSignature: 'env' }),
    error => validationCode(error, 'TEST_EXECUTION_PACKAGE_PATH_INVALID'),
  )
  assert.throws(
    () => buildExecutionPackage({ candidate: { ...candidate(), files: [...candidate().files, { path: 'tests/extra.ts', content: 'export {}' }] }, task, environmentSignature: 'env' }),
    error => validationCode(error, 'TEST_EXECUTION_WORKSPACE_FILE_UNREACHABLE'),
  )
  for (const unsafe of [
    `${validSource}\nvoid import('node:fs')`,
    `${validSource}\nprocess.exit(0)`,
    `import { test, expect } from '@playwright/test'\nimport { exec } from 'node:child_process'\n${validSource.split('\n').slice(2).join('\n')}`,
    `${validSource}\neval('1')`,
  ]) {
    assert.throws(
      () => buildExecutionPackage({ candidate: candidate(unsafe), task, environmentSignature: 'env' }),
      error => validationCode(error, 'TEST_EXECUTION_SCRIPT_UNSAFE'),
    )
  }
})

test('API Case 使用 request fixture 并冻结可复用 APIRequestContext Client 依赖闭包', () => {
  const task = apiTaskInput()
  const entryFile = 'tests/api/login.spec.ts'
  const clientFile = 'api/auth-client.ts'
  const clientSource = `import type { APIRequestContext } from '@playwright/test'

export class AuthClient {
  constructor(private readonly request: APIRequestContext) {}
  login() { return this.request.post('/api/login', { data: { username: 'fixture-user' } }) }
}
`
  const entrySource = `import { test, expect } from '@playwright/test'
import { AuthClient } from '../../api/auth-client.js'

test('API 登录 [TC_API_LOGIN_001]', async ({ request }) => {
  const response = await new AuthClient(request).login()
  // smarthub:assert expected-1
  expect(response.status()).toBe(403)
})
`
  const executionPackage = buildExecutionPackage({
    candidate: {
      entryFile,
      files: [{ path: entryFile, content: entrySource }],
      summary: '复用 AuthClient 的 API Case',
    },
    task,
    environmentSignature: 'environment-api',
    workspaceFiles: [{ path: clientFile, content: clientSource }],
  })
  assert.equal(executionPackage.manifest.entrypoint, entryFile)
  assert.deepEqual(executionPackage.files.map(file => file.path), [clientFile, entryFile])
  assert.equal(executionPackage.manifest.assertions[0].matcher, 'toBe')
})

test('API Validator 拒绝其他 HTTP Client、硬编码 Host、fetch 与不安全相对导入', () => {
  const task = apiTaskInput()
  const entryFile = 'tests/api/login.spec.ts'
  const entry = (extraImport: string, requestExpression: string) => `import { test, expect } from '@playwright/test'
${extraImport}
test('API 登录 [TC_API_LOGIN_001]', async ({ request }) => {
  const response = ${requestExpression}
  // smarthub:assert expected-1
  expect(response.status()).toBe(403)
})
`
  const build = (source: string, workspaceFiles: Array<{ path: string; content: string }> = []) => buildExecutionPackage({
    candidate: {
      entryFile,
      files: [{ path: entryFile, content: source }],
      summary: 'API Validator',
    },
    task,
    environmentSignature: 'environment-api',
    workspaceFiles,
  })
  for (const source of [
    entry("import axios from 'axios'", "await axios.get('/api/login')"),
    entry('', "await request.get('https://production.example.test/api/login')"),
    entry('', "await fetch('/api/login')"),
    entry("import { exec } from 'node:child_process'", "await request.get('/api/login')"),
  ]) {
    assert.throws(() => build(source), error => validationCode(error, 'TEST_EXECUTION_SCRIPT_UNSAFE'))
  }
  assert.throws(
    () => build(entry("import { AuthClient } from '../../api/missing'", 'await new AuthClient(request).login()')),
    error => validationCode(error, 'TEST_EXECUTION_WORKSPACE_IMPORT_UNRESOLVED'),
  )
  assert.throws(
    () => build(entry("import { helper } from '../../../foreign'", 'await helper(request)')),
    error => validationCode(error, 'TEST_EXECUTION_WORKSPACE_IMPORT_ESCAPE'),
  )
  assert.throws(
    () => build(
      entry("import { AuthClient } from '../../api/auth-client'", 'await new AuthClient(request).login()'),
      [{
        path: 'api/auth-client.ts',
        content: `import { expect, type APIRequestContext } from '@playwright/test'\nexport class AuthClient { constructor(private request: APIRequestContext) {} async login() { const response = await this.request.post('/api/login'); expect(response.status()).toBe(403); return response } }\n`,
      }],
    ),
    error => validationCode(error, 'TEST_EXECUTION_SCRIPT_UNSAFE'),
  )
})

test('UI Case 必须使用 page 完成 UI 目标，但允许 request 辅助准备', () => {
  const task = taskInput()
  const requestOnly = `import { test, expect } from '@playwright/test'
test('状态检查 [case-status]', async ({ request }) => {
  const response = await request.get('/api/status')
  // smarthub:assert expected-1
  expect(response.ok()).toBeTruthy()
})
`
  assert.throws(
    () => buildExecutionPackage({ candidate: candidate(requestOnly), task, environmentSignature: 'env' }),
    error => validationCode(error, 'TEST_EXECUTION_SCRIPT_UNSAFE'),
  )
  const mixed = `import { test, expect } from '@playwright/test'
test('状态检查 [case-status]', async ({ page, request }) => {
  await request.post('/api/setup')
  await page.goto('/status')
  // smarthub:assert expected-1
  await expect(page.locator('[data-testid="status"]')).toHaveText('Ready')
})
`
  assert.doesNotThrow(
    () => buildExecutionPackage({ candidate: candidate(mixed), task, environmentSignature: 'env' }),
  )
})

test('普通业务 Case 可复用 Run 临时认证 Fixture，认证敏感 Case 必须使用 fresh/anonymous Context', () => {
  const sharedFixture = `import { test as base, expect } from '@playwright/test'
export const test = base.extend({
  storageState: async ({}, use, testInfo) => {
    const directory = (testInfo.config.metadata as { smarthubAuthState: { directory: string } }).smarthubAuthState.directory
    await use(directory + '/shared.json')
  },
})
export { expect }
`
  const ordinaryEntry = `import { test, expect } from '../../fixtures/auth-fixture.js'
test('状态检查 [case-status]', async ({ page }) => {
  await page.goto('/status')
  // smarthub:assert expected-1
  await expect(page.locator('[data-testid="status"]')).toHaveText('Ready')
})
`
  assert.doesNotThrow(() => buildExecutionPackage({
    candidate: {
      ...candidate(ordinaryEntry),
      files: [
        { path: 'fixtures/auth-fixture.ts', content: sharedFixture },
        { path: 'tests/ui/task-status.spec.ts', content: ordinaryEntry },
      ],
    },
    task: taskInput(),
    environmentSignature: 'env',
  }))

  const authTask = apiTaskInput()
  const sharedAuthEntry = `import { test, expect } from '../../fixtures/auth-fixture.js'
test('API 登录 [TC_API_LOGIN_001]', async ({ request }) => {
  const response = await request.post('/api/login')
  // smarthub:assert expected-1
  expect(response.status()).toBe(403)
})
`
  assert.throws(() => buildExecutionPackage({
    candidate: {
      entryFile: 'tests/api/login.spec.ts',
      files: [
        { path: 'fixtures/auth-fixture.ts', content: sharedFixture },
        { path: 'tests/api/login.spec.ts', content: sharedAuthEntry },
      ],
      summary: '错误复用共享认证态',
    },
    task: authTask,
    environmentSignature: 'env',
  }), error => validationCode(error, 'TEST_EXECUTION_SCRIPT_UNSAFE'))

  const anonymousEntry = `import { test, expect } from '@playwright/test'
test.use({ storageState: undefined })
test('匿名访问 [TC_API_LOGIN_001]', async ({ request }) => {
  const response = await request.get('/api/session')
  // smarthub:assert expected-1
  expect(response.status()).toBe(403)
})
`
  assert.doesNotThrow(() => buildExecutionPackage({
    candidate: {
      entryFile: 'tests/api/login.spec.ts', files: [{ path: 'tests/api/login.spec.ts', content: anonymousEntry }],
      summary: '显式匿名 Context',
    },
    task: authTask,
    environmentSignature: 'env',
  }))
  assert.throws(() => buildExecutionPackage({
    candidate: {
      entryFile: 'tests/api/login.spec.ts',
      files: [{ path: 'tests/api/login.spec.ts', content: anonymousEntry.replace('storageState: undefined', "storageState: 'shared.json'") }],
      summary: '匿名 Case 错误加载共享状态',
    },
    task: authTask,
    environmentSignature: 'env',
  }), error => validationCode(error, 'TEST_EXECUTION_SCRIPT_UNSAFE'))
})

test('持久化 Expected Result 强制 API 回读，Repair 不能删除业务闭环', () => {
  const persistentContent: TestCaseContent = {
    ...caseContent,
    title: '更新状态并回读',
    executionMethods: ['api'],
    steps: ['更新状态'],
    expectedResults: ['状态持久化，重新查询后仍为 done'],
  }
  const persistentSha256 = canonicalSha256(persistentContent)
  const task = {
    ...freezeExecutionTaskInput({
      libraryMember: {
        ...libraryMember,
        caseId: 'case-persisted-status',
        contentSha256: persistentSha256,
        frozenContent: persistentContent,
      },
      handoffMember: {
        ...handoffMember,
        caseId: 'case-persisted-status',
        method: 'api',
        dedupKey: 'case-persisted-status:3:api',
        contentSha256: persistentSha256,
        executionSpec: { schemaVersion: 'test-script-input/v1', method: 'api', testCase: persistentContent },
      },
    }),
    taskId: 'task-persisted-status',
  }
  const entryFile = 'tests/api/persisted-status.spec.ts'
  const source = (readBack: boolean) => `import { test, expect } from '@playwright/test'
test('更新状态并回读 [case-persisted-status]', async ({ request }) => {
  const mutation = await request.post('/api/status', { data: { status: 'done' } })
  ${readBack ? "const persisted = await request.get('/api/status')" : 'const persisted = mutation'}
  // smarthub:assert expected-1
  expect(await persisted.json()).toMatchObject({ status: 'done' })
})
`
  const build = (content: string, baselineAssertions?: ReturnType<typeof buildExecutionPackage>['manifest']['assertions']) => buildExecutionPackage({
    candidate: {
      entryFile,
      files: [{ path: entryFile, content }],
      summary: '持久化闭环',
    },
    task,
    environmentSignature: 'env',
    ...(baselineAssertions ? { baselineAssertions } : {}),
  })
  assert.throws(() => build(source(false)), error => validationCode(error, 'TEST_EXECUTION_SCRIPT_UNSAFE'))
  const baseline = build(source(true))
  assert.throws(() => build(source(false), baseline.manifest.assertions), error => validationCode(error, 'TEST_EXECUTION_SCRIPT_UNSAFE'))
  assert.throws(
    () => build(source(false).replace("const mutation = await request.post('/api/status', { data: { status: 'done' } })", "await request.get('/api/status')\n  const mutation = await request.post('/api/status', { data: { status: 'done' } })")),
    error => validationCode(error, 'TEST_EXECUTION_SCRIPT_UNSAFE'),
  )
})

test('API Repair 不能将受保护 HTTP 403 业务断言改为 200', () => {
  const task = apiTaskInput()
  const entryFile = 'tests/api/login.spec.ts'
  const source = (status: number) => `import { test, expect } from '@playwright/test'
test('API 登录 [TC_API_LOGIN_001]', async ({ request }) => {
  const response = await request.post('/api/login')
  // smarthub:assert expected-1
  expect(response.status()).toBe(${status})
})
`
  const baseline = buildExecutionPackage({
    candidate: { entryFile, files: [{ path: entryFile, content: source(403) }], summary: 'baseline' },
    task,
    environmentSignature: 'env',
  })
  assert.throws(() => buildExecutionPackage({
    candidate: { entryFile, files: [{ path: entryFile, content: source(200) }], summary: 'weaken assertion' },
    task,
    environmentSignature: 'env',
    baselineAssertions: baseline.manifest.assertions,
  }), error => validationCode(error, 'TEST_EXECUTION_PROTECTED_ASSERTION_CHANGED'))
})

test('脚本修复可变更 selector，但不能更改受保护断言语义', () => {
  const task = taskInput()
  const baseline = buildExecutionPackage({ candidate: candidate(), task, environmentSignature: 'env' })
  const selectorRepair = validSource.replace('[data-testid="status"]', '[aria-label="service status"]')
  assert.doesNotThrow(() => buildExecutionPackage({
    candidate: candidate(selectorRepair),
    task,
    environmentSignature: 'env',
    baselineAssertions: baseline.manifest.assertions,
  }))
  const weakened = validSource.replace("toHaveText('Ready')", "toContainText('Ready')")
  assert.throws(
    () => buildExecutionPackage({ candidate: candidate(weakened), task, environmentSignature: 'env', baselineAssertions: baseline.manifest.assertions }),
    error => validationCode(error, 'TEST_EXECUTION_PROTECTED_ASSERTION_CHANGED'),
  )
  const changedExpected = validSource.replace("toHaveText('Ready')", "toHaveText('Anything')")
  assert.throws(
    () => buildExecutionPackage({ candidate: candidate(changedExpected), task, environmentSignature: 'env', baselineAssertions: baseline.manifest.assertions }),
    error => validationCode(error, 'TEST_EXECUTION_PROTECTED_ASSERTION_CHANGED'),
  )
})

test('FailureAnalysisAgent 只提交最小分类，自动修复策略由服务端固定', () => {
  const diagnosisCandidate = {
    category: 'selector_changed',
    reason: '登录按钮 selector 已变化',
    evidence: 'Playwright 无法定位原登录按钮',
  }
  const diagnosis = validateFailureDiagnosisCandidate(diagnosisCandidate)
  assert.deepEqual(diagnosis, diagnosisCandidate)
  assert.equal(automaticRepairAllowed(diagnosis, 0), true)
  assert.equal(automaticRepairAllowed(diagnosis, 2), false)
  assert.equal(automaticRepairAllowed({ category: 'product_defect' }, 0), false)
  assert.equal(automaticRepairAllowed({ category: 'assertion_mismatch' }, 0), false)
  assert.equal(automaticRepairAllowed({ category: 'unknown' }, 0), false)
  assert.throws(
    () => validateFailureDiagnosisCandidate({ ...diagnosisCandidate, repairable: true }),
    error => validationCode(error, 'TEST_EXECUTION_DIAGNOSIS_SYSTEM_FIELD_FORBIDDEN'),
  )
  assert.throws(
    () => validateFailureDiagnosisCandidate({ ...diagnosisCandidate, schemaVersion: 'failure-analysis/v0' }),
    error => validationCode(error, 'TEST_EXECUTION_DIAGNOSIS_SCHEMA_INVALID'),
  )
})

test('执行环境快照不含 secret，且只在签名一致的 Runner 启动边界解析', async () => {
  const sourceName = 'SMARTHUB_TEST_EXECUTION_SECRET_SOURCE'
  const previous = process.env[sourceName]
  delete process.env[sourceName]
  try {
    const catalog = new ConfiguredExecutionEnvironmentCatalog(
      executionEnvironmentProfilesFromJson(JSON.stringify([{
        environmentId: 'environment-test',
        name: '隔离测试环境',
        baseUrl: 'https://EXAMPLE.test/status',
        targets: [{ protocol: 'https', host: 'EXAMPLE.test', port: 443 }],
        networkName: 'smarthub-test-network',
        secretEnvironmentVariables: {
          SMARTHUB_SECRET_TOKEN: sourceName,
        },
      }])),
    )
    assert.deepEqual(await catalog.readiness(), {
      ready: false,
      reason: 'TEST_EXECUTION_ENVIRONMENT_SECRETS_UNAVAILABLE',
    })
    const snapshot = await catalog.resolveSnapshotForBaseUrl('https://EXAMPLE.test/status')
    assert.deepEqual(snapshot, {
      environmentId: 'environment-test',
      name: '隔离测试环境',
      baseUrl: 'https://example.test/status',
      targets: [{ protocol: 'https', host: 'example.test', port: 443 }],
      signature: snapshot.signature,
    })
    await assert.rejects(
      catalog.resolveSnapshotForBaseUrl('https://unregistered.example.test/'),
      /TEST_EXECUTION_ENVIRONMENT_NOT_REGISTERED/u,
    )
    assert.equal(JSON.stringify(snapshot).includes(sourceName), false)
    assert.deepEqual(catalog.networkPolicies(), {
      [snapshot.signature]: 'smarthub-test-network',
    })
    await assert.rejects(
      catalog.resolveForLaunch({
        environmentId: snapshot.environmentId,
        environmentSignature: snapshot.signature,
      }, new AbortController().signal),
      /TEST_EXECUTION_SECRET_UNAVAILABLE/u,
    )
    process.env[sourceName] = 'launch-only-secret-value'
    assert.deepEqual(await catalog.readiness(), { ready: true })
    assert.deepEqual(await catalog.resolveForLaunch({
      environmentId: snapshot.environmentId,
      environmentSignature: snapshot.signature,
    }, new AbortController().signal), {
      SMARTHUB_SECRET_TOKEN: 'launch-only-secret-value',
    })
    await assert.rejects(
      catalog.resolveForLaunch({
        environmentId: snapshot.environmentId,
        environmentSignature: 'f'.repeat(64),
      }, new AbortController().signal),
      /TEST_EXECUTION_ENVIRONMENT_SNAPSHOT_DRIFT/u,
    )
  } finally {
    if (previous === undefined) delete process.env[sourceName]
    else process.env[sourceName] = previous
  }
})

test('执行环境 readiness 要求至少一个服务端配置', async () => {
  assert.deepEqual(
    await new ConfiguredExecutionEnvironmentCatalog([]).readiness(),
    {
      ready: false,
      reason: 'TEST_EXECUTION_ENVIRONMENT_NOT_CONFIGURED',
    },
  )
})

test('执行环境拒绝未声明 base URL、重复目标和不安全 secret 映射', () => {
  assert.throws(() => new ConfiguredExecutionEnvironmentCatalog([{
    environmentId: 'environment-test',
    name: '隔离测试环境',
    baseUrl: 'https://foreign.test/',
    targets: [{ protocol: 'https', host: 'example.test', port: 443 }],
    networkName: 'smarthub-test-network',
  }]), /TEST_EXECUTION_ENVIRONMENT_BASE_URL_NOT_ALLOWED/u)
  assert.throws(() => new ConfiguredExecutionEnvironmentCatalog([{
    environmentId: 'environment-test',
    name: '隔离测试环境',
    baseUrl: 'https://example.test/',
    targets: [
      { protocol: 'https', host: 'example.test', port: 443 },
      { protocol: 'https', host: 'EXAMPLE.test', port: 443 },
    ],
    networkName: 'smarthub-test-network',
  }]), /TEST_EXECUTION_ENVIRONMENT_TARGET_DUPLICATE/u)
  assert.throws(() => new ConfiguredExecutionEnvironmentCatalog([{
    environmentId: 'environment-test',
    name: '隔离测试环境',
    baseUrl: 'https://example.test/',
    targets: [{ protocol: 'https', host: 'example.test', port: 443 }],
    networkName: 'smarthub-test-network',
    secretEnvironmentVariables: { PATH: 'PATH' },
  }]), /TEST_EXECUTION_SECRET_NAME_INVALID/u)
})

test('Artifact Store readiness 必须能在受控 staging 目录真实写入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smarthub-artifact-readiness-'))
  try {
    await writeFile(join(root, '.staging'), 'not-a-directory')
    assert.deepEqual(
      await new LocalExecutionArtifactStore(root).readiness(),
      {
        ready: false,
        reason: 'TEST_EXECUTION_ARTIFACT_STORE_UNAVAILABLE',
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('LocalExecutionArtifactStore 流式写入、按内容寻址并拒绝路径逃逸', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smarthub-execution-artifacts-'))
  try {
    const store = new LocalExecutionArtifactStore(root)
    assert.deepEqual(await store.readiness(), { ready: true })
    const stored = await store.put({ body: executionArtifactBody('real runner log'), mimeType: 'text/plain; charset=utf-8' })
    assert.equal(stored.sha256, createHash('sha256').update('real runner log').digest('hex'))
    const duplicate = await store.put({ body: executionArtifactBody('real runner log'), mimeType: 'text/plain; charset=utf-8' })
    assert.equal(duplicate.storagePath, stored.storagePath)
    assert.deepEqual(await store.stat(stored.storagePath), { storagePath: stored.storagePath, sha256: stored.sha256, size: stored.size })
    let content = ''
    for await (const chunk of await store.open(stored.storagePath)) content += Buffer.from(chunk).toString('utf8')
    assert.equal(content, 'real runner log')
    await writeFile(join(root, ...stored.storagePath.split('/')), 'fake runner log')
    await assert.rejects(
      () => store.stat(stored.storagePath),
      /EXECUTION_ARTIFACT_IMMUTABILITY_CONFLICT/u,
    )
    await assert.rejects(
      () => store.open(stored.storagePath),
      /EXECUTION_ARTIFACT_IMMUTABILITY_CONFLICT/u,
    )
    await assert.rejects(
      () => store.put({
        body: executionArtifactBody('real runner log'),
        mimeType: 'text/plain; charset=utf-8',
      }),
      /EXECUTION_ARTIFACT_IMMUTABILITY_CONFLICT/u,
    )
    await assert.rejects(() => store.open('../secret'), /STORAGE_PATH_INVALID/u)
    await assert.rejects(() => store.put({ body: executionArtifactBody('too large'), mimeType: 'text/plain', maximumBytes: 2 }), /TOO_LARGE/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
