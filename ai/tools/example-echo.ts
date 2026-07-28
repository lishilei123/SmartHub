import type { ToolExecutionContext } from '../../server/domain/tool-types.js'

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
