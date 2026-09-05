import { randomUUID } from 'node:crypto'
import type { AgentExecutionEvent } from '../../domain/agent-types.js'
import type {
  CoverageAudit,
  HistoricalCaseSnapshot,
  TestCase,
  TestCaseContent,
  TestDesignNodeKey,
  TestDesignWorkflowRun,
  WorkflowArtifact,
  WorkflowNodeRun,
} from '../../domain/test-design-types.js'
import { canonicalSha256 } from '../canonical-json.js'
import { auditTestDesignCoverage } from '../test-design-coverage-auditor.js'
import {
  isTestDesignRepairPatch,
  TestDesignError,
  validateTestCaseDesignCandidate,
  type CandidateCase,
  type TestCaseDesignCandidate,
  type TestDesignRepairPatch,
} from '../test-design-validation.js'
import { required, now, structuralDiff, errorCode } from './state.js'
import {
  currentCaseRevision,
  semanticContentSha256,
  createCaseRevision,
  newCase,
  validateCurrentDependencyGraph,
  requirementRefsForCase,
  reconcileAutomaticProposalDecisions,
  isHistoricalTestCaseContent,
  effectiveHistoricalRequirementRefs,
  buildEffectiveCaseSet,
} from './case-review.js'
import { sameStringSet, normalizeSemanticText, tokenSimilarity } from './snapshots.js'

const AUTOMATIC_REPAIR_MAX_ATTEMPTS = 1

const PLANNING_AGENT_EDITOR_ID = 'planning-agent'

type RepairCandidateCase = { ref: string } & TestCaseContent

type RepairCandidateSnapshot = {
  schemaVersion: 'test-case-design/v3'
  cases: RepairCandidateCase[]
}

export function workflowNodes(runId: string): WorkflowNodeRun[] {
  const definition: Array<[TestDesignNodeKey, TestDesignNodeKey[]]> = [
    ['test_case_design', []],
    ['coverage_audit', ['test_case_design']],
    ['test_design_repair', ['coverage_audit']],
  ]
  return definition.map(([nodeKey, dependencies]) => ({
    id: `${runId}:${nodeKey}:g1:a0`,
    nodeKey,
    generation: 1,
    attempt: 0,
    status: nodeKey === 'test_case_design' ? 'queued' : 'pending',
    dependencies,
  }))
}

export function caseDesignInput(run: TestDesignWorkflowRun) {
  return {
    workspaceSnapshotSha256: run.workspaceSnapshot.snapshotSha256,
    requirementReleaseId: run.workspaceSnapshot.requirementReleaseId,
    requirementReleaseContentSha256: run.workspaceSnapshot.requirementReleaseContentSha256,
  }
}

export function repairInput(run: TestDesignWorkflowRun) {
  const state = required(run.automaticRepair, 'TEST_DESIGN_REPAIR_NOT_QUEUED', '自动修复状态不存在')
  const audit = required(
    run.coverageAudits.find(item => item.id === state.triggerAuditId),
    'TEST_DESIGN_REPAIR_AUDIT_NOT_FOUND',
    '触发修复的 Coverage Audit 不存在',
  )
  return {
    schemaVersion: 'test-design-repair-context/v1',
    attempt: state.attempt,
    maxAttempts: state.maxAttempts,
    auditId: audit.id,
    blockers: selectedRepairBlockers(audit, state),
    candidateWorkspacePath: 'workspace/agent_workspace/planning_agent/current-test-cases.json',
    baseCandidateSha256: canonicalSha256(repairCandidateContent(run)),
  }
}

export function repairCandidateContent(run: TestDesignWorkflowRun): RepairCandidateSnapshot {
  const activeCases = run.testCases.filter(item => !item.tombstonedAt)
  return {
    schemaVersion: 'test-case-design/v3',
    cases: activeCases.map(testCase => {
      const revision = currentCaseRevision(testCase)
      return { ref: testCase.candidateRef ?? `case-${testCase.id}`, ...structuredClone(revision.content) }
    }),
  }
}

function completeCandidateSnapshot(value: TestCaseDesignCandidate | RepairCandidateSnapshot) {
  return {
    schemaVersion: 'test-design-candidate-snapshot/v3',
    sourceSchemaVersion: value.schemaVersion,
    cases: value.cases.map(item => ('content' in item ? flatCandidateCase(item) : structuredClone(item))),
  }
}

function flatCandidateCase(candidate: CandidateCase): RepairCandidateCase {
  return { ref: candidate.ref, ...structuredClone(candidate.content) }
}

function requiredRepairCaseRef(refById: Map<string, string>, caseId: string) {
  const ref = refById.get(caseId)
  if (!ref)
    throw new TestDesignError(
      'TEST_DESIGN_REPAIR_CASE_REFERENCE_INVALID',
      `自动修复候选引用的用例不存在或已删除：${caseId}`,
      409,
    )
  return ref
}

export function materializeCaseDesign(
  run: TestDesignWorkflowRun,
  raw: unknown,
  actorId: string,
  repair: boolean,
): TestCaseDesignCandidate {
  const submitted = validateTestCaseDesignCandidate(raw, repair)
  const value = isTestDesignRepairPatch(submitted) ? applyRepairPatch(run, submitted) : submitted
  if (!value.cases.length && !run.historicalSnapshot.items.length)
    throw new TestDesignError(
      'TEST_DESIGN_CANDIDATE_EMPTY',
      '没有冻结 Historical Baseline 时，test-case-design/v3 至少需要一条测试用例',
      422,
    )
  validateCandidateRequirementRefs(run, value)
  const existingByRef = new Map(
    run.testCases.filter(item => !item.tombstonedAt && item.candidateRef).map(item => [item.candidateRef!, item]),
  )
  const idByRef = new Map(
    value.cases.map(candidate => [candidate.ref, existingByRef.get(candidate.ref)?.id ?? `test_case_${randomUUID()}`]),
  )
  const nextCases = value.cases.map(candidate => {
    const content = candidate.content
    const current = existingByRef.get(candidate.ref)
    if (current) {
      const previous = currentCaseRevision(current)
      if (previous.semanticSha256 !== semanticContentSha256(content)) {
        const revision = createCaseRevision(
          previous.revision + 1,
          content,
          PLANNING_AGENT_EDITOR_ID,
          repair ? 'PlanningAgent Repair Patch' : 'PlanningAgent 候选更新',
          previous.content,
        )
        current.revisions.push(revision)
        current.currentRevision = revision.revision
        current.reviewState = 'in_review'
      }
      current.tombstonedAt = undefined
      return current
    }
    const testCase = newCase(
      run.id,
      content,
      'ai',
      PLANNING_AGENT_EDITOR_ID,
      'PlanningAgent Candidate Delta',
      idByRef.get(candidate.ref)!,
    )
    testCase.candidateRef = candidate.ref
    return testCase
  })
  if (repair)
    for (const removed of run.testCases.filter(item => item.candidateRef && !idByRef.has(item.candidateRef)))
      removed.tombstonedAt = now()
  run.testCases = repair ? [...run.testCases.filter(item => !item.candidateRef), ...nextCases] : nextCases
  materializeCaseChangeProposals(run, value, nextCases)
  validateCurrentDependencyGraph(run)
  return value
}

function validateCandidateRequirementRefs(run: TestDesignWorkflowRun, value: TestCaseDesignCandidate) {
  const allowed = new Set(run.basisSnapshot.content.requirements.map(item => item.clientRequirementPointId.trim()))
  for (const candidate of value.cases) {
    const invalid = candidate.content.requirementRefs.filter(ref => !allowed.has(ref))
    if (invalid.length)
      throw new TestDesignError(
        'TEST_CASE_REQUIREMENT_REFERENCE_INVALID',
        `用例 ${candidate.ref} 引用了当前 Requirement Release 之外的需求：${invalid.join('、')}`,
        422,
        { ref: candidate.ref, invalidRequirementRefs: invalid },
      )
  }
}

function applyRepairPatch(run: TestDesignWorkflowRun, patch: TestDesignRepairPatch): TestCaseDesignCandidate {
  const before = repairCandidateContent(run)
  const actualSha256 = canonicalSha256(before)
  if (patch.baseCandidateSha256 !== actualSha256)
    throw new TestDesignError(
      'TEST_DESIGN_REPAIR_BASE_CANDIDATE_CONFLICT',
      'Repair Patch 的 baseCandidateSha256 与当前完整 Candidate 不一致，请重新读取当前快照后提交',
      409,
      { expectedBaseCandidateSha256: actualSha256, actualBaseCandidateSha256: patch.baseCandidateSha256 },
    )
  const cases = new Map(before.cases.map(item => [item.ref, structuredClone(item)]))
  for (const ref of patch.removeCaseRefs) {
    if (!cases.delete(ref))
      throw new TestDesignError(
        'TEST_DESIGN_REPAIR_CASE_REFERENCE_INVALID',
        `removeCaseRefs 引用了不存在的当前 Candidate：${ref}`,
        422,
      )
  }
  for (const candidate of patch.upsertCases) {
    cases.set(candidate.ref, flatCandidateCase(candidate))
  }
  const normalized = validateTestCaseDesignCandidate(
    { schemaVersion: 'test-case-design/v3', cases: [...cases.values()] },
    false,
  )
  if (isTestDesignRepairPatch(normalized))
    throw new TestDesignError('TEST_DESIGN_REPAIR_PATCH_INVALID', 'Repair Patch 未能展开为完整 Candidate', 422)
  return normalized
}

function materializeCaseChangeProposals(run: TestDesignWorkflowRun, value: TestCaseDesignCandidate, cases: TestCase[]) {
  const byRef = new Map(
    cases.flatMap(testCase => (testCase.candidateRef ? [[testCase.candidateRef, testCase] as const] : [])),
  )
  const usedHistorical = new Set<string>()
  const candidates: Array<{
    operation: 'reuse' | 'update' | 'create'
    sourceCaseId?: string
    sourceRevision?: number
    candidateRef?: string
    requirementRefs: string[]
    reason: string
    confidence: number
  }> = value.cases.map(candidate => {
    const testCase = required(byRef.get(candidate.ref), 'CASE_CHANGE_PROPOSAL_CANDIDATE_INVALID', '候选用例不存在')
    const revision = currentCaseRevision(testCase)
    const match = matchHistoricalCandidate(run, revision.content, usedHistorical)
    const historical = match.item
    if (historical) usedHistorical.add(historical.id)
    const locator = historical?.locator as { caseId?: string; revision?: number } | undefined
    if (historical && locator?.caseId && locator.revision !== undefined) {
      testCase.historicalSourceRef = historical.id
      testCase.origin = match.kind === 'exact' ? 'historical_unchanged' : 'historical_modified'
      if (match.kind === 'exact') testCase.reviewState = 'approved'
      return {
        operation: match.kind === 'exact' ? 'reuse' : 'update',
        sourceCaseId: locator.caseId,
        sourceRevision: locator.revision,
        candidateRef: candidate.ref,
        requirementRefs: requirementRefsForCase(run, revision.content),
        reason:
          match.kind === 'exact'
            ? 'Service 通过唯一 semanticSha256 匹配复用冻结 Revision'
            : 'Service 通过标题、维度、Requirement 与执行方式的唯一高置信匹配识别语义更新',
        confidence: match.kind === 'exact' ? 1 : 0.9,
      }
    }
    return {
      operation: 'create' as const,
      candidateRef: candidate.ref,
      requirementRefs: requirementRefsForCase(run, revision.content),
      reason:
        match.kind === 'ambiguous'
          ? '存在多个可能的历史交集，Service 安全降级为新增并保留全部历史用例'
          : 'Service 未匹配到可证明为同一测试意图的冻结历史用例',
      confidence: match.kind === 'ambiguous' ? 0.5 : 0.8,
    }
  })
  for (const historical of run.historicalSnapshot.items.filter(item => !usedHistorical.has(item.id))) {
    const locator = historical.locator as { caseId?: string; revision?: number } | undefined
    if (locator?.caseId && locator.revision !== undefined)
      candidates.push({
        operation: 'reuse',
        sourceCaseId: locator.caseId,
        sourceRevision: locator.revision,
        requirementRefs: requirementRefsForCase(run, historical.content as TestCaseContent),
        reason: '本轮 Candidate Delta 未修改该冻结历史用例，Service 默认保留并复用原 Revision',
        confidence: 1,
      })
  }
  const frozenByCase = new Map(
    run.historicalSnapshot.items.flatMap(item => {
      const locator = item.locator as { caseId?: unknown; revision?: unknown } | undefined
      return typeof locator?.caseId === 'string' && Number.isInteger(locator.revision)
        ? [[`${locator.caseId}:${locator.revision}`, item] as const]
        : []
    }),
  )
  const existing = new Map(
    run.caseChangeProposals.map(item => [
      proposalAssociation(
        item.sourceCaseId,
        item.sourceRevision,
        cases.find(candidate => candidate.id === item.candidateCaseId)?.candidateRef,
      ),
      item,
    ]),
  )
  run.caseChangeProposals = candidates.map(candidate => {
    const source =
      candidate.sourceCaseId && candidate.sourceRevision !== undefined
        ? required(
            frozenByCase.get(`${candidate.sourceCaseId}:${candidate.sourceRevision}`),
            'CASE_CHANGE_PROPOSAL_SOURCE_INVALID',
            'Proposal 来源不属于冻结历史用例',
          )
        : undefined
    const testCase = candidate.candidateRef
      ? required(byRef.get(candidate.candidateRef), 'CASE_CHANGE_PROPOSAL_CANDIDATE_INVALID', 'Proposal 候选用例不存在')
      : undefined
    const content = testCase ? currentCaseRevision(testCase).content : undefined
    const operation =
      source &&
      content &&
      ['reuse', 'update'].includes(candidate.operation) &&
      semanticContentSha256(content) === source.semanticSha256
        ? 'reuse'
        : candidate.operation
    const retained = existing.get(
      proposalAssociation(candidate.sourceCaseId, candidate.sourceRevision, candidate.candidateRef),
    )
    const candidateChanged = Boolean(
      retained?.candidateContent &&
        content &&
        semanticContentSha256(retained.candidateContent) !== semanticContentSha256(content),
    )
    const resetDecision = Boolean(retained && (candidateChanged || retained.operation !== operation))
    const createdAt = retained?.createdAt ?? now()
    return {
      id: retained?.id ?? `case_change_proposal_${randomUUID()}`,
      runId: run.id,
      operation,
      ...(candidate.sourceCaseId ? { sourceCaseId: candidate.sourceCaseId } : {}),
      ...(candidate.sourceRevision !== undefined ? { sourceRevision: candidate.sourceRevision } : {}),
      ...(testCase ? { candidateCaseId: testCase.id, candidateContent: structuredClone(content) } : {}),
      diff: source && content ? structuralDiff(source.content, content) : [],
      requirementRefs: content ? requirementRefsForCase(run, content) : candidate.requirementRefs,
      reason: candidate.reason,
      confidence: candidate.confidence,
      decision: resetDecision ? 'pending' : (retained?.decision ?? 'pending'),
      createdAt,
      ...(!resetDecision && retained?.decidedBy ? { decidedBy: retained.decidedBy } : {}),
      ...(!resetDecision && retained?.decidedAt ? { decidedAt: retained.decidedAt } : {}),
      decisions: retained?.decisions ?? [],
      ...(!resetDecision && retained?.appliedCaseId ? { appliedCaseId: retained.appliedCaseId } : {}),
      ...(!resetDecision && retained?.appliedRevision !== undefined
        ? { appliedRevision: retained.appliedRevision }
        : {}),
    }
  })
  reconcileAutomaticProposalDecisions(run)
}

type HistoricalCandidateMatch = {
  kind: 'exact' | 'update' | 'ambiguous' | 'none'
  item?: HistoricalCaseSnapshot['items'][number]
}

function matchHistoricalCandidate(
  run: TestDesignWorkflowRun,
  content: TestCaseContent,
  usedHistorical: Set<string>,
): HistoricalCandidateMatch {
  const available = run.historicalSnapshot.items.filter(
    item => !usedHistorical.has(item.id) && isHistoricalTestCaseContent(item.content),
  )
  const hash = semanticContentSha256(content)
  const exact = available.filter(item => item.semanticSha256 === hash)
  if (exact.length === 1) return { kind: 'exact', item: exact[0] }
  if (exact.length > 1) return { kind: 'ambiguous' }
  const update = available.filter(item =>
    highConfidenceHistoricalIntent(
      item.content as TestCaseContent,
      content,
      sameMappedRequirements(run, item, content),
    ),
  )
  if (update.length === 1) return { kind: 'update', item: update[0] }
  return { kind: update.length > 1 ? 'ambiguous' : 'none' }
}

function sameMappedRequirements(
  run: TestDesignWorkflowRun,
  historical: HistoricalCaseSnapshot['items'][number],
  candidate: TestCaseContent,
) {
  const mapped = effectiveHistoricalRequirementRefs(run, historical)
  return mapped.length > 0 && candidate.requirementRefs.length > 0 && sameStringSet(mapped, candidate.requirementRefs)
}

function highConfidenceHistoricalIntent(
  historical: TestCaseContent,
  candidate: TestCaseContent,
  sameCurrentRequirements: boolean,
) {
  if (
    normalizeSemanticText(historical.title) !== normalizeSemanticText(candidate.title) ||
    historical.dimension !== candidate.dimension
  )
    return false
  if (!sameStringSet(historical.executionMethods, candidate.executionMethods)) return false
  const behaviorSimilarity = tokenSimilarity(
    [...historical.preconditions, ...historical.steps, ...historical.expectedResults],
    [...candidate.preconditions, ...candidate.steps, ...candidate.expectedResults],
  )
  return sameCurrentRequirements || behaviorSimilarity >= 0.6
}

function proposalAssociation(sourceCaseId?: string, sourceRevision?: number, candidateRef?: string) {
  return `${sourceCaseId ?? ''}:${sourceRevision ?? ''}:${candidateRef ?? ''}`
}

export function finalizeCaseDesignAndAudit(run: TestDesignWorkflowRun, raw: unknown, actorId: string, repair: boolean) {
  const beforeCandidate = repair ? repairCandidateContent(run) : undefined
  const before = beforeCandidate ? completeCandidateSnapshot(beforeCandidate) : undefined
  const value = materializeCaseDesign(run, raw, actorId, repair)
  const after = completeCandidateSnapshot(value)
  const artifact = repair
    ? {
        schemaVersion: 'test-design-repair-snapshot/v3',
        content: {
          baseCandidateSha256: canonicalSha256(beforeCandidate!),
          before,
          after,
          diff: structuralDiff(before, after),
        },
      }
    : { schemaVersion: 'test-case-design-candidate-snapshot/v3', content: after }
  const auditNode = node(run, 'coverage_audit')
  Object.assign(auditNode, {
    status: 'running',
    attempt: auditNode.attempt + 1,
    startedAt: now(),
    finishedAt: undefined,
    error: undefined,
    errorCode: undefined,
  })
  const audit = runCoverageAudit(run)
  run.coverageAudits.forEach(item => {
    item.status = 'stale'
  })
  run.coverageAudits.push(audit)
  finishNode(run, 'coverage_audit')

  const repairable = audit.blockers.filter(item => item.resolution === 'agent_repair')
  const selectedRepairable = repairable.filter(item => repairBlockerCanRunIndependently(run, audit, item))
  const state = run.automaticRepair ?? initialAutomaticRepairState()
  run.automaticRepair = state
  const safeToRepair = selectedRepairable.every(item => repairBlockerCandidateIsSafe(run, item))
  if (selectedRepairable.length && safeToRepair && state.attempt < state.maxAttempts) {
    const timestamp = now()
    Object.assign(state, {
      status: 'queued',
      attempt: state.attempt + 1,
      blockerCodes: [...new Set(selectedRepairable.map(item => item.code))],
      blockerScopes: selectedRepairable.map(item => ({
        code: item.code,
        ...(item.subjectId ? { subjectId: item.subjectId } : {}),
      })),
      triggerAuditId: audit.id,
      startedAt: state.startedAt ?? timestamp,
      finishedAt: undefined,
    })
    const repairNode = node(run, 'test_design_repair')
    if (repairNode.status === 'pending') queueNode(run, 'test_design_repair')
    else advanceNodeGeneration(run, repairNode, 'queued')
    advanceNodeGeneration(run, node(run, 'coverage_audit'), 'pending')
    Object.assign(run, {
      status: 'queued',
      stage: 'test_design_repair',
      progress: 80,
      finishedAt: undefined,
      error: undefined,
      errorCode: undefined,
    })
    return { repairQueued: true, artifact }
  }

  const attempted = state.attempt > 0
  const status = repairable.length
    ? selectedRepairable.length && state.attempt >= state.maxAttempts
      ? 'exhausted'
      : 'deferred'
    : attempted
      ? 'succeeded'
      : 'not_needed'
  Object.assign(state, {
    status,
    blockerCodes: [...new Set(selectedRepairable.map(item => item.code))],
    blockerScopes: selectedRepairable.map(item => ({
      code: item.code,
      ...(item.subjectId ? { subjectId: item.subjectId } : {}),
    })),
    triggerAuditId: repairable.length ? audit.id : undefined,
    finishedAt: now(),
  })
  Object.assign(run, {
    status: 'succeeded',
    stage: 'completed',
    progress: 100,
    finishedAt: now(),
    error: undefined,
    errorCode: undefined,
  })
  return { repairQueued: false, artifact }
}

function selectedRepairBlockers(audit: CoverageAudit, state: NonNullable<TestDesignWorkflowRun['automaticRepair']>) {
  const scopes = state.blockerScopes
  const agentRepair = audit.blockers.filter(item => item.resolution === 'agent_repair')
  if (!scopes?.length) return agentRepair
  return agentRepair.filter(item =>
    scopes.some(scope => scope.code === item.code && scope.subjectId === item.subjectId),
  )
}

function repairBlockerCanRunIndependently(
  run: TestDesignWorkflowRun,
  audit: CoverageAudit,
  blocker: CoverageAudit['blockers'][number],
) {
  if (blocker.code === 'TEST_CASE_REQUIREMENT_REFERENCE_INVALID') return true
  if (blocker.code !== 'COVERAGE_REQUIREMENT_UNCOVERED' || !blocker.subjectId) return false
  const requirementId = blocker.subjectId
  const relatedCaseIds = new Set(
    run.testCases
      .filter(item => !item.tombstonedAt && currentCaseRevision(item).content.requirementRefs.includes(requirementId))
      .map(item => item.id),
  )
  const relatedClarification = run.basisSnapshot.content.clarifications.some(
    item => item.blocking && item.status === 'pending' && item.requirementPointRefs.includes(requirementId),
  )
  if (relatedClarification) return false
  return !audit.blockers.some(item => {
    if (item.resolution !== 'human_decision' && item.resolution !== 'manual_edit') return false
    if (relatedCaseIds.has(item.subjectId ?? '')) return true
    const clarification = run.basisSnapshot.content.clarifications.find(candidate => candidate.id === item.subjectId)
    return clarification?.requirementPointRefs.includes(requirementId) ?? false
  })
}

function repairBlockerCandidateIsSafe(run: TestDesignWorkflowRun, blocker: CoverageAudit['blockers'][number]) {
  const activeCases = run.testCases.filter(item => !item.tombstonedAt)
  const relatedIds = new Set<string>()
  if (blocker.subjectId && activeCases.some(item => item.id === blocker.subjectId)) relatedIds.add(blocker.subjectId)
  if (blocker.code === 'COVERAGE_REQUIREMENT_UNCOVERED' && blocker.subjectId)
    activeCases
      .filter(item => currentCaseRevision(item).content.requirementRefs.includes(blocker.subjectId!))
      .forEach(item => relatedIds.add(item.id))
  return [...relatedIds].every(caseId => {
    const candidate = activeCases.find(item => item.id === caseId)!
    const proposal = run.caseChangeProposals.find(item => item.candidateCaseId === candidate.id)
    return (
      candidate.origin !== 'manual' &&
      candidate.reviewActions.length === 0 &&
      candidate.revisions.every(revision => revision.editorId === PLANNING_AGENT_EDITOR_ID) &&
      (!proposal || proposal.decision === 'pending')
    )
  })
}

export function runCoverageAudit(run: TestDesignWorkflowRun): CoverageAudit {
  const audit = auditTestDesignCoverage({
    runId: run.id,
    basis: run.basisSnapshot,
    retrieval: run.retrievalSnapshot,
    historical: run.historicalSnapshot,
    cases: buildEffectiveCaseSet(run),
  })
  for (const proposal of run.caseChangeProposals.filter(
    item => item.operation === 'create' && item.reason.includes('多个可能的历史交集'),
  )) {
    audit.advisories.push({
      code: 'POSSIBLE_HISTORICAL_OVERLAP',
      message: 'Candidate 可能对应多个 Historical Case；Service 已保留全部历史项并将 Candidate 安全降级为 create。',
      subjectId: proposal.candidateCaseId,
    })
  }
  return audit
}

export function initialAutomaticRepairState(): NonNullable<TestDesignWorkflowRun['automaticRepair']> {
  return { status: 'idle', attempt: 0, maxAttempts: AUTOMATIC_REPAIR_MAX_ATTEMPTS, blockerCodes: [] }
}

export function publishArtifact(
  run: TestDesignWorkflowRun,
  key: TestDesignNodeKey,
  output: { schemaVersion: string; content: unknown },
) {
  const target = node(run, key)
  const artifactValue: WorkflowArtifact = {
    id: `workflow_artifact_${randomUUID()}`,
    nodeKey: key,
    schemaVersion: output.schemaVersion,
    generation: target.generation,
    content: structuredClone(output.content),
    contentSha256: canonicalSha256(output.content),
    createdAt: now(),
  }
  run.artifacts.push(artifactValue)
  target.outputArtifactId = artifactValue.id
}

export function finishNode(
  run: TestDesignWorkflowRun,
  key: TestDesignNodeKey,
  execution?: WorkflowNodeRun['execution'],
) {
  const target = node(run, key)
  Object.assign(target, { status: 'succeeded', finishedAt: now(), ...(execution ? { execution } : {}) })
}

export function failNode(run: TestDesignWorkflowRun, key: TestDesignNodeKey, error: unknown) {
  const target = node(run, key)
  const message = error instanceof Error ? error.message : String(error)
  const execution =
    error && typeof error === 'object' && 'execution' in error
      ? (error as { execution?: WorkflowNodeRun['execution'] }).execution
      : undefined
  Object.assign(target, {
    status: 'failed',
    finishedAt: now(),
    error: message,
    errorCode: errorCode(message),
    ...(execution ? { execution } : {}),
  })
}

export function shouldCheckpointTestDesignExecution(event: AgentExecutionEvent) {
  return [
    'tool_execution_end',
    'turn_end',
    'agent_end',
    'result_submission_required',
    'result_submission_retry',
    'input_package_built',
    'input_batch_delivered',
  ].includes(event.type)
}

export function testDesignExecutionProgress(
  run: TestDesignWorkflowRun,
  stage: 'test_case_design' | 'test_design_repair',
  events: AgentExecutionEvent[],
): WorkflowNodeRun['execution'] {
  const framework = events.find(event => event.framework)?.framework
  return {
    agentKey: 'planning',
    workflowStage: stage,
    agentVersion: run.agentConfigurationSnapshot.agentDefinition.version,
    modelLabel: run.agentConfigurationSnapshot.primaryModel.modelName,
    degraded: false,
    turns: events.reduce((maximum, event) => Math.max(maximum, event.turn ?? 0), 0),
    toolCalls: events.filter(event => event.type === 'tool_execution_start').length,
    toolErrors: events.filter(event => event.type === 'tool_execution_end' && event.isError).length,
    ...(framework ? { framework } : {}),
    events: structuredClone(events),
  }
}

function queueNode(run: TestDesignWorkflowRun, key: TestDesignNodeKey) {
  const target = node(run, key)
  Object.assign(target, { status: 'queued', error: undefined, errorCode: undefined })
}

export function advanceNodeGeneration(
  run: TestDesignWorkflowRun,
  target: WorkflowNodeRun,
  status: WorkflowNodeRun['status'],
) {
  target.generation += 1
  target.attempt = 0
  target.id = `${run.id}:${target.nodeKey}:g${target.generation}:a0`
  target.status = status
  target.outputArtifactId = undefined
  target.startedAt = undefined
  target.finishedAt = undefined
  target.error = undefined
  target.errorCode = undefined
  target.execution = undefined
}

export function node(run: TestDesignWorkflowRun, key: TestDesignNodeKey) {
  return required(
    run.nodeRuns.find(item => item.nodeKey === key),
    'WORKFLOW_NODE_NOT_FOUND',
    `${key} 节点不存在`,
  )
}

export function presentRun(run: TestDesignWorkflowRun, detail = false) {
  const value = structuredClone(run)
  if (value.status === 'succeeded') {
    value.error = undefined
    value.errorCode = undefined
  }
  if (!detail)
    return {
      id: value.id,
      testDesignId: value.testDesignId,
      projectVersionId: value.projectVersionId,
      status: value.status,
      stage: value.stage,
      progress: value.progress,
      createdAt: value.createdAt,
      startedAt: value.startedAt,
      finishedAt: value.finishedAt,
      errorCode: value.errorCode,
      error: value.error,
    }
  return value
}
