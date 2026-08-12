import assert from 'node:assert/strict'
import test from 'node:test'
import { askRequirementReviewQuestion, retryRequirementReviewRun, type AgentExecutionEvent, type ReviewQuestionResponse } from '../src/requirement-analysis-api.js'

test('评审问答客户端逐帧接收执行事件并返回最终答案', async () => {
  const originalFetch = globalThis.fetch
  const event: AgentExecutionEvent = { sequence: 1, type: 'tool_execution_start', occurredAt: '2026-07-28T00:00:00.000Z', turn: 1, toolId: 'review_answer_submit', toolCallId: 'call-1', toolArguments: { answer: '测试回答' } }
  const result: ReviewQuestionResponse = {
    id: 'review_qa_test', runId: 'run-1', question: '测试问题', answer: '测试回答', citations: [], limitations: [], modelLabel: '测试模型', createdAt: '2026-07-28T00:00:01.000Z',
    execution: { agentKey: 'review-qa', turns: 1, toolCalls: 1, toolErrors: 0, framework: { name: 'pi-agent-core', version: 'test' }, events: [event] },
  }
  const payload = `${JSON.stringify({ type: 'event', event })}\n${JSON.stringify({ type: 'result', result })}\n`
  const encoded = new TextEncoder().encode(payload)
  let requestedUrl = ''
  globalThis.fetch = async input => {
    requestedUrl = String(input)
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 17))
        controller.enqueue(encoded.slice(17, 73))
        controller.enqueue(encoded.slice(73))
        controller.close()
      },
    }), { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } })
  }
  try {
    const events: AgentExecutionEvent[] = []
    const answer = await askRequirementReviewQuestion('run-1', { question: '测试问题' }, undefined, item => events.push(item))
    assert.match(requestedUrl, /questions\?stream=true$/u)
    assert.deepEqual(events, [event])
    assert.equal(answer.answer, '测试回答')
    assert.equal(answer.execution.toolCalls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

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
