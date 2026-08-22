import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ExecutionRunnerSnapshot } from '../domain/test-execution-types.js'
import type { PlaywrightRunner } from './playwright-runner.js'
import type { SandboxExecutionResult } from './execution-sandbox.js'
import type { ExecutionArtifactStore } from '../infrastructure/execution-artifact-store.js'

/** Local runner for the ProjectVersion-owned automation workspace. */
export class LocalWorkspaceRunner implements PlaywrightRunner {
  private readonly value: ExecutionRunnerSnapshot = {
    runnerVersion: 'local-workspace/v1',
    playwrightVersion: 'workspace-managed',
    imageReference: 'local-workspace',
    imageDigest: `sha256:${'0'.repeat(64)}`,
  }

  constructor(private readonly artifacts: ExecutionArtifactStore, private readonly timeoutMs = 120_000) {}

  snapshot() { return structuredClone(this.value) }
  async readiness() {
    try {
      await access(process.cwd())
      return { ready: true, snapshot: this.snapshot() }
    } catch (error) {
      return { ready: false, reason: error instanceof Error ? error.message : String(error), snapshot: this.snapshot() }
    }
  }

  async execute(input: Parameters<PlaywrightRunner['execute']>[0], signal: AbortSignal): Promise<SandboxExecutionResult> {
    if (!input.workspace) throw new Error('TEST_EXECUTION_LOCAL_WORKSPACE_REQUIRED')
    if (JSON.stringify(input.runner) !== JSON.stringify(this.value)) throw new Error('TEST_EXECUTION_RUNNER_SNAPSHOT_DRIFT')
    const entry = resolve(input.workspace.root, ...input.workspace.entryFile.split('/'))
    if (!entry.startsWith(resolve(input.workspace.root))) throw new Error('TEST_EXECUTION_WORKSPACE_ENTRY_INVALID')
    await access(entry)
    const entrySource = await readFile(entry, 'utf8')
    const started = Date.now()
    const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx'
    const args = ['playwright', 'test', input.workspace.entryFile]
    // A legacy per-case entry can be executed directly. Shared entry files use
    // the stable symbol as a Playwright grep without inventing a selector.
    if (entrySource.includes(input.workspace.entrySymbol)) args.push('--grep', input.workspace.entrySymbol)
    const child = spawn(executable, args, {
      cwd: input.workspace.root,
      shell: false,
      windowsHide: true,
      env: { ...process.env, SMARTHUB_BASE_URL: input.environment.baseUrl },
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
    const output = Buffer.concat([Buffer.concat(stdout), Buffer.concat(stderr)])
    const artifact = output.length ? await this.artifacts.put({ body: bytes(output), mimeType: 'text/plain; charset=utf-8', maximumBytes: 2 * 1024 * 1024 }) : undefined
    if (signal.aborted) return { status: 'cancelled', durationMs: Date.now() - started, summary: 'Local Runner 已取消', error: 'TEST_EXECUTION_RUNNER_CANCELLED', artifacts: artifact ? [{ ...artifact, type: 'log' }] : [] }
    const passed = exitCode === 0
    return {
      status: passed ? 'passed' : 'failed',
      exitCode: exitCode ?? undefined,
      durationMs: Date.now() - started,
      summary: passed ? 'Local Playwright 通过' : 'Local Playwright 失败',
      ...(passed ? {} : { error: `PLAYWRIGHT_EXIT_${exitCode ?? 'UNKNOWN'}` }),
      artifacts: artifact ? [{ ...artifact, type: 'log' }] : [],
    }
  }
}

async function* bytes(value: Buffer) { yield value }
