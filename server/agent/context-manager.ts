import {
  estimateTokens,
  sessionEntryToContextMessages,
  type AgentSession,
  type AgentSessionEvent,
  type CompactionResult,
  type ContextUsage,
} from '@earendil-works/pi-coding-agent'
import type {
  AgentExecutionContext,
  AgentExecutionEvent,
} from '../domain/agent-types.js'
import type { PiSessionScope } from './pi-session-runtime.js'

export type PlanningCompactionCheckpoint =
  | 'requirement_analysis_completed'
  | 'before_test_case_design'
  | 'test_case_design_completed'
  | 'coverage_repair_completed'

export class ContextManager {
  private readonly pendingCheckpoints = new Map<
    string,
    PlanningCompactionCheckpoint
  >()

  constructor(private readonly proactiveThresholdPercent = 78) {}

  profile() {
    return {
      proactiveThresholdPercent:
        this.proactiveThresholdPercent,
      checkpoints: [
        'requirement_analysis_completed',
        'before_test_case_design',
        'test_case_design_completed',
        'coverage_repair_completed',
      ] as PlanningCompactionCheckpoint[],
    }
  }

  queueCheckpoint(
    scopeKey: string,
    checkpoint: PlanningCompactionCheckpoint,
  ) {
    this.pendingCheckpoints.set(scopeKey, checkpoint)
  }

  async consumeCheckpoint(
    session: AgentSession,
    scopeKey: string,
  ) {
    const checkpoint = this.pendingCheckpoints.get(scopeKey)
    if (!checkpoint) return undefined
    this.pendingCheckpoints.delete(scopeKey)
    return this.compactAtCheckpoint(session, checkpoint)
  }

  describe(session: AgentSession, scope: PiSessionScope): AgentExecutionContext {
    const usage = session.getContextUsage()
    const entries = session.sessionManager.getBranch()
    const compactions = entries.filter(entry => entry.type === 'compaction')
    const lastCompaction = compactions.at(-1)
    const stats = session.getSessionStats()
    return {
      sessionId: session.sessionId,
      ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
      sessionRole: scope.role,
      ...(scope.parentKey ? { parentSessionKey: scope.parentKey } : {}),
      contextWindow: usage?.contextWindow ?? session.model?.contextWindow ?? 0,
      currentTokens: usage?.tokens ?? null,
      usagePercent: usage?.percent ?? null,
      compactionCount: compactions.length,
      ...(lastCompaction ? { lastCompactionAt: lastCompaction.timestamp } : {}),
      totalMessages: stats.totalMessages,
      autoCompactionEnabled: session.autoCompactionEnabled,
    }
  }

  usageEvent(session: AgentSession, scope: PiSessionScope): Omit<AgentExecutionEvent, 'sequence' | 'occurredAt'> {
    return {
      type: 'context_usage',
      context: this.describe(session, scope),
    }
  }

  sessionEvent(event: AgentSessionEvent, session: AgentSession, scope: PiSessionScope): Omit<AgentExecutionEvent, 'sequence' | 'occurredAt'> | undefined {
    if (event.type === 'compaction_start') {
      return {
        type: 'compaction_started',
        context: this.describe(session, scope),
        compaction: { reason: event.reason },
      }
    }
    if (event.type === 'compaction_end') {
      return {
        type: 'compaction_completed',
        isError: Boolean(event.errorMessage),
        ...(event.errorMessage ? { content: event.errorMessage } : {}),
        context: this.describe(session, scope),
        compaction: this.compactionProjection(event.reason, event.result, event.aborted, event.willRetry),
      }
    }
    return undefined
  }

  shouldCompact(session: AgentSession) {
    const usage = session.getContextUsage()
    return usage?.percent != null && usage.percent >= this.proactiveThresholdPercent
  }

  async compactAtCheckpoint(session: AgentSession, checkpoint: PlanningCompactionCheckpoint) {
    if (!this.shouldCompact(session)) return undefined
    return this.compactWithBoundary(
      session,
      protectedCompactionInstructions('manual', `当前检查点：${checkpoint}。`),
      checkpoint,
    )
  }

  async compact(session: AgentSession) {
    return this.compactWithBoundary(
      session,
      protectedCompactionInstructions('manual', '这是用户主动触发的上下文压缩。'),
      'manual',
    )
  }

  private async compactWithBoundary(
    session: AgentSession,
    instructions: string,
    checkpoint: PlanningCompactionCheckpoint | 'manual',
  ) {
    if (hasOversizedUnfinishedToolTail(session)) {
      appendCompactionBoundary(session, checkpoint)
    }
    try {
      return await session.compact(instructions)
    } catch (error) {
      if (!isNoCompactionAvailable(error)) throw error
      return undefined
    }
  }

  private compactionProjection(reason: 'manual' | 'threshold' | 'overflow', result: CompactionResult | undefined, aborted: boolean, willRetry: boolean) {
    return {
      reason,
      aborted,
      willRetry,
      ...(result ? {
        tokensBefore: result.tokensBefore,
        estimatedTokensAfter: result.estimatedTokensAfter,
        compactedTokens: result.estimatedTokensAfter == null
          ? undefined
          : Math.max(0, result.tokensBefore - result.estimatedTokensAfter),
      } : {}),
    }
  }
}

function isNoCompactionAvailable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /Nothing to compact \(session too small\)/iu.test(message)
}

function hasOversizedUnfinishedToolTail(session: AgentSession) {
  const entries = session.sessionManager.getBranch()
  const keepRecentTokens = session.settingsManager.getCompactionSettings().keepRecentTokens
  let trailingTokens = 0
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const messages = sessionEntryToContextMessages(entries[index])
    trailingTokens += messages.reduce((total, message) => total + estimateTokens(message), 0)
    if (trailingTokens < keepRecentTokens) continue
    // Pi cannot cut at a toolResult. Without a later context-visible entry,
    // its compactor returns "Nothing to compact" even for a large session.
    return !entries.slice(index).some(entry => sessionEntryToContextMessages(entry).some(message => isCompactionCutPoint(message.role)))
  }
  return false
}

function isCompactionCutPoint(role: string) {
  return role === 'user'
    || role === 'assistant'
    || role === 'bashExecution'
    || role === 'custom'
    || role === 'branchSummary'
    || role === 'compactionSummary'
}

function appendCompactionBoundary(
  session: AgentSession,
  checkpoint: PlanningCompactionCheckpoint | 'manual',
) {
  const latest = session.sessionManager.getBranch().at(-1)
  if (latest?.type === 'custom_message' && latest.customType === 'smarthub_context_compaction_boundary') return
  session.sessionManager.appendCustomMessageEntry(
    'smarthub_context_compaction_boundary',
    contextCompactionBoundary(checkpoint),
    false,
    { checkpoint },
  )
}

function contextCompactionBoundary(checkpoint: PlanningCompactionCheckpoint | 'manual') {
  return [
    '[SmartHub 系统上下文检查点]',
    `检查点：${checkpoint}。`,
    '此前的工具返回仅用于当前推理；本条不是新的业务任务，也不是正式业务事实。',
    '后续继续时必须以当前任务、Service/PostgreSQL、固定 Release、Snapshot 和 Workspace 重新读取正式事实。',
  ].join('\n')
}

export function protectedCompactionInstructions(
  reason: 'manual' | 'threshold' | 'overflow',
  detail?: string,
) {
  return [
    '仅总结运行上下文，不把摘要当作正式业务事实。',
    `压缩原因：${reason}。`,
    ...(detail ? [detail] : []),
    '保留当前 Workflow Stage、当前目标、用户确认事项、已确认的需求分析与测试设计结论、当前 Workspace 引用、固定 Release/Snapshot 引用、未解决 Finding、Test Focus 和下一步动作。',
    '正式 Requirement Release、TestCase、Version、Revision、Hash、Snapshot 内容不得从摘要恢复；后续 Stage 必须由 Service/PostgreSQL 重新读取固定事实。',
  ].join('\n')
}

export function contextUsageValue(usage: ContextUsage | undefined) {
  return {
    contextWindow: usage?.contextWindow ?? 0,
    currentTokens: usage?.tokens ?? null,
    usagePercent: usage?.percent ?? null,
  }
}
