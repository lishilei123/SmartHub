import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { AiResource, AiResourceKind, McpServerResource, SkillPackageMetadata, SkillResource, ToolResource } from '../domain/types.js'
import type { SkillPackageStore } from '../infrastructure/skill-package-store.js'
import type { StateStore } from '../infrastructure/store.js'
import { applicationRoot, codeRoot, deployedModuleCandidates } from '../infrastructure/runtime-paths.js'
import { isSkillRuntimeToolId, normalizeSkillRuntimePolicy } from './skill-runtime-policy.js'
import { defaultBuiltInToolConfigResolver } from '../tools/built-in-tool-config.js'
import { scanAiExtensions, type AiExtensionCandidate } from '../infrastructure/ai-extension-scanner.js'

export type AiResourceCatalog = {
  mcpServers: McpServerResource[]
  skills: SkillResource[]
  tools: ToolResource[]
}

const builtInTools: ToolResource[] = defaultBuiltInToolConfigResolver.keys({ catalogVisibleOnly: true }).map(key => defaultBuiltInToolConfigResolver.toToolResource(key))
const builtInSkills: SkillResource[] = [
  builtInSkill('system.structured-summary', '结构化摘要示例', '内置 Skill 示例：把已有材料整理为结论、关键事实和待确认项。', '1.0.0', 'server/skills/structured-summary/SKILL.md', [], ['系统', '摘要', '示例']),
  builtInSkill('requirement.baseline', '需求基线', '读取固定需求正文并建立完整、原子且可追溯到原文证据的需求基线草稿。', '1.0.0', 'server/skills/requirement-baseline/SKILL.md', [], ['需求分析', '基线', 'baseline']),
  builtInSkill('requirement.analysis', '需求分析', '在同一 Session 中完成需求理解、Clarification、Test Focus 与自检。', '1.0.0', 'server/skills/requirement-analysis/SKILL.md', [], ['需求分析', 'clarification', 'traceability']),
  builtInSkill('test-design-baseline', '测试设计基线', '从冻结 Requirement Release、正式用例库或套件建立测试设计事实和变化基线。', '1.2.0', 'server/skills/test-design-baseline/SKILL.md', [], ['测试设计', '基线', 'workspace']),
  builtInSkill('test-case-design', '测试用例设计', '生成按维度区分的 executionSpec、测试数据和正式用例库变更 Proposal。', '1.2.0', 'server/skills/test-case-design/SKILL.md', [], ['测试设计', '测试用例', 'Proposal']),
  builtInSkill('test-design-repair', '测试设计修复', '保留 Proposal 与 executionSpec，仅修复 Coverage Audit 标记为 agent_repair 的质量问题。', '1.2.0', 'server/skills/test-design-repair/SKILL.md', [], ['测试设计', '修复', 'coverage']),
  builtInSkill('test-script-generation', '测试脚本生成', '从冻结执行任务生成单文件 Playwright UI 或 API 脚本候选。', '1.0.0', 'server/skills/test-script-generation/SKILL.md', [], ['测试执行', 'Playwright', '脚本生成']),
  builtInSkill('failure-analysis', '执行失败分析', '根据同脚本终态 Attempt 与不可变证据生成失败诊断候选。', '1.0.0', 'server/skills/failure-analysis/SKILL.md', [], ['测试执行', '诊断', '失败分析']),
  builtInSkill('script-repair', '测试脚本修复', '在受保护断言语义不变的前提下修复 Playwright 实现候选。', '1.0.0', 'server/skills/script-repair/SKILL.md', [], ['测试执行', 'Playwright', '脚本修复']),
]
const builtInResources: AiResource[] = [...builtInTools, ...builtInSkills]
const allowedSourceRoots = ['server/tools', 'ai/tools'] as const
const maximumSourceBytes = 512 * 1024

export class AiResourceService {
  private extensionReloadTimer?: NodeJS.Timeout
  private synchronization?: Promise<void>
  private lastExtensionWarnings = ''

  constructor(
    private readonly store: StateStore,
    private readonly skillPackages?: SkillPackageStore,
    private readonly options: { extensionRoot?: string; reloadIntervalMs?: number } = {},
  ) {}

  async initialize() {
    await this.synchronizeCatalog()
    if (this.extensionReloadTimer) return
    const interval = this.options.reloadIntervalMs ?? 1_000
    if (interval <= 0) return
    this.extensionReloadTimer = setInterval(() => { void this.synchronizeCatalog().catch(error => console.error('AI 外置资源自动重载失败：', message(error))) }, interval)
    this.extensionReloadTimer.unref()
  }

  async close() {
    if (this.extensionReloadTimer) clearInterval(this.extensionReloadTimer)
    this.extensionReloadTimer = undefined
    await this.synchronization
  }

  async list(): Promise<AiResourceCatalog> {
    await this.synchronizeCatalog()
    const resources = this.store.listAiResources ? await this.store.listAiResources() : (await this.store.snapshot()).aiResources
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
        const resource = normalizeResource('skill', { ...value, entrypoint: installed.entrypoint, package: installed.package, runtime: installed.runtime }, { id: `ai_resource_${randomUUID()}`, builtIn: false, createdAt: now, updatedAt: now }) as SkillResource
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
      if (previous.builtIn && update.enabled === false) throw new Error('内置 Tool 和 Skill 始终启用，不可停用')
      if (previous.kind === 'skill' && !previous.package && ('package' in update || String(update.entrypoint ?? '').startsWith('skill-package://'))) throw new Error('Skill 包元数据和受控入口只能由 ZIP 上传生成')
      const merged = { ...previous, ...update, id: previous.id, kind: previous.kind, builtIn: previous.builtIn, createdAt: previous.createdAt, updatedAt: new Date().toISOString() }
      if (previous.kind === 'skill' && previous.package) Object.assign(merged, { key: previous.key, version: previous.version, entrypoint: previous.entrypoint, package: previous.package, runtime: previous.runtime, status: previous.status })
      if (previous.managedBy === 'filesystem') Object.assign(merged, previous, { enabled: typeof update.enabled === 'boolean' ? update.enabled : previous.enabled, updatedAt: new Date().toISOString() })
      if (previous.builtIn) Object.assign(merged, previous, { enabled: true, updatedAt: new Date().toISOString() })
      const resource = normalizeResource(kind, merged, { id: previous.id, builtIn: previous.builtIn, managedBy: previous.managedBy, createdAt: previous.createdAt, updatedAt: merged.updatedAt })
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
      if (resource.builtIn) throw new Error('内置 Tool 和 Skill 不可删除或停用')
      if (resource.managedBy === 'filesystem') throw new Error('外置目录资源由文件系统管理，请删除对应描述文件')
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
    const candidates = deployedModuleCandidates(sourcePath)
    const actualPath = await firstRealPath(candidates)
    const allowedRoots = await Promise.all([...new Set([applicationRoot, codeRoot])].flatMap(base => allowedSourceRoots.map(root => resolve(base, ...root.split('/')))).map(root => realpath(root).catch(() => null)))
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
      state.aiResources = state.aiResources.filter(item => !item.builtIn || isCurrentBuiltInResource(item))
      state.aiResources = state.aiResources.map(item => {
        if (item.builtIn) return item
        if (item.kind === 'mcp') return { ...item, managedBy: item.managedBy ?? 'catalog', status: 'ready', ...(item.authType === 'none' || item.credentialEnv ? {} : { credentialEnv: defaultCredentialEnv('MCP', item.key) }) }
        if (item.kind === 'skill') return { ...item, managedBy: item.managedBy ?? 'catalog', status: 'ready' }
        return { ...item, managedBy: item.managedBy ?? 'catalog', status: item.source !== 'http' || item.endpoint ? 'ready' : 'draft' }
      })
      for (const builtIn of builtInResources) {
        const index = state.aiResources.findIndex(item => item.kind === builtIn.kind && item.key === builtIn.key)
        if (index < 0) state.aiResources.push(structuredClone(builtIn))
        else state.aiResources[index] = { ...structuredClone(builtIn), createdAt: state.aiResources[index].createdAt, updatedAt: state.aiResources[index].updatedAt }
      }
    })
  }

  private synchronizeCatalog() {
    if (this.synchronization) return this.synchronization
    this.synchronization = this.performSynchronization().finally(() => { this.synchronization = undefined })
    return this.synchronization
  }

  private async performSynchronization() {
    let resources = this.store.listAiResources ? await this.store.listAiResources() : (await this.store.snapshot()).aiResources
    if (builtInsNeedSync(resources) || catalogMetadataNeedsSync(resources)) {
      await this.ensureBuiltIns()
      resources = this.store.listAiResources ? await this.store.listAiResources() : (await this.store.snapshot()).aiResources
    }
    const scanned = await scanAiExtensions(this.options.extensionRoot ?? applicationRoot)
    const normalized = normalizeExtensionCandidates(scanned.candidates, resources, scanned.warnings)
    this.reportExtensionWarnings(scanned.warnings)
    const synchronizedAt = new Date().toISOString()
    const next = reconcileExtensions(resources, normalized, synchronizedAt)
    if (JSON.stringify(next) === JSON.stringify(resources)) return
    await this.transaction(state => { state.aiResources = reconcileExtensions(state.aiResources, normalized, synchronizedAt) })
  }

  private reportExtensionWarnings(warnings: string[]) {
    const current = warnings.join('\n')
    if (current === this.lastExtensionWarnings) return
    this.lastExtensionWarnings = current
    for (const warning of warnings) console.warn(`AI 外置资源已跳过：${warning}`)
  }

  private transaction<T>(operation: (draft: Awaited<ReturnType<StateStore['snapshot']>>) => T | Promise<T>): Promise<T> {
    return (this.store.transactionScope
      ? this.store.transactionScope('ai_configuration', operation)
      : this.store.transaction(operation)) as Promise<T>
  }
}

function catalogMetadataNeedsSync(resources: AiResource[]) {
  return resources.some(item => !item.builtIn && (
    !item.managedBy
    || (item.kind === 'mcp' && (item.status !== 'ready' || (item.authType !== 'none' && !item.credentialEnv)))
    || (item.kind === 'skill' && item.status !== 'ready')
    || (item.kind === 'tool' && item.status !== (item.source !== 'http' || item.endpoint ? 'ready' : 'draft'))
  ))
}

async function firstRealPath(candidates: string[]) {
  for (const candidate of candidates) {
    const actual = await realpath(candidate).catch(() => null)
    if (actual) return actual
  }
  throw new Error('工具源码文件不存在')
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
  if (resources.some(item => item.builtIn && !isCurrentBuiltInResource(item))) return true
  return builtInResources.some(expected => {
    const actual = resources.find(item => item.kind === expected.kind && item.key === expected.key)
    if (!actual?.builtIn) return true
    return JSON.stringify({ ...actual, createdAt: expected.createdAt, updatedAt: expected.updatedAt }) !== JSON.stringify(expected)
  })
}

function isCurrentBuiltInResource(resource: AiResource) {
  return builtInResources.some(item => item.kind === resource.kind && item.key === resource.key)
}


function builtInSkill(key: string, name: string, description: string, version: string, entrypoint: string, toolIds: string[], tags: string[]): SkillResource {
  return { id: `builtin_skill_${key.replace(/[^a-z0-9]+/giu, '_')}`, kind: 'skill', key, name, description, version, enabled: true, status: 'ready', builtIn: true, managedBy: 'builtin', entrypoint, toolIds, tags, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }
}

function normalizeResource(kind: AiResourceKind, input: unknown, fixed: Pick<AiResource, 'id' | 'builtIn' | 'createdAt' | 'updatedAt'> & Pick<AiResource, 'managedBy'>): AiResource {
  const value = object(input)
  const base = {
    ...fixed,
    kind,
    key: key(value.key),
    name: text(value.name, '资源名称', 100),
    description: optionalText(value.description, 1000),
    version: version(value.version),
    enabled: value.enabled !== false,
    status: 'ready' as const,
    managedBy: fixed.builtIn ? 'builtin' as const : fixed.managedBy ?? 'catalog' as const,
  }
  if (kind === 'mcp') {
    const transport = oneOf(value.transport, ['streamable_http', 'sse'] as const, 'MCP 传输类型')
    const endpoint = httpUrl(value.endpoint, 'MCP Endpoint')
    const authType = oneOf(value.authType ?? 'none', ['none', 'bearer', 'oauth2'] as const, 'MCP 鉴权类型')
    const credentialEnv = authType === 'none' ? undefined : environmentName(value.credentialEnv ?? defaultCredentialEnv('MCP', String(value.key ?? '')))
    return { ...base, kind, transport, endpoint, authType, credentialEnv, toolIds: keys(value.toolIds) }
  }
  if (kind === 'skill') {
    const runtime = normalizeSkillRuntimePolicy(value.runtime)
    const toolIds = keys(value.toolIds).filter(toolId => !isSkillRuntimeToolId(toolId))
    return { ...base, kind, entrypoint: text(value.entrypoint, 'Skill 入口', 500), toolIds, tags: stringList(value.tags, 20, 50), runtime, package: value.package === undefined ? undefined : skillPackage(value.package), contentSha256: optionalSha256(value.contentSha256) }
  }
  const source = oneOf(value.source ?? 'local', ['builtin', 'local', 'http', 'mcp'] as const, '工具来源')
  if (source === 'builtin' && !fixed.builtIn) throw new Error('不能创建自定义内置工具')
  const risk = oneOf(value.risk ?? 'read', ['read', 'network_read', 'code_execution', 'internal_write', 'write_reversible', 'write_high_risk'] as const, '工具风险')
  const timeoutMs = integer(value.timeoutMs ?? 30_000, '工具超时', 1_000, 300_000)
  const sourcePath = source === 'builtin' || source === 'local' ? normalizeSourcePath(value.sourcePath) : undefined
  const mcpServerId = source === 'mcp' ? text(value.mcpServerId, 'MCP 服务', 200) : undefined
  const endpoint = source === 'http' ? httpUrl(value.endpoint, 'HTTP 工具 Endpoint') : undefined
  const authType = source === 'http' ? oneOf(value.authType ?? 'none', ['none', 'bearer'] as const, 'HTTP 工具鉴权类型') : undefined
  const credentialEnv = source === 'http' && authType === 'bearer' ? environmentName(value.credentialEnv ?? defaultCredentialEnv('HTTP_TOOL', String(value.key ?? ''))) : undefined
  const parameters = source === 'http' ? jsonObjectSchema(value.parameters) : undefined
  return { ...base, kind, source, risk, timeoutMs, sourcePath, mcpServerId, endpoint, authType, credentialEnv, parameters, contentSha256: optionalSha256(value.contentSha256) }
}

function validateUnique(resources: AiResource[], candidate: AiResource) {
  if (candidate.kind === 'tool' && isSkillRuntimeToolId(candidate.key)) throw new Error('Skill 运行能力由运行权限清单管理，不能注册为独立工具')
  if (candidate.kind === 'tool' && !candidate.builtIn && defaultBuiltInToolConfigResolver.has(candidate.key)) throw new Error('内置工具标识由受版本控制的配置保留，不能注册为自定义工具')
  if (resources.some(item => item.kind === candidate.kind && item.key.toLocaleLowerCase() === candidate.key.toLocaleLowerCase())) throw new Error(`已存在相同标识的${kindLabel(candidate.kind)}资源`)
}

function validateReferences(resources: AiResource[], candidate: AiResource) {
  const tools = new Set([...builtInTools.map(item => item.key), ...resources.filter(item => item.kind === 'tool').map(item => item.key)])
  if (candidate.kind === 'skill') {
    const unknown = candidate.toolIds.filter(id => !tools.has(id))
    if (unknown.length) throw new Error(`Skill 引用了未注册工具：${unknown.join('、')}`)
  }
  if (candidate.kind === 'tool' && candidate.source === 'mcp' && !resources.some(item => item.kind === 'mcp' && item.id === candidate.mcpServerId)) throw new Error('请选择已注册的 MCP 服务')
}

function normalizeExtensionCandidates(candidates: AiExtensionCandidate[], resources: AiResource[], warnings: string[]) {
  const normalized: AiResource[] = []
  const ordered = [...candidates].sort((left, right) => Number(left.kind === 'skill') - Number(right.kind === 'skill') || left.source.localeCompare(right.source, 'en'))
  for (const candidate of ordered) {
    try {
      const epoch = new Date(0).toISOString()
      const resource = normalizeResource(candidate.kind, candidate.input, {
        id: extensionResourceId(candidate.kind, candidate.source),
        builtIn: false,
        managedBy: 'filesystem',
        createdAt: epoch,
        updatedAt: epoch,
      })
      const available = [...resources.filter(item => item.managedBy !== 'filesystem'), ...normalized]
      validateUnique(available, resource)
      validateReferences(available, resource)
      normalized.push(resource)
    } catch (error) { warnings.push(`${candidate.source}: ${message(error)}`) }
  }
  return normalized
}

function reconcileExtensions(resources: AiResource[], candidates: AiResource[], synchronizedAt: string) {
  const existing = new Map(resources.filter(item => item.managedBy === 'filesystem').map(item => [item.id, item]))
  const fixed = resources.filter(item => item.managedBy !== 'filesystem')
  const extensions = candidates.map(candidate => {
    const previous = existing.get(candidate.id)
    if (!previous) return { ...candidate, createdAt: synchronizedAt, updatedAt: synchronizedAt }
    const next = { ...candidate, enabled: previous.enabled, createdAt: previous.createdAt, updatedAt: previous.updatedAt }
    return sameExtension(previous, next) ? previous : { ...next, updatedAt: synchronizedAt }
  })
  return [...fixed, ...extensions]
}

function sameExtension(left: AiResource, right: AiResource) {
  return JSON.stringify({ ...left, enabled: true, createdAt: '', updatedAt: '' }) === JSON.stringify({ ...right, enabled: true, createdAt: '', updatedAt: '' })
}

function extensionResourceId(kind: 'skill' | 'tool', source: string) {
  return `filesystem_${kind}_${createHash('sha256').update(source.toLocaleLowerCase()).digest('hex').slice(0, 24)}`
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
function environmentName(value: unknown) { const result = text(value, '凭据环境变量', 200); if (!/^[A-Z_][A-Z0-9_]*$/u.test(result)) throw new Error('凭据环境变量只能使用大写字母、数字和下划线'); return result }
function optionalSha256(value: unknown) { if (value === undefined) return undefined; const result = String(value); if (!/^[a-f0-9]{64}$/u.test(result)) throw new Error('内容 SHA-256 无效'); return result }
function defaultCredentialEnv(prefix: string, resourceKey: string) { return `SMARTHUB_${prefix}_${resourceKey.toLocaleUpperCase().replace(/[^A-Z0-9]+/gu, '_')}_TOKEN` }
function jsonObjectSchema(value: unknown): Record<string, unknown> {
  const schema = value === undefined ? { type: 'object', additionalProperties: true } : object(value)
  if (schema.type !== 'object') throw new Error('工具参数 Schema 的 type 必须是 object')
  if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > 64 * 1024) throw new Error('工具参数 Schema 不能超过 64 KB')
  return structuredClone(schema)
}
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
function message(error: unknown) { return error instanceof Error ? error.message : String(error) }
