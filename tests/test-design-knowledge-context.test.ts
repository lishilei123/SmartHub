import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildPlanningTestDesignTask } from '../server/agent/pi-test-design-runtime.js'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import {
  buildTestDesignRetrievalQueries,
  selectRuntimeKnowledgeReferences,
  TEST_DESIGN_RUNTIME_KNOWLEDGE_REFERENCE_LIMIT,
} from '../server/application/test-design-service.js'
import { validateCreateTestDesignInput, validateTestCaseContent } from '../server/application/test-design-validation.js'
import type { RetrievalSnapshot, TestDesign, TestDesignWorkflowRun, TestDesignWorkspaceSnapshot } from '../server/domain/test-design-types.js'
import type { RequirementReleaseContent } from '../server/domain/requirement-workflow-types.js'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('冻结 Retrieval Hits 经确定性裁剪后直接进入 TestCase Design Runtime 上下文', () => {
  const retrieval = retrievalSnapshot()
  const selected = selectRuntimeKnowledgeReferences(retrieval)
  assert.equal(selected.length, TEST_DESIGN_RUNTIME_KNOWLEDGE_REFERENCE_LIMIT)
  assert.equal(selected[0].classification, 'historical_defect')
  assert.equal(selected.filter(item => item.content === '重复知识正文').length, 1)
  assert.deepEqual(Object.keys(selected[0]).sort(), ['assetVersionId', 'chunkId', 'classification', 'content', 'id', 'locator'])

  const parsed = JSON.parse(buildPlanningTestDesignTask(run(retrieval), design(), 'test_case_design', workspace())) as {
    requirementRelease: { content: Record<string, unknown> }
    design: Record<string, unknown>
    knowledgeReferences: { source: string; maxHits: number; availableHitCount: number; selectedHitCount: number; hits: typeof selected }
    instructions: string[]
  }
  assert.equal(parsed.knowledgeReferences.source, 'retrievalSnapshot.hits')
  assert.equal(parsed.knowledgeReferences.maxHits, TEST_DESIGN_RUNTIME_KNOWLEDGE_REFERENCE_LIMIT)
  assert.equal(parsed.knowledgeReferences.availableHitCount, retrieval.hits.length)
  assert.deepEqual(parsed.knowledgeReferences.hits, selected)
  assert.equal(parsed.requirementRelease.content.testFocus, undefined)
  assert.equal(parsed.design.userCoverageObjectives, undefined)
  assert.match(parsed.instructions.join('\n'), /无需再次调用 knowledge\.search 才能获得既有 Retrieval/u)
})

test('Retrieval Query 直接使用 Requirement、answered Clarification 与 TestDesign 正式输入', () => {
  const content = requirementContent()
  const plan = buildTestDesignRetrievalQueries({
    name: '任务管理测试设计',
    objective: '验证任务状态与查询一致性',
    includedScopes: [{ kind: 'module', value: '任务管理' }],
    excludedScopes: [{ kind: 'module', value: '历史归档' }],
    focusDimensions: ['functional', 'stability'],
    executionMethods: ['ui', 'api'],
    knowledgeAugmentation: { mode: 'disabled' },
  }, content)
  const queries = plan.map(item => item.query).join('\n')
  assert.ok(plan.length <= 20)
  assert.match(queries, /任务状态流转/u)
  assert.match(queries, /todo 只能进入 in_progress/u)
  assert.match(queries, /回退请求必须拒绝/u)
  assert.match(queries, /验证任务状态与查询一致性/u)
  assert.match(queries, /module 任务管理/u)
  assert.match(queries, /functional stability 测试风险/u)
  assert.doesNotMatch(queries, /旧 Test Focus 不得参与检索/u)
  assert.doesNotMatch(queries, /未回答问题不得参与检索/u)
})

test('Test Focus 残留不再构造 TestDesign，TestCase v3 Schema 保持不变', () => {
  assert.throws(() => validateCreateTestDesignInput({
    name: '测试设计',
    objective: '验证正式需求与知识风险',
    userCoverageObjectives: ['旧 Test Focus 映射'],
    knowledgeAugmentation: { mode: 'disabled' },
  }), /userCoverageObjectives/u)
  assert.deepEqual(Object.keys(validateTestCaseContent({
    schemaVersion: 'test-case/v3',
    title: '完整 CRUD 业务闭环',
    dimension: 'functional',
    priority: 'P1',
    requirementRefs: ['RP-STATE'],
    executionMethods: ['ui', 'api'],
    preconditions: ['已登录'],
    steps: ['Create → Read → Update → Read → Delete → Read'],
    expectedResults: ['完整业务闭环符合 Requirement'],
  })).sort(), ['dimension', 'executionMethods', 'expectedResults', 'preconditions', 'priority', 'requirementRefs', 'schemaVersion', 'steps', 'title'])

  const service = read('../server/application/test-design-service.ts')
  const createPanel = read('../src/test-design/TestDesignCreatePanel.tsx')
  const types = read('../server/domain/test-design-types.ts')
  assert.doesNotMatch(service, /result\.testFocus\.map|userCoverageObjectives/u)
  assert.doesNotMatch(createPanel, /userCoverageObjectives|覆盖目标（每行一项）/u)
  assert.doesNotMatch(types, /interface\s+(?:TestPoint|RiskContext)|type\s+(?:TestPoint|RiskContext)/u)
})

test('Skill 保留自然闭环并要求独立风险拆分，Coverage UI 明确为追溯覆盖率', () => {
  const skill = read('../server/skills/test-case-design/SKILL.md')
  const auditPanel = read('../src/test-design/CoverageAuditPanel.tsx')
  const page = read('../src/test-design/TestDesignPage.tsx')
  assert.match(skill, /Create → Read → Update → Read → Delete → Read/u)
  assert.match(skill, /todo → in_progress → completed/u)
  assert.match(skill, /distinct risk hypothesis|fail independently/u)
  assert.match(skill, /Do not split merely to increase Case count/u)
  assert.match(skill, /not formal product facts or mandatory Case-decomposition rules/u)
  assert.match(skill, /“result is non-empty” is insufficient/u)
  assert.doesNotMatch(skill, /minimumCaseCount|at least \d+ Cases|Requirement 数量.*固定倍数/u)
  assert.match(auditPanel, /需求追溯覆盖率/u)
  assert.match(auditPanel, /不表示异常、边界或组合场景已 100% 覆盖/u)
  assert.match(page, /需求追溯覆盖率/u)
  assert.doesNotMatch(`${auditPanel}\n${page}`, /目标 Requirement 覆盖/u)
})

function requirementContent(): RequirementReleaseContent {
  return {
    requirements: [{
      clientRequirementPointId: 'RP-STATE',
      title: '任务状态流转',
      description: '任务从 todo 流转到 in_progress 后才能 completed',
      actor: '项目成员',
      action: '更新状态',
      object: '任务',
      conditions: ['任务属于当前项目'],
      businessRules: ['todo 只能进入 in_progress'],
      exceptions: ['非法状态转换必须拒绝'],
      acceptanceCriteria: ['状态保存后查询一致'],
      evidenceRefs: [],
      coverageTarget: true,
    }],
    evidence: [],
    clarifications: [
      { id: 'CL-ANSWERED', question: '完成态是否允许回退？', reason: '影响预期结果', category: 'business_rule', requirementPointRefs: ['RP-STATE'], blocking: true, status: 'answered', answer: '回退请求必须拒绝', createdAt: '2026-08-22T00:00:00.000Z' },
      { id: 'CL-PENDING', question: '未回答问题不得参与检索', reason: '尚无正式答案', category: 'other', requirementPointRefs: ['RP-STATE'], blocking: false, status: 'pending', createdAt: '2026-08-22T00:00:00.000Z' },
    ],
    testFocus: [{ id: 'TF-LEGACY', title: '旧 Test Focus 不得参与检索', description: '历史兼容字段', requirementPointRefs: ['RP-STATE'] }],
  }
}

function retrievalSnapshot(): RetrievalSnapshot {
  const hits: RetrievalSnapshot['hits'] = Array.from({ length: 20 }, (_, index) => {
    const duplicate = index === 18 || index === 19
    const content = duplicate ? '重复知识正文' : `知识正文 ${index}`
    return {
      id: `hit-${index}`,
      assetVersionId: `asset-version-${index}`,
      chunkId: `chunk-${index}`,
      contentSha256: canonicalSha256(content),
      score: 1 - index / 100,
      rank: index + 1,
      locator: { logicalPath: `workspace/shared/knowledge-${index}.md`, line: index + 1 },
      classification: index === 17 ? 'historical_defect' : index % 2 ? 'normative_reference' : 'context_only',
      content,
    }
  })
  return { canonicalVersion: 'retrieval-snapshot/v1', mode: 'fixed_index', assetVersionIds: [], queryPlan: [], hits, createdAt: '2026-08-22T00:00:00.000Z', snapshotSha256: 'a'.repeat(64) }
}

function run(retrievalSnapshot: RetrievalSnapshot): TestDesignWorkflowRun {
  return {
    id: 'run-knowledge',
    testDesignId: 'design-knowledge',
    projectVersionId: 'project-version-1',
    status: 'running',
    stage: 'test_case_design',
    progress: 20,
    idempotencyKey: 'knowledge-context',
    basisSnapshot: { schemaVersion: 'test-design-basis-snapshot/v3', projectVersionId: 'project-version-1', requirementReleaseId: 'release-1', verificationRunId: 'analysis-run-1', requirementReleaseContentSha256: canonicalSha256(requirementContent()), content: requirementContent(), createdAt: '2026-08-22T00:00:00.000Z', snapshotSha256: 'b'.repeat(64) },
    agentConfigurationSnapshot: { agentDefinition: { enabledSkills: ['test-case-design'] } } as never,
    currentInputRefs: [],
    workspaceSnapshot: workspace(),
    formalWorkspaceFiles: [],
    retrievalSnapshot,
    historicalSnapshot: { schemaVersion: 'historical-case-snapshot/v2', items: [], requirementMappings: [], createdAt: '2026-08-22T00:00:00.000Z', snapshotSha256: 'c'.repeat(64) },
    nodeRuns: [], artifacts: [], gateDecisions: [], testCases: [], caseChangeProposals: [], coverageAudits: [], events: [], createdBy: 'tester', createdAt: '2026-08-22T00:00:00.000Z',
  }
}

function design(): TestDesign {
  return { id: 'design-knowledge', projectVersionId: 'project-version-1', projectId: 'project-1', name: '知识增强测试设计', objective: '验证任务状态与查询一致性', input: { name: '知识增强测试设计', objective: '验证任务状态与查询一致性', includedScopes: [], excludedScopes: [], focusDimensions: ['functional'], executionMethods: ['ui', 'api'], knowledgeAugmentation: { mode: 'fixed_index', indexVersionId: 'index-1' } }, logicalInputSha256: 'd'.repeat(64), createdBy: 'tester', createdAt: '2026-08-22T00:00:00.000Z' }
}

function workspace(): TestDesignWorkspaceSnapshot {
  return { schemaVersion: 'project-workspace-snapshot/v1', projectId: 'project-1', rootLogicalPath: 'workspace', activeBranchLogicalPath: 'workspace/branches/V1', agentLogicalPath: 'workspace/agent_workspace/planning_agent', projectVersionId: 'project-version-1', projectVersionName: 'V1', knowledgeBaseId: 'kb-1', indexVersionId: 'index-1', requirementReleaseId: 'release-1', verificationRunId: 'analysis-run-1', requirementReleaseContentSha256: 'e'.repeat(64), files: [], createdAt: '2026-08-22T00:00:00.000Z', snapshotSha256: 'f'.repeat(64) }
}
