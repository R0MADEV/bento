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
import { M3UChannelRepository } from './adapters/M3UChannelRepository'
import { IptvOrgChannelRepository } from './adapters/IptvOrgChannelRepository'
import { LocalStorageFavoritesRepository } from './adapters/LocalStorageFavoritesRepository'
import { LocalStorageWorkspaceStateRepository } from './adapters/LocalStorageWorkspaceStateRepository'
import { createSessionManager } from './app/createSessionManager'
import { getThemeName, applyAppTheme } from './panels/terminal/themePreference'
import { isMac } from './ui/platform'
import { invoke } from '@tauri-apps/api/core'
import tvM3U from './assets/tv.m3u?raw'

// Web panels live in Rust state and survive a frontend reload as orphans — clean them up
invoke('web_panel_close_all').catch(() => {})

// Terminal scrollback is no longer persisted; drop any old history keys to free localStorage.
Object.keys(localStorage).filter(k => k.startsWith('bento.terminal.history.')).forEach(k => localStorage.removeItem(k))

// Tiñe toda la UI con el tema guardado al arrancar
applyAppTheme(getThemeName())

// En macOS la barra de título es overlay: deja hueco para los semáforos
if (isMac) {
  document.body.classList.add('is-mac')
}

// Composition root: inyecta dependencias, registra paneles, monta la app.
// Base ligera = M3U español (bundled). Mundial = iptv-org bajo demanda.
const channelRepo = new M3UChannelRepository(tvM3U)
const worldRepo = new IptvOrgChannelRepository()
const favoritesRepo = new LocalStorageFavoritesRepository()
const stateRepo = new LocalStorageWorkspaceStateRepository()

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

const app = document.getElementById('app')!
app.appendChild(createSessionManager(panels, stateRepo))
