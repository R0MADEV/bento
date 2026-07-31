import 'dockview-core/dist/styles/dockview.css'
import './styles.css'
import { createPanelRegistry } from './panels/registry'
import { tvPanelDefinition } from './panels/tv/definition'
import { terminalPanelDefinition } from './panels/terminal/definition'
import { webPanelDefinition } from './panels/web/definition'
import { notesPanelDefinition } from './panels/notes/definition'
import { httpPanelDefinition } from './panels/http/definition'
import { scriptsPanelDefinition } from './panels/scripts/definition'
import { dbPanelDefinition } from './panels/db/definition'
import { jiraPanelDefinition } from './panels/jira/definition'
import { dockerPanelDefinition } from './panels/docker/definition'
import { vaultPanelDefinition } from './panels/vault/definition'
import { tasksPanelDefinition } from './panels/tasks/definition'
import { memoryPanelDefinition } from './panels/memory/definition'
import { M3UChannelRepository } from './adapters/M3UChannelRepository'
import { IptvOrgChannelRepository } from './adapters/IptvOrgChannelRepository'
import { LocalStorageFavoritesRepository } from './adapters/LocalStorageFavoritesRepository'
import { TauriMemoryRepository } from './adapters/TauriMemoryRepository'
import { TauriWorkspaceStateRepository } from './adapters/TauriWorkspaceStateRepository'
import { createSessionManager } from './app/createSessionManager'
import { createAiChat } from './ui/aiChat'
import { getThemeName, applyAppTheme } from './panels/terminal/themePreference'
import { isMac } from './ui/platform'
import { invoke } from '@tauri-apps/api/core'
import tvM3U from './assets/tv.m3u?raw'

// Web panels live in Rust state and survive a frontend reload as orphans — clean them up
invoke('web_panel_close_all').catch(() => {})

// Terminal scrollback is no longer persisted; drop any old history keys to free localStorage.
Object.keys(localStorage).filter(k => k.startsWith('bento.terminal.history.')).forEach(k => localStorage.removeItem(k))

// Tint the whole UI with the saved theme on startup
applyAppTheme(getThemeName())

// Global UI zoom: Cmd/Ctrl + / - / 0
const ZOOM_KEY = 'bento.zoom'
const ZOOM_STEP = 0.1
const clampZoom = (z: number): number => Math.max(0.5, Math.min(2, Math.round(z * 10) / 10))
const applyZoom = (z: number): void => {
  const v = clampZoom(z)
  document.documentElement.style.zoom = String(v)
  localStorage.setItem(ZOOM_KEY, String(v))
}
const savedZoom = parseFloat(localStorage.getItem(ZOOM_KEY) ?? '1')
if (savedZoom !== 1) applyZoom(savedZoom)

document.addEventListener('keydown', e => {
  if (!e.metaKey && !e.ctrlKey) return
  const current = parseFloat(document.documentElement.style.zoom || '1')
  if (e.key === '=' || e.key === '+') { e.preventDefault(); applyZoom(current + ZOOM_STEP) }
  else if (e.key === '-') { e.preventDefault(); applyZoom(current - ZOOM_STEP) }
  else if (e.key === '0') { e.preventDefault(); applyZoom(1) }
})

// On macOS the title bar is an overlay: leave room for the traffic lights
if (isMac) {
  document.body.classList.add('is-mac')
}

// Composition root: injects dependencies, registers panels, mounts the app.
// Lightweight base = Spanish M3U (bundled). Worldwide = iptv-org on demand.
const channelRepo = new M3UChannelRepository(tvM3U)
const worldRepo = new IptvOrgChannelRepository()
const favoritesRepo = new LocalStorageFavoritesRepository()
const memoryRepo = new TauriMemoryRepository()
const stateRepo = new TauriWorkspaceStateRepository()

const panels = createPanelRegistry()
panels.register(tvPanelDefinition(channelRepo, favoritesRepo, worldRepo))
panels.register(terminalPanelDefinition)
panels.register(webPanelDefinition)
panels.register(notesPanelDefinition)
panels.register(httpPanelDefinition)
panels.register(scriptsPanelDefinition)
panels.register(dbPanelDefinition)
panels.register(jiraPanelDefinition)
panels.register(dockerPanelDefinition)
panels.register(vaultPanelDefinition)
panels.register(tasksPanelDefinition)
panels.register(memoryPanelDefinition(memoryRepo))

const app = document.getElementById('app')!
app.appendChild(createSessionManager(panels, stateRepo))
app.appendChild(createAiChat(memoryRepo))
