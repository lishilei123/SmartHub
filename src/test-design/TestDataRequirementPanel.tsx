import { Database, History, ShieldCheck } from 'lucide-react'
import type { TestDesignWorkflowRun } from './types'

export function TestDataRequirementPanel({ run }: { run: TestDesignWorkflowRun }) {
  const latest = run.dataSetVersions.at(-1)
  return <section className="tdw-panel tdw-data-requirements">
    <header><div><span className="tdw-icon"><Database /></span><div><h2>测试数据需求</h2><p>独立保留 PlanningAgent 提出的数据约束；这里不录入真实账号、凭据或个人数据。</p></div></div>{latest && <span className="tdw-badge">V{latest.version} · {latest.requirements.length} 项</span>}</header>
    {!latest ? <div className="tdw-empty"><Database /><b>尚无测试数据需求</b><span>没有数据需求的用例可以直接进入后续审核与执行准备。</span></div> : <>
      <div className="tdw-data-boundary"><ShieldCheck /><span><b>需求定义与执行数据分离</b><small>测试设计只冻结需要什么数据、数量、约束、隔离和清理方式；创建测试执行 Run 时再绑定受控 Fixture、生成器或数据引用。</small></span></div>
      <div className="tdw-data-requirement-grid">{latest.requirements.map(requirement => {
        const linkedCases = requirement.caseIds.map(caseId => run.testCases.find(item => item.id === caseId)).filter(Boolean)
        return <article key={requirement.id}>
          <header><span><b>{requirement.name}</b><code>{requirement.id}</code></span><em className={`tdw-status ${requirement.readiness === 'ready' ? 'active' : requirement.readiness === 'blocked' ? 'failed' : 'pending'}`}>{readinessLabel(requirement.readiness)}</em></header>
          <dl><div><dt>实体 / 数量</dt><dd>{requirement.entityType} · {requirement.quantity}</dd></div><div><dt>敏感级别</dt><dd>{requirement.sensitivity}</dd></div><div><dt>初始状态</dt><dd>{requirement.initialState || '未明确'}</dd></div><div><dt>隔离方式</dt><dd>{requirement.isolation || '未明确'}</dd></div></dl>
          {Object.keys(requirement.fieldConstraints).length > 0 && <section><b>字段约束</b><div className="tdw-chips">{Object.entries(requirement.fieldConstraints).map(([key, value]) => <code key={key}>{key}: {value}</code>)}</div></section>}
          <section><b>准备与清理</b><p>{requirement.preparationHint || '未提供准备提示'}</p><p>{requirement.resetAndCleanup || '未提供重置与清理方式'}</p></section>
          {requirement.readinessReason && <p className="td-confirmation-note">{requirement.readinessReason}</p>}
          <footer><span>关联用例 {linkedCases.length}</span><div className="tdw-chips">{linkedCases.map(testCase => <code key={testCase!.id}>{testCase!.revisions.find(item => item.revision === testCase!.currentRevision)?.content.title ?? testCase!.id}</code>)}</div></footer>
        </article>
      })}</div>
      <section className="tdw-data-version-history"><h3><History />独立版本记录</h3>{[...run.dataSetVersions].reverse().map(version => <article key={version.id}><span><b>V{version.version}</b><small>{version.requirements.length} 项 · {new Date(version.createdAt).toLocaleString('zh-CN')}</small></span><code title={version.contentSha256}>{version.contentSha256}</code></article>)}</section>
    </>}
  </section>
}

function readinessLabel(value: 'ready' | 'blocked' | 'needs_confirmation') {
  return value === 'ready' ? '定义完整' : value === 'blocked' ? '执行阻断' : '执行时补充'
}
