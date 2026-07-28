import { realpath, stat } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { applicationRoot, codeRoot } from './runtime-paths.js'

export async function resolveManualSkillEntrypoint(entrypoint: string) {
  return resolveManualSkillPath(entrypoint, null)
}

export async function resolveManualSkillFile(entrypoint: string, relativePath: string) {
  return resolveManualSkillPath(entrypoint, relativePath)
}

async function resolveManualSkillPath(entrypoint: string, relativePath: string | null) {
  const normalized = safeEntrypoint(entrypoint)
  const relativeEntrypoint = normalized.slice('ai/skills/'.length)
  const resourceParts = relativePath == null ? [] : safeRelativePath(relativePath).split('/')
  const roots = [...new Set([resolve(applicationRoot, 'ai/skills'), resolve(codeRoot, 'ai/skills')])]
  for (const root of roots) {
    const actualRoot = await realpath(root).catch(() => null)
    const actualEntrypoint = await realpath(resolve(root, ...relativeEntrypoint.split('/'))).catch(() => null)
    if (!actualRoot || !actualEntrypoint || !inside(actualRoot, actualEntrypoint)) continue
    const target = relativePath == null ? actualEntrypoint : await realpath(resolve(dirname(actualEntrypoint), ...resourceParts)).catch(() => null)
    if (!target || !inside(dirname(actualEntrypoint), target) || !(await stat(target)).isFile()) continue
    return target
  }
  throw new Error(relativePath == null ? `SKILL_ENTRYPOINT_NOT_FOUND: ${entrypoint}` : `SKILL_RESOURCE_NOT_FOUND: ${entrypoint} -> ${relativePath}`)
}

function safeEntrypoint(value: string) {
  const normalized = value.replaceAll('\\', '/')
  if (!normalized.startsWith('ai/skills/') || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('SKILL_ENTRYPOINT_OUTSIDE_ALLOWED_ROOT')
  return normalized
}

function safeRelativePath(value: string) {
  const normalized = value.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('SKILL_RESOURCE_PATH_INVALID')
  return normalized
}

function inside(root: string, target: string) { return target === root || target.startsWith(`${root}${sep}`) }
