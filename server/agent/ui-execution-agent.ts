import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { ExecutionRun, ExecutionTask } from '../domain/test-execution-types.js'

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
  error?: string
}

export interface PlaywrightCliToolAdapter {
  explore(input: {
    baseUrl: string
    run: ExecutionRun
    task: ExecutionTask
    phase: UiExecutionAgentPhase
  }, signal: AbortSignal): Promise<UiExecutionBrowserContext>
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
    return structuredClone(context)
  }
}

/**
 * Adapter for Playwright's official coding-agent CLI.  It uses a unique
 * ephemeral browser session per Run/Task and only exposes browser operations:
 * navigate, snapshot, locator discovery, interactions and screenshots. The
 * Service, not this adapter, controls execution state and repair permission.
 */
export class PlaywrightCliAdapter implements PlaywrightCliToolAdapter {
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
  }, signal: AbortSignal): Promise<UiExecutionBrowserContext> {
    const session = `smarthub-${hash(`${input.run.id}:${input.task.id}`).slice(0, 24)}`
    try {
      await this.command(session, 'open', [input.baseUrl], signal)
      const snapshot = await this.command(session, 'snapshot', [], signal)
      const title = input.task.input.caseContent.title.trim()
      const hint = title
        ? await this.command(session, 'find', [title], signal).catch(() => '')
        : ''
      return {
        tool: 'playwright-cli',
        phase: input.phase,
        baseUrl: input.baseUrl,
        available: true,
        snapshot,
        locatorHints: hint ? [hint] : [],
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

  private async command(session: string, action: string, args: readonly string[], signal: AbortSignal) {
    const executable = this.options.command
      ?? process.env.SMARTHUB_PLAYWRIGHT_CLI_COMMAND
      ?? (process.platform === 'win32' ? 'npx.cmd' : 'npx')
    const command = this.options.command || process.env.SMARTHUB_PLAYWRIGHT_CLI_COMMAND
      ? [ `-s=${session}`, action, ...args, '--json' ]
      : ['--yes', this.options.packageSpec ?? '@playwright/cli@latest', `-s=${session}`, action, ...args, '--json']
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
        else if (code !== 0) reject(new Error(`PLAYWRIGHT_CLI_${action.toUpperCase()}_FAILED: ${output.slice(0, 2_000)}`))
        else resolve(output)
      })
    })
  }
}

function hash(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
