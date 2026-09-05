import { createHash } from 'node:crypto'
import type { DatabaseState } from '../../domain/types.js'
import type { TestDesignState } from '../../domain/test-design-types.js'
import { canonicalSha256 } from '../canonical-json.js'
import { TestDesignError } from '../test-design-validation.js'

export function canonicalSha256Text(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

export function normalizeWorkspacePath(value: string) {
  return value.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
}

export function isWithinWorkspace(value: string) {
  const normalized = normalizeWorkspacePath(value)
  return normalized === 'workspace' || normalized.startsWith('workspace/')
}

export function safeWorkspaceSegment(value: string) {
  const encode = (character: string) => `%${character.codePointAt(0)!.toString(16).toUpperCase().padStart(2, '0')}`
  const source = value.normalize('NFC').trim() || '未命名版本'
  let safe = source
    .replace(/[%<>:"/\\|?*\u0000-\u001F]/gu, encode)
    .replace(/[. ]+$/gu, characters => [...characters].map(encode).join(''))
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(source)) safe = `${encode(source[0])}${safe.slice(1)}`
  return safe
}

export function assertProjectExists(state: DatabaseState, projectId: string) {
  required(
    state.projects.find(item => item.id === projectId),
    'PROJECT_NOT_FOUND',
    '项目不存在',
  )
}

export function structuralDiff(
  before: unknown,
  after: unknown,
  path = '',
): Array<{ path: string; before?: unknown; after?: unknown }> {
  if (before === undefined || after === undefined)
    return before === after
      ? []
      : [{ path: path || '/', ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) }]
  if (canonicalSha256(before) === canonicalSha256(after)) return []
  if (
    !before ||
    !after ||
    typeof before !== 'object' ||
    typeof after !== 'object' ||
    Array.isArray(before) ||
    Array.isArray(after)
  )
    return [{ path: path || '/', before, after }]
  const left = before as Record<string, unknown>
  const right = after as Record<string, unknown>
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .sort()
    .flatMap(key => structuralDiff(left[key], right[key], `${path}/${key}`))
}

export function findDesign(state: DatabaseState, projectVersionId: string, designId: string) {
  return required(
    readDesignState(state).designs.find(item => item.id === designId && item.projectVersionId === projectVersionId),
    'TEST_DESIGN_NOT_FOUND',
    '测试设计不存在',
  )
}

export function findRun(state: DatabaseState, projectVersionId: string, designId: string, runId: string) {
  findDesign(state, projectVersionId, designId)
  return required(
    readDesignState(state).runs.find(
      item => item.id === runId && item.testDesignId === designId && item.projectVersionId === projectVersionId,
    ),
    'TEST_DESIGN_RUN_NOT_FOUND',
    '测试设计运行不存在',
  )
}

export function findRunById(state: DatabaseState, runId: string) {
  return required(
    designState(state).runs.find(item => item.id === runId),
    'TEST_DESIGN_RUN_NOT_FOUND',
    '测试设计运行不存在',
  )
}

export function assertOpenVersion(state: DatabaseState, projectVersionId: string) {
  const version = required(
    state.projectVersions.find(item => item.id === projectVersionId),
    'PROJECT_VERSION_NOT_FOUND',
    '项目版本不存在',
  )
  if (version.status !== 'open') throw new TestDesignError('PROJECT_VERSION_READ_ONLY', '当前项目版本只读', 409)
}

export function designState(state: DatabaseState): TestDesignState {
  return (state.testDesignState ??= emptyTestDesignState())
}

export function readDesignState(state: DatabaseState): TestDesignState {
  return state.testDesignState ?? emptyTestDesignState()
}

function emptyTestDesignState(): TestDesignState {
  return {
    architectureVersion: 'single-agent-skills/v1',
    designs: [],
    runs: [],
    libraryCases: [],
    libraryVersions: [],
    suiteDrafts: [],
    suiteVersions: [],
    executionHandoffs: [],
  }
}

export function required<T>(value: T | null | undefined, code: string, message: string): T {
  if (value == null) throw new TestDesignError(code, message, code.endsWith('_NOT_FOUND') ? 404 : 409)
  return value
}

export function cleanRequired(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new TestDesignError('TEST_DESIGN_INPUT_INVALID', `${label} 不能为空且不能超过 ${max} 个字符`, 422)
  return value.trim()
}

export function newest(
  left: { createdAt?: string; publishedAt?: string },
  right: { createdAt?: string; publishedAt?: string },
) {
  return String(right.createdAt ?? right.publishedAt).localeCompare(String(left.createdAt ?? left.publishedAt))
}

export function now() {
  return new Date().toISOString()
}

export function errorCode(message: string) {
  return /^([A-Z][A-Z0-9_]+):/u.exec(message)?.[1] ?? 'TEST_DESIGN_RUN_FAILED'
}
