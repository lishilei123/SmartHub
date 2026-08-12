import { createHash, randomUUID } from 'node:crypto'
import { createAgentDefinitionVersion } from '../agent/requirement-analysis-agent.js'
import { defaultAgentDefinitionResolver } from '../agent/dynamic-agent-definition-resolver.js'
import type { AgentDefinitionResolver, AgentDefinitionVersion } from '../domain/agent-types.js'
import type { AgentConfigurationAgentDraft, AgentConfigurationAgentKey, AgentConfigurationDraft, AgentConfigurationVersion, AgentDefinitionDraft, AgentModelReference, AgentRoutingConfiguration, DatabaseState, McpServerResource, SkillResource, ToolResource } from '../domain/types.js'
import type { StateStore } from '../infrastructure/store.js'
import { mcpPolicyHash, skillConfigurationHash, toolBindingToken } from './ai-resource-hash.js'
import { isSkillRuntimeToolId, requiredSkillRuntimeToolIds } from './skill-runtime-policy.js'
import { defaultBuiltInToolConfigResolver } from '../tools/built-in-tool-config.js'

const SCENE = 'requirement_analysis' as const
const AGENT_KEYS = ['requirementAnalysis', 'testDesign'] as const
const RETIRED_TOOL_KEYS = new Set(['evidence.validate_batch', 'review.answer_submit', 'requirement-points.submit_result', 'review.submit_result', 'technical_solution.input.read', 'technical_solution.evidence.preview', 'technical_solution_points.submit_result', 'technical_solution_review.submit_result', 'test_analysis.submit_result', 'functional_test_design.submit_result', 'non_functional_test_design.submit_result', 'test_case_synthesis.submit_result'])
const REQUIRED_ANALYSIS_TOOL = 'requirement-analysis.submit_result'
const REQUIRED_TEST_DESIGN_TOOLS = ['test_design_points.submit_result', 'test_design_cases.submit_result', 'test_design_repair.submit_result'] as const
const REQUIRED_SKILLS: Record<AgentConfigurationAgentKey, readonly string[]> = {
  requirementAnalysis: ['requirement.baseline', 'requirement.review', 'requirement.repair', 'requirement.verification', 'requirement.release'],
  testDesign: ['test-design-baseline', 'test-point-design', 'test-case-design', 'test-design-repair'],
}
const REQUIRED_MCPS: Record<AgentConfigurationAgentKey, readonly string[]> = {
  requirementAnalysis: [],
  testDesign: [],
}

export type AgentConfigurationInput = {
  agentKey: AgentConfigurationAgentKey
  revision: number
  routing: AgentRoutingConfiguration
  definition: AgentDefinitionDraft
}

export class AgentConfigurationService implements AgentDefinitionResolver {
  constructor(private readonly store: StateStore) {}

  async get() {
    const configuration = this.store.getAgentConfigurationState
      ? await Promise.all([this.store.getAgentConfigurationState(SCENE), this.store.getAgentConfigurationState('test_design')]).then(([primary, testDesign]) => ({ draft: primary.draft, versions: [...primary.versions, ...testDesign.versions] }))
      : await this.store.snapshot().then(state => ({
        draft: state.agentConfigurationDrafts.find(item => item.scene === SCENE) ?? null,
        versions: state.agentConfigurationVersions.filter(item => item.scene === SCENE || item.scene === 'test_design'),
      }))
    const draft = normalizeStoredDraft(configuration.draft ?? undefined)
    const versions = expandStoredVersions(configuration.versions)
    return {
      scene: SCENE,
      agents: {
        requirementAnalysis: agentState('requirementAnalysis', draft, versions),
        testDesign: agentState('testDesign', draft, versions),
      },
    }
  }

  async getVersion(id: string) {
    const configuration = this.store.getAgentConfigurationState
      ? await Promise.all([this.store.getAgentConfigurationState(SCENE), this.store.getAgentConfigurationState('test_design')]).then(([primary, testDesign]) => ({ draft: primary.draft, versions: [...primary.versions, ...testDesign.versions] }))
      : await this.store.snapshot().then(state => ({ draft: null, versions: state.agentConfigurationVersions.filter(item => item.scene === SCENE || item.scene === 'test_design') }))
    const versions = expandStoredVersions(configuration.versions)
    return structuredClone(required(versions.find(item => item.id === id), 'Agent 配置版本不存在'))
  }

  async resolveVersion(id: string) { return this.getVersion(id) }

  async save(input: AgentConfigurationInput) {
    const agentKey = normalizeAgentKey(input.agentKey)
    return await this.transaction(state => {
      migrateState(state)
      const normalized = normalizeAgentDraft(agentKey, input, state)
      const index = state.agentConfigurationDrafts.findIndex(item => item.scene === SCENE)
      const draft = index < 0 ? defaultDraft() : state.agentConfigurationDrafts[index]
      const current = draft.agents[agentKey]
      if (input.revision !== current.revision) throw new Error(`${agentLabel(agentKey)}草稿已被其他操作更新，请刷新后重试`)
      const value: AgentConfigurationAgentDraft = { ...normalized, revision: current.revision + 1, updatedAt: new Date().toISOString() }
      const next: AgentConfigurationDraft = { ...draft, agents: { ...draft.agents, [agentKey]: value } }
      if (index < 0) state.agentConfigurationDrafts.push(next)
      else state.agentConfigurationDrafts[index] = next
      return structuredClone(value)
    })
  }

  async publish(input: { agentKey: AgentConfigurationAgentKey; revision: number; publishedBy?: string }) {
    const agentKey = normalizeAgentKey(input.agentKey)
    return await this.transaction(state => {
      migrateState(state)
      const draft = required(state.agentConfigurationDrafts.find(item => item.scene === SCENE), `请先保存${agentLabel(agentKey)}草稿`)
      const agentDraft = draft.agents[agentKey]
      if (agentDraft.revision !== input.revision) throw new Error(`${agentLabel(agentKey)}草稿已更新，请刷新后再发布`)
      validatePublishable(agentKey, agentDraft, state)
      const scene = configurationScene(agentKey)
      const version = Math.max(0, ...state.agentConfigurationVersions.filter(item => item.scene === scene && item.agentKey === agentKey).map(item => item.version)) + 1
      const agentDefinition = publishedDefinition(agentKey, agentDraft.definition, version, state)
      state.agentConfigurationVersions.forEach(item => { if (item.scene === scene && item.agentKey === agentKey && item.status === 'active') item.status = 'superseded' })
      const createdAt = new Date().toISOString()
      const valueWithoutHash = {
        id: `agent_config_${randomUUID()}`,
        scene,
        agentKey,
        version,
        status: 'active' as const,
        routing: structuredClone(agentDraft.routing),
        agentDefinition,
        createdAt,
        publishedBy: cleanText(input.publishedBy, 80) || '系统管理员',
      }
      const value: AgentConfigurationVersion = {
        ...valueWithoutHash,
        contentSha256: createHash('sha256').update(JSON.stringify(valueWithoutHash)).digest('hex'),
      }
      state.agentConfigurationVersions.push(value)
      return structuredClone(value)
    })
  }

  async resolveActive(agentKey: AgentDefinitionVersion['agentKey']) {
    const key = configurationKey(agentKey)
    const scene = configurationScene(key)
    if (this.store.getActiveAgentConfiguration) {
      const value = await this.store.getActiveAgentConfiguration(scene, key)
      return value ? normalizeStoredVersion(value, key) : null
    }
    const state = await this.store.snapshot()
    const versions = expandStoredVersions(state.agentConfigurationVersions.filter(item => item.scene === scene))
    return structuredClone(versions.find(item => item.agentKey === key && item.status === 'active') ?? null)
  }

  async resolve(agentKey: AgentDefinitionVersion['agentKey']) {
    const active = await this.resolveActive(agentKey)
    if (!active) return defaultDefinition(configurationKey(agentKey))
    return structuredClone(active.agentDefinition)
  }

  private transaction<T>(operation: (draft: Awaited<ReturnType<StateStore['snapshot']>>) => T | Promise<T>): Promise<T> {
    return (this.store.transactionScope
      ? this.store.transactionScope('ai_configuration', operation)
      : this.store.transaction(operation)) as Promise<T>
  }
}

function agentState(agentKey: AgentConfigurationAgentKey, draft: AgentConfigurationDraft, versions: AgentConfigurationVersion[]) {
  const agentVersions = versions.filter(item => item.agentKey === agentKey).sort((left, right) => right.version - left.version)
  return {
    draft: structuredClone(draft.agents[agentKey]),
    requiredToolIds: requiredTools(agentKey),
    requiredSkillKeys: [...REQUIRED_SKILLS[agentKey]],
    requiredMcpServerKeys: [...REQUIRED_MCPS[agentKey]],
    activeVersion: structuredClone(agentVersions.find(item => item.status === 'active') ?? null),
    versions: agentVersions.map(versionSummary),
  }
}

function defaultDraft(): AgentConfigurationDraft {
  return {
    scene: SCENE,
    agents: {
      requirementAnalysis: defaultAgentDraft('requirementAnalysis'),
      testDesign: defaultAgentDraft('testDesign'),
    },
  }
}

function defaultAgentDraft(agentKey: AgentConfigurationAgentKey): AgentConfigurationAgentDraft {
  return {
    revision: 0,
    routing: defaultRouting(),
    definition: definitionDraft(defaultDefinition(agentKey)),
    updatedAt: new Date(0).toISOString(),
  }
}

function defaultRouting(): AgentRoutingConfiguration {
  return {
    primaryModel: null,
    fallbackModels: [],
    intelligentRouting: true,
    fallbackEnabled: true,
    maxOutputTokens: 8_192,
    requestTimeoutSeconds: 120,
    retryCount: 2,
    structuredOutput: true,
  }
}

function definitionDraft(value: AgentDefinitionVersion): AgentDefinitionDraft {
  return { systemPrompt: value.systemPrompt, taskTemplate: value.taskTemplate, skillKeys: value.skillBindings.filter(item => item.enabled).map(item => item.skillKey), mcpServerKeys: value.mcpBindings.filter(item => item.enabled).map(item => item.serverKey), toolIds: [...value.toolIds], limits: structuredClone(value.limits) }
}

function normalizeAgentDraft(agentKey: AgentConfigurationAgentKey, input: AgentConfigurationInput, state: DatabaseState): Omit<AgentConfigurationAgentDraft, 'revision' | 'updatedAt'> {
  if (!Number.isInteger(input.revision) || input.revision < 0) throw new Error(`${agentLabel(agentKey)}草稿 revision 无效`)
  return {
    routing: normalizeRouting(input.routing),
    definition: normalizeAgent(input.definition, agentLabel(agentKey), requiredTools(agentKey), REQUIRED_SKILLS[agentKey], REQUIRED_MCPS[agentKey], state),
  }
}

function normalizeRouting(value: AgentRoutingConfiguration): AgentRoutingConfiguration {
  if (!value || typeof value !== 'object') throw new Error('模型与路由配置不能为空')
  const maxOutputTokens = integer(value.maxOutputTokens, '最大输出 Token', 1_024, 262_144)
  const requestTimeoutSeconds = integer(value.requestTimeoutSeconds, '请求超时', 10, 3_600)
  const retryCount = integer(value.retryCount, '失败重试次数', 0, 5)
  const primaryModel = modelReference(value.primaryModel)
  const fallbackModels = uniqueModelReferences(Array.isArray(value.fallbackModels) ? value.fallbackModels.map(modelReference).filter((item): item is AgentModelReference => Boolean(item)) : [])
    .filter(item => !primaryModel || modelKey(item) !== modelKey(primaryModel))
  return {
    primaryModel,
    fallbackModels,
    intelligentRouting: value.intelligentRouting === true,
    fallbackEnabled: value.fallbackEnabled === true,
    maxOutputTokens,
    requestTimeoutSeconds,
    retryCount,
    structuredOutput: value.structuredOutput !== false,
  }
}

function normalizeAgent(value: AgentDefinitionDraft | undefined, label: string, requiredToolIds: readonly string[], requiredSkillKeys: readonly string[], requiredMcpServerKeys: readonly string[], state: DatabaseState): AgentDefinitionDraft {
  if (!value) throw new Error(`${label}配置不能为空`)
  const systemPrompt = cleanRequired(value.systemPrompt, `${label}系统 Prompt`, 100_000)
  const taskTemplate = cleanRequired(value.taskTemplate, `${label}任务模板`, 50_000)
  const toolIds = normalizeToolIds(value.toolIds, label, state)
  const missingRequiredTools = requiredToolIds.filter(toolId => !toolIds.includes(toolId))
  if (missingRequiredTools.length) throw new Error(`${label}必须保留结果提交工具和受控工具 ${missingRequiredTools.join('、')}`)
  const skillKeys = normalizeSkillKeys(value.skillKeys, requiredSkillKeys, label, state)
  const mcpServerKeys = normalizeMcpServerKeys(value.mcpServerKeys, requiredMcpServerKeys, label, state)
  validateCapabilityDependencies(toolIds, skillKeys, mcpServerKeys, label, state)
  const limits = value.limits
  if (!limits || typeof limits !== 'object') throw new Error(`${label}运行限制不能为空`)
  return {
    systemPrompt,
    taskTemplate,
    skillKeys,
    mcpServerKeys,
    toolIds,
    limits: {
      maxTurns: integer(limits.maxTurns, `${label}最大轮次`, 4, 100),
      maxToolCalls: integer(limits.maxToolCalls, `${label}最大工具调用`, 1, 200),
      deadlineMs: integer(limits.deadlineMs, `${label}总截止时间`, 30_000, 3_600_000),
      toolTimeoutMs: integer(limits.toolTimeoutMs, `${label}工具超时`, 1_000, 300_000),
      maxCandidateBytes: integer(limits.maxCandidateBytes, `${label}最大结果字节`, 16_384, 2_097_152),
      maxFindings: integer(limits.maxFindings, `${label}最大分析数`, 0, 1_000),
      maxRepeatedToolCall: integer(limits.maxRepeatedToolCall, `${label}重复工具调用限制`, 1, 20),
      reasoningEffort: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(limits.reasoningEffort)) ? limits.reasoningEffort : 'medium',
      ...(limits.reservedOutputTokens == null ? {} : { reservedOutputTokens: integer(limits.reservedOutputTokens, `${label}预留输出 Token`, 1_024, 262_144) }),
      ...(limits.correctionReserveTokens == null ? {} : { correctionReserveTokens: integer(limits.correctionReserveTokens, `${label}修正预留 Token`, 1_024, 262_144) }),
    },
  }
}

function validateCapabilityDependencies(toolIds: string[], skillKeys: string[], mcpServerKeys: string[], label: string, state: DatabaseState) {
  const selectedTools = new Set(toolIds)
  for (const skill of resolveSkills(skillKeys, state)) {
    const missing = skill.toolIds.filter(toolId => !isSkillRuntimeToolId(toolId) && !selectedTools.has(toolId))
    if (missing.length) throw new Error(`${label}选择的 Skill ${skill.key} 依赖未选择工具：${missing.join('、')}`)
  }
  const selectedMcps = new Set(mcpServerKeys)
  const mcps = state.aiResources.filter((item): item is McpServerResource => item.kind === 'mcp')
  const tools = state.aiResources.filter((item): item is ToolResource => item.kind === 'tool')
  for (const toolId of toolIds) {
    const tool = tools.find(item => item.key === toolId && item.source === 'mcp')
    if (!tool) continue
    const server = mcps.find(item => item.id === tool.mcpServerId)
    if (!server || !selectedMcps.has(server.key)) throw new Error(`${label}选择的 MCP 工具 ${tool.key} 必须同时选择其 MCP 服务`)
    if (!server.toolIds.includes(tool.key)) throw new Error(`${label}选择的工具 ${tool.key} 不在 MCP ${server.key} 的允许范围内`)
  }
}

function validatePublishable(agentKey: AgentConfigurationAgentKey, draft: AgentConfigurationAgentDraft, state: DatabaseState) {
  normalizeToolIds(draft.definition.toolIds, agentLabel(agentKey), state)
  normalizeSkillKeys(draft.definition.skillKeys, REQUIRED_SKILLS[agentKey], agentLabel(agentKey), state)
  normalizeMcpServerKeys(draft.definition.mcpServerKeys, REQUIRED_MCPS[agentKey], agentLabel(agentKey), state)
  const primary = required(draft.routing.primaryModel, `发布${agentLabel(agentKey)}前必须选择默认模型`)
  const references = [primary, ...(draft.routing.fallbackEnabled ? draft.routing.fallbackModels : [])]
  references.forEach((reference, index) => {
    const source = required(state.modelSources.find(item => item.id === reference.sourceId), `${agentLabel(agentKey)}${index ? '回退' : '默认'}模型来源不存在`)
    const model = required(source.models.find(item => item.id === reference.modelId), `${agentLabel(agentKey)}${index ? '回退' : '默认'}模型不存在`)
    if (!source.enabled || !model.enabled) throw new Error(`${source.name} · ${model.displayName} 未启用`)
    if (model.health !== 'healthy') throw new Error(`${source.name} · ${model.displayName} 尚未通过健康探测`)
    if (!model.qualityGate?.passed || model.qualityGate.version !== 'model-probe/v2') throw new Error(`${source.name} · ${model.displayName} 尚未通过 model-probe/v2 质量门禁`)
    if (!model.capabilities.includes('tool_calling')) throw new Error(`${source.name} · ${model.displayName} 不支持工具调用`)
    if (draft.routing.structuredOutput && !model.capabilities.includes('structured_output')) throw new Error(`${source.name} · ${model.displayName} 不支持结构化输出`)
  })
}

function publishedDefinition(agentKey: AgentConfigurationAgentKey, value: AgentDefinitionDraft, configurationVersion: number, state: DatabaseState) {
  const builtIn = defaultDefinition(agentKey)
  const selectedSkills = resolveSkills(value.skillKeys, state)
  const skills = selectedSkills.map(skill => ({
    skillKey: skill.key,
    version: skill.version,
    enabled: true,
    configurationHash: skillConfigurationHash(skill),
  }))
  const mcps = resolveMcps(value.mcpServerKeys, state).map(server => ({
    serverKey: server.key,
    version: server.version,
    enabled: true,
    toolIds: [...server.toolIds],
    policyHash: mcpPolicyHash(server),
  }))
  const runtimeToolIds = selectedSkills.flatMap(skill => requiredSkillRuntimeToolIds(skill.runtime))
  const tools = resolveTools([...new Set([...value.toolIds, ...runtimeToolIds])], state).map(tool => toolBindingToken(tool))
  return createAgentDefinitionVersion({
    agentKey: builtIn.agentKey,
    agentType: builtIn.agentType,
    resultSchemaVersion: builtIn.resultSchemaVersion,
    modelScene: builtIn.modelScene,
    version: `${builtIn.version}+config.${configurationVersion}`,
    systemPrompt: value.systemPrompt,
    taskTemplate: value.taskTemplate,
    promptKey: builtIn.promptRef.promptKey,
    tools,
    skills,
    mcps,
    limits: value.limits,
  })
}

function versionSummary(value: AgentConfigurationVersion) {
  return { id: value.id, agentKey: value.agentKey, version: value.version, status: value.status, createdAt: value.createdAt, publishedBy: value.publishedBy, contentSha256: value.contentSha256, primaryModel: value.routing.primaryModel }
}

function normalizeStoredDraft(value: AgentConfigurationDraft | undefined): AgentConfigurationDraft {
  if (!value) return defaultDraft()
  const raw = value as unknown as { agents?: Record<string, AgentConfigurationAgentDraft | undefined> }
  const agents = raw.agents ?? {}
  return {
    scene: SCENE,
    agents: {
      requirementAnalysis: normalizeStoredAgentDraft(agents.requirementAnalysis, 'requirementAnalysis'),
      testDesign: normalizeStoredAgentDraft(agents.testDesign, 'testDesign'),
    },
  }
}

function normalizeStoredAgentDraft(value: AgentConfigurationAgentDraft | undefined, agentKey: AgentConfigurationAgentKey): AgentConfigurationAgentDraft {
  const fallback = defaultAgentDraft(agentKey)
  const definition = value?.definition ?? fallback.definition
  return {
    ...fallback,
    ...structuredClone(value),
    routing: normalizeRouting(value?.routing ?? fallback.routing),
    definition: {
      ...fallback.definition,
      ...structuredClone(definition),
      skillKeys: requiredKeys(stringKeys(definition.skillKeys), REQUIRED_SKILLS[agentKey]),
      mcpServerKeys: requiredKeys(stringKeys(definition.mcpServerKeys), REQUIRED_MCPS[agentKey]),
      toolIds: requiredKeys(activeToolKeys(definition.toolIds), requiredTools(agentKey)),
    },
  }
}

function expandStoredVersions(values: AgentConfigurationVersion[]): AgentConfigurationVersion[] {
  return values.flatMap(value => {
    const raw = value as unknown as { agentKey?: string; agentDefinition?: AgentDefinitionVersion }
    if (!raw.agentKey || !raw.agentDefinition || !AGENT_KEYS.includes(raw.agentKey as typeof AGENT_KEYS[number])) return []
    return [normalizeStoredVersion(value, raw.agentKey as AgentConfigurationAgentKey)]
  })
}

function normalizeStoredVersion(value: AgentConfigurationVersion, agentKey: AgentConfigurationVersion['agentKey']): AgentConfigurationVersion {
  return { ...structuredClone(value), agentKey, routing: normalizeRouting(value.routing) }
}

function migrateState(state: DatabaseState) {
  const draftIndex = state.agentConfigurationDrafts.findIndex(item => item.scene === SCENE)
  if (draftIndex >= 0) state.agentConfigurationDrafts[draftIndex] = normalizeStoredDraft(state.agentConfigurationDrafts[draftIndex])
  const current = state.agentConfigurationVersions.filter(item => item.scene === SCENE)
  const retained = expandStoredVersions(current)
  if (retained.length !== current.length) {
    state.agentConfigurationVersions = [...state.agentConfigurationVersions.filter(item => item.scene !== SCENE), ...retained]
  }
}

function defaultDefinition(agentKey: AgentConfigurationAgentKey) {
  return defaultAgentDefinitionResolver.resolve(configurationAgentKey(agentKey))
}

function configurationAgentKey(agentKey: AgentConfigurationAgentKey): AgentDefinitionVersion['agentKey'] {
  return agentKey === 'requirementAnalysis' ? 'requirement-analysis' : 'test-design'
}
function configurationScene(agentKey: AgentConfigurationAgentKey): AgentConfigurationVersion['scene'] { return agentKey === 'testDesign' ? 'test_design' : SCENE }
function configurationKey(agentKey: AgentDefinitionVersion['agentKey']): AgentConfigurationAgentKey { return agentKey === 'requirement-analysis' ? 'requirementAnalysis' : 'testDesign' }
function normalizeAgentKey(value: AgentConfigurationAgentKey) { if (!AGENT_KEYS.includes(value)) throw new Error('Agent 标识无效'); return value }
function agentLabel(agentKey: AgentConfigurationAgentKey) { return agentKey === 'requirementAnalysis' ? '需求分析 Agent' : '测试设计 Agent' }
function requiredTool(agentKey: AgentConfigurationAgentKey) { return agentKey === 'requirementAnalysis' ? REQUIRED_ANALYSIS_TOOL : REQUIRED_TEST_DESIGN_TOOLS[0] }
function requiredTools(agentKey: AgentConfigurationAgentKey) { return agentKey === 'requirementAnalysis' ? ['skill.activate', requiredTool(agentKey), 'requirement-repair.submit_result', 'requirement-release.submit_result'] : ['workspace.read_file', 'workspace.grep_files', 'workspace.find_files', 'workspace.list_directory', 'knowledge.search', 'knowledge.read_chunk', 'skill.activate', ...REQUIRED_TEST_DESIGN_TOOLS] }
function modelReference(value: AgentModelReference | null | undefined) { if (!value) return null; const sourceId = cleanText(value.sourceId, 200); const modelId = cleanText(value.modelId, 200); return sourceId && modelId ? { sourceId, modelId } : null }
function uniqueModelReferences(values: AgentModelReference[]) { return [...new Map(values.map(item => [modelKey(item), item])).values()] }
function modelKey(value: AgentModelReference) { return `${value.sourceId}\u0000${value.modelId}` }
function normalizeSkillKeys(value: unknown, requiredKeys: readonly string[], label: string, state: DatabaseState) {
  const selected = stringKeys(value)
  const skills = state.aiResources.filter((item): item is SkillResource => item.kind === 'skill')
  const skillKeys = [...new Set([...requiredKeys, ...selected])]
  const unknown = skillKeys.filter(key => !skills.some(skill => skill.key === key))
  if (unknown.length) throw new Error(`${label}包含未注册 Skill：${unknown.join('、')}`)
  const unavailable = skillKeys.filter(key => skills.some(skill => skill.key === key && !skill.enabled))
  if (unavailable.length) throw new Error(`${label}包含未启用 Skill：${unavailable.join('、')}`)
  return skillKeys
}
function resolveSkills(skillKeys: string[], state: DatabaseState) {
  const skills = state.aiResources.filter((item): item is SkillResource => item.kind === 'skill')
  return skillKeys.map(key => required(skills.find(skill => skill.key === key && skill.enabled), `Skill ${key} 不存在或未启用`))
}
function normalizeMcpServerKeys(value: unknown, requiredKeys: readonly string[], label: string, state: DatabaseState) {
  const selected = stringKeys(value)
  const servers = state.aiResources.filter((item): item is McpServerResource => item.kind === 'mcp')
  const serverKeys = [...new Set([...requiredKeys, ...selected])]
  const unknown = serverKeys.filter(key => !servers.some(server => server.key === key))
  if (unknown.length) throw new Error(`${label}包含未注册 MCP：${unknown.join('、')}`)
  const unavailable = serverKeys.filter(key => servers.some(server => server.key === key && !server.enabled))
  if (unavailable.length) throw new Error(`${label}包含未启用 MCP：${unavailable.join('、')}`)
  return serverKeys
}
function resolveMcps(serverKeys: string[], state: DatabaseState) {
  const servers = state.aiResources.filter((item): item is McpServerResource => item.kind === 'mcp')
  return serverKeys.map(key => required(servers.find(server => server.key === key && server.enabled), `MCP ${key} 不存在或未启用`))
}
function normalizeToolIds(value: unknown, label: string, state: DatabaseState) {
  const toolIds = stringKeys(value).filter(key => !isSkillRuntimeToolId(key))
  const tools = state.aiResources.filter((item): item is ToolResource => item.kind === 'tool')
  const known = new Set<string>([...defaultBuiltInToolConfigResolver.keys(), ...tools.map(tool => tool.key)])
  const unknown = toolIds.filter(key => !known.has(key))
  if (unknown.length) throw new Error(`${label}包含未注册工具：${unknown.join('、')}`)
  const unavailable = toolIds.filter(key => tools.some(tool => tool.key === key && !tool.enabled))
  if (unavailable.length) throw new Error(`${label}包含未启用工具：${unavailable.join('、')}`)
  return toolIds
}
function resolveTools(toolIds: string[], state: DatabaseState): Array<ToolResource> {
  const tools = state.aiResources.filter((item): item is ToolResource => item.kind === 'tool')
  return toolIds.map(key => tools.find(tool => tool.key === key && tool.enabled) ?? builtInToolReference(key))
}
function builtInToolReference(key: string): ToolResource {
  const definitions: Record<string, { version: string; risk: ToolResource['risk']; timeoutMs: number }> = {
    'workspace.read_file': { version: '1.0.0', risk: 'read', timeoutMs: 30_000 },
    'workspace.grep_files': { version: '1.0.0', risk: 'read', timeoutMs: 30_000 },
    'workspace.find_files': { version: '1.0.0', risk: 'read', timeoutMs: 30_000 },
    'workspace.list_directory': { version: '1.0.0', risk: 'read', timeoutMs: 30_000 },
    'knowledge.search': { version: '1.0.0', risk: 'read', timeoutMs: 30_000 },
    'knowledge.read_chunk': { version: '1.0.0', risk: 'read', timeoutMs: 30_000 },
    'skill.activate': { version: '1.0.0', risk: 'read', timeoutMs: 30_000 },
    'requirement-analysis.submit_result': { version: '1.0.0', risk: 'internal_write', timeoutMs: 30_000 },
    'requirement-repair.submit_result': { version: '1.0.0', risk: 'internal_write', timeoutMs: 30_000 },
    'requirement-release.submit_result': { version: '1.0.0', risk: 'internal_write', timeoutMs: 30_000 },
    'test_design_points.submit_result': { version: '1.0.0', risk: 'internal_write', timeoutMs: 30_000 },
    'test_design_cases.submit_result': { version: '1.1.0', risk: 'internal_write', timeoutMs: 30_000 },
    'test_design_repair.submit_result': { version: '1.1.0', risk: 'internal_write', timeoutMs: 30_000 },
    'skill.execute_script': { version: '1.0.0', risk: 'code_execution', timeoutMs: 120_000 },
    'skill.http_request': { version: '1.0.0', risk: 'network_read', timeoutMs: 60_000 },
  }
  const definition = required(definitions[key], `工具 ${key} 不存在或未启用`)
  return { id: `builtin_tool_${key.replace(/[^a-z0-9]+/giu, '_')}`, kind: 'tool', key, name: key, description: '', version: definition.version, enabled: true, status: 'ready', builtIn: true, source: 'builtin', risk: definition.risk, timeoutMs: definition.timeoutMs, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }
}
function stringKeys(value: unknown) { return [...new Set((Array.isArray(value) ? value : []).map(item => String(item).trim()).filter(Boolean))] }
function activeToolKeys(value: unknown) { return stringKeys(value).filter(key => !RETIRED_TOOL_KEYS.has(key) && !isSkillRuntimeToolId(key)) }
function requiredKeys(selected: readonly string[], requiredValues: readonly string[]) { return [...new Set([...selected, ...requiredValues])] }
function cleanRequired(value: unknown, name: string, max: number) { const result = cleanText(value, max); if (!result) throw new Error(`${name}不能为空`); return result }
function cleanText(value: unknown, max: number) { const result = String(value ?? '').trim(); if (result.length > max) throw new Error(`文本长度不能超过 ${max}`); return result }
function integer(value: unknown, name: string, min: number, max: number) { const result = Number(value); if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${name}必须是 ${min} 到 ${max} 之间的整数`); return result }
function required<T>(value: T | undefined | null, message: string): T { if (value == null) throw new Error(message); return value }
