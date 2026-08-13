import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import type { ReviewRun } from '../server/domain/types.js'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import { TestDesignService } from '../server/application/test-design-service.js'
import type { TestCaseContent, TestDesign, TestDesignWorkflowRun } from '../server/domain/test-design-types.js'
import { runMigrations } from '../server/infrastructure/migrations.js'
import { PostgresStore } from '../server/infrastructure/postgres-store.js'
import type { ReviewJob, TaskLease, TestDesignJob } from '../server/infrastructure/store.js'

const connectionString = process.env.TEST_DATABASE_URL
if (!connectionString) throw new Error('test:postgres 需要配置指向隔离数据库的 TEST_DATABASE_URL')
if (!/test/iu.test(new URL(connectionString).pathname)) {
  throw new Error('TEST_DATABASE_URL 必须指向名称包含 test 的隔离数据库')
}

await runMigrations(connectionString)

const database = new Pool({ connectionString })
const store = new PostgresStore(connectionString)
const prefix = `review-job-postgres-${randomUUID()}`
const now = new Date().toISOString()
const ids = {
  project: `${prefix}-project`,
  projectVersion: `${prefix}-project-version`,
  knowledgeBase: `${prefix}-knowledge-base`,
  config: `${prefix}-config`,
  asset: `${prefix}-asset`,
  assetVersion: `${prefix}-asset-version`,
}

await store.load()
await seedParents()

test.after(async () => {
  await database.query('DELETE FROM smarthub.legacy_test_case_id_mappings mapping USING smarthub.legacy_test_case_migrations migration WHERE mapping.migration_id=migration.id AND migration.project_id=$1', [ids.project])
  await database.query('DELETE FROM smarthub.legacy_test_case_migrations WHERE project_id=$1', [ids.project])
  await store.transaction(state => { if (!state.testDesignState) return; state.testDesignState.executionHandoffs = state.testDesignState.executionHandoffs.filter(item => !item.id.startsWith(prefix)); state.testDesignState.suiteVersions = state.testDesignState.suiteVersions.filter(item => !item.id.startsWith(prefix)); state.testDesignState.suiteDrafts = state.testDesignState.suiteDrafts.filter(item => !item.id.startsWith(prefix)); state.testDesignState.libraryVersions = state.testDesignState.libraryVersions.filter(item => !item.id.startsWith(prefix)); state.testDesignState.libraryCases = state.testDesignState.libraryCases.filter(item => !item.id.startsWith(prefix)); state.testDesignState.legacyMigrations = state.testDesignState.legacyMigrations.filter(item => !item.id.startsWith(prefix)) })
  await database.query('DELETE FROM smarthub.test_suite_drafts WHERE project_id=$1', [ids.project])
  await database.query('UPDATE smarthub.workflow_runs SET base_test_case_library_version_id=NULL, base_test_case_library_version_sha256=NULL WHERE id LIKE $1', [`${prefix}%`])
  await database.query('DELETE FROM smarthub.test_case_library_version_members member USING smarthub.test_case_library_versions version WHERE member.version_id=version.id AND version.project_id=$1', [ids.project])
  await database.query('DELETE FROM smarthub.test_case_library_versions WHERE project_id=$1', [ids.project])
  await database.query('DELETE FROM smarthub.library_test_case_revision_requirement_refs reference USING smarthub.library_test_cases test_case WHERE reference.case_id=test_case.id AND test_case.project_id=$1', [ids.project])
  await database.query('DELETE FROM smarthub.library_test_case_revision_test_point_refs reference USING smarthub.library_test_cases test_case WHERE reference.case_id=test_case.id AND test_case.project_id=$1', [ids.project])
  await database.query('DELETE FROM smarthub.library_test_case_revisions revision USING smarthub.library_test_cases test_case WHERE revision.case_id=test_case.id AND test_case.project_id=$1', [ids.project])
  await database.query('DELETE FROM smarthub.library_test_cases WHERE project_id=$1', [ids.project])
  await store.transaction(state => { if (!state.testDesignState) return; state.testDesignState.caseSetVersions = state.testDesignState.caseSetVersions.filter(item => !item.id.startsWith(prefix)); state.testDesignState.runs = state.testDesignState.runs.filter(item => !item.id.startsWith(prefix)); state.testDesignState.designs = state.testDesignState.designs.filter(item => !item.id.startsWith(prefix)) })
  await database.query('DELETE FROM smarthub.case_change_proposal_decisions decision USING smarthub.case_change_proposals proposal WHERE decision.proposal_id=proposal.id AND proposal.workflow_run_id LIKE $1', [`${prefix}%`])
  await database.query('DELETE FROM smarthub.case_change_proposals WHERE workflow_run_id LIKE $1', [`${prefix}%`])
  await database.query('DELETE FROM smarthub.workflow_task_jobs WHERE id LIKE $1', [`${prefix}%`])
  await database.query('DELETE FROM smarthub.review_jobs WHERE id LIKE $1', [`${prefix}%`])
  await database.query('DELETE FROM smarthub.review_runs WHERE id LIKE $1', [`${prefix}%`])
  await database.query('DELETE FROM smarthub.asset_versions WHERE id=$1', [ids.assetVersion])
  await database.query('DELETE FROM smarthub.knowledge_assets WHERE id=$1', [ids.asset])
  await database.query('DELETE FROM smarthub.config_versions WHERE id=$1', [ids.config])
  await database.query('DELETE FROM smarthub.knowledge_bases WHERE id=$1', [ids.knowledgeBase])
  await database.query('DELETE FROM smarthub.project_versions WHERE id=$1', [ids.projectVersion])
  await database.query('DELETE FROM smarthub.projects WHERE id=$1', [ids.project])
  await store.close?.()
  await database.end()
})

test('PostgreSQL Review Job 在重试时清理租约并拒绝旧 fencing token', async () => {
  const run = await createRun('retry-and-fencing')
  await enqueue(run, 3)

  const first = required(await store.claimReviewJob?.('worker-a', 60_000), '应领取首次任务')
  const firstLease: TaskLease = { workerId: 'worker-a', runToken: required(first.runToken, '首次任务缺少 fencing token') }
  assert.equal(first.attempts, 1)

  const written = await store.transactionWithReviewLease?.(run.id, firstLease, state => {
    const current = required(state.reviewRuns.find(item => item.id === run.id), '运行不存在')
    current.step = 'attempt-one'
    current.progress = 10
    return true
  })
  assert.equal(written, true)

  assert.equal(await store.releaseReviewJob?.(run.id, firstLease, 1_000, '首次失败'), true)
  const released = await reviewJob(run.id)
  assert.equal(released.status, 'queued')
  assert.equal(released.attempt_count, 1)
  assert.equal(released.lease_owner, null)
  assert.equal(released.run_token, null)
  assert.equal(released.error, '首次失败')
  assert.equal(Date.parse(released.available_at) > Date.now() + 800, true)

  assert.equal(await store.heartbeatReviewJob?.(run.id, firstLease, 60_000), false)
  assert.equal(await store.releaseReviewJob?.(run.id, firstLease, 0, '旧 token'), false)
  assert.equal(await store.finishReviewJob?.(run.id, firstLease, 'failed', '旧 token'), false)
  assert.equal(await store.transactionWithReviewLease?.(run.id, firstLease, () => true), null)

  await database.query("UPDATE smarthub.review_jobs SET available_at=now() WHERE run_id=$1", [run.id])
  const second = required(await store.claimReviewJob?.('worker-b', 60_000), '应领取第二次任务')
  const secondLease: TaskLease = { workerId: 'worker-b', runToken: required(second.runToken, '第二次任务缺少 fencing token') }
  assert.equal(second.attempts, 2)
  assert.notEqual(secondLease.runToken, firstLease.runToken)
  assert.equal(await store.releaseReviewJob?.(run.id, secondLease, 0, '第二次失败'), true)

  const third = required(await store.claimReviewJob?.('worker-c', 60_000), '应领取第三次任务')
  const thirdLease: TaskLease = { workerId: 'worker-c', runToken: required(third.runToken, '第三次任务缺少 fencing token') }
  assert.equal(third.attempts, 3)
  assert.equal(await store.releaseReviewJob?.(run.id, thirdLease, 0, '不应超过最大次数'), false)
  assert.equal(await store.finishReviewJob?.(run.id, thirdLease, 'failed', '第三次失败'), true)

  const exhausted = await reviewJob(run.id)
  assert.equal(exhausted.status, 'failed')
  assert.equal(exhausted.attempt_count, 3)
  assert.equal(await store.claimReviewJob?.('worker-d', 60_000), null)
})

test('PostgreSQL Review Job 仅靠领取操作恢复失效租约并保持 Run 为运行态', async () => {
  const run = await createRun('expired-lease-retry')
  await enqueue(run, 3)
  const first = required(await store.claimReviewJob?.('worker-a', 60_000), '应领取首次任务')
  assert.equal(first.attempts, 1)

  await database.query("UPDATE smarthub.review_jobs SET lease_expires_at=now()-interval '1 second' WHERE run_id=$1", [run.id])
  const recovered = required(await store.claimReviewJob?.('worker-b', 60_000), '失效租约任务应被重新领取')
  assert.equal(recovered.attempts, 2)

  const storedRun = await reviewRun(run.id)
  assert.equal(storedRun.status, 'running')
  assert.equal(storedRun.data.status, 'running')
  assert.equal(storedRun.data.step, 'waiting_worker')
})

test('PostgreSQL Review Job 的取消标记阻止重试并在失租约后收敛为取消', async () => {
  const run = await createRun('cancelled-lease')
  await enqueue(run, 3)
  const claimed = required(await store.claimReviewJob?.('worker-a', 60_000), '应领取待取消任务')
  const lease: TaskLease = { workerId: 'worker-a', runToken: required(claimed.runToken, '任务缺少 fencing token') }

  assert.equal(await store.cancelReviewJob?.(run.id), true)
  assert.equal(await store.releaseReviewJob?.(run.id, lease, 0, '不应重试'), false)
  assert.equal(await store.transactionWithReviewLease?.(run.id, lease, () => true), null)
  await database.query("UPDATE smarthub.review_jobs SET lease_expires_at=now()-interval '1 second' WHERE run_id=$1", [run.id])
  assert.equal(await store.claimReviewJob?.('worker-b', 60_000), null)

  const cancelled = await reviewJob(run.id)
  assert.equal(cancelled.status, 'cancelled')
  const storedRun = await reviewRun(run.id)
  assert.equal(storedRun.status, 'cancelled')
  assert.equal(storedRun.data.status, 'cancelled')
})

test('PostgreSQL Phase 4 使用规范化事实表并以 nodeRunId 隔离 fencing token', async () => {
  const designId = `${prefix}-test-design`
  const runId = `${prefix}-test-design-run`
  const nodeRunId = `${prefix}-test-point-design-node`
  const design: TestDesign = {
    id: designId, projectVersionId: ids.projectVersion, projectId: ids.project, name: 'PostgreSQL Phase 4', objective: '验证规范化持久化与节点租约',
    input: { name: 'PostgreSQL Phase 4', objective: '验证规范化持久化与节点租约', knowledgeAugmentation: { mode: 'disabled' } },
    logicalInputSha256: '1'.repeat(64), createdBy: 'integration-test', createdAt: now,
  }
  const run: TestDesignWorkflowRun = {
    id: runId, testDesignId: designId, projectVersionId: ids.projectVersion, status: 'queued', stage: 'test_point_design', progress: 0, idempotencyKey: `${prefix}-phase4`,
    basisSnapshot: { schemaVersion: 'test-design-basis-snapshot/v2', projectVersionId: ids.projectVersion, requirementReleaseId: `${prefix}-release`, verificationRunId: `${prefix}-verification`, requirementsJsonSha256: '2'.repeat(64), items: [{ id: `${prefix}-basis-item`, kind: 'requirement_release', sourceId: `${prefix}-release:RP-1`, contentSha256: '3'.repeat(64), content: { title: '固定需求', description: '固定内容' }, locator: { coverageTarget: true } }], snapshotSha256: '4'.repeat(64), createdAt: now },
    agentConfigurationSnapshot: {} as TestDesignWorkflowRun['agentConfigurationSnapshot'], workspaceSnapshot: {} as TestDesignWorkflowRun['workspaceSnapshot'], formalWorkspaceFiles: [],
    retrievalSnapshot: { canonicalVersion: 'retrieval-snapshot/v1', mode: 'disabled', assetVersionIds: [], queryPlan: [], hits: [], snapshotSha256: '5'.repeat(64), createdAt: now },
    historicalSnapshot: { schemaVersion: 'historical-case-snapshot/v1', items: [], snapshotSha256: '6'.repeat(64), createdAt: now },
    nodeRuns: [{ id: nodeRunId, nodeKey: 'test_point_design', generation: 1, attempt: 0, status: 'queued', dependencies: [] }], artifacts: [], gateDecisions: [], testCases: [], dataSetVersions: [], coverageAudits: [], smokeCandidates: [], impactedRegression: [], findings: [], confirmationItems: [], events: [], createdBy: 'integration-test', createdAt: now,
  }
  await store.transaction(state => { const aggregate = state.testDesignState ??= { architectureVersion: 'single-agent-skills/v1', designs: [], runs: [], caseSetVersions: [], suiteVersions: [], executionHandoffs: [] }; aggregate.designs.push(design); aggregate.runs.push(run) })
  const normalized = await database.query<{ designs: string; runs: string; snapshots: string; items: string }>('SELECT (SELECT count(*) FROM smarthub.test_designs WHERE id=$1)::text AS designs, (SELECT count(*) FROM smarthub.workflow_runs WHERE id=$2)::text AS runs, (SELECT count(*) FROM smarthub.test_design_basis_snapshots WHERE workflow_run_id=$2)::text AS snapshots, (SELECT count(*) FROM smarthub.test_design_snapshot_items WHERE workflow_run_id=$2)::text AS items', [designId, runId])
  assert.deepEqual(normalized.rows[0], { designs: '1', runs: '1', snapshots: '1', items: '1' })

  const job: TestDesignJob = { id: `${prefix}-phase4-job`, runId, nodeRunId, status: 'queued', attempts: 0, maxAttempts: 3, availableAt: now, createdAt: now, updatedAt: now }
  await store.enqueueTestDesignJob?.(job)
  const first = required(await store.claimTestDesignJob?.('phase4-worker-a', 60_000), '应领取 Phase 4 节点任务')
  const firstLease: TaskLease = { workerId: 'phase4-worker-a', runToken: required(first.runToken, 'Phase 4 节点缺少 fencing token') }
  assert.equal(await store.transactionWithTestDesignLease?.(nodeRunId, firstLease, state => { const current = required(state.testDesignState?.runs.find(item => item.id === runId), 'Phase 4 Run 不存在'); current.progress = 33; return true }), true)
  await database.query("UPDATE smarthub.workflow_task_jobs SET lease_expires_at=now()-interval '1 second' WHERE node_run_id=$1", [nodeRunId])
  const second = required(await store.claimTestDesignJob?.('phase4-worker-b', 60_000), '失效的 Phase 4 节点任务应重新领取')
  assert.notEqual(second.runToken, firstLease.runToken)
  assert.equal(await store.transactionWithTestDesignLease?.(nodeRunId, firstLease, state => { const current = required(state.testDesignState?.runs.find(item => item.id === runId), 'Phase 4 Run 不存在'); current.progress = 99; return true }), null)
  assert.equal((await store.snapshot()).testDesignState?.runs.find(item => item.id === runId)?.progress, 33)
  const secondLease: TaskLease = { workerId: 'phase4-worker-b', runToken: required(second.runToken, '第二次 Phase 4 节点缺少 fencing token') }
  assert.equal(await store.finishTestDesignJob?.(nodeRunId, secondLease, 'succeeded'), true)
  await store.transaction(state => { if (!state.testDesignState) return; state.testDesignState.runs = state.testDesignState.runs.filter(item => item.id !== runId); state.testDesignState.designs = state.testDesignState.designs.filter(item => item.id !== designId) })
})

test('PostgreSQL Migration 26 完整恢复追溯、冻结 Revision、readiness override 和幂等迁移', async () => {
  const designId = `${prefix}-formal-design`
  const runId = `${prefix}-formal-run`
  const legacySetId = `${prefix}-legacy-set`
  const libraryCaseId = `${prefix}-library-case`
  const libraryVersionId = `${prefix}-library-version`
  const draftId = `${prefix}-suite-draft`
  const suiteVersionId = `${prefix}-suite-version`
  const handoffId = `${prefix}-handoff`
  const migrationId = `${prefix}-migration`
  const proposalId = `${prefix}-proposal`
  const previewSha256 = '9'.repeat(64)
  const traceability = { sourceRequirementReleaseId: `${prefix}-release`, requirementRefs: [{ requirementReleaseId: `${prefix}-release`, requirementId: 'REQ-1' }], testPointRefs: [{ testPointTreeVersionId: `${prefix}-tree-version`, testPointId: `${prefix}-point` }] }
  const content: TestCaseContent = { schemaVersion: 'test-case/v2', title: 'PostgreSQL 正式用例', objective: '验证持久化恢复', dimension: 'functional', testPointIds: [`${prefix}-point`], priority: 'P0', preconditions: [], dataRequirementIds: [`${prefix}-data`], cleanup: [], dependencies: [], executionMethods: [{ method: 'ui', uiSpec: { entry: '/orders', viewport: '1440x900', selectors: ['data-testid=orders'] }, steps: [{ key: 'step-1', action: '打开订单页', expected: '订单页可用' }], verificationChecks: [{ key: 'check-1', description: '订单列表可见' }], executionReadiness: 'ready', automationHint: 'UI 自动化' }], executionSpec: { kind: 'functional', method: 'ui', uiSpec: { entry: '/orders', viewport: '1440x900', selectors: ['data-testid=orders'] }, preconditions: [], steps: [{ key: 'step-1', action: '打开订单页', expected: '订单页可用' }], verificationChecks: [{ key: 'check-1', description: '订单列表可见' }], testDataRequirements: [`${prefix}-data`], executionReadiness: 'ready', automationHint: 'UI 自动化' }, sharedVerificationChecks: [], tags: ['postgres'], domain: '订单' }
  const design: TestDesign = { id: designId, projectVersionId: ids.projectVersion, projectId: ids.project, name: 'PostgreSQL 正式资产', objective: '验证 Migration 26', input: { name: 'PostgreSQL 正式资产', objective: '验证 Migration 26', knowledgeAugmentation: { mode: 'disabled' } }, logicalInputSha256: '1'.repeat(64), createdBy: 'integration-test', createdAt: now }
  const run: TestDesignWorkflowRun = {
    id: runId, testDesignId: designId, projectVersionId: ids.projectVersion, status: 'succeeded', stage: 'completed', progress: 100, idempotencyKey: `${prefix}-formal`,
    basisSnapshot: { schemaVersion: 'test-design-basis-snapshot/v2', projectVersionId: ids.projectVersion, requirementReleaseId: traceability.sourceRequirementReleaseId, verificationRunId: `${prefix}-verification`, requirementsJsonSha256: '2'.repeat(64), items: [], snapshotSha256: '3'.repeat(64), createdAt: now },
    agentConfigurationSnapshot: {} as TestDesignWorkflowRun['agentConfigurationSnapshot'], workspaceSnapshot: {} as TestDesignWorkflowRun['workspaceSnapshot'], formalWorkspaceFiles: [], retrievalSnapshot: { canonicalVersion: 'retrieval-snapshot/v1', mode: 'disabled', assetVersionIds: [], queryPlan: [], hits: [], snapshotSha256: '4'.repeat(64), createdAt: now }, historicalSnapshot: { schemaVersion: 'historical-case-snapshot/v1', items: [], snapshotSha256: '5'.repeat(64), createdAt: now },
    nodeRuns: [], artifacts: [], gateDecisions: [], testCases: [], caseChangeProposals: [{ id: proposalId, runId, operation: 'create', candidateContent: content, diff: [], requirementRefs: ['REQ-1'], testPointIds: [`${prefix}-point`], reason: '新增正式用例', confidence: 1, decision: 'accepted', createdAt: now, decidedBy: 'integration-test', decidedAt: now, decisions: [{ id: `${proposalId}-decision`, expectedVersion: 0, fromDecision: 'pending', decision: 'accepted', decidedBy: 'integration-test', decidedAt: now }] }], dataSetVersions: [], coverageAudits: [], smokeCandidates: [], impactedRegression: [], findings: [], confirmationItems: [], events: [], createdBy: 'integration-test', createdAt: now, finishedAt: now,
  }
  const legacySet = { id: legacySetId, projectId: ids.project, projectVersionId: ids.projectVersion, testDesignId: designId, runId, version: 1, schemaVersion: 'test-case-set/v1' as const, name: '历史用例集', treeVersionId: `${prefix}-tree-version`, dataSetVersionId: `${prefix}-data-version`, coverageAuditId: `${prefix}-audit`, members: [], canonicalContent: { schemaVersion: 'test-case-set/v1', cases: [{ caseId: libraryCaseId, revision: 1, content }] }, contentSha256: '6'.repeat(64), publishedBy: 'integration-test', publishedAt: now, projection: { status: 'succeeded' as const, files: [] } }
  await store.transaction(state => { const aggregate = state.testDesignState ??= { architectureVersion: 'single-agent-skills/v1', designs: [], runs: [], caseSetVersions: [], libraryCases: [], libraryVersions: [], suiteDrafts: [], suiteVersions: [], executionHandoffs: [], legacyMigrations: [] }; aggregate.designs.push(design); aggregate.runs.push(run); aggregate.caseSetVersions.push(legacySet) })

  const revision = { revision: 1, content, contentSha256: canonicalSha256(content), semanticSha256: 'b'.repeat(64), traceability, sourceRunId: runId, sourceProposalId: proposalId, changeReason: 'Proposal 合入', createdBy: 'integration-test', createdAt: now }
  const currentContent = { ...content, title: 'PostgreSQL 当前 Revision 标题', priority: 'P1' as const }
  const currentRevision = { revision: 2, content: currentContent, contentSha256: canonicalSha256(currentContent), semanticSha256: canonicalSha256(currentContent), traceability, changeReason: '人工维护当前 Revision', createdBy: 'integration-test', createdAt: now }
  const member = { testCaseLibraryVersionId: libraryVersionId, caseId: libraryCaseId, revision: 1, ordinal: 0, executionMethods: ['ui' as const], executionMethod: 'ui' as const, reason: '核心链路' }
  await store.transaction(state => {
    const aggregate = state.testDesignState!
    aggregate.libraryCases.push({ id: libraryCaseId, projectId: ids.project, currentRevision: 2, status: 'active', createdAt: now, updatedAt: now, revisions: [revision, currentRevision] })
    aggregate.libraryVersions.push({ id: libraryVersionId, projectId: ids.project, version: 1, name: '正式用例库 V1', sourceRunId: runId, legacyTestCaseSetVersionId: legacySetId, members: [{ caseId: libraryCaseId, revision: 1, ordinal: 0, contentSha256: revision.contentSha256, frozenContent: content, traceability, executionReadiness: 'ready' }], contentSha256: 'c'.repeat(64), publishedBy: 'integration-test', publishedAt: now, projection: { status: 'succeeded', files: [] } })
    aggregate.suiteDrafts.push({ id: draftId, projectId: ids.project, suiteKey: 'postgres-smoke', suiteType: 'smoke', name: 'PostgreSQL Smoke', testCaseLibraryVersionId: libraryVersionId, compatibilityStatus: 'compatible', members: [member], contentSha256: 'd'.repeat(64), status: 'published', publishedVersionId: suiteVersionId, createdBy: 'integration-test', createdAt: now, updatedBy: 'integration-test', updatedAt: now })
    aggregate.suiteVersions.push({ id: suiteVersionId, projectId: ids.project, suiteKey: 'postgres-smoke', suiteType: 'smoke', version: 1, name: 'PostgreSQL Smoke', testCaseLibraryVersionId: libraryVersionId, compatibilityStatus: 'compatible', members: [member], contentSha256: 'e'.repeat(64), publishedBy: 'integration-test', publishedAt: now, status: 'active' })
    aggregate.executionHandoffs.push({ id: handoffId, projectId: ids.project, projectVersionId: ids.projectVersion, testCaseLibraryVersionId: libraryVersionId, suiteVersionId, mode: 'smoke', members: [{ stage: 'smoke', ordinal: 0, sourceVersionId: suiteVersionId, caseId: libraryCaseId, revision: 1, method: 'ui', reason: '核心链路', dedupKey: `${libraryCaseId}:1:ui`, dimension: 'functional', executionSpec: content.executionSpec!, traceability, selectionReason: '核心链路', contentSha256: revision.contentSha256, readinessOverride: { reason: '人工确认历史执行配置', actorId: 'integration-test', createdAt: now } }], contentSha256: 'f'.repeat(64), createdBy: 'integration-test', createdAt: now })
    aggregate.legacyMigrations.push({ id: migrationId, projectId: ids.project, legacyTestCaseSetVersionId: legacySetId, previewSha256, status: 'migrated', mappings: [{ legacyCaseId: libraryCaseId, legacyRevision: 1, libraryCaseId, libraryRevision: 1, resolution: 'created' }], testCaseLibraryVersionId: libraryVersionId, migratedBy: 'integration-test', migratedAt: now })
  })
  await store.transaction(state => { const persistedRun = state.testDesignState!.runs.find(item => item.id === runId)!; persistedRun.baseTestCaseLibraryVersionId = libraryVersionId; persistedRun.baseTestCaseLibraryVersionSha256 = 'c'.repeat(64); persistedRun.historicalSnapshot.baseTestCaseLibraryVersionId = libraryVersionId; persistedRun.historicalSnapshot.baseTestCaseLibraryVersionSha256 = 'c'.repeat(64) })

  const restarted = new PostgresStore(connectionString); await restarted.load()
  try {
    const snapshot = await restarted.snapshot(); const aggregate = snapshot.testDesignState!
    const restoredCase = aggregate.libraryCases.find(item => item.id === libraryCaseId)!
    assert.deepEqual(restoredCase.revisions[0].traceability, traceability)
    assert.equal(aggregate.runs.find(item => item.id === runId)!.caseChangeProposals[0].decisions.length, 1)
    assert.equal(aggregate.libraryVersions.find(item => item.id === libraryVersionId)!.members[0].revision, 1)
    const frozenVersion = await new TestDesignService(restarted).getLibraryVersion(ids.project, libraryVersionId)
    assert.equal(frozenVersion.members[0].frozenContent?.title, content.title)
    assert.notEqual(frozenVersion.members[0].frozenContent?.title, restoredCase.revisions.find(item => item.revision === restoredCase.currentRevision)!.content.title)
    assert.equal(aggregate.suiteDrafts.find(item => item.id === draftId)!.testCaseLibraryVersionId, libraryVersionId)
    assert.equal(aggregate.suiteVersions.find(item => item.id === suiteVersionId)!.members[0].caseId, libraryCaseId)
    const restoredHandoffMember = aggregate.executionHandoffs.find(item => item.id === handoffId)!.members[0]
    assert.equal(restoredHandoffMember.dimension, 'functional'); assert.deepEqual(restoredHandoffMember.executionSpec, content.executionSpec); assert.deepEqual(restoredHandoffMember.traceability, traceability); assert.equal(restoredHandoffMember.contentSha256, revision.contentSha256); assert.equal(restoredHandoffMember.readinessOverride?.reason, '人工确认历史执行配置')
    const idempotent = await new TestDesignService(restarted).migrateLegacyCaseSet(ids.project, { legacyTestCaseSetVersionId: legacySetId, expectedPreviewSha256: previewSha256 }, { subjectId: 'integration-test', displayName: '集成测试' })
    assert.equal(idempotent.version.id, libraryVersionId); assert.equal(idempotent.record.id, migrationId)
  } finally { await restarted.close?.() }

  const normalized = await database.query<{ migration: string; requirements: string; points: string; handoffs: string; frozen: string; baseline: string }>(`SELECT
    (SELECT count(*) FROM smarthub.schema_migrations WHERE version=26)::text AS migration,
    (SELECT count(*) FROM smarthub.library_test_case_revision_requirement_refs WHERE case_id=$1)::text AS requirements,
    (SELECT count(*) FROM smarthub.library_test_case_revision_test_point_refs WHERE case_id=$1)::text AS points,
    (SELECT count(*) FROM smarthub.test_execution_handoff_members WHERE handoff_id=$2 AND dimension='functional' AND execution_spec IS NOT NULL AND traceability IS NOT NULL AND content_sha256 IS NOT NULL AND readiness_override IS NOT NULL)::text AS handoffs,
    (SELECT count(*) FROM smarthub.test_case_library_version_members WHERE version_id=$4 AND frozen_content IS NOT NULL AND traceability IS NOT NULL AND execution_readiness='ready')::text AS frozen,
    (SELECT count(*) FROM smarthub.workflow_runs WHERE id=$3 AND base_test_case_library_version_id=$4 AND base_test_case_library_version_sha256=$5)::text AS baseline`, [libraryCaseId, handoffId, runId, libraryVersionId, 'c'.repeat(64)])
  assert.deepEqual(normalized.rows[0], { migration: '1', requirements: '2', points: '2', handoffs: '1', frozen: '1', baseline: '1' })
  await assert.rejects(database.query('DELETE FROM smarthub.library_test_case_revisions WHERE case_id=$1 AND revision=1', [libraryCaseId]), /foreign key/iu)
  await assert.rejects(database.query('DELETE FROM smarthub.test_case_library_versions WHERE id=$1', [libraryVersionId]), /foreign key/iu)
  await runMigrations(connectionString)
  assert.equal((await database.query<{ count: string }>('SELECT count(*)::text AS count FROM smarthub.schema_migrations WHERE version=26')).rows[0].count, '1')
})

async function seedParents() {
  await database.query('INSERT INTO smarthub.projects (id, name, created_at, data) VALUES ($1,$2,$3,$4::jsonb)', [ids.project, `${prefix} project`, now, JSON.stringify({ id: ids.project, name: `${prefix} project`, createdAt: now })])
  await database.query('INSERT INTO smarthub.project_versions (id, project_id, name, status, created_at, updated_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)', [ids.projectVersion, ids.project, `${prefix} version`, 'open', now, now, JSON.stringify({ id: ids.projectVersion, projectId: ids.project, name: `${prefix} version`, status: 'open', createdAt: now, updatedAt: now })])
  await database.query('INSERT INTO smarthub.knowledge_bases (id, project_id, name, active_index_version_id, active_config_version_id, created_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)', [ids.knowledgeBase, ids.project, `${prefix} base`, null, ids.config, now, JSON.stringify({ id: ids.knowledgeBase, projectId: ids.project, name: `${prefix} base`, activeConfigVersionId: ids.config, createdAt: now })])
  await database.query('INSERT INTO smarthub.config_versions (id, knowledge_base_id, version, requires_rebuild, created_at, data) VALUES ($1,$2,$3,$4,$5,$6::jsonb)', [ids.config, ids.knowledgeBase, 1, false, now, JSON.stringify({ id: ids.config, knowledgeBaseId: ids.knowledgeBase, version: 1, requiresRebuild: false, createdAt: now })])
  await database.query('INSERT INTO smarthub.knowledge_assets (id, knowledge_base_id, logical_path, display_name, asset_type, source_type, active_version_id, created_at, updated_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)', [ids.asset, ids.knowledgeBase, `${prefix}.md`, `${prefix} asset`, 'document', 'upload', ids.assetVersion, now, now, JSON.stringify({ id: ids.asset, knowledgeBaseId: ids.knowledgeBase, logicalPath: `${prefix}.md`, displayName: `${prefix} asset`, assetType: 'document', sourceType: 'upload', activeVersionId: ids.assetVersion, createdAt: now, updatedAt: now })])
  await database.query('INSERT INTO smarthub.asset_versions (id, asset_id, version, content_hash, status, config_version_id, created_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [ids.assetVersion, ids.asset, 1, 'a'.repeat(64), 'ready', ids.config, now, JSON.stringify({ id: ids.assetVersion, assetId: ids.asset, number: 1, contentHash: 'a'.repeat(64), status: 'ready', configVersionId: ids.config, content: '', chunks: [], createdAt: now })])
}

async function createRun(name: string): Promise<ReviewRun> {
  const id = `${prefix}-${name}`
  const run: ReviewRun = {
    id,
    projectVersionId: ids.projectVersion,
    assetId: ids.asset,
    assetVersionId: ids.assetVersion,
    documentTitle: '队列测试需求',
    documentVersion: 1,
    logicalPath: `${prefix}.md`,
    sourceId: 'test-source',
    modelId: 'test-model',
    modelLabel: 'PostgreSQL 队列测试模型',
    status: 'running',
    step: 'waiting_worker',
    progress: 1,
    createdAt: now,
    startedAt: now,
    snapshot: {} as ReviewRun['snapshot'],
  }
  await database.query('INSERT INTO smarthub.review_runs (id, project_version_id, asset_id, asset_version_id, status, created_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)', [run.id, run.projectVersionId, run.assetId, run.assetVersionId, run.status, run.createdAt, JSON.stringify(run)])
  return run
}

async function enqueue(run: ReviewRun, maxAttempts: number) {
  const job: ReviewJob = {
    id: `${run.id}-job`,
    runId: run.id,
    projectVersionId: run.projectVersionId,
    status: 'queued',
    attempts: 0,
    maxAttempts,
    availableAt: now,
    createdAt: now,
    updatedAt: now,
  }
  await store.enqueueReviewJob?.(job)
}

async function reviewJob(runId: string) {
  const result = await database.query<{ status: string; attempt_count: number; lease_owner: string | null; run_token: string | null; available_at: string; error: string | null }>('SELECT status, attempt_count, lease_owner, run_token::text, available_at::text, error FROM smarthub.review_jobs WHERE run_id=$1', [runId])
  return required(result.rows[0], 'Review Job 不存在')
}

async function reviewRun(runId: string) {
  const result = await database.query<{ status: string; data: Pick<ReviewRun, 'status' | 'step'> }>('SELECT status, data FROM smarthub.review_runs WHERE id=$1', [runId])
  return required(result.rows[0], 'Review Run 不存在')
}

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message)
  return value
}
