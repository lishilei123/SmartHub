import { createHash } from 'node:crypto'
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
  maximumFiles: 4,
  maximumFileBytes: 512 * 1024,
  maximumPackageBytes: 1024 * 1024,
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

const allowedStaticImports = new Set(['@playwright/test', './smarthub-fixture.js'])
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
const forbiddenModulePrefixes = [
  'node:',
  'child_process',
  'fs',
  'net',
  'tls',
  'dns',
  'dgram',
  'cluster',
  'worker_threads',
  'module',
  'vm',
  'os',
]

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
  const requiredDataIds = [...new Set(libraryMember.frozenContent.dataRequirementIds)]
    .sort((left, right) => left.localeCompare(right, 'en'))
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
  baselineAssertions?: readonly ExecutionAssertionContract[]
  parentScriptRevisionId?: string
}): ExecutionPackage {
  const repairing = input.baselineAssertions !== undefined
  const expectedSchemaVersion = repairing ? 'script-repair/v1' : 'test-script-generation/v1'
  if (input.candidate.schemaVersion !== expectedSchemaVersion) {
    throw new TestExecutionValidationError('TEST_EXECUTION_PACKAGE_SCHEMA_INVALID', '脚本候选 schemaVersion 无效')
  }
  if (input.candidate.taskId !== input.task.taskId) {
    throw new TestExecutionValidationError('TEST_EXECUTION_PACKAGE_TASK_MISMATCH', '脚本候选引用了错误任务')
  }
  if (
    repairing
      ? !input.parentScriptRevisionId
        || input.candidate.parentScriptRevisionId !== input.parentScriptRevisionId
      : input.candidate.parentScriptRevisionId !== undefined
  ) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_PACKAGE_PARENT_REVISION_MISMATCH',
      '脚本候选引用了错误的 parent ScriptRevision',
    )
  }
  if (!['ui', 'api'].includes(input.task.method)) {
    throw new TestExecutionValidationError('TEST_EXECUTION_METHOD_UNSUPPORTED', '不支持的方法不能创建执行包')
  }
  const entrypoint = `tests/${safeIdentity(input.task.taskId, 'taskId')}.spec.ts`
  const files = normalizePackageFiles(input.candidate.files)
  if (files.length !== 1 || files[0].path !== entrypoint) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_PACKAGE_ENTRYPOINT_INVALID',
      `执行包必须且只能包含固定入口 ${entrypoint}`,
    )
  }
  const assertions = validateEntrypointSource(files[0].content, input.task.executionSpec)
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

export function assertExecutionPackageIntegrity(input: {
  package: ExecutionPackage
  task: FrozenExecutionTaskInput & { taskId: string }
  environmentSignature: string
  expectedPackageSha256: string
}) {
  const rebuilt = buildExecutionPackage({
    candidate: {
      schemaVersion: 'test-script-generation/v1',
      taskId: input.task.taskId,
      files: input.package.files,
      summary: 'Runner boundary validation',
    },
    task: input.task,
    environmentSignature: input.environmentSignature,
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
  context: { taskId: string; scriptRevisionId: string; attemptIds: readonly string[]; artifactIds: readonly string[] },
): Pick<FailureDiagnosis, 'category' | 'confidence' | 'summary' | 'evidence' | 'repairable' | 'recommendedAction'> {
  const candidate = record(value, '诊断候选必须是对象')
  if (candidate.schemaVersion !== 'failure-analysis/v1') {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_DIAGNOSIS_SCHEMA_INVALID',
      '诊断候选 schemaVersion 无效',
    )
  }
  if (text(candidate.taskId, 'taskId') !== context.taskId) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_DIAGNOSIS_TASK_MISMATCH',
      '诊断候选引用了错误任务',
    )
  }
  if (
    text(candidate.scriptRevisionId, 'scriptRevisionId')
      !== context.scriptRevisionId
  ) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_DIAGNOSIS_REVISION_MISMATCH',
      '诊断候选引用了错误 ScriptRevision',
    )
  }
  if (!Array.isArray(candidate.attemptIds)) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_DIAGNOSIS_ATTEMPTS_INVALID',
      '诊断候选必须引用当前固定的 Attempt 集',
    )
  }
  const candidateAttemptIds = candidate.attemptIds.map(
    (attemptId, index) => text(attemptId, `attemptIds[${index}]`),
  )
  if (
    candidateAttemptIds.length !== context.attemptIds.length
    || new Set(candidateAttemptIds).size !== candidateAttemptIds.length
    || candidateAttemptIds.some(
      attemptId => !context.attemptIds.includes(attemptId),
    )
  ) {
    throw new TestExecutionValidationError(
      'TEST_EXECUTION_DIAGNOSIS_ATTEMPTS_MISMATCH',
      '诊断候选引用了错误的 Attempt 集',
    )
  }
  const category = text(candidate.category, 'category') as FailureDiagnosisCategory
  if (!diagnosisCategories.has(category)) throw new TestExecutionValidationError('TEST_EXECUTION_DIAGNOSIS_CATEGORY_INVALID', '诊断分类无效')
  const confidence = Number(candidate.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new TestExecutionValidationError('TEST_EXECUTION_DIAGNOSIS_CONFIDENCE_INVALID', '诊断置信度必须在 0 到 1 之间')
  if (!Array.isArray(candidate.evidence) || !candidate.evidence.length || candidate.evidence.length > 50) throw new TestExecutionValidationError('TEST_EXECUTION_DIAGNOSIS_EVIDENCE_INVALID', '诊断证据必须包含 1 到 50 项')
  const attemptIds = new Set(context.attemptIds)
  const artifactIds = new Set(context.artifactIds)
  const evidence = candidate.evidence.map((entry, index) => {
    const item = record(entry, `evidence[${index}] 必须是对象`)
    const attemptId = text(item.attemptId, `evidence[${index}].attemptId`)
    const artifactId = item.artifactId === undefined ? undefined : text(item.artifactId, `evidence[${index}].artifactId`)
    if (!attemptIds.has(attemptId) || artifactId && !artifactIds.has(artifactId)) throw new TestExecutionValidationError('TEST_EXECUTION_DIAGNOSIS_EVIDENCE_FOREIGN', '诊断证据引用了当前任务之外的执行事实')
    return { attemptId, ...(artifactId ? { artifactId } : {}), observation: text(item.observation, `evidence[${index}].observation`, 4_000) }
  })
  const repairable = candidate.repairable
  if (typeof repairable !== 'boolean') throw new TestExecutionValidationError('TEST_EXECUTION_DIAGNOSIS_REPAIRABLE_INVALID', 'repairable 必须是布尔值')
  return {
    category,
    confidence,
    summary: text(candidate.summary, 'summary', 4_000),
    evidence,
    repairable,
    recommendedAction: text(candidate.recommendedAction, 'recommendedAction', 4_000),
  }
}

export function automaticRepairAllowed(diagnosis: Pick<FailureDiagnosis, 'category' | 'repairable'>, repairCount: number) {
  if (!Number.isInteger(repairCount) || repairCount < 0) {
    throw new TestExecutionValidationError('TEST_EXECUTION_REPAIR_COUNT_INVALID', '修复次数无效')
  }
  return diagnosis.repairable
    && repairCount < 2
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

function normalizePackageFiles(candidateFiles: ExecutionPackageCandidate['files']): ExecutionPackageFile[] {
  if (!Array.isArray(candidateFiles) || !candidateFiles.length || candidateFiles.length > EXECUTION_PACKAGE_LIMITS.maximumFiles) {
    throw new TestExecutionValidationError('TEST_EXECUTION_PACKAGE_FILE_COUNT_INVALID', '执行包文件数无效')
  }
  const paths = new Set<string>()
  let totalBytes = 0
  return candidateFiles.map(candidate => {
    const path = safePackagePath(candidate.path)
    if (paths.has(path.toLocaleLowerCase())) throw new TestExecutionValidationError('TEST_EXECUTION_PACKAGE_PATH_DUPLICATE', `执行包路径重复：${path}`)
    paths.add(path.toLocaleLowerCase())
    if (typeof candidate.content !== 'string' || candidate.content.includes('\0')) throw new TestExecutionValidationError('TEST_EXECUTION_PACKAGE_CONTENT_INVALID', `执行包文件内容无效：${path}`)
    const size = Buffer.byteLength(candidate.content, 'utf8')
    totalBytes += size
    if (!size || size > EXECUTION_PACKAGE_LIMITS.maximumFileBytes || totalBytes > EXECUTION_PACKAGE_LIMITS.maximumPackageBytes) {
      throw new TestExecutionValidationError('TEST_EXECUTION_PACKAGE_SIZE_INVALID', '执行包超过大小限制')
    }
    const contentSha256 = sha256(candidate.content)
    if (candidate.contentSha256 && candidate.contentSha256 !== contentSha256) throw new TestExecutionValidationError('TEST_EXECUTION_PACKAGE_CONTENT_HASH_MISMATCH', `执行包文件 Hash 不一致：${path}`)
    return { path, content: candidate.content, contentSha256, size }
  }).sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

function validateEntrypointSource(source: string, executionSpec: TestCaseExecutionSpec): ExecutionAssertionContract[] {
  let ast: ReturnType<typeof parse>
  try {
    ast = parse(source, { sourceType: 'module', plugins: ['typescript'], errorRecovery: false })
  } catch (cause) {
    throw new TestExecutionValidationError('TEST_EXECUTION_SCRIPT_SYNTAX_INVALID', cause instanceof Error ? cause.message : '执行脚本语法无效')
  }
  const anchors = new Map<string, { matcher: string; modifiers: string[]; expected: Node | null }>()
  walkAst(ast, (node, parent) => {
    if (node.type === 'ImportDeclaration') {
      const module = String(node.source.value)
      if (!allowedStaticImports.has(module)) rejectSource(`不允许导入模块 ${module}`)
      if (node.importKind === 'type') return
    }
    if (node.type === 'ImportExpression' || node.type === 'CallExpression' && node.callee.type === 'Import') rejectSource('不允许动态 import')
    if (node.type === 'Identifier' && forbiddenIdentifiers.has(node.name) && isRuntimeIdentifier(node, parent)) rejectSource(`不允许访问 ${node.name}`)
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && forbiddenIdentifiers.has(node.callee.name)) rejectSource(`不允许调用 ${node.callee.name}`)
    if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && forbiddenIdentifiers.has(node.callee.name)) rejectSource(`不允许构造 ${node.callee.name}`)
    if (node.type === 'StringLiteral' && parent?.type === 'ImportDeclaration' && forbiddenModulePrefixes.some(prefix => node.value === prefix || node.value.startsWith(`${prefix}/`))) rejectSource(`不允许导入模块 ${node.value}`)
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
  return 'verificationChecks' in spec ? spec.verificationChecks : []
}

function resolveExecutionSpec(content: TestCaseContent, method: string): TestCaseExecutionSpec {
  if (content.executionSpec?.method === method) return content.executionSpec
  const executionMethod = content.executionMethods.find(item => item.method === method)
  if (!executionMethod) throw new TestExecutionValidationError('TEST_EXECUTION_METHOD_NOT_IN_CASE', '固定用例不包含 Handoff 执行方法')
  return {
    kind: 'functional',
    method: executionMethod.method,
    steps: executionMethod.steps,
    verificationChecks: executionMethod.verificationChecks,
    preconditions: content.preconditions,
    testDataRequirements: content.dataRequirementIds,
    executionReadiness: executionMethod.executionReadiness,
    automationHint: executionMethod.automationHint,
  }
}

function safePackagePath(value: string) {
  const normalized = String(value ?? '').trim().replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized) || normalized.includes('\0') || normalized.length > 500) {
    throw new TestExecutionValidationError('TEST_EXECUTION_PACKAGE_PATH_INVALID', `执行包路径不安全：${value}`)
  }
  const parts = normalized.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || part.length > 120 || /[<>:"|?* -]/u.test(part) || /[. ]$/u.test(part) || windowsReserved(part))) {
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
