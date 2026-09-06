import { createHash } from 'node:crypto'
import { parse } from '@babel/parser'
import type { ExecutionReadEvidence, InputDeliveryManifest, TestExecutionAgentWorkspaceProjection } from '../domain/agent-types.js'
import type { ExecutionPackageCandidate, ExecutionRun } from '../domain/test-execution-types.js'
import { canonicalSha256 } from './canonical-json.js'

export interface ApiContractEvidence {
  kind: 'contract' | 'implementation' | 'observation'
  method: string
  path: string
  sourceRef: string
  contentSha256: string
  toolCallId: string
  /** Only a complete OpenAPI path item establishes the available method set. */
  methodsComplete: boolean
}

type Endpoint = Pick<ApiContractEvidence, 'method' | 'path' | 'methodsComplete'>
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
const hash = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex')

export function executionReadEvidence(workspace: TestExecutionAgentWorkspaceProjection, contentSha256: string): ExecutionReadEvidence {
  return {
    projectId: workspace.projectId, projectVersionId: workspace.projectVersionId,
    runId: workspace.runId, taskId: workspace.taskId, contentSha256,
    workspaceSha256: canonicalSha256({
      projectId: workspace.projectId, projectVersionId: workspace.projectVersionId,
      runId: workspace.runId, taskId: workspace.taskId,
      indexVersionId: workspace.indexVersionId, knowledgeBaseId: workspace.knowledgeBaseId,
      files: workspace.workspaceFiles.map(file => ({ path: file.logicalPath, hash: file.contentSha256, kind: file.evidenceKind ?? null })),
    }),
  }
}

/** Manifest is supplied by Pi's server tool registry, never by the candidate. */
export function resolveApiContractEvidence(
  manifest: InputDeliveryManifest,
  workspace: TestExecutionAgentWorkspaceProjection,
  run: Pick<ExecutionRun, 'id' | 'projectId' | 'projectVersionId' | 'environment' | 'knowledge'>,
): ApiContractEvidence[] {
  if (workspace.runId !== run.id || workspace.projectId !== run.projectId || workspace.projectVersionId !== run.projectVersionId) return []
  const result: ApiContractEvidence[] = []
  const root = (workspace.documentWorkspace.rootLogicalPath ?? workspace.documentWorkspace.logicalPath).replaceAll('\\', '/').replace(/\/$/u, '')
  const validRead = (read: ExecutionReadEvidence | undefined, digest: string) => read && canonicalSha256(read) === canonicalSha256(executionReadEvidence(workspace, digest))
  for (const read of manifest.toolReads ?? []) {
    const path = read.relativePath.replaceAll('\\', '/').replace(/^\.\//u, '')
    const file = workspace.workspaceFiles.find(file => file.logicalPath.replaceAll('\\', '/') === `${root}/${path}`)
    if (!file || !read.toolCallId || !validRead(read.executionEvidence, file.contentSha256) || hash(file.content) !== file.contentSha256) continue
    if (file.assetVersionId && !read.assetVersionIds.includes(file.assetVersionId)) continue
    const lines = file.content.split(/\r?\n/u)
    if (read.startLine < 1 || read.endLine < read.startLine || read.endLine > lines.length) continue
    const content = lines.slice(read.startLine - 1, read.endLine).join('\n')
    const kind = file.evidenceKind ?? (file.assetVersionId ? 'contract' : undefined)
    if (!kind) continue
    const endpoints = kind === 'observation'
      ? observationEndpoints(content, run)
      : kind === 'implementation'
        ? requestEndpoints(content).endpoints
        : contractEndpoints(content)
    for (const endpoint of endpoints) result.push({ ...endpoint, kind, sourceRef: `workspace:${path}:${read.startLine}-${read.endLine}`, contentSha256: file.contentSha256, toolCallId: read.toolCallId })
  }
  for (const read of manifest.knowledgeReads ?? []) {
    const evidence = read.executionEvidence
    if (!evidence || !read.toolCallId || !run.knowledge || run.knowledge.knowledgeBaseId !== workspace.knowledgeBaseId || read.indexVersionId !== run.knowledge.indexVersionId || read.indexVersionId !== workspace.indexVersionId) continue
    const { content, sourceSha256, ...scope } = evidence
    if (!validRead(scope, read.contentHash) || hash(content) !== read.contentHash || sourceSha256 !== canonicalSha256({ chunkId: read.chunkId, assetVersionId: read.assetVersionId, indexVersionId: read.indexVersionId, contentHash: read.contentHash })) continue
    for (const endpoint of contractEndpoints(content)) result.push({ ...endpoint, kind: 'contract', sourceRef: `knowledge:${read.indexVersionId}:${read.assetVersionId}:${read.chunkId}`, contentSha256: read.contentHash, toolCallId: read.toolCallId })
  }
  return result
}

export function apiContractEvidenceIssues(candidate: ExecutionPackageCandidate, evidence: readonly ApiContractEvidence[]): string[] {
  const extracted = candidate.files.map(file => requestEndpoints(file.content))
  const endpoints = extracted.flatMap(result => result.endpoints)
  const issues: string[] = []
  if (extracted.some(result => result.unresolved)) issues.push('动态 Endpoint/Method 无法与已读契约关联；请提供可解析的受管实现，或交人工补充契约后重新验证')
  if (!endpoints.length) issues.push('未找到可与契约关联的 API 请求；请读取依赖闭包中的受管 API 实现并提供可解析 Endpoint/Method')
  for (const endpoint of endpoints) if (!evidence.some(item => item.method === endpoint.method && apiPathMatches(item.path, endpoint.path))) {
    issues.push(`缺少 ${endpoint.method} ${endpoint.path} 的已读取、Hash 匹配且属于本 Run/ProjectVersion 的接口证据；请读取冻结 OpenAPI/接口说明、固定 Knowledge Chunk、受管 API 实现或本环境有效探索结果。旧读取记录缺少来源元数据时必须重读`)
  }
  return [...new Set(issues)]
}

export function apiPathMatches(contractPath: string, actualPath: string) {
  const expected = contractPath.split('/'), actual = actualPath.split('/')
  return expected.length === actual.length && expected.every((part, index) => /^\{[^/{}]+\}$/u.test(part) ? Boolean(actual[index]) : part === actual[index])
}

function contractEndpoints(content: string): Endpoint[] {
  try {
    const document = JSON.parse(content)
    if ((typeof document.openapi === 'string' && /^3\.\d+\.\d+$/u.test(document.openapi) || document.swagger === '2.0') && document.paths && typeof document.paths === 'object') {
      return Object.entries(document.paths).flatMap(([path, item]) => path.startsWith('/') && item && typeof item === 'object'
        ? Object.entries(item).filter(([method, operation]) => methods.has(method.toUpperCase()) && operation && typeof operation === 'object' && !Array.isArray(operation)).map(([method]) => ({ path, method: method.toUpperCase(), methodsComplete: !('$ref' in item) })) : [])
    }
  } catch { /* Markdown and YAML are recognized below, without guessing prose. */ }
  const result: Endpoint[] = []
  // Conservative block-style OpenAPI/Swagger YAML subset; unsupported YAML needs a JSON export.
  if (/^(?:openapi:\s*['"]?3\.|swagger:\s*['"]?2\.0)/mu.test(content)) {
    let inPaths = false, path: string | undefined
    for (const line of content.split(/\r?\n/u)) {
      if (/^paths:\s*$/u.test(line)) { inPaths = true; continue }
      if (inPaths && /^\S/u.test(line)) inPaths = false
      if (!inPaths) continue
      const pathMatch = /^  ['"]?(\/[^'"\s]*?)['"]?:\s*$/u.exec(line)
      if (pathMatch) { path = pathMatch[1]; continue }
      if (/^  \S/u.test(line)) path = undefined
      const method = /^    (get|post|put|patch|delete|head|options):\s*(?:\{\})?\s*$/u.exec(line)?.[1]
      if (path && method) result.push({ path, method: method.toUpperCase(), methodsComplete: false })
    }
  }
  // Explicit method + path statements in versioned interface documentation, never a bare keyword.
  for (const match of content.matchAll(/(?:^|\n)\s*(?:#{1,6}\s+|[-*]\s+)?`?(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s`<>]+)`?\s*(?:$|\n|[—–:：])/gu)) {
    result.push({ method: match[1], path: match[2], methodsComplete: false })
  }
  return result
}

function observationEndpoints(content: string, run: Pick<ExecutionRun, 'projectVersionId' | 'environment'>): Endpoint[] {
  try {
    const document = JSON.parse(content)
    if (document.schemaVersion !== 'project-version-exploration-context/v1' || document.authority !== 'runtime_observed_knowledge' || document.requirementTruth !== false || document.projectVersionId !== run.projectVersionId || document.environmentSignature !== run.environment.signature) return []
    return (Array.isArray(document.results) ? document.results : []).flatMap((value: Record<string, unknown>) => {
      if (value.projectVersionId !== run.projectVersionId || value.environmentSignature !== run.environment.signature || value.validationStatus !== 'validated' || value.reuseRecommendation !== 'prefer_reuse' || !value.sourceRunId || !value.sourceTaskId || !value.id || value.origin !== new URL(run.environment.baseUrl).origin || typeof value.path !== 'string' || !value.path.startsWith('/') || typeof value.method !== 'string' || !methods.has(value.method.toUpperCase())) return []
      return [{ method: value.method.toUpperCase(), path: value.path, methodsComplete: false }]
    })
  } catch { return [] }
}

/** Small expression reader; this is evidence correlation, not the network security boundary. */
function requestEndpoints(content: string): { endpoints: Endpoint[]; unresolved: boolean } {
  const endpoints: Endpoint[] = []
  let unresolved = false
  let ast: unknown
  try { ast = parse(content, { sourceType: 'module', plugins: ['typescript'] }) } catch { return { endpoints, unresolved: false } }
  const constants = new Map<string, unknown>()
  const declared = new Set<string>()
  const requestNames = new Set<string>()
  const requestProperties = new Set<string>()
  const dataNames = new Set<string>()
  const detachedRequestMethods = new Set<string>()
  const walk = (node: unknown, visit: (node: Record<string, unknown>) => void) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const item of node) walk(item, visit); return }
    const record = node as Record<string, unknown>
    visit(record)
    for (const [key, value] of Object.entries(record)) if (!['loc', 'comments', 'tokens'].includes(key)) walk(value, visit)
  }
  const typedRequest = (node: Record<string, unknown>) => JSON.stringify(node.typeAnnotation ?? {}).includes('"name":"APIRequestContext"')
  walk(ast, node => {
    if (node.type === 'Identifier' && typedRequest(node)) { requestNames.add(String(node.name)); requestProperties.add(String(node.name)) }
    if (node.type === 'ObjectPattern') for (const property of node.properties as Array<{ key?: { name?: string }; value?: { type?: string; name?: string } }>) {
      if (property.key?.name === 'request' && property.value?.type === 'Identifier' && property.value.name) requestNames.add(property.value.name)
    }
    if (node.type === 'VariableDeclaration') for (const declaration of node.declarations as Array<{ id: { type?: string; name?: string }; init?: unknown }>) {
      if (declaration.id.type !== 'Identifier' || !declaration.id.name) continue
      const name = declaration.id.name
      if (declared.has(name) || node.kind !== 'const') constants.delete(name)
      else constants.set(name, declaration.init)
      declared.add(name)
      const initializer = declaration.init as { type?: string; argument?: unknown; callee?: { type?: string; property?: { name?: string } } } | undefined
      const call = (initializer?.type === 'AwaitExpression' ? initializer.argument : initializer) as typeof initializer
      if (call?.type === 'CallExpression' && call.callee?.type === 'MemberExpression' && call.callee.property?.name === 'newContext') requestNames.add(name)
    }
  })
  // This reader deliberately has no general scope interpreter. A parameter
  // shadowing a constant must not borrow the outer constant's endpoint value.
  walk(ast, node => {
    if (!Array.isArray(node.params)) return
    walk(node.params, parameter => {
      if (parameter.type === 'Identifier') constants.delete(String(parameter.name))
    })
  })
  const isRequest = (value: unknown) => {
    const receiver = value as { type?: string; name?: string; object?: { type?: string }; property?: { name?: string } } | undefined
    return receiver?.type === 'Identifier' && requestNames.has(String(receiver.name))
      || receiver?.type === 'MemberExpression' && receiver.object?.type === 'ThisExpression' && requestProperties.has(String(receiver.property?.name))
  }
  // Bounded propagation handles managed request aliases, without treating arbitrary helpers as safe.
  for (let pass = 0; pass <= constants.size; pass += 1) {
    let changed = false
    for (const [name, value] of constants) {
      const initializer = value as { type?: string; name?: string; callee?: { type?: string; name?: string }; object?: unknown; property?: { name?: string } } | undefined
      if (!requestNames.has(name) && isRequest(initializer)) { requestNames.add(name); changed = true }
      if (!dataNames.has(name) && (initializer?.type === 'NewExpression' && initializer.callee?.type === 'Identifier' && ['Map', 'Set', 'WeakMap', 'WeakSet', 'URLSearchParams', 'Headers'].includes(String(initializer.callee.name)) || initializer?.type === 'Identifier' && dataNames.has(String(initializer.name)))) { dataNames.add(name); changed = true }
      if (initializer?.type === 'MemberExpression' && isRequest(initializer.object)) detachedRequestMethods.add(name)
    }
    if (!changed) break
  }
  walk(ast, node => {
    if (node.type !== 'VariableDeclarator' || !isRequest(node.init)) return
    const id = node.id as { type?: string; properties?: Array<{ value?: { type?: string; name?: string } }> }
    if (id?.type === 'ObjectPattern') for (const property of id.properties ?? []) if (property.value?.type === 'Identifier') detachedRequestMethods.add(String(property.value.name))
  })
  const literal = (value: unknown, depth = 0): string | undefined => {
    if (!value || typeof value !== 'object' || depth > 5) return undefined
    const node = value as Record<string, unknown>
    if (node.type === 'StringLiteral') return String(node.value)
    if (node.type === 'Identifier') return literal(constants.get(String(node.name)), depth + 1)
    if (node.type === 'NewExpression' && (node.callee as { name?: string })?.name === 'URL') return literal((node.arguments as unknown[])[0], depth + 1)
    return undefined
  }
  walk(ast, node => {
    if (node.type !== 'CallExpression') return
    const callee = node.callee as { type?: string; name?: string; computed?: boolean; property?: { name?: string }; object?: unknown }
    if (callee?.type === 'Identifier' && detachedRequestMethods.has(String(callee.name))) { unresolved = true; return }
    if (callee?.type !== 'MemberExpression') return
    const receiver = callee.object as { type?: string; name?: string; object?: { type?: string }; property?: { name?: string } } | undefined
    if (receiver?.type === 'Identifier' && dataNames.has(String(receiver.name)) && !requestNames.has(String(receiver.name))) return
    const managedReceiver = isRequest(receiver)
    if (callee.computed) { unresolved = true; return }
    let method = callee.property?.name?.toUpperCase()
    if (!managedReceiver) {
      if (method && (methods.has(method) || method === 'FETCH')) unresolved = true
      return
    }
    if (method === 'FETCH') {
      const options = (node.arguments as Array<{ type?: string; properties?: Array<{ type?: string; computed?: boolean; key?: { name?: string }; value?: unknown }> }>)[1]
      const methodProperty = options?.properties?.find(property => property.key?.name === 'method')
      if (!options) method = 'GET'
      else if (options.type !== 'ObjectExpression' || options.properties?.some(property => property.type === 'SpreadElement' || property.computed)) { unresolved = true; return }
      else method = methodProperty ? literal(methodProperty.value)?.toUpperCase() : 'GET'
      if (!method || !methods.has(method)) { unresolved = true; return }
    }
    if (!method || !methods.has(method)) return
    // request/APIRequestContext aliases are validated separately by the package Validator.
    const args = node.arguments as unknown[]
    const target = literal(args[0])
    if (!target) { unresolved = true; return }
    let path = target
    try { if (/^https?:\/\//u.test(target)) path = new URL(target).pathname } catch { unresolved = true; return }
    if (!path.startsWith('/')) { unresolved = true; return }
    endpoints.push({ method, path: path.split('?')[0], methodsComplete: false })
  })
  return { endpoints, unresolved }
}
