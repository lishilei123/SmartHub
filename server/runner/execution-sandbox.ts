import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import type {
  ExecutionArtifactType,
  ExecutionEnvironmentSnapshot,
  ExecutionPackage,
  ExecutionRunnerSnapshot,
} from '../domain/test-execution-types.js'
import type {
  ExecutionArtifactStore,
  StoredExecutionArtifact,
} from '../infrastructure/execution-artifact-store.js'

export type RunnerArtifactObject = StoredExecutionArtifact & {
  type: ExecutionArtifactType
}

export type SandboxExecutionResult = {
  status: 'passed' | 'failed' | 'cancelled' | 'infrastructure_error'
  exitCode?: number
  durationMs: number
  summary: string
  error?: string
  artifacts: RunnerArtifactObject[]
}

export interface ExecutionSandbox {
  readiness(): Promise<{
    ready: boolean
    reason?: string
    snapshot: ExecutionRunnerSnapshot
  }>
  snapshot(): ExecutionRunnerSnapshot
  execute(input: {
    package: ExecutionPackage
    attemptId: string
    environment: ExecutionEnvironmentSnapshot
    secretEnvironment: Readonly<Record<string, string>>
  }, signal: AbortSignal): Promise<SandboxExecutionResult>
}

export type OciExecutionSandboxOptions = {
  runtimeExecutable: string
  imageReference: string
  imageDigest: string
  runnerVersion: string
  playwrightVersion: string
  networkPolicies: Readonly<Record<string, string>>
  entrypoint?: string
  workingRoot?: string
  timeoutMs?: number
  memoryBytes?: number
  cpuLimit?: number
  pidsLimit?: number
  maximumOutputBytes?: number
  maximumStdioBytes?: number
}

type NormalizedSandboxOptions = {
  runtimeExecutable: string
  imageReference: string
  imageDigest: string
  runnerVersion: string
  playwrightVersion: string
  networkPolicies: Readonly<Record<string, string>>
  entrypoint: string
  workingRoot?: string
  timeoutMs: number
  memoryBytes: number
  cpuLimit: number
  pidsLimit: number
  maximumOutputBytes: number
  maximumStdioBytes: number
}

type CompletionManifest = {
  schemaVersion: 'playwright-runner-completion/v1'
  attemptId: string
  packageSha256: string
  status: 'passed' | 'failed'
  exitCode: number
  durationMs: number
  summary: string
  error?: string
}

const OUTPUT_RULES: Array<{
  pattern: RegExp
  type: ExecutionArtifactType
  mimeType: string
}> = [
  {
    pattern: /^completion\.json$/u,
    type: 'completion_manifest',
    mimeType: 'application/json',
  },
  {
    pattern: /^results\.json$/u,
    type: 'result',
    mimeType: 'application/json',
  },
  {
    pattern: /^runner-(?:stdout|stderr)\.log$/u,
    type: 'log',
    mimeType: 'text/plain; charset=utf-8',
  },
  {
    pattern: /^screenshots\/[A-Za-z0-9._-]+\.png$/u,
    type: 'screenshot',
    mimeType: 'image/png',
  },
  {
    pattern: /^traces\/[A-Za-z0-9._-]+\.zip$/u,
    type: 'trace',
    mimeType: 'application/zip',
  },
  {
    pattern: /^videos\/[A-Za-z0-9._-]+\.webm$/u,
    type: 'video',
    mimeType: 'video/webm',
  },
  {
    pattern: /^har\/[A-Za-z0-9._-]+\.har$/u,
    type: 'har',
    mimeType: 'application/json',
  },
]

export class OciExecutionSandbox implements ExecutionSandbox {
  private readonly options: NormalizedSandboxOptions

  constructor(
    options: OciExecutionSandboxOptions,
    private readonly artifactStore: ExecutionArtifactStore,
  ) {
    this.options = normalizeOptions(options)
  }

  snapshot(): ExecutionRunnerSnapshot {
    return {
      runnerVersion: this.options.runnerVersion,
      playwrightVersion: this.options.playwrightVersion,
      imageReference: this.options.imageReference,
      imageDigest: this.options.imageDigest,
    }
  }

  async readiness() {
    const snapshot = this.snapshot()
    try {
      await runCommand(
        this.options.runtimeExecutable,
        ['--version'],
        10_000,
      )
      await runCommand(
        this.options.runtimeExecutable,
        ['image', 'inspect', qualifiedImage(this.options)],
        20_000,
      )
      for (
        const [environmentSignature, networkName]
        of Object.entries(this.options.networkPolicies)
      ) {
        const inspected = await runCommand(
          this.options.runtimeExecutable,
          [
            'network',
            'inspect',
            '--format',
            '{{ index .Labels "com.smarthub.environment-signature" }}',
            networkName,
          ],
          20_000,
        )
        if (inspected.stdout.toString('utf8').trim() !== environmentSignature) {
          throw new Error(
            `TEST_EXECUTION_RUNNER_NETWORK_SIGNATURE_MISMATCH: ${networkName}`,
          )
        }
      }
      await runCommand(
        this.options.runtimeExecutable,
        readinessArguments(this.options),
        60_000,
      )
      return { ready: true, snapshot }
    } catch (error) {
      return {
        ready: false,
        reason: error instanceof Error ? error.message : String(error),
        snapshot,
      }
    }
  }

  async execute(input: {
    package: ExecutionPackage
    attemptId: string
    environment: ExecutionEnvironmentSnapshot
    secretEnvironment: Readonly<Record<string, string>>
  }, signal: AbortSignal): Promise<SandboxExecutionResult> {
    const startedAt = Date.now()
    const attemptId = safeIdentity(input.attemptId, 'attemptId')
    const environment = validateEnvironment(
      input.environment,
      this.options.networkPolicies,
    )
    const secretEnvironment = normalizeSecretEnvironment(
      input.secretEnvironment,
    )
    const workingRoot = this.options.workingRoot ?? tmpdir()
    await mkdir(workingRoot, { recursive: true })
    const root = await mkdtemp(join(workingRoot, 'smarthub-runner-'))
    const packageRoot = join(root, 'package')
    const outputRoot = join(root, 'output')
    try {
      await Promise.all([
        mkdir(packageRoot, { recursive: true }),
        mkdir(outputRoot, { recursive: true }),
      ])
      await Promise.all([
        chmod(packageRoot, 0o755),
        chmod(outputRoot, 0o777),
      ])
      await materializePackage(packageRoot, input.package)
      await writeFile(
        join(packageRoot, 'environment.json'),
        JSON.stringify({
          schemaVersion: 'execution-environment/v1',
          environmentId: environment.environmentId,
          name: environment.name,
          baseUrl: environment.baseUrl,
          targets: environment.targets,
          signature: environment.signature,
        }),
        { encoding: 'utf8', mode: 0o444, flag: 'wx' },
      )
      await assertNetworkPolicy(
        this.options.runtimeExecutable,
        environment.signature,
        this.options.networkPolicies[environment.signature],
      )
      const processResult = await launchContainer({
        options: this.options,
        attemptId,
        packageSha256: input.package.manifest.packageSha256,
        packageRoot,
        outputRoot,
        environment,
        secretEnvironment,
        signal,
      })
      await writeCapturedOutput(
        outputRoot,
        processResult.stdout,
        processResult.stderr,
      )
      const durationMs = Math.max(0, Date.now() - startedAt)
      if (processResult.cancelled) {
        const artifacts = await safelyIngestOutputs(
          outputRoot,
          this.artifactStore,
          this.options.maximumOutputBytes,
        )
        return {
          status: 'cancelled',
          durationMs,
          summary: 'Runner 已取消',
          error: 'TEST_EXECUTION_RUNNER_CANCELLED',
          artifacts,
        }
      }
      if (processResult.error) {
        const artifacts = await safelyIngestOutputs(
          outputRoot,
          this.artifactStore,
          this.options.maximumOutputBytes,
        )
        return {
          status: 'infrastructure_error',
          durationMs,
          summary: 'Runner 启动或容器执行失败',
          error: processResult.error,
          artifacts,
        }
      }
      try {
        const inspected = await inspectAndIngestOutputs({
          root: outputRoot,
          artifactStore: this.artifactStore,
          maximumOutputBytes: this.options.maximumOutputBytes,
          attemptId,
          packageSha256: input.package.manifest.packageSha256,
          processExitCode: processResult.exitCode,
        })
        const completion = inspected.completion
        const passed = completion.status === 'passed'
          && completion.exitCode === 0
          && processResult.exitCode === 0
        return {
          status: passed ? 'passed' : 'failed',
          exitCode: processResult.exitCode,
          durationMs,
          summary: completion.summary,
          ...(passed
            ? {}
            : {
                error: completion.error
                  ?? `PLAYWRIGHT_EXIT_${processResult.exitCode}`,
              }),
          artifacts: inspected.artifacts,
        }
      } catch (error) {
        const artifacts = await safelyIngestOutputs(
          outputRoot,
          this.artifactStore,
          this.options.maximumOutputBytes,
        )
        return {
          status: 'infrastructure_error',
          exitCode: processResult.exitCode,
          durationMs,
          summary: 'Runner 输出契约无效',
          error: error instanceof Error ? error.message : String(error),
          artifacts,
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}

async function materializePackage(
  root: string,
  executionPackage: ExecutionPackage,
) {
  for (const file of executionPackage.files) {
    const target = resolve(root, ...file.path.split('/'))
    assertInside(root, target)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(
      target,
      file.content,
      { encoding: 'utf8', mode: 0o444, flag: 'wx' },
    )
  }
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify(executionPackage.manifest),
    { encoding: 'utf8', mode: 0o444, flag: 'wx' },
  )
}

export function buildOciRunArguments(input: {
  containerName: string
  packageRoot: string
  outputRoot: string
  attemptId: string
  packageSha256: string
  networkName: string
  imageReference: string
  imageDigest: string
  entrypoint: string
  pidsLimit: number
  memoryBytes: number
  cpuLimit: number
  secretEnvironmentNames: readonly string[]
}) {
  return [
    'run',
    '--rm',
    '--init',
    '--name',
    input.containerName,
    '--hostname',
    'smarthub-runner',
    '--user',
    '10001:10001',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(input.pidsLimit),
    '--memory',
    String(input.memoryBytes),
    '--cpus',
    String(input.cpuLimit),
    '--network',
    input.networkName,
    '--ipc',
    'none',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=268435456,mode=1777',
    '--tmpfs',
    '/dev/shm:rw,nosuid,nodev,size=268435456,mode=1777',
    '--mount',
    `type=bind,src=${resolve(input.packageRoot)},dst=/smarthub/package,readonly`,
    '--mount',
    `type=bind,src=${resolve(input.outputRoot)},dst=/smarthub/output`,
    '--workdir',
    '/smarthub/package',
    '--env',
    'SMARTHUB_BASE_URL',
    '--env',
    'SMARTHUB_ALLOWED_TARGETS_JSON',
    ...[...input.secretEnvironmentNames]
      .sort()
      .flatMap(key => ['--env', key]),
    '--entrypoint',
    input.entrypoint,
    `${input.imageReference}@${input.imageDigest}`,
    '--manifest',
    '/smarthub/package/manifest.json',
    '--environment',
    '/smarthub/package/environment.json',
    '--output',
    '/smarthub/output',
    '--attempt-id',
    input.attemptId,
    '--package-sha256',
    input.packageSha256,
  ]
}

async function launchContainer(input: {
  options: NormalizedSandboxOptions
  attemptId: string
  packageSha256: string
  packageRoot: string
  outputRoot: string
  environment: ExecutionEnvironmentSnapshot
  secretEnvironment: Record<string, string>
  signal: AbortSignal
}) {
  const name = `smarthub-${input.attemptId}-${randomUUID().slice(0, 8)}`
  const networkName = input.options.networkPolicies[input.environment.signature]
  const args = buildOciRunArguments({
    containerName: name,
    packageRoot: input.packageRoot,
    outputRoot: input.outputRoot,
    attemptId: input.attemptId,
    packageSha256: input.packageSha256,
    networkName,
    imageReference: input.options.imageReference,
    imageDigest: input.options.imageDigest,
    entrypoint: input.options.entrypoint,
    pidsLimit: input.options.pidsLimit,
    memoryBytes: input.options.memoryBytes,
    cpuLimit: input.options.cpuLimit,
    secretEnvironmentNames: Object.keys(input.secretEnvironment),
  })
  const child = spawn(input.options.runtimeExecutable, args, {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SMARTHUB_BASE_URL: input.environment.baseUrl,
      SMARTHUB_ALLOWED_TARGETS_JSON: JSON.stringify(
        input.environment.targets,
      ),
      ...input.secretEnvironment,
    },
  })
  return collectProcess({
    child,
    signal: input.signal,
    timeoutMs: input.options.timeoutMs,
    maximumStdioBytes: input.options.maximumStdioBytes,
    terminateContainer: () => removeContainer(
      input.options.runtimeExecutable,
      name,
    ),
  })
}

async function collectProcess(input: {
  child: ChildProcess
  signal: AbortSignal
  timeoutMs: number
  maximumStdioBytes: number
  terminateContainer: () => Promise<void>
}): Promise<{
  exitCode?: number
  stdout: Buffer
  stderr: Buffer
  cancelled: boolean
  error?: string
}> {
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let totalOutputBytes = 0
  let processError: string | undefined
  let cancelled = false
  let termination: Promise<void> | undefined
  const collect = (target: Buffer[]) => (value: Buffer | string) => {
    const chunk = Buffer.from(value)
    totalOutputBytes += chunk.length
    if (totalOutputBytes <= input.maximumStdioBytes) {
      target.push(chunk)
    } else {
      processError ??= 'TEST_EXECUTION_RUNNER_STDIO_LIMIT_EXCEEDED'
    }
  }
  input.child.stdout?.on('data', collect(stdout))
  input.child.stderr?.on('data', collect(stderr))
  input.child.once('error', error => {
    processError = `TEST_EXECUTION_RUNNER_PROCESS_ERROR: ${error.message}`
  })
  const terminate = (reason: 'cancelled' | 'timeout') => {
    if (reason === 'cancelled') cancelled = true
    else processError ??=
      `TEST_EXECUTION_RUNNER_TIMEOUT: ${input.timeoutMs}ms`
    input.child.kill(reason === 'cancelled' ? 'SIGTERM' : 'SIGKILL')
    termination ??= input.terminateContainer()
  }
  const abort = () => terminate('cancelled')
  if (input.signal.aborted) abort()
  else input.signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => terminate('timeout'), input.timeoutMs)
  try {
    const exitCode = await new Promise<number | undefined>(resolvePromise => {
      input.child.once('close', code => resolvePromise(code ?? undefined))
    })
    await termination
    return {
      exitCode,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      cancelled: cancelled || input.signal.aborted,
      ...(processError ? { error: processError } : {}),
    }
  } finally {
    clearTimeout(timeout)
    input.signal.removeEventListener('abort', abort)
  }
}

async function removeContainer(executable: string, name: string) {
  try {
    await runCommand(executable, ['rm', '--force', name], 20_000)
  } catch {
    return
  }
}

async function writeCapturedOutput(
  root: string,
  stdout: Buffer,
  stderr: Buffer,
) {
  await Promise.all([
    stdout.length
      ? writeFile(join(root, 'runner-stdout.log'), stdout, { flag: 'wx' })
      : undefined,
    stderr.length
      ? writeFile(join(root, 'runner-stderr.log'), stderr, { flag: 'wx' })
      : undefined,
  ])
}

async function inspectAndIngestOutputs(input: {
  root: string
  artifactStore: ExecutionArtifactStore
  maximumOutputBytes: number
  attemptId: string
  packageSha256: string
  processExitCode?: number
}) {
  const files = await listOutputFiles(input.root)
  validateOutputFiles(files, input.maximumOutputBytes)
  const completionFile = files.find(
    file => file.relativePath === 'completion.json',
  )
  if (!completionFile) {
    throw new Error('TEST_EXECUTION_RUNNER_COMPLETION_REQUIRED')
  }
  const completion = await readCompletionManifest(
    completionFile.absolutePath,
    input.attemptId,
    input.packageSha256,
    input.processExitCode,
  )
  const artifacts = await storeOutputFiles(
    files,
    input.artifactStore,
    input.maximumOutputBytes,
  )
  return { completion, artifacts }
}

async function safelyIngestOutputs(
  root: string,
  artifactStore: ExecutionArtifactStore,
  maximumOutputBytes: number,
) {
  try {
    const files = await listOutputFiles(root)
    validateOutputFiles(files, maximumOutputBytes)
    return await storeOutputFiles(files, artifactStore, maximumOutputBytes)
  } catch {
    return []
  }
}

function validateOutputFiles(
  files: Awaited<ReturnType<typeof listOutputFiles>>,
  maximumOutputBytes: number,
) {
  if (files.length > 200) {
    throw new Error('TEST_EXECUTION_RUNNER_OUTPUT_FILE_LIMIT_EXCEEDED')
  }
  let totalBytes = 0
  for (const file of files) {
    if (!OUTPUT_RULES.some(rule => rule.pattern.test(file.relativePath))) {
      throw new Error(
        `TEST_EXECUTION_RUNNER_OUTPUT_NOT_ALLOWED: ${file.relativePath}`,
      )
    }
    totalBytes += file.size
    if (totalBytes > maximumOutputBytes) {
      throw new Error('TEST_EXECUTION_RUNNER_OUTPUT_SIZE_EXCEEDED')
    }
  }
}

async function storeOutputFiles(
  files: Awaited<ReturnType<typeof listOutputFiles>>,
  artifactStore: ExecutionArtifactStore,
  maximumOutputBytes: number,
) {
  const artifacts: RunnerArtifactObject[] = []
  for (const file of files) {
    const rule = OUTPUT_RULES.find(
      candidate => candidate.pattern.test(file.relativePath),
    )!
    const stored = await artifactStore.put({
      body: createReadStream(file.absolutePath),
      mimeType: rule.mimeType,
      maximumBytes: maximumOutputBytes,
    })
    artifacts.push({ ...stored, type: rule.type })
  }
  return artifacts
}

async function listOutputFiles(root: string) {
  const actualRoot = await realpath(root)
  const pending = [root]
  const files: Array<{
    absolutePath: string
    relativePath: string
    size: number
  }> = []
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name)
      const metadata = await lstat(absolutePath)
      if (metadata.isSymbolicLink()) {
        throw new Error('TEST_EXECUTION_RUNNER_OUTPUT_SYMLINK_FORBIDDEN')
      }
      const actual = await realpath(absolutePath)
      assertInside(actualRoot, actual)
      if (metadata.isDirectory()) {
        pending.push(absolutePath)
      } else if (metadata.isFile()) {
        files.push({
          absolutePath,
          relativePath: relative(root, absolutePath).replaceAll('\\', '/'),
          size: metadata.size,
        })
      } else {
        throw new Error('TEST_EXECUTION_RUNNER_OUTPUT_TYPE_FORBIDDEN')
      }
    }
  }
  return files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, 'en'))
}

async function readCompletionManifest(
  path: string,
  attemptId: string,
  packageSha256: string,
  processExitCode?: number,
): Promise<CompletionManifest> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new Error('TEST_EXECUTION_RUNNER_COMPLETION_INVALID')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('TEST_EXECUTION_RUNNER_COMPLETION_INVALID')
  }
  const record = value as Record<string, unknown>
  const exactKeys = [
    'schemaVersion',
    'attemptId',
    'packageSha256',
    'status',
    'exitCode',
    'durationMs',
    'summary',
    ...(record.error === undefined ? [] : ['error']),
  ].sort()
  if (Object.keys(record).sort().join('\0') !== exactKeys.join('\0')) {
    throw new Error('TEST_EXECUTION_RUNNER_COMPLETION_FIELDS_INVALID')
  }
  if (
    record.schemaVersion !== 'playwright-runner-completion/v1'
    || record.attemptId !== attemptId
    || record.packageSha256 !== packageSha256
    || !['passed', 'failed'].includes(String(record.status))
    || !Number.isSafeInteger(record.exitCode)
    || Number(record.exitCode) < 0
    || !Number.isSafeInteger(record.durationMs)
    || Number(record.durationMs) < 0
    || typeof record.summary !== 'string'
    || !record.summary.trim()
    || record.summary.length > 4_000
    || record.error !== undefined
      && (typeof record.error !== 'string' || record.error.length > 4_000)
    || processExitCode === undefined
    || record.exitCode !== processExitCode
    || record.status === 'passed' && record.exitCode !== 0
    || record.status === 'failed' && record.exitCode === 0
  ) {
    throw new Error('TEST_EXECUTION_RUNNER_COMPLETION_INVALID')
  }
  return record as CompletionManifest
}

async function assertNetworkPolicy(
  executable: string,
  environmentSignature: string,
  networkName: string,
) {
  const inspected = await runCommand(
    executable,
    [
      'network',
      'inspect',
      '--format',
      '{{ index .Labels "com.smarthub.environment-signature" }}',
      networkName,
    ],
    20_000,
  )
  if (inspected.stdout.toString('utf8').trim() !== environmentSignature) {
    throw new Error(
      `TEST_EXECUTION_RUNNER_NETWORK_SIGNATURE_MISMATCH: ${networkName}`,
    )
  }
}

function readinessArguments(options: NormalizedSandboxOptions) {
  return [
    'run',
    '--rm',
    '--user',
    '10001:10001',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--network',
    'none',
    '--pids-limit',
    '128',
    '--memory',
    '536870912',
    '--cpus',
    '1',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=67108864,mode=1777',
    '--entrypoint',
    options.entrypoint,
    qualifiedImage(options),
    '--readiness',
    '--runner-version',
    options.runnerVersion,
    '--playwright-version',
    options.playwrightVersion,
  ]
}

function validateEnvironment(
  environment: ExecutionEnvironmentSnapshot,
  networkPolicies: Readonly<Record<string, string>>,
) {
  if (!/^[a-f0-9]{64}$/u.test(environment.signature)) {
    throw new Error('TEST_EXECUTION_ENVIRONMENT_SIGNATURE_INVALID')
  }
  if (!networkPolicies[environment.signature]) {
    throw new Error('TEST_EXECUTION_RUNNER_NETWORK_POLICY_UNAVAILABLE')
  }
  if (
    !Array.isArray(environment.targets)
    || !environment.targets.length
    || environment.targets.length > 32
  ) {
    throw new Error('TEST_EXECUTION_ENVIRONMENT_TARGETS_INVALID')
  }
  const targets = new Set<string>()
  for (const target of environment.targets) {
    if (
      !['http', 'https'].includes(target.protocol)
      || !safeHost(target.host)
      || !Number.isSafeInteger(target.port)
      || target.port < 1
      || target.port > 65_535
    ) {
      throw new Error('TEST_EXECUTION_ENVIRONMENT_TARGET_INVALID')
    }
    const key = `${target.protocol}:${target.host.toLocaleLowerCase()}:${target.port}`
    if (targets.has(key)) {
      throw new Error('TEST_EXECUTION_ENVIRONMENT_TARGET_DUPLICATE')
    }
    targets.add(key)
  }
  let baseUrl: URL
  try {
    baseUrl = new URL(environment.baseUrl)
  } catch {
    throw new Error('TEST_EXECUTION_ENVIRONMENT_BASE_URL_INVALID')
  }
  if (
    !['http:', 'https:'].includes(baseUrl.protocol)
    || baseUrl.username
    || baseUrl.password
    || baseUrl.hash
  ) {
    throw new Error('TEST_EXECUTION_ENVIRONMENT_BASE_URL_INVALID')
  }
  const protocol = baseUrl.protocol.slice(0, -1)
  const port = baseUrl.port
    ? Number(baseUrl.port)
    : protocol === 'https' ? 443 : 80
  if (!targets.has(`${protocol}:${baseUrl.hostname.toLocaleLowerCase()}:${port}`)) {
    throw new Error('TEST_EXECUTION_ENVIRONMENT_BASE_URL_NOT_ALLOWED')
  }
  return structuredClone(environment)
}

function normalizeOptions(
  options: OciExecutionSandboxOptions,
): NormalizedSandboxOptions {
  const runtimeExecutable = requiredText(
    options.runtimeExecutable,
    'runtimeExecutable',
  )
  const imageReference = requiredText(options.imageReference, 'imageReference')
  const imageDigest = requiredText(options.imageDigest, 'imageDigest')
  const runnerVersion = requiredText(options.runnerVersion, 'runnerVersion')
  const playwrightVersion = requiredText(
    options.playwrightVersion,
    'playwrightVersion',
  )
  const entrypoint = requiredText(
    options.entrypoint ?? '/opt/smarthub/run-playwright',
    'entrypoint',
  )
  if (!/^sha256:[a-f0-9]{64}$/u.test(imageDigest)) {
    throw new Error('TEST_EXECUTION_RUNNER_IMAGE_DIGEST_INVALID')
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/:=-]{0,499}$/u.test(imageReference)
    || imageReference.includes('@')
  ) {
    throw new Error('TEST_EXECUTION_RUNNER_IMAGE_REFERENCE_INVALID')
  }
  if (!/^\/[A-Za-z0-9][A-Za-z0-9/._-]{0,499}$/u.test(entrypoint)) {
    throw new Error('TEST_EXECUTION_RUNNER_ENTRYPOINT_INVALID')
  }
  const runtimeName = basename(runtimeExecutable)
    .toLocaleLowerCase()
    .replace(/\.exe$/u, '')
  if (!['docker', 'podman'].includes(runtimeName)) {
    throw new Error('TEST_EXECUTION_CONTAINER_RUNTIME_INVALID')
  }
  const networkPolicies: Record<string, string> = {}
  for (const [signature, networkName] of Object.entries(
    options.networkPolicies,
  )) {
    if (!/^[a-f0-9]{64}$/u.test(signature) || !safeNetworkName(networkName)) {
      throw new Error('TEST_EXECUTION_RUNNER_NETWORK_POLICY_INVALID')
    }
    networkPolicies[signature] = networkName
  }
  if (!Object.keys(networkPolicies).length) {
    throw new Error('TEST_EXECUTION_RUNNER_NETWORK_POLICY_REQUIRED')
  }
  return {
    runtimeExecutable,
    imageReference,
    imageDigest,
    runnerVersion,
    playwrightVersion,
    networkPolicies: Object.freeze(networkPolicies),
    entrypoint,
    ...(options.workingRoot
      ? { workingRoot: resolve(options.workingRoot) }
      : {}),
    timeoutMs: positiveInteger(
      options.timeoutMs ?? 10 * 60_000,
      'timeoutMs',
    ),
    memoryBytes: positiveInteger(
      options.memoryBytes ?? 2 * 1024 * 1024 * 1024,
      'memoryBytes',
    ),
    cpuLimit: positiveNumber(options.cpuLimit ?? 2, 'cpuLimit'),
    pidsLimit: positiveInteger(options.pidsLimit ?? 512, 'pidsLimit'),
    maximumOutputBytes: positiveInteger(
      options.maximumOutputBytes ?? 512 * 1024 * 1024,
      'maximumOutputBytes',
    ),
    maximumStdioBytes: positiveInteger(
      options.maximumStdioBytes ?? 16 * 1024 * 1024,
      'maximumStdioBytes',
    ),
  }
}

function normalizeSecretEnvironment(
  values: Readonly<Record<string, string>>,
) {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    if (!/^SMARTHUB_SECRET_[A-Z0-9_]{1,80}$/u.test(key)) {
      throw new Error(`TEST_EXECUTION_SECRET_NAME_INVALID: ${key}`)
    }
    if (
      typeof value !== 'string'
      || value.includes('\0')
      || Buffer.byteLength(value, 'utf8') > 64 * 1024
    ) {
      throw new Error(`TEST_EXECUTION_SECRET_VALUE_INVALID: ${key}`)
    }
    result[key] = value
  }
  return result
}

async function runCommand(
  executable: string,
  args: string[],
  timeoutMs: number,
) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const result = await collectProcess({
      child,
      signal: controller.signal,
      timeoutMs,
      maximumStdioBytes: 1024 * 1024,
      terminateContainer: async () => undefined,
    })
    if (result.error || result.exitCode !== 0) {
      const output = Buffer.concat([result.stdout, result.stderr])
        .toString('utf8')
        .trim()
        .slice(0, 1_000)
      throw new Error(
        result.error
          ?? (output
            || `TEST_EXECUTION_RUNNER_COMMAND_EXIT_${result.exitCode}`),
      )
    }
    return result
  } finally {
    clearTimeout(timeout)
  }
}

function qualifiedImage(
  options: Pick<OciExecutionSandboxOptions, 'imageReference' | 'imageDigest'>,
) {
  return `${options.imageReference}@${options.imageDigest}`
}

function safeIdentity(value: string, label: string) {
  const result = String(value ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(result)) {
    throw new Error(
      `TEST_EXECUTION_${label.toLocaleUpperCase()}_INVALID`,
    )
  }
  return result
}

function safeHost(value: string) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 253
    && !value.includes('\0')
    && (/^[A-Za-z0-9.-]+$/u.test(value)
      || /^\[[A-Fa-f0-9:]+\]$/u.test(value))
}

function safeNetworkName(value: string) {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value)
    && !['host', 'bridge', 'none', 'default'].includes(
      value.toLocaleLowerCase(),
    )
}

function assertInside(root: string, target: string) {
  const base = resolve(root)
  const resolved = resolve(target)
  if (resolved !== base && !resolved.startsWith(`${base}${sep}`)) {
    throw new Error('TEST_EXECUTION_RUNNER_PATH_OUTSIDE_ROOT')
  }
}

function requiredText(value: unknown, label: string) {
  const result = String(value ?? '').trim()
  if (!result || result.length > 1_000 || result.includes('\0')) {
    throw new Error(
      `TEST_EXECUTION_RUNNER_${label.toLocaleUpperCase()}_INVALID`,
    )
  }
  return result
}

function positiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `TEST_EXECUTION_RUNNER_${label.toLocaleUpperCase()}_INVALID`,
    )
  }
  return value
}

function positiveNumber(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `TEST_EXECUTION_RUNNER_${label.toLocaleUpperCase()}_INVALID`,
    )
  }
  return value
}
