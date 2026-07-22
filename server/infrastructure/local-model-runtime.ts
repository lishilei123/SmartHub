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
  modelHub?: string
  fallbackUsed?: boolean
  error?: string
  updatedAt: string
}

export type ProgressInfo = { status: string; file?: string; progress?: number; modelHub?: string; fallbackUsed?: boolean }
type TensorResult = { tolist(): unknown[] }
type TokenizerResult = { input_ids: TensorResult }
type ModelTokenizer = ((text: string, options?: { add_special_tokens?: boolean }) => TokenizerResult) & { model_max_length?: number }
export type FeatureExtractor = ((texts: string | string[], options: { pooling: 'mean'; normalize: true }) => Promise<TensorResult>) & { dispose(): Promise<void>; tokenizer?: ModelTokenizer }
export type FeatureExtractorLoader = (model: string, cacheDirectory: string, onProgress: (info: ProgressInfo) => void) => Promise<FeatureExtractor>
export type PipelineFactory = (task: 'feature-extraction', model: string, options: { cache_dir: string; dtype: 'q8'; progress_callback: (info: ProgressInfo) => void }) => Promise<FeatureExtractor>
export type TransformersModuleLoader = () => Promise<{ env: { remoteHost: string }; pipeline: PipelineFactory }>

type RuntimeEntry = {
  extractor: FeatureExtractor | null
  activeOperation: Promise<void> | null
  generation: number
  status: LocalModelStatus
}

const now = () => new Date().toISOString()

const loadTransformers: TransformersModuleLoader = async () => {
  const module = await import('@huggingface/transformers')
  return { env: module.env, pipeline: module.pipeline as unknown as PipelineFactory }
}

export function createFeatureExtractorLoader(loadModule: TransformersModuleLoader = loadTransformers): FeatureExtractorLoader {
  return async (model, cacheDirectory, onProgress) => {
    const { env, pipeline } = await loadModule()
    const configuredPrimary = normalizeModelHub(process.env.SMARTHUB_MODEL_HUB?.trim())
    if (configuredPrimary) env.remoteHost = configuredPrimary
    const primary = normalizeModelHub(env.remoteHost)
    const fallbackSetting = process.env.SMARTHUB_MODEL_HUB_FALLBACK
    const fallback = fallbackSetting === undefined ? 'https://hf-mirror.com/' : normalizeModelHub(fallbackSetting.trim())
    const options = { cache_dir: cacheDirectory, dtype: 'q8' as const, progress_callback: onProgress }
    try {
      return await pipeline('feature-extraction', model, options)
    } catch (primaryError) {
      if (!fallback || fallback === primary || !isModelHubNetworkError(primaryError)) throw primaryError
      env.remoteHost = fallback
      onProgress({ status: 'fallback', file: '正在切换备用模型镜像', progress: 0, modelHub: fallback, fallbackUsed: true })
      try { return await pipeline('feature-extraction', model, options) }
      catch (fallbackError) { throw new Error(`主模型仓库连接失败，备用镜像 ${fallback} 也未能加载模型：${errorMessage(fallbackError)}`, { cause: fallbackError }) }
    }
  }
}

const defaultLoader = createFeatureExtractorLoader()

export class LocalModelRuntime {
  private readonly cacheDirectory: string
  private readonly entries = new Map<string, RuntimeEntry>()
  private currentModel = ''

  constructor(modelRoot: string, private readonly loader: FeatureExtractorLoader = defaultLoader) {
    this.cacheDirectory = resolve(modelRoot, 'cache')
  }

  status(model = this.currentModel) {
    const requested = model.trim()
    const entry = requested ? this.entries.get(requested) : undefined
    return entry ? { ...entry.status } : this.idleStatus(requested)
  }

  statuses() {
    return [...this.entries.values()].map(entry => ({ ...entry.status })).sort((left, right) => left.model.localeCompare(right.model))
  }

  start(model: string) {
    const requested = model.trim()
    if (!requested) throw new Error('模型名称不能为空')
    this.currentModel = requested
    const entry = this.getEntry(requested)
    if (entry.status.phase === 'running' || entry.activeOperation) return this.status(requested)
    const generation = ++entry.generation
    entry.status = { phase: 'downloading', model: requested, progress: 0, cacheDirectory: this.cacheDirectory, updatedAt: now() }
    entry.activeOperation = this.load(entry, requested, generation).finally(() => { entry.activeOperation = null })
    return this.status(requested)
  }

  private async load(entry: RuntimeEntry, model: string, generation: number) {
    try {
      await mkdir(this.cacheDirectory, { recursive: true })
      if (entry.extractor) { await entry.extractor.dispose(); entry.extractor = null }
      const extractor = await this.loader(model, this.cacheDirectory, info => {
        if (generation !== entry.generation) return
        const progress = Math.max(0, Math.min(100, Math.round(info.progress ?? entry.status.progress)))
        const phase = info.status === 'ready' || info.status === 'done' ? 'loading' : 'downloading'
        entry.status = { ...entry.status, phase, progress, file: info.file, modelHub: info.modelHub ?? entry.status.modelHub, fallbackUsed: info.fallbackUsed ?? entry.status.fallbackUsed, updatedAt: now() }
      })
      if (generation !== entry.generation) { await extractor.dispose(); return }
      entry.status = { ...entry.status, phase: 'loading', progress: 100, file: undefined, updatedAt: now() }
      const vectors = await runExtractor(extractor, ['SmartHub 本地模型运行检查'])
      if (generation !== entry.generation) { await extractor.dispose(); return }
      entry.extractor = extractor
      entry.status = { ...entry.status, phase: 'running', progress: 100, dimensions: vectors[0]?.length ?? 0, maxTokens: extractor.tokenizer?.model_max_length, updatedAt: now() }
    } catch (error) {
      if (generation !== entry.generation) return
      entry.extractor = null
      entry.status = { ...entry.status, phase: 'failed', error: describeError(error), updatedAt: now() }
    }
  }

  async stop(model = this.currentModel) {
    const requested = model.trim()
    if (!requested) return this.idleStatus('')
    this.currentModel = requested
    const entry = this.getEntry(requested)
    ++entry.generation
    entry.status = { ...entry.status, phase: 'stopping', updatedAt: now() }
    if (entry.extractor) { await entry.extractor.dispose(); entry.extractor = null }
    entry.status = this.idleStatus(requested)
    return this.status(requested)
  }

  async embed(model: string, texts: string[]) {
    if (!texts.length) return []
    const requested = model.trim()
    const entry = this.entries.get(requested)
    if (entry?.status.phase !== 'running' || !entry.extractor) throw new Error(`本地模型 ${requested} 未运行，请先在知识库配置中拉取并启动模型`)
    return runExtractor(entry.extractor, texts)
  }

  async tokenCodec(model: string): Promise<TokenCodec | null> {
    await this.ensureRunning(model)
    const tokenizer = this.entries.get(model.trim())?.extractor?.tokenizer
    if (!tokenizer) return null
    return {
      maxTokens: tokenizer.model_max_length,
      count: text => flatten(tokenizer(text, { add_special_tokens: false }).input_ids.tolist()).length,
    }
  }

  async ensureRunning(model: string, timeoutMs = 5 * 60 * 1000) {
    const requested = model.trim()
    if (!requested) throw new Error('模型名称不能为空')
    this.currentModel = requested
    const entry = this.getEntry(requested)
    if (entry.status.phase === 'running') return this.status(requested)
    if (!entry.activeOperation) this.start(requested)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const status = this.status(requested)
      if (status.phase === 'running') return status
      if (status.phase === 'failed') throw new Error(status.error ?? '本地模型启动失败')
      if (status.phase === 'idle') throw new Error('本地模型启动已取消')
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    }
    throw new Error('本地模型启动超时，请检查模型仓库网络和磁盘空间')
  }

  private getEntry(model: string) {
    let entry = this.entries.get(model)
    if (!entry) {
      entry = { extractor: null, activeOperation: null, generation: 0, status: this.idleStatus(model) }
      this.entries.set(model, entry)
    }
    return entry
  }

  private idleStatus(model: string): LocalModelStatus {
    return { phase: 'idle', model, progress: 0, cacheDirectory: this.cacheDirectory, updatedAt: now() }
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

function normalizeModelHub(value: string | undefined) { return value ? value.endsWith('/') ? value : `${value}/` : '' }

function errorMessage(error: unknown) { return error instanceof Error ? error.message : '未知错误' }

function isModelHubNetworkError(error: unknown) {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    parts.push(current.message, String((current as Error & { code?: string }).code ?? ''))
    current = current.cause
  }
  return /(fetch failed|network|connect|connection|timeout|timed out|ssl|tls|certificate|unexpected eof|socket|econnreset|econnrefused|etimedout|eai_again|und_err)/i.test(parts.join(' '))
}
