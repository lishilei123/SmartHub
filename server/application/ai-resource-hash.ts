import { createHash } from 'node:crypto'
import type { McpServerResource, SkillResource } from '../domain/types.js'
import type { ToolResource } from '../domain/types.js'
import { isSkillRuntimeToolId, requiredSkillRuntimeToolIds } from './skill-runtime-policy.js'
import { defaultBuiltInToolConfigResolver } from '../tools/built-in-tool-config.js'

export function skillConfigurationHash(skill: SkillResource) {
  return sha256(skillHashPayload(skill, skill.toolIds.filter(toolId => !isSkillRuntimeToolId(toolId))))
}

export function matchesSkillConfigurationHash(skill: SkillResource, expected: string) {
  if (skillConfigurationHash(skill) === expected) return true
  return legacySkillConfigurationHash(skill) === expected
}

export function legacySkillConfigurationHash(skill: SkillResource) {
  const legacyToolIds = [...new Set([...skill.toolIds.filter(toolId => !isSkillRuntimeToolId(toolId)), ...requiredSkillRuntimeToolIds(skill.runtime)])]
  return sha256(skillHashPayload(skill, legacyToolIds))
}

export function mcpPolicyHash(server: McpServerResource) {
  return sha256({ key: server.key, version: server.version, transport: server.transport, endpoint: server.endpoint, authType: server.authType, credentialEnv: server.credentialEnv, toolIds: server.toolIds })
}

export function toolsetContentHash(tools: string[]) { return sha256(tools) }

export function toolConfigurationHash(tool: ToolResource) {
  return sha256({ key: tool.key, version: tool.version, source: tool.source, risk: tool.risk, timeoutMs: tool.timeoutMs, sourcePath: tool.sourcePath, mcpServerId: tool.mcpServerId, endpoint: tool.endpoint, authType: tool.authType, credentialEnv: tool.credentialEnv, parameters: tool.parameters })
}

export function builtInToolBindingToken(key: string, resolver = defaultBuiltInToolConfigResolver) {
  const config = resolver.get(key)
  return `${key}@${config.version}#${sha256({ key, config })}`
}

export function toolBindingToken(tool: Pick<ToolResource, 'key' | 'version' | 'builtIn'> & Partial<ToolResource>) {
  return tool.builtIn ? builtInToolBindingToken(tool.key) : `${tool.key}@${tool.version}#${toolConfigurationHash(tool as ToolResource)}`
}

function skillHashPayload(skill: SkillResource, toolIds: string[]) { return { key: skill.key, version: skill.version, entrypoint: skill.entrypoint, contentSha256: skill.package?.contentSha256, toolIds, tags: skill.tags, runtime: skill.runtime } }

function sha256(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
