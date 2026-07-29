import { filterCommands, type Command } from '../core/command/command'
import { appT } from '../core/i18n'

// Command palette (Cmd/Ctrl+K). getCommands is called on open, so it reflects
// the current state (sessions, themes, etc.).
export function createCommandPalette(getCommands: () => Command[]): HTMLElement {
  const overlay = document.createElement('div')
  overlay.className = 'cmdk hidden'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', appT('commandPalette'))

  const panel = document.createElement('div')
  panel.className = 'cmdk-panel'

  const input = document.createElement('input')
  input.className = 'cmdk-input'
  input.placeholder = appT('commandPlaceholder')
  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-autocomplete', 'list')
  input.setAttribute('aria-controls', 'bento-command-list')

  const list = document.createElement('div')
  list.className = 'cmdk-list'
  list.id = 'bento-command-list'
  list.setAttribute('role', 'listbox')

  panel.append(input, list)
  overlay.appendChild(panel)

  let results: Command[] = []
  let selected = 0
  // scrollIntoView triggers a synthetic mousemove (same coords) that would hijack
  // the keyboard selection; we only honour a mousemove when the pointer truly moves.
  let lastX = -1
  let lastY = -1

  const close = (): void => {
    overlay.classList.add('hidden')
    input.value = ''
  }

  const run = (cmd: Command | undefined): void => {
    if (!cmd) return
    close()
    cmd.run()
  }

  const render = (): void => {
    results = filterCommands(getCommands(), input.value)
    if (selected >= results.length) selected = Math.max(0, results.length - 1)

    list.innerHTML = ''
    results.forEach((cmd, i) => {
      const row = document.createElement('div')
      row.className = i === selected ? 'cmdk-item selected' : 'cmdk-item'
      row.id = `bento-command-${i}`
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(i === selected))
      const label = document.createElement('span')
      label.textContent = cmd.label
      row.appendChild(label)
      if (cmd.hint) {
        const hint = document.createElement('kbd')
        hint.textContent = cmd.hint
        row.appendChild(hint)
      }
      row.addEventListener('click', () => run(cmd))
      row.addEventListener('mousemove', e => {
        if (e.clientX === lastX && e.clientY === lastY) return
        lastX = e.clientX
        lastY = e.clientY
        selected = i
        highlight()
      })
      list.appendChild(row)
    })
  }

  const highlight = (): void => {
    list.querySelectorAll('.cmdk-item').forEach((el, i) => {
      const isSelected = i === selected
      el.classList.toggle('selected', isSelected)
      el.setAttribute('aria-selected', String(isSelected))
      if (isSelected) el.scrollIntoView({ block: 'nearest' })
    })
    input.setAttribute('aria-activedescendant', results.length ? `bento-command-${selected}` : '')
  }

  const open = (): void => {
    selected = 0
    overlay.classList.remove('hidden')
    render()
    input.focus()
  }

  input.addEventListener('input', () => { selected = 0; render() })
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(selected + 1, results.length - 1); highlight() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(selected - 1, 0); highlight() }
    else if (e.key === 'Enter') { e.preventDefault(); run(results[selected]) }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
  })

  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close() })

  // Global Cmd/Ctrl+K shortcut
  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault()
      if (overlay.classList.contains('hidden')) open()
      else close()
    }
  })

  return overlay
}
