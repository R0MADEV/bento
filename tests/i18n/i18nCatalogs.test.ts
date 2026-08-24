import { describe, expect, it } from 'vitest'
import es from '../../src/i18n/es.json'
import en from '../../src/i18n/en.json'

const placeholders = (message: string): string[] =>
  [...message.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort()

describe('i18n catalogs', () => {
  it.each(['es', 'en'] as const)('%s contains no legacy dynamic translation sections', locale => {
    const catalog = locale === 'es' ? es : en
    expect(catalog).not.toHaveProperty('dynamic')
    expect(catalog).not.toHaveProperty('legacy')
    expect(catalog.panels).not.toHaveProperty('dynamic')
  })

  it.each(['app', 'tasks', 'common'] as const)('%s has the same keys in every locale', namespace => {
    expect(Object.keys(en[namespace]).sort()).toEqual(Object.keys(es[namespace]).sort())
  })

  it('has the same panel namespaces and keys in every locale', () => {
    expect(Object.keys(en.panels).sort()).toEqual(Object.keys(es.panels).sort())
    for (const panel of Object.keys(es.panels) as Array<keyof typeof es.panels>) {
      expect(Object.keys(en.panels[panel]).sort()).toEqual(Object.keys(es.panels[panel]).sort())
    }
  })

  it.each(['app', 'tasks', 'common'] as const)('%s preserves interpolation placeholders', namespace => {
    for (const key of Object.keys(es[namespace]) as Array<keyof typeof es[typeof namespace]>) {
      expect(placeholders(en[namespace][key])).toEqual(placeholders(es[namespace][key]))
    }
  })

  it('preserves interpolation placeholders in every panel', () => {
    for (const panel of Object.keys(es.panels) as Array<keyof typeof es.panels>) {
      for (const key of Object.keys(es.panels[panel]) as Array<keyof typeof es.panels[typeof panel]>) {
        expect(placeholders(en.panels[panel][key])).toEqual(placeholders(es.panels[panel][key]))
      }
    }
  })
})
