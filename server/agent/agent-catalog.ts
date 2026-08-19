import type { AgentDefinitionVersion } from '../domain/agent-types.js'
import type { AgentConfigurationAgentKey, AgentConfigurationScene } from '../domain/types.js'

const WORKSPACE_TOOLS = [
  'workspace.read_file',
  'workspace.grep_files',
  'workspace.find_files',
  'workspace.list_directory',
] as const

const KNOWLEDGE_TOOLS = [
  'knowledge.search',
  'knowledge.read_chunk',
] as const

export interface AgentCatalogEntry {
  configurationKey: AgentConfigurationAgentKey
  definitionKey: AgentDefinitionVersion['agentKey']
  scene: AgentConfigurationScene
  label: string
  identifier: string
  requiredToolIds: readonly string[]
  requiredSkillKeys: readonly string[]
  requiredMcpServerKeys: readonly string[]
  runtimeToolIds: readonly string[]
  exactCapabilities: boolean
}

export const AGENT_CATALOG = {
  planning: {
    configurationKey: 'planning',
    definitionKey: 'planning',
    scene: 'planning',
    label: 'PlanningAgent',
    identifier: 'PlanningAgent',
    requiredToolIds: [
      ...WORKSPACE_TOOLS,
      ...KNOWLEDGE_TOOLS,
      'requirement-analysis.submit_result',
      'requirement-release.submit_result',
      'test_design_points.submit_result',
      'test_design_cases.submit_result',
      'test_design_repair.submit_result',
    ],
    requiredSkillKeys: [],
    requiredMcpServerKeys: [],
    runtimeToolIds: [...WORKSPACE_TOOLS, ...KNOWLEDGE_TOOLS],
    exactCapabilities: false,
  },
  testScript: {
    configurationKey: 'testScript',
    definitionKey: 'test-script',
    scene: 'test_execution',
    label: '测试脚本 Agent',
    identifier: 'TestScriptAgent',
    requiredToolIds: [...WORKSPACE_TOOLS, 'test_script.submit_result'],
    requiredSkillKeys: ['test-script-generation'],
    requiredMcpServerKeys: [],
    runtimeToolIds: [...WORKSPACE_TOOLS],
    exactCapabilities: true,
  },
  failureAnalysis: {
    configurationKey: 'failureAnalysis',
    definitionKey: 'failure-analysis',
    scene: 'test_execution',
    label: '失败分析 Agent',
    identifier: 'FailureAnalysisAgent',
    requiredToolIds: [...WORKSPACE_TOOLS, 'failure_analysis.submit_result'],
    requiredSkillKeys: ['failure-analysis'],
    requiredMcpServerKeys: [],
    runtimeToolIds: [...WORKSPACE_TOOLS],
    exactCapabilities: true,
  },
  scriptRepair: {
    configurationKey: 'scriptRepair',
    definitionKey: 'script-repair',
    scene: 'test_execution',
    label: '脚本修复 Agent',
    identifier: 'ScriptRepairAgent',
    requiredToolIds: [...WORKSPACE_TOOLS, 'script_repair.submit_result'],
    requiredSkillKeys: ['script-repair'],
    requiredMcpServerKeys: [],
    runtimeToolIds: [...WORKSPACE_TOOLS],
    exactCapabilities: true,
  },
} as const satisfies Record<AgentConfigurationAgentKey, AgentCatalogEntry>

export const AGENT_CONFIGURATION_KEYS = Object.keys(AGENT_CATALOG) as AgentConfigurationAgentKey[]
export const AGENT_DEFINITION_KEYS = AGENT_CONFIGURATION_KEYS.map(key => AGENT_CATALOG[key].definitionKey)
export const AGENT_CONFIGURATION_SCENES = [...new Set(AGENT_CONFIGURATION_KEYS.map(key => AGENT_CATALOG[key].scene))]

const byDefinitionKey = new Map(
  AGENT_CONFIGURATION_KEYS.map(key => [AGENT_CATALOG[key].definitionKey, AGENT_CATALOG[key]]),
)

export function agentCatalogEntry(key: AgentConfigurationAgentKey) {
  return AGENT_CATALOG[key]
}

export function agentCatalogEntryByDefinition(key: AgentDefinitionVersion['agentKey']) {
  const entry = byDefinitionKey.get(key)
  if (!entry) throw new Error(`AGENT_CATALOG_NOT_FOUND: ${key}`)
  return entry
}
