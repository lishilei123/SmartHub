import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { TechnicalEvidence } from './technical-solution-review-api'

export type TechnicalDocument = {
  assetVersionId: string
  title: string
  content: string
  evidence?: TechnicalEvidence
}

export function TechnicalDocumentViewer({ document, onClose }: { document: TechnicalDocument; onClose: () => void }) {
  const scrollerRef = useRef<HTMLPreElement>(null)
  const firstHitRef = useRef<HTMLSpanElement>(null)
  const lines = document.content.split(/\r?\n/u)

  useEffect(() => {
    if (document.evidence && firstHitRef.current) {
      firstHitRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' })
      return
    }
    scrollerRef.current?.scrollTo({ top: 0 })
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
      <span><b>{document.title}</b><small>{document.assetVersionId}{document.evidence ? ` · L${document.evidence.startLine}-${document.evidence.endLine}` : ' · 从文档顶部打开'}</small></span>
      <button type="button" onClick={onClose} aria-label="关闭固定原文" title="关闭（Esc）"><X /></button>
    </header>
    <pre ref={scrollerRef} tabIndex={0}>{lines.map((line, index) => {
      const lineNumber = index + 1
      const isHit = Boolean(document.evidence && lineNumber >= document.evidence.startLine && lineNumber <= document.evidence.endLine)
      return <span key={lineNumber} ref={document.evidence?.startLine === lineNumber ? firstHitRef : undefined} className={isHit ? 'hit' : undefined} data-source-line={lineNumber}>
        <i aria-hidden="true">{lineNumber}</i><code>{line || ' '}</code>
      </span>
    })}</pre>
  </section>
}
