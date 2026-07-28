import { createHash } from 'node:crypto'
import type { McpServerResource, SkillResource } from '../domain/types.js'
import type { ToolResource } from '../domain/types.js'

export function skillConfigurationHash(skill: SkillResource) {
  return sha256({ key: skill.key, version: skill.version, entrypoint: skill.entrypoint, contentSha256: skill.package?.contentSha256, toolIds: skill.toolIds, tags: skill.tags })
}

export function mcpPolicyHash(server: McpServerResource) {
  return sha256({ key: server.key, version: server.version, transport: server.transport, endpoint: server.endpoint, authType: server.authType, credentialEnv: server.credentialEnv, toolIds: server.toolIds })
}

export function toolsetContentHash(tools: string[]) { return sha256(tools) }

export function toolConfigurationHash(tool: ToolResource) {
  return sha256({ key: tool.key, version: tool.version, source: tool.source, risk: tool.risk, timeoutMs: tool.timeoutMs, sourcePath: tool.sourcePath, mcpServerId: tool.mcpServerId, endpoint: tool.endpoint, authType: tool.authType, credentialEnv: tool.credentialEnv, parameters: tool.parameters })
}

export function toolBindingToken(tool: Pick<ToolResource, 'key' | 'version' | 'builtIn'> & Partial<ToolResource>) {
  return tool.builtIn ? `${tool.key}@${tool.version}` : `${tool.key}@${tool.version}#${toolConfigurationHash(tool as ToolResource)}`
}

function sha256(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
