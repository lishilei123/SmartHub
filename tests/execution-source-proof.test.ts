import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import { buildExecutionPackage, freezeExecutionTaskInput } from '../server/application/test-execution-validation.js'
import type { TestCaseContent } from '../server/domain/test-design-types.js'

function build(body: string, options: { method?: 'ui' | 'api'; expected?: string; steps?: string[]; prefix?: string; files?: Array<{ path: string; content: string }> } = {}) {
  const method = options.method ?? 'ui'
  const content: TestCaseContent = {
    schemaVersion: 'test-case/v3', title: '执行验证', dimension: 'functional', requirementRefs: ['requirement'], priority: 'P1',
    preconditions: [], executionMethods: [method], steps: options.steps ?? ['查看页面'], expectedResults: [options.expected ?? '显示 Ready'],
  }
  const hash = canonicalSha256(content)
  const task = freezeExecutionTaskInput({
    libraryMember: { caseId: 'case-proof', revision: 1, ordinal: 0, contentSha256: hash, frozenContent: content, executionReadiness: 'ready' },
    handoffMember: { caseId: 'case-proof', revision: 1, ordinal: 0, stage: 'smoke', sourceVersionId: 'library-1', method, reason: '验证', dedupKey: 'case-proof', contentSha256: hash, executionSpec: { schemaVersion: 'test-script-input/v1', method, testCase: content } },
  })
  const entryFile = `tests/${method}/proof.spec.ts`
  return buildExecutionPackage({
    candidate: { entryFile, files: [{ path: entryFile, content: `import { test, expect } from '@playwright/test'\n${options.prefix ?? ''}\ntest('验证 [case-proof]', async ({ ${method === 'ui' ? 'page' : 'request'} }) => {\n${body}\n})` }] },
    workspaceFiles: options.files ?? [], task: { ...task, taskId: 'task-proof' }, environmentSignature: 'frozen-env',
  })
}

const uiAssertion = `// smarthub:assert expected-1
await expect(page.getByRole('status')).toHaveText('Ready')`

test('业务 URL 输入、冻结数据字段、响应字段和断言值不会被当成网络目标', () => {
  assert.doesNotThrow(() => build(`await page.goto('/')
const frozenData = { website: 'https://company.example/profile' }
const links = new Map([['https://company.example/profile', 'company']])
expect(links.get('https://company.example/profile')).toBe('company')
await page.getByLabel('网站').fill(frozenData.website)
// smarthub:assert expected-1
await expect(page.getByLabel('网站')).toHaveValue('https://company.example/profile')`))
  assert.doesNotThrow(() => build(`const response = await test.step('GET /profile', () => request.get('/profile'))
const profile = await response.json()
// smarthub:assert expected-1
expect(profile.website).toBe('https://company.example/profile')`, { method: 'api' }))
})

test('实际绝对请求目标与脱离受管 Browser 的调用继续拒绝', () => {
  for (const navigation of ["await page.goto('https://untrusted.example/')", "await page.goto('//untrusted.example/')", 'await page.context().browser().browserType().launch()']) {
    assert.throws(() => build(`${navigation}\n${uiAssertion}`), /实际网络请求|受管 Playwright/u)
  }
  assert.throws(() => build(`await request.get('https://untrusted.example/api')\n// smarthub:assert expected-1\nexpect(true).toBeTruthy()`, { method: 'api' }), /实际网络请求/u)
})

test('直接导航、真实调用的导入 helper 和 Page Object 支持相同页面断言', () => {
  assert.doesNotThrow(() => build(`await page.goto('/')\n${uiAssertion}`))
  assert.doesNotThrow(() => build(`await openStatus(page)\n${uiAssertion}`, {
    prefix: "import { openStatus } from '../../helpers/navigation'",
    files: [{ path: 'helpers/navigation.ts', content: "export async function openStatus(page) { await page.goto('/status') }" }],
  }))
  for (const constructor of ['constructor(private page: Page) {}', 'constructor(page: Page) { this.page = page }']) {
    assert.doesNotThrow(() => build(`const status = new StatusPage(page)\nawait status.open()\n${uiAssertion}`, {
      prefix: "import { StatusPage } from '../../pages/status'",
      files: [{ path: 'pages/status.ts', content: `import type { Page } from '@playwright/test'; export class StatusPage { ${constructor} async open() { await this.page.goto('/status') } }` }],
    }))
  }
})

test('未调用、不可达、未等待和动态分派的导航不能证明已完成 UI 导航', () => {
  for (const navigation of [
    "async function unused() { await page.goto('/') }",
    "if (false) { await page.goto('/') }",
    "return; await page.goto('/')",
    "page.goto('/')",
    "async function open() { await page.goto('/') }; open()",
    "async function open() { if (false) { await page.goto('/') } }; await open()",
    "const method = 'goto'; await page[method]('/')",
    "page.goto = async () => {}; await page.goto('/')",
    "Object.assign(page, { goto: async () => {} }); await page.goto('/')",
  ]) assert.throws(() => build(`${navigation}\n${uiAssertion}`), /无法证明|依赖闭包/u)
  assert.throws(() => build(`await page.goto('/')\n// smarthub:assert expected-1\nexpect(true).toBeTruthy()`), /真实页面断言/u)
})

test('当前无法静态证明 fixture 导航时给出明确不支持诊断', () => {
  assert.throws(() => build(uiAssertion, {
    prefix: "import { navigationReady } from '../../fixtures/navigation'",
    files: [{ path: 'fixtures/navigation.ts', content: "export async function navigationReady(page) { await page.goto('/') }" }],
  }), /不支持.*fixture/u)
  for (const fixtures of ["{ page: async ({}, use) => use({ goto: async () => {}, getByRole: () => 'Ready' }) }", '{ ...overrides }', 'overrides']) {
    assert.throws(() => build(`await page.goto('/')\n${uiAssertion}`, {
      prefix: "import { customTest } from '../../fixtures/navigation'",
      files: [{ path: 'fixtures/navigation.ts', content: `import { test } from '@playwright/test'; export const customTest = test.extend(${fixtures})` }],
    }), /不支持.*fixture/u)
  }
})

test('只读不存在资源与仍然只读的查询不要求写操作', () => {
  assert.doesNotThrow(() => build(`const response = await request.get('/missing')
// smarthub:assert expected-1
expect(response.status()).toBe(404)`, { method: 'api', steps: ['查询不存在的资源'], expected: '资源仍然不存在，返回 HTTP 404' }))
})

test('明确持久化要求需要真实回读来源绑定对应断言，不能用同名假 helper 或旧响应代替', () => {
  const options = { method: 'api' as const, steps: ['执行操作'], expected: '修改后重新查询仍保持 done' }
  const mutation = "const changed = await test.step('PATCH /status', () => request.patch('/status', { data: { status: 'done' } }))"
  const read = "const persisted = await test.step('GET /status', () => request.get('/status'))"
  const assertion = (value: string) => `// smarthub:assert expected-1\nexpect(await ${value}.json()).toMatchObject({ status: 'done' })`
  assert.doesNotThrow(() => build(`${mutation}\n${read}\n${assertion('persisted')}`, options))
  assert.throws(() => build(`${mutation}\n${assertion('changed')}`, options), /持久化/u)
  assert.throws(() => build(`${mutation}\n${read}\n${assertion('changed')}`, options), /持久化/u)
  assert.throws(() => build(`${mutation}\nasync function query() { return changed }; const persisted = await test.step('GET /status', () => query())\n${assertion('persisted')}`, options), /持久化/u)
  assert.throws(() => build(`${mutation}\nasync function unused() { await request.get('/status') }\n${assertion('changed')}`, options), /持久化/u)
})

test('受管 API helper 回读保留实际 APIRequestContext 与响应来源的关联', () => {
  assert.doesNotThrow(() => build(`await request.patch('/status', { data: { status: 'done' } })
const persisted = await test.step('GET /status', () => readStatus(request))
// smarthub:assert expected-1
expect(await persisted.json()).toMatchObject({ status: 'done' })`, {
    method: 'api', steps: ['修改状态'], expected: '重新查询后仍保持 done', prefix: "import { readStatus } from '../../helpers/status'",
    files: [{ path: 'helpers/status.ts', content: "export async function readStatus(request) { return request.get('/status') }" }],
  }))
})

test('受管 Page Object 刷新后允许复用 Locator，但拒绝刷新前读取的旧值', () => {
  const options = { steps: ['修改状态'], expected: '修改后刷新仍保持 Ready', prefix: "import { StatusPage } from '../../pages/status'", files: [{ path: 'pages/status.ts', content: "export class StatusPage { constructor(private page) {} async refresh() { await this.page.reload() } }" }] }
  const setup = "await page.goto('/'); const status = new StatusPage(page); await page.getByRole('button').click();"
  assert.doesNotThrow(() => build(`${setup}\nconst locator = page.getByRole('status'); await status.refresh();\n// smarthub:assert expected-1\nawait expect(locator).toHaveText('Ready')`, options))
  assert.throws(() => build(`${setup}\nconst oldText = await page.getByRole('status').innerText(); await status.refresh();\n// smarthub:assert expected-1\nexpect(oldText).toBe('Ready')`, options), /持久化/u)
})
