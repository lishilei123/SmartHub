import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../api'
import type { CreateTestDesignInput, ExecutionReadinessOverrideInput, LibraryExecutionHandoff, LibraryTestCase, LibraryTestSuiteVersion, TestCaseContent, TestCaseLibraryVersion, TestCaseTraceability, TestDesign, TestDesignInputCandidates, TestDesignRunSummary, TestDesignWorkflowRun, TestExecutionMethod, TestSuiteDraft } from '../types'

type Notify = (message: string, tone?: 'success' | 'error' | 'warning') => void
const LIVE_RUN_REFRESH_MS = 1_000

function rawErrorMessage(cause: unknown) { return cause instanceof Error ? cause.message : String(cause) }
function actionableErrorMessage(raw: string) {
  if (/COVERAGE_AUDIT_STALE|没有有效 Coverage Audit|测试设计状态已变化/u.test(raw)) return '测试用例已经发生变化，请重新执行覆盖检查。'
  if (/CASE_CHANGE_PROPOSAL_DECISION_REQUIRED/u.test(raw)) return '还有历史用例变更需要确认。'
  if (/TEST_CASE_REVIEW_REQUIRED/u.test(raw)) return '仍有测试用例尚未审核通过，无法发布正式用例库。'
  if (/TEST_CASE_LIBRARY_BASE_CHANGED|CASE_CHANGE_PROPOSAL_SOURCE_STALE|LIBRARY_TEST_CASE_REVISION_CONFLICT/u.test(raw)) return '正式用例库已发生变化，请基于最新版本重新处理后再发布。'
  if (/TEST_CASE_LIBRARY_PUBLICATION_BLOCKED/u.test(raw)) return '仍存在阻断发布的问题，请先在待处理问题中完成处置。'
  return raw
}

export function useTestDesign(projectVersionId: string | undefined, notify: Notify) {
  const [inputs, setInputs] = useState<TestDesignInputCandidates | null>(null)
  const [designs, setDesigns] = useState<TestDesign[]>([])
  const [design, setDesign] = useState<TestDesign | null>(null)
  const [run, setRun] = useState<TestDesignWorkflowRun | null>(null)
  const [runs, setRuns] = useState<TestDesignRunSummary[]>([])
  const [libraryCases, setLibraryCases] = useState<LibraryTestCase[]>([])
  const [libraryVersions, setLibraryVersions] = useState<TestCaseLibraryVersion[]>([])
  const [suiteDrafts, setSuiteDrafts] = useState<TestSuiteDraft[]>([])
  const [suiteVersions, setSuiteVersions] = useState<LibraryTestSuiteVersion[]>([])
  const [handoffs, setHandoffs] = useState<LibraryExecutionHandoff[]>([])
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
    setRuns(current => current.map(item => item.id === next.id ? { ...item, status: next.status, stage: next.stage, progress: next.progress, startedAt: next.startedAt, finishedAt: next.finishedAt, errorCode: next.errorCode, error: next.error, baseTestCaseLibraryVersionId: next.baseTestCaseLibraryVersionId, caseCount: next.candidateCaseCount ?? next.testCases.filter(testCase => !testCase.tombstonedAt).length, candidateCaseCount: next.candidateCaseCount, effectiveCaseCount: next.effectiveCaseCount, pendingManualProposalCount: next.pendingManualProposalCount ?? 0 } : item))
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
    setInputs(null); setDesigns([]); setDesign(null); setRun(null); setRuns([]); setLibraryCases([]); setLibraryVersions([]); setSuiteDrafts([]); setSuiteVersions([]); setHandoffs([]); setError(''); setTechnicalError(''); setAuditRetryError(''); resynthesisRunIdRef.current = null
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
    const history = await guarded('load-runs', () => api.loadRuns(projectVersionId, selected.id))
    setRuns(history.items)
    const selectedRunId = history.items[0]?.id
    if (!selectedRunId) { setRun(null); return }
    const next = await guarded('load-run', () => api.loadRun(projectVersionId, selected.id, selectedRunId))
    setRun(next)
  }, [guarded, projectVersionId])

  const openLinkedRun = useCallback(async (designId: string, runId: string) => {
    if (!projectVersionId) return
    setDesign(null); setRun(null); setHandoffs([]); setAuditRetryError('')
    const linked = await guarded('load-linked-run', async () => {
      const [nextDesign, nextRun, history] = await Promise.all([
        api.loadDesign(projectVersionId, designId),
        api.loadRun(projectVersionId, designId, runId),
        api.loadRuns(projectVersionId, designId),
      ])
      return { design: nextDesign, run: nextRun, runs: history.items }
    })
    setDesign(linked.design); setRun(linked.run); setRuns(linked.runs)
  }, [guarded, projectVersionId])

  const openRun = useCallback(async (runId: string) => {
    if (!projectVersionId || !design) return
    const next = await guarded('load-run', () => api.loadRun(projectVersionId, design.id, runId))
    setRun(next); setHandoffs([]); setAuditRetryError('')
  }, [design, guarded, projectVersionId])

  const closeDesign = useCallback(() => { setDesign(null); setRun(null); setRuns([]); setHandoffs([]); setAuditRetryError('') }, [])

  const create = useCallback(async (input: CreateTestDesignInput) => {
    if (!projectVersionId) return
    const nextDesign = await guarded('create', () => api.createDesign(projectVersionId, input))
    const nextRun = await api.createRun(projectVersionId, nextDesign.id)
    setDesign({ ...nextDesign, latestRun: nextRun }); setRun(nextRun); setRuns((await api.loadRuns(projectVersionId, nextDesign.id)).items)
    await loadCollection(); notify('测试设计已创建，Requirement Release 与 Workspace 快照已冻结。', 'success')
  }, [guarded, loadCollection, notify, projectVersionId])

  const startRun = useCallback(async () => {
    if (!projectVersionId || !design) return
    const next = await guarded('start-run', () => api.createRun(projectVersionId, design.id), '已启动新的测试设计运行。')
    setRun(next); setRuns((await api.loadRuns(projectVersionId, design.id)).items); setHandoffs([]); setAuditRetryError('')
  }, [design, guarded, projectVersionId])

  const resynthesize = useCallback(async () => {
    if (!projectVersionId || !design || !run) return
    const next = await guarded('resynthesize', () => api.resynthesizeCases(projectVersionId, design.id, run.id), 'PlanningAgent 已开始重新生成测试用例。')
    resynthesisRunIdRef.current = next.id
    setRun(next); setAuditRetryError('')
  }, [design, guarded, projectVersionId, run])

  const reviewCases = useCallback(async (requestedTargets?: Array<{ caseId: string; targetRevision: number }>) => {
    if (!projectVersionId || !design || !run) return
    const eligibleTargets = new Map(run.testCases.filter(item => !item.tombstonedAt && item.reviewState === 'in_review').map(item => [item.id, item.currentRevision]))
    const targets = requestedTargets
      ? requestedTargets.filter(target => eligibleTargets.get(target.caseId) === target.targetRevision)
      : [...eligibleTargets].map(([caseId, targetRevision]) => ({ caseId, targetRevision }))
    if (!targets.length) return
    await guarded('case-approve', () => api.batchReviewCases(projectVersionId, design.id, run.id, targets, 'approve'), `${targets.length} 条选中测试用例已审核通过。`)
    await refreshRun()
  }, [design, guarded, projectVersionId, refreshRun, run])

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
    await refreshRun()
  }, [design, guarded, projectVersionId, refreshRun, run])

  const reAudit = useCallback(async () => {
    if (!design || !run) return
    await requestAudit(design.id, run.id)
  }, [design, requestAudit, run])

  const publish = useCallback(async (name: string) => {
    if (!projectVersionId || !design || !run) return
    const audit = [...run.coverageAudits].reverse().find(item => item.status === 'valid')
    if (!audit) {
      const cause = new Error('COVERAGE_AUDIT_STALE: 没有有效覆盖审计')
      const raw = recordError(cause); notify(actionableErrorMessage(raw), 'error')
      throw cause
    }
    const version = await guarded('publish', () => api.publishLibraryVersion(projectVersionId, design.id, run.id, { name, expectedAuditId: audit.id, expectedCaseSetSha256: audit.caseSetSha256, expectedProposalSha256: run.caseChangeProposalSha256 }), '正式测试用例版本已发布并投影到 Workspace。')
    const [, , history] = await Promise.all([refreshRun(), loadCollection(), api.loadRuns(projectVersionId, design.id)]); setRuns(history.items); return version
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
  const saveSuiteDraft = useCallback(async (draft: TestSuiteDraft | undefined, value: api.SuiteDraftInput) => { if (!inputs) return; if (draft) { const loaded = await api.loadSuiteDraft(inputs.projectVersion.projectId, draft.id); await guarded('suite-save', () => api.updateSuiteDraft(inputs.projectVersion.projectId, draft.id, loaded.response.headers.get('etag') ?? draft.etag ?? '', value), '测试套件草稿已保存。') } else await guarded('suite-create', () => api.createSuiteDraft(inputs.projectVersion.projectId, value), '测试套件草稿已创建。'); await loadCollection() }, [guarded, inputs, loadCollection])
  const publishSuite = useCallback(async (draft: TestSuiteDraft) => { if (!inputs) return; const loaded = await api.loadSuiteDraft(inputs.projectVersion.projectId, draft.id); await guarded('suite-publish', () => api.publishSuiteDraft(inputs.projectVersion.projectId, draft.id, loaded.response.headers.get('etag') ?? draft.etag ?? ''), '不可变测试套件版本已发布。'); await loadCollection() }, [guarded, inputs, loadCollection])
  const deprecateSuite = useCallback(async (version: LibraryTestSuiteVersion) => { if (!inputs) return; await guarded('suite-deprecate', () => api.deprecateSuiteVersion(inputs.projectVersion.projectId, version.id), '测试套件版本已废弃，历史引用保留。'); await loadCollection() }, [guarded, inputs, loadCollection])

  return { inputs, designs, design, run, runs, libraryCases, libraryVersions, suiteDrafts, suiteVersions, handoffs, busy, error, technicalError, auditRetryError, loadCollection, openDesign, openLinkedRun, openRun, closeDesign, create, startRun, refreshRun, resynthesize, reviewCases, createCase, editCase, removeCase, reviewCase, reAudit, publish, handoff, createLibraryCase, editLibraryCase, copyLibraryCase, deprecateLibraryCase, saveSuiteDraft, publishSuite, deprecateSuite }
}
