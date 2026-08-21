import type { ProjectVersion, RequirementReleaseBinding } from './types.js'

export function requirementReleaseBindings(version: Pick<ProjectVersion, 'requirementReleaseBinding' | 'requirementReleaseBindings'>): RequirementReleaseBinding[] {
  const unique = new Map<string, RequirementReleaseBinding>()
  for (const binding of [...(version.requirementReleaseBindings ?? []), ...(version.requirementReleaseBinding ? [version.requirementReleaseBinding] : [])]) {
    if (!binding.releaseId || !binding.verificationRunId || !binding.releaseContentSha256 || !binding.boundAt) continue
    unique.set(binding.releaseId, { ...binding })
  }
  return [...unique.values()].sort((left, right) => left.boundAt.localeCompare(right.boundAt) || left.releaseId.localeCompare(right.releaseId))
}

export function activeRequirementReleaseBinding(version: Pick<ProjectVersion, 'requirementReleaseBinding' | 'requirementReleaseBindings' | 'activeRequirementReleaseId'>): RequirementReleaseBinding | undefined {
  const bindings = requirementReleaseBindings(version)
  return bindings.find(binding => binding.releaseId === version.activeRequirementReleaseId)
    ?? (version.requirementReleaseBinding ? bindings.find(binding => binding.releaseId === version.requirementReleaseBinding?.releaseId) : undefined)
    ?? bindings.at(-1)
}

export function activateRequirementReleaseBinding(version: ProjectVersion, binding: RequirementReleaseBinding) {
  const bindings = requirementReleaseBindings(version).filter(item => item.releaseId !== binding.releaseId)
  bindings.push({ ...binding })
  bindings.sort((left, right) => left.boundAt.localeCompare(right.boundAt) || left.releaseId.localeCompare(right.releaseId))
  version.requirementReleaseBindings = bindings
  version.activeRequirementReleaseId = binding.releaseId
  version.requirementReleaseBinding = { ...binding }
}

export function normalizeRequirementReleaseBindings(version: ProjectVersion) {
  const bindings = requirementReleaseBindings(version)
  if (!bindings.length) {
    delete version.requirementReleaseBindings
    delete version.activeRequirementReleaseId
    delete version.requirementReleaseBinding
    return
  }
  const active = activeRequirementReleaseBinding({ ...version, requirementReleaseBindings: bindings }) ?? bindings.at(-1)!
  version.requirementReleaseBindings = bindings
  version.activeRequirementReleaseId = active.releaseId
  version.requirementReleaseBinding = { ...active }
}
