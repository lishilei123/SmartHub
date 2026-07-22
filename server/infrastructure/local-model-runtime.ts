import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { TokenCodec } from '../application/content.js'

export type LocalModelPhase = 'idle' | 'downloading' | 'loading' | 'running' | 'stopping' | 'failed'

export interface LocalModelStatus {
  phase: LocalModelPhase
  model: string
  progress: number
  cacheDirectory: string
  file?: string
  dimensions?: number
  maxTokens?: number
  error?: string
  updatedAt: string
}

type ProgressInfo = { status: string; file?: string; progress?: number }
type TensorResult = { tolist(): unknown[] }
type TokenizerResult = { input_ids: TensorResult }
type ModelTokenizer = ((text: string, options?: { add_special_tokens?: boolean }) => TokenizerResult) & { model_max_length?: number }
export type FeatureExtractor = ((texts: string | string[], options: { pooling: 'mean'; normalize: true }) => Promise<TensorResult>) & { dispose(): Promise<void>; tokenizer?: ModelTokenizer }
export type FeatureExtractorLoader = (model: string, cacheDirectory: string, onProgress: (info: ProgressInfo) => void) => Promise<FeatureExtractor>

const now = () => new Date().toISOString()

async function defaultLoader(model: string, cacheDirectory: string, onProgress: (info: ProgressInfo) => void) {
  const { env, pipeline } = await import('@huggingface/transformers')
  const modelHub = process.env.SMARTHUB_MODEL_HUB?.trim()
  if (modelHub) env.remoteHost = modelHub.endsWith('/') ? modelHub : `${modelHub}/`
  return pipeline('feature-extraction', model, { cache_dir: cacheDirectory, dtype: 'q8', progress_callback: onProgress })
}

export class LocalModelRuntime {
  private extractor: FeatureExtractor | null = null
  private activeOperation: Promise<void> | null = null
  private generation = 0
  private current: LocalModelStatus

  constructor(modelRoot: string, private readonly loader: FeatureExtractorLoader = defaultLoader) {
    const cacheDirectory = resolve(modelRoot, 'cache')
    this.current = { phase: 'idle', model: '', progress: 0, cacheDirectory, updatedAt: now() }
  }

  status() { return { ...this.current } }

  start(model: string) {
    const requested = model.trim()
    if (!requested) throw new Error('模型名称不能为空')
    if (this.current.phase === 'running' && this.current.model === requested) return this.status()
    if (this.activeOperation) throw new Error('已有本地模型正在下载或加载')
    const generation = ++this.generation
    this.current = { phase: 'downloading', model: requested, progress: 0, cacheDirectory: this.current.cacheDirectory, updatedAt: now() }
    this.activeOperation = this.load(requested, generation).finally(() => { this.activeOperation = null })
    return this.status()
  }

  private async load(model: string, generation: number) {
    try {
      await mkdir(this.current.cacheDirectory, { recursive: true })
      if (this.extractor) { await this.extractor.dispose(); this.extractor = null }
      const extractor = await this.loader(model, this.current.cacheDirectory, info => {
        if (generation !== this.generation) return
        const progress = Math.max(0, Math.min(100, Math.round(info.progress ?? this.current.progress)))
        const phase = info.status === 'ready' || info.status === 'done' ? 'loading' : 'downloading'
        this.current = { ...this.current, phase, progress, file: info.file, updatedAt: now() }
      })
      if (generation !== this.generation) { await extractor.dispose(); return }
      this.current = { ...this.current, phase: 'loading', progress: 100, file: undefined, updatedAt: now() }
      const vectors = await runExtractor(extractor, ['SmartHub 本地模型运行检查'])
      if (generation !== this.generation) { await extractor.dispose(); return }
      this.extractor = extractor
      this.current = { ...this.current, phase: 'running', progress: 100, dimensions: vectors[0]?.length ?? 0, maxTokens: extractor.tokenizer?.model_max_length, updatedAt: now() }
    } catch (error) {
      if (generation !== this.generation) return
      this.extractor = null
      this.current = { ...this.current, phase: 'failed', error: describeError(error), updatedAt: now() }
    }
  }

  async stop() {
    ++this.generation
    this.current = { ...this.current, phase: 'stopping', updatedAt: now() }
    if (this.extractor) { await this.extractor.dispose(); this.extractor = null }
    this.current = { phase: 'idle', model: '', progress: 0, cacheDirectory: this.current.cacheDirectory, updatedAt: now() }
    return this.status()
  }

  async embed(model: string, texts: string[]) {
    if (!texts.length) return []
    if (this.current.phase !== 'running' || !this.extractor) throw new Error('本地模型未运行，请先在知识库配置中拉取并启动模型')
    if (this.current.model !== model.trim()) throw new Error(`当前运行模型为 ${this.current.model}，请先启动配置中的模型 ${model}`)
    return runExtractor(this.extractor, texts)
  }

  async tokenCodec(model: string): Promise<TokenCodec | null> {
    await this.ensureRunning(model)
    const tokenizer = this.extractor?.tokenizer
    if (!tokenizer) return null
    return {
      maxTokens: tokenizer.model_max_length,
      count: text => flatten(tokenizer(text, { add_special_tokens: false }).input_ids.tolist()).length,
    }
  }

  async ensureRunning(model: string, timeoutMs = 5 * 60 * 1000) {
    const requested = model.trim()
    if (!requested) throw new Error('模型名称不能为空')
    if (this.current.phase === 'running' && this.current.model === requested) return this.status()
    if (!this.activeOperation) this.start(requested)
    else if (this.current.model !== requested) throw new Error(`模型 ${this.current.model} 正在加载，请完成后再切换到 ${requested}`)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.current.phase === 'running' && this.current.model === requested) return this.status()
      if (this.current.phase === 'failed') throw new Error(this.current.error ?? '本地模型启动失败')
      if (this.current.phase === 'idle') throw new Error('本地模型启动已取消')
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    }
    throw new Error('本地模型启动超时，请检查模型仓库网络和磁盘空间')
  }
}

async function runExtractor(extractor: FeatureExtractor, texts: string[]) {
  const result = await extractor(texts, { pooling: 'mean', normalize: true })
  const list = result.tolist()
  if (!Array.isArray(list[0])) return [list.map(Number)]
  return list.map(row => (row as unknown[]).map(Number))
}

function flatten(values: unknown[]): unknown[] { return values.flatMap(value => Array.isArray(value) ? flatten(value) : [value]) }

function describeError(error: unknown) {
  if (!(error instanceof Error)) return '本地模型加载失败'
  const cause = error.cause as { code?: string; message?: string } | undefined
  if (cause?.code === 'UND_ERR_CONNECT_TIMEOUT') return '连接模型仓库超时，请检查服务器网络，或通过 SMARTHUB_MODEL_HUB 配置系统模型镜像地址'
  return cause?.message ? `${error.message}：${cause.message}` : error.message
}
