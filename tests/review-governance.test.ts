import assert from 'node:assert/strict'
import test from 'node:test'
import { ReviewGovernanceService } from '../server/application/review-governance-service.js'
import type { ReviewRun } from '../server/domain/types.js'
import { JsonStore } from '../server/infrastructure/store.js'

async function governedStore(status: ReviewRun['status'] = 'succeeded') {
  const store = new JsonStore(null)
  await store.load()
  await store.transaction(state => {
    state.projectVersions.push({ id: 'pv-1', projectId: 'project-1', name: 'V1', status: 'open', createdAt: '2026-07-28T00:00:00.000Z', updatedAt: '2026-07-28T00:00:00.000Z' })
    state.reviewRuns.push({
      id: 'run-1', projectVersionId: 'pv-1', assetId: 'asset-1', assetVersionId: 'version-1', documentTitle: '需求', documentVersion: 1,
      logicalPath: 'requirements/a.md', sourceId: 'source-1', modelId: 'model-1', modelLabel: '测试模型', status, step: status === 'succeeded' ? 'completed' : 'extracting_requirement_points', progress: status === 'succeeded' ? 100 : 10,
      createdAt: '2026-07-28T00:00:00.000Z', startedAt: '2026-07-28T00:00:00.000Z',
      snapshot: { runId: 'run-1', projectId: 'project-1', projectName: 'SmartHub', projectVersionId: 'pv-1', projectVersionName: 'V1', knowledgeBaseId: 'kb-1', assetId: 'asset-1', assetVersionId: 'version-1', assetContentHash: 'a'.repeat(64), indexVersionId: 'index-1', logicalPath: 'requirements/a.md', assets: [{ assetId: 'asset-1', assetVersionId: 'version-1', assetContentHash: 'a'.repeat(64), logicalPath: 'requirements/a.md', displayName: '需求' }], modelRef: { sourceId: 'source-1', modelId: 'model-1', providerType: 'openai_compatible', modelName: 'model', contextWindow: 32_768, maxOutputTokens: 4_096, supportsReasoning: false }, focusAreas: [], excludedAreas: [], agentDefinition: {} as never, analysisCoveragePlan: [], analysisToolBudget: { directoryCalls: 0, chunkCalls: 0, knowledgeCalls: 0, submissionCalls: 1, minimumToolCalls: 1 }, analysisInput: { policyVersion: 'v1', mode: 'agent_directory', estimatedInputTokens: 10, safeInputBudget: 10_000, packageSha256: 'b'.repeat(64), batches: [] }, createdAt: '2026-07-28T00:00:00.000Z' },
      result: { summary: { overview: '订单取消需求分析。', businessGoals: ['支持订单取消'], overallAssessment: 'needs_revision', score: 70, strengths: [], risks: ['需确认'] }, requirementPoints: [{ clientRequirementPointId: 'RP-001', title: '取消订单', description: '用户取消订单', actor: '用户', action: '取消', object: '订单', conditions: [], businessRules: [], exceptions: [], acceptanceCriteria: [], evidenceRefs: ['E-001'] }], findings: [{ clientFindingId: 'F-001', type: 'ambiguity', severity: 'blocker', confidence: 0.9, title: '取消边界不清', description: '未说明已支付状态', impact: '可能误取消', recommendation: '明确状态' , requirementPointRefs: ['RP-001'] }], testFocus: [{ id: 'TF-001', title: '取消边界', description: '验证不同支付状态的取消规则。', requirementPointRefs: ['RP-001'] }], evidence: [{ clientEvidenceId: 'E-001', sourceType: 'knowledge_chunk', sourceRef: { chunkId: 'chunk-1', assetVersionId: 'version-1' }, quote: '用户可以取消订单', locator: { heading: '取消', start: 1, end: 10 } }], coverage: { assets: [{ assetVersionId: 'version-1', deliveredChunkIds: ['chunk-1'], excludedChunks: [] }], limitations: [] }, artifacts: [] },
      executions: { requirementAnalysis: { agentKey: 'requirement-analysis', turns: 1, toolCalls: 1, events: [] } },
    })
  })
  return store
}

test('高风险工具审批绑定参数 Hash，批准后放行且参数变化重新审批', async () => {
  const store = await governedStore('running')
  const service = new ReviewGovernanceService(store)
  const controller = new AbortController()
  const authorization = service.authorize({ runId: 'run-1', toolId: 'external.write', toolVersion: '1.0.0', risk: 'write_high_risk', arguments: { ticket: 'A-1', apiKey: 'must-not-leak' }, signal: controller.signal })
  await new Promise(resolve => setTimeout(resolve, 20))
  const pending = await service.listApprovals('run-1')
  assert.equal(pending.length, 1)
  assert.equal(pending[0].parameterHash.length, 64)
  assert.doesNotMatch(pending[0].parameterSummary, /must-not-leak/u)
  await service.decideApproval(pending[0].id, { decision: 'approved', principal: { subjectId: 'approver-1', displayName: '审批人' } })
  await authorization
  assert.ok((await service.listApprovals('run-1'))[0].consumedAt)

  const replayController = new AbortController()
  const replay = service.authorize({ runId: 'run-1', toolId: 'external.write', toolVersion: '1.0.0', risk: 'write_high_risk', arguments: { ticket: 'A-1', apiKey: 'must-not-leak' }, signal: replayController.signal })
  await new Promise(resolve => setTimeout(resolve, 20))
  const replayPending = (await service.listApprovals('run-1')).find(item => item.status === 'pending')
  assert.ok(replayPending)
  assert.notEqual(replayPending.id, pending[0].id)
  replayController.abort(new Error('replay cancelled'))
  await assert.rejects(replay, /replay cancelled/u)
  assert.equal((await service.listApprovals('run-1')).find(item => item.id === replayPending.id)?.status, 'cancelled')

  const changedController = new AbortController()
  const changed = service.authorize({ runId: 'run-1', toolId: 'external.write', toolVersion: '1.0.0', risk: 'write_high_risk', arguments: { ticket: 'A-2' }, signal: changedController.signal })
  await new Promise(resolve => setTimeout(resolve, 20))
  const approvals = await service.listApprovals('run-1')
  assert.equal(approvals.filter(item => item.status === 'pending').length, 1)
  changedController.abort(new Error('test cancelled'))
  await assert.rejects(changed, /test cancelled/u)
  assert.equal((await service.listApprovals('run-1')).find(item => item.status === 'pending'), undefined)
})
