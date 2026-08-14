import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import { TestReportService } from '../server/application/test-report-service.js'
import {
  freezeExecutionTaskInput,
  unsupportedExecutionMethodReason,
} from '../server/application/test-execution-validation.js'
import type {
  ExecutionRun,
  ExecutionTask,
} from '../server/domain/test-execution-types.js'
import type {
  PerformanceExecutionSpec,
  TestCaseContent,
  TestCaseLibraryVersionMemberDetail,
  TestExecutionHandoffMember,
} from '../server/domain/test-design-types.js'
import { runMigrations } from '../server/infrastructure/migrations.js'
import { PostgresTestExecutionStore } from '../server/infrastructure/test-execution-store.js'
import { reportSourceFixture } from './test-report-fixture.js'

const connectionString = process.env.TEST_DATABASE_URL
if (!connectionString) throw new Error('test:postgres 需要配置指向隔离数据库的 TEST_DATABASE_URL')
if (!/test/iu.test(new URL(connectionString).pathname)) throw new Error('TEST_DATABASE_URL 必须指向名称包含 test 的隔离数据库')

await runMigrations(connectionString)

const database = new Pool({ connectionString })
const store = new PostgresTestExecutionStore(connectionString)
const service = new TestReportService(store)
const prefix = `test-report-postgres-${randomUUID()}`
const now = '2026-08-14T08:00:00.000Z'
const templateRun = reportSourceFixture().run
const ids = {
  project: `${prefix}-project`,
  projectVersion: `${prefix}-project-version`,
  libraryVersion: `${prefix}-library-version`,
  handoff: `${prefix}-handoff`,
  run: `${prefix}-run`,
}

const performanceSpec: PerformanceExecutionSpec = {
  kind: 'performance',
  method: 'performance_tool',
  target: '/api/orders',
  scenario: '订单查询基准',
  virtualUsers: 20,
  duration: '5m',
  rampUp: '30s',
  thresholds: [{ metric: 'p95', target: '<500ms', sourceRef: 'NFR-1' }],
  dataStrategy: '隔离测试数据',
  environmentRequirements: ['性能隔离环境'],
  executionReadiness: 'ready',
}

function caseFixture(ordinal: number) {
  const caseId = `${prefix}-case-${ordinal}`
  const content: TestCaseContent = {
    schemaVersion: 'test-case/v2',
    title: `不支持的性能用例 ${ordinal}`,
    objective: '验证报告读取不支持任务',
    dimension: 'performance',
    testPointIds: [`${prefix}-point-${ordinal}`],
    priority: 'P1',
    preconditions: [],
    dataRequirementIds: [],
    cleanup: [],
    dependencies: [],
    executionMethods: [],
    executionSpec: performanceSpec,
    sharedVerificationChecks: [],
    tags: ['report-postgres'],
    domain: 'reporting',
  }
  const contentSha256 = canonicalSha256(content)
  const libraryMember: TestCaseLibraryVersionMemberDetail = {
    caseId,
    revision: 1,
    ordinal,
    contentSha256,
    frozenContent: content,
    executionReadiness: 'ready',
  }
  const handoffMember: TestExecutionHandoffMember = {
    stage: 'full',
    ordinal,
    sourceVersionId: ids.libraryVersion,
    caseId,
    revision: 1,
    method: 'performance_tool',
    reason: '完整回归',
    dedupKey: `${caseId}:1:performance_tool`,
    dimension: 'performance',
    executionSpec: performanceSpec,
    contentSha256,
  }
  const input = freezeExecutionTaskInput({ handoffMember, libraryMember })
  return { caseId, content, contentSha256, libraryMember, handoffMember, input }
}

const cases = [caseFixture(0), caseFixture(1)]
const librarySourceRunId = `${prefix}-design-run`
const libraryVersionSha256 = canonicalSha256({
  schemaVersion: 'test-case-library/v1',
  projectId: ids.project,
  sourceRunId: librarySourceRunId,
  members: cases.map(item => item.libraryMember),
})
const handoffSha256 = canonicalSha256({
  projectId: ids.project,
  projectVersionId: ids.projectVersion,
  testCaseLibraryVersionId: ids.libraryVersion,
  mode: 'full',
  members: cases.map(item => item.handoffMember),
})
const run: ExecutionRun = {
  id: ids.run,
  projectId: ids.project,
  projectVersionId: ids.projectVersion,
  handoff: {
    handoffId: ids.handoff,
    handoffSha256,
    projectId: ids.project,
    projectVersionId: ids.projectVersion,
    testCaseLibraryVersionId: ids.libraryVersion,
    testCaseLibraryVersionSha256: libraryVersionSha256,
    mode: 'full',
    memberSnapshotSha256: canonicalSha256(cases.map(item => item.input)),
  },
  environment: templateRun.environment,
  runner: templateRun.runner,
  agents: templateRun.agents,
  status: 'queued',
  stateVersion: 0,
  idempotencyKey: `${prefix}-idempotency`,
  taskCount: cases.length,
  createdBy: 'integration-test',
  createdAt: now,
}
const unsupportedReason = unsupportedExecutionMethodReason('performance_tool')!
const tasks: ExecutionTask[] = cases.map((item, index) => ({
  id: `${prefix}-task-${index}`,
  runId: ids.run,
  input: item.input,
  status: 'unsupported',
  stateVersion: 0,
  runnerAttemptCount: 0,
  sameScriptRetryCount: 0,
  repairCount: 0,
  unsupportedReason,
  createdAt: now,
  updatedAt: now,
  finishedAt: now,
}))

test.before(async () => {
  await seedSources()
  await store.createAggregate({ run, tasks: tasks.slice().reverse(), jobs: [] })
})

test.after(async () => {
  await store.close()
  await database.end()
})

test('PostgreSQL 报告 reader 读取一致正式来源、稳定排序且不写入执行事实', async () => {
  const before = await executionFactState()
  const source = await store.getRunReportSource(ids.run)
  assert.ok(source)
  assert.equal(source.run.id, ids.run)
  assert.equal(source.run.status, 'partial')
  assert.equal(source.testCaseLibraryVersionSourceRunId, librarySourceRunId)
  assert.deepEqual(source.tasks.map(task => task.input.ordinal), [0, 1])
  assert.deepEqual(source.attempts, [])
  assert.deepEqual(source.diagnoses, [])
  assert.deepEqual(source.scriptRevisions, [])
  assert.deepEqual(source.artifacts, [])

  const report = await service.getReport(ids.run)
  assert.equal(report.overview.totalCases, 2)
  assert.equal(report.overview.unsupported, 2)
  assert.deepEqual(report.overview.finalPassRate, {
    numerator: 0,
    denominator: 2,
    percentage: 0,
  })
  assert.equal(report.traceability.handoff.sha256, handoffSha256)
  assert.equal(report.traceability.testCaseLibraryVersion.sha256, libraryVersionSha256)
  assert.equal(report.traceability.testCaseLibraryVersion.sourceRunId, librarySourceRunId)
  assert.doesNotMatch(JSON.stringify(report), /storagePath/u)
  assert.deepEqual(await executionFactState(), before)
})

async function seedSources() {
  await database.query(
    'INSERT INTO smarthub.projects (id,name,created_at,data) VALUES ($1,$2,$3,$4::jsonb)',
    [ids.project, `${prefix} project`, now, JSON.stringify({ id: ids.project, name: `${prefix} project`, createdAt: now })],
  )
  await database.query(
    'INSERT INTO smarthub.project_versions (id,project_id,name,status,created_at,updated_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)',
    [ids.projectVersion, ids.project, `${prefix} version`, 'open', now, now, JSON.stringify({ id: ids.projectVersion, projectId: ids.project, name: `${prefix} version`, status: 'open', createdAt: now, updatedAt: now })],
  )
  for (const item of cases) {
    await database.query(
      'INSERT INTO smarthub.library_test_cases (id,project_id,current_revision,status,created_at,updated_at,data) VALUES ($1,$2,1,$3,$4,$4,$5::jsonb)',
      [item.caseId, ids.project, 'active', now, JSON.stringify({ id: item.caseId, projectId: ids.project, currentRevision: 1, status: 'active', createdAt: now, updatedAt: now })],
    )
    await database.query(
      'INSERT INTO smarthub.library_test_case_revisions (case_id,revision,content_sha256,semantic_sha256,created_by,created_at,content,data) VALUES ($1,1,$2,$2,$3,$4,$5::jsonb,$6::jsonb)',
      [item.caseId, item.contentSha256, 'integration-test', now, JSON.stringify(item.content), JSON.stringify({ revision: 1, content: item.content, contentSha256: item.contentSha256, semanticSha256: item.contentSha256, changeReason: 'report reader integration', createdBy: 'integration-test', createdAt: now })],
    )
  }
  await database.query(
    'INSERT INTO smarthub.test_case_library_versions (id,project_id,version,name,source_run_id,content_sha256,published_by,published_at,data) VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8::jsonb)',
    [ids.libraryVersion, ids.project, 'Report reader library', librarySourceRunId, libraryVersionSha256, 'integration-test', now, JSON.stringify({ id: ids.libraryVersion, projectId: ids.project, version: 1, name: 'Report reader library', sourceRunId: librarySourceRunId, members: cases.map(item => item.libraryMember), contentSha256: libraryVersionSha256, publishedBy: 'integration-test', publishedAt: now, projection: { status: 'succeeded', files: [] } })],
  )
  for (const item of cases) {
    await database.query(
      'INSERT INTO smarthub.test_case_library_version_members (version_id,case_id,case_revision,ordinal,content_sha256,frozen_content,execution_readiness) VALUES ($1,$2,1,$3,$4,$5::jsonb,$6)',
      [ids.libraryVersion, item.caseId, item.libraryMember.ordinal, item.contentSha256, JSON.stringify(item.content), 'ready'],
    )
  }
  await database.query(
    'INSERT INTO smarthub.test_execution_handoffs (id,project_version_id,test_case_library_version_id,execution_mode,strategy,content_sha256,created_by,created_at,content,data) VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8::jsonb,$8::jsonb)',
    [ids.handoff, ids.projectVersion, ids.libraryVersion, 'full', handoffSha256, 'integration-test', now, JSON.stringify({ id: ids.handoff, projectId: ids.project, projectVersionId: ids.projectVersion, testCaseLibraryVersionId: ids.libraryVersion, mode: 'full', members: cases.map(item => item.handoffMember), contentSha256: handoffSha256, createdBy: 'integration-test', createdAt: now })],
  )
  for (const item of cases) {
    await database.query(
      'INSERT INTO smarthub.test_execution_handoff_members (handoff_id,stage,ordinal,source_version_id,case_id,case_revision,method,dedup_key,dimension,execution_spec,content_sha256,data) VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$9::jsonb,$10,$11::jsonb)',
      [ids.handoff, 'full', item.handoffMember.ordinal, ids.libraryVersion, item.caseId, 'performance_tool', item.handoffMember.dedupKey, 'performance', JSON.stringify(performanceSpec), item.contentSha256, JSON.stringify(item.handoffMember)],
    )
  }
}

async function executionFactState() {
  const result = await database.query<{
    status: string
    state_version: number
    task_count: string
    attempt_count: string
    diagnosis_count: string
    revision_count: string
    artifact_count: string
  }>(`
    SELECT run.status,run.state_version,
      (SELECT count(*) FROM smarthub.test_execution_tasks WHERE run_id=run.id)::text AS task_count,
      (SELECT count(*) FROM smarthub.test_execution_attempts WHERE run_id=run.id)::text AS attempt_count,
      (SELECT count(*) FROM smarthub.test_execution_diagnoses WHERE run_id=run.id)::text AS diagnosis_count,
      (SELECT count(*) FROM smarthub.test_execution_script_revisions WHERE run_id=run.id)::text AS revision_count,
      (SELECT count(*) FROM smarthub.test_execution_artifacts WHERE run_id=run.id)::text AS artifact_count
    FROM smarthub.test_execution_runs run WHERE run.id=$1
  `, [ids.run])
  return result.rows[0]
}
