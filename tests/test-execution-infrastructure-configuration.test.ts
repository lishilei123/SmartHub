import assert from 'node:assert/strict'
import test from 'node:test'
import { TestExecutionInfrastructureConfigurationService } from '../server/application/test-execution-infrastructure-configuration-service.js'
import { ServerConfiguredExecutionEnvironmentCatalog } from '../server/application/test-execution-environment.js'
import { JsonStore } from '../server/infrastructure/store.js'

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
