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
