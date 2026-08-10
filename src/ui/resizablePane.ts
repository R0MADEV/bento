import { appT } from '../core/i18n'

export interface ResizablePaneOptions {
  target: HTMLElement
  container: HTMLElement
  initialWidth?: number | null
  minWidth?: number
  minRemaining?: number
  onWidthChange?: (width: number) => void
}

export interface ResizablePaneHandle {
  element: HTMLElement
}

export function createHorizontalResizablePane(options: ResizablePaneOptions): ResizablePaneHandle {
  const { target, container, initialWidth, onWidthChange } = options
  const minWidth = options.minWidth ?? 180
  const minRemaining = options.minRemaining ?? 280
  if (initialWidth) target.style.width = `${initialWidth}px`

  const element = document.createElement('div')
  element.className = 'resizable-pane-handle'
  element.title = appT('resize')

  element.addEventListener('pointerdown', e => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const startWidth = target.getBoundingClientRect().width
    element.setPointerCapture(e.pointerId)
    element.classList.add('dragging')

    const resize = (event: PointerEvent): void => {
      if (!element.hasPointerCapture(event.pointerId)) return
      const containerWidth = container.getBoundingClientRect().width
      const maxWidth = Math.max(minWidth, containerWidth - minRemaining)
      const nextWidth = Math.min(maxWidth, Math.max(minWidth, startWidth + event.clientX - startX))
      target.style.width = `${nextWidth}px`
    }

    const stop = (event: PointerEvent): void => {
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId)
      element.classList.remove('dragging')
      onWidthChange?.(target.getBoundingClientRect().width)
      element.removeEventListener('pointermove', resize)
      element.removeEventListener('pointerup', stop)
      element.removeEventListener('pointercancel', stop)
    }

    element.addEventListener('pointermove', resize)
    element.addEventListener('pointerup', stop)
    element.addEventListener('pointercancel', stop)
  })

  return { element }
}
