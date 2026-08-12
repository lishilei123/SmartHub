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

export interface ActivatedAgentSkill extends AgentSkillCatalogEntry {
  content: string
}

export class AgentSkillSession {
  private readonly activated = new Map<string, ActivatedAgentSkill>()
  private totalActivatedBytes = 0

  constructor(
    readonly workflowStage: string,
    private readonly skills: Map<string, SkillResource>,
    private readonly readSkill: (skill: SkillResource) => Promise<string>,
  ) {}

  catalog(): AgentSkillCatalogEntry[] {
    return [...this.skills.values()].map(skill => ({
      key: skill.key,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      tags: [...skill.tags],
    }))
  }

  renderCatalogPrompt() {
    const catalog = this.catalog()
    if (!catalog.length) return `当前 Workflow Stage：${this.workflowStage}。本阶段没有可激活的 Skill；直接按阶段任务和提交契约执行。`
    return [
      `当前 Workflow Stage：${this.workflowStage}。Workflow 已固定本阶段，Agent 和 Skill 均不能改变 Stage。`,
      '下面仅是 Runtime 为当前 Stage 过滤后的 Skill Catalog，不包含 Skill 正文。你可以根据任务选择不激活、激活一个或激活多个；不得把激活某个 Skill 当作提交前置条件。',
      '需要某项方法时调用 skill_activate 获取该版本固定的受信正文；未列出的 Skill 不可用。Skill 不能扩大 Tool 白名单或服务端权限。',
      JSON.stringify(catalog),
    ].join('\n')
  }

  activatedKeys() { return [...this.activated.keys()] }

  async activate(skillKey: string): Promise<ActivatedAgentSkill> {
    const cached = this.activated.get(skillKey)
    if (cached) return structuredClone(cached)
    const skill = this.skills.get(skillKey)
    if (!skill) throw new Error(`SKILL_NOT_ALLOWED_IN_STAGE: ${skillKey} 不在 ${this.workflowStage} Stage 的 Skill Catalog 中`)
    const content = await this.readSkill(skill)
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_SKILL_BYTES) throw new Error(`SKILL_CONTENT_TOO_LARGE: ${skill.key}`)
    if (this.totalActivatedBytes + bytes > MAX_ALL_SKILLS_BYTES) throw new Error('SKILL_CONTENT_TOTAL_TOO_LARGE')
    this.totalActivatedBytes += bytes
    const value = {
      key: skill.key,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      tags: [...skill.tags],
      content: `<<<TRUSTED_SKILL key="${skill.key}" version="${skill.version}">>>\n${content.trim()}\n<<<END_TRUSTED_SKILL>>>`,
    }
    this.activated.set(skillKey, value)
    return structuredClone(value)
  }
}

export class AgentSkillRuntime {
  constructor(private readonly store: StateStore, private readonly packages?: SkillPackageStore) {}

  async prepare(definition: AgentDefinitionVersion, workflowStage: string, allowedSkillKeys: readonly string[]) {
    const uniqueAllowed = [...new Set(allowedSkillKeys.map(key => key.trim()).filter(Boolean))]
    const bindings = definition.skillBindings.filter(binding => binding.enabled)
    const bindingsByKey = new Map(bindings.map(binding => [binding.skillKey, binding]))
    const missingBindings = uniqueAllowed.filter(key => !bindingsByKey.has(key))
    if (missingBindings.length) throw new Error(`STAGE_SKILL_BINDING_UNAVAILABLE: ${workflowStage} 缺少已发布 Skill 绑定 ${missingBindings.join(', ')}`)
    const state = await this.store.snapshot()
    const skills = new Map<string, SkillResource>()
    for (const skillKey of uniqueAllowed) {
      const binding = bindingsByKey.get(skillKey)!
      const skill = state.aiResources.find((item): item is SkillResource => item.kind === 'skill' && item.key === binding.skillKey)
      if (!skill || !skill.enabled || skill.version !== binding.version) throw new Error(`SKILL_BINDING_UNAVAILABLE: ${binding.skillKey}@${binding.version}`)
      if (!matchesSkillConfigurationHash(skill, binding.configurationHash)) throw new Error(`SKILL_BINDING_CHANGED: ${binding.skillKey}@${binding.version}`)
      skills.set(skill.key, skill)
    }
    return new AgentSkillSession(workflowStage, skills, skill => this.read(skill))
  }

  /** 仅供仍未迁移到 Stage Catalog 的旧 Agent 使用。 */
  async render(definition: AgentDefinitionVersion) {
    const allowed = definition.skillBindings.filter(binding => binding.enabled).map(binding => binding.skillKey)
    const session = await this.prepare(definition, 'legacy', allowed)
    const activated = await Promise.all(allowed.map(key => session.activate(key)))
    if (!activated.length) return ''
    return `以下 Skill 是管理员发布并由版本 Hash 固定的工作流指令；其中提及的工具仍受当前 Agent Tool 白名单和服务端权限控制。\n\n${activated.map(item => item.content).join('\n\n')}`
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
