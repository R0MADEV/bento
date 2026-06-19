export interface MenuItem {
  label: string
  onClick: () => void
}

export function showContextMenu(x: number, y: number, items: MenuItem[]): void {
  // Cierra cualquier menú previo que pudiera quedar abierto
  document.querySelectorAll('.context-menu').forEach(m => m.remove())

  const menu = document.createElement('div')
  menu.className = 'context-menu'
  menu.style.left = `${x}px`
  menu.style.top = `${y}px`

  const close = (): void => {
    menu.remove()
    document.removeEventListener('mousedown', onOutside, true)
    document.removeEventListener('keydown', onKey, true)
  }

  const onOutside = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node)) close()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close()
  }

  items.forEach(item => {
    const el = document.createElement('div')
    el.className = 'context-menu-item'
    el.textContent = item.label
    el.addEventListener('click', () => {
      close()
      item.onClick()
    })
    menu.appendChild(el)
  })

  document.body.appendChild(menu)

  setTimeout(() => {
    document.addEventListener('mousedown', onOutside, true)
    document.addEventListener('keydown', onKey, true)
  }, 0)
}
