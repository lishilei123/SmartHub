import assert from 'node:assert/strict'
import test from 'node:test'
import type { CandidateRequirementPoint } from '../server/domain/review-types.js'

type GoldenRequirementPoint = {
  id: string
  critical: boolean
  evidenceRefs: string[]
  mergeGroupId?: string
}

const goldenSample: GoldenRequirementPoint[] = [
  { id: 'RP-CANCEL', critical: true, evidenceRefs: ['E-CANCEL'] },
  { id: 'RP-TIMEOUT', critical: true, evidenceRefs: ['E-TIMEOUT'] },
  { id: 'RP-NOTIFY', critical: false, evidenceRefs: ['E-NOTIFY'], mergeGroupId: 'notification' },
]

const extractedSample: CandidateRequirementPoint[] = [
  {
    clientRequirementPointId: 'RP-CANCEL',
    title: '取消待支付订单',
    description: '用户可以取消处于待支付状态的订单。',
    actor: '用户',
    action: '取消',
    object: '待支付订单',
    conditions: ['订单处于待支付状态'],
    businessRules: ['取消后释放待支付占用资源'],
    exceptions: ['已支付订单不可取消'],
    acceptanceCriteria: ['提交取消后订单不再待支付'],
    evidenceRefs: ['E-CANCEL'],
    coverageTarget: true,
  },
  {
    clientRequirementPointId: 'RP-TIMEOUT',
    title: '支付超时关闭订单',
    description: '超过十五分钟未支付的订单会自动关闭。',
    actor: '系统',
    action: '关闭',
    object: '超时未支付订单',
    conditions: ['超过十五分钟未支付'],
    businessRules: ['超时自动关闭'],
    exceptions: [],
    acceptanceCriteria: ['超时订单状态为已关闭'],
    evidenceRefs: ['E-TIMEOUT'],
    coverageTarget: true,
  },
  {
    clientRequirementPointId: 'RP-NOTIFY',
    title: '通知订单状态变更',
    description: '订单关闭或取消后通知用户。',
    actor: '系统',
    action: '通知',
    object: '用户',
    conditions: ['订单状态发生关闭或取消变更'],
    businessRules: [],
    exceptions: [],
    acceptanceCriteria: ['用户收到状态变更通知'],
    evidenceRefs: ['E-NOTIFY'],
    coverageTarget: true,
    mergeGroupId: 'notification',
    mergeRationale: '关闭和取消后的通知属于同一状态变更通知规则。',
  },
]

test('需求点黄金集达到试点的原子性、召回、证据与归并阈值', () => {
  const metrics = calculateGoldenMetrics(goldenSample, extractedSample)

  assert.equal(metrics.totalRecall, 1)
  assert.equal(metrics.criticalRecall, 1)
  assert.equal(metrics.evidenceValidity, 1)
  assert.equal(metrics.mergeAccuracy, 1)
  assert.equal(metrics.atomicity, 1)
  assert.ok(metrics.totalRecall >= 0.9)
  assert.ok(metrics.criticalRecall >= 0.95)
  assert.ok(metrics.evidenceValidity >= 1)
  assert.ok(metrics.mergeAccuracy >= 0.9)
  assert.ok(metrics.atomicity >= 0.95)
})

function calculateGoldenMetrics(golden: GoldenRequirementPoint[], extracted: CandidateRequirementPoint[]) {
  const byId = new Map(extracted.map(point => [point.clientRequirementPointId, point]))
  const matched = golden.filter(point => byId.has(point.id))
  const critical = golden.filter(point => point.critical)
  const criticalMatched = critical.filter(point => byId.has(point.id))
  const validEvidence = matched.filter(point => {
    const extractedPoint = byId.get(point.id)!
    return point.evidenceRefs.every(ref => extractedPoint.evidenceRefs.includes(ref))
  })
  const expectedMerged = golden.filter(point => point.mergeGroupId)
  const correctMerged = expectedMerged.filter(point => {
    const extractedPoint = byId.get(point.id)
    return extractedPoint?.mergeGroupId === point.mergeGroupId && Boolean(extractedPoint.mergeRationale?.trim())
  })
  const atomic = extracted.filter(point => Boolean(
    point.actor.trim()
    && point.action.trim()
    && point.object.trim()
    && point.evidenceRefs.length
    && (point.conditions.length || point.businessRules.length || point.exceptions.length || point.acceptanceCriteria.length)
  ))
  return {
    totalRecall: matched.length / golden.length,
    criticalRecall: criticalMatched.length / critical.length,
    evidenceValidity: validEvidence.length / matched.length,
    mergeAccuracy: correctMerged.length / expectedMerged.length,
    atomicity: atomic.length / extracted.length,
  }
}
