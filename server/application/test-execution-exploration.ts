import { createHash } from 'node:crypto'
import type {
  ExplorationSchemaShape,
  HttpExplorationObservation,
  ProjectVersionExplorationResult,
} from '../domain/test-execution-types.js'

export interface RawUiNetworkObservation {
  method?: string
  url?: string
  resourceType?: string
  requestHeaders?: unknown
  requestBody?: unknown
  responseStatus?: number
  responseHeaders?: unknown
  responseBody?: unknown
  page?: string
  action?: string
  actionType?: HttpExplorationObservation['observedFrom']['actionType']
  sequence?: number
}

const sensitiveName = /(?:^|[-_.])(authorization|cookie|set-cookie|password|passwd|passcode|token|access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|secret|session(?:[-_]?id)?|csrf(?:[-_]?token)?|xsrf(?:[-_]?token)?|private[-_]?key)(?:$|[-_.])/iu
const staticExtension = /\.(?:avif|bmp|css|eot|gif|ico|jpe?g|js|map|mjs|mp3|mp4|ogg|otf|pdf|png|svg|ttf|webm|webp|woff2?)(?:$|\/)/iu
const lowValuePath = /(?:^|\/)(?:analytics?|telemetry|metrics?|tracking|collect|beacon|ads?|pixel)(?:\/|$)/iu
const lowValueHost = /(?:^|\.)(?:analytics?|telemetry|tracking|ads?)(?:\.|$)/iu
const allowedResourceTypes = new Set(['fetch', 'xhr'])
const preservedHeaderValues = new Set(['accept', 'content-type', 'x-requested-with'])

export function normalizeUiNetworkObservation(
  input: RawUiNetworkObservation,
): HttpExplorationObservation | null {
  const method = String(input.method ?? '').trim().toUpperCase()
  if (!/^[A-Z]{3,12}$/u.test(method) || ['OPTIONS', 'HEAD'].includes(method)) return null
  let url: URL
  try {
    url = new URL(String(input.url ?? ''))
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null
  const resourceType = String(input.resourceType ?? '').trim().toLocaleLowerCase()
  const requestHeaders = normalizeHeaders(input.requestHeaders)
  const responseHeaders = normalizeHeaders(input.responseHeaders)
  const contentType = contentTypeValue(responseHeaders) ?? contentTypeValue(requestHeaders)
  if (!businessRequest({ method, url, resourceType, contentType })) return null
  const page = safePage(input.page)
  const actionType = allowedActionType(input.actionType) ? input.actionType : 'other'
  const action = redactFreeText(String(input.action ?? `${actionType} ${page}`), 500)
  const sequence = Number.isSafeInteger(input.sequence) && Number(input.sequence) >= 0
    ? Number(input.sequence)
    : 0
  const status = Number(input.responseStatus)
  return {
    type: 'http_endpoint',
    method,
    origin: url.origin,
    path: normalizedEndpointPath(url.pathname),
    queryParams: [...new Set([...url.searchParams.keys()].map(safeFieldName))].sort((left, right) => left.localeCompare(right, 'en')),
    requestHeaders,
    ...(input.requestBody === undefined ? {} : { requestSchema: schemaShape(input.requestBody) }),
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { responseStatus: status } : {}),
    ...(input.responseBody === undefined ? {} : { responseSchema: schemaShape(input.responseBody) }),
    ...(contentType ? { contentType } : {}),
    observedFrom: { page, action, actionType, sequence },
    confidence: actionType === 'navigate' ? 0.7 : 0.9,
  }
}

export function createProjectVersionExplorationResult(input: {
  projectVersionId: string
  sourceCaseId: string
  environmentSignature: string
  sourceRunId?: string
  sourceTaskId?: string
  observedAt: string
  observation: HttpExplorationObservation
}): ProjectVersionExplorationResult {
  const projectVersionId = identity(input.projectVersionId, 'projectVersionId')
  const sourceCaseId = identity(input.sourceCaseId, 'sourceCaseId')
  const environmentSignature = hashValue(input.environmentSignature, 'environmentSignature')
  const observedAt = timestamp(input.observedAt, 'observedAt')
  const observation = assertSafeObservation(input.observation)
  const contextKey = explorationContextKey(observation, environmentSignature)
  return {
    ...observation,
    id: `exploration_${sha256(`${projectVersionId}\u0000${contextKey}`).slice(0, 40)}`,
    projectVersionId,
    sourceCaseId,
    environmentSignature,
    source: 'ui_exploration',
    validationStatus: 'validated',
    observedAt,
    createdAt: observedAt,
    updatedAt: observedAt,
    ...(input.sourceRunId ? { sourceRunId: identity(input.sourceRunId, 'sourceRunId') } : {}),
    ...(input.sourceTaskId ? { sourceTaskId: identity(input.sourceTaskId, 'sourceTaskId') } : {}),
  }
}

export function explorationContextKey(
  observation: Pick<HttpExplorationObservation, 'method' | 'path' | 'observedFrom'>,
  environmentSignature: string,
) {
  return sha256(JSON.stringify({
    environmentSignature,
    method: observation.method,
    path: observation.path,
    page: observation.observedFrom.page,
    action: observation.observedFrom.action,
    actionType: observation.observedFrom.actionType,
  }))
}

export function assertSafeExplorationResult(
  input: ProjectVersionExplorationResult,
): ProjectVersionExplorationResult {
  const observation = assertSafeObservation(input)
  const result: ProjectVersionExplorationResult = {
    ...observation,
    id: identity(input.id, 'id'),
    projectVersionId: identity(input.projectVersionId, 'projectVersionId'),
    sourceCaseId: identity(input.sourceCaseId, 'sourceCaseId'),
    environmentSignature: hashValue(input.environmentSignature, 'environmentSignature'),
    source: input.source,
    validationStatus: input.validationStatus,
    observedAt: timestamp(input.observedAt, 'observedAt'),
    createdAt: timestamp(input.createdAt, 'createdAt'),
    updatedAt: timestamp(input.updatedAt, 'updatedAt'),
    ...(input.sourceRunId ? { sourceRunId: identity(input.sourceRunId, 'sourceRunId') } : {}),
    ...(input.sourceTaskId ? { sourceTaskId: identity(input.sourceTaskId, 'sourceTaskId') } : {}),
    ...(input.inheritedFromProjectVersionId ? { inheritedFromProjectVersionId: identity(input.inheritedFromProjectVersionId, 'inheritedFromProjectVersionId') } : {}),
    ...(input.inheritedFromExplorationId ? { inheritedFromExplorationId: identity(input.inheritedFromExplorationId, 'inheritedFromExplorationId') } : {}),
  }
  if (!['ui_exploration', 'api_exploration'].includes(result.source)) throw new Error('TEST_EXECUTION_EXPLORATION_SOURCE_INVALID')
  if (!['validated', 'needs_validation', 'invalid'].includes(result.validationStatus)) throw new Error('TEST_EXECUTION_EXPLORATION_STATUS_INVALID')
  return result
}

function assertSafeObservation(input: HttpExplorationObservation): HttpExplorationObservation {
  const normalized = normalizeUiNetworkObservation({
    method: input.method,
    url: `${input.origin}${input.path}${input.queryParams.length ? `?${input.queryParams.map(name => `${encodeURIComponent(name)}=`).join('&')}` : ''}`,
    resourceType: 'fetch',
    requestHeaders: input.requestHeaders,
    requestBody: input.requestSchema,
    responseStatus: input.responseStatus,
    responseHeaders: input.contentType ? { 'content-type': input.contentType } : undefined,
    responseBody: input.responseSchema,
    page: input.observedFrom.page,
    action: input.observedFrom.action,
    actionType: input.observedFrom.actionType,
    sequence: input.observedFrom.sequence,
  })
  if (!normalized) throw new Error('TEST_EXECUTION_EXPLORATION_RESULT_INVALID')
  // Existing shapes are descriptors, not captured bodies; preserve them after
  // validating that they contain only the allowlisted schema vocabulary.
  normalized.requestSchema = input.requestSchema ? validateSchema(input.requestSchema) : undefined
  normalized.responseSchema = input.responseSchema ? validateSchema(input.responseSchema) : undefined
  normalized.queryParams = [...new Set(input.queryParams.map(safeFieldName))]
    .sort((left, right) => left.localeCompare(right, 'en'))
  normalized.confidence = Number(input.confidence)
  if (!Number.isFinite(normalized.confidence) || normalized.confidence < 0 || normalized.confidence > 1) throw new Error('TEST_EXECUTION_EXPLORATION_CONFIDENCE_INVALID')
  return normalized
}

function businessRequest(input: { method: string; url: URL; resourceType: string; contentType?: string }) {
  if (staticExtension.test(input.url.pathname) || lowValuePath.test(input.url.pathname) || lowValueHost.test(input.url.hostname)) return false
  if (allowedResourceTypes.has(input.resourceType)) return true
  if (input.contentType?.includes('json') || input.contentType?.includes('graphql')) return true
  if (input.method !== 'GET' && /(?:^|\/)(?:api|graphql|rest|rpc)(?:\/|$)/iu.test(input.url.pathname)) return true
  return false
}

function normalizeHeaders(value: unknown) {
  const headers = headerRecord(value)
  const result: Record<string, string> = {}
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim().toLocaleLowerCase()
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,100}$/u.test(name)) continue
    if (sensitiveName.test(name)) result[name] = '<REDACTED>'
    else if (preservedHeaderValues.has(name)) result[name] = redactFreeText(String(rawValue), 500)
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right, 'en')))
}

function headerRecord(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (Array.isArray(value)) {
    return Object.fromEntries(value.flatMap(entry => {
      if (Array.isArray(entry) && entry.length >= 2) return [[String(entry[0]), entry[1]]]
      if (entry && typeof entry === 'object') {
        const item = entry as { name?: unknown; value?: unknown }
        if (item.name !== undefined) return [[String(item.name), item.value]]
      }
      return []
    }))
  }
  const text = String(value)
  return Object.fromEntries(text.split(/\r?\n/u).flatMap(line => {
    const match = /^\s*([^:]+):\s*(.*)$/u.exec(line)
    return match ? [[match[1], match[2]]] : []
  }))
}

function schemaShape(value: unknown, fieldName?: string, depth = 0): ExplorationSchemaShape {
  if (fieldName && sensitiveName.test(fieldName)) return { type: inferredType(value), redacted: true }
  if (depth >= 6) return { type: inferredType(value) }
  const parsed = parseBody(value)
  if (parsed !== value) return schemaShape(parsed, fieldName, depth)
  if (parsed === null) return { type: 'null' }
  if (Array.isArray(parsed)) return {
    type: 'array',
    ...(parsed.length ? { items: schemaShape(parsed[0], undefined, depth + 1) } : {}),
  }
  if (typeof parsed === 'object') {
    const entries = Object.entries(parsed as Record<string, unknown>).slice(0, 100)
    const properties = Object.fromEntries(entries.map(([name, child]) => {
      const safeName = safeFieldName(name)
      return [safeName, schemaShape(child, safeName, depth + 1)]
    }))
    return { type: 'object', properties, required: Object.keys(properties).sort((left, right) => left.localeCompare(right, 'en')) }
  }
  return { type: inferredType(parsed) }
}

function validateSchema(input: ExplorationSchemaShape, depth = 0): ExplorationSchemaShape {
  if (depth > 6 || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('TEST_EXECUTION_EXPLORATION_SCHEMA_INVALID')
  if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null', 'unknown'].includes(input.type)) throw new Error('TEST_EXECUTION_EXPLORATION_SCHEMA_INVALID')
  const properties = input.properties
    ? Object.fromEntries(Object.entries(input.properties).slice(0, 100).map(([name, value]) => [safeFieldName(name), validateSchema(value, depth + 1)]))
    : undefined
  const required = properties && input.required
    ? [...new Set(input.required.map(safeFieldName).filter(name => Object.hasOwn(properties, name)))].sort((left, right) => left.localeCompare(right, 'en'))
    : undefined
  return {
    type: input.type,
    ...(properties ? { properties } : {}),
    ...(required ? { required } : {}),
    ...(input.items ? { items: validateSchema(input.items, depth + 1) } : {}),
    ...(input.redacted ? { redacted: true } : {}),
  }
}

function parseBody(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const text = value.trim().slice(0, 64 * 1024)
  if (!text) return ''
  try { return JSON.parse(text) as unknown } catch { /* body may be form or plain text */ }
  if (/^[^=&]+=[^=&]*(?:&[^=&]+=[^=&]*)*$/u.test(text)) {
    return Object.fromEntries([...new URLSearchParams(text).keys()].map(name => [name, '']))
  }
  return text
}

function inferredType(value: unknown): ExplorationSchemaShape['type'] {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  if (['string', 'boolean', 'object'].includes(typeof value)) return typeof value as 'string' | 'boolean' | 'object'
  return 'unknown'
}

function contentTypeValue(headers: Record<string, string>) {
  const value = headers['content-type']?.trim().toLocaleLowerCase()
  return value && value.length <= 200 ? value : undefined
}

function normalizedEndpointPath(pathname: string) {
  const normalized = pathname.split('/').map(segment => {
    const decoded = decodeURIComponentSafe(segment)
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(decoded)) return '{value}'
    if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(decoded)) return '{token}'
    if (/^[0-9]{2,}$/u.test(decoded)) return '{id}'
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(decoded)) return '{id}'
    if (/^[A-Za-z0-9_-]{24,}$/u.test(decoded) && /[0-9]/u.test(decoded)) return '{id}'
    return encodeURIComponent(decoded).replaceAll('%7B', '{').replaceAll('%7D', '}')
  }).join('/')
  return normalized.startsWith('/') ? normalized : `/${normalized}`
}

function safePage(value: unknown) {
  const raw = String(value ?? '/').trim()
  try { return normalizedEndpointPath(new URL(raw).pathname) } catch { /* relative page */ }
  try { return normalizedEndpointPath(new URL(raw, 'https://smarthub.invalid').pathname) } catch { return '/' }
}

function safeFieldName(value: unknown) {
  const name = String(value ?? '').trim().slice(0, 120)
  if (!name || /[\u0000-\u001F\u007F]/u.test(name)) return 'field'
  if (
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(name)
    || /\b(?:\d[ -]*?){7,19}\b/u.test(name)
    || /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(name)
  ) return 'redacted_field'
  return name
}

function redactFreeText(value: string, maximum: number) {
  return value
    .slice(0, maximum)
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/giu, 'Bearer <REDACTED>')
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '<REDACTED>')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '<REDACTED>')
    .replace(/\b(?:\d[ -]*?){13,19}\b/gu, '<REDACTED>')
    .replace(/\b(authorization|cookie|password|passwd|passcode|token|api[-_ ]?key|secret|session(?:[-_ ]?id)?|csrf(?:[-_ ]?token)?)\s*[:=]\s*[^\s,;]+/giu, '$1=<REDACTED>')
    .replace(/\b(authorization|cookie|password|passwd|passcode|token|api[-_ ]?key|secret|session(?:[-_ ]?id)?|csrf(?:[-_ ]?token)?)\s+(?:with|as|value|为|填写|输入)\s+[^\s,;]+/giu, '$1 <REDACTED>')
    .replace(/([?&][^=&#]{1,100}=)[^&#]*/gu, '$1<REDACTED>')
}

function allowedActionType(value: unknown): value is HttpExplorationObservation['observedFrom']['actionType'] {
  return ['navigate', 'click', 'fill', 'select', 'wait', 'other'].includes(String(value))
}

function identity(value: string, field: string) {
  const normalized = String(value ?? '').trim()
  if (!normalized || normalized.length > 500 || /[\u0000-\u001F\u007F]/u.test(normalized)) throw new Error(`TEST_EXECUTION_EXPLORATION_${field.toUpperCase()}_INVALID`)
  return normalized
}

function hashValue(value: string, field: string) {
  const normalized = String(value ?? '').trim()
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error(`TEST_EXECUTION_EXPLORATION_${field.toUpperCase()}_INVALID`)
  return normalized
}

function timestamp(value: string, field: string) {
  const normalized = String(value ?? '').trim()
  if (!normalized || !Number.isFinite(Date.parse(normalized))) throw new Error(`TEST_EXECUTION_EXPLORATION_${field.toUpperCase()}_INVALID`)
  return normalized
}

function decodeURIComponentSafe(value: string) {
  try { return decodeURIComponent(value) } catch { return value }
}

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
