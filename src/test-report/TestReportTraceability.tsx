import { Fingerprint } from 'lucide-react'
import type { LegacyTestReport } from './types'

export function TestReportTraceability({ report }: { report: LegacyTestReport }) {
  const trace = report.traceability
  const references = [
    ['Project ID', trace.projectId],
    ['ProjectVersion ID', trace.projectVersionId],
    ['ExecutionRun ID', trace.runId],
    ['Run stateVersion', String(trace.runStateVersion)],
    ['Handoff ID', trace.handoff.id],
    ['Handoff Hash', trace.handoff.sha256],
    ['Member Snapshot Hash', trace.handoff.memberSnapshotSha256],
    ['Library Version ID', trace.testCaseLibraryVersion.id],
    ['Library Version Hash', trace.testCaseLibraryVersion.sha256],
    ...(trace.testCaseLibraryVersion.sourceRunId ? [['Library Source Run', trace.testCaseLibraryVersion.sourceRunId]] : []),
    ...(trace.testSuiteVersion ? [['Suite Version ID', trace.testSuiteVersion.id], ['Suite Version Hash', trace.testSuiteVersion.sha256]] : []),
    ['Environment ID', trace.environment.id],
    ['Environment Signature', trace.environment.signature],
    ['Runner Version', trace.runner.runnerVersion],
    ['Playwright Version', trace.runner.playwrightVersion],
    ['Runner Image', `${trace.runner.imageReference}@${trace.runner.imageDigest}`],
  ]

  return <section className="tr-section tr-trace" aria-labelledby="tr-trace-title">
    <header><div><h2 id="tr-trace-title"><Fingerprint aria-hidden="true" />完整追溯</h2><p>全部身份、版本和 Hash 来自 ExecutionRun 冻结快照及已校验的正式来源。</p></div></header>
    <dl className="tr-trace-grid">{references.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <h3>执行环境目标</h3>
    <ul className="tr-targets">{trace.environment.targets.map(target => <li key={`${target.protocol}-${target.host}-${target.port}`}>{target.protocol}://{target.host}:{target.port}</li>)}</ul>
    <div className="tr-table-scroll"><table><thead><tr><th>Agent</th><th>配置版本</th><th>配置 ID</th><th>配置 Hash</th><th>定义 Hash</th><th>快照 Hash</th></tr></thead><tbody>{Object.values(trace.agents).map(agent => <tr key={agent.agentKey}><td><b>{agent.agentKey}</b></td><td>{agent.configurationVersion}</td><td><code>{agent.configurationId}</code></td><td><code>{agent.configurationSha256}</code></td><td><code>{agent.definitionSha256}</code></td><td><code>{agent.snapshotSha256}</code></td></tr>)}</tbody></table></div>
  </section>
}
