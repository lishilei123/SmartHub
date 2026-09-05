import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bot,
  BrainCircuit,
  FileText,
  Play,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { type GenerativeSourceDraft, type SettingsDraft } from '../prototype-data'
import {
  type AgentConfigurationAgentDraft,
  type AgentConfigurationAgentKey,
  type AgentConfigurationState,
  type AgentRoutingConfiguration,
} from '../agent-configuration-api'
import {
  loadAiResources,
  type AiResourceCatalog,
  type McpServerResource,
  type SkillResource,
  type ToolResource,
} from '../ai-resource-api'
import { loadPlanningAgentProfile, type PlanningAgentProfile } from '../planning-api'
import { type Notify } from './types'
import { Badge } from './shared'
import { ModelPanelHead, FormRow, SwitchRow, agentSkillSummary, AgentConfigurationLoading } from './settings-shared'

export const agentConfigurationMetadata: Record<
  AgentConfigurationAgentKey,
  {
    label: string
    identifier: string
    sceneLabel: string
    protocolLabel: string
    publishTarget: string
    runtimeToolIds: string[]
    exactCapabilities: boolean
  }
> = {
  planning: {
    label: 'PlanningAgent',
    identifier: 'PlanningAgent',
    sceneLabel: '测试策划',
    protocolLabel: 'Planning + Project Workspace v1',
    publishTarget: '新的需求分析与测试设计任务',
    runtimeToolIds: [
      'workspace.list_directory',
      'workspace.find_files',
      'workspace.grep_files',
      'workspace.read_file',
      'knowledge.search',
      'knowledge.read_chunk',
      'requirement-analysis.submit_result',
      'test_design_cases.submit_result',
      'test_design_repair.submit_result',
    ],
    exactCapabilities: false,
  },
  executionImplementation: {
    label: '执行实现 Agent',
    identifier: 'ExecutionImplementationAgent',
    sceneLabel: '测试执行',
    protocolLabel: '生成 + 修复 v1',
    publishTarget: '新测试执行运行',
    runtimeToolIds: [
      'workspace.list_directory',
      'workspace.find_files',
      'workspace.grep_files',
      'workspace.read_file',
      'knowledge.search',
      'knowledge.read_chunk',
      'execution_implementation.submit_result',
    ],
    exactCapabilities: true,
  },
  failureAnalysis: {
    label: '失败分析 Agent',
    identifier: 'FailureAnalysisAgent',
    sceneLabel: '测试执行',
    protocolLabel: '失败分析 v1',
    publishTarget: '新测试执行诊断',
    runtimeToolIds: [
      'workspace.list_directory',
      'workspace.find_files',
      'workspace.grep_files',
      'workspace.read_file',
      'failure_analysis.submit_result',
    ],
    exactCapabilities: true,
  },
}

const agentConfigurationGroups: Array<{ label: string; agentKeys: AgentConfigurationAgentKey[] }> = [
  { label: '测试策划', agentKeys: ['planning'] },
  { label: '测试执行', agentKeys: ['executionImplementation', 'failureAnalysis'] },
]

export function PromptAgentSettings({
  draft,
  notify,
  agentDraft,
  updateAgent,
  configuration,
  configurationError,
  modelSourcesState,
  modelSourcesError,
  onRetryConfiguration,
  onRetryModelSources,
  publishing,
  onPublish,
}: {
  draft: SettingsDraft
  notify: Notify
  agentDraft: Record<AgentConfigurationAgentKey, AgentConfigurationAgentDraft>
  updateAgent: (
    value:
      | Record<AgentConfigurationAgentKey, AgentConfigurationAgentDraft>
      | ((
          current: Record<AgentConfigurationAgentKey, AgentConfigurationAgentDraft>,
        ) => Record<AgentConfigurationAgentKey, AgentConfigurationAgentDraft>),
  ) => void
  configuration: AgentConfigurationState
  configurationError: string | null
  modelSourcesState: 'idle' | 'loading' | 'ready' | 'failed'
  modelSourcesError: string | null
  onRetryConfiguration: () => void
  onRetryModelSources: () => void
  publishing: boolean
  onPublish: (agentKey: AgentConfigurationAgentKey) => Promise<void>
}) {
  const [selectedAgent, setSelectedAgent] = useState<AgentConfigurationAgentKey>('planning')
  const [tab, setTab] = useState<'planning' | 'model' | 'prompt' | 'tools'>('planning')
  const [resourceCatalog, setResourceCatalog] = useState<AiResourceCatalog | null>(null)
  const [resourceCatalogError, setResourceCatalogError] = useState('')
  const [planningProfile, setPlanningProfile] = useState<PlanningAgentProfile | null>(null)
  const [planningProfileError, setPlanningProfileError] = useState('')
  const currentDraft = agentDraft[selectedAgent]
  const currentState = configuration.agents[selectedAgent]
  const routing = currentDraft.routing
  const definition = currentDraft.definition
  const agentMetadata = agentConfigurationMetadata[selectedAgent]
  const agentLabel = agentMetadata.label
  const agentIdentifier = agentMetadata.identifier
  const allModels = draft.generativeSources.flatMap(source => source.models.map(model => ({ ...model, source })))
  const modelSourcesReady = modelSourcesState === 'ready'
  const availableModels = modelSourcesReady ? allModels.filter(model => model.source.enabled && model.enabled) : []
  const modelValue = (sourceId: string, modelId: string) => `${sourceId}\u0000${modelId}`
  const resolveModel = (reference: { sourceId: string; modelId: string } | null) =>
    reference
      ? allModels.find(model => model.source.id === reference.sourceId && model.id === reference.modelId)
      : undefined
  const defaultModel = resolveModel(routing.primaryModel)
  const updateCurrent = (value: AgentConfigurationAgentDraft) =>
    updateAgent(current => ({ ...current, [selectedAgent]: value }))
  const updateRouting = <K extends keyof AgentRoutingConfiguration>(key: K, value: AgentRoutingConfiguration[K]) =>
    updateCurrent({ ...currentDraft, routing: { ...routing, [key]: value } })
  const updateDefinition = (patch: Partial<AgentConfigurationAgentDraft['definition']>) =>
    updateCurrent({ ...currentDraft, definition: { ...definition, ...patch } })
  const updateLimit = (limit: keyof AgentConfigurationAgentDraft['definition']['limits'], value: number | string) =>
    updateDefinition({ limits: { ...definition.limits, [limit]: value } })
  const moveFallback = (index: number, offset: number) => {
    const target = index + offset
    if (target < 0 || target >= routing.fallbackModels.length) return
    const next = [...routing.fallbackModels]
    ;[next[index], next[target]] = [next[target], next[index]]
    updateRouting('fallbackModels', next)
  }
  const addFallback = () => {
    const model = availableModels.find(
      item =>
        (!routing.primaryModel ||
          modelValue(item.source.id, item.id) !==
            modelValue(routing.primaryModel.sourceId, routing.primaryModel.modelId)) &&
        !routing.fallbackModels.some(
          reference => modelValue(reference.sourceId, reference.modelId) === modelValue(item.source.id, item.id),
        ),
    )
    if (model)
      updateRouting('fallbackModels', [...routing.fallbackModels, { sourceId: model.source.id, modelId: model.id }])
  }
  const requiredToolIds = currentState.requiredToolIds
  const requiredSkillKeys = currentState.requiredSkillKeys
  const requiredMcpServerKeys = currentState.requiredMcpServerKeys
  const stageRuntimeToolIds = new Set(agentMetadata.runtimeToolIds)
  const toggleTool = (tool: ToolResource) => {
    if (agentMetadata.exactCapabilities || requiredToolIds.includes(tool.key)) return
    const selected = definition.toolIds.includes(tool.key)
    updateDefinition({
      toolIds: selected ? definition.toolIds.filter(item => item !== tool.key) : [...definition.toolIds, tool.key],
    })
  }
  const toggleSkill = (skill: SkillResource) => {
    if (agentMetadata.exactCapabilities || requiredSkillKeys.includes(skill.key)) return
    const selected = definition.skillKeys.includes(skill.key)
    updateDefinition({
      skillKeys: selected
        ? definition.skillKeys.filter(item => item !== skill.key)
        : [...definition.skillKeys, skill.key],
    })
  }
  const toggleMcp = (server: McpServerResource) => {
    if (agentMetadata.exactCapabilities || requiredMcpServerKeys.includes(server.key)) return
    const selected = definition.mcpServerKeys.includes(server.key)
    updateDefinition({
      mcpServerKeys: selected
        ? definition.mcpServerKeys.filter(item => item !== server.key)
        : [...definition.mcpServerKeys, server.key],
    })
  }
  const loadResourceCatalog = useCallback(() => {
    setResourceCatalogError('')
    return loadAiResources()
      .then(setResourceCatalog)
      .catch(error => {
        setResourceCatalogError(error instanceof Error ? error.message : 'AI 资源目录读取失败')
        throw error
      })
  }, [])
  useEffect(() => {
    if (tab !== 'tools' || resourceCatalog || resourceCatalogError) return
    void loadResourceCatalog().catch(() => undefined)
  }, [loadResourceCatalog, resourceCatalog, resourceCatalogError, tab])
  const loadPlanningProfile = useCallback(() => {
    setPlanningProfileError('')
    return loadPlanningAgentProfile()
      .then(setPlanningProfile)
      .catch(error => {
        setPlanningProfileError(error instanceof Error ? error.message : 'PlanningAgent Profile 读取失败')
        throw error
      })
  }, [])
  useEffect(() => {
    void loadPlanningProfile().catch(() => undefined)
  }, [loadPlanningProfile])
  const selectAgent = (value: AgentConfigurationAgentKey) => setSelectedAgent(value)
  return (
    <>
      <div className="agent-settings-page">
        <section className="agent-config-header">
          <div className="agent-symbol">
            <BrainCircuit />
          </div>
          <div className="agent-selector">
            <span>配置 Agent</span>
            <select
              value={selectedAgent}
              onChange={event => selectAgent(event.target.value as AgentConfigurationAgentKey)}
              aria-label="选择要配置的 Agent"
            >
              {agentConfigurationGroups.map(group => (
                <optgroup label={group.label} key={group.label}>
                  {group.agentKeys.map(agentKey => {
                    const metadata = agentConfigurationMetadata[agentKey]
                    return (
                      <option value={agentKey} key={agentKey}>
                        {metadata.label}（{metadata.identifier}）
                      </option>
                    )
                  })}
                </optgroup>
              ))}
            </select>
            <p>
              {agentMetadata.sceneLabel} / {agentIdentifier} · 草稿 revision {currentDraft.revision}
            </p>
          </div>
          <Badge tone={currentState.activeVersion ? 'green' : 'orange'}>
            {currentState.activeVersion ? `V${currentState.activeVersion.version} 生效中` : '尚未发布'}
          </Badge>
          <button
            className="btn primary agent-publish-button"
            disabled={publishing || !routing.primaryModel || !modelSourcesReady}
            onClick={() => void onPublish(selectedAgent)}
          >
            <Play />
            {publishing ? '发布中…' : `发布`}
          </button>
        </section>
        {configurationError && (
          <div className="agent-configuration-status failed">
            <AlertTriangle />
            <div>
              <b>版本已发布，但配置刷新失败</b>
              <span>{configurationError}</span>
            </div>
            <button className="btn ghost" onClick={onRetryConfiguration}>
              <RefreshCw />
              重新加载
            </button>
          </div>
        )}
        <nav className="agent-config-tabs">
          <button className={tab === 'planning' ? 'active' : ''} onClick={() => setTab('planning')}>
            <BrainCircuit />
            PlanningAgent
          </button>
          <button className={tab === 'model' ? 'active' : ''} onClick={() => setTab('model')}>
            <Bot />
            模型与路由
          </button>
          <button className={tab === 'prompt' ? 'active' : ''} onClick={() => setTab('prompt')}>
            <FileText />
            提示词
          </button>
          <button className={tab === 'tools' ? 'active' : ''} onClick={() => setTab('tools')}>
            <ShieldCheck />
            Tool、MCP、Skill
          </button>
        </nav>
        {tab === 'planning' && (
          <PlanningAgentSettings
            profile={planningProfile}
            error={planningProfileError}
            modelSources={draft.generativeSources}
            agentDraft={agentDraft}
            onRetry={() => void loadPlanningProfile().catch(() => undefined)}
          />
        )}
        {tab === 'model' && (
          <div className="model-routing-grid">
            <section className="model-config-panel">
              <ModelPanelHead title={`${agentLabel}模型参数`} desc={`仅作用于${agentLabel}，不会影响其他 Agent。`}>
                <Badge tone="purple">{agentMetadata.sceneLabel}</Badge>
              </ModelPanelHead>
              {!modelSourcesReady && (
                <div className={`agent-configuration-status ${modelSourcesState === 'failed' ? 'failed' : ''}`}>
                  <RefreshCw />
                  <div>
                    <b>{modelSourcesState === 'failed' ? '模型来源读取失败' : '正在读取模型来源'}</b>
                    <span>
                      {modelSourcesState === 'failed'
                        ? (modelSourcesError ?? '模型与路由暂不可编辑。')
                        : '提示词、工具和运行限制仍可使用。'}
                    </span>
                  </div>
                  {modelSourcesState === 'failed' && (
                    <button className="btn ghost" onClick={onRetryModelSources}>
                      <RefreshCw />
                      重新加载
                    </button>
                  )}
                </div>
              )}
              <div className="routing-form">
                <FormRow label="默认模型" help="智能路由关闭时固定使用该模型">
                  <select
                    disabled={!modelSourcesReady}
                    value={
                      routing.primaryModel
                        ? modelValue(routing.primaryModel.sourceId, routing.primaryModel.modelId)
                        : ''
                    }
                    onChange={event => {
                      const [sourceId, modelId] = event.target.value.split('\u0000')
                      updateRouting('primaryModel', sourceId && modelId ? { sourceId, modelId } : null)
                    }}
                  >
                    <option value="">{modelSourcesReady ? '请选择模型' : '模型来源读取中…'}</option>
                    {availableModels.map(model => (
                      <option value={modelValue(model.source.id, model.id)} key={modelValue(model.source.id, model.id)}>
                        {model.displayName} · {model.source.name}
                      </option>
                    ))}
                  </select>
                </FormRow>
                <FormRow label="上下文窗口" help="由当前 Agent 独立设置，并随 Agent 配置版本固化">
                  <div className="input-unit">
                    <input
                      type="number"
                      min="16384"
                      step="1024"
                      value={routing.contextWindow}
                      onChange={event => updateRouting('contextWindow', Number(event.target.value))}
                    />
                    <span>tokens</span>
                  </div>
                </FormRow>
                <FormRow label="最大输出 Token" help="由当前 Agent 独立设置，发布后直接用于模型调用">
                  <div className="input-unit">
                    <input
                      type="number"
                      min="1024"
                      step="1024"
                      value={routing.maxOutputTokens}
                      onChange={event => updateRouting('maxOutputTokens', Number(event.target.value))}
                    />
                    <span>tokens</span>
                  </div>
                </FormRow>
                <FormRow
                  label="流式无响应超时"
                  help="从请求发起或最近一次流式数据开始计时；正常思考、文本和工具参数流会自动续期"
                >
                  <div className="input-unit">
                    <input
                      type="number"
                      min="10"
                      value={routing.requestTimeoutSeconds}
                      onChange={event => updateRouting('requestTimeoutSeconds', Number(event.target.value))}
                    />
                    <span>秒</span>
                  </div>
                </FormRow>
                <FormRow label="失败重试" help="仅对限流、超时等错误生效">
                  <select
                    value={routing.retryCount}
                    onChange={event => updateRouting('retryCount', Number(event.target.value))}
                  >
                    <option value={0}>不重试</option>
                    <option value={1}>1 次</option>
                    <option value={2}>2 次</option>
                    <option value={3}>3 次</option>
                  </select>
                </FormRow>
              </div>
            </section>
            <section className="model-config-panel route-policy-panel">
              <ModelPanelHead title="路由与降级" desc={`仅保存到${agentLabel}的独立版本快照。`} />
              <SwitchRow
                title="启用智能模型路由"
                desc="按能力、启用和健康状态选择模型"
                checked={routing.intelligentRouting}
                onChange={value => updateRouting('intelligentRouting', value)}
              />
              <SwitchRow
                title="允许模型降级"
                desc="默认模型不可用时按顺序尝试备用模型"
                checked={routing.fallbackEnabled}
                onChange={value => updateRouting('fallbackEnabled', value)}
              />
              <div className={`fallback-route ${routing.fallbackEnabled ? '' : 'disabled'}`}>
                <div className="fallback-primary">
                  <span>主</span>
                  <div>
                    <b>{defaultModel?.displayName ?? '未选择默认模型'}</b>
                    <small>{defaultModel?.source.name ?? '请先在模型管理中启用模型'}</small>
                  </div>
                  <Badge tone="green">默认</Badge>
                </div>
                {routing.fallbackModels.map((reference, index) => {
                  const model = resolveModel(reference)
                  return (
                    model && (
                      <div className="fallback-item" key={modelValue(reference.sourceId, reference.modelId)}>
                        <span>{index + 1}</span>
                        <div>
                          <b>{model.displayName}</b>
                          <small>{model.source.name}</small>
                        </div>
                        <div>
                          <button
                            className="icon-btn"
                            disabled={!modelSourcesReady || index === 0}
                            onClick={() => moveFallback(index, -1)}
                          >
                            <ArrowUp />
                          </button>
                          <button
                            className="icon-btn"
                            disabled={!modelSourcesReady || index === routing.fallbackModels.length - 1}
                            onClick={() => moveFallback(index, 1)}
                          >
                            <ArrowDown />
                          </button>
                          <button
                            className="icon-btn danger-text"
                            disabled={!modelSourcesReady}
                            onClick={() =>
                              updateRouting(
                                'fallbackModels',
                                routing.fallbackModels.filter((_, position) => position !== index),
                              )
                            }
                          >
                            <Trash2 />
                          </button>
                        </div>
                      </div>
                    )
                  )
                })}
                <button
                  className="add-fallback"
                  disabled={
                    !modelSourcesReady ||
                    !routing.fallbackEnabled ||
                    !availableModels.some(
                      model =>
                        (!routing.primaryModel ||
                          modelValue(model.source.id, model.id) !==
                            modelValue(routing.primaryModel.sourceId, routing.primaryModel.modelId)) &&
                        !routing.fallbackModels.some(
                          reference =>
                            modelValue(reference.sourceId, reference.modelId) === modelValue(model.source.id, model.id),
                        ),
                    )
                  }
                  onClick={addFallback}
                >
                  <Plus />
                  添加回退模型
                </button>
              </div>
              <div className="route-note">
                <ShieldCheck />
                <span>
                  <b>{agentLabel}独立配置</b>
                  <small>模型来源由通用模型库管理；模型选择和路由策略随当前 Agent 版本发布。</small>
                </span>
              </div>
            </section>
            <section className="model-config-panel agent-runtime-limits">
              <ModelPanelHead title="运行限制" desc={`控制${agentLabel}的执行预算，并随当前 Agent 版本固化。`} />
              <div className="agent-limit-grid">
                <label>
                  最大轮次
                  <input
                    type="number"
                    min="4"
                    max="100"
                    value={definition.limits.maxTurns}
                    onChange={event => updateLimit('maxTurns', Number(event.target.value))}
                  />
                </label>
                <label>
                  最大工具调用
                  <input
                    type="number"
                    min="1"
                    max="200"
                    value={definition.limits.maxToolCalls}
                    onChange={event => updateLimit('maxToolCalls', Number(event.target.value))}
                  />
                </label>
                <label>
                  总截止时间（秒）
                  <input
                    type="number"
                    min="30"
                    max="3600"
                    value={definition.limits.deadlineMs / 1000}
                    onChange={event => updateLimit('deadlineMs', Number(event.target.value) * 1000)}
                  />
                </label>
                <label>
                  推理强度
                  <select
                    value={definition.limits.reasoningEffort ?? 'medium'}
                    onChange={event => updateLimit('reasoningEffort', event.target.value)}
                  >
                    <option value="off">关闭</option>
                    <option value="low">低</option>
                    <option value="medium">中</option>
                    <option value="high">高</option>
                    <option value="xhigh">超高</option>
                  </select>
                </label>
              </div>
            </section>
          </div>
        )}
        {tab === 'prompt' && (
          <section className="model-config-panel agent-prompt-editor">
            <ModelPanelHead title={`${agentLabel}提示词`} desc={`配置${agentLabel}的系统指令与任务模板。`}>
              <Badge tone="purple">{agentMetadata.protocolLabel}</Badge>
            </ModelPanelHead>
            <label>
              <span>系统提示词</span>
              <textarea
                value={definition.systemPrompt}
                onChange={event => updateDefinition({ systemPrompt: event.target.value })}
              />
              <small>{definition.systemPrompt.length.toLocaleString()} 字符</small>
            </label>
            <label>
              <span>任务模板</span>
              <textarea
                className="task-template"
                value={definition.taskTemplate}
                onChange={event => updateDefinition({ taskTemplate: event.target.value })}
              />
              <small>{definition.taskTemplate.length.toLocaleString()} 字符</small>
            </label>
          </section>
        )}
        {tab === 'tools' && (
          <section className="model-config-panel agent-tool-editor">
            <ModelPanelHead
              title={`${agentLabel} Tool、MCP、Skill`}
              desc="Agent 默认绑定的 Skill / Tool 由服务端强制保留，不可关闭；其他能力可按需配置。发布版本绑定的 Skill 只把 Catalog 加载到 Prompt，Agent 按需通过 skill.read 读取正文。"
            >
              <Badge tone="green">服务端强校验</Badge>
            </ModelPanelHead>
            {resourceCatalog === null && !resourceCatalogError && (
              <div className="agent-capability-state">
                <RefreshCw className="document-loading-icon" />
                正在读取完整 AI 资源目录…
              </div>
            )}
            {resourceCatalogError && (
              <div className="agent-capability-state failed">
                <AlertTriangle />
                <span>{resourceCatalogError}</span>
                <button className="btn ghost" onClick={() => void loadResourceCatalog().catch(() => undefined)}>
                  <RefreshCw />
                  重试
                </button>
              </div>
            )}
            {resourceCatalog && (
              <>
                <div className="agent-capability-section">
                  <header>
                    <div>
                      <b>Tool</b>
                      <small>默认绑定项不可移除；其他可用工具可独立配置。</small>
                    </div>
                    <Badge tone="purple">
                      {
                        resourceCatalog.tools.filter(
                          tool => definition.toolIds.includes(tool.key) || requiredToolIds.includes(tool.key),
                        ).length
                      }{' '}
                      / {resourceCatalog.tools.length} 已选择
                    </Badge>
                  </header>
                  {resourceCatalog.tools.length === 0 ? (
                    <div className="agent-capability-state">
                      <ShieldCheck />
                      暂无 Tool，请先到模型管理添加。
                    </div>
                  ) : (
                    <div className="agent-skill-list">
                      {resourceCatalog.tools.map(tool => {
                        const required = requiredToolIds.includes(tool.key)
                        const selected = definition.toolIds.includes(tool.key) || required
                        const runtimeReady = stageRuntimeToolIds.has(tool.key)
                        return (
                          <label className={!tool.enabled ? 'disabled' : ''} key={tool.id}>
                            <input
                              type="checkbox"
                              checked={selected}
                              disabled={agentMetadata.exactCapabilities || required || (!tool.enabled && !selected)}
                              onChange={() => toggleTool(tool)}
                            />
                            <span>
                              <b>{tool.name}</b>
                              <code>
                                {tool.key}@{tool.version}
                              </code>
                              <small>{required ? 'Agent 默认绑定，不可关闭' : tool.description || '暂无描述'}</small>
                            </span>
                            <Badge
                              tone={required || runtimeReady ? 'green' : tool.status === 'ready' ? 'blue' : 'gray'}
                            >
                              {required
                                ? '默认绑定'
                                : runtimeReady
                                  ? '可运行'
                                  : tool.status === 'ready'
                                    ? '可绑定'
                                    : '待接入'}
                            </Badge>
                          </label>
                        )
                      })}
                    </div>
                  )}
                </div>
                <div className="agent-capability-section">
                  <header>
                    <div>
                      <b>MCP</b>
                      <small>展示 MCP 目录中的全部服务，选择结果随 Agent 版本固化。</small>
                    </div>
                    <Badge tone="purple">
                      {
                        resourceCatalog.mcpServers.filter(
                          server =>
                            definition.mcpServerKeys.includes(server.key) || requiredMcpServerKeys.includes(server.key),
                        ).length
                      }{' '}
                      / {resourceCatalog.mcpServers.length} 已选择
                    </Badge>
                  </header>
                  {resourceCatalog.mcpServers.length === 0 ? (
                    <div className="agent-capability-state">
                      <Server />
                      暂无 MCP，请先到模型管理添加。
                    </div>
                  ) : (
                    <div className="agent-skill-list">
                      {resourceCatalog.mcpServers.map(server => {
                        const required = requiredMcpServerKeys.includes(server.key)
                        const selected = definition.mcpServerKeys.includes(server.key) || required
                        return (
                          <label className={!server.enabled ? 'disabled' : ''} key={server.id}>
                            <input
                              type="checkbox"
                              checked={selected}
                              disabled={agentMetadata.exactCapabilities || required || (!server.enabled && !selected)}
                              onChange={() => toggleMcp(server)}
                            />
                            <span>
                              <b>{server.name}</b>
                              <code>
                                {server.key}@{server.version}
                              </code>
                              <small>
                                {required
                                  ? '必需 MCP，不可移除'
                                  : !server.enabled
                                    ? '已停用，可取消但不能新增'
                                    : `${server.transport === 'streamable_http' ? 'Streamable HTTP' : 'SSE'} · ${server.toolIds.length} 个远程工具`}
                              </small>
                            </span>
                            <Badge tone={required ? 'green' : server.status === 'ready' ? 'blue' : 'gray'}>
                              {required ? '必需' : server.status === 'ready' ? '可绑定' : '待接入'}
                            </Badge>
                          </label>
                        )
                      })}
                    </div>
                  )}
                </div>
                <div className="agent-capability-section">
                  <header>
                    <div>
                      <b>Skill</b>
                      <small>默认绑定项不可移除；其他 Skill 可按需绑定，运行时由 Agent 自主读取正文。</small>
                    </div>
                    <Badge tone="purple">
                      {
                        resourceCatalog.skills.filter(
                          skill => definition.skillKeys.includes(skill.key) || requiredSkillKeys.includes(skill.key),
                        ).length
                      }{' '}
                      / {resourceCatalog.skills.length} 已选择
                    </Badge>
                  </header>
                  {resourceCatalog.skills.length === 0 ? (
                    <div className="agent-capability-state">
                      <Sparkles />
                      暂无 Skill，请先到模型管理添加。
                    </div>
                  ) : (
                    <div className="agent-skill-list">
                      {resourceCatalog.skills.map(skill => {
                        const required = requiredSkillKeys.includes(skill.key)
                        const selected = definition.skillKeys.includes(skill.key) || required
                        return (
                          <label className={!skill.enabled ? 'disabled' : ''} key={skill.id}>
                            <input
                              type="checkbox"
                              checked={selected}
                              disabled={agentMetadata.exactCapabilities || required || (!skill.enabled && !selected)}
                              onChange={() => toggleSkill(skill)}
                            />
                            <span>
                              <b>{skill.name}</b>
                              <code>
                                {skill.key}@{skill.version}
                              </code>
                              <small>
                                {required
                                  ? 'Agent 默认绑定，不可关闭'
                                  : !skill.enabled
                                    ? '已停用，可取消但不能新增'
                                    : agentSkillSummary(skill)}
                              </small>
                            </span>
                            <Badge tone={required ? 'green' : skill.status === 'ready' ? 'blue' : 'gray'}>
                              {required ? '默认绑定' : skill.status === 'ready' ? '可绑定' : '待接入'}
                            </Badge>
                          </label>
                        )
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
        )}
      </div>
    </>
  )
}

function PlanningAgentSettings({
  profile,
  error,
  modelSources,
  agentDraft,
  onRetry,
}: {
  profile: PlanningAgentProfile | null
  error: string
  modelSources: GenerativeSourceDraft[]
  agentDraft: Record<AgentConfigurationAgentKey, AgentConfigurationAgentDraft>
  onRetry: () => void
}) {
  if (error)
    return (
      <div className="agent-configuration-status failed">
        <AlertTriangle />
        <div>
          <b>PlanningAgent Profile 读取失败</b>
          <span>{error}</span>
        </div>
        <button className="btn ghost" onClick={onRetry}>
          <RefreshCw />
          重新加载
        </button>
      </div>
    )
  if (!profile) return <AgentConfigurationLoading />
  const modelFor = (reference: { sourceId: string; modelId: string } | null) =>
    reference
      ? modelSources
          .flatMap(source => source.models.map(model => ({ source, model })))
          .find(item => item.source.id === reference.sourceId && item.model.id === reference.modelId)
      : undefined
  return (
    <section className="planning-agent-profile">
      <header>
        <span>
          <BrainCircuit />
          <div>
            <b>{profile.label}</b>
            <small>需求分析与测试设计共用的唯一可发布 Agent 配置。</small>
          </div>
        </span>
        <Badge tone="green">projectVersion Planning Session</Badge>
      </header>
      <div className="planning-agent-summary">
        <article>
          <small>Parent Session</small>
          <b>{profile.parentSession}</b>
          <span>RequirementAnalysis 与 TestDesign 共用同一 Planning Context</span>
        </article>
        <article>
          <small>Auto Compaction</small>
          <b>
            {profile.context.autoCompaction ? 'Enabled' : 'Disabled'} · {profile.context.proactiveThresholdPercent}%
          </b>
          <span>Summary 不是正式业务事实</span>
        </article>
        <article>
          <small>SubAgents</small>
          <b>{profile.subAgents.length} 个独立 Reviewer</b>
          <span>独立 Session · 只读 Workspace</span>
        </article>
        <article>
          <small>Stages</small>
          <b>{profile.stageProfiles.length} 个固定 Stage</b>
          <span>用例审核与发布保留人工门禁</span>
        </article>
      </div>
      <div className="planning-agent-configurations">
        {profile.configurations.map(configuration => {
          const active = configuration.activeVersion
          const model = modelFor(active?.routing.primaryModel ?? null)
          const draft = agentDraft[configuration.agentKey]
          return (
            <article key={configuration.agentKey}>
              <header>
                <span>
                  <Bot />
                  <div>
                    <b>PlanningAgent</b>
                    <small>统一已发布配置 · {configuration.scene}</small>
                  </div>
                </span>
                <Badge tone={active ? 'green' : 'orange'}>{active ? `V${active.version}` : '未发布'}</Badge>
              </header>
              {active ? (
                <>
                  <div className="planning-agent-kpis">
                    <span>
                      <small>模型</small>
                      <b>{model?.model.displayName ?? active.routing.primaryModel?.modelId ?? '未选择'}</b>
                    </span>
                    <span>
                      <small>Context Window</small>
                      <b>{active.routing.contextWindow.toLocaleString()}</b>
                    </span>
                    <span>
                      <small>最大 Turns</small>
                      <b>{active.agentDefinition.limits.maxTurns}</b>
                    </span>
                    <span>
                      <small>Tool Calls</small>
                      <b>{active.agentDefinition.limits.maxToolCalls}</b>
                    </span>
                  </div>
                  <details>
                    <summary>System Prompt</summary>
                    <pre>{active.agentDefinition.systemPrompt}</pre>
                  </details>
                  <dl>
                    <div>
                      <dt>Enabled Skills</dt>
                      <dd>{active.agentDefinition.enabledSkills.join(' · ') || '—'}</dd>
                    </div>
                    <div>
                      <dt>Tools</dt>
                      <dd>{active.agentDefinition.toolIds.join(' · ') || '—'}</dd>
                    </div>
                  </dl>
                </>
              ) : (
                <p className="readonly-notice">请在模型与路由、提示词、Tool/MCP/Skill 页签完成统一配置并发布。</p>
              )}
              <footer>草稿 revision {draft.revision} · 需求分析与测试设计都会固定使用该配置版本</footer>
            </article>
          )
        })}
      </div>
      <section className="planning-agent-subagents">
        <header>
          <ShieldCheck />
          <span>
            <b>Reviewer SubAgents</b>
            <small>候选只注入 Parent Session，最终采纳仍由 Workflow、Service 与 Validator 决定。</small>
          </span>
        </header>
        <div>
          {profile.subAgents.map(subAgent => (
            <article key={subAgent.reviewerType}>
              <Bot />
              <span>
                <b>{subAgent.label}</b>
                <small>
                  {subAgent.session} session · {subAgent.workspace} workspace
                </small>
                <code>{subAgent.resultSchemaVersion}</code>
              </span>
            </article>
          ))}
        </div>
      </section>
      <section className="planning-agent-context">
        <header>
          <RefreshCw />
          <span>
            <b>Context / Compaction</b>
            <small>检查点达到阈值时主动压缩，不在每个 Stage 无条件压缩。</small>
          </span>
        </header>
        <div>
          {profile.context.checkpoints.map(checkpoint => (
            <code key={checkpoint}>{checkpoint}</code>
          ))}
        </div>
      </section>
      <section className="planning-agent-stages">
        <header>
          <Activity />
          <span>
            <b>Workflow Stage 边界</b>
            <small>
              Workflow 固定业务 Gate、Allowed Tools、Submit Tool、Schema 与 Reviewer；Skill 始终来自 PlanningAgent 的
              Enabled Skills。
            </small>
          </span>
        </header>
        <div>
          {profile.stageProfiles.map(stage => (
            <article key={stage.stage}>
              <header>
                <b>{stage.stage}</b>
                <Badge tone={stage.humanGate ? 'orange' : 'gray'}>
                  {stage.humanGate ? 'Human Gate' : stage.agentKey}
                </Badge>
              </header>
              <dl>
                <div>
                  <dt>Tools</dt>
                  <dd>{stage.allowedToolIds.join(' · ') || '—'}</dd>
                </div>
                <div>
                  <dt>Submit / Schema</dt>
                  <dd>
                    {stage.submitToolId ?? '—'} · {stage.resultSchemaVersion ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt>Reviewer</dt>
                  <dd>{stage.reviewers.join(' · ') || '—'}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      </section>
    </section>
  )
}
