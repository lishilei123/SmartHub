import type { TSchema } from 'typebox'
import type { ReviewRunSnapshot } from './agent-types.js'

export type ToolRisk = 'read' | 'network_read' | 'internal_write'

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

export interface ToolExecutionResult {
  data: unknown
  terminate?: boolean
}

export type ToolHandler = (request: ToolExecutionRequest, signal: AbortSignal) => Promise<ToolExecutionResult>
