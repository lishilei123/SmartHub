const apiBase = 'http://127.0.0.1:8787/api'

export type ProjectVersionStatus = 'open' | 'locked' | 'archived'
export type ProjectVersion = {
  id: string
  name: string
  description?: string
  status: ProjectVersionStatus
  sourceProjectVersionId?: string
  createdAt: string
  updatedAt: string
}
export type RequirementBinding = { id: string; projectVersionId: string; assetId: string; assetVersionId: string; createdAt: string }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } })
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? '项目版本服务请求失败')
  return body
}

export const loadProjectVersions = () => request<ProjectVersion[]>('/project-versions')
export const createProjectVersion = (input: { name: string; description?: string; sourceProjectVersionId?: string; inheritRequirementBindings?: boolean }) => request<ProjectVersion>('/project-versions', { method: 'POST', body: JSON.stringify(input) })
export const updateProjectVersionStatus = (id: string, status: ProjectVersionStatus) => request<ProjectVersion>(`/project-versions/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: JSON.stringify({ status }) })
export const deleteProjectVersion = (id: string) => request<{ id: string; name: string; deletedBindings: number }>(`/project-versions/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const loadRequirementBindings = (id: string) => request<RequirementBinding[]>(`/project-versions/${encodeURIComponent(id)}/requirement-bindings`)
export const bindRequirementVersion = (id: string, assetVersionId: string) => request<RequirementBinding>(`/project-versions/${encodeURIComponent(id)}/requirement-bindings`, { method: 'POST', body: JSON.stringify({ assetVersionId }) })
export const unbindRequirementVersion = (id: string, bindingId: string) => request<RequirementBinding>(`/project-versions/${encodeURIComponent(id)}/requirement-bindings/${encodeURIComponent(bindingId)}`, { method: 'DELETE' })
