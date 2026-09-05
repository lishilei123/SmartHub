import assert from 'node:assert/strict'
import test from 'node:test'
import { ExecutionResourceScheduler } from '../server/application/execution-resource-scheduler.js'
import type { ExecutionResourceClass } from '../server/domain/test-execution-types.js'

const flush = () => new Promise<void>(resolve => setImmediate(resolve))

test('容量在领取前预留；Agent 堵塞不阻止成熟 Runner，Runner 堵塞不阻止 Agent', async () => {
  const starts: ExecutionResourceClass[] = []
  const pending = { runner: [] as Array<() => void>, agent: [] as Array<() => void> }
  const scheduler = new ExecutionResourceScheduler(async resource => {
    starts.push(resource)
    await new Promise<void>(resolve => pending[resource].push(resolve))
    return true
  }, error => { throw error })
  assert.deepEqual(scheduler.configuration, { runnerConcurrency: 3, agentConcurrency: 1 })
  scheduler.tick()
  scheduler.tick()
  await flush()
  assert.deepEqual(scheduler.running, { runner: 3, agent: 1 })
  assert.equal(starts.length, 4)
  pending.runner.shift()!()
  await flush()
  scheduler.tick()
  await flush()
  assert.equal(starts.filter(value => value === 'runner').length, 4)
  assert.equal(starts.filter(value => value === 'agent').length, 1)
  pending.agent.shift()!()
  await flush()
  scheduler.tick()
  await flush()
  assert.equal(starts.filter(value => value === 'agent').length, 2)
  const stopped = scheduler.stop()
  pending.runner.forEach(resolve => resolve())
  pending.agent.forEach(resolve => resolve())
  await stopped
  scheduler.tick()
  assert.deepEqual(scheduler.running, { runner: 0, agent: 0 })
})

test('已发布配置动态升降容量，降低不打断已开始任务，读取失败保留有效值', async () => {
  const pending: Array<() => void> = []
  const errors: unknown[] = []
  const scheduler = new ExecutionResourceScheduler(async () => {
    await new Promise<void>(resolve => pending.push(resolve))
    return true
  }, error => errors.push(error))
  await scheduler.refresh(async () => ({ runnerConcurrency: 1, agentConcurrency: 1 }))
  scheduler.tick()
  await flush()
  assert.deepEqual(scheduler.running, { runner: 1, agent: 1 })
  await scheduler.refresh(async () => ({ runnerConcurrency: 4, agentConcurrency: 2 }))
  scheduler.tick()
  await flush()
  assert.deepEqual(scheduler.running, { runner: 4, agent: 2 })
  await scheduler.refresh(async () => ({ runnerConcurrency: 1, agentConcurrency: 1 }))
  scheduler.tick()
  assert.deepEqual(scheduler.running, { runner: 4, agent: 2 })
  assert.equal(await scheduler.refresh(async () => { throw new Error('database unavailable') }), false)
  assert.equal(await scheduler.refresh(async () => ({ runnerConcurrency: 99, agentConcurrency: 1 })), false)
  assert.equal(errors.length, 2)
  assert.deepEqual(scheduler.configuration, { runnerConcurrency: 1, agentConcurrency: 1 })
  pending.splice(0).forEach(resolve => resolve())
  await flush()
  scheduler.tick()
  await flush()
  assert.deepEqual(scheduler.running, { runner: 1, agent: 1 })
  const stopped = scheduler.stop()
  pending.forEach(resolve => resolve())
  await stopped
})
