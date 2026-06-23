import { invoke } from '@tauri-apps/api/core'
import { parseNote, serializeNote, type ParsedNote } from '../../core/notes/noteFile'
import { noteTitle } from '../../core/notes/noteTitle'
import { renderMarkdown } from '../../core/notes/renderMarkdown'
import { icon } from '../../ui/icons'

interface Entry { name: string; note: ParsedNote }

export function createNotesPanel() {
  const root = document.createElement('div')
  root.className = 'notes-panel'

  const sidebar = document.createElement('div')
  sidebar.className = 'notes-sidebar'
  const addBtn = document.createElement('button')
  addBtn.className = 'notes-add'
  addBtn.innerHTML = `${icon('plus')}<span>Nueva nota</span>`
  const search = document.createElement('input')
  search.className = 'notes-search'
  search.placeholder = 'Buscar…'
  const list = document.createElement('div')
  list.className = 'notes-list'
  sidebar.append(addBtn, search, list)

  const editArea = document.createElement('div')
  editArea.className = 'notes-main'
  const header = document.createElement('div')
  header.className = 'notes-header'
  const titleInput = document.createElement('input')
  titleInput.className = 'notes-title'
  titleInput.placeholder = 'Título'
  const previewBtn = document.createElement('button')
  previewBtn.className = 'notes-toggle'
  previewBtn.title = 'Vista previa / editar'
  previewBtn.innerHTML = icon('eye')
  header.append(titleInput, previewBtn)
  const metaRow = document.createElement('div')
  metaRow.className = 'notes-meta'
  const categoryInput = document.createElement('input')
  categoryInput.className = 'notes-meta-input'
  categoryInput.placeholder = 'Categoría'
  const tagsInput = document.createElement('input')
  tagsInput.className = 'notes-meta-input'
  tagsInput.placeholder = 'tags: a, b, c'
  metaRow.append(categoryInput, tagsInput)
  const body = document.createElement('textarea')
  body.className = 'notes-textarea'
  body.placeholder = 'Escribe… (markdown)'
  body.spellcheck = false
  const preview = document.createElement('div')
  preview.className = 'notes-preview hidden'
  editArea.append(header, metaRow, body, preview)

  const fields = [titleInput, categoryInput, tagsInput, body]
  // Keep typing local — the workspace swallows some global shortcuts.
  fields.forEach(el => el.addEventListener('keydown', e => e.stopPropagation()))

  root.append(sidebar, editArea)

  let entries: Entry[] = []
  let selectedName: string | null = null
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let previewMode = false

  const applyPreview = (): void => {
    if (previewMode) preview.innerHTML = renderMarkdown(body.value)
    preview.classList.toggle('hidden', !previewMode)
    body.classList.toggle('hidden', previewMode)
    previewBtn.classList.toggle('active', previewMode)
  }
  previewBtn.addEventListener('click', () => { previewMode = !previewMode; applyPreview() })

  const displayTitle = (n: ParsedNote): string => n.title.trim() || noteTitle(n.body)

  const groups = (): { category: string; items: Entry[] }[] => {
    const q = search.value.trim().toLowerCase()
    const matches = (e: Entry): boolean => {
      if (!q) return true
      return `${e.note.title} ${e.note.category} ${e.note.tags.join(' ')}`.toLowerCase().includes(q)
    }
    const map = new Map<string, Entry[]>()
    entries.filter(matches).forEach(e => {
      const cat = e.note.category.trim() || 'Sin categoría'
      const items = map.get(cat) ?? []
      items.push(e)
      map.set(cat, items)
    })
    return [...map.entries()].map(([category, items]) => ({ category, items }))
  }

  const renderList = (): void => {
    list.innerHTML = ''
    groups().forEach(g => {
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
  }

  const fillEditor = (): void => {
    const e = entries.find(x => x.name === selectedName)
    fields.forEach(el => { el.disabled = !e })
    titleInput.value = e?.note.title ?? ''
    categoryInput.value = e?.note.category ?? ''
    tagsInput.value = e?.note.tags.join(', ') ?? ''
    body.value = e?.note.body ?? ''
    applyPreview()
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

  const persist = (): void => {
    if (!selectedName) return
    const note = currentNote()
    const e = entries.find(x => x.name === selectedName)
    if (e) e.note = note
    renderList()
    if (saveTimer) clearTimeout(saveTimer)
    const name = selectedName
    saveTimer = setTimeout(() => { invoke('notes_write', { name, content: serializeNote(note) }).catch(() => {}) }, 300)
  }
  fields.forEach(el => el.addEventListener('input', persist))

  const removeNote = (name: string): void => {
    invoke('notes_delete', { name }).catch(() => {})
    entries = entries.filter(e => e.name !== name)
    if (selectedName === name) selectedName = entries[0]?.name ?? null
    fillEditor()
    renderList()
  }

  addBtn.addEventListener('click', () => {
    const name = `${Date.now().toString(36)}.md`
    const note: ParsedNote = { title: '', category: '', tags: [], body: '' }
    entries = [{ name, note }, ...entries]
    invoke('notes_write', { name, content: serializeNote(note) }).catch(() => {})
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
      if (saveTimer) clearTimeout(saveTimer)
      if (selectedName) invoke('notes_write', { name: selectedName, content: serializeNote(currentNote()) }).catch(() => {})
    },
  }
}
