export interface NormalizedGroup {
  category: string
  country: string
}

const REGIONS = new Set([
  'Andalucía', 'Cataluña', 'C. Valenciana', 'País Vasco', 'Canarias', 'Galicia',
  'Castilla-La Mancha', 'C. de Madrid', 'Castilla y León', 'R. de Murcia', 'La Rioja',
  'Cantabria', 'C. Foral de Navarra', 'Illes Balears', 'Extremadura', 'Aragón',
  'P. de Asturias', 'Melilla',
])

const TYPES: Record<string, string> = {
  Deportivos: 'Deportes',
  'Deportivos Int.': 'Deportes',
  Musicales: 'Música',
  Infantiles: 'Infantil',
  Religiosos: 'Religión',
  Eventuales: 'Eventos',
}

// Converts the M3U group into a clean category + country (ES except for international ones).
export function normalizeGroup(group: string): NormalizedGroup {
  if (REGIONS.has(group)) return { category: 'Autonómicas', country: 'ES' }
  if (group.startsWith('Int. ')) return { category: 'Internacional', country: '' }
  return { category: TYPES[group] ?? group, country: 'ES' }
}
