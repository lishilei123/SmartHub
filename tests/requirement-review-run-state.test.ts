import test from 'node:test'
import assert from 'node:assert/strict'
import { persistedRunningReviewRunIds, resolveReviewRunId } from '../src/requirement-review-run-state.js'

test('需求评审轮询忽略尚未获得服务端 ID 的临时运行', () => {
  assert.deepEqual(persistedRunningReviewRunIds([
    { id: 'pending-123', status: 'running' },
    { id: 'review_run_1', status: 'running' },
    { runId: 'review_run_2', status: 'running' },
    { id: 'review_run_3', status: 'succeeded' },
  ]), ['review_run_1', 'review_run_2'])
})

test('需求评审创建响应兼容 id 与 runId', () => {
  assert.equal(resolveReviewRunId({ id: 'review_run_id', runId: 'review_run_legacy' }), 'review_run_id')
  assert.equal(resolveReviewRunId({ runId: 'review_run_legacy' }), 'review_run_legacy')
  assert.equal(resolveReviewRunId(undefined), '')
})
