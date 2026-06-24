// Reusable master-detail layout: a grouped, selectable list on the left and a
// detail pane on the right. Shared by panels that show "a list + the selected
// item's detail" (Docker, and — pending migration — Notes and DB).

export interface MdItem {
  id: string
  label: string
  group: string
  // Optional node shown before the label (e.g. a status dot).
  leading?: HTMLElement
}

export interface MasterDetailOptions {
  title: string
  onSelect: (id: string) => void
  headerActions?: HTMLElement[]
  // Per-group action buttons (e.g. start/stop a whole project), shown on hover.
  groupActions?: (group: string, ids: string[]) => HTMLElement[]
  // Small badge next to the group name (e.g. "5/9").
  groupBadge?: (group: string, ids: string[]) => string
  emptyText?: string
}

export interface MasterDetail {
  element: HTMLElement
  detail: HTMLElement
  setItems: (items: MdItem[]) => void
  select: (id: string) => void
  selected: () => string
}

export function createMasterDetail(opts: MasterDetailOptions): MasterDetail {
  const element = document.createElement('div')
  element.className = 'md-panel'
  const sidebar = document.createElement('div')
  sidebar.className = 'md-sidebar'
  const detail = document.createElement('div')
  detail.className = 'md-detail'
  element.append(sidebar, detail)

  const head = document.createElement('div')
  head.className = 'md-head'
  const title = document.createElement('span')
  title.className = 'md-title'
  title.textContent = opts.title
  head.append(title, ...(opts.headerActions ?? []))

  const list = document.createElement('div')
  list.className = 'md-list'
  sidebar.append(head, list)

  let items: MdItem[] = []
  let selectedId = ''

  // Group preserving first-seen order, so the consumer controls ordering.
  const grouped = (): { name: string; items: MdItem[] }[] => {
    const groups: { name: string; items: MdItem[] }[] = []
    for (const it of items) {
      let g = groups.find(x => x.name === it.group)
      if (!g) { g = { name: it.group, items: [] }; groups.push(g) }
      g.items.push(it)
    }
    return groups
  }

  const render = (): void => {
    list.replaceChildren()
    if (!items.length) {
      if (opts.emptyText) {
        const empty = document.createElement('div')
        empty.className = 'md-empty'
        empty.textContent = opts.emptyText
        list.append(empty)
      }
      return
    }
    for (const g of grouped()) {
      const ids = g.items.map(i => i.id)
      const cat = document.createElement('div')
      cat.className = 'md-cat'
      const name = document.createElement('span')
      name.className = 'md-cat-name'
      name.textContent = g.name
      cat.append(name)
      const badge = opts.groupBadge?.(g.name, ids)
      if (badge) {
        const b = document.createElement('span')
        b.className = 'md-cat-badge'
        b.textContent = badge
        cat.append(b)
      }
      const acts = opts.groupActions?.(g.name, ids) ?? []
      if (acts.length) {
        const wrap = document.createElement('span')
        wrap.className = 'md-cat-actions'
        wrap.append(...acts)
        cat.append(wrap)
      }
      list.append(cat)

      for (const it of g.items) {
        const item = document.createElement('button')
        item.className = it.id === selectedId ? 'md-item active' : 'md-item'
        if (it.leading) item.append(it.leading)
        const label = document.createElement('span')
        label.className = 'md-item-name'
        label.textContent = it.label
        item.append(label)
        item.addEventListener('click', () => { selectedId = it.id; render(); opts.onSelect(it.id) })
        list.append(item)
      }
    }
  }

  return {
    element,
    detail,
    setItems: next => { items = next; render() },
    select: id => { selectedId = id; render() },
    selected: () => selectedId,
  }
}
