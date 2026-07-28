import { readFile, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { AgentDefinitionVersion } from '../domain/agent-types.js'
import type { SkillResource } from '../domain/types.js'
import type { SkillPackageStore } from '../infrastructure/skill-package-store.js'
import type { StateStore } from '../infrastructure/store.js'
import { applicationRoot, codeRoot } from '../infrastructure/runtime-paths.js'
import { skillConfigurationHash } from '../application/ai-resource-hash.js'

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
      if (skillConfigurationHash(skill) !== binding.configurationHash) throw new Error(`SKILL_BINDING_CHANGED: ${binding.skillKey}@${binding.version}`)
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
    const path = await resolveManualSkill(skill.entrypoint)
    return decodeUtf8(await readFile(path), skill.key)
  }
}

async function resolveManualSkill(entrypoint: string) {
  const normalized = entrypoint.replaceAll('\\', '/')
  if (!normalized.startsWith('ai/skills/') || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('SKILL_ENTRYPOINT_OUTSIDE_ALLOWED_ROOT')
  const roots = [...new Set([resolve(applicationRoot, 'ai/skills'), resolve(codeRoot, 'ai/skills')])]
  for (const root of roots) {
    const actualRoot = await realpath(root).catch(() => null)
    const candidate = await realpath(resolve(root, ...normalized.slice('ai/skills/'.length).split('/'))).catch(() => null)
    if (actualRoot && candidate && (candidate === actualRoot || candidate.startsWith(`${actualRoot}${sep}`))) return candidate
  }
  throw new Error(`SKILL_ENTRYPOINT_NOT_FOUND: ${entrypoint}`)
}

function decodeUtf8(value: Buffer, key: string) {
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(value)
    if (!content.trim()) throw new Error('empty')
    return content
  } catch { throw new Error(`SKILL_CONTENT_INVALID_UTF8: ${key}`) }
}
