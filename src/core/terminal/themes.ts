export interface TerminalTheme {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
}

export const DEFAULT_THEME = 'dark'

const THEMES: Record<string, TerminalTheme> = {
  dark: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#ffffff',
    selectionBackground: '#264f78',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
  },
  light: {
    background: '#fffffe',
    foreground: '#2e2e2e',
    cursor: '#000000',
    selectionBackground: '#add6ff',
    black: '#000000',
    red: '#cd3131',
    green: '#107c10',
    yellow: '#949800',
    blue: '#0451a5',
    magenta: '#bc05bc',
    cyan: '#0598bc',
    white: '#555555',
    brightBlack: '#666666',
  },
}

export const themeNames = Object.keys(THEMES)

export function getTheme(name: string): TerminalTheme {
  return THEMES[name] ?? THEMES[DEFAULT_THEME]
}
