import type { AgentTestSpec, TestCaseContent } from './types'

export function TestCaseEditor({ value, onChange }: { value: TestCaseContent; onChange: (value: TestCaseContent) => void }) {
  const patch = (next: Partial<TestCaseContent>) => onChange({ ...value, ...next })
  const toggleMethod = (method: 'ui' | 'api' | 'agent') => {
    if (method === 'agent') {
      patch({ executionMethods: ['agent'], agentTestSpec: value.agentTestSpec ?? emptyAgentTestSpec() })
      return
    }
    const selected = value.executionMethods.includes(method)
    const current = value.executionMethods.filter(item => item !== 'agent')
    const executionMethods = selected ? current.filter(item => item !== method) : [...current, method]
    patch({ executionMethods: (['ui', 'api'] as const).filter(item => executionMethods.includes(item)) })
  }
  return <div className="tdw-form-grid">
    <label className="wide">标题<input value={value.title} onChange={event => patch({ title: event.target.value })} /></label>
    <label>测试类型<select value={value.dimension} onChange={event => patch({ dimension: event.target.value as TestCaseContent['dimension'] })}>{['functional', 'performance', 'stability', 'compatibility', 'security'].map(item => <option key={item} value={item}>{dimensionLabel(item as TestCaseContent['dimension'])}</option>)}</select></label>
    <label>优先级<select value={value.priority} onChange={event => patch({ priority: event.target.value as TestCaseContent['priority'] })}>{['P0', 'P1', 'P2', 'P3'].map(item => <option key={item}>{item}</option>)}</select></label>
    <fieldset className="wide"><legend>执行方式</legend><label><input type="radio" checked={value.executionMethods.includes('agent')} onChange={() => toggleMethod('agent')} /> Agent</label><label><input type="checkbox" checked={value.executionMethods.includes('ui')} onChange={() => toggleMethod('ui')} /> UI（历史链）</label><label><input type="checkbox" checked={value.executionMethods.includes('api')} onChange={() => toggleMethod('api')} /> API（历史链）</label></fieldset>
    <LineEditor label="关联需求" hint="每行一个 Requirement ID；留空表示扩展风险测试。" values={value.requirementRefs} onChange={requirementRefs => patch({ requirementRefs })} />
    <LineEditor label="前置条件" values={value.preconditions} onChange={preconditions => patch({ preconditions })} />
    <LineEditor label="执行步骤" values={value.steps} onChange={steps => patch({ steps })} />
    <LineEditor label="预期结果" values={value.expectedResults} onChange={expectedResults => patch({ expectedResults })} />
    {value.executionMethods.includes('agent') && <AgentSpecEditor value={value.agentTestSpec ?? emptyAgentTestSpec()} onChange={agentTestSpec => patch({ agentTestSpec })} />}
  </div>
}

function LineEditor({ label, hint, values, onChange }: { label: string; hint?: string; values: string[]; onChange: (values: string[]) => void }) {
  return <label className="wide">{label}<textarea value={values.join('\n')} onChange={event => onChange(event.target.value.split(/\r?\n/u).map(item => item.trim()).filter(Boolean))} />{hint && <small>{hint}</small>}</label>
}

function AgentSpecEditor({ value, onChange }: { value: AgentTestSpec; onChange: (value: AgentTestSpec) => void }) {
  const patch = (next: Partial<AgentTestSpec>) => onChange({ ...value, ...next })
  return <section className="wide tdw-agent-spec"><h4>Agent Test Spec</h4><p>只描述 Evidence 约束，不写死完整 Trace；看不到的 Tool Evidence 将判为 NOT_EVALUABLE。</p>
    <label className="wide">Agent 输入<textarea value={typeof value.input === 'string' ? value.input : JSON.stringify(value.input, null, 2)} onChange={event => patch({ input: event.target.value })} /></label>
    <label className="wide">预期业务结果<textarea value={value.expectedOutcome} onChange={event => patch({ expectedOutcome: event.target.value })} /></label>
    <LineEditor label="必须调用的 Tool" values={value.requiredTools} onChange={requiredTools => patch({ requiredTools })} />
    <LineEditor label="禁止调用的 Tool" values={value.forbiddenTools} onChange={forbiddenTools => patch({ forbiddenTools })} />
    <LineEditor label="必须动作" values={value.requiredActions} onChange={requiredActions => patch({ requiredActions })} />
    <LineEditor label="禁止动作" values={value.forbiddenActions} onChange={forbiddenActions => patch({ forbiddenActions })} />
    <LineEditor label="顺序约束" hint="每行 before -> after；允许 Agent 插入其他合理步骤。" values={value.sequenceConstraints.map(item => `${item.before} -> ${item.after}`)} onChange={lines => patch({ sequenceConstraints: lines.flatMap(line => { const [before, after] = line.split(/\s*->\s*/u); return before && after ? [{ before, after }] : [] }) })} />
    <LineEditor label="语义断言" hint="每行 criterion :: expected" values={value.semanticAssertions.map(item => `${item.criterion} :: ${item.expected}`)} onChange={lines => patch({ semanticAssertions: criterionLines(lines) })} />
    <LineEditor label="安全断言" hint="每行 criterion :: expected" values={value.safetyAssertions.map(item => `${item.criterion} :: ${item.expected}`)} onChange={lines => patch({ safetyAssertions: criterionLines(lines) })} />
    <div className="tdw-form-grid"><label>Timeout (ms)<input type="number" min="100" max="600000" value={value.executionConstraints.timeoutMs} onChange={event => patch({ executionConstraints: { ...value.executionConstraints, timeoutMs: Number(event.target.value) } })} /></label><label>Max Steps<input type="number" min="1" max="10000" value={value.executionConstraints.maxSteps} onChange={event => patch({ executionConstraints: { ...value.executionConstraints, maxSteps: Number(event.target.value) } })} /></label><label>Repeat Count<input type="number" min="1" max="50" value={value.executionConstraints.repeatCount} onChange={event => patch({ executionConstraints: { ...value.executionConstraints, repeatCount: Number(event.target.value) } })} /></label></div>
  </section>
}

function criterionLines(lines: string[]) { return lines.flatMap(line => { const [criterion, expected] = line.split(/\s*::\s*/u); return criterion && expected ? [{ criterion, expected }] : [] }) }
function emptyAgentTestSpec(): AgentTestSpec { return { input: '', expectedOutcome: '', requiredTools: [], forbiddenTools: [], requiredActions: [], forbiddenActions: [], argumentAssertions: [], sequenceConstraints: [], businessAssertions: [], artifactAssertions: [], semanticAssertions: [], safetyAssertions: [], executionConstraints: { timeoutMs: 30000, maxSteps: 50, repeatCount: 1 } } }
export function createEmptyTestCase(): TestCaseContent { return { schemaVersion: 'test-case/v3', title: '', dimension: 'functional', priority: 'P1', requirementRefs: [], executionMethods: ['agent'], preconditions: [], steps: [], expectedResults: [], agentTestSpec: emptyAgentTestSpec() } }
export function testCaseEditorValid(value: TestCaseContent) { return Boolean(value.schemaVersion === 'test-case/v3' && value.title.trim() && value.executionMethods.length && value.steps.some(item => item.trim()) && value.expectedResults.some(item => item.trim()) && (!value.executionMethods.includes('agent') || value.executionMethods.length === 1 && value.agentTestSpec?.expectedOutcome.trim())) }
export function executionPendingItems(_value: TestCaseContent) { return [] }
export function actualExecutionMethod(value: TestCaseContent) { return value.executionMethods.map(item => item.toUpperCase()).join(' + ') }
export function dimensionLabel(value: TestCaseContent['dimension']) { return ({ functional: '功能', performance: '性能', stability: '稳定性', compatibility: '兼容性', security: '安全' } as const)[value] }
