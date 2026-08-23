import { t as i18nT } from '../../i18n'
import { uniqMemoryValues } from './normalize'
import type { MemoryEntry, MemoryKind } from './MemoryEntry'

export const KIND_LABEL: Record<MemoryKind, string> = {
  decision: i18nT('memory.decision'),
  fact: i18nT('memory.fact'),
  task: i18nT('memory.task'),
  note: i18nT('common.note'),
}

export const KIND_OPTIONS: Array<MemoryKind | 'all'> = ['all', 'decision', 'fact', 'task', 'note']

export const splitList = (value: string): string[] => uniqMemoryValues(value.split(','))

export const basename = (value: string): string => value.split(/[\\/]/).filter(Boolean).pop() ?? ''

export const projectName = (value: string): string => basename(value) || value

/** The project an imported memory says it was indexed from, if it names one. */
export const detailProject = (value: string): string | null => {
  const match = value.match(/^Proyecto indexado:\s+(.+)$/m)
  return match?.[1]?.trim() ?? null
}

/** The project folder inside a `.lexis/projects/<folder>/…` path. */
export const lexisProjectFolder = (value: string): string | null => {
  const normalized = value.replace(/\\/g, '/')
  const marker = '/.lexis/projects/'
  const start = normalized.indexOf(marker)
  if (start < 0) return null
  const rest = normalized.slice(start + marker.length)
  const folder = rest.split('/')[0]?.trim()
  return folder || null
}

export const timeLabel = (iso: string): string => {
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

export const sourceLabel = (value: string): string => value || i18nT('memory.manual')

/** Only session summaries can be asked for again; the rest are imported as-is. */
export const canRegenerateSummary = (entry?: MemoryEntry): boolean =>
  Boolean(entry?.externalId && entry.externalId.includes(':session-summary:'))
