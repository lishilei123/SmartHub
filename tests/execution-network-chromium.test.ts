import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import { buildExecutionPackage, freezeExecutionTaskInput } from '../server/application/test-execution-validation.js'
import type { TestCaseContent } from '../server/domain/test-design-types.js'
import { LocalExecutionArtifactStore } from '../server/infrastructure/execution-artifact-store.js'
import { LocalExecutionWorkspaceStore } from '../server/infrastructure/execution-workspace-store.js'
import { LocalWorkspaceRunner } from '../server/runner/local-workspace-runner.js'

test('真实 Chromium 与 APIRequestContext 对业务 URL、受管导航、动态目标和重定向执行冻结网络策略', async () => {
  let unauthorizedRequests = 0
  const upgradedSockets = new Set<import('node:stream').Duplex>()
  const foreign = createServer((_request, response) => { unauthorizedRequests++; response.end('unauthorized') })
  foreign.on('upgrade', (_request, socket) => { unauthorizedRequests++; socket.destroy() })
  const foreignUrl = await listen(foreign)
  const allowed = createServer((request, response) => {
    if (request.url === '/redirect-denied') { response.writeHead(302, { location: foreignUrl }); response.end(); return }
    if (request.url === '/redirect-allowed') { response.writeHead(302, { location: '/' }); response.end(); return }
    if (request.url === '/api') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ website: foreignUrl })); return }
    response.setHeader('content-type', 'text/html; charset=utf-8')
    if (request.url === '/websocket' || request.url === '/websocket-denied') {
      const target = request.url === '/websocket' ? `ws://${request.headers.host}/socket` : foreignUrl.replace('http:', 'ws:')
      response.end(`<h1>Ready</h1><p id="state">connecting</p><script>const ws = new WebSocket(${JSON.stringify(target)}); ws.onmessage = event => state.textContent = event.data; ws.onerror = () => state.textContent = 'closed';</script>`)
      return
    }
    response.end(`<h1>Ready</h1><input aria-label="website"><a href="${foreignUrl}">Website</a><button onclick="location.href='${foreignUrl}'">Navigate outside</button>`)
  })
  allowed.on('upgrade', (request, socket) => {
    upgradedSockets.add(socket)
    socket.once('close', () => upgradedSockets.delete(socket))
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.write(Buffer.from([0x81, 4, ...Buffer.from('open')]))
    socket.on('error', () => socket.destroy())
  })
  const baseUrl = await listen(allowed)
  const temporary = await mkdtemp(join(process.cwd(), 'smarthub-network-regression-'))
  try {
    const artifacts = new LocalExecutionArtifactStore(join(temporary, 'artifacts'))
    const workspaceStore = new LocalExecutionWorkspaceStore(join(temporary, 'workspaces'))
    const runner = new LocalWorkspaceRunner(artifacts, 30_000)
    const environment = {
      environmentId: 'network-regression', name: '真实本地网络回归', baseUrl,
      signature: 'network-regression-environment',
      targets: [{ protocol: 'http' as const, host: '127.0.0.1', port: Number(new URL(baseUrl).port) }],
    }
    const execute = async (name: string, method: 'ui' | 'api', source: string, dependencies: Array<{ path: string; content: string }> = []) => {
      const task = frozenTask(method)
      const entryFile = `tests/${method}/network.spec.ts`
      const executionPackage = buildExecutionPackage({
        candidate: { entryFile, files: [{ path: entryFile, content: source }, ...dependencies] },
        task, environmentSignature: environment.signature,
      })
      await workspaceStore.writeFiles(name, executionPackage.files)
      const workspace = await workspaceStore.snapshot(name)
      const result = await runner.execute({
        package: executionPackage, task, attemptId: name,
        expectedPackageSha256: executionPackage.manifest.packageSha256,
        environment, runner: runner.snapshot(),
        workspace: { root: workspace.root, entryFile, entrySymbol: '[TC_NETWORK_001]',
          authStateRoot: await workspaceStore.runtimeAuthRoot(name, 'run-network') },
      }, new AbortController().signal)
      let log = ''
      for (const artifact of result.artifacts.filter(item => item.type === 'log')) {
        for await (const chunk of await artifacts.open(artifact.storagePath)) log += Buffer.from(chunk).toString('utf8')
      }
      return { result, log }
    }
    const ui = (body: string, imports = '') => `import { test, expect } from '@playwright/test'
${imports}
test('network [TC_NETWORK_001]', async ({ page }) => {
${body}
  // smarthub:assert expected-1
  await expect(page.getByRole('heading')).toHaveText('Ready')
})`
    const business = await execute('business-url', 'ui', ui(`
  await page.goto('/')
  await page.getByLabel('website').fill(${JSON.stringify(foreignUrl)})
  await expect(page.getByLabel('website')).toHaveValue(${JSON.stringify(foreignUrl)})
  await expect(page.getByRole('link')).toHaveAttribute('href', ${JSON.stringify(foreignUrl)})`))
    assert.equal(business.result.status, 'passed', business.log)
    const helper = await execute('helper-navigation', 'ui', ui('  await openHome(page)', "import { openHome } from '../../helpers/home.js'"), [
      { path: 'helpers/home.ts', content: "export async function openHome(page) { await page.goto('/') }" },
    ])
    assert.equal(helper.result.status, 'passed', helper.log)
    const pageObject = await execute('page-object-navigation', 'ui', ui('  const home = new Home(page)\n  await home.open()', "import { Home } from '../../pages/home.js'"), [
      { path: 'pages/home.ts', content: "export class Home { constructor(private readonly page) {} async open() { await this.page.goto('/') } }" },
    ])
    assert.equal(pageObject.result.status, 'passed', pageObject.log)
    const redirect = await execute('allowed-redirect', 'ui', ui("  await page.goto('/redirect-allowed')"))
    assert.equal(redirect.result.status, 'passed', redirect.log)
    const websocket = await execute('allowed-websocket', 'ui', ui("  await page.goto('/websocket')\n  await expect(page.locator('#state')).toHaveText('open')"))
    assert.equal(websocket.result.status, 'passed', websocket.log)
    for (const [name, action] of [
      ['dynamic-target', `const destination = ${JSON.stringify(foreignUrl)}; await page.goto(destination).catch(() => {})`],
      ['redirect-target', "await page.goto('/redirect-denied').catch(() => {})"],
      ['application-target', "await page.getByRole('button').click(); await page.waitForTimeout(300)"],
      ['page-request-target', `const destination = ${JSON.stringify(foreignUrl)}; await page.request.get(destination).catch(() => {})`],
      ['nested-context-target', `const context = await page.context().browser().newContext({ proxy: { server: ${JSON.stringify(foreignUrl)} } }); const destination = ${JSON.stringify(foreignUrl)}; await context.request.get(destination).catch(() => {}); await context.close()`],
      ['websocket-target', "await page.goto('/websocket-denied'); await expect(page.locator('#state')).toHaveText('closed')"],
    ]) {
      const denied = await execute(name!, 'ui', ui(`  await page.goto('/')\n  ${action}\n  await page.goto('/')`))
      assert.equal(denied.result.status, 'failed', denied.log)
      assert.equal(denied.result.error, 'TEST_EXECUTION_NETWORK_TARGET_REJECTED', denied.log)
    }
    const api = (body: string) => `import { test, expect } from '@playwright/test'
test('network [TC_NETWORK_001]', async ({ request }) => {
${body}
  const response = await test.step('GET /api', async () => request.get('/api'))
  const body = await response.json()
  expect(body.website).toBe(${JSON.stringify(foreignUrl)})
  // smarthub:assert expected-1
  expect(response.status()).toBe(200)
})`
    const responseData = await execute('api-response-url', 'api', api(''))
    assert.equal(responseData.result.status, 'passed', responseData.log)
    const overriddenProxy = await execute('api-overridden-proxy', 'api', api('').replace(
      "test('network", `test.use({ proxy: { server: ${JSON.stringify(foreignUrl)} } })\ntest('network`,
    ))
    assert.equal(overriddenProxy.result.status, 'passed', overriddenProxy.log)
    const fixtureSource = api('').replace("import { test, expect } from '@playwright/test'",
      "import { expect } from '@playwright/test'\nimport { test } from '../../fixtures/network.js'")
    await assert.rejects(() => execute('api-managed-fixture', 'api', fixtureSource, [{
      path: 'fixtures/network.ts', content: `import { test as base, request as factory } from '@playwright/test'
export const test = base.extend({ request: async ({}, use) => {
  const context = await factory.newContext({ baseURL: ${JSON.stringify(baseUrl)}, proxy: { server: ${JSON.stringify(foreignUrl)} } })
  try { await use(context) } finally { await context.dispose() }
} })`,
    }]), /不支持覆盖 page\/request\/browser\/context/u)
    const managedContext = await execute('api-managed-context', 'api', api(`
  const context = await factory.newContext({ baseURL: ${JSON.stringify(baseUrl)}, proxy: { server: ${JSON.stringify(foreignUrl)} } })
  const probe = await context.get('/api')
  expect(probe.status()).toBe(200)
  await context.dispose()`).replace("import { test, expect }", "import { test, expect, request as factory }"))
    assert.equal(managedContext.result.status, 'passed', managedContext.log)
    const apiDenied = await execute('api-redirect-target', 'api', api("  await request.get('/redirect-denied').catch(() => {})"))
    assert.equal(apiDenied.result.error, 'TEST_EXECUTION_NETWORK_TARGET_REJECTED', apiDenied.log)
    const protocolDenied = await execute('api-protocol-target', 'api', api(`
  const destination = ${JSON.stringify(baseUrl)}.replace('http:', 'https:')
  await request.get(destination).catch(() => {})`))
    assert.equal(protocolDenied.result.error, 'TEST_EXECUTION_NETWORK_TARGET_REJECTED', protocolDenied.log)
    assert.equal(unauthorizedRequests, 0, '未授权服务必须没有收到浏览器或 API 请求')
  } finally {
    for (const socket of upgradedSockets) socket.destroy()
    await Promise.all([close(allowed), close(foreign)])
    await rm(temporary, { recursive: true, force: true })
  }
})

function frozenTask(method: 'ui' | 'api') {
  const content: TestCaseContent = {
    schemaVersion: 'test-case/v3', title: '冻结网络边界', dimension: 'functional', priority: 'P1',
    requirementRefs: ['requirement-network'], preconditions: [], executionMethods: [method],
    steps: ['打开目标并检查结果'], expectedResults: [method === 'ui' ? '页面标题为 Ready' : '返回 HTTP 200'],
  }
  const contentSha256 = canonicalSha256(content)
  return { ...freezeExecutionTaskInput({
    libraryMember: { caseId: 'TC_NETWORK_001', revision: 1, ordinal: 0, contentSha256,
      frozenContent: content, executionReadiness: 'ready' },
    handoffMember: { stage: 'full', ordinal: 0, sourceVersionId: 'network-library', caseId: 'TC_NETWORK_001',
      revision: 1, method, reason: '真实网络验证', dedupKey: `TC_NETWORK_001:1:${method}`, dimension: 'functional',
      executionSpec: { schemaVersion: 'test-script-input/v1', method, testCase: content }, contentSha256 },
  }), taskId: 'task-network' }
}

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}/`
}
async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
