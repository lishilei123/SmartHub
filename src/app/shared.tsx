import { useEffect, useRef, type ReactNode } from 'react'
import { RefreshCw, XCircle } from 'lucide-react'

export function Badge({ children, tone = 'gray' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>
}

export function Progress({ value, tone = 'blue' }: { value: number; tone?: string }) {
  return (
    <div className="progress" aria-label={`进度 ${value}%`}>
      <span className={tone} style={{ width: `${value}%` }} />
    </div>
  )
}

export function Modal({
  title,
  onClose,
  children,
  className = '',
}: {
  title: string
  onClose: () => void
  children: ReactNode
  className?: string
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.focus()
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
      className={`modal-backdrop ${className}`}
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        ref={dialogRef}
        tabIndex={-1}
      >
        <header>
          <h2 id="modal-title">{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={`关闭${title}`}>
            <XCircle />
          </button>
        </header>
        {children}
      </div>
    </div>
  )
}

export function PageLoading({ label }: { label: string }) {
  return (
    <section className="card page-loading" role="status">
      <RefreshCw />
      <span>{label}</span>
    </section>
  )
}
