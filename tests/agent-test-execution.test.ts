import assert from 'node:assert/strict'
import test from 'node:test'
import { applyAgentEvaluationCandidate } from '../server/application/test-execution-service.js'
import type { AgentTestSpec, AgentUnderTestVersion, FrozenAgentUnderTestSnapshot } from '../server/domain/agent-test-types.js'
import { AgentRunner, UnavailableAgentSemanticEvaluator } from '../server/runner/agent-runner.js'

const createdAt = '2026-09-02T00:00:00.000Z'
const configurationSha256 = 'a'.repeat(64)
const requestMapping = { method: 'POST' as const, inputField: 'input' }
const responseMapping = { outputPath: 'output', tracePath: 'trace', traceCompleteness: 'complete' as const }
const version: AgentUnderTestVersion = {
  version: 1,
  endpoint: 'https://agent.example.test/run',
  protocol: 'http',
  authenticationConfig: { type: 'none' },
  requestMapping,
  responseMapping,
  documentationRefs: [],
  configurationSha256,
  createdAt,
  createdBy: 'tester',
}
const snapshot: FrozenAgentUnderTestSnapshot = {
  id: 'aut-1',
  projectId: 'project-1',
  projectVersionId: 'version-1',
  name: 'AUT',
  version: 1,
  endpoint: version.endpoint,
  protocol: version.protocol,
  requestMapping,
  responseMapping,
  documentationRefs: [],
  configurationSha256,
}
const spec: AgentTestSpec = {
  input: { prompt: 'create task' },
  expectedOutcome: '任务创建成功',
  requiredTools: [],
  forbiddenTools: [],
  requiredActions: [],
  forbiddenActions: [],
  argumentAssertions: [],
  sequenceConstraints: [],
  businessAssertions: [],
  artifactAssertions: [],
  semanticAssertions: [],
  safetyAssertions: [],
  executionConstraints: { timeoutMs: 5_000, maxSteps: 10, repeatCount: 1 },
}

test('AgentRunner 使用执行代次隔离不可变 CaseRun 与 Trace 身份', async () => {
  const runner = new AgentRunner(
    new UnavailableAgentSemanticEvaluator(),
    async () => new Response(JSON.stringify({ output: 'done', trace: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
  )
  const first = await runner.execute({ runId: 'run-1', taskId: 'task-1', executionAttemptOrdinal: 1, agentUnderTest: snapshot, resolvedVersion: version, spec }, new AbortController().signal)
  const second = await runner.execute({ runId: 'run-1', taskId: 'task-1', executionAttemptOrdinal: 2, agentUnderTest: snapshot, resolvedVersion: version, spec }, new AbortController().signal)
  assert.equal(first.executionAttemptOrdinal, 1)
  assert.equal(second.executionAttemptOrdinal, 2)
  assert.notEqual(first.caseRuns[0]?.id, second.caseRuns[0]?.id)
  assert.match(first.caseRuns[0]!.id, /:attempt:1:repeat:1$/u)
  assert.match(second.caseRuns[0]!.id, /:attempt:2:repeat:1$/u)
})

test('模型 Evaluation 失败同步生成正式 Failure Fact 并重算聚合状态', async () => {
  const runner = new AgentRunner(
    new UnavailableAgentSemanticEvaluator(),
    async () => new Response(JSON.stringify({ output: 'done', trace: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
  )
  const initial = await runner.execute({ runId: 'run-1', taskId: 'task-1', executionAttemptOrdinal: 1, agentUnderTest: snapshot, resolvedVersion: version, spec }, new AbortController().signal)
  const evaluation = initial.caseRuns[0]!.evaluationResults[0]!
  const evidenceRefs = initial.caseRuns[0]!.traceEvents.filter(item => item.type === 'AGENT_OUTPUT').map(item => item.id)
  const evaluated = applyAgentEvaluationCandidate(initial, { results: [{ caseRunId: evaluation.caseRunId, kind: evaluation.kind, criterion: evaluation.criterion, status: 'FAIL', explanation: '输出未满足任务完成标准', evidenceRefs }] }, 'model-snapshot-1')
  assert.equal(evaluated.status, 'FAIL')
  assert.equal(evaluated.caseRuns[0]?.status, 'FAIL')
  assert.deepEqual(evaluated.caseRuns[0]?.failureFacts.map(item => item.code), ['AI_EVALUATION_FAILED'])
  assert.equal(evaluated.caseRuns[0]?.failureFacts[0]?.message, '输出未满足任务完成标准')
})
