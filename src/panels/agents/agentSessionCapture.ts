import { invoke } from '@tauri-apps/api/core'
import type { AgentSlot } from './AgentsPanel'

const SOCKET_AGENTS = new Set(['claude', 'codex'])
// Agents without a socket-reporting hook: find the session on disk by creation
// time. Only OpenCode needs this (it has no hook; its session lives in SQLite).
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
    const useSocket = SOCKET_AGENTS.has(cmd)
    const findCmd = SESSION_FIND[cmd]
    if (!useSocket && !findCmd) return

    const paneId = agentSlot.handle.getPtyId()
    let attempt = 0
    const agentIsAlive = () => deps.slots().includes(agentSlot) && !agentSlot.sessionId

    // Socket agents report on SessionStart (right after launch); poll fast early
    // so closing the panel a couple seconds in still captures the resume id. If
    // the hook hasn't fired in ~1 min it never will, so stop. OpenCode writes its
    // session only on the first message, which can be much later — poll long.
    const maxAttempts = useSocket ? 24 : 120

    while (agentIsAlive() && attempt < maxAttempts) {
      await delay(useSocket ? Math.min(500 + attempt * 400, 3000) : Math.min(2000 + attempt * 500, 5000))
      attempt++

      // Socket (Claude/Codex): exact match by HERDR_PANE_ID.
      // File-based (OpenCode): newest session created at/after sinceMs, skipping
      // ones already claimed by another agent in this panel.
      const [socketId, fileId] = await Promise.all([
        useSocket
          ? invoke<string | null>('agent_get_session', { paneId }).catch(() => null)
          : Promise.resolve(null),
        findCmd
          ? invoke<string | null>(findCmd, { cwd, sinceMs, exclude: [...deps.claimedSessionIds] }).catch(() => null)
          : Promise.resolve(null),
      ])

      const id = (socketId && !deps.claimedSessionIds.has(socketId)) ? socketId
               : (fileId  && !deps.claimedSessionIds.has(fileId))  ? fileId
               : null

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
