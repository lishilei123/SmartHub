import { randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AiResource, AiResourceKind, McpServerResource, SkillPackageMetadata, SkillResource, ToolResource } from '../domain/types.js'
import type { SkillPackageStore } from '../infrastructure/skill-package-store.js'
import type { StateStore } from '../infrastructure/store.js'

export type AiResourceCatalog = {
  mcpServers: McpServerResource[]
  skills: SkillResource[]
  tools: ToolResource[]
}

const builtInTools: ToolResource[] = [
  builtInTool('knowledge.search', '固定索引检索', '仅在运行固定的知识索引中检索相关内容。', '1.0.0', 'read', 30_000, 'server/tools/knowledge-search.ts'),
  builtInTool('knowledge.read_chunk', '读取固定 Chunk', '按 Chunk ID 读取本次固定输入的完整内容与定位。', '1.0.0', 'read', 30_000, 'server/tools/knowledge-read-chunk.ts'),
  builtInTool('requirement-points.submit_result', '提交需求点', '提交需求点提取候选结果，由服务端生成 ID 和证据关联。', '5.1.0', 'internal_write', 30_000, 'server/tools/requirement-points-submit-result.ts'),
  builtInTool('review.submit_result', '提交评审分析', '提交需求点评审候选结果，由服务端校验并发布。', '4.0.0', 'internal_write', 30_000, 'server/tools/review-submit-result.ts'),
]
const retiredBuiltInToolKeys = new Set(['evidence.validate_batch'])
const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url))
const allowedSourceRoots = ['server/tools', 'ai/tools'] as const
const maximumSourceBytes = 512 * 1024

export class AiResourceService {
  constructor(private readonly store: StateStore, private readonly skillPackages?: SkillPackageStore) {}

  async list(): Promise<AiResourceCatalog> {
    let resources = this.store.listAiResources ? await this.store.listAiResources() : (await this.store.snapshot()).aiResources
    if (builtInsNeedSync(resources)) {
      await this.ensureBuiltIns()
      resources = this.store.listAiResources ? await this.store.listAiResources() : (await this.store.snapshot()).aiResources
    }
    return catalog(resources)
  }

  async create(kind: AiResourceKind, input: unknown): Promise<AiResource> {
    if (kind === 'skill') {
      const value = object(input)
      if ('package' in value || String(value.entrypoint ?? '').startsWith('skill-package://')) throw new Error('Skill 包元数据和受控入口只能由 ZIP 上传生成')
    }
    return this.transaction(state => {
      const now = new Date().toISOString()
      const resource = normalizeResource(kind, input, { id: `ai_resource_${randomUUID()}`, builtIn: false, createdAt: now, updatedAt: now })
      validateUnique(state.aiResources, resource)
      validateReferences(state.aiResources, resource)
      state.aiResources.push(resource)
      return structuredClone(resource)
    })
  }

  async createSkillPackage(input: unknown): Promise<SkillResource> {
    if (!this.skillPackages) throw new Error('Skill 包存储未配置')
    const value = object(input)
    const archive = decodeBase64(value.contentBase64)
    const installed = await this.skillPackages.install({ key: key(value.key), version: version(value.version), fileName: text(value.fileName, 'ZIP 文件名', 200), archive })
    try {
      return await this.transaction(state => {
        const now = new Date().toISOString()
        const resource = normalizeResource('skill', { ...value, entrypoint: installed.entrypoint, package: installed.package }, { id: `ai_resource_${randomUUID()}`, builtIn: false, createdAt: now, updatedAt: now }) as SkillResource
        resource.status = 'ready'
        validateUnique(state.aiResources, resource)
        validateReferences(state.aiResources, resource)
        state.aiResources.push(resource)
        return structuredClone(resource)
      })
    } catch (error) {
      await this.skillPackages.remove(installed.package.storageKey).catch(() => undefined)
      throw error
    }
  }

  async update(kind: AiResourceKind, id: string, input: unknown): Promise<AiResource> {
    return this.transaction(state => {
      const index = state.aiResources.findIndex(item => item.id === id && item.kind === kind)
      if (index < 0) throw new Error('AI 资源不存在')
      const previous = state.aiResources[index]
      const update = object(input)
      if (previous.kind === 'skill' && !previous.package && ('package' in update || String(update.entrypoint ?? '').startsWith('skill-package://'))) throw new Error('Skill 包元数据和受控入口只能由 ZIP 上传生成')
      const merged = { ...previous, ...update, id: previous.id, kind: previous.kind, builtIn: previous.builtIn, createdAt: previous.createdAt, updatedAt: new Date().toISOString() }
      if (previous.kind === 'skill' && previous.package) Object.assign(merged, { key: previous.key, version: previous.version, entrypoint: previous.entrypoint, package: previous.package, status: previous.status })
      if (previous.builtIn) Object.assign(merged, previous, { enabled: typeof update.enabled === 'boolean' ? update.enabled : previous.enabled, updatedAt: new Date().toISOString() })
      const resource = normalizeResource(kind, merged, { id: previous.id, builtIn: previous.builtIn, createdAt: previous.createdAt, updatedAt: merged.updatedAt })
      validateUnique(state.aiResources.filter(item => item.id !== id), resource)
      validateReferences(state.aiResources.filter(item => item.id !== id), resource)
      state.aiResources[index] = resource
      return structuredClone(resource)
    })
  }

  async delete(kind: AiResourceKind, id: string): Promise<{ id: string; deleted: true }> {
    const result = await this.transaction(state => {
      const resource = state.aiResources.find(item => item.id === id && item.kind === kind)
      if (!resource) throw new Error('AI 资源不存在')
      if (resource.builtIn) throw new Error('内置工具不可删除，只能停用')
      if (resource.kind === 'mcp' && state.aiResources.some(item => item.kind === 'tool' && item.mcpServerId === resource.id)) throw new Error('MCP 服务仍被工具引用，无法删除')
      if (resource.kind === 'tool' && state.aiResources.some(item => item.kind === 'skill' && item.toolIds.includes(resource.key))) throw new Error('工具仍被 Skill 引用，无法删除')
      if (resource.kind === 'tool' && state.agentConfigurationDrafts.some(draft => Object.values(draft.agents).some(agent => agent.definition.toolIds?.includes(resource.key)))) throw new Error('工具仍被 Agent 草稿引用，请先从 Agent 配置移除')
      if (resource.kind === 'tool' && state.agentConfigurationVersions.some(version => version.status === 'active' && version.agentDefinition.toolIds?.includes(resource.key))) throw new Error('工具仍被生效 Agent 版本引用，请先发布移除该工具的新版本')
      if (resource.kind === 'mcp' && state.agentConfigurationDrafts.some(draft => Object.values(draft.agents).some(agent => agent.definition.mcpServerKeys?.includes(resource.key)))) throw new Error('MCP 仍被 Agent 草稿引用，请先从 Agent 配置移除')
      if (resource.kind === 'mcp' && state.agentConfigurationVersions.some(version => version.status === 'active' && version.agentDefinition.mcpBindings?.some(binding => binding.enabled && binding.serverKey === resource.key))) throw new Error('MCP 仍被生效 Agent 版本引用，请先发布移除该 MCP 的新版本')
      if (resource.kind === 'skill' && state.agentConfigurationDrafts.some(draft => Object.values(draft.agents).some(agent => agent.definition.skillKeys?.includes(resource.key)))) throw new Error('Skill 仍被 Agent 草稿引用，请先从 Agent 配置移除')
      if (resource.kind === 'skill' && state.agentConfigurationVersions.some(version => version.status === 'active' && version.agentDefinition.skillBindings?.some(binding => binding.enabled && binding.skillKey === resource.key))) throw new Error('Skill 仍被生效 Agent 版本引用，请先发布移除该 Skill 的新版本')
      state.aiResources = state.aiResources.filter(item => item.id !== id)
      return { id, deleted: true as const, packageStorageKey: resource.kind === 'skill' ? resource.package?.storageKey : undefined }
    })
    if (result.packageStorageKey && this.skillPackages) await this.skillPackages.remove(result.packageStorageKey)
    return { id: result.id, deleted: true }
  }

  async source(id: string) {
    const current = await this.list()
    const resources: AiResource[] = [...current.mcpServers, ...current.skills, ...current.tools]
    const tool = resources.find((item): item is ToolResource => item.id === id && item.kind === 'tool')
    if (!tool) throw new Error('工具不存在')
    if (!['builtin', 'local'].includes(tool.source)) throw new Error('只有内置或本地工具可以查看源码')
    const sourcePath = normalizeSourcePath(tool.sourcePath)
    const candidate = resolve(workspaceRoot, ...sourcePath.split('/'))
    const [actualPath, allowedRoots] = await Promise.all([
      realpath(candidate).catch(() => { throw new Error('工具源码文件不存在') }),
      Promise.all(allowedSourceRoots.map(root => realpath(resolve(workspaceRoot, ...root.split('/'))).catch(() => null))),
    ])
    const insideAllowedRoot = allowedRoots.some(root => root && (actualPath === root || actualPath.startsWith(`${root}${sep}`)))
    if (!insideAllowedRoot) throw new Error('工具源码路径超出允许目录')
    const sourceStat = await stat(actualPath)
    if (!sourceStat.isFile()) throw new Error('工具源码路径不是文件')
    if (sourceStat.size > maximumSourceBytes) throw new Error('工具源码文件超过 512 KB，无法在线查看')
    const extension = extname(actualPath).toLocaleLowerCase()
    return { toolId: tool.id, toolKey: tool.key, path: sourcePath, language: sourceLanguage(extension), content: await readFile(actualPath, 'utf8'), readOnly: true as const }
  }

  private async ensureBuiltIns() {
    await this.transaction(state => {
      state.aiResources = state.aiResources.filter(item => !(item.kind === 'tool' && item.builtIn && retiredBuiltInToolKeys.has(item.key)))
      for (const builtIn of builtInTools) {
        const index = state.aiResources.findIndex(item => item.kind === 'tool' && item.key === builtIn.key)
        if (index < 0) state.aiResources.push(structuredClone(builtIn))
        else if (state.aiResources[index].builtIn) state.aiResources[index] = { ...structuredClone(builtIn), enabled: state.aiResources[index].enabled, createdAt: state.aiResources[index].createdAt, updatedAt: state.aiResources[index].updatedAt }
      }
    })
  }

  private transaction<T>(operation: (draft: Awaited<ReturnType<StateStore['snapshot']>>) => T | Promise<T>): Promise<T> {
    return (this.store.transactionScope
      ? this.store.transactionScope('ai_configuration', operation)
      : this.store.transaction(operation)) as Promise<T>
  }
}

function catalog(resources: AiResource[]): AiResourceCatalog {
  const sorted = [...resources].sort((left, right) => Number(right.builtIn) - Number(left.builtIn) || left.name.localeCompare(right.name, 'zh-CN'))
  return {
    mcpServers: sorted.filter((item): item is McpServerResource => item.kind === 'mcp'),
    skills: sorted.filter((item): item is SkillResource => item.kind === 'skill'),
    tools: sorted.filter((item): item is ToolResource => item.kind === 'tool'),
  }
}

function builtInsNeedSync(resources: AiResource[]) {
  if (resources.some(item => item.kind === 'tool' && item.builtIn && retiredBuiltInToolKeys.has(item.key))) return true
  return builtInTools.some(expected => {
    const actual = resources.find((item): item is ToolResource => item.kind === 'tool' && item.key === expected.key)
    if (!actual?.builtIn) return true
    return JSON.stringify({ ...actual, enabled: true, createdAt: expected.createdAt, updatedAt: expected.updatedAt }) !== JSON.stringify(expected)
  })
}

function builtInTool(key: string, name: string, description: string, version: string, risk: ToolResource['risk'], timeoutMs: number, sourcePath: string): ToolResource {
  return { id: `builtin_tool_${key.replace(/[^a-z0-9]+/giu, '_')}`, kind: 'tool', key, name, description, version, enabled: true, status: 'ready', builtIn: true, source: 'builtin', risk, timeoutMs, sourcePath, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }
}

function normalizeResource(kind: AiResourceKind, input: unknown, fixed: Pick<AiResource, 'id' | 'builtIn' | 'createdAt' | 'updatedAt'>): AiResource {
  const value = object(input)
  const base = {
    ...fixed,
    kind,
    key: key(value.key),
    name: text(value.name, '资源名称', 100),
    description: optionalText(value.description, 1000),
    version: version(value.version),
    enabled: value.enabled !== false,
    status: fixed.builtIn ? 'ready' as const : 'draft' as const,
  }
  if (kind === 'mcp') {
    const transport = oneOf(value.transport, ['streamable_http', 'sse'] as const, 'MCP 传输类型')
    const endpoint = httpUrl(value.endpoint, 'MCP Endpoint')
    const authType = oneOf(value.authType ?? 'none', ['none', 'bearer', 'oauth2'] as const, 'MCP 鉴权类型')
    return { ...base, kind, transport, endpoint, authType, toolIds: keys(value.toolIds) }
  }
  if (kind === 'skill') return { ...base, kind, entrypoint: text(value.entrypoint, 'Skill 入口', 500), toolIds: keys(value.toolIds), tags: stringList(value.tags, 20, 50), package: value.package === undefined ? undefined : skillPackage(value.package) }
  const source = oneOf(value.source ?? 'local', ['builtin', 'local', 'http', 'mcp'] as const, '工具来源')
  if (source === 'builtin' && !fixed.builtIn) throw new Error('不能创建自定义内置工具')
  const risk = oneOf(value.risk ?? 'read', ['read', 'network_read', 'internal_write'] as const, '工具风险')
  const timeoutMs = integer(value.timeoutMs ?? 30_000, '工具超时', 1_000, 300_000)
  const sourcePath = source === 'builtin' || source === 'local' ? normalizeSourcePath(value.sourcePath) : undefined
  const mcpServerId = source === 'mcp' ? text(value.mcpServerId, 'MCP 服务', 200) : undefined
  return { ...base, kind, source, risk, timeoutMs, sourcePath, mcpServerId }
}

function validateUnique(resources: AiResource[], candidate: AiResource) {
  if (resources.some(item => item.kind === candidate.kind && item.key.toLocaleLowerCase() === candidate.key.toLocaleLowerCase())) throw new Error(`已存在相同标识的${kindLabel(candidate.kind)}资源`)
}

function validateReferences(resources: AiResource[], candidate: AiResource) {
  const tools = new Set(resources.filter(item => item.kind === 'tool').map(item => item.key))
  if (candidate.kind === 'skill') {
    const unknown = candidate.toolIds.filter(id => !tools.has(id))
    if (unknown.length) throw new Error(`Skill 引用了未注册工具：${unknown.join('、')}`)
  }
  if (candidate.kind === 'tool' && candidate.source === 'mcp' && !resources.some(item => item.kind === 'mcp' && item.id === candidate.mcpServerId)) throw new Error('请选择已注册的 MCP 服务')
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function text(value: unknown, label: string, maxLength: number) { const result = String(value ?? '').trim(); if (!result) throw new Error(`${label}不能为空`); if (result.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`); return result }
function optionalText(value: unknown, maxLength: number) { const result = String(value ?? '').trim(); if (result.length > maxLength) throw new Error(`描述不能超过 ${maxLength} 个字符`); return result }
function key(value: unknown) { const result = text(value, '资源标识', 100); if (!/^[a-z0-9][a-z0-9._-]*$/u.test(result)) throw new Error('资源标识只能使用小写字母、数字、点、下划线和连字符'); return result }
function version(value: unknown) { const result = text(value ?? '1.0.0', '资源版本', 50); if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/u.test(result)) throw new Error('资源版本格式无效'); return result }
function keys(value: unknown) { return [...new Set(stringList(value, 100, 100).map(item => key(item)))] }
function stringList(value: unknown, maxItems: number, maxLength: number) { if (value === undefined) return []; if (!Array.isArray(value) || value.length > maxItems) throw new Error('列表格式无效'); return value.map(item => text(item, '列表项', maxLength)) }
function integer(value: unknown, label: string, min: number, max: number) { const result = Number(value); if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${label}必须是 ${min} 到 ${max} 之间的整数`); return result }
function oneOf<T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] { if (!allowed.includes(value as T[number])) throw new Error(`${label}无效`); return value as T[number] }
function httpUrl(value: unknown, label: string) { const result = text(value, label, 2000); let parsed: URL; try { parsed = new URL(result) } catch { throw new Error(`${label}必须是有效 URL`) }; if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${label}仅支持 HTTP/HTTPS`); return parsed.toString().replace(/\/$/u, '') }
function kindLabel(kind: AiResourceKind) { return kind === 'mcp' ? ' MCP ' : kind === 'skill' ? ' Skill ' : '工具' }
function skillPackage(value: unknown): SkillPackageMetadata {
  const input = object(value)
  const archiveSha256 = sha256(input.archiveSha256, 'ZIP Hash')
  const contentSha256 = sha256(input.contentSha256, '内容 Hash')
  return {
    storageKey: text(input.storageKey, 'Skill 包存储标识', 160),
    entrypointPath: text(input.entrypointPath, 'Skill 包入口', 500),
    uploadedFileName: text(input.uploadedFileName, 'ZIP 文件名', 200),
    archiveSha256,
    contentSha256,
    fileCount: integer(input.fileCount, 'Skill 文件数', 1, 200),
    unpackedBytes: integer(input.unpackedBytes, 'Skill 解压大小', 1, 50 * 1024 * 1024),
    files: stringList(input.files, 200, 500),
  }
}
function sha256(value: unknown, label: string) { const result = text(value, label, 64); if (!/^[a-f0-9]{64}$/u.test(result)) throw new Error(`${label}格式无效`); return result }
function decodeBase64(value: unknown) {
  const encoded = text(value, 'Skill ZIP 内容', 30 * 1024 * 1024)
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length % 4 !== 0) throw new Error('Skill ZIP Base64 格式无效')
  const result = Buffer.from(encoded, 'base64')
  if (result.toString('base64') !== encoded) throw new Error('Skill ZIP Base64 格式无效')
  return result
}
function normalizeSourcePath(value: unknown) {
  const result = text(value, '工具源码路径', 500).replaceAll('\\', '/')
  const segments = result.split('/')
  if (result.startsWith('/') || /^[A-Za-z]:/u.test(result) || segments.some(segment => !segment || segment === '.' || segment === '..')) throw new Error('工具源码路径必须是允许目录内的相对文件路径')
  if (!allowedSourceRoots.some(root => result.startsWith(`${root}/`))) throw new Error(`工具源码只能位于 ${allowedSourceRoots.join(' 或 ')}`)
  if (!['.ts', '.tsx', '.js', '.mjs', '.cjs'].includes(extname(result).toLocaleLowerCase())) throw new Error('工具源码文件类型必须是 TypeScript 或 JavaScript')
  return result
}
function sourceLanguage(extension: string) { return extension === '.ts' || extension === '.tsx' ? 'typescript' : 'javascript' }
