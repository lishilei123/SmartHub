import { randomUUID } from 'node:crypto'
import { canonicalSha256 } from './canonical-json.js'
import {
  ConfiguredExecutionEnvironmentCatalog,
  type ExecutionEnvironmentProfile,
} from './test-execution-environment.js'
import type {
  TestExecutionInfrastructureConfigurationVersion,
  TestExecutionRunnerConfiguration,
} from '../domain/types.js'
import type { StateStore } from '../infrastructure/store.js'

export type TestExecutionInfrastructureConfigurationInput = {
  expectedActiveVersion?: number | null
  environments: ExecutionEnvironmentProfile[]
  runner?: TestExecutionRunnerConfiguration
}

export class TestExecutionInfrastructureConfigurationService {
  constructor(private readonly store: StateStore) {}

  async get() {
    const versions = await this.listVersions()
    return {
      activeVersion: structuredClone(versions.find(item => item.status === 'active') ?? null),
      versions: versions.map(versionSummary),
    }
  }

  async resolveActive() {
    return (await this.get()).activeVersion
  }

  async resolveVersion(id: string) {
    const version = (await this.listVersions()).find(item => item.id === id)
    if (!version) throw new Error('TEST_EXECUTION_INFRASTRUCTURE_CONFIGURATION_NOT_FOUND')
    return structuredClone(version)
  }

  async publish(input: TestExecutionInfrastructureConfigurationInput, publishedBy: string) {
    const normalized = normalizeInput(input)
    const write = async (state: import('../domain/types.js').DatabaseState) => {
      const current = state.testExecutionInfrastructureConfigurationVersions
        .find(item => item.status === 'active') ?? null
      const expected = input.expectedActiveVersion ?? null
      if ((current?.version ?? null) !== expected) {
        throw new Error('TEST_EXECUTION_INFRASTRUCTURE_CONFIGURATION_VERSION_CONFLICT')
      }
      for (const item of state.testExecutionInfrastructureConfigurationVersions) {
        if (item.status === 'active') item.status = 'superseded'
      }
      const version = Math.max(0, ...state.testExecutionInfrastructureConfigurationVersions.map(item => item.version)) + 1
      const createdAt = new Date().toISOString()
      const base = {
        schemaVersion: 'test-execution-infrastructure/v1',
        environments: normalized.environments,
        ...(normalized.runner ? { runner: normalized.runner } : {}),
      }
      const value: TestExecutionInfrastructureConfigurationVersion = {
        id: `test_execution_infrastructure_${randomUUID()}`,
        version,
        status: 'active',
        environments: structuredClone(normalized.environments),
        ...(normalized.runner ? { runner: structuredClone(normalized.runner) } : {}),
        contentSha256: canonicalSha256(base),
        createdAt,
        publishedBy: cleanText(publishedBy, 80) || '系统管理员',
      }
      state.testExecutionInfrastructureConfigurationVersions.push(value)
      return structuredClone(value)
    }
    return this.store.transactionScope
      ? await this.store.transactionScope('test_execution_infrastructure_configuration', write)
      : await this.store.transaction(write)
  }

  private async listVersions() {
    if (this.store.listTestExecutionInfrastructureConfigurationVersions) {
      return await this.store.listTestExecutionInfrastructureConfigurationVersions()
    }
    return (await this.store.snapshot()).testExecutionInfrastructureConfigurationVersions
  }
}

function normalizeInput(input: TestExecutionInfrastructureConfigurationInput) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.environments)) {
    throw new Error('TEST_EXECUTION_INFRASTRUCTURE_CONFIGURATION_INVALID')
  }
  if (input.environments.length > 100) throw new Error('TEST_EXECUTION_INFRASTRUCTURE_ENVIRONMENT_LIMIT_EXCEEDED')
  // Reuse the execution-time normalizer so configuration and Run validation cannot drift.
  const catalog = new ConfiguredExecutionEnvironmentCatalog(input.environments)
  const environments = catalog.exportProfiles()
  return {
    environments,
    ...(input.runner === undefined ? {} : { runner: normalizeRunner(input.runner) }),
  }
}

function normalizeRunner(value: TestExecutionRunnerConfiguration) {
  if (!value || typeof value !== 'object') throw new Error('TEST_EXECUTION_RUNNER_CONFIGURATION_INVALID')
  const runner: TestExecutionRunnerConfiguration = {
    containerRuntime: value.containerRuntime,
    runnerVersion: text(value.runnerVersion, 'RUNNER_VERSION', 100),
    playwrightVersion: text(value.playwrightVersion, 'PLAYWRIGHT_VERSION', 100),
    imageReference: text(value.imageReference, 'IMAGE_REFERENCE', 500),
    imageDigest: text(value.imageDigest, 'IMAGE_DIGEST', 80),
    ...(value.entrypoint ? { entrypoint: text(value.entrypoint, 'ENTRYPOINT', 500) } : {}),
    ...(value.workingRoot ? { workingRoot: text(value.workingRoot, 'WORK_ROOT', 500) } : {}),
  }
  if (!['docker', 'podman'].includes(runner.containerRuntime)) throw new Error('TEST_EXECUTION_CONTAINER_RUNTIME_INVALID')
  if (!/^sha256:[a-f0-9]{64}$/u.test(runner.imageDigest)) throw new Error('TEST_EXECUTION_RUNNER_IMAGE_DIGEST_INVALID')
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:=-]{0,499}$/u.test(runner.imageReference) || runner.imageReference.includes('@')) throw new Error('TEST_EXECUTION_RUNNER_IMAGE_REFERENCE_INVALID')
  if (runner.entrypoint && !/^\/[A-Za-z0-9][A-Za-z0-9/._-]{0,499}$/u.test(runner.entrypoint)) throw new Error('TEST_EXECUTION_RUNNER_ENTRYPOINT_INVALID')
  return runner
}

function text(value: unknown, field: string, max: number) {
  const normalized = String(value ?? '').trim()
  if (!normalized || normalized.length > max || /[\u0000-\u001F\u007F]/u.test(normalized)) throw new Error(`TEST_EXECUTION_RUNNER_${field}_INVALID`)
  return normalized
}

function cleanText(value: string, max: number) {
  return String(value ?? '').trim().replace(/[\u0000-\u001F\u007F]/gu, '').slice(0, max)
}

function versionSummary(value: TestExecutionInfrastructureConfigurationVersion) {
  return { id: value.id, version: value.version, status: value.status, contentSha256: value.contentSha256, createdAt: value.createdAt, publishedBy: value.publishedBy }
}
