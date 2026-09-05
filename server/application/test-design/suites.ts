import type {
  TestCaseContent,
  TestDesignState,
  TestExecutionMethod,
  TestSuiteDraft,
  TestSuiteVersionMember,
} from '../../domain/test-design-types.js'
import { canonicalSha256 } from '../canonical-json.js'
import { TestDesignError } from '../test-design-validation.js'
import { cleanRequired, required } from './state.js'
import { presentLibraryVersion, executionMethodsForContent } from './library.js'

export function suiteDraftInput(raw: unknown): {
  suiteKey: string
  suiteType: 'smoke' | 'regression' | 'custom'
  name: string
  testCaseLibraryVersionId: string
  confirmLibraryVersionChange: boolean
  members: Array<{
    testCaseLibraryVersionId?: string
    caseId: string
    executionMethods: Array<'ui' | 'api'>
    reason: string
  }>
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new TestDesignError('TEST_SUITE_DRAFT_INVALID', '套件草稿必须是对象', 422)
  const input = raw as Record<string, unknown>
  if (
    Object.keys(input).some(
      key =>
        ![
          'suiteKey',
          'suiteType',
          'name',
          'testCaseLibraryVersionId',
          'confirmLibraryVersionChange',
          'members',
        ].includes(key),
    )
  )
    throw new TestDesignError('TEST_SUITE_DRAFT_INVALID', '套件草稿包含未知字段', 422)
  const suiteType = String(input.suiteType)
  if (!['smoke', 'regression', 'custom'].includes(suiteType))
    throw new TestDesignError('TEST_SUITE_DRAFT_INVALID', 'suiteType 必须为 smoke、regression 或 custom', 422)
  if (!Array.isArray(input.members) || input.members.length > 10_000)
    throw new TestDesignError('TEST_SUITE_DRAFT_INVALID', 'members 必须是最多 10000 项的数组', 422)
  const memberVersionIds = [
    ...new Set(
      input.members
        .flatMap(candidate =>
          candidate &&
          typeof candidate === 'object' &&
          !Array.isArray(candidate) &&
          typeof (candidate as Record<string, unknown>).testCaseLibraryVersionId === 'string'
            ? [String((candidate as Record<string, unknown>).testCaseLibraryVersionId).trim()]
            : [],
        )
        .filter(Boolean),
    ),
  ]
  const selectedVersionId =
    input.testCaseLibraryVersionId ?? (memberVersionIds.length === 1 ? memberVersionIds[0] : undefined)
  return {
    suiteKey: cleanRequired(input.suiteKey, 'suiteKey', 200),
    suiteType: suiteType as 'smoke' | 'regression' | 'custom',
    name: cleanRequired(input.name, '套件名称', 200),
    testCaseLibraryVersionId: cleanRequired(selectedVersionId, 'testCaseLibraryVersionId', 500),
    confirmLibraryVersionChange: input.confirmLibraryVersionChange === true,
    members: input.members.map((candidate, index) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
        throw new TestDesignError('TEST_SUITE_DRAFT_INVALID', `members[${index}] 必须是对象`, 422)
      const item = candidate as Record<string, unknown>
      if (
        Object.keys(item).some(
          key => !['testCaseLibraryVersionId', 'caseId', 'executionMethods', 'reason'].includes(key),
        )
      )
        throw new TestDesignError('TEST_SUITE_EXECUTION_METHOD_INVALID', `members[${index}] 包含未知字段`, 422)
      const rawExecutionMethods = item.executionMethods
      if (rawExecutionMethods !== undefined && !Array.isArray(rawExecutionMethods))
        throw new TestDesignError(
          'TEST_SUITE_EXECUTION_METHOD_INVALID',
          `members[${index}].executionMethods 必须是数组`,
          422,
        )
      const executionMethods = Array.isArray(rawExecutionMethods)
        ? rawExecutionMethods.map((method, methodIndex) => {
            if (method !== 'ui' && method !== 'api')
              throw new TestDesignError(
                'TEST_SUITE_EXECUTION_METHOD_INVALID',
                `members[${index}].executionMethods[${methodIndex}] 只能是 ui 或 api`,
                422,
              )
            return method
          })
        : undefined
      if (executionMethods && !executionMethods.length)
        throw new TestDesignError(
          'TEST_SUITE_EXECUTION_METHOD_INVALID',
          `members[${index}].executionMethods 不能为空`,
          422,
        )
      if (executionMethods && new Set(executionMethods).size !== executionMethods.length)
        throw new TestDesignError(
          'TEST_SUITE_EXECUTION_METHOD_INVALID',
          `members[${index}].executionMethods 不能包含重复执行方式`,
          422,
        )
      if (!executionMethods)
        throw new TestDesignError(
          'TEST_SUITE_EXECUTION_METHOD_INVALID',
          `members[${index}] 必须提供 executionMethods`,
          422,
        )
      return {
        ...(typeof item.testCaseLibraryVersionId === 'string' && item.testCaseLibraryVersionId.trim()
          ? { testCaseLibraryVersionId: item.testCaseLibraryVersionId.trim() }
          : {}),
        caseId: cleanRequired(item.caseId, 'caseId', 500),
        executionMethods: canonicalSuiteExecutionMethods(executionMethods),
        reason: cleanRequired(item.reason, '选择原因', 2_000),
      }
    }),
  }
}

export function validateSuiteMembers(
  aggregate: TestDesignState,
  projectId: string,
  testCaseLibraryVersionId: string,
  values: ReturnType<typeof suiteDraftInput>['members'],
): TestSuiteVersionMember[] {
  const version = presentLibraryVersion(
    aggregate,
    required(
      aggregate.libraryVersions.find(item => item.id === testCaseLibraryVersionId && item.projectId === projectId),
      'TEST_CASE_LIBRARY_VERSION_NOT_FOUND',
      '套件引用的用例库版本不存在',
    ),
  )
  const seen = new Set<string>()
  return values.map((value, ordinal) => {
    if (value.testCaseLibraryVersionId && value.testCaseLibraryVersionId !== version.id)
      throw new TestDesignError(
        'TEST_SUITE_LIBRARY_VERSION_MISMATCH',
        '套件所有成员必须属于草稿固定的同一个用例库版本',
        422,
      )
    if (seen.has(value.caseId)) throw new TestDesignError('TEST_SUITE_MEMBER_DUPLICATE', '套件成员不能重复', 422)
    seen.add(value.caseId)
    const member = required(
      version.members.find(item => item.caseId === value.caseId),
      'TEST_CASE_LIBRARY_MEMBER_NOT_FOUND',
      '套件成员不属于固定的用例库版本',
    )
    const frozenContent = required(
      member.frozenContent,
      'TEST_CASE_LIBRARY_MEMBER_HASH_MISMATCH',
      '用例库成员缺少冻结内容',
    )
    const availableMethods = executionMethodsForContent(frozenContent)
    const selectedMethods = value.executionMethods
    if (!selectedMethods?.length || selectedMethods.some(method => !availableMethods.includes(method)))
      throw new TestDesignError(
        'TEST_SUITE_EXECUTION_METHOD_INVALID',
        '套件执行方式不是冻结 Revision 实际拥有方式的非空子集',
        422,
        { caseId: member.caseId, revision: member.revision, selectedMethods: selectedMethods ?? [], availableMethods },
      )
    return {
      testCaseLibraryVersionId: version.id,
      caseId: member.caseId,
      revision: member.revision,
      executionMethods: canonicalSuiteExecutionMethods(selectedMethods),
      ordinal,
      reason: cleanRequired(value.reason, '套件成员原因', 2_000),
    }
  })
}

function canonicalSuiteExecutionMethods(methods: Array<'ui' | 'api'>) {
  return (['ui', 'api'] as const).filter((method): method is 'ui' | 'api' => methods.includes(method))
}

export function suiteMemberExecutionMethods(
  member: TestSuiteVersionMember,
  _frozenContent: TestCaseContent,
): TestExecutionMethod[] {
  return canonicalSuiteExecutionMethods(member.executionMethods)
}

export function suiteDraftEtag(draft: TestSuiteDraft) {
  return `"suite-draft:${draft.id}:${canonicalSha256({ contentSha256: draft.contentSha256, status: draft.status, updatedAt: draft.updatedAt })}"`
}

export function versionMemberDiff<T extends { caseId: string; revision: number }>(left: T[], right: T[]) {
  const before = new Map(left.map(item => [item.caseId, item]))
  const after = new Map(right.map(item => [item.caseId, item]))
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .map(caseId => {
      const from = before.get(caseId)
      const to = after.get(caseId)
      return {
        caseId,
        change: !from
          ? ('added' as const)
          : !to
            ? ('removed' as const)
            : canonicalSha256(from) === canonicalSha256(to)
              ? ('unchanged' as const)
              : ('modified' as const),
        ...(from ? { from: structuredClone(from) } : {}),
        ...(to ? { to: structuredClone(to) } : {}),
      }
    })
    .filter(item => item.change !== 'unchanged')
}
