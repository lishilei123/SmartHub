import { randomUUID } from 'node:crypto'
import type {
  CaseChangeDecision,
  CaseChangeProposal,
  EffectiveTestCase,
  HistoricalCaseSnapshot,
  TestCase,
  TestCaseContent,
  TestDesignWorkflowRun,
} from '../../domain/test-design-types.js'
import { canonicalSha256 } from '../canonical-json.js'
import { etag, TestDesignError, validateCaseDependencyGraph } from '../test-design-validation.js'
import { structuralDiff, cleanRequired, now, required } from './state.js'

const TEST_DESIGN_SERVICE_ACTOR_ID = 'system:test-design-service'

export function isHistoricalTestCaseContent(value: unknown): value is TestCaseContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const content = value as Partial<TestCaseContent>
  return (
    content.schemaVersion === 'test-case/v3' &&
    typeof content.title === 'string' &&
    typeof content.dimension === 'string' &&
    Array.isArray(content.requirementRefs) &&
    Array.isArray(content.executionMethods) &&
    Array.isArray(content.preconditions) &&
    Array.isArray(content.steps) &&
    Array.isArray(content.expectedResults)
  )
}

export function effectiveHistoricalRequirementRefs(
  run: TestDesignWorkflowRun,
  historical: HistoricalCaseSnapshot['items'][number],
) {
  const currentRequirementIds = new Set(
    run.basisSnapshot.content.requirements.map(item => item.clientRequirementPointId.trim()),
  )
  return [
    ...new Set(
      historical.sourceRequirementRefs.flatMap(sourceRequirementId => {
        const mapping = run.historicalSnapshot.requirementMappings.find(
          item => item.sourceRequirementId === sourceRequirementId,
        )
        return mapping?.targetRequirementId &&
          currentRequirementIds.has(mapping.targetRequirementId) &&
          (mapping.status === 'exact' || mapping.status === 'high_confidence')
          ? [mapping.targetRequirementId]
          : []
      }),
    ),
  ]
}

export function requirementRefsForCase(_run: TestDesignWorkflowRun, content: TestCaseContent) {
  return [...new Set(content.requirementRefs ?? [])]
}

export function buildEffectiveCaseSet(run: TestDesignWorkflowRun): EffectiveTestCase[] {
  const effective = new Map<string, EffectiveTestCase>()
  for (const historical of run.historicalSnapshot.items) {
    if (!isHistoricalTestCaseContent(historical.content)) continue
    const locator = historical.locator as { caseId?: unknown; revision?: unknown } | undefined
    if (typeof locator?.caseId !== 'string' || !Number.isInteger(locator.revision)) continue
    const revision = locator.revision as number
    effective.set(locator.caseId, {
      caseId: locator.caseId,
      revision,
      content: structuredClone(historical.content),
      contentSha256: historical.contentSha256,
      effectiveRequirementRefs: effectiveHistoricalRequirementRefs(run, historical),
      source: 'historical_reuse',
      sourceCaseId: locator.caseId,
    })
  }
  for (const proposal of run.caseChangeProposals) {
    const candidate = proposal.candidateCaseId
      ? run.testCases.find(item => item.id === proposal.candidateCaseId && !item.tombstonedAt)
      : undefined
    const candidateRevision = candidate ? currentCaseRevision(candidate) : undefined
    if (
      proposal.operation === 'update' &&
      proposal.sourceCaseId &&
      proposal.sourceRevision !== undefined &&
      candidateRevision
    ) {
      effective.set(proposal.sourceCaseId, {
        caseId: proposal.sourceCaseId,
        revision: proposal.sourceRevision + 1,
        content: structuredClone(candidateRevision.content),
        contentSha256: candidateRevision.contentSha256,
        effectiveRequirementRefs: requirementRefsForCase(run, candidateRevision.content),
        source: 'historical_update',
        sourceCaseId: proposal.sourceCaseId,
        candidateCaseId: candidate!.id,
      })
    }
    if (proposal.operation === 'create' && candidateRevision) {
      effective.set(candidate!.id, {
        caseId: candidate!.id,
        revision: 1,
        content: structuredClone(candidateRevision.content),
        contentSha256: candidateRevision.contentSha256,
        effectiveRequirementRefs: requirementRefsForCase(run, candidateRevision.content),
        source: 'candidate_create',
        candidateCaseId: candidate!.id,
      })
    }
  }
  return [...effective.values()].sort((left, right) => left.caseId.localeCompare(right.caseId))
}

export function testCaseSemanticSha256(content: TestCaseContent) {
  return canonicalSha256({
    title: content.title,
    dimension: content.dimension,
    priority: content.priority,
    executionMethods: content.executionMethods,
    preconditions: content.preconditions,
    steps: content.steps,
    expectedResults: content.expectedResults,
  })
}

export function semanticContentSha256(content: TestCaseContent) {
  return testCaseSemanticSha256(content)
}

export function newCase(
  runId: string,
  content: TestCaseContent,
  origin: TestCase['origin'],
  actorId: string,
  reason: string,
  id = `test_case_${randomUUID()}`,
): TestCase {
  const revision = createCaseRevision(0, content, actorId, reason)
  return { id, runId, origin, currentRevision: 0, reviewState: 'in_review', revisions: [revision], reviewActions: [] }
}

export function createCaseRevision(
  revision: number,
  content: TestCaseContent,
  actorId: string,
  reason: string,
  previous?: TestCaseContent,
) {
  return {
    revision,
    content: structuredClone(content),
    contentSha256: canonicalSha256(content),
    semanticSha256: semanticContentSha256(content),
    diff: previous ? structuralDiff(previous, content) : [],
    editorId: actorId,
    reason: cleanRequired(reason, '保存说明', 2_000),
    createdAt: now(),
  }
}

export function caseChangeProposalSha256(proposals: CaseChangeProposal[]) {
  return canonicalSha256(
    proposals
      .map(item => ({
        id: item.id,
        operation: item.operation,
        ...(item.sourceCaseId ? { sourceCaseId: item.sourceCaseId } : {}),
        ...(item.sourceRevision !== undefined ? { sourceRevision: item.sourceRevision } : {}),
        ...(item.candidateCaseId ? { candidateCaseId: item.candidateCaseId } : {}),
        ...(item.candidateContent ? { candidateContentSha256: canonicalSha256(item.candidateContent) } : {}),
        decision: item.decision,
        decisionVersion: item.decisions.length,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  )
}

function proposalSourceContent(run: TestDesignWorkflowRun, proposal: CaseChangeProposal): TestCaseContent | undefined {
  if (!proposal.sourceCaseId || proposal.sourceRevision === undefined) return undefined
  return run.historicalSnapshot.items.find(item => {
    const locator = item.locator as { caseId?: unknown; revision?: unknown } | undefined
    return locator?.caseId === proposal.sourceCaseId && locator?.revision === proposal.sourceRevision
  })?.content as TestCaseContent | undefined
}

export function requiresHumanProposalDecision(_proposal: CaseChangeProposal) {
  return false
}

function resetProposalDecision(proposal: CaseChangeProposal) {
  proposal.decision = 'pending'
  delete proposal.decidedBy
  delete proposal.decidedAt
  delete proposal.appliedCaseId
  delete proposal.appliedRevision
}

export function ensureCandidateProposal(run: TestDesignWorkflowRun, testCase: TestCase, reason: string) {
  const revision = currentCaseRevision(testCase)
  const existing = run.caseChangeProposals.find(item => item.candidateCaseId === testCase.id)
  const source = existing ? proposalSourceContent(run, existing) : undefined
  const operation: CaseChangeProposal['operation'] = source
    ? revision.semanticSha256 === semanticContentSha256(source)
      ? 'reuse'
      : 'update'
    : 'create'
  if (!existing) {
    run.caseChangeProposals.push({
      id: `case_change_proposal_${randomUUID()}`,
      runId: run.id,
      operation,
      candidateCaseId: testCase.id,
      candidateContent: structuredClone(revision.content),
      diff: [],
      requirementRefs: requirementRefsForCase(run, revision.content),
      reason,
      confidence: 1,
      decision: 'pending',
      createdAt: now(),
      decisions: [],
    })
    return
  }
  const changed =
    existing.operation !== operation ||
    !existing.candidateContent ||
    semanticContentSha256(existing.candidateContent) !== revision.semanticSha256
  existing.operation = operation
  existing.candidateContent = structuredClone(revision.content)
  existing.diff = source ? structuralDiff(source, revision.content) : []
  existing.requirementRefs = requirementRefsForCase(run, revision.content)
  existing.reason = reason
  if (changed) resetProposalDecision(existing)
}

export function convertDeletedCandidateProposal(run: TestDesignWorkflowRun, testCase: TestCase) {
  const proposal = run.caseChangeProposals.find(item => item.candidateCaseId === testCase.id)
  if (!proposal) return
  if (!proposal.sourceCaseId || proposal.sourceRevision === undefined) {
    run.caseChangeProposals = run.caseChangeProposals.filter(item => item.id !== proposal.id)
    return
  }
  proposal.operation = 'reuse'
  proposal.reason = 'Candidate Delta 已移除该更新；Service 回退为保留冻结历史 Revision'
  proposal.diff = []
  delete proposal.candidateCaseId
  delete proposal.candidateContent
  resetProposalDecision(proposal)
}

export function reconcileAutomaticProposalDecisions(run: TestDesignWorkflowRun) {
  for (const proposal of run.caseChangeProposals) {
    if (proposal.decision !== 'pending' || requiresHumanProposalDecision(proposal)) continue
    const candidate = proposal.candidateCaseId
      ? run.testCases.find(item => item.id === proposal.candidateCaseId && !item.tombstonedAt)
      : undefined
    const eligible =
      proposal.operation === 'reuse' ||
      ((proposal.operation === 'create' || proposal.operation === 'update') && candidate?.reviewState === 'approved')
    if (!eligible) continue
    const decidedAt = now()
    proposal.decision = 'accepted'
    proposal.decidedBy = TEST_DESIGN_SERVICE_ACTOR_ID
    proposal.decidedAt = decidedAt
    proposal.decisions.push({
      id: `case_change_decision_${randomUUID()}`,
      expectedVersion: proposal.decisions.length,
      decision: 'accepted',
      comment:
        proposal.operation === 'reuse'
          ? 'Service 自动保留并复用冻结 Historical Baseline Revision'
          : 'Service 随当前 TestCase Revision 审核通过自动接受',
      decidedBy: TEST_DESIGN_SERVICE_ACTOR_ID,
      decidedAt,
    })
  }
}

export function validateProposalDecision(
  proposal: CaseChangeProposal,
  decision: Exclude<CaseChangeDecision, 'pending'>,
) {
  const allowed: Record<CaseChangeProposal['operation'], Array<Exclude<CaseChangeDecision, 'pending'>>> = {
    reuse: [],
    update: [],
    create: [],
    deprecate: ['deprecated', 'keep_original'],
    reference: ['reference', 'rejected'],
  }
  if (!allowed[proposal.operation].includes(decision))
    throw new TestDesignError(
      'CASE_CHANGE_PROPOSAL_DECISION_INVALID',
      `${proposal.operation} 不允许决策 ${decision}`,
      422,
    )
}

export function applyReviewAction(
  testCase: TestCase,
  input: {
    decision: 'submit' | 'approve' | 'reject' | 'request_revision' | 'withdraw'
    targetRevision: number
    comment?: string
  },
  actorId: string,
) {
  if (testCase.currentRevision !== input.targetRevision)
    throw new TestDesignError('TEST_CASE_REVISION_CONFLICT', '审核目标 revision 已变化', 412)
  if (['reject', 'request_revision'].includes(input.decision) && !input.comment?.trim())
    throw new TestDesignError('TEST_CASE_REVIEW_COMMENT_REQUIRED', '退回修改或拒绝必须填写审核意见。', 422)
  const transitions = {
    draft: { submit: 'in_review' },
    in_review: { approve: 'approved', reject: 'rejected', request_revision: 'needs_revision', withdraw: 'draft' },
    approved: { request_revision: 'needs_revision' },
    rejected: {},
    needs_revision: { submit: 'in_review' },
  } as const
  const toState = (transitions[testCase.reviewState] as Record<string, TestCase['reviewState'] | undefined>)[
    input.decision
  ]
  if (!toState)
    throw new TestDesignError(
      'TEST_CASE_REVIEW_TRANSITION_INVALID',
      `不能从 ${testCase.reviewState} 执行 ${input.decision}`,
      409,
    )
  testCase.reviewActions.push({
    id: `test_case_review_${randomUUID()}`,
    targetRevision: input.targetRevision,
    fromState: testCase.reviewState,
    toState,
    decision: input.decision,
    ...(input.comment?.trim() ? { comment: input.comment.trim().slice(0, 4_000) } : {}),
    actorId,
    createdAt: now(),
  })
  testCase.reviewState = toState
}

export function validateCurrentDependencyGraph(run: TestDesignWorkflowRun) {
  validateCaseDependencyGraph(
    run.testCases
      .filter(item => !item.tombstonedAt)
      .map(item => ({ id: item.id, content: currentCaseRevision(item).content })),
  )
}

export function invalidateAudit(run: TestDesignWorkflowRun) {
  run.coverageAudits.forEach(item => {
    item.status = 'stale'
  })
}

export function currentCaseRevision(testCase: TestCase) {
  return required(
    testCase.revisions.find(item => item.revision === testCase.currentRevision),
    'TEST_CASE_REVISION_NOT_FOUND',
    '用例当前 revision 不存在',
  )
}

export function findCase(run: TestDesignWorkflowRun, caseId: string) {
  return required(
    run.testCases.find(item => item.id === caseId),
    'TEST_CASE_NOT_FOUND',
    '测试用例不存在',
  )
}

export function presentCase(testCase: TestCase, detail = false) {
  const revision = currentCaseRevision(testCase)
  const value = {
    id: testCase.id,
    runId: testCase.runId,
    origin: testCase.origin,
    currentRevision: testCase.currentRevision,
    reviewState: testCase.reviewState,
    content: structuredClone(revision.content),
    contentSha256: revision.contentSha256,
    etag: etag('case', testCase.id, revision.revision, revision.contentSha256),
    ...(detail
      ? {
          revisions: structuredClone(testCase.revisions),
          reviewActions: structuredClone(testCase.reviewActions),
          tombstonedAt: testCase.tombstonedAt,
        }
      : {}),
  }
  return value
}
