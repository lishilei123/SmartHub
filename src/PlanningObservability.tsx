import { Bot, BrainCircuit, Clock3, Gauge, GitBranch, RefreshCw, ShieldCheck } from 'lucide-react'
import type { AgentExecutionContext, PlanningSubAgentRunRecord } from './planning-api'
import './planning.css'

const reviewerLabels = {
  requirement: 'RequirementReviewer',
  test_case: 'TestCaseReviewer',
  coverage: 'CoverageReviewer',
} as const

export function PlanningContextMetrics({ context, compacting = false, onCompact }: { context?: AgentExecutionContext | null; compacting?: boolean; onCompact?: () => void }) {
  if (!context) return <div className="planning-context-empty"><BrainCircuit /><span><b>Parent Session 尚未创建</b><small>第一次运行需求分析或测试设计 Stage 后建立 projectVersion 级会话。</small></span></div>
  return <section className="planning-context-card">
    <header><span><BrainCircuit /><b>Planning Parent Session</b></span>{onCompact && <button disabled={compacting} onClick={onCompact}><RefreshCw className={compacting ? 'planning-spin' : ''} />主动压缩</button>}</header>
    <div className="planning-context-metrics">
      <Metric icon={<Gauge />} label="Context Window" value={formatTokens(context.contextWindow)} />
      <Metric icon={<BrainCircuit />} label="Current Tokens" value={context.currentTokens == null ? '—' : formatTokens(context.currentTokens)} />
      <Metric icon={<Gauge />} label="Usage" value={context.usagePercent == null ? '—' : `${context.usagePercent.toFixed(1)}%`} />
      <Metric icon={<RefreshCw />} label="Compactions" value={String(context.compactionCount)} />
      <Metric icon={<Clock3 />} label="Last Compaction" value={context.lastCompactionAt ? formatTime(context.lastCompactionAt) : '—'} />
      <Metric icon={<GitBranch />} label="Messages" value={String(context.totalMessages)} />
    </div>
    <footer><code>{context.sessionId}</code><span>{context.autoCompactionEnabled ? 'Auto Compaction 已启用' : 'Auto Compaction 未启用'}</span></footer>
  </section>
}

export function PlanningSubAgentRuns({ runs }: { runs?: PlanningSubAgentRunRecord[] }) {
  if (!runs?.length) return null
  return <section className="planning-subagent-runs"><header><Bot /><b>Reviewer SubAgent Runs</b><span>{runs.length}</span></header><div>{[...runs].reverse().map(run => <article key={run.runId} className={run.status}>
    <ShieldCheck />
    <span><b>{reviewerLabels[run.reviewerType]}</b><small>{run.status} · {run.turns} Turn · {run.toolCalls} Tool Calls{run.toolErrors ? ` · ${run.toolErrors} Errors` : ''}</small><code title={run.reviewerSessionId}>{run.reviewerSessionId ?? run.runId}</code></span>
    <time>{formatTime(run.finishedAt ?? run.startedAt)}</time>
  </article>)}</div></section>
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <span>{icon}<small>{label}</small><b>{value}</b></span>
}
function formatTokens(value: number) { return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : String(value) }
function formatTime(value: string) { return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
