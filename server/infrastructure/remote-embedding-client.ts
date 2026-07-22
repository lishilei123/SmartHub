import { encodingForModel, getEncoding, type TiktokenModel } from 'js-tiktoken'
import type { TokenCodec } from '../application/content.js'
import type { KnowledgeConfig } from '../domain/types.js'

export type ResolvedEmbeddingRoute = { sourceId: string; model: string; baseUrl: string; apiKey?: string }

type Fetch = typeof fetch
type EmbeddingResponse = { data?: { embedding?: number[]; index?: number }[] }
type RemotePayload = {
  data?: { embedding?: number[]; index?: number }[]
  embeddings?: number[][]
  error?: string | { message?: string }
}

const cl100k = getEncoding('cl100k_base')

export class RemoteEmbeddingClient {
  constructor(private readonly request: Fetch = fetch) {}

  tokenCodec(model: string): TokenCodec {
    let tokenizer = cl100k
    try { tokenizer = encodingForModel(model as TiktokenModel) }
    catch { /* OpenAI-compatible custom models use the documented cl100k fallback. */ }
    return { count: text => tokenizer.encode(text).length, maxTokens: 8191 }
  }

  async embed(route: ResolvedEmbeddingRoute, config: KnowledgeConfig, texts: string[], signal?: AbortSignal) {
    throwIfAborted(signal)
    if (!texts.length) return []
    const vectors: number[][] = []
    for (let offset = 0; offset < texts.length; offset += config.embeddingBatchSize) {
      throwIfAborted(signal)
      const batch = texts.slice(offset, offset + config.embeddingBatchSize)
      const response = await this.post(route, config, { model: route.model, input: batch, dimensions: config.embeddingDimensions }, signal)
      const ordered = [...(response.data ?? [])].sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      if (ordered.length !== batch.length) throw new Error(`远程 Embedding 返回数量不匹配：期望 ${batch.length}，实际 ${ordered.length}`)
      for (const item of ordered) {
        const vector = item.embedding
        if (!Array.isArray(vector) || vector.some(value => !Number.isFinite(value))) throw new Error('远程 Embedding 返回了无效向量')
        if (vector.length !== config.embeddingDimensions) throw new Error(`远程 Embedding 维度不匹配：配置 ${config.embeddingDimensions}，实际 ${vector.length}`)
        vectors.push(vector)
      }
    }
    return vectors
  }

  async detectDimensions(route: ResolvedEmbeddingRoute, config: KnowledgeConfig) {
    const response = await this.post(route, config, { model: route.model, input: ['SmartHub 向量维度自动检测'] })
    const vector = response.data?.[0]?.embedding
    if (!Array.isArray(vector) || !vector.length || vector.some(value => !Number.isFinite(value))) throw new Error('远程 Embedding 未返回有效向量，无法自动检测维度')
    return vector.length
  }

  private async post(route: ResolvedEmbeddingRoute, config: KnowledgeConfig, body: Record<string, unknown>, signal?: AbortSignal) {
    const endpoint = embeddingsEndpoint(route.baseUrl)
    let lastError: Error | null = null
    for (let attempt = 0; attempt <= config.embeddingRetries; attempt += 1) {
      throwIfAborted(signal)
      const controller = new AbortController()
      const abort = () => controller.abort(signal?.reason)
      signal?.addEventListener('abort', abort, { once: true })
      const timeout = setTimeout(() => controller.abort(), config.embeddingTimeoutMs)
      try {
        const response = await this.request(endpoint.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(route.apiKey ? { authorization: `Bearer ${route.apiKey}` } : {}) },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        const raw = await response.text()
        const payload = parsePayload(response, raw)
        if (!response.ok) throw new RemoteResponseError(response.status, responseError(payload) ?? `HTTP ${response.status}`)
        return normalizePayload(payload, endpoint.protocol)
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error
        lastError = error instanceof Error ? error : new Error('远程 Embedding 请求失败')
        const retryable = !(error instanceof RemoteResponseError) || error.status === 429 || error.status >= 500
        if (!retryable || attempt >= config.embeddingRetries) break
        await waitForRetry(Math.min(250 * (2 ** attempt), 4000), signal)
      } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
    }
    throw new Error(`远程 Embedding 请求失败：${safeProviderMessage(lastError?.message)}`)
  }
}

class RemoteResponseError extends Error { constructor(readonly status: number, message: string) { super(message) } }

function throwIfAborted(signal?: AbortSignal) { if (signal?.aborted) throw signal.reason ?? new Error('Embedding 请求已中止') }

function waitForRetry(delayMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolvePromise, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('Embedding 请求已中止')); return }
    const timeout = setTimeout(() => { signal?.removeEventListener('abort', abort); resolvePromise() }, delayMs)
    const abort = () => { clearTimeout(timeout); reject(signal?.reason ?? new Error('Embedding 请求已中止')) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function embeddingsEndpoint(baseUrl: string): { url: string; protocol: 'openai' | 'ollama' } {
  const value = baseUrl.trim().replace(/\/+$/, '')
  if (!value) throw new Error('远程 Embedding 来源未配置地址')
  if (/\/api\/embed$/i.test(value)) return { url: value, protocol: 'ollama' }
  if (/\/api$/i.test(value)) return { url: `${value}/embed`, protocol: 'ollama' }
  if (/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):11434$/i.test(value)) return { url: `${value}/api/embed`, protocol: 'ollama' }
  return { url: /\/embeddings$/i.test(value) ? value : `${value}/embeddings`, protocol: 'openai' }
}

function parsePayload(response: Response, raw: string): RemotePayload {
  let value: unknown
  try { value = JSON.parse(raw) }
  catch { throw new RemoteResponseError(response.status, `远程 Embedding 返回了非 JSON 响应（HTTP ${response.status}）。`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RemoteResponseError(response.status, `远程 Embedding 返回了无效响应（HTTP ${response.status}）。`)
  return value as RemotePayload
}

function normalizePayload(payload: RemotePayload, protocol: 'openai' | 'ollama'): EmbeddingResponse {
  if (protocol === 'ollama' || Array.isArray(payload.embeddings)) return { data: payload.embeddings?.map((embedding, index) => ({ embedding, index })) }
  return { data: payload.data }
}

function responseError(payload: RemotePayload) {
  if (typeof payload.error === 'string') return payload.error
  return payload.error?.message
}

function safeProviderMessage(message?: string) {
  if (!message) return '远程服务不可用'
  return message.replace(/https?:\/\/[^\s'"`]+/giu, '[已隐藏地址]').replace(/(?:bearer|api[_ -]?key|token)\s+[^\s,;]+/giu, '$1 [已隐藏]').slice(0, 240)
}
