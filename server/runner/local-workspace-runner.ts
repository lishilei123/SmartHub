import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import JSZip, { type JSZipObject } from 'jszip'
import type {
  ExecutionEventStatus,
  ExecutionEventType,
  ExecutionRunnerSnapshot,
  RunnerExecutionEvent,
} from '../domain/test-execution-types.js'
import { canonicalSha256 } from '../application/canonical-json.js'
import type { RuntimeApiAuthorization } from '../application/test-execution-auth-session.js'
import {
  assertExecutionPackageIntegrity,
  GOVERNED_UI_API_TEST_MODULE,
} from '../application/test-execution-validation.js'
import type { ExecutionEnvironmentSecretResolver, PlaywrightRunner } from './playwright-runner.js'
import type { RunnerArtifactObject, SandboxExecutionResult } from './execution-sandbox.js'
import type { ExecutionArtifactStore } from '../infrastructure/execution-artifact-store.js'
import { withWindowsHiddenNodeChildren } from './windows-child-process.js'

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
      runnerVersion: 'local-workspace/v10',
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
    if (canonicalSha256(input.runner) !== canonicalSha256(this.value)) throw new Error('TEST_EXECUTION_RUNNER_SNAPSHOT_DRIFT')
    const executionPackage = assertExecutionPackageIntegrity({
      package: input.package,
      task: input.task,
      environmentSignature: input.environment.signature,
      expectedPackageSha256: input.expectedPackageSha256,
    })
    const workspaceRoot = resolve(input.workspace.root)
    const authStateRoot = resolve(input.workspace.authStateRoot)
    const authStatePath = relative(workspaceRoot, authStateRoot).replaceAll('\\', '/')
    const authStateFile = input.workspace.authStatePath
      ? resolve(input.workspace.authStatePath)
      : undefined
    const apiAuthorization = input.workspace.apiAuthorization
    if (!inside(workspaceRoot, authStateRoot) || !/^\.runtime-auth\/[A-Za-z0-9._-]{1,200}$/u.test(authStatePath)) {
      throw new Error('TEST_EXECUTION_AUTH_STATE_SCOPE_INVALID')
    }
    if (authStateFile) {
      const relativeState = relative(authStateRoot, authStateFile).replaceAll('\\', '/')
      if (!inside(authStateRoot, authStateFile) || !/^[A-Za-z0-9._-]{1,200}\.json$/u.test(relativeState)) {
        throw new Error('TEST_EXECUTION_AUTH_STATE_FILE_INVALID')
      }
      const [actualAuthRoot, actualAuthState, authStateMetadata] = await Promise.all([
        realpath(authStateRoot),
        realpath(authStateFile),
        lstat(authStateFile),
      ])
      if (
        !inside(actualAuthRoot, actualAuthState)
        || !authStateMetadata.isFile()
        || authStateMetadata.isSymbolicLink()
      ) throw new Error('TEST_EXECUTION_AUTH_STATE_FILE_INVALID')
    }
    if (apiAuthorization && !authStateFile) {
      throw new Error('TEST_EXECUTION_API_AUTHORIZATION_STATE_REQUIRED')
    }
    const runtimeApiAuthorization = apiAuthorization && authStateFile
      ? await readRuntimeApiAuthorization(authStateFile, apiAuthorization, input.environment.baseUrl)
      : undefined
    const apiAuthorizationMode = input.workspace.apiAuthorizationMode
      ?? (runtimeApiAuthorization ? 'default_request_context' : undefined)
    if (signal.aborted) return cancelled()
    const secretEnvironment = normalizeSecretEnvironment(await this.secretResolver.resolveForLaunch({
      environmentId: input.environment.environmentId,
      environmentSignature: input.environment.signature,
      ...(input.runner.configurationId ? { configurationId: input.runner.configurationId } : {}),
    }, signal))
    if (signal.aborted) return cancelled()
    const started = Date.now()
    // Execute the immutable ScriptRevision package, not the mutable shared
    // ProjectVersion workspace. Keeping the temporary root beside ProjectVersion
    // workspaces preserves normal Node module resolution up to the repository.
    const runtimeRoot = await mkdtemp(join(dirname(workspaceRoot), '.runtime-execution-'))
    try {
      const executionRoot = join(runtimeRoot, 'workspace')
      const configPath = join(runtimeRoot, 'playwright.config.mjs')
      const reporterPath = join(runtimeRoot, 'playwright-report.json')
      await mkdir(executionRoot, { recursive: true })
      if (runtimeApiAuthorization && apiAuthorizationMode === 'isolated_ui_request_fixture') {
        await writeGovernedUiApiFixture(runtimeRoot)
      }
      for (const file of executionPackage.files) {
        const target = resolve(executionRoot, ...file.path.split('/'))
        if (!inside(executionRoot, target)) throw new Error('TEST_EXECUTION_WORKSPACE_DEPENDENCY_INVALID')
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, file.content, { encoding: 'utf8' })
      }
      const entry = resolve(executionRoot, ...input.workspace.entryFile.split('/'))
      if (!inside(executionRoot, entry)) throw new Error('TEST_EXECUTION_WORKSPACE_ENTRY_INVALID')
      await access(entry)
      await mkdir(authStateRoot, { recursive: true, mode: 0o700 })
      await writeFile(
        configPath,
        localPlaywrightConfig(
          executionRoot,
          join(runtimeRoot, 'test-results'),
          reporterPath,
          authStateRoot,
          authStateFile,
          Boolean(runtimeApiAuthorization && apiAuthorizationMode === 'default_request_context'),
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
        cwd: executionRoot,
        shell: false,
        windowsHide: true,
        env: {
          ...withWindowsHiddenNodeChildren(infrastructureEnvironment()),
          PLAYWRIGHT_HTML_OPEN: 'never',
          SMARTHUB_BASE_URL: input.environment.baseUrl,
          ...secretEnvironment,
          ...(runtimeApiAuthorization
            ? { SMARTHUB_RUNTIME_API_AUTHORIZATION: runtimeApiAuthorization }
            : {}),
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
      const sensitiveValues = [
        ...Object.values(secretEnvironment),
        ...(runtimeApiAuthorization
          ? [runtimeApiAuthorization, runtimeApiAuthorization.replace(/^Bearer\s+/iu, '')]
          : []),
      ]
      const output = redactRunnerOutput(
        Buffer.concat([Buffer.concat(stdout), Buffer.concat(stderr)]),
        sensitiveValues,
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
        sensitiveValues,
      )
      const traceEvidence = await readPlaywrightTraceEvidence(
        runtimeRoot,
        report.attachments,
        input.environment.baseUrl,
        sensitiveValues,
      )
      report.events = applyPlaywrightTraceHttpObservations(
        report.events,
        traceEvidence.http,
      )
      const artifacts = [
        ...(artifact ? [{ ...artifact, type: 'log' as const }] : []),
        ...attachmentArtifacts,
      ]
      const passed = exitCode === 0
      const events = report.events.slice()
      if (traceEvidence.terminalPage) {
        const traceArtifacts = attachmentArtifacts.filter(item => item.type === 'trace')
        events.push(terminalPageEvent(
          traceEvidence.terminalPage,
          traceArtifacts.length === 1 ? traceArtifacts[0].sha256 : undefined,
        ))
      }
      events.push(...attachmentArtifacts.map((item, index): RunnerExecutionEvent => ({
        sequence: events.length + index + 1,
        type: item.type === 'screenshot' ? 'screenshot' : item.type === 'trace' ? 'trace' : 'video',
        title: item.type === 'screenshot'
          ? passed ? '成功页面截图' : '失败页面截图'
          : item.type === 'trace' ? 'Playwright Trace' : 'Playwright Video',
        status: 'passed',
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
  authStatePath?: string,
  apiAuthorization = false,
) {
  const storageState = authStatePath ? `, storageState: ${JSON.stringify(authStatePath)}` : ''
  const runtimeAuthorization = apiAuthorization
    ? [
        "const runtimeAuthorization = process.env.SMARTHUB_RUNTIME_API_AUTHORIZATION",
        "if (!runtimeAuthorization) throw new Error('TEST_EXECUTION_API_AUTHORIZATION_REQUIRED')",
      ]
    : []
  const extraHttpHeaders = apiAuthorization
    ? ', extraHTTPHeaders: { Authorization: runtimeAuthorization }'
    : ''
  return [
    "const baseURL = process.env.SMARTHUB_BASE_URL",
    "if (!baseURL) throw new Error('TEST_EXECUTION_BASE_URL_REQUIRED')",
    ...runtimeAuthorization,
    `export default { testDir: ${JSON.stringify(workspaceRoot)}, outputDir: ${JSON.stringify(outputRoot)}, reporter: [['json', { outputFile: ${JSON.stringify(reporterPath)} }]], metadata: { smarthubAuthState: { directory: ${JSON.stringify(authStateRoot)}, scope: 'run', ephemeral: true } }, use: { baseURL, headless: true, trace: 'on', screenshot: 'on'${storageState}${extraHttpHeaders} } }`,
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

export type PlaywrightTraceHttpObservation = {
  method: string
  path: string
  status: number
  request?: PlaywrightTraceHttpPayload
  response?: PlaywrightTraceHttpPayload
}

export type PlaywrightTraceHttpPayload = {
  contentType?: string
  bodyBytes: number
  truncated?: boolean
  body?: unknown
}

export type PlaywrightTraceTerminalPageObservation = {
  path: string
  queryFields?: string[]
  headings?: string[]
  controls?: string[]
  observedAt: string
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
  // The launch boundary already scopes Playwright to the integrity-checked
  // entry file and exact Case Symbol. JSON Reporter may project that one
  // declaration more than once (for example across nested suites/projects),
  // so reporter cardinality is not an independent executable-entry count.
  if (!specs.length) {
    const globalErrors = reporterGlobalErrors(record)
    if (globalErrors.length) return { events: globalErrors, attachments: [] }
    throw new Error('TEST_EXECUTION_PLAYWRIGHT_REPORT_ENTRY_COUNT_INVALID')
  }
  const tests = specs.flatMap(spec => Array.isArray(spec.tests) ? spec.tests : [])
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
    const outcomeAt = new Date(Date.parse(startedAt) + durationMs).toISOString()
    if (status === 'failed') {
      const failure = reporterFailure(result)
      events.push({
        ...eventRecord('failure', failure.title, 'failed', outcomeAt, 0),
        metadata: {
          source: 'playwright_json_reporter',
          retry: Number.isSafeInteger(retry) ? retry : 0,
          failureKind: failure.kind,
          ...(failure.message ? { message: failure.message } : {}),
          ...(failure.location ? { location: failure.location } : {}),
          ...(failure.locator ? { locator: failure.locator } : {}),
        },
      })
    } else {
      events.push({
        ...eventRecord(
          'runner',
          status === 'passed' ? 'Playwright 测试通过' : 'Playwright 测试跳过',
          status,
          outcomeAt,
          0,
        ),
        metadata: { source: 'playwright_json_reporter', retry: Number.isSafeInteger(retry) ? retry : 0 },
      })
    }
  }
  return {
    events: events.map((event, index) => ({ ...event, sequence: index + 1 })),
    attachments: [...new Map(attachments.map(item => [item.path, item])).values()],
  }
}

function reporterGlobalErrors(report: Record<string, unknown>): RunnerExecutionEvent[] {
  if (!Array.isArray(report.errors)) return []
  const stats = report.stats && typeof report.stats === 'object'
    ? report.stats as Record<string, unknown>
    : undefined
  const startedAt = safeTimestamp(stats?.startTime)
  return report.errors.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') return []
    const error = candidate as Record<string, unknown>
    const failure = reporterFailure({
      error,
      errors: [error],
      errorLocation: error.location,
    })
    return [{
      ...eventRecord('failure', 'Playwright 测试加载失败', 'failed', startedAt, 0),
      sequence: index + 1,
      metadata: {
        source: 'playwright_json_reporter',
        retry: 0,
        failureKind: failure.kind,
        phase: 'load',
        ...(failure.message ? { message: failure.message } : {}),
        ...(failure.location ? { location: failure.location } : {}),
      },
    } satisfies RunnerExecutionEvent]
  })
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

function reporterFailure(result: Record<string, unknown>): {
  title: string
  kind: 'assertion' | 'timeout' | 'execution'
  message?: string
  location?: { file: string; line: number; column: number }
  locator?: { strategy: 'test_id'; value: string; operation?: string }
} {
  const messages = [result.error, ...(Array.isArray(result.errors) ? result.errors : [])]
    .flatMap(value => {
      if (!value || typeof value !== 'object') return []
      const message = (value as Record<string, unknown>).message
      return typeof message === 'string' ? [message] : []
    })
  const kind = messages.some(message => /(?:\bexpect\b|\bassert(?:ion)?\b|\bto(?:be|equal|match|contain|have|throw)\w*\s*\()/iu.test(message))
    ? 'assertion' as const
    : messages.some(message => /\btimeout|timed\s*out\b/iu.test(message))
      ? 'timeout' as const
      : 'execution' as const
  const location = safeReporterLocation(result.errorLocation)
  const locator = safeReporterLocator(messages)
  const message = safeReporterFailureMessage(messages)
  return {
    title: kind === 'assertion'
      ? 'Playwright 断言失败'
      : kind === 'timeout'
        ? 'Playwright 执行超时'
        : 'Playwright 执行失败',
    kind,
    ...(message ? { message } : {}),
    ...(location ? { location } : {}),
    ...(locator ? { locator } : {}),
  }
}

function safeReporterFailureMessage(messages: readonly string[]) {
  const message = messages.find(value => value.trim())
  if (!message) return undefined
  const redacted = message
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[A-Za-z]:\\[^\r\n]*/gu, redactReporterLocalPath)
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer <REDACTED>')
    .replace(
      /\b(authorization|cookie|set-cookie|password|token|api[_ -]?key|secret)\b\s*[:=]\s*[^\r\n,;]+/giu,
      '$1=<REDACTED>',
    )
  return safeMetadataText(redacted, 1_200) || undefined
}

function redactReporterLocalPath(value: string) {
  const normalized = value.replaceAll('\\', '/')
  const workspacePath = normalized.lastIndexOf('/tests/')
  return workspacePath >= 0 ? `<workspace>${normalized.slice(workspacePath)}` : '<local-path>'
}

function safeReporterLocator(messages: readonly string[]) {
  for (const message of messages) {
    const target = /waiting for getByTestId\((['"])([A-Za-z0-9._:-]{1,120})\1\)/u.exec(message)
    if (!target) continue
    const operation = /locator\.([A-Za-z][A-Za-z0-9]{0,50})\s*:/u.exec(message)?.[1]
    return {
      strategy: 'test_id' as const,
      value: target[2],
      ...(operation ? { operation } : {}),
    }
  }
  return undefined
}

function safeReporterLocation(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const file = typeof record.file === 'string'
    ? record.file.replaceAll('\\', '/').replace(/^\.\//u, '')
    : ''
  const line = Number(record.line)
  const column = Number(record.column)
  if (
    !file
    || file.startsWith('/')
    || /^[A-Za-z]:\//u.test(file)
    || file.split('/').includes('..')
    || !Number.isSafeInteger(line)
    || line < 1
    || !Number.isSafeInteger(column)
    || column < 1
  ) return undefined
  return { file: safeMetadataText(file, 500), line, column }
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

export function applyPlaywrightTraceHttpObservations(
  events: readonly RunnerExecutionEvent[],
  observations: readonly PlaywrightTraceHttpObservation[],
) {
  const pending = observations.slice()
  return events.map(event => {
    if (event.type !== 'http') return event
    const method = typeof event.metadata?.method === 'string' ? event.metadata.method : ''
    const path = typeof event.metadata?.path === 'string' ? event.metadata.path : ''
    const index = pending.findIndex(observation => traceHttpObservationMatches(method, path, observation))
    const observation = index >= 0 ? pending.splice(index, 1)[0] : undefined
    if (!observation) return event
    return {
      ...event,
      title: `${method.toUpperCase()} ${path} · ${observation.status}`,
      metadata: {
        ...event.metadata,
        httpStatus: observation.status,
        ...(observation.request ? { request: observation.request } : {}),
        ...(observation.response ? { response: observation.response } : {}),
      },
    }
  })
}

function traceHttpObservationMatches(
  method: string,
  path: string,
  observation: PlaywrightTraceHttpObservation,
) {
  if (method.toUpperCase() !== observation.method.toUpperCase()) return false
  if (path === observation.path) return true
  const expected = path.split('/').filter(Boolean)
  const actual = observation.path.split('/').filter(Boolean)
  return expected.length === actual.length && expected.every((segment, index) =>
    segment.startsWith(':') || /^\{[^{}]+\}$/u.test(segment) || segment === actual[index])
}

async function readPlaywrightTraceEvidence(
  runtimeRoot: string,
  attachments: readonly PlaywrightJsonAttachment[],
  baseUrl: string,
  secrets: readonly string[],
): Promise<{
  http: PlaywrightTraceHttpObservation[]
  terminalPage?: PlaywrightTraceTerminalPageObservation
}> {
  const http: PlaywrightTraceHttpObservation[] = []
  let terminalPage: PlaywrightTraceTerminalPageObservation | undefined
  for (const attachment of attachments) {
    if (reporterAttachmentType(attachment) !== 'trace') continue
    try {
      const { actual, metadata } = await validatedReporterAttachment(runtimeRoot, attachment)
      if (metadata.size > 64 * 1024 * 1024) continue
      const archive = await JSZip.loadAsync(await readFile(actual))
      const networkEntries = Object.values(archive.files)
        .filter(entry => !entry.dir && /(?:^|\/)\d*-?trace\.network$/u.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name, 'en'))
      for (const entry of networkEntries) {
        const source = await readBoundedZipEntry(entry, 16 * 1024 * 1024)
        for (const line of source.split(/\r?\n/u)) {
          if (!line || line.length > 1024 * 1024) continue
          const observation = await traceHttpObservation(line, archive, secrets)
          if (observation) http.push(observation)
        }
      }
      const traceEntries = Object.values(archive.files)
        .filter(entry => !entry.dir && /(?:^|\/)\d+-trace\.trace$/u.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name, 'en'))
      for (const entry of traceEntries) {
        const source = await readBoundedZipEntry(entry, 16 * 1024 * 1024)
        const observation = traceTerminalPageObservation(source, baseUrl, secrets)
        if (observation) terminalPage = observation
      }
    } catch {
      // Trace enrichment is best-effort. Attachment ingestion above remains
      // authoritative and still rejects invalid paths or files.
    }
  }
  return { http, ...(terminalPage ? { terminalPage } : {}) }
}

function traceTerminalPageObservation(
  source: string,
  baseUrl: string,
  secrets: readonly string[],
): PlaywrightTraceTerminalPageObservation | undefined {
  const snapshots: Array<{
    pageId: string
    frameUrl: string
    html: unknown
    observedAt: string
  }> = []
  for (const line of source.split(/\r?\n/u)) {
    if (!line || line.length > 1024 * 1024) continue
    let value: unknown
    try { value = JSON.parse(line) } catch { continue }
    if (!value || typeof value !== 'object') continue
    const record = value as Record<string, unknown>
    if (record.type !== 'frame-snapshot' || !record.snapshot || typeof record.snapshot !== 'object') continue
    const snapshot = record.snapshot as Record<string, unknown>
    if (snapshot.isMainFrame !== true || typeof snapshot.frameUrl !== 'string' || typeof snapshot.pageId !== 'string') continue
    const observedAt = traceObservedAt(snapshot.wallTime)
    snapshots.push({
      pageId: snapshot.pageId,
      frameUrl: snapshot.frameUrl,
      html: snapshot.html,
      observedAt,
    })
  }
  const terminal = snapshots.at(-1)
  if (!terminal) return undefined
  const location = safeTerminalPageLocation(terminal.frameUrl, baseUrl)
  if (!location) return undefined
  let phaseStart = snapshots.length - 1
  while (
    phaseStart > 0
    && snapshots[phaseStart - 1].pageId === terminal.pageId
    && snapshots[phaseStart - 1].frameUrl === terminal.frameUrl
  ) phaseStart -= 1
  const headings: string[] = []
  const controls: string[] = []
  for (const snapshot of snapshots.slice(phaseStart)) {
    collectTraceLandmarks(snapshot.html, headings, controls, secrets)
  }
  return {
    path: location.path,
    ...(location.queryFields.length ? { queryFields: location.queryFields } : {}),
    ...(headings.length ? { headings } : {}),
    ...(controls.length ? { controls } : {}),
    observedAt: terminal.observedAt,
  }
}

function safeTerminalPageLocation(rawUrl: string, baseUrl: string) {
  try {
    const actual = new URL(rawUrl)
    const approved = new URL(baseUrl)
    if (actual.origin !== approved.origin) return undefined
    const path = safeMetadataText(actual.pathname || '/', 500)
    if (!path) return undefined
    return {
      path,
      queryFields: [...new Set([...actual.searchParams.keys()])].sort().slice(0, 40),
    }
  } catch {
    return undefined
  }
}

function collectTraceLandmarks(
  html: unknown,
  headings: string[],
  controls: string[],
  secrets: readonly string[],
) {
  let visited = 0
  const visit = (node: unknown, depth: number) => {
    if (!Array.isArray(node) || depth > 80 || visited >= 50_000) return
    visited += 1
    if (typeof node[0] !== 'string') {
      for (const child of node) visit(child, depth + 1)
      return
    }
    const tag = node[0].toUpperCase()
    const attributes = node[1] && typeof node[1] === 'object' && !Array.isArray(node[1])
      ? node[1] as Record<string, unknown>
      : {}
    const role = String(attributes.role ?? '').toLowerCase()
    const rawLabel = traceNodeText(node, 0, { visited: 0 })
      || (typeof attributes['aria-label'] === 'string' ? attributes['aria-label'] : '')
    const label = safeTraceLandmark(rawLabel, secrets)
    if (label && (/^H[1-6]$/u.test(tag) || role === 'heading')) appendUnique(headings, label, 20)
    if (label && (tag === 'BUTTON' || tag === 'A' || role === 'button' || role === 'link')) appendUnique(controls, label, 30)
    for (const child of node.slice(2)) visit(child, depth + 1)
  }
  visit(html, 0)
}

function traceNodeText(node: unknown, depth: number, state: { visited: number }): string {
  if (typeof node === 'string') return node
  if (!Array.isArray(node) || depth > 40 || state.visited >= 10_000) return ''
  state.visited += 1
  const children = typeof node[0] === 'string' ? node.slice(2) : node
  return children.map(child => traceNodeText(child, depth + 1, state)).join(' ')
}

function safeTraceLandmark(value: string, secrets: readonly string[]) {
  const exactRedacted = redactRunnerOutput(Buffer.from(value, 'utf8'), secrets).toString('utf8')
  const genericRedacted = safeReporterFailureMessage([exactRedacted])
  return genericRedacted ? safeMetadataText(genericRedacted.replace(/\s+/gu, ' '), 200) : ''
}

function appendUnique(target: string[], value: string, maximum: number) {
  if (target.length >= maximum || target.includes(value)) return
  target.push(value)
}

function traceObservedAt(value: unknown) {
  const milliseconds = Number(value)
  if (!Number.isFinite(milliseconds) || milliseconds < 946684800000 || milliseconds > Date.now() + 24 * 60 * 60 * 1_000) {
    return new Date().toISOString()
  }
  return new Date(milliseconds).toISOString()
}

function terminalPageEvent(
  observation: PlaywrightTraceTerminalPageObservation,
  traceArtifactSha256?: string,
): RunnerExecutionEvent {
  return {
    sequence: 0,
    type: 'navigate',
    title: `终态页面 ${observation.path}`,
    status: 'passed',
    startedAt: observation.observedAt,
    finishedAt: observation.observedAt,
    durationMs: 0,
    ...(traceArtifactSha256 ? { artifactSha256s: [traceArtifactSha256] } : {}),
    metadata: {
      source: 'playwright_trace',
      category: 'terminal_page',
      path: observation.path,
      ...(observation.queryFields?.length ? { queryFields: observation.queryFields } : {}),
      ...(observation.headings?.length ? { headings: observation.headings } : {}),
      ...(observation.controls?.length ? { controls: observation.controls } : {}),
    },
  }
}

async function readBoundedZipEntry(entry: JSZipObject, maximumBytes: number) {
  const stream = entry.nodeStream('nodebuffer') as NodeJS.ReadableStream & { destroy?: () => void }
  return await new Promise<string>((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    stream.on('data', value => {
      if (settled) return
      const chunk = Buffer.from(value)
      size += chunk.length
      if (size > maximumBytes) {
        settled = true
        stream.destroy?.()
        reject(new Error('TEST_EXECUTION_PLAYWRIGHT_TRACE_NETWORK_TOO_LARGE'))
        return
      }
      chunks.push(chunk)
    })
    stream.once('error', error => {
      if (settled) return
      settled = true
      reject(error)
    })
    stream.once('end', () => {
      if (settled) return
      settled = true
      resolvePromise(Buffer.concat(chunks).toString('utf8'))
    })
  })
}

async function traceHttpObservation(
  line: string,
  archive: JSZip,
  secrets: readonly string[],
): Promise<PlaywrightTraceHttpObservation | undefined> {
  let value: unknown
  try { value = JSON.parse(line) } catch { return undefined }
  if (!value || typeof value !== 'object') return undefined
  const snapshot = (value as Record<string, unknown>).snapshot
  if (!snapshot || typeof snapshot !== 'object') return undefined
  const request = (snapshot as Record<string, unknown>).request
  const response = (snapshot as Record<string, unknown>).response
  if (!request || typeof request !== 'object' || !response || typeof response !== 'object') return undefined
  const method = String((request as Record<string, unknown>).method ?? '').toUpperCase()
  const rawUrl = (request as Record<string, unknown>).url
  const status = Number((response as Record<string, unknown>).status)
  if (!/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/u.test(method) || typeof rawUrl !== 'string') return undefined
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) return undefined
  try {
    const path = safeMetadataText(new URL(rawUrl).pathname, 500)
    if (!path) return undefined
    const [safeRequest, safeResponse] = await Promise.all([
      traceHttpPayload(request as Record<string, unknown>, archive, secrets, 'request'),
      traceHttpPayload(response as Record<string, unknown>, archive, secrets, 'response'),
    ])
    return {
      method,
      path,
      status,
      ...(safeRequest ? { request: safeRequest } : {}),
      ...(safeResponse ? { response: safeResponse } : {}),
    }
  } catch {
    return undefined
  }
}

const TRACE_HTTP_BODY_LIMIT = 16 * 1024
const TRACE_HTTP_SENSITIVE_KEY = /authorization|cookie|password|passwd|passcode|token|api.?key|secret|session|csrf|xsrf|private.?key/iu

async function traceHttpPayload(
  message: Record<string, unknown>,
  archive: JSZip,
  secrets: readonly string[],
  kind: 'request' | 'response',
): Promise<PlaywrightTraceHttpPayload | undefined> {
  const bodyRecord = kind === 'request'
    ? objectRecord(message.postData)
    : objectRecord(message.content)
  const contentType = safeHttpContentType(
    bodyRecord?.mimeType ?? traceHeaderValue(message.headers, 'content-type'),
  )
  const declaredBytes = safeHttpBodySize(
    kind === 'request' ? message.bodySize : bodyRecord?.size,
  )
  const inlineText = typeof bodyRecord?.text === 'string' && bodyRecord.text
    ? Buffer.from(bodyRecord.text, 'utf8')
    : undefined
  const resource = inlineText
    ? undefined
    : traceBodyResource(archive, bodyRecord?._sha1)
  const loaded = inlineText
    ? {
        buffer: inlineText.subarray(0, TRACE_HTTP_BODY_LIMIT),
        truncated: inlineText.length > TRACE_HTTP_BODY_LIMIT,
      }
    : resource
      ? await readBoundedZipBuffer(resource, TRACE_HTTP_BODY_LIMIT)
      : undefined
  const bodyBytes = declaredBytes ?? loaded?.buffer.length ?? 0
  if (!contentType && !loaded && declaredBytes === undefined) return undefined
  const body = loaded && !loaded.truncated
    ? safeTraceHttpBody(loaded.buffer, contentType, secrets)
    : undefined
  return {
    ...(contentType ? { contentType } : {}),
    bodyBytes,
    ...(loaded?.truncated ? { truncated: true } : {}),
    ...(body !== undefined ? { body } : {}),
  }
}

function objectRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function traceHeaderValue(value: unknown, expectedName: string) {
  if (!Array.isArray(value)) return undefined
  for (const candidate of value) {
    const header = objectRecord(candidate)
    if (String(header?.name ?? '').toLowerCase() !== expectedName) continue
    return header?.value
  }
  return undefined
}

function safeHttpContentType(value: unknown) {
  if (typeof value !== 'string') return undefined
  const type = value.split(';')[0].trim().toLowerCase()
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(type) ? type.slice(0, 100) : undefined
}

function safeHttpBodySize(value: unknown) {
  const size = Number(value)
  return Number.isSafeInteger(size) && size >= 0 && size <= 1024 * 1024 * 1024 ? size : undefined
}

function traceBodyResource(archive: JSZip, value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9@._-]{1,200}$/u.test(value)) return undefined
  return archive.file(`resources/${value}`) ?? undefined
}

async function readBoundedZipBuffer(entry: JSZipObject, maximumBytes: number) {
  const stream = entry.nodeStream('nodebuffer') as NodeJS.ReadableStream & { destroy?: () => void }
  return await new Promise<{ buffer: Buffer; truncated: boolean }>((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    stream.on('data', value => {
      if (settled) return
      const chunk = Buffer.from(value)
      const remaining = maximumBytes - size
      if (chunk.length > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
        settled = true
        stream.destroy?.()
        resolvePromise({ buffer: Buffer.concat(chunks), truncated: true })
        return
      }
      chunks.push(chunk)
      size += chunk.length
    })
    stream.once('error', error => {
      if (settled) return
      settled = true
      reject(error)
    })
    stream.once('end', () => {
      if (settled) return
      settled = true
      resolvePromise({ buffer: Buffer.concat(chunks), truncated: false })
    })
  })
}

function safeTraceHttpBody(buffer: Buffer, contentType: string | undefined, secrets: readonly string[]) {
  const source = buffer.toString('utf8')
  if (contentType?.includes('json') || /^[\s\r\n]*[\[{]/u.test(source)) {
    try {
      return safeTraceHttpBodyValue(JSON.parse(source), '', 0, secrets)
    } catch {
      // Fall through to a redacted text representation.
    }
  }
  if (contentType === 'application/x-www-form-urlencoded') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of new URLSearchParams(source)) {
      if (Object.keys(result).length >= 100) break
      result[safeMetadataText(key, 100)] = TRACE_HTTP_SENSITIVE_KEY.test(key)
        ? '<REDACTED>'
        : safeTraceHttpText(value, secrets)
    }
    return result
  }
  if (contentType && !contentType.startsWith('text/') && !/xml|graphql|javascript/u.test(contentType)) {
    return undefined
  }
  return safeTraceHttpText(source, secrets)
}

function safeTraceHttpBodyValue(value: unknown, key: string, depth: number, secrets: readonly string[]): unknown {
  if (TRACE_HTTP_SENSITIVE_KEY.test(key)) return '<REDACTED>'
  if (depth > 8) return '<TRUNCATED>'
  if (typeof value === 'string') return safeTraceHttpText(value, secrets)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 100).map(item => safeTraceHttpBodyValue(item, key, depth + 1, secrets))
  if (!value || typeof value !== 'object') return String(value ?? '')
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .slice(0, 100)
    .map(([childKey, child]) => [
      safeMetadataText(childKey, 100),
      safeTraceHttpBodyValue(child, childKey, depth + 1, secrets),
    ]))
}

function safeTraceHttpText(value: string, secrets: readonly string[]) {
  const exactRedacted = redactRunnerOutput(Buffer.from(value, 'utf8'), secrets).toString('utf8')
  return safeMetadataText(exactRedacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, 'Bearer <REDACTED>')
    .replace(
      /\b(authorization|cookie|set-cookie|password|passwd|passcode|token|api[_ -]?key|secret|session|csrf|xsrf|private[_ -]?key)\b\s*[:=]\s*[^\s,;&]+/giu,
      '$1=<REDACTED>',
    ), 4_000)
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
  secrets: readonly string[] = [],
): Promise<RunnerArtifactObject[]> {
  const actualRoot = await realpath(runtimeRoot)
  const results: RunnerArtifactObject[] = []
  for (const attachment of attachments) {
    const type = reporterAttachmentType(attachment)
    if (!type) continue
    const { actual, metadata } = await validatedReporterAttachment(runtimeRoot, attachment, actualRoot)
    if (type === 'trace') {
      if (metadata.size > 64 * 1024 * 1024) continue
      await redactTraceArchive(actual, secrets)
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

async function redactTraceArchive(path: string, secrets: readonly string[]) {
  const sensitiveValues = new Set(secrets.filter(Boolean))
  const archive = await JSZip.loadAsync(await readFile(path))
  const httpResources = new Map<string, string | undefined>()
  for (const entry of Object.values(archive.files)) {
    if (entry.dir || !/(?:^|\/)\d*-?trace\.network$/u.test(entry.name)) continue
    const lines = (await entry.async('string')).split(/\r?\n/u)
    const redactedLines = lines.map(line => {
      if (!line) return line
      let value: unknown
      try { value = JSON.parse(line) } catch { return redactTraceText(line, secrets) }
      const snapshot = objectRecord(objectRecord(value)?.snapshot)
      const request = objectRecord(snapshot?.request)
      const response = objectRecord(snapshot?.response)
      const postData = objectRecord(request?.postData)
      const content = objectRecord(response?.content)
      registerTraceHttpResource(httpResources, postData?._sha1, postData?.mimeType)
      registerTraceHttpResource(httpResources, content?._sha1, content?.mimeType)
      return JSON.stringify(redactTraceNetworkValue(value, '', secrets))
    })
    archive.file(entry.name, redactedLines.join('\n'))
  }
  for (const [sha, contentType] of httpResources) {
    const entry = archive.file(`resources/${sha}`)
    if (!entry) continue
    const source = await entry.async('nodebuffer')
    collectTraceHttpSensitiveValues(source, contentType, sensitiveValues)
    archive.file(entry.name, redactTraceHttpResource(source, contentType, secrets))
  }
  const values = [...sensitiveValues]
    .map(secret => Buffer.from(secret, 'utf8').toString('latin1'))
    .sort((left, right) => right.length - left.length)
  for (const entry of Object.values(archive.files)) {
    if (entry.dir) continue
    const source = await entry.async('nodebuffer')
    let redacted = source.toString('latin1')
    for (const value of values) redacted = redacted.replaceAll(value, '<REDACTED>')
    if (redacted !== source.toString('latin1')) {
      archive.file(entry.name, Buffer.from(redacted, 'latin1'))
    }
  }
  await writeFile(path, await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
}

function collectTraceHttpSensitiveValues(source: Buffer, contentType: string | undefined, target: Set<string>) {
  const text = source.toString('utf8')
  if (contentType?.includes('json') || /^[\s\r\n]*[\[{]/u.test(text)) {
    try {
      collectSensitiveBodyValues(JSON.parse(text), '', target)
      return
    } catch {
      // Fall through for malformed text.
    }
  }
  if (contentType === 'application/x-www-form-urlencoded') {
    for (const [key, value] of new URLSearchParams(text)) {
      if (TRACE_HTTP_SENSITIVE_KEY.test(key) && value) target.add(value)
    }
  }
}

function collectSensitiveBodyValues(value: unknown, key: string, target: Set<string>) {
  if (TRACE_HTTP_SENSITIVE_KEY.test(key)) {
    if (typeof value === 'string' && value) target.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSensitiveBodyValues(item, key, target)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    collectSensitiveBodyValues(child, childKey, target)
  }
}

function registerTraceHttpResource(target: Map<string, string | undefined>, sha: unknown, mimeType: unknown) {
  if (typeof sha !== 'string' || !/^[A-Za-z0-9@._-]{1,200}$/u.test(sha)) return
  target.set(sha, safeHttpContentType(mimeType))
}

function redactTraceNetworkValue(value: unknown, key: string, secrets: readonly string[]): unknown {
  if (typeof value === 'string') {
    if (TRACE_HTTP_SENSITIVE_KEY.test(key)) return '<REDACTED>'
    if (key === 'url') return redactTraceUrl(value)
    return redactTraceText(value, secrets)
  }
  if (Array.isArray(value)) {
    if (key === 'queryString') return value.map(item => redactNamedTraceValue(item, true, secrets))
    if (key === 'cookies' || key === 'params') return value.map(item => redactNamedTraceValue(item, false, secrets))
    if (key === 'headers') return value.map(item => redactNamedTraceValue(item, false, secrets))
    return value.map(item => redactTraceNetworkValue(item, key, secrets))
  }
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([childKey, child]) => [childKey, redactTraceNetworkValue(child, childKey, secrets)]))
}

function redactNamedTraceValue(value: unknown, redactEveryValue: boolean, secrets: readonly string[]) {
  const record = objectRecord(value)
  if (!record) return redactTraceNetworkValue(value, '', secrets)
  const sensitive = redactEveryValue || TRACE_HTTP_SENSITIVE_KEY.test(String(record.name ?? ''))
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [
    key,
    key === 'value' && sensitive ? '<REDACTED>' : redactTraceNetworkValue(child, key, secrets),
  ]))
}

function redactTraceUrl(value: string) {
  try {
    const url = new URL(value)
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '<REDACTED>')
    return url.toString()
  } catch {
    return value.split('?')[0]
  }
}

function redactTraceHttpResource(source: Buffer, contentType: string | undefined, secrets: readonly string[]) {
  const text = source.toString('utf8')
  if (contentType?.includes('json') || /^[\s\r\n]*[\[{]/u.test(text)) {
    try {
      return Buffer.from(JSON.stringify(redactTraceNetworkValue(JSON.parse(text), '', secrets)), 'utf8')
    } catch {
      // Preserve non-JSON bodies and apply text redaction below.
    }
  }
  if (contentType === 'application/x-www-form-urlencoded') {
    const params = new URLSearchParams(text)
    for (const key of [...params.keys()]) {
      const values = params.getAll(key)
      params.delete(key)
      for (const value of values) params.append(
        key,
        TRACE_HTTP_SENSITIVE_KEY.test(key) ? '<REDACTED>' : redactTraceText(value, secrets),
      )
    }
    return Buffer.from(params.toString(), 'utf8')
  }
  if (!contentType || contentType.startsWith('text/') || /xml|graphql|javascript/u.test(contentType)) {
    return Buffer.from(redactTraceText(text, secrets), 'utf8')
  }
  return source
}

function redactTraceText(value: string, secrets: readonly string[]) {
  const exactRedacted = redactRunnerOutput(Buffer.from(value, 'utf8'), secrets).toString('utf8')
  return exactRedacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, 'Bearer <REDACTED>')
    .replace(
      /\b(authorization|cookie|set-cookie|password|passwd|passcode|token|api[_ -]?key|secret|session|csrf|xsrf|private[_ -]?key)\b\s*[:=]\s*[^\s,;&]+/giu,
      '$1=<REDACTED>',
    )
}

async function readRuntimeApiAuthorization(
  statePath: string,
  descriptor: RuntimeApiAuthorization,
  baseUrl: string,
) {
  if (
    descriptor.kind !== 'bearer_local_storage'
    || descriptor.origin !== new URL(baseUrl).origin
    || !/^[A-Za-z0-9._-]{1,200}$/u.test(descriptor.localStorageKey)
  ) throw new Error('TEST_EXECUTION_API_AUTHORIZATION_INVALID')
  const state = JSON.parse(await readFile(statePath, 'utf8')) as {
    origins?: Array<{
      origin?: unknown
      localStorage?: Array<{ name?: unknown; value?: unknown }>
    }>
  }
  const origin = state.origins?.find(value => String(value.origin ?? '') === descriptor.origin)
  const entry = origin?.localStorage?.find(value => value.name === descriptor.localStorageKey)
  const token = typeof entry?.value === 'string' ? entry.value.trim() : ''
  if (!token || token.length > 64 * 1024 || /[\r\n]/u.test(token)) {
    throw new Error('TEST_EXECUTION_API_AUTHORIZATION_INVALID')
  }
  return /^Bearer\s+/iu.test(token) ? token : `Bearer ${token}`
}

async function writeGovernedUiApiFixture(runtimeRoot: string) {
  const packageRoot = join(runtimeRoot, 'node_modules', ...GOVERNED_UI_API_TEST_MODULE.split('/'))
  await mkdir(packageRoot, { recursive: true })
  await Promise.all([
    writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: GOVERNED_UI_API_TEST_MODULE,
      private: true,
      type: 'module',
      exports: './index.mjs',
    }), { encoding: 'utf8' }),
    writeFile(join(packageRoot, 'index.mjs'), governedUiApiFixtureSource(), { encoding: 'utf8' }),
  ])
}

function governedUiApiFixtureSource() {
  return `import { test as base, expect, request as playwrightRequest } from '@playwright/test'

const baseURL = process.env.SMARTHUB_BASE_URL
const authorization = process.env.SMARTHUB_RUNTIME_API_AUTHORIZATION
if (!baseURL) throw new Error('TEST_EXECUTION_BASE_URL_REQUIRED')
if (!authorization) throw new Error('TEST_EXECUTION_API_AUTHORIZATION_REQUIRED')
const approvedOrigin = new URL(baseURL).origin
const requestMethods = new Set(['delete', 'fetch', 'get', 'head', 'patch', 'post', 'put'])

export const test = base.extend({
  request: async ({}, use) => {
    const context = await playwrightRequest.newContext({
      baseURL,
      extraHTTPHeaders: { Authorization: authorization },
    })
    const governed = new Proxy(context, {
      get(target, property, receiver) {
        if (requestMethods.has(property)) {
          return async (url, options = {}) => {
            if (typeof url !== 'string' || new URL(url, baseURL).origin !== approvedOrigin) {
              throw new Error('TEST_EXECUTION_API_REQUEST_CROSS_ORIGIN_REJECTED')
            }
            return target[property](url, { ...options, maxRedirects: 0 })
          }
        }
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    try { await use(governed) } finally { await context.dispose() }
  },
})

export { expect }
`
}

async function validatedReporterAttachment(
  runtimeRoot: string,
  attachment: PlaywrightJsonAttachment,
  resolvedRoot?: string,
) {
  const actualRoot = resolvedRoot ?? await realpath(runtimeRoot)
  const target = resolve(runtimeRoot, attachment.path)
  const [actual, metadata] = await Promise.all([realpath(target), lstat(target)])
  if (!inside(actualRoot, actual) || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('TEST_EXECUTION_PLAYWRIGHT_ATTACHMENT_INVALID')
  }
  return { actual, metadata }
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
