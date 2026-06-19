// Devuelve el índice de la pista de subtítulos en el idioma preferido, o -1.
export function pickSubtitleTrack(languages: string[], preferred: string): number {
  const p = preferred.toLowerCase()
  const iso2to3: Record<string, string> = { es: 'spa', en: 'eng', fr: 'fra', de: 'deu', pt: 'por' }

  return languages.findIndex(lang => {
    const l = lang.toLowerCase()
    return l.startsWith(p) || l.startsWith(iso2to3[p] ?? p)
  })
}
