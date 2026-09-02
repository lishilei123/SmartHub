import { Activity, Bot, CheckCircle2, Clock3, RefreshCw, ShieldAlert } from 'lucide-react'
import type { ExecutionTask, ExecutionTaskDetail, Versioned } from './types'

export function ExecutionTaskPanel({ tasks, task, busy, onOpen, onRetry }: {
  tasks: ExecutionTask[]
  task: Versioned<ExecutionTaskDetail> | null
  busy: string
  onOpen: (id: string) => Promise<ExecutionTaskDetail | undefined>
  onRetry: () => Promise<void>
}) {
  const result = task?.value.agentExecutionResult
  const attempts = task?.value.agentExecutionAttempts ?? (result ? [result] : [])
  return <div className="te-task-column">
    <section className="te-card te-task-list">
      <header><div><h2>Agent Test Tasks</h2><p>每个 Task 对应一条冻结 Agent Case。</p></div><span>{tasks.length}</span></header>
      <div>{tasks.map(item => <button key={item.id} className={task?.value.task.id === item.id ? 'active' : ''} onClick={() => void onOpen(item.id)}>
        <TaskIcon status={item.status} />
        <span><b>{item.input.caseContent.title}</b><small>{item.input.caseId} · Agent · {item.input.dimension}</small></span>
        <em className={`te-status-pill ${item.status}`}>{taskStatusLabel(item.status)}</em>
      </button>)}{!tasks.length && <p className="te-empty">选择 Run 后查看 Tasks</p>}</div>
    </section>

    {task && <section className="te-card te-task-detail">
      <header>
        <div><h2>{task.value.task.input.caseContent.title}</h2><p>{task.value.task.input.caseId} · Revision {task.value.task.input.caseRevision}</p></div>
        {['failed', 'blocked'].includes(task.value.task.status) && <button className="te-secondary" disabled={Boolean(busy)} onClick={() => void onRetry()}><RefreshCw />{busy === 'retry' ? '排队中…' : '创建新执行代次'}</button>}
      </header>
      <dl>
        <div><dt>Task 状态</dt><dd>{taskStatusLabel(task.value.task.status)}</dd></div>
        <div><dt>最新结果</dt><dd>{result?.status ?? '尚无结果'}</dd></div>
        <div><dt>执行代次</dt><dd>{attempts.length}</dd></div>
        <div><dt>Repeat</dt><dd>{result?.caseRuns.length ?? 0}</dd></div>
        <div><dt>平均延迟</dt><dd>{result ? `${Math.round(result.averageLatencyMs)} ms` : '—'}</dd></div>
      </dl>
      {task.value.task.error && <div className="te-global-error">{task.value.task.error}</div>}
      {result?.evaluationError && <div className="te-global-error">Evaluation 未收口：{result.evaluationError}</div>}
      {result?.failureAnalysisError && <div className="te-global-error">FailureAnalysis 未收口：{result.failureAnalysisError}</div>}
      {result?.failureAnalysis && <section><h3>失败分析</h3><p><b>{result.failureAnalysis.category}</b> · {result.failureAnalysis.reason}</p><p>{result.failureAnalysis.evidence}</p></section>}

      <section>
        <h3>Agent 执行证据</h3>
        {attempts.slice().reverse().map(attempt => <details key={`${attempt.taskId}:${attempt.executionAttemptOrdinal}`} className="te-developer-details" open={attempt.executionAttemptOrdinal === result?.executionAttemptOrdinal}>
          <summary>执行代次 {attempt.executionAttemptOrdinal} · {attempt.status} · {attempt.caseRuns.length} Repeats</summary>
          {attempt.caseRuns.map(caseRun => <details key={caseRun.id} className="te-developer-details">
            <summary>Repeat {caseRun.repeatOrdinal} · {caseRun.status} · {caseRun.latencyMs} ms</summary>
            <p>Steps: {caseRun.stepCount} · Assertions: {caseRun.assertionResults.length} · Evaluations: {caseRun.evaluationResults.length} · Trace: {caseRun.traceEvents.length}</p>
            {caseRun.assertionResults.map(assertion => <div key={assertion.id}><b>{assertion.status} · {assertion.code}</b><p>{assertion.message}</p></div>)}
            {caseRun.evaluationResults.map(evaluation => <div key={evaluation.id}><b>{evaluation.status} · {evaluation.kind}</b><p>{evaluation.criterion}：{evaluation.explanation}</p></div>)}
            {caseRun.failureFacts.map((fact, index) => <div key={`${fact.code}:${index}`}><b>Failure Fact · {fact.code}</b><p>{fact.message}</p></div>)}
          </details>)}
        </details>)}
        {!result && <p className="te-empty"><Activity />等待 AgentRunner 返回正式结果。</p>}
      </section>
    </section>}
  </div>
}

function TaskIcon({ status }: { status: ExecutionTask['status'] }) {
  return status === 'passed' ? <CheckCircle2 /> : ['pending', 'running'].includes(status) ? <Clock3 /> : status === 'cancelled' ? <ShieldAlert /> : <Bot />
}

function taskStatusLabel(status: ExecutionTask['status']) {
  return ({ pending: '等待中', running: '执行中', passed: '通过', failed: '失败', blocked: '阻塞', cancelled: '已取消' })[status]
}
