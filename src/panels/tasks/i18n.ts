import esCatalog from '../../i18n/es.json'
import {
  catalogT,
  getAppLocale,
  setAppLocale,
  type AppLocale,
  type TranslationValues,
} from '../../core/i18n'

export type TaskLocale = AppLocale
export type TaskMessageKey = keyof typeof esCatalog.tasks

export function getTaskLocale(): TaskLocale {
  return getAppLocale()
}

export function setTaskLocale(locale: TaskLocale): void {
  setAppLocale(locale)
}

export function taskT(key: TaskMessageKey, values: TranslationValues = {}): string {
  return catalogT('tasks', key, values)
}
