import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PassThrough, Readable } from 'node:stream'
import test from 'node:test'
import { canonicalJson } from '../server/application/canonical-json.js'
import { TestReportService } from '../server/application/test-report-service.js'
import { routeTestReport } from '../server/http/test-report-routes.js'
import { reportSourceFixture, reportSourceReader } from './test-report-fixture.js'

const principal = { subjectId: 'operator-1', displayName: '报告查看者' }
const service = new TestReportService(reportSourceReader())

test('报告列表解析 limit、授权正式 ProjectVersion 并返回 Run 索引', async () => {
  const result = await routeCall({
    path: '/api/project-versions/pv-1/test-reports?limit=1',
    service,
  })
  assert.equal(result.status, 200)
  assert.equal((result.body as { items: unknown[] }).items.length, 1)
  assert.deepEqual(result.permissions, [{
    projectVersionId: 'pv-1',
    permission: 'test-execution:read',
  }])
})

test('报告列表在 PostgreSQL Service 不可用时返回明确 503', async () => {
  await assert.rejects(
    routeCall({ path: '/api/project-versions/pv-1/test-reports' }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'TEST_REPORT_POSTGRES_UNAVAILABLE'
      && 'status' in error
      && error.status === 503,
  )
})

test('报告详情先按真实 Run 授权，再校验 URL ProjectVersion scope', async () => {
  let authorized = ''
  await assert.rejects(
    routeCall({
      path: '/api/project-versions/pv-other/test-reports/run-report-1',
      service,
      onAuthorize(projectVersionId) { authorized = projectVersionId },
    }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'TEST_REPORT_RUN_NOT_FOUND'
      && 'status' in error
      && error.status === 404,
  )
  assert.equal(authorized, 'pv-1')
})

test('报告详情返回稳定 ETag、报告 Hash 和脱敏 JSON', async () => {
  const result = await routeCall({
    path: '/api/project-versions/pv-1/test-reports/run-report-1',
    service,
  })
  const report = result.body as {
    schemaVersion: string
    reportSha256: string
    overview: { maintenanceProposalCount: number; pendingMaintenanceCount: number }
    maintenanceProposals: Array<{ taskId: string; status: string }>
  }
  assert.equal(result.status, 200)
  assert.equal(report.schemaVersion, 'test-execution-report/v2')
  assert.equal(report.overview.maintenanceProposalCount, 1)
  assert.equal(report.overview.pendingMaintenanceCount, 1)
  assert.equal(report.maintenanceProposals.length, 1)
  assert.deepEqual(
    report.maintenanceProposals.map(item => ({ taskId: item.taskId, status: item.status })),
    [{ taskId: 'task-3', status: 'pending' }],
  )
  assert.equal(result.headers.get('etag'), `"test-report-sha256-${report.reportSha256}"`)
  assert.equal(result.headers.get('x-report-sha256'), report.reportSha256)
  assert.equal(result.headers.get('cache-control'), 'private, no-store')
  assert.equal(result.headers.get('vary'), 'Authorization')
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(result.permissions, [{ projectVersionId: 'pv-1', permission: 'test-execution:read' }])
  assert.doesNotMatch(result.rawBody.toString('utf8'), /storagePath|private\/objects/u)
})

test('If-None-Match 对详情和两种导出返回 304 且保留安全 Header', async () => {
  const detail = await routeCall({
    path: '/api/project-versions/pv-1/test-reports/run-report-1',
    service,
  })
  const detail304 = await routeCall({
    path: '/api/project-versions/pv-1/test-reports/run-report-1',
    headers: { 'if-none-match': detail.headers.get('etag')! },
    service,
  })
  assert.equal(detail304.status, 304)
  assert.equal(detail304.rawBody.length, 0)
  assert.equal(detail304.headers.get('x-report-sha256'), detail.headers.get('x-report-sha256'))
  assert.equal(detail304.headers.get('x-content-type-options'), 'nosniff')

  for (const suffix of ['export.json', 'report.md']) {
    const first = await routeCall({
      path: `/api/project-versions/pv-1/test-reports/run-report-1/${suffix}`,
      service,
    })
    const notModified = await routeCall({
      path: `/api/project-versions/pv-1/test-reports/run-report-1/${suffix}`,
      headers: { 'if-none-match': first.headers.get('etag')! },
      service,
    })
    assert.equal(notModified.status, 304)
    assert.equal(notModified.rawBody.length, 0)
    assert.equal(notModified.headers.get('x-report-sha256'), first.headers.get('x-report-sha256'))
  }
})

test('JSON 导出发送 canonical UTF-8 字节并使用 download 权限', async () => {
  const result = await routeCall({
    path: '/api/project-versions/pv-1/test-reports/run-report-1/export.json',
    service,
  })
  const report = await service.getReport('run-report-1')
  assert.equal(result.status, 200)
  assert.equal(result.rawBody.toString('utf8'), canonicalJson(report))
  assert.equal(result.headers.get('content-length'), String(result.rawBody.length))
  assert.equal(result.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(result.headers.get('content-disposition'), 'attachment; filename="test-report-run-report-1.json"')
  assert.deepEqual(result.permissions, [{ projectVersionId: 'pv-1', permission: 'test-execution:download' }])
})

test('Markdown 导出 ETag 绑定实际表示字节并正确计算 UTF-8 长度', async () => {
  const result = await routeCall({
    path: '/api/project-versions/pv-1/test-reports/run-report-1/report.md',
    service,
  })
  const body = result.rawBody.toString('utf8')
  const sha256 = createHash('sha256').update(result.rawBody).digest('hex')
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('etag'), `"sha256-${sha256}"`)
  assert.equal(result.headers.get('content-length'), String(Buffer.byteLength(body, 'utf8')))
  assert.equal(result.headers.get('content-type'), 'text/markdown; charset=utf-8')
  assert.equal(result.headers.get('content-disposition'), 'attachment; filename="test-report-run-report-1.md"')
  assert.match(body, /失败 \\| &lt;script&gt;<br>路径\\\\名称/u)
  assert.match(body, /## 用例维护建议/u)
  assert.match(body, /待确认维护建议 \\| 1/u)
  assert.match(body, /不会自动修改正式 TestCase/u)
  assert.doesNotMatch(body, /storagePath|private\/objects/u)
})

test('不存在的正式 ProjectVersion 在列表授权前返回 404', async () => {
  let authorized = false
  await assert.rejects(
    routeCall({
      path: '/api/project-versions/missing/test-reports',
      service,
      resolveProjectVersion: async () => null,
      onAuthorize() { authorized = true },
    }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'TEST_REPORT_PROJECT_VERSION_NOT_FOUND'
      && 'status' in error
      && error.status === 404,
  )
  assert.equal(authorized, false)
})

test('报告 GET 仅调用只读 source reader 方法', async () => {
  const source = reportSourceFixture()
  const calls: string[] = []
  const readOnlyService = new TestReportService({
    async listRuns() { calls.push('listRuns'); return [source.run] },
    async getRun() { calls.push('getRun'); return source.run },
    async getRunReportSource() { calls.push('getRunReportSource'); return source },
  })
  await routeCall({
    path: '/api/project-versions/pv-1/test-reports/run-report-1',
    service: readOnlyService,
  })
  assert.deepEqual(calls, ['getRun', 'getRunReportSource'])
})

async function routeCall(input: {
  path: string
  headers?: Record<string, string>
  service?: TestReportService
  resolveProjectVersion?: (projectVersionId: string) => Promise<{
    id: string
    projectId: string
    name: string
    status: 'open'
    createdAt: string
    updatedAt: string
  } | null>
  onAuthorize?: (projectVersionId: string) => void
}) {
  const request = Object.assign(Readable.from([]), { headers: input.headers ?? {} })
  const responseHeaders = new Map<string, string>()
  const chunks: Buffer[] = []
  const response = Object.assign(new PassThrough(), {
    statusCode: 0,
    setHeader(name: string, value: string | number) {
      responseHeaders.set(name.toLowerCase(), String(value))
    },
  })
  response.on('data', chunk => chunks.push(Buffer.from(chunk)))
  const permissions: Array<{ projectVersionId: string; permission: string }> = []
  const handled = await routeTestReport(request as never, response as never, {
    method: 'GET',
    url: new URL(`http://127.0.0.1${input.path}`),
    principal,
    service: input.service,
    controls: {
      async authorize(_principal, projectVersionId, permission) {
        permissions.push({ projectVersionId, permission })
        input.onAuthorize?.(projectVersionId)
      },
      async canAccess() { return true },
    },
    resolveProjectVersion: input.resolveProjectVersion ?? (async projectVersionId => ({
      id: projectVersionId,
      projectId: 'project-1',
      name: '测试版本',
      status: 'open',
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z',
    })),
  })
  assert.equal(handled, true)
  await new Promise<void>(resolve => response.once('end', resolve))
  const rawBody = Buffer.concat(chunks)
  const contentType = responseHeaders.get('content-type') ?? ''
  return {
    status: response.statusCode,
    headers: responseHeaders,
    rawBody,
    body: contentType.includes('application/json') && rawBody.length
      ? JSON.parse(rawBody.toString('utf8')) as unknown
      : undefined,
    permissions,
  }
}
