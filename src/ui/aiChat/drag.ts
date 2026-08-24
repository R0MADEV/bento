import { clampToViewport } from '../helpers/floatingPosition'
import { getUiZoom, toLayoutPixels } from '../helpers/zoom'

// Arrastrar la ventana flotante del chat y mantenerla dentro de la pantalla.
// El estado de la posición vive aquí; el chat solo dice dónde empezó y cuándo
// guardarla.

export interface DragDeps {
  root: HTMLElement
  modal: HTMLElement
  toggle: HTMLElement
  header: HTMLElement
  storageKey: string
}

export function buildAiChatDrag(deps: DragDeps, initial: { x: number; y: number }): {
  clampPosition: () => void
  savePosition: () => void
  position: () => { x: number; y: number }
  moveTo: (position: { x: number; y: number }) => void
} {
  const { root, modal, toggle, header } = deps
  let dragX = initial.x
  let dragY = initial.y
  const clampPosition = (): void => {
    const zoom = getUiZoom()
    const collapsed = modal.classList.contains('hidden')
    const clamped = clampToViewport(
      { x: dragX, y: dragY },
      {
        width: (collapsed ? toggle.offsetWidth : modal.offsetWidth) || (collapsed ? 44 : 460),
        height: (collapsed ? toggle.offsetHeight : modal.offsetHeight) || (collapsed ? 44 : 320),
      },
      { width: window.innerWidth / zoom, height: window.innerHeight / zoom },
    )
    dragX = clamped.x
    dragY = clamped.y
    root.style.setProperty('--ai-drag-x', `${dragX}px`)
    root.style.setProperty('--ai-drag-y', `${dragY}px`)
  }
  window.addEventListener('resize', clampPosition)
  window.addEventListener('bento:zoom-change', clampPosition)

  const savePosition = (): void => {
    localStorage.setItem(deps.storageKey, JSON.stringify({ x: dragX, y: dragY }))
  }
  const draggable = (handle: HTMLElement): void => {
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return
      if (handle === header && (e.target as Element).closest('button, input, select, textarea')) return
      const startX = e.clientX
      const startY = e.clientY
      const initialX = dragX
      const initialY = dragY
      let moved = false
      const onMove = (event: PointerEvent): void => {
        const zoom = getUiZoom()
        const dx = toLayoutPixels(event.clientX - startX, zoom)
        const dy = toLayoutPixels(event.clientY - startY, zoom)
        moved = moved || Math.abs(dx) > 3 || Math.abs(dy) > 3
        if (!moved) return
        dragX = initialX + dx
        dragY = initialY + dy
        clampPosition()
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        if (moved) savePosition()
        root.dataset.dragged = moved ? 'true' : 'false'
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp, { once: true })
    })
  }
  draggable(toggle)


  draggable(toggle)
  draggable(header)

  const position = () => ({ x: dragX, y: dragY })
  const moveTo = (next: { x: number; y: number }): void => {
    dragX = next.x
    dragY = next.y
    root.style.setProperty('--ai-drag-x', `${dragX}px`)
    root.style.setProperty('--ai-drag-y', `${dragY}px`)
  }

  return { clampPosition, savePosition, position, moveTo }
}
