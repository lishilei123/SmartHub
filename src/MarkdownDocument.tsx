import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ComponentPropsWithoutRef } from 'react'
import { emptyMarkdownOutline, type MarkdownOutline } from './markdown-outline'

export type DocumentFormat = 'markdown' | 'text'

export function resolveKnowledgeDocumentLink(logicalPath: string, href: string) {
  if (!href || /^(?:[a-z]+:|\/\/|#|\/)/i.test(href)) return null
  let decoded = href.split(/[?#]/, 1)[0]
  try { decoded = decodeURIComponent(decoded) } catch { return null }
  if (!/\.(?:md|txt)$/i.test(decoded)) return null
  const parts = [...logicalPath.replaceAll('\\', '/').split('/').slice(0, -1), ...decoded.replaceAll('\\', '/').split('/')]
  const normalized: string[] = []
  for (const part of parts) { if (!part || part === '.') continue; if (part === '..') { if (!normalized.length) return null; normalized.pop() } else normalized.push(part) }
  return normalized.join('/') || null
}

export function resolveKnowledgeImage(kbId: string, logicalPath: string, source: string) {
  if (!kbId || !source || /^(?:[a-z]+:|\/\/|#)/i.test(source)) return null
  const baseParts = logicalPath.replaceAll('\\', '/').split('/').slice(0, -1)
  const parts = [...baseParts, ...source.split(/[?#]/, 1)[0].replaceAll('\\', '/').split('/')]
  const normalized: string[] = []
  for (const part of parts) { if (!part || part === '.') continue; if (part === '..') { if (!normalized.length) return null; normalized.pop() } else normalized.push(part) }
  if (!normalized.length) return null
  return `http://127.0.0.1:8787/api/knowledge-bases/${encodeURIComponent(kbId)}/files/${normalized.map(encodeURIComponent).join('/')}`
}

export function MarkdownDocument({ source, format, knowledgeBaseId = '', logicalPath = '', outline = emptyMarkdownOutline, activeSectionKey, anchorPrefix = 'document-section', onOpenKnowledgeDocument }: { source: string; format: DocumentFormat; knowledgeBaseId?: string; logicalPath?: string; outline?: MarkdownOutline; activeSectionKey?: string | null; anchorPrefix?: string; onOpenKnowledgeDocument?: (logicalPath: string) => void }) {
  if (format === 'text') return <pre className="plain-text-document">{source}</pre>

  const sectionsByOffset = new Map(outline.sections.map(section => [section.sourceOffset, section]))
  const heading = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') => ({ children, className, node, ...props }: ComponentPropsWithoutRef<'h2'> & { node?: { position?: { start?: { offset?: number } } } }) => {
    const section = sectionsByOffset.get(node?.position?.start?.offset ?? -1)
    const classes = [className, section ? 'document-section-heading' : '', section && section.key === activeSectionKey ? 'active-document-section' : ''].filter(Boolean).join(' ')
    return <Tag {...props} {...(section ? { id: `${anchorPrefix}-${section.key}`, 'data-document-section-key': section.key } : {})} className={classes || undefined}>{children}</Tag>
  }
  return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    h1: heading('h1'), h2: heading('h2'), h3: heading('h3'), h4: heading('h4'), h5: heading('h5'), h6: heading('h6'),
    table({ className, children, ...props }) {
      return <div className="md-table-wrap"><table {...props} className={['md-table', className].filter(Boolean).join(' ')}>{children}</table></div>
    },
    a({ href, children, node, ...props }) {
      void node
      const target = resolveKnowledgeDocumentLink(logicalPath, href ?? '')
      if (target) return <a {...props} href={href} onClick={event => { event.preventDefault(); onOpenKnowledgeDocument?.(target) }}>{children}</a>
      return <a {...props} href={href} target="_blank" rel="noreferrer noopener">{children}</a>
    },
    img({ alt, src }) {
      const resolved = resolveKnowledgeImage(knowledgeBaseId, logicalPath, src ?? '')
      return resolved ? <img className="md-knowledge-image" src={resolved} alt={alt ?? ''} loading="lazy" /> : <span className="md-image-placeholder" role="img" aria-label={alt || '文档图片'}>{alt || '文档图片'}</span>
    },
  }}>{source}</ReactMarkdown>
}
