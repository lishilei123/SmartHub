import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  ExecutionEventStatus,
  ExecutionEventType,
  ExecutionRunnerSnapshot,
  RunnerExecutionEvent,
} from '../domain/test-execution-types.js'
import { assertExecutionPackageIntegrity } from '../application/test-execution-validation.js'
import type { ExecutionEnvironmentSecretResolver, PlaywrightRunner } from './playwright-runner.js'
import type { RunnerArtifactObject, SandboxExecutionResult } from './execution-sandbox.js'
import type { ExecutionArtifactStore } from '../infrastructure/execution-artifact-store.js'

/** Local runner for the ProjectVersion-owned automation workspace. */
export class LocalWorkspaceRunner implements PlaywrightRunner {
  private readonly playwright: LocalPlaywrightInstallation
  private readonly value: ExecutionRunnerSnapshot

  constructor(
    private readonly artifacts: ExecutionArtifactStore,
    private readonly timeoutMs = 120_000,
    private readonly secretResolver: ExecutionEnvironmentSecretResolver = emptySecretResolver,
    playwright?: LocalPlaywrightInstallation,
  ) {
    this.playwright = playwright ?? localPlaywrightInstallation()
    this.value = {
      runnerVersion: 'local-workspace/v3',
      playwrightVersion: this.playwright.version,
      imageReference: 'local-workspace',
      imageDigest: `sha256:${'0'.repeat(64)}`,
    }
  }

  snapshot() { return structuredClone(this.value) }
  async readiness() {
    try {
      if (this.playwright.error) throw new Error(this.playwright.error)
      await Promise.all([
        access(this.playwright.packagePath),
        access(this.playwright.cliPath),
      ])
      const manifest = JSON.parse(await readFile(this.playwright.packagePath, 'utf8')) as { version?: unknown }
      if (manifest.version !== this.playwright.version || !validPlaywrightVersion(manifest.version)) {
        throw new Error('TEST_EXECUTION_PLAYWRIGHT_VERSION_INVALID')
      }
      return { ready: true, snapshot: this.snapshot() }
    } catch (error) {
      return { ready: false, reason: error instanceof Error ? error.message : String(error), snapshot: this.snapshot() }
    }
  }

  async execute(input: Parameters<PlaywrightRunner['execute']>[0], signal: AbortSignal): Promise<SandboxExecutionResult> {
    if (!input.workspace) throw new Error('TEST_EXECUTION_LOCAL_WORKSPACE_REQUIRED')
    if (this.playwright.error) throw new Error(this.playwright.error)
    if (JSON.stringify(input.runner) !== JSON.stringify(this.value)) throw new Error('TEST_EXECUTION_RUNNER_SNAPSHOT_DRIFT')
    const executionPackage = assertExecutionPackageIntegrity({
      package: input.package,
      task: input.task,
      environmentSignature: input.environment.signature,
      expectedPackageSha256: input.expectedPackageSha256,
    })
    const workspaceRoot = resolve(input.workspace.root)
    const entry = resolve(workspaceRoot, ...input.workspace.entryFile.split('/'))
    const authStateRoot = resolve(input.workspace.authStateRoot)
    const authStatePath = relative(workspaceRoot, authStateRoot).replaceAll('\\', '/')
    if (!inside(workspaceRoot, entry)) throw new Error('TEST_EXECUTION_WORKSPACE_ENTRY_INVALID')
    if (!inside(workspaceRoot, authStateRoot) || !/^\.runtime-auth\/[A-Za-z0-9._-]{1,200}$/u.test(authStatePath)) {
      throw new Error('TEST_EXECUTION_AUTH_STATE_SCOPE_INVALID')
    }
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
      const reporterPath = join(runtimeRoot, 'playwright-report.json')
      await mkdir(authStateRoot, { recursive: true, mode: 0o700 })
      await writeFile(
        configPath,
        localPlaywrightConfig(
          workspaceRoot,
          join(runtimeRoot, 'test-results'),
          reporterPath,
          authStateRoot,
        ),
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
      const report = parsePlaywrightJsonReport(
        JSON.parse(await readFile(reporterPath, 'utf8')) as unknown,
        input.workspace.entrySymbol,
      )
      const attachmentArtifacts = await ingestReporterAttachments(
        runtimeRoot,
        report.attachments,
        this.artifacts,
      )
      const artifacts = [
        ...(artifact ? [{ ...artifact, type: 'log' as const }] : []),
        ...attachmentArtifacts,
      ]
      const passed = exitCode === 0
      const attachmentSha256s = attachmentArtifacts.map(item => item.sha256)
      const events = report.events.map(event =>
        event.type === 'failure' || event.type === 'runner' && event.status === 'failed'
          ? { ...event, artifactSha256s: attachmentSha256s }
          : event)
      events.push(...attachmentArtifacts.map((item, index): RunnerExecutionEvent => ({
        sequence: events.length + index + 1,
        type: item.type === 'screenshot' ? 'screenshot' : item.type === 'trace' ? 'trace' : 'video',
        title: item.type === 'screenshot' ? '失败页面截图' : item.type === 'trace' ? 'Playwright Trace' : 'Playwright Video',
        status: passed ? 'passed' : 'failed',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        artifactSha256s: [item.sha256],
        metadata: { source: 'playwright_json_reporter' },
      })))
      return {
        status: passed ? 'passed' : 'failed',
        exitCode: exitCode ?? undefined,
        durationMs: Date.now() - started,
        summary: passed ? 'Local Playwright 通过' : 'Local Playwright 失败',
        ...(passed ? {} : { error: `PLAYWRIGHT_EXIT_${exitCode ?? 'UNKNOWN'}` }),
        artifacts,
        events,
      }
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true })
    }
  }
}

const emptySecretResolver: ExecutionEnvironmentSecretResolver = {
  async resolveForLaunch() { return {} },
}

export interface LocalPlaywrightInstallation {
  version: string
  packagePath: string
  cliPath: string
  error?: string
}

function localPlaywrightInstallation(): LocalPlaywrightInstallation {
  const require = createRequire(import.meta.url)
  try {
    const packagePath = require.resolve('@playwright/test/package.json')
    const value = require(packagePath) as { version?: unknown }
    if (!validPlaywrightVersion(value.version)) {
      return { version: 'unavailable', packagePath, cliPath: '', error: 'TEST_EXECUTION_PLAYWRIGHT_VERSION_INVALID' }
    }
    return { version: value.version, packagePath, cliPath: join(dirname(packagePath), 'cli.js') }
  } catch (error) {
    return {
      version: 'unavailable',
      packagePath: '',
      cliPath: '',
      error: `TEST_EXECUTION_PLAYWRIGHT_PACKAGE_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export function localPlaywrightConfig(
  workspaceRoot: string,
  outputRoot: string,
  reporterPath = join(outputRoot, 'playwright-report.json'),
  authStateRoot = join(outputRoot, '.runtime-auth'),
) {
  return [
    "const baseURL = process.env.SMARTHUB_BASE_URL",
    "if (!baseURL) throw new Error('TEST_EXECUTION_BASE_URL_REQUIRED')",
    `export default { testDir: ${JSON.stringify(workspaceRoot)}, outputDir: ${JSON.stringify(outputRoot)}, reporter: [['json', { outputFile: ${JSON.stringify(reporterPath)} }]], metadata: { smarthubAuthState: { directory: ${JSON.stringify(authStateRoot)}, scope: 'run', ephemeral: true } }, use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' } }`,
    '',
  ].join('\n')
}

type PlaywrightJsonAttachment = {
  name: string
  contentType: string
  path: string
}

type PlaywrightJsonStep = {
  title?: unknown
  category?: unknown
  duration?: unknown
  error?: unknown
  steps?: unknown
}

/** Parse only Playwright's structured JSON reporter contract, never stdout. */
export function parsePlaywrightJsonReport(value: unknown, entrySymbol: string): {
  events: RunnerExecutionEvent[]
  attachments: PlaywrightJsonAttachment[]
} {
  if (!value || typeof value !== 'object') throw new Error('TEST_EXECUTION_PLAYWRIGHT_REPORT_INVALID')
  const record = value as Record<string, unknown>
  const specs = collectReporterSpecs(record.suites)
    .filter(spec => reporterTitleMatches(String(spec.title ?? ''), entrySymbol))
  if (specs.length !== 1) throw new Error('TEST_EXECUTION_PLAYWRIGHT_REPORT_ENTRY_COUNT_INVALID')
  const tests = Array.isArray(specs[0].tests) ? specs[0].tests : []
  const results = tests.flatMap(test => {
    if (!test || typeof test !== 'object') return []
    const value = (test as Record<string, unknown>).results
    return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as Array<Record<string, unknown>> : []
  })
  if (!results.length) throw new Error('TEST_EXECUTION_PLAYWRIGHT_REPORT_RESULT_REQUIRED')
  const events: RunnerExecutionEvent[] = []
  const attachments: PlaywrightJsonAttachment[] = []
  for (const result of results) {
    const startedAt = safeTimestamp(result.startTime)
    const durationMs = safeDuration(result.duration)
    const retry = Number(result.retry ?? 0)
    if (Number.isSafeInteger(retry) && retry > 0) {
      events.push(eventRecord('retry', `Playwright retry #${retry}`, 'passed', startedAt, 0))
    }
    let offsetMs = 0
    const appendSteps = (steps: unknown) => {
      if (!Array.isArray(steps)) return
      for (const candidate of steps) {
        if (!candidate || typeof candidate !== 'object') continue
        const step = candidate as PlaywrightJsonStep
        const duration = safeDuration(step.duration)
        const type = reporterStepType(String(step.category ?? ''), String(step.title ?? ''))
        const start = new Date(Date.parse(startedAt) + offsetMs).toISOString()
        const status: ExecutionEventStatus = step.error ? 'failed' : 'passed'
        const http = safeHttpMetadata(String(step.title ?? ''))
        events.push({
          ...eventRecord(
            type,
            safeExecutionTitle(String(step.title ?? 'Playwright step'), type, http),
            status,
            start,
            duration,
          ),
          metadata: {
            source: 'playwright_json_reporter',
            category: safeMetadataText(String(step.category ?? 'step'), 80),
            ...http,
          },
        })
        offsetMs += duration
        appendSteps(step.steps)
      }
    }
    appendSteps(result.steps)
    const status = reporterStatus(result.status)
    const resultAttachments = Array.isArray(result.attachments) ? result.attachments : []
    for (const candidate of resultAttachments) {
      if (!candidate || typeof candidate !== 'object') continue
      const attachment = candidate as Record<string, unknown>
      if (typeof attachment.path !== 'string' || typeof attachment.contentType !== 'string') continue
      attachments.push({
        name: safeMetadataText(String(attachment.name ?? 'artifact'), 120),
        contentType: safeMetadataText(attachment.contentType, 120),
        path: attachment.path,
      })
    }
    if (status === 'failed') {
      events.push(eventRecord('failure', 'Playwright 执行失败', 'failed', startedAt, durationMs))
    }
    events.push({
      ...eventRecord(
        'runner',
        safeExecutionTitle(String(specs[0].title ?? entrySymbol), 'runner'),
        status,
        startedAt,
        durationMs,
      ),
      metadata: { source: 'playwright_json_reporter', retry: Number.isSafeInteger(retry) ? retry : 0 },
    })
  }
  return {
    events: events.map((event, index) => ({ ...event, sequence: index + 1 })),
    attachments: [...new Map(attachments.map(item => [item.path, item])).values()],
  }
}

function collectReporterSpecs(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.flatMap(candidate => {
    if (!candidate || typeof candidate !== 'object') return []
    const suite = candidate as Record<string, unknown>
    return [
      ...(Array.isArray(suite.specs)
        ? suite.specs.filter(spec => spec && typeof spec === 'object') as Array<Record<string, unknown>>
        : []),
      ...collectReporterSpecs(suite.suites),
    ]
  })
}

function reporterTitleMatches(title: string, entrySymbol: string) {
  return title === entrySymbol || title.endsWith(` ${entrySymbol}`)
}

function reporterStepType(category: string, title: string): ExecutionEventType {
  if (safeHttpMetadata(title).method) return 'http'
  if (category === 'expect' || /\bexpect\b/iu.test(title)) return 'assertion'
  if (/\b(?:goto|navigate|open)\b/iu.test(title)) return 'navigate'
  if (/\bclick\b/iu.test(title)) return 'click'
  if (/\b(?:fill|type|pressSequentially)\b/iu.test(title)) return 'fill'
  if (/\bscreenshot\b/iu.test(title)) return 'screenshot'
  return 'step'
}

function reporterStatus(value: unknown): ExecutionEventStatus {
  if (value === 'passed') return 'passed'
  if (value === 'skipped') return 'skipped'
  return 'failed'
}

function eventRecord(
  type: ExecutionEventType,
  title: string,
  status: ExecutionEventStatus,
  startedAt: string,
  durationMs: number,
): RunnerExecutionEvent {
  return {
    sequence: 0,
    type,
    title,
    status,
    startedAt,
    finishedAt: new Date(Date.parse(startedAt) + durationMs).toISOString(),
    durationMs,
  }
}

function safeHttpMetadata(title: string) {
  const request = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b[^/]*(https?:\/\/[^\s"')]+|\/[^\s"')]+)/iu.exec(title)
  if (!request) return {} as { method?: string; path?: string; httpStatus?: number; queryFields?: string[] }
  let path = request[2]
  let queryFields: string[] = []
  try {
    const url = new URL(path, 'https://smarthub.invalid')
    path = url.pathname
    queryFields = [...new Set([...url.searchParams.keys()])].sort()
  } catch {
    path = path.split('?')[0]
  }
  const status = /(?:->|=>|→|status\s*[:=]?)\s*(\d{3})\b/iu.exec(title)
  return {
    method: request[1].toUpperCase(),
    path: safeMetadataText(path, 500),
    ...(status ? { httpStatus: Number(status[1]) } : {}),
    ...(queryFields.length ? { queryFields } : {}),
  }
}

function safeExecutionTitle(
  value: string,
  type: ExecutionEventType,
  http: ReturnType<typeof safeHttpMetadata> = {},
) {
  if (http.method && http.path) {
    return `${http.method} ${http.path}${http.httpStatus ? ` · ${http.httpStatus}` : ''}`
  }
  if (type === 'fill') {
    const target = value.split(/\b(?:fill|type|pressSequentially)\b/iu)[0].trim()
    return safeMetadataText(`${target || '输入控件'} · 填写内容已脱敏`, 500)
  }
  let result = value.replace(/https?:\/\/[^\s"')]+/giu, raw => {
    try { return new URL(raw).pathname } catch { return '<redacted-url>' }
  })
  result = result.replace(
    /\b(authorization|cookie|set-cookie|password|token|api[_ -]?key|secret)\b\s*[:=]\s*[^\s,;]+/giu,
    '$1=<REDACTED>',
  )
  return safeMetadataText(result || 'Playwright step', 500)
}

function safeMetadataText(value: string, maximum: number) {
  return value.replace(/[\u0000-\u001F\u007F]/gu, ' ').trim().slice(0, maximum)
}

function safeTimestamp(value: unknown) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString()
}

function safeDuration(value: unknown) {
  const duration = Number(value ?? 0)
  return Number.isFinite(duration) && duration >= 0 ? Math.min(Math.round(duration), 24 * 60 * 60 * 1_000) : 0
}

async function ingestReporterAttachments(
  runtimeRoot: string,
  attachments: readonly PlaywrightJsonAttachment[],
  store: ExecutionArtifactStore,
): Promise<RunnerArtifactObject[]> {
  const actualRoot = await realpath(runtimeRoot)
  const results: RunnerArtifactObject[] = []
  for (const attachment of attachments) {
    const type = reporterAttachmentType(attachment)
    if (!type) continue
    const target = resolve(runtimeRoot, attachment.path)
    const [actual, metadata] = await Promise.all([realpath(target), lstat(target)])
    if (!inside(actualRoot, actual) || !metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('TEST_EXECUTION_PLAYWRIGHT_ATTACHMENT_INVALID')
    }
    const stored = await store.put({
      body: createReadStream(actual),
      mimeType: attachment.contentType,
      maximumBytes: 512 * 1024 * 1024,
    })
    results.push({ ...stored, type })
  }
  return results
}

function reporterAttachmentType(attachment: PlaywrightJsonAttachment): RunnerArtifactObject['type'] | undefined {
  if (attachment.contentType === 'image/png') return 'screenshot'
  if (attachment.contentType === 'application/zip' || /trace/iu.test(attachment.name)) return 'trace'
  if (attachment.contentType === 'video/webm') return 'video'
  return undefined
}

function validPlaywrightVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(value)
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
