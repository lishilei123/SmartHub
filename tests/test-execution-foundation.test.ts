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
  preconditions: [],
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

test('status', async ({ page }) => {
  await page.goto('/status')
  // smarthub:assert expected-1
  await expect(page.locator('[data-testid="status"]')).toHaveText('Ready')
})
`

function taskInput(): FrozenExecutionTaskInput & { taskId: string } {
  return { ...freezeExecutionTaskInput({ handoffMember, libraryMember }), taskId: 'task-status' }
}

function candidate(source = validSource, schemaVersion: ExecutionPackageCandidate['schemaVersion'] = 'test-script-generation/v1'): ExecutionPackageCandidate {
  return {
    schemaVersion,
    taskId: 'task-status',
    files: [{ path: 'tests/task-status.spec.ts', content: source }],
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
  assert.equal(first.manifest.entrypoint, 'tests/task-status.spec.ts')
  assert.equal(first.manifest.packageSha256, second.manifest.packageSha256)
  assert.equal(first.manifest.assertions[0].verificationCheckKey, 'expected-1')
  assert.equal(first.files[0].contentSha256, createHash('sha256').update(validSource).digest('hex'))
  assert.notEqual(
    scriptCacheKey({ caseId: 'case-status', caseRevision: 3, method: 'ui', caseContentSha256: contentSha256, executionSpecSha256: task.executionSpecSha256, environmentSignature: 'one', testScriptAgentVersion: 1, testScriptAgentConfigurationSha256: 'b'.repeat(64) }),
    scriptCacheKey({ caseId: 'case-status', caseRevision: 3, method: 'ui', caseContentSha256: contentSha256, executionSpecSha256: task.executionSpecSha256, environmentSignature: 'two', testScriptAgentVersion: 1, testScriptAgentConfigurationSha256: 'b'.repeat(64) }),
  )
  assert.notEqual(
    scriptCacheKey({ caseId: 'case-status', caseRevision: 3, method: 'ui', caseContentSha256: contentSha256, executionSpecSha256: task.executionSpecSha256, taskInputSha256: 'c'.repeat(64), environmentSignature: 'one', testScriptAgentVersion: 1, testScriptAgentConfigurationSha256: 'b'.repeat(64) }),
    scriptCacheKey({ caseId: 'case-status', caseRevision: 3, method: 'ui', caseContentSha256: contentSha256, executionSpecSha256: task.executionSpecSha256, taskInputSha256: 'd'.repeat(64), environmentSignature: 'one', testScriptAgentVersion: 1, testScriptAgentConfigurationSha256: 'b'.repeat(64) }),
  )
})

test('ExecutionPackage 拒绝路径逃逸、额外入口、动态导入与 Node 运行时能力', () => {
  const task = taskInput()
  assert.throws(
    () => buildExecutionPackage({ candidate: { ...candidate(), files: [{ path: '../task.spec.ts', content: validSource }] }, task, environmentSignature: 'env' }),
    error => validationCode(error, 'TEST_EXECUTION_PACKAGE_PATH_INVALID'),
  )
  assert.throws(
    () => buildExecutionPackage({ candidate: { ...candidate(), files: [...candidate().files, { path: 'tests/extra.ts', content: 'export {}' }] }, task, environmentSignature: 'env' }),
    error => validationCode(error, 'TEST_EXECUTION_PACKAGE_ENTRYPOINT_INVALID'),
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

test('脚本修复可变更 selector，但不能更改受保护断言语义', () => {
  const task = taskInput()
  const baseline = buildExecutionPackage({ candidate: candidate(), task, environmentSignature: 'env' })
  const selectorRepair = validSource.replace('[data-testid="status"]', '[aria-label="service status"]')
  assert.doesNotThrow(() => buildExecutionPackage({
    candidate: { ...candidate(selectorRepair, 'script-repair/v1'), parentScriptRevisionId: 'script-revision-1' },
    task,
    environmentSignature: 'env',
    baselineAssertions: baseline.manifest.assertions,
    parentScriptRevisionId: 'script-revision-1',
  }))
  assert.throws(
    () => buildExecutionPackage({
      candidate: { ...candidate(selectorRepair, 'script-repair/v1'), parentScriptRevisionId: 'foreign-revision' },
      task,
      environmentSignature: 'env',
      baselineAssertions: baseline.manifest.assertions,
      parentScriptRevisionId: 'script-revision-1',
    }),
    error => validationCode(error, 'TEST_EXECUTION_PACKAGE_PARENT_REVISION_MISMATCH'),
  )
  const weakened = validSource.replace("toHaveText('Ready')", "toContainText('Ready')")
  assert.throws(
    () => buildExecutionPackage({ candidate: { ...candidate(weakened, 'script-repair/v1'), parentScriptRevisionId: 'script-revision-1' }, task, environmentSignature: 'env', baselineAssertions: baseline.manifest.assertions, parentScriptRevisionId: 'script-revision-1' }),
    error => validationCode(error, 'TEST_EXECUTION_PROTECTED_ASSERTION_CHANGED'),
  )
  const changedExpected = validSource.replace("toHaveText('Ready')", "toHaveText('Anything')")
  assert.throws(
    () => buildExecutionPackage({ candidate: { ...candidate(changedExpected, 'script-repair/v1'), parentScriptRevisionId: 'script-revision-1' }, task, environmentSignature: 'env', baselineAssertions: baseline.manifest.assertions, parentScriptRevisionId: 'script-revision-1' }),
    error => validationCode(error, 'TEST_EXECUTION_PROTECTED_ASSERTION_CHANGED'),
  )
})

test('诊断证据只允许引用当前任务事实，自动修复策略由服务端固定', () => {
  const diagnosisCandidate = {
    schemaVersion: 'failure-analysis/v1',
    taskId: 'task-status',
    scriptRevisionId: 'revision-1',
    attemptIds: ['attempt-1'],
    category: 'selector_changed',
    confidence: 0.92,
    summary: '登录按钮 selector 已变化',
    evidence: [{ attemptId: 'attempt-1', artifactId: 'artifact-log-1', observation: '两次执行均无法定位旧 selector' }],
    repairable: true,
    recommendedAction: '更新 selector',
  }
  const context = { taskId: 'task-status', scriptRevisionId: 'revision-1', attemptIds: ['attempt-1'], artifactIds: ['artifact-log-1'] }
  const diagnosis = validateFailureDiagnosisCandidate(diagnosisCandidate, context)
  assert.equal(automaticRepairAllowed(diagnosis, 0), true)
  assert.equal(automaticRepairAllowed(diagnosis, 2), false)
  assert.equal(automaticRepairAllowed({ category: 'product_defect', repairable: true }, 0), false)
  assert.equal(automaticRepairAllowed({ category: 'assertion_mismatch', repairable: true }, 0), false)
  assert.equal(automaticRepairAllowed({ category: 'unknown', repairable: true }, 0), false)
  assert.throws(
    () => validateFailureDiagnosisCandidate({ ...diagnosisCandidate, evidence: [{ attemptId: 'foreign-attempt', observation: '外部事实' }] }, { ...context, artifactIds: [] }),
    error => validationCode(error, 'TEST_EXECUTION_DIAGNOSIS_EVIDENCE_FOREIGN'),
  )
  assert.throws(
    () => validateFailureDiagnosisCandidate({ ...diagnosisCandidate, schemaVersion: 'failure-analysis/v0' }, context),
    error => validationCode(error, 'TEST_EXECUTION_DIAGNOSIS_SCHEMA_INVALID'),
  )
  assert.throws(
    () => validateFailureDiagnosisCandidate({ ...diagnosisCandidate, taskId: 'foreign-task' }, context),
    error => validationCode(error, 'TEST_EXECUTION_DIAGNOSIS_TASK_MISMATCH'),
  )
  assert.throws(
    () => validateFailureDiagnosisCandidate({ ...diagnosisCandidate, attemptIds: ['foreign-attempt'] }, context),
    error => validationCode(error, 'TEST_EXECUTION_DIAGNOSIS_ATTEMPTS_MISMATCH'),
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
