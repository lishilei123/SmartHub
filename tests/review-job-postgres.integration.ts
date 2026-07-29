import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import type { ReviewRun } from '../server/domain/types.js'
import { runMigrations } from '../server/infrastructure/migrations.js'
import { PostgresStore } from '../server/infrastructure/postgres-store.js'
import type { ReviewJob, TaskLease } from '../server/infrastructure/store.js'

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
