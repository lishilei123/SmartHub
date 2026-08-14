import type { AgentSkillSession } from '../agent/skill-runtime.js'
import { defaultBuiltInToolConfigResolver } from './built-in-tool-config.js'
import type { ToolRegistry } from './registry.js'

export function registerSkillActivateTool(registry: ToolRegistry, session: AgentSkillSession) {
  registry.register(defaultBuiltInToolConfigResolver.toDescriptor('skill.activate'), async request => {
    const value = request.arguments as { skillKey?: unknown }
    const skillKey = String(value.skillKey ?? '').trim()
    if (!skillKey) throw new Error('SKILL_KEY_REQUIRED')
    const activated = await session.activate(skillKey)
    return {
      data: {
        workflowStage: session.workflowStage,
        catalogSource: session.catalogSource,
        skillKey: activated.key,
        version: activated.version,
        content: activated.content,
        activatedSkillKeys: session.activatedKeys(),
      },
      terminate: false,
    }
  })
}
