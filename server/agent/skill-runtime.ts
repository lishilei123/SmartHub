import { readFile } from 'node:fs/promises'
import type { AgentDefinitionVersion } from '../domain/agent-types.js'
import type { SkillResource } from '../domain/types.js'
import type { SkillPackageStore } from '../infrastructure/skill-package-store.js'
import type { StateStore } from '../infrastructure/store.js'
import { resolveManualSkillEntrypoint } from '../infrastructure/manual-skill-files.js'
import { matchesSkillConfigurationHash } from '../application/ai-resource-hash.js'

const MAX_SKILL_BYTES = 256 * 1024
const MAX_ALL_SKILLS_BYTES = 512 * 1024

export class AgentSkillRuntime {
  constructor(private readonly store: StateStore, private readonly packages?: SkillPackageStore) {}

  async render(definition: AgentDefinitionVersion) {
    const bindings = definition.skillBindings.filter(binding => binding.enabled)
    if (!bindings.length) return ''
    const state = await this.store.snapshot()
    const sections: string[] = []
    let totalBytes = 0
    for (const binding of bindings) {
      const skill = state.aiResources.find((item): item is SkillResource => item.kind === 'skill' && item.key === binding.skillKey)
      if (!skill || !skill.enabled || skill.version !== binding.version) throw new Error(`SKILL_BINDING_UNAVAILABLE: ${binding.skillKey}@${binding.version}`)
      if (!matchesSkillConfigurationHash(skill, binding.configurationHash)) throw new Error(`SKILL_BINDING_CHANGED: ${binding.skillKey}@${binding.version}`)
      const content = await this.read(skill)
      const bytes = Buffer.byteLength(content, 'utf8')
      if (bytes > MAX_SKILL_BYTES) throw new Error(`SKILL_CONTENT_TOO_LARGE: ${skill.key}`)
      totalBytes += bytes
      if (totalBytes > MAX_ALL_SKILLS_BYTES) throw new Error('SKILL_CONTENT_TOTAL_TOO_LARGE')
      sections.push(`<<<TRUSTED_SKILL key="${skill.key}" version="${skill.version}">>>\n${content.trim()}\n<<<END_TRUSTED_SKILL>>>`)
    }
    return `以下 Skill 是管理员发布并由版本 Hash 固定的工作流指令；其中提及的工具仍受当前 Agent Tool 白名单和服务端权限控制。\n\n${sections.join('\n\n')}`
  }

  private async read(skill: SkillResource) {
    if (skill.package) {
      if (!this.packages) throw new Error(`SKILL_PACKAGE_STORE_UNAVAILABLE: ${skill.key}`)
      return decodeUtf8(await this.packages.read(skill.package.storageKey, skill.package.entrypointPath), skill.key)
    }
    const path = await resolveManualSkillEntrypoint(skill.entrypoint)
    return decodeUtf8(await readFile(path), skill.key)
  }
}

function decodeUtf8(value: Buffer, key: string) {
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(value)
    if (!content.trim()) throw new Error('empty')
    return content
  } catch { throw new Error(`SKILL_CONTENT_INVALID_UTF8: ${key}`) }
}
