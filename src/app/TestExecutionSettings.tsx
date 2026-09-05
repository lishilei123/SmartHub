import { useCallback, useEffect, useState } from 'react'
import {
  RUNNER_CONCURRENCY_RANGE,
  AGENT_CONCURRENCY_RANGE,
  normalizeExecutionConcurrency,
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
  const [values, setValues] = useState(normalizeExecutionConcurrency())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    const next = await loadExecutionInfrastructureConfiguration()
    setState(next)
    setValues(next.draft?.concurrency ?? normalizeExecutionConcurrency(next.activeVersion?.concurrency))
    setError(null)
    return next
  }, [])
  useEffect(() => {
    void refresh().catch(reason => setError(String(reason.message ?? reason)))
  }, [refresh])
  const dirty =
    JSON.stringify(values) !==
    JSON.stringify(state?.draft?.concurrency ?? normalizeExecutionConcurrency(state?.activeVersion?.concurrency))
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
  if (!state)
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
        notify(`测试执行配置 V${version.version} 已发布，Worker 将在下一次配置轮询时生效。`)
      } else {
        const base = state.activeVersion
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
      <FormSection title="当前生效配置" desc="Worker 读取已发布配置；没有发布配置时使用统一代码默认值。">
        <FormRow label="当前生效值" help="">
          <span>
            Runner {effective.runnerConcurrency} · Agent {effective.agentConcurrency}
          </span>
        </FormRow>
        <FormRow label="当前配置来源" help="">
          <span>
            {effective.source === 'published_configuration'
              ? '已发布配置'
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
        title="并发控制"
        desc={`草稿配置${state.draft ? ` · 修订 ${state.draft.revision} · ${state.draft.updatedBy}` : ' · 尚未保存'}${dirty ? ' · 有未保存更改' : ''}`}
      >
        <FormRow label="Runner 最大并发数" help="控制同时真实执行的 Playwright 任务数。">
          <input
            aria-label="Runner 最大并发数"
            type="number"
            min={RUNNER_CONCURRENCY_RANGE.min}
            max={RUNNER_CONCURRENCY_RANGE.max}
            step={1}
            value={values.runnerConcurrency}
            disabled={busy}
            onChange={event => setValues(value => ({ ...value, runnerConcurrency: Number(event.target.value) }))}
          />
        </FormRow>
        <FormRow label="Agent 最大并发数" help="控制脚本生成、页面探索、脚本修复和失败分析的并发数。">
          <input
            aria-label="Agent 最大并发数"
            type="number"
            min={AGENT_CONCURRENCY_RANGE.min}
            max={AGENT_CONCURRENCY_RANGE.max}
            step={1}
            value={values.agentConcurrency}
            disabled={busy}
            onChange={event => setValues(value => ({ ...value, agentConcurrency: Number(event.target.value) }))}
          />
        </FormRow>
        <p className="readonly-notice">
          Runner 范围 {RUNNER_CONCURRENCY_RANGE.min}～{RUNNER_CONCURRENCY_RANGE.max}，Agent 范围{' '}
          {AGENT_CONCURRENCY_RANGE.min}～{AGENT_CONCURRENCY_RANGE.max}
          。调低并发不会终止已经开始的任务；调高并发后允许调度更多新任务。并发配置只影响调度速度，不影响测试结果和业务事实。
        </p>
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
