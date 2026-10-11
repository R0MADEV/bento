import { getUiZoom } from '../../ui/helpers/zoom'

// Where a pointer at `client` really is, in layout pixels, inside an element
// whose edge is at `origin`, once the UI zoom is undone.
export const unzoomedCoordinate = (client: number, origin: number, zoom: number): number =>
  origin + (client - origin) / zoom

// The events xterm maps to a cell: selection, links and mouse reporting.
const POINTER_EVENTS = ['mousedown', 'mousemove', 'mouseup', 'wheel'] as const

// The UI zoom is a CSS transform, and xterm doesn't account for transforms: it
// divides the pointer's (scaled) distance by the cell's (unscaled) size, so at
// 110% it picks a cell 10% further from the corner than the one under the
// pointer. Rewrites the coordinates of the terminal's pointer events before
// xterm reads them. Returns the function that stops doing it.
export function correctPointerForZoom(root: HTMLElement): () => void {
  let dragging = false

  const correct = (event: MouseEvent) => {
    const zoom = getUiZoom()
    const screen = root.querySelector('.xterm-screen')
    if (zoom === 1 || !screen) return
    const corner = screen.getBoundingClientRect()
    Object.defineProperty(event, 'clientX', { value: unzoomedCoordinate(event.clientX, corner.left, zoom) })
    Object.defineProperty(event, 'clientY', { value: unzoomedCoordinate(event.clientY, corner.top, zoom) })
  }

  // On the document, capturing: it must run before xterm's own listeners, and a
  // selection keeps being dragged (and is released) outside the terminal.
  const onPointer = (event: MouseEvent) => {
    const isInside = event.target instanceof Node && root.contains(event.target)
    if (event.type === 'mousedown') dragging = isInside
    const concernsTerminal = dragging || isInside
    if (concernsTerminal) correct(event)
    if (event.type === 'mouseup') dragging = false
  }

  POINTER_EVENTS.forEach(type => document.addEventListener(type, onPointer, true))
  return () => POINTER_EVENTS.forEach(type => document.removeEventListener(type, onPointer, true))
}
