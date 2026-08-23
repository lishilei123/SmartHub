import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { parse } from '@babel/parser'
import type { Node } from '@babel/types'
import { canonicalJson, canonicalSha256 } from './canonical-json.js'
import type {
  ExecutionAssertionContract,
  ExecutionPackage,
  ExecutionPackageCandidate,
  ExecutionPackageFile,
  ExecutionRun,
  ExecutionRunStatus,
  ExecutionTaskStatus,
  FailureDiagnosis,
  FailureDiagnosisCandidate,
  FailureDiagnosisCategory,
  FrozenExecutionTestDataSnapshot,
  FrozenExecutionTaskInput,
  ScriptArtifact,
} from '../domain/test-execution-types.js'
import type {
  TestCaseContent,
  TestCaseExecutionSpec,
  TestCaseLibraryVersionMemberDetail,
  TestExecutionHandoffMember,
} from '../domain/test-design-types.js'

export const EXECUTION_PACKAGE_LIMITS = {
  maximumCandidateFiles: 16,
  maximumFiles: 100,
  maximumFileBytes: 512 * 1024,
  maximumPackageBytes: 4 * 1024 * 1024,
} as const

export const UNSUPPORTED_EXECUTION_METHODS: ReadonlyMap<string, string> = new Map([
  ['performance_tool', 'V1 不支持 performance_tool 执行方法'],
  ['long_running', 'V1 不支持 long_running 执行方法'],
  ['environment_matrix', 'V1 不支持 environment_matrix 执行方法'],
])

export const EXECUTION_RUN_TRANSITIONS: Readonly<Record<ExecutionRunStatus, readonly ExecutionRunStatus[]>> = {
  queued: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'partial', 'cancelled'],
  succeeded: [],
  failed: ['running'],
  partial: ['running'],
  cancelled: [],
}

export const EXECUTION_TASK_TRANSITIONS: Readonly<Record<ExecutionTaskStatus, readonly ExecutionTaskStatus[]>> = {
  pending: ['script_generating', 'ready', 'unsupported', 'blocked', 'cancelled'],
  script_generating: ['ready', 'blocked', 'waiting_manual', 'cancelled'],
  ready: ['running', 'blocked', 'waiting_manual', 'cancelled'],
  running: ['ready', 'passed', 'retrying', 'diagnosing', 'blocked', 'waiting_manual', 'cancelled'],
  retrying: ['running', 'blocked', 'cancelled'],
  diagnosing: ['repairing', 'failed', 'blocked', 'waiting_manual', 'cancelled'],
  repairing: ['ready', 'blocked', 'waiting_manual', 'cancelled'],
  passed: [],
  failed: ['ready'],
  blocked: ['ready'],
  unsupported: [],
  waiting_manual: ['ready'],
  cancelled: [],
}

const terminalTaskStates = new Set<ExecutionTaskStatus>([
  'passed',
  'failed',
  'blocked',
  'unsupported',
  'waiting_manual',
  'cancelled',
])

const diagnosisCategories = new Set<FailureDiagnosisCategory>([
  'product_defect',
  'script_defect',
  'selector_changed',
  'environment_defect',
  'test_data_defect',
  'flaky',
  'assertion_mismatch',
  'timeout',
  'unknown',
])

const allowedExternalStaticImports = new Set(['@playwright/test'])
const allowedWorkspaceSourceRoots = new Set(['tests', 'api', 'pages', 'helpers', 'fixtures'])
const forbiddenHttpClientModules = new Set([
  'axios',
  'superagent',
  'undici',
  'node:http',
  'node:https',
  'http',
  'https',
])
const maintenanceLocatorMethods = new Set([
  'locator',
  'frameLocator',
  'getByAltText',
  'getByLabel',
  'getByPlaceholder',
  'getByTestId',
  'getByText',
  'getByTitle',
])
const forbiddenIdentifiers = new Set([
  'eval',
  'Function',
  'require',
  'process',
  'global',
  'globalThis',
  'Buffer',
  'WebAssembly',
])
const forbiddenHttpRuntimeIdentifiers = new Set([
  'fetch',
  'XMLHttpRequest',
])
export class TestExecutionValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

export function assertRunTransition(from: ExecutionRunStatus, to: ExecutionRunStatus) {
  if (!EXECUTION_RUN_TRANSITIONS[from].includes(to)) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_RUN_TRANSITION_INVALID',
      `执行运行不允许从 ${from} 迁移到 ${to}`,
      { from, to },
    )
  }
}

export function assertTaskTransition(from: ExecutionTaskStatus, to: ExecutionTaskStatus) {
  if (!EXECUTION_TASK_TRANSITIONS[from].includes(to)) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_TASK_TRANSITION_INVALID',
      `执行任务不允许从 ${from} 迁移到 ${to}`,
      { from, to },
    )
  }
}

export function aggregateExecutionRunStatus(statuses: readonly ExecutionTaskStatus[]): ExecutionRunStatus | 'running' {
  if (!statuses.length) {
    throw new TestExecutionValidationError('TEST_EXECUTION_RUN_EMPTY', '执行运行必须包含至少一个任务')
  }
  if (statuses.some(status => !terminalTaskStates.has(status))) return 'running'
  if (statuses.every(status => status === 'cancelled')) return 'cancelled'
  if (statuses.every(status => status === 'passed')) return 'succeeded'
  if (statuses.every(status => status === 'failed')) return 'failed'
  return 'partial'
}

export function unsupportedExecutionMethodReason(method: string) {
  return UNSUPPORTED_EXECUTION_METHODS.get(method)
}

type ExecutionCreateRequestSource = Pick<
  ExecutionRun,
  'projectVersionId' | 'handoff' | 'environment' | 'createdBy'
>

export function executionCreateRequestCanonical(
  run: ExecutionCreateRequestSource,
) {
  return canonicalJson({
    schemaVersion: 'test-execution-create-request/v1',
    projectVersionId: run.projectVersionId,
    handoffId: run.handoff.handoffId,
    environmentId: run.environment.environmentId,
    createdBy: run.createdBy,
  })
}

export function executionCreateRequestSha256(
  run: ExecutionCreateRequestSource,
) {
  return createHash('sha256')
    .update(executionCreateRequestCanonical(run), 'utf8')
    .digest('hex')
}

export function freezeExecutionTaskInput(input: {
  handoffMember: TestExecutionHandoffMember
  libraryMember: TestCaseLibraryVersionMemberDetail
  testData?: FrozenExecutionTestDataSnapshot
}): FrozenExecutionTaskInput {
  const { handoffMember, libraryMember } = input
  if (handoffMember.caseId !== libraryMember.caseId || handoffMember.revision !== libraryMember.revision) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_HANDOFF_MEMBER_MISMATCH',
      'Handoff 成员与固定用例库成员不一致',
    )
  }
  if (!handoffMember.contentSha256 || handoffMember.contentSha256 !== libraryMember.contentSha256) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_HANDOFF_CONTENT_HASH_MISMATCH',
      'Handoff 用例 Hash 与固定用例库成员不一致',
    )
  }
  const contentSha256 = canonicalSha256(libraryMember.frozenContent)
  if (contentSha256 !== libraryMember.contentSha256) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_LIBRARY_CONTENT_HASH_MISMATCH',
      '固定用例内容 Hash 与正式用例库成员不一致',
    )
  }
  const executionSpec = handoffMember.executionSpec
  if (!executionSpec) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_SPEC_REQUIRED',
      'Handoff 成员缺少固定执行规范',
    )
  }
  if (executionSpec.method !== handoffMember.method) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_METHOD_MISMATCH',
      'Handoff 执行方法与固定执行规范不一致',
    )
  }
  if (canonicalSha256(executionSpec) !== canonicalSha256(resolveExecutionSpec(libraryMember.frozenContent, handoffMember.method))) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_SPEC_HASH_MISMATCH',
      'Handoff 执行规范与固定用例内容不一致',
    )
  }
  if (handoffMember.dimension && handoffMember.dimension !== libraryMember.frozenContent.dimension) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_DIMENSION_MISMATCH',
      'Handoff 测试维度与固定用例内容不一致',
    )
  }
  if (handoffMember.traceability && canonicalSha256(handoffMember.traceability) !== canonicalSha256(libraryMember.traceability)) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_TRACEABILITY_MISMATCH',
      'Handoff 追溯快照与固定用例库成员不一致',
    )
  }
  const requiredDataIds: string[] = []
  let testDataBindings: FrozenExecutionTaskInput['testDataBindings']
  if (requiredDataIds.length) {
    if (!input.testData) {
      throw new TestExecutionValidationError(
        'TEST_EXECUTION_TEST_DATA_REQUIRED',
        '固定用例需要测试数据，但执行 Run 缺少测试数据供给快照',
      )
    }
    const definitions = new Map(input.testData.requirements.map(requirement => [requirement.id, requirement]))
    const bindings = new Map(input.testData.bindings.map(binding => [binding.requirementId, binding]))
    testDataBindings = requiredDataIds.map(requirementId => {
      const requirement = definitions.get(requirementId)
      const binding = bindings.get(requirementId)
      if (!requirement || !binding) {
        throw new TestExecutionValidationError(
          'TEST_EXECUTION_TEST_DATA_BINDING_MISMATCH',
          `测试数据需求 ${requirementId} 缺少冻结定义或供给绑定`,
        )
      }
      return {
        requirement: structuredClone(requirement),
        binding: structuredClone(binding),
      }
    })
  }
  const frozen = {
    sourceVersionId: handoffMember.sourceVersionId,
    ordinal: handoffMember.ordinal,
    dedupKey: handoffMember.dedupKey,
    stage: handoffMember.stage,
    caseId: handoffMember.caseId,
    caseRevision: handoffMember.revision,
    caseContent: structuredClone(libraryMember.frozenContent),
    caseContentSha256: libraryMember.contentSha256,
    method: handoffMember.method,
    dimension: libraryMember.frozenContent.dimension,
    executionSpec: structuredClone(executionSpec),
    executionSpecSha256: canonicalSha256(executionSpec),
    ...(libraryMember.traceability ? { traceability: structuredClone(libraryMember.traceability) } : {}),
    ...(handoffMember.selectionReason ? { selectionReason: handoffMember.selectionReason } : {}),
    ...(handoffMember.readinessOverride ? { readinessOverride: structuredClone(handoffMember.readinessOverride) } : {}),
    ...(testDataBindings?.length ? { testDataBindings } : {}),
  }
  return { ...frozen, inputSha256: canonicalSha256(frozen) }
}

export function scriptCacheKey(input: Omit<ScriptArtifact, 'id' | 'cacheKey' | 'createdAt'>) {
  return canonicalSha256({
    schemaVersion: 'test-execution-script-cache/v1',
    caseId: input.caseId,
    caseRevision: input.caseRevision,
    method: input.method,
    caseContentSha256: input.caseContentSha256,
    executionSpecSha256: input.executionSpecSha256,
    ...(input.taskInputSha256 ? { taskInputSha256: input.taskInputSha256 } : {}),
    environmentSignature: input.environmentSignature,
    testScriptAgentVersion: input.testScriptAgentVersion,
    testScriptAgentConfigurationSha256: input.testScriptAgentConfigurationSha256,
  })
}

export function buildExecutionPackage(input: {
  candidate: ExecutionPackageCandidate
  task: FrozenExecutionTaskInput & { taskId: string }
  environmentSignature: string
  workspaceFiles?: readonly Pick<ExecutionPackageFile, 'path' | 'content'>[]
  baselineAssertions?: readonly ExecutionAssertionContract[]
}): ExecutionPackage {
  if (!['ui', 'api'].includes(input.task.method)) {
    throw new TestExecutionValidationError('TEST_EXECUTION_METHOD_UNSUPPORTED', '不支持的方法不能创建执行包')
  }
  const entrypoint = safePackagePath(input.candidate.entryFile)
  if (!entrypoint.startsWith(`tests/${input.task.method}/`)) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_PACKAGE_ENTRYPOINT_INVALID',
      `执行入口必须位于 tests/${input.task.method}/`,
    )
  }
  const files = resolveExecutionPackageFiles({
    candidateFiles: input.candidate.files,
    workspaceFiles: input.workspaceFiles ?? [],
    entrypoint,
  })
  const entry = files.find(file => file.path === entrypoint)
  if (!entry) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_PACKAGE_ENTRYPOINT_INVALID',
      `执行包必须包含入口 ${entrypoint}`,
    )
  }
  const assertions = validateEntrypointSource(
    entry.content,
    input.task.executionSpec,
    input.task.caseId,
  )
  if (input.baselineAssertions) assertProtectedAssertions(input.baselineAssertions, assertions)
  const protectedAssertionSha256 = canonicalSha256(assertions)
  const manifestBase = {
    schemaVersion: 'execution-package/v1' as const,
    taskId: input.task.taskId,
    caseId: input.task.caseId,
    caseRevision: input.task.caseRevision,
    method: input.task.method as 'ui' | 'api',
    entrypoint,
    taskInputSha256: input.task.inputSha256,
    caseContentSha256: input.task.caseContentSha256,
    executionSpecSha256: input.task.executionSpecSha256,
    environmentSignature: input.environmentSignature,
    files: files.map(({ path, contentSha256, size }) => ({ path, contentSha256, size })),
    assertions,
    protectedAssertionSha256,
  }
  return {
    manifest: { ...manifestBase, packageSha256: canonicalSha256(manifestBase) },
    files,
  }
}

/** Stable Playwright title suffix owned by the Execution Binding. */
export function executionEntrySymbol(caseId: string) {
  return `[${safeIdentity(caseId, 'caseId')}]`
}

/**
 * Revalidates a persisted Binding against the current entry source. This is
 * intentionally AST based: a comment, helper string or partial Case ID is not
 * an executable Playwright entry.
 */
export function assertExecutionBindingEntry(
  source: string,
  caseId: string,
  entrySymbol: string,
) {
  const expected = executionEntrySymbol(caseId)
  if (entrySymbol !== expected) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_BINDING_ENTRY_SYMBOL_INVALID',
      `Execution Binding entrySymbol 必须为 ${expected}`,
    )
  }
  entryTestCallback(parseWorkspaceSource(source), caseId)
}

export function assertExecutionPackageIntegrity(input: {
  package: ExecutionPackage
  task: FrozenExecutionTaskInput & { taskId: string }
  environmentSignature: string
  expectedPackageSha256: string
}) {
  const rebuilt = buildExecutionPackage({
    candidate: {
      entryFile: input.package.manifest.entrypoint,
      files: input.package.files
        .filter(file => file.path === input.package.manifest.entrypoint),
      summary: 'Runner boundary validation',
    },
    task: input.task,
    environmentSignature: input.environmentSignature,
    workspaceFiles: input.package.files,
  })
  if (
    canonicalSha256(rebuilt) !== canonicalSha256(input.package)
    || rebuilt.manifest.packageSha256 !== input.expectedPackageSha256
  ) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_PACKAGE_INTEGRITY_INVALID',
      '执行包内容、Manifest 或固定输入不一致',
    )
  }
  return rebuilt
}

export function validateFailureDiagnosisCandidate(
  value: unknown,
): FailureDiagnosisCandidate {
  const candidate = record(value, '诊断候选必须是对象')
  if (candidate.schemaVersion !== undefined && candidate.schemaVersion !== 'failure-analysis/v1') {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_DIAGNOSIS_SCHEMA_INVALID',
      '诊断候选 schemaVersion 无效',
    )
  }
  const allowed = new Set(['schemaVersion', 'category', 'reason', 'evidence'])
  if (Object.keys(candidate).some(key => !allowed.has(key))) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_DIAGNOSIS_SYSTEM_FIELD_FORBIDDEN',
      '诊断候选不能提交任务、Revision、Attempt、Artifact 或修复策略字段',
    )
  }
  const category = text(candidate.category, 'category') as FailureDiagnosisCategory
  if (!diagnosisCategories.has(category)) throw new TestExecutionValidationError('TEST_EXECUTION_DIAGNOSIS_CATEGORY_INVALID', '诊断分类无效')
  return {
    category,
    reason: text(candidate.reason, 'reason', 4_000),
    evidence: text(candidate.evidence, 'evidence', 4_000),
  }
}

export function automaticRepairAllowed(diagnosis: Pick<FailureDiagnosis, 'category'>, repairCount: number) {
  if (!Number.isInteger(repairCount) || repairCount < 0) {
    throw new TestExecutionValidationError('TEST_EXECUTION_REPAIR_COUNT_INVALID', '修复次数无效')
  }
  return repairCount < 2
    && ['script_defect', 'selector_changed'].includes(diagnosis.category)
}

export function scriptMaintenanceSemanticSha256(source: string) {
  let ast: ReturnType<typeof parse>
  try {
    ast = parse(source, { sourceType: 'module', plugins: ['typescript'], errorRecovery: false })
  } catch (cause) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_SCRIPT_SYNTAX_INVALID',
      cause instanceof Error ? cause.message : '执行脚本语法无效',
    )
  }
  return canonicalSha256(normalizeMaintenanceAst(ast))
}

function normalizeMaintenanceAst(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(normalizeMaintenanceAst)
  const node = isAstNode(value) ? value : undefined
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === undefined || ['start', 'end', 'loc', 'extra', 'leadingComments', 'trailingComments', 'innerComments'].includes(key)) continue
    if (key === 'arguments' && node && maintenanceLocatorCall(node) && Array.isArray(child)) {
      result[key] = child.map((argument, index) => index === 0 && maintenanceLocatorToken(argument)
        ? '__smarthub_maintenance_locator__'
        : normalizeMaintenanceAst(argument))
      continue
    }
    result[key] = normalizeMaintenanceAst(child)
  }
  return result
}

function maintenanceLocatorCall(node: Node) {
  return node.type === 'CallExpression'
    && node.callee.type === 'MemberExpression'
    && !node.callee.computed
    && node.callee.property.type === 'Identifier'
    && maintenanceLocatorMethods.has(node.callee.property.name)
}

function maintenanceLocatorToken(value: unknown) {
  return isAstNode(value)
    && (value.type === 'StringLiteral' || value.type === 'RegExpLiteral')
}

function normalizeCandidateFiles(candidateFiles: ExecutionPackageCandidate['files']): ExecutionPackageFile[] {
  if (!Array.isArray(candidateFiles) || !candidateFiles.length || candidateFiles.length > EXECUTION_PACKAGE_LIMITS.maximumCandidateFiles) {
    throw new TestExecutionValidationError('TEST_EXECUTION_PACKAGE_FILE_COUNT_INVALID', '执行包文件数无效')
  }
  const paths = new Set<string>()
  return candidateFiles.map(candidate => {
    const path = safePackagePath(candidate.path)
    assertWorkspaceSourcePath(path)
    if (paths.has(path.toLocaleLowerCase())) throw new TestExecutionValidationError('TEST_EXECUTION_PACKAGE_PATH_DUPLICATE', `执行包路径重复：${path}`)
    paths.add(path.toLocaleLowerCase())
    if (typeof candidate.content !== 'string' || candidate.content.includes('\0')) throw new TestExecutionValidationError('TEST_EXECUTION_PACKAGE_CONTENT_INVALID', `执行包文件内容无效：${path}`)
    const size = Buffer.byteLength(candidate.content, 'utf8')
    if (!size || size > EXECUTION_PACKAGE_LIMITS.maximumFileBytes) {
      throw new TestExecutionValidationError('TEST_EXECUTION_PACKAGE_SIZE_INVALID', '执行包超过大小限制')
    }
    const contentSha256 = sha256(candidate.content)
    return { path, content: candidate.content, contentSha256, size }
  }).sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

function resolveExecutionPackageFiles(input: {
  candidateFiles: ExecutionPackageCandidate['files']
  workspaceFiles: readonly Pick<ExecutionPackageFile, 'path' | 'content'>[]
  entrypoint: string
}) {
  const candidateFiles = normalizeCandidateFiles(input.candidateFiles)
  const sources = new Map<string, string>()
  for (const file of input.workspaceFiles) {
    const path = safePackagePath(file.path)
    if (!workspaceSourcePath(path)) continue
    if (typeof file.content !== 'string' || file.content.includes('\0')) {
      throw new TestExecutionValidationError('TEST_EXECUTION_PACKAGE_CONTENT_INVALID', `Workspace 文件内容无效：${path}`)
    }
    sources.set(path, file.content)
  }
  for (const file of candidateFiles) sources.set(file.path, file.content)

  const pending = [input.entrypoint]
  const included = new Set<string>()
  while (pending.length) {
    const path = pending.pop()!
    if (included.has(path)) continue
    const source = sources.get(path)
    if (source === undefined) {
      throw new TestExecutionValidationError(
        'TEST_EXECUTION_WORKSPACE_IMPORT_UNRESOLVED',
        `Workspace 源文件不存在：${path}`,
      )
    }
    included.add(path)
    const inspected = inspectWorkspaceSource(path, source)
    for (const specifier of inspected.relativeImports) {
      const dependency = resolveWorkspaceImport(path, specifier, sources)
      if (!included.has(dependency)) pending.push(dependency)
    }
  }
  const unreachableCandidate = candidateFiles.find(file => !included.has(file.path))
  if (unreachableCandidate) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_WORKSPACE_FILE_UNREACHABLE',
      `候选文件未被入口依赖闭包引用：${unreachableCandidate.path}`,
    )
  }

  let totalBytes = 0
  const files = [...included]
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map(path => {
      const content = sources.get(path)!
      const size = Buffer.byteLength(content, 'utf8')
      totalBytes += size
      if (!size || size > EXECUTION_PACKAGE_LIMITS.maximumFileBytes || totalBytes > EXECUTION_PACKAGE_LIMITS.maximumPackageBytes) {
        throw new TestExecutionValidationError('TEST_EXECUTION_PACKAGE_SIZE_INVALID', '执行包超过大小限制')
      }
      return { path, content, contentSha256: sha256(content), size }
    })
  if (files.length > EXECUTION_PACKAGE_LIMITS.maximumFiles) {
    throw new TestExecutionValidationError('TEST_EXECUTION_PACKAGE_FILE_COUNT_INVALID', '执行包依赖闭包文件数无效')
  }
  return files
}

function inspectWorkspaceSource(path: string, source: string) {
  const ast = parseWorkspaceSource(source)
  const relativeImports: string[] = []
  walkAst(ast, (node, parent) => {
    const staticModule = staticModuleSpecifier(node)
    if (staticModule !== undefined) {
      if (staticModule.startsWith('.')) relativeImports.push(staticModule)
      else if (!allowedExternalStaticImports.has(staticModule)) {
        const reason = forbiddenHttpClientModules.has(staticModule)
          ? `API HTTP 请求只能使用 @playwright/test，禁止导入 ${staticModule}`
          : `不允许导入模块 ${staticModule}`
        rejectSource(reason)
      }
    }
    if (node.type === 'ImportExpression' || node.type === 'CallExpression' && node.callee.type === 'Import') rejectSource('不允许动态 import')
    if (node.type === 'Identifier' && forbiddenIdentifiers.has(node.name) && isRuntimeIdentifier(node, parent)) rejectSource(`不允许访问 ${node.name}`)
    if (node.type === 'Identifier' && forbiddenHttpRuntimeIdentifiers.has(node.name) && isRuntimeIdentifier(node, parent)) {
      rejectSource(`API HTTP 请求只能使用 @playwright/test，禁止访问 ${node.name}`)
    }
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && forbiddenIdentifiers.has(node.callee.name)) rejectSource(`不允许调用 ${node.callee.name}`)
    if (
      path.startsWith('api/')
      && node.type === 'CallExpression'
      && node.callee.type === 'Identifier'
      && node.callee.name === 'expect'
    ) rejectSource('API Client 只负责请求与复用操作，业务断言必须保留在 Case Entry')
    if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && forbiddenIdentifiers.has(node.callee.name)) rejectSource(`不允许构造 ${node.callee.name}`)
    const literal = staticTextLiteral(node)
    if (literal && /^https?:\/\//iu.test(literal)) {
      rejectSource('Playwright page/request 必须使用当前 ExecutionRun baseUrl，禁止硬编码绝对 Host')
    }
    if (
      node.type === 'ObjectProperty'
      && !node.computed
      && propertyName(node.key)
      && /^(?:authorization|cookie)$/iu.test(propertyName(node.key)!)
      && staticTextLiteral(node.value)?.trim()
    ) rejectSource('禁止在 Execution Workspace 写死 Authorization 或 Cookie')
  })
  return { ast, relativeImports }
}

function validateEntrypointSource(
  source: string,
  executionSpec: TestCaseExecutionSpec,
  caseId: string,
): ExecutionAssertionContract[] {
  const ast = parseWorkspaceSource(source)
  const callback = entryTestCallback(ast, caseId)
  assertAuthIsolation(ast, executionSpec)
  assertBusinessClosure(ast, executionSpec)
  const fixtures = callbackFixtureNames(callback)
  if (executionSpec.method === 'api' && !fixtures.has('request')) {
    rejectSource('API Case 必须使用 Playwright Test request fixture / APIRequestContext')
  }
  if (executionSpec.method === 'ui' && !fixtures.has('page')) {
    rejectSource('UI Case 必须使用 Playwright page 完成真实 UI 测试目标')
  }
  const anchors = new Map<string, { matcher: string; modifiers: string[]; expected: Node | null }>()
  walkAst(callback, (node) => {
    if (node.type === 'ExpressionStatement') {
      const comments = [...(node.leadingComments ?? []), ...(node.innerComments ?? [])]
      const anchorComment = comments.map(comment => comment.value.match(/smarthub:assert\s+([A-Za-z0-9._-]+)/u)?.[1]).find(Boolean)
      if (!anchorComment) return
      if (anchors.has(anchorComment)) rejectSource(`断言锚点重复：${anchorComment}`)
      const parsed = assertionExpression(node.expression)
      if (!parsed) rejectSource(`断言锚点 ${anchorComment} 必须绑定 Playwright expect 断言`)
      anchors.set(anchorComment, parsed)
    }
  })
  const checks = verificationChecks(executionSpec)
  if (!checks.length) throw new TestExecutionValidationError('TEST_EXECUTION_VERIFICATION_CHECK_REQUIRED', '固定执行规范至少需要一个 Verification Check')
  const expectedKeys = new Set(checks.map(check => check.key))
  const unexpectedAnchor = [...anchors.keys()].find(key => !expectedKeys.has(key))
  if (unexpectedAnchor) rejectSource(`存在未声明的断言锚点：${unexpectedAnchor}`)
  return checks.map(check => {
    const assertion = anchors.get(check.key)
    if (!assertion) rejectSource(`缺少 Verification Check 断言锚点：${check.key}`)
    return {
      verificationCheckKey: check.key,
      verificationCheckSha256: canonicalSha256(check),
      anchor: `smarthub:assert ${check.key}`,
      matcher: assertion.matcher,
      modifiers: assertion.modifiers,
      expectedSemanticsSha256: canonicalSha256({
        verificationCheck: check,
        matcher: assertion.matcher,
        modifiers: assertion.modifiers,
        expected: normalizeAst(assertion.expected),
      }),
    }
  })
}

function assertAuthIsolation(
  ast: ReturnType<typeof parse>,
  executionSpec: TestCaseExecutionSpec,
) {
  if (!authIsolationRequired(executionSpec.testCase)) return
  let sharedFixtureImport = false
  let configuredStorageState = false
  walkAst(ast, node => {
    if (node.type === 'ImportDeclaration' && String(node.source.value) !== '@playwright/test') {
      sharedFixtureImport ||= node.specifiers.some(specifier =>
        specifier.local.name === 'test'
        || specifier.type === 'ImportSpecifier'
          && (specifier.imported.type === 'Identifier'
            ? specifier.imported.name === 'test'
            : specifier.imported.value === 'test'))
    }
    if (
      node.type === 'CallExpression'
      && node.callee.type === 'MemberExpression'
      && !node.callee.computed
      && node.callee.object.type === 'Identifier'
      && node.callee.object.name === 'test'
      && node.callee.property.type === 'Identifier'
      && node.callee.property.name === 'use'
      && node.arguments[0]?.type === 'ObjectExpression'
    ) {
      configuredStorageState ||= node.arguments[0].properties.some(property =>
        property.type === 'ObjectProperty'
        && propertyName(property.key) === 'storageState'
        && property.value.type !== 'NullLiteral'
        && !(property.value.type === 'Identifier' && property.value.name === 'undefined'))
    }
  })
  if (sharedFixtureImport || configuredStorageState) {
    rejectSource('登录、退出、未登录、会话失效、角色切换或账号隔离 Case 必须使用 fresh/anonymous/isolated Context，不能加载共享认证 Fixture/storageState')
  }
}

function authIsolationRequired(testCase: TestCaseContent) {
  const intent = [testCase.title, ...testCase.steps, ...testCase.expectedResults]
    .join('\n')
    .toLocaleLowerCase()
    .replace(/(?:成功)?登录后|after\s+(?:logging\s+in|login)/giu, '')
  return /(?:登录|登出|退出登录|未登录|未经认证|匿名访问|会话失效|会话过期|token\s*过期|cookie\s*失效|角色切换|账号隔离|登录安全|多会话|\blog\s*in\b|\blogin\b|\blogout\b|unauthenticated|anonymous|session\s*expir|token\s*expir|cookie\s*expir|role\s*switch|account\s*isolation|multi[- ]session)/iu.test(intent)
}

function assertBusinessClosure(
  ast: ReturnType<typeof parse>,
  executionSpec: TestCaseExecutionSpec,
) {
  const expected = executionSpec.testCase.expectedResults.join('\n').toLocaleLowerCase()
  const requiresReadBack = /(?:查询确认|查询成功|再次查询|重新查询|刷新后|重新进入|重新打开|仍为|仍然|持久化|最终状态|不存在|删除后|read\s*back|re-?query|reload|refresh|re-?enter|persisted|eventual\s+state|no\s+longer\s+exists)/iu.test(expected)
  if (!requiresReadBack) return
  const mutationPositions: number[] = []
  const readBackPositions: number[] = []
  walkAst(ast, node => {
    if (
      node.type !== 'CallExpression'
      || node.callee.type !== 'MemberExpression'
      || node.callee.computed
      || node.callee.property.type !== 'Identifier'
    ) return
    const method = node.callee.property.name.toLocaleLowerCase()
    const position = node.start ?? -1
    if (executionSpec.method === 'api') {
      if (/^(?:post|put|patch|delete|create|update|remove|save|submit|transition|complete|cancel|approve|reject|publish|archive|restore|assign|set[a-z0-9_]*)$/u.test(method)) mutationPositions.push(position)
      if (/^(?:get|read|find|detail|query|list|fetch|reload|refresh)$/u.test(method)) readBackPositions.push(position)
    } else {
      if (/^(?:click|dblclick|fill|press|presssequentially|check|uncheck|selectoption|setchecked|dragto)$/u.test(method)) mutationPositions.push(position)
      if (/^(?:reload|goto|waitforurl)$/u.test(method)) readBackPositions.push(position)
    }
  })
  const readBackObserved = mutationPositions.some(mutation =>
    readBackPositions.some(readBack => readBack > mutation))
  if (!readBackObserved) {
    rejectSource(executionSpec.method === 'api'
      ? 'Expected Result 要求持久化业务闭环，API 脚本必须包含后续读取/查询并通过受保护断言验证最终状态'
      : 'Expected Result 要求持久化业务闭环，UI 脚本必须刷新、重新进入或重新导航并通过受保护断言验证最终状态')
  }
}

function parseWorkspaceSource(source: string) {
  try {
    return parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: false,
    })
  } catch (cause) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_SCRIPT_SYNTAX_INVALID',
      cause instanceof Error ? cause.message : '执行脚本语法无效',
    )
  }
}

function staticModuleSpecifier(node: Node) {
  if (
    node.type === 'ImportDeclaration'
    || node.type === 'ExportNamedDeclaration'
    || node.type === 'ExportAllDeclaration'
  ) return node.source ? String(node.source.value) : undefined
  if (
    node.type === 'TSImportEqualsDeclaration'
    && node.moduleReference.type === 'TSExternalModuleReference'
  ) return String(node.moduleReference.expression.value)
  return undefined
}

function resolveWorkspaceImport(
  importer: string,
  specifier: string,
  sources: ReadonlyMap<string, string>,
) {
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier))
  if (
    posix.isAbsolute(base)
    || base === '..'
    || base.startsWith('../')
  ) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_WORKSPACE_IMPORT_ESCAPE',
      `相对导入越过 Execution Workspace：${importer} -> ${specifier}`,
    )
  }
  const withoutJsExtension = base.replace(/\.(?:mjs|cjs|js)$/iu, '')
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${withoutJsExtension}.ts`,
    `${withoutJsExtension}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]
  const target = [...new Set(candidates)].find(candidate => sources.has(candidate))
  if (!target || !workspaceSourcePath(target)) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_WORKSPACE_IMPORT_UNRESOLVED',
      `相对导入无法解析到安全 Workspace 源文件：${importer} -> ${specifier}`,
    )
  }
  return target
}

function assertWorkspaceSourcePath(path: string) {
  if (!workspaceSourcePath(path)) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_PACKAGE_PATH_INVALID',
      `执行源码只能位于 tests、api、pages、helpers 或 fixtures：${path}`,
    )
  }
}

function workspaceSourcePath(path: string) {
  const [root] = path.split('/')
  return allowedWorkspaceSourceRoots.has(root)
    && /\.(?:ts|tsx)$/iu.test(path)
}

function entryTestCallback(ast: ReturnType<typeof parse>, caseId: string): Node {
  const entrySymbol = executionEntrySymbol(caseId)
  const callbacks: Node[] = []
  walkAst(ast, node => {
    if (
      node.type !== 'CallExpression'
      || node.callee.type !== 'Identifier'
      || node.callee.name !== 'test'
      || node.arguments[0]?.type !== 'StringLiteral'
    ) return
    if (!entryTitleMatches(node.arguments[0].value, entrySymbol)) return
    const callback = node.arguments[1]
    if (
      callback?.type === 'ArrowFunctionExpression'
      || callback?.type === 'FunctionExpression'
    ) callbacks.push(callback)
  })
  if (callbacks.length !== 1) {
    rejectSource(`入口文件必须且只能包含一个以 ${entrySymbol} 结尾的 Playwright test`)
  }
  return callbacks[0]
}

function entryTitleMatches(title: string, entrySymbol: string) {
  return title === entrySymbol || title.endsWith(` ${entrySymbol}`)
}

function callbackFixtureNames(callback: Node) {
  const result = new Set<string>()
  if (
    callback.type !== 'ArrowFunctionExpression'
    && callback.type !== 'FunctionExpression'
  ) return result
  const parameter = callback.params[0]
  if (parameter?.type !== 'ObjectPattern') return result
  for (const property of parameter.properties) {
    if (property.type !== 'ObjectProperty') continue
    const name = propertyName(property.key)
    if (name) result.add(name)
  }
  return result
}

function propertyName(node: Node) {
  return node.type === 'Identifier'
    ? node.name
    : node.type === 'StringLiteral'
      ? node.value
      : undefined
}

function staticTextLiteral(node: Node) {
  if (node.type === 'StringLiteral') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map(quasi => quasi.value.cooked ?? quasi.value.raw).join('')
  }
  return undefined
}

function assertProtectedAssertions(baseline: readonly ExecutionAssertionContract[], candidate: readonly ExecutionAssertionContract[]) {
  if (canonicalSha256(baseline) !== canonicalSha256(candidate)) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_PROTECTED_ASSERTION_CHANGED',
      '脚本修复不能修改 Verification Check、断言匹配器或期望语义',
    )
  }
}

function assertionExpression(expression: Node): { matcher: string; modifiers: string[]; expected: Node | null } | null {
  if (expression.type === 'AwaitExpression') return assertionExpression(expression.argument)
  if (expression.type !== 'CallExpression' || expression.callee.type !== 'MemberExpression' || expression.callee.computed) return null
  if (expression.callee.property.type !== 'Identifier' || !expression.callee.property.name.startsWith('to')) return null
  const matcher = expression.callee.property.name
  const modifiers: string[] = []
  let current: Node = expression.callee.object
  while (current.type === 'MemberExpression' && !current.computed && current.property.type === 'Identifier') {
    modifiers.unshift(current.property.name)
    current = current.object
  }
  if (current.type !== 'CallExpression' || current.callee.type !== 'Identifier' || current.callee.name !== 'expect') return null
  return { matcher, modifiers, expected: expression.arguments[0] && expression.arguments[0].type !== 'SpreadElement' ? expression.arguments[0] : null }
}

function walkAst(root: Node, visit: (node: Node, parent: Node | null) => void) {
  const stack: Array<{ node: Node; parent: Node | null }> = [{ node: root, parent: null }]
  while (stack.length) {
    const current = stack.pop()!
    visit(current.node, current.parent)
    for (const value of Object.values(current.node)) {
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) if (isAstNode(value[index])) stack.push({ node: value[index], parent: current.node })
      } else if (isAstNode(value)) stack.push({ node: value, parent: current.node })
    }
  }
}

function isRuntimeIdentifier(node: Node & { type: 'Identifier' }, parent: Node | null) {
  if (!parent) return true
  if ((parent.type === 'ObjectProperty' || parent.type === 'ObjectMethod' || parent.type === 'ClassMethod') && parent.key === node && !parent.computed) return false
  if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return false
  if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier') return false
  if (parent.type.startsWith('TS')) return false
  return true
}

function normalizeAst(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(normalizeAst)
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (['start', 'end', 'loc', 'extra', 'leadingComments', 'trailingComments', 'innerComments'].includes(key)) continue
    result[key] = normalizeAst(child)
  }
  return result
}

function verificationChecks(spec: TestCaseExecutionSpec) {
  return spec.testCase.expectedResults.map((description, index) => ({ key: `expected-${index + 1}`, description }))
}

function resolveExecutionSpec(content: TestCaseContent, method: string): TestCaseExecutionSpec {
  if (method !== 'ui' && method !== 'api' || !content.executionMethods.includes(method)) throw new TestExecutionValidationError('TEST_EXECUTION_METHOD_NOT_IN_CASE', '固定用例不包含 Handoff 执行方法')
  return { schemaVersion: 'test-script-input/v1', method, testCase: structuredClone(content) }
}

function safePackagePath(value: string) {
  const normalized = String(value ?? '').trim().replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized) || normalized.includes('\0') || normalized.length > 500) {
    throw new TestExecutionValidationError('TEST_EXECUTION_PACKAGE_PATH_INVALID', `执行包路径不安全：${value}`)
  }
  const parts = normalized.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || part.length > 120 || /[<>:"|?*\u0000-\u001F]/u.test(part) || /[. ]$/u.test(part) || windowsReserved(part))) {
    throw new TestExecutionValidationError('TEST_EXECUTION_PACKAGE_PATH_INVALID', `执行包路径不安全：${value}`)
  }
  return parts.join('/')
}

function safeIdentity(value: string, label: string) {
  const result = String(value ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(result)) throw new TestExecutionValidationError('TEST_EXECUTION_IDENTITY_INVALID', `${label} 格式无效`)
  return result
}

function rejectSource(message: string): never {
  throw new TestExecutionValidationError('TEST_EXECUTION_SCRIPT_UNSAFE', message)
}

function text(value: unknown, label: string, maximum = 500) {
  const result = String(value ?? '').trim()
  if (!result || result.length > maximum) throw new TestExecutionValidationError('TEST_EXECUTION_DIAGNOSIS_INVALID', `${label} 必须是 1 到 ${maximum} 个字符`)
  return result
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TestExecutionValidationError('TEST_EXECUTION_DIAGNOSIS_INVALID', message)
  return value as Record<string, unknown>
}

function isAstNode(value: unknown): value is Node {
  return Boolean(value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string')
}

function windowsReserved(segment: string) {
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment)
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}
