import type { KnowledgeDirectory, KnowledgeDocument } from './prototype-data'
import { requirementWorkspaceDirectory } from './version-document-path'

const workspaceRoot = 'workspace'

const branchDirectoryNames = ['input', 'requirements', 'test-design', 'test-cases', 'scripts', 'execution', 'reports'] as const
const inputDirectoryNames = ['requirements', 'api', 'ui', 'environment'] as const
const sharedDirectoryNames = ['knowledge', 'common_scripts', 'common_docs'] as const
const agentDirectoryNames = ['planning_agent', 'execution_agent', 'report_agent'] as const

export type WorkspaceKnowledgeDirectory = KnowledgeDirectory & {
  logicalPath: string
  persisted: boolean
  structural: boolean
}

export type WorkspaceKnowledgeTree = {
  directories: WorkspaceKnowledgeDirectory[]
  documents: KnowledgeDocument[]
  rootDirectoryId: string | null
}

function normalizeLogicalPath(value: string) {
  return value.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '').replace(/\/{2,}/gu, '/')
}

function isWorkspacePath(value: string) {
  return value === workspaceRoot || value.startsWith(`${workspaceRoot}/`)
}

function parentPath(value: string) {
  const index = value.lastIndexOf('/')
  return index < 0 ? '' : value.slice(0, index)
}

function workspaceScaffold(versionNames: string[]) {
  const paths = new Set<string>([
    workspaceRoot,
    `${workspaceRoot}/branches`,
    `${workspaceRoot}/shared`,
    ...sharedDirectoryNames.map(name => `${workspaceRoot}/shared/${name}`),
    `${workspaceRoot}/agent_workspace`,
    ...agentDirectoryNames.map(name => `${workspaceRoot}/agent_workspace/${name}`),
  ])
  versionNames.forEach(versionName => {
    const branchPath = requirementWorkspaceDirectory(versionName).replace(/\/input\/requirements$/u, '')
    paths.add(branchPath)
    branchDirectoryNames.forEach(name => paths.add(`${branchPath}/${name}`))
    inputDirectoryNames.forEach(name => paths.add(`${branchPath}/input/${name}`))
  })
  return paths
}

function siblingOrder(parent: string) {
  if (parent === workspaceRoot) return ['branches', 'shared', 'agent_workspace'] as readonly string[]
  if (parent === `${workspaceRoot}/shared`) return sharedDirectoryNames
  if (parent === `${workspaceRoot}/agent_workspace`) return agentDirectoryNames
  if (/^workspace\/branches\/[^/]+$/u.test(parent)) return branchDirectoryNames
  if (/^workspace\/branches\/[^/]+\/input$/u.test(parent)) return inputDirectoryNames
  return [] as readonly string[]
}

function compareWorkspacePaths(left: string, right: string) {
  const leftParent = parentPath(left)
  const rightParent = parentPath(right)
  if (leftParent === rightParent) {
    const order = siblingOrder(leftParent)
    const leftName = left.slice(leftParent.length + 1)
    const rightName = right.slice(rightParent.length + 1)
    const leftIndex = order.indexOf(leftName)
    const rightIndex = order.indexOf(rightName)
    if (leftIndex >= 0 || rightIndex >= 0) return (leftIndex < 0 ? order.length : leftIndex) - (rightIndex < 0 ? order.length : rightIndex) || leftName.localeCompare(rightName, 'zh-CN', { numeric: true })
    return leftName.localeCompare(rightName, 'zh-CN', { numeric: true })
  }
  return left.localeCompare(right, 'zh-CN', { numeric: true })
}

export function buildWorkspaceKnowledgeTree(input: {
  directories: KnowledgeDirectory[]
  documents: KnowledgeDocument[]
  versionNames: string[]
}): WorkspaceKnowledgeTree {
  const sourceById = new Map(input.directories.map(directory => [directory.id, directory]))
  const pathById = new Map<string, string>()
  const resolving = new Set<string>()
  const resolveDirectoryPath = (directoryId: string): string => {
    const cached = pathById.get(directoryId)
    if (cached) return cached
    const directory = sourceById.get(directoryId)
    if (!directory || resolving.has(directoryId)) return ''
    resolving.add(directoryId)
    const parent = directory.parentId ? resolveDirectoryPath(directory.parentId) : ''
    resolving.delete(directoryId)
    const path = normalizeLogicalPath([parent, directory.name].filter(Boolean).join('/'))
    pathById.set(directoryId, path)
    return path
  }

  input.directories.forEach(directory => resolveDirectoryPath(directory.id))
  const directoryByPath = new Map<string, KnowledgeDirectory>()
  input.directories.forEach(directory => {
    const path = pathById.get(directory.id) ?? ''
    if (!isWorkspacePath(path)) return
    const current = directoryByPath.get(path)
    if (!current || (current.id.startsWith('api-dir:') && !directory.id.startsWith('api-dir:'))) directoryByPath.set(path, directory)
  })

  const structuralPaths = workspaceScaffold(input.versionNames)
  const allPaths = new Set(structuralPaths)
  const addPathAndAncestors = (rawPath: string) => {
    let path = normalizeLogicalPath(rawPath)
    if (!isWorkspacePath(path)) return
    while (path && isWorkspacePath(path)) {
      allPaths.add(path)
      if (path === workspaceRoot) break
      path = parentPath(path)
    }
  }
  directoryByPath.forEach((_directory, path) => addPathAndAncestors(path))
  input.documents.forEach(document => {
    const logicalPath = normalizeLogicalPath(document.logicalPath ?? '')
    if (isWorkspacePath(logicalPath)) addPathAndAncestors(parentPath(logicalPath))
  })

  const idByPath = new Map<string, string>()
  ;[...allPaths].forEach(path => idByPath.set(path, directoryByPath.get(path)?.id ?? `workspace-dir:${path}`))
  const directories = [...allPaths]
    .filter(path => path !== workspaceRoot)
    .sort(compareWorkspacePaths)
    .map<WorkspaceKnowledgeDirectory>(path => {
      const source = directoryByPath.get(path)
      const parent = parentPath(path)
      const persisted = Boolean(source && !source.id.startsWith('api-dir:'))
      return {
        id: idByPath.get(path)!,
        name: path.slice(path.lastIndexOf('/') + 1),
        parentId: parent === workspaceRoot ? null : idByPath.get(parent) ?? null,
        operationTaskId: source?.operationTaskId,
        task: source?.task,
        logicalPath: path,
        persisted,
        structural: structuralPaths.has(path),
      }
    })

  const documents = input.documents.flatMap(document => {
    const logicalPath = normalizeLogicalPath(document.logicalPath ?? '')
    if (!isWorkspacePath(logicalPath)) return []
    const directoryPath = parentPath(logicalPath)
    return [{ ...document, logicalPath, parentId: directoryPath === workspaceRoot ? null : idByPath.get(directoryPath) ?? null }]
  }).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true }))

  const rootDirectory = directoryByPath.get(workspaceRoot)
  return {
    directories,
    documents,
    rootDirectoryId: rootDirectory && !rootDirectory.id.startsWith('api-dir:') ? rootDirectory.id : null,
  }
}
