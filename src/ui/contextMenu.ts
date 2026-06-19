export interface MenuItem {
  label: string
  onClick: () => void
}

export function showContextMenu(x: number, y: number, items: MenuItem[]): void {
  document.querySelector('.context-menu')?.remove()

  const menu = document.createElement('div')
  menu.className = 'context-menu'
  menu.style.left = `${x}px`
  menu.style.top = `${y}px`

  items.forEach(item => {
    const el = document.createElement('div')
    el.className = 'context-menu-item'
    el.textContent = item.label
    el.addEventListener('click', () => {
      menu.remove()
      item.onClick()
    })
    menu.appendChild(el)
  })

  document.body.appendChild(menu)

  const close = (e: MouseEvent) => {
    if (menu.contains(e.target as Node)) return
    menu.remove()
    document.removeEventListener('mousedown', close)
  }
  setTimeout(() => document.addEventListener('mousedown', close), 0)
}
