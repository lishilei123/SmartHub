import type { TestExecutionInfrastructureConfigurationService } from '../application/test-execution-infrastructure-configuration-service.js'
import { ConfiguredExecutionEnvironmentCatalog } from '../application/test-execution-environment.js'
import type { ExecutionArtifactStore } from '../infrastructure/execution-artifact-store.js'
import type { ExecutionRunnerSnapshot } from '../domain/test-execution-types.js'
import { OciExecutionSandbox } from './execution-sandbox.js'
import { OciPlaywrightRunner, type PlaywrightRunner } from './playwright-runner.js'

export class ConfiguredOciPlaywrightRunner implements PlaywrightRunner {
  private lastSnapshot: ExecutionRunnerSnapshot = unavailableSnapshot()

  constructor(
    private readonly configurations: TestExecutionInfrastructureConfigurationService,
    private readonly artifacts: ExecutionArtifactStore,
  ) {}

  snapshot() { return structuredClone(this.lastSnapshot) }

  async readiness() {
    const configuration = await this.configurations.resolveActive()
    if (!configuration?.runner || !configuration.environments.length) return {
      ready: false,
      reason: 'TEST_EXECUTION_RUNNER_UNAVAILABLE: OCI Runner 配置不完整',
      snapshot: unavailableSnapshot(),
    }
    const runner = this.create(configuration)
    const readiness = await runner.readiness()
    const snapshot = snapshotFor(configuration)
    this.lastSnapshot = snapshot
    return { ...readiness, snapshot }
  }

  async execute(input: Parameters<PlaywrightRunner['execute']>[0], signal: AbortSignal) {
    if (!input.runner.configurationId) {
      throw new Error('TEST_EXECUTION_RUNNER_CONFIGURATION_SNAPSHOT_REQUIRED')
    }
    const configuration = await this.configurations.resolveVersion(input.runner.configurationId)
    if (!configuration.runner || !sameSnapshot(input.runner, snapshotFor(configuration))) {
      throw new Error('TEST_EXECUTION_RUNNER_SNAPSHOT_DRIFT')
    }
    return await this.create(configuration).execute(input, signal)
  }

  private create(configuration: NonNullable<Awaited<ReturnType<TestExecutionInfrastructureConfigurationService['resolveActive']>>>) {
    const runner = configuration.runner!
    return new OciPlaywrightRunner(
      new OciExecutionSandbox({
        runtimeExecutable: runner.containerRuntime,
        imageReference: runner.imageReference,
        imageDigest: runner.imageDigest,
        runnerVersion: runner.runnerVersion,
        playwrightVersion: runner.playwrightVersion,
        networkPolicies: new ConfiguredExecutionEnvironmentCatalog(configuration.environments).networkPolicies(),
        ...(runner.entrypoint ? { entrypoint: runner.entrypoint } : {}),
        ...(runner.workingRoot ? { workingRoot: runner.workingRoot } : {}),
      }, this.artifacts),
      new ConfiguredExecutionEnvironmentCatalog(configuration.environments),
    )
  }
}

function snapshotFor(configuration: NonNullable<Awaited<ReturnType<TestExecutionInfrastructureConfigurationService['resolveActive']>>>) {
  const runner = configuration.runner!
  return {
    runnerVersion: runner.runnerVersion,
    playwrightVersion: runner.playwrightVersion,
    imageReference: runner.imageReference,
    imageDigest: runner.imageDigest,
    configurationId: configuration.id,
    configurationVersion: configuration.version,
    configurationSha256: configuration.contentSha256,
  }
}

function sameSnapshot(left: ExecutionRunnerSnapshot, right: ExecutionRunnerSnapshot) {
  return left.runnerVersion === right.runnerVersion
    && left.playwrightVersion === right.playwrightVersion
    && left.imageReference === right.imageReference
    && left.imageDigest === right.imageDigest
    && left.configurationId === right.configurationId
    && left.configurationVersion === right.configurationVersion
    && left.configurationSha256 === right.configurationSha256
}

function unavailableSnapshot(): ExecutionRunnerSnapshot {
  return { runnerVersion: 'unconfigured', playwrightVersion: 'unconfigured', imageReference: 'unconfigured', imageDigest: `sha256:${'0'.repeat(64)}` }
}
