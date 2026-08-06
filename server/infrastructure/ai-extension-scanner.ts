import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { extname, relative, resolve, sep } from 'node:path'
import { parse } from '@babel/parser'
import type { Expression, ObjectProperty } from '@babel/types'
import { normalizeSkillRuntimePolicy, SKILL_RUNTIME_MANIFEST } from '../application/skill-runtime-policy.js'

const MAX_EXTENSION_FILES = 1_000
const MAX_DESCRIPTOR_BYTES = 256 * 1024
const MAX_SKILL_FILES = 200
const MAX_SKILL_BYTES = 50 * 1024 * 1024
const moduleExtensions = new Set(['.js', '.mjs', '.cjs', '.ts'])
const inlineManifestNames = new Set(['tool', 'toolManifest', 'metadata'])
const ignoredDirectoryNames = new Set(['.git', 'node_modules'])

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
  for (const descriptor of await findFiles(toolRoot, isToolDescriptor)) {
    try { candidates.push(...await scanToolDescriptor(extensionRoot, toolRoot, descriptor)) }
    catch (error) { if (!missing(error)) warnings.push(`${portable(relative(extensionRoot, descriptor))}: ${message(error)}`) }
  }
  for (const modulePath of await findFiles(toolRoot, isInlineToolModule)) {
    try {
      const inline = await scanInlineTool(extensionRoot, toolRoot, modulePath)
      if (inline && !candidates.some(candidate => candidate.kind === 'tool' && candidate.input.sourcePath === inline.input.sourcePath)) candidates.push(inline)
    }
    catch (error) { if (!missing(error)) warnings.push(`${portable(relative(extensionRoot, modulePath))}: ${message(error)}`) }
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

async function scanToolDescriptor(extensionRoot: string, toolRoot: string, descriptorPath: string): Promise<AiExtensionCandidate[]> {
  const document = await readJsonDescriptorValue(descriptorPath)
  const descriptorName = descriptorPath.replaceAll('\\', '/').split('/').at(-1)!.toLocaleLowerCase()
  const definitions = toolDefinitions(document, descriptorName)
  return Promise.all(definitions.map(async (definition, index) => {
    const descriptor = record(definition.value, `${definition.label} 必须是 JSON 对象`)
    const moduleName = await resolveToolModule(descriptorPath, descriptor.module ?? definition.defaultModule)
    return scanTool(extensionRoot, toolRoot, descriptorPath, descriptor, moduleName, definitions.length > 1 ? `${index + 1}-${String(descriptor.key ?? '')}` : '')
  }))
}

async function scanTool(extensionRoot: string, toolRoot: string, descriptorPath: string, descriptor: Record<string, unknown>, moduleName: string, sourceSuffix: string): Promise<AiExtensionCandidate> {
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
    source: `${portable(relative(extensionRoot, descriptorPath))}${sourceSuffix ? `#${sourceSuffix}` : ''}`,
    input: {
      ...descriptor,
      source: 'local',
      sourcePath,
      contentSha256,
      managedBy: 'filesystem',
    },
  }
}

async function scanInlineTool(extensionRoot: string, toolRoot: string, modulePath: string): Promise<AiExtensionCandidate | undefined> {
  const actualModule = await realFileInside(toolRoot, modulePath, 'Tool 模块不存在或越界')
  const sourcePath = portable(relative(extensionRoot, actualModule))
  if (!sourcePath.startsWith('ai/tools/')) throw new Error('Tool module 必须位于 ai/tools')
  const content = await readFile(actualModule)
  if (content.length > 512 * 1024) throw new Error('单文件 Tool 不能超过 512 KB')
  const source = content.toString('utf8')
  if (!/\bexport\s+const\s+(?:tool|toolManifest|metadata)\b/u.test(source)) return undefined
  const descriptor = parseInlineToolManifest(source, sourcePath)
  return {
    kind: 'tool',
    source: sourcePath,
    input: {
      ...descriptor,
      source: 'local',
      sourcePath,
      contentSha256: createHash('sha256').update(content).digest('hex'),
      managedBy: 'filesystem',
    },
  }
}

async function readJsonDescriptor(path: string) {
  return record(await readJsonDescriptorValue(path), '描述文件必须是 JSON 对象')
}

async function readJsonDescriptorValue(path: string) {
  const info = await stat(path)
  if (!info.isFile() || info.size > MAX_DESCRIPTOR_BYTES) throw new Error('描述文件必须是不超过 256 KB 的普通文件')
  return parseJson(await readFile(path), path)
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
      if (entry.isDirectory() && !ignoredDirectoryNames.has(entry.name.toLocaleLowerCase())) pending.push(path)
      else if (entry.isFile() && matches(entry.name)) files.push(path)
      if (files.length > maximum) throw new Error(`扩展目录文件数量超过 ${maximum}`)
    }
  }
  return files.sort((left, right) => left.localeCompare(right, 'en'))
}

function toolDefinitions(document: unknown, descriptorName: string) {
  if (descriptorName === 'package.json') {
    const packageDocument = record(document, 'package.json 必须是 JSON 对象')
    const smarthub = optionalRecord(packageDocument.smarthub)
    if (!smarthub) return []
    const defaultModule = packageDocument.module ?? packageDocument.main
    if (smarthub.tool !== undefined) return [{ value: smarthub.tool, label: 'package.json smarthub.tool', defaultModule }]
    if (smarthub.tools !== undefined) return arrayDefinitions(smarthub.tools, 'package.json smarthub.tools', defaultModule)
    return []
  }
  if (descriptorName === 'tools.json') {
    if (Array.isArray(document)) return arrayDefinitions(document, 'tools.json')
    const catalog = record(document, 'tools.json 必须是数组或包含 tools 数组的对象')
    return arrayDefinitions(catalog.tools, 'tools.json tools')
  }
  return [{ value: document, label: descriptorName, defaultModule: undefined }]
}

function arrayDefinitions(value: unknown, label: string, defaultModule?: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error(`${label} 必须是 1 到 100 项的数组`)
  return value.map((item, index) => ({ value: item, label: `${label}[${index}]`, defaultModule }))
}

async function resolveToolModule(descriptorPath: string, configured: unknown) {
  if (configured !== undefined) return relativeFile(configured, 'Tool module')
  const descriptorName = descriptorPath.replaceAll('\\', '/').split('/').at(-1)!
  const baseName = descriptorName.toLocaleLowerCase().endsWith('.tool.json') ? descriptorName.slice(0, -'.tool.json'.length) : ''
  const stems = baseName ? [baseName] : ['tool', 'index']
  const candidates = stems.flatMap(stem => [...moduleExtensions].map(extension => `${stem}${extension}`))
  const existing: string[] = []
  for (const candidate of candidates) if ((await stat(resolve(descriptorPath, '..', candidate)).catch(() => null))?.isFile()) existing.push(candidate)
  if (!existing.length) throw new Error(`Tool module 未声明，且未找到约定模块：${candidates.join('、')}`)
  if (existing.length > 1) throw new Error(`Tool module 存在多个候选，请显式声明 module：${existing.join('、')}`)
  return existing[0]
}

function isToolDescriptor(name: string) {
  const normalized = name.toLocaleLowerCase()
  return normalized.endsWith('.tool.json') || normalized === 'tool.json' || normalized === 'tools.json' || normalized === 'package.json'
}

function isInlineToolModule(name: string) { return /\.(?:ts|js|mjs)$/iu.test(name) && !/\.d\.ts$/iu.test(name) }

function parseInlineToolManifest(source: string, path: string) {
  const program = parse(source, { sourceType: 'module', sourceFilename: path, plugins: path.toLocaleLowerCase().endsWith('.ts') ? ['typescript'] : [] }).program
  const manifests: Array<{ name: string; initializer: Expression }> = []
  for (const statement of program.body) {
    if (statement.type !== 'ExportNamedDeclaration' || statement.declaration?.type !== 'VariableDeclaration') continue
    for (const declaration of statement.declaration.declarations) {
      if (declaration.id.type === 'Identifier' && inlineManifestNames.has(declaration.id.name) && declaration.init) manifests.push({ name: declaration.id.name, initializer: declaration.init as Expression })
    }
  }
  if (!manifests.length) throw new Error('单文件 Tool 必须静态导出 tool、toolManifest 或 metadata 对象')
  if (manifests.length > 1) throw new Error(`单文件 Tool 存在多个清单导出：${manifests.map(item => item.name).join('、')}`)
  return record(literalValue(manifests[0].initializer, manifests[0].name), '单文件 Tool 清单必须是对象字面量')
}

function literalValue(node: Expression, label: string): unknown {
  const expression = unwrapExpression(node)
  if (expression.type === 'StringLiteral') return expression.value
  if (expression.type === 'NumericLiteral') return expression.value
  if (expression.type === 'BooleanLiteral') return expression.value
  if (expression.type === 'NullLiteral') return null
  if (expression.type === 'TemplateLiteral' && !expression.expressions.length) return expression.quasis[0]?.value.cooked ?? expression.quasis[0]?.value.raw ?? ''
  if (expression.type === 'UnaryExpression' && expression.operator === '-' && expression.argument.type === 'NumericLiteral') return -expression.argument.value
  if (expression.type === 'ArrayExpression') return expression.elements.map((item, index) => {
    if (!item || item.type === 'SpreadElement') throw new Error(`${label}[${index}] 只允许静态字面量`)
    return literalValue(item as Expression, `${label}[${index}]`)
  })
  if (expression.type === 'ObjectExpression') {
    const result: Record<string, unknown> = {}
    for (const property of expression.properties) {
      if (property.type !== 'ObjectProperty' || property.computed || property.shorthand) throw new Error(`${label} 只允许静态属性赋值`)
      const name = propertyName(property)
      if (name === '__proto__' || name === 'constructor' || name === 'prototype') throw new Error(`${label}.${name} 不允许使用`)
      result[name] = literalValue(property.value as Expression, `${label}.${name}`)
    }
    return result
  }
  throw new Error(`${label} 只允许 JSON 兼容的静态字面量`)
}

function unwrapExpression(node: Expression): Expression {
  if (node.type === 'ParenthesizedExpression' || node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSTypeAssertion') return unwrapExpression(node.expression)
  return node
}

function propertyName(property: ObjectProperty) {
  const name = property.key
  if (name.type === 'Identifier') return name.name
  if (name.type === 'StringLiteral' || name.type === 'NumericLiteral') return String(name.value)
  throw new Error('单文件 Tool 清单属性名必须是静态文本')
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

function optionalRecord(value: unknown) { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined }

function portable(path: string) { return path.replaceAll('\\', '/') }
function message(error: unknown) { return error instanceof Error ? error.message : String(error) }
function missing(error: unknown) { return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') }
