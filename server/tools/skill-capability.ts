import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { Type } from 'typebox'
import { SKILL_EXECUTE_SCRIPT_TOOL_ID, SKILL_HTTP_REQUEST_TOOL_ID, requiredSkillRuntimeToolIds } from '../application/skill-runtime-policy.js'
import { matchesSkillConfigurationHash } from '../application/ai-resource-hash.js'
import type { AgentDefinitionVersion } from '../domain/agent-types.js'
import type { DatabaseState, SkillResource } from '../domain/types.js'
import type { ToolDescriptor, ToolExecutionContext } from '../domain/tool-types.js'
import { resolveManualSkillFile } from '../infrastructure/manual-skill-files.js'
import type { SkillPackageStore } from '../infrastructure/skill-package-store.js'
import type { ToolRegistry } from './registry.js'

const MAX_RESULT_BYTES = 256 * 1024
const MAX_SCRIPT_ARGUMENTS = 20
const MAX_SCRIPT_ARGUMENT_LENGTH = 500

export class SkillCapabilityRuntime {
  private readonly skills = new Map<string, SkillResource>()

  constructor(definition: AgentDefinitionVersion, state: DatabaseState, private readonly packages?: SkillPackageStore) {
    for (const binding of definition.skillBindings.filter(item => item.enabled)) {
      const skill = state.aiResources.find((item): item is SkillResource => item.kind === 'skill' && item.key === binding.skillKey)
      if (!skill || !skill.enabled || skill.version !== binding.version || !matchesSkillConfigurationHash(skill, binding.configurationHash)) continue
      this.skills.set(skill.key, skill)
    }
  }

  runtimeToolIds() {
    return [...new Set([...this.skills.values()].flatMap(skill => requiredSkillRuntimeToolIds(skill.runtime)))]
  }

  register(registry: ToolRegistry) {
    const toolIds = new Set(this.runtimeToolIds())
    if (toolIds.has(SKILL_EXECUTE_SCRIPT_TOOL_ID)) this.registerScriptTool(registry)
    if (toolIds.has(SKILL_HTTP_REQUEST_TOOL_ID)) this.registerNetworkTool(registry)
  }

  private registerScriptTool(registry: ToolRegistry) {
    registry.register(skillCapabilityDescriptor(SKILL_EXECUTE_SCRIPT_TOOL_ID), async (request, signal) => {
      const args = request.arguments as { skillKey?: string; script: string; args?: string[] }
      return { data: await this.executeScript(args.skillKey, args.script, args.args ?? [], request.context, signal) }
    })
  }

  private registerNetworkTool(registry: ToolRegistry) {
    registry.register(skillCapabilityDescriptor(SKILL_HTTP_REQUEST_TOOL_ID), async (request, signal) => {
      const args = request.arguments as { skillKey: string; url: string; method?: 'GET' | 'HEAD' }
      return { data: await this.httpRequest(args.skillKey, args.url, args.method ?? 'GET', signal) }
    })
  }

  private async executeScript(skillKey: string | undefined, scriptPath: string, args: string[], context: ToolExecutionContext, signal: AbortSignal) {
    const { skill, declared } = this.resolveScriptSkill(skillKey, scriptPath)
    if (!Array.isArray(args) || args.length > MAX_SCRIPT_ARGUMENTS || args.some(item => typeof item !== 'string' || item.length > MAX_SCRIPT_ARGUMENT_LENGTH)) throw new Error('SKILL_SCRIPT_ARGUMENTS_INVALID')
    const script = await this.resolveFile(skill, declared.path)
    const result = await runPowerShell(script, args, context.snapshot.runId, AbortSignal.any([signal, AbortSignal.timeout(declared.timeoutMs)]))
    const stdout = result.stdout.trim()
    let parsed: unknown
    if (stdout) { try { parsed = JSON.parse(stdout) } catch { parsed = undefined } }
    const output = { skillKey: skill.key, script: declared.path, exitCode: result.exitCode, ...(parsed === undefined ? { stdout } : { parsed }) }
    enforceResultSize(output, 'SKILL_SCRIPT_OUTPUT_TOO_LARGE')
    return output
  }

  private async httpRequest(skillKey: string, value: string, method: 'GET' | 'HEAD', signal: AbortSignal) {
    const skill = this.requiredSkill(skillKey)
    const policy = skill.runtime?.network
    if (!policy) throw new Error(`SKILL_NETWORK_NOT_ALLOWED: ${skillKey}`)
    let url: URL
    try { url = new URL(value) } catch { throw new Error('SKILL_NETWORK_URL_INVALID') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !policy.allowedOrigins.includes(url.origin)) throw new Error(`NETWORK_TARGET_FORBIDDEN: ${url.origin}`)
    if (!policy.allowedMethods.includes(method)) throw new Error(`NETWORK_METHOD_FORBIDDEN: ${method}`)
    const response = await fetch(url, { method, redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(policy.timeoutMs)]), headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.1', 'user-agent': 'SmartHub-SkillRuntime/1.0' } })
    if (response.status >= 300 && response.status < 400) throw new Error(`NETWORK_REDIRECT_FORBIDDEN: HTTP ${response.status}`)
    const body = method === 'HEAD' ? Buffer.alloc(0) : await readLimitedBody(response, signal)
    const text = body.toString('utf8')
    let parsed: unknown
    if (response.headers.get('content-type')?.includes('application/json') && text) { try { parsed = JSON.parse(text) } catch { parsed = undefined } }
    const result = { skillKey, url: url.toString(), method, status: response.status, contentType: response.headers.get('content-type') ?? '', ...(parsed === undefined ? { body: text } : { parsed }) }
    enforceResultSize(result, 'SKILL_NETWORK_RESPONSE_TOO_LARGE')
    return result
  }

  private requiredSkill(skillKey: string) {
    const skill = this.skills.get(skillKey)
    if (!skill) throw new Error(`SKILL_BINDING_UNAVAILABLE: ${skillKey}`)
    return skill
  }

  private resolveScriptSkill(skillKey: string | undefined, scriptPath: string) {
    if (skillKey) {
      const skill = this.requiredSkill(skillKey)
      const declared = skill.runtime?.scripts.find(item => item.path === scriptPath)
      if (!declared) throw new Error(`SKILL_SCRIPT_NOT_ALLOWED: ${skillKey}/${scriptPath}`)
      return { skill, declared }
    }
    const matches = [...this.skills.values()].flatMap(skill => {
      const declared = skill.runtime?.scripts.find(item => item.path === scriptPath)
      return declared ? [{ skill, declared }] : []
    })
    if (!matches.length) throw new Error(`SKILL_SCRIPT_NOT_ALLOWED: ${scriptPath}`)
    if (matches.length > 1) throw new Error(`SKILL_SCRIPT_SKILL_KEY_REQUIRED: ${scriptPath} 同时属于 ${matches.map(item => item.skill.key).join('、')}`)
    return matches[0]
  }

  private async resolveFile(skill: SkillResource, relativePath: string) {
    if (!skill.package) return resolveManualSkillFile(skill.entrypoint, relativePath)
    if (!this.packages) throw new Error(`SKILL_PACKAGE_STORE_UNAVAILABLE: ${skill.key}`)
    const entrypointDirectory = dirname(skill.package.entrypointPath).replaceAll('\\', '/')
    const archivePath = entrypointDirectory === '.' ? relativePath : `${entrypointDirectory}/${relativePath}`
    return this.packages.resolveFile(skill.package.storageKey, archivePath)
  }
}

function skillCapabilityDescriptor(id: typeof SKILL_EXECUTE_SCRIPT_TOOL_ID | typeof SKILL_HTTP_REQUEST_TOOL_ID): ToolDescriptor {
  if (id === SKILL_EXECUTE_SCRIPT_TOOL_ID) return {
    id,
    piName: 'skill_execute_script',
    version: '1.0.0',
    label: '执行已绑定 Skill 脚本',
    description: '仅执行当前已绑定 Skill 在 skill-runtime.json 中声明的 PowerShell 脚本。脚本路径必须被允许；仅路径重复时需要 skillKey 消歧。',
    risk: 'code_execution',
    parameters: Type.Object({
      skillKey: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      script: Type.String({ minLength: 1, maxLength: 500 }),
      args: Type.Optional(Type.Array(Type.String({ maxLength: MAX_SCRIPT_ARGUMENT_LENGTH }), { maxItems: MAX_SCRIPT_ARGUMENTS })),
    }, { additionalProperties: false }),
    timeoutMs: 120_000,
    idempotent: false,
  }
  return {
    id,
    piName: 'skill_http_request',
    version: '1.0.0',
    label: '访问已绑定 Skill 允许的网络目标',
    description: '仅向当前已绑定 Skill 在 skill-runtime.json 中声明的 HTTP/HTTPS Origin 发起 GET 或 HEAD 请求。',
    risk: 'network_read',
    parameters: Type.Object({
      skillKey: Type.String({ minLength: 1, maxLength: 100 }),
      url: Type.String({ minLength: 1, maxLength: 2_000 }),
      method: Type.Optional(Type.Union([Type.Literal('GET'), Type.Literal('HEAD')])),
    }, { additionalProperties: false }),
    timeoutMs: 60_000,
    idempotent: true,
  }
}

async function runPowerShell(script: string, args: string[], runId: string, signal: AbortSignal) {
  signal.throwIfAborted()
  return new Promise<{ exitCode: number; stdout: string }>((resolvePromise, reject) => {
    const child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, ...args], {
      cwd: dirname(script),
      env: restrictedEnvironment(runId),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let settled = false
    const finish = (error?: Error, exitCode = 0) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolvePromise({ exitCode, stdout: Buffer.concat(stdout).toString('utf8') })
    }
    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_RESULT_BYTES) {
        child.kill()
        finish(new Error('SKILL_SCRIPT_OUTPUT_TOO_LARGE'))
        return
      }
      target.push(Buffer.from(chunk))
    }
    const abort = () => { child.kill(); finish(new Error(signal.reason instanceof Error ? signal.reason.message : 'SKILL_SCRIPT_CANCELLED')) }
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', chunk => collect(stdout, chunk as Buffer))
    child.stderr.on('data', chunk => collect(stderr, chunk as Buffer))
    child.once('error', error => finish(new Error(`SKILL_SCRIPT_START_FAILED: ${error.message}`)))
    child.once('close', code => {
      const exitCode = code ?? -1
      if (exitCode !== 0) return finish(new Error(`SKILL_SCRIPT_FAILED(${exitCode}): ${Buffer.concat(stderr).toString('utf8').trim().slice(0, 2_000)}`), exitCode)
      finish(undefined, exitCode)
    })
    if (signal.aborted) abort()
  })
}

function restrictedEnvironment(runId: string): NodeJS.ProcessEnv {
  const source = process.env
  const environment: NodeJS.ProcessEnv = { SMARTHUB_RUN_ID: runId }
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (source[key]) environment[key] = source[key]
  return environment
}

async function readLimitedBody(response: Response, signal: AbortSignal) {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_RESULT_BYTES) throw new Error('SKILL_NETWORK_RESPONSE_TOO_LARGE')
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const current = await reader.read()
      if (current.done) break
      bytes += current.value.byteLength
      if (bytes > MAX_RESULT_BYTES) throw new Error('SKILL_NETWORK_RESPONSE_TOO_LARGE')
      chunks.push(Buffer.from(current.value))
    }
    return Buffer.concat(chunks)
  } finally { await reader.cancel().catch(() => undefined) }
}

function enforceResultSize(value: unknown, error: string) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_RESULT_BYTES) throw new Error(error)
}
