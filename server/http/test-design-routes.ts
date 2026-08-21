import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Principal, ProjectVersionPermission } from '../domain/access-control.js'
import type { TestDesignService } from '../application/test-design-service.js'
import type { AccessControl } from './access-control.js'
import type { StateStore } from '../infrastructure/store.js'

export async function routeTestDesign(request: IncomingMessage, response: ServerResponse, context: { method: string; url: URL; principal: Principal; controls: AccessControl; service: TestDesignService; store: StateStore }) {
  const { method, url, principal, controls, service, store } = context
  if (!url.pathname.includes('test-design') && !url.pathname.includes('test-case') && !url.pathname.includes('test-suite') && !url.pathname.includes('test-execution')) return false
  const authorize = (projectVersionId: string, permission: ProjectVersionPermission) => controls.authorize(principal, projectVersionId, permission)

  const allInputs = /^\/api\/project-versions\/([^/]+)\/test-designs\/inputs$/.exec(url.pathname)
  if (allInputs && method === 'GET') { await authorize(allInputs[1], 'test-design:read'); return send(response, 200, await service.inputCandidates(allInputs[1])) }
  const inputs = /^\/api\/project-versions\/([^/]+)\/test-designs\/inputs\/(requirement-release|knowledge-assets|fixed-indexes)$/.exec(url.pathname)
  if (inputs && method === 'GET') { await authorize(inputs[1], 'test-design:read'); const candidates = await service.inputCandidates(inputs[1]); const keys = { 'requirement-release': 'requirementRelease', 'knowledge-assets': 'knowledgeAssets', 'fixed-indexes': 'fixedIndexes' } as const; return send(response, 200, candidates[keys[inputs[2] as keyof typeof keys]]) }
  const readiness = /^\/api\/project-versions\/([^/]+)\/test-designs\/agent-readiness$/.exec(url.pathname)
  if (readiness && method === 'GET') { await authorize(readiness[1], 'test-design:read'); return send(response, 200, (await service.inputCandidates(readiness[1])).agentReadiness) }
  const designs = /^\/api\/project-versions\/([^/]+)\/test-designs$/.exec(url.pathname)
  if (designs && method === 'POST') { await authorize(designs[1], 'test-design:create'); return send(response, 201, await service.createDesign(designs[1], await json(request), principal)) }
  if (designs && method === 'GET') { await authorize(designs[1], 'test-design:read'); return send(response, 200, { items: await service.listDesigns(designs[1]) }) }
  const design = /^\/api\/project-versions\/([^/]+)\/test-designs\/([^/]+)$/.exec(url.pathname)
  if (design && method === 'GET') { await authorize(design[1], 'test-design:read'); return send(response, 200, await service.getDesign(design[1], design[2])) }
  const runs = /^\/api\/project-versions\/([^/]+)\/test-designs\/([^/]+)\/runs$/.exec(url.pathname)
  if (runs && method === 'POST') { await authorize(runs[1], 'test-design:create'); return send(response, 202, await service.createRun(runs[1], runs[2], header(request, 'idempotency-key'), principal)) }
  if (runs && method === 'GET') { await authorize(runs[1], 'test-design:read'); return send(response, 200, { items: await service.listRuns(runs[1], runs[2]) }) }
  const run = /^\/api\/project-versions\/([^/]+)\/test-designs\/([^/]+)\/runs\/([^/]+)$/.exec(url.pathname)
  if (run && method === 'GET') { await authorize(run[1], 'test-design:read'); return send(response, 200, await service.getRun(run[1], run[2], run[3])) }
  const cancel = /^\/api\/project-versions\/([^/]+)\/test-designs\/([^/]+)\/runs\/([^/]+)\/cancel$/.exec(url.pathname)
  if (cancel && method === 'POST') { await authorize(cancel[1], 'test-design:cancel'); return send(response, 200, await service.cancelRun(cancel[1], cancel[2], cancel[3], principal)) }
  const fullRerun = /^\/api\/project-versions\/([^/]+)\/test-designs\/([^/]+)\/runs\/([^/]+)\/actions\/full-rerun$/.exec(url.pathname)
  if (fullRerun && method === 'POST') { await authorize(fullRerun[1], 'test-design:create'); return send(response, 202, await service.fullRerun(fullRerun[1], fullRerun[2], fullRerun[3], header(request, 'idempotency-key'), principal)) }
  const resynthesize = /^\/api\/project-versions\/([^/]+)\/test-designs\/([^/]+)\/runs\/([^/]+)\/actions\/resynthesize$/.exec(url.pathname)
  if (resynthesize && method === 'POST') { await authorize(resynthesize[1], 'test-design:edit'); return send(response, 202, await service.resynthesize(resynthesize[1], resynthesize[2], resynthesize[3])) }
  const reaudit = /^\/api\/project-versions\/([^/]+)\/test-designs\/([^/]+)\/runs\/([^/]+)\/actions\/re-audit$/.exec(url.pathname)
  if (reaudit && method === 'POST') { await authorize(reaudit[1], 'test-design:edit'); return send(response, 201, await service.reAudit(reaudit[1], reaudit[2], reaudit[3])) }

  const cases = /^\/api\/project-versions\/([^/]+)\/test-designs\/([^/]+)\/runs\/([^/]+)\/test-cases$/.exec(url.pathname)
  if (cases && method === 'GET') { await authorize(cases[1], 'test-design:read'); return send(response, 200, { items: await service.listCases(cases[1], cases[2], cases[3], { dimension: url.searchParams.get('dimension') ?? undefined, executionMethod: url.searchParams.get('executionMethod') ?? undefined, status: url.searchParams.get('status') ?? undefined }) }) }
  if (cases && method === 'POST') { await authorize(cases[1], 'test-design:edit'); const body = await json(request); return send(response, 201, await service.createCase(cases[1], cases[2], cases[3], body.content ?? body, principal)) }
  const oneCase = /^\/api\/project-versions\/([^/]+)\/test-designs\/([^/]+)\/runs\/([^/]+)\/test-cases\/([^/]+)$/.exec(url.pathname)
  if (oneCase && method === 'GET') { await authorize(oneCase[1], 'test-design:read'); const value = await service.getCase(oneCase[1], oneCase[2], oneCase[3], oneCase[4]); response.setHeader('ETag', value.etag); return send(response, 200, value) }
  if (oneCase && method === 'PATCH') { await authorize(oneCase[1], 'test-design:edit'); const value = await service.patchCase(oneCase[1], oneCase[2], oneCase[3], oneCase[4], request.headers['if-match'], await json(request) as never, principal); response.setHeader('ETag', value.etag); return send(response, 200, value) }
  if (oneCase && method === 'DELETE') { await authorize(oneCase[1], 'test-design:edit'); return send(response, 200, await service.deleteCase(oneCase[1], oneCase[2], oneCase[3], oneCase[4], principal)) }
  const caseRevisions = /^\/api\/project-versions\/([^/]+)\/test-designs\/([^/]+)\/runs\/([^/]+)\/test-cases\/([^/]+)\/revisions$/.exec(url.pathname)
  if (caseRevisions && method === 'GET') { await authorize(caseRevisions[1], 'test-design:read'); return send(response, 200, { items: await service.caseRevisions(caseRevisions[1], caseRevisions[2], caseRevisions[3], caseRevisions[4]) }) }
  const caseDiff = /^\/api\/project-versions\/([^/]+)\/test-designs\/([^/]+)\/runs\/([^/]+)\/test-cases\/([^/]+)\/diff$/.exec(url.pathname)
  if (caseDiff && method === 'GET') { await authorize(caseDiff[1], 'test-design:read'); return send(response, 200, { changes: await service.caseDiff(caseDiff[1], caseDiff[2], caseDiff[3], caseDiff[4], Number(url.searchParams.get('from')), Number(url.searchParams.get('to'))) }) }
  const caseReview = /^\/api\/project-versions\/([^/]+)\/test-designs\/([^/]+)\/runs\/([^/]+)\/test-cases\/([^/]+)\/review-actions$/.exec(url.pathname)
  if (caseReview && method === 'POST') { await authorize(caseReview[1], 'test-design:review'); return send(response, 201, await service.reviewCase(caseReview[1], caseReview[2], caseReview[3], caseReview[4], await json(request) as never, principal)) }
  const batchReview = /^\/api\/project-versions\/([^/]+)\/test-designs\/([^/]+)\/runs\/([^/]+)\/test-cases\/batch-review-actions$/.exec(url.pathname)
  if (batchReview && method === 'POST') { await authorize(batchReview[1], 'test-design:review'); return send(response, 201, await service.batchReview(batchReview[1], batchReview[2], batchReview[3], await json(request) as never, principal)) }

  const audits = /^\/api\/project-versions\/([^/]+)\/test-designs\/([^/]+)\/runs\/([^/]+)\/coverage-audits$/.exec(url.pathname)
  if (audits && method === 'GET') { await authorize(audits[1], 'test-design:read'); return send(response, 200, { items: await service.coverageAudits(audits[1], audits[2], audits[3]) }) }
  const matrix = /^\/api\/project-versions\/([^/]+)\/test-designs\/([^/]+)\/runs\/([^/]+)\/coverage-matrix$/.exec(url.pathname)
  if (matrix && method === 'GET') { await authorize(matrix[1], 'test-design:read'); const direction = url.searchParams.get('direction') === 'case_to_basis' ? 'case_to_basis' : 'basis_to_case'; return send(response, 200, { direction, relations: await service.coverageMatrix(matrix[1], matrix[2], matrix[3], direction) }) }
  const basisSource = /^\/api\/project-versions\/([^/]+)\/test-designs\/([^/]+)\/runs\/([^/]+)\/basis-items\/([^/]+)\/source$/.exec(url.pathname)
  if (basisSource && method === 'GET') { await authorize(basisSource[1], 'test-design:read'); return send(response, 200, await service.basisSource(basisSource[1], basisSource[2], basisSource[3], basisSource[4])) }
  const retrievalSource = /^\/api\/project-versions\/([^/]+)\/test-designs\/([^/]+)\/runs\/([^/]+)\/retrieval-hits\/([^/]+)\/source$/.exec(url.pathname)
  if (retrievalSource && method === 'GET') { await authorize(retrievalSource[1], 'test-design:read'); return send(response, 200, await service.retrievalSource(retrievalSource[1], retrievalSource[2], retrievalSource[3], retrievalSource[4])) }
  const historicalSource = /^\/api\/project-versions\/([^/]+)\/test-designs\/([^/]+)\/runs\/([^/]+)\/historical-cases\/([^/]+)$/.exec(url.pathname)
  if (historicalSource && method === 'GET') { await authorize(historicalSource[1], 'test-design:read'); return send(response, 200, await service.historicalSource(historicalSource[1], historicalSource[2], historicalSource[3], historicalSource[4])) }
  const proposals = /^\/api\/project-versions\/([^/]+)\/test-designs\/([^/]+)\/runs\/([^/]+)\/case-change-proposals$/.exec(url.pathname)
  if (proposals && method === 'GET') { await authorize(proposals[1], 'test-design:read'); return send(response, 200, { items: await service.listCaseChangeProposals(proposals[1], proposals[2], proposals[3], url.searchParams.get('operation') ?? undefined) }) }
  const proposalDecision = /^\/api\/project-versions\/([^/]+)\/test-designs\/([^/]+)\/runs\/([^/]+)\/case-change-proposals\/([^/]+)\/decisions$/.exec(url.pathname)
  if (proposalDecision && method === 'POST') { await authorize(proposalDecision[1], 'test-design:review'); return send(response, 201, await service.decideCaseChangeProposal(proposalDecision[1], proposalDecision[2], proposalDecision[3], proposalDecision[4], await json(request) as never, principal)) }
  const publishLibrary = /^\/api\/project-versions\/([^/]+)\/test-designs\/([^/]+)\/runs\/([^/]+)\/test-case-library-versions$/.exec(url.pathname)
  if (publishLibrary && method === 'POST') { await authorize(publishLibrary[1], 'test-design:publish'); return send(response, 201, await service.publishLibraryVersion(publishLibrary[1], publishLibrary[2], publishLibrary[3], await json(request) as never, principal)) }
  const handoff = /^\/api\/test-execution-handoffs\/([^/]+)$/.exec(url.pathname)
  if (handoff && method === 'GET') { const value = await service.getHandoff(handoff[1]); await authorize(value.projectVersionId, 'test-design:read'); return send(response, 200, value) }

  const libraryHandoffs = /^\/api\/project-versions\/([^/]+)\/test-case-library-versions\/([^/]+)\/execution-handoffs$/.exec(url.pathname)
  if (libraryHandoffs && method === 'POST') { await authorize(libraryHandoffs[1], 'test-design:publish'); return send(response, 201, await service.createLibraryHandoff(libraryHandoffs[1], libraryHandoffs[2], await json(request) as never, principal)) }
  if (libraryHandoffs && method === 'GET') { await authorize(libraryHandoffs[1], 'test-design:read'); return send(response, 200, { items: await service.listLibraryHandoffs(libraryHandoffs[1], libraryHandoffs[2]) }) }
  const projectLibraryHandoffs = /^\/api\/project-versions\/([^/]+)\/test-case-library-handoffs$/.exec(url.pathname)
  if (projectLibraryHandoffs && method === 'GET') { await authorize(projectLibraryHandoffs[1], 'test-design:read'); return send(response, 200, { items: await service.listLibraryHandoffs(projectLibraryHandoffs[1], url.searchParams.get('libraryVersionId') ?? undefined) }) }

  const suites = /^\/api\/projects\/([^/]+)\/test-suite-versions$/.exec(url.pathname)
  if (suites && method === 'GET') { await authorizeProject(suites[1], principal, controls, store); return send(response, 200, { items: await service.listSuites(suites[1], url.searchParams.get('suiteType') ?? undefined) }) }
  const suite = /^\/api\/projects\/([^/]+)\/test-suite-versions\/([^/]+)$/.exec(url.pathname)
  if (suite && method === 'GET' && suite[2] !== 'diff') { await authorizeProject(suite[1], principal, controls, store); return send(response, 200, await service.getSuite(suite[1], suite[2])) }
  const libraryCases = /^\/api\/projects\/([^/]+)\/test-case-library$/.exec(url.pathname)
  if (libraryCases && method === 'GET') { await authorizeProjectPermission(libraryCases[1], 'test-design:read', principal, controls, store); return send(response, 200, { items: await service.listLibraryCases(libraryCases[1], { domain: url.searchParams.get('domain') ?? undefined, dimension: url.searchParams.get('dimension') ?? undefined, executionMethod: url.searchParams.get('executionMethod') ?? undefined, priority: url.searchParams.get('priority') ?? undefined, status: url.searchParams.get('status') ?? undefined, tag: url.searchParams.get('tag') ?? undefined }) }) }
  if (libraryCases && method === 'POST') { await authorizeProjectPermission(libraryCases[1], 'test-design:edit', principal, controls, store); const body = await json(request); return send(response, 201, await service.createLibraryCase(libraryCases[1], body.content, body.changeReason, principal)) }
  const libraryCase = /^\/api\/projects\/([^/]+)\/test-case-library\/([^/]+)$/.exec(url.pathname)
  if (libraryCase && method === 'GET') { await authorizeProjectPermission(libraryCase[1], 'test-design:read', principal, controls, store); const value = await service.getLibraryCase(libraryCase[1], libraryCase[2]); response.setHeader('ETag', value.etag); return send(response, 200, value) }
  if (libraryCase && method === 'PATCH') { await authorizeProjectPermission(libraryCase[1], 'test-design:edit', principal, controls, store); const body = await json(request); const value = await service.editLibraryCase(libraryCase[1], libraryCase[2], request.headers['if-match'], body.content, body.changeReason, principal, body.traceability); response.setHeader('ETag', value.etag); return send(response, 200, value) }
  if (libraryCase && method === 'DELETE') { await authorizeProjectPermission(libraryCase[1], 'test-design:edit', principal, controls, store); const body = await json(request); return send(response, 200, await service.deprecateLibraryCase(libraryCase[1], libraryCase[2], request.headers['if-match'], body.changeReason, principal)) }
  const copyLibraryCase = /^\/api\/projects\/([^/]+)\/test-case-library\/([^/]+)\/copy$/.exec(url.pathname)
  if (copyLibraryCase && method === 'POST') { await authorizeProjectPermission(copyLibraryCase[1], 'test-design:edit', principal, controls, store); return send(response, 201, await service.copyLibraryCase(copyLibraryCase[1], copyLibraryCase[2], await json(request) as never, principal)) }
  const libraryCaseDiff = /^\/api\/projects\/([^/]+)\/test-case-library\/([^/]+)\/diff$/.exec(url.pathname)
  if (libraryCaseDiff && method === 'GET') { await authorizeProjectPermission(libraryCaseDiff[1], 'test-design:read', principal, controls, store); return send(response, 200, { changes: await service.libraryCaseDiff(libraryCaseDiff[1], libraryCaseDiff[2], Number(url.searchParams.get('from')), Number(url.searchParams.get('to'))) }) }
  const libraryVersions = /^\/api\/projects\/([^/]+)\/test-case-library-versions$/.exec(url.pathname)
  if (libraryVersions && method === 'GET') { await authorizeProjectPermission(libraryVersions[1], 'test-design:read', principal, controls, store); return send(response, 200, { items: await service.listLibraryVersions(libraryVersions[1], url.searchParams.get('sourceRunId') ?? undefined) }) }
  const libraryVersion = /^\/api\/projects\/([^/]+)\/test-case-library-versions\/([^/]+)$/.exec(url.pathname)
  if (libraryVersion && method === 'GET' && libraryVersion[2] !== 'diff') { await authorizeProjectPermission(libraryVersion[1], 'test-design:read', principal, controls, store); return send(response, 200, await service.getLibraryVersion(libraryVersion[1], libraryVersion[2])) }
  const libraryVersionDiff = /^\/api\/projects\/([^/]+)\/test-case-library-versions\/diff$/.exec(url.pathname)
  if (libraryVersionDiff && method === 'GET') { await authorizeProjectPermission(libraryVersionDiff[1], 'test-design:read', principal, controls, store); return send(response, 200, { changes: await service.compareLibraryVersions(libraryVersionDiff[1], String(url.searchParams.get('from')), String(url.searchParams.get('to'))) }) }
  const suiteDrafts = /^\/api\/projects\/([^/]+)\/test-suite-drafts$/.exec(url.pathname)
  if (suiteDrafts && method === 'GET') { await authorizeProjectPermission(suiteDrafts[1], 'test-design:read', principal, controls, store); return send(response, 200, { items: await service.listSuiteDrafts(suiteDrafts[1]) }) }
  if (suiteDrafts && method === 'POST') { await authorizeProjectPermission(suiteDrafts[1], 'test-design:edit', principal, controls, store); return send(response, 201, await service.createSuiteDraft(suiteDrafts[1], await json(request), principal)) }
  const suiteDraft = /^\/api\/projects\/([^/]+)\/test-suite-drafts\/([^/]+)$/.exec(url.pathname)
  if (suiteDraft && method === 'GET') { await authorizeProjectPermission(suiteDraft[1], 'test-design:read', principal, controls, store); const value = await service.getSuiteDraft(suiteDraft[1], suiteDraft[2]); response.setHeader('ETag', value.etag); return send(response, 200, value) }
  if (suiteDraft && method === 'PUT') { await authorizeProjectPermission(suiteDraft[1], 'test-design:edit', principal, controls, store); const value = await service.updateSuiteDraft(suiteDraft[1], suiteDraft[2], request.headers['if-match'], await json(request), principal); response.setHeader('ETag', value.etag); return send(response, 200, value) }
  const publishSuite = /^\/api\/projects\/([^/]+)\/test-suite-drafts\/([^/]+)\/publish$/.exec(url.pathname)
  if (publishSuite && method === 'POST') { await authorizeProjectPermission(publishSuite[1], 'test-design:publish', principal, controls, store); return send(response, 201, await service.publishSuiteDraft(publishSuite[1], publishSuite[2], request.headers['if-match'], principal)) }
  const suiteDiff = /^\/api\/projects\/([^/]+)\/test-suite-versions\/diff$/.exec(url.pathname)
  if (suiteDiff && method === 'GET') { await authorizeProjectPermission(suiteDiff[1], 'test-design:read', principal, controls, store); return send(response, 200, { changes: await service.compareSuiteVersions(suiteDiff[1], String(url.searchParams.get('from')), String(url.searchParams.get('to'))) }) }
  const deprecateSuite = /^\/api\/projects\/([^/]+)\/test-suite-versions\/([^/]+)\/deprecate$/.exec(url.pathname)
  if (deprecateSuite && method === 'POST') { await authorizeProjectPermission(deprecateSuite[1], 'test-design:publish', principal, controls, store); return send(response, 200, await service.deprecateSuiteVersion(deprecateSuite[1], deprecateSuite[2], principal)) }
  return false
}

async function authorizeProject(projectId: string, principal: Principal, controls: AccessControl, store: StateStore) {
  const versions = (await store.snapshot()).projectVersions.filter(item => item.projectId === projectId)
  for (const version of versions) if (await controls.canAccess(principal, version.id, 'test-design:read')) return
  await controls.authorize(principal, versions[0]?.id ?? `project:${projectId}`, 'test-design:read')
}
async function authorizeProjectPermission(projectId: string, permission: ProjectVersionPermission, principal: Principal, controls: AccessControl, store: StateStore) { const versions = (await store.snapshot()).projectVersions.filter(item => item.projectId === projectId); for (const version of versions) if (await controls.canAccess(principal, version.id, permission)) return; await controls.authorize(principal, versions[0]?.id ?? `project:${projectId}`, permission) }

function header(request: IncomingMessage, name: string) { const value = request.headers[name]; return Array.isArray(value) ? value[0] ?? '' : value ?? '' }
async function json(request: IncomingMessage) { const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length; if (size > 10 * 1024 * 1024) throw new Error('REQUEST_TOO_LARGE'); chunks.push(buffer) } const text = Buffer.concat(chunks).toString('utf8'); return text ? JSON.parse(text) as Record<string, any> : {} }
function send(response: ServerResponse, status: number, value: unknown) { response.statusCode = status; response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.setHeader('Access-Control-Allow-Origin', '*'); response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS'); response.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, idempotency-key, if-match'); response.setHeader('Access-Control-Expose-Headers', 'etag, content-disposition'); response.end(value == null ? '' : JSON.stringify(value)); return true }
