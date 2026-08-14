import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import { Eye, LoaderCircle, Trash2, Upload, XCircle } from 'lucide-react'
import { RequirementAnalysisPageV2 } from './RequirementAnalysisPageV2'
import { deleteKnowledgeAsset, loadAssetVersion, uploadKnowledgeArchive, uploadKnowledgeFile, waitForTaskResults } from './knowledge-api'
import { MarkdownDocument } from './MarkdownDocument'
import type { KnowledgeDocument } from './prototype-data'
import type { ProjectVersion } from './project-version-api'
import { requirementWorkspaceDirectory } from './version-document-path'
import './requirement-input-toolbar.css'
import './requirement-analysis-layout.css'

type Notify = (message: string, tone?: 'success' | 'error' | 'warning') => void

type Props = {
  projectVersion: ProjectVersion | null
  documents: KnowledgeDocument[]
  knowledgeBaseId: string
  apiState: 'connecting' | 'ready' | 'offline'
  refreshKnowledge: () => Promise<void>
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

async function ensureTasksCompleted(taskIds: string[]) {
  if (!taskIds.length) return
  const completed = await waitForTaskResults(taskIds)
  if (completed.failed.length) throw new Error(completed.failed[0]?.error ?? '需求文档入库失败')
  if (completed.cancelled.length) throw new Error('需求文档入库任务已取消')
  if (completed.pending.length) throw new Error('需求文档入库尚未完成')
}

function safeFileName(file: File) {
  const name = file.name.replaceAll('\\', '/').split('/').at(-1)?.trim() ?? ''
  if (!name || !/\.(?:md|txt)$/iu.test(name)) throw new Error(`仅支持 Markdown / TXT 需求文档：${file.name}`)
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
  const [busy, setBusy] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null)
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [workspaceFooter, setWorkspaceFooter] = useState<HTMLElement | null>(null)

  const workspaceDirectoryPath = projectVersion ? requirementWorkspaceDirectory(projectVersion.name) : ''
  const canManage = Boolean(projectVersion?.status === 'open' && knowledgeBaseId && apiState === 'ready' && !busy)

  useEffect(() => {
    if (uploadProgress?.stage !== 'completed') return
    const timer = window.setTimeout(() => setUploadProgress(current => current?.stage === 'completed' ? null : current), 5_000)
    return () => window.clearTimeout(timer)
  }, [uploadProgress?.stage])

  const uploadFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    if (!files.length || !projectVersion || !canManage) return
    setBusy(true)
    setUploadProgress({ stage: 'reading', percent: 2, detail: `正在读取 ${files.length} 个文件` })
    try {
      const taskIds: string[] = []
      let importedDocuments = 0
      for (const [fileIndex, file] of files.entries()) {
        setUploadProgress({ stage: 'submitting', percent: 5 + Math.round(fileIndex / files.length * 15), detail: `正在提交 ${file.name}（${fileIndex + 1}/${files.length}）` })
        if (/\.zip$/iu.test(file.name)) {
          const uploaded = await uploadKnowledgeArchive(knowledgeBaseId, file, workspaceDirectoryPath, 'requirement')
          taskIds.push(...uploaded.taskIds)
          importedDocuments += uploaded.documents
          continue
        }
        const name = safeFileName(file)
        const logicalPath = `${workspaceDirectoryPath}/${name}`
        const uploaded = await uploadKnowledgeFile(knowledgeBaseId, file, logicalPath, 'requirement')
        if (uploaded.task?.id) taskIds.push(uploaded.task.id)
        importedDocuments += 1
      }
      if (taskIds.length) {
        const completed = await waitForTaskResults(taskIds, { onProgress: progress => setUploadProgress({ stage: 'processing', percent: 20 + Math.round(progress.percent * .7), detail: `${taskStepLabel(progress.currentStep)} · ${progress.completed}/${progress.total} 个任务完成` }) })
        if (completed.failed.length) throw new Error(completed.failed[0]?.error ?? '需求文档入库失败')
        if (completed.cancelled.length) throw new Error('需求文档入库任务已取消')
        if (completed.pending.length) throw new Error('需求文档入库尚未完成')
      }
      setUploadProgress({ stage: 'refreshing', percent: 94, detail: '正在刷新 Workspace 文档列表' })
      await refreshKnowledge()
      addAudit(`上传需求输入：${files.map(file => file.name).join('、')} → /${workspaceDirectoryPath}`)
      const summary = `已导入 ${importedDocuments} 份需求文档。`
      setUploadProgress({ stage: 'completed', percent: 100, detail: summary })
      notify(summary)
    } catch (error) {
      const detail = error instanceof Error ? error.message : '需求文档上传失败'
      setUploadProgress(current => ({ stage: 'failed', percent: current?.percent ?? 0, detail }))
      await refreshKnowledge().catch(() => undefined)
      notify(detail, 'error')
    } finally {
      setBusy(false)
    }
  }

  const openPreview = async (document: KnowledgeDocument) => {
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
      notify(error instanceof Error ? error.message : '需求文档预览失败', 'error')
    }
  }

  const removeDocument = async (document: KnowledgeDocument) => {
    if (!canManage) return
    if (!window.confirm(`确认删除需求文档“${document.name}”吗？该资产的历史版本也会按现有知识库删除规则处理。`)) return
    setBusy(true)
    try {
      const removed = await deleteKnowledgeAsset(document.id)
      if (removed.task?.id) await ensureTasksCompleted([removed.task.id])
      await refreshKnowledge()
      if (preview?.document.id === document.id) setPreview(null)
      addAudit(`删除需求文档：${document.logicalPath ?? document.name}`)
      notify('需求文档已删除。')
    } catch (error) {
      notify(error instanceof Error ? error.message : '需求文档删除失败', 'error')
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

  return <div className="requirement-analysis-shell" ref={shellRef}>
    <RequirementAnalysisPageV2 {...props} onOpenRequirementDocument={document => void openPreview(document)} onDeleteRequirementDocument={document => void removeDocument(document)} canDeleteRequirementDocument={canManage} />

    {workspaceFooter && createPortal(<div className="requirement-workspace-upload-actions">
      <button className="primary" disabled={!canManage} onClick={() => fileInputRef.current?.click()}><Upload />{busy ? '处理中…' : '上传需求文档'}</button>
      <small>支持 MD / TXT / ZIP</small>
      {uploadProgress && <div className={`requirement-upload-progress ${uploadProgress.stage}`} role="status" aria-live="polite"><div><span>{uploadProgress.stage === 'failed' ? '上传未完成' : uploadProgress.stage === 'completed' ? '上传完成' : '上传解析进度'}</span><b>{uploadProgress.percent}%</b></div><progress max="100" value={uploadProgress.percent} /><small title={uploadProgress.detail}>{uploadProgress.detail}</small></div>}
    </div>, workspaceFooter)}

    <input ref={fileInputRef} type="file" hidden multiple accept=".md,.txt,.zip,text/markdown,text/plain,application/zip" onChange={uploadFiles} />

    {preview && <div className="requirement-input-backdrop preview" onMouseDown={event => { if (event.currentTarget === event.target) setPreview(null) }}>
      <section className="requirement-input-preview">
        <header><div><Eye /><span><b>{preview.document.title || preview.document.name}</b><small>{preview.document.version} · {preview.document.logicalPath}</small></span></div><button onClick={() => setPreview(null)}><XCircle /></button></header>
        <div className="requirement-input-preview-body">
          {preview.loading ? <div className="requirement-input-empty"><LoaderCircle className="rotating" /><b>正在读取固定版本</b></div> : <MarkdownDocument source={preview.content} format={preview.document.name.toLowerCase().endsWith('.txt') ? 'text' : 'markdown'} knowledgeBaseId={knowledgeBaseId} logicalPath={preview.document.logicalPath ?? ''} />}
        </div>
        <footer><span>AssetVersion：{preview.document.assetVersionId ?? '-'}</span>{projectVersion?.status === 'open' && <button className="btn danger" disabled={busy} onClick={() => void removeDocument(preview.document)}><Trash2 />删除文档</button>}</footer>
      </section>
    </div>}
  </div>
}
