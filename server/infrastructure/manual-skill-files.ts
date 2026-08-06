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
  const { rootPath, relativeEntrypoint } = safeEntrypoint(entrypoint)
  const resourceParts = relativePath == null ? [] : safeRelativePath(relativePath).split('/')
  const roots = [...new Set([resolve(applicationRoot, rootPath), resolve(codeRoot, rootPath)])]
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
  const rootPath = normalized.startsWith('ai/skills/') ? 'ai/skills' : normalized.startsWith('server/skills/') ? 'server/skills' : null
  if (!rootPath || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('SKILL_ENTRYPOINT_OUTSIDE_ALLOWED_ROOT')
  return { rootPath, relativeEntrypoint: normalized.slice(rootPath.length + 1) }
}

function safeRelativePath(value: string) {
  const normalized = value.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('SKILL_RESOURCE_PATH_INVALID')
  return normalized
}

function inside(root: string, target: string) { return target === root || target.startsWith(`${root}${sep}`) }
