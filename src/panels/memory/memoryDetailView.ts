import { t as i18nT } from '../../i18n'
import { invoke } from '@tauri-apps/api/core'
import { askAi } from '../../ui/askAi'
import { icon } from '../../ui/icons'
import type { MemoryEntry, MemoryKind, NewMemoryEntry } from '../../core/memory/MemoryEntry'
import {
  KIND_LABEL, KIND_OPTIONS, splitList, timeLabel, sourceLabel, canRegenerateSummary,
} from '../../core/memory/memoryFormat'
import {
  MEMORY_PINNED_TAG, MEMORY_SUPERSEDED_TAG, MEMORY_VERIFIED_TAG,
} from '../../core/memory/normalize'
import type { MemoryRepository } from '../../ports/MemoryRepository'
import type { MemoryEntryActions } from './memoryEntryActions'

export interface MemoryDetailViewDeps {
  repo: MemoryRepository
  currentProject: string
  getSelectedEntry: () => MemoryEntry | undefined
  getSelectedId: () => string | null
  setSelectedId: (id: string | null) => void
  reload: () => Promise<void>
  actions: MemoryEntryActions
}

export interface MemoryDetailView {
  element: HTMLElement
  /** Shows an entry in the form, or clears it when given nothing. */
  fill: (entry?: MemoryEntry) => void
  /** The status line, shared by the whole panel. */
  setStatus: (message?: string, entry?: MemoryEntry) => void
  /** Moves the cursor into the title field, for a brand new entry. */
  focusTitle: () => void
}

/** The right-hand pane: the entry form plus the actions that act on one entry. */
export function createMemoryDetailView(deps: MemoryDetailViewDeps): MemoryDetailView {
  const { repo, currentProject, getSelectedEntry, getSelectedId, setSelectedId, reload, actions } = deps

  const detail = document.createElement('div')
  detail.className = 'memory-detail'

  const detailHead = document.createElement('div')
  detailHead.className = 'memory-detail-head'
  const status = document.createElement('div')
  status.className = 'memory-status'
  const askBtn = document.createElement('button')
  askBtn.className = 'memory-action'
  askBtn.title = i18nT('common.sendToAiChat')
  askBtn.innerHTML = icon('chat')
  const regenerateBtn = document.createElement('button')
  regenerateBtn.className = 'memory-action'
  regenerateBtn.title = i18nT('memory.regenerateSummaryFromTranscript')
  regenerateBtn.textContent = i18nT('memory.regenerate')
  const archiveBtn = document.createElement('button')
  archiveBtn.className = 'memory-action'
  archiveBtn.title = i18nT('memory.archiveEntry')
  archiveBtn.textContent = i18nT('memory.archive')
  const pinBtn = document.createElement('button')
  pinBtn.className = 'memory-action'
  pinBtn.title = i18nT('memory.keepThisMemoryPrioritized')
  pinBtn.textContent = i18nT('memory.pin')
  const verifyBtn = document.createElement('button')
  verifyBtn.className = 'memory-action'
  verifyBtn.title = i18nT('memory.markContentAsManuallyReviewed')
  verifyBtn.textContent = i18nT('memory.verify')
  const supersedeBtn = document.createElement('button')
  supersedeBtn.className = 'memory-action'
  supersedeBtn.title = i18nT('memory.markAsObsoleteOrReplaced')
  supersedeBtn.textContent = i18nT('memory.obsolete')
  const deleteBtn = document.createElement('button')
  deleteBtn.className = 'memory-action danger'
  deleteBtn.title = i18nT('memory.deleteEntry')
  deleteBtn.innerHTML = icon('trash')
  detailHead.append(status, askBtn, regenerateBtn, pinBtn, verifyBtn, supersedeBtn, archiveBtn, deleteBtn)

  const form = document.createElement('div')
  form.className = 'memory-form'

  const kind = document.createElement('select')
  kind.className = 'memory-input'
  KIND_OPTIONS.filter((value): value is MemoryKind => value !== 'all').forEach(value => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = KIND_LABEL[value]
    kind.appendChild(option)
  })

  const source = document.createElement('input')
  source.className = 'memory-input'
  source.placeholder = i18nT('memory.sourceManualCodexClaude')

  const titleInput = document.createElement('input')
  titleInput.className = 'memory-input'
  titleInput.placeholder = i18nT('common.title')

  const tags = document.createElement('input')
  tags.className = 'memory-input'
  tags.placeholder = i18nT('memory.tagsPlaceholder')

  const files = document.createElement('input')
  files.className = 'memory-input'
  files.placeholder = i18nT('memory.filesSrcATsSrcBTs')

  const summary = document.createElement('textarea')
  summary.className = 'memory-textarea summary'
  summary.placeholder = i18nT('memory.shortReusableSummary')

  const details = document.createElement('textarea')
  details.className = 'memory-textarea'
  details.placeholder = i18nT('memory.detailsContextWhyNextStep')

  const saveBtn = document.createElement('button')
  saveBtn.className = 'memory-primary'
  saveBtn.textContent = i18nT('common.save')

  form.append(kind, source, titleInput, tags, files, summary, details, saveBtn)
  detail.append(detailHead, form)

  const setStatus = (message?: string, entry?: MemoryEntry): void => {
    if (message) {
      status.textContent = message
      return
    }
    status.textContent = entry
      ? `${KIND_LABEL[entry.kind]} · ${sourceLabel(entry.source)} · ${timeLabel(entry.updatedAt)}`
      : currentProject
        ? i18nT('memory.projectLabel', { project: currentProject })
        : i18nT('memory.globalMemory')
  }

  const fill = (entry?: MemoryEntry): void => {
    kind.value = entry?.kind ?? 'decision'
    source.value = entry?.source ?? 'manual'
    titleInput.value = entry?.title ?? ''
    tags.value = entry?.tags.join(', ') ?? ''
    files.value = entry?.files.join(', ') ?? ''
    summary.value = entry?.summary ?? ''
    details.value = entry?.details ?? ''
    deleteBtn.disabled = !entry
    askBtn.disabled = !entry
    archiveBtn.disabled = !entry
    pinBtn.disabled = !entry
    verifyBtn.disabled = !entry
    supersedeBtn.disabled = !entry
    pinBtn.textContent = entry?.tags.includes(MEMORY_PINNED_TAG) ? i18nT('memory.unpin') : i18nT('memory.pin')
    verifyBtn.textContent = entry?.tags.includes(MEMORY_VERIFIED_TAG) ? i18nT('memory.verified') : i18nT('memory.verify')
    supersedeBtn.textContent = entry?.tags.includes(MEMORY_SUPERSEDED_TAG) ? i18nT('memory.restore') : i18nT('memory.obsolete')
    regenerateBtn.disabled = !canRegenerateSummary(entry)
    setStatus(undefined, entry)
  }

  saveBtn.addEventListener('click', () => { void (async () => {
    const payload: NewMemoryEntry = {
      kind: kind.value as MemoryKind,
      source: source.value.trim() || 'manual',
      title: titleInput.value.trim(),
      summary: summary.value.trim(),
      details: details.value.trim(),
      tags: splitList(tags.value),
      files: splitList(files.value),
    }
    if (!payload.title && !payload.summary && !payload.details) return
    try {
      saveBtn.disabled = true
      const openId = getSelectedId()
      const entry = openId
        ? await repo.update(currentProject, openId, payload)
        : await repo.create(currentProject, payload)
      if (!entry) throw new Error('La entrada ya no existe.')
      setSelectedId(entry.id)
      await reload()
      setStatus(i18nT('memory.memorySaved'), entry)
    } catch (error) {
      setStatus(i18nT('memory.saveFailed', { error: error instanceof Error ? error.message : String(error) }))
    } finally {
      saveBtn.disabled = false
    }
  })() })

  archiveBtn.addEventListener('click', () => { void actions.archiveEntries(getSelectedEntry() ? [getSelectedEntry()!] : []).catch(error => setStatus(String(error))) })
  pinBtn.addEventListener('click', () => { void actions.toggleSelectedTag(MEMORY_PINNED_TAG).catch(error => setStatus(String(error))) })
  verifyBtn.addEventListener('click', () => { void actions.toggleSelectedTag(MEMORY_VERIFIED_TAG).catch(error => setStatus(String(error))) })
  supersedeBtn.addEventListener('click', () => { void actions.toggleSelectedTag(MEMORY_SUPERSEDED_TAG).catch(error => setStatus(String(error))) })
  deleteBtn.addEventListener('click', () => { void actions.deleteEntries(getSelectedEntry() ? [getSelectedEntry()!] : []).catch(error => setStatus(String(error))) })
  regenerateBtn.addEventListener('click', () => { void (async () => {
    const entry = getSelectedEntry()
    if (!entry || !entry.externalId.includes(':session-summary:')) return
    try {
      regenerateBtn.disabled = true
      setStatus(i18nT('memory.regeneratingSummaryFromTranscript'))
      const updated = await invoke<MemoryEntry | null>('memory_regenerate_summary', {
        projectPath: entry.projectPath,
        externalId: entry.externalId,
      })
      if (!updated) {
        setStatus(i18nT('memory.theSummaryCouldNotBeRegeneratedOrThere'))
        return
      }
      setSelectedId(updated.id)
      await reload()
      setStatus(i18nT('memory.summaryRegenerated'), updated)
    } catch (error) {
      setStatus(i18nT('memory.regenerateFailed', { error: error instanceof Error ? error.message : String(error) }))
    } finally {
      regenerateBtn.disabled = !canRegenerateSummary(getSelectedEntry())
    }
  })() })

  askBtn.addEventListener('click', () => {
    const entry = getSelectedEntry()
    if (!entry) return
    askAi(
      `Contexto — memoria reutilizable del proyecto${currentProject ? ` (${currentProject})` : ''}:\n\n` +
      `Tipo: ${KIND_LABEL[entry.kind]}\n` +
      `Origen: ${entry.source}\n` +
      `Título: ${entry.title}\n` +
      `Tags: ${entry.tags.join(', ')}\n` +
      `Archivos: ${entry.files.join(', ')}\n\n` +
      `${entry.summary}\n\n${entry.details}\n`
    )
  })

  return { element: detail, fill, setStatus, focusTitle: () => titleInput.focus() }
}
