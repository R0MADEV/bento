export interface MenuItem {
  label: string
  onClick: () => void
  testId?: string
}

export interface ContextMenuOptions {
  align?: 'left' | 'right'
}

export function showContextMenu(x: number, y: number, items: MenuItem[], options: ContextMenuOptions = {}): void {
  // Close any previous menu that might still be open
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
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'context-menu-item'
    el.textContent = item.label
    if (item.testId) el.dataset.testid = item.testId
    el.addEventListener('click', () => {
      close()
      item.onClick()
    })
    menu.appendChild(el)
  })

  document.body.appendChild(menu)

  // Fit to the viewport: if it overflows off the bottom/right, reposition
  const rect = menu.getBoundingClientRect()
  const margin = 8
  const width = rect.width
  const height = rect.height
  const left = rect.left
  const top = rect.top
  const anchorLeft = x
  if (options.align === 'right') {
    menu.style.left = `${Math.max(margin, anchorLeft - width)}px`
  }
  if (top + height > window.innerHeight) {
    menu.style.top = `${Math.max(margin, window.innerHeight - height - margin)}px`
  }
  if (left + width > window.innerWidth) {
    menu.style.left = `${Math.max(margin, window.innerWidth - width - margin)}px`
  }

  setTimeout(() => {
    document.addEventListener('mousedown', onOutside, true)
    document.addEventListener('keydown', onKey, true)
  }, 0)
}
