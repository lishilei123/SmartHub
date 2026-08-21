import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import {
  buildExecutionPackage,
  freezeExecutionTaskInput,
  TestExecutionValidationError,
} from '../server/application/test-execution-validation.js'
import type {
  ExecutionEnvironmentSnapshot,
  ExecutionPackage,
  ExecutionRunnerSnapshot,
} from '../server/domain/test-execution-types.js'
import type {
  TestCaseContent,
  TestCaseLibraryVersionMemberDetail,
  TestExecutionHandoffMember,
} from '../server/domain/test-design-types.js'
import {
  buildOciRunArguments,
  type ExecutionSandbox,
} from '../server/runner/execution-sandbox.js'
import {
  OciPlaywrightRunner,
} from '../server/runner/playwright-runner.js'

const content: TestCaseContent = {
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

const spec = { schemaVersion: 'test-script-input/v1' as const, method: 'ui' as const, testCase: content }

const contentSha256 = canonicalSha256(content)
const libraryMember: TestCaseLibraryVersionMemberDetail = {
  caseId: 'case-status',
  revision: 3,
  ordinal: 0,
  contentSha256,
  frozenContent: content,
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
  executionSpec: spec,
  contentSha256,
}
const task = {
  ...freezeExecutionTaskInput({ handoffMember, libraryMember }),
  taskId: 'task-status',
}
const source = `import { test, expect } from '@playwright/test'

test('status', async ({ page }) => {
  await page.goto('/status')
  // smarthub:assert expected-1
  await expect(page.locator('[data-testid="status"]')).toHaveText('Ready')
})
`
const environment: ExecutionEnvironmentSnapshot = {
  environmentId: 'environment-test',
  name: '隔离测试环境',
  baseUrl: 'https://example.test',
  targets: [{ protocol: 'https', host: 'example.test', port: 443 }],
  signature: 'e'.repeat(64),
}
const runnerSnapshot: ExecutionRunnerSnapshot = {
  runnerVersion: '1.0.0',
  playwrightVersion: '1.58.2',
  imageReference: 'registry.example/smarthub/playwright',
  imageDigest: `sha256:${'a'.repeat(64)}`,
}

function executionPackage() {
  return buildExecutionPackage({
    candidate: {
      schemaVersion: 'test-script-generation/v1',
      taskId: task.taskId,
      files: [{ path: 'tests/task-status.spec.ts', content: source }],
      summary: '状态检查脚本',
    },
    task,
    environmentSignature: environment.signature,
  })
}

class RecordingSandbox implements ExecutionSandbox {
  calls: Array<{
    package: ExecutionPackage
    attemptId: string
    environment: ExecutionEnvironmentSnapshot
    secretEnvironment: Readonly<Record<string, string>>
  }> = []

  snapshot() {
    return structuredClone(runnerSnapshot)
  }

  async readiness() {
    return { ready: true, snapshot: this.snapshot() }
  }

  async execute(
    input: RecordingSandbox['calls'][number],
    _signal: AbortSignal,
  ) {
    this.calls.push(structuredClone(input))
    return {
      status: 'passed' as const,
      exitCode: 0,
      durationMs: 10,
      summary: '通过',
      artifacts: [],
    }
  }
}

test('OCI argv 固定隔离参数且不包含脚本、Agent 文本或 secret 值', () => {
  const secretValue = 'never-appear-in-argv'
  const args = buildOciRunArguments({
    containerName: 'smarthub-attempt-1',
    packageRoot: 'C:/runner/package',
    outputRoot: 'C:/runner/output',
    attemptId: 'attempt-1',
    packageSha256: 'b'.repeat(64),
    networkName: 'smarthub-env-network',
    imageReference: runnerSnapshot.imageReference,
    imageDigest: runnerSnapshot.imageDigest,
    entrypoint: '/opt/smarthub/run-playwright',
    pidsLimit: 512,
    memoryBytes: 2_147_483_648,
    cpuLimit: 2,
    secretEnvironmentNames: ['SMARTHUB_SECRET_TOKEN'],
  })
  assert.deepEqual(args.slice(0, 5), [
    'run', '--rm', '--init', '--name', 'smarthub-attempt-1',
  ])
  assert.ok(args.includes('--read-only'))
  assert.ok(args.includes('10001:10001'))
  assert.ok(args.includes('ALL'))
  assert.ok(args.includes('no-new-privileges'))
  assert.ok(args.includes('smarthub-env-network'))
  assert.ok(args.includes('/opt/smarthub/run-playwright'))
  assert.ok(args.includes('SMARTHUB_SECRET_TOKEN'))
  assert.ok(args.includes(
    `${runnerSnapshot.imageReference}@${runnerSnapshot.imageDigest}`,
  ))
  assert.equal(args.includes(secretValue), false)
  assert.equal(args.some(value => value.includes(source)), false)
  assert.equal(args.includes('sh'), false)
  assert.equal(args.includes('bash'), false)
})

test('PlaywrightRunner 仅在 package 与冻结 Runner 快照验真后解析 secret 并启动 sandbox', async () => {
  const sandbox = new RecordingSandbox()
  let secretResolutionCount = 0
  const runner = new OciPlaywrightRunner(sandbox, {
    async resolveForLaunch(input) {
      secretResolutionCount += 1
      assert.deepEqual(input, {
        environmentId: environment.environmentId,
        environmentSignature: environment.signature,
      })
      return { SMARTHUB_SECRET_TOKEN: 'runner-secret' }
    },
  })
  const packageValue = executionPackage()
  const result = await runner.execute({
    package: packageValue,
    task,
    attemptId: 'attempt-1',
    expectedPackageSha256: packageValue.manifest.packageSha256,
    environment,
    runner: runnerSnapshot,
  }, new AbortController().signal)
  assert.equal(result.status, 'passed')
  assert.equal(secretResolutionCount, 1)
  assert.equal(sandbox.calls.length, 1)
  assert.deepEqual(sandbox.calls[0].secretEnvironment, {
    SMARTHUB_SECRET_TOKEN: 'runner-secret',
  })
})

test('PlaywrightRunner 拒绝 package 篡改和 Runner drift，且拒绝发生在 secret 解析前', async () => {
  const sandbox = new RecordingSandbox()
  let secretResolutionCount = 0
  const runner = new OciPlaywrightRunner(sandbox, {
    async resolveForLaunch() {
      secretResolutionCount += 1
      return {}
    },
  })
  const packageValue = executionPackage()
  const tampered = structuredClone(packageValue)
  tampered.files[0].content += '\n// tampered'
  await assert.rejects(
    runner.execute({
      package: tampered,
      task,
      attemptId: 'attempt-1',
      expectedPackageSha256: packageValue.manifest.packageSha256,
      environment,
      runner: runnerSnapshot,
    }, new AbortController().signal),
    error => error instanceof TestExecutionValidationError
      && error.code === 'TEST_EXECUTION_PACKAGE_CONTENT_HASH_MISMATCH',
  )
  await assert.rejects(
    runner.execute({
      package: packageValue,
      task,
      attemptId: 'attempt-2',
      expectedPackageSha256: packageValue.manifest.packageSha256,
      environment,
      runner: { ...runnerSnapshot, imageDigest: `sha256:${'f'.repeat(64)}` },
    }, new AbortController().signal),
    /TEST_EXECUTION_RUNNER_SNAPSHOT_DRIFT/u,
  )
  assert.equal(secretResolutionCount, 0)
  assert.equal(sandbox.calls.length, 0)
})

test('PlaywrightRunner 在启动前取消时不解析 secret 且不调用 sandbox', async () => {
  const sandbox = new RecordingSandbox()
  let secretResolutionCount = 0
  const runner = new OciPlaywrightRunner(sandbox, {
    async resolveForLaunch() {
      secretResolutionCount += 1
      return {}
    },
  })
  const controller = new AbortController()
  controller.abort()
  const packageValue = executionPackage()
  const result = await runner.execute({
    package: packageValue,
    task,
    attemptId: 'attempt-cancelled',
    expectedPackageSha256: packageValue.manifest.packageSha256,
    environment,
    runner: runnerSnapshot,
  }, controller.signal)
  assert.equal(result.status, 'cancelled')
  assert.equal(secretResolutionCount, 0)
  assert.equal(sandbox.calls.length, 0)
})
