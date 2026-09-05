import { useEffect, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Database,
  Download,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  XCircle,
  Zap,
} from 'lucide-react'
import { type EmbeddingSourceDraft, type SettingsDraft } from '../prototype-data'
import {
  cancelTask,
  loadLocalModelStatuses,
  loadTasks,
  rebuildIndex,
  startLocalModel,
  stopLocalModel,
  testEmbeddingConfig,
  type LocalModelStatus,
} from '../knowledge-api'
import { type Notify, type JobStatus } from './types'
import { Badge, Progress, Modal } from './shared'

type SourceEditorDraft = { id?: string; name: string; baseUrl: string; apiKey: string; modelName: string }

const localModelRecommendations = [
  { name: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', title: '多语言通用 · 推荐', detail: '中英文知识库 · 384 维' },
  { name: 'Xenova/multilingual-e5-small', title: '多语言检索', detail: '面向语义检索 · 384 维' },
  { name: 'Xenova/all-MiniLM-L6-v2', title: '英文轻量模型', detail: '体积较小、速度快 · 384 维' },
] as const

export function EmbeddingModelPrototype({
  knowledgeBaseId,
  draft,
  update,
  notify,
}: {
  knowledgeBaseId: string
  draft: SettingsDraft
  update: <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => void
  notify: Notify
}) {
  const [testingModel, setTestingModel] = useState('')
  const [runtimeStatuses, setRuntimeStatuses] = useState<LocalModelStatus[]>([])
  const [runtimeBusy, setRuntimeBusy] = useState('')
  const [sourceEditor, setSourceEditor] = useState<SourceEditorDraft | null>(null)
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({})
  const [recommendationSourceId, setRecommendationSourceId] = useState('')
  const selectedSource =
    draft.embeddingSources.find(source => source.id === draft.embeddingSourceId) ?? draft.embeddingSources[0]

  useEffect(() => {
    if (!draft.embeddingSources.some(source => source.type === 'local')) return
    let active = true
    const refresh = () =>
      loadLocalModelStatuses()
        .then(statuses => {
          if (active) setRuntimeStatuses(statuses)
        })
        .catch(() => undefined)
    void refresh()
    const timer = window.setInterval(refresh, 1000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [draft.embeddingSources])

  useEffect(() => {
    let changed = false
    const sources = draft.embeddingSources.map(source =>
      source.type !== 'local'
        ? source
        : {
            ...source,
            models: source.models.map(model => {
              const dimensions = runtimeStatuses.find(
                status => status.model === model.name && status.phase === 'running',
              )?.dimensions
              if (!dimensions || dimensions === model.dimensions) return model
              changed = true
              return { ...model, dimensions }
            }),
          },
    )
    if (changed) update('embeddingSources', sources)
    const status = runtimeStatuses.find(item => item.model === draft.embeddingModel && item.phase === 'running')
    if (status?.dimensions && draft.embeddingDimensions !== String(status.dimensions))
      update('embeddingDimensions', String(status.dimensions))
  }, [
    draft.embeddingDimensions,
    draft.embeddingModel,
    draft.embeddingSourceId,
    draft.embeddingSources,
    runtimeStatuses,
    update,
  ])

  const applySelection = (source: EmbeddingSourceDraft, model = source.models[0]) => {
    if (!model) return
    update('embeddingSourceId', source.id)
    update('embeddingMode', source.type)
    update('embeddingBaseUrl', source.baseUrl)
    update('embeddingApiKey', source.apiKey)
    update('embeddingModel', model.name)
    update('embeddingDimensions', String(model.dimensions))
  }
  const updateSources = (sources: EmbeddingSourceDraft[]) => update('embeddingSources', sources)
  const replaceSource = (next: EmbeddingSourceDraft) =>
    updateSources(draft.embeddingSources.map(source => (source.id === next.id ? next : source)))

  const saveSource = () => {
    if (!sourceEditor) return
    const name = sourceEditor.name.trim()
    const baseUrl = sourceEditor.baseUrl.trim()
    if (!name) {
      notify('请填写来源名称。')
      return
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      notify('远程来源 Base URL 必须使用 http:// 或 https://。')
      return
    }
    if (sourceEditor.id) {
      const current = draft.embeddingSources.find(source => source.id === sourceEditor.id)
      if (!current || current.type !== 'remote_api') {
        notify('远程来源不存在，无法保存编辑。')
        return
      }
      const source: EmbeddingSourceDraft = { ...current, name, baseUrl, apiKey: sourceEditor.apiKey }
      replaceSource(source)
      if (draft.embeddingSourceId === source.id) {
        const model = source.models.find(candidate => candidate.name === draft.embeddingModel)
        if (model) applySelection(source, model)
      }
      setSourceEditor(null)
      notify(`已更新远程来源 ${name}。`)
      return
    }
    const modelName = sourceEditor.modelName.trim()
    if (!modelName) {
      notify('请填写首个模型名称。')
      return
    }
    const source: EmbeddingSourceDraft = {
      id: crypto.randomUUID(),
      name,
      type: 'remote_api',
      baseUrl,
      apiKey: sourceEditor.apiKey,
      models: [{ name: modelName, dimensions: 0 }],
    }
    updateSources([...draft.embeddingSources, source])
    setSourceEditor(null)
    notify(`已添加远程来源 ${name}，请在“知识库生效模型”中手动选择。`)
  }

  const editSource = (source: EmbeddingSourceDraft) => {
    if (source.type !== 'remote_api') return
    setSourceEditor({ id: source.id, name: source.name, baseUrl: source.baseUrl, apiKey: '', modelName: '' })
  }

  const addModel = (source: EmbeddingSourceDraft) => {
    const name = (modelDrafts[source.id] ?? '').trim()
    if (!name) {
      notify('请填写模型名称。')
      return
    }
    if (source.models.some(model => model.name === name)) {
      notify('该来源中已存在同名模型。')
      return
    }
    replaceSource({ ...source, models: [...source.models, { name, dimensions: 0 }] })
    setModelDrafts(current => ({ ...current, [source.id]: '' }))
    setRecommendationSourceId('')
  }

  const removeModel = async (source: EmbeddingSourceDraft, modelName: string) => {
    if (source.type === 'remote_api' && source.models.length === 1) {
      notify('远程来源至少需要保留一个模型；如不再使用，可以删除整个远程来源。')
      return
    }
    const runtime = source.type === 'local' ? runtimeStatuses.find(status => status.model === modelName) : undefined
    if (runtime && runtime.phase !== 'idle') {
      setRuntimeBusy(modelName)
      try {
        const status = await stopLocalModel(modelName)
        setRuntimeStatuses(current => [...current.filter(item => item.model !== modelName), status])
      } catch (error) {
        notify(error instanceof Error ? error.message : '停止本地模型失败，暂未删除。')
        return
      } finally {
        setRuntimeBusy('')
      }
    }
    const next = { ...source, models: source.models.filter(model => model.name !== modelName) }
    const sources = draft.embeddingSources.map(item => (item.id === source.id ? next : item))
    const fallback = next.models.length ? next : sources.find(item => item.models.length > 0)
    updateSources(sources)
    if (draft.embeddingSourceId === source.id && draft.embeddingModel === modelName) {
      if (fallback) applySelection(fallback)
      else {
        update('embeddingSourceId', source.id)
        update('embeddingMode', 'local')
        update('embeddingBaseUrl', '')
        update('embeddingApiKey', '')
        update('embeddingModel', '')
        update('embeddingDimensions', '0')
      }
    }
    if (draft.rerankerSourceId === source.id && draft.rerankerModel === modelName) {
      if (fallback) {
        update('rerankerSourceId', fallback.id)
        update('rerankerModel', fallback.models[0].name)
      } else {
        update('rerankerEnabled', false)
        update('rerankerSourceId', source.id)
        update('rerankerModel', '')
      }
    }
    notify(
      `已删除${source.type === 'local' ? '本地' : '远程'}模型 ${modelName}${fallback ? '，相关选择已自动更新。' : '；当前没有可用模型，请重新添加或配置远程来源。'}`,
    )
  }

  const removeSource = (sourceId: string) => {
    if (draft.embeddingSources.find(source => source.id === sourceId)?.type === 'local') {
      notify('本地模型为系统内置来源，不能删除。')
      return
    }
    if (draft.embeddingSources.length === 1) {
      notify('至少保留一个模型来源。')
      return
    }
    const remaining = draft.embeddingSources.filter(source => source.id !== sourceId)
    updateSources(remaining)
    if (draft.embeddingSourceId === sourceId) applySelection(remaining[0])
    if (draft.rerankerSourceId === sourceId) {
      update('rerankerSourceId', remaining[0].id)
      update('rerankerModel', remaining[0].models[0].name)
    }
  }

  const testConnection = async (source: EmbeddingSourceDraft, model: EmbeddingSourceDraft['models'][number]) => {
    setTestingModel(`${source.id}:${model.name}`)
    try {
      const result = await testEmbeddingConfig(knowledgeBaseId, {
        embeddingSourceId: source.id,
        embeddingSources: draft.embeddingSources,
        embeddingMode: 'remote_api',
        embeddingBaseUrl: source.baseUrl,
        embeddingApiKey: source.apiKey,
        embeddingModel: model.name,
        embeddingDimensions: model.dimensions,
        embeddingBatchSize: Number(draft.embeddingBatchSize),
        embeddingTimeoutMs: Number(draft.embeddingTimeoutMs),
        embeddingRetries: Number(draft.embeddingRetries),
      })
      updateSources(
        draft.embeddingSources.map(item =>
          item.id !== source.id
            ? item
            : {
                ...item,
                models: item.models.map(candidate =>
                  candidate.name === model.name ? { ...candidate, dimensions: result.dimensions } : candidate,
                ),
              },
        ),
      )
      if (draft.embeddingSourceId === source.id && draft.embeddingModel === model.name)
        update('embeddingDimensions', String(result.dimensions))
      notify(`连接验证成功：${source.name} / ${result.model} · ${result.dimensions} 维。`)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Embedding 连接验证失败。', 'error')
    } finally {
      setTestingModel('')
    }
  }

  const operateLocalModel = async (model: string, running: boolean) => {
    setRuntimeBusy(model)
    try {
      const status = running ? await stopLocalModel(model) : await startLocalModel(model)
      setRuntimeStatuses(current => [...current.filter(item => item.model !== model), status])
      notify(running ? `已停止本地模型 ${model}。` : `已开始拉取并加载 ${model}；其他模型继续运行。`)
    } catch (error) {
      notify(error instanceof Error ? error.message : '本地模型操作失败。')
    } finally {
      setRuntimeBusy('')
    }
  }

  const phaseLabel = (phase?: LocalModelStatus['phase']) =>
    phase === 'running'
      ? '运行中'
      : phase === 'downloading'
        ? '下载中'
        : phase === 'loading'
          ? '加载中'
          : phase === 'stopping'
            ? '停止中'
            : phase === 'failed'
              ? '启动失败'
              : '未运行'
  const phaseTone = (phase?: LocalModelStatus['phase']) =>
    phase === 'running' ? 'green' : phase === 'failed' ? 'red' : phase && phase !== 'idle' ? 'orange' : 'gray'

  return (
    <div className="model-resource-config">
      <div className="model-source-toolbar">
        <div>
          <b>模型来源</b>
          <small>本地模型始终可用；这里可以继续添加远程 API 来源</small>
        </div>
        <button
          className="btn primary"
          onClick={() => setSourceEditor({ name: '', baseUrl: '', apiKey: '', modelName: '' })}
        >
          <Plus />
          添加远程来源
        </button>
      </div>
      <div className="model-source-list">
        {draft.embeddingSources.map(source => (
          <section
            className={`model-source-card ${source.id === draft.embeddingSourceId ? 'selected' : ''} ${recommendationSourceId === source.id ? 'recommendations-open' : ''}`}
            key={source.id}
          >
            <header>
              <div className={`source-kind ${source.type}`}>
                {source.type === 'local' ? <Download /> : <Database />}
              </div>
              <span>
                <b>{source.name}</b>
                <small title={source.type === 'remote_api' ? source.baseUrl : undefined}>
                  {source.type === 'local' ? '系统内置 · 可同时运行多个模型' : source.baseUrl}
                </small>
              </span>
              <Badge tone={source.type === 'local' ? 'green' : 'purple'}>
                {source.type === 'local' ? '本地' : '远程 API'} · {source.models.length} 个
              </Badge>
              {source.type === 'remote_api' && (
                <>
                  <button
                    className="icon-btn"
                    title="编辑来源"
                    aria-label={`编辑来源 ${source.name}`}
                    onClick={() => editSource(source)}
                  >
                    <Pencil />
                  </button>
                  <button
                    className="icon-btn"
                    title="删除来源"
                    aria-label={`删除来源 ${source.name}`}
                    onClick={() => removeSource(source.id)}
                  >
                    <Trash2 />
                  </button>
                </>
              )}
            </header>
            <div className="source-model-list">
              <div className="source-model-table-head">
                <span>模型</span>
                <span>向量维度</span>
                <span>状态</span>
                <span>操作</span>
              </div>
              {source.models.map(model => {
                const runtime =
                  source.type === 'local' ? runtimeStatuses.find(status => status.model === model.name) : undefined
                const working =
                  runtime?.phase === 'downloading' || runtime?.phase === 'loading' || runtime?.phase === 'stopping'
                const running = runtime?.phase === 'running'
                const testKey = `${source.id}:${model.name}`
                const detectedDimensions = runtime?.dimensions ?? model.dimensions
                const dimensionReady = detectedDimensions > 0
                const statusLabel =
                  source.type === 'remote_api'
                    ? model.dimensions > 0
                      ? '已检测'
                      : '待检测'
                    : runtime?.fallbackUsed && running
                      ? '镜像运行'
                      : phaseLabel(runtime?.phase)
                return (
                  <div className={`source-model-row ${working ? 'working' : ''}`} key={model.name}>
                    <div className="model-identity">
                      <div
                        className={`model-state-dot ${runtime?.phase ?? (source.type === 'remote_api' && model.dimensions > 0 ? 'configured' : 'idle')}`}
                      />
                      <span>
                        <b title={model.name}>{model.name}</b>
                        <small>
                          {source.type === 'local' ? '本地模型' : 'API 模型'}
                          {runtime?.maxTokens ? ` · 最大 ${runtime.maxTokens} tokens` : ''}
                        </small>
                      </span>
                    </div>
                    <div
                      className={`model-dimension ${dimensionReady ? 'ready' : 'pending'} ${runtime?.error ? 'failed' : ''}`}
                    >
                      <b>{dimensionReady ? `${detectedDimensions} 维` : '自动检测'}</b>
                      <small title={runtime?.error}>
                        {runtime?.error ??
                          (dimensionReady ? '已识别' : source.type === 'local' ? '运行后识别' : '检测后识别')}
                      </small>
                    </div>
                    <Badge
                      tone={
                        source.type === 'remote_api'
                          ? model.dimensions > 0
                            ? 'blue'
                            : 'orange'
                          : phaseTone(runtime?.phase)
                      }
                    >
                      {statusLabel}
                    </Badge>
                    <div className="model-row-actions">
                      {source.type === 'local' ? (
                        <button
                          className={`btn ${running ? 'danger' : 'ghost'}`}
                          disabled={runtimeBusy === model.name || working}
                          onClick={() => void operateLocalModel(model.name, running)}
                        >
                          {running ? (
                            <>
                              <XCircle />
                              停止
                            </>
                          ) : (
                            <>
                              <Play />
                              运行
                            </>
                          )}
                        </button>
                      ) : (
                        <button
                          className="btn ghost"
                          disabled={Boolean(testingModel)}
                          onClick={() => void testConnection(source, model)}
                        >
                          <Activity />
                          {testingModel === testKey ? '检测中' : model.dimensions > 0 ? '重检' : '检测'}
                        </button>
                      )}
                      {source.type === 'local' && (
                        <button
                          className="icon-btn model-remove"
                          title="移除模型"
                          aria-label={`移除模型 ${model.name}`}
                          onClick={() => void removeModel(source, model.name)}
                        >
                          <Trash2 />
                        </button>
                      )}
                    </div>
                    {working && (
                      <div className="model-row-progress">
                        <Progress value={runtime?.progress ?? 0} tone="orange" />
                        <small>{runtime?.progress ?? 0}%</small>
                      </div>
                    )}
                  </div>
                )
              })}
              {source.models.length === 1 && (
                <button
                  type="button"
                  className="source-model-add-slot"
                  onClick={() => document.getElementById(`model-input-${source.id}`)?.focus()}
                >
                  <Plus />
                  <span>
                    <b>继续添加模型</b>
                    <small>同一来源可以配置多个模型</small>
                  </span>
                </button>
              )}
              {source.models.length === 0 && (
                <div className="source-model-empty">
                  <Download />
                  <span>
                    <b>暂无{source.type === 'local' ? '本地' : '远程'}模型</b>
                    <small>可以从下方输入模型名称并添加。</small>
                  </span>
                </div>
              )}
            </div>
            <div className="add-source-model">
              {source.type === 'local' ? (
                <div
                  className="model-recommendation-combobox"
                  onBlur={event => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node)) setRecommendationSourceId('')
                  }}
                >
                  <input
                    id={`model-input-${source.id}`}
                    value={modelDrafts[source.id] ?? ''}
                    onFocus={() => setRecommendationSourceId(source.id)}
                    onChange={event => {
                      setModelDrafts(current => ({ ...current, [source.id]: event.target.value }))
                      setRecommendationSourceId(source.id)
                    }}
                    placeholder="选择推荐模型或输入 Hugging Face 模型名"
                    aria-label="本地模型名称"
                    autoComplete="off"
                  />
                  <button
                    className="recommendation-trigger"
                    type="button"
                    title="选择推荐模型"
                    aria-label="选择推荐模型"
                    aria-expanded={recommendationSourceId === source.id}
                    onClick={() => setRecommendationSourceId(current => (current === source.id ? '' : source.id))}
                  >
                    <Sparkles />
                    <ChevronDown />
                  </button>
                  {recommendationSourceId === source.id && (
                    <div className="model-recommendation-menu" role="listbox">
                      <header>
                        <span>
                          <Sparkles />
                          推荐模型
                        </span>
                        <small>也可以直接输入其他模型名称</small>
                      </header>
                      {localModelRecommendations
                        .filter(item => {
                          const query = (modelDrafts[source.id] ?? '').trim().toLocaleLowerCase()
                          return (
                            !query ||
                            item.name.toLocaleLowerCase().includes(query) ||
                            item.title.toLocaleLowerCase().includes(query)
                          )
                        })
                        .map(item => {
                          const added = source.models.some(model => model.name === item.name)
                          return (
                            <button
                              type="button"
                              role="option"
                              aria-selected={modelDrafts[source.id] === item.name}
                              disabled={added}
                              key={item.name}
                              onClick={() => {
                                setModelDrafts(current => ({ ...current, [source.id]: item.name }))
                                setRecommendationSourceId('')
                              }}
                            >
                              <span>
                                <b>{item.title}</b>
                                <small>{item.name}</small>
                              </span>
                              <em>{added ? '已添加' : item.detail}</em>
                            </button>
                          )
                        })}
                      {localModelRecommendations.every(item => {
                        const query = (modelDrafts[source.id] ?? '').trim().toLocaleLowerCase()
                        return (
                          query &&
                          !item.name.toLocaleLowerCase().includes(query) &&
                          !item.title.toLocaleLowerCase().includes(query)
                        )
                      }) && <p>没有匹配的推荐项，可直接使用当前输入的自定义模型。</p>}
                    </div>
                  )}
                </div>
              ) : (
                <input
                  id={`model-input-${source.id}`}
                  value={modelDrafts[source.id] ?? ''}
                  onChange={event => setModelDrafts(current => ({ ...current, [source.id]: event.target.value }))}
                  placeholder="API 模型名称"
                />
              )}
              <span className="auto-dimension">
                <Activity />
                维度自动检测
              </span>
              <button className="btn ghost" onClick={() => addModel(source)}>
                <Plus />
                添加模型
              </button>
            </div>
          </section>
        ))}
      </div>
      <div className="active-model-picker">
        <div className="picker-title">
          <CheckCircle2 />
          <span>
            <b>知识库生效模型</b>
            <small>先选择来源，再选择该来源下用于向量化和检索的模型</small>
          </span>
        </div>
        <label>
          <span>使用来源</span>
          <select
            value={selectedSource?.id ?? ''}
            onChange={event => {
              const source = draft.embeddingSources.find(item => item.id === event.target.value)
              if (source) applySelection(source)
            }}
          >
            {draft.embeddingSources.map(source => (
              <option key={source.id} value={source.id}>
                {source.name} · {source.type === 'local' ? '本地' : '远程'}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>使用模型</span>
          <select
            value={draft.embeddingModel}
            disabled={!selectedSource?.models.length}
            onChange={event => {
              const model = selectedSource?.models.find(item => item.name === event.target.value)
              if (selectedSource && model) applySelection(selectedSource, model)
            }}
          >
            {!selectedSource?.models.length && <option value="">暂无模型</option>}
            {selectedSource?.models.map(model => (
              <option key={model.name} value={model.name}>
                {model.name} · {model.dimensions > 0 ? `${model.dimensions} 维` : '自动检测'}
              </option>
            ))}
          </select>
        </label>
      </div>
      {selectedSource && (
        <div className={`active-model-summary ${draft.embeddingModel ? '' : 'empty'}`}>
          <Zap />
          <span>
            <b>
              {draft.embeddingModel ? `当前选择：${selectedSource.name} / ${draft.embeddingModel}` : '当前没有生效模型'}
            </b>
            <small>
              {draft.embeddingModel
                ? selectedSource.type === 'local'
                  ? '保存后，任务会使用对应的本地运行实例；未运行时将自动启动。'
                  : `请求将发送到 ${selectedSource.baseUrl}`
                : '可以保存空模型列表；添加本地模型或选择远程模型后即可恢复向量能力。'}
            </small>
          </span>
        </div>
      )}
      {sourceEditor && (
        <Modal title={sourceEditor.id ? '编辑远程模型来源' : '添加远程模型来源'} onClose={() => setSourceEditor(null)}>
          <div className="modal-form">
            <p>
              支持 OpenAI 兼容 Embeddings API 和 Ollama 原生 API。Ollama 可直接填写{' '}
              <code>http://localhost:11434/api/embed</code>。
            </p>
            <label>
              来源名称
              <input
                value={sourceEditor.name}
                onChange={event =>
                  setSourceEditor(current => (current ? { ...current, name: event.target.value } : current))
                }
                placeholder="例如：本机 Ollama"
              />
            </label>
            <label>
              Base URL
              <input
                value={sourceEditor.baseUrl}
                onChange={event =>
                  setSourceEditor(current => (current ? { ...current, baseUrl: event.target.value } : current))
                }
                placeholder="https://api.example.com/v1 或 http://localhost:11434/api/embed"
              />
            </label>
            <label>
              API Key（可选）
              <input
                type="password"
                value={sourceEditor.apiKey}
                onChange={event =>
                  setSourceEditor(current => (current ? { ...current, apiKey: event.target.value } : current))
                }
                placeholder={sourceEditor.id ? '留空保留已保存的凭据' : 'Ollama 本地接口可留空'}
              />
            </label>
            {sourceEditor.id ? (
              <div className="auto-detect-note">
                <Activity />
                <span>
                  <b>模型与维度将保留</b>
                  <small>API Key 留空会保留已保存的凭据；如需刷新模型维度，请在来源卡片中点击“重检”。</small>
                </span>
              </div>
            ) : (
              <>
                <label>
                  首个模型
                  <input
                    value={sourceEditor.modelName}
                    onChange={event =>
                      setSourceEditor(current => (current ? { ...current, modelName: event.target.value } : current))
                    }
                    placeholder="例如：bge-m3"
                  />
                </label>
                <div className="auto-detect-note">
                  <Activity />
                  <span>
                    <b>向量维度：自动检测</b>
                    <small>
                      添加后点击“检测”，系统将请求一次 Embedding 并记录实际维度。添加后不会自动切换知识库生效模型。
                    </small>
                  </span>
                </div>
              </>
            )}
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setSourceEditor(null)}>
                取消
              </button>
              <button className="btn primary" onClick={saveSource}>
                {sourceEditor.id ? (
                  <>
                    <Check />
                    保存来源
                  </>
                ) : (
                  <>
                    <Plus />
                    添加来源
                  </>
                )}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

function RerankerModelDropdown({
  source,
  value,
  onChange,
}: {
  source: EmbeddingSourceDraft | undefined
  value: string
  onChange: (model: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const selected = source?.models.find(model => model.name === value)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const models =
    source?.models.filter(model => !normalizedQuery || model.name.toLocaleLowerCase().includes(normalizedQuery)) ?? []
  useEffect(() => {
    setOpen(false)
    setQuery('')
  }, [source?.id])
  return (
    <div
      className={`reranker-model-dropdown ${open ? 'open' : ''}`}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false)
      }}
    >
      <button
        type="button"
        className="reranker-model-trigger"
        disabled={!source}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        <span>
          <b title={selected?.name}>{selected?.name ?? '请选择 Reranker 模型'}</b>
          <small>
            {selected
              ? `${source?.type === 'local' ? '本地模型' : '远程 API'} · ${selected.dimensions > 0 ? `${selected.dimensions} 维` : '维度待检测'}`
              : '当前来源暂无可选模型'}
          </small>
        </span>
        {selected && (
          <Badge tone={selected.dimensions > 0 ? 'green' : 'orange'}>
            {selected.dimensions > 0 ? '可用' : '待检测'}
          </Badge>
        )}
        <ChevronDown />
      </button>
      {open && (
        <div className="reranker-model-menu">
          <div className="reranker-model-search">
            <Search />
            <input
              value={query}
              autoFocus
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') setOpen(false)
              }}
              placeholder="搜索模型名称"
              aria-label="搜索 Reranker 模型"
            />
          </div>
          <div className="reranker-model-menu-list" role="listbox">
            {models.map(model => {
              const active = model.name === value
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={active ? 'active' : ''}
                  key={model.name}
                  onClick={() => {
                    onChange(model.name)
                    setOpen(false)
                    setQuery('')
                  }}
                >
                  <span className="reranker-menu-check">{active && <Check />}</span>
                  <span>
                    <b title={model.name}>{model.name}</b>
                    <small>
                      {source?.type === 'local' ? '本地模型' : '远程 API'} ·{' '}
                      {model.dimensions > 0 ? `${model.dimensions} 维` : '维度待检测'}
                    </small>
                  </span>
                  <Badge tone={model.dimensions > 0 ? 'green' : 'orange'}>
                    {model.dimensions > 0 ? '可用' : '待检测'}
                  </Badge>
                </button>
              )
            })}
            {models.length === 0 && <p>没有匹配的模型</p>}
          </div>
          <footer>
            共 {source?.models.length ?? 0} 个模型{normalizedQuery ? ` · 匹配 ${models.length} 个` : ''}
          </footer>
        </div>
      )}
    </div>
  )
}

export function RetrievalIndexConfig({
  knowledgeBaseId,
  requiresRebuild,
  onRebuilt,
  draft,
  update,
  notify,
}: {
  knowledgeBaseId: string
  requiresRebuild: boolean
  onRebuilt: () => void
  draft: SettingsDraft
  update: <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => void
  notify: Notify
}) {
  const [rebuild, setRebuild] = useState<JobStatus>('idle')
  const [rebuildProgress, setRebuildProgress] = useState(0)
  const [rebuildTaskId, setRebuildTaskId] = useState('')
  const [rebuildPollVersion, setRebuildPollVersion] = useState(0)

  useEffect(() => {
    if (!knowledgeBaseId) return
    let cancelled = false
    let timer: number | undefined
    const refreshRebuild = async () => {
      try {
        const tasks = await loadTasks(knowledgeBaseId)
        if (cancelled) return
        const activeTask = tasks.find(
          task => task.type === 'rebuild' && (task.status === 'queued' || task.status === 'running'),
        )
        const trackedTask = rebuildTaskId ? tasks.find(task => task.id === rebuildTaskId) : undefined
        const task = activeTask ?? trackedTask
        if (!task) return
        setRebuildTaskId(task.id)
        setRebuildProgress(task.progress)
        if (task.status === 'queued' || task.status === 'running') {
          setRebuild('running')
          timer = window.setTimeout(() => void refreshRebuild(), 1_000)
          return
        }
        setRebuildTaskId('')
        if (task.status === 'succeeded') {
          setRebuild('completed')
          onRebuilt()
          notify('候选索引校验完成，活动索引已原子切换。')
        } else if (task.status === 'cancelled') {
          setRebuild('cancelled')
          notify('索引重建已取消，旧活动索引继续生效。')
        } else if (task.status === 'failed') {
          setRebuild('failed')
          notify(task.error ?? '索引重建失败，旧索引继续生效。', 'error')
        }
      } catch {
        if (!cancelled) timer = window.setTimeout(() => void refreshRebuild(), 3_000)
      }
    }
    void refreshRebuild()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [knowledgeBaseId, rebuildTaskId, rebuildPollVersion])

  const startRebuild = async () => {
    if (rebuild === 'running') return
    setRebuild('running')
    setRebuildProgress(0)
    try {
      const queued = await rebuildIndex(knowledgeBaseId)
      setRebuildTaskId(queued.task.id)
      setRebuildProgress(queued.task.progress)
      setRebuildPollVersion(version => version + 1)
    } catch (error) {
      setRebuild('failed')
      notify(error instanceof Error ? error.message : '索引重建失败，旧索引继续生效。', 'error')
    }
  }

  const cancelRebuild = async () => {
    if (!rebuildTaskId) return
    try {
      await cancelTask(rebuildTaskId)
      setRebuildPollVersion(version => version + 1)
    } catch (error) {
      notify(error instanceof Error ? error.message : '取消索引重建失败。', 'error')
    }
  }
  const rerankerSource = draft.embeddingSources.find(source => source.id === draft.rerankerSourceId)
  const rerankerModel = rerankerSource?.models.find(model => model.name === draft.rerankerModel)
  const toggleReranker = (enabled: boolean) => {
    update('rerankerEnabled', enabled)
    if (!enabled || (rerankerSource && rerankerModel)) return
    const fallback =
      draft.embeddingSources.find(source => source.id === draft.embeddingSourceId) ?? draft.embeddingSources[0]
    if (fallback) {
      update('rerankerSourceId', fallback.id)
      update('rerankerModel', fallback.models[0]?.name ?? '')
    }
  }
  return (
    <div className="retrieval-config">
      <div className="retrieval-block">
        <div className="block-title">
          <div>
            <b>混合检索</b>
            <small>保存后用于后续真实检索，不需要重建索引</small>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={draft.hybridSearch}
              onChange={event => update('hybridSearch', event.target.checked)}
              aria-label="启用混合检索"
            />
            <i />
          </label>
        </div>
        <div className="parameter-grid">
          <label>
            <span>向量召回数量</span>
            <select value={draft.vectorRecall} onChange={event => update('vectorRecall', event.target.value)}>
              <option>30</option>
              <option>40</option>
              <option>50</option>
            </select>
          </label>
          <label>
            <span>关键词召回数量</span>
            <select value={draft.keywordRecall} onChange={event => update('keywordRecall', event.target.value)}>
              <option>30</option>
              <option>40</option>
              <option>50</option>
            </select>
          </label>
          <label>
            <span>最终返回数量</span>
            <select value={draft.finalResults} onChange={event => update('finalResults', event.target.value)}>
              <option>5</option>
              <option>8</option>
              <option>10</option>
            </select>
          </label>
          <label>
            <span>最低相关度</span>
            <div className="threshold">
              <input
                type="range"
                min="0"
                max="100"
                value={Math.round(draft.relevanceThreshold * 100)}
                onChange={event => update('relevanceThreshold', Number(event.target.value) / 100)}
              />
              <b>{draft.relevanceThreshold.toFixed(2)}</b>
            </div>
          </label>
        </div>
      </div>
      <div className="retrieval-block reranker-block">
        <div className="block-title">
          <div>
            <b>Reranker 结果重排</b>
            <small>可独立选择模型来源和模型，不受 Embedding 生效模型限制</small>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={draft.rerankerEnabled}
              onChange={event => toggleReranker(event.target.checked)}
              aria-label="启用 Reranker"
            />
            <i />
          </label>
        </div>
        {draft.rerankerEnabled && (
          <div className="reranker-config-body">
            <div className="reranker-source-field">
              <div className="reranker-field-label">
                <i>1</i>
                <span>
                  <b>选择模型来源</b>
                  <small>本地模型或已配置的远程 API</small>
                </span>
              </div>
              <select
                value={rerankerSource?.id ?? ''}
                onChange={event => {
                  const source = draft.embeddingSources.find(item => item.id === event.target.value)
                  if (source) {
                    update('rerankerSourceId', source.id)
                    update('rerankerModel', source.models[0]?.name ?? '')
                  }
                }}
              >
                {draft.embeddingSources.map(source => (
                  <option key={source.id} value={source.id}>
                    {source.name} · {source.type === 'local' ? '本地' : '远程 API'}
                  </option>
                ))}
              </select>
            </div>
            <div className="reranker-model-field">
              <div className="reranker-field-label">
                <i>2</i>
                <span>
                  <b>选择 Reranker 模型</b>
                  <small>支持搜索；模型较多时在下拉列表内滚动</small>
                </span>
              </div>
              <RerankerModelDropdown
                source={rerankerSource}
                value={draft.rerankerModel}
                onChange={model => update('rerankerModel', model)}
              />
            </div>
            <div className={`reranker-selection-summary ${rerankerModel?.dimensions ? 'ready' : 'pending'}`}>
              <Activity />
              <span>
                <b>{rerankerModel?.dimensions ? 'Reranker 已就绪' : 'Reranker 尚未就绪'}</b>
                <small>
                  {rerankerSource?.name ?? '未选择来源'} / {rerankerModel?.name ?? '未选择模型'}
                  {rerankerModel?.dimensions ? ` · ${rerankerModel.dimensions} 维` : ' · 请先运行或检测模型'}
                </small>
              </span>
              <Badge tone={rerankerModel?.dimensions ? 'green' : 'orange'}>
                {rerankerModel?.dimensions ? '配置有效' : '需要处理'}
              </Badge>
            </div>
          </div>
        )}
      </div>
      <div className="index-rebuild">
        <div className="index-status">
          <div className={`index-icon ${rebuild === 'running' ? 'running' : rebuild === 'completed' ? 'done' : ''}`}>
            <Database />
          </div>
          <div>
            <b>活动索引</b>
            <Badge tone={rebuild === 'running' || requiresRebuild ? 'orange' : 'green'}>
              {rebuild === 'running'
                ? '正在构建候选索引'
                : requiresRebuild
                  ? '配置待重建'
                  : rebuild === 'completed'
                    ? '已切换新索引'
                    : '当前索引可用'}
            </Badge>
            <small>
              {rebuild === 'running' ? '重建期间旧活动索引继续提供检索' : '索引绑定固定配置快照与资产版本范围'}
            </small>
          </div>
        </div>
        {rebuild === 'running' && (
          <div className="rebuild-progress">
            <div>
              <span>正在处理资产与 Chunk</span>
              <b>{rebuildProgress}%</b>
            </div>
            <Progress value={rebuildProgress} />
          </div>
        )}
        {rebuild === 'cancelled' && (
          <div className="rebuild-notice">
            <AlertTriangle />
            <span>
              <b>重建已取消</b>
              <small>旧活动索引未发生变化。</small>
            </span>
          </div>
        )}
        {rebuild === 'failed' && (
          <div className="rebuild-notice">
            <AlertTriangle />
            <span>
              <b>重建失败</b>
              <small>旧活动索引继续有效，可在任务列表查看错误。</small>
            </span>
          </div>
        )}
        {rebuild === 'completed' && (
          <div className="rebuild-done">
            <CheckCircle2 />
            <span>
              <b>重建完成</b>
              <small>候选索引已校验并原子切换。</small>
            </span>
          </div>
        )}
        <div className="index-actions">
          {rebuild === 'running' && (
            <button className="btn danger" onClick={() => void cancelRebuild()}>
              <XCircle />
              取消
            </button>
          )}
          <button
            className="btn primary"
            disabled={rebuild === 'running' || !requiresRebuild}
            onClick={() => void startRebuild()}
          >
            <RefreshCw className={rebuild === 'running' ? 'rotating' : ''} />
            {requiresRebuild ? '确认重建索引' : '无需重建'}
          </button>
        </div>
      </div>
    </div>
  )
}
