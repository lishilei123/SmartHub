import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import { Eye, LoaderCircle, Trash2, Upload, XCircle } from 'lucide-react'
import { RequirementAnalysisPageV2 } from './RequirementAnalysisPageV2'
import { deleteKnowledgeAsset, loadAssetVersion, loadTasks, uploadKnowledgeArchive, uploadKnowledgeFile, waitForTaskResults } from './knowledge-api'
import { MarkdownDocument } from './MarkdownDocument'
import type { KnowledgeDocument } from './prototype-data'
import type { ProjectVersion } from './project-version-api'
import { requirementAnalysisInputDirectory, requirementAnalysisInputTypeForDocument, requirementAnalysisInputTypes, type RequirementAnalysisInputType } from './version-document-path'
import './requirement-input-toolbar.css'
import './requirement-analysis-layout.css'

type Notify = (message: string, tone?: 'success' | 'error' | 'warning') => void

type Props = {
  projectVersion: ProjectVersion | null
  documents: KnowledgeDocument[]
  knowledgeBaseId: string
  apiState: 'connecting' | 'ready' | 'offline'
  refreshKnowledge: () => Promise<void>
  refreshProjectVersions: () => Promise<ProjectVersion[]>
  onManageVersions: () => void
  onOpenKnowledge: () => void
  onOpenActivity: () => void
  notify: Notify
  addAudit: (entry: string) => void
}

type PreviewState = {
  document: KnowledgeDocument
  content: string
  loading: boolean
}

type UploadProgress = {
  stage: 'reading' | 'submitting' | 'processing' | 'refreshing' | 'completed' | 'failed'
  percent: number
  detail: string
}

async function ensureTasksCompleted(taskIds: string[], documentLabel = '文档') {
  if (!taskIds.length) return
  const completed = await waitForTaskResults(taskIds)
  if (completed.failed.length) throw new Error(completed.failed[0]?.error ?? `${documentLabel}入库失败`)
  if (completed.cancelled.length) throw new Error(`${documentLabel}入库任务已取消`)
  if (completed.pending.length) throw new Error(`${documentLabel}入库尚未完成`)
}

function safeFileName(file: File, documentLabel: string) {
  const name = file.name.replaceAll('\\', '/').split('/').at(-1)?.trim() ?? ''
  if (!name || !/\.(?:md|txt)$/iu.test(name)) throw new Error(`仅支持 Markdown / TXT ${documentLabel}：${file.name}`)
  return name
}

function taskStepLabel(step: string) {
  return ({
    queued: '等待处理',
    waiting: '等待 Worker',
    claimed: '任务已领取',
    parsing: '解析文档',
    chunking: '切分正文',
    embedding: '生成 Embedding',
    vector_indexing: '构建向量索引',
    indexing: '写入索引',
    committing: '发布活动索引',
    publishing: '发布索引',
    completed: '处理完成',
    succeeded: '处理完成',
    failed: '处理失败',
    cancelled: '任务已取消',
  } as Record<string, string>)[step] ?? '正在处理知识资产'
}

export function RequirementAnalysisPage(props: Props) {
  const { projectVersion, knowledgeBaseId, apiState, refreshKnowledge, notify, addAudit } = props
  const shellRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const foregroundUploadRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [uploadInputType, setUploadInputType] = useState<RequirementAnalysisInputType>('requirement')
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null)
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [workspaceFooter, setWorkspaceFooter] = useState<HTMLElement | null>(null)

  const selectedInputType = requirementAnalysisInputTypes.find(input => input.value === uploadInputType) ?? requirementAnalysisInputTypes[0]
  const workspaceDirectoryPath = projectVersion ? requirementAnalysisInputDirectory(projectVersion.name, uploadInputType) : ''
  const canManage = Boolean(projectVersion?.status === 'open' && knowledgeBaseId && apiState === 'ready' && !busy)
  const projectUploadAssetIds = projectVersion
    ? props.documents
      .filter(document => Boolean(requirementAnalysisInputTypeForDocument(projectVersion.name, document.logicalPath ?? '', document.assetType)))
      .map(document => document.id)
      .sort()
      .join('\n')
    : ''

  useEffect(() => {
    if (uploadProgress?.stage !== 'completed') return
    const timer = window.setTimeout(() => setUploadProgress(current => current?.stage === 'completed' ? null : current), 5_000)
    return () => window.clearTimeout(timer)
  }, [uploadProgress?.stage])

  useEffect(() => {
    if (!projectVersion || !knowledgeBaseId || apiState !== 'ready' || !projectUploadAssetIds) return
    const assetIds = new Set(projectUploadAssetIds.split('\n'))
    let cancelled = false
    let timer: number | undefined
    let trackedTaskIds: string[] = []

    const pollPersistedUpload = async () => {
      if (foregroundUploadRef.current) return
      try {
        const tasks = await loadTasks(knowledgeBaseId)
        if (cancelled || foregroundUploadRef.current) return
        if (!trackedTaskIds.length) {
          trackedTaskIds = tasks
            .filter(task => task.type === 'sync'
              && task.trigger === 'upload'
              && (task.status === 'queued' || task.status === 'running')
              && Boolean(task.targetId && assetIds.has(task.targetId)))
            .map(task => task.id)
          if (!trackedTaskIds.length) return
        }

        const trackedTasks = trackedTaskIds
          .map(taskId => tasks.find(task => task.id === taskId))
          .filter(task => task !== undefined)
        if (!trackedTasks.length) return
        const terminal = trackedTasks.filter(task => ['succeeded', 'failed', 'cancelled'].includes(task.status))
        const averageProgress = Math.round(trackedTasks.reduce((sum, task) => sum + task.progress, 0) / trackedTasks.length)
        const displayedProgress = 20 + Math.round(Math.max(0, Math.min(100, averageProgress)) * .7)
        const activeTask = trackedTasks.find(task => task.status === 'running') ?? trackedTasks.find(task => task.status === 'queued')

        if (activeTask) {
          setBusy(true)
          setUploadProgress({
            stage: 'processing',
            percent: displayedProgress,
            detail: `${taskStepLabel(activeTask.step)} · ${terminal.length}/${trackedTasks.length} 个任务完成`,
          })
          timer = window.setTimeout(() => void pollPersistedUpload(), 1_000)
          return
        }

        const failedTask = trackedTasks.find(task => task.status === 'failed')
        const cancelledTask = trackedTasks.find(task => task.status === 'cancelled')
        if (failedTask || cancelledTask) {
          const detail = failedTask?.error ?? (cancelledTask ? '文档入库任务已取消' : '文档入库失败')
          setUploadProgress({ stage: 'failed', percent: displayedProgress, detail })
          setBusy(false)
          notify(detail, 'error')
          return
        }

        setUploadProgress({ stage: 'refreshing', percent: 94, detail: '入库任务已完成，正在刷新 Workspace 文档列表' })
        await refreshKnowledge()
        if (cancelled) return
        setUploadProgress({ stage: 'completed', percent: 100, detail: `已完成 ${trackedTasks.length} 个文档入库任务。` })
        setBusy(false)
        notify('文档入库已完成。')
      } catch {
        if (!cancelled) timer = window.setTimeout(() => void pollPersistedUpload(), 3_000)
      }
    }

    void pollPersistedUpload()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [apiState, knowledgeBaseId, projectUploadAssetIds, projectVersion?.id])

  const uploadFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    if (!files.length || !projectVersion || !canManage) return
    const inputType = requirementAnalysisInputTypes.find(input => input.value === uploadInputType) ?? requirementAnalysisInputTypes[0]
    const targetDirectoryPath = requirementAnalysisInputDirectory(projectVersion.name, inputType.value)
    foregroundUploadRef.current = true
    setBusy(true)
    setUploadProgress({ stage: 'reading', percent: 2, detail: `正在读取 ${files.length} 个文件` })
    try {
      const taskIds: string[] = []
      let importedDocuments = 0
      for (const [fileIndex, file] of files.entries()) {
        setUploadProgress({ stage: 'submitting', percent: 5 + Math.round(fileIndex / files.length * 15), detail: `正在提交 ${file.name}（${fileIndex + 1}/${files.length}）` })
        if (/\.zip$/iu.test(file.name)) {
          const uploaded = await uploadKnowledgeArchive(knowledgeBaseId, file, targetDirectoryPath, inputType.assetType)
          taskIds.push(...uploaded.taskIds)
          importedDocuments += uploaded.documents
          continue
        }
        const name = safeFileName(file, inputType.label)
        const logicalPath = `${targetDirectoryPath}/${name}`
        const uploaded = await uploadKnowledgeFile(knowledgeBaseId, file, logicalPath, inputType.assetType)
        if (uploaded.task?.id) taskIds.push(uploaded.task.id)
        importedDocuments += 1
      }
      if (taskIds.length) {
        const completed = await waitForTaskResults(taskIds, { onProgress: progress => setUploadProgress({ stage: 'processing', percent: 20 + Math.round(progress.percent * .7), detail: `${taskStepLabel(progress.currentStep)} · ${progress.completed}/${progress.total} 个任务完成` }) })
        if (completed.failed.length) throw new Error(completed.failed[0]?.error ?? `${inputType.label}入库失败`)
        if (completed.cancelled.length) throw new Error(`${inputType.label}入库任务已取消`)
        if (completed.pending.length) throw new Error(`${inputType.label}入库尚未完成`)
      }
      setUploadProgress({ stage: 'refreshing', percent: 94, detail: '正在刷新 Workspace 文档列表' })
      await refreshKnowledge()
      addAudit(`上传${inputType.label}：${files.map(file => file.name).join('、')} → /${targetDirectoryPath}`)
      const summary = `已导入 ${importedDocuments} 份${inputType.label}。`
      setUploadProgress({ stage: 'completed', percent: 100, detail: summary })
      notify(summary)
    } catch (error) {
      const detail = error instanceof Error ? error.message : `${inputType.label}上传失败`
      setUploadProgress(current => ({ stage: 'failed', percent: current?.percent ?? 0, detail }))
      await refreshKnowledge().catch(() => undefined)
      notify(detail, 'error')
    } finally {
      foregroundUploadRef.current = false
      setBusy(false)
    }
  }

  const openPreview = async (document: KnowledgeDocument) => {
    const documentLabel = projectVersion ? requirementAnalysisInputTypeForDocument(projectVersion.name, document.logicalPath ?? '', document.assetType)?.label ?? '输入文档' : '输入文档'
    if (!document.assetVersionId) {
      notify('该文档尚未生成可预览的 AssetVersion。', 'warning')
      return
    }
    setPreview({ document, content: '', loading: true })
    try {
      const version = await loadAssetVersion(document.assetVersionId)
      setPreview({ document, content: version.content ?? '', loading: false })
    } catch (error) {
      setPreview(null)
      notify(error instanceof Error ? error.message : `${documentLabel}预览失败`, 'error')
    }
  }

  const removeDocument = async (document: KnowledgeDocument) => {
    if (!canManage) return
    const inputType = projectVersion ? requirementAnalysisInputTypeForDocument(projectVersion.name, document.logicalPath ?? '', document.assetType) : undefined
    const documentLabel = inputType?.label ?? '输入文档'
    if (!window.confirm(`确认删除${documentLabel}“${document.name}”吗？该资产的历史版本也会按现有知识库删除规则处理。`)) return
    setBusy(true)
    try {
      const removed = await deleteKnowledgeAsset(document.id)
      if (removed.task?.id) await ensureTasksCompleted([removed.task.id])
      await refreshKnowledge()
      if (preview?.document.id === document.id) setPreview(null)
      addAudit(`删除${documentLabel}：${document.logicalPath ?? document.name}`)
      notify(`${documentLabel}已删除。`)
    } catch (error) {
      notify(error instanceof Error ? error.message : `${documentLabel}删除失败`, 'error')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const root = shellRef.current
    if (!root) return
    const footer = root.querySelector<HTMLElement>('.rav2-workspace > footer')
    setWorkspaceFooter(footer)
  }, [])

  const previewInputType = preview && projectVersion ? requirementAnalysisInputTypeForDocument(projectVersion.name, preview.document.logicalPath ?? '', preview.document.assetType) : undefined

  return <div className="requirement-analysis-shell" ref={shellRef}>
    <RequirementAnalysisPageV2 {...props} onOpenInputDocument={document => void openPreview(document)} onDeleteInputDocument={document => void removeDocument(document)} canDeleteInputDocument={canManage} />

    {workspaceFooter && createPortal(<div className="requirement-workspace-upload-actions">
      <label className="requirement-upload-type"><span>上传为</span><select aria-label="上传资料类型" value={uploadInputType} disabled={busy} onChange={event => setUploadInputType(event.target.value as RequirementAnalysisInputType)}>{requirementAnalysisInputTypes.map(input => <option key={input.value} value={input.value}>{input.label}</option>)}</select></label>
      <button className="primary" disabled={!canManage} onClick={() => fileInputRef.current?.click()}><Upload />{busy ? '处理中…' : `上传${selectedInputType.label}`}</button>
      <small title={`/${workspaceDirectoryPath}`}>支持 MD / TXT / ZIP · /input/{selectedInputType.directoryName}</small>
      {uploadProgress && <div className={`requirement-upload-progress ${uploadProgress.stage}`} role="status" aria-live="polite"><div><span>{uploadProgress.stage === 'failed' ? '上传未完成' : uploadProgress.stage === 'completed' ? '上传完成' : '上传解析进度'}</span><b>{uploadProgress.percent}%</b></div><progress max="100" value={uploadProgress.percent} /><small title={uploadProgress.detail}>{uploadProgress.detail}</small></div>}
    </div>, workspaceFooter)}

    <input ref={fileInputRef} type="file" hidden multiple accept=".md,.txt,.zip,text/markdown,text/plain,application/zip" onChange={uploadFiles} />

    {preview && <div className="requirement-input-backdrop preview" onMouseDown={event => { if (event.currentTarget === event.target) setPreview(null) }}>
      <section className="requirement-input-preview">
        <header><div><Eye /><span><b>{preview.document.title || preview.document.name}</b><small>{preview.document.version} · {preview.document.logicalPath}</small></span></div><button onClick={() => setPreview(null)}><XCircle /></button></header>
        <div className="requirement-input-preview-body">
          {preview.loading ? <div className="requirement-input-empty"><LoaderCircle className="rotating" /><b>正在读取固定版本</b></div> : <MarkdownDocument source={preview.content} format={preview.document.name.toLowerCase().endsWith('.txt') ? 'text' : 'markdown'} knowledgeBaseId={knowledgeBaseId} logicalPath={preview.document.logicalPath ?? ''} />}
        </div>
        <footer><span>AssetVersion：{preview.document.assetVersionId ?? '-'}</span>{projectVersion?.status === 'open' && <button className="btn danger" disabled={busy} onClick={() => void removeDocument(preview.document)}><Trash2 />删除{previewInputType?.label ?? '文档'}</button>}</footer>
      </section>
    </div>}
  </div>
}
