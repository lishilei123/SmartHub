import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { createReadOnlyTools } from '@earendil-works/pi-coding-agent'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { glob as globFiles } from 'glob'
import type { InputDeliveryManifest, ReviewRunSnapshot, TestDesignAgentSnapshot } from '../domain/agent-types.js'
import type { ToolExecutionRequest, ToolExecutionResult } from '../domain/tool-types.js'
import type { AssetVersion } from '../domain/types.js'
import type { StateStore } from '../infrastructure/store.js'
import { defaultBuiltInToolConfigResolver } from './built-in-tool-config.js'
import { ToolRegistry } from './registry.js'

export const REQUIREMENT_WORKSPACE_TOOL_IDS = [
  'workspace.read_file',
  'workspace.grep_files',
  'workspace.find_files',
  'workspace.list_directory',
] as const

export type RequirementWorkspaceToolId = typeof REQUIREMENT_WORKSPACE_TOOL_IDS[number]

export type RequirementDocumentReadObservation = NonNullable<InputDeliveryManifest['toolReads']>[number]

type WorkspaceFile = {
  relativePath: string
  assetId?: string
  assetVersionId?: string
  contentHash: string
  displayName: string
  content: string
  version?: AssetVersion
}

type MaterializedWorkspace = {
  root: string
  filesByPath: Map<string, WorkspaceFile>
  toolsById: Map<RequirementWorkspaceToolId, AgentTool>
}

const toolNameById: Record<RequirementWorkspaceToolId, 'read' | 'grep' | 'find' | 'ls'> = {
  'workspace.read_file': 'read',
  'workspace.grep_files': 'grep',
  'workspace.find_files': 'find',
  'workspace.list_directory': 'ls',
}

const toolIdByName = new Map(Object.entries(toolNameById).map(([id, name]) => [name, id as RequirementWorkspaceToolId]))

/**
 * A run-scoped, read-only filesystem workspace backed by frozen AssetVersion content.
 * Pi's official Coding Agent read-only tools operate on the materialized directory,
 * while every accepted path remains relative to that directory.
 */
export class RequirementDocumentWorkspace {
  private materialized?: Promise<MaterializedWorkspace>

  constructor(private readonly store: StateStore, private readonly snapshot: ReviewRunSnapshot | TestDesignAgentSnapshot) {}

  async execute(toolId: RequirementWorkspaceToolId, request: ToolExecutionRequest, signal: AbortSignal, onRead?: (observation: RequirementDocumentReadObservation) => void): Promise<ToolExecutionResult> {
    const workspace = await this.ensureMaterialized()
    const tool = required(workspace.toolsById.get(toolId), `PI_WORKSPACE_TOOL_NOT_FOUND: ${toolId}`)
    const args = normalizeToolArguments(toolId, request.arguments)
    try {
      const result = await tool.execute(request.toolCallId, args, signal)
      const output = textOutput(result)
      if (toolId !== 'workspace.read_file') return { data: { tool: tool.name, output, ...(result.details === undefined ? {} : { details: result.details }) } }

      const file = required(workspace.filesByPath.get(pathKey(String(args.path))), `PI_WORKSPACE_FILE_NOT_FOUND: ${String(args.path)}`)
      const range = observedReadRange(file.content, args, result.details)
       const planned = 'analysisCoveragePlan' in this.snapshot && file.assetVersionId
         ? this.snapshot.analysisCoveragePlan.find(item => item.assetVersionId === file.assetVersionId)?.chunks ?? []
         : []
      const chunkIds = range
        ? planned.filter(chunk => !chunk.excludedReason && chunk.startLine >= range.startLine && chunk.endLine <= range.endLine).map(chunk => chunk.chunkId)
        : []
      if (range) onRead?.({
        toolCallId: request.toolCallId,
        toolId: 'workspace.read_file',
        relativePath: file.relativePath,
         assetVersionIds: file.assetVersionId ? [file.assetVersionId] : [],
        chunkIds,
        ...range,
      })
      return {
        data: {
          tool: tool.name,
          path: file.relativePath,
          displayName: file.displayName,
          assetVersionId: file.assetVersionId,
          contentHash: file.contentHash,
          ...(range ?? {}),
           totalLines: lineCount(file.content),
          output,
          ...(result.details === undefined ? {} : { details: result.details }),
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(message.replaceAll(workspace.root, '.'))
    }
  }

  async dispose() {
    if (!this.materialized) return
    const workspace = await this.materialized.catch(() => undefined)
    if (!workspace) return
    const temporaryRoot = resolve(tmpdir())
    const target = resolve(workspace.root)
    const relation = relative(temporaryRoot, target)
    if (!relation || relation.startsWith('..') || isAbsolute(relation) || !target.split(/[\\/]/u).at(-1)?.startsWith('smarthub-workspace-')) throw new Error('PI_WORKSPACE_CLEANUP_TARGET_INVALID')
    await rm(target, { recursive: true, force: true })
  }

  private ensureMaterialized() {
    this.materialized ??= this.materialize()
    return this.materialized
  }

  private async materialize(): Promise<MaterializedWorkspace> {
    const workspace = required(this.snapshot.documentWorkspace, 'PI_DOCUMENT_WORKSPACE_REQUIRED')
    const root = await mkdtemp(join(tmpdir(), 'smarthub-workspace-'))
    try {
      const state = await this.store.snapshot()
      const filesByPath = new Map<string, WorkspaceFile>()
      for (const directory of workspaceDirectories(workspace)) await mkdir(join(root, ...directory.split('/')), { recursive: true })
      const logicalRoot = workspace.rootLogicalPath ?? workspace.logicalPath
      const fixedFiles: Array<{ logicalPath: string; assetId?: string; assetVersionId?: string; contentHash: string; displayName: string; content: string; version?: AssetVersion }> = 'workspaceFiles' in this.snapshot
        ? this.snapshot.workspaceFiles.map(file => ({
            logicalPath: file.logicalPath,
            assetId: file.assetId,
            assetVersionId: file.assetVersionId,
            contentHash: file.contentSha256,
            displayName: file.displayName,
            content: file.content,
          }))
        : this.snapshot.assets.map(fixed => {
            const version = required(state.versions.find(item => item.id === fixed.assetVersionId && item.status === 'ready'), `PI_WORKSPACE_VERSION_UNAVAILABLE: ${fixed.assetVersionId}`)
            if (version.assetId !== fixed.assetId || version.contentHash !== fixed.assetContentHash) throw new Error(`PI_WORKSPACE_VERSION_DRIFT: ${fixed.assetVersionId}`)
            return { ...fixed, contentHash: fixed.assetContentHash, content: version.content, version }
          })
      for (const fixed of fixedFiles) {
        const relativePath = relativeLogicalPath(logicalRoot, fixed.logicalPath)
        const key = pathKey(relativePath)
        if (filesByPath.has(key)) throw new Error(`PI_WORKSPACE_PATH_COLLISION: ${relativePath}`)
        const target = join(root, ...relativePath.split('/'))
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, fixed.content, { encoding: 'utf8', flag: 'wx' })
        await access(target, constants.R_OK)
        const targetStat = await stat(target)
        if (!targetStat.isFile()) throw new Error(`PI_WORKSPACE_FILE_INVALID: ${relativePath}`)
        filesByPath.set(key, {
          relativePath,
          assetId: fixed.assetId,
          assetVersionId: fixed.assetVersionId,
          contentHash: fixed.contentHash,
          displayName: fixed.displayName,
          content: fixed.content,
          ...(fixed.version ? { version: fixed.version } : {}),
        })
      }

      const tools = createReadOnlyTools(root, {
        find: {
          operations: {
            exists: async path => access(path, constants.F_OK).then(() => true, () => false),
            glob: async (pattern, cwd, options) => (await globFiles(pattern, {
              cwd,
              absolute: true,
              dot: true,
              ignore: options.ignore,
            })).sort((left, right) => left.localeCompare(right, 'zh-CN')).slice(0, options.limit),
          },
        },
      })
      return {
        root,
        filesByPath,
        toolsById: new Map(tools.map(tool => [required(toolIdByName.get(tool.name as 'read' | 'grep' | 'find' | 'ls'), `PI_WORKSPACE_TOOL_UNSUPPORTED: ${tool.name}`), tool])),
      }
    } catch (error) {
      await rm(root, { recursive: true, force: true })
      throw error
    }
  }
}

export function registerRequirementDocumentWorkspaceTools(registry: ToolRegistry, workspace: RequirementDocumentWorkspace, onRead?: (observation: RequirementDocumentReadObservation) => void) {
  for (const toolId of REQUIREMENT_WORKSPACE_TOOL_IDS) {
    registry.register(defaultBuiltInToolConfigResolver.toDescriptor(toolId), (request, signal) => workspace.execute(toolId, request, signal, onRead))
  }
}

function normalizeToolArguments(toolId: RequirementWorkspaceToolId, value: unknown): Record<string, unknown> {
  const input = record(value)
  if (toolId === 'workspace.read_file') return {
    path: relativeInput(input.path, false),
    ...(input.offset === undefined ? {} : { offset: positiveInteger(input.offset, 'offset') }),
    ...(input.limit === undefined ? {} : { limit: positiveInteger(input.limit, 'limit') }),
  }
  if (toolId === 'workspace.grep_files') return {
    pattern: requiredText(input.pattern, 'pattern'),
    path: relativeInput(input.path ?? '.', true),
    ...(input.glob === undefined ? {} : { glob: safeGlob(input.glob) }),
    ...(input.ignoreCase === undefined ? {} : { ignoreCase: Boolean(input.ignoreCase) }),
    ...(input.literal === undefined ? {} : { literal: Boolean(input.literal) }),
    ...(input.context === undefined ? {} : { context: nonNegativeInteger(input.context, 'context') }),
    ...(input.limit === undefined ? {} : { limit: positiveInteger(input.limit, 'limit') }),
  }
  if (toolId === 'workspace.find_files') return {
    pattern: safeGlob(input.pattern),
    path: relativeInput(input.path ?? '.', true),
    ...(input.limit === undefined ? {} : { limit: positiveInteger(input.limit, 'limit') }),
  }
  return {
    path: relativeInput(input.path ?? '.', true),
    ...(input.limit === undefined ? {} : { limit: positiveInteger(input.limit, 'limit') }),
  }
}

function relativeInput(value: unknown, allowDirectory: boolean) {
  const raw = requiredText(value, 'path').replaceAll('\\', '/')
  if (isAbsolute(raw) || /^[a-z]:/iu.test(raw) || raw.startsWith('//')) throw new Error('PI_WORKSPACE_PATH_OUTSIDE_ROOT: 只允许工作目录内的相对路径')
  const normalized = posix.normalize(raw)
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../') || (!allowDirectory && normalized === '.')) throw new Error('PI_WORKSPACE_PATH_OUTSIDE_ROOT: 只允许工作目录内的相对路径')
  return normalized
}

function safeGlob(value: unknown) {
  const pattern = requiredText(value, 'pattern').replaceAll('\\', '/')
  if (isAbsolute(pattern) || /^[a-z]:/iu.test(pattern) || pattern.startsWith('//') || pattern.split('/').includes('..')) throw new Error('PI_WORKSPACE_GLOB_OUTSIDE_ROOT: 匹配模式不得越过工作目录')
  return pattern
}

function relativeLogicalPath(workspacePath: string, logicalPath: string) {
  const root = normalizedLogicalPath(workspacePath)
  const file = normalizedLogicalPath(logicalPath)
  const value = posix.relative(root, file)
  if (!value || value === '..' || value.startsWith('../') || posix.isAbsolute(value)) throw new Error(`PI_WORKSPACE_LOGICAL_PATH_OUTSIDE_ROOT: ${logicalPath}`)
  return value
}

function normalizedLogicalPath(value: string) {
  const normalized = posix.normalize(value.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, ''))
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) throw new Error(`PI_WORKSPACE_LOGICAL_PATH_INVALID: ${value}`)
  return normalized
}

function workspaceDirectories(workspace: NonNullable<ReviewRunSnapshot['documentWorkspace']>) {
  if (workspace.layoutVersion !== 'workspace/v1' || !workspace.rootLogicalPath || !workspace.activeBranchLogicalPath) return []
  const root = normalizedLogicalPath(workspace.rootLogicalPath)
  const relativeBranchPaths = [...new Set([...(workspace.branchLogicalPaths ?? []), workspace.activeBranchLogicalPath])].map(branch => relativeLogicalPath(root, branch))
  return [
    ...relativeBranchPaths.flatMap(branch => [
      branch,
      `${branch}/input`,
      `${branch}/input/requirements`,
      `${branch}/input/api`,
      `${branch}/input/ui`,
      `${branch}/input/environment`,
      `${branch}/requirements`,
      `${branch}/test_design`,
      `${branch}/test_cases`,
      `${branch}/scripts`,
      `${branch}/execution`,
      `${branch}/reports`,
    ]),
    'shared/knowledge',
    'shared/common_scripts',
    'shared/common_docs',
    'agent_workspace/requirement_agent',
    'agent_workspace/design_agent',
    'agent_workspace/execution_agent',
    'agent_workspace/report_agent',
  ]
}

function observedReadRange(content: string, args: Record<string, unknown>, details: unknown) {
  const totalLines = lineCount(content)
  const startLine = Number(args.offset ?? 1)
  const requestedLines = Math.min(Number(args.limit ?? totalLines), Math.max(0, totalLines - startLine + 1))
  const truncation = record(record(details).truncation)
  const outputLines = truncation.firstLineExceedsLimit === true
    ? 0
    : truncation.truncated === true && Number.isInteger(Number(truncation.outputLines))
      ? Number(truncation.outputLines)
      : requestedLines
  if (outputLines <= 0) return undefined
  return { startLine, endLine: Math.min(totalLines, startLine + outputLines - 1) }
}

function textOutput(result: Awaited<ReturnType<AgentTool['execute']>>) {
  return result.content.flatMap(item => item.type === 'text' ? [item.text] : item.type === 'image' ? ['[图片内容已读取，但未写入文本轨迹]'] : []).join('\n')
}

function pathKey(value: string) { return posix.normalize(value.replaceAll('\\', '/')).toLocaleLowerCase() }
function lineCount(value: string) { return value.split('\n').length }
function record(value: unknown) { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function requiredText(value: unknown, name: string) { const text = typeof value === 'string' ? value.trim() : ''; if (!text) throw new Error(`PI_WORKSPACE_ARGUMENT_REQUIRED: ${name}`); return text }
function positiveInteger(value: unknown, name: string) { const number = Number(value); if (!Number.isInteger(number) || number < 1) throw new Error(`PI_WORKSPACE_ARGUMENT_INVALID: ${name}`); return number }
function nonNegativeInteger(value: unknown, name: string) { const number = Number(value); if (!Number.isInteger(number) || number < 0) throw new Error(`PI_WORKSPACE_ARGUMENT_INVALID: ${name}`); return number }
function required<T>(value: T | undefined, message: string): T { if (value === undefined) throw new Error(message); return value }
