import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  TestReportService,
  TestReportServiceError,
} from '../application/test-report-service.js'
import type { Principal, ProjectVersionPermission } from '../domain/access-control.js'
import type { ProjectVersion } from '../domain/types.js'
import type { AccessControl } from './access-control.js'

export interface TestReportRouteContext {
  method: string
  url: URL
  principal: Principal
  controls: AccessControl
  service?: TestReportService
  resolveProjectVersion(projectVersionId: string): Promise<ProjectVersion | null>
}

export async function routeTestReport(
  request: IncomingMessage,
  response: ServerResponse,
  context: TestReportRouteContext,
) {
  const { method, url } = context
  if (!url.pathname.includes('/test-reports')) return false
  if (method !== 'GET') return false

  const list = /^\/api\/project-versions\/([^/]+)\/test-reports$/.exec(url.pathname)
  if (list) {
    const projectVersion = await scopedProjectVersion(
      context,
      list[1],
      'test-execution:read',
    )
    const limit = url.searchParams.has('limit')
      ? Number(url.searchParams.get('limit'))
      : 50
    return sendJson(
      response,
      200,
      await requireService(context.service).listReports(projectVersion.id, limit),
    )
  }

  const detail = /^\/api\/project-versions\/([^/]+)\/test-reports\/([^/]+)$/.exec(url.pathname)
  if (detail) {
    const service = requireService(context.service)
    await scopedRun(
      service,
      context,
      detail[1],
      detail[2],
      'test-execution:read',
    )
    const report = await service.getReport(detail[2])
    reportHeaders(response, report.reportSha256)
    if (conditionalNotModified(request, response, reportEtag(report.reportSha256))) return true
    return sendJson(response, 200, report)
  }

  const jsonExport = /^\/api\/project-versions\/([^/]+)\/test-reports\/([^/]+)\/export\.json$/.exec(url.pathname)
  if (jsonExport) {
    const service = requireService(context.service)
    await scopedRun(
      service,
      context,
      jsonExport[1],
      jsonExport[2],
      'test-execution:download',
    )
    const exported = await service.exportJson(jsonExport[2])
    reportHeaders(response, exported.report.reportSha256)
    if (conditionalNotModified(
      request,
      response,
      reportEtag(exported.report.reportSha256),
    )) return true
    return sendBytes(response, 200, exported.body, {
      contentType: 'application/json; charset=utf-8',
      fileName: `test-report-${safeFileName(exported.report.run.id)}.json`,
    })
  }

  const markdownExport = /^\/api\/project-versions\/([^/]+)\/test-reports\/([^/]+)\/report\.md$/.exec(url.pathname)
  if (markdownExport) {
    const service = requireService(context.service)
    await scopedRun(
      service,
      context,
      markdownExport[1],
      markdownExport[2],
      'test-execution:download',
    )
    const exported = await service.exportMarkdown(markdownExport[2])
    reportHeaders(response, exported.report.reportSha256)
    if (conditionalNotModified(request, response, representationEtag(exported.sha256))) return true
    return sendBytes(response, 200, exported.body, {
      contentType: 'text/markdown; charset=utf-8',
      fileName: `test-report-${safeFileName(exported.report.run.id)}.md`,
    })
  }

  return false
}

async function scopedProjectVersion(
  context: TestReportRouteContext,
  projectVersionId: string,
  permission: ProjectVersionPermission,
) {
  const projectVersion = await context.resolveProjectVersion(projectVersionId)
  if (!projectVersion) {
    throw new TestReportServiceError(
      'TEST_REPORT_PROJECT_VERSION_NOT_FOUND',
      '项目版本不存在',
      404,
    )
  }
  await context.controls.authorize(
    context.principal,
    projectVersion.id,
    permission,
  )
  return projectVersion
}

async function scopedRun(
  service: TestReportService,
  context: TestReportRouteContext,
  projectVersionId: string,
  runId: string,
  permission: ProjectVersionPermission,
) {
  const run = await service.getRun(runId)
  await context.controls.authorize(
    context.principal,
    run.projectVersionId,
    permission,
  )
  if (run.projectVersionId !== projectVersionId) {
    throw new TestReportServiceError(
      'TEST_REPORT_RUN_NOT_FOUND',
      '测试报告对应的执行 Run 不存在',
      404,
    )
  }
  return run
}

function requireService(service?: TestReportService) {
  if (!service) {
    throw new TestReportServiceError(
      'TEST_REPORT_POSTGRES_UNAVAILABLE',
      '测试报告要求 PostgreSQL 正式执行存储',
      503,
    )
  }
  return service
}

function conditionalNotModified(
  request: IncomingMessage,
  response: ServerResponse,
  etag: string,
) {
  response.setHeader('ETag', etag)
  const candidates = String(request.headers['if-none-match'] ?? '')
    .split(',')
    .map(value => value.trim())
  if (!candidates.includes(etag) && !candidates.includes('*')) return false
  response.statusCode = 304
  reportCacheHeaders(response)
  cors(response)
  response.end()
  return true
}

function reportHeaders(response: ServerResponse, reportSha256: string) {
  response.setHeader('X-Report-SHA256', reportSha256)
  reportCacheHeaders(response)
  response.setHeader('X-Content-Type-Options', 'nosniff')
}

function reportCacheHeaders(response: ServerResponse) {
  response.setHeader('Cache-Control', 'private, no-store')
  response.setHeader('Vary', 'Authorization')
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
) {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  cors(response)
  response.end(value == null ? '' : JSON.stringify(value))
  return true
}

function sendBytes(
  response: ServerResponse,
  status: number,
  body: string,
  options: { contentType: string; fileName: string },
) {
  const bytes = Buffer.from(body, 'utf8')
  response.statusCode = status
  response.setHeader('Content-Type', options.contentType)
  response.setHeader('Content-Length', bytes.length)
  response.setHeader('Content-Disposition', `attachment; filename="${options.fileName}"`)
  cors(response)
  response.end(bytes)
  return true
}

function reportEtag(sha256: string) {
  return `"test-report-sha256-${sha256}"`
}

function representationEtag(sha256: string) {
  return `"sha256-${sha256}"`
}

function safeFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/gu, '_').slice(0, 120) || 'run'
}

function cors(response: ServerResponse) {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  response.setHeader(
    'Access-Control-Allow-Headers',
    'authorization, if-none-match',
  )
  response.setHeader(
    'Access-Control-Expose-Headers',
    'etag, x-report-sha256, content-disposition, content-length',
  )
}
