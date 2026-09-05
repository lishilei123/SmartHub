import type { TestDesignWorkflowRun } from './test-design-types.js'

/** Deterministic recovery of an interrupted node; completed facts stay intact. */
export function recoverTestDesignNode(
  run: TestDesignWorkflowRun,
  nodeRunId: string,
  input: { cancelled: boolean; exhausted: boolean; at: string },
): 'queued' | 'succeeded' | 'failed' | 'cancelled' {
  const node = run.nodeRuns.find(item => item.id === nodeRunId)
  if (!node || node.status === 'stale' || run.status === 'cancelled' || node.status === 'cancelled') return 'cancelled'
  if (node.status === 'succeeded' || run.status === 'succeeded') return 'succeeded'
  if (input.cancelled || input.exhausted) {
    const status = input.cancelled ? 'cancelled' : 'failed'
    const errorCode = input.cancelled ? 'WORKFLOW_CANCELLED' : 'WORKFLOW_JOB_LEASE_EXHAUSTED'
    const error = input.cancelled ? '运行已取消，过期任务已收口' : '测试设计 Worker 租约过期且重试次数已耗尽，请人工重试'
    Object.assign(node, { status, finishedAt: input.at, errorCode, error })
    Object.assign(run, { status, stage: status, finishedAt: input.at, errorCode, error })
    if (run.automaticRepair && ['queued', 'running'].includes(run.automaticRepair.status)) {
      run.automaticRepair.status = input.cancelled ? 'deferred' : 'exhausted'
      run.automaticRepair.finishedAt = input.at
    }
    return status
  }
  Object.assign(node, { status: 'queued', finishedAt: undefined })
  Object.assign(run, { status: 'queued', stage: node.nodeKey, finishedAt: undefined })
  if (node.nodeKey === 'test_design_repair' && run.automaticRepair) run.automaticRepair.status = 'queued'
  return 'queued'
}
