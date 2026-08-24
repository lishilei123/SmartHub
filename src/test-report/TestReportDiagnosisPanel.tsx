import { SearchCheck } from 'lucide-react'
import type { FailureDiagnosisCategory, LegacyTestReport } from './types'

const labels: Record<FailureDiagnosisCategory, string> = {
  product_defect: '产品缺陷',
  script_defect: '脚本缺陷',
  selector_changed: '选择器变化',
  environment_defect: '环境缺陷',
  test_data_defect: '测试数据缺陷',
  flaky: 'Flaky',
  assertion_mismatch: '断言不匹配',
  timeout: '超时',
  unknown: '未知',
}

export function TestReportDiagnosisPanel({ report }: { report: LegacyTestReport }) {
  return <section className="tr-section tr-diagnosis" aria-labelledby="tr-diagnosis-title">
    <header><div><h2 id="tr-diagnosis-title"><SearchCheck aria-hidden="true" />诊断分布</h2><p>统计全部正式 FailureDiagnosis 事件，共 {report.diagnosisDistribution.totalDiagnoses} 条。</p></div></header>
    <div className="tr-table-scroll"><table><thead><tr><th>正式类别</th><th>事件数</th><th>占比</th><th>幅度</th></tr></thead><tbody>{report.diagnosisDistribution.categories.map(item => <tr key={item.category}><td><b>{labels[item.category]}</b><code>{item.category}</code></td><td>{item.count}</td><td>{item.percentage.toFixed(2)}%</td><td><span className="tr-magnitude" aria-label={`${labels[item.category]} ${item.percentage.toFixed(2)}%`}><i style={{ width: `${item.percentage}%` }} /></span></td></tr>)}</tbody></table></div>
  </section>
}

export function diagnosisLabel(category: FailureDiagnosisCategory) {
  return labels[category]
}
