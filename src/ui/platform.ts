// Platform helpers. Bento ships for Linux, macOS and Windows; only the display
// of shortcuts differs (⌘ on macOS, Ctrl elsewhere). The shortcuts themselves
// work everywhere because the handlers accept metaKey || ctrlKey.

export const isMac = navigator.platform.toUpperCase().includes('MAC')

export const shortcutLabel = (key: string): string => (isMac ? `⌘${key}` : `Ctrl+${key}`)
