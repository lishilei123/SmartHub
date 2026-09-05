import { type ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { type SkillResource } from '../ai-resource-api'

export function AgentConfigurationLoading() {
  return (
    <div className="page-loading" role="status">
      <RefreshCw />
      <span>正在读取服务端 Agent 配置…</span>
    </div>
  )
}

export function AgentConfigurationFailure({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <div className="agent-configuration-status failed" role="alert">
      <AlertTriangle />
      <div>
        <b>Agent 配置读取失败</b>
        <span>{error ?? '请确认服务端已启动后重新加载。'}</span>
      </div>
      <button className="btn ghost" onClick={onRetry}>
        <RefreshCw />
        重新加载
      </button>
    </div>
  )
}

export function agentSkillSummary(skill: SkillResource) {
  const capabilities = skillRuntimeSummary(skill)
  return [
    skill.toolIds.length ? `外部依赖：${skill.toolIds.join('、')}` : '',
    capabilities,
    '发布后进入 Catalog，正文按需读取',
  ]
    .filter(Boolean)
    .join(' · ')
}

export function skillRuntimeSummary(skill: SkillResource) {
  const items = [
    ...(skill.runtime?.scripts.length ? [`${skill.runtime.scripts.length} 个受控 PowerShell 脚本`] : []),
    ...(skill.runtime?.network ? [`联网：${skill.runtime.network.allowedOrigins.length} 个 Origin`] : []),
  ]
  return items.length ? items.join('；') : '无脚本或联网权限'
}

export function formatBytes(value: number) {
  return value < 1024
    ? `${value} B`
    : value < 1024 * 1024
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / 1024 / 1024).toFixed(1)} MB`
}

export function ModelPanelHead({ title, desc, children }: { title: string; desc: string; children?: ReactNode }) {
  return (
    <div className="model-panel-head">
      <div>
        <h3>{title}</h3>
        <p>{desc}</p>
      </div>
      {children}
    </div>
  )
}

export function FormSection({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="form-section">
      <div className="form-section-title">
        <h3>{title}</h3>
        {desc && <p>{desc}</p>}
      </div>
      <div>{children}</div>
    </section>
  )
}

export function FormRow({ label, help, children }: { label: string; help: string; children: ReactNode }) {
  return (
    <label className="form-row">
      <span>
        <b>{label}</b>
        <small>{help}</small>
      </span>
      <div>{children}</div>
    </label>
  )
}

export function SwitchRow({
  title,
  desc,
  checked,
  onChange,
}: {
  title: string
  desc: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className="form-row">
      <span>
        <b>{title}</b>
        <small>{desc}</small>
      </span>
      <label className="switch">
        <input
          type="checkbox"
          checked={checked}
          onChange={event => onChange(event.target.checked)}
          aria-label={title}
        />
        <i />
      </label>
    </div>
  )
}
