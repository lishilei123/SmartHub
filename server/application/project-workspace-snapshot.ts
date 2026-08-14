import type {
  CurrentInputRef,
  ProjectWorkspaceSnapshot,
  ProjectWorkspaceSourceScope,
} from '../domain/agent-types.js'
import type { Asset, AssetVersion, ProjectVersion } from '../domain/types.js'
import { canonicalSha256 } from './canonical-json.js'

type WorkspaceAssetPair = {
  asset: Pick<Asset, 'id' | 'logicalPath' | 'displayName'>
  version: Pick<AssetVersion, 'id' | 'contentHash'>
}

export function buildProjectWorkspaceSnapshot(input: {
  projectId: string
  projectVersion: Pick<ProjectVersion, 'id' | 'name'>
  files: WorkspaceAssetPair[]
  currentInputVersionIds: ReadonlySet<string>
  createdAt: string
}): ProjectWorkspaceSnapshot {
  const activeBranchLogicalPath = `workspace/branches/${safeWorkspaceSegment(input.projectVersion.name)}`
  const files = input.files.map(({ asset, version }) => {
    const logicalPath = normalizeWorkspacePath(asset.logicalPath)
    return {
      assetId: asset.id,
      assetVersionId: version.id,
      logicalPath,
      displayName: asset.displayName,
      contentSha256: version.contentHash,
      sourceScope: classifyWorkspaceSourceScope(
        logicalPath,
        activeBranchLogicalPath,
        input.currentInputVersionIds.has(version.id),
      ),
    }
  }).sort((left, right) => left.logicalPath.localeCompare(right.logicalPath, 'zh-CN') || left.assetVersionId.localeCompare(right.assetVersionId))
  const base = {
    schemaVersion: 'project-workspace-snapshot/v1' as const,
    projectId: input.projectId,
    projectVersionId: input.projectVersion.id,
    rootLogicalPath: 'workspace' as const,
    activeBranchLogicalPath,
    files,
    createdAt: input.createdAt,
  }
  return { ...base, snapshotSha256: canonicalSha256(base) }
}

export function buildCurrentInputRefs(files: WorkspaceAssetPair[]): CurrentInputRef[] {
  return files.map(({ asset, version }) => ({
    assetId: asset.id,
    assetVersionId: version.id,
    logicalPath: normalizeWorkspacePath(asset.logicalPath),
    contentSha256: version.contentHash,
  })).sort((left, right) => left.logicalPath.localeCompare(right.logicalPath, 'zh-CN') || left.assetVersionId.localeCompare(right.assetVersionId))
}

export function classifyWorkspaceSourceScope(
  logicalPath: string,
  activeBranchLogicalPath: string,
  currentInput = false,
): ProjectWorkspaceSourceScope {
  if (currentInput) return 'current_input'
  const path = normalizeWorkspacePath(logicalPath)
  const activeBranch = normalizeWorkspacePath(activeBranchLogicalPath)
  if (path === 'workspace/shared' || path.startsWith('workspace/shared/')) return 'shared'
  if (path === 'workspace/formal-output' || path.startsWith('workspace/formal-output/')) return 'formal_output'
  if (path.startsWith('workspace/branches/') && path !== activeBranch && !path.startsWith(`${activeBranch}/`)) return 'historical_branch'
  if (isFormalBranchOutput(path, activeBranch)) return 'formal_output'
  return 'current_branch'
}

export function normalizeWorkspacePath(value: string) {
  const normalized = String(value).replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
  if (!normalized || (normalized !== 'workspace' && !normalized.startsWith('workspace/')) || /^[A-Za-z]:/u.test(normalized) || normalized.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`PROJECT_WORKSPACE_PATH_INVALID: ${value}`)
  }
  return normalized
}

export function safeWorkspaceSegment(value: string) {
  const encode = (character: string) => `%${character.codePointAt(0)!.toString(16).toUpperCase().padStart(2, '0')}`
  const source = value.normalize('NFC').trim() || '未命名版本'
  let safe = source.replace(/[%<>:"/\\|?*\u0000-\u001F]/gu, encode).replace(/[. ]+$/gu, characters => [...characters].map(encode).join(''))
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(source)) safe = `${encode(source[0])}${safe.slice(1)}`
  return safe
}

function isFormalBranchOutput(path: string, activeBranch: string) {
  return [
    'requirements',
    'test-design',
    'test_design',
    'test-cases',
    'test_cases',
    'test-case-library',
    'test_case_library',
    'scripts',
    'execution',
    'reports',
  ].some(directory => path === `${activeBranch}/${directory}` || path.startsWith(`${activeBranch}/${directory}/`))
}
