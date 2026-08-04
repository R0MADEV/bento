import esCatalog from '../../i18n/es.json'
import { catalogT, type TranslationValues } from '../../core/i18n'

export type DiffMessageKey = keyof typeof esCatalog.diff

export function diffT(key: DiffMessageKey, values: TranslationValues = {}): string {
  return catalogT('diff', key, values)
}
