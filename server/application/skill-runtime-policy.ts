import { extname } from 'node:path'
import type { SkillRuntimePolicy } from '../domain/types.js'

export const SKILL_EXECUTE_SCRIPT_TOOL_ID = 'skill.execute_script'
export const SKILL_HTTP_REQUEST_TOOL_ID = 'skill.http_request'
export const SKILL_RUNTIME_MANIFEST = 'skill-runtime.json'

const MAX_SCRIPTS = 20
const MAX_NETWORK_ORIGINS = 20

export function normalizeSkillRuntimePolicy(value: unknown, availableFiles?: ReadonlySet<string>): SkillRuntimePolicy | undefined {
  if (value == null) return undefined
  const input = object(value, 'Skill 运行权限清单必须是 JSON 对象')
  const scripts = array(input.scripts, 'scripts', MAX_SCRIPTS).map((item, index) => {
    const script = object(item, `scripts[${index}] 必须是对象`)
    const path = relativePath(script.path, `scripts[${index}].path`)
    if (extname(path).toLocaleLowerCase() !== '.ps1') throw new Error(`Skill 运行脚本仅支持 PowerShell .ps1：${path}`)
    if (availableFiles && !availableFiles.has(path.toLocaleLowerCase())) throw new Error(`Skill 运行脚本不存在：${path}`)
    if (script.runner !== undefined && script.runner !== 'powershell') throw new Error(`Skill 脚本运行器无效：${String(script.runner)}`)
    return { path, runner: 'powershell' as const, timeoutMs: integer(script.timeoutMs ?? 15_000, `scripts[${index}].timeoutMs`, 1_000, 120_000) }
  })
  const duplicateScript = scripts.find((script, index) => scripts.findIndex(item => item.path.toLocaleLowerCase() === script.path.toLocaleLowerCase()) !== index)
  if (duplicateScript) throw new Error(`Skill 运行脚本重复声明：${duplicateScript.path}`)

  let network: SkillRuntimePolicy['network']
  if (input.network != null) {
    const source = object(input.network, 'network 必须是对象')
    const allowedOrigins = array(source.allowedOrigins, 'network.allowedOrigins', MAX_NETWORK_ORIGINS).map((item, index) => origin(item, `network.allowedOrigins[${index}]`))
    if (!allowedOrigins.length) throw new Error('network.allowedOrigins 至少需要一个 Origin')
    const allowedMethods = array(source.allowedMethods ?? ['GET'], 'network.allowedMethods', 2).map(item => String(item).toLocaleUpperCase())
    if (!allowedMethods.length) throw new Error('network.allowedMethods 至少需要一个方法')
    if (allowedMethods.some(method => method !== 'GET' && method !== 'HEAD')) throw new Error('Skill 网络访问只支持 GET 或 HEAD')
    network = {
      allowedOrigins: [...new Set(allowedOrigins)],
      allowedMethods: [...new Set(allowedMethods)] as Array<'GET' | 'HEAD'>,
      timeoutMs: integer(source.timeoutMs ?? 15_000, 'network.timeoutMs', 1_000, 60_000),
    }
  }
  if (!scripts.length && !network) return undefined
  return { scripts, ...(network ? { network } : {}) }
}

export function requiredSkillRuntimeToolIds(runtime: SkillRuntimePolicy | undefined) {
  return [
    ...(runtime?.scripts.length ? [SKILL_EXECUTE_SCRIPT_TOOL_ID] : []),
    ...(runtime?.network ? [SKILL_HTTP_REQUEST_TOOL_ID] : []),
  ]
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} 必须是最多 ${max} 项的数组`)
  return value
}

function relativePath(value: unknown, label: string) {
  const result = String(value ?? '').trim().replaceAll('\\', '/')
  const parts = result.split('/')
  if (!result || result.startsWith('/') || /^[A-Za-z]:/u.test(result) || parts.some(part => !part || part === '.' || part === '..')) throw new Error(`${label} 必须是 Skill 目录内的相对路径`)
  return parts.join('/')
}

function origin(value: unknown, label: string) {
  let parsed: URL
  try { parsed = new URL(String(value ?? '').trim()) } catch { throw new Error(`${label} 必须是有效的 HTTP/HTTPS Origin`) }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error(`${label} 必须是无路径、凭据、查询和片段的 HTTP/HTTPS Origin`)
  return parsed.origin
}

function integer(value: unknown, label: string, min: number, max: number) {
  const result = Number(value)
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${label} 必须是 ${min} 到 ${max} 之间的整数`)
  return result
}
