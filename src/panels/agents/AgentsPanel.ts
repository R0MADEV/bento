import { t as i18nT } from '../../i18n'
import { appT } from '../../core/i18n'
import { invoke } from '@tauri-apps/api/core'
import { createAgentStore } from '../../core/terminal/agentStore'
import { createTerminalPanel, type TerminalPanelHandle } from '../terminal/TerminalPanel'
import { detectAgentCmd, resolveAgentIdentity } from './detectAgent'
import { emitAgentDock, savedAgentDockEntries, type AgentAttention } from '../../core/terminal/agentDockState'
import { createCollapsibleSidebar } from '../../ui/collapsibleSidebar'

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
interface SavedSession { name: string; cwd: string; cmd?: string; sessionId?: string }

const STATUS_ICON: Record<string, string> = {
  working: '●',
  blocked: '◉',
  idle: '○',
}

// Agents whose herdr hooks report the exact session_id via the Bento socket
// (keyed by HERDR_PANE_ID). This is the reliable path.
const SOCKET_AGENTS = new Set(['claude', 'codex'])
// Agents without a socket-reporting hook: find the session on disk by creation
// time. Only OpenCode needs this (it has no hook; its session lives in SQLite).
const SESSION_FIND: Record<string, string> = {
  'opencode': 'agent_find_opencode_session',
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Builds the exact resume command, verifying the session still exists on disk
// before using --resume to avoid "No conversation found" errors.
async function buildResumeCmd(cmd: string, cwd: string, sessionId?: string): Promise<string> {
  if (cmd === 'claude') {
    if (sessionId) {
      const exists = await invoke<boolean>('agent_claude_session_exists', { cwd, sessionId }).catch(() => false)
      return exists ? `claude --resume ${sessionId}` : 'claude'
    }
    return 'claude'
  }
  if (cmd === 'opencode') return sessionId ? `opencode --session ${sessionId}` : 'opencode'
  if (cmd === 'codex') {
    if (sessionId) {
      // Codex only writes the rollout on the first message: a session captured at
      // launch but closed before any turn was never saved. Verify it exists before
      // resuming, else `codex resume <id>` fails hard with "No saved session found".
      const exists = await invoke<boolean>('agent_codex_session_exists', { sessionId }).catch(() => false)
      if (!exists) return 'codex'
      // Clear stale thread-writer lock so codex doesn't reject with
      // "already has an active writer" when the previous PTY was killed externally.
      await invoke('agent_codex_clear_lock', { sessionId }).catch(() => {})
      return `codex resume ${sessionId}`
    }
    return 'codex'
  }
  return cmd
}


interface AgentSlot {
  num: number
  customName: string
  cmd?: string
  sessionId?: string
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
    const entries = store.getAll().map((entry, index) => ({
      id: entry.id,
      name: slots[index]?.customName ?? entry.title,
      cwd: entry.title,
      cmd: slots[index]?.cmd,
      status: entry.status,
      attention: attention.get(entry.id),
      active: index === activeIndex,
    }))
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
  const captureSession = async (agentSlot: AgentSlot, cmd: string, cwd: string, sinceMs: number) => {
    const useSocket = SOCKET_AGENTS.has(cmd)
    const findCmd = SESSION_FIND[cmd]
    if (!useSocket && !findCmd) return

    const paneId = agentSlot.handle.getPtyId()
    let attempt = 0
    const agentIsAlive = () => slots.includes(agentSlot) && !agentSlot.sessionId

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
          ? invoke<string | null>(findCmd, { cwd, sinceMs, exclude: [...claimedSessionIds] }).catch(() => null)
          : Promise.resolve(null),
      ])

      const id = (socketId && !claimedSessionIds.has(socketId)) ? socketId
               : (fileId  && !claimedSessionIds.has(fileId))  ? fileId
               : null

      if (id) {
        claimedSessionIds.add(id)
        agentSlot.sessionId = id
        persistNow()
        return
      }
    }
  }

  // ── Root ──────────────────────────────────────────────────────
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
  const startRename = (slot: AgentSlot, nameEl: HTMLElement) => {
    // The click preceding dblclick can trigger activateAgent → renderSidebar,
    // detaching nameEl before dblclick fires. Guard against that case.
    if (!nameEl.isConnected) return
    isEditing = true
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
      isEditing = false
      renderSidebar()
    }

    input.addEventListener('blur', commit)
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur() }
      if (e.key === 'Escape') { committed = true; isEditing = false; renderSidebar() }
    })
  }

  // ── Sidebar render ─────────────────────────────────────────────

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
  const addAgent = (savedName?: string, savedCwd?: string, savedCmd?: string, savedSessionId?: string, savedSnapshot?: string) => {
    if (slots.length >= MAX_AGENTS) return

    const num = ++agentCounter
    const defaultName = `Agent ${num}`

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
    )

    slot.appendChild(handle.element)

    const agentSlot: AgentSlot = {
      num,
      customName: savedName || defaultName,
      cmd: savedCmd,
      sessionId: savedSessionId,
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

    if (savedCmd) {
      buildResumeCmd(savedCmd, savedCwd || projectPath, savedSessionId).then(cmd => {
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

    // Detect known agent CLIs from what the user types.
    // Rename only if still at the default name; always (re)capture the session.
    handle.onInput(line => {
      const cmd = detectAgentCmd(line)
      if (!cmd) return
      // cmd ALWAYS follows the latest agent run in this terminal, so it stays
      // consistent with the session captured for it (else you get e.g.
      // `opencode --session <codex-id>`). Name auto-updates only while default.
      const { name } = resolveAgentIdentity(agentSlot.customName, defaultName, cmd)
      if (name !== agentSlot.customName) { agentSlot.customName = name; renderSidebar() }
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
    if (activeIndex >= 0 && slots[activeIndex]) {
      slots[activeIndex].handle.fit?.()
    }
  }

  // Save agents synchronously if the page is torn down (reload/close) before a
  // clean dispose runs — otherwise a just-created agent could be lost.
  const onBeforeUnload = () => persistNow()
  window.addEventListener('beforeunload', onBeforeUnload)

  // ── Dispose ───────────────────────────────────────────────────
  const dispose = () => {
    window.removeEventListener('beforeunload', onBeforeUnload)
    persistNow()
    disposed = true   // block any late persist from clobbering the saved list
    for (const s of slots) {
      s.titleCleanup()
      s.handle.dispose?.()
    }
    slots.length = 0
    if (publishToDock) emitAgentDock(savedAgentDockEntries())
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
        try { addAgent(s.name, s.cwd || projectPath, s.cmd, s.sessionId, history[i]) }
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

  // Flush current agents to storage without tearing them down. Lets an embedding
  // host (e.g. the Tasks worktree terminal) save on navigation, so idle agents
  // survive even if dispose never fires (abrupt close).
  const persist = () => persistNow()

  return { element: root, fit, persist, dispose }
}
