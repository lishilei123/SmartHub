import type { AgentDefinitionResolver, AgentDefinitionVersion } from '../domain/agent-types.js'
import { createAgentDefinitionVersion } from './requirement-analysis-agent.js'
import type { AgentDefinitionConfigDictionary } from './agent-definition-config.js'
import { defaultAgentDefinitionConfigDictionary } from './agent-definition-config.js'

export class DynamicAgentDefinitionResolver implements AgentDefinitionResolver {
  constructor(private readonly configurations: AgentDefinitionConfigDictionary) {}

  resolve(agentKey: AgentDefinitionVersion['agentKey']): AgentDefinitionVersion {
    const configKey = agentKey
    const config = this.configurations[agentKey]
    if (!config) throw new Error(`AGENT_DEFINITION_NOT_FOUND: ${agentKey as string}`)
    return createAgentDefinitionVersion({
      agentKey: configKey as AgentDefinitionVersion['agentKey'],
      agentType: config.agentType,
      resultSchemaVersion: config.resultSchemaVersion,
      version: config.version,
      systemPrompt: config.systemPrompt,
      taskTemplate: config.taskTemplate,
      promptKey: config.promptKey,
      tools: config.tools,
      skills: config.skills,
      mcps: config.mcps,
      limits: config.limits,
      modelScene: config.modelScene,
    })
  }
}

export const defaultAgentDefinitionResolver = new DynamicAgentDefinitionResolver(defaultAgentDefinitionConfigDictionary)
