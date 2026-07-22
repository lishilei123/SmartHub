import { encodingForModel, getEncoding, type TiktokenModel } from 'js-tiktoken'
import type { TokenCodec } from '../application/content.js'
import type { KnowledgeConfig } from '../domain/types.js'

type Fetch = typeof fetch
type EmbeddingResponse = { data?: { embedding?: number[]; index?: number }[]; error?: { message?: string } }

const cl100k = getEncoding('cl100k_base')

export class RemoteEmbeddingClient {
  constructor(private readonly request: Fetch = fetch) {}

  tokenCodec(model: string): TokenCodec {
    let tokenizer = cl100k
    try { tokenizer = encodingForModel(model as TiktokenModel) }
    catch { /* OpenAI-compatible custom models use the documented cl100k fallback. */ }
    return { count: text => tokenizer.encode(text).length, maxTokens: 8191 }
  }

  async embed(config: KnowledgeConfig, texts: string[], model = config.embeddingModel) {
    if (!texts.length) return []
    const vectors: number[][] = []
    for (let offset = 0; offset < texts.length; offset += config.embeddingBatchSize) {
      const batch = texts.slice(offset, offset + config.embeddingBatchSize)
      const response = await this.post(config, { model, input: batch, dimensions: config.embeddingDimensions })
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

  private async post(config: KnowledgeConfig, body: Record<string, unknown>) {
    const endpoint = embeddingsEndpoint(config.embeddingBaseUrl)
    let lastError: Error | null = null
    for (let attempt = 0; attempt <= config.embeddingRetries; attempt += 1) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), config.embeddingTimeoutMs)
      try {
        const response = await this.request(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(config.embeddingApiKey ? { authorization: `Bearer ${config.embeddingApiKey}` } : {}) },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        const payload = await response.json() as EmbeddingResponse
        if (!response.ok) throw new RemoteResponseError(response.status, payload.error?.message ?? `HTTP ${response.status}`)
        return payload
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('远程 Embedding 请求失败')
        const retryable = !(error instanceof RemoteResponseError) || error.status === 429 || error.status >= 500
        if (!retryable || attempt >= config.embeddingRetries) break
        await new Promise(resolvePromise => setTimeout(resolvePromise, Math.min(250 * (2 ** attempt), 4000)))
      } finally { clearTimeout(timeout) }
    }
    throw new Error(`远程 Embedding 请求失败：${lastError?.message ?? '未知错误'}`)
  }
}

class RemoteResponseError extends Error { constructor(readonly status: number, message: string) { super(message) } }

function embeddingsEndpoint(baseUrl: string) {
  const value = baseUrl.trim().replace(/\/+$/, '')
  if (!value) throw new Error('远程 Embedding Base URL 不能为空')
  return /\/embeddings$/i.test(value) ? value : `${value}/embeddings`
}
