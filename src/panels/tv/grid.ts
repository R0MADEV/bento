import type { Channel } from '../../core/channel/Channel'

export function renderGrid(
  container: HTMLElement,
  channels: Channel[],
  onSelect: (ch: Channel) => void
): void {
  container.innerHTML = ''

  channels.slice(0, 100).forEach(ch => {
    const card = document.createElement('div')
    card.className = 'tv-card'
    card.title = ch.name

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

    card.addEventListener('click', () => onSelect(ch))
    container.appendChild(card)
  })
}
