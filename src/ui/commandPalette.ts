import { filterCommands, type Command } from '../core/command/command'

// Paleta de comandos (Cmd/Ctrl+K). getCommands se llama al abrir, así refleja
// el estado actual (sesiones, temas, etc.).
export function createCommandPalette(getCommands: () => Command[]): HTMLElement {
  const overlay = document.createElement('div')
  overlay.className = 'cmdk hidden'

  const panel = document.createElement('div')
  panel.className = 'cmdk-panel'

  const input = document.createElement('input')
  input.className = 'cmdk-input'
  input.placeholder = 'Escribe un comando...'

  const list = document.createElement('div')
  list.className = 'cmdk-list'

  panel.append(input, list)
  overlay.appendChild(panel)

  let results: Command[] = []
  let selected = 0

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
      row.innerHTML = `<span>${cmd.label}</span>${cmd.hint ? `<kbd>${cmd.hint}</kbd>` : ''}`
      row.addEventListener('click', () => run(cmd))
      row.addEventListener('mousemove', () => { selected = i; highlight() })
      list.appendChild(row)
    })
  }

  const highlight = (): void => {
    list.querySelectorAll('.cmdk-item').forEach((el, i) =>
      el.classList.toggle('selected', i === selected))
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

  // Atajo global Cmd/Ctrl+K
  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault()
      if (overlay.classList.contains('hidden')) open()
      else close()
    }
  })

  return overlay
}
