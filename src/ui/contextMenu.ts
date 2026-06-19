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

  // Ajustar al viewport: si se sale por abajo/derecha, reposicionar
  const rect = menu.getBoundingClientRect()
  const margin = 8
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${Math.max(margin, window.innerHeight - rect.height - margin)}px`
  }
  if (rect.right > window.innerWidth) {
    menu.style.left = `${Math.max(margin, window.innerWidth - rect.width - margin)}px`
  }

  setTimeout(() => {
    document.addEventListener('mousedown', onOutside, true)
    document.addEventListener('keydown', onKey, true)
  }, 0)
}
