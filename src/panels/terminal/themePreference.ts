import { DEFAULT_THEME, themeNames, getTheme } from '../../core/terminal/themes'
import { nextTheme } from '../../core/terminal/nextTheme'
import { deriveAppVars } from '../../core/terminal/appVars'

const KEY = 'bento.terminal.theme'
const EVENT = 'bento:terminal-theme'

export function getThemeName(): string {
  return localStorage.getItem(KEY) ?? DEFAULT_THEME
}

// Aplica las variables CSS de la app (UI completa) según el tema.
export function applyAppTheme(name: string): void {
  const vars = deriveAppVars(getTheme(name))
  const root = document.documentElement
  Object.entries(vars).forEach(([key, value]) => root.style.setProperty(key, value))
}

// Aplica un tema y lo guarda; notifica a las terminales y tiñe la app.
export function setTheme(name: string): void {
  localStorage.setItem(KEY, name)
  applyAppTheme(name)
  window.dispatchEvent(new CustomEvent(EVENT, { detail: name }))
}

// Cicla al siguiente tema.
export function cycleTheme(): void {
  setTheme(nextTheme(getThemeName(), themeNames))
}

// Suscribe un callback a los cambios de tema. Devuelve la función para desuscribir.
export function onThemeChange(handler: (name: string) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<string>).detail)
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
