import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, BookOpen, CheckCircle2, Clock3, Download, FileText, Filter, GitBranch, History, Play, RefreshCw, ShieldCheck, Square, Upload, XCircle } from 'lucide-react'
import type { ProjectVersion } from './project-version-api'
import { uploadKnowledgeArchive, uploadKnowledgeFile, waitForTaskResults } from './knowledge-api'
import { actOnTechnicalFinding, cancelTechnicalRun, createTechnicalReview, createTechnicalRun, downloadTechnicalReport, loadTechnicalBaselines, loadTechnicalFindingActions, loadTechnicalFixedContent, loadTechnicalReviews, loadTechnicalRun, loadTechnicalRuns, loadTechnicalSolutionAssets, type CoverageStatus, type FindingActionsResponse, type FindingState, type TechnicalBaseline, type TechnicalEvidence, type TechnicalFormalResult, type TechnicalReview, type TechnicalRun, type TechnicalRunSummary, type TechnicalSolutionAsset } from './technical-solution-review-api'
import { TechnicalDocumentViewer, type TechnicalDocument } from './TechnicalDocumentViewer'
import { versionDocumentDirectory, versionDocumentPath } from './version-document-path'
import './technical-solution-review.css'
import './technical-solution-sources.css'

type Notify = (message: string, tone?: 'success' | 'error' | 'warning') => void
type Tab = 'overview' | 'coverage' | 'findings' | 'risks' | 'evidence' | 'history'
type UploadProgress = { stage: 'reading' | 'submitting' | 'processing' | 'refreshing' | 'completed' | 'failed'; percent: number; detail: string }

export function TechnicalSolutionReviewPage({ projectVersion, knowledgeBaseId, apiState, refreshKnowledge, onManageVersions, onOpenKnowledge, notify, addAudit }: { projectVersion: ProjectVersion | null; knowledgeBaseId: string; apiState: 'connecting' | 'ready' | 'offline'; refreshKnowledge: () => Promise<void>; onManageVersions: () => void; onOpenKnowledge: () => void; notify: Notify; addAudit: (entry: string) => void }) {
  const projectVersionId = projectVersion?.id ?? ''
  const initial = useMemo(() => routeContext(), [])
  const [baselines, setBaselines] = useState<TechnicalBaseline[]>([])
  const [assets, setAssets] = useState<TechnicalSolutionAsset[]>([])
  const [reviews, setReviews] = useState<TechnicalReview[]>([])
  const [selectedBaseline, setSelectedBaseline] = useState('')
  const [selectedAssets, setSelectedAssets] = useState<string[]>([])
  const [reviewName, setReviewName] = useState('技术方案评审')
  const [agentReady, setAgentReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [reviewId, setReviewId] = useState(initial.technicalReviewId)
  const [runId, setRunId] = useState(initial.runId)
  const [run, setRun] = useState<TechnicalRun | null>(null)
  const [runs, setRuns] = useState<TechnicalRunSummary[]>([])
  const [tab, setTab] = useState<Tab>('overview')
  const [selectedFindingId, setSelectedFindingId] = useState('')
  const [actions, setActions] = useState<FindingActionsResponse>({ actions: [], findings: [] })
  const [severity, setSeverity] = useState('all')
  const [findingType, setFindingType] = useState('all')
  const [findingState, setFindingState] = useState('all')
  const [coverageStatus, setCoverageStatus] = useState<'all' | CoverageStatus>('all')
  const [document, setDocument] = useState<TechnicalDocument | null>(null)
  const [comment, setComment] = useState('')
  const [acting, setActing] = useState(false)
  const [uploadState, setUploadState] = useState<'idle' | 'running'>('idle')
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null)
  const pollRef = useRef<number | undefined>(undefined)
  const uploadRef = useRef<HTMLInputElement>(null)
  const technicalUploadDirectory = projectVersion ? versionDocumentDirectory(projectVersion.name, '技术方案') : ''

  const refreshInputs = useCallback(async () => {
    if (!projectVersionId) return []
    setLoading(true)
    try {
      const [baselineResponse, assetResponse, reviewResponse] = await Promise.all([loadTechnicalBaselines(projectVersionId), loadTechnicalSolutionAssets(projectVersionId), loadTechnicalReviews(projectVersionId)])
      setBaselines(baselineResponse.items); setAssets(assetResponse.items); setReviews(reviewResponse.items); setAgentReady(Boolean(baselineResponse.agentConfiguration))
      setSelectedBaseline(current => current || baselineResponse.items[0]?.id || '')
      return assetResponse.items
    } catch (error) { notify(message(error), 'error'); return [] }
    finally { setLoading(false) }
  }, [projectVersionId, notify])

  const loadRunContext = useCallback(async (technicalReviewId: string, technicalRunId: string) => {
    if (!projectVersionId || !technicalReviewId || !technicalRunId) return
    try {
      const [detail, history] = await Promise.all([loadTechnicalRun(projectVersionId, technicalReviewId, technicalRunId), loadTechnicalRuns(projectVersionId, technicalReviewId)])
      setRun(detail); setRuns(history.items); setReviewId(technicalReviewId); setRunId(technicalRunId)
      if (detail.status === 'succeeded') {
        const actionResponse = await loadTechnicalFindingActions(projectVersionId, technicalReviewId, technicalRunId)
        setActions(actionResponse)
        setSelectedFindingId(current => detail.result?.findings.some(item => item.id === current) ? current : detail.result?.findings[0]?.id ?? '')
      }
    } catch (error) { notify(message(error), 'error') }
  }, [projectVersionId, notify])

  useEffect(() => { void refreshInputs() }, [refreshInputs])
  useEffect(() => {
    if (uploadProgress?.stage !== 'completed') return
    const timer = window.setTimeout(() => setUploadProgress(current => current?.stage === 'completed' ? null : current), 5_000)
    return () => window.clearTimeout(timer)
  }, [uploadProgress?.stage])
  useEffect(() => {
    const restore = () => { const context = routeContext(); setReviewId(context.technicalReviewId); setRunId(context.runId); setDocument(null) }
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [])
  useEffect(() => { if (projectVersionId && reviewId && runId) void loadRunContext(reviewId, runId) }, [projectVersionId, reviewId, runId, loadRunContext])
  useEffect(() => {
    if (pollRef.current) window.clearInterval(pollRef.current)
    if (!run || !['queued', 'running'].includes(run.status)) return
    pollRef.current = window.setInterval(() => void loadRunContext(run.technicalReviewId, run.runId), 1_500)
    return () => { if (pollRef.current) window.clearInterval(pollRef.current) }
  }, [run?.status, run?.technicalReviewId, run?.runId, loadRunContext])

  const start = async () => {
    if (!projectVersionId || !selectedBaseline || !selectedAssets.length) return
    setStarting(true)
    try {
      const review = await createTechnicalReview(projectVersionId, { name: reviewName, sourceReviewRunId: selectedBaseline, solutionAssetVersionIds: selectedAssets })
      const created = await createTechnicalRun(projectVersionId, review.id)
      setReviewId(review.id); setRunId(created.runId); setRun(created); updateRoute(review.id, created.runId); notify('技术方案评审已进入运行队列')
      await refreshInputs()
    } catch (error) { notify(message(error), 'error') }
    finally { setStarting(false) }
  }
  const uploadTechnicalSolutions = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    if (!files.length || !projectVersion || projectVersion.status !== 'open' || !knowledgeBaseId || apiState !== 'ready' || uploadState === 'running') return
    setUploadState('running')
    setUploadProgress({ stage: 'reading', percent: 2, detail: `正在读取 ${files.length} 个文件` })
    const taskIds: string[] = []
    const assetVersionIds: string[] = []
    let documentCount = 0
    let attachmentCount = 0
    let skippedCount = 0
    let deduplicatedCount = 0
    try {
      for (const [fileIndex, file] of files.entries()) {
        setUploadProgress({ stage: 'submitting', percent: 5 + Math.round(fileIndex / files.length * 15), detail: `正在提交 ${file.name}（${fileIndex + 1}/${files.length}）` })
        const extension = file.name.split('.').at(-1)?.toLowerCase()
        if (extension === 'zip') {
          const result = await uploadKnowledgeArchive(knowledgeBaseId, file, technicalUploadDirectory, 'technical_design')
          taskIds.push(...result.taskIds); assetVersionIds.push(...result.assetVersionIds)
          documentCount += result.documents; attachmentCount += result.attachments; skippedCount += result.skipped; deduplicatedCount += result.deduplicated
          addAudit(`上传技术方案压缩包：${file.name} · ${result.documents} 篇文档`)
        } else if (extension === 'md' || extension === 'txt') {
          const result = await uploadKnowledgeFile(knowledgeBaseId, file, versionDocumentPath(projectVersion.name, '技术方案', file.name), 'technical_design')
          documentCount += 1; assetVersionIds.push(result.version.id)
          if (result.task?.id) taskIds.push(result.task.id)
          if (result.deduplicated) deduplicatedCount += 1
          addAudit(`上传技术方案文档：${file.name}`)
        } else skippedCount += 1
      }
      if (!documentCount) throw new Error('没有可上传的技术方案文档，仅支持 Markdown、TXT 或包含这些文件的 ZIP。')
      const taskResults = taskIds.length ? await waitForTaskResults(taskIds, { onProgress: progress => setUploadProgress({ stage: 'processing', percent: 20 + Math.round(progress.percent * .65), detail: `${taskStepLabel(progress.currentStep)} · ${progress.completed}/${progress.total} 个任务完成` }) }) : { succeeded: [], failed: [], cancelled: [], pending: [] }
      setUploadProgress({ stage: 'refreshing', percent: 90, detail: '正在刷新活动索引和技术方案资料列表' })
      await refreshKnowledge()
      const refreshedAssets = await refreshInputs()
      const uploaded = [...new Set(assetVersionIds)].filter(id => refreshedAssets.some(item => item.assetVersionId === id))
      setSelectedAssets(current => [...new Set([...current, ...uploaded])].slice(0, 10))
      const failures = [...taskResults.failed.map(task => task.error ?? `${task.id} 处理失败`), ...taskResults.cancelled.map(task => `${task.id} 已取消`), ...taskResults.pending.map(task => `${task.id} 仍在处理`)]
      if (!uploaded.length) throw new Error(failures[0] ?? '技术方案已提交，但尚未进入当前活动索引，请稍后刷新。')
      const summary = `技术方案已入库：${uploaded.length} 篇并自动勾选${attachmentCount ? `、${attachmentCount} 个附件` : ''}${deduplicatedCount ? `，${deduplicatedCount} 篇内容已去重` : ''}${skippedCount ? `，跳过 ${skippedCount} 个不支持文件` : ''}；目录：/${technicalUploadDirectory}`
      setUploadProgress({ stage: 'completed', percent: 100, detail: summary })
      if (failures.length) notify(`${summary}；另有 ${failures.length} 项未完成`, 'warning')
      else notify(summary)
    } catch (error) {
      await refreshKnowledge().catch(() => undefined)
      const detail = message(error)
      setUploadProgress(current => ({ stage: 'failed', percent: current?.percent ?? 0, detail }))
      notify(detail, 'error')
    } finally { setUploadState('idle') }
  }
  const rerun = async () => { if (!projectVersionId || !reviewId) return; setStarting(true); try { const created = await createTechnicalRun(projectVersionId, reviewId); setRunId(created.runId); setRun(created); updateRoute(reviewId, created.runId); notify('已创建新的技术方案评审运行') } catch (error) { notify(message(error), 'error') } finally { setStarting(false) } }
  const cancel = async () => { if (!run) return; try { setRun(await cancelTechnicalRun(projectVersionId, run.technicalReviewId, run.runId)); notify('已取消技术方案评审', 'warning') } catch (error) { notify(message(error), 'error') } }
  const selectRun = (item: TechnicalRunSummary) => { setReviewId(item.technicalReviewId); setRunId(item.runId); updateRoute(item.technicalReviewId, item.runId); setTab('overview'); setDocument(null) }
  const openEvidence = async (evidence: TechnicalEvidence) => { if (!run) return; try { const value = await loadTechnicalFixedContent(projectVersionId, run.technicalReviewId, run.runId, evidence.assetVersionId); if (value.contentSha256 !== evidence.contentSha256) throw new Error('固定正文 Hash 与 Evidence 不一致'); const title = run.snapshot.solutionInputs.find(item => item.assetVersionId === evidence.assetVersionId)?.displayName ?? (evidence.sourceKind === 'requirement' ? '冻结需求原文' : '技术方案原文'); setDocument({ assetVersionId: evidence.assetVersionId, title, content: value.content, evidence }) } catch (error) { notify(message(error), 'error') } }
  const exportReport = async () => { if (!run) return; try { const blob = await downloadTechnicalReport(projectVersionId, run.technicalReviewId, run.runId); const url = URL.createObjectURL(blob); const anchor = window.document.createElement('a'); anchor.href = url; anchor.download = `技术方案评审-${run.runId.slice(-8)}.md`; anchor.click(); URL.revokeObjectURL(url); notify('Markdown 报告已导出') } catch (error) { notify(message(error), 'error') } }

  if (!projectVersion) return <section className="tech-empty"><FileText /><h2>请先选择项目版本</h2><p>技术方案评审必须固定到明确的项目版本。</p></section>
  if (!run) return <InputSelection loading={loading} projectVersion={projectVersion} baselines={baselines} assets={assets} reviews={reviews} selectedBaseline={selectedBaseline} setSelectedBaseline={setSelectedBaseline} selectedAssets={selectedAssets} setSelectedAssets={setSelectedAssets} reviewName={reviewName} setReviewName={setReviewName} agentReady={agentReady} starting={starting} start={start} openHistory={item => item.latestRun && selectRun(item.latestRun)} refresh={() => void refreshInputs()} uploadRef={uploadRef} uploadState={uploadState} uploadProgress={uploadProgress} uploadDirectory={technicalUploadDirectory} apiState={apiState} upload={uploadTechnicalSolutions} onManageVersions={onManageVersions} onOpenKnowledge={onOpenKnowledge} />

  const result = run.result
  const selectedFinding = result?.findings.find(item => item.id === selectedFindingId) ?? null
  const currentProjection = selectedFinding ? actions.findings.find(item => item.findingId === selectedFinding.id) ?? { findingId: selectedFinding.id, state: 'open' as FindingState, version: 0 } : null
  const filteredFindings = (result?.findings ?? []).filter(item => severity === 'all' || item.severity === severity).filter(item => findingType === 'all' || item.type === findingType).filter(item => findingState === 'all' || (actions.findings.find(value => value.findingId === item.id)?.state ?? 'open') === findingState)
  const filteredCoverage = (result?.coverage ?? []).filter(item => coverageStatus === 'all' || item.status === coverageStatus)
  const act = async (action: string) => { if (!selectedFinding || !currentProjection) return; setActing(true); try { await actOnTechnicalFinding(projectVersionId, run.technicalReviewId, run.runId, selectedFinding.id, { action, comment, expectedVersion: currentProjection.version }); setActions(await loadTechnicalFindingActions(projectVersionId, run.technicalReviewId, run.runId)); setComment(''); notify('Finding 处置已追加保存') } catch (error) { notify(message(error), 'error'); setActions(await loadTechnicalFindingActions(projectVersionId, run.technicalReviewId, run.runId).catch(() => actions)) } finally { setActing(false) } }

  return <div className="tech-workbench">
    <header className="tech-run-header"><div><div className="tech-title-line"><h2>{reviews.find(item => item.id === run.technicalReviewId)?.name ?? '技术方案评审'}</h2><StatusBadge status={run.status} /></div><p>{run.runId} · 基线 {run.sourceReviewRunId} · {run.modelLabel}{run.degradations?.length ? ` · 已降级 ${run.degradations.length} 次` : ''}</p><div className="tech-progress"><span style={{ width: `${run.progress}%` }} /><em>{stepLabel(run.step)} · {run.progress}%</em></div></div><div className="tech-actions"><button className="btn ghost" onClick={rerun} disabled={starting || ['queued','running'].includes(run.status)}><RefreshCw />重新评审</button>{['queued','running'].includes(run.status) && <button className="btn danger" onClick={cancel}><Square />取消</button>}<button className="btn primary" disabled={run.status !== 'succeeded'} onClick={exportReport}><Download />导出报告</button></div></header>
    {(run.status === 'failed' || run.status === 'cancelled') && <div className={`tech-terminal ${run.status}`}><AlertTriangle /><div><b>{run.status === 'failed' ? '运行失败' : '运行已取消'}</b><p>{run.error ?? '本次运行没有发布正式结果。'}</p></div></div>}
    <div className="tech-columns">
      <aside className="tech-sources"><h3>固定资料</h3><SourceList run={run} result={result} openEvidence={openEvidence} document={document} loadContent={async assetVersionId => { const value = await loadTechnicalFixedContent(projectVersionId, run.technicalReviewId, run.runId, assetVersionId); setDocument({ assetVersionId, title: run.snapshot.solutionInputs.find(item => item.assetVersionId === assetVersionId)?.displayName ?? '冻结原文', content: value.content }) }} /></aside>
      <main className="tech-results"><nav className="tech-tabs">{([['overview','评审概览'],['coverage','需求覆盖'],['findings','技术 Finding'],['risks','风险与待确认'],['evidence','Evidence'],['history','运行历史']] as Array<[Tab,string]>).map(([key,label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</nav>
        <div className="tech-results-scroll">
        {!result && <RunPlaceholder run={run} />}
        {result && tab === 'overview' && <Overview result={result} run={run} />}
        {result && tab === 'coverage' && <section><FilterBar label="覆盖状态" value={coverageStatus} onChange={value => setCoverageStatus(value as typeof coverageStatus)} options={[['all','全部'],['covered','已覆盖'],['partially_covered','部分覆盖'],['not_covered','未覆盖'],['needs_confirmation','待确认']]} /><div className="tech-list">{filteredCoverage.map(item => <article key={item.id} className="coverage-row"><StatusPill status={item.status} /><div><h4>{item.requirementTitle}</h4><p>{item.analysis}</p><EvidenceButtons ids={item.evidenceIds} result={result} open={openEvidence} /></div></article>)}</div></section>}
        {result && tab === 'findings' && <section><div className="tech-filters"><Filter size={15} /><select value={severity} onChange={event => setSeverity(event.target.value)}><option value="all">全部严重度</option><option value="blocker">Blocker</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select><select value={findingType} onChange={event => setFindingType(event.target.value)}><option value="all">全部类型</option>{[...new Set(result.findings.map(item => item.type))].map(item => <option key={item} value={item}>{typeLabel(item)}</option>)}</select><select value={findingState} onChange={event => setFindingState(event.target.value)}><option value="all">全部状态</option>{['open','confirmed','dismissed','resolved','needs_follow_up'].map(item => <option key={item} value={item}>{stateLabel(item as FindingState)}</option>)}</select></div><div className="tech-list">{filteredFindings.map(item => <button key={item.id} className={`finding-row ${selectedFindingId === item.id ? 'selected' : ''}`} onClick={() => setSelectedFindingId(item.id)}><Severity severity={item.severity} /><span><b>{item.title}</b><small>{typeLabel(item.type)} · {stateLabel(actions.findings.find(value => value.findingId === item.id)?.state ?? 'open')} · 置信度 {Math.round(item.confidence * 100)}%</small><em>{item.problem}</em></span></button>)}</div></section>}
        {result && tab === 'risks' && <section className="tech-risk-grid"><div><h3>主要风险</h3>{result.risks.map(item => <article key={item.id}><AlertTriangle /><div><b>{item.description}</b><p>影响：{item.impact}</p><p>缓解：{item.mitigation}</p><EvidenceButtons ids={item.evidenceIds} result={result} open={openEvidence} /></div></article>)}</div><div><h3>待确认问题</h3>{result.questions.map(item => <article key={item.id}><Clock3 /><div><b>{item.question}</b><p>{item.reason}</p><EvidenceButtons ids={item.evidenceIds} result={result} open={openEvidence} /></div></article>)}</div></section>}
        {result && tab === 'evidence' && <section className="tech-evidence-grid">{result.evidence.map(item => <button key={item.id} onClick={() => void openEvidence(item)}><BookOpen /><span><b>{item.sourceKind === 'requirement' ? '需求' : '技术方案'} · {item.headingPath.join(' / ') || '正文'}</b><small>{item.assetVersionId} · L{item.startLine}-{item.endLine}</small><em>“{item.quote}”</em></span></button>)}</section>}
          {tab === 'history' && <HistoryList runs={runs} current={run.runId} select={selectRun} />}
        </div>
        {document && <TechnicalDocumentViewer document={document} onClose={() => setDocument(null)} />}
      </main>
      <aside className="tech-detail"><h3>详情与处置</h3>{selectedFinding && result ? <><div className="detail-heading"><Severity severity={selectedFinding.severity} /><div><h4>{selectedFinding.title}</h4><p>{typeLabel(selectedFinding.type)} · {stateLabel(currentProjection?.state ?? 'open')}</p></div></div><DetailBlock title="问题" value={selectedFinding.problem} /><DetailBlock title="影响" value={selectedFinding.impact} /><DetailBlock title="建议" value={selectedFinding.recommendation} /><DetailBlock title="关联需求点" value={selectedFinding.requirementPointIds.join('、') || '未关联'} /><EvidenceButtons ids={selectedFinding.evidenceIds} result={result} open={openEvidence} /><div className="action-box"><label>处置说明<textarea value={comment} onChange={event => setComment(event.target.value)} maxLength={2000} placeholder="追加说明，不覆盖 AI 原始内容" /></label><div>{currentProjection?.state === 'open' ? <><button disabled={acting} onClick={() => void act('confirm')}>确认</button><button disabled={acting} onClick={() => void act('dismiss')}>驳回</button><button disabled={acting} onClick={() => void act('resolve')}>已解决</button><button disabled={acting} onClick={() => void act('request_follow_up')}>需跟进</button></> : <button disabled={acting} onClick={() => void act('reopen')}>重新打开</button>}</div></div><div className="action-history">{actions.actions.filter(item => item.findingId === selectedFinding.id).map(item => <p key={item.id}><b>{stateLabel(item.toState)}</b><span>{item.actorDisplayName} · {formatTime(item.createdAt)}</span><em>{item.comment}</em></p>)}</div></> : <div className="detail-empty"><ShieldCheck /><p>选择一条 Finding 查看影响、建议、Evidence 和人工处置。</p></div>}</aside>
    </div>
  </div>
}

function InputSelection(props: { loading:boolean;projectVersion:ProjectVersion;baselines:TechnicalBaseline[];assets:TechnicalSolutionAsset[];reviews:TechnicalReview[];selectedBaseline:string;setSelectedBaseline:(value:string)=>void;selectedAssets:string[];setSelectedAssets:(value:string[])=>void;reviewName:string;setReviewName:(value:string)=>void;agentReady:boolean;starting:boolean;start:()=>void;openHistory:(review:TechnicalReview)=>void;refresh:()=>void;uploadRef:React.RefObject<HTMLInputElement|null>;uploadState:'idle'|'running';uploadProgress:UploadProgress|null;uploadDirectory:string;apiState:'connecting'|'ready'|'offline';upload:(event:React.ChangeEvent<HTMLInputElement>)=>Promise<void>;onManageVersions:()=>void;onOpenKnowledge:()=>void }) {
  const selected = props.baselines.find(item => item.id === props.selectedBaseline)
  const canStart = props.projectVersion.status === 'open' && props.agentReady && Boolean(props.selectedBaseline) && props.selectedAssets.length > 0 && props.reviewName.trim().length > 0
  const toggleAsset = (assetVersionId:string, checked:boolean) => props.setSelectedAssets(checked ? [...new Set([...props.selectedAssets, assetVersionId])].slice(0, 10) : props.selectedAssets.filter(id => id !== assetVersionId))
  return <div className="tech-input-page"><header className="tech-setup-header"><div><span className="tech-version-chip"><GitBranch />{props.projectVersion.name}</span><h2>技术方案评审工作台</h2><p>上传并固定技术方案资料，对齐已完成的需求评审基线。</p></div><button className="btn ghost" onClick={props.refresh}><RefreshCw />刷新资料</button></header><div className="tech-setup-columns">
    <aside className="tech-setup-sources"><div className="tech-panel-head"><span><FileText /><b>技术方案资料</b></span><em>{props.assets.length} 份 ready</em></div><div className="tech-source-list">{props.assets.map(item => <label className={`tech-source-row ${props.selectedAssets.includes(item.assetVersionId) ? 'selected' : ''}`} key={item.assetVersionId}><input type="checkbox" checked={props.selectedAssets.includes(item.assetVersionId)} onChange={event => toggleAsset(item.assetVersionId,event.target.checked)} /><span className="tech-file-icon">MD</span><span><b>{item.displayName}</b><small>V{item.version} · {props.selectedAssets.includes(item.assetVersionId) ? '已选为固定输入' : '可选输入'}</small><em title={item.logicalPath}>{item.logicalPath}</em></span></label>)}{!props.assets.length && !props.loading && <div className="tech-setup-empty"><FileText /><b>还没有技术方案资料</b><p>上传 Markdown、TXT 或 ZIP，索引 ready 后会自动勾选。</p></div>}{props.loading && <div className="tech-setup-empty"><RefreshCw className="spin" /><p>正在读取技术方案资料…</p></div>}</div><div className="tech-source-footer"><button className="tech-upload-button" disabled={props.projectVersion.status !== 'open' || props.uploadState === 'running' || props.apiState !== 'ready'} onClick={() => props.uploadRef.current?.click()}><Upload />{props.projectVersion.status !== 'open' ? '当前版本只读' : props.uploadState === 'running' ? '正在解析并入库…' : '上传技术方案 / ZIP'}</button><small className="tech-upload-target" title={`/${props.uploadDirectory}`}>入库目录：/{props.uploadDirectory}</small><input ref={props.uploadRef} className="visually-hidden" type="file" multiple accept=".zip,.md,.txt,application/zip,text/markdown,text/plain" onChange={event => void props.upload(event)} />{props.uploadProgress && <div className={`tech-upload-progress ${props.uploadProgress.stage}`} role="status" aria-live="polite"><div><span>{props.uploadProgress.stage === 'failed' ? '上传未完成' : props.uploadProgress.stage === 'completed' ? '上传完成' : '上传解析进度'}</span><b>{props.uploadProgress.percent}%</b></div><progress max="100" value={props.uploadProgress.percent} /><small>{props.uploadProgress.detail}</small></div>}<button onClick={props.onManageVersions}><GitBranch />切换 / 管理版本</button><button onClick={props.onOpenKnowledge}><BookOpen />前往知识库</button></div></aside>
    <main className="tech-setup-main"><div className="tech-setup-title"><div><span>新建评审</span><h2>固定需求基线与技术方案输入</h2><p>运行创建后，基线、正文 Hash、活动索引和 Agent 版本都会写入服务端快照。</p></div><span className="tech-selection-count">已选 {props.selectedAssets.length} / 10</span></div>{props.projectVersion.status !== 'open' && <div className="input-warning"><AlertTriangle />当前版本为 {props.projectVersion.status}，只能查看历史运行。</div>}<section className="tech-form-card"><label><span>评审名称</span><input value={props.reviewName} onChange={event => props.setReviewName(event.target.value)} maxLength={200} /></label><label><span>需求基线</span><select value={props.selectedBaseline} onChange={event => props.setSelectedBaseline(event.target.value)}><option value="">请选择成功运行</option>{props.baselines.map(item => <option value={item.id} key={item.id}>{item.documentTitle} · {item.requirementCount} 个需求点 · {formatTime(item.completedAt)}</option>)}</select></label>{selected ? <div className="tech-baseline-summary"><ShieldCheck /><span><b>{selected.documentTitle}</b><small>{selected.requirementCount} 个冻结需求点 · 完成于 {formatTime(selected.completedAt)}</small></span></div> : <div className="tech-inline-empty">请先在需求分析中完成一次成功评审，作为固定需求基线。</div>}{selected && selected.unresolvedHighCount > 0 && <div className="input-warning"><AlertTriangle />该基线仍有 {selected.unresolvedHighCount} 个未处置 blocker/high Finding；本次仅提示，不阻止启动。</div>}</section><section className="tech-selected-card"><header><div><b>本次固定技术方案</b><span>只使用左侧已勾选、ready 且进入活动索引的版本</span></div><em>{props.selectedAssets.length} 份</em></header>{props.selectedAssets.length ? <div>{props.selectedAssets.map(id => { const item=props.assets.find(asset=>asset.assetVersionId===id); return item ? <article key={id}><CheckCircle2 /><span><b>{item.displayName}</b><small>{item.logicalPath} · Hash {item.contentSha256.slice(0,12)}</small></span><button aria-label={`移除 ${item.displayName}`} onClick={()=>toggleAsset(id,false)}><XCircle /></button></article> : null })}</div> : <div className="tech-inline-empty">从左侧选择资料，或直接上传新的技术方案文档。</div>}</section><footer className="tech-start-bar"><div className={`agent-check ${props.agentReady ? 'ready':'missing'}`}>{props.agentReady ? <CheckCircle2 /> : <XCircle />}<span><b>{props.agentReady ? 'TechnicalSolutionAnalysisAgent 已发布' : 'TechnicalSolutionAnalysisAgent 尚未发布'}</b><small>服务端将固定 Agent、Prompt、模型与工具权限。</small></span></div><button className="btn primary start-tech" disabled={!canStart || props.starting} onClick={props.start}><Play />{props.starting ? '正在创建真实运行…':'开始技术方案评审'}</button></footer></main>
    <aside className="tech-setup-history"><div className="tech-panel-head"><span><History /><b>历史技术评审</b></span><em>{props.reviews.length} 次</em></div><div>{props.reviews.map(item => <button key={item.id} disabled={!item.latestRun} onClick={() => props.openHistory(item)}><History /><span><b>{item.name}</b><small>{item.latestRun ? `${statusLabel(item.latestRun.status)} · ${formatTime(item.latestRun.createdAt)}` : '尚未运行'}</small><em>{item.latestRun?.summary?.overview ?? item.id}</em></span></button>)}{!props.reviews.length && <div className="tech-setup-empty"><History /><b>暂无历史评审</b><p>完成一次评审后，可从这里恢复固定运行。</p></div>}</div><section className="tech-readiness"><h3>启动条件</h3><p className={props.selectedBaseline?'done':''}><span>{props.selectedBaseline?'✓':'1'}</span>成功需求评审基线</p><p className={props.selectedAssets.length?'done':''}><span>{props.selectedAssets.length?'✓':'2'}</span>至少一份技术方案</p><p className={props.agentReady?'done':''}><span>{props.agentReady?'✓':'3'}</span>已发布专用 Agent</p></section></aside>
  </div></div>
}

function SourceList({run,result,openEvidence,document,loadContent}:{run:TechnicalRun;result?:TechnicalFormalResult;openEvidence:(e:TechnicalEvidence)=>Promise<void>;document:{assetVersionId:string}|null;loadContent:(id:string)=>Promise<void>}) { const requirementEvidence=result?.evidence.filter(item=>item.sourceKind==='requirement')??[]; return <div className="source-list"><p>需求基线</p><button className={document && requirementEvidence.some(item=>item.assetVersionId===document.assetVersionId)?'active':''} disabled={!requirementEvidence.length} onClick={() => requirementEvidence[0] && void openEvidence(requirementEvidence[0])}><FileText /><span><b>{run.sourceReviewRunId}</b><small>{run.snapshot.requirementBaseline.requirementPoints.length} 个冻结需求点</small></span></button><p>技术方案</p>{run.snapshot.solutionInputs.map(item=><button className={document?.assetVersionId===item.assetVersionId?'active':''} key={item.assetVersionId} onClick={()=>void loadContent(item.assetVersionId)}><BookOpen /><span><b>{item.displayName}</b><small>{item.assetVersionId}</small></span></button>)}</div> }
function Overview({result,run}:{result:TechnicalFormalResult;run:TechnicalRun}) { const stats=result.statistics; return <section className="tech-overview"><div className="stat-grid"><Stat label="需求总数" value={stats.totalRequirements}/><Stat label="已覆盖" value={stats.covered} tone="green"/><Stat label="部分覆盖" value={stats.partiallyCovered} tone="orange"/><Stat label="未覆盖" value={stats.notCovered} tone="red"/><Stat label="待确认" value={stats.needsConfirmation} tone="violet"/><Stat label="覆盖率" value={`${(stats.coverageRatio*100).toFixed(1)}%`} tone="blue"/></div><article className="summary-card"><h3>AI 技术方案摘要</h3><p>{result.summary.overview}</p><div><section><b>主要缺口</b>{result.summary.majorGaps.map(item=><span key={item}>{item}</span>)}</section><section><b>主要风险</b>{result.summary.majorRisks.map(item=><span key={item}>{item}</span>)}</section><section><b>建议处理顺序</b>{result.summary.recommendedOrder.map((item,index)=><span key={item}>{index+1}. {item}</span>)}</section></div></article><article className="snapshot-card"><h3>运行快照</h3><dl><dt>Agent / Prompt</dt><dd>{run.snapshot.agentDefinition.agentKey} {run.snapshot.agentDefinition.version} · {run.snapshot.agentDefinition.promptRef.contentSha256.slice(0,12)}</dd><dt>模型</dt><dd>{run.modelLabel}</dd><dt>索引</dt><dd>{run.snapshot.indexVersionId}</dd><dt>输入投递</dt><dd>{run.snapshot.inputPlan.mode} · {run.snapshot.inputPlan.batches.length} 批 · {run.snapshot.inputPlan.estimatedInputTokens} Token</dd><dt>执行</dt><dd>{run.execution?.turns??0} 轮 · {run.execution?.toolCalls??0} 次工具调用 · {run.execution?.toolErrors??0} 次错误</dd></dl></article></section> }
function RunPlaceholder({run}:{run:TechnicalRun}) { return <div className="run-placeholder">{['queued','running'].includes(run.status)?<RefreshCw className="spin"/>:run.status==='failed'?<XCircle/>:<AlertTriangle/>}<h3>{run.status==='queued'?'等待 Worker 领取任务':run.status==='running'?'TechnicalSolutionAnalysisAgent 正在分析固定输入':run.status==='failed'?'本次运行失败':'本次运行未发布结果'}</h3><p>{run.error??'状态和进度来自服务端，不使用前端模拟结果。'}</p></div> }
function HistoryList({runs,current,select}:{runs:TechnicalRunSummary[];current:string;select:(run:TechnicalRunSummary)=>void}) { return <section className="run-history-list">{runs.map(item=><button key={item.runId} className={item.runId===current?'active':''} onClick={()=>select(item)}><StatusBadge status={item.status}/><span><b>{item.runId}</b><small>{formatTime(item.createdAt)} · {item.modelLabel}</small><em>{item.summary?.overview??item.error??stepLabel(item.step)}</em></span></button>)}</section> }
function EvidenceButtons({ids,result,open}:{ids:string[];result:TechnicalFormalResult;open:(e:TechnicalEvidence)=>Promise<void>}) { return <div className="evidence-buttons">{ids.map(id=>{const item=result.evidence.find(value=>value.id===id);return item?<button key={id} onClick={event=>{event.stopPropagation();void open(item)}}><BookOpen/>{item.sourceKind==='requirement'?'需求':'方案'} Evidence</button>:null})}</div> }
function DetailBlock({title,value}:{title:string;value:string}) { return <section className="detail-block"><b>{title}</b><p>{value}</p></section> }
function FilterBar({label,value,onChange,options}:{label:string;value:string;onChange:(value:string)=>void;options:Array<[string,string]>}) { return <div className="tech-filters"><Filter size={15}/><span>{label}</span><select value={value} onChange={event=>onChange(event.target.value)}>{options.map(([key,text])=><option key={key} value={key}>{text}</option>)}</select></div> }
function Stat({label,value,tone='gray'}:{label:string;value:string|number;tone?:string}) { return <div className={`stat ${tone}`}><b>{value}</b><span>{label}</span></div> }
function StatusBadge({status}:{status:TechnicalRun['status']}) { return <span className={`tech-status ${status}`}>{statusLabel(status)}</span> }
function StatusPill({status}:{status:CoverageStatus}) { return <span className={`coverage-status ${status}`}>{coverageLabel(status)}</span> }
function Severity({severity}:{severity:string}) { return <span className={`severity-dot ${severity}`}>{severity.toUpperCase()}</span> }
function updateRoute(technicalReviewId:string,runId:string){const url=new URL(window.location.href);url.searchParams.set('page','design');url.searchParams.set('technicalReviewId',technicalReviewId);url.searchParams.set('runId',runId);window.history.pushState({},'',url)}
function routeContext(){if(typeof window==='undefined')return{technicalReviewId:'',runId:''};const url=new URL(window.location.href);return{technicalReviewId:url.searchParams.get('technicalReviewId')??'',runId:url.searchParams.get('runId')??''}}
function message(error:unknown){return error instanceof Error?error.message:'操作失败'}
function formatTime(value?:string){return value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'未完成'}
function statusLabel(value:string){return({queued:'排队中',running:'运行中',succeeded:'已成功',failed:'失败',cancelled:'已取消'} as Record<string,string>)[value]??value}
function stepLabel(value:string){return({waiting_worker:'等待 Worker',validating_input:'校验输入',assembling_context:'组装正文',analyzing_solution:'Agent 分析',candidate_submitted:'结果已提交',resolving_evidence:'解析 Evidence',validating_result:'校验结果',publishing_result:'保存正式结果',succeeded:'已完成',failed:'失败',cancelled:'已取消'} as Record<string,string>)[value]??value}
function taskStepLabel(value:string){return({queued:'等待处理',parsing:'解析文档',chunking:'切分正文',embedding:'生成向量',indexing:'写入索引',publishing:'发布索引',completed:'处理完成',succeeded:'处理完成',failed:'处理失败'} as Record<string,string>)[value]??value}
function coverageLabel(value:CoverageStatus){return({covered:'已覆盖',partially_covered:'部分覆盖',not_covered:'未覆盖',needs_confirmation:'待确认'} as Record<CoverageStatus,string>)[value]}
function stateLabel(value:FindingState){return({open:'待处理',confirmed:'已确认',dismissed:'已驳回',resolved:'已解决',needs_follow_up:'需跟进'} as Record<FindingState,string>)[value]}
function typeLabel(value:string){return({requirement_coverage_gap:'需求覆盖缺口',architecture_gap:'架构缺口',interface_gap:'接口缺口',data_gap:'数据缺口',exception_gap:'异常流程缺口',non_functional_gap:'非功能缺口',conflict:'冲突',risk:'风险',other:'其他'} as Record<string,string>)[value]??value}
