import {
  Bot,
  Box,
  CheckCircle2,
  Clock3,
  Database,
  Globe2,
  Play,
  RefreshCw,
  Server,
  ShieldAlert,
  Square,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type {
  CaseMaintenanceProposal,
  ExecutionEnvironment,
  ExecutionHandoff,
  ExecutionReadiness,
  ExecutionRun,
  ExecutionTestDataBinding,
  Versioned,
} from './types'

export function ExecutionRunPanel({
  readiness,
  environments,
  handoffs,
  runs,
  run,
  maintenanceProposals,
  maintenanceFilter,
  busy,
  loading,
  onRefresh,
  onCreate,
  onOpen,
  onCancel,
  onToggleMaintenanceFilter,
}: {
  readiness: ExecutionReadiness | null
  environments: ExecutionEnvironment[]
  handoffs: ExecutionHandoff[]
  runs: ExecutionRun[]
  run: Versioned<ExecutionRun> | null
  maintenanceProposals: CaseMaintenanceProposal[]
  maintenanceFilter: boolean
  busy: string
  loading: boolean
  onRefresh: () => Promise<void>
  onCreate: (handoffId: string, environmentId: string, testDataBindings: ExecutionTestDataBinding[]) => Promise<ExecutionRun | undefined>
  onOpen: (runId: string) => Promise<ExecutionRun | undefined>
  onCancel: () => Promise<void>
  onToggleMaintenanceFilter: () => void
}) {
  const [handoffId, setHandoffId] = useState('')
  const [environmentId, setEnvironmentId] = useState('')
  const [testDataDrafts, setTestDataDrafts] = useState<Record<string, {
    sourceType: ExecutionTestDataBinding['sourceType']
    sourceRef: string
    preparationNote: string
  }>>({})
  useEffect(() => {
    setHandoffId(current => handoffs.some(item => item.id === current)
      ? current
      : handoffs[0]?.id ?? '')
  }, [handoffs])
  useEffect(() => {
    setEnvironmentId(current => environments.some(item => item.environmentId === current)
      ? current
      : environments[0]?.environmentId ?? '')
  }, [environments])
  const handoff = handoffs.find(item => item.id === handoffId)
  const dataRequirements = useMemo(() => handoff?.testDataSnapshot?.requirements ?? [], [handoff])
  useEffect(() => {
    setTestDataDrafts(Object.fromEntries(dataRequirements.map(requirement => [requirement.id, {
      sourceType: 'fixture' as const,
      sourceRef: '',
      preparationNote: '',
    }])))
  }, [handoffId, dataRequirements])
  const testDataBindings = useMemo<ExecutionTestDataBinding[]>(() => dataRequirements.map(requirement => {
    const draft = testDataDrafts[requirement.id] ?? { sourceType: 'fixture' as const, sourceRef: '', preparationNote: '' }
    return {
      requirementId: requirement.id,
      sourceType: draft.sourceType,
      sourceRef: draft.sourceRef.trim(),
      ...(draft.preparationNote.trim() ? { preparationNote: draft.preparationNote.trim() } : {}),
    }
  }), [dataRequirements, testDataDrafts])
  const missingDataBindingCount = testDataBindings.filter(binding => !binding.sourceRef).length
  const pendingMaintenanceCount = maintenanceProposals.filter(item => item.status === 'pending').length
  const counts = useMemo(() => handoff?.members.reduce((result, member) => {
    if (member.method === 'ui') result.ui += 1
    else if (member.method === 'api') result.api += 1
    else result.unsupported += 1
    return result
  }, { ui: 0, api: 0, unsupported: 0 }) ?? { ui: 0, api: 0, unsupported: 0 }, [handoff])

  return <div className="te-run-column">
    <section className="te-card te-readiness">
      <header><div><h2>执行就绪状态</h2><p>生产执行要求正式存储、不可变 Artifact、三个独立 Agent 与 OCI Runner 全部就绪。</p></div><button className="te-icon-button" disabled={loading} onClick={() => void onRefresh()} aria-label="刷新执行就绪状态"><RefreshCw /></button></header>
      <div className="te-readiness-grid">
        <ReadinessItem icon={<Database />} label="PostgreSQL" ready={readiness?.store.ready} reason={readiness?.store.reason} />
        <ReadinessItem icon={<Box />} label="Artifact Store" ready={readiness?.artifactStore.ready} reason={readiness?.artifactStore.reason} />
        <ReadinessItem icon={<Globe2 />} label="执行环境" ready={readiness?.environment.ready} reason={readiness?.environment.reason} />
        <ReadinessItem icon={<Bot />} label="执行 Agents" ready={readiness?.agents.ready} reason={readiness?.agents.agents.filter(item => !item.ready).map(item => item.reason ?? item.agentKey).join('；')} />
        <ReadinessItem icon={<Server />} label="OCI Runner" ready={readiness?.runner.ready} reason={readiness?.runner.reason} />
      </div>
      {readiness && <span className={`te-status-pill ${readiness.ready ? 'passed' : 'blocked'}`}>{readiness.ready ? '可以创建真实执行' : 'Runner unavailable / Agent not ready'}</span>}
    </section>

    <section className="te-card te-create-card">
      <header><div><h2>创建测试执行</h2><p>用例与数据需求来自不可变 Handoff；这里仅绑定本次 Run 的受控数据供给。</p></div></header>
      <label>Execution Handoff<select value={handoffId} onChange={event => setHandoffId(event.target.value)}><option value="">选择不可变 Handoff</option>{handoffs.map(item => <option key={item.id} value={item.id}>{item.mode} · {item.members.length} 个成员 · {shortId(item.id)}</option>)}</select></label>
      <label>执行环境<select value={environmentId} onChange={event => setEnvironmentId(event.target.value)}><option value="">选择服务端环境</option>{environments.map(item => <option key={item.environmentId} value={item.environmentId}>{item.name} · {item.baseUrl}</option>)}</select></label>
      {handoff && <div className="te-handoff-preview">
        <div><span>模式</span><b>{handoff.mode}</b></div><div><span>UI</span><b>{counts.ui}</b></div><div><span>API</span><b>{counts.api}</b></div><div><span>Unsupported</span><b>{counts.unsupported}</b></div>
        <code title={handoff.contentSha256}>{handoff.contentSha256}</code>
      </div>}
      {handoff && <section className="te-test-data-supply">
        <header><div><Database /><span><b>测试数据供给</b><small>定义保留在正式版本中，创建 Run 时才绑定实际来源。</small></span></div><em>{dataRequirements.length} 项</em></header>
        {dataRequirements.map(requirement => {
          const draft = testDataDrafts[requirement.id] ?? { sourceType: 'fixture' as const, sourceRef: '', preparationNote: '' }
          return <article key={requirement.id}>
            <div className="te-test-data-heading"><span><b>{requirement.name}</b><small>{requirement.entityType} · {requirement.quantity} 条 · {testDataReadinessLabel(requirement.readiness)}</small></span><code>{shortId(requirement.id)}</code></div>
            <p>{requirement.initialState}{requirement.readinessReason ? ` · ${requirement.readinessReason}` : ''}</p>
            <div className="te-test-data-controls">
              <label>供给方式<select value={draft.sourceType} onChange={event => updateTestDataDraft(setTestDataDrafts, requirement.id, { sourceType: event.target.value as ExecutionTestDataBinding['sourceType'] })}><option value="fixture">固定 Fixture</option><option value="generator">数据生成器</option><option value="data_reference">受控数据引用</option></select></label>
              <label>来源引用<input value={draft.sourceRef} onChange={event => updateTestDataDraft(setTestDataDrafts, requirement.id, { sourceRef: event.target.value })} placeholder={testDataReferencePlaceholder(draft.sourceType)} /></label>
              <label className="wide">准备说明（可选）<input value={draft.preparationNote} onChange={event => updateTestDataDraft(setTestDataDrafts, requirement.id, { preparationNote: event.target.value })} placeholder={requirement.preparationHint || '仅填写准备方式，不填写真实账号、密码或个人数据'} /></label>
            </div>
          </article>
        })}
        {!dataRequirements.length && <p className="te-test-data-empty">当前 Handoff 的用例不需要额外测试数据。</p>}
        {dataRequirements.length > 0 && <p className="te-test-data-policy"><ShieldAlert />只保存 Fixture、生成器或数据资产引用；真实凭据与敏感值必须由受控运行环境解析。</p>}
      </section>}
      {!handoffs.length && !loading && <p className="te-empty-note"><ShieldAlert />当前项目版本没有可执行 Handoff，请先在测试设计中发布正式用例库与交接。</p>}
      <button className="te-primary" disabled={!readiness?.ready || !handoffId || !environmentId || missingDataBindingCount > 0 || Boolean(busy)} onClick={() => void onCreate(handoffId, environmentId, testDataBindings)}><Play />{busy === 'create' ? '正在冻结执行输入…' : missingDataBindingCount > 0 ? `还需绑定 ${missingDataBindingCount} 项数据` : '创建执行 Run'}</button>
    </section>

    <section className="te-card te-run-history">
      <header><div><h2>执行历史</h2><p>只展示 PostgreSQL 中的正式 Run。</p></div><span>{runs.length}</span></header>
      <div className="te-run-list">
        {runs.map(item => <button key={item.id} className={run?.value.id === item.id ? 'active' : ''} onClick={() => void onOpen(item.id)}>
          <StatusMark status={item.status} /><span><b>{item.handoff.mode} · {item.taskCount} Tasks</b><small>{new Date(item.createdAt).toLocaleString('zh-CN')}</small><code>{shortId(item.id)}</code></span><em className={`te-status-pill ${item.status}`}>{runStatusLabel(item.status)}</em>
        </button>)}
        {!runs.length && !loading && <p className="te-empty">暂无执行历史</p>}
      </div>
    </section>

    {run && <section className="te-card te-maintenance-summary">
      <header><div><h2>用例维护</h2><p>当前 Run 的建议只确认是否需要人工维护，不自动修改正式用例。</p></div><button className={maintenanceFilter ? 'te-primary' : 'te-secondary'} onClick={onToggleMaintenanceFilter}>待确认 {pendingMaintenanceCount}</button></header>
      <div className="te-task-metrics"><Metric label="全部建议" value={maintenanceProposals.length} /><Metric label="待确认" value={pendingMaintenanceCount} /><Metric label="已确认" value={maintenanceProposals.filter(item => item.status === 'accepted').length} /><Metric label="已拒绝" value={maintenanceProposals.filter(item => item.status === 'rejected').length} /></div>
    </section>}

    {run && <section className="te-card te-run-snapshot">
      <header><div><h2>Run 冻结快照</h2><p>开始后不再解析 latest、current 或 active。</p></div>{['queued', 'running'].includes(run.value.status) && <button className="te-danger" disabled={Boolean(busy) || Boolean(run.value.cancelRequestedAt)} onClick={() => void onCancel()}><Square />{run.value.cancelRequestedAt ? '已请求取消' : busy === 'cancel' ? '正在取消…' : '取消 Run'}</button>}</header>
      <dl>
        <div><dt>Handoff</dt><dd>{shortId(run.value.handoff.handoffId)} · {run.value.handoff.mode}</dd></div>
        <div><dt>Library</dt><dd title={run.value.handoff.testCaseLibraryVersionSha256}>{shortId(run.value.handoff.testCaseLibraryVersionId)}</dd></div>
        <div><dt>Environment</dt><dd>{run.value.environment.name} · {shortId(run.value.environment.signature)}</dd></div>
        <div><dt>Test data</dt><dd>{run.value.testData ? `需求 V${run.value.testData.sourceSetVersion} · ${run.value.testData.bindings.length} 项供给 · ${shortId(run.value.testData.contentSha256)}` : '无额外数据需求'}</dd></div>
        <div><dt>Runner</dt><dd>{run.value.runner.runnerVersion} · Playwright {run.value.runner.playwrightVersion}</dd></div>
        <div><dt>Image</dt><dd title={`${run.value.runner.imageReference}@${run.value.runner.imageDigest}`}>{run.value.runner.imageReference} · {shortId(run.value.runner.imageDigest)}</dd></div>
        <div><dt>Agent snapshots</dt><dd>{Object.values(run.value.agents).map(agent => `${agent.agentKey} v${agent.configurationVersion}`).join(' · ')}</dd></div>
      </dl>
    </section>}
  </div>
}

function updateTestDataDraft(
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, { sourceType: ExecutionTestDataBinding['sourceType']; sourceRef: string; preparationNote: string }>>>,
  requirementId: string,
  patch: Partial<{ sourceType: ExecutionTestDataBinding['sourceType']; sourceRef: string; preparationNote: string }>,
) {
  setDrafts(current => {
    const existing = current[requirementId]
    return {
      ...current,
      [requirementId]: {
        sourceType: existing?.sourceType ?? 'fixture',
        sourceRef: existing?.sourceRef ?? '',
        preparationNote: existing?.preparationNote ?? '',
        ...patch,
      },
    }
  })
}

function testDataReferencePlaceholder(sourceType: ExecutionTestDataBinding['sourceType']) {
  if (sourceType === 'generator') return 'generator://project/customer-seed/v2'
  if (sourceType === 'data_reference') return 'data://project-version/asset/version'
  return 'fixture://project/login-users/v3'
}

function testDataReadinessLabel(readiness: 'ready' | 'needs_confirmation' | 'blocked') {
  return ({ ready: '定义就绪', needs_confirmation: '需在执行前确认', blocked: '定义受阻' })[readiness]
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div><span>{label}</span><b>{value}</b></div>
}

function ReadinessItem({ icon, label, ready, reason }: { icon: React.ReactNode; label: string; ready?: boolean; reason?: string }) {
  return <div className={ready ? 'ready' : 'unavailable'}>{icon}<span><b>{label}</b><small title={reason}>{ready ? 'Ready' : reason ?? '正在检查'}</small></span>{ready ? <CheckCircle2 /> : <ShieldAlert />}</div>
}

function StatusMark({ status }: { status: ExecutionRun['status'] }) {
  return status === 'succeeded' ? <CheckCircle2 /> : status === 'queued' || status === 'running' ? <Clock3 /> : <ShieldAlert />
}

export function runStatusLabel(status: ExecutionRun['status']) {
  return ({ queued: '排队中', running: '执行中', succeeded: '成功', failed: '失败', partial: '部分完成', cancelled: '已取消' })[status]
}

export function shortId(value: string) {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value
}
