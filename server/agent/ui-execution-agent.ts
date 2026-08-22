import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  normalizeUiNetworkObservation,
  type RawUiNetworkObservation,
} from '../application/test-execution-exploration.js'
import type {
  ExecutionRun,
  ExecutionTask,
  HttpExplorationObservation,
} from '../domain/test-execution-types.js'

export type UiExecutionAgentPhase = 'implementation' | 'failure_analysis' | 'script_repair'

/**
 * Small, ephemeral browser context returned directly to the governed agent.
 * It is not a second test plan, ScriptRevision or persisted workflow artifact.
 */
export interface UiExecutionBrowserContext {
  tool: 'playwright-cli'
  phase: UiExecutionAgentPhase
  baseUrl: string
  available: boolean
  snapshot?: string
  locatorHints: string[]
  networkObservations: HttpExplorationObservation[]
  error?: string
}

export interface PlaywrightCliExplorationContext extends Omit<UiExecutionBrowserContext, 'networkObservations'> {
  /** Raw values are ephemeral and must be normalized before leaving UIExecutionAgent. */
  networkCandidates?: RawUiNetworkObservation[]
}

export interface PlaywrightCliToolAdapter {
  explore(input: {
    baseUrl: string
    run: ExecutionRun
    task: ExecutionTask
    phase: UiExecutionAgentPhase
  }, signal: AbortSignal): Promise<PlaywrightCliExplorationContext>
}

/**
 * SmartHub's UI capability agent.  It owns only the controlled invocation of
 * Playwright CLI; it never creates a Test Plan or decides a TestCase result.
 */
export class UIExecutionAgent {
  constructor(private readonly cli: PlaywrightCliToolAdapter) {}

  async explore(input: {
    baseUrl: string
    run: ExecutionRun
    task: ExecutionTask
    phase: UiExecutionAgentPhase
  }, signal: AbortSignal) {
    if (input.task.input.method !== 'ui') return undefined
    const context = await this.cli.explore(input, signal)
    if (
      context.tool !== 'playwright-cli'
      || context.phase !== input.phase
      || context.baseUrl !== input.baseUrl
    ) throw new Error('UI_EXECUTION_PLAYWRIGHT_CLI_CONTEXT_SCOPE_INVALID')
    const { networkCandidates = [], ...browser } = context
    const networkObservations = networkCandidates
      .map(candidate => normalizeUiNetworkObservation(candidate))
      .filter((candidate): candidate is HttpExplorationObservation => Boolean(candidate))
    return structuredClone({ ...browser, networkObservations })
  }
}

/**
 * Adapter for Playwright's official coding-agent CLI.  It uses a unique
 * ephemeral browser session per Run/Task and only exposes browser operations:
 * navigate, snapshot, locator discovery, interactions and screenshots. The
 * Service, not this adapter, controls execution state and repair permission.
 */
export class PlaywrightCliAdapter implements PlaywrightCliToolAdapter {
  private readonly seenRequestIndexes = new Map<string, Set<number>>()

  constructor(private readonly options: {
    command?: string
    packageSpec?: string
    timeoutMs?: number
  } = {}) {}

  async explore(input: {
    baseUrl: string
    run: ExecutionRun
    task: ExecutionTask
    phase: UiExecutionAgentPhase
  }, signal: AbortSignal): Promise<PlaywrightCliExplorationContext> {
    const session = `smarthub-${hash(`${input.run.id}:${input.task.id}`).slice(0, 24)}`
    try {
      await this.command(session, 'open', [input.baseUrl], signal)
      const snapshot = await this.command(session, 'snapshot', [], signal)
      const title = input.task.input.caseContent.title.trim()
      const hint = title
        ? await this.command(session, 'find', [title], signal).catch(() => '')
        : ''
      const page = safePage(input.baseUrl)
      const networkCandidates = await this.observeNetworkForAction(session, {
        page,
        action: `navigate ${page}`,
        actionType: 'navigate',
        sequence: 0,
      }, signal).catch(() => [])
      return {
        tool: 'playwright-cli',
        phase: input.phase,
        baseUrl: input.baseUrl,
        available: true,
        snapshot,
        locatorHints: hint ? [hint] : [],
        networkCandidates,
      }
    } catch (error) {
      return {
        tool: 'playwright-cli',
        phase: input.phase,
        baseUrl: input.baseUrl,
        available: false,
        locatorHints: [],
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      await this.command(session, 'close', [], AbortSignal.timeout(5_000)).catch(() => undefined)
      this.seenRequestIndexes.delete(session)
    }
  }

  /** Available to the capability agent when a discovered ref must be exercised. */
  async click(session: string, target: string, signal: AbortSignal) {
    return this.command(session, 'click', [target], signal)
  }

  /** Available to the capability agent when a discovered ref must be exercised. */
  async fill(session: string, target: string, text: string, signal: AbortSignal) {
    return this.command(session, 'fill', [target, text], signal)
  }

  /** Uses the official CLI locator generator against a previously observed ref. */
  async generateLocator(session: string, target: string, signal: AbortSignal) {
    return this.command(session, 'generate-locator', [target], signal)
  }

  /** Captures a screenshot through the official CLI when failure diagnosis needs it. */
  async screenshot(session: string, target: string | undefined, signal: AbortSignal) {
    return this.command(session, 'screenshot', target ? [target] : [], signal)
  }

  /**
   * Reads network requests accumulated in the current CLI session and binds
   * the new observations to the caller-supplied UI action boundary.
   */
  async observeNetworkForAction(
    session: string,
    observedFrom: Pick<RawUiNetworkObservation, 'page' | 'action' | 'actionType' | 'sequence'>,
    signal: AbortSignal,
  ) {
    const list = await this.command(session, 'requests', [], signal)
    const seen = this.seenRequestIndexes.get(session) ?? new Set<number>()
    this.seenRequestIndexes.set(session, seen)
    const listed = parsePlaywrightCliRequestSummaries(list)
    const summaries = listed.filter(summary => !seen.has(summary.index)).slice(0, 30)
    listed.forEach(summary => seen.add(summary.index))
    const candidates: RawUiNetworkObservation[] = []
    for (const summary of summaries) {
      if (!possiblyBusinessRequest(summary)) continue
      const detail = await this.command(session, 'request', [String(summary.index)], signal).catch(() => '')
      const parsed = parsePlaywrightCliRequestDetail(detail, summary)
      if (!possiblyBusinessRequest(parsed)) continue
      const [requestHeaders, requestBody, responseHeaders, responseBody] = await Promise.all([
        this.command(session, 'request-headers', [String(summary.index)], signal, { json: false }).catch(() => ''),
        this.command(session, 'request-body', [String(summary.index)], signal, { json: false }).catch(() => undefined),
        this.command(session, 'response-headers', [String(summary.index)], signal, { json: false }).catch(() => ''),
        this.command(session, 'response-body', [String(summary.index)], signal, { json: false }).catch(() => undefined),
      ])
      candidates.push({
        ...observedFrom,
        method: parsed.method,
        url: parsed.url,
        resourceType: parsed.resourceType,
        requestHeaders,
        ...(requestBody === undefined ? {} : { requestBody: boundedOutput(requestBody) }),
        responseStatus: parsed.status,
        responseHeaders,
        ...(responseBody === undefined ? {} : { responseBody: boundedOutput(responseBody) }),
      })
    }
    return candidates
  }

  private async command(
    session: string,
    action: string,
    args: readonly string[],
    signal: AbortSignal,
    output: { json?: boolean } = {},
  ) {
    const executable = this.options.command
      ?? process.env.SMARTHUB_PLAYWRIGHT_CLI_COMMAND
      ?? (process.platform === 'win32' ? 'npx.cmd' : 'npx')
    const actionArgs = [`-s=${session}`, action, ...args, ...(output.json === false ? [] : ['--json'])]
    const command = this.options.command || process.env.SMARTHUB_PLAYWRIGHT_CLI_COMMAND
      ? actionArgs
      : ['--yes', this.options.packageSpec ?? '@playwright/cli@latest', ...actionArgs]
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 60_000)
    const combined = AbortSignal.any([signal, timeout])
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(executable, command, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout?.on('data', value => stdout.push(Buffer.from(value)))
      child.stderr?.on('data', value => stderr.push(Buffer.from(value)))
      const terminate = () => child.kill('SIGTERM')
      combined.addEventListener('abort', terminate, { once: true })
      child.once('error', error => {
        combined.removeEventListener('abort', terminate)
        reject(error)
      })
      child.once('close', code => {
        combined.removeEventListener('abort', terminate)
        const output = Buffer.concat([Buffer.concat(stdout), Buffer.concat(stderr)]).toString('utf8').trim()
        if (combined.aborted) reject(new Error(signal.aborted ? 'UI_EXECUTION_AGENT_CANCELLED' : 'PLAYWRIGHT_CLI_TIMEOUT'))
        // Network commands may print real request values on stderr. Never carry
        // command output across the controlled adapter boundary on failure.
        else if (code !== 0) reject(new Error(`PLAYWRIGHT_CLI_${action.toUpperCase()}_FAILED_EXIT_${code ?? 'UNKNOWN'}`))
        else resolve(output)
      })
    })
  }
}

export interface PlaywrightCliRequestSummary {
  index: number
  method: string
  url: string
  status?: number
  resourceType?: string
}

export function parsePlaywrightCliRequestSummaries(output: string): PlaywrightCliRequestSummary[] {
  const fromJson = requestSummariesFromJson(output)
  if (fromJson.length) return uniqueSummaries(fromJson)
  const summaries: PlaywrightCliRequestSummary[] = []
  for (const line of output.split(/\r?\n/u)) {
    const index = /(?:^|\s)(?:\[(\d+)\]|#?(\d+)[.):])(?:\s|$)/u.exec(line)
    const request = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(https?:\/\/[^\s)\]]+)/iu.exec(line)
    if (!index || !request) continue
    const status = /(?:=>|→|status\s*[:=]?|\[)\s*(\d{3})\b/iu.exec(line)
    const resourceType = /\b(fetch|xhr|document|script|stylesheet|image|font|media)\b/iu.exec(line)
    summaries.push({
      index: Number(index[1] ?? index[2]),
      method: request[1].toUpperCase(),
      url: request[2],
      ...(status ? { status: Number(status[1]) } : {}),
      ...(resourceType ? { resourceType: resourceType[1].toLocaleLowerCase() } : {}),
    })
  }
  return uniqueSummaries(summaries)
}

export function parsePlaywrightCliRequestDetail(
  output: string,
  fallback: PlaywrightCliRequestSummary,
): PlaywrightCliRequestSummary {
  const [json] = requestSummariesFromJson(output)
  if (json) return { ...fallback, ...json, index: fallback.index }
  const method = labeledValue(output, 'method')?.toUpperCase()
    ?? /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/iu.exec(output)?.[1]?.toUpperCase()
    ?? fallback.method
  const url = labeledValue(output, 'url')
    ?? /https?:\/\/[^\s)\]]+/iu.exec(output)?.[0]
    ?? fallback.url
  const statusText = labeledValue(output, 'status') ?? /\bstatus\D{0,10}(\d{3})\b/iu.exec(output)?.[1]
  const resourceType = labeledValue(output, 'resource type')?.toLocaleLowerCase()
    ?? labeledValue(output, 'resourceType')?.toLocaleLowerCase()
    ?? fallback.resourceType
  const status = statusText ? Number(/\d{3}/u.exec(statusText)?.[0]) : fallback.status
  return { index: fallback.index, method, url, ...(status ? { status } : {}), ...(resourceType ? { resourceType } : {}) }
}

function requestSummariesFromJson(output: string) {
  let parsed: unknown
  try { parsed = JSON.parse(output) as unknown } catch { return [] }
  const summaries: PlaywrightCliRequestSummary[] = []
  const pending: unknown[] = [parsed]
  while (pending.length) {
    const current = pending.pop()
    if (Array.isArray(current)) {
      pending.push(...current)
      continue
    }
    if (!current || typeof current !== 'object') continue
    const record = current as Record<string, unknown>
    const method = String(record.method ?? record.requestMethod ?? '').toUpperCase()
    const url = String(record.url ?? record.requestUrl ?? '')
    const index = Number(record.index ?? record.requestIndex ?? record.id)
    if (Number.isSafeInteger(index) && index >= 0 && /^[A-Z]{3,12}$/u.test(method) && /^https?:\/\//iu.test(url)) {
      const status = Number(record.status ?? record.statusCode)
      const resourceType = String(record.resourceType ?? record.type ?? '').toLocaleLowerCase()
      summaries.push({ index, method, url, ...(Number.isInteger(status) ? { status } : {}), ...(resourceType ? { resourceType } : {}) })
    }
    pending.push(...Object.values(record))
  }
  return summaries
}

function uniqueSummaries(values: PlaywrightCliRequestSummary[]) {
  return [...new Map(values.map(value => [value.index, value])).values()]
    .sort((left, right) => left.index - right.index)
}

function possiblyBusinessRequest(input: Pick<PlaywrightCliRequestSummary, 'method' | 'url' | 'resourceType'>) {
  if (['HEAD', 'OPTIONS'].includes(input.method)) return false
  let url: URL
  try { url = new URL(input.url) } catch { return false }
  if (/\.(?:css|gif|ico|jpe?g|js|map|mjs|png|svg|ttf|webp|woff2?)(?:$|\/)/iu.test(url.pathname)) return false
  if (/(?:^|\/)(?:analytics?|telemetry|tracking|collect|beacon|ads?|pixel)(?:\/|$)/iu.test(url.pathname)) return false
  return !input.resourceType || ['fetch', 'xhr'].includes(input.resourceType)
}

function labeledValue(output: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?${escaped}\\s*[:=]\\s*([^\\r\\n]+)`, 'iu').exec(output)?.[1]?.trim()
}

function boundedOutput(value: string) {
  return value.slice(0, 64 * 1024)
}

function safePage(value: string) {
  try { return new URL(value).pathname || '/' } catch { return '/' }
}

function hash(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
