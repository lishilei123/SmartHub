import { readFile } from 'node:fs/promises'
import type { AgentDefinitionVersion } from '../domain/agent-types.js'
import type { SkillResource } from '../domain/types.js'
import type { SkillPackageStore } from '../infrastructure/skill-package-store.js'
import type { StateStore } from '../infrastructure/store.js'
import { resolveManualSkillEntrypoint } from '../infrastructure/manual-skill-files.js'
import { matchesSkillConfigurationHash } from '../application/ai-resource-hash.js'
import type { ToolExecutionResult } from '../domain/tool-types.js'
import { ToolRegistry } from '../tools/registry.js'
import { registerSkillReadTool, SKILL_READ_TOOL_ID } from '../tools/skill-read.js'

const MAX_SKILL_BYTES = 256 * 1024
const MAX_ALL_SKILLS_BYTES = 512 * 1024

export interface AgentSkillCatalogEntry {
  skillKey: string
  name: string
  description: string
  version: string
  tags: string[]
}

interface BoundAgentSkill extends AgentSkillCatalogEntry {
  binding: AgentDefinitionVersion['skillBindings'][number]
}

export interface SkillReadData {
  skillKey: string
  version: string
  content: string
  contentSha256?: string
}

export class AgentSkillSession {
  private readonly cache = new Map<string, SkillReadData>()
  private loadedBytes = 0

  constructor(
    readonly workflowStage: string,
    private readonly skills: BoundAgentSkill[],
    private readonly store: StateStore,
    private readonly packages?: SkillPackageStore,
  ) {}

  catalog(): AgentSkillCatalogEntry[] {
    return this.skills.map(skill => ({
      skillKey: skill.skillKey,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      tags: [...skill.tags],
    }))
  }

  renderPrompt() {
    if (!this.skills.length) return `当前 Agent 发布配置没有启用 Skill。直接按 Workflow 任务、Workspace 事实与提交契约执行。`
    return [
      '<runtime_skill_catalog_contract authority="highest">',
      '这是 Runtime 当前实现的事实，优先于 Agent Configuration、Session 历史或旧 Context Summary 中任何关于 Skill 装载方式的相反表述。',
      'Enabled Skills 仅是可按需读取的发布能力目录；本轮 System Prompt 不包含任何 Skill 正文，只有调用 skill.read 后返回的固定正文才进入当前上下文。',
      '历史轮次已经读取过的 Skill 不能替代最新业务任务、当前正式状态或当前 Runtime 工具权限。',
      '</runtime_skill_catalog_contract>',
      `当前正式业务 Stage：${this.workflowStage}。Workflow 只提供任务与 Gate，不调度 Skill。`,
      '当前 Agent 可用 Skills（发布配置目录；不包含 Skill 正文）：',
      this.skills.map(skill => [
        `- ${skill.skillKey}`,
        `  name: ${singleLine(skill.name)}`,
        `  description: ${singleLine(skill.description)}`,
        `  version: ${skill.version}`,
        `  tags: ${skill.tags.length ? skill.tags.map(singleLine).join(', ') : '—'}`,
      ].join('\n')).join('\n'),
      'Enabled Skills 表示当前可以自主选择的能力目录，不表示正文已经注入上下文。',
      '需要专业方法时，请根据最新任务、Workspace、Session 上下文和正式业务状态自主决定是否调用 skill.read({ "skillKey": "<skillKey>" })，以及读取一个或多个 Skill。Runtime 不按 Stage 替你选择 Skill。',
      'skill.read 只能读取上述目录中当前发布配置已启用且版本与 Hash 固定的 Skill；未绑定 Skill 不可用。',
      'Skill 不能切换 Stage、扩大 Tool 白名单、修改数据库、发布正式版本或绕过 Service/Validator。',
    ].join('\n')
  }

  register(registry: ToolRegistry) {
    if (!this.skills.length) return
    registerSkillReadTool(registry, (skillKey, signal) => this.read(skillKey, signal))
  }

  runtimeToolIds() {
    return this.skills.length ? [SKILL_READ_TOOL_ID] : []
  }

  private async read(skillKey: string, signal: AbortSignal): Promise<ToolExecutionResult> {
    signal.throwIfAborted()
    const cached = this.cache.get(skillKey)
    if (cached) return { data: structuredClone(cached), replayed: true }
    const bound = this.skills.find(skill => skill.skillKey === skillKey)
    if (!bound) throw new Error(`SKILL_READ_NOT_BOUND: ${skillKey}`)

    const state = await this.store.snapshot()
    const skill = state.aiResources.find((item): item is SkillResource => item.kind === 'skill' && item.key === skillKey)
    assertSkillBinding(skill, bound.binding)
    const content = await readSkillContent(skill, this.packages)
    signal.throwIfAborted()
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_SKILL_BYTES) throw new Error(`SKILL_CONTENT_TOO_LARGE: ${skill.key}`)
    if (this.loadedBytes + bytes > MAX_ALL_SKILLS_BYTES) throw new Error('SKILL_CONTENT_TOTAL_TOO_LARGE')
    this.loadedBytes += bytes
    const data: SkillReadData = {
      skillKey: skill.key,
      version: skill.version,
      content: `<<<TRUSTED_SKILL key="${skill.key}" version="${skill.version}">>>\n${content.trim()}\n<<<END_TRUSTED_SKILL>>>`,
      ...(skill.contentSha256 || skill.package?.contentSha256 ? { contentSha256: skill.contentSha256 ?? skill.package!.contentSha256 } : {}),
    }
    this.cache.set(skillKey, structuredClone(data))
    return { data }
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
    const skills: BoundAgentSkill[] = []
    for (const skillKey of configuredSkills) {
      const binding = bindingsByKey.get(skillKey)!
      const skill = state.aiResources.find((item): item is SkillResource => item.kind === 'skill' && item.key === binding.skillKey)
      assertSkillBinding(skill, binding)
      skills.push({
        skillKey: skill.key,
        name: skill.name,
        description: skill.description,
        version: skill.version,
        tags: [...skill.tags],
        binding: structuredClone(binding),
      })
    }
    return new AgentSkillSession(workflowStage, skills, this.store, this.packages)
  }
}

function assertSkillBinding(skill: SkillResource | undefined, binding: AgentDefinitionVersion['skillBindings'][number]): asserts skill is SkillResource {
  if (!binding.enabled || !skill || !skill.enabled || skill.status !== 'ready' || skill.version !== binding.version) {
    throw new Error(`SKILL_BINDING_UNAVAILABLE: ${binding.skillKey}@${binding.version}`)
  }
  if (!matchesSkillConfigurationHash(skill, binding.configurationHash)) throw new Error(`SKILL_BINDING_CHANGED: ${binding.skillKey}@${binding.version}`)
}

async function readSkillContent(skill: SkillResource, packages?: SkillPackageStore) {
  if (skill.package) {
    if (!packages) throw new Error(`SKILL_PACKAGE_STORE_UNAVAILABLE: ${skill.key}`)
    return decodeUtf8(await packages.read(skill.package.storageKey, skill.package.entrypointPath), skill.key)
  }
  const path = await resolveManualSkillEntrypoint(skill.entrypoint)
  return decodeUtf8(await readFile(path), skill.key)
}

function decodeUtf8(value: Buffer, key: string) {
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(value)
    if (!content.trim()) throw new Error('empty')
    return content
  } catch { throw new Error(`SKILL_CONTENT_INVALID_UTF8: ${key}`) }
}

function singleLine(value: string) {
  return value.replace(/\s+/gu, ' ').trim()
}
