const CATEGORY_ES: Record<string, string> = {
  auto: 'Motor',
  animation: 'Animación',
  business: 'Negocios',
  classic: 'Clásicos',
  comedy: 'Comedia',
  cooking: 'Cocina',
  culture: 'Cultura',
  documentary: 'Documentales',
  education: 'Educación',
  entertainment: 'Entretenimiento',
  family: 'Familiar',
  general: 'General',
  kids: 'Infantil',
  legislative: 'Legislativo',
  lifestyle: 'Estilo de vida',
  movies: 'Películas',
  music: 'Música',
  news: 'Noticias',
  outdoor: 'Aire libre',
  relax: 'Relax',
  religious: 'Religioso',
  science: 'Ciencia',
  series: 'Series',
  shop: 'Compras',
  sports: 'Deportes',
  travel: 'Viajes',
  weather: 'Tiempo',
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

export function translateCategory(id: string): string {
  return CATEGORY_ES[id] ?? capitalize(id)
}

let regionNames: Intl.DisplayNames | undefined
try {
  regionNames = new Intl.DisplayNames(['es'], { type: 'region' })
} catch {
  regionNames = undefined
}

export function spanishCountryName(code: string, fallback: string): string {
  if (!code) return fallback
  try {
    return regionNames?.of(code) ?? fallback
  } catch {
    return fallback
  }
}
