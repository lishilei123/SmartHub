import { useEffect, useRef } from 'react'
import { ShieldCheck, X } from 'lucide-react'
import { MarkdownDocument } from './MarkdownDocument'
import type { TechnicalEvidence } from './technical-solution-review-api'

export type TechnicalDocument = {
  assetVersionId: string
  title: string
  content: string
  logicalPath?: string
  evidence?: TechnicalEvidence
}

export function TechnicalDocumentViewer({ document, knowledgeBaseId = '', onClose }: { document: TechnicalDocument; knowledgeBaseId?: string; onClose: () => void }) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const format = document.title.toLowerCase().endsWith('.txt') ? 'text' : 'markdown'

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const firstHit = scroller.querySelector<HTMLElement>('.technical-evidence-hit')
    if (document.evidence && firstHit) {
      const top = firstHit.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight * .25), behavior: 'smooth' })
      return
    }
    scroller.scrollTo({ top: 0 })
  }, [document])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return <section className="fixed-document" aria-label={`固定原文：${document.title}`}>
    <header>
      <span><b>{document.title}</b><small>{document.assetVersionId}{document.evidence ? ` · Evidence L${document.evidence.startLine}-${document.evidence.endLine}` : ` · ${format === 'text' ? '纯文本' : 'Markdown'} 渲染视图`}</small></span>
      <button type="button" onClick={onClose} aria-label="关闭固定原文" title="关闭（Esc）"><X /></button>
    </header>
    {document.evidence && <div className="fixed-document-evidence"><ShieldCheck /><span><b>已定位固定 Evidence</b><small>{document.evidence.headingPath.join(' / ') || `L${document.evidence.startLine}-${document.evidence.endLine}`} · {document.evidence.quote}</small></span></div>}
    <div className="fixed-document-body rr-markdown" ref={scrollerRef} tabIndex={0}><MarkdownDocument source={document.content} format={format} knowledgeBaseId={knowledgeBaseId} logicalPath={document.logicalPath ?? document.title} highlightSourceRange={document.evidence ? { startLine: document.evidence.startLine, endLine: document.evidence.endLine } : undefined} anchorPrefix={`technical-${document.assetVersionId}`} /></div>
  </section>
}
