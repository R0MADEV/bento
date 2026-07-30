import esCatalog from './es.json'
import enCatalog from './en.json'

export type AppLocale = 'es' | 'en'
export type CatalogNamespace = 'app' | 'tasks'
export type TranslationValues = Record<string, string | number>
export type AppMessageKey = keyof typeof esCatalog.app
type PanelCatalog = typeof esCatalog.panels
type PanelMessageKey = {
  [Panel in keyof PanelCatalog]: `${Panel & string}.${keyof PanelCatalog[Panel] & string}`
}[keyof PanelCatalog]
export type UiMessageKey = `common.${keyof typeof esCatalog.common & string}` | PanelMessageKey

const LOCALE_KEY = 'bento.locale'
const catalogs = { es: esCatalog, en: enCatalog } as const

export function getAppLocale(): AppLocale {
  const storage = globalThis.localStorage
  const hasStorage = typeof storage?.getItem === 'function'
  const saved = hasStorage ? storage.getItem(LOCALE_KEY) ?? storage.getItem('bento.tasks.locale') : null
  if (saved === 'es' || saved === 'en') return saved
  if (!hasStorage) return 'es'
  const language = typeof globalThis.navigator?.language === 'string' ? globalThis.navigator.language : 'es'
  return language.toLowerCase().startsWith('en') ? 'en' : 'es'
}

export function setAppLocale(locale: AppLocale): void {
  const storage = globalThis.localStorage
  if (typeof storage?.setItem === 'function') storage.setItem(LOCALE_KEY, locale)
  if (typeof storage?.removeItem === 'function') storage.removeItem('bento.tasks.locale')
  if (typeof globalThis.window?.dispatchEvent === 'function') {
    globalThis.window.dispatchEvent(new CustomEvent('bento:locale-change', { detail: locale }))
  }
}

function interpolate(message: string, values: TranslationValues): string {
  let result = message
  for (const [name, value] of Object.entries(values)) result = result.split(`{${name}}`).join(String(value))
  return result
}

export function catalogT(namespace: CatalogNamespace, key: string, values: TranslationValues = {}): string {
  const messages = catalogs[getAppLocale()][namespace] as Record<string, string>
  return interpolate(messages[key] ?? key, values)
}

export function appT(key: AppMessageKey, values: TranslationValues = {}): string {
  return catalogT('app', key, values)
}

export function t(key: UiMessageKey, values: TranslationValues = {}): string {
  const [namespace, messageKey] = key.split('.', 2)
  const catalog = catalogs[getAppLocale()] as unknown as {
    common: Record<string, string>
    panels: Record<string, Record<string, string>>
  }
  const section = namespace === 'common' ? catalog.common : catalog.panels?.[namespace]
  return interpolate(section?.[messageKey] ?? key, values)
}
