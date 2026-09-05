import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Code2,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react'
import {
  createAiResource,
  deleteAiResource,
  loadAiResources,
  loadToolSource,
  updateAiResource,
  uploadSkillPackage,
  type AiResource,
  type AiResourceCatalog,
  type AiResourceKind,
  type McpServerResource,
  type SkillPackageMetadata,
  type ToolResource,
  type ToolSource,
} from '../ai-resource-api'
import { type Notify } from './types'
import { ModelPanelHead, formatBytes, skillRuntimeSummary } from './settings-shared'
import { Badge, Modal } from './shared'

type AiResourceEditor = {
  id?: string
  kind: AiResourceKind
  key: string
  name: string
  description: string
  version: string
  enabled: boolean
  transport: McpServerResource['transport']
  endpoint: string
  authType: McpServerResource['authType']
  credentialEnv: string
  entrypoint: string
  skillMode: 'zip' | 'entrypoint'
  packageFile: File | null
  package?: SkillPackageMetadata
  toolIds: string[]
  tags: string
  source: ToolResource['source']
  risk: ToolResource['risk']
  timeoutMs: number
  sourcePath: string
  mcpServerId: string
  parametersJson: string
}

export function AiResourceManagement({ kind, notify }: { kind: AiResourceKind; notify: Notify }) {
  const [catalog, setCatalog] = useState<AiResourceCatalog | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')
  const [editor, setEditor] = useState<AiResourceEditor | null>(null)
  const [sourceViewer, setSourceViewer] = useState<ToolSource | null>(null)
  const [sourceLoadingId, setSourceLoadingId] = useState('')
  const load = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true)
      setError('')
    }
    try {
      const nextCatalog = await loadAiResources()
      setCatalog(nextCatalog)
      setError('')
      return nextCatalog
    } catch (loadError) {
      if (!silent) setError(loadError instanceof Error ? loadError.message : 'AI 资源目录读取失败')
      return null
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(true), 1000)
    return () => window.clearInterval(timer)
  }, [load])
  const resources: AiResource[] = catalog
    ? kind === 'mcp'
      ? catalog.mcpServers
      : kind === 'skill'
        ? catalog.skills
        : catalog.tools
    : []
  const title = kind === 'mcp' ? 'MCP 服务' : kind === 'skill' ? 'Skill' : '工具'
  const description =
    kind === 'mcp'
      ? '注册远程 MCP 服务及其暴露的工具范围；当前只允许 HTTP/S 传输。'
      : kind === 'skill'
        ? '维护可复用专业方法与外部依赖；Agent 发布版本绑定 Catalog，运行时按需读取正文。'
        : '统一治理可独立配置的内置、本地、HTTP 与 MCP 工具。'
  const openCreate = () =>
    setEditor({
      kind,
      key: '',
      name: '',
      description: '',
      version: '1.0.0',
      enabled: true,
      transport: 'streamable_http',
      endpoint: '',
      authType: 'none',
      credentialEnv: '',
      entrypoint: '',
      skillMode: kind === 'skill' ? 'zip' : 'entrypoint',
      packageFile: null,
      toolIds: [],
      tags: '',
      source: kind === 'tool' ? 'local' : 'builtin',
      risk: 'read',
      timeoutMs: 30_000,
      sourcePath: '',
      mcpServerId: '',
      parametersJson: '{\n  "type": "object",\n  "properties": {}\n}',
    })
  const openEdit = (resource: AiResource) =>
    setEditor({
      id: resource.id,
      kind: resource.kind,
      key: resource.key,
      name: resource.name,
      description: resource.description,
      version: resource.version,
      enabled: resource.enabled,
      transport: resource.kind === 'mcp' ? resource.transport : 'streamable_http',
      endpoint: resource.kind === 'mcp' ? resource.endpoint : resource.kind === 'tool' ? (resource.endpoint ?? '') : '',
      authType:
        resource.kind === 'mcp' ? resource.authType : resource.kind === 'tool' ? (resource.authType ?? 'none') : 'none',
      credentialEnv:
        resource.kind === 'mcp'
          ? (resource.credentialEnv ?? '')
          : resource.kind === 'tool'
            ? (resource.credentialEnv ?? '')
            : '',
      entrypoint: resource.kind === 'skill' ? resource.entrypoint : '',
      skillMode: resource.kind === 'skill' && resource.package ? 'zip' : 'entrypoint',
      packageFile: null,
      package: resource.kind === 'skill' ? resource.package : undefined,
      toolIds: resource.kind === 'tool' ? [] : [...resource.toolIds],
      tags: resource.kind === 'skill' ? resource.tags.join(', ') : '',
      source: resource.kind === 'tool' ? resource.source : 'local',
      risk: resource.kind === 'tool' ? resource.risk : 'read',
      timeoutMs: resource.kind === 'tool' ? resource.timeoutMs : 30_000,
      sourcePath: resource.kind === 'tool' ? (resource.sourcePath ?? '') : '',
      mcpServerId: resource.kind === 'tool' ? (resource.mcpServerId ?? '') : '',
      parametersJson:
        resource.kind === 'tool'
          ? JSON.stringify(resource.parameters ?? { type: 'object', properties: {} }, null, 2)
          : '{\n  "type": "object",\n  "properties": {}\n}',
    })
  const persist = async () => {
    if (!editor) return
    setBusyId(editor.id ?? 'new')
    try {
      const common = {
        key: editor.key,
        name: editor.name,
        description: editor.description,
        version: editor.version,
        enabled: editor.enabled,
      }
      const payload =
        editor.kind === 'mcp'
          ? {
              ...common,
              transport: editor.transport,
              endpoint: editor.endpoint,
              authType: editor.authType,
              credentialEnv: editor.authType === 'none' ? undefined : editor.credentialEnv || undefined,
              toolIds: editor.toolIds,
            }
          : editor.kind === 'skill'
            ? {
                ...common,
                entrypoint: editor.entrypoint,
                toolIds: editor.toolIds,
                tags: editor.tags
                  .split(',')
                  .map(item => item.trim())
                  .filter(Boolean),
              }
            : {
                ...common,
                source: editor.source,
                risk: editor.risk,
                timeoutMs: editor.timeoutMs,
                sourcePath: editor.source === 'local' ? editor.sourcePath : undefined,
                mcpServerId: editor.source === 'mcp' ? editor.mcpServerId : undefined,
                endpoint: editor.source === 'http' ? editor.endpoint : undefined,
                authType: editor.source === 'http' ? editor.authType : undefined,
                credentialEnv:
                  editor.source === 'http' && editor.authType === 'bearer'
                    ? editor.credentialEnv || undefined
                    : undefined,
                parameters: editor.source === 'http' ? JSON.parse(editor.parametersJson) : undefined,
              }
      if (editor.id) await updateAiResource(editor.kind, editor.id, payload)
      else if (editor.kind === 'skill' && editor.skillMode === 'zip') {
        if (!editor.packageFile) throw new Error('请选择 Skill ZIP 包')
        if (editor.packageFile.size > 20 * 1024 * 1024) throw new Error('Skill ZIP 不能超过 20 MB')
        await uploadSkillPackage(payload, editor.packageFile)
      } else await createAiResource(editor.kind, payload)
      setEditor(null)
      await load()
      notify(`${title}${editor.id ? '已更新' : '已添加'}并持久化。`)
    } catch (saveError) {
      notify(saveError instanceof Error ? saveError.message : `${title}保存失败`, 'error')
    } finally {
      setBusyId('')
    }
  }
  const toggle = async (resource: AiResource) => {
    if (resource.builtIn) return
    setBusyId(resource.id)
    try {
      await updateAiResource(resource.kind, resource.id, { enabled: !resource.enabled })
      await load()
      notify(`${resource.name} 已${resource.enabled ? '停用' : '启用'}。`)
    } catch (toggleError) {
      notify(toggleError instanceof Error ? toggleError.message : '状态更新失败', 'error')
    } finally {
      setBusyId('')
    }
  }
  const remove = async (resource: AiResource) => {
    if (!window.confirm(`删除${title}“${resource.name}”？该操作将立即写入服务端。`)) return
    setBusyId(resource.id)
    try {
      await deleteAiResource(resource.kind, resource.id)
      await load()
      notify(`${resource.name} 已删除。`)
    } catch (deleteError) {
      notify(deleteError instanceof Error ? deleteError.message : '资源删除失败', 'error')
    } finally {
      setBusyId('')
    }
  }
  const viewSource = async (resource: ToolResource) => {
    setSourceLoadingId(resource.id)
    try {
      setSourceViewer(await loadToolSource(resource.id))
    } catch (sourceError) {
      const refreshedCatalog = await load(true)
      if (refreshedCatalog && !refreshedCatalog.tools.some(tool => tool.id === resource.id)) return
      notify(sourceError instanceof Error ? sourceError.message : '工具源码读取失败', 'error')
    } finally {
      setSourceLoadingId('')
    }
  }
  return (
    <section className="model-config-panel ai-resource-panel">
      <ModelPanelHead title={title} desc={description}>
        <span className="ai-resource-head-actions">
          <Badge tone="purple">{resources.length} 项</Badge>
          <button className="btn primary" onClick={openCreate}>
            <Plus />
            添加{title}
          </button>
        </span>
      </ModelPanelHead>
      {loading && (
        <div className="ai-resource-state">
          <RefreshCw className="document-loading-icon" />
          <span>正在读取 AI 资源目录…</span>
        </div>
      )}
      {!loading && error && (
        <div className="ai-resource-state failed">
          <AlertTriangle />
          <span>
            <b>读取失败</b>
            <small>{error}</small>
          </span>
          <button className="btn ghost" onClick={() => void load()}>
            <RefreshCw />
            重试
          </button>
        </div>
      )}
      {!loading && !error && resources.length === 0 && (
        <div className="ai-resource-empty">
          <CurrentAiResourceIcon kind={kind} />
          <b>尚未注册{title}</b>
          <span>点击“添加{title}”创建首个服务端资源记录。</span>
        </div>
      )}
      {!loading && !error && resources.length > 0 && (
        <div className="ai-resource-list">
          {resources.map(resource => (
            <article className={resource.enabled ? '' : 'disabled'} key={resource.id}>
              <div className="ai-resource-icon">
                <CurrentAiResourceIcon kind={resource.kind} />
              </div>
              <div className="ai-resource-main">
                <header>
                  <b>{resource.name}</b>
                  <Badge tone={resource.status === 'ready' ? 'green' : 'orange'}>
                    {resource.status === 'ready' ? '可用' : '待接入'}
                  </Badge>
                  {resource.builtIn && <Badge tone="blue">内置</Badge>}
                  {resource.managedBy === 'filesystem' && <Badge tone="purple">外置</Badge>}
                </header>
                <code>
                  {resource.key}@{resource.version}
                </code>
                <p>{resource.description || '暂无描述'}</p>
                <ResourceMetadata resource={resource} catalog={catalog} />
              </div>
              <div className="ai-resource-actions">
                <label
                  className="switch"
                  title={resource.builtIn ? '内置 Tool 和 Skill 始终启用，不可关闭' : undefined}
                >
                  <input
                    type="checkbox"
                    checked={resource.enabled}
                    disabled={resource.builtIn || busyId === resource.id}
                    onChange={() => void toggle(resource)}
                    aria-label={
                      resource.builtIn
                        ? `${resource.name} 为内置资源，始终启用`
                        : `${resource.enabled ? '停用' : '启用'} ${resource.name}`
                    }
                  />
                  <i />
                </label>
                {resource.kind === 'tool' && ['builtin', 'local'].includes(resource.source) && resource.sourcePath && (
                  <button
                    className="icon-btn source-code-button"
                    disabled={sourceLoadingId === resource.id}
                    title="查看源码"
                    aria-label={`查看 ${resource.name} 源码`}
                    onClick={() => void viewSource(resource)}
                  >
                    {sourceLoadingId === resource.id ? <RefreshCw className="document-loading-icon" /> : <Code2 />}
                  </button>
                )}
                {!resource.builtIn && resource.managedBy !== 'filesystem' && (
                  <button
                    className="icon-btn"
                    disabled={busyId === resource.id}
                    onClick={() => openEdit(resource)}
                    aria-label={`编辑 ${resource.name}`}
                  >
                    <Pencil />
                  </button>
                )}
                {!resource.builtIn && resource.managedBy !== 'filesystem' && (
                  <button
                    className="icon-btn danger-text"
                    disabled={busyId === resource.id}
                    onClick={() => void remove(resource)}
                    aria-label={`删除 ${resource.name}`}
                  >
                    <Trash2 />
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {editor && (
        <Modal
          title={`${editor.id ? '编辑' : '添加'}${title}`}
          className="ai-resource-modal"
          onClose={() => setEditor(null)}
        >
          <div className="modal-form ai-resource-form">
            <div className="ai-resource-common-fields">
              <label>
                资源标识
                <input
                  value={editor.key}
                  disabled={Boolean(editor.id)}
                  onChange={event => setEditor(current => current && { ...current, key: event.target.value })}
                  placeholder={
                    kind === 'mcp' ? 'github.mcp' : kind === 'skill' ? 'requirement.analysis' : 'quality.check'
                  }
                />
              </label>
              <label>
                名称
                <input
                  value={editor.name}
                  onChange={event => setEditor(current => current && { ...current, name: event.target.value })}
                  placeholder={`${title}展示名称`}
                />
              </label>
              <label>
                版本
                <input
                  value={editor.version}
                  disabled={Boolean(editor.package)}
                  onChange={event => setEditor(current => current && { ...current, version: event.target.value })}
                  placeholder="1.0.0"
                />
                {editor.package && <small>ZIP 包版本不可原位覆盖，请以新版本重新上传。</small>}
              </label>
              <label className="wide">
                描述
                <textarea
                  value={editor.description}
                  onChange={event => setEditor(current => current && { ...current, description: event.target.value })}
                  placeholder="说明用途、数据边界与适用场景"
                />
              </label>
            </div>
            {editor.kind === 'mcp' && (
              <div className="ai-resource-specific-fields">
                <label>
                  传输协议
                  <select
                    value={editor.transport}
                    onChange={event =>
                      setEditor(
                        current =>
                          current && { ...current, transport: event.target.value as McpServerResource['transport'] },
                      )
                    }
                  >
                    <option value="streamable_http">Streamable HTTP</option>
                    <option value="sse">SSE（兼容旧服务）</option>
                  </select>
                </label>
                <label>
                  鉴权类型
                  <select
                    value={editor.authType}
                    onChange={event =>
                      setEditor(
                        current =>
                          current && { ...current, authType: event.target.value as McpServerResource['authType'] },
                      )
                    }
                  >
                    <option value="none">无鉴权</option>
                    <option value="bearer">Bearer Token</option>
                    <option value="oauth2">OAuth 2.0 Access Token</option>
                  </select>
                </label>
                <label className="wide">
                  Endpoint
                  <input
                    value={editor.endpoint}
                    onChange={event => setEditor(current => current && { ...current, endpoint: event.target.value })}
                    placeholder="https://mcp.example.com/mcp"
                  />
                </label>
                {editor.authType !== 'none' && (
                  <label className="wide">
                    Token 环境变量
                    <input
                      value={editor.credentialEnv}
                      onChange={event =>
                        setEditor(current => current && { ...current, credentialEnv: event.target.value })
                      }
                      placeholder="SMARTHUB_MCP_ISSUES_MCP_TOKEN"
                    />
                    <small>只保存环境变量名称；Token 由部署环境注入，不写入数据库。</small>
                  </label>
                )}
                <label className="wide">
                  允许的远程工具标识（逗号分隔）
                  <input
                    value={editor.toolIds.join(', ')}
                    onChange={event =>
                      setEditor(
                        current =>
                          current && {
                            ...current,
                            toolIds: event.target.value
                              .split(',')
                              .map(item => item.trim())
                              .filter(Boolean),
                          },
                      )
                    }
                    placeholder="issues.list, issues.create"
                  />
                </label>
              </div>
            )}
            {editor.kind === 'skill' && (
              <div className="ai-resource-specific-fields">
                <div className="skill-source-choice wide">
                  <button
                    type="button"
                    className={editor.skillMode === 'zip' ? 'active' : ''}
                    disabled={Boolean(editor.package)}
                    onClick={() => setEditor(current => current && { ...current, skillMode: 'zip' })}
                  >
                    ZIP 包上传
                  </button>
                  <button
                    type="button"
                    className={editor.skillMode === 'entrypoint' ? 'active' : ''}
                    disabled={Boolean(editor.package)}
                    onClick={() => setEditor(current => current && { ...current, skillMode: 'entrypoint' })}
                  >
                    手动入口
                  </button>
                </div>
                {editor.skillMode === 'zip' ? (
                  editor.package ? (
                    <div className="skill-package-summary wide">
                      <b>{editor.package.uploadedFileName}</b>
                      <span>
                        {editor.package.fileCount} 个文件 · {formatBytes(editor.package.unpackedBytes)}
                      </span>
                      <code>SHA-256 {editor.package.contentSha256}</code>
                      <small>{editor.package.entrypointPath}</small>
                    </div>
                  ) : (
                    <label className="skill-zip-picker wide">
                      <span>Skill ZIP 包</span>
                      <input
                        type="file"
                        accept=".zip,application/zip"
                        onChange={event =>
                          setEditor(current => current && { ...current, packageFile: event.target.files?.[0] ?? null })
                        }
                      />
                      <small>
                        {editor.packageFile
                          ? `${editor.packageFile.name} · ${formatBytes(editor.packageFile.size)}`
                          : '最多 20 MB、200 个文件；必须且只能包含一个非空 UTF-8 SKILL.md。'}
                      </small>
                    </label>
                  )
                ) : (
                  <label className="wide">
                    Skill 入口
                    <input
                      value={editor.entrypoint}
                      onChange={event =>
                        setEditor(current => current && { ...current, entrypoint: event.target.value })
                      }
                      placeholder="ai/skills/requirement-analysis/SKILL.md"
                    />
                  </label>
                )}
                <label className="wide">
                  标签（逗号分隔）
                  <input
                    value={editor.tags}
                    onChange={event => setEditor(current => current && { ...current, tags: event.target.value })}
                    placeholder="需求, 分析, 证据"
                  />
                </label>
                <fieldset className="wide">
                  <legend>外部依赖工具</legend>
                  <small>Skill 只声明专业方法；需要执行的独立业务能力必须通过正式 Tool 或 MCP 显式绑定。</small>
                  <div className="ai-tool-options">
                    {catalog?.tools.map(tool => (
                      <label key={tool.id}>
                        <input
                          type="checkbox"
                          checked={editor.toolIds.includes(tool.key)}
                          onChange={event =>
                            setEditor(
                              current =>
                                current && {
                                  ...current,
                                  toolIds: event.target.checked
                                    ? [...current.toolIds, tool.key]
                                    : current.toolIds.filter(id => id !== tool.key),
                                },
                            )
                          }
                        />
                        <span>
                          <b>{tool.name}</b>
                          <small>{tool.key}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
            )}
            {editor.kind === 'tool' && (
              <div className="ai-resource-specific-fields">
                <label>
                  工具来源
                  <select
                    value={editor.source}
                    onChange={event =>
                      setEditor(
                        current =>
                          current && {
                            ...current,
                            source: event.target.value as ToolResource['source'],
                            mcpServerId: event.target.value === 'mcp' ? current.mcpServerId : '',
                            sourcePath: event.target.value === 'local' ? current.sourcePath : '',
                          },
                      )
                    }
                  >
                    <option value="local">本地模块</option>
                    <option value="http">HTTP API</option>
                    <option value="mcp">MCP 服务</option>
                  </select>
                </label>
                <label>
                  风险等级
                  <select
                    value={editor.risk}
                    onChange={event =>
                      setEditor(current => current && { ...current, risk: event.target.value as ToolResource['risk'] })
                    }
                  >
                    <option value="read">只读</option>
                    <option value="network_read">网络只读</option>
                    <option value="code_execution">代码执行</option>
                    <option value="internal_write">SmartHub 内部写入</option>
                    <option value="write_reversible">外部可撤销写入（需审批）</option>
                    <option value="write_high_risk">外部高风险写入（需审批）</option>
                  </select>
                </label>
                <label>
                  超时（毫秒）
                  <input
                    type="number"
                    min="1000"
                    max="300000"
                    step="1000"
                    value={editor.timeoutMs}
                    onChange={event =>
                      setEditor(current => current && { ...current, timeoutMs: Number(event.target.value) })
                    }
                  />
                </label>
                {editor.source === 'local' && (
                  <label className="wide">
                    模块路径
                    <input
                      value={editor.sourcePath}
                      onChange={event =>
                        setEditor(current => current && { ...current, sourcePath: event.target.value })
                      }
                      placeholder="ai/tools/my-tool.js"
                    />
                    <small>
                      模块必须导出 parameters 和 execute(arguments, context, signal)；打包运行优先加载编译后的 JS。
                    </small>
                  </label>
                )}
                {editor.source === 'http' && (
                  <>
                    <label className="wide">
                      HTTP Endpoint
                      <input
                        value={editor.endpoint}
                        onChange={event =>
                          setEditor(current => current && { ...current, endpoint: event.target.value })
                        }
                        placeholder="https://tools.example.com/invoke"
                      />
                    </label>
                    <label>
                      鉴权类型
                      <select
                        value={editor.authType}
                        onChange={event =>
                          setEditor(
                            current =>
                              current && { ...current, authType: event.target.value as McpServerResource['authType'] },
                          )
                        }
                      >
                        <option value="none">无鉴权</option>
                        <option value="bearer">Bearer Token</option>
                      </select>
                    </label>
                    {editor.authType === 'bearer' && (
                      <label>
                        Token 环境变量
                        <input
                          value={editor.credentialEnv}
                          onChange={event =>
                            setEditor(current => current && { ...current, credentialEnv: event.target.value })
                          }
                          placeholder="SMARTHUB_HTTP_TOOL_NAME_TOKEN"
                        />
                      </label>
                    )}
                    <label className="wide">
                      参数 JSON Schema
                      <textarea
                        value={editor.parametersJson}
                        onChange={event =>
                          setEditor(current => current && { ...current, parametersJson: event.target.value })
                        }
                      />
                    </label>
                  </>
                )}
                {editor.source === 'mcp' && (
                  <label>
                    MCP 服务
                    <select
                      value={editor.mcpServerId}
                      onChange={event =>
                        setEditor(current => current && { ...current, mcpServerId: event.target.value })
                      }
                    >
                      <option value="">请选择 MCP 服务</option>
                      {catalog?.mcpServers.map(server => (
                        <option value={server.id} key={server.id}>
                          {server.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}
            <label className="ai-resource-enabled">
              <input
                type="checkbox"
                checked={editor.enabled}
                onChange={event => setEditor(current => current && { ...current, enabled: event.target.checked })}
              />
              保存后立即启用该资源
            </label>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setEditor(null)}>
                取消
              </button>
              <button className="btn primary" disabled={busyId === (editor.id ?? 'new')} onClick={() => void persist()}>
                <Check />
                {busyId ? '保存中…' : '保存资源'}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {sourceViewer && (
        <Modal
          title={`${sourceViewer.toolKey} · 源码`}
          className="tool-source-modal"
          onClose={() => setSourceViewer(null)}
        >
          <div className="tool-source-viewer">
            <header>
              <span>
                <Code2 />
                <b>{sourceViewer.path}</b>
              </span>
              <Badge tone="blue">只读</Badge>
            </header>
            <pre>
              <code>{sourceViewer.content}</code>
            </pre>
          </div>
        </Modal>
      )}
    </section>
  )
}

function CurrentAiResourceIcon({ kind }: { kind: AiResourceKind }) {
  return kind === 'mcp' ? <Server /> : kind === 'skill' ? <Sparkles /> : <ShieldCheck />
}

function ResourceMetadata({ resource, catalog }: { resource: AiResource; catalog: AiResourceCatalog | null }) {
  if (resource.kind === 'mcp')
    return (
      <footer>
        <span>{resource.transport === 'streamable_http' ? 'Streamable HTTP' : 'SSE'}</span>
        <span>
          {resource.authType === 'none' ? '无鉴权' : resource.authType === 'bearer' ? 'Bearer' : 'OAuth 2.0 Token'}
        </span>
        <span>{resource.toolIds.length} 个远程工具</span>
        <span title={resource.endpoint}>{resource.endpoint}</span>
        {resource.credentialEnv && <span>{resource.credentialEnv}</span>}
      </footer>
    )
  if (resource.kind === 'skill')
    return (
      <footer>
        <span>
          {resource.package
            ? `ZIP · ${resource.package.fileCount} 个文件 · ${formatBytes(resource.package.unpackedBytes)}`
            : '手动入口'}
        </span>
        <span>{resource.toolIds.length} 个外部依赖工具</span>
        <span>{skillRuntimeSummary(resource)}</span>
        <span>{resource.tags.join(' · ') || '未设置标签'}</span>
        <span title={resource.package?.contentSha256 ?? resource.entrypoint}>
          {resource.package ? `SHA-256 ${resource.package.contentSha256.slice(0, 12)}…` : resource.entrypoint}
        </span>
      </footer>
    )
  const mcp = resource.mcpServerId ? catalog?.mcpServers.find(server => server.id === resource.mcpServerId) : null
  return (
    <footer>
      <span>
        {resource.source === 'builtin'
          ? '内置'
          : resource.source === 'local'
            ? '本地'
            : resource.source === 'http'
              ? 'HTTP'
              : `MCP · ${mcp?.name ?? '未解析'}`}
      </span>
      <span>
        {resource.risk === 'read'
          ? '只读'
          : resource.risk === 'network_read'
            ? '网络只读'
            : resource.risk === 'code_execution'
              ? '代码执行'
              : resource.risk === 'internal_write'
                ? 'SmartHub 内部写入'
                : resource.risk === 'write_reversible'
                  ? '外部可撤销写入 · 需审批'
                  : '外部高风险写入 · 需审批'}
      </span>
      <span>{(resource.timeoutMs / 1000).toLocaleString()} 秒超时</span>
      {resource.sourcePath && <span title={resource.sourcePath}>{resource.sourcePath}</span>}
      {resource.endpoint && <span title={resource.endpoint}>{resource.endpoint}</span>}
    </footer>
  )
}
