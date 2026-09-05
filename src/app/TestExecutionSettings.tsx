import { useCallback, useEffect, useState } from 'react'
import {
  RUNNER_CONCURRENCY_RANGE,
  AGENT_CONCURRENCY_RANGE,
  DEFAULT_RUNNER_CONCURRENCY,
  DEFAULT_AGENT_CONCURRENCY,
  type ExecutionConcurrencyConfiguration,
} from '../../server/domain/test-execution-infrastructure-configuration'
import {
  loadExecutionInfrastructureConfiguration,
  saveExecutionInfrastructureDraft,
  publishExecutionInfrastructureDraft,
  type ExecutionInfrastructureState,
} from '../test-execution-infrastructure-api'
import { FormSection, FormRow } from './settings-shared'
import type { Notify } from './types'

export function TestExecutionSettings({ notify, addAudit }: { notify: Notify; addAudit: (entry: string) => void }) {
  const [state, setState] = useState<ExecutionInfrastructureState | null>(null)
  const [values, setValues] = useState<ExecutionConcurrencyConfiguration | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    const next = await loadExecutionInfrastructureConfiguration()
    setState(next)
    setValues(editableConcurrency(next))
    setError(null)
    return next
  }, [])
  useEffect(() => {
    void refresh().catch(reason => setError(String(reason.message ?? reason)))
  }, [refresh])
  const dirty = state !== null && JSON.stringify(values) !== JSON.stringify(editableConcurrency(state))
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  if (!state || !values)
    return (
      <div className="settings-form">
        <p role={error ? 'alert' : 'status'}>{error ?? '正在读取测试执行配置…'}</p>
        {error && (
          <button className="btn" onClick={() => void refresh().catch(reason => setError(reason.message))}>
            重新读取
          </button>
        )}
      </div>
    )
  const effective = state.effectiveConcurrency
  const valid =
    Number.isInteger(values.runnerConcurrency) &&
    values.runnerConcurrency >= RUNNER_CONCURRENCY_RANGE.min &&
    values.runnerConcurrency <= RUNNER_CONCURRENCY_RANGE.max &&
    Number.isInteger(values.agentConcurrency) &&
    values.agentConcurrency >= AGENT_CONCURRENCY_RANGE.min &&
    values.agentConcurrency <= AGENT_CONCURRENCY_RANGE.max
  const operation = async (publish: boolean) => {
    setBusy(true)
    setError(null)
    try {
      if (publish) {
        if (!state.draft || dirty) throw new Error('请先保存当前草稿。')
        const version = await publishExecutionInfrastructureDraft({
          revision: state.draft.revision,
          expectedActiveVersion: state.activeVersion?.version ?? null,
        })
        addAudit(`发布测试执行配置 V${version.version}`)
        notify(
          `测试执行配置 V${version.version} 已发布，供调度器读取；正常情况下约 5 秒刷新，尚不代表所有 Worker 已应用。`,
        )
      } else {
        const base = state.draft ?? state.activeVersion
        await saveExecutionInfrastructureDraft({
          expectedActiveVersion: state.activeVersion?.version ?? null,
          expectedDraftRevision: state.draft?.revision ?? null,
          environments: base?.environments ?? [],
          ...(base?.runner ? { runner: base.runner } : {}),
          concurrency: values,
        })
        addAudit('保存测试执行并发配置草稿')
        notify('草稿已保存，发布后才影响调度。')
      }
      await refresh()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '测试执行配置操作失败'
      setError(message)
      notify(message, 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="settings-form">
      <FormSection
        title="已发布配置与兼容回退"
        desc="展示后端解析的已发布配置或兼容回退值，不代表所有 Worker 已确认应用；下方输入框编辑的是草稿。"
      >
        <FormRow label="供调度器读取的值" help="">
          <span>
            Runner {effective.runnerConcurrency} · AI 任务 {effective.agentConcurrency}
          </span>
        </FormRow>
        <FormRow label="当前配置来源" help="">
          <span>
            {effective.source === 'published_configuration'
              ? '已发布配置'
              : effective.source === 'legacy_environment'
                ? '旧环境变量兼容配置'
                : effective.source === 'historical_defaults'
                  ? '历史发布版本缺少并发字段，使用代码默认值'
                  : '代码默认值'}
          </span>
        </FormRow>
        <FormRow label="已发布配置版本" help="">
          <span>{effective.version === null ? '尚未发布' : `V${effective.version}`}</span>
        </FormRow>
        <FormRow label="最近发布时间" help="">
          <span>{effective.publishedAt ? new Date(effective.publishedAt).toLocaleString() : '—'}</span>
        </FormRow>
        <FormRow label="最近发布人" help="">
          <span>{effective.publishedBy ?? '—'}</span>
        </FormRow>
      </FormSection>
      <FormSection
        title="AI 与 Runner 资源并发"
        desc={`草稿配置${state.draft ? ` · 修订 ${state.draft.revision} · ${state.draft.updatedBy}` : ' · 尚未保存'}${dirty ? ' · 有未保存更改' : ''}`}
      >
        <FormRow
          label="Runner 最大并发数"
          help="控制真实 Playwright 执行及受管认证准备浏览器的并发数，与 AI 配额独立。"
        >
          <input
            aria-label="Runner 最大并发数"
            type="number"
            min={RUNNER_CONCURRENCY_RANGE.min}
            max={RUNNER_CONCURRENCY_RANGE.max}
            step={1}
            value={values.runnerConcurrency}
            disabled={busy}
            onChange={event => setValues(value => ({ ...value!, runnerConcurrency: Number(event.target.value) }))}
          />
        </FormRow>
        <FormRow label="AI 任务最大并发数" help="同一进程中接入共享配额的 AI 操作共用容量，不同类型任务可能互相等待。">
          <input
            aria-label="AI 任务最大并发数"
            type="number"
            min={AGENT_CONCURRENCY_RANGE.min}
            max={AGENT_CONCURRENCY_RANGE.max}
            step={1}
            value={values.agentConcurrency}
            disabled={busy}
            onChange={event => setValues(value => ({ ...value!, agentConcurrency: Number(event.target.value) }))}
          />
        </FormRow>
        <p className="readonly-notice">
          Runner 默认 {DEFAULT_RUNNER_CONCURRENCY}，范围 {RUNNER_CONCURRENCY_RANGE.min}～{RUNNER_CONCURRENCY_RANGE.max}
          ； AI 默认 {DEFAULT_AGENT_CONCURRENCY}，范围 {AGENT_CONCURRENCY_RANGE.min}～{AGENT_CONCURRENCY_RANGE.max}
          。AI 配额覆盖脚本生成、受控页面探索、脚本修复、失败诊断，以及需求分析、测试设计、评审与会话压缩、知识库
          Embedding/Reranker 模型调用与配置测试、模型探测。
          配额限制受管操作的并发数，不等同于模型服务商的请求速率限制；确定性 Binding、Hash、依赖与环境检查不占 AI 配额。
        </p>
        <p className="readonly-notice">
          保存草稿不生效，发布后供调度器读取。Worker 正常情况下约 5 秒刷新；实际资源入口按需读取，间隔至少 5
          秒，读取失败保留最近有效值。 调低配额不强制终止已经运行的任务，后续申请按新上限授予。
        </p>
        <p className="readonly-notice">
          数据库明确发布的并发配置优先。没有明确发布值时，旧 SMARTHUB_TEST_EXECUTION_CONCURRENCY 仅兼容映射
          Runner（1～8），无效时使用后端默认值；AI 默认 1。 不提供 SMARTHUB_RUNNER_CONCURRENCY 或
          SMARTHUB_AGENT_CONCURRENCY 环境变量。
        </p>
        <p className="readonly-notice">
          单进程配额：只在当前进程内共享，不是整个部署的集群全局限制。每个 Worker 进程拥有独立配额，总容量会叠加；API 与
          Worker 分进程时也不共享内存配额。 跨 Worker 全局配额及跨进程 Workspace 互斥尚未实现，同一 Workspace 应由一个
          Worker 进程管理。
        </p>
        {!valid && <p role="alert">并发数必须是范围内的整数。</p>}
        {error && <p role="alert">{error}</p>}
        <div className="execution-infrastructure-actions">
          <button
            className="btn"
            disabled={busy || !valid || (!dirty && !!state.draft)}
            onClick={() => void operation(false)}
          >
            保存草稿
          </button>
          <button
            className="btn primary"
            disabled={busy || !state.draft || dirty || !valid}
            onClick={() => void operation(true)}
          >
            发布配置
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={() => void refresh().catch(reason => setError(reason.message))}
          >
            重新读取
          </button>
        </div>
      </FormSection>
    </div>
  )
}

function editableConcurrency(state: ExecutionInfrastructureState): ExecutionConcurrencyConfiguration {
  const { runnerConcurrency, agentConcurrency } = state.draft?.concurrency ?? state.effectiveConcurrency
  return { runnerConcurrency, agentConcurrency }
}
