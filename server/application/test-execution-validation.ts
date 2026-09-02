import { createHash } from 'node:crypto'
import { canonicalJson, canonicalSha256 } from './canonical-json.js'
import type {
  ExecutionRun,
  ExecutionRunStatus,
  ExecutionTaskStatus,
  FailureDiagnosisCandidate,
  FailureDiagnosisCategory,
  FrozenExecutionTestDataSnapshot,
  FrozenExecutionTaskInput,
} from '../domain/test-execution-types.js'
import type { TestCaseLibraryVersionMemberDetail, TestExecutionHandoffMember } from '../domain/test-design-types.js'

export const EXECUTION_RUN_TRANSITIONS: Readonly<Record<ExecutionRunStatus, readonly ExecutionRunStatus[]>> = {
  queued: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'partial', 'cancelled'],
  succeeded: [],
  failed: ['running'],
  partial: ['running'],
  cancelled: [],
}

export const EXECUTION_TASK_TRANSITIONS: Readonly<Record<ExecutionTaskStatus, readonly ExecutionTaskStatus[]>> = {
  pending: ['running', 'failed', 'cancelled'],
  running: ['passed', 'failed', 'blocked', 'cancelled'],
  passed: [],
  failed: ['pending'],
  blocked: ['pending'],
  cancelled: [],
}

const terminalTaskStates = new Set<ExecutionTaskStatus>(['passed', 'failed', 'blocked', 'cancelled'])
const diagnosisCategories = new Set<FailureDiagnosisCategory>([
  'product_defect', 'environment_defect', 'test_data_defect', 'assertion_mismatch', 'timeout',
  'planning', 'tool_selection', 'tool_argument', 'tool_sequence', 'prompt', 'context', 'model',
  'tool_schema', 'mcp', 'workflow', 'knowledge', 'memory', 'runtime', 'business_backend', 'unknown',
])

export class TestExecutionValidationError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) { super(message) }
}

export function assertRunTransition(from: ExecutionRunStatus, to: ExecutionRunStatus) {
  if (!EXECUTION_RUN_TRANSITIONS[from].includes(to)) {
    throw new TestExecutionValidationError('TEST_EXECUTION_RUN_TRANSITION_INVALID', `执行运行不允许从 ${from} 迁移到 ${to}`, { from, to })
  }
}

export function assertTaskTransition(from: ExecutionTaskStatus, to: ExecutionTaskStatus) {
  if (!EXECUTION_TASK_TRANSITIONS[from].includes(to)) {
    throw new TestExecutionValidationError('TEST_EXECUTION_TASK_TRANSITION_INVALID', `执行任务不允许从 ${from} 迁移到 ${to}`, { from, to })
  }
}

export function aggregateExecutionRunStatus(statuses: readonly ExecutionTaskStatus[]): ExecutionRunStatus | 'running' {
  if (!statuses.length) throw new TestExecutionValidationError('TEST_EXECUTION_RUN_EMPTY', '执行运行必须包含至少一个任务')
  if (statuses.some(status => !terminalTaskStates.has(status))) return 'running'
  if (statuses.every(status => status === 'cancelled')) return 'cancelled'
  if (statuses.every(status => status === 'passed')) return 'succeeded'
  if (statuses.every(status => status === 'failed')) return 'failed'
  return 'partial'
}

type ExecutionCreateRequestSource = Pick<ExecutionRun, 'projectVersionId' | 'handoff' | 'agentUnderTest' | 'createdBy'>

export function executionCreateRequestCanonical(run: ExecutionCreateRequestSource) {
  return canonicalJson({
    schemaVersion: 'agent-test-execution-create-request/v1',
    projectVersionId: run.projectVersionId,
    handoffId: run.handoff.handoffId,
    agentUnderTestId: run.agentUnderTest.id,
    agentUnderTestVersion: run.agentUnderTest.version,
    createdBy: run.createdBy,
  })
}

export function executionCreateRequestSha256(run: ExecutionCreateRequestSource) {
  return createHash('sha256').update(executionCreateRequestCanonical(run), 'utf8').digest('hex')
}

export function freezeExecutionTaskInput(input: {
  handoffMember: TestExecutionHandoffMember
  libraryMember: TestCaseLibraryVersionMemberDetail
  testData?: FrozenExecutionTestDataSnapshot
}): FrozenExecutionTaskInput {
  const { handoffMember, libraryMember } = input
  if (handoffMember.method !== 'agent') throw new TestExecutionValidationError('AGENT_TEST_EXECUTION_METHOD_REQUIRED', '执行交接只允许 Agent Test')
  if (handoffMember.caseId !== libraryMember.caseId || handoffMember.revision !== libraryMember.revision) {
    throw new TestExecutionValidationError('TEST_EXECUTION_HANDOFF_MEMBER_MISMATCH', 'Handoff 成员与固定用例库成员不一致')
  }
  if (!handoffMember.contentSha256 || handoffMember.contentSha256 !== libraryMember.contentSha256) {
    throw new TestExecutionValidationError('TEST_EXECUTION_HANDOFF_CONTENT_HASH_MISMATCH', 'Handoff 用例 Hash 与固定用例库成员不一致')
  }
  if (canonicalSha256(libraryMember.frozenContent) !== libraryMember.contentSha256) {
    throw new TestExecutionValidationError('TEST_EXECUTION_LIBRARY_CONTENT_HASH_MISMATCH', '固定用例内容 Hash 与正式用例库成员不一致')
  }
  const executionSpec = handoffMember.executionSpec
  if (
    !executionSpec || executionSpec.schemaVersion !== 'agent-test-input/v1' || executionSpec.method !== 'agent'
    || !libraryMember.frozenContent.agentTestSpec
    || libraryMember.frozenContent.executionMethods.length !== 1
    || libraryMember.frozenContent.executionMethods[0] !== 'agent'
  ) throw new TestExecutionValidationError('AGENT_TEST_EXECUTION_SPEC_REQUIRED', '冻结用例必须提供唯一 Agent Test 执行规范')
  if (canonicalSha256(executionSpec.testCase) !== libraryMember.contentSha256) {
    throw new TestExecutionValidationError('TEST_EXECUTION_SPEC_HASH_MISMATCH', 'Handoff 执行规范与固定用例内容不一致')
  }
  if (handoffMember.dimension && handoffMember.dimension !== libraryMember.frozenContent.dimension) {
    throw new TestExecutionValidationError('TEST_EXECUTION_DIMENSION_MISMATCH', 'Handoff 测试维度与固定用例内容不一致')
  }
  if (handoffMember.traceability && canonicalSha256(handoffMember.traceability) !== canonicalSha256(libraryMember.traceability)) {
    throw new TestExecutionValidationError('TEST_EXECUTION_TRACEABILITY_MISMATCH', 'Handoff 追溯快照与固定用例库成员不一致')
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
    method: 'agent' as const,
    dimension: libraryMember.frozenContent.dimension,
    executionSpec: structuredClone(executionSpec),
    executionSpecSha256: canonicalSha256(executionSpec),
    ...(libraryMember.traceability ? { traceability: structuredClone(libraryMember.traceability) } : {}),
    ...(handoffMember.selectionReason ? { selectionReason: handoffMember.selectionReason } : {}),
    ...(handoffMember.readinessOverride ? { readinessOverride: structuredClone(handoffMember.readinessOverride) } : {}),
  }
  return { ...frozen, inputSha256: canonicalSha256(frozen) }
}

export function validateFailureDiagnosisCandidate(value: unknown): FailureDiagnosisCandidate {
  const candidate = record(value, '诊断候选必须是对象')
  if (candidate.schemaVersion !== undefined && candidate.schemaVersion !== 'failure-analysis/v1') {
    throw new TestExecutionValidationError('TEST_EXECUTION_DIAGNOSIS_SCHEMA_INVALID', '诊断候选 schemaVersion 无效')
  }
  const allowed = new Set(['schemaVersion', 'category', 'reason', 'evidence'])
  if (Object.keys(candidate).some(key => !allowed.has(key))) {
    throw new TestExecutionValidationError('TEST_EXECUTION_DIAGNOSIS_SYSTEM_FIELD_FORBIDDEN', '诊断候选不能提交运行状态或系统治理字段')
  }
  const category = text(candidate.category, 'category') as FailureDiagnosisCategory
  if (!diagnosisCategories.has(category)) throw new TestExecutionValidationError('TEST_EXECUTION_DIAGNOSIS_CATEGORY_INVALID', '诊断分类无效')
  return { category, reason: text(candidate.reason, 'reason', 4_000), evidence: text(candidate.evidence, 'evidence', 4_000) }
}

function text(value: unknown, label: string, maximum = 500) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
    throw new TestExecutionValidationError('TEST_EXECUTION_VALUE_INVALID', `${label} 无效`)
  }
  return value.trim()
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TestExecutionValidationError('TEST_EXECUTION_VALUE_INVALID', message)
  return value as Record<string, unknown>
}
