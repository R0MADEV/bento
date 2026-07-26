import type { TerminalTheme } from './themes'
import { mix, isDark } from './color'

// Derives the CSS variables for the whole app from the theme's palette,
// so the UI (bars, tabs, buttons) matches the terminal.
export function deriveAppVars(theme: TerminalTheme): Record<string, string> {
  const dark = isDark(theme.background)
  const shade = dark ? '#ffffff' : '#000000'

  return {
    '--bg': theme.background,
    '--surface': mix(theme.background, shade, 0.05),
    '--surface-2': mix(theme.background, shade, 0.1),
    '--border': mix(theme.background, shade, 0.16),
    '--fg': theme.foreground,
    '--fg-dim': theme.brightBlack,
    '--accent': theme.blue,
    '--accent-fg': theme.background,
    '--selection': theme.selectionBackground,
    // Shades for the glassmorphism background gradient (vibrant blue)
    '--bg-grad': mix(theme.background, theme.blue, 0.35),
    '--glow': mix(theme.blue, '#ffffff', 0.1),
  }
}
