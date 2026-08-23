import { t as i18nT } from '../../i18n'
import { icon } from '../../ui/icons'

export const note = (text: string, cls = 'db-note'): HTMLElement => {
  const el = document.createElement('div')
  el.className = cls
  el.textContent = text
  return el
}

export const makeFilterInput = (onChange: (q: string) => void): HTMLInputElement => {
  const input = document.createElement('input')
  input.className = 'db-filter'
  input.placeholder = i18nT('db.filterRows')
  input.type = 'search'
  let t: ReturnType<typeof setTimeout> | null = null
  input.addEventListener('input', () => {
    if (t) clearTimeout(t)
    t = setTimeout(() => onChange(input.value.toLowerCase()), 150)
  })
  return input
}

export const makeCsvBtn = (getData: () => { cols: string[]; rows: string[][]; filename: string }): HTMLButtonElement => {
  const btn = document.createElement('button')
  btn.className = 'db-action'
  btn.title = i18nT('db.exportCsv')
  btn.innerHTML = icon('download')
  btn.addEventListener('click', () => {
    const { cols, rows, filename } = getData()
    const csv = [cols, ...rows].map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = filename
    a.click()
    URL.revokeObjectURL(a.href)
  })
  return btn
}

export const buildWheres = (pkIdx: number[], columns: string[], row: string[]): [string, string][] =>
  pkIdx.map(i => [columns[i], row[i]])

export const makeResultWrap = (tbl: HTMLElement, toolbarItems: HTMLElement[]): HTMLElement => {
  const toolbar = document.createElement('div')
  toolbar.className = 'db-result-toolbar'
  toolbar.append(...toolbarItems)
  const wrap = document.createElement('div')
  wrap.className = 'db-result-wrap'
  wrap.append(toolbar, tbl)
  return wrap
}

export const rowEl = (depth: number, iconName: string, label: string, expandable: boolean): HTMLButtonElement => {
  const row = document.createElement('button')
  row.className = 'db-row'
  row.style.paddingLeft = `${8 + depth * 14}px`
  if (expandable) {
    const chevron = document.createElement('span')
    chevron.className = 'db-chevron'
    chevron.innerHTML = icon('chevron')
    row.appendChild(chevron)
  }
  const ic = document.createElement('span')
  ic.className = 'db-row-icon'
  ic.innerHTML = icon(iconName)
  const lbl = document.createElement('span')
  lbl.className = 'db-row-label'
  lbl.textContent = label
  row.append(ic, lbl)
  return row
}

export const appendExpandable = (
  parent: HTMLElement,
  row: HTMLButtonElement,
  onFirstExpand: (children: HTMLElement) => void,
): void => {
  let children: HTMLElement | null = null
  let loaded = false
  row.addEventListener('click', () => {
    if (!children) {
      children = document.createElement('div')
      children.className = 'db-children'
      row.insertAdjacentElement('afterend', children)
      row.classList.add('open')
      if (!loaded) { loaded = true; onFirstExpand(children) }
      return
    }
    const willOpen = children.classList.contains('hidden')
    row.classList.toggle('open', willOpen)
    children.classList.toggle('hidden', !willOpen)
    if (willOpen && !loaded) { loaded = true; onFirstExpand(children) }
  })
  parent.appendChild(row)
}
