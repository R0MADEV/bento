function toRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

const toHex = (n: number): string => Math.round(n).toString(16).padStart(2, '0')

// Mezcla a→b según ratio (0 = a, 1 = b).
export function mix(a: string, b: string, ratio: number): string {
  const [ar, ag, ab] = toRgb(a)
  const [br, bg, bb] = toRgb(b)
  const m = (x: number, y: number) => x + (y - x) * ratio
  return `#${toHex(m(ar, br))}${toHex(m(ag, bg))}${toHex(m(ab, bb))}`
}

// Luminancia relativa simple para decidir claro/oscuro.
export function isDark(hex: string): boolean {
  const [r, g, b] = toRgb(hex)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5
}
