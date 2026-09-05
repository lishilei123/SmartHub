import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BookOpen,
  Bot,
  Check,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react'
import { initialSettings, type GenerativeSourceDraft, type SettingsDraft } from '../prototype-data'
import { loadConfig, loadGenerativeModelSources, saveConfig, saveGenerativeModelSources } from '../knowledge-api'
import {
  loadAgentConfiguration,
  materializeRequiredAgentCapabilities,
  publishAgentConfiguration,
  saveAgentConfigurationDraft,
  type AgentConfigurationAgentDraft,
  type AgentConfigurationAgentKey,
  type AgentConfigurationState,
} from '../agent-configuration-api'
import { type Notify } from './types'
import { repairGenerativeRouting, ModelManagementSettings } from './ModelManagementSettings'
import { agentConfigurationMetadata, PromptAgentSettings } from './PromptAgentSettings'
import { Badge } from './shared'
import {
  AgentConfigurationLoading,
  AgentConfigurationFailure,
  FormSection,
  FormRow,
  SwitchRow,
} from './settings-shared'
import { EmbeddingModelPrototype, RetrievalIndexConfig } from './KnowledgeSettings'
import { TestExecutionSettings } from './TestExecutionSettings'

export function SystemSettings({
  knowledgeBaseId,
  notify,
  addAudit,
}: {
  knowledgeBaseId: string
  notify: Notify
  addAudit: (entry: string) => void
}) {
  const items = [
    { name: '模型管理', desc: '模型、MCP、Skill 与工具资源管理', icon: Bot, group: 'AI 能力' },
    { name: 'Agent 配置', desc: '模型、提示词、工具和运行限制', icon: Sparkles, group: 'AI 能力' },
    { name: '知识库配置', desc: '同步、切分与检索策略', icon: BookOpen, group: '资源与集成' },
    { name: '用户与权限', desc: '成员、角色与审批流程', icon: Users, group: '安全与治理' },
    { name: '环境与安全', desc: '密钥、数据保留与审计', icon: ShieldCheck, group: '安全与治理' },
    { name: '测试执行配置', desc: 'Runner 与 Agent 并发控制及版本发布', icon: Bot, group: '资源与集成' },
  ]
  const [selected, setSelected] = useState(0)
  const [collapsed, setCollapsed] = useState(false)
  const [saved, setSaved] = useState<SettingsDraft>(initialSettings)
  const [draft, setDraft] = useState<SettingsDraft>(initialSettings)
  const [configVersion, setConfigVersion] = useState<number | null>(null)
  const [requiresRebuild, setRequiresRebuild] = useState(false)
  const [modelSourcesState, setModelSourcesState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [modelSourcesError, setModelSourcesError] = useState<string | null>(null)
  const [configLoaded, setConfigLoaded] = useState(false)
  const [agentConfiguration, setAgentConfiguration] = useState<AgentConfigurationState | null>(null)
  const [savedAgentDraft, setSavedAgentDraft] = useState<Record<
    AgentConfigurationAgentKey,
    AgentConfigurationAgentDraft
  > | null>(null)
  const [agentDraft, setAgentDraft] = useState<Record<AgentConfigurationAgentKey, AgentConfigurationAgentDraft> | null>(
    null,
  )
  const [agentConfigState, setAgentConfigState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [agentConfigError, setAgentConfigError] = useState<string | null>(null)
  const [agentPublishing, setAgentPublishing] = useState(false)
  const editorScrollRef = useRef<HTMLDivElement>(null)
  const modelSourcesRequestRef = useRef(0)
  const agentConfigRequestRef = useRef(0)
  useEffect(
    () => () => {
      modelSourcesRequestRef.current += 1
      agentConfigRequestRef.current += 1
    },
    [],
  )
  const loadModelSources = useCallback(async () => {
    const requestId = ++modelSourcesRequestRef.current
    setModelSourcesState('loading')
    setModelSourcesError(null)
    try {
      const generativeSources = await loadGenerativeModelSources()
      if (requestId !== modelSourcesRequestRef.current) return generativeSources
      setSaved(current => ({
        ...current,
        generativeSources,
        ...repairGenerativeRouting(generativeSources, new Set(), current),
      }))
      setDraft(current => ({
        ...current,
        generativeSources,
        ...repairGenerativeRouting(generativeSources, new Set(), current),
      }))
      setModelSourcesState('ready')
      return generativeSources
    } catch (error) {
      if (requestId !== modelSourcesRequestRef.current) throw error
      const message = error instanceof Error ? error.message : '模型来源读取失败。'
      setModelSourcesState('failed')
      setModelSourcesError(message)
      throw error
    }
  }, [])
  const loadCurrentAgentConfiguration = useCallback(async () => {
    const requestId = ++agentConfigRequestRef.current
    setAgentConfigState('loading')
    setAgentConfigError(null)
    try {
      const configuration = await loadAgentConfiguration()
      if (requestId !== agentConfigRequestRef.current) return configuration
      const agentDrafts = Object.fromEntries(
        (Object.keys(agentConfigurationMetadata) as AgentConfigurationAgentKey[]).map(agentKey => [
          agentKey,
          configuration.agents[agentKey].draft,
        ]),
      ) as Record<AgentConfigurationAgentKey, AgentConfigurationAgentDraft>
      setAgentConfiguration(configuration)
      setSavedAgentDraft(agentDrafts)
      setAgentDraft(agentDrafts)
      setAgentConfigState('ready')
      return configuration
    } catch (error) {
      if (requestId !== agentConfigRequestRef.current) throw error
      const message = error instanceof Error ? error.message : 'Agent 配置读取失败。'
      setAgentConfigState('failed')
      setAgentConfigError(message)
      throw error
    }
  }, [])
  useEffect(() => {
    if ((selected !== 0 && selected !== 1) || modelSourcesState !== 'idle') return
    void loadModelSources().catch(() => undefined)
  }, [loadModelSources, modelSourcesState, selected])
  useEffect(() => {
    if (!knowledgeBaseId || selected !== 2 || configLoaded) return
    void loadConfig(knowledgeBaseId)
      .then(value => {
        const config = value.config
        const mapped = {
          parserVersion: config.parserVersion,
          preprocessVersion: config.preprocessVersion,
          chunkSize: `${config.chunkTargetSize} tokens`,
          chunkMaxSize: String(config.chunkMaxSize),
          chunkOverlap: `${config.chunkOverlap} tokens`,
          headingDepth: String(config.headingDepth),
          embeddingSourceId: config.embeddingSourceId,
          embeddingSources: config.embeddingSources,
          embeddingMode: config.embeddingMode,
          embeddingBaseUrl: config.embeddingBaseUrl,
          embeddingApiKey: config.embeddingApiKey,
          embeddingModel: config.embeddingModel,
          embeddingDimensions: String(config.embeddingDimensions),
          embeddingBatchSize: String(config.embeddingBatchSize),
          embeddingTimeoutMs: String(config.embeddingTimeoutMs),
          embeddingRetries: String(config.embeddingRetries),
          vectorRecall: String(config.vectorRecall),
          keywordRecall: String(config.keywordRecall),
          finalResults: String(config.finalResults),
          relevanceThreshold: config.relevanceThreshold,
          hybridSearch: config.hybridSearch,
          rerankerEnabled: config.rerankerEnabled,
          rerankerSourceId: config.rerankerSourceId ?? config.embeddingSourceId,
          rerankerModel: config.rerankerModel,
        }
        setSaved(current => ({ ...current, ...mapped }))
        setDraft(current => ({ ...current, ...mapped }))
        setConfigVersion(value.version)
        setRequiresRebuild(value.requiresRebuild)
        setConfigLoaded(true)
      })
      .catch(error => notify(error instanceof Error ? error.message : '知识库配置 API 未连接。', 'error'))
  }, [configLoaded, knowledgeBaseId, notify, selected])
  useEffect(() => {
    if (selected !== 1 || agentConfigState !== 'idle') return
    void loadCurrentAgentConfiguration().catch(() => undefined)
  }, [agentConfigState, loadCurrentAgentConfiguration, selected])
  const current = items[selected]
  const CurrentIcon = current.icon
  const settingsDirty = JSON.stringify(saved) !== JSON.stringify(draft)
  const agentDefinitionDirty = JSON.stringify(savedAgentDraft) !== JSON.stringify(agentDraft)
  const dirty = selected === 1 ? agentDefinitionDirty : settingsDirty
  useEffect(() => {
    editorScrollRef.current?.scrollTo({ top: 0 })
  }, [selected])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  const update = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) =>
    setDraft(currentDraft => ({ ...currentDraft, [key]: value }))
  const save = async () => {
    if (selected === 2 && knowledgeBaseId) {
      if (draft.embeddingModel && Number(draft.embeddingDimensions) <= 0) {
        notify('请先运行本地模型，或测试远程模型，以自动检测向量维度。')
        return
      }
      const rerankerSource = draft.embeddingSources.find(source => source.id === draft.rerankerSourceId)
      const rerankerModel = rerankerSource?.models.find(model => model.name === draft.rerankerModel)
      if (draft.rerankerEnabled && (!rerankerSource || !rerankerModel)) {
        notify('请为 Reranker 选择有效的模型来源和模型。')
        return
      }
      if (draft.rerankerEnabled && rerankerModel!.dimensions <= 0) {
        notify('请先运行或检测所选 Reranker 模型的向量维度。')
        return
      }
      try {
        const result = await saveConfig(knowledgeBaseId, {
          parserVersion: draft.parserVersion,
          preprocessVersion: draft.preprocessVersion,
          chunkTargetSize: Number.parseInt(draft.chunkSize),
          chunkMaxSize: Number(draft.chunkMaxSize),
          chunkOverlap: Number.parseInt(draft.chunkOverlap),
          headingDepth: Number(draft.headingDepth),
          embeddingSourceId: draft.embeddingSourceId,
          embeddingSources: draft.embeddingSources,
          embeddingMode: draft.embeddingMode,
          embeddingBaseUrl: draft.embeddingBaseUrl,
          embeddingApiKey: draft.embeddingApiKey,
          embeddingModel: draft.embeddingModel,
          embeddingDimensions: Number(draft.embeddingDimensions),
          embeddingBatchSize: Number(draft.embeddingBatchSize),
          embeddingTimeoutMs: Number(draft.embeddingTimeoutMs),
          embeddingRetries: Number(draft.embeddingRetries),
          vectorRecall: Number(draft.vectorRecall),
          keywordRecall: Number(draft.keywordRecall),
          finalResults: Number(draft.finalResults),
          relevanceThreshold: draft.relevanceThreshold,
          hybridSearch: draft.hybridSearch,
          rerankerEnabled: draft.rerankerEnabled,
          rerankerSourceId: draft.rerankerSourceId,
          rerankerModel: draft.rerankerModel,
        })
        setSaved(draft)
        setConfigVersion(result.configVersion.version)
        setRequiresRebuild(result.configVersion.requiresRebuild)
        addAudit(`保存知识库配置 V${result.configVersion.version}`)
        notify(
          result.impact === 'index_rebuild'
            ? '配置已保存；兼容性变更需要确认重建索引。'
            : result.impact === 'query'
              ? '检索配置已保存，无需重建索引。'
              : '知识库配置已保存。',
        )
        return
      } catch (error) {
        notify(error instanceof Error ? error.message : '配置保存失败')
        return
      }
    }
    setSaved(draft)
    addAudit(`保存系统设置草稿：${current.name}`)
    notify('此模块尚未接入服务端，配置仅保存在当前会话。', 'warning')
  }
  const persistModelSources = async (nextSources: GenerativeSourceDraft[], removedModelIds: Set<string>) => {
    const generativeSources = await saveGenerativeModelSources(nextSources)
    const synchronize = (currentDraft: SettingsDraft) => ({
      ...currentDraft,
      generativeSources,
      ...repairGenerativeRouting(generativeSources, removedModelIds, currentDraft),
    })
    setSaved(synchronize)
    setDraft(synchronize)
    addAudit('即时保存生成式模型来源和模型配置')
    return generativeSources
  }
  return (
    <div className={`settings-layout ${collapsed ? 'directory-collapsed' : ''}`}>
      <aside className={`card settings-directory ${collapsed ? 'collapsed' : ''}`}>
        <div className="settings-dir-head">
          <b>配置目录</b>
          <button
            className="icon-btn"
            title={collapsed ? '展开配置目录' : '收起配置目录'}
            aria-label={collapsed ? '展开配置目录' : '收起配置目录'}
            onClick={() => setCollapsed(value => !value)}
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </button>
        </div>
        {['AI 能力', '资源与集成', '安全与治理'].map(group => (
          <div className="settings-group" key={group}>
            <p>{group}</p>
            {items.map(
              (item, index) =>
                item.group === group && (
                  <button
                    key={item.name}
                    className={selected === index ? 'active' : ''}
                    onClick={() => setSelected(index)}
                  >
                    <item.icon />
                    <span>
                      <b>{item.name}</b>
                      <small>{item.desc}</small>
                    </span>
                    <ChevronRight />
                  </button>
                ),
            )}
          </div>
        ))}
      </aside>
      <section className="card settings-editor">
        {selected !== 1 && (
          <div className="settings-editor-head">
            <div className="setting-symbol">
              <CurrentIcon />
            </div>
            <div>
              <h2>{current.name}</h2>
              <p>
                {current.desc}
                {selected === 2 && configVersion ? ` · 配置 V${configVersion}` : ''}
              </p>
            </div>
            {selected !== 0 && selected !== 5 && (
              <>
                <Badge tone={dirty ? 'orange' : requiresRebuild && selected === 2 ? 'orange' : 'green'}>
                  {dirty ? '有未保存更改' : requiresRebuild && selected === 2 ? '待重建' : '已保存'}
                </Badge>
                <button className="btn primary" disabled={!dirty} onClick={() => void save()}>
                  <Check />
                  保存配置
                </button>
              </>
            )}
          </div>
        )}
        <div className="settings-editor-scroll" ref={editorScrollRef}>
          {selected === 5 && <TestExecutionSettings notify={notify} addAudit={addAudit} />}
          {selected === 0 && (
            <ModelManagementSettings
              draft={draft}
              notify={notify}
              onPersistSources={persistModelSources}
              onHealthUpdated={source => {
                const mergeHealth = (sources: GenerativeSourceDraft[]) =>
                  sources.map(item =>
                    item.id !== source.id
                      ? item
                      : {
                          ...item,
                          health: source.health,
                          models: item.models.map(model => {
                            const checked = source.models.find(candidate => candidate.id === model.id)
                            return checked ? { ...model, health: checked.health } : model
                          }),
                        },
                  )
                setDraft(current => ({ ...current, generativeSources: mergeHealth(current.generativeSources) }))
                setSaved(current => ({ ...current, generativeSources: mergeHealth(current.generativeSources) }))
              }}
            />
          )}
          {selected === 1 && agentDraft && agentConfiguration && (
            <PromptAgentSettings
              draft={draft}
              notify={notify}
              agentDraft={agentDraft}
              updateAgent={value =>
                setAgentDraft(current => (typeof value === 'function' ? (current ? value(current) : current) : value))
              }
              configuration={agentConfiguration}
              configurationError={agentConfigError}
              modelSourcesState={modelSourcesState}
              modelSourcesError={modelSourcesError}
              onRetryConfiguration={() => void loadCurrentAgentConfiguration().catch(() => undefined)}
              onRetryModelSources={() => void loadModelSources().catch(() => undefined)}
              publishing={agentPublishing}
              onPublish={async agentKey => {
                setAgentPublishing(true)
                try {
                  const nextDraft = materializeRequiredAgentCapabilities(
                    agentDraft[agentKey],
                    agentConfiguration.agents[agentKey],
                  )
                  const persisted = await saveAgentConfigurationDraft(agentKey, nextDraft)
                  setAgentDraft(current => (current ? { ...current, [agentKey]: persisted } : current))
                  setSavedAgentDraft(current => (current ? { ...current, [agentKey]: persisted } : current))
                  setAgentConfiguration(current =>
                    current
                      ? {
                          ...current,
                          agents: { ...current.agents, [agentKey]: { ...current.agents[agentKey], draft: persisted } },
                        }
                      : current,
                  )
                  const published = await publishAgentConfiguration(agentKey, persisted.revision)
                  const metadata = agentConfigurationMetadata[agentKey]
                  const label = metadata.label
                  addAudit(`发布${label}配置 V${published.version}`)
                  notify(`${label} V${published.version} 已发布，${metadata.publishTarget}将固定使用该版本。`)
                  void loadCurrentAgentConfiguration().catch(error =>
                    notify(
                      error instanceof Error
                        ? `版本已发布，但配置刷新失败：${error.message}`
                        : '版本已发布，但配置刷新失败。',
                      'warning',
                    ),
                  )
                } catch (error) {
                  notify(error instanceof Error ? error.message : 'Agent 配置发布失败', 'error')
                } finally {
                  setAgentPublishing(false)
                }
              }}
            />
          )}
          {selected === 1 && !agentDraft && agentConfigState !== 'failed' && <AgentConfigurationLoading />}
          {selected === 1 && !agentDraft && agentConfigState === 'failed' && (
            <AgentConfigurationFailure
              error={agentConfigError}
              onRetry={() => void loadCurrentAgentConfiguration().catch(() => undefined)}
            />
          )}
          {selected === 2 && (
            <div className="settings-form">
              <FormSection title="向量模型配置" desc="集中管理多个来源和模型，再选择知识库实际使用的来源与模型">
                <EmbeddingModelPrototype
                  knowledgeBaseId={knowledgeBaseId}
                  draft={draft}
                  update={update}
                  notify={notify}
                />
              </FormSection>
              <FormSection title="Markdown 切分" desc="按模型 tokenizer 计数；修改后需要重建索引">
                <FormRow label="目标 Chunk 大小" help="默认 400 tokens，达到目标后优先在 Markdown 结构边界切分">
                  <select
                    value={draft.chunkSize}
                    onChange={event => {
                      const value = event.target.value
                      const target = Number.parseInt(value)
                      update('chunkSize', value)
                      if (target > Number(draft.chunkMaxSize))
                        update('chunkMaxSize', String(target === 600 ? 800 : target))
                    }}
                  >
                    <option>300 tokens</option>
                    <option>400 tokens</option>
                    <option>600 tokens</option>
                    <option>800 tokens</option>
                  </select>
                </FormRow>
                <FormRow label="最大 Chunk 大小" help="普通文本不会超过该值；代码块和表格优先保持完整">
                  <select
                    value={draft.chunkMaxSize}
                    onChange={event => {
                      const value = event.target.value
                      update('chunkMaxSize', value)
                      if (Number.parseInt(draft.chunkSize) > Number(value))
                        update('chunkSize', `${Math.min(Number(value), 400)} tokens`)
                    }}
                  >
                    <option>400</option>
                    <option>480</option>
                    <option>800</option>
                    <option>1200</option>
                  </select>
                </FormRow>
                <FormRow label="Chunk 重叠" help="仅在同一标题内切出相邻块时保留尾部上下文">
                  <select value={draft.chunkOverlap} onChange={event => update('chunkOverlap', event.target.value)}>
                    <option>0 tokens</option>
                    <option>50 tokens</option>
                    <option>80 tokens</option>
                    <option>120 tokens</option>
                  </select>
                </FormRow>
              </FormSection>
              <FormSection title="检索与索引" desc="调整检索参数并管理向量索引">
                <RetrievalIndexConfig
                  knowledgeBaseId={knowledgeBaseId}
                  requiresRebuild={requiresRebuild}
                  onRebuilt={() => setRequiresRebuild(false)}
                  draft={draft}
                  update={update}
                  notify={notify}
                />
              </FormSection>
            </div>
          )}
          {selected === 3 && (
            <StaticSettings title="访问控制" text="成员、角色和审批流程尚未接入服务端；当前页面仅展示本地原型说明。" />
          )}
          {selected === 4 && (
            <div className="settings-form">
              <FormSection title="数据安全" desc="安全策略可在本次会话中作为草稿保存">
                <SwitchRow
                  title="启用完整审计"
                  desc="记录当前会话中的本地模拟操作"
                  checked={draft.auditEnabled}
                  onChange={value => update('auditEnabled', value)}
                />
              </FormSection>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function StaticSettings({ title, text }: { title: string; text: string }) {
  return (
    <div className="settings-form">
      <FormSection title={title} desc={text}>
        <p className="readonly-notice">此项没有后端支撑，因此不伪造成功、连接或持久化状态。</p>
      </FormSection>
    </div>
  )
}
