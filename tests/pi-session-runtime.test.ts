import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PiSessionRuntime } from '../server/agent/pi-session-runtime.js'
import { LocalExecutionWorkspaceStore } from '../server/infrastructure/execution-workspace-store.js'

function executionScope(runtime: PiSessionRuntime, taskId: string, agentKey: string) {
  return runtime.scopeFor({
    snapshot: {
      runId: 'run-1',
      taskId,
      projectId: 'project-1',
      projectVersionId: 'project-version-1',
      agentDefinition: { agentKey },
    },
  })
}

test('同一个 Run 中不同 ExecutionTask 使用不同 Agent Session scope', () => {
  const runtime = PiSessionRuntime.inMemory()
  const first = executionScope(runtime, 'task-a', 'test-script')
  const second = executionScope(runtime, 'task-b', 'test-script')
  assert.equal(first.key, 'execution:run-1:task-a')
  assert.equal(second.key, 'execution:run-1:task-b')
  assert.notEqual(first.key, second.key)
})

test('同一 ExecutionTask 的 generation diagnosis repair 复用同一个 Session scope', () => {
  const runtime = PiSessionRuntime.inMemory()
  const scopes = ['test-script', 'failure-analysis', 'script-repair']
    .map(agentKey => executionScope(runtime, 'task-a', agentKey))
  assert.deepEqual(scopes.map(scope => scope.key), [
    'execution:run-1:task-a',
    'execution:run-1:task-a',
    'execution:run-1:task-a',
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
      executionScope(PiSessionRuntime.inMemory(), 'task-a', 'test-script').key,
      executionScope(PiSessionRuntime.inMemory(), 'task-b', 'test-script').key,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
