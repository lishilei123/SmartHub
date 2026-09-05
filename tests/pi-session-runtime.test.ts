import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PiSessionRuntime } from '../server/agent/pi-session-runtime.js'
import { LocalExecutionWorkspaceStore } from '../server/infrastructure/execution-workspace-store.js'

function executionScope(runtime: PiSessionRuntime, taskId: string, agentKey: 'execution-implementation' | 'failure-analysis', executionSessionKey: string) {
  return runtime.scopeFor({
    snapshot: {
      runId: 'run-1',
      taskId,
      projectId: 'project-1',
      projectVersionId: 'project-version-1',
      agentDefinition: { agentKey },
      executionSessionKey,
    },
  })
}

test('同一个 Run 中不同 ExecutionTask 使用不同 Agent Session scope', () => {
  const runtime = PiSessionRuntime.inMemory()
  const first = executionScope(runtime, 'task-a', 'execution-implementation', 'execution-implementation:run-1:task-a')
  const second = executionScope(runtime, 'task-b', 'execution-implementation', 'execution-implementation:run-1:task-b')
  assert.equal(first.key, 'execution-implementation:run-1:task-a')
  assert.equal(second.key, 'execution-implementation:run-1:task-b')
  assert.notEqual(first.key, second.key)
})

test('同一 ExecutionTask 的 generation 与 repair 复用实现 Session，diagnosis 按 Revision 独立', () => {
  const runtime = PiSessionRuntime.inMemory()
  const scopes = [
    executionScope(runtime, 'task-a', 'execution-implementation', 'execution-implementation:run-1:task-a'),
    executionScope(runtime, 'task-a', 'failure-analysis', 'execution-diagnosis:run-1:task-a:revision-1'),
    executionScope(runtime, 'task-a', 'execution-implementation', 'execution-implementation:run-1:task-a'),
  ]
  assert.deepEqual(scopes.map(scope => scope.key), [
    'execution-implementation:run-1:task-a',
    'execution-diagnosis:run-1:task-a:revision-1',
    'execution-implementation:run-1:task-a',
  ])
})

test('Agent Session 按 Task 隔离时仍共享同一个 ProjectVersion Execution Workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smarthub-session-workspace-'))
  try {
    const store = new LocalExecutionWorkspaceStore(root)
    const first = await store.ensure('project-version-1')
    const second = await store.ensure('project-version-1')
    assert.equal(first, second)
    assert.notEqual(
      executionScope(PiSessionRuntime.inMemory(), 'task-a', 'execution-implementation', 'execution-implementation:run-1:task-a').key,
      executionScope(PiSessionRuntime.inMemory(), 'task-b', 'execution-implementation', 'execution-implementation:run-1:task-b').key,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('取消 Session 排队立即退出，并保留前序锁与后续顺序，结束后无残留等待', async () => {
  const runtime = PiSessionRuntime.inMemory()
  const scope = executionScope(runtime, 'task-abort', 'execution-implementation', 'execution:abort')
  const first = await runtime.acquire(scope)
  const controller = new AbortController()
  const reason = new Error('lease lost while waiting for session')
  const cancelled = runtime.acquire(scope, controller.signal)
  const rejected = assert.rejects(cancelled, error => error === reason)
  let thirdStarted = false
  const third = runtime.acquire(scope).then(lease => { thirdStarted = true; return lease })
  controller.abort(reason)
  await rejected
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(thirdStarted, false, 'Cancelling a waiter must not release the active session owner')
  await assert.rejects(runtime.acquireIdle(scope), /PI_SESSION_BUSY/)
  first.release()
  const thirdLease = await third
  let fourthStarted = false
  const fourth = runtime.acquire(scope).then(lease => { fourthStarted = true; return lease })
  first.release()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(fourthStarted, false, 'Repeated release must not unlock a later owner')
  thirdLease.release()
  const fourthLease = await fourth
  fourthLease.release()
  const idle = await runtime.acquireIdle(scope)
  idle.release()
})

test('预先取消与获得 Session 锁期间取消均不创建或遗留锁', async () => {
  const runtime = PiSessionRuntime.inMemory()
  const scope = executionScope(runtime, 'task-aborted', 'execution-implementation', 'execution:aborted')
  const controller = new AbortController()
  const reason = new Error('worker shutdown')
  controller.abort(reason)
  await assert.rejects(runtime.acquire(scope, controller.signal), error => error === reason)
  const idle = await runtime.acquireIdle(scope)
  idle.release()
  const racing = new AbortController()
  const acquisition = runtime.acquire(scope, racing.signal)
  const rejected = assert.rejects(acquisition, error => error === reason)
  racing.abort(reason)
  await rejected
  const next = await runtime.acquireIdle(scope)
  next.release()
})
