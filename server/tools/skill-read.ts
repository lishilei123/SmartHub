import { Type } from 'typebox'
import { SKILL_READ_TOOL_ID } from '../application/skill-runtime-policy.js'
import type { ToolExecutionResult } from '../domain/tool-types.js'
import { ToolRegistry } from './registry.js'

export { SKILL_READ_TOOL_ID }

export function registerSkillReadTool(
  registry: ToolRegistry,
  read: (skillKey: string, signal: AbortSignal) => Promise<ToolExecutionResult>,
) {
  registry.register({
    id: SKILL_READ_TOOL_ID,
    piName: 'skill_read',
    version: '1.0.0',
    label: '读取已启用 Skill',
    description: '按 skillKey 读取当前 Agent 发布配置中已启用且版本绑定的 Skill 正文，并返回本次正文的内容 Hash。若同一版本和内容仍在当前 Planning Session 上下文，返回短引用并应直接复用此前方法。只读，不切换 Workflow Stage、不修改正式状态，也不扩大 Runtime 工具权限。',
    risk: 'read',
    parameters: Type.Object({
      skillKey: Type.String({ minLength: 1, maxLength: 100 }),
    }, { additionalProperties: false }),
    timeoutMs: 30_000,
    idempotent: true,
    repeatPolicy: 'replay_success_once',
  }, async (request, signal) => {
    const input = request.arguments
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('SKILL_READ_ARGUMENTS_INVALID')
    const entries = Object.entries(input as Record<string, unknown>)
    if (entries.length !== 1 || entries[0][0] !== 'skillKey') throw new Error('SKILL_READ_ARGUMENTS_INVALID')
    const skillKey = typeof entries[0][1] === 'string' ? entries[0][1].trim() : ''
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/u.test(skillKey)) throw new Error('SKILL_READ_KEY_INVALID')
    return read(skillKey, signal)
  })
}
