import type { AgentDefinitionVersion } from '../domain/agent-types.js'
import rawConfig from './agents-config.json' with { type: 'json' }

export type AgentDefinitionConfigKey = Exclude<AgentDefinitionVersion['agentKey'], 'technical-solution-analysis'>

export interface AgentDefinitionConfig {
  agentType: AgentDefinitionVersion['agentType']
  modelScene: AgentDefinitionVersion['modelScene']
  resultSchemaVersion: AgentDefinitionVersion['resultSchemaVersion']
  version: string
  promptKey: string
  systemPrompt: string
  taskTemplate: string
  tools: string[]
  skills?: AgentDefinitionVersion['skillBindings']
  mcps?: AgentDefinitionVersion['mcpBindings']
  limits: AgentDefinitionVersion['limits']
}

export interface AgentDefinitionConfigFile {
  schemaVersion: number
  agents: Record<string, AgentDefinitionConfig>
}

export type AgentDefinitionConfigDictionary = Record<string, AgentDefinitionConfig>

const expectedKeys: readonly AgentDefinitionConfigKey[] = [
  'requirement-point-extraction',
  'requirement-review',
  'review-qa',
  'technical-solution-extraction',
  'technical-solution-review',
]

export function validateAgentDefinitionConfig(value: unknown): AgentDefinitionConfigFile {
  if (!value || typeof value !== 'object') throw new Error('AGENT_CONFIG_INVALID: 配置文件必须是对象')
  const candidate = value as Partial<AgentDefinitionConfigFile>
  if (candidate.schemaVersion !== 1) throw new Error(`AGENT_CONFIG_INVALID: 不支持的配置 schemaVersion：${String(candidate.schemaVersion)}`)
  if (!candidate.agents || typeof candidate.agents !== 'object' || Array.isArray(candidate.agents)) throw new Error('AGENT_CONFIG_INVALID: agents 必须是对象')
  const agents: Record<string, AgentDefinitionConfig> = {}
  for (const [agentKey, config] of Object.entries(candidate.agents)) agents[agentKey] = validateAgent(agentKey, config)
  for (const key of expectedKeys) if (!agents[key]) throw new Error(`AGENT_CONFIG_INVALID: 缺少内置 Agent 配置：${key}`)
  return { schemaVersion: 1, agents }
}

function validateAgent(agentKey: string, value: unknown): AgentDefinitionConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`AGENT_CONFIG_INVALID: Agent ${agentKey} 配置必须是对象`)
  const candidate = value as Partial<AgentDefinitionConfig>
  const agentType = requiredString(candidate.agentType, agentKey, 'agentType', 200) as AgentDefinitionVersion['agentType']
  const modelScene = requiredString(candidate.modelScene, agentKey, 'modelScene', 200) as AgentDefinitionVersion['modelScene']
  const resultSchemaVersion = requiredString(candidate.resultSchemaVersion, agentKey, 'resultSchemaVersion', 200) as AgentDefinitionVersion['resultSchemaVersion']
  const version = requiredString(candidate.version, agentKey, 'version', 100)
  const promptKey = requiredString(candidate.promptKey, agentKey, 'promptKey', 200)
  const systemPrompt = requiredString(candidate.systemPrompt, agentKey, 'systemPrompt', 100_000)
  const taskTemplate = requiredString(candidate.taskTemplate, agentKey, 'taskTemplate', 50_000)
  if (!Array.isArray(candidate.tools) || candidate.tools.length === 0 || candidate.tools.some(item => typeof item !== 'string' || !item.trim())) throw new Error(`AGENT_CONFIG_INVALID: Agent ${agentKey} tools 必须是非空字符串数组`)
  return {
    agentType,
    modelScene,
    resultSchemaVersion,
    version,
    promptKey,
    systemPrompt,
    taskTemplate,
    tools: candidate.tools.map(item => item.trim()),
    skills: validateBindings(candidate.skills, agentKey, 'skills'),
    mcps: validateBindings(candidate.mcps, agentKey, 'mcps'),
    limits: validateLimits(candidate.limits, agentKey),
  }
}

function validateBindings<T>(value: T[] | undefined, agentKey: string, field: string): T[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`AGENT_CONFIG_INVALID: Agent ${agentKey} ${field} 必须是数组`)
  return structuredClone(value)
}

function validateLimits(value: AgentDefinitionVersion['limits'] | undefined, agentKey: string): AgentDefinitionVersion['limits'] {
  if (!value || typeof value !== 'object') throw new Error(`AGENT_CONFIG_INVALID: Agent ${agentKey} limits 必须是对象`)
  const limits = value as AgentDefinitionVersion['limits']
  const integerFields: Array<[keyof AgentDefinitionVersion['limits'], number, number]> = [
    ['maxTurns', 4, 100], ['maxToolCalls', 1, 200], ['deadlineMs', 30_000, 3_600_000], ['toolTimeoutMs', 1_000, 300_000],
    ['maxCandidateBytes', 16_384, 2_097_152], ['maxFindings', 0, 1_000], ['maxRepeatedToolCall', 1, 20],
  ]
  for (const [field, min, max] of integerFields) {
    const number = Number(limits[field])
    if (!Number.isInteger(number) || number < min || number > max) throw new Error(`AGENT_CONFIG_INVALID: Agent ${agentKey} limits.${String(field)} 必须是 ${min} 到 ${max} 之间的整数`)
  }
  for (const field of ['reservedOutputTokens', 'correctionReserveTokens'] as const) {
    if (limits[field] === undefined) continue
    const number = Number(limits[field])
    if (!Number.isInteger(number) || number < 1_024 || number > 262_144) throw new Error(`AGENT_CONFIG_INVALID: Agent ${agentKey} limits.${field} 必须是 1024 到 262144 之间的整数`)
  }
  const effort = limits.reasoningEffort
  if (effort !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error(`AGENT_CONFIG_INVALID: Agent ${agentKey} limits.reasoningEffort 无效`)
  return structuredClone(limits)
}

function requiredString(value: unknown, agentKey: string, field: string, maxLength: number) {
  const result = String(value ?? '').trim()
  if (!result) throw new Error(`AGENT_CONFIG_INVALID: Agent ${agentKey} ${field} 不能为空`)
  if (result.length > maxLength) throw new Error(`AGENT_CONFIG_INVALID: Agent ${agentKey} ${field} 不能超过 ${maxLength} 个字符`)
  return result
}

export const defaultAgentDefinitionConfig = validateAgentDefinitionConfig(rawConfig)
export const defaultAgentDefinitionConfigDictionary = defaultAgentDefinitionConfig.agents

export const REQUIREMENT_POINT_EXTRACTION_AGENT_VERSION = defaultAgentDefinitionConfigDictionary['requirement-point-extraction'].version
export const REQUIREMENT_REVIEW_AGENT_VERSION = defaultAgentDefinitionConfigDictionary['requirement-review'].version
export const REVIEW_QA_AGENT_VERSION = defaultAgentDefinitionConfigDictionary['review-qa'].version
