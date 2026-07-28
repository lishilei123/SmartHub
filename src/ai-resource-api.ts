const apiBase = 'http://127.0.0.1:8787/api'

export type AiResourceKind = 'mcp' | 'skill' | 'tool'
export type AiResourceStatus = 'ready' | 'draft'

type AiResourceBase = {
  id: string
  kind: AiResourceKind
  key: string
  name: string
  description: string
  version: string
  enabled: boolean
  status: AiResourceStatus
  builtIn: boolean
  createdAt: string
  updatedAt: string
}

export type McpServerResource = AiResourceBase & { kind: 'mcp'; transport: 'streamable_http' | 'sse'; endpoint: string; authType: 'none' | 'bearer' | 'oauth2'; credentialEnv?: string; toolIds: string[] }
export type SkillPackageMetadata = { storageKey: string; entrypointPath: string; uploadedFileName: string; archiveSha256: string; contentSha256: string; fileCount: number; unpackedBytes: number; files: string[] }
export type SkillRuntimePolicy = { scripts: Array<{ path: string; runner: 'powershell'; timeoutMs: number }>; network?: { allowedOrigins: string[]; allowedMethods: Array<'GET' | 'HEAD'>; timeoutMs: number } }
export type SkillResource = AiResourceBase & { kind: 'skill'; entrypoint: string; toolIds: string[]; tags: string[]; runtime?: SkillRuntimePolicy; package?: SkillPackageMetadata }
export type ToolResource = AiResourceBase & { kind: 'tool'; source: 'builtin' | 'local' | 'http' | 'mcp'; risk: 'read' | 'network_read' | 'code_execution' | 'internal_write' | 'write_reversible' | 'write_high_risk'; timeoutMs: number; sourcePath?: string; mcpServerId?: string; endpoint?: string; authType?: 'none' | 'bearer'; credentialEnv?: string; parameters?: Record<string, unknown> }
export type ToolSource = { toolId: string; toolKey: string; path: string; language: string; content: string; readOnly: true }
export type AiResource = McpServerResource | SkillResource | ToolResource
export type AiResourceCatalog = { mcpServers: McpServerResource[]; skills: SkillResource[]; tools: ToolResource[] }

export async function loadAiResources() { return request<AiResourceCatalog>('/ai-resources') }
export async function createAiResource(kind: AiResourceKind, value: unknown) { return request<AiResource>(`/ai-resources/${kind}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }) }
export async function uploadSkillPackage(value: unknown, file: File) {
  const contentBase64 = await fileBase64(file)
  return request<SkillResource>('/ai-resources/skill-package', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(value as object), fileName: file.name, contentBase64 }) })
}
export async function updateAiResource(kind: AiResourceKind, id: string, value: unknown) { return request<AiResource>(`/ai-resources/${kind}/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }) }
export async function deleteAiResource(kind: AiResourceKind, id: string) { return request<{ id: string; deleted: true }>(`/ai-resources/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' }) }
export async function loadToolSource(id: string) { return request<ToolSource>(`/ai-resources/tool/${encodeURIComponent(id)}/source`) }

async function request<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${apiBase}${path}`, init)
  const value = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error((value as { error?: string }).error ?? `请求失败（HTTP ${response.status}）`)
  return value as T
}

function fileBase64(file: File) {
  return new Promise<string>((resolvePromise, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('ZIP 文件读取失败'))
    reader.onload = () => {
      const value = String(reader.result ?? '')
      const comma = value.indexOf(',')
      if (comma < 0) return reject(new Error('ZIP 文件读取失败'))
      resolvePromise(value.slice(comma + 1))
    }
    reader.readAsDataURL(file)
  })
}
