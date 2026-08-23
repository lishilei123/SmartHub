import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { ExecutionRunnerSnapshot } from '../domain/test-execution-types.js'
import { assertExecutionPackageIntegrity } from '../application/test-execution-validation.js'
import type { ExecutionEnvironmentSecretResolver, PlaywrightRunner } from './playwright-runner.js'
import type { SandboxExecutionResult } from './execution-sandbox.js'
import type { ExecutionArtifactStore } from '../infrastructure/execution-artifact-store.js'

/** Local runner for the ProjectVersion-owned automation workspace. */
export class LocalWorkspaceRunner implements PlaywrightRunner {
  private readonly playwright = localPlaywrightInstallation()
  private readonly value: ExecutionRunnerSnapshot = {
    runnerVersion: 'local-workspace/v2',
    playwrightVersion: this.playwright.version,
    imageReference: 'local-workspace',
    imageDigest: `sha256:${'0'.repeat(64)}`,
  }

  constructor(
    private readonly artifacts: ExecutionArtifactStore,
    private readonly timeoutMs = 120_000,
    private readonly secretResolver: ExecutionEnvironmentSecretResolver = emptySecretResolver,
  ) {}

  snapshot() { return structuredClone(this.value) }
  async readiness() {
    try {
      await access(this.playwright.cliPath)
      return { ready: true, snapshot: this.snapshot() }
    } catch (error) {
      return { ready: false, reason: error instanceof Error ? error.message : String(error), snapshot: this.snapshot() }
    }
  }

  async execute(input: Parameters<PlaywrightRunner['execute']>[0], signal: AbortSignal): Promise<SandboxExecutionResult> {
    if (!input.workspace) throw new Error('TEST_EXECUTION_LOCAL_WORKSPACE_REQUIRED')
    if (JSON.stringify(input.runner) !== JSON.stringify(this.value)) throw new Error('TEST_EXECUTION_RUNNER_SNAPSHOT_DRIFT')
    const executionPackage = assertExecutionPackageIntegrity({
      package: input.package,
      task: input.task,
      environmentSignature: input.environment.signature,
      expectedPackageSha256: input.expectedPackageSha256,
    })
    const workspaceRoot = resolve(input.workspace.root)
    const entry = resolve(workspaceRoot, ...input.workspace.entryFile.split('/'))
    if (!inside(workspaceRoot, entry)) throw new Error('TEST_EXECUTION_WORKSPACE_ENTRY_INVALID')
    await access(entry)
    for (const file of executionPackage.files) {
      const target = resolve(workspaceRoot, ...file.path.split('/'))
      if (!inside(workspaceRoot, target)) throw new Error('TEST_EXECUTION_WORKSPACE_DEPENDENCY_INVALID')
      const content = await readFile(target, 'utf8')
      if (sha256(content) !== file.contentSha256) throw new Error('TEST_EXECUTION_WORKSPACE_DEPENDENCY_DRIFT')
    }
    if (signal.aborted) return cancelled()
    const secretEnvironment = normalizeSecretEnvironment(await this.secretResolver.resolveForLaunch({
      environmentId: input.environment.environmentId,
      environmentSignature: input.environment.signature,
      ...(input.runner.configurationId ? { configurationId: input.runner.configurationId } : {}),
    }, signal))
    if (signal.aborted) return cancelled()
    const started = Date.now()
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'smarthub-playwright-config-'))
    try {
      const configPath = join(runtimeRoot, 'playwright.config.mjs')
      await writeFile(
        configPath,
        localPlaywrightConfig(workspaceRoot, join(runtimeRoot, 'test-results')),
        { encoding: 'utf8' },
      )
      const args = [
        this.playwright.cliPath,
        'test',
        '--config',
        configPath,
        input.workspace.entryFile,
        '--grep',
        `${escapeRegExp(input.workspace.entrySymbol)}$`,
      ]
      const child = spawn(process.execPath, args, {
        cwd: workspaceRoot,
        shell: false,
        windowsHide: true,
        env: {
          ...infrastructureEnvironment(),
          SMARTHUB_BASE_URL: input.environment.baseUrl,
          ...secretEnvironment,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)))
      child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)))
      const terminate = () => child.kill('SIGTERM')
      signal.addEventListener('abort', terminate, { once: true })
      const timeout = setTimeout(() => child.kill('SIGKILL'), this.timeoutMs)
      const exitCode = await new Promise<number | null>(resolveExit => child.once('close', resolveExit))
      clearTimeout(timeout)
      signal.removeEventListener('abort', terminate)
      const output = redactRunnerOutput(
        Buffer.concat([Buffer.concat(stdout), Buffer.concat(stderr)]),
        Object.values(secretEnvironment),
      )
      const artifact = output.length ? await this.artifacts.put({ body: bytes(output), mimeType: 'text/plain; charset=utf-8', maximumBytes: 2 * 1024 * 1024 }) : undefined
      if (signal.aborted) return { ...cancelled(Date.now() - started), artifacts: artifact ? [{ ...artifact, type: 'log' }] : [] }
      const passed = exitCode === 0
      return {
        status: passed ? 'passed' : 'failed',
        exitCode: exitCode ?? undefined,
        durationMs: Date.now() - started,
        summary: passed ? 'Local Playwright 通过' : 'Local Playwright 失败',
        ...(passed ? {} : { error: `PLAYWRIGHT_EXIT_${exitCode ?? 'UNKNOWN'}` }),
        artifacts: artifact ? [{ ...artifact, type: 'log' }] : [],
      }
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true })
    }
  }
}

const emptySecretResolver: ExecutionEnvironmentSecretResolver = {
  async resolveForLaunch() { return {} },
}

function localPlaywrightInstallation() {
  const require = createRequire(import.meta.url)
  const packagePath = require.resolve('@playwright/test/package.json')
  const value = require(packagePath) as { version?: unknown }
  if (typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(value.version)) {
    throw new Error('TEST_EXECUTION_PLAYWRIGHT_VERSION_INVALID')
  }
  return { version: value.version, cliPath: join(dirname(packagePath), 'cli.js') }
}

export function localPlaywrightConfig(workspaceRoot: string, outputRoot: string) {
  return [
    "const baseURL = process.env.SMARTHUB_BASE_URL",
    "if (!baseURL) throw new Error('TEST_EXECUTION_BASE_URL_REQUIRED')",
    `export default { testDir: ${JSON.stringify(workspaceRoot)}, outputDir: ${JSON.stringify(outputRoot)}, use: { baseURL } }`,
    '',
  ].join('\n')
}

function infrastructureEnvironment() {
  const allowed = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']
  return Object.fromEntries(allowed.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]))
}

function normalizeSecretEnvironment(values: Readonly<Record<string, string>>) {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    if (!/^SMARTHUB_SECRET_[A-Z0-9_]{1,80}$/u.test(key) || typeof value !== 'string' || !value) {
      throw new Error('TEST_EXECUTION_SECRET_ENVIRONMENT_INVALID')
    }
    result[key] = value
  }
  return result
}

function inside(root: string, target: string) {
  const path = relative(root, target)
  return path !== '' && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\')
}

function cancelled(durationMs = 0): SandboxExecutionResult {
  return { status: 'cancelled', durationMs, summary: 'Local Runner 已取消', error: 'TEST_EXECUTION_RUNNER_CANCELLED', artifacts: [] }
}

function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') }
function sha256(value: string) { return createHash('sha256').update(value, 'utf8').digest('hex') }
async function* bytes(value: Buffer) { yield value }

function redactRunnerOutput(output: Buffer, secrets: readonly string[]) {
  let value = output.toString('utf8')
  for (const secret of [...new Set(secrets)].sort((left, right) => right.length - left.length)) {
    value = value.replaceAll(secret, '<REDACTED>')
  }
  return Buffer.from(value, 'utf8')
}
