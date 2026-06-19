import { DEFAULT_THEME, themeNames } from '../../core/terminal/themes'
import { nextTheme } from '../../core/terminal/nextTheme'

const KEY = 'bento.terminal.theme'
const EVENT = 'bento:terminal-theme'

export function getThemeName(): string {
  return localStorage.getItem(KEY) ?? DEFAULT_THEME
}

// Aplica un tema y lo guarda; notifica a todas las terminales abiertas.
export function setTheme(name: string): void {
  localStorage.setItem(KEY, name)
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
