import assert from 'node:assert/strict'
import test from 'node:test'
import { TestExecutionInfrastructureConfigurationService } from '../server/application/test-execution-infrastructure-configuration-service.js'
import { ServerConfiguredExecutionEnvironmentCatalog } from '../server/application/test-execution-environment.js'
import { JsonStore } from '../server/infrastructure/store.js'
import { loadExecutionInfrastructureConfiguration, saveExecutionInfrastructureDraft, publishExecutionInfrastructureDraft } from '../src/test-execution-infrastructure-api.js'

const runner = {
  containerRuntime: 'docker' as const,
  runnerVersion: '1.0.0',
  playwrightVersion: '1.58.2',
  imageReference: 'registry.example/smarthub/playwright-runner',
  imageDigest: `sha256:${'a'.repeat(64)}`,
}

const environment = {
  environmentId: 'sit-web',
  name: 'SIT Web',
  baseUrl: 'https://sit.example.test/',
  targets: [{ protocol: 'https' as const, host: 'sit.example.test', port: 443 }],
  networkName: 'smarthub-sit',
  secretEnvironmentVariables: { SMARTHUB_SECRET_TOKEN: 'SIT_TOKEN' },
}

test('执行基础设施由服务端发布不可变版本，环境运行时只读取当前版本', async () => {
  const store = new JsonStore(null); await store.load()
  const service = new TestExecutionInfrastructureConfigurationService(store)
  assert.equal((await service.get()).activeVersion, null)

  const first = await service.publish({ expectedActiveVersion: null, environments: [environment], runner }, '执行管理员')
  assert.equal(first.version, 1)
  assert.equal(first.status, 'active')
  assert.match(first.contentSha256, /^[a-f0-9]{64}$/u)
  assert.equal(JSON.stringify(first).includes('SIT_TOKEN'), true)
  assert.equal(JSON.stringify(first).includes('secret-value'), false)

  const catalog = new ServerConfiguredExecutionEnvironmentCatalog(service)
  assert.deepEqual(await catalog.readiness(), { ready: false, reason: 'TEST_EXECUTION_ENVIRONMENT_SECRETS_UNAVAILABLE' })
  assert.deepEqual(await catalog.listSnapshots(), [{
    environmentId: environment.environmentId,
    name: environment.name,
    baseUrl: environment.baseUrl,
    targets: environment.targets,
    signature: (await catalog.listSnapshots())[0]!.signature,
  }])

  const second = await service.publish({ expectedActiveVersion: first.version, environments: [environment] }, '执行管理员')
  assert.equal(second.version, 2)
  assert.equal((await service.resolveVersion(first.id)).status, 'superseded')
  assert.equal((await service.resolveActive())?.id, second.id)
  await assert.rejects(
    service.publish({ expectedActiveVersion: first.version, environments: [environment] }, '执行管理员'),
    /TEST_EXECUTION_INFRASTRUCTURE_CONFIGURATION_VERSION_CONFLICT/u,
  )
})

test('执行基础设施拒绝不安全 Runner 镜像和未声明目标的环境', async () => {
  const store = new JsonStore(null); await store.load()
  const service = new TestExecutionInfrastructureConfigurationService(store)
  await assert.rejects(
    service.publish({ expectedActiveVersion: null, environments: [{ ...environment, baseUrl: 'https://foreign.example.test/' }], runner }, '执行管理员'),
    /TEST_EXECUTION_ENVIRONMENT_BASE_URL_NOT_ALLOWED/u,
  )
  await assert.rejects(
    service.publish({ expectedActiveVersion: null, environments: [environment], runner: { ...runner, imageDigest: 'latest' } }, '执行管理员'),
    /TEST_EXECUTION_RUNNER_IMAGE_DIGEST_INVALID/u,
  )
})

test('并发默认值、历史版本兼容及定向 Worker 读取不修改历史内容', async () => {
  const store = new JsonStore(null); await store.load()
  const service = new TestExecutionInfrastructureConfigurationService(store)
  assert.deepEqual(await service.resolveConcurrency(), { runnerConcurrency: 3, agentConcurrency: 1, source: 'code_defaults', version: null, publishedAt: null, publishedBy: null })
  await store.transaction(state => { state.testExecutionInfrastructureConfigurationVersions.push({
    id: 'historic', version: 1, status: 'active', environments: [], contentSha256: 'a'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z', publishedBy: '旧管理员',
  }) })
  const before = await service.resolveVersion('historic')
  store.snapshot = async () => { throw new Error('Full database snapshot forbidden during polling') }
  store.listTestExecutionInfrastructureConfigurationVersions = async () => { throw new Error('History scan forbidden during polling') }
  assert.deepEqual(await service.resolveConcurrency(), { runnerConcurrency: 3, agentConcurrency: 1, source: 'historical_defaults', version: 1, publishedAt: before.createdAt, publishedBy: '旧管理员' })
  assert.deepEqual(await store.getActiveTestExecutionInfrastructureConfiguration(), before)
})

test('并发草稿保存不会生效，发布后 Worker 读取新版本且旧版本内容保持不变', async () => {
  const store = new JsonStore(null); await store.load()
  const service = new TestExecutionInfrastructureConfigurationService(store)
  const draft = await service.saveDraft({ environments: [], concurrency: { runnerConcurrency: 8, agentConcurrency: 2 } }, '保存人')
  assert.equal((await service.resolveConcurrency()).runnerConcurrency, 3)
  assert.equal((await service.get()).draft?.updatedBy, '保存人')
  const first = await service.publishDraft({ revision: draft.revision }, '发布人')
  assert.equal((await service.resolveConcurrency()).runnerConcurrency, 8)
  assert.equal((await service.resolveConcurrency()).publishedBy, '发布人')
  await assert.rejects(service.publishDraft({ revision: draft.revision }, '过期页面'), /DRAFT_CONFLICT/u)
  const persistedDraft = (await service.get()).draft!
  const secondDraft = await service.saveDraft({ expectedActiveVersion: first.version, expectedDraftRevision: persistedDraft.revision, environments: [], concurrency: { runnerConcurrency: 1, agentConcurrency: 8 } }, '保存人')
  await service.publishDraft({ revision: secondDraft.revision, expectedActiveVersion: first.version }, '发布人')
  assert.deepEqual(await service.resolveVersion(first.id), { ...first, status: 'superseded' })
  assert.equal((await service.resolveConcurrency()).agentConcurrency, 8)
})

test('旧执行并发仅为迁移兜底，数据库显式配置优先，旧客户端保存不重置有效配置', async () => {
  const store = new JsonStore(null); await store.load()
  const environment = { SMARTHUB_TEST_EXECUTION_CONCURRENCY: '2' }
  const service = new TestExecutionInfrastructureConfigurationService(store, environment)
  assert.deepEqual(await service.resolveConcurrency(), {
    runnerConcurrency: 2, agentConcurrency: 1, source: 'legacy_environment', version: null, publishedAt: null, publishedBy: null,
  })
  assert.equal((await service.get()).effectiveConcurrency.runnerConcurrency, 2)
  const first = await service.publish({ environments: [], concurrency: { runnerConcurrency: 5, agentConcurrency: 3 } }, '管理员')
  environment.SMARTHUB_TEST_EXECUTION_CONCURRENCY = '8'
  assert.equal((await service.resolveConcurrency()).source, 'published_configuration')
  const draft = await service.saveDraft({ environments: [], expectedActiveVersion: first.version }, '旧客户端')
  assert.deepEqual(draft.concurrency, { runnerConcurrency: 5, agentConcurrency: 3 })
  await service.publishDraft({ revision: draft.revision, expectedActiveVersion: first.version }, '管理员')
  assert.equal((await service.resolveConcurrency()).runnerConcurrency, 5)
  assert.deepEqual(await service.resolveVersion(first.id), { ...first, status: 'superseded' })
})

test('无效旧并发环境变量不阻止默认配置读取，历史版本迁移不改写Hash', async () => {
  const store = new JsonStore(null); await store.load()
  for (const legacy of ['', 'bad', '0', '1.5', '9']) {
    const service = new TestExecutionInfrastructureConfigurationService(store, { SMARTHUB_TEST_EXECUTION_CONCURRENCY: legacy })
    assert.equal((await service.resolveConcurrency()).runnerConcurrency, 3)
    assert.equal((await service.resolveConcurrency()).source, 'code_defaults')
  }
  const historic = { id: 'legacy', version: 1, status: 'active' as const, environments: [], contentSha256: 'b'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z', publishedBy: '旧管理员' }
  await store.transaction(state => { state.testExecutionInfrastructureConfigurationVersions.push(historic) })
  const service = new TestExecutionInfrastructureConfigurationService(store, { SMARTHUB_TEST_EXECUTION_CONCURRENCY: '2' })
  assert.equal((await service.resolveConcurrency()).source, 'legacy_environment')
  assert.equal((await service.resolveConcurrency()).runnerConcurrency, 2)
  assert.deepEqual(await service.resolveVersion(historic.id), historic)
})

test('并发配置拒绝越界、小数、字符串和陈旧草稿写入', async () => {
  const store = new JsonStore(null); await store.load()
  const service = new TestExecutionInfrastructureConfigurationService(store)
  for (const concurrency of [
    { runnerConcurrency: 0, agentConcurrency: 1 }, { runnerConcurrency: 17, agentConcurrency: 1 },
    { runnerConcurrency: 1, agentConcurrency: 0 }, { runnerConcurrency: 1, agentConcurrency: 9 },
    { runnerConcurrency: 1.5, agentConcurrency: 1 }, { runnerConcurrency: '3', agentConcurrency: 1 },
  ]) await assert.rejects(service.saveDraft({ environments: [], concurrency: concurrency as never }, '管理员'), /CONCURRENCY_CONFIGURATION_INVALID/u)
  await service.saveDraft({ environments: [] }, '管理员')
  await assert.rejects(service.saveDraft({ environments: [] }, '旧页面'), /DRAFT_CONFLICT/u)
})

test('页面使用的配置 API 完成草稿保存和正式发布，并保留发布时间与发布人', async t => {
  const store = new JsonStore(null); await store.load()
  const service = new TestExecutionInfrastructureConfigurationService(store)
  // Exercise the real frontend API serialization against the real configuration Service.
  const paths: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    paths.push(url)
    const input = init?.body ? JSON.parse(String(init.body)) : null
    const value = url.endsWith('/draft') ? await service.saveDraft(input, '页面管理员')
      : url.endsWith('/publish') ? await service.publishDraft(input, '页面管理员') : await service.get()
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  assert.equal((await loadExecutionInfrastructureConfiguration()).effectiveConcurrency.runnerConcurrency, 3)
  const draft = await saveExecutionInfrastructureDraft({ environments: [], concurrency: { runnerConcurrency: 16, agentConcurrency: 8 } })
  const published = await publishExecutionInfrastructureDraft({ revision: draft.revision })
  const current = await loadExecutionInfrastructureConfiguration()
  assert.equal(current.activeVersion?.id, published.id)
  assert.equal(current.effectiveConcurrency.runnerConcurrency, 16)
  assert.equal(current.effectiveConcurrency.agentConcurrency, 8)
  assert.equal(current.effectiveConcurrency.publishedBy, '页面管理员')
  assert.equal(current.effectiveConcurrency.publishedAt, published.createdAt)
  assert.equal(paths.includes('/api/test-execution-infrastructure-configuration/draft'), true)
  assert.equal(paths.includes('/api/test-execution-infrastructure-configuration/publish'), true)
})
