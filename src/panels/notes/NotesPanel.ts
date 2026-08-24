import { t as i18nT } from '../../i18n'
import { invoke } from '@tauri-apps/api/core'
import { askAi } from '../../ui/askAi'
import { parseNote, serializeNote, type ParsedNote } from '../../core/notes/noteFile'
import { groupNoteEntries, type NoteGroup } from '../../core/notes/noteGroups'
import { noteTitle } from '../../core/notes/noteTitle'
import { renderMarkdown } from '../../core/notes/renderMarkdown'
import { initUndo, commit, undo, redo, current, type UndoState } from '../../core/notes/undoStack'
import { showContextMenu } from '../../ui/contextMenu'
import { icon } from '../../ui/helpers/icons'
import { createCollapsibleSidebar } from '../../ui/collapsibleSidebar'

type ViewMode = 'edit' | 'preview' | 'split-h' | 'split-v'
const VIEW_KEY = 'bento.notes.view'

interface Entry { name: string; note: ParsedNote }

export function createNotesPanel() {
  const root = document.createElement('div')
  root.className = 'notes-panel'

  const cs = createCollapsibleSidebar({
    storageKey: 'bento.notes.sidebar',
    title: i18nT('notes.title'),
    defaultWidth: 210,
    minWidth: 150,
    minRemaining: 360,
    container: root,
  })
  // Fixed search on top, scrolling notes list below.
  Object.assign(cs.list.style, { overflow: 'hidden', display: 'flex', flexDirection: 'column' })

  // New-note action lives in the sidebar header.
  const addBtn = document.createElement('button')
  addBtn.className = 'notes-add'
  addBtn.title = i18nT('notes.newNote')
  addBtn.innerHTML = icon('plus')
  cs.actions.append(addBtn)

  const search = document.createElement('input')
  search.className = 'notes-search'
  search.placeholder = i18nT('notes.search')
  const list = document.createElement('div')
  list.className = 'notes-list'
  cs.list.append(search, list)

  const editArea = document.createElement('div')
  editArea.className = 'notes-main'
  const header = document.createElement('div')
  header.className = 'notes-header'
  const titleInput = document.createElement('input')
  titleInput.className = 'notes-title'
  titleInput.placeholder = i18nT('common.title')
  // Notes autosave silently; this only appears when a write to disk fails, so the
  // user knows their edits are NOT persisted instead of losing them unaware.
  const saveStatus = document.createElement('span')
  saveStatus.className = 'notes-save-status hidden'
  saveStatus.textContent = i18nT('notes.saveFailed')
  saveStatus.title = i18nT('notes.saveFailedHint')
  const deleteStatus = document.createElement('span')
  deleteStatus.className = 'notes-save-status notes-delete-status hidden'
  deleteStatus.textContent = i18nT('notes.deleteFailed')
  deleteStatus.title = i18nT('notes.deleteFailedHint')
  const layoutBtn = document.createElement('button')
  layoutBtn.className = 'notes-toggle'
  layoutBtn.title = i18nT('common.view')
  layoutBtn.innerHTML = icon('eye')
  const askAiBtn = document.createElement('button')
  askAiBtn.className = 'notes-toggle'
  askAiBtn.title = i18nT('notes.askAiAboutThisNote')
  askAiBtn.innerHTML = icon('chat')
  askAiBtn.addEventListener('click', () => {
    const content = body.value.trim()
    if (!content) return
    const title = titleInput.value.trim()
    askAi(`Contexto — nota${title ? ` "${title}"` : ''}:\n\n${content}\n\n`)
  })
  header.append(titleInput, saveStatus, deleteStatus)
  // View toggle + Ask-AI act on the open note → live in the sidebar header.
  cs.actions.append(layoutBtn, askAiBtn)
  const metaRow = document.createElement('div')
  metaRow.className = 'notes-meta'
  const categoryInput = document.createElement('input')
  categoryInput.className = 'notes-meta-input'
  categoryInput.placeholder = i18nT('common.category')
  const tagsInput = document.createElement('input')
  tagsInput.className = 'notes-meta-input'
  tagsInput.placeholder = i18nT('notes.tagsPlaceholder')
  metaRow.append(categoryInput, tagsInput)
  const bodyWrap = document.createElement('div')
  bodyWrap.className = 'notes-bodywrap'
  const styleBody = (ta: HTMLTextAreaElement): void => {
    ta.className = 'notes-textarea'
    ta.placeholder = i18nT('notes.writeMarkdown')
    ta.spellcheck = false
  }
  let body = document.createElement('textarea')
  styleBody(body)
  const preview = document.createElement('div')
  preview.className = 'notes-preview'
  bodyWrap.append(body, preview)
  editArea.append(header, metaRow, bodyWrap)

  const metaFields = [titleInput, categoryInput, tagsInput]
  // Keep typing local — the workspace swallows some global shortcuts.
  metaFields.forEach(el => el.addEventListener('keydown', e => e.stopPropagation()))

  root.append(cs.element, cs.resizer, editArea)

  let entries: Entry[] = []
  let selectedName: string | null = null
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let commitTimer: ReturnType<typeof setTimeout> | undefined
  const writeGenerations = new Map<string, number>()
  const writeQueues = new Map<string, Promise<void>>()
  const pendingWriteContents = new Map<string, string>()
  const deletedNotes = new Set<string>()
  const saveErrorNotes = new Set<string>()
  const deleteErrorNotes = new Set<string>()
  let undoState: UndoState = initUndo('')
  let viewMode = (localStorage.getItem(VIEW_KEY) as ViewMode | null) ?? 'edit'

  // Persists a note, surfacing failures instead of dropping them: a failed write
  // reveals the "not saved" marker, a successful one clears it. Never rejects.
  const syncSaveStatus = (): void => {
    if (!selectedName) {
      saveStatus.classList.add('hidden')
      return
    }
    saveStatus.classList.toggle('hidden', !saveErrorNotes.has(selectedName))
  }

  const syncDeleteStatus = (): void => {
    if (!selectedName) {
      deleteStatus.classList.add('hidden')
      return
    }
    deleteStatus.classList.toggle('hidden', !deleteErrorNotes.has(selectedName))
  }

  const writeNote = (name: string, content: string): Promise<void> => {
    if (deletedNotes.has(name)) return Promise.resolve()
    pendingWriteContents.set(name, content)
    const previous = writeQueues.get(name) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(async () => {
      if (deletedNotes.has(name)) return
      const nextContent = pendingWriteContents.get(name)
      if (nextContent === undefined) return
      pendingWriteContents.delete(name)
      const generation = (writeGenerations.get(name) ?? 0) + 1
      writeGenerations.set(name, generation)
      try {
        await invoke('notes_write', { name, content: nextContent })
        if (writeGenerations.get(name) !== generation) return
        saveErrorNotes.delete(name)
        if (selectedName === name) syncSaveStatus()
      } catch {
        if (writeGenerations.get(name) !== generation) return
        saveErrorNotes.add(name)
        if (selectedName === name) syncSaveStatus()
      }
    })
    writeQueues.set(name, next)
    next.finally(() => {
      if (writeQueues.get(name) === next) writeQueues.delete(name)
    })
    return next
  }

  const previewVisible = (): boolean => viewMode !== 'edit'

  const applyPreview = (): void => {
    bodyWrap.className = `notes-bodywrap ${viewMode}`
    layoutBtn.classList.toggle('active', previewVisible())
    if (previewVisible()) preview.innerHTML = renderMarkdown(body.value)
  }

  const setView = (mode: ViewMode): void => {
    viewMode = mode
    localStorage.setItem(VIEW_KEY, mode)
    applyPreview()
  }

  layoutBtn.addEventListener('click', () => {
    const r = layoutBtn.getBoundingClientRect()
    showContextMenu(r.left, r.bottom, [
      { label: i18nT('notes.editorOnly'), onClick: () => setView('edit') },
      { label: i18nT('notes.previewOnly'), onClick: () => setView('preview') },
      { label: i18nT('notes.splitSideBySide'), onClick: () => setView('split-h') },
      { label: i18nT('notes.splitTopBottom'), onClick: () => setView('split-v') },
    ])
  })

  const displayTitle = (n: ParsedNote): string => n.title.trim() || noteTitle(n.body)

  const groups = (): NoteGroup[] => groupNoteEntries(entries, search.value, i18nT('notes.uncategorized'))

  const renderList = (): void => {
    list.innerHTML = ''
    const gs = groups()
    gs.forEach(g => {
      const header = document.createElement('div')
      header.className = 'notes-group'
      header.textContent = g.category
      list.appendChild(header)
      g.items.forEach(e => {
        const item = document.createElement('button')
        item.className = e.name === selectedName ? 'notes-item active' : 'notes-item'
        const label = document.createElement('span')
        label.className = 'notes-item-title'
        label.textContent = displayTitle(e.note)
        const del = document.createElement('span')
        del.className = 'notes-item-del'
        del.innerHTML = icon('x')
        del.addEventListener('click', ev => { ev.stopPropagation(); removeNote(e.name) })
        item.append(label, del)
        item.addEventListener('click', () => select(e.name))
        list.appendChild(item)
      })
    })
    cs.setMiniItems(gs.flatMap(g => g.items).map(e => ({
      label: displayTitle(e.note),
      active: e.name === selectedName,
      onClick: () => select(e.name),
    })))
  }

  const fillEditor = (): void => {
    const e = entries.find(x => x.name === selectedName)
    metaFields.forEach(el => { el.disabled = !e || deletedNotes.has(selectedName ?? '') })
    titleInput.value = e?.note.title ?? ''
    categoryInput.value = e?.note.category ?? ''
    tagsInput.value = e?.note.tags.join(', ') ?? ''
    setBody(e?.note.body ?? '', !!e)
    applyPreview()
    syncSaveStatus()
    syncDeleteStatus()
  }

  const select = (name: string): void => {
    selectedName = name
    fillEditor()
    renderList()
    body.focus()
  }

  const currentNote = (): ParsedNote => ({
    title: titleInput.value,
    category: categoryInput.value,
    tags: tagsInput.value.split(',').map(t => t.trim()).filter(Boolean),
    body: body.value,
  })

  // Typing must NOT mutate the DOM (rebuilding the sidebar/preview inside the input
  // event breaks the textarea's native undo in WebKit). On input we only schedule a
  // save; the sidebar and preview refresh on blur and when switching notes.
  const persist = (): void => {
    if (!selectedName) return
    const note = currentNote()
    const e = entries.find(x => x.name === selectedName)
    if (e) e.note = note
    const name = selectedName
    const existingTimer = saveTimers.get(name)
    if (existingTimer) clearTimeout(existingTimer)
    saveTimers.set(name, setTimeout(() => {
      saveTimers.delete(name)
      void writeNote(name, serializeNote(note))
    }, 300))
  }

  const refreshUi = (): void => {
    if (previewVisible()) preview.innerHTML = renderMarkdown(body.value)
    renderList()
  }
  metaFields.forEach(el => { el.addEventListener('input', persist); el.addEventListener('blur', refreshUi) })

  // Manual undo: Tauri's WebView collapses all typing into one native undo step,
  // so we keep our own word-granular history and intercept Cmd/Ctrl+Z ourselves.
  const commitNow = (): void => {
    if (commitTimer) { clearTimeout(commitTimer); commitTimer = undefined }
    undoState = commit(undoState, body.value)
  }
  const restore = (text: string): void => {
    body.value = text
    body.selectionStart = body.selectionEnd = text.length
    persist()
    if (previewVisible()) preview.innerHTML = renderMarkdown(text)
  }
  const doUndo = (): void => {
    commitNow()
    const next = undo(undoState)
    if (next !== undoState) { undoState = next; restore(current(undoState)) }
  }
  const doRedo = (): void => {
    const next = redo(undoState)
    if (next !== undoState) { undoState = next; restore(current(undoState)) }
  }

  const wireBody = (ta: HTMLTextAreaElement): void => {
    ta.addEventListener('keydown', e => {
      e.stopPropagation()
      const mod = e.metaKey || e.ctrlKey
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) doRedo(); else doUndo()
      } else if (mod && e.key === 'y') {
        e.preventDefault()
        doRedo()
      }
    })
    ta.addEventListener('input', () => {
      persist()
      if (previewVisible()) preview.innerHTML = renderMarkdown(ta.value)
      // Checkpoint on word boundaries (space/newline), else after a short pause.
      const ch = ta.value[ta.selectionStart - 1]
      if (ch === ' ' || ch === '\n') commitNow()
      else { if (commitTimer) clearTimeout(commitTimer); commitTimer = setTimeout(commitNow, 400) }
    })
    ta.addEventListener('blur', () => { commitNow(); refreshUi() })
  }
  wireBody(body)

  const setBody = (content: string, enabled: boolean): void => {
    const fresh = document.createElement('textarea')
    styleBody(fresh)
    // Initial value via the DOM text node, NOT the .value setter — the setter
    // poisons WebKit's undo so all later typing collapses into one undo step.
    fresh.textContent = content
    fresh.disabled = !enabled
    wireBody(fresh)
    body.replaceWith(fresh)
    body = fresh
    undoState = initUndo(content)
    if (commitTimer) { clearTimeout(commitTimer); commitTimer = undefined }
  }

  const removeNote = (name: string): void => {
    if (deletedNotes.has(name)) return
    const index = entries.findIndex(e => e.name === name)
    const removed = entries[index]
    if (!removed) return
    deletedNotes.add(name)
    deleteErrorNotes.delete(name)
    fillEditor()
    const previous = writeQueues.get(name) ?? Promise.resolve()
    const deleteNoteNow: Promise<void> = previous.catch(() => {}).then(async () => {
      await invoke('notes_delete', { name })
      entries = entries.filter(e => e.name !== name)
      pendingWriteContents.delete(name)
      saveErrorNotes.delete(name)
      const timer = saveTimers.get(name)
      if (timer) clearTimeout(timer)
      saveTimers.delete(name)
      if (selectedName === name) selectedName = entries[0]?.name ?? null
      fillEditor()
      renderList()
    }).catch(() => {
      deletedNotes.delete(name)
      deleteErrorNotes.add(name)
      if (!entries.some(e => e.name === name)) entries = [...entries.slice(0, index), removed, ...entries.slice(index)]
      if (selectedName !== name) selectedName = name
      const pendingContent = pendingWriteContents.get(name) ?? serializeNote(removed.note)
      fillEditor()
      renderList()
      void writeNote(name, pendingContent)
    }).finally(() => {
      if (writeQueues.get(name) === deleteNoteNow) writeQueues.delete(name)
      writeGenerations.delete(name)
      deletedNotes.delete(name)
    })
    writeQueues.set(name, deleteNoteNow)
  }

  addBtn.addEventListener('click', () => {
    const name = `${Date.now().toString(36)}.md`
    const note: ParsedNote = { title: '', category: '', tags: [], body: '' }
    entries = [{ name, note }, ...entries]
    void writeNote(name, serializeNote(note))
    select(name)
    titleInput.focus()
  })

  search.addEventListener('input', renderList)
  search.addEventListener('keydown', e => e.stopPropagation())

  invoke<{ name: string; content: string }[]>('notes_list')
    .then(files => {
      entries = files
        .map(f => ({ name: f.name, note: parseNote(f.content) }))
        .sort((a, b) => displayTitle(a.note).localeCompare(displayTitle(b.note)))
      selectedName = entries[0]?.name ?? null
      fillEditor()
      renderList()
    })
    .catch(() => { fillEditor(); renderList() })

  return {
    element: root,
    focus: () => body.focus(),
    dispose: () => {
      const pendingNames = [...saveTimers.keys()]
      saveTimers.forEach(timer => clearTimeout(timer))
      saveTimers.clear()
      if (commitTimer) clearTimeout(commitTimer)
      pendingNames.forEach(name => {
        const entry = entries.find(e => e.name === name)
        if (entry) void writeNote(name, serializeNote(entry.note))
      })
    },
  }
}
