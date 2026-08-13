import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import {
  aggregateExecutionRunStatus,
  assertRunTransition,
  assertTaskTransition,
  automaticRepairAllowed,
  buildExecutionPackage,
  freezeExecutionTaskInput,
  scriptCacheKey,
  TestExecutionValidationError,
  unsupportedExecutionMethodReason,
  validateFailureDiagnosisCandidate,
} from '../server/application/test-execution-validation.js'
import type {
  ExecutionPackageCandidate,
  FrozenExecutionTaskInput,
} from '../server/domain/test-execution-types.js'
import type {
  FunctionalExecutionSpec,
  TestCaseContent,
  TestCaseLibraryVersionMemberDetail,
  TestExecutionHandoffMember,
} from '../server/domain/test-design-types.js'
import {
  executionArtifactBody,
  LocalExecutionArtifactStore,
} from '../server/infrastructure/execution-artifact-store.js'

const functionalSpec: FunctionalExecutionSpec = {
  kind: 'functional',
  method: 'ui',
  steps: [{ key: 'open', action: '打开状态页', expected: '页面已加载' }],
  verificationChecks: [{ key: 'status', description: '状态显示 Ready' }],
  preconditions: [],
  testDataRequirements: [],
  executionReadiness: 'ready',
  automationHint: '使用 data-testid',
}

const caseContent: TestCaseContent = {
  schemaVersion: 'test-case/v2',
  title: '状态检查',
  objective: '验证状态页显示 Ready',
  dimension: 'functional',
  testPointIds: ['point-status'],
  priority: 'P0',
  preconditions: [],
  dataRequirementIds: [],
  cleanup: [],
  dependencies: [],
  executionMethods: [{
    method: 'ui',
    uiSpec: { entry: '/status' },
    steps: functionalSpec.steps,
    verificationChecks: functionalSpec.verificationChecks,
    executionReadiness: 'ready',
    automationHint: functionalSpec.automationHint,
  }],
  executionSpec: functionalSpec,
  sharedVerificationChecks: functionalSpec.verificationChecks,
  tags: ['smoke'],
  domain: 'system',
}

const contentSha256 = canonicalSha256(caseContent)
const libraryMember: TestCaseLibraryVersionMemberDetail = {
  caseId: 'case-status',
  revision: 3,
  ordinal: 0,
  contentSha256,
  frozenContent: caseContent,
  traceability: {
    sourceRequirementReleaseId: 'release-1',
    requirementRefs: [{ requirementReleaseId: 'release-1', requirementId: 'requirement-status' }],
    testPointRefs: [{ testPointTreeVersionId: 'tree-version-1', testPointId: 'point-status' }],
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
  // smarthub:assert status
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

test('任务冻结只接受同一正式用例库成员的内容、执行规范与追溯 Hash', () => {
  const frozen = freezeExecutionTaskInput({ handoffMember, libraryMember })
  assert.equal(frozen.caseContentSha256, contentSha256)
  assert.equal(frozen.executionSpecSha256, canonicalSha256(functionalSpec))
  const { inputSha256, ...snapshot } = frozen
  assert.equal(inputSha256, canonicalSha256(snapshot))
})

test('任务冻结拒绝损坏的内容 Hash 与 Handoff 执行规范漂移', () => {
  assert.throws(
    () => freezeExecutionTaskInput({ handoffMember: { ...handoffMember, contentSha256: 'a'.repeat(64) }, libraryMember }),
    error => validationCode(error, 'TEST_EXECUTION_HANDOFF_CONTENT_HASH_MISMATCH'),
  )
  const changedSpec: FunctionalExecutionSpec = { ...functionalSpec, automationHint: '已漂移' }
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
  assert.equal(first.manifest.assertions[0].verificationCheckKey, 'status')
  assert.equal(first.files[0].contentSha256, createHash('sha256').update(validSource).digest('hex'))
  assert.notEqual(
    scriptCacheKey({ caseId: 'case-status', caseRevision: 3, method: 'ui', caseContentSha256: contentSha256, executionSpecSha256: task.executionSpecSha256, environmentSignature: 'one', testScriptAgentVersion: 1, testScriptAgentConfigurationSha256: 'b'.repeat(64) }),
    scriptCacheKey({ caseId: 'case-status', caseRevision: 3, method: 'ui', caseContentSha256: contentSha256, executionSpecSha256: task.executionSpecSha256, environmentSignature: 'two', testScriptAgentVersion: 1, testScriptAgentConfigurationSha256: 'b'.repeat(64) }),
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
  }))
  const weakened = validSource.replace("toHaveText('Ready')", "toContainText('Ready')")
  assert.throws(
    () => buildExecutionPackage({ candidate: candidate(weakened, 'script-repair/v1'), task, environmentSignature: 'env', baselineAssertions: baseline.manifest.assertions }),
    error => validationCode(error, 'TEST_EXECUTION_PROTECTED_ASSERTION_CHANGED'),
  )
  const changedExpected = validSource.replace("toHaveText('Ready')", "toHaveText('Anything')")
  assert.throws(
    () => buildExecutionPackage({ candidate: candidate(changedExpected, 'script-repair/v1'), task, environmentSignature: 'env', baselineAssertions: baseline.manifest.assertions }),
    error => validationCode(error, 'TEST_EXECUTION_PROTECTED_ASSERTION_CHANGED'),
  )
})

test('诊断证据只允许引用当前任务事实，自动修复策略由服务端固定', () => {
  const diagnosis = validateFailureDiagnosisCandidate({
    category: 'selector_changed',
    confidence: 0.92,
    summary: '登录按钮 selector 已变化',
    evidence: [{ attemptId: 'attempt-1', artifactId: 'artifact-log-1', observation: '两次执行均无法定位旧 selector' }],
    repairable: true,
    recommendedAction: '更新 selector',
  }, { taskId: 'task-status', scriptRevisionId: 'revision-1', attemptIds: ['attempt-1'], artifactIds: ['artifact-log-1'] })
  assert.equal(automaticRepairAllowed(diagnosis, 0), true)
  assert.equal(automaticRepairAllowed(diagnosis, 2), false)
  assert.equal(automaticRepairAllowed({ category: 'product_defect', repairable: true }, 0), false)
  assert.equal(automaticRepairAllowed({ category: 'assertion_mismatch', repairable: true }, 0), false)
  assert.equal(automaticRepairAllowed({ category: 'unknown', repairable: true }, 0), false)
  assert.throws(
    () => validateFailureDiagnosisCandidate({ ...diagnosis, evidence: [{ attemptId: 'foreign-attempt', observation: '外部事实' }] }, { taskId: 'task-status', scriptRevisionId: 'revision-1', attemptIds: ['attempt-1'], artifactIds: [] }),
    error => validationCode(error, 'TEST_EXECUTION_DIAGNOSIS_EVIDENCE_FOREIGN'),
  )
})

test('LocalExecutionArtifactStore 流式写入、按内容寻址并拒绝路径逃逸', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smarthub-execution-artifacts-'))
  try {
    const store = new LocalExecutionArtifactStore(root)
    const stored = await store.put({ body: executionArtifactBody('real runner log'), mimeType: 'text/plain; charset=utf-8' })
    assert.equal(stored.sha256, createHash('sha256').update('real runner log').digest('hex'))
    const duplicate = await store.put({ body: executionArtifactBody('real runner log'), mimeType: 'text/plain; charset=utf-8' })
    assert.equal(duplicate.storagePath, stored.storagePath)
    assert.deepEqual(await store.stat(stored.storagePath), { storagePath: stored.storagePath, sha256: stored.sha256, size: stored.size })
    let content = ''
    for await (const chunk of await store.open(stored.storagePath)) content += Buffer.from(chunk).toString('utf8')
    assert.equal(content, 'real runner log')
    await assert.rejects(() => store.open('../secret'), /STORAGE_PATH_INVALID/u)
    await assert.rejects(() => store.put({ body: executionArtifactBody('too large'), mimeType: 'text/plain', maximumBytes: 2 }), /TOO_LARGE/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
