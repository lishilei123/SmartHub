import assert from 'node:assert/strict'
import test from 'node:test'
import { Type } from 'typebox'
import type { ReviewRunSnapshot } from '../server/domain/agent-types.js'
import type { ToolDescriptor, ToolExecutionRequest, ToolExecutionResult } from '../server/domain/tool-types.js'
import { ToolRegistry } from '../server/tools/registry.js'
import { GovernedToolRuntime } from '../server/tools/runtime.js'

const snapshot = {} as ReviewRunSnapshot

function descriptor(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    id: 'fixed.read',
    piName: 'fixed_read',
    version: '1.0.0',
    label: '读取固定内容',
    description: 'test',
    risk: 'read',
    parameters: Type.Object({ value: Type.String() }),
    timeoutMs: 1_000,
    idempotent: true,
    ...overrides,
  }
}

function request(toolId: string, argumentsValue: unknown): ToolExecutionRequest {
  return {
    toolId,
    toolCallId: `call-${JSON.stringify(argumentsValue)}`,
    arguments: argumentsValue,
    context: { snapshot, allowedToolIds: new Set([toolId]) },
  }
}

async function execute(runtime: GovernedToolRuntime, toolId: string, argumentsValue: unknown) {
  return runtime.execute(request(toolId, argumentsValue), AbortSignal.timeout(1_000))
}

test('固定只读工具在重复阈值后只重放一次成功结果且不消耗额度', async () => {
  const registry = new ToolRegistry()
  let dispatches = 0
  registry.register(descriptor({ repeatPolicy: 'replay_success_once' }), async () => {
    dispatches += 1
    return { data: { content: 'fixed chunk', dispatches } }
  })
  const runtime = new GovernedToolRuntime(registry, { maxToolCalls: 8, maxRepeatedToolCall: 3 })

  await execute(runtime, 'fixed.read', { value: 'chunk-1' })
  await execute(runtime, 'fixed.read', { value: 'chunk-1' })
  const third = await execute(runtime, 'fixed.read', { value: 'chunk-1' })
  const replay = await execute(runtime, 'fixed.read', { value: 'chunk-1' })
  const rejected = await execute(runtime, 'fixed.read', { value: 'chunk-1' })

  assert.deepEqual(third.data, { content: 'fixed chunk', dispatches: 3 })
  assert.equal(dispatches, 3)
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.data, third.data)
  assert.equal(rejected.policyError?.code, 'REPEATED_TOOL_CALL')
  assert.equal(rejected.policyError?.retryable, false)
  assert.match(rejected.policyError?.nextAction ?? '', /不要再次提交相同参数/u)
  assert.equal(runtime.callCount, 3)
  assert.equal(runtime.remainingStandardCalls, 5)
})

test('重复指纹规范化对象键但保留数组顺序', async () => {
  const registry = new ToolRegistry()
  let dispatches = 0
  registry.register(descriptor({ repeatPolicy: 'replay_success_once' }), async () => {
    dispatches += 1
    return { data: { dispatches } }
  })
  const runtime = new GovernedToolRuntime(registry, { maxToolCalls: 6, maxRepeatedToolCall: 1 })

  await execute(runtime, 'fixed.read', { first: 'a', second: 'b' })
  const replay = await execute(runtime, 'fixed.read', { second: 'b', first: 'a' })
  await execute(runtime, 'fixed.read', { value: ['a', 'b'] })
  await execute(runtime, 'fixed.read', { value: ['b', 'a'] })

  assert.equal(replay.replayed, true)
  assert.equal(dispatches, 3)
})

test('失败、未授权重放策略与非只读工具不会返回缓存结果', async () => {
  const failedRegistry = new ToolRegistry()
  let failures = 0
  failedRegistry.register(descriptor({ repeatPolicy: 'replay_success_once' }), async () => {
    failures += 1
    throw new Error('READ_FAILED')
  })
  const failedRuntime = new GovernedToolRuntime(failedRegistry, { maxToolCalls: 8, maxRepeatedToolCall: 3 })
  await assert.rejects(() => execute(failedRuntime, 'fixed.read', { value: 'chunk-1' }), /READ_FAILED/)
  await assert.rejects(() => execute(failedRuntime, 'fixed.read', { value: 'chunk-1' }), /READ_FAILED/)
  await assert.rejects(() => execute(failedRuntime, 'fixed.read', { value: 'chunk-1' }), /READ_FAILED/)
  const failedRepeat = await execute(failedRuntime, 'fixed.read', { value: 'chunk-1' })
  assert.equal(failures, 3)
  assert.equal(failedRepeat.policyError?.code, 'REPEATED_TOOL_CALL')

  const defaultRegistry = new ToolRegistry()
  let defaultDispatches = 0
  defaultRegistry.register(descriptor(), async (): Promise<ToolExecutionResult> => {
    defaultDispatches += 1
    return { data: { defaultDispatches } }
  })
  const defaultRuntime = new GovernedToolRuntime(defaultRegistry, { maxToolCalls: 8, maxRepeatedToolCall: 3 })
  await execute(defaultRuntime, 'fixed.read', { value: 'chunk-1' })
  await execute(defaultRuntime, 'fixed.read', { value: 'chunk-1' })
  await execute(defaultRuntime, 'fixed.read', { value: 'chunk-1' })
  const defaultRepeat = await execute(defaultRuntime, 'fixed.read', { value: 'chunk-1' })
  assert.equal(defaultDispatches, 3)
  assert.equal(defaultRepeat.policyError?.code, 'REPEATED_TOOL_CALL')

  assert.throws(
    () => new ToolRegistry().register(descriptor({ risk: 'internal_write', repeatPolicy: 'replay_success_once' }), async () => ({ data: {} })),
    /重复调用策略无效/u
  )
  assert.throws(
    () => new ToolRegistry().register(descriptor({ risk: 'network_read', repeatPolicy: 'replay_success_once' }), async () => ({ data: {} })),
    /重复调用策略无效/u
  )
})
