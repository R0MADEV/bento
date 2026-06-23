export const isMac = navigator.platform.toUpperCase().includes('MAC')

export const shortcutLabel = (key: string): string => (isMac ? `⌘${key}` : `Ctrl+${key}`)
