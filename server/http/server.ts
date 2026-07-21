import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KnowledgeService } from '../application/knowledge-service.js'
import { JsonStore, type StateStore } from '../infrastructure/store.js'
import type { AssetType, KnowledgeConfig, SourceType } from '../domain/types.js'
import { RawDocumentStore } from '../infrastructure/raw-document-store.js'
import { LocalModelRuntime } from '../infrastructure/local-model-runtime.js'
import { PostgresStore } from '../infrastructure/postgres-store.js'

const envFile = resolve(fileURLToPath(new URL('../../.env.local', import.meta.url)))
if (existsSync(envFile)) process.loadEnvFile(envFile)
const dataFile = process.env.SMARTHUB_DATA_FILE ?? resolve(fileURLToPath(new URL('../../data/smarthub.json', import.meta.url)))
const documentRoot = process.env.SMARTHUB_DOCUMENT_ROOT ?? resolve(fileURLToPath(new URL('../../data/knowledge-bases', import.meta.url)))
const modelRoot = process.env.SMARTHUB_MODEL_ROOT ?? resolve(fileURLToPath(new URL('../../data/models', import.meta.url)))
export const localModelRuntime = new LocalModelRuntime(modelRoot)
export const stateStore: StateStore = process.env.DATABASE_URL ? new PostgresStore(process.env.DATABASE_URL) : new JsonStore(dataFile)
export const rawDocumentStore = new RawDocumentStore(documentRoot)
export const service = new KnowledgeService(stateStore, rawDocumentStore, localModelRuntime)

export async function start(port = Number(process.env.PORT ?? 8787)) {
  await service.initialize()
  if (stateStore instanceof PostgresStore && !stateStore.read().projects.length && existsSync(dataFile)) {
    const legacy = new JsonStore(dataFile)
    await legacy.load()
    const snapshot = legacy.read()
    if (snapshot.projects.length) {
      await stateStore.transaction(draft => Object.assign(draft, snapshot))
      await service.initialize()
    }
  }
  const interruptedRebuilds = await service.recoverInterruptedRebuilds()
  const server = createServer(async (request, response) => {
    try { await route(request, response) }
    catch (error) { send(response, 400, { error: error instanceof Error ? error.message : '未知错误' }) }
  })
  server.once('close', () => { void stateStore.close?.() })
  return new Promise<typeof server>(resolvePromise => server.listen(port, '127.0.0.1', () => {
    interruptedRebuilds.forEach(taskId => setTimeout(() => void service.processQueuedRebuild(taskId), 0))
    resolvePromise(server)
  }))
}

async function route(request: IncomingMessage, response: ServerResponse) {
  const method = request.method ?? 'GET'; const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (method === 'OPTIONS') return send(response, 204, null)
  if (method === 'GET' && url.pathname === '/api/health') return send(response, 200, { status: 'ok' })
  if (method === 'GET' && url.pathname === '/api/local-model/status') return send(response, 200, localModelRuntime.status())
  if (method === 'POST' && url.pathname === '/api/local-model/start') { const body = await json(request); return send(response, 202, localModelRuntime.start(String(body.model ?? ''))) }
  if (method === 'POST' && url.pathname === '/api/local-model/stop') return send(response, 200, await localModelRuntime.stop())
  if (method === 'POST' && url.pathname === '/api/default-knowledge-base') return send(response, 200, await service.ensureDefaultKnowledgeBase('SmartHub'))
  if (method === 'DELETE' && url.pathname === '/api/maintenance/empty-knowledge-bases') { const body = await json(request); if (body.confirm !== 'delete-empty-smarthub-knowledge-bases') throw new Error('缺少清理确认'); return send(response, 200, await service.cleanupEmptyDefaultKnowledgeBases('SmartHub')) }
  if (method === 'DELETE' && url.pathname === '/api/maintenance/knowledge-bases') { const body = await json(request); if (body.confirm !== 'delete-all-other-knowledge-bases') throw new Error('缺少清理确认'); return send(response, 200, await service.cleanupKnowledgeBasesExcept(String(body.keepKnowledgeBaseId ?? ''))) }
  if (method === 'POST' && url.pathname === '/api/projects') { const body = await json(request); return send(response, 201, await service.createProject(String(body.name ?? ''))) }
  const overview = /^\/api\/knowledge-bases\/([^/]+)\/overview$/.exec(url.pathname)
  if (method === 'GET' && overview) return send(response, 200, service.overview(overview[1]))
  const directories = /^\/api\/knowledge-bases\/([^/]+)\/directories$/.exec(url.pathname)
  if (method === 'GET' && directories) return send(response, 200, service.directories(directories[1]))
  if (method === 'POST' && directories) { const body = await json(request); return send(response, 201, await service.createDirectory(directories[1], String(body.name ?? ''), body.parentId ? String(body.parentId) : null)) }
  const directory = /^\/api\/directories\/([^/]+)$/.exec(url.pathname)
  if (method === 'PUT' && directory) { const body = await json(request); return send(response, 200, await service.renameDirectory(directory[1], String(body.name ?? ''))) }
  if (method === 'DELETE' && directory) { const body = await json(request); return send(response, 200, await service.deleteDirectory(directory[1], body.mode === 'move' ? 'move' : 'recursive', body.targetParentId ? String(body.targetParentId) : null)) }
  const config = /^\/api\/knowledge-bases\/([^/]+)\/config$/.exec(url.pathname)
  if (method === 'GET' && config) return send(response, 200, service.config(config[1]))
  if (method === 'PUT' && config) return send(response, 200, await service.saveConfig(config[1], await json(request) as Partial<KnowledgeConfig>))
  const uploads = /^\/api\/knowledge-bases\/([^/]+)\/uploads$/.exec(url.pathname)
  if (method === 'POST' && uploads) { const body = await json(request); return send(response, 202, await service.ingest({ knowledgeBaseId: uploads[1], sourceType: 'upload', sourceKey: String(body.sourceKey ?? body.logicalPath), assetType: body.assetType as AssetType, displayName: String(body.displayName), logicalPath: String(body.logicalPath), content: String(body.content), simulateFailureAt: body.simulateFailureAt as string | undefined })) }
  const archives = /^\/api\/knowledge-bases\/([^/]+)\/archives$/.exec(url.pathname)
  if (method === 'POST' && archives) {
    const body = await json(request); const documents = Array.isArray(body.documents) ? body.documents : []; const attachments = Array.isArray(body.attachments) ? body.attachments : []
    if (documents.length > 500 || attachments.length > 2000) throw new Error('压缩包文件数量超过限制')
    let attachmentBytes = 0
    for (const item of attachments) { const path = String(item.logicalPath ?? ''); const encoded = String(item.contentBase64 ?? ''); const content = Buffer.from(encoded, 'base64'); attachmentBytes += content.length; if (content.length > 15 * 1024 * 1024 || attachmentBytes > 100 * 1024 * 1024) throw new Error('压缩包图片容量超过限制'); await rawDocumentStore.saveAttachment(archives[1], path, content) }
    let deduplicated = 0
    for (const item of documents) { const result = await service.ingest({ knowledgeBaseId: archives[1], sourceType: 'upload', sourceKey: `archive:${String(item.logicalPath)}`, assetType: String(item.assetType ?? 'other'), displayName: String(item.displayName), logicalPath: String(item.logicalPath), content: String(item.content) }); if (result.deduplicated) deduplicated += 1 }
    return send(response, 202, { documents: documents.length, attachments: attachments.length, deduplicated, skipped: Number(body.skipped ?? 0) })
  }
  const knowledgeFile = /^\/api\/knowledge-bases\/([^/]+)\/files\/(.+)$/.exec(url.pathname)
  if (method === 'GET' && knowledgeFile) { const logicalPath = decodeURIComponent(knowledgeFile[2]); const content = await rawDocumentStore.readAttachment(knowledgeFile[1], logicalPath); return sendBinary(response, 200, content, contentType(logicalPath)) }
  const assets = /^\/api\/knowledge-bases\/([^/]+)\/assets$/.exec(url.pathname)
  if (method === 'GET' && assets) return send(response, 200, service.assets(assets[1], Object.fromEntries(url.searchParams)))
  const tasks = /^\/api\/knowledge-bases\/([^/]+)\/tasks$/.exec(url.pathname)
  if (method === 'GET' && tasks) return send(response, 200, service.tasks(tasks[1]))
  const task = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname)
  if (method === 'GET' && task) return send(response, 200, service.task(task[1]))
  const retry = /^\/api\/tasks\/([^/]+)\/retry$/.exec(url.pathname)
  if (method === 'POST' && retry) return send(response, 202, await service.retry(retry[1]))
  const cancel = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(url.pathname)
  if (method === 'POST' && cancel) return send(response, 202, await service.cancelTask(cancel[1]))
  const asset = /^\/api\/assets\/([^/]+)$/.exec(url.pathname)
  if (method === 'PUT' && asset) { const body = await json(request); const patch: { displayName?: string; targetDirectoryId?: string | null } = {}; if ('displayName' in body) patch.displayName = String(body.displayName ?? ''); if ('targetDirectoryId' in body) patch.targetDirectoryId = body.targetDirectoryId ? String(body.targetDirectoryId) : null; return send(response, 200, await service.updateAsset(asset[1], patch)) }
  if (method === 'DELETE' && asset) return send(response, 202, await service.deleteAsset(asset[1]))
  const version = /^\/api\/asset-versions\/([^/]+)$/.exec(url.pathname)
  if (method === 'GET' && version) return send(response, 200, service.version(version[1]))
  const search = /^\/api\/knowledge-bases\/([^/]+)\/search$/.exec(url.pathname)
  if (method === 'POST' && search) { const body = await json(request); return send(response, 200, await service.search(search[1], { query: String(body.query ?? ''), mode: body.mode as 'keyword' | 'vector' | 'hybrid' | undefined, assetType: body.assetType as AssetType | undefined, sourceType: body.sourceType as SourceType | undefined, logicalPath: body.logicalPath as string | undefined })) }
  const rebuild = /^\/api\/knowledge-bases\/([^/]+)\/rebuild$/.exec(url.pathname)
  if (method === 'POST' && rebuild) { const body = await json(request); if (body.outcome) return send(response, 202, await service.rebuild(rebuild[1], body.outcome as 'success' | 'failure' | 'cancel')); const task = await service.queueRebuild(rebuild[1]); if (task.status === 'queued') setTimeout(() => void service.processQueuedRebuild(task.id), 300); return send(response, 202, { task }) }
  send(response, 404, { error: '接口不存在' })
}

async function json(request: IncomingMessage) { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {} }
function send(response: ServerResponse, status: number, body: unknown) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type' }); response.end(body == null ? '' : JSON.stringify(body)) }
function sendBinary(response: ServerResponse, status: number, body: Buffer, type: string) { response.writeHead(status, { 'content-type': type, 'content-length': body.length, 'cache-control': 'private, max-age=3600', 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*' }); response.end(body) }
function contentType(path: string) { const extension = path.toLowerCase().split('.').at(-1); return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml; charset=utf-8' } as Record<string, string>)[extension ?? ''] ?? 'application/octet-stream' }

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) start().then(() => console.log('SmartHub API: http://127.0.0.1:8787'))
