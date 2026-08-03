import { useEffect, useMemo, useRef, useState } from 'react'
import { PanelLeftClose, PanelLeftOpen, Quote, ShieldCheck, X } from 'lucide-react'
import { MarkdownDocument } from './MarkdownDocument'
import { emptyMarkdownOutline, parseMarkdownOutline } from './markdown-outline'
import type { TechnicalEvidence } from './technical-solution-review-api'

export type TechnicalDocument = {
  assetVersionId: string
  title: string
  content: string
  logicalPath?: string
  evidence?: TechnicalEvidence
}

export function TechnicalDocumentViewer({ document, knowledgeBaseId = '', onClose }: { document: TechnicalDocument; knowledgeBaseId?: string; onClose: () => void }) {
  const sourceRef = useRef<HTMLDivElement>(null)
  const outlineRef = useRef<HTMLElement>(null)
  const pendingSectionScroll = useRef<string | null>(null)
  const [outlineCollapsed, setOutlineCollapsed] = useState(false)
  const [activeSectionKey, setActiveSectionKey] = useState<string | null>(null)
  const format = document.title.toLowerCase().endsWith('.txt') ? 'text' : 'markdown'
  const outline = useMemo(() => format === 'markdown' && document.content ? parseMarkdownOutline(document.content) : emptyMarkdownOutline, [document.content, format])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  useEffect(() => {
    setOutlineCollapsed(false)
    setActiveSectionKey(null)
    pendingSectionScroll.current = null
  }, [document.assetVersionId])

  useEffect(() => {
    const scroller = sourceRef.current
    if (!scroller) return
    const firstHit = scroller.querySelector<HTMLElement>('.technical-evidence-hit')
    if (document.evidence && firstHit) {
      const top = firstHit.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight * .25), behavior: 'smooth' })
      return
    }
    scroller.scrollTo({ top: 0 })
  }, [document])

  const scrollToSection = (key: string) => {
    const scroller = sourceRef.current
    const target = scroller?.querySelector<HTMLElement>(`[data-document-section-key="${key}"]`)
    if (!scroller || !target) return
    const scrollerTop = scroller.getBoundingClientRect().top
    const targetTop = target.getBoundingClientRect().top
    scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + targetTop - scrollerTop - 16), behavior: 'smooth' })
  }

  const activateSection = (key: string) => {
    pendingSectionScroll.current = key
    setActiveSectionKey(key)
    requestAnimationFrame(() => {
      if (pendingSectionScroll.current !== key) return
      pendingSectionScroll.current = null
      scrollToSection(key)
    })
  }

  useEffect(() => {
    const scroller = sourceRef.current
    if (!scroller || format !== 'markdown') return
    const updateActiveSection = () => {
      const headings = Array.from(scroller.querySelectorAll<HTMLElement>('[data-document-section-key]'))
      if (!headings.length) { setActiveSectionKey(null); return }
      const scrollerTop = scroller.getBoundingClientRect().top + 24
      const current = headings.reduce((active, heading) => heading.getBoundingClientRect().top <= scrollerTop ? heading : active, headings[0])
      const key = current.dataset.documentSectionKey
      if (!key) return
      setActiveSectionKey(active => active === key ? active : key)
      outlineRef.current?.querySelector<HTMLElement>(`[data-outline-section-key="${key}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    const pendingKey = pendingSectionScroll.current
    if (pendingKey) {
      pendingSectionScroll.current = null
      scrollToSection(pendingKey)
    }
    updateActiveSection()
    scroller.addEventListener('scroll', updateActiveSection, { passive: true })
    return () => scroller.removeEventListener('scroll', updateActiveSection)
  }, [document.content, format, outline.sections])

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><div className="modal rr-source-modal" role="dialog" aria-modal="true" aria-label="固定原文定位">
    <header><h2>固定原文定位</h2><button className="icon-btn" onClick={onClose} aria-label="关闭固定原文定位"><X /></button></header>
    <div className={`rr-source-layout ${outlineCollapsed ? 'outline-collapsed' : ''}`}>
      <nav className="rr-outline" ref={outlineRef} aria-label="本文目录">
        <header><b>本文目录</b>{!outlineCollapsed && <span className="rr-badge blue">{outline.sections.length}</span>}<button className="rr-outline-toggle" onClick={() => setOutlineCollapsed(value => !value)} aria-label={outlineCollapsed ? '展开文档目录' : '收起文档目录'} title={outlineCollapsed ? '展开目录' : '收起目录'}>{outlineCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button></header>
        {!outlineCollapsed && outline.sections.map(section => <button className={activeSectionKey === section.key ? 'active' : ''} data-outline-section-key={section.key} style={{ paddingLeft: `${12 + Math.max(0, section.depth - 2) * 10}px` }} onClick={() => activateSection(section.key)} key={section.key}><span>{section.title}</span></button>)}
      </nav>
      <article className="rr-source-document">
        <header><div><span className="rr-badge blue">{format === 'text' ? 'TXT' : 'Markdown'}</span><b>{document.title}</b><span>{document.assetVersionId}</span></div><span><ShieldCheck />只读固定版本</span></header>
        {document.evidence && <div className="rr-evidence-banner"><ShieldCheck /><span><b>已定位固定 Evidence · {document.evidence.headingPath.join(' / ') || `L${document.evidence.startLine}-${document.evidence.endLine}`}</b><small>{document.evidence.quote}</small></span><span className="rr-badge green">L{document.evidence.startLine}-{document.evidence.endLine}</span></div>}
        <div className="rr-markdown" ref={sourceRef} tabIndex={0}><MarkdownDocument source={document.content} format={format} knowledgeBaseId={knowledgeBaseId} logicalPath={document.logicalPath ?? document.title} outline={outline} activeSectionKey={activeSectionKey} highlightSourceRange={document.evidence ? { startLine: document.evidence.startLine, endLine: document.evidence.endLine } : undefined} anchorPrefix={`technical-${document.assetVersionId}`} /></div>
        <footer><Quote />仅展示技术方案固定版本原文；不会修改或覆盖评审输入。</footer>
      </article>
    </div>
  </div></div>
}
