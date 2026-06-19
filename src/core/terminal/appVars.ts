import type { TerminalTheme } from './themes'
import { mix, isDark } from './color'

// Deriva las variables CSS de toda la app a partir de la paleta del tema,
// para que la UI (barras, tabs, botones) combine con la terminal.
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
  }
}
