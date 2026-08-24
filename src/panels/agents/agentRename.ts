import { invoke } from '@tauri-apps/api/core'
import type { AgentSlot } from './AgentsPanel'

// Renombrar un agente en el sitio: cambia el nombre por un input, y confirma
// con Enter o al perder el foco. Aparte porque mientras dura hay que dejar de
// repintar la lista, y eso es fácil de olvidar.

export interface AgentRenameDeps {
  setEditing: (editing: boolean) => void
  onRenamed: () => void
}

export function buildAgentRename(deps: AgentRenameDeps): (slot: AgentSlot, nameEl: HTMLElement) => void {
  const startRename = (slot: AgentSlot, nameEl: HTMLElement) => {
    // The click preceding dblclick can trigger activateAgent → renderSidebar,
    // detaching nameEl before dblclick fires. Guard against that case.
    if (!nameEl.isConnected) return
    deps.setEditing(true)
    const input = document.createElement('input')
    input.className = 'agents-sidebar-name-input'
    input.value = slot.customName
    nameEl.replaceWith(input)
    input.focus()
    input.select()

    let committed = false
    const commit = () => {
      if (committed) return
      committed = true
      const val = input.value.trim()
      slot.customName = val || slot.customName
      void invoke('pty_set_title', { id: slot.ptyId, title: slot.customName })
      deps.setEditing(false)
      deps.onRenamed()
    }

    input.addEventListener('blur', commit)
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur() }
      if (e.key === 'Escape') { committed = true; deps.setEditing(false); deps.onRenamed() }
    })
  }

  // ── Sidebar render ─────────────────────────────────────────────

  return startRename
}
