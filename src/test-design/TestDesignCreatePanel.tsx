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
  const [coverage, setCoverage] = useState('')
  const [selectedDimensions, setSelectedDimensions] = useState<TestDimension[]>(['functional'])
  const [methods, setMethods] = useState<ExecutionMethod[]>(['ui', 'api'])
  const [knowledgeAssets, setKnowledgeAssets] = useState<string[]>([])
  const [historyMode, setHistoryMode] = useState<'latest_library' | 'library_version' | 'suite_version' | 'none'>('latest_library')
  const [historyVersionId, setHistoryVersionId] = useState('')
  const blockers = useMemo(() => [!inputs.requirementRelease ? '当前 ProjectVersion 未绑定正式 Requirement Release' : '', !inputs.agentReadiness.ready ? 'TestDesignAgent 尚未就绪' : '', !name.trim() ? '填写任务名称' : '', !objective.trim() ? '填写测试目标' : '', !selectedDimensions.length ? '至少选择一个测试维度' : '', !methods.length ? '至少选择一个执行入口' : ''].filter(Boolean), [inputs, methods, name, objective, selectedDimensions])
  const toggle = <T extends string>(value: T, values: T[], setter: (next: T[]) => void) => setter(values.includes(value) ? values.filter(item => item !== value) : [...values, value])
  const submit = () => onCreate({
    name: name.trim(), objective: objective.trim(),
    includedScopes: lines(included).map(value => ({ kind: 'scope', value })),
    excludedScopes: lines(excluded).map(value => ({ kind: 'scope', value })),
    focusDimensions: selectedDimensions, executionMethods: methods, userCoverageObjectives: lines(coverage),
    knowledgeAugmentation: knowledgeAssets.length ? { mode: 'selected_assets', assetVersionIds: knowledgeAssets } : { mode: 'disabled' },
    historicalLibrarySelection: historyMode === 'library_version' ? { mode: historyMode, testCaseLibraryVersionId: historyVersionId || (inputs.testCaseLibraryVersions[0]?.id ?? '') } : historyMode === 'suite_version' ? { mode: historyMode, suiteVersionId: historyVersionId || (inputs.historicalTestSuites[0]?.id ?? '') } : { mode: historyMode },
  })

  return <section className="td2-create td2-card">
    <header><div><span className="td2-icon"><Play /></span><div><p className="td2-kicker">创建测试设计</p><h2>固定目标与输入边界</h2><p>运行开始时由服务端冻结当前绑定的 Requirement Release、Agent 配置和 Workspace 快照。</p></div></div><button className="td2-button ghost" onClick={onCancel}>取消</button></header>
    <div className="td2-release-lock">
      <LockKeyhole />
      {inputs.requirementRelease ? <div><b>{inputs.requirementRelease.label}</b><small>releaseId {inputs.requirementRelease.id} · verificationRunId {inputs.requirementRelease.reviewRunId}</small><code>{inputs.requirementRelease.contentSha256}</code></div> : <div><b>未绑定 Requirement Release</b><small>请先在当前 ProjectVersion 发布正式需求包。</small></div>}
      {inputs.requirementRelease ? <CheckCircle2 /> : <XCircle />}
    </div>
    <div className="td2-form-grid">
      <label><span>任务名称</span><input value={name} onChange={event => setName(event.target.value)} placeholder="例如：订单结算测试设计" /></label>
      <label className="wide"><span>测试目标</span><textarea value={objective} onChange={event => setObjective(event.target.value)} placeholder="说明这次测试要验证什么，以及成功标准。" /></label>
      <label><span>纳入范围（每行一项）</span><textarea value={included} onChange={event => setIncluded(event.target.value)} placeholder="创建订单&#10;支付回调" /></label>
      <label><span>排除范围（每行一项）</span><textarea value={excluded} onChange={event => setExcluded(event.target.value)} placeholder="线下退款&#10;旧版客户端" /></label>
      <label className="wide"><span>覆盖目标（每行一项）</span><textarea value={coverage} onChange={event => setCoverage(event.target.value)} placeholder="主流程与异常恢复&#10;权限与接口幂等" /></label>
    </div>
    <div className="td2-choice-row"><div><b>测试维度</b><small>非功能维度只在 Workspace 有依据且适用时生成。</small></div><div>{dimensions.map(item => <button key={item.key} className={selectedDimensions.includes(item.key) ? 'active' : ''} onClick={() => toggle(item.key, selectedDimensions, setSelectedDimensions)}>{item.label}</button>)}</div></div>
    <div className="td2-choice-row"><div><b>执行入口</b><small>首期重点支持 UI 与 API。</small></div><div>{(['ui', 'api'] as const).map(item => <button key={item} className={methods.includes(item) ? 'active' : ''} onClick={() => toggle(item, methods, setMethods)}>{item.toUpperCase()}</button>)}</div></div>
    <div className="td2-history-source"><div><b>历史用例策略</b><small>运行时冻结选择的正式用例库或测试套件，不读取后续变化。</small></div><select value={historyMode} onChange={event => { setHistoryMode(event.target.value as typeof historyMode); setHistoryVersionId('') }}><option value="latest_library">项目最新用例库版本（默认）</option><option value="library_version">指定用例库版本</option><option value="suite_version">指定历史测试套件</option><option value="none">不使用历史用例</option></select>{historyMode === 'library_version' && <select value={historyVersionId} onChange={event => setHistoryVersionId(event.target.value)}>{inputs.testCaseLibraryVersions.map(item => <option key={item.id} value={item.id}>V{item.version} · {item.name} · {item.memberCount} 条</option>)}</select>}{historyMode === 'suite_version' && <select value={historyVersionId} onChange={event => setHistoryVersionId(event.target.value)}>{inputs.historicalTestSuites.map(item => <option key={item.id} value={item.id}>{item.suiteType} · {item.name} V{item.version}</option>)}</select>}</div>
    <details className="td2-optional"><summary><Database />可选增强上下文 <small>{knowledgeAssets.length ? `已选择 ${knowledgeAssets.length} 份` : '默认不启用'}</small></summary><div>{inputs.knowledgeAssets.filter(item => item.selectable).map(item => <label key={item.assetVersionId}><input type="checkbox" checked={knowledgeAssets.includes(item.assetVersionId)} onChange={() => toggle(item.assetVersionId, knowledgeAssets, setKnowledgeAssets)} /><span><b>{item.displayName}</b><small>{item.logicalPath}</small></span></label>)}</div></details>
    <footer><div className={inputs.agentReadiness.ready ? 'td2-agent-ready' : 'td2-agent-ready danger'}><Bot /><span><b>TestDesignAgent</b><small>{inputs.agentReadiness.ready ? '配置、模型与 Skill 绑定已就绪' : inputs.agentReadiness.agents[0]?.reason ?? '未就绪'}</small></span></div><button className="td2-button primary" disabled={busy || blockers.length > 0} onClick={submit}>{busy ? '正在冻结快照…' : '创建并启动'}</button></footer>
    {blockers.length > 0 && <p className="td2-blockers">{blockers.join(' · ')}</p>}
  </section>
}

function lines(value: string) { return value.split(/\r?\n/u).map(item => item.trim()).filter(Boolean) }
