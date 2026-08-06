import type { ToolExecutionContext } from '../../server/domain/tool-types.js'

export const tool = {
  key: 'example.echo',
  name: '外置 Echo 示例',
  description: '演示 ai/tools 单文件外置模块的自动扫描、登记与重载。',
  version: '1.1.0',
  risk: 'read',
  timeoutMs: 5000,
} as const

export const parameters = {
  type: 'object',
  additionalProperties: false,
  required: ['message'],
  properties: { message: { type: 'string', description: '要原样返回的文本。' } },
}

export async function execute(argumentsValue: unknown, context: ToolExecutionContext, signal: AbortSignal) {
  signal.throwIfAborted()
  const message = String((argumentsValue as { message?: unknown } | null)?.message ?? '')
  return { data: { message, runId: context.snapshot.runId } }
}
