export type AppLocale = 'es' | 'en'

const LOCALE_KEY = 'bento.locale'

const messages = {
  es: {
    empty: '(vacía)', duplicateSession: 'Duplicar sesión', closeSession: 'Cerrar sesión', newSession: 'Nueva sesión', session: 'Sesión', copy: 'copia',
    newTerminal: 'Nueva terminal', newTv: 'Nuevo panel TV', newWeb: 'Nuevo panel Web', newNotes: 'Nuevas notas',
    newHttp: 'Nuevo cliente HTTP', newScripts: 'Nuevo panel Scripts', newDb: 'Nuevo panel Bases de datos',
    newJira: 'Nuevo panel Jira', newDocker: 'Nuevo panel Docker', newTasks: 'Nuevo panel Tareas', newMemory: 'Nuevo panel Memoria',
    bindProject: 'Atar sesión a la carpeta de la terminal activa', exportWorkspace: 'Exportar workspace', importWorkspace: 'Importar workspace',
    invalidFormat: 'Formato inválido', importError: 'Error al importar: {error}', goTo: 'Ir a {name}', sessionsPosition: 'Sesiones: {position}',
    top: 'arriba', bottom: 'abajo', left: 'izquierda', right: 'derecha', windowBorders: 'Bordes de ventana', theme: 'Tema: {name}',
    panelNotRegistered: 'Panel no registrado: {name}', moveRight: '↦ Mover a la derecha', moveLeft: '↤ Mover a la izquierda',
    moveUp: '↥ Mover arriba', moveDown: '↧ Mover abajo', splitRight: 'Dividir derecha', splitLeft: 'Dividir izquierda',
    splitUp: 'Dividir arriba', splitDown: 'Dividir abajo', newTab: 'Nueva pestaña ({name})',
    panelDb: 'Bases de datos', panelDocker: 'Docker', panelHttp: 'HTTP', panelJira: 'Jira', panelMemory: 'Memoria', panelNotes: 'Notas',
    panelScripts: 'Scripts', panelTasks: 'Tareas', panelTerminal: 'Terminal', panelTv: 'TV', panelVault: 'Vault', panelWeb: 'Web',
    languageSpanish: 'Idioma: Español', languageEnglish: 'Idioma: Inglés', commandPalette: 'Paleta de comandos', commandPlaceholder: 'Escribe un comando…',
  },
  en: {
    empty: '(empty)', duplicateSession: 'Duplicate session', closeSession: 'Close session', newSession: 'New session', session: 'Session', copy: 'copy',
    newTerminal: 'New terminal', newTv: 'New TV panel', newWeb: 'New Web panel', newNotes: 'New notes',
    newHttp: 'New HTTP client', newScripts: 'New Scripts panel', newDb: 'New Databases panel',
    newJira: 'New Jira panel', newDocker: 'New Docker panel', newTasks: 'New Tasks panel', newMemory: 'New Memory panel',
    bindProject: 'Bind session to the active terminal folder', exportWorkspace: 'Export workspace', importWorkspace: 'Import workspace',
    invalidFormat: 'Invalid format', importError: 'Import failed: {error}', goTo: 'Go to {name}', sessionsPosition: 'Sessions: {position}',
    top: 'top', bottom: 'bottom', left: 'left', right: 'right', windowBorders: 'Window borders', theme: 'Theme: {name}',
    panelNotRegistered: 'Panel not registered: {name}', moveRight: '↦ Move right', moveLeft: '↤ Move left',
    moveUp: '↥ Move up', moveDown: '↧ Move down', splitRight: 'Split right', splitLeft: 'Split left',
    splitUp: 'Split above', splitDown: 'Split below', newTab: 'New tab ({name})',
    panelDb: 'Databases', panelDocker: 'Docker', panelHttp: 'HTTP', panelJira: 'Jira', panelMemory: 'Memory', panelNotes: 'Notes',
    panelScripts: 'Scripts', panelTasks: 'Tasks', panelTerminal: 'Terminal', panelTv: 'TV', panelVault: 'Vault', panelWeb: 'Web',
    languageSpanish: 'Language: Spanish', languageEnglish: 'Language: English', commandPalette: 'Command palette', commandPlaceholder: 'Type a command…',
  },
} as const

export type AppMessageKey = keyof typeof messages.es

export function getAppLocale(): AppLocale {
  const storage = globalThis.localStorage
  const hasStorage = typeof storage?.getItem === 'function'
  const saved = hasStorage ? storage.getItem(LOCALE_KEY) ?? storage.getItem('bento.tasks.locale') : null
  if (saved === 'es' || saved === 'en') return saved
  if (!hasStorage) return 'es'
  const language = typeof globalThis.navigator?.language === 'string' ? globalThis.navigator.language : 'es'
  return language.toLowerCase().startsWith('en') ? 'en' : 'es'
}

export function setAppLocale(locale: AppLocale): void {
  const storage = globalThis.localStorage
  if (typeof storage?.setItem === 'function') storage.setItem(LOCALE_KEY, locale)
  if (typeof storage?.removeItem === 'function') storage.removeItem('bento.tasks.locale')
  if (typeof globalThis.window?.dispatchEvent === 'function') {
    globalThis.window.dispatchEvent(new CustomEvent('bento:locale-change', { detail: locale }))
  }
}

export function appT(key: AppMessageKey, values: Record<string, string | number> = {}): string {
  let result: string = messages[getAppLocale()][key]
  for (const [name, value] of Object.entries(values)) result = result.split(`{${name}}`).join(String(value))
  return result
}
