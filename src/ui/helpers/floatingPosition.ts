export interface Point { x: number; y: number }
export interface Size { width: number; height: number }

// Márgenes con los que se puede asomar por cada borde. Dejar que salga un poco
// es cómodo; dejar que se pierda del todo hace imposible recuperarlo.
const EDGE = 16
const BOTTOM_EDGE = 32

/// Mantiene una ventana flotante dentro de la pantalla tras arrastrarla o tras
/// un cambio de tamaño o de zoom.
export function clampToViewport(position: Point, size: Size, viewport: Size): Point {
  const minX = -EDGE
  const maxX = Math.max(minX, viewport.width - size.width - EDGE)
  const minY = Math.min(EDGE, size.height + BOTTOM_EDGE - viewport.height)
  const maxY = Math.max(minY, viewport.height - size.height - BOTTOM_EDGE)
  return {
    x: Math.max(minX, Math.min(maxX, position.x)),
    y: Math.max(minY, Math.min(maxY, position.y)),
  }
}
