import { describe, it, expect } from 'vitest'
import { translateCategory, spanishCountryName } from '../../../src/core/channel/translate'

describe('translateCategory', () => {
  it('translates known categories to Spanish', () => {
    expect(translateCategory('news')).toBe('Noticias')
    expect(translateCategory('sports')).toBe('Deportes')
    expect(translateCategory('kids')).toBe('Infantil')
    expect(translateCategory('movies')).toBe('Películas')
  })

  it('falls back to the capitalized id for unknown categories', () => {
    expect(translateCategory('weather')).toBe('Tiempo')
    expect(translateCategory('zzz')).toBe('Zzz')
  })
})

describe('spanishCountryName', () => {
  it('translates ISO codes to Spanish country names', () => {
    expect(spanishCountryName('US', 'United States')).toBe('Estados Unidos')
    expect(spanishCountryName('ES', 'Spain')).toBe('España')
  })

  it('falls back when the code is invalid', () => {
    expect(spanishCountryName('', 'Desconocido')).toBe('Desconocido')
  })
})
