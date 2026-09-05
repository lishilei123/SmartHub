import assert from 'node:assert/strict'
import test from 'node:test'
import { ExecutionResourceGovernor } from '../server/application/execution-resource-governor.js'

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

test('实际资源调用共享配额，双向独立调度，动态升降无 permit 泄漏', async () => {
  const resources = new ExecutionResourceGovernor()
  resources.configure({ agentConcurrency: 2, runnerConcurrency: 3 })
  const pending = { agent: gate(), runner: gate() }
  const starts = { agent: 0, runner: 0 }
  const work = (['agent', 'runner'] as const).flatMap(resource => Array.from({ length: 6 }, () =>
    resources.withResource(resource, new AbortController().signal, async () => {
      starts[resource] += 1
      await pending[resource].promise
    })))
  await flush()
  assert.deepEqual(resources.running, { agent: 2, runner: 3 })
  assert.deepEqual(resources.waiting, { agent: 4, runner: 3 })
  resources.configure({ agentConcurrency: 3, runnerConcurrency: 1 })
  await flush()
  assert.deepEqual(resources.running, { agent: 3, runner: 3 })
  pending.agent.release()
  await flush()
  assert.equal(starts.agent, 6)
  assert.equal(starts.runner, 3)
  pending.runner.release()
  await Promise.all(work)
  assert.equal(starts.runner, 6)
  assert.deepEqual(resources.running, { agent: 0, runner: 0 })
  assert.deepEqual(resources.waiting, { agent: 0, runner: 0 })
})

for (const reason of ['user_cancelled', 'lease_lost', 'heartbeat_unavailable', 'worker_shutdown']) {
  test(`${reason} 中断两类运行与等候调用，移除队列且不启动后续资源`, async () => {
    const resources = new ExecutionResourceGovernor()
    resources.configure({ agentConcurrency: 1, runnerConcurrency: 1 })
    const controller = new AbortController()
    const stop = new Error(reason)
    let started = 0
    const promises = (['agent', 'runner'] as const).flatMap(resource => Array.from({ length: 3 }, () =>
      resources.withResource(resource, controller.signal, async () => {
        started += 1
        await new Promise<void>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
        })
      })))
    const results = Promise.allSettled(promises)
    await flush()
    assert.deepEqual(resources.waiting, { agent: 2, runner: 2 })
    controller.abort(stop)
    for (const result of await results) {
      assert.equal(result.status, 'rejected')
      if (result.status === 'rejected') assert.equal(result.reason, stop)
    }
    assert.equal(started, 2)
    assert.deepEqual(resources.running, { agent: 0, runner: 0 })
    assert.deepEqual(resources.waiting, { agent: 0, runner: 0 })
    await assert.rejects(resources.withResource('agent', controller.signal, async () => { started += 1 }), error => error === stop)
    assert.equal(started, 2)
  })
}

test('队列有界，Agent阶段与其模型调用共享permit，异常安全释放且禁止同时持有两类配额', async () => {
  const resources = new ExecutionResourceGovernor(1)
  resources.configure({ agentConcurrency: 1, runnerConcurrency: 1 })
  const controller = new AbortController()
  const pending = gate()
  const first = resources.withResource('agent', controller.signal, async () => {
    await resources.withResource('agent', controller.signal, async () => assert.equal(resources.running.agent, 1))
    await assert.rejects(resources.withResource('runner', controller.signal, async () => undefined), /NESTED_RESERVATION_FORBIDDEN/)
    await pending.promise
  })
  await flush()
  const second = resources.withResource('agent', controller.signal, async () => { throw new Error('original failure') })
  const failure = assert.rejects(second, /original failure/)
  await assert.rejects(resources.withResource('agent', controller.signal, async () => undefined), /RESOURCE_QUEUE_FULL/)
  await resources.withResource('runner', controller.signal, async () => assert.equal(resources.running.runner, 1))
  pending.release()
  await Promise.all([first, failure])
  assert.deepEqual(resources.running, { agent: 0, runner: 0 })
  assert.deepEqual(resources.waiting, { agent: 0, runner: 0 })
})

test('首次调用读取后端配置，配置等待可取消并合并并发查询', async () => {
  const resources = new ExecutionResourceGovernor()
  const read = gate()
  let reads = 0
  let calls = 0
  resources.setConfigurationReader(async () => {
    reads += 1
    await read.promise
    return { agentConcurrency: 2, runnerConcurrency: 1 }
  })
  const controller = new AbortController()
  const stopped = new Error('lease_lost')
  const first = resources.withResource('agent', controller.signal, async () => { calls += 1 })
  const rejection = assert.rejects(first, error => error === stopped)
  const second = resources.withResource('runner', new AbortController().signal, async () => { calls += 1 })
  await flush()
  assert.equal(reads, 1)
  controller.abort(stopped)
  await rejection
  assert.equal(calls, 0)
  read.release()
  await second
  assert.equal(calls, 1)
  assert.deepEqual(resources.running, { agent: 0, runner: 0 })
})
