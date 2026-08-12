import { Type } from 'typebox'
import type { TSchema } from 'typebox'
import rawConfig from './built-in-tools-config.json' with { type: 'json' }
import type { ToolDescriptor } from '../domain/tool-types.js'
import type { ToolResource } from '../domain/types.js'

export type BuiltInToolRisk = ToolResource['risk']
export type BuiltInToolRepeatPolicy = NonNullable<ToolDescriptor['repeatPolicy']>
export type BuiltInToolKey = keyof typeof rawConfig.tools

export interface BuiltInToolConfig {
  version: string
  piName: string
  label: string
  catalogName: string
  description: string
  catalogDescription: string
  risk: BuiltInToolRisk
  timeoutMs: number
  idempotent: boolean
  repeatPolicy?: BuiltInToolRepeatPolicy
  sourcePath: string
  handlerKey: string
  catalogVisible: boolean
  parameters: Record<string, unknown>
  variants?: Record<string, BuiltInToolVariantConfig>
}

export type BuiltInToolVariantConfig = Partial<Pick<BuiltInToolConfig, 'version' | 'label' | 'description' | 'parameters'>>

export interface BuiltInToolConfigFile {
  schemaVersion: number
  tools: Record<string, BuiltInToolConfig>
}

export const BUILT_IN_HANDLER_KEYS = [
  'workspace.read_file',
  'workspace.grep_files',
  'workspace.find_files',
  'workspace.list_directory',
  'knowledge.search',
  'knowledge.read_chunk',
  'skill.activate',
  'requirement-analysis.submit_result',
  'requirement-repair.submit_result',
  'requirement-release.submit_result',
  'test_design_points.submit_result',
  'test_design_cases.submit_result',
  'test_design_repair.submit_result',
  'skill.execute_script',
  'skill.http_request',
] as const

const allowedRisks = ['read', 'network_read', 'code_execution', 'internal_write', 'write_reversible', 'write_high_risk'] as const
const allowedRepeatPolicies = ['replay_success_once'] as const
const sourceRoots = ['server/tools', 'ai/tools'] as const
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/u
const handlerKeys = new Set<string>(BUILT_IN_HANDLER_KEYS)

export class BuiltInToolConfigResolver {
  constructor(private readonly config: BuiltInToolConfigFile) {}

  has(key: string) { return Object.hasOwn(this.config.tools, key) }

  get(key: string, variant?: string): BuiltInToolConfig {
    const base = this.config.tools[key]
    if (!base) throw new Error(`BUILT_IN_TOOL_CONFIG_NOT_FOUND: ${key}`)
    if (!variant) return structuredClone(base)
    const override = base.variants?.[variant]
    if (!override) throw new Error(`BUILT_IN_TOOL_VARIANT_NOT_FOUND: ${key}@${variant}`)
    return { ...structuredClone(base), ...structuredClone(override), variants: undefined }
  }

  keys(options: { catalogVisibleOnly?: boolean } = {}) {
    return Object.keys(this.config.tools).filter(key => !options.catalogVisibleOnly || this.config.tools[key].catalogVisible)
  }

  versions() {
    return Object.fromEntries(this.keys().map(key => [key, this.get(key).version]))
  }

  toToolResource(key: string, variant?: string): ToolResource {
    const config = this.get(key, variant)
    return {
      id: `builtin_tool_${key.replace(/[^a-z0-9]+/giu, '_')}`,
      kind: 'tool',
      key,
      name: config.catalogName,
      description: config.catalogDescription,
      version: config.version,
      enabled: true,
      status: 'ready',
      builtIn: true,
      managedBy: 'builtin',
      source: 'builtin',
      risk: config.risk,
      timeoutMs: config.timeoutMs,
      sourcePath: config.sourcePath,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }
  }

  toDescriptor(key: string, variant?: string): ToolDescriptor {
    const config = this.get(key, variant)
    return {
      id: key,
      piName: config.piName,
      version: config.version,
      label: config.label,
      description: config.description,
      risk: config.risk,
      parameters: jsonSchemaToTypebox(config.parameters),
      timeoutMs: config.timeoutMs,
      idempotent: config.idempotent,
      ...(config.repeatPolicy ? { repeatPolicy: config.repeatPolicy } : {}),
    }
  }
}

export function normalizeToolSourcePath(value: unknown) {
  const result = String(value ?? '').trim().replaceAll('\\', '/')
  const segments = result.split('/')
  if (!result || result.startsWith('/') || /^[A-Za-z]:/u.test(result) || segments.some(segment => !segment || segment === '.' || segment === '..')) throw new Error('工具源码路径必须是允许目录内的相对文件路径')
  if (!sourceRoots.some(root => result.startsWith(`${root}/`))) throw new Error(`工具源码只能位于 ${sourceRoots.join(' 或 ')}`)
  if (!['.ts', '.tsx', '.js', '.mjs', '.cjs'].some(extension => result.toLocaleLowerCase().endsWith(extension))) throw new Error('工具源码文件类型必须是 TypeScript 或 JavaScript')
  return result
}

function jsonSchemaToTypebox(schema: Record<string, unknown>): TSchema {
  const options = descriptionOptions(schema)
  if (Object.hasOwn(schema, 'const') || Array.isArray(schema.enum)) return Type.Unsafe<TSchema>(structuredClone(schema))
  if (schema.type === 'object') {
    const properties = schema.properties as Record<string, Record<string, unknown>>
    const required = new Set(schema.required as string[] | undefined)
    const shape: Record<string, TSchema> = {}
    for (const [key, value] of Object.entries(properties)) {
      const property = jsonSchemaToTypebox(value)
      shape[key] = required.has(key) ? property : Type.Optional(property)
    }
    return Type.Object(shape, { ...options, additionalProperties: schema.additionalProperties !== false })
  }
  if (schema.type === 'array') return Type.Array(jsonSchemaToTypebox(schema.items as Record<string, unknown>), arrayOptions(schema))
  if (schema.type === 'string') return Type.String(stringOptions(schema))
  if (schema.type === 'integer') return Type.Integer(numberOptions(schema))
  if (schema.type === 'number') return Type.Number(numberOptions(schema))
  return Type.Boolean(options)
}

function descriptionOptions(schema: Record<string, unknown>) {
  return typeof schema.description === 'string' ? { description: schema.description } : {}
}

function stringOptions(schema: Record<string, unknown>) {
  return {
    ...descriptionOptions(schema),
    ...(typeof schema.minLength === 'number' ? { minLength: schema.minLength } : {}),
    ...(typeof schema.maxLength === 'number' ? { maxLength: schema.maxLength } : {}),
  }
}

function numberOptions(schema: Record<string, unknown>) {
  return {
    ...descriptionOptions(schema),
    ...(typeof schema.minimum === 'number' ? { minimum: schema.minimum } : {}),
    ...(typeof schema.maximum === 'number' ? { maximum: schema.maximum } : {}),
  }
}

function arrayOptions(schema: Record<string, unknown>) {
  return {
    ...descriptionOptions(schema),
    ...(typeof schema.minItems === 'number' ? { minItems: schema.minItems } : {}),
    ...(typeof schema.maxItems === 'number' ? { maxItems: schema.maxItems } : {}),
  }
}

export function validateBuiltInToolConfig(value: unknown): BuiltInToolConfigFile {
  if (!isRecord(value)) throw new Error('BUILT_IN_TOOL_CONFIG_INVALID: 配置文件必须是对象')
  if (value.schemaVersion !== 1) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: 不支持的 schemaVersion：${String(value.schemaVersion)}`)
  if (!isRecord(value.tools)) throw new Error('BUILT_IN_TOOL_CONFIG_INVALID: tools 必须是对象')
  const tools: Record<string, BuiltInToolConfig> = {}
  for (const [key, tool] of Object.entries(value.tools)) tools[key] = validateTool(key, tool)
  validateHandlerCoverage(tools)
  validatePiNameUniqueness(tools)
  return { schemaVersion: 1, tools }
}

function validateTool(key: string, value: unknown): BuiltInToolConfig {
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(key)) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: 工具标识无效：${key}`)
  if (!isRecord(value)) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${key} 必须是对象`)
  const requiredStrings = ['version', 'piName', 'label', 'catalogName', 'description', 'catalogDescription', 'sourcePath', 'handlerKey'] as const
  for (const field of requiredStrings) if (!String(value[field] ?? '').trim()) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${key}.${field} 不能为空`)
  if (!versionPattern.test(String(value.version))) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${key}.version 格式无效`)
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/u.test(String(value.piName))) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${key}.piName 格式无效`)
  let sourcePath: string
  try { sourcePath = normalizeToolSourcePath(value.sourcePath) } catch { throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${key}.sourcePath 超出允许目录`) }
  if (value.handlerKey !== key || !handlerKeys.has(key)) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${key}.handlerKey 未映射到受控实现`)
  if (!allowedRisks.includes(value.risk as typeof allowedRisks[number])) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${key}.risk 无效`)
  if (!Number.isInteger(value.timeoutMs) || Number(value.timeoutMs) < 1_000 || Number(value.timeoutMs) > 300_000) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${key}.timeoutMs 无效`)
  if (typeof value.idempotent !== 'boolean' || typeof value.catalogVisible !== 'boolean') throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${key}.idempotent/catalogVisible 无效`)
  if (value.repeatPolicy !== undefined && !allowedRepeatPolicies.includes(value.repeatPolicy as typeof allowedRepeatPolicies[number])) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${key}.repeatPolicy 无效`)
  validateJsonSchema(value.parameters, `${key}.parameters`)
  const variants = validateVariants(key, value.variants)
  return {
    version: String(value.version), piName: String(value.piName), label: String(value.label), catalogName: String(value.catalogName), description: String(value.description), catalogDescription: String(value.catalogDescription), risk: value.risk as BuiltInToolRisk, timeoutMs: Number(value.timeoutMs), idempotent: value.idempotent, ...(value.repeatPolicy ? { repeatPolicy: value.repeatPolicy as BuiltInToolRepeatPolicy } : {}), sourcePath, handlerKey: key, catalogVisible: value.catalogVisible, parameters: structuredClone(value.parameters as Record<string, unknown>), ...(variants ? { variants } : {}),
  }
}

function validateVariants(key: string, value: unknown) {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${key}.variants 必须是对象`)
  const variants: Record<string, BuiltInToolVariantConfig> = {}
  for (const [variant, override] of Object.entries(value)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(variant) || !isRecord(override)) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${key}@${variant} 变体无效`)
    const fields = Object.keys(override)
    if (!fields.length || fields.some(field => !['version', 'label', 'description', 'parameters'].includes(field))) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${key}@${variant} 包含不允许的覆盖字段`)
    if (override.version !== undefined && (!isText(override.version) || !versionPattern.test(override.version))) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${key}@${variant}.version 无效`)
    if (override.label !== undefined && !isText(override.label)) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${key}@${variant}.label 无效`)
    if (override.description !== undefined && !isText(override.description)) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${key}@${variant}.description 无效`)
    if (override.parameters !== undefined) validateJsonSchema(override.parameters, `${key}@${variant}.parameters`)
    variants[variant] = structuredClone(override) as BuiltInToolVariantConfig
  }
  return variants
}

function validateHandlerCoverage(tools: Record<string, BuiltInToolConfig>) {
  const configured = new Set(Object.keys(tools))
  const missing = BUILT_IN_HANDLER_KEYS.filter(key => !configured.has(key))
  const unexpected = [...configured].filter(key => !handlerKeys.has(key))
  if (missing.length || unexpected.length) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: handler 覆盖不一致（缺少：${missing.join('、') || '无'}；未知：${unexpected.join('、') || '无'}）`)
}

function validatePiNameUniqueness(tools: Record<string, BuiltInToolConfig>) {
  const owners = new Map<string, string>()
  for (const [key, tool] of Object.entries(tools)) {
    const owner = owners.get(tool.piName)
    if (owner) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${key}.piName 与 ${owner} 重复`)
    owners.set(tool.piName, key)
  }
}

function validateJsonSchema(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${path} 必须是 JSON Schema 对象`)
  if (Object.hasOwn(value, 'const')) {
    assertFields(value, ['const', 'description'], path)
    if (!isJsonLiteral(value.const)) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${path}.const 无效`)
    validateDescription(value, path)
    return
  }
  if (Object.hasOwn(value, 'enum')) {
    assertFields(value, ['enum', 'description'], path)
    if (!Array.isArray(value.enum) || !value.enum.length || value.enum.some(item => !isJsonLiteral(item))) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${path}.enum 无效`)
    validateDescription(value, path)
    return
  }
  switch (value.type) {
    case 'object': {
      assertFields(value, ['type', 'properties', 'required', 'additionalProperties', 'description'], path)
      if (!isRecord(value.properties)) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${path}.properties 必须是对象`)
      if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean') throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${path}.additionalProperties 无效`)
      const properties = Object.keys(value.properties)
      if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some(item => typeof item !== 'string' || !Object.hasOwn(value.properties!, item)) || new Set(value.required).size !== value.required.length)) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${path}.required 无效`)
      validateDescription(value, path)
      for (const [name, schema] of Object.entries(value.properties)) validateJsonSchema(schema, `${path}.properties.${name}`)
      return
    }
    case 'array':
      assertFields(value, ['type', 'items', 'minItems', 'maxItems', 'description'], path)
      validateNonNegativeInteger(value.minItems, `${path}.minItems`)
      validateNonNegativeInteger(value.maxItems, `${path}.maxItems`)
      if (typeof value.minItems === 'number' && typeof value.maxItems === 'number' && value.minItems > value.maxItems) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${path} 数组范围无效`)
      validateDescription(value, path)
      validateJsonSchema(value.items, `${path}.items`)
      return
    case 'string':
      assertFields(value, ['type', 'minLength', 'maxLength', 'description'], path)
      validateNonNegativeInteger(value.minLength, `${path}.minLength`)
      validateNonNegativeInteger(value.maxLength, `${path}.maxLength`)
      if (typeof value.minLength === 'number' && typeof value.maxLength === 'number' && value.minLength > value.maxLength) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${path} 字符串范围无效`)
      validateDescription(value, path)
      return
    case 'integer':
    case 'number':
      assertFields(value, ['type', 'minimum', 'maximum', 'description'], path)
      if (value.minimum !== undefined && !Number.isFinite(value.minimum)) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${path}.minimum 无效`)
      if (value.maximum !== undefined && !Number.isFinite(value.maximum)) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${path}.maximum 无效`)
      if (typeof value.minimum === 'number' && typeof value.maximum === 'number' && value.minimum > value.maximum) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${path} 数值范围无效`)
      validateDescription(value, path)
      return
    case 'boolean':
      assertFields(value, ['type', 'description'], path)
      validateDescription(value, path)
      return
    default:
      throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${path}.type 无效`)
  }
}

function assertFields(value: Record<string, unknown>, allowed: string[], path: string) {
  const unexpected = Object.keys(value).find(field => !allowed.includes(field))
  if (unexpected) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${path}.${unexpected} 不受支持`)
}

function validateDescription(value: Record<string, unknown>, path: string) {
  if (value.description !== undefined && (!isText(value.description))) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${path}.description 无效`)
}

function validateNonNegativeInteger(value: unknown, path: string) {
  if (value !== undefined && (!Number.isInteger(value) || Number(value) < 0)) throw new Error(`BUILT_IN_TOOL_CONFIG_INVALID: ${path} 无效`)
}

function isJsonLiteral(value: unknown): value is string | number | boolean | null { return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function isText(value: unknown): value is string { return typeof value === 'string' && Boolean(value.trim()) }

export const defaultBuiltInToolConfig = validateBuiltInToolConfig(rawConfig)
export const defaultBuiltInToolConfigResolver = new BuiltInToolConfigResolver(defaultBuiltInToolConfig)
