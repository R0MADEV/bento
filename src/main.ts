import 'dockview-core/dist/styles/dockview.css'
import './styles.css'
import { createPanelRegistry } from './panels/registry'
import { tvPanelDefinition } from './panels/tv/definition'
import { terminalPanelDefinition } from './panels/terminal/definition'
import { M3UChannelRepository } from './adapters/M3UChannelRepository'
import { IptvOrgChannelRepository } from './adapters/IptvOrgChannelRepository'
import { LocalStorageFavoritesRepository } from './adapters/LocalStorageFavoritesRepository'
import { LocalStorageWorkspaceStateRepository } from './adapters/LocalStorageWorkspaceStateRepository'
import { createSessionManager } from './app/createSessionManager'
import { getThemeName, applyAppTheme } from './panels/terminal/themePreference'
import tvM3U from './assets/tv.m3u?raw'

// Tiñe toda la UI con el tema guardado al arrancar
applyAppTheme(getThemeName())

// En macOS la barra de título es overlay: deja hueco para los semáforos
if (navigator.platform.toUpperCase().includes('MAC')) {
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

const app = document.getElementById('app')!
app.appendChild(createSessionManager(panels, stateRepo))
