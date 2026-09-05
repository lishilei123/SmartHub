import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../api'
import type { CreateTestDesignInput, ExecutionReadinessOverrideInput, LibraryExecutionHandoff, LibraryTestCase, LibraryTestSuiteVersion, TestCaseContent, TestCaseLibraryVersion, TestCaseTraceability, TestDesign, TestDesignInputCandidates, TestDesignRunSummary, TestDesignWorkflowRun, TestSuiteDraft } from '../types'

type Notify = (message: string, tone?: 'success' | 'error' | 'warning') => void
const LIVE_RUN_REFRESH_MS = 1_000
type Entry = 'designs' | 'library' | 'suites' | 'releases'
type Asset = 'cases' | 'versions' | 'drafts' | 'suites'
const PANEL_ASSETS: Record<Entry, Asset[]> = {
  designs: [], library: ['cases', 'versions', 'drafts', 'suites'],
  suites: ['cases', 'versions', 'drafts', 'suites'], releases: ['cases', 'versions'],
}

function rawErrorMessage(cause: unknown) { return cause instanceof Error ? cause.message : String(cause) }
function actionableErrorMessage(raw: string) {
  if (/COVERAGE_AUDIT_STALE|没有有效 Coverage Audit|测试设计状态已变化/u.test(raw)) return '测试用例已经发生变化，请重新执行覆盖检查。'
  if (/CASE_CHANGE_PROPOSAL_DECISION_REQUIRED/u.test(raw)) return '还有历史用例变更需要确认。'
  if (/TEST_CASE_REVIEW_REQUIRED/u.test(raw)) return '仍有测试用例尚未审核通过，无法发布正式用例库。'
  if (/TEST_CASE_LIBRARY_BASE_CHANGED|CASE_CHANGE_PROPOSAL_SOURCE_STALE|LIBRARY_TEST_CASE_REVISION_CONFLICT/u.test(raw)) return '正式用例库已发生变化，请基于最新版本重新处理后再发布。'
  if (/TEST_CASE_LIBRARY_PUBLICATION_BLOCKED/u.test(raw)) return '仍存在阻断发布的问题，请先在待处理问题中完成处置。'
  return raw
}

export function useTestDesign(projectVersionId: string | undefined, notify: Notify, entry: Entry = 'designs') {
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
  const projectRef = useRef({ id: projectVersionId })
  const selectionRef = useRef({})
  if (projectRef.current.id !== projectVersionId) {
    projectRef.current = { id: projectVersionId }
    selectionRef.current = {}
  }
  const projectScope = projectRef.current
  const viewScope = selectionRef.current
  const entryRef = useRef(entry)
  entryRef.current = entry
  const collectionRequestRef = useRef(0)
  const busyRequestRef = useRef(0)
  const assetsRef = useRef(new Map<Asset, { project: typeof projectScope; task: Promise<void> }>())
  const runRequestRef = useRef<{ scope: object; task: Promise<TestDesignWorkflowRun | undefined> } | null>(null)
  const currentProject = useCallback(() => projectRef.current === projectScope, [projectScope])
  const currentView = useCallback(() => currentProject() && selectionRef.current === viewScope, [currentProject, viewScope])

  const recordError = useCallback((cause: unknown) => {
    const raw = rawErrorMessage(cause)
    setTechnicalError(raw); setError(actionableErrorMessage(raw))
    return raw
  }, [])

  const guarded = useCallback(async <T,>(label: string, action: () => Promise<T>, success?: string) => {
    const scope = selectionRef.current
    const requestId = ++busyRequestRef.current
    const isCurrent = () => currentProject() && selectionRef.current === scope
    if (isCurrent()) { setBusy(label); setError(''); setTechnicalError('') }
    try {
      const value = await action()
      if (isCurrent() && success) notify(success, 'success')
      return value
    } catch (cause) {
      if (isCurrent()) {
        const raw = recordError(cause)
        notify(actionableErrorMessage(raw), 'error')
      }
      throw cause
    } finally {
      if (isCurrent() && busyRequestRef.current === requestId) setBusy('')
    }
  }, [currentProject, notify, recordError])

  const loadAssets = useCallback(async (projectId: string, resources: Asset[], force = false) => {
    if (!currentProject()) return
    await Promise.all(resources.map(resource => {
      const cached = assetsRef.current.get(resource)
      if (!force && cached?.project === projectScope) return cached.task
      const request = { project: projectScope, task: Promise.resolve() }
      const isCurrent = () => currentProject() && assetsRef.current.get(resource) === request
      request.task = (async () => {
        if (resource === 'cases') { const result = await api.loadLibraryCases(projectId); if (isCurrent()) setLibraryCases(result.items) }
        if (resource === 'versions') { const result = await api.loadLibraryVersions(projectId); if (isCurrent()) setLibraryVersions(result.items) }
        if (resource === 'drafts') { const result = await api.loadSuiteDrafts(projectId); if (isCurrent()) setSuiteDrafts(result.items) }
        if (resource === 'suites') { const result = await api.loadSuiteVersions(projectId); if (isCurrent()) setSuiteVersions(result.items) }
      })().catch(cause => {
        if (isCurrent()) assetsRef.current.delete(resource)
        throw cause
      })
      assetsRef.current.set(resource, request)
      return request.task
    }))
  }, [currentProject, projectScope])

  const loadCollection = useCallback(async () => {
    if (!projectVersionId || !currentProject()) return
    const requestId = ++collectionRequestRef.current
    const [nextInputs, nextDesigns] = await Promise.all([api.loadInputs(projectVersionId), api.loadDesigns(projectVersionId)])
    if (!currentProject() || collectionRequestRef.current !== requestId) return
    setInputs(nextInputs); setDesigns(nextDesigns.items)
    const previouslyLoaded = [...assetsRef.current.entries()].filter(([, value]) => value.project === projectScope).map(([key]) => key)
    await loadAssets(nextInputs.projectVersion.projectId, [...new Set([...PANEL_ASSETS[entryRef.current], ...previouslyLoaded])], true)
  }, [currentProject, loadAssets, projectScope, projectVersionId])

  const refreshRun = useCallback(async (afterMutation = false) => {
    if (!projectVersionId || !design || !run || !currentView()) return
    if (runRequestRef.current?.scope === viewScope) {
      if (!afterMutation) return runRequestRef.current.task
      await runRequestRef.current.task.catch(() => undefined)
      if (!currentView()) return
      if (runRequestRef.current?.scope === viewScope) return runRequestRef.current.task
    }
    const request = { scope: viewScope, task: Promise.resolve<TestDesignWorkflowRun | undefined>(undefined) }
    request.task = (async () => {
      const next = await api.loadRun(projectVersionId, design.id, run.id)
      if (!currentView()) return
      setRun(next)
      setRuns(current => current.map(item => item.id === next.id ? { ...item, status: next.status, stage: next.stage, progress: next.progress, startedAt: next.startedAt, finishedAt: next.finishedAt, errorCode: next.errorCode, error: next.error, baseTestCaseLibraryVersionId: next.baseTestCaseLibraryVersionId, caseCount: next.candidateCaseCount ?? next.testCases.filter(testCase => !testCase.tombstonedAt).length, candidateCaseCount: next.candidateCaseCount, effectiveCaseCount: next.effectiveCaseCount, pendingManualProposalCount: next.pendingManualProposalCount ?? 0 } : item))
      return next
    })().finally(() => { if (runRequestRef.current === request) runRequestRef.current = null })
    runRequestRef.current = request
    return request.task
  }, [projectVersionId, design?.id, run?.id, currentView, viewScope])

  const requestAudit = useCallback(async (designId: string, runId: string, success = '服务端已重新执行覆盖检查。') => {
    if (!projectVersionId || !currentView()) return
    if (auditRequestRef.current) return auditRequestRef.current
    const task = (async () => {
      setAuditRetryError('')
      try {
        await guarded('audit', () => api.reAudit(projectVersionId, designId, runId), success)
        if (!currentView()) return
        return await refreshRun(true)
      } catch (cause) {
        if (currentView()) {
          recordError(cause)
          setAuditRetryError('重新覆盖检查未完成。已保存的用例修改仍然有效，请稍后重试。')
        }
        return undefined
      }
    })()
    auditRequestRef.current = task
    void task.finally(() => { if (auditRequestRef.current === task) auditRequestRef.current = null })
    return task
  }, [currentView, guarded, projectVersionId, recordError, refreshRun])

  const refreshAndScheduleAudit = useCallback(async () => {
    const next = await refreshRun(true)
    if (!next || ['queued', 'running'].includes(next.status) || !next.testCases.some(item => !item.tombstonedAt)) return next
    if (next.coverageAudits.at(-1)?.status === 'valid') { setAuditRetryError(''); return next }
    return (await requestAudit(next.testDesignId, next.id)) ?? next
  }, [refreshRun, requestAudit])

  useEffect(() => {
    setInputs(null); setDesigns([]); setDesign(null); setRun(null); setRuns([]); setLibraryCases([]); setLibraryVersions([]); setSuiteDrafts([]); setSuiteVersions([]); setHandoffs([]); setError(''); setTechnicalError(''); setAuditRetryError(''); resynthesisRunIdRef.current = null
    setBusy(''); auditRequestRef.current = null; assetsRef.current.clear()
    if (projectVersionId) void loadCollection().catch(cause => { if (currentProject()) recordError(cause) })
  }, [projectVersionId, loadCollection, recordError, currentProject])
  useEffect(() => {
    if (!inputs || inputs.projectVersion.id !== projectVersionId) return
    const resources = entry === 'designs' && design ? ['versions' as const] : PANEL_ASSETS[entry]
    void loadAssets(inputs.projectVersion.projectId, resources).catch(cause => { if (currentProject()) recordError(cause) })
  }, [inputs, projectVersionId, entry, design?.id, loadAssets, currentProject, recordError])
  useEffect(() => {
    if (entry !== 'designs' || !run || !['queued', 'running'].includes(run.status)) return
    let disposed = false
    let timer: number
    const poll = async () => {
      try { await refreshRun() } catch (cause) { if (!disposed && currentView()) recordError(cause) }
      if (!disposed) timer = window.setTimeout(() => { void poll() }, LIVE_RUN_REFRESH_MS)
    }
    timer = window.setTimeout(() => { void poll() }, LIVE_RUN_REFRESH_MS)
    return () => { disposed = true; window.clearTimeout(timer) }
  }, [entry, run?.id, run?.status, refreshRun, currentView, recordError])
  useEffect(() => {
    if (!run || resynthesisRunIdRef.current !== run.id || ['queued', 'running'].includes(run.status)) return
    resynthesisRunIdRef.current = null
    if (run.status === 'succeeded') void refreshAndScheduleAudit()
  }, [run, refreshAndScheduleAudit])

  const selectView = useCallback(() => {
    selectionRef.current = {}
    auditRequestRef.current = null
    resynthesisRunIdRef.current = null
    setBusy(''); setError(''); setTechnicalError(''); setAuditRetryError('')
    const scope = selectionRef.current
    return () => currentProject() && selectionRef.current === scope
  }, [currentProject])

  const openDesign = useCallback(async (selected: TestDesign) => {
    if (!projectVersionId || !currentProject()) return
    const isCurrent = selectView()
    setDesign(selected); setRun(null); setRuns([])
    const history = await guarded('load-runs', () => api.loadRuns(projectVersionId, selected.id))
    if (!isCurrent()) return
    setRuns(history.items)
    const selectedRunId = history.items[0]?.id
    if (!selectedRunId) return
    const next = await guarded('load-run', () => api.loadRun(projectVersionId, selected.id, selectedRunId))
    if (isCurrent()) setRun(next)
  }, [guarded, projectVersionId, currentProject, selectView])

  const openLinkedRun = useCallback(async (designId: string, runId: string) => {
    if (!projectVersionId || !currentProject()) return
    const isCurrent = selectView()
    setDesign(null); setRun(null); setRuns([])
    const linked = await guarded('load-linked-run', async () => {
      const [nextDesign, nextRun, history] = await Promise.all([
        api.loadDesign(projectVersionId, designId),
        api.loadRun(projectVersionId, designId, runId),
        api.loadRuns(projectVersionId, designId),
      ])
      return { design: nextDesign, run: nextRun, runs: history.items }
    })
    if (!isCurrent()) return
    setDesign(linked.design); setRun(linked.run); setRuns(linked.runs)
  }, [guarded, projectVersionId, currentProject, selectView])

  const openRun = useCallback(async (runId: string) => {
    if (!projectVersionId || !design || !currentView()) return
    const isCurrent = selectView()
    setRun(null)
    const next = await guarded('load-run', () => api.loadRun(projectVersionId, design.id, runId))
    if (isCurrent()) setRun(next)
  }, [design, guarded, projectVersionId, currentView, selectView])

  const closeDesign = useCallback(() => { selectView(); setDesign(null); setRun(null); setRuns([]) }, [selectView])

  const loadPublicationAssets = useCallback(async () => {
    if (!inputs || !currentView()) return
    await guarded('publication-assets', () => loadAssets(inputs.projectVersion.projectId, ['cases', 'versions'], true))
    return currentView()
  }, [inputs, currentView, guarded, loadAssets])

  const create = useCallback(async (input: CreateTestDesignInput) => {
    if (!projectVersionId || !currentProject()) return
    const isCurrent = selectView()
    const created = await guarded('create', async () => {
      const nextDesign = await api.createDesign(projectVersionId, input)
      const nextRun = await api.createRun(projectVersionId, nextDesign.id)
      const history = await api.loadRuns(projectVersionId, nextDesign.id)
      return { nextDesign, nextRun, history }
    }, '测试设计已创建，Requirement Release 与 Workspace 快照已冻结。')
    if (!isCurrent()) return
    setDesign({ ...created.nextDesign, latestRun: created.nextRun }); setRun(created.nextRun); setRuns(created.history.items)
    await loadCollection()
  }, [guarded, loadCollection, projectVersionId, currentProject, selectView])

  const startRun = useCallback(async () => {
    if (!projectVersionId || !design || !currentView()) return
    const isCurrent = selectView()
    setRun(null)
    const next = await guarded('start-run', () => api.createRun(projectVersionId, design.id), '已启动新的测试设计运行。')
    if (!isCurrent()) return
    setRun(next)
    const history = await api.loadRuns(projectVersionId, design.id)
    if (isCurrent()) setRuns(history.items)
  }, [design, guarded, projectVersionId, currentView, selectView])

  const resynthesize = useCallback(async () => {
    if (!projectVersionId || !design || !run || !currentView()) return
    const isCurrent = selectView()
    const next = await guarded('resynthesize', () => api.resynthesizeCases(projectVersionId, design.id, run.id), 'PlanningAgent 已开始重新生成测试用例。')
    if (!isCurrent()) return
    resynthesisRunIdRef.current = next.id
    setRun(next); setAuditRetryError('')
  }, [design, guarded, projectVersionId, run, currentView, selectView])

  const reviewCases = useCallback(async (requestedTargets?: Array<{ caseId: string; targetRevision: number }>) => {
    if (!projectVersionId || !design || !run || !currentView()) return
    const eligibleTargets = new Map(run.testCases.filter(item => !item.tombstonedAt && item.reviewState === 'in_review').map(item => [item.id, item.currentRevision]))
    const targets = requestedTargets
      ? requestedTargets.filter(target => eligibleTargets.get(target.caseId) === target.targetRevision)
      : [...eligibleTargets].map(([caseId, targetRevision]) => ({ caseId, targetRevision }))
    if (!targets.length) return
    await guarded('case-approve', () => api.batchReviewCases(projectVersionId, design.id, run.id, targets, 'approve'), `${targets.length} 条选中测试用例已审核通过。`)
    await refreshRun(true)
  }, [design, guarded, projectVersionId, refreshRun, run, currentView])

  const createCase = useCallback(async (content: TestCaseContent) => {
    if (!projectVersionId || !design || !run || !currentView()) return
    await guarded('case-create', () => api.createCase(projectVersionId, design.id, run.id, content), '测试用例已创建并进入人工审核。')
    await refreshAndScheduleAudit()
  }, [design, guarded, projectVersionId, refreshAndScheduleAudit, run, currentView])

  const editCase = useCallback(async (caseId: string, content: TestCaseContent, reason: string) => {
    if (!projectVersionId || !design || !run || !currentView()) return
    const current = await guarded('case-load', () => api.loadCase(projectVersionId, design.id, run.id, caseId))
    if (!currentView()) return
    await guarded('case-edit', () => api.patchCase(projectVersionId, design.id, run.id, caseId, current.etag, content, reason), '测试用例已生成新的草稿 Revision，请提交审核。')
    await refreshAndScheduleAudit()
  }, [design, guarded, projectVersionId, refreshAndScheduleAudit, run, currentView])

  const removeCase = useCallback(async (caseId: string) => {
    if (!projectVersionId || !design || !run || !currentView()) return
    await guarded('case-delete', () => api.deleteCase(projectVersionId, design.id, run.id, caseId), '测试用例已删除。')
    await refreshAndScheduleAudit()
  }, [design, guarded, projectVersionId, refreshAndScheduleAudit, run, currentView])

  const reviewCase = useCallback(async (caseId: string, decision: api.TestCaseReviewDecision, targetRevision: number, comment?: string) => {
    if (!projectVersionId || !design || !run || !currentView()) return
    const message = ({ submit: `Revision ${targetRevision} 已提交人工审核。`, approve: `Revision ${targetRevision} 已审核通过。`, reject: `Revision ${targetRevision} 已拒绝。`, request_revision: `Revision ${targetRevision} 已退回修改。`, withdraw: `Revision ${targetRevision} 已撤回审核并回到草稿。` } as const)[decision]
    await guarded(`case-${decision}`, () => api.reviewCase(projectVersionId, design.id, run.id, caseId, decision, targetRevision, comment), message)
    await refreshRun(true)
  }, [design, guarded, projectVersionId, refreshRun, run, currentView])

  const reAudit = useCallback(async () => {
    if (!design || !run) return
    await requestAudit(design.id, run.id)
  }, [design, requestAudit, run])

  const publish = useCallback(async (name: string) => {
    if (!projectVersionId || !design || !run || !currentView()) return
    const audit = [...run.coverageAudits].reverse().find(item => item.status === 'valid')
    if (!audit) {
      const cause = new Error('COVERAGE_AUDIT_STALE: 没有有效覆盖审计')
      const raw = recordError(cause); notify(actionableErrorMessage(raw), 'error')
      throw cause
    }
    const version = await guarded('publish', () => api.publishLibraryVersion(projectVersionId, design.id, run.id, { name, expectedAuditId: audit.id, expectedCaseSetSha256: audit.caseSetSha256, expectedProposalSha256: run.caseChangeProposalSha256 }), '正式测试用例版本已发布并投影到 Workspace。')
    if (!currentView()) return
    const [, , history] = await Promise.all([refreshRun(true), loadCollection(), api.loadRuns(projectVersionId, design.id)])
    if (!currentView()) return
    setRuns(history.items); return version
  }, [design, guarded, loadCollection, notify, projectVersionId, recordError, refreshRun, run, currentView])

  const handoff = useCallback(async (version: TestCaseLibraryVersion, mode: 'smoke' | 'regression' | 'full' | 'custom', suiteVersionId?: string, impactedCaseIds?: string[], executionReadinessOverrides?: ExecutionReadinessOverrideInput[]) => {
    if (!projectVersionId || !currentProject()) return
    const created = await guarded('handoff', () => api.createLibraryHandoff(projectVersionId, version.id, { mode, expectedLibrarySha256: version.contentSha256, suiteVersionId, impactedCaseIds, executionReadinessOverrides }), '执行交接已创建并冻结执行输入。')
    if (!currentProject()) return
    setHandoffs(current => [created, ...current]); return created
  }, [guarded, projectVersionId, currentProject])

  const createLibraryCase = useCallback(async (content: TestCaseContent, reason: string) => { if (!inputs || !currentProject()) return; await guarded('library-create', () => api.createLibraryCase(inputs.projectVersion.projectId, content, reason), '正式用例已创建。'); await loadCollection() }, [guarded, inputs, loadCollection, currentProject])
  const editLibraryCase = useCallback(async (testCase: LibraryTestCase, content: TestCaseContent, reason: string, traceability?: TestCaseTraceability) => { if (!inputs || !currentProject()) return; await guarded('library-edit', () => api.editLibraryCase(inputs.projectVersion.projectId, testCase.id, testCase.etag, content, reason, traceability), '正式用例已生成新 Revision。'); await loadCollection() }, [guarded, inputs, loadCollection, currentProject])
  const copyLibraryCase = useCallback(async (testCase: LibraryTestCase) => { if (!inputs || !currentProject()) return; await guarded('library-copy', () => api.copyLibraryCase(inputs.projectVersion.projectId, testCase.id, `复制自 ${testCase.id}`), '正式用例副本已创建。'); await loadCollection() }, [guarded, inputs, loadCollection, currentProject])
  const deprecateLibraryCase = useCallback(async (testCase: LibraryTestCase, reason: string) => { if (!inputs || !currentProject()) return; await guarded('library-deprecate', () => api.deprecateLibraryCase(inputs.projectVersion.projectId, testCase.id, testCase.etag, reason), '正式用例已废弃，历史 Revision 保留。'); await loadCollection() }, [guarded, inputs, loadCollection, currentProject])
  const saveSuiteDraft = useCallback(async (draft: TestSuiteDraft | undefined, value: api.SuiteDraftInput) => { if (!inputs || !currentProject()) return; if (draft) { const loaded = await api.loadSuiteDraft(inputs.projectVersion.projectId, draft.id); if (!currentProject()) return; await guarded('suite-save', () => api.updateSuiteDraft(inputs.projectVersion.projectId, draft.id, loaded.response.headers.get('etag') ?? draft.etag ?? '', value), '测试套件草稿已保存。') } else await guarded('suite-create', () => api.createSuiteDraft(inputs.projectVersion.projectId, value), '测试套件草稿已创建。'); await loadCollection() }, [guarded, inputs, loadCollection, currentProject])
  const publishSuite = useCallback(async (draft: TestSuiteDraft) => { if (!inputs || !currentProject()) return; const loaded = await api.loadSuiteDraft(inputs.projectVersion.projectId, draft.id); if (!currentProject()) return; await guarded('suite-publish', () => api.publishSuiteDraft(inputs.projectVersion.projectId, draft.id, loaded.response.headers.get('etag') ?? draft.etag ?? ''), '不可变测试套件版本已发布。'); await loadCollection() }, [guarded, inputs, loadCollection, currentProject])
  const deprecateSuite = useCallback(async (version: LibraryTestSuiteVersion) => { if (!inputs || !currentProject()) return; await guarded('suite-deprecate', () => api.deprecateSuiteVersion(inputs.projectVersion.projectId, version.id), '测试套件版本已废弃，历史引用保留。'); await loadCollection() }, [guarded, inputs, loadCollection, currentProject])

  return { inputs, designs, design, run, runs, libraryCases, libraryVersions, suiteDrafts, suiteVersions, handoffs, busy, error, technicalError, auditRetryError, loadCollection, loadPublicationAssets, openDesign, openLinkedRun, openRun, closeDesign, create, startRun, refreshRun, resynthesize, reviewCases, createCase, editCase, removeCase, reviewCase, reAudit, publish, handoff, createLibraryCase, editLibraryCase, copyLibraryCase, deprecateLibraryCase, saveSuiteDraft, publishSuite, deprecateSuite }
}
