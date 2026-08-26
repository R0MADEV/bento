import { icon } from '../../ui/helpers/icons'

export function note(text: string, cls = 'jira-note'): HTMLElement {
  const el = document.createElement('div')
  el.className = cls
  el.textContent = text
  return el
}

export function mkBtn(iconName: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'jira-action'
  b.title = title
  b.innerHTML = icon(iconName)
  b.addEventListener('click', onClick)
  return b
}

/** The detail pane header: a title followed by whatever action buttons the caller gives. */
export function detailHeader(title: string, ...actions: HTMLElement[]): HTMLElement {
  const bar = document.createElement('div')
  bar.className = 'jira-header'
  const h = document.createElement('span')
  h.className = 'jira-title'
  h.textContent = title
  bar.append(h, ...actions)
  return bar
}

/** A labeled text input, used throughout the config/create/bulk forms. */
export function field(label: string, value = '', type = 'text'): { row: HTMLElement; input: HTMLInputElement } {
  const row = document.createElement('label')
  row.className = 'jira-field'
  row.textContent = label
  const input = document.createElement('input')
  input.className = 'jira-input'
  input.type = type
  input.value = value
  row.appendChild(input)
  return { row, input }
}
