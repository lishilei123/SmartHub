import { useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Archive, Eye, FileText, LoaderCircle, Trash2, Upload, XCircle } from 'lucide-react'
import { RequirementAnalysisPageV2 } from './RequirementAnalysisPageV2'
import { deleteKnowledgeAsset, loadAssetVersion, uploadKnowledgeArchive, uploadKnowledgeFile, waitForTaskResults } from './knowledge-api'
import { MarkdownDocument } from './MarkdownDocument'
import type { KnowledgeDocument } from './prototype-data'
import type { ProjectVersion } from './project-version-api'
import { requirementWorkspaceDirectory } from './version-document-path'
import './requirement-input-toolbar.css'

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

export function RequirementReviewPage(props: Props) {
  const { projectVersion, documents, knowledgeBaseId, apiState, refreshKnowledge, notify, addAudit } = props
  const fileInputRef = useRef<HTMLInputElement>(null)
  const archiveInputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [managerOpen, setManagerOpen] = useState(false)
  const [preview, setPreview] = useState<PreviewState | null>(null)

  const workspaceDirectoryPath = projectVersion ? requirementWorkspaceDirectory(projectVersion.name) : ''
  const inputDocuments = useMemo(() => documents.filter(document => {
    const logicalPath = document.logicalPath?.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '') ?? ''
    return Boolean(workspaceDirectoryPath) && logicalPath.startsWith(`${workspaceDirectoryPath}/`)
  }), [documents, workspaceDirectoryPath])

  const canManage = Boolean(projectVersion?.status === 'open' && knowledgeBaseId && apiState === 'ready' && !busy)

  const uploadFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    if (!files.length || !projectVersion || !canManage) return
    setBusy(true)
    try {
      const taskIds: string[] = []
      for (const file of files) {
        const name = safeFileName(file)
        const logicalPath = `${workspaceDirectoryPath}/${name}`
        const uploaded = await uploadKnowledgeFile(knowledgeBaseId, file, logicalPath, 'requirement')
        if (uploaded.task?.id) taskIds.push(uploaded.task.id)
      }
      await ensureTasksCompleted(taskIds)
      await refreshKnowledge()
      addAudit(`上传需求文档：${files.map(file => file.name).join('、')} → /${workspaceDirectoryPath}`)
      notify(`已上传 ${files.length} 份需求文档。`)
    } catch (error) {
      notify(error instanceof Error ? error.message : '需求文档上传失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const uploadArchive = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file || !projectVersion || !canManage) return
    setBusy(true)
    try {
      const uploaded = await uploadKnowledgeArchive(knowledgeBaseId, file, workspaceDirectoryPath, 'requirement')
      await ensureTasksCompleted(uploaded.taskIds)
      await refreshKnowledge()
      addAudit(`上传需求压缩包：${file.name} → /${workspaceDirectoryPath}`)
      notify(`压缩包已导入：${uploaded.documents} 份需求文档。`)
    } catch (error) {
      notify(error instanceof Error ? error.message : '需求 ZIP 上传失败', 'error')
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

  return <div className="requirement-review-v2-shell">
    {projectVersion && <section className="requirement-input-toolbar">
      <div className="requirement-input-title">
        <FileText />
        <span><b>需求输入</b><small>固定目录：/{workspaceDirectoryPath}</small></span>
        <em>{inputDocuments.length} 份</em>
      </div>
      <div className="requirement-input-actions">
        <button className="btn ghost" onClick={() => setManagerOpen(true)}><Eye />预览 / 管理</button>
        <button className="btn ghost" disabled={!canManage} onClick={() => fileInputRef.current?.click()}><Upload />上传需求文档</button>
        <button className="btn ghost" disabled={!canManage} onClick={() => archiveInputRef.current?.click()}><Archive />上传 ZIP</button>
        {busy && <span className="requirement-input-busy"><LoaderCircle className="rotating" />处理中</span>}
        <input ref={fileInputRef} type="file" hidden multiple accept=".md,.txt,text/markdown,text/plain" onChange={uploadFiles} />
        <input ref={archiveInputRef} type="file" hidden accept=".zip,application/zip" onChange={uploadArchive} />
      </div>
    </section>}

    <RequirementAnalysisPageV2 {...props} />

    {managerOpen && <div className="requirement-input-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) setManagerOpen(false) }}>
      <section className="requirement-input-manager">
        <header><div><FileText /><span><b>需求文档</b><small>点击文档即可预览；开放版本支持删除。</small></span></div><button onClick={() => setManagerOpen(false)}><XCircle /></button></header>
        <div className="requirement-input-manager-path">/{workspaceDirectoryPath}</div>
        <div className="requirement-input-manager-list">
          {inputDocuments.map(document => <article key={document.id}>
            <button className="requirement-input-document" onClick={() => void openPreview(document)}>
              <FileText />
              <span><b>{document.title || document.name}</b><small>{document.version} · {document.status ?? 'unknown'}</small><em>{document.logicalPath}</em></span>
            </button>
            <div className="requirement-input-row-actions">
              <button title="预览" onClick={() => void openPreview(document)}><Eye /></button>
              <button className="danger" title="删除" disabled={!canManage} onClick={() => void removeDocument(document)}><Trash2 /></button>
            </div>
          </article>)}
          {!inputDocuments.length && <div className="requirement-input-empty"><FileText /><b>暂无需求文档</b><p>点击“上传需求文档”或“上传 ZIP”导入当前版本需求。</p></div>}
        </div>
        <footer><button className="btn ghost" disabled={!canManage} onClick={() => fileInputRef.current?.click()}><Upload />上传需求文档</button><button className="btn ghost" disabled={!canManage} onClick={() => archiveInputRef.current?.click()}><Archive />上传 ZIP</button></footer>
      </section>
    </div>}

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
