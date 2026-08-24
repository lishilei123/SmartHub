import type {
  AgentTokenUsage,
  AgentUnderTestResponseMapping,
  TraceEvent,
  TraceEventType,
  TraceEvidenceCoverage,
} from '../domain/agent-test-types.js'

export type CollectedTraceEvent = Omit<TraceEvent, 'id' | 'runId' | 'taskId' | 'caseRunId' | 'sequence'>

export interface TraceCollectorResult {
  actualOutput?: unknown
  events: CollectedTraceEvent[]
  evidenceCoverage: TraceEvidenceCoverage
  tokenUsage?: AgentTokenUsage
  cost?: number
}

export interface TraceCollector {
  readonly protocol: 'http' | 'sse'
  collect(body: string, mapping: AgentUnderTestResponseMapping, receivedAt: string): TraceCollectorResult
}

const TRACE_TYPES = new Set<TraceEventType>([
  'USER_INPUT',
  'AGENT_OUTPUT',
  'LLM_CALL',
  'TOOL_CALL',
  'TOOL_RESULT',
  'MCP_CALL',
  'RETRIEVAL',
  'SUB_AGENT_CALL',
  'ARTIFACT',
  'BUSINESS_STATE',
  'ERROR',
])

const TRACE_DEPENDENT_TYPES = [...TRACE_TYPES].filter(type => type !== 'USER_INPUT' && type !== 'AGENT_OUTPUT')

export class HttpResponseCollector implements TraceCollector {
  readonly protocol = 'http' as const

  collect(body: string, mapping: AgentUnderTestResponseMapping, receivedAt: string): TraceCollectorResult {
    const payload = parseJson(body, 'HTTP Agent 响应不是有效 JSON')
    const actualOutput = readPath(payload, mapping.outputPath)
    const traceValue = mapping.tracePath ? readPath(payload, mapping.tracePath) : undefined
    const events = normalizeTraceArray(traceValue, receivedAt, 'http_response_collector')
    if (actualOutput !== undefined) events.push({ type: 'AGENT_OUTPUT', timestamp: receivedAt, source: 'http_response_collector', output: redact(actualOutput) })
    return {
      ...(actualOutput === undefined ? {} : { actualOutput: redact(actualOutput) }),
      events,
      evidenceCoverage: coverage(mapping, traceValue),
      ...metrics(payload, mapping),
    }
  }
}

export class SseEventCollector implements TraceCollector {
  readonly protocol = 'sse' as const

  collect(body: string, mapping: AgentUnderTestResponseMapping, receivedAt: string): TraceCollectorResult {
    const blocks = parseSse(body)
    const events: CollectedTraceEvent[] = []
    let actualOutput: unknown
    let tokenUsage: AgentTokenUsage | undefined
    let cost: number | undefined
    let traceObserved = false
    for (const block of blocks) {
      if (!block.data) continue
      const payload = parseJson(block.data, 'SSE data 不是有效 JSON')
      const directType = TRACE_TYPES.has(block.event as TraceEventType) ? block.event as TraceEventType : undefined
      if (directType) {
        events.push(normalizeTraceEvent({ ...(isRecord(payload) ? payload : { output: payload }), type: directType }, receivedAt, 'sse_event_collector'))
        traceObserved ||= directType !== 'AGENT_OUTPUT' && directType !== 'USER_INPUT'
        if (directType === 'AGENT_OUTPUT') actualOutput = redact(readPath(payload, mapping.outputPath) ?? (isRecord(payload) ? payload.output : payload))
      }
      const traceValue = mapping.tracePath ? readPath(payload, mapping.tracePath) : undefined
      if (traceValue !== undefined) {
        traceObserved = true
        events.push(...normalizeTraceArray(traceValue, receivedAt, 'sse_event_collector'))
      }
      const output = directType ? undefined : readPath(payload, mapping.outputPath)
      if (output !== undefined) {
        actualOutput = redact(output)
        events.push({ type: 'AGENT_OUTPUT', timestamp: receivedAt, source: 'sse_event_collector', output: actualOutput })
      }
      const found = metrics(payload, mapping)
      tokenUsage = found.tokenUsage ?? tokenUsage
      cost = found.cost ?? cost
    }
    return {
      ...(actualOutput === undefined ? {} : { actualOutput }),
      events,
      evidenceCoverage: traceObserved ? directSseCoverage(mapping) : coverage(mapping, undefined),
      ...(tokenUsage ? { tokenUsage } : {}),
      ...(cost === undefined ? {} : { cost }),
    }
  }
}

function directSseCoverage(mapping: AgentUnderTestResponseMapping): TraceEvidenceCoverage {
  const traceCoverage = mapping.traceCompleteness ?? 'partial'
  return Object.fromEntries([
    ['USER_INPUT', 'complete'],
    ['AGENT_OUTPUT', 'complete'],
    ...TRACE_DEPENDENT_TYPES.map(type => [type, traceCoverage]),
  ]) as TraceEvidenceCoverage
}

export function readPath(value: unknown, path: string): unknown {
  if (path === '$') return value
  let current = value
  for (const segment of path.split('.')) {
    if (Array.isArray(current) && /^\d+$/u.test(segment)) current = current[Number(segment)]
    else if (isRecord(current)) current = current[segment]
    else return undefined
  }
  return current
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 30) return '[REDACTED_DEPTH]'
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1))
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /(?:authorization|cookie|token|api[-_]?key|password|passwd|secret|credential)/iu.test(key)
      ? '[REDACTED]'
      : redact(item, depth + 1),
  ]))
}

function normalizeTraceArray(value: unknown, timestamp: string, source: CollectedTraceEvent['source']) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('AGENT_TRACE_MAPPING_INVALID: tracePath 必须指向数组')
  return value.map(item => normalizeTraceEvent(item, timestamp, source))
}

function normalizeTraceEvent(value: unknown, fallbackTimestamp: string, source: CollectedTraceEvent['source']): CollectedTraceEvent {
  if (!isRecord(value) || !TRACE_TYPES.has(value.type as TraceEventType)) throw new Error('AGENT_TRACE_EVENT_INVALID: Trace 事件缺少有效 type')
  const timestamp = typeof value.timestamp === 'string' && Number.isFinite(Date.parse(value.timestamp)) ? new Date(value.timestamp).toISOString() : fallbackTimestamp
  const durationMs = typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0 ? value.durationMs : undefined
  return {
    type: value.type as TraceEventType,
    timestamp,
    source,
    ...(typeof value.name === 'string' && value.name.trim() ? { name: value.name.trim().slice(0, 500) } : {}),
    ...(Object.hasOwn(value, 'input') ? { input: redact(value.input) } : {}),
    ...(Object.hasOwn(value, 'output') ? { output: redact(value.output) } : {}),
    ...(isRecord(value.metadata) ? { metadata: redact(value.metadata) as Record<string, unknown> } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
  }
}

function coverage(mapping: AgentUnderTestResponseMapping, traceValue: unknown): TraceEvidenceCoverage {
  const traceCoverage = mapping.tracePath && traceValue !== undefined ? mapping.traceCompleteness ?? 'partial' : 'unavailable'
  return Object.fromEntries([
    ['USER_INPUT', 'complete'],
    ['AGENT_OUTPUT', 'complete'],
    ...TRACE_DEPENDENT_TYPES.map(type => [type, traceCoverage]),
  ]) as TraceEvidenceCoverage
}

function metrics(payload: unknown, mapping: AgentUnderTestResponseMapping) {
  const tokenValue = mapping.tokenUsagePath ? readPath(payload, mapping.tokenUsagePath) : undefined
  const costValue = mapping.costPath ? readPath(payload, mapping.costPath) : undefined
  const tokenUsage = isRecord(tokenValue) ? normalizeTokenUsage(tokenValue) : undefined
  const cost = typeof costValue === 'number' && Number.isFinite(costValue) && costValue >= 0 ? costValue : undefined
  return { ...(tokenUsage ? { tokenUsage } : {}), ...(cost === undefined ? {} : { cost }) }
}

function normalizeTokenUsage(value: Record<string, unknown>): AgentTokenUsage | undefined {
  const inputTokens = metricNumber(value.inputTokens ?? value.input_tokens)
  const outputTokens = metricNumber(value.outputTokens ?? value.output_tokens)
  const totalTokens = metricNumber(value.totalTokens ?? value.total_tokens)
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined
  return { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }), ...(totalTokens === undefined ? {} : { totalTokens }) }
}

function metricNumber(value: unknown) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined }

function parseSse(body: string) {
  return body.replace(/\r\n?/gu, '\n').split(/\n\n+/u).map(block => {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue
      if (line.startsWith('event:')) event = line.slice(6).trim()
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    return { event, data: data.join('\n') }
  })
}

function parseJson(body: string, message: string): unknown {
  try { return JSON.parse(body) } catch { throw new Error(`AGENT_RESPONSE_INVALID: ${message}`) }
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
