import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../api'
import type { CaseChangeDecision, CreateTestDesignInput, ExecutionReadinessOverrideInput, LibraryExecutionHandoff, LibraryTestCase, LibraryTestSuiteVersion, TestCaseContent, TestCaseLibraryVersion, TestCaseTraceability, TestDesign, TestDesignInputCandidates, TestDesignWorkflowRun, TestExecutionMethod, TestSuiteDraft } from '../types'

type Notify = (message: string, tone?: 'success' | 'error' | 'warning') => void
const LIVE_RUN_REFRESH_MS = 1_000

function rawErrorMessage(cause: unknown) { return cause instanceof Error ? cause.message : String(cause) }
function actionableErrorMessage(raw: string) {
  if (/COVERAGE_AUDIT_STALE|没有有效 Coverage Audit|测试设计状态已变化/u.test(raw)) return '测试用例已经发生变化，请重新执行覆盖检查。'
  if (/CASE_CHANGE_PROPOSAL_DECISION_REQUIRED/u.test(raw)) return '还有历史用例变更需要确认。'
  if (/TEST_CASE_REVIEW_REQUIRED/u.test(raw)) return '仍有测试用例尚未审核通过。'
  if (/TEST_CASE_LIBRARY_BASE_CHANGED|CASE_CHANGE_PROPOSAL_SOURCE_STALE|LIBRARY_TEST_CASE_REVISION_CONFLICT/u.test(raw)) return '正式用例库已发生变化，请基于最新版本重新处理后再发布。'
  if (/TEST_CASE_LIBRARY_PUBLICATION_BLOCKED/u.test(raw)) return '仍存在阻断发布的问题，请先在待处理问题中完成处置。'
  return raw
}

export function useTestDesign(projectVersionId: string | undefined, notify: Notify) {
  const [inputs, setInputs] = useState<TestDesignInputCandidates | null>(null)
  const [designs, setDesigns] = useState<TestDesign[]>([])
  const [design, setDesign] = useState<TestDesign | null>(null)
  const [run, setRun] = useState<TestDesignWorkflowRun | null>(null)
  const [libraryCases, setLibraryCases] = useState<LibraryTestCase[]>([])
  const [libraryVersions, setLibraryVersions] = useState<TestCaseLibraryVersion[]>([])
  const [suiteDrafts, setSuiteDrafts] = useState<TestSuiteDraft[]>([])
  const [suiteVersions, setSuiteVersions] = useState<LibraryTestSuiteVersion[]>([])
  const [handoffs, setHandoffs] = useState<LibraryExecutionHandoff[]>([])
  const [legacyMigrationPreview, setLegacyMigrationPreview] = useState<Awaited<ReturnType<typeof api.previewLegacyCaseMigration>> | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [technicalError, setTechnicalError] = useState('')
  const [auditRetryError, setAuditRetryError] = useState('')
  const auditRequestRef = useRef<Promise<TestDesignWorkflowRun | undefined> | null>(null)
  const resynthesisRunIdRef = useRef<string | null>(null)

  const recordError = useCallback((cause: unknown) => {
    const raw = rawErrorMessage(cause)
    setTechnicalError(raw); setError(actionableErrorMessage(raw))
    return raw
  }, [])

  const guarded = useCallback(async <T,>(label: string, action: () => Promise<T>, success?: string) => {
    setBusy(label); setError(''); setTechnicalError('')
    try {
      const value = await action()
      if (success) notify(success, 'success')
      return value
    } catch (cause) {
      const raw = recordError(cause)
      notify(actionableErrorMessage(raw), 'error')
      throw cause
    } finally {
      setBusy('')
    }
  }, [notify, recordError])

  const loadCollection = useCallback(async () => {
    if (!projectVersionId) return
    const [nextInputs, nextDesigns] = await Promise.all([api.loadInputs(projectVersionId), api.loadDesigns(projectVersionId)])
    const projectId = nextInputs.projectVersion.projectId
    setInputs(nextInputs); setDesigns(nextDesigns.items)
    const [cases, versions, drafts, suites, nextHandoffs] = await Promise.all([api.loadLibraryCases(projectId), api.loadLibraryVersions(projectId), api.loadSuiteDrafts(projectId), api.loadSuiteVersions(projectId), api.loadLibraryHandoffs(projectVersionId)])
    setLibraryCases(cases.items); setLibraryVersions(versions.items); setSuiteDrafts(drafts.items); setSuiteVersions(suites.items); setHandoffs(nextHandoffs.items)
  }, [projectVersionId])

  const refreshRun = useCallback(async () => {
    if (!projectVersionId || !design || !run) return
    const next = await api.loadRun(projectVersionId, design.id, run.id)
    setRun(next)
    return next
  }, [projectVersionId, design, run])

  const requestAudit = useCallback(async (designId: string, runId: string, success = '服务端已重新执行覆盖检查。') => {
    if (!projectVersionId) return
    if (auditRequestRef.current) return auditRequestRef.current
    let task: Promise<TestDesignWorkflowRun | undefined>
    task = (async () => {
      setAuditRetryError('')
      try {
        await guarded('audit', () => api.reAudit(projectVersionId, designId, runId), success)
        const refreshed = await api.loadRun(projectVersionId, designId, runId)
        setRun(current => current?.id === runId ? refreshed : current)
        return refreshed
      } catch (cause) {
        recordError(cause)
        setAuditRetryError('重新覆盖检查未完成。已保存的用例修改仍然有效，请稍后重试。')
        return undefined
      } finally {
        auditRequestRef.current = null
      }
    })()
    auditRequestRef.current = task
    return task
  }, [guarded, projectVersionId])

  const refreshAndScheduleAudit = useCallback(async () => {
    const next = await refreshRun()
    if (!next || ['queued', 'running'].includes(next.status) || !next.testCases.some(item => !item.tombstonedAt)) return next
    if (next.coverageAudits.at(-1)?.status === 'valid') { setAuditRetryError(''); return next }
    return (await requestAudit(next.testDesignId, next.id)) ?? next
  }, [refreshRun, requestAudit])

  useEffect(() => {
    setInputs(null); setDesigns([]); setDesign(null); setRun(null); setLibraryCases([]); setLibraryVersions([]); setSuiteDrafts([]); setSuiteVersions([]); setHandoffs([]); setError(''); setTechnicalError(''); setAuditRetryError(''); resynthesisRunIdRef.current = null
    if (projectVersionId) void loadCollection().catch(recordError)
  }, [projectVersionId, loadCollection, recordError])
  useEffect(() => {
    if (!run || !['queued', 'running'].includes(run.status)) return
    const timer = window.setInterval(() => { void refreshRun().catch(recordError) }, LIVE_RUN_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [run, refreshRun, recordError])
  useEffect(() => {
    if (!run || resynthesisRunIdRef.current !== run.id || ['queued', 'running'].includes(run.status)) return
    resynthesisRunIdRef.current = null
    if (run.status === 'succeeded') void refreshAndScheduleAudit()
  }, [run, refreshAndScheduleAudit])

  const openDesign = useCallback(async (selected: TestDesign) => {
    if (!projectVersionId) return
    setDesign(selected); setHandoffs([]); setAuditRetryError('')
    if (!selected.latestRun) { setRun(null); return }
    const next = await guarded('load-run', () => api.loadRun(projectVersionId, selected.id, selected.latestRun!.id))
    setRun(next)
  }, [guarded, projectVersionId])

  const openLinkedRun = useCallback(async (designId: string, runId: string) => {
    if (!projectVersionId) return
    setDesign(null); setRun(null); setHandoffs([]); setAuditRetryError('')
    const linked = await guarded('load-linked-run', async () => {
      const [nextDesign, nextRun] = await Promise.all([
        api.loadDesign(projectVersionId, designId),
        api.loadRun(projectVersionId, designId, runId),
      ])
      return { design: nextDesign, run: nextRun }
    })
    setDesign(linked.design); setRun(linked.run)
  }, [guarded, projectVersionId])

  const closeDesign = useCallback(() => { setDesign(null); setRun(null); setHandoffs([]); setAuditRetryError('') }, [])

  const create = useCallback(async (input: CreateTestDesignInput) => {
    if (!projectVersionId) return
    const nextDesign = await guarded('create', () => api.createDesign(projectVersionId, input))
    const nextRun = await api.createRun(projectVersionId, nextDesign.id)
    setDesign({ ...nextDesign, latestRun: nextRun }); setRun(nextRun)
    await loadCollection(); notify('测试设计已创建，Requirement Release 与 Workspace 快照已冻结。', 'success')
  }, [guarded, loadCollection, notify, projectVersionId])

  const startRun = useCallback(async () => {
    if (!projectVersionId || !design) return
    const next = await guarded('start-run', () => api.createRun(projectVersionId, design.id), '已启动新的测试设计运行。')
    setRun(next); setHandoffs([]); setAuditRetryError('')
  }, [design, guarded, projectVersionId])

  const resynthesize = useCallback(async () => {
    if (!projectVersionId || !design || !run) return
    const next = await guarded('resynthesize', () => api.resynthesizeCases(projectVersionId, design.id, run.id), 'PlanningAgent 已开始重新生成测试用例。')
    resynthesisRunIdRef.current = next.id
    setRun(next); setAuditRetryError('')
  }, [design, guarded, projectVersionId, run])

  const reviewCases = useCallback(async () => {
    if (!projectVersionId || !design || !run) return
    const targets = run.testCases.filter(item => !item.tombstonedAt && item.reviewState === 'in_review').map(item => ({ caseId: item.id, targetRevision: item.currentRevision }))
    if (!targets.length) return
    await guarded('case-approve', () => api.batchReviewCases(projectVersionId, design.id, run.id, targets, 'approve'), '当前待审核 Revision 已批量审核通过。')
    await refreshAndScheduleAudit()
  }, [design, guarded, projectVersionId, refreshAndScheduleAudit, run])

  const createCase = useCallback(async (content: TestCaseContent) => {
    if (!projectVersionId || !design || !run) return
    await guarded('case-create', () => api.createCase(projectVersionId, design.id, run.id, content), '测试用例已创建并进入人工审核。')
    await refreshAndScheduleAudit()
  }, [design, guarded, projectVersionId, refreshAndScheduleAudit, run])

  const editCase = useCallback(async (caseId: string, content: TestCaseContent, reason: string) => {
    if (!projectVersionId || !design || !run) return
    const current = await guarded('case-load', () => api.loadCase(projectVersionId, design.id, run.id, caseId))
    await guarded('case-edit', () => api.patchCase(projectVersionId, design.id, run.id, caseId, current.etag, content, reason), '测试用例已生成新的草稿 Revision，请提交审核。')
    await refreshAndScheduleAudit()
  }, [design, guarded, projectVersionId, refreshAndScheduleAudit, run])

  const removeCase = useCallback(async (caseId: string) => {
    if (!projectVersionId || !design || !run) return
    await guarded('case-delete', () => api.deleteCase(projectVersionId, design.id, run.id, caseId), '测试用例已删除。')
    await refreshAndScheduleAudit()
  }, [design, guarded, projectVersionId, refreshAndScheduleAudit, run])

  const reviewCase = useCallback(async (caseId: string, decision: api.TestCaseReviewDecision, targetRevision: number, comment?: string) => {
    if (!projectVersionId || !design || !run) return
    const message = ({ submit: `Revision ${targetRevision} 已提交人工审核。`, approve: `Revision ${targetRevision} 已审核通过。`, reject: `Revision ${targetRevision} 已拒绝。`, request_revision: `Revision ${targetRevision} 已退回修改。`, withdraw: `Revision ${targetRevision} 已撤回审核并回到草稿。` } as const)[decision]
    await guarded(`case-${decision}`, () => api.reviewCase(projectVersionId, design.id, run.id, caseId, decision, targetRevision, comment), message)
    await refreshAndScheduleAudit()
  }, [design, guarded, projectVersionId, refreshAndScheduleAudit, run])

  const reAudit = useCallback(async () => {
    if (!design || !run) return
    await requestAudit(design.id, run.id)
  }, [design, requestAudit, run])

  const resolveIssue = useCallback(async (kind: 'finding' | 'confirmation', id: string, expectedVersion: number, decision: api.TestDesignIssueDecision = 'resolve', comment?: string) => {
    if (!projectVersionId || !design || !run) return
    const confirmationResult = kind === 'confirmation'
      ? await guarded('resolve-issue', () => api.actOnConfirmation(projectVersionId, design.id, run.id, id, { expectedVersion, decision, comment }), '人工处理已记录。')
      : undefined
    if (kind === 'finding') await guarded('resolve-issue', () => api.actOnFinding(projectVersionId, design.id, run.id, id, { expectedVersion, decision, comment }), '人工处理已记录。')
    if (confirmationResult?.requiredAction === 'resynthesize') {
      await resynthesize()
      return
    }
    await refreshAndScheduleAudit()
  }, [design, guarded, projectVersionId, refreshAndScheduleAudit, resynthesize, run])

  const decideProposal = useCallback(async (proposalId: string, decision: Exclude<CaseChangeDecision, 'pending'>, comment?: string, editedContent?: TestCaseContent) => {
    if (!projectVersionId || !design || !run) return
    const proposal = run.caseChangeProposals.find(item => item.id === proposalId)
    if (!proposal) return
    await guarded('proposal-decision', () => api.decideProposal(projectVersionId, design.id, run.id, proposalId, { expectedVersion: proposal.decisions.length, decision, comment, editedContent }), '历史用例变更决定已记录。')
    await refreshAndScheduleAudit()
  }, [design, guarded, projectVersionId, refreshAndScheduleAudit, run])

  const publish = useCallback(async (name: string) => {
    if (!projectVersionId || !design || !run) return
    const audit = [...run.coverageAudits].reverse().find(item => item.status === 'valid')
    if (!audit) {
      const cause = new Error('COVERAGE_AUDIT_STALE: 没有有效覆盖审计')
      const raw = recordError(cause); notify(actionableErrorMessage(raw), 'error')
      throw cause
    }
    const version = await guarded('publish', () => api.publishLibraryVersion(projectVersionId, design.id, run.id, { name, expectedAuditId: audit.id, expectedCaseSetSha256: audit.caseSetSha256, expectedProposalSha256: run.caseChangeProposalSha256 }), '正式测试用例版本已发布并投影到 Workspace。')
    await Promise.all([refreshRun(), loadCollection()]); return version
  }, [design, guarded, loadCollection, notify, projectVersionId, recordError, refreshRun, run])

  const handoff = useCallback(async (version: TestCaseLibraryVersion, mode: 'smoke' | 'regression' | 'full' | 'custom', suiteVersionId?: string, impactedCaseIds?: string[], executionReadinessOverrides?: ExecutionReadinessOverrideInput[]) => {
    if (!projectVersionId) return
    const created = await guarded('handoff', () => api.createLibraryHandoff(projectVersionId, version.id, { mode, expectedLibrarySha256: version.contentSha256, suiteVersionId, impactedCaseIds, executionReadinessOverrides }), '执行交接已创建并冻结执行输入。')
    setHandoffs(current => [created, ...current]); return created
  }, [guarded, projectVersionId])

  const createLibraryCase = useCallback(async (content: TestCaseContent, reason: string) => { if (!inputs) return; await guarded('library-create', () => api.createLibraryCase(inputs.projectVersion.projectId, content, reason), '正式用例已创建。'); await loadCollection() }, [guarded, inputs, loadCollection])
  const editLibraryCase = useCallback(async (testCase: LibraryTestCase, content: TestCaseContent, reason: string, traceability?: TestCaseTraceability) => { if (!inputs) return; await guarded('library-edit', () => api.editLibraryCase(inputs.projectVersion.projectId, testCase.id, testCase.etag, content, reason, traceability), '正式用例已生成新 Revision。'); await loadCollection() }, [guarded, inputs, loadCollection])
  const copyLibraryCase = useCallback(async (testCase: LibraryTestCase) => { if (!inputs) return; await guarded('library-copy', () => api.copyLibraryCase(inputs.projectVersion.projectId, testCase.id, `复制自 ${testCase.id}`), '正式用例副本已创建。'); await loadCollection() }, [guarded, inputs, loadCollection])
  const deprecateLibraryCase = useCallback(async (testCase: LibraryTestCase, reason: string) => { if (!inputs) return; await guarded('library-deprecate', () => api.deprecateLibraryCase(inputs.projectVersion.projectId, testCase.id, testCase.etag, reason), '正式用例已废弃，历史 Revision 保留。'); await loadCollection() }, [guarded, inputs, loadCollection])
  const saveSuiteDraft = useCallback(async (draft: TestSuiteDraft | undefined, value: { suiteKey: string; suiteType: 'smoke' | 'regression' | 'custom'; name: string; testCaseLibraryVersionId: string; confirmLibraryVersionChange?: boolean; members: Array<{ caseId: string; executionMethod: TestExecutionMethod; reason: string }> }) => { if (!inputs) return; if (draft) { const loaded = await api.loadSuiteDraft(inputs.projectVersion.projectId, draft.id); await guarded('suite-save', () => api.updateSuiteDraft(inputs.projectVersion.projectId, draft.id, loaded.response.headers.get('etag') ?? draft.etag ?? '', value), '测试套件草稿已保存。') } else await guarded('suite-create', () => api.createSuiteDraft(inputs.projectVersion.projectId, value), '测试套件草稿已创建。'); await loadCollection() }, [guarded, inputs, loadCollection])
  const publishSuite = useCallback(async (draft: TestSuiteDraft) => { if (!inputs) return; const loaded = await api.loadSuiteDraft(inputs.projectVersion.projectId, draft.id); await guarded('suite-publish', () => api.publishSuiteDraft(inputs.projectVersion.projectId, draft.id, loaded.response.headers.get('etag') ?? draft.etag ?? ''), '不可变测试套件版本已发布。'); await loadCollection() }, [guarded, inputs, loadCollection])
  const deprecateSuite = useCallback(async (version: LibraryTestSuiteVersion) => { if (!inputs) return; await guarded('suite-deprecate', () => api.deprecateSuiteVersion(inputs.projectVersion.projectId, version.id), '测试套件版本已废弃，历史引用保留。'); await loadCollection() }, [guarded, inputs, loadCollection])
  const previewLegacyMigration = useCallback(async (legacyTestCaseSetVersionId: string) => { if (!inputs) return; const preview = await guarded('legacy-migration-preview', () => api.previewLegacyCaseMigration(inputs.projectVersion.projectId, legacyTestCaseSetVersionId)); if (preview) setLegacyMigrationPreview(preview); return preview }, [guarded, inputs])
  const migrateLegacyCaseSet = useCallback(async (legacyTestCaseSetVersionId: string, confirmUncertain = false) => { if (!inputs) return; const preview = legacyMigrationPreview?.legacyTestCaseSetVersionId === legacyTestCaseSetVersionId ? legacyMigrationPreview : await api.previewLegacyCaseMigration(inputs.projectVersion.projectId, legacyTestCaseSetVersionId); await guarded('legacy-migration', () => api.migrateLegacyCaseSet(inputs.projectVersion.projectId, { legacyTestCaseSetVersionId, expectedPreviewSha256: preview.previewSha256, confirmUncertain }), '历史已发布用例集已幂等导入正式用例库。'); setLegacyMigrationPreview(null); await loadCollection() }, [guarded, inputs, legacyMigrationPreview, loadCollection])

  return { inputs, designs, design, run, libraryCases, libraryVersions, suiteDrafts, suiteVersions, handoffs, legacyMigrationPreview, busy, error, technicalError, auditRetryError, loadCollection, openDesign, openLinkedRun, closeDesign, create, startRun, refreshRun, resynthesize, reviewCases, createCase, editCase, removeCase, reviewCase, reAudit, resolveIssue, decideProposal, publish, handoff, createLibraryCase, editLibraryCase, copyLibraryCase, deprecateLibraryCase, saveSuiteDraft, publishSuite, deprecateSuite, previewLegacyMigration, migrateLegacyCaseSet }
}
