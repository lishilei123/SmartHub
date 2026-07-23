import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AssetType, KnowledgeConfig } from '../domain/types.js'
import { localModelRuntime, modelService, rawDocumentStore, requirementAnalysisService, service, stateStore, usingPostgres } from '../runtime.js'

export { localModelRuntime, modelService, rawDocumentStore, requirementAnalysisService, service, stateStore }

export async function start(port = Number(process.env.PORT ?? 8787)) {
  await service.initialize()
  const server = createServer(async (request, response) => {
    try { await route(request, response) }
    catch (error) { send(response, 400, { error: error instanceof Error ? error.message : '未知错误' }) }
  })
  server.once('close', () => { void stateStore.close?.() })
  return new Promise<typeof server>(resolvePromise => server.listen(port, '127.0.0.1', () => resolvePromise(server)))
}

async function route(request: IncomingMessage, response: ServerResponse) {
  const method = request.method ?? 'GET'; const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (method === 'OPTIONS') return send(response, 204, null)
  if (method === 'GET' && url.pathname === '/api/health') return send(response, 200, { status: 'ok' })
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
  if (method === 'POST' && url.pathname === '/api/requirement-analysis/run') {
    const body = await json(request)
    const controller = new AbortController()
    request.once('aborted', () => controller.abort(new Error('客户端已中断请求')))
    return send(response, 200, await requirementAnalysisService.analyze({ assetVersionId: String(body.assetVersionId ?? ''), sourceId: String(body.sourceId ?? ''), modelId: String(body.modelId ?? ''), focusAreas: stringList(body.focusAreas), excludedAreas: stringList(body.excludedAreas) }, controller.signal))
  }
  const modelSource = /^\/api\/model-sources\/([^/]+)$/.exec(url.pathname)
  if (method === 'PATCH' && modelSource) return send(response, 200, await modelService.updateSource(modelSource[1], await json(request)))
  if (method === 'DELETE' && modelSource) return send(response, 200, await modelService.deleteSource(modelSource[1]))
  const modelProbe = /^\/api\/model-sources\/([^/]+)\/models\/([^/]+)\/probe$/.exec(url.pathname)
  if (method === 'POST' && modelProbe) return send(response, 200, await modelService.probe(modelProbe[1], modelProbe[2]))
  if (method === 'POST' && url.pathname === '/api/default-knowledge-base') return send(response, 200, await service.ensureDefaultKnowledgeBase('SmartHub'))
  if (method === 'DELETE' && url.pathname === '/api/maintenance/empty-knowledge-bases') { const body = await json(request); if (body.confirm !== 'delete-empty-smarthub-knowledge-bases') throw new Error('缺少清理确认'); return send(response, 200, await service.cleanupEmptyDefaultKnowledgeBases('SmartHub')) }
  if (method === 'DELETE' && url.pathname === '/api/maintenance/knowledge-bases') { const body = await json(request); if (body.confirm !== 'delete-all-other-knowledge-bases') throw new Error('缺少清理确认'); return send(response, 200, await service.cleanupKnowledgeBasesExcept(String(body.keepKnowledgeBaseId ?? ''))) }
  if (method === 'POST' && url.pathname === '/api/projects') { const body = await json(request); return send(response, 201, await service.createProject(String(body.name ?? ''))) }
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
    let deduplicated = 0; const taskIds: string[] = []
    for (const item of documents) { const result = await service.ingest({ knowledgeBaseId: archives[1], sourceType: 'upload', sourceKey: `archive:${String(item.logicalPath)}`, assetType: String(item.assetType ?? 'other'), displayName: String(item.displayName), logicalPath: String(item.logicalPath), content: String(item.content) }); if (result.deduplicated) deduplicated += 1; if (result.task) { taskIds.push(result.task.id); await notifyTask(result.task.id) } }
    return send(response, taskIds.length ? 202 : 200, { documents: documents.length, attachments: attachments.length, deduplicated, taskIds, skipped: Number(body.skipped ?? 0) })
  }
  const knowledgeFile = /^\/api\/knowledge-bases\/([^/]+)\/files\/(.+)$/.exec(url.pathname)
  if (method === 'GET' && knowledgeFile) { const logicalPath = decodeURIComponent(knowledgeFile[2]); const content = await rawDocumentStore.readAttachment(knowledgeFile[1], logicalPath); return sendBinary(response, 200, content, contentType(logicalPath)) }
  const assets = /^\/api\/knowledge-bases\/([^/]+)\/assets$/.exec(url.pathname)
  if (method === 'GET' && assets) return send(response, 200, await service.assets(assets[1], Object.fromEntries(url.searchParams)))
  const tasks = /^\/api\/knowledge-bases\/([^/]+)\/tasks$/.exec(url.pathname)
  if (method === 'GET' && tasks) return send(response, 200, await service.tasks(tasks[1]))
  const task = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname)
  if (method === 'GET' && task) return send(response, 200, await service.task(task[1]))
  const retry = /^\/api\/tasks\/([^/]+)\/retry$/.exec(url.pathname)
  if (method === 'POST' && retry) { const retried = await service.retry(retry[1]); await notifyTask(retried.id); return send(response, 202, retried) }
  const cancel = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(url.pathname)
  if (method === 'POST' && cancel) return send(response, 202, await service.cancelTask(cancel[1]))
  const asset = /^\/api\/assets\/([^/]+)$/.exec(url.pathname)
  if (method === 'PUT' && asset) { const body = await json(request); const patch: { displayName?: string; targetDirectoryId?: string | null } = {}; if ('displayName' in body) patch.displayName = String(body.displayName ?? ''); if ('targetDirectoryId' in body) patch.targetDirectoryId = body.targetDirectoryId ? String(body.targetDirectoryId) : null; return send(response, 200, await service.updateAsset(asset[1], patch)) }
  if (method === 'DELETE' && asset) { const result = await service.deleteAsset(asset[1]); await notifyTask(result.task.id); return send(response, 202, result) }
  const version = /^\/api\/asset-versions\/([^/]+)$/.exec(url.pathname)
  if (method === 'GET' && version) return send(response, 200, await service.version(version[1]))
  const search = /^\/api\/knowledge-bases\/([^/]+)\/search$/.exec(url.pathname)
  if (method === 'POST' && search) { const body = await json(request); return send(response, 200, await service.search(search[1], { query: String(body.query ?? ''), mode: body.mode as 'keyword' | 'vector' | 'hybrid' | undefined, logicalPath: body.logicalPath as string | undefined })) }
  const rebuild = /^\/api\/knowledge-bases\/([^/]+)\/rebuild$/.exec(url.pathname)
  if (method === 'POST' && rebuild) { const body = await json(request); if (body.outcome) return send(response, 202, await service.rebuild(rebuild[1], body.outcome as 'success' | 'failure' | 'cancel')); const task = await service.queueRebuild(rebuild[1]); if (task.status === 'queued') await notifyTask(task.id); return send(response, 202, { task }) }
  send(response, 404, { error: '接口不存在' })
}

function stringList(value: unknown) { return Array.isArray(value) ? value.map(String) : undefined }
async function json(request: IncomingMessage) { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {} }
function send(response: ServerResponse, status: number, body: unknown) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type' }); response.end(body == null ? '' : JSON.stringify(body)) }
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
