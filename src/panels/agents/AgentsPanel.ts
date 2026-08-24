import { t as i18nT } from '../../i18n'
import { buildAgentRename } from './agentRename'
import { buildSessionCapture } from './agentSessionCapture'
import { appT } from '../../core/i18n'
import { invoke } from '@tauri-apps/api/core'
import { createAgentStore } from '../../core/terminal/agentStore'
import { createTerminalPanel, type TerminalPanelHandle } from '../terminal/TerminalPanel'
import { detectAgentCmd, resolveAgentIdentity } from '../../core/ai/detectAgent'
import { emitAgentDock, AGENT_ACTIVATE_EVENT, type AgentAttention } from '../../core/terminal/agentDockState'
import { createCollapsibleSidebar } from '../../ui/collapsibleSidebar'
import { buildResumeCmd } from './agentResume'

const MAX_AGENTS = 20

export interface AgentsPanelOptions {
  // Namespace for this panel's localStorage (sessions + sidebar state). Lets a
  // per-worktree panel keep its own agents, isolated from the global one.
  storageScope?: string
  // Whether to broadcast agents to the global dock/status bar. Off for embedded
  // per-worktree panels so they don't pollute the global agent list.
  publishToDock?: boolean
}

// herdr-style split: the small, critical resume metadata (agent list + session
// refs) is persisted separately from the large, optional scrollback history, so
// a huge/over-quota snapshot can never evict or corrupt the resume info.
interface SavedSession { name: string; cwd: string; cmd?: string; sessionId?: string; ptyId?: string }

const STATUS_ICON: Record<string, string> = {
  working: '●',
  blocked: '◉',
  idle: '○',
}

// Agents whose herdr hooks report the exact session_id via the Bento socket
// (keyed by HERDR_PANE_ID). This is the reliable path.
export interface AgentSlot {
  num: number
  customName: string
  cmd?: string
  sessionId?: string
  // Stable, persisted pty id so a reload reattaches to the same daemon terminal.
  ptyId: string
  handle: TerminalPanelHandle
  slot: HTMLDivElement
  titleCleanup: () => void
  // herdr model: when the shell/process exits we keep the slot (marked exited)
  // instead of removing it — the user closes it with ×. Runtime-only; on restore
  // the agent is relaunched (resumed), so this isn't persisted.
  exited?: boolean
}

export function createAgentsPanel(projectPath = '', opts: AgentsPanelOptions = {}): { element: HTMLElement; fit: () => void; persist: () => void; dispose: () => void } {
  const { storageScope = 'bento.agents', publishToDock = true } = opts
  const sessionsKey = `${storageScope}.sessions`   // resume metadata → localStorage
  const store = createAgentStore()
  const slots: AgentSlot[] = []
  let activeIndex = -1
  let agentCounter = 0
  let isEditing = false
  let initialized = false
  // Once disposed the hub must never persist again: dispose already flushed the
  // final state, and any late persist (a stray navigate/debounce on the dead hub)
  // would clobber it with an empty list.
  let disposed = false
  // Global registry of session IDs already claimed by an agent slot in this
  // panel. Prevents two concurrent agents in the same directory from racing
  // to capture the same session.
  const claimedSessionIds = new Set<string>()

  // Attention flags for background agents that need the user's eyes. Keyed by the
  // terminal's store id, cleared when the user views that agent.
  //  'bell'    — the agent rang the terminal bell (precise: turn done / needs
  //              input). This is the real signal and always wins.
  //  'blocked' — soft heuristic: no output for 30s (agentStatusTracker). Kept as
  //              a fallback for agents that never ring the bell; auto-clears if
  //              the agent resumes output (the silence was a false alarm).
  const attention = new Map<string, AgentAttention>()

  const publishDock = (): void => {
    if (!publishToDock) return
    const entries = store.getAll().flatMap((entry, index) => {
      const slot = slots[index]
      // Only advertise live agents: an exited (✕) pane stays in the sidebar for
      // resume but must not inflate the dock's agent count.
      if (!slot || slot.exited) return []
      return [{
        id: entry.id,
        name: slot.customName ?? entry.title,
        cwd: entry.title,
        cmd: slot.cmd,
        status: entry.status,
        attention: attention.get(entry.id),
        active: index === activeIndex,
      }]
    })
    emitAgentDock(entries)
  }

  // Persists the agents in two stores (herdr-style):
  //  1. resume metadata (name/cwd/cmd/sessionId) → localStorage. Tiny, always fits.
  //  2. scrollback history → a file (agent_history), off the browser quota, so a
  //     huge scrollback can never evict the resume list. Best-effort, async.
  // getSnapshot is expensive, so persistSessions() coalesces render-driven calls;
  // persistNow() flushes immediately for critical events (capture, dispose, unload).
  let persistTimer: ReturnType<typeof setTimeout> | undefined
  const persistNow = () => {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = undefined }
    // A disposed hub already flushed its final state; a late persist would clobber
    // it with an empty list. Not yet initialized → nothing to save yet.
    if (disposed || !initialized) return
    const entries = store.getAll()
    const sessions: SavedSession[] = slots.map((slot, i) => ({
      name: slot.customName,
      cwd: slot.handle.getCwd() || entries[i]?.title || '',
      cmd: slot.cmd,
      sessionId: slot.sessionId,
      ptyId: slot.ptyId,
    }))
    try { localStorage.setItem(sessionsKey, JSON.stringify(sessions)) }
    catch { /* metadata is tiny; nothing we can do if even this fails */ }

    const history = slots.map(slot => {
      try { return slot.handle.getSnapshot() } catch { return '' }
    })
    void invoke('agent_history_save', { scope: storageScope, content: JSON.stringify(history) }).catch(() => {})
  }
  const persistSessions = () => {
    if (persistTimer || !initialized) return
    persistTimer = setTimeout(() => { persistTimer = undefined; persistNow() }, 1500)
  }

  // Bind an agent to its own conversation. Claude/Codex report their exact
  // session via the socket (keyed by pane id); OpenCode is matched on disk by
  // creation time at/after launch (`sinceMs`), which never grabs another agent's
  // session. Polls for the whole agent lifetime because OpenCode only writes the
  // session on the first message, which may be long after launch.
  const captureSession = buildSessionCapture({ slots: () => slots, claimedSessionIds, onCaptured: () => persistNow() })

  const root = document.createElement('div')
  root.className = 'agents-hub'

  // ── Sidebar ───────────────────────────────────────────────────
  const cs = createCollapsibleSidebar({
    storageKey: storageScope,
    title: appT('panelTerminal'),
    defaultWidth: 220,
    minWidth: 160,
    minRemaining: 320,
    container: root,
    onToggle: () => setTimeout(() => slots[activeIndex]?.handle.fit?.(), 210),
  })

  const newBtn = document.createElement('button')
  newBtn.className = 'agents-new-btn'
  newBtn.textContent = `+ ${i18nT('agents.newAgent')}`
  newBtn.addEventListener('click', () => addAgent())
  cs.footer.appendChild(newBtn)

  // ── Terminal area ──────────────────────────────────────────────
  const termArea = document.createElement('div')
  termArea.className = 'agents-term-area'

  const emptyMsg = document.createElement('div')
  emptyMsg.className = 'agents-hub-empty'
  emptyMsg.innerHTML = `<span>${i18nT('agents.noTerminals')}</span><span class="agents-empty-hint">${i18nT('agents.noTerminalsHint')}</span>`
  termArea.appendChild(emptyMsg)

  root.append(cs.element, cs.resizer, termArea)

  // ── Inline name edit ──────────────────────────────────────────
  const startRename = buildAgentRename({
    setEditing: editing => { isEditing = editing },
    onRenamed: () => { persistNow(); renderSidebar() },
  })

  const refreshMiniItems = () => {
    const entries = store.getAll()
    cs.setMiniItems(entries.map((entry, i) => {
      const att = attention.get(entry.id)
      const name = slots[i]?.customName ?? ''
      return {
        label: entry.title ? `${name}\n${entry.title}` : name,
        dot: att ?? entry.status,
        active: i === activeIndex,
        onClick: () => activateAgent(i),
      }
    }))
  }

  const renderSidebar = () => {
    if (isEditing) return
    cs.list.innerHTML = ''
    const entries = store.getAll()
    publishDock()

    newBtn.disabled = entries.length >= MAX_AGENTS
    persistSessions()
    refreshMiniItems()

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      const slot = slots[i]
      if (!slot) continue
      const isActive = i === activeIndex

      const li = document.createElement('li')
      li.className = `agents-sidebar-item${isActive ? ' active' : ''}${slot.exited ? ' exited' : ''}`
      li.dataset.status = entry.status
      const att = attention.get(entry.id)
      if (att) li.dataset.attention = att

      const icon = document.createElement('span')
      icon.className = 'agents-sidebar-icon'
      // Exited agents show a hollow marker; live ones use their status icon.
      icon.textContent = slot.exited ? '✕' : (STATUS_ICON[entry.status] ?? '○')

      const info = document.createElement('div')
      info.className = 'agents-sidebar-info'

      const nameRow = document.createElement('div')
      nameRow.className = 'agents-sidebar-name-row'

      const nameEl = document.createElement('span')
      nameEl.className = 'agents-sidebar-name'
      nameEl.textContent = slot.customName
      nameEl.addEventListener('dblclick', e => {
        e.stopPropagation()
        startRename(slot, nameEl)
      })

      // Tooltip on the whole row: name + path (useful when name is truncated)
      li.title = entry.title
        ? `${slot.customName}\n${entry.title}`
        : slot.customName

      const closeBtn = document.createElement('button')
      closeBtn.className = 'agents-sidebar-close'
      closeBtn.textContent = '×'
      closeBtn.title = 'Close agent'
      closeBtn.addEventListener('click', e => {
        e.stopPropagation()
        removeAgent(i)
      })

      if (att) {
        const badge = document.createElement('span')
        badge.className = 'agents-sidebar-badge'
        badge.dataset.kind = att
        const label = att === 'blocked' ? i18nT('agents.waitingForInput') : i18nT('agents.wantsAttention')
        badge.title = label
        badge.setAttribute('aria-label', label)
        nameRow.append(nameEl, badge, closeBtn)
      } else {
        nameRow.append(nameEl, closeBtn)
      }

      const cwd = document.createElement('div')
      cwd.className = 'agents-sidebar-cwd'
      cwd.textContent = entry.title
      cwd.title = entry.title

      info.append(nameRow, cwd)
      li.append(icon, info)
      li.addEventListener('click', () => activateAgent(i))
      cs.list.appendChild(li)
    }
  }

  // ── Status → soft 'blocked' attention flag ─────────────────────
  // The precise 'bell' flag is set from the terminal bell (see addAgent).
  store.onChange(entries => {
    const activeId = slots[activeIndex]?.handle.getPtyId()
    for (const e of entries) {
      // The agent the user is looking at never needs an attention flag.
      if (e.id === activeId) { attention.delete(e.id); continue }
      const wentQuiet = e.status === 'blocked' && attention.get(e.id) !== 'bell'
      const resumedOutput = e.status === 'working' && attention.get(e.id) === 'blocked'
      if (wentQuiet) attention.set(e.id, 'blocked')
      else if (resumedOutput) attention.delete(e.id)
    }
    renderSidebar()
  })

  // ── Activate agent by index ────────────────────────────────────
  // Does NOT call renderSidebar — only patches the CSS active class so that
  // the existing nameEl DOM nodes stay connected (required for dblclick → rename).
  const activateAgent = (index: number) => {
    if (activeIndex >= 0 && slots[activeIndex]) {
      slots[activeIndex].slot.classList.remove('active')
    }
    activeIndex = index
    if (slots[index]) {
      emptyMsg.hidden = true
      slots[index].slot.classList.add('active')
      slots[index].handle.fit?.()
      slots[index].handle.focus?.()
    }
    // Viewing an agent clears its attention flag. activateAgent must not call
    // renderSidebar (it would detach nameEl mid-dblclick), so patch in place.
    const activeId = slots[index]?.handle.getPtyId()
    if (activeId) attention.delete(activeId)
    cs.list.querySelectorAll<HTMLElement>('.agents-sidebar-item').forEach((li, i) => {
      const isActive = i === index
      li.classList.toggle('active', isActive)
      if (isActive) {
        li.removeAttribute('data-attention')
        li.querySelector('.agents-sidebar-badge')?.remove()
      }
    })
    refreshMiniItems()
    publishDock()
  }

  // ── Add agent ─────────────────────────────────────────────────
  const addAgent = (savedName?: string, savedCwd?: string, savedCmd?: string, savedSessionId?: string, savedSnapshot?: string, savedPtyId?: string) => {
    if (slots.length >= MAX_AGENTS) return

    const num = ++agentCounter
    const defaultName = `Agent ${num}`
    // Stable id so a reload reattaches to the same daemon terminal instead of
    // spawning a duplicate. Reuse the persisted one on restore; else mint a new one.
    const ptyId = savedPtyId || `pty-agent-${crypto.randomUUID()}`

    const slot = document.createElement('div')
    slot.className = 'agents-term-slot'
    termArea.appendChild(slot)

    const handle = createTerminalPanel(
      `agent-${num}`,
      savedCwd || projectPath,
      // Process exited: mark the slot (herdr keeps the pane), don't remove it.
      () => markAgentExited(slots.findIndex(s => s.handle === handle)),
      undefined,
      store,
      ptyId,
      savedName || defaultName,
    )

    slot.appendChild(handle.element)

    const agentSlot: AgentSlot = {
      num,
      customName: savedName || defaultName,
      cmd: savedCmd,
      sessionId: savedSessionId,
      ptyId,
      handle,
      slot,
      titleCleanup: () => {},
    }
    const offTitle = handle.onTitleChange(() => renderSidebar())
    // Bell from a background agent = it wants the user's eyes → flag immediately.
    const offBell = handle.onBell(() => {
      const id = handle.getPtyId()
      if (slots[activeIndex]?.handle.getPtyId() === id) return
      attention.set(id, 'bell')
      renderSidebar()
    })
    agentSlot.titleCleanup = () => { offTitle(); offBell() }

    if (savedCmd || savedSnapshot) {
      void handle.spawned.then(reattached => {
        // Reattached to a still-running terminal in the daemon: the agent (or
        // shell) is already there, so replaying its command/scrollback would
        // double it. The daemon replays the live scrollback for us.
        if (reattached) return
        if (savedCmd) {
          void buildResumeCmd(savedCmd, savedCwd || projectPath, savedSessionId).then(cmd => {
            // If the command contains --resume / --session the stored sessionId is
            // still valid and capture can be skipped.  Otherwise the session file no
            // longer exists (or was never captured) — clear the stale ID so the
            // agentIsAlive() guard inside captureSession lets it poll.
            const isResuming = cmd.includes('--resume') || cmd.includes('--session') || cmd.includes(' resume ')
            // A resuming agent replays the whole conversation itself; painting the
            // saved snapshot too would double it (and mis-render it at another width).
            // Only restore the snapshot when there's no replay.
            if (!isResuming && savedSnapshot) handle.writeSnapshot(savedSnapshot)
            handle.sendInput(cmd)
            if (!isResuming) {
              if (agentSlot.sessionId) claimedSessionIds.delete(agentSlot.sessionId)
              agentSlot.sessionId = undefined
              captureSession(agentSlot, savedCmd, handle.getCwd() || savedCwd || projectPath, Date.now())
            }
          })
        } else if (savedSnapshot) {
          // Plain shell (no agent to replay): restore its scrollback for context.
          handle.writeSnapshot(savedSnapshot)
        }
      })
    }

    // Detect known agent CLIs from what the user types.
    // Rename only if still at the default name; always (re)capture the session.
    handle.onInput(line => {
      const cmd = detectAgentCmd(line)
      if (!cmd) return
      // cmd ALWAYS follows the latest agent run in this terminal, so it stays
      // consistent with the session captured for it (else you get e.g.
      // `opencode --session <codex-id>`). Name auto-updates only while default.
      const { name } = resolveAgentIdentity(agentSlot.customName, defaultName, cmd)
      if (name !== agentSlot.customName) {
        agentSlot.customName = name
        void invoke('pty_set_title', { id: agentSlot.ptyId, title: name })
        renderSidebar()
      }
      agentSlot.cmd = cmd
      // Restart session capture so the stored sessionId reflects this agent.
      if (agentSlot.sessionId) claimedSessionIds.delete(agentSlot.sessionId)
      agentSlot.sessionId = undefined
      captureSession(agentSlot, cmd, handle.getCwd() || savedCwd || projectPath, Date.now())
    })

    slots.push(agentSlot)

    activateAgent(slots.length - 1)
  }

  // ── Process exited ────────────────────────────────────────────
  // herdr keeps a pane whose process died (marked exited) instead of removing
  // it, so the agent survives — in the list and in persistence — until the user
  // closes it with ×. Persist so a mass exit (app reload) can't lose agents.
  const markAgentExited = (index: number) => {
    const s = slots[index]
    if (!s || s.exited) return
    s.exited = true
    renderSidebar()
    persistNow()
  }

  // ── Remove agent ──────────────────────────────────────────────
  const removeAgent = (index: number) => {
    if (index < 0 || index >= slots.length) return
    const s = slots[index]
    attention.delete(s.handle.getPtyId())
    s.titleCleanup()
    s.handle.dispose?.()
    s.slot.remove()
    slots.splice(index, 1)

    if (slots.length === 0) {
      activeIndex = -1
      emptyMsg.hidden = false
    } else {
      activateAgent(Math.min(index, slots.length - 1))
    }
    renderSidebar()
  }


  // ── Fit ───────────────────────────────────────────────────────
  const fit = () => {
    if (activeIndex >= 0) slots[activeIndex]?.handle.fit?.()
  }

  // Save agents synchronously if the page is torn down (reload/close) before a
  // clean dispose runs — otherwise a just-created agent could be lost.
  const onBeforeUnload = () => persistNow()
  window.addEventListener('beforeunload', onBeforeUnload)

  // Dock chip click → focus that exact agent here (see agentStatusBar). Only the
  // dock-publishing (global) panel listens; worktree panels aren't in the dock.
  const onActivateRequest = (e: Event): void => {
    const index = slots.findIndex(s => s.handle.getPtyId() === (e as CustomEvent<string>).detail)
    if (index >= 0) activateAgent(index)
  }
  if (publishToDock) window.addEventListener(AGENT_ACTIVATE_EVENT, onActivateRequest)

  // ── Dispose ───────────────────────────────────────────────────
  const dispose = () => {
    window.removeEventListener('beforeunload', onBeforeUnload)
    if (publishToDock) window.removeEventListener(AGENT_ACTIVATE_EVENT, onActivateRequest)
    persistNow()
    disposed = true   // block any late persist from clobbering the saved list
    for (const s of slots) {
      s.titleCleanup()
      s.handle.dispose?.()
    }
    slots.length = 0
    // No agents are live once disposed — clear the dock (don't re-seed from
    // persisted sessions, which would show closed agents).
    if (publishToDock) emitAgentDock([])
  }

  // Restore previously open agents, or start with one fresh agent. Metadata comes
  // from localStorage (sync); scrollback comes from a file (async). A missing/
  // corrupt history just means agents restore without their old scrollback.
  const savedSessions = (() => {
    try { return JSON.parse(localStorage.getItem(sessionsKey) ?? '[]') as SavedSession[] }
    catch { return [] }
  })()
  // One-time migration: drop the pre-file scrollback key from localStorage.
  try { localStorage.removeItem(`${storageScope}.history`) } catch { /* ignore */ }

  const restoreFrom = (history: string[]): void => {
    if (disposed) return
    try {
      savedSessions.forEach((s, i) => {
        if (s.sessionId) claimedSessionIds.add(s.sessionId)
        // One bad entry must not abort the whole restore — otherwise the rest are
        // lost and the panel reopens with 1.
        try { addAgent(s.name, s.cwd || projectPath, s.cmd, s.sessionId, history[i], s.ptyId) }
        catch { /* skip this agent, keep restoring the others */ }
      })
      if (slots.length === 0) addAgent()
    } finally {
      // Always mark ready, even if restore threw: a false `initialized` silently
      // disables all persistence (nothing would ever be saved again).
      initialized = true
    }
  }

  if (savedSessions.length === 0) {
    restoreFrom([])
  } else {
    // Agents are coming from the async history load — hide the empty state so it
    // doesn't flash, then restore once the scrollback file resolves.
    emptyMsg.hidden = true
    invoke<string>('agent_history_load', { scope: storageScope })
      .then(json => { try { return JSON.parse(json) as string[] } catch { return [] } })
      .catch(() => [] as string[])
      .then(restoreFrom)
  }

  // Adopt terminals created from mobile (or CLI) that the daemon knows about but
  // this panel doesn't. Runs periodically so mobile-spawned shells appear here.
  const adoptDaemonTerminals = async () => {
    if (!initialized) return
    try {
      const list = await invoke<Array<{ id: string; title: string; cwd: string }>>('pty_list')
      const daemonIds = new Set(list.map(t => t.id))

      // Remove slots whose PTY is gone from the daemon:
      // – always for mobile terminals (no session to resume)
      // – for any slot already marked exited (PTY died, safe to clean up)
      for (let i = slots.length - 1; i >= 0; i--) {
        const slot = slots[i]
        const isGone = !daemonIds.has(slot.ptyId)
        if (isGone && (slot.ptyId.startsWith('pty-mobile-') || slot.exited)) removeAgent(i)
      }

      // Adopt new terminals not yet tracked
      const knownIds = new Set(slots.map(s => s.ptyId))
      for (const t of list) {
        if (!knownIds.has(t.id)) {
          addAgent(t.title || 'Mobile shell', t.cwd || projectPath, undefined, undefined, undefined, t.id)
        }
      }
    } catch { /* daemon not ready */ }
  }
  const adoptInterval = setInterval(adoptDaemonTerminals, 4000)

  // Flush current agents to storage without tearing them down. Lets an embedding
  // host (e.g. the Tasks worktree terminal) save on navigation, so idle agents
  // survive even if dispose never fires (abrupt close).
  const persist = () => persistNow()

  return { element: root, fit, persist, dispose: () => { clearInterval(adoptInterval); dispose() } }
}
