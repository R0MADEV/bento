const KEY = 'bento.window.decorations'

export function getDecorations(): boolean {
  return localStorage.getItem(KEY) !== 'false'
}

export function setDecorations(enabled: boolean): void {
  localStorage.setItem(KEY, String(enabled))
}
