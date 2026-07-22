import { parseMarkdownOutline } from './markdown-outline'
import type { KnowledgeDirectory, KnowledgeDocument } from './prototype-data'

const base = 'http://127.0.0.1:8787/api'
export type ApiConfig = { id: string; version: number; requiresRebuild: boolean; config: { parserVersion: string; preprocessVersion: string; chunkTargetSize: number; chunkMaxSize: number; chunkOverlap: number; headingDepth: number; embeddingMode: 'remote_api' | 'local'; embeddingBaseUrl: string; embeddingApiKey: string; embeddingModel: string; embeddingDimensions: number; embeddingBatchSize: number; embeddingTimeoutMs: number; embeddingRetries: number; keywordRecall: number; vectorRecall: number; finalResults: number; relevanceThreshold: number; hybridSearch: boolean; rerankerEnabled: boolean; rerankerModel: string } }
export type ApiTask = { id: string; type: string; status: string; step: string; progress: number; attempts: number; createdAt: string; error?: string; metrics?: Record<string, number> }
export type LocalModelStatus = { phase: 'idle' | 'downloading' | 'loading' | 'running' | 'stopping' | 'failed'; model: string; progress: number; cacheDirectory: string; file?: string; dimensions?: number; error?: string; updatedAt: string }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } })
  const body = await response.json(); if (!response.ok) throw new Error(body.error ?? '知识库服务请求失败'); return body as T
}

export async function ensureKnowledgeBase() {
  const result = await request<{ knowledgeBase: { id: string } }>('/default-knowledge-base', { method: 'POST', body: '{}' })
  localStorage.setItem('smarthub-kb-id', result.knowledgeBase.id)
  return result.knowledgeBase.id
}

type ApiVersion = { id: string; number: number; content: string; status: string; createdAt: string; readyAt?: string; chunks: { headingPath: string[] }[] }
type ApiAsset = { id: string; displayName: string; logicalPath: string; assetType: string; sourceType: string; activeVersionId: string | null; activeVersion: ApiVersion | null; versions: { id: string; number: number; status: string; createdAt: string }[] }
type ApiDirectory = { id: string; knowledgeBaseId: string; name: string; parentId: string | null }
export async function loadKnowledgeAssets(kbId: string, includeDeleted = false): Promise<{ directories: KnowledgeDirectory[]; documents: KnowledgeDocument[] }> {
  const [assets, savedDirectories] = await Promise.all([request<ApiAsset[]>(`/knowledge-bases/${kbId}/assets${includeDeleted ? '?includeDeleted=true' : ''}`), request<ApiDirectory[]>(`/knowledge-bases/${kbId}/directories`)])
  const directoryMap = new Map(savedDirectories.map(item => [item.id, { id: item.id, name: item.name, parentId: item.parentId }]))
  const pathToId = new Map<string, string>()
  const resolveDirectoryPath = (directory: KnowledgeDirectory): string => { const parentPath = directory.parentId ? resolveDirectoryPath(directoryMap.get(directory.parentId)!) : ''; const path = parentPath ? `${parentPath}/${directory.name}` : directory.name; pathToId.set(path.toLocaleLowerCase(), directory.id); return path }
  savedDirectories.forEach(item => resolveDirectoryPath(directoryMap.get(item.id)!))
  const documents = await Promise.all(assets.map(async asset => {
    const parts = asset.logicalPath.replaceAll('\\', '/').split('/').filter(Boolean); parts.pop(); let parentId: string | null = null; let path = ''
    for (const part of parts) { path = path ? `${path}/${part}` : part; let id = pathToId.get(path.toLocaleLowerCase()); if (!id) { id = `api-dir:${path}`; directoryMap.set(id, { id, name: part, parentId }); pathToId.set(path.toLocaleLowerCase(), id) } parentId = id }
    const current = asset.activeVersion ?? await request<ApiVersion>(`/asset-versions/${asset.versions.at(-1)!.id}`); const content = current.content; const format = asset.displayName.toLowerCase().endsWith('.txt') ? 'text' : 'markdown'; const outline = format === 'markdown' ? parseMarkdownOutline(content) : undefined
    return { id: asset.id, name: asset.displayName, parentId, version: `V${current.number}`, updated: current.readyAt ? new Date(current.readyAt).toLocaleString('zh-CN') : new Date(current.createdAt).toLocaleString('zh-CN'), title: outline?.title ?? asset.displayName.replace(/\.(md|txt)$/i, ''), intro: content.split('\n').find(line => line.trim() && !line.startsWith('#'))?.trim() ?? '纯文本知识资产', sections: outline?.sections.map(section => section.title) ?? [], content, assetType: asset.assetType, sourceType: asset.sourceType, assetVersionId: current.id, versions: asset.versions, status: current.status, logicalPath: asset.logicalPath }
  }))
  return { directories: [...directoryMap.values()], documents }
}

export async function uploadKnowledgeFile(kbId: string, file: File, logicalPath: string, assetType = 'other') {
  return request<{ deduplicated: boolean; task: ApiTask | null }>(`/knowledge-bases/${kbId}/uploads`, { method: 'POST', body: JSON.stringify({ sourceKey: `browser:${logicalPath}`, assetType, displayName: file.name, logicalPath, content: await file.text() }) })
}
export async function uploadKnowledgeArchive(kbId: string, file: File, targetPath = '', assetType = 'other') {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(file)
  const prefix = targetPath.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
  const documents: { logicalPath: string; displayName: string; content: string; assetType: string }[] = []
  const attachments: { logicalPath: string; contentBase64: string }[] = []
  let skipped = 0
  const entries = Object.values(zip.files).filter(entry => !entry.dir && !entry.name.startsWith('__MACOSX/'))
  for (const entry of entries) {
    const relativePath = entry.name.replaceAll('\\', '/').replace(/^\/+/, '')
    if (!relativePath || relativePath.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`压缩包路径不安全：${entry.name}`)
    const logicalPath = [prefix, relativePath].filter(Boolean).join('/')
    const extension = relativePath.split('.').at(-1)?.toLowerCase() ?? ''
    if (extension === 'md' || extension === 'txt') documents.push({ logicalPath, displayName: relativePath.split('/').at(-1)!, content: await entry.async('text'), assetType })
    else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(extension)) attachments.push({ logicalPath, contentBase64: await entry.async('base64') })
    else skipped += 1
  }
  if (!documents.length) throw new Error('压缩包中没有可入库的 Markdown 或 TXT 文件。')
  return request<{ documents: number; attachments: number; deduplicated: number; taskIds: string[]; skipped: number }>(`/knowledge-bases/${kbId}/archives`, { method: 'POST', body: JSON.stringify({ documents, attachments, skipped }) })
}
export const loadConfig = (kbId: string) => request<ApiConfig>(`/knowledge-bases/${kbId}/config`)
export const saveConfig = (kbId: string, config: Record<string, unknown>) => request<{ changed: boolean; impact: string; configVersion: ApiConfig }>(`/knowledge-bases/${kbId}/config`, { method: 'PUT', body: JSON.stringify(config) })
export const rebuildIndex = (kbId: string, outcome?: 'failure' | 'cancel') => request<{ task: ApiTask; index?: { id: string; number: number } }>(`/knowledge-bases/${kbId}/rebuild`, { method: 'POST', body: JSON.stringify(outcome ? { outcome } : {}) })
export const loadTasks = (kbId: string) => request<ApiTask[]>(`/knowledge-bases/${kbId}/tasks`)
export const loadTask = (taskId: string) => request<ApiTask>(`/tasks/${taskId}`)
export async function waitForTasks(taskIds: string[], attempts = 300) {
  const pending = new Set(taskIds)
  for (let attempt = 0; attempt < attempts && pending.size; attempt += 1) {
    await new Promise(resolvePromise => window.setTimeout(resolvePromise, 200))
    for (const taskId of [...pending]) {
      const task = await loadTask(taskId)
      if (task.status === 'failed') throw new Error(task.error ?? '知识库任务失败')
      if (task.status === 'cancelled') throw new Error('知识库任务已取消')
      if (task.status === 'succeeded') pending.delete(taskId)
    }
  }
  if (pending.size) throw new Error('知识库任务等待超时，可稍后刷新查看结果')
}
export const retryTask = (taskId: string) => request(`/tasks/${taskId}/retry`, { method: 'POST', body: '{}' })
export const cancelTask = (taskId: string) => request<ApiTask>(`/tasks/${taskId}/cancel`, { method: 'POST', body: '{}' })
export type ApiSearchResult = { score: number; retrievalMode: string; excerpt: string; scores?: { keyword: number; vector: number; reranker?: number; final: number }; asset: { id: string; displayName: string; assetType: string; sourceType: string; logicalPath: string }; version: { id: string; number: number }; chunk: { chunkKey: string; headingPath: string[]; startLine: number; endLine: number } }
export type ApiSearchMeta = { mode: string; requestedMode?: string; degraded?: boolean; degradedReason?: string; minimumRelevance: number; keywordCandidates: number; vectorCandidates: number; mergedCandidates: number; eligibleCandidates: number; returned: number; rerankerEnabled: boolean; rerankerDegraded?: boolean }
export const searchKnowledge = (kbId: string, query: string) => request<{ status: string; retrieval?: ApiSearchMeta; results: ApiSearchResult[] }>(`/knowledge-bases/${kbId}/search`, { method: 'POST', body: JSON.stringify({ query }) })
export const loadLocalModelStatus = () => request<LocalModelStatus>('/local-model/status')
export const startLocalModel = (model: string) => request<LocalModelStatus>('/local-model/start', { method: 'POST', body: JSON.stringify({ model }) })
export const stopLocalModel = () => request<LocalModelStatus>('/local-model/stop', { method: 'POST', body: '{}' })
export const testEmbeddingConfig = (kbId: string, config: Record<string, unknown>) => request<{ ok: true; model: string; dimensions: number }>(`/knowledge-bases/${kbId}/embedding/test`, { method: 'POST', body: JSON.stringify(config) })
export const createKnowledgeDirectory = (kbId: string, name: string, parentId: string | null) => request<ApiDirectory>(`/knowledge-bases/${kbId}/directories`, { method: 'POST', body: JSON.stringify({ name, parentId }) })
export const renameKnowledgeDirectory = (directoryId: string, name: string) => request<ApiDirectory>(`/directories/${directoryId}`, { method: 'PUT', body: JSON.stringify({ name }) })
export const deleteKnowledgeDirectory = (directoryId: string, mode: 'recursive' | 'move', targetParentId: string | null = null) => request<{ deletedDirectoryIds: string[]; affectedAssets: number }>(`/directories/${directoryId}`, { method: 'DELETE', body: JSON.stringify({ mode, targetParentId }) })
export const updateKnowledgeAsset = (assetId: string, patch: { displayName?: string; targetDirectoryId?: string | null }) => request<ApiAsset>(`/assets/${assetId}`, { method: 'PUT', body: JSON.stringify(patch) })
export const deleteKnowledgeAsset = (assetId: string) => request<{ task: ApiTask }>(`/assets/${assetId}`, { method: 'DELETE' })
