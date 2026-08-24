import type {
  AgentAssertionResult,
  AgentAssertionStatus,
  AgentCaseRunStatus,
  AgentFailureFact,
  AgentTestSpec,
  TraceEvent,
  TraceEventType,
  TraceEvidenceCoverage,
} from '../domain/agent-test-types.js'
import { canonicalSha256 } from './canonical-json.js'
import { readPath } from '../runner/agent-trace-collectors.js'

export interface AgentAssertionInput {
  caseRunId: string
  spec: AgentTestSpec
  httpStatus?: number
  timedOut: boolean
  actualOutput?: unknown
  trace: TraceEvent[]
  evidenceCoverage: TraceEvidenceCoverage
  cost?: number
}

export interface AgentAssertionEngineResult {
  results: AgentAssertionResult[]
  failureFacts: AgentFailureFact[]
  stepCount: number
}

export class AgentAssertionEngine {
  evaluate(input: AgentAssertionInput): AgentAssertionEngineResult {
    const builder = new AssertionBuilder(input.caseRunId)
    const trace = input.trace.slice().sort((left, right) => left.sequence - right.sequence)
    const toolCalls = trace.filter(event => event.type === 'TOOL_CALL')
    const actionEvents = trace.filter(event => event.name && !['USER_INPUT', 'AGENT_OUTPUT'].includes(event.type))
    const artifacts = trace.filter(event => event.type === 'ARTIFACT')
    const stepCount = actionEvents.length

    const httpPassed = input.httpStatus !== undefined && input.httpStatus >= 200 && input.httpStatus < 300
    builder.add('HTTP_RESULT', httpPassed ? 'PASS' : 'FAIL', input.httpStatus === undefined ? 'AGENT_HTTP_STATUS_UNAVAILABLE' : httpPassed ? 'AGENT_HTTP_STATUS_OK' : 'AGENT_HTTP_STATUS_INVALID', input.httpStatus === undefined ? '未获得 HTTP 状态' : `HTTP 状态为 ${input.httpStatus}`, { expected: '2xx', actual: input.httpStatus })
    builder.add('TIMEOUT', input.timedOut ? 'FAIL' : 'PASS', input.timedOut ? 'AGENT_EXECUTION_TIMEOUT' : 'AGENT_EXECUTION_WITHIN_TIMEOUT', input.timedOut ? '被测 Agent 调用超时' : '被测 Agent 在时限内返回', { expected: input.spec.executionConstraints.timeoutMs })
    builder.add('STEP_COUNT', stepCount <= input.spec.executionConstraints.maxSteps ? 'PASS' : 'FAIL', stepCount <= input.spec.executionConstraints.maxSteps ? 'AGENT_STEP_COUNT_WITHIN_LIMIT' : 'AGENT_STEP_COUNT_EXCEEDED', `观察到 ${stepCount} 个 Agent 步骤，限制为 ${input.spec.executionConstraints.maxSteps}`, { expected: input.spec.executionConstraints.maxSteps, actual: stepCount, evidenceRefs: actionEvents.map(item => item.id) })
    if (input.spec.executionConstraints.maxCost !== undefined) {
      builder.add('COST_LIMIT', input.cost === undefined ? 'NOT_EVALUABLE' : input.cost <= input.spec.executionConstraints.maxCost ? 'PASS' : 'FAIL', input.cost === undefined ? 'AGENT_COST_UNAVAILABLE' : input.cost <= input.spec.executionConstraints.maxCost ? 'AGENT_COST_WITHIN_LIMIT' : 'AGENT_COST_EXCEEDED', input.cost === undefined ? '被测 Agent 未提供可验证 Cost Evidence' : `观察到 Cost ${input.cost}`, { expected: input.spec.executionConstraints.maxCost, actual: input.cost })
    }

    for (const name of input.spec.requiredTools) {
      const matches = toolCalls.filter(event => event.name === name)
      const status = matches.length ? 'PASS' : absentStatus(input.evidenceCoverage, 'TOOL_CALL')
      builder.add('TOOL_PRESENCE', status, status === 'PASS' ? 'REQUIRED_TOOL_OBSERVED' : status === 'FAIL' ? 'REQUIRED_TOOL_MISSING' : 'REQUIRED_TOOL_NOT_EVALUABLE', status === 'PASS' ? `已观察到必需 Tool ${name}` : status === 'FAIL' ? `完整 Tool Trace 中未出现 ${name}` : `当前 Evidence 无法证明 Tool ${name} 是否出现`, { expected: name, evidenceRefs: matches.map(item => item.id) })
    }
    for (const name of input.spec.forbiddenTools) {
      const matches = toolCalls.filter(event => event.name === name)
      const status = matches.length ? 'FAIL' : absentPassStatus(input.evidenceCoverage, 'TOOL_CALL')
      builder.add('FORBIDDEN_TOOL', status, matches.length ? 'FORBIDDEN_TOOL_OBSERVED' : status === 'PASS' ? 'FORBIDDEN_TOOL_ABSENT' : 'FORBIDDEN_TOOL_NOT_EVALUABLE', matches.length ? `观察到禁止 Tool ${name}` : status === 'PASS' ? `完整 Tool Trace 中未出现禁止 Tool ${name}` : `当前 Evidence 无法证明禁止 Tool ${name} 未发生`, { expected: name, evidenceRefs: matches.map(item => item.id) })
    }

    const actionCoverage = aggregateActionCoverage(input.evidenceCoverage)
    for (const name of input.spec.requiredActions) {
      const matches = actionEvents.filter(event => event.name === name)
      const status = matches.length ? 'PASS' : actionCoverage === 'complete' ? 'FAIL' : 'NOT_EVALUABLE'
      builder.add('ACTION_PRESENCE', status, status === 'PASS' ? 'REQUIRED_ACTION_OBSERVED' : status === 'FAIL' ? 'REQUIRED_ACTION_MISSING' : 'REQUIRED_ACTION_NOT_EVALUABLE', status === 'PASS' ? `已观察到必需 Action ${name}` : status === 'FAIL' ? `完整 Trace 中未出现 ${name}` : `当前 Evidence 无法证明 Action ${name} 是否出现`, { expected: name, evidenceRefs: matches.map(item => item.id) })
    }
    for (const name of input.spec.forbiddenActions) {
      const matches = actionEvents.filter(event => event.name === name)
      const status = matches.length ? 'FAIL' : actionCoverage === 'complete' ? 'PASS' : 'NOT_EVALUABLE'
      builder.add('FORBIDDEN_ACTION', status, matches.length ? 'FORBIDDEN_ACTION_OBSERVED' : status === 'PASS' ? 'FORBIDDEN_ACTION_ABSENT' : 'FORBIDDEN_ACTION_NOT_EVALUABLE', matches.length ? `观察到禁止 Action ${name}` : status === 'PASS' ? `完整 Trace 中未出现禁止 Action ${name}` : `当前 Evidence 无法证明禁止 Action ${name} 未发生`, { expected: name, evidenceRefs: matches.map(item => item.id) })
    }

    for (const assertion of input.spec.argumentAssertions) {
      const calls = toolCalls.filter(event => event.name === assertion.tool)
      if (!calls.length) {
        const status = absentStatus(input.evidenceCoverage, 'TOOL_CALL')
        builder.add('ARGUMENT_MATCH', status, status === 'FAIL' ? 'TOOL_ARGUMENT_CALL_MISSING' : 'TOOL_ARGUMENT_NOT_EVALUABLE', status === 'FAIL' ? `完整 Tool Trace 中未出现 ${assertion.tool}` : `当前 Evidence 无法读取 ${assertion.tool} 参数`, { expected: assertion.expected })
        continue
      }
      const matched = calls.some(call => matchesValue(readPath(call.input, assertion.path), assertion.operator, assertion.expected))
      builder.add('ARGUMENT_MATCH', matched ? 'PASS' : 'FAIL', matched ? 'TOOL_ARGUMENT_MATCHED' : 'TOOL_ARGUMENT_MISMATCH', matched ? `${assertion.tool}.${assertion.path} 满足约束` : `${assertion.tool}.${assertion.path} 不满足约束`, { expected: assertion.expected, actual: calls.map(call => readPath(call.input, assertion.path)), evidenceRefs: calls.map(item => item.id) })
    }

    for (const constraint of input.spec.sequenceConstraints) {
      const before = actionEvents.findIndex(event => event.name === constraint.before)
      const after = actionEvents.findIndex(event => event.name === constraint.after)
      if (before < 0 || after < 0) {
        const status = actionCoverage === 'complete' ? 'FAIL' : 'NOT_EVALUABLE'
        builder.add('SEQUENCE_CONSTRAINT', status, status === 'FAIL' ? 'SEQUENCE_EVENT_MISSING' : 'SEQUENCE_NOT_EVALUABLE', status === 'FAIL' ? `完整 Trace 缺少顺序节点 ${before < 0 ? constraint.before : constraint.after}` : '当前 Evidence 无法完整判断事件顺序', { expected: `${constraint.before} BEFORE ${constraint.after}` })
      } else {
        const status = before < after ? 'PASS' : 'FAIL'
        builder.add('SEQUENCE_CONSTRAINT', status, status === 'PASS' ? 'SEQUENCE_SATISFIED' : 'SEQUENCE_VIOLATION', status === 'PASS' ? `${constraint.before} 先于 ${constraint.after}` : `${constraint.after} 出现在 ${constraint.before} 之前`, { expected: `${constraint.before} BEFORE ${constraint.after}`, actual: `${actionEvents[before]?.name}@${before + 1}, ${actionEvents[after]?.name}@${after + 1}`, evidenceRefs: [actionEvents[before]!.id, actionEvents[after]!.id] })
      }
    }

    for (const assertion of input.spec.businessAssertions) {
      const actual = readPath(input.actualOutput, assertion.path)
      const matched = matchesValue(actual, assertion.operator, assertion.expected)
      builder.add('BUSINESS_RESULT', matched ? 'PASS' : 'FAIL', matched ? 'BUSINESS_RESULT_MATCHED' : 'BUSINESS_RESULT_MISMATCH', matched ? `输出 ${assertion.path} 满足业务断言` : `输出 ${assertion.path} 不满足业务断言`, { expected: assertion.expected, actual })
    }

    for (const assertion of input.spec.artifactAssertions) {
      const matches = artifacts.filter(event => event.name === assertion.name)
      const status = matches.length ? 'PASS' : absentStatus(input.evidenceCoverage, 'ARTIFACT')
      builder.add('ARTIFACT', status, status === 'PASS' ? 'REQUIRED_ARTIFACT_OBSERVED' : status === 'FAIL' ? 'REQUIRED_ARTIFACT_MISSING' : 'REQUIRED_ARTIFACT_NOT_EVALUABLE', status === 'PASS' ? `已观察到 Artifact ${assertion.name}` : status === 'FAIL' ? `完整 Artifact Trace 中未出现 ${assertion.name}` : `当前 Evidence 无法证明 Artifact ${assertion.name} 是否产生`, { expected: assertion.name, evidenceRefs: matches.map(item => item.id) })
    }

    return { results: builder.results, failureFacts: builder.failureFacts(), stepCount }
  }
}

export function agentCaseRunStatus(input: { assertions: AgentAssertionResult[]; evaluations: Array<{ status: AgentAssertionStatus }>; error?: string }): AgentCaseRunStatus {
  if (input.error) return 'ERROR'
  const statuses = [...input.assertions, ...input.evaluations].map(item => item.status)
  if (statuses.includes('FAIL')) return 'FAIL'
  if (statuses.includes('NOT_EVALUABLE')) return 'NOT_EVALUABLE'
  return 'PASS'
}

function absentStatus(coverage: TraceEvidenceCoverage, type: TraceEventType): AgentAssertionStatus { return coverage[type] === 'complete' ? 'FAIL' : 'NOT_EVALUABLE' }
function absentPassStatus(coverage: TraceEvidenceCoverage, type: TraceEventType): AgentAssertionStatus { return coverage[type] === 'complete' ? 'PASS' : 'NOT_EVALUABLE' }
function aggregateActionCoverage(coverage: TraceEvidenceCoverage) { return ['TOOL_CALL', 'MCP_CALL', 'SUB_AGENT_CALL', 'BUSINESS_STATE', 'ARTIFACT'].every(type => coverage[type as TraceEventType] === 'complete') ? 'complete' : 'partial' }

function matchesValue(actual: unknown, operator: AgentTestSpec['argumentAssertions'][number]['operator'], expected: unknown) {
  if (operator === 'exists') return actual !== undefined
  if (operator === 'equals') return canonicalEquals(actual, expected)
  if (operator === 'not_equals') return !canonicalEquals(actual, expected)
  if (operator === 'contains') {
    if (typeof actual === 'string' && typeof expected === 'string') return actual.includes(expected)
    if (Array.isArray(actual)) return actual.some(item => canonicalEquals(item, expected))
    return false
  }
  return typeof actual === 'string' && typeof expected === 'string' && new RegExp(expected, 'u').test(actual)
}

function canonicalEquals(left: unknown, right: unknown) {
  if (left === undefined || right === undefined) return left === right
  return canonicalSha256(left) === canonicalSha256(right)
}

class AssertionBuilder {
  readonly results: AgentAssertionResult[] = []
  constructor(private readonly caseRunId: string) {}
  add(type: AgentAssertionResult['type'], status: AgentAssertionStatus, code: string, message: string, details: { expected?: unknown; actual?: unknown; evidenceRefs?: string[] } = {}) {
    const ordinal = this.results.length + 1
    this.results.push({ id: `${this.caseRunId}:assertion:${ordinal}`, caseRunId: this.caseRunId, ordinal, type, status, code, message, ...(Object.hasOwn(details, 'expected') ? { expected: details.expected } : {}), ...(Object.hasOwn(details, 'actual') ? { actual: details.actual } : {}), evidenceRefs: [...(details.evidenceRefs ?? [])] })
  }
  failureFacts(): AgentFailureFact[] { return this.results.filter(item => item.status === 'FAIL').map(item => ({ code: item.code, message: item.message, evidenceRefs: [...item.evidenceRefs], ...(Object.hasOwn(item, 'expected') ? { expected: item.expected } : {}), ...(Object.hasOwn(item, 'actual') ? { actual: item.actual } : {}) })) }
}
