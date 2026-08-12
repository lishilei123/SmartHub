import { useCallback, useEffect, useState } from 'react'
import * as api from '../api'
import type { CreateTestDesignInput, TestCaseSetVersion, TestDesign, TestDesignInputCandidates, TestDesignWorkflowRun, TestExecutionHandoff, TestPointNode, TestPointTree, TestPointTreeOperation, TestSuiteVersion } from '../types'

type Notify = (message: string, tone?: 'success' | 'error' | 'warning') => void

export function useTestDesign(projectVersionId: string | undefined, notify: Notify) {
  const [inputs, setInputs] = useState<TestDesignInputCandidates | null>(null)
  const [designs, setDesigns] = useState<TestDesign[]>([])
  const [design, setDesign] = useState<TestDesign | null>(null)
  const [run, setRun] = useState<TestDesignWorkflowRun | null>(null)
  const [tree, setTree] = useState<{ tree: TestPointTree; revision: { revision: number; nodes: TestPointNode[]; treeSha256: string }; etag: string } | null>(null)
  const [handoffs, setHandoffs] = useState<TestExecutionHandoff[]>([])
  const [suites, setSuites] = useState<TestSuiteVersion[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const guarded = useCallback(async <T,>(label: string, action: () => Promise<T>, success?: string) => {
    setBusy(label); setError('')
    try {
      const value = await action()
      if (success) notify(success, 'success')
      return value
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message); notify(message, 'error'); throw cause
    } finally {
      setBusy('')
    }
  }, [notify])

  const loadCollection = useCallback(async () => {
    if (!projectVersionId) return
    const [nextInputs, nextDesigns] = await Promise.all([api.loadInputs(projectVersionId), api.loadDesigns(projectVersionId)])
    setInputs(nextInputs); setDesigns(nextDesigns.items); setSuites((await api.loadSuites(nextInputs.projectVersion.projectId)).items)
  }, [projectVersionId])

  const refreshRun = useCallback(async () => {
    if (!projectVersionId || !design || !run) return
    const next = await api.loadRun(projectVersionId, design.id, run.id)
    setRun(next)
    if (next.testPointTree) setTree(await api.loadTree(projectVersionId, design.id, next.id))
    const published = next.caseSetVersions?.at(-1)
    if (published) setHandoffs((await api.loadHandoffs(published.id)).items)
    return next
  }, [projectVersionId, design, run])

  useEffect(() => { setInputs(null); setDesigns([]); setDesign(null); setRun(null); setTree(null); setHandoffs([]); setSuites([]); if (projectVersionId) void loadCollection().catch(cause => setError(cause instanceof Error ? cause.message : String(cause))) }, [projectVersionId, loadCollection])
  useEffect(() => {
    if (!run || !['queued', 'running'].includes(run.status)) return
    const timer = window.setInterval(() => { void refreshRun().catch(cause => setError(cause instanceof Error ? cause.message : String(cause))) }, 1800)
    return () => window.clearInterval(timer)
  }, [run, refreshRun])

  const openDesign = useCallback(async (selected: TestDesign) => {
    if (!projectVersionId) return
    setDesign(selected); setTree(null); setHandoffs([])
    if (!selected.latestRun) { setRun(null); return }
    const next = await guarded('load-run', () => api.loadRun(projectVersionId, selected.id, selected.latestRun!.id))
    setRun(next)
    if (next.testPointTree) setTree(await api.loadTree(projectVersionId, selected.id, next.id))
    const published = next.caseSetVersions?.at(-1)
    if (published) setHandoffs((await api.loadHandoffs(published.id)).items)
  }, [guarded, projectVersionId])

  const closeDesign = useCallback(() => { setDesign(null); setRun(null); setTree(null); setHandoffs([]) }, [])

  const create = useCallback(async (input: CreateTestDesignInput) => {
    if (!projectVersionId) return
    const nextDesign = await guarded('create', () => api.createDesign(projectVersionId, input))
    const nextRun = await api.createRun(projectVersionId, nextDesign.id)
    setDesign({ ...nextDesign, latestRun: nextRun }); setRun(nextRun); setTree(null)
    await loadCollection(); notify('测试设计已创建，Requirement Release 与 Workspace 快照已冻结。', 'success')
  }, [guarded, loadCollection, notify, projectVersionId])

  const startRun = useCallback(async () => {
    if (!projectVersionId || !design) return
    const next = await guarded('start-run', () => api.createRun(projectVersionId, design.id), '已启动新的测试设计运行。')
    setRun(next); setTree(null); setHandoffs([])
  }, [design, guarded, projectVersionId])

  const updateTree = useCallback(async (operations: TestPointTreeOperation[], reason: string) => {
    if (!projectVersionId || !design || !run || !tree) return
    const next = await guarded('tree-edit', () => api.patchTree(projectVersionId, design.id, run.id, tree.etag, operations, reason), '测试点树已生成新 Revision。')
    setTree(next); await refreshRun()
  }, [design, guarded, projectVersionId, refreshRun, run, tree])

  const approve = useCallback(async () => {
    if (!projectVersionId || !design || !run || !tree) return
    await guarded('tree-approve', () => api.approveTree(projectVersionId, design.id, run.id, tree.etag), 'TestPointTreeVersion 已批准并投影到正式 Workspace 资产。')
    await refreshRun()
  }, [design, guarded, projectVersionId, refreshRun, run, tree])

  const redesign = useCallback(async () => {
    if (!projectVersionId || !design || !run) return
    await guarded('redesign', () => api.redesignTestPoints(projectVersionId, design.id, run.id), '已要求 TestDesignAgent 重新设计测试点。')
    setTree(null); await refreshRun()
  }, [design, guarded, projectVersionId, refreshRun, run])

  const resynthesize = useCallback(async () => {
    if (!projectVersionId || !design || !run) return
    await guarded('resynthesize', () => api.resynthesizeCases(projectVersionId, design.id, run.id), '已要求 TestDesignAgent 重新生成用例。')
    await refreshRun()
  }, [design, guarded, projectVersionId, refreshRun, run])

  const reviewCases = useCallback(async (decision: 'submit' | 'approve') => {
    if (!projectVersionId || !design || !run) return
    const targetState = decision === 'submit' ? 'draft' : 'in_review'
    const targets = run.testCases.filter(item => !item.tombstonedAt && item.reviewState === targetState).map(item => ({ caseId: item.id, targetRevision: item.currentRevision }))
    if (!targets.length) return
    await guarded(`case-${decision}`, () => api.batchReviewCases(projectVersionId, design.id, run.id, targets, decision), decision === 'submit' ? '用例已提交人工审核。' : '用例已批准。')
    await refreshRun()
  }, [design, guarded, projectVersionId, refreshRun, run])

  const reAudit = useCallback(async () => {
    if (!projectVersionId || !design || !run) return
    await guarded('audit', () => api.reAudit(projectVersionId, design.id, run.id), '服务端 Coverage Audit 已重新执行。')
    await refreshRun()
  }, [design, guarded, projectVersionId, refreshRun, run])

  const resolveIssue = useCallback(async (kind: 'finding' | 'confirmation', id: string, expectedVersion: number) => {
    if (!projectVersionId || !design || !run) return
    await guarded('resolve-issue', () => kind === 'finding' ? api.actOnFinding(projectVersionId, design.id, run.id, id, expectedVersion) : api.actOnConfirmation(projectVersionId, design.id, run.id, id, expectedVersion), '人工决策已记录，请重新执行 Coverage Audit。')
    await refreshRun()
  }, [design, guarded, projectVersionId, refreshRun, run])

  const publish = useCallback(async (name: string) => {
    if (!projectVersionId || !design || !run) return
    const audit = [...run.coverageAudits].reverse().find(item => item.status === 'valid')
    if (!audit) throw new Error('没有有效 Coverage Audit')
    const version = await guarded('publish', () => api.publishCaseSet(projectVersionId, design.id, run.id, { name, expectedAuditId: audit.id, expectedCaseSetSha256: audit.caseSetSha256 }), 'TestCaseSetVersion 已发布并投影到正式 Workspace 资产。')
    await refreshRun(); return version
  }, [design, guarded, projectVersionId, refreshRun, run])

  const handoff = useCallback(async (version: TestCaseSetVersion, strategy: 'standard' | 'fast' | 'full', smokeSuiteVersionId?: string, regressionSuiteVersionId?: string) => {
    const created = await guarded('handoff', () => api.createHandoff(version.id, { strategy, expectedCaseSetSha256: version.contentSha256, smokeSuiteVersionId, regressionSuiteVersionId }), 'Execution Handoff 已创建。')
    setHandoffs(current => [created, ...current]); return created
  }, [guarded])

  return { inputs, designs, design, run, tree, handoffs, suites, busy, error, loadCollection, openDesign, closeDesign, create, startRun, refreshRun, updateTree, approve, redesign, resynthesize, reviewCases, reAudit, resolveIssue, publish, handoff }
}
