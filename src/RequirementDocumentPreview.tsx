import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, LoaderCircle, Trash2, XCircle } from 'lucide-react'
import { getActiveDocumentSectionKey } from './document-scroll'
import { MarkdownDocument } from './MarkdownDocument'
import { emptyMarkdownOutline, parseMarkdownOutline } from './markdown-outline'
import type { KnowledgeDocument } from './prototype-data'

export type RequirementDocumentPreviewState = {
  document: KnowledgeDocument
  content: string
  loading: boolean
}

type Props = {
  preview: RequirementDocumentPreviewState
  knowledgeBaseId: string
  deleting?: boolean
  canDelete?: boolean
  onClose: () => void
  onDelete: (document: KnowledgeDocument) => void
  onOpenKnowledgeDocument?: (logicalPath: string) => void
}

export function RequirementDocumentPreview({ preview, knowledgeBaseId, deleting = false, canDelete = false, onClose, onDelete, onOpenKnowledgeDocument }: Props) {
  const documentRef = useRef<HTMLDivElement>(null)
  const [activeSectionKey, setActiveSectionKey] = useState<string | null>(null)
  const isText = preview.document.name.toLowerCase().endsWith('.txt')
  const outline = useMemo(
    () => !preview.loading && !isText && preview.content ? parseMarkdownOutline(preview.content) : emptyMarkdownOutline,
    [isText, preview.content, preview.loading],
  )

  useEffect(() => {
    setActiveSectionKey(outline.sections[0]?.key ?? null)
    documentRef.current?.scrollTo({ top: 0 })
  }, [preview.document.id, preview.document.assetVersionId, outline.sections.length])

  const updateActiveSection = () => {
    const container = documentRef.current
    if (!container || isText) return
    const sections = Array.from(container.querySelectorAll<HTMLElement>('[data-document-section-key]'))
      .map(node => ({ key: node.dataset.documentSectionKey ?? '', top: node.offsetTop }))
      .filter(item => item.key)
    setActiveSectionKey(getActiveDocumentSectionKey(sections, container.scrollTop + 56))
  }

  const jumpToSection = (key: string) => {
    const container = documentRef.current
    const heading = container?.querySelector<HTMLElement>(`[data-document-section-key="${key}"]`)
    if (!container || !heading) return
    container.scrollTo({ top: Math.max(0, heading.offsetTop - 18), behavior: 'smooth' })
    setActiveSectionKey(key)
  }

  return <div className="requirement-input-backdrop preview" onMouseDown={event => { if (event.currentTarget === event.target) onClose() }}>
    <section className="requirement-input-preview">
      <header>
        <div><FileText /><span><b>{preview.document.title || preview.document.name}</b><small>{preview.document.version} · {preview.document.logicalPath}</small></span></div>
        <button onClick={onClose}><XCircle /></button>
      </header>

      <div className="requirement-input-preview-body">
        <aside className="requirement-input-preview-outline">
          <header><FileText /><b>文档目录</b></header>
          {preview.loading
            ? <div className="requirement-input-outline-empty"><LoaderCircle className="rotating" /><span>正在解析目录</span></div>
            : isText
              ? <div className="requirement-input-outline-empty"><span>TXT 纯文本无章节目录</span></div>
              : outline.sections.length
                ? <nav>{outline.sections.map(section => <button
                    key={section.key}
                    className={activeSectionKey === section.key ? 'active' : ''}
                    style={{ paddingLeft: `${12 + Math.max(0, section.depth - 2) * 12}px` }}
                    onClick={() => jumpToSection(section.key)}
                    title={section.title}
                  ><span>{section.title}</span></button>)}</nav>
                : <div className="requirement-input-outline-empty"><span>未检测到 Markdown 章节标题</span></div>}
        </aside>

        <div className="requirement-input-preview-document" ref={documentRef} onScroll={updateActiveSection}>
          {preview.loading
            ? <div className="requirement-input-empty"><LoaderCircle className="rotating" /><b>正在读取固定版本</b></div>
            : <MarkdownDocument
                source={preview.content}
                format={isText ? 'text' : 'markdown'}
                knowledgeBaseId={knowledgeBaseId}
                logicalPath={preview.document.logicalPath ?? ''}
                outline={outline}
                activeSectionKey={activeSectionKey}
                anchorPrefix="requirement-preview-section"
                onOpenKnowledgeDocument={onOpenKnowledgeDocument}
              />}
        </div>
      </div>

      <footer>
        <span>AssetVersion：{preview.document.assetVersionId ?? '-'}</span>
        {canDelete && <button className="btn danger" disabled={deleting} onClick={() => onDelete(preview.document)}><Trash2 />删除文档</button>}
      </footer>
    </section>
  </div>
}
