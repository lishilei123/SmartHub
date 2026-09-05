import { useState } from 'react'
import { Bot, Check, Pencil, Plus, RefreshCw, Server, ShieldCheck, Sparkles, Trash2 } from 'lucide-react'
import { type GenerativeModelDraft, type GenerativeSourceDraft, type SettingsDraft } from '../prototype-data'
import { discoverGenerativeModels, probeGenerativeModel } from '../knowledge-api'
import { type AiResourceKind } from '../ai-resource-api'
import { type Notify } from './types'
import { ModelPanelHead } from './settings-shared'
import { Badge, Modal } from './shared'
import { AiResourceManagement } from './AiResourceManagement'

type GenerativeSourceEditor = {
  id?: string
  name: string
  providerType: GenerativeSourceDraft['providerType']
  baseUrl: string
  apiKey: string
  models: GenerativeModelDraft[]
}

type GenerativeSourceEditorErrors = { source?: string; modelList?: string; models?: Record<string, string> }

type GenerativeModelCapabilities = Pick<GenerativeModelDraft, 'capabilities'>

const genericModelCapabilities = (): GenerativeModelCapabilities => ({ capabilities: ['tool_calling'] })

const modelCapabilityDefaults = (
  providerType: GenerativeSourceDraft['providerType'],
  name: string,
): GenerativeModelCapabilities => {
  if (providerType === 'openai' && /^gpt-5\.6(?:-(?:sol|terra|luna))?$/iu.test(name.trim())) {
    return { capabilities: ['tool_calling', 'reasoning', 'vision'] }
  }
  return genericModelCapabilities()
}

const sameModelCapabilities = (model: GenerativeModelDraft, defaults: GenerativeModelCapabilities) =>
  [...model.capabilities].sort().join('\u0000') === [...defaults.capabilities].sort().join('\u0000')

const createGenerativeModel = (
  providerType: GenerativeSourceDraft['providerType'],
  discovered?: { name: string; displayName: string },
): GenerativeModelDraft => ({
  id: crypto.randomUUID(),
  name: discovered?.name ?? '',
  displayName: discovered?.displayName ?? '',
  ...modelCapabilityDefaults(providerType, discovered?.name ?? ''),
  enabled: true,
  health: 'unknown',
})

export const repairGenerativeRouting = (
  nextSources: GenerativeSourceDraft[],
  removedModelIds: ReadonlySet<string>,
  draft: Pick<SettingsDraft, 'mainModel' | 'fallbackModelIds'>,
) => {
  const models = nextSources.flatMap(source => source.models.map(model => ({ ...model, source })))
  const availableIds = new Set(models.map(model => model.id))
  const mainModel =
    removedModelIds.has(draft.mainModel) || !availableIds.has(draft.mainModel)
      ? (models.find(model => model.source.enabled && model.enabled)?.id ?? '')
      : draft.mainModel
  const fallbackModelIds = [...new Set(draft.fallbackModelIds)].filter(
    id => availableIds.has(id) && !removedModelIds.has(id) && id !== mainModel,
  )
  return { mainModel, fallbackModelIds }
}

export function ModelManagementSettings({
  draft,
  notify,
  onPersistSources,
  onHealthUpdated,
}: {
  draft: SettingsDraft
  notify: Notify
  onPersistSources: (sources: GenerativeSourceDraft[], removedModelIds: Set<string>) => Promise<GenerativeSourceDraft[]>
  onHealthUpdated: (source: GenerativeSourceDraft) => void
}) {
  const [catalogTab, setCatalogTab] = useState<'model' | AiResourceKind>('model')
  const [sourceEditor, setSourceEditor] = useState<GenerativeSourceEditor | null>(null)
  const [sourceEditorErrors, setSourceEditorErrors] = useState<GenerativeSourceEditorErrors>({})
  const [testingModelId, setTestingModelId] = useState('')
  const [savingSourceId, setSavingSourceId] = useState('')
  const sources = draft.generativeSources
  const providerLabel = (type: GenerativeSourceDraft['providerType']) =>
    type === 'openai' ? 'OpenAI' : type === 'anthropic' ? 'Anthropic' : 'OpenAI Compatible'
  const persistSources = async (
    nextSources: GenerativeSourceDraft[],
    removedModelIds: Set<string>,
    operationId: string,
    message: string,
  ) => {
    setSavingSourceId(operationId)
    try {
      await onPersistSources(nextSources, removedModelIds)
      notify(message)
      return true
    } catch (error) {
      notify(error instanceof Error ? error.message : '模型来源保存失败', 'error')
      return false
    } finally {
      setSavingSourceId('')
    }
  }
  const updateSource = async (id: string, patch: Partial<GenerativeSourceDraft>) => {
    const nextSources = sources.map(source => (source.id === id ? { ...source, ...patch } : source))
    await persistSources(nextSources, new Set(), id, patch.enabled === false ? '模型来源已停用。' : '模型来源已启用。')
  }
  const deleteSource = async (source: GenerativeSourceDraft) => {
    if (!window.confirm(`移除模型来源“${source.name}”？该操作会立即写入服务端。`)) return
    const removedIds = new Set(source.models.map(model => model.id))
    const remaining = sources.filter(item => item.id !== source.id)
    await persistSources(remaining, removedIds, source.id, `模型来源“${source.name}”已删除。`)
  }
  const openSourceEditor = (source?: GenerativeSourceDraft) => {
    setSourceEditorErrors({})
    setSourceEditor(
      source
        ? {
            id: source.id,
            name: source.name,
            providerType: source.providerType,
            baseUrl: source.baseUrl,
            apiKey: '',
            models: source.models.map(model => ({ ...model, capabilities: [...model.capabilities] })),
          }
        : { name: '', providerType: 'openai_compatible', baseUrl: '', apiKey: '', models: [] },
    )
  }
  const updateEditorModel = (id: string, patch: Partial<GenerativeModelDraft>) =>
    setSourceEditor(
      current =>
        current && {
          ...current,
          models: current.models.map(model => (model.id === id ? { ...model, ...patch } : model)),
        },
    )
  const updateEditorModelName = (id: string, name: string) =>
    setSourceEditor(current => {
      if (!current) return current
      return {
        ...current,
        models: current.models.map(model => {
          if (model.id !== id) return model
          const previousDefaults = modelCapabilityDefaults(current.providerType, model.name)
          const nextDefaults = modelCapabilityDefaults(current.providerType, name)
          return { ...model, name, ...(sameModelCapabilities(model, previousDefaults) ? nextDefaults : {}) }
        }),
      }
    })
  const addEditorModel = () => {
    setSourceEditorErrors(current => ({ ...current, modelList: undefined }))
    setSourceEditor(
      current => current && { ...current, models: [...current.models, createGenerativeModel(current.providerType)] },
    )
  }
  const discoverModels = async () => {
    if (!sourceEditor) return
    try {
      const discovered = await discoverGenerativeModels(sourceEditor)
      if (discovered.length) setSourceEditorErrors(errors => ({ ...errors, modelList: undefined }))
      setSourceEditor(current => {
        if (!current) return current
        const knownNames = new Set(current.models.map(model => model.name.trim().toLocaleLowerCase()))
        const additions = discovered
          .filter(model => !knownNames.has(model.name.toLocaleLowerCase()))
          .map(model => createGenerativeModel(current.providerType, model))
        return additions.length ? { ...current, models: [...current.models, ...additions] } : current
      })
      notify(
        discovered.length ? `已从部署端点获取 ${discovered.length} 个模型。` : '部署端点未返回可用模型。',
        discovered.length ? 'success' : 'warning',
      )
    } catch (error) {
      notify(error instanceof Error ? error.message : '获取模型失败', 'error')
    }
  }
  const removeEditorModel = (id: string) =>
    setSourceEditor(current =>
      current ? { ...current, models: current.models.filter(model => model.id !== id) } : current,
    )
  const testModelConnection = async (source: GenerativeSourceDraft, model: GenerativeModelDraft) => {
    if (!source.enabled || !model.enabled) {
      notify('请先启用模型来源和模型后再测试。', 'warning')
      return
    }
    setTestingModelId(model.id)
    try {
      const result = await probeGenerativeModel(source.id, model.id)
      onHealthUpdated(result.source)
      notify(`${model.displayName}：${result.message}`, result.ok ? 'success' : 'error')
    } catch (error) {
      notify(error instanceof Error ? error.message : '模型连通性测试失败', 'error')
    } finally {
      setTestingModelId('')
    }
  }
  const saveSource = async () => {
    if (!sourceEditor) return
    const name = sourceEditor.name.trim()
    const baseUrl = sourceEditor.baseUrl.trim()
    const apiKey = sourceEditor.apiKey.trim()
    const normalizedModels = sourceEditor.models.map(model => ({
      ...model,
      name: model.name.trim(),
      displayName: model.displayName.trim(),
      capabilities: [...new Set(model.capabilities)],
    }))
    const modelErrors: Record<string, string> = {}
    const names = new Set<string>()
    for (const model of normalizedModels) {
      if (!model.name || !model.displayName) modelErrors[model.id] = '请填写模型标识和展示名称。'
      const key = model.name.toLocaleLowerCase()
      if (key && names.has(key)) modelErrors[model.id] = '同一来源不能有重复的模型标识。'
      names.add(key)
    }
    const sourceError = !name || !baseUrl ? '请完整填写来源名称和 Base URL。' : undefined
    const modelListError = normalizedModels.length ? undefined : '请先获取当前配置模型或手动添加至少一个模型。'
    if (sourceError || modelListError || Object.keys(modelErrors).length) {
      setSourceEditorErrors({ source: sourceError, modelList: modelListError, models: modelErrors })
      notify('请修正来源和模型配置。', 'warning')
      return
    }
    const source: GenerativeSourceDraft | null = sourceEditor.id
      ? (() => {
          const existingSource = sources.find(item => item.id === sourceEditor.id)
          if (!existingSource) return null
          return {
            ...existingSource,
            name,
            providerType: sourceEditor.providerType,
            baseUrl,
            apiKey,
            models: normalizedModels,
          }
        })()
      : {
          id: crypto.randomUUID(),
          name,
          providerType: sourceEditor.providerType,
          baseUrl,
          apiKey,
          enabled: true,
          health: 'unknown',
          priority: sources.length + 1,
          models: normalizedModels,
        }
    if (!source) {
      notify('模型来源不存在，无法保存修改。', 'warning')
      return
    }
    const existing = sources.find(item => item.id === source.id)
    const removedIds = new Set(
      existing
        ? existing.models.filter(model => !source.models.some(next => next.id === model.id)).map(model => model.id)
        : [],
    )
    const nextSources = existing ? sources.map(item => (item.id === source.id ? source : item)) : [...sources, source]
    const saved = await persistSources(
      nextSources,
      removedIds,
      source.id,
      existing ? '模型来源修改已保存。' : '模型来源已添加。',
    )
    if (saved) {
      setSourceEditor(null)
      setSourceEditorErrors({})
    }
  }
  return (
    <div className="model-config-page">
      <nav className="ai-catalog-tabs" aria-label="AI 资源管理类型">
        <button className={catalogTab === 'model' ? 'active' : ''} onClick={() => setCatalogTab('model')}>
          <Bot />
          <span>
            <b>模型</b>
            <small>来源与能力</small>
          </span>
        </button>
        <button className={catalogTab === 'mcp' ? 'active' : ''} onClick={() => setCatalogTab('mcp')}>
          <Server />
          <span>
            <b>MCP</b>
            <small>远程工具服务</small>
          </span>
        </button>
        <button className={catalogTab === 'skill' ? 'active' : ''} onClick={() => setCatalogTab('skill')}>
          <Sparkles />
          <span>
            <b>Skill</b>
            <small>可复用工作流</small>
          </span>
        </button>
        <button className={catalogTab === 'tool' ? 'active' : ''} onClick={() => setCatalogTab('tool')}>
          <ShieldCheck />
          <span>
            <b>工具</b>
            <small>确定性动作</small>
          </span>
        </button>
      </nav>
      {catalogTab === 'model' ? (
        <>
          <div className="model-config-panel">
            <ModelPanelHead
              title="模型来源"
              desc="统一维护可供各 Agent 使用的生成式模型渠道；所有变更即时保存到服务端。"
            >
              <button className="btn primary" disabled={Boolean(savingSourceId)} onClick={() => openSourceEditor()}>
                <Plus />
                添加来源
              </button>
            </ModelPanelHead>
            <div className="generative-source-grid">
              {sources.map(source => (
                <article
                  className={`generative-source-card ${source.enabled ? '' : 'disabled'}`}
                  key={source.id}
                  aria-label={`${source.name} 模型来源`}
                >
                  <header>
                    <div className="source-logo">
                      <Server />
                    </div>
                    <div>
                      <b>{source.name}</b>
                      <small>{providerLabel(source.providerType)}</small>
                    </div>
                    <Badge tone={source.enabled ? modelHealthTone(source.health) : 'gray'}>
                      {savingSourceId === source.id
                        ? '保存中'
                        : source.enabled
                          ? modelHealthLabel(source.health)
                          : '已停用'}
                    </Badge>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={source.enabled}
                        disabled={Boolean(savingSourceId)}
                        onChange={event => void updateSource(source.id, { enabled: event.target.checked })}
                        aria-label={`启用 ${source.name}`}
                      />
                      <i />
                    </label>
                  </header>
                  <div className="source-reference">
                    <span>
                      Base URL<b>{source.baseUrl}</b>
                    </span>
                  </div>
                  <div className="source-model-chips">
                    {source.models.map(model => (
                      <button
                        type="button"
                        key={model.id}
                        disabled={
                          Boolean(savingSourceId) || !source.enabled || !model.enabled || testingModelId === model.id
                        }
                        onClick={() => testModelConnection(source, model)}
                        title={`测试 ${model.displayName} 连通性`}
                        aria-label={`测试 ${model.displayName} 连通性`}
                      >
                        <i className={model.health} aria-hidden="true" />
                        <span>{testingModelId === model.id ? '测试中…' : model.displayName}</span>
                      </button>
                    ))}
                  </div>
                  <footer>
                    <span>{source.models.length} 个模型</span>
                    <div>
                      <button
                        className="icon-btn"
                        disabled={Boolean(savingSourceId)}
                        onClick={() => openSourceEditor(source)}
                        title={`编辑来源 ${source.name}`}
                        aria-label={`编辑来源 ${source.name}`}
                      >
                        <Pencil />
                      </button>
                      <button
                        className="icon-btn danger-text"
                        disabled={Boolean(savingSourceId)}
                        onClick={() => void deleteSource(source)}
                        title={`移除来源 ${source.name}`}
                        aria-label={`移除来源 ${source.name}`}
                      >
                        <Trash2 />
                      </button>
                    </div>
                  </footer>
                </article>
              ))}
            </div>
          </div>
          {sources.length === 0 && (
            <div className="model-source-empty">
              <Server />
              <b>尚未配置生成式模型来源</b>
              <span>填写 Base URL、API Key 和模型并提交，即可进行真实发现与连通性探测。</span>
            </div>
          )}
          {sourceEditor && (
            <Modal
              title={sourceEditor.id ? '编辑生成式模型来源' : '添加生成式模型来源'}
              className="model-source-modal"
              onClose={() => {
                setSourceEditor(null)
                setSourceEditorErrors({})
              }}
            >
              <div className="modal-form">
                <div className="model-source-modal-content">
                  <p>Base URL 和 API Key 由服务端保存；读取配置时不会回显 API Key。</p>
                  <label>
                    来源名称
                    <input
                      value={sourceEditor.name}
                      onChange={event =>
                        setSourceEditor(current => current && { ...current, name: event.target.value })
                      }
                      placeholder="例如：OpenAI 灾备渠道"
                    />
                  </label>
                  <label>
                    协议类型
                    <select
                      value={sourceEditor.providerType}
                      onChange={event =>
                        setSourceEditor(
                          current =>
                            current && {
                              ...current,
                              providerType: event.target.value as GenerativeSourceDraft['providerType'],
                            },
                        )
                      }
                    >
                      <option value="openai">OpenAI</option>
                      <option value="anthropic">Anthropic</option>
                      <option value="openai_compatible">OpenAI Compatible</option>
                    </select>
                  </label>
                  <label>
                    Base URL
                    <input
                      value={sourceEditor.baseUrl}
                      onChange={event =>
                        setSourceEditor(current => current && { ...current, baseUrl: event.target.value })
                      }
                      placeholder="https://api.example.com/v1"
                    />
                  </label>
                  <label>
                    API Key（可选）
                    <input
                      type="password"
                      value={sourceEditor.apiKey}
                      onChange={event =>
                        setSourceEditor(current => current && { ...current, apiKey: event.target.value })
                      }
                      placeholder={sourceEditor.id ? '留空保留已保存的 API Key' : '无需鉴权时可留空'}
                    />
                  </label>
                  {sourceEditorErrors.source && <span className="field-error">{sourceEditorErrors.source}</span>}
                  <section className="generative-model-editor">
                    <header>
                      <div>
                        <b>模型配置</b>
                        <small>端点发现只返回模型标识；保存前请确认模型能力。</small>
                      </div>
                      <div className="generative-model-editor-actions">
                        <button type="button" className="btn ghost" onClick={discoverModels}>
                          <RefreshCw />
                          获取当前配置模型
                        </button>
                        <button type="button" className="btn ghost" onClick={addEditorModel}>
                          <Plus />
                          手动添加模型
                        </button>
                      </div>
                    </header>
                    {sourceEditorErrors.modelList && (
                      <span className="field-error">{sourceEditorErrors.modelList}</span>
                    )}
                    <div>
                      {sourceEditor.models.map((model, index) => (
                        <article key={model.id}>
                          <header>
                            <div>
                              <b>模型 {index + 1}</b>
                              {model.id === draft.mainModel && <Badge tone="green">默认模型</Badge>}
                              {draft.fallbackModelIds.includes(model.id) && <Badge tone="purple">回退模型</Badge>}
                            </div>
                            <button
                              type="button"
                              className="icon-btn danger-text"
                              title={`移除模型 ${model.displayName || model.name || index + 1}`}
                              aria-label={`移除模型 ${model.displayName || model.name || index + 1}`}
                              onClick={() => removeEditorModel(model.id)}
                            >
                              <Trash2 />
                            </button>
                          </header>
                          <div className="generative-model-fields">
                            <label>
                              模型标识
                              <input
                                value={model.name}
                                onChange={event => updateEditorModelName(model.id, event.target.value)}
                                placeholder="gpt-5.6-terra"
                              />
                            </label>
                            <label>
                              展示名称
                              <input
                                value={model.displayName}
                                onChange={event => updateEditorModel(model.id, { displayName: event.target.value })}
                                placeholder="GPT-5.6 Terra"
                              />
                            </label>
                          </div>
                          <div className="generative-model-options">
                            <span>能力</span>
                            {(['tool_calling', 'reasoning', 'vision'] as const).map(capability => (
                              <label key={capability}>
                                <input
                                  type="checkbox"
                                  checked={model.capabilities.includes(capability)}
                                  onChange={event =>
                                    updateEditorModel(model.id, {
                                      capabilities: event.target.checked
                                        ? [...model.capabilities, capability]
                                        : model.capabilities.filter(item => item !== capability),
                                    })
                                  }
                                />
                                {capability === 'tool_calling'
                                  ? '工具调用'
                                  : capability === 'reasoning'
                                    ? '推理'
                                    : '视觉'}
                              </label>
                            ))}
                            <label className="model-enabled">
                              <input
                                type="checkbox"
                                checked={model.enabled}
                                onChange={event => updateEditorModel(model.id, { enabled: event.target.checked })}
                              />
                              启用模型
                            </label>
                          </div>
                          {sourceEditorErrors.models?.[model.id] && (
                            <span className="field-error">{sourceEditorErrors.models[model.id]}</span>
                          )}
                        </article>
                      ))}
                    </div>
                  </section>
                </div>
                <div className="modal-actions">
                  <button
                    className="btn ghost"
                    disabled={Boolean(savingSourceId)}
                    onClick={() => {
                      setSourceEditor(null)
                      setSourceEditorErrors({})
                    }}
                  >
                    取消
                  </button>
                  <button className="btn primary" disabled={Boolean(savingSourceId)} onClick={() => void saveSource()}>
                    {sourceEditor.id ? <Check /> : <Plus />}
                    {savingSourceId ? '保存中…' : sourceEditor.id ? '保存修改' : '添加来源'}
                  </button>
                </div>
              </div>
            </Modal>
          )}
        </>
      ) : (
        <AiResourceManagement kind={catalogTab} notify={notify} />
      )}
    </div>
  )
}

const modelHealthLabel = (health: GenerativeSourceDraft['health']) =>
  health === 'healthy' ? '健康' : health === 'degraded' ? '降级' : '待探测'

const modelHealthTone = (health: GenerativeSourceDraft['health']) =>
  health === 'healthy' ? 'green' : health === 'degraded' ? 'orange' : 'gray'
