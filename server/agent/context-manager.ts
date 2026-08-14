import type {
  AgentSession,
  AgentSessionEvent,
  CompactionResult,
  ContextUsage,
} from '@earendil-works/pi-coding-agent'
import type {
  AgentExecutionContext,
  AgentExecutionEvent,
} from '../domain/agent-types.js'
import type { PiSessionScope } from './pi-session-runtime.js'

export type PlanningCompactionCheckpoint =
  | 'requirement_analysis_completed'
  | 'requirement_release_completed'
  | 'test_points_confirmed'
  | 'before_test_case_design'
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
        'requirement_release_completed',
        'test_points_confirmed',
        'before_test_case_design',
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
    return session.compact(protectedCompactionInstructions('manual', `当前检查点：${checkpoint}。`))
  }

  async compact(session: AgentSession) {
    return session.compact(protectedCompactionInstructions('manual', '这是用户主动触发的上下文压缩。'))
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
