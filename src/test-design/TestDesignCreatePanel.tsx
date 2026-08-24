import { useMemo, useState } from 'react'
import { Bot, CheckCircle2, Database, LockKeyhole, Play, XCircle } from 'lucide-react'
import type { CreateTestDesignInput, ExecutionMethod, TestDesignInputCandidates, TestDimension } from './types'

const dimensions: Array<{ key: TestDimension; label: string }> = [
  { key: 'functional', label: '功能' }, { key: 'performance', label: '性能' }, { key: 'stability', label: '稳定性' }, { key: 'compatibility', label: '兼容性' }, { key: 'security', label: '安全' },
]

export function TestDesignCreatePanel({ inputs, busy, onCreate, onCancel }: { inputs: TestDesignInputCandidates; busy: boolean; onCreate: (input: CreateTestDesignInput) => Promise<void> | void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [objective, setObjective] = useState('')
  const [included, setIncluded] = useState('')
  const [excluded, setExcluded] = useState('')
  const [selectedDimensions, setSelectedDimensions] = useState<TestDimension[]>(['functional', 'performance', 'stability', 'compatibility', 'security'])
  const [methods, setMethods] = useState<ExecutionMethod[]>(['agent'])
  const [knowledgeAssets, setKnowledgeAssets] = useState<string[]>([])
  const releases = inputs.requirementReleases.length ? inputs.requirementReleases : inputs.requirementRelease ? [{ ...inputs.requirementRelease, active: true }] : []
  const [requirementReleaseId, setRequirementReleaseId] = useState(() => inputs.requirementRelease?.id ?? '')
  const selectedRelease = releases.find(item => item.id === requirementReleaseId) ?? releases.find(item => item.active) ?? releases[0]
  const blockers = useMemo(() => [!selectedRelease ? '当前 ProjectVersion 未绑定正式 Requirement Release' : '', !inputs.agentReadiness.ready ? 'PlanningAgent 尚未就绪' : '', !name.trim() ? '填写任务名称' : '', !objective.trim() ? '填写测试目标' : '', !selectedDimensions.length ? '至少选择一个测试维度' : '', !methods.length ? '至少选择一个执行入口' : ''].filter(Boolean), [inputs.agentReadiness.ready, methods, name, objective, selectedDimensions, selectedRelease])
  const toggle = <T extends string>(value: T, values: T[], setter: (next: T[]) => void) => setter(values.includes(value) ? values.filter(item => item !== value) : [...values, value])
  const submit = () => onCreate({
    name: name.trim(), objective: objective.trim(), requirementReleaseId: selectedRelease?.id,
    includedScopes: lines(included).map(value => ({ kind: 'scope', value })),
    excludedScopes: lines(excluded).map(value => ({ kind: 'scope', value })),
    focusDimensions: selectedDimensions, executionMethods: methods,
    knowledgeAugmentation: knowledgeAssets.length ? { mode: 'selected_assets', assetVersionIds: knowledgeAssets } : { mode: 'disabled' },
  })

  return <section className="td2-create td2-card">
    <header><div><span className="td2-icon"><Play /></span><div><p className="td2-kicker">创建测试设计</p><h2>固定目标与输入边界</h2><p>运行开始时由服务端冻结所选 Requirement Release、Agent 配置和 Workspace 快照。</p></div></div><button className="td2-button ghost" onClick={onCancel}>取消</button></header>
    <div className="td2-release-lock">
      <LockKeyhole />
      {selectedRelease ? <div><b>{selectedRelease.label}</b>{releases.length > 1 && <select aria-label="测试设计 Requirement Release" value={selectedRelease.id} onChange={event => setRequirementReleaseId(event.target.value)}>{releases.map(item => <option key={item.id} value={item.id}>{item.active ? '当前默认 · ' : ''}{item.label}</option>)}</select>}<small>releaseId {selectedRelease.id} · verificationRunId {selectedRelease.analysisRunId}</small><code>{selectedRelease.contentSha256}</code></div> : <div><b>未绑定 Requirement Release</b><small>请先在当前 ProjectVersion 发布正式需求包。</small></div>}
      {selectedRelease ? <CheckCircle2 /> : <XCircle />}
    </div>
    <div className="td2-form-grid">
      <label><span>任务名称</span><input value={name} onChange={event => setName(event.target.value)} placeholder="例如：订单结算测试设计" /></label>
      <label className="wide"><span>测试目标</span><textarea value={objective} onChange={event => setObjective(event.target.value)} placeholder="说明这次测试要验证什么，以及成功标准。" /></label>
      <label><span>纳入范围（每行一项）</span><textarea value={included} onChange={event => setIncluded(event.target.value)} placeholder="创建订单&#10;支付回调" /></label>
      <label><span>排除范围（每行一项）</span><textarea value={excluded} onChange={event => setExcluded(event.target.value)} placeholder="线下退款&#10;旧版客户端" /></label>
    </div>
    <div className="td2-choice-row"><div><b>测试维度</b><small>非功能维度只在 Workspace 有依据且适用时生成。</small></div><div>{dimensions.map(item => <button key={item.key} className={selectedDimensions.includes(item.key) ? 'active' : ''} onClick={() => toggle(item.key, selectedDimensions, setSelectedDimensions)}>{item.label}</button>)}</div></div>
    <div className="td2-choice-row"><div><b>执行入口</b><small>当前主链为 Evidence-driven Agent Test；UI/API 仅保留历史兼容。</small></div><div>{(['agent'] as const).map(item => <button key={item} className={methods.includes(item) ? 'active' : ''} onClick={() => toggle(item, methods, setMethods)}>{item.toUpperCase()}</button>)}</div></div>
    <div className="td2-history-source"><div><b>历史用例</b><small>该基线由 ProjectVersion 的显式继承关系自动确定，TestDesign 不再单独选择来源。</small></div>{inputs.historicalBaseline.status === 'source_library_available' ? <article className="td2-inherited-library"><b>来源版本：{inputs.historicalBaseline.sourceProjectVersionName}</b><small>继承用例库：正式用例库 V{inputs.historicalBaseline.testCaseLibraryVersion.version} · {inputs.historicalBaseline.testCaseLibraryVersion.name} · {inputs.historicalBaseline.testCaseLibraryVersion.memberCount} 条</small><small>该基线由版本继承关系自动确定。</small></article> : inputs.historicalBaseline.status === 'source_library_missing' ? <article className="td2-inherited-library"><b>来源版本：{inputs.historicalBaseline.sourceProjectVersionName}</b><small>来源版本暂无正式测试用例库，本次将按无历史基线生成。</small></article> : <article className="td2-inherited-library"><b>未启用版本继承</b><small>当前版本未继承来源版本，本次测试设计不加载历史用例。</small></article>}</div>
    <details className="td2-optional"><summary><Database />可选增强上下文 <small>{knowledgeAssets.length ? `已选择 ${knowledgeAssets.length} 份` : '默认不启用'}</small></summary><div>{inputs.knowledgeAssets.filter(item => item.selectable).map(item => <label key={item.assetVersionId}><input type="checkbox" checked={knowledgeAssets.includes(item.assetVersionId)} onChange={() => toggle(item.assetVersionId, knowledgeAssets, setKnowledgeAssets)} /><span><b>{item.displayName}</b><small>{item.logicalPath}</small></span></label>)}</div></details>
    <footer><div className={inputs.agentReadiness.ready ? 'td2-agent-ready' : 'td2-agent-ready danger'}><Bot /><span><b>PlanningAgent</b><small>{inputs.agentReadiness.ready ? '统一配置、模型与 Enabled Skills 已就绪' : inputs.agentReadiness.agents[0]?.reason ?? '未就绪'}</small></span></div><button className="td2-button primary" disabled={busy || blockers.length > 0} onClick={submit}>{busy ? '正在冻结快照…' : '创建并启动'}</button></footer>
    {blockers.length > 0 && <p className="td2-blockers">{blockers.join(' · ')}</p>}
  </section>
}

function lines(value: string) { return value.split(/\r?\n/u).map(item => item.trim()).filter(Boolean) }
