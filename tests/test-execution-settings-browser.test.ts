import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createViteServer } from 'vite'
import { chromium, expect } from '@playwright/test'
import { TestExecutionInfrastructureConfigurationService } from '../server/application/test-execution-infrastructure-configuration-service.js'
import { JsonStore } from '../server/infrastructure/store.js'

test('真实配置页面加载后端值、校验、保存发布、失败提示与持久化重载', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'smarthub-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const database = join(directory, 'settings.json')
  const environment = { SMARTHUB_TEST_EXECUTION_CONCURRENCY: '2' }
  let store = new JsonStore(database)
  await store.load()
  let service = new TestExecutionInfrastructureConfigurationService(store, environment)
  let failSave = false
  let failLoad = true
  let saveCalls = 0
  const vite = await createViteServer({
    configFile: false,
    cacheDir: join(directory, 'vite-cache'),
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    plugins: [{
      name: 'settings-behavior-harness',
      resolveId: id => id === '/__settings-test.js' ? id : undefined,
      load: id => id === '/__settings-test.js' ? `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { TestExecutionSettings } from '/src/app/TestExecutionSettings.tsx';
        createRoot(document.getElementById('root')).render(React.createElement(TestExecutionSettings, { notify: () => {}, addAudit: () => {} }));
      ` : undefined,
    }],
  })
  t.after(() => vite.close())
  // A real HTTP adapter calls the same configuration Service; only the explicit
  // outage below is injected. No browser routing or fetch responses are mocked.
  const server = createServer(async (request, response) => {
    try {
      const path = request.url ?? '/'
      if (path.startsWith('/api/test-execution-infrastructure-configuration')) {
        let body = ''
        for await (const chunk of request) body += chunk
        const input = body ? JSON.parse(body) : undefined
        let result: unknown
        if (request.method === 'PUT' && path.endsWith('/draft')) {
          saveCalls += 1
          if (failSave) throw new Error('配置数据库暂时不可用')
          result = await service.saveDraft(input, '页面测试管理员')
        } else if (request.method === 'POST' && path.endsWith('/publish')) {
          result = await service.publishDraft(input, '页面测试管理员')
        } else {
          if (failLoad) throw new Error('无法读取配置数据库')
          result = await service.get()
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
      } else if (path === '/') {
        const html = await vite.transformIndexHtml('/', '<html><body><div id="root"></div><script type="module" src="/__settings-test.js"></script></body></html>')
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
      } else vite.middlewares(request, response)
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  page.on('pageerror', error => t.diagnostic(error.stack ?? error.message))
  await page.goto(`http://127.0.0.1:${address.port}`)
  await expect(page.getByRole('alert')).toHaveText('无法读取配置数据库')
  await expect(page.getByRole('spinbutton')).toHaveCount(0)
  failLoad = false
  await page.getByRole('button', { name: '重新读取' }).click()
  const runner = page.getByRole('spinbutton', { name: 'Runner 最大并发数' })
  const agent = page.getByRole('spinbutton', { name: 'Agent 最大并发数' })
  const save = page.getByRole('button', { name: '保存草稿' })
  const publish = page.getByRole('button', { name: '发布配置' })
  await expect(runner).toHaveValue('2')
  await expect(agent).toHaveValue('1')
  await expect(page.getByText('旧环境变量兼容配置', { exact: true })).toBeVisible()

  for (const invalid of ['0', '17', '1.5']) {
    await runner.fill(invalid)
    await expect(save).toBeDisabled()
    await expect(page.getByRole('alert')).toHaveText('并发数必须是范围内的整数。')
  }
  assert.equal(saveCalls, 0)
  const invalidResponse = await page.request.put(`http://127.0.0.1:${address.port}/api/test-execution-infrastructure-configuration/draft`, {
    data: { environments: [], concurrency: { runnerConcurrency: 2, agentConcurrency: 1.5 } },
  })
  assert.equal(invalidResponse.status(), 400)
  assert.match((await invalidResponse.json()).error, /CONCURRENCY_CONFIGURATION_INVALID/u)
  assert.equal((await service.get()).draft, null)
  await runner.fill('4')
  await agent.fill('2')
  await save.click()
  await expect(publish).toBeEnabled()
  assert.equal((await service.get()).draft?.concurrency?.runnerConcurrency, 4)
  assert.equal((await service.resolveConcurrency()).runnerConcurrency, 2)
  await publish.click()
  await expect(page.getByText('Runner 4 · Agent 2', { exact: true })).toBeVisible()
  await expect(page.getByText('已发布配置', { exact: true })).toBeVisible()

  const published = await service.resolveActive()
  failSave = true
  await runner.fill('5')
  await save.click()
  await expect(page.getByRole('alert')).toHaveText('配置数据库暂时不可用')
  await expect(runner).toHaveValue('5')
  await expect(page.getByText('Runner 4 · Agent 2', { exact: true })).toBeVisible()
  assert.deepEqual(await service.resolveActive(), published)
  assert.equal((await service.get()).draft?.concurrency?.runnerConcurrency, 4)
  await page.getByRole('button', { name: '重新读取' }).click()
  await expect(runner).toHaveValue('4')
  await expect(page.getByRole('alert')).toHaveCount(0)

  // Reload the persisted store as well as the browser to catch state-only saves.
  store = new JsonStore(database)
  await store.load()
  service = new TestExecutionInfrastructureConfigurationService(store, environment)
  await page.reload()
  await expect(runner).toHaveValue('4')
  await expect(agent).toHaveValue('2')
  await expect(page.getByText('Runner 4 · Agent 2', { exact: true })).toBeVisible()
  assert.deepEqual(await service.resolveActive(), published)
})
