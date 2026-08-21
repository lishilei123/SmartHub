import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import { PlanningWorkflowService, type PlanningReviewerRuntime } from '../server/application/planning-workflow-service.js'
import type { AgentDefinitionVersion, ReviewerExecutionInput } from '../server/domain/agent-types.js'
import type { TestCaseContent, TestDesignWorkflowRun } from '../server/domain/test-design-types.js'
import type { AgentConfigurationVersion } from '../server/domain/types.js'
import { JsonStore } from '../server/infrastructure/store.js'

test('CoverageReviewer 正常执行并读取 Service 自动冻结的完整只读快照', async () => {
  const store = new JsonStore(null)
  await store.load()
  const agentDefinition = planningAgentDefinition()
  const configuration = planningConfiguration(agentDefinition)
  const run = coverageRun(agentDefinition, configuration)
  await store.transaction(state => {
    state.projects.push({ id: 'project-1', name: 'Reviewer 项目', createdAt: '2026-08-21T00:00:00.000Z' })
    state.projectVersions.push({ id: 'project-version-1', projectId: 'project-1', name: 'V1', status: 'open', inheritRequirementBindings: false, createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z' })
    state.modelSources.push({
      id: 'source-1', name: 'Reviewer Model Source', providerType: 'openai_compatible', baseUrl: 'https://models.example/v1', apiKey: 'secret', enabled: true, health: 'healthy', priority: 1, createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z',
      models: [{ id: 'model-1', name: 'reviewer-model', displayName: 'Reviewer Model', contextWindow: 32_768, maxOutputTokens: 4_096, capabilities: ['tool_calling'], enabled: true, health: 'healthy', qualityGate: { version: 'model-probe/v2', checkedAt: '2026-08-21T00:00:00.000Z', passed: true, sampleSha256: '1'.repeat(64), inputCharacters: 8_000, checks: { connectivity: true, longContext: true, structuredSubmission: true, toolCalling: true } } }],
    })
    state.agentConfigurationVersions.push(configuration)
    state.testDesignState = { architectureVersion: 'single-agent-skills/v1', designs: [], runs: [run], caseSetVersions: [], libraryCases: [], libraryVersions: [], suiteDrafts: [], suiteVersions: [], executionHandoffs: [], legacyMigrations: [] }
  })

  let captured: ReviewerExecutionInput | undefined
  const runtime: PlanningReviewerRuntime = {
    contextProfile: () => ({ proactiveThresholdPercent: 78, checkpoints: ['before_test_case_design'] }),
    context: () => undefined,
    appendPlanningTask: async () => ({ parentSessionId: 'parent-session', scopeKey: 'planning:project-1:project-version-1' }),
    review: async input => {
      captured = input
      return {
        runId: input.runId,
        reviewerType: 'coverage',
        candidate: { schemaVersion: 'planning-review-candidate/v1', reviewerType: 'coverage', verdict: 'pass', summary: 'Coverage 快照已完成复核', findings: [], suggestedActions: [] },
        events: [], turns: 1, toolCalls: 4, toolErrors: 0, framework: { name: 'pi-coding-agent', version: 'test' },
        context: { sessionId: 'coverage-review-session', sessionRole: 'reviewer', contextWindow: 32_768, currentTokens: 1_024, usagePercent: 3.125, compactionCount: 0, totalMessages: 2, autoCompactionEnabled: true },
      }
    },
    injectReviewCandidate: async (_snapshot, output) => ({ parentSessionId: 'parent-session', subAgentRunId: output.runId, reviewerType: output.reviewerType }),
  }
  const unavailable = async () => { throw new Error('本测试不应调用该依赖') }
  const service = new PlanningWorkflowService(
    store,
    { resolveActive: unavailable },
    runtime,
    { list: unavailable, finalizeRequirementRelease: unavailable },
    { listDesigns: unavailable, createAutomaticDesignAndRun: unavailable },
  )

  const result = await service.reviewCoverage(run.id)
  assert.equal(result.reviewerType, 'coverage')
  assert.equal(captured?.reviewerType, 'coverage')
  assert.deepEqual(captured?.requiredReadPaths.map(path => path.split('/').at(-1)), ['test-cases.json', 'test-data-requirements.json', 'coverage-audit.json'])
  assert.match(captured?.task ?? '', /Requirement Release Content/u)
  assert.match(captured?.task ?? '', /REQ-1/u)
  const files = captured?.snapshot.workspaceFiles ?? []
  assert.ok(files.some(file => file.logicalPath.endsWith('/test-cases.json') && file.content.includes('case-current')))
  assert.ok(files.some(file => file.logicalPath.endsWith('/test-data-requirements.json') && file.content.includes('data-current')))
  assert.ok(files.some(file => file.logicalPath.endsWith('/coverage-audit.json') && file.content.includes('audit-current')))
  const persisted = (await store.snapshot()).testDesignState?.runs[0].planningSubAgentRuns?.at(-1)
  assert.equal(persisted?.status, 'succeeded')
  assert.equal(persisted?.reviewerType, 'coverage')
  assert.equal(persisted?.sourceReference.kind, 'test_design')
})

function planningAgentDefinition(): AgentDefinitionVersion {
  return {
    agentKey: 'planning', agentType: 'planning', version: '1.0.0', status: 'published', modelScene: 'planning', resultSchemaVersion: 'planning/v1',
    systemPrompt: 'PlanningAgent', taskTemplate: '{{task}}', promptRef: { promptKey: 'planning', version: '1.0.0', contentSha256: '2'.repeat(64) },
    toolsetVersion: '1.0.0', toolsetContentSha256: '3'.repeat(64), skillBindings: [], enabledSkills: [], mcpBindings: [], toolIds: ['workspace.read_file'],
    limits: { maxTurns: 8, maxToolCalls: 20, deadlineMs: 60_000, toolTimeoutMs: 10_000, maxCandidateBytes: 128_000, maxFindings: 100, maxRepeatedToolCall: 3 },
    contentSha256: '4'.repeat(64),
  }
}

function planningConfiguration(agentDefinition: AgentDefinitionVersion): AgentConfigurationVersion {
  return {
    id: 'configuration-1', scene: 'planning', agentKey: 'planning', version: 1, status: 'active',
    routing: { primaryModel: { sourceId: 'source-1', modelId: 'model-1' }, fallbackModels: [], intelligentRouting: false, fallbackEnabled: false, contextWindow: 32_768, maxOutputTokens: 4_096, requestTimeoutSeconds: 30, retryCount: 0 },
    agentDefinition, contentSha256: '5'.repeat(64), createdAt: '2026-08-21T00:00:00.000Z', publishedBy: 'test',
  }
}

function coverageRun(agentDefinition: AgentDefinitionVersion, configuration: AgentConfigurationVersion): TestDesignWorkflowRun {
  const caseContent: TestCaseContent = { schemaVersion: 'test-case/v2', title: '当前用例', objective: '验证当前 Coverage', dimension: 'functional', requirementRefs: ['REQ-1'], priority: 'P0', preconditions: [], dataRequirementIds: [], cleanup: [], dependencies: [], executionMethods: [], sharedVerificationChecks: [], tags: [], domain: 'Reviewer' }
  const caseSha256 = canonicalSha256(caseContent)
  const testCases = [{ id: 'case-current', runId: 'test-design-run-1', origin: 'ai' as const, candidateRef: 'TC-1', currentRevision: 1, reviewState: 'in_review' as const, revisions: [{ revision: 1, content: caseContent, contentSha256: caseSha256, semanticSha256: caseSha256, diff: [], editorId: 'agent', reason: '生成', createdAt: '2026-08-21T01:00:00.000Z' }], reviewActions: [] }]
  const caseSetSha256 = canonicalSha256([{ caseId: 'case-current', revision: 1, contentSha256: caseSha256 }])
  const requirementContent = { requirements: [{ clientRequirementPointId: 'REQ-1', title: '固定需求', description: '用于 Coverage Reviewer', actor: '用户', action: '操作', object: '对象', conditions: [], businessRules: [], exceptions: [], acceptanceCriteria: [], evidenceRefs: [], coverageTarget: true }], evidence: [], clarifications: [], testFocus: [] }
  return {
    id: 'test-design-run-1', testDesignId: 'design-1', projectVersionId: 'project-version-1', status: 'succeeded', stage: 'completed', progress: 100, idempotencyKey: 'reviewer-test',
    basisSnapshot: { schemaVersion: 'test-design-basis-snapshot/v3', projectVersionId: 'project-version-1', requirementReleaseId: 'release-1', verificationRunId: 'requirement-run-1', requirementReleaseContentSha256: canonicalSha256(requirementContent), content: requirementContent, createdAt: '2026-08-21T00:00:00.000Z', snapshotSha256: '7'.repeat(64) },
    agentConfigurationSnapshot: { configurationId: configuration.id, configurationVersion: configuration.version, configurationSha256: configuration.contentSha256, agentDefinition, routing: configuration.routing, primaryModel: { sourceId: 'source-1', providerType: 'openai_compatible', modelId: 'model-1', modelName: 'reviewer-model', contextWindow: 32_768, maxOutputTokens: 4_096, supportsReasoning: false }, createdAt: configuration.createdAt, snapshotSha256: '8'.repeat(64) },
    currentInputRefs: [],
    workspaceSnapshot: { schemaVersion: 'project-workspace-snapshot/v1', projectId: 'project-1', projectVersionId: 'project-version-1', projectVersionName: 'V1', rootLogicalPath: 'workspace', activeBranchLogicalPath: 'workspace/branches/V1', agentLogicalPath: 'workspace/agent_workspace/planning_agent', knowledgeBaseId: 'kb-1', indexVersionId: 'index-1', requirementReleaseId: 'release-1', verificationRunId: 'requirement-run-1', requirementReleaseContentSha256: canonicalSha256(requirementContent), files: [], createdAt: '2026-08-21T00:00:00.000Z', snapshotSha256: '9'.repeat(64) },
    formalWorkspaceFiles: [], retrievalSnapshot: { canonicalVersion: 'retrieval-snapshot/v1', mode: 'disabled', assetVersionIds: [], queryPlan: [], hits: [], createdAt: '2026-08-21T00:00:00.000Z', snapshotSha256: 'a'.repeat(64) }, historicalSnapshot: { schemaVersion: 'historical-case-snapshot/v1', items: [], createdAt: '2026-08-21T00:00:00.000Z', snapshotSha256: 'b'.repeat(64) },
    nodeRuns: [], artifacts: [], gateDecisions: [], testCases, scenarioClaims: [], dimensionAssessments: [], caseChangeProposals: [],
    dataSetVersions: [{ id: 'data-current', version: 1, requirements: [], contentSha256: 'c'.repeat(64), createdBy: 'agent', createdAt: '2026-08-21T01:00:00.000Z' }],
    coverageAudits: [{ id: 'audit-current', runId: 'test-design-run-1', requirementReleaseId: 'release-1', dataSetVersionId: 'data-current', caseSetSha256, inputSha256: 'd'.repeat(64), status: 'valid', statistics: { totalBasis: 1, coveredBasis: 1, totalCases: 1 }, relations: [], blockers: [], advisories: [], createdAt: '2026-08-21T02:00:00.000Z' }],
    smokeCandidates: [], impactedRegression: [], findings: [], confirmationItems: [], events: [], createdBy: 'test', createdAt: '2026-08-21T00:00:00.000Z', finishedAt: '2026-08-21T02:00:00.000Z',
  }
}
