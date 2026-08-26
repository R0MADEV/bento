export function getUiZoom(): number {
  const raw = document.documentElement.style.getPropertyValue('--bento-zoom') || '1'
  const zoom = Number.parseFloat(raw)
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1
}

export function toLayoutPixels(value: number, zoom = getUiZoom()): number {
  return value / zoom
}
