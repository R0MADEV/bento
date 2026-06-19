import type { Channel } from '../../core/channel/Channel'

export interface GridHandlers {
  onSelect: (ch: Channel) => void
  isFavorite: (ch: Channel) => boolean
  onToggleFavorite: (ch: Channel) => void
}

export function renderGrid(container: HTMLElement, channels: Channel[], handlers: GridHandlers): void {
  container.innerHTML = ''

  channels.slice(0, 200).forEach(ch => {
    const card = document.createElement('div')
    card.className = 'tv-card'
    card.title = ch.name

    const star = document.createElement('button')
    star.className = handlers.isFavorite(ch) ? 'tv-star active' : 'tv-star'
    star.textContent = '★'
    star.addEventListener('click', e => {
      e.stopPropagation()
      handlers.onToggleFavorite(ch)
    })
    card.appendChild(star)

    if (ch.logo) {
      const img = document.createElement('img')
      img.src = ch.logo
      img.alt = ch.name
      img.onerror = () => img.remove()
      card.appendChild(img)
    }

    const label = document.createElement('span')
    label.textContent = ch.name
    card.appendChild(label)

    card.addEventListener('click', () => handlers.onSelect(ch))
    container.appendChild(card)
  })
}
