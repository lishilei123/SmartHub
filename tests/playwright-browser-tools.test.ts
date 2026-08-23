import assert from 'node:assert/strict'
import { access, writeFile } from 'node:fs/promises'
import test from 'node:test'
import type { TestExecutionAgentSnapshot } from '../server/domain/agent-types.js'
import type { ExecutionRun, ExecutionTask } from '../server/domain/test-execution-types.js'
import type {
  PlaywrightBrowserCliAdapter,
  PlaywrightCliRequestSummary,
} from '../server/agent/ui-execution-agent.js'
import type { RawUiNetworkObservation } from '../server/application/test-execution-exploration.js'
import {
  BROWSER_TOOL_IDS,
  PlaywrightBrowserToolGateway,
  type BrowserToolSession,
  type BrowserToolStage,
} from '../server/tools/playwright-browser-tools.js'
import { ToolRegistry } from '../server/tools/registry.js'
import { GovernedToolRuntime } from '../server/tools/runtime.js'

class FixtureBrowserCli implements PlaywrightBrowserCliAdapter {
  opened: string[] = []
  closed: string[] = []
  screenshotFilenames: string[] = []
  snapshotValue = 'url: https://example.test/app\n- button "提交" [ref=e1]\n- textbox "账号" [ref=e2]'
  readonly summaries: PlaywrightCliRequestSummary[] = [
    { index: 1, method: 'POST', url: 'https://example.test/api/login?token=real-query', status: 200, resourceType: 'fetch' },
    { index: 2, method: 'GET', url: 'https://analytics.invalid/collect', status: 204, resourceType: 'xhr' },
  ]

  async open(session: string) { this.opened.push(session) }
  async close(session: string) { this.closed.push(session) }
  async snapshot() { return this.snapshotValue }
  async click(_session: string, target: string) { return `clicked ${target}` }
  async fill(_session: string, target: string) { return `filled ${target}` }
  async generateLocator() { return `page.getByRole('button', { name: '提交' })` }
  async screenshot(
    _session: string,
    _target: string | undefined,
    _signal: AbortSignal,
    options?: { filename?: string },
  ) {
    assert.ok(options?.filename)
    this.screenshotFilenames.push(options.filename)
    await writeFile(options.filename, Buffer.from('fixture-png'), { encoding: 'utf8' })
    return 'saved screenshot with token=real-secret'
  }
  async listRequests() { return structuredClone(this.summaries) }
  async requestDetail(
    _session: string,
    summary: PlaywrightCliRequestSummary,
    observedFrom: Pick<RawUiNetworkObservation, 'page' | 'action' | 'actionType' | 'sequence'>,
  ): Promise<RawUiNetworkObservation> {
    return {
      ...observedFrom,
      method: summary.method,
      url: summary.url,
      resourceType: summary.resourceType,
      requestHeaders: {
        authorization: 'Bearer real-authorization',
        cookie: 'session=real-session',
        'content-type': 'application/json',
      },
      requestBody: { username: 'alice', password: 'real-password' },
      responseStatus: summary.status,
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: { token: 'real-token', user: { id: 42 } },
    }
  }
}

const environmentSignature = 'a'.repeat(64)

function execution(stage: BrowserToolStage = 'script_generation', taskId = 'task-browser-1') {
  const run = {
    id: 'run-browser-1',
    projectId: 'project-browser-1',
    projectVersionId: 'version-browser-1',
    environment: {
      baseUrl: 'https://example.test/',
      signature: environmentSignature,
    },
  } as ExecutionRun
  const task = {
    id: taskId,
    runId: run.id,
    input: {
      method: 'ui',
      caseContent: {
        schemaVersion: 'test-case/v3',
        title: '登录并提交',
        dimension: 'functional',
        requirementRefs: [],
        priority: 'P1',
        executionMethods: ['ui'],
        preconditions: [],
        steps: ['在账号框输入 "alice"', '点击提交'],
        expectedResults: ['提交成功'],
      },
      executionSpec: {},
    },
  } as ExecutionTask
  return { run, task, stage }
}

function requestContext(session: BrowserToolSession, overrides: Partial<TestExecutionAgentSnapshot> = {}) {
  return {
    runId: session.scope.runId,
    taskId: session.scope.taskId,
    projectId: 'project-browser-1',
    projectVersionId: session.scope.projectVersionId,
    browserAuthorization: {
      runId: session.scope.runId,
      taskId: session.scope.taskId,
      projectVersionId: session.scope.projectVersionId,
      environmentSignature: session.scope.environmentSignature,
      stage: session.scope.stage,
    },
    ...overrides,
  } as TestExecutionAgentSnapshot
}

async function invoke(
  session: BrowserToolSession,
  toolId: string,
  argumentsValue: Record<string, unknown>,
  snapshot = requestContext(session),
) {
  const binding = session.runtimeToolBindings().find(candidate => candidate.descriptor.id === toolId)
  assert.ok(binding)
  return binding.handler({
    toolId,
    toolCallId: `call-${toolId}`,
    arguments: argumentsValue,
    context: { snapshot, allowedToolIds: new Set(BROWSER_TOOL_IDS) },
  }, new AbortController().signal)
}

test('Browser Tools 支持受控多轮 Agent Loop，并对测试数据、请求详情和截图输出脱敏', async () => {
  const cli = new FixtureBrowserCli()
  const session = await new PlaywrightBrowserToolGateway(cli).openSession(execution(), new AbortController().signal)

  assert.deepEqual(session.runtimeToolBindings().map(binding => binding.descriptor.id), [...BROWSER_TOOL_IDS])
  assert.equal(BROWSER_TOOL_IDS.includes('browser.evaluate' as never), false)
  assert.match(JSON.stringify((await invoke(session, 'browser.snapshot', {})).data), /ref=e1/u)
  await invoke(session, 'browser.fill', { target: 'e2', text: 'alice' })
  await assert.rejects(() => invoke(session, 'browser.fill', { target: 'e2', text: 'invented-account' }), /BROWSER_FILL_VALUE_NOT_AUTHORIZED/u)
  await invoke(session, 'browser.click', { target: 'e1' })
  const requests = (await invoke(session, 'browser.requests', {})).data as { requests: Array<{ requestRef: string; path: string }> }
  assert.equal(requests.requests.length, 1)
  assert.equal(requests.requests[0].path, '/api/login')
  const detail = await invoke(session, 'browser.request_detail', { requestRef: requests.requests[0].requestRef })
  const serialized = JSON.stringify(detail.data)
  assert.match(serialized, /<REDACTED>/u)
  assert.doesNotMatch(serialized, /real-authorization|real-session|real-password|real-token|real-query/u)
  assert.match(JSON.stringify((await invoke(session, 'browser.get_locator', { target: 'e1' })).data), /getByRole/u)
  const screenshotResult = await invoke(session, 'browser.screenshot', {})
  const screenshot = JSON.stringify(screenshotResult.data)
  assert.match(screenshot, /ephemeral_browser_session/u)
  assert.doesNotMatch(screenshot, /runtime|real-secret|Zml4dHVyZS1wbmc=/u)
  assert.equal(screenshotResult.modelContent?.[1]?.type, 'image')
  assert.equal(screenshotResult.modelContent?.[1]?.type === 'image'
    ? screenshotResult.modelContent[1].data
    : undefined, Buffer.from('fixture-png').toString('base64'))

  await session.close()
  assert.equal(cli.closed.length, 1)
  await assert.rejects(() => access(cli.screenshotFilenames[0]))
  await assert.rejects(() => invoke(session, 'browser.snapshot', {}), /BROWSER_SESSION_CLOSED/u)
})

test('Browser Session 按 Task 隔离，并拒绝错误 scope、跨 Session requestRef 与跨源页面', async () => {
  const cli = new FixtureBrowserCli()
  const gateway = new PlaywrightBrowserToolGateway(cli)
  const first = await gateway.openSession(execution('script_generation', 'task-a'), new AbortController().signal)
  const second = await gateway.openSession(execution('script_repair', 'task-b'), new AbortController().signal)
  assert.notEqual(cli.opened[0], cli.opened[1])

  const firstRequests = (await invoke(first, 'browser.requests', {})).data as { requests: Array<{ requestRef: string }> }
  await assert.rejects(
    () => invoke(second, 'browser.click', { target: 'e1' }),
    /BROWSER_ELEMENT_REF_NOT_OBSERVED/u,
  )
  await assert.rejects(
    () => invoke(second, 'browser.request_detail', { requestRef: firstRequests.requests[0].requestRef }),
    /BROWSER_REQUEST_REF_NOT_OBSERVED/u,
  )
  await assert.rejects(
    () => invoke(first, 'browser.snapshot', {}, requestContext(first, { taskId: 'task-b' })),
    /BROWSER_TOOL_SCOPE_INVALID/u,
  )
  cli.snapshotValue = 'url: https://evil.invalid/app\n- button "外部" [ref=e9]'
  await assert.rejects(() => invoke(first, 'browser.snapshot', {}), /BROWSER_CROSS_ORIGIN_NAVIGATION_REJECTED/u)

  await Promise.all([first.close(), second.close()])
  assert.equal(cli.closed.length, 2)
})

test('Browser Tools 通过 GovernedToolRuntime 计入调用上限与重复调用治理', async () => {
  const cli = new FixtureBrowserCli()
  const session = await new PlaywrightBrowserToolGateway(cli).openSession(execution(), new AbortController().signal)
  const registry = new ToolRegistry()
  session.runtimeToolBindings().forEach(binding => registry.register(binding.descriptor, binding.handler))
  const runtime = new GovernedToolRuntime(registry, { maxToolCalls: 2, maxRepeatedToolCall: 3 })
  const snapshot = requestContext(session)
  const execute = (toolId: string, argumentsValue: Record<string, unknown>) => runtime.execute({
    toolId,
    toolCallId: `governed-${toolId}`,
    arguments: argumentsValue,
    context: { snapshot, allowedToolIds: new Set(BROWSER_TOOL_IDS) },
  }, new AbortController().signal)

  await execute('browser.snapshot', {})
  await execute('browser.requests', {})
  await assert.rejects(() => execute('browser.get_locator', { target: 'e1' }), /AGENT_TOOL_LIMIT_EXCEEDED/u)
  await session.close()
})
