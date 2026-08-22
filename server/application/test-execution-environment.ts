import type {
  ExecutionEnvironmentSnapshot,
} from '../domain/test-execution-types.js'
import type { TestExecutionEnvironmentProfile } from '../domain/types.js'
import type { TestExecutionInfrastructureConfigurationService } from './test-execution-infrastructure-configuration-service.js'
import type {
  ExecutionEnvironmentSecretResolver,
} from '../runner/playwright-runner.js'
import { canonicalSha256 } from './canonical-json.js'
import type {
  ExecutionEnvironmentResolver,
} from './test-execution-service.js'

export type ExecutionEnvironmentProfile = TestExecutionEnvironmentProfile

export class ConfiguredExecutionEnvironmentCatalog
implements ExecutionEnvironmentResolver, ExecutionEnvironmentSecretResolver {
  private readonly profiles = new Map<string, {
    snapshot: ExecutionEnvironmentSnapshot
    networkName: string
    secretEnvironmentVariables: Readonly<Record<string, string>>
  }>()

  constructor(profiles: readonly ExecutionEnvironmentProfile[]) {
    for (const profile of profiles) {
      const normalized = normalizeProfile(profile)
      if (this.profiles.has(normalized.snapshot.environmentId)) {
        throw new Error('TEST_EXECUTION_ENVIRONMENT_DUPLICATE')
      }
      this.profiles.set(normalized.snapshot.environmentId, normalized)
    }
  }

  async readiness() {
    if (!this.profiles.size) {
      return {
        ready: false,
        reason: 'TEST_EXECUTION_ENVIRONMENT_NOT_CONFIGURED',
      }
    }
    const secretsAvailable = [...this.profiles.values()].every(profile =>
      Object.values(profile.secretEnvironmentVariables)
        .every(processName => Object.hasOwn(process.env, processName)))
    return secretsAvailable
      ? { ready: true }
      : {
          ready: false,
          reason: 'TEST_EXECUTION_ENVIRONMENT_SECRETS_UNAVAILABLE',
        }
  }

  async resolveSnapshotForBaseUrl(baseUrl: string) {
    const normalizedBaseUrl = normalizeUnscopedBaseUrl(baseUrl)
    const profile = [...this.profiles.values()].find(item =>
      item.snapshot.baseUrl === normalizedBaseUrl)
    if (!profile) {
      throw new Error('TEST_EXECUTION_ENVIRONMENT_NOT_REGISTERED')
    }
    return structuredClone(profile.snapshot)
  }

  async resolveForLaunch(input: {
    environmentId: string
    environmentSignature: string
  }, signal: AbortSignal) {
    if (signal.aborted) throw abortError(signal)
    const profile = this.profiles.get(input.environmentId)
    if (
      !profile
      || profile.snapshot.signature !== input.environmentSignature
    ) {
      throw new Error('TEST_EXECUTION_ENVIRONMENT_SNAPSHOT_DRIFT')
    }
    const secrets: Record<string, string> = {}
    for (const [runnerName, processName] of Object.entries(
      profile.secretEnvironmentVariables,
    )) {
      if (signal.aborted) throw abortError(signal)
      const value = process.env[processName]
      if (value === undefined) {
        throw new Error(
          `TEST_EXECUTION_SECRET_UNAVAILABLE: ${runnerName}`,
        )
      }
      secrets[runnerName] = value
    }
    return secrets
  }

  networkPolicies() {
    return Object.fromEntries(
      [...this.profiles.values()]
        .map(profile => [profile.snapshot.signature, profile.networkName])
        .sort(([left], [right]) => left.localeCompare(right)),
    )
  }

  async listSnapshots() {
    return [...this.profiles.values()]
      .map(profile => structuredClone(profile.snapshot))
      .sort((left, right) =>
        left.environmentId.localeCompare(right.environmentId))
  }

  /** Normalized non-secret configuration for creating an immutable release. */
  exportProfiles(): ExecutionEnvironmentProfile[] {
    return [...this.profiles.values()]
      .map(profile => ({
        environmentId: profile.snapshot.environmentId,
        name: profile.snapshot.name,
        baseUrl: profile.snapshot.baseUrl,
        targets: structuredClone(profile.snapshot.targets),
        networkName: profile.networkName,
        ...(Object.keys(profile.secretEnvironmentVariables).length
          ? { secretEnvironmentVariables: structuredClone(profile.secretEnvironmentVariables) }
          : {}),
      }))
      .sort((left, right) => left.environmentId.localeCompare(right.environmentId))
  }
}

/** Resolves the active server-owned infrastructure release on every operation. */
export class ServerConfiguredExecutionEnvironmentCatalog
implements ExecutionEnvironmentResolver, ExecutionEnvironmentSecretResolver {
  constructor(private readonly configurations: TestExecutionInfrastructureConfigurationService) {}

  async readiness() {
    const catalog = await this.activeCatalog()
    return catalog ? await catalog.readiness() : { ready: false, reason: 'TEST_EXECUTION_ENVIRONMENT_NOT_CONFIGURED' }
  }

  async resolveSnapshotForBaseUrl(baseUrl: string) {
    const catalog = await this.requiredActiveCatalog()
    return await catalog.resolveSnapshotForBaseUrl(baseUrl)
  }

  async resolveForLaunch(input: { environmentId: string; environmentSignature: string; configurationId?: string }, signal: AbortSignal) {
    const configuration = input.configurationId
      ? await this.configurations.resolveVersion(input.configurationId)
      : await this.configurations.resolveActive()
    if (!configuration) throw new Error('TEST_EXECUTION_ENVIRONMENT_NOT_CONFIGURED')
    return await new ConfiguredExecutionEnvironmentCatalog(configuration.environments)
      .resolveForLaunch(input, signal)
  }

  async listSnapshots() {
    const catalog = await this.activeCatalog()
    return catalog?.listSnapshots() ?? []
  }

  private async activeCatalog() {
    const configuration = await this.configurations.resolveActive()
    return configuration ? new ConfiguredExecutionEnvironmentCatalog(configuration.environments) : null
  }

  private async requiredActiveCatalog() {
    const catalog = await this.activeCatalog()
    if (!catalog) throw new Error('TEST_EXECUTION_ENVIRONMENT_NOT_CONFIGURED')
    return catalog
  }
}

export function executionEnvironmentProfilesFromJson(value: string | undefined) {
  if (!value?.trim()) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('TEST_EXECUTION_ENVIRONMENT_CONFIG_INVALID')
  }
  if (!Array.isArray(parsed) || parsed.length > 100) {
    throw new Error('TEST_EXECUTION_ENVIRONMENT_CONFIG_INVALID')
  }
  return parsed.map(parseProfile)
}

function parseProfile(value: unknown): ExecutionEnvironmentProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('TEST_EXECUTION_ENVIRONMENT_CONFIG_INVALID')
  }
  const record = value as Record<string, unknown>
  const targets = Array.isArray(record.targets)
    ? record.targets.map(target => {
        if (!target || typeof target !== 'object' || Array.isArray(target)) {
          throw new Error('TEST_EXECUTION_ENVIRONMENT_CONFIG_INVALID')
        }
        const item = target as Record<string, unknown>
        return {
          protocol: item.protocol as 'http' | 'https',
          host: String(item.host ?? ''),
          port: Number(item.port),
        }
      })
    : []
  const rawSecrets = record.secretEnvironmentVariables
  const secretEnvironmentVariables = rawSecrets === undefined
    ? undefined
    : stringRecord(rawSecrets)
  return {
    environmentId: String(record.environmentId ?? ''),
    name: String(record.name ?? ''),
    baseUrl: String(record.baseUrl ?? ''),
    targets,
    networkName: String(record.networkName ?? ''),
    ...(secretEnvironmentVariables ? { secretEnvironmentVariables } : {}),
  }
}

function normalizeProfile(profile: ExecutionEnvironmentProfile) {
  const environmentId = safeIdentity(profile.environmentId, 'environmentId')
  const name = safeText(profile.name, 'name', 200)
  const networkName = safeNetworkName(profile.networkName)
  const targets = normalizeTargets(profile.targets)
  const baseUrl = normalizeBaseUrl(profile.baseUrl, targets)
  const signatureBase = {
    schemaVersion: 'test-execution-environment/v1',
    environmentId,
    name,
    baseUrl,
    targets,
  }
  const secretEnvironmentVariables = normalizeSecretMappings(
    profile.secretEnvironmentVariables ?? {},
  )
  return {
    snapshot: {
      environmentId,
      name,
      baseUrl,
      targets,
      signature: canonicalSha256(signatureBase),
    },
    networkName,
    secretEnvironmentVariables,
  }
}

function normalizeTargets(targets: ExecutionEnvironmentProfile['targets']) {
  if (!Array.isArray(targets) || !targets.length || targets.length > 32) {
    throw new Error('TEST_EXECUTION_ENVIRONMENT_TARGETS_INVALID')
  }
  const seen = new Set<string>()
  return targets.map(target => {
    const protocol = target.protocol
    const host = safeHost(target.host)
    const port = target.port
    if (
      !['http', 'https'].includes(protocol)
      || !Number.isSafeInteger(port)
      || port < 1
      || port > 65_535
    ) {
      throw new Error('TEST_EXECUTION_ENVIRONMENT_TARGET_INVALID')
    }
    const key = `${protocol}:${host}:${port}`
    if (seen.has(key)) {
      throw new Error('TEST_EXECUTION_ENVIRONMENT_TARGET_DUPLICATE')
    }
    seen.add(key)
    return { protocol, host, port }
  })
}

function normalizeBaseUrl(
  value: string,
  targets: ExecutionEnvironmentSnapshot['targets'],
) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('TEST_EXECUTION_ENVIRONMENT_BASE_URL_INVALID')
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.hash
  ) {
    throw new Error('TEST_EXECUTION_ENVIRONMENT_BASE_URL_INVALID')
  }
  const protocol = url.protocol.slice(0, -1) as 'http' | 'https'
  const host = url.hostname.toLocaleLowerCase()
  const port = url.port
    ? Number(url.port)
    : protocol === 'https' ? 443 : 80
  if (!targets.some(target =>
    target.protocol === protocol
    && target.host === host
    && target.port === port)) {
    throw new Error('TEST_EXECUTION_ENVIRONMENT_BASE_URL_NOT_ALLOWED')
  }
  return url.toString()
}

function normalizeUnscopedBaseUrl(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('TEST_EXECUTION_BASE_URL_INVALID')
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.hash
  ) {
    throw new Error('TEST_EXECUTION_BASE_URL_INVALID')
  }
  safeHost(url.hostname)
  return url.toString()
}

function normalizeSecretMappings(values: Readonly<Record<string, string>>) {
  const result: Record<string, string> = {}
  for (const [runnerName, processName] of Object.entries(values)) {
    if (!/^SMARTHUB_SECRET_[A-Z0-9_]{1,80}$/u.test(runnerName)) {
      throw new Error('TEST_EXECUTION_SECRET_NAME_INVALID')
    }
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(processName)) {
      throw new Error('TEST_EXECUTION_SECRET_SOURCE_NAME_INVALID')
    }
    result[runnerName] = processName
  }
  return Object.freeze(result)
}

function stringRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('TEST_EXECUTION_ENVIRONMENT_CONFIG_INVALID')
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (typeof item !== 'string') {
        throw new Error('TEST_EXECUTION_ENVIRONMENT_CONFIG_INVALID')
      }
      return [key, item]
    }),
  )
}

function safeIdentity(value: string, field: string) {
  const normalized = String(value ?? '').trim()
  if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(normalized)) {
    throw new Error(`TEST_EXECUTION_ENVIRONMENT_${field.toUpperCase()}_INVALID`)
  }
  return normalized
}

function safeText(value: string, field: string, maximum: number) {
  const normalized = String(value ?? '').trim()
  if (
    !normalized
    || normalized.length > maximum
    || /[\u0000-\u001F\u007F]/u.test(normalized)
  ) {
    throw new Error(`TEST_EXECUTION_ENVIRONMENT_${field.toUpperCase()}_INVALID`)
  }
  return normalized
}

function safeHost(value: string) {
  const normalized = String(value ?? '').trim().toLocaleLowerCase()
  if (
    !normalized
    || normalized.length > 253
    || /[\u0000-\u0020\u007F/@\\]/u.test(normalized)
  ) {
    throw new Error('TEST_EXECUTION_ENVIRONMENT_HOST_INVALID')
  }
  return normalized
}

function safeNetworkName(value: string) {
  const normalized = String(value ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(normalized)) {
    throw new Error('TEST_EXECUTION_ENVIRONMENT_NETWORK_INVALID')
  }
  return normalized
}

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('TEST_EXECUTION_ABORTED')
}
