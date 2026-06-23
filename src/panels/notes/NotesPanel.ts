import { noteTitle } from '../../core/notes/noteTitle'

const NOTES_KEY = (id: string) => `bento.notes.${id}`

export function createNotesPanel(panelId = '') {
  const root = document.createElement('div')
  root.className = 'notes-panel'

  const textarea = document.createElement('textarea')
  textarea.className = 'notes-textarea'
  textarea.placeholder = 'Escribe tus notas…'
  textarea.spellcheck = false
  root.appendChild(textarea)

  const saved = panelId ? localStorage.getItem(NOTES_KEY(panelId)) : null
  if (saved) textarea.value = saved

  let titleCb: ((title: string) => void) | undefined
  let saveTimer: ReturnType<typeof setTimeout> | undefined

  const save = (): void => {
    if (!panelId) return
    try { localStorage.setItem(NOTES_KEY(panelId), textarea.value) } catch { /* storage lleno */ }
  }

  textarea.addEventListener('input', () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(save, 300)
    titleCb?.(noteTitle(textarea.value))
  })
  // The terminal/web panels swallow some shortcuts; let typing here stay local.
  textarea.addEventListener('keydown', e => e.stopPropagation())

  return {
    element: root,
    focus: () => textarea.focus(),
    onTitleChange: (cb: (title: string) => void) => {
      titleCb = cb
      cb(noteTitle(textarea.value))
      return () => { titleCb = undefined }
    },
    dispose: () => {
      if (saveTimer) clearTimeout(saveTimer)
      save()
    },
  }
}
