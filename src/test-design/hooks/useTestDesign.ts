import { useCallback, useEffect, useState } from 'react'
import * as api from '../api'
import type { CaseChangeDecision, CreateTestDesignInput, LibraryExecutionHandoff, LibraryTestCase, LibraryTestSuiteVersion, TestCaseContent, TestCaseLibraryVersion, TestDesign, TestDesignInputCandidates, TestDesignWorkflowRun, TestExecutionMethod, TestPointNode, TestPointTree, TestPointTreeOperation, TestSuiteDraft } from '../types'

type Notify = (message: string, tone?: 'success' | 'error' | 'warning') => void

export function useTestDesign(projectVersionId: string | undefined, notify: Notify) {
  const [inputs, setInputs] = useState<TestDesignInputCandidates | null>(null)
  const [designs, setDesigns] = useState<TestDesign[]>([])
  const [design, setDesign] = useState<TestDesign | null>(null)
  const [run, setRun] = useState<TestDesignWorkflowRun | null>(null)
  const [tree, setTree] = useState<{ tree: TestPointTree; revision: { revision: number; nodes: TestPointNode[]; treeSha256: string }; etag: string } | null>(null)
  const [libraryCases, setLibraryCases] = useState<LibraryTestCase[]>([])
  const [libraryVersions, setLibraryVersions] = useState<TestCaseLibraryVersion[]>([])
  const [suiteDrafts, setSuiteDrafts] = useState<TestSuiteDraft[]>([])
  const [suiteVersions, setSuiteVersions] = useState<LibraryTestSuiteVersion[]>([])
  const [handoffs, setHandoffs] = useState<LibraryExecutionHandoff[]>([])
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
    const projectId = nextInputs.projectVersion.projectId
    const [cases, versions, drafts, suites, nextHandoffs] = await Promise.all([api.loadLibraryCases(projectId), api.loadLibraryVersions(projectId), api.loadSuiteDrafts(projectId), api.loadSuiteVersions(projectId), api.loadLibraryHandoffs(projectVersionId)])
    setInputs(nextInputs); setDesigns(nextDesigns.items); setLibraryCases(cases.items); setLibraryVersions(versions.items); setSuiteDrafts(drafts.items); setSuiteVersions(suites.items); setHandoffs(nextHandoffs.items)
  }, [projectVersionId])

  const refreshRun = useCallback(async () => {
    if (!projectVersionId || !design || !run) return
    const next = await api.loadRun(projectVersionId, design.id, run.id)
    setRun(next)
    if (next.testPointTree) setTree(await api.loadTree(projectVersionId, design.id, next.id))
    return next
  }, [projectVersionId, design, run])

  useEffect(() => { setInputs(null); setDesigns([]); setDesign(null); setRun(null); setTree(null); setLibraryCases([]); setLibraryVersions([]); setSuiteDrafts([]); setSuiteVersions([]); setHandoffs([]); if (projectVersionId) void loadCollection().catch(cause => setError(cause instanceof Error ? cause.message : String(cause))) }, [projectVersionId, loadCollection])
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

  const createCase = useCallback(async (content: TestCaseContent) => {
    if (!projectVersionId || !design || !run) return
    await guarded('case-create', () => api.createCase(projectVersionId, design.id, run.id, content), '测试用例已创建为草稿。')
    await refreshRun()
  }, [design, guarded, projectVersionId, refreshRun, run])

  const editCase = useCallback(async (caseId: string, content: TestCaseContent, reason: string) => {
    if (!projectVersionId || !design || !run) return
    const current = await guarded('case-load', () => api.loadCase(projectVersionId, design.id, run.id, caseId))
    await guarded('case-edit', () => api.patchCase(projectVersionId, design.id, run.id, caseId, current.etag, content, reason), '测试用例已生成新 Revision。')
    await refreshRun()
  }, [design, guarded, projectVersionId, refreshRun, run])

  const removeCase = useCallback(async (caseId: string) => {
    if (!projectVersionId || !design || !run) return
    await guarded('case-delete', () => api.deleteCase(projectVersionId, design.id, run.id, caseId), '测试用例已删除，Coverage Audit 已失效。')
    await refreshRun()
  }, [design, guarded, projectVersionId, refreshRun, run])

  const reviewCase = useCallback(async (caseId: string, decision: 'submit' | 'approve' | 'reject' | 'request_revision' | 'withdraw', targetRevision: number, comment?: string) => {
    if (!projectVersionId || !design || !run) return
    await guarded(`case-${decision}`, () => api.reviewCase(projectVersionId, design.id, run.id, caseId, decision, targetRevision, comment), '用例审核状态已更新。')
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

  const decideProposal = useCallback(async (proposalId: string, decision: Exclude<CaseChangeDecision, 'pending'>, comment?: string, editedContent?: TestCaseContent) => {
    if (!projectVersionId || !design || !run) return
    const proposal = run.caseChangeProposals.find(item => item.id === proposalId)
    if (!proposal) return
    await guarded('proposal-decision', () => api.decideProposal(projectVersionId, design.id, run.id, proposalId, { expectedVersion: proposal.decisions.length, decision, comment, editedContent }), '用例库变更决策已记录。')
    await refreshRun()
  }, [design, guarded, projectVersionId, refreshRun, run])

  const publish = useCallback(async (name: string) => {
    if (!projectVersionId || !design || !run) return
    const audit = [...run.coverageAudits].reverse().find(item => item.status === 'valid')
    if (!audit) throw new Error('没有有效 Coverage Audit')
    const version = await guarded('publish', () => api.publishLibraryVersion(projectVersionId, design.id, run.id, { name, expectedAuditId: audit.id, expectedCaseSetSha256: audit.caseSetSha256, expectedProposalSha256: run.caseChangeProposalSha256 }), '正式测试用例库版本已发布并投影到 Workspace。')
    await Promise.all([refreshRun(), loadCollection()]); return version
  }, [design, guarded, projectVersionId, refreshRun, run])

  const handoff = useCallback(async (version: TestCaseLibraryVersion, mode: 'smoke' | 'regression' | 'full' | 'custom', suiteVersionId?: string, impactedCaseIds?: string[]) => {
    if (!projectVersionId) return
    const created = await guarded('handoff', () => api.createLibraryHandoff(projectVersionId, version.id, { mode, expectedLibrarySha256: version.contentSha256, suiteVersionId, impactedCaseIds }), 'Execution Handoff 已创建并冻结执行输入。')
    setHandoffs(current => [created, ...current]); return created
  }, [guarded, projectVersionId])

  const createLibraryCase = useCallback(async (content: TestCaseContent, reason: string) => { if (!inputs) return; await guarded('library-create', () => api.createLibraryCase(inputs.projectVersion.projectId, content, reason), '正式用例已创建。'); await loadCollection() }, [guarded, inputs, loadCollection])
  const editLibraryCase = useCallback(async (testCase: LibraryTestCase, content: TestCaseContent, reason: string) => { if (!inputs) return; await guarded('library-edit', () => api.editLibraryCase(inputs.projectVersion.projectId, testCase.id, testCase.etag, content, reason), '正式用例已生成新 Revision。'); await loadCollection() }, [guarded, inputs, loadCollection])
  const copyLibraryCase = useCallback(async (testCase: LibraryTestCase) => { if (!inputs) return; await guarded('library-copy', () => api.copyLibraryCase(inputs.projectVersion.projectId, testCase.id, `复制自 ${testCase.id}`), '正式用例副本已创建。'); await loadCollection() }, [guarded, inputs, loadCollection])
  const deprecateLibraryCase = useCallback(async (testCase: LibraryTestCase, reason: string) => { if (!inputs) return; await guarded('library-deprecate', () => api.deprecateLibraryCase(inputs.projectVersion.projectId, testCase.id, testCase.etag, reason), '正式用例已废弃，历史 Revision 保留。'); await loadCollection() }, [guarded, inputs, loadCollection])
  const saveSuiteDraft = useCallback(async (draft: TestSuiteDraft | undefined, value: { suiteKey: string; suiteType: 'smoke' | 'regression' | 'custom'; name: string; members: Array<{ testCaseLibraryVersionId: string; caseId: string; executionMethod: TestExecutionMethod; reason: string }> }) => { if (!inputs) return; if (draft) { const loaded = await api.loadSuiteDraft(inputs.projectVersion.projectId, draft.id); await guarded('suite-save', () => api.updateSuiteDraft(inputs.projectVersion.projectId, draft.id, loaded.response.headers.get('etag') ?? draft.etag ?? '', value), '测试套件草稿已保存。') } else await guarded('suite-create', () => api.createSuiteDraft(inputs.projectVersion.projectId, value), '测试套件草稿已创建。'); await loadCollection() }, [guarded, inputs, loadCollection])
  const publishSuite = useCallback(async (draft: TestSuiteDraft) => { if (!inputs) return; const loaded = await api.loadSuiteDraft(inputs.projectVersion.projectId, draft.id); await guarded('suite-publish', () => api.publishSuiteDraft(inputs.projectVersion.projectId, draft.id, loaded.response.headers.get('etag') ?? draft.etag ?? ''), '不可变测试套件版本已发布。'); await loadCollection() }, [guarded, inputs, loadCollection])
  const deprecateSuite = useCallback(async (version: LibraryTestSuiteVersion) => { if (!inputs) return; await guarded('suite-deprecate', () => api.deprecateSuiteVersion(inputs.projectVersion.projectId, version.id), '测试套件版本已废弃，历史引用保留。'); await loadCollection() }, [guarded, inputs, loadCollection])

  return { inputs, designs, design, run, tree, libraryCases, libraryVersions, suiteDrafts, suiteVersions, handoffs, busy, error, loadCollection, openDesign, closeDesign, create, startRun, refreshRun, updateTree, approve, redesign, resynthesize, reviewCases, createCase, editCase, removeCase, reviewCase, reAudit, resolveIssue, decideProposal, publish, handoff, createLibraryCase, editLibraryCase, copyLibraryCase, deprecateLibraryCase, saveSuiteDraft, publishSuite, deprecateSuite }
}
