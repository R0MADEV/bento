import type { SearchAddon } from 'xterm-addon-search'

interface SearchBar {
  element: HTMLElement
  toggle: () => void
}

export function createSearchBar(searchAddon: SearchAddon): SearchBar {
  const bar = document.createElement('div')
  bar.className = 'terminal-search hidden'

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'Buscar...'
  input.className = 'terminal-search-input'

  const prev = document.createElement('button')
  prev.textContent = '↑'
  prev.title = 'Anterior'

  const next = document.createElement('button')
  next.textContent = '↓'
  next.title = 'Siguiente'

  const close = document.createElement('button')
  close.textContent = '✕'
  close.title = 'Cerrar'

  bar.append(input, prev, next, close)

  const searchNext = () => searchAddon.findNext(input.value)
  const searchPrev = () => searchAddon.findPrevious(input.value)

  input.addEventListener('input', searchNext)
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') e.shiftKey ? searchPrev() : searchNext()
    if (e.key === 'Escape') hide()
  })
  next.addEventListener('click', searchNext)
  prev.addEventListener('click', searchPrev)
  close.addEventListener('click', () => hide())

  const hide = () => bar.classList.add('hidden')

  const toggle = () => {
    bar.classList.toggle('hidden')
    if (!bar.classList.contains('hidden')) {
      input.focus()
      input.select()
    }
  }

  return { element: bar, toggle }
}
