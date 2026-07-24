import { randomUUID } from 'node:crypto'
import type { ProjectVersionStatus } from '../domain/types.js'
import type { RequirementBindingMetadata, StateStore } from '../infrastructure/store.js'

const now = () => new Date().toISOString()
const id = (prefix: string) => `${prefix}_${randomUUID()}`

export class ProjectVersionService {
  constructor(private readonly store: StateStore) {}

  async list() {
    const state = await this.store.snapshot()
    const project = platformProject(state)
    return state.projectVersions.filter(item => item.projectId === project.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  async create(input: { name: string; description?: string; sourceProjectVersionId?: string; inheritRequirementBindings?: boolean }) {
    const name = input.name.trim()
    if (!name) throw new Error('版本名称不能为空')
    return this.store.transaction(state => {
      const project = platformProject(state)
      if (state.projectVersions.some(item => item.projectId === project.id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('版本名称已存在')
      const source = input.sourceProjectVersionId ? required(state.projectVersions.find(item => item.id === input.sourceProjectVersionId && item.projectId === project.id), '来源版本不存在') : undefined
      const createdAt = now()
      const version = { id: id('pv'), projectId: project.id, name, description: input.description?.trim() || undefined, status: 'open' as const, sourceProjectVersionId: source?.id, createdAt, updatedAt: createdAt }
      state.projectVersions.push(version)
      if (source && input.inheritRequirementBindings) {
        for (const binding of state.projectVersionRequirementBindings.filter(item => item.projectVersionId === source.id)) {
          state.projectVersionRequirementBindings.push({ id: id('pvrb'), projectVersionId: version.id, assetId: binding.assetId, assetVersionId: binding.assetVersionId, createdAt })
        }
      }
      return version
    })
  }

  async updateStatus(projectVersionId: string, status: ProjectVersionStatus) {
    if (!['open', 'locked', 'archived'].includes(status)) throw new Error('版本状态不合法')
    return this.store.transaction(state => {
      const project = platformProject(state)
      const version = required(state.projectVersions.find(item => item.id === projectVersionId && item.projectId === project.id), '项目版本不存在')
      version.status = status
      version.updatedAt = now()
      return version
    })
  }

  async delete(projectVersionId: string) {
    return this.store.transaction(state => {
      const project = platformProject(state)
      const version = required(state.projectVersions.find(item => item.id === projectVersionId && item.projectId === project.id), '项目版本不存在')
      const dependent = state.projectVersions.find(item => item.sourceProjectVersionId === version.id)
      if (dependent) throw new Error(`版本正在被 ${dependent.name} 作为继承来源，不能删除`)
      if (state.reviewRuns.some(item => item.projectVersionId === version.id)) throw new Error('项目版本已存在需求评审运行，只能归档，不能物理删除')
      const deletedBindings = state.projectVersionRequirementBindings.filter(item => item.projectVersionId === version.id).length
      state.projectVersionRequirementBindings = state.projectVersionRequirementBindings.filter(item => item.projectVersionId !== version.id)
      state.projectVersions = state.projectVersions.filter(item => item.id !== version.id)
      return { id: version.id, name: version.name, deletedBindings }
    })
  }

  async bindings(projectVersionId: string) {
    if (this.store.listRequirementBindings && this.store.getProjectVersion) {
      const version = await this.store.getProjectVersion(projectVersionId)
      if (!version) throw new Error('项目版本不存在')
      return await this.store.listRequirementBindings(projectVersionId)
    }
    const state = await this.store.snapshot()
    const version = versionInSingleProject(state, projectVersionId)
    return state.projectVersionRequirementBindings
      .filter(item => item.projectVersionId === version.id)
      .map(bindingMetadata(state))
  }

  async bindRequirement(projectVersionId: string, assetVersionId: string) {
    return this.store.transaction(state => {
      const projectVersion = versionInSingleProject(state, projectVersionId)
      if (projectVersion.status !== 'open') throw new Error('当前项目版本为只读状态，不能绑定需求')
      const assetVersion = required(state.versions.find(item => item.id === assetVersionId), '需求资产版本不存在')
      if (assetVersion.status !== 'ready') throw new Error('需求资产版本尚未就绪')
      const asset = required(state.assets.find(item => item.id === assetVersion.assetId), '需求资产不存在')
      if (asset.assetType !== 'requirement') throw new Error('只能绑定 requirement 类型资产')
      const knowledgeBase = required(state.knowledgeBases.find(item => item.id === asset.knowledgeBaseId && item.projectId === projectVersion.projectId), '需求资产不属于当前项目')
      void knowledgeBase
      const existing = state.projectVersionRequirementBindings.find(item => item.projectVersionId === projectVersion.id && item.assetId === asset.id)
      if (existing) {
        existing.assetVersionId = assetVersion.id
        return existing
      }
      const binding = { id: id('pvrb'), projectVersionId: projectVersion.id, assetId: asset.id, assetVersionId: assetVersion.id, createdAt: now() }
      state.projectVersionRequirementBindings.push(binding)
      return binding
    })
  }

  async unbindRequirement(projectVersionId: string, bindingId: string) {
    return this.store.transaction(state => {
      const projectVersion = versionInSingleProject(state, projectVersionId)
      if (projectVersion.status !== 'open') throw new Error('当前项目版本为只读状态，不能移除需求绑定')
      const binding = required(state.projectVersionRequirementBindings.find(item => item.id === bindingId && item.projectVersionId === projectVersion.id), '需求绑定不存在')
      state.projectVersionRequirementBindings = state.projectVersionRequirementBindings.filter(item => item.id !== binding.id)
      return binding
    })
  }
}

function bindingMetadata(state: Awaited<ReturnType<StateStore['snapshot']>>) {
  return (binding: Awaited<ReturnType<StateStore['snapshot']>>['projectVersionRequirementBindings'][number]): RequirementBindingMetadata => {
    const asset = required(state.assets.find(item => item.id === binding.assetId), '需求资产不存在')
    const version = required(state.versions.find(item => item.id === binding.assetVersionId), '需求资产版本不存在')
    return {
      ...binding,
      asset: { displayName: asset.displayName, logicalPath: asset.logicalPath, assetType: asset.assetType, sourceType: asset.sourceType, activeVersionId: asset.activeVersionId },
      version: { id: version.id, number: version.number, status: version.status, createdAt: version.createdAt, readyAt: version.readyAt },
      versions: state.versions
        .filter(item => item.assetId === asset.id)
        .sort((left, right) => left.number - right.number)
        .map(item => ({ id: item.id, number: item.number, status: item.status, createdAt: item.createdAt, readyAt: item.readyAt })),
    }
  }
}

function platformProject(state: Awaited<ReturnType<StateStore['snapshot']>>) {
  if (state.projects.length === 0) throw new Error('平台项目尚未初始化')
  const candidates = state.projects.filter(project => project.name === 'SmartHub').map(project => ({
    project,
    assets: state.knowledgeBases.filter(kb => kb.projectId === project.id).reduce((count, kb) => count + state.assets.filter(asset => asset.knowledgeBaseId === kb.id && asset.activeVersionId).length, 0),
  })).sort((left, right) => right.assets - left.assets || left.project.createdAt.localeCompare(right.project.createdAt))
  if (candidates[0]) return candidates[0].project
  if (state.projects.length === 1) return state.projects[0]
  throw new Error('平台单项目尚未完成初始化')
}

function versionInSingleProject(state: Awaited<ReturnType<StateStore['snapshot']>>, projectVersionId: string) {
  const project = platformProject(state)
  return required(state.projectVersions.find(item => item.id === projectVersionId && item.projectId === project.id), '项目版本不存在')
}

function required<T>(value: T | undefined, message: string): T { if (value === undefined) throw new Error(message); return value }
