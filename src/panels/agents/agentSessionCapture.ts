import { invoke } from '@tauri-apps/api/core'
import type { AgentSlot } from './AgentsPanel'

// Agents whose session can't be read from their process (see runningAgent.ts):
// find it on disk by creation time. Only OpenCode needs this (its session lives
// in SQLite); Claude and Codex are read from the process, so nothing running in
// a terminal has to report back to Bento.
const SESSION_FIND: Record<string, string> = {
  'opencode': 'agent_find_opencode_session',
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))


// Averiguar con qué id de sesión ha arrancado un agente, mirando lo que deja
// en disco. Es adivinar con reglas, y por eso vale la pena tenerlo aparte:
// cada agente guarda su sesión en un sitio y con un formato distinto.

export interface SessionCaptureDeps {
  slots: () => AgentSlot[]
  claimedSessionIds: Set<string>
  onCaptured: () => void
}

export function buildSessionCapture(deps: SessionCaptureDeps) {
  const captureSession = async (agentSlot: AgentSlot, cmd: string, cwd: string, sinceMs: number) => {
    const findCmd = SESSION_FIND[cmd]
    if (!findCmd) return

    let attempt = 0
    const agentIsAlive = () => deps.slots().includes(agentSlot) && !agentSlot.sessionId

    // OpenCode writes its session only on the first message, which can be long
    // after launch — poll long.
    const maxAttempts = 120

    while (agentIsAlive() && attempt < maxAttempts) {
      await delay(Math.min(2000 + attempt * 500, 5000))
      attempt++

      // The newest session created at/after sinceMs, skipping ones already
      // claimed by another agent in this panel.
      const found = await invoke<string | null>(findCmd, { cwd, sinceMs, exclude: [...deps.claimedSessionIds] }).catch(() => null)
      const id = found && !deps.claimedSessionIds.has(found) ? found : null

      if (id) {
        deps.claimedSessionIds.add(id)
        agentSlot.sessionId = id
        deps.onCaptured()
        return
      }
    }
  }

  // ── Root ──────────────────────────────────────────────────────

  return captureSession
}
