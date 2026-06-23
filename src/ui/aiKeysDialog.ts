import { invoke } from '@tauri-apps/api/core'
import { AI_PROVIDERS } from '../core/ai/providers'
import { icon } from './icons'

// Modal to manage AI provider API keys. Keys are stored in the OS keychain (Rust
// ai_key_* commands) and never touched in the DOM beyond the input that sets them.
export function openAiKeysDialog(): void {
  const overlay = document.createElement('div')
  overlay.className = 'ai-keys'

  const panel = document.createElement('div')
  panel.className = 'ai-keys-panel'

  const title = document.createElement('div')
  title.className = 'ai-keys-title'
  title.textContent = 'Configurar IA'

  const hint = document.createElement('div')
  hint.className = 'ai-keys-hint'
  hint.textContent = 'Las keys se guardan en el llavero del sistema y se inyectan en las terminales para que lexis las use. Abre una terminal nueva tras cambiarlas.'

  const list = document.createElement('div')
  list.className = 'ai-keys-list'

  panel.append(title, hint, list)
  overlay.appendChild(panel)
  document.body.appendChild(overlay)

  const close = (): void => {
    overlay.remove()
    window.removeEventListener('keydown', onKeydown)
  }
  const onKeydown = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); close() } }
  window.addEventListener('keydown', onKeydown)
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close() })

  const render = (configured: string[]): void => {
    list.innerHTML = ''
    AI_PROVIDERS.forEach(p => {
      const isSet = configured.includes(p.id)

      const row = document.createElement('div')
      row.className = 'ai-keys-row'

      const name = document.createElement('span')
      name.className = 'ai-keys-name'
      name.innerHTML = `${p.name}${isSet ? ' <span class="ai-keys-ok">✓</span>' : ''}`

      const input = document.createElement('input')
      input.className = 'ai-keys-input'
      input.type = 'password'
      input.placeholder = isSet ? '•••••••• (guardada)' : 'Pega tu API key'

      const reveal = document.createElement('button')
      reveal.className = 'ai-keys-btn'
      reveal.title = 'Mostrar'
      reveal.innerHTML = icon('eye')
      reveal.disabled = !isSet
      reveal.addEventListener('click', async () => {
        if (input.type === 'text') { input.type = 'password'; input.value = ''; return }
        const key = await invoke<string | null>('ai_key_get', { provider: p.id }).catch(() => null)
        if (key) { input.value = key; input.type = 'text' }
      })

      const save = document.createElement('button')
      save.className = 'ai-keys-btn'
      save.title = 'Guardar'
      save.innerHTML = icon('star')
      save.addEventListener('click', async () => {
        const key = input.value.trim()
        if (!key) return
        await invoke('ai_key_set', { provider: p.id, key }).catch(() => {})
        input.value = ''
        refresh()
      })

      const del = document.createElement('button')
      del.className = 'ai-keys-btn'
      del.title = 'Borrar'
      del.innerHTML = icon('x')
      del.disabled = !isSet
      del.addEventListener('click', async () => {
        await invoke('ai_key_delete', { provider: p.id }).catch(() => {})
        refresh()
      })

      input.addEventListener('keydown', e => { if (e.key === 'Enter') save.click() })

      row.append(name, input, reveal, save, del)
      list.appendChild(row)
    })
  }

  const refresh = (): void => {
    invoke<string[]>('ai_key_list').then(render).catch(() => render([]))
  }
  refresh()
}
