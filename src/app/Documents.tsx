import { forwardRef, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Code2,
  Columns2,
  FileText,
  FolderOpen,
  FolderPlus,
  Library,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react'
import { type KnowledgeDocument } from '../prototype-data'
import {
  cancelTask,
  createKnowledgeDirectory,
  deleteKnowledgeAsset,
  deleteKnowledgeDirectory,
  loadAssetVersion,
  loadKnowledgeOverview,
  loadTasks,
  renameKnowledgeDirectory,
  retryTask,
  searchKnowledge,
  updateKnowledgeAsset,
  uploadKnowledgeArchive,
  uploadKnowledgeFile,
  type ApiIndexSummary,
  type ApiSearchMeta,
  type ApiSearchResult,
} from '../knowledge-api'
import { MarkdownDocument } from '../MarkdownDocument'
import { getActiveDocumentSectionKey, getClosestSourceLineIndex } from '../document-scroll'
import { emptyMarkdownOutline, parseMarkdownOutline, type MarkdownOutline } from '../markdown-outline'
import { type WorkspaceKnowledgeDirectory } from '../workspace-knowledge-tree'
import { type Notify, type JobStatus } from './types'
import { Badge, Modal } from './shared'

type SearchLocation = { assetId: string; assetVersionId: string; startLine: number; endLine: number; nonce: number }

const retrievalModeLabel = (mode: string) =>
  mode === 'hybrid' ? '混合检索' : mode === 'vector' ? '向量检索' : '关键词检索'

export function Documents({
  knowledgeBaseId,
  apiState,
  refreshKnowledge,
  loadDocument,
  directories,
  documents,
  workspaceRootDirectoryId,
  notify,
  addAudit,
}: {
  knowledgeBaseId: string
  apiState: 'connecting' | 'ready' | 'offline'
  refreshKnowledge: (includeDeleted?: boolean) => Promise<void>
  loadDocument: (document: KnowledgeDocument) => Promise<KnowledgeDocument>
  directories: WorkspaceKnowledgeDirectory[]
  documents: KnowledgeDocument[]
  workspaceRootDirectoryId: string | null
  notify: Notify
  addAudit: (entry: string) => void
}) {
  const [selectedId, setSelectedId] = useState(documents[0]?.id ?? '')
  const [selectedDirectoryId, setSelectedDirectoryId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<ApiSearchResult[]>([])
  const [searchMeta, setSearchMeta] = useState<ApiSearchMeta | null>(null)
  const [searchStatus, setSearchStatus] = useState('')
  const [searchLocation, setSearchLocation] = useState<SearchLocation | null>(null)
  const [evidenceFile, setEvidenceFile] = useState<KnowledgeDocument | null>(null)
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  const [outlineCollapsed, setOutlineCollapsed] = useState(false)
  const [viewMode, setViewMode] = useState<'preview' | 'source' | 'split'>('preview')
  const [activeSectionKey, setActiveSectionKey] = useState<string | null>(null)
  const [imageOpen, setImageOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [fileNameDraft, setFileNameDraft] = useState('')
  const [fileTargetDirectoryId, setFileTargetDirectoryId] = useState('')
  const [fileActionError, setFileActionError] = useState('')
  const [fileActionBusy, setFileActionBusy] = useState(false)
  const [syncState, setSyncState] = useState<JobStatus>('idle')
  const [uploadState, setUploadState] = useState<JobStatus>('idle')
  const [expandedDirectoryIds, setExpandedDirectoryIds] = useState<Set<string>>(() => new Set())
  const [directoryActionId, setDirectoryActionId] = useState<string | null>(null)
  const [directoryEditor, setDirectoryEditor] = useState<
    { mode: 'create'; parentId: string | null } | { mode: 'rename'; directoryId: string } | null
  >(null)
  const [directoryName, setDirectoryName] = useState('')
  const [directoryNameError, setDirectoryNameError] = useState('')
  const [directorySaving, setDirectorySaving] = useState(false)
  const [deleteDirectoryId, setDeleteDirectoryId] = useState<string | null>(null)
  const [moveTargetId, setMoveTargetId] = useState('')
  const timers = useRef<number[]>([])
  const uploadRef = useRef<HTMLInputElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const documentPanelRef = useRef<HTMLElement>(null)
  const outlineRef = useRef<HTMLElement>(null)
  const searchInputRef = useRef<HTMLDivElement>(null)
  const searchPopoverRef = useRef<HTMLDivElement>(null)
  const searchRequestRef = useRef(0)
  const searchResultQueryRef = useRef('')
  const searchResultStatusRef = useRef('')
  const [uploadCandidates, setUploadCandidates] = useState<File[]>([])
  const [uploadAssetType, setUploadAssetType] = useState('other')
  const [uploadLogicalPath, setUploadLogicalPath] = useState('')
  const [activeIndexSummary, setActiveIndexSummary] = useState<ApiIndexSummary | null>(null)
  const [candidateProgress, setCandidateProgress] = useState<{ step: string; progress: number } | null>(null)
  const [taskPollVersion, setTaskPollVersion] = useState(0)
  useEffect(() => () => timers.current.forEach(timer => window.clearTimeout(timer)), [])
  useEffect(() => {
    if (!knowledgeBaseId || apiState !== 'ready') return
    let cancelled = false
    let timer: number | undefined
    const refreshTaskState = async () => {
      try {
        const [overview, tasks] = await Promise.all([
          loadKnowledgeOverview(knowledgeBaseId),
          loadTasks(knowledgeBaseId),
        ])
        if (cancelled) return
        setActiveIndexSummary(overview.indexSummary)
        setCandidateProgress(
          overview.candidateSummary
            ? { step: overview.candidateSummary.task.step, progress: overview.candidateSummary.task.progress }
            : null,
        )
        const active = tasks.some(task => task.status === 'queued' || task.status === 'running')
        if (active) {
          await refreshKnowledge()
          if (!cancelled) timer = window.setTimeout(() => void refreshTaskState(), 1_000)
        }
      } catch {
        if (!cancelled) timer = window.setTimeout(() => void refreshTaskState(), 3_000)
      }
    }
    void refreshTaskState()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [apiState, knowledgeBaseId, refreshKnowledge, taskPollVersion])
  useEffect(() => {
    if (!documents.some(document => document.id === selectedId)) {
      setSelectedId(documents[0]?.id ?? '')
      setActiveSectionKey(null)
    }
  }, [documents, selectedId])
  useEffect(() => {
    if (selectedDirectoryId && !directories.some(directory => directory.id === selectedDirectoryId))
      setSelectedDirectoryId(null)
  }, [directories, selectedDirectoryId])
  useEffect(() => {
    const validDirectoryIds = new Set(directories.map(directory => directory.id))
    setExpandedDirectoryIds(current => {
      const next = new Set([...current].filter(directoryId => validDirectoryIds.has(directoryId)))
      return next.size === current.size ? current : next
    })
  }, [directories])
  useEffect(() => {
    if (!query.trim() || apiState !== 'ready') {
      searchRequestRef.current += 1
      searchResultQueryRef.current = ''
      searchResultStatusRef.current = ''
      setSearchResults([])
      setSearchMeta(null)
      setSearchStatus('')
      return
    }
    const timer = window.setTimeout(() => void search(), 350)
    return () => window.clearTimeout(timer)
  }, [query, apiState, knowledgeBaseId])
  useEffect(() => {
    if (!searchStatus) return
    const close = () => {
      searchRequestRef.current += 1
      setSearchStatus('')
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!searchInputRef.current?.contains(target) && !searchPopoverRef.current?.contains(target)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [searchStatus])

  const directoryById = useMemo(() => new Map(directories.map(directory => [directory.id, directory])), [directories])
  const directoriesByParent = useMemo(() => {
    const result = new Map<string | null, WorkspaceKnowledgeDirectory[]>()
    directories.forEach(directory =>
      result.set(directory.parentId, [...(result.get(directory.parentId) ?? []), directory]),
    )
    return result
  }, [directories])
  const documentsByParent = useMemo(() => {
    const result = new Map<string | null, KnowledgeDocument[]>()
    documents.forEach(document => result.set(document.parentId, [...(result.get(document.parentId) ?? []), document]))
    return result
  }, [documents])
  const documentCountByDirectory = useMemo(() => {
    const result = new Map<string, number>()
    const count = (directoryId: string): number => {
      const total =
        (documentsByParent.get(directoryId) ?? []).length +
        (directoriesByParent.get(directoryId) ?? []).reduce((sum, child) => sum + count(child.id), 0)
      result.set(directoryId, total)
      return total
    }
    directories.filter(directory => directory.parentId === null).forEach(directory => count(directory.id))
    return result
  }, [directories, directoriesByParent, documentsByParent])
  const queryText = query.trim().toLowerCase()
  const matchingDocumentIds = useMemo(
    () =>
      new Set(
        documents
          .filter(document =>
            `${document.name} ${document.intro} ${document.content ?? ''}`.toLowerCase().includes(queryText),
          )
          .map(document => document.id),
      ),
    [documents, queryText],
  )
  const visibleDirectoryIds = useMemo(() => {
    if (!queryText) return new Set(directories.map(directory => directory.id))
    const result = new Set<string>()
    documents
      .filter(document => matchingDocumentIds.has(document.id))
      .forEach(document => {
        let currentId = document.parentId
        while (currentId) {
          result.add(currentId)
          currentId = directoryById.get(currentId)?.parentId ?? null
        }
      })
    return result
  }, [directories, directoryById, documents, matchingDocumentIds, queryText])
  const deleteTarget = deleteDirectoryId ? directoryById.get(deleteDirectoryId) : undefined
  const deleteDirectoryIds = useMemo(() => {
    const result = new Set<string>()
    const collect = (directoryId: string) => {
      result.add(directoryId)
      ;(directoriesByParent.get(directoryId) ?? []).forEach(child => collect(child.id))
    }
    if (deleteDirectoryId) collect(deleteDirectoryId)
    return result
  }, [deleteDirectoryId, directoriesByParent])
  const moveCandidates = useMemo(
    () => directories.filter(directory => !deleteDirectoryIds.has(directory.id)),
    [deleteDirectoryIds, directories],
  )
  const currentFile = documents.find(document => document.id === selectedId)
  const file = evidenceFile?.id === selectedId ? evidenceFile : currentFile
  useEffect(() => {
    if (!currentFile?.assetVersionId || currentFile.content !== undefined) return
    let cancelled = false
    void loadDocument(currentFile).catch(error => {
      if (!cancelled) notify(error instanceof Error ? error.message : '文档正文加载失败', 'error')
    })
    return () => {
      cancelled = true
    }
  }, [currentFile?.assetVersionId, currentFile?.content, loadDocument])
  const documentContentLoading = Boolean(file?.assetVersionId && file.content === undefined)
  const source = file && !documentContentLoading ? makeSource(file) : ''
  const format = file?.name.toLowerCase().endsWith('.txt') ? 'text' : 'markdown'
  const outline = useMemo(
    () => (format === 'markdown' ? parseMarkdownOutline(source) : emptyMarkdownOutline),
    [format, source],
  )
  useEffect(() => {
    const preview = previewRef.current
    if (!preview || viewMode !== 'preview' || format !== 'markdown' || !outline.sections.length) {
      setActiveSectionKey(null)
      return
    }

    const getActiveSection = () => {
      const previewTop = preview.getBoundingClientRect().top
      const sections = [...preview.querySelectorAll<HTMLElement>('[data-document-section-key]')]
        .map(section => ({
          key: section.dataset.documentSectionKey ?? '',
          top: section.getBoundingClientRect().top - previewTop + preview.scrollTop,
        }))
        .filter(section => section.key)
      const key = getActiveDocumentSectionKey(sections, preview.scrollTop + 14)
      setActiveSectionKey(current => (current === key ? current : key))
    }

    getActiveSection()
    preview.addEventListener('scroll', getActiveSection, { passive: true })
    return () => preview.removeEventListener('scroll', getActiveSection)
  }, [format, outline, selectedId, viewMode])
  useEffect(() => {
    const outlineElement = outlineRef.current
    const activeButton = outlineElement?.querySelector<HTMLElement>('[data-outline-section-key].active')
    if (!outlineElement || !activeButton) return

    const outlineBounds = outlineElement.getBoundingClientRect()
    const buttonBounds = activeButton.getBoundingClientRect()
    if (buttonBounds.top < outlineBounds.top) outlineElement.scrollTop += buttonBounds.top - outlineBounds.top
    else if (buttonBounds.bottom > outlineBounds.bottom)
      outlineElement.scrollTop += buttonBounds.bottom - outlineBounds.bottom
  }, [activeSectionKey])
  useEffect(() => {
    if (
      !searchLocation ||
      searchLocation.assetId !== selectedId ||
      searchLocation.assetVersionId !== file?.assetVersionId ||
      viewMode !== 'preview'
    )
      return
    let highlighted: HTMLElement | null = null
    let highlightTimer = 0
    const frame = window.requestAnimationFrame(() => {
      const preview = previewRef.current
      if (!preview) return
      const located = [...preview.querySelectorAll<HTMLElement>('[data-source-start-line]')]
      const lines = located.map(element => Number(element.dataset.sourceStartLine ?? 0))
      const index = getClosestSourceLineIndex(lines, searchLocation.startLine)
      const target = index >= 0 ? located[index] : null
      if (target) {
        highlighted = target
        target.classList.add('search-location-hit')
        const top = target.getBoundingClientRect().top - preview.getBoundingClientRect().top + preview.scrollTop - 18
        preview.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
        const sectionElements = [
          ...preview.querySelectorAll<HTMLElement>('[data-document-section-key][data-source-start-line]'),
        ]
        const sectionIndex = getClosestSourceLineIndex(
          sectionElements.map(element => Number(element.dataset.sourceStartLine ?? 0)),
          searchLocation.startLine,
        )
        const sectionKey = sectionIndex >= 0 ? sectionElements[sectionIndex].dataset.documentSectionKey : null
        if (sectionKey) setActiveSectionKey(sectionKey)
        highlightTimer = window.setTimeout(() => target.classList.remove('search-location-hit'), 2600)
      } else {
        const totalLines = Math.max(1, source.split('\n').length - 1)
        const ratio = Math.max(0, Math.min(1, (searchLocation.startLine - 1) / totalLines))
        preview.scrollTo({ top: ratio * Math.max(0, preview.scrollHeight - preview.clientHeight), behavior: 'smooth' })
      }
    })
    return () => {
      window.cancelAnimationFrame(frame)
      if (highlightTimer) window.clearTimeout(highlightTimer)
      highlighted?.classList.remove('search-location-hit')
    }
  }, [file?.assetVersionId, format, searchLocation, selectedId, source, viewMode])
  useEffect(() => {
    if (searchLocation?.assetId === selectedId) return
    const frame = window.requestAnimationFrame(() => {
      const panel = documentPanelRef.current
      panel?.querySelectorAll<HTMLElement>('.markdown-view, .source-view, .split-markdown').forEach(element => {
        element.scrollTop = 0
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [searchLocation, selectedId])

  const getDirectoryBreadcrumb = (directoryId: string) => {
    const names: string[] = []
    const visited = new Set<string>()
    let currentId: string | null = directoryId
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId)
      const directory = directoryById.get(currentId)
      if (!directory) break
      names.unshift(directory.name)
      currentId = directory.parentId
    }
    return ['知识库', ...names].join(' / ')
  }
  const getDirectoryLogicalPath = (directoryId: string) => directoryById.get(directoryId)?.logicalPath ?? ''
  const getBreadcrumb = (document: KnowledgeDocument) =>
    `${getDirectoryBreadcrumb(document.parentId ?? '').replace(/ \/ $/, '')} / ${document.name}`
  const isExpanded = (directoryId: string) =>
    queryText ? visibleDirectoryIds.has(directoryId) : expandedDirectoryIds.has(directoryId)
  const toggleDirectory = (directoryId: string) =>
    setExpandedDirectoryIds(current => {
      const next = new Set(current)
      if (next.has(directoryId)) next.delete(directoryId)
      else next.add(directoryId)
      return next
    })
  const closeEditor = () => {
    setDirectoryEditor(null)
    setDirectoryName('')
    setDirectoryNameError('')
  }
  const openCreate = (parentId: string | null) => {
    setDirectoryActionId(null)
    setDirectoryEditor({ mode: 'create', parentId })
    setDirectoryName('')
    setDirectoryNameError('')
  }
  const openRename = (directory: WorkspaceKnowledgeDirectory) => {
    setDirectoryActionId(null)
    setDirectoryEditor({ mode: 'rename', directoryId: directory.id })
    setDirectoryName(directory.name)
    setDirectoryNameError('')
  }
  const saveDirectory = async () => {
    if (!directoryEditor) return
    const value = directoryName.trim()
    const editedDirectory =
      directoryEditor.mode === 'rename' ? directoryById.get(directoryEditor.directoryId) : undefined
    const parentId = (directoryEditor.mode === 'create' ? directoryEditor.parentId : editedDirectory?.parentId) ?? null
    if (!value) {
      setDirectoryNameError('请输入目录名称。')
      return
    }
    if (
      directories.some(
        directory =>
          directory.parentId === parentId &&
          directory.id !== editedDirectory?.id &&
          directory.name.trim().toLocaleLowerCase() === value.toLocaleLowerCase(),
      )
    ) {
      setDirectoryNameError('同一目录下已存在相同名称。')
      return
    }
    setDirectorySaving(true)
    try {
      if (directoryEditor.mode === 'create') {
        const created = await createKnowledgeDirectory(knowledgeBaseId, value, parentId)
        await refreshKnowledge()
        setExpandedDirectoryIds(current => new Set([...current, created.id, ...(parentId ? [parentId] : [])]))
        setSelectedDirectoryId(created.id)
        addAudit(`创建知识库目录：${value}`)
        notify('目录已保存到知识库。')
      } else if (editedDirectory) {
        await renameKnowledgeDirectory(editedDirectory.id, value)
        await refreshKnowledge()
        setSelectedDirectoryId(editedDirectory.id)
        addAudit(`重命名知识库目录：${editedDirectory.name} → ${value}`)
        notify('目录名称及相关文档路径已保存。')
      }
      closeEditor()
    } catch (error) {
      setDirectoryNameError(error instanceof Error ? error.message : '目录保存失败')
    } finally {
      setDirectorySaving(false)
    }
  }
  const openDelete = (directory: WorkspaceKnowledgeDirectory) => {
    setDirectoryActionId(null)
    setDeleteDirectoryId(directory.id)
    setMoveTargetId(directory.parentId ?? workspaceRootDirectoryId ?? '')
  }
  const closeDelete = () => {
    setDeleteDirectoryId(null)
    setMoveTargetId('')
  }
  const deleteEverything = async () => {
    if (!deleteTarget) return
    try {
      const result = await deleteKnowledgeDirectory(deleteTarget.id, 'recursive')
      await refreshKnowledge()
      setTaskPollVersion(version => version + 1)
      setSelectedDirectoryId(null)
      addAudit(`提交删除知识库目录及内容：${deleteTarget.name}`)
      notify('目录删除任务已提交，索引切换完成后将清理文件。')
      closeDelete()
      if ('task' in result && result.task) setExpandedDirectoryIds(current => new Set([...current, deleteTarget.id]))
    } catch (error) {
      notify(error instanceof Error ? error.message : '目录删除失败', 'error')
    }
  }
  const moveContents = async () => {
    if (!deleteTarget) return
    const parentId = moveTargetId || null
    const movedDirectories = directories.filter(directory => directory.parentId === deleteTarget.id).length
    const movedDocuments = documents.filter(document => document.parentId === deleteTarget.id).length
    const destination = parentId
      ? (directoryById.get(parentId)?.name ?? (parentId === workspaceRootDirectoryId ? '/workspace' : '目标目录'))
      : '/workspace'
    try {
      await deleteKnowledgeDirectory(deleteTarget.id, 'move', parentId)
      await refreshKnowledge()
      setExpandedDirectoryIds(current => {
        const next = new Set(current)
        next.delete(deleteTarget.id)
        if (parentId) next.add(parentId)
        return next
      })
      setSelectedDirectoryId(null)
      addAudit(`移动“${deleteTarget.name}”的 ${movedDirectories} 个子目录和 ${movedDocuments} 份文档至“${destination}”`)
      notify('目录内容已移动，目录变更已保存。')
      closeDelete()
    } catch (error) {
      notify(error instanceof Error ? error.message : '目录移动失败')
    }
  }
  const sync = async () => {
    if (!knowledgeBaseId) return
    setSyncState('running')
    try {
      await refreshKnowledge()
      setSyncState('completed')
      addAudit('刷新知识库真实状态')
      notify('知识库状态已刷新。')
    } catch (error) {
      setSyncState('failed')
      notify(error instanceof Error ? error.message : '刷新失败')
    }
  }
  const search = async () => {
    const searchQuery = query.trim()
    if (!searchQuery || !knowledgeBaseId) return
    const requestId = ++searchRequestRef.current
    try {
      const result = await searchKnowledge(knowledgeBaseId, searchQuery)
      if (requestId !== searchRequestRef.current) return
      searchResultQueryRef.current = searchQuery
      searchResultStatusRef.current = result.status
      setSearchResults(result.results)
      setSearchMeta(result.retrieval ?? null)
      setSearchStatus(result.status)
    } catch (error) {
      if (requestId === searchRequestRef.current) notify(error instanceof Error ? error.message : '检索失败')
    }
  }
  const updateSearchQuery = (value: string) => {
    setQuery(value)
    if (value.trim() !== searchResultQueryRef.current) setSearchStatus('')
  }
  const reopenSearchResults = () => {
    const searchQuery = query.trim()
    if (!searchQuery) return
    if (searchQuery === searchResultQueryRef.current && searchResultStatusRef.current)
      setSearchStatus(searchResultStatusRef.current)
    else void search()
  }
  const chooseUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = [...(event.target.files ?? [])]
    event.target.value = ''
    if (!selected.length) return
    const archives = selected.filter(file => file.name.toLowerCase().endsWith('.zip'))
    if (archives.length && selected.length > 1) {
      notify('ZIP 压缩包需要单独上传，不能与 Markdown 文件混选。')
      return
    }
    setUploadCandidates(selected)
    const directoryPath = selectedDirectoryId
      ? getDirectoryLogicalPath(selectedDirectoryId)
      : 'workspace/shared/knowledge'
    setUploadLogicalPath(
      selected.length === 1 && !archives.length
        ? directoryPath
          ? `${directoryPath}/${selected[0].name}`
          : selected[0].name
        : directoryPath,
    )
  }
  const upload = async () => {
    const uploaded = uploadCandidates
    if (!uploaded.length || !knowledgeBaseId) return
    setUploadState('running')
    try {
      if (uploaded[0].name.toLowerCase().endsWith('.zip')) {
        const result = await uploadKnowledgeArchive(knowledgeBaseId, uploaded[0], uploadLogicalPath, uploadAssetType)
        await refreshKnowledge()
        setTaskPollVersion(version => version + 1)
        setUploadState('completed')
        setUploadCandidates([])
        addAudit(`上传 Markdown 压缩包：${uploaded[0].name}`)
        notify(
          `已提交 ${result.documents} 篇文档的入库任务${result.skipped ? `，跳过 ${result.skipped} 个不支持文件` : ''}。`,
        )
      } else {
        let succeeded = 0
        let deduplicated = 0
        const failed: string[] = []
        const targetDirectory =
          uploaded.length > 1 ? uploadLogicalPath.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '') : ''
        for (const file of uploaded) {
          const logicalPath =
            uploaded.length === 1 ? uploadLogicalPath : [targetDirectory, file.name].filter(Boolean).join('/')
          try {
            const result = await uploadKnowledgeFile(knowledgeBaseId, file, logicalPath, uploadAssetType)
            succeeded += 1
            if (result.deduplicated) deduplicated += 1
            addAudit(`上传知识资产：${logicalPath}`)
          } catch {
            failed.push(file.name)
          }
        }
        await refreshKnowledge()
        if (succeeded) setTaskPollVersion(version => version + 1)
        setUploadState(succeeded ? 'completed' : 'failed')
        if (succeeded) setUploadCandidates([])
        notify(
          `已上传 ${succeeded} 个文档${deduplicated ? `，其中 ${deduplicated} 个内容未变化` : ''}${failed.length ? `；失败 ${failed.length} 个：${failed.join('、')}` : ''}。`,
        )
      }
    } catch (error) {
      setUploadState('failed')
      notify(error instanceof Error ? error.message : '上传失败')
    }
  }
  const clearEvidencePreview = () => {
    setEvidenceFile(null)
    setSearchLocation(null)
  }
  const selectFile = (id: string) => {
    setSelectedId(id)
    setActiveSectionKey(null)
    clearEvidencePreview()
    setSelectedDirectoryId(null)
  }
  const openSearchResult = async (result: ApiSearchResult) => {
    const requestId = ++searchRequestRef.current
    setSelectedId(result.asset.id)
    setSelectedDirectoryId(null)
    setViewMode('preview')
    setActiveSectionKey(null)
    setSearchStatus('')
    try {
      const version = await loadAssetVersion(result.version.id)
      if (requestId !== searchRequestRef.current) return
      const name = result.asset.displayName
      const format = name.toLowerCase().endsWith('.txt') ? 'text' : 'markdown'
      const outline = format === 'markdown' ? parseMarkdownOutline(version.content) : undefined
      setEvidenceFile({
        id: result.asset.id,
        name,
        parentId: null,
        version: `V${result.version.number}`,
        updated: version.readyAt
          ? new Date(version.readyAt).toLocaleString('zh-CN')
          : new Date(version.createdAt).toLocaleString('zh-CN'),
        title: outline?.title ?? name.replace(/\.(md|txt)$/i, ''),
        intro:
          version.content
            .split('\n')
            .find(line => line.trim() && !line.startsWith('#'))
            ?.trim() ?? '',
        sections: outline?.sections.map(section => section.title) ?? [],
        content: version.content,
        assetType: result.asset.assetType,
        sourceType: result.asset.sourceType,
        assetVersionId: version.id,
        versions: [{ id: version.id, number: version.number, status: version.status, createdAt: version.createdAt }],
        status: version.status,
        logicalPath: result.asset.logicalPath,
      })
      setSearchLocation({
        assetId: result.asset.id,
        assetVersionId: version.id,
        startLine: result.chunk.startLine,
        endLine: result.chunk.endLine,
        nonce: Date.now(),
      })
      notify(`已打开检索证据固定版本 V${result.version.number} · L${result.chunk.startLine}-${result.chunk.endLine}`)
    } catch (error) {
      if (requestId === searchRequestRef.current)
        notify(error instanceof Error ? error.message : '固定版本加载失败', 'error')
    }
  }
  const openLinkedDocument = (logicalPath: string) => {
    const linked = documents.find(
      document => document.logicalPath?.replaceAll('\\', '/').toLocaleLowerCase() === logicalPath.toLocaleLowerCase(),
    )
    if (!linked) {
      notify(`知识库中未找到链接文档：${logicalPath}`)
      return
    }
    selectFile(linked.id)
  }
  const openFileActions = (target: KnowledgeDocument | undefined = file) => {
    if (!target) return
    setSelectedId(target.id)
    setFileNameDraft(target.name)
    setFileTargetDirectoryId(target.parentId ?? workspaceRootDirectoryId ?? '')
    setFileActionError('')
    setMoreOpen(true)
  }
  const renameFile = async () => {
    if (!file) return
    setFileActionBusy(true)
    setFileActionError('')
    try {
      await updateKnowledgeAsset(file.id, { displayName: fileNameDraft })
      clearEvidencePreview()
      await refreshKnowledge()
      addAudit(`重命名知识文件：${file.name} → ${fileNameDraft}`)
      notify('文件名称及物理路径已保存。')
      setMoreOpen(false)
    } catch (error) {
      setFileActionError(error instanceof Error ? error.message : '文件重命名失败')
    } finally {
      setFileActionBusy(false)
    }
  }
  const moveFile = async () => {
    if (!file) return
    setFileActionBusy(true)
    setFileActionError('')
    try {
      await updateKnowledgeAsset(file.id, { targetDirectoryId: fileTargetDirectoryId || null })
      clearEvidencePreview()
      await refreshKnowledge()
      addAudit(`移动知识文件：${file.name}`)
      notify('文件已移动并保存到目标目录。')
      setMoreOpen(false)
    } catch (error) {
      setFileActionError(error instanceof Error ? error.message : '文件移动失败')
    } finally {
      setFileActionBusy(false)
    }
  }
  const deleteFile = async () => {
    if (!file) return
    setFileActionBusy(true)
    setFileActionError('')
    try {
      const deletedName = file.name
      await deleteKnowledgeAsset(file.id)
      setMoreOpen(false)
      await refreshKnowledge()
      setTaskPollVersion(version => version + 1)
      addAudit(`提交删除知识文件：${deletedName}`)
      notify('已提交删除任务，活动索引完成切换后将移除文件。')
    } catch (error) {
      setFileActionError(error instanceof Error ? error.message : '文件删除失败')
    } finally {
      setFileActionBusy(false)
    }
  }
  const retryRowTask = async (taskId: string) => {
    try {
      await retryTask(taskId)
      await refreshKnowledge()
      setTaskPollVersion(version => version + 1)
      notify('已重新提交任务。')
    } catch (error) {
      notify(error instanceof Error ? error.message : '任务重试失败', 'error')
    }
  }
  const cancelRowTask = async (taskId: string) => {
    try {
      await cancelTask(taskId)
      await refreshKnowledge()
      notify('已取消任务。')
    } catch (error) {
      notify(error instanceof Error ? error.message : '任务取消失败', 'error')
    }
  }
  const jumpToSection = (sectionKey: string) => {
    const preview = previewRef.current
    const target = preview?.querySelector<HTMLElement>(`[data-document-section-key="${sectionKey}"]`)
    setActiveSectionKey(sectionKey)
    if (!preview || !target) return

    const top = target.getBoundingClientRect().top - preview.getBoundingClientRect().top + preview.scrollTop - 14
    preview.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }
  const renderTask = (task: KnowledgeDocument['task'] | WorkspaceKnowledgeDirectory['task']) =>
    task ? (
      <span className={`tree-task ${task.status}`} title={task.error ?? `${task.step} ${task.progress}%`}>
        <span>
          {task.status === 'failed'
            ? '失败'
            : task.status === 'queued'
              ? '排队'
              : task.step === 'file_cleanup'
                ? '清理中'
                : `${task.progress}%`}
        </span>
        {task.canRetry && (
          <button
            onClick={event => {
              event.stopPropagation()
              void retryRowTask(task.id)
            }}
          >
            重试
          </button>
        )}
        {task.canCancel && (
          <button
            onClick={event => {
              event.stopPropagation()
              void cancelRowTask(task.id)
            }}
          >
            取消
          </button>
        )}
      </span>
    ) : null
  const renderFile = (document: KnowledgeDocument, paddingLeft: string) => (
    <div className={`tree-file-row ${selectedId === document.id ? 'active' : ''}`} key={document.id}>
      <button
        className={`tree-file ${selectedId === document.id ? 'active' : ''}`}
        style={{ paddingLeft }}
        onClick={() => selectFile(document.id)}
        title={document.task?.error ?? document.name}
      >
        <FileText />
        <span>{document.name}</span>
      </button>
      {renderTask(document.task)}
      <button
        className="icon-btn tree-file-action"
        aria-label={`${document.name}更多操作`}
        disabled={Boolean(document.task && document.task.status !== 'failed')}
        onClick={() => openFileActions(document)}
      >
        <MoreHorizontal />
      </button>
    </div>
  )
  const renderDirectory = (directory: WorkspaceKnowledgeDirectory, depth: number): ReactNode => {
    if (queryText && !visibleDirectoryIds.has(directory.id)) return null
    const childDirectories = directoriesByParent.get(directory.id) ?? []
    const childDocuments = (documentsByParent.get(directory.id) ?? []).filter(
      document => !queryText || matchingDocumentIds.has(document.id),
    )
    const hasChildren = childDirectories.length + (documentsByParent.get(directory.id) ?? []).length > 0
    const expanded = isExpanded(directory.id)
    return (
      <div className="tree-directory" key={directory.id}>
        <div
          className={`tree-folder ${selectedDirectoryId === directory.id ? 'selected' : ''}`}
          style={{ paddingLeft: `${8 + depth * 17}px` }}
        >
          {hasChildren ? (
            <button
              className="tree-expand"
              onClick={() => toggleDirectory(directory.id)}
              aria-label={expanded ? `收起${directory.name}` : `展开${directory.name}`}
              aria-expanded={expanded}
            >
              {expanded ? <ChevronDown /> : <ChevronRight />}
            </button>
          ) : (
            <span className="tree-expand-placeholder" />
          )}
          <button
            className="tree-folder-name"
            onClick={() => {
              setSelectedDirectoryId(directory.id)
              if (hasChildren) toggleDirectory(directory.id)
            }}
            title={directory.task?.error ?? directory.name}
          >
            <FolderOpen />
            <span>{directory.name}</span>
          </button>
          {renderTask(directory.task)}
          <small>{documentCountByDirectory.get(directory.id) ?? 0}</small>
          {directory.persisted && (
            <button
              className="icon-btn tree-action"
              disabled={Boolean(directory.task && directory.task.status !== 'failed')}
              aria-label={`${directory.name}更多操作`}
              onClick={() => setDirectoryActionId(current => (current === directory.id ? null : directory.id))}
            >
              <MoreHorizontal />
            </button>
          )}
          {directory.persisted && directoryActionId === directory.id && (
            <div className="tree-menu" role="menu">
              <button role="menuitem" onClick={() => openCreate(directory.id)}>
                <FolderPlus />
                新建子目录
              </button>
              {!directory.structural && (
                <>
                  <button role="menuitem" onClick={() => openRename(directory)}>
                    <Pencil />
                    重命名
                  </button>
                  <button className="danger" role="menuitem" onClick={() => openDelete(directory)}>
                    <Trash2 />
                    删除目录
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        {expanded && (
          <div className="tree-children">
            {childDirectories.map(child => renderDirectory(child, depth + 1))}
            {childDocuments.map(document => renderFile(document, `${47 + depth * 17}px`))}
          </div>
        )}
      </div>
    )
  }
  const rootDirectories = directoriesByParent.get(null) ?? []
  const rootDocuments = (documentsByParent.get(null) ?? []).filter(
    document => !queryText || matchingDocumentIds.has(document.id),
  )
  const editorTarget = directoryEditor?.mode === 'rename' ? directoryById.get(directoryEditor.directoryId) : undefined
  const editorParentId = directoryEditor?.mode === 'create' ? directoryEditor.parentId : editorTarget?.parentId
  const editorParentName = editorParentId ? (directoryById.get(editorParentId)?.name ?? '/workspace') : '/workspace'
  const deletedDocumentCount = documents.filter(
    document => document.parentId && deleteDirectoryIds.has(document.parentId),
  ).length
  const uploadIsArchive = uploadCandidates.length === 1 && uploadCandidates[0].name.toLowerCase().endsWith('.zip')
  const uploadIsMultiple = uploadCandidates.length > 1
  const uploadDirectorySuggestions = directories
    .map(directory => directory.logicalPath)
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
  const uploadPathSuggestions =
    uploadIsArchive || uploadIsMultiple
      ? uploadDirectorySuggestions
      : uploadCandidates.length === 1
        ? [uploadCandidates[0].name, ...uploadDirectorySuggestions.map(path => `${path}/${uploadCandidates[0].name}`)]
        : []

  return (
    <section className="card knowledge-page">
      <div className="knowledge-toolbar">
        <div ref={searchInputRef} className="mini-search wide">
          <Search size={16} />
          <input
            aria-label="搜索知识库"
            value={query}
            onChange={event => updateSearchQuery(event.target.value)}
            onFocus={reopenSearchResults}
            placeholder="搜索文件名称或文档内容"
          />
        </div>
        <Badge tone={apiState === 'ready' ? 'green' : apiState === 'connecting' ? 'orange' : 'gray'}>
          {apiState === 'ready' ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
          {apiState === 'ready' ? '知识库已连接' : apiState === 'connecting' ? '正在连接' : 'API 未启动'}
        </Badge>
        {activeIndexSummary && (
          <Badge tone="blue">
            活动索引 V{activeIndexSummary.number} · {activeIndexSummary.dimensions} 维 · {activeIndexSummary.chunks}{' '}
            Chunk ·{' '}
            {activeIndexSummary.hnswReady === null
              ? '内存检索'
              : activeIndexSummary.hnswReady
                ? 'HNSW 就绪'
                : '精确检索'}
          </Badge>
        )}
        {candidateProgress && (
          <Badge tone="orange">
            候选索引 {candidateProgress.step} · {candidateProgress.progress}%（旧索引继续服务）
          </Badge>
        )}
        <button
          className="btn ghost"
          disabled={syncState === 'running' || apiState !== 'ready'}
          onClick={() => void sync()}
        >
          <RefreshCw size={16} />
          {syncState === 'running' ? '刷新中' : '刷新'}
        </button>
        <button
          className="btn primary"
          disabled={uploadState === 'running' || apiState !== 'ready'}
          onClick={() => uploadRef.current?.click()}
        >
          <Upload size={16} />
          {uploadState === 'running' ? '上传中' : '上传资料'}
        </button>
        <input
          ref={uploadRef}
          className="visually-hidden"
          type="file"
          multiple
          accept=".zip,.md,.txt,application/zip,text/markdown,text/plain"
          onChange={chooseUpload}
        />
        {searchStatus && (
          <div ref={searchPopoverRef} className="knowledge-search-results" role="dialog" aria-label="知识库检索结果">
            {searchMeta && (
              <div className="search-summary">
                <b>
                  {retrievalModeLabel(searchMeta.mode)}
                  {searchMeta.degraded ? '（已降级）' : ''}
                </b>
                <span>
                  关键词召回 {searchMeta.keywordCandidates} · 向量召回 {searchMeta.vectorCandidates} · 通过门槛{' '}
                  {searchMeta.eligibleCandidates}
                </span>
                <em>
                  {searchMeta.degraded
                    ? '向量服务不可用，已使用关键词检索'
                    : `最低相关度 ${Math.round(searchMeta.minimumRelevance * 100)}%`}
                </em>
              </div>
            )}
            {searchResults.length ? (
              searchResults.map(result => (
                <button key={`${result.version.id}-${result.chunk.chunkKey}`} onClick={() => openSearchResult(result)}>
                  <b>
                    {result.asset.displayName}
                    <em className="final-score">综合 {Math.round(result.score * 100)}%</em>
                  </b>
                  <span>{result.excerpt}</span>
                  <small>
                    {result.asset.logicalPath} · {result.chunk.headingPath.join(' / ') || '正文'} · L
                    {result.chunk.startLine}-{result.chunk.endLine}
                  </small>
                  {result.scores && (
                    <div className="score-breakdown">
                      <i className={result.scores.keyword > 0 ? 'active' : ''}>
                        关键词 {Math.round(result.scores.keyword * 100)}%
                      </i>
                      <i className={result.scores.vector > 0 ? 'active' : ''}>
                        向量 {Math.round(result.scores.vector * 100)}%
                      </i>
                      {result.scores.reranker != null && (
                        <i className="active">重排 {Math.round(result.scores.reranker * 100)}%</i>
                      )}
                    </div>
                  )}
                </button>
              ))
            ) : (
              <p>
                {searchStatus === 'no_ready_assets'
                  ? '尚无已就绪资料。'
                  : searchStatus === 'initial_indexing'
                    ? '正在建立首个索引，请稍后重试。'
                    : searchStatus === 'no_active_index'
                      ? '尚未建立活动索引。'
                      : searchStatus === 'vector_unavailable'
                        ? '向量服务暂不可用，可切换关键词检索。'
                        : searchStatus === 'filter_empty'
                          ? '当前筛选范围没有可检索资料。'
                          : '当前范围没有匹配结果。'}
              </p>
            )}
          </div>
        )}
      </div>
      <div className={`knowledge-layout ${treeCollapsed ? 'tree-collapsed' : ''}`}>
        <aside className={`file-tree ${treeCollapsed ? 'collapsed' : ''}`}>
          <div className="tree-root" title="/workspace">
            <FolderOpen />
            <b>知识库</b>
            <small>{documents.length}</small>
            {workspaceRootDirectoryId && (
              <button
                className="icon-btn tree-root-action"
                onClick={() => openCreate(workspaceRootDirectoryId)}
                aria-label="在 /workspace 新建目录"
              >
                <FolderPlus />
              </button>
            )}
            <button
              className="icon-btn tree-collapse"
              title={treeCollapsed ? '展开文件树' : '收起文件树'}
              aria-label={treeCollapsed ? '展开文件树' : '收起文件树'}
              onClick={() => setTreeCollapsed(value => !value)}
            >
              {treeCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            </button>
          </div>
          {queryText && !matchingDocumentIds.size ? (
            <p className="empty-state">没有匹配的文档。</p>
          ) : (
            <div className="tree-content">
              {rootDirectories.map(directory => renderDirectory(directory, 0))}
              {rootDocuments.map(document => renderFile(document, '30px'))}
            </div>
          )}
        </aside>
        <article ref={documentPanelRef} className={`document-preview ${outlineCollapsed ? 'outline-collapsed' : ''}`}>
          <div className="preview-head">
            <div className="breadcrumb">
              <Library size={14} />
              <span title={file ? getBreadcrumb(file) : undefined}>{file ? getBreadcrumb(file) : '尚未选择文档'}</span>
            </div>
            {file && (
              <div className="preview-actions">
                {evidenceFile && <Badge tone="purple">检索证据固定版本</Badge>}
                <Badge
                  tone={
                    file.task?.status === 'failed'
                      ? 'red'
                      : file.task
                        ? 'orange'
                        : file.status === 'ready'
                          ? 'green'
                          : 'gray'
                  }
                >
                  {file.task?.status === 'failed'
                    ? '入库失败'
                    : file.task
                      ? `${file.task.step} ${file.task.progress}%`
                      : file.status === 'ready'
                        ? '已入库'
                        : '等待入库'}
                </Badge>
                <div className="view-switch" role="group" aria-label="文档视图">
                  <button
                    className={viewMode === 'preview' ? 'active' : ''}
                    aria-pressed={viewMode === 'preview'}
                    onClick={() => setViewMode('preview')}
                  >
                    <BookOpen />
                    预览
                  </button>
                  <button
                    className={viewMode === 'source' ? 'active' : ''}
                    aria-pressed={viewMode === 'source'}
                    onClick={() => setViewMode('source')}
                  >
                    <Code2 />
                    源码
                  </button>
                  <button
                    className={viewMode === 'split' ? 'active' : ''}
                    aria-pressed={viewMode === 'split'}
                    onClick={() => setViewMode('split')}
                  >
                    <Columns2 />
                    分屏
                  </button>
                </div>
                <button className="btn ghost" onClick={() => setHistoryOpen(true)}>
                  <Clock3 />
                  版本历史
                </button>
                <button
                  className="icon-btn"
                  title={outlineCollapsed ? '显示本文目录' : '隐藏本文目录'}
                  aria-label={outlineCollapsed ? '显示本文目录' : '隐藏本文目录'}
                  onClick={() => setOutlineCollapsed(value => !value)}
                >
                  {outlineCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
                </button>
                <button className="icon-btn" aria-label="文档更多操作" onClick={() => openFileActions()}>
                  <MoreHorizontal />
                </button>
              </div>
            )}
          </div>
          {file ? (
            documentContentLoading ? (
              <div className="document-empty" role="status">
                <RefreshCw className="document-loading-icon" />
                <h2>正在加载文档正文</h2>
                <p>列表已就绪，正在读取所选固定版本。</p>
              </div>
            ) : viewMode === 'preview' ? (
              <div className="preview-body">
                <DocumentContent
                  ref={previewRef}
                  file={file}
                  source={source}
                  format={format}
                  outline={outline}
                  knowledgeBaseId={knowledgeBaseId}
                  activeSectionKey={activeSectionKey}
                  onOpenDocument={openLinkedDocument}
                  onOpenImage={() => setImageOpen(true)}
                />
                <nav ref={outlineRef} className="document-outline" aria-label="本文目录">
                  <b>本文目录</b>
                  {outline.sections.map(section => (
                    <button
                      key={section.key}
                      data-outline-section-key={section.key}
                      className={activeSectionKey === section.key ? 'active' : ''}
                      onClick={() => jumpToSection(section.key)}
                    >
                      {section.title}
                    </button>
                  ))}
                </nav>
              </div>
            ) : viewMode === 'source' ? (
              <SourceView source={source} />
            ) : (
              <div className="split-view">
                <section className="split-pane source-pane">
                  <header>
                    <Code2 />
                    Markdown 源码 <Badge tone="orange">只读</Badge>
                  </header>
                  <SourceView source={source} />
                </section>
                <section className="split-pane rendered-pane">
                  <header>
                    <BookOpen />
                    渲染预览
                  </header>
                  <DocumentContent
                    file={file}
                    source={source}
                    format={format}
                    outline={outline}
                    knowledgeBaseId={knowledgeBaseId}
                    activeSectionKey={activeSectionKey}
                    onOpenDocument={openLinkedDocument}
                    onOpenImage={() => setImageOpen(true)}
                    compact
                  />
                </section>
              </div>
            )
          ) : (
            <div className="document-empty">
              <FolderOpen />
              <h2>暂无可预览文档</h2>
              <p>请上传资料，或检查知识库服务连接后再刷新。</p>
            </div>
          )}
        </article>
      </div>
      {imageOpen && <ImageLightbox onClose={() => setImageOpen(false)} />}
      {uploadCandidates.length > 0 && (
        <Modal
          title={
            uploadIsArchive
              ? '上传 Markdown 压缩包'
              : uploadIsMultiple
                ? `批量上传 ${uploadCandidates.length} 个文档`
                : '上传知识资产'
          }
          onClose={() => setUploadCandidates([])}
        >
          <div className="modal-form">
            <p>
              {uploadIsArchive
                ? '将保留 ZIP 内的目录结构，导入 Markdown/TXT，并保存其中被文档相对路径引用的 PNG、JPG、GIF、WebP 或 SVG 图片。'
                : uploadIsMultiple
                  ? '所选 Markdown/TXT 将统一上传到目标目录，每个文件独立生成资产版本并进入活动索引。'
                  : '文件将按逻辑路径保存到系统默认知识库目录，并生成不可变版本快照；索引切换完成后进入检索。'}
            </p>
            <label>
              {uploadIsMultiple ? '已选文件' : '文件'}
              <input
                value={
                  uploadIsMultiple
                    ? `${uploadCandidates.length} 个：${uploadCandidates.map(file => file.name).join('、')}`
                    : uploadCandidates[0].name
                }
                readOnly
                title={uploadCandidates.map(file => file.name).join('\n')}
              />
            </label>
            <label>
              资料类型
              <input
                value={uploadAssetType}
                onChange={event => setUploadAssetType(event.target.value)}
                placeholder="输入资料类型"
              />
            </label>
            <label>
              {uploadIsArchive || uploadIsMultiple ? '导入到目录（可留空）' : '知识库路径'}
              <input
                list="knowledge-upload-paths"
                value={uploadLogicalPath}
                onChange={event => setUploadLogicalPath(event.target.value)}
                placeholder={uploadIsArchive || uploadIsMultiple ? '输入或选择现有目录' : '输入或选择知识库路径'}
              />
              <small className="field-hint">可从现有知识库目录中选择，也可以直接输入新路径。</small>
            </label>
            <datalist id="knowledge-upload-paths">
              {uploadPathSuggestions.map(path => (
                <option key={path} value={path} />
              ))}
            </datalist>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setUploadCandidates([])}>
                取消
              </button>
              <button
                className="btn primary"
                disabled={
                  (!uploadIsArchive && !uploadIsMultiple && !uploadLogicalPath.trim()) ||
                  !uploadAssetType.trim() ||
                  uploadState === 'running'
                }
                onClick={() => void upload()}
              >
                <Upload />
                确认上传
              </button>
            </div>
          </div>
        </Modal>
      )}
      {historyOpen && file && (
        <Modal title="文档版本历史" onClose={() => setHistoryOpen(false)}>
          <div className="history-list">
            {file.versions?.length ? (
              [...file.versions].reverse().map(version => (
                <div key={version.id}>
                  <b>
                    V{version.number} · {version.status}
                  </b>
                  <span>
                    {new Date(version.createdAt).toLocaleString('zh-CN')} · {version.id}
                  </span>
                </div>
              ))
            ) : (
              <div>
                <b>{file.version}</b>
                <span>当前展示版本 · {file.updated}</span>
              </div>
            )}
          </div>
        </Modal>
      )}
      {moreOpen && file && (
        <Modal
          title={`文件操作：${file.name}`}
          onClose={() => {
            if (!fileActionBusy) setMoreOpen(false)
          }}
        >
          <div className="modal-form">
            <p>移动、重命名和删除会同步更新 PostgreSQL、系统默认文件目录与活动索引。</p>
            <label>
              文件名称
              <input
                value={fileNameDraft}
                onChange={event => {
                  setFileNameDraft(event.target.value)
                  setFileActionError('')
                }}
                placeholder="document.md"
              />
            </label>
            <div className="modal-actions">
              <button
                className="btn primary"
                disabled={fileActionBusy || !fileNameDraft.trim() || fileNameDraft === file.name}
                onClick={() => void renameFile()}
              >
                <Pencil />
                保存名称
              </button>
            </div>
            <div className="move-directory">
              <label>
                移动至
                <select
                  value={fileTargetDirectoryId}
                  onChange={event => {
                    setFileTargetDirectoryId(event.target.value)
                    setFileActionError('')
                  }}
                >
                  <option value={workspaceRootDirectoryId ?? ''}>/workspace</option>
                  {directories
                    .filter(directory => directory.persisted)
                    .map(directory => (
                      <option key={directory.id} value={directory.id}>
                        {getDirectoryBreadcrumb(directory.id)}
                      </option>
                    ))}
                </select>
              </label>
              <button
                className="btn primary"
                disabled={fileActionBusy || fileTargetDirectoryId === (file.parentId ?? workspaceRootDirectoryId ?? '')}
                onClick={() => void moveFile()}
              >
                <FolderOpen />
                移动文件
              </button>
            </div>
            {fileActionError && <small className="field-error">{fileActionError}</small>}
            <div className="modal-actions delete-modal-actions">
              <button className="btn ghost" disabled={fileActionBusy} onClick={() => setMoreOpen(false)}>
                取消
              </button>
              <button className="btn danger" disabled={fileActionBusy} onClick={() => void deleteFile()}>
                <Trash2 />
                删除文件
              </button>
            </div>
          </div>
        </Modal>
      )}
      {directoryEditor && (
        <Modal title={directoryEditor.mode === 'create' ? '新建目录' : '重命名目录'} onClose={closeEditor}>
          <div className="modal-form">
            <p>
              {directoryEditor.mode === 'create'
                ? `将在“${editorParentName}”中创建目录。`
                : '目录名称更新后，相关文档路径会同步更新。'}{' '}
              变更会保存到知识库数据库。
            </p>
            <label>
              目录名称
              <input
                value={directoryName}
                onChange={event => {
                  setDirectoryName(event.target.value)
                  setDirectoryNameError('')
                }}
                autoFocus
                placeholder="例如：接口规范"
              />
            </label>
            {directoryNameError && <small className="field-error">{directoryNameError}</small>}
            <div className="modal-actions">
              <button className="btn ghost" disabled={directorySaving} onClick={closeEditor}>
                取消
              </button>
              <button className="btn primary" disabled={directorySaving} onClick={() => void saveDirectory()}>
                {directorySaving ? '保存中' : directoryEditor.mode === 'create' ? '创建目录' : '保存名称'}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {deleteTarget && (
        <Modal title={`删除目录：${deleteTarget.name}`} onClose={closeDelete}>
          <div className="modal-form">
            <p>
              此目录包含 {deleteDirectoryIds.size - 1} 个子目录和 {deletedDocumentCount}{' '}
              份文档。操作完成后会同步保存到知识库数据库。
            </p>
            <div className="delete-summary">
              <span>
                <FolderOpen />
                目录树
              </span>
              <b>{deleteDirectoryIds.size} 个目录</b>
              <span>
                <FileText />
                文档
              </span>
              <b>{deletedDocumentCount} 份</b>
            </div>
            <div className="move-directory">
              <label>
                移动内容至
                <select value={moveTargetId} onChange={event => setMoveTargetId(event.target.value)}>
                  <option value={workspaceRootDirectoryId ?? ''}>/workspace</option>
                  {moveCandidates
                    .filter(directory => directory.persisted)
                    .map(directory => (
                      <option key={directory.id} value={directory.id}>
                        {getDirectoryBreadcrumb(directory.id)}
                      </option>
                    ))}
                </select>
              </label>
              <button className="btn primary" onClick={() => void moveContents()}>
                移动内容并删除目录
              </button>
            </div>
            <div className="modal-actions delete-modal-actions">
              <button className="btn ghost" onClick={closeDelete}>
                取消
              </button>
              <button className="btn danger" onClick={() => void deleteEverything()}>
                <Trash2 />
                全部删除
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  )
}

function makeSource(file: KnowledgeDocument) {
  return (
    file.content ??
    `# ${file.title}\n\n${file.intro}\n\n> 文档说明：当前为只读本地示例，不能保存或发布。\n\n${file.sections.map((section, index) => `## ${index + 1}. ${section}\n\n随着业务规模持续增长，本文档的示例内容覆盖主流程、异常处理和可追溯要求。\n\n${index === 0 ? '![统一支付与退款处理流程](assets/payment-flow.svg)' : ''}`).join('\n\n')}`
  )
}

function SourceView({ source }: { source: string }) {
  return (
    <div className="source-view">
      <div className="source-gutter">
        {source.split('\n').map((_, index) => (
          <span key={index}>{index + 1}</span>
        ))}
      </div>
      <pre>
        <code>{source}</code>
      </pre>
    </div>
  )
}

const DocumentContent = forwardRef<
  HTMLDivElement,
  {
    file: KnowledgeDocument
    source: string
    format: 'markdown' | 'text'
    outline: MarkdownOutline
    knowledgeBaseId: string
    activeSectionKey: string | null
    onOpenDocument: (logicalPath: string) => void
    onOpenImage: () => void
    compact?: boolean
  }
>(function DocumentContent(
  { file, source, format, outline, knowledgeBaseId, activeSectionKey, onOpenDocument, onOpenImage, compact = false },
  ref,
) {
  const className = compact ? 'split-markdown' : 'markdown-view'
  if (file.content) {
    return (
      <div ref={ref} className={className}>
        <div className="document-meta">
          <Badge tone="blue">{format === 'text' ? 'TXT' : 'Markdown'}</Badge>
          <span>版本 {file.version}</span>
          <span>更新于 {file.updated}</span>
          <Badge tone="green">已入活动索引</Badge>
        </div>
        <MarkdownDocument
          source={source}
          format={format}
          knowledgeBaseId={knowledgeBaseId}
          logicalPath={file.logicalPath}
          outline={outline}
          activeSectionKey={activeSectionKey}
          anchorPrefix={compact ? `split-${file.id}` : `preview-${file.id}`}
          onOpenKnowledgeDocument={onOpenDocument}
        />
        <div className="readonly-notice">
          固定资产版本：{file.assetVersionId} · 类型：{file.assetType}
        </div>
      </div>
    )
  }
  return (
    <div ref={ref} className={className}>
      <div className="document-meta">
        <Badge tone="blue">Markdown</Badge>
        <span>版本 {file.version}</span>
        <span>更新于 {file.updated}</span>
        <Badge tone="orange">只读</Badge>
      </div>
      <h1>{file.title}</h1>
      <p>{file.intro}</p>
      <div className="md-callout">
        <CircleHelp size={18} />
        <div>
          <b>只读原型说明</b>
          <span>编辑、保存、发布和历史恢复需要后端服务；当前只能查看本地示例。</span>
        </div>
      </div>
      {outline.sections.map((section, index) => (
        <section
          id={`preview-${file.id}-${section.key}`}
          data-document-section-key={section.key}
          className={
            activeSectionKey === section.key
              ? 'document-section-heading active-document-section'
              : 'document-section-heading'
          }
          key={section.key}
        >
          <h2>{section.title}</h2>
          <p>
            随着业务规模持续增长，原有流程在扩展性、异常恢复和统一治理方面逐渐暴露出不足。本地示例用于验证阅读、定位和视图切换交互。
          </p>
          {index === 0 && (
            <button className="md-image" onClick={onOpenImage} aria-label="打开统一支付与退款处理流程原图">
              <img src="/assets/payment-flow.svg" alt="统一支付与退款处理流程" />
              <span>
                <span>图 1：统一支付与退款处理流程</span>
                <em>点击查看原图</em>
              </span>
            </button>
          )}
          {index === 1 && (
            <ul>
              <li>统一核心流程及状态流转规则。</li>
              <li>完善异常、超时和重试场景。</li>
              <li>保留来源引用并支持版本追溯。</li>
            </ul>
          )}
        </section>
      ))}
    </div>
  )
})

function ImageLightbox({ onClose }: { onClose: () => void }) {
  const previousFocus = useRef<HTMLElement | null>(null)
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previousFocus.current?.focus()
    }
  }, [])
  return (
    <div
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="统一支付与退款处理流程原图"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <button aria-label="关闭原图" onClick={onClose} autoFocus>
        <XCircle />
      </button>
      <div onMouseDown={event => event.stopPropagation()}>
        <img src="/assets/payment-flow.svg" alt="统一支付与退款处理流程原图" />
        <p>统一支付与退款处理流程 · 本地示例资源</p>
      </div>
    </div>
  )
}
