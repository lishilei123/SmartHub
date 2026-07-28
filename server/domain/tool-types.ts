import type { TSchema } from 'typebox'
import type { ReviewRunSnapshot } from './agent-types.js'

export type ToolRisk = 'read' | 'network_read' | 'code_execution' | 'internal_write'
export type ToolRepeatPolicy = 'replay_success_once'

export interface ToolDescriptor {
  id: string
  piName: string
  version: string
  label: string
  description: string
  risk: ToolRisk
  parameters: TSchema
  timeoutMs: number
  idempotent: boolean
  repeatPolicy?: ToolRepeatPolicy
}

export interface ToolExecutionContext {
  snapshot: ReviewRunSnapshot
  allowedToolIds: ReadonlySet<string>
}

export interface ToolExecutionRequest {
  toolId: string
  toolCallId: string
  arguments: unknown
  context: ToolExecutionContext
}

export interface ToolPolicyError {
  code: 'REPEATED_TOOL_CALL'
  retryable: false
  toolId: string
  nextAction: string
}

export interface ToolExecutionResult {
  data: unknown
  terminate?: boolean
  replayed?: boolean
  policyError?: ToolPolicyError
}

export type ToolHandler = (request: ToolExecutionRequest, signal: AbortSignal) => Promise<ToolExecutionResult>
