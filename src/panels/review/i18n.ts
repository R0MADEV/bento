import esCatalog from '../../i18n/es.json'
import { catalogT, type TranslationValues } from '../../core/i18n'

export type ReviewMessageKey = keyof typeof esCatalog.review

export function reviewT(key: ReviewMessageKey, values: TranslationValues = {}): string {
  return catalogT('review', key, values)
}
