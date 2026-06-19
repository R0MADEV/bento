import 'dockview-core/dist/styles/dockview.css'
import './styles.css'
import { createPanelRegistry } from './panels/registry'
import { tvPanelDefinition } from './panels/tv/definition'
import { terminalPanelDefinition } from './panels/terminal/definition'
import { IptvOrgChannelRepository } from './adapters/IptvOrgChannelRepository'
import { LocalStorageFavoritesRepository } from './adapters/LocalStorageFavoritesRepository'
import { createSessionManager } from './app/createSessionManager'

// Composition root: inyecta dependencias, registra paneles, monta la app.
const channelRepo = new IptvOrgChannelRepository()
const favoritesRepo = new LocalStorageFavoritesRepository()

const panels = createPanelRegistry()
panels.register(tvPanelDefinition(channelRepo, favoritesRepo))
panels.register(terminalPanelDefinition)

const app = document.getElementById('app')!
app.appendChild(createSessionManager(panels))
