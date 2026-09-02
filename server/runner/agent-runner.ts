import type {
  AgentEvaluationResult,
  AgentExecutionAggregateResult,
  AgentExecutionCaseRun,
  AgentTestSpec,
  AgentUnderTestVersion,
  FrozenAgentUnderTestSnapshot,
  TraceEvent,
} from '../domain/agent-test-types.js'
import { AgentAssertionEngine, agentCaseRunStatus } from '../application/agent-assertion-engine.js'
import {
  HttpResponseCollector,
  SseEventCollector,
  redact,
  type TraceCollector,
} from './agent-trace-collectors.js'

export interface AgentSemanticEvaluatorInput {
  caseRunId: string
  expectedOutcome: string
  actualOutput?: unknown
  semanticAssertions: AgentTestSpec['semanticAssertions']
  safetyAssertions: AgentTestSpec['safetyAssertions']
  trace: TraceEvent[]
}

export interface AgentSemanticEvaluator {
  evaluate(input: AgentSemanticEvaluatorInput, signal: AbortSignal): Promise<AgentEvaluationResult[]>
}

export interface AgentRunnerInput {
  runId: string
  taskId: string
  executionAttemptOrdinal: number
  agentUnderTest: FrozenAgentUnderTestSnapshot
  resolvedVersion: AgentUnderTestVersion
  spec: AgentTestSpec
}

type Fetch = typeof globalThis.fetch

export class AgentRunner {
  private readonly collectors: Map<'http' | 'sse', TraceCollector>
  constructor(
    private readonly evaluator: AgentSemanticEvaluator,
    private readonly fetchImplementation: Fetch = globalThis.fetch,
    private readonly assertionEngine = new AgentAssertionEngine(),
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {
    this.collectors = new Map<'http' | 'sse', TraceCollector>([
      ['http', new HttpResponseCollector()],
      ['sse', new SseEventCollector()],
    ])
  }

  async execute(input: AgentRunnerInput, signal: AbortSignal): Promise<AgentExecutionAggregateResult> {
    validateSnapshot(input.agentUnderTest, input.resolvedVersion)
    const caseRuns: AgentExecutionCaseRun[] = []
    for (let repeatOrdinal = 1; repeatOrdinal <= input.spec.executionConstraints.repeatCount; repeatOrdinal += 1) {
      if (signal.aborted) throw abortError(signal)
      caseRuns.push(await this.executeCaseRun(input, repeatOrdinal, signal))
    }
    return aggregate(input.runId, input.taskId, caseRuns, this.clock())
  }

  private async executeCaseRun(input: AgentRunnerInput, repeatOrdinal: number, outerSignal: AbortSignal): Promise<AgentExecutionCaseRun> {
    const caseRunId = `${input.runId}:${input.taskId}:attempt:${input.executionAttemptOrdinal}:repeat:${repeatOrdinal}`
    const startedAt = this.clock()
    const startedMs = Date.now()
    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('AGENT_EXECUTION_TIMEOUT'))
    }, input.spec.executionConstraints.timeoutMs)
    const onAbort = () => controller.abort(outerSignal.reason)
    outerSignal.addEventListener('abort', onAbort, { once: true })
    let httpStatus: number | undefined
    let actualOutput: unknown
    let trace: TraceEvent[] = []
    let evidenceCoverage = {}
    let tokenUsage
    let cost: number | undefined
    let error: string | undefined
    try {
      const body = requestBody(input.spec, input.agentUnderTest.requestMapping, caseRunId)
      const response = await this.fetchImplementation(input.agentUnderTest.endpoint, {
        method: 'POST',
        headers: requestHeaders(input.resolvedVersion, caseRunId),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      httpStatus = response.status
      const responseBody = await response.text()
      const receivedAt = this.clock()
      const collector = this.collectors.get(input.agentUnderTest.protocol)!
      const collected = collector.collect(responseBody, input.agentUnderTest.responseMapping, receivedAt)
      actualOutput = collected.actualOutput
      evidenceCoverage = collected.evidenceCoverage
      tokenUsage = collected.tokenUsage
      cost = collected.cost
      trace = assignTrace(caseRunId, input.runId, input.taskId, [
        { type: 'USER_INPUT', timestamp: startedAt, source: 'agent_runner', input: redact(input.spec.input), metadata: { repeatOrdinal } },
        ...collected.events,
      ])
    } catch (cause) {
      if (outerSignal.aborted) throw abortError(outerSignal)
      if (!timedOut) error = safeError(cause)
      trace = assignTrace(caseRunId, input.runId, input.taskId, [
        { type: 'USER_INPUT', timestamp: startedAt, source: 'agent_runner', input: redact(input.spec.input), metadata: { repeatOrdinal } },
        { type: 'ERROR', timestamp: this.clock(), source: 'agent_runner', output: timedOut ? 'AGENT_EXECUTION_TIMEOUT' : error ?? 'AGENT_EXECUTION_ERROR' },
      ])
    } finally {
      clearTimeout(timeout)
      outerSignal.removeEventListener('abort', onAbort)
    }

    const assertion = this.assertionEngine.evaluate({ caseRunId, spec: input.spec, httpStatus, timedOut, actualOutput, trace, evidenceCoverage, cost })
    let evaluationResults: AgentEvaluationResult[] = []
    if (!error && !timedOut && httpStatus !== undefined && httpStatus >= 200 && httpStatus < 300) {
      evaluationResults = normalizeEvaluations(caseRunId, await this.evaluator.evaluate({ caseRunId, expectedOutcome: input.spec.expectedOutcome, actualOutput, semanticAssertions: input.spec.semanticAssertions, safetyAssertions: input.spec.safetyAssertions, trace }, outerSignal))
    }
    const finishedAt = this.clock()
    const status = agentCaseRunStatus({ assertions: assertion.results, evaluations: evaluationResults, ...(error ? { error } : {}) })
    const failureFacts = [
      ...assertion.failureFacts,
      ...evaluationResults.filter(item => item.status === 'FAIL').map(item => ({ code: 'AI_EVALUATION_FAILED', message: item.explanation, evidenceRefs: [...item.evidenceRefs], expected: item.criterion, actual: actualOutput })),
      ...(error ? [{ code: 'AGENT_RUNTIME_ERROR', message: error, evidenceRefs: trace.filter(item => item.type === 'ERROR').map(item => item.id) }] : []),
    ]
    return {
      id: caseRunId,
      runId: input.runId,
      taskId: input.taskId,
      executionAttemptOrdinal: input.executionAttemptOrdinal,
      repeatOrdinal,
      status,
      ...(actualOutput === undefined ? {} : { actualOutput }),
      assertionResults: assertion.results,
      evaluationResults,
      traceRef: `agent-trace:${caseRunId}`,
      traceEvents: trace,
      evidenceRefs: trace.map(item => item.id),
      evidenceCoverage,
      latencyMs: Math.max(0, Date.now() - startedMs),
      ...(tokenUsage ? { tokenUsage } : {}),
      ...(cost === undefined ? {} : { cost }),
      stepCount: assertion.stepCount,
      failureFacts,
      startedAt,
      finishedAt,
      ...(error ? { error } : {}),
    }
  }
}

/** Explicitly records that semantic judgment is unavailable; it never fabricates a score. */
export class UnavailableAgentSemanticEvaluator implements AgentSemanticEvaluator {
  async evaluate(input: AgentSemanticEvaluatorInput): Promise<AgentEvaluationResult[]> {
    const criteria = [
      { kind: 'task_completion' as const, criterion: input.expectedOutcome },
      ...input.semanticAssertions.map(item => ({ kind: 'semantic' as const, criterion: `${item.criterion}: ${item.expected}` })),
      ...input.safetyAssertions.map(item => ({ kind: 'safety' as const, criterion: `${item.criterion}: ${item.expected}` })),
    ]
    return criteria.map((item, index) => ({ id: `${input.caseRunId}:evaluation:${index + 1}`, caseRunId: input.caseRunId, ordinal: index + 1, kind: item.kind, criterion: item.criterion, status: 'NOT_EVALUABLE', explanation: '当前运行未配置可用的 SmartHub AI Evaluator', evidenceRefs: input.trace.filter(event => event.type === 'AGENT_OUTPUT').map(event => event.id) }))
  }
}

function requestBody(spec: AgentTestSpec, mapping: FrozenAgentUnderTestSnapshot['requestMapping'], caseRunId: string) {
  const value: Record<string, unknown> = { [mapping.inputField]: spec.input }
  if (mapping.contextField && spec.context) value[mapping.contextField] = spec.context
  if (mapping.sessionIdField) value[mapping.sessionIdField] = caseRunId
  return value
}

function requestHeaders(version: AgentUnderTestVersion, caseRunId: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: version.protocol === 'sse' ? 'text/event-stream' : 'application/json', 'idempotency-key': caseRunId, ...version.requestMapping.headers }
  const auth = version.authenticationConfig
  if (auth.type === 'none') return headers
  const secret = process.env[auth.environmentVariable]
  if (!secret) throw new Error(`AGENT_UNDER_TEST_CREDENTIAL_UNAVAILABLE: ${auth.environmentVariable}`)
  if (auth.type === 'bearer_env') headers.authorization = `Bearer ${secret}`
  else headers[auth.headerName] = secret
  return headers
}

function validateSnapshot(snapshot: FrozenAgentUnderTestSnapshot, version: AgentUnderTestVersion) {
  if (snapshot.version !== version.version || snapshot.configurationSha256 !== version.configurationSha256 || snapshot.endpoint !== version.endpoint || snapshot.protocol !== version.protocol) throw new Error('AGENT_UNDER_TEST_RUNTIME_SNAPSHOT_MISMATCH')
}

function assignTrace(caseRunId: string, runId: string, taskId: string, events: Array<Omit<TraceEvent, 'id' | 'runId' | 'taskId' | 'caseRunId' | 'sequence'>>): TraceEvent[] {
  return events.map((event, index) => ({ ...event, id: `${caseRunId}:trace:${index + 1}`, runId, taskId, caseRunId, sequence: index + 1 }))
}

function normalizeEvaluations(caseRunId: string, values: AgentEvaluationResult[]) {
  return values.map((item, index) => ({ ...item, id: `${caseRunId}:evaluation:${index + 1}`, caseRunId, ordinal: index + 1, evidenceRefs: [...item.evidenceRefs] }))
}

function aggregate(runId: string, taskId: string, caseRuns: AgentExecutionCaseRun[], createdAt: string): AgentExecutionAggregateResult {
  const count = caseRuns.length
  const statuses = caseRuns.map(item => item.status)
  const status = statuses.includes('ERROR') ? 'ERROR' : statuses.includes('FAIL') ? 'FAIL' : statuses.includes('NOT_EVALUABLE') ? 'NOT_EVALUABLE' : 'PASS'
  const tokenUsage = sumTokens(caseRuns)
  const costs = caseRuns.flatMap(item => item.cost === undefined ? [] : [item.cost])
  return {
    taskId,
    runId,
    executionAttemptOrdinal: caseRuns[0]!.executionAttemptOrdinal,
    status,
    caseRuns,
    successRate: rate(statuses.filter(item => item === 'PASS').length, count),
    failureRate: rate(statuses.filter(item => item === 'FAIL').length, count),
    notEvaluableRate: rate(statuses.filter(item => item === 'NOT_EVALUABLE').length, count),
    errorRate: rate(statuses.filter(item => item === 'ERROR').length, count),
    averageLatencyMs: Math.round(caseRuns.reduce((sum, item) => sum + item.latencyMs, 0) / count),
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(costs.length ? { cost: costs.reduce((sum, item) => sum + item, 0) } : {}),
    createdAt,
  }
}

function sumTokens(caseRuns: AgentExecutionCaseRun[]) {
  const values = caseRuns.flatMap(item => item.tokenUsage ? [item.tokenUsage] : [])
  if (!values.length) return undefined
  const sum = (key: 'inputTokens' | 'outputTokens' | 'totalTokens') => values.some(item => item[key] !== undefined) ? values.reduce((total, item) => total + (item[key] ?? 0), 0) : undefined
  const inputTokens = sum('inputTokens'); const outputTokens = sum('outputTokens'); const totalTokens = sum('totalTokens')
  return { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }), ...(totalTokens === undefined ? {} : { totalTokens }) }
}

function rate(value: number, total: number) { return total ? Number((value / total).toFixed(4)) : 0 }
function safeError(error: unknown) { const message = error instanceof Error ? error.message : String(error); return message.replace(/Bearer\s+\S+/giu, 'Bearer [REDACTED]').slice(0, 4_000) }
function abortError(signal: AbortSignal) { return signal.reason instanceof Error ? signal.reason : new Error('ABORT_ERR') }
