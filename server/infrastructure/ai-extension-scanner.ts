import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { extname, relative, resolve, sep } from 'node:path'
import { normalizeSkillRuntimePolicy, SKILL_RUNTIME_MANIFEST } from '../application/skill-runtime-policy.js'

const MAX_EXTENSION_FILES = 1_000
const MAX_DESCRIPTOR_BYTES = 256 * 1024
const MAX_SKILL_FILES = 200
const MAX_SKILL_BYTES = 50 * 1024 * 1024
const moduleExtensions = new Set(['.js', '.mjs', '.cjs', '.ts'])

export type AiExtensionCandidate = {
  kind: 'skill' | 'tool'
  source: string
  input: Record<string, unknown>
}

export type AiExtensionScan = {
  candidates: AiExtensionCandidate[]
  warnings: string[]
}

export async function scanAiExtensions(extensionRoot: string): Promise<AiExtensionScan> {
  const candidates: AiExtensionCandidate[] = []
  const warnings: string[] = []
  const skillRoot = resolve(extensionRoot, 'ai/skills')
  const toolRoot = resolve(extensionRoot, 'ai/tools')

  for (const descriptor of await findFiles(skillRoot, name => name.toLocaleLowerCase() === 'skill.json')) {
    try { candidates.push(await scanSkill(extensionRoot, skillRoot, descriptor)) }
    catch (error) { if (!missing(error)) warnings.push(`${portable(relative(extensionRoot, descriptor))}: ${message(error)}`) }
  }
  for (const descriptor of await findFiles(toolRoot, name => name.toLocaleLowerCase().endsWith('.tool.json'))) {
    try { candidates.push(await scanTool(extensionRoot, toolRoot, descriptor)) }
    catch (error) { if (!missing(error)) warnings.push(`${portable(relative(extensionRoot, descriptor))}: ${message(error)}`) }
  }
  return { candidates, warnings }
}

async function scanSkill(extensionRoot: string, skillRoot: string, descriptorPath: string): Promise<AiExtensionCandidate> {
  const descriptor = await readJsonDescriptor(descriptorPath)
  const directory = resolve(descriptorPath, '..')
  const entrypointName = relativeFile(descriptor.entrypoint ?? 'SKILL.md', 'Skill entrypoint')
  const entrypoint = await realFileInside(directory, resolve(directory, ...entrypointName.split('/')), 'Skill 入口不存在或越界')
  const files = await findFiles(directory, () => true, MAX_SKILL_FILES)
  if (!files.includes(entrypoint)) throw new Error('Skill 入口必须是普通文件')
  const contents = await readFiles(files, MAX_SKILL_BYTES)
  const availableFiles = new Set(files.map(file => portable(relative(directory, file)).toLocaleLowerCase()))
  const runtimePath = resolve(directory, SKILL_RUNTIME_MANIFEST)
  const runtimeContent = contents.get(runtimePath)
  const runtime = runtimeContent === undefined ? undefined : normalizeSkillRuntimePolicy(parseJson(runtimeContent, SKILL_RUNTIME_MANIFEST), availableFiles)
  const relativeEntrypoint = portable(relative(extensionRoot, entrypoint))
  if (!relativeEntrypoint.startsWith('ai/skills/')) throw new Error('Skill 入口必须位于 ai/skills')
  return {
    kind: 'skill',
    source: portable(relative(extensionRoot, descriptorPath)),
    input: {
      ...descriptor,
      entrypoint: relativeEntrypoint,
      runtime,
      contentSha256: contentHash(directory, contents),
      managedBy: 'filesystem',
    },
  }
}

async function scanTool(extensionRoot: string, toolRoot: string, descriptorPath: string): Promise<AiExtensionCandidate> {
  const descriptor = await readJsonDescriptor(descriptorPath)
  const moduleName = relativeFile(descriptor.module, 'Tool module')
  const modulePath = await realFileInside(toolRoot, resolve(descriptorPath, '..', ...moduleName.split('/')), 'Tool 模块不存在或越界')
  if (!moduleExtensions.has(extname(modulePath).toLocaleLowerCase())) throw new Error('Tool module 只支持 .ts、.js、.mjs 或 .cjs')
  const sourcePath = portable(relative(extensionRoot, modulePath))
  if (!sourcePath.startsWith('ai/tools/')) throw new Error('Tool module 必须位于 ai/tools')
  const [descriptorContent, moduleContent] = await Promise.all([readFile(descriptorPath), readFile(modulePath)])
  const contentSha256 = createHash('sha256')
    .update(portable(relative(toolRoot, descriptorPath))).update('\0').update(descriptorContent).update('\0')
    .update(portable(relative(toolRoot, modulePath))).update('\0').update(moduleContent).digest('hex')
  return {
    kind: 'tool',
    source: portable(relative(extensionRoot, descriptorPath)),
    input: {
      ...descriptor,
      source: 'local',
      sourcePath,
      contentSha256,
      managedBy: 'filesystem',
    },
  }
}

async function readJsonDescriptor(path: string) {
  const info = await stat(path)
  if (!info.isFile() || info.size > MAX_DESCRIPTOR_BYTES) throw new Error('描述文件必须是不超过 256 KB 的普通文件')
  return record(parseJson(await readFile(path), path), '描述文件必须是 JSON 对象')
}

async function findFiles(root: string, matches: (name: string) => boolean, maximum = MAX_EXTENSION_FILES) {
  const actualRoot = await realpath(root).catch(() => null)
  if (!actualRoot) return []
  const files: string[] = []
  const pending = [actualRoot]
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && matches(entry.name)) files.push(path)
      if (files.length > maximum) throw new Error(`扩展目录文件数量超过 ${maximum}`)
    }
  }
  return files.sort((left, right) => left.localeCompare(right, 'en'))
}

async function readFiles(files: string[], maximumBytes: number) {
  const contents = new Map<string, Buffer>()
  let bytes = 0
  for (const file of files) {
    const content = await readFile(file)
    bytes += content.length
    if (bytes > maximumBytes) throw new Error('Skill 目录内容超过 50 MB')
    contents.set(file, content)
  }
  return contents
}

function contentHash(root: string, contents: Map<string, Buffer>) {
  const hash = createHash('sha256')
  for (const [path, content] of [...contents].sort(([left], [right]) => left.localeCompare(right, 'en'))) hash.update(portable(relative(root, path))).update('\0').update(content).update('\0')
  return hash.digest('hex')
}

async function realFileInside(root: string, candidate: string, error: string) {
  const [actualRoot, actual] = await Promise.all([realpath(root), realpath(candidate).catch(() => null)])
  if (!actual || !(actual === actualRoot || actual.startsWith(`${actualRoot}${sep}`)) || !(await stat(actual)).isFile()) throw new Error(error)
  return actual
}

function relativeFile(value: unknown, label: string) {
  const normalized = String(value ?? '').trim().replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`${label} 必须是相对文件路径`)
  return normalized
}

function parseJson(content: Buffer, label: string) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)) as unknown }
  catch { throw new Error(`${label} 不是有效的 UTF-8 JSON`) }
}

function record(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(error)
  return value as Record<string, unknown>
}

function portable(path: string) { return path.replaceAll('\\', '/') }
function message(error: unknown) { return error instanceof Error ? error.message : String(error) }
function missing(error: unknown) { return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') }
