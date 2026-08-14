import { createHash, randomUUID } from 'node:crypto'
import type { GenerativeCapability, GenerativeModel, GenerativeModelSource, GenerativeProviderType, ModelHealth } from '../domain/types.js'
import type { StateStore } from '../infrastructure/store.js'

const providerTypes = new Set<GenerativeProviderType>(['openai', 'anthropic', 'openai_compatible'])
const capabilities = new Set<GenerativeCapability>(['structured_output', 'tool_calling', 'vision', 'reasoning'])

export class ModelService {
  constructor(private readonly store: StateStore) {}

  async listSources() {
    const sources = this.store.listModelSources
      ? await this.store.listModelSources()
      : (await this.store.snapshot()).modelSources
    return sources.sort((left, right) => left.priority - right.priority || left.createdAt.localeCompare(right.createdAt)).map(source => this.publicSource(source))
  }

  async replaceSources(input: unknown) {
    if (!Array.isArray(input)) throw new Error('模型来源必须是数组')
    return this.transaction(draft => {
      const previous = new Map(draft.modelSources.map(source => [source.id, source]))
      const now = new Date().toISOString()
      const sources = input.map((value, index) => this.normalizeSource(value, index + 1, previous, now))
      this.validateUniqueSources(sources)
      draft.modelSources = sources
      return sources.map(source => this.publicSource(source))
    })
  }

  async createSource(input: unknown) {
    const now = new Date().toISOString()
    const source = await this.transaction(draft => {
      const source = this.normalizeSource(input, draft.modelSources.length + 1, new Map(), now)
      this.validateUniqueSources([...draft.modelSources, source])
      draft.modelSources.push(source)
      return source
    })
    return this.publicSource(source)
  }

  async updateSource(id: string, input: unknown) {
    const now = new Date().toISOString()
    return this.transaction(draft => {
      const index = draft.modelSources.findIndex(source => source.id === id)
      if (index < 0) throw new Error('模型来源不存在')
      const merged = { ...this.publicSource(draft.modelSources[index]), ...object(input), id }
      const source = this.normalizeSource(merged, draft.modelSources[index].priority, new Map([[id, draft.modelSources[index]]]), now)
      const next = [...draft.modelSources]
      next[index] = source
      this.validateUniqueSources(next)
      draft.modelSources = next
      return source
    }).then(source => this.publicSource(source))
  }

  async deleteSource(id: string) {
    const source = await this.transaction(draft => {
      const index = draft.modelSources.findIndex(source => source.id === id)
      if (index < 0) throw new Error('模型来源不存在')
      const [removed] = draft.modelSources.splice(index, 1)
      draft.modelSources.forEach((source, priority) => { source.priority = priority + 1 })
      return removed
    })
    return this.publicSource(source)
  }

  async discover(input: unknown) {
    const value = object(input)
    const sourceId = cleanId(value.id)
    const saved = sourceId ? (this.store.listModelSources ? await this.store.listModelSources() : (await this.store.snapshot()).modelSources).find(source => source.id === sourceId) : undefined
    const providerType = String(value.providerType ?? saved?.providerType ?? '') as GenerativeProviderType
    if (!providerTypes.has(providerType)) throw new Error('不支持的模型协议类型')
    if (providerType === 'anthropic') throw new Error('Anthropic 不提供标准模型列表接口，请手动注册已获授权的模型')
    const endpoint = validBaseUrl(String(value.baseUrl ?? '').trim() || saved?.baseUrl || '')
    const credential = String(value.apiKey ?? '').trim() || saved?.apiKey || ''
    const url = modelListUrl(endpoint)
    const response = await fetch(url, { headers: credential ? { authorization: `Bearer ${credential}` } : {}, signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw await providerError(response, credential, endpoint)
    const body = await response.json() as { data?: { id?: unknown }[]; models?: { name?: unknown }[] }
    const names = [
      ...(Array.isArray(body.data) ? body.data.map(item => String(item.id ?? '')) : []),
      ...(Array.isArray(body.models) ? body.models.map(item => String(item.name ?? '').replace(/^models\//, '')) : []),
    ].filter(Boolean)
    return [...new Set(names)].sort().map(name => ({ name, displayName: name }))
  }

  async probe(sourceId: string, modelId: string) {
    const sources = this.store.listModelSources ? await this.store.listModelSources() : (await this.store.snapshot()).modelSources
    const source = sources.find(item => item.id === sourceId)
    if (!source) throw new Error('模型来源不存在')
    const model = source.models.find(item => item.id === modelId)
    if (!model) throw new Error('模型不存在')
    if (!source.enabled || !model.enabled) throw new Error('请先启用模型来源和模型')

    const checkedAt = new Date().toISOString()
    let health: ModelHealth = 'healthy'
    let message = 'model-probe/v2 质量门禁通过'
    const sample = controlledProbeSample()
    let checks = { connectivity: false, longContext: false, structuredSubmission: false, toolCalling: false }
    try {
      const endpoint = source.baseUrl
      const credential = source.apiKey
      const requireToolCall = model.capabilities.includes('tool_calling')
      const response = source.providerType === 'anthropic'
        ? await probeAnthropic(endpoint, credential, model.name, requireToolCall, sample.content)
        : await probeOpenAi(endpoint, credential, model.name, requireToolCall, sample.content)
      if (!response.ok) throw await providerError(response, credential, endpoint)
      checks.connectivity = true
      if (requireToolCall) {
        const body = await response.json() as Record<string, unknown>
        const submission = requiredProbeSubmission(body, source.providerType)
        checks.toolCalling = Boolean(submission)
        checks.longContext = submission?.contextMarker === sample.marker
        checks.structuredSubmission = submission?.schemaVersion === 'model-probe/v2' && submission?.finding?.severity === 'blocker' && typeof submission.finding.title === 'string' && submission.finding.title.length > 0
        if (!checks.toolCalling) throw new Error('模型普通生成可用，但未按要求产生工具调用（质量门禁提交）；不能用于需求分析 Agent')
        if (!checks.longContext) throw new Error('模型未能从受控长上下文末尾恢复固定标记')
        if (!checks.structuredSubmission) throw new Error('模型提交的结构化质量门禁结果不完整')
      } else {
        throw new Error('需求分析模型必须声明并通过工具调用质量门禁')
      }
    } catch (error) {
      health = 'degraded'
      message = error instanceof Error ? error.message : '连通性探测失败'
    }

    const updated = await this.transaction(draft => {
      const storedSource = draft.modelSources.find(item => item.id === sourceId)
      const storedModel = storedSource?.models.find(item => item.id === modelId)
      if (!storedSource || !storedModel) throw new Error('探测期间模型配置已被删除')
      storedModel.health = health
      storedModel.lastCheckedAt = checkedAt
      storedModel.healthMessage = message
      storedModel.qualityGate = {
        version: 'model-probe/v2', checkedAt, passed: health === 'healthy', sampleSha256: sample.sha256,
        inputCharacters: sample.content.length, checks,
        ...(health === 'healthy' ? {} : { failureSummary: message.slice(0, 500) }),
      }
      storedSource.lastCheckedAt = checkedAt
      storedSource.health = aggregateHealth(storedSource.models)
      storedSource.healthMessage = message
      storedSource.updatedAt = checkedAt
      return structuredClone(storedSource)
    })
    return { ok: health === 'healthy', message, checkedAt, source: this.publicSource(updated) }
  }

  private transaction<T>(operation: (draft: Awaited<ReturnType<StateStore['snapshot']>>) => T | Promise<T>): Promise<T> {
    return (this.store.transactionScope
      ? this.store.transactionScope('ai_configuration', operation)
      : this.store.transaction(operation)) as Promise<T>
  }

  private normalizeSource(input: unknown, priority: number, previous: Map<string, GenerativeModelSource>, now: string): GenerativeModelSource {
    const value = object(input)
    const id = cleanId(value.id) || randomUUID()
    const existing = previous.get(id)
    const name = required(value.name, '来源名称')
    const providerType = String(value.providerType ?? '') as GenerativeProviderType
    if (!providerTypes.has(providerType)) throw new Error(`模型来源“${name}”的协议类型不受支持`)
    const baseUrl = validBaseUrl(required(value.baseUrl, 'Base URL'))
    const submittedApiKey = String(value.apiKey ?? '').trim()
    const apiKey = submittedApiKey || existing?.apiKey || ''
    const connectionUnchanged = existing?.baseUrl === baseUrl && (!submittedApiKey || existing.apiKey === submittedApiKey) && existing?.providerType === providerType
    const rawModels = value.models
    if (!Array.isArray(rawModels) || !rawModels.length) throw new Error(`模型来源“${name}”至少需要一个模型`)
    const models = rawModels.map(raw => normalizeModel(raw, connectionUnchanged ? existing?.models : undefined))
    const modelNames = new Set<string>()
    for (const model of models) {
      const key = model.name.toLocaleLowerCase()
      if (modelNames.has(key)) throw new Error(`模型来源“${name}”存在重复模型标识：${model.name}`)
      modelNames.add(key)
    }
    return {
      id, name, providerType, baseUrl, apiKey,
      enabled: value.enabled !== false,
      health: connectionUnchanged ? existing?.health ?? 'unknown' : 'unknown',
      priority,
      models,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(connectionUnchanged && existing?.lastCheckedAt ? { lastCheckedAt: existing.lastCheckedAt, healthMessage: existing.healthMessage } : {}),
    }
  }

  private validateUniqueSources(sources: GenerativeModelSource[]) {
    const ids = new Set<string>()
    const names = new Set<string>()
    for (const source of sources) {
      const name = source.name.toLocaleLowerCase()
      if (ids.has(source.id)) throw new Error('模型来源 ID 不能重复')
      if (names.has(name)) throw new Error(`模型来源名称不能重复：${source.name}`)
      ids.add(source.id)
      names.add(name)
    }
  }

  private publicSource(source: GenerativeModelSource): GenerativeModelSource {
    return { ...structuredClone(source), apiKey: '', hasApiKey: Boolean(source.apiKey) }
  }
}

function normalizeModel(input: unknown, previous: GenerativeModel[] | undefined): GenerativeModel {
  const value = object(input)
  const id = cleanId(value.id) || randomUUID()
  const existing = previous?.find(model => model.id === id)
  const name = required(value.name, '模型标识')
  const displayName = required(value.displayName, '模型展示名称')
  const contextWindow = positiveInteger(value.contextWindow, `模型“${displayName}”上下文长度`)
  const maxOutputTokens = positiveInteger(value.maxOutputTokens, `模型“${displayName}”最大输出 Token`)
  if (maxOutputTokens > contextWindow) throw new Error(`模型“${displayName}”最大输出 Token 不能超过上下文长度`)
  const rawCapabilities = Array.isArray(value.capabilities) ? value.capabilities.map(String) : []
  if (rawCapabilities.some(item => !capabilities.has(item as GenerativeCapability))) throw new Error(`模型“${displayName}”包含不支持的能力声明`)
  const unchanged = existing?.name === name
    && existing.contextWindow === contextWindow
    && existing.maxOutputTokens === maxOutputTokens
    && JSON.stringify([...existing.capabilities].sort()) === JSON.stringify([...new Set(rawCapabilities)].sort())
  return {
    id, name, displayName, contextWindow, maxOutputTokens,
    capabilities: [...new Set(rawCapabilities)] as GenerativeCapability[],
    enabled: value.enabled !== false,
    health: unchanged ? existing?.health ?? 'unknown' : 'unknown',
    ...(unchanged && existing?.lastCheckedAt ? { lastCheckedAt: existing.lastCheckedAt, healthMessage: existing.healthMessage, qualityGate: existing.qualityGate } : {}),
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求结构无效')
  return value as Record<string, unknown>
}
function cleanId(value: unknown) { const id = String(value ?? '').trim(); return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : '' }
function required(value: unknown, label: string) { const text = String(value ?? '').trim(); if (!text) throw new Error(`${label}不能为空`); if (text.length > 200) throw new Error(`${label}过长`); return text }
function positiveInteger(value: unknown, label: string) { const number = Number(value); if (!Number.isInteger(number) || number <= 0) throw new Error(`${label}必须是正整数`); return number }
function validBaseUrl(value: string) {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error('Base URL 不是有效 URL') }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Base URL 只支持 HTTP/HTTPS')
  return parsed.toString().replace(/\/$/, '')
}
function modelListUrl(endpoint: string) {
  if (/\/models$/i.test(endpoint)) return endpoint
  if (/\/chat\/completions$/i.test(endpoint)) return endpoint.replace(/\/chat\/completions$/i, '/models')
  return `${endpoint}/models`
}
function chatUrl(endpoint: string) { return /\/chat\/completions$/i.test(endpoint) ? endpoint : `${endpoint}/chat/completions` }
function anthropicUrl(endpoint: string) { return /\/v1\/messages$/i.test(endpoint) ? endpoint : `${endpoint}/v1/messages` }
function probeOpenAi(endpoint: string, credential: string, model: string, requireToolCall: boolean, sample: string) {
  const tool = { type: 'function', function: { name: 'smarthub_requirement_submit_probe', description: 'Submit the controlled requirement analysis probe.', parameters: probeSubmissionSchema() } }
  return fetch(chatUrl(endpoint), {
    method: 'POST',
    headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: requireToolCall ? sample : 'Reply with OK.' }], max_tokens: requireToolCall ? 256 : 1, ...(requireToolCall ? { tools: [tool], tool_choice: { type: 'function', function: { name: 'smarthub_requirement_submit_probe' } } } : {}) }),
    signal: AbortSignal.timeout(30_000),
  })
}
function probeAnthropic(endpoint: string, credential: string, model: string, requireToolCall: boolean, sample: string) {
  const tool = { name: 'smarthub_requirement_submit_probe', description: 'Submit the controlled requirement analysis probe.', input_schema: probeSubmissionSchema() }
  return fetch(anthropicUrl(endpoint), {
    method: 'POST',
    headers: { 'x-api-key': credential, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: requireToolCall ? sample : 'Reply with OK.' }], max_tokens: requireToolCall ? 256 : 1, ...(requireToolCall ? { tools: [tool], tool_choice: { type: 'tool', name: 'smarthub_requirement_submit_probe' } } : {}) }),
    signal: AbortSignal.timeout(30_000),
  })
}
function requiredProbeSubmission(body: Record<string, unknown>, providerType: GenerativeProviderType): ProbeSubmission | null {
  if (providerType === 'anthropic') {
    const content = Array.isArray(body.content) ? body.content as Array<Record<string, unknown>> : []
    const call = content.find(item => item.type === 'tool_use' && item.name === 'smarthub_requirement_submit_probe')
    return parseProbeSubmission(call?.input)
  }
  const choices = Array.isArray(body.choices) ? body.choices as Array<Record<string, unknown>> : []
  return choices.map(choice => {
    const message = choice.message && typeof choice.message === 'object' ? choice.message as Record<string, unknown> : {}
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls as Array<Record<string, unknown>> : []
    const call = calls.find(call => {
      const fn = call.function && typeof call.function === 'object' ? call.function as Record<string, unknown> : {}
      return fn.name === 'smarthub_requirement_submit_probe'
    })
    if (!call) return null
    const fn = call.function && typeof call.function === 'object' ? call.function as Record<string, unknown> : {}
    try { return parseProbeSubmission(JSON.parse(String(fn.arguments ?? '{}'))) } catch { return null }
  }).find(Boolean) ?? null
}

type ProbeSubmission = { schemaVersion: string; contextMarker: string; finding: { title: string; severity: string } }
function parseProbeSubmission(value: unknown): ProbeSubmission | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const finding = raw.finding && typeof raw.finding === 'object' && !Array.isArray(raw.finding) ? raw.finding as Record<string, unknown> : {}
  return { schemaVersion: String(raw.schemaVersion ?? ''), contextMarker: String(raw.contextMarker ?? ''), finding: { title: String(finding.title ?? ''), severity: String(finding.severity ?? '') } }
}
function probeSubmissionSchema() { return { type: 'object', properties: { schemaVersion: { type: 'string', enum: ['model-probe/v2'] }, contextMarker: { type: 'string' }, finding: { type: 'object', properties: { title: { type: 'string', minLength: 1 }, severity: { type: 'string', enum: ['blocker'] } }, required: ['title', 'severity'], additionalProperties: false } }, required: ['schemaVersion', 'contextMarker', 'finding'], additionalProperties: false } }
function controlledProbeSample() {
  const marker = 'SMARTHUB-CONTEXT-END-7F3A'
  const paragraphs = Array.from({ length: 96 }, (_, index) => `需求段 ${index + 1}：订单在固定条件下进入状态 S${index + 1}，不得将相邻段落的条件混用。`).join('\n')
  const content = `这是 SmartHub model-probe/v2 受控质量门禁。阅读全部上下文后，调用 smarthub_requirement_submit_probe；schemaVersion 必须为 model-probe/v2，contextMarker 必须复制末尾标记，finding.title 填“缺少失败补偿”，severity 填 blocker。不要返回普通文本。\n${paragraphs}\n末尾固定标记：${marker}`
  return { marker, content, sha256: createHash('sha256').update(content).digest('hex') }
}
async function providerError(response: Response, credential: string, endpoint: string) {
  const raw = (await response.text()).slice(0, 400)
  const sanitized = (credential ? raw.replaceAll(credential, '••••••') : raw).replaceAll(endpoint, '[模型端点]')
  return new Error(`上游返回 HTTP ${response.status}${sanitized ? `：${sanitized}` : ''}`)
}
function aggregateHealth(models: GenerativeModel[]): ModelHealth {
  const enabled = models.filter(model => model.enabled)
  if (!enabled.length || enabled.every(model => model.health === 'unknown')) return 'unknown'
  if (enabled.some(model => model.health === 'healthy')) return enabled.every(model => model.health === 'healthy') ? 'healthy' : 'degraded'
  return 'degraded'
}
