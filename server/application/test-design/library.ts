import { randomUUID } from 'node:crypto'
import type { DatabaseState } from '../../domain/types.js'
import type {
  CaseChangeProposal,
  LibraryTestCase,
  LibraryTestCaseRevision,
  TestCaseContent,
  TestCaseLibraryVersion,
  TestCaseLibraryVersionDetail,
  TestCaseLibraryVersionMemberDetail,
  TestDesignWorkspaceFile,
  TestCaseTraceability,
  TestDesignState,
  TestDesignWorkflowRun,
  TestExecutionMethod,
} from '../../domain/test-design-types.js'
import { canonicalJson, canonicalSha256 } from '../canonical-json.js'
import { etag, TestDesignError } from '../test-design-validation.js'
import { required, now, designState, cleanRequired, safeWorkspaceSegment, canonicalSha256Text } from './state.js'
import {
  semanticContentSha256,
  requirementRefsForCase,
  currentCaseRevision,
  effectiveHistoricalRequirementRefs,
  buildEffectiveCaseSet,
  requiresHumanProposalDecision,
} from './case-review.js'

type PublishedTestCaseItem = {
  caseId: string
  revision: number
  source: 'current_created' | 'historical_reused' | 'historical_modified'
  content: TestCaseContent
  executionReadiness: 'ready' | 'needs_confirmation' | 'blocked'
  contentSha256: string
  traceability?: TestCaseTraceability
  sourceTraceability?: {
    sourceProjectVersionId: string
    sourceCaseId: string
    sourceRevision: number
    changeType: 'reuse' | 'update'
  }
}

export function presentPublishedTestCase(
  run: TestDesignWorkflowRun,
  member: TestCaseLibraryVersionMemberDetail,
): PublishedTestCaseItem {
  const historical = run.historicalSnapshot.items.find(item => {
    const locator = item.locator as { caseId?: unknown; revision?: unknown } | undefined
    return locator?.caseId === member.caseId && locator?.revision === member.revision
  })
  const update = run.caseChangeProposals.find(
    item =>
      item.operation === 'update' && item.appliedCaseId === member.caseId && item.appliedRevision === member.revision,
  )
  const created = run.caseChangeProposals.find(
    item =>
      item.operation === 'create' && item.appliedCaseId === member.caseId && item.appliedRevision === member.revision,
  )
  const historicalSource = update
    ? run.historicalSnapshot.items.find(item => {
        const locator = item.locator as { caseId?: unknown; revision?: unknown } | undefined
        return locator?.caseId === update.sourceCaseId && locator?.revision === update.sourceRevision
      })
    : historical
  const source = update
    ? 'historical_modified'
    : historicalSource
      ? 'historical_reused'
      : created
        ? 'current_created'
        : undefined
  if (!source)
    throw new TestDesignError(
      'TEST_CASE_LIBRARY_PUBLICATION_SOURCE_INVALID',
      '正式用例库成员无法追溯到当前版本发布结果',
      409,
      { runId: run.id, caseId: member.caseId, revision: member.revision },
    )
  const locator = historicalSource?.locator as
    | { sourceProjectVersionId?: unknown; caseId?: unknown; revision?: unknown }
    | undefined
  const sourceTraceability =
    source === 'current_created'
      ? undefined
      : {
          sourceProjectVersionId: required(
            typeof locator?.sourceProjectVersionId === 'string' ? locator.sourceProjectVersionId : undefined,
            'TEST_CASE_LIBRARY_PUBLICATION_SOURCE_INVALID',
            '历史正式用例缺少来源 ProjectVersion',
          ),
          sourceCaseId: required(
            typeof locator?.caseId === 'string' ? locator.caseId : undefined,
            'TEST_CASE_LIBRARY_PUBLICATION_SOURCE_INVALID',
            '历史正式用例缺少来源 Case',
          ),
          sourceRevision: required(
            typeof locator?.revision === 'number' ? locator.revision : undefined,
            'TEST_CASE_LIBRARY_PUBLICATION_SOURCE_INVALID',
            '历史正式用例缺少来源 Revision',
          ),
          changeType: source === 'historical_modified' ? ('update' as const) : ('reuse' as const),
        }
  return {
    caseId: member.caseId,
    revision: member.revision,
    source,
    content: structuredClone(member.frozenContent),
    executionReadiness: member.executionReadiness,
    contentSha256: member.contentSha256,
    ...(member.traceability ? { traceability: structuredClone(member.traceability) } : {}),
    ...(sourceTraceability ? { sourceTraceability } : {}),
  }
}

export function publishedTestCaseStatistics(items: PublishedTestCaseItem[]) {
  return {
    total: items.length,
    currentCreated: items.filter(item => item.source === 'current_created').length,
    historicalReused: items.filter(item => item.source === 'historical_reused').length,
    historicalModified: items.filter(item => item.source === 'historical_modified').length,
    ready: items.filter(item => item.executionReadiness === 'ready').length,
    needsConfirmation: items.filter(item => item.executionReadiness === 'needs_confirmation').length,
    blocked: items.filter(item => item.executionReadiness === 'blocked').length,
  }
}

export function createLibraryRevision(
  revision: number,
  content: TestCaseContent,
  actorId: string,
  changeReason: string,
  sourceRunId?: string,
  sourceProposalId?: string,
  traceability?: TestCaseTraceability,
): LibraryTestCaseRevision {
  return {
    revision,
    content: structuredClone(content),
    contentSha256: canonicalSha256(content),
    semanticSha256: semanticContentSha256(content),
    ...(sourceRunId ? { sourceRunId } : {}),
    ...(sourceProposalId ? { sourceProposalId } : {}),
    ...(traceability ? { traceability: structuredClone(traceability) } : {}),
    changeReason,
    createdBy: actorId,
    createdAt: now(),
  }
}

export function currentLibraryRevision(testCase: LibraryTestCase) {
  return required(
    testCase.revisions.find(item => item.revision === testCase.currentRevision),
    'LIBRARY_TEST_CASE_REVISION_NOT_FOUND',
    '正式用例当前 Revision 不存在',
  )
}

export function libraryCaseEtag(testCase: LibraryTestCase, revision = currentLibraryRevision(testCase)) {
  return `"library-case:${testCase.id}:r${revision.revision}:${canonicalSha256({ contentSha256: revision.contentSha256, status: testCase.status, updatedAt: testCase.updatedAt })}"`
}

export function presentLibraryCase(testCase: LibraryTestCase, detail = false) {
  const revision = currentLibraryRevision(testCase)
  return {
    id: testCase.id,
    projectId: testCase.projectId,
    currentRevision: testCase.currentRevision,
    status: testCase.status,
    content: structuredClone(revision.content),
    contentSha256: revision.contentSha256,
    semanticSha256: revision.semanticSha256,
    createdAt: testCase.createdAt,
    updatedAt: testCase.updatedAt,
    etag: libraryCaseEtag(testCase, revision),
    ...(detail ? { revisions: structuredClone(testCase.revisions) } : {}),
  }
}

export function findLibraryCase(state: DatabaseState, projectId: string, caseId: string) {
  return required(
    designState(state).libraryCases.find(item => item.id === caseId && item.projectId === projectId),
    'LIBRARY_TEST_CASE_NOT_FOUND',
    '正式测试用例不存在',
  )
}

function executionMethodForContent(content: TestCaseContent): TestExecutionMethod {
  return content.executionMethods[0]
}

export function executionMethodsForContent(content: TestCaseContent): TestExecutionMethod[] {
  return [...content.executionMethods]
}

export function executionSpecForMethod(content: TestCaseContent, executionMethod: TestExecutionMethod) {
  if (!content.executionMethods.includes(executionMethod))
    throw new TestDesignError(
      'TEST_SUITE_EXECUTION_METHOD_INVALID',
      '冻结 TestCase Revision 未选择该 UI/API 执行方式',
      422,
    )
  return { schemaVersion: 'test-script-input/v1' as const, method: executionMethod, testCase: structuredClone(content) }
}

export function executionConfigurationForMethod(
  content: TestCaseContent,
  executionMethod: TestExecutionMethod,
): { status: 'ready' | 'needs_confirmation' | 'blocked'; issues: string[] } {
  return content.executionMethods.includes(executionMethod)
    ? { status: 'ready', issues: [] }
    : { status: 'blocked', issues: ['TestCase 未选择该执行方式'] }
}

function executionConfiguration(content: TestCaseContent): {
  status: 'ready' | 'needs_confirmation' | 'blocked'
  issues: string[]
} {
  const configurations = executionMethodsForContent(content).map(method => ({
    method,
    configuration: executionConfigurationForMethod(content, method),
  }))
  const status = configurations.some(item => item.configuration.status === 'blocked')
    ? 'blocked'
    : configurations.some(item => item.configuration.status === 'needs_confirmation')
      ? 'needs_confirmation'
      : 'ready'
  return {
    status,
    issues: configurations.flatMap(item => item.configuration.issues.map(issue => `${item.method}: ${issue}`)),
  }
}

export function freezeLibraryVersionMember(
  aggregate: TestDesignState,
  projectId: string,
  member: {
    caseId: string
    revision: number
    ordinal: number
    contentSha256: string
    traceability?: TestCaseTraceability
  },
) {
  const testCase = required(
    aggregate.libraryCases.find(item => item.id === member.caseId && item.projectId === projectId),
    'LIBRARY_TEST_CASE_NOT_FOUND',
    '正式用例库成员不存在',
  )
  const revision = required(
    testCase.revisions.find(item => item.revision === member.revision),
    'LIBRARY_TEST_CASE_REVISION_NOT_FOUND',
    '正式用例库成员 Revision 不存在',
  )
  if (revision.contentSha256 !== member.contentSha256 || canonicalSha256(revision.content) !== member.contentSha256)
    throw new TestDesignError(
      'TEST_CASE_LIBRARY_MEMBER_HASH_MISMATCH',
      '用例库成员冻结内容 Hash 与成员记录不一致',
      409,
      {
        caseId: member.caseId,
        revision: member.revision,
        expectedSha256: member.contentSha256,
        actualSha256: revision.contentSha256,
      },
    )
  const traceability = member.traceability ?? revision.traceability
  if (traceability) assertFixedTraceability(traceability)
  return {
    ...member,
    frozenContent: structuredClone(revision.content),
    frozenExecutionMethods: executionMethodsForContent(revision.content).filter(
      (method): method is 'ui' | 'api' => method === 'ui' || method === 'api',
    ),
    ...(traceability ? { traceability: structuredClone(traceability) } : {}),
    executionReadiness: executionConfiguration(revision.content).status,
  }
}

export function presentLibraryVersion(
  aggregate: TestDesignState,
  version: TestCaseLibraryVersion,
): TestCaseLibraryVersionDetail {
  const members = version.members.map(member => {
    const frozen = member.frozenContent
    if (frozen && canonicalSha256(frozen) !== member.contentSha256)
      throw new TestDesignError(
        'TEST_CASE_LIBRARY_MEMBER_HASH_MISMATCH',
        '用例库版本冻结内容 Hash 与成员记录不一致',
        409,
        { versionId: version.id, caseId: member.caseId, revision: member.revision },
      )
    const detail = freezeLibraryVersionMember(aggregate, version.projectId, member)
    if (frozen && canonicalSha256(frozen) !== canonicalSha256(detail.frozenContent))
      throw new TestDesignError(
        'TEST_CASE_LIBRARY_MEMBER_HASH_MISMATCH',
        '用例库版本冻结内容与不可变 Revision 不一致',
        409,
        { versionId: version.id, caseId: member.caseId, revision: member.revision },
      )
    return detail
  })
  return structuredClone({ ...version, members }) as TestCaseLibraryVersionDetail
}

export function traceabilityRelevantContentChanged(before: TestCaseContent, after: TestCaseContent) {
  return canonicalSha256(before.requirementRefs) !== canonicalSha256(after.requirementRefs)
}

function dynamicTraceabilityReference(value: string) {
  return /^(?:latest|active|current)(?:$|[:/@_-])/iu.test(value)
}

export function assertFixedTraceability(traceability: TestCaseTraceability) {
  if (
    !traceability.sourceRequirementReleaseId ||
    dynamicTraceabilityReference(traceability.sourceRequirementReleaseId) ||
    traceability.requirementRefs.some(
      item =>
        item.requirementReleaseId !== traceability.sourceRequirementReleaseId ||
        dynamicTraceabilityReference(item.requirementReleaseId),
    )
  )
    throw new TestDesignError(
      'LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH',
      'requirementRefs 必须引用同一个固定 Requirement Release ID，禁止 latest、active、current 等动态引用',
      422,
    )
  if (
    new Set(traceability.requirementRefs.map(item => `${item.requirementReleaseId}\u0000${item.requirementId}`))
      .size !== traceability.requirementRefs.length
  )
    throw new TestDesignError('LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH', '同一 Requirement 引用不得重复', 422)
}

export function assertTraceabilityMatchesContent(content: TestCaseContent, traceability: TestCaseTraceability) {
  assertFixedTraceability(traceability)
  const contentRefs = new Set(content.requirementRefs)
  if (
    contentRefs.size !== traceability.requirementRefs.length ||
    traceability.requirementRefs.some(item => !contentRefs.has(item.requirementId))
  )
    throw new TestDesignError(
      'LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH',
      '测试用例 Requirement 引用必须与正式追溯一致',
      422,
    )
}

export function validateLibraryTraceability(
  state: DatabaseState,
  projectId: string,
  content: TestCaseContent,
  value: unknown,
): TestCaseTraceability {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TestDesignError('LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH', 'traceability 必须是对象', 422)
  const input = value as Record<string, unknown>
  const sourceRequirementReleaseId = cleanRequired(
    input.sourceRequirementReleaseId,
    'traceability.sourceRequirementReleaseId',
    500,
  )
  const requirementRefs = Array.isArray(input.requirementRefs)
    ? input.requirementRefs.map((candidate, index) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
          throw new TestDesignError(
            'LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH',
            `traceability.requirementRefs[${index}] 无效`,
            422,
          )
        const item = candidate as Record<string, unknown>
        return {
          requirementReleaseId: cleanRequired(
            item.requirementReleaseId,
            `traceability.requirementRefs[${index}].requirementReleaseId`,
            500,
          ),
          requirementId: cleanRequired(item.requirementId, `traceability.requirementRefs[${index}].requirementId`, 500),
        }
      })
    : []
  const traceability = { sourceRequirementReleaseId, requirementRefs }
  const duplicateRequirementRefs =
    new Set(requirementRefs.map(item => `${item.requirementReleaseId}\u0000${item.requirementId}`)).size !==
    requirementRefs.length
  if (duplicateRequirementRefs)
    throw new TestDesignError('LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH', '同一 Requirement 引用不得重复', 422)
  const fixedReleaseExists = state.reviewRuns.some(
    run =>
      run.workflow?.release?.id === sourceRequirementReleaseId &&
      run.workflow.release.status === 'published' &&
      state.projectVersions.some(version => version.id === run.projectVersionId && version.projectId === projectId),
  )
  if (!fixedReleaseExists)
    throw new TestDesignError(
      'LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH',
      'Requirement Release ID 不属于当前项目的已发布固定版本',
      422,
      { sourceRequirementReleaseId },
    )
  assertTraceabilityMatchesContent(content, traceability)
  return traceability
}

function traceabilityForProposal(
  run: TestDesignWorkflowRun,
  proposal: CaseChangeProposal,
  content: TestCaseContent,
): TestCaseTraceability {
  const releaseId = run.basisSnapshot.requirementReleaseId
  const referencedBasis = new Set([...(proposal.requirementRefs ?? []), ...requirementRefsForCase(run, content)])
  const requirementRefs = run.basisSnapshot.content.requirements.flatMap(item => {
    const requirementId = item.clientRequirementPointId.trim()
    if (!referencedBasis.has(requirementId)) return []
    return requirementId ? [{ requirementReleaseId: releaseId, requirementId }] : []
  })
  return {
    sourceRequirementReleaseId: releaseId,
    requirementRefs: [
      ...new Map(requirementRefs.map(item => [`${item.requirementReleaseId}:${item.requirementId}`, item])).values(),
    ],
  }
}

export function effectiveTraceabilityForPublishedMember(
  run: TestDesignWorkflowRun,
  caseId: string,
): TestCaseTraceability {
  const proposal = run.caseChangeProposals.find(item => item.appliedCaseId === caseId)
  let requirementRefs: string[] | undefined
  if (proposal?.operation === 'create' || proposal?.operation === 'update') {
    const candidate = proposal.candidateCaseId
      ? run.testCases.find(item => item.id === proposal.candidateCaseId && !item.tombstonedAt)
      : undefined
    requirementRefs = candidate ? requirementRefsForCase(run, currentCaseRevision(candidate).content) : undefined
  } else if (proposal?.sourceCaseId) {
    const historical = run.historicalSnapshot.items.find(item => {
      const locator = item.locator as { caseId?: unknown; revision?: unknown } | undefined
      return locator?.caseId === proposal.sourceCaseId && locator?.revision === proposal.sourceRevision
    })
    requirementRefs = historical ? effectiveHistoricalRequirementRefs(run, historical) : undefined
  }
  requirementRefs ??= buildEffectiveCaseSet(run).find(item => item.caseId === caseId)?.effectiveRequirementRefs
  if (!requirementRefs)
    throw new TestDesignError(
      'LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH',
      '无法为发布成员建立当前 Requirement Release 追溯',
      409,
      { caseId },
    )
  const allowed = new Set(run.basisSnapshot.content.requirements.map(item => item.clientRequirementPointId.trim()))
  if (requirementRefs.some(item => !allowed.has(item)))
    throw new TestDesignError(
      'LIBRARY_TEST_CASE_TRACEABILITY_MISMATCH',
      '发布成员包含当前 Requirement Release 之外的有效追溯',
      409,
      { caseId, requirementRefs },
    )
  const releaseId = run.basisSnapshot.requirementReleaseId
  return {
    sourceRequirementReleaseId: releaseId,
    requirementRefs: requirementRefs.map(requirementId => ({ requirementReleaseId: releaseId, requirementId })),
  }
}

export function assertLibraryPublicationGates(
  aggregate: TestDesignState,
  projectId: string,
  run: TestDesignWorkflowRun,
) {
  const unreviewed = run.testCases.filter(item => !item.tombstonedAt && item.reviewState !== 'approved')
  if (unreviewed.length)
    throw new TestDesignError('TEST_CASE_REVIEW_REQUIRED', '所有候选用例必须完成人工审核', 409, {
      caseIds: unreviewed.map(item => item.id),
    })
  const pendingProposals = run.caseChangeProposals.filter(
    item => item.decision === 'pending' && requiresHumanProposalDecision(item),
  )
  if (pendingProposals.length)
    throw new TestDesignError('CASE_CHANGE_PROPOSAL_DECISION_REQUIRED', '高风险用例库变更必须先完成人工处置', 409, {
      proposalIds: pendingProposals.map(item => item.id),
    })
  for (const suite of aggregate.suiteVersions.filter(item => item.projectId === projectId))
    for (const member of suite.members) {
      const testCase = aggregate.libraryCases.find(item => item.id === member.caseId && item.projectId === projectId)
      if (!testCase?.revisions.some(item => item.revision === member.revision))
        throw new TestDesignError(
          'LIBRARY_TEST_CASE_REVISION_CONFLICT',
          '已发布套件引用的正式用例 Revision 不存在',
          409,
          { suiteVersionId: suite.id, caseId: member.caseId, revision: member.revision },
        )
    }
  for (const handoff of aggregate.executionHandoffs.filter(
    item => item.projectId === projectId && item.testCaseLibraryVersionId,
  ))
    for (const member of handoff.members) {
      const testCase = aggregate.libraryCases.find(item => item.id === member.caseId && item.projectId === projectId)
      if (!testCase?.revisions.some(item => item.revision === member.revision))
        throw new TestDesignError(
          'LIBRARY_TEST_CASE_REVISION_CONFLICT',
          'Execution Handoff 引用的正式用例 Revision 不存在',
          409,
          { handoffId: handoff.id, caseId: member.caseId, revision: member.revision },
        )
    }
}

export function assertProposalSourcesCurrent(
  aggregate: TestDesignState,
  projectId: string,
  run: TestDesignWorkflowRun,
  baseline?: TestCaseLibraryVersion,
) {
  const baselineMembers = new Map((baseline?.members ?? []).map(item => [item.caseId, item]))
  for (const proposal of run.caseChangeProposals) {
    if (
      !proposal.sourceCaseId ||
      proposal.sourceRevision === undefined ||
      proposal.decision === 'rejected' ||
      proposal.decision === 'reference'
    )
      continue
    const baselineMember = baselineMembers.get(proposal.sourceCaseId)
    if (!baselineMember || baselineMember.revision !== proposal.sourceRevision)
      throw new TestDesignError(
        'CASE_CHANGE_PROPOSAL_SOURCE_STALE',
        'Proposal 来源不再是运行冻结基线中的 Revision',
        409,
        { proposalId: proposal.id, sourceCaseId: proposal.sourceCaseId, sourceRevision: proposal.sourceRevision },
      )
    const source = aggregate.libraryCases.find(
      item => item.id === proposal.sourceCaseId && item.projectId === projectId,
    )
    const revision = source?.revisions.find(item => item.revision === proposal.sourceRevision)
    if (
      !source ||
      !revision ||
      revision.contentSha256 !== baselineMember.contentSha256 ||
      canonicalSha256(revision.content) !== baselineMember.contentSha256
    )
      throw new TestDesignError(
        'CASE_CHANGE_PROPOSAL_SOURCE_STALE',
        'Proposal 来源冻结 Revision 不存在或内容已损坏',
        409,
        { proposalId: proposal.id, sourceCaseId: proposal.sourceCaseId, sourceRevision: proposal.sourceRevision },
      )
  }
}

export function assertLibraryBaselineMembersCurrent(
  aggregate: TestDesignState,
  projectId: string,
  run: TestDesignWorkflowRun,
  baseline?: TestCaseLibraryVersion,
) {
  for (const member of baseline?.members ?? []) {
    const correspondingProposal = run.caseChangeProposals.find(
      proposal =>
        proposal.sourceCaseId === member.caseId &&
        proposal.sourceRevision === member.revision &&
        !['pending', 'rejected', 'reference'].includes(proposal.decision),
    )
    if (correspondingProposal) continue
    const testCase = aggregate.libraryCases.find(item => item.id === member.caseId && item.projectId === projectId)
    if (!testCase)
      throw new TestDesignError('TEST_CASE_LIBRARY_BASE_MEMBER_CHANGED', '基线成员在任务运行期间被移除', 409, {
        caseId: member.caseId,
        revision: member.revision,
      })
    const revision = testCase.revisions.find(item => item.revision === member.revision)
    if (
      !revision ||
      revision.contentSha256 !== member.contentSha256 ||
      canonicalSha256(revision.content) !== member.contentSha256
    )
      throw new TestDesignError(
        'TEST_CASE_LIBRARY_BASE_MEMBER_CHANGED',
        'Run 冻结的基线成员 Revision 不存在或内容 Hash 已损坏',
        409,
        {
          caseId: member.caseId,
          expectedRevision: member.revision,
          expectedSha256: member.contentSha256,
          actualSha256: revision?.contentSha256,
        },
      )
  }
}

export function applyProposalToLibrary(
  aggregate: TestDesignState,
  projectId: string,
  run: TestDesignWorkflowRun,
  proposal: CaseChangeProposal,
  members: Map<string, { caseId: string; revision: number; ordinal: number; contentSha256: string }>,
  actorId: string,
) {
  if (proposal.decision === 'pending')
    throw new TestDesignError('CASE_CHANGE_PROPOSAL_DECISION_REQUIRED', 'Proposal 尚未处置', 409)
  const source = proposal.sourceCaseId
    ? required(
        aggregate.libraryCases.find(item => item.id === proposal.sourceCaseId && item.projectId === projectId),
        'LIBRARY_TEST_CASE_NOT_FOUND',
        'Proposal 来源正式用例不存在',
      )
    : undefined
  const sourceRevision =
    source && proposal.sourceRevision !== undefined
      ? required(
          source.revisions.find(item => item.revision === proposal.sourceRevision),
          'LIBRARY_TEST_CASE_REVISION_NOT_FOUND',
          'Proposal 来源 Revision 不存在',
        )
      : undefined
  const candidate = proposal.candidateCaseId
    ? required(
        run.testCases.find(item => item.id === proposal.candidateCaseId && !item.tombstonedAt),
        'CASE_CHANGE_PROPOSAL_CANDIDATE_INVALID',
        'Proposal 候选用例不存在',
      )
    : undefined
  const candidateRevision = candidate ? currentCaseRevision(candidate) : undefined
  if (candidate && candidate.reviewState !== 'approved')
    throw new TestDesignError('TEST_CASE_REVIEW_REQUIRED', `Proposal 候选用例 ${candidate.id} 未批准`, 409)
  if (proposal.decision === 'reference') {
    if (source) members.delete(source.id)
    return
  }
  if (proposal.decision === 'rejected') return
  if (proposal.decision === 'keep_original') {
    if (source && sourceRevision)
      members.set(source.id, {
        caseId: source.id,
        revision: sourceRevision.revision,
        ordinal: 0,
        contentSha256: sourceRevision.contentSha256,
      })
    return
  }
  if (proposal.operation === 'reuse') {
    const testCase = required(source, 'LIBRARY_TEST_CASE_NOT_FOUND', '复用来源用例不存在')
    const revision = required(sourceRevision, 'LIBRARY_TEST_CASE_REVISION_NOT_FOUND', '复用来源 Revision 不存在')
    members.set(testCase.id, {
      caseId: testCase.id,
      revision: revision.revision,
      ordinal: 0,
      contentSha256: revision.contentSha256,
    })
    proposal.appliedCaseId = testCase.id
    proposal.appliedRevision = revision.revision
    return
  }
  if (proposal.operation === 'update') {
    const testCase = required(source, 'LIBRARY_TEST_CASE_NOT_FOUND', '修改来源用例不存在')
    const content = required(
      candidateRevision?.content,
      'CASE_CHANGE_PROPOSAL_CANDIDATE_INVALID',
      '修改 Proposal 缺少候选内容',
    )
    const revision = createLibraryRevision(
      testCase.currentRevision + 1,
      content,
      actorId,
      proposal.reason,
      run.id,
      proposal.id,
      traceabilityForProposal(run, proposal, content),
    )
    testCase.revisions.push(revision)
    testCase.currentRevision = revision.revision
    testCase.status = 'active'
    testCase.updatedAt = revision.createdAt
    members.set(testCase.id, {
      caseId: testCase.id,
      revision: revision.revision,
      ordinal: 0,
      contentSha256: revision.contentSha256,
    })
    proposal.appliedCaseId = testCase.id
    proposal.appliedRevision = revision.revision
    return
  }
  if (proposal.operation === 'create') {
    const content = required(
      candidateRevision?.content,
      'CASE_CHANGE_PROPOSAL_CANDIDATE_INVALID',
      '新增 Proposal 缺少候选内容',
    )
    const createdAt = now()
    const revision = createLibraryRevision(
      1,
      content,
      actorId,
      proposal.reason,
      run.id,
      proposal.id,
      traceabilityForProposal(run, proposal, content),
    )
    const testCase: LibraryTestCase = {
      id: `library_test_case_${randomUUID()}`,
      projectId,
      currentRevision: 1,
      status: 'active',
      createdAt,
      updatedAt: createdAt,
      revisions: [revision],
    }
    aggregate.libraryCases.push(testCase)
    members.set(testCase.id, { caseId: testCase.id, revision: 1, ordinal: 0, contentSha256: revision.contentSha256 })
    proposal.appliedCaseId = testCase.id
    proposal.appliedRevision = 1
    return
  }
  if (proposal.operation === 'deprecate' && proposal.decision === 'deprecated') {
    const testCase = required(source, 'LIBRARY_TEST_CASE_NOT_FOUND', '废弃来源用例不存在')
    testCase.status = 'deprecated'
    testCase.updatedAt = now()
    members.delete(testCase.id)
    proposal.appliedCaseId = testCase.id
    proposal.appliedRevision = testCase.currentRevision
  }
}

export function libraryProjectionFiles(
  projectVersionName: string,
  version: TestCaseLibraryVersion,
  cases: LibraryTestCase[],
): TestDesignWorkspaceFile[] {
  const directory = `workspace/branches/${safeWorkspaceSegment(projectVersionName)}/test-case-library/v${version.version}`
  const entries = version.members.map(member => {
    const testCase = required(
      cases.find(item => item.id === member.caseId),
      'LIBRARY_TEST_CASE_NOT_FOUND',
      '正式用例不存在',
    )
    const revision = required(
      testCase.revisions.find(item => item.revision === member.revision),
      'LIBRARY_TEST_CASE_REVISION_NOT_FOUND',
      '正式用例 Revision 不存在',
    )
    const content = member.frozenContent ?? revision.content
    if (canonicalSha256(content) !== member.contentSha256 || revision.contentSha256 !== member.contentSha256)
      throw new TestDesignError(
        'TEST_CASE_LIBRARY_MEMBER_HASH_MISMATCH',
        'Workspace 投影前发现冻结内容 Hash 不一致',
        409,
        { versionId: version.id, caseId: member.caseId, revision: member.revision },
      )
    const traceability = member.traceability ?? revision.traceability
    if (traceability) assertFixedTraceability(traceability)
    return {
      caseId: testCase.id,
      revision: revision.revision,
      contentSha256: member.contentSha256,
      content: structuredClone(content),
      ...(traceability ? { traceability: structuredClone(traceability) } : {}),
      executionReadiness: member.executionReadiness ?? executionConfiguration(content).status,
    }
  })
  const canonicalContent = {
    schemaVersion: 'test-case-library/v3',
    versionId: version.id,
    projectId: version.projectId,
    version: version.version,
    name: version.name,
    contentSha256: version.contentSha256,
    cases: entries,
  }
  const json = `${canonicalJson(canonicalContent)}\n`
  const markdown = [
    `# ${version.name}`,
    '',
    `- Library Version: ${version.version}`,
    `- Version ID: ${version.id}`,
    `- SHA-256: ${version.contentSha256}`,
    '',
    ...entries.flatMap(item => {
      const trace = item.traceability
      const requirementIds = trace?.requirementRefs.map(reference => reference.requirementId) ?? []
      return [
        `## ${item.caseId} r${item.revision} · ${item.content.title}`,
        '',
        `- Case ID: ${item.caseId}`,
        `- Revision: r${item.revision}`,
        `- Content SHA-256: ${item.contentSha256}`,
        `- Dimension: ${item.content.dimension}`,
        `- Priority: ${item.content.priority}`,
        `- Execution Methods: ${item.content.executionMethods.join(', ')}`,
        `- Requirement Release: ${trace?.sourceRequirementReleaseId ?? version.sourceRunId ?? '未绑定'}`,
        `- Requirement ID: ${requirementIds.length ? requirementIds.join(', ') : '扩展测试'}`,
        '',
        '### 前置条件',
        ...item.content.preconditions.map(value => `- ${value}`),
        '',
        '### 步骤',
        ...item.content.steps.map(value => `- ${value}`),
        '',
        '### 预期结果',
        ...item.content.expectedResults.map(value => `- ${value}`),
        '',
      ]
    }),
  ].join('\n')
  const files = [
    { name: 'test-cases.json', content: json, displayName: `用例库 V${version.version} JSON` },
    { name: 'test-cases.md', content: markdown, displayName: `用例库 V${version.version} 文档` },
  ]
  const manifestBody = {
    schemaVersion: 'test-case-library-manifest/v3',
    versionId: version.id,
    contentSha256: version.contentSha256,
    members: entries.map(item => ({
      caseId: item.caseId,
      revision: item.revision,
      contentSha256: item.contentSha256,
      executionMethods: item.content.executionMethods,
      ...(item.traceability
        ? { traceability: item.traceability }
        : { traceabilityStatus: '扩展测试，无 Requirement direct trace' }),
    })),
    files: files.map(file => ({ name: file.name, sha256: canonicalSha256Text(file.content) })),
  }
  const manifest = `${canonicalJson(manifestBody)}\n`
  return [
    ...files.map(file => ({
      logicalPath: `${directory}/${file.name}`,
      sourceType: 'test_case_library_version' as const,
      sourceId: version.id,
      contentSha256: canonicalSha256Text(file.content),
      content: file.content,
      displayName: file.displayName,
      sourceScope: 'formal_output' as const,
    })),
    {
      logicalPath: `${directory}/manifest.json`,
      sourceType: 'test_case_library_version',
      sourceId: version.id,
      contentSha256: canonicalSha256Text(manifest),
      content: manifest,
      displayName: `用例库 V${version.version} Manifest`,
      sourceScope: 'formal_output',
    },
  ]
}

export function testExecutionMethod(value: unknown, label: string): TestExecutionMethod {
  if (value !== 'ui' && value !== 'api')
    throw new TestDesignError('TEST_EXECUTION_CASE_NOT_READY', `${label} 只能是 ui 或 api`, 422)
  return value
}
