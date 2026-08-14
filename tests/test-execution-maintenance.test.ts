import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import test from 'node:test'
import { canonicalSha256 } from '../server/application/canonical-json.js'
import type { TestExecutionService } from '../server/application/test-execution-service.js'
import type { CaseMaintenanceProposal } from '../server/domain/test-execution-types.js'
import type { ExecutionArtifactStore } from '../server/infrastructure/execution-artifact-store.js'
import { routeTestExecution } from '../server/http/test-execution-routes.js'

const principal = { subjectId: 'operator-1', displayName: '维护审批人' }
const run = { id: 'run-1', projectVersionId: 'pv-1', stateVersion: 4 }
const task = { id: 'task-1', runId: run.id, stateVersion: 7 }
const proposal: CaseMaintenanceProposal = {
  id: 'proposal-1',
  runId: run.id,
  taskId: task.id,
  caseId: 'case-1',
  caseRevision: 3,
  diagnosisId: 'diagnosis-1',
  scriptRevisionId: 'revision-repair',
  status: 'pending',
  summary: '修复脚本已通过真实 Runner，建议人工维护 selector',
  proposedChange: '仅维护 selector 或脚本执行表达；不得修改 Expected Result、Verification Check、matcher、Requirement 或业务语义。',
  baselineLibraryVersionId: 'library-version-1',
  baselineLibraryVersionSha256: 'a'.repeat(64),
  createdAt: '2026-08-14T00:00:00.000Z',
}
const detail = {
  proposal,
  run,
  task,
  diagnosis: {
    id: proposal.diagnosisId,
    runId: run.id,
    taskId: task.id,
    scriptRevisionId: 'revision-original',
    attemptIds: ['attempt-failed'],
    category: 'script_defect',
    confidence: 0.9,
    summary: 'selector 不再匹配',
    evidence: [{ attemptId: 'attempt-failed', observation: '元素未找到' }],
    repairable: true,
    recommendedAction: '修复 selector',
    source: 'agent',
    createdAt: '2026-08-14T00:00:00.000Z',
  },
  failureAttempts: [],
  originalScriptRevision: { id: 'revision-original', revision: 1 },
  repairScriptRevision: { id: proposal.scriptRevisionId, revision: 2 },
  postRepairAttempt: { id: 'attempt-passed', ordinal: 2, kind: 'post_repair', status: 'passed' },
  baselineCase: { caseId: proposal.caseId, revision: proposal.caseRevision, content: {}, contentSha256: 'b'.repeat(64) },
  baselineLibraryVersion: { id: proposal.baselineLibraryVersionId, sha256: proposal.baselineLibraryVersionSha256 },
  diff: { fromRevision: {}, toRevision: {}, changes: { removed: { lines: [] }, added: { lines: [] } } },
}
const proposalEtag = `"sha256-${canonicalSha256(proposal)}"`
const detailEtag = `"sha256-${canonicalSha256(detail)}"`

function maintenanceService(overrides: Record<string, unknown> = {}) {
  return {
    async getRun() { return run },
    async getTask() { return task },
    async listMaintenanceProposals() { return [proposal] },
    async listTaskMaintenanceProposals() { return [proposal] },
    async getMaintenanceProposal() { return proposal },
    async maintenanceProposalDetail() { return detail },
    ...overrides,
  }
}

test('Run 与 Task 维护建议列表复用 read 权限、scope 和私有 no-store', async () => {
  const paths = [
    '/api/project-versions/pv-1/test-execution-runs/run-1/maintenance-proposals',
    '/api/project-versions/pv-1/test-execution-runs/run-1/tasks/task-1/maintenance-proposals',
  ]
  for (const path of paths) {
    const result = await routeCall({ method: 'GET', path, service: maintenanceService() })
    assert.equal(result.status, 200)
    assert.deepEqual(result.body, { items: [proposal] })
    assert.deepEqual(result.permissions, [{ projectVersionId: 'pv-1', permission: 'test-execution:read' }])
    assert.equal(result.headers.get('cache-control'), 'private, no-store')
    assert.equal(result.headers.get('vary'), 'Authorization')
  }
})

test('Proposal 详情返回完整追溯、representation ETag 与独立决策 ETag', async () => {
  const result = await routeCall({
    method: 'GET',
    path: '/api/project-versions/pv-1/test-execution-runs/run-1/maintenance-proposals/proposal-1',
    service: maintenanceService(),
  })
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('etag'), detailEtag)
  assert.equal(result.headers.get('proposal-state-etag'), proposalEtag)
  assert.equal(result.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(result.body, detail)
  assert.deepEqual(result.permissions, [{ projectVersionId: 'pv-1', permission: 'test-execution:read' }])
})

test('accepted/rejected 决策只传 decision，decidedBy 固定来自认证 principal', async () => {
  for (const decision of ['accepted', 'rejected'] as const) {
    let decisionInput: unknown
    const decided = {
      ...proposal,
      status: decision,
      decidedBy: principal.subjectId,
      decidedAt: '2026-08-14T00:01:00.000Z',
    }
    const result = await routeCall({
      method: 'POST',
      path: '/api/project-versions/pv-1/test-execution-runs/run-1/maintenance-proposals/proposal-1/decision',
      headers: { 'if-match': proposalEtag },
      body: { decision },
      service: maintenanceService({
        async decideMaintenanceProposal(input: unknown) {
          decisionInput = input
          return decided
        },
      }),
    })
    assert.equal(result.status, 200)
    assert.deepEqual(decisionInput, {
      proposalId: proposal.id,
      decision,
      decidedBy: principal.subjectId,
    })
    assert.deepEqual(result.body, decided)
    assert.equal(result.headers.get('etag'), `"sha256-${canonicalSha256(decided)}"`)
    assert.equal(result.headers.get('proposal-state-etag'), `"sha256-${canonicalSha256(decided)}"`)
    assert.deepEqual(result.permissions, [{ projectVersionId: 'pv-1', permission: 'test-execution:maintain' }])
  }
})

test('决策缺少、malformed 或 stale If-Match 分别返回 428、400、412 且不写入', async () => {
  const cases = [
    { headers: undefined, status: 428, code: 'TEST_EXECUTION_IF_MATCH_REQUIRED' },
    { headers: { 'if-match': 'not-an-etag' }, status: 400, code: 'TEST_EXECUTION_IF_MATCH_INVALID' },
    { headers: { 'if-match': `"sha256-${'f'.repeat(64)}"` }, status: 412, code: 'TEST_EXECUTION_MAINTENANCE_PROPOSAL_STATE_CONFLICT' },
  ]
  for (const value of cases) {
    let decided = false
    await assert.rejects(
      routeCall({
        method: 'POST',
        path: '/api/project-versions/pv-1/test-execution-runs/run-1/maintenance-proposals/proposal-1/decision',
        headers: value.headers,
        body: { decision: 'accepted' },
        service: maintenanceService({ async decideMaintenanceProposal() { decided = true } }),
      }),
      (error: unknown) => error instanceof Error
        && 'status' in error
        && error.status === value.status
        && 'code' in error
        && error.code === value.code,
    )
    assert.equal(decided, false)
  }
})

test('决策 body 拒绝审批字段、正式用例内容与非法 decision', async () => {
  for (const body of [
    { decision: 'accepted', decidedBy: 'attacker' },
    { decision: 'rejected', decidedAt: '2020-01-01T00:00:00.000Z' },
    { decision: 'accepted', content: { expectedResult: '改成 PASS' } },
    { decision: 'pending' },
  ]) {
    let decided = false
    await assert.rejects(
      routeCall({
        method: 'POST',
        path: '/api/project-versions/pv-1/test-execution-runs/run-1/maintenance-proposals/proposal-1/decision',
        headers: { 'if-match': proposalEtag },
        body,
        service: maintenanceService({ async decideMaintenanceProposal() { decided = true } }),
      }),
      (error: unknown) => error instanceof Error
        && 'status' in error
        && error.status === 400,
    )
    assert.equal(decided, false)
  }
})

test('ProjectVersion、Run、Task 与 Proposal scope 不匹配均按正式 scope 授权后隐藏为 404', async () => {
  const cases = [
    {
      path: '/api/project-versions/pv-other/test-execution-runs/run-1/maintenance-proposals',
      service: maintenanceService(),
    },
    {
      path: '/api/project-versions/pv-1/test-execution-runs/run-other/tasks/task-1/maintenance-proposals',
      service: maintenanceService(),
    },
    {
      path: '/api/project-versions/pv-1/test-execution-runs/run-other/maintenance-proposals/proposal-1',
      service: maintenanceService(),
    },
    {
      path: '/api/project-versions/pv-1/test-execution-runs/run-1/maintenance-proposals/proposal-1',
      service: maintenanceService({
        async maintenanceProposalDetail() {
          return { ...detail, proposal: { ...proposal, taskId: 'task-other' } }
        },
      }),
    },
  ]
  for (const value of cases) {
    let authorized = ''
    await assert.rejects(
      routeCall({
        method: 'GET',
        path: value.path,
        service: value.service,
        onAuthorize(projectVersionId) { authorized = projectVersionId },
      }),
      (error: unknown) => error instanceof Error
        && 'status' in error
        && error.status === 404,
    )
    assert.equal(authorized, 'pv-1')
  }
})

test('前端维护 Tab、pending 筛选、If-Match 决策和 accepted-only 正式 editor 深链保持人工边界', () => {
  const taskPanel = read('../src/test-execution/ExecutionTaskPanel.tsx')
  const runPanel = read('../src/test-execution/ExecutionRunPanel.tsx')
  const page = read('../src/test-execution/TestExecutionPage.tsx')
  const api = read('../src/test-execution/api.ts')
  const hook = read('../src/test-execution/hooks/useTestExecution.ts')
  const designPage = read('../src/test-design/TestDesignPage.tsx')
  const library = read('../src/test-design/TestCaseLibraryPanel.tsx')
  const app = read('../src/App.tsx')

  assert.match(taskPanel, /tab === 'maintenance'/u)
  assert.match(taskPanel, /用例维护/u)
  assert.match(taskPanel, /接受建议/u)
  assert.match(taskPanel, /拒绝建议/u)
  assert.match(taskPanel, /proposal\.status === 'accepted'[\s\S]{0,260}打开正式用例/u)
  assert.match(taskPanel, /proposal\.status === 'rejected'[\s\S]{0,120}已拒绝/u)
  assert.match(taskPanel, /failureAttempts/u)
  assert.match(taskPanel, /postRepairAttempt/u)
  assert.match(taskPanel, /baselineLibraryVersion/u)
  assert.match(taskPanel, /修复前后 Diff/u)
  assert.match(runPanel, /status === 'pending'/u)
  assert.match(runPanel, /待确认 \{pendingMaintenanceCount\}/u)
  assert.match(page, /proposal\.taskId === task\.id && proposal\.status === 'pending'/u)
  assert.match(api, /headers: \{ 'if-match': etag \}/u)
  assert.match(api, /JSON\.stringify\(\{ decision \}\)/u)
  assert.match(hook, /已确认该测试用例需要人工维护/u)

  assert.match(page, /searchParams\.set\('testDesignEntry', 'library'\)/u)
  assert.match(page, /searchParams\.set\('libraryCaseId', caseId\)/u)
  assert.match(page, /searchParams\.delete\('executionMaintenanceProposalId'\)/u)
  assert.doesNotMatch(page, /searchParams\.set\([^\n]*(?:summary|proposedChange|caseRevision)/u)
  assert.match(designPage, /searchParams\.get\('libraryCaseId'\)/u)
  assert.match(library, /api\.loadLibraryCase\(projectId, selected\.id\)/u)
  assert.match(library, /setEditor\(result\.value\)/u)
  assert.match(library, /restoredInitialCase/u)
  assert.match(library, /onEdit\(editor, content, reason, traceability\)/u)
  assert.doesNotMatch(library, /maintenanceProposal|proposedChange|baselineCase/u)
  assert.match(app, /executionMaintenanceProposalId/u)
  assert.match(app, /testDesignEntry/u)
  assert.match(app, /libraryCaseId/u)
})

function read(path: string) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

async function routeCall(input: {
  method: string
  path: string
  body?: unknown
  headers?: Record<string, string>
  service: object
  onAuthorize?: (projectVersionId: string) => void
}) {
  const request = Object.assign(
    Readable.from(input.body === undefined ? [] : [Buffer.from(JSON.stringify(input.body), 'utf8')]),
    { headers: input.headers ?? {} },
  )
  const responseHeaders = new Map<string, string>()
  const chunks: Buffer[] = []
  const response = {
    statusCode: 0,
    setHeader(name: string, value: string | number) {
      responseHeaders.set(name.toLowerCase(), String(value))
    },
    end(value = '') {
      if (value) chunks.push(Buffer.from(String(value), 'utf8'))
    },
  }
  const permissions: Array<{ projectVersionId: string; permission: string }> = []
  const controls = {
    async authorize(
      _principal: typeof principal,
      projectVersionId: string,
      permission: string,
    ) {
      permissions.push({ projectVersionId, permission })
      input.onAuthorize?.(projectVersionId)
    },
    async canAccess() { return true },
  }
  const artifactStore: ExecutionArtifactStore = {
    async readiness() { return { ready: true } },
    async put() { throw new Error('NOT_USED') },
    async open() { throw new Error('NOT_USED') },
    async stat() { throw new Error('NOT_USED') },
  }
  const handled = await routeTestExecution(request as never, response as never, {
    method: input.method,
    url: new URL(`http://127.0.0.1${input.path}`),
    principal,
    controls: controls as never,
    service: input.service as TestExecutionService,
    artifactStore,
    resolveProjectVersion: async projectVersionId => ({
      id: projectVersionId,
      projectId: 'project-1',
      name: '测试版本',
      status: 'open',
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z',
    }),
    readiness: async () => ({ ready: true }),
    environments: () => [],
    handoffs: async () => [],
  })
  assert.equal(handled, true)
  const rawBody = Buffer.concat(chunks)
  const contentType = responseHeaders.get('content-type') ?? ''
  return {
    status: response.statusCode,
    headers: responseHeaders,
    body: contentType.includes('application/json') && rawBody.length
      ? JSON.parse(rawBody.toString('utf8')) as unknown
      : undefined,
    permissions,
  }
}
