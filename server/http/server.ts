import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentConfigurationScene, AiResourceKind, AssetType, KnowledgeConfig } from '../domain/types.js'
import { ForbiddenError, UnauthenticatedError, type Principal, type ProjectVersionPermission } from '../domain/access-control.js'
import type { AgentConfigurationInput } from '../application/agent-configuration-service.js'
import { accessControl, agentConfigurationService, agentUnderTestService, aiResourceService, localModelRuntime, modelService, piAgentRuntime, planningWorkflowService, projectVersionService, rawDocumentStore, requirementAnalysisService, reviewGovernanceService, service, stateStore, testDesignService, testExecutionAgentRuntime, testExecutionService, testExecutionStore, testReportService, usingPostgres } from '../runtime.js'
import type { AccessControl } from './access-control.js'
import { MAX_SKILL_ARCHIVE_BYTES } from '../infrastructure/skill-package-store.js'
import { applicationRoot } from '../infrastructure/runtime-paths.js'
import { routeTestDesign } from './test-design-routes.js'
import { TestDesignError } from '../application/test-design-validation.js'
import { TestExecutionServiceError } from '../application/test-execution-service.js'
import { TestExecutionValidationError } from '../application/test-execution-validation.js'
import { handleTestExecutionRoute } from './test-execution-routes.js'
import { TestReportServiceError } from '../application/test-report-service.js'
import { routeTestReport } from './test-report-routes.js'
import { AgentUnderTestServiceError, type AgentUnderTestInput } from '../application/agent-under-test-service.js'

const webRoot = resolve(applicationRoot, 'dist')

export { agentConfigurationService, agentUnderTestService, aiResourceService, localModelRuntime, modelService, planningWorkflowService, projectVersionService, rawDocumentStore, requirementAnalysisService, reviewGovernanceService, service, stateStore, testDesignService, testExecutionService, testExecutionStore, testReportService }

export async function start(port = Number(process.env.PORT ?? 8787), controls: AccessControl = accessControl) {
  await service.initialize()
  await aiResourceService.initialize()
  const server = createServer(async (request, response) => {
    try { await route(request, response, controls) }
    catch (error) {
      const status = error instanceof UnauthenticatedError
        ? 401
        : error instanceof ForbiddenError
          ? 403
          : error instanceof TestDesignError
            ? error.status
            : error instanceof TestExecutionServiceError
              ? error.status
              : error instanceof TestReportServiceError
                ? error.status
                : error instanceof AgentUnderTestServiceError
                  ? error.status
                : error instanceof TestExecutionValidationError
                  ? 422
                  : 400
      const structured = error instanceof TestDesignError
        || error instanceof TestExecutionServiceError
        || error instanceof TestReportServiceError
        || error instanceof AgentUnderTestServiceError
        || error instanceof TestExecutionValidationError
      send(response, status, structured
        ? { code: error.code, message: error.message.replace(/^[A-Z][A-Z0-9_]+:\s*/u, ''), details: error.details }
        : { error: error instanceof Error ? error.message : '未知错误' })
    }
  })
  installAwaitedShutdown(server)
  return new Promise<typeof server>((resolvePromise, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', async () => {
      server.off('error', onError)
      try {
        const recovered = await requirementAnalysisService.recoverInterruptedRuns()
        if (recovered) console.warn(`已将 ${recovered} 个因服务重启中断的需求分析运行标记为失败`)
        resolvePromise(server)
      } catch (error) {
        server.close()
        reject(error)
      }
    })
  })
}

async function route(request: IncomingMessage, response: ServerResponse, controls: AccessControl) {
  const method = request.method ?? 'GET'; const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (method === 'OPTIONS') return send(response, 204, null)
  if (method === 'GET' && url.pathname === '/api/health') return send(response, 200, { status: 'ok' })
  const principal = await controls.authenticate(request).catch(() => { throw new UnauthenticatedError() })
  const agentConfiguration = /^\/api\/agent-configurations\/(planning|test-execution)(?:\/(draft|publish))?$/.exec(url.pathname)
  if (agentConfiguration) {
    const scene = agentConfigurationScene(agentConfiguration[1])
    if (method === 'GET' && !agentConfiguration[2]) return send(response, 200, await agentConfigurationService.get(scene))
    if (method === 'PUT' && agentConfiguration[2] === 'draft') return send(response, 200, await agentConfigurationService.save(scene, await json(request) as unknown as AgentConfigurationInput))
    if (method === 'POST' && agentConfiguration[2] === 'publish') {
      const body = await json(request)
      return send(response, 201, await agentConfigurationService.publish(scene, { agentKey: String(body.agentKey) as AgentConfigurationInput['agentKey'], revision: Number(body.revision), publishedBy: principal.displayName }))
    }
  }
  if (await handleTestExecutionRoute({
    method,
    url,
    request,
    response,
    principal,
    controls,
    service: testExecutionService,
    resolveProjectVersion: loadProjectVersion,
    readiness: async () => testExecutionService
      ? testExecutionService.readiness()
      : unavailableTestExecutionReadiness(),
    handoffs: async projectVersionId =>
      testDesignService.listLibraryHandoffs(projectVersionId),
  })) return
  if (await routeTestReport(request, response, {
    method,
    url,
    principal,
    controls,
    service: testReportService,
    resolveProjectVersion: loadProjectVersion,
  })) return
  if (await routeTestDesign(request, response, { method, url, principal, controls, service: testDesignService, store: stateStore })) return
  const requireProjectVersion = async (projectVersionId: string, permission: ProjectVersionPermission) => {
    await controls.authorize(principal, projectVersionId, permission)
  }
  const requireRun = async (runId: string, permission: ProjectVersionPermission) => {
    const run = await loadRun(runId)
    await requireProjectVersion(run.projectVersionId, permission)
    return run
  }
  if (method === 'GET' && url.pathname === '/api/local-models') return send(response, 200, localModelRuntime.statuses())
  if (method === 'GET' && url.pathname === '/api/local-model/status') return send(response, 200, localModelRuntime.status())
  if (method === 'POST' && url.pathname === '/api/local-model/start') { const body = await json(request); return send(response, 202, localModelRuntime.start(String(body.model ?? ''))) }
  if (method === 'POST' && url.pathname === '/api/local-model/stop') { const body = await json(request); return send(response, 200, await localModelRuntime.stop(String(body.model ?? ''))) }
  if (method === 'GET' && url.pathname === '/api/model-sources') return send(response, 200, await modelService.listSources())
  if (method === 'PUT' && url.pathname === '/api/model-sources') return send(response, 200, await modelService.replaceSources(await json(request)))
  if (method === 'POST' && url.pathname === '/api/model-sources') return send(response, 201, await modelService.createSource(await json(request)))
  if (method === 'POST' && url.pathname === '/api/model-sources/discover') return send(response, 200, await modelService.discover(await json(request)))
  if (method === 'GET' && url.pathname === '/api/models') {
    const sources = await modelService.listSources()
    const sourceId = url.searchParams.get('sourceId')
    return send(response, 200, sources.filter(source => !sourceId || source.id === sourceId).flatMap(source => source.models.map(model => ({ ...model, sourceId: source.id, sourceName: source.name, providerType: source.providerType }))))
  }
  if (method === 'GET' && url.pathname === '/api/ai-resources') return send(response, 200, await aiResourceService.list())
  if (method === 'POST' && url.pathname === '/api/ai-resources/skill-package') return send(response, 201, await aiResourceService.createSkillPackage(await json(request, Math.ceil(MAX_SKILL_ARCHIVE_BYTES * 4 / 3) + 1024 * 1024)))
  const aiResourceCollection = /^\/api\/ai-resources\/(mcp|skill|tool)$/.exec(url.pathname)
  if (method === 'POST' && aiResourceCollection) return send(response, 201, await aiResourceService.create(aiResourceCollection[1] as AiResourceKind, await json(request)))
  const aiResource = /^\/api\/ai-resources\/(mcp|skill|tool)\/([^/]+)$/.exec(url.pathname)
  if (method === 'PUT' && aiResource) return send(response, 200, await aiResourceService.update(aiResource[1] as AiResourceKind, aiResource[2], await json(request)))
  if (method === 'DELETE' && aiResource) return send(response, 200, await aiResourceService.delete(aiResource[1] as AiResourceKind, aiResource[2]))
  const toolSource = /^\/api\/ai-resources\/tool\/([^/]+)\/source$/.exec(url.pathname)
  if (method === 'GET' && toolSource) return send(response, 200, await aiResourceService.source(toolSource[1]))
  const agentConfigurationVersion = /^\/api\/agent-configuration-versions\/([^/]+)$/.exec(url.pathname)
  if (method === 'GET' && agentConfigurationVersion) return send(response, 200, await agentConfigurationService.getVersion(agentConfigurationVersion[1]))
  if (method === 'GET' && url.pathname === '/api/planning-agent/profile') {
    return send(response, 200, await planningWorkflowService.profile())
  }
  const planningWorkflow = /^\/api\/project-versions\/([^/]+)\/planning-workflow$/.exec(url.pathname)
  if (method === 'GET' && planningWorkflow) {
    await requireProjectVersion(planningWorkflow[1], 'project-version:read')
    return send(response, 200, await planningWorkflowService.workflow(planningWorkflow[1]))
  }
  const planningContext = /^\/api\/project-versions\/([^/]+)\/planning-context$/.exec(url.pathname)
  if (planningContext) {
    const projectVersion = await loadProjectVersion(planningContext[1])
    if (!projectVersion) throw new Error('项目版本不存在')
    const scopeKey = `planning:${projectVersion.projectId}:${projectVersion.id}`
    if (method === 'GET') {
      await requireProjectVersion(projectVersion.id, 'project-version:read')
      return send(response, 200, piAgentRuntime.context(scopeKey) ?? null)
    }
    if (method === 'POST') {
      await requireProjectVersion(projectVersion.id, 'project-version:manage')
      return send(response, 202, await piAgentRuntime.compact(scopeKey))
    }
  }
  const requirementReviewer = /^\/api\/requirement-analysis-runs\/([^/]+)\/planning-reviewer$/.exec(url.pathname)
  if (method === 'POST' && requirementReviewer) {
    await requireRun(requirementReviewer[1], 'requirement-analysis:handle')
    return send(response, 202, await planningWorkflowService.reviewRequirement(requirementReviewer[1]))
  }
  const testDesignReviewer = /^\/api\/test-design-runs\/([^/]+)\/planning-reviewer$/.exec(url.pathname)
  if (method === 'POST' && testDesignReviewer) {
    const body = await json(request)
    const reviewerType = String(body.reviewerType ?? '')
    if (reviewerType !== 'coverage') throw new Error('PLANNING_REVIEWER_TYPE_INVALID')
    if (Object.keys(body).some(key => key !== 'reviewerType')) throw new Error('PLANNING_REVIEWER_REQUEST_INVALID')
    const state = await stateStore.snapshot()
    const run = state.testDesignState?.runs.find(item => item.id === testDesignReviewer[1])
    if (!run) throw new Error('TEST_DESIGN_RUN_NOT_FOUND')
    await requireProjectVersion(run.projectVersionId, 'test-design:review')
    return send(response, 202, await planningWorkflowService.reviewCoverage(run.id))
  }
  const projectVersionAnalysisRuns = /^\/api\/project-versions\/([^/]+)\/requirement-analysis-runs$/.exec(url.pathname)
  if (method === 'POST' && projectVersionAnalysisRuns) {
    await requireProjectVersion(projectVersionAnalysisRuns[1], 'requirement-analysis:create')
    const body = await json(request)
    return send(response, 202, await requirementAnalysisService.start({ projectVersionId: projectVersionAnalysisRuns[1], documentDirectoryPath: String(body.documentDirectoryPath ?? ''), focusAreas: stringList(body.focusAreas), excludedAreas: stringList(body.excludedAreas) }))
  }
  if (method === 'GET' && projectVersionAnalysisRuns) {
    await requireProjectVersion(projectVersionAnalysisRuns[1], 'requirement-analysis:read')
    return send(response, 200, await requirementAnalysisService.list(projectVersionAnalysisRuns[1], {
      limit: optionalPositiveInteger(url.searchParams.get('limit')),
      cursor: url.searchParams.get('cursor') ?? undefined,
      runningOnly: url.searchParams.get('runningOnly') === 'true',
    }))
  }
  const requirementAnalysisRun = /^\/api\/requirement-analysis-runs\/([^/]+)$/.exec(url.pathname)
  if (method === 'GET' && requirementAnalysisRun) { await requireRun(requirementAnalysisRun[1], 'requirement-analysis:read'); return send(response, 200, await requirementAnalysisService.get(requirementAnalysisRun[1])) }
  const clarificationBatch = /^\/api\/requirement-analysis-runs\/([^/]+)\/clarifications\/actions$/.exec(url.pathname)
  if (method === 'POST' && clarificationBatch) {
    await requireRun(clarificationBatch[1], 'requirement-analysis:handle')
    const body = await json(request)
    if (!Array.isArray(body.items)) throw new Error('CLARIFICATION_BATCH_INVALID: items 必须是数组')
    const items = body.items.map(item => {
      const value = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      const rawAction = String(value.action ?? '')
      if (rawAction !== 'answer' && rawAction !== 'dismiss') throw new Error('CLARIFICATION_BATCH_INVALID: action 不合法')
      const action: 'answer' | 'dismiss' = rawAction
      return { clarificationId: String(value.clarificationId ?? ''), action, answer: String(value.answer ?? '') }
    })
    return send(response, 202, await requirementAnalysisService.actOnClarifications(clarificationBatch[1], { items, principal }))
  }
  const automaticTestDesignRetry = /^\/api\/requirement-analysis-runs\/([^/]+)\/automatic-test-design\/retry$/.exec(url.pathname)
  if (method === 'POST' && automaticTestDesignRetry) {
    await requireRun(automaticTestDesignRetry[1], 'project-version:manage')
    return send(response, 202, await planningWorkflowService.requirementReleasePublished(automaticTestDesignRetry[1]))
  }
  const releaseArtifact = /^\/api\/requirement-analysis-runs\/([^/]+)\/release\/artifacts\/([^/]+)$/.exec(url.pathname)
  if (method === 'GET' && releaseArtifact) {
    await requireRun(releaseArtifact[1], 'requirement-analysis:read')
    const artifact = await requirementAnalysisService.releaseArtifact(releaseArtifact[1], decodeURIComponent(releaseArtifact[2]))
    return sendText(response, 200, artifact.content, `${artifact.mediaType}; charset=utf-8`, artifact.fileName)
  }
  const runApprovals = /^\/api\/requirement-analysis-runs\/([^/]+)\/approvals$/.exec(url.pathname)
  if (method === 'GET' && runApprovals) { await requireRun(runApprovals[1], 'requirement-analysis:read'); return send(response, 200, await reviewGovernanceService.listApprovals(runApprovals[1])) }
  const approvalDecision = /^\/api\/tool-approvals\/([^/]+)\/decision$/.exec(url.pathname)
  if (method === 'POST' && approvalDecision) {
    const approval = await loadApproval(approvalDecision[1])
    await requireProjectVersion(approval.projectVersionId, 'tool:approve')
    const body = await json(request)
    return send(response, 200, await reviewGovernanceService.decideApproval(approvalDecision[1], { decision: String(body.decision ?? '') as 'approved' | 'rejected', comment: body.comment === undefined ? undefined : String(body.comment), principal }))
  }
  const reportExport = /^\/api\/project-versions\/([^/]+)\/requirement-analysis-runs\/([^/]+)\/report\.md$/.exec(url.pathname)
  if (method === 'GET' && reportExport) { await requireProjectVersion(reportExport[1], 'requirement-analysis:read'); await requireRun(reportExport[2], 'requirement-analysis:read'); return sendText(response, 200, await reviewGovernanceService.exportMarkdown(reportExport[2], reportExport[1]), 'text/markdown; charset=utf-8', `requirement-analysis-${reportExport[2]}.md`) }
  const requirementAnalysisRunCancel = /^\/api\/requirement-analysis-runs\/([^/]+)\/cancel$/.exec(url.pathname)
  if (method === 'POST' && requirementAnalysisRunCancel) { await requireRun(requirementAnalysisRunCancel[1], 'requirement-analysis:cancel'); return send(response, 202, await requirementAnalysisService.cancel(requirementAnalysisRunCancel[1])) }
  const requirementAnalysisRunRetry = /^\/api\/requirement-analysis-runs\/([^/]+)\/retry$/.exec(url.pathname)
  if (method === 'POST' && requirementAnalysisRunRetry) {
    await requireRun(requirementAnalysisRunRetry[1], 'requirement-analysis:retry')
    const body = await json(request)
    const mode = String(body.mode ?? '')
    if (mode !== 'full') throw new Error('单 Agent 需求分析只支持 full 全部重跑')
    return send(response, 202, await requirementAnalysisService.retry(requirementAnalysisRunRetry[1], 'full'))
  }
  const modelSource = /^\/api\/model-sources\/([^/]+)$/.exec(url.pathname)
  if (method === 'PATCH' && modelSource) return send(response, 200, await modelService.updateSource(modelSource[1], await json(request)))
  if (method === 'DELETE' && modelSource) return send(response, 200, await modelService.deleteSource(modelSource[1]))
  const modelProbe = /^\/api\/model-sources\/([^/]+)\/models\/([^/]+)\/probe$/.exec(url.pathname)
  if (method === 'POST' && modelProbe) return send(response, 200, await modelService.probe(modelProbe[1], modelProbe[2]))
  if (method === 'POST' && url.pathname === '/api/default-knowledge-base') return send(response, 200, await service.ensureDefaultKnowledgeBase('SmartHub'))
  if (method === 'GET' && url.pathname === '/api/project-versions') {
    const versions = await projectVersionService.list()
    return send(response, 200, (await Promise.all(versions.map(async version => await controls.canAccess(principal, version.id, 'project-version:read') ? version : null))).filter(Boolean))
  }
  if (method === 'POST' && url.pathname === '/api/project-versions') { const body = await json(request); const sourceProjectVersionId = body.sourceProjectVersionId ? String(body.sourceProjectVersionId) : undefined; await requireProjectVersion(sourceProjectVersionId ?? '*', 'project-version:create'); return send(response, 201, await projectVersionService.create({ name: String(body.name ?? ''), description: body.description ? String(body.description) : undefined, sourceProjectVersionId, inheritRequirementBindings: body.inheritRequirementBindings === true })) }
  const agentsUnderTest = /^\/api\/project-versions\/([^/]+)\/agents-under-test$/.exec(url.pathname)
  if (method === 'GET' && agentsUnderTest) {
    await requireProjectVersion(agentsUnderTest[1], 'project-version:read')
    return send(response, 200, { items: await agentUnderTestService.list(agentsUnderTest[1]) })
  }
  if (method === 'POST' && agentsUnderTest) {
    await requireProjectVersion(agentsUnderTest[1], 'project-version:manage')
    return send(response, 201, await agentUnderTestService.create(
      agentsUnderTest[1],
      await json(request) as unknown as AgentUnderTestInput,
      principal.displayName,
    ))
  }
  const agentUnderTest = /^\/api\/project-versions\/([^/]+)\/agents-under-test\/([^/]+)$/.exec(url.pathname)
  if (method === 'GET' && agentUnderTest) {
    await requireProjectVersion(agentUnderTest[1], 'project-version:read')
    const value = await agentUnderTestService.get(agentUnderTest[2])
    if (value.projectVersionId !== agentUnderTest[1]) throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_SCOPE_MISMATCH', '被测 Agent 不属于当前 ProjectVersion', 404)
    return send(response, 200, value)
  }
  if ((method === 'PUT' || method === 'PATCH') && agentUnderTest) {
    await requireProjectVersion(agentUnderTest[1], 'project-version:manage')
    const body = await json(request)
    const expectedVersion = Number(body.expectedVersion)
    const value = await agentUnderTestService.get(agentUnderTest[2])
    if (value.projectVersionId !== agentUnderTest[1]) throw new AgentUnderTestServiceError('AGENT_UNDER_TEST_SCOPE_MISMATCH', '被测 Agent 不属于当前 ProjectVersion', 404)
    const { expectedVersion: _expectedVersion, ...input } = body
    return send(response, 200, await agentUnderTestService.update(agentUnderTest[2], expectedVersion, input as unknown as AgentUnderTestInput, principal.displayName))
  }
  const projectVersionStatus = /^\/api\/project-versions\/([^/]+)\/status$/.exec(url.pathname)
  if (method === 'PATCH' && projectVersionStatus) { await requireProjectVersion(projectVersionStatus[1], 'project-version:manage'); const body = await json(request); return send(response, 200, await projectVersionService.updateStatus(projectVersionStatus[1], String(body.status ?? '') as 'open' | 'locked' | 'archived')) }
  const projectVersion = /^\/api\/project-versions\/([^/]+)$/.exec(url.pathname)
  if (method === 'DELETE' && projectVersion) { await requireProjectVersion(projectVersion[1], 'project-version:manage'); const deleted = await projectVersionService.delete(projectVersion[1]); await Promise.all(deleted.workspaceCleanupTaskIds.map(notifyTask)); return send(response, 200, deleted) }
  const requirementBindings = /^\/api\/project-versions\/([^/]+)\/requirement-bindings$/.exec(url.pathname)
  if (method === 'GET' && requirementBindings) { await requireProjectVersion(requirementBindings[1], 'project-version:read'); return send(response, 200, await projectVersionService.bindings(requirementBindings[1])) }
  if (method === 'POST' && requirementBindings) { await requireProjectVersion(requirementBindings[1], 'project-version:manage'); const body = await json(request); return send(response, 201, await projectVersionService.bindRequirement(requirementBindings[1], String(body.assetVersionId ?? ''))) }
  const requirementBinding = /^\/api\/project-versions\/([^/]+)\/requirement-bindings\/([^/]+)$/.exec(url.pathname)
  if (method === 'DELETE' && requirementBinding) { await requireProjectVersion(requirementBinding[1], 'project-version:manage'); return send(response, 200, await projectVersionService.unbindRequirement(requirementBinding[1], requirementBinding[2])) }
  if (method === 'DELETE' && url.pathname === '/api/maintenance/empty-knowledge-bases') { const body = await json(request); if (body.confirm !== 'delete-empty-smarthub-knowledge-bases') throw new Error('缺少清理确认'); return send(response, 200, await service.cleanupEmptyDefaultKnowledgeBases('SmartHub')) }
  if (method === 'DELETE' && url.pathname === '/api/maintenance/knowledge-bases') { const body = await json(request); if (body.confirm !== 'delete-all-other-knowledge-bases') throw new Error('缺少清理确认'); return send(response, 200, await service.cleanupKnowledgeBasesExcept(String(body.keepKnowledgeBaseId ?? ''))) }
  const overview = /^\/api\/knowledge-bases\/([^/]+)\/overview$/.exec(url.pathname)
  if (method === 'GET' && overview) return send(response, 200, await service.overview(overview[1]))
  const directories = /^\/api\/knowledge-bases\/([^/]+)\/directories$/.exec(url.pathname)
  if (method === 'GET' && directories) return send(response, 200, await service.directories(directories[1]))
  if (method === 'POST' && directories) { const body = await json(request); return send(response, 201, await service.createDirectory(directories[1], String(body.name ?? ''), body.parentId ? String(body.parentId) : null)) }
  const directory = /^\/api\/directories\/([^/]+)$/.exec(url.pathname)
  if (method === 'PUT' && directory) { const body = await json(request); return send(response, 200, await service.renameDirectory(directory[1], String(body.name ?? ''))) }
  if (method === 'DELETE' && directory) { const body = await json(request); const result = await service.deleteDirectory(directory[1], body.mode === 'move' ? 'move' : 'recursive', body.targetParentId ? String(body.targetParentId) : null); if (body.mode !== 'move' && 'task' in result && result.task) { await notifyTask(result.task.id); return send(response, 202, result) } return send(response, 200, result) }
  const config = /^\/api\/knowledge-bases\/([^/]+)\/config$/.exec(url.pathname)
  if (method === 'GET' && config) return send(response, 200, await service.config(config[1]))
  if (method === 'PUT' && config) return send(response, 200, await service.saveConfig(config[1], await json(request) as Partial<KnowledgeConfig>))
  const embeddingTest = /^\/api\/knowledge-bases\/([^/]+)\/embedding\/test$/.exec(url.pathname)
  if (method === 'POST' && embeddingTest) return send(response, 200, await service.testEmbeddingConfig(embeddingTest[1], await json(request) as Partial<KnowledgeConfig>))
  const uploads = /^\/api\/knowledge-bases\/([^/]+)\/uploads$/.exec(url.pathname)
  if (method === 'POST' && uploads) { const body = await json(request); const result = await service.ingest({ knowledgeBaseId: uploads[1], sourceType: 'upload', sourceKey: String(body.sourceKey ?? body.logicalPath), assetType: body.assetType as AssetType, displayName: String(body.displayName), logicalPath: String(body.logicalPath), content: String(body.content), simulateFailureAt: body.simulateFailureAt as string | undefined }); if (result.task) await notifyTask(result.task.id); return send(response, result.task ? 202 : 200, result) }
  const archives = /^\/api\/knowledge-bases\/([^/]+)\/archives$/.exec(url.pathname)
  if (method === 'POST' && archives) {
    const body = await json(request); const documents = Array.isArray(body.documents) ? body.documents : []; const attachments = Array.isArray(body.attachments) ? body.attachments : []
    if (documents.length > 500 || attachments.length > 2000) throw new Error('压缩包文件数量超过限制')
    let attachmentBytes = 0
    for (const item of attachments) { const path = String(item.logicalPath ?? ''); const encoded = String(item.contentBase64 ?? ''); const content = Buffer.from(encoded, 'base64'); attachmentBytes += content.length; if (content.length > 15 * 1024 * 1024 || attachmentBytes > 100 * 1024 * 1024) throw new Error('压缩包图片容量超过限制'); await rawDocumentStore.saveAttachment(archives[1], path, content) }
    let deduplicated = 0; const taskIds: string[] = []; const assetVersionIds: string[] = []
    for (const item of documents) { const result = await service.ingest({ knowledgeBaseId: archives[1], sourceType: 'upload', sourceKey: `archive:${String(item.logicalPath)}`, assetType: String(item.assetType ?? 'other'), displayName: String(item.displayName), logicalPath: String(item.logicalPath), content: String(item.content) }); assetVersionIds.push(result.version.id); if (result.deduplicated) deduplicated += 1; if (result.task) { taskIds.push(result.task.id); await notifyTask(result.task.id) } }
    return send(response, taskIds.length ? 202 : 200, { documents: documents.length, attachments: attachments.length, deduplicated, taskIds, assetVersionIds, skipped: Number(body.skipped ?? 0) })
  }
  const knowledgeFile = /^\/api\/knowledge-bases\/([^/]+)\/files\/(.+)$/.exec(url.pathname)
  if (method === 'GET' && knowledgeFile) { const logicalPath = decodeURIComponent(knowledgeFile[2]); const content = await rawDocumentStore.readAttachment(knowledgeFile[1], logicalPath); return sendBinary(response, 200, content, contentType(logicalPath)) }
  const assets = /^\/api\/knowledge-bases\/([^/]+)\/assets$/.exec(url.pathname)
  if (method === 'GET' && assets) return send(response, 200, await service.assets(assets[1], Object.fromEntries(url.searchParams)))
  const tasks = /^\/api\/knowledge-bases\/([^/]+)\/tasks$/.exec(url.pathname)
  if (method === 'GET' && tasks) return send(response, 200, (await service.tasks(tasks[1])).map(presentTask))
  const task = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname)
  if (method === 'GET' && task) return send(response, 200, presentTask(await service.task(task[1])))
  const retry = /^\/api\/tasks\/([^/]+)\/retry$/.exec(url.pathname)
  if (method === 'POST' && retry) { const retried = await service.retry(retry[1]); await notifyTask(retried.id); return send(response, 202, retried) }
  const cancel = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(url.pathname)
  if (method === 'POST' && cancel) return send(response, 202, await service.cancelTask(cancel[1]))
  const asset = /^\/api\/assets\/([^/]+)$/.exec(url.pathname)
  if (method === 'PUT' && asset) { const body = await json(request); const patch: { displayName?: string; targetDirectoryId?: string | null } = {}; if ('displayName' in body) patch.displayName = String(body.displayName ?? ''); if ('targetDirectoryId' in body) patch.targetDirectoryId = body.targetDirectoryId ? String(body.targetDirectoryId) : null; return send(response, 200, await service.updateAsset(asset[1], patch)) }
  if (method === 'DELETE' && asset) { const result = await service.deleteAsset(asset[1]); await notifyTask(result.task.id); return send(response, 202, result) }
  const version = /^\/api\/asset-versions\/([^/]+)$/.exec(url.pathname)
  if (method === 'GET' && version) return send(response, 200, await service.version(version[1], false))
  const search = /^\/api\/knowledge-bases\/([^/]+)\/search$/.exec(url.pathname)
  if (method === 'POST' && search) { const body = await json(request); return send(response, 200, await service.search(search[1], { query: String(body.query ?? ''), mode: body.mode as 'keyword' | 'vector' | 'hybrid' | undefined, logicalPath: body.logicalPath as string | undefined })) }
  const rebuild = /^\/api\/knowledge-bases\/([^/]+)\/rebuild$/.exec(url.pathname)
  if (method === 'POST' && rebuild) { const body = await json(request); if (body.outcome) return send(response, 202, await service.rebuild(rebuild[1], body.outcome as 'success' | 'failure' | 'cancel')); const task = await service.queueRebuild(rebuild[1]); if (task.status === 'queued') await notifyTask(task.id); return send(response, 202, { task }) }
  if (method === 'GET' && !url.pathname.startsWith('/api/') && await sendWeb(response, url.pathname)) return
  send(response, 404, { error: '接口不存在' })
}

function installAwaitedShutdown(server: ReturnType<typeof createServer>) {
  const closeServer = server.close.bind(server)
  let cleanup: Promise<void> | undefined
  const closeResources = () => {
    cleanup ??= Promise.allSettled([
      () => aiResourceService.close(),
      () => testExecutionStore?.close(),
      () => stateStore.close?.(),
    ].map(close => Promise.resolve().then(close))).then(results => {
      const errors = results
        .filter((result): result is PromiseRejectedResult =>
          result.status === 'rejected')
        .map(result => result.reason)
      if (errors.length) {
        throw new AggregateError(errors, 'SERVER_RESOURCE_CLEANUP_FAILED')
      }
    })
    return cleanup
  }
  server.close = ((callback?: (error?: Error) => void) => {
    closeServer(error => {
      if (error) {
        callback?.(error)
        return
      }
      void closeResources().then(
        () => callback?.(),
        cause => {
          const failure = cause instanceof Error
            ? cause
            : new Error('SERVER_RESOURCE_CLEANUP_FAILED')
          if (callback) callback(failure)
          else console.error(failure)
        },
      )
    })
    return server
  }) as typeof server.close
}

async function unavailableTestExecutionReadiness() {
  const agents = await testExecutionAgentRuntime.readiness()
  const failureAnalysis = agents.agents.find(item => item.agentKey === 'failure-analysis')
  return {
    ready: false,
    store: {
      ready: false,
      reason: 'TEST_EXECUTION_POSTGRES_UNAVAILABLE',
    },
    worker: { ready: false, reason: 'AGENT_TEST_WORKER_UNAVAILABLE', activeWorkers: 0 },
    agents,
    runner: { ready: true, snapshot: { kind: 'agent', runnerVersion: 'agent-runner/v2' } },
    agent: { ready: false, reason: failureAnalysis?.reason ?? 'TEST_EXECUTION_POSTGRES_UNAVAILABLE' },
  }
}

async function sendWeb(response: ServerResponse, pathname: string) {
  const relative = decodeURIComponent(pathname).replace(/^\/+|\\/gu, '/')
  const requested = resolve(webRoot, ...relative.split('/').filter(Boolean))
  if (requested !== webRoot && !requested.startsWith(`${webRoot}${sep}`)) return false
  const requestedStat = await stat(requested).catch(() => null)
  if (!requestedStat?.isFile() && extname(requested)) return false
  const target = requestedStat?.isFile() ? requested : resolve(webRoot, 'index.html')
  const targetStat = await stat(target).catch(() => null)
  if (!targetStat?.isFile()) return false
  const body = await readFile(target)
  response.writeHead(200, { 'content-type': webContentType(target), 'content-length': body.length, 'cache-control': target.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' })
  response.end(body)
  return true
}

function webContentType(path: string) {
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' } as Record<string, string>)[extname(path).toLocaleLowerCase()] ?? 'application/octet-stream'
}

async function loadProjectVersion(projectVersionId: string) {
  return stateStore.getProjectVersion
    ? stateStore.getProjectVersion(projectVersionId)
    : (await stateStore.snapshot()).projectVersions.find(item =>
        item.id === projectVersionId) ?? null
}

async function loadRun(runId: string) {
  const run = stateStore.getReviewRun
    ? await stateStore.getReviewRun(runId)
    : (await stateStore.snapshot()).reviewRuns.find(item => item.id === runId)
  if (!run) throw new Error('需求分析运行不存在')
  return run
}

async function loadApproval(approvalId: string) {
  const approval = stateStore.getToolApproval
    ? await stateStore.getToolApproval(approvalId)
    : (await stateStore.snapshot()).toolApprovals.find(item => item.id === approvalId)
  if (!approval) throw new Error('审批记录不存在')
  return approval
}

function stringList(value: unknown) { return Array.isArray(value) ? value.map(String) : undefined }
function optionalPositiveInteger(value: string | null) {
  if (value == null || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('limit 必须是正整数')
  return parsed
}
function presentTask(task: Awaited<ReturnType<typeof service.task>>) {
  return {
    id: task.id,
    knowledgeBaseId: task.knowledgeBaseId,
    type: task.type,
    trigger: task.trigger,
    status: task.status,
    step: task.step,
    progress: task.progress,
    attempts: task.attempts,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    error: task.error,
    metrics: task.metrics,
    scope: task.scope,
    targetId: task.targetId,
  }
}
async function json(request: IncomingMessage, maximumBytes = 128 * 1024 * 1024) {
  const declared = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error(`请求体不能超过 ${Math.ceil(maximumBytes / 1024 / 1024)} MB`)
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    received += buffer.length
    if (received > maximumBytes) throw new Error(`请求体不能超过 ${Math.ceil(maximumBytes / 1024 / 1024)} MB`)
    chunks.push(buffer)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {}
}
function agentConfigurationScene(path: string): AgentConfigurationScene {
  if (path === 'planning') return 'planning'
  return 'test_execution'
}
function send(response: ServerResponse, status: number, body: unknown) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type, authorization, idempotency-key, if-match', 'access-control-expose-headers': 'etag, content-disposition' }); response.end(body == null ? '' : JSON.stringify(body)) }
function sendText(response: ServerResponse, status: number, body: string, type: string, filename?: string) { response.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(filename ? { 'content-disposition': `attachment; filename="${filename.replaceAll('"', '')}"` } : {}), 'access-control-allow-origin': '*' }); response.end(body) }
function writeNdjson(response: ServerResponse, body: unknown) { if (!response.writableEnded && !response.destroyed) response.write(`${JSON.stringify(body)}\n`) }
function sendBinary(response: ServerResponse, status: number, body: Buffer, type: string) { response.writeHead(status, { 'content-type': type, 'content-length': body.length, 'cache-control': 'private, max-age=3600', 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*' }); response.end(body) }
function contentType(path: string) { const extension = path.toLowerCase().split('.').at(-1); return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml; charset=utf-8' } as Record<string, string>)[extension ?? ''] ?? 'application/octet-stream' }
async function notifyTask(_taskId: string) {
  if (usingPostgres) await stateStore.notifyTask?.()
  else void service.processTask(_taskId).catch(error => console.error(`知识库任务 ${_taskId} 调度失败：`, error instanceof Error ? error.message : error))
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const port = Number(process.env.PORT ?? 8787)
  start(port).then(() => console.log(`SmartHub API: http://127.0.0.1:${port}`))
}
