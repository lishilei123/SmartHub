import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestExecutionAgentSnapshot } from '../domain/agent-types.js'
import {
  resolveAuthSessionPolicy,
  type AuthSessionPolicy,
  type RuntimeAuthStateAccess,
} from '../application/test-execution-auth-session.js'
import type {
  ExecutionRun,
  ExecutionTask,
  HttpExplorationObservation,
} from '../domain/test-execution-types.js'
import type { ToolDescriptor, ToolHandler } from '../domain/tool-types.js'
import type {
  PlaywrightBrowserCliAdapter,
  PlaywrightCliRequestSummary,
} from '../agent/ui-execution-agent.js'
import { normalizeUiNetworkObservation } from '../application/test-execution-exploration.js'
import { defaultBuiltInToolConfigResolver } from './built-in-tool-config.js'

export const BROWSER_TOOL_IDS = [
  'browser.snapshot',
  'browser.click',
  'browser.fill',
  'browser.get_locator',
  'browser.requests',
  'browser.request_detail',
  'browser.screenshot',
] as const

export type BrowserToolId = typeof BROWSER_TOOL_IDS[number]
export type BrowserToolStage = 'script_generation' | 'script_repair'

export interface BrowserToolSessionScope {
  runId: string
  taskId: string
  projectVersionId: string
  environmentSignature: string
  baseUrl: string
  stage: BrowserToolStage
  authPolicy: AuthSessionPolicy
  authStateLoaded: boolean
}

export interface BrowserToolSession {
  readonly scope: BrowserToolSessionScope
  runtimeToolBindings(): Array<{ descriptor: ToolDescriptor; handler: ToolHandler }>
  observations(): HttpExplorationObservation[]
  close(): Promise<void>
}

export interface BrowserToolGateway {
  openSession(input: {
    run: ExecutionRun
    task: ExecutionTask
    stage: BrowserToolStage
    authPolicy: AuthSessionPolicy
    authState?: RuntimeAuthStateAccess
  }, signal: AbortSignal): Promise<BrowserToolSession>
}

export class PlaywrightBrowserToolGateway implements BrowserToolGateway {
  constructor(private readonly cli: PlaywrightBrowserCliAdapter) {}

  async openSession(input: {
    run: ExecutionRun
    task: ExecutionTask
    stage: BrowserToolStage
    authPolicy: AuthSessionPolicy
    authState?: RuntimeAuthStateAccess
  }, signal: AbortSignal): Promise<BrowserToolSession> {
    if (input.task.input.method !== 'ui') throw new Error('BROWSER_TOOL_UI_CASE_REQUIRED')
    if (input.task.runId !== input.run.id) throw new Error('BROWSER_TOOL_TASK_SCOPE_INVALID')
    const expectedAuthPolicy = resolveAuthSessionPolicy(input.task.input)
    if (
      input.authPolicy.mode !== expectedAuthPolicy.mode
      || input.authPolicy.role !== expectedAuthPolicy.role
      || input.authPolicy.stateKey !== expectedAuthPolicy.stateKey
    ) throw new Error('BROWSER_AUTH_SESSION_POLICY_INVALID')
    if (
      (['fresh_anonymous', 'custom'].includes(input.authPolicy.mode) && input.authState)
      || (input.authPolicy.mode === 'isolated_role' && input.authState?.savePath)
    ) throw new Error('BROWSER_AUTH_STATE_NOT_ALLOWED')
    const baseUrl = controlledBaseUrl(input.run.environment.baseUrl)
    const sessionId = `smarthub-${hash(`${input.run.id}:${input.task.id}:${input.stage}:${randomUUID()}`).slice(0, 32)}`
    const screenshotRoot = await mkdtemp(join(tmpdir(), 'smarthub-browser-session-'))
    try {
      if (input.authState?.loadPath) {
        await this.cli.open(sessionId, undefined, signal)
        await this.cli.stateLoad(sessionId, input.authState.loadPath, signal)
        await this.cli.open(sessionId, baseUrl, signal)
      } else {
        await this.cli.open(sessionId, baseUrl, signal)
      }
    } catch (error) {
      await this.cli.close(sessionId, AbortSignal.timeout(5_000)).catch(() => undefined)
      await input.authState?.discard?.().catch(() => undefined)
      await rm(screenshotRoot, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    return new ControlledBrowserToolSession(this.cli, sessionId, {
      runId: input.run.id,
      taskId: input.task.id,
      projectVersionId: input.run.projectVersionId,
      environmentSignature: input.run.environment.signature,
      baseUrl,
      stage: input.stage,
      authPolicy: structuredClone(input.authPolicy),
      authStateLoaded: Boolean(input.authState?.loadPath),
    }, authorizedFillValues(input.task), screenshotRoot, input.authState)
  }
}

class ControlledBrowserToolSession implements BrowserToolSession {
  private readonly elementRefs = new Map<string, string>()
  private readonly requestRefs = new Map<string, PlaywrightCliRequestSummary>()
  private readonly observedNetwork: HttpExplorationObservation[] = []
  private closed = false
  private sequence = 0
  private screenshotSequence = 0
  private page = '/'
  private lastSnapshot = ''
  private authenticationSurfaceObserved = false
  private authenticationCredentialFillObserved = false
  private authenticationSubmitObserved = false
  private successfulAuthenticationObserved = false
  private stableAuthenticatedPageObserved = false
  private lastAction: {
    action: string
    actionType: HttpExplorationObservation['observedFrom']['actionType']
    sequence: number
  } = { action: '打开受控 Base URL', actionType: 'navigate', sequence: 0 }

  constructor(
    private readonly cli: PlaywrightBrowserCliAdapter,
    private readonly sessionId: string,
    readonly scope: BrowserToolSessionScope,
    private readonly allowedFillValues: ReadonlySet<string>,
    private readonly screenshotRoot: string,
    private readonly authState?: RuntimeAuthStateAccess,
  ) {
    this.page = new URL(scope.baseUrl).pathname || '/'
  }

  runtimeToolBindings() {
    return BROWSER_TOOL_IDS.map(toolId => ({
      descriptor: defaultBuiltInToolConfigResolver.toDescriptor(toolId),
      handler: this.handler(toolId),
    }))
  }

  observations() {
    return structuredClone(this.observedNetwork)
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.elementRefs.clear()
    this.requestRefs.clear()
    let closeError: unknown
    try {
      if (
        this.scope.authPolicy.mode === 'reuse_authenticated'
        && this.authState?.savePath
        && this.authenticationSurfaceObserved
        && this.authenticationCredentialFillObserved
        && this.authenticationSubmitObserved
        && authenticatedDestination(this.page, this.lastSnapshot)
        && (this.successfulAuthenticationObserved || this.stableAuthenticatedPageObserved)
      ) {
        await this.cli.stateSave(this.sessionId, this.authState.savePath, AbortSignal.timeout(10_000))
        await this.authState.commit?.()
      }
    } catch (error) {
      closeError = error
    } finally {
      try {
        await this.cli.close(this.sessionId, AbortSignal.timeout(5_000))
      } catch (error) {
        closeError ??= error
      } finally {
        await this.authState?.discard?.().catch(() => undefined)
        await rm(this.screenshotRoot, { recursive: true, force: true })
      }
    }
    if (closeError) throw closeError
  }

  private handler(toolId: BrowserToolId): ToolHandler {
    return async (request, signal) => {
      this.assertInvocation(request.context.snapshot, toolId)
      const args = request.arguments as Record<string, unknown>
      switch (toolId) {
        case 'browser.snapshot': {
          const snapshot = await this.refreshSnapshot(signal)
          return { data: { page: this.page, snapshot } }
        }
        case 'browser.click': {
          const target = this.observedTarget(args.target)
          this.assertTargetSameOrigin(target)
          await this.cli.click(this.sessionId, target, signal)
          this.rememberAction(`click ${target}`, 'click')
          if (this.authenticationSurfaceObserved && this.authenticationCredentialFillObserved) {
            this.authenticationSubmitObserved = true
          }
          const snapshot = await this.refreshSnapshot(signal)
          await this.collectNetwork(signal)
          return { data: { clicked: target, page: this.page, snapshot } }
        }
        case 'browser.fill': {
          const target = this.observedTarget(args.target)
          const text = String(args.text ?? '')
          if (!this.allowedFillValues.has(text)) throw new Error('BROWSER_FILL_VALUE_NOT_AUTHORIZED')
          const observed = this.elementRefs.get(target) ?? ''
          if (this.authenticationSurfaceObserved && authenticationCredentialField(observed)) {
            this.authenticationCredentialFillObserved = true
          }
          await this.cli.fill(this.sessionId, target, text, signal)
          this.rememberAction(`fill ${target}`, 'fill')
          const snapshot = await this.refreshSnapshot(signal)
          await this.collectNetwork(signal)
          return { data: { filled: target, page: this.page, snapshot } }
        }
        case 'browser.get_locator': {
          const target = this.observedTarget(args.target)
          const output = await this.cli.generateLocator(this.sessionId, target, signal)
          return { data: { target, locator: safeBrowserText(output, 8_000) } }
        }
        case 'browser.requests': {
          const requests = await this.listRequests(signal)
          return { data: { page: this.page, requests } }
        }
        case 'browser.request_detail': {
          const requestRef = String(args.requestRef ?? '')
          const summary = this.requestRefs.get(requestRef)
          if (!summary) throw new Error('BROWSER_REQUEST_REF_NOT_OBSERVED')
          const observation = await this.requestObservation(summary, signal)
          if (!observation) throw new Error('BROWSER_REQUEST_DETAIL_NOT_ALLOWED')
          this.rememberObservation(observation)
          return { data: { requestRef, observation } }
        }
        case 'browser.screenshot': {
          const target = args.target === undefined ? undefined : this.observedTarget(args.target)
          const filename = join(this.screenshotRoot, `screenshot-${++this.screenshotSequence}.png`)
          const output = await this.cli.screenshot(this.sessionId, target, signal, { filename })
          const image = await readFile(filename)
          if (!image.length || image.length > 10 * 1024 * 1024) throw new Error('BROWSER_SCREENSHOT_SIZE_INVALID')
          const snapshot = await this.refreshSnapshot(signal)
          const data = {
            captured: true,
            lifecycle: 'ephemeral_browser_session',
            screenshotSha256: createHash('sha256').update(image).digest('hex'),
            page: this.page,
            snapshot,
          }
          return {
            data,
            modelContent: [
              { type: 'text', text: JSON.stringify({ ...data, cliOutputSha256: hash(output) }) },
              { type: 'image', data: image.toString('base64'), mimeType: 'image/png' },
            ],
          }
        }
      }
    }
  }

  private assertInvocation(snapshot: TestExecutionAgentSnapshot | object, toolId: BrowserToolId) {
    if (this.closed) throw new Error('BROWSER_SESSION_CLOSED')
    const candidate = snapshot as Partial<TestExecutionAgentSnapshot>
    const authorization = candidate.browserAuthorization
    if (
      candidate.runId !== this.scope.runId
      || candidate.taskId !== this.scope.taskId
      || candidate.projectVersionId !== this.scope.projectVersionId
      || authorization?.runId !== this.scope.runId
      || authorization.taskId !== this.scope.taskId
      || authorization.projectVersionId !== this.scope.projectVersionId
      || authorization.environmentSignature !== this.scope.environmentSignature
      || authorization.stage !== this.scope.stage
    ) throw new Error(`BROWSER_TOOL_SCOPE_INVALID: ${toolId}`)
  }

  private async refreshSnapshot(signal: AbortSignal) {
    const snapshot = safeBrowserText(await this.cli.snapshot(this.sessionId, signal), 64 * 1024)
    this.lastSnapshot = snapshot
    this.elementRefs.clear()
    for (const line of snapshot.split(/\r?\n/u)) {
      for (const ref of observedElementRefs(line)) this.elementRefs.set(ref, line)
    }
    assertSnapshotSameOrigin(snapshot, this.scope.baseUrl)
    const pageUrl = pageUrlFromSnapshot(snapshot)
    if (pageUrl) this.page = new URL(pageUrl).pathname || '/'
    if (authenticationEntry(this.page, snapshot)) this.authenticationSurfaceObserved = true
    if (this.authenticationSubmitObserved) {
      this.stableAuthenticatedPageObserved = stableAuthenticatedPage(this.page, snapshot)
    }
    return snapshot
  }

  private observedTarget(value: unknown) {
    const target = String(value ?? '').trim()
    if (!target || !this.elementRefs.has(target)) throw new Error('BROWSER_ELEMENT_REF_NOT_OBSERVED')
    return target
  }

  private assertTargetSameOrigin(target: string) {
    const line = this.elementRefs.get(target) ?? ''
    for (const value of absoluteUrls(line)) assertSameOrigin(value, this.scope.baseUrl)
  }

  private rememberAction(
    action: string,
    actionType: HttpExplorationObservation['observedFrom']['actionType'],
  ) {
    this.sequence += 1
    this.lastAction = { action, actionType, sequence: this.sequence }
  }

  private async listRequests(signal: AbortSignal) {
    const summaries = await this.cli.listRequests(this.sessionId, signal)
    const result: Array<{
      requestRef: string
      method: string
      path: string
      status?: number
      resourceType?: string
    }> = []
    for (const summary of summaries.slice(0, 100)) {
      if (!sameOrigin(summary.url, this.scope.baseUrl)) continue
      const normalized = normalizeUiNetworkObservation({
        method: summary.method,
        url: summary.url,
        resourceType: summary.resourceType,
        responseStatus: summary.status,
        page: this.page,
        ...this.lastAction,
      })
      if (!normalized) continue
      const requestRef = `request_${hash(`${this.sessionId}:${summary.index}`).slice(0, 24)}`
      this.requestRefs.set(requestRef, summary)
      result.push({
        requestRef,
        method: normalized.method,
        path: normalized.path,
        ...(normalized.responseStatus ? { status: normalized.responseStatus } : {}),
        ...(summary.resourceType ? { resourceType: summary.resourceType } : {}),
      })
      if (result.length >= 30) break
    }
    return result
  }

  private async collectNetwork(signal: AbortSignal) {
    await this.listRequests(signal)
    for (const summary of this.requestRefs.values()) {
      const observation = await this.requestObservation(summary, signal).catch(() => null)
      if (observation) this.rememberObservation(observation)
    }
  }

  private async requestObservation(summary: PlaywrightCliRequestSummary, signal: AbortSignal) {
    if (!sameOrigin(summary.url, this.scope.baseUrl)) return null
    const raw = await this.cli.requestDetail(this.sessionId, summary, {
      page: this.page,
      ...this.lastAction,
    }, signal)
    if (!sameOrigin(String(raw.url ?? ''), this.scope.baseUrl)) return null
    return normalizeUiNetworkObservation(raw)
  }

  private rememberObservation(observation: HttpExplorationObservation) {
    const key = JSON.stringify([
      observation.method,
      observation.path,
      observation.observedFrom.action,
      observation.observedFrom.sequence,
    ])
    if (this.observedNetwork.some(candidate => JSON.stringify([
      candidate.method,
      candidate.path,
      candidate.observedFrom.action,
      candidate.observedFrom.sequence,
    ]) === key)) return
    this.observedNetwork.push(structuredClone(observation))
    if (
      this.authenticationSubmitObserved
      && observation.observedFrom.actionType === 'click'
      && successfulAuthenticationObservation(observation)
    ) {
      this.successfulAuthenticationObserved = true
    }
    if (this.observedNetwork.length > 100) this.observedNetwork.shift()
  }
}

function authorizedFillValues(task: ExecutionTask) {
  const values = new Set<string>()
  collectStrings(task.input.caseContent, values)
  collectStrings(task.input.executionSpec, values)
  collectStrings(task.input.testDataBindings, values)
  for (const value of [...values]) {
    for (const match of value.matchAll(/["'“”‘’]([^"'“”‘’]{1,500})["'“”‘’]/gu)) {
      if (match[1]) values.add(match[1])
    }
  }
  return values
}

function collectStrings(value: unknown, result: Set<string>, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return
  if (typeof value === 'string') {
    const normalized = value.trim()
    if (normalized && normalized.length <= 4_000) result.add(normalized)
    return
  }
  if (Array.isArray(value)) {
    value.slice(0, 1_000).forEach(item => collectStrings(item, result, depth + 1))
    return
  }
  if (typeof value === 'object') {
    Object.values(value as Record<string, unknown>).slice(0, 1_000)
      .forEach(item => collectStrings(item, result, depth + 1))
  }
}

function observedElementRefs(line: string) {
  const refs = new Set<string>()
  for (const match of line.matchAll(/\bref\s*[=:]\s*["']?([A-Za-z][A-Za-z0-9_-]{0,100})/gu)) {
    if (match[1]) refs.add(match[1])
  }
  for (const match of line.matchAll(/["']ref["']\s*:\s*["']([A-Za-z][A-Za-z0-9_-]{0,100})["']/gu)) {
    if (match[1]) refs.add(match[1])
  }
  return refs
}

function controlledBaseUrl(value: string) {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('BROWSER_BASE_URL_INVALID') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('BROWSER_BASE_URL_INVALID')
  }
  return url.toString()
}

function assertSnapshotSameOrigin(snapshot: string, baseUrl: string) {
  const pageUrl = pageUrlFromSnapshot(snapshot)
  if (pageUrl) assertSameOrigin(pageUrl, baseUrl)
}

function pageUrlFromSnapshot(snapshot: string) {
  return /(?:^|\n)\s*(?:page\s+)?url\s*[:=]\s*["']?(https?:\/\/[^\s"']+)/iu.exec(snapshot)?.[1]
}

function absoluteUrls(value: string) {
  return [...value.matchAll(/https?:\/\/[^\s"'<>\])}]+/giu)].map(match => match[0])
}

function assertSameOrigin(value: string, baseUrl: string) {
  if (!sameOrigin(value, baseUrl)) throw new Error('BROWSER_CROSS_ORIGIN_NAVIGATION_REJECTED')
}

function sameOrigin(value: string, baseUrl: string) {
  try { return new URL(value).origin === new URL(baseUrl).origin } catch { return false }
}

function safeBrowserText(value: string, maximum: number) {
  return String(value ?? '')
    .slice(0, maximum)
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/giu, 'Bearer <REDACTED>')
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '<REDACTED>')
    .replace(/\b(authorization|cookie|password|passwd|passcode|token|api[-_ ]?key|secret|session(?:[-_ ]?id)?|csrf(?:[-_ ]?token)?)\s*[:=]\s*[^\s,;]+/giu, '$1=<REDACTED>')
    .replace(/([?&][^=&#]{1,100}=)[^&#\s"']*/gu, '$1<REDACTED>')
}

function hash(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function successfulAuthenticationObservation(observation: HttpExplorationObservation) {
  return ['POST', 'PUT', 'PATCH'].includes(observation.method)
    && Number(observation.responseStatus) >= 200
    && Number(observation.responseStatus) < 400
    && /(?:^|\/)(?:auth(?:entication)?|login|sign[-_]?in|session|token)(?:\/|$)/iu.test(observation.path)
}

function authenticatedDestination(page: string, snapshot: string) {
  return !authenticationEntry(page, snapshot) && !authenticationFailure(page, snapshot)
}

function stableAuthenticatedPage(page: string, snapshot: string) {
  return authenticatedDestination(page, snapshot)
    && /(?:^|\n)\s*-?\s*(?:button|link|textbox|input|checkbox|radio|combobox|listbox|menuitem|tab|treeitem)\b/iu.test(snapshot)
}

function authenticationEntry(page: string, snapshot: string) {
  if (/(?:^|\/)(?:login|sign[-_]?in|auth)(?:\/|$)/iu.test(page)) return true
  const passwordInput = /(?:textbox|input)[^\n]*(?:密码|口令|password|passcode)/iu.test(snapshot)
  const loginAction = /(?:button|link)[^\n]*(?:登录|sign[ -]?in|log[ -]?in)/iu.test(snapshot)
  return passwordInput && loginAction
}

function authenticationCredentialField(value: string) {
  return /(?:账号|账户|用户名|邮箱|手机|密码|口令|username|user\s*name|email|phone|password|passcode)/iu.test(value)
}

function authenticationFailure(page: string, snapshot: string) {
  if (/(?:^|\/)(?:(?:login|sign[-_]?in|auth(?:entication)?|oauth|oidc|sso|callback)[-_/]?(?:error|failed|failure|denied)|access[-_]?denied|account[-_]?locked|unauthori[sz]ed|forbidden)(?:\/|$)/iu.test(page)) {
    return true
  }
  return /(?:密码|口令|用户名|账号|账户|验证码)(?:错误|不正确|无效)|(?:登录|认证|身份验证)(?:失败|错误)|账号(?:已被)?锁定|账户(?:已被)?锁定|访问(?:被)?拒绝|无权访问|(?:invalid|incorrect|wrong)\s+(?:password|passcode|username|user\s*name|credentials?|captcha|verification\s*code)|(?:password|passcode|username|user\s*name|credentials?|captcha|verification\s*code)\s+(?:is\s+)?(?:invalid|incorrect|wrong)|(?:login|log[ -]?in|sign[ -]?in|authentication)\s+(?:has\s+)?(?:failed|failure|error|denied)|account\s+(?:is\s+)?locked|access\s+denied/iu.test(snapshot)
}
