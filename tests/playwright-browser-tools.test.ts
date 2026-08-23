import assert from 'node:assert/strict'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveAuthSessionPolicy } from '../server/application/test-execution-auth-session.js'
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
import { LocalExecutionWorkspaceStore } from '../server/infrastructure/execution-workspace-store.js'

class FixtureBrowserCli implements PlaywrightBrowserCliAdapter {
  opened: string[] = []
  openedUrls: Array<string | undefined> = []
  loaded: string[] = []
  saved: string[] = []
  closed: string[] = []
  screenshotFilenames: string[] = []
  snapshotValue = 'url: https://example.test/app\n- button "提交" [ref=e1]\n- textbox "账号" [ref=e2]'
  readonly summaries: PlaywrightCliRequestSummary[] = [
    { index: 1, method: 'POST', url: 'https://example.test/api/login?token=real-query', status: 200, resourceType: 'fetch' },
    { index: 2, method: 'GET', url: 'https://analytics.invalid/collect', status: 204, resourceType: 'xhr' },
  ]

  async open(session: string, baseUrl?: string) {
    this.opened.push(session)
    this.openedUrls.push(baseUrl)
  }
  async stateLoad(_session: string, path: string) { this.loaded.push(path) }
  async stateSave(_session: string, path: string) {
    this.saved.push(path)
    await writeFile(path, JSON.stringify({ cookies: [], origins: [] }), { encoding: 'utf8' })
  }
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
  return { run, task, stage, authPolicy: { mode: 'fresh_anonymous' as const } }
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

async function observeReusableAuthentication(input: {
  taskId: string
  network: PlaywrightCliRequestSummary[]
  destinationSnapshot: string
}) {
  const root = await mkdtemp(join(tmpdir(), 'smarthub-browser-auth-evidence-'))
  try {
    const cli = new FixtureBrowserCli()
    cli.summaries.splice(0, cli.summaries.length, ...input.network)
    const scoped = execution('script_generation', input.taskId)
    scoped.task.input.caseContent = {
      ...scoped.task.input.caseContent,
      title: '新增项目',
      preconditions: ['管理员已登录'],
      steps: ['在账号框输入 "alice"', '在密码框输入 "secret-password"', '点击认证提交控件', '新增项目'],
      expectedResults: ['项目新增成功'],
    }
    const authPolicy = resolveAuthSessionPolicy(scoped.task.input)
    assert.deepEqual(authPolicy, { mode: 'reuse_authenticated', role: 'admin', stateKey: 'admin' })
    let committed = false
    const session = await new PlaywrightBrowserToolGateway(cli).openSession({
      ...scoped,
      authPolicy,
      authState: {
        savePath: join(root, 'admin.json'),
        commit: async () => { committed = true },
      },
    }, new AbortController().signal)

    cli.snapshotValue = [
      'url: https://example.test/account/access',
      '- heading "账户验证"',
      '- textbox "账号" [ref=e2]',
      '- textbox "密码" [ref=e3]',
      '- button "Sign in" [ref=e1]',
    ].join('\n')
    await invoke(session, 'browser.snapshot', {})
    await invoke(session, 'browser.fill', { target: 'e2', text: 'alice' })
    await invoke(session, 'browser.fill', { target: 'e3', text: 'secret-password' })
    cli.snapshotValue = input.destinationSnapshot
    await invoke(session, 'browser.click', { target: 'e1' })
    await session.close()

    return { saved: cli.saved.length, committed }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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

test('Browser Auth State 综合提交、页面与 Network 证据，并拒绝认证失败页面', async (context) => {
  await context.test('标准 login API 成功后仍保存', async () => {
    const result = await observeReusableAuthentication({
      taskId: 'task-auth-standard',
      network: [{
        index: 1,
        method: 'POST',
        url: 'https://example.test/api/login',
        status: 200,
        resourceType: 'fetch',
      }],
      destinationSnapshot: 'url: https://example.test/projects\n- heading "项目"',
    })
    assert.deepEqual(result, { saved: 1, committed: true })
  })

  for (const candidate of [
    { name: '非标准认证 API', path: '/gateway/account', taskId: 'task-auth-gateway' },
    { name: 'GraphQL 登录', path: '/graphql', taskId: 'task-auth-graphql' },
  ]) {
    await context.test(`${candidate.name} 可由稳定业务页面补足成功证据`, async () => {
      const result = await observeReusableAuthentication({
        taskId: candidate.taskId,
        network: [{
          index: 1,
          method: 'POST',
          url: `https://example.test${candidate.path}`,
          status: 200,
          resourceType: 'fetch',
        }],
        destinationSnapshot: 'url: https://example.test/projects\n- navigation "主导航"\n- link "项目列表" [ref=e8]',
      })
      assert.deepEqual(result, { saved: 1, committed: true })
    })
  }

  await context.test('无可识别认证请求时可由稳定业务页面保存', async () => {
    const result = await observeReusableAuthentication({
      taskId: 'task-auth-page-evidence',
      network: [],
      destinationSnapshot: 'url: https://example.test/projects\n- heading "项目"\n- button "新建项目" [ref=e8]',
    })
    assert.deepEqual(result, { saved: 1, committed: true })
  })

  for (const candidate of [
    {
      name: '密码错误并停留认证页',
      taskId: 'task-auth-invalid-password',
      snapshot: 'url: https://example.test/account/access\n- alert "密码错误"\n- textbox "密码" [ref=e3]\n- button "重试" [ref=e8]',
    },
    {
      name: '登录失败跳转错误页',
      taskId: 'task-auth-login-error',
      snapshot: 'url: https://example.test/login-error\n- heading "请求未完成"\n- button "返回" [ref=e8]',
    },
    {
      name: '账号锁定',
      taskId: 'task-auth-account-locked',
      snapshot: 'url: https://example.test/account/help\n- alert "Account is locked"\n- button "Contact support" [ref=e8]',
    },
  ]) {
    await context.test(`${candidate.name} 不保存`, async () => {
      const result = await observeReusableAuthentication({
        taskId: candidate.taskId,
        network: [],
        destinationSnapshot: candidate.snapshot,
      })
      assert.deepEqual(result, { saved: 0, committed: false })
    })
  }
})

test('Auth Session Policy 只根据冻结 Case 语义区分业务复用、认证隔离与多角色', () => {
  const policy = (title: string, preconditions: string[], steps = ['执行目标操作']) => resolveAuthSessionPolicy({
    caseId: `case-${title}`,
    caseContent: {
      schemaVersion: 'test-case/v3',
      title,
      dimension: 'functional',
      requirementRefs: [],
      priority: 'P1',
      executionMethods: ['ui'],
      preconditions,
      steps,
      expectedResults: ['结果符合预期'],
    },
    executionSpec: {} as ExecutionTask['input']['executionSpec'],
  })

  assert.deepEqual(policy('新增项目', ['管理员已登录']), {
    mode: 'reuse_authenticated', role: 'admin', stateKey: 'admin',
  })
  assert.deepEqual(policy('删除项目', ['普通用户已登录']), {
    mode: 'reuse_authenticated', role: 'user', stateKey: 'user',
  })
  assert.deepEqual(policy('密码错误登录', []), { mode: 'fresh_anonymous' })
  assert.deepEqual(policy('登录成功', []), { mode: 'fresh_anonymous' })
  assert.deepEqual(policy('退出登录', ['管理员已登录']), {
    mode: 'isolated_role', role: 'admin', stateKey: 'admin',
  })
  assert.deepEqual(policy('普通用户访问管理员页面', ['普通用户已登录']), {
    mode: 'isolated_role', role: 'user', stateKey: 'user',
  })
  assert.deepEqual(policy('角色切换', ['管理员已登录']), { mode: 'custom' })
  assert.deepEqual(policy('公开首页', []), { mode: 'fresh_anonymous' })
})

test('Browser Exploration 在 Run 内按 Role 复用状态，Repair 同策略，认证 Case 与其他 Run 不加载', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smarthub-browser-auth-policy-'))
  try {
    const store = new LocalExecutionWorkspaceStore(root)
    const cli = new FixtureBrowserCli()
    cli.summaries.splice(0, cli.summaries.length, {
      index: 1,
      method: 'POST',
      url: 'https://example.test/gateway/account',
      status: 200,
      resourceType: 'fetch',
    })
    const gateway = new PlaywrightBrowserToolGateway(cli)
    await assert.rejects(
      () => gateway.openSession({
        ...execution(),
        authPolicy: { mode: 'reuse_authenticated', role: 'default', stateKey: 'default' },
      }, new AbortController().signal),
      /BROWSER_AUTH_SESSION_POLICY_INVALID/u,
    )
    const openFor = async (input: ReturnType<typeof execution>, title: string, preconditions: string[]) => {
      input.task.input.caseContent = {
        ...input.task.input.caseContent,
        title,
        preconditions,
        steps: ['在账号框输入 "alice"', '执行目标操作'],
        expectedResults: ['操作成功'],
      }
      const authPolicy = resolveAuthSessionPolicy(input.task.input)
      const authState = authPolicy.role && authPolicy.stateKey
        ? await store.runtimeAuthStateAccess({
            projectVersionId: input.run.projectVersionId,
            runId: input.run.id,
            environmentSignature: input.run.environment.signature,
            baseUrl: input.run.environment.baseUrl,
            role: authPolicy.role,
            stateKey: authPolicy.stateKey,
          }, { writable: authPolicy.mode === 'reuse_authenticated' })
        : undefined
      return gateway.openSession({ ...input, authPolicy, ...(authState ? { authState } : {}) }, new AbortController().signal)
    }

    const createProject = await openFor(execution('script_generation', 'task-create'), '新增项目', ['管理员已登录'])
    assert.equal(createProject.scope.authStateLoaded, false)
    cli.snapshotValue = 'url: https://example.test/login\n- button "登录" [ref=e1]\n- textbox "账号" [ref=e2]'
    await invoke(createProject, 'browser.snapshot', {})
    await invoke(createProject, 'browser.fill', { target: 'e2', text: 'alice' })
    cli.snapshotValue = 'url: https://example.test/app\n- button "提交" [ref=e1]'
    await invoke(createProject, 'browser.click', { target: 'e1' })
    await createProject.close()
    assert.equal(cli.saved.length, 1)
    assert.match(cli.saved[0], /\.runtime-auth[\\/]run-browser-1[\\/]\.admin\./u)

    const deleteProject = await openFor(execution('script_generation', 'task-delete'), '删除项目', ['管理员已登录'])
    assert.equal(deleteProject.scope.authStateLoaded, true)
    assert.match(cli.loaded.at(-1) ?? '', /\.runtime-auth[\\/]run-browser-1[\\/]admin\.json$/u)
    assert.deepEqual(cli.openedUrls.slice(-2), [undefined, 'https://example.test/'])
    await deleteProject.close()

    const repairProject = await openFor(execution('script_repair', 'task-repair'), '删除项目', ['管理员已登录'])
    assert.equal(repairProject.scope.authPolicy.mode, 'reuse_authenticated')
    assert.equal(repairProject.scope.authStateLoaded, true)
    await repairProject.close()

    const logout = await openFor(execution('script_repair', 'task-logout'), '退出登录', ['管理员已登录'])
    assert.equal(logout.scope.authPolicy.mode, 'isolated_role')
    assert.equal(logout.scope.authStateLoaded, true)
    await invoke(logout, 'browser.snapshot', {})
    await invoke(logout, 'browser.click', { target: 'e1' })
    await logout.close()
    assert.equal(cli.saved.length, 1)

    const loginFailure = await openFor(execution('script_repair', 'task-login-failure'), '密码错误登录', [])
    assert.equal(loginFailure.scope.authPolicy.mode, 'fresh_anonymous')
    assert.equal(loginFailure.scope.authStateLoaded, false)
    const loadedBeforeLoginFailure = cli.loaded.length
    await loginFailure.close()
    assert.equal(cli.loaded.length, loadedBeforeLoginFailure)

    const loginSuccess = await openFor(execution('script_generation', 'task-login-success'), '登录成功', [])
    assert.equal(loginSuccess.scope.authPolicy.mode, 'fresh_anonymous')
    assert.equal(loginSuccess.scope.authStateLoaded, false)
    await loginSuccess.close()

    const userBusiness = await openFor(execution('script_generation', 'task-user'), '查询项目', ['普通用户已登录'])
    cli.snapshotValue = 'url: https://example.test/login\n- button "登录" [ref=e1]\n- textbox "账号" [ref=e2]'
    await invoke(userBusiness, 'browser.snapshot', {})
    await invoke(userBusiness, 'browser.fill', { target: 'e2', text: 'alice' })
    cli.snapshotValue = 'url: https://example.test/app\n- button "提交" [ref=e1]'
    await invoke(userBusiness, 'browser.click', { target: 'e1' })
    await userBusiness.close()
    assert.equal(cli.saved.length, 2)
    assert.match(cli.saved[1], /\.runtime-auth[\\/]run-browser-1[\\/]\.user\./u)

    const otherRunInput = execution('script_generation', 'task-other-run')
    otherRunInput.run.id = 'run-browser-2'
    otherRunInput.task.runId = otherRunInput.run.id
    const otherRun = await openFor(otherRunInput, '删除项目', ['管理员已登录'])
    assert.equal(otherRun.scope.authStateLoaded, false)
    await otherRun.close()
    await assert.rejects(() => access(join(root, 'version-browser-1', '.runtime-auth', 'run-browser-2', 'admin.json')))

    const otherEnvironmentInput = execution('script_generation', 'task-other-environment')
    otherEnvironmentInput.run.environment.signature = 'b'.repeat(64)
    const otherEnvironment = await openFor(otherEnvironmentInput, '删除项目', ['管理员已登录'])
    assert.equal(otherEnvironment.scope.authStateLoaded, false)
    await otherEnvironment.close()

    const otherVersionInput = execution('script_generation', 'task-other-version')
    otherVersionInput.run.projectVersionId = 'version-browser-2'
    const otherVersion = await openFor(otherVersionInput, '删除项目', ['管理员已登录'])
    assert.equal(otherVersion.scope.authStateLoaded, false)
    await otherVersion.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
