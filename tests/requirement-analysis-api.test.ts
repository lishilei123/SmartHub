import assert from 'node:assert/strict'
import test from 'node:test'
import { finalizeRequirementRepairDraft, retryRequirementReviewRun } from '../src/requirement-analysis-api.js'

test('需求分析重跑客户端只提交完整重跑模式', async () => {
  const originalFetch = globalThis.fetch
  const requestedUrls: string[] = []
  const requestedBodies: string[] = []
  globalThis.fetch = async (input, init) => {
    requestedUrls.push(String(input))
    requestedBodies.push(String(init?.body ?? ''))
    const mode = (JSON.parse(requestedBodies.at(-1)!) as { mode: 'full' }).mode
    return new Response(JSON.stringify({
      id: `review-run-${mode}`, projectVersionId: 'project-version-1', assetId: 'asset-1', assetVersionId: 'version-1', assetIds: ['asset-1'], assetVersionIds: ['version-1'], documents: [], documentTitle: '需求', documentVersion: 'V1', logicalPath: 'requirements/a.md', modelLabel: '分析模型', status: 'running', step: 'analyzing_requirements', progress: 10, createdAt: '2026-07-28T00:00:00.000Z', startedAt: '2026-07-28T00:00:00.000Z', retryMode: mode, retryOfRunId: 'review-run-source',
    }), { status: 202, headers: { 'content-type': 'application/json' } })
  }
  try {
    const retriedRun = await retryRequirementReviewRun('review-run-source')
    assert.ok(requestedUrls.every(url => /requirement-review-runs\/review-run-source\/retry$/u.test(url)))
    assert.deepEqual(requestedBodies.map(body => JSON.parse(body)), [{ mode: 'full' }])
    assert.equal(retriedRun.step, 'analyzing_requirements')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('修复应用完成接口只确认新版本，不复用复验启动接口', async () => {
  const originalFetch = globalThis.fetch
  let requestedUrl = ''
  let requestedMethod = ''
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input)
    requestedMethod = String(init?.method)
    return Response.json({
      id: 'repair-draft-1',
      sourceRunId: 'review-run-1',
      status: 'applied',
      candidate: { schemaVersion: 'requirement-repair/v1', summary: '补充重试次数', patches: [] },
      generationExecution: { turns: 1, toolCalls: 1, events: [] },
      createdAt: '2026-08-12T00:00:00.000Z',
      createdBy: 'reviewer',
    })
  }
  try {
    const draft = await finalizeRequirementRepairDraft('review-run-1', 'repair-draft-1')
    assert.equal(requestedUrl, 'http://127.0.0.1:8787/api/requirement-review-runs/review-run-1/repair-drafts/repair-draft-1/finalize')
    assert.equal(requestedMethod, 'POST')
    assert.equal(draft.status, 'applied')
  } finally {
    globalThis.fetch = originalFetch
  }
})
