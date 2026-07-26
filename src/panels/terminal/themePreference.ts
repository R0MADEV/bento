import { DEFAULT_THEME, themeNames, getTheme } from '../../core/terminal/themes'
import { nextTheme } from '../../core/terminal/nextTheme'
import { deriveAppVars } from '../../core/terminal/appVars'

const KEY = 'bento.terminal.theme'
const EVENT = 'bento:terminal-theme'

export function getThemeName(): string {
  return localStorage.getItem(KEY) ?? DEFAULT_THEME
}

// Applies the app's CSS variables (entire UI) based on the theme.
export function applyAppTheme(name: string): void {
  const vars = deriveAppVars(getTheme(name))
  const root = document.documentElement
  Object.entries(vars).forEach(([key, value]) => root.style.setProperty(key, value))
}

// Applies a theme and saves it; notifies the terminals and tints the app.
export function setTheme(name: string): void {
  localStorage.setItem(KEY, name)
  applyAppTheme(name)
  window.dispatchEvent(new CustomEvent(EVENT, { detail: name }))
}

// Cycles to the next theme.
export function cycleTheme(): void {
  setTheme(nextTheme(getThemeName(), themeNames))
}

// Subscribes a callback to theme changes. Returns the function to unsubscribe.
export function onThemeChange(handler: (name: string) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<string>).detail)
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
