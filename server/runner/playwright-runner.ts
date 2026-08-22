import type {
  ExecutionEnvironmentSnapshot,
  ExecutionPackage,
  ExecutionRunnerSnapshot,
  FrozenExecutionTaskInput,
} from '../domain/test-execution-types.js'
import {
  assertExecutionPackageIntegrity,
} from '../application/test-execution-validation.js'
import type {
  ExecutionSandbox,
  SandboxExecutionResult,
} from './execution-sandbox.js'

export interface ExecutionEnvironmentSecretResolver {
  resolveForLaunch(input: {
    environmentId: string
    environmentSignature: string
    configurationId?: string
  }, signal: AbortSignal): Promise<Readonly<Record<string, string>>>
}

export interface PlaywrightRunner {
  readiness(): Promise<{
    ready: boolean
    reason?: string
    snapshot: ExecutionRunnerSnapshot
  }>
  snapshot(): ExecutionRunnerSnapshot
  execute(input: {
    package: ExecutionPackage
    task: FrozenExecutionTaskInput & { taskId: string }
    attemptId: string
    expectedPackageSha256: string
    environment: ExecutionEnvironmentSnapshot
    runner: ExecutionRunnerSnapshot
    /** Present for persistent ProjectVersion workspaces. OCI runners may ignore it. */
    workspace?: {
      root: string
      entryFile: string
      entrySymbol: string
    }
  }, signal: AbortSignal): Promise<SandboxExecutionResult>
}

export class OciPlaywrightRunner implements PlaywrightRunner {
  constructor(
    private readonly sandbox: ExecutionSandbox,
    private readonly secretResolver: ExecutionEnvironmentSecretResolver,
  ) {}

  readiness() {
    return this.sandbox.readiness()
  }

  snapshot() {
    return structuredClone(this.sandbox.snapshot())
  }

  async execute(input: {
    package: ExecutionPackage
    task: FrozenExecutionTaskInput & { taskId: string }
    attemptId: string
    expectedPackageSha256: string
    environment: ExecutionEnvironmentSnapshot
    runner: ExecutionRunnerSnapshot
  }, signal: AbortSignal) {
    assertRunnerSnapshot(input.runner, this.sandbox.snapshot())
    const executionPackage = assertExecutionPackageIntegrity({
      package: input.package,
      task: input.task,
      environmentSignature: input.environment.signature,
      expectedPackageSha256: input.expectedPackageSha256,
    })
    if (signal.aborted) {
      return cancelledResult()
    }
    const secretEnvironment = await this.secretResolver.resolveForLaunch(
      {
        environmentId: input.environment.environmentId,
        environmentSignature: input.environment.signature,
        ...(input.runner.configurationId ? { configurationId: input.runner.configurationId } : {}),
      },
      signal,
    )
    if (signal.aborted) {
      return cancelledResult()
    }
    return this.sandbox.execute(
      {
        package: executionPackage,
        attemptId: input.attemptId,
        environment: structuredClone(input.environment),
        secretEnvironment,
      },
      signal,
    )
  }
}

function assertRunnerSnapshot(
  frozen: ExecutionRunnerSnapshot,
  actual: ExecutionRunnerSnapshot,
) {
  if (
    frozen.runnerVersion !== actual.runnerVersion
    || frozen.playwrightVersion !== actual.playwrightVersion
    || frozen.imageReference !== actual.imageReference
    || frozen.imageDigest !== actual.imageDigest
  ) {
    throw new Error('TEST_EXECUTION_RUNNER_SNAPSHOT_DRIFT')
  }
}

function cancelledResult(): SandboxExecutionResult {
  return {
    status: 'cancelled',
    durationMs: 0,
    summary: 'Runner 启动前已取消',
    error: 'TEST_EXECUTION_RUNNER_CANCELLED',
    artifacts: [],
  }
}
