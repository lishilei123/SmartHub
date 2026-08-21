import type { TestCaseContent } from './types'

export function TestCaseEditor({ value, onChange }: { value: TestCaseContent; onChange: (value: TestCaseContent) => void }) {
  const patch = (next: Partial<TestCaseContent>) => onChange({ ...value, ...next })
  const toggleMethod = (method: 'ui' | 'api') => {
    const selected = value.executionMethods.includes(method)
    const executionMethods = selected ? value.executionMethods.filter(item => item !== method) : [...value.executionMethods, method]
    patch({ executionMethods: (['ui', 'api'] as const).filter(item => executionMethods.includes(item)) })
  }
  return <div className="tdw-form-grid">
    <label className="wide">标题<input value={value.title} onChange={event => patch({ title: event.target.value })} /></label>
    <label>测试类型<select value={value.dimension} onChange={event => patch({ dimension: event.target.value as TestCaseContent['dimension'] })}>{['functional', 'performance', 'stability', 'compatibility', 'security'].map(item => <option key={item} value={item}>{dimensionLabel(item as TestCaseContent['dimension'])}</option>)}</select></label>
    <label>优先级<select value={value.priority} onChange={event => patch({ priority: event.target.value as TestCaseContent['priority'] })}>{['P0', 'P1', 'P2', 'P3'].map(item => <option key={item}>{item}</option>)}</select></label>
    <fieldset className="wide"><legend>执行方式</legend><label><input type="checkbox" checked={value.executionMethods.includes('ui')} onChange={() => toggleMethod('ui')} /> UI</label><label><input type="checkbox" checked={value.executionMethods.includes('api')} onChange={() => toggleMethod('api')} /> API</label></fieldset>
    <LineEditor label="关联需求" hint="每行一个 Requirement ID；留空表示扩展风险测试。" values={value.requirementRefs} onChange={requirementRefs => patch({ requirementRefs })} />
    <LineEditor label="前置条件" values={value.preconditions} onChange={preconditions => patch({ preconditions })} />
    <LineEditor label="执行步骤" values={value.steps} onChange={steps => patch({ steps })} />
    <LineEditor label="预期结果" values={value.expectedResults} onChange={expectedResults => patch({ expectedResults })} />
  </div>
}

function LineEditor({ label, hint, values, onChange }: { label: string; hint?: string; values: string[]; onChange: (values: string[]) => void }) {
  return <label className="wide">{label}<textarea value={values.join('\n')} onChange={event => onChange(event.target.value.split(/\r?\n/u).map(item => item.trim()).filter(Boolean))} />{hint && <small>{hint}</small>}</label>
}

export function createEmptyTestCase(): TestCaseContent { return { schemaVersion: 'test-case/v3', title: '', dimension: 'functional', priority: 'P1', requirementRefs: [], executionMethods: ['ui'], preconditions: [], steps: [], expectedResults: [] } }
export function testCaseEditorValid(value: TestCaseContent) { return Boolean(value.schemaVersion === 'test-case/v3' && value.title.trim() && value.executionMethods.length && value.steps.some(item => item.trim()) && value.expectedResults.some(item => item.trim())) }
export function executionPendingItems(_value: TestCaseContent) { return [] }
export function actualExecutionMethod(value: TestCaseContent) { return value.executionMethods.map(item => item.toUpperCase()).join(' + ') }
export function dimensionLabel(value: TestCaseContent['dimension']) { return ({ functional: '功能', performance: '性能', stability: '稳定性', compatibility: '兼容性', security: '安全' } as const)[value] }
