import { readFile } from 'node:fs/promises'
import type { AgentDefinitionVersion } from '../domain/agent-types.js'
import type { SkillResource } from '../domain/types.js'
import type { SkillPackageStore } from '../infrastructure/skill-package-store.js'
import type { StateStore } from '../infrastructure/store.js'
import { resolveManualSkillEntrypoint } from '../infrastructure/manual-skill-files.js'
import { matchesSkillConfigurationHash } from '../application/ai-resource-hash.js'

const MAX_SKILL_BYTES = 256 * 1024
const MAX_ALL_SKILLS_BYTES = 512 * 1024

export interface AgentSkillCatalogEntry {
  key: string
  name: string
  description: string
  version: string
  tags: string[]
}

export interface LoadedAgentSkill extends AgentSkillCatalogEntry {
  content: string
}

export class AgentSkillSession {
  constructor(
    readonly workflowStage: string,
    private readonly skills: LoadedAgentSkill[],
  ) {}

  catalog(): AgentSkillCatalogEntry[] {
    return this.skills.map(skill => ({
      key: skill.key,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      tags: [...skill.tags],
    }))
  }

  renderPrompt() {
    if (!this.skills.length) return `当前 Agent 发布配置没有启用 Skill。直接按 Workflow 任务、Workspace 事实与提交契约执行。`
    return [
      `当前正式业务 Stage：${this.workflowStage}。Workflow 只提供任务与 Gate，不调度 Skill。`,
      '下面是当前 Agent 发布配置中的全部 Enabled Skills 正文。Runtime 已按发布版本、内容 Hash 和绑定状态一次性加载，不按 Workflow Stage 过滤，也不需要调用 Skill 激活 Tool。',
      '请根据当前任务、Workspace、Session 上下文和正式业务状态自主组合使用一个或多个 Skill；未绑定的 Skill 不可用。',
      'Skill 不能切换 Stage、扩大 Tool 白名单、修改数据库、发布正式版本或绕过 Service/Validator。',
      this.skills.map(skill => skill.content).join('\n\n'),
    ].join('\n')
  }
}

export class AgentSkillRuntime {
  constructor(private readonly store: StateStore, private readonly packages?: SkillPackageStore) {}

  async prepare(definition: AgentDefinitionVersion, workflowStage: string) {
    const bindings = definition.skillBindings.filter(binding => binding.enabled)
    const configuredSkills = definition.enabledSkills
    if (configuredSkills.length !== bindings.length || configuredSkills.some(key => !bindings.some(binding => binding.skillKey === key))) throw new Error('AGENT_ENABLED_SKILLS_SNAPSHOT_INVALID')
    const bindingsByKey = new Map(bindings.map(binding => [binding.skillKey, binding]))
    const state = await this.store.snapshot()
    const skills: SkillResource[] = []
    for (const skillKey of configuredSkills) {
      const binding = bindingsByKey.get(skillKey)!
      const skill = state.aiResources.find((item): item is SkillResource => item.kind === 'skill' && item.key === binding.skillKey)
      if (!skill || !skill.enabled || skill.version !== binding.version) throw new Error(`SKILL_BINDING_UNAVAILABLE: ${binding.skillKey}@${binding.version}`)
      if (!matchesSkillConfigurationHash(skill, binding.configurationHash)) throw new Error(`SKILL_BINDING_CHANGED: ${binding.skillKey}@${binding.version}`)
      skills.push(skill)
    }
    const loaded: LoadedAgentSkill[] = []
    let totalBytes = 0
    for (const skill of skills) {
      const content = await this.read(skill)
      const bytes = Buffer.byteLength(content, 'utf8')
      if (bytes > MAX_SKILL_BYTES) throw new Error(`SKILL_CONTENT_TOO_LARGE: ${skill.key}`)
      totalBytes += bytes
      if (totalBytes > MAX_ALL_SKILLS_BYTES) throw new Error('SKILL_CONTENT_TOTAL_TOO_LARGE')
      loaded.push({
        key: skill.key,
        name: skill.name,
        description: skill.description,
        version: skill.version,
        tags: [...skill.tags],
        content: `<<<TRUSTED_SKILL key="${skill.key}" version="${skill.version}">>>\n${content.trim()}\n<<<END_TRUSTED_SKILL>>>`,
      })
    }
    return new AgentSkillSession(workflowStage, loaded)
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
