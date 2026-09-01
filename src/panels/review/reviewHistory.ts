import { reviewT } from './i18n'

/// One entry of the shared checkpoint store, as the Rust side serializes it.
export interface CheckpointMeta {
  base: string
  saved_at: string
  branch?: string | null
  run_id?: string | null
  /** Whether it can still be asked a follow-up: the verifier's session. */
  resumable: boolean
  /** Whether the branch moved on since the review was made. */
  stale?: boolean
}

interface HistoryHandlers {
  onOpen: (meta: CheckpointMeta) => void
  onDelete: (meta: CheckpointMeta) => void
}

// `2026-08-27T09:05:00Z` → `27/08 09:05`. Only the shape the store writes is
// shortened; anything else is left alone rather than sliced into nonsense.
function shortTimestamp(savedAt: string): string {
  const [date, time] = savedAt.split('T')
  const [, month, day] = (date ?? '').split('-')
  const isStoreShape = Boolean(month && day) && (time ?? '').length >= 5
  return isStoreShape ? `${day}/${month} ${time.slice(0, 5)}` : savedAt
}

// One saved review, in a line: when it was made and what it is about. The
// branch reviewed wins over the ref it is filed under — that is what the
// reader recognises, and the two differ between clients.
export function formatCheckpointRow(meta: CheckpointMeta): string {
  const about = meta.branch || meta.base
  // Lo de "desfasada" lo decide el daemon comparando el commit guardado con
  // el de la rama, para que los tres clientes lo digan igual.
  const stale = meta.stale ? ` · ${reviewT('staleShort')}` : ''
  return `${shortTimestamp(meta.saved_at)} · ${about}${stale}`
}

// The list of past reviews, for the drawer that shows the report they open.
// Every client now stamps a run id, so a branch keeps every review instead of
// only the last one — and the desktop had no way to reach any but the newest.
export function buildReviewHistory(metas: CheckpointMeta[], handlers: HistoryHandlers): HTMLElement {
  const list = document.createElement('div')
  list.className = 'review-history'
  if (!metas.length) {
    list.append(Object.assign(document.createElement('div'), {
      className: 'review-history-empty', textContent: reviewT('noSavedReview'),
    }))
    return list
  }
  for (const meta of metas) {
    const row = document.createElement('div')
    row.className = 'review-history-row'
    const open = Object.assign(document.createElement('button'), {
      className: 'review-history-open', textContent: formatCheckpointRow(meta),
    })
    open.addEventListener('click', () => { handlers.onOpen(meta) })
    row.append(open)
    if (meta.resumable) {
      row.append(Object.assign(document.createElement('span'), {
        className: 'review-history-resumable', title: reviewT('historyResumable'), textContent: '↺',
      }))
    }
    const remove = Object.assign(document.createElement('button'), {
      className: 'review-history-delete', title: reviewT('historyDelete'), textContent: '✕',
    })
    remove.addEventListener('click', () => { handlers.onDelete(meta) })
    row.append(remove)
    list.append(row)
  }
  return list
}
