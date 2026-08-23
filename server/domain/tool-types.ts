import type { TSchema } from 'typebox'
import type {
  PlanningReviewerSnapshot,
  ReviewRunSnapshot,
  PlanningTestDesignSnapshot,
  TestExecutionAgentSnapshot,
} from './agent-types.js'

export type ToolRisk = 'read' | 'network_read' | 'code_execution' | 'internal_write' | 'write_reversible' | 'write_high_risk'
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
  snapshot:
    | ReviewRunSnapshot
    | PlanningTestDesignSnapshot
    | TestExecutionAgentSnapshot
    | PlanningReviewerSnapshot
  allowedToolIds: ReadonlySet<string>
}

export interface ToolApprovalGate {
  authorize(input: {
    runId: string
    toolId: string
    toolVersion: string
    risk: 'write_reversible' | 'write_high_risk'
    arguments: unknown
    signal: AbortSignal
  }): Promise<void>
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
  /** Optional model-facing rich content; never copied into execution-event details. */
  modelContent?: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >
  terminate?: boolean
  replayed?: boolean
  policyError?: ToolPolicyError
}

export type ToolHandler = (request: ToolExecutionRequest, signal: AbortSignal) => Promise<ToolExecutionResult>
