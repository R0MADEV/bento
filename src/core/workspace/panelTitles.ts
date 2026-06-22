// Extracts panel titles from a serialized Dockview layout, so we can preview
// what a session has open without instantiating it.

interface SerializedLayout {
  panels?: Record<string, { title?: string; id?: string }>
}

export function panelTitlesFromLayout(layout: unknown): string[] {
  if (!layout || typeof layout !== 'object') return []
  const panels = (layout as SerializedLayout).panels
  if (!panels || typeof panels !== 'object') return []
  return Object.values(panels)
    .map(p => p.title ?? p.id ?? '')
    .filter(Boolean)
}
